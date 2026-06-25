import Sortable from 'https://cdn.jsdelivr.net/npm/sortablejs@1.15.4/+esm'
import { getToken } from './auth.js'
import { completeTask, uncompleteTask, moveTask, patchTask, reorderTask, spawnNextRecurrence, renameTaskList, deleteTaskList } from './providers/googleTasks.js'
import { serializeNotes, nowTimestamp } from './providers/parsers.js'
import { getBoardColumnSort, setBoardColumnSort, getTaskListOrder, setTaskListOrder } from './providers/drivePrefs.js'
import { generateKid, updateTaskMeta } from './providers/driveTaskMeta.js'

const DONE_COL_ID = '__done__'

let _sortables      = []
let _callbacks      = {}
let _taskLists      = []
let _boardItems     = []
let _doneWindow     = 30
let _primaryListId  = null

function setColSort(listId, mode) {
  if (getBoardColumnSort()[listId] === mode) return
  setBoardColumnSort(listId, mode)
  renderBoard(_taskLists, _boardItems, _callbacks, _doneWindow, _primaryListId)
}

function colSortMode(listId) {
  return getBoardColumnSort()[listId] ?? 'manual'
}

function sortedItems(items, listId) {
  if (colSortMode(listId) !== 'date') return items
  return [...items].sort((a, b) => {
    if (!a.due && !b.due) return 0
    if (!a.due) return 1
    if (!b.due) return -1
    return a.due - b.due
  })
}

// Apply the saved list order, appending any new lists not yet in the order array.
function orderedLists(lists) {
  const order  = getTaskListOrder()
  if (!order.length) return lists
  const known   = new Set(order)
  const ordered = order.map(id => lists.find(l => l.id === id)).filter(Boolean)
  const rest    = lists.filter(l => !known.has(l.id))
  return [...ordered, ...rest]
}

// ── Snooze popover ────────────────────────────────────────────────────────────

let _snoozeItem      = null
let _snoozeOnRefresh = null
let _activeSnoozeBtn = null
let _snoozeActionFn  = null   // optional override: async (n, newDate, dateLabel) => void

async function executeSnooze(daysOverride) {
  const n = daysOverride ?? parseInt(document.getElementById('snooze-days').value, 10)
  if (!n || n < 1) return
  if (!_snoozeItem && !_snoozeActionFn) return

  const item = _snoozeItem
  const cb   = _snoozeOnRefresh
  const fn   = _snoozeActionFn

  const baseDate = item?.due ?? item?.start ?? new Date()
  const newDue   = new Date(baseDate)
  newDue.setDate(newDue.getDate() + n)
  const pad = v => String(v).padStart(2, '0')
  const dateLabel = newDue.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  document.getElementById('snooze-popover').hidden = true
  _activeSnoozeBtn = null
  _snoozeItem      = null
  _snoozeOnRefresh = null
  _snoozeActionFn  = null

  if (fn) {
    try { await fn(n, newDue, dateLabel) } catch (err) { console.error('Snooze failed:', err) }
    cb?.()
    return
  }

  // Default: task snooze
  const newDueIso = `${newDue.getFullYear()}-${pad(newDue.getMonth()+1)}-${pad(newDue.getDate())}T00:00:00.000Z`

  const kid         = item.metadata?.kid ?? generateKid()
  const newComments = [...(item.metadata.comments ?? []), {
    timestamp: nowTimestamp(),
    text: `Snoozed — follow up on ${dateLabel}`,
  }]
  updateTaskMeta(kid, { loe: item.metadata.loe ?? null, comments: newComments })

  const notes = serializeNotes({
    body:       item.metadata.body       ?? '',
    recurrence: item.metadata.recurrence ?? null,
    checklist:  item.metadata.checklist  ?? [],
    kid,
  })

  try {
    const token = await getToken()
    if (token) {
      await patchTask(token, item.source.account_id, item.source.external_id, {
        due: newDueIso,
        notes,
      })
    }
  } catch (err) {
    console.error('Snooze failed:', err)
  }
  cb?.()
}

export function openSnoozePopover(btn, item, onRefresh, actionFn = null) {
  const popover = document.getElementById('snooze-popover')

  if (_activeSnoozeBtn === btn && !popover.hidden) {
    popover.hidden = true
    _activeSnoozeBtn = null
    return
  }

  _snoozeItem      = item
  _snoozeOnRefresh = onRefresh
  _activeSnoozeBtn = btn
  _snoozeActionFn  = actionFn ?? null

  const daysInput = document.getElementById('snooze-days')
  daysInput.value = 3
  document.getElementById('snooze-day-label').textContent = 'days'

  // Populate quick-select labels
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const daysToSat = (6 - today.getDay() + 7) % 7 || 7
  const daysToMon = (1 - today.getDay() + 7) % 7 || 7
  const fmt = d => {
    const dow = d.toLocaleDateString('en-US', { weekday: 'short' })
    return `${dow} ${d.getMonth() + 1}/${d.getDate()}`
  }
  const mkDate = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d }

  const qTomorrow = document.getElementById('snooze-q-tomorrow')
  const qWeekend  = document.getElementById('snooze-q-weekend')
  const qNextWeek = document.getElementById('snooze-q-nextweek')

  qTomorrow.textContent     = `Tomorrow (${fmt(mkDate(1))})`
  qTomorrow.dataset.days    = 1
  qWeekend.textContent      = `This weekend (${fmt(mkDate(daysToSat))})`
  qWeekend.dataset.days     = daysToSat
  qNextWeek.textContent     = `Next week (${fmt(mkDate(daysToMon))})`
  qNextWeek.dataset.days    = daysToMon

  const rect = btn.getBoundingClientRect()
  const popoverWidth = 240
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
  document.getElementById('snooze-confirm').addEventListener('click', () => executeSnooze())
  document.getElementById('snooze-days').addEventListener('keydown', e => {
    if (e.key === 'Enter')  executeSnooze()
    if (e.key === 'Escape') {
      document.getElementById('snooze-popover').hidden = true
      _activeSnoozeBtn = null
    }
  })
  ;['snooze-q-tomorrow', 'snooze-q-weekend', 'snooze-q-nextweek'].forEach(id => {
    document.getElementById(id).addEventListener('click', () => {
      executeSnooze(parseInt(document.getElementById(id).dataset.days, 10))
    })
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

export function renderBoard(taskLists, boardItems, callbacks, doneWindow = 30, primaryListId = null) {
  _taskLists     = taskLists
  _boardItems    = boardItems
  _doneWindow    = doneWindow
  _callbacks     = callbacks
  _primaryListId = primaryListId

  // Capture scroll positions before wiping the DOM
  const scrollTops = {}
  document.querySelectorAll('.board-task-list[data-list-id]').forEach(el => {
    if (el.scrollTop > 0) scrollTops[el.dataset.listId] = el.scrollTop
  })

  destroyBoard()

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

  // Render columns in the user's preferred order
  const lists = orderedLists(taskLists)
  for (const list of lists) {
    const col = buildCol(list, activeByList[list.id] ?? [], false, doneWindow)
    board.appendChild(col)
    _sortables.push(Sortable.create(col.querySelector('.board-task-list'), {
      group: 'tasks',
      animation: 150,
      ghostClass: 'board-ghost',
      dragClass:  'board-dragging',
      sort: colSortMode(list.id) !== 'date',
      onEnd: handleDrop,
    }))
  }

  // Done column — cap at 100 to keep the list manageable
  const doneCol = buildCol({ id: DONE_COL_ID, title: 'Done' }, doneItems.slice(0, 100), true, doneWindow)
  board.appendChild(doneCol)

  // "Add list" pseudo-column — after Done so new lists land before it
  board.appendChild(buildAddListCol(callbacks))
  _sortables.push(Sortable.create(doneCol.querySelector('.board-task-list'), {
    group: 'tasks',
    animation: 150,
    ghostClass: 'board-ghost',
    onEnd: handleDrop,
  }))

  // Drag-to-reorder columns (handle only; excludes Done and Add-list pseudo-columns)
  _sortables.push(Sortable.create(board, {
    animation:  150,
    handle:     '.board-col-drag-handle',
    draggable:  '.board-col-reorderable',
    ghostClass: 'board-col-ghost',
    onEnd: () => {
      const newOrder = [...board.querySelectorAll('.board-col-reorderable')]
        .map(col => col.dataset.listId)
      setTaskListOrder(newOrder)
    },
  }))

  // Restore scroll positions after rebuild
  document.querySelectorAll('.board-task-list[data-list-id]').forEach(el => {
    const saved = scrollTops[el.dataset.listId]
    if (saved) el.scrollTop = saved
  })
}

// ── Column ────────────────────────────────────────────────────────────────────

function buildCol(list, items, isDone, doneWindow) {
  const col = document.createElement('div')
  col.className = `board-col${isDone ? ' board-col-done' : ' board-col-reorderable'}`
  if (!isDone) col.dataset.listId = list.id

  // Header
  const hdr = document.createElement('div')
  hdr.className = 'board-col-header'

  if (!isDone) {
    const dragHandle = document.createElement('span')
    dragHandle.className   = 'board-col-drag-handle'
    dragHandle.textContent = '⠿'
    dragHandle.title       = 'Drag to reorder'
    hdr.appendChild(dragHandle)
  }

  const titleEl = document.createElement('span')
  titleEl.className = 'board-col-title'
  titleEl.textContent = list.title

  const countEl = document.createElement('span')
  countEl.className = 'board-col-count'
  countEl.textContent = items.length

  hdr.append(titleEl, countEl)

  if (!isDone) {
    titleEl.title = 'Click to rename'
    titleEl.style.cursor = 'text'
    titleEl.addEventListener('click', () => {
      const inp = document.createElement('input')
      inp.type      = 'text'
      inp.className = 'board-col-title-input'
      inp.value     = list.title
      inp.maxLength = 100
      titleEl.replaceWith(inp)
      inp.focus()
      inp.select()

      let done = false
      const commit = async () => {
        if (done) return
        done = true
        const newTitle = inp.value.trim()
        if (newTitle && newTitle !== list.title) {
          try {
            const token = await getToken()
            if (token) await renameTaskList(token, list.id, newTitle)
            _callbacks.onRefresh?.()
          } catch (err) {
            console.error('Rename list failed:', err)
            inp.replaceWith(titleEl)
          }
        } else {
          inp.replaceWith(titleEl)
        }
      }
      const cancel = () => { done = true; inp.replaceWith(titleEl) }

      inp.addEventListener('blur', commit)
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); commit() }
        if (e.key === 'Escape') cancel()
      })
    })
  }

  if (isDone) {
    const toggle = document.createElement('div')
    toggle.className = 'done-window-toggle'
    for (const days of [7, 30, 90]) {
      const btn = document.createElement('button')
      btn.className = `done-window-btn${days === doneWindow ? ' active' : ''}`
      btn.textContent = `${days}d`
      btn.addEventListener('click', () => _callbacks.onDoneWindowChange?.(days))
      toggle.appendChild(btn)
    }
    hdr.appendChild(toggle)
  } else {
    const isDate  = colSortMode(list.id) === 'date'
    const sortBtn = document.createElement('button')
    sortBtn.className   = `col-sort-date-btn${isDate ? ' active' : ''}`
    sortBtn.textContent = '📅'
    sortBtn.title       = isDate ? 'Sorted by date — click for manual order' : 'Sort by date'
    sortBtn.addEventListener('click', () => setColSort(list.id, isDate ? 'manual' : 'date'))
    hdr.appendChild(sortBtn)

    const addBtn = document.createElement('button')
    addBtn.className   = 'board-add-btn'
    addBtn.title       = 'New task'
    addBtn.textContent = '+'
    addBtn.addEventListener('click', () => _callbacks.onCreate?.(list.id))
    hdr.appendChild(addBtn)

    if (list.id !== _primaryListId) {
      const delBtn = document.createElement('button')
      delBtn.className   = 'board-col-delete-btn'
      delBtn.title       = 'Delete list'
      delBtn.textContent = '🗑'
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${list.title}" and all its tasks? This cannot be undone.`)) return
        try {
          const token = await getToken()
          if (!token) return
          await deleteTaskList(token, list.id)
          setTaskListOrder(getTaskListOrder().filter(id => id !== list.id))
          _callbacks.onRefresh?.()
        } catch (err) {
          console.error('Delete list failed:', err)
        }
      })
      hdr.appendChild(delBtn)
    }
  }

  // Task list
  const listEl = document.createElement('div')
  listEl.className      = 'board-task-list'
  listEl.dataset.listId = list.id

  for (const item of sortedItems(items, list.id)) listEl.appendChild(buildCard(item))

  col.append(hdr, listEl)
  return col
}

// "Add list" pseudo-column with inline input
function buildAddListCol(callbacks) {
  const col = document.createElement('div')
  col.className = 'board-col board-col-add'

  const addBtn = document.createElement('button')
  addBtn.className   = 'board-add-list-btn'
  addBtn.textContent = '+ New list'

  const form = document.createElement('div')
  form.className = 'board-add-list-form'
  form.hidden    = true

  const inp = document.createElement('input')
  inp.type        = 'text'
  inp.className   = 'board-add-list-input'
  inp.placeholder = 'List name'
  inp.maxLength   = 100

  const confirmBtn = document.createElement('button')
  confirmBtn.className   = 'board-add-list-confirm'
  confirmBtn.textContent = 'Add'

  const cancelBtn = document.createElement('button')
  cancelBtn.className   = 'board-add-list-cancel'
  cancelBtn.textContent = '✕'

  form.append(inp, confirmBtn, cancelBtn)

  const showForm = () => { addBtn.hidden = true; form.hidden = false; inp.value = ''; inp.focus() }
  const hideForm = () => { form.hidden = true; addBtn.hidden = false }
  const submit   = () => {
    const name = inp.value.trim()
    if (name) callbacks.onCreateList?.(name)
    hideForm()
  }

  addBtn.addEventListener('click', showForm)
  confirmBtn.addEventListener('click', submit)
  cancelBtn.addEventListener('click', hideForm)
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  submit()
    if (e.key === 'Escape') hideForm()
  })

  col.append(addBtn, form)
  return col
}

// ── Card ──────────────────────────────────────────────────────────────────────

function buildCard(item) {
  const isDone = item.status === 'COMPLETED'
  const card   = document.createElement('div')
  card.className         = `board-card${isDone ? ' board-card-done' : ''}`
  card.dataset.itemId    = item.id
  card.dataset.listId    = item.source.account_id
  card.dataset.extId     = item.source.external_id

  // Header row: title + optional snooze button
  const hdr = document.createElement('div')
  hdr.className = 'board-card-header'

  const titleEl = document.createElement('div')
  titleEl.className   = 'board-card-title'
  titleEl.textContent = item.title
  hdr.appendChild(titleEl)

  const iconGroup = document.createElement('div')
  iconGroup.className = 'card-icon-group'

  if (item.metadata?.recurrence && !isDone) {
    const recurIcon = document.createElement('span')
    recurIcon.className   = 'card-recur-icon'
    recurIcon.title       = 'Recurring task'
    recurIcon.textContent = '↻'
    iconGroup.appendChild(recurIcon)
  }

  if (item.due && !isDone) {
    const snoozeBtn = document.createElement('button')
    snoozeBtn.className   = 'card-snooze'
    snoozeBtn.title       = 'Snooze'
    snoozeBtn.textContent = '⏰'
    snoozeBtn.addEventListener('click', e => {
      e.stopPropagation()
      openSnoozePopover(snoozeBtn, item, () => _callbacks.onRefresh?.())
    })
    iconGroup.appendChild(snoozeBtn)
  }

  if (iconGroup.children.length) hdr.appendChild(iconGroup)

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
    if (diff < 0)        chip.classList.add('overdue')
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
  const listId    = cardEl.dataset.listId
  const extId     = cardEl.dataset.extId

  if (fromColId === toColId) {
    if (fromColId === DONE_COL_ID) return
    // Same-column reorder — persist to Google Tasks (no refresh; DOM already correct)
    const prevCard  = to.children[evt.newIndex - 1]
    const prevExtId = prevCard?.dataset.extId ?? null
    try {
      const token = await getToken()
      if (token) await reorderTask(token, listId, extId, prevExtId)
    } catch (err) {
      console.error('Reorder failed:', err)
      _callbacks.onRefresh?.()
    }
    return
  }

  try {
    const token = await getToken()
    if (!token) { _callbacks.onRefresh?.(); return }

    if (toColId === DONE_COL_ID) {
      const item = _boardItems.find(i => i.source.external_id === extId && i.source.account_id === listId)
      if (item?.metadata?.recurrence) await spawnNextRecurrence(token, item, listId)
      await completeTask(token, listId, extId)
    } else if (fromColId === DONE_COL_ID) {
      await uncompleteTask(token, listId, extId)
      if (toColId !== listId) await moveTask(token, listId, extId, toColId)
    } else {
      await moveTask(token, listId, extId, toColId)
    }
  } catch (err) {
    console.error('Drop failed:', err)
  }

  _callbacks.onRefresh?.()
}
