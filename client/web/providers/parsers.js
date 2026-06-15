// Regexes ported from agile-tasks/src/parsers.js for compatibility with existing task data.

const LOE_RE = /^~\s*(?:(\d+(?:\.\d+)?)d\s*)?(?:(\d+(?:\.\d+)?)h\s*)?(?:(\d+(?:\.\d+)?)m)?$/
const COMMENT_RE = /^@(\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?)\s*(.*)/
const CHECKLIST_RE = /^- \[([ x])\] (.*)/

// Structured action comment verbs: @timestamp !verb $KEY payload
const ACTION_RE = /^!([a-z]+)\s+\$(\S+)\s*(.*)/
const KNOWN_VERBS = new Set(['spawned', 'cancelled', 'deferred'])

// ── Task notes parser ─────────────────────────────────────────────────────────
// Serialization order: prose body → checklist → LOE → comments

export function parseTaskNotes(notes) {
  if (!notes) return { body: '', loe: null, checklist: [], comments: [] }

  const lines = notes.split('\n')
  const bodyLines = []
  let loe = null
  const checklist = []
  const comments = []

  for (const line of lines) {
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
    bodyLines.push(line)
  }

  return {
    body: bodyLines.join('\n').trim(),
    loe,
    checklist,
    comments: [...comments].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  }
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
