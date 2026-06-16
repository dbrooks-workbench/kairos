import { createTask } from './providers/googleTasks.js'
import { updateEvent } from './providers/googleCalendar.js'
import { serializeNotes, serializeEventDescription, nowTimestamp } from './providers/parsers.js'
import { getToken } from './auth.js'
import { getSweepTargetListId } from './sweep.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDayOffset(str) {
  const m = String(str ?? '0d').match(/^(-?\d+)d$/)
  return m ? parseInt(m[1], 10) : 0
}

function shiftDate(date, days) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  d.setHours(0, 0, 0, 0)
  return d
}

function toIsoDate(date) {
  const p = v => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

// ── Spawn processing ──────────────────────────────────────────────────────────
// Scans calendarItems (events only) for spawn configs. For each prototype whose
// trigger window has opened, creates a Google Task and appends a !spawned log
// entry to the event description. Idempotent: re-running is safe.

export async function processSpawnDirectives(calendarItems, taskLists) {
  const token = await getToken()
  if (!token || !taskLists?.length) return { spawned: 0 }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const configuredId = getSweepTargetListId()
  const targetListId = (configuredId && taskLists.some(l => l.id === configuredId))
    ? configuredId
    : taskLists[0]?.id
  if (!targetListId) return { spawned: 0 }

  let spawned = 0

  for (const item of calendarItems) {
    if (item.item_type !== 'EVENT') continue
    const protos = item.metadata?.config?.spawn
    if (!Array.isArray(protos) || !protos.length) continue
    if (!item.editable) continue

    const eventStart = new Date(item.start)
    eventStart.setHours(0, 0, 0, 0)
    if (today > eventStart) continue  // don't process past events

    for (const proto of protos) {
      if (!proto.key || !proto.title || !proto.trigger) continue

      // Only act once trigger window has opened (today >= eventStart + offset)
      const triggerDate = shiftDate(eventStart, parseDayOffset(proto.trigger))
      if (today < triggerDate) continue

      // Idempotence: check for existing !spawned $KEY log entry
      const alreadySpawned = (item.metadata.comments ?? []).some(c =>
        c.action === 'spawned' && c.key === proto.key
      )
      if (alreadySpawned) continue

      try {
        const dueDate = shiftDate(eventStart, parseDayOffset(proto.due ?? '0d'))
        const notes   = serializeNotes({
          body:      proto.body ?? '',
          loe:       proto.loe  ?? null,
          checklist: (proto.checklist ?? []).map(t => ({ text: String(t), checked: false })),
          comments:  [],
        })

        const created = await createTask(token, targetListId, {
          title: proto.title,
          notes: notes || undefined,
          due:   `${toIsoDate(dueDate)}T00:00:00.000Z`,
        })

        // Write !spawned log entry back to the event description
        const newComments = [
          ...(item.metadata.comments ?? []),
          {
            timestamp: nowTimestamp(),
            text:      `!spawned $${proto.key} ${created.id}`,
            action:    'spawned',
            key:       proto.key,
            payload:   created.id,
          },
        ]
        await updateEvent(token, item.source.account_id, item.source.external_id, {
          description: serializeEventDescription(
            item.metadata.body ?? '',
            item.metadata.config,
            newComments,
          ),
        })

        // Mutate in-memory so subsequent protos on this event see the log
        item.metadata.comments = newComments
        spawned++
      } catch (err) {
        console.error(`Spawn: failed for "$${proto.key}" on "${item.title}":`, err)
      }
    }
  }

  return { spawned }
}
