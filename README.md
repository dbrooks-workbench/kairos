# Kairos

> *καιρός* — the right or opportune moment. Time as experienced and acted upon, not merely measured.

A self-hosted calendar aggregation and personal task management platform. The calendar grid is the primary UI primitive — events, tasks, deadlines, and milestones all share a unified temporal model and render on it.

Google Calendar and Google Tasks are the first (and currently only planned) provider implementations. The provider abstraction layer exists to normalize Google's data model and accommodate structured metadata extensions, not to swap out backends.

---

## Architecture

```
client/web      Vanilla JS SPA — custom week-view calendar grid, no framework
api/            FastAPI backend — aggregates providers, serves /feed and /feed.ics
```

The FastAPI backend normalizes all time-aware data to a common `CalendarItem` model and serves it as a unified JSON feed. A secondary `/feed.ics` endpoint produces a standard iCalendar feed consumable by any calendar client.

## Deployment

The stack runs as two Docker containers (FastAPI + nginx) managed by Docker Compose. Images are built by GitHub Actions and pushed to GHCR on every push to `main`.

**On the server, you only need two files:**

```bash
# 1. Copy docker-compose.yml and .env to the server
# 2. Authenticate to GHCR
echo YOUR_PAT | docker login ghcr.io -u dbrooks-workbench --password-stdin
# 3. Pull and start
docker compose pull && docker compose up -d
```

See `.env.example` for required configuration. `BASE_URL` must be set to your public domain — it drives OAuth redirect URIs.

## Google Cloud Setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable **Google Calendar API** and **Tasks API**
3. Configure an OAuth consent screen (Internal if Google Workspace, External otherwise)
4. Create an OAuth 2.0 Web Client credential; add `https://your-domain/api/auth/google/callback` as an authorized redirect URI
5. Copy the client ID and secret into `.env`

Once deployed, visit `https://your-domain/api/auth/google/login` to connect your Google account.

## Development

```bash
cp .env.example .env
# fill in GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, BASE_URL, SECRET_KEY

docker compose up --build
```

The API auto-documents at `http://localhost/api/docs`.

## Status

Phase 1 in progress — Google-backed validation build.
