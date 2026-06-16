import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.4/+esm'
import { getTokenFor } from './auth.js'
import { completeTask, uncompleteTask, moveTask, patchTask } from './providers/googleTasks.js'
import { serializeNotes, nowTimestamp } from './providers/parsers.js'

const DONE_COL_ID = '__done__'
let _sortables  = []
let _callbacks  = {}

// ── Snooze popover ────────────────────────────────────────────────────────────

let _snoozeItem      = null
let _snoozeOnRefresh = null
let _activeSnoozeBtn = null

async function executeSnooze() {
  const n = parseInt(document.getElementById('snooze-days').value, 10)
  if (!n || n < 1 || !_snoozeItem) return

  const item = _snoozeItem
  const cb   = _snoozeOnRefresh

  const newDue = new Date(item.due)
  newDue.setDate(newDue.getDate() + n)
  const pad = v => String(v).padStart(2, '0')
  const newDueIso = `${newDue.getFullYear()}-${pad(newDue.getMonth()+1)}-${pad(newDue.getDate())}T00:00:00.000Z`
  const dateLabel = newDue.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const newNotes = serializeNotes({
    body:      item.metadata.body      ?? '',
    loe:       item.metadata.loe       ?? null,
    checklist: item.metadata.checklist ?? [],
    comments:  [...(item.metadata.comments ?? []), {
      timestamp: nowTimestamp(),
      text: `Snoozed — follow up on ${dateLabel}`,
    }],
  })

  document.getElementById('snooze-popover').hidden = true
  _activeSnoozeBtn = null
  _snoozeItem      = null
  _snoozeOnRefresh = null

  try {
    const token = await getTokenFor(item.source.owner_account)
    if (token) {
      await patchTask(token, item.source.account_id, item.source.external_id, {
        due:   newDueIso,
        notes: newNotes,
      })
    }
  } catch (err) {
    console.error('Snooze failed:', err)
  }
  cb?.()
}

export function openSnoozePopover(btn, item, onRefresh) {
  const popover = document.getElementById('snooze-popover')

  if (_activeSnoozeBtn === btn && !popover.hidden) {
    popover.hidden = true
    _activeSnoozeBtn = null
    return
  }

  _snoozeItem      = item
  _snoozeOnRefresh = onRefresh
  _activeSnoozeBtn = btn

  const daysInput = document.getElementById('snooze-days')
  daysInput.value = 3
  document.getElementById('snooze-day-label').textContent = 'days'

  const rect = btn.getBoundingClientRect()
  const popoverWidth = 228
  const left = Math.min(rect.left, window.innerWidth - popoverWidth - 8)
  popover.style.top  = `${rect.bottom + 6}px`
  popover.style.left = `${Math.max(8, left)}px`
  popover.hidden = false
  daysInput.focus()
  daysInput.select()
}

export function initSnooze() {
  document.getElementById('snooze-days').addEventListener('input', () => {
    const n = parseInt(document.getElementById('snooze-days').value, 10)
    document.getElementById('snooze-day-label').textContent = n === 1 ? 'day' : 'days'
  })
  document.getElementById('snooze-confirm').addEventListener('click', executeSnooze)
  document.getElementById('snooze-days').addEventListener('keydown', e => {
    if (e.key === 'Enter')  executeSnooze()
    if (e.key === 'Escape') {
      document.getElementById('snooze-popover').hidden = true
      _activeSnoozeBtn = null
    }
  })
  document.addEventListener('mousedown', e => {
    const popover = document.getElementById('snooze-popover')
    if (!popover.hidden
        && !popover.contains(e.target)
        && !e.target.closest('.card-snooze')
        && !e.target.closest('.task-snooze')) {
      popover.hidden = true
      _activeSnoozeBtn = null
    }
  })
}

export function destroyBoard() {
  _sortables.forEach(s => { try { s.destroy() } catch {} })
  _sortables = []
  document.getElementById('board').innerHTML = ''
}

export function renderBoard(taskLists, boardItems, callbacks) {
  destroyBoard()
  _callbacks = callbacks

  const board = document.getElementById('board')

  // Partition: active tasks keyed by list, completed tasks in Done column
  const activeByList = {}
  const doneItems    = []

  for (const item of boardItems) {
    if (item.status === 'COMPLETED') {
      doneItems.push(item)
    } else {
      const lid = item.source.account_id
      if (!activeByList[lid]) activeByList[lid] = []
      activeByList[lid].push(item)
    }
  }

  // One column per task list
  for (const list of taskLists) {
    const col = buildCol(list, activeByList[list.id] ?? [], false)
    board.appendChild(col)
    _sortables.push(Sortable.create(col.querySelector('.board-task-list'), {
      group: 'tasks',
      animation: 150,
      ghostClass: 'board-ghost',
      dragClass:  'board-dragging',
      onEnd: handleDrop,
    }))
  }

  // Done column — cap at 50 to keep the list manageable
  const doneCol = buildCol({ id: DONE_COL_ID, title: 'Done' }, doneItems.slice(0, 50), true)
  board.appendChild(doneCol)
  _sortables.push(Sortable.create(doneCol.querySelector('.board-task-list'), {
    group: 'tasks',
    animation: 150,
    ghostClass: 'board-ghost',
    onEnd: handleDrop,
  }))
}

// ── Column ────────────────────────────────────────────────────────────────────

function buildCol(list, items, isDone) {
  const col = document.createElement('div')
  col.className = `board-col${isDone ? ' board-col-done' : ''}`

  // Header
  const hdr = document.createElement('div')
  hdr.className = 'board-col-header'

  const titleEl = document.createElement('span')
  titleEl.className = 'board-col-title'
  titleEl.textContent = list.title

  const countEl = document.createElement('span')
  countEl.className = 'board-col-count'
  countEl.textContent = items.length

  hdr.append(titleEl, countEl)

  if (!isDone) {
    const addBtn = document.createElement('button')
    addBtn.className = 'board-add-btn'
    addBtn.title     = 'New task'
    addBtn.textContent = '+'
    addBtn.addEventListener('click', () => _callbacks.onCreate?.(list.id))
    hdr.appendChild(addBtn)
  }

  // Task list
  const listEl = document.createElement('div')
  listEl.className      = 'board-task-list'
  listEl.dataset.listId = list.id

  for (const item of items) listEl.appendChild(buildCard(item))

  col.append(hdr, listEl)
  return col
}

// ── Card ──────────────────────────────────────────────────────────────────────

function buildCard(item) {
  const isDone = item.status === 'COMPLETED'
  const card   = document.createElement('div')
  card.className         = `board-card${isDone ? ' board-card-done' : ''}`
  card.dataset.itemId      = item.id
  card.dataset.listId      = item.source.account_id    // actual Google list ID
  card.dataset.extId       = item.source.external_id   // Google task ID
  card.dataset.ownerAccount = item.source.owner_account ?? ''

  // Header row: title + optional snooze button
  const hdr = document.createElement('div')
  hdr.className = 'board-card-header'

  const titleEl = document.createElement('div')
  titleEl.className   = 'board-card-title'
  titleEl.textContent = item.title
  hdr.appendChild(titleEl)

  if (item.due && !isDone) {
    const snoozeBtn = document.createElement('button')
    snoozeBtn.className = 'card-snooze'
    snoozeBtn.title     = 'Snooze'
    snoozeBtn.textContent = '⏰'
    snoozeBtn.addEventListener('click', e => {
      e.stopPropagation()
      openSnoozePopover(snoozeBtn, item, () => _callbacks.onRefresh?.())
    })
    hdr.appendChild(snoozeBtn)
  }

  card.appendChild(hdr)

  const chips = buildChips(item)
  if (chips.length) {
    const meta = document.createElement('div')
    meta.className = 'board-card-meta'
    chips.forEach(c => meta.appendChild(c))
    card.appendChild(meta)
  }

  card.addEventListener('click', () => _callbacks.onEdit?.(item))
  return card
}

function buildChips(item) {
  const chips = []

  if (item.due) {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const due   = new Date(item.due); due.setHours(0, 0, 0, 0)
    const diff  = Math.round((due - today) / 86_400_000)
    const chip  = document.createElement('span')
    chip.className = 'board-chip board-chip-due'
    if (diff < 0)       chip.classList.add('overdue')
    else if (diff === 0) chip.classList.add('today')
    chip.textContent = diff === 0  ? 'Today'
      : diff === -1 ? 'Yesterday'
      : diff === 1  ? 'Tomorrow'
      : due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    chips.push(chip)
  }

  if (item.metadata?.loe) {
    const chip = document.createElement('span')
    chip.className   = 'board-chip board-chip-loe'
    chip.textContent = item.metadata.loe
    chips.push(chip)
  }

  const cl = item.metadata?.checklist
  if (cl?.length) {
    const done = cl.filter(c => c.checked).length
    const chip = document.createElement('span')
    chip.className   = `board-chip board-chip-cl${done === cl.length ? ' complete' : ''}`
    chip.textContent = `${done}/${cl.length} ✓`
    chips.push(chip)
  }

  const cm = item.metadata?.comments
  if (cm?.length) {
    const chip = document.createElement('span')
    chip.className   = 'board-chip board-chip-comments'
    chip.textContent = `${cm.length} 💬`
    chips.push(chip)
  }

  return chips
}

// ── Drag-drop ─────────────────────────────────────────────────────────────────

async function handleDrop(evt) {
  const { item: cardEl, from, to } = evt
  if (from === to && evt.oldIndex === evt.newIndex) return

  const fromColId = from.dataset.listId
  const toColId   = to.dataset.listId
  if (fromColId === toColId) return  // same-column reorder not yet supported

  const listId      = cardEl.dataset.listId      // actual Google Tasks list ID
  const extId       = cardEl.dataset.extId
  const ownerAccount = cardEl.dataset.ownerAccount

  try {
    const token = await getTokenFor(ownerAccount)
    if (!token) { _callbacks.onRefresh?.(); return }

    if (toColId === DONE_COL_ID) {
      // Dropped into Done → complete
      await completeTask(token, listId, extId)
    } else if (fromColId === DONE_COL_ID) {
      // Dragged out of Done → uncomplete (then move if to a different list)
      await uncompleteTask(token, listId, extId)
      if (toColId !== listId) await moveTask(token, listId, extId, toColId)
    } else {
      // Moved between active lists
      await moveTask(token, listId, extId, toColId)
    }
  } catch (err) {
    console.error('Drop failed:', err)
  }

  _callbacks.onRefresh?.()
}
