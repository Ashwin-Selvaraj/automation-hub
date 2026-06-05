'use strict';

const express      = require('express');
const router       = express.Router();
const configService = require('../services/configService');
const { mask }     = require('../services/cryptoService');
const { getSprintWindow } = require('../utils/dateUtils');
const slackService = require('../services/slackService');
const jiraService  = require('../services/jiraService');
const claudeService = require('../services/claudeService');
const zohoService  = require('../services/zohoService');
const activityLog  = require('../services/activityLog');
const memberRepo   = require('../repositories/memberRepository');

// ─── GET /api/config ──────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const cfg    = configService.getSprintConfig();
    const window = getSprintWindow();
    res.json({
      sprintName:    cfg.sprintName,
      startDate:     cfg.startDate,
      durationWeeks: cfg.durationWeeks,
      endDate:       window.endStr,
      projectKey:    cfg.projectKey,
      channelId:     cfg.channelId,
      timezone:      cfg.timezone,
      syncTime:      cfg.syncTime,
      eodCheckTime:  cfg.eodCheckTime,
      reportDay:     cfg.reportDay,
      reportTime:    cfg.reportTime,
      teamMembers:   cfg.teamMembers,
      jiraSiteUrl:   cfg.jiraSiteUrl || process.env.JIRA_SITE_URL || '',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/config/sprint ──────────────────────────────────────────────────

router.post('/sprint', async (req, res) => {
  try {
    const { sprintName, startDate, durationWeeks } = req.body;
    if (!sprintName && !startDate && !durationWeeks) {
      return res.status(400).json({ error: 'Provide at least one field to update' });
    }
    const updates = {};
    if (sprintName)     updates['sprint.name']           = sprintName;
    if (startDate)      updates['sprint.start_date']     = startDate;
    if (durationWeeks)  updates['sprint.duration_weeks'] = String(durationWeeks);
    await configService.setMany(updates);
    const window = getSprintWindow();
    res.json({ ok: true, message: 'Sprint config updated', window });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/config/team ────────────────────────────────────────────────────

router.post('/team', async (req, res) => {
  try {
    const { members } = req.body;
    if (!Array.isArray(members)) {
      return res.status(400).json({ error: 'members must be an array' });
    }

    // Diff old vs new to log changes
    const oldMembers = configService.getSprintConfig().teamMembers || [];
    const oldIds = new Set(oldMembers.map((m) => m.id));
    const newIds = new Set(members.map((m) => m.id));

    oldMembers.forEach((m) => {
      if (!newIds.has(m.id)) {
        activityLog.addEntry({ type: 'team_change', userId: m.id, userName: m.name, action: 'Removed from team', success: true });
      }
    });
    members.forEach((m) => {
      if (!oldIds.has(m.id)) {
        activityLog.addEntry({ type: 'team_change', userId: m.id, userName: m.name, action: 'Added to team', success: true });
      }
    });

    // Persist members to DB (members table)
    const orgId = parseInt(process.env.ORGANISATION_ID || '1', 10);
    for (const m of members) {
      try {
        await memberRepo.findOrCreate(orgId, m.id, m.name, m.email || null);
      } catch (_) {}
    }

    // Also keep TEAM_MEMBERS env in sync (for backward-compat with sprintConfig)
    process.env.TEAM_MEMBERS = JSON.stringify(members);

    res.json({ ok: true, message: 'Team members updated', members });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/config/health ───────────────────────────────────────────────────

router.get('/health', async (req, res) => {
  const errors = {};
  const cfg    = configService.getSprintConfig();

  const [slackOk, jiraOk, claudeOk, zohoOk] = await Promise.all([
    slackService.testConnection().catch((e) => { errors.slack = e.message; return false; }),
    jiraService.testConnection(cfg.projectKey).catch((e) => { errors.jira = e.message; return false; }),
    claudeService.testConnection().catch((e) => { errors.claude = e.message; return false; }),
    zohoService.isConfigured()
      ? zohoService.testConnection().catch((e) => { errors.zoho = e.message; return false; })
      : Promise.resolve(null), // null = not configured (not a failure)
  ]);

  res.json({ slack: slackOk, jira: jiraOk, claude: claudeOk, zoho: zohoOk, errors });
});

// ─── GET /api/config/env-status ───────────────────────────────────────────────
// Returns current config state (secrets masked) for the Connections UI.

router.get('/env-status', async (req, res) => {
  try {
    // Team members — first try DB, fall back to env
    const orgId = parseInt(process.env.ORGANISATION_ID || '1', 10);
    let dbMembers = [];
    try { dbMembers = await memberRepo.findAll(orgId); } catch (_) {}

    const rawTeam = process.env.TEAM_MEMBERS || '';
    let envMembers = [];
    try { const p = JSON.parse(rawTeam); envMembers = Array.isArray(p) ? p : []; } catch (_) {}

    const parsedTeam = dbMembers.length > 0
      ? dbMembers.map((m) => ({ id: m.slack_user_id, dbId: m.id, name: m.name }))
      : envMembers;

    const isPlaceholder = parsedTeam.some((m) => m.id && m.id.startsWith('U00000000'));

    // Config values from DB
    const getV = (k) => configService.getSync(k);
    const getSet = (k) => { const v = getV(k); return v != null && v !== ''; };
    const getPreview = (k) => { const v = getV(k); return v ? mask(v) : null; };

    res.json({
      slack: {
        botToken:      { set: getSet('slack.bot_token'),      secret: true,  preview: getPreview('slack.bot_token') },
        channelId:     { set: getSet('slack.channel_id'),     secret: false, value:   getV('slack.channel_id') },
        signingSecret: { set: getSet('slack.signing_secret'), secret: true,  preview: getPreview('slack.signing_secret') },
      },
      jira: {
        email:      { set: getSet('jira.email'),       secret: false, value:   getV('jira.email') },
        apiToken:   { set: getSet('jira.api_token'),   secret: true,  preview: getPreview('jira.api_token') },
        siteUrl:    { set: getSet('jira.site_url'),    secret: false, value:   getV('jira.site_url') },
        cloudId:    { set: getSet('jira.cloud_id'),    secret: false, value:   getV('jira.cloud_id') },
        projectKey: { set: getSet('jira.project_key'), secret: false, value:   getV('jira.project_key') },
      },
      claude: {
        apiKey: { set: getSet('claude.api_key'), secret: true, preview: getPreview('claude.api_key') },
      },
      zoho: {
        clientId:     { set: getSet('zoho.client_id'),     secret: false, value:   getV('zoho.client_id') },
        clientSecret: { set: getSet('zoho.client_secret'), secret: true,  preview: getPreview('zoho.client_secret') },
        refreshToken: { set: getSet('zoho.refresh_token'), secret: true,  preview: getPreview('zoho.refresh_token') },
        orgId:        { set: getSet('zoho.org_id'),        secret: false, value:   getV('zoho.org_id') },
        domain:       { set: getSet('zoho.domain'),        secret: false, value:   getV('zoho.domain') || 'zoho.in' },
        workStart:    { set: getSet('zoho.work_start'),    secret: false, value:   getV('zoho.work_start') || '09:00' },
        workEnd:      { set: getSet('zoho.work_end'),      secret: false, value:   getV('zoho.work_end')   || '18:00' },
      },
      schedule: {
        timezone:       { set: getSet('schedule.timezone'),    secret: false, value: getV('schedule.timezone') },
        syncTime:       { set: getSet('schedule.sync_time'),   secret: false, value: getV('schedule.sync_time') },
        eodCheckTime:   { set: getSet('schedule.eod_time'),    secret: false, value: getV('schedule.eod_time') },
        reportDay:      { set: getSet('schedule.report_day'),  secret: false, value: getV('schedule.report_day') },
        reportTime:     { set: getSet('schedule.report_time'), secret: false, value: getV('schedule.report_time') },
        managerSlackId: { set: getSet('schedule.manager_slack_id'), secret: false, value: getV('schedule.manager_slack_id') },
      },
      team: {
        count:         parsedTeam.length,
        members:       parsedTeam,
        isPlaceholder,
        rawSet:        rawTeam !== '' || dbMembers.length > 0,
        parseError:    false,
        source:        dbMembers.length > 0 ? 'database' : 'env',
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/config/connections ─────────────────────────────────────────────
// Saves non-secret (and optionally secret) config values to DB.

router.post('/connections', async (req, res) => {
  try {
    const {
      // Slack
      channelId, botToken, signingSecret,
      // Jira
      jiraEmail, jiraSiteUrl, jiraCloudId, projectKey, jiraApiToken,
      // Claude
      anthropicApiKey,
      // Schedule
      timezone, syncTime, eodCheckTime, reportDay, reportTime, managerSlackId,
      // Zoho People
      zohoClientId, zohoClientSecret, zohoRefreshToken, zohoOrgId, zohoDomain,
      workStartTime, workEndTime,
    } = req.body;

    const updates = {};
    if (channelId         != null) updates['slack.channel_id']          = channelId;
    if (botToken          != null) updates['slack.bot_token']           = botToken;
    if (signingSecret     != null) updates['slack.signing_secret']      = signingSecret;
    if (jiraEmail         != null) updates['jira.email']                = jiraEmail;
    if (jiraApiToken      != null) updates['jira.api_token']            = jiraApiToken;
    if (jiraSiteUrl       != null) updates['jira.site_url']             = jiraSiteUrl;
    if (jiraCloudId       != null) updates['jira.cloud_id']             = jiraCloudId;
    if (projectKey        != null) updates['jira.project_key']          = projectKey;
    if (anthropicApiKey   != null) updates['claude.api_key']            = anthropicApiKey;
    if (timezone          != null) updates['schedule.timezone']         = timezone;
    if (syncTime          != null) updates['schedule.sync_time']        = syncTime;
    if (eodCheckTime      != null) updates['schedule.eod_time']         = eodCheckTime;
    if (reportDay         != null) updates['schedule.report_day']       = reportDay;
    if (reportTime        != null) updates['schedule.report_time']      = reportTime;
    if (managerSlackId    != null) updates['schedule.manager_slack_id'] = managerSlackId;
    if (zohoClientId      != null) updates['zoho.client_id']            = zohoClientId;
    if (zohoClientSecret  != null) updates['zoho.client_secret']        = zohoClientSecret;
    if (zohoRefreshToken  != null) updates['zoho.refresh_token']        = zohoRefreshToken;
    if (zohoOrgId         != null) updates['zoho.org_id']               = zohoOrgId;
    if (zohoDomain        != null) updates['zoho.domain']               = zohoDomain;
    if (workStartTime     != null) updates['zoho.work_start']           = workStartTime;
    if (workEndTime       != null) updates['zoho.work_end']             = workEndTime;

    await configService.setMany(updates);
    res.json({ ok: true, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
