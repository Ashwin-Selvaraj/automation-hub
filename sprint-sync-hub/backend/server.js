'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { getSprintWindow } = require('./utils/dateUtils');
const { getSprintConfig } = require('./utils/sprintConfig');
const { startCronJobs } = require('./cron');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/api/config', require('./routes/config'));
app.use('/api/slack', require('./routes/slack'));
app.use('/api/jira', require('./routes/jira'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/report', require('./routes/report'));

// Health check
app.get('/api/health', (req, res) => {
  const cfg = getSprintConfig();
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

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error:`, err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  const cfg = getSprintConfig();
  const window = getSprintWindow();

  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║       Sprint-Sync Hub — Backend        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`  Port:       ${PORT}`);
  console.log(`  Sprint:     ${cfg.sprintName}`);
  console.log(`  Window:     ${window.startStr} → ${window.endStr}`);
  console.log(`  Project:    ${cfg.projectKey}`);
  console.log(`  Channel:    ${cfg.channelId || '(not set)'}`);
  console.log(`  Timezone:   ${cfg.timezone}`);
  console.log('');

  startCronJobs();
});

module.exports = app;
