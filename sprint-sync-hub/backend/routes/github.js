'use strict';

const express = require('express');
const router  = express.Router();
const githubService   = require('../services/githubService');
const prReviewService = require('../services/prReviewService');
const { getOrgId }    = require('../core/orgContext');

/**
 * GET /api/github/status
 *
 * Is the integration configured, and can the token actually see each repository?
 * GitHub answers 404 (not 403) for a repository a token cannot access, so a
 * misconfigured token otherwise shows up later as a quietly empty brief. This
 * checks each repository directly so the cause is visible straight away.
 * Never returns the token.
 */
router.get('/status', async (req, res) => {
  try {
    const repos = githubService.getRepos();
    const configured = githubService.isConfigured();
    const access = configured
      ? await Promise.all(repos.map((r) => githubService.checkRepoAccess(r)))
      : [];

    res.json({
      configured,
      hasToken: Boolean(process.env.GITHUB_TOKEN),
      repos,
      invalidRepos: githubService.getInvalidRepos(),
      slaHours: prReviewService.slaHours(),
      staleDays: prReviewService.staleDays(),
      access,
    });
  } catch (err) {
    console.error('[GET /api/github/status]', err.message);
    res.status(500).json({ error: 'Could not check the GitHub connection' });
  }
});

/**
 * GET /api/github/reviews
 *
 * The full assessment: everything waiting on review, with how long, and who it
 * is waiting on — the same data the daily brief draws from, before it is
 * reduced to what is over the SLA. `?fresh=true` bypasses the cache.
 */
router.get('/reviews', async (req, res) => {
  try {
    const fresh = req.query.fresh === 'true';
    const result = await prReviewService.assessWithin(getOrgId(), {
      budgetMs: fresh ? 60_000 : 8_000,
      ...(fresh ? { maxAgeMs: 0 } : {}),
    });
    res.json(result);
  } catch (err) {
    console.error('[GET /api/github/reviews]', err.message);
    res.status(502).json({ error: 'Could not read review data from GitHub' });
  }
});

module.exports = router;
