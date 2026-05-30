import React, { useState } from 'react';
import { COLORS, FONTS, card } from '../config.js';

function Section({ title, color, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ ...card, borderLeft: `3px solid ${color}`, padding: 0, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: '100%', background: 'none', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '18px 20px', textAlign: 'left',
        }}
      >
        <span style={{ fontFamily: FONTS.heading, fontSize: 15, fontWeight: 700, color: COLORS.text }}>{title}</span>
        <span style={{ color: COLORS.muted, fontSize: 16, flexShrink: 0 }}>{open ? '▼' : '▶'}</span>
      </button>
      {open && <div style={{ padding: '0 20px 20px', borderTop: `1px solid ${COLORS.border}` }}>{children}</div>}
    </div>
  );
}

function Code({ children }) {
  return (
    <pre style={{
      background: '#070810', border: `1px solid ${COLORS.border}`, borderRadius: 8,
      padding: '14px 16px', fontFamily: FONTS.mono, fontSize: 12, color: COLORS.secondary,
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '12px 0', lineHeight: 1.7,
    }}>
      {children}
    </pre>
  );
}

function P({ children }) {
  return <p style={{ color: COLORS.muted, fontSize: 14, lineHeight: 1.7, marginTop: 12 }}>{children}</p>;
}

function Step({ n, children }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
      <span style={{ fontFamily: FONTS.mono, fontSize: 12, color: COLORS.primary, background: 'rgba(124,106,255,0.15)', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontWeight: 600 }}>{n}</span>
      <p style={{ color: COLORS.muted, fontSize: 14, lineHeight: 1.6 }}>{children}</p>
    </div>
  );
}

export default function HowItWorksTab() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <h2 style={{ fontFamily: FONTS.heading, fontSize: 20, fontWeight: 700, color: COLORS.text }}>How It Works</h2>
        <p style={{ color: COLORS.muted, fontSize: 14, marginTop: 4 }}>Click any section to expand it.</p>
      </div>

      <Section title="1. Architecture" color={COLORS.primary}>
        <P>Automation-Hub has three layers: a React frontend (this dashboard), a Node.js/Express backend (runs cron jobs and holds all credentials), and three external APIs (Slack, Jira, Claude AI).</P>
        <Code>{`Browser (React)
    │  REST API calls (no secrets)
    ▼
Express Backend (Node.js)          ← All secrets live here
    ├── Slack Web API  ← reads standup messages, sends DMs
    ├── Jira REST API  ← reads issues, posts comments, transitions
    └── Anthropic API  ← analyses messages, drafts copy

  Flow:
  Slack channel → Backend fetches messages → Claude analyses
  → match found → Jira comment + status update
  → no match    → DM sent to user`}</Code>
        <P>The frontend never sees API tokens. It only calls your backend over HTTP, which in turn calls the external services.</P>
      </Section>

      <Section title="2. Where Credentials Live" color={COLORS.secondary}>
        <P>Credentials are stored exclusively in <strong style={{ color: COLORS.text }}>backend/.env</strong>. The browser never reads this file. The frontend only stores non-sensitive display config (sprint name, dates).</P>
        <Code>{`# backend/.env  ← NEVER commit this file

# Slack
SLACK_BOT_TOKEN=xoxb-your-token-here
SLACK_CHANNEL_ID=Cxxxxxxxxxx
SLACK_SIGNING_SECRET=your-signing-secret

# Jira
JIRA_EMAIL=admin@yourcompany.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_SITE_URL=https://yourcompany.atlassian.net
JIRA_PROJECT_KEY=QG

# Anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Sprint
SPRINT_NAME=Sprint 1
SPRINT_START_DATE=2026-05-18
SPRINT_DURATION_WEEKS=2

# Schedule
TIMEZONE=Asia/Kolkata
EOD_CHECK_TIME=17:30
REPORT_DAY=Friday
REPORT_TIME=17:00
MANAGER_SLACK_ID=

# Team
TEAM_MEMBERS=[{"id":"U001","name":"Alice","initials":"AL"}]`}</Code>
        <P>After editing .env, restart the backend with <code style={{ fontFamily: FONTS.mono, background: COLORS.surface, padding: '2px 6px', borderRadius: 4 }}>npm run dev</code>.</P>
      </Section>

      <Section title="3. How Huddle → Jira Sync Works" color={COLORS.warning}>
        <P>Every 30 minutes (Mon–Fri, 8am–8pm), the backend runs the sync job:</P>
        <Code>{`1. Fetch new Slack messages since last run
   └─ Only messages within sprint window are processed

2. For each message:
   └─ Is the author in the team members list? → continue
   └─ Call Claude API with message + all Jira tasks
      └─ Claude returns: { matched, confidence, issueKey,
                           suggestedStatus, commentText }

3. If matched AND confidence >= 70%:
   ├─ POST comment to Jira issue
   ├─ Transition issue to suggestedStatus
   └─ Log action in activity log

4. If not matched OR confidence < 70%:
   ├─ Check: was a DM sent to this user in last 24h?
   │   └─ Yes → skip (no spam)
   ├─ Draft friendly DM via Claude
   ├─ Send DM via Slack API
   └─ Log action in activity log`}</Code>
      </Section>

      <Section title="4. How to Switch Slack Workspaces" color={COLORS.success}>
        <P>To connect a different Slack workspace:</P>
        <Step n="1">Go to <strong style={{ color: COLORS.text }}>api.slack.com/apps</strong> and create a new app → From scratch.</Step>
        <Step n="2">Add OAuth scopes: <code style={{ fontFamily: FONTS.mono, fontSize: 12 }}>channels:history</code>, <code style={{ fontFamily: FONTS.mono, fontSize: 12 }}>chat:write</code>, <code style={{ fontFamily: FONTS.mono, fontSize: 12 }}>im:write</code>, <code style={{ fontFamily: FONTS.mono, fontSize: 12 }}>users:read</code>, <code style={{ fontFamily: FONTS.mono, fontSize: 12 }}>users:read.email</code></Step>
        <Step n="3">Install the app to the new workspace and copy the Bot User OAuth Token (starts with xoxb-).</Step>
        <Step n="4">Right-click your standup channel → Copy link → extract the channel ID from the URL.</Step>
        <Step n="5">Update <strong style={{ color: COLORS.text }}>backend/.env</strong>: replace SLACK_BOT_TOKEN, SLACK_CHANNEL_ID, SLACK_SIGNING_SECRET.</Step>
        <Step n="6">Restart the backend: <code style={{ fontFamily: FONTS.mono, fontSize: 12 }}>npm run dev</code> in the backend folder.</Step>
        <Step n="7">Update the Team tab in this dashboard with the new Slack user IDs.</Step>
      </Section>

      <Section title="5. How to Switch Jira Instances" color={COLORS.error}>
        <P>To point at a different Jira cloud instance:</P>
        <Step n="1">Get your new Jira site URL: <code style={{ fontFamily: FONTS.mono, fontSize: 12 }}>https://yourcompany.atlassian.net</code></Step>
        <Step n="2">Log in to <strong style={{ color: COLORS.text }}>id.atlassian.com</strong> → Security → API tokens → Create API token → copy it.</Step>
        <Step n="3">Note the project key (e.g. QG) from your Jira board URL.</Step>
        <Step n="4">Update <strong style={{ color: COLORS.text }}>backend/.env</strong>: JIRA_EMAIL, JIRA_API_TOKEN, JIRA_SITE_URL, JIRA_PROJECT_KEY.</Step>
        <Step n="5">Restart the backend. Test connection from the Connections tab.</Step>
      </Section>

      <Section title="6. How to Deploy" color="#A855F7">
        <P>Frontend deploys to Vercel, backend deploys to Railway (or any Node.js host).</P>
        <Code>{`# Deploy frontend to Vercel
cd sprint-sync-hub/frontend
npx vercel --prod
# Set env var in Vercel dashboard:
# VITE_API_URL=https://your-backend.railway.app

# Deploy backend to Railway
cd sprint-sync-hub/backend
railway login
railway init
railway up
# Add all .env variables in Railway dashboard → Variables tab`}</Code>
        <P>Important: on Railway, add every key from .env as an environment variable in the dashboard. The app reads from process.env, so it works identically in production.</P>
        <P>After deploying, update VITE_API_URL in Vercel to point to your Railway backend URL, then redeploy the frontend.</P>
      </Section>
    </div>
  );
}
