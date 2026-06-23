// Per-task metadata store in Google Drive appDataFolder — two files:
//
//   kairos-tasks.json         active/current records; loaded on every page load;
//                             stays bounded to roughly what's alive in Google Tasks
//
//   kairos-tasks-archive.json historical records; grows indefinitely; loaded only
//                             on demand (history view, Life History export, etc.)
//
// When a kid disappears from the live Google Tasks set (detected during board-view
// load via getAllTasks), its record is moved from current → archive rather than
// deleted. This preserves the full task history even after Google's purge window.
//
// Record shape (same in both files):
//   {
//     version: 1,
//     tasks: {
//       [kid]: {
//         loe: string | null,
//         comments: [{timestamp, text}],
//         history: [{_syncedAt, ...googleTaskPayload}],   // newest first, max 10
//         archivedAt?: string    // ISO timestamp, present only in archive file
//       }
//     }
//   }

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FILE_CURRENT = 'kairos-tasks.json'
const FILE_ARCHIVE = 'kairos-tasks-archive.json'
const HISTORY_MAX  = 10

// ── Current file state ────────────────────────────────────────────────────────
let _fileId    = null
let _meta      = null
let _dirty     = false
let _saveTimer = null

// ── Archive file state ────────────────────────────────────────────────────────
let _archiveFileId    = null
let _archive          = null   // null = not yet loaded
let _archiveDirty     = false
let _archiveSaveTimer = null

// Shared token — set on first successful load of either file
let _saveToken = null

// ── Utilities ─────────────────────────────────────────────────────────────────

export function generateKid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Current file ──────────────────────────────────────────────────────────────

export async function loadTaskMeta(token) {
  if (_meta) return _meta
  _meta = await _loadFile(token, FILE_CURRENT, id => { _fileId = id })
  _saveToken = token
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
// Only call when kid is known (not null).
export function syncTaskSnapshot(kid, googlePayload, { loe, comments }) {
  if (!_meta || !kid) return

  const entry    = { _syncedAt: new Date().toISOString(), ...googlePayload }
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

// Update loe/comments without pushing a history snapshot — used on explicit save.
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

// ── Archive file ──────────────────────────────────────────────────────────────

// Load the archive lazily — only called from getAllTasks (board view) and
// explicit history/export consumers. Not loaded on normal calendar page load.
export async function loadTaskArchive(token) {
  if (_archive) return _archive
  _archive   = await _loadFile(token, FILE_ARCHIVE, id => { _archiveFileId = id })
  _saveToken = token
  return _archive
}

// Move records for kids no longer present in the live Google Tasks set from
// current → archive. Call only from getAllTasks, which has a complete picture
// of what's alive. Never deletes from archive.
export function archiveOrphanedMeta(liveKids) {
  if (!_meta || !_archive) return

  let moved = false
  for (const [kid, record] of Object.entries(_meta.tasks)) {
    if (!liveKids.has(kid)) {
      _archive.tasks[kid] = { ...record, archivedAt: new Date().toISOString() }
      delete _meta.tasks[kid]
      moved = true
    }
  }

  if (moved) {
    _dirty        = true
    _archiveDirty = true
    _scheduleSave()
    _scheduleArchiveSave()
  }
}

// ── Internal: shared file helpers ─────────────────────────────────────────────

async function _loadFile(token, fileName, onFileId) {
  try {
    const q         = encodeURIComponent(`name='${fileName}'`)
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
      onFileId(files[0].id)
      const dataRes = await fetch(
        `${DRIVE_BASE}/files/${files[0].id}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!dataRes.ok) throw new Error(`Drive read failed: ${dataRes.status}`)
      const data = await dataRes.json()
      if (!data.tasks) data.tasks = {}
      return { version: 1, tasks: {}, ...data }
    }

    return { version: 1, tasks: {} }
  } catch (err) {
    if (err.message !== 'drive_scope_missing') {
      console.warn(`Drive load failed (${fileName}):`, err.message)
    }
    return { version: 1, tasks: {} }
  }
}

async function _writeFile(fileId, fileName, data) {
  const body = JSON.stringify(data)
  if (fileId) {
    const res = await fetch(
      `${UPLOAD_BASE}/files/${fileId}?uploadType=media`,
      {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${_saveToken}`, 'Content-Type': 'application/json' },
        body,
      }
    )
    if (!res.ok) throw new Error(`Drive update failed: ${res.status}`)
    return fileId
  } else {
    const meta = JSON.stringify({ name: fileName, parents: ['appDataFolder'] })
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
    return (await res.json()).id
  }
}

function _scheduleSave() {
  if (!_saveToken) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => _flush(), 3000)
}

function _scheduleArchiveSave() {
  if (!_saveToken) return
  if (_archiveSaveTimer) clearTimeout(_archiveSaveTimer)
  _archiveSaveTimer = setTimeout(() => _flushArchive(), 3000)
}

async function _flush() {
  if (!_dirty || !_meta || !_saveToken) return
  _dirty     = false
  _saveTimer = null
  try {
    _fileId = await _writeFile(_fileId, FILE_CURRENT, _meta)
  } catch (err) {
    console.warn('Drive task meta save failed:', err.message)
    _dirty = true
  }
}

async function _flushArchive() {
  if (!_archiveDirty || !_archive || !_saveToken) return
  _archiveDirty     = false
  _archiveSaveTimer = null
  try {
    _archiveFileId = await _writeFile(_archiveFileId, FILE_ARCHIVE, _archive)
  } catch (err) {
    console.warn('Drive task archive save failed:', err.message)
    _archiveDirty = true
  }
}
