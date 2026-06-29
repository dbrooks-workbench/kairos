// Life log — append-only activity store in Firestore (activity/{autoId}).
//
// Each document:
//   { timestamp, source, item_id, item_type, title, verb, action_detail, narrative, context }
//
// verb          — machine token: completed, uncompleted, snoozed, comment, ...
// action_detail — object with verb-specific fields
// narrative     — human-readable prose

import { fsList, fsAdd, fsSet, fsDelete } from './firestore.js'

const COLLECTION = 'activity'

// { [item_id]:   [{ _id, ... }] }  — primary index by item_id
// { [kairosId]:  [{ _id, ... }] }  — secondary index by kairosId field (task events)
// Both null until loadLifeLog has run
let _logByItemId   = null
let _logByKairosId = null
let _loadPromise   = null   // deduplicates concurrent calls (e.g. from parallel getEvents+getTasks)

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
    _logByItemId   = {}
    _logByKairosId = {}
    for (const { _id, ...entry } of docs) {
      const { item_id, kairosId } = entry
      if (!item_id) continue
      if (!_logByItemId[item_id]) _logByItemId[item_id] = []
      _logByItemId[item_id].push({ _id, ...entry })
      if (kairosId) {
        if (!_logByKairosId[kairosId]) _logByKairosId[kairosId] = []
        _logByKairosId[kairosId].push({ _id, ...entry })
      }
    }
  } catch (err) {
    console.warn('Life log load failed:', err.message)
    _logByItemId   = {}
    _logByKairosId = {}
  }
}

// Returns log entries for one item, sorted chronologically.
// Pass kairosId for task events so migrated entries (stored under old gtasks: IDs) are found.
export function getItemLog(itemId, kairosId) {
  if (!_logByItemId) return []
  const byId      = itemId   ? (_logByItemId[itemId]     ?? []) : []
  const byKairos  = kairosId ? (_logByKairosId[kairosId] ?? []) : []
  // Merge, deduplicate by _id
  const seen = new Set()
  const merged = []
  for (const e of [...byId, ...byKairos]) {
    if (!seen.has(e._id)) { seen.add(e._id); merged.push(e) }
  }
  return merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
}

// Append an activity entry. Returns the new Firestore _id (null on failure).
// entry: { item_id, item_type, title, verb, action_detail, narrative, context, event_date?, kairosId? }
// Pass kairosId for task events — stored in the document so entries survive future item ID changes.
export async function appendLogEntry(token, entry) {
  const timestamp = new Date().toISOString()
  const doc = {
    timestamp,                                   // immutable create time
    event_date:    entry.event_date ?? timestamp, // editable "when it happened"
    source:        'kairos',
    item_id:       entry.item_id       ?? '',
    item_type:     entry.item_type     ?? '',
    title:         entry.title         ?? '',
    verb:          entry.verb,
    action_detail: entry.action_detail ?? {},
    narrative:     entry.narrative     ?? '',
    context:       entry.context       ?? '',
    ...(entry.kairosId ? { kairosId: entry.kairosId } : {}),
  }

  // Update in-memory cache immediately (_id backfilled after write)
  if (_logByItemId !== null && entry.item_id) {
    if (!_logByItemId[entry.item_id]) _logByItemId[entry.item_id] = []
    _logByItemId[entry.item_id].push({ _id: null, ...doc })
  }
  if (_logByKairosId !== null && entry.kairosId) {
    if (!_logByKairosId[entry.kairosId]) _logByKairosId[entry.kairosId] = []
    _logByKairosId[entry.kairosId].push({ _id: null, ...doc })
  }

  try {
    const written = await fsAdd(token, COLLECTION, doc)
    // Backfill _id on the cache entry we just pushed
    if (_logByItemId && entry.item_id) {
      const arr  = _logByItemId[entry.item_id]
      const last = arr?.[arr.length - 1]
      if (last && last._id === null && last.timestamp === timestamp) last._id = written._id
    }
    return written._id
  } catch (err) {
    console.warn('Life log append failed:', err.message)
    return null
  }
}

// Update mutable fields (narrative, action_detail, event_date) on an existing entry.
// Uses the in-memory cache to reconstruct the full document for a safe full-replace write.
export async function updateLogEntry(token, itemId, entryId, updates) {
  if (!entryId) return
  const cached = (_logByItemId?.[itemId] ?? []).find(e => e._id === entryId)
  if (!cached) return

  if ('narrative'     in updates) cached.narrative     = updates.narrative
  if ('action_detail' in updates) cached.action_detail = updates.action_detail
  if ('event_date'    in updates) cached.event_date    = updates.event_date

  const { _id: _, ...doc } = cached
  try {
    await fsSet(token, `${COLLECTION}/${entryId}`, doc)
  } catch (err) {
    console.warn('Life log update failed:', err.message)
  }
}

// Re-link activity entries from an old item_id (e.g. gtasks:…) to a kairosId.
// Adds the kairosId field to each matching Firestore document so getItemLog can find
// them via the kairosId index. Does not change item_id — both lookups keep working.
// Use from the browser console after a task migration:
//   relinkLogEntries(token, 'gtasks:LIST:TASKID', 'kairosId')
export async function relinkLogEntries(token, oldItemId, kairosId) {
  if (!oldItemId || !kairosId || !_logByItemId) return 0
  const entries = (_logByItemId[oldItemId] ?? []).filter(e => e._id)
  let count = 0
  for (const entry of entries) {
    if (entry.kairosId === kairosId) continue   // already linked
    entry.kairosId = kairosId
    // Add to kairosId index
    if (!_logByKairosId[kairosId]) _logByKairosId[kairosId] = []
    if (!_logByKairosId[kairosId].find(e => e._id === entry._id)) {
      _logByKairosId[kairosId].push(entry)
    }
    const { _id, ...doc } = entry
    try {
      await fsSet(token, `${COLLECTION}/${_id}`, doc)
      count++
    } catch (err) {
      console.warn('relinkLogEntries write failed:', err.message)
    }
  }
  return count
}

// Delete a single activity entry from Firestore and the in-memory cache.
export async function deleteLogEntry(token, itemId, entryId) {
  if (!entryId) return
  // Remove from both caches immediately
  if (_logByItemId && itemId) {
    _logByItemId[itemId] = (_logByItemId[itemId] ?? []).filter(e => e._id !== entryId)
  }
  if (_logByKairosId) {
    for (const key of Object.keys(_logByKairosId)) {
      _logByKairosId[key] = _logByKairosId[key].filter(e => e._id !== entryId)
    }
  }
  try {
    await fsDelete(token, `${COLLECTION}/${entryId}`)
  } catch (err) {
    console.warn('Life log delete failed:', err.message)
  }
}
