import { getToken } from './auth.js'
import { updateEvent } from './providers/googleCalendar.js'

const THRESHOLD = 6   // px before drag activates
const SNAP      = 15  // minute grid

let _weekStart = null
let _items     = []
let _cbs       = {}
let _pending   = null   // set on mousedown; activates into _drag after threshold
let _drag      = null   // active drag state
let _suppress  = false  // suppress the click event that follows a drag's mouseup

const pad  = n => String(n).padStart(2, '0')
const snap = m => Math.round(m / SNAP) * SNAP

function yToMin(clientY) {
  const r = document.getElementById('timed-cols').getBoundingClientRect()
  return Math.max(0, Math.min(1439, clientY - r.top))
}

function xToDayIdx(clientX) {
  for (const col of document.querySelectorAll('.timed-col')) {
    const r = col.getBoundingClientRect()
    if (clientX >= r.left && clientX < r.right) return +col.dataset.day
  }
  return null
}

function dateAt(dayIdx, minOfDay) {
  const d = new Date(_weekStart)
  d.setDate(d.getDate() + dayIdx)
  d.setHours(Math.floor(minOfDay / 60), minOfDay % 60, 0, 0)
  return d
}

function fmtDT(d) {
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

function findItem(id) { return _items.find(i => i.id === id) ?? null }

// ── Public API ────────────────────────────────────────────────────────────────

export function initTimedDrag(weekStart, items, cbs) {
  _weekStart = weekStart
  _items     = items
  _cbs       = cbs
  const tc = document.getElementById('timed-cols')
  if (!tc) return
  tc.addEventListener('click',     _killClick, true)   // capture phase
  tc.addEventListener('mousedown', _onDown)
  document.addEventListener('mousemove', _onMove)
  document.addEventListener('mouseup',   _onUp)
}

export function destroyTimedDrag() {
  const tc = document.getElementById('timed-cols')
  if (tc) {
    tc.removeEventListener('click',     _killClick, true)
    tc.removeEventListener('mousedown', _onDown)
  }
  document.removeEventListener('mousemove', _onMove)
  document.removeEventListener('mouseup',   _onUp)
  _cleanup()
  _pending = null
}

// ── Click suppressor (capture phase on #timed-cols) ───────────────────────────

function _killClick(e) {
  if (!_suppress) return
  _suppress = false
  e.stopImmediatePropagation()
  e.preventDefault()
}

// ── Mousedown ─────────────────────────────────────────────────────────────────

function _onDown(e) {
  if (e.button !== 0) return
  e.preventDefault()   // prevent text selection during potential drag

  const handle  = e.target.closest('.resize-handle')
  const eventEl = e.target.closest('.cal-event')

  if (handle && eventEl) {
    const item = findItem(eventEl.dataset.itemId)
    if (!item?.editable || item.item_type === 'TASK') return
    _pending = {
      type: 'resize', item, el: eventEl,
      startY: e.clientY,
      origHeight: parseFloat(eventEl.style.height),
      origTop:    parseFloat(eventEl.style.top),
    }
    return
  }

  if (eventEl) {
    _pending = {
      type: 'move', item: findItem(eventEl.dataset.itemId),
      el: eventEl, startX: e.clientX, startY: e.clientY,
    }
    return
  }

  const col = e.target.closest('.timed-col')
  if (col) {
    _pending = {
      type: 'draw', col, dayIdx: +col.dataset.day,
      startX: e.clientX, startY: e.clientY,
      startMin: snap(yToMin(e.clientY)),
    }
  }
}

// ── Mousemove ─────────────────────────────────────────────────────────────────

function _onMove(e) {
  if (!_pending && !_drag) return

  if (_pending) {
    const dx = e.clientX - _pending.startX
    const dy = e.clientY - (_pending.startY ?? e.clientY)
    if (dx*dx + dy*dy < THRESHOLD*THRESHOLD) return
    _activate(e)
  }

  if (_drag) {
    e.preventDefault()
    if (_drag.type === 'move')   _moveMove(e)
    if (_drag.type === 'resize') _resizeMove(e)
    if (_drag.type === 'draw')   _drawMove(e)
  }
}

function _activate(e) {
  const p = _pending
  _pending = null

  if (p.type === 'move') {
    if (!p.item?.editable || p.item.item_type === 'TASK') return
    const el   = p.el
    const rect = el.getBoundingClientRect()
    const colEl = el.closest('.timed-col')

    const ghost = document.createElement('div')
    ghost.className = 'cal-event drag-ghost'
    Object.assign(ghost.style, {
      position: 'fixed', pointerEvents: 'none',
      left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
      background: el.style.background || '',
    })
    ghost.innerHTML = el.innerHTML
    document.body.appendChild(ghost)

    el.classList.add('drag-placeholder')
    el.style.pointerEvents = 'none'
    document.body.classList.add('drag-active')

    _drag = {
      type: 'move', item: p.item, el, ghost, colEl,
      origDayIdx: +colEl.dataset.day,
      origTop:    parseFloat(el.style.top),
      origHeight: parseFloat(el.style.height),
      offsetY: e.clientY - rect.top,
      curDayIdx: +colEl.dataset.day,
    }

  } else if (p.type === 'resize') {
    p.el.classList.add('resizing')
    document.body.classList.add('resize-active')
    _drag = p

  } else if (p.type === 'draw') {
    const ghost = document.createElement('div')
    ghost.className = 'draw-selection'
    Object.assign(ghost.style, {
      top: `${p.startMin}px`, height: '15px',
      left: '2px', right: '14px', pointerEvents: 'none',
    })
    p.col.appendChild(ghost)
    document.body.classList.add('drag-active')
    _drag = { type: 'draw', col: p.col, dayIdx: p.dayIdx, startMin: p.startMin, ghost }
  }
}

// ── Live update handlers ──────────────────────────────────────────────────────

function _moveMove(e) {
  const { ghost, offsetY, origHeight } = _drag
  const rawMin = yToMin(e.clientY) - offsetY
  const newTop = Math.max(0, Math.min(1440 - origHeight - 2, snap(rawMin)))

  const di = xToDayIdx(e.clientX)
  if (di !== null) _drag.curDayIdx = di

  const col = document.querySelector(`.timed-col[data-day="${_drag.curDayIdx}"]`)
  const tc  = document.getElementById('timed-cols')
  if (col && tc) {
    const cr = col.getBoundingClientRect()
    const tr = tc.getBoundingClientRect()
    Object.assign(ghost.style, {
      left:  `${cr.left}px`,
      width: `${cr.width - 16}px`,
      top:   `${tr.top + newTop}px`,
    })
  }
}

function _resizeMove(e) {
  const { el, startY, origHeight, origTop } = _drag
  const newH = Math.max(13, snap(origHeight + (e.clientY - startY)))
  el.style.height = `${newH}px`
  const endMin = Math.min(1439, origTop + newH + 2)
  const te = el.querySelector('.event-time')
  if (te) {
    const sh = Math.floor(origTop/60), sm = origTop % 60
    const eh = Math.floor(endMin/60) % 24, em = endMin % 60
    te.textContent = `${pad(sh)}:${pad(sm)} – ${pad(eh)}:${pad(em)}`
  }
}

function _drawMove(e) {
  const { ghost, startMin } = _drag
  const cur = snap(yToMin(e.clientY))
  const top = Math.min(startMin, cur)
  const h   = Math.max(15, Math.abs(cur - startMin))
  ghost.style.top    = `${top}px`
  ghost.style.height = `${h}px`
  const endMin = Math.min(1439, top + h)
  ghost.textContent = `${pad(Math.floor(top/60))}:${pad(top%60)} – ${pad(Math.floor(endMin/60)%24)}:${pad(endMin%60)}`
}

// ── Mouseup ───────────────────────────────────────────────────────────────────

async function _onUp(e) {
  if (_pending) {
    _pending = null
    return  // no drag — let click event propagate normally
  }
  if (!_drag) return

  _suppress = true
  const drag = _drag
  _drag = null
  _cleanup(drag)

  if (drag.type === 'move')   await _finishMove(drag, e)
  if (drag.type === 'resize') await _finishResize(drag, e)
  if (drag.type === 'draw')   _finishDraw(drag, e)
}

function _cleanup(drag) {
  if (!drag) return
  drag.ghost?.remove()
  if (drag.el) {
    drag.el.classList.remove('drag-placeholder', 'resizing')
    drag.el.style.pointerEvents = ''
  }
  document.body.classList.remove('drag-active', 'resize-active')
}

// ── Finishers ─────────────────────────────────────────────────────────────────

async function _finishMove(drag, e) {
  const { item, el, colEl, origTop, origHeight, origDayIdx, curDayIdx, offsetY } = drag
  const rawMin    = yToMin(e.clientY) - offsetY
  const newTopMin = Math.max(0, Math.min(1440 - origHeight - 2, snap(rawMin)))

  if (newTopMin === origTop && curDayIdx === origDayIdx) return

  // Optimistic DOM update so there's no flash before the re-render
  const newCol = document.querySelector(`.timed-col[data-day="${curDayIdx}"]`)
  if (newCol && newCol !== colEl) newCol.appendChild(el)
  el.style.top = `${newTopMin}px`

  const dur      = item.end - item.start
  const newStart = dateAt(curDayIdx, newTopMin)
  const newEnd   = new Date(newStart.getTime() + dur)
  const tz       = Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    const token = await getToken()
    if (token) await updateEvent(token, item.source.account_id, item.source.external_id, {
      start: { dateTime: fmtDT(newStart), timeZone: tz },
      end:   { dateTime: fmtDT(newEnd),   timeZone: tz },
    })
  } catch (err) { console.error('Event move failed:', err) }
  _cbs.onRefresh?.()
}

async function _finishResize(drag, e) {
  const { item, el, origTop, origHeight, startY } = drag
  const newH = Math.max(13, snap(origHeight + (e.clientY - startY)))
  if (newH === origHeight) return
  const colEl  = el.closest('.timed-col')
  const dayIdx = colEl ? +colEl.dataset.day : 0
  const endMin = Math.min(1439, origTop + newH + 2)
  const newEnd = dateAt(dayIdx, endMin)
  const tz     = Intl.DateTimeFormat().resolvedOptions().timeZone
  try {
    const token = await getToken()
    if (token) await updateEvent(token, item.source.account_id, item.source.external_id, {
      end: { dateTime: fmtDT(newEnd), timeZone: tz },
    })
  } catch (err) { console.error('Event resize failed:', err) }
  _cbs.onRefresh?.()
}

function _finishDraw(drag, e) {
  const { dayIdx, startMin } = drag
  const cur     = snap(yToMin(e.clientY))
  const top     = Math.min(startMin, cur)
  const h       = Math.max(15, Math.abs(cur - startMin))
  const endMin  = Math.min(1439, top + h)
  const d = new Date(_weekStart); d.setDate(d.getDate() + dayIdx)
  _cbs.onDrawCreate?.({
    date:      d.toLocaleDateString('en-CA'),
    startTime: `${pad(Math.floor(top/60))}:${pad(top%60)}`,
    endTime:   `${pad(Math.floor(endMin/60)%24)}:${pad(endMin%60)}`,
  })
}
