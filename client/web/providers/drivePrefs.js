// User preferences stored in Firestore (prefs/main document).
//
// On first load, if prefs/main doesn't exist, runs a one-time migration
// from Google Drive appDataFolder (kairos-prefs.json) and writes migratedAt.
//
// Shape:
//   {
//     version: 1,
//     hiddenCalendars:   string[],
//     commitmentCalendars: string[],
//     boardColumnSort:   { [listId]: 'manual' | 'date' },
//     taskListOrder:     string[],
//     lifeLogSheetId:    string | null,
//     migratedAt?:       string   // ISO; set on first Firestore write
//   }

import { fsGet, fsSet } from './firestore.js'

const DEFAULTS = () => ({
  version: 1,
  hiddenCalendars:     [],
  commitmentCalendars: [],
  boardColumnSort:     {},
  taskListOrder:       [],
  lifeLogSheetId:      null,
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
      // First run with Firestore — migrate from Drive then write prefs/main
      const { runMigration } = await import('./migration.js')
      const drivePrefs = await runMigration(token)
      const { version: _v, ...rest } = drivePrefs ?? {}
      _prefs = { ...DEFAULTS(), ...rest, migratedAt: new Date().toISOString() }
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

export function getHiddenCalendars()    { return _prefs?.hiddenCalendars    ?? [] }
export function getCommitmentCalendars(){ return _prefs?.commitmentCalendars ?? [] }
export function getBoardColumnSort()    { return _prefs?.boardColumnSort     ?? {} }
export function getTaskListOrder()      { return _prefs?.taskListOrder       ?? [] }
export function getLifeLogSheetId()     { return _prefs?.lifeLogSheetId      ?? null }

// ── Setters ───────────────────────────────────────────────────────────────────

export function setHiddenCalendars(cals) {
  if (!_prefs) return
  _prefs.hiddenCalendars = [...cals]
  _dirty = true
  _scheduleSave()
}

export function setCommitmentCalendars(cals) {
  if (!_prefs) return
  _prefs.commitmentCalendars = [...cals]
  _dirty = true
  _scheduleSave()
}

export function setLifeLogSheetId(id) {
  if (!_prefs) return
  _prefs.lifeLogSheetId = id
  _dirty = true
  _flushNow()
}

export function setBoardColumnSort(listId, mode) {
  if (!_prefs) return
  if (!_prefs.boardColumnSort) _prefs.boardColumnSort = {}
  _prefs.boardColumnSort[listId] = mode
  _dirty = true
  _flushNow()
}

export function setTaskListOrder(order) {
  if (!_prefs) return
  _prefs.taskListOrder = [...order]
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
