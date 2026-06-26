// Per-project task lists stored in Firestore.
// lists/{listId}: { calendarId, name, order, sortMode: 'manual'|'date' }

import { fsAdd, fsList, fsSet, fsDelete } from './firestore.js'

const DEFAULT_LIST_NAMES = ['Backlog', 'In Progress', 'Done']

let _lists       = null  // { [listId]: record } — null until loaded
let _saveToken   = null
let _loadPromise = null

export async function loadLists(token) {
  if (_lists !== null) return
  if (_loadPromise) return _loadPromise
  _loadPromise = _doLoad(token).finally(() => { _loadPromise = null })
  return _loadPromise
}

async function _doLoad(token) {
  _saveToken = token
  try {
    const docs = await fsList(token, 'lists')
    _lists = {}
    for (const { _id, ...record } of docs) {
      _lists[_id] = record
    }
  } catch (err) {
    console.warn('Firestore lists load failed:', err.message)
    _lists = {}
  }
}

export function getListsForCalendar(calendarId) {
  if (!_lists) return []
  return Object.entries(_lists)
    .filter(([, r]) => r.calendarId === calendarId)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

export function getList(listId) {
  if (!_lists?.[listId]) return null
  return { id: listId, ..._lists[listId] }
}

export function getAllLists() {
  if (!_lists) return []
  return Object.entries(_lists).map(([id, r]) => ({ id, ...r }))
}

export async function createList(token, calendarId, name, order = 0) {
  const data = { calendarId, name, order, sortMode: 'manual' }
  const { _id, ...rest } = await fsAdd(token ?? _saveToken, 'lists', data)
  if (_lists) _lists[_id] = rest
  return { id: _id, ...rest }
}

export async function updateList(token, listId, changes) {
  if (!_lists?.[listId]) return
  const updated = { ..._lists[listId], ...changes }
  _lists[listId] = updated
  await fsSet(token ?? _saveToken, `lists/${listId}`, updated)
  return { id: listId, ...updated }
}

export async function deleteList(token, listId) {
  if (_lists) delete _lists[listId]
  await fsDelete(token ?? _saveToken, `lists/${listId}`)
}

// Create the three default lists for a calendar just designated as a task calendar.
// No-op if the calendar already has lists.
export async function ensureDefaultLists(token, calendarId) {
  const existing = getListsForCalendar(calendarId)
  if (existing.length > 0) return existing
  const created = []
  for (let i = 0; i < DEFAULT_LIST_NAMES.length; i++) {
    created.push(await createList(token, calendarId, DEFAULT_LIST_NAMES[i], i * 10))
  }
  return created
}
