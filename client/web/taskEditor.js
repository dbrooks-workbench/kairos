import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'

import { getToken } from './auth.js'
import { normalizeLoe, nowTimestamp, displayTimestamp } from './providers/parsers.js'
import {
  createTask as _createTask,
  updateTask as _updateTask,
  deleteTask as _deleteTask,
  completeTask as _completeTask,
  uncompleteTask as _uncompleteTask,
} from './providers/calendarTasks.js'
import { generateKairosId } from './providers/driveTaskMeta.js'
import { getListsForCalendar } from './providers/kairosLists.js'
import { getTaskCalendars } from './providers/kairosPrefs.js'
import { appendLogEntry, getItemLog, deleteLogEntry } from './providers/lifeLog.js'

// ── Module state ──────────────────────────────────────────────────────────────

let _item       = null   // null → create mode
let _calendarId = null   // Google Calendar ID the task lives on
let _listId     = null   // Firestore list ID within that calendar
let _kairosId   = null   // null in create mode; set on first save
let _comments   = []
let _originalCommentTimestamps = new Set()
let _callbacks  = {}
let _defaultDue = null
let _editor     = null   // Tiptap editor (created once in initModal)
let _rawMode    = false
let _rawBtn     = null
let _webhookToken   = null  // cached after first fetch
let _preserveRrule  = null  // holds a custom RRULE that can't be represented as a preset

// ── Recurrence helpers ────────────────────────────────────────────────────────

const RECUR_PRESETS = {
  DAILY:    'RRULE:FREQ=DAILY',
  WEEKDAYS: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
  WEEKLY:   'RRULE:FREQ=WEEKLY',
  MONTHLY:  'RRULE:FREQ=MONTHLY',
  ANNUALLY: 'RRULE:FREQ=YEARLY',
}

function _matchPreset(rrule) {
  if (!rrule) return ''
  for (const [key, val] of Object.entries(RECUR_PRESETS)) {
    if (rrule.startsWith(val)) return key
  }
  return 'CUSTOM'
}

// ── Toolbar config ────────────────────────────────────────────────────────────

const TOOLBAR = [
  { name: 'bold',       label: 'B', title: 'Bold',          cmd: e => e.chain().focus().toggleBold().run() },
  { name: 'italic',     label: 'I', title: 'Italic',        cmd: e => e.chain().focus().toggleItalic().run() },
  { name: 'strike',     label: 'S', title: 'Strikethrough', cmd: e => e.chain().focus().toggleStrike().run() },
  null,
  { name: 'bulletList', label: '≡', title: 'Bullet list',   cmd: e => e.chain().focus().toggleBulletList().run() },
  { name: 'taskList',   label: '☑', title: 'Checklist',     cmd: e => e.chain().focus().toggleTaskList().run() },
]

// ── Public API ────────────────────────────────────────────────────────────────

export function initModal() {
  el('modal-close').addEventListener('click', close)
  el('modal-cancel').addEventListener('click', close)
  el('modal-save').addEventListener('click', save)
  el('modal-delete').addEventListener('click', doDelete)
  el('modal-toggle-complete').addEventListener('click', toggleComplete)

  el('modal-comment-add').addEventListener('click', addComment)
  el('modal-comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') addComment() })
  el('modal-loe').addEventListener('input', () => el('modal-loe-error').hidden = true)

  el('task-modal').addEventListener('click', e => { if (e.target === el('task-modal')) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('task-modal').hidden) close() })

  _editor = new Editor({
    element: el('modal-editor'),
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: false }),
      Placeholder.configure({ placeholder: 'Notes…' }),
    ],
    content: '',
    editorProps: { attributes: { class: 'modal-editor-content' } },
  })

  _buildToolbar()
  _editor.on('transaction', _updateToolbar)

  // Pre-fetch the webhook token so it's ready on first save
  _ensureWebhookToken()
}

// Edit an existing calendar task.
export function openModal(item, callbacks) {
  _item       = item
  _calendarId = item.source.account_id
  _listId     = item.metadata?.listId ?? null
  _kairosId   = item.metadata?.kairosId ?? null
  _comments   = getItemLog(item.id).map(e => ({
    _id:       e._id,
    timestamp: e.timestamp,
    text:      e.verb === 'comment' ? (e.action_detail?.text ?? e.narrative) : e.narrative,
    _readonly: e.verb !== 'comment',
  }))
  _originalCommentTimestamps = new Set(_comments.map(c => c.timestamp))
  _callbacks  = callbacks
  _defaultDue = null
  populate()
  show()
}

// Create a new calendar task. calendarId defaults to the first task calendar.
// listId is a Firestore list ID; null = unassigned.
export function openCreateModal(calendarId, listId, callbacks, opts = {}) {
  _item       = null
  _calendarId = calendarId ?? getTaskCalendars()[0] ?? null
  _listId     = listId ?? null
  _kairosId   = null
  _comments   = []
  _originalCommentTimestamps = new Set()
  _callbacks  = callbacks
  _defaultDue = opts.due ?? null
  populate()
  show()
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id) }
function show()  { el('task-modal').hidden = false; _editor?.commands.focus() }
function close() { el('task-modal').hidden = true }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _fmtDate(d) {
  if (!d) return ''
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  const dt = d instanceof Date ? d : new Date(d)
  return isNaN(dt) ? '' : dt.toLocaleDateString('en-CA')
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function _buildToolbar() {
  const toolbar = el('modal-editor-toolbar')
  const group   = document.createElement('div')
  group.className = 'editor-btn-group'

  for (const item of TOOLBAR) {
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
  _rawBtn.title = 'Toggle HTML source'
  _rawBtn.textContent = 'Raw'
  _rawBtn.addEventListener('click', _toggleMode)
  toolbar.appendChild(_rawBtn)
}

function _updateToolbar() {
  if (!_editor) return
  for (const btn of el('modal-editor-toolbar').querySelectorAll('.editor-btn[data-tip-name]')) {
    btn.classList.toggle('is-active', _editor.isActive(btn.dataset.tipName))
  }
}

// ── Populate ──────────────────────────────────────────────────────────────────

function populate() {
  const isEdit = !!_item

  el('modal-title').value = _item?.title ?? ''

  // Lists from Firestore kairosLists for this calendar
  const lists = _calendarId ? getListsForCalendar(_calendarId) : []
  if (lists.length) {
    el('modal-list').innerHTML = lists
      .map(l => `<option value="${esc(l.id)}"${l.id === _listId ? ' selected' : ''}>${esc(l.name)}</option>`)
      .join('')
  } else {
    el('modal-list').innerHTML = '<option value="">No lists</option>'
  }

  // Date field — due date for dated tasks; blank for undated
  el('modal-due').value = _item?.due
    ? _fmtDate(_item.due)
    : _fmtDate(_defaultDue)

  // Recurrence — master events carry recurrence[0]; instances have null (series rule
  // lives on the master, not on individual instances fetched via singleEvents=true)
  const rrule  = _item?.recurrence ?? null
  const preset = _matchPreset(rrule)
  _preserveRrule = (preset === 'CUSTOM') ? rrule : null
  const recurSel = el('modal-recur')
  recurSel.querySelector('option[value="CUSTOM"]')?.remove()
  if (preset === 'CUSTOM') {
    const opt = document.createElement('option')
    opt.value       = 'CUSTOM'
    opt.textContent = 'Custom (preserved)'
    recurSel.appendChild(opt)
  }
  recurSel.value = preset

  el('modal-loe').value        = _item?.metadata?.loe ?? ''
  el('modal-loe-error').hidden = true
  el('modal-comment-input').value = ''

  // Body from metadata.body (HTML from Calendar); plain text gets wrapped
  _setEditorContent(_toHtml(_item?.metadata?.body ?? ''))
  if (_rawMode) _switchToRich()

  renderComments()
  el('modal-comments-section').open = _comments.length > 0

  el('modal-delete').hidden          = !isEdit
  el('modal-toggle-complete').hidden = !isEdit

  if (isEdit) {
    const isDone = _item.status === 'COMPLETED'
    el('modal-toggle-complete').textContent = isDone ? 'Mark incomplete' : 'Mark complete'
  }

  const taskIdEl = el('modal-task-id')
  if (isEdit) {
    const extId = _item.source.external_id ?? '—'
    const kid   = _item.metadata?.kairosId ?? '—'
    taskIdEl.textContent = `event: ${extId}  ·  kId: ${kid}`
    taskIdEl.hidden = false
  } else {
    taskIdEl.hidden = true
  }

  el('modal-save').disabled = false
}

// Ensure body text without HTML markup is safely wrapped for Tiptap.
function _toHtml(body) {
  if (!body) return ''
  const s = body.trim()
  if (s.startsWith('<')) return s
  return '<p>' + s.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>'
}

// ── Editor helpers ────────────────────────────────────────────────────────────

function _setEditorContent(html) {
  if (!_editor) return
  _editor.commands.setContent(html || '', false)
  if (_rawMode) el('modal-notes-raw').value = html || ''
}

function _getHtml() {
  if (_rawMode) return el('modal-notes-raw').value
  return _editor ? _editor.getHTML() : ''
}

function _toggleMode() {
  if (_rawMode) _switchToRich()
  else _switchToRaw()
}

function _switchToRaw() {
  if (_rawMode) return
  _rawMode = true
  el('modal-notes-raw').value  = _editor ? _editor.getHTML() : ''
  el('modal-editor').hidden    = true
  el('modal-notes-raw').hidden = false
  if (_rawBtn) _rawBtn.textContent = 'Rich'
}

function _switchToRich() {
  if (!_rawMode) return
  _rawMode = false
  const html = el('modal-notes-raw').value
  if (_editor) _editor.commands.setContent(html, false)
  el('modal-notes-raw').hidden = true
  el('modal-editor').hidden    = false
  if (_rawBtn) _rawBtn.textContent = 'Raw'
}

// ── Webhook token ─────────────────────────────────────────────────────────────

async function _ensureWebhookToken() {
  if (_webhookToken) return _webhookToken
  try {
    const res = await fetch('/api/webhook-token', { credentials: 'include' })
    if (res.ok) _webhookToken = (await res.json()).token ?? null
  } catch {}
  return _webhookToken
}

// ── Comments ──────────────────────────────────────────────────────────────────

function renderComments() {
  const container = el('modal-comments-items')
  container.innerHTML = ''

  const sorted = [..._comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
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
      _comments = _comments.filter(x => x !== c)
      renderComments()
      if (c._id && _item) {
        const token = await getToken()
        if (token) deleteLogEntry(token, _item.id, c._id)
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
        const orig = _comments.find(x => x === c)
        if (orig) orig.text = txt.value
      })
      row.append(ts, txt, del)
    }

    container.appendChild(row)
  })

  el('modal-comments-count').textContent = _comments.length ? `(${_comments.length})` : ''
}

function addComment() {
  const inp  = el('modal-comment-input')
  const text = inp.value.trim()
  if (!text) return
  _comments.push({ _id: null, timestamp: nowTimestamp(), text })
  inp.value = ''
  renderComments()
  el('modal-comments-section').open = true
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function save() {
  const title = el('modal-title').value.trim()
  if (!title) { el('modal-title').focus(); return }

  const saveBtn = el('modal-save')
  if (saveBtn.disabled) return
  saveBtn.disabled = true

  try {
    const rawLoe = el('modal-loe').value.trim()
    const loe    = rawLoe ? normalizeLoe(rawLoe) : null
    if (rawLoe && !loe) {
      el('modal-loe-error').hidden = false
      el('modal-loe').focus()
      saveBtn.disabled = false
      return
    }

    const dateStr      = el('modal-due').value || null  // YYYY-MM-DD or null
    const selectedList = el('modal-list').value || null

    // Recurrence: read the select; CUSTOM means preserve the original RRULE unchanged.
    const recurVal  = el('modal-recur').value
    const recurrence = recurVal === 'CUSTOM'
      ? undefined                       // don't include — preserve existing via PATCH
      : (RECUR_PRESETS[recurVal] ?? null)  // null clears recurrence; RRULE string sets it

    // Assign a kairosId on first save and remember it for subsequent edits.
    const kairosId = _kairosId ?? generateKairosId()
    _kairosId      = kairosId

    const wt   = await _ensureWebhookToken()
    const body = _getHtml()

    const taskData = {
      title,
      body,
      kairosId,
      listId:       selectedList,
      order:        _item?.metadata?.order ?? Date.now(),
      loe,
      date:         dateStr,
      noDate:       !dateStr,
      webhookToken: wt,
      recurrence,
      completed:    _item?.status === 'COMPLETED',
    }

    const token = await getToken()
    if (!token) { saveBtn.disabled = false; return }

    // Flush new comments to the life log
    const userComments = _comments.filter(c => !c._readonly)
    const newComments  = userComments.filter(c => !_originalCommentTimestamps.has(c.timestamp))
    const logItemId    = _item?.id ?? `gcal:${_calendarId}:pending`
    for (const c of newComments) {
      appendLogEntry(token, {
        item_id:       logItemId,
        item_type:     'TASK',
        title,
        verb:          'comment',
        action_detail: { verb: 'comment', text: c.text },
        narrative:     c.text,
      })
      _originalCommentTimestamps.add(c.timestamp)
    }

    if (!_item) {
      await _createTask(token, _calendarId, taskData)
    } else {
      await _updateTask(token, _calendarId, _item.source.external_id, taskData)
    }

    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Task save failed:', err)
    saveBtn.disabled = false
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function doDelete() {
  if (!_item) return
  if (!confirm(`Delete "${_item.title}"?`)) return
  const token = await getToken()
  if (!token) return
  try {
    await _deleteTask(token, _calendarId, _item.source.external_id)
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
      await _uncompleteTask(token, _calendarId, _item.source.external_id, _item.title)
    } else {
      await _completeTask(token, _calendarId, _item.source.external_id, _item.title)
    }
    close()
    _callbacks.onToggleDone?.()
  } catch (err) {
    console.error('Toggle complete failed:', err)
  }
}
