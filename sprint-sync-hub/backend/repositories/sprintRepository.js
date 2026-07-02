'use strict';

const db = require('../db');

async function createSprint(organisationId, name, startDate, endDate, durationWeeks) {
  try {
    const { rows } = await db.query(
      `INSERT INTO sprints (organisation_id, name, start_date, end_date, duration_weeks)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [organisationId, name, startDate, endDate, durationWeeks || 2]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[sprintRepository.createSprint]', err.message);
    throw err;
  }
}

async function getActiveSprint(organisationId) {
  try {
    const { rows } = await db.query(
      'SELECT * FROM sprints WHERE organisation_id = $1 AND is_active = true LIMIT 1',
      [organisationId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[sprintRepository.getActiveSprint]', err.message);
    throw err;
  }
}

async function setActive(sprintId, organisationId) {
  try {
    await db.query(
      'UPDATE sprints SET is_active = false WHERE organisation_id = $1',
      [organisationId]
    );
    const { rows } = await db.query(
      'UPDATE sprints SET is_active = true WHERE id = $1 RETURNING *',
      [sprintId]
    );
    return rows[0] || null;
  } catch (err) {
    console.error('[sprintRepository.setActive]', err.message);
    throw err;
  }
}

async function findById(sprintId) {
  try {
    const { rows } = await db.query('SELECT * FROM sprints WHERE id = $1', [sprintId]);
    return rows[0] || null;
  } catch (err) {
    console.error('[sprintRepository.findById]', err.message);
    throw err;
  }
}

async function upsertSprint(organisationId, name, startDate, endDate, durationWeeks) {
  try {
    const { rows } = await db.query(
      `INSERT INTO sprints (organisation_id, name, start_date, end_date, duration_weeks)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organisation_id, name) DO UPDATE
         SET start_date = EXCLUDED.start_date,
             end_date = EXCLUDED.end_date,
             duration_weeks = EXCLUDED.duration_weeks
       RETURNING *`,
      [organisationId, name, startDate, endDate, durationWeeks || 2]
    );
    return rows[0] || null;
  } catch (err) {
    // If no unique constraint on name yet, fall back to insert-or-get
    const existing = await db.query(
      'SELECT * FROM sprints WHERE organisation_id = $1 AND name = $2',
      [organisationId, name]
    );
    if (existing.rows.length > 0) return existing.rows[0];
    const ins = await db.query(
      `INSERT INTO sprints (organisation_id, name, start_date, end_date, duration_weeks)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [organisationId, name, startDate, endDate, durationWeeks || 2]
    );
    return ins.rows[0];
  }
}

module.exports = { createSprint, getActiveSprint, setActive, findById, upsertSprint };
