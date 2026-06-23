import { getToken } from './auth.js'
import { serializeNotes, normalizeLoe, nowTimestamp, displayTimestamp, parseRecurSigil, MONTH_NAMES, nextOccurrenceAfter } from './providers/parsers.js'
import { createTask, patchTask, deleteTask, moveTask, completeTask, uncompleteTask, spawnNextRecurrence } from './providers/googleTasks.js'
import { generateKid, updateTaskMeta } from './providers/driveTaskMeta.js'

// ── Module state ──────────────────────────────────────────────────────────────

let _item         = null   // null → create mode
let _listId       = null
let _taskLists    = []
let _checklist    = []
let _comments     = []
let _callbacks    = {}
let _defaultDue   = null   // 'yyyy-mm-dd' pre-fill for create mode
let _notesPreview = null   // created once in initModal
let _recurDays    = new Set()  // selected weekdays when freq is WEEKLY/BIWEEKLY

const _SHORT_TO_LONG  = { SU:'SUNDAY', MO:'MONDAY', TU:'TUESDAY', WE:'WEDNESDAY', TH:'THURSDAY', FR:'FRIDAY', SA:'SATURDAY' }
const _DAY_LONG_NAMES = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY']

function _syncDayBtns() {
  document.querySelectorAll('#modal-recur-days-row .crp-day').forEach(b => {
    b.classList.toggle('active', _recurDays.has(b.dataset.rday))
  })
}

function _inferDayFromDue() {
  const dueStr = el('modal-due').value
  if (!dueStr) return
  const inferred = _DAY_LONG_NAMES[new Date(dueStr + 'T00:00:00').getDay()]
  _recurDays = new Set([inferred])
  _syncDayBtns()
}

function _inferMonthDayFromDue() {
  const dueStr = el('modal-due').value
  if (!dueStr) return
  el('modal-custom-monthday').value = new Date(dueStr + 'T00:00:00').getDate()
}

function _inferYearMonthDayFromDue() {
  const dueStr = el('modal-due').value
  if (!dueStr) return
  const d = new Date(dueStr + 'T00:00:00')
  el('modal-custom-month').value   = d.getMonth() + 1
  el('modal-custom-yearday').value = d.getDate()
}

function _syncCustomSubRows() {
  const customFreq = el('modal-custom-freq').value
  el('modal-recur-days-row').hidden      = customFreq !== 'WEEKLY'
  el('modal-custom-monthday-row').hidden  = customFreq !== 'MONTHLY'
  el('modal-custom-yearmonth-row').hidden = customFreq !== 'YEARLY'
  _syncDayBtns()
}

// Build the RRULE string from current modal UI state (used by both save and preview).
function _buildCurrentRecurrence() {
  const recurFreq  = el('modal-recur').value
  const recurUntil = el('modal-recur-until').value
  const dueStr     = el('modal-due').value

  if (recurFreq === 'CUSTOM') {
    const n        = Math.max(1, parseInt(el('modal-custom-interval').value, 10) || 1)
    const cfreq    = el('modal-custom-freq').value
    const untilSfx = recurUntil ? ` UNTIL ${recurUntil}` : ''
    let sigil = ''
    if (cfreq === 'DAILY') {
      sigil = n === 1 ? '&DAILY' : `&EVERY ${n} DAYS`
    } else if (cfreq === 'WEEKLY') {
      const days = _recurDays.size > 0 ? [..._recurDays]
        : (dueStr ? [_DAY_LONG_NAMES[new Date(dueStr + 'T00:00:00').getDay()]] : [])
      const dayStr = days.length ? ',' + days.join(',') : ''
      if      (n === 1) sigil = `&WEEKLY${dayStr}`
      else if (n === 2) sigil = `&BIWEEKLY${dayStr}`
      else              sigil = `&EVERY ${n} WEEKS${dayStr}`
    } else if (cfreq === 'MONTHLY') {
      const mday = parseInt(el('modal-custom-monthday').value, 10)
        || (dueStr ? new Date(dueStr + 'T00:00:00').getDate() : 1)
      sigil = n === 1 ? `&MONTHLY,${mday}` : `&EVERY ${n} MONTHS,${mday}`
    } else if (cfreq === 'YEARLY') {
      const month     = parseInt(el('modal-custom-month').value, 10) || 7
      const day       = parseInt(el('modal-custom-yearday').value, 10) || 1
      const monthName = MONTH_NAMES[month - 1]
      sigil = n === 1 ? `&ANNUALLY,${monthName} ${day}` : `&EVERY ${n} YEARS,${monthName} ${day}`
    }
    return sigil ? parseRecurSigil(sigil + untilSfx) : null
  }

  if (recurFreq) {
    let sigil = `&${recurFreq}`
    if (recurFreq === 'WEEKLY' || recurFreq === 'BIWEEKLY') {
      const days = _recurDays.size > 0 ? _recurDays : (() => {
        if (!dueStr) return new Set()
        return new Set([_DAY_LONG_NAMES[new Date(dueStr + 'T00:00:00').getDay()]])
      })()
      if (days.size > 0) sigil += ',' + [...days].join(',')
    } else if (recurFreq === 'MONTHLY' && dueStr) {
      sigil += ',' + new Date(dueStr + 'T00:00:00').getDate()
    }
    if (recurUntil) sigil += ` UNTIL ${recurUntil}`
    return parseRecurSigil(sigil)
  }

  return null
}

function _hideRecurPreview() {
  document.getElementById('recur-preview-popover').hidden = true
  el('modal-recur-preview-btn').textContent = '▸ Preview upcoming dates'
}

function _showRecurPreview(triggerBtn) {
  const rrule   = _buildCurrentRecurrence()
  const dueStr  = el('modal-due').value
  const listEl  = document.getElementById('recur-preview-popover-list')
  const popover = document.getElementById('recur-preview-popover')

  if (!rrule) {
    listEl.textContent = 'No recurrence configured.'
  } else {
    const start = dueStr ? new Date(dueStr + 'T00:00:00') : new Date()
    start.setHours(0, 0, 0, 0)
    const dates = []
    let cur = start
    for (let i = 0; i < 10; i++) {
      const next = nextOccurrenceAfter(rrule, cur)
      if (!next) break
      dates.push(next)
      cur = next
    }
    listEl.innerHTML = dates.length
      ? dates.map(d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })).join('<br>')
      : 'No upcoming occurrences — series may have ended.'
  }

  const rect = triggerBtn.getBoundingClientRect()
  const popW = 230
  popover.style.top  = `${rect.bottom + 6}px`
  popover.style.left = `${Math.min(rect.left, window.innerWidth - popW - 8)}px`
  popover.hidden = false
  el('modal-recur-preview-btn').textContent = '▾ Preview upcoming dates'
}

// ── URL linkification ─────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const _URL_RE = /https?:\/\/[^\s<>"']+/g

function linkify(text) {
  _URL_RE.lastIndex = 0
  let out = '', last = 0, m
  while ((m = _URL_RE.exec(text)) !== null) {
    out += escHtml(text.slice(last, m.index))
    out += `<a href="${escHtml(m[0])}" target="_blank" rel="noopener noreferrer">${escHtml(m[0])}</a>`
    last = _URL_RE.lastIndex
  }
  return (out + escHtml(text.slice(last))).replace(/\n/g, '<br>')
}

function _refreshNotesPreview() {
  if (!_notesPreview) return
  const ta = el('modal-notes')
  if (!/https?:\/\//.test(ta.value) || document.activeElement === ta) {
    _notesPreview.hidden = true
  } else {
    _notesPreview.innerHTML = linkify(ta.value)
    _notesPreview.hidden = false
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initModal() {
  el('modal-close').addEventListener('click', close)
  el('modal-cancel').addEventListener('click', close)
  el('modal-save').addEventListener('click', save)
  el('modal-delete').addEventListener('click', doDelete)
  el('modal-toggle-complete').addEventListener('click', toggleComplete)

  el('modal-checklist-add').addEventListener('click', addChecklistItem)
  el('modal-checklist-input').addEventListener('keydown', e => { if (e.key === 'Enter') addChecklistItem() })

  el('modal-comment-add').addEventListener('click', addComment)
  el('modal-comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') addComment() })

  el('modal-loe').addEventListener('input', () => el('modal-loe-error').hidden = true)

  // Recurrence
  el('modal-recur').addEventListener('change', () => {
    const freq     = el('modal-recur').value
    const isCustom = freq === 'CUSTOM'
    el('modal-recur-until-row').hidden     = !freq
    el('modal-custom-interval-row').hidden = !isCustom
    el('modal-recur-preview-wrap').hidden = !freq
    _hideRecurPreview()
    if (!isCustom) {
      el('modal-recur-days-row').hidden      = freq !== 'WEEKLY' && freq !== 'BIWEEKLY'
      el('modal-custom-monthday-row').hidden  = true
      el('modal-custom-yearmonth-row').hidden = true
    }
    if (!freq) { el('modal-recur-until').value = ''; _recurDays = new Set(); _syncDayBtns() }
    if (!isCustom && (freq === 'WEEKLY' || freq === 'BIWEEKLY') && _recurDays.size === 0) _inferDayFromDue()
    if (isCustom) {
      _syncCustomSubRows()
      const cfreq = el('modal-custom-freq').value
      if (cfreq === 'WEEKLY' && _recurDays.size === 0) _inferDayFromDue()
      if (cfreq === 'MONTHLY') _inferMonthDayFromDue()
      if (cfreq === 'YEARLY')  _inferYearMonthDayFromDue()
    }
  })
  el('modal-custom-freq').addEventListener('change', () => {
    _syncCustomSubRows()
    _hideRecurPreview()
    const cfreq = el('modal-custom-freq').value
    if (cfreq === 'WEEKLY' && _recurDays.size === 0) _inferDayFromDue()
    if (cfreq === 'MONTHLY') _inferMonthDayFromDue()
    if (cfreq === 'YEARLY')  _inferYearMonthDayFromDue()
  })
  document.querySelectorAll('#modal-recur-days-row .crp-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = btn.dataset.rday
      if (_recurDays.has(day)) { _recurDays.delete(day); btn.classList.remove('active') }
      else                     { _recurDays.add(day);    btn.classList.add('active') }
    })
  })

  el('modal-recur-preview-btn').addEventListener('click', () => {
    const popover = document.getElementById('recur-preview-popover')
    if (!popover.hidden) { _hideRecurPreview() }
    else                 { _showRecurPreview(el('modal-recur-preview-btn')) }
  })
  document.getElementById('recur-preview-popover-close').addEventListener('click', _hideRecurPreview)
  document.addEventListener('mousedown', e => {
    const popover = document.getElementById('recur-preview-popover')
    if (!popover.hidden
        && !popover.contains(e.target)
        && e.target !== el('modal-recur-preview-btn')) {
      _hideRecurPreview()
    }
  })

  el('task-modal').addEventListener('click', e => { if (e.target === el('task-modal')) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('task-modal').hidden) close() })

  // ── Task delete scope picker ───────────────────────────────────────────────
  el('task-delete-scope-cancel').addEventListener('click', () => { el('task-delete-scope-modal').hidden = true })
  el('task-delete-scope-ok').addEventListener('click', async () => {
    const scope = document.querySelector('input[name="task-delete-scope"]:checked')?.value ?? 'this'
    el('task-delete-scope-modal').hidden = true
    await _executeDeleteRecur(scope)
  })

  // ── Notes URL preview ──────────────────────────────────────────────────────
  _notesPreview = document.createElement('div')
  _notesPreview.className = 'notes-preview'
  _notesPreview.hidden    = true
  el('modal-notes').closest('.modal-field').after(_notesPreview)

  el('modal-notes').addEventListener('input', _refreshNotesPreview)
  el('modal-notes').addEventListener('focus', () => { if (_notesPreview) _notesPreview.hidden = true })
  el('modal-notes').addEventListener('blur',  _refreshNotesPreview)
}

export function openModal(item, taskLists, callbacks) {
  _item      = item
  _listId    = item.source.account_id
  _taskLists = taskLists
  _checklist = (item.metadata?.checklist ?? []).map(i => ({ ...i }))
  _comments  = (item.metadata?.comments  ?? []).map(c => ({ ...c }))
  _callbacks = callbacks
  populate()
  show()
}

export function openCreateModal(listId, taskLists, callbacks, opts = {}) {
  _item       = null
  _listId     = listId
  _taskLists  = taskLists
  _checklist  = []
  _comments   = []
  _callbacks  = callbacks
  _defaultDue = opts.due ?? null
  populate()
  show()
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id) }
function show()  { el('task-modal').hidden = false; el('modal-title').focus() }
function close() { el('task-modal').hidden = true; _hideRecurPreview() }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ── Populate ──────────────────────────────────────────────────────────────────

function populate() {
  const isEdit = !!_item

  el('modal-title').value = _item?.title ?? ''

  el('modal-list').innerHTML = _taskLists
    .map(l => `<option value="${esc(l.id)}"${l.id === _listId ? ' selected' : ''}>${esc(l.title)}</option>`)
    .join('')

  // Due date → yyyy-mm-dd for the date input
  el('modal-due').value = _item?.due
    ? new Date(_item.due).toLocaleDateString('en-CA')
    : (_defaultDue ?? '')

  el('modal-loe').value     = _item?.metadata?.loe ?? ''
  el('modal-loe-error').hidden = true
  el('modal-notes').value   = _item?.metadata?.body ?? ''
  _refreshNotesPreview()

  // Recurrence
  _recurDays = new Set()
  const rrule = _item?.metadata?.recurrence ?? null
  if (rrule) {
    const freq     = rrule.match(/FREQ=(\w+)/)?.[1]
    const interval = parseInt(rrule.match(/INTERVAL=(\d+)/)?.[1] ?? '1', 10)
    const byday    = rrule.match(/BYDAY=([^;]+)/)?.[1]?.split(',') ?? []
    const bymonth  = parseInt(rrule.match(/BYMONTH=(\d+)/)?.[1] ?? '0', 10)
    const untilM   = rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/)
    el('modal-recur-until').value = untilM ? `${untilM[1]}-${untilM[2]}-${untilM[3]}` : ''

    // Determine if this is a custom recurrence (doesn't map to a simple dropdown option)
    const useCustom =
      (freq === 'DAILY'   && interval > 1) ||
      (freq === 'WEEKLY'  && interval > 2) ||
      (freq === 'MONTHLY' && interval > 1) ||
      (freq === 'YEARLY'  && (interval > 1 || bymonth > 0))

    if (useCustom) {
      el('modal-recur').value = 'CUSTOM'
      el('modal-custom-interval').value = interval
      const freqMap = { DAILY:'DAILY', WEEKLY:'WEEKLY', MONTHLY:'MONTHLY', YEARLY:'YEARLY' }
      el('modal-custom-freq').value = freqMap[freq] ?? 'YEARLY'
      if (freq === 'YEARLY') {
        el('modal-custom-month').value   = bymonth || 7
        el('modal-custom-yearday').value = parseInt(rrule.match(/BYMONTHDAY=(\d+)/)?.[1] ?? '1', 10)
      } else if (freq === 'MONTHLY') {
        el('modal-custom-monthday').value = parseInt(rrule.match(/BYMONTHDAY=(\d+)/)?.[1] ?? '1', 10)
      } else if (freq === 'WEEKLY') {
        byday.forEach(d => _recurDays.add(_SHORT_TO_LONG[d] ?? d))
      }
    } else {
      if      (freq === 'DAILY')                    el('modal-recur').value = 'DAILY'
      else if (freq === 'YEARLY')                   el('modal-recur').value = 'ANNUALLY'
      else if (freq === 'MONTHLY')                  el('modal-recur').value = 'MONTHLY'
      else if (freq === 'WEEKLY' && interval === 2) el('modal-recur').value = 'BIWEEKLY'
      else if (freq === 'WEEKLY')                   el('modal-recur').value = 'WEEKLY'
      else                                          el('modal-recur').value = ''
      byday.forEach(d => _recurDays.add(_SHORT_TO_LONG[d] ?? d))
    }
  } else {
    el('modal-recur').value       = ''
    el('modal-recur-until').value = ''
  }
  const curFreq  = el('modal-recur').value
  const isCustom = curFreq === 'CUSTOM'
  el('modal-custom-interval-row').hidden    = !isCustom
  el('modal-recur-until-row').hidden        = !curFreq
  el('modal-recur-preview-wrap').hidden = !curFreq
  _hideRecurPreview()
  if (isCustom) {
    _syncCustomSubRows()
  } else {
    el('modal-recur-days-row').hidden      = curFreq !== 'WEEKLY' && curFreq !== 'BIWEEKLY'
    el('modal-custom-monthday-row').hidden  = true
    el('modal-custom-yearmonth-row').hidden = true
  }
  _syncDayBtns()

  el('modal-checklist-input').value = ''
  el('modal-comment-input').value   = ''

  renderChecklist()
  renderComments()

  // Auto-open details sections if they have content
  el('modal-checklist-section').open = _checklist.length > 0
  el('modal-comments-section').open  = _comments.length  > 0

  el('modal-delete').hidden          = !isEdit
  el('modal-toggle-complete').hidden = !isEdit
  if (isEdit) {
    const isDone = _item.status === 'COMPLETED'
    el('modal-toggle-complete').textContent = isDone ? 'Mark incomplete' : 'Mark complete'
  }
}

// ── Checklist ─────────────────────────────────────────────────────────────────

function renderChecklist() {
  const container = el('modal-checklist-items')
  container.innerHTML = ''

  _checklist.forEach((ci, idx) => {
    const row = document.createElement('div')
    row.className = 'modal-cl-row'

    const cb = document.createElement('input')
    cb.type    = 'checkbox'
    cb.checked = ci.checked
    cb.addEventListener('change', () => { _checklist[idx].checked = cb.checked })

    const txt = document.createElement('input')
    txt.type      = 'text'
    txt.className = 'modal-cl-text'
    txt.value     = ci.text
    txt.addEventListener('input', () => { _checklist[idx].text = txt.value })

    const del = document.createElement('button')
    del.className   = 'modal-row-del'
    del.textContent = '×'
    del.addEventListener('click', () => { _checklist.splice(idx, 1); renderChecklist() })

    row.append(cb, txt, del)
    container.appendChild(row)
  })

  const count = _checklist.length
  el('modal-checklist-count').textContent = count ? `(${count})` : ''
}

function addChecklistItem() {
  const inp  = el('modal-checklist-input')
  const text = inp.value.trim()
  if (!text) return
  _checklist.push({ text, checked: false })
  inp.value = ''
  renderChecklist()
  el('modal-checklist-section').open = true
}

// ── Comments ──────────────────────────────────────────────────────────────────

function renderComments() {
  const container = el('modal-comments-items')
  container.innerHTML = ''

  const sorted = [..._comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  sorted.forEach(c => {
    const row = document.createElement('div')
    row.className = 'modal-comment-row'

    const ts = document.createElement('span')
    ts.className   = 'modal-comment-ts'
    ts.textContent = displayTimestamp(c.timestamp)

    const txt = document.createElement('input')
    txt.type      = 'text'
    txt.className = 'modal-comment-text'
    txt.value     = c.text
    txt.addEventListener('input', () => {
      const orig = _comments.find(x => x.timestamp === c.timestamp)
      if (orig) orig.text = txt.value
    })

    const del = document.createElement('button')
    del.className   = 'modal-row-del'
    del.textContent = '×'
    del.addEventListener('click', () => {
      _comments = _comments.filter(x => x.timestamp !== c.timestamp)
      renderComments()
    })

    row.append(ts, txt, del)
    container.appendChild(row)
  })

  const count = _comments.length
  el('modal-comments-count').textContent = count ? `(${count})` : ''
}

function addComment() {
  const inp  = el('modal-comment-input')
  const text = inp.value.trim()
  if (!text) return
  _comments.push({ timestamp: nowTimestamp(), text })
  inp.value = ''
  renderComments()
  el('modal-comments-section').open = true
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function save() {
  const title = el('modal-title').value.trim()
  if (!title) { el('modal-title').focus(); return }

  const rawLoe = el('modal-loe').value.trim()
  const loe    = rawLoe ? normalizeLoe(rawLoe) : null
  if (rawLoe && !loe) {
    el('modal-loe-error').hidden = false
    el('modal-loe').focus()
    return
  }

  const dueStr = el('modal-due').value              // 'yyyy-mm-dd' or ''
  const due    = dueStr ? `${dueStr}T00:00:00.000Z` : null

  // Build recurrence RRULE from the UI state (shared with preview)
  const recurrence = _buildCurrentRecurrence()

  // Kid: use existing (from loaded item) or generate new one for create mode
  const kid = _item?.metadata?.kid ?? generateKid()

  const notes = serializeNotes({
    body:      el('modal-notes').value.trim(),
    recurrence,
    checklist: _checklist,
    kid,
  })

  const token = await getToken()
  if (!token) return

  // Write loe/comments to Drive — authoritative store for these fields
  updateTaskMeta(kid, { loe, comments: _comments })

  const selectedListId = el('modal-list').value

  try {
    if (!_item) {
      // Create new task
      await createTask(token, selectedListId, { title, notes, due })
    } else if (selectedListId !== _listId) {
      // Move to different list (with updated content)
      await moveTask(token, _listId, _item.source.external_id, selectedListId, { title, notes, due })
    } else {
      // Update in place
      await patchTask(token, _listId, _item.source.external_id, { title, notes, due })
    }
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Save failed:', err)
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function doDelete() {
  if (!_item) return

  if (_item.metadata?.recurrence) {
    // Reset radio to default and show scope picker
    const radio = document.querySelector('input[name="task-delete-scope"][value="this"]')
    if (radio) radio.checked = true
    el('task-delete-scope-modal').hidden = false
    return
  }

  if (!confirm(`Delete "${_item.title}"?`)) return
  const token = await getToken()
  if (!token) return
  try {
    await deleteTask(token, _listId, _item.source.external_id)
    close()
    _callbacks.onDeleted?.()
  } catch (err) {
    console.error('Delete failed:', err)
  }
}

async function _executeDeleteRecur(scope) {
  if (!_item) return
  const token = await getToken()
  if (!token) return
  try {
    if (scope === 'this') {
      // Spawn next so the series continues, then delete this instance
      await spawnNextRecurrence(token, _item, _listId)
    }
    // scope === 'following': delete without spawning — series ends here
    await deleteTask(token, _listId, _item.source.external_id)
    close()
    _callbacks.onDeleted?.()
  } catch (err) {
    console.error('Delete recurring failed:', err)
  }
}

// ── Toggle complete ───────────────────────────────────────────────────────────

async function toggleComplete() {
  if (!_item) return
  const token = await getToken()
  if (!token) return
  const isDone = _item.status === 'COMPLETED'

  try {
    if (isDone) {
      await uncompleteTask(token, _listId, _item.source.external_id)
    } else {
      if (_item.metadata?.recurrence) await spawnNextRecurrence(token, _item, _listId)
      await completeTask(token, _listId, _item.source.external_id)
    }
    close()
    _callbacks.onToggleDone?.()
  } catch (err) {
    console.error('Toggle complete failed:', err)
  }
}
