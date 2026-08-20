// POST /api/save-watch
//
// Stores Google Calendar watch channel info in KV after the browser registers
// watches directly with the Calendar API. Used to track expiry and drive renewal.
//
// Body: { channels: [{ channelId, resourceId, calendarId, expiration }] }

export async function onRequestPost(context) {
  const { request, env } = context

  const sessionId = _sessionId(request)
  if (!sessionId) return _json({ error: 'no_session' }, 401)

  let channels
  try {
    ;({ channels } = await request.json())
    if (!Array.isArray(channels)) throw new Error('channels must be an array')
  } catch {
    return _json({ error: 'invalid_body' }, 400)
  }

  // TTL slightly longer than the longest possible watch (7 days + buffer)
  await env.SESSIONS.put(`cal:watches:${sessionId}`, JSON.stringify(channels), { expirationTtl: 60 * 60 * 24 * 8 })

  return _json({ ok: true })
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
