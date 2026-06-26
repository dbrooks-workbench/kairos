// Life log — append-only activity store in Firestore (activity/{autoId}).
//
// Each document:
//   { timestamp, source, item_id, item_type, title, verb, action_detail, narrative, context }
//
// verb          — machine token: completed, uncompleted, snoozed, comment, ...
// action_detail — object with verb-specific fields
// narrative     — human-readable prose
//
// On first load, if the activity collection is empty and a legacy Google Sheets
// life log exists (lifeLogSheetId in prefs), rows are migrated to Firestore.

import { fsList, fsAdd, fsDelete } from './firestore.js'
import { getLifeLogSheetId, getActivityMigratedAt, markActivityMigrated } from './drivePrefs.js'

const SHEETS_BASE  = 'https://sheets.googleapis.com/v4'
const COLLECTION   = 'activity'

// { [item_id]: [{ _id, timestamp, verb, action_detail, narrative }] }
// null until loadLifeLog has run
let _logByItemId = null

// ── Public API ────────────────────────────────────────────────────────────────

// Load all activity into memory. No-op if already loaded.
// Must be awaited at startup before getItemLog is meaningful.
export async function loadLifeLog(token) {
  if (_logByItemId !== null) return
  try {
    const docs = await fsList(token, COLLECTION)
    _logByItemId = {}
    for (const { _id, ...entry } of docs) {
      const { item_id } = entry
      if (!item_id) continue
      if (!_logByItemId[item_id]) _logByItemId[item_id] = []
      _logByItemId[item_id].push({ _id, ...entry })
    }

    // Migrate from Google Sheets on first run (one-time, idempotent flag in prefs)
    if (docs.length === 0 && !getActivityMigratedAt()) {
      await _migrateFromSheet(token)
    }
  } catch (err) {
    console.warn('Life log load failed:', err.message)
    _logByItemId = {}
  }
}

// Returns log entries for one item, sorted chronologically.
export function getItemLog(itemId) {
  if (!itemId || !_logByItemId) return []
  return (_logByItemId[itemId] ?? []).slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

// Append an activity entry. Fire-and-forget — a failed write never blocks the UI.
// entry: { item_id, item_type, title, verb, action_detail, narrative, context }
export async function appendLogEntry(token, entry) {
  const timestamp = new Date().toISOString()
  const doc = {
    timestamp,
    source:   'kairos',
    item_id:  entry.item_id  ?? '',
    item_type:entry.item_type ?? '',
    title:    entry.title    ?? '',
    verb:     entry.verb,
    action_detail: entry.action_detail ?? {},
    narrative:entry.narrative ?? '',
    context:  entry.context  ?? '',
  }

  // Update in-memory cache immediately (with _id = null; backfilled after write)
  if (_logByItemId !== null && entry.item_id) {
    if (!_logByItemId[entry.item_id]) _logByItemId[entry.item_id] = []
    _logByItemId[entry.item_id].push({ _id: null, ...doc })
  }

  try {
    const written = await fsAdd(token, COLLECTION, doc)
    // Backfill _id on the cache entry we just pushed
    if (_logByItemId && entry.item_id) {
      const arr  = _logByItemId[entry.item_id]
      const last = arr?.[arr.length - 1]
      if (last && last._id === null && last.timestamp === timestamp) last._id = written._id
    }
  } catch (err) {
    console.warn('Life log append failed:', err.message)
  }
}

// Delete a single activity entry from Firestore and the in-memory cache.
export async function deleteLogEntry(token, itemId, entryId) {
  if (!entryId) return
  // Remove from cache immediately so the UI reflects the change
  if (_logByItemId && itemId) {
    _logByItemId[itemId] = (_logByItemId[itemId] ?? []).filter(e => e._id !== entryId)
  }
  try {
    await fsDelete(token, `${COLLECTION}/${entryId}`)
  } catch (err) {
    console.warn('Life log delete failed:', err.message)
  }
}

// ── Sheets migration ──────────────────────────────────────────────────────────

async function _migrateFromSheet(token) {
  const sheetId = getLifeLogSheetId()
  if (!sheetId) {
    markActivityMigrated()   // no sheet to migrate; mark done so we don't check again
    return
  }

  try {
    console.log('[migration] Migrating Google Sheets life log → Firestore activity')
    const res = await fetch(
      `${SHEETS_BASE}/spreadsheets/${encodeURIComponent(sheetId)}/values/A:I`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) throw new Error(`Sheet read failed: ${res.status}`)
    const { values = [] } = await res.json()
    const rows = values.slice(1)   // skip header row

    console.log(`[migration] Migrating ${rows.length} activity rows`)

    // Write in parallel batches of 20
    const BATCH = 20
    for (let i = 0; i < rows.length; i += BATCH) {
      await Promise.all(
        rows.slice(i, i + BATCH).map(row => {
          const [timestamp, source, item_id, item_type, title, verb, action_detail_str, narrative, context] = row
          if (!item_id && !verb) return Promise.resolve()
          let action_detail = {}
          try { action_detail = JSON.parse(action_detail_str) } catch { /* ignore */ }
          const doc = { timestamp, source: source || 'kairos', item_id, item_type, title, verb, action_detail, narrative, context }
          return fsAdd(token, COLLECTION, doc).then(written => {
            // Populate cache with migrated entries
            if (_logByItemId && item_id) {
              if (!_logByItemId[item_id]) _logByItemId[item_id] = []
              _logByItemId[item_id].push({ _id: written._id, ...doc })
            }
          }).catch(err => console.warn('Migration row failed:', err.message))
        })
      )
    }

    console.log('[migration] Sheets → Firestore activity migration complete')
  } catch (err) {
    console.warn('[migration] Sheets migration failed:', err.message)
  }

  markActivityMigrated()   // mark done even on partial failure (idempotent re-run is safe)
}
