# Sprint-Sync Hub — Slack & Jira Integration Guide

This document explains every integration point between Sprint-Sync Hub and Slack / Jira: what credentials are needed, what API calls are made, and how data flows into the database.

---

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Slack Integration](#slack-integration)
   - [How the Slack client is created](#how-the-slack-client-is-created)
   - [Required bot scopes](#required-bot-scopes)
   - [Fetching email addresses from Slack](#fetching-email-addresses-from-slack)
   - [Fetching a Slack user ID](#fetching-a-slack-user-id)
   - [Sending DMs](#sending-dms)
   - [Reading channel messages](#reading-channel-messages)
   - [Posting to a channel](#posting-to-a-channel)
3. [Jira Integration](#jira-integration)
   - [How the Jira client is created](#how-the-jira-client-is-created)
   - [Fetching Jira account IDs for team members](#fetching-jira-account-ids-for-team-members)
   - [Fetching sprint issues](#fetching-sprint-issues)
   - [Fetching overdue issues](#fetching-overdue-issues)
   - [Creating a Jira issue](#creating-a-jira-issue)
   - [Creating a sprint](#creating-a-sprint)
   - [Transitioning an issue status](#transitioning-an-issue-status)
   - [Posting a comment on an issue](#posting-a-comment-on-an-issue)
4. [Member Data Sync Flow](#member-data-sync-flow)
5. [Manual Jira ID Override](#manual-jira-id-override)
6. [API Endpoints Reference](#api-endpoints-reference)
7. [Common Errors & Fixes](#common-errors--fixes)

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SLACK_BOT_TOKEN` | Yes | Bot OAuth token (`xoxb-…`) |
| `SLACK_CHANNEL_ID` | Yes | Slack channel to read standups from |
| `SLACK_SIGNING_SECRET` | Yes | Used to verify incoming Slack event payloads |
| `JIRA_EMAIL` | Yes | Atlassian account email used to generate the API token |
| `JIRA_API_TOKEN` | Yes | Jira API token from id.atlassian.com/manage-profile/security/api-tokens |
| `JIRA_SITE_URL` | Yes | e.g. `https://yourcompany.atlassian.net` |
| `JIRA_CLOUD_ID` | Yes | Cloud ID from Atlassian — found in `JIRA_SITE_URL/_edge/tenant_info` |
| `JIRA_PROJECT_KEY` | Yes | Short project key, e.g. `QG` |
| `JIRA_BOARD_ID` | No | If set, skips the board lookup API call on every boot |

---

## Slack Integration

### How the Slack client is created

**File:** `backend/services/slackService.js`

```js
const { WebClient } = require('@slack/web-api');

function getClient() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN is not set');
  return new WebClient(token);
}
```

Every function calls `getClient()` to get a fresh `WebClient` instance, which automatically handles retries and rate limiting via the `@slack/web-api` SDK.

---

### Required bot scopes

Go to **api.slack.com/apps → your app → OAuth & Permissions → Bot Token Scopes** and add:

| Scope | Why it's needed |
|---|---|
| `channels:history` | Read messages from public channels |
| `groups:history` | Read messages from private channels |
| `im:history` | Read DM history |
| `im:write` | Open DM conversations (`conversations.open`) |
| `chat:write` | Send messages and DMs |
| `users:read` | Basic user profile lookup (`users.info`) |
| `users:read.email` | Read the email field from user profiles — **required for email sync** |

After adding `users:read.email` you must click **Reinstall to Workspace** to generate a new bot token.

---

### Fetching email addresses from Slack

**Triggered by:** `POST /api/members/fetch-slack-emails`  
**Function:** `slackService.fetchAndStoreSlackEmails(organisationId)`

**Flow:**

1. Load all members from the DB for this organisation.
2. Skip members who already have an email stored.
3. Skip members with no `slack_user_id` on record.
4. For each remaining member, call Slack's `users.info` API:

```js
const response = await slack.users.info({ user: member.slack_user_id });
const email = response.user.profile.email;
```

5. If an email is returned, save it to the `members` table via `memberRepository.updateEmail()`.
6. A 100 ms delay is added between each request to respect Slack rate limits.

**What the API returns:**

```json
{
  "ok": true,
  "user": {
    "id": "U074QLDJQ5P",
    "profile": {
      "real_name": "Ashwin",
      "display_name": "ashwin",
      "email": "ashwin@company.com"
    }
  }
}
```

**Why email can be missing even with `ok: true`:**
- The `users:read.email` scope is not added to the bot token.
- The Slack user has set their email visibility to private in their profile settings.

---

### Fetching a Slack user ID

**There is no automatic lookup of Slack user IDs.** Slack user IDs (`U0XXXXXXX`) must be provided upfront when adding a team member, either via:

- The `TEAM_MEMBERS` JSON array in `.env` — each entry requires an `id` field which is the Slack user ID.
- The Config UI, which writes to the same `TEAM_MEMBERS` config.

On server boot, `server.js` reads `cfg.teamMembers` and calls `memberRepository.findOrCreate(orgId, m.id, m.name, ...)` — inserting each member with their Slack user ID.

**How to find a Slack user ID manually:**
- In Slack, open the member's profile → click the three-dot menu → **Copy member ID**.

---

### Sending DMs

**Function:** `slackService.sendDM(userId, text)`

```js
const slack = getClient();
const conv = await slack.conversations.open({ users: userId });
await slack.chat.postMessage({
  channel: conv.channel.id,
  text,
});
```

Used for: standup reminders, overdue task alerts, checkout nudges, mismatch notifications.  
Only members with at least one **technical role** receive automated DMs. Members with only managerial roles are excluded.

---

### Reading channel messages

**Function:** `slackService.getChannelMessages(channelId, oldestTs, latestTs)`

```js
await slack.conversations.history({
  channel: channelId,
  oldest: oldestTs,
  latest: latestTs,
  limit: 200,
});
```

Used by the cron jobs to read standup posts from the configured Slack channel.

---

### Posting to a channel

**Function:** `slackService.postToChannel(channelId, text)`

```js
await slack.chat.postMessage({ channel: channelId, text });
```

Used for sprint summaries and team-wide announcements.

---

## Jira Integration

### How the Jira client is created

**File:** `backend/services/jiraService.js`

Two clients are used — one for the standard REST API, one for the Agile API:

```js
// Standard REST API — issues, comments, transitions, user search
axios.create({
  baseURL: `${JIRA_SITE_URL}/rest/api/3`,
  headers: { Authorization: `Basic base64(email:token)` },
});

// Agile API — boards, sprints
axios.create({
  baseURL: `${JIRA_SITE_URL}/rest/agile/1.0`,
  headers: { Authorization: `Basic base64(email:token)` },
});
```

Authentication uses **HTTP Basic Auth** with the Atlassian account email and an API token (not the account password).

---

### Fetching Jira account IDs for team members

**Triggered by:** `POST /api/members/fetch-jira-ids`  
**Function:** `jiraService.fetchAndStoreJiraAccountIds(organisationId)`

**Prerequisite:** members must have an email stored first (run Slack email sync first, or use `POST /api/members/sync-all`).

**Flow:**

1. Load all members from DB.
2. Skip members whose Jira ID was set manually (`source = 'manual'`).
3. Skip members with no email.
4. For each remaining member, call Jira's user search API:

```js
GET /rest/api/3/user/search?query=ashwin@company.com
```

5. Find the result whose `emailAddress` exactly matches (case-insensitive). Falls back to the first result if no exact match.
6. Save `accountId` to `members.jira_account_id` with `source = 'auto'`.
7. A 200 ms delay is added between requests to avoid Jira rate limits.

**What the API returns:**

```json
[
  {
    "accountId": "5b10a2844c20165700ede21g",
    "displayName": "Ashwin",
    "emailAddress": "ashwin@company.com",
    "active": true
  }
]
```

The `accountId` is what gets stored and later used to assign Jira issues to team members.

---

### Fetching sprint issues

**Function:** `jiraService.getSprintIssues(projectKey, startDate, endDate)`

```js
GET /rest/api/3/search/jql
  ?jql=project = "QG" AND updated >= "2026-05-18" AND updated <= "2026-06-01"
  &fields=summary,status,assignee,duedate,priority,issuetype
```

Returns: `key`, `summary`, `status`, `assigneeEmail`, `assigneeName`, `duedate`, `priority`.

Used by the cron job to pull the current sprint's tasks and match them to DB members.

---

### Fetching overdue issues

**Function:** `jiraService.getOverdueIssues(projectKey)`

```js
GET /rest/api/3/search/jql
  ?jql=project = "QG" AND duedate < "2026-06-05" AND status != Done
  &fields=summary,status,assignee,duedate,priority
```

Returns issues past their due date, enriched with a `daysOverdue` count. Used by the daily deadline check cron to send DM alerts to assignees.

---

### Creating a Jira issue

**Function:** `jiraService.createIssue(projectKey, summary, description, priority, assigneeAccountId, dueDate, sprintId, issueType)`

```js
POST /rest/api/3/issue
{
  "fields": {
    "project": { "key": "QG" },
    "summary": "Build login page",
    "issuetype": { "name": "Task" },
    "priority": { "name": "High" },
    "assignee": { "id": "5b10a2844c20165700ede21g" },
    "duedate": "2026-06-15",
    "customfield_10020": { "id": 42 }   // sprint ID
  }
}
```

`assigneeAccountId` is the Jira `accountId` fetched and stored in the member sync step. If no Jira account ID is stored for a member, the issue is created unassigned.

---

### Creating a sprint

**Function:** `jiraService.createSprint(projectKey, name, startDate, endDate, boardId)`

```js
POST /rest/agile/1.0/sprint
{
  "name": "Sprint 1",
  "startDate": "2026-05-18T09:00:00.000Z",
  "endDate": "2026-06-01T18:00:00.000Z",
  "originBoardId": 7
}
```

Requires the **Manage Sprints** permission in Jira. If missing, the API returns 403.

---

### Transitioning an issue status

**Function:** `jiraService.transitionIssue(issueKey, statusName)`

1. `GET /rest/api/3/issue/{key}/transitions` — fetch all available transitions.
2. Find the transition whose `name` matches `statusName` (case-insensitive).
3. `POST /rest/api/3/issue/{key}/transitions` with the matched transition ID.

---

### Posting a comment on an issue

**Function:** `jiraService.addComment(issueKey, commentText)`

```js
POST /rest/api/3/issue/{key}/comment
{
  "body": {
    "type": "doc",
    "version": 1,
    "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "..." }] }]
  }
}
```

Jira's REST API v3 uses Atlassian Document Format (ADF) for rich text, not plain strings.

---

## Member Data Sync Flow

The full sync order matters — each step depends on the previous one:

```
TEAM_MEMBERS config (Slack user IDs set manually)
        │
        ▼
members table populated on server boot (findOrCreate)
        │
        ▼
POST /api/members/fetch-slack-emails
  → slack.users.info(slack_user_id) → saves email
        │
        ▼
POST /api/members/fetch-jira-ids
  → GET /user/search?query=email → saves jira_account_id
        │
        ▼
Sprint Planning: createIssue uses jira_account_id to assign tasks
```

`POST /api/members/sync-all` runs both email and Jira ID sync in sequence automatically. It also runs automatically on server startup if no emails are found in the DB.

---

## Manual Jira ID Override

If the automatic Jira ID lookup fails for a member (e.g. their Jira email differs from their Slack email), you can set it manually from the Team tab:

```
PATCH /api/members/:memberId/jira-id
Body: { "jiraAccountId": "5b10a2844c20165700ede21g" }
```

Manually set IDs are stored with `source = 'manual'` and are **never overwritten** by the auto-sync. They show a "manual" badge in the Team tab UI.

---

## API Endpoints Reference

| Method | Endpoint | What it does |
|---|---|---|
| `GET` | `/api/members` | List all members with roles, email, Jira ID |
| `GET` | `/api/members/jira-id-status` | Per-member Jira ID status report |
| `PATCH` | `/api/members/:id/jira-id` | Manually set a Jira account ID |
| `POST` | `/api/members/fetch-slack-emails` | Pull emails from Slack for all members |
| `POST` | `/api/members/fetch-jira-ids` | Look up Jira account IDs by email |
| `POST` | `/api/members/sync-all` | Run email sync then Jira ID sync in sequence |

---

## Common Errors & Fixes

| Error | Cause | Fix |
|---|---|---|
| `email: undefined` from `users.info` | `users:read.email` scope missing | Add scope in api.slack.com/apps, reinstall app, update `SLACK_BOT_TOKEN` |
| `missing_scope` from Slack | Bot token lacks the required scope | Add the scope, reinstall the app |
| `user_not_found` from Slack | `slack_user_id` is wrong or user was deactivated | Correct the ID in the Config UI |
| `401` from Jira | Wrong `JIRA_EMAIL` or `JIRA_API_TOKEN` | Regenerate the API token at id.atlassian.com |
| `403` from Jira sprint creation | Account lacks Manage Sprints permission | Ask Jira admin to grant it |
| `No Jira user found with this email` | Member's Jira account uses a different email | Use the manual Jira ID override in the Team tab |
| `jira_account_id` is null after sync | Email sync hasn't run yet | Run `POST /api/members/sync-all` |
