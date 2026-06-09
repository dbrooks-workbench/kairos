export async function onRequestGet(context) {
  const { request, env } = context
  const cookies = parseCookies(request.headers.get('Cookie') || '')
  const sessionId = cookies['kairos_session']

  if (!sessionId) return jsonRes({ error: 'no_session' }, 401)

  const session = await env.SESSIONS.get(sessionId, 'json')
  if (!session) return jsonRes({ error: 'session_expired' }, 401)

  if (session.accessToken && session.expiresAt > Date.now()) {
    return jsonRes({ access_token: session.accessToken })
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: session.refreshToken,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })

  if (!tokenRes.ok) {
    await env.SESSIONS.delete(sessionId)
    return jsonRes({ error: 'refresh_failed' }, 401)
  }

  const tokens = await tokenRes.json()
  const ttl = 60 * 60 * 24 * 365

  await env.SESSIONS.put(sessionId, JSON.stringify({
    ...session,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
  }), { expirationTtl: ttl })

  return jsonRes({ access_token: tokens.access_token })
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parseCookies(header) {
  return Object.fromEntries(
    header.split(';')
      .map(c => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k.trim(), v.join('=').trim()])
  )
}
