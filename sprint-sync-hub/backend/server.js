'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { getSprintWindow } = require('./utils/dateUtils');
const configService = require('./services/configService');
const { startCronJobs }   = require('./cron');
const { testConnection, runMigrations } = require('./db');
const sprintRepo   = require('./repositories/sprintRepository');
const memberRepo   = require('./repositories/memberRepository');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api/config',      require('./routes/config'));
app.use('/api/slack',       require('./routes/slack'));
app.use('/api/jira',        require('./routes/jira'));
app.use('/api/sync',        require('./routes/sync'));
app.use('/api/report',      require('./routes/report'));
app.use('/api/performance', require('./routes/performance'));
app.use('/api/attendance',  require('./routes/attendance'));
app.use('/api/settings',    require('./routes/settings'));
app.use('/api/checkout',        require('./routes/checkout'));
app.use('/api/sprint-planning', require('./routes/sprintPlanning'));
app.use('/api/assignment',     require('./routes/assignment'));
app.use('/api/mismatch',      require('./routes/mismatch'));
app.use('/api/roles',         require('./routes/roles'));
app.use('/api/members',       require('./routes/members'));
app.use('/api/webhooks',      require('./routes/webhooks'));
app.use('/api/zoho/oauth',   require('./routes/zohoOAuth'));

// Diagnostic routes — only available in non-production environments
if (process.env.NODE_ENV !== 'production') {
  app.use('/api/debug', require('./routes/debug'));
  console.log('[Server] Debug routes mounted at /api/debug (development only)');
}

app.get('/api/health', (req, res) => {
  const cfg    = configService.getSprintConfig();
  const window = getSprintWindow();
  res.json({
    status: 'ok',
    sprint: cfg.sprintName,
    channel: cfg.channelId,
    project: cfg.projectKey,
    sprintWindow: { start: window.startStr, end: window.endStr },
    uptime: process.uptime(),
  });
});

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error:`, err.message);
  res.status(500).json({ error: 'Internal server error' });
});

async function boot() {
  // 1. Connect to database
  await testConnection();

  // 2. Run migrations (includes app_config table)
  await runMigrations();

  // 3. Seed config from env → DB on first boot; subsequent boots load from DB
  await configService.seedFromEnv();

  const cfg = configService.getSprintConfig();

  // 4. Ensure default organisation exists
  const orgId   = parseInt(process.env.ORGANISATION_ID || '1', 10);
  const orgName = process.env.ORGANISATION_NAME || cfg.sprintName || 'My Organisation';
  const { query } = require('./db');
  await query(
    `INSERT INTO organisations (id, name, slack_channel_id, jira_project_key, jira_site_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET slack_channel_id = COALESCE(EXCLUDED.slack_channel_id, organisations.slack_channel_id),
           jira_project_key = COALESCE(EXCLUDED.jira_project_key, organisations.jira_project_key),
           jira_site_url    = COALESCE(EXCLUDED.jira_site_url,    organisations.jira_site_url)`,
    [orgId, orgName, cfg.channelId || null, cfg.projectKey || null, process.env.JIRA_SITE_URL || null]
  );

  // 5. Ensure active sprint exists
  const window = getSprintWindow();
  const startDate = window.startStr;
  const endDate   = window.endStr;
  let sprint = await sprintRepo.getActiveSprint(orgId);
  if (!sprint) {
    sprint = await sprintRepo.upsertSprint(orgId, cfg.sprintName, startDate, endDate, cfg.durationWeeks);
    if (sprint) await sprintRepo.setActive(sprint.id, orgId);
  }

  // 6. Pre-sync team members from config into DB
  for (const m of cfg.teamMembers) {
    try {
      await memberRepo.findOrCreate(orgId, m.id, m.name, m.email || null);
    } catch (_) { /* non-fatal */ }
  }

  // 6b. Seed system roles
  try {
    const { seedDefaults } = require('./repositories/roleRepository');
    await seedDefaults(orgId);
    console.log('Roles seeded successfully');
  } catch (err) {
    console.warn('[boot] Role seeding failed (non-fatal):', err.message);
  }

  // 6c. Log DM-enabled members
  try {
    const { getMembersWhoReceiveDMs } = require('./repositories/memberRoleRepository');
    const dmMembers = await getMembersWhoReceiveDMs(orgId);
    if (dmMembers.length > 0) {
      console.log(`DM-enabled members: ${dmMembers.map((m) => m.name).join(', ')}`);
    }
  } catch (_) { /* non-fatal */ }

  // 6d. First-startup auto-sync: fetch Slack emails + Jira IDs if no member has either
  try {
    const allMembers = await memberRepo.findAll(orgId);
    const noEmailCount = allMembers.filter((m) => !m.email).length;
    if (allMembers.length > 0 && noEmailCount === allMembers.length) {
      console.log('First startup detected — auto-fetching Slack emails and Jira account IDs...');
      const slackSvc = require('./services/slackService');
      const jiraSvc  = require('./services/jiraService');
      try {
        const emailResult = await slackSvc.fetchAndStoreSlackEmails(orgId);
        console.log(`  Emails: ${emailResult.fetched.length} fetched, ${emailResult.failed.length} failed`);
      } catch (e) {
        console.warn('  Slack email fetch failed (non-fatal):', e.message);
      }
      try {
        const jiraResult = await jiraSvc.fetchAndStoreJiraAccountIds(orgId);
        console.log(`  Jira IDs: ${jiraResult.matched.length} matched, ${jiraResult.notFound.length} not found`);
      } catch (e) {
        console.warn('  Jira ID fetch failed (non-fatal):', e.message);
      }
    }
  } catch (_) { /* non-fatal */ }

  // 6e. Startup member email check — warn if Zoho will silently return 0
  try {
    const { query } = require('./db');
    const memberCheck = await query(
      `SELECT
         COUNT(*)        AS total,
         COUNT(email)    AS with_email,
         COUNT(jira_account_id) AS with_jira_id
       FROM members WHERE is_active = true`
    );
    const stats = memberCheck.rows[0];
    const total    = parseInt(stats.total, 10);
    const withEmail = parseInt(stats.with_email, 10);
    const withJira  = parseInt(stats.with_jira_id, 10);
    console.log(`[Startup] Members: ${total} total, ${withEmail} with email, ${withJira} with Jira ID`);
    if (total > 0 && withEmail === 0) {
      console.warn('[Startup] ⚠ NO MEMBERS HAVE EMAILS — Zoho attendance will return 0 for everyone.');
      console.warn('[Startup]   Run POST /api/members/fetch-slack-emails to fix this.');
    }
    if (total > 0 && withJira === 0) {
      console.warn('[Startup] ⚠ NO MEMBERS HAVE JIRA IDs — sprint planning assignment will be unassigned.');
      console.warn('[Startup]   Run POST /api/members/sync-all to fix this.');
    }
  } catch (_) { /* non-fatal */ }

  // 6e2. Seed zoho_attendance_enabled flag (default OFF — team lead must enable)
  await query(
    `INSERT INTO system_config (organisation_id, config_key, config_value)
     VALUES ($1, 'zoho_attendance_enabled', 'false')
     ON CONFLICT (organisation_id, config_key) DO NOTHING`,
    [orgId]
  ).catch(() => {});

  // 6f. Clear cached broken Zoho attendance endpoint (switching to presence API)
  try {
    const { query } = require('./db');
    await query(
      `DELETE FROM system_config
       WHERE organisation_id = $1 AND config_key = 'zoho_attendance_endpoint'`,
      [parseInt(process.env.ORGANISATION_ID || '1')]
    );
    console.log('[Startup] Cleared stale Zoho attendance endpoint cache');
  } catch (_) { /* non-fatal — table may not exist yet */ }

  // 6h. Run attendance endpoint discovery in background (will use presence API now)
  try {
    const attendanceService = require('./services/attendanceService');
    attendanceService.discoverZohoEndpoint()
      .then(endpoint => {
        if (endpoint) {
          console.log(`[Startup] ✅ Zoho attendance API working: ${endpoint}`);
        } else {
          console.log('[Startup] Zoho attendance API not available — Slack fallback active');
          console.log('[Startup]   To enable real-time attendance: configure Zoho webhook');
          console.log('[Startup]   Zoho People → Settings → Integrations → Webhooks');
          console.log('[Startup]   Webhook URL: /api/webhooks/zoho-attendance');
        }
      })
      .catch(err => console.warn('[Startup] Endpoint discovery error:', err.message));
  } catch (_) { /* non-fatal */ }

  // 7. Start Express
  app.listen(PORT, () => {
    const activeSprint = sprint ? sprint.name : cfg.sprintName;
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║       Automation-Hub — Backend        ║');
    console.log('╚════════════════════════════════════════╝');
    console.log(`  Port:       ${PORT}`);
    console.log(`  Sprint:     ${activeSprint}`);
    console.log(`  Window:     ${startDate} → ${endDate}`);
    console.log(`  Project:    ${cfg.projectKey}`);
    console.log(`  Channel:    ${cfg.channelId || '(not set)'}`);
    console.log(`  Timezone:   ${cfg.timezone}`);
    console.log(`  DB:         connected`);
    console.log('');
    console.log(`Automation-Hub running. Sprint: ${activeSprint}. Org: ${orgName}. DB: connected.`);
    console.log('');

    // 8. Start cron jobs
    startCronJobs();
  });
}

boot().catch((err) => {
  console.error('[boot] Fatal startup error:', err.message);
  process.exit(1);
});

module.exports = app;
