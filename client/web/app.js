import { getToken, getTokens, isAuthenticated, logout, logoutAccount, addAccount, loginUrl, invalidateCache } from './auth.js'
import { processSpawnDirectives } from './spawn.js'
import { getCalendars, getEvents, fetchDelta, clearSyncTokens, updateEvent } from './providers/googleCalendar.js'
import { getAllTaskEvents, getTaskEvents, completeTask as calCompleteTask, uncompleteTask as calUncompleteTask, patchTaskProps, patchTaskDate, findTaskByKairosId, ensureFooters, ensureAllFooters } from './providers/calendarTasks.js'
import { loadPrefs, getHiddenCalendars, setHiddenCalendars, getTaskCalendars, setTaskCalendars, getSweepSources, setSweepSources, getIntakeStatusId, setIntakeStatusId, getProjectCalendarId, setProjectCalendarId, getVisibilityStart, getVisibilityEnd, setVisibilityWindow, getMaxWindowDays, getListsMigrated, setListsMigrated } from './providers/kairosPrefs.js'
import { loadLists, getList } from './providers/kairosLists.js'   // retained only for the one-time listId→tag migration
import { loadConfig, ensureDefaultStatuses, getStatusesForCalendar, getStatus, getAllStatuses, getInProgressStatusIds, createStatus, getTagColor, getAllTagNames, ensureTags, getTagPalette, setTagColor, removeTagFromPalette } from './providers/kairosConfig.js'
import { encodeTags } from './providers/tagCodec.js'
import { loadStatuses as loadFsStatuses, getStatusesForCalendar as fsStatusesForCalendar } from './providers/kairosStatuses.js'

// One-time: convert each task's legacy listId into a tag named after the list,
// then clear the listId. Operates on state.boardItems (already loaded); patches the
// recurring master once. Sets a prefs flag so it never re-runs after a clean pass.
async function migrateListsToTags(token) {
  if (getListsMigrated()) return
  const targets = new Map()   // "calId:eventId" -> { calId, targetId, tagName }
  for (const item of state.boardItems) {
    if (!item.metadata?.listId) continue
    const tagName = getList(item.metadata.listId)?.name
    if (!tagName) continue
    const calId    = item.source.account_id
    const targetId = item.metadata.recurringEventId ?? item.source.external_id
    targets.set(`${calId}:${targetId}`, { calId, targetId, tagName, tags: item.metadata.tags ?? [] })
  }
  let failures = 0
  for (const { calId, targetId, tagName, tags } of targets.values()) {
    const newTags = [...new Set([...tags, tagName])]
    try {
      await ensureTags(token, calId, [tagName])
      await patchTaskProps(token, calId, targetId, { tags: encodeTags(newTags), listId: null })
    } catch (err) { console.warn('list->tag migration failed:', err.message); failures++ }
  }
  // Reflect in the in-memory items so the current render shows tags, not lists.
  for (const item of state.boardItems) {
    const tagName = item.metadata?.listId ? getList(item.metadata.listId)?.name : null
    if (tagName) {
      item.metadata.tags   = [...new Set([...(item.metadata.tags ?? []), tagName])]
      item.metadata.listId = null
    }
  }
  if (failures === 0) { setListsMigrated(true); if (targets.size) console.log(`Migrated ${targets.size} lists to tags.`) }
}

// Load the per-calendar config events (statuses + tag palette), migrating any
// legacy Firestore statuses into a calendar's config event the first time it's
// created. Needs prefs loaded first (for the task-calendar list).
async function loadStatusConfig(token) {
  await loadFsStatuses(token).catch(() => {})   // migration source only
  await loadConfig(token, getTaskCalendars(), calId => {
    const fs = fsStatusesForCalendar(calId)
    if (!fs.length) return null
    const obj = {}
    fs.forEach(s => { obj[s.id] = { name: s.name, order: s.order, inProgress: s.inProgress } })
    return obj
  })
}
import { setCompleted, setUncompleted } from './providers/completionStore.js'
import { appendLogEntry, relinkLogEntries } from './providers/lifeLog.js'
import { renderBoard, destroyBoard, isBoardDragging, initSnooze, openSnoozePopover } from './board.js'
import { runSweep, getGtLists } from './providers/taskSweep.js'
import { initEditor, openEditor, openEditorForEdit } from './unifiedEditor.js'
import { initTimedDrag, destroyTimedDrag, isDragging } from './calendarDrag.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const VERSION   = '0.37.4'

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
  pastDueTasks: [],        // incomplete tasks in the window's past bound — rolled forward to today on the calendar
  visibility: null,        // effective { start, end } window (Dates); session state, expands on calendar browse
  filter: { text: '', tags: [] },   // active-view filter: title substring + tag AND-set (session only)
}

// Does an item pass the active filter? Title substring (case-insensitive) AND
// must carry every filter tag. Empty filter passes everything.
function matchesFilter(item) {
  const f = state.filter
  if (f.text && !(item.title ?? '').toLowerCase().includes(f.text.toLowerCase())) return false
  if (f.tags.length) {
    const tags = item.metadata?.tags ?? []
    if (!f.tags.every(t => tags.includes(t))) return false
  }
  return true
}

function renderFilterBar() {
  const chips = document.getElementById('filter-tags')
  if (!chips) return
  chips.innerHTML = ''
  for (const name of state.filter.tags) {
    const chip = el('span', 'filter-tag')
    chip.textContent = name
    const x = el('button', 'filter-tag-remove'); x.textContent = '×'
    x.addEventListener('click', () => { state.filter.tags = state.filter.tags.filter(t => t !== name); renderFilterBar(); applyFilter() })
    chip.appendChild(x)
    chips.appendChild(chip)
  }
  document.getElementById('filter-datalist').innerHTML =
    getAllTagNames().filter(n => !state.filter.tags.includes(n)).map(n => `<option value="${n}"></option>`).join('')
  const active = !!state.filter.text || state.filter.tags.length > 0
  document.getElementById('filter-clear').hidden = !active
}

// Re-apply the filter to the active view (no refetch — client-side).
function applyFilter() {
  if (state.view === 'calendar') renderItems(getVisibleItems())
  else rerenderWorkView()
}

// ── Visibility period ─────────────────────────────────────────────────────────
// A date window (default [today-14d, today+14d]) that bounds the board and the
// calendar roll-forward. A custom window is persisted in prefs; calendar browsing
// widens the effective window for the session only.
const VIS_DEFAULT_DAYS = 14

function _visDefaultWindow() {
  const t = new Date(); t.setHours(0, 0, 0, 0)
  return { start: addDays(t, -VIS_DEFAULT_DAYS), end: addDays(t, VIS_DEFAULT_DAYS) }
}

// Initialize the effective window from a saved custom window, else the default.
function initVisibility() {
  const cs = getVisibilityStart(), ce = getVisibilityEnd()
  const def = _visDefaultWindow()
  state.visibility = {
    start: cs ? new Date(cs + 'T00:00:00') : def.start,
    end:   ce ? new Date(ce + 'T00:00:00') : def.end,
  }
}

// Effective window. Falls back to a fresh default (uncached) until prefs have
// loaded and initVisibility() has run — so a saved custom window isn't masked by
// an early pre-prefs read.
let _visReady = false
function visibilityWindow() {
  return state.visibility ?? _visDefaultWindow()
}

// Initialize the session window from prefs exactly once, after prefs are loaded.
function ensureVisibilityReady() {
  if (_visReady) return
  initVisibility()
  _visReady = true
}

// Widen the effective window to cover [from, to). Session-only. Returns true if
// the window actually grew (so callers can refresh dependent views).
//
// The span is capped at getMaxWindowDays() (default 180). When browsing pushes
// the window past the cap, we infer the shift direction from which end moved and
// truncate the *other* (trailing) end — so the window slides with you rather than
// growing without bound.
function expandVisibility(from, to) {
  if (!state.visibility) initVisibility()
  const w = state.visibility
  const prevStart = w.start.getTime(), prevEnd = w.end.getTime()
  let changed = false
  if (from < w.start) { w.start = new Date(from); changed = true }
  if (to   > w.end)   { w.end   = new Date(to);   changed = true }
  if (!changed) return false

  const DAY_MS = 86400000
  const maxMs  = getMaxWindowDays() * DAY_MS
  if (w.end.getTime() - w.start.getTime() > maxMs) {
    const movedEnd   = w.end.getTime()   > prevEnd
    const movedStart = w.start.getTime() < prevStart
    // Shifting forward (end grew) → drop the old past bound; shifting back
    // (start grew) → drop the future bound. If both moved (e.g. a jump), keep
    // the forward end as the anchor.
    if (movedStart && !movedEnd) w.end   = new Date(w.start.getTime() + maxMs)
    else                         w.start = new Date(w.end.getTime()   - maxMs)
  }
  return true
}

// Keep the effective window a rolling buffer around the viewed week: always
// extend it to cover VIS_DEFAULT_DAYS beyond both ends of the current week, so
// stepping one week toward an edge pushes the bound out another 7 days (and the
// dependent views / past-due fetch pull in that range) instead of only widening
// once we actually hit the edge. Session-only; never contracts. Returns true if
// the window grew.
function syncVisibilityToWeek(weekStart) {
  return expandVisibility(
    addDays(weekStart, -VIS_DEFAULT_DAYS),
    addDays(weekStart, 7 + VIS_DEFAULT_DAYS),
  )
}

function _fmtVisDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function _dateInputValue(d) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function renderVisibilityPill() {
  const w  = visibilityWindow()
  const el = document.getElementById('btn-visibility')
  if (el) el.textContent = `${_fmtVisDate(w.start)} – ${_fmtVisDate(w.end)}`
}

// Re-render whichever surface is active (used after the window changes).
function refreshActiveView() {
  if (WORK_VIEWS.includes(state.view)) loadBoardData()
  else render()
}

function openVisibilityDialog() {
  const dialog = document.getElementById('visibility-dialog')
  const startI = document.getElementById('visibility-start-input')
  const endI   = document.getElementById('visibility-end-input')
  const w = visibilityWindow()
  startI.value = _dateInputValue(w.start)
  endI.value   = _dateInputValue(w.end)
  dialog.hidden = false

  const close = () => { dialog.hidden = true }
  document.getElementById('visibility-cancel-btn').onclick   = close
  document.getElementById('visibility-dialog-close').onclick = close
  document.getElementById('visibility-default-btn').onclick  = () => {
    setVisibilityWindow(null, null)
    initVisibility()
    renderVisibilityPill()
    close()
    refreshActiveView()
  }
  document.getElementById('visibility-save-btn').onclick = () => {
    let s = startI.value || null, e = endI.value || null
    if (s && e && s > e) [s, e] = [e, s]   // tolerate reversed range
    setVisibilityWindow(s, e)
    initVisibility()
    renderVisibilityPill()
    close()
    refreshActiveView()
  }
}

function todayMidnight() {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate())
}

// A dated, incomplete task whose start is within the visibility window's past
// bound and before today — eligible to be rolled forward. Undated tasks and tasks
// older than the window's start are excluded.
function isRollablePastDue(item) {
  // Only real Kairos tasks roll — matches exactly what refreshPastDueTasks fetches
  // (isTask events), so native task-calendar events are never suppressed-then-lost.
  if (item.item_type !== 'TASK' || item.status === 'COMPLETED') return false
  if (!item.start || item.metadata?.noDate) return false
  const s = new Date(item.start)
  return s < todayMidnight() && s >= visibilityWindow().start
}

// Render-time clone placed on today as an all-day chip (marked so it keeps the
// red past-due ring even though its displayed date is now today).
function rollToToday(item) {
  const t = todayMidnight()
  return {
    ...item,
    start:    t,
    end:      null,
    due:      t,
    all_day:  true,
    metadata: { ...item.metadata, rolledPastDue: true },
  }
}

// Fetch incomplete, dated tasks within the visibility window's past bound across
// task calendars, de-duplicating recurring series to the most-recent overdue one.
async function refreshPastDueTasks() {
  const token = await getToken()
  if (!token) { state.pastDueTasks = []; return }
  const t     = todayMidnight()
  const since = visibilityWindow().start
  const calIds = getTaskCalendars()
  const per = await Promise.all(
    calIds.map(cal => getTaskEvents(token, cal, since, t).catch(() => []))
  )
  const all = per.flat().filter(x =>
    x.status !== 'COMPLETED' && x.start && !x.metadata?.noDate && new Date(x.start) < t
  )
  const bySeries = new Map()
  const singles  = []
  for (const x of all) {
    const sid = x.metadata?.recurringEventId
    if (!sid) { singles.push(x); continue }
    const prev = bySeries.get(sid)
    if (!prev || new Date(x.start) > new Date(prev.start)) bySeries.set(sid, x)
  }
  state.pastDueTasks = [...singles, ...bySeries.values()]
}

// Status IDs flagged "in progress" — refreshed at the top of each render pass so
// task chips in those statuses get the green ring (past-due red still wins).
let _inProgressIds = new Set()
function isInProgressItem(item, isTask, isDone) {
  const sid = item.metadata?.statusId
  return isTask && !isDone && !!sid && _inProgressIds.has(sid)
}

// Rank a calendar by its position in the user's calendar list — used to order
// all-day items by calendar (then title).
function calRank(id) {
  const i = state.calendars.findIndex(c => c.id === id)
  return i === -1 ? Number.MAX_SAFE_INTEGER : i
}
function byCalendarThenTitle(a, b) {
  return (calRank(a.source.account_id) - calRank(b.source.account_id))
    || (a.title ?? '').localeCompare(b.title ?? '')
}

// Small coloured dots for an item's tags, appended to calendar chips (so tagged
// items — including events — read as tagged). Returns null when there are none.
function _tagDots(item) {
  const tags = item.metadata?.tags ?? []
  if (!tags.length) return null
  const wrap = document.createElement('span')
  wrap.className = 'cal-tag-dots'
  wrap.title = tags.join(', ')
  for (const t of tags.slice(0, 3)) {
    const dot = document.createElement('span')
    dot.className = 'cal-tag-dot'
    dot.style.background = getTagColor(item.source.account_id, t)
    wrap.appendChild(dot)
  }
  return wrap
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
    ensureCalendarWatches(token, state.calendars).catch(err =>
      console.warn('Watch registration failed:', err)
    )
  } catch (err) {
    console.error('Failed to load calendar list:', err)
  }
}

// ── Calendar push-notification watches ───────────────────────────────────────

const _WATCH_URL     = 'https://kairos.inlandsoftware.com/api/calendar-webhook'
const _WATCH_RENEW_T = 24 * 60 * 60 * 1000   // re-register if expiring within 24 h

async function ensureCalendarWatches(token, calendars) {
  // Google requires a public HTTPS callback — skip in local dev
  if (window.location.hostname === 'localhost') return

  // Check current watch expiry
  const pollRes = await fetch('/api/calendar-poll', { credentials: 'include' }).catch(() => null)
  if (!pollRes?.ok) return
  const { watchExpiry } = await pollRes.json()
  if (watchExpiry && watchExpiry > Date.now() + _WATCH_RENEW_T) return  // still fresh

  // Get the webhook token used to authenticate Google's callbacks
  const wtRes = await fetch('/api/webhook-token', { credentials: 'include' }).catch(() => null)
  if (!wtRes?.ok) return
  const { token: webhookToken } = await wtRes.json()
  if (!webhookToken) return

  // Register a watch per calendar (skipping freeBusy-only calendars)
  const channels = []
  await Promise.allSettled(
    calendars
      .filter(c => c.accessRole !== 'freeBusyReader')
      .map(async cal => {
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events/watch`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id:      crypto.randomUUID(),
              type:    'web_hook',
              address: _WATCH_URL,
              token:   webhookToken,
              params:  { ttl: '604800' },   // request 7 days; Google may grant less
            }),
          }
        )
        if (!res.ok) { console.warn(`Watch failed for ${cal.id}:`, res.status); return }
        const data = await res.json()
        channels.push({
          channelId:  data.id,
          resourceId: data.resourceId,
          calendarId: cal.id,
          expiration: Number(data.expiration),
        })
      })
  )

  if (!channels.length) return
  await fetch('/api/save-watch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channels }),
    credentials: 'include',
  }).catch(() => {})
}

async function fetchItems(start, end) {
  const token = await getToken()
  if (!token) return null
  try {
    const items = await getEvents(token, start, end)
    _weekCache.set(start.getTime(), { items, ts: Date.now() })
    return items
  } catch (err) {
    console.error('Calendar events fetch failed:', err)
    clearSyncTokens()   // stale token may have caused a rate-limit cascade; start fresh
    return null
  }
}

async function handleToggleTask(item) {
  const token = await getToken()
  if (!token) return
  const isDone = item.status === 'COMPLETED'
  const verb   = isDone ? 'uncompleted' : 'completed'
  try {
    if (isDone) await calUncompleteTask(token, item.source.account_id, item.source.external_id, item.title, item)
    else        await calCompleteTask(token, item.source.account_id, item.source.external_id, item.title, item)
    const target = state.items.find(i => i.id === item.id)
    if (target) target.status = isDone ? 'NEEDS_ACTION' : 'COMPLETED'
    // Drop a just-completed rolled-forward task from today's pile immediately;
    // a full refresh reconciles the rest.
    if (!isDone) state.pastDueTasks = state.pastDueTasks.filter(t => t.id !== item.id)
    renderItems(getVisibleItems())
    appendLogEntry(token, {
      item_id:       item.id,
      kairosId:      item.metadata?.kairosId ?? undefined,
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
// Ref-counted: bar shows whenever any foreground fetch is in-flight.
// Background preload fetches bypass it via _bgFetchCount.

function showLoading() { document.getElementById('loading-bar').classList.add('active') }
function hideLoading() { document.getElementById('loading-bar').classList.remove('active') }

let _pending      = 0
let _bgFetchCount = 0
const _origFetch  = window.fetch.bind(window)
window.fetch = async (...args) => {
  if (_bgFetchCount > 0) return _origFetch(...args)
  if (++_pending === 1) showLoading()
  try {
    return await _origFetch(...args)
  } finally {
    if (--_pending <= 0) { _pending = 0; hideLoading() }
  }
}

// ── Week cache ────────────────────────────────────────────────────────────────
// Keyed by weekStart.getTime(). Preloaded adjacent weeks render instantly on
// navigation. Populated by fetchItems() and preload; TTL = 5 minutes.

const _weekCache  = new Map() // ts → { items, ts }
const _CACHE_TTL  = 5 * 60 * 1000

async function _preloadWeek(token, weekStart) {
  const key = weekStart.getTime()
  const hit = _weekCache.get(key)
  if (hit && Date.now() - hit.ts < _CACHE_TTL) return
  _bgFetchCount++
  try {
    const items = await getEvents(token, weekStart, addDays(weekStart, 7))
    _weekCache.set(key, { items, ts: Date.now() })
  } catch {
    // preload failures are silent — next navigation will fetch normally
  } finally {
    _bgFetchCount--
  }
}

function preloadAdjacentWeeks() {
  getToken().then(async t => {
    if (!t) return
    await _preloadWeek(t, addDays(state.weekStart,  7))
    await _preloadWeek(t, addDays(state.weekStart, 14))
    await _preloadWeek(t, addDays(state.weekStart, -7))
  })
}

// ── Calendar-view modal callbacks ─────────────────────────────────────────────

// ── Toast ─────────────────────────────────────────────────────────────────────

let _toastTimer = null
function showToast(msg) {
  let el = document.getElementById('kairos-toast')
  if (!el) {
    el = document.createElement('div')
    el.id = 'kairos-toast'
    document.body.appendChild(el)
  }
  el.textContent = msg
  el.classList.add('visible')
  if (_toastTimer) clearTimeout(_toastTimer)
  _toastTimer = setTimeout(() => { el.classList.remove('visible'); _toastTimer = null }, 4000)
}

// ── Calendar-view item refresh ────────────────────────────────────────────────

// Used by polling and visibilitychange. Tries a sync-token delta first; falls
// back to a full fetch. Skips entirely if a drag is active (post-drag onRefresh
// fires immediately after, ensuring consistency).
async function _refreshItems() {
  if (isDragging()) return

  const end = addDays(state.weekStart, 7)

  // Try incremental delta (fetchDelta returns null until tokens are populated
  // after the first full fetch, or when coverage is incomplete — caller falls through)
  const token = await getToken()
  if (token && state.calendars.length) {
    const delta = await fetchDelta(token, state.calendars, state.items).catch(err => {
      console.warn('Delta fetch failed, falling back to full refresh:', err)
      return null
    })
    if (delta !== null) {
      state.items = delta
      renderItems(getVisibleItems())
      _lastRefreshedAt = Date.now()
      return
    }
  }

  // Full fetch fallback
  const items = await fetchItems(state.weekStart, end)
  if (items !== null) {
    state.items = items
    renderItems(getVisibleItems())
    _lastRefreshedAt = Date.now()
  } else {
    showToast('Could not refresh calendar — showing last known data')
  }
}

async function refreshCalendarItems() {
  const end  = addDays(state.weekStart, 7)
  const [items] = await Promise.all([fetchItems(state.weekStart, end), refreshPastDueTasks()])
  if (items !== null) {
    state.items = items
    renderItems(getVisibleItems())
    _lastRefreshedAt = Date.now()
  }
}

function calendarModalCallbacks() {
  return {
    onSaved:    refreshCalendarItems,
    onDeleted:  refreshCalendarItems,
    onCompleted(updated) {
      const idx = state.items.findIndex(i => i.id === updated.id)
      if (idx >= 0) state.items[idx] = updated
      renderItems(getVisibleItems())
    },
  }
}

// ── View switching ────────────────────────────────────────────────────────────

const WORK_VIEWS = ['board']

// Deep-link routing: each view has a URL path (the task Board lives at /board;
// /tasks is accepted as a synonym). The SPA fallback (_redirects) serves
// index.html for these so they're bookmarkable and reload-safe.
const VIEW_PATH = { calendar: '/calendar', board: '/board' }
const PATH_VIEW = { '/calendar': 'calendar', '/board': 'board', '/tasks': 'board' }

// The view implied by the current URL path, or null if the path isn't a view.
function _viewFromPath() {
  return PATH_VIEW[(window.location.pathname.replace(/\/+$/, '') || '/')] ?? null
}

// Reflect the active view in the address bar (preserving query/hash).
function _syncUrlToView(v, replace = false) {
  const path = VIEW_PATH[v] ?? '/calendar'
  if (window.location.pathname === path) return
  const url = path + window.location.search + window.location.hash
  if (replace) history.replaceState({ view: v }, '', url)
  else         history.pushState({ view: v }, '', url)
}

function setView(v, { updateUrl = true, replace = false } = {}) {
  state.view = v
  const isWork = WORK_VIEWS.includes(v)
  document.getElementById('calendar').hidden      = v !== 'calendar'
  document.getElementById('mobile-cal').hidden    = v !== 'calendar'
  document.getElementById('board').hidden         = v !== 'board'
  if (v !== 'board') destroyBoard()
  _syncViewSwitchActive()
  _syncProjectSelectorVisibility()
  if (updateUrl) _syncUrlToView(v, replace)

  renderVisibilityPill()
  renderFilterBar()
  stopPolling()
  if (isWork) {
    loadBoardData()
    startPolling()
  } else {
    render()
    startPolling()
  }
}

// Resolve a target view against availability: work views require a task calendar,
// otherwise fall back to the calendar.
function _availableView(v) {
  return (WORK_VIEWS.includes(v) && getTaskCalendars().length === 0) ? 'calendar' : v
}

// Back/forward between deep-linked views.
window.addEventListener('popstate', () => {
  const target = _availableView(_viewFromPath() ?? 'calendar')
  if (target !== state.view) setView(target, { updateUrl: false })
})

// Inline SVG icons for the view switcher (stroke = currentColor via CSS).
const VIEW_DEFS = [
  ['calendar',  'Calendar',  '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'],
  ['board',     'Board',     '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18"/>'],
]

// The Board view only makes sense with a task calendar. Rebuild the segmented
// switcher accordingly and fall back to the calendar if a work view
// is active when the last task calendar is removed.
function populateViewSelect() {
  const wrap = document.getElementById('view-switch')
  if (!wrap) return
  // The active-project <select> lives inside the switcher (after the Board icon);
  // rebuild only the buttons and keep the select in place as the last segment.
  const sel = document.getElementById('board-calendar-select')
  wrap.querySelectorAll('button').forEach(b => b.remove())
  const hasTaskCals = getTaskCalendars().length > 0
  const views = hasTaskCals ? VIEW_DEFS : VIEW_DEFS.filter(([v]) => !WORK_VIEWS.includes(v))
  for (const [v, label, svg] of views) {
    const btn = document.createElement('button')
    btn.type          = 'button'
    btn.dataset.view  = v
    btn.title         = label
    btn.setAttribute('role', 'tab')
    btn.setAttribute('aria-label', label)
    btn.innerHTML     = `<svg viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>`
    btn.addEventListener('click', () => setView(v))
    wrap.insertBefore(btn, sel)   // buttons before the trailing select
  }
  _syncViewSwitchActive()
}

// Reflect the active view on the switcher buttons (aria + highlight).
function _syncViewSwitchActive() {
  const wrap = document.getElementById('view-switch')
  if (!wrap) return
  for (const btn of wrap.querySelectorAll('button')) {
    const on = btn.dataset.view === state.view
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-selected', on ? 'true' : 'false')
  }
}

function updateWorkViewButtons() {
  populateViewSelect()
  if (getTaskCalendars().length === 0 && WORK_VIEWS.includes(state.view)) setView('calendar')
}

// ── Polling ───────────────────────────────────────────────────────────────────

let _pollHandle   = null
let _lastRefreshedAt = 0      // set after every successful refresh; compared to changedAt from KV
let _lastSpawnAt  = 0
const _SPAWN_MIN  = 2 * 60 * 1000   // spawn scan runs at most once per 2 min

function startPolling() {
  stopPolling()
  _pollHandle = setInterval(async () => {
    if (document.hidden) return

    // Spawn scan — keep at the prior 2-minute effective cadence
    if (Date.now() - _lastSpawnAt >= _SPAWN_MIN) {
      await runSpawnScan()
      _lastSpawnAt = Date.now()
    }

    // KV change poll — check if Google notified us of a change since last refresh
    try {
      const res = await fetch('/api/calendar-poll', { credentials: 'include' })
      if (!res.ok) return
      const { changedAt } = await res.json()
      if (changedAt && changedAt > _lastRefreshedAt) {
        if (WORK_VIEWS.includes(state.view)) { if (!isBoardDragging()) await loadBoardData() }
        else await _refreshItems()
        // _lastRefreshedAt is updated inside _refreshItems / loadBoardData doesn't
        // need it tracked (board has its own freshness logic)
      }
    } catch (err) {
      console.warn('Calendar poll failed:', err)
    }
  }, 20_000)
}

function stopPolling() {
  if (_pollHandle !== null) { clearInterval(_pollHandle); _pollHandle = null }
}

// Resume immediately when the user returns to the tab; force-refresh the token
// so returning after any idle period doesn't carry a stale access token.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  invalidateCache()
  clearSyncTokens()   // force full re-fetch on tab return — token covers changes while hidden
  runSpawnScan()
    .then(() => {
      runSweepIfConfigured()
      if (WORK_VIEWS.includes(state.view)) { if (!isBoardDragging()) loadBoardData() }
      else _refreshItems()
    })
})

// ── Board data + callbacks ────────────────────────────────────────────────────

// The board + list views are scoped to one "project" calendar. Prefer the saved
// choice when it's still a task calendar, else the intake status's calendar, else
// the first task calendar.
function currentProjectCalendarId() {
  const taskCals = getTaskCalendars()
  if (!taskCals.length) return null
  const saved = getProjectCalendarId()
  if (saved && taskCals.includes(saved)) return saved
  const intakeStatus = getIntakeStatusId() ? getStatus(getIntakeStatusId()) : null
  if (intakeStatus && taskCals.includes(intakeStatus.calendarId)) return intakeStatus.calendarId
  return taskCals[0]
}

function boardCallbacks() {
  return {
    onCreate:     (calendarId, statusId) => openEditor(
      { mode: 'task', calendarId: calendarId ?? currentProjectCalendarId(), statusId },
      { onSaved: loadBoardData },
    ),
    onEdit:       item    => openEditorForEdit(item, {
      onSaved:   loadBoardData,
      onDeleted: loadBoardData,
    }),
    onRefresh:          loadBoardData,
    onDoneWindowChange: days => { state.doneWindow = days; loadBoardData() },
    onCreateStatus: async name => {
      const token = await getToken()
      if (!token) return
      const calId = currentProjectCalendarId()
      if (!calId) return
      try {
        const calStatuses = getStatusesForCalendar(calId)
        const maxOrder    = calStatuses.length ? Math.max(...calStatuses.map(s => s.order ?? 0)) : 0
        await createStatus(token, calId, name, maxOrder + 10)
        await loadBoardData()
      } catch (err) {
        console.error('Create status failed:', err)
      }
    },
  }
}

function rerenderBoard() {
  const calId = currentProjectCalendarId()
  renderBoard(getStatusesForCalendar(calId), getBoardItems(), boardCallbacks(), state.doneWindow, calId)
}

// Re-render the active work surface (the board).
function rerenderWorkView() {
  rerenderBoard()
}

// Fill the board/list project-calendar <select> from the designated task calendars.
function populateProjectSelector() {
  const sel = document.getElementById('board-calendar-select')
  if (!sel) return
  const taskCals = getTaskCalendars()
  const current  = currentProjectCalendarId()
  sel.innerHTML = ''
  for (const calId of taskCals) {
    const opt = document.createElement('option')
    opt.value       = calId
    opt.textContent = state.calendars.find(c => c.id === calId)?.summary ?? calId
    if (calId === current) opt.selected = true
    sel.appendChild(opt)
  }
  _syncProjectSelectorVisibility()
}

// The project selector lives in the header now; show it only on the board/list
// views (it scopes those) and only when a task calendar exists.
function _syncProjectSelectorVisibility() {
  const sel = document.getElementById('board-calendar-select')
  if (!sel) return
  sel.hidden = !(state.view === 'board' && getTaskCalendars().length > 0)
}

function getBoardItems() {
  // Bound to the visibility window by task date; undated tasks always show.
  const w       = visibilityWindow()
  const endExcl = addDays(w.end, 1)   // include the whole end day
  const items = state.boardItems.filter(i =>
    matchesFilter(i) &&
    (!i.start || i.metadata?.noDate || (i.start >= w.start && i.start < endExcl))
  )

  // Recurring tasks are shown as one card per series: the next upcoming non-completed
  // instance. Falls back to the most recent past non-completed instance if none upcoming.
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const bestBySeries = new Map()

  for (const item of items) {
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
    ...items.filter(i => !i.metadata?.recurringEventId),
    ...[...bestBySeries.values()],
  ]
}

async function loadBoardData() {
  const token = await getToken()
  if (!token) return
  try {
    // Prefs/lists first so the visibility window and task-calendar list are known
    // (the config load and windowed fetch both need them).
    await Promise.all([loadPrefs(token), loadLists(token)])
    await loadStatusConfig(token)
    ensureVisibilityReady()
    renderVisibilityPill()
    renderFilterBar()
    const taskCalIds = getTaskCalendars()
    // Backfill statuses for task calendars designated before statuses existed
    // (ensureDefaultStatuses is a no-op where a calendar already has any).
    await Promise.all(taskCalIds.map(calId => ensureDefaultStatuses(token, calId).catch(console.warn)))
    const w = visibilityWindow()
    // Extend the fetch end by a day so tasks on the last visible day are included
    // (the display filter already treats the end day inclusively).
    const win = { start: w.start, end: addDays(w.end, 1) }
    const results = await Promise.all(
      taskCalIds.map(calId =>
        getAllTaskEvents(token, calId, win).catch(err => {
          console.warn(`Tasks fetch failed for ${calId}:`, err.message)
          return []
        })
      )
    )
    state.boardItems = results.flat()
    await migrateListsToTags(token).catch(console.warn)   // one-time listId -> tag
    populateProjectSelector()
    rerenderWorkView()
    ensureFooters(token, state.boardItems).catch(console.warn)
    // Board changes (completion, snooze, move) must be visible immediately when the
    // user switches back to the calendar view — drop the cached week so render() re-fetches.
    _weekCache.clear()
  } catch (err) {
    console.error('Board data load failed:', err)
  }
}

// Filter already-fetched items by calendar visibility — no network call needed.
// Also rolls past-due tasks (within the visibility window's past bound) forward:
// they're suppressed at their real past date and re-emitted as all-day chips on
// today (see rollToToday).
function getVisibleItems() {
  const visible = item => item.item_type !== 'EVENT' || !state.hiddenCalendars.has(item.source.account_id)
  const items   = state.items.filter(visible).filter(i => !isRollablePastDue(i))
  const rolled  = state.pastDueTasks.filter(visible).map(rollToToday)
  return items.concat(rolled).filter(matchesFilter)
}

// ── Calendar picker (lives in the Configure Kairos dialog) ─────────────────────

function renderCalendarPicker() {
  const panel = document.getElementById('cal-picker-panel')
  if (!panel) return

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
      } else {
        state.taskCalendars.add(cal.id)
        taskBtn.classList.add('active')
        const token = await getToken()
        if (token) await ensureDefaultStatuses(token, cal.id)   // seeds the config event
      }
      setTaskCalendars([...state.taskCalendars])
      updateWorkViewButtons()
      refreshCalendarItems()
    })

    row.append(lbl, taskBtn)
    panel.appendChild(row)
  }
}


// Toggle all-day between top-3 cap and show-all
document.getElementById('btn-allday-toggle').addEventListener('click', () => {
  state.allDayExpanded = !state.allDayExpanded
  renderAllDayToggle()
  renderItems(getVisibleItems())
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

  // Kairos configuration (intake list + Google Task Sweep)
  const sweepSec = el('div', 'acct-section acct-section-border')
  sweepSec.innerHTML = `<button class="acct-sweep-link" id="btn-open-sweep">Configure Kairos →</button>`
  panel.appendChild(sweepSec)

  panel.querySelector('#btn-panel-signout')?.addEventListener('click', logout)
  panel.querySelector('#btn-add-secondary')?.addEventListener('click', addAccount)
  panel.querySelectorAll('.acct-remove').forEach(btn => {
    btn.addEventListener('click', () => logoutAccount(btn.dataset.id))
  })
  panel.querySelector('#btn-open-sweep')?.addEventListener('click', e => {
    e.stopPropagation()
    document.getElementById('account-panel').hidden = true
    openConfigDialog()
  })
}

function el(tag, className) {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

// ── Google Task Sweep ─────────────────────────────────────────────────────────

const SWEEP_INTERVAL = 15 * 60 * 1000  // 15 minutes

async function _fetchWebhookToken() {
  try {
    const res = await fetch('/api/webhook-token', { credentials: 'include' })
    if (res.ok) return (await res.json()).token ?? null
  } catch {}
  return null
}

// Run a sweep pass if sources and target are configured. Silent unless tasks are swept.
async function runSweepIfConfigured() {
  const sources  = getSweepSources()
  const targetId = getIntakeStatusId()
  if (!sources.length || !targetId) return

  const accounts = await getTokens()
  const calToken = accounts.find(a => a.primary)?.token
  if (!calToken) return

  const webhookToken = await _fetchWebhookToken()

  try {
    const result = await runSweep({ accounts, calToken, webhookToken, sweepSources: sources, targetStatusId: targetId })
    if (result.swept > 0) {
      console.log(`[sweep] swept ${result.swept} tasks into Kairos`)
      _weekCache.clear()
      await loadBoardData()
    }
  } catch (err) {
    console.warn('[sweep] failed:', err.message)
  }
}

// Open the Configure Kairos dialog (default intake list + Google Task Sweep).
// Tag manager (in Configure Kairos): recolor or delete tags, grouped by calendar.
function renderTagManager() {
  const wrap = document.getElementById('tag-manager')
  if (!wrap) return
  wrap.innerHTML = ''
  let any = false
  for (const calId of getTaskCalendars()) {
    const palette = getTagPalette(calId)
    const names   = Object.keys(palette).sort((a, b) => a.localeCompare(b))
    if (!names.length) continue
    any = true
    const calLbl = el('div', 'tag-mgr-cal')
    calLbl.textContent = state.calendars.find(c => c.id === calId)?.summary ?? calId
    wrap.appendChild(calLbl)
    for (const name of names) {
      const row   = el('div', 'tag-mgr-row')
      const color = el('input', 'tag-mgr-color'); color.type = 'color'; color.value = palette[name]
      color.addEventListener('change', async () => setTagColor(await getToken(), calId, name, color.value).catch(console.warn))
      const label = el('span', 'tag-mgr-name'); label.textContent = name
      const del   = el('button', 'tag-mgr-del'); del.textContent = '×'; del.title = 'Delete tag'
      del.addEventListener('click', async () => {
        if (!confirm(`Delete tag "${name}"? It will be removed from the palette and from loaded items on this calendar.`)) return
        const token = await getToken(); if (!token) return
        await removeTagFromPalette(token, calId, name).catch(console.warn)
        // Untag loaded items (board + calendar) on this calendar.
        for (const item of [...state.boardItems, ...state.items]) {
          if (item.source.account_id !== calId || !item.metadata?.tags?.includes(name)) continue
          const nt = item.metadata.tags.filter(t => t !== name)
          await patchTaskProps(token, calId, item.source.external_id, { tags: encodeTags(nt) }).catch(console.warn)
          item.metadata.tags = nt
        }
        renderTagManager()
      })
      row.append(color, label, del)
      wrap.appendChild(row)
    }
  }
  if (!any) { const e = el('div', 'sweep-section-hint'); e.textContent = 'No tags yet.'; wrap.appendChild(e) }
}

async function openConfigDialog() {
  const dialog   = document.getElementById('sweep-dialog')
  const container = document.getElementById('sweep-sources-container')
  const targetSel = document.getElementById('intake-status-select')
  const status    = document.getElementById('sweep-dialog-status')
  const saveBtn      = document.getElementById('sweep-save-btn')
  const cancelBtn    = document.getElementById('sweep-cancel-btn')
  const nowBtn       = document.getElementById('sweep-now-btn')

  dialog.hidden = false
  status.textContent = ''
  renderCalendarPicker()
  renderTagManager()

  // Populate default intake status dropdown — statuses across all task calendars,
  // each labelled with its calendar to disambiguate same-named statuses.
  targetSel.innerHTML = '<option value="">— select a status —</option>'
  const savedTarget = getIntakeStatusId()
  const taskCalIds  = getTaskCalendars()
  const calName     = id => state.calendars.find(c => c.id === id)?.summary ?? id
  for (const calId of taskCalIds) {
    for (const st of getStatusesForCalendar(calId)) {
      const opt = document.createElement('option')
      opt.value       = st.id
      opt.textContent = `${st.name} — ${calName(calId)}`
      opt.selected    = st.id === savedTarget
      targetSel.appendChild(opt)
    }
  }

  // Load GT lists per account and build source checkboxes
  container.innerHTML = ''
  const savedSources = getSweepSources()
  const accounts = await getTokens()

  for (const account of accounts) {
    const group = el('div', 'sweep-account-group')
    const nameEl = el('div', 'sweep-account-name')
    nameEl.textContent = `${account.email ?? account.id}${account.primary ? ' (primary)' : ''}`
    group.appendChild(nameEl)

    const loadingEl = el('div', 'sweep-loading')
    loadingEl.textContent = 'Loading lists…'
    group.appendChild(loadingEl)
    container.appendChild(group)

    // Fetch this account's GT lists asynchronously
    getGtLists(account.token).then(lists => {
      loadingEl.remove()
      if (!lists.length) {
        const empty = el('div', 'sweep-loading')
        empty.textContent = 'No task lists found'
        group.appendChild(empty)
        return
      }
      for (const list of lists) {
        const isChecked = savedSources.some(s => s.accountId === account.id && s.listId === list.id)
        const row = el('label', 'sweep-list-row')
        const cb  = document.createElement('input')
        cb.type    = 'checkbox'
        cb.dataset.accountId   = account.id
        cb.dataset.listId      = list.id
        cb.dataset.listName    = list.title ?? list.id
        cb.checked = isChecked
        row.appendChild(cb)
        row.appendChild(document.createTextNode(list.title ?? list.id))
        group.appendChild(row)
      }
    }).catch(err => {
      console.warn(`[sweep] GT list load failed for ${account.email ?? account.id}:`, err)
      loadingEl.textContent = `Couldn't load lists — ${err.message || err}`
      // Missing scope on an account connected before Tasks access was granted:
      // offer a one-click reconnect that re-runs consent for this account.
      if (/\b40[13]\b/.test(err.message || '') || /scope/i.test(err.message || '')) {
        const btn = document.createElement('button')
        btn.className   = 'sweep-reconnect-btn'
        btn.textContent = 'Reconnect account'
        btn.onclick     = () => addAccount()
        group.appendChild(btn)
      }
    })
  }

  // Cancel
  cancelBtn.onclick = () => { dialog.hidden = true }

  // Save + dismiss
  saveBtn.onclick = async () => {
    const sources = []
    container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      sources.push({ accountId: cb.dataset.accountId, listId: cb.dataset.listId, listName: cb.dataset.listName })
    })
    setSweepSources(sources)
    setIntakeStatusId(targetSel.value || null)
    dialog.hidden = true
  }

  // Sweep now
  nowBtn.onclick = async () => {
    // Save current UI state first so runSweep reads fresh config
    const sources = []
    container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
      sources.push({ accountId: cb.dataset.accountId, listId: cb.dataset.listId, listName: cb.dataset.listName })
    })
    setSweepSources(sources)
    setIntakeStatusId(targetSel.value || null)

    const targetId = targetSel.value
    if (!sources.length) { status.textContent = 'No sources selected.'; return }
    if (!targetId)        { status.textContent = 'No intake status selected.'; return }

    nowBtn.disabled = true
    status.textContent = 'Sweeping…'

    const accounts    = await getTokens()
    const calToken    = accounts.find(a => a.primary)?.token
    const webhookToken = await _fetchWebhookToken()

    try {
      const result = await runSweep({
        accounts, calToken, webhookToken,
        sweepSources: sources, targetStatusId: targetId,
        onProgress: ({ swept, total }) => {
          status.textContent = `Sweeping… ${swept}/${total}`
        },
      })
      const parts = [`${result.swept} swept`]
      if (result.failed)  parts.push(`${result.failed} failed`)
      if (result.skipped) parts.push(`${result.skipped} skipped`)
      status.textContent = `Done — ${parts.join(', ')}`
      if (result.swept > 0) { _weekCache.clear(); loadBoardData() }
    } catch (err) {
      status.textContent = `Error: ${err.message}`
    } finally {
      nowBtn.disabled = false
    }
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
      if (WORK_VIEWS.includes(state.view)) { if (!isBoardDragging()) loadBoardData() }
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

  _inProgressIds = getInProgressStatusIds()
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
        // A timed event that crosses midnight is split into one segment per day,
        // each clamped to that day's [00:00, 24:00], so it wraps into the next
        // column instead of overflowing the bottom of the start day.
        let segStart = start
        while (segStart < end) {
          const nextMidnight = new Date(segStart.getFullYear(), segStart.getMonth(), segStart.getDate() + 1)
          const segEnd       = end < nextMidnight ? end : nextMidnight
          const segDayIdx    = localDayIndex(segStart, state.weekStart)
          if (segDayIdx >= 0 && segDayIdx < 7) {
            timedByDay[segDayIdx].push({ item, start: segStart, end: segEnd })
          }
          segStart = nextMidnight
        }
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

    // Row-pack by start day first — the greedy row assignment below needs this to
    // stay compact (out-of-order start days leave empty gaps). Items that start on
    // the same day are then ordered by calendar, then title.
    spans.sort((a, b) =>
      (a.startDay - b.startDay) || byCalendarThenTitle(a.item, b.item)
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
        isPastDue || item.metadata?.rolledPastDue ? 'past-due' : '',
        !isPastDue && !item.metadata?.rolledPastDue && isInProgressItem(item, isTask, isDone) ? 'in-progress' : '',
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
        chipEl.textContent = item.title
        if (isRecurringEv) {
          chipEl.style.paddingRight = '14px'
          const icon = document.createElement('span')
          icon.className   = 'allday-recur-icon'
          icon.textContent = '↻'
          chipEl.appendChild(icon)
        }
        chipEl.style.cursor = 'pointer'
        chipEl.addEventListener('click', () => {
          openEditorForEdit(item, calendarModalCallbacks())
        })
      }

      { const d = _tagDots(item); if (d) chipEl.appendChild(d) }
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
        _timedTask && _timedDone                   ? 'completed' : '',
        _timedPast && !_timedTask && !_timedDone ? 'is-past'  : '',
        _timedTask && _timedPast  && !_timedDone ? 'past-due' : '',
        !(_timedTask && _timedPast && !_timedDone) && isInProgressItem(item, _timedTask, _timedDone) ? 'in-progress' : '',
      ].filter(Boolean).join(' ')
      el.dataset.itemId = item.id
      if (_timedTask && !_timedDone && item.color) applyColor(el, item.color)
      else if (!_timedTask && item.color) applyColor(el, item.color)
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

      if (_timedTask) {
        const check = document.createElement('button')
        check.className = `task-check${_timedDone ? ' done' : ''}`
        check.setAttribute('aria-label', _timedDone ? 'Mark incomplete' : 'Mark complete')
        if (_timedDone) check.textContent = '✓'
        check.addEventListener('click', e => {
          e.stopPropagation()
          if (item.item_type === 'TASK') handleToggleTask(item)
          else                           handleToggleCommitment(item)
        })

        const textWrap = document.createElement('div')
        textWrap.className = 'timed-task-text'
        const titleEl = document.createElement('div')
        titleEl.className   = 'event-title'
        titleEl.textContent = item.title
        const timeEl = document.createElement('div')
        timeEl.className   = 'event-time'
        timeEl.textContent = formatTimeRange(start, end)
        textWrap.append(titleEl, timeEl)

        if (isRecurringEv) {
          el.classList.add('has-recur')
          const icon = document.createElement('span')
          icon.className   = 'timed-recur-icon'
          icon.textContent = '↻'
          el.appendChild(icon)
        }

        const snoozeBtn = !_timedDone ? (() => {
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

        el.append(check, textWrap, ...(snoozeBtn ? [snoozeBtn] : []))
        el.title = item.title
        el.addEventListener('click', () => {
          openEditorForEdit(item, calendarModalCallbacks())
        })
      } else {
        const titleEl = document.createElement('div')
        titleEl.className   = 'event-title'
        titleEl.textContent = item.title
        const timeEl  = document.createElement('div')
        timeEl.className   = 'event-time'
        timeEl.textContent = formatTimeRange(start, end)
        el.append(titleEl, timeEl)
        if (isRecurringEv) {
          el.classList.add('has-recur')
          const icon = document.createElement('span')
          icon.className   = 'timed-recur-icon'
          icon.textContent = '↻'
          el.appendChild(icon)
        }
        el.title = item.title
        el.addEventListener('click', () => {
          openEditorForEdit(item, calendarModalCallbacks())
        })
        if (item.editable) {
          const handle = document.createElement('div')
          handle.className = 'resize-handle'
          el.appendChild(handle)
        }
      }
      { const d = _tagDots(item); if (d) el.appendChild(d) }
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

  _inProgressIds = getInProgressStatusIds()
  const day      = state.mobileDay
  const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0)
  const dayEnd   = new Date(dayStart.getTime() + 86_400_000)
  const today    = new Date()
  const isToday  = sameDay(day, today)
  const _now            = today
  const _todayMidnight  = new Date(today.getFullYear(), today.getMonth(), today.getDate())

  // Day label
  const labelEl = document.getElementById('mobile-day-label')
  labelEl.textContent = day.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  labelEl.classList.toggle('is-today', isToday)

  const items = getVisibleItems()

  // ── All-day / multi-day timed events ──────────────────────────────────────
  const allDayContainer = document.getElementById('mobile-allday-items')
  allDayContainer.innerHTML = ''

  for (const item of [...items].sort(byCalendarThenTitle)) {
    const start = new Date(item.start)
    const end   = item.end ? new Date(item.end) : new Date(start.getTime() + 86_400_000)

    let covers = false
    if (item.all_day) {
      covers = start < dayEnd && end > dayStart  // Google end is exclusive
    } else if (end - start >= 86_400_000) {
      covers = start < dayEnd && end > dayStart
    }
    if (!covers) continue

    const isTask    = item.item_type === 'TASK' || (item.item_type === 'EVENT' && !!item.metadata?.task_calendar)
    const isDone    = item.status === 'COMPLETED'
    const isPast    = item.end ? new Date(item.end) <= _todayMidnight : new Date(item.start) < _todayMidnight
    const isPastDue = isTask && isPast && !isDone

    const chip = document.createElement('div')
    chip.className = [
      'mobile-allday-chip',
      isTask    ? 'type-task' : '',
      isDone    ? 'completed' : '',
      isPast && !isTask && !isDone ? 'is-past'  : '',
      isPastDue || item.metadata?.rolledPastDue ? 'past-due' : '',
      !isPastDue && !item.metadata?.rolledPastDue && isInProgressItem(item, isTask, isDone) ? 'in-progress' : '',
    ].filter(Boolean).join(' ')
    chip.title = item.title

    if (isTask) {
      if (isDone) chip.style.background = 'transparent'
      else if (item.color) applyColor(chip, item.color)

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
      const parts = [check, titleSpan]
      if (isRecurring) {
        const icon = document.createElement('span')
        icon.className   = 'task-recur-icon'
        icon.textContent = '↻'
        icon.title       = 'Recurring'
        parts.push(icon)
      }
      chip.append(...parts)
    } else {
      if (item.color) applyColor(chip, item.color)
      const isRecurringEv = !!(item.recurrence || item.metadata?.recurringEventId)
      chip.textContent = item.title
      if (isRecurringEv) {
        chip.style.paddingRight = '14px'
        const icon = document.createElement('span')
        icon.className   = 'allday-recur-icon'
        icon.textContent = '↻'
        chip.appendChild(icon)
      }
    }

    chip.addEventListener('click', () => {
      openEditorForEdit(item, calendarModalCallbacks())
    })
    { const d = _tagDots(item); if (d) chip.appendChild(d) }
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
    if (!(start < dayEnd && end > dayStart)) continue  // doesn't touch this day
    // Clamp to the viewed day so a cross-midnight event shows its portion here
    // (00:00 head on the following day, tail up to 24:00 on the start day).
    const segStart = start < dayStart ? dayStart : start
    const segEnd   = end   > dayEnd   ? dayEnd   : end
    timedItems.push({ item, start: segStart, end: segEnd })
  }

  for (const { item, start, end, colIdx, numCols } of computeOverlapLayout(timedItems)) {
    const topMin = start.getHours() * 60 + start.getMinutes()
    const durMin = Math.max((end - start) / 60_000, 15)

    const _timedTask = item.item_type === 'TASK' || (item.item_type === 'EVENT' && !!item.metadata?.task_calendar)
    const _timedDone = item.status === 'COMPLETED'
    const _timedPast = end <= _now

    const eventEl = document.createElement('div')
    eventEl.className = [
      'mobile-cal-event',
      _timedTask                               ? 'type-task' : '',
      _timedTask && _timedDone                 ? 'completed' : '',
      _timedPast && !_timedTask && !_timedDone ? 'is-past'   : '',
      _timedTask && _timedPast  && !_timedDone ? 'past-due'  : '',
      !(_timedTask && _timedPast && !_timedDone) && isInProgressItem(item, _timedTask, _timedDone) ? 'in-progress' : '',
    ].filter(Boolean).join(' ')
    if (_timedTask && !_timedDone && item.color) applyColor(eventEl, item.color)
    else if (!_timedTask && item.color) applyColor(eventEl, item.color)
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

    const isRecurringEv = !!(item.recurrence || item.metadata?.recurringEventId)

    if (_timedTask) {
      const check = document.createElement('button')
      check.className = `task-check${_timedDone ? ' done' : ''}`
      check.setAttribute('aria-label', _timedDone ? 'Mark incomplete' : 'Mark complete')
      if (_timedDone) check.textContent = '✓'
      check.addEventListener('click', e => {
        e.stopPropagation()
        if (item.item_type === 'TASK') handleToggleTask(item)
        else                           handleToggleCommitment(item)
      })

      const textWrap = document.createElement('div')
      textWrap.className = 'timed-task-text'
      const titleEl = document.createElement('div')
      titleEl.className   = 'mobile-event-title'
      titleEl.textContent = item.title
      const timeEl = document.createElement('div')
      timeEl.className   = 'mobile-event-time'
      timeEl.textContent = formatTimeRange(start, end)
      textWrap.append(titleEl, timeEl)

      if (isRecurringEv) {
        eventEl.classList.add('has-recur')
        const icon = document.createElement('span')
        icon.className   = 'timed-recur-icon'
        icon.textContent = '↻'
        eventEl.appendChild(icon)
      }

      const snoozeBtn = !_timedDone ? (() => {
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

      eventEl.append(check, textWrap, ...(snoozeBtn ? [snoozeBtn] : []))
      eventEl.title = item.title
      eventEl.addEventListener('click', () => {
        openEditorForEdit(item, calendarModalCallbacks())
      })
    } else {
      const titleEl = document.createElement('div')
      titleEl.className   = 'mobile-event-title'
      titleEl.textContent = item.title
      const timeEl = document.createElement('div')
      timeEl.className   = 'mobile-event-time'
      timeEl.textContent = formatTimeRange(start, end)
      eventEl.append(titleEl, timeEl)
      if (isRecurringEv) {
        eventEl.classList.add('has-recur')
        const icon = document.createElement('span')
        icon.className   = 'timed-recur-icon'
        icon.textContent = '↻'
        eventEl.appendChild(icon)
      }
      eventEl.title = item.title
      eventEl.addEventListener('click', () => {
        openEditorForEdit(item, calendarModalCallbacks())
      })
    }
    { const d = _tagDots(item); if (d) eventEl.appendChild(d) }
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
    syncVisibilityToWeek(state.weekStart)
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
  renderVisibilityPill()
  renderColumnHeaders()
  renderTimeGutter()
  renderDayColumns()
  updateTimeIndicator()
  renderAccountStatus()
  loadCalendars()  // async, populates calendar picker in background

  try {
    const end      = addDays(state.weekStart, 7)
    const cacheKey = state.weekStart.getTime()
    const hit      = _weekCache.get(cacheKey)

    if (hit && Date.now() - hit.ts < _CACHE_TTL) {
      // Fast path: serve from preloaded cache — navigation feels instant
      state.items = hit.items
      renderItems(getVisibleItems())
      getToken().then(t => { if (t) ensureFooters(t, state.items).catch(console.warn) })
    } else {
      // Cold path: fetch items, prefs, and lists in parallel
      const [items] = await Promise.all([
        fetchItems(state.weekStart, end),
        getToken().then(t => t ? loadPrefs(t).then(() => {
          state.hiddenCalendars = new Set(getHiddenCalendars())
          state.taskCalendars   = new Set(getTaskCalendars())
        }) : null),
        getToken().then(t => t ? loadLists(t) : null),
      ])
      // Config events (statuses + tag palette) need the task-calendar list, so
      // after prefs. Cosmetic for the calendar (in-progress ring), so non-blocking.
      getToken().then(t => t ? loadStatusConfig(t).then(() => { renderItems(getVisibleItems()); renderFilterBar() }) : null).catch(console.warn)
      ensureVisibilityReady()
      renderVisibilityPill()
      if (items !== null) {
        state.items = items
      } else {
        showToast('Calendar failed to load — check your connection and refresh')
      }
      renderItems(getVisibleItems())
      getToken().then(t => { if (t) ensureFooters(t, state.items).catch(console.warn) })
    }
    updateWorkViewButtons()
    // Roll past-due tasks onto today (needs prefs loaded for task calendars, so
    // runs after the fetch above; re-renders once the set is in).
    refreshPastDueTasks().then(() => renderItems(getVisibleItems())).catch(() => {})
  } catch (err) {
    console.error('Render failed:', err)
  }

  preloadAdjacentWeeks()
}

// ── Navigation ───────────────────────────────────────────────────────────────

document.getElementById('btn-prev').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, -7)
  syncVisibilityToWeek(state.weekStart)
  render()
})
document.getElementById('btn-next').addEventListener('click', () => {
  state.weekStart = addDays(state.weekStart, 7)
  syncVisibilityToWeek(state.weekStart)
  render()
})
document.getElementById('btn-today').addEventListener('click', () => {
  state.weekStart = getWeekStart(new Date())
  state.mobileDay = new Date()
  render()
})

document.getElementById('btn-visibility').addEventListener('click', openVisibilityDialog)

// ── Init ─────────────────────────────────────────────────────────────────────

if (new URLSearchParams(window.location.search).get('auth_error')) {
  history.replaceState({}, '', '/')
  alert('Sign-in failed. Please try again.')
}

// View switcher — buttons wire their own click handlers in populateViewSelect().
populateViewSelect()

// Filter bar
document.getElementById('filter-input').addEventListener('input', e => {
  state.filter.text = e.target.value
  document.getElementById('filter-clear').hidden = !(state.filter.text || state.filter.tags.length)
  applyFilter()
})
document.getElementById('filter-input').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  const val = e.target.value.trim()
  const match = getAllTagNames().find(n => n.toLowerCase() === val.toLowerCase())
  if (match && !state.filter.tags.includes(match)) {
    state.filter.tags.push(match)
    state.filter.text = ''
    e.target.value = ''
    renderFilterBar()
    applyFilter()
  }
})
document.getElementById('filter-clear').addEventListener('click', () => {
  state.filter = { text: '', tags: [] }
  document.getElementById('filter-input').value = ''
  renderFilterBar()
  applyFilter()
})

// Board / list project-calendar selector
document.getElementById('board-calendar-select').addEventListener('change', e => {
  setProjectCalendarId(e.target.value)
  rerenderWorkView()
})

// Show version on hover over the app title
document.getElementById('app-name').dataset.tooltip = `v${VERSION}`

// Admin utilities — callable from browser console for data repair
// Usage: await _kairos.relinkLog(token, 'gtasks:LIST:TASKID', 'kairosId')
window._kairos = {
  relinkLog: async (token, oldItemId, kairosId) => {
    const n = await relinkLogEntries(token, oldItemId, kairosId)
    console.log(`relinkLog: updated ${n} entries (${oldItemId} → kairosId:${kairosId})`)
    return n
  },

  // Bulk-move every incomplete task from one status column to another, matched
  // by status name (case-insensitive), on the currently selected project calendar.
  // Usage: await _kairos.moveAllStatus('Intake', 'Backlog')
  moveAllStatus: async (fromName, toName) => {
    const token = await getToken()
    if (!token) { console.warn('moveAllStatus: not signed in'); return 0 }
    const calId = currentProjectCalendarId()
    if (!calId) { console.warn('moveAllStatus: no project calendar selected'); return 0 }

    const statuses = getStatusesForCalendar(calId)
    const norm = s => (s ?? '').trim().toLowerCase()
    const from = statuses.find(s => norm(s.name) === norm(fromName))
    const to   = statuses.find(s => norm(s.name) === norm(toName))
    if (!from) { console.warn(`moveAllStatus: no status named "${fromName}" on this calendar`); return 0 }
    if (!to)   { console.warn(`moveAllStatus: no status named "${toName}" on this calendar`); return 0 }

    // Column membership mirrors the board: unknown/missing statusId falls into the
    // first (lowest-order) column, so "Intake" scoops up untriaged tasks too.
    const firstId = [...statuses].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.id
    const known   = new Set(statuses.map(s => s.id))
    const effId   = t => { const sid = t.metadata?.statusId; return (sid && known.has(sid)) ? sid : firstId }

    const items = (await getAllTaskEvents(token, calId))
      .filter(t => t.status !== 'COMPLETED' && effId(t) === from.id)

    let moved = 0
    for (const t of items) {
      try {
        const extId = t.source.external_id
        if (t.metadata?.unprocessed) {
          const master = t.metadata.recurringEventId ?? extId
          await patchTaskProps(token, calId, master, { isTask: 'true', statusId: to.id })
        } else {
          await patchTaskProps(token, calId, extId, { statusId: to.id })
        }
        moved++
      } catch (err) {
        console.error(`moveAllStatus: failed for "${t.title}"`, err)
      }
    }

    if (WORK_VIEWS.includes(state.view)) await loadBoardData()
    const calName = state.calendars.find(c => c.id === calId)?.summary ?? calId
    console.log(`moveAllStatus: moved ${moved} task(s) ${from.name} → ${to.name} on ${calName}`)
    return moved
  },
}

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

// Sweep dialog close
document.getElementById('sweep-dialog-close').addEventListener('click', () => {
  document.getElementById('sweep-dialog').hidden = true
})
document.getElementById('sweep-dialog').addEventListener('click', e => {
  if (e.target === document.getElementById('sweep-dialog'))
    document.getElementById('sweep-dialog').hidden = true
})

render().then(async () => {
  // Deep-link routing: switch to the view named by the URL path (prefs/task
  // calendars are loaded by now, so availability is known). Canonicalize the
  // root to /calendar so the address bar always names the current view.
  const _initialView = _availableView(_viewFromPath() ?? 'calendar')
  if (_initialView !== 'calendar') setView(_initialView, { replace: true })
  else                             _syncUrlToView('calendar', true)

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
  runSweepIfConfigured()
  setInterval(runSweepIfConfigured, SWEEP_INTERVAL)
  startPolling()

  // One-time global footer backfill — fetches masters (not instances) so recurring
  // tasks propagate the footer to all future instances via description inheritance.
  getToken().then(t => {
    if (t && state.taskCalendars.size)
      ensureAllFooters(t, [...state.taskCalendars]).catch(console.warn)
  })

  // Deep-link: ?task=<kairosId> opens the task editor directly (written into the
  // "View in Kairos" footer link so native GCal clients can jump back to Kairos)
  const sp          = new URLSearchParams(window.location.search)
  const deepLinkId  = sp.get('task')
  if (deepLinkId) {
    history.replaceState({}, '', '/')
    const token = await getToken()
    if (token) {
      let task = state.items.find(i => i.metadata?.kairosId === deepLinkId)
      if (!task && state.taskCalendars.size) {
        task = await findTaskByKairosId(token, [...state.taskCalendars], deepLinkId).catch(() => null)
      }
      if (task) openEditorForEdit(task, { onSaved: refreshCalendarItems })
    }
  }
})
