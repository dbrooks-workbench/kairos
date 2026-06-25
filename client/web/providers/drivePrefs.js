// User preferences stored in Google Drive appDataFolder.
// Drive is the single source of truth — no localStorage fallback.
// The UI stays in a loading state until loadPrefs resolves.
//
// Write strategy:
//   setBoardColumnSort / setTaskListOrder — flush immediately (explicit user action)
//   setHiddenCalendars                   — debounced 1s (may toggle several in a row)
//
// keepalive: true on all PATCH writes so they survive a hard refresh / page unload.
// The prefs file is created eagerly in loadPrefs so _fileId is always set before
// any user interaction, guaranteeing all writes use PATCH rather than the multipart
// POST that doesn't support keepalive.
//
// Shape:
//   {
//     version: 1,
//     hiddenCalendars: string[],
//     boardColumnSort: { [listId]: string },  // 'manual' | 'date'
//     taskListOrder:   string[],
//   }

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FILE_NAME   = 'kairos-prefs.json'
const DEFAULTS    = () => ({ version: 1, hiddenCalendars: [], commitmentCalendars: [], boardColumnSort: {}, taskListOrder: [], lifeLogSheetId: null })

let _fileId      = null
let _prefs       = null
let _saveToken   = null
let _dirty       = false
let _saveTimer   = null
let _loadPromise = null   // prevents concurrent loads from racing

export async function loadPrefs(token) {
  if (_prefs) return _prefs
  if (_loadPromise) return _loadPromise
  _loadPromise = _doLoad(token).finally(() => { _loadPromise = null })
  return _loadPromise
}

async function _doLoad(token) {
  try {
    const q         = encodeURIComponent(`name='${FILE_NAME}'`)
    const searchRes = await fetch(
      `${DRIVE_BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!searchRes.ok) {
      if (searchRes.status === 403) throw new Error('drive_scope_missing')
      throw new Error(`Drive search failed: ${searchRes.status}`)
    }

    const { files } = await searchRes.json()

    if (files?.length > 0) {
      _fileId = files[0].id
      const dataRes = await fetch(
        `${DRIVE_BASE}/files/${_fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!dataRes.ok) throw new Error(`Drive read failed: ${dataRes.status}`)
      const data = await dataRes.json()
      _prefs = { ...DEFAULTS(), ...data }
    } else {
      // No file yet — create it immediately so all future writes use PATCH,
      // which supports keepalive: true and survives hard refresh / page unload.
      _prefs = DEFAULTS()
      const createRes = await fetch(`${DRIVE_BASE}/files`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' }),
      })
      if (createRes.ok) {
        _fileId = (await createRes.json()).id
        // Upload initial content
        await fetch(`${UPLOAD_BASE}/files/${_fileId}?uploadType=media`, {
          method:  'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(_prefs),
        })
      }
    }

    _saveToken = token
  } catch (err) {
    if (err.message !== 'drive_scope_missing') {
      console.warn('Drive prefs unavailable:', err.message)
    }
    _prefs = DEFAULTS()
  }

  return _prefs
}

export function getHiddenCalendars() {
  return _prefs?.hiddenCalendars ?? []
}

export function setHiddenCalendars(cals) {
  if (!_prefs) return
  _prefs.hiddenCalendars = [...cals]
  _dirty = true
  _scheduleSave()
}

export function getLifeLogSheetId() {
  return _prefs?.lifeLogSheetId ?? null
}

export function setLifeLogSheetId(id) {
  if (!_prefs) return
  _prefs.lifeLogSheetId = id
  _dirty = true
  _flushNow()
}

export function getCommitmentCalendars() {
  return _prefs?.commitmentCalendars ?? []
}

export function setCommitmentCalendars(cals) {
  if (!_prefs) return
  _prefs.commitmentCalendars = [...cals]
  _dirty = true
  _scheduleSave()
}

export function getBoardColumnSort() {
  return _prefs?.boardColumnSort ?? {}
}

export function setBoardColumnSort(listId, mode) {
  if (!_prefs) return
  if (!_prefs.boardColumnSort) _prefs.boardColumnSort = {}
  _prefs.boardColumnSort[listId] = mode
  _dirty = true
  _flushNow()
}

export function getTaskListOrder() {
  return _prefs?.taskListOrder ?? []
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
  _saveTimer = setTimeout(() => _flush(), 1000)
}

function _flushNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null }
  _flush()
}

async function _flush() {
  console.log('[prefs] _flush | dirty:', _dirty, '| _prefs:', !!_prefs, '| _saveToken:', !!_saveToken, '| _fileId:', _fileId)
  if (!_dirty || !_prefs || !_saveToken) return
  _dirty     = false
  _saveTimer = null
  const body = JSON.stringify(_prefs)

  try {
    if (_fileId) {
      // keepalive: true — request completes even if the page is hard-refreshed
      const res = await fetch(
        `${UPLOAD_BASE}/files/${_fileId}?uploadType=media`,
        {
          method:    'PATCH',
          headers:   { Authorization: `Bearer ${_saveToken}`, 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }
      )
      if (res.ok) return
      // 404 = file deleted on Drive — fall through and recreate it
      if (res.status !== 404) throw new Error(`Drive update failed: ${res.status}`)
      _fileId = null
    }
    // _fileId null: either file creation failed in loadPrefs, or stale ID returned 404
    const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })
    const form = new FormData()
    form.append('metadata', new Blob([meta], { type: 'application/json' }))
    form.append('media',    new Blob([body], { type: 'application/json' }))
    const res = await fetch(
      `${UPLOAD_BASE}/files?uploadType=multipart&fields=id`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${_saveToken}` },
        body:    form,
      }
    )
    if (!res.ok) throw new Error(`Drive create failed: ${res.status}`)
    _fileId = (await res.json()).id
  } catch (err) {
    console.warn('Drive prefs save failed:', err.message)
    _dirty = true
  }
}
