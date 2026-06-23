// Per-task metadata store in Google Drive appDataFolder.
// Stores Kairos-owned fields (LOE, comments) and a bounded history of raw
// Google Tasks payloads, keyed by a stable Kairos UUID (kid) embedded in
// the task's notes field.
//
// File shape:
//   {
//     version: 1,
//     tasks: {
//       [kid]: {
//         loe: string | null,
//         comments: [{timestamp, text}],
//         history: [{_syncedAt, ...googleTaskPayload}]   // newest first, max 10
//       }
//     }
//   }

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FILE_NAME   = 'kairos-tasks.json'
const HISTORY_MAX = 10

let _fileId    = null
let _meta      = null   // null = not yet loaded
let _saveToken = null
let _dirty     = false
let _saveTimer = null

export function generateKid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function loadTaskMeta(token) {
  if (_meta) return _meta

  try {
    const searchRes = await fetch(
      `${DRIVE_BASE}/files?spaces=appDataFolder&q=name%3D'${FILE_NAME}'&fields=files(id)`,
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
      _meta = { version: 1, tasks: {}, ...data }
      if (!_meta.tasks) _meta.tasks = {}
    } else {
      _meta = { version: 1, tasks: {} }
    }

    _saveToken = token
  } catch (err) {
    if (err.message !== 'drive_scope_missing') {
      console.warn('Drive task meta unavailable:', err.message)
    }
    _meta = { version: 1, tasks: {} }
  }

  return _meta
}

export function hasTaskRecord(kid) {
  return !!(_meta?.tasks?.[kid])
}

export function getTaskMeta(kid) {
  if (!_meta || !kid) return { loe: null, comments: [] }
  const record = _meta.tasks[kid]
  if (!record) return { loe: null, comments: [] }
  return { loe: record.loe ?? null, comments: record.comments ?? [] }
}

// Push the current Google Tasks payload to history and update loe/comments.
// Only call when kid is known (not null) to avoid orphaned records.
export function syncTaskSnapshot(kid, googlePayload, { loe, comments }) {
  if (!_meta || !kid) return

  const entry = { _syncedAt: new Date().toISOString(), ...googlePayload }
  const existing = _meta.tasks[kid]

  if (existing) {
    existing.loe      = loe
    existing.comments = comments
    existing.history  = [entry, ...(existing.history ?? [])].slice(0, HISTORY_MAX)
  } else {
    _meta.tasks[kid] = { loe, comments, history: [entry] }
  }

  _dirty = true
  _scheduleSave()
}

// Update loe/comments without pushing a new history snapshot — used on explicit save.
export function updateTaskMeta(kid, { loe, comments }) {
  if (!_meta || !kid) return

  const existing = _meta.tasks[kid]
  if (existing) {
    existing.loe      = loe
    existing.comments = comments
  } else {
    _meta.tasks[kid] = { loe, comments, history: [] }
  }

  _dirty = true
  _scheduleSave()
}

// Drop records whose kid is no longer present in the live task set.
export function pruneOrphanedMeta(token, liveKids) {
  if (!_meta) return
  let pruned = false
  for (const kid of Object.keys(_meta.tasks)) {
    if (!liveKids.has(kid)) {
      delete _meta.tasks[kid]
      pruned = true
    }
  }
  if (pruned) {
    if (token) _saveToken = token
    _dirty = true
    _scheduleSave()
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _scheduleSave() {
  if (!_saveToken) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => _flush(), 3000)
}

async function _flush() {
  if (!_dirty || !_meta || !_saveToken) return
  _dirty     = false
  _saveTimer = null
  const body = JSON.stringify(_meta)

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
    console.warn('Drive task meta save failed:', err.message)
    _dirty = true
  }
}
