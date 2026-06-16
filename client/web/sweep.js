import { getAllTasks, createTask, deleteTask } from './providers/googleTasks.js'
import { serializeNotes, nowTimestamp } from './providers/parsers.js'

const CONFIG_KEY = 'kairos:sweep-target-list'

export function getSweepTargetListId()      { return localStorage.getItem(CONFIG_KEY) ?? null }
export function setSweepTargetListId(id)    { localStorage.setItem(CONFIG_KEY, id) }

// Move all active (NEEDS_ACTION) tasks from every secondary account into a single
// list on the primary account. Appends a timestamped comment recording the origin.
// Returns { moved: number }.
export async function runSweep(accounts, taskLists) {
  const primary     = accounts.find(a => a.primary)
  const secondaries = accounts.filter(a => !a.primary)

  if (!primary || !secondaries.length) return { moved: 0 }

  const configuredId = getSweepTargetListId()
  const targetListId = (configuredId && taskLists.some(l => l.id === configuredId))
    ? configuredId
    : taskLists[0]?.id

  if (!targetListId) return { moved: 0 }

  let moved = 0
  const pad = v => String(v).padStart(2, '0')

  for (const secondary of secondaries) {
    let result
    try {
      result = await getAllTasks(secondary.token)
    } catch (err) {
      console.error(`Sweep: failed to read tasks from ${secondary.email ?? secondary.id}:`, err)
      continue
    }

    const active = result.tasks.filter(t => t.status === 'NEEDS_ACTION')

    for (const task of active) {
      try {
        const due = task.due
          ? `${task.due.getFullYear()}-${pad(task.due.getMonth() + 1)}-${pad(task.due.getDate())}`
          : null

        const notes = serializeNotes({
          body:      task.metadata.body      ?? '',
          loe:       task.metadata.loe       ?? null,
          checklist: task.metadata.checklist ?? [],
          comments: [
            ...(task.metadata.comments ?? []),
            { timestamp: nowTimestamp(), text: `Swept from ${secondary.email ?? 'secondary account'}` },
          ],
        })

        await createTask(primary.token, targetListId, { title: task.title, notes, due })
        await deleteTask(secondary.token, task.source.account_id, task.source.external_id)
        moved++
      } catch (err) {
        console.error(`Sweep: failed to move "${task.title}":`, err)
      }
    }
  }

  return { moved }
}
