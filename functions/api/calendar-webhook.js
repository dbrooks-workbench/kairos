// POST /api/calendar-webhook
//
// Receives Google Calendar push notifications (events.watch).
// On change: writes a changedAt timestamp to KV so the browser poll detects it.
//
// Auth: X-Goog-Channel-Token header (the user's webhook token, validated via KV
//       the same way /api/complete validates completion-link tokens).
// Google sends two resource states:
//   'sync'   — initial verification ping when a watch is registered; acknowledge only.
//   'exists' — an event was created, updated, or deleted; write the flag.

export async function onRequestPost(context) {
  const { request, env } = context

  const token = request.headers.get('X-Goog-Channel-Token')
  const state = request.headers.get('X-Goog-Resource-State')

  if (!token) return new Response('', { status: 400 })

  // Validate: wt:{token} → sessionId (same KV structure as completion-link tokens)
  const sessionId = await env.SESSIONS.get(`wt:${token}`)
  if (!sessionId) return new Response('', { status: 401 })

  // Handshake ping — just acknowledge
  if (state === 'sync') return new Response('', { status: 200 })

  // Change notification — set the flag; browser poll picks it up within 20 s
  await env.SESSIONS.put(`cal:changedAt:${sessionId}`, String(Date.now()), { expirationTtl: 86400 })

  return new Response('', { status: 200 })
}
