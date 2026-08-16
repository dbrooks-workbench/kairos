// User preferences stored in Firestore (prefs/main document).
//
// Shape:
//   {
//     version: 1,
//     hiddenCalendars:     string[],
//     taskCalendars:       string[],   // ordered project/task calendars
//     taskColumnSort:      { [calId]: 'manual' | 'date' },
//     sweepSources:        [{ accountId, listId, listName }],
//     defaultIntakeListId: string|null, // DEPRECATED (retired in intake cutover) — replaced by intakeStatusId
//     intakeStatusId:      string|null, // shared bucket — voice captures + swept tasks land in this status; the
//                                       // status record carries its own calendarId, so this one pointer resolves
//                                       // to both the destination status and its project calendar
//   }

import { fsGet, fsSet } from './firestore.js'

const DEFAULTS = () => ({
  version:             1,
  hiddenCalendars:     [],
  taskCalendars:       [],
  taskColumnSort:      {},
  sweepSources:        [],   // [{ accountId, listId, listName }]
  defaultIntakeListId: null, // DEPRECATED — see intakeStatusId
  intakeStatusId:      null, // Kairos status ID — shared intake bucket for voice captures + swept tasks
  projectCalendarId:   null, // calendar the board + list views are scoped to (the active "project")
  visibilityStart:     null, // custom visibility-window start 'YYYY-MM-DD' (null = default: today-14d)
  visibilityEnd:       null, // custom visibility-window end   'YYYY-MM-DD' (null = default: today+14d)
  maxWindowDays:       180,  // cap on the effective visibility span; browsing past it truncates the trailing end
  recurringCollapsed:  false, // board: the synthetic Recurring column is collapsed to a strip
  doneCollapsed:       false, // board: the synthetic Done column is collapsed to a strip
  listsMigrated:       false, // one-time: legacy listId -> tag migration has run
  lastUsedTaskCalendarId:  null,
  lastUsedEventCalendarId: null,
})

let _prefs       = null
let _saveToken   = null
let _dirty       = false
let _saveTimer   = null
let _loadPromise = null

export async function loadPrefs(token) {
  if (_prefs) return _prefs
  if (_loadPromise) return _loadPromise
  _loadPromise = _doLoad(token).finally(() => { _loadPromise = null })
  return _loadPromise
}

async function _doLoad(token) {
  _saveToken = token
  try {
    const data = await fsGet(token, 'prefs/main')
    if (data) {
      _prefs = { ...DEFAULTS(), ...data }
      // Migrate legacy sweepTargetListId → defaultIntakeListId (renamed 2026-07:
      // the destination is now a general intake bucket, not sweep-specific).
      if (_prefs.defaultIntakeListId == null && data.sweepTargetListId != null) {
        _prefs.defaultIntakeListId = data.sweepTargetListId
      }
      delete _prefs.sweepTargetListId  // fsSet full-replaces, so the stale key is dropped on next save
    } else {
      _prefs = DEFAULTS()
      await fsSet(token, 'prefs/main', _prefs)
    }
  } catch (err) {
    if (err.message?.includes('403')) {
      console.error('[Firestore] 403 — ensure GOOGLE_PROJECT_ID is set, Firestore API is enabled, and you have re-signed in to grant the datastore scope')
    } else {
      console.warn('Firestore prefs load failed:', err.message)
    }
    _prefs = DEFAULTS()
  }
  return _prefs
}

// ── Getters ───────────────────────────────────────────────────────────────────

export function getHiddenCalendars()  { return _prefs?.hiddenCalendars   ?? [] }
export function getTaskCalendars()    { return _prefs?.taskCalendars     ?? [] }
export function getTaskColumnSort()   { return _prefs?.taskColumnSort    ?? {} }
export function getSweepSources()       { return _prefs?.sweepSources        ?? [] }
export function getDefaultIntakeListId(){ return _prefs?.defaultIntakeListId ?? null }
export function getIntakeStatusId()     { return _prefs?.intakeStatusId      ?? null }
export function getProjectCalendarId()  { return _prefs?.projectCalendarId   ?? null }
export function getVisibilityStart()    { return _prefs?.visibilityStart     ?? null }
export function getVisibilityEnd()      { return _prefs?.visibilityEnd       ?? null }
export function getMaxWindowDays()      { return _prefs?.maxWindowDays       ?? 180 }
export function getRecurringCollapsed() { return _prefs?.recurringCollapsed  ?? false }
export function setRecurringCollapsed(v) { if (_prefs) { _prefs.recurringCollapsed = !!v; _dirty = true; _scheduleSave() } }
export function getDoneCollapsed()      { return _prefs?.doneCollapsed       ?? false }
export function setDoneCollapsed(v) { if (_prefs) { _prefs.doneCollapsed = !!v; _dirty = true; _scheduleSave() } }
export function getListsMigrated()          { return _prefs?.listsMigrated           ?? false }
export function setListsMigrated(v) { if (_prefs) { _prefs.listsMigrated = !!v; _dirty = true; _scheduleSave() } }
export function getLastUsedTaskCalendarId()  { return _prefs?.lastUsedTaskCalendarId  ?? null }
export function getLastUsedEventCalendarId() { return _prefs?.lastUsedEventCalendarId ?? null }

// ── Setters ───────────────────────────────────────────────────────────────────

export function setHiddenCalendars(cals) {
  if (!_prefs) return
  _prefs.hiddenCalendars = [...cals]
  _dirty = true
  _scheduleSave()
}

export function setTaskCalendars(cals) {
  if (!_prefs) return
  _prefs.taskCalendars = [...cals]
  _dirty = true
  _scheduleSave()
}

export function setSweepSources(sources) {
  if (!_prefs) return
  _prefs.sweepSources = [...sources]
  _dirty = true
  _scheduleSave()
}

export function setDefaultIntakeListId(listId) {
  if (!_prefs) return
  _prefs.defaultIntakeListId = listId ?? null
  _dirty = true
  _scheduleSave()
}

export function setIntakeStatusId(statusId) {
  if (!_prefs) return
  _prefs.intakeStatusId = statusId ?? null
  _dirty = true
  _scheduleSave()
}

export function setProjectCalendarId(calendarId) {
  if (!_prefs) return
  _prefs.projectCalendarId = calendarId ?? null
  _dirty = true
  _scheduleSave()
}

// Persist a custom visibility window (both null = revert to the relative default).
export function setVisibilityWindow(startStr, endStr) {
  if (!_prefs) return
  _prefs.visibilityStart = startStr ?? null
  _prefs.visibilityEnd   = endStr   ?? null
  _dirty = true
  _scheduleSave()
}

export function setLastUsedTaskCalendarId(id) {
  if (!_prefs) return
  _prefs.lastUsedTaskCalendarId = id ?? null
  _dirty = true
  _scheduleSave()
}

export function setLastUsedEventCalendarId(id) {
  if (!_prefs) return
  _prefs.lastUsedEventCalendarId = id ?? null
  _dirty = true
  _scheduleSave()
}

export function setTaskColumnSort(calId, mode) {
  if (!_prefs) return
  if (!_prefs.taskColumnSort) _prefs.taskColumnSort = {}
  _prefs.taskColumnSort[calId] = mode
  _dirty = true
  _flushNow()
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _scheduleSave() {
  if (!_saveToken) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(_flush, 1000)
}

function _flushNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null }
  _flush()
}

async function _flush() {
  if (!_dirty || !_prefs || !_saveToken) return
  _dirty     = false
  _saveTimer = null
  try {
    await fsSet(_saveToken, 'prefs/main', _prefs, { keepalive: true })
  } catch (err) {
    console.warn('Firestore prefs save failed:', err.message)
    _dirty = true
  }
}
