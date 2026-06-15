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
  const due = task.due ? new Date(task.due) : null
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
