// GET /api/complete?kairosId=xxx&wt=yyy
//
// Native-client completion endpoint. Included as a link in the mark-done
// footer written to dated task event descriptions so that users can complete
// tasks directly from Google Calendar without opening the Kairos SPA.
//
// Auth: webhook token (wt param) — no browser cookie required.
// Flow: wt → sessionId (KV), sessionId → refreshToken (KV), refreshToken → accessToken (Google)

const GCAL_BASE  = 'https://www.googleapis.com/calendar/v3'
const TOKEN_URL  = 'https://oauth2.googleapis.com/token'

export async function onRequestGet(context) {
  const { request, env } = context
  const url      = new URL(request.url)
  const kairosId = url.searchParams.get('kairosId')
  const wt       = url.searchParams.get('wt')

  if (!kairosId || !wt) {
    return _html('Invalid request', 'Missing required parameters.')
  }

  try {
    // Validate webhook token → sessionId
    const sessionId = await env.SESSIONS.get(`wt:${wt}`)
    if (!sessionId) return _html('Unauthorised', 'Invalid or expired completion link.')

    // Get session → primary refresh token
    const session = await env.SESSIONS.get(sessionId, 'json')
    const primary = _primaryAccount(session)
    const refreshToken = primary?.refreshToken
    if (!refreshToken) {
      return _html('Session expired', 'Please sign in to Kairos again to re-authorise.')
    }

    // Exchange refresh token for a fresh access token
    const accessToken = await _refreshAccessToken(refreshToken, env)

    // Find the event across all writable calendars
    const found = await _findByKairosId(accessToken, kairosId)
    if (!found) {
      return _html('Task not found', 'This task may have been deleted or moved to a different account.')
    }

    // Already complete?
    const alreadyDone = found.event.extendedProperties?.private?.completedAt
    if (alreadyDone) {
      const when = new Date(alreadyDone).toLocaleDateString(undefined, { dateStyle: 'medium' })
      return _html('Already done ✓', `This task was marked as complete on ${when}.`)
    }

    // Mark complete via extendedProperties.private.completedAt
    await _markComplete(accessToken, found.calendarId, found.event.id)

    const title = found.event.summary ?? 'Task'
    return _html('Done ✓', `"${_esc(title)}" has been marked as complete.`)

  } catch (err) {
    console.error('[/api/complete]', err)
    return _html('Error', 'Something went wrong. Please try again or use the Kairos app.')
  }
}

// ── Google API calls ──────────────────────────────────────────────────────────

async function _refreshAccessToken(refreshToken, env) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
    }),
  })
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`)
  return (await res.json()).access_token
}

async function _findByKairosId(accessToken, kairosId) {
  const headers = { Authorization: `Bearer ${accessToken}` }

  // Fetch all calendars the user can write to
  const calRes = await fetch(`${GCAL_BASE}/users/me/calendarList?maxResults=250`, { headers })
  if (!calRes.ok) throw new Error(`CalendarList: ${calRes.status}`)
  const calendars = ((await calRes.json()).items ?? [])
    .filter(c => c.accessRole === 'owner' || c.accessRole === 'writer')

  // Search each calendar for the event matching kairosId
  const params = new URLSearchParams({
    privateExtendedProperty: `kairosId=${kairosId}`,
    maxResults: '1',
  })
  for (const cal of calendars) {
    const res = await fetch(
      `${GCAL_BASE}/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
      { headers }
    )
    if (!res.ok) continue
    const data = await res.json()
    if (data.items?.length) {
      return { calendarId: cal.id, event: data.items[0] }
    }
  }
  return null
}

async function _markComplete(accessToken, calendarId, eventId) {
  const res = await fetch(
    `${GCAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method:  'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extendedProperties: { private: { completedAt: new Date().toISOString() } },
      }),
    }
  )
  if (!res.ok) throw new Error(`Mark complete failed: ${res.status}`)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _primaryAccount(session) {
  if (!session) return null
  if (Array.isArray(session.accounts)) {
    return session.accounts.find(a => a.primary) ?? session.accounts[0] ?? null
  }
  return session.refreshToken ? session : null
}

function _esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function _html(heading, body) {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${_esc(heading)} — Kairos</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f8f9fa; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 24px }
    .card { background: #fff; border-radius: 12px; padding: 36px 40px; max-width: 440px;
            width: 100%; box-shadow: 0 2px 12px rgba(0,0,0,.08); text-align: center }
    h1 { font-size: 1.5rem; font-weight: 600; color: #202124; margin-bottom: 10px }
    p  { color: #5f6368; font-size: 0.95rem; line-height: 1.5 }
  </style>
</head>
<body>
  <div class="card">
    <h1>${_esc(heading)}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`,
    { headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
  )
}
