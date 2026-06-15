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
  recurrence: string | null,  // RRULE string
  metadata: {                 // type-specific fields
    body?: string,            // prose notes
    loe?: string,             // e.g. "2d 4h" (parsed from ~-prefix line)
    comments?: [{timestamp, text}],
    checklist?: [{text, checked}],
    linked_task_ids?: string[],
  },
  color: string | null,
  editable: boolean,
}
```

**`item_type` drives:**
- How the item renders on the calendar grid (all-day bar vs timed block vs task chip)
- What interaction surface appears on click/tap (view-only, completable, editable form, etc.)
- Whether it appears in the ICS feed output

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
- Tasks are not events: due time and recurrence are event properties, not task properties. Recurrence belongs on calendar events; a recurring commitment that triggers work should be modelled as a recurring event, not a recurring task. Google's own recurring task feature is considered a kludge that confirms this boundary. `GoogleTasksProvider` has no RRULE logic.

---

## Development Notes

- Iterate in Claude Code sessions; memorialize decisions back into this file
- Data model is the highest-leverage design investment — get the `CalendarItem` schema right before building around it
- Provider interfaces should be finalized before writing implementations
- The SPA calendar grid is custom — build the week view first, then month view
- All-day area and timed area are separate rendering zones; tasks can appear in either depending on whether they have a time component
- `GoogleTasksProvider` must parse agile-tasks metadata conventions from the Google Tasks `notes` field and surface them via `CalendarItem.metadata`. Conventions (from `../agile-tasks/src/parsers.js`): LOE as `~1d 5h 20m` (→ `metadata.loe`), timestamped comments as `@2026-05-21T14:30:00 text` (→ `metadata.comments`), checklists as GFM `- [ ] item` (→ `metadata.checklist`). Serialization order within notes: prose body → checklist → LOE → comments.
- `GoogleCalendarProvider` parses event descriptions for: (1) a single embedded JSON object (first `{` to matching `}`, depth-tracked, silent fail) → `metadata.config`; (2) `@timestamp` comment lines → `metadata.comments`. Structured action comments use a `!verb` prefix to distinguish from plain narrative entries — sigil grammar: `@` = when, `!` = action verb, `$` = key reference. Parser matches `!verb` against a known allowlist (`spawned`, `cancelled`, `deferred`, ...) so unrecognized `!word` gracefully degrades to narrative. Example: `@2025-11-15T09:23:00 !spawned $PAY-TAX tasks/abc123xyz`. The JSON config object may contain `tasks` (linked task IDs) and `spawn` (task prototypes) keys.
- **Event description format**: prose first, then optional JSON config block, then `@timestamp` log entries appended at the bottom. Example: `{"tasks":["tasks/abc123"],"spawn":[{"key":"PAY-TAX","trigger":"-30d","due":"-5d","title":"Pay property tax","loe":"1h","checklist":["Check assessor","Pay via portal"]}]}`
- **Spawn triggers** (future feature): `spawn` array in the event's JSON config block defines named task prototypes. Kairos spawns a Google Task when entering the trigger window and appends `@timestamp !spawned $KEY tasks/{id}` to the event log. Spawn state determined by parsing `!spawned $KEY` comments — no writeback to the JSON block. Do not implement until core calendar + task rendering is complete.