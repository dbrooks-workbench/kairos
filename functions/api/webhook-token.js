// GET /api/webhook-token
//
// Returns the caller's webhook token (creating one if none exists).
// The token is stored in SESSIONS KV under wt:{token} -> sessionId so that
// /api/complete can validate it without a browser cookie.
// Requires the kairos_session cookie (same auth as /auth/refresh).

export async function onRequestGet(context) {
  const { request, env } = context

  const sessionId = _sessionId(request)
  if (!sessionId) return _json({ error: 'no_session' }, 401)

  const session = await env.SESSIONS.get(sessionId, 'json')
  if (!session) return _json({ error: 'session_expired' }, 401)

  const primary = _primaryAccount(session)
  if (!primary) return _json({ error: 'no_account' }, 401)

  // Return the existing webhook token if already minted.
  if (primary.webhookToken) {
    return _json({ token: primary.webhookToken })
  }

  // Generate a new 24-byte hex token (192 bits of entropy).
  const token = _randomHex(24)
  const ttl   = 60 * 60 * 24 * 365

  // wt:{token} → sessionId so /api/complete can reverse-lookup the session.
  await env.SESSIONS.put(`wt:${token}`, sessionId, { expirationTtl: ttl })

  // Persist the token on the primary account so the same token is reused.
  primary.webhookToken = token
  await env.SESSIONS.put(sessionId, JSON.stringify(session), { expirationTtl: ttl })

  return _json({ token })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sessionId(request) {
  const cookie = request.headers.get('Cookie') ?? ''
  const match  = cookie.match(/(?:^|;\s*)kairos_session=([^;]+)/)
  return match?.[1] ?? null
}

function _primaryAccount(session) {
  if (Array.isArray(session.accounts)) {
    return session.accounts.find(a => a.primary) ?? session.accounts[0] ?? null
  }
  // Legacy single-account shape
  return session.refreshToken ? session : null
}

function _randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
