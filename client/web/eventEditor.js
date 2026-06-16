import { getToken } from './auth.js'
import { createEvent } from './providers/googleCalendar.js'

let _callbacks = {}

const DAY_SHORT = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function el(id) { return document.getElementById(id) }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function minutesToTime(total) {
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function buildRrule(freq, startDate) {
  if (!freq) return null
  if (freq === 'DAILY')    return 'RRULE:FREQ=DAILY'
  if (freq === 'MONTHLY')  return 'RRULE:FREQ=MONTHLY'
  if (freq === 'ANNUALLY') return 'RRULE:FREQ=YEARLY'
  if (freq === 'WEEKDAYS') return 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'
  if (freq === 'WEEKLY') {
    const d = new Date(startDate + 'T00:00:00')
    return `RRULE:FREQ=WEEKLY;BYDAY=${DAY_SHORT[d.getDay()]}`
  }
  return null
}

function setAllDayUI(allDay) {
  el('event-modal-panel').classList.toggle('all-day', allDay)
}

export function initEventEditor() {
  el('event-modal-close').addEventListener('click', close)
  el('event-modal-cancel').addEventListener('click', close)
  el('event-modal-save').addEventListener('click', save)
  el('event-modal-allday').addEventListener('change', () => {
    setAllDayUI(el('event-modal-allday').checked)
  })
  el('event-modal').addEventListener('click', e => {
    if (e.target === el('event-modal')) close()
  })
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el('event-modal').hidden) close()
  })
}

// opts: { date, startTime, endTime, allDay, calendars }
// calendars: raw Google Calendar API list objects (optional — fetched if not provided)
export async function openEventEditor(opts = {}, callbacks = {}) {
  _callbacks = callbacks

  const allDay = opts.allDay ?? false
  el('event-modal-allday').checked = allDay
  setAllDayUI(allDay)

  const today = opts.date ?? new Date().toLocaleDateString('en-CA')
  el('event-modal-start-date').value = today
  el('event-modal-end-date').value   = today

  if (opts.startTime) {
    el('event-modal-start-time').value = opts.startTime
    el('event-modal-end-time').value   = minutesToTime(timeToMinutes(opts.startTime) + 30)
  } else {
    el('event-modal-start-time').value = '09:00'
    el('event-modal-end-time').value   = '09:30'
  }

  el('event-modal-title').value    = ''
  el('event-modal-location').value = ''
  el('event-modal-desc').value     = ''
  el('event-modal-recur').value    = ''

  // Populate calendar list
  const calSelect = el('event-modal-calendar')
  const calendars = opts.calendars ?? null

  if (calendars?.length) {
    populateCalendars(calSelect, calendars, opts.calendarId)
  } else {
    calSelect.innerHTML = '<option value="">Loading…</option>'
    const token = await getToken()
    if (token) {
      try {
        const { getCalendars } = await import('./providers/googleCalendar.js')
        const list = await getCalendars(token)
        populateCalendars(calSelect, list, opts.calendarId)
      } catch {
        calSelect.innerHTML = '<option value="">Could not load calendars</option>'
      }
    }
  }

  el('event-modal').hidden = false
  el('event-modal-title').focus()
}

function populateCalendars(select, calendars, preferredId) {
  const writable = calendars.filter(c => c.accessRole === 'owner' || c.accessRole === 'writer')
  select.innerHTML = writable
    .map(c => `<option value="${esc(c.id)}"${c.primary ? ' selected' : ''}>${esc(c.summary)}</option>`)
    .join('')
  if (preferredId) select.value = preferredId
}

function close() {
  el('event-modal').hidden = true
}

async function save() {
  const title = el('event-modal-title').value.trim()
  if (!title) { el('event-modal-title').focus(); return }

  const calendarId = el('event-modal-calendar').value
  if (!calendarId) return

  const allDay    = el('event-modal-allday').checked
  const startDate = el('event-modal-start-date').value
  const endDate   = el('event-modal-end-date').value || startDate
  const startTime = el('event-modal-start-time').value
  const endTime   = el('event-modal-end-time').value
  const freq      = el('event-modal-recur').value
  const location  = el('event-modal-location').value.trim()
  const desc      = el('event-modal-desc').value.trim()
  const tz        = Intl.DateTimeFormat().resolvedOptions().timeZone

  const body = {
    summary: title,
    ...(location && { location }),
    ...(desc && { description: desc }),
  }

  if (allDay) {
    // Google Calendar end is exclusive for all-day: advance by 1 if same as start
    let endD = new Date(endDate + 'T00:00:00')
    if (endDate <= startDate) endD = new Date(startDate + 'T00:00:00')
    endD.setDate(endD.getDate() + 1)
    const pad = v => String(v).padStart(2, '0')
    body.start = { date: startDate }
    body.end   = { date: `${endD.getFullYear()}-${pad(endD.getMonth() + 1)}-${pad(endD.getDate())}` }
  } else {
    body.start = { dateTime: `${startDate}T${startTime}:00`, timeZone: tz }
    body.end   = { dateTime: `${endDate}T${endTime}:00`, timeZone: tz }
  }

  const rrule = buildRrule(freq, startDate)
  if (rrule) body.recurrence = [rrule]

  const token = await getToken()
  if (!token) return

  const saveBtn = el('event-modal-save')
  saveBtn.disabled = true
  try {
    await createEvent(token, calendarId, body)
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Event creation failed:', err)
  } finally {
    saveBtn.disabled = false
  }
}
