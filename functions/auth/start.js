export async function onRequestGet(context) {
  const { request, env } = context
  const url        = new URL(request.url)
  const addAccount = url.searchParams.get('add_account') === '1'

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return new Response(
      'Server misconfiguration: GOOGLE_CLIENT_ID and/or GOOGLE_CLIENT_SECRET are not set.',
      { status: 500, headers: { 'Content-Type': 'text/plain' } }
    )
  }

  const codeVerifier  = generateCodeVerifier()
  const codeChallenge = await generateCodeChallenge(codeVerifier)
  const state         = crypto.randomUUID()

  // When adding a secondary account, carry the existing session ID through
  // the PKCE entry so the callback can append rather than replace.
  let existingSessionId = null
  if (addAccount) {
    const cookies = parseCookies(request.headers.get('Cookie') || '')
    existingSessionId = cookies['kairos_session'] ?? null
  }

  await env.SESSIONS.put(`pkce:${state}`, JSON.stringify({
    codeVerifier,
    ...(existingSessionId ? { existingSessionId } : {}),
  }), { expirationTtl: 300 })

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     env.GOOGLE_CLIENT_ID,
    redirect_uri:  `${url.origin}/auth/callback`,
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks',
    access_type: 'offline',
    // Force account picker + consent so the user can choose a different account
    // and we always receive a fresh refresh token.
    prompt: addAccount ? 'select_account consent' : 'consent',
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
    state,
  })

  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, 302)
}

function generateCodeVerifier() {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return base64urlEncode(array)
}

async function generateCodeChallenge(verifier) {
  const data   = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return base64urlEncode(new Uint8Array(digest))
}

function base64urlEncode(array) {
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function parseCookies(header) {
  return Object.fromEntries(
    header.split(';')
      .map(c => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k.trim(), v.join('=').trim()])
  )
}
