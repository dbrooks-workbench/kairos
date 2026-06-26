import Sortable from 'sortablejs'
import { getToken } from './auth.js'
import {
  completeTask, uncompleteTask, patchTaskProps, patchTaskDate, rebalanceColumn,
} from './providers/calendarTasks.js'
import { patchTask } from './providers/googleTasksIntake.js'
import { getTaskColumnSort, setTaskColumnSort } from './providers/kairosPrefs.js'
import { updateList, deleteList } from './providers/kairosLists.js'
import { appendLogEntry } from './providers/lifeLog.js'

const DONE_COL_ID     = '__done__'
const UNLISTED_COL_ID = '__unlisted__'

let _sortables  = []
let _callbacks  = {}
let _taskLists  = []   // Kairos lists [{id, calendarId, name, order}]
let _boardItems = []   // CalendarItem[] — calendar task events
let _doneWindow = 30

// ── Sort mode ─────────────────────────────────────────────────────────────────

function setColSort(listId, mode) {
  if (getTaskColumnSort()[listId] === mode) return
  setTaskColumnSort(listId, mode)
  renderBoard(_taskLists, _boardItems, _callbacks, _doneWindow)
}

function colSortMode(listId) {
  return getTaskColumnSort()[listId] ?? 'manual'
}

function sortedItems(items, listId) {
  if (colSortMode(listId) === 'date') {
    return [...items].sort((a, b) => {
      if (!a.due && !b.due) return 0
      if (!a.due) return 1
      if (!b.due) return -1
      return a.due - b.due
    })
  }
  return [...items].sort((a, b) => (a.metadata?.order ?? 0) - (b.metadata?.order ?? 0))
}

// ── Snooze popover ────────────────────────────────────────────────────────────

let _snoozeItem      = null
let _snoozeOnRefresh = null
let _activeSnoozeBtn = null
let _snoozeActionFn  = null

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

  const newDateStr = `${newDue.getFullYear()}-${pad(newDue.getMonth()+1)}-${pad(newDue.getDate())}`

  try {
    const token = await getToken()
    if (token) {
      if (item.source.provider === 'google-calendar-task') {
        await patchTaskDate(token, item.source.account_id, item.source.external_id, newDateStr)
      } else {
        // Legacy Google Tasks fallback (calendar view chips during migration)
        await patchTask(token, item.source.account_id, item.source.external_id, {
          due: `${newDateStr}T00:00:00.000Z`,
        })
      }
      appendLogEntry(token, {
        item_id:       item.id,
        item_type:     'TASK',
        title:         item.title,
        verb:          'snoozed',
        action_detail: { verb: 'snoozed', to: newDateStr },
        narrative:     `Snoozed "${item.title}" to ${dateLabel}`,
        context:       item.metadata?.list_title ?? '',
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

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const daysToSat = (6 - today.getDay() + 7) % 7 || 7
  const daysToMon = (1 - today.getDay() + 7) % 7 || 7
  const fmt = d => {
    const dow = d.toLocaleDateString('en-US', { weekday: 'short' })
    return `${dow} ${d.getMonth() + 1}/${d.getDate()}`
  }
  const mkDate = n => { const d = new Date(today); d.setDate(d.getDate() + n); return d }

  document.getElementById('snooze-q-tomorrow').textContent  = `Tomorrow (${fmt(mkDate(1))})`
  document.getElementById('snooze-q-tomorrow').dataset.days = 1
  document.getElementById('snooze-q-weekend').textContent   = `This weekend (${fmt(mkDate(daysToSat))})`
  document.getElementById('snooze-q-weekend').dataset.days  = daysToSat
  document.getElementById('snooze-q-nextweek').textContent  = `Next week (${fmt(mkDate(daysToMon))})`
  document.getElementById('snooze-q-nextweek').dataset.days = daysToMon

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

// ── Board render ──────────────────────────────────────────────────────────────

export function destroyBoard() {
  _sortables.forEach(s => { try { s.destroy() } catch {} })
  _sortables = []
  document.getElementById('board').innerHTML = ''
}

export function renderBoard(taskLists, boardItems, callbacks, doneWindow = 30) {
  _taskLists  = taskLists
  _boardItems = boardItems
  _callbacks  = callbacks
  _doneWindow = doneWindow

  const scrollTops = {}
  document.querySelectorAll('.board-task-list[data-list-id]').forEach(el => {
    if (el.scrollTop > 0) scrollTops[el.dataset.listId] = el.scrollTop
  })

  destroyBoard()
  const board = document.getElementById('board')

  // Partition: active tasks keyed by Firestore listId, completed in Done, unassigned in Unlisted
  const knownListIds  = new Set(taskLists.map(l => l.id))
  const activeByList  = {}
  const doneItems     = []
  const unlistedItems = []

  for (const item of boardItems) {
    if (item.status === 'COMPLETED') {
      doneItems.push(item)
    } else {
      const lid = item.metadata?.listId
      if (lid && knownListIds.has(lid)) {
        if (!activeByList[lid]) activeByList[lid] = []
        activeByList[lid].push(item)
      } else {
        unlistedItems.push(item)
      }
    }
  }

  // Columns in ascending list.order
  const sorted = [...taskLists].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (const list of sorted) {
    const items = sortedItems(activeByList[list.id] ?? [], list.id)
    const col   = buildCol(list, items, 'user', doneWindow)
    board.appendChild(col)
    _sortables.push(Sortable.create(col.querySelector('.board-task-list'), {
      group:      'tasks',
      animation:  150,
      ghostClass: 'board-ghost',
      dragClass:  'board-dragging',
      sort: colSortMode(list.id) !== 'date',
      onEnd: handleDrop,
    }))
  }

  if (unlistedItems.length > 0) {
    const unlistedCol = buildCol(
      { id: UNLISTED_COL_ID, name: 'Unlisted', calendarId: null },
      unlistedItems, 'unlisted', doneWindow,
    )
    board.appendChild(unlistedCol)
    _sortables.push(Sortable.create(unlistedCol.querySelector('.board-task-list'), {
      group:      { name: 'tasks', pull: true, put: false },
      animation:  150,
      ghostClass: 'board-ghost',
      sort:       false,
      onEnd:      handleDrop,
    }))
  }

  const doneCol = buildCol(
    { id: DONE_COL_ID, name: 'Done', calendarId: null },
    doneItems.slice(0, 100), 'done', doneWindow,
  )
  board.appendChild(doneCol)
  board.appendChild(buildAddListCol(callbacks))
  _sortables.push(Sortable.create(doneCol.querySelector('.board-task-list'), {
    group:      'tasks',
    animation:  150,
    ghostClass: 'board-ghost',
    onEnd: handleDrop,
  }))

  _sortables.push(Sortable.create(board, {
    animation:  150,
    handle:     '.board-col-drag-handle',
    draggable:  '.board-col-reorderable',
    ghostClass: 'board-col-ghost',
    onEnd: handleColReorder,
  }))

  document.querySelectorAll('.board-task-list[data-list-id]').forEach(el => {
    const saved = scrollTops[el.dataset.listId]
    if (saved) el.scrollTop = saved
  })
}

// ── Column ────────────────────────────────────────────────────────────────────

function buildCol(list, items, colType, doneWindow) {
  const isUser     = colType === 'user'
  const isDone     = colType === 'done'
  const isUnlisted = colType === 'unlisted'

  const col = document.createElement('div')
  col.className = `board-col${isDone ? ' board-col-done' : isUnlisted ? ' board-col-unlisted' : ' board-col-reorderable'}`
  if (isUser) col.dataset.listId = list.id

  const hdr = document.createElement('div')
  hdr.className = 'board-col-header'

  if (isUser) {
    const dragHandle = document.createElement('span')
    dragHandle.className   = 'board-col-drag-handle'
    dragHandle.textContent = '⠿'
    dragHandle.title       = 'Drag to reorder'
    hdr.appendChild(dragHandle)
  }

  const titleEl = document.createElement('span')
  titleEl.className   = 'board-col-title'
  titleEl.textContent = list.name ?? ''

  const countEl = document.createElement('span')
  countEl.className   = 'board-col-count'
  countEl.textContent = items.length

  hdr.append(titleEl, countEl)

  if (isUser) {
    titleEl.title        = 'Click to rename'
    titleEl.style.cursor = 'text'
    titleEl.addEventListener('click', () => {
      const inp = document.createElement('input')
      inp.type      = 'text'
      inp.className = 'board-col-title-input'
      inp.value     = list.name ?? ''
      inp.maxLength = 100
      titleEl.replaceWith(inp)
      inp.focus()
      inp.select()

      let done = false
      const commit = async () => {
        if (done) return
        done = true
        const newName = inp.value.trim()
        if (newName && newName !== list.name) {
          try {
            const token = await getToken()
            if (token) await updateList(token, list.id, { name: newName })
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
    addBtn.addEventListener('click', () => _callbacks.onCreate?.(list.calendarId, list.id))
    hdr.appendChild(addBtn)

    const delBtn = document.createElement('button')
    delBtn.className   = 'board-col-delete-btn'
    delBtn.title       = 'Delete list'
    delBtn.textContent = '🗑'
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${list.name}"? Tasks in this list will become unassigned.`)) return
      try {
        const token = await getToken()
        if (token) await deleteList(token, list.id)
        _callbacks.onRefresh?.()
      } catch (err) {
        console.error('Delete list failed:', err)
      }
    })
    hdr.appendChild(delBtn)
  }

  if (isDone) {  // Done-window toggle only on sentinel Done column
    const toggle = document.createElement('div')
    toggle.className = 'done-window-toggle'
    for (const days of [7, 30, 90]) {
      const btn = document.createElement('button')
      btn.className   = `done-window-btn${days === doneWindow ? ' active' : ''}`
      btn.textContent = `${days}d`
      btn.addEventListener('click', () => _callbacks.onDoneWindowChange?.(days))
      toggle.appendChild(btn)
    }
    hdr.appendChild(toggle)
  }

  const listEl = document.createElement('div')
  listEl.className      = 'board-task-list'
  listEl.dataset.listId = list.id

  for (const item of items) listEl.appendChild(buildCard(item))

  col.append(hdr, listEl)
  return col
}

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
  card.className          = `board-card${isDone ? ' board-card-done' : ''}`
  card.dataset.itemId     = item.id
  card.dataset.listId     = item.metadata?.listId ?? ''
  card.dataset.calendarId = item.source.account_id
  card.dataset.extId      = item.source.external_id
  card.dataset.order      = String(item.metadata?.order ?? 0)

  const hdr = document.createElement('div')
  hdr.className = 'board-card-header'

  const titleEl = document.createElement('div')
  titleEl.className   = 'board-card-title'
  titleEl.textContent = item.title
  hdr.appendChild(titleEl)

  const iconGroup = document.createElement('div')
  iconGroup.className = 'card-icon-group'

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

  return chips
}

// ── Drag-drop ─────────────────────────────────────────────────────────────────

async function handleDrop(evt) {
  const { item: cardEl, from, to } = evt
  if (from === to && evt.oldIndex === evt.newIndex) return

  const fromListId  = from.dataset.listId
  const toListId    = to.dataset.listId
  const calendarId  = cardEl.dataset.calendarId
  const extId       = cardEl.dataset.extId

  if (fromListId === toListId) {
    if (fromListId === DONE_COL_ID) return
    // Same-column reorder: compute new order float from neighbors
    const cards   = [...to.children]
    const idx     = cards.indexOf(cardEl)
    const prevOrd = idx > 0                ? parseFloat(cards[idx - 1].dataset.order) : null
    const nextOrd = idx < cards.length - 1 ? parseFloat(cards[idx + 1].dataset.order) : null

    let newOrder
    if (prevOrd === null && nextOrd === null) {
      newOrder = 10
    } else if (prevOrd === null) {
      newOrder = nextOrd - 10
    } else if (nextOrd === null) {
      newOrder = prevOrd + 10
    } else {
      newOrder = (prevOrd + nextOrd) / 2
    }

    if (!isFinite(newOrder) || newOrder === prevOrd || newOrder === nextOrd) {
      // Float precision exhausted — rebalance the whole column
      const listItems = _boardItems.filter(i =>
        i.metadata?.listId === fromListId && i.status !== 'COMPLETED'
      )
      const token = await getToken()
      if (token) await rebalanceColumn(token, calendarId, fromListId, listItems)
      _callbacks.onRefresh?.()
      return
    }

    try {
      const token = await getToken()
      if (token) {
        await patchTaskProps(token, calendarId, extId, { order: newOrder })
        cardEl.dataset.order = String(newOrder)
      }
    } catch (err) {
      console.error('Reorder failed:', err)
      _callbacks.onRefresh?.()
    }
    return
  }

  // Cross-column move
  const token = await getToken()
  if (!token) { _callbacks.onRefresh?.(); return }

  try {
    if (toListId === DONE_COL_ID) {
      await completeTask(token, calendarId, extId)
    } else if (fromListId === DONE_COL_ID) {
      await uncompleteTask(token, calendarId, extId)
      if (toListId) await patchTaskProps(token, calendarId, extId, { listId: toListId })
    } else {
      const srcItem = _boardItems.find(i => i.source.external_id === extId)
      const extra   = srcItem?.metadata?.unprocessed ? { isTask: 'true' } : {}
      await patchTaskProps(token, calendarId, extId, { listId: toListId, ...extra })
    }
  } catch (err) {
    console.error('Drop failed:', err)
  }

  _callbacks.onRefresh?.()
}

async function handleColReorder() {
  const board  = document.getElementById('board')
  const colEls = [...board.querySelectorAll('.board-col-reorderable')]
  const token  = await getToken()
  if (!token) return

  await Promise.allSettled(
    colEls.map((el, i) => {
      const listId   = el.dataset.listId
      const newOrder = (i + 1) * 10
      const list     = _taskLists.find(l => l.id === listId)
      if (!list || Math.abs((list.order ?? 0) - newOrder) < 0.1) return Promise.resolve()
      return updateList(token, listId, { order: newOrder })
    })
  )
}
