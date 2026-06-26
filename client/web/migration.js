// Phase 7: one-shot migration of Google Tasks → Calendar task events.
//
// Flow per task:
//   1. Parse notes with parseTaskNotes (extracts body, checklist, kid, loe)
//   2. Convert prose + checklist to Tiptap-compatible HTML
//   3. Create calendar event on the configured task calendar
//   4. Mark the GT task as completed so Google auto-purges it in 30 days
//
// Reuses the existing kid as kairosId for continuity across the migration.

import { parseTaskNotes } from './providers/parsers.js'
import { generateKairosId } from './providers/driveTaskMeta.js'
import { createTask } from './providers/calendarTasks.js'
import { getListsForCalendar, createList } from './providers/kairosLists.js'
import { getTaskCalendars } from './providers/kairosPrefs.js'

const GT_BASE = 'https://www.googleapis.com/tasks/v1'

// ── Google Tasks helpers ──────────────────────────────────────────────────────

async function _gtFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  })
  if (!res.ok) throw new Error(`GT ${res.status}: ${res.statusText}`)
  return res.status === 204 ? null : res.json()
}

async function _paginate(token, url) {
  const items = []
  let pageToken = null
  do {
    const data = await _gtFetch(token, pageToken ? `${url}&pageToken=${pageToken}` : url)
    if (data?.items?.length) items.push(...data.items)
    pageToken = data?.nextPageToken ?? null
  } while (pageToken)
  return items
}

async function _getLists(token) {
  const data = await _gtFetch(token, `${GT_BASE}/users/@me/lists`)
  return data?.items ?? []
}

async function _getActiveTasks(token, listId) {
  return _paginate(
    token,
    `${GT_BASE}/lists/${encodeURIComponent(listId)}/tasks?showCompleted=false&showHidden=false&maxResults=100`,
  )
}

async function _markGtComplete(token, listId, taskId) {
  await _gtFetch(token, `${GT_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body:   JSON.stringify({ status: 'completed' }),
  })
}

async function _fetchWebhookToken() {
  try {
    const res = await fetch('/api/webhook-token', { credentials: 'include' })
    if (res.ok) return (await res.json()).token ?? null
  } catch {}
  return null
}

// ── Notes → HTML conversion ───────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _notesToHtml(body, checklist) {
  let html = ''
  if (body?.trim()) {
    html += body.trim()
      .split(/\n\n+/)
      .map(p => `<p>${_esc(p).replace(/\n/g, '<br>')}</p>`)
      .join('')
  }
  if (checklist?.length) {
    const items = checklist
      .map(c => `<li data-type="taskItem" data-checked="${c.checked}">${_esc(c.text)}</li>`)
      .join('')
    html += `<ul data-type="taskList">${items}</ul>`
  }
  return html
}

// ── Migration ─────────────────────────────────────────────────────────────────

// Migrates all active (needsAction) Google Tasks to the first configured task
// calendar, then marks each source task completed in Google Tasks.
// Returns { migrated, failed, skipped, total }.
export async function runMigration(token, onProgress) {
  const targetCalId = getTaskCalendars()[0] ?? null
  if (!targetCalId) throw new Error('No task calendar configured. Enable one in the Calendars picker first.')

  const webhookToken = await _fetchWebhookToken()

  // Build name→listId lookup from Kairos lists (populated lazily during migration)
  const kairosLists  = getListsForCalendar(targetCalId)
  const nameToListId = new Map(kairosLists.map(l => [l.name.toLowerCase(), l.id]))
  const maxOrder     = kairosLists.reduce((m, l) => Math.max(m, l.order ?? 0), 0)
  let   nextOrder    = maxOrder + 10

  const gtLists = await _getLists(token)
  let migrated = 0, failed = 0, skipped = 0, total = 0

  // Per-destination-list order counter so items don't all land at the same order value
  const orderCtr = {}

  for (const gtList of gtLists) {
    let tasks
    try {
      tasks = await _getActiveTasks(token, gtList.id)
    } catch (err) {
      console.warn(`Skipping GT list "${gtList.title}": ${err.message}`)
      continue
    }

    // Match by name (case-insensitive); create a new Kairos list if none matches
    const nameKey = gtList.title?.toLowerCase() ?? ''
    let targetListId = nameToListId.get(nameKey) ?? null
    if (!targetListId && gtList.title?.trim()) {
      const newList  = await createList(token, targetCalId, gtList.title.trim(), nextOrder)
      nextOrder += 10
      targetListId = newList.id
      nameToListId.set(nameKey, targetListId)
    }
    total += tasks.length
    onProgress?.({ migrated, failed, skipped, total })

    for (const task of tasks) {
      if (!task.title?.trim()) {
        skipped++
        onProgress?.({ migrated, failed, skipped, total })
        continue
      }

      try {
        const { body, checklist, kid, loe } = parseTaskNotes(task.notes ?? '')
        const kairosId = kid ?? generateKairosId()
        const htmlBody = _notesToHtml(body, checklist)
        const dateStr  = task.due ? task.due.slice(0, 10) : null

        // Assign a monotonically increasing order per destination list
        orderCtr[targetListId] = (orderCtr[targetListId] ?? 0) + 10

        await createTask(token, targetCalId, {
          title:        task.title,
          body:         htmlBody,
          kairosId,
          listId:       targetListId,
          order:        orderCtr[targetListId],
          loe:          loe || null,
          date:         dateStr,
          noDate:       !dateStr,
          webhookToken: dateStr ? webhookToken : null,
        })

        await _markGtComplete(token, gtList.id, task.id)
        migrated++
      } catch (err) {
        console.error(`Migration failed for "${task.title}":`, err)
        failed++
      }

      onProgress?.({ migrated, failed, skipped, total })
    }
  }

  return { migrated, failed, skipped, total }
}
