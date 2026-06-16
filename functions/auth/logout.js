export async function onRequestPost(context) {
  const { request, env } = context
  const url       = new URL(request.url)
  const accountId = url.searchParams.get('account')  // omit to sign out entirely
  const cookies   = parseCookies(request.headers.get('Cookie') || '')
  const sessionId = cookies['kairos_session']

  if (sessionId) {
    const session = await env.SESSIONS.get(sessionId, 'json')
    if (session) {
      const accounts = migrateSession(session)

      if (accountId) {
        // Remove a single secondary account; keep the session if the primary remains.
        const target = accounts.find(a => a.id === accountId)
        if (target?.refreshToken) {
          await fetch(
            `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(target.refreshToken)}`,
            { method: 'POST' }
          ).catch(() => {})
        }
        const remaining = accounts.filter(a => a.id !== accountId)
        if (remaining.length > 0) {
          await env.SESSIONS.put(
            sessionId,
            JSON.stringify({ accounts: remaining }),
            { expirationTtl: 60 * 60 * 24 * 365 }
          )
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
        // Last account removed — fall through to full teardown
      } else {
        // Revoke all refresh tokens
        await Promise.all(accounts.map(a =>
          a.refreshToken
            ? fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refreshToken)}`,
                { method: 'POST' }).catch(() => {})
            : Promise.resolve()
        ))
      }

      await env.SESSIONS.delete(sessionId)
    }
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `kairos_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
    },
  })
}

function migrateSession(session) {
  if (Array.isArray(session.accounts)) return session.accounts
  if (session.refreshToken) return [{ id: 'legacy', email: null, primary: true, ...session }]
  return []
}

function parseCookies(header) {
  return Object.fromEntries(
    header.split(';')
      .map(c => c.trim().split('='))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k.trim(), v.join('=').trim()])
  )
}
