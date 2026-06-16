let _accounts  = null   // null = not yet fetched; [] = fetched, none connected
let _expiresAt = 0

async function fetchAccounts() {
  try {
    const res = await fetch('/auth/refresh')
    if (!res.ok) { _accounts = []; return }
    const data = await res.json()
    if (data.accounts) {
      _accounts = data.accounts.map(a => ({
        id:      a.id,
        email:   a.email,
        primary: a.primary ?? false,
        token:   a.access_token,
      }))
      // Guarantee at least one primary (guards against migration edge cases)
      if (_accounts.length && !_accounts.some(a => a.primary)) {
        _accounts[0].primary = true
      }
    } else if (data.access_token) {
      // Backward-compat with old single-token refresh response
      _accounts = [{ id: 'default', email: null, primary: true, token: data.access_token }]
    } else {
      _accounts = []
    }
  } catch {
    _accounts = []
  }
  _expiresAt = Date.now() + 55 * 60 * 1000
}

function invalidateCache() { _accounts = null; _expiresAt = 0 }

// All connected accounts as [{ id, email, primary, token }].
export async function getTokens() {
  if (_accounts !== null && Date.now() < _expiresAt) return _accounts
  await fetchAccounts()
  return _accounts
}

// Primary account's token — used by all data-fetching and mutation code.
export async function getToken() {
  const accounts = await getTokens()
  return accounts.find(a => a.primary)?.token ?? accounts[0]?.token ?? null
}

export async function isAuthenticated() {
  return (await getTokens()).length > 0
}

// Navigate to Google OAuth to connect a secondary account.
export function addAccount() {
  window.location.href = '/auth/start?add_account=1'
}

// Remove a single account by ID (revokes its token server-side then reloads).
export async function logoutAccount(id) {
  invalidateCache()
  await fetch(`/auth/logout?account=${encodeURIComponent(id)}`, { method: 'POST' })
  window.location.reload()
}

export async function logout() {
  invalidateCache()
  await fetch('/auth/logout', { method: 'POST' })
  window.location.reload()
}

export function loginUrl() {
  return '/auth/start'
}
