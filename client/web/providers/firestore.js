// Low-level Firestore REST client.
// Project is read from /config (a Pages Function that serves GOOGLE_PROJECT_ID from env).
// All functions throw on non-404 HTTP errors — callers should catch.

import { GOOGLE_PROJECT_ID } from '/config'

function _base() {
  if (!GOOGLE_PROJECT_ID) throw new Error('GOOGLE_PROJECT_ID not set — add it to Cloudflare env vars and re-deploy')
  return `https://firestore.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/databases/(default)/documents`
}

// ── Value encoding ────────────────────────────────────────────────────────────

function _toVal(v) {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'boolean')        return { booleanValue: v }
  if (typeof v === 'number')         return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  if (typeof v === 'string')         return { stringValue: v }
  if (Array.isArray(v))              return { arrayValue: { values: v.map(_toVal) } }
  if (typeof v === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(v).filter(([, val]) => val !== undefined).map(([k, val]) => [k, _toVal(val)])
        ),
      },
    }
  }
  return { stringValue: String(v) }
}

function _fromVal(fsv) {
  if (!fsv) return null
  if ('nullValue'      in fsv) return null
  if ('booleanValue'   in fsv) return fsv.booleanValue
  if ('integerValue'   in fsv) return Number(fsv.integerValue)
  if ('doubleValue'    in fsv) return fsv.doubleValue
  if ('stringValue'    in fsv) return fsv.stringValue
  if ('timestampValue' in fsv) return fsv.timestampValue
  if ('arrayValue'     in fsv) return (fsv.arrayValue.values ?? []).map(_fromVal)
  if ('mapValue'       in fsv) {
    return Object.fromEntries(
      Object.entries(fsv.mapValue.fields ?? {}).map(([k, v]) => [k, _fromVal(v)])
    )
  }
  return null
}

function _toDoc(obj) {
  return {
    fields: Object.fromEntries(
      Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, _toVal(v)])
    ),
  }
}

function _fromDoc(doc) {
  if (!doc?.fields) return {}
  return Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, _fromVal(v)]))
}

// ── REST helpers ──────────────────────────────────────────────────────────────

// GET a document by path (e.g. 'prefs/main'). Returns null on 404.
export async function fsGet(token, path) {
  const res = await fetch(`${_base()}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Firestore GET ${path}: ${res.status} ${await res.text().catch(() => '')}`)
  return _fromDoc(await res.json())
}

// SET (full replace) a document by path. Creates if not exists.
export async function fsSet(token, path, data, { keepalive = false } = {}) {
  const res = await fetch(`${_base()}/${path}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(_toDoc(data)),
    keepalive,
  })
  if (!res.ok) throw new Error(`Firestore SET ${path}: ${res.status} ${await res.text().catch(() => '')}`)
  return _fromDoc(await res.json())
}

// CREATE a document with an auto-generated ID in a collection.
// Returns the stored data plus _id (the Firestore-assigned document ID).
export async function fsAdd(token, collection, data) {
  const res = await fetch(`${_base()}/${collection}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(_toDoc(data)),
  })
  if (!res.ok) throw new Error(`Firestore ADD ${collection}: ${res.status} ${await res.text().catch(() => '')}`)
  const doc = await res.json()
  return { _id: doc.name.split('/').pop(), ..._fromDoc(doc) }
}

// DELETE a document by path. 404 is treated as success (already gone).
export async function fsDelete(token, path) {
  const res = await fetch(`${_base()}/${path}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Firestore DELETE ${path}: ${res.status} ${await res.text().catch(() => '')}`)
  }
}

// LIST all documents in a collection (auto-paginates).
// Each returned object has an extra `_id` field containing the Firestore document ID.
export async function fsList(token, collection) {
  const docs = []
  let pageToken = null
  do {
    const url = new URL(`${_base()}/${collection}`)
    url.searchParams.set('pageSize', '300')
    if (pageToken) url.searchParams.set('pageToken', pageToken)
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 404) return []   // collection doesn't exist yet
    if (!res.ok) throw new Error(`Firestore LIST ${collection}: ${res.status} ${await res.text().catch(() => '')}`)
    const body = await res.json()
    for (const doc of body.documents ?? []) {
      docs.push({ _id: doc.name.split('/').pop(), ..._fromDoc(doc) })
    }
    pageToken = body.nextPageToken ?? null
  } while (pageToken)
  return docs
}

// BATCH SET up to 500 documents. writes = [{ path, data }]
export async function fsBatchWrite(token, writes) {
  if (!writes.length) return
  // Document name in the request body must be the resource path (no https:// prefix),
  // e.g. "projects/my-proj/databases/(default)/documents/tasks/abc123"
  const resourceBase = `projects/${GOOGLE_PROJECT_ID}/databases/(default)/documents`
  const body = {
    writes: writes.map(({ path, data }) => ({
      update: { name: `${resourceBase}/${path}`, ..._toDoc(data) },
    })),
  }
  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/databases/(default)/documents:batchWrite`,
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }
  )
  if (!res.ok) throw new Error(`Firestore batchWrite: ${res.status} ${await res.text().catch(() => '')}`)
}
