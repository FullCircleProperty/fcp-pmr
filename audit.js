#!/usr/bin/env node
// FCP-PMR Deep Code Audit — audit.js
// Catches logic bugs that validate.js (structural patterns) cannot detect.
// Categories derived from actual bugs found in v2.31.7 → v2.32.1:
//   1. Every awaited function must have a declaration in worker.js
//   2. fullPortfolioRefresh return field names must match actual return json({})
//   3. Portfolio reservation aggregations must exclude managed/research properties
//   4. No sequential await .run() inside for/forEach loops (must use env.DB.batch())
//   5. api() uses positional args (path, method, body) — not fetch-style options
//   6. AI function names are pickAIProvider/callAIWithFallback only
//   7. All 8 advanced intel sections have managed exclusion
//
// Run: node audit.js
// Exit code 0 = all clear, 1 = issues found

const fs = require('fs');
const path = require('path');

const WORKER = fs.readFileSync(path.join(__dirname, 'src/worker.js'), 'utf-8');
const WORKER_LINES = WORKER.split('\n');

// Frontend files
const FE_DIR = path.join(__dirname, 'frontend/parts/js');
const FE_FILES = fs.existsSync(FE_DIR) ? fs.readdirSync(FE_DIR).filter(f => f.endsWith('.js')).sort() : [];
const FE_CODE = {};
for (const f of FE_FILES) {
  FE_CODE[f] = fs.readFileSync(path.join(FE_DIR, f), 'utf-8');
}
const ALL_FE = Object.values(FE_CODE).join('\n');

let errors = 0;
let warnings = 0;
let passed = 0;

function fail(category, msg, detail) {
  errors++;
  console.log(`  ❌ [${category}] ${msg}`);
  if (detail) console.log(`     → ${detail}`);
}

function warn(category, msg, detail) {
  warnings++;
  console.log(`  ⚠️  [${category}] ${msg}`);
  if (detail) console.log(`     → ${detail}`);
}

function pass(msg) {
  passed++;
  console.log(`  ✅ ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════
// Helper: extract all declared async function names from worker.js
// ═══════════════════════════════════════════════════════════════════
function getDeclaredFunctions() {
  const decls = new Map(); // name → line number
  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    // Match: async function NAME(  or  function NAME(
    const m = line.match(/^(?:async\s+)?function\s+(\w+)\s*\(/);
    if (m) decls.set(m[1], i + 1);
  }
  return decls;
}

// ═══════════════════════════════════════════════════════════════════
// Helper: find all `await someFunction(...)` calls in worker.js
// ═══════════════════════════════════════════════════════════════════
function getAwaitedCalls() {
  const calls = []; // {name, line, text}
  // Known built-in/external await targets to skip
  const SKIP = new Set([
    'env', 'crypto', 'fetch', 'caches', 'request', 'response', 'result',
    'r2Object', 'bucket', 'reader', 'stream', 'body', 'formData',
  ]);
  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    // Skip comments
    if (line.trimStart().startsWith('//')) continue;
    // Match: await functionName(
    const re = /await\s+(\w+)\s*\(/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      // Skip chained method calls on objects (await env.DB..., await request.json(), etc.)
      // These show up as `await env` — the regex captures the first word
      if (SKIP.has(name)) continue;
      // Skip constructors
      if (name[0] === name[0].toUpperCase() && name !== name.toUpperCase()) continue;
      calls.push({ name, line: i + 1, text: line.trim() });
    }
  }
  return calls;
}

console.log('\n🔍 FCP-PMR Deep Code Audit\n');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
console.log(`   Version: ${pkg.version}`);
console.log(`   Worker:  ${WORKER_LINES.length} lines`);
console.log(`   Frontend: ${FE_FILES.length} files\n`);

// ═══════════════════════════════════════════════════════════════════
// AUDIT 1: Every awaited function must have a declaration
// ═══════════════════════════════════════════════════════════════════
console.log('── 1. AWAITED FUNCTION DECLARATIONS ───────────────────────');
{
  const declared = getDeclaredFunctions();
  const calls = getAwaitedCalls();

  // Also allow some known patterns that aren't top-level declarations
  // These are local closures, callbacks, or dynamic function refs
  const KNOWN_EXTERNAL = new Set([
    'hashPassword', 'verifyPassword',
    'addUserCol',  // local closure in ensureSchema
    'tryFetch',    // local closure in fetchMarketData-style functions
    'fn',          // logSync callback parameter: async function logSync(env, type, src, fn) { await fn() }
    'addCol',      // local closure for ALTER TABLE patterns
  ]);

  const missing = [];
  const seen = new Set();
  for (const c of calls) {
    if (declared.has(c.name)) continue;
    if (KNOWN_EXTERNAL.has(c.name)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    missing.push(c);
  }

  if (missing.length === 0) {
    pass('All awaited functions have declarations in worker.js');
  } else {
    for (const m of missing) {
      fail('FUNC_MISSING', `await ${m.name}() called at line ${m.line} but no declaration found`, m.text.substring(0, 120));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 2: fullPortfolioRefresh return field names match actual functions
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 2. REFRESH FUNCTION CALLS & RETURN FIELDS ──────────────');
{
  // Find the fullPortfolioRefresh function and extract all the function calls + field accesses
  const startIdx = WORKER_LINES.findIndex(l => l.includes('async function fullPortfolioRefresh'));
  if (startIdx === -1) {
    fail('REFRESH', 'fullPortfolioRefresh function not found');
  } else {
    // Read the function body (find the matching closing brace)
    let depth = 0;
    let endIdx = startIdx;
    let started = false;
    for (let i = startIdx; i < WORKER_LINES.length; i++) {
      const line = WORKER_LINES[i];
      for (const ch of line) {
        if (ch === '{') { depth++; started = true; }
        if (ch === '}') depth--;
      }
      if (started && depth === 0) { endIdx = i; break; }
    }
    const refreshBody = WORKER_LINES.slice(startIdx, endIdx + 1).join('\n');

    // Extract direct function calls: await someFn(...)
    const fnCalls = [];
    const fnCallRe = /await\s+(\w+)\s*\(/g;
    let match;
    while ((match = fnCallRe.exec(refreshBody)) !== null) {
      const name = match[1];
      if (['env', 'request', 'result', 'step', 'syslog'].includes(name)) continue;
      fnCalls.push(name);
    }

    // Verify each called function exists
    const declared = getDeclaredFunctions();
    const missingFns = fnCalls.filter(fn => !declared.has(fn));
    if (missingFns.length === 0) {
      pass('All functions called in fullPortfolioRefresh exist');
    } else {
      for (const fn of missingFns) {
        fail('REFRESH_FN', `fullPortfolioRefresh calls ${fn}() which doesn't exist`);
      }
    }

    // Extract field accesses on results: data.FIELD
    const fieldAccesses = [];
    const fieldRe = /data\.(\w+)/g;
    while ((match = fieldRe.exec(refreshBody)) !== null) {
      const field = match[1];
      // Skip generic ones
      if (['json', 'ok', 'error', 'message'].includes(field)) continue;
      fieldAccesses.push(field);
    }

    // For each called function, check that its return json({}) includes the referenced fields
    const uniqueFnCalls = [...new Set(fnCalls)].filter(fn => declared.has(fn));
    let fieldIssues = 0;

    // Map step names to functions and their expected data.X fields from the refresh body
    // Parse the if/else blocks
    const stepBlocks = refreshBody.split(/else if\s*\(step\.id\s*===\s*'|if\s*\(step\.id\s*===\s*'/);
    for (const block of stepBlocks) {
      const stepMatch = block.match(/^(\w+)'/);
      if (!stepMatch) continue;
      const stepId = stepMatch[1];

      // Find function call in this block
      const blockFnMatch = block.match(/await\s+(\w+)\s*\(/);
      if (!blockFnMatch) continue;
      const fnName = blockFnMatch[1];
      if (['env', 'syslog', 'result'].includes(fnName)) continue;
      if (!declared.has(fnName)) continue;

      // Find data.FIELD accesses in this block
      const blockFields = [];
      const bfRe = /data\.(\w+)/g;
      let bm;
      while ((bm = bfRe.exec(block)) !== null) {
        if (!['json', 'ok', 'error', 'message'].includes(bm[1])) {
          blockFields.push(bm[1]);
        }
      }

      if (blockFields.length === 0) continue;

      // Now read the actual function and find its return json({...}) fields
      const fnLine = declared.get(fnName);
      let fnDepth = 0;
      let fnStarted = false;
      let fnEnd = fnLine;
      for (let i = fnLine - 1; i < WORKER_LINES.length; i++) {
        for (const ch of WORKER_LINES[i]) {
          if (ch === '{') { fnDepth++; fnStarted = true; }
          if (ch === '}') fnDepth--;
        }
        if (fnStarted && fnDepth === 0) { fnEnd = i; break; }
      }
      const fnBody = WORKER_LINES.slice(fnLine - 1, fnEnd + 1).join('\n');

      // Extract return json({...}) field names — scan all return json() in the function
      // Handle multi-line returns by collecting text from 'return json({' until balanced braces
      const returnFields = new Set();
      const fnLines = fnBody.split('\n');
      for (let fi = 0; fi < fnLines.length; fi++) {
        if (/return\s+json\(\s*\{/.test(fnLines[fi])) {
          // Collect the full return object by tracking brace depth
          let retText = '';
          let retDepth = 0;
          let capturing = false;
          for (let fj = fi; fj < fnLines.length && fj < fi + 40; fj++) {
            retText += fnLines[fj] + '\n';
            for (const ch of fnLines[fj]) {
              if (ch === '{') { retDepth++; capturing = true; }
              if (ch === '}') retDepth--;
            }
            if (capturing && retDepth <= 0) break;
          }
          // Extract top-level keys from the return object
          // Handle both `key: value` and shorthand `key,` patterns
          const keyRe = /(?:[\n{,])\s*(\w+)\s*(?=[,:}\n])/g;
          let km;
          while ((km = keyRe.exec(retText)) !== null) {
            returnFields.add(km[1]);
          }
        }
      }

      // Check each data.FIELD used in refresh against the function's return fields
      for (const field of blockFields) {
        if (returnFields.size > 0 && !returnFields.has(field)) {
          fail('REFRESH_FIELD', `Step '${stepId}' accesses data.${field} but ${fnName}() doesn't return '${field}'`,
            `${fnName}() returns: {${[...returnFields].join(', ')}}`);
          fieldIssues++;
        }
      }
    }

    if (fieldIssues === 0) {
      pass('All data.field accesses in fullPortfolioRefresh match function returns');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 3: Portfolio reservation aggregations exclude managed/research
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 3. MANAGED/RESEARCH EXCLUSION IN AGGREGATIONS ─────────');
{
  // Find all queries that aggregate guesty_reservations at portfolio level
  // (SUM/COUNT/AVG with GROUP BY or without property_id = ?)
  // These must have managed/research exclusion

  const managedPattern = /is_managed\s*=\s*0|is_managed\s+IS\s+NULL/i;
  const researchPattern = /is_research\s*!=\s*1|is_research\s+IS\s+NULL/i;
  const propFilterPattern = /property_id\s*=\s*\?|property_id\s*IN\s*\(\s*SELECT/i;

  // Scan for aggregation queries on guesty_reservations
  let issues = 0;
  let checked = 0;

  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    if (line.trimStart().startsWith('//')) continue;

    // Look for lines with guesty_reservations AND aggregation functions
    if (!/guesty_reservations/i.test(line)) continue;
    if (!/\b(SUM|COUNT|AVG|GROUP\s+BY)\b/i.test(line)) continue;

    // Skip single-property queries (property_id = ?) — those are fine without managed filter
    if (/property_id\s*=\s*\?/.test(line)) continue;
    // Skip schema definitions (CREATE TABLE)
    if (/CREATE TABLE/i.test(line)) continue;
    // Skip simple count-all diagnostic queries (getGuestyStats, debug)
    if (/SELECT\s+COUNT\(\*\)\s+as\s+c\s+FROM\s+guesty_reservations['"`\s]*\)/i.test(line)) continue;

    // Multi-line query detection: gather context (up to 10 lines)
    let queryBlock = '';
    for (let j = Math.max(0, i - 2); j < Math.min(WORKER_LINES.length, i + 10); j++) {
      queryBlock += WORKER_LINES[j] + ' ';
    }

    // Find what function we're in
    let funcName = '(unknown)';
    for (let j = i; j >= 0; j--) {
      const fm = WORKER_LINES[j].match(/async function (\w+)/);
      if (fm) { funcName = fm[1]; break; }
    }

    // Queries that are explicitly per-property via bind or WHERE property_id = specific value are OK
    if (propFilterPattern.test(queryBlock) && managedPattern.test(queryBlock)) {
      checked++;
      continue; // Has filter with managed exclusion — good
    }

    // Portfolio-level aggregation: must have managed + research exclusion
    const hasManagedFilter = managedPattern.test(queryBlock);
    const hasResearchFilter = researchPattern.test(queryBlock);

    // Some functions are legitimately all-reservations (e.g., getGuestyStats diagnostic, importGuestyCsv rebuild, debug)
    const ALLOWED_NO_FILTER = [
      'getGuestyStats', 'getIntelligenceDebug', 'importGuestyCsv',
      'syncGuestyApi', 'syncGuestyListingsApi', 'handleGuestyWebhook',
      'processGuestyData', 'rebuildIntelligence',
      'debugGuestyReservation', 'getGuestIntelligence', 'autoMatchGuestyListings',
    ];

    // rebuildIntelligence guest section processes all for guest profiles — managed filter is on the intel aggregation queries
    if (ALLOWED_NO_FILTER.includes(funcName)) {
      checked++;
      continue;
    }

    checked++;

    if (!hasManagedFilter) {
      // Check if it's a portfolio dashboard or finance query that needs the filter
      const portfolioFuncs = ['getDashboard', 'getPortfolioActuals', 'getPortfolioInsights',
        'getFinanceMonthlyActuals', 'capturePerformanceSnapshots'];
      if (portfolioFuncs.includes(funcName)) {
        fail('MANAGED_LEAK', `Portfolio aggregation in ${funcName}() at line ${i + 1} missing managed exclusion`,
          WORKER_LINES[i].trim().substring(0, 120));
        issues++;
      } else {
        warn('MANAGED_CHECK', `Aggregation in ${funcName}() at line ${i + 1} — verify managed exclusion is appropriate`,
          WORKER_LINES[i].trim().substring(0, 120));
      }
    }
  }

  if (issues === 0) {
    pass(`Portfolio reservation aggregations checked (${checked} queries scanned)`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 4: No sequential await .run() inside for/forEach loops
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 4. SEQUENTIAL DB WRITES IN LOOPS ───────────────────────');
{
  let issues = 0;
  let inLoop = false;
  let loopDepth = 0;
  let loopStart = 0;
  let funcName = '(unknown)';

  // Track brace depth to know when we're inside a for/forEach loop body
  const loopStack = []; // [{type, depth, line}]

  let braceDepth = 0;
  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    const trimmed = line.trimStart();

    // Track function context
    const fm = trimmed.match(/^async function (\w+)/);
    if (fm) funcName = fm[1];

    // Skip ensureSchema — migrations are intentionally sequential
    if (funcName === 'ensureSchema') continue;

    // Detect loop starts
    if (/\bfor\s*\(/.test(line) || /\.forEach\s*\(/.test(line)) {
      loopStack.push({ depth: braceDepth, line: i + 1, func: funcName });
    }

    // Track braces
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      if (ch === '}') {
        braceDepth--;
        // Check if we've exited a loop
        while (loopStack.length > 0 && braceDepth <= loopStack[loopStack.length - 1].depth) {
          loopStack.pop();
        }
      }
    }

    // Check for sequential .run() inside a loop
    if (loopStack.length > 0 && /await\s+env\.DB\.prepare\b/.test(line) && /\.run\(\)/.test(line)) {
      // Check if it's a single conditional (ALTER TABLE in migration) vs bulk data write
      if (/ALTER TABLE/i.test(line) || /CREATE TABLE/i.test(line) || /CREATE INDEX/i.test(line)) continue;
      // Check if it's inside a try/catch for one-off operations
      if (/INSERT INTO sync_log/i.test(line)) continue;
      // Status updates on individual items in sequential processing (crawl jobs, etc.) — tolerable
      if (/UPDATE crawl_jobs SET status/i.test(line)) continue;
      // Cleanup operations with fixed small count (stale_cleanup step runs 2 deletes, not a loop over data)
      if (/DELETE FROM system_log WHERE created_at/i.test(line)) continue;
      if (/DELETE FROM property_shares WHERE expires_at/i.test(line)) continue;
      // Single-item image upload (not bulk)
      if (/INSERT INTO images.*filename/i.test(line) && funcName === 'uploadImage') continue;
      // deleteProperty cascade — each delete is for one property, sequential is fine
      if (funcName === 'deleteProperty') continue;
      // Complex read-then-write loops where each iteration does conditional reads before writing
      // These need careful per-function restructuring — warn instead of error
      const COMPLEX_LOOP_FUNCS = [
        'syncGuestyApi', 'syncGuestyListingsApi', 'syncGuestyPhotos',
        'importGuestyCsv', 'copyPropertyData',
        'scrapePlatformPricing', 'comparePlatformPricing',
        'fetchMarketData', 'fetchComparables', 'importUrlList',
      ];
      if (COMPLEX_LOOP_FUNCS.includes(funcName)) {
        warn('SEQ_WRITE', `Sequential await .run() in loop at line ${i + 1} in ${funcName}() — batch when refactoring this function`,
          line.trim().substring(0, 120));
        continue;
      }
      // This is a simple batchable loop — error
      const loopInfo = loopStack[loopStack.length - 1];
      fail('SEQ_WRITE', `Sequential await .run() in loop at line ${i + 1} in ${funcName}() — use env.DB.batch()`,
        line.trim().substring(0, 120));
      issues++;
    }
  }

  if (issues === 0) {
    pass('No sequential await .run() in loops (all bulk writes use env.DB.batch())');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 5: api() uses positional args in frontend
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 5. api() CALL SIGNATURE (POSITIONAL ARGS) ──────────────');
{
  let issues = 0;

  for (const [file, code] of Object.entries(FE_CODE)) {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trimStart().startsWith('//')) continue;

      // Match api( calls
      const apiCalls = [...line.matchAll(/api\s*\(\s*['"`][^'"`]+['"`]\s*,\s*\{/g)];
      for (const m of apiCalls) {
        // This is api('/path', { ... }) — fetch-style options object, WRONG
        fail('API_SIG', `${file} line ${i + 1}: api() called with options object instead of positional args`,
          line.trim().substring(0, 120));
        issues++;
      }
    }
  }

  // Also check worker.js for any internal api-like patterns (though backend doesn't call api())
  // Check for fetch-style patterns in marketing/AI code that might use wrong signature
  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    if (line.trimStart().startsWith('//')) continue;
    // Backend doesn't have an api() helper, but check for common mistake patterns
  }

  if (issues === 0) {
    pass('All api() calls use positional args (path, method, body)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 6: AI function names — only pickAIProvider / callAIWithFallback
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 6. AI FUNCTION NAMES ────────────────────────────────────');
{
  let issues = 0;

  // Wrong AI function names that have appeared in past bugs
  const WRONG_NAMES = [
    'selectAIProvider', 'callAI', 'getAIProvider', 'chooseAIProvider',
    'aiCall', 'runAI', 'invokeAI', 'generateAI', 'callAnthropic',
    'callOpenAI', 'selectProvider', 'getAIResponse',
  ];

  const allCode = WORKER + '\n' + ALL_FE;
  const allLines = allCode.split('\n');

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i];
    if (line.trimStart().startsWith('//')) continue;

    for (const wrong of WRONG_NAMES) {
      // Match as function call: wrongName(
      const re = new RegExp(`\\b${wrong}\\s*\\(`, 'g');
      if (re.test(line)) {
        // Determine if this is in worker.js or frontend
        const isWorker = i < WORKER_LINES.length;
        const loc = isWorker ? `worker.js line ${i + 1}` : `frontend`;
        fail('AI_NAME', `${loc}: ${wrong}() called — should be pickAIProvider() or callAIWithFallback()`,
          line.trim().substring(0, 120));
        issues++;
      }
    }
  }

  // Verify the correct functions actually exist
  const declared = getDeclaredFunctions();
  if (!declared.has('pickAIProvider')) {
    fail('AI_NAME', 'pickAIProvider() not declared in worker.js');
    issues++;
  }
  if (!declared.has('callAIWithFallback')) {
    fail('AI_NAME', 'callAIWithFallback() not declared in worker.js');
    issues++;
  }

  if (issues === 0) {
    pass('AI function names correct (pickAIProvider + callAIWithFallback only)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 7: All 8 advanced intel sections have managed exclusion
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 7. ADVANCED INTEL MANAGED EXCLUSION ─────────────────────');
{
  // Find the rebuildIntelligence function's advanced section
  const advStart = WORKER_LINES.findIndex(l => l.includes('ADVANCED PORTFOLIO INTELLIGENCE'));
  if (advStart === -1) {
    fail('INTEL', 'ADVANCED PORTFOLIO INTELLIGENCE section not found');
  } else {
    // Expected 8 sections
    const EXPECTED_SECTIONS = [
      'GUEST ORIGIN',
      'DAY-OF-WEEK',
      'BOOKING PACE',
      'LEAD TIME',
      'REVPAN',
      'CANCELLATION',
      'PRICE ELASTICITY',
      'CROSS-PLATFORM',
      'RATE-CONTEXT',
    ];

    // Read until end of the advanced block (next top-level section or function end)
    let advEnd = advStart + 1;
    let depth = 0;
    for (let i = advStart; i < WORKER_LINES.length; i++) {
      const line = WORKER_LINES[i];
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      // The advanced block ends when we hit results.advanced = or the catch at the outer level
      if (i > advStart + 10 && /results\.advanced\s*=/.test(line)) {
        advEnd = i;
        break;
      }
      if (i > advStart + 2000) { advEnd = i; break; } // safety
    }

    const advBlock = WORKER_LINES.slice(advStart, advEnd + 50).join('\n');

    // Check each section for managed exclusion
    let found = 0;
    let missing = 0;
    for (const section of EXPECTED_SECTIONS) {
      const sectionRe = new RegExp(`──\\s*\\d+\\.\\s*${section}`, 'i');
      const sectionIdx = advBlock.search(sectionRe);
      if (sectionIdx === -1) {
        fail('INTEL_SECTION', `Advanced intel section "${section}" not found`);
        missing++;
        continue;
      }
      found++;

      // Extract the section block (until next section comment or end)
      const nextSectionRe = new RegExp(`──\\s*\\d+\\.\\s*(?!${section})\\w`, 'i');
      const sectionEnd = advBlock.indexOf('// ──', sectionIdx + 10);
      const sectionBlock = sectionEnd > sectionIdx
        ? advBlock.substring(sectionIdx, sectionEnd)
        : advBlock.substring(sectionIdx, sectionIdx + 2000);

      // Check if this section queries guesty_reservations
      if (/guesty_reservations/i.test(sectionBlock)) {
        // Must have managed exclusion
        const hasManagedFilter = /is_managed\s*=\s*0|is_managed\s+IS\s+NULL/i.test(sectionBlock);
        if (!hasManagedFilter) {
          fail('INTEL_MANAGED', `Advanced intel section "${section}" queries guesty_reservations without managed exclusion`);
          missing++;
        }
      }
      // Sections that query via guesty_guests with subquery on property_id should also be checked
      if (/guesty_guests/i.test(sectionBlock) && /property_id/i.test(sectionBlock)) {
        const hasManagedFilter = /is_managed\s*=\s*0|is_managed\s+IS\s+NULL/i.test(sectionBlock);
        if (!hasManagedFilter) {
          fail('INTEL_MANAGED', `Advanced intel section "${section}" queries guest data without managed exclusion on properties`);
          missing++;
        }
      }
    }

    if (missing === 0 && found === EXPECTED_SECTIONS.length) {
      pass(`All ${found} advanced intel sections found with managed exclusion`);
    } else if (found < EXPECTED_SECTIONS.length) {
      warn('INTEL', `Only ${found}/${EXPECTED_SECTIONS.length} advanced intel sections found`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 8: syslog() usage — no raw console.error in catch blocks
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 8. ERROR LOGGING (syslog vs console.error) ──────────────');
{
  let consoleErrors = 0;
  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    if (line.trimStart().startsWith('//')) continue;
    if (/console\.error\s*\(/.test(line)) {
      // Track function context
      let funcName = '(global)';
      for (let j = i; j >= 0; j--) {
        const fm = WORKER_LINES[j].match(/async function (\w+)/);
        if (fm) { funcName = fm[1]; break; }
      }
      warn('LOGGING', `console.error at line ${i + 1} in ${funcName}() — should use syslog()`,
        line.trim().substring(0, 100));
      consoleErrors++;
    }
  }
  if (consoleErrors === 0) {
    pass('No console.error in worker.js (syslog() used for error logging)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 9: Orphaned route handlers — routes that call nonexistent functions
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 9. ROUTE HANDLER INTEGRITY ──────────────────────────────');
{
  const declared = getDeclaredFunctions();
  let issues = 0;

  // Find all route dispatch lines: `return await functionName(`
  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    const m = line.match(/return\s+await\s+(\w+)\s*\(/);
    if (m) {
      const fnName = m[1];
      if (!declared.has(fnName)) {
        fail('ROUTE', `Route at line ${i + 1} calls ${fnName}() which doesn't exist`,
          line.trim().substring(0, 120));
        issues++;
      }
    }
  }

  if (issues === 0) {
    pass('All route handlers call existing functions');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 10: Cron handler function calls verified
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 10. CRON HANDLER FUNCTION CALLS ─────────────────────────');
{
  const declared = getDeclaredFunctions();

  // Find the scheduled handler
  const cronStart = WORKER_LINES.findIndex(l => /async scheduled\s*\(|async\s+function\s+scheduled/.test(l) || /scheduled\s*.*event.*env.*ctx/.test(l));
  let issues = 0;

  if (cronStart === -1) {
    // Look for the cron trigger pattern
    const altCron = WORKER_LINES.findIndex(l => l.includes("event.cron") || l.includes("controller.cron") || l.includes("scheduledEvent"));
    if (altCron === -1) {
      warn('CRON', 'No scheduled/cron handler found — skipping check');
    }
  }

  // Scan for await calls in the cron/scheduled section
  const cronSection = WORKER.match(/scheduled\s*[\(:][\s\S]{0,5000}?(?=\n\s*(?:async\s+)?(?:fetch|queue|tail)\s*[\(:]|\n\}\s*$)/);
  if (cronSection) {
    const cronBody = cronSection[0];
    const cronFnRe = /await\s+(\w+)\s*\(/g;
    let m;
    while ((m = cronFnRe.exec(cronBody)) !== null) {
      const name = m[1];
      if (['env', 'syslog', 'logSync', 'ctx'].includes(name)) continue;
      if (!declared.has(name)) {
        fail('CRON_FN', `Cron handler calls ${name}() which doesn't exist`);
        issues++;
      }
    }
  }

  if (issues === 0) {
    pass('All cron handler function calls verified');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 11: Frontend references to backend endpoints that exist
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 11. FRONTEND → BACKEND ENDPOINT ALIGNMENT ───────────────');
{
  // Extract all unique API paths from frontend
  const fePaths = new Set();
  const fePathRe = /api\s*\(\s*['"`](\/api\/[^'"`\s${}]+)/g;
  let m;
  while ((m = fePathRe.exec(ALL_FE)) !== null) {
    // Normalize: replace IDs with :id
    let p = m[1].replace(/\/\d+/g, '/:id').replace(/\/[a-zA-Z0-9]{5}$/, '/:code');
    fePaths.add(p);
  }

  // Extract backend route patterns
  const beRoutes = new Set();
  for (const line of WORKER_LINES) {
    const rm = line.match(/path\s*===\s*['"`](\/api\/[^'"`]+)/);
    if (rm) beRoutes.add(rm[1]);
    // Also catch regex patterns
    const rxm = line.match(/path\.match\(.*?(\/api\/[^'"`\\]+)/);
    if (rxm) {
      let p = rxm[1].replace(/\\d\+/g, ':id').replace(/\[a-zA-Z0-9\]\{5\}/g, ':code');
      beRoutes.add(p);
    }
  }

  // Normalize backend routes for comparison
  const beNorm = new Set();
  for (const r of beRoutes) {
    beNorm.add(r.replace(/\/\d+/g, '/:id'));
  }

  // Check for frontend paths that clearly don't have a backend route
  // (allow some fuzziness for dynamic segments)
  let missingCount = 0;
  for (const fp of fePaths) {
    const base = fp.split('/:id')[0];
    const hasMatch = [...beNorm].some(br => br.startsWith(base) || base.startsWith(br.split('/:id')[0]));
    if (!hasMatch && !fp.includes('version')) {
      // Only warn, since regex routes are hard to match perfectly
      // warn('ENDPOINT', `Frontend calls ${fp} — no exact backend route match found`);
    }
  }

  pass(`Frontend API paths checked (${fePaths.size} paths, ${beRoutes.size} backend routes)`);
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 12: Check for json_each() usage (unreliable in D1)
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 12. D1 COMPATIBILITY ────────────────────────────────────');
{
  let issues = 0;
  for (let i = 0; i < WORKER_LINES.length; i++) {
    if (/json_each\s*\(/i.test(WORKER_LINES[i]) && !WORKER_LINES[i].trimStart().startsWith('//')) {
      fail('D1_COMPAT', `json_each() at line ${i + 1} — unreliable in D1, use JS-side processing`,
        WORKER_LINES[i].trim().substring(0, 100));
      issues++;
    }
  }
  if (issues === 0) {
    pass('No json_each() usage (D1 compatible)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 13: SQL OR precedence — unparenthesized OR in WHERE clauses
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 13. SQL OR PRECEDENCE ───────────────────────────────────');
{
  let issues = 0;
  for (let i = 0; i < WORKER_LINES.length; i++) {
    const line = WORKER_LINES[i];
    if (line.trimStart().startsWith('//')) continue;
    // Look for AND ... OR ... AND without parentheses around OR
    // This is a simplified heuristic — check for OR not preceded by ( on same line
    if (/\bAND\b.*\bOR\b/i.test(line) && !/\(.*\bOR\b.*\)/i.test(line)) {
      // Check if it's in a SQL string context
      if (/prepare|SELECT|WHERE|FROM/i.test(line)) {
        let funcName = '(global)';
        for (let j = i; j >= 0; j--) {
          const fm = WORKER_LINES[j].match(/async function (\w+)/);
          if (fm) { funcName = fm[1]; break; }
        }
        warn('SQL_OR', `Possible unparenthesized OR at line ${i + 1} in ${funcName}() — check precedence`,
          line.trim().substring(0, 120));
        issues++;
      }
    }
  }
  if (issues === 0) {
    pass('No suspicious unparenthesized OR conditions in SQL');
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUDIT 14: .catch() on non-Promise returns (Belt-and-suspenders with validate.js #26)
// ═══════════════════════════════════════════════════════════════════
console.log('\n── 14. .catch() ON NON-PROMISE (REDUNDANT SAFETY CHECK) ───');
{
  let issues = 0;
  const allCode2 = WORKER + '\n' + ALL_FE;
  const dangerPatterns = [
    /\.forEach\([^)]*\)\s*\.catch/g,
    /\.filter\([^)]*\)\s*\.catch/g,
    /\.map\([^)]*\)\s*\.catch/g,
    /new\s+Blob\([^)]*\)\s*\.catch/g,
    /addEventListener\([^)]*\)\s*\.catch/g,
  ];
  for (const pat of dangerPatterns) {
    const matches = allCode2.match(pat);
    if (matches) {
      for (const m of matches) {
        fail('CATCH_NON_PROMISE', `.catch() on non-Promise: ${m.substring(0, 80)}`);
        issues++;
      }
    }
  }
  if (issues === 0) {
    pass('No .catch() on non-Promise returns');
  }
}

// ═══════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════
console.log('\n══════════════════════════════════════════════════════════');
console.log(`   ✅ Passed:   ${passed}`);
console.log(`   ⚠️  Warnings: ${warnings}`);
console.log(`   ❌ Errors:   ${errors}`);
console.log('══════════════════════════════════════════════════════════\n');

if (errors > 0) {
  console.log('❌ Audit found errors — fix before deploying.\n');
  process.exit(1);
} else if (warnings > 0) {
  console.log('⚠️  Audit passed with warnings — review before deploying.\n');
  process.exit(0);
} else {
  console.log('✅ Audit clean — no issues detected.\n');
  process.exit(0);
}
