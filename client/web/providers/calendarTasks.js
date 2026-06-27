// Task events stored in Google Calendar using extendedProperties.private.
// isTask='true' marks the event as a Kairos task (never a regular event).
//
// extendedProperties.private schema:
//   kairosId    — stable identifier (survives events.move)
//   isTask      — 'true' always
//   listId      — Firestore list ID
//   order       — sparse float string for manual sorting
//   loe         — level-of-effort string, optional
//   noDate      — 'true' when undated (start.date = KAIROS_UNDATED_SENTINEL)
//   unprocessed — 'true' when newly imported and not yet triaged
//   completedAt — ISO timestamp or absent (absent = not complete)

export const KAIROS_UNDATED_SENTINEL = '1970-01-01'

const BASE = 'https://www.googleapis.com/calendar/v3'

// ── Helpers ───────────────────────────────────────────────────────────────────

function _nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt  = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = n => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

function _markDoneFooter(kairosId, webhookToken) {
  const origin = (typeof window !== 'undefined') ? window.location.origin : ''
  const url = `${origin}/api/complete?kairosId=${encodeURIComponent(kairosId)}&wt=${encodeURIComponent(webhookToken)}`
  return `<div data-kairos="complete-link" style="margin-top:12px;border-top:1px solid #eee;padding-top:8px;font-size:12px;color:#888"><a href="${url}" style="color:#1a73e8">✓ Mark as done in Kairos</a></div>`
}

function _stripCompleteLink(html) {
  if (!html) return ''
  return html.replace(/<div[^>]*data-kairos="complete-link"[^>]*>[\s\S]*?<\/div>/gi, '').trim()
}

function _buildEventBody(taskData) {
  const { title, body, kairosId, listId, order, loe, date, noDate, unprocessed, webhookToken } = taskData
  const isUndated = noDate || !date
  const dateStr   = isUndated ? KAIROS_UNDATED_SENTINEL : date

  const footer = (!isUndated && webhookToken) ? _markDoneFooter(kairosId, webhookToken) : ''
  const rawBody = _stripCompleteLink(body ?? '')
  const description = rawBody ? `${rawBody}${footer}` : (footer || undefined)

  const props = {
    kairosId,
    isTask:  'true',
    listId:  listId ?? '',
    order:   String(order ?? 0),
  }
  if (loe)         props.loe         = loe
  if (isUndated)   props.noDate      = 'true'
  if (unprocessed) props.unprocessed = 'true'

  return {
    summary: title,
    ...(description !== undefined && { description }),
    start: { date: dateStr },
    end:   { date: _nextDay(dateStr) },
    extendedProperties: { private: props },
  }
}

// ── Normalize raw Calendar event → CalendarItem ───────────────────────────────

export function normalizeTask(event, calendarId) {
  const p          = event.extendedProperties?.private ?? {}
  // All-day events have start.date; timed events have start.dateTime — use date portion for both
  const dateStr    = event.start?.date ?? event.start?.dateTime?.slice(0, 10)
  const isUndated  = p.noDate === 'true' || dateStr === KAIROS_UNDATED_SENTINEL || !dateStr
  const start      = isUndated ? null : new Date(dateStr + 'T00:00:00')
  const completedAt = p.completedAt || null

  return {
    id:        `gcal:${calendarId}:${event.id}`,
    title:     event.summary ?? '(No title)',
    item_type: 'TASK',
    source: {
      provider:    'google-calendar-task',
      account_id:  calendarId,
      external_id: event.id,
    },
    start,
    end:       null,
    due:       start,
    all_day:   !!event.start?.date,
    status:    completedAt ? 'COMPLETED' : 'NEEDS_ACTION',
    recurrence: null,
    metadata: {
      kairosId:         p.kairosId    ?? null,
      listId:           p.listId      || null,
      order:            p.order != null ? parseFloat(p.order) : null,
      loe:              p.loe         ?? null,
      noDate:           isUndated,
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
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PATCH', headers: _authHeaders(token), body: JSON.stringify(body) }
  )
  if (!res.ok) throw new Error(`calendarTasks PATCH ${res.status}: ${res.statusText}`)
  return res.json()
}

async function _post(token, calId, body) {
  const res = await fetch(
    `${BASE}/calendars/${encodeURIComponent(calId)}/events`,
    { method: 'POST', headers: _authHeaders(token), body: JSON.stringify(body) }
  )
  if (!res.ok) throw new Error(`calendarTasks POST ${res.status}: ${res.statusText}`)
  return res.json()
}

// ── Task CRUD ─────────────────────────────────────────────────────────────────

export async function createTask(token, calendarId, taskData) {
  const event = await _post(token, calendarId, _buildEventBody(taskData))
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

export async function completeTask(token, calendarId, eventId) {
  return patchTaskProps(token, calendarId, eventId, { completedAt: new Date().toISOString() })
}

// null clears the completedAt key from extendedProperties.private
export async function uncompleteTask(token, calendarId, eventId) {
  return patchTaskProps(token, calendarId, eventId, { completedAt: null })
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

// Resets order values to evenly-spaced integers when float precision runs low.
// Sorts by current order, then assigns 10, 20, 30, ...
export async function rebalanceColumn(token, calendarId, listId, items) {
  const filtered = items.filter(i => i.metadata.listId === listId)
  const sorted   = [...filtered].sort((a, b) => (a.metadata.order ?? 0) - (b.metadata.order ?? 0))
  await Promise.all(
    sorted.map((item, i) =>
      patchTaskProps(token, calendarId, item.source.external_id, { order: (i + 1) * 10 })
    )
  )
}
