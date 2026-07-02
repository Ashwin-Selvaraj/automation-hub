'use strict';

const path = require('path');

// backend/test/helpers/ -> backend/
const BACKEND_ROOT = path.join(__dirname, '..', '..');

/**
 * Replace a CommonJS module in require.cache with a fake implementation, so
 * that any later `require(...)` for that module (from anywhere — including
 * modules already required elsewhere) returns the fake instead of running
 * the real one. Must be called before the module under test is required.
 *
 * @param {string} relPathFromBackendRoot - e.g. 'services/claudeService', 'db'
 * @param {object} fakeExports - the object other modules will receive when they require() this path
 */
function stubModule(relPathFromBackendRoot, fakeExports) {
  const resolved = require.resolve(path.join(BACKEND_ROOT, relPathFromBackendRoot));
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: fakeExports,
  };
  return resolved;
}

module.exports = { stubModule, BACKEND_ROOT };
