// Regexes ported from agile-tasks/src/parsers.js for compatibility with existing task data.

const LOE_RE       = /^~\s*(?:(\d+(?:\.\d+)?)d\s*)?(?:(\d+(?:\.\d+)?)h\s*)?(?:(\d+(?:\.\d+)?)m)?$/
const COMMENT_RE   = /^@(\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)\s*(.*)/
const CHECKLIST_RE = /^- \[([ x])\] (.*)/
const KID_RE       = /^\[kid:([0-9a-f]+)\]$/

// Structured action comment verbs: @timestamp !verb $KEY payload
const ACTION_RE = /^!([a-z]+)\s+\$(\S+)\s*(.*)/
const KNOWN_VERBS = new Set(['spawned', 'cancelled', 'deferred', 'completed', 'uncompleted', 'snoozed'])

// ── Task notes parser ─────────────────────────────────────────────────────────
// Serialization order: prose body → checklist → LOE → comments

export function parseTaskNotes(notes) {
  if (!notes) return { body: '', loe: null, checklist: [], kid: null }

  // Strip write-only snapshot block — Kairos never reads it back
  const snapIdx = notes.indexOf('\n--- Kairos ---')
  const stripped = snapIdx >= 0 ? notes.slice(0, snapIdx) : notes

  const lines     = stripped.split('\n')
  const bodyLines = []
  let loe = null
  let kid = null
  const checklist = []

  for (const line of lines) {
    const kidMatch = line.match(KID_RE)
    if (kidMatch) { kid = kidMatch[1]; continue }

    // Skip legacy @timestamp comment lines — comments now live in the life log Sheet
    if (COMMENT_RE.test(line)) continue

    const checkMatch = line.match(CHECKLIST_RE)
    if (checkMatch) {
      checklist.push({ text: checkMatch[2], checked: checkMatch[1] === 'x' })
      continue
    }
    if (!loe && LOE_RE.test(line)) {
      loe = line.replace(/^~\s*/, '').trim()
      continue
    }
    bodyLines.push(line)
  }

  return { body: bodyLines.join('\n').trim(), loe, checklist, kid }
}

// ── Serialization ────────────────────────────────────────────────────────────
// Order: prose body → checklist → LOE line → comments (chronological)

// Serialization order: prose → checklist → [kid:xxx]
// LOE, comments, and recurrence are stored in Drive (driveTaskMeta.js), not in notes.
export function serializeNotes({ body, checklist, kid, snapshot }) {
  const parts = []
  if (body?.trim()) parts.push(body.trim())
  if (checklist?.length)
    parts.push(checklist.map(i => `- [${i.checked ? 'x' : ' '}] ${i.text}`).join('\n'))
  const body_out = parts.join('\n\n')
  let result = kid ? (body_out ? `${body_out}\n\n[kid:${kid}]` : `[kid:${kid}]`) : body_out
  if (snapshot) result = result ? `${result}\n\n${snapshot}` : snapshot
  return result
}

// Serialize notes from a full markdown body string produced by the Tiptap editor.
// Appends the [kid:xxx] anchor and snapshot block (same position as serializeNotes).
export function serializeNotesFromMarkdown(bodyMarkdown, { kid, snapshot }) {
  let result = bodyMarkdown?.trim() ?? ''
  if (kid) result = result ? `${result}\n\n[kid:${kid}]` : `[kid:${kid}]`
  if (snapshot) result = result ? `${result}\n\n${snapshot}` : snapshot
  return result
}

// Build the write-only --- Kairos --- snapshot appended to notes/descriptions.
// Standard clients see this; Kairos never reads it back (stripped in parseTaskNotes).
export function buildSnapshot({ completedAt, loe, comments }) {
  const parts = []
  if (completedAt) {
    const d = new Date(completedAt)
    parts.push(`Completed ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`)
  } else if (loe) {
    parts.push(`LOE: ${loe}`)
  }
  if (comments?.length) {
    parts.push(`${comments.length} comment${comments.length === 1 ? '' : 's'}`)
  }
  parts.push(`Updated ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`)
  return `--- Kairos ---\n${parts.join('  ·  ')}`
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
  // Normalize space-separated datetime (e.g. from Sheets) to ISO format
  const normalized = String(ts).replace(' ', 'T')
  const d = new Date(normalized.includes('T') ? normalized : normalized + 'T00:00:00')
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
