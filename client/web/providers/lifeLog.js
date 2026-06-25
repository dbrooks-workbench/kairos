// Life log — append-only Google Sheet storing every Kairos action as a structured row.
// Sheet is created lazily on first write; ID stored in kairos-prefs.json.
// Writes are fire-and-forget: a failed append never blocks the UI.
//
// Columns: timestamp · source · item_id · item_type · title · verb · action_detail · narrative · context
// verb          — machine token: completed, uncompleted, snoozed, comment, ...
// action_detail — JSON payload with verb + verb-specific fields
// narrative     — always human-readable prose; what a human reader looks at

import { getLifeLogSheetId, setLifeLogSheetId } from './drivePrefs.js'

const SHEETS_BASE = 'https://sheets.googleapis.com/v4'
const SHEET_TITLE = 'Kairos Life Log'
const HEADERS     = ['timestamp', 'source', 'item_id', 'item_type', 'title', 'verb', 'action_detail', 'narrative', 'context']

let _creatingPromise = null   // prevents concurrent sheet creation races
let _logByItemId     = null   // { [item_id]: [{timestamp,verb,action_detail,narrative}] }; null until loaded

// ── Public API ────────────────────────────────────────────────────────────────

// Load all Sheet rows into memory keyed by item_id. No-op if already loaded.
// Must be awaited at startup before getItemLog is meaningful.
export async function loadLifeLog(token) {
  if (_logByItemId !== null) return
  const sheetId = getLifeLogSheetId()
  if (!sheetId) { _logByItemId = {}; return }
  try {
    const res = await fetch(
      `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(sheetId)}/values/A:I`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) throw new Error(`Sheet read failed: ${res.status}`)
    const { values = [] } = await res.json()
    _logByItemId = {}
    for (const row of values.slice(1)) {   // skip header row
      const [timestamp, , item_id, , , verb, action_detail_str, narrative] = row
      if (!item_id) continue
      let action_detail
      try { action_detail = JSON.parse(action_detail_str) } catch { action_detail = {} }
      if (!_logByItemId[item_id]) _logByItemId[item_id] = []
      _logByItemId[item_id].push({ timestamp, verb, action_detail, narrative })
    }
  } catch (err) {
    console.warn('Life log load failed:', err.message)
    _logByItemId = {}
  }
}

// Returns log entries for one item, sorted chronologically.
// Shape: { timestamp, verb, action_detail, narrative }
export function getItemLog(itemId) {
  if (!itemId || !_logByItemId) return []
  return (_logByItemId[itemId] ?? []).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

// Fire-and-forget. entry: { item_id, item_type, title, verb, action_detail, narrative, context }
export async function appendLogEntry(token, entry) {
  const timestamp = new Date().toISOString()
  // Update in-memory cache immediately so modal re-opens reflect the entry without reload
  if (_logByItemId !== null && entry.item_id) {
    if (!_logByItemId[entry.item_id]) _logByItemId[entry.item_id] = []
    _logByItemId[entry.item_id].push({
      timestamp,
      verb:          entry.verb,
      action_detail: entry.action_detail,
      narrative:     entry.narrative,
    })
  }
  try {
    const sheetId = await _ensureSheet(token)
    if (!sheetId) return
    await _appendRows(token, sheetId, [_buildRow(timestamp, entry)])
  } catch (err) {
    console.warn('Life log append failed:', err.message)
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

