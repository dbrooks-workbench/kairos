export async function onRequestGet(context) {
  const { request, env } = context
  const url  = new URL(request.url)
  const code  = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error || !code || !state) {
    return Response.redirect(`${url.origin}/?auth_error=1`, 302)
  }

  const pkceRaw = await env.SESSIONS.get(`pkce:${state}`)
  await env.SESSIONS.delete(`pkce:${state}`)

  if (!pkceRaw) {
    return Response.redirect(`${url.origin}/?auth_error=1`, 302)
  }

  // PKCE entry is JSON (new) or a plain string (legacy first-login before this change)
  let codeVerifier, existingSessionId = null
  try {
    const pkce     = JSON.parse(pkceRaw)
    codeVerifier   = pkce.codeVerifier
    existingSessionId = pkce.existingSessionId ?? null
  } catch {
    codeVerifier = pkceRaw
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  `${url.origin}/auth/callback`,
      grant_type:    'authorization_code',
      code_verifier: codeVerifier,
    }),
  })

  if (!tokenRes.ok) {
    return Response.redirect(`${url.origin}/?auth_error=1`, 302)
  }

  const tokens   = await tokenRes.json()
  const email    = extractEmail(tokens.id_token)
  const accountId = email ?? crypto.randomUUID()
  const ttl = 60 * 60 * 24 * 365

  const newAccount = {
    id:           accountId,
    email,
    refreshToken: tokens.refresh_token,
    accessToken:  tokens.access_token,
    expiresAt:    Date.now() + (tokens.expires_in - 60) * 1000,
  }

  let sessionId, sessionData

  if (existingSessionId) {
    const existing = await env.SESSIONS.get(existingSessionId, 'json')
    if (existing) {
      sessionId = existingSessionId
      const accounts = migrateSession(existing)
      const idx = accounts.findIndex(a => a.id === accountId)
      if (idx >= 0) accounts[idx] = { ...accounts[idx], ...newAccount }
      else accounts.push(newAccount)
      sessionData = { accounts }
    }
  }

  if (!sessionData) {
    sessionId   = crypto.randomUUID()
    sessionData = { accounts: [newAccount] }
  }

  await env.SESSIONS.put(sessionId, JSON.stringify(sessionData), { expirationTtl: ttl })

  const headers = new Headers({ Location: url.origin })
  headers.append('Set-Cookie',
    `kairos_session=${sessionId}; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttl}; Path=/`)

  return new Response(null, { status: 302, headers })
}

// Extract email from Google's id_token (JWT) without full signature verification —
// the token arrived directly over HTTPS from Google's token endpoint so trust is established.
function extractEmail(idToken) {
  if (!idToken) return null
  try {
    const b64 = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64))
    return payload.email ?? null
  } catch { return null }
}

// Migrate old single-account session shape to the new accounts array.
function migrateSession(session) {
  if (Array.isArray(session.accounts)) return [...session.accounts]
  if (session.refreshToken) return [{ id: session.email ?? 'legacy', email: session.email ?? null, ...session }]
  return []
}
