import { getTokens, getTokenFor } from './auth.js'
import { parseTaskNotes, serializeNotes, normalizeLoe, nowTimestamp, displayTimestamp } from './providers/parsers.js'
import { createTask, patchTask, deleteTask, moveTask, completeTask, uncompleteTask } from './providers/googleTasks.js'

// ── Module state ──────────────────────────────────────────────────────────────

let _item      = null   // null → create mode
let _listId    = null   // original list ID (source); never mutated during an edit
let _taskLists = []
let _accounts  = []     // [{ id, email, token }] — refreshed on each modal open
let _accountId = null   // currently selected account ID
let _checklist = []
let _comments  = []
let _callbacks = {}

// ── Public API ────────────────────────────────────────────────────────────────

export function initModal() {
  el('modal-close').addEventListener('click', close)
  el('modal-cancel').addEventListener('click', close)
  el('modal-save').addEventListener('click', save)
  el('modal-delete').addEventListener('click', doDelete)
  el('modal-toggle-complete').addEventListener('click', toggleComplete)

  el('modal-account').addEventListener('change', () => {
    _accountId = el('modal-account').value
    populateListSelect()
  })

  el('modal-checklist-add').addEventListener('click', addChecklistItem)
  el('modal-checklist-input').addEventListener('keydown', e => { if (e.key === 'Enter') addChecklistItem() })

  el('modal-comment-add').addEventListener('click', addComment)
  el('modal-comment-input').addEventListener('keydown', e => { if (e.key === 'Enter') addComment() })

  el('modal-loe').addEventListener('input', () => el('modal-loe-error').hidden = true)

  el('task-modal').addEventListener('click', e => { if (e.target === el('task-modal')) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('task-modal').hidden) close() })
}

export async function openModal(item, taskLists, callbacks) {
  _item      = item
  _listId    = item.source.account_id
  _taskLists = taskLists
  _checklist = (item.metadata?.checklist ?? []).map(i => ({ ...i }))
  _comments  = (item.metadata?.comments  ?? []).map(c => ({ ...c }))
  _callbacks = callbacks
  _accounts  = await getTokens()
  _accountId = item.source.owner_account ?? _accounts[0]?.id ?? null
  populate()
  show()
}

export async function openCreateModal(listId, taskLists, callbacks) {
  _item      = null
  _listId    = listId
  _taskLists = taskLists
  _checklist = []
  _comments  = []
  _callbacks = callbacks
  _accounts  = await getTokens()
  // Derive account from the list's tagged owner_account
  const list = taskLists.find(l => l.id === listId)
  _accountId = list?.owner_account ?? _accounts[0]?.id ?? null
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

  // Account selector — visible only when multiple accounts are connected
  const acctRow = el('modal-account-row')
  acctRow.hidden = _accounts.length <= 1
  if (_accounts.length > 1) {
    el('modal-account').innerHTML = _accounts
      .map(a => `<option value="${esc(a.id)}"${a.id === _accountId ? ' selected' : ''}>${esc(a.email ?? a.id)}</option>`)
      .join('')
  }

  // List selector — filtered to the selected account when multi-account
  populateListSelect()

  // Due date → yyyy-mm-dd for the date input
  el('modal-due').value = _item?.due
    ? new Date(_item.due).toLocaleDateString('en-CA')
    : ''

  el('modal-loe').value        = _item?.metadata?.loe ?? ''
  el('modal-loe-error').hidden = true
  el('modal-notes').value      = _item?.metadata?.body ?? ''

  el('modal-checklist-input').value = ''
  el('modal-comment-input').value   = ''

  renderChecklist()
  renderComments()

  // Auto-open sections that have content
  el('modal-checklist-section').open = _checklist.length > 0
  el('modal-comments-section').open  = _comments.length  > 0

  el('modal-delete').hidden          = !isEdit
  el('modal-toggle-complete').hidden = !isEdit
  if (isEdit) {
    el('modal-toggle-complete').textContent =
      _item.status === 'COMPLETED' ? 'Mark incomplete' : 'Mark complete'
  }
}

// Render the List <select> filtered to the currently selected account.
// Falls back to all lists if task lists have no owner_account tag (single-account session).
function populateListSelect() {
  const listsForAccount = _accounts.length > 1
    ? _taskLists.filter(l => l.owner_account === _accountId)
    : _taskLists

  // Keep the original list selected if it's still in scope; else pick the first.
  const selectId = listsForAccount.some(l => l.id === _listId) ? _listId : (listsForAccount[0]?.id ?? _listId)

  el('modal-list').innerHTML = listsForAccount
    .map(l => `<option value="${esc(l.id)}"${l.id === selectId ? ' selected' : ''}>${esc(l.title)}</option>`)
    .join('')
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

  el('modal-checklist-count').textContent = _checklist.length ? `(${_checklist.length})` : ''
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

  const rawLoe = el('modal-loe').value.trim()
  const loe    = rawLoe ? normalizeLoe(rawLoe) : null
  if (rawLoe && !loe) {
    el('modal-loe-error').hidden = false
    el('modal-loe').focus()
    return
  }

  const dueStr = el('modal-due').value
  const due    = dueStr ? `${dueStr}T00:00:00.000Z` : null

  const notes = serializeNotes({
    body:      el('modal-notes').value.trim(),
    loe,
    checklist: _checklist,
    comments:  _comments,
  })

  const selectedListId    = el('modal-list').value
  const selectedAccountId = _accounts.length > 1 ? el('modal-account').value : (_accountId ?? _accounts[0]?.id)
  const srcAccountId      = _item?.source?.owner_account ?? selectedAccountId
  const isCrossAccount    = !!_item && selectedAccountId !== srcAccountId
  const isCrossList       = !!_item && selectedListId !== _listId

  try {
    if (!_item) {
      // Create new task in the selected account + list
      const token = await getTokenFor(selectedAccountId)
      if (!token) return
      await createTask(token, selectedListId, { title, notes, due })

    } else if (isCrossAccount) {
      // Cross-account move: create in target account, then delete from source
      const srcToken = await getTokenFor(srcAccountId)
      const dstToken = await getTokenFor(selectedAccountId)
      if (!srcToken || !dstToken) return
      await createTask(dstToken, selectedListId, { title, notes, due })
      await deleteTask(srcToken, _listId, _item.source.external_id)

    } else if (isCrossList) {
      // Same account, different list
      const token = await getTokenFor(selectedAccountId)
      if (!token) return
      await moveTask(token, _listId, _item.source.external_id, selectedListId, { title, notes, due })

    } else {
      // Same account, same list — patch in place
      const token = await getTokenFor(selectedAccountId)
      if (!token) return
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

  const token = await getTokenFor(_item.source.owner_account)
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
  const token = await getTokenFor(_item.source.owner_account)
  if (!token) return
  const isDone = _item.status === 'COMPLETED'

  try {
    if (isDone) await uncompleteTask(token, _listId, _item.source.external_id)
    else        await completeTask(token, _listId, _item.source.external_id)
    close()
    _callbacks.onToggleDone?.()
  } catch (err) {
    console.error('Toggle complete failed:', err)
  }
}
