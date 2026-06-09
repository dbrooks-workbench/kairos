export async function onRequestPost(context) {
  const { request, env } = context
  const cookies = parseCookies(request.headers.get('Cookie') || '')
  const sessionId = cookies['kairos_session']

  if (sessionId) {
    const session = await env.SESSIONS.get(sessionId, 'json')
    if (session?.refreshToken) {
      await fetch(
        `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(session.refreshToken)}`,
        { method: 'POST' }
      ).catch(() => {})
    }
    await env.SESSIONS.delete(sessionId)
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `kairos_session=; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Path=/`,
    },
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
