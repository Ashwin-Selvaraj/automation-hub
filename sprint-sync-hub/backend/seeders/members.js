'use strict';

/**
 * Team members seeder.
 *
 * Edit this array to add / update / remove team members.
 * Run:  npm run seed:members
 *
 * On first boot the backend also auto-seeds from TEAM_MEMBERS env var if the
 * members table is empty — whichever runs first wins.
 * After the first seed the database is the source of truth; this file is the
 * canonical way to bulk-update the roster.
 *
 * Fields:
 *   id        — Slack User ID  (required, e.g. "U0123456789")
 *   name      — Display name   (required)
 *   initials  — 2-char initials (optional — auto-derived from name if omitted)
 *   role      — Job title / role (optional)
 *   email     — Work email (optional — used for Jira assignee matching)
 */
const TEAM_MEMBERS = [
  // ── Replace these with your real team ──────────────────────────────────────
  // { id: 'U0123456789', name: 'Alice Smith',  initials: 'AS', role: 'Frontend Engineer', email: 'alice@company.com' },
  // { id: 'U9876543210', name: 'Bob Jones',    initials: 'BJ', role: 'Backend Engineer',  email: 'bob@company.com'   },
  // { id: 'U1111111111', name: 'Carol White',  initials: 'CW', role: 'QA Engineer',       email: 'carol@company.com' },
  // ───────────────────────────────────────────────────────────────────────────
];

// ─── Seeder runner ────────────────────────────────────────────────────────────

if (require.main === module) {
  require('dotenv').config();
  const { testConnection, runMigrations } = require('../db');
  const memberRepo = require('../repositories/memberRepository');

  function getInitials(name) {
    if (!name) return '??';
    return name.trim().split(/\s+/).map((w) => w[0] || '').join('').toUpperCase().slice(0, 2) || '??';
  }

  async function run() {
    await testConnection();
    await runMigrations();

    const orgId = parseInt(process.env.ORGANISATION_ID || '1', 10);
    let created = 0, updated = 0;

    for (const m of TEAM_MEMBERS) {
      if (!m.id || !m.name) { console.warn('[seed:members] Skipping entry without id/name:', m); continue; }
      const initials = m.initials || getInitials(m.name);
      const member = await memberRepo.findOrCreate(orgId, m.id, m.name, m.email || null, m.role || null);

      // If the member already existed but name/role changed, update it
      if (member.name !== m.name || member.role !== (m.role || null)) {
        const { query } = require('../db');
        await query(
          'UPDATE members SET name = $1, role = $2, updated_at = NOW() WHERE id = $3',
          [m.name, m.role || null, member.id]
        );
        updated++;
        console.log(`  [updated] ${m.name} (${m.id})`);
      } else {
        created++;
        console.log(`  [ok]      ${m.name} (${m.id})`);
      }

      // Also keep TEAM_MEMBERS env aligned (in-process, for compatibility)
      const existing = JSON.parse(process.env.TEAM_MEMBERS || '[]');
      const idx = existing.findIndex((e) => e.id === m.id);
      const entry = { id: m.id, name: m.name, initials, ...(m.role ? { role: m.role } : {}), ...(m.email ? { email: m.email } : {}) };
      if (idx >= 0) existing[idx] = entry; else existing.push(entry);
      process.env.TEAM_MEMBERS = JSON.stringify(existing);
    }

    console.log(`\n✅ seed:members complete — ${TEAM_MEMBERS.length} members processed (${updated} updated)`);
    process.exit(0);
  }

  run().catch((err) => {
    console.error('[seed:members] Error:', err.message);
    process.exit(1);
  });
}

module.exports = { TEAM_MEMBERS };
