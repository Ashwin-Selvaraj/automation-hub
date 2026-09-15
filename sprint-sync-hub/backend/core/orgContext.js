'use strict';

/**
 * Single source for the current organisation id.
 *
 * This replaced fourteen copies of the same `parseInt(process.env.ORGANISATION_ID || '1')`
 * expression scattered across routes and services — one of which captured the
 * value at module load, so it could never change after boot.
 *
 * The app is single-tenant today. Keeping the lookup in one place is what makes
 * it possible to resolve the org per-request later without touching every
 * caller again.
 */

const DEFAULT_ORG_ID = 1;

function getOrgId() {
  const parsed = parseInt(process.env.ORGANISATION_ID || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ORG_ID;
}

module.exports = { getOrgId, DEFAULT_ORG_ID };
