# Kairos

> *καιρός* — the right or opportune moment. Time as experienced and acted upon, not merely measured.

A self-hosted calendar aggregation and personal task management platform. The calendar grid is the primary UI primitive — events and tasks share a unified temporal model and render on it.

Google Calendar is the data provider. Tasks are stored as Google Calendar events with private extended properties (not in the Google Tasks API), giving them first-class recurrence, stable IDs, and native visibility in any calendar client.

## What's built

- **Week-view calendar** — all-day area and timed area; custom CSS Grid layout
- **Board view** — Kanban-style task board grouped by list; recurring tasks deduplicated to one card per series
- **Unified editor** — create and edit events and tasks in a single modal; Tiptap WYSIWYG body editor; recurrence (RRULE), LOE, location, all-day / multi-day
- **Task completion** — chip checkbox, editor button, and a webhook link embedded in the GCal event description (works from any native calendar client without opening Kairos)
- **Snooze** — moves the task instance to a future date
- **Activity log** — per-item comment and action history stored in Firestore; `event_date` (editable) and `timestamp` (immutable) tracked separately
- **Recurrence indicator** — ↻ on any recurring event or task chip
- **Past event treatment** — past events fade; past-due incomplete tasks get a red urgency ring
- **Mobile day view** — responsive layout switches to a day-by-day view on narrow screens
- **Multi-account auth** — PKCE OAuth2 via Cloudflare Pages Functions; tokens in KV, never in the browser

## Architecture

```
functions/auth/         Cloudflare Pages Functions — OAuth start/callback/refresh/logout
functions/api/          Cloudflare Pages Functions — /api/complete, /api/webhook-token
client/web/             SPA source (vanilla JS, Vite 5 build)
dist/                   Build output — served by Cloudflare Pages
```

The SPA calls Google Calendar API directly from the browser. Cloudflare Pages Functions handle auth and the headless completion webhook. Activity is logged to Firestore.

## Deployment

The app deploys automatically via Cloudflare Pages' GitHub integration on every push to `main`.

- **Build command**: `npm run build`
- **Build output directory**: `dist`

### First-time setup

**1. Cloudflare KV namespace**

In the Cloudflare dashboard, create a KV namespace named `kairos-sessions`. Copy the namespace ID into `wrangler.toml`.

**2. Cloudflare Pages project**

Connect this GitHub repo to a new Cloudflare Pages project and set:
- Build command: `npm run build`
- Build output directory: `dist`
- Environment variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

**3. Google Cloud**

- Enable Google Calendar API
- OAuth consent screen: Internal (Google Workspace) or External
- Scopes: `openid email calendar`
- OAuth 2.0 Web Client credential; authorized redirect URI: `https://your-domain/auth/callback`

**4. Firestore**

- Create a Firestore database in the Google Cloud project
- Add `FIRESTORE_PROJECT_ID` and `FIRESTORE_API_KEY` to Cloudflare Pages environment variables

Once deployed, visit `https://your-domain/auth/start` to connect your Google account.

## Local development

```bash
npm install
cp .env.example .dev.vars   # fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, FIRESTORE_*
npm run dev                 # Vite dev server + Wrangler Pages Functions
```

## Status

**Baseline shipped** (v0.23.20). Core calendar + task management is functional.

**Next**: Work surfaces (intake, planning), then Flutter mobile app.
