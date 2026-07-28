// List view — tasks organized by Kairos list (the organization axis), for a
// single project calendar. Sibling to the board (which is the status axis);
// deliberately isolated in implementation but reuses the board's card/column
// CSS, the snooze popover, and Sortable mechanics for visual + functional parity.
//
// Sort within a list is automatic (no manual order): in-progress first, then by
// due date (undated last), then alphabetical. There is no synthetic Done column —
// completed tasks are omitted (this is a "what I need to do" surface).

import Sortable from 'sortablejs'
import { getToken } from './auth.js'
import { patchTaskProps } from './providers/calendarTasks.js'
import { updateList, deleteList } from './providers/kairosLists.js'
import { getInProgressStatusIds } from './providers/kairosConfig.js'
import { openSnoozePopover } from './board.js'

const UNLISTED_COL_ID = '__unlisted__'

let _sortables     = []
let _callbacks     = {}
let _lists         = []    // lists for the selected calendar, ascending order
let _calendarId    = null
let _items         = []    // CalendarItem[] (all calendars; filtered at render)
let _inProgressIds = new Set()

function _isInProgress(item) {
  const sid = item.metadata?.statusId
  return !!sid && _inProgressIds.has(sid)
}

// In-progress first, then due date (undated last), then title.
function _sortItems(items) {
  return [...items].sort((a, b) => {
    const ap = _isInProgress(a) ? 0 : 1
    const bp = _isInProgress(b) ? 0 : 1
    if (ap !== bp) return ap - bp
    const ad = a.due ? +new Date(a.due) : Infinity
    const bd = b.due ? +new Date(b.due) : Infinity
    if (ad !== bd) return ad - bd
    return (a.title ?? '').localeCompare(b.title ?? '')
  })
}

export function destroyList() {
  _sortables.forEach(s => { try { s.destroy() } catch {} })
  _sortables = []
  const listEl = document.getElementById('list')
  if (listEl) listEl.innerHTML = ''
}

export function renderList(lists, items, callbacks, calendarId = null) {
  _lists         = [...lists].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  _calendarId    = calendarId
  _items         = items
  _callbacks     = callbacks
  _inProgressIds = getInProgressStatusIds()

  const scrollTops = {}
  document.querySelectorAll('#list .board-task-list[data-list-id]').forEach(el => {
    if (el.scrollTop > 0) scrollTops[el.dataset.listId] = el.scrollTop
  })

  destroyList()
  const listRoot = document.getElementById('list')

  // This calendar's incomplete task events, partitioned by listId (unknown → Unlisted).
  const scoped        = (calendarId ? items.filter(i => i.source.account_id === calendarId) : items)
    .filter(i => i.status !== 'COMPLETED')
  const knownListIds  = new Set(_lists.map(l => l.id))
  const byList        = {}
  const unlistedItems = []
  for (const item of scoped) {
    const lid = item.metadata?.listId
    if (lid && knownListIds.has(lid)) (byList[lid] ??= []).push(item)
    else unlistedItems.push(item)
  }

  for (const list of _lists) {
    const col = buildCol(list, _sortItems(byList[list.id] ?? []), 'user')
    listRoot.appendChild(col)
    _sortables.push(Sortable.create(col.querySelector('.board-task-list'), {
      group:      'listtasks',
      animation:  150,
      ghostClass: 'board-ghost',
      dragClass:  'board-dragging',
      sort:       false,   // within-list order is automatic
      onEnd:      handleDrop,
    }))
  }

  if (unlistedItems.length > 0) {
    const col = buildCol(
      { id: UNLISTED_COL_ID, name: 'Unlisted', calendarId }, _sortItems(unlistedItems), 'unlisted',
    )
    listRoot.appendChild(col)
    _sortables.push(Sortable.create(col.querySelector('.board-task-list'), {
      group:      { name: 'listtasks', pull: true, put: false },
      animation:  150,
      ghostClass: 'board-ghost',
      sort:       false,
      onEnd:      handleDrop,
    }))
  }

  listRoot.appendChild(buildAddListCol(callbacks))

  _sortables.push(Sortable.create(listRoot, {
    animation:  150,
    handle:     '.board-col-drag-handle',
    draggable:  '.board-col-reorderable',
    ghostClass: 'board-col-ghost',
    onEnd:      handleColReorder,
  }))

  document.querySelectorAll('#list .board-task-list[data-list-id]').forEach(el => {
    const saved = scrollTops[el.dataset.listId]
    if (saved) el.scrollTop = saved
  })
}

// ── Column ────────────────────────────────────────────────────────────────────

function buildCol(list, items, colType) {
  const isUser = colType === 'user'

  const col = document.createElement('div')
  col.className = `board-col${isUser ? ' board-col-reorderable' : ' board-col-unlisted'}`
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
      if (!confirm(`Delete "${list.name}"? Tasks in this list will become unlisted.`)) return
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

  const body = document.createElement('div')
  body.className        = 'board-task-list'
  body.dataset.listId   = list.id
  for (const item of items) body.appendChild(buildCard(item))

  col.append(hdr, body)
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
  const today     = new Date(); today.setHours(0, 0, 0, 0)
  const isPastDue = item.due && new Date(item.due).setHours(0, 0, 0, 0) < today
  const inProgress = !isPastDue && _isInProgress(item)

  const card = document.createElement('div')
  card.className          = `board-card${inProgress ? ' in-progress' : ''}`
  card.dataset.itemId     = item.id
  card.dataset.listId     = item.metadata?.listId ?? ''
  card.dataset.calendarId = item.source.account_id
  card.dataset.extId      = item.source.external_id

  const hdr = document.createElement('div')
  hdr.className = 'board-card-header'

  const titleEl = document.createElement('div')
  titleEl.className   = 'board-card-title'
  titleEl.textContent = item.title
  hdr.appendChild(titleEl)

  if (item.due) {
    const snoozeBtn = document.createElement('button')
    snoozeBtn.className   = 'card-snooze'
    snoozeBtn.title       = 'Snooze'
    snoozeBtn.textContent = '⏰'
    snoozeBtn.addEventListener('click', e => {
      e.stopPropagation()
      openSnoozePopover(snoozeBtn, item, () => _callbacks.onRefresh?.())
    })
    const iconGroup = document.createElement('div')
    iconGroup.className = 'card-icon-group'
    iconGroup.appendChild(snoozeBtn)
    hdr.appendChild(iconGroup)
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
  const fromListId = from.dataset.listId
  const toListId   = to.dataset.listId
  if (fromListId === toListId) return   // within-list: auto-sorted, nothing to persist

  const calendarId = cardEl.dataset.calendarId
  const extId      = cardEl.dataset.extId
  const newListId  = toListId === UNLISTED_COL_ID ? '' : toListId

  const token = await getToken()
  if (!token) { _callbacks.onRefresh?.(); return }

  const srcItem = _items.find(i => i.source.external_id === extId)

  // Unprocessed adoption needs a refresh (isTask tagging); a plain list move does
  // not change the card's look, so persist optimistically without rebuilding.
  if (srcItem?.metadata?.unprocessed) {
    try {
      const masterEventId = srcItem.metadata.recurringEventId ?? extId
      await patchTaskProps(token, calendarId, masterEventId, { isTask: 'true', listId: newListId })
    } catch (err) {
      console.error('List move failed:', err)
    }
    _callbacks.onRefresh?.()
    return
  }

  try {
    await patchTaskProps(token, calendarId, extId, { listId: newListId })
    if (srcItem) srcItem.metadata.listId = newListId || null
    cardEl.dataset.listId = newListId
    _updateColumnCounts()
  } catch (err) {
    console.error('List move failed:', err)
    _callbacks.onRefresh?.()
  }
}

// Update each list column's count badge from its current DOM card count, after
// an optimistic move — keeps counts correct without a full re-render.
function _updateColumnCounts() {
  document.querySelectorAll('#list .board-col').forEach(col => {
    const body  = col.querySelector('.board-task-list')
    const count = col.querySelector('.board-col-count')
    if (body && count) count.textContent = body.children.length
  })
}

async function handleColReorder() {
  const root   = document.getElementById('list')
  const colEls = [...root.querySelectorAll('.board-col-reorderable')]
  const token  = await getToken()
  if (!token) return

  await Promise.allSettled(
    colEls.map((el, i) => {
      const listId   = el.dataset.listId
      const newOrder = (i + 1) * 10
      const list     = _lists.find(l => l.id === listId)
      if (!list || Math.abs((list.order ?? 0) - newOrder) < 0.1) return Promise.resolve()
      return updateList(token, listId, { order: newOrder })
    })
  )
}
