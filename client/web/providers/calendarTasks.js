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

// Prefix written to the Google Calendar event summary when a task is completed.
// Lets standard GCal clients show completion state without Kairos open.
// Stripped from CalendarItem.title at normalization time so Kairos UI never
// sees it — completion state is authoritative in Drive (completedAt).
const COMPLETED_PREFIX = '✅ '

const BASE = 'https://www.googleapis.com/calendar/v3'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Adds or removes COMPLETED_PREFIX from a title to match isCompleted.
// Safe to call redundantly — only modifies when the prefix state is wrong.
function _applyPrefix(title, isCompleted) {
  const has = (title ?? '').startsWith(COMPLETED_PREFIX)
  if (isCompleted && !has) return COMPLETED_PREFIX + (title ?? '')
  if (!isCompleted && has)  return (title ?? '').slice(COMPLETED_PREFIX.length)
  return title ?? ''
}

function _nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt  = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = n => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

function _markDoneFooter(kairosId, webhookToken, completed) {
  const origin  = (typeof window !== 'undefined') ? window.location.origin : ''
  const url     = `${origin}/api/complete?kairosId=${encodeURIComponent(kairosId)}&wt=${encodeURIComponent(webhookToken)}`
  const label   = completed ? '↩ Mark as incomplete in Kairos' : '✓ Mark as complete in Kairos'
  const viewUrl = `${origin}/?task=${encodeURIComponent(kairosId)}`
  return `<div data-kairos="complete-link" style="margin-top:12px;border-top:1px solid #eee;padding-top:8px;font-size:12px;color:#888"><a href="${url}" style="color:#1a73e8;display:block">${label}</a><a href="${viewUrl}" style="color:#1a73e8;display:block;margin-top:4px">View in Kairos</a></div>`
}

function _stripCompleteLink(html) {
  if (!html) return ''
  return html.replace(/<div[^>]*data-kairos="complete-link"[^>]*>[\s\S]*?<\/div>/gi, '').trim()
}

function _extractWebhookToken(description) {
  if (!description) return null
  const m = description.match(/[?&]wt=([^&"<\s]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

function _buildDescriptionPatch(item, nowCompleted) {
  if (!item) return {}
  const { kairosId, webhookToken, body } = item.metadata ?? {}
  if (!kairosId || !webhookToken) return {}
  const footer = _markDoneFooter(kairosId, webhookToken, nowCompleted)
  const rawBody = body ?? ''
  return { description: rawBody ? `${rawBody}${footer}` : footer }
}

function _buildEventBody(taskData, isCreate = false) {
  const {
    title, body, kairosId, listId, order, loe,
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

  const footer = (!isUndated && webhookToken) ? _markDoneFooter(kairosId, webhookToken, !!completed) : ''
  const rawBody = _stripCompleteLink(body ?? '')
  const description = rawBody ? `${rawBody}${footer}` : (footer || undefined)

  const props = {
    kairosId,
    isTask:  'true',
    listId:  listId ?? '',
    order:   String(order ?? 0),
  }
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

  const rawTitle = event.summary ?? ''
  const cleanTitle = rawTitle.startsWith(COMPLETED_PREFIX)
    ? rawTitle.slice(COMPLETED_PREFIX.length) || '(No title)'
    : rawTitle || '(No title)'

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
      hasViewLink:      (event.description ?? '').includes('?task='),
      listId:           p.listId      || null,
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
  console.log('[calendarTasks PATCH]', eventId, body)
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
  const items = []
  for (const calId of calendarIds) {
    // Omit singleEvents so recurring masters are returned instead of instances.
    // orderBy requires singleEvents=true so it must be omitted here too.
    const masters = await _fetchPage(token, calId, new URLSearchParams({
      privateExtendedProperty: 'isTask=true',
      timeMin:    new Date(KAIROS_UNDATED_SENTINEL + 'T00:00:00Z').toISOString(),
      timeMax:    new Date('2099-12-31T23:59:59Z').toISOString(),
      maxResults: '2500',
    })).catch(err => { console.warn('[ensureAllFooters] fetch failed:', calId, err.message); return [] })
    items.push(...masters.map(e => normalizeTask(e, calId)))
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

// Backfill: patch any task events in `items` that are missing the "View in Kairos"
// footer link, building the correct description and title prefix for each.
// Idempotent — items with hasViewLink=true are skipped. No-ops instantly when
// everything is already up to date (no webhook-token fetch, no API calls).
export async function ensureFooters(token, items) {
  const tasks = items.filter(i => i.item_type === 'TASK')
  const stale = tasks.filter(item =>
    item.metadata?.kairosId &&
    !item.metadata?.unprocessed &&
    !item.metadata?.noDate &&
    !item.metadata?.hasViewLink
  )
  console.log(`[ensureFooters] ${tasks.length} tasks, ${stale.length} need footer update`)
  if (!stale.length) return

  let wt = null
  try {
    const r = await fetch('/api/webhook-token', { credentials: 'include' })
    if (r.ok) wt = (await r.json()).token ?? null
  } catch (err) {
    console.warn('[ensureFooters] webhook-token fetch failed:', err.message)
  }
  if (!wt) { console.warn('[ensureFooters] no webhook token, aborting'); return }

  let patched = 0
  for (let i = 0; i < stale.length; i += 5) {
    await Promise.all(stale.slice(i, i + 5).map(async item => {
      const { kairosId } = item.metadata
      const completed    = item.status === 'COMPLETED'
      const footer       = _markDoneFooter(kairosId, wt, completed)
      const rawBody      = item.metadata.body ?? ''
      try {
        await _patch(token, item.source.account_id, item.source.external_id, {
          summary:     _applyPrefix(item.title, completed),
          description: rawBody ? `${rawBody}${footer}` : footer,
        })
        patched++
      } catch (err) {
        console.warn('[ensureFooters] patch failed:', kairosId, err.message)
      }
    }))
  }
  console.log(`[ensureFooters] patched ${patched}/${stale.length}`)
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
