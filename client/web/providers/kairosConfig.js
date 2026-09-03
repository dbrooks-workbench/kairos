// Per-calendar PROJECT config, stored in a hidden "config event" on the calendar
// itself -- so it travels with an ACL share ("a project = a calendar + its config").
// Holds the workflow statuses and the tag colour palette. It is a cache of
// reconstructable state: if the event is ever deleted, it's rebuilt from a walk of
// the calendar's items (in-use statuses/tags), with order/flags/colours re-seeded.
//
// Config event: an all-day event at 1970-01-01, marked extendedProperties.private
// kairosConfig='true', with:
//   s_<statusId> = 'name<US>order<US>progressFlag'  (one property per status)
//     progressFlag: '' = none, '1' = in-progress, 'r' = ready (pins undated tasks to today)
//   tagPalette   = JSON { "<tagName>": "<color>", ... }   (structured for growth)
//
// This replaces the Firestore-backed statuses. User-scoped data (prefs, life log)
// stays in Firestore -- only project-scoped config lives here.

const BASE = 'https://www.googleapis.com/calendar/v3'
const CONFIG_SENTINEL = '1970-01-01'
const CONFIG_TITLE    = 'Kairos config - do not delete'
const SEP             = String.fromCharCode(31)   // unit separator -- cannot collide with user text
const MARKER          = 'kairosConfig'

const DEFAULT_STATUSES = [
  { name: 'Intake',      progress: ''            },
  { name: 'Backlog',     progress: ''            },
  { name: 'Up Next',     progress: 'ready'       },
  { name: 'In Progress', progress: 'in-progress' },
]

// Deterministic fallback colour when a tag isn't in the palette (stable per name).
const TAG_PALETTE_FALLBACK = ['#7986cb','#33b679','#8e24aa','#e67c73','#f6c026','#f5511d','#039be5','#616161','#3f51b5','#0b8043','#d60000']
export function defaultTagColor(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  return TAG_PALETTE_FALLBACK[Math.abs(h) % TAG_PALETTE_FALLBACK.length]
}

// In-memory: { [calendarId]: { eventId, statuses: {id: {name,order,progress}}, palette: {name: color} } }
let _config    = {}
let _saveToken = null

// -- HTTP --------------------------------------------------------------------
const _enc = encodeURIComponent
function _headers(token) { return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }

function _nextDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt  = new Date(Date.UTC(y, m - 1, d + 1))
  const pad = n => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

function _genId() {
  return (crypto.randomUUID?.() ?? String(Math.random()).slice(2)).replace(/-/g, '').slice(0, 10)
}

async function _findConfigEvent(token, calendarId) {
  const params = new URLSearchParams({
    privateExtendedProperty: `${MARKER}=true`,
    timeMin:      '1969-06-01T00:00:00Z',
    timeMax:      '1970-06-01T00:00:00Z',
    singleEvents: 'true',
    maxResults:   '2',
  })
  const res = await fetch(`${BASE}/calendars/${_enc(calendarId)}/events?${params}`, { headers: _headers(token) })
  if (!res.ok) throw new Error(`config find ${res.status}`)
  const data = await res.json()
  return data.items?.[0] ?? null
}

async function _patchEvent(token, calendarId, eventId, privProps) {
  const res = await fetch(`${BASE}/calendars/${_enc(calendarId)}/events/${_enc(eventId)}`, {
    method: 'PATCH', headers: _headers(token),
    body: JSON.stringify({ extendedProperties: { private: privProps } }),
  })
  if (!res.ok) throw new Error(`config patch ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

async function _createConfigEvent(token, calendarId, statuses, palette) {
  const priv = { [MARKER]: 'true', tagPalette: JSON.stringify(palette ?? {}) }
  for (const [id, s] of Object.entries(statuses ?? {})) priv[`s_${id}`] = _encodeStatus(s)
  const res = await fetch(`${BASE}/calendars/${_enc(calendarId)}/events`, {
    method: 'POST', headers: _headers(token),
    body: JSON.stringify({
      summary:      CONFIG_TITLE,
      start:        { date: CONFIG_SENTINEL },
      end:          { date: _nextDay(CONFIG_SENTINEL) },
      transparency: 'transparent',
      extendedProperties: { private: priv },
    }),
  })
  if (!res.ok) throw new Error(`config create ${res.status}: ${await res.text().catch(() => '')}`)
  return res.json()
}

// -- Encoding ----------------------------------------------------------------
function _encodeStatus(s) {
  // progressFlag: '' = none, '1' = in-progress (legacy compat), 'r' = ready
  const flag = s.progress === 'in-progress' ? '1' : s.progress === 'ready' ? 'r' : ''
  return `${s.name}${SEP}${s.order ?? 0}${SEP}${flag}`
}
function _decodeStatus(val) {
  const [name, order, flag] = val.split(SEP)
  // '1' is the legacy in-progress flag written before tri-state was introduced
  const progress = flag === '1' ? 'in-progress' : flag === 'r' ? 'ready' : ''
  return { name: name ?? '', order: Number(order) || 0, progress }
}

function _parseConfigEvent(event) {
  const p        = event.extendedProperties?.private ?? {}
  const statuses = {}
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('s_')) statuses[k.slice(2)] = _decodeStatus(v)
  }
  let palette = {}
  try { palette = JSON.parse(p.tagPalette || '{}') } catch {}
  return { eventId: event.id, statuses, palette }
}

// -- Load --------------------------------------------------------------------
// Load (and create-if-missing, with default statuses) the config event for each
// of the given calendars. `seedStatuses(calendarId) => {id: {name,order,inProgress}}|null`
// lets callers migrate an existing status set (e.g. from Firestore) on first create.
export async function loadConfig(token, calendarIds, seedStatuses = null) {
  _saveToken = token
  await Promise.all(calendarIds.map(calId => _loadOne(token, calId, seedStatuses).catch(err => {
    console.warn(`config load failed for ${calId}:`, err.message)
  })))
}

async function _loadOne(token, calendarId, seedStatuses) {
  const existing = await _findConfigEvent(token, calendarId)
  if (existing) {
    _config[calendarId] = _parseConfigEvent(existing)
    return
  }
  // Missing -> create. Seed from the caller (migration) if provided, else defaults.
  let statuses = (seedStatuses && seedStatuses(calendarId)) || null
  if (!statuses) {
    statuses = {}
    DEFAULT_STATUSES.forEach((s, i) => { statuses[_genId()] = { name: s.name, order: i * 10, progress: s.progress } })
  }
  const event = await _createConfigEvent(token, calendarId, statuses, {})
  _config[calendarId] = { eventId: event.id, statuses, palette: {} }
}

// -- Status API (matches the former kairosStatuses surface) ------------------
export function getStatusesForCalendar(calendarId) {
  const c = _config[calendarId]
  if (!c) return []
  return Object.entries(c.statuses)
    .map(([id, s]) => ({ id, calendarId, ...s }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

// The default "intake" status for a calendar: its lowest-order status (the first
// board column, seeded as "Intake"). Used so every task gets a status even when
// the user doesn't pick one. Returns null if the calendar has no statuses yet.
export function getDefaultStatusId(calendarId) {
  return getStatusesForCalendar(calendarId)[0]?.id ?? null
}

export function getStatus(statusId) {
  for (const [calendarId, c] of Object.entries(_config)) {
    if (c.statuses[statusId]) return { id: statusId, calendarId, ...c.statuses[statusId] }
  }
  return null
}

export function getAllStatuses() {
  const out = []
  for (const [calendarId, c] of Object.entries(_config)) {
    for (const [id, s] of Object.entries(c.statuses)) out.push({ id, calendarId, ...s })
  }
  return out
}

export function getInProgressStatusIds() {
  const set = new Set()
  for (const c of Object.values(_config)) {
    for (const [id, s] of Object.entries(c.statuses)) if (s.progress === 'in-progress') set.add(id)
  }
  return set
}

export function getReadyStatusIds() {
  const set = new Set()
  for (const c of Object.values(_config)) {
    for (const [id, s] of Object.entries(c.statuses)) if (s.progress === 'ready') set.add(id)
  }
  return set
}

export async function createStatus(token, calendarId, name, order = 0, progress = '') {
  const c = _config[calendarId]
  if (!c) return null
  const id = _genId()
  c.statuses[id] = { name, order, progress }
  await _patchEvent(token ?? _saveToken, calendarId, c.eventId, { [`s_${id}`]: _encodeStatus(c.statuses[id]) })
  return { id, calendarId, name, order, progress }
}

export async function updateStatus(token, statusId, changes) {
  for (const [calendarId, c] of Object.entries(_config)) {
    if (!c.statuses[statusId]) continue
    c.statuses[statusId] = { ...c.statuses[statusId], ...changes }
    await _patchEvent(token ?? _saveToken, calendarId, c.eventId, { [`s_${statusId}`]: _encodeStatus(c.statuses[statusId]) })
    return { id: statusId, calendarId, ...c.statuses[statusId] }
  }
}

export async function deleteStatus(token, statusId) {
  for (const [calendarId, c] of Object.entries(_config)) {
    if (!c.statuses[statusId]) continue
    delete c.statuses[statusId]
    await _patchEvent(token ?? _saveToken, calendarId, c.eventId, { [`s_${statusId}`]: null })
    return
  }
}

// Create default statuses for a calendar just designated a task calendar (ensures
// its config event exists). No-op if it already has statuses.
export async function ensureDefaultStatuses(token, calendarId) {
  if (!_config[calendarId]) await _loadOne(token, calendarId, null)
  const c = _config[calendarId]
  if (c && Object.keys(c.statuses).length === 0) {
    for (let i = 0; i < DEFAULT_STATUSES.length; i++) {
      await createStatus(token, calendarId, DEFAULT_STATUSES[i].name, i * 10, DEFAULT_STATUSES[i].progress)
    }
  }
  return getStatusesForCalendar(calendarId)
}

// -- Tag palette API ----------------------------------------------------------
export function getTagPalette(calendarId) {
  return { ...(_config[calendarId]?.palette ?? {}) }
}

export function getTagColor(calendarId, name) {
  return _config[calendarId]?.palette?.[name] ?? defaultTagColor(name)
}

export function isConfigLoaded(calendarId) {
  return Object.prototype.hasOwnProperty.call(_config, calendarId)
}

// All tag names known for a calendar (palette entries -- used for the typeahead).
export function getPaletteTagNames(calendarId) {
  return Object.keys(_config[calendarId]?.palette ?? {}).sort((a, b) => a.localeCompare(b))
}

// Every tag name across all loaded calendars (for the global filter typeahead).
export function getAllTagNames() {
  const set = new Set()
  for (const c of Object.values(_config)) for (const n of Object.keys(c.palette)) set.add(n)
  return [...set].sort((a, b) => a.localeCompare(b))
}

export async function setTagColor(token, calendarId, name, color) {
  const c = _config[calendarId]
  if (!c) return
  c.palette[name] = color
  await _patchEvent(token ?? _saveToken, calendarId, c.eventId, { tagPalette: JSON.stringify(c.palette) })
}

// Add a tag to the palette (deterministic colour if none given). Idempotent.
export async function ensureTag(token, calendarId, name, color = null) {
  const c = _config[calendarId]
  if (!c || c.palette[name]) return
  c.palette[name] = color ?? defaultTagColor(name)
  await _patchEvent(token ?? _saveToken, calendarId, c.eventId, { tagPalette: JSON.stringify(c.palette) })
}

// Add any not-yet-known tag names to the palette in a single PATCH (hash colours).
export async function ensureTags(token, calendarId, names) {
  const c = _config[calendarId]
  if (!c) return
  let changed = false
  for (const name of names) {
    if (name && !(name in c.palette)) { c.palette[name] = defaultTagColor(name); changed = true }
  }
  if (changed) await _patchEvent(token ?? _saveToken, calendarId, c.eventId, { tagPalette: JSON.stringify(c.palette) })
}

export async function removeTagFromPalette(token, calendarId, name) {
  const c = _config[calendarId]
  if (!c || !(name in c.palette)) return
  delete c.palette[name]
  await _patchEvent(token ?? _saveToken, calendarId, c.eventId, { tagPalette: JSON.stringify(c.palette) })
}
