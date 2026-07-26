# CLAUDE.md — Kairos
> Time-aware personal operating system with a calendar as the primary rendering surface.

**Name**: Kairos — from the Greek concept of *kairos* (καιρός), meaning the right or opportune moment. Distinct from *chronos* (clock time), kairos is time as experienced and acted upon. The name reflects the project's purpose: not just displaying time, but helping you act at the right time.

---

## Project Vision

A self-hosted, open-source **calendar aggregation and personal task management platform**. The calendar grid is the UI primitive — everything that is time-aware surfaces on it. Tasks, events, project milestones, habits, and future custom types all share a common temporal model and render contextually based on their type.

This is not a Google Calendar clone. It is a provider-agnostic aggregation layer with an extensible, type-driven interaction surface — with Google Calendar as the first concrete provider implementation.

The project should be buildable by others, self-hostable with minimal friction, and extensible by the community.

---

## Ultimate Goal

A **personal project management / calendar hybrid** where:
- All time-aware data (tasks, events, deadlines, milestones) surfaces on a unified calendar view
- Each item type drives its own rendering and interaction surface
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
│  │  SPA (Vite build)   │   │  Pages Functions         │ │
│  │  (client/web/ →     │   │  (functions/)            │ │
│  │   dist/)            │   │                          │ │
│  │  vanilla JS         │   │  /auth/start             │ │
│  │  week-view calendar │   │  /auth/callback          │ │
│  │  Google API calls   │   │  /auth/refresh           │ │
│  └──────────┬──────────┘   │  /auth/logout            │ │
│             │              │  /api/complete            │ │
│             │              │  /api/webhook-token       │ │
│             │              └────────────┬─────────────┘ │
│             │                           │               │
│             │              ┌────────────▼─────────────┐ │
│             │              │  Cloudflare KV           │ │
│             │              │  (session + token store) │ │
│             │              └──────────────────────────┘ │
└─────────────┼────────────────────────────────────────────┘
              │ direct API calls (Bearer token)
    ┌─────────▼──────────────────────────┐
    │  Google APIs                       │
    │  Calendar API v3                   │
    └────────────────────────────────────┘
              │
    ┌─────────▼──────────────────────────┐
    │  Firestore                         │
    │  (activity / life log)             │
    └────────────────────────────────────┘
```

### Web SPA (`client/web/`)

- Vanilla JS with Vite 5 build; output to `dist/`; deployed via Cloudflare Pages
- Tiptap WYSIWYG editor for event/task body content
- Custom calendar grid using CSS Grid — week view with all-day and timed zones
- Calls Google Calendar API directly from the browser using a Bearer token
- Token obtained by calling `/auth/refresh` (Pages Function); never stored in browser
- Token cache invalidated on `visibilitychange` — re-fetch on every tab focus
- Rendering is type-driven: each item knows its `item_type`, driving visual treatment and interaction surface

### Auth — Cloudflare Pages Functions (`functions/auth/`)

- PKCE OAuth2 flow; client secret never exposed to the browser
- PKCE verifier stored temporarily in KV (5-minute TTL)
- Tokens stored in KV under a random session ID (1-year TTL)
- Session ID in an HttpOnly Secure cookie — JS cannot access tokens directly
- `/auth/refresh` returns a fresh access token to the SPA on demand; refreshes the Google token from the stored refresh token if expired

### Completion Webhook (`functions/api/`)

- `/api/webhook-token` — issues a per-user webhook token stored in KV; used to authorize the completion link without a browser session
- `/api/complete` — toggles completion state on a calendar task event from a link clicked in Google Calendar (or any native client); authenticates via `wt` webhook token param; updates the event summary, extendedProperties, and description footer in one PATCH

### Mobile — Native Android (Phase 2, next)

- Native Android app: **Kotlin + Jetpack Compose** (decided 2026-07-23; was pinned to Flutter). Android-only for now; iOS is an outside chance, not a target.
- Will call Google APIs directly with the same OAuth pattern
- No ntfy stopgap — jumping straight to the native app
- See `../kairos-mobile/CLAUDE.md` for the framework rationale and mobile-specific decisions

### Activity Log — Firestore (`client/web/providers/lifeLog.js`)

- Append-only activity store; each document: `{ timestamp, event_date, source, item_id, item_type, title, verb, action_detail, narrative, context }`
- `timestamp` = immutable create time; `event_date` = editable "when it happened" (defaults to timestamp)
- Loaded at startup into an in-memory cache keyed by `item_id`
- `appendLogEntry`, `updateLogEntry`, `deleteLogEntry` — immediate Firestore writes; in-memory cache updated synchronously so UI reflects changes without waiting for a round-trip

---

## Core Data Model

All time-aware data normalizes to a `CalendarItem` (JavaScript object):

```js
{
  id: string,                   // e.g. "gcal:{calendarId}:{eventId}"
  title: string,
  item_type: 'EVENT' | 'TASK',
  source: { provider: string, account_id: string, external_id: string },
  start: Date,                  // all-day items: midnight local time
  end: Date | null,
  due: Date | null,             // tasks: same as start
  all_day: boolean,
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' | 'COMPLETED' | 'NEEDS_ACTION',
  recurrence: string | null,    // RRULE string
  metadata: {
    body?: string,              // prose notes (stripped of footer/snapshot blocks)
    loe?: string,               // e.g. "2d 4h"
    kairosId?: string,          // stable Kairos ID for task events (extendedProperty)
    webhookToken?: string,      // extracted from completion footer URL; used to rebuild footer on toggle
    listId?: string,            // Kairos list (organization axis) assignment (extendedProperty)
    statusId?: string,          // Kairos status (workflow axis / board column) assignment (extendedProperty)
    order?: number,             // board sort order within a status column (extendedProperty)
    completedAt?: string|null,  // ISO timestamp or null (extendedProperty)
    noDate?: boolean,           // undated task (sentineled start date)
    location?: string,
    unprocessed?: boolean,      // true if event lacks isTask='true' extendedProperty
    recurringEventId?: string,  // camelCase; present on recurring event instances
    task_calendar?: boolean,    // derived: true when source calendar is a task calendar
    linked_task_ids?: string[], // from ---tasks--- block in event description
  },
  color: string | null,
  editable: boolean,
}
```

### `item_type` vs render behavior

`item_type` is the **persistence type** — where the item lives:
- `'TASK'` → stored as a Google Calendar event with `isTask='true'` private extended property (`calendarTasks.js`)
- `'EVENT'` → stored as a regular Google Calendar event (`googleCalendar.js`)

**Render behavior is derived, not stored.** The interaction surface depends on `item_type` plus `metadata.task_calendar`:
- `TASK` or `EVENT` where `metadata.task_calendar` is true → task chip, completion button, snooze, LOE display
- `EVENT` where `metadata.task_calendar` is false → standard event block, editable form

`metadata.task_calendar` is set at normalization time by checking `source.account_id` against the user's designated task calendars (`taskCalendars` in prefs). Never stored — always recomputed on load.

---

## Task Events (Calendar-Backed Tasks)

Tasks in Kairos are stored as Google Calendar events with private extended properties, not in the Google Tasks API. This gives tasks:
- First-class recurrence (RRULE, per-instance editing, "edit this / all" scope)
- Native calendar visibility in any GCal client
- Stable event IDs across moves/renames

### Extended properties (private)

| Key | Type | Meaning |
|---|---|---|
| `isTask` | `'true'` | Marks the event as a Kairos task |
| `kairosId` | string | Stable per-task ID; used for webhook completion lookup |
| `listId` | string | List (organization axis) assignment — the List view's columns |
| `statusId` | string | Status (workflow axis) assignment — the Board's columns |
| `order` | string (number) | Board sort order within a status column |
| `completedAt` | ISO string \| null | Non-null = completed; encodes both state and time |
| `loe` | string | Level of effort (e.g. `"2h"`) |
| `noDate` | `'true'` | Task has no due date (start is a sentinel value) |

### Completion model

- `completedAt` non-null = completed. One field encodes state and timestamp with no redundancy.
- Summary prefixed with `✅ ` for visibility in native GCal clients; stripped at normalization time so Kairos UI sees clean title.
- Description footer: `<div data-kairos="complete-link">` containing `✓ Mark as complete in Kairos` or `↩ Mark as incomplete in Kairos` link — toggled on every complete/uncomplete PATCH, not only on Save.
- `/api/complete` webhook toggles completion from a native GCal link click (no browser session needed).

### Completion footer URL

`https://kairos.inlandsoftware.com/api/complete?kairosId={kairosId}&wt={webhookToken}`

The `wt` (webhook token) is stored in KV and authorizes the completion without a cookie-based session. It is also extracted from the existing footer URL by `_extractWebhookToken()` in `normalizeTask` so callers always have it without a separate fetch.

### Snapshot block

On modal Save, a write-only `--- Kairos ---` block is appended to the description/notes for native client visibility. Kairos never reads it back — stripped before parsing. Format:

```
--- Kairos ---
LOE: 2h  ·  3 comments  ·  Updated Jun 27, 2026
```

---

## Two Axes: Status vs List

Tasks are classified on two orthogonal axes, both stored on the calendar event and both scoped to the task calendar (so a calendar acts as a shareable "project" container — sharing the calendar shares its config):

- **Status** (`statusId` → Firestore `statuses/{id}` = `{ calendarId, name, order, inProgress }`) — the **workflow** axis: intake → backlog → up next → in progress. This is the **Board's** column axis. Statuses are user-defined per calendar. Any status may be flagged `inProgress`; a task in an in-progress status gets a green ring wherever it renders (past-due red takes priority). One status per account is the designated **intake** destination (`intakeStatusId` pref) where voice captures + swept tasks land; the pointer resolves its calendar via the status record.
- **List** (`listId` → Firestore `lists/{id}` = `{ calendarId, name, order, sortMode }`) — the **organization** axis (Home, Car, Work…). This is the **List view's** column axis.

Three surfaces, three lenses on the same tasks:
- **Calendar** — *when* am I working on this (time)
- **Board** (`board.js`) — *priority* / workflow stage (status columns)
- **List** (`list.js`) — *organization* / categorization (list columns)

`kairosStatuses.js` mirrors `kairosLists.js` (calendar-scoped CRUD). Role behavior (intake, in-progress) is never name-matched — intake is a prefs pointer, in-progress is a per-status boolean — so statuses can be freely renamed.

## Board View

The board (`board.js`) surfaces a **single project calendar's** task events in a Kanban layout grouped by **status** (the calendar is chosen via the project selector in the board toolbar, persisted as `projectCalendarId`). Columns are the calendar's statuses; tasks with missing/unknown `statusId` fall into the first (Intake) column. **Done** is synthetic (derived from `completedAt`), not a status value. Each column header has a hammer toggle to flag the status `inProgress`. Recurring tasks are deduplicated to one card per series. Drag rewrites `statusId`.

## List View

The list view (`list.js`) surfaces the same project calendar's **incomplete** task events grouped by **list**; tasks with no list fall into an Unlisted column. No Done column. Auto-sorted per column: in-progress first, then due date, then alphabetical (no manual order). Drag rewrites `listId`. Reuses the board's column/card CSS, snooze popover, and Sortable mechanics but is otherwise an isolated module.

---

## UI Details

- **Past events**: regular past events fade to opacity 0.45 (`.is-past`); past-due incomplete tasks get a red urgency ring (`.past-due`)
- **Recurrence indicator**: `↻` appended to chip/card title for any item with `recurrence` or `metadata.recurringEventId`
- **End date**: hidden by default in all-day mode; "Add end date" link reveals it; "Hide end date" collapses back
- **All day** checkbox appears below the date row (logically modifies dates)
- **Token refresh**: `invalidateCache()` called on `visibilitychange` — every tab focus gets a fresh token from `/auth/refresh`

---

## Provider Abstractions

Providers are plain JS modules that take a token and return `CalendarItem[]`.

**Implemented providers:**
- `calendarTasks.js` — Google Calendar API v3; reads/writes Kairos task events (extendedProperties pattern)
- `googleCalendar.js` — Google Calendar API v3; regular events; parses `---tasks---` blocks and `@timestamp !verb` log entries in descriptions

**Planned provider extensions:**
- Outlook / Microsoft 365
- Apple Calendar (CalDAV)

---

## Build Phases

### Phase 1 — Baseline (Complete ✓)
**Shipped**: Functional web app. Week-view calendar, board view, unified editor, task event model, completion/snooze/recurrence, activity log, mobile day view.

Key baseline version: **v0.23.20**

### Phase 1.5 — Work Surfaces (Next)
- Intake surface — capture new tasks/events quickly without opening the full editor
- Planning surface — review and sequence upcoming work

### Phase 2 — Native Android Mobile (Next major project)
- Native Android app: Kotlin + Jetpack Compose (Android-only; iOS is an outside chance)
- Feature parity with web SPA
- Same OAuth pattern; calls Google APIs directly

### Phase 3 — Extensibility
- Plugin/adapter pattern for community providers
- Custom event type registration

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Hosting | Cloudflare Pages | Zero-ops, free tier, edge-deployed functions |
| Auth | PKCE + KV sessions | Client secret never in browser; tokens in KV, not localStorage |
| Web frontend | Vanilla JS + Vite | Maximum control over calendar rendering; Vite for bundling/dev ergonomics |
| Mobile | Native Android — Kotlin + Jetpack Compose (Phase 2) | Android-only for the maintainer; iOS an outside chance. Lowest complexity for one OS, best on-device perf/gestures. Decided 2026-07-23 (was Flutter). |
| Calendar rendering | Custom-rolled | Avoid fighting framework assumptions about task display |
| No backend | Google APIs direct | No server to maintain; auth handled by Pages Functions |
| Task storage | Google Calendar events (not Google Tasks API) | First-class RRULE recurrence, stable IDs, per-instance editing, native GCal visibility |
| Task completion state | `completedAt` extendedProperty + footer toggle | Single field encodes state and time; no redundancy; footer link lets native clients complete tasks |
| Activity log | Firestore | Structured, queryable; separate from task body; `event_date` editable, `timestamp` immutable |
| Token refresh | Invalidate on visibilitychange | Ensures returning to tab after any idle period always gets a fresh token |
| `item_type` | Persistence type only | Render behavior derived from `item_type` + `task_calendar` flag at normalization time |

---

## Standards & Interop

- **OAuth2 + PKCE**: Google auth via Cloudflare Pages Functions. Tokens in KV, never in browser storage
- **Google Calendar API v3**: All data (events and task events)
- **Firestore**: Activity log / life history

---

## What This Is Not

- Not a scheduling/booking tool (no availability sharing, no meeting links)
- Not a team collaboration tool (single-user, self-hosted first)
- Not a replacement for a full PMS — it is a *calendar-first* view of personal work
- Not locked to Google — Google is the first implementation, not the architecture
- Not using the Google Tasks API — tasks are Google Calendar events with extended properties

---

## Development Notes

- Iterate in Claude Code sessions; memorialize decisions back into this file
- Production URL: `https://kairos.inlandsoftware.com` (permanent CNAME to Cloudflare Pages)
- Build: `npm run build` in repo root → `dist/`; Cloudflare Pages picks up `dist/` automatically
- All-day area and timed area are separate rendering zones
- `normalizeTask` (calendarTasks.js): extracts `webhookToken` from existing footer URL via `_extractWebhookToken()` so it's always available in metadata without a separate fetch
- `normalizeEvent` (googleCalendar.js): uses camelCase `recurringEventId` (not snake_case) — must stay consistent with `normalizeTask` so all recurrence checks work uniformly
- `_buildDescriptionPatch(item, nowCompleted)` in calendarTasks.js: rebuilds description with correctly-labelled footer on every complete/uncomplete; called from `completeTask`, `uncompleteTask`, and the `/api/complete` webhook
- `_setMode()` in unifiedEditor.js: resets `ue-complete.disabled = false` when the button is shown — prevents button staying disabled across modal re-opens
- **Spawn triggers** (future): config prototypes will live in Drive. Do not implement until work surfaces are complete.
- **Text fields are clean**: prose body only. The `--- Kairos --- ` snapshot block is write-only (appended on Save); the `data-kairos="complete-link"` footer div is managed by completion handlers. Neither is read back by the parser.
