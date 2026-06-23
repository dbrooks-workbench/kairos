// User preferences stored in Google Drive appDataFolder.
// Replaces localStorage so prefs are device-agnostic and survive browser clears.
//
// Shape:
//   {
//     version: 1,
//     hiddenCalendars: string[],           // calendar IDs hidden from view
//     boardColumnSort: { [listId]: string }, // 'manual' | 'date' per column
//     taskListOrder:   string[],            // ordered list IDs for board columns
//   }

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FILE_NAME   = 'kairos-prefs.json'

let _fileId    = null
let _prefs     = null
let _saveToken = null
let _dirty     = false
let _saveTimer = null

export async function loadPrefs(token) {
  if (_prefs) return _prefs

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
      _prefs = { version: 1, hiddenCalendars: [], boardColumnSort: {}, taskListOrder: [], ...data }
    } else {
      _prefs = { version: 1, hiddenCalendars: [], boardColumnSort: {}, taskListOrder: [] }
    }

    _saveToken = token
  } catch (err) {
    if (err.message !== 'drive_scope_missing') {
      console.warn('Drive prefs unavailable:', err.message)
    }
    _prefs = { version: 1, hiddenCalendars: [], boardColumnSort: {}, taskListOrder: [] }
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

export function getBoardColumnSort() {
  return _prefs?.boardColumnSort ?? {}
}

export function setBoardColumnSort(listId, mode) {
  if (!_prefs) return
  if (!_prefs.boardColumnSort) _prefs.boardColumnSort = {}
  _prefs.boardColumnSort[listId] = mode
  _dirty = true
  _scheduleSave()
}

export function getTaskListOrder() {
  return _prefs?.taskListOrder ?? []
}

export function setTaskListOrder(order) {
  if (!_prefs) return
  _prefs.taskListOrder = [...order]
  _dirty = true
  _scheduleSave()
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _scheduleSave() {
  if (!_saveToken) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => _flush(), 3000)
}

async function _flush() {
  if (!_dirty || !_prefs || !_saveToken) return
  _dirty     = false
  _saveTimer = null
  const body = JSON.stringify(_prefs)

  try {
    if (_fileId) {
      const res = await fetch(
        `${UPLOAD_BASE}/files/${_fileId}?uploadType=media`,
        {
          method:  'PATCH',
          headers: { Authorization: `Bearer ${_saveToken}`, 'Content-Type': 'application/json' },
          body,
        }
      )
      if (!res.ok) throw new Error(`Drive update failed: ${res.status}`)
    } else {
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
    }
  } catch (err) {
    console.warn('Drive prefs save failed:', err.message)
    _dirty = true
  }
}
