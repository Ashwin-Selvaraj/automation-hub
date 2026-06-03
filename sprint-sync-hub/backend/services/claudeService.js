'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

let anthropic = null;

/**
 * Returns a singleton Anthropic client.
 * @returns {Anthropic}
 */
function getClient() {
  if (!anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY is not configured');
    }
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return anthropic;
}

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1000;

const MATCH_SYSTEM_PROMPT = `You are a Jira automation assistant. Analyse a developer's standup message and determine if it refers to one of the provided Jira tasks. Use semantic understanding, not just keywords. Consider: task title similarity, technical terms, feature names, action verbs (completed, fixed, deployed, working on, reviewed, merged). Respond ONLY with valid JSON matching the exact schema provided. No preamble, no explanation.

Additionally, determine the matchType:
- "assigned_task": the message matches a task that IS assigned to this specific member
- "unassigned_task": the message matches a task that EXISTS in Jira but is assigned to someone else or unassigned
- "different_project": the work described doesn't match any task but seems related to a different project area
- "no_match": no Jira task matches the described work at all

For mismatchDetails: if matchType is not "assigned_task", write one sentence describing
what the mismatch is e.g. "Member is working on payment gateway but their assigned task
is coupon security middleware."`;

/**
 * Analyses a standup message and attempts to match it to a Jira task.
 * @param {string} messageText       - The Slack standup message
 * @param {string} memberName        - Team member's display name
 * @param {Array<{ key: string, summary: string, status: string }>} jiraTasks - Current sprint tasks
 * @param {string} sprintName        - Name of the current sprint
 * @param {Array<{ key: string, summary: string }>} [assignedTasks] - Tasks assigned to this member
 * @returns {Promise<{
 *   matched: boolean, confidence: number,
 *   issueKey: string|null, issueTitle: string|null,
 *   suggestedStatus: string, commentText: string, reason: string,
 *   matchType: "assigned_task"|"unassigned_task"|"different_project"|"no_match",
 *   mismatchDetails: string|null
 * }>}
 */
async function matchHuddleToJira(messageText, memberName, jiraTasks, sprintName, assignedTasks) {
  try {
    const client = getClient();

    // Split tasks: assigned to this member vs all others
    const assignedKeys = new Set((assignedTasks || []).map((t) => t.key));

    const assignedList = (assignedTasks && assignedTasks.length > 0)
      ? assignedTasks.map((t) => `  [${t.key}] ${t.summary} (Status: ${t.status || 'To Do'})`).join('\n')
      : '  (none)';

    const otherTasks = jiraTasks.filter((t) => !assignedKeys.has(t.key));
    const otherList = otherTasks.length > 0
      ? otherTasks.map((t) => `  [${t.key}] ${t.summary} (Status: ${t.status})`).join('\n')
      : '  (none)';

    const userPrompt = `Standup message from ${memberName} in ${sprintName}:
"${messageText}"

Tasks assigned to ${memberName} this sprint:
${assignedList}

All other tasks in sprint (not assigned to ${memberName}):
${otherList}

Respond with a JSON object matching this exact schema:
{
  "matched": boolean,
  "confidence": number (0-100),
  "issueKey": string or null,
  "issueTitle": string or null,
  "suggestedStatus": string (one of: "To Do", "In Progress", "In Review", "Done"),
  "commentText": string (max 2 sentences, written as a standup log entry),
  "reason": string (brief explanation of your decision),
  "matchType": "assigned_task" | "unassigned_task" | "different_project" | "no_match",
  "mismatchDetails": string or null
}`;

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: MATCH_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = res.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude returned no JSON object');

    const parsed = JSON.parse(jsonMatch[0]);

    // Back-compat: derive matchType from old-style matched boolean if missing
    let matchType = parsed.matchType || null;
    if (!matchType) {
      if (parsed.matched && parsed.confidence >= 70 && parsed.issueKey) {
        matchType = assignedKeys.has(parsed.issueKey) ? 'assigned_task' : 'unassigned_task';
      } else {
        matchType = 'no_match';
      }
    }

    return {
      matched:        Boolean(parsed.matched),
      confidence:     Number(parsed.confidence) || 0,
      issueKey:       parsed.issueKey || null,
      issueTitle:     parsed.issueTitle || null,
      suggestedStatus: parsed.suggestedStatus || 'In Progress',
      commentText:    parsed.commentText || '',
      reason:         parsed.reason || '',
      matchType,
      mismatchDetails: parsed.mismatchDetails || null,
    };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] claudeService.matchHuddleToJira error:`, err.message);
    throw new Error(`Claude matchHuddleToJira failed: ${err.message}`);
  }
}

/**
 * Draft a clarification DM for a member whose standup doesn't match their assigned tasks.
 * @param {string} memberName
 * @param {string} messageText
 * @param {Array<{key:string,title:string}>} assignedTasks
 * @param {string} matchType
 * @param {string} mismatchDetails
 * @param {string} sprintName
 * @returns {Promise<string>}
 */
async function draftMismatchDM(memberName, messageText, assignedTasks, matchType, mismatchDetails, sprintName) {
  try {
    const client = getClient();

    const taskLines = (assignedTasks || [])
      .map((t) => `  • ${t.key || t.jira_key}: ${t.title || t.summary}`)
      .join('\n') || '  (no tasks assigned yet)';

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 250,
      system: `You are a friendly team assistant. Write a short Slack DM to a developer
whose standup update doesn't clearly align with their assigned sprint tasks.

Tone rules:
- Warm and non-accusatory — they may be doing legitimate work
- Do not assume they are doing something wrong
- Give them an easy way to respond
- Maximum 4 sentences
- End with "— Sprint-Sync Hub"
- Never say "you should", "you must", or "you need to"`,
      messages: [{
        role: 'user',
        content: `Member: ${memberName}
Their standup said: "${messageText}"
Their assigned tasks this sprint (${sprintName}):
${taskLines}

Situation: ${mismatchDetails || 'The update does not clearly match any assigned sprint task.'}

Write a DM asking them to clarify whether this work is related to their
sprint tasks or if a new Jira task should be created for it.`,
      }],
    });

    return res.content[0]?.text?.trim() ||
      `Hey ${memberName} 👋 Your update today mentions work that doesn't clearly match your assigned sprint tasks for ${sprintName}. Could you let us know if this is related to one of your current tasks, or whether we should create a new Jira task to track it? — Sprint-Sync Hub`;
  } catch (err) {
    console.error('[claudeService.draftMismatchDM]', err.message);
    return `Hey ${memberName} 👋 Your standup update today doesn't appear to match your assigned tasks in ${sprintName}. Could you clarify whether this work is related to an existing sprint task or if a new one should be created? — Sprint-Sync Hub`;
  }
}

/**
 * Draft a private alert DM to the team lead about a task mismatch.
 * Factual and concise — not a complaint, just information.
 * @param {string} memberName
 * @param {string} messageText
 * @param {string} matchType
 * @param {string} mismatchDetails
 * @param {Array<{key:string,title:string}>} assignedTasks
 * @returns {Promise<string>}
 */
async function draftTeamLeadAlert(memberName, messageText, matchType, mismatchDetails, assignedTasks) {
  try {
    const client = getClient();

    const taskLines = (assignedTasks || [])
      .map((t) => `  • ${t.key || t.jira_key}: ${t.title || t.summary}`)
      .join('\n') || '  (no tasks assigned)';

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: `You are a team management assistant. Write a brief private Slack DM
to a team lead alerting them to a potential task mismatch.

Rules:
- Factual and concise — 3 sentences maximum
- Present the facts only, no judgement
- Suggest one simple action the lead can take
- No emojis except a single ⚠️ at the start
- Sign off as "Sprint-Sync Hub"`,
      messages: [{
        role: 'user',
        content: `Team member: ${memberName}
Their standup: "${messageText}"
Situation: ${mismatchDetails || 'The update does not match their assigned sprint tasks.'}
Match type: ${matchType}
Their assigned sprint tasks:
${taskLines}

Write the alert now.`,
      }],
    });

    return res.content[0]?.text?.trim() ||
      `⚠️ ${memberName} posted a standup update that doesn't clearly match their assigned sprint tasks. ${mismatchDetails || ''} You may want to check in with them or update their sprint assignment. — Sprint-Sync Hub`;
  } catch (err) {
    console.error('[claudeService.draftTeamLeadAlert]', err.message);
    return `⚠️ ${memberName}'s standup update today doesn't appear to match their assigned sprint tasks. ${mismatchDetails || ''} You may want to follow up. — Sprint-Sync Hub`;
  }
}

/**
 * Drafts a friendly DM for a message that didn't match any Jira task.
 * @param {string} memberName - Team member's display name
 * @param {string} messageText - The original standup message
 * @param {string} jiraSiteUrl - Jira site URL
 * @param {string} projectKey - Jira project key
 * @param {string} sprintName - Current sprint name
 * @returns {Promise<string>} DM text to send
 */
async function draftNoMatchDM(memberName, messageText, jiraSiteUrl, projectKey, sprintName) {
  try {
    const client = getClient();
    const boardUrl = `${jiraSiteUrl.replace(/\/$/, '')}/jira/software/projects/${projectKey}/boards`;

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: `Draft a friendly Slack DM for a developer named ${memberName} whose standup update ("${messageText}") didn't match any Jira task in ${sprintName}.

The DM must follow this exact 3-line structure:
Line 1: "Hey ${memberName} 👋 I noticed your update about [specific thing they mentioned] — sounds like solid progress!"
Line 2: "I couldn't find a matching Jira task for this work in ${sprintName}. Logging it helps the team track velocity and makes sure your effort shows up in the weekly report."
Line 3: "Could you create a task here? → ${boardUrl}"

Fill in [specific thing they mentioned] based on the message. Keep the rest of each line verbatim. Return only the 3-line DM, nothing else.`,
        },
      ],
    });

    return res.content[0]?.text?.trim() || `Hey ${memberName} 👋 Could you add your work to Jira? → ${boardUrl}`;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] claudeService.draftNoMatchDM error:`, err.message);
    throw new Error(`Claude draftNoMatchDM failed: ${err.message}`);
  }
}

/**
 * Drafts a gentle reminder DM for a team member who hasn't posted a standup update.
 * @param {string} memberName - Team member's display name
 * @param {string} channelName - Slack channel name (without #)
 * @param {string} sprintName - Current sprint name
 * @returns {Promise<string>} DM text to send
 */
async function draftMissingUpdateDM(memberName, channelName, sprintName) {
  try {
    const client = getClient();

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: `Write a short, friendly Slack DM reminding ${memberName} to post their daily standup update in #${channelName} for ${sprintName}. Keep it under 3 sentences, warm but professional. Start with "Hey ${memberName} 👋". Don't be preachy. Return only the DM text.`,
        },
      ],
    });

    return res.content[0]?.text?.trim() || `Hey ${memberName} 👋 Quick reminder to drop your standup update in #${channelName} today!`;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] claudeService.draftMissingUpdateDM error:`, err.message);
    throw new Error(`Claude draftMissingUpdateDM failed: ${err.message}`);
  }
}

/**
 * Drafts a DM alerting a team member about an overdue Jira issue.
 * @param {string} memberName - Team member's display name
 * @param {string} issueKey - Jira issue key
 * @param {string} issueTitle - Jira issue summary
 * @param {number} daysOverdue - Number of days past due date
 * @param {string} issueUrl - Direct URL to the Jira issue
 * @returns {Promise<string>} DM text to send
 */
async function draftDeadlineDM(memberName, issueKey, issueTitle, daysOverdue, issueUrl) {
  try {
    const client = getClient();

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: `Write a brief, professional but empathetic Slack DM to ${memberName} about their overdue Jira issue.

Issue: ${issueKey} — "${issueTitle}"
Days overdue: ${daysOverdue}
Link: ${issueUrl}

Keep it under 4 sentences. Be direct but kind. Offer to help if blocked. Include the issue link. Start with "Hey ${memberName} 👋". Return only the DM text.`,
        },
      ],
    });

    return res.content[0]?.text?.trim() || `Hey ${memberName} 👋 ${issueKey} — "${issueTitle}" is ${daysOverdue} day(s) overdue. Could you update the status? ${issueUrl}`;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] claudeService.draftDeadlineDM error:`, err.message);
    throw new Error(`Claude draftDeadlineDM failed: ${err.message}`);
  }
}

/**
 * Generates a formatted weekly sprint report for posting to Slack.
 * @param {string} weekLabel - e.g. "Week 1" or "Full Sprint"
 * @param {Array<{ name: string, updateCount: number, workingDays: number, updates: string[] }>} memberActivity
 * @param {Array<{ key: string, summary: string, status: string, daysOverdue?: number }>} jiraTasks
 * @param {string} sprintName - Current sprint name
 * @returns {Promise<string>} Formatted Slack message string
 */
async function generateWeeklyReport(weekLabel, memberActivity, jiraTasks, sprintName) {
  try {
    const client = getClient();

    const activitySummary = memberActivity
      .map((m) => `${m.name}: ${m.updateCount}/${m.workingDays} updates posted\nSample updates: ${m.updates.slice(0, 3).join(' | ')}`)
      .join('\n\n');

    const overdueTasks = jiraTasks.filter((t) => t.daysOverdue > 0);
    const overdueList = overdueTasks.map((t) => `${t.key}: ${t.summary} (${t.daysOverdue} days overdue)`).join('\n');
    const taskList = jiraTasks.map((t) => `${t.key}: ${t.summary} — ${t.status}`).join('\n');

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user',
          content: `Generate a ${weekLabel} sprint report for ${sprintName} in this EXACT format (use Slack mrkdwn):

📊 *${sprintName} · ${weekLabel} Report*
[date range for this period]

📦 *Delivered This Week*
• [member]: [what they completed based on their updates]
• [member]: [what they completed]

⚠️ *Needs Attention*
• [overdue task key]: [title] — [X] days overdue
• [member]: only [N]/[total working days] updates posted

👥 *Engagement Scores*
• [member]: [N]/[total] updates
• ...

🏆 *Shoutout*
[one person, one sentence, specific achievement from their updates]

📝 *Manager's Note*
[one sentence summary of the week's velocity and mood]

Team activity data:
${activitySummary}

Jira tasks:
${taskList || 'No tasks found'}

Overdue:
${overdueList || 'None'}

Return only the formatted report, no extra text.`,
        },
      ],
    });

    return res.content[0]?.text?.trim() || `📊 *${sprintName} · ${weekLabel} Report*\n\nNo data available for this period.`;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] claudeService.generateWeeklyReport error:`, err.message);
    throw new Error(`Claude generateWeeklyReport failed: ${err.message}`);
  }
}

/**
 * Detects whether a Slack message contains multi-date standup updates (bulk posting).
 * If yes, returns an array of { date, updates[] } objects.
 * If no, returns null (treat as a single-day message).
 *
 * @param {string} messageText
 * @param {string} memberName
 * @returns {Promise<Array<{ date: string, updates: string[] }> | null>}
 */
async function parseMultiDateStandup(messageText, memberName) {
  try {
    const client = getClient();

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: 'You are a standup message parser. Detect if a message contains updates for multiple dates (bulk posting). Respond ONLY with valid JSON.',
      messages: [{
        role: 'user',
        content: `Analyze this standup message from ${memberName}:

"""
${messageText}
"""

Does this message contain updates for MULTIPLE dates? Look for date patterns like "25/5/2026", "25 May", "Monday", "Yesterday", etc. as section headers.

If YES (multi-date bulk post), respond with:
{
  "isMultiDate": true,
  "entries": [
    { "date": "YYYY-MM-DD", "updates": ["update 1", "update 2"] },
    ...
  ],
  "note": "Posted X days of updates in a single message on [actual post date]"
}

If NO (single day update), respond with:
{
  "isMultiDate": false,
  "entries": null
}

Today's date for reference: ${new Date().toISOString().split('T')[0]}
Only use confirmed dates from the message. Do not invent dates. Respond with JSON only.`,
      }],
    });

    const text = res.content[0]?.text || '{}';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.isMultiDate || !Array.isArray(parsed.entries)) return null;
    return { entries: parsed.entries, note: parsed.note || '' };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] claudeService.parseMultiDateStandup error:`, err.message);
    return null; // non-fatal — fall back to treating as single-day
  }
}

/**
 * Tests the Anthropic API connection with a minimal request.
 * @returns {Promise<boolean>}
 */
/**
 * Draft a friendly Slack DM for a member who checked out without posting a standup.
 * Warm and non-scolding — acknowledges they have left and gently asks for a quick update.
 *
 * @param {string} memberName   - Member's display name e.g. "Akhil"
 * @param {string} channelName  - Standup channel name e.g. "tech-huddle"
 * @param {string} checkoutTime - Time they checked out e.g. "18:32"
 * @param {string} sprintName   - Current sprint name e.g. "Sprint 12"
 * @returns {Promise<string>}   - The DM text ready to send
 */
async function draftCheckoutNudgeDM(memberName, channelName, checkoutTime, sprintName) {
  try {
    const client = getClient();
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      system: `You are a friendly team assistant. Write a short Slack DM to a developer who just checked out of the office without posting their daily standup update.

Rules:
- Warm and friendly, never scolding or passive aggressive
- Acknowledge they have already left for the day — do not ask them to come back
- Ask them to post a quick update in the standup channel when they have a moment
- Mention it helps the team and feeds into the sprint report
- Maximum 3 sentences
- No bullet points
- End with a friendly sign-off from "Sprint-Sync Hub"
- Do not use the word "forgot" — use "haven't had a chance to" instead`,
      messages: [{
        role: 'user',
        content: `Member name: ${memberName}
Checked out at: ${checkoutTime}
Standup channel: #${channelName}
Current sprint: ${sprintName}

Write the DM now.`,
      }],
    });
    return res.content[0]?.text?.trim() ||
      `Hey ${memberName} 👋 Looks like you haven't had a chance to post your standup in #${channelName} today — no worries since you've already wrapped up! Whenever you get a moment, a quick update would help the team and keep the ${sprintName} report accurate. — Sprint-Sync Hub`;
  } catch (err) {
    console.error('[claudeService.draftCheckoutNudgeDM]', err.message);
    return `Hey ${memberName} 👋 Looks like you haven't had a chance to post your standup in #${channelName} today — no worries since you've already wrapped up for the day! Whenever you get a moment, a quick update would really help the team stay in sync for ${sprintName}. — Sprint-Sync Hub`;
  }
}

async function testConnection() {
  try {
    const client = getClient();
    await client.messages.create({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: 'ping' }],
    });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  matchHuddleToJira,
  draftNoMatchDM,
  draftMissingUpdateDM,
  draftDeadlineDM,
  draftCheckoutNudgeDM,
  draftMismatchDM,
  draftTeamLeadAlert,
  generateWeeklyReport,
  parseMultiDateStandup,
  testConnection,
};
