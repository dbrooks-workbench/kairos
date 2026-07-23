// User preferences stored in Firestore (prefs/main document).
//
// Shape:
//   {
//     version: 1,
//     hiddenCalendars: string[],
//     taskCalendars:   string[],   // ordered project/task calendars
//     taskColumnSort:  { [calId]: 'manual' | 'date' },
//   }

import { fsGet, fsSet } from './firestore.js'

const DEFAULTS = () => ({
  version:           1,
  hiddenCalendars:   [],
  taskCalendars:     [],
  taskColumnSort:    {},
  sweepSources:      [],   // [{ accountId, listId, listName }]
  sweepTargetListId: null, // Kairos list ID where swept tasks land
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
export function getSweepSources()     { return _prefs?.sweepSources      ?? [] }
export function getSweepTargetListId(){ return _prefs?.sweepTargetListId ?? null }

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

export function setSweepTargetListId(listId) {
  if (!_prefs) return
  _prefs.sweepTargetListId = listId ?? null
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
