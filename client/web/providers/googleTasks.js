import { parseTaskNotes } from './parsers.js'

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
  const due = task.due ? new Date(task.due.slice(0, 10) + 'T00:00:00') : null
  const { body, loe, checklist, comments } = parseTaskNotes(task.notes ?? '')

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
    metadata: { body, loe, checklist, comments, list_title: list.title },
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

export async function deleteTask(token, listId, taskId) {
  const res = await fetch(
    `${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
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
// 2. Completed tasks from the last 30 days — Google purges beyond that anyway
// completedMin only filters the completed field; active tasks have no completed
// field so a single query with completedMin would silently drop all active tasks.
export async function getAllTasks(token) {
  const lists        = await getTaskLists(token)
  const completedMin = new Date(Date.now() - 30 * 86_400_000).toISOString()

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

  return {
    lists,
    tasks: results.flatMap(r => {
      if (r.status === 'rejected') { console.warn('Board tasks fetch error:', r.reason); return [] }
      return r.value
    }),
  }
}

export async function getTasks(token, start, end) {
  const lists = await getTaskLists(token)
  const results = await Promise.allSettled(
    lists.map(async list => {
      const params = new URLSearchParams({
        maxResults:    '100',
        showCompleted: 'true',
        showHidden:    'true',
        dueMin: start.toISOString(),
        dueMax: end.toISOString(),
      })
      const tasks = await paginate(
        token,
        `${BASE}/lists/${encodeURIComponent(list.id)}/tasks?${params}`
      )
      return tasks.map(t => normalizeTask(t, list))
    })
  )

  return results
    .flatMap(r => {
      if (r.status === 'rejected') { console.warn('Tasks fetch error:', r.reason); return [] }
      return r.value
    })
}
