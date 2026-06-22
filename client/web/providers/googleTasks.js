import { parseTaskNotes, serializeNotes, expandRruleInWindow, nextOccurrenceAfter } from './parsers.js'

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
  const { body, loe, recurrence, checklist, comments } = parseTaskNotes(task.notes ?? '')

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
    metadata: { body, loe, recurrence, checklist, comments, list_title: list.title },
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
  const lists        = await getTaskLists(token)
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

  return {
    lists,
    tasks: results.flatMap(r => {
      if (r.status === 'rejected') { console.warn('Board tasks fetch error:', r.reason); return [] }
      return r.value
    }),
  }
}

export async function spawnNextRecurrence(token, item, listId) {
  const rrule = item.metadata?.recurrence
  if (!rrule) return
  const nextDue = nextOccurrenceAfter(rrule, item.due ?? new Date())
  if (!nextDue) return  // UNTIL reached — series is done

  const p = v => String(v).padStart(2, '0')
  const notes = serializeNotes({
    body:       item.metadata?.body      ?? '',
    loe:        item.metadata?.loe       ?? null,
    recurrence: rrule,
    checklist:  (item.metadata?.checklist ?? []).map(c => ({ ...c, checked: false })),
    comments:   [],
  })
  await createTask(token, listId, {
    title: item.title,
    notes,
    due:   `${nextDue.getFullYear()}-${p(nextDue.getMonth()+1)}-${p(nextDue.getDate())}T00:00:00.000Z`,
  })
}

export async function getTasks(token, start, end) {
  const lists = await getTaskLists(token)
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

      const [windowRaw, activeRaw] = await Promise.all([
        paginate(token, `${BASE}/lists/${enc}/tasks?${params}`),
        paginate(token, `${BASE}/lists/${enc}/tasks?maxResults=100&showCompleted=false&showHidden=false`),
      ])

      const windowItems = windowRaw.map(t => normalizeTask(t, list))

      // Outer active recurring tasks (due outside the window)
      const windowIds = new Set(windowItems.map(i => i.source.external_id))
      const outerRecurring = activeRaw
        .filter(t => !windowIds.has(t.id))
        .map(t => normalizeTask(t, list))
        .filter(i => i.metadata?.recurrence)

      // Build virtual instances from ALL recurring tasks (active + completed).
      // De-duplicate by series: group by (title + rrule) and only expand from the
      // LATEST task in each series. This prevents cascading duplicates when Google
      // GCs old completed instances while newer spawned ones are still alive.
      const allRecurring = [
        ...windowItems.filter(i => i.metadata?.recurrence),
        ...outerRecurring,
      ]
      const seriesLatest = new Map()  // `${title}::${rrule}` → item with highest due
      for (const item of allRecurring) {
        const key = `${item.title}::${item.metadata.recurrence}`
        const cur = seriesLatest.get(key)
        if (!cur || (item.due && (!cur.due || item.due > cur.due))) seriesLatest.set(key, item)
      }

      const virtual = [...seriesLatest.values()].flatMap(item => expandRruleInWindow(item, start, end))

      // Suppress virtuals that land on a date already occupied by a real task
      // in the same list (either a spawned next-instance or any other real task).
      const realDateKeys = new Set(
        windowItems
          .filter(i => i.due)
          .map(i => i.due.toLocaleDateString('en-CA'))
      )
      const seenVirtual = new Set()
      const dedupedVirtual = virtual.filter(v => {
        const dk = v.due?.toLocaleDateString('en-CA')
        if (!dk || realDateKeys.has(dk) || seenVirtual.has(dk)) return false
        seenVirtual.add(dk)
        return true
      })

      return [...windowItems, ...dedupedVirtual]
    })
  )

  return results.flatMap(r => {
    if (r.status === 'rejected') { console.warn('Tasks fetch error:', r.reason); return [] }
    return r.value
  })
}
