'use strict';

/**
 * Calls across modules must hit functions that really exist.
 *
 * Almost every test in this project stubs the modules around the one under test.
 * That is fast, but a stub can happily provide a function the real module never
 * exported, and the test passes while production throws a TypeError. That is not
 * hypothetical: `performanceService.shouldSendTaskDM` was called from the end-of-day
 * reminder and from the original cron, was never exported, and every test stubbed
 * it into existence.
 *
 * This test loads the REAL modules, finds every `alias.fn(` call made through a
 * local require, and checks `fn` is actually exported. It reads source text, so it
 * needs no database and no network.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://localhost:5432/unused';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'test', 'migrations', 'db']);
const SKIP_FILES = new Set(['server.js']);   // starts a listener on load

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.js') && !SKIP_FILES.has(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Strips comments only.
 *
 * Strings and template literals are deliberately NOT stripped. An earlier version
 * tried, and a regex cannot parse nested templates (`${link(`${a}`, { max: 7 })}`):
 * it swallowed real code and a genuine bad call went unreported. Leaving strings in
 * can only cause a visible false positive, which is fixable; stripping them wrongly
 * causes a silent miss, which is the failure this test exists to prevent.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function analyse(file) {
  const code = stripComments(fs.readFileSync(file, 'utf8'));
  const withStrings = code;
  const problems = [];
  let checked = 0;

  const resolveLocal = (spec) => {
    if (!spec.startsWith('.')) return null;
    try { return require.resolve(path.resolve(path.dirname(file), spec)); } catch { return null; }
  };

  // const alias = require('./x')
  const aliases = new Map();
  for (const m of withStrings.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*'([^']+)'\s*\)/g)) {
    const resolved = resolveLocal(m[2]);
    if (resolved) aliases.set(m[1], { spec: m[2], resolved });
  }

  // const { a, b: c } = require('./x')
  const destructured = [];
  for (const m of withStrings.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*'([^']+)'\s*\)/g)) {
    const resolved = resolveLocal(m[2]);
    if (!resolved) continue;
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].trim();
      if (name) destructured.push({ spec: m[2], resolved, name });
    }
  }

  const load = (resolved) => { try { return require(resolved); } catch (err) { return { __loadError: err.message }; } };

  for (const [alias, { spec, resolved }] of aliases) {
    const mod = load(resolved);
    if (mod.__loadError) { problems.push(`${path.relative(ROOT, file)}: could not load ${spec}: ${mod.__loadError}`); continue; }
    if (mod === null || (typeof mod !== 'object' && typeof mod !== 'function')) continue;

    const seen = new Set();
    for (const call of code.matchAll(new RegExp(`(?<![\\w$.])${alias.replace(/\$/g, '\\$')}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) {
      const fn = call[1];
      checked++;
      if (seen.has(fn)) continue;
      seen.add(fn);
      if (typeof mod[fn] !== 'function') {
        problems.push(`${path.relative(ROOT, file)}: calls ${alias}.${fn}() but ${spec} does not export a function named "${fn}"`);
      }
    }
  }

  for (const { spec, resolved, name } of destructured) {
    const mod = load(resolved);
    if (mod.__loadError) { problems.push(`${path.relative(ROOT, file)}: could not load ${spec}: ${mod.__loadError}`); continue; }
    if (mod === null || (typeof mod !== 'object' && typeof mod !== 'function')) continue;
    if (!(name in mod)) problems.push(`${path.relative(ROOT, file)}: imports { ${name} } from ${spec}, which does not export it`);
  }

  analyse.checked = (analyse.checked || 0) + checked;
  return problems;
}

test('every function one module calls on another is really exported by it', () => {
  analyse.checked = 0;
  const problems = sourceFiles(ROOT).flatMap(analyse);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);

  // A floor, so the checker cannot quietly go blind: if a refactor of the regexes
  // makes it see almost nothing, this fails instead of passing on an empty set.
  assert.ok(analyse.checked > 300, `only ${analyse.checked} call sites were inspected — the checker has stopped seeing the code`);
});

test('the checker itself would catch the bug it exists for', () => {
  // A throwaway module that calls a function the target never exported.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'contract-'));
  fs.writeFileSync(path.join(dir, 'target.js'), "module.exports = { real() {} };\n");
  fs.writeFileSync(path.join(dir, 'caller.js'), "const target = require('./target');\ntarget.real();\ntarget.imaginary();\nconst { alsoMissing } = require('./target');\n");
  const found = analyse(path.join(dir, 'caller.js'));
  assert.equal(found.length, 2);
  assert.ok(found.some((p) => /target\.imaginary\(\)/.test(p)));
  assert.ok(found.some((p) => /alsoMissing/.test(p)));
});

test('every repository or service a file calls into is imported there', () => {
  // The Phase 3 clean-up deleted an endpoint from routes/checkout.js together
  // with the import that its sibling endpoint still used, and the checkout
  // history page returned 500 until a test happened to call it. A name used as
  // `somethingRepo.method(` or `somethingService.method(` must be declared in the
  // same file.
  const problems = [];
  for (const file of sourceFiles(ROOT)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const used = new Set([...src.matchAll(/\b([a-z]\w*(?:Repo|Repository|Service))\.\w+\(/g)].map((m) => m[1]));
    for (const name of used) {
      const declared = new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name})\\s*=|function\\s+${name}\\b`).test(src);
      if (!declared) problems.push(`${path.relative(ROOT, file)}: uses ${name}, which it never declares`);
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});
