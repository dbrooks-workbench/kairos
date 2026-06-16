export async function onRequestGet(context) {
  const { request, env } = context
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error || !code || !state) {
    return Response.redirect(`${url.origin}/?auth_error=1`, 302)
  }

  const codeVerifier = await env.SESSIONS.get(`pkce:${state}`)
  await env.SESSIONS.delete(`pkce:${state}`)

  if (!codeVerifier) {
    return Response.redirect(`${url.origin}/?auth_error=1`, 302)
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/auth/callback`,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenRes.ok) {
    return Response.redirect(`${url.origin}/?auth_error=1`, 302)
  }

  const tokens = await tokenRes.json()
  const sessionId = crypto.randomUUID()
  const ttl = 60 * 60 * 24 * 365

  await env.SESSIONS.put(sessionId, JSON.stringify({
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
  }), { expirationTtl: ttl })

  const headers = new Headers({ Location: url.origin })
  headers.append('Set-Cookie', `kairos_session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}; Path=/`)

  return new Response(null, { status: 302, headers })
}
