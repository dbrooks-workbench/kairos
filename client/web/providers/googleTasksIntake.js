import { parseTaskNotes, serializeNotes } from './parsers.js'
import { loadTaskMeta, loadTaskArchive, getTaskMeta, hasTaskRecord, syncTaskSnapshot, updateTaskMeta, archiveOrphanedMeta } from './driveTaskMeta.js'
import { loadPrefs } from './kairosPrefs.js'
import { loadLifeLog, getItemLog } from './lifeLog.js'

const BASE = 'https://www.googleapis.com/tasks/v1'

async function get(token, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
  return res.json()
}

async function paginate(token, url) {
  const items = []
  let pageToken = null
  do {
    const data = await get(token, pageToken ? `${url}&pageToken=${pageToken}` : url)
    if (data.items?.length) items.push(...data.items)
    pageToken = data.nextPageToken ?? null
  } while (pageToken)
  return items
}

export async function getTaskLists(token) {
  const data = await get(token, `${BASE}/users/@me/lists`)
  return data.items ?? []
}

function normalizeTask(task, list) {
  // task.due is UTC midnight (e.g. "2026-06-15T00:00:00.000Z"). Parsing directly
  // shifts the date back by one day in any timezone west of UTC. Instead, extract
  // the date portion and parse as local midnight so the day matches the due date.
  const due    = task.due ? new Date(task.due.slice(0, 10) + 'T00:00:00') : null
  const parsed = parseTaskNotes(task.notes ?? '')
  const kid    = parsed.kid

  const loe = kid && hasTaskRecord(kid) ? getTaskMeta(kid).loe : parsed.loe

  // Comments sourced exclusively from the life log Sheet (single source of truth).
  const itemId   = `gtasks:${list.id}:${task.id}`
  const comments = getItemLog(itemId).map(e => ({
    timestamp: e.timestamp,
    text:      e.verb === 'comment' ? (e.action_detail?.text ?? e.narrative) : e.narrative,
    _readonly: e.verb !== 'comment',
  }))

  if (kid) syncTaskSnapshot(kid, task, { loe })

  return {
    id: `gtasks:${list.id}:${task.id}`,
    title: task.title ?? '(No title)',
    item_type: 'TASK',
    source: {
      provider: 'google-tasks',
      account_id: list.id,
      external_id: task.id,
    },
    start: due,
    end: null,
    due,
    all_day: true,
    status: task.status === 'completed' ? 'COMPLETED' : 'NEEDS_ACTION',
    recurrence: null,
    metadata: { body: parsed.body, loe, checklist: parsed.checklist, comments, list_title: list.title, kid },
    color: null,
    editable: true,
  }
}

export async function patchTask(token, listId, taskId, fields) {
  const res = await fetch(
    `${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }
  )
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
  if (res.status === 204) return null
  return res.json()
}

export const completeTask   = (token, listId, taskId) => patchTask(token, listId, taskId, { status: 'completed' })
export const uncompleteTask = (token, listId, taskId) => patchTask(token, listId, taskId, { status: 'needsAction' })

export async function createTask(token, listId, { title, notes, due }) {
  const body = { title }
  if (notes) body.notes = notes
  if (due)   body.due   = due.includes('T') ? due : `${due}T00:00:00.000Z`
  const res = await fetch(`${BASE}/lists/${encodeURIComponent(listId)}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
  return res.json()
}

export async function createTaskList(token, title) {
  const res = await fetch(`${BASE}/users/@me/lists`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
  return res.json()
}

export async function renameTaskList(token, listId, title) {
  const res = await fetch(`${BASE}/users/@me/lists/${encodeURIComponent(listId)}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ title }),
  })
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
  return res.json()
}

export async function deleteTaskList(token, listId) {
  const res = await fetch(`${BASE}/users/@me/lists/${encodeURIComponent(listId)}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
}

export async function deleteTask(token, listId, taskId) {
  const res = await fetch(
    `${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
}

export async function reorderTask(token, listId, taskId, previousTaskId) {
  const qs = previousTaskId ? `?previous=${encodeURIComponent(previousTaskId)}` : ''
  const res = await fetch(
    `${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/move${qs}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
  return res.json()
}

// Move a task between lists: read → create in target → delete from source.
// Pass overrides to update content during the move (used by the modal's save path).
export async function moveTask(token, fromListId, taskId, toListId, overrides = null) {
  const src = await get(token, `${BASE}/lists/${encodeURIComponent(fromListId)}/tasks/${encodeURIComponent(taskId)}`)
  const body = {
    title: overrides?.title ?? src.title,
    notes: overrides?.notes ?? src.notes,
  }
  const rawDue = overrides ? overrides.due : src.due
  if (rawDue) body.due = rawDue.includes('T') ? rawDue : `${rawDue}T00:00:00.000Z`
  const createRes = await fetch(`${BASE}/lists/${encodeURIComponent(toListId)}/tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!createRes.ok) throw new Error(`Tasks API ${createRes.status} ${createRes.statusText}`)
  const newTask = await createRes.json()
  await deleteTask(token, fromListId, taskId)
  return newTask
}

// Fetch all tasks for the board view using two separate queries per list:
// 1. Active (needsAction) tasks — no date constraint, typically a small set
// 2. Completed tasks from the last N days (completedDays, default 30)
// completedMin only filters the completed field; active tasks have no completed
// field so a single query with completedMin would silently drop all active tasks.
export async function getAllTasks(token, completedDays = 30) {
  // Load both Drive files in parallel — archive is needed here for the sweep.
  const [lists] = await Promise.all([
    getTaskLists(token),
    loadTaskMeta(token),
    loadTaskArchive(token),
  ])
  const completedMin = new Date(Date.now() - completedDays * 86_400_000).toISOString()

  const results = await Promise.allSettled(
    lists.map(async list => {
      const enc = encodeURIComponent(list.id)

      const [active, done] = await Promise.all([
        paginate(token, `${BASE}/lists/${enc}/tasks?maxResults=100&showCompleted=false&showHidden=false`),
        paginate(token, `${BASE}/lists/${enc}/tasks?maxResults=100&showCompleted=true&showHidden=true&completedMin=${encodeURIComponent(completedMin)}`),
      ])

      // Deduplicate by Google task ID then normalise
      const seen = new Set()
      return [...active, ...done]
        .filter(t => !seen.has(t.id) && seen.add(t.id))
        .map(t => normalizeTask(t, list))
    })
  )

  const tasks = results.flatMap(r => {
    if (r.status === 'rejected') { console.warn('Board tasks fetch error:', r.reason); return [] }
    return r.value
  })

  // Move Drive meta records for tasks no longer present in Google Tasks to the
  // archive file rather than deleting them. Only safe here because getAllTasks
  // has a complete picture of what's currently alive across all lists.
  const liveKids = new Set(tasks.flatMap(t => t.metadata?.kid ? [t.metadata.kid] : []))
  archiveOrphanedMeta(liveKids)

  return { lists, tasks }
}

export async function getTasks(token, start, end) {
  await loadPrefs(token)   // must resolve before loadLifeLog reads getLifeLogSheetId()
  const [lists] = await Promise.all([getTaskLists(token), loadTaskMeta(token), loadLifeLog(token)])

  const results = await Promise.allSettled(
    lists.map(async list => {
      const enc    = encodeURIComponent(list.id)
      const params = new URLSearchParams({
        maxResults:    '100',
        showCompleted: 'true',
        showHidden:    'true',
        dueMin: start.toISOString(),
        dueMax: end.toISOString(),
      })
      const raw = await paginate(token, `${BASE}/lists/${enc}/tasks?${params}`)
      return raw.map(t => normalizeTask(t, list))
    })
  )

  return results.flatMap(r => {
    if (r.status === 'rejected') { console.warn('Tasks fetch error:', r.reason); return [] }
    return r.value
  })
}
