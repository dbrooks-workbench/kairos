import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'

import { getToken } from './auth.js'
import { normalizeLoe, nowTimestamp, displayTimestamp, buildSnapshot, serializeNotesFromMarkdown } from './providers/parsers.js'
import { createTask, patchTask, deleteTask, moveTask, completeTask, uncompleteTask } from './providers/googleTasks.js'
import { generateKairosId, updateTaskMeta } from './providers/driveTaskMeta.js'
import { appendLogEntry, getItemLog, deleteLogEntry } from './providers/lifeLog.js'

// ── Module state ──────────────────────────────────────────────────────────────

let _item                      = null   // null → create mode
let _listId                    = null
let _taskLists                 = []
let _comments                  = []
let _originalCommentTimestamps = new Set()
let _callbacks                 = {}
let _defaultDue                = null
let _editor                    = null   // Tiptap editor instance (created once in initModal)
let _rawMode                   = false  // true = textarea visible, editor hidden
let _rawBtn                    = null   // Raw/Rich toggle button reference

// ── Toolbar config ────────────────────────────────────────────────────────────

const TOOLBAR = [
  { name: 'bold',       label: 'B',  title: 'Bold',           cmd: e => { e.chain().focus().toggleBold().run() } },
  { name: 'italic',     label: 'I',  title: 'Italic',         cmd: e => { e.chain().focus().toggleItalic().run() } },
  { name: 'strike',     label: 'S',  title: 'Strikethrough',  cmd: e => { e.chain().focus().toggleStrike().run() } },
  null,
  { name: 'bulletList', label: '≡',  title: 'Bullet list',    cmd: e => { e.chain().focus().toggleBulletList().run() } },
  { name: 'taskList',   label: '☑',  title: 'Checklist',      cmd: e => { e.chain().focus().toggleTaskList().run() } },
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

  // Create the Tiptap editor once and keep it alive
  _editor = new Editor({
    element: el('modal-editor'),
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: false }),
      Placeholder.configure({ placeholder: 'Notes…' }),
      Markdown.configure({ html: false, tightLists: true }),
    ],
    content: '',
    editorProps: {
      attributes: { class: 'modal-editor-content' },
    },
  })

  _buildToolbar()
  _editor.on('transaction', _updateToolbar)
}

export function openModal(item, taskLists, callbacks) {
  _item       = item
  _listId     = item.source.account_id
  _taskLists  = taskLists
  _comments   = getItemLog(item.id).map(e => ({
    _id:       e._id,
    timestamp: e.timestamp,
    text:      e.verb === 'comment' ? (e.action_detail?.text ?? e.narrative) : e.narrative,
    _readonly: e.verb !== 'comment',
  }))
  _originalCommentTimestamps = new Set(_comments.map(c => c.timestamp))
  _callbacks  = callbacks
  populate()
  show()
}

export function openCreateModal(listId, taskLists, callbacks, opts = {}) {
  _item       = null
  _listId     = listId
  _taskLists  = taskLists
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

// ── Toolbar ───────────────────────────────────────────────────────────────────

function _buildToolbar() {
  const toolbar = el('modal-editor-toolbar')

  // Formatting buttons (left)
  const group = document.createElement('div')
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
    // mousedown prevents the editor from losing focus before the command runs
    btn.addEventListener('mousedown', e => { e.preventDefault(); item.cmd(_editor) })
    group.appendChild(btn)
  }
  toolbar.appendChild(group)

  // Raw/Rich toggle (right)
  _rawBtn = document.createElement('button')
  _rawBtn.type = 'button'
  _rawBtn.className = 'editor-mode-btn'
  _rawBtn.title = 'Toggle raw markdown'
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

  el('modal-list').innerHTML = _taskLists
    .map(l => `<option value="${esc(l.id)}"${l.id === _listId ? ' selected' : ''}>${esc(l.title)}</option>`)
    .join('')

  el('modal-due').value = _item?.due
    ? new Date(_item.due).toLocaleDateString('en-CA')
    : (_defaultDue ?? '')

  el('modal-loe').value        = _item?.metadata?.loe ?? ''
  el('modal-loe-error').hidden = true
  el('modal-comment-input').value = ''

  // Load body + checklist into the editor
  _setEditorContent(_itemToMarkdown(_item))
  if (_rawMode) _switchToRich()   // always open in rich mode

  renderComments()
  el('modal-comments-section').open = _comments.length > 0

  el('modal-delete').hidden          = !isEdit
  el('modal-toggle-complete').hidden = !isEdit

  const saveBtn = el('modal-save')
  saveBtn.disabled = false

  const taskIdEl = el('modal-task-id')
  if (isEdit) {
    const extId = _item.source.external_id ?? '—'
    const kid   = _item.metadata?.kid ?? '—'
    taskIdEl.textContent = `task: ${extId}  ·  kid: ${kid}`
    taskIdEl.hidden = false
  } else {
    taskIdEl.hidden = true
  }
  if (isEdit) {
    const isDone = _item.status === 'COMPLETED'
    el('modal-toggle-complete').textContent = isDone ? 'Mark incomplete' : 'Mark complete'
  }
}

// Build the combined markdown string that goes into the editor.
function _itemToMarkdown(item) {
  if (!item) return ''
  const body      = item.metadata?.body ?? ''
  const checklist = item.metadata?.checklist ?? []
  const parts     = []
  if (body.trim()) parts.push(body.trim())
  if (checklist.length)
    parts.push(checklist.map(c => `- [${c.checked ? 'x' : ' '}] ${c.text}`).join('\n'))
  return parts.join('\n\n')
}

// ── Editor helpers ────────────────────────────────────────────────────────────

function _setEditorContent(markdown) {
  if (!_editor) return
  _editor.commands.setContent(markdown ?? '', false)
  if (_rawMode) el('modal-notes-raw').value = markdown ?? ''
}

function _getRawMarkdown() {
  if (_rawMode) return el('modal-notes-raw').value
  return _editor ? _editor.storage.markdown.getMarkdown() : ''
}

function _toggleMode() {
  if (_rawMode) _switchToRich()
  else _switchToRaw()
}

function _switchToRaw() {
  if (_rawMode) return
  _rawMode = true
  el('modal-notes-raw').value  = _editor ? _editor.storage.markdown.getMarkdown() : ''
  el('modal-editor').hidden    = true
  el('modal-notes-raw').hidden = false
  if (_rawBtn) _rawBtn.textContent = 'Rich'
}

function _switchToRich() {
  if (!_rawMode) return
  _rawMode = false
  const md = el('modal-notes-raw').value
  if (_editor) _editor.commands.setContent(md, false)
  el('modal-notes-raw').hidden = true
  el('modal-editor').hidden    = false
  if (_rawBtn) _rawBtn.textContent = 'Raw'
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
      return
    }

    const dueStr = el('modal-due').value
    const due    = dueStr ? `${dueStr}T00:00:00.000Z` : null

    const kid          = _item?.metadata?.kid ?? generateKairosId()
    const userComments = _comments.filter(c => !c._readonly)
    const snapshot     = userComments.length > 0 ? buildSnapshot({ loe, comments: userComments }) : null

    const bodyMarkdown = _getRawMarkdown()
    const notes = serializeNotesFromMarkdown(bodyMarkdown, { kid, snapshot })

    const token = await getToken()
    if (!token) return

    updateTaskMeta(kid, { loe })

    const newUserComments = userComments.filter(c => !_originalCommentTimestamps.has(c.timestamp))
    for (const c of newUserComments) {
      appendLogEntry(token, {
        item_id:       _item?.id ?? `kid:${kid}`,
        item_type:     'TASK',
        title,
        verb:          'comment',
        action_detail: { verb: 'comment', text: c.text },
        narrative:     c.text,
        context:       _item?.metadata?.list_title ?? '',
      })
      _originalCommentTimestamps.add(c.timestamp)
    }

    const selectedListId = el('modal-list').value

    if (!_item) {
      await createTask(token, selectedListId, { title, notes, due })
    } else if (selectedListId !== _listId) {
      await moveTask(token, _listId, _item.source.external_id, selectedListId, { title, notes, due })
    } else {
      await patchTask(token, _listId, _item.source.external_id, { title, notes, due })
    }
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Save failed:', err)
  } finally {
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
      await completeTask(token, _listId, _item.source.external_id)
    }
    close()
    _callbacks.onToggleDone?.()
  } catch (err) {
    console.error('Toggle complete failed:', err)
  }
}
