# Sprint-Sync Hub

Sprint-Sync Hub is an AI-powered automation system that connects your team's Slack standup channel to your Jira project board. It uses Claude AI to automatically match standup messages to Jira tasks, update statuses, send nudge DMs, and generate weekly sprint reports — all on a configurable schedule.

## Features Implemented

### Slack ↔ Jira Standup Sync
- **Daily huddle sync** (cron, configurable time) — reads standup messages from the Slack channel, uses Claude to match each message to a Jira task, posts a comment on the matched issue, and transitions its status.
- **Bulk / multi-day standup detection** — Claude detects when a member posts several days' worth of updates in one message and records each date separately.
- **Mismatch detection & handling** — flags updates that reference an unassigned task or a different project, DMs the member, alerts the team lead, and logs the event (`mismatch_events` table). Includes a 4-hour idempotency window to avoid duplicate DMs.
- **No-match nudge DMs** — if a message can't be matched to any Jira task, Claude drafts a DM asking the member to update Jira.
- **End-of-day (EOD) missing-update check** — DMs anyone who hasn't posted a standup or whose post didn't match a task; skips members who show absent or who checked out early, based on unified attendance data (Zoho webhook > Zoho presence > Slack fallback).
- **Deadline / overdue check** — daily scan for overdue Jira issues, DMs the assignee with days-overdue context.
- **Checkout-without-standup detection** — polls every 15 minutes (4:30–7:30 PM) for real Zoho webhook checkout events and DMs anyone who checked out without posting a standup.
- **Role-based DM gating** — managerial-only members are exempt from all automated task/standup DMs (huddle-sync no-match, EOD reminders, deadline alerts, checkout nudges, mismatch alerts).
- **Weekly sprint report** — Claude generates a summary (with leaderboard + at-risk members) and posts it to the channel and/or DMs the manager, on a configurable day/time.

### AI-Assisted Sprint Planning & Task Assignment
- **Sprint goal breakdown** — paste a sprint goal, Claude breaks it into individual Jira-ready tasks.
- **Smart task assignment** — ranks team members per task using skill profile match, current workload, and past performance; creates the sprint and issues directly in Jira with assignees pre-filled.
- **Skill extraction** — Claude extracts skills/technologies mentioned in standup messages and builds a per-member skill profile over time (cached, rebuildable).

### Performance Tracking
- **Daily stats & streaks** — tracks standups posted, Jira syncs, missed days, and posting streaks per member per sprint.
- **Sprint performance scoring** — computes a performance score, trend, and risk level (at-risk detection with reasons) per member.
- **Team leaderboard & dashboard** — ranks members by performance; a dedicated "at-risk" view surfaces who needs attention.
- **Per-member profile & history** — historical performance across sprints, drill-down by member.

### Attendance (Zoho Integration)
- **Zoho OAuth flow** — one-click authorization to grant attendance scopes.
- **Unified attendance sync** — merges three sources in priority order: Zoho webhook (real-time check-in/out, if configured in Zoho People → Settings → Integrations → Webhooks) overrides Zoho Chat presence (online/offline signal), which overrides a Slack-activity fallback (first message of the day) for anyone the above missed. The Zoho People Attendance/Leave REST API is not used — it returns error 7201 (module disabled) on this account, so there is currently no reliable leave-detection signal.
- **Feature flag toggle** — Zoho attendance can be turned on/off from Settings without a redeploy; all attendance-dependent cron logic checks this flag.
- **Attendance history** — per-member and team-wide attendance history views.

### Roles & Member Management
- **Role management** — create/edit/delete roles, distinguish technical vs. managerial roles; managerial-only members are excluded from automated task DMs.
- **Member ↔ role assignment** — assign/remove one or more roles per member.
- **Slack/Jira identity sync** — auto-fetches Slack emails (`users.info`) and matches Jira account IDs by email; supports manual override (never overwritten by auto-sync) with a "manual" badge in the UI.
- **Full sync** endpoint runs email sync → Jira ID sync in one call, and automatically on server boot if no emails are on record.

### Configuration & Admin
- **DB-backed config service** — sprint settings, team members, and connections are stored in Postgres with env-var fallback and in-memory caching; credentials are encrypted at rest (`cryptoService`).
- **API authentication** — every `/api` route (except `/api/health` and the Zoho webhook, which can't send custom headers) requires an `x-api-key` header matching `API_AUTH_TOKEN`. Without it set, the API is open — set it before deploying anywhere reachable from the internet.
- **Connections health check** — verifies Slack, Jira, and Anthropic credentials from the dashboard.
- **Activity / sync log** — every automated action (matches, DMs, errors) is logged and viewable from the dashboard.
- **Manual sync trigger & Jira actions** — run the huddle sync on demand, browse issues/overdue tasks, post comments, and transition statuses directly from the UI.

### Dashboard (React + Vite frontend)
Tabs: **Overview**, **Connections**, **Team**, **Sprint**, **Sync**, **Performance**, **Sprint Planning**, **Roles**, **Report**, **How It Works** — covering configuration, live sync status, performance leaderboards, AI sprint planning, and report generation/posting.

## Prerequisites

- Node.js 20+
- A Slack workspace with a bot app (see below)
- A Jira Cloud account with API access
- An Anthropic API key (for Claude AI)

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url>
cd sprint-sync-hub

# 2. Set up backend
cd backend
npm install
cp .env.example .env
# → Fill in all values in .env (see sections below)
npm run dev          # starts on http://localhost:3001

# 3. Set up frontend (in a new terminal)
cd frontend
npm install
npm run dev          # starts on http://localhost:5173
```

Open http://localhost:5173 in your browser.

## Getting Your Credentials

### Slack Bot Token
1. Go to https://api.slack.com/apps → Create New App → From scratch
2. Go to **OAuth & Permissions** → add Bot Token Scopes:
   - `channels:history`, `chat:write`, `im:write`, `users:read`, `users:read.email`
3. Install App to Workspace → copy the **Bot User OAuth Token** (`xoxb-…`)
4. Find your channel ID: right-click the channel in Slack → View channel details → copy the ID at the bottom
5. Copy the **Signing Secret** from Basic Information → App Credentials

### Jira API Token
1. Log in to https://id.atlassian.com
2. Go to **Security** → **API tokens** → Create API token
3. Copy the token value (shown only once)
4. Your `JIRA_SITE_URL` is `https://yourcompany.atlassian.net`
5. Your `JIRA_PROJECT_KEY` is the short prefix before issue numbers (e.g. `QG` for `QG-42`)

### Anthropic API Key
1. Go to https://console.anthropic.com
2. **API Keys** → Create Key → copy the `sk-ant-…` value

## How to Change Organisation

To switch to a different Slack workspace, Jira instance, or team:

1. Edit `backend/.env` with the new credentials
2. Restart the backend: `npm run dev`
3. Update team members in the dashboard → Team tab

## Deployment

```bash
# Frontend → Vercel
cd frontend
npx vercel --prod
# Add VITE_API_URL=https://your-backend.railway.app in Vercel dashboard

# Backend → Railway
cd backend
railway login && railway init && railway up
# Add all .env variables in Railway → Variables tab
```
