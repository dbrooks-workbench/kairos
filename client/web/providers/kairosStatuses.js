// Per-calendar workflow statuses stored in Firestore. A status is the board's
// column axis (workflow stage: intake → backlog → up next → in progress),
// orthogonal to lists (organization). Scoped to a calendar so a calendar acts
// as a shareable "project" container: sharing the calendar shares its statuses.
//
// statuses/{statusId}: { calendarId, name, order, inProgress }
//   - inProgress: boolean — many statuses may set it; any task in an inProgress
//     status gets the "in progress" (green) treatment wherever it renders.

import { fsAdd, fsList, fsSet, fsDelete } from './firestore.js'

// Seeded when a calendar is first designated a task/project calendar.
// The "In Progress" stage is flagged so freshly-seeded boards light up correctly.
const DEFAULT_STATUSES = [
  { name: 'Intake',      inProgress: false },
  { name: 'Backlog',     inProgress: false },
  { name: 'Up Next',     inProgress: false },
  { name: 'In Progress', inProgress: true  },
]

let _statuses    = null  // { [statusId]: record } — null until loaded
let _saveToken   = null
let _loadPromise = null

export async function loadStatuses(token) {
  if (_statuses !== null) return
  if (_loadPromise) return _loadPromise
  _loadPromise = _doLoad(token).finally(() => { _loadPromise = null })
  return _loadPromise
}

async function _doLoad(token) {
  _saveToken = token
  try {
    const docs = await fsList(token, 'statuses')
    _statuses = {}
    for (const { _id, ...record } of docs) {
      _statuses[_id] = record
    }
  } catch (err) {
    console.warn('Firestore statuses load failed:', err.message)
    _statuses = {}
  }
}

export function getStatusesForCalendar(calendarId) {
  if (!_statuses) return []
  return Object.entries(_statuses)
    .filter(([, r]) => r.calendarId === calendarId)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function getStatus(statusId) {
  if (!_statuses?.[statusId]) return null
  return { id: statusId, ..._statuses[statusId] }
}

export function getAllStatuses() {
  if (!_statuses) return []
  return Object.entries(_statuses).map(([id, r]) => ({ id, ...r }))
}

// IDs of every status flagged inProgress, across all calendars. Cheap Set for
// render-time "does this task get the green treatment?" checks (calendar view
// spans calendars, so this is intentionally not calendar-scoped).
export function getInProgressStatusIds() {
  if (!_statuses) return new Set()
  return new Set(
    Object.entries(_statuses).filter(([, r]) => r.inProgress).map(([id]) => id)
  )
}

export async function createStatus(token, calendarId, name, order = 0, inProgress = false) {
  const data = { calendarId, name, order, inProgress }
  const { _id, ...rest } = await fsAdd(token ?? _saveToken, 'statuses', data)
  if (_statuses) _statuses[_id] = rest
  return { id: _id, ...rest }
}

export async function updateStatus(token, statusId, changes) {
  if (!_statuses?.[statusId]) return
  const updated = { ..._statuses[statusId], ...changes }
  _statuses[statusId] = updated
  await fsSet(token ?? _saveToken, `statuses/${statusId}`, updated)
  return { id: statusId, ...updated }
}

export async function deleteStatus(token, statusId) {
  if (_statuses) delete _statuses[statusId]
  await fsDelete(token ?? _saveToken, `statuses/${statusId}`)
}

// Create the default statuses for a calendar just designated as a task calendar.
// No-op if the calendar already has statuses.
export async function ensureDefaultStatuses(token, calendarId) {
  const existing = getStatusesForCalendar(calendarId)
  if (existing.length > 0) return existing
  const created = []
  for (let i = 0; i < DEFAULT_STATUSES.length; i++) {
    const { name, inProgress } = DEFAULT_STATUSES[i]
    created.push(await createStatus(token, calendarId, name, i * 10, inProgress))
  }
  return created
}
