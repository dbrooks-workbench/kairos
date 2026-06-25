// Life log — append-only Google Sheet storing every Kairos action as a structured row.
// Sheet is created lazily on first write; ID stored in kairos-prefs.json.
// Writes are fire-and-forget: a failed append never blocks the UI.
//
// Columns: timestamp · source · item_id · item_type · title · verb · action_detail · narrative · context
// verb      — machine token: completed, uncompleted, snoozed, comment, ...
// action_detail — JSON payload with verb + verb-specific fields
// narrative — always human-readable prose; what a human reader looks at

import { getLifeLogSheetId, setLifeLogSheetId } from './drivePrefs.js'

const SHEETS_BASE  = 'https://sheets.googleapis.com/v4'
const SHEET_TITLE  = 'Kairos Life Log'
const HEADERS      = ['timestamp', 'source', 'item_id', 'item_type', 'title', 'verb', 'action_detail', 'narrative', 'context']

let _creatingPromise = null   // prevents concurrent sheet creation races

// ── Public API ────────────────────────────────────────────────────────────────

// Fire-and-forget: caller does not need to await this.
// entry: { item_id, item_type, title, verb, action_detail (object), narrative, context }
export async function appendLogEntry(token, entry) {
  try {
    const sheetId = await _ensureSheet(token)
    if (!sheetId) return

    const row = [
      new Date().toISOString(),
      'kairos',
      entry.item_id    ?? '',
      entry.item_type  ?? '',
      entry.title      ?? '',
      entry.verb,
      JSON.stringify(entry.action_detail),
      entry.narrative  ?? '',
      entry.context    ?? '',
    ]

    const res = await fetch(
      `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(sheetId)}/values/A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ values: [row] }),
      }
    )
    if (!res.ok) throw new Error(`Sheets append failed: ${res.status}`)
  } catch (err) {
    console.warn('Life log append failed:', err.message)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _ensureSheet(token) {
  const existing = getLifeLogSheetId()
  if (existing) return existing
  if (_creatingPromise) return _creatingPromise
  _creatingPromise = _createSheet(token).finally(() => { _creatingPromise = null })
  return _creatingPromise
}

async function _createSheet(token) {
  // 1. Create the spreadsheet
  const createRes = await fetch(`${SHEETS_BASE}/spreadsheets`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ properties: { title: SHEET_TITLE } }),
  })
  if (!createRes.ok) throw new Error(`Sheet create failed: ${createRes.status}`)
  const created = await createRes.json()
  const sheetId   = created.spreadsheetId
  const sheetName = created.sheets?.[0]?.properties?.title ?? 'Sheet1'

  // 2. Write header row
  await fetch(
    `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values: [HEADERS] }),
    }
  )

  // 3. Persist the ID so future calls skip creation
  setLifeLogSheetId(sheetId)
  return sheetId
}
