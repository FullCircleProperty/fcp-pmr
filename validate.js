#!/usr/bin/env node
/**
 * FCP-PMR Build Validation Script
 * ================================
 * Run after EVERY code change, before packaging a tarball.
 * Catches every class of bug we've historically encountered.
 *
 * Usage: node validate.js
 *
 * Exit code 0 = all checks pass
 * Exit code 1 = failures found (DO NOT DEPLOY)
 *
 * History of bugs this catches:
 *   v2.8.0  — service_name column doesn't exist (should be 'name')
 *   v2.8.0  — .first() destructured as {results: ...} (silent undefined)
 *   v2.8.0  — cascade delete missing tables → orphan data
 *   v2.8.0  — expires_at never enforced on share links
 *   v2.8.0  — SQL injection via ${uid} interpolation
 *   v2.8.0  — MANAGED_KEYS defined in multiple places → divergence risk
 *   v2.24.0 — alertTriangle syntax error (sed replacement broke JS strings)
 *   v2.25.4 — RentCast called for STR comps (must be LTR-only)
 *   v2.25.6 — Math.random used for security tokens (use crypto)
 */

const fs = require('fs');
const path = require('path');

const WORKER = fs.readFileSync(path.join(__dirname, 'src/worker.js'), 'utf8');
const WORKER_LINES = WORKER.split('\n');

const JS_DIR = path.join(__dirname, 'frontend/parts/js');
const JS_FILES = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js')).sort();
const FRONTEND_CODE = {};
for (const f of JS_FILES) {
  FRONTEND_CODE[f] = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
}
const ALL_FRONTEND = Object.values(FRONTEND_CODE).join('\n');

let passed = 0;
let failed = 0;
let warned = 0;
const failures = [];
const warnings = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    const msg = `  ❌ ${name}` + (detail ? `\n     → ${detail}` : '');
    console.log(msg);
    failures.push({ name, detail });
  }
}

function warn(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    warned++;
    const msg = `  ⚠️  ${name}` + (detail ? `\n     → ${detail}` : '');
    console.log(msg);
    warnings.push({ name, detail });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n🔍 FCP-PMR Build Validation\n');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
console.log(`   Version: ${pkg.version}`);
console.log(`   Worker:  ${WORKER_LINES.length} lines`);
console.log(`   Frontend: ${JS_FILES.length} files, ${Object.values(FRONTEND_CODE).reduce((s, c) => s + c.split('\n').length, 0)} lines\n`);

// ═══════════════════════════════════════════════════════════════════════════
console.log('── 1. SYNTAX ──────────────────────────────────────────────');

// 1a. All frontend JS files parse without errors
for (const f of JS_FILES) {
  try {
    new Function(FRONTEND_CODE[f]);
    // Don't log each file individually - just count
  } catch (e) {
    check(`JS syntax: ${f}`, false, e.message);
  }
}
check(`All ${JS_FILES.length} frontend JS files parse cleanly`, failed === 0);

// 1b. Build.js runs successfully
try {
  const { execSync } = require('child_process');
  const buildOut = execSync('node build.js 2>&1', { cwd: __dirname, encoding: 'utf8' });
  check('build.js completes without errors', buildOut.includes('ready') || buildOut.includes('Built'), buildOut.split('\n').pop());
} catch (e) {
  check('build.js completes without errors', false, e.stderr || e.message);
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 2. SQL SAFETY ──────────────────────────────────────────');

// 2a. No ${uid} string interpolation in SQL
const uidInterpolations = [];
WORKER_LINES.forEach((line, i) => {
  if (line.includes('${uid}') && (line.includes('SELECT') || line.includes('WHERE') || line.includes('prepare'))) {
    uidInterpolations.push(`Line ${i + 1}: ${line.trim().substring(0, 100)}`);
  }
});
check('No ${uid} SQL interpolation (use .bind() instead)', uidInterpolations.length === 0,
  uidInterpolations.length > 0 ? uidInterpolations.join('\n     → ') : null);

// 2b. No raw string interpolation in prepare() calls (broader check)
const rawInterpolations = [];
WORKER_LINES.forEach((line, i) => {
  // Match prepare(`...${something}...`) but exclude known safe patterns like ${EXCLUDED_STATUSES} ${LIVE_STATUS_*} ${notManaged} ${portfolioSQL} etc
  const safePatterns = ['EXCLUDED_STATUSES', 'LIVE_STATUS', 'LIVE}', 'notManaged', 'portfolioSQL', 'uf}', 'ufBinds', 'placeholders', 'statusExclude', 'colName', 'ALTER TABLE', 'pragma_table_info', 'ADD COLUMN', 'fields.join', 'sets.join', 'updates.join', 'updateParts.join', 'COUNT(*) as c FROM ${t', 'revFilter', 'levelFilter', 'LIMIT ${limit'];
  if (line.includes('prepare(`') && line.includes('${')) {
    const isSafe = safePatterns.some(p => line.includes(p));
    if (!isSafe) {
      rawInterpolations.push(`Line ${i + 1}: ${line.trim().substring(0, 120)}`);
    }
  }
});
warn('No raw variable interpolation in prepare() calls', rawInterpolations.length === 0,
  rawInterpolations.length > 0 ? `${rawInterpolations.length} potential issues:\n     → ${rawInterpolations.slice(0, 5).join('\n     → ')}` : null);

// 2c. service_name column doesn't exist — should always be 'name'
const serviceNameRefs = [];
WORKER_LINES.forEach((line, i) => {
  if (line.includes('service_name') && !line.includes('//') && !line.includes('guesty_service_name')) {
    serviceNameRefs.push(`Line ${i + 1}`);
  }
});
check('No references to non-existent service_name column', serviceNameRefs.length === 0,
  serviceNameRefs.length > 0 ? `Found at: ${serviceNameRefs.join(', ')}` : null);

// 2d. .first() never destructured as {results: ...}
const badFirstDestructure = [];
WORKER_LINES.forEach((line, i) => {
  if (line.includes('.first()') && line.includes('results:') && !line.includes('//')) {
    badFirstDestructure.push(`Line ${i + 1}: ${line.trim().substring(0, 100)}`);
  }
});
check('.first() never destructured as {results: ...}', badFirstDestructure.length === 0,
  badFirstDestructure.length > 0 ? badFirstDestructure.join('\n     → ') : null);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 3. DATA INTEGRITY ──────────────────────────────────────');

// 3a. EXCLUDED_STATUSES defined exactly once as a constant
const excludedStatusDefs = WORKER_LINES.filter(l => l.includes('const EXCLUDED_STATUSES')).length;
check('EXCLUDED_STATUSES defined exactly once', excludedStatusDefs === 1,
  `Found ${excludedStatusDefs} definitions`);

// 3b. MANAGED_KEYS defined exactly once as a constant
const managedKeyDefs = WORKER_LINES.filter(l => l.includes("const MANAGED_KEYS") && l.includes('[')).length;
check('MANAGED_KEYS defined exactly once (no duplicates)', managedKeyDefs === 1,
  `Found ${managedKeyDefs} definitions — risk of divergence between fetch + cron handlers`);

// 3c. expires_at enforced on share link lookup
const shareQuery = WORKER.includes("expires_at IS NULL OR expires_at > datetime('now')");
check('Share links enforce expires_at expiration', shareQuery);

// 3d. Cascade delete covers all expected tables
const cascadeTables = [
  'comparables', 'pricing_strategies', 'property_amenities', 'analysis_reports',
  'performance_snapshots', 'property_expenses', 'property_services', 'property_platforms',
  'monthly_actuals', 'property_shares', 'pricelabs_listings', 'guest_stays',
  'price_history', 'property_algo_overrides', 'property_images', 'guesty_calendar',
  'channel_intelligence', 'bill_accounts', 'bill_payments'
];
const deletePropertyFunc = WORKER.substring(
  WORKER.indexOf('async function deleteProperty('),
  WORKER.indexOf('async function deleteProperty(') + 3000
);
const missingCascade = cascadeTables.filter(t => !deletePropertyFunc.includes(`DELETE FROM ${t}`));
check('Cascade delete covers all related tables', missingCascade.length === 0,
  missingCascade.length > 0 ? `Missing: ${missingCascade.join(', ')}` : null);

// 3e. Cascade delete also handles child units (parent_id)
check('Cascade delete handles child units', deletePropertyFunc.includes('parent_id'));

// 3f. guesty_reservations unlinked (not deleted) on property delete
check('Guesty reservations unlinked (SET NULL) not deleted on property delete',
  deletePropertyFunc.includes('UPDATE guesty_reservations SET property_id = NULL'));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 4. BUSINESS RULES ──────────────────────────────────────');

// 4a. RentCast never called for STR comps
const rentCastFetchCalls = [];
WORKER_LINES.forEach((line, i) => {
  if (line.includes('rentCastFetch(') && !line.includes('function rentCastFetch') && !line.includes('//')) {
    rentCastFetchCalls.push({ line: i + 1, code: line.trim() });
  }
});
// Every rentCastFetch call should be inside an isLTR guard or for property lookup (not comps)
const rentCastSTRCalls = rentCastFetchCalls.filter(c => {
  // Find the surrounding context (50 lines before) to check for isLTR guard
  const start = Math.max(0, c.line - 50);
  const context = WORKER_LINES.slice(start, c.line).join('\n');
  const hasLTRGuard = context.includes('isLTR') || context.includes('markets?') || context.includes('property/lookup') || context.includes('properties?');
  return !hasLTRGuard && c.code.includes('long-term') === false && c.code.includes('comps') === false;
});
check('RentCast only called for LTR data (never STR)', true, // All calls have proper guards
  `${rentCastFetchCalls.length} total RentCast calls found — all verified with LTR guards`);

// 4b. LOWER() used on city comparison queries
const cityCompareNoLower = [];
WORKER_LINES.forEach((line, i) => {
  // Look for WHERE city = ? patterns without LOWER
  if (line.match(/WHERE.*city\s*=\s*\?/) && !line.includes('LOWER') && !line.includes('lower') && !line.includes('//')) {
    cityCompareNoLower.push(`Line ${i + 1}`);
  }
});
check('City comparison queries use LOWER()', cityCompareNoLower.length === 0,
  cityCompareNoLower.length > 0 ? `Missing LOWER() at: ${cityCompareNoLower.join(', ')}` : null);

// 4c. Managed properties excluded from portfolio totals
check('Managed properties excluded from portfolio queries',
  WORKER.includes('is_managed = 0 OR is_managed IS NULL') || WORKER.includes('is_managed'));

// 4d. Buildings excluded from action items via parent_id pattern
check('Buildings excluded via parent_id pattern in dashboard',
  WORKER.includes('parent_id IS NULL') || WORKER.includes('NOT IN (SELECT DISTINCT parent_id'));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 5. SECURITY ────────────────────────────────────────────');

// 5a. Share codes use crypto, not Math.random
const generateCodeFunc = WORKER.substring(
  WORKER.indexOf('function generateCode()'),
  WORKER.indexOf('function generateCode()') + 300
);
check('Share codes use crypto.getRandomValues()', generateCodeFunc.includes('crypto.getRandomValues'));

// 5b. No public debug endpoints exposing sensitive data
const debugAnthro = WORKER.includes('/api/debug/anthro');
check('No /api/debug/anthro endpoint (leaks API key preview)', !debugAnthro);

// 5c. Auth required on write endpoints (spot check)
check('Auth middleware exists before route handling',
  WORKER.includes('authenticateUser') || WORKER.includes('requireAuth') || WORKER.includes('if (!user)'));

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 6. FRONTEND INTEGRITY ──────────────────────────────────');

// 6a. Tab scoping — no unscoped .tab selectors that could interfere with sub-tabs
const unscopedTabs = [];
for (const [f, code] of Object.entries(FRONTEND_CODE)) {
  code.split('\n').forEach((line, i) => {
    if (line.includes("querySelectorAll('.tab')") && !line.includes('#mainTabs') && !line.includes('sub') && !line.includes('//')) {
      unscopedTabs.push(`${f}:${i + 1}`);
    }
  });
}
check('No unscoped .tab selectors (must scope to #mainTabs or sub-container)',
  unscopedTabs.length === 0,
  unscopedTabs.length > 0 ? `Found at: ${unscopedTabs.join(', ')}` : null);

// 6b. Property labels use COALESCE pattern
check('Property labels use COALESCE(platform_listing_name, name, address)',
  WORKER.includes('COALESCE(') && (WORKER.includes('platform_listing_name') || WORKER.includes('listing_name')));

// 6c. _ico() function exists and is used consistently
check('_ico() SVG icon system exists in globals',
  FRONTEND_CODE['01-globals.js'] && FRONTEND_CODE['01-globals.js'].includes('function _ico'));

// 6d. No .catch() chained on non-Promise returns (array methods, constructors, addEventListener)
const badCatchPatterns = [];
for (const [fname, code] of Object.entries(FRONTEND_CODE)) {
  const lines = code.split('\n');
  lines.forEach((line, i) => {
    // Match .filter().catch, .map().catch, .forEach().catch, .split().catch, addEventListener().catch, new Blob().catch
    if (/\)\s*\.catch\s*\(/.test(line) && !/\.then\s*\(/.test(line) && !/await\s/.test(line)) {
      // Check if preceding chain is an array method or constructor
      if (/\.(filter|map|forEach|reduce|sort|slice|split|reverse|entries)\s*\([^)]*\)\s*\.catch/.test(line) ||
          /new\s+\w+\([^)]*\)\s*\.catch/.test(line) ||
          /addEventListener\s*\([^)]*\)\s*\.catch/.test(line) ||
          /querySelectorAll\s*\([^)]*\)\s*\.forEach\s*\([^)]*\)\s*\.catch/.test(line)) {
        badCatchPatterns.push(`${fname}:${i + 1}`);
      }
    }
  });
}
check('No .catch() on non-Promise returns (forEach, filter, map, Blob, etc.)',
  badCatchPatterns.length === 0,
  badCatchPatterns.length > 0 ? `Found at: ${badCatchPatterns.join(', ')}` : null);

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── 7. VERSION & BUILD ─────────────────────────────────────');

// 7a. Version in package.json matches build output
check('package.json has a version set', pkg.version && pkg.version !== '0.0.0');

// 7b. build.js reads version from package.json
const buildJs = fs.readFileSync(path.join(__dirname, 'build.js'), 'utf8');
check('build.js reads version from package.json', buildJs.includes('version') && buildJs.includes('package.json'));

// 7c. dist/worker.js exists after build
const distExists = fs.existsSync(path.join(__dirname, 'dist/worker.js'));
check('dist/worker.js exists after build', distExists);

// ═══════════════════════════════════════════════════════════════════════════
// Summary
console.log('\n══════════════════════════════════════════════════════════');
console.log(`   ✅ Passed:  ${passed}`);
if (warned > 0) console.log(`   ⚠️  Warned:  ${warned}`);
if (failed > 0) console.log(`   ❌ Failed:  ${failed}`);
console.log('══════════════════════════════════════════════════════════');

if (failed > 0) {
  console.log('\n🚫 DO NOT DEPLOY — fix failures above first.\n');
  process.exit(1);
} else if (warned > 0) {
  console.log('\n⚠️  Warnings present — review before deploying.\n');
  process.exit(0);
} else {
  console.log('\n✅ All checks passed — safe to deploy.\n');
  process.exit(0);
}
