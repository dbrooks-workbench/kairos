import { getToken } from './auth.js'
import { createEvent } from './providers/googleCalendar.js'

let _callbacks = {}

const DAY_SHORT = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// ── Custom recurrence state ───────────────────────────────────────────────────

let _crpFreq     = 'WEEKLY'
let _crpInterval = 1
let _crpByDay    = new Set()
let _crpEndType  = 'never'
let _crpEndDate  = ''
let _crpEndCount = 10

function buildCustomRrule() {
  let rule = `RRULE:FREQ=${_crpFreq}`
  if (_crpInterval > 1) rule += `;INTERVAL=${_crpInterval}`
  if (_crpFreq === 'WEEKLY' && _crpByDay.size > 0) {
    rule += `;BYDAY=${[..._crpByDay].join(',')}`
  }
  if (_crpEndType === 'date' && _crpEndDate) {
    rule += `;UNTIL=${_crpEndDate.replace(/-/g, '')}T235959Z`
  } else if (_crpEndType === 'count' && _crpEndCount > 0) {
    rule += `;COUNT=${_crpEndCount}`
  }
  return rule
}

// ── Simple recurrence presets ─────────────────────────────────────────────────

function buildRrule(freq, startDate) {
  if (!freq || freq === 'CUSTOM') return null
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

// ── DOM helpers ───────────────────────────────────────────────────────────────

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

function setAllDayUI(allDay) {
  el('event-modal-panel').classList.toggle('all-day', allDay)
}

// ── Custom recurrence panel init ──────────────────────────────────────────────

function initCustomRecur() {
  el('crp-freq').addEventListener('change', e => {
    _crpFreq = e.target.value
    el('crp-days-row').hidden = _crpFreq !== 'WEEKLY'
  })

  el('crp-interval').addEventListener('input', e => {
    _crpInterval = Math.max(1, parseInt(e.target.value, 10) || 1)
  })

  document.querySelectorAll('.crp-day').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = btn.dataset.day
      if (_crpByDay.has(day)) { _crpByDay.delete(day); btn.classList.remove('active') }
      else                    { _crpByDay.add(day);    btn.classList.add('active') }
    })
  })

  document.querySelectorAll('input[name="crp-end"]').forEach(radio => {
    radio.addEventListener('change', e => {
      _crpEndType = e.target.value
      el('crp-end-date').disabled  = _crpEndType !== 'date'
      el('crp-end-count').disabled = _crpEndType !== 'count'
    })
  })

  el('crp-end-date').addEventListener('input',  e => { _crpEndDate  = e.target.value })
  el('crp-end-count').addEventListener('input', e => { _crpEndCount = parseInt(e.target.value, 10) || 10 })
}

function resetCustomRecur(startDateStr) {
  _crpFreq     = 'WEEKLY'
  _crpInterval = 1
  _crpByDay    = new Set()
  _crpEndType  = 'never'
  _crpEndDate  = ''
  _crpEndCount = 10

  el('crp-freq').value     = 'WEEKLY'
  el('crp-interval').value = 1
  el('crp-days-row').hidden = false
  el('crp-end-date').value  = ''
  el('crp-end-count').value = 10
  el('crp-end-date').disabled  = true
  el('crp-end-count').disabled = true
  document.querySelector('input[name="crp-end"][value="never"]').checked = true

  // Pre-select the start date's day of week
  document.querySelectorAll('.crp-day').forEach(b => b.classList.remove('active'))
  if (startDateStr) {
    const dow     = new Date(startDateStr + 'T00:00:00').getDay()
    const dayCode = DAY_SHORT[dow]
    _crpByDay.add(dayCode)
    document.querySelector(`.crp-day[data-day="${dayCode}"]`)?.classList.add('active')
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initEventEditor() {
  el('event-modal-close').addEventListener('click',  close)
  el('event-modal-cancel').addEventListener('click', close)
  el('event-modal-save').addEventListener('click',   save)

  el('event-modal-allday').addEventListener('change', () => {
    setAllDayUI(el('event-modal-allday').checked)
  })

  el('event-modal-recur').addEventListener('change', e => {
    el('custom-recur-panel').hidden = e.target.value !== 'CUSTOM'
  })

  el('event-modal').addEventListener('click', e => {
    if (e.target === el('event-modal')) close()
  })

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !el('event-modal').hidden) close()
  })

  initCustomRecur()
}

// opts: { date, startTime, allDay, calendarId, calendars }
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
  el('custom-recur-panel').hidden  = true
  resetCustomRecur(today)

  // Populate calendar list
  const calSelect = el('event-modal-calendar')
  if (opts.calendars?.length) {
    populateCalendars(calSelect, opts.calendars, opts.calendarId)
  } else {
    calSelect.innerHTML = '<option value="">Loading…</option>'
    const token = await getToken()
    if (token) {
      try {
        const { getCalendars } = await import('./providers/googleCalendar.js')
        populateCalendars(calSelect, await getCalendars(token), opts.calendarId)
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

// ── Save ──────────────────────────────────────────────────────────────────────

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
    // Google Calendar end is exclusive for all-day events
    const endD = new Date((endDate <= startDate ? startDate : endDate) + 'T00:00:00')
    endD.setDate(endD.getDate() + 1)
    const pad = v => String(v).padStart(2, '0')
    body.start = { date: startDate }
    body.end   = { date: `${endD.getFullYear()}-${pad(endD.getMonth() + 1)}-${pad(endD.getDate())}` }
  } else {
    body.start = { dateTime: `${startDate}T${startTime}:00`, timeZone: tz }
    body.end   = { dateTime: `${endDate}T${endTime}:00`,     timeZone: tz }
  }

  const rrule = freq === 'CUSTOM' ? buildCustomRrule() : buildRrule(freq, startDate)
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
