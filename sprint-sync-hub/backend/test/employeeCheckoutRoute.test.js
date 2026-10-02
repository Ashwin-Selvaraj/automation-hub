'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { stubModule } = require('./helpers/mockRequire');

let receivedEmployee;

stubModule('middleware/employeeAuth', {
  requireEmployeeSession(req, res, next) {
    req.employee = { memberId: 7, slackUserId: 'U7', organisationId: 1 };
    next();
  },
  requireEmployeeCsrf(req, res, next) { next(); },
});
stubModule('services/checkoutValidationService', {
  async validate(employee) {
    receivedEmployee = employee;
    return { code: 'UPDATE_MISSING', message: 'missing' };
  },
});

const router = require('../routes/employeeCheckout');
const app = express();
app.use(express.json());
app.use('/api/employee/checkout', router);

test('ignores browser-supplied employee IDs and uses authenticated identity', async () => {
  const response = await request(app)
    .post('/api/employee/checkout/validate')
    .send({ memberId: 999, slackUserId: 'U_OTHER' })
    .expect(200);

  assert.equal(response.body.code, 'UPDATE_MISSING');
  assert.equal(receivedEmployee.memberId, 7);
  assert.equal(receivedEmployee.slackUserId, 'U7');
});
