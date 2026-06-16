let _accounts  = null   // null = not yet fetched; [] = fetched, none connected
let _expiresAt = 0

async function fetchAccounts() {
  try {
    const res = await fetch('/auth/refresh')
    if (!res.ok) { _accounts = []; return }
    const data = await res.json()
    if (data.accounts) {
      _accounts = data.accounts.map(a => ({ id: a.id, email: a.email, token: a.access_token }))
    } else if (data.access_token) {
      // Backward-compat with old single-token refresh response
      _accounts = [{ id: 'default', email: null, token: data.access_token }]
    } else {
      _accounts = []
    }
  } catch {
    _accounts = []
  }
  _expiresAt = Date.now() + 55 * 60 * 1000
}

function invalidateCache() { _accounts = null; _expiresAt = 0 }

// Returns all connected accounts as [{ id, email, token }].
export async function getTokens() {
  if (_accounts !== null && Date.now() < _expiresAt) return _accounts
  await fetchAccounts()
  return _accounts
}

// Convenience: first account's token (used by callers that operate on a single token).
export async function getToken() {
  const accounts = await getTokens()
  return accounts[0]?.token ?? null
}

// Lookup the token for a specific owner account (e.g. from item.source.owner_account).
export async function getTokenFor(ownerId) {
  const accounts = await getTokens()
  return accounts.find(a => a.id === ownerId)?.token ?? accounts[0]?.token ?? null
}

export async function isAuthenticated() {
  return (await getTokens()).length > 0
}

// Navigate to Google OAuth to connect an additional account.
// The existing session is preserved and the new account is appended.
export function addAccount() {
  window.location.href = '/auth/start?add_account=1'
}

// Disconnect a single account by ID; reloads after removal.
export async function logoutAccount(id) {
  invalidateCache()
  await fetch(`/auth/logout?account=${encodeURIComponent(id)}`, { method: 'POST' })
  window.location.reload()
}

// Sign out of all accounts.
export async function logout() {
  invalidateCache()
  await fetch('/auth/logout', { method: 'POST' })
  window.location.reload()
}

export function loginUrl() {
  return '/auth/start'
}
