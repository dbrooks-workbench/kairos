import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'

import { getToken } from './auth.js'
import { createEvent, updateEvent, getEvent, deleteEvent } from './providers/googleCalendar.js'
import { nowTimestamp, displayTimestamp } from './providers/parsers.js'
import { setCompleted, setUncompleted } from './providers/completionStore.js'
import { getItemLog, appendLogEntry, deleteLogEntry } from './providers/lifeLog.js'
import { openSnoozePopover } from './board.js'

// ── Module state ──────────────────────────────────────────────────────────────

let _callbacks     = {}
let _editItem      = null
let _preserveRrule = null
let _pendingBody   = null
let _pendingAction = null
let _locLink       = null

// Tiptap (HTML mode — Google Calendar stores HTML descriptions)
let _editorEvent  = null
let _evRawMode    = false
let _evRawBtn     = null

// Comments
let _evComments           = []
let _evOriginalTimestamps = new Set()

// ── Toolbar config ────────────────────────────────────────────────────────────

const EV_TOOLBAR = [
  { name: 'bold',       label: 'B', title: 'Bold',           cmd: e => e.chain().focus().toggleBold().run() },
  { name: 'italic',     label: 'I', title: 'Italic',         cmd: e => e.chain().focus().toggleItalic().run() },
  { name: 'strike',     label: 'S', title: 'Strikethrough',  cmd: e => e.chain().focus().toggleStrike().run() },
  null,
  { name: 'bulletList', label: '≡', title: 'Bullet list',    cmd: e => e.chain().focus().toggleBulletList().run() },
  { name: 'taskList',   label: '☑', title: 'Checklist',      cmd: e => e.chain().focus().toggleTaskList().run() },
]

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id) }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
function minutesToTime(n) { return `${String(Math.floor(n/60)%24).padStart(2,'0')}:${String(n%60).padStart(2,'0')}` }

function setAllDayUI(allDay) {
  el('event-modal-panel').classList.toggle('all-day', allDay)
}

// ── Description helpers ───────────────────────────────────────────────────────

// Convert plain text to HTML paragraphs for loading into the Tiptap editor.
// Existing Google Calendar HTML descriptions are passed through unchanged.
function _textToHtml(text) {
  if (!text?.trim()) return ''
  if (/<[a-z][\s\S]*>/i.test(text.trim())) return text
  return text.trim().split(/\n\n+/)
    .map(p => `<p>${p.trim().replace(/\n/g, '<br>')}</p>`)
    .join('')
}

// Strip the Kairos-written snapshot div from a description HTML string before
// loading into the editor. The snapshot is delimited by data-kairos="snapshot".
function _stripEvSnapshot(html) {
  if (!html) return ''
  return html.replace(/<div[^>]*data-kairos="snapshot"[^>]*>[\s\S]*?<\/div>/gi, '').trim()
}

// Build an HTML snapshot block for commitment events — appended to the
// description on save so other calendar clients see comment count.
// Returns '' when there are no comments (skip the block entirely).
function _buildEvSnapshotHtml(comments) {
  if (!comments?.length) return ''
  const count = comments.length
  const date  = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const text  = `${count} comment${count !== 1 ? 's' : ''} · Updated ${date}`
  return `<div data-kairos="snapshot" style="font-size:11px;color:#888;border-top:1px solid #ddd;margin-top:12px;padding-top:8px">${text}</div>`
}

function _evGetHtml() {
  if (_evRawMode) return el('event-modal-desc-raw').value.trim()
  if (!_editorEvent) return ''
  const html = _editorEvent.getHTML()
  return html === '<p></p>' ? '' : html
}

// ── Toolbar helpers ───────────────────────────────────────────────────────────

function _buildEvToolbar() {
  const toolbar = el('event-modal-editor-toolbar')

  const group = document.createElement('div')
  group.className = 'editor-btn-group'
  for (const item of EV_TOOLBAR) {
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
    btn.addEventListener('mousedown', e => { e.preventDefault(); item.cmd(_editorEvent) })
    group.appendChild(btn)
  }
  toolbar.appendChild(group)

  _evRawBtn = document.createElement('button')
  _evRawBtn.type = 'button'
  _evRawBtn.className = 'editor-mode-btn'
  _evRawBtn.title = 'Toggle raw HTML'
  _evRawBtn.textContent = 'Raw'
  _evRawBtn.addEventListener('click', _evToggleMode)
  toolbar.appendChild(_evRawBtn)
}

function _updateEvToolbar() {
  if (!_editorEvent) return
  for (const btn of el('event-modal-editor-toolbar').querySelectorAll('.editor-btn[data-tip-name]')) {
    btn.classList.toggle('is-active', _editorEvent.isActive(btn.dataset.tipName))
  }
}

function _evToggleMode() { _evRawMode ? _evSwitchToRich() : _evSwitchToRaw() }

function _evSwitchToRaw() {
  if (_evRawMode) return
  _evRawMode = true
  el('event-modal-desc-raw').value = _editorEvent ? _editorEvent.getHTML() : ''
  el('event-modal-editor').hidden    = true
  el('event-modal-desc-raw').hidden  = false
  if (_evRawBtn) _evRawBtn.textContent = 'Rich'
}

function _evSwitchToRich() {
  if (!_evRawMode) return
  _evRawMode = false
  const html = el('event-modal-desc-raw').value
  if (_editorEvent) _editorEvent.commands.setContent(html, false)
  el('event-modal-desc-raw').hidden = true
  el('event-modal-editor').hidden   = false
  if (_evRawBtn) _evRawBtn.textContent = 'Raw'
}

// ── Comments helpers ──────────────────────────────────────────────────────────

function _renderEventComments() {
  const container = el('event-modal-comments-items')
  container.innerHTML = ''
  const sorted = [..._evComments].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  sorted.forEach(c => {
    const row = document.createElement('div')
    row.className = 'modal-comment-row' + (c._readonly ? ' modal-comment-readonly' : '')

    const ts = document.createElement('span')
    ts.className   = 'modal-comment-ts'
    ts.textContent = displayTimestamp(c.timestamp)

    const del = document.createElement('button')
    del.className   = 'modal-row-del'
    del.textContent = '×'
    del.addEventListener('click', async () => {
      _evComments = _evComments.filter(x => x !== c)
      _renderEventComments()
      if (c._id && _editItem) {
        const token = await getToken()
        if (token) deleteLogEntry(token, _editItem.id, c._id)
      }
    })

    if (c._readonly) {
      const txt = document.createElement('span')
      txt.className   = 'modal-comment-text'
      txt.textContent = c.text
      row.append(ts, txt, del)
    } else {
      const txt = document.createElement('input')
      txt.type      = 'text'
      txt.className = 'modal-comment-text'
      txt.value     = c.text
      txt.addEventListener('input', () => {
        const orig = _evComments.find(x => x === c)
        if (orig) orig.text = txt.value
      })
      row.append(ts, txt, del)
    }
    container.appendChild(row)
  })
  el('event-modal-comments-count').textContent = _evComments.length ? `(${_evComments.length})` : ''
}

function _addEventComment() {
  const inp  = el('event-modal-comment-input')
  const text = inp.value.trim()
  if (!text) return
  _evComments.push({ _id: null, timestamp: nowTimestamp(), text })
  inp.value = ''
  _renderEventComments()
  el('event-modal-comments-section').open = true
}

async function _logNewEvComments(token, itemId, title) {
  const newComments = _evComments.filter(c => !c._readonly && !_evOriginalTimestamps.has(c.timestamp))
  for (const c of newComments) {
    appendLogEntry(token, {
      item_id:       itemId,
      item_type:     'EVENT',
      title,
      verb:          'comment',
      action_detail: { verb: 'comment', text: c.text },
      narrative:     c.text,
      context:       '',
    })
    _evOriginalTimestamps.add(c.timestamp)
  }
}

// ── Recurrence helpers ────────────────────────────────────────────────────────

const DAY_SHORT = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function matchRrulePreset(rrule) {
  if (!rrule) return ''
  if (rrule === 'RRULE:FREQ=DAILY')   return 'DAILY'
  if (rrule === 'RRULE:FREQ=MONTHLY') return 'MONTHLY'
  if (rrule === 'RRULE:FREQ=YEARLY')  return 'ANNUALLY'
  if (/RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR/.test(rrule)) return 'WEEKDAYS'
  if (/RRULE:FREQ=WEEKLY/.test(rrule)) return 'WEEKLY'
  return 'CUSTOM'
}

function buildRrule(freq, startDate) {
  if (!freq || freq === 'CUSTOM') return null
  if (freq === 'DAILY')    return 'RRULE:FREQ=DAILY'
  if (freq === 'MONTHLY')  return 'RRULE:FREQ=MONTHLY'
  if (freq === 'ANNUALLY') return 'RRULE:FREQ=YEARLY'
  if (freq === 'WEEKDAYS') return 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  if (freq === 'WEEKLY') {
    const d = new Date(startDate + 'T00:00:00')
    return `RRULE:FREQ=WEEKLY;BYDAY=${DAY_SHORT[d.getDay()]}`
  }
  return null
}

// ── Custom recurrence state ───────────────────────────────────────────────────

let _crpFreq     = 'WEEKLY'
let _crpInterval = 1
let _crpByDay    = new Set()
let _crpEndType  = 'never'
let _crpEndDate  = ''
let _crpEndCount = 10

function buildCustomRrule() {
  let rule = `RRULE:FREQ=${_crpFreq}`
  if (_crpInterval > 1) rule += `;INTERVAL=${_crpInterval}`
  if (_crpFreq === 'WEEKLY' && _crpByDay.size > 0) rule += `;BYDAY=${[..._crpByDay].join(',')}`
  if (_crpEndType === 'date'  && _crpEndDate)  rule += `;UNTIL=${_crpEndDate.replace(/-/g, '')}T235959Z`
  if (_crpEndType === 'count' && _crpEndCount) rule += `;COUNT=${_crpEndCount}`
  return rule
}

function initCustomRecur() {
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

function resetCustomRecur(startDateStr) {
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

// ── Public API ────────────────────────────────────────────────────────────────

export function initEventEditor() {
  el('event-modal-close').addEventListener('click',  close)
  el('event-modal-cancel').addEventListener('click', close)
  el('event-modal-save').addEventListener('click',   save)

  el('event-modal-allday').addEventListener('change', () => setAllDayUI(el('event-modal-allday').checked))

  el('event-modal-recur').addEventListener('change', e => {
    el('custom-recur-panel').hidden = e.target.value !== 'CUSTOM'
    _preserveRrule = null
  })

  el('event-modal-delete')?.addEventListener('click', confirmDelete)
  el('event-modal-complete')?.addEventListener('click', handleCommitmentToggle)
  el('event-modal-snooze')?.addEventListener('click', () => {
    if (!_editItem) return
    openSnoozePopover(
      el('event-modal-snooze'),
      _editItem,
      () => { close(); _callbacks.onSaved?.() },
      (n, newDate, dateLabel) => handleCommitmentSnooze(n, newDate, dateLabel)
    )
  })

  el('event-modal').addEventListener('click', e => { if (e.target === el('event-modal')) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('event-modal').hidden) close() })

  // Location URL link
  _locLink = document.createElement('a')
  _locLink.className = 'field-url-link'
  _locLink.target    = '_blank'
  _locLink.rel       = 'noopener noreferrer'
  _locLink.textContent = '↗'
  _locLink.hidden    = true
  el('event-modal-location').parentNode.appendChild(_locLink)
  el('event-modal-location').addEventListener('input', e => {
    const v = e.target.value.trim()
    _locLink.hidden = !/^https?:\/\//i.test(v)
    _locLink.href   = v
  })

  // Comments
  el('event-modal-comment-add').addEventListener('click', _addEventComment)
  el('event-modal-comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') _addEventComment() })

  // Recurring-event scope picker
  el('recur-scope-cancel')?.addEventListener('click', () => {
    el('recur-scope-modal').hidden = true
    _pendingBody   = null
    _pendingAction = null
    el('event-modal-save').disabled   = false
    el('event-modal-delete').disabled = false
  })
  el('recur-scope-ok')?.addEventListener('click', () => executeWithScope(
    document.querySelector('input[name="recur-scope"]:checked')?.value ?? 'this'
  ))

  initCustomRecur()

  // Tiptap editor — HTML mode (Google Calendar natively stores HTML descriptions)
  _editorEvent = new Editor({
    element: el('event-modal-editor'),
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: false }),
      Placeholder.configure({ placeholder: 'Description…' }),
    ],
    content: '',
    editorProps: { attributes: { class: 'modal-editor-content' } },
  })
  _buildEvToolbar()
  _editorEvent.on('transaction', _updateEvToolbar)
}

export async function openEventEditor(opts = {}, callbacks = {}) {
  _editItem      = null
  _preserveRrule = null
  _callbacks     = callbacks

  const allDay = opts.allDay ?? false
  el('event-modal-allday').checked = allDay
  setAllDayUI(allDay)

  const today = opts.date ?? new Date().toLocaleDateString('en-CA')
  el('event-modal-start-date').value = today
  el('event-modal-end-date').value   = today

  if (opts.startTime) {
    el('event-modal-start-time').value = opts.startTime
    el('event-modal-end-time').value   = opts.endTime ?? minutesToTime(timeToMinutes(opts.startTime) + 30)
  } else {
    el('event-modal-start-time').value = '09:00'
    el('event-modal-end-time').value   = '09:30'
  }

  el('event-modal-title').value    = ''
  el('event-modal-location').value = ''
  el('event-modal-recur').value    = ''
  el('custom-recur-panel').hidden  = true
  el('event-modal-delete').hidden  = true
  if (_locLink) _locLink.hidden    = true

  if (_editorEvent) _editorEvent.commands.setContent('', false)
  if (_evRawMode) _evSwitchToRich()

  _evComments           = []
  _evOriginalTimestamps = new Set()
  el('event-modal-comments-section').hidden = true   // comments only in edit mode

  resetCustomRecur(today)

  const calSelect = el('event-modal-calendar')
  calSelect.disabled = false
  if (opts.calendars?.length) {
    populateCalendars(calSelect, opts.calendars, opts.calendarId)
  } else {
    calSelect.innerHTML = '<option value="">Loading…</option>'
    const token = await getToken()
    if (token) {
      try {
        const { getCalendars } = await import('./providers/googleCalendar.js')
        populateCalendars(calSelect, await getCalendars(token), opts.calendarId)
      } catch {
        calSelect.innerHTML = '<option value="">Could not load calendars</option>'
      }
    }
  }

  el('event-modal').hidden = false
  el('event-modal-title').focus()
}

export async function openEventEditorForEdit(item, callbacks = {}) {
  _editItem      = item
  _preserveRrule = null
  _callbacks     = callbacks

  const allDay = item.all_day
  el('event-modal-allday').checked = allDay
  setAllDayUI(allDay)

  const start      = new Date(item.start)
  const endRaw     = item.end ? new Date(item.end) : new Date(start.getTime() + 30 * 60_000)
  const displayEnd = allDay ? new Date(endRaw.getTime() - 86_400_000) : endRaw

  const toDate = d => d.toLocaleDateString('en-CA')
  const toTime = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`

  el('event-modal-start-date').value = toDate(start)
  el('event-modal-end-date').value   = toDate(displayEnd)
  el('event-modal-start-time').value = toTime(start)
  el('event-modal-end-time').value   = toTime(endRaw)
  el('event-modal-title').value      = item.title
  el('event-modal-location').value   = item.metadata?.location ?? ''

  // Load description into editor — strip any Kairos snapshot then convert plain text → HTML
  if (_editorEvent) _editorEvent.commands.setContent(_textToHtml(_stripEvSnapshot(item.metadata?.body ?? '')), false)
  if (_evRawMode) _evSwitchToRich()

  // Load activity log
  _evComments = getItemLog(item.id).map(e => ({
    _id:       e._id,
    timestamp: e.timestamp,
    text:      e.verb === 'comment' ? (e.action_detail?.text ?? e.narrative) : e.narrative,
    _readonly: e.verb !== 'comment',
  }))
  _evOriginalTimestamps = new Set(_evComments.map(c => c.timestamp))
  el('event-modal-comments-section').hidden = false
  _renderEventComments()
  el('event-modal-comments-section').open = _evComments.length > 0

  // Recurrence
  const preset = matchRrulePreset(item.recurrence)
  el('event-modal-recur').value = preset
  el('custom-recur-panel').hidden = preset !== 'CUSTOM'
  if (preset === 'CUSTOM' && item.recurrence) _preserveRrule = item.recurrence
  resetCustomRecur(toDate(start))

  // Calendar selector (locked in edit mode)
  const calSelect = el('event-modal-calendar')
  calSelect.disabled  = true
  calSelect.innerHTML = `<option value="${esc(item.source.account_id)}" selected>${esc(item.metadata?.calendar_name ?? 'Loading…')}</option>`

  const token = await getToken()
  if (token) {
    const calendarPromise = (async () => {
      try {
        const { getCalendars } = await import('./providers/googleCalendar.js')
        const cals = await getCalendars(token)
        const cal  = cals.find(c => c.id === item.source.account_id)
        if (cal) calSelect.innerHTML = `<option value="${esc(cal.id)}" selected>${esc(cal.summary)}</option>`
      } catch { /* keep the metadata name */ }
    })()

    const masterPromise = item.metadata?.recurring_event_id
      ? getEvent(token, item.source.account_id, item.metadata.recurring_event_id).catch(() => null)
      : Promise.resolve(null)

    const [, master] = await Promise.all([calendarPromise, masterPromise])

    if (master?.recurrence?.[0]) {
      const masterPreset = matchRrulePreset(master.recurrence[0])
      el('event-modal-recur').value = masterPreset
      el('custom-recur-panel').hidden = masterPreset !== 'CUSTOM'
      _preserveRrule = masterPreset === 'CUSTOM' ? master.recurrence[0] : null
    }
  }

  el('event-modal-delete').hidden   = false
  el('event-modal-delete').disabled = false

  if (item.metadata?.task_calendar) {
    const isDone = item.status === 'COMPLETED'
    const completeBtn = el('event-modal-complete')
    completeBtn.textContent = isDone ? 'Mark incomplete' : 'Mark complete'
    completeBtn.hidden      = false
    el('event-modal-snooze').hidden = isDone
  }

  const locVal = (item.metadata?.location ?? '').trim()
  if (_locLink) {
    _locLink.hidden = !/^https?:\/\//i.test(locVal)
    _locLink.href   = locVal
  }

  el('event-modal').hidden = false
  el('event-modal-title').focus()
}

function populateCalendars(select, calendars, preferredId) {
  select.disabled = false
  const writable  = calendars.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer')
  select.innerHTML = writable
    .map(c => `<option value="${esc(c.id)}"${c.primary ? ' selected' : ''}>${esc(c.summary)}</option>`)
    .join('')
  if (preferredId) select.value = preferredId
}

function close() {
  el('event-modal').hidden          = true
  el('event-modal-complete').hidden = true
  el('event-modal-snooze').hidden   = true
}

// ── Commitment complete / snooze ──────────────────────────────────────────────

async function handleCommitmentToggle() {
  if (!_editItem) return
  const token   = await getToken()
  if (!token) return
  const isDone  = _editItem.status === 'COMPLETED'
  const eventId = _editItem.source.external_id
  const verb    = isDone ? 'uncompleted' : 'completed'

  el('event-modal-complete').disabled = true
  try {
    if (isDone) await setUncompleted(token, eventId)
    else        await setCompleted(token, eventId)
    appendLogEntry(token, {
      item_id:       _editItem.id,
      item_type:     'EVENT',
      title:         _editItem.title,
      verb,
      action_detail: { verb },
      narrative:     isDone ? `Marked "${_editItem.title}" incomplete` : `Completed "${_editItem.title}"`,
      context:       _editItem.metadata?.calendar_name ?? '',
    })
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Commitment toggle failed:', err)
    el('event-modal-complete').disabled = false
  }
}

async function handleCommitmentSnooze(n, newDate, dateLabel) {
  if (!_editItem) return
  const token   = await getToken()
  if (!token) return
  const calId   = _editItem.source.account_id
  const eventId = _editItem.source.external_id
  const pad     = v => String(v).padStart(2, '0')
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
  await updateEvent(token, calId, eventId, body)
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function save() {
  const title = el('event-modal-title').value.trim()
  if (!title) { el('event-modal-title').focus(); return }

  const calendarId = el('event-modal-calendar').value
  if (!calendarId) return

  const allDay    = el('event-modal-allday').checked
  const startDate = el('event-modal-start-date').value
  const endDate   = el('event-modal-end-date').value || startDate
  const startTime = el('event-modal-start-time').value
  const endTime   = el('event-modal-end-time').value
  const freq      = el('event-modal-recur').value
  const location  = el('event-modal-location').value.trim()
  const html      = _evGetHtml()
  const snapHtml  = _buildEvSnapshotHtml(_evComments)
  const fullDesc  = snapHtml ? `${html}${snapHtml}` : html
  const tz        = Intl.DateTimeFormat().resolvedOptions().timeZone

  const body = {
    summary: title,
    ...(location  && { location }),
    ...(fullDesc  && { description: fullDesc }),
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

  let rrule
  if (freq === 'CUSTOM') {
    rrule = _preserveRrule ?? buildCustomRrule()
  } else {
    rrule = buildRrule(freq, startDate)
  }
  if (rrule) {
    body.recurrence = [rrule]
  } else if (_editItem && freq === '') {
    body.recurrence = []
  }

  const token = await getToken()
  if (!token) return

  const saveBtn = el('event-modal-save')
  saveBtn.disabled = true

  if (_editItem?.metadata?.recurring_event_id) {
    const scopeModal = el('recur-scope-modal')
    if (scopeModal) {
      _pendingBody = body
      document.querySelector('input[name="recur-scope"][value="this"]').checked = true
      scopeModal.hidden = false
      return
    }
  }

  try {
    let savedId = _editItem?.source.external_id ?? null
    if (_editItem) {
      await updateEvent(token, _editItem.source.account_id, _editItem.source.external_id, body)
    } else {
      const created = await createEvent(token, calendarId, body)
      savedId = created.id
    }
    await _logNewEvComments(token, _editItem?.id ?? `gcal:${calendarId}:${savedId}`, title)
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Event save failed:', err)
  } finally {
    saveBtn.disabled = false
  }
}

async function confirmDelete() {
  const deleteBtn = el('event-modal-delete')
  deleteBtn.disabled = true
  _pendingAction = 'delete'

  if (_editItem?.metadata?.recurring_event_id) {
    const scopeModal = el('recur-scope-modal')
    if (scopeModal) {
      el('recur-scope-title').textContent = 'Delete recurring event'
      document.querySelector('input[name="recur-scope"][value="this"]').checked = true
      scopeModal.hidden = false
      return
    }
  }

  const token = await getToken()
  if (!token) { deleteBtn.disabled = false; _pendingAction = null; return }
  try {
    await deleteEvent(token, _editItem.source.account_id, _editItem.source.external_id)
    close()
    _callbacks.onDeleted?.()
  } catch (err) {
    console.error('Event delete failed:', err)
    deleteBtn.disabled = false
  }
  _pendingAction = null
}

async function executeWithScope(scope) {
  const scopeModal = el('recur-scope-modal')
  if (scopeModal) scopeModal.hidden = true

  const action   = _pendingAction
  _pendingAction = null
  el('recur-scope-title').textContent = 'Edit recurring event'

  if (action === 'delete') {
    const token = await getToken()
    if (!token) { el('event-modal-delete').disabled = false; return }
    try {
      if (scope === 'all')            await deleteAllEvents(token)
      else if (scope === 'following') await deleteThisAndFollowing(token)
      else                            await deleteEvent(token, _editItem.source.account_id, _editItem.source.external_id)
      close()
      _callbacks.onDeleted?.()
    } catch (err) {
      console.error('Event delete failed:', err)
      el('event-modal-delete').disabled = false
    }
    return
  }

  const body    = _pendingBody
  _pendingBody  = null
  const saveBtn = el('event-modal-save')
  const token   = await getToken()
  if (!token || !body) { saveBtn.disabled = false; return }
  const calId   = _editItem.source.account_id
  const eventId = _editItem.source.external_id
  const title   = body.summary ?? _editItem.title
  try {
    if (scope === 'all')            await saveAllEvents(token, body)
    else if (scope === 'following') await saveThisAndFollowing(token, body)
    else                            await updateEvent(token, calId, eventId, body)
    await _logNewEvComments(token, _editItem?.id ?? `gcal:${calId}:${eventId}`, title)
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Event save failed:', err)
  } finally {
    saveBtn.disabled = false
  }
}

// ── Recurring save helpers ────────────────────────────────────────────────────

async function saveAllEvents(token, body) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurring_event_id
  const master   = await getEvent(token, calId, masterId)
  const masterBody = {}
  if (body.summary)     masterBody.summary     = body.summary
  if (body.location)    masterBody.location    = body.location
  if (body.description !== undefined) masterBody.description = body.description
  if (body.recurrence?.length) masterBody.recurrence = body.recurrence
  if (body.start?.dateTime && master.start?.dateTime) {
    const newTime  = body.start.dateTime.slice(11)
    const origDate = master.start.dateTime.slice(0, 11)
    masterBody.start = { dateTime: origDate + newTime, timeZone: body.start.timeZone }
    const newEndTime  = body.end.dateTime.slice(11)
    const origEndDate = master.end?.dateTime?.slice(0, 11) ?? origDate
    masterBody.end = { dateTime: origEndDate + newEndTime, timeZone: body.end.timeZone }
  }
  await updateEvent(token, calId, masterId, masterBody)
}

async function saveThisAndFollowing(token, body) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurring_event_id
  const master      = await getEvent(token, calId, masterId)
  const masterRrule = master.recurrence?.[0]
  if (masterRrule) {
    const cutoff = new Date(_editItem.start)
    cutoff.setUTCDate(cutoff.getUTCDate() - 1)
    cutoff.setUTCHours(23, 59, 59, 0)
    const pad = v => String(v).padStart(2, '0')
    const untilStr = `${cutoff.getUTCFullYear()}${pad(cutoff.getUTCMonth()+1)}${pad(cutoff.getUTCDate())}` +
                     `T${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}Z`
    const truncated = masterRrule.replace(/;?(UNTIL|COUNT)=[^;]*/g, '') + `;UNTIL=${untilStr}`
    await updateEvent(token, calId, masterId, { recurrence: [truncated] })
  }
  if (!body.recurrence && masterRrule) {
    body.recurrence = [masterRrule.replace(/;?(UNTIL|COUNT)=[^;]*/g, '')]
  }
  await createEvent(token, calId, body)
}

// ── Recurring delete helpers ──────────────────────────────────────────────────

async function deleteAllEvents(token) {
  await deleteEvent(token, _editItem.source.account_id, _editItem.metadata.recurring_event_id)
}

async function deleteThisAndFollowing(token) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurring_event_id
  const master      = await getEvent(token, calId, masterId)
  const masterRrule = master.recurrence?.[0]
  if (masterRrule) {
    const cutoff = new Date(_editItem.start)
    cutoff.setUTCDate(cutoff.getUTCDate() - 1)
    cutoff.setUTCHours(23, 59, 59, 0)
    const pad = v => String(v).padStart(2, '0')
    const untilStr = `${cutoff.getUTCFullYear()}${pad(cutoff.getUTCMonth()+1)}${pad(cutoff.getUTCDate())}` +
                     `T${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}Z`
    const truncated = masterRrule.replace(/;?(UNTIL|COUNT)=[^;]*/g, '') + `;UNTIL=${untilStr}`
    await updateEvent(token, calId, masterId, { recurrence: [truncated] })
  } else {
    await deleteEvent(token, calId, _editItem.source.external_id)
  }
}
