'use strict';

const express = require('express');
const router = express.Router();
const zohoService = require('../services/employeeZohoService');
const {
  requireEmployeeSession,
  requireEmployeeCsrf,
} = require('../middleware/employeeAuth');

function frontendRedirect(result) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/?zoho_connection=${encodeURIComponent(result)}`;
}

// Zoho redirects here without the employee cookie being required. The
// single-use state row is already bound to the employee session that started it.
router.get('/callback', async (req, res) => {
  try {
    if (req.query.error) throw Object.assign(new Error('Zoho authorization was declined'), { code: req.query.error });
    await zohoService.exchangeCallback({
      code: String(req.query.code || ''),
      state: String(req.query.state || ''),
      location: req.query.location ? String(req.query.location) : null,
      callbackAccountsServer: req.query['accounts-server']
        ? String(req.query['accounts-server'])
        : null,
    });
    res.redirect(frontendRedirect('success'));
  } catch (err) {
    console.warn('[employee-zoho] OAuth callback failed:', err.code || err.message);
    res.redirect(frontendRedirect(err.code === 'IDENTITY_MISMATCH' ? 'identity_mismatch' : 'failed'));
  }
});

router.use(requireEmployeeSession);

router.get('/status', async (req, res, next) => {
  try {
    const status = await zohoService.ensureConnected(req.employee.memberId);
    res.json(status);
  } catch (err) {
    if (err.code === 'ZOHO_ERROR') {
      return res.status(502).json({
        code: 'ZOHO_ERROR',
        error: 'Zoho could not verify your connection. Please retry.',
        retryable: true,
      });
    }
    next(err);
  }
});

router.post('/connect', requireEmployeeCsrf, async (req, res, next) => {
  try {
    const authUrl = await zohoService.createAuthorizationUrl(req.employee);
    res.json({ authUrl });
  } catch (err) {
    if (err.code === 'ZOHO_NOT_CONFIGURED') {
      return res.status(503).json({ code: err.code, error: err.message });
    }
    next(err);
  }
});

router.post('/disconnect', requireEmployeeCsrf, async (req, res, next) => {
  try {
    await zohoService.disconnect(req.employee.memberId);
    res.json({ ok: true, connected: false });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
