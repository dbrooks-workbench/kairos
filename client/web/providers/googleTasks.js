import { parseTaskNotes, serializeNotes, expandRruleInWindow, nextOccurrenceAfter } from './parsers.js'
import { loadRegistry, upsertSeries, orphanedDrivers } from './driveStore.js'
import { loadTaskMeta, loadTaskArchive, getTaskMeta, hasTaskRecord, syncTaskSnapshot, updateTaskMeta, generateKid, archiveOrphanedMeta } from './driveTaskMeta.js'
import { loadPrefs } from './drivePrefs.js'
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

  // Drive meta is authoritative for loe/recurrence when a record exists.
  // Fall back to notes-embedded values for tasks not yet saved through the new path.
  let loe, recurrence
  if (kid && hasTaskRecord(kid)) {
    const meta = getTaskMeta(kid)
    loe        = meta.loe
    recurrence = meta.recurrence
  } else {
    loe        = parsed.loe
    recurrence = parsed.recurrence   // backward compat: still in notes for unmigrated tasks
  }

  // Comments sourced exclusively from the life log Sheet (single source of truth).
  const itemId   = `gtasks:${list.id}:${task.id}`
  const comments = getItemLog(itemId).map(e => ({
    timestamp: e.timestamp,
    text:      e.verb === 'comment' ? (e.action_detail?.text ?? e.narrative) : e.narrative,
    _readonly: e.verb !== 'comment',
  }))

  // Push a history snapshot for any task that has a kid anchor in notes.
  if (kid) syncTaskSnapshot(kid, task, { loe, recurrence })

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
    metadata: { body: parsed.body, loe, recurrence, checklist: parsed.checklist, comments, list_title: list.title, kid },
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

// Recreate a real Google Task for an orphaned-driver virtual (series whose chain
// was broken externally and whose real tasks have been GC'd by Google).
export async function recreateOrphanedTask(token, item) {
  const due = item.due
  if (!due) return
  const p   = v => String(v).padStart(2, '0')
  const kid = generateKid()
  const notes = serializeNotes({ body: '', checklist: [], kid })
  await createTask(token, item.source.account_id, {
    title: item.title,
    notes,
    due:   `${due.getFullYear()}-${p(due.getMonth()+1)}-${p(due.getDate())}T00:00:00.000Z`,
  })
  updateTaskMeta(kid, { loe: null, comments: [], recurrence: item.metadata.recurrence ?? null })
}

export async function spawnNextRecurrence(token, item, listId) {
  const rrule = item.metadata?.recurrence
  if (!rrule) return
  const nextDue = nextOccurrenceAfter(rrule, item.due ?? new Date())
  if (!nextDue) return  // UNTIL reached — series is done

  const p   = v => String(v).padStart(2, '0')
  const kid = generateKid()
  const notes = serializeNotes({
    body:      item.metadata?.body ?? '',
    checklist: (item.metadata?.checklist ?? []).map(c => ({ ...c, checked: false })),
    kid,
  })
  await createTask(token, listId, {
    title: item.title,
    notes,
    due:   `${nextDue.getFullYear()}-${p(nextDue.getMonth()+1)}-${p(nextDue.getDate())}T00:00:00.000Z`,
  })

  // Write recurrence and inherited LOE to Drive meta for the spawned task
  updateTaskMeta(kid, { loe: item.metadata?.loe ?? null, comments: [], recurrence: rrule })
}

export async function getTasks(token, start, end) {
  await loadPrefs(token)   // must resolve before loadLifeLog reads getLifeLogSheetId()
  const [lists] = await Promise.all([getTaskLists(token), loadRegistry(token), loadTaskMeta(token), loadLifeLog(token)])

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

      // completedMin window for fetching recently-completed tasks as series drivers.
      // Needed so tasks completed outside Kairos (no spawn) still generate virtuals.
      const completedMin = new Date(Date.now() - 30 * 86_400_000).toISOString()

      const [windowRaw, activeRaw, recentDoneRaw] = await Promise.all([
        paginate(token, `${BASE}/lists/${enc}/tasks?${params}`),
        paginate(token, `${BASE}/lists/${enc}/tasks?maxResults=100&showCompleted=false&showHidden=false`),
        paginate(token, `${BASE}/lists/${enc}/tasks?maxResults=100&showCompleted=true&showHidden=true&completedMin=${encodeURIComponent(completedMin)}`),
      ])

      const windowItems = windowRaw.map(t => normalizeTask(t, list))

      // Outer active recurring tasks (due outside the window)
      const windowIds = new Set(windowItems.map(i => i.source.external_id))
      const outerRecurring = activeRaw
        .filter(t => !windowIds.has(t.id))
        .map(t => normalizeTask(t, list))
        .filter(i => i.metadata?.recurrence)

      // Recently-completed recurring tasks that fall outside the window.
      // When a task is completed via Google Tasks directly (bypassing Kairos),
      // no successor is spawned. Including these here lets them drive virtual
      // expansion so the series stays visible. seriesLatest de-dup ensures that
      // if a real successor was spawned (higher due date), it wins instead.
      const outerDoneRecurring = recentDoneRaw
        .filter(t => !windowIds.has(t.id))
        .map(t => normalizeTask(t, list))
        .filter(i => i.metadata?.recurrence && i.status === 'COMPLETED')

      // Build virtual instances from ALL recurring tasks (active + completed).
      // De-duplicate by series: group by (title + rrule) and only expand from the
      // LATEST task in each series. This prevents cascading duplicates when Google
      // GCs old completed instances while newer spawned ones are still alive.
      const allRecurring = [
        ...windowItems.filter(i => i.metadata?.recurrence),
        ...outerRecurring,
        ...outerDoneRecurring,
      ]

      // Refresh the Drive registry with every live recurring task we can see.
      for (const item of allRecurring) {
        if (item.due) upsertSeries(token, item.title, item.metadata.recurrence, list.id, item.due)
      }

      // Add registry entries for series with no live task driver. These are
      // series whose real tasks have been GC'd by Google (>30 days after completion
      // without a Kairos-spawned successor). The registry anchor keeps the series
      // visible as virtual instances indefinitely.
      const liveSeriesKeys = new Set(allRecurring.map(i => `${i.title}::${i.metadata.recurrence}`))
      for (const s of orphanedDrivers(liveSeriesKeys, list.id)) {
        allRecurring.push({
          id:         `registry:${list.id}:${s.title}`,
          title:      s.title,
          item_type:  'TASK',
          source:     { provider: 'google-tasks', account_id: list.id, external_id: null },
          due:        new Date(s.lastDue + 'T00:00:00'),
          start:      new Date(s.lastDue + 'T00:00:00'),
          end:        null,
          all_day:    true,
          status:     'NEEDS_ACTION',
          recurrence: null,
          metadata:   { recurrence: s.rrule, orphaned: true, body: '', loe: null, checklist: [], comments: [], list_title: list.title },
          color:      null,
          editable:   false,
        })
      }

      const seriesLatest = new Map()  // `${title}::${rrule}` → item with highest due
      for (const item of allRecurring) {
        const key = `${item.title}::${item.metadata.recurrence}`
        const cur = seriesLatest.get(key)
        if (!cur || (item.due && (!cur.due || item.due > cur.due))) seriesLatest.set(key, item)
      }

      const virtual = [...seriesLatest.values()].flatMap(item => expandRruleInWindow(item, start, end))

      // Suppress virtuals only where a real task from the SAME series (title + rrule)
      // already occupies that date. Different recurring series may share dates freely.
      const realSeriesDateKeys = new Set(
        windowItems
          .filter(i => i.due && i.metadata?.recurrence)
          .map(i => `${i.title}::${i.metadata.recurrence}::${i.due.toLocaleDateString('en-CA')}`)
      )
      const dedupedVirtual = virtual.filter(v => {
        const dk = v.due?.toLocaleDateString('en-CA')
        if (!dk) return false
        return !realSeriesDateKeys.has(`${v.title}::${v.metadata.recurrence}::${dk}`)
      })

      return [...windowItems, ...dedupedVirtual]
    })
  )

  return results.flatMap(r => {
    if (r.status === 'rejected') { console.warn('Tasks fetch error:', r.reason); return [] }
    return r.value
  })
}
