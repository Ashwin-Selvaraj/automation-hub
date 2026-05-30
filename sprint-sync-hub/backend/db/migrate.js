'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { testConnection, runMigrations } = require('./index');

(async () => {
  try {
    await testConnection();
    await runMigrations();
    console.log('[migrate] All migrations complete.');
    process.exit(0);
  } catch (err) {
    console.error('[migrate] Fatal:', err.message);
    process.exit(1);
  }
})();
