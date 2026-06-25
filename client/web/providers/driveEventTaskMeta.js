// Commitment completion state and log/comments stored in Google Drive appDataFolder.
// Shape: {
//   version: 1,
//   events: {
//     "[eventId]": { completedAt: "ISO | null", comments: [{timestamp, text}] }
//   }
// }
// completedAt non-null = completed. Action entries use !verb text convention.
// Same {timestamp, text} schema as task comments in kairos-tasks.json.

const DRIVE_BASE  = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FILE_NAME   = 'kairos-event-tasks.json'
const DEFAULTS    = () => ({ version: 1, events: {} })

let _fileId      = null
let _meta        = null
let _saveToken   = null
let _loadPromise = null

export async function loadEventTaskMeta(token) {
  if (_meta) return _meta
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
    if (!searchRes.ok) throw new Error(`Drive search failed: ${searchRes.status}`)
    const { files } = await searchRes.json()

    if (files?.length > 0) {
      _fileId = files[0].id
      const dataRes = await fetch(
        `${DRIVE_BASE}/files/${_fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!dataRes.ok) throw new Error(`Drive read failed: ${dataRes.status}`)
      const data = await dataRes.json()
      _meta = { ...DEFAULTS(), ...data }
    } else {
      _meta = DEFAULTS()
      const createRes = await fetch(`${DRIVE_BASE}/files`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' }),
      })
      if (createRes.ok) {
        _fileId = (await createRes.json()).id
        await fetch(`${UPLOAD_BASE}/files/${_fileId}?uploadType=media`, {
          method:  'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(_meta),
        })
      }
    }
    _saveToken = token
  } catch (err) {
    console.warn('Drive event-task meta unavailable:', err.message)
    _meta = DEFAULTS()
  }
  return _meta
}

function _ensureRecord(eventId) {
  if (!_meta.events) _meta.events = {}
  if (!_meta.events[eventId]) _meta.events[eventId] = { completedAt: null, comments: [] }
  if (!_meta.events[eventId].comments) _meta.events[eventId].comments = []
  return _meta.events[eventId]
}

export function getEventCompletedAt(eventId) {
  return _meta?.events?.[eventId]?.completedAt ?? null
}

export function getEventComments(eventId) {
  return _meta?.events?.[eventId]?.comments ?? []
}

export async function setEventCompleted(token, eventId) {
  if (!_meta) return null
  const ts  = new Date().toISOString()
  const rec = _ensureRecord(eventId)
  rec.completedAt = ts
  rec.comments.push({ timestamp: ts, text: '!completed' })
  await _flush(token ?? _saveToken)
  return ts
}

export async function setEventUncompleted(token, eventId) {
  if (!_meta) return
  const ts  = new Date().toISOString()
  const rec = _ensureRecord(eventId)
  rec.completedAt = null
  rec.comments.push({ timestamp: ts, text: '!uncompleted' })
  await _flush(token ?? _saveToken)
}

export async function addEventSnooze(token, eventId, newDateStr) {
  if (!_meta) return
  const ts  = new Date().toISOString()
  const rec = _ensureRecord(eventId)
  rec.comments.push({ timestamp: ts, text: `!snoozed to ${newDateStr}` })
  await _flush(token ?? _saveToken)
}

async function _flush(token) {
  if (!token || !_meta) return
  const body = JSON.stringify(_meta)
  try {
    if (_fileId) {
      const res = await fetch(
        `${UPLOAD_BASE}/files/${_fileId}?uploadType=media`,
        {
          method:    'PATCH',
          headers:   { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body,
          keepalive: true,
        }
      )
      if (!res.ok) throw new Error(`Drive update failed: ${res.status}`)
    }
  } catch (err) {
    console.warn('Drive event-task meta save failed:', err.message)
  }
}
