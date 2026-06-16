export async function onRequestGet(context) {
  const { request, env } = context
  const cookies   = parseCookies(request.headers.get('Cookie') || '')
  const sessionId = cookies['kairos_session']

  if (!sessionId) return jsonRes({ error: 'no_session' }, 401)

  const session = await env.SESSIONS.get(sessionId, 'json')
  if (!session)  return jsonRes({ error: 'session_expired' }, 401)

  const accounts = migrateSession(session)
  if (!accounts.length) return jsonRes({ error: 'no_accounts' }, 401)

  const ttl      = 60 * 60 * 24 * 365
  const refreshed = []
  let dirty = !Array.isArray(session.accounts)  // migration itself is a dirty write

  for (const account of accounts) {
    if (account.accessToken && account.expiresAt > Date.now()) {
      refreshed.push(account)
      continue
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: account.refreshToken,
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type:    'refresh_token',
      }),
    })

    if (!tokenRes.ok) {
      console.error(`Failed to refresh token for ${account.id}`)
      continue  // drop this account from the response but keep it in KV
    }

    const tokens = await tokenRes.json()
    let email = account.email

    // Migrate legacy accounts that have no email by fetching userinfo
    if (!email) {
      try {
        const ui = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        })
        email = (await ui.json()).email ?? null
      } catch {}
    }

    refreshed.push({
      ...account,
      email,
      id:          email ?? account.id,
      accessToken: tokens.access_token,
      expiresAt:   Date.now() + (tokens.expires_in - 60) * 1000,
    })
    dirty = true
  }

  if (dirty) {
    await env.SESSIONS.put(sessionId, JSON.stringify({ accounts: refreshed }), { expirationTtl: ttl })
  }

  return jsonRes({
    accounts: refreshed.map(a => ({
      id:           a.id,
      email:        a.email,
      access_token: a.accessToken,
    }))
  })
}

function migrateSession(session) {
  if (Array.isArray(session.accounts)) return [...session.accounts]
  if (session.refreshToken) return [{ id: session.email ?? 'legacy', email: session.email ?? null, ...session }]
  return []
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
