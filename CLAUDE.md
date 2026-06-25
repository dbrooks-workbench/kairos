# CLAUDE.md — Kairos
> Time-aware personal operating system with a calendar as the primary rendering surface.

**Name**: Kairos — from the Greek concept of *kairos* (καιρός), meaning the right or opportune moment. Distinct from *chronos* (clock time), kairos is time as experienced and acted upon. The name reflects the project's purpose: not just displaying time, but helping you act at the right time.

---

## Project Vision

A self-hosted, open-source **calendar aggregation and personal task management platform**. The calendar grid is the UI primitive — everything that is time-aware surfaces on it. Tasks, events, project milestones, habits, and future custom types all share a common temporal model and render contextually based on their type.

This is not a Google Calendar clone. It is a provider-agnostic aggregation layer with an extensible, type-driven interaction surface — with Google Calendar and Google Tasks as the first concrete provider implementations.

The project should be buildable by others, self-hostable with minimal friction, and extensible by the community.

---

## Ultimate Goal

A **personal project management / calendar hybrid** where:
- All time-aware data (tasks, events, deadlines, milestones) surfaces on a unified calendar view
- Each item type drives its own rendering and interaction surface (similar to how Google Calendar surfaces tasks differently than events)
- The system is provider-agnostic — Google is the first implementation, not the assumption
- The community can add new providers, event types, and interaction surfaces

---

## Architecture

### Layer Overview

```
┌──────────────────────────────────────────────────────────┐
│                  Cloudflare Pages                        │
│                                                          │
│  ┌─────────────────────┐   ┌──────────────────────────┐ │
│  │  Static SPA          │   │  Pages Functions         │ │
│  │  (client/web/)       │   │  (functions/auth/)       │ │
│  │                      │   │                          │ │
│  │  vanilla JS          │   │  /auth/start             │ │
│  │  week-view calendar  │   │  /auth/callback          │ │
│  │  Google API calls    │   │  /auth/refresh           │ │
│  └──────────┬───────────┘   │  /auth/logout            │ │
│             │               └────────────┬─────────────┘ │
│             │                            │               │
│             │               ┌────────────▼─────────────┐ │
│             │               │  Cloudflare KV           │ │
│             │               │  (session + token store) │ │
│             │               └──────────────────────────┘ │
└─────────────┼────────────────────────────────────────────┘
              │ direct API calls (Bearer token)
    ┌─────────▼──────────────────────────┐
    │  Google APIs                       │
    │  Calendar API v3  /  Tasks API v1  │
    └────────────────────────────────────┘
```

### Web SPA — Vanilla JS (`client/web/`)

- No framework, no build step — files served directly by Cloudflare Pages
- Custom calendar grid using CSS Grid and vanilla JS
- Calls Google Calendar and Tasks APIs directly from the browser using a Bearer token
- Token obtained by calling `/auth/refresh` (Pages Function); never stored in browser
- Rendering is type-driven: each item knows its `item_type`, driving visual treatment and interaction surface

### Auth — Cloudflare Pages Functions (`functions/auth/`)

- PKCE OAuth2 flow; client secret never exposed to the browser
- PKCE verifier stored temporarily in KV (5-minute TTL)
- Tokens stored in KV under a random session ID (1-year TTL)
- Session ID in an HttpOnly Secure cookie — JS cannot access tokens directly
- `/auth/refresh` returns a fresh access token to the SPA on demand

### Mobile — Flutter (Phase 2, deferred)

- Flutter app targeting iOS and Android
- Will call Google APIs directly with the same OAuth pattern

---

## Core Data Model

All time-aware data normalizes to a `CalendarItem` (JavaScript object):

```js
{
  id: string,
  title: string,
  item_type: 'EVENT' | 'TASK' | 'MILESTONE' | 'HABIT',
  source: { provider: string, account_id: string, external_id: string },
  start: Date,                // all-day items: midnight local time
  end: Date | null,
  due: Date | null,           // tasks with deadlines
  all_day: boolean,
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' | 'COMPLETED' | 'NEEDS_ACTION',
  recurrence: string | null,  // RRULE string (EVENT items only; TASK recurrence is in metadata)
  metadata: {                 // type-specific and derived fields
    body?: string,            // prose notes
    loe?: string,             // e.g. "2d 4h"
    comments?: [{timestamp, text}],
    checklist?: [{text, checked}],
    recurrence?: string,      // RRULE string for TASK items (stored in Drive, not notes)
    kid?: string,             // Kairos stable ID for TASK items (anchor in notes)
    task_calendar?: boolean,  // derived: true when item_type=EVENT and source calendar is a commitment calendar
    linked_task_ids?: string[],
    // virtual/orphaned flags for recurring task instances
    virtual?: boolean,
    orphaned?: boolean,
  },
  color: string | null,
  editable: boolean,
}
```

### `item_type` vs render behavior

`item_type` is the **persistence type** — where the item lives:
- `'TASK'` → stored in Google Tasks
- `'EVENT'` → stored in Google Calendar

**Render behavior is derived, not stored.** The interaction surface Kairos shows depends on `item_type` plus context:
- `TASK` → task chip, completion button, snooze, LOE display
- `EVENT` where `metadata.task_calendar` is false → standard event block, view-only or editable form
- `EVENT` where `metadata.task_calendar` is true → **commitment**: renders as a task chip (all-day) with completion button and snooze

`metadata.task_calendar` is a derived flag set at normalization time by checking `source.account_id` against the user's designated commitment calendars (`commitmentCalendars` in Drive prefs). It is never stored in Drive or Google APIs — always recomputed on load.

---

## Commitments

Google Calendar events on a user-designated **commitment calendar** are treated by Kairos as completable, snoozeable commitments. This is the correct model for recurring scheduled work (weekly review, monthly budget, etc.) because Google Calendar has first-class native recurrence with per-instance editing, stable event IDs, and "edit this / this and following / all" semantics — none of which exist in Google Tasks.

The logical line between a task and a commitment: a **task** is something you need to do, often with a due date. A **commitment** is something you've scheduled — it happens at a specific time and may recur. Due dates alone don't cross the line; recurrence and schedule-anchoring do.

### Commitment calendar designation

Users designate 0–n Google Calendars as commitment calendars via `commitmentCalendars: string[]` in `kairos-prefs.json`. The calendar picker UI shows a "Use as commitment calendar" toggle per calendar (independent of the visibility toggle). Multiple commitment calendars are supported.

### Completion model

Completion state is maintained at two layers:

1. **Drive** (`kairos-event-tasks.json`, keyed by Google Calendar event instance ID):
   ```json
   { "version": 1, "events": { "[eventId]": { "completedAt": "ISO timestamp | null" } } }
   ```
   `completedAt` is the single authoritative field: a non-null value means completed (and is the completion time); null/absent means not completed. One field encodes both state and timestamp with no redundancy and no possibility of the two going out of sync. Kairos reads this to render; it never walks the event log to determine current state.

2. **Log entry in event description** (append-only audit trail):
   - Complete: appends `@timestamp !completed` to the event instance description
   - Uncomplete: appends `@timestamp !uncompleted`
   - Visible in all calendar clients; feeds the Life History Project

Uncompleting sets `completedAt: null` in Drive and appends `!uncompleted` to the log.

### Snooze

Snooze moves the specific event instance to a new date via Google Calendar PATCH (updating `start.date`/`end.date` for all-day, `start.dateTime`/`end.dateTime` for timed) and appends `@timestamp !snoozed to YYYY-MM-DD` to the event description. The series is unaffected; only this instance moves.

### What stays on Google Tasks

One-off personal tasks, with or without a due date. The board view reflects Google Tasks only. Recurring scheduled work belongs on a commitment calendar; the board is for work items, not scheduled commitments.

---

## Provider Abstractions

Providers are plain JS modules that take a token and return `CalendarItem[]`.

```js
// calendar provider interface
async function getEvents(token, start, end) -> CalendarItem[]

// task provider interface
async function getTasks(token, start, end) -> CalendarItem[]
async function completeTask(token, taskId, listId) -> void
async function updateTask(token, item) -> CalendarItem
```

**Implemented providers (Phase 1):**
- `googleCalendar.js` — Google Calendar API v3; parses `---tasks---` blocks in event descriptions into `metadata.linked_task_ids`
- `googleTasks.js` — Google Tasks API v1; parses agile-tasks metadata conventions (LOE, comments, checklists) from task notes field

**Planned provider extensions:**
- Outlook / Microsoft 365
- Apple Calendar (CalDAV)

**Explicitly out of scope:**
- Self-hosted task backend — Google Tasks is the task provider. The abstraction exists to normalize and extend Google's model, not replace it.
- ICS feed output — indefinitely deferred.

---

## Build Phases

### Phase 1 — Google-Backed Validation (Current Focus)
**Goal**: Prove the UI and aggregation model work. Produces a functional, shippable product (customizable Google Calendar client).

- [ ] FastAPI backend skeleton with provider abstraction
- [ ] `GoogleCalendarProvider` — OAuth2 flow, multi-account, fetch/normalize events
- [ ] `GoogleTasksProvider` — fetch tasks, normalize, surface on calendar
- [ ] Unified `/feed` endpoint (JSON) — merged events + tasks
- [ ] ICS feed output endpoint (`/feed.ics`)
- [ ] Vanilla SPA — custom calendar grid, week/month views, all-day area
- [ ] Task rendering on calendar (all-day chips, deadline-aware positioning)
- [ ] Type-driven interaction surface (events vs tasks have different click behavior)

### Phase 2 — Flutter Mobile
- [ ] Flutter calendar app consuming same backend
- [ ] Feature parity with web SPA

### Phase 3 — Extensibility
- [ ] Plugin/adapter pattern for community providers
- [ ] Custom event type registration
- [ ] ICS feed import from arbitrary URLs

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Hosting | Cloudflare Pages | Zero-ops, free tier, same pattern as agile-tasks |
| Auth | PKCE + KV sessions | Client secret never in browser; tokens in KV, not localStorage |
| Web frontend | Vanilla JS SPA | No build pipeline, maximum control over calendar rendering |
| Mobile | Flutter (Phase 2) | Single codebase for iOS + Android |
| Calendar rendering | Custom-rolled | Avoid fighting framework assumptions about task display |
| No backend | Google APIs direct | No server to maintain; auth handled by Pages Functions |
| Provider pattern | JS modules | Normalize provider-specific models; parse agile-tasks metadata extensions |
| PWA | Optional | Offline support without a separate native app |
| Recurring commitments | Calendar events on commitment calendar, not tasks | Google Tasks has no native recurrence; Google Calendar has first-class RRULE with per-instance editing, stable IDs, and native "edit this / all" semantics |
| Commitment render behavior | Derived, not stored | `item_type` = persistence type; render behavior derived from `item_type` + commitment calendar membership at normalization time |
| Commitment completion | `completedAt` timestamp in Drive + log entry in description | `completedAt` non-null = completed (encodes both state and time in one field); log is append-only audit trail |
| Task vs commitment line | Due date alone stays a task; schedule/recurrence → commitment | "Task with a due date" ≠ "calendar event". Tasks live on the board; commitments render on the calendar with the completion surface |

---

## Standards & Interop

- **OAuth2 + PKCE**: Google auth via Cloudflare Pages Functions. Tokens in KV, never in browser storage
- **Google Calendar API v3**: Primary event source
- **Google Tasks API v1**: Task source; agile-tasks body conventions for structured metadata

---

## What This Is Not

- Not a scheduling/booking tool (no availability sharing, no meeting links)
- Not a team collaboration tool (single-user, self-hosted first)
- Not a replacement for a full PMS or project management suite — it is a *calendar-first* view of personal work
- Not locked to Google — Google is the first implementation, not the architecture
- Tasks are not events. `item_type` reflects persistence: `TASK` = Google Tasks, `EVENT` = Google Calendar. Render behavior is derived separately.
- Recurring commitments belong on commitment calendar events, not Google Tasks. Google Tasks has no native recurrence; the synthetic recurrence Kairos previously implemented there was fragile. `GoogleTasksProvider` has no RRULE logic going forward.
- The user-facing term for a completable calendar event is **commitment**. Internally, `metadata.task_calendar` flags it; `commitmentCalendars` in Drive prefs holds the designated calendar IDs.
- `!completed`, `!uncompleted`, and `!snoozed` are in the known action verb allowlist in `parseEventDescription`. All three append log entries to the event instance description; complete/uncomplete also write to `kairos-event-tasks.json`.

---

## Development Notes

- Iterate in Claude Code sessions; memorialize decisions back into this file
- Data model is the highest-leverage design investment — get the `CalendarItem` schema right before building around it
- Provider interfaces should be finalized before writing implementations
- The SPA calendar grid is custom — build the week view first, then month view
- All-day area and timed area are separate rendering zones; tasks can appear in either depending on whether they have a time component
- `GoogleTasksProvider`: task `notes` field contains only: prose body → GFM checklist (`- [ ] item`) → `[kid:xxx]` anchor (last line). LOE, comments, and recurrence are stored in `kairos-tasks.json` (Drive), not in notes. Backward-compat: `parseTaskNotes` still extracts LOE, comments, and recurrence sigils from notes for tasks not yet migrated through the modal save path. Migration is lazy — first explicit modal save moves metadata to Drive and cleans the notes.
- `GoogleCalendarProvider` parses event descriptions for: (1) a single embedded JSON object (first `{` to matching `}`, depth-tracked, silent fail) → `metadata.config`; (2) `@timestamp` comment lines → `metadata.comments`. Structured action comments use a `!verb` prefix to distinguish from plain narrative entries — sigil grammar: `@` = when, `!` = action verb, `$` = key reference. Parser matches `!verb` against a known allowlist (`spawned`, `cancelled`, `deferred`, ...) so unrecognized `!word` gracefully degrades to narrative. Example: `@2025-11-15T09:23:00 !spawned $PAY-TAX tasks/abc123xyz`. The JSON config object may contain `tasks` (linked task IDs) and `spawn` (task prototypes) keys.
- **Event description format**: prose first, then optional JSON config block, then `@timestamp` log entries appended at the bottom. Example: `{"tasks":["tasks/abc123"],"spawn":[{"key":"PAY-TAX","trigger":"-30d","due":"-5d","title":"Pay property tax","loe":"1h","checklist":["Check assessor","Pay via portal"]}]}`
- **Spawn triggers** (future feature): `spawn` array in the event's JSON config block defines named task prototypes. Kairos spawns a Google Task when entering the trigger window and appends `@timestamp !spawned $KEY tasks/{id}` to the event log. Spawn state determined by parsing `!spawned $KEY` comments — no writeback to the JSON block. Do not implement until core calendar + task rendering is complete.