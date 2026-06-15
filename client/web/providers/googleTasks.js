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

async function getTaskLists(token) {
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

async function patchTaskStatus(token, listId, taskId, status) {
  const res = await fetch(
    `${BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    }
  )
  if (!res.ok) throw new Error(`Tasks API ${res.status} ${res.statusText}`)
}

export const completeTask   = (token, listId, taskId) => patchTaskStatus(token, listId, taskId, 'completed')
export const uncompleteTask = (token, listId, taskId) => patchTaskStatus(token, listId, taskId, 'needsAction')

export async function getTasks(token, start, end) {
  const lists = await getTaskLists(token)
  const results = await Promise.allSettled(
    lists.map(async list => {
      const params = new URLSearchParams({
        showCompleted: 'false',
        showHidden: 'false',
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
