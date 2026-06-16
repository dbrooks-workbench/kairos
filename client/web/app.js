import { getTokens, getToken, getTokenFor, isAuthenticated, logout, logoutAccount, addAccount, loginUrl } from './auth.js'
import { getCalendars, getEvents } from './providers/googleCalendar.js'
import { getTasks, completeTask, uncompleteTask, getAllTasks, getTaskLists } from './providers/googleTasks.js'
import { renderBoard, destroyBoard, initSnooze, openSnoozePopover } from './board.js'
import { initModal, openModal, openCreateModal } from './modal.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const VERSION   = '0.5.0'

const state = {
  weekStart: getWeekStart(new Date()),
  items: [],
  calendars: [],
  hiddenCalendars: new Set(JSON.parse(localStorage.getItem('kairos:hidden-cals') ?? '[]')),
  allDayExpanded: false,   // false = top-3 cap; true = show all
  view: 'calendar',        // 'calendar' | 'board'
  taskLists: [],           // raw Google Tasks list objects (for board columns + modal)
  boardItems: [],          // CalendarItem[] — all tasks, no date filter
}

// ── Date helpers ─────────────────────────────────────────────────────────────

// Compare by local calendar date (year/month/day) using Date.UTC so that DST
// offsets cancel out and a "day" is always exactly 86 400 000 ms.
function localDayIndex(date, weekStart) {
  const a = Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate())
  const b = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((b - a) / 86_400_000)
}

function getWeekStart(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return d
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate()
}

function formatWeekLabel(start) {
  const end = addDays(start, 6)
  const opts = { month: 'long', day: 'numeric' }
  const s = start.toLocaleDateString('en-US', opts)
  const e = start.getMonth() === end.getMonth()
    ? end.getDate()
    : end.toLocaleDateString('en-US', opts)
  return `${s}–${e}`
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function loadCalendars() {
  const accounts = await getTokens()
  if (!accounts.length) return
  try {
    const lists = await Promise.all(accounts.map(a => getCalendars(a.token).catch(() => [])))
    state.calendars = lists.flat()
    renderCalendarPicker()
  } catch (err) {
    console.error('Failed to load calendar list:', err)
  }
}

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function fetchItems(start, end) {
  const accounts = await getTokens()
  if (!accounts.length) return []
  const perAccount = await Promise.all(accounts.map(async acct => {
    const [events, tasks] = await Promise.all([
      getEvents(acct.token, start, end).catch(err => { console.error('Calendar fetch failed:', err); return [] }),
      getTasks(acct.token, start, end).catch(err => { console.error('Tasks fetch failed:', err); return [] }),
    ])
    // Tag every item with the owning account so mutations can find the right token
    const tag = items => items.map(i => ({ ...i, source: { ...i.source, owner_account: acct.id } }))
    return [...tag(events), ...tag(tasks)]
  }))
  return perAccount.flat()
}

async function handleToggleTask(item) {
  const token = await getTokenFor(item.source.owner_account)
  if (!token) return
  const isDone = item.status === 'COMPLETED'
  try {
    if (isDone) {
      await uncompleteTask(token, item.source.account_id, item.source.external_id)
      const target = state.items.find(i => i.id === item.id)
      if (target) target.status = 'NEEDS_ACTION'
    } else {
      await completeTask(token, item.source.account_id, item.source.external_id)
      const target = state.items.find(i => i.id === item.id)
      if (target) target.status = 'COMPLETED'
    }
    renderItems(getVisibleItems())
  } catch (err) {
    console.error('Failed to toggle task:', err)
  }
}

// ── Loading indicator ─────────────────────────────────────────────────────────

function showLoading() { document.getElementById('loading-bar').hidden = false }
function hideLoading() { document.getElementById('loading-bar').hidden = true  }

// ── Calendar-view modal callbacks ─────────────────────────────────────────────

async function refreshCalendarItems() {
  const end  = addDays(state.weekStart, 7)
  state.items = await fetchItems(state.weekStart, end)
  renderItems(getVisibleItems())
}

function calendarModalCallbacks() {
  return { onSaved: refreshCalendarItems, onDeleted: refreshCalendarItems, onToggleDone: refreshCalendarItems }
}

// Ensure task lists are loaded (needed by the modal's list selector).
// Called lazily before first modal open if render() hasn't populated them yet.
async function ensureTaskLists() {
  if (state.taskLists.length) return
  const accounts = await getTokens()
  if (!accounts.length) return
  const lists = await Promise.all(accounts.map(a => getTaskLists(a.token).catch(() => [])))
  state.taskLists = lists.flat()
}

// ── View switching ────────────────────────────────────────────────────────────

function setView(v) {
  state.view = v
  document.getElementById('calendar').hidden = v !== 'calendar'
  document.getElementById('board').hidden    = v !== 'board'
  document.getElementById('btn-view-calendar').classList.toggle('active', v === 'calendar')
  document.getElementById('btn-view-board').classList.toggle('active', v === 'board')

  stopPolling()
  if (v === 'board') {
    loadBoardData()
    startPolling(60_000)
  } else {
    startPolling(120_000)
  }
}

// ── Polling ───────────────────────────────────────────────────────────────────

let _pollHandle = null

function startPolling(ms) {
  stopPolling()
  _pollHandle = setInterval(async () => {
    if (document.hidden) return
    if (state.view === 'board') {
      await loadBoardData()
    } else {
      const end  = addDays(state.weekStart, 7)
      state.items = await fetchItems(state.weekStart, end)
      renderItems(getVisibleItems())
    }
  }, ms)
}

function stopPolling() {
  if (_pollHandle !== null) { clearInterval(_pollHandle); _pollHandle = null }
}

// Resume immediately when the user returns to the tab
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  if (state.view === 'board') loadBoardData()
  else fetchItems(state.weekStart, addDays(state.weekStart, 7)).then(items => {
    state.items = items
    renderItems(getVisibleItems())
  })
})

// ── Board data + callbacks ────────────────────────────────────────────────────

function boardCallbacks() {
  return {
    onCreate:     listId  => openCreateModal(listId, state.taskLists, { onSaved: loadBoardData }),
    onEdit:       item    => openModal(item, state.taskLists, {
      onSaved:      loadBoardData,
      onDeleted:    loadBoardData,
      onToggleDone: loadBoardData,
    }),
    onRefresh: loadBoardData,
  }
}

async function loadBoardData() {
  const accounts = await getTokens()
  if (!accounts.length) return
  showLoading()
  try {
    const results = await Promise.all(accounts.map(a => getAllTasks(a.token).then(({ lists, tasks }) => ({
      lists,
      tasks: tasks.map(t => ({ ...t, source: { ...t.source, owner_account: a.id } })),
    })).catch(err => { console.error('Board data load failed:', err); return { lists: [], tasks: [] } })))
    state.taskLists  = results.flatMap(r => r.lists)
    state.boardItems = results.flatMap(r => r.tasks)
    renderBoard(state.taskLists, state.boardItems, boardCallbacks())
  } finally {
    hideLoading()
  }
}

// Filter already-fetched items by calendar visibility — no network call needed.
function getVisibleItems() {
  return state.items.filter(item =>
    item.item_type !== 'EVENT' || !state.hiddenCalendars.has(item.source.account_id)
  )
}

// ── Calendar picker ───────────────────────────────────────────────────────────

function updateCalPickerBadge() {
  const visible = state.calendars.filter(c => !state.hiddenCalendars.has(c.id))
  document.getElementById('btn-calendars').innerHTML =
    `Calendars <span class="count">${visible.length}/${state.calendars.length}</span>`
}

function renderCalendarPicker() {
  const panel = document.getElementById('cal-picker-panel')
  updateCalPickerBadge()

  if (state.calendars.length === 0) {
    panel.innerHTML = '<div class="cal-picker-empty">No calendars found</div>'
    return
  }

  panel.innerHTML = state.calendars.map(cal => `
    <label class="cal-picker-item">
      <input type="checkbox" data-cal-id="${cal.id}"
             ${state.hiddenCalendars.has(cal.id) ? '' : 'checked'}>
      <span class="cal-swatch" style="background:${cal.backgroundColor ?? '#1a73e8'}"></span>
      <span title="${cal.summary}">${cal.summary}</span>
    </label>
  `).join('')

  panel.querySelectorAll('input[type=checkbox]').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = cb.dataset.calId
      if (cb.checked) state.hiddenCalendars.delete(id)
      else            state.hiddenCalendars.add(id)
      localStorage.setItem('kairos:hidden-cals', JSON.stringify([...state.hiddenCalendars]))
      updateCalPickerBadge()
      renderItems(getVisibleItems())
    })
  })
}

// Toggle all-day between top-3 cap and show-all
document.getElementById('btn-allday-toggle').addEventListener('click', () => {
  state.allDayExpanded = !state.allDayExpanded
  renderAllDayToggle()
  renderItems(getVisibleItems())
})

// Toggle picker panel open/close
document.getElementById('btn-calendars').addEventListener('click', e => {
  e.stopPropagation()
  const panel = document.getElementById('cal-picker-panel')
  panel.hidden = !panel.hidden
})

document.addEventListener('click', () => {
  document.getElementById('cal-picker-panel').hidden = true
})

document.getElementById('cal-picker-panel').addEventListener('click', e => {
  e.stopPropagation()
})

// ── Auth UI ──────────────────────────────────────────────────────────────────

async function renderAccountStatus() {
  const accounts = await getTokens()
  const statusEl  = document.getElementById('account-status')
  const bannerEl  = document.getElementById('connect-banner')

  if (!accounts.length) {
    statusEl.innerHTML = `<a href="${loginUrl()}">Sign in</a>`
    bannerEl.style.display = 'flex'
    return
  }

  bannerEl.style.display = 'none'
  statusEl.innerHTML = accounts.map(a => `
    <span class="account-pill">
      <span class="account-email" title="${escHtml(a.email ?? 'Account')}">${escHtml(a.email ?? 'Account')}</span>
      <button class="account-remove" data-id="${escHtml(a.id)}" title="Disconnect">×</button>
    </span>
  `).join('') + `<button id="btn-add-account" class="btn-add-account">+ Add</button>`

  statusEl.querySelectorAll('.account-remove').forEach(btn => {
    btn.addEventListener('click', () => logoutAccount(btn.dataset.id))
  })
  document.getElementById('btn-add-account').addEventListener('click', addAccount)
}

// ── Calendar render ──────────────────────────────────────────────────────────

function renderWeekLabel() {
  document.getElementById('week-label').textContent = formatWeekLabel(state.weekStart)
}

function renderColumnHeaders() {
  const today = new Date()
  const container = document.getElementById('col-headers-days')
  container.innerHTML = ''
  for (let i = 0; i < 7; i++) {
    const d = addDays(state.weekStart, i)
    const div = document.createElement('div')
    div.className = `day-header${sameDay(d, today) ? ' today' : ''}`
    div.innerHTML = `<span class="day-name">${DAY_NAMES[d.getDay()]}</span>`
                  + `<span class="date-num">${d.getDate()}</span>`
    container.appendChild(div)
  }
}

function renderTimeGutter() {
  const gutter = document.getElementById('time-gutter')
  gutter.innerHTML = ''
  for (let h = 1; h < 24; h++) {
    const label = document.createElement('div')
    label.className = 'time-label'
    label.style.top = `${h * 60}px`
    label.textContent = `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`
    gutter.appendChild(label)
  }
}

function renderDayColumns() {
  const timedCols  = document.getElementById('timed-cols')
  const alldayCols = document.getElementById('allday-cols')
  timedCols.innerHTML  = ''
  alldayCols.innerHTML = ''

  for (let i = 0; i < 7; i++) {
    const col = document.createElement('div')
    col.className = 'timed-col'
    col.dataset.day = i
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div')
      line.className = 'hour-line'
      line.style.top = `${h * 60}px`
      col.appendChild(line)
      if (h < 23) {
        const half = document.createElement('div')
        half.className = 'half-line'
        half.style.top = `${h * 60 + 30}px`
        col.appendChild(half)
      }
    }
    timedCols.appendChild(col)

    const adCol = document.createElement('div')
    adCol.className = 'allday-col'
    adCol.dataset.day = i
    alldayCols.appendChild(adCol)
  }
}

// ── Time formatting ───────────────────────────────────────────────────────────

// "8am–5pm", "1–4pm", "8:30–9am"
// Same period → drop it from the start; different periods → show on both.
function formatTimeRange(start, end) {
  const sh = start.getHours(), sm = start.getMinutes()
  const eh = end.getHours(),   em = end.getMinutes()
  const sPeriod = sh < 12 ? 'am' : 'pm'
  const ePeriod = eh < 12 ? 'am' : 'pm'

  const fmt = (h, m) => {
    const h12 = h % 12 || 12
    return m === 0 ? `${h12}` : `${h12}:${String(m).padStart(2, '0')}`
  }

  const startStr = sPeriod === ePeriod ? fmt(sh, sm) : `${fmt(sh, sm)}${sPeriod}`
  const endStr   = `${fmt(eh, em)}${ePeriod}`
  return `${startStr}–${endStr}`
}

// ── Overlap layout ────────────────────────────────────────────────────────────

// Given an array of {item, start, end} for one day's timed events, assigns
// each a colIdx (0-based slot) and numCols (total slots in its cluster) so
// overlapping events sit side-by-side rather than stacking.
function computeOverlapLayout(events) {
  if (events.length === 0) return []

  // Work in epoch-ms throughout to avoid any Date-object comparison ambiguity.
  const sorted = [...events]
    .map(ev => ({ ...ev, s: ev.start.getTime(), e: ev.end.getTime() }))
    .sort((a, b) => (a.s - b.s) || ((b.e - b.s) - (a.e - a.s)))

  const colIdx  = new Array(sorted.length).fill(0)
  const numCols = new Array(sorted.length).fill(1)

  let i = 0
  while (i < sorted.length) {
    // Expand the cluster: include every event that overlaps with anything
    // already in the cluster (tracked by the running clusterEnd timestamp).
    let clusterEnd = sorted[i].e
    let j = i + 1
    while (j < sorted.length && sorted[j].s < clusterEnd) {
      if (sorted[j].e > clusterEnd) clusterEnd = sorted[j].e
      j++
    }

    // Greedy slot assignment: give each event the earliest slot whose last
    // occupant finished at or before this event's start.
    const slotEnds = [] // numeric ms timestamps
    for (let k = i; k < j; k++) {
      let slot = slotEnds.findIndex(end => end <= sorted[k].s)
      if (slot === -1) slot = slotEnds.length
      slotEnds[slot] = sorted[k].e
      colIdx[k] = slot
    }

    const n = slotEnds.length
    for (let k = i; k < j; k++) numCols[k] = n
    i = j
  }

  return sorted.map((ev, k) => ({ ...ev, colIdx: colIdx[k], numCols: numCols[k] }))
}

function renderAllDayToggle() {
  document.getElementById('btn-allday-toggle').textContent =
    (state.allDayExpanded ? '▴' : '▾') + ' all‑day'
}

function renderItems(items) {
  document.querySelectorAll('.cal-event, .allday-event, .allday-more').forEach(el => el.remove())

  const timedByDay  = Array.from({ length: 7 }, () => [])
  const allDayByDay = Array.from({ length: 7 }, () => [])

  for (const item of items) {
    const start  = new Date(item.start)
    const dayIdx = localDayIndex(start, state.weekStart)
    if (dayIdx < 0 || dayIdx >= 7) continue

    if (item.all_day) {
      allDayByDay[dayIdx].push(item)
    } else {
      const end = item.end ? new Date(item.end) : new Date(start.getTime() + 30 * 60_000)
      timedByDay[dayIdx].push({ item, start, end })
    }
  }

  // All-day events — top-3 cap or show-all depending on allDayExpanded
  {
    const LIMIT = 3
    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
      const col = document.querySelector(`.allday-col[data-day="${dayIdx}"]`)
      if (!col) continue
      const dayItems = allDayByDay[dayIdx]
      const visible  = state.allDayExpanded ? dayItems : dayItems.slice(0, LIMIT)
      const overflow = state.allDayExpanded ? 0 : Math.max(0, dayItems.length - LIMIT)

      for (const item of visible) {
        const isTask = item.item_type === 'TASK'
        const isDone = item.status === 'COMPLETED'
        const el = document.createElement('div')
        el.className = `allday-event${isTask ? ' type-task' : ''}${isDone ? ' completed' : ''}`
        el.title = item.title

        if (isTask) {
          if (isDone) el.style.background = 'transparent'
          else if (item.color) el.style.background = item.color

          const check = document.createElement('button')
          check.className = `task-check${isDone ? ' done' : ''}`
          check.setAttribute('aria-label', isDone ? 'Mark incomplete' : 'Mark complete')
          if (isDone) check.textContent = '✓'
          check.addEventListener('click', e => { e.stopPropagation(); handleToggleTask(item) })

          const titleSpan = document.createElement('span')
          titleSpan.textContent = item.title

          const snoozeBtn = item.due && !isDone ? (() => {
            const btn = document.createElement('button')
            btn.className = 'task-snooze'
            btn.title     = 'Snooze'
            btn.textContent = '⏰'
            btn.addEventListener('click', e => {
              e.stopPropagation()
              openSnoozePopover(btn, item, refreshCalendarItems)
            })
            return btn
          })() : null

          el.append(check, titleSpan, ...(snoozeBtn ? [snoozeBtn] : []))
          // Clicking the chip body (not the check/snooze button) opens the editor
          el.style.cursor = 'pointer'
          el.addEventListener('click', async () => {
            await ensureTaskLists()
            openModal(item, state.taskLists, calendarModalCallbacks())
          })
        } else {
          if (item.color) el.style.background = item.color
          el.textContent = item.title
        }

        col.appendChild(el)
      }

      if (overflow > 0) {
        const more = document.createElement('div')
        more.className   = 'allday-more'
        more.textContent = `+${overflow} more`
        more.addEventListener('click', () => {
          state.allDayExpanded = true
          renderAllDayToggle()
          renderItems(getVisibleItems())
        })
        col.appendChild(more)
      }
    }
  }

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    if (timedByDay[dayIdx].length === 0) continue
    const dayCol = document.querySelector(`.timed-col[data-day="${dayIdx}"]`)
    if (!dayCol) continue

    for (const { item, start, end, colIdx, numCols } of computeOverlapLayout(timedByDay[dayIdx])) {
      const topMin = start.getHours() * 60 + start.getMinutes()
      const durMin = Math.max((end - start) / 60_000, 15)
      const el     = document.createElement('div')
      el.className = `cal-event${item.item_type === 'TASK' ? ' type-task' : ''}`
      if (item.color) el.style.background = item.color
      el.style.top    = `${topMin}px`
      el.style.height = `${durMin - 2}px`
      if (numCols === 1) {
        el.style.left  = '2px'
        el.style.right = '2px'
      } else {
        const pct      = 100 / numCols
        el.style.left  = `calc(${colIdx * pct}% + 2px)`
        el.style.width = `calc(${pct}% - 4px)`
        el.style.right = 'auto'
      }
      const titleEl = document.createElement('div')
      titleEl.className   = 'event-title'
      titleEl.textContent = item.title
      const timeEl  = document.createElement('div')
      timeEl.className   = 'event-time'
      timeEl.textContent = formatTimeRange(start, end)
      el.append(titleEl, timeEl)
      el.title = item.title
      if (item.item_type === 'TASK') {
        el.addEventListener('click', async () => {
          await ensureTaskLists()
          openModal(item, state.taskLists, calendarModalCallbacks())
        })
      }
      dayCol.appendChild(el)
    }
  }
}

// ── Full render pass ─────────────────────────────────────────────────────────

async function render() {
  renderWeekLabel()
  renderColumnHeaders()
  renderTimeGutter()
  renderDayColumns()
  renderAccountStatus()
  loadCalendars()  // async, populates calendar picker in background

  showLoading()
  try {
    const end = addDays(state.weekStart, 7)
    // Fetch calendar items and task lists in parallel; task lists power the modal list selector
    const [items] = await Promise.all([
      fetchItems(state.weekStart, end),
      getTokens().then(accts =>
        Promise.all(accts.map(a => getTaskLists(a.token).catch(() => [])))
          .then(lists => { state.taskLists = lists.flat() })
      ),
    ])
    state.items = items
    renderItems(getVisibleItems())
  } finally {
    hideLoading()
  }
}

// ── Navigation ───────────────────────────────────────────────────────────────

document.getElementById('btn-prev').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, -7)
  render()
})
document.getElementById('btn-next').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, 7)
  render()
})
document.getElementById('btn-today').addEventListener('click', () => {
  state.weekStart = getWeekStart(new Date())
  render()
})

// ── Init ─────────────────────────────────────────────────────────────────────

if (new URLSearchParams(window.location.search).get('auth_error')) {
  history.replaceState({}, '', '/')
  alert('Sign-in failed. Please try again.')
}

// View toggle
document.getElementById('btn-view-calendar').addEventListener('click', () => setView('calendar'))
document.getElementById('btn-view-board').addEventListener('click',    () => setView('board'))

// Show version on hover over the app title
document.getElementById('app-name').dataset.tooltip = `v${VERSION}`

// Init modal + snooze popover listeners once
initModal()
initSnooze()

render().then(() => {
  // #pinned-top (col-headers + allday-row) is sticky so it always occupies
  // the top of the visible area. Scroll the timed grid to 8am.
  const timedScroll = document.getElementById('timed-scroll')
  const pinnedTop   = document.getElementById('pinned-top')
  timedScroll.scrollTop = pinnedTop.offsetHeight + 8 * 60
  startPolling(120_000)
})
