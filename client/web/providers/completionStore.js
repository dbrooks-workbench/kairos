// Task completion state in Firestore.
//
// Collection: events/{eventId}
//   { completedAt: ISO string | null }
//
// completedAt non-null = completed. Activity log lives in the life log only.

import { fsList, fsSet } from './firestore.js'

let _events      = null   // { [eventId]: { completedAt } } — null until loaded
let _saveToken   = null
let _loadPromise = null

export async function loadCompletionStore(token) {
  if (_events !== null) return
  if (_loadPromise) return _loadPromise
  _loadPromise = _doLoad(token).finally(() => { _loadPromise = null })
  return _loadPromise
}

async function _doLoad(token) {
  _saveToken = token
  try {
    const docs = await fsList(token, 'events')
    _events = {}
    for (const { _id: eventId, ...record } of docs) {
      _events[eventId] = record
    }
  } catch (err) {
    console.warn('Firestore completion store load failed:', err.message)
    _events = {}
  }
}

export function getCompletedAt(eventId) {
  return _events?.[eventId]?.completedAt ?? null
}

export async function setCompleted(token, eventId) {
  if (!_events) return null
  const ts = new Date().toISOString()
  if (!_events[eventId]) _events[eventId] = {}
  _events[eventId].completedAt = ts
  await _write(token ?? _saveToken, eventId)
  return ts
}

export async function setUncompleted(token, eventId) {
  if (!_events) return
  if (!_events[eventId]) _events[eventId] = {}
  _events[eventId].completedAt = null
  await _write(token ?? _saveToken, eventId)
}

async function _write(token, eventId) {
  try {
    await fsSet(token, `events/${eventId}`, _events[eventId], { keepalive: true })
  } catch (err) {
    console.warn('Firestore completion store save failed:', err.message)
  }
}
