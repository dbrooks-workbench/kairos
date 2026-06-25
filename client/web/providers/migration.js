// One-time migration: Google Drive appDataFolder JSON files → Firestore.
// Called by loadPrefs (drivePrefs.js) when prefs/main doesn't exist in Firestore.
// Idempotent — each write is a full document replace, safe to run twice.
//
// What migrates:
//   kairos-prefs.json         → prefs/main   (caller writes this after migration returns)
//   kairos-tasks.json         → tasks/{kid}
//   kairos-tasks-archive.json → tasks/{kid}  (same collection, archivedAt field set)
//   kairos-event-tasks.json   → events/{eventId}
//
// The Sheets life log is NOT migrated — it stays in Google Sheets and grows there.

import { fsSet } from './firestore.js'

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'

async function _readDriveFile(token, name) {
  try {
    const q      = encodeURIComponent(`name='${name}'`)
    const search = await fetch(
      `${DRIVE_BASE}/files?spaces=appDataFolder&q=${q}&fields=files(id)`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!search.ok) return null
    const { files } = await search.json()
    if (!files?.length) return null
    const data = await fetch(`${DRIVE_BASE}/files/${files[0].id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!data.ok) return null
    return await data.json()
  } catch {
    return null
  }
}

export async function runMigration(token) {
  console.log('[migration] Starting Drive → Firestore migration')

  const [drivePrefs, driveTasks, driveArchive, driveEvents] = await Promise.all([
    _readDriveFile(token, 'kairos-prefs.json'),
    _readDriveFile(token, 'kairos-tasks.json'),
    _readDriveFile(token, 'kairos-tasks-archive.json'),
    _readDriveFile(token, 'kairos-event-tasks.json'),
  ])

  // Active task records (kairos-tasks.json)
  if (driveTasks?.tasks) {
    const entries = Object.entries(driveTasks.tasks)
    console.log(`[migration] Migrating ${entries.length} active task records`)
    for (const [kid, record] of entries) {
      // Strip fields removed in v0.17.1 (recurrence, comments)
      const { recurrence, comments, ...clean } = record
      await fsSet(token, `tasks/${kid}`, clean)
    }
  }

  // Archived task records (kairos-tasks-archive.json)
  if (driveArchive?.tasks) {
    const entries = Object.entries(driveArchive.tasks)
    console.log(`[migration] Migrating ${entries.length} archived task records`)
    for (const [kid, record] of entries) {
      const { recurrence, comments, ...clean } = record
      await fsSet(token, `tasks/${kid}`, clean)
    }
  }

  // Event completion records (kairos-event-tasks.json)
  if (driveEvents?.events) {
    const entries = Object.entries(driveEvents.events)
    console.log(`[migration] Migrating ${entries.length} event records`)
    for (const [eventId, record] of entries) {
      await fsSet(token, `events/${_safeId(eventId)}`, record)
    }
  }

  console.log('[migration] Drive → Firestore migration complete')
  return drivePrefs   // caller merges into prefs/main and writes it
}

// Firestore document IDs must not contain '/'. Google Calendar event IDs are
// base32 alphanumeric with possible underscores — safe in practice, but
// replace any slash just in case.
function _safeId(id) {
  return id.replace(/\//g, '_sl_')
}
