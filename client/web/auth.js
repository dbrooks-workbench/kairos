let _token = null
let _tokenExpiresAt = 0

export async function getToken() {
  if (_token && Date.now() < _tokenExpiresAt) return _token

  const res = await fetch('/auth/refresh')
  if (!res.ok) return null

  const { access_token } = await res.json()
  _token = access_token
  _tokenExpiresAt = Date.now() + 55 * 60 * 1000 // treat as valid for 55 min
  return _token
}

export async function isAuthenticated() {
  return (await getToken()) !== null
}

export async function logout() {
  _token = null
  _tokenExpiresAt = 0
  await fetch('/auth/logout', { method: 'POST' })
  window.location.reload()
}

export function loginUrl() {
  return '/auth/start'
}
