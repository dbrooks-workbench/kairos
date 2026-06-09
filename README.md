# Kairos

> *καιρός* — the right or opportune moment. Time as experienced and acted upon, not merely measured.

A self-hosted calendar aggregation and personal task management platform. The calendar grid is the primary UI primitive — events, tasks, deadlines, and milestones all share a unified temporal model and render on it.

Google Calendar and Google Tasks are the data providers. The app reads task metadata (LOE, comments, checklists) stored in the Google Tasks notes field using the conventions established in the agile-tasks project.

## Architecture

A static vanilla JS SPA deployed on Cloudflare Pages. Cloudflare Pages Functions handle the OAuth flow server-side (PKCE + KV session storage); the SPA calls Google APIs directly from the browser.

```
functions/auth/     Cloudflare Pages Functions — OAuth start/callback/refresh/logout
client/web/         Static SPA — vanilla JS week-view calendar, no framework or build step
```

## Deployment

The app deploys automatically via Cloudflare Pages' GitHub integration on every push to `main`. No build step required.

### First-time setup

**1. Cloudflare KV namespace**

In the Cloudflare dashboard, create a KV namespace named `kairos-sessions`. Copy the namespace ID and preview ID into `wrangler.toml`.

**2. Cloudflare Pages project**

Connect this GitHub repo to a new Cloudflare Pages project:
- Build command: *(none)*
- Build output directory: `client/web`
- Add environment variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

**3. Google Cloud**

- Enable Google Calendar API and Tasks API
- OAuth consent screen: Internal (Google Workspace)
- Scopes: `openid email calendar tasks`
- OAuth 2.0 Web Client credential; authorized redirect URI: `https://your-pages-domain/auth/callback`

Once deployed, visit `https://your-pages-domain/auth/start` to connect your Google account.

## Local development

```bash
npm install -g wrangler
cp .env.example .dev.vars   # fill in GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
wrangler pages dev client/web --compatibility-date=2024-09-23
```

Wrangler reads KV bindings and `.dev.vars` automatically for local Pages dev.

## Status

Phase 1 in progress — Google Calendar and Tasks integration.
