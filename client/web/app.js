import { getToken, getTokens, isAuthenticated, logout, logoutAccount, addAccount, loginUrl, invalidateCache } from './auth.js'
import { processSpawnDirectives } from './spawn.js'
import { getCalendars, getEvents, updateEvent } from './providers/googleCalendar.js'
import { getAllTaskEvents, completeTask as calCompleteTask, uncompleteTask as calUncompleteTask, patchTaskDate } from './providers/calendarTasks.js'
import { loadPrefs, getHiddenCalendars, setHiddenCalendars, getTaskCalendars, setTaskCalendars } from './providers/kairosPrefs.js'
import { loadLists, getListsForCalendar, createList, getAllLists, updateList, deleteList, ensureDefaultLists } from './providers/kairosLists.js'
import { setCompleted, setUncompleted } from './providers/completionStore.js'
import { appendLogEntry } from './providers/lifeLog.js'
import { renderBoard, destroyBoard, initSnooze, openSnoozePopover } from './board.js'
import { runMigration } from './migration.js'
import { initEditor, openEditor, openEditorForEdit } from './unifiedEditor.js'
import { initTimedDrag, destroyTimedDrag } from './calendarDrag.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const VERSION   = '0.23.16'

const state = {
  weekStart: getWeekStart(new Date()),
  items: [],
  calendars: [],
  hiddenCalendars:     new Set(),   // populated from Drive prefs after auth
  taskCalendars: new Set(),          // calendar IDs designated as task/project calendars
  allDayExpanded: false,        // false = top-3 cap; true = show all
  view: 'calendar',        // 'calendar' | 'board'
  taskLists: [],           // Kairos lists [{id, calendarId, name, order}] for board columns
  boardItems: [],          // CalendarItem[] — all calendar task events
  doneWindow: 30,          // days of completed tasks to show in Done column
  mobileDay: new Date(),   // day currently shown in the mobile day view
}

// ── Color helpers ─────────────────────────────────────────────────────────────

// Returns '#000000' or '#ffffff' — whichever has better contrast against the
// given hex background color. Uses the WCAG relative luminance formula.
function contrastColor(hex) {
  if (!hex?.startsWith('#')) return null
  const h    = hex.slice(1)
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const r    = parseInt(full.slice(0, 2), 16) / 255
  const g    = parseInt(full.slice(2, 4), 16) / 255
  const b    = parseInt(full.slice(4, 6), 16) / 255
  const lin  = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  const L    = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return L > 0.179 ? '#000000' : '#ffffff'
}

// Apply background color and an auto-contrasted foreground color to an element.
function applyColor(el, color) {
  if (!color) return
  el.style.background = color
  const fg = contrastColor(color)
  if (fg) el.style.color = fg
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
  return getEvents(token, start, end)
    .catch(err => { console.error('Calendar events fetch failed:', err); return [] })
}

async function handleToggleTask(item) {
  const token = await getToken()
  if (!token) return
  const isDone = item.status === 'COMPLETED'
  const verb   = isDone ? 'uncompleted' : 'completed'
  try {
    if (isDone) await calUncompleteTask(token, item.source.account_id, item.source.external_id, item.title)
    else        await calCompleteTask(token, item.source.account_id, item.source.external_id, item.title)
    const target = state.items.find(i => i.id === item.id)
    if (target) target.status = isDone ? 'NEEDS_ACTION' : 'COMPLETED'
    renderItems(getVisibleItems())
    appendLogEntry(token, {
      item_id:       item.id,
      item_type:     'TASK',
      title:         item.title,
      verb,
      action_detail: { verb },
      narrative:     isDone ? `Marked "${item.title}" incomplete` : `Completed "${item.title}"`,
      context:       item.metadata?.list_title ?? '',
    })
  } catch (err) {
    console.error('Failed to toggle task:', err)
  }
}

async function handleToggleCommitment(item) {
  const token   = await getToken()
  if (!token) return
  const isDone  = item.status === 'COMPLETED'
  const verb    = isDone ? 'uncompleted' : 'completed'
  const eventId = item.source.external_id

  try {
    if (isDone) await setUncompleted(token, eventId)
    else        await setCompleted(token, eventId)
    const target = state.items.find(i => i.id === item.id)
    if (target) target.status = isDone ? 'CONFIRMED' : 'COMPLETED'
    renderItems(getVisibleItems())
    appendLogEntry(token, {
      item_id:       item.id,
      item_type:     'EVENT',
      title:         item.title,
      verb,
      action_detail: { verb },
      narrative:     isDone ? `Marked "${item.title}" incomplete` : `Completed "${item.title}"`,
      context:       item.metadata?.calendar_name ?? '',
    })
  } catch (err) {
    console.error('Failed to toggle commitment:', err)
    await refreshCalendarItems()
  }
}

async function handleSnoozeCommitment(item, n, newDate, dateLabel) {
  const token   = await getToken()
  if (!token) return
  const calId   = item.source.account_id
  const eventId = item.source.external_id
  const pad     = v => String(v).padStart(2, '0')
  const newDateStr = `${newDate.getFullYear()}-${pad(newDate.getMonth()+1)}-${pad(newDate.getDate())}`

  const pad2 = v => String(v).padStart(2, '0')
  const fromStr = item.start
    ? `${item.start.getFullYear()}-${pad2(item.start.getMonth()+1)}-${pad2(item.start.getDate())}`
    : null
  appendLogEntry(token, {
    item_id:       item.id,
    item_type:     'EVENT',
    title:         item.title,
    verb:          'snoozed',
    action_detail: { verb: 'snoozed', to: newDateStr, ...(fromStr && { from: fromStr }) },
    narrative:     `Snoozed "${item.title}" to ${dateLabel}`,
    context:       item.metadata?.calendar_name ?? '',
  })

  const body = {}
  if (item.all_day) {
    const endDate = new Date(newDate)
    endDate.setDate(endDate.getDate() + 1)
    body.start = { date: newDateStr }
    body.end   = { date: `${endDate.getFullYear()}-${pad(endDate.getMonth()+1)}-${pad(endDate.getDate())}` }
  } else {
    const origStart = new Date(item.start)
    const origEnd   = item.end ? new Date(item.end) : null
    const newStart  = new Date(origStart); newStart.setDate(newStart.getDate() + n)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    body.start = { dateTime: newStart.toISOString(), timeZone: tz }
    if (origEnd) {
      const newEnd = new Date(origEnd); newEnd.setDate(newEnd.getDate() + n)
      body.end = { dateTime: newEnd.toISOString(), timeZone: tz }
    }
  }
  await updateEvent(token, calId, eventId, body)
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
  return { onSaved: refreshCalendarItems, onDeleted: refreshCalendarItems }
}

// ── View switching ────────────────────────────────────────────────────────────

function setView(v) {
  state.view = v
  document.getElementById('calendar').hidden    = v !== 'calendar'
  document.getElementById('mobile-cal').hidden  = v !== 'calendar'
  document.getElementById('board-toolbar').hidden = v !== 'board'
  document.getElementById('board').hidden       = v !== 'board'
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

// Resume immediately when the user returns to the tab; force-refresh the token
// so returning after any idle period doesn't carry a stale access token.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  invalidateCache()
  runSpawnScan()
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
    onCreate:     (calendarId, listId) => openEditor(
      { mode: 'task', calendarId: calendarId ?? getTaskCalendars()[0] ?? null, listId },
      { onSaved: loadBoardData },
    ),
    onEdit:       item    => openEditorForEdit(item, {
      onSaved:   loadBoardData,
      onDeleted: loadBoardData,
    }),
    onRefresh:          loadBoardData,
    onDoneWindowChange: days => { state.doneWindow = days; loadBoardData() },
    onCreateList: async name => {
      const token = await getToken()
      if (!token) return
      const calId = getTaskCalendars()[0] ?? null
      if (!calId) return
      try {
        const calLists = getListsForCalendar(calId)
        const maxOrder = calLists.length ? Math.max(...calLists.map(l => l.order ?? 0)) : 0
        await createList(token, calId, name, maxOrder + 10)
        await loadBoardData()
      } catch (err) {
        console.error('Create list failed:', err)
      }
    },
  }
}

function getBoardItems() {
  const showRecurring = localStorage.getItem('kairos:showRecurring') === 'true'
  if (!showRecurring) return state.boardItems.filter(i => !i.metadata?.recurringEventId)

  // Recurring tasks are shown as one card per series: the next upcoming non-completed
  // instance. Falls back to the most recent past non-completed instance if none upcoming.
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const bestBySeries = new Map()

  for (const item of state.boardItems) {
    const sid = item.metadata?.recurringEventId
    if (!sid || item.status === 'COMPLETED') continue

    const prev     = bestBySeries.get(sid)
    const itemStart = item.start ?? new Date(0)
    const prevStart = prev?.start  ?? new Date(0)
    const itemAhead = itemStart >= today
    const prevAhead = prevStart >= today

    if (!prev
      || (itemAhead && !prevAhead)                            // upcoming beats past
      || (itemAhead && prevAhead && itemStart < prevStart)    // earlier upcoming wins
      || (!itemAhead && !prevAhead && itemStart > prevStart)  // more-recent past wins
    ) bestBySeries.set(sid, item)
  }

  return [
    ...state.boardItems.filter(i => !i.metadata?.recurringEventId),
    ...[...bestBySeries.values()],
  ]
}

async function loadBoardData() {
  const token = await getToken()
  if (!token) return
  try {
    const taskCalIds = getTaskCalendars()
    await Promise.all([
      Promise.all(
        taskCalIds.map(calId =>
          getAllTaskEvents(token, calId).catch(err => {
            console.warn(`Tasks fetch failed for ${calId}:`, err.message)
            return []
          })
        )
      ).then(results => { state.boardItems = results.flat() }),
      loadPrefs(token),
      loadLists(token),
    ])
    state.taskLists = getAllLists()
    renderBoard(state.taskLists, getBoardItems(), boardCallbacks(), state.doneWindow)
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

  panel.innerHTML = ''

  for (const cal of state.calendars) {
    const isTaskCal = state.taskCalendars.has(cal.id)

    // ── Calendar row ────────────────────────────────────────────────────────
    const row = document.createElement('div')
    row.className = 'cal-picker-item'

    const lbl = document.createElement('label')
    lbl.className = 'cal-picker-vis'

    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !state.hiddenCalendars.has(cal.id)
    cb.addEventListener('change', () => {
      if (cb.checked) state.hiddenCalendars.delete(cal.id)
      else            state.hiddenCalendars.add(cal.id)
      setHiddenCalendars([...state.hiddenCalendars])
      updateCalPickerBadge()
      renderItems(getVisibleItems())
    })

    const swatch = document.createElement('span')
    swatch.className = 'cal-swatch'
    swatch.style.background = cal.backgroundColor ?? '#1a73e8'

    const nameSp = document.createElement('span')
    nameSp.className = 'cal-name'
    nameSp.title = cal.summary
    nameSp.textContent = cal.summary

    lbl.append(cb, swatch, nameSp)

    const taskBtn = document.createElement('button')
    taskBtn.className = `cal-task-toggle${isTaskCal ? ' active' : ''}`
    taskBtn.title = 'Use as task calendar'
    taskBtn.textContent = 'tasks'
    taskBtn.addEventListener('click', async e => {
      e.stopPropagation()
      if (state.taskCalendars.has(cal.id)) {
        state.taskCalendars.delete(cal.id)
        taskBtn.classList.remove('active')
        panel.querySelector(`.cal-lists-panel[data-cal-id="${cal.id}"]`)?.remove()
      } else {
        state.taskCalendars.add(cal.id)
        taskBtn.classList.add('active')
        const token = await getToken()
        if (token) {
          await ensureDefaultLists(token, cal.id)
          row.insertAdjacentElement('afterend', buildListsPanel(cal.id))
        }
      }
      setTaskCalendars([...state.taskCalendars])
      refreshCalendarItems()
    })

    row.append(lbl, taskBtn)
    panel.appendChild(row)

    // ── Lists sub-panel (already a task calendar) ─────────────────────────
    if (isTaskCal) panel.appendChild(buildListsPanel(cal.id))
  }
}

function buildListsPanel(calendarId) {
  const lists = getListsForCalendar(calendarId)

  const wrap = document.createElement('div')
  wrap.className = 'cal-lists-panel'
  wrap.dataset.calId = calendarId

  const items = document.createElement('div')
  items.className = 'cal-lists-items'
  for (const list of lists) items.appendChild(buildListRow(list))

  const addRow = document.createElement('div')
  addRow.className = 'cal-lists-add-row'

  const inp = document.createElement('input')
  inp.type = 'text'
  inp.className = 'cal-list-add-input'
  inp.placeholder = 'New list…'

  const addBtn = document.createElement('button')
  addBtn.className = 'cal-list-add-btn'
  addBtn.textContent = '+'

  const doAdd = async () => {
    const name = inp.value.trim()
    if (!name) return
    const token = await getToken()
    if (!token) return
    const all   = getListsForCalendar(calendarId)
    const order = all.length ? Math.max(...all.map(l => l.order ?? 0)) + 10 : 0
    const list  = await createList(token, calendarId, name, order)
    inp.value   = ''
    items.appendChild(buildListRow(list))
  }
  addBtn.addEventListener('click', doAdd)
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd() })

  addRow.append(inp, addBtn)
  wrap.append(items, addRow, buildMigrateSection(calendarId))
  return wrap
}

function buildMigrateSection(calendarId) {
  const section = document.createElement('div')
  section.className = 'cal-migrate-section'

  const btn = document.createElement('button')
  btn.className   = 'cal-migrate-btn'
  btn.textContent = 'Import Google Tasks →'
  btn.title       = 'Migrate active Google Tasks into this calendar (tasks are marked complete in GT and auto-deleted by Google after 30 days)'

  const status = document.createElement('div')
  status.className = 'cal-migrate-status'
  status.hidden    = true

  btn.addEventListener('click', async () => {
    if (!confirm(
      'Migrate all active Google Tasks to this calendar?\n\n' +
      'Each task will be imported as a calendar event. ' +
      'The originals will be marked complete in Google Tasks (auto-deleted by Google after 30 days).'
    )) return

    btn.disabled  = true
    status.hidden = false
    status.textContent = 'Migrating…'

    try {
      const token = await getToken()
      if (!token) { btn.disabled = false; return }

      const result = await runMigration(token, ({ migrated, failed, total }) => {
        status.textContent = `Migrating… ${migrated + failed}/${total}`
      })

      const parts = [`${result.migrated} imported`]
      if (result.failed)  parts.push(`${result.failed} failed`)
      if (result.skipped) parts.push(`${result.skipped} skipped`)
      status.textContent = `Done — ${parts.join(', ')}`

      if (result.migrated > 0) loadBoardData()
    } catch (err) {
      console.error('Migration failed:', err)
      status.textContent = `Error: ${err.message}`
      btn.disabled = false
    }
  })

  section.append(btn, status)
  return section
}

function buildListRow(list) {
  const row = document.createElement('div')
  row.className = 'cal-list-row'

  const nameEl = document.createElement('span')
  nameEl.className = 'cal-list-name'
  nameEl.textContent = list.name

  const renameBtn = document.createElement('button')
  renameBtn.className = 'cal-list-btn'
  renameBtn.title = 'Rename'
  renameBtn.textContent = '✎'
  renameBtn.addEventListener('click', () => {
    const field = document.createElement('input')
    field.type = 'text'
    field.className = 'cal-list-rename-input'
    field.value = nameEl.textContent
    nameEl.replaceWith(field)
    renameBtn.disabled = true
    field.focus(); field.select()

    const commit = async () => {
      const val = field.value.trim() || nameEl.textContent
      if (val !== nameEl.textContent) {
        const token = await getToken()
        if (token) await updateList(token, list.id, { name: val })
      }
      nameEl.textContent = val
      field.replaceWith(nameEl)
      renameBtn.disabled = false
    }
    field.addEventListener('blur', commit)
    field.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); field.blur() }
      if (e.key === 'Escape') { field.value = nameEl.textContent; field.blur() }
    })
  })

  const delBtn = document.createElement('button')
  delBtn.className = 'cal-list-btn'
  delBtn.title = 'Delete'
  delBtn.textContent = '×'
  delBtn.addEventListener('click', async () => {
    if (!confirm(`Delete "${nameEl.textContent}"?`)) return
    const token = await getToken()
    if (!token) return
    await deleteList(token, list.id)
    row.remove()
  })

  row.append(nameEl, renameBtn, delBtn)
  return row
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

  panel.querySelector('#btn-panel-signout')?.addEventListener('click', logout)
  panel.querySelector('#btn-add-secondary')?.addEventListener('click', addAccount)
  panel.querySelectorAll('.acct-remove').forEach(btn => {
    btn.addEventListener('click', () => logoutAccount(btn.dataset.id))
  })
}

function el(tag, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
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

  const _now = new Date()
  const _todayMidnight = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate())

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
      const isTask = item.item_type === 'TASK' || (item.item_type === 'EVENT' && !!item.metadata?.task_calendar)
      const isDone = item.status === 'COMPLETED'
      // All-day: end is exclusive midnight of day-after-last, so end <= todayMidnight means fully past
      const isPast    = item.end ? new Date(item.end) <= _todayMidnight : new Date(item.start) < _todayMidnight
      const isPastDue = isTask && isPast && !isDone

      const chipEl = document.createElement('div')
      chipEl.className = [
        'allday-event',
        isTask ? 'type-task' : '',
        isDone    ? 'completed' : '',
        isPast && !isTask && !isDone ? 'is-past'   : '',
        isPastDue                    ? 'past-due'   : '',
        span.startsEarly             ? 'continues-left'  : '',
        span.endsLate                ? 'continues-right' : '',
      ].filter(Boolean).join(' ')
      chipEl.title = item.title

      chipEl.style.left  = `calc(${span.startDay / 7 * 100}% + 2px)`
      chipEl.style.width = `calc(${(span.endDay - span.startDay + 1) / 7 * 100}% - 4px)`
      chipEl.style.top   = `${2 + span.row * ROW_H}px`

      if (isTask) {
        if (isDone) chipEl.style.background = 'transparent'
        else if (item.color) applyColor(chipEl, item.color)

        const check = document.createElement('button')
        check.className = `task-check${isDone ? ' done' : ''}`
        check.setAttribute('aria-label', isDone ? 'Mark incomplete' : 'Mark complete')
        if (isDone) check.textContent = '✓'
        check.addEventListener('click', e => {
          e.stopPropagation()
          if (item.item_type === 'TASK') handleToggleTask(item)
          else                           handleToggleCommitment(item)
        })

        const titleSpan = document.createElement('span')
        titleSpan.textContent = item.title

        const isRecurring = !!(item.recurrence || item.metadata?.recurringEventId)
        const recurIcon = isRecurring ? (() => {
          const s = document.createElement('span')
          s.className   = 'task-recur-icon'
          s.textContent = '↻'
          s.title       = 'Recurring'
          return s
        })() : null

        const snoozeBtn = !isDone ? (() => {
          const btn = document.createElement('button')
          btn.className   = 'task-snooze'
          btn.title       = 'Snooze'
          btn.textContent = '⏰'
          btn.addEventListener('click', e => {
            e.stopPropagation()
            if (item.item_type === 'TASK')
              openSnoozePopover(btn, item, refreshCalendarItems)
            else
              openSnoozePopover(btn, item, refreshCalendarItems,
                (n, newDate, dateLabel) => handleSnoozeCommitment(item, n, newDate, dateLabel))
          })
          return btn
        })() : null

        chipEl.append(check, titleSpan, ...(recurIcon ? [recurIcon] : []), ...(snoozeBtn ? [snoozeBtn] : []))
        chipEl.style.cursor = 'pointer'
        chipEl.addEventListener('click', () => {
          openEditorForEdit(item, calendarModalCallbacks())
        })

        if (item.item_type === 'TASK') {
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
        }
      } else {
        if (item.color) applyColor(chipEl, item.color)
        const isRecurringEv = !!(item.recurrence || item.metadata?.recurringEventId)
        chipEl.textContent = item.title + (isRecurringEv ? ' ↻' : '')
        chipEl.style.cursor = 'pointer'
        chipEl.addEventListener('click', () => {
          openEditorForEdit(item, calendarModalCallbacks())
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
      const el          = document.createElement('div')
      const _timedPast  = end <= _now
      const _timedTask  = item.item_type === 'TASK' || (item.item_type === 'EVENT' && !!item.metadata?.task_calendar)
      const _timedDone  = item.status === 'COMPLETED'
      el.className = [
        'cal-event',
        _timedTask ? 'type-task' : '',
        _timedPast && !_timedTask && !_timedDone ? 'is-past'  : '',
        _timedTask && _timedPast  && !_timedDone ? 'past-due' : '',
      ].filter(Boolean).join(' ')
      el.dataset.itemId = item.id
      if (item.color) applyColor(el, item.color)
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
      const isRecurringEv = !!(item.recurrence || item.metadata?.recurringEventId)
      const titleEl = document.createElement('div')
      titleEl.className   = 'event-title'
      titleEl.textContent = item.title + (isRecurringEv ? ' ↻' : '')
      const timeEl  = document.createElement('div')
      timeEl.className   = 'event-time'
      timeEl.textContent = formatTimeRange(start, end)
      el.append(titleEl, timeEl)
      el.title = item.title
      if (item.item_type === 'TASK') {
        el.addEventListener('click', () => {
          openEditorForEdit(item, calendarModalCallbacks())
        })
      } else {
        el.addEventListener('click', () => {
          openEditorForEdit(item, calendarModalCallbacks())
        })
        if (item.editable) {
          const handle = document.createElement('div')
          handle.className = 'resize-handle'
          el.appendChild(handle)
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
      openEditor(
        { mode: 'event', date, startTime, endTime, allDay: false, calendars: state.calendars },
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
    chip.className = `mobile-allday-chip${item.item_type === 'TASK' ? ' type-task' : ''}`
    if (item.color) applyColor(chip, item.color)
    chip.textContent = item.title
    chip.title       = item.title
    chip.addEventListener('click', () => {
      openEditorForEdit(item, calendarModalCallbacks())
    })
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
    if (item.color) applyColor(eventEl, item.color)
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

    eventEl.addEventListener('click', () => {
      openEditorForEdit(item, calendarModalCallbacks())
    })
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
      await patchTaskDate(token, item.source.account_id, item.source.external_id, newDue)
      await refreshCalendarItems()
    } catch (err) {
      console.error('Calendar drag move failed:', err)
    }
  })
}

// ── Create handlers (+ button, all-day click, timed-col click) ───────────────

function initCreateHandlers() {
  // "+" header button → open editor (user chooses mode via toggle in editor)
  document.getElementById('btn-add').addEventListener('click', e => {
    e.stopPropagation()
    openEditor(
      { mode: 'event', calendars: state.calendars },
      { onSaved: refreshCalendarItems }
    )
  })

  // All-day col background click → new all-day event for that date
  document.getElementById('allday-cols').addEventListener('click', e => {
    if (e.target.closest('.allday-event') || e.target.closest('.allday-more')) return
    const col = e.target.closest('.allday-col')
    if (!col) return
    const dayIdx = parseInt(col.dataset.day, 10)
    const date   = addDays(state.weekStart, dayIdx).toLocaleDateString('en-CA')
    openEditor(
      { mode: 'event', date, allDay: true, calendars: state.calendars },
      { onSaved: refreshCalendarItems }
    )
  })

  // Timed col background click → new timed event at the clicked time slot
  document.getElementById('timed-cols').addEventListener('click', e => {
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
    openEditor(
      { mode: 'event', date, startTime, allDay: false, calendars: state.calendars },
      { onSaved: refreshCalendarItems }
    )
  })
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
    // Fetch items, task lists, and prefs in parallel
    const [items] = await Promise.all([
      fetchItems(state.weekStart, end),
      getToken().then(t => t ? loadPrefs(t).then(() => {
        state.hiddenCalendars = new Set(getHiddenCalendars())
        state.taskCalendars   = new Set(getTaskCalendars())
      }) : null),
      getToken().then(t => t ? loadLists(t) : null),
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

// Board recurring-task filter
const _recurringToggle = document.getElementById('board-show-recurring')
_recurringToggle.checked = localStorage.getItem('kairos:showRecurring') === 'true'
_recurringToggle.addEventListener('change', e => {
  localStorage.setItem('kairos:showRecurring', e.target.checked)
  renderBoard(state.taskLists, getBoardItems(), boardCallbacks(), state.doneWindow)
})

// Show version on hover over the app title
document.getElementById('app-name').dataset.tooltip = `v${VERSION}`

// Init editor + snooze popover listeners once
initEditor()
initSnooze()
initCalendarDrag()
initCreateHandlers()
initTimeIndicator()
initMobileDayView()

// Close account panel on outside click
document.addEventListener('click', () => {
  document.getElementById('account-panel').hidden = true
})
document.getElementById('account-panel').addEventListener('click', e => e.stopPropagation())

render().then(async () => {
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

  runSpawnScan()
  startPolling(120_000)
})
