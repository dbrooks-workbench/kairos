import { generateKairosId } from './driveTaskMeta.js'

// Task events stored in Google Calendar using extendedProperties.private.
// isTask='true' marks the event as a Kairos task (never a regular event).
//
// extendedProperties.private schema:
//   kairosId    — stable identifier (survives events.move)
//   isTask      — 'true' always
//   listId      — Firestore list ID (organization axis)
//   statusId    — Firestore status ID (workflow axis; board column)
//   order       — sparse float string for manual sorting
//   loe         — level-of-effort string, optional
//   noDate      — 'true' when undated (start.date = KAIROS_UNDATED_SENTINEL)
//   unprocessed — 'true' when newly imported and not yet triaged
//   completedAt — ISO timestamp or absent (absent = not complete)

export const KAIROS_UNDATED_SENTINEL = '1970-01-01'

// Prefix written to the Google Calendar event summary when a task is completed.
// Lets standard GCal clients show completion state without Kairos open.
// Stripped from CalendarItem.title at normalization time so Kairos UI never
// sees it — completion state is authoritative in extendedProperties (completedAt).
const COMPLETED_PREFIX = '✅ '
const PENDING_PREFIX   = '☐ '

const BASE = 'https://www.googleapis.com/calendar/v3'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Strips any status prefix then re-applies the correct one for isCompleted.
function _applyPrefix(title, isCompleted) {
  const clean = (title ?? '').replace(/^(?:✅|☐)\s*/, '')
  return (isCompleted ? COMPLETED_PREFIX : PENDING_PREFIX) + clean
}

// Strips any status prefix. Used at normalization time so Kairos UI sees clean titles.
function _stripPrefix(title) {
  return (title ?? '').replace(/^(?:✅|☐)\s*/, '')
}

function _nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt  = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = n => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

function _markDoneFooter(kairosId) {
  const origin  = (typeof window !== 'undefined') ? window.location.origin : ''
  const viewUrl = `${origin}/?task=${encodeURIComponent(kairosId)}`
  return `<div data-kairos="complete-link" style="margin-top:12px;border-top:1px solid #eee;padding-top:8px;font-size:12px;color:#888"><a href="${viewUrl}" style="color:#1a73e8">View on Kairos</a></div>`
}

function _stripCompleteLink(html) {
  if (!html) return ''
  return html.replace(/<div[^>]*data-kairos="complete-link"[^>]*>[\s\S]*?<\/div>/gi, '').trim()
}

// Minimal normalization for GCal-native events on task calendars (no isTask='true').
// Produces just enough structure for ensureFooters to process and promote them.
function _normalizeNativeEvent(event, calId) {
  if (event.status === 'cancelled') return null
  const rawSummary  = event.summary ?? ''
  const desc        = event.description ?? ''
  const isCompleted = rawSummary.startsWith(COMPLETED_PREFIX)
  const isPending   = rawSummary.startsWith(PENDING_PREFIX)
  return {
    item_type:  'EVENT',
    title:      _stripPrefix(rawSummary),
    source:     { account_id: calId, external_id: event.id },
    status:     isCompleted ? 'COMPLETED' : 'NEEDS_ACTION',
    recurrence: event.recurrence?.[0] ?? null,
    metadata: {
      task_calendar: true,
      kairosId:      null,
      unprocessed:   false,
      noDate:        false,
      hasViewLink:   desc.includes('View on Kairos'),
      hasPrefix:     isCompleted || isPending,
      body:          _stripCompleteLink(desc) || null,
    },
  }
}

function _extractWebhookToken(description) {
  if (!description) return null
  const m = description.match(/[?&]wt=([^&"<\s]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

function _buildDescriptionPatch(item) {
  if (!item) return {}
  const { kairosId, body } = item.metadata ?? {}
  if (!kairosId) return {}
  const footer = _markDoneFooter(kairosId)
  const rawBody = body ?? ''
  return { description: rawBody ? `${rawBody}${footer}` : footer }
}

function _buildEventBody(taskData, isCreate = false) {
  const {
    title, body, kairosId, listId, statusId, order, loe,
    date, noDate, allDay, startTime, endDate, endTime, timeZone,
    location, unprocessed, webhookToken, recurrence, completed, completedAt,
  } = taskData

  const isUndated = noDate || !date
  const dateStr   = isUndated ? KAIROS_UNDATED_SENTINEL : date
  // allDay defaults to true when not explicitly set (preserves existing all-day behaviour)
  const isAllDay  = isUndated || allDay !== false

  let startField, endField
  if (isAllDay) {
    const eStr = isUndated ? _nextDay(dateStr)
      : _nextDay(endDate && endDate >= dateStr ? endDate : dateStr)
    startField = { date: dateStr }
    endField   = { date: eStr }
  } else {
    const tz = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    startField = { dateTime: `${dateStr}T${startTime ?? '09:00'}:00`,          timeZone: tz }
    endField   = { dateTime: `${endDate ?? dateStr}T${endTime ?? '09:30'}:00`, timeZone: tz }
  }

  const footer = (!isUndated && kairosId) ? _markDoneFooter(kairosId) : ''
  const rawBody = _stripCompleteLink(body ?? '')
  const description = rawBody ? `${rawBody}${footer}` : (footer || undefined)

  const props = {
    kairosId,
    isTask:  'true',
    listId:  listId ?? '',
    order:   String(order ?? 0),
  }
  // Only touch statusId when the caller supplies it — on PATCH, omitting a key
  // from extendedProperties.private preserves the stored value (Google merges),
  // so editor saves that don't carry statusId won't wipe a task's column.
  if (statusId !== undefined) props.statusId = statusId ?? ''
  if (loe)         props.loe         = loe
  // null clears an existing noDate property via PATCH merge; omit on POST (Google rejects null in extendedProperties)
  if (isUndated)        props.noDate = 'true'
  else if (!isCreate)   props.noDate = null
  if (completedAt) props.completedAt = completedAt
  if (unprocessed) props.unprocessed = 'true'

  return {
    summary: _applyPrefix(title, !!completed),
    ...(description !== undefined && { description }),
    ...(location  && { location }),
    start: startField,
    end:   endField,
    extendedProperties: { private: props },
    // recurrence: undefined leaves the existing rule unchanged on PATCH.
    ...(recurrence !== undefined && { recurrence: recurrence ? [recurrence] : [] }),
  }
}

// ── Normalize raw Calendar event → CalendarItem ───────────────────────────────

export function normalizeTask(event, calendarId) {
  const p           = event.extendedProperties?.private ?? {}
  const dateStr     = event.start?.date ?? event.start?.dateTime?.slice(0, 10)
  const isUndated   = p.noDate === 'true' || dateStr === KAIROS_UNDATED_SENTINEL || !dateStr
  const completedAt = p.completedAt || null

  const rawTitle   = event.summary ?? ''
  const hasPrefix  = /^(?:✅|☐)/.test(rawTitle)
  const cleanTitle = _stripPrefix(rawTitle) || '(No title)'

  const allDay = !!event.start?.date
  const start  = isUndated ? null
    : allDay ? new Date(dateStr + 'T00:00:00')
    : new Date(event.start.dateTime)
  // For all-day: GCal end.date is exclusive (day after), don't surface as end.
  // For timed: surface the actual end dateTime.
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null

  return {
    id:        `gcal:${calendarId}:${event.id}`,
    title:     cleanTitle,
    item_type: 'TASK',
    source: {
      provider:    'google-calendar-task',
      account_id:  calendarId,
      external_id: event.id,
    },
    start,
    end,
    due:       start,
    all_day:   allDay,
    status:    completedAt ? 'COMPLETED' : 'NEEDS_ACTION',
    recurrence: event.recurrence?.[0] ?? null,
    metadata: {
      kairosId:         p.kairosId    ?? null,
      webhookToken:     _extractWebhookToken(event.description ?? null),
      hasViewLink:      (event.description ?? '').includes('View on Kairos'),
      hasPrefix,
      listId:           p.listId      || null,
      statusId:         p.statusId    || null,
      order:            p.order != null ? parseFloat(p.order) : null,
      loe:              p.loe         ?? null,
      noDate:           isUndated,
      location:         event.location ?? null,
      unprocessed:      p.isTask !== 'true',
      recurringEventId: event.recurringEventId ?? null,
      completedAt,
      body:             _stripCompleteLink(event.description ?? ''),
    },
    color:    null,
    editable: true,
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function _authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function _patch(token, calId, eventId, body) {
  const serialized = JSON.stringify(body)
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', headers: _authHeaders(token), body: serialized }
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`calendarTasks PATCH ${res.status}: ${detail || res.statusText}\nRequest: ${serialized}`)
  }
  return res.json()
}

async function _post(token, calId, body) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calId)}/events`,
    { method: 'POST', headers: _authHeaders(token), body: JSON.stringify(body) }
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`calendarTasks POST ${res.status}: ${detail || res.statusText}`)
  }
  return res.json()
}

// ── Task CRUD ─────────────────────────────────────────────────────────────────

export async function createTask(token, calendarId, taskData) {
  const event = await _post(token, calendarId, _buildEventBody(taskData, true))
  return normalizeTask(event, calendarId)
}

// Full update from task editor save. taskData same shape as createTask.
export async function updateTask(token, calendarId, eventId, taskData) {
  const event = await _patch(token, calendarId, eventId, _buildEventBody(taskData))
  return normalizeTask(event, calendarId)
}

// Changes a task's date (snooze). Patches start/end and clears noDate.
export async function patchTaskDate(token, calendarId, eventId, newDateStr) {
  const event = await _patch(token, calendarId, eventId, {
    start: { date: newDateStr },
    end:   { date: _nextDay(newDateStr) },
    extendedProperties: { private: { noDate: null } },
  })
  return normalizeTask(event, calendarId)
}

// Partial update for system-managed properties (order, listId, etc.).
// Values are coerced to strings; null clears a property from extendedProperties.
export async function patchTaskProps(token, calendarId, eventId, props) {
  const stringified = {}
  for (const [k, v] of Object.entries(props)) {
    stringified[k] = v === null ? null : String(v)
  }
  const event = await _patch(token, calendarId, eventId, {
    extendedProperties: { private: stringified },
  })
  return normalizeTask(event, calendarId)
}

// Moves the event to a different calendar. Event ID and all extendedProperties
// are preserved by the API (unlike copying and deleting).
export async function moveTask(token, sourceCalId, eventId, destCalId) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(sourceCalId)}/events/${encodeURIComponent(eventId)}/move?destination=${encodeURIComponent(destCalId)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`calendarTasks move ${res.status}: ${res.statusText}`)
  return res.json()
}

export async function deleteTask(token, calendarId, eventId) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok && res.status !== 410) {
    throw new Error(`calendarTasks DELETE ${res.status}: ${res.statusText}`)
  }
}

// ── Completion ────────────────────────────────────────────────────────────────

export async function completeTask(token, calendarId, eventId, title = '', item = null) {
  const event = await _patch(token, calendarId, eventId, {
    summary: _applyPrefix(title, true),
    extendedProperties: { private: { completedAt: new Date().toISOString() } },
    ..._buildDescriptionPatch(item, true),
  })
  return normalizeTask(event, calendarId)
}

export async function uncompleteTask(token, calendarId, eventId, title = '', item = null) {
  const event = await _patch(token, calendarId, eventId, {
    summary: _applyPrefix(title, false),
    extendedProperties: { private: { completedAt: null } },
    ..._buildDescriptionPatch(item, false),
  })
  return normalizeTask(event, calendarId)
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function _fetchPage(token, calendarId, params) {
  const items = []
  let pageToken = null
  do {
    if (pageToken) params.set('pageToken', pageToken)
    const res = await fetch(
      `${BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) throw new Error(`Calendar events ${res.status}: ${res.statusText}`)
    const data = await res.json()
    items.push(...(data.items ?? []))
    pageToken = data.nextPageToken ?? null
  } while (pageToken)
  return items
}

export async function getTaskEvents(token, calendarId, start, end) {
  const params = new URLSearchParams({
    privateExtendedProperty: 'isTask=true',
    timeMin:      start.toISOString(),
    timeMax:      end.toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '2500',
  })
  return (await _fetchPage(token, calendarId, params)).map(e => normalizeTask(e, calendarId))
}

// Returns all task events for board view: Kairos-tagged events (full range,
// including undated sentinel) plus any untagged events in a rolling ±window
// (so raw calendar events and recurring tasks surface in the Unlisted column).
export async function getAllTaskEvents(token, calendarId) {
  const now     = new Date()
  const past    = new Date(now.getTime() - 30  * 86_400_000)
  const future  = new Date(now.getTime() + 180 * 86_400_000)

  const [tagged, all] = await Promise.all([
    _fetchPage(token, calendarId, new URLSearchParams({
      privateExtendedProperty: 'isTask=true',
      timeMin:      new Date(KAIROS_UNDATED_SENTINEL + 'T00:00:00Z').toISOString(),
      timeMax:      new Date('2099-12-31T23:59:59Z').toISOString(),
      singleEvents: 'true',
      orderBy:      'startTime',
      maxResults:   '2500',
    })),
    _fetchPage(token, calendarId, new URLSearchParams({
      timeMin:      past.toISOString(),
      timeMax:      future.toISOString(),
      singleEvents: 'true',
      orderBy:      'startTime',
      maxResults:   '2500',
    })),
  ])

  const taggedIds = new Set(tagged.map(e => e.id))

  // Deduplicate recurring instances in the untagged set: keep only the first
  // (earliest) instance per series. Events are ordered by startTime so the first
  // hit is the soonest upcoming occurrence — one Unlisted card per series.
  const seenSeries = new Set()
  const untagged   = all.filter(e => {
    if (taggedIds.has(e.id)) return false
    const seriesKey = e.recurringEventId ?? e.id
    if (seenSeries.has(seriesKey)) return false
    seenSeries.add(seriesKey)
    return true
  })

  return [...tagged, ...untagged].map(e => normalizeTask(e, calendarId))
}

// Global one-time backfill: fetches all task MASTER events (not instances) across
// the given calendars and patches any that are missing the "View in Kairos" footer.
// Patching the master propagates the footer to all future instances via inheritance,
// avoiding the need to patch every individual recurring instance separately.
export async function ensureAllFooters(token, calendarIds) {
  const timeMin = new Date(KAIROS_UNDATED_SENTINEL + 'T00:00:00Z').toISOString()
  const timeMax = new Date('2099-12-31T23:59:59Z').toISOString()
  const items   = []
  for (const calId of calendarIds) {
    // Pass 1: Kairos task events (have isTask='true'). Omit singleEvents so
    // recurring masters are returned; patching a master propagates to instances.
    const masters = await _fetchPage(token, calId, new URLSearchParams({
      privateExtendedProperty: 'isTask=true',
      timeMin, timeMax, maxResults: '2500',
    })).catch(err => { console.warn('[ensureAllFooters] task fetch failed:', calId, err.message); return [] })
    items.push(...masters.map(e => normalizeTask(e, calId)))

    // Pass 2: GCal-native events on this task calendar (no isTask='true').
    // These were created directly in Google Calendar and need to be promoted.
    const raw = await _fetchPage(token, calId, new URLSearchParams({
      timeMin, timeMax, maxResults: '2500',
    })).catch(err => { console.warn('[ensureAllFooters] native fetch failed:', calId, err.message); return [] })
    const native = raw
      .filter(e => e.extendedProperties?.private?.isTask !== 'true')
      .map(e => _normalizeNativeEvent(e, calId))
      .filter(Boolean)
    items.push(...native)
  }
  await ensureFooters(token, items)
}

// Returns the first task event with the given kairosId, searching across the
// supplied calendar IDs. Used for deep-link navigation from "View in Kairos".
export async function findTaskByKairosId(token, calendarIds, kairosId) {
  const params = new URLSearchParams({
    privateExtendedProperty: `kairosId=${kairosId}`,
    timeMin:      new Date(KAIROS_UNDATED_SENTINEL).toISOString(),
    timeMax:      new Date('2099-12-31T23:59:59Z').toISOString(),
    singleEvents: 'true',
    orderBy:      'startTime',
    maxResults:   '1',
  })
  for (const calId of calendarIds) {
    const items = await _fetchPage(token, calId, params).catch(() => [])
    if (items.length) return normalizeTask(items[0], calId)
  }
  return null
}

// Backfill: patch any task events in `items` that are missing the "View on Kairos"
// footer link or the correct title prefix (☐/✅).
// Idempotent — skips items that have both. No-ops instantly when everything is current.
export async function ensureFooters(token, items) {
  const tasks = items.filter(i =>
    i.item_type === 'TASK' || (i.item_type === 'EVENT' && i.metadata?.task_calendar)
  )
  const stale = []
  for (const item of tasks) {
    const { unprocessed, noDate, hasViewLink, hasPrefix } = item.metadata ?? {}
    if (unprocessed) {
      console.log('[ensureFooters] SKIP unprocessed:', item.title, '·', item.source.external_id)
      continue
    }
    if (noDate) {
      console.log('[ensureFooters] SKIP noDate:', item.title, '·', item.source.external_id)
      continue
    }
    if (hasViewLink && hasPrefix) {
      console.log('[ensureFooters] OK:', item.title, '· hasViewLink:', hasViewLink, '· hasPrefix:', hasPrefix)
      continue
    }
    console.log('[ensureFooters] STALE:', item.title, '· hasViewLink:', hasViewLink, '· hasPrefix:', hasPrefix)
    stale.push(item)
  }
  if (!stale.length) return

  // Sequential with 150 ms gap to stay within Google Calendar API rate limits.
  for (const item of stale) {
    const kairosId          = item.metadata.kairosId ?? generateKairosId()
    const isRecurringMaster = item.recurrence !== null
    const completed         = !isRecurringMaster && item.status === 'COMPLETED'
    const footer            = _markDoneFooter(kairosId)
    const rawBody           = item.metadata.body ?? ''
    const body              = {
      summary:     _applyPrefix(item.title, completed),
      description: rawBody ? `${rawBody}${footer}` : footer,
    }
    if (!item.metadata.kairosId || item.item_type === 'EVENT') {
      body.extendedProperties = { private: { kairosId, isTask: 'true' } }
    }
    try {
      await _patch(token, item.source.account_id, item.source.external_id, body)
      console.log('[ensureFooters] PATCHED:', item.title, '· kairosId:', kairosId)
    } catch (err) {
      console.warn('[ensureFooters] patch failed:', kairosId, err.message)
    }
    await new Promise(r => setTimeout(r, 150))
  }
}

// Resets order values to evenly-spaced integers when float precision runs low.
// Caller passes the already-filtered column items (by statusId or listId).
// Sorts by current order, then assigns 10, 20, 30, ...
export async function rebalanceColumn(token, calendarId, items) {
  const sorted = [...items].sort((a, b) => (a.metadata.order ?? 0) - (b.metadata.order ?? 0))
  await Promise.all(
    sorted.map((item, i) =>
      patchTaskProps(token, calendarId, item.source.external_id, { order: (i + 1) * 10 })
    )
  )
}
