# Sprint-Sync Hub

Sprint-Sync Hub is an AI-powered automation system that connects your team's Slack standup channel to your Jira project board. It uses Claude AI to automatically match standup messages to Jira tasks, update statuses, send nudge DMs, and generate weekly sprint reports — all on a configurable schedule.

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
