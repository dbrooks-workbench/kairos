// GET /api/calendar-poll
//
// Lightweight KV read the browser calls every 20 s to detect external calendar changes.
// Returns { changedAt, watchExpiry }:
//   changedAt   — Unix ms of the most recent change notification (null = none yet)
//   watchExpiry — Unix ms of the soonest watch channel expiry (null = no watches stored)
//
// The browser compares changedAt against its last-refreshed timestamp; if newer,
// it triggers a fetchDelta() call. watchExpiry drives watch renewal.

export async function onRequestGet(context) {
  const { request, env } = context

  const sessionId = _sessionId(request)
  if (!sessionId) return _json({ error: 'no_session' }, 401)

  const [changedAtVal, watchesVal] = await Promise.all([
    env.SESSIONS.get(`cal:changedAt:${sessionId}`),
    env.SESSIONS.get(`cal:watches:${sessionId}`),
  ])

  const changedAt = changedAtVal ? parseInt(changedAtVal, 10) : null

  let watchExpiry = null
  if (watchesVal) {
    try {
      const watches = JSON.parse(watchesVal)
      if (watches.length) watchExpiry = Math.min(...watches.map(w => w.expiration))
    } catch {}
  }

  return _json({ changedAt, watchExpiry })
}

function _sessionId(request) {
  const cookie = request.headers.get('Cookie') ?? ''
  const match  = cookie.match(/(?:^|;\s*)kairos_session=([^;]+)/)
  return match?.[1] ?? null
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
