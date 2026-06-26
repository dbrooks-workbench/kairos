import { getToken } from './auth.js'
import { serializeNotes, normalizeLoe, nowTimestamp, displayTimestamp, buildSnapshot } from './providers/parsers.js'
import { createTask, patchTask, deleteTask, moveTask, completeTask, uncompleteTask } from './providers/googleTasks.js'
import { generateKid, updateTaskMeta } from './providers/driveTaskMeta.js'
import { appendLogEntry, getItemLog, deleteLogEntry } from './providers/lifeLog.js'

// ── Module state ──────────────────────────────────────────────────────────────

let _item                      = null   // null → create mode
let _listId                    = null
let _taskLists                 = []
let _checklist                 = []
let _comments                  = []
let _originalCommentTimestamps = new Set()  // timestamps present when modal opened; new ones logged on save
let _callbacks                 = {}
let _defaultDue                = null   // 'yyyy-mm-dd' pre-fill for create mode
let _notesPreview              = null   // created once in initModal

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
  _item       = item
  _listId     = item.source.account_id
  _taskLists  = taskLists
  _checklist  = (item.metadata?.checklist ?? []).map(i => ({ ...i }))
  // Comments sourced from life log Sheet (single source of truth)
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
  _checklist  = []
  _comments   = []
  _originalCommentTimestamps = new Set()
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

  el('modal-due').value = _item?.due
    ? new Date(_item.due).toLocaleDateString('en-CA')
    : (_defaultDue ?? '')

  el('modal-loe').value     = _item?.metadata?.loe ?? ''
  el('modal-loe-error').hidden = true
  el('modal-notes').value   = _item?.metadata?.body ?? ''
  _refreshNotesPreview()

  el('modal-checklist-input').value = ''
  el('modal-comment-input').value   = ''

  renderChecklist()
  renderComments()

  el('modal-checklist-section').open = _checklist.length > 0
  el('modal-comments-section').open  = _comments.length  > 0

  el('modal-delete').hidden          = !isEdit
  el('modal-toggle-complete').hidden = !isEdit

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
    row.className = 'modal-comment-row' + (c._readonly ? ' modal-comment-readonly' : '')

    const ts = document.createElement('span')
    ts.className   = 'modal-comment-ts'
    ts.textContent = displayTimestamp(c.timestamp)

    const del = document.createElement('button')
    del.className   = 'modal-row-del'
    del.textContent = '×'
    del.addEventListener('click', async () => {
      _comments = _comments.filter(x => x.timestamp !== c.timestamp)
      renderComments()
      // If the entry has a Firestore ID, delete it from the life log
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
        const orig = _comments.find(x => x.timestamp === c.timestamp)
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
  _comments.push({ timestamp: nowTimestamp(), text })
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

    const kid           = _item?.metadata?.kid ?? generateKid()
    const userComments  = _comments.filter(c => !c._readonly)
    const snapshot      = buildSnapshot({ loe, comments: userComments })

    const notes = serializeNotes({
      body:      el('modal-notes').value.trim(),
      checklist: _checklist,
      kid,
      snapshot,
    })

    const token = await getToken()
    if (!token) return

    updateTaskMeta(kid, { loe })

    // Log new user comments (added this session) to the life log Sheet
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
      // Mark as logged so a re-save within the same session doesn't duplicate
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
