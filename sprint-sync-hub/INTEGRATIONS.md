# Sprint-Sync Hub — Slack & Jira Integration Guide

This document explains every integration point between Sprint-Sync Hub and Slack / Jira: what credentials are needed, what API calls are made, and how data flows into the database.

## Employee checkout reminder

The Overview checkout card is a reminder and validation flow, not an attendance writer:

1. The employee signs in through Slack OpenID Connect (`openid profile email`).
2. The backend validates OAuth state/nonce, restricts the Slack workspace with `SLACK_TEAM_ID`, resolves `members.slack_user_id`, and stores only a hashed opaque session token.
3. The employee connects their own Zoho account. Zoho state is single-use and bound to that employee session. Only `AaaServer.profile.Read` is requested so the backend can verify that the Zoho email matches the verified Slack email.
4. `POST /api/employee/checkout/validate` derives the employee from the session. It checks the current `TIMEZONE` day in `SLACK_CHANNEL_ID` by exact Slack user ID. Existing `standup_posts` may satisfy the check; otherwise Slack channel history is paginated.
5. Top-level messages count. Thread replies, messages from another Slack ID, and messages outside the current local day do not.
6. On `UPDATE_FOUND`, the backend returns the administrator-supplied `ZOHO_CHECKOUT_URL`. The browser opens it in a new tab. No attendance endpoint is called and no punch-out is recorded.

Employee endpoints return `NOT_CONNECTED`, `UPDATE_FOUND`, `UPDATE_MISSING`, or `SLACK_ERROR`. Provider failures are retryable and are not reported as missing updates.

Required checkout settings are `FRONTEND_URL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_TEAM_ID`, `SLACK_OIDC_REDIRECT_URI`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_OAUTH_REDIRECT_URI`, `ZOHO_ACCOUNTS_SERVER`, `ZOHO_CHECKOUT_URL`, `SLACK_CHANNEL_ID`, `TIMEZONE`, and `ENCRYPTION_KEY`. `SLACK_CHANNEL_URL` and `EMPLOYEE_SESSION_TTL_HOURS` are optional.

Zoho `location`, `accounts-server`, and `api_domain` metadata are retained per employee. Refresh and access tokens are AES-256-GCM encrypted with `ENCRYPTION_KEY`; token responses and secrets are never sent to the frontend. Revoked refresh tokens require reconnecting. The optional organization-wide Zoho attendance credential is separate and never proves that an employee connected.

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
8. [GitHub Integration](#github-integration)
9. [Jira Task Sync](#jira-task-sync)
10. [People](#people)

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

---

## GitHub Integration

Read-only. It lists open pull requests, their events, and their reviews, and never writes to GitHub. The token it needs is a **fine-grained personal access token** with *read-only* "Pull requests" and "Metadata" access on the repositories in `GITHUB_REPOS`, and nothing more.

| Variable | Required | Description |
|---|---|---|
| `GITHUB_TOKEN` | Yes | Fine-grained, read-only. Never returned by any endpoint. |
| `GITHUB_REPOS` | Yes | Comma-separated `owner/repo`. Malformed names are reported, not silently ignored. |
| `GITHUB_REVIEW_SLA_HOURS` | No | Working hours before a wait is flagged. Default `24`. |
| `GITHUB_REVIEW_STALE_DAYS` | No | Working days after which a wait is "parked". Default `10`. |
| `GITHUB_REVIEW_IGNORE_LABELS` | No | Comma-separated labels (case-insensitive) that hide a pull request. |
| `GITHUB_CACHE_SECONDS` | No | Response cache. Default `300`; `0` disables. |
| `GITHUB_API_URL` | No | GitHub Enterprise Server. Must be `https`. |
| `REVIEW_NUDGE_TIME` | No | When the optional digest runs. Default `10:30`. |

### How a wait is decided

- **Who owes a review** is the pull request's *current* `requested_reviewers`. GitHub removes a reviewer from that list when they submit a review and puts them back on a re-request, so the list already means "the ball is in this person's court" — including the case where changes were requested and it is the author's turn.
- **Since when** is per reviewer: that reviewer's own most recent `review_requested` event, never earlier than when the pull request became ready for review (`ready_for_review` for a draft that was opened as one).
- **The clock** only runs during `WORK_START_TIME`–`WORK_END_TIME` on working days (`WORKDAYS`) in `TIMEZONE`. There is no holiday calendar, so a public holiday counts as a working day.
- **Pull requests nobody was asked to review** are reported separately — unless a person other than the author has already reviewed them.
- **A pull request is skipped, not guessed at,** when its events cannot be read: defaulting to the opening time would overstate the wait.
- **Left out entirely:** drafts, bot-authored pull requests, bot reviewers, ignored labels.

### Linking people

Set a member's GitHub username on the **Team** tab, or `PATCH /api/members/:memberId/github-login` with `{ "githubLogin": "bob-dev" }` (an empty value unlinks). A pasted `@` is tolerated; the name is validated against GitHub's rules; it must be unique within the organisation, case-insensitively. Reviewers with no linked person are still shown, by username.

### Endpoints

| Method | Endpoint | What it does |
|---|---|---|
| `GET` | `/api/github/status` | Configured or not, and whether the token can actually see each repository. |
| `GET` | `/api/github/reviews` | The full assessment. `?fresh=true` bypasses the cache. |
| `PATCH` | `/api/members/:memberId/github-login` | Link or unlink a GitHub username. |

### Common GitHub errors

| Symptom | Cause | Fix |
|---|---|---|
| `GitHub 404 … the token cannot access it` | GitHub answers 404, not 403, for a repository the token cannot see | Add the repository to the token's access, or correct the name in `GITHUB_REPOS`. `/api/github/status` shows which repository. |
| `GitHub 401 … token is invalid or expired` | Expired or revoked token | Create a new fine-grained token. |
| `rate limit reached` | Too many reads | Raise `GITHUB_CACHE_SECONDS`. |
| The brief shows "Review waits are incomplete" | One or more repositories could not be read | The warning names them; the rest of the brief is unaffected. |

---

## Jira Task Sync

The `jira-task-sync` automation reads every issue in `JIRA_PROJECT_KEY` updated in the last `JIRA_SYNC_LOOKBACK_DAYS` days and writes it to the `tasks` table, hourly at :05. It reads from Jira and writes only to this application's database.

| Variable | Default | Description |
|---|---|---|
| `JIRA_SYNC_LOOKBACK_DAYS` | `120` | Days of history read (max 730). |
| `JIRA_SPRINT_FIELD` | `customfield_10020` | The Sprint custom field's id on your instance. |

### What it decides

- **Done** comes from the status *category* (`statusCategory.key === "done"`); status names are per-workflow. The name list (`done`, `closed`, `resolved`…) is only a fallback for an issue that arrives with no category.
- **When it was finished** is Jira's `resolutiondate`. A task finished months ago and first seen today is dated when it was finished. A reopened task has its completion cleared.
- **Assignee and due date** are overwritten from Jira, including with *nothing* when Jira has cleared them. People are matched by Jira account id, then by email; assignees who are not linked to a team member are left unassigned and counted.
- **Sprint:** an issue in the *active* Jira sprint is attached to the active sprint here. An issue in no sprint, or only closed or future ones, keeps whatever attachment it already had.
- **"No movement"** in the brief uses Jira's own `updated` time (comments, edits and status changes all move it).

### What it says when something is wrong

Written to the activity log as a failure (once a day per distinct problem, not every hour), and returned in the run summary:

| Message | Meaning | Fix |
|---|---|---|
| `None of the N issues carried the sprint field …` | `JIRA_SPRINT_FIELD` is wrong for this instance | Set it to your Sprint field id. |
| `Jira returned more issues than the sync reads in one run` | The read stopped at its page cap | Lower `JIRA_SYNC_LOOKBACK_DAYS`. |
| `There is no active sprint in the database` | Nothing could be attached to a sprint | Create or activate a sprint. |
| `N of M issues are assigned to people who are not linked` | Jira IDs are missing on the Team tab | Run the member sync, or set IDs by hand. |

### Limits worth knowing

- An issue **deleted** in Jira stays in the table as it was last seen; deletion is not detected.
- "Added after the sprint started" is judged from an issue's *creation* date. An old backlog item pulled into the sprint mid-sprint is not seen as scope added.
- The sprint field is read from Jira Cloud's object form. Older Jira Server instances encode sprints as strings, which are not parsed.
- This was verified against real Jira payload shapes and a scratch database, **not against your own Jira instance**. Check the first run's summary.

---

## People

Three things for the lead, all on the **People** tab and all addressed to the lead only (`TEAM_LEAD_SLACK_ID`, falling back to `MANAGER_SLACK_ID`). Two are scheduled automations under the `people` category; the evidence pack is on demand.

| Automation | Key | When | Default |
|---|---|---|---|
| 1:1 prep | `one-on-one-prep` | `ONE_ON_ONE_PREP_TIME` on working days, for people whose 1:1 is that day | on — does nothing until a 1:1 day is set |
| Recognition suggestions | `weekly-recognition` | `RECOGNITION_DAY` at `RECOGNITION_TIME` | on |

### Data

Migration `022_one_on_ones.sql` adds `members.one_on_one_weekday` / `one_on_one_cadence`, and the tables `one_on_ones` (date, notes) and `one_on_one_actions` (follow-ups, owner `lead` or `member`). Notes and follow-up text are encrypted with `ENCRYPTION_KEY`; if that key changes, they cannot be read.

Fortnightly and monthly cadences count from the last 1:1 **recorded** (at least 10 and 24 days), so a 1:1 moved by a few days does not push the next one a whole cycle away. Until one is recorded, a fortnightly person gets prep every week.

### Rules it keeps

- **Facts with sources, turned into questions.** Topics are fixed rules ("QG-7 has not moved in 6 days — is anything in the way?"), not model output. No model writes anything about a person.
- **No presence measurement.** Standup counts, hours online and after-hours activity are not used.
- **No rankings.** Recognition lists people alphabetically and only says "closed N tasks" when there is nothing more specific.
- **Says what it cannot see.** The evidence pack ends with its limits: due dates are compared with each task's *current* due date (moves are not recorded), and work outside Jira and GitHub is invisible.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/people` | Members with 1:1 day, last 1:1 and open follow-ups |
| PATCH | `/api/people/:memberId/schedule` | `{ weekday: 0-6 \| null, cadence }` |
| GET | `/api/people/:memberId/prep` | The prep pack, as JSON and as the DM text |
| GET / POST | `/api/people/:memberId/one-on-ones` | Recent 1:1s; record one `{ heldOn, notes, actions: [{ owner, text }] }` |
| PATCH | `/api/people/actions/:actionId` | `{ done: true \| false }` |
| GET | `/api/people/recognition?from=&to=` | Defaults to the last seven days |
| GET | `/api/people/:memberId/evidence?from=&to=[&format=md]` | Up to 400 days |

GitHub data (reviews given, PRs merged) needs `GITHUB_TOKEN`/`GITHUB_REPOS` and the person's GitHub username on the Team tab. Reviews are counted on pull requests merged in the period, up to 120 per read.
