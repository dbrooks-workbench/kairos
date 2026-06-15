import { getToken, isAuthenticated, logout, loginUrl } from './auth.js'
import { getCalendars, getEvents } from './providers/googleCalendar.js'
import { getTasks } from './providers/googleTasks.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const state = {
  weekStart: getWeekStart(new Date()),
  items: [],
  calendars: [],
  hiddenCalendars: new Set(JSON.parse(localStorage.getItem('kairos:hidden-cals') ?? '[]')),
}

// ── Date helpers ─────────────────────────────────────────────────────────────

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

  const visibleIds = state.calendars.length
    ? new Set(state.calendars.filter(c => !state.hiddenCalendars.has(c.id)).map(c => c.id))
    : null

  const [events, tasks] = await Promise.all([
    getEvents(token, start, end, visibleIds)
      .catch(err => { console.error('Calendar events fetch failed:', err); return [] }),
    getTasks(token, start, end)
      .catch(err => { console.error('Tasks fetch failed:', err); return [] }),
  ])
  return [...events, ...tasks]
}

// ── Calendar picker ───────────────────────────────────────────────────────────

function renderCalendarPicker() {
  const panel = document.getElementById('cal-picker-panel')
  const btn   = document.getElementById('btn-calendars')
  const visible = state.calendars.filter(c => !state.hiddenCalendars.has(c.id))

  // Update button badge
  btn.innerHTML = `Calendars <span class="count">${visible.length}/${state.calendars.length}</span>`

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
      renderCalendarPicker()
      refreshItems()
    })
  })
}

async function refreshItems() {
  const end = addDays(state.weekStart, 7)
  const items = await fetchItems(state.weekStart, end)
  state.items = items
  renderItems(items)
}

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
  const authed = await isAuthenticated()
  const statusEl = document.getElementById('account-status')
  const bannerEl = document.getElementById('connect-banner')

  if (!authed) {
    statusEl.innerHTML = `<a href="${loginUrl()}">Sign in</a>`
    bannerEl.style.display = 'flex'
  } else {
    bannerEl.style.display = 'none'
    statusEl.innerHTML = `<button id="btn-signout">Sign out</button>`
    document.getElementById('btn-signout').addEventListener('click', logout)
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

function renderItems(items) {
  document.querySelectorAll('.cal-event, .allday-event').forEach(el => el.remove())

  for (const item of items) {
    const start  = new Date(item.start)
    const dayIdx = Math.floor((start - state.weekStart) / 86_400_000)
    if (dayIdx < 0 || dayIdx >= 7) continue

    if (item.all_day) {
      const col = document.querySelector(`.allday-col[data-day="${dayIdx}"]`)
      if (!col) continue
      const el = document.createElement('div')
      el.className = `allday-event${item.item_type === 'TASK' ? ' type-task' : ''}`
      if (item.color) el.style.background = item.color
      el.textContent = item.title
      el.title = item.title
      col.appendChild(el)
    } else {
      const col = document.querySelector(`.timed-col[data-day="${dayIdx}"]`)
      if (!col) continue
      const topMin  = start.getHours() * 60 + start.getMinutes()
      const end     = item.end ? new Date(item.end) : new Date(start.getTime() + 30 * 60_000)
      const durMin  = Math.max((end - start) / 60_000, 15)
      const el      = document.createElement('div')
      el.className  = `cal-event${item.item_type === 'TASK' ? ' type-task' : ''}`
      if (item.color) el.style.background = item.color
      el.style.top    = `${topMin}px`
      el.style.height = `${durMin}px`
      el.textContent  = item.title
      el.title        = item.title
      col.appendChild(el)
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
  loadCalendars() // async, populates picker in background

  const end   = addDays(state.weekStart, 7)
  const items = await fetchItems(state.weekStart, end)
  state.items = items
  renderItems(items)
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

render().then(() => {
  // #col-headers is sticky so it always occupies the top of the visible area.
  // Scroll past the all-day row then 8 hours into the timed grid.
  const timedScroll = document.getElementById('timed-scroll')
  const alldayRow   = document.getElementById('allday-row')
  timedScroll.scrollTop = alldayRow.offsetHeight + 8 * 60
})
