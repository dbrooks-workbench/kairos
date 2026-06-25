// Life log — append-only Google Sheet storing every Kairos action as a structured row.
// Sheet is created lazily on first write; ID stored in kairos-prefs.json.
// Writes are fire-and-forget: a failed append never blocks the UI.
//
// Columns: timestamp · source · item_id · item_type · title · verb · action_detail · narrative · context
// verb          — machine token: completed, uncompleted, snoozed, comment, ...
// action_detail — JSON payload with verb + verb-specific fields
// narrative     — always human-readable prose; what a human reader looks at

import { getLifeLogSheetId, setLifeLogSheetId, getLifeLogMigratedHashes, addLifeLogMigratedHashes } from './drivePrefs.js'
import { loadTaskArchive, getAllTaskRecords, getAllArchiveRecords } from './driveTaskMeta.js'
import { getAllEventRecords } from './driveEventTaskMeta.js'

const SHEETS_BASE = 'https://sheets.googleapis.com/v4'
const SHEET_TITLE = 'Kairos Life Log'
const HEADERS     = ['timestamp', 'source', 'item_id', 'item_type', 'title', 'verb', 'action_detail', 'narrative', 'context']

let _creatingPromise = null   // prevents concurrent sheet creation races

// ── Public API ────────────────────────────────────────────────────────────────

// Fire-and-forget. entry: { item_id, item_type, title, verb, action_detail, narrative, context }
export async function appendLogEntry(token, entry) {
  try {
    const sheetId = await _ensureSheet(token)
    if (!sheetId) return
    await _appendRows(token, sheetId, [_buildRow(new Date().toISOString(), entry)])
  } catch (err) {
    console.warn('Life log append failed:', err.message)
  }
}

// Sweep existing Drive task/event comments into the life log.
// Idempotent via content hashes stored in kairos-prefs.json — safe to call on every startup.
// items = state.items (used to resolve titles/context for known items).
export async function migrateExistingComments(token, items = []) {
  // Load archive before reading records — no-op if already loaded by board view.
  // This ensures completed/purged tasks in kairos-tasks-archive.json are included.
  await loadTaskArchive(token)

  // Current records override archive for the same kid (task still alive in Google Tasks).
  const taskRecords  = { ...getAllArchiveRecords(), ...getAllTaskRecords() }
  const eventRecords = getAllEventRecords()

  const hasTasks  = Object.keys(taskRecords).length > 0
  const hasEvents = Object.keys(eventRecords).length > 0
  if (!hasTasks && !hasEvents) return

  const processed = new Set(getLifeLogMigratedHashes())
  const newRows   = []
  const newHashes = []

  // ── Task Drive comments ────────────────────────────────────────────────────
  for (const [kid, record] of Object.entries(taskRecords)) {
    if (!record.comments?.length) continue
    const itemRef = items.find(i => i.metadata?.kid === kid)
    const title   = itemRef?.title ?? record.history?.[0]?.title ?? `[task:${kid.slice(-6)}]`
    const context = itemRef?.metadata?.list_title ?? ''
    const item_id = itemRef?.id ?? `kid:${kid}`

    for (const comment of record.comments) {
      const hash = _hash(comment.timestamp, item_id, comment.text)
      if (processed.has(hash)) continue
      const { verb, action_detail, narrative } = _parseComment(comment.text, title)
      newRows.push(_buildRow(comment.timestamp, { item_id, item_type: 'TASK', title, verb, action_detail, narrative, context }))
      newHashes.push(hash)
      processed.add(hash)
    }
  }

  // ── Event Drive comments ───────────────────────────────────────────────────
  for (const [eventId, record] of Object.entries(eventRecords)) {
    if (!record.comments?.length) continue
    const itemRef = items.find(i => i.source?.external_id === eventId)
    const title   = itemRef?.title ?? `[event:${eventId.slice(-8)}]`
    const context = itemRef?.metadata?.calendar_name ?? ''
    const item_id = itemRef?.id ?? `gcal:${eventId}`

    for (const comment of record.comments) {
      const hash = _hash(comment.timestamp, item_id, comment.text)
      if (processed.has(hash)) continue
      const { verb, action_detail, narrative } = _parseComment(comment.text, title)
      newRows.push(_buildRow(comment.timestamp, { item_id, item_type: 'EVENT', title, verb, action_detail, narrative, context }))
      newHashes.push(hash)
      processed.add(hash)
    }
  }

  if (!newRows.length) return

  try {
    const sheetId = await _ensureSheet(token)
    if (!sheetId) return
    // Sort rows chronologically before writing
    newRows.sort((a, b) => a[0].localeCompare(b[0]))
    await _appendRows(token, sheetId, newRows)
    addLifeLogMigratedHashes(newHashes)
  } catch (err) {
    console.warn('Life log migration failed:', err.message)
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _buildRow(timestamp, { item_id, item_type, title, verb, action_detail, narrative, context }) {
  return [
    timestamp,
    'kairos',
    item_id    ?? '',
    item_type  ?? '',
    title      ?? '',
    verb,
    JSON.stringify(action_detail),
    narrative  ?? '',
    context    ?? '',
  ]
}

async function _appendRows(token, sheetId, rows) {
  const res = await fetch(
    `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(sheetId)}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: rows }),
    }
  )
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status}`)
}

async function _ensureSheet(token) {
  const existing = getLifeLogSheetId()
  if (existing) return existing
  if (_creatingPromise) return _creatingPromise
  _creatingPromise = _createSheet(token).finally(() => { _creatingPromise = null })
  return _creatingPromise
}

async function _createSheet(token) {
  const createRes = await fetch(`${SHEETS_BASE}/spreadsheets`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ properties: { title: SHEET_TITLE } }),
  })
  if (!createRes.ok) throw new Error(`Sheet create failed: ${createRes.status}`)
  const created   = await createRes.json()
  const sheetId   = created.spreadsheetId
  const sheetName = created.sheets?.[0]?.properties?.title ?? 'Sheet1'

  await _appendRows(token, sheetId, [HEADERS])
  // Freeze the header row so it stays visible when scrolling
  await fetch(`${SHEETS_BASE}/spreadsheets/${encodeURIComponent(sheetId)}:batchUpdate`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      requests: [{
        updateSheetProperties: {
          properties: { sheetId: created.sheets[0].properties.sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      }],
    }),
  })

  setLifeLogSheetId(sheetId)
  return sheetId
}

// Parse a Drive comment text string into { verb, action_detail, narrative }.
// Handles both current !verb format and legacy prose formats.
function _parseComment(text, title) {
  const t = (text ?? '').trim()
  const q = `"${title}"`

  if (t === '!completed')
    return { verb: 'completed',   action_detail: { verb: 'completed' },   narrative: `Completed ${q}` }

  if (t === '!uncompleted')
    return { verb: 'uncompleted', action_detail: { verb: 'uncompleted' }, narrative: `Marked ${q} incomplete` }

  const snoozeM = t.match(/^!snoozed to (\d{4}-\d{2}-\d{2})$/)
  if (snoozeM) {
    const to  = snoozeM[1]
    const d   = new Date(to + 'T00:00:00')
    const ds  = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    return { verb: 'snoozed', action_detail: { verb: 'snoozed', to }, narrative: `Snoozed ${q} to ${ds}` }
  }

  // Legacy task snooze prose (pre-v0.16.1): "Snoozed — follow up on Jun 25, 2026"
  const legacySnoozeM = t.match(/^Snoozed — follow up on (.+)$/)
  if (legacySnoozeM)
    return { verb: 'snoozed', action_detail: { verb: 'snoozed' }, narrative: `Snoozed ${q}: follow up on ${legacySnoozeM[1]}` }

  // Legacy event description log entries (pre-v0.16.1 @timestamp format already stripped by caller)
  return { verb: 'comment', action_detail: { verb: 'comment', text: t }, narrative: t }
}

// FNV-1a 32-bit hash → base-36 string. Deterministic, compact, sufficient for dedup.
function _hash(timestamp, itemId, text) {
  const s = `${timestamp}|${itemId}|${(text ?? '').slice(0, 40)}`
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}
