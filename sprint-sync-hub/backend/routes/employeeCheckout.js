'use strict';

const express = require('express');
const router = express.Router();
const checkoutService = require('../services/checkoutValidationService');
const {
  requireEmployeeSession,
  requireEmployeeCsrf,
} = require('../middleware/employeeAuth');

router.use(requireEmployeeSession);

router.post('/validate', requireEmployeeCsrf, async (req, res, next) => {
  try {
    const result = await checkoutService.validate(req.employee);
    res.json(result);
  } catch (err) {
    if (err.code === 'SLACK_ERROR') {
      console.warn('[employee-checkout] Slack validation failed:', err.cause?.message || err.message);
      return res.status(502).json({
        code: 'SLACK_ERROR',
        error: 'Slack could not be checked right now. Please retry.',
        retryable: true,
      });
    }
    if (err.code === 'DESTINATION_NOT_CONFIGURED') {
      return res.status(503).json({
        code: err.code,
        error: 'The Zoho checkout destination has not been configured by an administrator.',
        retryable: false,
      });
    }
    if (err.code === 'SLACK_NOT_CONFIGURED') {
      return res.status(503).json({
        code: err.code,
        error: 'The Slack daily-update channel has not been configured.',
        retryable: false,
      });
    }
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

module.exports = router;
