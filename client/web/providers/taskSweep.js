// Google Tasks → Kairos calendar task sweep.
//
// Designed to run on a schedule (future Cloudflare cron) or on-demand.
// Reads from explicitly designated GT lists across any connected account,
// creates Kairos calendar task events, then marks each GT task complete
// with a "Moved to Kairos" note appended for audit visibility.

import { parseTaskNotes } from './parsers.js'
import { generateKairosId } from './driveTaskMeta.js'
import { createTask } from './calendarTasks.js'
import { getStatus } from './kairosConfig.js'

const GT_BASE = 'https://www.googleapis.com/tasks/v1'

// ── Google Tasks API helpers ──────────────────────────────────────────────────

async function _gtFetch(token, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`GT ${res.status}: ${res.statusText}`)
  return res.status === 204 ? null : res.json()
}

// Fetch all GT task lists for the given account token.
export async function getGtLists(token) {
  const data = await _gtFetch(token, `${GT_BASE}/users/@me/lists`)
  return data?.items ?? []
}

// Fetch all active (needsAction) tasks from a specific GT list.
async function _getActiveTasks(token, listId) {
  const items = []
  let pageToken = null
  do {
    const qs  = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100' })
    if (pageToken) qs.set('pageToken', pageToken)
    const data = await _gtFetch(token, `${GT_BASE}/lists/${encodeURIComponent(listId)}/tasks?${qs}`)
    if (data?.items?.length) items.push(...data.items)
    pageToken = data?.nextPageToken ?? null
  } while (pageToken)
  return items
}

// Append "Moved to Kairos" note + mark task complete in a single PATCH.
// Visible to anyone who opens the task in the native Google Tasks client before
// Google auto-purges it after 30 days.
async function _markSwept(token, listId, taskId, originalNotes) {
  const existing = (originalNotes ?? '').trimEnd()
  const date     = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const appended = existing ? `${existing}\n\n---\nMoved to Kairos · ${date}` : `Moved to Kairos · ${date}`
  await _gtFetch(
    token,
    `${GT_BASE}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { method: 'PATCH', body: JSON.stringify({ notes: appended, status: 'completed' }) },
  )
}

// ── Notes → HTML ──────────────────────────────────────────────────────────────

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

// ── Main sweep ────────────────────────────────────────────────────────────────

// Run a sweep pass against all configured sources.
//
// accounts:      [{ id, email, primary, token }]  — all connected accounts
// calToken:      primary account token (for Google Calendar writes)
// webhookToken:  from /api/webhook-token; written into completion footer
// sweepSources:   [{ accountId, listId, listName }]
// targetStatusId: Kairos status ID (intake) where swept tasks land; its record
//                 carries the calendarId that determines the destination calendar
// onProgress:     optional ({ swept, failed, skipped, total }) callback
//
// Returns { swept, failed, skipped, total }.
export async function runSweep({ accounts, calToken, webhookToken, sweepSources, targetStatusId, onProgress }) {
  const targetStatus = getStatus(targetStatusId)
  if (!targetStatus) throw new Error('Sweep target status not found — check intake configuration.')

  const targetCalId = targetStatus.calendarId
  let swept = 0, failed = 0, skipped = 0, total = 0

  for (const source of sweepSources) {
    const account = accounts.find(a => a.id === source.accountId)
    if (!account) {
      console.warn(`[sweep] account ${source.accountId} not connected; skipping "${source.listName}"`)
      continue
    }

    let tasks
    try {
      tasks = await _getActiveTasks(account.token, source.listId)
    } catch (err) {
      console.warn(`[sweep] failed to fetch "${source.listName}" (${source.accountId}):`, err.message)
      continue
    }

    total += tasks.length
    onProgress?.({ swept, failed, skipped, total })

    for (const task of tasks) {
      if (!task.title?.trim()) {
        skipped++
        onProgress?.({ swept, failed, skipped, total })
        continue
      }

      try {
        const { body, checklist, kid, loe } = parseTaskNotes(task.notes ?? '')
        const kairosId = kid ?? generateKairosId()
        const htmlBody = _notesToHtml(body, checklist)
        const dateStr  = task.due ? task.due.slice(0, 10) : null

        await createTask(calToken, targetCalId, {
          title:        task.title,
          body:         htmlBody,
          kairosId,
          statusId:     targetStatusId,
          order:        Date.now(),
          loe:          loe || null,
          date:         dateStr,
          noDate:       !dateStr,
          webhookToken: dateStr ? webhookToken : null,
        })

        await _markSwept(account.token, source.listId, task.id, task.notes ?? '')
        swept++
      } catch (err) {
        console.error(`[sweep] failed for "${task.title}":`, err)
        failed++
      }

      onProgress?.({ swept, failed, skipped, total })
    }
  }

  return { swept, failed, skipped, total }
}
