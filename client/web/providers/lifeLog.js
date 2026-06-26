// Life log — append-only activity store in Firestore (activity/{autoId}).
//
// Each document:
//   { timestamp, source, item_id, item_type, title, verb, action_detail, narrative, context }
//
// verb          — machine token: completed, uncompleted, snoozed, comment, ...
// action_detail — object with verb-specific fields
// narrative     — human-readable prose

import { fsList, fsAdd, fsDelete } from './firestore.js'

const COLLECTION = 'activity'

// { [item_id]: [{ _id, timestamp, verb, action_detail, narrative }] }
// null until loadLifeLog has run
let _logByItemId = null
let _loadPromise = null   // deduplicates concurrent calls (e.g. from parallel getEvents+getTasks)

// ── Public API ────────────────────────────────────────────────────────────────

// Load all activity into memory. No-op if already loaded.
// Must be awaited at startup before getItemLog is meaningful.
export async function loadLifeLog(token) {
  if (_logByItemId !== null) return
  if (_loadPromise) return _loadPromise
  _loadPromise = _doLoad(token).finally(() => { _loadPromise = null })
  return _loadPromise
}

async function _doLoad(token) {
  try {
    const docs = await fsList(token, COLLECTION)
    _logByItemId = {}
    for (const { _id, ...entry } of docs) {
      const { item_id } = entry
      if (!item_id) continue
      if (!_logByItemId[item_id]) _logByItemId[item_id] = []
      _logByItemId[item_id].push({ _id, ...entry })
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
    source:        'kairos',
    item_id:       entry.item_id       ?? '',
    item_type:     entry.item_type     ?? '',
    title:         entry.title         ?? '',
    verb:          entry.verb,
    action_detail: entry.action_detail ?? {},
    narrative:     entry.narrative     ?? '',
    context:       entry.context       ?? '',
  }

  // Update in-memory cache immediately (_id backfilled after write)
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
