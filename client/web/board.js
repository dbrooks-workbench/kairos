import Sortable from 'sortablejs'
import { getToken } from './auth.js'
import {
  completeTask, uncompleteTask, patchTaskProps, patchTaskDate, rebalanceColumn,
} from './providers/calendarTasks.js'
import { patchTask } from './providers/googleTasksIntake.js'
import { getTaskColumnSort, setTaskColumnSort } from './providers/kairosPrefs.js'
import { updateStatus, deleteStatus } from './providers/kairosConfig.js'
import { appendLogEntry } from './providers/lifeLog.js'

const DONE_COL_ID = '__done__'

let _sortables  = []
let _callbacks  = {}
let _statuses   = []   // Kairos statuses [{id, calendarId, name, order, inProgress}] for the selected calendar
let _calendarId = null // calendar the board is scoped to
let _boardItems = []   // CalendarItem[] — calendar task events (all calendars; filtered to _calendarId at render)
let _doneWindow = 30

// The board renders one calendar at a time. Items whose statusId is missing or
// points at a status not on this calendar fall into the first (lowest-order)
// column — Intake by seed convention — so legacy/untriaged tasks surface there.
function _fallbackStatusId() {
  return _statuses[0]?.id ?? null
}

function _effectiveStatusId(item) {
  const sid = item.metadata?.statusId
  return (sid && _statuses.some(s => s.id === sid)) ? sid : _fallbackStatusId()
}

// ── Sort mode ─────────────────────────────────────────────────────────────────

function setColSort(statusId, mode) {
  if (getTaskColumnSort()[statusId] === mode) return
  setTaskColumnSort(statusId, mode)
  renderBoard(_statuses, _boardItems, _callbacks, _doneWindow, _calendarId)
}

function colSortMode(statusId) {
  return getTaskColumnSort()[statusId] ?? 'manual'
}

function sortedItems(items, statusId) {
  if (colSortMode(statusId) === 'date') {
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

  // Measure real height without a visible flash, then decide above vs below
  popover.style.visibility = 'hidden'
  popover.hidden = false
  const popoverHeight = popover.offsetHeight
  popover.hidden = true
  popover.style.visibility = ''

  const left       = Math.min(rect.left, window.innerWidth - popoverWidth - 8)
  const spaceBelow = window.innerHeight - rect.bottom - 8
  const top        = spaceBelow >= popoverHeight
    ? rect.bottom + 6
    : Math.max(8, rect.top - popoverHeight - 6)

  popover.style.top  = `${top}px`
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

export function renderBoard(statuses, boardItems, callbacks, doneWindow = 30, calendarId = null) {
  _statuses   = [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  _calendarId = calendarId
  _boardItems = boardItems
  _callbacks  = callbacks
  _doneWindow = doneWindow

  const scrollTops = {}
  document.querySelectorAll('.board-task-list[data-status-id]').forEach(el => {
    if (el.scrollTop > 0) scrollTops[el.dataset.statusId] = el.scrollTop
  })

  destroyBoard()
  const board = document.getElementById('board')

  // Only this calendar's task events; partition active tasks by effective status,
  // completed ones into the synthetic Done column.
  const items = calendarId
    ? boardItems.filter(i => i.source.account_id === calendarId)
    : boardItems
  const activeByStatus = {}
  const doneItems      = []

  for (const item of items) {
    if (item.status === 'COMPLETED') {
      doneItems.push(item)
    } else {
      const sid = _effectiveStatusId(item)
      if (!sid) continue
      if (!activeByStatus[sid]) activeByStatus[sid] = []
      activeByStatus[sid].push(item)
    }
  }

  for (const status of _statuses) {
    const colItems = sortedItems(activeByStatus[status.id] ?? [], status.id)
    const col      = buildCol(status, colItems, 'user', doneWindow)
    board.appendChild(col)
    _sortables.push(Sortable.create(col.querySelector('.board-task-list'), {
      group:      'tasks',
      animation:  150,
      ghostClass: 'board-ghost',
      dragClass:  'board-dragging',
      sort: colSortMode(status.id) !== 'date',
      onEnd: handleDrop,
    }))
  }

  const doneCol = buildCol(
    { id: DONE_COL_ID, name: 'Done', calendarId: null },
    doneItems.slice(0, 100), 'done', doneWindow,
  )
  board.appendChild(doneCol)
  board.appendChild(buildAddStatusCol(callbacks))
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

  document.querySelectorAll('.board-task-list[data-status-id]').forEach(el => {
    const saved = scrollTops[el.dataset.statusId]
    if (saved) el.scrollTop = saved
  })
}

// ── Column ────────────────────────────────────────────────────────────────────

function buildCol(status, items, colType, doneWindow) {
  const isUser = colType === 'user'
  const isDone = colType === 'done'

  const col = document.createElement('div')
  col.className = `board-col${isDone ? ' board-col-done' : ' board-col-reorderable'}`
  if (isUser) col.dataset.statusId = status.id

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
  titleEl.textContent = status.name ?? ''

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
      inp.value     = status.name ?? ''
      inp.maxLength = 100
      titleEl.replaceWith(inp)
      inp.focus()
      inp.select()

      let done = false
      const commit = async () => {
        if (done) return
        done = true
        const newName = inp.value.trim()
        if (newName && newName !== status.name) {
          try {
            const token = await getToken()
            if (token) await updateStatus(token, status.id, { name: newName })
            _callbacks.onRefresh?.()
          } catch (err) {
            console.error('Rename status failed:', err)
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

    // Hammer toggle: mark this status as an "in progress" stage. Many statuses
    // may be flagged; any task in a flagged status gets the green treatment.
    const hammerBtn = document.createElement('button')
    hammerBtn.className   = `col-inprogress-btn${status.inProgress ? ' active' : ''}`
    hammerBtn.textContent = '🔨'
    hammerBtn.title       = status.inProgress
      ? 'In-progress stage — click to unset'
      : 'Mark as an in-progress stage'
    hammerBtn.addEventListener('click', async () => {
      try {
        const token = await getToken()
        if (token) await updateStatus(token, status.id, { inProgress: !status.inProgress })
        _callbacks.onRefresh?.()
      } catch (err) {
        console.error('Toggle in-progress failed:', err)
      }
    })
    hdr.appendChild(hammerBtn)

    const isDate  = colSortMode(status.id) === 'date'
    const sortBtn = document.createElement('button')
    sortBtn.className   = `col-sort-date-btn${isDate ? ' active' : ''}`
    sortBtn.textContent = '📅'
    sortBtn.title       = isDate ? 'Sorted by date — click for manual order' : 'Sort by date'
    sortBtn.addEventListener('click', () => setColSort(status.id, isDate ? 'manual' : 'date'))
    hdr.appendChild(sortBtn)

    const addBtn = document.createElement('button')
    addBtn.className   = 'board-add-btn'
    addBtn.title       = 'New task'
    addBtn.textContent = '+'
    addBtn.addEventListener('click', () => _callbacks.onCreate?.(status.calendarId, status.id))
    hdr.appendChild(addBtn)

    const delBtn = document.createElement('button')
    delBtn.className   = 'board-col-delete-btn'
    delBtn.title       = 'Delete status'
    delBtn.textContent = '🗑'
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${status.name}"? Tasks in this status will move to the first column.`)) return
      try {
        const token = await getToken()
        if (token) await deleteStatus(token, status.id)
        _callbacks.onRefresh?.()
      } catch (err) {
        console.error('Delete status failed:', err)
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
  listEl.className        = 'board-task-list'
  listEl.dataset.statusId = status.id

  for (const item of items) listEl.appendChild(buildCard(item))

  col.append(hdr, listEl)
  return col
}

function buildAddStatusCol(callbacks) {
  const col = document.createElement('div')
  col.className = 'board-col board-col-add'

  const addBtn = document.createElement('button')
  addBtn.className   = 'board-add-list-btn'
  addBtn.textContent = '+ New status'

  const form = document.createElement('div')
  form.className = 'board-add-list-form'
  form.hidden    = true

  const inp = document.createElement('input')
  inp.type        = 'text'
  inp.className   = 'board-add-list-input'
  inp.placeholder = 'Status name'
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
    if (name) callbacks.onCreateStatus?.(name)
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
  // Green ring when the task's status is flagged in-progress (past-due, shown via
  // the red "overdue" due-chip, takes priority — suppress green then).
  const today     = new Date(); today.setHours(0, 0, 0, 0)
  const isPastDue = !isDone && item.due && new Date(item.due).setHours(0, 0, 0, 0) < today
  const st        = item.metadata?.statusId ? _statuses.find(s => s.id === item.metadata.statusId) : null
  const inProgress = !isDone && !isPastDue && !!st?.inProgress
  const card   = document.createElement('div')
  card.className          = `board-card${isDone ? ' board-card-done' : ''}${inProgress ? ' in-progress' : ''}`
  card.dataset.itemId     = item.id
  card.dataset.statusId   = _effectiveStatusId(item) ?? ''
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

  if (item.metadata?.dueDate) {
    const d = new Date(item.metadata.dueDate)
    const chip = document.createElement('span')
    chip.className   = 'board-chip board-chip-deadline'
    chip.textContent = `⚑ ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
    chip.title       = 'Due by'
    chips.push(chip)
  }

  if (item.metadata?.loe) {
    const chip = document.createElement('span')
    chip.className   = 'board-chip board-chip-loe'
    chip.textContent = item.metadata.loe
    chips.push(chip)
  }

  if (item.recurrence || item.metadata?.recurringEventId) {
    const chip = document.createElement('span')
    chip.className   = 'board-chip board-chip-recur'
    chip.textContent = '↻ Recurring'
    chip.title       = item.recurrence ?? ''
    chips.push(chip)
  }

  return chips
}

// ── Drag-drop ─────────────────────────────────────────────────────────────────

async function handleDrop(evt) {
  const { item: cardEl, from, to } = evt
  if (from === to && evt.oldIndex === evt.newIndex) return

  const fromStatusId = from.dataset.statusId
  const toStatusId   = to.dataset.statusId
  const calendarId   = cardEl.dataset.calendarId
  const extId        = cardEl.dataset.extId

  if (fromStatusId === toStatusId) {
    if (fromStatusId === DONE_COL_ID) return
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
      const colItems = _boardItems.filter(i =>
        i.status !== 'COMPLETED' && i.source.account_id === calendarId &&
        _effectiveStatusId(i) === fromStatusId
      )
      const token = await getToken()
      if (token) await rebalanceColumn(token, calendarId, colItems)
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

  const srcItem    = _boardItems.find(i => i.source.external_id === extId)
  const isDoneMove = toStatusId === DONE_COL_ID || fromStatusId === DONE_COL_ID
  const isAdopt    = !isDoneMove && !!srcItem?.metadata?.unprocessed

  // Completion transitions and unprocessed-adoption change more than a card's
  // column (title prefix/footer, isTask tagging), so fall back to a full refresh.
  if (isDoneMove || isAdopt) {
    try {
      if (toStatusId === DONE_COL_ID) {
        await completeTask(token, calendarId, extId, srcItem?.title ?? '')
      } else if (fromStatusId === DONE_COL_ID) {
        await uncompleteTask(token, calendarId, extId, srcItem?.title ?? '')
        if (toStatusId) await patchTaskProps(token, calendarId, extId, { statusId: toStatusId })
      } else {
        const masterEventId = srcItem.metadata.recurringEventId ?? extId
        await patchTaskProps(token, calendarId, masterEventId, { isTask: 'true', statusId: toStatusId })
      }
    } catch (err) {
      console.error('Drop failed:', err)
    }
    _callbacks.onRefresh?.()
    return
  }

  // Plain status move: Sortable already moved the card. Persist in the background
  // and refresh only this one card (for the in-progress ring), leaving the rest
  // of the board intact so the next drag can start immediately — no full rebuild.
  try {
    const updated = await patchTaskProps(token, calendarId, extId, { statusId: toStatusId })
    const idx = _boardItems.findIndex(i => i.source.external_id === extId)
    if (idx >= 0) _boardItems[idx] = updated
    cardEl.replaceWith(buildCard(updated))
    _updateColumnCounts()
  } catch (err) {
    console.error('Move failed:', err)
    _callbacks.onRefresh?.()   // reconcile the board on failure
  }
}

// Update each column's count badge from its current card count in the DOM.
// Used after an optimistic move so counts stay correct without a full re-render.
function _updateColumnCounts() {
  document.querySelectorAll('#board .board-col').forEach(col => {
    const list  = col.querySelector('.board-task-list')
    const count = col.querySelector('.board-col-count')
    if (list && count) count.textContent = list.children.length
  })
}

async function handleColReorder() {
  const board  = document.getElementById('board')
  const colEls = [...board.querySelectorAll('.board-col-reorderable')]
  const token  = await getToken()
  if (!token) return

  await Promise.allSettled(
    colEls.map((el, i) => {
      const statusId = el.dataset.statusId
      const newOrder = (i + 1) * 10
      const status   = _statuses.find(s => s.id === statusId)
      if (!status || Math.abs((status.order ?? 0) - newOrder) < 0.1) return Promise.resolve()
      return updateStatus(token, statusId, { order: newOrder })
    })
  )
}
