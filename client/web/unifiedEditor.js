import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'

import { getToken } from './auth.js'
import { createEvent, updateEvent, getEvent, deleteEvent, moveEvent, getCalendars } from './providers/googleCalendar.js'
import {
  createTask, updateTask, deleteTask, moveTask,
  completeTask, uncompleteTask,
} from './providers/calendarTasks.js'
import { normalizeLoe, nowTimestamp, displayTimestamp } from './providers/parsers.js'
import { generateKairosId } from './providers/driveTaskMeta.js'
import { getListsForCalendar } from './providers/kairosLists.js'
import { getStatusesForCalendar } from './providers/kairosStatuses.js'
import { getTaskCalendars } from './providers/kairosPrefs.js'
import { getItemLog, appendLogEntry, updateLogEntry, deleteLogEntry } from './providers/lifeLog.js'
import { openSnoozePopover } from './board.js'

// ── Module state ──────────────────────────────────────────────────────────────

let _mode          = 'event'   // 'event' | 'task'
let _editItem      = null      // null = create mode
let _callbacks     = {}
let _kairosId           = null   // task mode: stable ID (null until first save)
let _originalCalendarId = null   // calendar ID at open time, for move detection
let _endDateExplicit    = false  // true once user has manually changed end date
let _preserveRrule      = null
let _pendingBody   = null      // pending save body while scope modal is open
let _pendingAction = null      // 'delete' | null
let _locLink       = null      // ↗ link next to location field
let _webhookToken  = null      // cached after first fetch (task mode)

// Tiptap
let _editor  = null
let _rawMode = false
let _rawBtn  = null

// Comments / activity log
let _comments           = []
let _originalTimestamps = new Set()

// Custom recurrence state
let _crpFreq = 'WEEKLY', _crpInterval = 1, _crpByDay = new Set()
let _crpEndType = 'never', _crpEndDate = '', _crpEndCount = 10

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id) }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _toDate(d) {
  if (!d) return null
  if (typeof d === 'string') return new Date(d)
  return d instanceof Date ? d : new Date(d)
}

function _fmtDate(d) {
  if (!d) return ''
  const dt = _toDate(d)
  return isNaN(dt) ? '' : dt.toLocaleDateString('en-CA')
}

function _fmtTime(d) {
  if (!d) return ''
  const dt = _toDate(d)
  return isNaN(dt) ? '' : `${String(dt.getHours()).padStart(2,'0')}:${String(dt.getMinutes()).padStart(2,'0')}`
}

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
function minutesToTime(n) { return `${String(Math.floor(n/60)%24).padStart(2,'0')}:${String(n%60).padStart(2,'0')}` }

function _setAllDayUI(allDay) {
  const panel = el('unified-editor-panel')
  panel.classList.toggle('all-day', allDay)
  // multiday class only meaningful in all-day mode; timed always shows both rows
  panel.classList.toggle('multiday', allDay && _endDateExplicit)
}

// ── Description helpers ───────────────────────────────────────────────────────

function _textToHtml(text) {
  if (!text?.trim()) return ''
  if (/<[a-z][\s\S]*>/i.test(text.trim())) return text
  return text.trim().split(/\n\n+/)
    .map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`)
    .join('')
}

function _stripSnapshot(html) {
  if (!html) return ''
  return html.replace(/<div[^>]*data-kairos="snapshot"[^>]*>[\s\S]*?<\/div>/gi, '').trim()
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

const TOOLBAR_BTNS = [
  { name: 'bold',       label: 'B', title: 'Bold',          cmd: e => e.chain().focus().toggleBold().run() },
  { name: 'italic',     label: 'I', title: 'Italic',        cmd: e => e.chain().focus().toggleItalic().run() },
  { name: 'strike',     label: 'S', title: 'Strikethrough', cmd: e => e.chain().focus().toggleStrike().run() },
  null,
  { name: 'bulletList', label: '≡', title: 'Bullet list',   cmd: e => e.chain().focus().toggleBulletList().run() },
  { name: 'taskList',   label: '☑', title: 'Checklist',     cmd: e => e.chain().focus().toggleTaskList().run() },
]

function _buildToolbar() {
  const toolbar = el('ue-toolbar')
  const group   = document.createElement('div')
  group.className = 'editor-btn-group'
  for (const item of TOOLBAR_BTNS) {
    if (!item) {
      const sep = document.createElement('span')
      sep.className = 'editor-btn-sep'
      group.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'editor-btn'
    btn.dataset.tipName = item.name
    btn.textContent = item.label
    btn.title = item.title
    btn.addEventListener('mousedown', e => { e.preventDefault(); item.cmd(_editor) })
    group.appendChild(btn)
  }
  toolbar.appendChild(group)

  _rawBtn = document.createElement('button')
  _rawBtn.type = 'button'
  _rawBtn.className = 'editor-mode-btn'
  _rawBtn.title = 'Toggle raw HTML'
  _rawBtn.textContent = 'Raw'
  _rawBtn.addEventListener('click', _toggleRaw)
  toolbar.appendChild(_rawBtn)
}

function _updateToolbar() {
  if (!_editor) return
  for (const btn of el('ue-toolbar').querySelectorAll('.editor-btn[data-tip-name]')) {
    btn.classList.toggle('is-active', _editor.isActive(btn.dataset.tipName))
  }
}

function _toggleRaw() { _rawMode ? _switchToRich() : _switchToRaw() }

function _switchToRaw() {
  if (_rawMode) return
  _rawMode = true
  el('ue-raw').value    = _editor ? _editor.getHTML() : ''
  el('ue-content').hidden = true
  el('ue-raw').hidden   = false
  if (_rawBtn) _rawBtn.textContent = 'Rich'
}

function _switchToRich() {
  if (!_rawMode) return
  _rawMode = false
  const html = el('ue-raw').value
  if (_editor) _editor.commands.setContent(html, false)
  el('ue-raw').hidden   = true
  el('ue-content').hidden = false
  if (_rawBtn) _rawBtn.textContent = 'Raw'
}

function _getHtml() {
  if (_rawMode) return el('ue-raw').value.trim()
  if (!_editor) return ''
  const html = _editor.getHTML()
  return html === '<p></p>' ? '' : html
}

// ── Activity log / comments ───────────────────────────────────────────────────

function _toDatetimeLocal(isoStr) {
  if (!isoStr) return ''
  const d   = new Date(isoStr)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

let _activityFilter = 'comments'  // 'all' | 'comments'

function _renderComments() {
  const container = el('ue-activity-items')
  container.innerHTML = ''
  const sorted = [..._comments]
    .filter(c => _activityFilter === 'comments' ? !c._readonly : true)
    .sort((a, b) =>
      (a.event_date ?? a.timestamp).localeCompare(b.event_date ?? b.timestamp)
    )
  sorted.forEach(c => {
    const row = document.createElement('div')
    row.className = 'modal-comment-row' + (c._readonly ? ' modal-comment-readonly' : '')

    const del = document.createElement('button')
    del.className   = 'modal-row-del'
    del.textContent = '×'
    del.addEventListener('click', async () => {
      _comments = _comments.filter(x => x !== c)
      _renderComments()
      if (c._id && _editItem) {
        const token = await getToken()
        if (token) await deleteLogEntry(token, _editItem.id, c._id)
      }
    })

    if (c._readonly) {
      const ts = document.createElement('span')
      ts.className   = 'modal-comment-ts'
      ts.textContent = displayTimestamp(c.event_date ?? c.timestamp)
      const txt = document.createElement('span')
      txt.className   = 'modal-comment-text'
      txt.textContent = c.text
      txt.title       = c.text
      row.append(ts, txt, del)
    } else {
      // Timestamp: display span (formatted) swaps to datetime-local input on click, back on blur
      const tsWrap    = document.createElement('span')
      tsWrap.className = 'modal-comment-ts'

      const tsDisplay = document.createElement('span')
      tsDisplay.className   = 'modal-comment-ts-display'
      tsDisplay.textContent = displayTimestamp(c.event_date ?? c.timestamp)
      tsDisplay.title       = 'Click to edit date/time'

      const tsInput = document.createElement('input')
      tsInput.type      = 'datetime-local'
      tsInput.className = 'modal-comment-ts-input'
      tsInput.value     = _toDatetimeLocal(c.event_date ?? c.timestamp)
      tsInput.hidden    = true

      tsDisplay.addEventListener('click', () => {
        tsDisplay.hidden = true
        tsInput.hidden   = false
        tsInput.focus()
      })
      tsInput.addEventListener('blur', async () => {
        tsDisplay.hidden = false
        tsInput.hidden   = true
        if (!tsInput.value || !c._id || !_editItem) return
        const newDate = new Date(tsInput.value).toISOString()
        if (newDate === (c.event_date ?? c.timestamp)) return
        c.event_date          = newDate
        tsDisplay.textContent = displayTimestamp(newDate)
        const token = await getToken()
        if (token) updateLogEntry(token, _editItem.id, c._id, { event_date: newDate })
      })
      tsWrap.append(tsDisplay, tsInput)

      const txt = document.createElement('input')
      txt.type      = 'text'
      txt.className = 'modal-comment-text'
      txt.value     = c.text
      txt.addEventListener('input', () => { c.text = txt.value })
      txt.addEventListener('blur', async () => {
        if (!c._id || !_editItem) return
        const newText = txt.value.trim()
        if (!newText || newText === c.text) return
        c.text = newText
        const token = await getToken()
        if (token) updateLogEntry(token, _editItem.id, c._id, {
          narrative:     newText,
          action_detail: { verb: 'comment', text: newText },
        })
      })
      row.append(tsWrap, txt, del)
    }
    container.appendChild(row)
  })
  const total = _comments.length
  const shown = sorted.length
  el('ue-activity-count').textContent = total ? (shown < total ? `(${shown}/${total})` : `(${total})`) : ''
}

async function _addComment() {
  const inp  = el('ue-comment-input')
  const text = inp.value.trim()
  if (!text || !_editItem) return
  const ts     = nowTimestamp()
  const itemId = _editItem.id   // capture before awaits in case modal closes
  const c  = { _id: null, timestamp: ts, event_date: ts, text }
  _comments.push(c)
  inp.value = ''
  _renderComments()
  el('ue-activity-section').open = true

  _originalTimestamps.add(ts)
  const token = await getToken()
  if (!token) return
  c._id = await appendLogEntry(token, {
    item_id:       itemId,
    kairosId:      _editItem?.metadata?.kairosId ?? undefined,
    item_type:     _mode === 'task' ? 'TASK' : 'EVENT',
    title:         _editItem?.title ?? '',
    verb:          'comment',
    action_detail: { verb: 'comment', text: c.text },
    narrative:     c.text,
    context:       '',
  })
  // Race condition: if the comment was deleted while appendLogEntry was writing,
  // c._id was null so deleteLogEntry was never called — clean up now.
  if (c._id && !_comments.includes(c)) {
    const tk = await getToken()
    if (tk) deleteLogEntry(tk, itemId, c._id)
  }
}

async function _logNewComments(token, itemId, title) {
  const newComments = _comments.filter(c => !c._readonly && !_originalTimestamps.has(c.timestamp))
  const kairosId = _editItem?.metadata?.kairosId ?? undefined
  for (const c of newComments) {
    appendLogEntry(token, {
      item_id:       itemId,
      kairosId,
      item_type:     _mode === 'task' ? 'TASK' : 'EVENT',
      title,
      verb:          'comment',
      action_detail: { verb: 'comment', text: c.text },
      narrative:     c.text,
      context:       '',
    })
    _originalTimestamps.add(c.timestamp)
  }
}

// ── Recurrence helpers ────────────────────────────────────────────────────────

const DAY_SHORT = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function _matchPreset(rrule) {
  if (!rrule) return ''
  if (rrule === 'RRULE:FREQ=DAILY')   return 'DAILY'
  if (rrule === 'RRULE:FREQ=MONTHLY') return 'MONTHLY'
  if (rrule === 'RRULE:FREQ=YEARLY')  return 'ANNUALLY'
  if (/RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR/.test(rrule)) return 'WEEKDAYS'
  if (/RRULE:FREQ=WEEKLY/.test(rrule)) return 'WEEKLY'
  return 'CUSTOM'
}

function _buildRrule(freq, startDate) {
  if (!freq || freq === 'CUSTOM') return null
  if (freq === 'DAILY')    return 'RRULE:FREQ=DAILY'
  if (freq === 'MONTHLY')  return 'RRULE:FREQ=MONTHLY'
  if (freq === 'ANNUALLY') return 'RRULE:FREQ=YEARLY'
  if (freq === 'WEEKDAYS') return 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  if (freq === 'WEEKLY') {
    // Anchor BYDAY to the start date; fall back to today so we never emit
    // BYDAY=undefined when no date is set (callers should validate first).
    const src = startDate || new Date().toLocaleDateString('en-CA')  // yyyy-mm-dd, local
    const d   = new Date(src + 'T00:00:00')
    return `RRULE:FREQ=WEEKLY;BYDAY=${DAY_SHORT[d.getDay()]}`
  }
  return null
}

function _buildCustomRrule() {
  let rule = `RRULE:FREQ=${_crpFreq}`
  if (_crpInterval > 1) rule += `;INTERVAL=${_crpInterval}`
  if (_crpFreq === 'WEEKLY' && _crpByDay.size > 0) rule += `;BYDAY=${[..._crpByDay].join(',')}`
  if (_crpEndType === 'date'  && _crpEndDate)  rule += `;UNTIL=${_crpEndDate.replace(/-/g,'')}T235959Z`
  if (_crpEndType === 'count' && _crpEndCount) rule += `;COUNT=${_crpEndCount}`
  return rule
}

function _initCustomRecur() {
  el('crp-freq').addEventListener('change', e => {
    _crpFreq = e.target.value
    el('crp-days-row').hidden = _crpFreq !== 'WEEKLY'
  })
  el('crp-interval').addEventListener('input', e => {
    _crpInterval = Math.max(1, parseInt(e.target.value, 10) || 1)
  })
  document.querySelectorAll('.crp-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = btn.dataset.day
      if (_crpByDay.has(day)) { _crpByDay.delete(day); btn.classList.remove('active') }
      else                    { _crpByDay.add(day);    btn.classList.add('active') }
    })
  })
  document.querySelectorAll('input[name="crp-end"]').forEach(radio => {
    radio.addEventListener('change', e => {
      _crpEndType = e.target.value
      el('crp-end-date').disabled  = _crpEndType !== 'date'
      el('crp-end-count').disabled = _crpEndType !== 'count'
    })
  })
  el('crp-end-date').addEventListener('input',  e => { _crpEndDate  = e.target.value })
  el('crp-end-count').addEventListener('input', e => { _crpEndCount = parseInt(e.target.value, 10) || 10 })
}

function _resetCustomRecur(startDateStr) {
  _crpFreq = 'WEEKLY'; _crpInterval = 1; _crpByDay = new Set()
  _crpEndType = 'never'; _crpEndDate = ''; _crpEndCount = 10
  el('crp-freq').value = 'WEEKLY'
  el('crp-interval').value = 1
  el('crp-days-row').hidden = false
  el('crp-end-date').value = ''; el('crp-end-date').disabled = true
  el('crp-end-count').value = 10; el('crp-end-count').disabled = true
  document.querySelector('input[name="crp-end"][value="never"]').checked = true
  document.querySelectorAll('.crp-day').forEach(b => b.classList.remove('active'))
  if (startDateStr) {
    const code = DAY_SHORT[new Date(startDateStr + 'T00:00:00').getDay()]
    _crpByDay.add(code)
    document.querySelector(`.crp-day[data-day="${code}"]`)?.classList.add('active')
  }
}

function _applyRruleToCustomPanel(rrule) {
  if (!rrule) return
  const params = {}
  rrule.replace(/^RRULE:/, '').split(';').forEach(part => {
    const [k, v] = part.split('=')
    if (k) params[k] = v ?? ''
  })

  const freq = params.FREQ ?? 'WEEKLY'
  _crpFreq = freq
  el('crp-freq').value = freq
  el('crp-days-row').hidden = freq !== 'WEEKLY'

  const interval = parseInt(params.INTERVAL ?? '1', 10) || 1
  _crpInterval = interval
  el('crp-interval').value = interval

  if (params.BYDAY) {
    _crpByDay = new Set(params.BYDAY.split(','))
    document.querySelectorAll('.crp-day').forEach(btn =>
      btn.classList.toggle('active', _crpByDay.has(btn.dataset.day))
    )
  }

  if (params.UNTIL) {
    const raw = params.UNTIL.replace(/T.*$/, '')
    _crpEndType  = 'date'
    _crpEndDate  = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    el('crp-end-date').value    = _crpEndDate
    el('crp-end-date').disabled = false
    document.querySelector('input[name="crp-end"][value="date"]').checked = true
  } else if (params.COUNT) {
    _crpEndType  = 'count'
    _crpEndCount = parseInt(params.COUNT, 10) || 10
    el('crp-end-count').value    = _crpEndCount
    el('crp-end-count').disabled = false
    document.querySelector('input[name="crp-end"][value="count"]').checked = true
  }
  // 'never' is already set by the preceding _resetCustomRecur call
}

// ── Mode toggle ───────────────────────────────────────────────────────────────

function _setMode(mode, { locked = false } = {}) {
  _mode = mode
  el('ue-mode-event').classList.toggle('active',   mode === 'event')
  el('ue-mode-task').classList.toggle('active',    mode === 'task')
  el('ue-mode-event').disabled = locked
  el('ue-mode-task').disabled  = locked
  el('ue-title').placeholder   = mode === 'task' ? 'Task title…' : 'Event title…'
  el('ue-list-row').hidden     = mode !== 'task'
  el('ue-status-row').hidden   = mode !== 'task'
  el('ue-loe-row').hidden      = mode !== 'task'
  el('ue-item-id').hidden      = !(mode === 'task' && _editItem)

  const isDone = _editItem?.status === 'COMPLETED'
  if (mode === 'task' && _editItem) {
    el('ue-complete').textContent = isDone ? 'Mark incomplete' : 'Mark complete'
    el('ue-complete').hidden      = false
    el('ue-complete').disabled    = false
    el('ue-snooze').hidden        = isDone
  } else {
    el('ue-complete').hidden = true
    el('ue-snooze').hidden   = true
  }
}

// ── Calendar dropdown ─────────────────────────────────────────────────────────

async function _populateCalendars(preferredId, preloaded) {
  const sel        = el('ue-calendar')
  const taskCalIds = new Set(getTaskCalendars())

  let cals = preloaded
  if (!cals) {
    sel.innerHTML = '<option value="">Loading…</option>'
    const token = await getToken()
    if (!token) return
    try {
      cals = await getCalendars(token)
    } catch {
      sel.innerHTML = '<option value="">Could not load calendars</option>'
      return
    }
  }

  const filtered = _mode === 'task'
    ? cals.filter(c => taskCalIds.has(c.id))
    : cals.filter(c => (c.accessRole === 'owner' || c.accessRole === 'writer') && !taskCalIds.has(c.id))

  sel.innerHTML = filtered
    .map(c => `<option value="${esc(c.id)}"${c.primary ? ' selected' : ''}>${esc(c.summary)}</option>`)
    .join('')
  if (preferredId) sel.value = preferredId

  // Populate list + status dropdowns after calendar is known (task mode only)
  if (_mode === 'task') {
    _populateList(_editItem?.metadata?.listId ?? null)
    _populateStatus(_editItem?.metadata?.statusId ?? null)
  }
}

function _populateList(preferredListId) {
  const calId = el('ue-calendar').value
  if (!calId) return
  const lists = getListsForCalendar(calId)
  const sel   = el('ue-list')
  sel.innerHTML = '<option value="">— No list —</option>'
    + lists.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')
  if (preferredListId) sel.value = preferredListId
}

function _populateStatus(preferredStatusId) {
  const calId = el('ue-calendar').value
  if (!calId) return
  const statuses = getStatusesForCalendar(calId)
  const sel      = el('ue-status')
  sel.innerHTML = '<option value="">— No status —</option>'
    + statuses.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')
  if (preferredStatusId) sel.value = preferredStatusId
}

// ── Webhook token (task mode) ─────────────────────────────────────────────────

async function _ensureWebhookToken() {
  if (_webhookToken) return _webhookToken
  try {
    const res = await fetch('/api/webhook-token', { credentials: 'include' })
    if (res.ok) _webhookToken = (await res.json()).token ?? null
  } catch {}
  return _webhookToken
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initEditor() {
  el('ue-close').addEventListener('click',  _close)
  el('ue-cancel').addEventListener('click', _close)
  el('ue-save').addEventListener('click',   _save)
  el('ue-delete').addEventListener('click', _confirmDelete)
  el('ue-complete').addEventListener('click', _toggleComplete)
  el('ue-snooze').addEventListener('click', () => {
    if (!_editItem) return
    openSnoozePopover(el('ue-snooze'), _editItem,
      () => { _close(); _callbacks.onSaved?.() },
      _handleSnooze,
    )
  })

  el('ue-mode-event').addEventListener('click', () => {
    if (_mode === 'event') return
    _setMode('event')
    _populateCalendars(null, null)
  })
  el('ue-mode-task').addEventListener('click', () => {
    if (_mode === 'task') return
    _setMode('task')
    _populateCalendars(getTaskCalendars()[0] ?? null, null)
  })

  el('ue-allday').addEventListener('change', () => _setAllDayUI(el('ue-allday').checked))

  el('ue-multiday-btn').addEventListener('click', () => {
    _endDateExplicit = true
    el('unified-editor-panel').classList.add('multiday')
  })
  el('ue-singleday-btn').addEventListener('click', () => {
    _endDateExplicit = false
    el('unified-editor-panel').classList.remove('multiday')
    el('ue-end-date').value = el('ue-start-date').value
  })

  // End date follows start date in create mode; clamps to start if dragged before it.
  el('ue-start-date').addEventListener('change', () => {
    const s = el('ue-start-date').value
    const e = el('ue-end-date').value
    if (!_endDateExplicit) {
      el('ue-end-date').value = s
    } else if (e < s) {
      el('ue-end-date').value = s
      _endDateExplicit = false
    }
  })
  el('ue-end-date').addEventListener('change', () => {
    _endDateExplicit = el('ue-end-date').value !== el('ue-start-date').value
  })
  el('ue-recur').addEventListener('change', e => {
    el('custom-recur-panel').hidden = e.target.value !== 'CUSTOM'
    _preserveRrule = null
  })
  el('ue-calendar').addEventListener('change', () => {
    if (_mode === 'task') { _populateList(); _populateStatus() }
  })

  // Location URL link
  _locLink = document.createElement('a')
  _locLink.className  = 'field-url-link'
  _locLink.target     = '_blank'
  _locLink.rel        = 'noopener noreferrer'
  _locLink.textContent = '↗'
  _locLink.hidden     = true
  el('ue-location').parentNode.appendChild(_locLink)
  el('ue-location').addEventListener('input', e => {
    const v = e.target.value.trim()
    _locLink.hidden = !/^https?:\/\//i.test(v)
    _locLink.href   = v
  })

  el('ue-comment-add').addEventListener('click', _addComment)
  el('ue-comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') _addComment() })

  el('ue-activity-filter').addEventListener('click', e => {
    const btn = e.target.closest('[data-filter]')
    if (!btn) return
    _activityFilter = btn.dataset.filter
    el('ue-activity-filter').querySelectorAll('[data-filter]').forEach(s => {
      s.classList.toggle('active', s.dataset.filter === _activityFilter)
    })
    _renderComments()
  })

  el('unified-editor').addEventListener('click', e => { if (e.target === el('unified-editor')) _close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('unified-editor').hidden) _close() })

  // Scope modal
  el('recur-scope-cancel')?.addEventListener('click', () => {
    el('recur-scope-modal').hidden = true
    _pendingBody = null; _pendingAction = null
    el('ue-save').disabled   = false
    el('ue-delete').disabled = false
  })
  el('recur-scope-ok')?.addEventListener('click', () =>
    _executeWithScope(document.querySelector('input[name="recur-scope"]:checked')?.value ?? 'this')
  )

  _initCustomRecur()

  _editor = new Editor({
    element: el('ue-content'),
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: false }),
      Placeholder.configure({ placeholder: 'Description…' }),
    ],
    content: '',
    editorProps: { attributes: { class: 'modal-editor-content' } },
  })
  _buildToolbar()
  _editor.on('transaction', _updateToolbar)

  // Pre-warm webhook token
  _ensureWebhookToken()
}

// Create mode — call with mode='event' or mode='task'.
export async function openEditor(opts = {}, callbacks = {}) {
  _editItem      = null
  _kairosId      = null
  _callbacks     = callbacks
  _preserveRrule = null
  _comments      = []
  _originalTimestamps = new Set()

  const mode   = opts.mode ?? 'event'
  const allDay = opts.allDay ?? true   // both modes default all-day; grid click passes allDay:false
  const today  = opts.date ?? new Date().toLocaleDateString('en-CA')
  _endDateExplicit = false

  _setMode(mode)
  _setAllDayUI(allDay)
  el('ue-allday').checked    = allDay
  el('ue-start-date').value  = today
  el('ue-end-date').value    = today
  el('ue-start-time').value  = opts.startTime ?? '09:00'
  el('ue-end-time').value    = opts.endTime ?? minutesToTime(timeToMinutes(opts.startTime ?? '09:00') + 30)
  el('ue-title').value       = ''
  el('ue-location').value    = ''
  el('ue-recur').value       = ''
  el('ue-loe').value         = ''
  el('ue-loe-error').hidden  = true
  el('ue-comment-input').value = ''
  el('custom-recur-panel').hidden = true
  if (_locLink) _locLink.hidden = true
  if (_editor) _editor.commands.setContent('', false)
  if (_rawMode) _switchToRich()

  el('ue-activity-section').hidden = true
  el('ue-delete').hidden       = true
  el('ue-complete').hidden     = true
  el('ue-snooze').hidden       = true
  el('ue-save').disabled       = false
  el('ue-save-error').hidden   = true

  _resetCustomRecur(today)
  await _populateCalendars(opts.calendarId ?? (mode === 'task' ? getTaskCalendars()[0] : null), opts.calendars ?? null)
  // List + status are populated (with blank option) inside _populateCalendars.
  // Caller can request a specific list/status via opts.listId / opts.statusId.
  if (mode === 'task' && opts.listId)   el('ue-list').value   = opts.listId
  if (mode === 'task' && opts.statusId) el('ue-status').value = opts.statusId

  el('unified-editor').hidden = false
  el('ue-title').focus()
}

// Edit mode — mode is derived from item.item_type (locked).
export async function openEditorForEdit(item, callbacks = {}) {
  _editItem      = item
  _callbacks     = callbacks
  _preserveRrule = null
  _pendingBody   = null
  _pendingAction = null

  // Treat as a task if: explicitly typed TASK, or sits on a designated task
  // calendar (events on task calendars are adopted into the task flow on save).
  const taskCalSet = new Set(getTaskCalendars())
  const isTask = item.item_type === 'TASK'
              || !!item.metadata?.task_calendar
              || taskCalSet.has(item.source.account_id)
  const mode   = isTask ? 'task' : 'event'
  _kairosId    = isTask ? (item.metadata?.kairosId ?? null) : null

  // Load activity log
  _comments = getItemLog(item.id, item.metadata?.kairosId).map(e => ({
    _id:        e._id,
    timestamp:  e.timestamp,
    event_date: e.event_date ?? e.timestamp,
    text:       e.verb === 'comment' ? (e.action_detail?.text ?? e.narrative) : e.narrative,
    _readonly:  e.verb !== 'comment',
  }))
  _originalTimestamps = new Set(_comments.map(c => c.timestamp))

  const allDay = item.all_day
  const start  = _toDate(item.start)
  const endRaw = item.end ? _toDate(item.end) : (start ? new Date(start.getTime() + 30 * 60_000) : null)
  const displayEnd = (allDay && endRaw) ? new Date(endRaw.getTime() - 86_400_000) : endRaw

  _originalCalendarId = item.source.account_id
  // Multi-day items have an end date the user set intentionally; single-day items
  // can have end track start if the user moves the date.
  _endDateExplicit = !!item.end && _fmtDate(item.start) !== _fmtDate(
    item.all_day && item.end ? new Date(new Date(item.end).getTime() - 86_400_000) : item.end
  )
  _setMode(mode, { locked: true })
  _setAllDayUI(allDay)
  el('ue-allday').checked    = allDay
  el('ue-title').value       = item.title
  el('ue-start-date').value  = _fmtDate(start)
  el('ue-end-date').value    = _fmtDate(displayEnd ?? start)
  el('ue-start-time').value  = _fmtTime(start)
  el('ue-end-time').value    = _fmtTime(endRaw ?? start)
  el('ue-location').value    = item.metadata?.location ?? ''
  el('ue-comment-input').value = ''
  el('ue-loe-error').hidden  = true

  if (isTask) {
    el('ue-loe').value = item.metadata?.loe ?? ''
    const extId = item.source.external_id ?? '—'
    const kid   = item.metadata?.kairosId  ?? '—'
    el('ue-item-id').textContent = `event: ${extId}  ·  kId: ${kid}`
    el('ue-item-id').hidden = false
  } else {
    el('ue-loe').value      = ''
    el('ue-item-id').hidden = true
  }

  // Description
  if (_editor) _editor.commands.setContent(_textToHtml(_stripSnapshot(item.metadata?.body ?? '')), false)
  if (_rawMode) _switchToRich()

  // Activity
  _renderComments()
  el('ue-activity-section').hidden = false
  el('ue-activity-section').open   = _comments.length > 0

  // Recurrence — for instances, fetch master to get the series rule
  const preset = _matchPreset(item.recurrence)
  el('ue-recur').value = preset
  el('custom-recur-panel').hidden = preset !== 'CUSTOM'
  _preserveRrule = preset === 'CUSTOM' ? item.recurrence : null
  _resetCustomRecur(_fmtDate(start))
  if (preset === 'CUSTOM' && item.recurrence) _applyRruleToCustomPanel(item.recurrence)

  el('ue-delete').hidden   = false
  el('ue-delete').disabled = false

  const token = await getToken()

  // Populate calendar dropdown with all calendars of the appropriate type,
  // pre-selecting the item's current calendar. Calendar is editable — changing
  // it and saving will move the item to the new calendar.
  await _populateCalendars(item.source.account_id)

  // List dropdown is populated (with blank option) via _populateCalendars → _populateList.
  // Nothing extra needed here — listId already passed as preferredListId.

  if (token && item.metadata?.recurringEventId) {
    const master = await getEvent(token, item.source.account_id, item.metadata.recurringEventId).catch(() => null)
    if (master?.recurrence?.[0]) {
      const rrule = master.recurrence[0]
      const mp = _matchPreset(rrule)
      el('ue-recur').value = mp
      el('custom-recur-panel').hidden = mp !== 'CUSTOM'
      _preserveRrule = mp === 'CUSTOM' ? rrule : null
      if (mp === 'CUSTOM') _applyRruleToCustomPanel(rrule)
    }
  }

  const locVal = (item.metadata?.location ?? '').trim()
  if (_locLink) {
    _locLink.hidden = !/^https?:\/\//i.test(locVal)
    _locLink.href   = locVal
  }

  el('unified-editor').hidden = false
  el('ue-title').focus()
}

// ── Close ─────────────────────────────────────────────────────────────────────

function _close() {
  el('unified-editor').hidden  = true
  el('ue-complete').hidden     = true
  el('ue-snooze').hidden       = true
  el('ue-save').disabled       = false
  el('ue-delete').disabled     = false
}

// ── Complete / Snooze (task mode) ─────────────────────────────────────────────

async function _toggleComplete() {
  if (!_editItem) return
  const token  = await getToken()
  if (!token) return
  const isDone = _editItem.status === 'COMPLETED'
  const calId  = _editItem.source.account_id
  const extId  = _editItem.source.external_id
  const verb   = isDone ? 'uncompleted' : 'completed'
  el('ue-complete').disabled = true
  try {
    const updated = isDone
      ? await uncompleteTask(token, calId, extId, _editItem.title, _editItem)
      : await completeTask(token, calId, extId, _editItem.title, _editItem)
    appendLogEntry(token, {
      item_id:       _editItem.id,
      kairosId:      _editItem.metadata?.kairosId ?? undefined,
      item_type:     'TASK',
      title:         _editItem.title,
      verb,
      action_detail: { verb },
      narrative:     isDone ? `Marked "${_editItem.title}" incomplete` : `Completed "${_editItem.title}"`,
    })
    _close()
    _callbacks.onCompleted?.(updated)
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Toggle complete failed:', err)
    el('ue-complete').disabled = false
  }
}

async function _handleSnooze(n, newDate) {
  if (!_editItem) return
  const token = await getToken()
  if (!token) return
  const calId  = _editItem.source.account_id
  const extId  = _editItem.source.external_id
  const pad    = v => String(v).padStart(2, '0')
  const newDateStr = `${newDate.getFullYear()}-${pad(newDate.getMonth()+1)}-${pad(newDate.getDate())}`

  const body = {}
  if (_editItem.all_day) {
    const endDate = new Date(newDate)
    endDate.setDate(endDate.getDate() + 1)
    body.start = { date: newDateStr }
    body.end   = { date: `${endDate.getFullYear()}-${pad(endDate.getMonth()+1)}-${pad(endDate.getDate())}` }
  } else {
    const origStart = new Date(_editItem.start)
    const origEnd   = _editItem.end ? new Date(_editItem.end) : null
    const newStart  = new Date(origStart); newStart.setDate(newStart.getDate() + n)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    body.start = { dateTime: newStart.toISOString(), timeZone: tz }
    if (origEnd) {
      const newEnd = new Date(origEnd); newEnd.setDate(newEnd.getDate() + n)
      body.end = { dateTime: newEnd.toISOString(), timeZone: tz }
    }
  }
  await updateEvent(token, calId, extId, body)
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function _save() {
  const title = el('ue-title').value.trim()
  if (!title) { el('ue-title').focus(); return }

  const saveBtn = el('ue-save')
  if (saveBtn.disabled) return
  saveBtn.disabled = true
  el('ue-save-error').hidden = true

  try {
    if (_mode === 'task') await _saveTask(title)
    else                  await _saveEvent(title)
  } catch (err) {
    console.error('Save failed:', err)
    el('ue-save-error').textContent = err.message || 'Save failed'
    el('ue-save-error').hidden = false
    saveBtn.disabled = false
  }
}

async function _saveTask(title) {
  const rawLoe = el('ue-loe').value.trim()
  const loe    = rawLoe ? normalizeLoe(rawLoe) : null
  if (rawLoe && !loe) {
    el('ue-loe-error').hidden = false
    el('ue-loe').focus()
    el('ue-save').disabled = false
    return
  }

  const calId     = el('ue-calendar').value
  if (!calId) { el('ue-save').disabled = false; return }
  const listId    = el('ue-list').value   || null
  const statusId  = el('ue-status').value || null
  const allDay    = el('ue-allday').checked
  const startDate = el('ue-start-date').value || null
  const endDate   = el('ue-end-date').value   || null
  const startTime = el('ue-start-time').value
  const endTime   = el('ue-end-time').value
  const location  = el('ue-location').value.trim() || null
  const body      = _getHtml()
  const kairosId  = _kairosId ?? generateKairosId()
  _kairosId       = kairosId
  const wt        = await _ensureWebhookToken()
  const freq      = el('ue-recur').value
  // recurrence=null → send recurrence:[] to CLEAR an existing rule; recurrence=undefined → omit entirely.
  // Only send [] when the item was originally recurring (master has a rule); for non-recurring tasks
  // and recurring instances (recurrence field is on master, not instance) omit it — Google rejects
  // recurrence:[] combined with a start format change (e.g. timed→all-day) with "Invalid start time."
  // A recurring task needs a start-date anchor — without one the series would be
  // pinned to the undated sentinel (1970). Require a date before repeating.
  if (freq && !startDate) {
    el('ue-save-error').textContent = 'Add a start date to make this task repeat.'
    el('ue-save-error').hidden = false
    el('ue-save').disabled = false
    return
  }

  const recurrence = freq === 'CUSTOM'
    ? undefined
    : freq
      ? (_buildRrule(freq, startDate) ?? null)
      : (_editItem?.recurrence ? null : undefined)

  const taskData = {
    title,
    body,
    kairosId,
    listId,
    statusId,
    order:        _editItem?.metadata?.order ?? Date.now(),
    loe,
    date:         startDate,
    noDate:       !startDate,
    allDay,
    startTime,
    endDate,
    endTime,
    timeZone:     Intl.DateTimeFormat().resolvedOptions().timeZone,
    location,
    webhookToken: wt,
    recurrence,
    completed:    _editItem?.status === 'COMPLETED',
    completedAt:  _editItem?.metadata?.completedAt ?? null,
  }

  const token = await getToken()
  if (!token) { el('ue-save').disabled = false; return }

  if (!_editItem) {
    await createTask(token, calId, taskData)
  } else {
    const extId   = _editItem.source.external_id
    const origCal = _originalCalendarId ?? _editItem.source.account_id
    if (_editItem.metadata?.recurringEventId) {
      _pendingBody = { _taskData: taskData, calId, origCal }
      document.querySelector('input[name="recur-scope"][value="this"]').checked = true
      el('recur-scope-modal').hidden = false
      return
    }
    if (calId !== origCal) await moveTask(token, origCal, extId, calId)
    await updateTask(token, calId, extId, taskData)
  }

  _close()
  _callbacks.onSaved?.()
}

async function _saveEvent(title) {
  const calId     = el('ue-calendar').value
  if (!calId) { el('ue-save').disabled = false; return }
  const allDay    = el('ue-allday').checked
  const startDate = el('ue-start-date').value
  const endDate   = el('ue-end-date').value || startDate
  const startTime = el('ue-start-time').value
  const endTime   = el('ue-end-time').value
  const freq      = el('ue-recur').value
  const location  = el('ue-location').value.trim()
  const html      = _getHtml()
  const tz        = Intl.DateTimeFormat().resolvedOptions().timeZone

  const body = {
    summary: title,
    ...(location && { location }),
    ...(html     && { description: html }),
  }

  if (allDay) {
    const endD = new Date((endDate <= startDate ? startDate : endDate) + 'T00:00:00')
    endD.setDate(endD.getDate() + 1)
    const pad = v => String(v).padStart(2, '0')
    body.start = { date: startDate }
    body.end   = { date: `${endD.getFullYear()}-${pad(endD.getMonth()+1)}-${pad(endD.getDate())}` }
  } else {
    body.start = { dateTime: `${startDate}T${startTime}:00`, timeZone: tz }
    body.end   = { dateTime: `${endDate}T${endTime}:00`,     timeZone: tz }
  }

  if (freq && !startDate) {
    el('ue-save-error').textContent = 'Add a start date to make this event repeat.'
    el('ue-save-error').hidden = false
    el('ue-save').disabled = false
    return
  }

  let rrule
  if (freq === 'CUSTOM') rrule = _preserveRrule ?? _buildCustomRrule()
  else                   rrule = _buildRrule(freq, startDate)
  if (rrule)
    body.recurrence = [rrule]
  else if (_editItem && !freq && _editItem.recurrence)
    body.recurrence = []   // only clear if item was originally recurring

  const token = await getToken()
  if (!token) { el('ue-save').disabled = false; return }

  if (_editItem?.metadata?.recurringEventId) {
    _pendingBody = body
    document.querySelector('input[name="recur-scope"][value="this"]').checked = true
    el('recur-scope-modal').hidden = false
    return
  }

  let savedId = _editItem?.source.external_id ?? null
  if (_editItem) {
    const origCal = _originalCalendarId ?? _editItem.source.account_id
    if (calId !== origCal) await moveEvent(token, origCal, _editItem.source.external_id, calId)
    await updateEvent(token, calId, _editItem.source.external_id, body)
  } else {
    const created = await createEvent(token, calId, body)
    savedId = created.id
  }
  _close()
  _callbacks.onSaved?.()
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function _confirmDelete() {
  el('ue-delete').disabled = true
  _pendingAction = 'delete'

  if (_editItem?.metadata?.recurringEventId) {
    el('recur-scope-title').textContent = 'Delete recurring event'
    document.querySelector('input[name="recur-scope"][value="this"]').checked = true
    el('recur-scope-modal').hidden = false
    return
  }

  const token = await getToken()
  if (!token) { el('ue-delete').disabled = false; _pendingAction = null; return }
  try {
    if (_mode === 'task') {
      await deleteTask(token, _editItem.source.account_id, _editItem.source.external_id)
    } else {
      await deleteEvent(token, _editItem.source.account_id, _editItem.source.external_id)
    }
    _close()
    _callbacks.onDeleted?.()
  } catch (err) {
    console.error('Delete failed:', err)
    el('ue-delete').disabled = false
  }
  _pendingAction = null
}

// ── Scope modal ───────────────────────────────────────────────────────────────

async function _executeWithScope(scope) {
  el('recur-scope-modal').hidden = true
  el('recur-scope-title').textContent = 'Edit recurring event'

  const action   = _pendingAction
  _pendingAction = null

  if (action === 'delete') {
    const token = await getToken()
    if (!token) { el('ue-delete').disabled = false; return }
    try {
      if (scope === 'all')            await _deleteAll(token)
      else if (scope === 'following') await _deleteFollowing(token)
      else {
        if (_mode === 'task') await deleteTask(token, _editItem.source.account_id, _editItem.source.external_id)
        else                  await deleteEvent(token, _editItem.source.account_id, _editItem.source.external_id)
      }
      _close()
      _callbacks.onDeleted?.()
    } catch (err) {
      console.error('Delete failed:', err)
      el('ue-delete').disabled = false
    }
    return
  }

  // Save
  const pending  = _pendingBody
  _pendingBody   = null
  const saveBtn  = el('ue-save')
  const token    = await getToken()
  if (!token || !pending) { saveBtn.disabled = false; return }

  try {
    if (_mode === 'task') {
      const { _taskData: td, calId } = pending
      const extId    = _editItem.source.external_id
      const masterId = _editItem.metadata.recurringEventId
      if (scope === 'all')            await _saveAllTask(token, calId, td)
      else if (scope === 'following') await _saveFollowingTask(token, calId, td)
      else                            await updateTask(token, calId, extId, { ...td, recurrence: undefined })
    } else {
      const calId   = _editItem.source.account_id
      const extId   = _editItem.source.external_id
      if (scope === 'all')            await _saveAll(token, pending)
      else if (scope === 'following') await _saveFollowing(token, pending)
      else                            await updateEvent(token, calId, extId, pending)
    }
    _close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Save failed:', err)
  } finally {
    saveBtn.disabled = false
  }
}

// ── Recurring save/delete helpers ─────────────────────────────────────────────

async function _saveAll(token, body) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurringEventId
  const master   = await getEvent(token, calId, masterId)
  const mb = {}
  if (body.summary)                    mb.summary     = body.summary
  if (body.location)                   mb.location    = body.location
  if (body.description !== undefined)  mb.description = body.description
  if (body.recurrence?.length)         mb.recurrence  = body.recurrence
  if (body.start?.dateTime && master.start?.dateTime) {
    const newTime  = body.start.dateTime.slice(11)
    const origDate = master.start.dateTime.slice(0, 11)
    mb.start = { dateTime: origDate + newTime, timeZone: body.start.timeZone }
    const newEndTime  = body.end.dateTime.slice(11)
    const origEndDate = master.end?.dateTime?.slice(0, 11) ?? origDate
    mb.end = { dateTime: origEndDate + newEndTime, timeZone: body.end.timeZone }
  }
  await updateEvent(token, calId, masterId, mb)
}

async function _saveFollowing(token, body) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurringEventId
  const master   = await getEvent(token, calId, masterId)
  const mrule    = master.recurrence?.[0]
  if (mrule) {
    const cutoff = new Date(_editItem.start)
    cutoff.setUTCDate(cutoff.getUTCDate() - 1)
    cutoff.setUTCHours(23, 59, 59, 0)
    const pad = v => String(v).padStart(2, '0')
    const until = `${cutoff.getUTCFullYear()}${pad(cutoff.getUTCMonth()+1)}${pad(cutoff.getUTCDate())}` +
                  `T${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}Z`
    await updateEvent(token, calId, masterId, { recurrence: [mrule.replace(/;?(UNTIL|COUNT)=[^;]*/g,'') + `;UNTIL=${until}`] })
  }
  if (!body.recurrence && mrule) body.recurrence = [mrule.replace(/;?(UNTIL|COUNT)=[^;]*/g,'')]
  await createEvent(token, calId, body)
}

async function _saveAllTask(token, calId, taskData) {
  const masterId   = _editItem.metadata.recurringEventId
  const master     = await getEvent(token, calId, masterId)
  // Use the master's start date so the series anchor is unchanged and BYDAY stays
  // consistent with the master's recurrence rule (instance date may differ on exceptions).
  const masterDate    = master.start?.date ?? master.start?.dateTime?.slice(0, 10)
  const isAllDay      = !!master.start?.date
  const masterTime    = master.start?.dateTime ? master.start.dateTime.slice(11, 16) : null
  const masterEndTime = master.end?.dateTime   ? master.end.dateTime.slice(11, 16)   : null
  // Rebuild RRULE using master's start date to keep BYDAY consistent
  const freq  = el('ue-recur').value
  const rrule = freq === 'CUSTOM' ? _preserveRrule
    : freq ? (_buildRrule(freq, masterDate) ?? null) : null
  const tdForMaster = {
    ...taskData,
    date:       masterDate,
    noDate:     !masterDate,
    allDay:     isAllDay,
    startTime:  masterTime    ?? taskData.startTime,
    endDate:    null,
    endTime:    masterEndTime ?? taskData.endTime,
    recurrence: rrule,
  }
  await updateTask(token, calId, masterId, tdForMaster)
}

async function _saveFollowingTask(token, calId, taskData) {
  // Cut the master series at the day before this instance, then create a new series.
  const masterId = _editItem.metadata.recurringEventId
  const master   = await getEvent(token, calId, masterId)
  const mrule    = master.recurrence?.[0]
  if (mrule) {
    const cutoff = new Date(_editItem.start)
    cutoff.setUTCDate(cutoff.getUTCDate() - 1)
    cutoff.setUTCHours(23, 59, 59, 0)
    const pad = v => String(v).padStart(2, '0')
    const until = `${cutoff.getUTCFullYear()}${pad(cutoff.getUTCMonth()+1)}${pad(cutoff.getUTCDate())}` +
                  `T${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}Z`
    await updateEvent(token, calId, masterId, { recurrence: [mrule.replace(/;?(UNTIL|COUNT)=[^;]*/g,'') + `;UNTIL=${until}`] })
  }
  await createTask(token, calId, { ...taskData, kairosId: generateKairosId() })
}

async function _deleteAll(token) {
  if (_mode === 'task') await deleteTask(token, _editItem.source.account_id, _editItem.metadata.recurringEventId)
  else                  await deleteEvent(token, _editItem.source.account_id, _editItem.metadata.recurringEventId)
}

async function _deleteFollowing(token) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurringEventId
  const master   = await getEvent(token, calId, masterId)
  const mrule    = master.recurrence?.[0]
  if (mrule) {
    const cutoff = new Date(_editItem.start)
    cutoff.setUTCDate(cutoff.getUTCDate() - 1)
    cutoff.setUTCHours(23, 59, 59, 0)
    const pad = v => String(v).padStart(2, '0')
    const until = `${cutoff.getUTCFullYear()}${pad(cutoff.getUTCMonth()+1)}${pad(cutoff.getUTCDate())}` +
                  `T${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}Z`
    await updateEvent(token, calId, masterId, { recurrence: [mrule.replace(/;?(UNTIL|COUNT)=[^;]*/g,'') + `;UNTIL=${until}`] })
  } else {
    if (_mode === 'task') await deleteTask(token, calId, _editItem.source.external_id)
    else                  await deleteEvent(token, calId, _editItem.source.external_id)
  }
}
