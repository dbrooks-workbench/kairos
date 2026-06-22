import { getToken } from './auth.js'
import { parseTaskNotes, serializeNotes, normalizeLoe, nowTimestamp, displayTimestamp, parseRecurSigil } from './providers/parsers.js'
import { createTask, patchTask, deleteTask, moveTask, completeTask, uncompleteTask, spawnNextRecurrence } from './providers/googleTasks.js'

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
    const freq = el('modal-recur').value
    el('modal-recur-days-row').hidden  = freq !== 'WEEKLY' && freq !== 'BIWEEKLY'
    el('modal-recur-until-row').hidden = !freq
    if (!freq) { el('modal-recur-until').value = ''; _recurDays = new Set(); _syncDayBtns() }
    // Auto-infer day from due date when switching to weekly and no days selected yet
    if ((freq === 'WEEKLY' || freq === 'BIWEEKLY') && _recurDays.size === 0) _inferDayFromDue()
  })
  document.querySelectorAll('#modal-recur-days-row .crp-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = btn.dataset.rday
      if (_recurDays.has(day)) { _recurDays.delete(day); btn.classList.remove('active') }
      else                     { _recurDays.add(day);    btn.classList.add('active') }
    })
  })

  el('task-modal').addEventListener('click', e => { if (e.target === el('task-modal')) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('task-modal').hidden) close() })

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
function close() { el('task-modal').hidden = true }

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
    const untilM   = rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/)
    if      (freq === 'DAILY')                   el('modal-recur').value = 'DAILY'
    else if (freq === 'YEARLY')                  el('modal-recur').value = 'ANNUALLY'
    else if (freq === 'MONTHLY')                 el('modal-recur').value = 'MONTHLY'
    else if (freq === 'WEEKLY' && interval === 2) el('modal-recur').value = 'BIWEEKLY'
    else if (freq === 'WEEKLY')                  el('modal-recur').value = 'WEEKLY'
    else                                         el('modal-recur').value = ''
    byday.forEach(d => _recurDays.add(_SHORT_TO_LONG[d] ?? d))
    el('modal-recur-until').value = untilM ? `${untilM[1]}-${untilM[2]}-${untilM[3]}` : ''
  } else {
    el('modal-recur').value       = ''
    el('modal-recur-until').value = ''
  }
  const curFreq = el('modal-recur').value
  el('modal-recur-days-row').hidden  = curFreq !== 'WEEKLY' && curFreq !== 'BIWEEKLY'
  el('modal-recur-until-row').hidden = !curFreq
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

  // Build recurrence RRULE from the UI selector + optional day picker + optional UNTIL
  const recurFreq  = el('modal-recur').value
  const recurUntil = el('modal-recur-until').value  // 'YYYY-MM-DD' or ''
  let recurrence = null
  if (recurFreq) {
    let sigil = `&${recurFreq}`
    if (recurFreq === 'WEEKLY' || recurFreq === 'BIWEEKLY') {
      // Auto-infer day from due date if no days were explicitly selected
      const days = _recurDays.size > 0 ? _recurDays : (() => {
        if (!dueStr) return new Set()
        return new Set([_DAY_LONG_NAMES[new Date(dueStr + 'T00:00:00').getDay()]])
      })()
      if (days.size > 0) sigil += ',' + [...days].join(',')
    } else if (recurFreq === 'MONTHLY' && dueStr) {
      sigil += ',' + new Date(dueStr + 'T00:00:00').getDate()
    }
    if (recurUntil) sigil += ` UNTIL ${recurUntil}`
    recurrence = parseRecurSigil(sigil)
  }

  const notes = serializeNotes({
    body:      el('modal-notes').value.trim(),
    loe,
    recurrence,
    checklist: _checklist,
    comments:  _comments,
  })

  const token = await getToken()
  if (!token) return

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
