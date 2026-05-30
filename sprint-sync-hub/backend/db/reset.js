'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, testConnection } = require('./index');

if (!process.argv.includes('--confirm')) {
  console.error('[reset] Refusing to run without --confirm flag. This drops ALL tables.');
  process.exit(1);
}

(async () => {
  try {
    await testConnection();
    console.log('[reset] Dropping all tables...');
    await query(`
      DROP TABLE IF EXISTS
        notifications_sent,
        member_overall_stats,
        member_sprint_summary,
        member_daily_stats,
        task_transitions,
        deadline_events,
        standup_posts,
        tasks,
        sprints,
        members,
        organisations,
        schema_migrations
      CASCADE
    `);
    console.log('[reset] All tables dropped. Run "node db/migrate.js" to recreate.');
    process.exit(0);
  } catch (err) {
    console.error('[reset] Fatal:', err.message);
    process.exit(1);
  }
})();
