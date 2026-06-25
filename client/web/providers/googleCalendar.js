import { parseEventDescription } from './parsers.js'
import { loadPrefs, getCommitmentCalendars } from './drivePrefs.js'
import { loadEventTaskMeta, getEventCompletedAt } from './driveEventTaskMeta.js'
import { loadLifeLog, getItemLog } from './lifeLog.js'

const BASE = 'https://www.googleapis.com/calendar/v3'

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

async function paginate(token, url) {
  const items = []
  let pageToken = null
  do {
    const data = await get(token, pageToken ? `${url}&pageToken=${pageToken}` : url)
    if (data.items?.length) items.push(...data.items)
    pageToken = data.nextPageToken ?? null
  } while (pageToken)
  return items
}

export async function getCalendars(token) {
  const data = await get(token, `${BASE}/users/me/calendarList`)
  return (data.items ?? []).filter(c => c.accessRole !== 'freeBusyReader')
}

function normalizeEvent(event, calendar) {
  const allDay = !!event.start?.date
  const start = allDay
    ? new Date(event.start.date + 'T00:00:00')
    : new Date(event.start.dateTime)
  const end = !event.end ? null
    : allDay
      ? new Date(event.end.date + 'T00:00:00')
      : new Date(event.end.dateTime)

  const { prose, config } = parseEventDescription(event.description ?? '')

  const isCommitment = getCommitmentCalendars().includes(calendar.id)
  const completedAt  = isCommitment ? getEventCompletedAt(event.id) : null
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
      recurring_event_id: event.recurringEventId ?? null,
      location: event.location ?? null,
      task_calendar: isCommitment,
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

export async function updateEvent(token, calendarId, eventId, body) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  )
  if (!res.ok) throw new Error(`updateEvent: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function deleteEvent(token, calendarId, eventId) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`deleteEvent: ${res.status} ${res.statusText}`)
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
  if (!res.ok) throw new Error(`createEvent: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function getEvents(token, start, end) {
  const [calendars] = await Promise.all([
    getCalendars(token),
    loadPrefs(token),           // ensures getCommitmentCalendars() returns correct data
    loadEventTaskMeta(token),   // ensures getEventCompletedAt() returns correct data
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
      const events = await paginate(
        token,
        `${BASE}/calendars/${encodeURIComponent(calendar.id)}/events?${params}`
      )
      return events.map(e => normalizeEvent(e, calendar))
    })
  )

  return results
    .flatMap(r => {
      if (r.status === 'rejected') { console.warn('Calendar fetch error:', r.reason); return [] }
      return r.value
    })
}
