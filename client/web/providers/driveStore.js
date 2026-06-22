// Persistent registry of recurring task series, stored as a single JSON file
// in the user's Google Drive appDataFolder. The file is invisible to the user
// in the Drive UI. This survives Google Tasks GC of completed tasks and works
// across devices and browsers using the same Google account.
//
// Registry shape:
//   { version: 1, series: { [title::rrule]: { title, rrule, listId, lastDue, updatedAt } } }

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FILE_NAME   = 'kairos-registry.json'
const STALE_MS    = 2 * 365 * 24 * 60 * 60 * 1000  // 2 years

let _fileId    = null   // cached Drive file ID
let _registry  = null   // in-memory registry; null = not yet loaded
let _saveToken = null   // token used for saves (set on first successful load)
let _dirty     = false
let _saveTimer = null

// Load the registry from Drive (or create an empty one if it doesn't exist yet).
// Returns the registry object. Gracefully returns an empty registry on any error
// (including 403 when the drive.appdata scope hasn't been granted yet).
export async function loadRegistry(token) {
  if (_registry) return _registry

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
      _registry = { version: 1, series: {}, ...data }
      if (!_registry.series) _registry.series = {}
      _pruneStale()
    } else {
      _registry = { version: 1, series: {} }
    }

    _saveToken = token
  } catch (err) {
    if (err.message !== 'drive_scope_missing') {
      console.warn('Drive registry unavailable:', err.message)
    }
    _registry = { version: 1, series: {} }
  }

  return _registry
}

// Upsert a recurring task series into the registry. Only writes if the new
// lastDue is later than the stored one (so we always keep the freshest anchor).
export function upsertSeries(token, title, rrule, listId, dueDate) {
  if (!_registry || !dueDate) return

  const key     = `${title}::${rrule}`
  const lastDue = dueDate instanceof Date
    ? dueDate.toLocaleDateString('en-CA')
    : String(dueDate)

  const existing = _registry.series[key]
  if (existing && existing.lastDue >= lastDue && existing.listId === listId) return

  _registry.series[key] = {
    title,
    rrule,
    listId,
    lastDue,
    updatedAt: new Date().toISOString(),
  }
  _dirty = true
  _scheduleSave(token ?? _saveToken)
}

// Return registry entries for series that have no live task driver in the
// provided set. Only returns entries matching the given listId.
export function orphanedDrivers(liveSeriesKeys, listId) {
  if (!_registry) return []
  return Object.values(_registry.series).filter(
    s => s.listId === listId && !liveSeriesKeys.has(`${s.title}::${s.rrule}`)
  )
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _pruneStale() {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString()
  for (const [key, entry] of Object.entries(_registry.series)) {
    if (entry.updatedAt < cutoff) {
      delete _registry.series[key]
      _dirty = true
    }
  }
}

function _scheduleSave(token) {
  if (!token) return
  _saveToken = token
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => _flush(), 3000)
}

async function _flush() {
  if (!_dirty || !_registry || !_saveToken) return
  _dirty     = false
  _saveTimer = null
  const body = JSON.stringify(_registry)

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
    console.warn('Drive registry save failed:', err.message)
    _dirty = true  // will retry on next upsert
  }
}
