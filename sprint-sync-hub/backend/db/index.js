'use strict';

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function getClient() {
  return pool.connect();
}

async function runMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) PRIMARY KEY,
      run_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const { rows } = await query(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [file]
    );
    if (rows.length > 0) {
      console.log(`[DB] Migration already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    console.log(`[DB] Running migration: ${file}`);
    try {
      await query(sql);
      await query(
        'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
      console.log(`[DB] Migration complete: ${file}`);
    } catch (err) {
      console.error(`[DB] Migration FAILED: ${file} — ${err.message}`);
      throw err;
    }
  }
}

async function testConnection() {
  try {
    await query('SELECT 1');
    console.log('[DB] Database connected');
  } catch (err) {
    console.error('[DB] Connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = { query, getClient, runMigrations, testConnection };
