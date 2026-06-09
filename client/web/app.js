import { getToken, isAuthenticated, logout, loginUrl } from './auth.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const state = {
  weekStart: getWeekStart(new Date()),
  items: [],
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

// ── Google API ───────────────────────────────────────────────────────────────

async function gFetch(url) {
  const token = await getToken()
  if (!token) return null
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) return null
  return res.json()
}

async function fetchItems(start, end) {
  // TODO: implement Google Calendar and Tasks fetches; return CalendarItem[]
  return []
}

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
  document.getElementById('timed-scroll').scrollTop = 8 * 60
})
