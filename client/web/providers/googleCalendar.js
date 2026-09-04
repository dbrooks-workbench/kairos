import { parseEventDescription } from './parsers.js'
import { loadPrefs, getTaskCalendars } from './kairosPrefs.js'
import { loadCompletionStore, getCompletedAt } from './completionStore.js'
import { loadLifeLog, getItemLog } from './lifeLog.js'
import { getTaskEvents } from './calendarTasks.js'
import { decodeTags } from './tagCodec.js'

const BASE = 'https://www.googleapis.com/calendar/v3'

// Sync tokens per calendar (regular events only — task events use a separate fetch).
// Populated after each successful full fetch; cleared on 410 (stale token).
const _syncTokens = new Map()   // calendarId → nextSyncToken

export function clearSyncTokens() { _syncTokens.clear() }

const EVENT_STATUS = {
  confirmed: 'CONFIRMED',
  tentative: 'TENTATIVE',
  cancelled: 'CANCELLED',
}

async function get(token, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Calendar API ${res.status} ${res.statusText}`)
  return res.json()
}

// Build an Error whose message includes Google's actual reason (e.g.
// "forbiddenForNonOrganizer", "You need to have writer access…") — a bare
// status code hides why a 403/400 happened, which is exactly what a user
// deleting a shared or non-owned recurring event needs to see.
export async function apiError(label, res) {
  let reason = res.statusText || ''
  try {
    const body = await res.json()
    const e = body?.error
    const primary = e?.message || reason
    const detail  = e?.errors?.map(x => `${x.domain || ''}.${x.reason || ''}: ${x.message || ''}`).join('; ')
    reason = detail ? `${primary} [${detail}]` : primary
  } catch { /* non-JSON body */ }
  return new Error(`${label}: ${res.status}${reason ? ` ${reason}` : ''}`)
}

async function paginate(token, url) {
  const items = []
  let pageToken = null
  let syncToken = null
  do {
    const data = await get(token, pageToken ? `${url}&pageToken=${pageToken}` : url)
    if (data.items?.length) items.push(...data.items)
    pageToken = data.nextPageToken ?? null
    if (!pageToken) syncToken = data.nextSyncToken ?? null
  } while (pageToken)
  return { items, syncToken }
}

export async function getCalendars(token) {
  const data = await get(token, `${BASE}/users/me/calendarList`)
  return (data.items ?? []).filter(c => c.accessRole !== 'freeBusyReader')
}

function normalizeEvent(event, calendar) {
  // Task events are owned by calendarTasks.js; skip them here to avoid duplication.
  if (event.extendedProperties?.private?.isTask === 'true') return null
  // The per-calendar Kairos config lives in a hidden all-day event at 1970 — never
  // surface it as a calendar item.
  if (event.extendedProperties?.private?.kairosConfig === 'true') return null

  const allDay = !!event.start?.date
  const start = allDay
    ? new Date(event.start.date + 'T00:00:00')
    : new Date(event.start.dateTime)
  const end = !event.end ? null
    : allDay
      ? new Date(event.end.date + 'T00:00:00')
      : new Date(event.end.dateTime)

  const { prose, config } = parseEventDescription(event.description ?? '')

  const isTaskCal   = getTaskCalendars().includes(calendar.id)
  const completedAt = isTaskCal ? getCompletedAt(event.id) : null
  const itemId       = `gcal:${calendar.id}:${event.id}`

  // Comments sourced exclusively from the life log Sheet (single source of truth).
  const comments = getItemLog(itemId).map(e => ({
    timestamp: e.timestamp,
    text:      e.verb === 'comment' ? (e.action_detail?.text ?? e.narrative) : e.narrative,
    _readonly: e.verb !== 'comment',
  }))

  return {
    id: itemId,
    title: event.summary ?? '(No title)',
    item_type: 'EVENT',
    source: {
      provider: 'google-calendar',
      account_id: calendar.id,
      external_id: event.id,
    },
    start,
    end,
    due: null,
    all_day: allDay,
    status: completedAt ? 'COMPLETED' : (EVENT_STATUS[event.status] ?? 'CONFIRMED'),
    recurrence: event.recurrence?.[0] ?? null,
    metadata: {
      body: prose,
      config,
      comments,
      linked_task_ids: config?.tasks ?? [],
      spawn_prototypes: config?.spawn ?? [],
      calendar_name: calendar.summary,
      calendar_color: calendar.backgroundColor ?? null,
      recurringEventId: event.recurringEventId ?? null,
      location: event.location ?? null,
      task_calendar: isTaskCal,
      tags: decodeTags(event.extendedProperties?.private?.tags),
    },
    color: event.colorId ? resolveColor(event.colorId) : (calendar.backgroundColor ?? null),
    editable: event.organizer?.self === true,
  }
}

// Google Calendar event color palette (colorId 1–11)
const GCal_COLORS = {
  1: '#7986cb', 2: '#33b679', 3: '#8e24aa', 4: '#e67c73',
  5: '#f6c026', 6: '#f5511d', 7: '#039be5', 8: '#616161',
  9: '#3f51b5', 10: '#0b8043', 11: '#d60000',
}

function resolveColor(colorId) {
  return GCal_COLORS[colorId] ?? null
}

export async function getEvent(token, calendarId, eventId) {
  return get(token, `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`)
}

// Expanded occurrences of a recurring master between timeMin/timeMax (ISO). Used
// to remove "this and following" occurrences one-by-one when we can't rewrite the
// master's RRULE (non-organizer / read-only calendar) — the same thing the Google
// Calendar UI does for a guest.
export async function getEventInstances(token, calendarId, masterId, timeMin, timeMax) {
  const qs = new URLSearchParams({ timeMin, timeMax, showDeleted: 'false', maxResults: '2500' })
  const { items } = await paginate(
    token,
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(masterId)}/instances?${qs}`,
  )
  return items
}

export async function updateEvent(token, calendarId, eventId, body) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) throw await apiError('updateEvent', res)
  return res.json()
}

export async function moveEvent(token, sourceCalId, eventId, destCalId) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(sourceCalId)}/events/${encodeURIComponent(eventId)}/move?destination=${encodeURIComponent(destCalId)}`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
  )
  if (!res.ok) throw await apiError('moveEvent', res)
  return res.json()
}

export async function deleteEvent(token, calendarId, eventId) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
  )
  if (!res.ok) throw await apiError('deleteEvent', res)
}

export async function createEvent(token, calendarId, body) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) throw await apiError('createEvent', res)
  return res.json()
}

export async function getEvents(token, start, end) {
  await loadPrefs(token)   // must resolve before loadLifeLog reads getLifeLogSheetId()
  const taskCalendars = getTaskCalendars()
  const [calendars] = await Promise.all([
    getCalendars(token),
    loadCompletionStore(token),
    loadLifeLog(token),         // ensures getItemLog() returns correct data
  ])
  const results = await Promise.allSettled(
    calendars.map(async calendar => {
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '2500',
      })
      const { items: events, syncToken } = await paginate(
        token,
        `${BASE}/calendars/${encodeURIComponent(calendar.id)}/events?${params}`
      )
      if (syncToken) _syncTokens.set(calendar.id, syncToken)
      // normalizeEvent returns null for isTask=true events — filter them out.
      const normalized = events.map(e => normalizeEvent(e, calendar)).filter(Boolean)

      // For task calendars, merge in dated task events for the same range.
      // Stamp the calendar's background color onto task items so they match
      // non-tagged events on the same calendar (normalizeTask has no calendar object).
      if (taskCalendars.includes(calendar.id)) {
        let tasks = []
        try {
          const calColor = calendar.backgroundColor ?? null
          tasks = (await getTaskEvents(token, calendar.id, start, end))
            .map(t => ({ ...t, color: t.color ?? calColor }))
        } catch (err) {
          console.warn(`Task events fetch failed for ${calendar.id}:`, err.message)
        }
        return [...normalized, ...tasks]
      }
      return normalized
    })
  )

  return results
    .flatMap(r => {
      if (r.status === 'rejected') { console.warn('Calendar fetch error:', r.reason); return [] }
      return r.value
    })
}

// Incremental refresh using stored sync tokens. Only covers non-task calendars
// (task events use a separate filtered fetch that would need its own token).
// Returns a merged CalendarItem[] on success, or null if any token is stale/missing
// (caller should fall back to getEvents for a full re-fetch).
//
// `calendars` — the current calendarList (pass state.calendars from app.js).
// `currentItems` — the last known full item list to merge into.
export async function fetchDelta(token, calendars, currentItems) {
  const taskCalIds = new Set(getTaskCalendars())

  // Only include non-task calendars that already have a sync token.
  // If any non-task calendar is missing a token, we can't do a complete delta.
  const nonTaskCals = calendars.filter(c =>
    !taskCalIds.has(c.id) && c.accessRole !== 'freeBusyReader'
  )
  if (nonTaskCals.length === 0) return null
  if (nonTaskCals.some(c => !_syncTokens.has(c.id))) return null

  await Promise.all([loadCompletionStore(token), loadLifeLog(token)])

  let merged = [...currentItems]
  let stale  = false

  await Promise.allSettled(nonTaskCals.map(async calendar => {
    const syncToken = _syncTokens.get(calendar.id)
    const params = new URLSearchParams({ syncToken, singleEvents: 'true', maxResults: '2500' })
    const url = `${BASE}/calendars/${encodeURIComponent(calendar.id)}/events?${params}`

    let delta, newToken
    try {
      ;({ items: delta, syncToken: newToken } = await paginate(token, url))
    } catch (err) {
      if (err.message?.includes('410')) { _syncTokens.delete(calendar.id); stale = true; return }
      throw err
    }
    if (newToken) _syncTokens.set(calendar.id, newToken)

    for (const event of delta) {
      if (event.extendedProperties?.private?.kairosConfig === 'true') continue
      const id = `gcal:${calendar.id}:${event.id}`
      merged = merged.filter(i => i.id !== id)
      if (event.status !== 'cancelled') {
        const normalized = normalizeEvent(event, calendar)
        if (normalized) merged.push(normalized)
      }
    }
  }))

  return stale ? null : merged
}
