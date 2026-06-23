// Regexes ported from agile-tasks/src/parsers.js for compatibility with existing task data.

const LOE_RE       = /^~\s*(?:(\d+(?:\.\d+)?)d\s*)?(?:(\d+(?:\.\d+)?)h\s*)?(?:(\d+(?:\.\d+)?)m)?$/
const COMMENT_RE   = /^@(\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)\s*(.*)/
const CHECKLIST_RE = /^- \[([ x])\] (.*)/
const RECUR_RE     = /^&\s*(\S.*)/  // & followed by non-empty content
const KID_RE       = /^\[kid:([0-9a-f]+)\]$/

// ── Recurrence helpers ────────────────────────────────────────────────────────
// Sigil format: &FREQ[,DAY[,DAY…]] — human readable, no "RRULE:" prefix.
// Examples: &DAILY  &WEEKLY,FRIDAY  &BIWEEKLY,MONDAY,WEDNESDAY  &MONTHLY,15  &ANNUALLY

const _FREQ_KEYS = new Set(['DAILY', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ANNUALLY'])
const _DAY_LONG  = { SUNDAY:'SU', MONDAY:'MO', TUESDAY:'TU', WEDNESDAY:'WE', THURSDAY:'TH', FRIDAY:'FR', SATURDAY:'SA' }
const _DAY_SHORT = ['SU','MO','TU','WE','TH','FR','SA']
const _DAY_LONG_FROM_SHORT = { SU:'SUNDAY', MO:'MONDAY', TU:'TUESDAY', WE:'WEDNESDAY', TH:'THURSDAY', FR:'FRIDAY', SA:'SATURDAY' }
export const MONTH_NAMES = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER']

// Parse &WEEKLY,FRIDAY → canonical RRULE:FREQ=WEEKLY;BYDAY=FR
// Supports simple shorthands and the extended &EVERY N FREQ[,...] format.
// Examples: &DAILY  &WEEKLY,FRIDAY  &MONTHLY,15  &ANNUALLY,JULY 1
//           &EVERY 2 YEARS,JULY 1   &EVERY 3 MONTHS,15  &EVERY 10 DAYS
// Optional UNTIL suffix: &WEEKLY,FRIDAY UNTIL 2026-12-31
// Returns null if the content after & isn't a recognized recurrence pattern.
export function parseRecurSigil(raw) {
  if (!raw) return null
  const stripped = raw.replace(/^&\s*/, '').trim()

  // Extract optional UNTIL date before upcasing everything
  const untilMatch = stripped.match(/\bUNTIL\s+(\d{4}-\d{2}-\d{2})\s*$/i)
  const until      = untilMatch ? untilMatch[1] : null
  const main       = stripped.replace(/\s*UNTIL\s+\S+\s*$/i, '').trim().toUpperCase()

  const parts = main.split(/[,;\s]+/).map(p => p.trim()).filter(Boolean)
  const _u = until ? `;UNTIL=${until.replace(/-/g, '')}T235959Z` : ''

  // &EVERY N FREQ[,...] — e.g. &EVERY 2 YEARS,JULY 1
  if (parts[0] === 'EVERY') {
    const n = parseInt(parts[1], 10)
    if (isNaN(n) || n < 1) return null
    const freqMap = { DAYS:'DAILY', WEEKS:'WEEKLY', MONTHS:'MONTHLY', YEARS:'YEARLY' }
    const resolvedFreq = freqMap[parts[2]]
    if (!resolvedFreq) return null
    return _buildRruleFromParts(resolvedFreq, n > 1 ? `;INTERVAL=${n}` : '', parts.slice(3), _u)
  }

  const freq = parts[0]
  if (!_FREQ_KEYS.has(freq)) return null

  if (freq === 'DAILY')    return `RRULE:FREQ=DAILY${_u}`
  if (freq === 'ANNUALLY') return _buildRruleFromParts('YEARLY', '', parts.slice(1), _u)

  if (freq === 'MONTHLY') {
    const n = parseInt(parts[1] ?? '', 10)
    const base = isNaN(n) ? 'RRULE:FREQ=MONTHLY' : `RRULE:FREQ=MONTHLY;BYMONTHDAY=${n}`
    return base + _u
  }

  // WEEKLY / BIWEEKLY
  const intStr = freq === 'BIWEEKLY' ? ';INTERVAL=2' : ''
  const days = parts.slice(1)
    .map(d => _DAY_LONG[d] ?? (Object.values(_DAY_LONG).includes(d) ? d : null))
    .filter(Boolean)
  const base = days.length
    ? `RRULE:FREQ=WEEKLY${intStr};BYDAY=${days.join(',')}`
    : `RRULE:FREQ=WEEKLY${intStr}`
  return base + _u
}

// Build canonical RRULE from freq + interval string + extra parts (month/day/byday).
function _buildRruleFromParts(freq, intStr, extras, _u) {
  if (freq === 'DAILY')   return `RRULE:FREQ=DAILY${intStr}${_u}`

  if (freq === 'YEARLY') {
    let bymonth = '', bymdd = ''
    if (extras.length >= 1) {
      const idx = MONTH_NAMES.indexOf(extras[0])
      if (idx >= 0) {
        bymonth = `;BYMONTH=${idx + 1}`
        const day = parseInt(extras[1] ?? '', 10)
        if (!isNaN(day) && day >= 1 && day <= 31) bymdd = `;BYMONTHDAY=${day}`
      }
    }
    return `RRULE:FREQ=YEARLY${intStr}${bymonth}${bymdd}${_u}`
  }

  if (freq === 'MONTHLY') {
    const n = parseInt(extras[0] ?? '', 10)
    return `RRULE:FREQ=MONTHLY${intStr}${isNaN(n) ? '' : `;BYMONTHDAY=${n}`}${_u}`
  }

  if (freq === 'WEEKLY') {
    const days = extras
      .map(d => _DAY_LONG[d] ?? (Object.values(_DAY_LONG).includes(d) ? d : null))
      .filter(Boolean)
    const byday = days.length ? `;BYDAY=${days.join(',')}` : ''
    return `RRULE:FREQ=WEEKLY${intStr}${byday}${_u}`
  }

  return null
}

// Convert RRULE:FREQ=WEEKLY;BYDAY=FR → &WEEKLY,FRIDAY (for storage in notes)
// With UNTIL: &WEEKLY,FRIDAY UNTIL 2026-12-31
// Custom intervals use the &EVERY N FREQ form; BYMONTH emits the month name.
export function recurSigilFromRrule(rrule) {
  if (!rrule) return ''
  const freq     = rrule.match(/FREQ=(\w+)/)?.[1]
  const interval = parseInt(rrule.match(/INTERVAL=(\d+)/)?.[1] ?? '1', 10)
  const byday    = rrule.match(/BYDAY=([^;]+)/)?.[1]?.split(',') ?? []
  const bymd     = rrule.match(/BYMONTHDAY=(\d+)/)?.[1]
  const bymonth  = parseInt(rrule.match(/BYMONTH=(\d+)/)?.[1] ?? '0', 10)
  const untilM   = rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/)
  const untilStr = untilM ? ` UNTIL ${untilM[1]}-${untilM[2]}-${untilM[3]}` : ''

  // BIWEEKLY special case
  if (freq === 'WEEKLY' && interval === 2) {
    let sig = '&BIWEEKLY'
    if (byday.length) sig += ',' + byday.map(d => _DAY_LONG_FROM_SHORT[d] ?? d).join(',')
    return sig + untilStr
  }

  let sig
  if (interval === 1) {
    const freqSig = { DAILY:'DAILY', WEEKLY:'WEEKLY', MONTHLY:'MONTHLY', YEARLY:'ANNUALLY' }[freq] ?? freq
    sig = `&${freqSig}`
  } else {
    const freqWord = { DAILY:'DAYS', WEEKLY:'WEEKS', MONTHLY:'MONTHS', YEARLY:'YEARS' }[freq] ?? freq
    sig = `&EVERY ${interval} ${freqWord}`
  }

  if (freq === 'YEARLY') {
    if (bymonth > 0) {
      sig += ',' + MONTH_NAMES[bymonth - 1]
      if (bymd) sig += ' ' + bymd
    }
  } else if (freq === 'WEEKLY') {
    if (byday.length) sig += ',' + byday.map(d => _DAY_LONG_FROM_SHORT[d] ?? d).join(',')
  } else if (freq === 'MONTHLY') {
    if (bymd) sig += ',' + bymd
  }

  return sig + untilStr
}

// Given an RRULE and the task's due date, return the next scheduled occurrence.
// Returns null if the series has ended (UNTIL reached) or the rule is unrecognised.
// Schedule-based: snaps snoozed due dates back to the nearest prior schedule day
// before advancing, so the cadence stays anchored to the rule, not the due field.
export function nextOccurrenceAfter(rrule, dueDate) {
  if (!rrule || !dueDate) return null
  const freq     = rrule.match(/FREQ=(\w+)/)?.[1]
  const interval = parseInt(rrule.match(/INTERVAL=(\d+)/)?.[1] ?? '1', 10)
  const byday    = rrule.match(/BYDAY=([^;]+)/)?.[1]?.split(',') ?? []
  const bymd     = parseInt(rrule.match(/BYMONTHDAY=(\d+)/)?.[1] ?? '0', 10)
  const untilM   = rrule.match(/UNTIL=(\d{4})(\d{2})(\d{2})/)
  const until    = untilM ? new Date(`${untilM[1]}-${untilM[2]}-${untilM[3]}T00:00:00`) : null

  const bymonth = parseInt(rrule.match(/BYMONTH=(\d+)/)?.[1] ?? '0', 10)

  const d = new Date(dueDate); d.setHours(0,0,0,0)
  let next = null

  if (freq === 'DAILY') {
    d.setDate(d.getDate() + interval); next = d
  } else if (freq === 'WEEKLY') {
    if (!byday.length) {
      d.setDate(d.getDate() + 7*interval); next = d
    } else {
      const targets = byday.map(b => _DAY_SHORT.indexOf(b))
      const cur = d.getDay()
      let snapBack = 0
      for (let i = 0; i <= 6; i++) {
        if (targets.includes((cur - i + 7) % 7)) { snapBack = i; break }
      }
      d.setDate(d.getDate() - snapBack + 7*interval); next = d
    }
  } else if (freq === 'MONTHLY') {
    d.setMonth(d.getMonth() + interval)
    if (bymd) d.setDate(bymd)
    next = d
  } else if (freq === 'YEARLY') {
    d.setFullYear(d.getFullYear() + interval)
    if (bymonth) {
      d.setDate(1)               // reset day first to prevent month overflow
      d.setMonth(bymonth - 1)
      if (bymd) d.setDate(bymd)
    } else if (bymd) {
      d.setDate(bymd)
    }
    next = d
  }

  if (!next) return null
  if (until && next > until) return null
  return next
}

// Expand a recurring task into virtual CalendarItem instances within [windowStart, windowEnd].
// Only generates dates strictly after the task's own due date.
export function expandRruleInWindow(item, windowStart, windowEnd) {
  const rrule = item.metadata?.recurrence
  const base  = item.due
  if (!rrule || !base) return []

  const results = []
  let current   = new Date(base); current.setHours(0,0,0,0)

  for (let guard = 0; guard < 500; guard++) {
    const next = nextOccurrenceAfter(rrule, current)
    if (!next || next > windowEnd) break
    if (next >= windowStart) {
      results.push({
        ...item,
        id:       `${item.id}:v:${next.getTime()}`,
        due:      new Date(next),
        start:    new Date(next),
        status:   'NEEDS_ACTION',
        metadata: { ...item.metadata, virtual: true },
      })
    }
    current = next
  }
  return results
}

// Structured action comment verbs: @timestamp !verb $KEY payload
const ACTION_RE = /^!([a-z]+)\s+\$(\S+)\s*(.*)/
const KNOWN_VERBS = new Set(['spawned', 'cancelled', 'deferred'])

// ── Task notes parser ─────────────────────────────────────────────────────────
// Serialization order: prose body → checklist → LOE → comments

export function parseTaskNotes(notes) {
  if (!notes) return { body: '', loe: null, recurrence: null, checklist: [], comments: [], kid: null }

  const lines     = notes.split('\n')
  const bodyLines = []
  let loe        = null
  let recurrence = null
  let kid        = null
  const checklist = []
  const comments  = []

  for (const line of lines) {
    const kidMatch = line.match(KID_RE)
    if (kidMatch) { kid = kidMatch[1]; continue }

    const commentMatch = line.match(COMMENT_RE)
    if (commentMatch) {
      comments.push({ timestamp: commentMatch[1], text: commentMatch[2].trim() })
      continue
    }
    const checkMatch = line.match(CHECKLIST_RE)
    if (checkMatch) {
      checklist.push({ text: checkMatch[2], checked: checkMatch[1] === 'x' })
      continue
    }
    if (!loe && LOE_RE.test(line)) {
      loe = line.replace(/^~\s*/, '').trim()
      continue
    }
    if (!recurrence && RECUR_RE.test(line)) {
      const parsed = parseRecurSigil(line)
      if (parsed) { recurrence = parsed; continue }
      // & line that doesn't match a known frequency → treat as prose
    }
    bodyLines.push(line)
  }

  return {
    body: bodyLines.join('\n').trim(),
    loe,
    recurrence,
    checklist,
    comments: [...comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    kid,
  }
}

// ── Serialization ────────────────────────────────────────────────────────────
// Order: prose body → checklist → LOE line → comments (chronological)

// Serialization order: prose → checklist → [kid:xxx]
// LOE, comments, and recurrence are stored in Drive (driveTaskMeta.js), not in notes.
export function serializeNotes({ body, checklist, kid }) {
  const parts = []
  if (body?.trim()) parts.push(body.trim())
  if (checklist?.length)
    parts.push(checklist.map(i => `- [${i.checked ? 'x' : ' '}] ${i.text}`).join('\n'))
  const body_out = parts.join('\n\n')
  if (kid) return body_out ? `${body_out}\n\n[kid:${kid}]` : `[kid:${kid}]`
  return body_out
}

// ── LOE helpers ───────────────────────────────────────────────────────────────

export function normalizeLoe(raw) {
  if (!raw?.trim()) return null
  const val = raw.trim().replace(/^~\s*/, '').trim()
  if (!val) return null
  const m = LOE_RE.exec('~' + val)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return val
}

export function loeLabel(loe) {
  if (!loe) return null
  return loe.replace(/^~\s*/, '').trim() || null
}

// ── Timestamp helpers ─────────────────────────────────────────────────────────

export function nowTimestamp() {
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function displayTimestamp(ts) {
  if (!ts) return ''
  const d = new Date(ts.includes('T') ? ts : ts + 'T00:00:00')
  if (isNaN(d)) return ts
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

// ── Event description serializer ─────────────────────────────────────────────
// Inverse of parseEventDescription.
// Format: prose → blank line → JSON config → blank line → @timestamp log entries

export function serializeEventDescription(prose, config, comments) {
  const parts = []
  if (prose?.trim()) parts.push(prose.trim())
  if (config && Object.keys(config).length > 0) parts.push(JSON.stringify(config))
  if (comments?.length) {
    const sorted = [...comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    parts.push(sorted.map(c => `@${c.timestamp} ${c.text}`).join('\n'))
  }
  return parts.join('\n\n')
}

// ── Event description parser ──────────────────────────────────────────────────
// Format: prose → JSON config block → @timestamp log entries

export function extractKairosConfig(description) {
  if (!description) return null
  const start = description.indexOf('{')
  if (start === -1) return null
  let depth = 0, end = -1
  for (let i = start; i < description.length; i++) {
    if (description[i] === '{') depth++
    else if (description[i] === '}') { if (--depth === 0) { end = i; break } }
  }
  if (end === -1) return null
  try { return JSON.parse(description.slice(start, end + 1)) }
  catch { return null }
}

export function parseEventDescription(description) {
  if (!description) return { prose: '', config: null, comments: [] }

  const config = extractKairosConfig(description)

  // Strip the JSON block so we can parse prose and comments from what remains
  let remaining = description
  if (config !== null) {
    const start = description.indexOf('{')
    let depth = 0, end = -1
    for (let i = start; i < description.length; i++) {
      if (description[i] === '{') depth++
      else if (description[i] === '}') { if (--depth === 0) { end = i; break } }
    }
    remaining = (description.slice(0, start) + description.slice(end + 1)).trim()
  }

  const proseLines = []
  const comments = []

  for (const line of remaining.split('\n')) {
    const commentMatch = line.match(COMMENT_RE)
    if (commentMatch) {
      const timestamp = commentMatch[1]
      const text = commentMatch[2].trim()
      const actionMatch = text.match(ACTION_RE)
      if (actionMatch && KNOWN_VERBS.has(actionMatch[1])) {
        comments.push({
          timestamp,
          text,
          action: actionMatch[1],
          key: actionMatch[2],
          payload: actionMatch[3].trim(),
        })
      } else {
        comments.push({ timestamp, text })
      }
      continue
    }
    proseLines.push(line)
  }

  return {
    prose: proseLines.join('\n').trim(),
    config,
    comments: [...comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  }
}
