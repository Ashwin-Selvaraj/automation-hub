'use strict';

const express              = require('express');
const router               = express.Router();
const memberRepository     = require('../repositories/memberRepository');
const memberRoleRepository = require('../repositories/memberRoleRepository');
const slackService         = require('../services/slackService');
const jiraService          = require('../services/jiraService');
const activityLog          = require('../services/activityLog');

const ORG_ID = () => parseInt(process.env.ORGANISATION_ID || '1', 10);

// Jira account ID format: 24-char alphanumeric
const JIRA_ID_RE = /^[a-zA-Z0-9]{24}$/;

// ─── GET /api/members ─────────────────────────────────────────────────────────
// Returns all members with their roles, email, jira_account_id.

router.get('/', async (req, res) => {
  try {
    const members = await memberRoleRepository.getAllMembersWithRoles(ORG_ID());
    res.json(members);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/members/jira-id-status ─────────────────────────────────────────

router.get('/jira-id-status', async (req, res) => {
  try {
    const members = await memberRepository.findAll(ORG_ID());
    res.json(members.map((m) => ({
      memberId:            m.id,
      name:                m.name,
      email:               m.email,
      hasJiraId:           !!m.jira_account_id,
      jiraAccountId:       m.jira_account_id || null,
      source:              m.jira_account_id ? (m.jira_account_id_source || 'auto') : null,
      fetchedAt:           m.jira_account_id_fetched_at || null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/members/:memberId ───────────────────────────────────────────────

router.get('/:memberId', async (req, res) => {
  try {
    const m = await memberRoleRepository.getMemberWithRoles(req.params.memberId);
    if (!m) return res.status(404).json({ error: 'Member not found' });
    res.json(m);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/members/:memberId/jira-id ─────────────────────────────────────
// Manually set a Jira account ID for a specific member.

router.patch('/:memberId/jira-id', async (req, res) => {
  try {
    const { memberId } = req.params;
    const { jiraAccountId } = req.body;

    if (!jiraAccountId) {
      return res.status(400).json({ error: 'jiraAccountId is required' });
    }
    if (!JIRA_ID_RE.test(jiraAccountId)) {
      return res.status(400).json({
        error: 'Jira account IDs are 24-character alphanumeric strings. Find yours in Jira under Profile → Account settings.',
      });
    }

    const member = await memberRepository.findById(memberId);
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const updated = await memberRepository.setManualJiraAccountId(memberId, jiraAccountId);

    activityLog.addEntry({
      type:     'jira_id_manual',
      userName: member.name,
      action:   `Jira account ID manually set for ${member.name}`,
      success:  true,
    });

    res.json({ success: true, member: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/members/fetch-slack-emails ─────────────────────────────────────
// Fetch emails from Slack for all members who have no email yet.

router.post('/fetch-slack-emails', async (req, res) => {
  try {
    console.log('[/api/members/fetch-slack-emails] Starting Slack email fetch...');
    const result = await slackService.fetchAndStoreSlackEmails(ORG_ID());
    console.log(`[/api/members/fetch-slack-emails] Done: ${result.fetched.length} fetched, ${result.failed.length} failed, ${result.skipped.length} skipped`);

    activityLog.addEntry({
      type:    'slack_email_sync',
      action:  `Slack emails: ${result.fetched.length} fetched, ${result.failed.length} failed`,
      success: true,
    });

    res.json(result);
  } catch (err) {
    console.error('[/api/members/fetch-slack-emails]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/members/fetch-jira-ids ────────────────────────────────────────
// Fetch Jira account IDs for all members by email.

router.post('/fetch-jira-ids', async (req, res) => {
  try {
    console.log('[/api/members/fetch-jira-ids] Starting Jira ID fetch...');
    const result = await jiraService.fetchAndStoreJiraAccountIds(ORG_ID());
    console.log(`[/api/members/fetch-jira-ids] Done: ${result.matched.length} matched, ${result.notFound.length} not found, ${result.noEmail.length} no email`);

    activityLog.addEntry({
      type:    'jira_id_sync',
      action:  `Jira IDs: ${result.matched.length} matched, ${result.notFound.length} not found`,
      success: true,
    });

    res.json(result);
  } catch (err) {
    console.error('[/api/members/fetch-jira-ids]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/members/sync-all ───────────────────────────────────────────────
// Runs both email fetch and Jira ID fetch in sequence.

router.post('/sync-all', async (req, res) => {
  try {
    console.log('[/api/members/sync-all] Starting full sync...');

    let slackEmails = { fetched: [], failed: [], skipped: [] };
    let jiraIds     = { matched: [], notFound: [], noEmail: [] };

    try {
      slackEmails = await slackService.fetchAndStoreSlackEmails(ORG_ID());
      console.log(`[sync-all] Slack: ${slackEmails.fetched.length} emails fetched`);
    } catch (err) {
      console.warn('[sync-all] Slack email fetch failed:', err.message);
      slackEmails.error = err.message;
    }

    try {
      jiraIds = await jiraService.fetchAndStoreJiraAccountIds(ORG_ID());
      console.log(`[sync-all] Jira: ${jiraIds.matched.length} IDs matched`);
    } catch (err) {
      console.warn('[sync-all] Jira ID fetch failed:', err.message);
      jiraIds.error = err.message;
    }

    activityLog.addEntry({
      type:    'sync_all',
      action:  `Sync: ${slackEmails.fetched.length} emails, ${jiraIds.matched.length} Jira IDs`,
      success: true,
    });

    res.json({ slackEmails, jiraIds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
