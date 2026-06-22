import { getToken, getTokens, isAuthenticated, logout, logoutAccount, addAccount, loginUrl } from './auth.js'
import { runSweep, getSweepTargetListId, setSweepTargetListId } from './sweep.js'
import { processSpawnDirectives } from './spawn.js'
import { getCalendars, getEvents } from './providers/googleCalendar.js'
import { getTasks, completeTask, uncompleteTask, patchTask, getAllTasks, getTaskLists } from './providers/googleTasks.js'
import { renderBoard, destroyBoard, initSnooze, openSnoozePopover } from './board.js'
import { initModal, openModal, openCreateModal } from './modal.js'
import { initEventEditor, openEventEditor, openEventEditorForEdit } from './eventEditor.js'
import { initTimedDrag, destroyTimedDrag } from './calendarDrag.js'
import { spawnNextRecurrence } from './providers/googleTasks.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const VERSION   = '0.10.4'

const state = {
  weekStart: getWeekStart(new Date()),
  items: [],
  calendars: [],
  hiddenCalendars: new Set(JSON.parse(localStorage.getItem('kairos:hidden-cals') ?? '[]')),
  allDayExpanded: false,   // false = top-3 cap; true = show all
  view: 'calendar',        // 'calendar' | 'board'
  taskLists: [],           // raw Google Tasks list objects (for board columns + modal)
  boardItems: [],          // CalendarItem[] — all tasks, no date filter
  doneWindow: 30,          // days of completed tasks to show in Done column
  mobileDay: new Date(),   // day currently shown in the mobile day view
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
  const token = await getToken()
  if (!token) return
  try {
    state.calendars = await getCalendars(token)
    renderCalendarPicker()
  } catch (err) {
    console.error('Failed to load calendar list:', err)
  }
}

async function fetchItems(start, end) {
  const token = await getToken()
  if (!token) return []
  const [events, tasks] = await Promise.all([
    getEvents(token, start, end)
      .catch(err => { console.error('Calendar events fetch failed:', err); return [] }),
    getTasks(token, start, end)
      .catch(err => { console.error('Tasks fetch failed:', err); return [] }),
  ])
  return [...events, ...tasks]
}

async function handleToggleTask(item) {
  const token = await getToken()
  if (!token) return
  const isDone = item.status === 'COMPLETED'
  try {
    if (isDone) {
      await uncompleteTask(token, item.source.account_id, item.source.external_id)
      const target = state.items.find(i => i.id === item.id)
      if (target) target.status = 'NEEDS_ACTION'
    } else {
      if (item.metadata?.recurrence) await spawnNextRecurrence(token, item, item.source.account_id)
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
// Ref-counted: bar shows whenever any fetch is in-flight, hides when all settle.

function showLoading() { document.getElementById('loading-bar').classList.add('active') }
function hideLoading() { document.getElementById('loading-bar').classList.remove('active') }

let _pending = 0
const _origFetch = window.fetch.bind(window)
window.fetch = async (...args) => {
  if (++_pending === 1) showLoading()
  try {
    return await _origFetch(...args)
  } finally {
    if (--_pending <= 0) { _pending = 0; hideLoading() }
  }
}

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
  const token = await getToken()
  if (!token) return
  state.taskLists = await getTaskLists(token)
}

// ── View switching ────────────────────────────────────────────────────────────

function setView(v) {
  state.view = v
  document.getElementById('calendar').hidden   = v !== 'calendar'
  document.getElementById('mobile-cal').hidden = v !== 'calendar'
  document.getElementById('board').hidden      = v !== 'board'
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
    await runSweepAndRefresh()
    await runSpawnScan()
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
  runSweepAndRefresh()
    .then(() => runSpawnScan())
    .then(() => {
      if (state.view === 'board') loadBoardData()
      else fetchItems(state.weekStart, addDays(state.weekStart, 7)).then(items => {
        state.items = items
        renderItems(getVisibleItems())
      })
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
    onRefresh:          loadBoardData,
    onDoneWindowChange: days => { state.doneWindow = days; loadBoardData() },
  }
}

async function loadBoardData() {
  const token = await getToken()
  if (!token) return
  try {
    const { lists, tasks } = await getAllTasks(token, state.doneWindow)
    state.taskLists  = lists
    state.boardItems = tasks
    renderBoard(state.taskLists, state.boardItems, boardCallbacks(), state.doneWindow)
  } catch (err) {
    console.error('Board data load failed:', err)
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

// ── Auth + sweep UI ───────────────────────────────────────────────────────────

const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function renderAccountStatus() {
  const accounts = await getTokens()
  const statusEl = document.getElementById('account-status')
  const bannerEl = document.getElementById('connect-banner')

  if (!accounts.length) {
    statusEl.innerHTML = `<a href="${loginUrl()}">Sign in</a>`
    bannerEl.style.display = 'flex'
    return
  }

  bannerEl.style.display = 'none'

  const primary = accounts.find(a => a.primary) ?? accounts[0]
  const initial = (primary?.email?.[0] ?? '?').toUpperCase()
  statusEl.innerHTML = `<button id="btn-accounts-toggle" class="acct-avatar" title="${escHtml(primary?.email ?? '')}">${escHtml(initial)}</button>`
  document.getElementById('btn-accounts-toggle').addEventListener('click', e => {
    e.stopPropagation()
    const panel = document.getElementById('account-panel')
    if (!panel.hidden) { panel.hidden = true; return }
    renderAccountPanel(accounts)
    panel.hidden = false
  })
}

function renderAccountPanel(accounts) {
  const panel     = document.getElementById('account-panel')
  const primary   = accounts.find(a => a.primary)
  const secondaries = accounts.filter(a => !a.primary)
  const configListId = getSweepTargetListId()

  panel.innerHTML = ''

  // Primary account
  const primarySec = el('div', 'acct-section')
  primarySec.innerHTML = `
    <div class="acct-row">
      <span class="acct-email" title="${escHtml(primary?.email)}">${escHtml(primary?.email ?? 'Primary account')}</span>
      <span class="acct-badge primary">Primary</span>
      <button class="acct-signout" id="btn-panel-signout">Sign out</button>
    </div>`
  panel.appendChild(primarySec)

  // Secondary accounts
  if (secondaries.length) {
    const secSec = el('div', 'acct-section acct-section-border')
    secondaries.forEach(a => {
      const row = el('div', 'acct-row')
      row.innerHTML = `
        <span class="acct-email" title="${escHtml(a.email ?? a.id)}">${escHtml(a.email ?? a.id)}</span>
        <span class="acct-badge secondary">Secondary</span>
        <button class="acct-remove" data-id="${escHtml(a.id)}" title="Remove">×</button>`
      secSec.appendChild(row)
    })
    panel.appendChild(secSec)
  }

  // Add secondary
  const addSec = el('div', 'acct-section acct-section-border')
  addSec.innerHTML = `<button class="acct-add" id="btn-add-secondary">+ Add secondary account</button>`
  panel.appendChild(addSec)

  // Sweep destination + trigger (only when secondary accounts exist)
  if (secondaries.length && state.taskLists.length) {
    const sweepSec = el('div', 'acct-section acct-section-border')
    sweepSec.innerHTML = `
      <div class="acct-sweep-config">
        <label class="acct-sweep-label">Sweep tasks to</label>
        <select id="sweep-target-list" class="acct-sweep-select">
          ${state.taskLists.map(l =>
            `<option value="${escHtml(l.id)}"${l.id === configListId ? ' selected' : ''}>${escHtml(l.title)}</option>`
          ).join('')}
        </select>
      </div>
      <button class="acct-sweep-now" id="btn-sweep-now">Sweep now</button>`
    panel.appendChild(sweepSec)
  }

  panel.querySelector('#btn-panel-signout')?.addEventListener('click', logout)
  panel.querySelector('#btn-add-secondary')?.addEventListener('click', addAccount)
  panel.querySelectorAll('.acct-remove').forEach(btn => {
    btn.addEventListener('click', () => logoutAccount(btn.dataset.id))
  })
  panel.querySelector('#sweep-target-list')?.addEventListener('change', e => {
    setSweepTargetListId(e.target.value)
  })
  panel.querySelector('#btn-sweep-now')?.addEventListener('click', () => {
    panel.hidden = true
    runSweepAndRefresh()
  })
}

function el(tag, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

// ── Sweep ─────────────────────────────────────────────────────────────────────

async function runSweepAndRefresh() {
  const accounts    = await getTokens()
  const secondaries = accounts.filter(a => !a.primary)
  if (!secondaries.length) return

  try {
    const { moved } = await runSweep(accounts, state.taskLists)
    if (moved > 0) {
      if (state.view === 'board') {
        await loadBoardData()
      } else {
        state.items = await fetchItems(state.weekStart, addDays(state.weekStart, 7))
        renderItems(getVisibleItems())
      }
    }
  } catch (err) {
    console.error('Sweep error:', err)
  }
}

// ── Spawn scan ────────────────────────────────────────────────────────────────
// Fetches the next 90 days of calendar events and processes any spawn directives
// whose trigger windows have opened. Idempotent — safe to run on every poll.

async function runSpawnScan() {
  const token = await getToken()
  if (!token || !state.taskLists.length) return

  try {
    const today  = new Date()
    const future = addDays(today, 90)
    const items  = await fetchItems(today, future)
    const { spawned } = await processSpawnDirectives(items, state.taskLists)
    if (spawned > 0) {
      if (state.view === 'board') loadBoardData()
      else refreshCalendarItems()
    }
  } catch (err) {
    console.error('Spawn scan error:', err)
  }
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

// ── Current-time indicator ────────────────────────────────────────────────────

function updateTimeIndicator() {
  document.querySelectorAll('.time-indicator').forEach(el => el.remove())

  const now      = new Date()
  const thisWeek = getWeekStart(now)
  if (state.weekStart.getTime() !== thisWeek.getTime()) return

  const dayIdx = localDayIndex(now, state.weekStart)
  const col    = document.querySelector(`.timed-col[data-day="${dayIdx}"]`)
  if (!col) return

  const top = now.getHours() * 60 + now.getMinutes()

  const bar = document.createElement('div')
  bar.className = 'time-indicator'
  bar.style.top = `${top}px`
  bar.innerHTML = '<div class="time-indicator-dot"></div><div class="time-indicator-line"></div>'
  col.appendChild(bar)
}

let _timeIndicatorInterval = null

function initTimeIndicator() {
  updateTimeIndicator()
  clearInterval(_timeIndicatorInterval)
  _timeIndicatorInterval = setInterval(updateTimeIndicator, 60_000)
}

let _calDragItem = null  // task being dragged in the calendar all-day area

function renderItems(items) {
  document.querySelectorAll('.cal-event, .allday-event, .allday-more').forEach(el => el.remove())

  const timedByDay = Array.from({ length: 7 }, () => [])
  const allDayItems = []

  for (const item of items) {
    const start  = new Date(item.start)
    const dayIdx = localDayIndex(start, state.weekStart)

    if (item.all_day) {
      // Collect regardless of start day — multi-day events may start before the week.
      allDayItems.push(item)
    } else {
      const end = item.end ? new Date(item.end) : new Date(start.getTime() + 30 * 60_000)
      if (end - start >= 86_400_000) {
        // Timed events ≥ 24 h (e.g. multi-night bookings from ICS feeds) span
        // multiple calendar days and render as banners in the all-day row.
        const endDayIdx = localDayIndex(end, state.weekStart)
        if (endDayIdx >= 0 && dayIdx <= 6) allDayItems.push(item)
      } else {
        if (dayIdx < 0 || dayIdx >= 7) continue
        timedByDay[dayIdx].push({ item, start, end })
      }
    }
  }

  // ── All-day events (multi-day spanning) ──────────────────────────────────────
  {
    const ROW_H = 24   // px per row: 22px chip + 2px gap
    const LIMIT = 3    // max rows when not expanded

    // Build week-clamped spans for every all-day item
    const spans = []
    for (const item of allDayItems) {
      const start = new Date(item.start)
      const end   = item.end ? new Date(item.end) : new Date(start.getTime() + 86_400_000)

      const s = localDayIndex(start, state.weekStart)
      // Google all-day end dates are exclusive (a Tue all-day event has end.date = Wed).
      // Timed event end times are inclusive — the day they fall on is the last display day.
      const e = item.all_day
        ? localDayIndex(end, state.weekStart) - 1
        : localDayIndex(end, state.weekStart)

      const clampS = Math.max(0, s)
      const clampE = Math.min(6, e)
      if (clampS > 6 || clampE < 0) continue  // entirely outside this week

      spans.push({
        item,
        startDay:    clampS,
        endDay:      clampE,
        startsEarly: s < 0,   // continues from previous week
        endsLate:    e > 6,   // continues into next week
        row: 0,
      })
    }

    // Sort: earlier start first, then longer span first (mirrors Google Calendar)
    spans.sort((a, b) =>
      (a.startDay - b.startDay) || ((b.endDay - b.startDay) - (a.endDay - a.startDay))
    )

    // Greedy row assignment: find the earliest row that doesn't overlap this span
    const rowEnds = []  // rowEnds[r] = last endDay used in row r
    for (const span of spans) {
      let row = rowEnds.findIndex(end => end < span.startDay)
      if (row === -1) row = rowEnds.length
      rowEnds[row] = span.endDay
      span.row = row
    }

    const totalRows   = rowEnds.length
    const visibleRows = state.allDayExpanded ? totalRows : Math.min(totalRows, LIMIT)
    const container   = document.getElementById('allday-cols')

    // Drive container height; grid cells stretch to fill it automatically.
    // Add a full extra row when "+N more" chips are present so they don't overflow.
    const hasMore = !state.allDayExpanded && totalRows > visibleRows
    container.style.height = `${Math.max(28, visibleRows * ROW_H + (hasMore ? ROW_H : 4))}px`

    // Render visible event chips as absolutely-positioned children of #allday-cols
    for (const span of spans) {
      if (span.row >= visibleRows) continue

      const { item } = span
      const isTask = item.item_type === 'TASK'
      const isDone = item.status === 'COMPLETED'

      const isVirtual = !!item.metadata?.virtual
      const chipEl = document.createElement('div')
      chipEl.className = [
        'allday-event',
        isTask           ? 'type-task'       : '',
        isDone           ? 'completed'       : '',
        isVirtual        ? 'virtual'         : '',
        span.startsEarly ? 'continues-left'  : '',
        span.endsLate    ? 'continues-right' : '',
      ].filter(Boolean).join(' ')
      chipEl.title = item.title

      chipEl.style.left  = `calc(${span.startDay / 7 * 100}% + 2px)`
      chipEl.style.width = `calc(${(span.endDay - span.startDay + 1) / 7 * 100}% - 4px)`
      chipEl.style.top   = `${2 + span.row * ROW_H}px`

      if (isTask) {
        if (isDone) chipEl.style.background = 'transparent'
        else if (item.color) chipEl.style.background = item.color

        if (!isVirtual) {
          const check = document.createElement('button')
          check.className = `task-check${isDone ? ' done' : ''}`
          check.setAttribute('aria-label', isDone ? 'Mark incomplete' : 'Mark complete')
          if (isDone) check.textContent = '✓'
          check.addEventListener('click', e => { e.stopPropagation(); handleToggleTask(item) })

          const titleSpan = document.createElement('span')
          titleSpan.textContent = item.title

          const snoozeBtn = item.due && !isDone ? (() => {
            const btn = document.createElement('button')
            btn.className   = 'task-snooze'
            btn.title       = 'Snooze'
            btn.textContent = '⏰'
            btn.addEventListener('click', e => {
              e.stopPropagation()
              openSnoozePopover(btn, item, refreshCalendarItems)
            })
            return btn
          })() : null

          const recurIcon = item.metadata?.recurrence && !isDone ? (() => {
            const s = document.createElement('span')
            s.className   = 'task-recur-icon'
            s.title       = 'Recurring task'
            s.textContent = '↻'
            return s
          })() : null
          chipEl.append(check, titleSpan, ...(recurIcon ? [recurIcon] : []), ...(snoozeBtn ? [snoozeBtn] : []))
          chipEl.style.cursor = 'pointer'
          chipEl.addEventListener('click', async () => {
            await ensureTaskLists()
            openModal(item, state.taskLists, calendarModalCallbacks())
          })

          chipEl.draggable = true
          chipEl.addEventListener('dragstart', e => {
            _calDragItem = item
            e.dataTransfer.effectAllowed = 'move'
            requestAnimationFrame(() => chipEl.classList.add('drag-source'))
          })
          chipEl.addEventListener('dragend', () => {
            chipEl.classList.remove('drag-source')
            _calDragItem = null
          })
        } else {
          // Virtual instance: show title only, no interaction
          const titleSpan = document.createElement('span')
          titleSpan.textContent = item.title
          chipEl.appendChild(titleSpan)
        }
      } else {
        if (item.color) chipEl.style.background = item.color
        chipEl.textContent = item.title
        chipEl.style.cursor = 'pointer'
        chipEl.addEventListener('click', () => {
          openEventEditorForEdit(item, { onSaved: refreshCalendarItems })
        })
      }

      container.appendChild(chipEl)
    }

    // Per-day "+N more" chips at the bottom of the visible area
    if (!state.allDayExpanded && totalRows > visibleRows) {
      for (let day = 0; day < 7; day++) {
        const hiddenCount = spans.filter(
          s => s.row >= visibleRows && s.startDay <= day && s.endDay >= day
        ).length
        if (!hiddenCount) continue

        const more = document.createElement('div')
        more.className   = 'allday-more'
        more.textContent = `+${hiddenCount} more`
        more.style.left  = `calc(${day / 7 * 100}% + 2px)`
        more.style.width = `calc(${1 / 7 * 100}% - 4px)`
        more.style.top   = `${2 + visibleRows * ROW_H}px`
        more.addEventListener('click', () => {
          state.allDayExpanded = true
          renderAllDayToggle()
          renderItems(getVisibleItems())
        })
        container.appendChild(more)
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
      const isVirtual = !!item.metadata?.virtual
      const el     = document.createElement('div')
      el.className = `cal-event${item.item_type === 'TASK' ? ' type-task' : ''}${isVirtual ? ' virtual' : ''}`
      el.dataset.itemId = item.id
      if (item.color) el.style.background = item.color
      el.style.top    = `${topMin}px`
      el.style.height = `${durMin - 2}px`
      if (numCols === 1) {
        el.style.left  = '2px'
        el.style.right = '14px'
      } else {
        const pct = 100 / numCols
        el.style.left = `calc(${colIdx * pct}% + 2px)`
        if (colIdx === numCols - 1) {
          // Last column in cluster gets the right gutter so there's always open
          // space on the column edge to draw/click a new event behind overlaps.
          el.style.right = '14px'
          el.style.width = 'auto'
        } else {
          el.style.width = `calc(${pct}% - 4px)`
          el.style.right = 'auto'
        }
      }
      const titleEl = document.createElement('div')
      titleEl.className   = 'event-title'
      titleEl.textContent = item.title
      const timeEl  = document.createElement('div')
      timeEl.className   = 'event-time'
      timeEl.textContent = formatTimeRange(start, end)
      el.append(titleEl, timeEl)
      el.title = item.title
      if (!isVirtual) {
        if (item.item_type === 'TASK') {
          el.addEventListener('click', async () => {
            await ensureTaskLists()
            openModal(item, state.taskLists, calendarModalCallbacks())
          })
        } else {
          el.addEventListener('click', () => {
            openEventEditorForEdit(item, { onSaved: refreshCalendarItems, onDeleted: refreshCalendarItems })
          })
          if (item.editable) {
            const handle = document.createElement('div')
            handle.className = 'resize-handle'
            el.appendChild(handle)
          }
        }
      }
      dayCol.appendChild(el)
    }
  }

  renderMobileDay()

  // (Re-)initialise timed drag after every render so item references stay fresh
  destroyTimedDrag()
  initTimedDrag(state.weekStart, items, {
    onRefresh:    refreshCalendarItems,
    onDrawCreate: ({ date, startTime, endTime }) =>
      openEventEditor(
        { date, startTime, endTime, allDay: false, calendars: state.calendars },
        { onSaved: refreshCalendarItems }
      ),
  })
}

// ── Mobile day view ──────────────────────────────────────────────────────────

function initMobileDayView() {
  const gutter = document.getElementById('mobile-time-gutter')
  const col    = document.getElementById('mobile-timed-col')
  if (!gutter || !col) return

  // Hour labels (reuse .time-label class from desktop)
  for (let h = 1; h < 24; h++) {
    const label = document.createElement('div')
    label.className   = 'time-label'
    label.style.top   = `${h * 60}px`
    label.textContent = `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`
    gutter.appendChild(label)
  }

  // Hour and half-hour grid lines
  for (let h = 0; h < 24; h++) {
    const line = document.createElement('div')
    line.className = 'mobile-hour-line'
    line.style.top = `${h * 60}px`
    col.appendChild(line)
    if (h < 23) {
      const half = document.createElement('div')
      half.className = 'mobile-half-line'
      half.style.top = `${h * 60 + 30}px`
      col.appendChild(half)
    }
  }

  document.getElementById('mobile-btn-prev').addEventListener('click', () => navigateMobileDay(-1))
  document.getElementById('mobile-btn-next').addEventListener('click', () => navigateMobileDay(1))

  // Swipe left/right to navigate days; vertical scrolling is unaffected
  let _tx = 0, _ty = 0
  const scroll = document.getElementById('mobile-timed-scroll')
  scroll.addEventListener('touchstart', e => {
    _tx = e.touches[0].clientX
    _ty = e.touches[0].clientY
  }, { passive: true })
  scroll.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _tx
    const dy = e.changedTouches[0].clientY - _ty
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) navigateMobileDay(dx < 0 ? 1 : -1)
  }, { passive: true })
}

function renderMobileDay() {
  if (window.innerWidth > 768) return  // desktop — skip

  const day      = state.mobileDay
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0)
  const dayEnd   = new Date(dayStart.getTime() + 86_400_000)
  const today    = new Date()
  const isToday  = sameDay(day, today)

  // Day label
  const labelEl = document.getElementById('mobile-day-label')
  labelEl.textContent = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  labelEl.classList.toggle('is-today', isToday)

  const items = getVisibleItems()

  // ── All-day / multi-day timed events ──────────────────────────────────────
  const allDayContainer = document.getElementById('mobile-allday-items')
  allDayContainer.innerHTML = ''

  for (const item of items) {
    const start = new Date(item.start)
    const end   = item.end ? new Date(item.end) : new Date(start.getTime() + 86_400_000)

    let covers = false
    if (item.all_day) {
      covers = start < dayEnd && end > dayStart  // Google end is exclusive
    } else if (end - start >= 86_400_000) {
      covers = start < dayEnd && end > dayStart
    }
    if (!covers) continue

    const chip = document.createElement('div')
    chip.className = `mobile-allday-chip${item.item_type === 'TASK' ? ' type-task' : ''}${item.metadata?.virtual ? ' virtual' : ''}`
    if (item.color) chip.style.background = item.color
    chip.textContent = item.title
    chip.title       = item.title
    if (!item.metadata?.virtual) {
      chip.addEventListener('click', () => {
        if (item.item_type === 'TASK') {
          ensureTaskLists().then(() => openModal(item, state.taskLists, calendarModalCallbacks()))
        } else {
          openEventEditorForEdit(item, calendarModalCallbacks())
        }
      })
    }
    allDayContainer.appendChild(chip)
  }

  // ── Timed events ──────────────────────────────────────────────────────────
  const col = document.getElementById('mobile-timed-col')
  col.querySelectorAll('.mobile-cal-event, .mobile-time-indicator').forEach(e => e.remove())

  const timedItems = []
  for (const item of items) {
    if (item.all_day) continue
    const start = new Date(item.start)
    const end   = item.end ? new Date(item.end) : new Date(start.getTime() + 30 * 60_000)
    if (end - start >= 86_400_000) continue  // multi-day → shown above
    if (!sameDay(start, day)) continue
    timedItems.push({ item, start, end })
  }

  for (const { item, start, end, colIdx, numCols } of computeOverlapLayout(timedItems)) {
    const topMin = start.getHours() * 60 + start.getMinutes()
    const durMin = Math.max((end - start) / 60_000, 15)

    const eventEl = document.createElement('div')
    eventEl.className = `mobile-cal-event${item.item_type === 'TASK' ? ' type-task' : ''}`
    if (item.color) eventEl.style.background = item.color
    eventEl.style.top    = `${topMin}px`
    eventEl.style.height = `${durMin - 2}px`

    if (numCols === 1) {
      eventEl.style.left  = '2px'
      eventEl.style.right = '2px'
    } else {
      const pct = 100 / numCols
      eventEl.style.left = `calc(${colIdx * pct}% + 2px)`
      if (colIdx === numCols - 1) {
        eventEl.style.right = '2px'
        eventEl.style.width = 'auto'
      } else {
        eventEl.style.width = `calc(${pct}% - 4px)`
        eventEl.style.right = 'auto'
      }
    }

    const titleEl = document.createElement('div')
    titleEl.className   = 'mobile-event-title'
    titleEl.textContent = item.title
    const timeEl = document.createElement('div')
    timeEl.className   = 'mobile-event-time'
    timeEl.textContent = formatTimeRange(start, end)
    eventEl.append(titleEl, timeEl)
    eventEl.title = item.title

    if (!item.metadata?.virtual) {
      eventEl.addEventListener('click', () => {
        if (item.item_type === 'TASK') {
          ensureTaskLists().then(() => openModal(item, state.taskLists, calendarModalCallbacks()))
        } else {
          openEventEditorForEdit(item, calendarModalCallbacks())
        }
      })
    }
    col.appendChild(eventEl)
  }

  // Current-time indicator
  if (isToday) {
    const topMin = today.getHours() * 60 + today.getMinutes()
    const ind = document.createElement('div')
    ind.className = 'mobile-time-indicator'
    ind.style.top = `${topMin}px`
    ind.innerHTML = '<div class="mobile-time-indicator-dot"></div><div class="mobile-time-indicator-line"></div>'
    col.appendChild(ind)
  }
}

async function navigateMobileDay(delta) {
  const newDay = addDays(state.mobileDay, delta)
  state.mobileDay = newDay

  // If the new day falls outside the currently fetched week, refetch
  const newWeekStart = getWeekStart(newDay)
  if (newWeekStart.getTime() !== state.weekStart.getTime()) {
    state.weekStart = newWeekStart
    const end = addDays(state.weekStart, 7)
    state.items = await fetchItems(state.weekStart, end)
    renderWeekLabel()
    renderColumnHeaders()
    renderItems(getVisibleItems())  // also re-renders mobile via the hook at the end
    return
  }

  renderMobileDay()

  // Scroll to a sensible position for the new day
  const scroll = document.getElementById('mobile-timed-scroll')
  if (scroll) {
    const now      = new Date()
    const scrollTo = sameDay(newDay, now) ? Math.max(0, now.getHours() * 60 + now.getMinutes() - 120) : 8 * 60
    requestAnimationFrame(() => { scroll.scrollTop = scrollTo })
  }
}

// ── Calendar drag-to-move ────────────────────────────────────────────────────

// Event chips are absolutely positioned in #allday-cols, not inside .allday-col,
// so we find the column by x-coordinate rather than DOM traversal.
function alldayColAtX(clientX) {
  for (const col of document.querySelectorAll('.allday-col')) {
    const r = col.getBoundingClientRect()
    if (clientX >= r.left && clientX < r.right) return col
  }
  return null
}

function initCalendarDrag() {
  const container = document.getElementById('allday-cols')

  container.addEventListener('dragover', e => {
    if (!_calDragItem) return
    const col = alldayColAtX(e.clientX)
    if (!col) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!col.classList.contains('drag-over')) {
      container.querySelectorAll('.allday-col.drag-over').forEach(c => c.classList.remove('drag-over'))
      col.classList.add('drag-over')
    }
  })

  container.addEventListener('dragleave', e => {
    if (!container.contains(e.relatedTarget)) {
      container.querySelectorAll('.allday-col.drag-over').forEach(c => c.classList.remove('drag-over'))
    }
  })

  container.addEventListener('drop', async e => {
    e.preventDefault()
    container.querySelectorAll('.allday-col.drag-over').forEach(c => c.classList.remove('drag-over'))
    const col = alldayColAtX(e.clientX)
    if (!col || !_calDragItem) return

    const item   = _calDragItem
    _calDragItem = null

    const dayIdx  = parseInt(col.dataset.day, 10)
    const newDate = addDays(state.weekStart, dayIdx)
    const pad     = v => String(v).padStart(2, '0')
    const newDue  = `${newDate.getFullYear()}-${pad(newDate.getMonth() + 1)}-${pad(newDate.getDate())}`

    // No-op if dropped on the same day
    const curDue = item.due
      ? `${item.due.getFullYear()}-${pad(item.due.getMonth() + 1)}-${pad(item.due.getDate())}`
      : null
    if (newDue === curDue) return

    try {
      const token = await getToken()
      if (!token) return
      await patchTask(token, item.source.account_id, item.source.external_id, {
        due: `${newDue}T00:00:00.000Z`,
      })
      await refreshCalendarItems()
    } catch (err) {
      console.error('Calendar drag move failed:', err)
    }
  })
}

// ── Context menu (new event / new task) ──────────────────────────────────────

let _ctxOpts = {}

function showContextMenu(x, y, opts = {}) {
  _ctxOpts = opts
  const menu = document.getElementById('context-menu')
  menu.hidden = false
  // Keep within viewport
  menu.style.left = `${Math.min(x, window.innerWidth  - menu.offsetWidth  - 8)}px`
  menu.style.top  = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`
}

function initContextMenu() {
  const menu = document.getElementById('context-menu')

  document.getElementById('ctx-new-event').addEventListener('click', () => {
    menu.hidden = true
    openEventEditor(
      { date: _ctxOpts.date, allDay: _ctxOpts.allDay ?? true, calendars: state.calendars },
      { onSaved: refreshCalendarItems }
    )
  })

  document.getElementById('ctx-new-task').addEventListener('click', async () => {
    menu.hidden = true
    await ensureTaskLists()
    openCreateModal(
      state.taskLists[0]?.id ?? null,
      state.taskLists,
      calendarModalCallbacks(),
      { due: _ctxOpts.date ?? null }
    )
  })

  // + button
  document.getElementById('btn-add').addEventListener('click', e => {
    e.stopPropagation()
    showContextMenu(e.clientX, e.clientY)
  })

  // All-day col background click → context menu with date
  document.getElementById('allday-cols').addEventListener('click', e => {
    if (e.target.closest('.allday-event') || e.target.closest('.allday-more')) return
    const col = e.target.closest('.allday-col')
    if (!col) return
    e.stopPropagation()
    // Toggle: a second click anywhere in the all-day area closes the menu
    if (!menu.hidden) { menu.hidden = true; return }
    const dayIdx = parseInt(col.dataset.day, 10)
    const date   = addDays(state.weekStart, dayIdx).toLocaleDateString('en-CA')
    showContextMenu(e.clientX, e.clientY, { date, allDay: true })
  })

  // Timed col background click → straight to event editor for that 30-min block
  document.getElementById('timed-cols').addEventListener('click', e => {
    if (!menu.hidden) { menu.hidden = true; return }
    if (e.target.closest('.cal-event')) return
    const col = e.target.closest('.timed-col')
    if (!col) return
    const dayIdx  = parseInt(col.dataset.day, 10)
    const date    = addDays(state.weekStart, dayIdx).toLocaleDateString('en-CA')
    const colRect = col.getBoundingClientRect()
    const minsIntoDay = Math.max(0, Math.floor((e.clientY - colRect.top) / 30) * 30)
    const h = Math.floor(minsIntoDay / 60) % 24
    const m = minsIntoDay % 60
    const startTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    openEventEditor(
      { date, startTime, allDay: false, calendars: state.calendars },
      { onSaved: refreshCalendarItems }
    )
  })

  // Close on outside click or ESC
  document.addEventListener('click', () => { menu.hidden = true })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') menu.hidden = true })
  menu.addEventListener('click', e => e.stopPropagation())
}

// ── Full render pass ─────────────────────────────────────────────────────────

async function render() {
  renderWeekLabel()
  renderColumnHeaders()
  renderTimeGutter()
  renderDayColumns()
  updateTimeIndicator()
  renderAccountStatus()
  loadCalendars()  // async, populates calendar picker in background

  try {
    const end = addDays(state.weekStart, 7)
    // Fetch items and task lists in parallel; task lists power the modal list selector
    const [items] = await Promise.all([
      fetchItems(state.weekStart, end),
      getToken().then(t => t ? getTaskLists(t).then(l => { state.taskLists = l }) : null),
    ])
    state.items = items
    renderItems(getVisibleItems())
  } catch (err) {
    console.error('Render failed:', err)
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
  state.mobileDay = new Date()
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
initCalendarDrag()
initEventEditor()
initContextMenu()
initTimeIndicator()
initMobileDayView()

// Close account panel on outside click
document.addEventListener('click', () => {
  document.getElementById('account-panel').hidden = true
})
document.getElementById('account-panel').addEventListener('click', e => e.stopPropagation())

render().then(() => {
  // #timed-scroll is a flex column container; scrollTop = M shows timed-area
  // minute M at the top of the visible area below the sticky header.
  // No pinnedTop.offsetHeight offset needed — that caused the indicator to land
  // behind the sticky header by exactly pinnedTop.offsetHeight pixels.
  const timedScroll = document.getElementById('timed-scroll')
  const now         = new Date()
  const minsNow     = now.getHours() * 60 + now.getMinutes()
  const scrollMins  = getWeekStart(now).getTime() === state.weekStart.getTime()
    ? Math.max(0, minsNow - 120)
    : 8 * 60
  timedScroll.scrollTop = scrollMins

  const mobileScroll = document.getElementById('mobile-timed-scroll')
  if (mobileScroll) mobileScroll.scrollTop = Math.max(0, minsNow - 120)

  runSweepAndRefresh().then(() => runSpawnScan())
  startPolling(120_000)
})
