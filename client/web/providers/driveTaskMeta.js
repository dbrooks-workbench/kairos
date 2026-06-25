// Per-task metadata in Firestore.
//
// Collection: tasks/{kid}
//   { loe, history, archivedAt? }
//
// Active tasks:   no archivedAt field
// Archived tasks: archivedAt is an ISO timestamp
//
// loadTaskMeta lists the full collection once and partitions into active / archive.
// Mutations mark individual kids dirty; a debounced batch write flushes them.

import { fsList, fsBatchWrite } from './firestore.js'

const HISTORY_MAX = 10

let _active      = null   // { [kid]: record } — null until loaded
let _archive     = null   // { [kid]: record } — null until loaded
let _saveToken   = null
let _dirty       = new Set()
let _saveTimer   = null
let _loadPromise = null

export function generateKid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Load ──────────────────────────────────────────────────────────────────────

export async function loadTaskMeta(token) {
  if (_active !== null) return
  if (_loadPromise) return _loadPromise
  _loadPromise = _doLoad(token).finally(() => { _loadPromise = null })
  return _loadPromise
}

async function _doLoad(token) {
  _saveToken = token
  try {
    const docs = await fsList(token, 'tasks')
    _active  = {}
    _archive = {}
    for (const { _id: kid, ...record } of docs) {
      if (record.archivedAt) _archive[kid] = record
      else _active[kid] = record
    }
  } catch (err) {
    console.warn('Firestore task meta load failed:', err.message)
    _active  = {}
    _archive = {}
  }
}

// Archive is loaded as part of loadTaskMeta (same LIST call). This function
// exists so callers that only need the archive can await it independently.
export async function loadTaskArchive(token) {
  if (_active === null) await loadTaskMeta(token ?? _saveToken)
  return { version: 1, tasks: _archive ?? {} }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function hasTaskRecord(kid) {
  return !!(_active?.[kid])
}

export function getTaskMeta(kid) {
  if (!_active || !kid) return { loe: null }
  const record = _active[kid]
  if (!record) return { loe: null }
  return { loe: record.loe ?? null }
}

// ── Write ─────────────────────────────────────────────────────────────────────

// Push the current Google Tasks payload to history and update loe.
// Call on every normalizeTask so Drive reflects the latest Google Tasks state.
export function syncTaskSnapshot(kid, googlePayload, { loe }) {
  if (!_active || !kid) return
  const entry    = { _syncedAt: new Date().toISOString(), ...googlePayload }
  const existing = _active[kid]
  if (existing) {
    existing.loe     = loe
    existing.history = [entry, ...(existing.history ?? [])].slice(0, HISTORY_MAX)
  } else {
    _active[kid] = { loe, history: [entry] }
  }
  _dirty.add(kid)
  _scheduleSave()
}

// Update loe on explicit modal Save — does not push a history snapshot.
export function updateTaskMeta(kid, { loe }) {
  if (!_active || !kid) return
  const existing = _active[kid]
  if (existing) {
    existing.loe = loe
  } else {
    _active[kid] = { loe, history: [] }
  }
  _dirty.add(kid)
  _scheduleSave()
}

// Move records for kids no longer in the live Google Tasks set to the archive.
// Only safe to call from getAllTasks, which has a complete view of live kids.
export function archiveOrphanedMeta(liveKids) {
  if (!_active || !_archive) return
  const now = new Date().toISOString()
  for (const [kid, record] of Object.entries(_active)) {
    if (!liveKids.has(kid)) {
      _archive[kid] = { ...record, archivedAt: now }
      delete _active[kid]
      _dirty.add(kid)
    }
  }
  if (_dirty.size) _scheduleSave()
}

// ── Flush ─────────────────────────────────────────────────────────────────────

function _scheduleSave() {
  if (!_saveToken) return
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(_flush, 3000)
}

async function _flush() {
  if (!_dirty.size || !_saveToken) return
  const kids = [..._dirty]
  _dirty.clear()
  _saveTimer = null
  try {
    const writes = kids
      .map(kid => {
        const record = _active?.[kid] ?? _archive?.[kid]
        return record ? { path: `tasks/${kid}`, data: record } : null
      })
      .filter(Boolean)
    if (writes.length) await fsBatchWrite(_saveToken, writes)
  } catch (err) {
    console.warn('Firestore task meta save failed:', err.message)
    for (const kid of kids) _dirty.add(kid)
  }
}
