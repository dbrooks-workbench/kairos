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
┌─────────────────────────────────────────────────────┐
│                   Clients                           │
│   SPA (Web)          Flutter (Mobile)               │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / REST
┌──────────────────────▼──────────────────────────────┐
│              FastAPI Backend (Python)                │
│                                                     │
│  ┌─────────────────────────────────────────────┐   │
│  │           Aggregation Layer                  │   │
│  │  ICalendarProvider[]  +  ITaskProvider[]     │   │
│  └────────────┬──────────────────┬─────────────┘   │
│               │                  │                  │
│  ┌────────────▼──┐   ┌───────────▼──────────────┐  │
│  │ Google Cal    │   │ Google Tasks Provider    │  │
│  │ Provider      │   │ (ITaskProvider impl)     │  │
│  │ (OAuth2)      │   │ (OAuth2, shared tokens)  │  │
│  └───────────────┘   └──────────────────────────┘  │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │ ICS Feed Provider (read-only, URL-based)     │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
                       │
              ┌────────▼────────┐
              │  ICS Feed Output │  ← any calendar client can subscribe
              │  (tasks as       │
              │   static events) │
              └──────────────────┘
```

### Backend — FastAPI (Python)

- **Framework**: FastAPI (minimal, async, self-documenting via OpenAPI)
- **Primary responsibility**: Aggregation. Fetches from all configured providers, normalizes to internal model, serves unified feed
- **Auth**: OAuth2 token storage per account (encrypted at rest). Handles token refresh
- **ICS output**: Dynamic ICS feed endpoint. Tasks serialized as `VEVENT` entries. Consumable by any ICS-capable client (Apple Calendar, Outlook, Fantastical, etc.)
- **Database**: TBD — likely SQLite for MVP simplicity, Postgres for production

### Web Frontend — Vanilla SPA

- **Single HTML/JS/CSS file** — no build pipeline required for basic use
- **No calendar framework** — custom-rolled calendar grid using CSS Grid and vanilla JS
- **Optionally bundleable as a PWA** for offline support
- **Rendering is type-driven**: each `CalendarItem` knows its type, and the frontend uses that to determine visual treatment and available interactions
- **Connects to**: FastAPI backend REST API

### Mobile — Flutter

- Flutter app targeting iOS and Android
- Connects to same FastAPI backend
- Custom calendar rendering (consistent with web, adapted for mobile UX)

---

## Core Data Model

All time-aware data normalizes to a `CalendarItem`:

```python
class CalendarItem(BaseModel):
    id: str
    title: str
    item_type: ItemType          # EVENT | TASK | MILESTONE | HABIT | ...
    source: SourceInfo           # which provider + account this came from
    start: datetime | date       # date = all-day
    end: datetime | date | None
    due: datetime | date | None  # for tasks with deadlines
    all_day: bool
    status: ItemStatus           # CONFIRMED | TENTATIVE | CANCELLED | COMPLETED | ...
    recurrence: str | None       # RRULE string
    metadata: dict               # type-specific extra fields
    tags: list[str]
    color: str | None            # provider-assigned or user-assigned
    editable: bool               # can this item be mutated via this provider?
```

**`item_type` drives:**
- How the item renders on the calendar grid (all-day bar vs timed block vs task chip)
- What interaction surface appears on click/tap (view-only, completable, editable form, etc.)
- Whether it appears in the ICS feed output

---

## Provider Abstractions

```python
class ICalendarProvider(ABC):
    async def get_events(self, start: datetime, end: datetime) -> list[CalendarItem]: ...
    async def create_event(self, item: CalendarItem) -> CalendarItem: ...
    async def update_event(self, item: CalendarItem) -> CalendarItem: ...
    async def delete_event(self, item_id: str) -> None: ...

class ITaskProvider(ABC):
    async def get_tasks(self, start: date, end: date) -> list[CalendarItem]: ...
    async def complete_task(self, task_id: str) -> None: ...
    async def update_task(self, item: CalendarItem) -> CalendarItem: ...
```

**Implemented providers (Phase 1):**
- `GoogleCalendarProvider` — OAuth2, Google Calendar API v3, supports multiple accounts
- `GoogleTasksProvider` — OAuth2 (shared token with calendar), Google Tasks API; parses agile-tasks metadata conventions from task body text
- `ICSFeedProvider` — read-only, polls a URL on a configurable interval

**Planned provider extensions (community):**
- Outlook / Microsoft 365
- Apple Calendar (CalDAV)

**Explicitly out of scope (initial release):**
- Self-hosted task backend — Google Tasks remains the task provider indefinitely. The abstraction layer exists to normalize and extend Google's model, not to replace it.

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
| Backend language | Python / FastAPI | Minimal, async, great open source deployment story |
| Web frontend | Vanilla JS SPA | No build pipeline, maximum control over calendar rendering |
| Mobile | Flutter | Single codebase for iOS + Android |
| Calendar rendering | Custom-rolled | Avoid fighting framework assumptions about task display |
| Standards | ICS output, OAuth2 | Interop with any calendar client; standard auth |
| Multi-account | Yes, Phase 1 | Multiple Google accounts merged into single view |
| Provider pattern | Abstract interfaces | Normalize provider-specific models; accommodate metadata extensions (agile-tasks conventions in task body) |
| PWA | Optional | Offline support without a separate native app |

---

## Standards & Interop

- **ICS / iCalendar (RFC 5545)**: Output feed format. Tasks serialized as `VEVENT` with appropriate `STATUS` and `DUE` fields
- **CalDAV**: Not implemented in Phase 1, but provider abstraction accommodates it
- **OAuth2**: Google auth. Tokens stored encrypted server-side, never in browser
- **OpenAPI**: FastAPI auto-generates — all endpoints self-documented

---

## What This Is Not

- Not a scheduling/booking tool (no availability sharing, no meeting links)
- Not a team collaboration tool (single-user, self-hosted first)
- Not a replacement for a full PMS or project management suite — it is a *calendar-first* view of personal work
- Not locked to Google — Google is the first implementation, not the architecture

---

## Development Notes

- Iterate in Claude Code sessions; memorialize decisions back into this file
- Data model is the highest-leverage design investment — get the `CalendarItem` schema right before building around it
- Provider interfaces should be finalized before writing implementations
- The SPA calendar grid is custom — build the week view first, then month view
- All-day area and timed area are separate rendering zones; tasks can appear in either depending on whether they have a time component
- `GoogleTasksProvider` must parse agile-tasks metadata conventions from the Google Tasks `notes` field and surface them via `CalendarItem.metadata`. Conventions (from `../agile-tasks/src/parsers.js`): LOE as `~1d 5h 20m` (→ `metadata.loe`), timestamped comments as `@2026-05-21T14:30:00 text` (→ `metadata.comments`), checklists as GFM `- [ ] item` (→ `metadata.checklist`). Serialization order within notes: prose body → checklist → LOE → comments.
- `GoogleCalendarProvider` should parse the `---tasks---` block in event descriptions (agile-tasks convention for task-event linking) and surface linked task IDs via `metadata.linked_task_ids`.