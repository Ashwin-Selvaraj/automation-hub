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

const MATCH_SYSTEM_PROMPT = `You are a Jira automation assistant. Analyse a developer's standup message and determine if it refers to one of the provided Jira tasks. Use semantic understanding, not just keywords. Consider: task title similarity, technical terms, feature names, action verbs (completed, fixed, deployed, working on, reviewed, merged). Respond ONLY with valid JSON matching the exact schema provided. No preamble, no explanation.`;

/**
 * Analyses a standup message and attempts to match it to a Jira task.
 * @param {string} messageText - The Slack standup message
 * @param {string} memberName - Team member's display name
 * @param {Array<{ key: string, summary: string, status: string }>} jiraTasks - Current sprint tasks
 * @param {string} sprintName - Name of the current sprint
 * @returns {Promise<{ matched: boolean, confidence: number, issueKey: string|null, issueTitle: string|null, suggestedStatus: string, commentText: string, reason: string }>}
 */
async function matchHuddleToJira(messageText, memberName, jiraTasks, sprintName) {
  try {
    const client = getClient();

    const taskList = jiraTasks
      .map((t, i) => `${i + 1}. [${t.key}] ${t.summary} (Status: ${t.status})`)
      .join('\n');

    const userPrompt = `Standup message from ${memberName} in ${sprintName}:
"${messageText}"

Jira tasks in this sprint:
${taskList || 'No tasks found'}

Respond with a JSON object matching this exact schema:
{
  "matched": boolean,
  "confidence": number (0-100),
  "issueKey": string or null,
  "issueTitle": string or null,
  "suggestedStatus": string (one of: "To Do", "In Progress", "In Review", "Done"),
  "commentText": string (max 2 sentences, written as a standup log entry),
  "reason": string (brief explanation of your decision)
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
    return {
      matched: Boolean(parsed.matched),
      confidence: Number(parsed.confidence) || 0,
      issueKey: parsed.issueKey || null,
      issueTitle: parsed.issueTitle || null,
      suggestedStatus: parsed.suggestedStatus || 'In Progress',
      commentText: parsed.commentText || '',
      reason: parsed.reason || '',
    };
  } catch (err) {
    console.error(`[${new Date().toISOString()}] claudeService.matchHuddleToJira error:`, err.message);
    throw new Error(`Claude matchHuddleToJira failed: ${err.message}`);
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
 * Tests the Anthropic API connection with a minimal request.
 * @returns {Promise<boolean>}
 */
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
  generateWeeklyReport,
  testConnection,
};
