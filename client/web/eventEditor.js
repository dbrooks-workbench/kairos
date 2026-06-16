import { getToken } from './auth.js'
import { createEvent, updateEvent, getEvent } from './providers/googleCalendar.js'
import { serializeNotes, serializeEventDescription } from './providers/parsers.js'

let _callbacks     = {}
let _spawns        = []     // [{ key, title, triggerDays, dueDays, loe, checklist, _autoKey }]
let _editItem      = null   // CalendarItem being edited; null = create mode
let _preserveRrule = null   // original RRULE to keep when "Custom" is not re-configured
let _pendingBody   = null   // body held while scope-picker modal is open

const DAY_SHORT = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

// ── Recurrence helpers ────────────────────────────────────────────────────────

// Match an existing RRULE string to one of our simple preset keys (or 'CUSTOM')
function matchRrulePreset(rrule) {
  if (!rrule) return ''
  if (rrule === 'RRULE:FREQ=DAILY')   return 'DAILY'
  if (rrule === 'RRULE:FREQ=MONTHLY') return 'MONTHLY'
  if (rrule === 'RRULE:FREQ=YEARLY')  return 'ANNUALLY'
  if (/RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR/.test(rrule)) return 'WEEKDAYS'
  if (/RRULE:FREQ=WEEKLY/.test(rrule)) return 'WEEKLY'
  return 'CUSTOM'
}

// Parse "-30d" → -30 (used when loading spawn config from an existing event)
function parseDayOffset(str) {
  const m = String(str ?? '0d').match(/^(-?\d+)d$/)
  return m ? parseInt(m[1], 10) : 0
}

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
  if (_crpFreq === 'WEEKLY' && _crpByDay.size > 0) rule += `;BYDAY=${[..._crpByDay].join(',')}`
  if (_crpEndType === 'date'  && _crpEndDate)  rule += `;UNTIL=${_crpEndDate.replace(/-/g, '')}T235959Z`
  if (_crpEndType === 'count' && _crpEndCount) rule += `;COUNT=${_crpEndCount}`
  return rule
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id) }

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m }
function minutesToTime(n) { return `${String(Math.floor(n/60)%24).padStart(2,'0')}:${String(n%60).padStart(2,'0')}` }

function setAllDayUI(allDay) {
  el('event-modal-panel').classList.toggle('all-day', allDay)
}

function slugify(str) {
  return String(str).toUpperCase().trim().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'TASK'
}

// ── Spawn list UI ─────────────────────────────────────────────────────────────

function renderSpawnList() {
  const container = el('event-spawn-items')
  container.innerHTML = ''

  _spawns.forEach((spawn, idx) => {
    const entry = document.createElement('div')
    entry.className = 'spawn-entry'
    entry.innerHTML = `
      <div class="spawn-entry-header">
        <input class="spawn-title modal-input" type="text" placeholder="Task title…" value="${esc(spawn.title)}">
        <button type="button" class="spawn-remove modal-row-del">×</button>
      </div>
      <div class="spawn-fields">
        <div class="spawn-field-row">
          <label class="spawn-label">Key</label>
          <input class="spawn-key modal-input" type="text" placeholder="TASK-KEY" value="${esc(spawn.key)}">
        </div>
        <div class="spawn-field-row">
          <label class="spawn-label">Trigger</label>
          <input class="spawn-num crp-interval" type="number" min="0" max="365" value="${spawn.triggerDays}" data-field="triggerDays">
          <span class="spawn-suffix">days before event</span>
        </div>
        <div class="spawn-field-row">
          <label class="spawn-label">Due</label>
          <input class="spawn-num crp-interval" type="number" min="0" max="365" value="${spawn.dueDays}" data-field="dueDays">
          <span class="spawn-suffix">days before event</span>
        </div>
        <div class="spawn-field-row">
          <label class="spawn-label">LOE</label>
          <input class="spawn-loe modal-input" type="text" placeholder="1h 30m" value="${esc(spawn.loe)}">
        </div>
        <div class="spawn-field-row spawn-cl-row">
          <label class="spawn-label">Checklist</label>
          <textarea class="spawn-checklist modal-notes" rows="3" placeholder="One item per line…">${esc(spawn.checklist.join('\n'))}</textarea>
        </div>
      </div>`

    const titleInp = entry.querySelector('.spawn-title')
    const keyInp   = entry.querySelector('.spawn-key')

    titleInp.addEventListener('input', e => {
      _spawns[idx].title = e.target.value
      if (_spawns[idx]._autoKey) {
        const auto = slugify(e.target.value)
        _spawns[idx].key = auto
        keyInp.value = auto
      }
    })
    keyInp.addEventListener('input', e => {
      _spawns[idx].key = e.target.value
      _spawns[idx]._autoKey = false
    })
    entry.querySelectorAll('.spawn-num').forEach(inp => {
      inp.addEventListener('input', e => {
        _spawns[idx][e.target.dataset.field] = Math.max(0, parseInt(e.target.value, 10) || 0)
      })
    })
    entry.querySelector('.spawn-loe').addEventListener('input', e => {
      _spawns[idx].loe = e.target.value.trim()
    })
    entry.querySelector('.spawn-checklist').addEventListener('input', e => {
      _spawns[idx].checklist = e.target.value.split('\n').map(s => s.trim()).filter(Boolean)
    })
    entry.querySelector('.spawn-remove').addEventListener('click', () => {
      _spawns.splice(idx, 1)
      renderSpawnList()
    })

    container.appendChild(entry)
  })

  el('event-spawn-count').textContent = _spawns.length ? `(${_spawns.length})` : ''
}

function addSpawn() {
  _spawns.push({ key: '', title: '', triggerDays: 30, dueDays: 5, loe: '', checklist: [], _autoKey: true })
  renderSpawnList()
  el('event-spawn-section').open = true
  // Focus the new title input
  const entries = el('event-spawn-items').querySelectorAll('.spawn-title')
  entries[entries.length - 1]?.focus()
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
  _crpFreq = 'WEEKLY'; _crpInterval = 1; _crpByDay = new Set()
  _crpEndType = 'never'; _crpEndDate = ''; _crpEndCount = 10
  el('crp-freq').value = 'WEEKLY'
  el('crp-interval').value = 1
  el('crp-days-row').hidden = false
  el('crp-end-date').value = ''; el('crp-end-date').disabled = true
  el('crp-end-count').value = 10; el('crp-end-count').disabled = true
  document.querySelector('input[name="crp-end"][value="never"]').checked = true
  document.querySelectorAll('.crp-day').forEach(b => b.classList.remove('active'))
  if (startDateStr) {
    const code = DAY_SHORT[new Date(startDateStr + 'T00:00:00').getDay()]
    _crpByDay.add(code)
    document.querySelector(`.crp-day[data-day="${code}"]`)?.classList.add('active')
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function initEventEditor() {
  el('event-modal-close').addEventListener('click',  close)
  el('event-modal-cancel').addEventListener('click', close)
  el('event-modal-save').addEventListener('click',   save)

  el('event-modal-allday').addEventListener('change', () => setAllDayUI(el('event-modal-allday').checked))

  el('event-modal-recur').addEventListener('change', e => {
    el('custom-recur-panel').hidden = e.target.value !== 'CUSTOM'
    _preserveRrule = null  // user changed the selector — don't preserve original anymore
  })

  el('event-spawn-add').addEventListener('click', addSpawn)

  el('event-modal').addEventListener('click', e => { if (e.target === el('event-modal')) close() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('event-modal').hidden) close() })

  // Recurring-event scope picker (guard against stale-cache HTML/JS mismatch)
  el('recur-scope-cancel')?.addEventListener('click', () => {
    el('recur-scope-modal').hidden = true
    _pendingBody = null
    el('event-modal-save').disabled = false
  })
  el('recur-scope-ok')?.addEventListener('click', () => executeWithScope(
    document.querySelector('input[name="recur-scope"]:checked')?.value ?? 'this'
  ))

  initCustomRecur()
}

export async function openEventEditor(opts = {}, callbacks = {}) {
  _editItem      = null
  _preserveRrule = null
  _callbacks     = callbacks
  _spawns        = []

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
  el('event-spawn-section').open   = false
  renderSpawnList()
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

// Open the editor pre-populated with an existing CalendarItem for editing.
export async function openEventEditorForEdit(item, callbacks = {}) {
  _editItem      = item
  _preserveRrule = null
  _callbacks     = callbacks

  const allDay = item.all_day
  el('event-modal-allday').checked = allDay
  setAllDayUI(allDay)

  const start      = new Date(item.start)
  const endRaw     = item.end ? new Date(item.end) : new Date(start.getTime() + 30 * 60_000)
  // All-day end from Google Calendar is exclusive — show inclusive to the user
  const displayEnd = allDay ? new Date(endRaw.getTime() - 86_400_000) : endRaw

  const toDate = d => d.toLocaleDateString('en-CA')
  const toTime = d => `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`

  el('event-modal-start-date').value = toDate(start)
  el('event-modal-end-date').value   = toDate(displayEnd)
  el('event-modal-start-time').value = toTime(start)
  el('event-modal-end-time').value   = toTime(endRaw)

  el('event-modal-title').value    = item.title
  el('event-modal-location').value = item.metadata?.location ?? ''
  el('event-modal-desc').value     = item.metadata?.body ?? ''

  // Recurrence — match to preset or fall back to CUSTOM (preserving original)
  const preset = matchRrulePreset(item.recurrence)
  el('event-modal-recur').value = preset
  el('custom-recur-panel').hidden = preset !== 'CUSTOM'
  if (preset === 'CUSTOM' && item.recurrence) _preserveRrule = item.recurrence

  resetCustomRecur(toDate(start))

  // Pre-load spawn prototypes from existing config
  _spawns = (item.metadata?.config?.spawn ?? []).map(s => ({
    key:         s.key,
    title:       s.title,
    triggerDays: Math.abs(parseDayOffset(s.trigger)),
    dueDays:     Math.abs(parseDayOffset(s.due ?? '0d')),
    loe:         s.loe ?? '',
    checklist:   s.checklist ?? [],
    _autoKey:    false,
  }))
  renderSpawnList()
  el('event-spawn-section').open = _spawns.length > 0

  // Populate calendar list and, for recurring instances, load master RRULE
  const calSelect = el('event-modal-calendar')
  calSelect.innerHTML = '<option value="">Loading…</option>'
  const token = await getToken()
  if (token) {
    const calendarPromise = (async () => {
      try {
        const { getCalendars } = await import('./providers/googleCalendar.js')
        populateCalendars(calSelect, await getCalendars(token), item.source.account_id)
      } catch {
        calSelect.innerHTML = `<option value="${item.source.account_id}" selected>${item.metadata?.calendar_name ?? 'Current calendar'}</option>`
      }
    })()

    // Instances don't carry recurrence — fetch the master to show the correct RRULE
    const masterPromise = item.metadata?.recurring_event_id
      ? getEvent(token, item.source.account_id, item.metadata.recurring_event_id).catch(() => null)
      : Promise.resolve(null)

    const [, master] = await Promise.all([calendarPromise, masterPromise])

    if (master?.recurrence?.[0]) {
      const masterPreset = matchRrulePreset(master.recurrence[0])
      el('event-modal-recur').value = masterPreset
      el('custom-recur-panel').hidden = masterPreset !== 'CUSTOM'
      _preserveRrule = masterPreset === 'CUSTOM' ? master.recurrence[0] : null
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

function close() { el('event-modal').hidden = true }

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
  const prose     = el('event-modal-desc').value.trim()
  const tz        = Intl.DateTimeFormat().resolvedOptions().timeZone

  // Build spawn config if any entries are defined
  const spawnArr = _spawns
    .filter(s => s.key && s.title)
    .map(s => {
      const e = { key: s.key, title: s.title, trigger: `-${s.triggerDays}d`, due: `-${s.dueDays}d` }
      if (s.loe)              e.loe = s.loe
      if (s.checklist.length) e.checklist = s.checklist
      return e
    })
  const config = spawnArr.length ? { spawn: spawnArr } : null

  // Serialize description: prose → JSON config block → (empty log at create time)
  const description = serializeEventDescription(prose, config, []) || undefined

  const body = {
    summary: title,
    ...(location    && { location }),
    ...(description && { description }),
  }

  if (allDay) {
    const endD = new Date((endDate <= startDate ? startDate : endDate) + 'T00:00:00')
    endD.setDate(endD.getDate() + 1)
    const pad = v => String(v).padStart(2, '0')
    body.start = { date: startDate }
    body.end   = { date: `${endD.getFullYear()}-${pad(endD.getMonth()+1)}-${pad(endD.getDate())}` }
  } else {
    body.start = { dateTime: `${startDate}T${startTime}:00`, timeZone: tz }
    body.end   = { dateTime: `${endDate}T${endTime}:00`,     timeZone: tz }
  }

  // Recurrence: CUSTOM in edit mode preserves the original RRULE unless the user
  // re-configured the custom panel (signaled by _preserveRrule being cleared).
  let rrule
  if (freq === 'CUSTOM') {
    rrule = _preserveRrule ?? buildCustomRrule()
  } else {
    rrule = buildRrule(freq, startDate)
  }
  if (rrule) {
    body.recurrence = [rrule]
  } else if (_editItem && freq === '') {
    // Explicitly removing recurrence from an existing event
    body.recurrence = []
  }

  // In edit mode, preserve existing log comments — only update prose + config
  if (_editItem) {
    const existingComments = _editItem.metadata?.comments ?? []
    body.description = serializeEventDescription(prose, config, existingComments) || undefined
  }

  const token = await getToken()
  if (!token) return

  const saveBtn = el('event-modal-save')
  saveBtn.disabled = true

  // For recurring event instances, pause and show the scope picker
  if (_editItem?.metadata?.recurring_event_id) {
    const scopeModal = el('recur-scope-modal')
    if (scopeModal) {
      _pendingBody = body
      document.querySelector('input[name="recur-scope"][value="this"]').checked = true
      scopeModal.hidden = false
      return  // executeWithScope() will finish the save after the user picks
    }
    // Scope modal missing (stale cache) — fall through and save as 'this event'
  }

  // Non-recurring edit or new event — save immediately
  try {
    if (_editItem) {
      await updateEvent(token, _editItem.source.account_id, _editItem.source.external_id, body)
    } else {
      await createEvent(token, calendarId, body)
    }
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Event save failed:', err)
  } finally {
    saveBtn.disabled = false
  }
}

async function executeWithScope(scope) {
  const scopeModal = el('recur-scope-modal')
  if (scopeModal) scopeModal.hidden = true
  const body    = _pendingBody
  _pendingBody  = null
  const saveBtn = el('event-modal-save')
  const token   = await getToken()
  if (!token || !body) { saveBtn.disabled = false; return }
  try {
    if (scope === 'all')           await saveAllEvents(token, body)
    else if (scope === 'following') await saveThisAndFollowing(token, body)
    else await updateEvent(token, _editItem.source.account_id, _editItem.source.external_id, body)
    close()
    _callbacks.onSaved?.()
  } catch (err) {
    console.error('Event save failed:', err)
  } finally {
    saveBtn.disabled = false
  }
}

// ── Recurring save helpers ────────────────────────────────────────────────────

async function saveAllEvents(token, body) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurring_event_id

  // Fetch the master so we can preserve its original start date while
  // optionally applying a time-of-day change from the editor.
  const master = await getEvent(token, calId, masterId)

  // Build a safe patch body: text fields only, plus optional time update.
  const masterBody = {}
  if (body.summary)     masterBody.summary     = body.summary
  if (body.location)    masterBody.location    = body.location
  if (body.description !== undefined) masterBody.description = body.description
  if (body.recurrence?.length) masterBody.recurrence = body.recurrence

  // Apply time-of-day change to the master's original start/end date.
  // We do this only for timed (non-all-day) events; all-day events have no
  // meaningful time component to carry over.
  if (body.start?.dateTime && master.start?.dateTime) {
    const newTime  = body.start.dateTime.slice(11)   // 'HH:MM:SS'
    const origDate = master.start.dateTime.slice(0, 11) // 'YYYY-MM-DDT'
    masterBody.start = { dateTime: origDate + newTime, timeZone: body.start.timeZone }

    const newEndTime  = body.end.dateTime.slice(11)
    const origEndDate = master.end?.dateTime?.slice(0, 11) ?? origDate
    masterBody.end = { dateTime: origEndDate + newEndTime, timeZone: body.end.timeZone }
  }

  console.log('[saveAllEvents] masterBody:', JSON.stringify(masterBody))
  await updateEvent(token, calId, masterId, masterBody)
}

async function saveThisAndFollowing(token, body) {
  const calId    = _editItem.source.account_id
  const masterId = _editItem.metadata.recurring_event_id

  // Fetch master to get its current RRULE
  const master      = await getEvent(token, calId, masterId)
  const masterRrule = master.recurrence?.[0]

  // Truncate master: UNTIL = day before this instance's original start (UTC)
  if (masterRrule) {
    const cutoff = new Date(_editItem.start)
    cutoff.setUTCDate(cutoff.getUTCDate() - 1)
    cutoff.setUTCHours(23, 59, 59, 0)
    const pad = v => String(v).padStart(2, '0')
    const untilStr = `${cutoff.getUTCFullYear()}${pad(cutoff.getUTCMonth()+1)}${pad(cutoff.getUTCDate())}` +
                     `T${pad(cutoff.getUTCHours())}${pad(cutoff.getUTCMinutes())}${pad(cutoff.getUTCSeconds())}Z`
    const truncated = masterRrule.replace(/;?(UNTIL|COUNT)=[^;]*/g, '') + `;UNTIL=${untilStr}`
    await updateEvent(token, calId, masterId, { recurrence: [truncated] })
  }

  // Create new forward series starting at this instance's (possibly edited) date
  // Carry forward the master's RRULE (stripped of UNTIL/COUNT) if user didn't set one
  if (!body.recurrence && masterRrule) {
    body.recurrence = [masterRrule.replace(/;?(UNTIL|COUNT)=[^;]*/g, '')]
  }
  await createEvent(token, calId, body)
}
