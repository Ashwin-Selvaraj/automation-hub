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
      await memberRepo.findOrCreate(orgId, m.id, m.name, m.email || null, m.role || null);
    } catch (_) { /* non-fatal */ }
  }

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
