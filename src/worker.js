// FCP Property Market Research — Cloudflare Worker API
// With Auth, User Management, Admin Approval, DNS Config

const APP_VERSION = '__APP_VERSION__';
const BUILD_DATE = '__BUILD_DATE__';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEFAULT_ADMIN_PASSWORD = 'PMR@dmin2026!';
const SESSION_TTL_HOURS = 720; // 30 days

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function html(content) {
  return new Response(content, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS },
  });
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  const hashHex = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
  return saltHex + ':' + hashHex;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  const checkHex = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
  return checkHex === hashHex;
}

function generateToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  return await env.DB.prepare(`
    SELECT s.*, u.id as user_id, u.email, u.display_name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(token).first();
}

function requireAuth(user) {
  if (!user) return json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, 401);
  if (user.role === 'pending') return json({ error: 'Account pending approval', code: 'PENDING_APPROVAL' }, 403);
  return null;
}

function requireAdmin(user) {
  const err = requireAuth(user);
  if (err) return err;
  if (user.role !== 'admin') return json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' }, 403);
  return null;
}

// Get effective user_id: admin can "view as" another user via ?as_user=ID
function getEffectiveUserId(user, searchParams) {
  if (!user) return null;
  if (user.role === 'admin' && searchParams) {
    const asUser = searchParams.get('as_user');
    if (asUser) return parseInt(asUser);
  }
  return user.user_id;
}

let migrationDone = false;
// Canonical reservation status exclusion list — used in 34+ queries
// ANY status in this list is considered non-live (canceled, pending, etc.)
// To add a new excluded status, add it here ONCE — all queries reference this constant
const EXCLUDED_STATUSES = "'canceled','cancelled','declined','expired','denied','no_show','inquiry','awaiting_payment','pending','quote'";
const LIVE_STATUS_SQL = `LOWER(COALESCE(status,'')) NOT IN (${EXCLUDED_STATUSES})`;
const LIVE_STATUS_GR = `LOWER(COALESCE(gr.status,'')) NOT IN (${EXCLUDED_STATUSES})`;
const LIVE_STATUS_MA = `LOWER(COALESCE(ma.status,'')) NOT IN (${EXCLUDED_STATUSES})`;

// Canonical managed API keys list — used in fetch handler and cron handler
// To add a new API key, add it here ONCE — both handlers reference this constant
const MANAGED_KEYS = ['ANTHROPIC_API_KEY','OPENAI_API_KEY','RENTCAST_API_KEY','GOOGLE_PLACES_API_KEY','SEARCHAPI_KEY','PRICELABS_API_KEY','GUESTY_CLIENT_ID','GUESTY_CLIENT_SECRET'];

// ── Persistent system logger — writes to system_log table ──
// Usage: await syslog(env, 'error', 'getDashboard', 'Query failed', e.message, propertyId)
// Levels: 'error', 'warn', 'info'
// Rate-limited: deduplicates identical source+message within 60 seconds
const _syslogRecent = new Map(); // in-memory dedup cache
async function syslog(env, level, source, message, detail, propertyId) {
  try {
    // Deduplicate: same source+message within 60s → skip
    const dedupKey = source + ':' + (message || '').substring(0, 80);
    const now = Date.now();
    if (_syslogRecent.has(dedupKey) && now - _syslogRecent.get(dedupKey) < 60000) return;
    _syslogRecent.set(dedupKey, now);
    // Cap cache size
    if (_syslogRecent.size > 200) {
      const oldest = [..._syslogRecent.entries()].sort((a, b) => a[1] - b[1]).slice(0, 100);
      for (const [k] of oldest) _syslogRecent.delete(k);
    }
    await env.DB.prepare(
      `INSERT INTO system_log (level, source, message, detail, property_id) VALUES (?, ?, ?, ?, ?)`
    ).bind(level || 'error', source || 'unknown', (message || '').substring(0, 500), (detail || '').substring(0, 2000), propertyId || null).run();
  } catch { /* logging should never crash the app */ }
}

async function trackAI(env, endpoint, provider, tokensApprox, success, errorMsg) {
  const costs = API_COSTS[provider] || {};
  // Cost estimates: Anthropic claude-sonnet-4 ~$0.9/1K tokens blended, OpenAI gpt-4o-mini ~$0.04/1K tokens blended
  const estCostCents = provider === 'anthropic' ? Math.round(tokensApprox * 0.9 / 1000 * 100) / 100 :
    provider === 'openai' ? Math.round(tokensApprox * 0.04 / 1000 * 100) / 100 : 0;
  try {
    await env.DB.prepare(`INSERT INTO ai_usage (endpoint, provider, tokens_approx, success, error_msg, cost_cents) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(endpoint, provider, tokensApprox || 0, success ? 1 : 0, errorMsg || null, estCostCents).run();
  } catch {
    try { await env.DB.prepare(`INSERT INTO ai_usage (endpoint, provider, tokens_approx, success, error_msg) VALUES (?, ?, ?, ?, ?)`)
      .bind(endpoint, provider, tokensApprox || 0, success ? 1 : 0, errorMsg || null).run(); } catch {}
  }
}

async function getRcLimit(env) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'rc_monthly_limit'`).first();
    return row ? parseInt(row.value) : 50;
  } catch { return 50; }
}

async function getRcUsageThisMonth(env) {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM rc_usage WHERE created_at >= date('now', 'start of month')`).first();
    return row?.c || 0;
  } catch { return 0; }
}

async function checkRentCastLimit(env) {
  const limit = await getRcLimit(env);
  const used = await getRcUsageThisMonth(env);
  return { allowed: used < limit, used, limit, remaining: Math.max(0, limit - used) };
}

async function trackRcCall(env, endpoint, city, state, success) {
  try { await env.DB.prepare(`INSERT INTO rc_usage (endpoint, city, state, success) VALUES (?, ?, ?, ?)`).bind(endpoint, city || '', state || '', success ? 1 : 0).run(); } catch {}
}

async function getApiLimit(env, service) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind(service + '_monthly_limit').first();
    if (row) return parseInt(row.value);
  } catch {}
  return API_COSTS[service] ? API_COSTS[service].free_limit : 100;
}

async function getApiUsageCount(env, service) {
  try {
    const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM api_usage WHERE service = ? AND created_at >= date('now', 'start of month')`).bind(service).first();
    return row?.c || 0;
  } catch { return 0; }
}

async function checkApiLimit(env, service) {
  const limit = await getApiLimit(env, service);
  const used = await getApiUsageCount(env, service);
  return { allowed: used < limit, used, limit, remaining: Math.max(0, limit - used) };
}

const API_COSTS = {
  rentcast: { free_limit: 50, per_call_cents: 1, label: 'RentCast' },
  searchapi: { free_limit: 100, per_call_cents: 0.5, label: 'SearchAPI' },
  google_places: { free_limit: 1000, per_call_cents: 0.3, label: 'Google Places' },
  pricelabs: { free_limit: 999999, per_call_cents: 0, label: 'PriceLabs' },
  anthropic: { free_limit: 0, per_call_cents: 8, label: 'Anthropic Claude', per_1k_input: 0.3, per_1k_output: 1.5 },
  openai: { free_limit: 0, per_call_cents: 6, label: 'OpenAI GPT-4o', per_1k_input: 0.25, per_1k_output: 1.0 },
  workers_ai: { free_limit: 999999, per_call_cents: 0, label: 'Workers AI (Free)' },
  // Fixed infrastructure — always included in totals
  cloudflare_workers: { fixed_monthly_cents: 500, label: 'Cloudflare Workers Paid', note: '$5/mo · 10M req/mo · removes 1MB bundle limit' },
};

// AI task classification: which tasks need premium AI vs free
const AI_TASK_TIER = {
  url_parse: 'free',
  market_search: 'free',
  comp_analysis: 'free',
  pricing_analysis: 'premium',
  pl_strategy: 'premium',
  revenue_optimization: 'premium',
  acquisition_analysis: 'premium',
  market_enrich: 'premium',
  pricing_compare: 'free',
};

// Smart AI router: picks the best provider based on task importance
async function pickAIProvider(env, taskName, qualityPref) {
  // qualityPref: 'best' = try paid first, 'economy' = workers_ai only, undefined = use task tier
  const tier = AI_TASK_TIER[taskName] || 'free';
  const usePremium = qualityPref === 'best' || (qualityPref !== 'economy' && tier === 'premium');
  if (usePremium) {
    if (env.ANTHROPIC_API_KEY && await checkBudget(env, 'anthropic')) return 'anthropic';
    if (env.OPENAI_API_KEY && await checkBudget(env, 'openai')) return 'openai';
    // No paid provider available — fall back to free
  }
  return env.AI ? 'workers_ai' : null;
}


// Shared AI call helper — used by PL strategy, revenue optimize, acquisition analysis
// Respects pickAIProvider order, budget limits, and automatic fallback
async function callAIWithFallback(env, taskName, prompt, maxTokensMain, maxTokensWorkers) {
  const providers = [];
  const pref = await pickAIProvider(env, taskName, 'best');
  // Build ordered list: preferred first, then fallbacks
  if (pref) providers.push(pref);
  if (pref !== 'anthropic' && env.ANTHROPIC_API_KEY && await checkBudget(env, 'anthropic')) providers.push('anthropic');
  if (pref !== 'openai' && env.OPENAI_API_KEY && await checkBudget(env, 'openai')) providers.push('openai');
  if (pref !== 'workers_ai' && env.AI) providers.push('workers_ai');

  for (const provider of providers) {
    try {
      let text = null;
      const maxTok = provider === 'workers_ai' ? (maxTokensWorkers || 4000) : (maxTokensMain || 3000);
      if (provider === 'anthropic') {
        const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: maxTok, messages: [{ role: 'user', content: prompt }] }) });
        const d = await r.json();
        if (!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (d?.error?.message || JSON.stringify(d).substring(0, 120)));
        text = d.content?.[0]?.text || null;
        if (!text) throw new Error('Anthropic empty response');
      } else if (provider === 'openai') {
        const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.OPENAI_API_KEY }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: maxTok }) });
        const d = await r.json();
        if (!r.ok) throw new Error('OpenAI ' + r.status + ': ' + (d?.error?.message || JSON.stringify(d).substring(0, 120)));
        text = d.choices?.[0]?.message?.content || null;
        if (!text) throw new Error('OpenAI empty response');
      } else if (provider === 'workers_ai') {
        const d = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: maxTok });
        text = d.response;
        if (!text) throw new Error('Workers AI empty response');
      }
      if (text) {
        await trackAI(env, taskName, provider, maxTok, true, null);
        await trackApiCall(env, provider === 'workers_ai' ? 'workers_ai' : provider, taskName, true);
        return { text, provider };
      }
    } catch (e) {
      await trackAI(env, taskName, provider, 0, false, e.message);
      // continue to next provider
    }
  }
  return null; // all providers failed
}

async function checkBudget(env, service) {
  try {
    const budgetRow = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('budget_' + service).first();
    const budget = budgetRow ? parseFloat(budgetRow.value) : 20.00; // Default $20/mo per provider
    if (budget <= 0) return false;
    const spentRow = await env.DB.prepare(`SELECT SUM(cost_cents) as spent FROM ai_usage WHERE provider = ? AND created_at >= date('now', 'start of month')`).bind(service).first();
    const spentDollars = (spentRow?.spent || 0) / 100;
    return spentDollars < budget;
  } catch { return true; }
}

async function trackApiCall(env, service, endpoint, success) {
  const costInfo = API_COSTS[service] || { free_limit: 0, per_call_cents: 0 };
  try {
    // Count this month's usage for this service
    const row = await env.DB.prepare(`SELECT COUNT(*) as c FROM api_usage WHERE service = ? AND created_at >= date('now', 'start of month')`).bind(service).first();
    const monthCount = (row?.c || 0) + 1;
    const costCents = monthCount > costInfo.free_limit ? costInfo.per_call_cents : 0;
    await env.DB.prepare(`INSERT INTO api_usage (service, endpoint, success, cost_cents) VALUES (?, ?, ?, ?)`)
      .bind(service, endpoint || '', success ? 1 : 0, costCents).run();
  } catch {}
}

async function getApiUsageSummary(env) {
  const summary = {};
  try {
    const { results } = await env.DB.prepare(`SELECT service, COUNT(*) as calls, SUM(cost_cents) as total_cost_cents FROM api_usage WHERE created_at >= date('now', 'start of month') GROUP BY service`).all();
    for (const r of (results || [])) {
      const info = API_COSTS[r.service] || {};
      summary[r.service] = {
        label: info.label || r.service,
        calls: r.calls,
        free_limit: info.free_limit > 0 && info.free_limit < 999999 ? info.free_limit : null,
        remaining: info.free_limit > 0 && info.free_limit < 999999 ? Math.max(0, info.free_limit - r.calls) : null,
        over_limit: info.free_limit > 0 && info.free_limit < 999999 && r.calls > info.free_limit,
        cost_cents: Math.round(r.total_cost_cents || 0),
        per_call_cents: info.per_call_cents,
      };
    }
    // Per-endpoint breakdown for each service
    const { results: byEndpoint } = await env.DB.prepare(`SELECT service, endpoint, COUNT(*) as calls FROM api_usage WHERE created_at >= date('now', 'start of month') GROUP BY service, endpoint ORDER BY service, calls DESC`).all();
    const endpointMap = {};
    for (const r of (byEndpoint || [])) {
      if (!endpointMap[r.service]) endpointMap[r.service] = [];
      endpointMap[r.service].push({ endpoint: r.endpoint, calls: r.calls });
    }
    for (const svc in summary) {
      if (endpointMap[svc]) summary[svc].by_endpoint = endpointMap[svc];
    }
  } catch {}
  // Add AI provider usage from ai_usage table (separate from api_usage)
  try {
    const { results: aiRows } = await env.DB.prepare(`SELECT provider, COUNT(*) as calls, SUM(tokens_approx) as tokens, SUM(cost_cents) as cost FROM ai_usage WHERE created_at >= date('now', 'start of month') AND success = 1 GROUP BY provider`).all();
    for (const r of (aiRows || [])) {
      const prov = r.provider; // 'anthropic', 'openai', 'workers_ai'
      if (!summary[prov]) {
        const info = API_COSTS[prov] || {};
        summary[prov] = { label: info.label || prov, calls: 0, free_limit: null, remaining: null, over_limit: false, cost_cents: 0 };
      }
      summary[prov].calls = (summary[prov].calls || 0) + r.calls;
      summary[prov].cost_cents = (summary[prov].cost_cents || 0) + Math.round(r.cost || 0);
      summary[prov].tokens = (summary[prov].tokens || 0) + (r.tokens || 0);
    }
    // Add budget info for paid AI providers
    for (const prov of ['anthropic', 'openai']) {
      if (summary[prov]) {
        try {
          const brow = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('budget_' + prov).first();
          summary[prov].budget_dollars = brow ? parseFloat(brow.value) : 20.00;
        } catch { summary[prov].budget_dollars = 20.00; }
        // Budget-based over_limit for paid services
        const spentDollars = (summary[prov].cost_cents || 0) / 100;
        const budget = summary[prov].budget_dollars || 20.00;
        summary[prov].budget_remaining = Math.max(0, budget - spentDollars);
        summary[prov].budget_pct = budget > 0 ? Math.round(spentDollars / budget * 100) : 0;
        summary[prov].over_limit = spentDollars >= budget;
      }
    }
  } catch {}
  try {
    const plCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings`).first();
    summary.pricelabs_fixed = { label: 'PriceLabs (fixed)', listings: plCount?.c || 0, cost_cents: (plCount?.c || 0) * 100 };
  } catch {}
  // Always include fixed infrastructure costs
  summary.cloudflare_workers = {
    label: 'Cloudflare Workers Paid',
    fixed: true,
    note: '$5/mo · 10M req/mo · removes 1MB bundle limit',
    cost_cents: 500,
    calls: null,
  };
  return summary;
}

// SearchAPI tracked wrapper

async function rentCastFetch(url, rcKey, env, endpoint, city, state) {
  const check = await checkRentCastLimit(env);
  if (!check.allowed) {
    return { ok: false, limited: true, used: check.used, limit: check.limit, error: 'RentCast limit reached: ' + check.used + '/' + check.limit + ' calls this month' };
  }
  try {
    await trackApiCall(env, 'rentcast', endpoint, true);
    const res = await fetch(url, { headers: { 'Accept': 'application/json', 'X-Api-Key': rcKey } });
    await trackRcCall(env, endpoint, city, state, res.ok);
    if (res.ok) {
      const data = await res.json();
      return { ok: true, data, used: check.used + 1, limit: check.limit };
    }
    return { ok: false, status: res.status, error: 'API error: ' + res.status, used: check.used + 1, limit: check.limit };
  } catch (e) {
    await trackRcCall(env, endpoint, city, state, false);
    return { ok: false, error: e.message, used: check.used + 1, limit: check.limit };
  }
}
async function ensureSchema(env) {
  if (migrationDone) return;
  migrationDone = true;
  try {
    const cols = await env.DB.prepare(`SELECT name FROM pragma_table_info('properties')`).all();
    const existing = new Set((cols.results || []).map(r => r.name));
    const needed = [
      ['image_url','TEXT'], ['unit_number','TEXT'], ['ownership_type','TEXT'],
      ['monthly_mortgage','REAL'], ['monthly_insurance','REAL'],
      ['monthly_rent_cost','REAL'], ['security_deposit','REAL'],
      ['expense_electric','REAL'], ['expense_gas','REAL'], ['expense_water','REAL'],
      ['expense_internet','REAL'], ['expense_trash','REAL'], ['expense_other','REAL'],
      ['cleaning_fee','REAL'], ['parent_id','INTEGER'], ['latitude','REAL'], ['longitude','REAL'],
      ['parking_spaces','INTEGER'], ['total_units_count','INTEGER'], ['parcel_id','TEXT'], ['zoning','TEXT'],
      ['name','TEXT'], ['county','TEXT'], ['is_research','INTEGER'], ['cleaning_cost','REAL'],
      ['service_guesty','INTEGER'], ['service_lock','INTEGER'], ['service_pricelabs','INTEGER'],
      ['listing_url','TEXT'], ['listing_status','TEXT'],
      ['purchase_date','TEXT'], ['loan_amount','REAL'], ['interest_rate','REAL'], ['loan_term_years','INTEGER'],
      ['down_payment_pct','REAL'], ['zestimate','REAL'], ['zestimate_date','TEXT'], ['zillow_url','TEXT'],
      ['tax_rate_pct','REAL']
    ];
    for (const [col, type] of needed) {
      if (!existing.has(col)) {
        await env.DB.prepare(`ALTER TABLE properties ADD COLUMN ${col} ${type} DEFAULT ${type === 'TEXT' ? "''" : '0'}`).run();
      }
    }
    // Create images table
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, mime_type TEXT NOT NULL, data TEXT NOT NULL, size_bytes INTEGER, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Create market_insights table for AI analysis persistence
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_insights (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, state TEXT NOT NULL, insight_type TEXT DEFAULT 'deep_dive', analysis TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Create ai_usage table for tracking
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT, provider TEXT, tokens_approx INTEGER, success INTEGER DEFAULT 1, error_msg TEXT, cost_cents REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`).run();
    try { const aiCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('ai_usage')`).all(); if (!(aiCols.results || []).find(c => c.name === 'cost_cents')) await env.DB.prepare(`ALTER TABLE ai_usage ADD COLUMN cost_cents REAL DEFAULT 0`).run(); } catch {}
    // Create rc_usage table for RentCast rate limiting
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rc_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT, city TEXT, state TEXT, success INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Universal API usage tracking
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS api_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, service TEXT NOT NULL, endpoint TEXT, success INTEGER DEFAULT 1, cost_cents REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Performance tracking snapshots
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS performance_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, snapshot_date TEXT NOT NULL, base_price REAL, recommended_price REAL, min_price REAL, max_price REAL, cleaning_fee REAL, occupancy_7d TEXT, occupancy_30d TEXT, occupancy_60d TEXT, market_occ_30d TEXT, blended_adr REAL, est_monthly_revenue REAL, est_monthly_expenses REAL, est_monthly_net REAL, source TEXT DEFAULT 'sync', created_at TEXT DEFAULT (datetime('now')), UNIQUE(property_id, snapshot_date))`).run();
    // AI analysis reports (saved per property)
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS analysis_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, report_type TEXT NOT NULL, report_data TEXT NOT NULL, provider TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Property sharing codes
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS property_shares (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, share_code TEXT NOT NULL UNIQUE, label TEXT, expires_at TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Property monthly services
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS property_services (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, name TEXT NOT NULL, monthly_cost REAL NOT NULL, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Service catalog (auto-built from usage)
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS service_catalog (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, default_cost REAL, child_cost REAL, category TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Guesty reservation imports
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guesty_reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, confirmation_code TEXT NOT NULL UNIQUE, property_id INTEGER, guesty_listing_id TEXT, listing_name TEXT, check_in TEXT, check_out TEXT, nights_count INTEGER, guest_count INTEGER, guest_name TEXT, channel TEXT, status TEXT, accommodation_fare REAL, cleaning_fee REAL, total_fees REAL, total_taxes REAL, host_payout REAL, guest_total REAL, platform_fee REAL, currency TEXT DEFAULT 'USD', source_file TEXT, imported_at TEXT DEFAULT (datetime('now')))`).run();
    // Monthly actuals (aggregated from reservations)
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS monthly_actuals (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, month TEXT NOT NULL, booked_nights INTEGER DEFAULT 0, available_nights INTEGER DEFAULT 30, occupancy_pct REAL, total_revenue REAL, avg_nightly_rate REAL, num_reservations INTEGER DEFAULT 0, avg_stay_length REAL, cleaning_revenue REAL, host_payout REAL, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(property_id, month))`).run();
    // Market seasonality (derived from monthly_actuals)
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_seasonality (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, state TEXT NOT NULL, month_number INTEGER NOT NULL, avg_occupancy REAL, avg_adr REAL, multiplier REAL DEFAULT 1.0, sample_size INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(city, state, month_number))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, state TEXT NOT NULL, str_listing_count INTEGER, str_avg_adr REAL, str_median_adr REAL, str_avg_occupancy REAL, str_avg_rating REAL, str_avg_reviews INTEGER, str_property_mix TEXT, str_bedroom_mix TEXT, str_price_bands TEXT, str_superhost_pct REAL, ltr_avg_rent REAL, ltr_median_rent REAL, ltr_active_listings INTEGER, your_property_count INTEGER, your_avg_adr REAL, your_avg_occupancy REAL, your_total_revenue REAL, your_avg_rating REAL, adr_trend_3mo REAL, listing_count_trend_3mo REAL, new_listings_30d INTEGER, peak_months TEXT, low_months TEXT, peak_multiplier REAL, ai_demand_drivers TEXT, ai_regulatory_notes TEXT, ai_investment_thesis TEXT, ai_competitive_position TEXT, ai_recommendations TEXT, ai_risk_factors TEXT, ai_enriched_at TEXT, demographics_json TEXT, demographics_updated_at TEXT, last_updated TEXT DEFAULT (datetime('now')), UNIQUE(city, state))`).run();
    // Migrate market_profiles: add demographics columns for existing DBs
    try { const mpCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('market_profiles')`).all(); const mpSet = new Set((mpCols.results || []).map(r => r.name)); if (!mpSet.has('demographics_json')) await env.DB.prepare(`ALTER TABLE market_profiles ADD COLUMN demographics_json TEXT`).run(); if (!mpSet.has('demographics_updated_at')) await env.DB.prepare(`ALTER TABLE market_profiles ADD COLUMN demographics_updated_at TEXT`).run(); if (!mpSet.has('str_top_hosts')) await env.DB.prepare(`ALTER TABLE market_profiles ADD COLUMN str_top_hosts TEXT`).run(); } catch {}
    // Guesty listing mapping
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guesty_listings (id INTEGER PRIMARY KEY AUTOINCREMENT, guesty_listing_id TEXT UNIQUE, listing_name TEXT, listing_address TEXT, property_id INTEGER, auto_matched INTEGER DEFAULT 0, match_score REAL, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Capital / one-time expenses
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS property_expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, name TEXT NOT NULL, amount REAL NOT NULL, category TEXT DEFAULT 'other', date_incurred TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS property_images (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, image_url TEXT NOT NULL, caption TEXT, sort_order INTEGER DEFAULT 0, source TEXT DEFAULT 'upload', created_at TEXT DEFAULT (datetime('now')))`).run();
    // Guesty calendar — daily pricing/availability per listing (ACTUAL live prices)
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guesty_calendar (id INTEGER PRIMARY KEY AUTOINCREMENT, guesty_listing_id TEXT NOT NULL, property_id INTEGER, date TEXT NOT NULL, price REAL, min_nights INTEGER DEFAULT 1, status TEXT DEFAULT 'available', is_base_price INTEGER DEFAULT 1, currency TEXT DEFAULT 'USD', pl_recommended_price REAL, price_discrepancy REAL, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(guesty_listing_id, date))`).run();
    // Guesty guests — platform-agnostic guest profiles
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guesty_guests (id INTEGER PRIMARY KEY AUTOINCREMENT, guesty_id TEXT UNIQUE, full_name TEXT, email TEXT, phone TEXT, hometown TEXT, country TEXT, language TEXT, is_returning INTEGER DEFAULT 0, total_stays INTEGER DEFAULT 0, total_revenue REAL DEFAULT 0, avg_stay_nights REAL DEFAULT 0, avg_spend REAL DEFAULT 0, has_pets INTEGER DEFAULT 0, pet_details TEXT, preferred_channel TEXT, tags TEXT, notes TEXT, first_seen TEXT, last_seen TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Guest-reservation link for multi-platform tracking
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guest_stays (id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id INTEGER NOT NULL, property_id INTEGER, confirmation_code TEXT, platform TEXT, channel TEXT, check_in TEXT, check_out TEXT, nights INTEGER, guests INTEGER, revenue REAL, payout REAL, has_pets INTEGER DEFAULT 0, pet_type TEXT, pet_fee REAL DEFAULT 0, rating_left REAL, review_text TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Market intelligence — aggregated benchmarks from your actual portfolio
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_intelligence (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, state TEXT NOT NULL, property_type TEXT DEFAULT 'all', bedrooms INTEGER, metric_key TEXT NOT NULL, metric_value REAL, sample_size INTEGER DEFAULT 0, period TEXT, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(city, state, property_type, bedrooms, metric_key, period))`).run();
    // Channel intelligence — performance by booking channel
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS channel_intelligence (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER, channel TEXT NOT NULL, period TEXT NOT NULL, reservations INTEGER DEFAULT 0, total_revenue REAL DEFAULT 0, total_payout REAL DEFAULT 0, avg_adr REAL DEFAULT 0, avg_nights REAL DEFAULT 0, avg_lead_days REAL DEFAULT 0, cancellations INTEGER DEFAULT 0, cancel_rate REAL DEFAULT 0, pet_bookings INTEGER DEFAULT 0, avg_guest_count REAL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(property_id, channel, period))`).run();
    // Market watchlist — automated monitoring tiers
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS market_watchlist (id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, state TEXT NOT NULL, tier INTEGER DEFAULT 1, frequency TEXT DEFAULT 'weekly', radius_miles INTEGER DEFAULT 25, notes TEXT, listing_count INTEGER DEFAULT 0, avg_price REAL DEFAULT 0, price_trend REAL DEFAULT 0, new_listings_30d INTEGER DEFAULT 0, occupancy_est REAL DEFAULT 0, last_crawl TEXT, next_crawl TEXT, auto_created INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), UNIQUE(city, state))`).run();
    // Webhook log — track incoming webhooks
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_log (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, event_type TEXT, payload_summary TEXT, status TEXT DEFAULT 'received', error TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Sync schedule — track cron and manual sync runs
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, sync_type TEXT NOT NULL, source TEXT NOT NULL, status TEXT DEFAULT 'started', records_processed INTEGER DEFAULT 0, error TEXT, started_at TEXT DEFAULT (datetime('now')), completed_at TEXT)`).run();
    // Cloudflare usage tracking
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cf_usage (date TEXT PRIMARY KEY, requests INTEGER DEFAULT 0, api_requests INTEGER DEFAULT 0, d1_reads INTEGER DEFAULT 0, d1_writes INTEGER DEFAULT 0)`).run();
    // Create settings table
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run();
    // Migrate market_snapshots: add rental_type, bedrooms, property_type if missing
    try {
      const msCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('market_snapshots')`).all();
      const msExisting = new Set((msCols.results || []).map(r => r.name));
      if (!msExisting.has('rental_type')) await env.DB.prepare(`ALTER TABLE market_snapshots ADD COLUMN rental_type TEXT DEFAULT 'str'`).run();
      if (!msExisting.has('bedrooms')) await env.DB.prepare(`ALTER TABLE market_snapshots ADD COLUMN bedrooms INTEGER`).run();
      if (!msExisting.has('property_type')) await env.DB.prepare(`ALTER TABLE market_snapshots ADD COLUMN property_type TEXT`).run();
    } catch {}
    // Migrate comparables: add comp_type if missing
    try {
      const compCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('comparables')`).all();
      const compExisting = new Set((compCols.results || []).map(r => r.name));
      if (!compExisting.has('comp_type')) {
        await env.DB.prepare(`ALTER TABLE comparables ADD COLUMN comp_type TEXT DEFAULT 'ltr'`).run();
        // Tag RentCast comps as ltr, everything else as str
        await env.DB.prepare(`UPDATE comparables SET comp_type = 'ltr' WHERE source = 'RentCast' OR source LIKE '%Estimated%'`).run();
        await env.DB.prepare(`UPDATE comparables SET comp_type = 'str' WHERE source != 'RentCast' AND source NOT LIKE '%Estimated%' AND comp_type = 'ltr'`).run();
      }
      // Fix any wrongly tagged RentCast comps from previous buggy migration
      await env.DB.prepare(`UPDATE comparables SET comp_type = 'ltr' WHERE source = 'RentCast' AND comp_type = 'str'`).run();
    } catch {}
    // Migrate guesty_listings: add listing_address if missing
    try {
      const glCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('guesty_listings')`).all();
      const glExisting = new Set((glCols.results || []).map(r => r.name));
      if (!glExisting.has('listing_address')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_address TEXT`).run();
      if (!glExisting.has('listing_city')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_city TEXT`).run();
      if (!glExisting.has('listing_state')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_state TEXT`).run();
      if (!glExisting.has('listing_zip')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_zip TEXT`).run();
      if (!glExisting.has('listing_property_type')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_property_type TEXT`).run();
      if (!glExisting.has('listing_bedrooms')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_bedrooms INTEGER`).run();
      if (!glExisting.has('listing_bathrooms')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_bathrooms INTEGER`).run();
      if (!glExisting.has('listing_accommodates')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_accommodates INTEGER`).run();
      if (!glExisting.has('listing_thumbnail')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_thumbnail TEXT`).run();
      if (!glExisting.has('listing_pictures_json')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_pictures_json TEXT`).run();
      if (!glExisting.has('listing_description')) await env.DB.prepare(`ALTER TABLE guesty_listings ADD COLUMN listing_description TEXT`).run();
    } catch {}
    // Migrate guesty_reservations: add API-sourced columns
    try {
      const grCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('guesty_reservations')`).all();
      const grExisting = new Set((grCols.results || []).map(r => r.name));
      if (!grExisting.has('booking_date')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN booking_date TEXT`).run();
      if (!grExisting.has('guesty_id')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN guesty_id TEXT`).run();
      if (!grExisting.has('subtotal')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN subtotal REAL`).run();
      if (!grExisting.has('last_synced_at')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN last_synced_at TEXT`).run();
      if (!grExisting.has('has_pets')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN has_pets INTEGER DEFAULT 0`).run();
      if (!grExisting.has('pet_type')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN pet_type TEXT`).run();
      if (!grExisting.has('pet_fee')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN pet_fee REAL DEFAULT 0`).run();
      if (!grExisting.has('guest_id')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN guest_id INTEGER`).run();
      if (!grExisting.has('notes')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN notes TEXT`).run();
      if (!grExisting.has('demand_segment')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN demand_segment TEXT`).run();
      // Refund tracking columns (from CSV: TOTAL REFUNDED, CANCELLATION FEE, CANCELED ACCOMMODATION/CLEANING/PAYOUT)
      if (!grExisting.has('total_refunded')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN total_refunded REAL DEFAULT 0`).run();
      if (!grExisting.has('cancellation_fee')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN cancellation_fee REAL DEFAULT 0`).run();
      if (!grExisting.has('canceled_accommodation')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN canceled_accommodation REAL DEFAULT 0`).run();
      if (!grExisting.has('canceled_cleaning')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN canceled_cleaning REAL DEFAULT 0`).run();
      if (!grExisting.has('canceled_payout')) await env.DB.prepare(`ALTER TABLE guesty_reservations ADD COLUMN canceled_payout REAL DEFAULT 0`).run();
    } catch {}
    // Migrate guesty_guests: add expanded fields
    try {
      const ggCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('guesty_guests')`).all();
      const ggExisting = new Set((ggCols.results || []).map(r => r.name));
      if (!ggExisting.has('country')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN country TEXT`).run();
      if (!ggExisting.has('language')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN language TEXT`).run();
      if (!ggExisting.has('avg_stay_nights')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN avg_stay_nights REAL DEFAULT 0`).run();
      if (!ggExisting.has('avg_spend')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN avg_spend REAL DEFAULT 0`).run();
      if (!ggExisting.has('has_pets')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN has_pets INTEGER DEFAULT 0`).run();
      if (!ggExisting.has('pet_details')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN pet_details TEXT`).run();
      if (!ggExisting.has('preferred_channel')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN preferred_channel TEXT`).run();
      if (!ggExisting.has('tags')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN tags TEXT`).run();
      if (!ggExisting.has('notes')) await env.DB.prepare(`ALTER TABLE guesty_guests ADD COLUMN notes TEXT`).run();
    } catch {}
    // Migrate guest_stays: add pet_fee column
    try {
      const gsCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('guest_stays')`).all();
      const gsExisting = new Set((gsCols.results || []).map(r => r.name));
      if (!gsExisting.has('pet_fee')) await env.DB.prepare(`ALTER TABLE guest_stays ADD COLUMN pet_fee REAL DEFAULT 0`).run();
    } catch {}
    // Migrate guesty_calendar: add price comparison columns
    try {
      const gcCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('guesty_calendar')`).all();
      const gcExisting = new Set((gcCols.results || []).map(r => r.name));
      if (!gcExisting.has('pl_recommended_price')) await env.DB.prepare(`ALTER TABLE guesty_calendar ADD COLUMN pl_recommended_price REAL`).run();
      if (!gcExisting.has('price_discrepancy')) await env.DB.prepare(`ALTER TABLE guesty_calendar ADD COLUMN price_discrepancy REAL`).run();
    } catch {}
    // Migrate market_watchlist: add radius_miles column
    try {
      const mwCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('market_watchlist')`).all();
      const mwExisting = new Set((mwCols.results || []).map(r => r.name));
      if (!mwExisting.has('radius_miles')) await env.DB.prepare(`ALTER TABLE market_watchlist ADD COLUMN radius_miles INTEGER DEFAULT 25`).run();
    } catch {}
    // Migrate pricing_strategies: add rental_type column and backfill from min_nights
    try {
      const psCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('pricing_strategies')`).all();
      const psExisting = new Set((psCols.results || []).map(r => r.name));
      if (!psExisting.has('rental_type')) {
        await env.DB.prepare(`ALTER TABLE pricing_strategies ADD COLUMN rental_type TEXT DEFAULT 'str'`).run();
        // Backfill: anything with min_nights >= 365 or LTR in strategy_name is LTR
        await env.DB.prepare(`UPDATE pricing_strategies SET rental_type = 'ltr' WHERE min_nights >= 365 OR strategy_name LIKE 'LTR%'`).run();
        await env.DB.prepare(`UPDATE pricing_strategies SET rental_type = 'str' WHERE rental_type IS NULL OR rental_type = '' OR (min_nights < 365 AND strategy_name NOT LIKE 'LTR%')`).run();
      }
    } catch {}
    // Migrate properties: add rental_type column (str/ltr)
    try {
      const propCols2 = await env.DB.prepare(`SELECT name FROM pragma_table_info('properties')`).all();
      const propExisting2 = new Set((propCols2.results || []).map(r => r.name));
      if (!propExisting2.has('rental_type')) {
        await env.DB.prepare(`ALTER TABLE properties ADD COLUMN rental_type TEXT DEFAULT 'str'`).run();
      }
    } catch {}
    // Migrate monthly_actuals: add tax/commission columns
    try {
      const maCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('monthly_actuals')`).all();
      const maExisting = new Set((maCols.results || []).map(r => r.name));
      if (!maExisting.has('total_taxes')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN total_taxes REAL DEFAULT 0`).run();
      if (!maExisting.has('platform_commission')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN platform_commission REAL DEFAULT 0`).run();
      if (!maExisting.has('total_refunded')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN total_refunded REAL DEFAULT 0`).run();
      if (!maExisting.has('cancellation_fees')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN cancellation_fees REAL DEFAULT 0`).run();
      // Add listing_name to property_platforms (the name shown on Airbnb/VRBO/etc from Guesty)
      const ppCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('property_platforms')`).all();
      const ppExisting = new Set((ppCols.results || []).map(c => c.name));
      if (!ppExisting.has('listing_name')) await env.DB.prepare(`ALTER TABLE property_platforms ADD COLUMN listing_name TEXT`).run();
      // Add platform_listing_name to properties table (shared name for all platforms)
      const propCols2 = await env.DB.prepare(`SELECT name FROM pragma_table_info('properties')`).all();
      const propExisting2 = new Set((propCols2.results || []).map(c => c.name));
      if (!propExisting2.has('platform_listing_name')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN platform_listing_name TEXT`).run();
      if (!propExisting2.has('algo_template_id')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN algo_template_id INTEGER`).run();
      if (!propExisting2.has('owner_name')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN owner_name TEXT`).run();
      if (!propExisting2.has('management_fee_pct')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN management_fee_pct REAL`).run();
      if (!propExisting2.has('fee_basis')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN fee_basis TEXT DEFAULT 'gross'`).run();
      if (!propExisting2.has('is_managed')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN is_managed INTEGER DEFAULT 0`).run();
      if (!propExisting2.has('management_base_fee')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN management_base_fee REAL DEFAULT 0`).run();
      if (!propExisting2.has('pl_customizations_json')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN pl_customizations_json TEXT`).run();
      if (!propExisting2.has('rental_restrictions')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN rental_restrictions TEXT`).run();
      if (!propExisting2.has('hoa_name')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN hoa_name TEXT`).run();
      if (!propExisting2.has('ai_notes')) await env.DB.prepare(`ALTER TABLE properties ADD COLUMN ai_notes TEXT`).run();
      if (!maExisting.has('taxes_you_owe')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN taxes_you_owe REAL DEFAULT 0`).run();
      if (!maExisting.has('elapsed_booked_nights')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN elapsed_booked_nights INTEGER`).run();
      if (!maExisting.has('elapsed_days')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN elapsed_days INTEGER`).run();
    } catch {}
    // Create intelligence tables if missing
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS master_listings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, platform TEXT NOT NULL, listing_type TEXT DEFAULT 'str', platform_id TEXT, listing_url TEXT, title TEXT, description TEXT, host_name TEXT, city TEXT, state TEXT, zip TEXT, address TEXT, latitude REAL, longitude REAL, bedrooms INTEGER, bathrooms REAL, sleeps INTEGER, sqft INTEGER, property_type TEXT, nightly_rate REAL, weekly_rate REAL, monthly_rate REAL, cleaning_fee REAL DEFAULT 0, service_fee REAL DEFAULT 0, rating REAL, review_count INTEGER DEFAULT 0, superhost INTEGER DEFAULT 0, amenities_json TEXT, photos_json TEXT, first_seen TEXT DEFAULT (datetime('now')), last_updated TEXT DEFAULT (datetime('now')), last_scraped TEXT, scrape_count INTEGER DEFAULT 1, status TEXT DEFAULT 'active', raw_data TEXT)`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS data_uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, upload_type TEXT NOT NULL, filename TEXT, r2_key TEXT, mime_type TEXT, size_bytes INTEGER, status TEXT DEFAULT 'pending', listings_extracted INTEGER DEFAULT 0, ai_summary TEXT, error_message TEXT, uploaded_at TEXT DEFAULT (datetime('now')), processed_at TEXT)`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS crawl_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, job_type TEXT NOT NULL, status TEXT DEFAULT 'pending', target_url TEXT, target_city TEXT, target_state TEXT, target_platform TEXT, listings_found INTEGER DEFAULT 0, listings_updated INTEGER DEFAULT 0, listings_new INTEGER DEFAULT 0, started_at TEXT, completed_at TEXT, error_message TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ml_city_state ON master_listings(city, state)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ml_platform ON master_listings(platform, platform_id)`).run();
    } catch {}
    // Add user_id to all data tables (multi-tenant)
    try {
      const addUserCol = async (table) => {
        const tcols = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all();
        if (!(tcols.results || []).some(r => r.name === 'user_id')) {
          await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN user_id INTEGER`).run();
        }
      };
      await addUserCol('properties');
      await addUserCol('comparables');
      await addUserCol('master_listings');
      await addUserCol('data_uploads');
      await addUserCol('crawl_jobs');
      await addUserCol('pricing_strategies');
    } catch {}
    // Create property_platforms table
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS property_platforms (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, property_id INTEGER NOT NULL, platform TEXT NOT NULL, listing_url TEXT, platform_id TEXT, is_active INTEGER DEFAULT 1, nightly_rate REAL, weekly_rate REAL, monthly_rate REAL, cleaning_fee REAL DEFAULT 0, service_fee REAL DEFAULT 0, platform_fee_pct REAL DEFAULT 0, guest_fee_pct REAL DEFAULT 0, occupancy_tax_pct REAL DEFAULT 0, min_nights INTEGER, weekly_discount_pct REAL DEFAULT 0, monthly_discount_pct REAL DEFAULT 0, last_minute_discount_pct REAL DEFAULT 0, early_bird_discount_pct REAL DEFAULT 0, cancellation_policy TEXT, instant_book INTEGER DEFAULT 0, rating REAL, review_count INTEGER DEFAULT 0, last_scraped TEXT, raw_data TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_pp_property ON property_platforms(property_id)`).run();
    } catch {}
    // Create PriceLabs tables
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pricelabs_listings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, property_id INTEGER, pl_listing_id TEXT NOT NULL, pl_listing_name TEXT, pl_platform TEXT, pl_pms TEXT, base_price REAL, min_price REAL, max_price REAL, recommended_base_price REAL, cleaning_fees REAL, currency TEXT DEFAULT 'USD', bedrooms INTEGER, latitude REAL, longitude REAL, city_name TEXT, state TEXT, country TEXT, group_name TEXT, tags TEXT, push_enabled INTEGER, last_date_pushed TEXT, occupancy_next_7 TEXT, market_occupancy_next_7 TEXT, occupancy_next_30 TEXT, market_occupancy_next_30 TEXT, occupancy_next_60 TEXT, market_occupancy_next_60 TEXT, channel_details TEXT, last_synced TEXT, last_refreshed_at TEXT, created_at TEXT DEFAULT (datetime('now')), UNIQUE(pl_listing_id))`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS pricelabs_rates (id INTEGER PRIMARY KEY AUTOINCREMENT, pl_listing_id TEXT NOT NULL, rate_date TEXT NOT NULL, price REAL NOT NULL, min_stay INTEGER DEFAULT 1, is_available INTEGER DEFAULT 1, fetched_at TEXT DEFAULT (datetime('now')), UNIQUE(pl_listing_id, rate_date))`).run();
      // Price history — snapshots base_price on each PriceLabs sync for trend tracking
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, base_price REAL, rec_price REAL, min_price REAL, max_price REAL, occ_30d TEXT, mkt_occ_30d TEXT, snapshot_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(property_id, snapshot_date))`).run();
      // Migrate pricelabs_listings: add new columns if missing
      try {
        const plCols = await env.DB.prepare(`SELECT name FROM pragma_table_info('pricelabs_listings')`).all();
        const plExisting = new Set((plCols.results || []).map(r => r.name));
        const plNeeded = [['max_price','REAL'],['recommended_base_price','REAL'],['cleaning_fees','REAL'],['latitude','REAL'],['longitude','REAL'],['city_name','TEXT'],['state','TEXT'],['country','TEXT'],['group_name','TEXT'],['tags','TEXT'],['push_enabled','INTEGER'],['last_date_pushed','TEXT'],['occupancy_next_7','TEXT'],['market_occupancy_next_7','TEXT'],['occupancy_next_30','TEXT'],['market_occupancy_next_30','TEXT'],['occupancy_next_60','TEXT'],['market_occupancy_next_60','TEXT'],['channel_details','TEXT'],['last_refreshed_at','TEXT']];
        for (const [col, type] of plNeeded) {
          if (!plExisting.has(col)) {
            await env.DB.prepare(`ALTER TABLE pricelabs_listings ADD COLUMN ${col} ${type}`).run();
          }
        }
      } catch {}
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_plr_listing ON pricelabs_rates(pl_listing_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_plr_date ON pricelabs_rates(rate_date)`).run();
      // Performance indexes for hot query paths
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ma_property_month ON monthly_actuals(property_id, month)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ar_property_type ON analysis_reports(property_id, report_type)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mw_city_state ON market_watchlist(city, state)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_plr_listing_date ON pricelabs_rates(pl_listing_id, rate_date)`).run();
    } catch {}
    // Algo overrides table
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS property_algo_overrides (id INTEGER PRIMARY KEY, property_id INTEGER NOT NULL UNIQUE, min_nights INTEGER, weekend_pct REAL, lastmin_pct REAL, gap_pct REAL, earlybird_pct REAL, monthly_pct REAL, notes TEXT, updated_at TEXT DEFAULT (datetime('now')))`).run();
    } catch {}
    // Algo templates — reusable pricing profiles
    try {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS algo_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT, occupancy_target REAL DEFAULT 65, pricing_bias TEXT DEFAULT 'balanced', min_nightly_rate REAL, max_nightly_rate REAL, min_nights INTEGER, weekend_pct REAL, lastmin_pct REAL, gap_pct REAL, earlybird_pct REAL, monthly_pct REAL, seasonal_profile TEXT DEFAULT 'standard', peak_months TEXT, low_months TEXT, peak_markup_pct REAL DEFAULT 20, low_discount_pct REAL DEFAULT 15, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))`).run();
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS marketing_content (id INTEGER PRIMARY KEY AUTOINCREMENT, section TEXT NOT NULL, content_key TEXT NOT NULL, content_value TEXT, sort_order INTEGER DEFAULT 0, is_active INTEGER DEFAULT 1, is_locked INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')), UNIQUE(section, content_key))`).run();
      try { await env.DB.prepare(`ALTER TABLE marketing_content ADD COLUMN is_locked INTEGER DEFAULT 0`).run(); } catch {}
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS system_log (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL DEFAULT 'error', source TEXT NOT NULL, message TEXT, detail TEXT, property_id INTEGER, created_at TEXT DEFAULT (datetime('now')))`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_syslog_created ON system_log(created_at)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_syslog_level ON system_log(level, created_at)`).run();
    } catch {}
    // ── Performance indexes on high-traffic tables ──
    try {
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gr_property ON guesty_reservations(property_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gr_status ON guesty_reservations(status)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gr_listing ON guesty_reservations(listing_name)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gr_checkin ON guesty_reservations(check_in)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gr_guest_id ON guesty_reservations(guest_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gs_guest ON guest_stays(guest_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gs_property ON guest_stays(property_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_gs_confirm ON guest_stays(confirmation_code)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ma_property ON monthly_actuals(property_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_prop_user ON properties(user_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_prop_parent ON properties(parent_id)`).run();
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_ci_property ON channel_intelligence(property_id)`).run();
    } catch {}
    // Seed expanded amenity catalog (INSERT OR IGNORE — safe to run every startup)
    try {
      const amenityRows = [
        // Outdoor additions
        ['Private Beach / Beachfront','outdoor',30.0],['Rooftop Deck / Terrace','outdoor',10.0],
        ['Infinity Pool','outdoor',20.0],['Plunge Pool / Splash Pool','outdoor',8.0],
        ['Pool Heating (year-round)','outdoor',5.0],['Outdoor Fireplace','outdoor',5.0],
        ['Pergola / Gazebo','outdoor',3.0],['Hammock / Swing','outdoor',2.0],
        ['Bocce Ball / Cornhole','outdoor',2.0],['Basketball Hoop','outdoor',2.0],
        ['Ping Pong Table','outdoor',3.0],['Horseshoes','outdoor',1.0],
        ['Playground / Swing Set','outdoor',4.0],['Outdoor Movie Screen','outdoor',5.0],
        ['BBQ Smoker','outdoor',3.0],['Pizza Oven','outdoor',4.0],
        ['Boat / Kayak / Paddleboard','outdoor',10.0],['Fishing Gear Provided','outdoor',4.0],
        ['Golf Cart Included','outdoor',6.0],['Mountain / Ski Access','outdoor',20.0],
        ['Ski-in / Ski-out','outdoor',25.0],['Snowshoes / Sleds','outdoor',3.0],
        ['Bikes Provided','outdoor',4.0],['Tennis Court','outdoor',8.0],['Pickleball Court','outdoor',6.0],
        // Kitchen additions
        ['Wine / Beverage Fridge','kitchen',3.0],['Keurig / Pod Coffee Maker','kitchen',1.5],
        ['Outdoor Fridge / Bar','kitchen',2.0],['Wet Bar','kitchen',4.0],
        ['Instant Pot / Air Fryer','kitchen',1.0],['Blender / Juicer','kitchen',1.0],
        // Entertainment additions
        ['Theater Room / Projector','entertainment',8.0],['Video Game Console','entertainment',3.0],
        ['Karaoke Machine','entertainment',4.0],['Foosball Table','entertainment',3.0],
        ['Shuffleboard Table','entertainment',4.0],['Hot Tub (indoor)','entertainment',13.0],
        ['Putting Green','entertainment',5.0],['Poker / Card Table','entertainment',3.0],
        ['Children Play Area (indoor)','entertainment',4.0],['Library / Reading Room','entertainment',2.0],
        ['Yoga Room / Meditation Space','entertainment',3.0],['Exercise / Fitness Room','entertainment',6.0],
        // Comfort additions
        ['Blackout Curtains','comfort',1.5],['Smart Home / Voice Control','comfort',2.0],
        ['Heated Floors','comfort',3.0],['Soaking / Jetted Tub','comfort',5.0],
        ['Steam Shower','comfort',4.0],['Walk-in Closet','comfort',1.5],
        ['Baby / Toddler Gear (crib, highchair)','comfort',4.0],['Pack-n-Play / Portable Crib','comfort',2.0],
        ['Rollaway / Extra Beds','comfort',1.5],['Bunk Beds','comfort',3.0],
        ['Murphy / Pull-down Bed','comfort',2.0],['Air Purifier / HEPA Filter','comfort',1.5],
        ['Ceiling Fans','comfort',1.0],['Mini Split A/C','comfort',2.0],['Central Heat','comfort',1.5],
        // Safety additions
        ['Ring / Smart Doorbell','safety',1.5],['Smart Lock / Keyless Entry','safety',1.5],
        ['First Aid Kit','safety',0.5],['Pool Fence / Safety Gate','safety',2.0],
        ['Carbon Monoxide Detector','safety',0.5],
        // Workspace additions
        ['Standing Desk','workspace',2.0],['Dual Monitors / External Display','workspace',2.5],
        ['Printer / Scanner','workspace',1.5],['Meeting Room / Conference Setup','workspace',4.0],
        ['Fiber Internet (500Mbps+)','workspace',4.0],
        // Location category (new)
        ['Walkable to Restaurants / Shops','location',5.0],['Near Public Transit','location',3.0],
        ['Private / Secluded Setting','location',6.0],['Downtown / City Center','location',4.0],
        ['Golf Course Community','location',5.0],['Marina / Waterfront Community','location',8.0],
        ['Horse Property / Ranch','location',6.0],
        // Unique additions
        ['Solar / Green Energy','unique',2.0],['Hot Springs / Natural Pool','unique',15.0],
        ['Treehouse','unique',20.0],['Tiny Home / Container Home','unique',10.0],
        ['A-Frame / Cabin','unique',8.0],['Farm Stay / Working Farm','unique',10.0],
        ['Vineyard / Winery Access','unique',12.0],['Artist Studio','unique',4.0],
        ['Recording Studio','unique',8.0],['Wheelchair Accessible','unique',5.0],
        ['Private Entrance / Separate Unit','unique',4.0],
        ['Concierge / Property Management On-site','unique',5.0],
        ['Long-Term Stay Friendly (28+ nights)','unique',3.0],
        ['Self Check-in / Smart Lock','unique',2.0],['Luggage Storage Available','unique',1.0],
        // Parking (new category)
        ['Driveway Parking (2+ cars)','parking',3.0],['Garage (1-car)','parking',4.0],
        ['Garage (2+ cars)','parking',6.0],['RV / Boat Parking','parking',4.0],
        ['Street Parking (free)','parking',1.5],['EV Charging Station','parking',4.0],
      ];
      const amenStmt = env.DB.prepare(`INSERT OR IGNORE INTO amenities (name, category, impact_score) VALUES (?, ?, ?)`);
      await env.DB.batch(amenityRows.map(([n, c, s]) => amenStmt.bind(n, c, s)));
    } catch (e) { console.error('Amenity seed:', e); }
  } catch (e) { console.error('Migration check:', e); }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    try {
      // Auto-migrate DB schema on first request
      await ensureSchema(env);

      // Track Cloudflare Workers request (lightweight - just increment counter in DB)
      try {
        const today = new Date().toISOString().split('T')[0];
        const isApi = path.startsWith('/api/');
        await env.DB.prepare(`INSERT INTO cf_usage (date, requests, api_requests, d1_reads, d1_writes) VALUES (?, 1, ?, 0, 0) ON CONFLICT(date) DO UPDATE SET requests = requests + 1, api_requests = api_requests + ?`)
          .bind(today, isApi ? 1 : 0, isApi ? 1 : 0).run();
      } catch { /* table might not exist yet */ }

      // Hydrate API keys: DB is the source of truth.
      // - If key exists in DB → use DB value (overrides wrangler secret)
      // - If key deleted from DB (row gone) → null it out (overrides wrangler secret)  
      // - If key never added to DB at all → keep wrangler secret as fallback
      // We distinguish "deleted" from "never set" by checking if the row existed before deletion.
      // Since we can't know that, we use a simpler rule: if app_settings table exists and is readable,
      // DB wins for all managed keys (set or null). This means: use Admin UI, not wrangler secrets.
      try {
        const { results: dbKeys } = await env.DB.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'apikey_%'`).all();
        const dbKeyMap = {};
        for (const row of (dbKeys || [])) { if (row.value) dbKeyMap[row.key] = row.value; }
        for (const k of MANAGED_KEYS) {
          const dbVal = dbKeyMap['apikey_' + k];
          if (dbVal) {
            // eslint-disable-next-line no-param-reassign
            env[k] = dbVal; // DB key wins over wrangler secret
          } else if (env[k]) {
            // Wrangler secret exists but not yet in DB — migrate it to DB automatically so Admin UI can manage it
            try {
              await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind('apikey_' + k, env[k], env[k]).run();
            } catch {}
            // env[k] stays as-is (already set from wrangler)
          } else {
            // eslint-disable-next-line no-param-reassign
            env[k] = null; // Not in DB and no secret = gone
          }
        }
      } catch { /* app_settings not yet created — leave wrangler env as-is */ }

      // Serve frontend for any non-API path
      if (path === '/manifest.json') return json({
        name: 'FCP Property Market Research',
        short_name: 'FCP PMR',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f1117',
        theme_color: '#0f1117',
        icons: [
          { src: '/api/icon/192', sizes: '192x192', type: 'image/png' },
          { src: '/api/icon/512', sizes: '512x512', type: 'image/png' }
        ]
      });
      if (path.startsWith('/api/icon/')) return generatePWAIcon(path.split('/').pop());
      if (!path.startsWith('/api/')) return html(FRONTEND_HTML);

      // Public auth routes
      if (path === '/api/auth/login' && method === 'POST') return await login(request, env);
      if (path === '/api/auth/register' && method === 'POST') return await register(request, env);
      if (path === '/api/auth/init' && method === 'GET') return await checkInit(env);
      if (path === '/api/auth/init' && method === 'POST') return await initAdmin(request, env);
      // Public image routes (no auth needed for viewing)
      if (path.match(/^\/api\/images\/\d+$/) && method === 'GET') return await getImage(path.split('/').pop(), env);
      if (path.match(/^\/api\/images\/r2\//) && method === 'GET') return await getR2Image(path.replace('/api/images/r2/', ''), env);
      // Public share view (no auth required)
      if (path.match(/^\/api\/share\/[a-zA-Z0-9]{5}$/) && method === 'GET') return await getSharedProperty(path.split('/')[3], env);
      // Public share view — always show code entry page (code not in URL)
      if (path === '/share' || path === '/share/' || path.match(/^\/share\/[a-zA-Z0-9]{5}$/)) return html(FRONTEND_HTML); // serve SPA, frontend handles routing

      // ─── Guesty Webhook Receiver (no auth — validated by secret) ───
      if (path === '/api/webhooks/guesty' && method === 'POST') return await handleGuestyWebhook(request, env);

      const user = await authenticate(request, env);

      // Auth management
      if (path === '/api/auth/me' && method === 'GET') {
        if (!user) return json({ error: 'Not authenticated' }, 401);
        return json({ user: { id: user.user_id, email: user.email, display_name: user.display_name, role: user.role, must_change_password: user.must_change_password } });
      }
      if (path === '/api/auth/change-password' && method === 'POST') {
        if (!user) return json({ error: 'Not authenticated' }, 401);
        return await changePassword(user, request, env);
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        if (user) { const token = request.headers.get('Authorization').substring(7); await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(token).run(); }
        return json({ ok: true });
      }

      // Force password change wall
      if (user && user.must_change_password) return json({ error: 'Password change required', code: 'MUST_CHANGE_PASSWORD' }, 403);

      // Admin routes
      if (path === '/api/admin/users' && method === 'GET') { const e = requireAdmin(user); if (e) return e; return await listUsers(env); }
      if (path.match(/^\/api\/admin\/users\/\d+\/approve$/) && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await approveUser(path.split('/')[4], user, env); }
      if (path.match(/^\/api\/admin\/users\/\d+\/reject$/) && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await rejectUser(path.split('/')[4], env); }
      if (path.match(/^\/api\/admin\/users\/\d+\/role$/) && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await setUserRole(path.split('/')[4], request, env); }
      if (path.match(/^\/api\/admin\/users\/\d+\/reset-password$/) && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await resetUserPassword(path.split('/')[4], env); }
      if (path.match(/^\/api\/admin\/users\/\d+$/) && method === 'DELETE') { const e = requireAdmin(user); if (e) return e; return await deleteUser(path.split('/')[4], user, env); }
      if (path === '/api/admin/dns/setup' && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await setupDNS(request, env); }
      if (path === '/api/admin/dns/status' && method === 'GET') { const e = requireAdmin(user); if (e) return e; return await checkDNSStatus(env); }

      // Protected app routes
      const authErr = requireAuth(user); if (authErr) return authErr;
      const uid = getEffectiveUserId(user, url.searchParams);
      if (path === '/api/properties' && method === 'GET') return await getProperties(env, uid);
      if (path === '/api/dashboard' && method === 'GET') return await getDashboard(env, uid);
      if (path === '/api/properties' && method === 'POST') return await createProperty(request, env, uid);
      if (path === '/api/properties/import-csv' && method === 'POST') return await importCSV(request, env, uid);
      if (path === '/api/properties/bulk-delete' && method === 'POST') return await bulkDeleteProperties(request, env, uid);
      if (path === '/api/properties/bulk-edit' && method === 'POST') return await bulkEditProperties(request, env, uid);
      if (path === '/api/properties/lookup' && method === 'POST') return await lookupProperty(request, env);
      if (path === '/api/images/upload' && method === 'POST') return await uploadImage(request, env);
      if (path === '/api/places/autocomplete' && method === 'GET') return await placesAutocomplete(url.searchParams.get('q'), env);
      if (path === '/api/places/details' && method === 'GET') return await placesDetails(url.searchParams.get('place_id'), env);
      if (path.match(/^\/api\/properties\/\d+\/add-unit$/) && method === 'POST') return await addUnit(path.split('/')[3], request, env, uid);
      if (path.match(/^\/api\/properties\/\d+\/add-units-batch$/) && method === 'POST') return await addUnitsBatch(path.split('/')[3], request, env, uid);
      if (path.match(/^\/api\/properties\/\d+\/push-to-units$/) && method === 'POST') return await pushBuildingToUnits(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+$/) && method === 'GET') return await getProperty(path.split('/').pop(), env, uid);
      if (path.match(/^\/api\/properties\/\d+$/) && (method === 'PUT' || method === 'PATCH')) return await updateProperty(path.split('/').pop(), request, env, uid);
      if (path.match(/^\/api\/properties\/\d+$/) && method === 'DELETE') return await deleteProperty(path.split('/').pop(), env, uid);
      if (path.match(/^\/api\/properties\/\d+\/amenities$/) && method === 'GET') return await getPropertyAmenities(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/amenities$/) && method === 'POST') return await setPropertyAmenities(path.split('/')[3], request, env);
      if (path.match(/^\/api\/properties\/\d+\/images$/) && method === 'GET') return await getPropertyImages(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/images$/) && method === 'POST') return await addPropertyImage(path.split('/')[3], request, env);
      if (path.match(/^\/api\/properties\/\d+\/images\/\d+$/) && method === 'DELETE') return await deletePropertyImage(path.split('/')[5], env);
      if (path.match(/^\/api\/properties\/\d+\/images\/reorder$/) && method === 'POST') return await reorderPropertyImages(path.split('/')[3], request, env);
      if (path === '/api/amenities' && method === 'GET') return await getAmenities(env);
      if (path.match(/^\/api\/properties\/\d+\/comparables$/) && method === 'GET') return await getComparables(path.split('/')[3], env, uid);
      if (path === '/api/comparables' && method === 'POST') return await addComparable(request, env, uid);
      if (path === '/api/comparables/parse-url' && method === 'POST') return await parseListingUrl(request, env);
      if (path === '/api/market' && method === 'GET') return await getMarketData(url.searchParams, env);
      if (path === '/api/market' && method === 'POST') return await addMarketSnapshot(request, env);
      if (path === '/api/market/fetch' && method === 'POST') return await fetchMarketData(request, env);
      if (path === '/api/market/search' && method === 'POST') return await marketSearch(request, env);
      if (path === '/api/comparables/fetch' && method === 'POST') return await fetchComparables(request, env, uid);
      // ── Intel / Data Dump routes ──
      if (path === '/api/intel/listings' && method === 'GET') return await getMasterListings(url.searchParams, env, uid);
      if (path === '/api/intel/listings/stats' && method === 'GET') return await getMasterListingsStats(env, uid);
      if (path === '/api/intel/upload' && method === 'POST') return await intelUpload(request, env, uid);
      if (path === '/api/intel/uploads' && method === 'GET') return await getDataUploads(env, uid);
      if (path === '/api/intel/import-urls' && method === 'POST') return await importUrlList(request, env, uid);
      if (path === '/api/intel/crawl' && method === 'POST') return await triggerCrawl(request, env, uid);
      if (path === '/api/intel/crawl-jobs' && method === 'GET') return await getCrawlJobs(env, uid);
      if (path.match(/^\/api\/intel\/crawl-jobs\/\d+$/) && method === 'DELETE') return await deleteCrawlJob(path.split('/').pop(), env, uid);
      // ── Finances ──
      if (path === '/api/finances/summary' && method === 'GET') return await getFinancesSummary(env, uid);
      // ── PriceLabs ──
      if (path === '/api/pricelabs/status' && method === 'GET') return await getPriceLabsStatus(env, uid);
      if (path === '/api/pricelabs/sync' && method === 'POST') return await syncPriceLabsListings(env, uid, url.searchParams.get('preview') === '1');
      if (path === '/api/pricelabs/prices' && method === 'POST') return await fetchPriceLabsPrices(request, env, uid);
      if (path === '/api/pricelabs/prices-all' && method === 'POST') return await fetchAllPriceLabsPrices(env, uid, url.searchParams.get('preview') === '1');
      if (path.match(/^\/api\/pricelabs\/listings\/\d+\/link$/) && method === 'POST') return await linkPriceLabsListing(path.split('/')[4], request, env, uid);
      if (path.match(/^\/api\/pricelabs\/listings\/\d+\/unlink$/) && method === 'POST') return await unlinkPriceLabsListing(path.split('/')[4], env, uid);
      if (path === '/api/pricelabs/calendar' && method === 'GET') return await getPriceLabsCalendar(url.searchParams, env, uid);
      if (path === '/api/pricelabs/summary' && method === 'GET') return await getPriceLabsSummary(url.searchParams, env, uid);
      if (path === '/api/pricelabs/bulk-customizations' && method === 'POST') return await bulkApplyPlCustomizations(request, env, uid);
      if (path === '/api/pricelabs/bulk-customizations-preview' && method === 'POST') return await getPlCustomizationsPreview(request, env, uid);
      // ── Platform Pricing ──
      if (path.match(/^\/api\/properties\/\d+\/platforms$/) && method === 'GET') return await getPropertyPlatforms(path.split('/')[3], env, uid);
      if (path.match(/^\/api\/properties\/\d+\/platforms$/) && method === 'POST') return await addPropertyPlatform(path.split('/')[3], request, env, uid);
      if (path.match(/^\/api\/properties\/\d+\/platforms\/\d+$/) && method === 'PUT') return await updatePropertyPlatform(path.split('/')[5], request, env, uid);
      if (path.match(/^\/api\/properties\/\d+\/platforms\/\d+$/) && method === 'DELETE') return await deletePropertyPlatform(path.split('/')[5], env, uid);
      if (path.match(/^\/api\/properties\/\d+\/platforms\/compare$/) && method === 'POST') return await comparePlatformPricing(path.split('/')[3], request, env, uid);
      if (path.match(/^\/api\/properties\/\d+\/platforms\/scrape$/) && method === 'POST') return await scrapePlatformPricing(path.split('/')[3], env, uid);
      if (path.match(/^\/api\/properties\/\d+\/platforms\/search$/) && method === 'POST') return await searchPlatformListings(path.split('/')[3], env, uid);
      if (path === '/api/admin/users-list' && method === 'GET') { const e = requireAdmin(user); if (e) return e; return await getAdminUsersList(env); }
      if (path === '/api/keys/status' && method === 'GET') return await checkApiKeyStatus(env);
      if (path === '/api/keys/test' && method === 'GET') {
        const reqKey = new URL(request.url).searchParams.get('key') || 'ANTHROPIC_API_KEY';
        const kv = env[reqKey] || null;
        const kp = kv ? (kv.substring(0, 10) + '...' + kv.slice(-4)) : null;
        let ping = null;
        if (kv && reqKey === 'ANTHROPIC_API_KEY') {
          try {
            // Use models list endpoint — no tokens consumed, just auth check
            const pr = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': kv, 'anthropic-version': '2023-06-01' } });
            const pj = await pr.json();
            ping = { status: pr.status, ok: pr.ok, body: pr.ok ? 'Auth OK — models list returned' : (pj?.error?.message || JSON.stringify(pj).substring(0, 200)) };
          } catch (e) { ping = { error: e.message, ok: false }; }
        } else if (kv && reqKey === 'OPENAI_API_KEY') {
          try {
            const pr = await fetch('https://api.openai.com/v1/models', { headers: { 'Authorization': 'Bearer ' + kv } });
            const pj = await pr.json();
            ping = { status: pr.status, ok: pr.ok, body: pr.ok ? 'Auth OK — models list returned' : (pj?.error?.message || JSON.stringify(pj).substring(0, 200)) };
          } catch (e) { ping = { error: e.message, ok: false }; }
        }
        const providerName = reqKey === 'ANTHROPIC_API_KEY' ? 'anthropic' : reqKey === 'OPENAI_API_KEY' ? 'openai' : null;
        const budget = providerName ? await checkBudget(env, providerName) : null;
        return json({ keyInEnv: !!kv, keyPreview: kp, budgetOk: budget, ping });
      }
      if (path === '/api/keys/save' && method === 'POST') return await saveApiKey(request, env);
      if (path === '/api/keys/usage' && method === 'GET') return json({ usage: await getApiUsageSummary(env) });
      if (path === '/api/version' && method === 'GET') return json({ version: APP_VERSION, build_date: BUILD_DATE });
      if (path === '/api/ai/status' && method === 'GET') return await getAiStatus(env);
      if (path === '/api/admin/rentcast-usage' && method === 'GET') return await getRentCastUsage(env);
      // ── Marketing content management (admin-only) ──
      if (path === '/api/admin/marketing' && method === 'GET') { const e = requireAdmin(user); if (e) return e; return await getMarketingContent(env); }
      if (path === '/api/admin/marketing' && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await saveMarketingContent(request, env); }
      if (path === '/api/admin/marketing/seed' && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await seedMarketingContent(env); }
      if (path === '/api/admin/marketing/generate' && method === 'POST') { const e = requireAdmin(user); if (e) return e; return await generateMarketingContent(request, env); }
      if (path === '/api/admin/marketing/landing-page' && method === 'GET') { const e = requireAdmin(user); if (e) return e; return await exportLandingPage(env); }
      if (path === '/api/admin/marketing/lock' && method === 'POST') {
        const e = requireAdmin(user); if (e) return e;
        const { section, content_key, locked } = await request.json();
        if (!section || !content_key) return json({ error: 'section and content_key required' }, 400);
        await env.DB.prepare(`UPDATE marketing_content SET is_locked = ?, updated_at = datetime('now') WHERE section = ? AND content_key = ?`).bind(locked ? 1 : 0, section, content_key).run();
        return json({ ok: true, locked: !!locked });
      }
      if (path === '/api/admin/marketing/stats' && method === 'GET') { const e = requireAdmin(user); if (e) return e; return await getMarketingStats(env); }
      // ── System log viewer (admin-only) ──
      if (path === '/api/admin/system-log' && method === 'GET') {
        const e = requireAdmin(user); if (e) return e;
        const level = url.searchParams.get('level') || null;
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
        const levelFilter = level ? `WHERE level = ?` : '';
        const binds = level ? [level] : [];
        const { results } = await env.DB.prepare(`SELECT * FROM system_log ${levelFilter} ORDER BY id DESC LIMIT ${limit}`).bind(...binds).all();
        const counts = await env.DB.prepare(`SELECT level, COUNT(*) as c FROM system_log GROUP BY level`).all();
        return json({ logs: results || [], counts: (counts.results || []).reduce((o, r) => { o[r.level] = r.c; return o; }, {}), total: (results || []).length });
      }
      if (path === '/api/admin/system-log/clear' && method === 'POST') {
        const e = requireAdmin(user); if (e) return e;
        const body = await request.json().catch(() => ({}));
        if (body.older_than_days) {
          await env.DB.prepare(`DELETE FROM system_log WHERE created_at < datetime('now', '-' || ? || ' days')`).bind(String(body.older_than_days)).run();
        } else {
          await env.DB.prepare(`DELETE FROM system_log`).run();
        }
        return json({ ok: true, message: 'System log cleared' });
      }
      if (path === '/api/admin/rentcast-config' && method === 'POST') return await setRentCastConfig(request, env);
      if (path === '/api/admin/settings' && method === 'POST') {
        const b = await request.json();
        if (!b.key) return json({ error: 'key required' }, 400);
        await env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?`).bind(b.key, b.value, b.value).run();
        return json({ ok: true });
      }
      if (path.match(/^\/api\/admin\/settings\//) && method === 'GET') {
        const key = decodeURIComponent(path.split('/api/admin/settings/')[1]);
        const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind(key).first();
        return json(row || { value: null });
      }
      if (path === '/api/market/deep-dive' && method === 'POST') return await marketDeepDive(request, env);
      if (path.match(/^\/api\/market\/insights\//) && method === 'GET') {
        const parts = path.split('/'); const city = decodeURIComponent(parts[4]); const state = decodeURIComponent(parts[5] || '');
        return await getMarketInsights(city, state, env);
      }
      if (path === '/api/taxes' && method === 'GET') return await getTaxRates(url.searchParams.get('state'), url.searchParams.get('county'), env);
      if (path.match(/^\/api\/properties\/\d+\/analyze$/) && method === 'POST') return await analyzePricing(path.split('/')[3], request, env);
      if (path === '/api/analyze/bulk' && method === 'POST') return await bulkAnalyzePricing(request, env);
      if (path === '/api/properties/bulk-tax-rate' && method === 'POST') return await bulkUpdateTaxRate(request, env, uid);
      if (path.match(/^\/api\/properties\/\d+\/pl-strategy$/) && method === 'POST') return await generatePLStrategyRecommendation(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/revenue-optimize$/) && method === 'POST') return await generateRevenueOptimization(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/listing-health$/) && method === 'GET') return await getListingHealth(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/acquisition-analysis$/) && method === 'POST') return await generateAcquisitionAnalysis(path.split('/')[3], request, env);
      if (path.match(/^\/api\/properties\/\d+\/strategies$/) && method === 'GET') return await getStrategies(path.split("/")[3], env, uid);
      if (path.match(/^\/api\/properties\/\d+\/performance$/) && method === 'GET') return await getPerformanceHistory(path.split("/")[3], env, uid);
      if (path.match(/^\/api\/properties\/\d+\/reports$/) && method === 'GET') return await getAnalysisReports(path.split("/")[3], env, uid);
      if (path.match(/^\/api\/properties\/\d+\/share$/) && method === 'POST') return await createShareCode(path.split('/')[3], request, env);
      if (path.match(/^\/api\/properties\/\d+\/share$/) && method === 'GET') return await getShareCodes(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/share$/) && method === 'DELETE') return await deleteShareCode(path.split('/')[3], request, env);
      if (path.match(/^\/api\/properties\/\d+\/auto-amenities$/) && method === 'POST') return await autoFetchAmenities(path.split('/')[3], env);
      // Guesty import
      if (path === '/api/guesty/import' && method === 'POST') return await importGuestyCsv(request, env, uid);
      if (path === '/api/guesty/listings' && method === 'GET') return await getGuestyListings(env);
      if (path === '/api/guesty/listings/link' && method === 'POST') return await linkGuestyListing(request, env);
      if (path === '/api/guesty/listings/unlink' && method === 'POST') return await unlinkGuestyListing(request, env);
      if (path === '/api/guesty/process' && method === 'POST') return await processGuestyData(env);
      if (path === '/api/guesty/rematch' && method === 'POST') { const r = await autoMatchGuestyListings(env); return json({ matched: r.matched, total: r.total, message: 'Re-matched ' + r.matched + ' of ' + r.total + ' unmatched listings.' }); }
      if (path === '/api/guesty/actuals' && method === 'GET') return await getMonthlyActuals(env);
      if (path === '/api/guesty/stats' && method === 'GET') return await getGuestyStats(env);
      if (path === '/api/guesty/connect' && method === 'POST') return await connectGuestyApi(request, env);
      if (path === '/api/guesty/connection' && method === 'GET') return await getGuestyConnection(env);
      if (path === '/api/guesty/api-sync' && method === 'POST') return await syncGuestyApi(request, env);
      if (path === '/api/guesty/api-sync-listings' && method === 'POST') return await syncGuestyListingsApi(env);
      if (path === '/api/guesty/sync-photos' && method === 'POST') return await syncGuestyPhotos(request, env);
      if (path === '/api/guesty/sync-calendar' && method === 'POST') return await syncGuestyCalendar(request, env);
      if (path === '/api/guesty/calendar' && method === 'GET') return await getGuestyCalendarData(url.searchParams, env);
      if (path === '/api/guesty/webhooks/subscribe' && method === 'POST') return await subscribeGuestyWebhooks(request, env);
      if (path === '/api/guesty/webhooks/status' && method === 'GET') return await getGuestyWebhookStatus(env);
      if (path === '/api/sync/log' && method === 'GET') return await getSyncLog(env);
      if (path === '/api/sync/run' && method === 'POST') return await runManualSync(request, env);
      // Intelligence APIs
      if (path === '/api/intelligence/guests' && method === 'GET') return await getGuestIntelligence(url.searchParams, env);
      if (path === '/api/intelligence/market' && method === 'GET') return await getMarketIntelligence(url.searchParams, env);
      if (path === '/api/intelligence/channels' && method === 'GET') return await getChannelIntelligence(url.searchParams, env);
      if (path === '/api/intelligence/rebuild' && method === 'POST') return await rebuildIntelligence(request, env);
      if (path === '/api/intelligence/context' && method === 'GET') return await getIntelligenceContext(url.searchParams, env);
      if (path === '/api/intelligence/debug' && method === 'GET') return await getIntelligenceDebug(env);
      if (path === '/api/guesty/debug-reservation' && method === 'GET') return await debugGuestyReservation(env, url.searchParams);
      if (path === '/api/guesty/debug-pets' && method === 'GET') {
        const stats = await env.DB.prepare(`SELECT 
          COUNT(*) as total_reservations,
          SUM(CASE WHEN guesty_id IS NOT NULL THEN 1 ELSE 0 END) as with_guesty_id,
          SUM(CASE WHEN guesty_id IS NULL THEN 1 ELSE 0 END) as without_guesty_id,
          SUM(CASE WHEN has_pets = 1 THEN 1 ELSE 0 END) as has_pets,
          SUM(CASE WHEN has_pets = -1 THEN 1 ELSE 0 END) as checked_no_pets,
          SUM(CASE WHEN has_pets = 0 THEN 1 ELSE 0 END) as unchecked,
          SUM(CASE WHEN pet_fee > 0 THEN 1 ELSE 0 END) as with_pet_fee,
          SUM(COALESCE(pet_fee, 0)) as total_pet_fee_amount
          FROM guesty_reservations`).first();
        const petRows = await env.DB.prepare(`SELECT confirmation_code, guest_name, check_in, has_pets, pet_type, pet_fee, guesty_id, source_file FROM guesty_reservations WHERE has_pets = 1 ORDER BY check_in DESC LIMIT 30`).all();
        const redactName = (n) => { if (!n) return '—'; const parts = n.trim().split(/\s+/); if (parts.length <= 1) return parts[0]; return parts[0] + ' ' + parts[parts.length - 1][0] + '.'; };
        const safePetRows = (petRows.results || []).map(r => ({ ...r, guest_name: redactName(r.guest_name) }));
        const guestStayPets = await env.DB.prepare(`SELECT COUNT(*) as count, SUM(COALESCE(pet_fee, 0)) as total_pet_fee FROM guesty_reservations WHERE has_pets = 1 AND ${LIVE_STATUS_SQL}`).first();
        // Duplicate detection — same guest+checkin different confirmation codes
        const dupes = await env.DB.prepare(`SELECT guest_name, check_in, COUNT(*) as cnt, GROUP_CONCAT(confirmation_code, ' | ') as codes FROM guesty_reservations WHERE ${LIVE_STATUS_SQL} GROUP BY LOWER(guest_name), check_in HAVING cnt > 1 LIMIT 20`).all();
        const safeDupes = (dupes.results || []).map(r => ({ ...r, guest_name: redactName(r.guest_name) }));
        // Returning guest sanity check
        const returningCheck = await env.DB.prepare(`SELECT COUNT(DISTINCT guest_id) as total_guests, SUM(CASE WHEN stay_ct > 1 THEN 1 ELSE 0 END) as multi_stay_in_table, (SELECT COUNT(*) FROM guesty_guests WHERE total_stays > 1) as multi_stay_lifetime FROM (SELECT guest_id, COUNT(*) as stay_ct FROM guesty_reservations WHERE guest_id IS NOT NULL AND ${LIVE_STATUS_SQL} GROUP BY guest_id)`).first();
        return json({ reservation_stats: stats, pet_reservations: safePetRows, guest_stays_pets: guestStayPets, possible_duplicates: safeDupes, returning_check: returningCheck });
      }
      // Market Watchlist
      if (path === '/api/watchlist' && method === 'GET') return await getMarketWatchlist(env);
      if (path === '/api/watchlist' && method === 'POST') return await upsertWatchlistMarket(request, env);
      if (path.match(/^\/api\/watchlist\/\d+$/) && method === 'DELETE') { const wid = path.split('/')[3]; await env.DB.prepare(`DELETE FROM market_watchlist WHERE id = ?`).bind(wid).run(); return json({ ok: true }); }
      if (path === '/api/watchlist/auto-populate' && method === 'POST') return await autoPopulateWatchlist(env);
      // Market Profiles
      if (path === '/api/market/profiles' && method === 'GET') return await getAllMarketProfiles(env);
      if (path === '/api/market/profile' && method === 'GET') { const c = url.searchParams.get('city'); const s = url.searchParams.get('state'); if (!c || !s) return json({ error: 'city and state required' }, 400); return await getMarketProfile(c, s, env); }
      if (path === '/api/market/profile/enrich' && method === 'POST') return await enrichMarketProfile(request, env);
      // Property Calendar (unified: Guesty + PriceLabs + Strategy)
      if (path.match(/^\/api\/properties\/\d+\/calendar$/) && method === 'GET') return await getPropertyCalendar(path.split('/')[3], url.searchParams, env);
      // Algo templates
      if (path === '/api/algo-templates' && method === 'GET') return await getAlgoTemplates(env);
      if (path === '/api/algo-templates' && method === 'POST') return await upsertAlgoTemplate(request, env);
      if (path.match(/^\/api\/algo-templates\/\d+$/) && method === 'GET') { const t = await env.DB.prepare(`SELECT * FROM algo_templates WHERE id = ?`).bind(path.split('/')[3]).first(); return json({ template: t || null }); }
      if (path.match(/^\/api\/algo-templates\/\d+$/) && method === 'PUT') return await upsertAlgoTemplate(request, env, path.split('/')[3]);
      if (path.match(/^\/api\/algo-templates\/\d+$/) && method === 'DELETE') { await env.DB.prepare(`DELETE FROM algo_templates WHERE id = ?`).bind(path.split('/')[3]).run(); await env.DB.prepare(`UPDATE properties SET algo_template_id = NULL WHERE algo_template_id = ?`).bind(path.split('/')[3]).run(); return json({ ok: true }); }
      if (path === '/api/algo-templates/assign' && method === 'POST') return await assignAlgoTemplate(request, env);
      // Capital expenses
      if (path.match(/^\/api\/properties\/\d+\/algo-overrides$/) && method === 'GET') {
        const pid = path.split('/')[3];
        const row = await env.DB.prepare(`SELECT * FROM property_algo_overrides WHERE property_id = ?`).bind(pid).first();
        return json({ overrides: row || {} });
      }
      if (path.match(/^\/api\/properties\/\d+\/algo-overrides$/) && method === 'POST') {
        const pid = path.split('/')[3];
        const b = await request.json();
        await env.DB.prepare(`INSERT INTO property_algo_overrides (property_id, min_nights, weekend_pct, lastmin_pct, gap_pct, earlybird_pct, monthly_pct, notes, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(property_id) DO UPDATE SET min_nights=excluded.min_nights, weekend_pct=excluded.weekend_pct, lastmin_pct=excluded.lastmin_pct, gap_pct=excluded.gap_pct, earlybird_pct=excluded.earlybird_pct, monthly_pct=excluded.monthly_pct, notes=excluded.notes, updated_at=datetime('now')`).bind(pid, b.min_nights||null, b.weekend_pct||null, b.lastmin_pct||null, b.gap_pct||null, b.earlybird_pct||null, b.monthly_pct||null, b.notes||null).run();
        return json({ ok: true });
      }
      if (path.match(/^\/api\/properties\/\d+\/expenses$/) && method === 'GET') { const { results } = await env.DB.prepare(`SELECT * FROM property_expenses WHERE property_id = ? ORDER BY date_incurred DESC, created_at DESC`).bind(path.split('/')[3]).all(); return json({ expenses: results }); }
      if (path.match(/^\/api\/properties\/\d+\/expenses$/) && method === 'POST') { const b = await request.json(); if (!b.name || !b.amount) return json({error:'name and amount required'},400); await env.DB.prepare(`INSERT INTO property_expenses (property_id, name, amount, category, date_incurred, notes) VALUES (?,?,?,?,?,?)`).bind(path.split('/')[3], b.name, b.amount, b.category || 'other', b.date_incurred || new Date().toISOString().split('T')[0], b.notes || null).run(); return json({ok:true}); }
      if (path.match(/^\/api\/expenses\/\d+$/) && method === 'DELETE') { await env.DB.prepare(`DELETE FROM property_expenses WHERE id = ?`).bind(path.split('/')[3]).run(); return json({ok:true}); }
      if (path === '/api/expenses/summary' && method === 'GET') return await getExpensesSummary(env);
      if (path === '/api/cf-usage' && method === 'GET') return await getCfUsage(env);
      if (path === '/api/usage-alerts' && method === 'GET') return await getUsageAlerts(env);
      if (path.match(/^\/api\/properties\/\d+\/zestimate$/) && method === 'POST') return await fetchZestimate(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/services$/) && method === 'GET') { const { results } = await env.DB.prepare(`SELECT * FROM property_services WHERE property_id = ? ORDER BY name`).bind(path.split('/')[3]).all(); return json({ services: results }); }
      if (path.match(/^\/api\/properties\/\d+\/services$/) && method === 'POST') {
        const b = await request.json(); if (!b.name) return json({error:'name required'},400);
        const pid = path.split('/')[3];
        await env.DB.prepare(`INSERT INTO property_services (property_id, name, monthly_cost) VALUES (?,?,?)`).bind(pid, b.name, b.monthly_cost || 0).run();
        // Auto-add to catalog
        const isChild = await env.DB.prepare(`SELECT parent_id FROM properties WHERE id = ?`).bind(pid).first();
        if (isChild && isChild.parent_id) {
          await env.DB.prepare(`INSERT INTO service_catalog (name, child_cost) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET child_cost=?`).bind(b.name, b.monthly_cost, b.monthly_cost).run();
        } else {
          await env.DB.prepare(`INSERT INTO service_catalog (name, default_cost) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET default_cost=?`).bind(b.name, b.monthly_cost, b.monthly_cost).run();
        }
        return json({ok:true});
      }
      if (path.match(/^\/api\/services\/\d+$/) && method === 'DELETE') { await env.DB.prepare(`DELETE FROM property_services WHERE id = ?`).bind(path.split('/')[3]).run(); return json({ok:true}); }
      if (path === '/api/service-catalog' && method === 'GET') { const { results } = await env.DB.prepare(`SELECT * FROM service_catalog ORDER BY name`).all(); return json({ catalog: results }); }
      if (path.match(/^\/api\/properties\/\d+\/copy-from\/\d+$/) && method === 'POST') return await copyPropertyData(path.split('/')[3], path.split('/')[5], request, env);
      if (path.match(/^\/api\/properties\/\d+\/copy-preview\/\d+$/) && method === 'GET') return await copyPreview(path.split('/')[3], path.split('/')[5], env);
      return json({ error: 'Not found' }, 404);
    } catch (err) { console.error(err); await syslog(env, 'error', 'global', url?.pathname || 'unknown route', err.message); return json({ error: err.message || 'Internal server error' }, 500); }
  },

  // ─── Cron Scheduled Handler ───────────────────────────────────────────
  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    const trigger = event.cron;
    const now = new Date().toISOString();
    console.log('[CRON] Triggered: ' + trigger + ' at ' + now);

    // Resolve DB-stored API keys into env (same as fetch handler)
    // Without this, keys stored via Admin UI won't be available to cron functions
    try {
      const { results: dbKeys } = await env.DB.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'apikey_%'`).all();
      const dbKeyMap = {};
      for (const row of (dbKeys || [])) { if (row.value) dbKeyMap[row.key] = row.value; }
      for (const k of MANAGED_KEYS) {
        const dbVal = dbKeyMap['apikey_' + k];
        if (dbVal) env[k] = dbVal;
      }
    } catch {}

    try {
      if (trigger === '0 */6 * * *') {
        // Every 6 hours — Guesty incremental reservation sync
        const hasCredentials = env.GUESTY_CLIENT_ID || await (async () => { try { return (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'apikey_GUESTY_CLIENT_ID'`).first())?.value; } catch { return null; } })();
        if (hasCredentials) {
          await logSync(env, 'guesty_reservations', 'cron', async () => {
            const fakeReq = { json: async () => ({ full: false }) };
            return await syncGuestyApi(fakeReq, env);
          });
        }
      }

      if (trigger === '0 6 * * *') {
        // Daily at 6am UTC — PriceLabs price sync + Guesty calendar + financial reconciliation
        const hasPL = env.PRICELABS_API_KEY || await (async () => { try { return (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'apikey_PRICELABS_API_KEY'`).first())?.value; } catch { return null; } })();
        if (hasPL) {
          await logSync(env, 'pricelabs_prices', 'cron', async () => {
            return await fetchAllPriceLabsPrices(env, null, false);
          });
        }
        // Guesty calendar sync (daily pricing/availability)
        const hasGuesty = env.GUESTY_CLIENT_ID || await (async () => { try { return (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'apikey_GUESTY_CLIENT_ID'`).first())?.value; } catch { return null; } })();
        if (hasGuesty) {
          await logSync(env, 'guesty_calendar', 'cron', async () => {
            const fakeReq = { json: async () => ({}) };
            return await syncGuestyCalendar(fakeReq, env);
          });
          // Monthly actuals rebuild
          await logSync(env, 'monthly_actuals', 'cron', async () => {
            return await processGuestyData(env);
          });
          // Rebuild intelligence (guest, market, channel analytics)
          await logSync(env, 'intelligence', 'cron', async () => {
            const fakeReq = { json: async () => ({ sections: ['guests', 'market', 'channels'] }) };
            return await rebuildIntelligence(fakeReq, env);
          });

          // Daily performance snapshots — captures ADR, occupancy, revenue trends
          // Uses PriceLabs + monthly_actuals data, so runs after both are refreshed
          try {
            await capturePerformanceSnapshots(env);
            console.log('[CRON] Performance snapshots captured');
          } catch (snapErr) { console.log('[CRON] Snapshot error: ' + snapErr.message); }
        }
      }

      if (trigger === '0 7 * * 1') {
        // Weekly on Monday at 7am UTC — Guesty listing sync + PriceLabs listing refresh
        const hasGuesty = env.GUESTY_CLIENT_ID || await (async () => { try { return (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'apikey_GUESTY_CLIENT_ID'`).first())?.value; } catch { return null; } })();
        if (hasGuesty) {
          await logSync(env, 'guesty_listings', 'cron', async () => {
            return await syncGuestyListingsApi(env);
          });
        }
        const hasPL = env.PRICELABS_API_KEY || await (async () => { try { return (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'apikey_PRICELABS_API_KEY'`).first())?.value; } catch { return null; } })();
        if (hasPL) {
          await logSync(env, 'pricelabs_listings', 'cron', async () => {
            return await syncPriceLabsListings(env, null, false);
          });
        }

        // Auto-analyze: re-run pricing analysis on stale or unanalyzed properties
        // Max 5 per week to control API costs. Skips research, managed, buildings.
        try {
          const hasAI = env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY;
          if (hasAI) {
            await logSync(env, 'auto_analysis', 'cron', async () => {
              return await autoAnalyzeProperties(env);
            });
          }
        } catch {}
      }

      // Clean up old sync logs (keep 90 days)
      try { await env.DB.prepare(`DELETE FROM sync_log WHERE started_at < datetime('now', '-90 days')`).run(); } catch {}
      try { await env.DB.prepare(`DELETE FROM webhook_log WHERE created_at < datetime('now', '-30 days')`).run(); } catch {}
      try { await env.DB.prepare(`DELETE FROM system_log WHERE created_at < datetime('now', '-30 days')`).run(); } catch {}

      // Mark stale master_listings as inactive (not seen in 90 days)
      try { await env.DB.prepare(`UPDATE master_listings SET status = 'stale' WHERE status = 'active' AND last_scraped < datetime('now', '-90 days') AND last_updated < datetime('now', '-90 days')`).run(); } catch {}

      // Auto-crawl watchlist markets — check which are due for refresh
      if (trigger === '0 6 * * *') {
        try {
          // Auto-populate watchlist from properties
          await autoPopulateWatchlist(env);

          // Find markets due for crawl — prioritize markets with least data
          const { results: dueCrawls } = await env.DB.prepare(
            `SELECT city, state, frequency, listing_count, last_crawl FROM market_watchlist WHERE next_crawl IS NULL OR next_crawl <= datetime('now') ORDER BY COALESCE(listing_count, 0) ASC, last_crawl ASC`
          ).all();

          let crawled = 0;
          // Budget guardrail: check SearchAPI usage this month before crawling
          // Each market uses ~2 API calls (Airbnb + VRBO). Reserve 20 calls for manual searches.
          let searchApiBudgetOk = true;
          try {
            const saUsage = await env.DB.prepare(`SELECT COUNT(*) as c FROM api_usage WHERE service = 'searchapi' AND created_at >= date('now', 'start of month')`).first();
            const saLimit = API_COSTS.searchapi ? API_COSTS.searchapi.free_limit : 100;
            const saUsed = saUsage?.c || 0;
            const saReserve = 20; // keep 20 for manual searches
            if (saUsed >= saLimit - saReserve) {
              searchApiBudgetOk = false;
              console.log('[CRON] SearchAPI budget guard: ' + saUsed + '/' + saLimit + ' calls used, skipping crawls (reserve ' + saReserve + ' for manual)');
            }
          } catch {}

          for (const m of (dueCrawls || []).slice(0, 10)) {
            try {
              // Smart skip: if market has 25+ listings and was crawled in the last 10 days, skip the API call
              // This saves SearchAPI budget for markets that actually need fresh data
              const hasGoodData = (m.listing_count || 0) >= 25;
              const daysSinceCrawl = m.last_crawl ? Math.round((Date.now() - new Date(m.last_crawl).getTime()) / 86400000) : 999;
              const skipCrawl = hasGoodData && daysSinceCrawl < 10;

              // First crawl fresh listings from SearchAPI into master_listings
              let crawlResult = null;
              if (searchApiBudgetOk && !skipCrawl) {
                crawlResult = await crawlMarketListings(m.city, m.state, env);
                // Recheck budget after each crawl (each uses ~2 calls)
                try {
                  const saCheck = await env.DB.prepare(`SELECT COUNT(*) as c FROM api_usage WHERE service = 'searchapi' AND created_at >= date('now', 'start of month')`).first();
                  if ((saCheck?.c || 0) >= 80) searchApiBudgetOk = false;
                } catch {}
              }
              // Then build/refresh the market profile from the now-populated data
              await buildMarketProfile(m.city, m.state, env);
              // Set next_crawl based on frequency — only mark last_crawl if we actually crawled
              const interval = m.frequency === 'weekly' ? '+14 days' : m.frequency === 'biweekly' ? '+14 days' : '+30 days';
              if (skipCrawl) {
                // Good data, skipped crawl — push next check to frequency interval, still rebuild profile from existing data
                await env.DB.prepare(`UPDATE market_watchlist SET next_crawl = datetime('now', ?), updated_at = datetime('now') WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`).bind(interval, m.city, m.state).run();
              } else if (crawlResult && (crawlResult.crawled || 0) > 0) {
                await env.DB.prepare(`UPDATE market_watchlist SET last_crawl = datetime('now'), next_crawl = datetime('now', ?), updated_at = datetime('now') WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`).bind(interval, m.city, m.state).run();
              } else {
                // Budget-blocked or 0 results — set next_crawl so we don't hammer on next cron
                await env.DB.prepare(`UPDATE market_watchlist SET next_crawl = datetime('now', ?), updated_at = datetime('now') WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`).bind(interval, m.city, m.state).run();
              }
              crawled++;
            } catch {}
          }
          if (crawled > 0) {
            await env.DB.prepare(`INSERT INTO sync_log (sync_type, source, status, records_processed, completed_at) VALUES ('market_crawl_profiles', 'cron', 'completed', ?, datetime('now'))`).bind(crawled).run();
          }
        } catch {}
      }

    } catch (err) {
      console.error('[CRON] Error:', err.message);
      try { await env.DB.prepare(`INSERT INTO sync_log (sync_type, source, status, error, completed_at) VALUES ('cron_error', 'cron', 'error', ?, datetime('now'))`).bind(err.message).run(); } catch {}
      await syslog(env, 'error', 'cron', 'Cron job failed', err.message);
    }
  },
};
async function checkInit(env) {
  const admin = await env.DB.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).first();
  return json({ initialized: !!admin });
}

async function initAdmin(request, env) {
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`).first();
  if (existing) return json({ error: 'Admin already exists' }, 400);
  const { email, display_name } = await request.json();
  if (!email) return json({ error: 'Email required' }, 400);
  const hash = await hashPassword(DEFAULT_ADMIN_PASSWORD);
  await env.DB.prepare(`INSERT INTO users (email, display_name, password_hash, role, must_change_password, approved_at) VALUES (?, ?, ?, 'admin', 1, datetime('now'))`).bind(email, display_name || 'Admin', hash).run();
  return json({ message: 'Admin account created. Sign in with the default password you configured, then change it immediately on first login.' });
}

async function login(request, env) {
  const { email, password } = await request.json();
  if (!email || !password) return json({ error: 'Email and password required' }, 400);
  const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?`).bind(email.toLowerCase().trim()).first();
  if (!user) return json({ error: 'Invalid credentials' }, 401);
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return json({ error: 'Invalid credentials' }, 401);
  if (user.role === 'pending') return json({ error: 'Your account is pending admin approval.', code: 'PENDING_APPROVAL' }, 403);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600000).toISOString();
  await env.DB.prepare(`INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, ?)`).bind(user.id, token, expiresAt).run();
  await env.DB.prepare(`UPDATE users SET last_login = datetime('now') WHERE id = ?`).bind(user.id).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`).run();
  return json({ token, user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role, must_change_password: user.must_change_password } });
}

async function register(request, env) {
  const { email, display_name, password } = await request.json();
  if (!email || !password || !display_name) return json({ error: 'Email, display name, and password are all required' }, 400);
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
  const emailClean = email.toLowerCase().trim();
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(emailClean).first();
  if (exists) return json({ error: 'An account with this email already exists' }, 409);
  const hash = await hashPassword(password);
  await env.DB.prepare(`INSERT INTO users (email, display_name, password_hash, role, must_change_password) VALUES (?, ?, ?, 'pending', 0)`).bind(emailClean, display_name.trim(), hash).run();
  return json({ message: 'Account request submitted. An admin will review and approve your access.' }, 201);
}

async function changePassword(user, request, env) {
  const { current_password, new_password } = await request.json();
  if (!new_password) return json({ error: 'New password required' }, 400);
  if (new_password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
  if (new_password === DEFAULT_ADMIN_PASSWORD) return json({ error: 'Cannot reuse the default password' }, 400);
  if (!user.must_change_password) {
    if (!current_password) return json({ error: 'Current password required' }, 400);
    const rec = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(user.user_id).first();
    const valid = await verifyPassword(current_password, rec.password_hash);
    if (!valid) return json({ error: 'Current password is incorrect' }, 401);
  }
  const hash = await hashPassword(new_password);
  await env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?`).bind(hash, user.user_id).run();
  return json({ message: 'Password changed successfully' });
}
async function listUsers(env) {
  const { results } = await env.DB.prepare(`SELECT id, email, display_name, role, must_change_password, approved_at, last_login, created_at FROM users ORDER BY CASE role WHEN 'pending' THEN 0 WHEN 'admin' THEN 1 WHEN 'user' THEN 2 END, created_at DESC`).all();
  return json({ users: results });
}

async function approveUser(id, admin, env) {
  const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  if (!u) return json({ error: 'User not found' }, 404);
  if (u.role !== 'pending') return json({ error: 'User is not pending' }, 400);
  await env.DB.prepare(`UPDATE users SET role = 'user', approved_at = datetime('now'), approved_by = ?, updated_at = datetime('now') WHERE id = ?`).bind(admin.user_id, id).run();
  return json({ message: `${u.display_name} approved` });
}

async function rejectUser(id, env) {
  const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  if (!u) return json({ error: 'User not found' }, 404);
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  return json({ message: `${u.display_name} rejected and removed` });
}

async function setUserRole(id, request, env) {
  const { role } = await request.json();
  if (!['user', 'admin'].includes(role)) return json({ error: 'Invalid role' }, 400);
  await env.DB.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`).bind(role, id).run();
  return json({ message: 'Role updated' });
}

async function resetUserPassword(id, env) {
  const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  if (!u) return json({ error: 'User not found' }, 404);
  const temp = 'Reset' + Math.random().toString(36).substring(2, 8) + '!';
  const hash = await hashPassword(temp);
  await env.DB.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?`).bind(hash, id).run();
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  return json({ message: `Password reset for ${u.display_name}`, temp_password: temp });
}

async function deleteUser(id, admin, env) {
  if (parseInt(id) === admin.user_id) return json({ error: 'Cannot delete yourself' }, 400);
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  return json({ message: 'User deleted' });
}
async function setupDNS(request, env) {
  const { cf_api_token, zone_id, subdomain, worker_route } = await request.json();
  if (!cf_api_token) return json({ error: 'Cloudflare API token required' }, 400);
  if (!zone_id) return json({ error: 'Zone ID required (Cloudflare Dashboard → domain → Overview → right sidebar)' }, 400);
  const sub = subdomain || 'pmr';
  const domain = 'fullcircle-property.com';
  const fullDomain = sub + '.' + domain;
  const results = { steps: [] };
  try {
    // Check existing CNAME
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records?type=CNAME&name=${fullDomain}`, { headers: { 'Authorization': `Bearer ${cf_api_token}`, 'Content-Type': 'application/json' } });
    const listData = await listRes.json();
    if (listData.result && listData.result.length > 0) {
      results.steps.push({ action: 'CNAME exists', detail: `${fullDomain} already configured`, status: 'skip' });
    } else {
      const workerHost = worker_route || 'fcp-pmr.workers.dev';
      const createRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone_id}/dns_records`, { method: 'POST', headers: { 'Authorization': `Bearer ${cf_api_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'CNAME', name: sub, content: workerHost, proxied: true, ttl: 1, comment: 'FCP PMR — auto-configured' }) });
      const createData = await createRes.json();
      if (createData.success) results.steps.push({ action: 'CNAME created', detail: `${fullDomain} → ${workerHost} (proxied)`, status: 'ok' });
      else results.steps.push({ action: 'CNAME failed', detail: JSON.stringify(createData.errors), status: 'error' });
    }
    // Worker route
    const routeRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone_id}/workers/routes`, { method: 'POST', headers: { 'Authorization': `Bearer ${cf_api_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern: `${fullDomain}/*`, script: 'fcp-pmr' }) });
    const routeData = await routeRes.json();
    if (routeData.success) results.steps.push({ action: 'Worker route created', detail: `${fullDomain}/* → fcp-pmr`, status: 'ok' });
    else {
      const msg = routeData.errors?.map(e => e.message).join(', ') || '';
      results.steps.push({ action: 'Worker route', detail: msg.includes('duplicate') || msg.includes('already') ? 'Already configured' : msg, status: msg.includes('duplicate') || msg.includes('already') ? 'skip' : 'error' });
    }
    results.domain = `https://${fullDomain}`;
    results.message = 'DNS configured. Changes propagate in 1-2 minutes.';
  } catch (err) { results.steps.push({ action: 'Error', detail: err.message, status: 'error' }); return json(results, 500); }
  return json(results);
}

async function checkDNSStatus(env) {
  const domain = 'pmr.fullcircle-property.com';
  try {
    const res = await fetch(`https://${domain}/api/auth/init`, { method: 'GET' });
    return json({ domain, reachable: res.ok, status: res.status });
  } catch { return json({ domain, reachable: false, status: 0 }); }
}
async function getProperties(env, uid) {
  const userFilter = uid ? `WHERE (p.user_id = ? OR p.user_id IS NULL)` : '';
  // Optimized: LEFT JOINs instead of ~17 correlated subqueries per row
  // 1) pricelabs_listings: one LEFT JOIN gets all PL columns
  // 2) latest pricing_strategy: JOIN on a subquery for max(id) per property
  // 3) counts: aggregate subqueries grouped, but only 3 instead of 17 separate lookups
  const { results } = await env.DB.prepare(`
    SELECT p.*,
      COALESCE(pa_cnt.amenity_count, 0) as amenity_count,
      COALESCE(comp_cnt.comparable_count, 0) as comparable_count,
      COALESCE(strat_cnt.strategy_count, 0) as strategy_count,
      COALESCE(child_cnt.child_count, 0) as child_count,
      ps.projected_monthly_avg as est_monthly_revenue,
      ps.base_nightly_rate as analysis_nightly_rate,
      ps.cleaning_fee as analysis_cleaning,
      ps.projected_occupancy as analysis_occ,
      ps.projected_monthly_avg as analysis_monthly,
      ps.projected_annual_revenue as analysis_annual,
      ps.strategy_name as latest_strategy,
      ps.created_at as last_analyzed,
      pl.base_price as pl_base_price,
      pl.recommended_base_price as pl_rec_base,
      pl.min_price as pl_min_price,
      pl.max_price as pl_max_price,
      pl.cleaning_fees as pl_cleaning,
      pl.occupancy_next_30 as pl_occ_30d,
      pl.market_occupancy_next_30 as pl_mkt_occ_30d
    FROM properties p
    LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
    LEFT JOIN (
      SELECT property_id, MAX(id) as max_id FROM pricing_strategies GROUP BY property_id
    ) ps_max ON ps_max.property_id = p.id
    LEFT JOIN pricing_strategies ps ON ps.id = ps_max.max_id
    LEFT JOIN (
      SELECT property_id, COUNT(*) as amenity_count FROM property_amenities GROUP BY property_id
    ) pa_cnt ON pa_cnt.property_id = p.id
    LEFT JOIN (
      SELECT property_id, COUNT(*) as comparable_count FROM comparables GROUP BY property_id
    ) comp_cnt ON comp_cnt.property_id = p.id
    LEFT JOIN (
      SELECT property_id, COUNT(*) as strategy_count FROM pricing_strategies GROUP BY property_id
    ) strat_cnt ON strat_cnt.property_id = p.id
    LEFT JOIN (
      SELECT parent_id, COUNT(*) as child_count FROM properties WHERE parent_id IS NOT NULL GROUP BY parent_id
    ) child_cnt ON child_cnt.parent_id = p.id
    ${userFilter}
    ORDER BY p.parent_id ASC NULLS FIRST, p.updated_at DESC
  `).bind(...(uid ? [uid] : [])).all();
  // Get performance trend data for badges
  let perfTrends = {};
  try {
    // Get latest 2 snapshots per property — efficient: grab recent snapshots, group in JS
    const { results: allSnaps } = await env.DB.prepare(`
      SELECT property_id, snapshot_date, est_monthly_net, est_monthly_revenue, blended_adr
      FROM performance_snapshots
      ORDER BY snapshot_date DESC
      LIMIT 500
    `).all();
    // Group by property, take latest 2
    const byProp = {};
    for (const s of (allSnaps || [])) {
      if (!byProp[s.property_id]) byProp[s.property_id] = [];
      if (byProp[s.property_id].length < 2) byProp[s.property_id].push(s);
    }
    for (const pid in byProp) {
      const latest = byProp[pid][0];
      const prev = byProp[pid].length > 1 ? byProp[pid][1] : null;
      perfTrends[pid] = {
        latest_net: latest.est_monthly_net,
        latest_rev: latest.est_monthly_revenue,
        latest_adr: latest.blended_adr,
        latest_date: latest.snapshot_date,
        prev_net: prev ? prev.est_monthly_net : null,
        prev_rev: prev ? prev.est_monthly_revenue : null,
        prev_adr: prev ? prev.blended_adr : null,
        prev_date: prev ? prev.snapshot_date : null,
      };
    }
  } catch {}

  // Get actual revenue from Guesty monthly_actuals (last 12 months)
  let actualRevenue = {};
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const fromMonth = twelveMonthsAgo.getFullYear() + '-' + String(twelveMonthsAgo.getMonth() + 1).padStart(2, '0');
    const { results: actuals } = await env.DB.prepare(`SELECT property_id, SUM(total_revenue) as total_rev, SUM(booked_nights) as total_nights, SUM(available_nights) as total_avail, COUNT(*) as month_count FROM monthly_actuals WHERE month >= ? GROUP BY property_id`).bind(fromMonth).all();
    for (const a of (actuals || [])) {
      actualRevenue[a.property_id] = {
        monthly_avg: a.month_count > 0 ? Math.round(a.total_rev / a.month_count) : 0,
        annual: Math.round(a.total_rev),
        occ: a.total_avail > 0 ? Math.round(a.total_nights / a.total_avail * 100) : 0,
        adr: a.total_nights > 0 ? Math.round(a.total_rev / a.total_nights) : 0,
        months: a.month_count,
      };
    }
    // This month and last month per-property
    const thisMonth = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
    const lmDate = new Date(); lmDate.setMonth(lmDate.getMonth() - 1);
    const lastMonth = lmDate.getFullYear() + '-' + String(lmDate.getMonth() + 1).padStart(2, '0');
    const { results: tmActuals } = await env.DB.prepare(`SELECT property_id, total_revenue, booked_nights, available_nights, occupancy_pct, avg_nightly_rate, host_payout FROM monthly_actuals WHERE month = ?`).bind(thisMonth).all();
    for (const t of (tmActuals || [])) {
      if (actualRevenue[t.property_id]) {
        actualRevenue[t.property_id].this_month_rev = Math.round(t.total_revenue || 0);
        actualRevenue[t.property_id].this_month_occ = Math.round((t.occupancy_pct || 0) * 100);
        actualRevenue[t.property_id].this_month_adr = Math.round(t.avg_nightly_rate || 0);
        actualRevenue[t.property_id].this_month_nights = t.booked_nights || 0;
        actualRevenue[t.property_id].this_month_payout = Math.round(t.host_payout || 0);
      } else {
        actualRevenue[t.property_id] = { monthly_avg: 0, annual: 0, occ: 0, adr: 0, months: 0, this_month_rev: Math.round(t.total_revenue || 0), this_month_occ: Math.round((t.occupancy_pct || 0) * 100), this_month_adr: Math.round(t.avg_nightly_rate || 0), this_month_nights: t.booked_nights || 0, this_month_payout: Math.round(t.host_payout || 0) };
      }
    }
    const { results: lmActuals } = await env.DB.prepare(`SELECT property_id, total_revenue, host_payout, occupancy_pct FROM monthly_actuals WHERE month = ?`).bind(lastMonth).all();
    for (const l of (lmActuals || [])) {
      if (actualRevenue[l.property_id]) {
        actualRevenue[l.property_id].last_month_rev = Math.round(l.total_revenue || 0);
        actualRevenue[l.property_id].last_month_payout = Math.round(l.host_payout || 0);
      }
    }
  } catch {}

  // Market profiles for performance badges (ADR vs market)
  let marketProfiles = {};
  try {
    const { results: mps } = await env.DB.prepare(`SELECT city, state, str_avg_adr, str_median_adr, str_avg_occupancy, str_listing_count FROM market_profiles`).all();
    for (const mp of (mps || [])) {
      const key = (mp.city || '').toLowerCase() + ',' + (mp.state || '').toLowerCase();
      marketProfiles[key] = { avg_adr: mp.str_avg_adr, median_adr: mp.str_median_adr, avg_occ: mp.str_avg_occupancy, listings: mp.str_listing_count };
    }
  } catch {}

  return json({ properties: results, trends: perfTrends, actual_revenue: actualRevenue, market_profiles: marketProfiles });
}

async function getProperty(id, env, uid) {
  const q = uid ? `SELECT * FROM properties WHERE id = ? AND (user_id = ? OR user_id IS NULL)` : `SELECT * FROM properties WHERE id = ?`;
  const property = uid ? await env.DB.prepare(q).bind(id, uid).first() : await env.DB.prepare(q).bind(id).first();
  if (!property) return json({ error: 'Property not found' }, 404);
  const { results: amenities } = await env.DB.prepare(`SELECT a.* FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(id).all();
  const { results: strategies } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC`).bind(id).all();
  const { results: comparables } = await env.DB.prepare(`SELECT * FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC`).bind(id).all();
  const { results: children } = await env.DB.prepare(`SELECT p.*, (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as est_monthly_revenue, (SELECT strategy_name FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as latest_strategy, (SELECT COUNT(*) FROM property_amenities WHERE property_id = p.id) as amenity_count, (SELECT COUNT(*) FROM comparables WHERE property_id = p.id) as comp_count, (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) as strategy_count FROM properties p WHERE p.parent_id = ? ORDER BY p.unit_number ASC`).bind(id).all();
  let parent = null;
  if (property.parent_id) {
    parent = await env.DB.prepare(`SELECT id, name, address, city, state, unit_number FROM properties WHERE id = ?`).bind(property.parent_id).first();
  }
  // PriceLabs data for this property
  let pricelabs = null;
  let plAvailable = false;
  try {
    const plCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings`).first();
    plAvailable = (plCount?.c || 0) > 0;

    const plLink = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE property_id = ?`).bind(id).first();
    if (plLink) {
      // Parse channel details
      let channels = [];
      try { channels = plLink.channel_details ? JSON.parse(plLink.channel_details) : []; } catch {}

      // Also check rates table if any exist
      const today = new Date().toISOString().split('T')[0];
      const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const avg30 = await env.DB.prepare(`SELECT AVG(price) as avg, COUNT(*) as cnt FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= ? AND rate_date <= ? AND is_available = 1`).bind(plLink.pl_listing_id, today, next30).first();

      // Compute projected monthly from base price and occupancy
      const occ30Raw = plLink.occupancy_next_30 ? parseInt(plLink.occupancy_next_30) / 100 : null;
      const projMonthly = plLink.base_price && occ30Raw ? Math.round(plLink.base_price * 30 * occ30Raw) : (plLink.base_price ? Math.round(plLink.base_price * 30 * 0.5) : null);

      pricelabs = {
        linked: true,
        pl_listing_id: plLink.pl_listing_id,
        pl_listing_name: plLink.pl_listing_name,
        pl_platform: plLink.pl_platform,
        pl_pms: plLink.pl_pms,
        base_price: plLink.base_price,
        min_price: plLink.min_price,
        max_price: plLink.max_price,
        recommended_base_price: plLink.recommended_base_price,
        cleaning_fees: plLink.cleaning_fees,
        bedrooms: plLink.bedrooms,
        last_synced: plLink.last_synced,
        last_refreshed_at: plLink.last_refreshed_at,
        group_name: plLink.group_name,
        tags: plLink.tags,
        push_enabled: plLink.push_enabled,
        last_date_pushed: plLink.last_date_pushed,
        occupancy_next_7: plLink.occupancy_next_7,
        market_occupancy_next_7: plLink.market_occupancy_next_7,
        occupancy_next_30: plLink.occupancy_next_30,
        market_occupancy_next_30: plLink.market_occupancy_next_30,
        occupancy_next_60: plLink.occupancy_next_60,
        market_occupancy_next_60: plLink.market_occupancy_next_60,
        channels: channels,
        projected_monthly: projMonthly,
        rates_count: avg30?.cnt || 0,
        avg_30d_rate: avg30?.avg ? Math.round(avg30.avg) : null,
      };
    } else if (plAvailable) {
      const unlinked = await env.DB.prepare(`SELECT id, pl_listing_id, pl_listing_name, pl_platform, base_price, recommended_base_price, occupancy_next_30 FROM pricelabs_listings WHERE property_id IS NULL ORDER BY pl_listing_name`).all();
      pricelabs = {
        linked: false,
        available_listings: (unlinked.results || []).map(l => ({ id: l.id, pl_listing_id: l.pl_listing_id, name: l.pl_listing_name, platform: l.pl_platform, base_price: l.base_price, rec_base: l.recommended_base_price, occ_30d: l.occupancy_next_30 })),
      };
    }
  } catch {}

  // Monthly actuals from Guesty import
  let monthlyActuals = [];
  let seasonality = [];
  try {
    const { results: actuals } = await env.DB.prepare(`SELECT month, booked_nights, available_nights, occupancy_pct, total_revenue, avg_nightly_rate, num_reservations, cleaning_revenue, host_payout FROM monthly_actuals WHERE property_id = ? ORDER BY month`).bind(id).all();
    monthlyActuals = actuals || [];
  } catch {}
  try {
    if (property.city && property.state) {
      const { results: season } = await env.DB.prepare(`SELECT month_number, avg_occupancy, avg_adr, multiplier, sample_size FROM market_seasonality WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY month_number`).bind(property.city, property.state).all();
      seasonality = season || [];
    }
  } catch {}

  // Sibling units — if this property has a parent, fetch fellow children with their PL data
  let siblings = [];
  try {
    if (property.parent_id) {
      const { results: sibRows } = await env.DB.prepare(
        `SELECT p.id, p.unit_number, p.bedrooms, p.bathrooms, p.sqft, p.listing_status,
                pl.base_price as pl_base, pl.min_price as pl_min, pl.max_price as pl_max,
                pl.recommended_base_price as pl_rec, pl.occupancy_next_30 as pl_occ_30,
                pl.market_occupancy_next_30 as pl_mkt_occ_30, pl.group_name as pl_group,
                (SELECT AVG(total_revenue) FROM monthly_actuals WHERE property_id = p.id) as actual_monthly,
                (SELECT AVG(avg_nightly_rate) FROM monthly_actuals WHERE property_id = p.id) as actual_adr,
                (SELECT AVG(occupancy_pct) FROM monthly_actuals WHERE property_id = p.id) as actual_occ
         FROM properties p
         LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
         WHERE p.parent_id = ? AND p.id != ?
         ORDER BY p.unit_number ASC`
      ).bind(property.parent_id, id).all();
      siblings = sibRows || [];
    }
  } catch {}

  // Guesty listing data — description, photos, accommodates, property type
  let guestyListing = null;
  try {
    const gl = await env.DB.prepare(
      `SELECT listing_name, listing_description, listing_pictures_json, listing_thumbnail,
              listing_property_type, listing_bedrooms, listing_bathrooms, listing_accommodates,
              listing_address, listing_city, listing_state, listing_zip, guesty_listing_id
       FROM guesty_listings WHERE property_id = ?`
    ).bind(id).first();
    if (gl) {
      let photos = [];
      try { photos = gl.listing_pictures_json ? JSON.parse(gl.listing_pictures_json) : []; } catch {}
      if (gl.listing_thumbnail && !photos.includes(gl.listing_thumbnail)) photos.unshift(gl.listing_thumbnail);
      guestyListing = {
        name: gl.listing_name,
        description: gl.listing_description || '',
        photos: photos,
        thumbnail: gl.listing_thumbnail,
        property_type: gl.listing_property_type,
        bedrooms: gl.listing_bedrooms,
        bathrooms: gl.listing_bathrooms,
        accommodates: gl.listing_accommodates,
        address: gl.listing_address,
        guesty_listing_id: gl.guesty_listing_id,
      };
    }
  } catch {}

  return json({ property, amenities, strategies, comparables, children, parent, siblings, pricelabs, pl_available: plAvailable, monthly_actuals: monthlyActuals, seasonality, guesty_listing: guestyListing });
}

async function createProperty(request, env, uid) {
  const b = await request.json();
  try {
    const result = await env.DB.prepare(`INSERT INTO properties (user_id, name, address, city, state, zip, county, property_type, bedrooms, bathrooms, sqft, lot_acres, year_built, stories, purchase_price, estimated_value, annual_taxes, hoa_monthly, image_url, unit_number, ownership_type, monthly_mortgage, monthly_insurance, monthly_rent_cost, security_deposit, expense_electric, expense_gas, expense_water, expense_internet, expense_trash, expense_other, cleaning_fee, parent_id, latitude, longitude, is_managed, owner_name, management_fee_pct, fee_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid || null, b.name || null, b.address, b.city, b.state, b.zip || null, b.county || null, b.property_type || 'single_family', b.bedrooms || 1, b.bathrooms || 1, b.sqft || null, b.lot_acres || null, b.year_built || null, b.stories || 1, b.purchase_price || null, b.estimated_value || null, b.annual_taxes || null, b.hoa_monthly || 0, b.image_url || null, b.unit_number || null, b.ownership_type || 'purchased', b.monthly_mortgage || 0, b.monthly_insurance || 0, b.monthly_rent_cost || 0, b.security_deposit || 0, b.expense_electric || 0, b.expense_gas || 0, b.expense_water || 0, b.expense_internet || 0, b.expense_trash || 0, b.expense_other || 0, b.cleaning_fee || 0, b.parent_id || null, b.latitude || null, b.longitude || null, b.is_managed || 0, b.owner_name || null, b.management_fee_pct || null, b.fee_basis || 'gross').run();
    // Auto-add city to market watchlist
    if (b.city && b.state) {
      try {
        const tier = b.is_research ? 2 : (b.is_managed ? 2 : 1);
        const freq = tier === 1 ? 'biweekly' : 'monthly';
        await env.DB.prepare(`INSERT INTO market_watchlist (city, state, tier, frequency, auto_created, updated_at) VALUES (?,?,?,?,1,datetime('now')) ON CONFLICT(city, state) DO NOTHING`).bind(b.city, b.state, tier, freq).run();
      } catch {}
    }
    return json({ id: result.meta.last_row_id, message: 'Property created' }, 201);
  } catch (e) {
    if (e.message && e.message.includes('has no column')) {
      migrationDone = false; await ensureSchema(env);
      try {
        const result = await env.DB.prepare(`INSERT INTO properties (user_id, address, city, state, zip, property_type, bedrooms, bathrooms, sqft, lot_acres, year_built, stories, purchase_price, estimated_value, annual_taxes, hoa_monthly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid || null, b.address, b.city, b.state, b.zip || null, b.property_type || 'single_family', b.bedrooms || 1, b.bathrooms || 1, b.sqft || null, b.lot_acres || null, b.year_built || null, b.stories || 1, b.purchase_price || null, b.estimated_value || null, b.annual_taxes || null, b.hoa_monthly || 0).run();
        return json({ id: result.meta.last_row_id, message: 'Property created' }, 201);
      } catch (e2) { return json({ error: e2.message }, 500); }
    }
    return json({ error: e.message }, 500);
  }
}

async function updateProperty(id, request, env, uid) {
  const b = await request.json();
  const fields = [], values = [];
  for (const k of ['name','address','city','state','zip','property_type','bedrooms','bathrooms','sqft','lot_acres','year_built','stories','purchase_price','estimated_value','annual_taxes','hoa_monthly','listing_status','listing_url','image_url','unit_number','latitude','longitude','ownership_type','monthly_mortgage','monthly_insurance','monthly_rent_cost','security_deposit','expense_electric','expense_gas','expense_water','expense_internet','expense_trash','expense_other','cleaning_fee','cleaning_cost','service_guesty','service_lock','service_pricelabs','parent_id','parking_spaces','total_units_count','parcel_id','zoning','county','is_research','rental_type','purchase_date','loan_amount','interest_rate','loan_term_years','down_payment_pct','zestimate','zestimate_date','zillow_url','platform_listing_name','owner_name','management_fee_pct','management_base_fee','fee_basis','is_managed','rental_restrictions','hoa_name','ai_notes','tax_rate_pct','pl_customizations_json']) {
    if (b[k] !== undefined) { fields.push(`${k} = ?`); values.push(b[k]); }
  }
  if (fields.length === 0) return json({ error: 'No fields to update' }, 400);
  fields.push(`updated_at = datetime('now')`);
  if (uid) { values.push(id, uid); await env.DB.prepare(`UPDATE properties SET ${fields.join(', ')} WHERE id = ? AND (user_id = ? OR user_id IS NULL)`).bind(...values).run(); }
  else { values.push(id); await env.DB.prepare(`UPDATE properties SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run(); }
  return json({ message: 'Property updated' });
}

async function deleteProperty(id, env, uid) {
  // Verify ownership before deleting
  const prop = uid
    ? await env.DB.prepare(`SELECT id FROM properties WHERE id = ? AND (user_id = ? OR user_id IS NULL)`).bind(id, uid).first()
    : await env.DB.prepare(`SELECT id FROM properties WHERE id = ?`).bind(id).first();
  if (!prop) return json({ error: 'Property not found' }, 404);

  // Get child unit IDs (for multi-family buildings)
  const { results: children } = await env.DB.prepare(`SELECT id FROM properties WHERE parent_id = ?`).bind(id).all();
  const allIds = [parseInt(id), ...(children || []).map(c => c.id)];

  // Cascade delete all related data for this property and any child units
  for (const pid of allIds) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM comparables WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM pricing_strategies WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM property_amenities WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM analysis_reports WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM performance_snapshots WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM property_expenses WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM property_services WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM property_platforms WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM monthly_actuals WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM property_shares WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM pricelabs_listings WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM guest_stays WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM price_history WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM property_algo_overrides WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM property_images WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM guesty_calendar WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`UPDATE guesty_reservations SET property_id = NULL WHERE property_id = ?`).bind(pid),
      env.DB.prepare(`DELETE FROM channel_intelligence WHERE property_id = ?`).bind(pid),
    ]);
    // Unlink guesty listings (not in batch above)
    await env.DB.prepare(`UPDATE guesty_listings SET property_id = NULL WHERE property_id = ?`).bind(pid).run();
  }
  // Delete child units first, then parent
  if (children && children.length > 0) {
    const childStmt = env.DB.prepare(`DELETE FROM properties WHERE id = ?`);
    await env.DB.batch(children.map(c => childStmt.bind(c.id)));
  }
  await env.DB.prepare(`DELETE FROM properties WHERE id = ?`).bind(id).run();
  return json({ message: 'Property deleted', cascade_deleted: allIds.length });
}

async function addUnit(parentId, request, env, uid) {
  const parent = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(parentId).first();
  if (!parent) return json({ error: 'Parent property not found' }, 404);
  const b = await request.json();
  const unitNum = b.unit_number || 'Unit ' + (Date.now() % 1000);
  const result = await env.DB.prepare(`INSERT INTO properties (user_id, address, city, state, zip, property_type, bedrooms, bathrooms, sqft, lot_acres, year_built, stories, purchase_price, estimated_value, annual_taxes, hoa_monthly, image_url, unit_number, ownership_type, parent_id, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    uid || parent.user_id || null, parent.address, parent.city, parent.state, parent.zip, b.property_type || 'apartment',
    b.bedrooms || 1, b.bathrooms || 1, b.sqft || null, null, parent.year_built, parent.stories,
    null, null, null, null, parent.image_url, unitNum, parent.ownership_type || 'purchased',
    parseInt(parentId), parent.latitude, parent.longitude
  ).run();
  return json({ id: result.meta.last_row_id, message: 'Unit ' + unitNum + ' created' }, 201);
}

async function addUnitsBatch(parentId, request, env, uid) {
  const parent = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(parentId).first();
  if (!parent) return json({ error: 'Parent property not found' }, 404);
  const { units } = await request.json();
  if (!units || !Array.isArray(units) || units.length === 0) return json({ error: 'units array required' }, 400);
  const created = [];
  for (const u of units) {
    const unitNum = u.unit_number || 'Unit ' + (Date.now() % 10000);
    const r = await env.DB.prepare(`INSERT INTO properties (user_id, address, city, state, zip, property_type, bedrooms, bathrooms, sqft, lot_acres, year_built, stories, purchase_price, estimated_value, annual_taxes, hoa_monthly, image_url, unit_number, ownership_type, parent_id, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      uid || parent.user_id || null, parent.address, parent.city, parent.state, parent.zip,
      u.property_type || 'apartment',
      u.bedrooms || 1, u.bathrooms || 1, u.sqft || null, null,
      parent.year_built, parent.stories,
      null, null, null, null, parent.image_url, unitNum,
      parent.ownership_type || 'purchased',
      parseInt(parentId), parent.latitude, parent.longitude
    ).run();
    created.push({ id: r.meta.last_row_id, unit_number: unitNum });
  }
  return json({ message: created.length + ' units created', created }, 201);
}

async function pushBuildingToUnits(parentId, env) {
  const parent = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(parentId).first();
  if (!parent) return json({ error: 'Building not found' }, 404);
  // Shared fields that flow from building to units
  const updated = await env.DB.prepare(
    `UPDATE properties SET address = ?, city = ?, state = ?, zip = ?, latitude = ?, longitude = ?, year_built = ?, image_url = CASE WHEN image_url IS NULL OR image_url = '' THEN ? ELSE image_url END, ownership_type = ? WHERE parent_id = ?`
  ).bind(
    parent.address, parent.city, parent.state, parent.zip,
    parent.latitude, parent.longitude, parent.year_built,
    parent.image_url, parent.ownership_type || 'purchased',
    parseInt(parentId)
  ).run();
  const count = updated.meta?.changes || 0;
  return json({ message: count + ' units updated with building data', updated: count });
}

async function bulkDeleteProperties(request, env, uid) {
  const { ids } = await request.json();
  if (!ids || !Array.isArray(ids) || ids.length === 0) return json({ error: 'ids array required' }, 400);
  // Delete with ownership check - use the full cascade deleteProperty for each
  let deleted = 0;
  for (const id of ids) {
    const r = await deleteProperty(id, env, uid);
    if (r.status !== 404) deleted++;
  }
  return json({ message: `Deleted ${deleted} properties`, deleted });
}

async function bulkEditProperties(request, env, uid) {
  const { ids, updates } = await request.json();
  if (!ids || !Array.isArray(ids) || ids.length === 0) return json({ error: 'ids array required' }, 400);
  if (!updates || typeof updates !== 'object') return json({ error: 'updates object required' }, 400);
  const allowed = ['property_type', 'listing_status', 'rental_type', 'ownership_type', 'city', 'state', 'zip', 'county', 'bedrooms', 'bathrooms', 'sqft', 'lot_acres', 'year_built', 'stories', 'parking_spaces', 'purchase_price', 'estimated_value', 'annual_taxes', 'hoa_monthly', 'monthly_mortgage', 'monthly_insurance', 'monthly_rent_cost', 'cleaning_fee', 'cleaning_cost', 'algo_template_id', 'owner_name', 'management_fee_pct', 'management_base_fee', 'fee_basis', 'is_managed'];
  const setClauses = [];
  const vals = [];
  for (const [key, val] of Object.entries(updates)) {
    if (allowed.includes(key)) { setClauses.push(`${key} = ?`); vals.push(val); }
  }
  if (setClauses.length === 0) return json({ error: 'No valid fields to update' }, 400);
  const sql = `UPDATE properties SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`;
  const stmt = env.DB.prepare(sql);
  await env.DB.batch(ids.map(id => stmt.bind(...vals, id)));
  return json({ message: `Updated ${ids.length} properties`, updated: ids.length });
}

async function getAmenities(env) { const { results } = await env.DB.prepare(`SELECT * FROM amenities ORDER BY category, name`).all(); return json({ amenities: results }); }
async function getPropertyAmenities(pid, env) { const { results } = await env.DB.prepare(`SELECT a.*, pa.notes FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(pid).all(); return json({ amenities: results, amenity_ids: results.map(a => a.id) }); }
async function setPropertyAmenities(pid, request, env) {
  const { amenity_ids } = await request.json();
  await env.DB.prepare(`DELETE FROM property_amenities WHERE property_id = ?`).bind(pid).run();
  if (amenity_ids.length > 0) { const stmt = env.DB.prepare(`INSERT INTO property_amenities (property_id, amenity_id) VALUES (?, ?)`); await env.DB.batch(amenity_ids.map(a => stmt.bind(pid, a))); }
  return json({ message: `Set ${amenity_ids.length} amenities` });
}

async function getPropertyImages(pid, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM property_images WHERE property_id = ? ORDER BY sort_order, id`).bind(pid).all();
  return json({ images: results || [] });
}

async function addPropertyImage(pid, request, env) {
  const b = await request.json();
  if (!b.image_url) return json({ error: 'image_url required' }, 400);
  const maxOrder = await env.DB.prepare(`SELECT MAX(sort_order) as mx FROM property_images WHERE property_id = ?`).bind(pid).first();
  const order = (maxOrder?.mx || 0) + 1;
  const result = await env.DB.prepare(`INSERT INTO property_images (property_id, image_url, caption, sort_order, source) VALUES (?, ?, ?, ?, ?)`).bind(pid, b.image_url, b.caption || null, order, b.source || 'upload').run();
  // Auto-set as main image if property has none
  await env.DB.prepare(`UPDATE properties SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = '')`).bind(b.image_url, pid).run();
  return json({ id: result.meta.last_row_id, message: 'Image added' }, 201);
}

async function deletePropertyImage(imageId, env) {
  const img = await env.DB.prepare(`SELECT * FROM property_images WHERE id = ?`).bind(imageId).first();
  if (!img) return json({ error: 'Not found' }, 404);
  await env.DB.prepare(`DELETE FROM property_images WHERE id = ?`).bind(imageId).run();
  // If this was the main image, set next available as main
  const next = await env.DB.prepare(`SELECT image_url FROM property_images WHERE property_id = ? ORDER BY sort_order, id LIMIT 1`).bind(img.property_id).first();
  if (next) {
    await env.DB.prepare(`UPDATE properties SET image_url = ? WHERE id = ? AND image_url = ?`).bind(next.image_url, img.property_id, img.image_url).run();
  } else {
    await env.DB.prepare(`UPDATE properties SET image_url = NULL WHERE id = ? AND image_url = ?`).bind(img.property_id, img.image_url).run();
  }
  return json({ message: 'Image deleted' });
}

async function reorderPropertyImages(pid, request, env) {
  const { image_ids } = await request.json();
  if (!image_ids || !Array.isArray(image_ids)) return json({ error: 'image_ids array required' }, 400);
  const stmt = env.DB.prepare(`UPDATE property_images SET sort_order = ? WHERE id = ? AND property_id = ?`);
  await env.DB.batch(image_ids.map((id, idx) => stmt.bind(idx, id, pid)));
  // Set first image as main
  if (image_ids.length > 0) {
    const first = await env.DB.prepare(`SELECT image_url FROM property_images WHERE id = ?`).bind(image_ids[0]).first();
    if (first) await env.DB.prepare(`UPDATE properties SET image_url = ? WHERE id = ?`).bind(first.image_url, pid).run();
  }
  return json({ message: 'Images reordered' });
}

async function getComparables(pid, env, uid) { const { results } = await env.DB.prepare(`SELECT * FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC`).bind(pid).all(); return json({ comparables: results }); }
async function addComparable(request, env, uid) {
  const b = await request.json();
  const total = (b.nightly_rate || 0) + (b.cleaning_fee || 0) + (b.service_fee || 0);
  const result = await env.DB.prepare(`INSERT INTO comparables (user_id, property_id, comp_type, source, source_url, title, host_name, bedrooms, bathrooms, sleeps, property_type, nightly_rate, cleaning_fee, service_fee, total_for_one_night, rating, review_count, superhost, amenities_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid || null, b.property_id, b.comp_type || 'str', b.source, b.source_url || null, b.title || null, b.host_name || null, b.bedrooms || null, b.bathrooms || null, b.sleeps || null, b.property_type || null, b.nightly_rate, b.cleaning_fee || 0, b.service_fee || 0, total, b.rating || null, b.review_count || 0, b.superhost || 0, b.amenities_json || null).run();
  return json({ id: result.meta.last_row_id, message: 'Comparable added' }, 201);
}

async function parseListingUrl(request, env) {
  const { url } = await request.json();
  if (!url) return json({ error: 'URL required' }, 400);
  const parsed = { source: 'Other', source_url: url, title: null, bedrooms: null, bathrooms: null, sleeps: null, nightly_rate: null, cleaning_fee: null, rating: null, review_count: null, host_name: null, property_type: null };

  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    // ── Airbnb ──
    if (host.includes('airbnb')) {
      parsed.source = 'Airbnb';
      // Extract listing ID from /rooms/12345
      const roomMatch = u.pathname.match(/\/rooms\/(\d+)/);
      if (roomMatch) parsed.title = 'Airbnb #' + roomMatch[1];
      // Check-in/out dates in params
      const adults = u.searchParams.get('adults');
      if (adults) parsed.sleeps = parseInt(adults);
      // Price sometimes in params for shared links
      const price = u.searchParams.get('price_min') || u.searchParams.get('price');
      if (price) parsed.nightly_rate = parseFloat(price);
    }
    // ── VRBO ──
    else if (host.includes('vrbo') || host.includes('homeaway')) {
      parsed.source = 'VRBO';
      // /12345 or /vacation-rental/p12345
      const idMatch = u.pathname.match(/\/(?:p)?(\d{4,})/);
      if (idMatch) parsed.title = 'VRBO #' + idMatch[1];
      const minBeds = u.searchParams.get('minBedrooms');
      if (minBeds) parsed.bedrooms = parseInt(minBeds);
    }
    // ── Booking.com ──
    else if (host.includes('booking.com')) {
      parsed.source = 'Booking.com';
      // /hotel/us/listing-name.html
      const nameMatch = u.pathname.match(/\/hotel\/\w+\/(.+?)\.html/);
      if (nameMatch) parsed.title = nameMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const rooms = u.searchParams.get('no_rooms');
      if (rooms) parsed.bedrooms = parseInt(rooms);
    }
    // ── Furnished Finder ──
    else if (host.includes('furnishedfinder')) {
      parsed.source = 'Furnished Finder';
      const pathParts = u.pathname.split('/').filter(Boolean);
      if (pathParts.length > 1) parsed.title = pathParts[pathParts.length - 1].replace(/-/g, ' ');
    }
    // ── Zillow ──
    else if (host.includes('zillow')) {
      parsed.source = 'Zillow';
      const zpid = u.pathname.match(/(\d{7,})/);
      if (zpid) parsed.title = 'Zillow #' + zpid[1];
    }

    // ── Try to fetch the page and extract data with AI ──
    if (env.AI) {
      try {
        const fetchResp = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PropertyAnalyzer/1.0)', 'Accept': 'text/html' },
          redirect: 'follow'
        });
        if (fetchResp.ok) {
          let pageText = await fetchResp.text();
          // Extract just the title and meta tags to save tokens
          const titleMatch = pageText.match(/<title[^>]*>(.*?)<\/title>/i);
          const metaDesc = pageText.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i);
          const ogTitle = pageText.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']*)/i);
          const ogDesc = pageText.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']*)/i);
          // Look for JSON-LD structured data
          const jsonLd = pageText.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);

          let context = '';
          if (titleMatch) context += 'Title: ' + titleMatch[1].substring(0, 200) + '\n';
          if (ogTitle) context += 'OG Title: ' + ogTitle[1].substring(0, 200) + '\n';
          if (ogDesc) context += 'OG Desc: ' + ogDesc[1].substring(0, 300) + '\n';
          if (metaDesc) context += 'Meta: ' + metaDesc[1].substring(0, 300) + '\n';
          if (jsonLd) context += 'JSON-LD: ' + jsonLd[1].substring(0, 1000) + '\n';

          if (context.length > 20) {
            const aiPrompt = `Extract rental listing data from this page metadata. Return ONLY a JSON object with these fields (use null for unknown):\n{"title":"listing name","bedrooms":N,"bathrooms":N,"sleeps":N,"nightly_rate":N,"cleaning_fee":N,"rating":N,"review_count":N,"host_name":"name","property_type":"house/condo/apartment"}\n\nPage data:\n${context.substring(0, 1500)}`;
            const aiResult = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: aiPrompt }], max_tokens: 300 });
            if (aiResult.response) {
              try {
                const cleaned = aiResult.response.replace(/```json|```/g, '').trim();
                const aiData = JSON.parse(cleaned);
                // Merge AI data with URL-parsed data (URL data takes precedence if not null)
                if (!parsed.title && aiData.title) parsed.title = aiData.title;
                if (!parsed.bedrooms && aiData.bedrooms) parsed.bedrooms = aiData.bedrooms;
                if (!parsed.bathrooms && aiData.bathrooms) parsed.bathrooms = aiData.bathrooms;
                if (!parsed.sleeps && aiData.sleeps) parsed.sleeps = aiData.sleeps;
                if (!parsed.nightly_rate && aiData.nightly_rate) parsed.nightly_rate = aiData.nightly_rate;
                if (!parsed.cleaning_fee && aiData.cleaning_fee) parsed.cleaning_fee = aiData.cleaning_fee;
                if (!parsed.rating && aiData.rating) parsed.rating = aiData.rating;
                if (!parsed.review_count && aiData.review_count) parsed.review_count = aiData.review_count;
                if (!parsed.host_name && aiData.host_name) parsed.host_name = aiData.host_name;
                if (!parsed.property_type && aiData.property_type) parsed.property_type = aiData.property_type;
                parsed.ai_extracted = true;
              } catch {}
            }
            await trackAI(env, 'url_parse', 'workers_ai', 300, true, null);
          }
        }
      } catch (fetchErr) {
        // Page fetch failed — that's OK, we still have URL-parsed data
        parsed.fetch_error = fetchErr.message;
      }
    }
  } catch (e) {
    parsed.parse_error = e.message;
  }

  return json(parsed);
}

async function getMarketData(params, env) {
  const city = params.get ? params.get('city') : null;
  const state = params.get ? params.get('state') : null;
  const rentalType = params.get ? params.get('rental_type') : null;
  let q = `SELECT * FROM market_snapshots WHERE 1=1`, p = [];
  if (city && state) { q += ` AND LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`; p.push(city, state); }
  else if (state) { q += ` AND state = ?`; p.push(state); }
  if (rentalType) { q += ` AND rental_type = ?`; p.push(rentalType); }
  q += ` ORDER BY snapshot_date DESC LIMIT 50`;
  const { results } = await env.DB.prepare(q).bind(...p).all();
  return json({ snapshots: results });
}

async function addMarketSnapshot(request, env) {
  const b = await request.json();
  const result = await env.DB.prepare(`INSERT INTO market_snapshots (city, state, avg_daily_rate, median_daily_rate, top10_daily_rate, top25_daily_rate, bottom25_daily_rate, avg_occupancy, peak_occupancy, low_occupancy, avg_annual_revenue, peak_month, low_month, active_listings, avg_review_score, data_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(b.city, b.state, b.avg_daily_rate || null, b.median_daily_rate || null, b.top10_daily_rate || null, b.top25_daily_rate || null, b.bottom25_daily_rate || null, b.avg_occupancy || null, b.peak_occupancy || null, b.low_occupancy || null, b.avg_annual_revenue || null, b.peak_month || null, b.low_month || null, b.active_listings || null, b.avg_review_score || null, b.data_source || 'manual').run();
  return json({ id: result.meta.last_row_id, message: 'Market snapshot added' }, 201);
}

async function getTaxRates(state, county, env) {
  let q = `SELECT * FROM tax_rates WHERE 1=1`, p = [];
  if (state) { q += ` AND state = ?`; p.push(state); }
  if (county) { q += ` AND county = ?`; p.push(county); }
  const { results } = await env.DB.prepare(q).bind(...p).all();
  return json({ tax_rates: results });
}

async function fetchMarketData(request, env) {
  const body = await request.json();
  const rcKey = env.RENTCAST_API_KEY;
  // Build city list: from request body + from properties
  const citySet = new Map();
  if (body.cities && Array.isArray(body.cities)) {
    body.cities.forEach(c => { if (c.city && c.state) citySet.set(c.city + '|' + c.state, { city: c.city, state: c.state }); });
  }
  const { results: props } = await env.DB.prepare(`SELECT DISTINCT city, state, zip FROM properties`).all();
  props.forEach(p => { if (p.city && p.state) citySet.set(p.city + '|' + p.state, p); });
  const cities = Array.from(citySet.values());
  if (cities.length === 0) return json({ error: 'No cities to fetch. Add properties or cities first.' }, 400);

  const fetched = [];
  let rcStatus = null;
  if (rcKey) {
    for (const p of cities) {
      const params = new URLSearchParams({ city: p.city, state: p.state });
      if (p.zip) params.set('zipCode', p.zip);
      const rc = await rentCastFetch('https://api.rentcast.io/v1/markets?' + params.toString(), rcKey, env, 'markets', p.city, p.state);
      rcStatus = { used: rc.used, limit: rc.limit };
      if (rc.limited) {
        fetched.push({ city: p.city, state: p.state, status: 'limit', detail: rc.error });
        break;
      } else if (rc.ok) {
        const data = rc.data;
        if (data && (data.medianRent || data.averageRent || data.saleToListRatio)) {
          await env.DB.prepare(`INSERT INTO market_snapshots (city, state, avg_daily_rate, median_daily_rate, avg_occupancy, active_listings, data_source) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(p.city, p.state, data.averageRent || null, data.medianRent || null, null, data.totalListings || null, 'RentCast API').run();
          fetched.push({ city: p.city, state: p.state, status: 'ok', detail: 'Median rent: $' + (data.medianRent || 0) });
        } else {
          fetched.push({ city: p.city, state: p.state, status: 'skip', detail: 'No data from RentCast' });
        }
      } else {
        fetched.push({ city: p.city, state: p.state, status: 'fail', detail: rc.error || 'API error' });
      }
    }
  } else {
    fetched.push({ city: 'all', status: 'skip', detail: 'No RENTCAST_API_KEY — add with: wrangler secret put RENTCAST_API_KEY' });
  }

  // ── Web fallback for cities that failed or hit limits ──
  if (env.SEARCHAPI_KEY) {
    const failedCities = cities.filter(c => !fetched.some(f => f.city === c.city && f.state === c.state && f.status === 'ok'));
    for (const c of failedCities.slice(0, 3)) {
      try {
        await trackApiCall(env, 'searchapi', 'market_fallback', true);
        const q = c.city + ' ' + c.state + ' average rent median rent 2024 2025';
        const resp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({ engine: 'google', q }).toString(), {
          headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
        });
        if (resp.ok) {
          const data = await resp.json();
          let avgRent = null, medRent = null, listings = null;
          const text = ((data.answer_box?.snippet || '') + ' ' + (data.organic_results || []).slice(0, 4).map(r => r.snippet || '').join(' ')).toLowerCase();
          // Parse rent numbers
          const rentMatches = text.match(/\$\s*([\d,]+)\s*(?:\/month|\/mo|per month|median rent|average rent)/gi) || [];
          for (const m of rentMatches) {
            const v = parseInt(m.replace(/[^0-9]/g, ''));
            if (v > 500 && v < 10000) {
              if (!medRent) medRent = v;
              else if (!avgRent) avgRent = v;
            }
          }
          if (medRent || avgRent) {
            await env.DB.prepare(`INSERT INTO market_snapshots (city, state, avg_daily_rate, median_daily_rate, data_source) VALUES (?, ?, ?, ?, ?)`).bind(c.city, c.state, avgRent, medRent, 'Web scrape').run();
            fetched.push({ city: c.city, state: c.state, status: 'ok', detail: 'Web: median ~$' + (medRent || avgRent) + '/mo', source: 'web' });
          }
        }
      } catch {}
    }
  }

  // AI market analysis
  let ai_analysis = null;
  if (body.use_ai && env.AI) {
    try {
      const { results: snaps } = await env.DB.prepare(`SELECT city, state, avg_daily_rate, median_daily_rate, avg_occupancy, active_listings FROM market_snapshots ORDER BY snapshot_date DESC LIMIT 20`).all();
      if (snaps.length > 0) {
        const marketSummary = snaps.map(s => s.city + ', ' + s.state + ': avg $' + (s.avg_daily_rate || '?') + ', median $' + (s.median_daily_rate || '?') + ', ' + (s.active_listings || '?') + ' listings').join('; ');
        const aiPrompt = 'You are a real estate market analyst. Analyze this market data and provide 3-4 sentences of actionable insights. Compare the markets, note which have the best rental yields, and flag any concerns.\n\nMARKET DATA:\n' + marketSummary;
        const aiResult = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: aiPrompt }], max_tokens: 400 });
        ai_analysis = aiResult.response || null;
        await trackAI(env, 'market_fetch', 'workers_ai', 400, true, null);
      }
    } catch (e) { await trackAI(env, 'market_fetch', 'workers_ai', 0, false, e.message); }
  }

  return json({ fetched, ai_analysis, rc_usage: rcStatus, message: 'Fetched data for ' + fetched.filter(f => f.status === 'ok').length + '/' + cities.length + ' cities' });
}

async function marketSearch(request, env) {
  const body = await request.json();
  const { city, state, rental_type, bedrooms, bathrooms, property_type, max_price, radius_miles, use_ai } = body;
  if (!city || !state) return json({ error: 'city and state required' }, 400);
  const isLTR = rental_type === 'ltr';
  const beds = bedrooms || null;
  const baths = bathrooms || null;
  const results = { sources: [], data: null, search_links: [], ai_analysis: null };

  // ── Generate search URLs for all platforms ──
  const cityEnc = encodeURIComponent(city + ', ' + state);
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  const stateSlug = state.toLowerCase();
  const bedParam = beds || 2;

  if (isLTR) {
    results.search_links = [
      { name: 'Zillow Rentals', icon: 'home', url: 'https://www.zillow.com/' + citySlug + '-' + stateSlug + '/rentals/' + (beds ? beds + '-_beds/' : '') },
      { name: 'Apartments.com', icon: 'building', url: 'https://www.apartments.com/' + citySlug + '-' + stateSlug + '/' + (beds ? beds + '-bedrooms/' : '') },
      { name: 'Realtor.com', icon: 'clipboard', url: 'https://www.realtor.com/apartments/' + citySlug + '_' + stateSlug + (beds ? '/beds-' + beds : '') },
      { name: 'Rent.com', icon: 'key', url: 'https://www.rent.com/search?location=' + cityEnc + (beds ? '&beds=' + beds : '') },
      { name: 'Redfin Rentals', icon: 'pieChart', url: 'https://www.redfin.com/city/' + citySlug + '-' + stateSlug + '/apartments-for-rent' + (beds ? '/filter/beds=' + beds : '') },
      { name: 'Trulia Rentals', icon: 'home', url: 'https://www.trulia.com/for_rent/' + citySlug + ',' + stateSlug + '/' + (beds ? beds + 'p_beds/' : '') },
      { name: 'HotPads', icon: 'mapPin', url: 'https://hotpads.com/' + citySlug + '-' + stateSlug + '/apartments-for-rent' + (beds ? '?beds=' + beds : '') },
      { name: 'Furnished Finder', icon: 'home', url: 'https://www.furnishedfinder.com/housing/' + city.replace(/\s+/g, '-') + '-' + state },
    ];
  } else {
    results.search_links = [
      { name: 'Airbnb', icon: 'home', url: 'https://www.airbnb.com/s/' + cityEnc + '/homes?adults=2' + (beds ? '&min_bedrooms=' + beds : '') + '&tab_id=home_tab' },
      { name: 'VRBO', icon: 'home', url: 'https://www.vrbo.com/search?destination=' + cityEnc + (beds ? '&minBedrooms=' + beds : '') },
      { name: 'Booking.com', icon: 'globe', url: 'https://www.booking.com/searchresults.html?ss=' + cityEnc + '&no_rooms=1&nflt=ht_id%3D220' },
      { name: 'AirDNA', icon: 'trendUp', url: 'https://www.airdna.co/vacation-rental-data/app/us/' + stateSlug + '/' + citySlug + '/overview' },
      { name: 'Furnished Finder', icon: 'home', url: 'https://www.furnishedfinder.com/housing/' + city.replace(/\s+/g, '-') + '-' + state },
      { name: 'AllTheRooms', icon: 'map', url: 'https://www.alltherooms.com/analytics/vacation-rental-data/' + citySlug + '-' + stateSlug },
      { name: 'Mashvisor', icon: 'trendUp', url: 'https://www.mashvisor.com/market/' + stateSlug + '/' + citySlug },
      { name: 'Rabbu', icon: 'search', url: 'https://www.rabbu.com/market/' + stateSlug + '/' + citySlug },
    ];
  }

  // ── RentCast: DISABLED for market search to conserve API calls ──
  // Use cached market snapshots instead. RentCast is reserved for property lookups only.
  // Market data can be refreshed via the dedicated "Refresh Market Data" button.
  {
    // Check for cached data first
    const cached = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC LIMIT 1`).bind(city, state).first();
    if (cached) {
      results.data = {
        avg_rate: cached.avg_daily_rate || null,
        median_rate: cached.median_daily_rate || null,
        active_listings: cached.active_listings || null,
        source: cached.data_source + ' (cached ' + (cached.snapshot_date || '').substring(0, 10) + ')',
      };
      results.sources.push({ name: 'Cached Market Data', status: 'ok', detail: 'From ' + (cached.snapshot_date || 'previous fetch') + '. Use "Refresh Market Data" button for fresh data.' });
    } else {
      results.sources.push({ name: 'Market Data', status: 'skip', detail: 'No cached data. Use "Refresh Market Data" button to pull from RentCast.' });
    }
    if (env.RENTCAST_API_KEY) {
      try { results.rc_usage = { used: (await getRcUsageThisMonth(env)), limit: (await getRcLimit(env)) }; } catch {}
    }
  }

  // ── Load historical snapshots for context ──
  const { results: histSnaps } = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND rental_type = ? ORDER BY snapshot_date DESC LIMIT 20`).bind(city, state, isLTR ? 'ltr' : 'str').all();
  results.history = histSnaps;

  // ── AI Analysis ──
  if (use_ai && env.AI) {
    try {
      const snapContext = histSnaps.slice(0, 5).map(s => 'Date:' + s.snapshot_date + ' ADR:$' + (s.avg_daily_rate || '?') + ' Median:$' + (s.median_daily_rate || '?') + ' Listings:' + (s.active_listings || '?')).join('; ');
      const listingContext = (results.listings || []).slice(0, 8).map(l => l.address + ' ' + (l.bedrooms || '?') + 'BR $' + (l.price || '?')).join('; ');
      const prompt = isLTR
        ? `You are an expert long-term rental market analyst. Analyze ${city}, ${state} for ${beds || 'all'}-bedroom ${property_type || ''} rentals.

MARKET DATA: ${snapContext || 'Limited data'}
ACTIVE LISTINGS: ${listingContext || 'None fetched'}
FILTERS: ${beds ? beds + ' beds' : 'All beds'}, ${baths ? baths + ' baths' : 'All baths'}, ${max_price ? 'Max $' + max_price : 'No price cap'}

Provide a comprehensive 5-7 sentence analysis covering:
- Fair monthly rent range for this configuration
- Supply/demand dynamics and vacancy rates
- Best neighborhoods or areas within ${city}
- Rental yield potential and investor considerations
- How this market compares regionally
Be specific with dollar amounts and percentages.`
        : `You are an expert short-term vacation rental market analyst. Analyze ${city}, ${state} for ${beds || 'all'}-bedroom STR properties.

MARKET DATA: ${snapContext || 'Limited data'}
REFERENCE RENTS: ${results.data ? 'Avg $' + results.data.avg_rate + ', Median $' + results.data.median_rate : 'No data'}

Provide a comprehensive 5-7 sentence analysis covering:
- Estimated nightly rate range for ${beds || 'typical'}-bedroom STR
- Occupancy rate expectations by season
- Peak vs off-peak pricing strategy
- Revenue potential (monthly/annual projections)
- Top platforms for this market (Airbnb vs VRBO vs Booking.com performance)
- Key amenities that drive bookings in ${city}
- Competition level and market saturation
Be specific with dollar amounts and percentages.`;
      const aiResult = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 800 });
      results.ai_analysis = aiResult.response || null;
      if (results.ai_analysis) {
        await env.DB.prepare(`INSERT INTO market_insights (city, state, insight_type, analysis) VALUES (?, ?, ?, ?)`).bind(city, state, isLTR ? 'ltr_search' : 'str_search', results.ai_analysis).run();
        await trackAI(env, 'market_search', 'workers_ai', 800, true, null);
        results.sources.push({ name: 'AI Analysis', status: 'ok' });
      }
    } catch (e) { results.sources.push({ name: 'AI', status: 'fail', detail: e.message }); }
  }

  results.message = 'Market search complete for ' + city + ', ' + state + ' (' + (isLTR ? 'LTR' : 'STR') + ')';
  return json(results);
}

async function fetchComparables(request, env, uid) {
  const { property_id, comp_type, use_ai } = await request.json();
  if (!property_id) return json({ error: 'property_id required' }, 400);
  const prop = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(property_id).first();
  if (!prop) return json({ error: 'Property not found' }, 404);
  const isLTR = comp_type === 'ltr';
  const comps = [];
  const sources = [];
  const searchLinks = [];
  const beds = prop.bedrooms || 2;
  const baths = prop.bathrooms || 1;
  const cityEnc = encodeURIComponent(prop.city + ', ' + prop.state);
  const citySlug = (prop.city || '').toLowerCase().replace(/\s+/g, '-');
  const stateSlug = (prop.state || '').toLowerCase();

  // ── Search links: platform-specific deep links ──
  if (isLTR) {
    searchLinks.push({ name: 'Zillow Rentals', icon: 'home', url: 'https://www.zillow.com/' + citySlug + '-' + stateSlug + '/rentals/' + beds + '-_beds/' });
    searchLinks.push({ name: 'Apartments.com', icon: 'building', url: 'https://www.apartments.com/' + citySlug + '-' + stateSlug + '/' + beds + '-bedrooms/' });
    searchLinks.push({ name: 'Realtor.com', icon: 'clipboard', url: 'https://www.realtor.com/apartments/' + citySlug + '_' + stateSlug });
    searchLinks.push({ name: 'Rent.com', icon: 'key', url: 'https://www.rent.com/search/' + cityEnc });
    searchLinks.push({ name: 'Redfin', icon: 'pieChart', url: 'https://www.redfin.com/city/' + citySlug + '-' + stateSlug + '/apartments-for-rent' });
    searchLinks.push({ name: 'HotPads', icon: 'mapPin', url: 'https://hotpads.com/' + citySlug + '-' + stateSlug + '/apartments-for-rent?beds=' + beds });
  } else {
    searchLinks.push({ name: 'Airbnb', icon: 'home', url: 'https://www.airbnb.com/s/' + cityEnc + '/homes?adults=2&min_bedrooms=' + beds + '&tab_id=home_tab' });
    searchLinks.push({ name: 'VRBO', icon: 'home', url: 'https://www.vrbo.com/search?destination=' + cityEnc + '&minBedrooms=' + beds });
    searchLinks.push({ name: 'Booking.com', icon: 'globe', url: 'https://www.booking.com/searchresults.html?ss=' + cityEnc + '&no_rooms=1&nflt=ht_id%3D220' });
    searchLinks.push({ name: 'Furnished Finder', icon: 'home', url: 'https://www.furnishedfinder.com/housing/' + (prop.city || '').replace(/\s+/g, '-') + '-' + prop.state });
    searchLinks.push({ name: 'AirDNA', icon: 'trendUp', url: 'https://www.airdna.co/vacation-rental-data/app/us/' + stateSlug + '/' + citySlug + '/overview' });
    searchLinks.push({ name: 'Mashvisor', icon: 'trendUp', url: 'https://www.mashvisor.com/market/' + stateSlug + '/' + citySlug });
  }

  // ── RentCast: ONLY for LTR mode ──
  if (isLTR && env.RENTCAST_API_KEY) {
    const rcEndpoint = 'https://api.rentcast.io/v1/listings/rental/long-term';
    const params = new URLSearchParams({ city: prop.city, state: prop.state, limit: '15', status: 'Active', bedrooms: beds });
    if (prop.zip) params.set('zipCode', prop.zip);
    const rc = await rentCastFetch(rcEndpoint + '?' + params.toString(), env.RENTCAST_API_KEY, env, 'comps_fetch', prop.city, prop.state);
    if (rc.limited) {
      sources.push({ name: 'RentCast', status: 'limit', detail: rc.error });
    } else if (rc.ok) {
      const items = Array.isArray(rc.data) ? rc.data : [];
      for (const l of items.slice(0, 12)) {
        comps.push({
          property_id, comp_type: 'ltr', source: 'RentCast', source_url: l.listingUrl || null,
          title: l.formattedAddress || l.addressLine1 || 'Listing',
          host_name: null, bedrooms: l.bedrooms || null, bathrooms: l.bathrooms || null,
          sleeps: null, property_type: l.propertyType || null, nightly_rate: l.price || 0,
          cleaning_fee: 0, service_fee: 0, total_for_one_night: l.price || 0,
          rating: null, review_count: 0, superhost: 0, amenities_json: null,
        });
        // Also save to master listings DB
        try { await upsertMasterListing(env, {
          platform: 'rentcast', listing_type: 'ltr',
          listing_url: l.listingUrl || null,
          title: l.formattedAddress || l.addressLine1 || 'Listing',
          city: prop.city, state: prop.state, zip: l.zipCode || prop.zip || null,
          address: l.formattedAddress || null,
          bedrooms: l.bedrooms || null, bathrooms: l.bathrooms || null,
          property_type: l.propertyType || null, monthly_rate: l.price || null,
          latitude: l.latitude || null, longitude: l.longitude || null,
          sqft: l.squareFootage || null,
        }, uid); } catch {}
      }
      sources.push({ name: 'RentCast', status: 'ok', count: items.length });
    } else {
      sources.push({ name: 'RentCast', status: 'fail', detail: rc.error || 'API error' });
    }
  }

  // ── LTR: Generate estimated rent range (high/low) from comps or regional data ──
  if (isLTR) {
    const ltrPrices = comps.filter(c => c.comp_type === 'ltr' && c.nightly_rate > 0).map(c => c.nightly_rate);
    let estBase = 0;
    let estSource = '';

    if (ltrPrices.length >= 2) {
      const sorted = ltrPrices.slice().sort((a, b) => a - b);
      estBase = sorted[Math.floor(sorted.length / 2)];
      estSource = ltrPrices.length + ' RentCast comps (median $' + estBase + '/mo)';
    } else {
      // Use regional estimates
      const tier = getStateTier(prop.state);
      const tierRents = {
        premium: { 0: 1800, 1: 2400, 2: 3200, 3: 4200, 4: 5500, 5: 7000, 6: 8500 },
        high:    { 0: 1400, 1: 1900, 2: 2500, 3: 3300, 4: 4300, 5: 5500, 6: 6500 },
        mid:     { 0: 1100, 1: 1500, 2: 2000, 3: 2600, 4: 3400, 5: 4200, 6: 5000 },
        low:     { 0: 850,  1: 1100, 2: 1500, 3: 1900, 4: 2500, 5: 3100, 6: 3800 },
      };
      estBase = (tierRents[tier] || tierRents.mid)[Math.min(beds, 6)] || 2000;
      estSource = 'Regional estimate (' + tier + ' tier, ' + prop.state + ')';
    }

    // Property adjustments
    const sqftAdj = prop.sqft > 2500 ? 1.12 : prop.sqft > 1800 ? 1.05 : prop.sqft > 1200 ? 1.0 : prop.sqft > 800 ? 0.95 : 0.88;
    const typeAdj = { single_family: 1.15, condo: 0.95, apartment: 0.88, townhouse: 1.0 }[prop.property_type] || 1.0;
    const bathBonus = baths > beds ? 1.05 : baths >= beds ? 1.0 : 0.95;
    const adjusted = Math.round(estBase * sqftAdj * typeAdj * bathBonus);

    comps.push({
      property_id, comp_type: 'ltr', source: 'Estimate (Low)',
      source_url: null, title: prop.city + ' ' + beds + 'BR Rent Estimate (low)',
      host_name: null, bedrooms: beds, bathrooms: baths, sleeps: null,
      property_type: prop.property_type, nightly_rate: Math.round(adjusted * 0.85),
      cleaning_fee: 0, service_fee: 0, total_for_one_night: Math.round(adjusted * 0.85),
      rating: null, review_count: 0, superhost: 0, amenities_json: null,
    });
    comps.push({
      property_id, comp_type: 'ltr', source: 'Estimate (Market)',
      source_url: null, title: prop.city + ' ' + beds + 'BR Rent Estimate (market)',
      host_name: null, bedrooms: beds, bathrooms: baths, sleeps: null,
      property_type: prop.property_type, nightly_rate: adjusted,
      cleaning_fee: 0, service_fee: 0, total_for_one_night: adjusted,
      rating: null, review_count: 0, superhost: 0, amenities_json: null,
    });
    comps.push({
      property_id, comp_type: 'ltr', source: 'Estimate (High)',
      source_url: null, title: prop.city + ' ' + beds + 'BR Rent Estimate (high)',
      host_name: null, bedrooms: beds, bathrooms: baths, sleeps: null,
      property_type: prop.property_type, nightly_rate: Math.round(adjusted * 1.15),
      cleaning_fee: 0, service_fee: 0, total_for_one_night: Math.round(adjusted * 1.15),
      rating: null, review_count: 0, superhost: 0, amenities_json: null,
    });
    sources.push({ name: 'LTR Estimates', status: 'ok', detail: estSource + ' → Low $' + Math.round(adjusted * 0.85) + ' / Market $' + adjusted + ' / High $' + Math.round(adjusted * 1.15) + '/mo' });
    sources.push({ name: 'Other Platforms', status: 'info', detail: 'Zillow, Apartments.com, Realtor.com, Rent.com, Redfin, HotPads — use search links below to compare and add comps' });
  }

  // ── STR mode: Real Airbnb data via SearchAPI.io + LTR-derived estimates ──
  if (!isLTR) {
    // ── SearchAPI.io: Real Airbnb listings ──
    if (env.SEARCHAPI_KEY) {
      try {
        // Set check-in 2 weeks out, 3-night stay
        const cin = new Date(Date.now() + 14 * 86400000);
        const cout = new Date(cin.getTime() + 3 * 86400000);
        const cinStr = cin.toISOString().split('T')[0];
        const coutStr = cout.toISOString().split('T')[0];
        const searchQ = prop.city + ', ' + prop.state;
        const saParams = new URLSearchParams({
          engine: 'airbnb', q: searchQ,
          check_in_date: cinStr, check_out_date: coutStr,
          adults: '2', min_bedrooms: beds,
        });
        await trackApiCall(env, 'searchapi', 'crawl_airbnb', true);
        const saResp = await fetch('https://www.searchapi.io/api/v1/search?' + saParams.toString(), {
          headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY, 'Accept': 'application/json' }
        });
        if (saResp.ok) {
          const saData = await saResp.json();
          const listings = saData.properties || saData.results || [];
          let added = 0;
          for (const l of listings.slice(0, 15)) {
            // Extract nightly rate from various price formats
            let nightlyRate = 0;
            let cleaningFee = 0;
            if (l.price) {
              if (l.price.extracted_price) nightlyRate = l.price.extracted_price;
              else if (l.price.total_price) {
                const m = String(l.price.total_price).match(/[\d,]+/);
                if (m) nightlyRate = Math.round(parseFloat(m[0].replace(/,/g, '')) / 3); // 3 night stay
              }
              if (l.price.price_details) {
                const cleanItem = (l.price.price_details || []).find(d => d.label && d.label.toLowerCase().includes('clean'));
                if (cleanItem && cleanItem.amount) cleaningFee = Math.abs(cleanItem.amount);
              }
            }
            if (l.pricing) {
              nightlyRate = l.pricing.nightly_rate || l.pricing.rate || nightlyRate;
            }
            // Fallback: try extracted_total_price / nights
            if (!nightlyRate && l.price && l.price.extracted_total_price) {
              nightlyRate = Math.round(l.price.extracted_total_price / 3);
            }
            if (nightlyRate <= 0) continue;

            const lBeds = l.beds || l.bedroom_count || l.bedrooms || null;
            // Filter: only keep if beds roughly match (within ±1)
            if (lBeds && beds && Math.abs(lBeds - beds) > 1) continue;

            comps.push({
              property_id, comp_type: 'str', source: 'Airbnb',
              source_url: l.link || l.listing_url || l.url || ('https://www.airbnb.com/rooms/' + l.id),
              title: (l.title || l.name || 'Airbnb listing').substring(0, 100),
              host_name: l.host_name || (l.host ? l.host.name : null) || null,
              bedrooms: lBeds, bathrooms: l.bathrooms || l.bathroom_count || null,
              sleeps: l.guest_capacity || l.guests || null,
              property_type: l.property_type || l.room_type || null,
              nightly_rate: Math.round(nightlyRate),
              cleaning_fee: Math.round(cleaningFee),
              service_fee: 0,
              total_for_one_night: Math.round(nightlyRate + cleaningFee),
              rating: l.rating || l.overall_rating || null,
              review_count: l.reviews || l.review_count || 0,
              superhost: (l.is_superhost || l.superhost) ? 1 : 0,
              amenities_json: null,
            });
            // Also save to master listings DB
            try { await upsertMasterListing(env, {
              platform: 'airbnb', listing_type: 'str', platform_id: l.id || null,
              listing_url: l.link || l.listing_url || (l.id ? 'https://www.airbnb.com/rooms/' + l.id : null),
              title: l.title || l.name, city: prop.city, state: prop.state,
              bedrooms: lBeds, bathrooms: l.bathrooms || l.bathroom_count || null,
              sleeps: l.guest_capacity || l.guests || null, property_type: l.property_type || l.room_type || null,
              nightly_rate: Math.round(nightlyRate), cleaning_fee: Math.round(cleaningFee),
              rating: l.rating || l.overall_rating || null, review_count: l.reviews || l.review_count || 0,
              superhost: (l.is_superhost || l.superhost) ? 1 : 0,
              raw_data: JSON.stringify(l).substring(0, 2000),
            }, uid); } catch {}
            added++;
            if (added >= 12) break;
          }
          if (added > 0) {
            sources.push({ name: 'Airbnb (via SearchAPI)', status: 'ok', count: added, detail: added + ' real Airbnb listings with nightly rates' });
          } else {
            sources.push({ name: 'Airbnb (via SearchAPI)', status: 'ok', detail: 'Search returned ' + listings.length + ' results but none matched ' + beds + 'BR filter' });
          }
        } else {
          const errText = await saResp.text().catch(() => '');
          sources.push({ name: 'SearchAPI', status: 'fail', detail: 'HTTP ' + saResp.status + ': ' + errText.substring(0, 100) });
        }
      } catch (e) {
        sources.push({ name: 'SearchAPI', status: 'fail', detail: e.message });
      }
    }

    // Use cached market data or regional estimates for LTR reference — no live RentCast call
    let ltrReference = [];
    try {
      // Check for existing comps or cached market data
      const cached = await env.DB.prepare(`SELECT median_daily_rate FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC LIMIT 1`).bind(prop.city, prop.state).first();
      if (cached && cached.median_daily_rate) ltrReference = [cached.median_daily_rate];
    } catch {}
    const ltrMedian = ltrReference.length > 0 ? ltrReference.sort((a, b) => a - b)[Math.floor(ltrReference.length / 2)] : 0;
    const strMult = getSTRMultiplier(prop.state, prop.city, prop.property_type);

    // Generate STR estimates from LTR data or regional baselines
    let estBase = 0;
    if (ltrMedian > 0) {
      estBase = Math.round((ltrMedian / 30) * strMult);
      sources.push({ name: 'LTR Reference', status: 'ok', detail: ltrReference.length + ' area rents (median $' + ltrMedian + '/mo) → ~$' + estBase + '/nt STR equivalent (' + strMult.toFixed(1) + 'x multiplier)' });
    } else {
      const tier = getStateTier(prop.state);
      const tierRents = { premium: { 0:1800,1:2400,2:3200,3:4200,4:5500,5:7000,6:8500 }, high: { 0:1400,1:1900,2:2500,3:3300,4:4300,5:5500,6:6500 }, mid: { 0:1100,1:1500,2:2000,3:2600,4:3400,5:4200,6:5000 }, low: { 0:850,1:1100,2:1500,3:1900,4:2500,5:3100,6:3800 } };
      const baseRent = (tierRents[tier] || tierRents.mid)[Math.min(beds, 6)] || 2000;
      estBase = Math.round((baseRent / 30) * strMult);
    }

    // Property adjustments
    const sqftAdj = prop.sqft > 2500 ? 1.12 : prop.sqft > 1800 ? 1.05 : prop.sqft > 1200 ? 1.0 : prop.sqft > 800 ? 0.95 : 0.88;
    const typeAdj = { single_family: 1.15, condo: 0.95, apartment: 0.88, townhouse: 1.0, glamping: 1.25, studio: 0.75 }[prop.property_type] || 1.0;
    const bathBonus = baths > beds ? 1.05 : baths >= beds ? 1.0 : 0.95;
    const adjNightly = Math.round(estBase * sqftAdj * typeAdj * bathBonus);
    const cleanFee = Math.round(Math.max(75, (prop.sqft || 1200) * 0.06));

    // Low / Market / High estimates
    comps.push({
      property_id, comp_type: 'str', source: 'Estimate (Low)',
      source_url: null, title: prop.city + ' ' + beds + 'BR STR (low range)',
      host_name: null, bedrooms: beds, bathrooms: baths, sleeps: beds * 2,
      property_type: prop.property_type, nightly_rate: Math.round(adjNightly * 0.80),
      cleaning_fee: Math.round(cleanFee * 0.8), service_fee: 0, total_for_one_night: Math.round(adjNightly * 0.80),
      rating: null, review_count: 0, superhost: 0, amenities_json: null,
    });
    comps.push({
      property_id, comp_type: 'str', source: 'Estimate (Market)',
      source_url: null, title: prop.city + ' ' + beds + 'BR STR (market rate)',
      host_name: null, bedrooms: beds, bathrooms: baths, sleeps: beds * 2,
      property_type: prop.property_type, nightly_rate: adjNightly,
      cleaning_fee: cleanFee, service_fee: 0, total_for_one_night: adjNightly,
      rating: null, review_count: 0, superhost: 0, amenities_json: null,
    });
    comps.push({
      property_id, comp_type: 'str', source: 'Estimate (High)',
      source_url: null, title: prop.city + ' ' + beds + 'BR STR (premium)',
      host_name: null, bedrooms: beds, bathrooms: baths, sleeps: beds * 2 + 2,
      property_type: prop.property_type, nightly_rate: Math.round(adjNightly * 1.25),
      cleaning_fee: Math.round(cleanFee * 1.2), service_fee: 0, total_for_one_night: Math.round(adjNightly * 1.25),
      rating: null, review_count: 0, superhost: 0, amenities_json: null,
    });
    sources.push({ name: 'STR Estimates', status: 'ok', detail: 'Low $' + Math.round(adjNightly * 0.80) + ' / Market $' + adjNightly + ' / High $' + Math.round(adjNightly * 1.25) + '/nt' });
    sources.push({ name: 'Platforms', status: 'info', detail: 'Add real comps from Airbnb, VRBO, Booking.com using search links or paste a listing URL' });
  }

  // ── Load existing comps from DB ──
  const existingQ = isLTR
    ? `SELECT * FROM comparables WHERE property_id = ? AND (comp_type = 'ltr' OR comp_type IS NULL) ORDER BY scraped_at DESC`
    : `SELECT * FROM comparables WHERE property_id = ? AND comp_type = 'str' ORDER BY scraped_at DESC`;
  const { results: existingComps } = await env.DB.prepare(existingQ).bind(property_id).all();

  // ── Pull from master listings DB (shared intel data) ──
  try {
    const mlType = isLTR ? 'ltr' : 'str';
    const { results: mlComps } = await env.DB.prepare(
      `SELECT * FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND listing_type = ? AND status = 'active' ORDER BY last_updated DESC LIMIT 20`
    ).bind(prop.city, prop.state, mlType).all();
    if (mlComps.length > 0) {
      let mlAdded = 0;
      for (const ml of mlComps) {
        // Don't duplicate — check if URL already in comps or existing
        const rate = isLTR ? (ml.monthly_rate || ml.nightly_rate) : (ml.nightly_rate || 0);
        if (rate <= 0) continue;
        const alreadyHave = comps.some(c => c.source_url && ml.listing_url && c.source_url === ml.listing_url)
          || existingComps.some(c => c.source_url && ml.listing_url && c.source_url === ml.listing_url);
        if (alreadyHave) continue;
        // Match bedrooms within ±1
        if (ml.bedrooms && beds && Math.abs(ml.bedrooms - beds) > 1) continue;
        comps.push({
          property_id, comp_type: mlType,
          source: (ml.platform || 'intel').charAt(0).toUpperCase() + (ml.platform || 'intel').slice(1),
          source_url: ml.listing_url || null,
          title: (ml.title || 'Listing').substring(0, 100),
          host_name: ml.host_name || null,
          bedrooms: ml.bedrooms, bathrooms: ml.bathrooms,
          sleeps: ml.sleeps, property_type: ml.property_type,
          nightly_rate: rate,
          cleaning_fee: ml.cleaning_fee || 0, service_fee: ml.service_fee || 0,
          total_for_one_night: rate + (ml.cleaning_fee || 0),
          rating: ml.rating, review_count: ml.review_count || 0,
          superhost: ml.superhost || 0, amenities_json: null,
          from_master: true, // flag to avoid re-saving to comparables
        });
        mlAdded++;
        if (mlAdded >= 12) break;
      }
      if (mlAdded > 0) {
        sources.push({ name: 'Intel DB', status: 'ok', count: mlAdded, detail: mlAdded + ' listings from master database (' + mlComps.length + ' available for ' + prop.city + ')' });
      }
    }
  } catch {}

  // ── AI analysis ──
  if (use_ai && env.AI) {
    try {
      const allComps = comps.length > 0 ? comps : existingComps;
      const relevantComps = isLTR
        ? allComps.filter(c => !c.comp_type || c.comp_type === 'ltr')
        : allComps.filter(c => c.comp_type === 'str');
      const compContext = relevantComps.length > 0
        ? relevantComps.slice(0, 8).map(c => (c.title || 'Listing') + ' ' + (c.bedrooms || '?') + 'BR $' + (c.nightly_rate || 0) + (isLTR ? '/mo' : '/nt') + (c.rating ? ' ' + c.rating + '★' : '') + ' [' + (c.source || '') + ']').join('; ')
        : 'No comparable data yet';
      const aiPrompt = isLTR
        ? `You are a long-term rental market analyst. Analyze LTR comps near ${prop.address}, ${prop.city}, ${prop.state} (${beds}BR/${baths}BA, ${prop.sqft || '?'}sqft):\n${compContext}\n\nWhat is the fair monthly rent range? Brief 2-3 sentence analysis.`
        : `You are a short-term vacation rental pricing expert for ${prop.city}, ${prop.state}. This is a ${beds}BR/${baths}BA ${(prop.property_type || 'property').replace('_', ' ')} (${prop.sqft || '?'}sqft).

${compContext !== 'No comparable data yet' ? 'Reference data:\n' + compContext : ''}

Based on your knowledge of the ${prop.city}, ${prop.state} vacation rental market:
1. What nightly rate range should a ${beds}BR STR target on Airbnb/VRBO?
2. What occupancy rate is realistic?
3. What are the peak vs low season rates?
4. What key amenities drive bookings here?

Be specific with dollar amounts. Brief 3-4 sentences.`;
      const aiResult = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: aiPrompt }], max_tokens: 500 });
      if (aiResult.response) {
        sources.push({ name: 'AI Analysis', status: 'ok', detail: aiResult.response });
        await trackAI(env, 'comp_analysis', 'workers_ai', 500, true, null);
      }
    } catch (e) { sources.push({ name: 'AI Analysis', status: 'skip', detail: e.message }); }
  }

  // ── Save NEW comps to DB (only matching type, skip intel-sourced) ──
  // First, delete old estimate comps for this property to prevent duplicates on refresh
  const compTypeFilter = isLTR ? 'ltr' : 'str';
  await env.DB.prepare(`DELETE FROM comparables WHERE property_id = ? AND comp_type = ? AND source LIKE 'Estimate%'`).bind(property_id, compTypeFilter).run();

  for (const comp of comps) {
    if (comp.from_master) continue; // Already in master_listings, don't duplicate
    // Skip if this exact comp already exists (by source_url or source+title match)
    if (comp.source_url) {
      const exists = existingComps.some(e => e.source_url === comp.source_url);
      if (exists) continue;
    } else if (comp.title && !comp.source.startsWith('Estimate')) {
      const exists = existingComps.some(e => e.source === comp.source && e.title === comp.title);
      if (exists) continue;
    }
    await env.DB.prepare(`INSERT INTO comparables (user_id, property_id, comp_type, source, source_url, title, host_name, bedrooms, bathrooms, sleeps, property_type, nightly_rate, cleaning_fee, service_fee, total_for_one_night, rating, review_count, superhost, amenities_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid || null, comp.property_id, comp.comp_type || (isLTR ? 'ltr' : 'str'), comp.source, comp.source_url, comp.title, comp.host_name, comp.bedrooms, comp.bathrooms, comp.sleeps, comp.property_type, comp.nightly_rate, comp.cleaning_fee, comp.service_fee, comp.total_for_one_night, comp.rating, comp.review_count, comp.superhost, comp.amenities_json).run();
  }

  // ── Response — return comps matching requested type ──
  const responseComps = comps.filter(c => isLTR ? c.comp_type === 'ltr' : c.comp_type === 'str');
  const msgParts = [];
  if (isLTR) {
    const rcCount = comps.filter(c => c.source === 'RentCast').length;
    if (rcCount > 0) msgParts.push(rcCount + ' LTR comps from RentCast');
    msgParts.push('Low/Market/High estimates generated');
    if (existingComps.length > 0) msgParts.push(existingComps.length + ' existing LTR comps');
  } else {
    const estCount = comps.filter(c => c.comp_type === 'str').length;
    if (estCount > 0) msgParts.push('Low/Market/High STR estimates generated');
    if (existingComps.length > 0) msgParts.push(existingComps.length + ' STR comps from platforms');
    msgParts.push('Add real comps from Airbnb/VRBO using links or paste URL');
  }

  return json({ comps: responseComps, existing_count: existingComps.length, sources, searchLinks, comp_type, message: msgParts.join(' · ') || 'Use the search links below to find comps' });
}

// Helper: get an API key from env var OR app_settings DB
async function checkApiKeyStatus(env) {
  const keyNames = ['RENTCAST_API_KEY', 'GOOGLE_PLACES_API_KEY', 'SEARCHAPI_KEY', 'PRICELABS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GUESTY_CLIENT_ID', 'GUESTY_CLIENT_SECRET'];
  const keys = {};
  const sources = {};
  for (const k of keyNames) {
    // DB is source of truth — check it first. If deleted from DB, key is gone even if wrangler secret exists.
    try {
      const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('apikey_' + k).first();
      if (row?.value) {
        keys[k] = true;
        sources[k] = 'db';
        continue;
      }
    } catch {}
    // No DB entry — fall back to wrangler secret
    if (env[k]) {
      keys[k] = true;
      sources[k] = 'env';
    } else {
      keys[k] = false;
      sources[k] = null;
    }
  }
  keys.WORKERS_AI = !!env.AI;
  sources.WORKERS_AI = env.AI ? 'env' : null;
  return json({ keys, sources });
}

async function saveApiKey(request, env) {
  const { key, value } = await request.json();
  const allowed = ['RENTCAST_API_KEY', 'GOOGLE_PLACES_API_KEY', 'SEARCHAPI_KEY', 'PRICELABS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GUESTY_CLIENT_ID', 'GUESTY_CLIENT_SECRET'];
  if (!allowed.includes(key)) return json({ error: 'Invalid key name' }, 400);
  if (!value || !value.trim()) {
    await env.DB.prepare(`DELETE FROM app_settings WHERE key = ?`).bind('apikey_' + key).run();
    // Also null it out of env so subsequent code in this request sees it gone
    // eslint-disable-next-line no-param-reassign
    env[key] = null;
    return json({ message: key + ' removed' });
  }
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`)
    .bind('apikey_' + key, value.trim(), value.trim()).run();
  return json({ message: key + ' saved' });
}

async function getAiStatus(env) {
  const status = {
    workers_ai: { available: !!env.AI, provider: 'Cloudflare Workers AI', model: '@cf/meta/llama-3.1-70b-instruct', cost: 'Free (included with Workers)' },
    anthropic: { available: !!env.ANTHROPIC_API_KEY, provider: 'Anthropic', model: 'claude-sonnet-4-5', cost: 'Per-token billing' },  // env already hydrated from DB at request start
    openai: { available: !!env.OPENAI_API_KEY, provider: 'OpenAI', model: 'gpt-4o-mini', cost: 'Per-token billing' },
  };
  let usage = { total: 0, today: 0, last7d: 0, by_endpoint: {}, by_provider: {}, recent: [], errors: 0 };
  try {
    const total = await env.DB.prepare(`SELECT COUNT(*) as c FROM ai_usage`).first();
    usage.total = total?.c || 0;
    const today = await env.DB.prepare(`SELECT COUNT(*) as c FROM ai_usage WHERE created_at >= date('now')`).first();
    usage.today = today?.c || 0;
    const week = await env.DB.prepare(`SELECT COUNT(*) as c FROM ai_usage WHERE created_at >= date('now', '-7 days')`).first();
    usage.last7d = week?.c || 0;
    const errs = await env.DB.prepare(`SELECT COUNT(*) as c FROM ai_usage WHERE success = 0`).first();
    usage.errors = errs?.c || 0;
    const byEp = await env.DB.prepare(`SELECT endpoint, COUNT(*) as c FROM ai_usage GROUP BY endpoint ORDER BY c DESC LIMIT 10`).all();
    (byEp.results || []).forEach(r => { usage.by_endpoint[r.endpoint] = r.c; });
    const byProv = await env.DB.prepare(`SELECT provider, COUNT(*) as c, SUM(tokens_approx) as tokens FROM ai_usage GROUP BY provider`).all();
    (byProv.results || []).forEach(r => { usage.by_provider[r.provider] = { calls: r.c, tokens: r.tokens || 0 }; });
    const recent = await env.DB.prepare(`SELECT * FROM ai_usage ORDER BY created_at DESC LIMIT 10`).all();
    usage.recent = recent.results || [];
  } catch { /* table may not exist yet */ }
  return json({ status, usage });
}

async function getRentCastUsage(env) {
  const limit = await getRcLimit(env);
  const used = await getRcUsageThisMonth(env);
  // Get reset date (1st of next month)
  const now = new Date();
  const resetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const daysLeft = Math.ceil((resetDate - now) / (1000 * 60 * 60 * 24));
  // Get usage by endpoint
  let byEndpoint = {};
  try {
    const { results } = await env.DB.prepare(`SELECT endpoint, COUNT(*) as c FROM rc_usage WHERE created_at >= date('now', 'start of month') GROUP BY endpoint ORDER BY c DESC`).all();
    (results || []).forEach(r => { byEndpoint[r.endpoint] = r.c; });
  } catch {}
  // Get daily breakdown
  let daily = [];
  try {
    const { results } = await env.DB.prepare(`SELECT date(created_at) as d, COUNT(*) as c FROM rc_usage WHERE created_at >= date('now', 'start of month') GROUP BY d ORDER BY d ASC`).all();
    daily = results || [];
  } catch {}
  // Recent calls
  let recent = [];
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM rc_usage ORDER BY created_at DESC LIMIT 15`).all();
    recent = results || [];
  } catch {}
  return json({
    used, limit, remaining: Math.max(0, limit - used),
    reset_date: resetDate.toISOString().substring(0, 10),
    days_until_reset: daysLeft,
    overage_cost_per_call: 0.01,
    by_endpoint: byEndpoint,
    daily,
    recent
  });
}

async function setRentCastConfig(request, env) {
  const { monthly_limit } = await request.json();
  if (monthly_limit === undefined || monthly_limit < 0) return json({ error: 'Invalid monthly_limit' }, 400);
  try {
    await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('rc_monthly_limit', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(String(monthly_limit), String(monthly_limit)).run();
  } catch {
    // Fallback if ON CONFLICT not supported
    await env.DB.prepare(`DELETE FROM app_settings WHERE key = 'rc_monthly_limit'`).run();
    await env.DB.prepare(`INSERT INTO app_settings (key, value) VALUES ('rc_monthly_limit', ?)`).bind(String(monthly_limit)).run();
  }
  return json({ message: 'Limit set to ' + monthly_limit, monthly_limit });
}

// ═══════════════════════════════════════════════════════════════════════════
// Marketing Content Management (Admin-only)
// ═══════════════════════════════════════════════════════════════════════════

async function getMarketingContent(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM marketing_content ORDER BY section, sort_order, id`).all();
  // Group by section
  const grouped = {};
  for (const r of (results || [])) {
    if (!grouped[r.section]) grouped[r.section] = [];
    grouped[r.section].push(r);
  }
  return json({ content: grouped, total: (results || []).length });
}

async function saveMarketingContent(request, env) {
  const { section, content_key, content_value, sort_order, is_active } = await request.json();
  if (!section || !content_key) return json({ error: 'section and content_key required' }, 400);
  await env.DB.prepare(
    `INSERT INTO marketing_content (section, content_key, content_value, sort_order, is_active, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now')) ON CONFLICT(section, content_key) DO UPDATE SET content_value = ?, sort_order = ?, is_active = ?, updated_at = datetime('now')`
  ).bind(section, content_key, content_value || '', sort_order || 0, is_active !== undefined ? is_active : 1, content_value || '', sort_order || 0, is_active !== undefined ? is_active : 1).run();
  return json({ ok: true });
}

async function seedMarketingContent(env) {
  const seeds = [
    // ── Brand ──
    ['brand', 'product_name', 'FCP-PMR', 0],
    ['brand', 'tagline', 'Your entire rental business in one dashboard.', 1],
    ['brand', 'tagline_sub', 'AI-powered property intelligence. Self-hosted. Under $10/month.', 2],
    ['brand', 'description', 'FCP-PMR is a property management and rental analysis platform that combines AI-powered pricing, market intelligence, guest analytics, and financial tracking into a single self-hosted dashboard. Built for STR/LTR investors and small property managers who are tired of juggling five different tools.', 3],
    // ── Hero ──
    ['hero', 'headline', 'Stop Juggling 5 Tools. Start Running Your Rentals.', 0],
    ['hero', 'subheadline', 'AI pricing strategies, live market intelligence, guest analytics, PMS integration, and portfolio finances — all in one place, self-hosted on Cloudflare for under $10/month.', 1],
    ['hero', 'cta_primary', 'Get Started Free', 2],
    ['hero', 'cta_secondary', 'See Features', 3],
    // ── Features ──
    ['features', 'ai_pricing', JSON.stringify({ title: 'AI-Powered Pricing', description: 'Get pricing strategies from Claude or GPT-4o based on your actual data — comps, seasonality, occupancy, and expenses. Not generic market averages.', icon: 'dollarSign', color: '#10b981' }), 0],
    ['features', 'market_intel', JSON.stringify({ title: 'Market Intelligence', description: 'Live market profiles with demographics, tourism data, competitor crawls, and trend analysis. Know your market before your competitors do.', icon: 'globe', color: '#6366f1' }), 1],
    ['features', 'pms_integration', JSON.stringify({ title: 'PMS Integration', description: 'Syncs with Guesty and PriceLabs automatically. Reservations, calendar, rates, and guest data flow in — no manual entry.', icon: 'link', color: '#f59e0b' }), 2],
    ['features', 'portfolio_finance', JSON.stringify({ title: 'Portfolio Finances', description: 'Track revenue, expenses, P&L, and owner statements across your entire portfolio. Every number is verifiable from source data.', icon: 'wallet', color: '#ef4444' }), 3],
    ['features', 'listing_health', JSON.stringify({ title: 'Listing Health Score', description: 'Photo count, description quality, amenity coverage, review scores, and platform presence — scored and compared against AI recommendations.', icon: 'star', color: '#8b5cf6' }), 4],
    ['features', 'guest_intel', JSON.stringify({ title: 'Guest Intelligence', description: 'Returning guests, booking patterns, channel attribution, pet tracking, stay duration analysis. Know who books and why.', icon: 'radar', color: '#06b6d4' }), 5],
    ['features', 'acquisition', JSON.stringify({ title: 'Acquisition Analysis', description: 'ROI projections, cap rate calculations, and cash flow analysis for potential purchases. AI-generated investment memos.', icon: 'trendUp', color: '#ec4899' }), 6],
    ['features', 'algo_health', JSON.stringify({ title: 'Algorithm Health', description: 'Monitor how PriceLabs dynamic pricing aligns with your strategy. Track ADR vs market, occupancy gaps, and pricing drift.', icon: 'layers', color: '#14b8a6' }), 7],
    // ── Stats (live from app) ──
    ['stats', 'api_routes', '164+', 0],
    ['stats', 'api_routes_label', 'API Endpoints', 0],
    ['stats', 'db_tables', '36', 1],
    ['stats', 'db_tables_label', 'Data Tables', 1],
    ['stats', 'ai_models', '3', 2],
    ['stats', 'ai_models_label', 'AI Providers', 2],
    ['stats', 'integrations', '6', 3],
    ['stats', 'integrations_label', 'Integrations', 3],
    // ── Pricing Tiers ──
    ['pricing', 'self_hosted', JSON.stringify({ name: 'Self-Hosted', price: '$5', period: '/month', description: 'Deploy on your own Cloudflare account. Full control, full privacy.', features: ['Unlimited properties', 'All AI features (bring your own keys)', 'Guesty + PriceLabs integration', 'Automatic daily data sync', 'Market intelligence & crawling', 'Owner statements & P&L', 'Listing health scoring', 'Custom domain'], highlight: true }), 0],
    ['pricing', 'managed', JSON.stringify({ name: 'Managed', price: '$29', period: '/month', description: 'We host and maintain it for you. Just log in and go.', features: ['Everything in Self-Hosted', 'We handle deployment & updates', 'Pre-configured AI (included)', 'Priority support', 'Automatic backups', 'Custom onboarding'] }), 1],
    ['pricing', 'enterprise', JSON.stringify({ name: 'Enterprise', price: 'Custom', period: '', description: 'Multi-team, white-label, or custom integrations.', features: ['Everything in Managed', 'Multi-user access control', 'Custom PMS integrations', 'White-label option', 'API access', 'Dedicated support'] }), 2],
    // ── Differentiators ──
    ['differentiators', 'vs_airdna', JSON.stringify({ competitor: 'AirDNA', their_price: '$300+/mo', their_limitation: 'Read-only analytics. No pricing tools, no PMS integration, no portfolio finance.', our_advantage: 'Full pricing + operations + intelligence + finance in one tool.' }), 0],
    ['differentiators', 'vs_pricelabs', JSON.stringify({ competitor: 'PriceLabs', their_price: '$20+/listing/mo', their_limitation: 'Dynamic pricing only. No market intelligence, no guest analytics, no financial tracking.', our_advantage: 'PriceLabs integration + AI strategy layer + full portfolio dashboard.' }), 1],
    ['differentiators', 'vs_guesty', JSON.stringify({ competitor: 'Guesty', their_price: '$25+/listing/mo', their_limitation: 'PMS only. Basic analytics. No AI pricing, no acquisition analysis.', our_advantage: 'Guesty as data source + AI-powered intelligence layer on top.' }), 2],
    ['differentiators', 'vs_spreadsheets', JSON.stringify({ competitor: 'Spreadsheets', their_price: 'Free but hours/week', their_limitation: 'Manual data entry. No automation. No AI. Breaks as portfolio grows.', our_advantage: 'Automated everything. AI analysis on demand. Scales from 1 to 50 properties.' }), 3],
    // ── Target Audiences ──
    ['audiences', 'str_investor', JSON.stringify({ title: 'STR Investors', description: 'You own 1-10 short-term rentals and want to maximize revenue without paying $300/mo for analytics.', pain: 'Juggling Airbnb, PriceLabs, spreadsheets, and Guesty with no unified view.', solution: 'One dashboard with AI pricing, market intel, and financial tracking.' }), 0],
    ['audiences', 'ltr_investor', JSON.stringify({ title: 'LTR Investors', description: 'You own multi-family or long-term rentals and need portfolio-level financial tracking and market analysis.', pain: 'No good tool for tracking P&L across a mixed portfolio of STR + LTR.', solution: 'Portfolio finances, comp analysis, and acquisition modeling in one place.' }), 1],
    ['audiences', 'small_pm', JSON.stringify({ title: 'Small Property Managers', description: 'You manage 5-50 properties for owners and need owner statements, managed property tracking, and operational intelligence.', pain: 'Owner reporting is manual. No way to show owners market data or optimization recommendations.', solution: 'Managed property support, owner statements, listing health scores, and AI recommendations.' }), 2],
    ['audiences', 'agent', JSON.stringify({ title: 'Real Estate Agents', description: 'You advise clients on rental investment properties and need data to back up your recommendations.', pain: 'No tool gives you STR revenue projections, market comps, and acquisition analysis together.', solution: 'Research mode with acquisition analysis, market intelligence, and AI investment memos.' }), 3],
    // ── Social media snippets ──
    ['social', 'twitter_1', 'Built an entire property management analytics platform on Cloudflare Workers for $5/month. AI pricing, market intelligence, guest analytics, portfolio finance. 164 API endpoints. One file.', 0],
    ['social', 'twitter_2', 'AirDNA: $300/mo for read-only analytics.\nPriceLabs: $20/listing/mo for pricing.\nGuesty: $25/listing/mo for PMS.\n\nOr: $5/mo for all of it, self-hosted, with AI. We built FCP-PMR.', 1],
    ['social', 'twitter_3', 'Your rental property doesn\'t need 5 subscriptions. It needs one dashboard. AI-powered pricing strategies, live market data, guest intelligence, and portfolio finances — all in one place.', 2],
    ['social', 'linkedin_1', 'After managing our own rental portfolio, we built the tool we wished existed. FCP-PMR combines AI pricing analysis, market intelligence, PMS integration, and portfolio finances into a single self-hosted dashboard.\n\nNo $300/month analytics subscriptions. No juggling 5 different platforms. Just one dashboard that actually tells you what to do and why.\n\nBuilt on Cloudflare Workers. Under $10/month to run. Open to early access users.', 0],
  ];

  let count = 0;
  // Use batch() to insert all seeds in a single D1 round-trip (avoids CPU/subrequest limits)
  // ON CONFLICT DO NOTHING — only adds NEW items, never overwrites customized content
  const batchStmts = seeds.map(([section, key, value, order]) => {
    count++;
    return env.DB.prepare(`INSERT INTO marketing_content (section, content_key, content_value, sort_order, is_active, updated_at) VALUES (?, ?, ?, ?, 1, datetime('now')) ON CONFLICT(section, content_key) DO NOTHING`)
      .bind(section, key, value, order);
  });
  await env.DB.batch(batchStmts);
  return json({ message: 'Seeded ' + count + ' marketing content items (existing items preserved)', count });
}

async function getMarketingStats(env) {
  // Pull live stats from the app for marketing use
  const routes = 164; // from grep count
  const tables = await env.DB.prepare(`SELECT COUNT(*) as c FROM sqlite_master WHERE type='table'`).first();
  const properties = await env.DB.prepare(`SELECT COUNT(*) as c FROM properties`).first();
  const reservations = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations`).first();
  const strategies = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricing_strategies`).first();
  const reports = await env.DB.prepare(`SELECT COUNT(*) as c FROM analysis_reports`).first();
  const comps = await env.DB.prepare(`SELECT COUNT(*) as c FROM comparables`).first();
  const marketProfiles = await env.DB.prepare(`SELECT COUNT(DISTINCT city || state) as c FROM market_snapshots`).first();
  return json({
    routes,
    tables: tables?.c || 0,
    properties: properties?.c || 0,
    reservations: reservations?.c || 0,
    strategies: strategies?.c || 0,
    reports: reports?.c || 0,
    comps: comps?.c || 0,
    market_profiles: marketProfiles?.c || 0,
    ai_providers: 3,
    integrations: 6
  });
}

async function generateMarketingContent(request, env) {
  const { section, instructions } = await request.json();
  // Get current marketing content for context
  const { results: existing } = await env.DB.prepare(`SELECT * FROM marketing_content ORDER BY section, sort_order`).all();
  const stats = await (await getMarketingStats(env)).json();

  const currentContent = {};
  const lockedKeys = new Set();
  for (const r of (existing || [])) {
    if (!currentContent[r.section]) currentContent[r.section] = {};
    currentContent[r.section][r.content_key] = r.content_value;
    if (r.is_locked) lockedKeys.add(r.section + ':' + r.content_key);
  }

  const lockedList = lockedKeys.size > 0 ? `\n\nLOCKED ITEMS (do NOT update these — they are finalized):\n${[...lockedKeys].join(', ')}` : '';

  const prompt = `You are a marketing copywriter for a SaaS product called FCP-PMR — a self-hosted property management and rental analysis platform.

CURRENT MARKETING CONTENT:
${JSON.stringify(currentContent, null, 2)}
${lockedList}

LIVE APP STATS:
${JSON.stringify(stats, null, 2)}

PRODUCT FACTS:
- Self-hosted on Cloudflare Workers ($5/month infrastructure)
- D1 SQLite database, R2 storage
- 164+ API endpoints, ${stats.tables} database tables
- AI-powered: Claude (Anthropic), GPT-4o (OpenAI), Workers AI (free)
- Integrations: Guesty PMS, PriceLabs, RentCast, SearchAPI, Google Places
- Features: AI pricing strategies, market intelligence, listing health scoring, guest analytics, portfolio finances, acquisition analysis, algorithm health monitoring
- Target: Individual rental investors, small property managers, real estate agents
- Differentiator: One tool replaces AirDNA ($300/mo) + PriceLabs ($20/listing) + spreadsheets
- Open to managing 1-50 properties

${section ? `FOCUS: Update the "${section}" section specifically.` : 'Review ALL sections.'}
${instructions ? `SPECIFIC INSTRUCTIONS: ${instructions}` : ''}

Return a JSON object where keys are "section:content_key" and values are the updated content strings. Only include items that should be changed. For feature/pricing/differentiator/audience items, return the full JSON string.

IMPORTANT: Be specific, compelling, and avoid generic marketing fluff. Use concrete numbers and real differentiators. The tone should be confident and direct — like a founder who built something they're proud of.`;

  const result = await callAIWithFallback(env, 'marketing_generate', prompt, 4000, 4000);
  if (!result.text) return json({ error: 'AI generation failed: ' + (result.error || 'No provider available or all failed') }, 500);

  // Parse and apply updates
  let updates;
  try {
    const cleaned = result.text.replace(/```json\n?|```/g, '').trim();
    updates = JSON.parse(cleaned);
  } catch (e) {
    return json({ raw_response: result.text, error: 'Could not parse AI response as JSON: ' + e.message }, 400);
  }

  let applied = 0;
  let skipped = 0;
  const batchStmts = [];
  for (const [compositeKey, value] of Object.entries(updates)) {
    const [sec, ...keyParts] = compositeKey.split(':');
    const key = keyParts.join(':');
    if (sec && key) {
      if (lockedKeys.has(sec + ':' + key)) { skipped++; continue; }
      batchStmts.push(env.DB.prepare(
        `INSERT INTO marketing_content (section, content_key, content_value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(section, content_key) DO UPDATE SET content_value = CASE WHEN is_locked = 1 THEN content_value ELSE ? END, updated_at = datetime('now')`
      ).bind(sec, key, String(value), String(value)));
      applied++;
    }
  }
  if (batchStmts.length > 0) await env.DB.batch(batchStmts);
  return json({ message: 'AI updated ' + applied + ' items' + (skipped > 0 ? ' (' + skipped + ' locked items skipped)' : ''), applied, skipped, provider: result.provider, updates });
}

async function exportLandingPage(env) {
  const { results } = await env.DB.prepare(`SELECT * FROM marketing_content WHERE is_active = 1 ORDER BY section, sort_order`).all();
  const content = {};
  for (const r of (results || [])) {
    if (!content[r.section]) content[r.section] = {};
    content[r.section][r.content_key] = r.content_value;
  }

  // Parse JSON values
  const features = Object.entries(content.features || {}).map(([k, v]) => { try { return JSON.parse(v); } catch { return { title: k, description: v }; } });
  const pricing = Object.entries(content.pricing || {}).map(([k, v]) => { try { return JSON.parse(v); } catch { return { name: k }; } });
  const differentiators = Object.entries(content.differentiators || {}).map(([k, v]) => { try { return JSON.parse(v); } catch { return { competitor: k }; } });
  const audiences = Object.entries(content.audiences || {}).map(([k, v]) => { try { return JSON.parse(v); } catch { return { title: k }; } });
  const brand = content.brand || {};
  const hero = content.hero || {};
  const social = content.social || {};

  return json({ brand, hero, features, pricing, differentiators, audiences, social, _export_date: new Date().toISOString() });
}

async function marketDeepDive(request, env) {
  const { city, state } = await request.json();
  if (!city || !state) return json({ error: 'city and state required' }, 400);

  // Get all snapshots for this city
  const { results: snaps } = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC`).bind(city, state).all();
  // Get properties in this city
  const { results: props } = await env.DB.prepare(`SELECT * FROM properties WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`).bind(city, state).all();
  // Get comps for properties in this city
  let compCount = 0;
  for (const p of props) {
    const cc = await env.DB.prepare(`SELECT COUNT(*) as c FROM comparables WHERE property_id = ?`).bind(p.id).first();
    compCount += cc?.c || 0;
  }

  // Run AI deep analysis
  let analysis = null;
  if (env.AI) {
    try {
      const snapStr = snaps.slice(0, 5).map(s => 'Date:' + (s.snapshot_date || '?') + ' ADR:$' + (s.avg_daily_rate || '?') + ' Median:$' + (s.median_daily_rate || '?') + ' Occ:' + (s.avg_occupancy || '?') + ' Listings:' + (s.active_listings || '?')).join('\n');
      const propStr = props.map(p => p.address + ' ' + p.bedrooms + 'BR/' + p.bathrooms + 'BA $' + (p.purchase_price || p.estimated_value || '?')).join('; ');
      const prevInsights = await env.DB.prepare(`SELECT analysis, created_at FROM market_insights WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY created_at DESC LIMIT 3`).bind(city, state).all();
      const prevStr = (prevInsights.results || []).map(pi => '[' + pi.created_at + '] ' + pi.analysis.substring(0, 200)).join('\n');

      const prompt = `You are an expert real estate market analyst specializing in short-term and long-term rental markets. Provide a comprehensive market analysis for ${city}, ${state}.

MARKET DATA HISTORY:
${snapStr || 'No historical data yet'}

PROPERTIES IN THIS MARKET (${props.length}):
${propStr || 'None'}

COMPARABLES FOUND: ${compCount}

${prevStr ? 'PREVIOUS ANALYSES (build on these, note changes/trends):\n' + prevStr : ''}

Provide a detailed analysis covering:
1. Market health and trajectory (is this market growing, stable, or declining?)
2. Supply vs demand dynamics
3. Rate optimization opportunities (are current rates optimal?)
4. Seasonal patterns and how to exploit them
5. Competitive positioning advice for these properties
6. Risk factors to monitor
7. Specific actionable recommendations

Be specific with numbers and percentages where possible. If previous analyses exist, note what has changed.`;

      const aiResult = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 1500 });
      analysis = aiResult.response || null;
      if (analysis) {
        await env.DB.prepare(`INSERT INTO market_insights (city, state, insight_type, analysis) VALUES (?, ?, 'deep_dive', ?)`).bind(city, state, analysis).run();
        await trackAI(env, 'market_deep_dive', 'workers_ai', 1500, true, null);
      }
    } catch (e) {
      await trackAI(env, 'market_deep_dive', 'workers_ai', 0, false, e.message);
    }
  }

  // Get all saved insights
  const { results: insights } = await env.DB.prepare(`SELECT * FROM market_insights WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY created_at DESC LIMIT 10`).bind(city, state).all();

  return json({ city, state, snapshots: snaps, properties: props, comp_count: compCount, analysis, insights });
}

async function getMarketInsights(city, state, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM market_insights WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY created_at DESC LIMIT 20`).bind(city, state).all();
  return json({ insights: results });
}
async function analyzePricing(propertyId, request, env) {
  const body = await request.json();
  const analysisType = body.analysis_type || 'str';
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);
  const { results: amenities } = await env.DB.prepare(`SELECT a.* FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(propertyId).all();
  const { results: marketData } = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC LIMIT 1`).bind(property.city, property.state).all();
  let { results: comparables } = await env.DB.prepare(`SELECT * FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC`).bind(propertyId).all();
  // Tax rate: per-property override > state-level table > null
  let taxRate = await env.DB.prepare(`SELECT * FROM tax_rates WHERE LOWER(state) = LOWER(?) LIMIT 1`).bind(property.state).first();
  if (property.tax_rate_pct > 0) {
    taxRate = taxRate || {};
    taxRate.total_rate = property.tax_rate_pct;
    taxRate.source = 'property_override';
  }
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ?`).bind(propertyId).all();

  // PriceLabs data
  let plData = null;
  const plLink = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();
  if (plLink) {
    let channels = [];
    try { channels = plLink.channel_details ? JSON.parse(plLink.channel_details) : []; } catch {}
    plData = {
      base_price: plLink.base_price, min_price: plLink.min_price, max_price: plLink.max_price,
      recommended_base: plLink.recommended_base_price, cleaning_fees: plLink.cleaning_fees,
      group: plLink.group_name, pms: plLink.pl_pms,
      occ_7d: plLink.occupancy_next_7, mkt_occ_7d: plLink.market_occupancy_next_7,
      occ_30d: plLink.occupancy_next_30, mkt_occ_30d: plLink.market_occupancy_next_30,
      occ_60d: plLink.occupancy_next_60, mkt_occ_60d: plLink.market_occupancy_next_60,
      push_enabled: plLink.push_enabled, last_pushed: plLink.last_date_pushed,
      channels,
    };
  }

  // Actual avg stay length from Guesty (for cleaning turnover calc)
  let guestyAvgStay = 0;
  try {
    const stayAvg = await env.DB.prepare(
      `SELECT AVG(avg_stay_length) as avg FROM monthly_actuals WHERE property_id = ? AND avg_stay_length > 0`
    ).bind(propertyId).first();
    guestyAvgStay = stayAvg?.avg || 0;
  } catch {}

  // Seasonality data for this market
  let seasonData = [];
  try {
    const { results: s } = await env.DB.prepare(`SELECT month_number, multiplier, avg_occupancy, avg_adr FROM market_seasonality WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY month_number`).bind(property.city, property.state).all();
    seasonData = s || [];
  } catch {}

  // Actual revenue history
  let actualsData = [];
  try {
    const { results: a } = await env.DB.prepare(`SELECT month, total_revenue, occupancy_pct, avg_nightly_rate FROM monthly_actuals WHERE property_id = ? ORDER BY month`).bind(propertyId).all();
    actualsData = a || [];
  } catch {}

  let autoFetchMsg = null;
  if (comparables.length === 0) autoFetchMsg = 'No comps found. Run an Intel Crawl for this property to pull comparables.';

  const sources = [];
  sources.push({ name: 'Market Data', status: marketData.length > 0 ? 'ok' : 'none' });
  sources.push({ name: 'Comparables', status: comparables.length > 0 ? comparables.length + ' found' : 'none' });
  sources.push({ name: 'PriceLabs', status: plData ? 'linked' : 'not linked' });
  sources.push({ name: 'Amenities', status: amenities.length > 0 ? amenities.length + ' tracked' : 'none' });
  sources.push({ name: 'Seasonality', status: seasonData.length > 0 ? seasonData.length + ' months' : 'none' });
  sources.push({ name: 'Guesty Actuals', status: actualsData.length > 0 ? actualsData.length + ' months' : 'none' });

  const all = [];

  // STR strategies
  let aiError = null;
  if (analysisType === 'str' || analysisType === 'both') {
    // Inject actual avg stay into seasonData so algorithmic strategies can use it
  if (guestyAvgStay > 0 && seasonData.length > 0) { seasonData[0].avg_stay_length = guestyAvgStay; }
  else if (guestyAvgStay > 0) { seasonData = [{ avg_stay_length: guestyAvgStay }]; }
  const strStrategies = generateAlgorithmicStrategies(property, amenities, marketData[0] || null, comparables, taxRate, plData, seasonData);
    all.push(...strStrategies);
    if (body.use_ai) {
      const qualityPref = body.quality || 'best'; // 'best' or 'economy'
      const aiProv = await pickAIProvider(env, 'pricing_analysis', qualityPref);
      if (!aiProv) {
        aiError = 'No AI provider available. Add an API key in Admin → API Keys or enable Workers AI.';
      } else {
        const aiS = await generateAIStrategy(property, amenities, marketData[0], comparables, taxRate, aiProv, 'str', env, plData, platforms);
        if (aiS && !aiS.__ai_error) { aiS.ai_provider = aiProv; all.push(aiS); }
        else {
          aiError = 'AI call failed (' + aiProv + '): ' + (aiS?.__ai_error || 'empty response');
          // Auto-fallback to Workers AI if paid provider failed
          if (aiProv !== 'workers_ai' && env.AI) {
            const aiSFb = await generateAIStrategy(property, amenities, marketData[0], comparables, taxRate, 'workers_ai', 'str', env, plData, platforms);
            if (aiSFb && !aiSFb.__ai_error) { aiSFb.ai_provider = 'workers_ai'; all.push(aiSFb); aiError = aiError + ' — fell back to Workers AI (Llama).'; }
          }
        }
      }
    }
  }

  // LTR strategies
  if (analysisType === 'ltr' || analysisType === 'both') {
    const ltrStrategies = generateLTRStrategies(property, amenities, marketData[0] || null, taxRate, comparables);
    all.push(...ltrStrategies);
    if (body.use_ai) {
      const qualityPref2 = body.quality || 'best';
      const aiProv2 = await pickAIProvider(env, 'pricing_analysis', qualityPref2);
      if (aiProv2) {
        const aiL = await generateAIStrategy(property, amenities, marketData[0], comparables, taxRate, aiProv2, 'ltr', env, plData, platforms);
        if (aiL && !aiL.__ai_error) { aiL.ai_provider = aiProv2; all.push(aiL); }
        else {
          if (!aiError) aiError = 'AI call failed (' + aiProv2 + '): ' + (aiL?.__ai_error || 'empty response');
          if (aiProv2 !== 'workers_ai' && env.AI) {
            const aiLFb = await generateAIStrategy(property, amenities, marketData[0], comparables, taxRate, 'workers_ai', 'ltr', env, plData, platforms);
            if (aiLFb && !aiLFb.__ai_error) { aiLFb.ai_provider = 'workers_ai'; all.push(aiLFb); aiError = aiError + ' — fell back to Workers AI (Llama).'; }
          }
        }
      }
    }
  }

  // Tag each strategy with rental_type so finance can filter STR vs LTR cleanly
  for (const s of all) {
    if (!s.rental_type) {
      s.rental_type = (s.min_nights >= 365 || (s.strategy_name || '').toUpperCase().includes('LTR')) ? 'ltr' : 'str';
    }
  }

  // Ensure ai_provider column exists (migration guard for existing deployments)
  try { await env.DB.prepare(`ALTER TABLE pricing_strategies ADD COLUMN ai_provider TEXT`).run(); } catch {}
  const stmt = env.DB.prepare(`INSERT INTO pricing_strategies (property_id, strategy_name, base_nightly_rate, weekend_rate, cleaning_fee, pet_fee, weekly_discount, monthly_discount, peak_season_markup, low_season_discount, min_nights, projected_occupancy, projected_annual_revenue, projected_monthly_avg, reasoning, ai_generated, rental_type, ai_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  await env.DB.batch(all.map(s => stmt.bind(propertyId, s.strategy_name, s.base_nightly_rate, s.weekend_rate || 0, s.cleaning_fee || 0, s.pet_fee || 0, s.weekly_discount || 0, s.monthly_discount || 0, s.peak_season_markup || 0, s.low_season_discount || 0, s.min_nights || 1, s.projected_occupancy, s.projected_annual_revenue, s.projected_monthly_avg, s.reasoning, s.ai_generated ? 1 : 0, s.rental_type || 'str', s.ai_provider || null)));

  // Cleanup: keep only latest 5 strategy runs (each run produces 3-4 strategies)
  try {
    const { results: oldStrats } = await env.DB.prepare(`SELECT id FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC`).bind(propertyId).all();
    if (oldStrats && oldStrats.length > 20) {
      const keepIds = oldStrats.slice(0, 20).map(s => s.id);
      const placeholders = keepIds.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM pricing_strategies WHERE property_id = ? AND id NOT IN (${placeholders})`).bind(propertyId, ...keepIds).run();
    }
  } catch {}

  // Save the full analysis result to analysis_reports so pricing tab can restore it on re-entry
  // This is the key fix: /analyze results were previously lost on navigation
  const provider = (all.find(s => s.ai_provider) || {}).ai_provider || 'system';
  try {
    const reportPayload = JSON.stringify({ market: marketData[0] || null, sources, seasonality: seasonData, strategies: all, analysis_type: analysisType, comparables_count: comparables.length });
    await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'pricing_analysis', ?, ?)`).bind(propertyId, reportPayload, provider).run();
    // Keep only last 3 pricing_analysis reports per property
    const { results: oldReports } = await env.DB.prepare(`SELECT id FROM analysis_reports WHERE property_id = ? AND report_type = 'pricing_analysis' ORDER BY created_at DESC`).bind(propertyId).all();
    if (oldReports && oldReports.length > 3) {
      const keepIds = oldReports.slice(0, 3).map(r => r.id);
      const placeholders = keepIds.map(() => '?').join(',');
      await env.DB.prepare(`DELETE FROM analysis_reports WHERE property_id = ? AND report_type = 'pricing_analysis' AND id NOT IN (${placeholders})`).bind(propertyId, ...keepIds).run();
    }
  } catch {}

  return json({ property, amenities, market: marketData[0] || null, comparables_count: comparables.length, auto_fetch: autoFetchMsg, tax_rate: taxRate, strategies: all, analysis_type: analysisType, pricelabs: plData, platforms, sources, seasonality: seasonData, actuals: actualsData, ai_error: aiError || null });
}

function generateAlgorithmicStrategies(property, amenities, market, comparables, taxRate, plData, seasonData) {
  const totalBoost = amenities.reduce((s, a) => s + (a.impact_score || 0), 0);
  const amenMult = 1 + (totalBoost / 100);
  const beds = Math.min(property.bedrooms || 1, 6);
  const baths = property.bathrooms || 1;

  // ── Step 1: Determine base nightly rate — PriceLabs first, then derive from comps ──
  let nightlyBase = 0;
  let rateSource = '';

  // Priority 1: PriceLabs recommended base price (algorithmically calculated from demand)
  if (plData && plData.recommended_base && plData.recommended_base > 0) {
    nightlyBase = Math.round(plData.recommended_base);
    rateSource = 'PriceLabs recommended base $' + nightlyBase + '/nt';
  }
  // Priority 2: PriceLabs current base price
  else if (plData && plData.base_price && plData.base_price > 0) {
    nightlyBase = Math.round(plData.base_price);
    rateSource = 'PriceLabs base price $' + nightlyBase + '/nt';
  }
  // Priority 3: STR comps (rates under $1000 are nightly)
  if (nightlyBase === 0) {
    const compRates = comparables.map(c => c.nightly_rate || 0).filter(r => r > 30);
    const strComps = compRates.filter(r => r < 1000);
    if (strComps.length >= 2) {
      const sorted = strComps.slice().sort((a, b) => a - b);
      nightlyBase = sorted[Math.floor(sorted.length / 2)];
      rateSource = strComps.length + ' STR comps (median $' + nightlyBase + '/nt)';
    }
  }
  // Priority 4: Derive from LTR comps
  if (nightlyBase === 0) {
    const compRates = comparables.map(c => c.nightly_rate || 0).filter(r => r > 30);
    const ltrComps = compRates.filter(r => r >= 1000);
    let monthlyRent = 0;
    if (ltrComps.length >= 2) {
      const sorted = ltrComps.slice().sort((a, b) => a - b);
      monthlyRent = sorted[Math.floor(sorted.length / 2)];
    } else if (market && market.median_daily_rate && market.median_daily_rate > 100) {
      monthlyRent = market.median_daily_rate;
    }
    if (monthlyRent < 500) {
      const stateTier = getStateTier(property.state);
      const tierRents = {
        premium: { 0: 1800, 1: 2400, 2: 3200, 3: 4200, 4: 5500, 5: 7000, 6: 8500 },
        high:    { 0: 1400, 1: 1900, 2: 2500, 3: 3300, 4: 4300, 5: 5500, 6: 6500 },
        mid:     { 0: 1100, 1: 1500, 2: 2000, 3: 2600, 4: 3400, 5: 4200, 6: 5000 },
        low:     { 0: 850,  1: 1100, 2: 1500, 3: 1900, 4: 2500, 5: 3100, 6: 3800 },
      };
      monthlyRent = (tierRents[stateTier] || tierRents.mid)[beds] || 2000;
    }
    const sqftAdj = property.sqft > 2500 ? 1.12 : property.sqft > 1800 ? 1.05 : property.sqft > 1200 ? 1.0 : property.sqft > 800 ? 0.95 : 0.88;
    const typeAdj = { single_family: 1.15, condo: 0.95, apartment: 0.88, townhouse: 1.0, glamping: 1.25, studio: 0.75 }[property.property_type] || 1.0;
    const adjMonthly = Math.round(monthlyRent * sqftAdj * typeAdj);
    const strMult = getSTRMultiplier(property.state, property.city, property.property_type);
    nightlyBase = Math.round((adjMonthly / 30) * strMult);
    rateSource = 'Derived from $' + adjMonthly + '/mo rent × ' + strMult.toFixed(1) + 'x STR multiplier';
  }

  // ── Step 2: Apply amenity premium ──
  const adj = Math.round(nightlyBase * amenMult);

  // ── Step 3: Smart occupancy estimation ──
  // PriceLabs forward occupancy is BOOKING PACE, not annual occupancy
  // Low forward numbers (0-20%) are normal — most bookings come last minute
  let baseOcc = 0.50;
  let occSource = 'default 50% estimate';

  // Priority 1: Actual Guesty history for this market
  if (seasonData && seasonData.length > 0) {
    const avgSeasonOcc = seasonData.reduce((s, m) => s + (m.avg_occupancy || 0), 0) / seasonData.length;
    if (avgSeasonOcc > 0.1) {
      baseOcc = avgSeasonOcc;
      occSource = 'market actual avg ' + Math.round(avgSeasonOcc * 100) + '% (from Guesty data)';
    }
  }

  // Priority 2: PriceLabs occupancy (but apply smart scaling)
  if (plData && plData.occ_30d) {
    // PriceLabs occ can be "35" (percent) or "0.35" (decimal) — normalize both
    const rawOcc = parseFloat(plData.occ_30d);
    const plOcc = rawOcc > 1 ? rawOcc / 100 : rawOcc;
    const rawMkt = plData.mkt_occ_30d ? parseFloat(plData.mkt_occ_30d) : 0;
    const mktOcc = rawMkt > 1 ? rawMkt / 100 : rawMkt;
    if (plOcc >= 0.40) {
      // High forward occupancy — property is booking well, use as-is
      baseOcc = plOcc;
      occSource = 'PriceLabs 30d ' + Math.round(plOcc * 100) + '% (strong booking pace)';
    } else if (plOcc > 0 && plOcc < 0.40) {
      // Low forward occupancy is normal — scale up to estimated annual
      // Forward 30d pace typically represents 30-50% of actual annual occupancy
      const scaledOcc = Math.max(0.40, Math.min(0.70, plOcc * 2.5));
      if (scaledOcc > baseOcc) {
        baseOcc = scaledOcc;
        occSource = 'est. ' + Math.round(scaledOcc * 100) + '% annual (PL forward ' + Math.round(plOcc * 100) + '%, scaled up)';
      }
    }
    // If market occupancy is available and higher, blend
    if (mktOcc > baseOcc) {
      baseOcc = (baseOcc + mktOcc) / 2;
      occSource += ', blended with market ' + Math.round(mktOcc * 100) + '%';
    }
  }

  // Priority 3: Market data
  if (baseOcc <= 0.1 && market && market.avg_occupancy > 0) {
    baseOcc = market.avg_occupancy;
    occSource = 'market average ' + Math.round(market.avg_occupancy * 100) + '%';
  }

  // Floor: never below 30% for an active listing
  if (baseOcc < 0.30) { baseOcc = 0.30; occSource += ' (floor 30%)'; }

  // ── Step 4: Cleaning fee — PriceLabs first, then estimate ──
  // Cleaning scales with both sqft and bedroom count (more rooms = more to clean)
  const bedClean = { 0: 60, 1: 75, 2: 95, 3: 120, 4: 150, 5: 185, 6: 220 };
  const baseBedClean = bedClean[Math.min(beds, 6)] || 100;
  let clean = property.sqft
    ? Math.round(Math.max(baseBedClean, Math.min(350, property.sqft * 0.07 + beds * 10)))
    : baseBedClean;
  let cleanSource = 'estimated from sqft';
  if (plData && plData.cleaning_fees && plData.cleaning_fees > 0) {
    clean = Math.round(plData.cleaning_fees);
    cleanSource = 'from PriceLabs ($' + clean + ')';
  } else if (property.cleaning_fee && property.cleaning_fee > 0) {
    clean = property.cleaning_fee;
    cleanSource = 'your current setting ($' + clean + ')';
  }

  const pet = amenities.some(a => a.name === 'Pet Friendly') ? 75 : 0;

  // ── Step 5: Generate three strategies ──
  // Revenue = (nightly rate × occupancy × 365) + (cleaning fee × turnovers)
  // Avg stay ~3 nights → turnovers ≈ (occ × 365) / 3
  // Average stay: use market data if available, otherwise smart defaults by market type
  // Vacation markets average 4-5n, urban markets 2-3n, suburban 3n
  let avgStay = 3;
  if (seasonData && seasonData.length > 0 && seasonData[0].avg_stay_length > 0) {
    avgStay = Math.round(seasonData[0].avg_stay_length * 10) / 10; // from market data
  } else {
    const strMult = getSTRMultiplier(property.state, property.city, property.property_type);
    if (strMult >= 3.0) avgStay = 4.5;       // vacation market
    else if (strMult <= 2.2) avgStay = 2.5;  // urban market
    else avgStay = 3.5;                       // suburban/mixed
  }

  const lr = Math.round(adj * 0.78);
  const lo = Math.min(baseOcc * 1.3, 0.85);
  const lNights = Math.round(lo * 365);
  const lTurnovers = Math.round(lNights / avgStay);
  const lRev = Math.round(lr * lNights + Math.round(clean * 0.7) * lTurnovers);

  const bNights = Math.round(baseOcc * 365);
  const bTurnovers = Math.round(bNights / avgStay);
  const bRev = Math.round(adj * bNights + clean * bTurnovers);

  const pr = Math.round(adj * 1.2);
  const po = Math.max(baseOcc * 0.75, 0.30);
  const pNights = Math.round(po * 365);
  const pTurnovers = Math.round(pNights / avgStay);
  const pRev = Math.round(pr * pNights + Math.round(clean * 1.2) * pTurnovers);

  const sourceNote = rateSource + '. Occupancy: ' + occSource + '. Cleaning fee: ' + cleanSource + '.';

  // Calculate real seasonal adjustments from data
  let peakMarkup = 25, lowDiscount = 15;
  let seasonNote = '';
  if (seasonData && seasonData.length >= 6) {
    const maxMult = Math.max(...seasonData.map(s => s.multiplier || 1));
    const minMult = Math.min(...seasonData.map(s => s.multiplier || 1));
    peakMarkup = Math.round((maxMult - 1) * 100);
    lowDiscount = Math.round((1 - minMult) * 100);
    const peakMonths = seasonData.filter(s => (s.multiplier || 1) >= 1.1).map(s => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(s.month_number || 1) - 1]);
    const lowMonths = seasonData.filter(s => (s.multiplier || 1) <= 0.85).map(s => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][(s.month_number || 1) - 1]);
    seasonNote = ' Seasonal: peak ' + peakMonths.join('/') + ' (+' + peakMarkup + '%), low ' + lowMonths.join('/') + ' (-' + lowDiscount + '%).';
  }

  return [
    { strategy_name: 'Aggressive Launch', base_nightly_rate: lr, weekend_rate: Math.round(lr * 1.15), cleaning_fee: Math.round(clean * 0.7), pet_fee: pet, weekly_discount: 15, monthly_discount: 35, peak_season_markup: Math.max(peakMarkup, 15), low_season_discount: Math.max(lowDiscount, 5), min_nights: 1, projected_occupancy: Math.round(lo * 100) / 100, projected_annual_revenue: lRev, projected_monthly_avg: Math.round(lRev / 12), reasoning: sourceNote + ' Priced 22% below market ($' + lr + '/nt) for review velocity. Amenity boost: +' + Math.round(totalBoost) + '%.' + seasonNote, ai_generated: false },
    { strategy_name: 'Balanced Market Rate', base_nightly_rate: adj, weekend_rate: Math.round(adj * 1.2), cleaning_fee: clean, pet_fee: pet, weekly_discount: 12, monthly_discount: 30, peak_season_markup: peakMarkup, low_season_discount: lowDiscount, min_nights: 2, projected_occupancy: Math.round(baseOcc * 100) / 100, projected_annual_revenue: bRev, projected_monthly_avg: Math.round(bRev / 12), reasoning: sourceNote + ' Market-aligned at $' + adj + '/nt. Amenity premium: +' + Math.round(totalBoost) + '% from ' + amenities.length + ' amenities.' + seasonNote, ai_generated: false },
    { strategy_name: 'Premium Positioning', base_nightly_rate: pr, weekend_rate: Math.round(pr * 1.25), cleaning_fee: Math.round(clean * 1.2), pet_fee: pet, weekly_discount: 10, monthly_discount: 25, peak_season_markup: Math.round(peakMarkup * 1.2), low_season_discount: Math.max(lowDiscount - 5, 5), min_nights: 2, projected_occupancy: Math.round(po * 100) / 100, projected_annual_revenue: pRev, projected_monthly_avg: Math.round(pRev / 12), reasoning: sourceNote + ' Top 25% positioning at $' + pr + '/nt. Requires pro photos and 4.8+ rating.' + seasonNote, ai_generated: false },
  ];
}

// State cost-of-living tier for rent estimates
function getStateTier(state) {
  const premium = ['CA', 'NY', 'MA', 'HI', 'DC', 'CT', 'NJ'];
  const high = ['WA', 'CO', 'OR', 'MD', 'VA', 'IL', 'NH', 'RI', 'AK', 'VT', 'DE', 'MN'];
  const low = ['MS', 'AR', 'WV', 'KY', 'AL', 'OK', 'IA', 'KS', 'NE', 'ND', 'SD', 'LA'];
  if (premium.includes(state)) return 'premium';
  if (high.includes(state)) return 'high';
  if (low.includes(state)) return 'low';
  return 'mid'; // FL, TX, AZ, NC, SC, TN, GA, PA, OH, MI, etc.
}

// STR premium multiplier — how much more STR earns per night vs LTR daily equivalent
function getSTRMultiplier(state, city, propertyType) {
  // Vacation/resort markets get higher multiplier
  const vacationCities = ['miami','orlando','key west','destin','panama city','myrtle beach','hilton head','gatlinburg','pigeon forge','sedona','scottsdale','palm springs','lake tahoe','big bear','park city','aspen','vail','steamboat','telluride','savannah','charleston','nashville','new orleans','san diego','honolulu','maui','kailua','lahaina','cape coral','fort myers','naples','sarasota','clearwater','st pete','anna maria','siesta key','kissimmee','daytona','cocoa beach','outer banks','nags head','ocean city','rehoboth','cape may','martha\'s vineyard','nantucket','bar harbor','mackinac','traverse city','branson','gulf shores','tybee island','folly beach','isle of palms','kiawah','amelia island','st augustine','palm coast','port aransas','south padre','galveston'];
  const urbanCities = ['new york','chicago','los angeles','san francisco','boston','seattle','washington','philadelphia','houston','dallas','austin','denver','portland','atlanta','minneapolis','detroit','phoenix','las vegas'];
  const cityLower = (city || '').toLowerCase();

  // Base multiplier by market type
  let mult = 2.5; // default suburban
  if (vacationCities.some(v => cityLower.includes(v))) mult = 3.2;
  else if (urbanCities.some(u => cityLower.includes(u))) mult = 2.2;

  // Vacation states get a bump even if city not in list
  const vacationStates = ['FL', 'HI', 'SC', 'TN', 'CO', 'AZ'];
  if (vacationStates.includes(state) && mult < 2.8) mult = 2.8;

  // Glamping/unique properties get premium
  if (propertyType === 'glamping') mult *= 1.2;

  return mult;
}

// Bulk pricing analysis — run analysis on all unanalyzed properties
async function bulkAnalyzePricing(request, env) {
  const body = await request.json().catch(() => ({}));
  const analysisType = body.analysis_type || 'str';
  const quality = body.quality || 'standard';
  const maxProperties = body.max || 10;

  // Find properties without any pricing strategy, excluding buildings and research
  const { results: unanalyzed } = await env.DB.prepare(
    `SELECT p.id, CASE WHEN p.unit_number IS NOT NULL AND p.unit_number != '' THEN p.unit_number || ' — ' || COALESCE(p.platform_listing_name, p.name, p.address) ELSE COALESCE(p.platform_listing_name, p.name, p.address, 'Property #' || p.id) END as label FROM properties p WHERE p.is_research != 1 AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL) AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active') AND (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) = 0 LIMIT ?`
  ).bind(maxProperties).all();

  if (!unanalyzed || unanalyzed.length === 0) {
    return json({ ok: true, analyzed: 0, message: 'All properties already have pricing analysis' });
  }

  const results = [];
  let succeeded = 0, failed = 0;

  for (const prop of unanalyzed) {
    try {
      const fakeReq = { json: async () => ({ use_ai: true, quality, analysis_type: analysisType }) };
      const response = await analyzePricing(prop.id, fakeReq, env);
      const data = await response.json();
      if (data.strategies && data.strategies.length > 0) {
        succeeded++;
        results.push({ id: prop.id, label: prop.label, status: 'ok', strategies: data.strategies.length });
      } else {
        failed++;
        results.push({ id: prop.id, label: prop.label, status: 'no_strategies', error: 'Analysis returned no strategies' });
      }
    } catch (e) {
      failed++;
      results.push({ id: prop.id, label: prop.label, status: 'error', error: e.message });
    }
  }

  return json({ ok: true, analyzed: succeeded, failed, total: unanalyzed.length, results, message: succeeded + ' of ' + unanalyzed.length + ' properties analyzed successfully' });
}

// Bulk update tax rate on multiple properties
async function bulkUpdateTaxRate(request, env, uid) {
  const body = await request.json();
  const { property_ids, tax_rate_pct, scope } = body;
  if (tax_rate_pct === undefined || tax_rate_pct === null) return json({ error: 'tax_rate_pct required' }, 400);
  const rate = parseFloat(tax_rate_pct);
  if (isNaN(rate) || rate < 0 || rate > 50) return json({ error: 'tax_rate_pct must be between 0 and 50' }, 400);

  let updated = 0;
  if (scope === 'all') {
    // Update all non-research, non-building properties
    const q = uid
      ? `UPDATE properties SET tax_rate_pct = ?, updated_at = datetime('now') WHERE (user_id = ? OR user_id IS NULL) AND (is_research != 1 OR is_research IS NULL) AND id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)`
      : `UPDATE properties SET tax_rate_pct = ?, updated_at = datetime('now') WHERE (is_research != 1 OR is_research IS NULL) AND id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)`;
    const r = uid ? await env.DB.prepare(q).bind(rate, uid).run() : await env.DB.prepare(q).bind(rate).run();
    updated = r.meta.changes || 0;
  } else if (scope === 'state' && body.state) {
    // Update all properties in a specific state
    const q = uid
      ? `UPDATE properties SET tax_rate_pct = ?, updated_at = datetime('now') WHERE LOWER(state) = LOWER(?) AND (user_id = ? OR user_id IS NULL)`
      : `UPDATE properties SET tax_rate_pct = ?, updated_at = datetime('now') WHERE LOWER(state) = LOWER(?)`;
    const r = uid ? await env.DB.prepare(q).bind(rate, body.state, uid).run() : await env.DB.prepare(q).bind(rate, body.state).run();
    updated = r.meta.changes || 0;
  } else if (property_ids && Array.isArray(property_ids) && property_ids.length > 0) {
    // Update specific properties
    const stmt = env.DB.prepare(`UPDATE properties SET tax_rate_pct = ?, updated_at = datetime('now') WHERE id = ?`);
    const batch = property_ids.slice(0, 50).map(pid => stmt.bind(rate, pid));
    await env.DB.batch(batch);
    updated = batch.length;
  } else {
    return json({ error: 'Provide property_ids array, scope="all", or scope="state" with state' }, 400);
  }

  return json({ ok: true, updated, tax_rate_pct: rate, message: updated + ' properties updated to ' + rate + '% tax rate' });
}

// Auto-analyze: weekly cron runs pricing analysis on stale/unanalyzed properties
// Priority: never-analyzed first, then oldest analysis. Max 5 per run.
async function autoAnalyzeProperties(env) {
  const MAX_PER_RUN = 5;

  // 1. Properties never analyzed (highest priority)
  const { results: neverAnalyzed } = await env.DB.prepare(
    `SELECT p.id, COALESCE(p.platform_listing_name, p.name, p.address) as label, p.rental_type
     FROM properties p
     WHERE (p.is_research != 1 OR p.is_research IS NULL)
       AND (p.is_managed = 0 OR p.is_managed IS NULL)
       AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
       AND (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) = 0
     LIMIT ?`
  ).bind(MAX_PER_RUN).all();

  // 2. Properties with stale analysis (30+ days old)
  const remaining = MAX_PER_RUN - (neverAnalyzed?.results?.length || neverAnalyzed?.length || 0);
  let staleProps = [];
  if (remaining > 0) {
    const staleResult = await env.DB.prepare(
      `SELECT p.id, COALESCE(p.platform_listing_name, p.name, p.address) as label, p.rental_type,
              (SELECT MAX(created_at) FROM pricing_strategies WHERE property_id = p.id) as last_analyzed
       FROM properties p
       WHERE (p.is_research != 1 OR p.is_research IS NULL)
         AND (p.is_managed = 0 OR p.is_managed IS NULL)
         AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
         AND (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) > 0
         AND (SELECT MAX(created_at) FROM pricing_strategies WHERE property_id = p.id) < datetime('now', '-30 days')
       ORDER BY last_analyzed ASC
       LIMIT ?`
    ).bind(remaining).all();
    staleProps = staleResult?.results || [];
  }

  const candidates = [...(neverAnalyzed?.results || neverAnalyzed || []), ...staleProps];
  if (candidates.length === 0) {
    return { auto_analyzed: 0, message: 'All properties have recent analysis' };
  }

  let succeeded = 0, failed = 0;
  const results = [];

  for (const prop of candidates) {
    try {
      const analysisType = prop.rental_type === 'ltr' ? 'ltr' : 'str';
      const fakeReq = { json: async () => ({ use_ai: true, quality: 'standard', analysis_type: analysisType }) };
      const response = await analyzePricing(prop.id, fakeReq, env);
      const data = await response.json();
      if (data.strategies && data.strategies.length > 0) {
        succeeded++;
        results.push({ id: prop.id, label: prop.label, status: 'ok' });
      } else {
        failed++;
        results.push({ id: prop.id, label: prop.label, status: 'no_strategies' });
      }
    } catch (e) {
      failed++;
      results.push({ id: prop.id, label: prop.label, status: 'error', error: e.message });
    }
  }

  return { auto_analyzed: succeeded, failed, total: candidates.length, results,
    message: succeeded + ' of ' + candidates.length + ' properties auto-analyzed' };
}

async function generateAIStrategy(property, amenities, market, comparables, taxRate, provider, mode, env, plData, platforms, seasonData) {
  const modeLabel = mode === 'ltr' ? 'long-term rental (LTR)' : 'short-term vacation rental (STR)';

  const utilities = (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0);

  // Property services (cleaning co, PM, etc.)
  let servicesMonthly = 0;
  let servicesList = '';
  try {
    const { results: services } = await env.DB.prepare(
      `SELECT name, monthly_cost FROM property_services WHERE property_id = ? ORDER BY monthly_cost DESC`
    ).bind(property.id).all();
    if (services && services.length > 0) {
      servicesMonthly = services.reduce((a, s) => a + (s.monthly_cost || 0), 0);
      servicesList = services.map(s => `${s.name} $${s.monthly_cost}/mo`).join(', ');
    }
  } catch {}

  const isManaged = property.is_managed === 1 || property.ownership_type === 'managed';
  // For managed properties, we still need real expenses — your fee is based on profit after expenses
  const baseCost = property.ownership_type === 'rental'
    ? (property.monthly_rent_cost || 0)
    : (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0);
  const totalMonthly = baseCost + utilities + servicesMonthly;

  const expenseInfo = isManaged
    ? `COSTS (owner's expenses): ${property.ownership_type === 'rental' ? 'Rent $' + (property.monthly_rent_cost || 0) + '/mo' : 'Mortgage $' + (property.monthly_mortgage || 0) + '/mo | Insurance $' + (property.monthly_insurance || 0) + '/mo | Taxes $' + (property.annual_taxes || '?') + '/yr | HOA $' + (property.hoa_monthly || 0) + '/mo'}\nMANAGEMENT: You manage this for ${property.owner_name || 'Owner'} — you take ${property.management_fee_pct || 0}% of ${(property.fee_basis || 'gross') === 'net_profit' ? 'net profit (revenue minus expenses)' : 'gross revenue'}. The more profitable the property, the more you earn.`
    : property.ownership_type === 'rental'
    ? `COSTS: Rent $${property.monthly_rent_cost || 0}/mo`
    : `COSTS: Mortgage $${property.monthly_mortgage || 0}/mo | Insurance $${property.monthly_insurance || 0}/mo | Taxes $${property.annual_taxes || '?'}/yr | HOA $${property.hoa_monthly || 0}/mo`;

  // PriceLabs context — include rate calendar data if available
  let plContext = '';
  if (plData) {
    const pl30dAvg = plData.avg_30d || null;
    const pl90dAvg = plData.avg_90d || null;
    plContext = `\n\nPRICELABS DYNAMIC PRICING DATA (LIVE):
  Current Base Price: $${plData.base_price || '?'}/nt | PriceLabs Recommended: $${plData.recommended_base || plData.recommended_base_price || '?'}/nt
  Price Range: Min $${plData.min_price || '?'} — Max $${plData.max_price || '?'}
  Cleaning Fee (current): $${plData.cleaning_fees || '?'}
  Strategy Group: ${plData.group || plData.group_name || 'Default'}
  YOUR Occupancy: 7d ${plData.occ_7d || '?'} | 30d ${plData.occ_30d || '?'} | 60d ${plData.occ_60d || '?'}
  MARKET Occupancy: 7d ${plData.mkt_occ_7d || '?'} | 30d ${plData.mkt_occ_30d || '?'} | 60d ${plData.mkt_occ_60d || '?'}
  ${pl30dAvg ? '30-day avg rate (calendar): $' + pl30dAvg + '/nt | 90-day avg: $' + (pl90dAvg || '?') + '/nt' : ''}
  Sync Active: ${plData.push_enabled ? 'YES' : 'NO'} | PMS: ${plData.pms || '?'}
  Channels: ${(plData.channels || []).map(c => c.channel_name + (c.avg_nightly_rate ? ' $' + Math.round(c.avg_nightly_rate) + '/nt' : '')).join(', ') || 'None'}
  IMPORTANT: PriceLabs base price is the ANCHOR for all dynamic pricing. Your recommended base_nightly_rate below should align with or improve upon PriceLabs recommended base. Min/max prices are guardrails — the AI base should sit between them.`;
  }

  // Platform pricing context
  let platContext = '';
  if (platforms && platforms.length > 0) {
    platContext = `\n\nPLATFORM LISTINGS (live scraped): ${platforms.map(p => p.platform + (p.nightly_rate ? ' $' + p.nightly_rate + '/nt' : ' (no rate)') + (p.rating ? ' ' + p.rating + '★' : '') + (p.review_count ? ' (' + p.review_count + ' reviews)' : '') + (p.listing_url ? '' : ' ⚠ no URL')).join(' | ')}`;
  }

  // Guesty actuals
  const guestyContext = await getGuestyActualsForPrompt(property.id, property.city, property.state, env);
  const portfolioContext = await getPortfolioContextForPrompt(property, env);
  const guestIntelContext = await getGuestIntelForPrompt(property.id, property.city, property.state, env);
  const marketTrendContext = await getMarketAndTrendContextForPrompt(property.id, property, env);
  const plCustomizationsContext = getPriceLabsCustomizationsForPrompt(property);

  // Seasonality context
  let seasonContext = '';
  if (seasonData && seasonData.length >= 6) {
    const mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const peakMonths = seasonData.filter(s => (s.multiplier || 1) >= 1.1).map(s => mNames[(s.month_number || 1) - 1]);
    const lowMonths = seasonData.filter(s => (s.multiplier || 1) <= 0.85).map(s => mNames[(s.month_number || 1) - 1]);
    const avgOcc = seasonData.reduce((a, s) => a + (s.avg_occupancy || 0), 0) / seasonData.length;
    seasonContext = `\nSEASONALITY (${property.city} market): Peak months: ${peakMonths.join(', ') || 'none'} | Low months: ${lowMonths.join(', ') || 'none'} | Market avg occ: ${Math.round(avgOcc * 100)}%`;
    if (seasonData[0]?.avg_stay_length > 0) seasonContext += ` | Avg stay: ${seasonData[0].avg_stay_length.toFixed(1)} nights`;
  }

  // Build restrictions + AI notes context
  let restrictionsContext = '';
  if (property.hoa_name || property.rental_restrictions || property.ai_notes) {
    restrictionsContext += '\n';
    if (property.hoa_name) restrictionsContext += `HOA/COMMUNITY: ${property.hoa_name}\n`;
    if (property.rental_restrictions) restrictionsContext += `RENTAL RESTRICTIONS: ${property.rental_restrictions}\n*** These restrictions are HARD CONSTRAINTS — your strategy MUST comply with them. If STR is not viable, recommend MTR or LTR strategy instead. ***\n`;
    if (property.ai_notes) restrictionsContext += `OPERATOR NOTES (keep in mind): ${property.ai_notes}\n`;
  }

  const prompt = `You are an expert ${modeLabel} revenue manager. Analyze this property using ALL available data and generate the most profitable realistic strategy.

PROPERTY: ${property.address}, ${property.city}, ${property.state} ${property.zip || ''}
Type: ${property.property_type} | ${property.bedrooms}BR/${property.bathrooms}BA | ${property.sqft || '?'}sqft
Ownership: ${isManaged ? 'MANAGED for ' + (property.owner_name || 'Owner') + ' (' + (property.management_fee_pct || 0) + '% of ' + ((property.fee_basis || 'gross') === 'net_profit' ? 'net profit' : 'gross') + ')' : property.ownership_type === 'rental' ? 'RENTED (arbitrage/sublet)' : 'OWNED'}
${property.listing_url ? 'Listing: ' + property.listing_url : ''}${restrictionsContext}

${expenseInfo}
UTILITIES: $${utilities}/mo${servicesMonthly > 0 ? ' | SERVICES: $' + servicesMonthly + '/mo (' + servicesList + ')' : ''}
TOTAL MONTHLY EXPENSES: $${totalMonthly}/mo
CLEANING: Guest pays $${property.cleaning_fee || 0} | Cleaner costs $${property.cleaning_cost || '? (not set)'} per turnover

AMENITIES (${amenities.length}): ${amenities.map(a => a.name + ' (+' + (a.impact_score || 0) + '%)').join(', ') || 'None'}

MARKET: ${market ? 'Avg $' + (market.avg_daily_rate || '?') + '/nt | Median $' + (market.median_daily_rate || '?') + '/nt | Avg occ ' + (market.avg_occupancy ? Math.round(market.avg_occupancy * 100) + '%' : '?') + ' | ' + (market.active_listings || '?') + ' active listings' : 'No market data'}

COMPS (${comparables.length}): ${comparables.slice(0, 12).map(c => (c.source || '') + ' ' + (c.bedrooms || '?') + 'BR $' + (c.nightly_rate || 0) + (c.comp_type === 'ltr' ? '/mo' : '/nt') + (c.rating ? ' ' + c.rating + '★' : '') + (c.occupancy_pct ? ' ' + Math.round(c.occupancy_pct * 100) + '%occ' : '')).join(' | ') || 'None'}
${plContext}${platContext}${seasonContext ? '\n' + seasonContext : ''}
${plCustomizationsContext}
${guestyContext ? guestyContext : ''}
${portfolioContext ? portfolioContext : ''}
${guestIntelContext ? guestIntelContext : ''}
${marketTrendContext ? marketTrendContext : ''}

${mode === 'str' ? `PRICING GUIDANCE:
- Your base_nightly_rate is the PriceLabs anchor — all dynamic adjustments (weekends, seasons, last-minute) happen ABOVE this
- If PriceLabs is linked, your base should align with or improve upon their recommended base price
- Do NOT set base_nightly_rate equal to what you want average revenue to be — base is the floor, dynamic pricing raises it
- Revenue projection = (base × dynamic_avg_multiplier × occupancy × 365) + (cleaning × turnovers)
- Typical dynamic multiplier: 1.15–1.35x (weekends, events, seasons push rates above base)
- Use actual Guesty data for occupancy if available — it's more reliable than PriceLabs forward booking pace
- Breakeven check: monthly_revenue must cover $${totalMonthly}/mo BEFORE any profit` : ''}

DATA INTEGRITY: Monthly actuals exclude the current in-progress month. Use only completed months for averages.

Respond ONLY with JSON (no markdown, no backticks):
{
  ${mode === 'ltr' ? '"monthly_rent":N,' : '"base_nightly_rate":N,"weekend_rate":N,"cleaning_fee":N,"cleaning_fee_reasoning":"why this amount","pet_fee":N,"weekly_discount":N,"monthly_discount":N,"peak_season_markup":N,"low_season_discount":N,"min_nights":N,"min_price":N,"max_price":N,'}
  "projected_occupancy":0.XX,
  "projected_annual_revenue":N,
  "projected_monthly_avg":N,
  "breakeven_rate":N,
  "analysis":"3-5 paragraph analysis: (1) Market positioning vs comps and rates, (2) Revenue projections with occupancy assumptions, (3) Expense coverage — does this cover $${totalMonthly}/mo and what is the profit margin, (4) ${plData ? 'PriceLabs alignment — is current base optimal, what to change in PriceLabs' : 'Platform pricing strategy'}, (5) Key risks and seasonal considerations for ${property.city}, ${property.state}. Be specific with numbers and cite which data sources you used.",
  "recommendations":["specific actionable recommendation 1","recommendation 2","recommendation 3"],
  "reasoning":"one-line summary of the core strategy"
}`;

  let aiResponse;
  try {
    if (provider === 'anthropic') {
      const k = env.ANTHROPIC_API_KEY; if (!k) throw new Error('ANTHROPIC_API_KEY not set');
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }) });
      const rj = await r.json();
      if (!r.ok) throw new Error('Anthropic API ' + r.status + ': ' + (rj?.error?.message || JSON.stringify(rj).substring(0, 120)));
      aiResponse = rj.content?.[0]?.text;
      if (!aiResponse) throw new Error('Anthropic returned empty content. Response: ' + JSON.stringify(rj).substring(0, 120));
    } else if (provider === 'openai') {
      const k = env.OPENAI_API_KEY; if (!k) throw new Error('OPENAI_API_KEY not set');
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 2500 }) });
      const rj = await r.json();
      if (!r.ok) throw new Error('OpenAI API ' + r.status + ': ' + (rj?.error?.message || JSON.stringify(rj).substring(0, 120)));
      aiResponse = rj.choices?.[0]?.message?.content;
      if (!aiResponse) throw new Error('OpenAI returned empty content. Response: ' + JSON.stringify(rj).substring(0, 120));
    } else if (provider === 'workers_ai') {
      if (!env.AI) throw new Error('Workers AI not configured');
      aiResponse = (await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 2500 })).response;
      if (!aiResponse) throw new Error('Workers AI returned empty response');
    }
  } catch (err) { await trackAI(env, 'pricing_analysis', provider, 0, false, err.message); return { __ai_error: err.message }; }
  await trackAI(env, 'pricing_analysis', provider, 2500, true, null);
  await trackApiCall(env, provider === 'workers_ai' ? 'workers_ai' : provider, 'pricing_analysis', true);

  const stratName = mode === 'ltr' ? 'AI — LTR Strategy' : 'AI — STR Strategy';
  try {
    let jsonStr = aiResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    const p = JSON.parse(jsonStr);

    if (mode === 'ltr' && p.monthly_rent) {
      let ltrOcc = p.projected_occupancy || 0.92;
      if (ltrOcc > 1) ltrOcc = ltrOcc / 100;
      return { strategy_name: stratName, base_nightly_rate: p.monthly_rent, weekend_rate: 0, cleaning_fee: 0, pet_fee: 0, weekly_discount: 0, monthly_discount: 0, peak_season_markup: 0, low_season_discount: 0, min_nights: 365, projected_occupancy: ltrOcc, projected_annual_revenue: p.projected_annual_revenue || p.monthly_rent * 12, projected_monthly_avg: p.monthly_rent, reasoning: (p.analysis || p.reasoning || ''), ai_generated: true, analysis: p.analysis, recommendations: p.recommendations, breakeven_rate: p.breakeven_rate };
    }
    const rate = p.base_nightly_rate || 150;
    // Normalize occupancy: AI may return 55 (meaning 55%) or 0.55 — ensure 0.XX format
    let occ = p.projected_occupancy || 0.45;
    if (occ > 1) occ = occ / 100; // AI returned 55 instead of 0.55
    occ = Math.min(Math.max(occ, 0.05), 0.98); // Clamp to reasonable range
    const annRev = p.projected_annual_revenue || Math.round(rate * occ * 365);
    const monAvg = p.projected_monthly_avg || Math.round(annRev / 12);
    return {
      strategy_name: stratName, base_nightly_rate: rate, weekend_rate: p.weekend_rate || Math.round(rate * 1.2),
      cleaning_fee: p.cleaning_fee || 50, pet_fee: p.pet_fee || 0, weekly_discount: p.weekly_discount || 10,
      monthly_discount: p.monthly_discount || 20, peak_season_markup: p.peak_season_markup || 15,
      low_season_discount: p.low_season_discount || 10, min_nights: p.min_nights || 2,
      projected_occupancy: occ, projected_annual_revenue: annRev, projected_monthly_avg: monAvg,
      reasoning: (p.analysis || p.reasoning || ''), ai_generated: true,
      analysis: p.analysis, recommendations: p.recommendations, breakeven_rate: p.breakeven_rate,
      cleaning_fee_reasoning: p.cleaning_fee_reasoning,
    };
  } catch (parseErr) {
    const extract = (key) => { const m = aiResponse.match(new RegExp('"' + key + '"\\s*:\\s*([\\d.]+)')); return m ? parseFloat(m[1]) : null; };
    const rate = extract('base_nightly_rate') || 150;
    const occ = extract('projected_occupancy') || 0.45;
    const annRev = extract('projected_annual_revenue') || Math.round(rate * occ * 365);
    return { strategy_name: stratName, base_nightly_rate: rate, weekend_rate: extract('weekend_rate') || Math.round(rate * 1.2), cleaning_fee: extract('cleaning_fee') || 50, pet_fee: 0, weekly_discount: 10, monthly_discount: 20, peak_season_markup: 15, low_season_discount: 10, min_nights: 2, projected_occupancy: occ, projected_annual_revenue: annRev, projected_monthly_avg: Math.round(annRev / 12), reasoning: aiResponse.substring(0, 500), ai_generated: true };
  }
}

async function generatePLStrategyRecommendation(propertyId, env) {
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);

  // Gather ALL available data
  const { results: amenities } = await env.DB.prepare(`SELECT a.* FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(propertyId).all();
  const { results: comparables } = await env.DB.prepare(`SELECT * FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC LIMIT 15`).bind(propertyId).all();
  const market = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC LIMIT 1`).bind(property.city, property.state).first();
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ?`).bind(propertyId).all();
  const { results: strategies } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC LIMIT 5`).bind(propertyId).all();

  // Property services (cleaning service, PM, etc.) — read-only, additive to expense picture
  let servicesMonthly = 0;
  let servicesList = '';
  try {
    const { results: services } = await env.DB.prepare(
      `SELECT name, monthly_cost FROM property_services WHERE property_id = ? ORDER BY monthly_cost DESC`
    ).bind(propertyId).all();
    if (services && services.length > 0) {
      servicesMonthly = services.reduce((a, s) => a + (s.monthly_cost || 0), 0);
      servicesList = services.map(s => `${s.name} $${s.monthly_cost}/mo`).join(', ');
    }
  } catch {}

  // Previous Generate Strategy report — read-only, gives AI context on prior recommendations
  // so it can improve on them rather than repeat or contradict without reason
  let prevStrategyContext = '';
  try {
    const prevReport = await env.DB.prepare(
      `SELECT report_data, provider, created_at FROM analysis_reports
       WHERE property_id = ? AND report_type = 'pl_strategy' ORDER BY created_at DESC LIMIT 1`
    ).bind(propertyId).first();
    if (prevReport && prevReport.report_data) {
      const prev = JSON.parse(prevReport.report_data);
      const s = prev.strategy || {};
      if (s.base_price || s.projected_monthly_revenue) {
        prevStrategyContext = `\nPREVIOUS STRATEGY (${prevReport.created_at ? prevReport.created_at.substring(0,10) : 'prior'}, by ${prevReport.provider || 'AI'}): `;
        prevStrategyContext += `Base $${s.base_price || '?'}/nt | Min $${s.min_price || '?'} | Max $${s.max_price || '?'} | `;
        prevStrategyContext += `Proj $${s.projected_monthly_revenue || '?'}/mo | Occ ${Math.round((s.projected_occupancy || 0) * 100)}%`;
        if (s.strategy_summary) prevStrategyContext += `\nPrev summary: ${s.strategy_summary.substring(0, 200)}`;
        prevStrategyContext += `\nIf recommending different numbers from the above, explicitly explain why (e.g. new Guesty data, market shift, seasonal change).\n`;
      }
    }
  } catch {}

  // Previous revenue optimization report — surfaces what was already recommended
  let prevOptContext = '';
  try {
    const prevOpt = await env.DB.prepare(
      `SELECT report_data, created_at FROM analysis_reports
       WHERE property_id = ? AND report_type = 'revenue_optimization' ORDER BY created_at DESC LIMIT 1`
    ).bind(propertyId).first();
    if (prevOpt && prevOpt.report_data) {
      const opt = JSON.parse(prevOpt.report_data);
      const o = opt.optimization || {};
      if (o.quick_wins && o.quick_wins.length > 0) {
        prevOptContext = `\nPREVIOUS OPTIMIZATION RECOMMENDATIONS (${prevOpt.created_at ? prevOpt.created_at.substring(0,10) : 'prior'}): `;
        prevOptContext += `Quick wins: ${o.quick_wins.slice(0, 3).join(' | ')}. `;
        prevOptContext += `Where relevant, reference whether those actions appear to have been taken based on current data.\n`;
      }
    }
  } catch {}

  // PriceLabs data
  let plData = null;
  const plLink = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();
  if (plLink) {
    const today = new Date().toISOString().split('T')[0];
    const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const next90 = new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];
    const avg30 = await env.DB.prepare(`SELECT AVG(price) as avg, MIN(price) as min, MAX(price) as max, COUNT(*) as cnt FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= ? AND rate_date <= ? AND is_available = 1`).bind(plLink.pl_listing_id, today, next30).first();
    const avg90 = await env.DB.prepare(`SELECT AVG(price) as avg FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= ? AND rate_date <= ?`).bind(plLink.pl_listing_id, today, next90).first();
    plData = {
      base_price: plLink.base_price, min_price: plLink.min_price, max_price: plLink.max_price,
      recommended_base: plLink.recommended_base_price,
      platform: plLink.pl_platform, pms: plLink.pl_pms,
      avg_30d: avg30?.avg ? Math.round(avg30.avg) : null,
      min_30d: avg30?.min, max_30d: avg30?.max,
      avg_90d: avg90?.avg ? Math.round(avg90.avg) : null,
      rates_count: avg30?.cnt || 0,
      occ_30d: plLink.occupancy_next_30, mkt_occ_30d: plLink.market_occupancy_next_30,
      occ_7d: plLink.occupancy_next_7,
    };
  }

  // Seasonality — same data the algorithmic strategies use, gives AI context on seasonal patterns
  let seasonDataPL = [];
  try {
    const { results: sRows } = await env.DB.prepare(
      `SELECT month_number, avg_occupancy, multiplier, avg_daily_rate FROM market_seasonality WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY month_number`
    ).bind(property.city, property.state).all();
    if (sRows && sRows.length > 0) {
      seasonDataPL = sRows;
    } else {
      // Derive from monthly_actuals if market seasonality not available
      const { results: aRows } = await env.DB.prepare(
        `SELECT month, total_revenue, occupancy_pct, avg_nightly_rate FROM monthly_actuals WHERE property_id = ? ORDER BY month`
      ).bind(propertyId).all();
      if (aRows && aRows.length >= 3) {
        const avgRev = aRows.reduce((a, r) => a + (r.total_revenue || 0), 0) / aRows.length;
        seasonDataPL = aRows.map(r => ({
          month_number: parseInt((r.month || '').split('-')[1]) || 1,
          avg_occupancy: r.occupancy_pct || 0,
          multiplier: avgRev > 0 ? (r.total_revenue || 0) / avgRev : 1,
          avg_daily_rate: r.avg_nightly_rate || 0,
        }));
      }
    }
  } catch {}

  // Portfolio context — sibling units + nearby managed properties (read-only intelligence)
  const buildingContext = await getPortfolioContextForPrompt(property, env);

  // Expenses — include property_services in total
  const monthlyCost = property.ownership_type === 'rental'
    ? (property.monthly_rent_cost || 0)
    : (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0);
  const utilities = (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0);
  const totalMonthly = monthlyCost + utilities + servicesMonthly;

  // Build comprehensive prompt
  const plRestrictions = [property.hoa_name ? 'HOA: ' + property.hoa_name : '', property.rental_restrictions ? 'RESTRICTIONS: ' + property.rental_restrictions + ' — strategy MUST comply' : '', property.ai_notes ? 'OPERATOR NOTES: ' + property.ai_notes : ''].filter(Boolean).join('\n');
  const prompt = `You are an expert STR revenue manager specializing in PriceLabs dynamic pricing setup. Generate a comprehensive pricing strategy recommendation for this property.

PROPERTY: ${property.address}, ${property.city}, ${property.state} ${property.zip || ''}
Type: ${property.property_type} | ${property.bedrooms || '?'}BR / ${property.bathrooms || '?'}BA | ${property.sqft || '?'} sqft
Ownership: ${(property.is_managed === 1 || property.ownership_type === 'managed') ? 'MANAGED for ' + (property.owner_name || 'Owner') + ' (' + (property.management_fee_pct || 0) + '% of ' + ((property.fee_basis || 'gross') === 'net_profit' ? 'net profit' : 'gross') + ')' : property.ownership_type === 'rental' ? 'RENTED (sublet/arbitrage)' : 'OWNED'}
${property.listing_url ? 'Listing: ' + property.listing_url : ''}${plRestrictions ? '\n' + plRestrictions : ''}

MONTHLY EXPENSES: $${totalMonthly}/mo total
${property.ownership_type === 'rental' ? '  Rent: $' + (property.monthly_rent_cost || 0) : '  Mortgage: $' + (property.monthly_mortgage || 0) + ' | Insurance: $' + (property.monthly_insurance || 0) + ' | Taxes: $' + Math.round((property.annual_taxes || 0) / 12) + '/mo | HOA: $' + (property.hoa_monthly || 0)}
  Utilities: $${utilities}/mo (elec $${property.expense_electric || 0}, gas $${property.expense_gas || 0}, water $${property.expense_water || 0}, internet $${property.expense_internet || 0}, trash $${property.expense_trash || 0})

AMENITIES (${amenities.length}): ${amenities.map(a => a.name + ' (+' + (a.impact_score || 0) + '%)').join(', ') || 'None listed'}

${plData ? `PRICELABS LIVE DATA:
  Current Base: $${plData.base_price || '?'}/nt | PL Recommended Base: $${plData.recommended_base || '?'}/nt
  Min Floor: $${plData.min_price || '?'}/nt | Max Ceiling: $${plData.max_price || '?'}/nt
  30d calendar avg rate: $${plData.avg_30d || '?'}/nt (range $${plData.min_30d || '?'}–$${plData.max_30d || '?'}) | 90d avg: $${plData.avg_90d || '?'}/nt
  Your forward occupancy: 7d ${plData.occ_7d || '?'} | 30d ${plData.occ_30d || '?'} | Market 30d ${plData.mkt_occ_30d || '?'}
  NOTE: Forward 30d occupancy is booking PACE, not annual occupancy. 10-30% forward is normal — annual occupancy is typically 50-75%.` : 'PRICELABS: Not linked — recommendations based on market data and comps only.'}

PLATFORM LISTINGS: ${platforms.length > 0 ? platforms.map(p => p.platform + (p.nightly_rate ? ' $' + p.nightly_rate + '/nt' : '') + (p.rating ? ' ' + p.rating + '★' : '') + (p.review_count ? ' (' + p.review_count + ' reviews)' : '')).join(', ') : 'None'}

MARKET DATA: ${market ? 'Avg STR $' + (market.avg_daily_rate || '?') + '/nt | Median $' + (market.median_daily_rate || '?') + '/nt | Avg occupancy ' + (market.avg_occupancy ? Math.round(market.avg_occupancy * 100) + '%' : '?') + ' | ' + (market.active_listings || '?') + ' active listings' : 'No market snapshots'}

COMP DATA (${comparables.length} comps): ${comparables.slice(0, 10).map(c => (c.source || '') + ' ' + (c.bedrooms || '?') + 'BR $' + (c.nightly_rate || 0) + (c.comp_type === 'ltr' ? '/mo' : '/nt') + (c.rating ? ' ' + c.rating + '★' : '')).join(' | ') || 'None'}

PRIOR ALGORITHMIC ANALYSIS: ${strategies.length > 0 ? strategies.slice(0, 3).map(s => s.strategy_name + ': base $' + s.base_nightly_rate + '/nt, occ ' + Math.round((s.projected_occupancy || 0) * 100) + '%, proj $' + Math.round(s.projected_monthly_avg || 0) + '/mo').join(' | ') : 'None yet — run Price Analysis for more data'}
${servicesList ? 'PROPERTY SERVICES: ' + servicesList + ' ($' + Math.round(servicesMonthly) + '/mo — included in total expenses)\n' : ''}${buildingContext}
${seasonDataPL.length >= 3 ? 'SEASONALITY (' + property.city + '): ' + (() => { const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return seasonDataPL.map(s => mn[(s.month_number||1)-1] + ' ' + (s.multiplier||1).toFixed(2) + 'x' + (s.avg_occupancy ? ' ' + Math.round(s.avg_occupancy*100) + '%occ' : '')).join(' | '); })() + '\n' : ''}
${await getGuestyActualsForPrompt(propertyId, property.city, property.state, env)}
${await getGuestIntelForPrompt(propertyId, property.city, property.state, env)}
${await getMonthlyTargetsForPrompt(propertyId, property, env)}
${await getMarketAndTrendContextForPrompt(propertyId, property, env)}
${prevStrategyContext}${prevOptContext}
CRITICAL: BASE PRICE ≠ AVERAGE RATE
The base_price you recommend is PriceLabs' anchor — dynamic demand adjustments push final rates 15–40% ABOVE base.
- If you want $200/nt average revenue, recommend base_price around $145–$165/nt
- The 30d calendar avg ($${plData?.avg_30d || '?'}/nt) already shows PriceLabs pushing rates above the $${plData?.base_price || '?'} base
- min_price = absolute floor (PriceLabs never goes below this, not even during slow periods)
- max_price = hard ceiling for the highest peak dates
- projected_monthly_revenue = what you expect the property to earn after dynamic pricing runs (use actual Guesty occ if available)
- All revenue projections must be achievable and must cover $${totalMonthly}/mo in expenses

DATA INTEGRITY: Monthly actuals exclude current in-progress month. Use completed months for averages only.

Generate a COMPREHENSIVE PriceLabs pricing strategy. Respond ONLY with JSON (no markdown, no backticks):
{
  "base_price": {number - PriceLabs anchor price. Dynamic pricing will push actual rates 15-40% above this},
  "min_price": {number - absolute minimum floor PriceLabs will never go below},
  "max_price": {number - hard ceiling for peak demand dates},
  "weekend_adjustment": {number - % increase for Fri/Sat, e.g. 20 means +20%},
  "cleaning_fee": {number - recommended cleaning fee},
  "cleaning_fee_reasoning": "why this cleaning fee amount",
  "pet_fee": {number or 0},
  "extra_guest_fee": {number per guest above base occupancy, or 0},
  "min_nights_weekday": {number},
  "min_nights_weekend": {number},
  "weekly_discount_pct": {number},
  "monthly_discount_pct": {number},
  "last_minute_discount_pct": {number - discount for bookings within 3 days},
  "early_bird_discount_pct": {number - discount for bookings 60+ days out},
  "peak_season_months": ["month names when rates should be highest"],
  "peak_season_markup_pct": {number},
  "low_season_months": ["month names when rates should be lowest"],
  "low_season_discount_pct": {number},
  "orphan_day_discount_pct": {number - discount for gap-filling single nights between bookings},
  "projected_occupancy": {0.XX},
  "projected_monthly_revenue": {number},
  "projected_annual_revenue": {number},
  "breakeven_occupancy": {0.XX - minimum occupancy needed to cover $${totalMonthly}/mo expenses},
  "pricelabs_setup_steps": ["step 1 text", "step 2 text", "specific PriceLabs settings to configure"],
  "pricelabs_action_items": [{"setting": "exact PriceLabs customization name", "current": "current value if known", "recommended": "recommended value", "reason": "why this change for THIS property", "priority": 1}],
  "strategy_summary": "2-3 sentence summary of the overall approach",
  "key_recommendations": ["recommendation 1", "recommendation 2", "recommendation 3"],
  "risks": ["risk 1", "risk 2"]
}`;

  const aiResult = await callAIWithFallback(env, 'pl_strategy', prompt, 3000, 3000);
  if (!aiResult) return json({ error: 'No AI provider available. Configure ANTHROPIC_API_KEY, OPENAI_API_KEY, or Workers AI.' }, 400);
  const aiResponse = aiResult.text;
  const provider = aiResult.provider;

  // Parse response - robust extraction
  let strategy = null;
  try {
    let jsonStr = aiResponse;
    // Strip any backtick fences (1, 2, or 3 backticks, with or without 'json' label)
    jsonStr = jsonStr.replace(/`{1,3}json\s*/gi, '').replace(/`{1,3}\s*/g, '');
    // Find outermost JSON object
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    // Clean common JSON issues
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    // Remove control characters except newlines
    jsonStr = jsonStr.replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, ' ');
    try { strategy = JSON.parse(jsonStr); } catch {
      // Try fixing common issues: unescaped quotes in values, trailing commas
      jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1').replace(/\t/g, ' ');
      try { strategy = JSON.parse(jsonStr); } catch {
        // Last resort: try to fix unescaped newlines in string values
        jsonStr = jsonStr.replace(/\n/g, '\\n').replace(/\r/g, '');
        try { strategy = JSON.parse(jsonStr); } catch {}
      }
    }
  } catch {}

  if (!strategy) {
    // All parsing attempts failed — return raw text as fallback
    return json({
      strategy: { strategy_summary: aiResponse.substring(0, 2000), key_recommendations: ['AI response could not be parsed into structured data — see summary above'], raw: true },
      property: { id: property.id, address: property.address, city: property.city, state: property.state },
      context: { provider, parse_error: true },
    });
  }

  const response = {
    strategy,
    property: { id: property.id, address: property.address, city: property.city, state: property.state, bedrooms: property.bedrooms, bathrooms: property.bathrooms },
    context: {
      monthly_expenses: totalMonthly,
      amenities_count: amenities.length,
      comps_count: comparables.length,
      platforms_count: platforms.length,
      has_pricelabs: !!plData,
      pricelabs: plData,
      provider,
    },
  };

  // Save to analysis_reports
  try {
    await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'pl_strategy', ?, ?)`)
      .bind(propertyId, JSON.stringify(response), provider).run();
  } catch {}

  // Also persist to pricing_strategies so the strategy feeds into dashboard, year projection, and property cards
  if (strategy && !strategy.raw && (strategy.base_price || strategy.base_nightly_rate)) {
    try {
      const s = strategy;
      const baseRate = s.base_price || s.base_nightly_rate || 0;
      const projOcc = s.projected_occupancy || 0;
      const projAnnual = s.projected_annual_revenue || Math.round(baseRate * 365 * projOcc);
      const projMonthly = s.projected_monthly_revenue || Math.round(projAnnual / 12);
      const stratName = 'AI Strategy (' + provider + ')';
      const reasoning = s.strategy_summary || s.reasoning || '';
      await env.DB.prepare(
        `INSERT INTO pricing_strategies (property_id, strategy_name, base_nightly_rate, weekend_rate, cleaning_fee, pet_fee, weekly_discount, monthly_discount, peak_season_markup, low_season_discount, min_nights, projected_occupancy, projected_annual_revenue, projected_monthly_avg, reasoning, ai_generated, rental_type, ai_provider) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`
      ).bind(
        propertyId, stratName, baseRate,
        s.weekend_adjustment ? Math.round(baseRate * (1 + (s.weekend_adjustment || 0) / 100)) : 0,
        s.cleaning_fee || 0, s.pet_fee || 0,
        s.weekly_discount_pct || 0, s.monthly_discount_pct || 0,
        s.peak_season_markup_pct || 0, s.low_season_discount_pct || 0,
        s.min_nights_weekday || s.min_nights || 2,
        projOcc, projAnnual, projMonthly,
        reasoning.substring(0, 2000), property.rental_type || 'str', provider
      ).run();
    } catch (e) { syslog(env, 'error', 'generateAIStrategy', 'save_pricing_strategies', e.message); }
  }

  return json(response);
}

async function generateRevenueOptimization(propertyId, env) {
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);
  const { results: amenities } = await env.DB.prepare(`SELECT a.* FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(propertyId).all();
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ?`).bind(propertyId).all();
  const { results: strategies } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC LIMIT 3`).bind(propertyId).all();
  const { results: comparables } = await env.DB.prepare(`SELECT * FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC LIMIT 10`).bind(propertyId).all();

  // Property services — read-only, adds to full cost picture
  let servicesMonthly = 0;
  let servicesList = '';
  try {
    const { results: services } = await env.DB.prepare(
      `SELECT name, monthly_cost FROM property_services WHERE property_id = ? ORDER BY monthly_cost DESC`
    ).bind(propertyId).all();
    if (services && services.length > 0) {
      servicesMonthly = services.reduce((a, s) => a + (s.monthly_cost || 0), 0);
      servicesList = services.map(s => `${s.name} $${s.monthly_cost}/mo`).join(', ');
    }
  } catch (e) { syslog(env, 'error', 'generateRevenueOptimization', 'L3966', e.message); }

  // Previous reports — read-only, gives AI continuity without re-reading its own DB writes back into pipeline
  let prevOptContext = '';
  try {
    const prevOpt = await env.DB.prepare(
      `SELECT report_data, provider, created_at FROM analysis_reports
       WHERE property_id = ? AND report_type = 'revenue_optimization' ORDER BY created_at DESC LIMIT 1`
    ).bind(propertyId).first();
    if (prevOpt && prevOpt.report_data) {
      const opt = JSON.parse(prevOpt.report_data);
      const o = opt.optimization || {};
      prevOptContext = `\nPREVIOUS OPTIMIZATION (${prevOpt.created_at ? prevOpt.created_at.substring(0,10) : 'prior'}, by ${prevOpt.provider || 'AI'}):\n`;
      if (o.quick_wins && o.quick_wins.length > 0) prevOptContext += `  Prior quick wins: ${o.quick_wins.slice(0,3).join(' | ')}\n`;
      if (o.target_monthly_revenue) prevOptContext += `  Prior target: $${o.target_monthly_revenue}/mo (+${o.revenue_increase_pct || '?'}%)\n`;
      prevOptContext += `  Review whether prior recommendations were acted on, and assess if targets were met based on current Guesty actuals.\n`;
    }
  } catch (e) { syslog(env, 'error', 'generateRevenueOptimization', 'L3983', e.message); }

  let prevStratContext = '';
  try {
    const prevStrat = await env.DB.prepare(
      `SELECT report_data, created_at FROM analysis_reports
       WHERE property_id = ? AND report_type = 'pl_strategy' ORDER BY created_at DESC LIMIT 1`
    ).bind(propertyId).first();
    if (prevStrat && prevStrat.report_data) {
      const ps = JSON.parse(prevStrat.report_data);
      const s = ps.strategy || {};
      if (s.base_price) {
        prevStratContext = `\nPREVIOUS PRICELABS STRATEGY (${prevStrat.created_at ? prevStrat.created_at.substring(0,10) : 'prior'}): `;
        prevStratContext += `Base $${s.base_price}/nt | Proj $${s.projected_monthly_revenue || '?'}/mo | Occ ${Math.round((s.projected_occupancy || 0) * 100)}%\n`;
        prevStratContext += `  Consider whether actual Guesty performance aligns with what that strategy projected.\n`;
      }
    }
  } catch (e) { syslog(env, 'error', 'generateRevenueOptimization', 'L4000', e.message); }

  let plData = null;
  const plLink = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();
  if (plLink) {
    let channels = [];
    try { channels = plLink.channel_details ? JSON.parse(plLink.channel_details) : []; } catch (e) { syslog(env, 'error', 'generateRevenueOptimization', 'L4006', e.message); }
    plData = plLink;
    plData.channels = channels;
  }

  const baseCost = property.ownership_type === 'rental'
    ? (property.monthly_rent_cost || 0)
    : (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0);
  const utilities = (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0);
  const monthlyCost = baseCost + utilities + servicesMonthly;
  const cleaningFee = property.cleaning_fee || (plData ? plData.cleaning_fees : 0) || 0;
  const cleaningCost = property.cleaning_cost || 0;

  // Structured listing audit from DB data — replaces fragile HTML scraping
  // Airbnb/VRBO actively block scrapes; HTML parsing was producing mostly empty strings
  // Instead, derive listing quality signals from what we have stored
  const listingAudit = [];
  for (const plat of platforms) {
    const audit = {
      platform: plat.platform,
      has_url: !!plat.listing_url,
      rating: plat.rating || null,
      review_count: plat.review_count || 0,
      nightly_rate: plat.nightly_rate || null,
      has_description: !!plat.description,
    };
    listingAudit.push(
      `${plat.platform}: ${plat.rating ? plat.rating + '★ (' + plat.review_count + ' reviews)' : 'no rating'} | ` +
      `Rate: ${plat.nightly_rate ? '$' + plat.nightly_rate + '/nt' : 'not stored'} | ` +
      `URL: ${plat.listing_url ? 'linked' : 'missing'}`
    );
  }

  const currentRev = plData && plData.base_price && plData.occupancy_next_30
    ? Math.round(plData.base_price * 30 * parseInt(plData.occupancy_next_30) / 100)
    : (strategies[0] ? strategies[0].projected_monthly_avg : 0);

  const prompt = `You are an expert STR revenue optimization consultant. A property owner wants to INCREASE their occupancy and revenue. Analyze their current performance and give specific, actionable recommendations.

CRITICAL PRICING RULE: If occupancy is ALREADY HIGH (above market average), DO NOT recommend lowering prices to increase occupancy — the property is already booking well at current rates. Instead focus on RAISING rates since demand supports it. Only recommend price reductions if occupancy is BELOW market average and bookings are suffering.

PROPERTY: ${property.address}, ${property.city}, ${property.state} | ${property.property_type} | ${property.bedrooms}BR/${property.bathrooms}BA | ${property.sqft || '?'}sqft
${property.rental_restrictions ? 'RESTRICTIONS: ' + property.rental_restrictions + ' — recommendations MUST comply with these constraints\n' : ''}${property.ai_notes ? 'OPERATOR NOTES: ' + property.ai_notes + '\n' : ''}
CURRENT PERFORMANCE:
${plData ? `  PriceLabs Base Price: $${plData.base_price}/nt | Recommended: $${plData.recommended_base_price}/nt
  Min: $${plData.min_price} | Max: $${plData.max_price} | Cleaning: $${plData.cleaning_fees}
  YOUR 7d Occupancy: ${plData.occupancy_next_7} | MARKET: ${plData.market_occupancy_next_7}
  YOUR 30d Occupancy: ${plData.occupancy_next_30} | MARKET: ${plData.market_occupancy_next_30}
  YOUR 60d Occupancy: ${plData.occupancy_next_60} | MARKET: ${plData.market_occupancy_next_60}
  OCCUPANCY ANALYSIS: ${plData.occupancy_next_30 && plData.market_occupancy_next_30 ? (parseInt(plData.occupancy_next_30) > parseInt(plData.market_occupancy_next_30) ? 'You are OUTPERFORMING the market by ' + (parseInt(plData.occupancy_next_30) - parseInt(plData.market_occupancy_next_30)) + ' points — this means demand is strong and you should consider RAISING prices, not lowering them.' : 'You are UNDERPERFORMING the market by ' + (parseInt(plData.market_occupancy_next_30) - parseInt(plData.occupancy_next_30)) + ' points — consider adjusting pricing or improving listing quality.') : 'No market comparison available.'}
  Strategy Group: ${plData.group_name || 'Default'}
  Push Enabled: ${plData.push_enabled ? 'YES' : 'NO'} | Last Pushed: ${plData.last_date_pushed || 'never'}` : '  No PriceLabs data — recommend connecting PriceLabs first.'}

MONTHLY EXPENSES: $${Math.round(monthlyCost)}/mo total
  ${(property.is_managed === 1 || property.ownership_type === 'managed') ? 'MANAGED for ' + (property.owner_name || 'Owner') + ' @ ' + (property.management_fee_pct || 0) + '% of ' + ((property.fee_basis || 'gross') === 'net_profit' ? 'net profit' : 'gross') : property.ownership_type === 'rental' ? 'Rent: $' + (property.monthly_rent_cost || 0) : 'Mortgage: $' + (property.monthly_mortgage || 0) + ' | Insurance: $' + (property.monthly_insurance || 0) + ' | Taxes: $' + Math.round((property.annual_taxes || 0) / 12) + '/mo | HOA: $' + (property.hoa_monthly || 0)}
  Utilities: $${Math.round(utilities)}/mo${servicesMonthly > 0 ? '\n  Services: ' + servicesList + ' ($' + Math.round(servicesMonthly) + '/mo)' : ''}
CURRENT PROJECTED REVENUE: $${currentRev}/mo (${currentRev > monthlyCost ? 'profitable, net +$' + (currentRev - monthlyCost) + '/mo' : 'LOSING $' + (monthlyCost - currentRev) + '/mo'})

PLATFORMS: ${listingAudit.length > 0 ? listingAudit.join('\n  ') : 'None linked'}
${platforms.length === 0 ? 'WARNING: No platforms linked — listing on Airbnb and VRBO at minimum is strongly recommended.\n' : ''}
LISTING QUALITY ASSESSMENT (based on stored data — use your knowledge of ${property.city}, ${property.state} STR market to add specific suggestions):
  Property type: ${property.property_type} | ${property.bedrooms}BR/${property.bathrooms}BA | ${property.sqft || '?'}sqft
  Amenities tracked: ${amenities.length > 0 ? amenities.map(a => a.name).join(', ') : 'None — recommend adding amenities for better pricing accuracy'}
  Platform ratings: ${platforms.filter(p => p.rating).map(p => p.platform + ' ' + p.rating + '★ (' + (p.review_count || 0) + ' reviews)').join(', ') || 'No ratings stored'}
  Based on property type and location, assess: typical listing title quality for this market, recommended photo count, description must-haves, and common amenity gaps for ${property.bedrooms}BR ${property.property_type}s in ${property.city}.

AMENITIES: ${amenities.map(a => a.name).join(', ') || 'None listed'}

CLEANING ECONOMICS: Guest pays $${cleaningFee}/stay | You pay $${cleaningCost || '? (not set)'}/turnover | ${cleaningFee > 0 && cleaningCost > 0 ? (cleaningFee > cleaningCost ? 'Net +$' + (cleaningFee - cleaningCost) + '/turnover' : 'LOSING $' + (cleaningCost - cleaningFee) + '/turnover on cleaning') : 'Set cleaning cost in property settings for margin analysis'}

COMPS: ${comparables.slice(0, 5).map(c => (c.bedrooms || '?') + 'BR $' + (c.nightly_rate || 0) + '/nt' + (c.rating ? ' ' + c.rating + '★' : '')).join(' | ') || 'None'}

PREVIOUS STRATEGIES: ${strategies.slice(0, 2).map(s => s.strategy_name + ': $' + s.base_nightly_rate + '/nt, ' + Math.round(s.projected_occupancy * 100) + '% occ, $' + Math.round(s.projected_monthly_avg) + '/mo').join(' | ') || 'None'}

${await getGuestyActualsForPrompt(propertyId, property.city, property.state, env)}
${await getGuestIntelForPrompt(propertyId, property.city, property.state, env)}
${await getMonthlyTargetsForPrompt(propertyId, property, env)}
${await getMarketAndTrendContextForPrompt(propertyId, property, env)}
${getPriceLabsCustomizationsForPrompt(property)}
${prevOptContext}${prevStratContext}
DATA INTEGRITY NOTE: All Guesty actuals above use only confirmed and closed reservations. The current calendar month is flagged as partial — do not treat partial-month figures as representative of full-month performance. Base your occupancy gap analysis on completed months only.

Respond ONLY with JSON (no markdown):
{
  "current_monthly_revenue": ${currentRev},
  "current_occupancy_pct": ${plData && plData.occupancy_next_30 ? parseInt(plData.occupancy_next_30) : 40},
  "target_occupancy_pct": N,
  "target_monthly_revenue": N,
  "revenue_increase_pct": N,
  "occupancy_improvements": [
    {"action": "specific action", "impact": "expected % or $ impact", "effort": "low/medium/high", "priority": 1}
  ],
  "revenue_improvements": [
    {"action": "specific action", "impact": "expected $ impact", "effort": "low/medium/high", "priority": 1}
  ],
  "pricing_adjustments": [
    {"setting": "PriceLabs setting name", "current": "current value", "recommended": "new value", "reason": "why"}
  ],
  "listing_improvements": ["specific improvement 1", "improvement 2"],
  "listing_health": {
    "photos": {"assessment": "good/needs_work/critical", "recommendation": "specific photo advice for this property"},
    "description": {"assessment": "good/needs_work/critical", "suggested_opener": "Write a compelling 1-2 sentence opener for this specific listing", "issues": ["issue 1"]},
    "amenities": {"assessment": "good/needs_work/critical", "missing_high_impact": ["amenity 1"], "recommendation": "specific amenity advice"},
    "reviews": {"strategy": "specific review-building advice", "target": "target review count"},
    "pricing_position": {"assessment": "good/needs_work/critical", "recommendation": "specific pricing position advice vs market"}
  },
  "guest_experience_improvements": ["improvement 1", "improvement 2"],
  "quick_wins": ["something you can do today", "another quick win"],
  "ninety_day_plan": "PLAIN TEXT ONLY — Write 3-4 sentences summarizing the 90-day action plan. Do NOT repeat the JSON structure here. Example: 'Month 1: Focus on listing VRBO and raising base price to $170. Month 2: Add pet fees and weekend premiums. Month 3: Target extended stays with monthly discounts. Expected result: revenue increase from $1,000 to $2,000/mo.'"
}`;

  const aiResult = await callAIWithFallback(env, 'revenue_optimization', prompt, 3000, 3000);
  if (!aiResult) return json({ error: 'No AI provider available. Configure ANTHROPIC_API_KEY or OPENAI_API_KEY in API Keys settings, or ensure Workers AI is enabled.' }, 400);
  const aiResponse = aiResult.text;
  const provider = aiResult.provider;

  try {
    let jsonStr = aiResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const fb = jsonStr.indexOf('{'); const lb = jsonStr.lastIndexOf('}');
    if (fb >= 0 && lb > fb) jsonStr = jsonStr.substring(fb, lb + 1);
    // Clean common JSON issues from AI responses
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    // Handle newlines inside JSON string values — replace with spaces ONLY inside quoted strings
    // First pass: try parsing as-is (AI might return valid JSON)
    let result;
    try { result = JSON.parse(jsonStr); } catch {
      // Second pass: aggressively clean — replace all control chars with spaces
      jsonStr = jsonStr.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/,\s*([}\]])/g, '$1');
      try { result = JSON.parse(jsonStr); } catch {
        // Third pass: try to fix unescaped quotes inside values
        jsonStr = jsonStr.replace(/"([^"]*)":\s*"((?:[^"\\]|\\.)*)"/g, function(m) { return m; }); // preserve valid
        jsonStr = jsonStr.replace(/\t/g, ' ');
        result = JSON.parse(jsonStr);
      }
    }
    // Post-parse cleanup: if ninety_day_plan is JSON or code-fenced, fix it
    if (result.ninety_day_plan && typeof result.ninety_day_plan === 'string') {
      const planStr = result.ninety_day_plan.trim();
      if (planStr.startsWith('{') || planStr.startsWith('```')) {
        // AI stuffed JSON into the plan field — replace with a summary
        result.ninety_day_plan = null;
        // Try to generate a summary from the structured data we DO have
        const parts = [];
        if (result.quick_wins && result.quick_wins.length > 0) parts.push('Quick wins: ' + result.quick_wins[0]);
        if (result.occupancy_improvements && result.occupancy_improvements.length > 0) parts.push('Priority: ' + result.occupancy_improvements[0].action.substring(0, 120));
        if (result.target_monthly_revenue) parts.push('Target: $' + result.target_monthly_revenue + '/mo (' + (result.revenue_increase_pct || 0) + '% increase).');
        if (parts.length > 0) result.ninety_day_plan = parts.join('. ');
      }
    }
    const response = { optimization: result, property: { id: property.id, address: property.address, city: property.city }, monthly_expenses: monthlyCost, provider };
    try {
      await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'revenue_optimization', ?, ?)`)
        .bind(propertyId, JSON.stringify(response), provider).run();
      // Also save listing_health as its own report if the AI returned it
      if (result.listing_health) {
        try {
          await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'listing_health', ?, ?)`)
            .bind(propertyId, JSON.stringify(result.listing_health), provider).run();
        } catch (e) { syslog(env, 'error', 'generateRevenueOptimization', 'L4164', e.message); }
      }
    } catch (e) { syslog(env, 'error', 'generateRevenueOptimization', 'L4166', e.message); }
    return json(response);
  } catch (e) {
    // Fallback: try to extract structured data from raw response even if JSON parsing failed
    const raw = aiResponse.substring(0, 4000);
    let quickWins = [];
    let plan = raw;
    // Try to pull quick_wins array even from broken JSON
    const qwMatch = raw.match(/"quick_wins"\s*:\s*\[([\s\S]*?)\]/);
    if (qwMatch) {
      try { quickWins = JSON.parse('[' + qwMatch[1] + ']'); } catch { quickWins = qwMatch[1].split(',').map(s => s.replace(/"/g, '').trim()).filter(Boolean); }
    }
    // Try to pull ninety_day_plan
    const planMatch = raw.match(/"ninety_day_plan"\s*:\s*"([\s\S]*?)(?:"\s*[,}])/);
    if (planMatch) plan = planMatch[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
    // Try to pull occupancy_improvements
    let occImprovements = [];
    const occMatch = raw.match(/"occupancy_improvements"\s*:\s*\[([\s\S]*?)\]/);
    if (occMatch) {
      try { occImprovements = JSON.parse('[' + occMatch[1] + ']'); } catch (e) { syslog(env, 'error', 'generateRevenueOptimization', 'L4185', e.message); }
    }

    const fallback = { optimization: { ninety_day_plan: plan, quick_wins: quickWins.length > 0 ? quickWins : ['See 90-day plan below for recommendations'], occupancy_improvements: occImprovements, current_monthly_revenue: 0, current_occupancy_pct: 0 }, property: { id: property.id }, monthly_expenses: monthlyCost, provider, parse_error: e.message };
    return json(fallback);
  }
}

async function getListingHealth(propertyId, env) {
  try {
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);

  // ── 1. Photos ──────────────────────────────────────────────────────────
  const { results: images } = await env.DB.prepare(`SELECT id, image_url, caption, source FROM property_images WHERE property_id = ? ORDER BY sort_order, id`).bind(propertyId).all();
  const gl = await env.DB.prepare(
    `SELECT listing_description, listing_pictures_json, listing_thumbnail, listing_name
     FROM guesty_listings WHERE property_id = ?`
  ).bind(propertyId).first();

  let guestyPhotos = [];
  if (gl && gl.listing_pictures_json) {
    try { guestyPhotos = JSON.parse(gl.listing_pictures_json); } catch {}
  }
  if (gl && gl.listing_thumbnail && !guestyPhotos.includes(gl.listing_thumbnail)) {
    guestyPhotos.unshift(gl.listing_thumbnail);
  }
  const totalPhotos = Math.max(images.length, guestyPhotos.length);
  const photoScore = totalPhotos >= 25 ? 100 : totalPhotos >= 20 ? 85 : totalPhotos >= 15 ? 65 : totalPhotos >= 10 ? 45 : totalPhotos >= 5 ? 25 : totalPhotos > 0 ? 10 : 0;

  // Detect missing photo types based on captions
  const captionText = images.map(i => (i.caption || '').toLowerCase()).join(' ') + ' ' + (gl && gl.listing_description ? gl.listing_description.toLowerCase() : '');
  const photoTypes = ['bedroom', 'bathroom', 'kitchen', 'living', 'exterior', 'pool', 'view', 'dining', 'patio', 'entrance'];
  const missingPhotoTypes = photoTypes.filter(t => !captionText.includes(t)).slice(0, 5);

  // ── 2. Description ─────────────────────────────────────────────────────
  const description = (gl && gl.listing_description) || '';
  const descLength = description.length;
  const descScore = descLength >= 800 ? 100 : descLength >= 500 ? 75 : descLength >= 300 ? 50 : descLength >= 100 ? 25 : 0;
  const descIssues = [];
  if (descLength < 200) descIssues.push('Too short — aim for 500-1000 characters');
  if (descLength > 0 && !description.match(/wifi|wi-fi|internet/i)) descIssues.push('No mention of WiFi/internet');
  if (descLength > 0 && !description.match(/check.?in|self.?check/i)) descIssues.push('No check-in process mentioned');
  if (descLength > 0 && !description.match(/locat|near|minutes?\s+(from|to|walk)|neighborhood|downtown|beach/i)) descIssues.push('No location/neighborhood details');

  // ── 3. Amenities ───────────────────────────────────────────────────────
  const { results: amenities } = await env.DB.prepare(`SELECT a.name, a.category FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(propertyId).all();
  const amenityNames = amenities.map(a => (a.name || '').toLowerCase());
  const highImpactAmenities = ['WiFi', 'Air Conditioning', 'Kitchen', 'Washer', 'Dryer', 'Free Parking', 'TV', 'Pool', 'Hot Tub', 'Self Check-in'];
  const missingHighImpact = highImpactAmenities.filter(a => !amenityNames.some(n => n.includes(a.toLowerCase())));
  const amenityScore = amenities.length >= 20 ? 100 : amenities.length >= 15 ? 80 : amenities.length >= 10 ? 60 : amenities.length >= 5 ? 35 : amenities.length > 0 ? 15 : 0;

  // ── 4. Reviews / Platforms ─────────────────────────────────────────────
  const { results: platforms } = await env.DB.prepare(`SELECT platform, rating, review_count, nightly_rate FROM property_platforms WHERE property_id = ? ORDER BY platform`).bind(propertyId).all();
  const totalReviews = platforms.reduce((s, p) => s + (p.review_count || 0), 0);
  const avgRating = platforms.filter(p => p.rating).length > 0 ? (platforms.reduce((s, p) => s + (p.rating || 0), 0) / platforms.filter(p => p.rating).length) : 0;
  const reviewScore = totalReviews >= 50 ? 100 : totalReviews >= 25 ? 80 : totalReviews >= 10 ? 55 : totalReviews >= 5 ? 35 : totalReviews > 0 ? 15 : 0;
  const ratingScore = avgRating >= 4.8 ? 100 : avgRating >= 4.5 ? 80 : avgRating >= 4.2 ? 55 : avgRating >= 4.0 ? 35 : avgRating > 0 ? 15 : 0;

  // ── 5. Platform coverage ───────────────────────────────────────────────
  const platformNames = platforms.map(p => (p.platform || '').toLowerCase());
  const idealPlatforms = ['airbnb', 'vrbo', 'booking.com'];
  const missingPlatforms = idealPlatforms.filter(p => !platformNames.some(n => n.includes(p)));
  const platformScore = platforms.length >= 3 ? 100 : platforms.length === 2 ? 65 : platforms.length === 1 ? 35 : 0;

  // ── 6. Overall score ───────────────────────────────────────────────────
  const overallScore = Math.round(
    photoScore * 0.25 + descScore * 0.15 + amenityScore * 0.15 +
    reviewScore * 0.15 + ratingScore * 0.15 + platformScore * 0.15
  );

  // ── 7. Load latest AI recommendations if available ─────────────────────
  let aiRecommendations = null;
  try {
    const aiReport = await env.DB.prepare(
      `SELECT report_data, provider, created_at FROM analysis_reports
       WHERE property_id = ? AND report_type = 'listing_health'
       ORDER BY created_at DESC LIMIT 1`
    ).bind(propertyId).first();
    if (aiReport) {
      try { aiRecommendations = JSON.parse(aiReport.report_data); aiRecommendations._created_at = aiReport.created_at; aiRecommendations._provider = aiReport.provider; } catch {}
    }
    // Fallback: try extracting from latest revenue_optimization report
    if (!aiRecommendations) {
      const revOpt = await env.DB.prepare(
        `SELECT report_data FROM analysis_reports
         WHERE property_id = ? AND report_type = 'revenue_optimization'
         ORDER BY created_at DESC LIMIT 1`
      ).bind(propertyId).first();
      if (revOpt) {
        try {
          const rd = JSON.parse(revOpt.report_data);
          const opt = rd.optimization || rd;
          if (opt.listing_health || opt.listing_improvements) {
            aiRecommendations = { from_rev_opt: true, listing_health: opt.listing_health || null, listing_improvements: opt.listing_improvements || [] };
          }
        } catch {}
      }
    }
  } catch {}

  return json({
    property_id: parseInt(propertyId),
    overall_score: overallScore,
    categories: {
      photos: {
        score: photoScore,
        count: totalPhotos,
        local_count: images.length,
        guesty_count: guestyPhotos.length,
        target: 25,
        missing_types: missingPhotoTypes,
        status: photoScore >= 70 ? 'good' : photoScore >= 40 ? 'needs_work' : 'critical'
      },
      description: {
        score: descScore,
        current_length: descLength,
        target_length: 800,
        issues: descIssues,
        preview: description.substring(0, 200) + (descLength > 200 ? '...' : ''),
        has_description: descLength > 0,
        status: descScore >= 70 ? 'good' : descScore >= 40 ? 'needs_work' : 'critical'
      },
      amenities: {
        score: amenityScore,
        count: amenities.length,
        target: 20,
        missing_high_impact: missingHighImpact,
        status: amenityScore >= 70 ? 'good' : amenityScore >= 40 ? 'needs_work' : 'critical'
      },
      reviews: {
        score: reviewScore,
        total_count: totalReviews,
        avg_rating: Math.round(avgRating * 10) / 10,
        rating_score: ratingScore,
        per_platform: platforms.map(p => ({ platform: p.platform, rating: p.rating, count: p.review_count || 0 })),
        target_count: 50,
        status: reviewScore >= 70 ? 'good' : reviewScore >= 40 ? 'needs_work' : 'critical'
      },
      platform_coverage: {
        score: platformScore,
        active_count: platforms.length,
        platforms: platforms.map(p => ({ name: p.platform, rate: p.nightly_rate })),
        missing: missingPlatforms,
        status: platformScore >= 70 ? 'good' : platformScore >= 40 ? 'needs_work' : 'critical'
      }
    },
    ai_recommendations: aiRecommendations
  });
  } catch (e) {
    return json({ error: 'Failed to load listing health: ' + (e.message || 'unknown error'), categories: null }, 500);
  }
}

async function generateAcquisitionAnalysis(propertyId, request, env) {
  const body = await request.json().catch(() => ({}));
  let considerations = body.considerations || '';
  // Also load saved considerations from DB
  if (!considerations) {
    try { const saved = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('acq_notes_' + propertyId).first(); if (saved && saved.value) considerations = saved.value; } catch {}
  }
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);
  const { results: amenities } = await env.DB.prepare(`SELECT a.* FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(propertyId).all();
  const { results: comparables } = await env.DB.prepare(`SELECT * FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC LIMIT 15`).bind(propertyId).all();
  const market = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC LIMIT 1`).bind(property.city, property.state).first();
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ?`).bind(propertyId).all();
  const { results: strategies } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC LIMIT 3`).bind(propertyId).all();

  // Previous analysis for context
  const prevReport = await env.DB.prepare(`SELECT report_data FROM analysis_reports WHERE property_id = ? AND report_type = 'acquisition_analysis' ORDER BY created_at DESC LIMIT 1`).bind(propertyId).first();
  let prevAnalysis = '';
  if (prevReport) {
    try { const pd = JSON.parse(prevReport.report_data); prevAnalysis = pd.analysis ? JSON.stringify(pd.analysis).substring(0, 1000) : ''; } catch {}
  }

  // Look at similar properties in the portfolio for real performance data
  const { results: similar } = await env.DB.prepare(`SELECT p.*, pl.base_price as pl_base, pl.occupancy_next_30 as pl_occ, pl.market_occupancy_next_30 as pl_mkt_occ, pl.cleaning_fees as pl_clean FROM properties p LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id WHERE LOWER(p.city) = LOWER(?) AND LOWER(p.state) = LOWER(?) AND p.id != ? AND p.is_research != 1`).bind(property.city, property.state, propertyId).all();

  // Get services
  let svcCost = 0;
  let svcList = [];
  try { const { results: svcs } = await env.DB.prepare(`SELECT name, monthly_cost FROM property_services WHERE property_id = ?`).bind(propertyId).all(); for (const s of (svcs||[])) { svcCost += s.monthly_cost; svcList.push(s.name + ' $' + s.monthly_cost); } } catch {}

  // PriceLabs data for this property
  const plLink = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();

  // Performance history
  const { results: snapshots } = await env.DB.prepare(`SELECT snapshot_date, blended_adr, est_monthly_revenue, est_monthly_net FROM performance_snapshots WHERE property_id = ? ORDER BY snapshot_date DESC LIMIT 5`).bind(propertyId).all();

  // All market data for this city
  const { results: allMarket } = await env.DB.prepare(`SELECT avg_daily_rate, median_daily_rate, active_listings, snapshot_date FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC LIMIT 5`).bind(property.city, property.state).all();

  // Master listings in area (real comps from crawls)
  const { results: masterComps } = await env.DB.prepare(`SELECT title, bedrooms, nightly_rate, rating, review_count, listing_type FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND status = 'active' ORDER BY review_count DESC LIMIT 10`).bind(property.city, property.state).all();

  // Revenue optimization report if exists
  const revOptReport = await env.DB.prepare(`SELECT report_data FROM analysis_reports WHERE property_id = ? AND report_type = 'revenue_optimization' ORDER BY created_at DESC LIMIT 1`).bind(propertyId).first();
  let revOptData = '';
  if (revOptReport) { try { const ro = JSON.parse(revOptReport.report_data); if (ro.optimization) revOptData = 'Rev target: $' + (ro.optimization.target_monthly_revenue || '?') + '/mo, Quick wins: ' + (ro.optimization.quick_wins || []).slice(0, 3).join('; '); } catch {} }

  // PL strategy report if exists
  const plStratReport = await env.DB.prepare(`SELECT report_data FROM analysis_reports WHERE property_id = ? AND report_type = 'pl_strategy' ORDER BY created_at DESC LIMIT 1`).bind(propertyId).first();
  let plStratData = '';
  if (plStratReport) { try { const ps = JSON.parse(plStratReport.report_data); if (ps.strategy) plStratData = 'Strategy: $' + (ps.strategy.base_price || '?') + '/nt, occ ' + (ps.strategy.projected_occupancy ? Math.round(ps.strategy.projected_occupancy * 100) : '?') + '%, rev $' + (ps.strategy.projected_monthly_revenue || '?') + '/mo'; } catch {} }

  // Guesty actual revenue data
  let guestyActuals = '';
  try {
    const { results: actuals } = await env.DB.prepare(`SELECT month, booked_nights, available_nights, occupancy_pct, total_revenue, avg_nightly_rate, host_payout FROM monthly_actuals WHERE property_id = ? ORDER BY month`).bind(propertyId).all();
    if (actuals && actuals.length > 0) {
      const totalRev = actuals.reduce((a, m) => a + (m.total_revenue || 0), 0);
      const totalNights = actuals.reduce((a, m) => a + (m.booked_nights || 0), 0);
      const totalAvail = actuals.reduce((a, m) => a + (m.available_nights || 30), 0);
      guestyActuals = actuals.length + ' months of REAL booking data. Avg monthly: $' + Math.round(totalRev / actuals.length) + '. Annual: $' + Math.round(totalRev) + '. Avg occ: ' + (totalAvail > 0 ? Math.round(totalNights / totalAvail * 100) : 0) + '%. Avg ADR: $' + (totalNights > 0 ? Math.round(totalRev / totalNights) : 0) + '/nt.\n' +
        'Monthly breakdown: ' + actuals.slice(-12).map(a => a.month + ': $' + Math.round(a.total_revenue || 0) + ' (' + Math.round((a.occupancy_pct || 0) * 100) + '% occ, $' + Math.round(a.avg_nightly_rate || 0) + '/nt)').join(' | ');
    }
  } catch {}

  // Seasonality for this market
  let seasonalityData = '';
  try {
    if (property.city && property.state) {
      const { results: season } = await env.DB.prepare(`SELECT month_number, avg_occupancy, avg_adr, multiplier FROM market_seasonality WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY month_number`).bind(property.city, property.state).all();
      if (season && season.length >= 6) {
        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        seasonalityData = season.map(s => monthNames[(s.month_number || 1) - 1] + ': ' + (s.multiplier || 1).toFixed(1) + 'x ($' + Math.round(s.avg_adr || 0) + '/nt, ' + Math.round((s.avg_occupancy || 0) * 100) + '% occ)').join(' | ');
      }
    }
  } catch {}

  const monthlyCost = (property.ownership_type === 'rental' ? (property.monthly_rent_cost || 0) : (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0)) + (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0) + svcCost;

  // Web search for actual regulations and market data
  let regData = '', areaData = '', saleCompsData = '';
  if (env.SEARCHAPI_KEY) {
    try {
      await trackApiCall(env, 'searchapi', 'acq_regulations', true);
      const regResp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({ engine: 'google', q: property.city + ' ' + property.state + ' short term rental regulations permit requirements 2024 2025' }).toString(), { headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY } });
      if (regResp.ok) {
        const regJson = await regResp.json();
        regData = (regJson.answer_box?.snippet || '') + ' ' + (regJson.organic_results || []).slice(0, 3).map(r => r.snippet || '').join(' ');
      }
    } catch {}
    try {
      await trackApiCall(env, 'searchapi', 'acq_market', true);
      const mktResp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({ engine: 'google', q: property.city + ' ' + property.state + ' real estate market trends development tourism employers 2025' }).toString(), { headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY } });
      if (mktResp.ok) {
        const mktJson = await mktResp.json();
        areaData = (mktJson.answer_box?.snippet || '') + ' ' + (mktJson.organic_results || []).slice(0, 3).map(r => r.snippet || '').join(' ');
      }
    } catch {}
    // Search for properties for sale nearby
    saleCompsData = '';
    try {
      await trackApiCall(env, 'searchapi', 'acq_sales', true);
      const saleResp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({ engine: 'google', q: property.bedrooms + ' bedroom house for sale ' + property.city + ' ' + property.state + ' ' + (property.zip || '') }).toString(), { headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY } });
      if (saleResp.ok) {
        const saleJson = await saleResp.json();
        saleCompsData = (saleJson.organic_results || []).slice(0, 6).map(r => {
          const priceM = (r.snippet || '').match(/\$([\d,]+)/);
          return (r.title || '').substring(0, 100) + (priceM ? ' — $' + priceM[1] : '') + (r.link ? ' | URL: ' + r.link : '');
        }).join('\n');
      }
    } catch {}
  }

  const prompt = `You are a senior real estate investment analyst preparing a COMPREHENSIVE ACQUISITION REPORT. This report must be DETAILED and THOROUGH — it will be used to make a real $${property.purchase_price || property.estimated_value || '500,000'}+ investment decision.

CRITICAL RULES:
- EVERY field in the JSON must be filled with detailed, specific content. Do NOT leave fields empty or generic.
- DO NOT CONTRADICT YOURSELF. If regulations say STR is allowed, do NOT put "city bans STR" in deal_breakers.
- Deal breakers must be REAL factual risks, not hypothetical regulatory fears.
- If you don't know a regulation, set it to "unknown" — do NOT guess.
- All numbers must be realistic and consistent with each other.
- The "upgrades" array MUST have at least 3-4 specific upgrades with realistic costs and ROI.
- "str_comps" MUST have 3+ comparable STR properties. "ltr_comps" MUST have 2+ LTR comps.
- "summary" must be 3-4 detailed sentences. "recommendation" must be 5-6 sentences.
- "market_outlook" and "comparable_performance" must each be 3-4 sentences with specific data.
- "area_demand.str_demand_drivers" must list 3+ specific things that bring visitors.
- "area_demand.ltr_demand_drivers" must list 3+ specific things that bring renters.
- "regulations.notes" must be 2-3 sentences about specific local rules.
${considerations ? '\nIMPORTANT — THE INVESTOR HAS SPECIFIC NOTES THAT MUST BE ADDRESSED IN YOUR ANALYSIS:\n"' + considerations + '"\nYou MUST directly address each of these points in your summary and recommendation.' : ''}

PROPERTY:
  Address: ${property.address}, ${property.city}, ${property.state} ${property.zip || ''}
  Type: ${property.property_type} | ${property.bedrooms}BR/${property.bathrooms}BA | ${property.sqft || '?'}sqft | Year: ${property.year_built || '?'}
  Lot: ${property.lot_acres || '?'} acres | Stories: ${property.stories || '?'} | Parking: ${property.parking_spaces || '?'}
  ${property.listing_url ? 'Listing: ' + property.listing_url : ''}
  Purchase Price: $${property.purchase_price || '?'} | Est. Value: $${property.estimated_value || '?'}
  ${property.ownership_type === 'rental' ? 'MODEL: Rental arbitrage — Rent: $' + (property.monthly_rent_cost || '?') + '/mo' : 'MODEL: Purchase — Mortgage: $' + (property.monthly_mortgage || 0) + '/mo'}
${property.hoa_name ? '  HOA/Community: ' + property.hoa_name : ''}
${property.rental_restrictions ? '  RENTAL RESTRICTIONS: ' + property.rental_restrictions + ' — analysis MUST account for these' : ''}
${property.ai_notes ? '  OPERATOR NOTES: ' + property.ai_notes : ''}

MONTHLY COSTS: $${monthlyCost}/mo total
  ${(property.is_managed === 1 || property.ownership_type === 'managed') ? 'MANAGED for ' + (property.owner_name || 'Owner') + ' @ ' + (property.management_fee_pct || 0) + '% of ' + ((property.fee_basis || 'gross') === 'net_profit' ? 'net profit' : 'gross') : property.ownership_type === 'rental' ? 'Rent: $' + (property.monthly_rent_cost || 0) : 'Mortgage: $' + (property.monthly_mortgage || 0) + ' | Insurance: $' + (property.monthly_insurance || 0) + ' | Taxes: $' + Math.round((property.annual_taxes || 0) / 12) + '/mo | HOA: $' + (property.hoa_monthly || 0)}
  Utilities: $${(property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0)}/mo
  Services: $${svcCost}/mo

AMENITIES: ${amenities.map(a => a.name).join(', ') || 'None identified'}
MARKET: ${market ? 'Avg rent $' + (market.avg_daily_rate || '?') + '/mo | Active listings: ' + (market.active_listings || '?') : 'No market data'}
COMPS: ${comparables.slice(0, 8).map(c => (c.bedrooms || '?') + 'BR $' + (c.nightly_rate || 0) + (c.comp_type === 'ltr' ? '/mo' : '/nt') + (c.rating ? ' ' + c.rating + '★' : '') + ' [' + (c.comp_type || 'str') + ']').join(' | ') || 'None'}
PLATFORMS: ${platforms.map(p => p.platform + (p.nightly_rate ? ' $' + p.nightly_rate + '/nt' : '') + (p.rating ? ' ' + p.rating + '★' : '')).join(', ') || 'None'}
STRATEGIES: ${strategies.slice(0, 2).map(s => s.strategy_name + ': $' + s.base_nightly_rate + '/nt, ' + Math.round(s.projected_occupancy * 100) + '% occ, $' + Math.round(s.projected_monthly_avg) + '/mo').join(' | ') || 'None'}
${plLink ? 'PRICELABS LIVE DATA: Base $' + (plLink.base_price || '?') + '/nt | Rec $' + (plLink.recommended_base_price || '?') + '/nt | Min $' + (plLink.min_price || '?') + ' Max $' + (plLink.max_price || '?') + ' | Occ 30d: ' + (plLink.occupancy_next_30 || '?') + ' (mkt: ' + (plLink.market_occupancy_next_30 || '?') + ')' : ''}
${snapshots.length > 0 ? 'PERFORMANCE HISTORY: ' + snapshots.map(s => s.snapshot_date + ': ADR $' + (s.blended_adr || 0) + ', Rev $' + (s.est_monthly_revenue || 0) + ', Net $' + (s.est_monthly_net || 0)).join(' | ') : ''}
${allMarket.length > 0 ? 'MARKET HISTORY: ' + allMarket.map(m => (m.snapshot_date || '') + ': avg $' + (m.avg_daily_rate || '?') + ', median $' + (m.median_daily_rate || '?') + ', ' + (m.active_listings || '?') + ' listings').join(' | ') : ''}
${masterComps.length > 0 ? 'AREA LISTINGS FROM CRAWL DATA (' + masterComps.length + '): ' + masterComps.slice(0, 6).map(m => (m.bedrooms || '?') + 'BR $' + (m.nightly_rate || 0) + '/nt ' + (m.rating || '') + '★ (' + (m.review_count || 0) + ' reviews) [' + (m.listing_type || 'str') + ']').join(' | ') : ''}
SERVICES: ${svcList.join(', ') || 'None'}
${revOptData ? 'REVENUE OPTIMIZATION REPORT: ' + revOptData : ''}
${plStratData ? 'PRICING STRATEGY REPORT: ' + plStratData : ''}
${similar.length > 0 ? 'PORTFOLIO PROPERTIES NEARBY:\n' + similar.map(s => '  ' + (s.address || '?') + ' ' + (s.bedrooms || '?') + 'BR — ' + (s.pl_base ? '$' + s.pl_base + '/nt' : '') + (s.pl_occ ? ' occ ' + s.pl_occ : '')).join('\n') : ''}
${guestyActuals ? 'ACTUAL REVENUE DATA FROM GUESTY (real bookings — use this as ground truth over estimates):\n' + guestyActuals : ''}
${seasonalityData ? 'SEASONALITY PATTERN FOR ' + property.city + ' (multiplier vs annual avg):\n' + seasonalityData : ''}
${await getMonthlyTargetsForPrompt(propertyId, property, env)}
${await getMarketAndTrendContextForPrompt(propertyId, property, env)}
${prevAnalysis ? 'PREVIOUS ANALYSIS (improve on this): ' + prevAnalysis.substring(0, 600) : ''}
${regData ? 'ACTUAL REGULATION DATA FROM WEB SEARCH (use this as ground truth for regulations section):\n' + regData.substring(0, 800) : 'No regulation data found — set regulations fields to "unknown" rather than guessing.'}
${areaData ? 'ACTUAL AREA/MARKET DATA FROM WEB SEARCH (use this for area_demand and future_value):\n' + areaData.substring(0, 800) : ''}
${saleCompsData ? 'NEARBY PROPERTIES FOR SALE (use for sale_comps — include the URLs as listing_url):\n' + saleCompsData.substring(0, 1000) : ''}

Respond ONLY with valid JSON. All number values must be plain numbers. No markdown, no backticks.
{
  "verdict": "GO" or "NO-GO" or "CONDITIONAL",
  "confidence": "high" or "medium" or "low",
  "summary": "3-4 sentence executive summary with specific dollar amounts",

  "projected_nightly_rate": N,
  "projected_occupancy_pct": N,
  "projected_monthly_revenue": N,
  "projected_annual_revenue": N,
  "monthly_expenses": ${monthlyCost},
  "projected_monthly_net": N,
  "projected_annual_net": N,
  "cap_rate_pct": N,
  "cash_on_cash_return_pct": N,
  "breakeven_occupancy_pct": N,
  "setup_costs_estimate": N,
  "payback_period_months": N,

  "str_comps": [
    {"description": "nearby similar STR", "bedrooms": N, "bathrooms": N, "nightly_rate": N, "occupancy": N, "monthly_revenue": N}
  ],
  "ltr_comps": [
    {"description": "nearby similar LTR", "bedrooms": N, "bathrooms": N, "monthly_rent": N}
  ],
  "sale_comps": [
    {"description": "nearby property for sale", "bedrooms": N, "bathrooms": N, "price": N, "sqft": N, "listing_url": "URL if available"},
    {"description": "another sale comp", "bedrooms": N, "bathrooms": N, "price": N, "sqft": N, "listing_url": "URL if available"}
  ],

  "str_projection": {
    "avg_nightly_rate": N, "peak_rate": N, "low_rate": N,
    "annual_occupancy_pct": N, "peak_season_months": "which months",
    "annual_gross": N, "annual_net": N,
    "best_case_monthly": N, "worst_case_monthly": N
  },
  "ltr_projection": {
    "monthly_rent": N, "annual_gross": N, "annual_net": N,
    "vacancy_rate_pct": N
  },
  "midterm_projection": {
    "monthly_rate": N, "target_stays": "typical stay length",
    "annual_gross": N, "annual_net": N
  },

  "upgrades": [
    {"name": "upgrade name", "cost": N, "monthly_increase": N, "roi": "X month payback", "description": "why this upgrade helps"}
  ],

  "strengths": ["specific strength with numbers"],
  "weaknesses": ["specific weakness with numbers"],
  "opportunities": ["specific opportunity"],
  "threats": ["specific threat"],

  "regulations": {
    "str_allowed": true or false or "unknown",
    "permit_required": true or false or "unknown",
    "occupancy_tax_pct": N or null,
    "max_occupancy_days": N or null,
    "notes": "specific regulations for ${property.city}, ${property.state} regarding STR licensing, zoning, HOA restrictions, etc."
  },

  "area_demand": {
    "str_demand_drivers": ["what brings short-term visitors - tourism, events, universities, hospitals, etc."],
    "ltr_demand_drivers": ["what brings long-term renters - employers, schools, affordability, etc."],
    "seasonal_patterns": "describe peak/off-peak seasons and why",
    "competition_level": "low/medium/high with explanation"
  },

  "future_value": {
    "appreciation_pct_annual": N,
    "value_in_3_years": N,
    "value_in_5_years": N,
    "area_development": "upcoming developments, infrastructure, or changes that affect value",
    "risk_factors": "what could decrease value"
  },

  "comparable_performance": "detailed 3-4 sentences comparing this property to STR and LTR comps with specific numbers",
  "market_outlook": "detailed 3-4 sentences about ${property.city} market trends, demand trajectory, and competition outlook",
  "conditions_for_go": ["specific actionable condition - e.g. negotiate price below $X", "verify permits available"],
  "deal_breakers": ["specific factual red flag - e.g. city bans STR in this zone", "negative cash flow at realistic occupancy"],
  "recommendation": "5-6 sentence final recommendation covering: should they buy, at what price, STR vs LTR vs midterm strategy, expected timeline to profitability, and specific next steps"
}`;

  // Increase max tokens for comprehensive report
  const maxTokens = 6000;
  const workersMaxTokens = 4000; // Workers AI limit is lower

  const aiResult = await callAIWithFallback(env, 'acquisition_analysis', prompt, maxTokens, workersMaxTokens);
  if (!aiResult) return json({ error: 'No AI provider available. Configure ANTHROPIC_API_KEY or OPENAI_API_KEY in API Keys settings, or ensure Workers AI is enabled.' }, 400);
  const aiResponse = aiResult.text;
  const provider = aiResult.provider;

  try {
    let jsonStr = aiResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const fb = jsonStr.indexOf('{'); const lb = jsonStr.lastIndexOf('}');
    if (fb >= 0 && lb > fb) jsonStr = jsonStr.substring(fb, lb + 1);
    // Fix common JSON issues from LLMs
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    let result;
    try { result = JSON.parse(jsonStr); } catch {
      jsonStr = jsonStr.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/,\s*([}\]])/g, '$1');
      try { result = JSON.parse(jsonStr); } catch { jsonStr = jsonStr.replace(/\t/g, ' '); result = JSON.parse(jsonStr); }
    }

    // Post-processing: fix contradictions
    if (result.regulations && result.deal_breakers) {
      var strAllowed = result.regulations.str_allowed;
      if (strAllowed === true) {
        // Remove deal breakers that contradict STR being allowed
        result.deal_breakers = result.deal_breakers.filter(function(db) {
          var lower = db.toLowerCase();
          return !lower.includes('bans short') && !lower.includes('bans str') && !lower.includes('prohibits short') && !lower.includes('not allowed') && !lower.includes('illegal');
        });
      }
      if (strAllowed === false) {
        // If STR not allowed, make sure verdict reflects that
        if (result.verdict === 'GO') result.verdict = 'CONDITIONAL';
        if (!result.deal_breakers.some(function(db) { return db.toLowerCase().includes('str') || db.toLowerCase().includes('short-term'); })) {
          result.deal_breakers.push('STR may not be allowed in this zone — verify local regulations before proceeding');
        }
      }
    }
    // Fix empty deal breakers array
    if (result.deal_breakers && result.deal_breakers.length === 0) {
      result.deal_breakers = null;
    }

    const response = { analysis: result, property: { id: property.id, address: property.address, city: property.city, state: property.state, is_research: property.is_research }, monthly_expenses: monthlyCost, provider };
    try {
      await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'acquisition_analysis', ?, ?)`)
        .bind(propertyId, JSON.stringify(response), provider).run();
    } catch {}
    return json(response);
  } catch (e) {
    // Third attempt: try to extract just the key fields via regex from the raw response
    try {
      const raw = aiResponse;
      const extract = (key) => { const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*"?([^",}]+)"?')); return m ? m[1].trim() : null; };
      const extractNum = (key) => { const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*([\\d.]+)')); return m ? parseFloat(m[1]) : null; };
      const extractArr = (key) => { const m = raw.match(new RegExp('"' + key + '"\\s*:\\s*\\[([^\\]]+)\\]')); return m ? m[1].split(',').map(s => s.replace(/"/g,'').trim()).filter(Boolean) : []; };
      const result = {
        verdict: extract('verdict') || 'CONDITIONAL',
        confidence: extract('confidence') || 'medium',
        summary: extract('summary') || '',
        projected_nightly_rate: extractNum('projected_nightly_rate'),
        projected_occupancy_pct: extractNum('projected_occupancy_pct'),
        projected_monthly_revenue: extractNum('projected_monthly_revenue'),
        projected_annual_revenue: extractNum('projected_annual_revenue'),
        monthly_expenses: extractNum('monthly_expenses'),
        projected_monthly_net: extractNum('projected_monthly_net'),
        projected_annual_net: extractNum('projected_annual_net'),
        cap_rate_pct: extractNum('cap_rate_pct'),
        cash_on_cash_return_pct: extractNum('cash_on_cash_return_pct'),
        breakeven_occupancy_pct: extractNum('breakeven_occupancy_pct'),
        payback_period_months: extractNum('payback_period_months'),
        setup_costs_estimate: extractNum('setup_costs_estimate'),
        strengths: extractArr('strengths'),
        weaknesses: extractArr('weaknesses'),
        opportunities: extractArr('opportunities'),
        threats: extractArr('threats'),
        conditions_for_go: extractArr('conditions_for_go'),
        deal_breakers: extractArr('deal_breakers'),
        market_outlook: extract('market_outlook') || '',
        comparable_performance: extract('comparable_performance') || '',
        recommendation: extract('recommendation') || '',
      };
      if (result.projected_nightly_rate || result.summary) {
        const response = { analysis: result, property: { id: property.id, address: property.address, city: property.city, state: property.state, is_research: property.is_research }, monthly_expenses: monthlyCost, provider };
        try { await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'acquisition_analysis', ?, ?)`).bind(propertyId, JSON.stringify(response), provider).run(); } catch {}
        return json(response);
      }
    } catch {}
    // Final fallback
    const fallback = { analysis: { verdict: 'UNKNOWN', summary: aiResponse.substring(0, 1500), recommendation: 'AI response could not be structured.' }, property: { id: property.id }, monthly_expenses: monthlyCost, provider };
    return json(fallback);
  }
}

function generateLTRStrategies(property, amenities, market, taxRate, comparables) {
  // LTR estimation: based on comps, property value, bedroom count, and local factors
  const value = property.estimated_value || property.purchase_price || 300000;
  const taxes = property.annual_taxes || (value * 0.012);
  const hoa = (property.hoa_monthly || 0) * 12;
  const insurance = value * 0.005;
  const maintenance = value * 0.01;
  const annualExpenses = taxes + hoa + insurance + maintenance;
  const monthlyExpenses = Math.round(annualExpenses / 12);
  const beds = Math.min(property.bedrooms || 1, 6);

  // ── Base rent: prefer comps, then market, then regional estimate ──
  let baseRent = 0;
  const compArr = comparables || [];
  // LTR comps from RentCast have monthly rents stored in nightly_rate (>= $500 typically)
  const ltrComps = compArr.map(c => c.nightly_rate || 0).filter(r => r >= 500);
  if (ltrComps.length >= 2) {
    const sorted = ltrComps.slice().sort((a, b) => a - b);
    baseRent = sorted[Math.floor(sorted.length / 2)]; // median
  } else if (market && market.median_daily_rate && market.median_daily_rate >= 500) {
    baseRent = market.median_daily_rate; // this is actually monthly rent from RentCast
  }

  if (baseRent < 500) {
    // Use location-aware defaults
    const tier = getStateTier(property.state);
    const tierRents = {
      premium:  { 0: 1800, 1: 2400, 2: 3200, 3: 4200, 4: 5500, 5: 7000, 6: 8500 },
      high:     { 0: 1400, 1: 1900, 2: 2500, 3: 3300, 4: 4300, 5: 5500, 6: 6500 },
      mid:      { 0: 1100, 1: 1500, 2: 2000, 3: 2600, 4: 3400, 5: 4200, 6: 5000 },
      low:      { 0: 850,  1: 1100, 2: 1500, 3: 1900, 4: 2500, 5: 3100, 6: 3800 },
    };
    baseRent = (tierRents[tier] || tierRents.mid)[beds] || 2000;
  }

  // Sqft adjustment
  if (property.sqft) {
    if (property.sqft > 2500) baseRent *= 1.15;
    else if (property.sqft < 1000) baseRent *= 0.85;
  }

  // Type adjustment
  const typeAdj = { single_family: 1.15, condo: 0.95, apartment: 0.85, townhouse: 1.0 }[property.property_type] || 1.0;
  baseRent = Math.round(baseRent * typeAdj);

  // Amenity bump for LTR (pool, garage, etc)
  const ltrBumpAmenities = ['Private Pool', 'Heated Pool', 'Garage', 'In-law Suite', 'Gated Community', 'Washer/Dryer'];
  const ltrBoost = amenities.filter(a => ltrBumpAmenities.includes(a.name)).length * 0.03;
  baseRent = Math.round(baseRent * (1 + ltrBoost));

  const conservativeRent = Math.round(baseRent * 0.9);
  const premiumRent = Math.round(baseRent * 1.12);

  const calcAnnual = (rent, vacancy) => Math.round(rent * 12 * (1 - vacancy));
  const calcCashFlow = (annual) => annual - annualExpenses;

  const compNote = ltrComps.length >= 2
    ? `Based on ${ltrComps.length} area comps (median $${Math.round(ltrComps.sort((a,b)=>a-b)[Math.floor(ltrComps.length/2)])}/mo). `
    : 'Using regional rent estimates. ';

  return [
    {
      strategy_name: 'LTR — Conservative',
      base_nightly_rate: conservativeRent,
      weekend_rate: 0, cleaning_fee: 0, pet_fee: 0,
      weekly_discount: 0, monthly_discount: 0, peak_season_markup: 0, low_season_discount: 0,
      min_nights: 365,
      projected_occupancy: 0.95,
      projected_annual_revenue: calcAnnual(conservativeRent, 0.05),
      projected_monthly_avg: conservativeRent,
      reasoning: `${compNote}LTR Conservative: $${conservativeRent}/mo rent, 5% vacancy. Annual gross: $${calcAnnual(conservativeRent, 0.05).toLocaleString()}. Expenses: $${annualExpenses.toLocaleString()}/yr ($${monthlyExpenses.toLocaleString()}/mo). Net cash flow: $${calcCashFlow(calcAnnual(conservativeRent, 0.05)).toLocaleString()}/yr. Cap rate: ${((calcAnnual(conservativeRent, 0.05) - annualExpenses) / value * 100).toFixed(1)}%.`,
      ai_generated: false,
    },
    {
      strategy_name: 'LTR — Market Rate',
      base_nightly_rate: baseRent,
      weekend_rate: 0, cleaning_fee: 0, pet_fee: 0,
      weekly_discount: 0, monthly_discount: 0, peak_season_markup: 0, low_season_discount: 0,
      min_nights: 365,
      projected_occupancy: 0.92,
      projected_annual_revenue: calcAnnual(baseRent, 0.08),
      projected_monthly_avg: baseRent,
      reasoning: `${compNote}LTR Market: $${baseRent}/mo rent, 8% vacancy. Annual gross: $${calcAnnual(baseRent, 0.08).toLocaleString()}. Expenses: $${annualExpenses.toLocaleString()}/yr. Net cash flow: $${calcCashFlow(calcAnnual(baseRent, 0.08)).toLocaleString()}/yr. Cap rate: ${((calcAnnual(baseRent, 0.08) - annualExpenses) / value * 100).toFixed(1)}%.`,
      ai_generated: false,
    },
    {
      strategy_name: 'LTR — Premium',
      base_nightly_rate: premiumRent,
      weekend_rate: 0, cleaning_fee: 0, pet_fee: 0,
      weekly_discount: 0, monthly_discount: 0, peak_season_markup: 0, low_season_discount: 0,
      min_nights: 365,
      projected_occupancy: 0.88,
      projected_annual_revenue: calcAnnual(premiumRent, 0.12),
      projected_monthly_avg: premiumRent,
      reasoning: `${compNote}LTR Premium: $${premiumRent}/mo rent, 12% vacancy. Annual gross: $${calcAnnual(premiumRent, 0.12).toLocaleString()}. Expenses: $${annualExpenses.toLocaleString()}/yr. Net cash flow: $${calcCashFlow(calcAnnual(premiumRent, 0.12)).toLocaleString()}/yr. Cap rate: ${((calcAnnual(premiumRent, 0.12) - annualExpenses) / value * 100).toFixed(1)}%. Requires updated finishes and strong location.`,
      ai_generated: false,
    },
  ];
}

async function lookupProperty(request, env) {
  const { address, city, state, zip, unit_number, property_type } = await request.json();
  if (!address) return json({ error: 'Address required' }, 400);

  const result = { address, city, state, zip, source: 'lookup', lookups: [] };
  const isMultiFamily = property_type === 'multi_family';
  const isUnit = property_type === 'apartment' || property_type === 'condo' || !!unit_number;

  // ── RentCast API (primary data source) ──
  const rcKey = env.RENTCAST_API_KEY;
  if (rcKey) {
    try {
      // For multi-family buildings: search WITHOUT unit number to find ALL units
      // For individual units: include unit number to find the specific one
      let lookupAddr = address;
      if (unit_number && !isMultiFamily) lookupAddr += ' ' + unit_number;
      const rcParams = new URLSearchParams({ address: lookupAddr });
      if (city) rcParams.set('city', city);
      if (state) rcParams.set('state', state);
      if (zip) rcParams.set('zipCode', zip);

      // Property records lookup (rate-limited)
      const rc1 = await rentCastFetch('https://api.rentcast.io/v1/properties?' + rcParams.toString(), rcKey, env, 'property_lookup', city, state);
      if (rc1.limited) {
        result.lookups.push({ action: 'RentCast property', status: 'limit', detail: rc1.error });
      } else if (rc1.ok) {
        const props = Array.isArray(rc1.data) ? rc1.data : (rc1.data.properties || []);
        if (props.length > 0) {
          // Score each result by how closely it matches the requested address
          const normalizeAddr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const reqNorm = normalizeAddr(address);
          const scoreProp = p => {
            const pAddr = normalizeAddr((p.addressLine1 || p.formattedAddress || p.address || ''));
            if (pAddr === reqNorm) return 100; // exact match
            if (pAddr.startsWith(reqNorm.substring(0, Math.min(reqNorm.length, 10)))) return 80; // starts with same
            // Check street number matches
            const reqNum = (address.match(/^(\d+)/) || [])[1];
            const pNum = ((p.addressLine1 || p.formattedAddress || '').match(/^(\d+)/) || [])[1];
            if (reqNum && pNum && reqNum === pNum) return 60;
            return 0;
          };
          const scored = props.map(p => ({ p, score: scoreProp(p) })).sort((a, b) => b.score - a.score);
          let match = scored[0].p;
          // Warn if best match score is 0 — likely wrong property
          if (scored[0].score === 0) {
            result.lookups.push({ action: 'RentCast property', status: 'warn', detail: 'Best match may not be exact — verify address. RentCast returned: ' + (match.formattedAddress || match.addressLine1 || 'unknown') });
          }
          if (isUnit && unit_number && props.length > 1) {
            const unitMatch = props.find(p => p.addressUnit && p.addressUnit.toLowerCase().includes(unit_number.toLowerCase()));
            if (unitMatch) match = unitMatch;
          }
          result.bedrooms = match.bedrooms || null;
          result.bathrooms = match.bathrooms || null;
          result.sqft = match.squareFootage || null;
          result.lot_acres = match.lotSize ? Math.round(match.lotSize / 43560 * 100) / 100 : null;
          result.year_built = match.yearBuilt || null;
          result.latitude = match.latitude || null;
          result.longitude = match.longitude || null;
          result.estimated_value = match.assessedValue || null;
          result.annual_taxes = match.taxAmount || null;
          result.stories = match.stories || null;
          result.parking_spaces = match.parkingSpaces || null;
          result.parcel_id = match.assessorID || match.id || null;
          result.zoning = match.zoning || null;
          result.county = match.county || null;
          // Only set property_type if user hasn't already chosen multi_family
          if (match.propertyType && !isMultiFamily) {
            const rcType = match.propertyType.toLowerCase();
            if (rcType.includes('single')) result.property_type = 'single_family';
            else if (rcType.includes('condo')) result.property_type = 'condo';
            else if (rcType.includes('apartment') || rcType.includes('multi')) result.property_type = 'apartment';
            else if (rcType.includes('townhouse') || rcType.includes('town')) result.property_type = 'townhouse';
          }
          if (match.addressUnit) result.unit_number = match.addressUnit;
          result.lookups.push({ action: 'RentCast property', status: 'ok', detail: (match.bedrooms || '?') + 'BR/' + (match.bathrooms || '?') + 'BA, ' + (match.squareFootage || '?') + ' sqft' + (props.length > 1 ? ' (' + props.length + ' units found)' : '') });

          // For multi-family buildings or when multiple records found, include all as available units
          if (props.length > 1 || isMultiFamily) {
            result.available_units = props.map(p => ({
              unit_number: p.addressUnit || p.unitNumber || null,
              bedrooms: p.bedrooms || null,
              bathrooms: p.bathrooms || null,
              sqft: p.squareFootage || null,
              property_type: p.propertyType || null,
              year_built: p.yearBuilt || null,
              assessed_value: p.assessedValue || null,
              rent_estimate: p.rentEstimate || null,
            }));
          }
        } else {
          result.lookups.push({ action: 'RentCast property', status: 'skip', detail: 'No matching record found' });
        }
      } else {
        result.lookups.push({ action: 'RentCast property', status: 'fail', detail: rc1.error || 'API error' });
      }

      // RentCast AVM (value estimate) - use full address + zip for best match precision
      const avmParams = new URLSearchParams({ address: address });
      if (city) avmParams.set('city', city);
      if (state) avmParams.set('state', state);
      if (zip) avmParams.set('zipCode', zip);
      // If we got lat/lng from property lookup, prefer that for AVM precision
      if (result.latitude && result.longitude) {
        avmParams.set('latitude', result.latitude);
        avmParams.set('longitude', result.longitude);
      }
      const rc2 = await rentCastFetch('https://api.rentcast.io/v1/avm/value?' + avmParams.toString(), rcKey, env, 'avm_value', city, state);
      if (rc2.limited) {
        result.lookups.push({ action: 'RentCast valuation', status: 'limit', detail: rc2.error });
      } else if (rc2.ok && rc2.data.price) {
        // Sanity check: price should be plausible (>$10K, <$50M)
        const price = rc2.data.price;
        if (price > 10000 && price < 50000000) {
          result.estimated_value = price;
          const conf = rc2.data.score ? ' · confidence: ' + Math.round(rc2.data.score * 100) + '%' : '';
          const range = rc2.data.priceRangeLow ? ' (range: $' + rc2.data.priceRangeLow.toLocaleString() + '–$' + rc2.data.priceRangeHigh.toLocaleString() + ')' : '';
          result.lookups.push({ action: 'RentCast valuation', status: 'ok', detail: '$' + price.toLocaleString() + range + conf });
        } else {
          result.lookups.push({ action: 'RentCast valuation', status: 'warn', detail: 'Value $' + price.toLocaleString() + ' seems implausible — not used' });
        }
      }

      // RentCast rent estimate (rate-limited)
      const rc3 = await rentCastFetch('https://api.rentcast.io/v1/avm/rent/long-term?' + avmParams.toString(), rcKey, env, 'avm_rent', city, state);
      if (rc3.limited) {
        result.lookups.push({ action: 'RentCast rent estimate', status: 'limit', detail: rc3.error });
      } else if (rc3.ok && rc3.data.rent) {
        result.estimated_rent = rc3.data.rent;
        result.lookups.push({ action: 'RentCast rent estimate', status: 'ok', detail: '$' + rc3.data.rent.toLocaleString() + '/mo' });
      }
    } catch (err) { result.lookups.push({ action: 'RentCast', status: 'fail', detail: err.message }); }
  }

  // ── Google Places (geocoding + address verification) ──
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (apiKey) {
    const gCheck = await checkApiLimit(env, 'google_places');
    if (!gCheck.allowed) {
      result.lookups.push({ action: 'Google Places', status: 'limit', detail: 'Monthly limit reached: ' + gCheck.used + '/' + gCheck.limit + '. Increase in Admin → API Keys.' });
    } else {
    try {
      await trackApiCall(env, 'google_places', 'geocode', true);
      const fullAddress = [address, city, state, zip].filter(Boolean).join(', ');
      const searchRes = await fetch(
        'https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=' + encodeURIComponent(fullAddress) + '&inputtype=textquery&fields=place_id,formatted_address,geometry,name,photos&key=' + apiKey
      );
      const searchData = await searchRes.json();
      if (searchData.candidates && searchData.candidates.length > 0) {
        const place = searchData.candidates[0];
        if (!result.latitude) result.latitude = place.geometry && place.geometry.location ? place.geometry.location.lat : null;
        if (!result.longitude) result.longitude = place.geometry && place.geometry.location ? place.geometry.location.lng : null;
        result.formatted_address = place.formatted_address;

        // Get photo URL if available
        if (place.photos && place.photos.length > 0) {
          result.image_url = 'https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photo_reference=' + place.photos[0].photo_reference + '&key=' + apiKey;
          result.lookups.push({ action: 'Google photo', status: 'ok', detail: 'Property photo found' });
        }

        // Get address components
        const detailRes = await fetch(
          'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + place.place_id + '&fields=address_components,geometry&key=' + apiKey
        );
        const detailData = await detailRes.json();
        if (detailData.result && detailData.result.address_components) {
          for (var c of detailData.result.address_components) {
            if (c.types.includes('locality')) result.city = c.long_name;
            if (c.types.includes('administrative_area_level_1')) result.state = c.short_name;
            if (c.types.includes('postal_code')) result.zip = c.short_name;
            if (c.types.includes('administrative_area_level_2')) result.county = c.long_name;
          }
        }
        result.lookups.push({ action: 'Google geocode', status: 'ok', detail: result.formatted_address || 'Geocoded' });
      } else {
        result.lookups.push({ action: 'Google geocode', status: 'skip', detail: 'No match found' });
      }
    } catch (err) { result.lookups.push({ action: 'Google', status: 'fail', detail: err.message }); }
    } // end limit check else
  }

  if (!rcKey && !apiKey) {
    result.lookups.push({ action: 'Setup', status: 'skip', detail: 'No API keys configured. Add RENTCAST_API_KEY for property data or GOOGLE_PLACES_API_KEY for geocoding.' });
  } else if (!rcKey) {
    result.lookups.push({ action: 'Tip', status: 'skip', detail: 'Add RENTCAST_API_KEY for beds/baths/sqft/value/tax data. Free: 50 calls/mo at rentcast.io/api' });
  }

  // ── Web Scraping Fallback — when RentCast limited or data missing ──
  const needsData = !result.bedrooms || !result.estimated_value || !result.sqft;
  const rcLimited = result.lookups.some(l => l.status === 'limit');
  if ((needsData || rcLimited) && env.SEARCHAPI_KEY) {
    const fullAddr = [address, unit_number, city, state, zip].filter(Boolean).join(' ');
    // Try Zillow/Redfin/Realtor via Google search
    try {
      await trackApiCall(env, 'searchapi', 'property_lookup_fallback', true);
      const params = new URLSearchParams({ engine: 'google', q: fullAddr + ' property details bedrooms sqft' });
      const resp = await fetch('https://www.searchapi.io/api/v1/search?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
      });
      if (resp.ok) {
        const data = await resp.json();
        let webFound = [];

        // Knowledge graph (Google often has property data)
        if (data.knowledge_graph) {
          const kg = data.knowledge_graph;
          if (!result.bedrooms && kg.bedrooms) result.bedrooms = parseInt(kg.bedrooms);
          if (!result.bathrooms && kg.bathrooms) result.bathrooms = parseFloat(kg.bathrooms);
          if (!result.sqft && kg.square_feet) result.sqft = parseInt(String(kg.square_feet).replace(/[^0-9]/g, ''));
          if (!result.year_built && kg.year_built) result.year_built = parseInt(kg.year_built);
          if (!result.estimated_value && kg.price) {
            const pm = String(kg.price).match(/\$?([\d,]+)/);
            if (pm) result.estimated_value = parseInt(pm[1].replace(/,/g, ''));
          }
          webFound.push('knowledge graph');
        }

        // Organic results — only use snippets containing the exact street number
        const reqNum = (address.match(/^(\d+)/) || [])[1];
        const snippets = (data.organic_results || []).slice(0, 8)
          .filter(s => !reqNum || ((s.snippet || '') + (s.title || '')).includes(reqNum));
        for (const s of snippets) {
          const text = (s.snippet || '') + ' ' + (s.title || '');
          // Beds
          if (!result.bedrooms) {
            const bedM = text.match(/(\d+)\s*(?:bed|br|bedroom)/i);
            if (bedM) result.bedrooms = parseInt(bedM[1]);
          }
          // Baths
          if (!result.bathrooms) {
            const bathM = text.match(/(\d+\.?\d*)\s*(?:bath|ba|bathroom)/i);
            if (bathM) result.bathrooms = parseFloat(bathM[1]);
          }
          // Sqft
          if (!result.sqft) {
            const sqM = text.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|square feet)/i);
            if (sqM) result.sqft = parseInt(sqM[1].replace(/,/g, ''));
          }
          // Year built
          if (!result.year_built) {
            const yrM = text.match(/(?:built|year)\s*:?\s*((?:19|20)\d{2})/i);
            if (yrM) result.year_built = parseInt(yrM[1]);
          }
          // Value/Price
          if (!result.estimated_value) {
            const valM = text.match(/\$\s*([\d,]+(?:,\d{3})+)/);
            if (valM) {
              const v = parseInt(valM[1].replace(/,/g, ''));
              if (v > 50000) result.estimated_value = v;
            }
          }
          // Lot size
          if (!result.lot_acres) {
            const lotM = text.match(/([\d.]+)\s*(?:acre|ac)\b/i);
            if (lotM) result.lot_acres = parseFloat(lotM[1]);
          }
          // Property type
          if (!result.property_type) {
            if (/single.?family/i.test(text)) result.property_type = 'single_family';
            else if (/condo/i.test(text)) result.property_type = 'condo';
            else if (/townhouse|townhome/i.test(text)) result.property_type = 'townhouse';
            else if (/apartment|multi/i.test(text)) result.property_type = 'apartment';
          }
          // Track sources
          const srcM = s.link ? s.link.match(/(zillow|redfin|realtor|trulia|homes)\./i) : null;
          if (srcM && webFound.indexOf(srcM[1].toLowerCase()) < 0) webFound.push(srcM[1].toLowerCase());
        }

        if (webFound.length > 0) {
          result.lookups.push({ action: 'Web scrape', status: 'ok', detail: 'Data from: ' + webFound.join(', ') + (result.bedrooms ? ' · ' + result.bedrooms + 'BR/' + (result.bathrooms || '?') + 'BA' : '') + (result.sqft ? ' · ' + result.sqft + ' sqft' : '') + (result.estimated_value ? ' · $' + result.estimated_value.toLocaleString() : '') });
        } else {
          result.lookups.push({ action: 'Web scrape', status: 'skip', detail: 'No property data found in search results' });
        }
      }
    } catch (err) {
      result.lookups.push({ action: 'Web scrape', status: 'fail', detail: err.message });
    }

    // Zillow search for value - use street number + zip for precision
    if (!result.estimated_value) {
      try {
        await trackApiCall(env, 'searchapi', 'zillow_value', true);
        // Include zip in query for precision - zip is the most important disambiguator
        const zQuery = 'site:zillow.com "' + address + '"' + (zip ? ' ' + zip : (state ? ' ' + state : ''));
        const zParams = new URLSearchParams({ engine: 'google', q: zQuery });
        const zResp = await fetch('https://www.searchapi.io/api/v1/search?' + zParams.toString(), {
          headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
        });
        if (zResp.ok) {
          const zData = await zResp.json();
          const zResults = (zData.organic_results || []).slice(0, 3);
          // Extract street number from address to validate result is for correct property
          const reqStreetNum = (address.match(/^(\d+)/) || [])[1];
          for (const z of zResults) {
            const text = (z.snippet || '') + ' ' + (z.title || '');
            // Verify result contains the street number — avoids picking up nearby listings
            if (reqStreetNum && !text.includes(reqStreetNum)) continue;
            const valM = text.match(/\$\s*([\d,]+(?:,\d{3})+)/);
            if (valM) {
              const v = parseInt(valM[1].replace(/,/g, ''));
              if (v > 50000 && v < 50000000) {
                result.estimated_value = v;
                result.lookups.push({ action: 'Zillow value', status: 'ok', detail: '$' + v.toLocaleString() });
                break;
              }
            }
          }
        }
      } catch {}
    }
  }

  return json(result);
}
async function getPropertyPlatforms(propId, env, uid) {
  const { results } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ? ORDER BY platform`).bind(propId).all();
  // Fetch the Guesty listing name matched to this property
  const guesty = await env.DB.prepare(
    `SELECT listing_name FROM guesty_listings WHERE property_id = ? LIMIT 1`
  ).bind(propId).first();
  // Also fetch the manually-set platform listing name from the property
  const prop = await env.DB.prepare(`SELECT platform_listing_name FROM properties WHERE id = ?`).bind(propId).first();
  return json({
    platforms: results,
    guesty_listing_name: guesty?.listing_name || null,
    platform_listing_name: prop?.platform_listing_name || null,
  });
}

async function addPropertyPlatform(propId, request, env, uid) {
  const b = await request.json();
  if (!b.platform) return json({ error: 'platform required' }, 400);
  // Check for duplicate platform
  const exists = await env.DB.prepare(`SELECT id FROM property_platforms WHERE property_id = ? AND platform = ?`).bind(propId, b.platform).first();
  if (exists) return json({ error: 'Platform ' + b.platform + ' already linked for this property' }, 409);
  const r = await env.DB.prepare(`INSERT INTO property_platforms (user_id, property_id, platform, listing_url, platform_id, nightly_rate, weekly_rate, monthly_rate, cleaning_fee, service_fee, platform_fee_pct, guest_fee_pct, occupancy_tax_pct, min_nights, weekly_discount_pct, monthly_discount_pct, last_minute_discount_pct, early_bird_discount_pct, cancellation_policy, instant_book, rating, review_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(uid || null, propId, b.platform, b.listing_url || null, b.platform_id || null, b.nightly_rate || null, b.weekly_rate || null, b.monthly_rate || null, b.cleaning_fee || 0, b.service_fee || 0, b.platform_fee_pct || 0, b.guest_fee_pct || 0, b.occupancy_tax_pct || 0, b.min_nights || null, b.weekly_discount_pct || 0, b.monthly_discount_pct || 0, b.last_minute_discount_pct || 0, b.early_bird_discount_pct || 0, b.cancellation_policy || null, b.instant_book || 0, b.rating || null, b.review_count || 0).run();
  return json({ id: r.meta.last_row_id, message: 'Platform added' }, 201);
}

async function updatePropertyPlatform(id, request, env, uid) {
  const b = await request.json();
  const fields = [], values = [];
  for (const k of ['platform','listing_url','platform_id','is_active','nightly_rate','weekly_rate','monthly_rate','cleaning_fee','service_fee','platform_fee_pct','guest_fee_pct','occupancy_tax_pct','min_nights','weekly_discount_pct','monthly_discount_pct','last_minute_discount_pct','early_bird_discount_pct','cancellation_policy','instant_book','rating','review_count']) {
    if (b[k] !== undefined) { fields.push(k + ' = ?'); values.push(b[k]); }
  }
  if (fields.length === 0) return json({ error: 'No fields to update' }, 400);
  fields.push("updated_at = datetime('now')");
  values.push(id);
  await env.DB.prepare(`UPDATE property_platforms SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  return json({ message: 'Platform updated' });
}

async function deletePropertyPlatform(id, env, uid) {
  if (uid) await env.DB.prepare(`DELETE FROM property_platforms WHERE id = ? AND (user_id = ? OR user_id IS NULL)`).bind(id, uid).run();
  else await env.DB.prepare(`DELETE FROM property_platforms WHERE id = ?`).bind(id).run();
  return json({ message: 'Platform deleted' });
}

async function scrapePlatformPricing(propId, env, uid) {
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ? AND is_active = 1`).bind(propId).all();
  if (platforms.length === 0) return json({ error: 'No platforms linked. Add platform URLs first.' }, 400);

  // Use consistent dates: 2 weeks out, 3 night stay
  const cin = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
  const cout = new Date(Date.now() + 17 * 86400000).toISOString().split('T')[0];

  const results = [];
  for (const plat of platforms) {
    if (!plat.listing_url) { results.push({ platform: plat.platform, status: 'skip', detail: 'No URL' }); continue; }
    try {
      const scraped = await scrapePlatformListing(plat.listing_url, plat.platform, 3, 2, env, cin, cout);
      if (scraped) {
        const sets = [];
        const vals = [];
        if (scraped.nightly_rate && scraped.nightly_rate > 0) { sets.push('nightly_rate = ?'); vals.push(scraped.nightly_rate); }
        if (scraped.cleaning_fee !== undefined && scraped.cleaning_fee !== null) { sets.push('cleaning_fee = ?'); vals.push(scraped.cleaning_fee); }
        if (scraped.rating) { sets.push('rating = ?'); vals.push(scraped.rating); }
        if (scraped.review_count) { sets.push('review_count = ?'); vals.push(scraped.review_count); }
        if (scraped.min_nights) { sets.push('min_nights = ?'); vals.push(scraped.min_nights); }
        if (scraped.raw_data) { sets.push('raw_data = ?'); vals.push(JSON.stringify(scraped.raw_data)); }
        sets.push("last_scraped = datetime('now')");
        sets.push("updated_at = datetime('now')");
        vals.push(plat.id);
        await env.DB.prepare(`UPDATE property_platforms SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        // Auto-update property main image if not set
        if (scraped.image_url) {
          try { await env.DB.prepare(`UPDATE properties SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = '')`).bind(scraped.image_url, propId).run(); } catch {}
        }
        results.push({ platform: plat.platform, status: 'ok', nightly_rate: scraped.nightly_rate, rating: scraped.rating, review_count: scraped.review_count, source: scraped.raw_data?.source, image_url: scraped.image_url });
      } else {
        results.push({ platform: plat.platform, status: 'no_data', detail: 'Could not extract pricing data. Ensure URL is correct.' });
      }
    } catch (e) {
      results.push({ platform: plat.platform, status: 'error', detail: e.message });
    }
  }
  return json({ results, message: results.filter(r => r.status === 'ok').length + '/' + platforms.length + ' platforms scraped' });
}

async function comparePlatformPricing(propId, request, env, uid) {
  const prop = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propId).first();
  if (!prop) return json({ error: 'Property not found' }, 404);
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ? ORDER BY platform`).bind(propId).all();
  if (platforms.length < 1) return json({ error: 'Add at least one platform link first' }, 400);

  const body = request ? await request.json().catch(() => ({})) : {};
  const nights = body.nights || 3;
  const guests = body.guests || 2;
  const pets = body.pets || 0; // number of pets

  // Compute consistent dates for all platforms
  const checkin = body.checkin ? new Date(body.checkin) : new Date(Date.now() + 14 * 86400000); // default: 2 weeks out
  const checkout = new Date(checkin.getTime() + nights * 86400000);
  const checkinStr = checkin.toISOString().split('T')[0];
  const checkoutStr = checkout.toISOString().split('T')[0];

  // Try to scrape live pricing from each platform URL
  const scrapeResults = [];
  for (const p of platforms) {
    if (!p.listing_url) { scrapeResults.push({ platform: p.platform, status: 'no_url' }); continue; }
    try {
      const scraped = await scrapePlatformListing(p.listing_url, p.platform, nights, guests, env, checkinStr, checkoutStr, pets);
      if (scraped) {
        // Update DB with scraped data
        const sets = [];
        const vals = [];
        if (scraped.nightly_rate && scraped.nightly_rate > 0) { sets.push('nightly_rate = ?'); vals.push(scraped.nightly_rate); }
        if (scraped.cleaning_fee !== undefined && scraped.cleaning_fee !== null) { sets.push('cleaning_fee = ?'); vals.push(scraped.cleaning_fee); }
        if (scraped.rating) { sets.push('rating = ?'); vals.push(scraped.rating); }
        if (scraped.review_count) { sets.push('review_count = ?'); vals.push(scraped.review_count); }
        if (scraped.min_nights) { sets.push('min_nights = ?'); vals.push(scraped.min_nights); }
        if (scraped.occupancy_tax_pct) { sets.push('occupancy_tax_pct = ?'); vals.push(scraped.occupancy_tax_pct); }
        if (scraped.weekly_rate) { sets.push('weekly_rate = ?'); vals.push(scraped.weekly_rate); }
        if (scraped.monthly_rate) { sets.push('monthly_rate = ?'); vals.push(scraped.monthly_rate); }
        if (scraped.raw_data) { sets.push('raw_data = ?'); vals.push(JSON.stringify(scraped.raw_data)); }
        sets.push("last_scraped = datetime('now')");
        if (sets.length > 0) {
          vals.push(p.id);
          await env.DB.prepare(`UPDATE property_platforms SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        }
        // Auto-update property main image if not set and we found one
        if (scraped.image_url) {
          try {
            await env.DB.prepare(`UPDATE properties SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = '')`).bind(scraped.image_url, propId).run();
          } catch {}
        }
        // Merge into platform object for this comparison
        if (scraped.nightly_rate) p.nightly_rate = scraped.nightly_rate;
        if (scraped.cleaning_fee !== undefined && scraped.cleaning_fee !== null) p.cleaning_fee = scraped.cleaning_fee;
        if (scraped.rating) p.rating = scraped.rating;
        if (scraped.review_count) p.review_count = scraped.review_count;
        if (scraped.min_nights) p.min_nights = scraped.min_nights;
        if (scraped.occupancy_tax_pct) p.occupancy_tax_pct = scraped.occupancy_tax_pct;
        p.last_scraped = new Date().toISOString();
        scrapeResults.push({ platform: p.platform, status: 'ok', nightly_rate: scraped.nightly_rate, source: scraped.raw_data?.source });
      } else {
        scrapeResults.push({ platform: p.platform, status: 'no_data' });
      }
    } catch (e) { scrapeResults.push({ platform: p.platform, status: 'error', detail: e.message }); }
  }

  // Build comparison data
  const comparison = platforms.map(p => {
    const nightlyBase = p.nightly_rate || 0;
    const cleaning = p.cleaning_fee || 0;
    const platformFeePct = p.platform_fee_pct || 0;
    const guestFeePct = p.guest_fee_pct || 0;
    const taxPct = p.occupancy_tax_pct || 0;

    // Calculate total for N nights
    const subtotal = nightlyBase * nights;
    const platformFee = Math.round(subtotal * platformFeePct / 100);
    const guestFee = Math.round(subtotal * guestFeePct / 100);
    const taxAmount = Math.round((subtotal + cleaning + platformFee + guestFee) * taxPct / 100);
    const totalGuest = subtotal + cleaning + platformFee + guestFee + taxAmount;
    const avgPerNight = nights > 0 ? Math.round(totalGuest / nights) : 0;

    // Host payout: subtract platform's host fee (varies by platform)
    const hostFeePcts = { direct: 0, airbnb: 3, vrbo: 5, booking: 15, furnished_finder: 0 };
    const hostFeePct = hostFeePcts[p.platform] || platformFeePct;
    const hostPayout = Math.round(subtotal + cleaning - (subtotal * hostFeePct / 100));

    // Weekly / Monthly projections
    const weeklyRate = p.weekly_rate || Math.round(nightlyBase * 7 * (1 - (p.weekly_discount_pct || 0) / 100));
    const monthlyRate = p.monthly_rate || Math.round(nightlyBase * 30 * (1 - (p.monthly_discount_pct || 0) / 100));

    return {
      id: p.id, platform: p.platform, listing_url: p.listing_url,
      nightly_rate: nightlyBase, cleaning_fee: cleaning,
      platform_fee_pct: platformFeePct, guest_fee_pct: guestFeePct, occupancy_tax_pct: taxPct,
      subtotal, platform_fee: platformFee, guest_fee: guestFee, tax_amount: taxAmount,
      total_guest_pays: totalGuest, avg_per_night: avgPerNight,
      host_payout: hostPayout, host_fee_pct: hostFeePct,
      weekly_rate: weeklyRate, monthly_rate: monthlyRate,
      weekly_discount_pct: p.weekly_discount_pct || 0,
      monthly_discount_pct: p.monthly_discount_pct || 0,
      last_minute_discount_pct: p.last_minute_discount_pct || 0,
      early_bird_discount_pct: p.early_bird_discount_pct || 0,
      min_nights: p.min_nights,
      cancellation_policy: p.cancellation_policy,
      instant_book: p.instant_book,
      rating: p.rating, review_count: p.review_count,
      last_scraped: p.last_scraped,
    };
  });

  // Price parity analysis
  const rates = comparison.filter(c => c.nightly_rate > 0);
  const totals = comparison.filter(c => c.total_guest_pays > 0);
  const hostPayouts = comparison.filter(c => c.host_payout > 0);
  const cheapestTotal = totals.length > 0 ? totals.reduce((a, b) => a.total_guest_pays < b.total_guest_pays ? a : b) : null;
  const bestHostPayout = hostPayouts.length > 0 ? hostPayouts.reduce((a, b) => a.host_payout > b.host_payout ? a : b) : null;
  const avgNightly = rates.length > 0 ? Math.round(rates.reduce((s, c) => s + c.nightly_rate, 0) / rates.length) : 0;
  const priceSpread = rates.length >= 2 ? Math.round((Math.max(...rates.map(r => r.nightly_rate)) - Math.min(...rates.map(r => r.nightly_rate))) / avgNightly * 100) : 0;

  // Generate insights
  const insights = [];
  if (cheapestTotal && totals.length > 1) {
    const expensive = totals.reduce((a, b) => a.total_guest_pays > b.total_guest_pays ? a : b);
    const diff = expensive.total_guest_pays - cheapestTotal.total_guest_pays;
    insights.push({ type: 'cost', icon: 'dollarSign', text: cheapestTotal.platform + ' is cheapest for guests ($' + cheapestTotal.total_guest_pays + ' for ' + nights + ' nights) — $' + diff + ' less than ' + expensive.platform });
  }
  if (bestHostPayout && hostPayouts.length > 1) {
    const worstHost = hostPayouts.reduce((a, b) => a.host_payout < b.host_payout ? a : b);
    const diff = bestHostPayout.host_payout - worstHost.host_payout;
    if (diff > 0) insights.push({ type: 'revenue', icon: 'trendUp', text: bestHostPayout.platform + ' gives you $' + diff + ' more per ' + nights + '-night booking vs ' + worstHost.platform + ' (host fees: ' + bestHostPayout.host_fee_pct + '% vs ' + worstHost.host_fee_pct + '%)' });
  }
  if (priceSpread > 15) {
    insights.push({ type: 'parity', icon: 'alertTriangle', text: 'Rate spread of ' + priceSpread + '% across platforms — OTAs may flag price parity violations. Consider aligning base rates.' });
  } else if (priceSpread > 0 && priceSpread <= 15) {
    insights.push({ type: 'parity', icon: 'check', text: 'Rate spread of ' + priceSpread + '% — within acceptable parity range.' });
  }
  // Direct booking advantage
  const directPlat = comparison.find(c => c.platform === 'direct');
  if (directPlat && directPlat.nightly_rate > 0) {
    const airbnb = comparison.find(c => c.platform === 'airbnb');
    if (airbnb && airbnb.total_guest_pays > 0 && directPlat.total_guest_pays > 0) {
      const savings = airbnb.total_guest_pays - directPlat.total_guest_pays;
      if (savings > 0) insights.push({ type: 'direct', icon: 'home', text: 'Direct booking saves guests $' + savings + ' (' + Math.round(savings / airbnb.total_guest_pays * 100) + '% off Airbnb) — great incentive for repeat guests' });
      else if (savings < 0) insights.push({ type: 'direct', icon: 'alertTriangle', text: 'Direct booking is $' + Math.abs(savings) + ' MORE than Airbnb — consider lowering direct rate or removing service fees to incentivize direct bookings' });
    }
  }
  // Discount analysis
  comparison.forEach(c => {
    if (c.weekly_discount_pct > 0 || c.monthly_discount_pct > 0) {
      insights.push({ type: 'discount', icon: 'tag', text: c.platform + ': ' + (c.weekly_discount_pct > 0 ? c.weekly_discount_pct + '% weekly' : '') + (c.weekly_discount_pct > 0 && c.monthly_discount_pct > 0 ? ' + ' : '') + (c.monthly_discount_pct > 0 ? c.monthly_discount_pct + '% monthly' : '') + ' discount' });
    }
  });
  // Missing platforms
  const allPlats = ['direct', 'airbnb', 'vrbo', 'booking'];
  const linkedPlats = comparison.map(c => c.platform);
  const missing = allPlats.filter(p => !linkedPlats.includes(p));
  if (missing.length > 0) {
    insights.push({ type: 'coverage', icon: 'clipboard', text: 'Not yet linked: ' + missing.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ') + ' — add these to complete the comparison' });
  }

  // AI analysis if available
  let aiAnalysis = null;
  if (env.AI && comparison.length >= 2) {
    try {
      const ctx = comparison.map(c => c.platform + ': $' + c.nightly_rate + '/nt, cleaning $' + c.cleaning_fee + ', platform fee ' + c.platform_fee_pct + '%, guest pays $' + c.total_guest_pays + ' total (' + nights + ' nights), host gets $' + c.host_payout + (c.weekly_discount_pct ? ', weekly -' + c.weekly_discount_pct + '%' : '') + (c.monthly_discount_pct ? ', monthly -' + c.monthly_discount_pct + '%' : '') + ', rating: ' + (c.rating || 'N/A') + ' (' + (c.review_count || 0) + ' reviews)').join('\n');
      const prompt = `You are a short-term rental pricing strategist. Analyze this multi-platform pricing for a ${prop.bedrooms}BR/${prop.bathrooms}BA ${prop.property_type || 'property'} in ${prop.city}, ${prop.state}:\n\n${ctx}\n\nGive 3-4 specific, actionable recommendations. Consider: rate parity, direct booking incentives, platform fee optimization, length-of-stay discounts, seasonal pricing strategy, and which platform to prioritize. Be specific with dollar amounts. Brief bullet points.`;
      const aiResult = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 600 });
      if (aiResult.response) aiAnalysis = aiResult.response;
      await trackAI(env, 'pricing_compare', 'workers_ai', 600, true, null);
    } catch {}
  }

  // Get PriceLabs recommended rate for this property if linked
  let plRate = null;
  let plMonthly = null;
  try {
    const plLink = await env.DB.prepare(`SELECT pl_listing_id, base_price, min_price FROM pricelabs_listings WHERE property_id = ?`).bind(propId).first();
    if (plLink) {
      // Get average rate for the next 30 days
      const today = new Date().toISOString().split('T')[0];
      const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      const avg = await env.DB.prepare(`SELECT AVG(price) as avg, MIN(price) as min, MAX(price) as max FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= ? AND rate_date <= ? AND is_available = 1`).bind(plLink.pl_listing_id, today, next30).first();
      if (avg?.avg) {
        plRate = { avg: Math.round(avg.avg), min: Math.round(avg.min), max: Math.round(avg.max), base_price: plLink.base_price, min_price: plLink.min_price };
        plMonthly = Math.round(avg.avg * 30 * 0.7);
      }
    }
  } catch {}

  // Add PriceLabs vs platform rate insight
  if (plRate && rates.length > 0) {
    comparison.forEach(c => {
      if (c.nightly_rate > 0 && plRate.avg > 0) {
        const diff = c.nightly_rate - plRate.avg;
        const pct = Math.round(diff / plRate.avg * 100);
        c.pl_diff = diff;
        c.pl_diff_pct = pct;
      }
    });
    const overpriced = comparison.filter(c => c.pl_diff_pct > 10);
    const underpriced = comparison.filter(c => c.pl_diff_pct < -10);
    if (overpriced.length > 0) insights.push({ type: 'pricelabs', icon: 'pieChart', text: overpriced.map(c => c.platform).join(', ') + ' priced ' + Math.abs(overpriced[0].pl_diff_pct) + '% above PriceLabs recommendation ($' + plRate.avg + '/nt avg). Consider lowering to match dynamic pricing.' });
    if (underpriced.length > 0) insights.push({ type: 'pricelabs', icon: 'pieChart', text: underpriced.map(c => c.platform).join(', ') + ' priced ' + Math.abs(underpriced[0].pl_diff_pct) + '% below PriceLabs recommendation. You may be leaving money on the table.' });
  }

  const compResponse = {
    property: { id: prop.id, name: prop.name, address: prop.address, city: prop.city, state: prop.state, bedrooms: prop.bedrooms, bathrooms: prop.bathrooms },
    nights, guests, checkin: checkinStr, checkout: checkoutStr, comparison, insights, ai_analysis: aiAnalysis, scrape_results: scrapeResults,
    pricelabs: plRate,
    summary: {
      cheapest_for_guest: cheapestTotal ? cheapestTotal.platform : null,
      best_host_payout: bestHostPayout ? bestHostPayout.platform : null,
      avg_nightly: avgNightly,
      price_spread_pct: priceSpread,
      platform_count: comparison.length,
      pl_recommended: plRate ? plRate.avg : null,
    }
  };

  try {
    await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'platform_comparison', ?, 'system')`)
      .bind(propId, JSON.stringify(compResponse)).run();
  } catch {}

  return json(compResponse);
}

async function searchPlatformListings(propId, env, uid) {
  const prop = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propId).first();
  if (!prop) return json({ error: 'Property not found' }, 404);

  const address = prop.address || '';
  const city = prop.city || '';
  const state = prop.state || '';
  // Prefer the manually-set platform_listing_name; fall back to the Guesty listing_name
  let listingName = prop.platform_listing_name || '';
  if (!listingName) {
    const guestyRow = await env.DB.prepare(`SELECT listing_name FROM guesty_listings WHERE property_id = ? LIMIT 1`).bind(prop.id).first();
    listingName = guestyRow?.listing_name || '';
  }
  const nameSearchTerm = listingName; // exact name used for platform title matching
  const searchTerm = listingName ? listingName + ' ' + city + ' ' + state : address + ' ' + city + ' ' + state;
  const found = [];

  // Search Airbnb via SearchAPI
  if (env.SEARCHAPI_KEY) {
    try {
      const cin = new Date(Date.now() + 14 * 86400000);
      const cout = new Date(cin.getTime() + 3 * 86400000);
      // If we have a listing name, search by name for precision; otherwise fall back to location
      const airbnbQ = nameSearchTerm ? nameSearchTerm + ' ' + city + ' ' + state : searchTerm;
      const saParams = new URLSearchParams({
        engine: 'airbnb', q: airbnbQ,
        check_in_date: cin.toISOString().split('T')[0],
        check_out_date: cout.toISOString().split('T')[0],
        adults: '2',
      });
      await trackApiCall(env, 'searchapi', 'benchmark_airbnb', true);
      if (prop.bedrooms) saParams.set('min_bedrooms', prop.bedrooms);
      const saResp = await fetch('https://www.searchapi.io/api/v1/search?' + saParams.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
      });
      if (saResp.ok) {
        const saData = await saResp.json();
        const listings = saData.properties || [];
        const scoredListings = listings.map(l => {
          let rate = 0;
          if (l.price && l.price.extracted_price) rate = l.price.extracted_price;
          else if (l.pricing && l.pricing.nightly_rate) rate = l.pricing.nightly_rate;
          else if (l.price && l.price.extracted_total_price) rate = Math.round(l.price.extracted_total_price / 3);
          const title = (l.title || l.name || '').toLowerCase();
          const nameLower = nameSearchTerm.toLowerCase();
          // Score: exact name match = 100, partial = 50, beds match = 10
          let score = 0;
          if (nameLower && title.includes(nameLower)) score += 100;
          else if (nameLower) {
            const nameWords = nameLower.split(/\s+/).filter(w => w.length > 3);
            const matchedWords = nameWords.filter(w => title.includes(w));
            score += Math.round(matchedWords.length / Math.max(nameWords.length, 1) * 50);
          }
          if (prop.bedrooms && (l.beds === prop.bedrooms || l.bedroom_count === prop.bedrooms)) score += 10;
          return { l, rate, score };
        });
        scoredListings.sort((a, b) => b.score - a.score);
        for (const { l, rate, score } of scoredListings.slice(0, 6)) {
          found.push({
            platform: 'airbnb',
            title: l.title || l.name || 'Airbnb listing',
            listing_url: l.link || (l.id ? 'https://www.airbnb.com/rooms/' + l.id : null),
            nightly_rate: rate > 0 ? Math.round(rate) : null,
            rating: l.rating || l.overall_rating || null,
            review_count: l.reviews || l.review_count || 0,
            bedrooms: l.beds || l.bedroom_count || null,
            superhost: l.is_superhost ? 1 : 0,
            image_url: l.thumbnail || l.image || l.images?.[0] || l.photo || l.xl_picture_url || null,
            match_score: score,
            name_match: score >= 100 ? 'exact' : score >= 50 ? 'partial' : 'location',
          });
        }
      }
    } catch {}

    // Search VRBO via SearchAPI Google Hotels engine
    try {
      const vrboQ = nameSearchTerm
        ? 'site:vrbo.com "' + nameSearchTerm + '"'
        : 'site:vrbo.com ' + city + ' ' + state + ' ' + (prop.bedrooms || '') + ' bedroom vacation rental';
      const vrboParams = new URLSearchParams({ engine: 'google', q: vrboQ });
      await trackApiCall(env, 'searchapi', 'crawl_vrbo', true);
      const vrboResp = await fetch('https://www.searchapi.io/api/v1/search?' + vrboParams.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
      });
      if (vrboResp.ok) {
        const vrboData = await vrboResp.json();
        const results = vrboData.organic_results || [];
        for (const r of results.slice(0, 3)) {
          if (r.link && r.link.includes('vrbo.com')) {
            found.push({
              platform: 'vrbo',
              title: r.title || 'VRBO listing',
              listing_url: r.link,
              nightly_rate: null,
              image_url: r.thumbnail || r.favicon || null,
            });
          }
        }
      }
    } catch {}

    // Search Booking.com via SearchAPI
    try {
      const bkQ = nameSearchTerm
        ? 'site:booking.com "' + nameSearchTerm + '"'
        : 'site:booking.com ' + city + ' ' + state + ' vacation rental ' + (prop.bedrooms || '') + ' bedroom';
      const bkParams = new URLSearchParams({ engine: 'google', q: bkQ });
      await trackApiCall(env, 'searchapi', 'crawl_booking', true);
      const bkResp = await fetch('https://www.searchapi.io/api/v1/search?' + bkParams.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
      });
      if (bkResp.ok) {
        const bkData = await bkResp.json();
        const results = bkData.organic_results || [];
        for (const r of results.slice(0, 3)) {
          if (r.link && r.link.includes('booking.com')) {
            found.push({
              platform: 'booking',
              title: r.title || 'Booking.com listing',
              listing_url: r.link,
              nightly_rate: null,
              image_url: r.thumbnail || r.favicon || null,
            });
          }
        }
      }
    } catch {}
  }

  // Search Furnished Finder by listing name if available (midterm rentals)
  if (env.SEARCHAPI_KEY && nameSearchTerm) {
    try {
      const ffParams = new URLSearchParams({ engine: 'google', q: 'site:furnishedfinder.com "' + nameSearchTerm + '"' });
      await trackApiCall(env, 'searchapi', 'search_ff', true);
      const ffResp = await fetch('https://www.searchapi.io/api/v1/search?' + ffParams.toString(), { headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY } });
      if (ffResp.ok) {
        const ffData = await ffResp.json();
        for (const r of (ffData.organic_results || []).slice(0, 2)) {
          if (r.link && r.link.includes('furnishedfinder.com')) {
            found.push({ platform: 'furnished_finder', title: r.title || 'Furnished Finder listing', listing_url: r.link, nightly_rate: null, name_match: 'exact' });
          }
        }
      }
    } catch {}
  }

  // Also check if we already have listings in master_listings for this area
  try {
    const { results: mlResults } = await env.DB.prepare(
      `SELECT DISTINCT platform, listing_url, title, nightly_rate, rating FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND bedrooms = ? AND listing_url IS NOT NULL LIMIT 10`
    ).bind(city, state, prop.bedrooms || 1).all();
    for (const ml of mlResults) {
      const already = found.some(f => f.listing_url === ml.listing_url);
      if (!already) found.push({ platform: ml.platform, title: ml.title, listing_url: ml.listing_url, nightly_rate: ml.nightly_rate, rating: ml.rating, from_intel: true });
    }
  } catch {}

  return json({ property_id: propId, found, count: found.length, message: found.length > 0 ? 'Found ' + found.length + ' potential listings' : 'No listings found — try adding manually' });
}

// Scrape pricing data from a platform listing URL
async function scrapePlatformListing(url, platform, nights, guests, env, checkinStr, checkoutStr, pets) {
  if (!url) return null;

  // Use passed dates or compute default
  const cin = checkinStr || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
  const cout = checkoutStr || new Date(new Date(cin).getTime() + nights * 86400000).toISOString().split('T')[0];

  // ── Airbnb: Use SearchAPI airbnb_property engine ──
  if (platform === 'airbnb' && env.SEARCHAPI_KEY) {
    await trackApiCall(env, 'searchapi', 'scrape_airbnb', true);
    const roomMatch = url.match(/rooms\/(\d+)/);
    if (roomMatch) {
      try {
        const params = new URLSearchParams({
          engine: 'airbnb_property',
          property_id: roomMatch[1],
          check_in_date: cin,
          check_out_date: cout,
          adults: String(guests),
          currency: 'USD',
        });
        if (pets > 0) params.set('pets', String(pets));
        const resp = await fetch('https://www.searchapi.io/api/v1/search?' + params.toString(), {
          headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY, 'Accept': 'application/json' }
        });
        if (resp.ok) {
          const data = await resp.json();
          // airbnb_property response has different structures depending on version
          // Try: data.property, data directly, data.listing
          const prop = data.property || data.listing || data;
          let nightlyRate = 0;
          let cleaningFee = null;

          // Price extraction - try multiple paths
          if (prop.pricing) {
            nightlyRate = prop.pricing.nightly_rate || prop.pricing.rate || 0;
            if (prop.pricing.cost_breakdown) {
              for (const item of prop.pricing.cost_breakdown) {
                if (item.label && item.label.toLowerCase().includes('clean')) {
                  cleaningFee = Math.abs(item.amount || 0);
                }
              }
            }
          }
          if (!nightlyRate && prop.price) {
            if (prop.price.extracted_price) nightlyRate = prop.price.extracted_price;
            else if (prop.price.extracted_total_price && nights > 0) nightlyRate = Math.round(prop.price.extracted_total_price / nights);
            if (prop.price.price_details) {
              for (const item of (prop.price.price_details || [])) {
                if (item.label && item.label.toLowerCase().includes('clean')) {
                  cleaningFee = Math.abs(item.amount || 0);
                }
                // nightly breakdown: "3 nights x $XXX"
                if (item.label && item.label.match(/night/i) && item.amount && !nightlyRate) {
                  nightlyRate = Math.round(Math.abs(item.amount) / nights);
                }
              }
            }
          }
          if (!nightlyRate && prop.rate_with_service_fee) {
            nightlyRate = prop.rate_with_service_fee.amount || prop.rate_with_service_fee;
          }

          const rating = prop.overall_rating || prop.rating || prop.guest_satisfaction_overall || null;
          const reviewCount = prop.review_count || prop.reviews_count || prop.number_of_reviews || null;
          const minNights = prop.min_nights || prop.min_stay || null;
          // Extract main image
          const imageUrl = prop.thumbnail || prop.xl_picture_url || prop.picture_url || prop.image || (prop.images && prop.images[0]) || (prop.photos && prop.photos[0] && (prop.photos[0].url || prop.photos[0].large || prop.photos[0])) || null;

          if (nightlyRate > 0 || rating) {
            return {
              nightly_rate: nightlyRate > 0 ? Math.round(nightlyRate) : null,
              cleaning_fee: cleaningFee,
              rating: typeof rating === 'number' && rating > 5 ? Math.round(rating) / 20 : rating,
              review_count: reviewCount,
              min_nights: minNights,
              image_url: imageUrl,
              raw_data: { source: 'searchapi_airbnb_property', fetched: new Date().toISOString(), property_id: roomMatch[1] },
            };
          }
        }
      } catch (e) { /* fall through to search method */ }

      // Fallback: search for the listing by ID using airbnb search engine
      try {
        const params = new URLSearchParams({
          engine: 'airbnb',
          q: roomMatch[1],
          check_in_date: cin,
          check_out_date: cout,
          adults: String(guests),
        });
        const resp = await fetch('https://www.searchapi.io/api/v1/search?' + params.toString(), {
          headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY, 'Accept': 'application/json' }
        });
        await trackApiCall(env, 'searchapi', 'scrape_airbnb_fallback', true);
        if (resp.ok) {
          const data = await resp.json();
          const listings = data.properties || data.results || [];
          // Find our exact listing by ID
          const match = listings.find(l => String(l.id) === roomMatch[1]) || listings[0];
          if (match) {
            let rate = 0;
            if (match.price) {
              rate = match.price.extracted_price || 0;
              if (!rate && match.price.extracted_total_price) rate = Math.round(match.price.extracted_total_price / nights);
            }
            if (match.pricing && match.pricing.nightly_rate) rate = match.pricing.nightly_rate;
            if (rate > 0) {
              return {
                nightly_rate: Math.round(rate),
                cleaning_fee: null,
                rating: match.rating || match.overall_rating || null,
                review_count: match.review_count || match.reviews || null,
                image_url: match.thumbnail || match.image || (match.images && match.images[0]) || match.xl_picture_url || null,
                raw_data: { source: 'searchapi_airbnb_search', fetched: new Date().toISOString() },
              };
            }
          }
        }
      } catch (e) { /* fall through */ }
    }
  }

  // ── VRBO: Fetch page directly with date params ──
  // URL format: https://www.vrbo.com/{listingId}?chkin=YYYY-MM-DD&chkout=YYYY-MM-DD&adults=N
  // Pets: add &pets=1 if applicable. Strip any existing query params from stored URL first.
  if (platform === 'vrbo') {
    try {
      const vrboBase = url.split('?')[0].replace(/\/+$/, ''); // strip existing params & trailing slash
      const vrboParams = new URLSearchParams({
        chkin: cin,
        chkout: cout,
        adults: String(guests || 2),
      });
      if (pets > 0) vrboParams.set('pets', String(pets));
      const vrboUrl = vrboBase + '?' + vrboParams.toString();
      const resp = await fetch(vrboUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.vrbo.com/' },
        redirect: 'follow'
      });
      if (resp.ok) {
        const html = await resp.text();
        const result = {};
        // Extract og:image (universal across all platforms)
        const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
        if (ogImg) result.image_url = ogImg[1];
        // VRBO shows "X.X out of 10" or "X.Xout of 10"
        const ratingMatch = html.match(/(\d\.\d)\s*out of 10/i) || html.match(/"ratingValue":\s*"?(\d\.\d+)"?/);
        if (ratingMatch) result.rating = Math.round(parseFloat(ratingMatch[1]) / 2 * 10) / 10; // Convert /10 to /5
        // Review count: "X external reviews" or "X reviews"  
        const revMatch = html.match(/(\d+)\s*(?:external\s+)?reviews?/i) || html.match(/"reviewCount":\s*"?(\d+)"?/);
        if (revMatch) result.review_count = parseInt(revMatch[1]);
        // Bedrooms/bathrooms/sleeps from page text
        const bedsMatch = html.match(/(\d+)\s*bedroom/i);
        const bathMatch = html.match(/(\d+)\s*bathroom/i);
        const sleepsMatch = html.match(/Sleeps\s*(\d+)/i);
        const sqftMatch = html.match(/([\d,]+)\s*sq\s*ft/i);
        if (bedsMatch) result.bedrooms = parseInt(bedsMatch[1]);
        if (bathMatch) result.bathrooms = parseInt(bathMatch[1]);
        if (sleepsMatch) result.sleeps = parseInt(sleepsMatch[1]);
        if (sqftMatch) result.sqft = parseInt(sqftMatch[1].replace(/,/g, ''));
        // Price patterns — with date params, VRBO shows per-night rate prominently
        // Also try to extract cleaning fee and total from the price breakdown
        const pricePatterns = [
          /\$(\d{2,4})\/night/i,
          /\$(\d{2,4})\s*per\s*night/i,
          /"price":\s*"?\$?(\d{2,4})"?/i,
          /"amount":\s*(\d{4,6})[,}]/,   // cents: 18500 = $185
          /avg.*?\$(\d{2,4})/i,
          /"unitPrice":\s*(\d{2,4})/i,
          /data-nightly[^>]*>\$([\d,]+)/i,
        ];
        for (const pat of pricePatterns) {
          const m = html.match(pat);
          if (m) {
            let v = parseInt(m[1].replace(/,/g, ''));
            // If value looks like cents (>10000 and no decimal context), convert
            if (v > 10000 && pat.source.includes('amount')) v = Math.round(v / 100);
            if (v > 0 && v < 5000) { result.nightly_rate = v; break; }
          }
        }
        // Try to extract cleaning fee
        const cleanPatterns = [
          /cleaning\s*fee[^\d$]*\$([\d,]+)/i,
          /"cleaningFee":\s*(\d{2,6})/i,
          /cleaning[^<]*\$(\d{2,4})/i,
        ];
        for (const pat of cleanPatterns) {
          const m = html.match(pat);
          if (m) {
            let v = parseInt(m[1].replace(/,/g, ''));
            if (v > 1000 && pat.source.includes('Fee')) v = Math.round(v / 100); // cents
            if (v > 0 && v < 2000) { result.cleaning_fee = v; break; }
          }
        }
        if (result.rating || result.review_count || result.nightly_rate) {
          result.raw_data = { source: 'vrbo_html', fetched: new Date().toISOString(), url_used: vrboUrl };
          return result;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── Booking.com: Append check-in/out + guest params, then try direct fetch ──
  // URL format: ...?checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&group_adults=N&no_rooms=1
  if (platform === 'booking') {
    try {
      const bkBase = url.split('?')[0];
      const bkParams = new URLSearchParams({
        checkin: cin,
        checkout: cout,
        group_adults: String(guests || 2),
        no_rooms: '1',
        selected_currency: 'USD',
      });
      if (pets > 0) bkParams.set('group_children', '0'); // Booking uses different pet param — note in raw_data
      const bkUrl = bkBase + '?' + bkParams.toString();
      const resp = await fetch(bkUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9', 'Referer': 'https://www.booking.com/' },
        redirect: 'follow'
      });
      if (resp.ok) {
        const html = await resp.text();
        // Only parse if we got actual content (not CAPTCHA)
        if (html.length > 5000 && !html.includes('verify that you')) {
          const result = {};
          // Extract og:image
          const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
          if (ogImg) result.image_url = ogImg[1];
          // With dates, Booking shows actual nightly rate
          const bkPricePatterns = [
            /\$(\d{2,4})\s*(?:\/|per)\s*night/i,
            /USD\s*([\d,]+)\s*per\s*night/i,
            /"price":\s*"?([\d.]+)"?/,
            /\$\s*(\d{2,4})/i,
          ];
          for (const bkPat of bkPricePatterns) {
            const bkM = html.match(bkPat);
            if (bkM) { result.nightly_rate = parseInt(bkM[1].replace(/,/g, '')); break; }
          }
          const ratingMatch = html.match(/(\d\.\d)\s*(?:\/\s*10|out of 10)/i) || html.match(/"ratingValue":\s*"?(\d\.\d+)"?/);
          if (ratingMatch) {
            const raw = parseFloat(ratingMatch[1]);
            result.rating = raw > 5 ? Math.round(raw / 2 * 10) / 10 : raw; // Booking uses /10
          }
          const revMatch = html.match(/([\d,]+)\s*(?:reviews?|ratings?|verified)/i);
          if (revMatch) result.review_count = parseInt(revMatch[1].replace(/,/g, ''));
          if (result.nightly_rate || result.rating) {
            result.raw_data = { source: 'booking_html', fetched: new Date().toISOString(), url_used: bkUrl };
            return result;
          }
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── Direct booking sites: Try direct HTML fetch for structured data ──
  if (platform === 'direct' || platform === 'furnished_finder') {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html' },
        redirect: 'follow'
      });
      if (resp.ok) {
        const html = await resp.text();
        if (html.length > 1000) {
          const result = {};
          // Extract og:image
          const ogImg = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
          if (ogImg) result.image_url = ogImg[1];
          // Look for JSON-LD structured data
          const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
          if (ldMatch) {
            try {
              const ld = JSON.parse(ldMatch[1]);
              if (ld.offers && ld.offers.price) result.nightly_rate = parseFloat(ld.offers.price);
              if (ld.aggregateRating) {
                result.rating = parseFloat(ld.aggregateRating.ratingValue);
                result.review_count = parseInt(ld.aggregateRating.reviewCount || 0);
              }
            } catch {}
          }
          // Fallback to common HTML patterns
          if (!result.nightly_rate) {
            const pricePatterns = [
              /\$(\d{2,4})\s*(?:\/|per)\s*night/i,
              /"price":\s*"?\$?(\d{2,4})"?/i,
              /(?:rate|price|nightly|from)\s*:?\s*\$(\d{2,4})/i,
              /data-price="(\d{2,4})"/i,
            ];
            for (const pat of pricePatterns) {
              const m = html.match(pat);
              if (m) { result.nightly_rate = parseInt(m[1]); break; }
            }
          }
          if (!result.rating) {
            const rm = html.match(/(\d\.\d{1,2})\s*(?:out of 5|stars|★|\/5)/i) || html.match(/"ratingValue":\s*"?(\d\.\d+)"?/);
            if (rm) result.rating = parseFloat(rm[1]);
          }
          if (!result.review_count) {
            const revm = html.match(/(\d{1,5})\s*(?:reviews?|ratings?)/i);
            if (revm) result.review_count = parseInt(revm[1]);
          }
          if (result.nightly_rate || result.rating) {
            result.raw_data = { source: 'direct_html', fetched: new Date().toISOString() };
            return result;
          }
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── All platforms fallback: Use Google search via SearchAPI ──
  if (env.SEARCHAPI_KEY) {
    try {
      await trackApiCall(env, 'searchapi', 'scrape_google', true);
      const params = new URLSearchParams({ engine: 'google', q: url });
      const resp = await fetch('https://www.searchapi.io/api/v1/search?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY, 'Accept': 'application/json' }
      });
      if (resp.ok) {
        const data = await resp.json();
        const result = {};

        // Knowledge graph
        if (data.knowledge_graph) {
          const kg = data.knowledge_graph;
          if (kg.price) {
            const pm = String(kg.price).match(/(\d[\d,]*)/);
            if (pm) result.nightly_rate = parseInt(pm[1].replace(/,/g, ''));
          }
          if (kg.rating) result.rating = parseFloat(kg.rating);
          if (kg.reviews) result.review_count = parseInt(String(kg.reviews).replace(/[^\d]/g, ''));
        }

        // Organic results
        const allText = (data.organic_results || []).map(r => (r.title || '') + ' ' + (r.snippet || '') + ' ' + JSON.stringify(r.rich_snippet || {})).join(' ');
        if (!result.nightly_rate) {
          const patterns = [
            /\$(\d{2,4})\s*(?:\/|per)\s*(?:night|avg)/i,
            /(?:from|price|rate|nightly)[\s:]*\$(\d{2,4})/i,
            /\$(\d{2,4})\s*(?:night|nightly)/i,
          ];
          for (const pat of patterns) {
            const m = allText.match(pat);
            if (m) { result.nightly_rate = parseInt(m[1]); break; }
          }
        }
        if (!result.rating) {
          const rm = allText.match(/(\d\.\d)\s*(?:\/\s*5|out of 5|stars?|★)/i);
          if (rm) result.rating = parseFloat(rm[1]);
          // Booking.com uses /10 scale
          if (!result.rating) {
            const rm10 = allText.match(/(\d\.\d)\s*(?:\/\s*10|out of 10)/i);
            if (rm10) result.rating = Math.round(parseFloat(rm10[1]) / 2 * 10) / 10;
          }
        }
        if (!result.review_count) {
          const revm = allText.match(/([\d,]+)\s*(?:reviews?|ratings?|guest reviews)/i);
          if (revm) result.review_count = parseInt(revm[1].replace(/,/g, ''));
        }

        if (result.nightly_rate || result.rating) {
          result.raw_data = { source: 'searchapi_google', fetched: new Date().toISOString(), platform };
          return result;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── Nothing worked ──
  return null;
}
// Customer API docs: https://help.pricelabs.co/portal/en/kb/articles/pricelabs-api
// Base URL: https://api.pricelabs.co
// Auth: api_key query param

const PL_BASE = 'https://api.pricelabs.co';

async function plFetch(path, env, params = {}) {
  if (!env.PRICELABS_API_KEY) throw new Error('PRICELABS_API_KEY not configured');
  await trackApiCall(env, 'pricelabs', path, true);
  const qs = new URLSearchParams({ api_key: env.PRICELABS_API_KEY, ...params });
  const resp = await fetch(PL_BASE + path + '?' + qs.toString(), {
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('PriceLabs API error ' + resp.status + ': ' + txt.substring(0, 200));
  }
  return resp.json();
}

async function bulkApplyPlCustomizations(request, env, uid) {
  const { rules, property_ids, mode, group_name } = await request.json();
  if (!rules || Object.keys(rules).length === 0) return json({ error: 'No rules provided' }, 400);

  // If specific property_ids provided, use those; otherwise fall back to mode-based selection
  let targets;
  if (property_ids && property_ids.length > 0) {
    const placeholders = property_ids.map(() => '?').join(',');
    const uf = uid ? ` AND (user_id = ? OR user_id IS NULL)` : '';
    const binds = uid ? [...property_ids, uid] : [...property_ids];
    const { results } = await env.DB.prepare(`SELECT id, pl_customizations_json FROM properties WHERE id IN (${placeholders})${uf}`).bind(...binds).all();
    targets = results || [];
  } else {
    if (mode === 'group' && group_name) {
      const uf = uid ? ` AND (p.user_id = ? OR p.user_id IS NULL)` : '';
      const binds = uid ? [group_name, uid] : [group_name];
      const { results } = await env.DB.prepare(`SELECT p.id, p.pl_customizations_json FROM properties p WHERE p.id IN (SELECT property_id FROM pricelabs_listings WHERE property_id IS NOT NULL AND group_name = ?)${uf}`).bind(...binds).all();
      targets = results || [];
    } else {
      const uf = uid ? ` AND (p.user_id = ? OR p.user_id IS NULL)` : '';
      const binds = uid ? [uid] : [];
      const q = `SELECT p.id, p.pl_customizations_json FROM properties p WHERE p.id IN (SELECT property_id FROM pricelabs_listings WHERE property_id IS NOT NULL)${uf}`;
      const { results } = binds.length > 0 ? await env.DB.prepare(q).bind(...binds).all() : await env.DB.prepare(q).all();
      targets = results || [];
    }
  }

  if (!targets || targets.length === 0) return json({ error: 'No matching properties found', updated: 0 });

  let updated = 0;
  for (const t of targets) {
    let existing = {};
    try { if (t.pl_customizations_json) existing = JSON.parse(t.pl_customizations_json); } catch {}
    const preservedNotes = existing.notes && !rules.notes ? existing.notes : (rules.notes || existing.notes || null);
    const merged = { ...rules };
    if (preservedNotes) merged.notes = preservedNotes;

    await env.DB.prepare(`UPDATE properties SET pl_customizations_json = ? WHERE id = ?`)
      .bind(JSON.stringify(merged), t.id).run();
    updated++;
  }

  return json({ ok: true, updated, total_targets: targets.length });
}

async function getPlCustomizationsPreview(request, env, uid) {
  const { rules, mode, group_name } = await request.json();

  // Get all PL-linked properties with their current customizations
  let q, binds = [];
  if (mode === 'group' && group_name) {
    q = `SELECT p.id, p.name, p.address, p.unit_number, p.city, p.state, p.pl_customizations_json,
            pl.group_name as pl_group
     FROM properties p
     LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
     WHERE p.id IN (SELECT pl2.property_id FROM pricelabs_listings pl2 WHERE pl2.property_id IS NOT NULL AND pl2.group_name = ?)`;
    binds.push(group_name);
  } else {
    q = `SELECT p.id, p.name, p.address, p.unit_number, p.city, p.state, p.pl_customizations_json,
            pl.group_name as pl_group
     FROM properties p
     LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
     WHERE p.id IN (SELECT pl2.property_id FROM pricelabs_listings pl2 WHERE pl2.property_id IS NOT NULL)`;
  }
  if (uid) { q += ` AND (p.user_id = ? OR p.user_id IS NULL)`; binds.push(uid); }
  q += ` ORDER BY p.unit_number, p.name`;

  const { results } = binds.length > 0 ? await env.DB.prepare(q).bind(...binds).all() : await env.DB.prepare(q).all();

  const properties = (results || []).map(p => {
    let existing = {};
    try { if (p.pl_customizations_json) existing = JSON.parse(p.pl_customizations_json); } catch {}
    return {
      id: p.id, name: p.name || p.address, address: p.address,
      unit_number: p.unit_number, city: p.city, state: p.state,
      pl_group: p.pl_group || existing.group_name || null,
      existing_rules: existing
    };
  });

  return json({ properties });
}

async function getPriceLabsStatus(env, uid) {
  const hasKey = !!env.PRICELABS_API_KEY;
  let listingCount = 0;
  let linkedCount = 0;
  let lastSync = null;
  let rateCount = 0;
  try {
    const lc = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings`).first();
    listingCount = lc?.c || 0;
    const linked = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings WHERE property_id IS NOT NULL`).first();
    linkedCount = linked?.c || 0;
    const ls = await env.DB.prepare(`SELECT MAX(last_synced) as ls FROM pricelabs_listings`).first();
    lastSync = ls?.ls || null;
    const rc = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_rates`).first();
    rateCount = rc?.c || 0;
  } catch {}
  return json({ configured: hasKey, listing_count: listingCount, linked_count: linkedCount, last_sync: lastSync, rate_count: rateCount });
}

async function syncPriceLabsListings(env, uid, preview = false) {
  // Fetch all listings from PriceLabs account
  let listings = [];
  let rawData = null;
  const endpoints = ['/v1/listings', '/api/v1/listings', '/v1/listing_prices'];
  let success = false;
  let lastError = '';

  for (const ep of endpoints) {
    try {
      const data = await plFetch(ep, env);
      rawData = data;
      if (Array.isArray(data)) { listings = data; }
      else if (data.listings) { listings = data.listings; }
      else if (data.data) { listings = Array.isArray(data.data) ? data.data : [data.data]; }
      else if (data.results) { listings = data.results; }
      if (listings.length > 0) { success = true; break; }
    } catch (e) { lastError = e.message; }
  }

  if (!success && listings.length === 0) {
    return json({ error: 'Could not fetch listings. Last error: ' + lastError, raw: rawData, help: 'Make sure your PriceLabs Customer API is enabled. Email support@pricelabs.co to activate it.' }, 400);
  }

  // Build change preview
  const changes = [];
  for (const l of listings) {
    const plId = String(l.id || l.listing_id || l.listingId || l.listing_hash || '');
    if (!plId) continue;
    const name = l.name || l.listing_name || l.title || 'PriceLabs #' + plId;
    const pms = l.pms || l.pms_name || null;
    const basePrice = l.base || l.base_price || l.basePrice || null;
    const minPrice = l.min || l.min_price || l.minPrice || null;
    const maxPrice = l.max || l.max_price || null;
    const recBase = l.recommended_base_price || null;
    const cleaningFees = l.cleaning_fees || l.cleaning_fee || null;
    const beds = l.no_of_bedrooms || l.bedrooms || l.beds || null;
    const lat = l.latitude ? parseFloat(l.latitude) : null;
    const lng = l.longitude ? parseFloat(l.longitude) : null;
    const cityName = l.city_name || l.city || null;
    const state = l.state || null;
    const country = l.country || null;
    const groupName = l.group || l.group_name || null;
    const tags = l.tags || null;
    const pushEnabled = l.push_enabled ? 1 : 0;
    const lastPushed = l.last_date_pushed || null;
    const lastRefreshed = l.last_refreshed_at || null;
    const occ7 = l.occupancy_next_7 || null;
    const mktOcc7 = l.market_occupancy_next_7 || null;
    const occ30 = l.occupancy_next_30 || null;
    const mktOcc30 = l.market_occupancy_next_30 || null;
    const occ60 = l.occupancy_next_60 || null;
    const mktOcc60 = l.market_occupancy_next_60 || null;
    const channelDetails = l.channel_listing_details ? JSON.stringify(l.channel_listing_details) : null;
    // Derive platform from channel details
    const platform = l.platform || l.channel || (l.channel_listing_details && l.channel_listing_details.length > 0 ? l.channel_listing_details.map(c => c.channel_name).join(', ') : null);

    const existing = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE pl_listing_id = ?`).bind(plId).first();
    const incoming = { pl_listing_id: plId, pl_listing_name: name, pl_platform: platform, pl_pms: pms, base_price: basePrice, min_price: minPrice, max_price: maxPrice, recommended_base_price: recBase, cleaning_fees: cleaningFees, bedrooms: beds, latitude: lat, longitude: lng, city_name: cityName, state, country, group_name: groupName, tags, push_enabled: pushEnabled, last_date_pushed: lastPushed, occupancy_next_7: occ7, market_occupancy_next_7: mktOcc7, occupancy_next_30: occ30, market_occupancy_next_30: mktOcc30, occupancy_next_60: occ60, market_occupancy_next_60: mktOcc60, channel_details: channelDetails, last_refreshed_at: lastRefreshed };

    if (existing) {
      const diffs = [];
      if (existing.pl_listing_name !== name) diffs.push({ field: 'name', from: existing.pl_listing_name, to: name });
      if (existing.base_price !== basePrice) diffs.push({ field: 'base_price', from: existing.base_price, to: basePrice });
      if (existing.min_price !== minPrice) diffs.push({ field: 'min_price', from: existing.min_price, to: minPrice });
      if (existing.max_price !== maxPrice) diffs.push({ field: 'max_price', from: existing.max_price, to: maxPrice });
      if (existing.recommended_base_price !== recBase) diffs.push({ field: 'recommended_base', from: existing.recommended_base_price, to: recBase });
      if (existing.cleaning_fees !== cleaningFees) diffs.push({ field: 'cleaning_fees', from: existing.cleaning_fees, to: cleaningFees });
      if (existing.occupancy_next_30 !== occ30) diffs.push({ field: 'occ_30d', from: existing.occupancy_next_30, to: occ30 });
      if (existing.pl_pms !== pms) diffs.push({ field: 'pms', from: existing.pl_pms, to: pms });
      if (existing.bedrooms !== beds) diffs.push({ field: 'bedrooms', from: existing.bedrooms, to: beds });

      changes.push({
        action: diffs.length > 0 ? 'update' : 'unchanged',
        pl_listing_id: plId,
        name: name,
        linked_property_id: existing.property_id,
        diffs: diffs,
        existing: { name: existing.pl_listing_name, base_price: existing.base_price, min_price: existing.min_price, max_price: existing.max_price, recommended_base: existing.recommended_base_price, occ_30d: existing.occupancy_next_30, last_synced: existing.last_synced },
        incoming: incoming,
      });
    } else {
      changes.push({
        action: 'add',
        pl_listing_id: plId,
        name: name,
        linked_property_id: null,
        diffs: [{ field: 'base', from: null, to: basePrice }, { field: 'min', from: null, to: minPrice }, { field: 'max', from: null, to: maxPrice }, { field: 'rec_base', from: null, to: recBase }, { field: 'cleaning', from: null, to: cleaningFees }, { field: 'occ_30d', from: null, to: occ30 }].filter(d => d.to != null),
        existing: null,
        incoming: incoming,
      });
    }
  }

  // Check for listings in DB that are NOT in PriceLabs response (orphans)
  const { results: allLocal } = await env.DB.prepare(`SELECT * FROM pricelabs_listings`).all();
  const incomingIds = new Set(changes.map(c => c.pl_listing_id));
  const orphans = allLocal.filter(l => !incomingIds.has(l.pl_listing_id));

  // PREVIEW MODE: return the diff without writing anything
  if (preview) {
    return json({
      preview: true,
      direction: 'pull_from_pricelabs',
      description: 'This will READ listing metadata from PriceLabs into your local database. Nothing is sent to PriceLabs.',
      summary: {
        total_from_pricelabs: listings.length,
        new_listings: changes.filter(c => c.action === 'add').length,
        updates: changes.filter(c => c.action === 'update').length,
        unchanged: changes.filter(c => c.action === 'unchanged').length,
        orphaned_local: orphans.length,
      },
      what_changes: 'Local pricelabs_listings table only. Your PriceLabs account is NOT modified.',
      what_is_safe: [
        'Your PriceLabs settings, rules, and pricing algorithms are NOT touched',
        'Your property links (property ↔ PriceLabs mapping) are preserved',
        'Existing rate data in pricelabs_rates is NOT modified',
        'Only listing metadata (name, platform, base price, min price) is updated',
      ],
      changes: changes,
      orphans: orphans.map(o => ({ pl_listing_id: o.pl_listing_id, name: o.pl_listing_name, linked_property_id: o.property_id, note: 'Exists locally but not in PriceLabs response. Will NOT be deleted.' })),
    });
  }

  // EXECUTE MODE: actually write changes
  let added = 0, updated = 0;
  for (const c of changes) {
    const i = c.incoming;
    if (c.action === 'add') {
      await env.DB.prepare(`INSERT INTO pricelabs_listings (user_id, pl_listing_id, pl_listing_name, pl_platform, pl_pms, base_price, min_price, max_price, recommended_base_price, cleaning_fees, bedrooms, latitude, longitude, city_name, state, country, group_name, tags, push_enabled, last_date_pushed, occupancy_next_7, market_occupancy_next_7, occupancy_next_30, market_occupancy_next_30, occupancy_next_60, market_occupancy_next_60, channel_details, last_refreshed_at, last_synced) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`)
        .bind(uid || null, i.pl_listing_id, i.pl_listing_name, i.pl_platform, i.pl_pms, i.base_price, i.min_price, i.max_price, i.recommended_base_price, i.cleaning_fees, i.bedrooms, i.latitude, i.longitude, i.city_name, i.state, i.country, i.group_name, i.tags, i.push_enabled, i.last_date_pushed, i.occupancy_next_7, i.market_occupancy_next_7, i.occupancy_next_30, i.market_occupancy_next_30, i.occupancy_next_60, i.market_occupancy_next_60, i.channel_details, i.last_refreshed_at).run();
      added++;
    } else if (c.action === 'update') {
      await env.DB.prepare(`UPDATE pricelabs_listings SET pl_listing_name=?, pl_platform=?, pl_pms=?, base_price=?, min_price=?, max_price=?, recommended_base_price=?, cleaning_fees=?, bedrooms=?, latitude=?, longitude=?, city_name=?, state=?, country=?, group_name=?, tags=?, push_enabled=?, last_date_pushed=?, occupancy_next_7=?, market_occupancy_next_7=?, occupancy_next_30=?, market_occupancy_next_30=?, occupancy_next_60=?, market_occupancy_next_60=?, channel_details=?, last_refreshed_at=?, last_synced=datetime('now') WHERE pl_listing_id=?`)
        .bind(i.pl_listing_name, i.pl_platform, i.pl_pms, i.base_price, i.min_price, i.max_price, i.recommended_base_price, i.cleaning_fees, i.bedrooms, i.latitude, i.longitude, i.city_name, i.state, i.country, i.group_name, i.tags, i.push_enabled, i.last_date_pushed, i.occupancy_next_7, i.market_occupancy_next_7, i.occupancy_next_30, i.market_occupancy_next_30, i.occupancy_next_60, i.market_occupancy_next_60, i.channel_details, i.last_refreshed_at, i.pl_listing_id).run();
      updated++;
    }
  }

  // Auto-snapshot performance for all linked properties
  await capturePerformanceSnapshots(env);

  return json({
    preview: false,
    message: 'Synced ' + listings.length + ' listings (' + added + ' new, ' + updated + ' updated, ' + orphans.length + ' orphaned)',
    count: listings.length, added, updated,
    orphans: orphans.length,
  });
}

async function capturePerformanceSnapshots(env) {
  const today = new Date().toISOString().split('T')[0];
  try {
    const { results: linked } = await env.DB.prepare(`SELECT pl.*, p.id as prop_id, p.cleaning_fee, p.cleaning_cost, p.monthly_mortgage, p.monthly_insurance, p.annual_taxes, p.hoa_monthly, p.monthly_rent_cost, p.ownership_type, p.expense_electric, p.expense_gas, p.expense_water, p.expense_internet, p.expense_trash, p.expense_other, p.parent_id FROM pricelabs_listings pl JOIN properties p ON pl.property_id = p.id WHERE p.is_research != 1 OR p.is_research IS NULL`).all();

    for (const l of linked) {
      const b = l.base_price || 0, r = l.recommended_base_price || b, mx = l.max_price || b;
      const blendedADR = b > 0 ? Math.round(b * 0.4 + r * 0.3 + b * 1.2 * 0.2 + (b + mx) / 2 * 0.1) : 0;
      
      const fwdOcc = l.occupancy_next_30 ? parseInt(l.occupancy_next_30) / 100 : 0;
      const mktFwdOcc = l.market_occupancy_next_30 ? parseInt(l.market_occupancy_next_30) / 100 : 0;
      let annOcc = 0.50;
      if (fwdOcc >= 0.50) annOcc = fwdOcc;
      else if (fwdOcc > 0 && mktFwdOcc > 0 && fwdOcc > mktFwdOcc) annOcc = Math.max(0.55, Math.min(0.70, fwdOcc * 3.5));
      else if (fwdOcc > 0) annOcc = Math.max(0.40, Math.min(0.60, fwdOcc * 3));

      const turnovers = Math.round(annOcc * 30 / 3);
      const nightlyRev = blendedADR > 0 ? Math.round(blendedADR * 30 * annOcc) : 0;
      const cleanRev = (l.cleaning_fee || l.cleaning_fees || 0) * turnovers;
      const totalRev = nightlyRev + Math.round(cleanRev);

      const fixedCost = (l.ownership_type === 'rental' ? (l.monthly_rent_cost || 0) : (l.monthly_mortgage || 0) + (l.monthly_insurance || 0) + Math.round((l.annual_taxes || 0) / 12) + (l.hoa_monthly || 0)) + (l.expense_electric || 0) + (l.expense_gas || 0) + (l.expense_water || 0) + (l.expense_internet || 0) + (l.expense_trash || 0) + (l.expense_other || 0);
      const cleanCost = (l.cleaning_cost || Math.round((l.cleaning_fee || l.cleaning_fees || 0) * 0.7)) * turnovers;
      // Get dynamic services for this property
      let propSvcCost = 0;
      try { const { results: svcs } = await env.DB.prepare(`SELECT monthly_cost FROM property_services WHERE property_id = ?`).bind(l.prop_id).all(); for (const s of (svcs||[])) propSvcCost += s.monthly_cost; } catch {}
      const supplies = Math.round(totalRev * 0.02);
      const totalExp = fixedCost + Math.round(cleanCost) + supplies + propSvcCost;

      await env.DB.prepare(`INSERT INTO performance_snapshots (property_id, snapshot_date, base_price, recommended_price, min_price, max_price, cleaning_fee, occupancy_7d, occupancy_30d, occupancy_60d, market_occ_30d, blended_adr, est_monthly_revenue, est_monthly_expenses, est_monthly_net, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(property_id, snapshot_date) DO UPDATE SET base_price=?, recommended_price=?, occupancy_30d=?, market_occ_30d=?, blended_adr=?, est_monthly_revenue=?, est_monthly_expenses=?, est_monthly_net=?`)
        .bind(l.prop_id, today, b, r, l.min_price, mx, l.cleaning_fees, l.occupancy_next_7, l.occupancy_next_30, l.occupancy_next_60, l.market_occupancy_next_30, blendedADR, totalRev, totalExp, totalRev - totalExp, 'sync', b, r, l.occupancy_next_30, l.market_occupancy_next_30, blendedADR, totalRev, totalExp, totalRev - totalExp).run();

      // Price history — lightweight snapshot for price change detection
      try {
        await env.DB.prepare(`INSERT INTO price_history (property_id, base_price, rec_price, min_price, max_price, occ_30d, mkt_occ_30d, snapshot_date) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(property_id, snapshot_date) DO UPDATE SET base_price=?, rec_price=?, occ_30d=?, mkt_occ_30d=?`)
          .bind(l.prop_id, b, r, l.min_price, mx, l.occupancy_next_30, l.market_occupancy_next_30, today, b, r, l.occupancy_next_30, l.market_occupancy_next_30).run();
      } catch {}
    }
  } catch {}
}

async function getPerformanceHistory(propertyId, env, uid) {
  const q = uid ? `SELECT id FROM properties WHERE id = ? AND (user_id = ? OR user_id IS NULL)` : `SELECT id FROM properties WHERE id = ?`;
  const owns = uid ? await env.DB.prepare(q).bind(propertyId, uid).first() : await env.DB.prepare(q).bind(propertyId).first();
  if (!owns) return json({ error: 'Property not found' }, 404);
  const { results } = await env.DB.prepare(`SELECT * FROM performance_snapshots WHERE property_id = ? ORDER BY snapshot_date DESC LIMIT 90`).bind(propertyId).all();
  return json({ snapshots: results, count: results.length });
}

async function getAnalysisReports(propertyId, env, uid) {
  const q = uid ? `SELECT id FROM properties WHERE id = ? AND (user_id = ? OR user_id IS NULL)` : `SELECT id FROM properties WHERE id = ?`;
  const owns = uid ? await env.DB.prepare(q).bind(propertyId, uid).first() : await env.DB.prepare(q).bind(propertyId).first();
  if (!owns) return json({ error: 'Property not found' }, 404);
  const { results } = await env.DB.prepare(`SELECT * FROM analysis_reports WHERE property_id = ? ORDER BY created_at DESC LIMIT 30`).bind(propertyId).all();
  // Parse report_data JSON for each
  const reports = (results || []).map(r => {
    let data = {};
    try { data = JSON.parse(r.report_data); } catch {}
    return { id: r.id, type: r.report_type, provider: r.provider, created_at: r.created_at, data };
  });
  // Get latest of each type
  const latest = {};
  for (const r of reports) {
    if (!latest[r.type]) latest[r.type] = r;
  }
  return json({ reports, latest, count: reports.length });
}

async function fetchPriceLabsPrices(request, env, uid) {
  const body = await request.json().catch(() => ({}));
  const plListingId = body.pl_listing_id;
  if (!plListingId) return json({ error: 'pl_listing_id required' }, 400);

  const apiKey = env.PRICELABS_API_KEY;
  if (!apiKey) return json({ error: 'PRICELABS_API_KEY not configured' }, 400);

  // Check if we already know the working endpoint format (cached in app_settings)
  let cachedFormat = null;
  try {
    const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'pl_pricing_format'`).first();
    if (row?.value) cachedFormat = JSON.parse(row.value);
  } catch {}

  let prices = [];
  let success = false;
  let lastError = '';
  let rawResponses = [];
  let emptyButValid = false;
  const hdrsJson = { 'Accept': 'application/json', 'Content-Type': 'application/json' };

  // Helper: try a single fetch
  async function tryFetch(label, url, opts) {
    try {
      const resp = await fetch(url, opts);
      const txt = await resp.text();
      let data = null;
      try { data = JSON.parse(txt); } catch {}
      const dataInfo = data ? (Array.isArray(data) ? 'array[' + data.length + ']' : 'object{' + Object.keys(data).slice(0, 8).join(',') + '}') : 'not_json';
      rawResponses.push({ endpoint: label, status: resp.ok ? 'ok' : 'http_' + resp.status, sample: txt.substring(0, 400), data_type: dataInfo });
      if (resp.ok && data) {
        // Check for empty but valid response — endpoint works but no pricing data
        if (data.listings && Array.isArray(data.listings) && data.listings.length === 0) {
          // The endpoint works, but PriceLabs returned no pricing data
          emptyButValid = true;
        }
        const found = extractPricesFromResponse(data, plListingId);
        if (found.length > 0) { prices = found; success = true; return true; }
      }
      lastError = 'HTTP ' + resp.status + ': ' + txt.substring(0, 100);
    } catch (e) {
      rawResponses.push({ endpoint: label, status: 'error', error: e.message.substring(0, 100) });
      lastError = e.message;
    }
    return false;
  }

  // If we have a cached working format, try ONLY that — 1 API call
  if (cachedFormat) {
    const url = cachedFormat.url.replace('{LISTING_ID}', plListingId).replace('{API_KEY}', apiKey);
    const opts = { method: cachedFormat.method, headers: { ...hdrsJson } };
    if (cachedFormat.authHeader) opts.headers[cachedFormat.authHeader] = cachedFormat.authPrefix ? cachedFormat.authPrefix + apiKey : apiKey;
    if (cachedFormat.method === 'POST' && cachedFormat.bodyTemplate) {
      opts.body = JSON.stringify(JSON.parse(cachedFormat.bodyTemplate.replace('{LISTING_ID}', plListingId).replace('{API_KEY}', apiKey)));
    }
    const worked = await tryFetch('cached: ' + cachedFormat.label, url, opts);
    if (worked) {
      // Still works — store prices and return
      return await storePLPrices(plListingId, prices, env);
    }
    // Cached format stopped working — clear it and fall through to discovery
    await env.DB.prepare(`DELETE FROM app_settings WHERE key = 'pl_pricing_format'`).run();
    rawResponses = [];
  }

  // ── DISCOVERY MODE: Try formats one at a time, stop on first success ──
  // Only runs once — result is cached for all future calls
  // GET /v1/listings/prices is confirmed working (returns 200), try it first
  const formats = [
    { label: 'GET /v1/listings/prices (no filter)', method: 'GET', url: PL_BASE + '/v1/listings/prices?api_key={API_KEY}' },
    { label: 'GET /v1/listings/prices?listing_id=', method: 'GET', url: PL_BASE + '/v1/listings/prices?api_key={API_KEY}&listing_id={LISTING_ID}' },
    { label: 'POST /v1/listings/prices (query auth)', method: 'POST', url: PL_BASE + '/v1/listings/prices?api_key={API_KEY}', bodyTemplate: '{"listings":["{LISTING_ID}"]}' },
    { label: 'POST /v1/listings/prices (body auth)', method: 'POST', url: PL_BASE + '/v1/listings/prices', bodyTemplate: '{"api_key":"{API_KEY}","listings":["{LISTING_ID}"]}' },
    { label: 'GET /v1/getprices?listing_id=', method: 'GET', url: PL_BASE + '/v1/getprices?api_key={API_KEY}&listing_id={LISTING_ID}' },
  ];

  for (const fmt of formats) {
    if (success) break;
    // If we already confirmed the API works but returns empty, stop probing
    if (emptyButValid) break;
    const url = fmt.url.replace('{LISTING_ID}', plListingId).replace('{API_KEY}', apiKey);
    const opts = { method: fmt.method, headers: { ...hdrsJson } };
    if (fmt.authHeader) opts.headers[fmt.authHeader] = (fmt.authPrefix || '') + apiKey;
    if (fmt.method === 'POST' && fmt.bodyTemplate) {
      opts.body = fmt.bodyTemplate.replace('{LISTING_ID}', plListingId).replace('{API_KEY}', apiKey);
    }
    const worked = await tryFetch(fmt.label, url, opts);
    if (worked) {
      // Cache this format so we never discovery-probe again
      try {
        await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('pl_pricing_format', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`)
          .bind(JSON.stringify(fmt), JSON.stringify(fmt)).run();
      } catch {}
      break;
    }
  }

  if (!success || prices.length === 0) {
    if (emptyButValid) {
      // API works but returns no pricing data — this is a PriceLabs account config issue
      return json({
        error: 'PriceLabs API connected but returned no pricing data for listing ' + plListingId,
        help: 'The API endpoint works (HTTP 200) but returns {"listings":[]}. This means pricing data is not available through the Customer API for this listing.',
        action_needed: [
          '1. Log into PriceLabs dashboard at pricelabs.co',
          '2. Find this listing and make sure "Sync Prices" toggle is ON',
          '3. Click "Review Prices" to ensure PriceLabs has generated rates',
          '4. Wait for the next sync cycle (usually within 24 hours)',
          '5. If prices still don\'t appear, contact support@pricelabs.co and ask them to enable Customer API pricing access for your account',
        ],
        note: 'Listing metadata sync works fine — only the daily pricing data is missing from the API response.',
        endpoints_tried: rawResponses,
      }, 400);
    }
    return json({
      error: 'Could not fetch prices for listing ' + plListingId,
      help: 'Tried ' + rawResponses.length + ' endpoint/auth combinations. Contact support@pricelabs.co with these diagnostics.',
      last_error: lastError,
      endpoints_tried: rawResponses,
    }, 400);
  }

  return await storePLPrices(plListingId, prices, env);
}

async function storePLPrices(plListingId, prices, env) {
  let stored = 0;
  for (const p of prices) {
    const date = p.date || p.dt || p.day || null;
    const price = p.price || p.rate || p.amount || p.recommended_price || p.final_price || 0;
    const minStay = p.min_stay || p.minStay || p.minimum_stay || p.min_nights || 1;
    const available = p.available !== undefined ? (p.available ? 1 : 0) : (p.is_available !== undefined ? (p.is_available ? 1 : 0) : 1);
    if (!date || !price) continue;
    try {
      await env.DB.prepare(`INSERT OR REPLACE INTO pricelabs_rates (pl_listing_id, rate_date, price, min_stay, is_available, fetched_at) VALUES (?,?,?,?,?,datetime('now'))`)
        .bind(plListingId, date, price, minStay, available).run();
      stored++;
    } catch {}
  }
  await env.DB.prepare(`UPDATE pricelabs_listings SET last_synced = datetime('now') WHERE pl_listing_id = ?`).bind(plListingId).run();
  return json({ listing_id: plListingId, prices_fetched: prices.length, stored, message: 'Stored ' + stored + ' daily rates' });
}

// Helper: extract price array from any PriceLabs response format
function extractPricesFromResponse(data, listingId) {
  if (!data) return [];
  // Direct array of {date, price}
  if (Array.isArray(data)) return data;
  // {prices: [...]}
  if (data.prices && Array.isArray(data.prices)) return data.prices;
  // {data: [...]}
  if (data.data && Array.isArray(data.data)) return data.data;
  // {calendar: [...]}
  if (data.calendar) return Array.isArray(data.calendar) ? data.calendar : [];
  // {rates: [...]}
  if (data.rates) return Array.isArray(data.rates) ? data.rates : [];
  // {pricing_data: [...]}
  if (data.pricing_data && Array.isArray(data.pricing_data)) return data.pricing_data;
  // Keyed by listing ID: {listing_id: {dates...}} or {listing_id: [{date, price}]}
  if (data[listingId]) {
    const ld = data[listingId];
    if (Array.isArray(ld)) return ld;
    if (ld.prices && Array.isArray(ld.prices)) return ld.prices;
    if (ld.data && Array.isArray(ld.data)) return ld.data;
    // Flat {date: price} object
    if (typeof ld === 'object') {
      const dateKeys = Object.keys(ld).filter(k => k.match(/^\d{4}-\d{2}-\d{2}$/));
      if (dateKeys.length > 0) {
        return dateKeys.map(k => {
          const v = ld[k];
          return typeof v === 'object' ? { date: k, ...v } : { date: k, price: v };
        });
      }
    }
  }
  // Flat {date: price} at top level
  if (typeof data === 'object' && !Array.isArray(data)) {
    const dateKeys = Object.keys(data).filter(k => k.match(/^\d{4}-\d{2}-\d{2}$/));
    if (dateKeys.length > 0) {
      return dateKeys.map(k => {
        const v = data[k];
        return typeof v === 'object' ? { date: k, ...v } : { date: k, price: v };
      });
    }
  }
  return [];
}

async function fetchAllPriceLabsPrices(env, uid, preview = false) {
  const { results: listings } = await env.DB.prepare(`SELECT pl.*, p.name as prop_name, p.address as prop_address FROM pricelabs_listings pl LEFT JOIN properties p ON pl.property_id = p.id`).all();
  if (listings.length === 0) return json({ error: 'No PriceLabs listings. Run sync first.' }, 400);

  const today = new Date().toISOString().split('T')[0];

  if (preview) {
    // Build preview showing what exists and what would be affected
    const previewData = [];
    for (const l of listings) {
      // Count existing rates
      const existing = await env.DB.prepare(`SELECT COUNT(*) as cnt, MIN(rate_date) as earliest, MAX(rate_date) as latest, AVG(price) as avg_price FROM pricelabs_rates WHERE pl_listing_id = ?`).bind(l.pl_listing_id).first();
      // Count future rates (would be overwritten)
      const futureRates = await env.DB.prepare(`SELECT COUNT(*) as cnt, AVG(price) as avg_price FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= ?`).bind(l.pl_listing_id, today).first();

      previewData.push({
        pl_listing_id: l.pl_listing_id,
        name: l.pl_listing_name,
        platform: l.pl_platform,
        linked_property: l.prop_name || l.prop_address || (l.property_id ? 'Property #' + l.property_id : null),
        base_price: l.base_price,
        last_synced: l.last_synced,
        existing_rates: {
          total: existing?.cnt || 0,
          date_range: existing?.cnt > 0 ? (existing.earliest + ' → ' + existing.latest) : null,
          avg_price: existing?.avg_price ? Math.round(existing.avg_price) : null,
        },
        future_rates_at_risk: {
          count: futureRates?.cnt || 0,
          avg_price: futureRates?.avg_price ? Math.round(futureRates.avg_price) : null,
          note: futureRates?.cnt > 0 ? 'These ' + futureRates.cnt + ' future rates will be REPLACED with fresh PriceLabs data' : 'No existing future rates — safe to pull',
        },
      });
    }

    return json({
      preview: true,
      direction: 'pull_from_pricelabs',
      description: 'This will READ daily rate recommendations from PriceLabs for each listing. Nothing is sent to PriceLabs.',
      summary: {
        listings_to_fetch: listings.length,
        listings_with_existing_rates: previewData.filter(p => p.existing_rates.total > 0).length,
        listings_with_future_rates: previewData.filter(p => p.future_rates_at_risk.count > 0).length,
        total_future_rates_at_risk: previewData.reduce((s, p) => s + p.future_rates_at_risk.count, 0),
      },
      what_changes: 'Local pricelabs_rates table only. Rates are REPLACED (INSERT OR REPLACE by date) with latest PriceLabs recommendations.',
      what_is_safe: [
        'Your PriceLabs account settings, rules, and algorithms are NOT touched',
        'We only READ recommended rates — we do NOT push rates to PriceLabs',
        'Your Airbnb/VRBO/Booking calendar prices are NOT affected',
        'Property links and listing metadata are NOT changed',
        'Historical rates for past dates are preserved (only future dates refreshed)',
      ],
      what_gets_overwritten: [
        'Future daily rates for each listing are replaced with PriceLabs latest recommendations',
        'Min-stay requirements per date are updated to match PriceLabs',
        'This is normal — you WANT the latest dynamic rates',
      ],
      listings: previewData,
    });
  }

  // EXECUTE MODE
  const results = [];
  for (const l of listings) {
    try {
      const fakeReq = { json: async () => ({ pl_listing_id: l.pl_listing_id }) };
      const resp = await fetchPriceLabsPrices(fakeReq, env, uid);
      const data = await resp.json();
      if (data.error) {
        results.push({ listing: l.pl_listing_name, id: l.pl_listing_id, error: data.error, endpoints_tried: data.endpoints_tried, tip: data.tip });
      } else {
        results.push({ listing: l.pl_listing_name, id: l.pl_listing_id, ...data });
      }
    } catch (e) {
      results.push({ listing: l.pl_listing_name, id: l.pl_listing_id, error: e.message });
    }
  }

  const succeeded = results.filter(r => !r.error);
  const failed = results.filter(r => r.error);
  let msg = succeeded.length + '/' + listings.length + ' listings updated';
  if (failed.length > 0) {
    msg += '. Failed: ' + failed.map(r => r.listing + ' (' + (r.error || '').substring(0, 60) + ')').join('; ');
  }

  return json({ preview: false, results, total: listings.length, succeeded: succeeded.length, failed: failed.length, message: msg });
}

async function linkPriceLabsListing(plDbId, request, env, uid) {
  const { property_id } = await request.json();
  if (!property_id) return json({ error: 'property_id required' }, 400);
  await env.DB.prepare(`UPDATE pricelabs_listings SET property_id = ? WHERE id = ?`).bind(property_id, plDbId).run();
  return json({ message: 'Linked' });
}

async function unlinkPriceLabsListing(plDbId, env, uid) {
  await env.DB.prepare(`UPDATE pricelabs_listings SET property_id = NULL WHERE id = ?`).bind(plDbId).run();
  return json({ message: 'Unlinked' });
}

async function getPriceLabsCalendar(searchParams, env, uid) {
  const propertyId = searchParams.get('property_id');
  const days = parseInt(searchParams.get('days')) || 90;

  let plListingId = null;
  if (propertyId) {
    const link = await env.DB.prepare(`SELECT pl_listing_id FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();
    if (link) plListingId = link.pl_listing_id;
  } else {
    plListingId = searchParams.get('pl_listing_id');
  }

  if (!plListingId) return json({ error: 'No PriceLabs listing linked to this property', help: 'Go to Settings > PriceLabs to link listings' }, 404);

  const today = new Date().toISOString().split('T')[0];
  const endDate = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];

  const { results: rates } = await env.DB.prepare(
    `SELECT rate_date, price, min_stay, is_available FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= ? AND rate_date <= ? ORDER BY rate_date`
  ).bind(plListingId, today, endDate).all();

  // Compute summary stats
  const available = rates.filter(r => r.is_available);
  const prices = available.map(r => r.price).filter(p => p > 0);
  const avg = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const min = prices.length > 0 ? Math.min(...prices) : 0;
  const max = prices.length > 0 ? Math.max(...prices) : 0;
  const median = prices.length > 0 ? prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)] : 0;

  // Monthly breakdown
  const byMonth = {};
  for (const r of available) {
    const month = r.rate_date.substring(0, 7);
    if (!byMonth[month]) byMonth[month] = { prices: [], minStays: [] };
    byMonth[month].prices.push(r.price);
    byMonth[month].minStays.push(r.min_stay);
  }
  const monthly = Object.entries(byMonth).map(([month, d]) => ({
    month,
    avg_rate: Math.round(d.prices.reduce((a, b) => a + b, 0) / d.prices.length),
    min_rate: Math.min(...d.prices),
    max_rate: Math.max(...d.prices),
    avg_min_stay: Math.round(d.minStays.reduce((a, b) => a + b, 0) / d.minStays.length * 10) / 10,
    days: d.prices.length,
    projected_revenue: Math.round(d.prices.reduce((a, b) => a + b, 0) * 0.7), // 70% occupancy assumption
  }));

  // Day-of-week analysis
  const byDow = {};
  for (const r of available) {
    const dow = new Date(r.rate_date + 'T00:00:00').getDay();
    const dowName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
    if (!byDow[dowName]) byDow[dowName] = [];
    byDow[dowName].push(r.price);
  }
  const dowAnalysis = Object.entries(byDow).map(([day, prices]) => ({
    day,
    avg_rate: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
    count: prices.length,
  }));

  return json({
    pl_listing_id: plListingId,
    days_requested: days,
    rates_count: rates.length,
    calendar: rates,
    summary: { avg, min, max, median, total_days: rates.length, available_days: available.length },
    monthly,
    dow_analysis: dowAnalysis,
  });
}

async function getPriceLabsSummary(searchParams, env, uid) {
  const { results: listings } = await env.DB.prepare(
    `SELECT pl.*, p.name as prop_name, p.address as prop_address, p.city as prop_city, p.state as prop_state, p.bedrooms as prop_beds FROM pricelabs_listings pl LEFT JOIN properties p ON pl.property_id = p.id ORDER BY pl.pl_listing_name`
  ).all();

  // Data is already in the listings from sync — just compute projected monthly
  const enriched = listings.map(l => {
    const occ30 = l.occupancy_next_30 ? parseInt(l.occupancy_next_30) / 100 : 0.5;
    return {
      ...l,
      projected_monthly: l.base_price ? Math.round(l.base_price * 30 * occ30) : null,
    };
  });

  return json({ listings: enriched, count: enriched.length });
}

async function getFinancesSummary(env, uid) {
  const uf = uid ? ` WHERE (p.user_id = ? OR p.user_id IS NULL)` : '';
  const ufBinds = uid ? [uid] : [];
  // Get all properties (excluding building parents — only count units/standalone)
  // STR revenue estimate: only use strategies where rental_type = 'str' OR min_nights < 365
  // This prevents LTR "Both" analysis runs from contaminating STR revenue projections
  const { results: props } = await env.DB.prepare(`SELECT p.*,
    (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'str' OR rental_type IS NULL) AND (min_nights IS NULL OR min_nights < 365) ORDER BY created_at DESC LIMIT 1) as est_monthly_revenue,
    (SELECT strategy_name FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'str' OR rental_type IS NULL) AND (min_nights IS NULL OR min_nights < 365) ORDER BY created_at DESC LIMIT 1) as latest_strategy,
    (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'ltr' OR min_nights >= 365) ORDER BY created_at DESC LIMIT 1) as est_ltr_revenue,
    (SELECT strategy_name FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'ltr' OR min_nights >= 365) ORDER BY created_at DESC LIMIT 1) as latest_ltr_strategy,
    (SELECT base_price FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_base_price,
    (SELECT recommended_base_price FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_rec_base,
    (SELECT max_price FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_max_price,
    (SELECT occupancy_next_30 FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_occ_30d,
    (SELECT market_occupancy_next_30 FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_mkt_occ_30d,
    (SELECT base_nightly_rate FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as analysis_nightly_rate,
    (SELECT projected_occupancy FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as analysis_occ
    FROM properties p ${uf} ORDER BY p.city, p.state`).bind(...ufBinds).all();

  // Separate buildings from units/standalone
  const buildings = props.filter(p => p.total_units_count > 0 || props.some(c => c.parent_id && String(c.parent_id) === String(p.id)));
  const buildingIds = new Set(buildings.map(b => String(b.id)));

  // Active/live properties: included in portfolio totals (listing_status = 'active' OR null/draft if they have expenses set)
  // Draft/inactive with no expenses: still shown in table but excluded from totals to avoid inflating costs
  // Research: always excluded
  const units = props.filter(p => !buildingIds.has(String(p.id)) && !p.is_research && !(p.is_managed === 1 || p.ownership_type === 'managed'));
  const managedProps = props.filter(p => !buildingIds.has(String(p.id)) && (p.is_managed === 1 || p.ownership_type === 'managed'));

  // Split: active STR, active LTR, inactive/draft
  const activeStr = units.filter(p => p.rental_type !== 'ltr' && p.listing_status !== 'inactive');
  const activeLtr = units.filter(p => p.rental_type === 'ltr' && p.listing_status !== 'inactive');
  const inactiveProps = units.filter(p => p.listing_status === 'inactive');

  let totalPurchaseValue = 0, totalEstimatedValue = 0;
  let totalMonthlyRevenue = 0, totalMonthlyCost = 0;
  let totalAnnualTaxes = 0;
  let propCount = 0;
  const byCity = {};

  // Get PriceLabs projected revenue for linked properties (from synced listing data)
  const plRevenue = {};
  try {
    const { results: plLinks } = await env.DB.prepare(`SELECT property_id, base_price, recommended_base_price, max_price, occupancy_next_30, market_occupancy_next_30 FROM pricelabs_listings WHERE property_id IS NOT NULL`).all();
    for (const link of plLinks) {
      if (link.base_price && link.base_price > 0) {
        const fwdOcc = link.occupancy_next_30 ? parseInt(link.occupancy_next_30) / 100 : 0;
        const mktFwdOcc = link.market_occupancy_next_30 ? parseInt(link.market_occupancy_next_30) / 100 : 0;
        // Smart occupancy: forward-looking is booking pace, not annual
        let annOcc = 0.50;
        if (fwdOcc >= 0.50) annOcc = fwdOcc;
        else if (fwdOcc > 0 && mktFwdOcc > 0 && fwdOcc > mktFwdOcc) annOcc = Math.max(0.55, Math.min(0.70, fwdOcc * 3.5));
        else if (fwdOcc > 0) annOcc = Math.max(0.40, Math.min(0.60, fwdOcc * 3));

        const b = link.base_price, r = link.recommended_base_price || b, mx = link.max_price || b;
        const blendedADR = Math.round(b * 0.4 + r * 0.3 + b * 1.2 * 0.2 + (b + mx) / 2 * 0.1);
        plRevenue[link.property_id] = Math.round(blendedADR * 30 * annOcc);
      }
    }
  } catch (e) { syslog(env, 'error', 'getFinancesSummary', 'PriceLabs revenue estimation failed', e.message); }

  // Get service costs per property BEFORE the loop
  const { results: allServices } = await env.DB.prepare(`SELECT property_id, name, monthly_cost FROM property_services`).all();
  const svcByProp = {};
  let totalServiceCost = 0;
  const svcTotals = {};
  for (const s of (allServices || [])) {
    if (!svcByProp[s.property_id]) svcByProp[s.property_id] = [];
    svcByProp[s.property_id].push(s);
    const key = s.name;
    if (!svcTotals[key]) svcTotals[key] = { name: key, count: 0, monthly: 0 };
    svcTotals[key].count++;
    svcTotals[key].monthly += s.monthly_cost;
  }

  // Pre-compute building cost allocations for child units
  const buildingAlloc = {};
  for (const bld of buildings) {
    const actualChildren = props.filter(p => String(p.parent_id) === String(bld.id)).length;
    const childCount = Math.max(actualChildren, bld.total_units_count || 0) || 1;
    const bldMortgage = bld.monthly_mortgage || 0;
    const bldInsurance = bld.monthly_insurance || 0;
    const bldTaxes = Math.round((bld.annual_taxes || 0) / 12);
    const bldHoa = bld.hoa_monthly || 0;
    // Only ownership costs get split — utilities are unit-level
    const totalOwnership = bldMortgage + bldInsurance + bldTaxes + bldHoa;
    const perUnit = Math.round(totalOwnership / childCount);
    buildingAlloc[String(bld.id)] = {
      per_unit: perUnit,
      total: totalOwnership,
      child_count: childCount,
      purchase_price: bld.purchase_price || 0,
      estimated_value: bld.estimated_value || 0,
    };
  }

  for (const p of units) {
    const isInactive = p.listing_status === 'inactive';
    const isLtrProp = p.rental_type === 'ltr';

    // Inactive properties: still count expenses (you're paying them) but mark clearly
    // They ARE included in cost totals — you're still paying rent/mortgage
    // But they should NOT inflate revenue totals with speculative projections
    propCount++;
    // Include building purchase/value for child units
    const bldAlloc = p.parent_id ? buildingAlloc[String(p.parent_id)] : null;
    const bldAllocCost = bldAlloc ? bldAlloc.per_unit : 0;
    totalPurchaseValue += p.purchase_price || (bldAlloc ? Math.round(bldAlloc.purchase_price / bldAlloc.child_count) : 0);
    totalEstimatedValue += p.estimated_value || p.purchase_price || (bldAlloc ? Math.round(bldAlloc.estimated_value / bldAlloc.child_count) : 0);
    totalAnnualTaxes += p.annual_taxes || 0;

    const propSvcs = svcByProp[p.id] || [];
    const svcCost = propSvcs.reduce((a, s) => a + s.monthly_cost, 0);
    totalServiceCost += svcCost;
    const isChild = !!p.parent_id && bldAllocCost > 0;
    const unitOwnCost = (isChild ? 0 : ((p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + (p.hoa_monthly || 0) + ((p.annual_taxes || 0) / 12))) +
      (p.monthly_rent_cost || 0) +
      (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) +
      (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0) +
      svcCost;
    const monthlyCost = unitOwnCost + bldAllocCost;
    totalMonthlyCost += monthlyCost;

    // Revenue: only count if property is active AND use the correct type
    // LTR properties use LTR strategy; STR properties use STR strategy
    // Managed and inactive properties contribute $0 revenue
    let monthlyRev = 0;
    let revSource = 'none';
    const isManaged = p.is_managed === 1 || p.ownership_type === 'managed';
    if (!isInactive && !isManaged) {
      if (isLtrProp) {
        monthlyRev = p.est_ltr_revenue || 0;
        revSource = monthlyRev ? 'ltr_strategy' : 'none';
      } else {
        monthlyRev = plRevenue[p.id] || p.est_monthly_revenue || 0;
        revSource = plRevenue[p.id] ? 'pricelabs' : (p.est_monthly_revenue ? 'str_estimate' : 'none');
      }
    }
    totalMonthlyRevenue += monthlyRev;

    const cityName = (p.city && p.city !== 'null') ? p.city : 'Unknown';
    const stateName = (p.state && p.state !== 'null') ? p.state : '';
    const key = cityName + ', ' + stateName;
    if (!byCity[key]) byCity[key] = { city: cityName, state: stateName, count: 0, value: 0, revenue: 0, cost: 0 };
    byCity[key].count++;
    byCity[key].value += p.estimated_value || p.purchase_price || 0;
    byCity[key].revenue += monthlyRev;
    byCity[key].cost += monthlyCost;
  }

  const totalMonthlyNet = totalMonthlyRevenue - totalMonthlyCost;
  const totalEquity = totalEstimatedValue - totalPurchaseValue;
  const avgCapRate = totalEstimatedValue > 0 ? ((totalMonthlyNet * 12) / totalEstimatedValue * 100) : 0;

  return json({
    portfolio: {
      property_count: propCount,
      building_count: buildings.length,
      total_purchase_value: Math.round(totalPurchaseValue),
      total_estimated_value: Math.round(totalEstimatedValue),
      total_equity: Math.round(totalEquity),
      monthly_revenue: Math.round(totalMonthlyRevenue),
      monthly_cost: Math.round(totalMonthlyCost),
      monthly_net: Math.round(totalMonthlyNet),
      annual_revenue: Math.round(totalMonthlyRevenue * 12),
      annual_cost: Math.round(totalMonthlyCost * 12),
      annual_net: Math.round(totalMonthlyNet * 12),
      annual_taxes: Math.round(totalAnnualTaxes),
      avg_cap_rate: Math.round(avgCapRate * 100) / 100,
      monthly_services: Math.round(totalServiceCost),
      service_breakdown: Object.values(svcTotals),
    },
    api_costs: await getApiUsageSummary(env),
    actual_revenue: await getPortfolioActuals(env),
    by_city: Object.values(byCity).sort((a, b) => b.value - a.value),
    properties: units.map(p => {
      const propSvcs = svcByProp[p.id] || [];
      const svc = propSvcs.reduce((a, s) => a + s.monthly_cost, 0);
      const bldA = p.parent_id ? buildingAlloc[String(p.parent_id)] : null;
      const bldCost = bldA ? bldA.per_unit : 0;
      const isChild = !!p.parent_id && bldCost > 0;
      const baseCost = (isChild ? 0 : ((p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + (p.hoa_monthly || 0) + ((p.annual_taxes || 0) / 12))) + (p.monthly_rent_cost || 0) + (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);
      const totalCost = baseCost + svc + bldCost;
      const isInactive = p.listing_status === 'inactive';
      const isLtrProp = p.rental_type === 'ltr';
      const isManProp = p.is_managed === 1 || p.ownership_type === 'managed';
      let rev = 0, revSource = 'none';
      if (!isInactive && !isManProp) {
        if (isLtrProp) { rev = p.est_ltr_revenue || 0; revSource = rev ? 'ltr_estimate' : 'none'; }
        else { rev = plRevenue[p.id] || p.est_monthly_revenue || 0; revSource = plRevenue[p.id] ? 'pricelabs' : (p.est_monthly_revenue ? 'str_estimate' : 'none'); }
      }
      return {
        id: p.id, name: p.name || p.address, city: p.city, state: p.state,
        unit_number: p.unit_number, property_type: p.property_type,
        bedrooms: p.bedrooms, purchase_price: p.purchase_price,
        estimated_value: p.estimated_value,
        rental_type: p.rental_type || 'str',
        listing_status: p.listing_status || 'draft',
        is_inactive: isInactive,
        is_managed: isManProp,
        owner_name: p.owner_name || null,
        management_fee_pct: p.management_fee_pct || null,
        monthly_revenue: rev,
        monthly_cost: Math.round(totalCost),
        monthly_net: Math.round(rev - totalCost),
        service_cost: Math.round(svc),
        building_alloc: bldCost > 0 ? Math.round(bldCost) : null,
        services: propSvcs.map(s => s.name + ' $' + s.monthly_cost),
        latest_strategy: isLtrProp ? (p.latest_ltr_strategy || p.latest_strategy) : p.latest_strategy,
        rev_source: revSource,
        // Fields needed by buildSmartExpectations for accurate projections
        pl_base_price: p.pl_base_price || null,
        pl_rec_base: p.pl_rec_base || null,
        pl_max_price: p.pl_max_price || null,
        pl_occ_30d: p.pl_occ_30d || null,
        pl_mkt_occ_30d: p.pl_mkt_occ_30d || null,
        analysis_occ: p.analysis_occ || null,
        analysis_nightly_rate: p.analysis_nightly_rate || null,
        est_monthly_revenue: p.est_monthly_revenue || null,
      };
    }),
    // Monthly actuals for Actual vs Expected
    monthly_actuals: await getFinanceMonthlyActuals(env),
    // Managed properties — separate section, never mixed with portfolio
    managed: await getManagedPropertiesSummary(managedProps, plRevenue, env),
  });
}

async function getManagedPropertiesSummary(managedProps, plRevenue, env) {
  if (!managedProps || managedProps.length === 0) return null;

  // Get actual revenue for managed properties from monthly_actuals
  const managedIds = managedProps.map(p => p.id);
  let managedActuals = {};
  try {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const fromMonth = twelveMonthsAgo.getFullYear() + '-' + String(twelveMonthsAgo.getMonth() + 1).padStart(2, '0');
    for (const pid of managedIds) {
      const a = await env.DB.prepare(`SELECT SUM(total_revenue) as total_rev, SUM(host_payout) as total_payout, SUM(booked_nights) as total_nights, SUM(available_nights) as total_avail, COUNT(*) as month_count FROM monthly_actuals WHERE property_id = ? AND month >= ?`).bind(pid, fromMonth).first();
      if (a && a.total_rev > 0) {
        managedActuals[pid] = {
          monthly_avg: a.month_count > 0 ? Math.round(a.total_rev / a.month_count) : 0,
          monthly_payout: a.month_count > 0 ? Math.round(a.total_payout / a.month_count) : 0,
          annual_rev: Math.round(a.total_rev),
          annual_payout: Math.round(a.total_payout),
          occ: a.total_avail > 0 ? Math.round(a.total_nights / a.total_avail * 100) : 0,
          adr: a.total_nights > 0 ? Math.round(a.total_rev / a.total_nights) : 0,
          months: a.month_count,
        };
      }
    }
  } catch {}

  // Get monthly breakdown for each managed property
  let monthlyBreakdown = {};
  try {
    for (const pid of managedIds) {
      const { results: months } = await env.DB.prepare(`SELECT month, total_revenue, host_payout, booked_nights, available_nights, occupancy_pct, avg_nightly_rate, cleaning_revenue, total_taxes, platform_commission FROM monthly_actuals WHERE property_id = ? ORDER BY month`).bind(pid).all();
      if (months && months.length > 0) monthlyBreakdown[pid] = months;
    }
  } catch {}

  // Get reservation-level detail for owner transparency
  let reservationDetail = {};
  try {
    for (const pid of managedIds) {
      const { results: res } = await env.DB.prepare(
        `SELECT confirmation_code, guest_name, check_in, check_out, nights_count, guest_count, channel, accommodation_fare, cleaning_fee, total_taxes, host_payout, platform_fee, status FROM guesty_reservations WHERE property_id = ? AND ${LIVE_STATUS_SQL} ORDER BY check_in DESC LIMIT 500`
      ).bind(pid).all();
      if (res && res.length > 0) reservationDetail[pid] = res;
    }
  } catch {}

  // Build per-owner summary
  // FEE MODEL: percentage of NET PROFIT (revenue - property expenses), not gross
  const byOwner = {};
  let totalGross = 0, totalYourFee = 0, totalOwnerPayout = 0, totalExpenses = 0;

  const propertyDetails = managedProps.map(p => {
    const feePct = p.management_fee_pct || 0;
    const feeBasis = p.fee_basis || 'gross';
    const baseFee = p.management_base_fee || 0;
    const ownerName = p.owner_name || 'Unknown Owner';
    const actual = managedActuals[p.id];
    const grossMonthly = actual ? actual.monthly_avg : (plRevenue[p.id] || p.est_monthly_revenue || 0);
    // Property expenses (same calc as portfolio properties)
    const propExpenses = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0) + (p.monthly_rent_cost || 0) + (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);
    // Fee basis: 'gross' = % of gross revenue, 'net_profit' = % of (gross - expenses)
    const feeBase = feeBasis === 'net_profit' ? Math.max(0, grossMonthly - propExpenses) : grossMonthly;
    const yourFee = Math.round(feeBase * feePct / 100) + baseFee;
    const ownerPayout = grossMonthly - propExpenses - yourFee;

    // Build full calendar — every month from first booking (or 12 months ago) to current
    const monthlyData = monthlyBreakdown[p.id] || [];
    const fullCalendar = [];
    if (monthlyData.length > 0 || baseFee > 0 || propExpenses > 0) {
      const firstMonth = monthlyData.length > 0 ? monthlyData[0].month : null;
      const now = new Date();
      const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      // Start from first booking month or 12 months ago, whichever is earlier
      let startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 12);
      if (firstMonth) {
        const fmDate = new Date(firstMonth + '-01');
        if (fmDate < startDate) startDate = fmDate;
      }
      const startMonth = startDate.getFullYear() + '-' + String(startDate.getMonth() + 1).padStart(2, '0');
      // Build a map of months with data
      const dataMap = {};
      for (const m of monthlyData) { dataMap[m.month] = m; }
      // Iterate every month
      let d = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
      let runningBalance = 0;
      while (true) {
        const mk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        if (mk > currentMonth) break;
        const hasData = dataMap[mk];
        const mRev = hasData ? (hasData.total_revenue || 0) : 0;
        const mPayout = hasData ? (hasData.host_payout || 0) : 0;
        const mClean = hasData ? (hasData.cleaning_revenue || 0) : 0;
        const mComm = hasData ? (hasData.platform_commission || 0) : 0;
        const mNights = hasData ? (hasData.booked_nights || 0) : 0;
        const mAvail = hasData ? (hasData.available_nights || 0) : new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const mOcc = mAvail > 0 ? (hasData ? (hasData.occupancy_pct || 0) : 0) : 0;
        const mAdr = hasData ? (hasData.avg_nightly_rate || 0) : 0;
        const mFeeBase = feeBasis === 'net_profit' ? Math.max(0, mRev - propExpenses) : mRev;
        const mPctFee = Math.round(mFeeBase * feePct / 100);
        const mTotalFee = mPctFee + baseFee;
        const mOwnerNet = Math.round(mRev - propExpenses - mTotalFee);
        runningBalance += mOwnerNet;
        fullCalendar.push({
          month: mk, total_revenue: mRev, host_payout: mPayout,
          cleaning_revenue: mClean, platform_commission: mComm,
          booked_nights: mNights, available_nights: mAvail,
          occupancy_pct: mOcc, avg_nightly_rate: mAdr,
          expenses: propExpenses, pct_fee: mPctFee, base_fee: baseFee,
          total_fee: mTotalFee, owner_net: mOwnerNet,
          running_balance: runningBalance, has_bookings: mRev > 0
        });
        d.setMonth(d.getMonth() + 1);
      }
    }

    if (!byOwner[ownerName]) byOwner[ownerName] = { owner: ownerName, properties: [], totalGross: 0, totalExpenses: 0, totalFee: 0, totalPayout: 0 };
    byOwner[ownerName].properties.push(p.name || p.address);
    byOwner[ownerName].totalGross += grossMonthly;
    byOwner[ownerName].totalExpenses += propExpenses;
    byOwner[ownerName].totalFee += yourFee;
    byOwner[ownerName].totalPayout += ownerPayout;

    totalGross += grossMonthly;
    totalExpenses += propExpenses;
    totalYourFee += yourFee;
    totalOwnerPayout += ownerPayout;

    return {
      id: p.id, name: p.name || p.address, address: p.address,
      city: p.city, state: p.state, unit_number: p.unit_number,
      owner_name: ownerName, fee_pct: feePct, fee_basis: feeBasis,
      base_fee: baseFee,
      gross_monthly: Math.round(grossMonthly),
      expenses: Math.round(propExpenses),
      net_profit: Math.round(Math.max(0, grossMonthly - propExpenses)),
      fee_base: Math.round(feeBase),
      your_fee: yourFee,
      owner_payout: Math.round(ownerPayout),
      actual: actual || null,
      monthly_breakdown: monthlyBreakdown[p.id] || [],
      full_calendar: fullCalendar,
      reservations: reservationDetail[p.id] || [],
      has_actual: !!actual,
    };
  });

  return {
    count: managedProps.length,
    total_gross: Math.round(totalGross),
    total_expenses: Math.round(totalExpenses),
    total_net_profit: Math.round(totalGross - totalExpenses),
    total_your_fee: Math.round(totalYourFee),
    total_owner_payout: Math.round(totalOwnerPayout),
    by_owner: Object.values(byOwner).map(o => ({ ...o, totalGross: Math.round(o.totalGross), totalExpenses: Math.round(o.totalExpenses), totalFee: Math.round(o.totalFee), totalPayout: Math.round(o.totalPayout) })),
    properties: propertyDetails,
  };
}

async function getFinanceMonthlyActuals(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT ma.property_id, ma.month, ma.total_revenue, ma.booked_nights, ma.available_nights, ma.occupancy_pct, ma.avg_nightly_rate, ma.num_reservations, ma.host_payout, ma.cleaning_revenue, ma.total_taxes, ma.platform_commission, ma.taxes_you_owe, COALESCE(ma.total_refunded, 0) as total_refunded, COALESCE(ma.cancellation_fees, 0) as cancellation_fees, p.name as prop_name, p.address, p.unit_number, p.city, p.state FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE (p.is_research != 1 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL) ORDER BY ma.month`).all();
    // Also get seasonality for all markets
    const { results: season } = await env.DB.prepare(`SELECT city, state, month_number, multiplier, avg_occupancy FROM market_seasonality ORDER BY city, state, month_number`).all();
    return { actuals: results || [], seasonality: season || [] };
  } catch { return { actuals: [], seasonality: [] }; }
}

// Admin: list all users with property counts
async function getAdminUsersList(env) {
  const { results } = await env.DB.prepare(`SELECT u.id, u.email, u.display_name, u.role, u.created_at, (SELECT COUNT(*) FROM properties WHERE user_id = u.id) as property_count, (SELECT COUNT(*) FROM master_listings WHERE user_id = u.id) as listing_count FROM users u ORDER BY u.created_at DESC`).all();
  return json({ users: results });
}
// Upsert a listing into master_listings (dedup by platform + platform_id or listing_url)
async function upsertMasterListing(env, listing, uid) {
  // Try to find existing by platform_id or URL
  let existing = null;
  if (listing.platform_id) {
    existing = await env.DB.prepare(`SELECT id, scrape_count FROM master_listings WHERE platform = ? AND platform_id = ?`).bind(listing.platform, listing.platform_id).first();
  }
  if (!existing && listing.listing_url) {
    existing = await env.DB.prepare(`SELECT id, scrape_count FROM master_listings WHERE listing_url = ?`).bind(listing.listing_url).first();
  }
  if (existing) {
    // Update existing — refresh all data fields, not just price
    await env.DB.prepare(`UPDATE master_listings SET title=?, description=COALESCE(?,description), host_name=COALESCE(?,host_name), nightly_rate=COALESCE(?,nightly_rate), weekly_rate=COALESCE(?,weekly_rate), monthly_rate=COALESCE(?,monthly_rate), cleaning_fee=?, service_fee=COALESCE(?,service_fee), rating=COALESCE(?,rating), review_count=CASE WHEN ?>0 THEN ? ELSE review_count END, superhost=?, bedrooms=COALESCE(?,bedrooms), bathrooms=COALESCE(?,bathrooms), sleeps=COALESCE(?,sleeps), property_type=COALESCE(?,property_type), latitude=COALESCE(?,latitude), longitude=COALESCE(?,longitude), amenities_json=COALESCE(?,amenities_json), photos_json=COALESCE(?,photos_json), raw_data=COALESCE(?,raw_data), last_updated=datetime('now'), last_scraped=datetime('now'), scrape_count=?, status='active' WHERE id=?`)
      .bind(
        listing.title || null, listing.description || null, listing.host_name || null,
        listing.nightly_rate || null, listing.weekly_rate || null, listing.monthly_rate || null,
        listing.cleaning_fee || 0, listing.service_fee || null,
        listing.rating || null, listing.review_count || 0, listing.review_count || 0,
        listing.superhost || 0,
        listing.bedrooms || null, listing.bathrooms || null, listing.sleeps || null,
        listing.property_type || null, listing.latitude || null, listing.longitude || null,
        listing.amenities_json || null, listing.photos_json || null,
        listing.raw_data || null,
        (existing.scrape_count || 1) + 1, existing.id
      ).run();
    return { id: existing.id, action: 'updated' };
  }
  // Insert new
  const r = await env.DB.prepare(`INSERT INTO master_listings (user_id, platform, listing_type, platform_id, listing_url, title, description, host_name, city, state, zip, address, latitude, longitude, bedrooms, bathrooms, sleeps, sqft, property_type, nightly_rate, weekly_rate, monthly_rate, cleaning_fee, service_fee, rating, review_count, superhost, amenities_json, photos_json, raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(uid || listing.user_id || null, listing.platform, listing.listing_type || 'str', listing.platform_id || null, listing.listing_url || null, listing.title || null, listing.description || null, listing.host_name || null, listing.city || null, listing.state || null, listing.zip || null, listing.address || null, listing.latitude || null, listing.longitude || null, listing.bedrooms || null, listing.bathrooms || null, listing.sleeps || null, listing.sqft || null, listing.property_type || null, listing.nightly_rate || null, listing.weekly_rate || null, listing.monthly_rate || null, listing.cleaning_fee || 0, listing.service_fee || 0, listing.rating || null, listing.review_count || 0, listing.superhost || 0, listing.amenities_json || null, listing.photos_json || null, listing.raw_data || null).run();
  return { id: r.meta.last_row_id, action: 'created' };
}

async function getMasterListings(params, env, uid) {
  let q = `SELECT * FROM master_listings WHERE 1=1`;
  const p = [];
  if (uid) { q += ` AND (user_id = ? OR user_id IS NULL)`; p.push(uid); }
  const city = params.get('city');
  const state = params.get('state');
  const type = params.get('type');
  const platform = params.get('platform');
  const beds = params.get('bedrooms');
  if (city) { q += ` AND LOWER(city) = LOWER(?)`; p.push(city); }
  if (state) { q += ` AND state = ?`; p.push(state); }
  if (type) { q += ` AND listing_type = ?`; p.push(type); }
  if (platform) { q += ` AND platform = ?`; p.push(platform); }
  if (beds) { q += ` AND bedrooms = ?`; p.push(parseInt(beds)); }
  q += ` ORDER BY last_updated DESC LIMIT 100`;
  const { results } = await env.DB.prepare(q).bind(...p).all();
  return json({ listings: results, count: results.length });
}

async function getMasterListingsStats(env, uid) {
  const uf = uid ? ` WHERE (user_id = ? OR user_id IS NULL)` : '';
  const uf2 = uid ? ` AND (user_id = ? OR user_id IS NULL)` : '';
  const b = uid ? [uid] : [];
  const total = await env.DB.prepare(`SELECT COUNT(*) as c FROM master_listings` + uf).bind(...b).first();
  const byPlatform = await env.DB.prepare(`SELECT platform, COUNT(*) as c FROM master_listings` + uf + ` GROUP BY platform ORDER BY c DESC`).bind(...b).all();
  const byCity = await env.DB.prepare(`SELECT city, state, COUNT(*) as c FROM master_listings` + uf + ` GROUP BY city, state ORDER BY c DESC LIMIT 20`).bind(...b).all();
  const byType = await env.DB.prepare(`SELECT listing_type, COUNT(*) as c FROM master_listings` + uf + ` GROUP BY listing_type`).bind(...b).all();
  const recent = await env.DB.prepare(`SELECT COUNT(*) as c FROM master_listings WHERE last_updated > datetime('now', '-7 days')` + uf2).bind(...b).first();
  return json({ total: total.c, recent_7d: recent.c, by_platform: byPlatform.results, by_city: byCity.results, by_type: byType.results });
}

// Upload file (screenshot, CSV, HAR, PDF) for AI processing
async function intelUpload(request, env, uid) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) return json({ error: 'Must use multipart/form-data' }, 400);
  const formData = await request.formData();
  const file = formData.get('file');
  if (!file || !file.name) return json({ error: 'No file uploaded' }, 400);

  const maxSize = 25 * 1024 * 1024; // 25MB
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > maxSize) return json({ error: 'File too large (max 25MB)' }, 400);

  // Determine upload type from mime/extension
  const mime = file.type || '';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let uploadType = 'text';
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mime)) uploadType = 'screenshot';
  else if (ext === 'csv' || mime.includes('csv')) uploadType = 'csv';
  else if (ext === 'har') uploadType = 'har';
  else if (ext === 'pdf' || mime.includes('pdf')) uploadType = 'pdf';
  else if (ext === 'xlsx' || ext === 'xls' || mime.includes('spreadsheet')) uploadType = 'csv';
  else if (ext === 'json') uploadType = 'har'; // Could be HAR or JSON data
  else if (ext === 'txt') uploadType = 'text';

  // Store in R2
  let r2Key = null;
  if (env.IMAGES) {
    r2Key = 'intel/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext;
    await env.IMAGES.put(r2Key, buffer, { httpMetadata: { contentType: mime }, customMetadata: { originalName: file.name } });
  }

  // Create upload record
  const res = await env.DB.prepare(`INSERT INTO data_uploads (user_id, upload_type, filename, r2_key, mime_type, size_bytes, status) VALUES (?,?,?,?,?,?,'processing')`)
    .bind(uid || null, uploadType, file.name, r2Key, mime, buffer.byteLength).run();
  const uploadId = res.meta.last_row_id;

  // Process based on type
  let extracted = 0;
  let aiSummary = '';
  let error = null;

  try {
    if (uploadType === 'screenshot' && env.AI) {
      // Use AI vision to extract listing data from screenshot
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
      const aiResult = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        messages: [{ role: 'user', content: [
          { type: 'text', text: `Extract ALL rental listings visible in this screenshot. For each listing, return a JSON array of objects with: {"title":"","platform":"airbnb/vrbo/booking/zillow/other","bedrooms":N,"bathrooms":N,"nightly_rate":N,"monthly_rate":N,"cleaning_fee":N,"rating":N,"review_count":N,"city":"","state":"","property_type":"","host_name":"","listing_url":""}. Use null for unknown fields. Return ONLY the JSON array, no other text.` },
          { type: 'image', image: base64 }
        ]}],
        max_tokens: 2000
      });
      if (aiResult.response) {
        try {
          const cleaned = aiResult.response.replace(/```json|```/g, '').trim();
          let listings = JSON.parse(cleaned);
          if (!Array.isArray(listings)) listings = [listings];
          for (const l of listings) {
            if (l.title || l.nightly_rate || l.monthly_rate) {
              await upsertMasterListing(env, { ...l, platform: l.platform || 'manual' }, uid);
              extracted++;
            }
          }
          aiSummary = 'Extracted ' + extracted + ' listings from screenshot';
        } catch { aiSummary = 'AI response: ' + (aiResult.response || '').substring(0, 500); }
      }
      await trackAI(env, 'intel_screenshot', 'workers_ai', 2000, true, null);

    } else if (uploadType === 'csv') {
      // Parse CSV — detect columns and import rows
      const text = new TextDecoder().decode(buffer);
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) throw new Error('CSV has no data rows');
      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/['"]/g, ''));

      // Map common column names
      const colMap = {};
      headers.forEach((h, i) => {
        if (h.includes('title') || h.includes('name') || h.includes('listing')) colMap.title = i;
        if (h.includes('bedroom') || h === 'beds' || h === 'br') colMap.bedrooms = i;
        if (h.includes('bathroom') || h === 'baths' || h === 'ba') colMap.bathrooms = i;
        if (h.includes('nightly') || h.includes('price') || h.includes('rate') || h.includes('adr')) colMap.nightly_rate = i;
        if (h.includes('monthly') || h.includes('rent')) colMap.monthly_rate = i;
        if (h.includes('clean')) colMap.cleaning_fee = i;
        if (h.includes('rating') || h.includes('score') || h.includes('stars')) colMap.rating = i;
        if (h.includes('review')) colMap.review_count = i;
        if (h.includes('city') || h.includes('market')) colMap.city = i;
        if (h.includes('state')) colMap.state = i;
        if (h.includes('url') || h.includes('link')) colMap.listing_url = i;
        if (h.includes('platform') || h.includes('source') || h.includes('channel')) colMap.platform = i;
        if (h.includes('host')) colMap.host_name = i;
        if (h.includes('type') || h.includes('category')) colMap.property_type = i;
        if (h.includes('sleep') || h.includes('guest') || h.includes('capacity')) colMap.sleeps = i;
        if (h.includes('sqft') || h.includes('sq ft') || h.includes('square')) colMap.sqft = i;
        if (h.includes('address')) colMap.address = i;
        if (h.includes('zip') || h.includes('postal')) colMap.zip = i;
        if (h.includes('superhost')) colMap.superhost = i;
      });

      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',').map(v => v.trim().replace(/^["']|["']$/g, ''));
        const row = {};
        for (const [field, idx] of Object.entries(colMap)) {
          if (idx < vals.length) row[field] = vals[idx] || null;
        }
        // Clean numeric fields
        if (row.nightly_rate) row.nightly_rate = parseFloat(String(row.nightly_rate).replace(/[$,]/g, '')) || null;
        if (row.monthly_rate) row.monthly_rate = parseFloat(String(row.monthly_rate).replace(/[$,]/g, '')) || null;
        if (row.cleaning_fee) row.cleaning_fee = parseFloat(String(row.cleaning_fee).replace(/[$,]/g, '')) || 0;
        if (row.rating) row.rating = parseFloat(row.rating) || null;
        if (row.review_count) row.review_count = parseInt(row.review_count) || 0;
        if (row.bedrooms) row.bedrooms = parseInt(row.bedrooms) || null;
        if (row.bathrooms) row.bathrooms = parseFloat(row.bathrooms) || null;
        if (row.sleeps) row.sleeps = parseInt(row.sleeps) || null;
        if (row.sqft) row.sqft = parseInt(String(row.sqft).replace(/,/g, '')) || null;
        if (row.superhost) row.superhost = row.superhost === '1' || row.superhost.toLowerCase() === 'true' || row.superhost.toLowerCase() === 'yes' ? 1 : 0;
        row.platform = row.platform || 'csv_import';
        row.listing_type = row.nightly_rate ? 'str' : (row.monthly_rate ? 'ltr' : 'str');

        if (row.title || row.nightly_rate || row.monthly_rate || row.listing_url) {
          await upsertMasterListing(env, row, uid);
          extracted++;
        }
      }
      aiSummary = 'Imported ' + extracted + ' listings from CSV (' + (lines.length - 1) + ' rows, mapped columns: ' + Object.keys(colMap).join(', ') + ')';

    } else if (uploadType === 'har') {
      // Parse HAR file — extract Airbnb StaysSearch API responses
      const text = new TextDecoder().decode(buffer);
      let harData;
      try { harData = JSON.parse(text); } catch { throw new Error('Invalid JSON/HAR file'); }

      const entries = harData.log ? harData.log.entries : (Array.isArray(harData) ? harData : []);
      for (const entry of entries) {
        if (!entry.response || !entry.response.content || !entry.response.content.text) continue;
        const reqUrl = entry.request ? entry.request.url : '';
        // Look for Airbnb StaysSearch responses
        if (reqUrl.includes('StaysSearch') || reqUrl.includes('/api/v3/') || reqUrl.includes('airbnb')) {
          try {
            const body = JSON.parse(entry.response.content.text);
            // Navigate Airbnb's nested response structure
            const results = body.data?.presentation?.staysSearch?.results?.searchResults ||
                           body.data?.presentation?.staysSearch?.mapResults?.mapSearchResults ||
                           body.data?.staysSearch?.results || [];
            for (const r of results) {
              const listing = r.listing || r;
              if (!listing.name && !listing.title) continue;
              const price = r.pricingQuote || r.pricing || {};
              const nightly = price.rate?.amount || price.priceItems?.[0]?.total?.amount || null;
              await upsertMasterListing(env, {
                platform: 'airbnb', listing_type: 'str',
                platform_id: listing.id || listing.listingId || null,
                listing_url: listing.id ? 'https://www.airbnb.com/rooms/' + listing.id : null,
                title: listing.name || listing.title,
                city: listing.city || null, state: listing.state || null,
                bedrooms: listing.bedrooms || null, bathrooms: listing.bathrooms || null,
                sleeps: listing.personCapacity || listing.guestCapacity || null,
                property_type: listing.roomType || listing.propertyType || null,
                nightly_rate: nightly, rating: listing.avgRating || listing.rating || null,
                review_count: listing.reviewsCount || listing.reviews || 0,
                superhost: listing.isSuperhost ? 1 : 0,
                latitude: listing.lat || listing.latitude || null,
                longitude: listing.lng || listing.longitude || null,
                raw_data: JSON.stringify(r).substring(0, 2000),
              });
              extracted++;
            }
          } catch {}
        }
      }
      aiSummary = 'Parsed HAR file: extracted ' + extracted + ' listings from ' + entries.length + ' network entries';

    } else if (uploadType === 'text' || uploadType === 'pdf') {
      // For text/PDF: use AI to extract any listing data
      if (env.AI) {
        const text = uploadType === 'text' ? new TextDecoder().decode(buffer) : 'PDF file uploaded: ' + file.name;
        const snippet = text.substring(0, 3000);
        const aiResult = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', {
          messages: [{ role: 'user', content: `Extract rental listing data from this content. Return a JSON array of listing objects with fields: title, platform, bedrooms, bathrooms, nightly_rate, monthly_rate, cleaning_fee, rating, review_count, city, state, property_type, host_name, listing_url. Use null for unknown. Return ONLY the JSON array.\n\nContent:\n${snippet}` }],
          max_tokens: 2000
        });
        if (aiResult.response) {
          try {
            const cleaned = aiResult.response.replace(/```json|```/g, '').trim();
            let listings = JSON.parse(cleaned);
            if (!Array.isArray(listings)) listings = [listings];
            for (const l of listings) {
              if (l.title || l.nightly_rate || l.monthly_rate) {
                await upsertMasterListing(env, { ...l, platform: l.platform || 'manual' });
                extracted++;
              }
            }
          } catch {}
          aiSummary = aiResult.response.substring(0, 500);
        }
        await trackAI(env, 'intel_text', 'workers_ai', 2000, true, null);
      }
    }
  } catch (e) { error = e.message; }

  // Update upload record
  await env.DB.prepare(`UPDATE data_uploads SET status=?, listings_extracted=?, ai_summary=?, error_message=?, processed_at=datetime('now') WHERE id=?`)
    .bind(error ? 'failed' : 'complete', extracted, aiSummary || null, error, uploadId).run();

  return json({ id: uploadId, upload_type: uploadType, listings_extracted: extracted, ai_summary: aiSummary, error: error, message: extracted > 0 ? 'Extracted ' + extracted + ' listings' : (error || 'No listings found') });
}

async function getDataUploads(env, uid) {
  const uf = uid ? ` WHERE (user_id = ? OR user_id IS NULL)` : '';
  const { results } = await env.DB.prepare(`SELECT * FROM data_uploads` + uf + ` ORDER BY uploaded_at DESC LIMIT 50`).bind(...(uid ? [uid] : [])).all();
  return json({ uploads: results });
}

// Bulk import URL list — user pastes Airbnb/VRBO/etc URLs, we create crawl jobs
async function importUrlList(request, env, uid) {
  const { urls } = await request.json();
  if (!urls || !Array.isArray(urls) || urls.length === 0) return json({ error: 'urls array required' }, 400);

  const jobs = [];
  for (const rawUrl of urls.slice(0, 50)) { // max 50 URLs per batch
    const url = rawUrl.trim();
    if (!url || !url.startsWith('http')) continue;

    // Detect platform
    let platform = 'other';
    const lower = url.toLowerCase();
    if (lower.includes('airbnb')) platform = 'airbnb';
    else if (lower.includes('vrbo') || lower.includes('homeaway')) platform = 'vrbo';
    else if (lower.includes('booking.com')) platform = 'booking';
    else if (lower.includes('zillow')) platform = 'zillow';
    else if (lower.includes('apartments.com')) platform = 'apartments';
    else if (lower.includes('furnished')) platform = 'furnished_finder';

    // Extract platform ID from URL
    let platformId = null;
    if (platform === 'airbnb') { const m = url.match(/\/rooms\/(\d+)/); if (m) platformId = m[1]; }
    else if (platform === 'vrbo') { const m = url.match(/\/(\d{4,})/); if (m) platformId = m[1]; }

    // Check if already in master DB
    let exists = false;
    if (platformId) {
      const ex = await env.DB.prepare(`SELECT id FROM master_listings WHERE platform = ? AND platform_id = ?`).bind(platform, platformId).first();
      if (ex) exists = true;
    }

    // Create crawl job
    const r = await env.DB.prepare(`INSERT INTO crawl_jobs (user_id, job_type, status, target_url, target_platform) VALUES (?, 'url_scrape', 'pending', ?, ?)`)
      .bind(uid || null, url, platform).run();
    jobs.push({ id: r.meta.last_row_id, url, platform, platform_id: platformId, already_exists: exists });
  }

  // Process jobs immediately using parseListingUrl logic
  let processed = 0, newListings = 0, updated = 0;
  for (const job of jobs) {
    try {
      await env.DB.prepare(`UPDATE crawl_jobs SET status='running', started_at=datetime('now') WHERE id=?`).bind(job.id).run();

      // Reuse the URL parser
      const fakeReq = { json: async () => ({ url: job.url }) };
      const result = await parseListingUrl(fakeReq, env);
      const parsed = await result.json();

      if (parsed.title || parsed.nightly_rate) {
        const uResult = await upsertMasterListing(env, {
          platform: parsed.source || job.platform,
          listing_type: parsed.nightly_rate && parsed.nightly_rate < 1000 ? 'str' : 'ltr',
          platform_id: job.platform_id,
          listing_url: job.url,
          title: parsed.title,
          host_name: parsed.host_name,
          bedrooms: parsed.bedrooms,
          bathrooms: parsed.bathrooms,
          sleeps: parsed.sleeps,
          property_type: parsed.property_type,
          nightly_rate: parsed.nightly_rate,
          cleaning_fee: parsed.cleaning_fee,
          rating: parsed.rating,
          review_count: parsed.review_count,
        });
        if (uResult.action === 'created') newListings++;
        else updated++;
      }
      processed++;
      await env.DB.prepare(`UPDATE crawl_jobs SET status='complete', listings_new=?, listings_updated=?, completed_at=datetime('now') WHERE id=?`)
        .bind(newListings, updated, job.id).run();
    } catch (e) {
      await env.DB.prepare(`UPDATE crawl_jobs SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`).bind(e.message, job.id).run();
    }
  }

  return json({ jobs_created: jobs.length, processed, new_listings: newListings, updated, message: 'Processed ' + processed + ' URLs: ' + newListings + ' new, ' + updated + ' updated' });
}

// Trigger a crawl for a specific city/platform
async function triggerCrawl(request, env, uid) {
  const { city, state, platform, listing_type } = await request.json();
  if (!city || !state) return json({ error: 'city and state required' }, 400);
  const isSTR = listing_type !== 'ltr';

  const r = await env.DB.prepare(`INSERT INTO crawl_jobs (user_id, job_type, status, target_city, target_state, target_platform, started_at) VALUES (?, 'search_refresh', 'running', ?, ?, ?, datetime('now'))`)
    .bind(uid || null, city, state, platform || (isSTR ? 'airbnb' : 'rentcast')).run();
  const jobId = r.meta.last_row_id;

  let found = 0, newL = 0, updL = 0;

  try {
    // STR: Use SearchAPI for Airbnb data
    if (isSTR && env.SEARCHAPI_KEY) {
      const cin = new Date(Date.now() + 14 * 86400000);
      const cout = new Date(cin.getTime() + 3 * 86400000);
      const saParams = new URLSearchParams({ engine: 'airbnb', q: city + ', ' + state, check_in_date: cin.toISOString().split('T')[0], check_out_date: cout.toISOString().split('T')[0], adults: '2' });
      await trackApiCall(env, 'searchapi', 'intel_airbnb', true);
      const saResp = await fetch('https://www.searchapi.io/api/v1/search?' + saParams.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
      });
      if (saResp.ok) {
        const saData = await saResp.json();
        const listings = saData.properties || [];
        for (const l of listings.slice(0, 20)) {
          let nightlyRate = 0;
          if (l.price?.extracted_price) nightlyRate = l.price.extracted_price;
          else if (l.price?.extracted_total_price) nightlyRate = Math.round(l.price.extracted_total_price / 3);
          else if (l.pricing?.nightly_rate) nightlyRate = l.pricing.nightly_rate;
          if (nightlyRate <= 0) continue;

          const res = await upsertMasterListing(env, {
            platform: 'airbnb', listing_type: 'str',
            platform_id: l.id, listing_url: l.link || ('https://www.airbnb.com/rooms/' + l.id),
            title: l.title || l.name, city, state,
            bedrooms: l.beds || l.bedroom_count || null, bathrooms: l.bathrooms || null,
            sleeps: l.guest_capacity || null, property_type: l.property_type || null,
            nightly_rate: Math.round(nightlyRate),
            rating: l.rating || l.overall_rating || null, review_count: l.reviews || l.review_count || 0,
            superhost: l.is_superhost ? 1 : 0,
            raw_data: JSON.stringify(l).substring(0, 2000),
          });
          found++;
          if (res.action === 'created') newL++; else updL++;
        }
      }
    }

    // LTR: Use cached market data only — no live RentCast calls during intel crawl
    // RentCast data should come from explicit "Refresh Market Data" button

    await env.DB.prepare(`UPDATE crawl_jobs SET status='complete', listings_found=?, listings_new=?, listings_updated=?, completed_at=datetime('now') WHERE id=?`)
      .bind(found, newL, updL, jobId).run();

    // Update watchlist stats from master_listings (same as cron does)
    try {
      await env.DB.prepare(`UPDATE market_watchlist SET listing_count = (SELECT COUNT(*) FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND status = 'active'), avg_price = (SELECT ROUND(AVG(nightly_rate), 2) FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND status = 'active' AND nightly_rate > 0), new_listings_30d = (SELECT COUNT(*) FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND first_seen >= datetime('now', '-30 days')), last_crawl = datetime('now'), updated_at = datetime('now') WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`)
        .bind(city, state, city, state, city, state, city, state).run();
    } catch {}
    // Also rebuild the market profile so top cards update
    try { await buildMarketProfile(city, state, env); } catch {}
  } catch (e) {
    await env.DB.prepare(`UPDATE crawl_jobs SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`).bind(e.message, jobId).run();
    return json({ job_id: jobId, error: e.message });
  }

  return json({ job_id: jobId, listings_found: found, new: newL, updated: updL, message: 'Crawl complete: ' + found + ' listings (' + newL + ' new, ' + updL + ' updated)' });
}

async function getCrawlJobs(env, uid) {
  const uf = uid ? ` WHERE (user_id = ? OR user_id IS NULL)` : '';
  const { results } = await env.DB.prepare(`SELECT *, CASE WHEN started_at IS NOT NULL AND completed_at IS NOT NULL THEN CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER) ELSE NULL END as duration_seconds FROM crawl_jobs` + uf + ` ORDER BY created_at DESC LIMIT 50`).bind(...(uid ? [uid] : [])).all();
  return json({ jobs: results });
}

async function deleteCrawlJob(id, env, uid) {
  if (uid) await env.DB.prepare(`DELETE FROM crawl_jobs WHERE id = ? AND (user_id = ? OR user_id IS NULL)`).bind(id, uid).run();
  else await env.DB.prepare(`DELETE FROM crawl_jobs WHERE id = ?`).bind(id).run();
  return json({ message: 'Crawl job deleted' });
}

async function uploadImage(request, env) {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) return json({ error: 'Must use multipart/form-data' }, 400);
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !file.name) return json({ error: 'No file uploaded' }, 400);
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/x-icon', 'image/svg+xml'];
    if (!allowed.includes(file.type)) return json({ error: 'Only JPEG, PNG, GIF, WebP, ICO, SVG allowed' }, 400);
    const maxSize = 5 * 1024 * 1024; // 5MB
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > maxSize) return json({ error: 'File too large (max 5MB)' }, 400);
    // Generate unique key
    const ext = file.name.split('.').pop() || 'bin';
    const key = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    // Store in R2 if available, fall back to D1
    if (env.IMAGES) {
      await env.IMAGES.put(key, buffer, {
        httpMetadata: { contentType: file.type },
        customMetadata: { originalName: file.name }
      });
      const imageUrl = '/api/images/r2/' + key;
      return json({ id: key, url: imageUrl, message: 'Image uploaded', storage: 'r2' }, 201);
    } else {
      // Fallback: store in D1 (legacy)
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const result = await env.DB.prepare(`INSERT INTO images (filename, mime_type, data, size_bytes) VALUES (?, ?, ?, ?)`).bind(file.name, file.type, base64, buffer.byteLength).run();
      const imageId = result.meta.last_row_id;
      const imageUrl = '/api/images/' + imageId;
      return json({ id: imageId, url: imageUrl, message: 'Image uploaded', storage: 'd1' }, 201);
    }
  } catch (err) { return json({ error: 'Upload failed: ' + err.message }, 500); }
}

async function getImage(id, env) {
  // Try R2 first (new path: /api/images/r2/KEY)
  // This handler is called for /api/images/:id — check if it's a D1 numeric id
  const img = await env.DB.prepare(`SELECT mime_type, data FROM images WHERE id = ?`).bind(id).first();
  if (!img) return new Response('Not found', { status: 404 });
  const binary = atob(img.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: { 'Content-Type': img.mime_type, 'Cache-Control': 'public, max-age=86400', ...CORS_HEADERS }
  });
}

async function getR2Image(key, env) {
  if (!env.IMAGES) return new Response('R2 not configured', { status: 500 });
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400',
      'ETag': obj.httpEtag || '',
      ...CORS_HEADERS
    }
  });
}

async function importCSV(request, env, uid) {
  const { rows } = await request.json();
  if (!rows || !Array.isArray(rows) || rows.length === 0) return json({ error: 'No rows provided' }, 400);

  const results = { imported: 0, skipped: 0, errors: [] };
  const stmt = env.DB.prepare(`INSERT INTO properties (user_id, address, city, state, zip, property_type, bedrooms, bathrooms, sqft, lot_acres, year_built, purchase_price, estimated_value, annual_taxes, hoa_monthly) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const batch = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.address || !r.city || !r.state) {
      results.errors.push(`Row ${i + 1}: missing address, city, or state`);
      results.skipped++;
      continue;
    }
    batch.push(stmt.bind(
      uid || null, r.address, r.city, r.state.toUpperCase(), r.zip || null,
      r.property_type || 'single_family',
      parseInt(r.bedrooms) || 1, parseFloat(r.bathrooms) || 1,
      parseInt(r.sqft) || null, parseFloat(r.lot_acres) || null,
      parseInt(r.year_built) || null,
      parseFloat(r.purchase_price) || null, parseFloat(r.estimated_value) || null,
      parseFloat(r.annual_taxes) || null, parseFloat(r.hoa_monthly) || 0
    ));
    results.imported++;
  }

  if (batch.length > 0) {
    try { await env.DB.batch(batch); }
    catch (err) { return json({ error: 'Database insert failed: ' + err.message, results }, 500); }
  }

  return json(results);
}

async function placesAutocomplete(query, env) {
  if (!query) return json({ predictions: [] });
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'GOOGLE_PLACES_API_KEY not configured. Set it with: wrangler secret put GOOGLE_PLACES_API_KEY', predictions: [] }, 200);

  try {
    await trackApiCall(env, 'google_places', 'autocomplete', true);
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(query)}&types=address&components=country:us&key=${apiKey}`
    );
    const data = await res.json();
    return json({ predictions: (data.predictions || []).map(p => ({ description: p.description, place_id: p.place_id })) });
  } catch (err) { return json({ predictions: [], error: err.message }); }
}

async function placesDetails(placeId, env) {
  if (!placeId) return json({ error: 'place_id required' }, 400);
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'GOOGLE_PLACES_API_KEY not configured' }, 400);

  try {
    await trackApiCall(env, 'google_places', 'details', true);
    const res = await fetch(
      `https://maps.googleapis.com/maps/api/place/details/json?place_id=${placeId}&fields=address_components,geometry,formatted_address&key=${apiKey}`
    );
    const data = await res.json();
    if (!data.result) return json({ error: 'Place not found' }, 404);

    const result = { formatted_address: data.result.formatted_address };
    result.latitude = data.result.geometry?.location?.lat;
    result.longitude = data.result.geometry?.location?.lng;

    for (const c of (data.result.address_components || [])) {
      if (c.types.includes('street_number')) result.street_number = c.long_name;
      if (c.types.includes('route')) result.route = c.long_name;
      if (c.types.includes('locality')) result.city = c.long_name;
      if (c.types.includes('administrative_area_level_1')) result.state = c.short_name;
      if (c.types.includes('postal_code')) result.zip = c.short_name;
      if (c.types.includes('administrative_area_level_2')) result.county = c.long_name;
    }
    result.address = [result.street_number, result.route].filter(Boolean).join(' ');
    return json(result);
  } catch (err) { return json({ error: err.message }, 500); }
}

async function getStrategies(pid, env, uid) {
  // Verify ownership
  const q = uid ? `SELECT id FROM properties WHERE id = ? AND (user_id = ? OR user_id IS NULL)` : `SELECT id FROM properties WHERE id = ?`;
  const owns = uid ? await env.DB.prepare(q).bind(pid, uid).first() : await env.DB.prepare(q).bind(pid).first();
  if (!owns) return json({ error: 'Property not found' }, 404);
  const { results } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC`).bind(pid).all();
  return json({ strategies: results });
}

async function copyPreview(targetId, sourceId, env) {
  const source = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(sourceId).first();
  if (!source) return json({ error: 'Source property not found' }, 404);
  const target = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(targetId).first();
  if (!target) return json({ error: 'Target property not found' }, 404);

  const fieldLabels = {
    ownership_type: 'Ownership Type', monthly_mortgage: 'Monthly Mortgage', monthly_insurance: 'Insurance',
    annual_taxes: 'Annual Taxes', hoa_monthly: 'HOA', monthly_rent_cost: 'Monthly Rent',
    security_deposit: 'Security Deposit', expense_electric: 'Electric', expense_gas: 'Gas/Heat',
    expense_water: 'Water/Sewer', expense_internet: 'Internet', expense_trash: 'Trash',
    expense_other: 'Other Expense', cleaning_fee: 'Cleaning Fee (guest)', cleaning_cost: 'Cleaning Cost (you pay)'
  };

  const fields = [];
  for (const f in fieldLabels) {
    var srcVal = source[f];
    var tgtVal = target[f];
    if (srcVal !== null && srcVal !== undefined && srcVal !== 0 && srcVal !== '') {
      fields.push({
        key: f, label: fieldLabels[f],
        source_value: srcVal, target_value: tgtVal,
        is_money: f !== 'ownership_type',
        would_overwrite: tgtVal && tgtVal !== 0 && tgtVal !== ''
      });
    }
  }

  const { results: srcServices } = await env.DB.prepare(`SELECT name, monthly_cost FROM property_services WHERE property_id = ?`).bind(sourceId).all();
  const { results: tgtServices } = await env.DB.prepare(`SELECT name FROM property_services WHERE property_id = ?`).bind(targetId).all();
  const tgtSvcNames = new Set((tgtServices || []).map(s => s.name));
  const services = (srcServices || []).map(s => ({ name: s.name, monthly_cost: s.monthly_cost, already_exists: tgtSvcNames.has(s.name) }));

  const { results: srcAmenities } = await env.DB.prepare(`SELECT a.id, a.name FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(sourceId).all();
  const { results: tgtAmenities } = await env.DB.prepare(`SELECT amenity_id FROM property_amenities WHERE property_id = ?`).bind(targetId).all();
  const tgtAmenIds = new Set((tgtAmenities || []).map(a => a.amenity_id));
  const amenities = (srcAmenities || []).map(a => ({ id: a.id, name: a.name, already_exists: tgtAmenIds.has(a.id) }));

  return json({
    source: { id: source.id, name: source.name || source.address, city: source.city },
    target: { id: target.id, name: target.name || target.address, city: target.city },
    fields, services, amenities
  });
}

async function copyPropertyData(targetId, sourceId, request, env) {
  const body = await request.json().catch(() => ({}));
  const source = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(sourceId).first();
  if (!source) return json({ error: 'Source property not found' }, 404);
  const target = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(targetId).first();
  if (!target) return json({ error: 'Target property not found' }, 404);

  const selectedFields = body.fields || [];
  const selectedServices = body.services || [];
  const selectedAmenities = body.amenities || [];

  // Copy selected fields
  const updates = [], vals = [];
  for (const f of selectedFields) {
    if (source[f] !== null && source[f] !== undefined) {
      updates.push(f + ' = ?');
      vals.push(source[f]);
    }
  }
  if (updates.length > 0) {
    vals.push(targetId);
    await env.DB.prepare(`UPDATE properties SET ${updates.join(', ')} WHERE id = ?`).bind(...vals).run();
  }

  // Copy selected services
  let svcCopied = 0;
  for (const svcName of selectedServices) {
    const src = await env.DB.prepare(`SELECT name, monthly_cost FROM property_services WHERE property_id = ? AND name = ?`).bind(sourceId, svcName).first();
    if (src) {
      const exists = await env.DB.prepare(`SELECT id FROM property_services WHERE property_id = ? AND name = ?`).bind(targetId, svcName).first();
      if (!exists) {
        await env.DB.prepare(`INSERT INTO property_services (property_id, name, monthly_cost) VALUES (?,?,?)`).bind(targetId, src.name, src.monthly_cost).run();
        svcCopied++;
      }
    }
  }

  // Copy selected amenities
  let amenCopied = 0;
  for (const amenId of selectedAmenities) {
    try { await env.DB.prepare(`INSERT OR IGNORE INTO property_amenities (property_id, amenity_id) VALUES (?,?)`).bind(targetId, amenId).run(); amenCopied++; } catch {}
  }

  return json({ ok: true, fields_copied: updates.length, services_copied: svcCopied, amenities_copied: amenCopied, source: source.name || source.address });
}

async function getUsageAlerts(env) {
  const alerts = [];
  try {
    // Check each API service
    for (const [service, info] of Object.entries(API_COSTS)) {
      if (info.free_limit >= 999999) continue;
      const row = await env.DB.prepare(`SELECT COUNT(*) as c, SUM(cost_cents) as cost FROM api_usage WHERE service = ? AND created_at >= date('now', 'start of month')`).bind(service).first();
      const used = row?.c || 0;
      const cost = (row?.cost || 0) / 100;
      if (info.free_limit > 0) {
        const pct = Math.round(used / info.free_limit * 100);
        if (pct >= 90) alerts.push({ service: info.label, level: 'critical', msg: used + '/' + info.free_limit + ' calls (' + pct + '%) — almost at limit', cost });
        else if (pct >= 70) alerts.push({ service: info.label, level: 'warning', msg: used + '/' + info.free_limit + ' calls (' + pct + '%) — approaching limit', cost });
      }
      if (cost > 10) alerts.push({ service: info.label, level: 'info', msg: '$' + cost.toFixed(2) + ' spent this month', cost });
    }
    // Check AI usage and costs
    const aiRow = await env.DB.prepare(`SELECT SUM(cost_cents) as cost, COUNT(*) as calls FROM ai_usage WHERE created_at >= date('now', 'start of month')`).first();
    const aiCost = (aiRow?.cost || 0) / 100;
    const aiCalls = aiRow?.calls || 0;
    if (aiCost > 5) alerts.push({ service: 'AI Total', level: aiCost > 20 ? 'warning' : 'info', msg: '$' + aiCost.toFixed(2) + ' on ' + aiCalls + ' calls this month' });
    // Check CF daily requests
    const today = new Date().toISOString().split('T')[0];
    const cfRow = await env.DB.prepare(`SELECT requests FROM cf_usage WHERE date = ?`).bind(today).first();
    const todayReqs = cfRow?.requests || 0;
    if (todayReqs > 80000) alerts.push({ service: 'Cloudflare', level: 'critical', msg: todayReqs.toLocaleString() + '/100K daily requests — near limit' });
    else if (todayReqs > 50000) alerts.push({ service: 'Cloudflare', level: 'warning', msg: todayReqs.toLocaleString() + '/100K daily requests' });
    // AI provider breakdown
    const { results: byProvider } = await env.DB.prepare(`SELECT provider, COUNT(*) as calls, SUM(tokens_approx) as tokens, SUM(cost_cents) as cost FROM ai_usage WHERE created_at >= date('now', 'start of month') GROUP BY provider`).all();
    return json({ alerts, ai_summary: { total_cost: aiCost, total_calls: aiCalls, by_provider: byProvider || [] } });
  } catch (e) { return json({ alerts: [], error: e.message }); }
}

async function getCfUsage(env) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const monthStart = today.substring(0, 8) + '01';
    // Today's usage
    const todayRow = await env.DB.prepare(`SELECT * FROM cf_usage WHERE date = ?`).bind(today).first();
    // This month's total
    const monthRow = await env.DB.prepare(`SELECT SUM(requests) as requests, SUM(api_requests) as api_requests FROM cf_usage WHERE date >= ?`).bind(monthStart).first();
    // Last 7 days
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const { results: weekData } = await env.DB.prepare(`SELECT date, requests, api_requests FROM cf_usage WHERE date >= ? ORDER BY date`).bind(weekAgo).all();
    // D1 database size estimate
    const { results: tables } = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all();
    let totalRows = 0;
    for (const t of (tables || [])) {
      try { const c = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${t.name}`).first(); totalRows += (c?.c || 0); } catch {}
    }

    // Free tier limits
    const limits = {
      requests_per_day: 100000,
      worker_size_mb: 1,
      d1_rows_read_per_day: 5000000,
      d1_rows_written_per_day: 100000,
      d1_storage_gb: 5,
    };

    return json({
      today: {
        date: today,
        requests: todayRow?.requests || 0,
        api_requests: todayRow?.api_requests || 0,
        pct_of_limit: Math.round(((todayRow?.requests || 0) / limits.requests_per_day) * 100),
      },
      this_month: {
        requests: monthRow?.requests || 0,
        api_requests: monthRow?.api_requests || 0,
        avg_per_day: weekData.length > 0 ? Math.round((monthRow?.requests || 0) / new Date().getDate()) : 0,
      },
      last_7_days: weekData || [],
      database: {
        total_rows: totalRows,
        table_count: (tables || []).length,
      },
      limits: limits,
      worker_size_kb: 763, // approximate from build
    });
  } catch (e) { return json({ error: e.message }); }
}

async function fetchZestimate(propertyId, env) {
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);

  const apiKey = env.SEARCHAPI_KEY || await (async () => { try { return (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'apikey_SEARCHAPI_KEY'`).first())?.value; } catch { return null; } })();
  if (!apiKey) return json({ error: 'SearchAPI key required for Zillow lookup' }, 400);

  const fullAddr = [property.address, property.city, property.state, property.zip].filter(Boolean).join(', ');
  let zestimate = null, rentZestimate = null, zestSource = '', zillowUrl = null, zillowData = {};

  // ── Pass 1: SearchAPI Zillow engine (structured property data) ──
  try {
    await trackApiCall(env, 'searchapi', 'zillow_property', true);
    const resp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({
      engine: 'zillow',
      search_type: 'buy',
      location: fullAddr,
    }).toString(), { headers: { 'Authorization': 'Bearer ' + apiKey } });
    if (resp.ok) {
      const data = await resp.json();
      // Look for exact address match in listings
      const listings = data.properties || data.results || [];
      const addrLower = (property.address || '').toLowerCase();
      for (const listing of listings.slice(0, 10)) {
        const listAddr = (listing.address?.street || listing.streetAddress || '').toLowerCase();
        if (listAddr && addrLower && listAddr.includes(addrLower.split(' ')[0])) {
          // Found matching property
          if (listing.zestimate) { zestimate = listing.zestimate; zestSource = 'Zillow (structured)'; }
          if (listing.rentZestimate || listing.rent_zestimate) { rentZestimate = listing.rentZestimate || listing.rent_zestimate; }
          if (listing.hdpUrl || listing.url) zillowUrl = 'https://www.zillow.com' + (listing.hdpUrl || listing.url);
          if (listing.price && !zestimate) { zestimate = listing.price; zestSource = 'Zillow listing price'; }
          zillowData = {
            beds: listing.bedrooms || listing.beds,
            baths: listing.bathrooms || listing.baths,
            sqft: listing.livingArea || listing.sqft,
            lot_sqft: listing.lotAreaValue,
            year_built: listing.yearBuilt,
            home_type: listing.homeType,
            days_on_market: listing.daysOnZillow,
            price_per_sqft: listing.price && listing.livingArea ? Math.round(listing.price / listing.livingArea) : null,
          };
          break;
        }
      }
    }
  } catch {}

  // ── Pass 2: Google search for Zestimate snippet (fallback) ──
  if (!zestimate) {
    try {
      await trackApiCall(env, 'searchapi', 'zillow_google_fallback', true);
      const resp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({
        engine: 'google',
        q: fullAddr + ' site:zillow.com zestimate',
      }).toString(), { headers: { 'Authorization': 'Bearer ' + apiKey } });
      if (resp.ok) {
        const data = await resp.json();
        // Answer box first
        const snippet = (data.answer_box?.snippet || '') + ' ' + (data.answer_box?.answer || '');
        if (snippet.trim()) {
          const m = snippet.match(/\$\s*([\d,.]+)\s*(K|M)?/i);
          if (m) {
            let val = parseFloat(m[1].replace(/,/g, ''));
            if (m[2]?.toUpperCase() === 'M') val *= 1000000;
            else if (m[2]?.toUpperCase() === 'K') val *= 1000;
            if (val >= 50000) { zestimate = Math.round(val); zestSource = 'Zillow (Google snippet)'; }
            if (data.answer_box?.link?.includes('zillow.com')) zillowUrl = data.answer_box.link;
          }
        }
        // Organic results
        if (!zestimate) {
          for (const r of (data.organic_results || []).slice(0, 5)) {
            const text = (r.title || '') + ' ' + (r.snippet || '');
            const prices = text.match(/\$([\d,]+(?:,\d{3})+)/g) || [];
            for (const p of prices) {
              const val = parseFloat(p.replace(/[$,]/g, ''));
              if (val >= 50000 && val <= 50000000) {
                zestimate = val;
                zestSource = r.link?.includes('zillow.com') ? 'Zillow' : (r.source || 'Web');
                if (r.link?.includes('zillow.com')) zillowUrl = r.link;
                break;
              }
            }
            if (zestimate) break;
          }
        }
      }
    } catch {}
  }

  if (!zestimate) return json({ error: 'Could not find Zestimate for ' + fullAddr + '. Try adding the Zillow URL to the property first.', address: fullAddr });

  // Save to property
  const today = new Date().toISOString().split('T')[0];
  const updateParts = ['zestimate = ?', 'zestimate_date = ?', 'estimated_value = CASE WHEN estimated_value IS NULL OR estimated_value = 0 THEN ? ELSE estimated_value END'];
  const updateVals = [zestimate, today, zestimate];
  if (zillowUrl) { updateParts.push('zillow_url = ?'); updateVals.push(zillowUrl); }
  updateVals.push(propertyId);
  await env.DB.prepare(`UPDATE properties SET ${updateParts.join(', ')} WHERE id = ?`).bind(...updateVals).run();

  return json({
    zestimate,
    rent_zestimate: rentZestimate,
    source: zestSource,
    date: today,
    zillow_url: zillowUrl,
    address: fullAddr,
    previous_value: property.estimated_value,
    zillow_data: zillowData,
  });
}

async function getExpensesSummary(env) {
  const { results: all } = await env.DB.prepare(`SELECT pe.*, p.name as prop_name, p.address as prop_address, p.unit_number, p.city FROM property_expenses pe JOIN properties p ON pe.property_id = p.id ORDER BY pe.date_incurred DESC`).all();
  const byCategory = {};
  const byProperty = {};
  let total = 0;
  for (const e of (all || [])) {
    total += e.amount;
    const cat = e.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = { category: cat, total: 0, count: 0 };
    byCategory[cat].total += e.amount;
    byCategory[cat].count++;
    const pid = e.property_id;
    if (!byProperty[pid]) byProperty[pid] = { property_id: pid, name: e.prop_name || e.prop_address, unit: e.unit_number, city: e.city, total: 0, count: 0 };
    byProperty[pid].total += e.amount;
    byProperty[pid].count++;
  }
  // Current year expenses
  const year = new Date().getFullYear();
  const thisYear = (all || []).filter(e => e.date_incurred && e.date_incurred.startsWith(String(year)));
  const thisYearTotal = thisYear.reduce((a, e) => a + e.amount, 0);

  return json({
    total,
    this_year_total: thisYearTotal,
    count: (all || []).length,
    by_category: Object.values(byCategory).sort((a, b) => b.total - a.total),
    by_property: Object.values(byProperty).sort((a, b) => b.total - a.total),
    recent: (all || []).slice(0, 10),
  });
}
function normalizeAddress(addr) {
  if (!addr) return '';
  return addr.toLowerCase().trim()
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\bdrive\b/g, 'dr')
    .replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln').replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bcourt\b/g, 'ct').replace(/\bplace\b/g, 'pl').replace(/\bcircle\b/g, 'cir')
    .replace(/\bpl\b/g, 'pl').replace(/\bst\b/g, 'st').replace(/\bave\b/g, 'ave')
    .replace(/,\s*(usa|us|united states)$/i, '')
    .replace(/,\s*\d{5}(-\d{4})?/, '') // strip zip
    .replace(/,\s*[A-Z]{2}\s*\d{5}.*$/, '') // strip state+zip+country
    .replace(/[.,#]/g, '').replace(/\s+/g, ' ');
}

function addressSimilarity(a, b) {
  a = normalizeAddress(a); b = normalizeAddress(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  // Check if one contains the other
  if (a.includes(b) || b.includes(a)) return 0.9;
  // Word overlap score
  const wa = a.split(' '), wb = b.split(' ');
  const common = wa.filter(w => w.length > 1 && wb.includes(w)).length;
  return common / Math.max(wa.length, wb.length);
}

async function importGuestyCsv(request, env, uid) {
  const body = await request.json();
  const rows = body.rows; // pre-parsed on frontend
  const headers = body.headers;
  const fileName = body.file_name || 'guesty_import.csv';
  if (!rows || !headers || rows.length === 0) return json({ error: 'No data to import' }, 400);

  // Map columns by fuzzy header matching
  const colMap = {};
  const mappings = {
    confirmation_code: ['confirmationcode', 'confirmation', 'reservationid', 'code'],
    listing_name: ['listing', 'listingtitle', 'listingname', 'property', 'propertyname'],
    listing_address: ['listingsaddress', 'listingaddress', 'address', 'propertyaddress'],
    listing_id: ['listingid', 'listingsid'],
    listing_nickname: ['listingsnickname', 'nickname'],
    check_in: ['checkindate', 'checkindatelocalized', 'arrivaldate', 'localcheckin'],
    check_out: ['checkoutdate', 'checkoutdatelocalized', 'departuredate', 'localcheckout'],
    check_in_full: ['checkin'],
    check_out_full: ['checkout'],
    nights_count: ['numberofnights', 'nights', 'nightscount', 'totalnight'],
    guest_count: ['numberofguests', 'guests', 'guestscount', 'guestcount'],
    guest_name: ['guest', 'guestname', 'guestsname', 'guestfullname', 'fullname'],
    channel: ['platform', 'bookingchannel'],
    status: ['status', 'reservationstatus', 'bookingstatus'],
    accommodation_fare: ['accommodationfare', 'netaccommodationfare', 'roomrevenue'],
    cleaning_fee: ['cleaningfare', 'cleaningfee'],
    total_fees: ['totalfees'],
    total_taxes: ['totaltaxes'],
    host_payout: ['totalpayout', 'hostpayout'],
    guest_total: ['totalguestpayout', 'guesttotal', 'totalamount'],
    platform_fee: ['channelcommission', 'channelcommissionincltax'],
    subtotal: ['subtotalprice'],
    currency: ['currency'],
    total_paid: ['totalpaid'],
    pets: ['pets', 'numberofpets', 'petcount', 'haspets', 'petsallowed', 'ofpets', 'numpets', 'petsnumber', 'numberofpets', 'noofpets', 'totalpets'],
    csv_pet_fee: ['petfee', 'petfees', 'petcharge', 'animalfee'],
    pet_type: ['pettype', 'petdetails', 'petname', 'petinfo', 'petbreed', 'animaldescription'],
    notes: ['notes', 'guestnotes', 'specialrequests', 'internalnotes', 'hostnotes', 'guestnote', 'reservationnotes'],
    total_refunded: ['totalrefunded', 'refunded', 'refundamount', 'totalrefund'],
    cancellation_fee: ['cancellationfee', 'cancelfee', 'cancelationfee'],
    canceled_accommodation: ['canceledaccommodationfare', 'cancelledaccommodationfare', 'canceledaccommodation', 'cancelledaccommodation'],
    canceled_cleaning: ['canceledcleaningfare', 'cancelledcleaningfare', 'canceledcleaning', 'cancelledcleaning'],
    canceled_payout: ['canceledtotalpayout', 'cancelledtotalpayout', 'canceledpayout', 'cancelledpayout'],
  };

  // First pass: exact match mapping
  for (let i = 0; i < headers.length; i++) {
    const hn = headers[i].toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const field in mappings) {
      for (const t of mappings[field]) {
        const tn = t.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (hn === tn) {
          if (colMap[field] === undefined) {
            colMap[field] = i;
          } else {
            // Multiple exact matches — check which has data in first 5 rows
            var existingHasData = false, newHasData = false;
            for (var ri = 0; ri < Math.min(5, rows.length); ri++) {
              var ev = (rows[ri][colMap[field]] || '').trim();
              var nv = (rows[ri][i] || '').trim();
              if (ev && ev !== '0' && ev !== '$0') existingHasData = true;
              if (nv && nv !== '0' && nv !== '$0') newHasData = true;
            }
            // Prefer the column with actual data
            if (newHasData && !existingHasData) colMap[field] = i;
          }
          break;
        }
      }
    }
  }

  if (colMap.confirmation_code === undefined && colMap.check_in === undefined) {
    return json({ error: 'Could not detect required columns. Need at least Confirmation Code or Check-in date.', detected: colMap, headers }, 400);
  }

  const get = (row, field) => {
    const idx = colMap[field];
    if (idx === undefined || idx >= row.length) return null;
    const v = (row[idx] || '').trim();
    return v === '' ? null : v;
  };
  const getNum = (row, field) => {
    const v = get(row, field);
    if (!v) return null;
    const n = parseFloat(v.replace(/[$,]/g, ''));
    return isNaN(n) ? null : n;
  };

  let imported = 0, skipped = 0, errors = 0;
  const listingNames = new Set();
  const listingAddresses = {};
  const listingIds = {};

  // Clean up old bad data: records with date-like status values (from previous bad column mapping)
  try {
    await env.DB.prepare(`DELETE FROM guesty_reservations WHERE status LIKE '20%-%' OR status LIKE '%AM' OR status LIKE '%PM'`).run();
    // Also clean up generated confirmation codes from previous imports of inquiries
    await env.DB.prepare(`DELETE FROM guesty_reservations WHERE confirmation_code LIKE 'GEN-%'`).run();
  } catch (e) { syslog(env, 'error', 'importGuestyCsv', 'L8098', e.message); }

  for (const row of rows) {
    try {
      const rawCode = get(row, 'confirmation_code');
      const code = rawCode || ('GEN-' + ((get(row, 'guest_name') || '') + (get(row, 'check_in') || get(row, 'check_in_full') || '') + (get(row, 'listing_name') || '')).replace(/[^a-zA-Z0-9]/g, '').substring(0, 40));
      const listingName = get(row, 'listing_name');
      const listingAddr = get(row, 'listing_address');
      const listingId = get(row, 'listing_id');
      // Prefer CHECK-IN DATE over CHECK-IN (which has time)
      let checkIn = get(row, 'check_in') || get(row, 'check_in_full');
      let checkOut = get(row, 'check_out') || get(row, 'check_out_full');
      // Normalize dates — strip time portion if present
      if (checkIn && checkIn.length > 10) checkIn = checkIn.substring(0, 10);
      if (checkOut && checkOut.length > 10) checkOut = checkOut.substring(0, 10);
      const status = get(row, 'status') || 'confirmed';

      // Import all statuses — we filter at processing time, not import time
      // This preserves cancellations and inquiries for intelligence
      if (!checkIn && !checkOut) { skipped++; continue; }
      if (!checkIn) { skipped++; continue; }

      let nights = getNum(row, 'nights_count');
      if (!nights && checkIn && checkOut) {
        const d1 = new Date(checkIn), d2 = new Date(checkOut);
        if (!isNaN(d1) && !isNaN(d2)) nights = Math.round((d2 - d1) / 86400000);
      }

      if (listingName) listingNames.add(listingName);
      if (listingName && listingAddr) listingAddresses[listingName] = listingAddr;
      if (listingName && listingId) listingIds[listingName] = listingId;

      // Detect pets from CSV columns, guest name, or notes
      var csvPets = get(row, 'pets') || '';
      var csvPetType = get(row, 'pet_type') || '';
      var guestName = get(row, 'guest_name') || '';
      var csvNotes = get(row, 'notes') || '';
      var petPattern = /\b(pet|pets|dog|dogs|cat|cats|puppy|kitten|animal|k9|canine|pup)\b/i;
      // Check if pets column has a number > 0
      var petNum = parseInt(csvPets);
      var hasPetFlag = 0;
      if (!isNaN(petNum) && petNum > 0) {
        hasPetFlag = 1;
        if (!csvPetType) csvPetType = petNum + (petNum === 1 ? ' pet' : ' pets');
      } else if (csvPets && csvPets !== '0' && csvPets.toLowerCase() !== 'no' && csvPets.toLowerCase() !== 'false' && csvPets.toLowerCase() !== 'n/a') {
        hasPetFlag = 1;
      }
      if (!hasPetFlag && (petPattern.test(guestName) || petPattern.test(csvPetType) || petPattern.test(csvNotes))) hasPetFlag = 1;
      // Also detect pets if PET FEE column has a value > 0
      var csvPetFeeVal = getNum(row, 'csv_pet_fee');
      if (!hasPetFlag && csvPetFeeVal && csvPetFeeVal > 0) { hasPetFlag = 1; if (!csvPetType) csvPetType = 'pet fee $' + csvPetFeeVal; }

      await env.DB.prepare(`INSERT INTO guesty_reservations (confirmation_code, listing_name, check_in, check_out, nights_count, guest_count, guest_name, channel, status, accommodation_fare, cleaning_fee, total_fees, total_taxes, host_payout, guest_total, platform_fee, currency, source_file, has_pets, pet_type, pet_fee, notes, total_refunded, cancellation_fee, canceled_accommodation, canceled_cleaning, canceled_payout) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(confirmation_code) DO UPDATE SET listing_name=COALESCE(excluded.listing_name, guesty_reservations.listing_name), check_in=COALESCE(excluded.check_in, guesty_reservations.check_in), check_out=COALESCE(excluded.check_out, guesty_reservations.check_out), nights_count=COALESCE(excluded.nights_count, guesty_reservations.nights_count), guest_count=COALESCE(excluded.guest_count, guesty_reservations.guest_count), guest_name=COALESCE(excluded.guest_name, guesty_reservations.guest_name), channel=COALESCE(excluded.channel, guesty_reservations.channel), status=COALESCE(excluded.status, guesty_reservations.status), accommodation_fare=COALESCE(excluded.accommodation_fare, guesty_reservations.accommodation_fare), cleaning_fee=COALESCE(excluded.cleaning_fee, guesty_reservations.cleaning_fee), total_fees=COALESCE(excluded.total_fees, guesty_reservations.total_fees), total_taxes=COALESCE(excluded.total_taxes, guesty_reservations.total_taxes), host_payout=COALESCE(excluded.host_payout, guesty_reservations.host_payout), guest_total=COALESCE(excluded.guest_total, guesty_reservations.guest_total), platform_fee=COALESCE(excluded.platform_fee, guesty_reservations.platform_fee), has_pets=CASE WHEN excluded.has_pets > 0 THEN excluded.has_pets WHEN guesty_reservations.has_pets > 0 THEN guesty_reservations.has_pets ELSE excluded.has_pets END, pet_type=COALESCE(excluded.pet_type, guesty_reservations.pet_type), pet_fee=CASE WHEN excluded.pet_fee > 0 THEN excluded.pet_fee WHEN guesty_reservations.pet_fee > 0 THEN guesty_reservations.pet_fee ELSE excluded.pet_fee END, notes=COALESCE(excluded.notes, guesty_reservations.notes), total_refunded=COALESCE(excluded.total_refunded, guesty_reservations.total_refunded), cancellation_fee=COALESCE(excluded.cancellation_fee, guesty_reservations.cancellation_fee), canceled_accommodation=COALESCE(excluded.canceled_accommodation, guesty_reservations.canceled_accommodation), canceled_cleaning=COALESCE(excluded.canceled_cleaning, guesty_reservations.canceled_cleaning), canceled_payout=COALESCE(excluded.canceled_payout, guesty_reservations.canceled_payout)`)
        .bind(code, listingName, checkIn, checkOut, nights, getNum(row, 'guest_count'), guestName, get(row, 'channel'), status, getNum(row, 'accommodation_fare'), getNum(row, 'cleaning_fee'), getNum(row, 'total_fees'), getNum(row, 'total_taxes'), getNum(row, 'host_payout'), getNum(row, 'guest_total'), getNum(row, 'platform_fee'), get(row, 'currency') || 'USD', fileName, hasPetFlag, csvPetType || null, csvPetFeeVal || 0, csvNotes || null, getNum(row, 'total_refunded') || 0, getNum(row, 'cancellation_fee') || 0, getNum(row, 'canceled_accommodation') || 0, getNum(row, 'canceled_cleaning') || 0, getNum(row, 'canceled_payout') || 0).run();
      imported++;
    } catch (e) { errors++; }
  }

  // Register discovered listings for matching (deduplicate by listing name)
  for (const name of listingNames) {
    try {
      const gId = listingIds[name] || 'csv_' + normalizeAddress(name).replace(/\s/g, '_').substring(0, 50);
      const addr = listingAddresses[name] || '';
      // Check if a listing with this name already exists under a different ID
      const existing = await env.DB.prepare(`SELECT id, guesty_listing_id, property_id FROM guesty_listings WHERE listing_name = ?`).bind(name).first();
      if (existing && existing.guesty_listing_id !== gId) {
        // Update existing record with better data, don't create duplicate
        await env.DB.prepare(`UPDATE guesty_listings SET listing_address = COALESCE(NULLIF(?, ''), listing_address), guesty_listing_id = ? WHERE id = ?`)
          .bind(addr, gId, existing.id).run();
      } else {
        await env.DB.prepare(`INSERT INTO guesty_listings (guesty_listing_id, listing_name, listing_address) VALUES (?, ?, ?) ON CONFLICT(guesty_listing_id) DO UPDATE SET listing_name=excluded.listing_name, listing_address=COALESCE(NULLIF(excluded.listing_address, ''), listing_address)`)
          .bind(gId, name, addr).run();
      }
    } catch (e) { syslog(env, 'error', 'importGuestyCsv', 'L8171', e.message); }
  }

  // Clean up duplicate listings (same name, keep the one with property_id or address)
  try {
    const { results: allListings } = await env.DB.prepare(`SELECT id, listing_name, property_id, listing_address FROM guesty_listings ORDER BY listing_name, property_id DESC`).all();
    const seen = {};
    for (const l of (allListings || [])) {
      if (seen[l.listing_name]) {
        // Duplicate — keep the better one (has property_id or address), delete this one
        const keep = seen[l.listing_name];
        const deleteId = (!l.property_id && keep.property_id) ? l.id : (!keep.property_id && l.property_id) ? keep.id : l.id;
        const keepId = deleteId === l.id ? keep.id : l.id;
        // Transfer property_id if the one being deleted has it
        if (deleteId === keep.id && keep.property_id) {
          await env.DB.prepare(`UPDATE guesty_listings SET property_id = ?, listing_address = COALESCE(NULLIF(listing_address, ''), ?) WHERE id = ?`).bind(keep.property_id, keep.listing_address || '', keepId).run();
        }
        await env.DB.prepare(`DELETE FROM guesty_listings WHERE id = ?`).bind(deleteId).run();
        seen[l.listing_name] = deleteId === l.id ? keep : l;
      } else {
        seen[l.listing_name] = l;
      }
    }
  } catch (e) { syslog(env, 'error', 'importGuestyCsv', 'L8194', e.message); }

  // Auto-match listings to properties
  const matchResults = await autoMatchGuestyListings(env);

  // Auto-rebuild monthly actuals + guest intelligence so data is immediately accurate
  let processOk = false, rebuildOk = false;
  try { await processGuestyData(env); processOk = true; } catch (e) { syslog(env, 'error', 'importGuestyCsv', 'processGuestyData post-import failed', e.message); }
  try { await rebuildIntelligence(new Request('http://x', { method: 'POST', body: JSON.stringify({ sections: ['guests'] }) }), env); rebuildOk = true; } catch (e) { syslog(env, 'error', 'importGuestyCsv', 'rebuildIntelligence post-import failed', e.message); }

  return json({
    imported, skipped, errors, total: rows.length,
    columns_detected: Object.keys(colMap).length,
    column_mapping: Object.fromEntries(Object.entries(colMap).map(([k, v]) => [k, headers[v]])),
    listings_found: listingNames.size,
    auto_matched: matchResults.matched,
    auto_processed: processOk,
    auto_rebuilt: rebuildOk,
    message: `Imported ${imported} reservations, skipped ${skipped}, ${errors} errors. Found ${listingNames.size} listings, auto-matched ${matchResults.matched}.${processOk ? ' Monthly actuals updated.' : ''}${rebuildOk ? ' Guest intelligence rebuilt.' : ''}`
  });
}

async function autoMatchGuestyListings(env) {
  // Backfill listing addresses from reservation data if missing
  try {
    const { results: noAddr } = await env.DB.prepare(`SELECT gl.id, gl.listing_name FROM guesty_listings gl WHERE gl.listing_address IS NULL OR gl.listing_address = ''`).all();
    for (const gl of (noAddr || [])) {
      // Find address from a reservation with this listing that has listing_address populated
      // We stored listing_address in the column mapping, but it might not be in guesty_reservations
      // Instead re-scan: look for a guesty reservation with this listing name and check the import
      // For now, try to extract from listing name patterns
    }
  } catch {}

  const { results: unmatched } = await env.DB.prepare(`SELECT * FROM guesty_listings WHERE property_id IS NULL`).all();
  const { results: props } = await env.DB.prepare(`SELECT id, name, address, city, state, unit_number, parent_id, (SELECT COUNT(*) FROM properties c WHERE c.parent_id = properties.id) as child_count FROM properties WHERE (is_research != 1 OR is_research IS NULL)`).all();
  let matched = 0;

  for (const gl of (unmatched || [])) {
    let bestMatch = null, bestScore = 0;

    // Extract unit number from Guesty listing name or nickname
    // Patterns: "Middletown 101 / ...", "101 — 49 Park", "#2", "#101"
    const gName = gl.listing_name || '';
    const gAddr = gl.listing_address || '';
    let gUnit = null;
    // Try extracting from name: "Middletown 101" → "101", "Near Wesleyan 201" → "201"
    const unitFromName = gName.match(/\b(\d{2,4})\b\s*[\/\-]/) || gName.match(/\b(\d{3})\s*$/);
    if (unitFromName) gUnit = unitFromName[1];
    // Try from address: "49 Park Pl #2" → "2", "1455 Southford Rd #3" → "3"
    const unitFromAddr = gAddr.match(/#(\d+)/);
    if (unitFromAddr && !gUnit) gUnit = unitFromAddr[1];

    // Normalize the base address (strip unit number from Guesty address)
    const gBaseAddr = normalizeAddress(gAddr.replace(/#\d+/, '').replace(/,.*$/, ''));

    for (const p of (props || [])) {
      // NEVER match to a parent building that has child units — those are containers, not rentable
      if (p.child_count > 0) continue;

      let score = 0;
      const pBaseAddr = normalizeAddress((p.address || '').replace(/#\d+/, ''));
      const pCity = (p.city || '').toLowerCase();

      // 1. Address similarity (base address without unit)
      const addrScore = addressSimilarity(gBaseAddr, pBaseAddr);

      // 2. City match
      const gCity = (gAddr.match(/,\s*([^,]+),\s*[A-Z]{2}/) || [])[1] || '';
      const cityMatch = pCity && gCity && pCity === gCity.toLowerCase().trim() ? 1 : 0;

      // 3. Unit number match
      let unitMatch = 0;
      if (gUnit && p.unit_number) {
        // Exact match: "201" === "201"
        if (gUnit === p.unit_number) unitMatch = 1;
        // Partial: Guesty "201" matches property "201" or "#201"
        else if (p.unit_number.replace('#','') === gUnit) unitMatch = 1;
        // Guesty uses apartment # not unit: "#2" matches "102"
        else if (unitFromAddr && p.unit_number.endsWith(unitFromAddr[1])) unitMatch = 0.7;
        else unitMatch = 0; // Different unit numbers — do NOT match
      } else if (gUnit && !p.unit_number) {
        // Guesty has a unit indicator but property doesn't — likely wrong property (building parent)
        unitMatch = -1; // Penalty — prevent matching a unit listing to a non-unit property
      } else if (!gUnit && !p.unit_number) {
        // Both have no unit — standalone property match is fine
        unitMatch = 0.5;
      }

      // Skip if unit mismatch penalty
      if (unitMatch < 0) continue;

      // Combined score: address is base, unit is critical differentiator
      if (addrScore >= 0.5 && (cityMatch > 0 || addrScore >= 0.7)) {
        if (gUnit && p.unit_number) {
          // Multi-unit: unit match is essential — without it, skip
          if (unitMatch < 0.5) continue;
          score = addrScore * 0.4 + unitMatch * 0.5 + cityMatch * 0.1;
        } else {
          // Standalone: just address + city
          score = addrScore * 0.7 + cityMatch * 0.2 + unitMatch * 0.1;
        }
      }

      // Also try matching listing name against property name directly
      // But only if this isn't a unit-vs-building mismatch
      if (p.name && !(gUnit && !p.unit_number)) {
        const nameScore = addressSimilarity(gName, p.name);
        if (nameScore > score) score = nameScore;
      }

      if (score > bestScore) { bestScore = score; bestMatch = p; }
    }

    if (bestMatch && bestScore >= 0.45) {
      await env.DB.prepare(`UPDATE guesty_listings SET property_id = ?, auto_matched = 1, match_score = ? WHERE id = ?`)
        .bind(bestMatch.id, Math.round(bestScore * 100) / 100, gl.id).run();
      await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE listing_name = ? AND property_id IS NULL`)
        .bind(bestMatch.id, gl.listing_name).run();
      matched++;
    }
  }
  return { matched, total: (unmatched || []).length };
}

async function getGuestyListings(env) {
  const { results: listings } = await env.DB.prepare(`SELECT gl.*, p.name as prop_name, p.address as prop_address, p.unit_number as prop_unit, (SELECT COUNT(*) FROM guesty_reservations WHERE listing_name = gl.listing_name) as reservation_count FROM guesty_listings gl LEFT JOIN properties p ON gl.property_id = p.id ORDER BY gl.property_id DESC, gl.listing_name`).all();
  return json({ listings });
}

async function linkGuestyListing(request, env) {
  const { guesty_listing_id, property_id } = await request.json();
  if (!guesty_listing_id || !property_id) return json({ error: 'guesty_listing_id and property_id required' }, 400);
  await env.DB.prepare(`UPDATE guesty_listings SET property_id = ?, auto_matched = 0 WHERE guesty_listing_id = ?`).bind(property_id, guesty_listing_id).run();

  // Get all identifiers for this listing
  const gl = await env.DB.prepare(`SELECT listing_name, listing_address, guesty_listing_id FROM guesty_listings WHERE guesty_listing_id = ?`).bind(guesty_listing_id).first();
  let linked = 0;

  if (gl) {
    // Match by listing_name (primary — covers both CSV and API imports)
    if (gl.listing_name) {
      const r = await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE listing_name = ? AND (property_id IS NULL OR property_id = ?)`).bind(property_id, gl.listing_name, property_id).run();
      linked += r.meta?.changes || 0;
    }
    // Match by guesty_listing_id (API-sourced reservations have this)
    if (gl.guesty_listing_id) {
      const r2 = await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE guesty_listing_id = ? AND property_id IS NULL`).bind(property_id, gl.guesty_listing_id).run();
      linked += r2.meta?.changes || 0;
    }
    // Match by listing address (CSV sometimes stores address in listing_name column)
    if (gl.listing_address) {
      const r3 = await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE listing_name = ? AND property_id IS NULL`).bind(property_id, gl.listing_address).run();
      linked += r3.meta?.changes || 0;
    }
    // Also check: property may have a platform_listing_name set — try matching that too
    const prop = await env.DB.prepare(`SELECT platform_listing_name, address FROM properties WHERE id = ?`).bind(property_id).first();
    if (prop) {
      if (prop.platform_listing_name) {
        const r4 = await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE listing_name = ? AND property_id IS NULL`).bind(property_id, prop.platform_listing_name).run();
        linked += r4.meta?.changes || 0;
      }
      // Last resort: match by property address against listing_name (fuzzy — CSV might have address as listing name)
      if (prop.address && linked === 0) {
        const r5 = await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE listing_name LIKE ? AND property_id IS NULL`).bind(property_id, '%' + prop.address.substring(0, 20) + '%').run();
        linked += r5.meta?.changes || 0;
      }
    }
  }

  // Auto-rebuild monthly_actuals and intelligence so finance + segments appear immediately
  try { await processGuestyData(env); } catch {}
  try { await rebuildIntelligence(new Request('http://x', { method: 'POST', body: JSON.stringify({ sections: ['guests'] }) }), env); } catch {}
  return json({ ok: true, linked_reservations: linked });
}

async function unlinkGuestyListing(request, env) {
  const { guesty_listing_id } = await request.json();
  await env.DB.prepare(`UPDATE guesty_listings SET property_id = NULL, auto_matched = 0 WHERE guesty_listing_id = ?`).bind(guesty_listing_id).run();
  const gl = await env.DB.prepare(`SELECT listing_name FROM guesty_listings WHERE guesty_listing_id = ?`).bind(guesty_listing_id).first();
  if (gl) await env.DB.prepare(`UPDATE guesty_reservations SET property_id = NULL WHERE listing_name = ?`).bind(gl.listing_name).run();
  return json({ ok: true });
}

async function getGuestyStats(env) {
  const total = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations`).first();
  const LIVE = `${LIVE_STATUS_SQL}`;
  const confirmed = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE ${LIVE}`).first();
  const linked = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE property_id IS NOT NULL AND ${LIVE}`).first();
  const canceled = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE LOWER(COALESCE(status,'')) IN ('canceled','cancelled')`).first();
  const inquiries = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE LOWER(COALESCE(status,'')) IN ('inquiry','expired','awaiting_payment','pending','quote')`).first();
  const listings = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_listings`).first();
  const matched = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_listings WHERE property_id IS NOT NULL`).first();
  const dateRange = await env.DB.prepare(`SELECT MIN(check_in) as earliest, MAX(check_out) as latest FROM guesty_reservations`).first();
  const byChannel = await env.DB.prepare(`SELECT channel, COUNT(*) as c, SUM(host_payout) as payout FROM guesty_reservations WHERE ${LIVE_STATUS_SQL} GROUP BY channel ORDER BY c DESC`).all();
  // Refund tracking summary
  const refundStats = await env.DB.prepare(`SELECT COUNT(*) as refund_count, SUM(total_refunded) as total_refunded, SUM(cancellation_fee) as total_cancel_fees, SUM(canceled_accommodation) as total_canceled_accommodation, SUM(canceled_cleaning) as total_canceled_cleaning, SUM(canceled_payout) as total_canceled_payout FROM guesty_reservations WHERE total_refunded > 0 OR cancellation_fee > 0 OR canceled_payout > 0`).first();
  return json({
    total_reservations: total?.c || 0,
    confirmed_reservations: confirmed?.c || 0,
    linked_reservations: linked?.c || 0,
    canceled_count: canceled?.c || 0,
    inquiry_count: inquiries?.c || 0,
    cancellation_rate: (confirmed?.c || 0) > 0 ? Math.round((canceled?.c || 0) / ((confirmed?.c || 0) + (canceled?.c || 0)) * 100) : 0,
    conversion_rate: (inquiries?.c || 0) > 0 ? Math.round((confirmed?.c || 0) / ((confirmed?.c || 0) + (inquiries?.c || 0)) * 100) : 0,
    total_listings: listings?.c || 0,
    matched_listings: matched?.c || 0,
    date_range: { earliest: dateRange?.earliest, latest: dateRange?.latest },
    by_channel: byChannel?.results || [],
    refund_summary: {
      refund_count: refundStats?.refund_count || 0,
      total_refunded: Math.round((refundStats?.total_refunded || 0) * 100) / 100,
      total_cancel_fees: Math.round((refundStats?.total_cancel_fees || 0) * 100) / 100,
      total_canceled_accommodation: Math.round((refundStats?.total_canceled_accommodation || 0) * 100) / 100,
      total_canceled_cleaning: Math.round((refundStats?.total_canceled_cleaning || 0) * 100) / 100,
      total_canceled_payout: Math.round((refundStats?.total_canceled_payout || 0) * 100) / 100,
    },
  });
}

async function processGuestyData(env) {
  // Phase 1: Aggregate reservations into monthly_actuals per property
  // Only delete actuals for properties that have Guesty reservations linked —
  // this ensures date changes and cancellations are reflected cleanly
  // while leaving non-Guesty properties completely untouched
  const { results: linked } = await env.DB.prepare(`SELECT DISTINCT property_id FROM guesty_reservations WHERE property_id IS NOT NULL`).all();
  let processed = 0;

  for (const { property_id } of (linked || [])) {
    // Clear this property's actuals before rebuilding — handles cancellations and date changes
    await env.DB.prepare(`DELETE FROM monthly_actuals WHERE property_id = ?`).bind(property_id).run();

    const { results: reservations } = await env.DB.prepare(`SELECT * FROM guesty_reservations WHERE property_id = ? AND ${LIVE_STATUS_SQL} ORDER BY check_in`).bind(property_id).all();
    // Also get canceled reservations that have refund data
    const { results: canceledRes } = await env.DB.prepare(`SELECT * FROM guesty_reservations WHERE property_id = ? AND status = 'canceled' AND (total_refunded > 0 OR cancellation_fee > 0 OR canceled_payout > 0) ORDER BY check_in`).bind(property_id).all();
    if ((!reservations || reservations.length === 0) && (!canceledRes || canceledRes.length === 0)) { processed++; continue; }

    // Group by month — use date-only parsing to avoid timezone/time issues
    const byMonth = {};
    const bookedDays = {}; // track unique days to prevent double-counting
    for (const r of reservations) {
      if (!r.check_in) continue;
      // Parse dates as date-only — use Date.UTC to guarantee no timezone shifts
      const ciStr = (r.check_in || '').substring(0, 10);
      const coStr = (r.check_out || '').substring(0, 10);
      if (!ciStr.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
      const [ciY, ciM, ciD] = ciStr.split('-').map(Number);
      const ci = new Date(Date.UTC(ciY, ciM - 1, ciD, 12));
      let co;
      if (coStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const [coY, coM, coD] = coStr.split('-').map(Number);
        co = new Date(Date.UTC(coY, coM - 1, coD, 12));
      } else {
        co = new Date(ci.getTime() + (r.nights_count || 1) * 86400000);
      }
      const nights = r.nights_count || Math.round((co - ci) / 86400000);
      const nightlyRate = nights > 0 && r.accommodation_fare > 0 ? r.accommodation_fare / nights : 0;

      // Count nights per month this reservation actually touches
      const monthsThisRes = {};
      let d = new Date(ci);
      while (d < co) {
        const monthKey = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
        const dayKey = property_id + '_' + d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
        if (!byMonth[monthKey]) byMonth[monthKey] = { nights: 0, revenue: 0, cleaning: 0, payout: 0, taxes: 0, commission: 0, taxes_you_owe: 0, total_refunded: 0, cancellation_fees: 0, reservations: new Set(), stayLengths: [] };
        // Only count each day once per property (prevent overlapping reservation double-count)
        if (!bookedDays[dayKey]) {
          bookedDays[dayKey] = true;
          byMonth[monthKey].nights++;
          byMonth[monthKey].revenue += nightlyRate;
        }
        if (!monthsThisRes[monthKey]) monthsThisRes[monthKey] = 0;
        monthsThisRes[monthKey]++;
        d = new Date(d.getTime() + 86400000);
      }

      // Count this reservation in each month it has nights, with actual nights in that month
      for (const mk in monthsThisRes) {
        byMonth[mk].reservations.add(r.confirmation_code);
        byMonth[mk].stayLengths.push(monthsThisRes[mk]); // nights THIS reservation had in THIS month
      }

      // Cash basis: attribute payout, cleaning, taxes, commission to check-in month
      // This matches when Airbnb actually pays you (~24hrs after check-in)
      const ciMonth = ci.getUTCFullYear() + '-' + String(ci.getUTCMonth() + 1).padStart(2, '0');
      if (byMonth[ciMonth]) {
        byMonth[ciMonth].cleaning += r.cleaning_fee || 0;
        byMonth[ciMonth].payout += r.host_payout || 0;
        byMonth[ciMonth].taxes += r.total_taxes || 0;
        byMonth[ciMonth].commission += r.platform_fee || 0;
        const ch = (r.channel || '').toLowerCase();
        if (ch !== 'airbnb') byMonth[ciMonth].taxes_you_owe += r.total_taxes || 0;
        // Track refunds on confirmed/closed reservations that also have refund data
        byMonth[ciMonth].total_refunded += r.total_refunded || 0;
        byMonth[ciMonth].cancellation_fees += r.cancellation_fee || 0;
      }
    }

    // Process canceled reservations for refund tracking (attributed to check-in month)
    for (const r of (canceledRes || [])) {
      if (!r.check_in) continue;
      const ciStr = (r.check_in || '').substring(0, 10);
      if (!ciStr.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
      const [ciY, ciM] = ciStr.split('-').map(Number);
      const ciMonth = ciY + '-' + String(ciM).padStart(2, '0');
      if (!byMonth[ciMonth]) byMonth[ciMonth] = { nights: 0, revenue: 0, cleaning: 0, payout: 0, taxes: 0, commission: 0, taxes_you_owe: 0, total_refunded: 0, cancellation_fees: 0, reservations: new Set(), stayLengths: [] };
      byMonth[ciMonth].total_refunded += r.total_refunded || 0;
      byMonth[ciMonth].cancellation_fees += r.cancellation_fee || 0;
    }

    // Write to monthly_actuals
    for (const month in byMonth) {
      const m = byMonth[month];
      const daysInMonth = new Date(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]), 0).getDate();
      const now = new Date();
      const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const isCurrentMonth = month === currentMonth;
      const elapsedDays = isCurrentMonth ? Math.min(now.getUTCDate(), daysInMonth) : null;

      // Total booked nights (all confirmed, including future) — for revenue and goal tracking
      const totalBookedNights = Math.min(m.nights, daysInMonth);

      // Elapsed booked nights (only nights <= today) — for "actual so far" occupancy
      let elapsedBookedNights = totalBookedNights; // past months: same as total
      if (isCurrentMonth) {
        const todayStr = now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0') + '-' + String(now.getUTCDate()).padStart(2, '0');
        elapsedBookedNights = 0;
        for (const dk in bookedDays) {
          if (!dk.startsWith(property_id + '_' + month)) continue;
          const dayDate = dk.substring(dk.indexOf('_') + 1);
          if (dayDate <= todayStr) elapsedBookedNights++;
        }
      }

      // Occupancy: for current month = elapsed_booked / elapsed_days (what actually happened)
      // For past months = total_booked / days_in_month (final number)
      const occDenom = isCurrentMonth ? (elapsedDays || 1) : daysInMonth;
      const occNum = isCurrentMonth ? elapsedBookedNights : totalBookedNights;
      const occ = occDenom > 0 ? Math.round(occNum / occDenom * 100) / 100 : 0;
      const adr = totalBookedNights > 0 ? Math.round(m.revenue / totalBookedNights * 100) / 100 : 0;
      const avgStay = m.stayLengths.length > 0 ? Math.round(m.stayLengths.reduce((a, b) => a + b, 0) / m.stayLengths.length * 10) / 10 : 0;

      // booked_nights = ALL confirmed (for revenue/goals), available_nights = full month always
      // elapsed_booked_nights + elapsed_days = partial month context (NULL for past months)
      try {
        await env.DB.prepare(`INSERT INTO monthly_actuals (property_id, month, booked_nights, available_nights, occupancy_pct, total_revenue, avg_nightly_rate, num_reservations, avg_stay_length, cleaning_revenue, host_payout, total_taxes, platform_commission, taxes_you_owe, total_refunded, cancellation_fees, elapsed_booked_nights, elapsed_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(property_id, month) DO UPDATE SET booked_nights=excluded.booked_nights, available_nights=excluded.available_nights, occupancy_pct=excluded.occupancy_pct, total_revenue=excluded.total_revenue, avg_nightly_rate=excluded.avg_nightly_rate, num_reservations=excluded.num_reservations, avg_stay_length=excluded.avg_stay_length, cleaning_revenue=excluded.cleaning_revenue, host_payout=excluded.host_payout, total_taxes=excluded.total_taxes, platform_commission=excluded.platform_commission, taxes_you_owe=excluded.taxes_you_owe, total_refunded=excluded.total_refunded, cancellation_fees=excluded.cancellation_fees, elapsed_booked_nights=excluded.elapsed_booked_nights, elapsed_days=excluded.elapsed_days, updated_at=datetime('now')`)
          .bind(property_id, month, totalBookedNights, daysInMonth, occ, Math.round(m.revenue), adr, m.reservations.size, avgStay, Math.round(m.cleaning), Math.round(m.payout), Math.round(m.taxes), Math.round(m.commission), Math.round(m.taxes_you_owe), Math.round(m.total_refunded), Math.round(m.cancellation_fees), isCurrentMonth ? elapsedBookedNights : null, elapsedDays).run();
      } catch {
        // Fallback: elapsed columns may not exist yet
        await env.DB.prepare(`INSERT INTO monthly_actuals (property_id, month, booked_nights, available_nights, occupancy_pct, total_revenue, avg_nightly_rate, num_reservations, avg_stay_length, cleaning_revenue, host_payout, total_taxes, platform_commission, taxes_you_owe, total_refunded, cancellation_fees) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(property_id, month) DO UPDATE SET booked_nights=excluded.booked_nights, available_nights=excluded.available_nights, occupancy_pct=excluded.occupancy_pct, total_revenue=excluded.total_revenue, avg_nightly_rate=excluded.avg_nightly_rate, num_reservations=excluded.num_reservations, avg_stay_length=excluded.avg_stay_length, cleaning_revenue=excluded.cleaning_revenue, host_payout=excluded.host_payout, total_taxes=excluded.total_taxes, platform_commission=excluded.platform_commission, taxes_you_owe=excluded.taxes_you_owe, total_refunded=excluded.total_refunded, cancellation_fees=excluded.cancellation_fees, updated_at=datetime('now')`)
          .bind(property_id, month, totalBookedNights, daysInMonth, occ, Math.round(m.revenue), adr, m.reservations.size, avgStay, Math.round(m.cleaning), Math.round(m.payout), Math.round(m.taxes), Math.round(m.commission), Math.round(m.taxes_you_owe), Math.round(m.total_refunded), Math.round(m.cancellation_fees)).run();
      }
    }
    processed++;
  }

  // Phase 2: Build market_seasonality from monthly_actuals
  const { results: actuals } = await env.DB.prepare(`SELECT ma.month, ma.occupancy_pct, ma.avg_nightly_rate, p.city, p.state FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE p.city IS NOT NULL`).all();

  const seasonData = {};
  for (const a of (actuals || [])) {
    const monthNum = parseInt(a.month.split('-')[1]);
    const key = a.city + '|' + a.state + '|' + monthNum;
    if (!seasonData[key]) seasonData[key] = { city: a.city, state: a.state, month: monthNum, occs: [], adrs: [] };
    if (a.occupancy_pct > 0) seasonData[key].occs.push(a.occupancy_pct);
    if (a.avg_nightly_rate > 0) seasonData[key].adrs.push(a.avg_nightly_rate);
  }

  // Calculate annual averages per market for multipliers
  const annualAvg = {};
  for (const k in seasonData) {
    const sd = seasonData[k];
    const mKey = sd.city + '|' + sd.state;
    if (!annualAvg[mKey]) annualAvg[mKey] = { adrs: [], occs: [] };
    annualAvg[mKey].adrs.push(...sd.adrs);
    annualAvg[mKey].occs.push(...sd.occs);
  }

  for (const k in seasonData) {
    const sd = seasonData[k];
    const avgOcc = sd.occs.length > 0 ? sd.occs.reduce((a, b) => a + b, 0) / sd.occs.length : 0;
    const avgAdr = sd.adrs.length > 0 ? sd.adrs.reduce((a, b) => a + b, 0) / sd.adrs.length : 0;
    const mKey = sd.city + '|' + sd.state;
    const annAvgAdr = annualAvg[mKey].adrs.length > 0 ? annualAvg[mKey].adrs.reduce((a, b) => a + b, 0) / annualAvg[mKey].adrs.length : 1;
    const multiplier = annAvgAdr > 0 ? Math.round(avgAdr / annAvgAdr * 100) / 100 : 1;

    await env.DB.prepare(`INSERT INTO market_seasonality (city, state, month_number, avg_occupancy, avg_adr, multiplier, sample_size) VALUES (?,?,?,?,?,?,?) ON CONFLICT(city, state, month_number) DO UPDATE SET avg_occupancy=excluded.avg_occupancy, avg_adr=excluded.avg_adr, multiplier=excluded.multiplier, sample_size=excluded.sample_size, updated_at=datetime('now')`)
      .bind(sd.city, sd.state, sd.month, Math.round(avgOcc * 100) / 100, Math.round(avgAdr * 100) / 100, multiplier, sd.occs.length).run();
  }

  return json({ properties_processed: processed, months_generated: Object.keys(seasonData).length, message: 'Processed ' + processed + ' properties into monthly actuals and seasonality data.' });
}


// ========== GUESTY OPEN API INTEGRATION ==========

async function getGuestyAccessToken(env) {
  // Check for cached token
  const cached = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_access_token'`).first();
  const expiry = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_token_expiry'`).first();
  if (cached?.value && expiry?.value) {
    const expiryTime = parseInt(expiry.value);
    // Refresh if within 5 minutes of expiry
    if (Date.now() < expiryTime - 300000) {
      return cached.value;
    }
  }

  // Get fresh token
  const clientId = env.GUESTY_CLIENT_ID;
  const clientSecret = env.GUESTY_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Guesty API credentials not configured. Add GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET in Admin → API Keys.');

  const resp = await fetch('https://open-api.guesty.com/oauth2/token', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString()
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => 'Unknown error');
    throw new Error('Guesty auth failed (' + resp.status + '): ' + errText.substring(0, 200));
  }
  const data = await resp.json();
  const token = data.access_token;
  if (!token) throw new Error('No access_token in Guesty response');

  // Cache token — expires_in is in seconds, typically 86400 (24h)
  const expiresAt = Date.now() + ((data.expires_in || 86400) * 1000);
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_access_token', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(token, token).run();
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_token_expiry', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(String(expiresAt), String(expiresAt)).run();

  return token;
}

async function guestyApiFetch(env, path, params = {}, method, body) {
  const token = await getGuestyAccessToken(env);
  const url = new URL('https://open-api.guesty.com' + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const opts = { method: method || 'GET', headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } };
  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url.toString(), opts);
  if (resp.status === 403 || resp.status === 401) {
    // Token may have expired, clear cache and retry once
    await env.DB.prepare(`DELETE FROM app_settings WHERE key IN ('guesty_access_token','guesty_token_expiry')`).run();
    const newToken = await getGuestyAccessToken(env);
    opts.headers.Authorization = 'Bearer ' + newToken;
    const resp2 = await fetch(url.toString(), opts);
    if (!resp2.ok) throw new Error('Guesty API error (' + resp2.status + '): ' + (await resp2.text().catch(() => '')).substring(0, 300));
    return await resp2.json();
  }
  if (!resp.ok) throw new Error('Guesty API error (' + resp.status + '): ' + (await resp.text().catch(() => '')).substring(0, 300));
  return await resp.json();
}

async function connectGuestyApi(request, env) {
  const body = await request.json();
  // Save credentials
  if (body.client_id) {
    await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('apikey_GUESTY_CLIENT_ID', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(body.client_id, body.client_id).run();
    env.GUESTY_CLIENT_ID = body.client_id;
  }
  if (body.client_secret) {
    await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('apikey_GUESTY_CLIENT_SECRET', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(body.client_secret, body.client_secret).run();
    env.GUESTY_CLIENT_SECRET = body.client_secret;
  }
  // Clear any cached token so we get a fresh one
  await env.DB.prepare(`DELETE FROM app_settings WHERE key IN ('guesty_access_token','guesty_token_expiry')`).run();

  // Test connection by fetching token + listings
  try {
    const token = await getGuestyAccessToken(env);
    // Quick test: fetch first page of listings
    const data = await guestyApiFetch(env, '/v1/listings', { limit: 5, fields: '_id title address' });
    const listingCount = data.count || (data.results || []).length;
    await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_connected_at', datetime('now'), datetime('now')) ON CONFLICT(key) DO UPDATE SET value = datetime('now'), updated_at = datetime('now')`).run();
    return json({ ok: true, message: 'Connected to Guesty! Found ' + listingCount + ' listings.', listing_count: listingCount });
  } catch (err) {
    return json({ error: 'Connection failed: ' + err.message }, 400);
  }
}

async function getGuestyConnection(env) {
  const hasId = !!env.GUESTY_CLIENT_ID;
  const hasSecret = !!env.GUESTY_CLIENT_SECRET;
  const connectedAt = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_connected_at'`).first();
  const lastSync = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_last_api_sync'`).first();
  const lastSyncCount = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_last_sync_count'`).first();
  const lastSyncError = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_last_sync_error'`).first();
  const tokenExpiry = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_token_expiry'`).first();
  const tokenValid = tokenExpiry?.value ? Date.now() < parseInt(tokenExpiry.value) : false;

  return json({
    configured: hasId && hasSecret,
    connected_at: connectedAt?.value || null,
    token_valid: tokenValid,
    last_sync: lastSync?.value || null,
    last_sync_count: lastSyncCount?.value ? parseInt(lastSyncCount.value) : null,
    last_sync_error: lastSyncError?.value || null,
  });
}

// Debug: fetch a single reservation from Guesty API with ALL fields to see what's available
async function debugGuestyReservation(env, params) {
  try {
    // Step 1: Fetch one reservation from the LIST endpoint (limited fields)
    const limit = 1;
    const skip = parseInt(params.get('skip') || '0');
    const data = await guestyApiFetch(env, '/v1/reservations', { limit, skip, sort: '-createdAt' });
    const r = (data.results || [])[0];
    if (!r) return json({ error: 'No reservations found', count: data.count || 0 });

    const topKeys = Object.keys(r);

    // Step 2: Fetch the SAME reservation via the DETAIL endpoint (returns ALL fields)
    // Guesty list endpoints omit many fields; detail endpoint returns the complete object
    let detailKeys = [];
    let detailPetFields = {};
    let detailCustomFields = null;
    let detailGuestCustomFields = null;
    let detailGuestNote = null;
    let detailNotes = null;
    let detailSpecialRequests = null;
    let detailError = null;
    let detailRaw = null;
    try {
      const resId = r._id;
      const detail = await guestyApiFetch(env, '/v1/reservations/' + resId);
      detailKeys = Object.keys(detail);
      detailCustomFields = detail.customFields || null;
      detailGuestCustomFields = detail.guest?.customFields || null;
      detailGuestNote = detail.guestNote || null;
      detailNotes = detail.notes || null;
      detailSpecialRequests = detail.specialRequests || null;
      // Scan detail for pet/custom/note fields
      function findFields(obj, path) {
        if (!obj || typeof obj !== 'object') return;
        for (const key of Object.keys(obj)) {
          const lk = key.toLowerCase();
          const fullPath = path ? path + '.' + key : key;
          if (lk.includes('pet') || lk.includes('animal') || lk.includes('custom') || lk.includes('note') || lk.includes('special') || lk.includes('request') || lk.includes('addon') || lk.includes('extra') || lk.includes('fee')) {
            detailPetFields[fullPath] = typeof obj[key] === 'object' ? JSON.stringify(obj[key]).substring(0, 500) : obj[key];
          }
          if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
            findFields(obj[key], fullPath);
          }
          if (Array.isArray(obj[key]) && obj[key].length > 0) {
            if (typeof obj[key][0] === 'object') {
              obj[key].slice(0, 3).forEach((item, i) => findFields(item, fullPath + '[' + i + ']'));
            }
            // Check if any array string values mention pets
            obj[key].forEach((item, i) => {
              if (typeof item === 'string' && (item.toLowerCase().includes('pet') || item.toLowerCase().includes('animal') || item.toLowerCase().includes('dog') || item.toLowerCase().includes('cat'))) {
                detailPetFields[fullPath + '[' + i + ']'] = item;
              }
            });
          }
          // Check string values for pet mentions
          if (typeof obj[key] === 'string' && obj[key].length > 0) {
            const lv = obj[key].toLowerCase();
            if (lv.includes('pet') || lv.includes('dog') || lv.includes('cat') || lv.includes('animal') || lv.includes('puppy') || lv.includes('service animal')) {
              detailPetFields[fullPath + ' (text match)'] = obj[key].substring(0, 200);
            }
          }
        }
      }
      findFields(detail, '');
      // Grab money.invoiceItems to see if there's a pet fee line item
      if (detail.money?.invoiceItems) {
        detail.money.invoiceItems.forEach((item, i) => {
          const t = (item.title || item.type || '').toLowerCase();
          if (t.includes('pet') || t.includes('animal') || t.includes('addon')) {
            detailPetFields['money.invoiceItems[' + i + ']'] = JSON.stringify(item).substring(0, 300);
          }
        });
      }
      // Sample of interesting fields for debugging
      detailRaw = {};
      ['customFields','guestNote','notes','specialRequests','addOns','extras','guestComments','hostNote','nightlyPriceOverrides'].forEach(k => {
        if (detail[k] !== undefined && detail[k] !== null && detail[k] !== '') detailRaw[k] = typeof detail[k] === 'object' ? JSON.stringify(detail[k]).substring(0, 500) : String(detail[k]).substring(0, 500);
      });
      if (detail.guest) {
        ['customFields','notes','comments','tags','preferences'].forEach(k => {
          if (detail.guest[k] !== undefined && detail.guest[k] !== null && detail.guest[k] !== '') detailRaw['guest.' + k] = typeof detail.guest[k] === 'object' ? JSON.stringify(detail.guest[k]).substring(0, 500) : String(detail.guest[k]).substring(0, 500);
        });
      }
    } catch (detErr) {
      detailError = detErr.message;
    }

    // Also check listing custom fields — pet policy may be on the listing, not reservation
    let listingPetInfo = null;
    try {
      if (r.listingId) {
        const listing = await guestyApiFetch(env, '/v1/listings/' + r.listingId);
        const lFields = {};
        function findListingPetFields(obj, path) {
          if (!obj || typeof obj !== 'object') return;
          for (const key of Object.keys(obj)) {
            const lk = key.toLowerCase();
            const fp = path ? path + '.' + key : key;
            if (lk.includes('pet') || lk.includes('animal') || lk.includes('custom') || lk.includes('amenity') || lk.includes('policy') || lk.includes('house_rules') || lk.includes('houserules') || lk.includes('addon') || lk.includes('fee')) {
              lFields[fp] = typeof obj[key] === 'object' ? JSON.stringify(obj[key]).substring(0, 500) : String(obj[key]).substring(0, 300);
            }
            if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
              findListingPetFields(obj[key], fp);
            }
          }
        }
        findListingPetFields(listing, '');
        if (Object.keys(lFields).length > 0) listingPetInfo = lFields;
        // Specifically check for petsAllowed, amenities containing pet
        if (listing.petsAllowed !== undefined) listingPetInfo = listingPetInfo || {};
        if (listing.petsAllowed !== undefined) listingPetInfo['petsAllowed'] = listing.petsAllowed;
        if (listing.amenities) {
          const petAmenities = listing.amenities.filter(a => typeof a === 'string' && (a.toLowerCase().includes('pet') || a.toLowerCase().includes('dog')));
          if (petAmenities.length) { listingPetInfo = listingPetInfo || {}; listingPetInfo['pet_amenities'] = petAmenities.join(', '); }
        }
        if (listing.publicDescription?.houseRules) {
          const rules = listing.publicDescription.houseRules;
          if (rules.toLowerCase().includes('pet')) { listingPetInfo = listingPetInfo || {}; listingPetInfo['houseRules_pet_mention'] = rules.substring(0, 300); }
        }
      }
    } catch {}

    return json({
      confirmation_code: r.confirmationCode,
      guest_name: r.guest?.fullName,
      status: r.status,
      total_reservations: data.count || 0,
      // List endpoint results (limited)
      list_endpoint: {
        keys: topKeys,
        has_customFields: !!r.customFields,
        has_guest_customFields: !!r.guest?.customFields,
        guestNote: r.guestNote || null,
        notes: r.notes || null,
        specialRequests: r.specialRequests || null,
      },
      // Detail endpoint results (complete)
      detail_endpoint: {
        keys: detailKeys,
        keys_count: detailKeys.length,
        pet_related_fields: detailPetFields,
        pet_fields_count: Object.keys(detailPetFields).length,
        customFields: detailCustomFields,
        guest_customFields: detailGuestCustomFields,
        guestNote: detailGuestNote,
        notes: detailNotes,
        specialRequests: detailSpecialRequests,
        interesting_fields: detailRaw,
        error: detailError,
      },
      // Listing-level pet info
      listing_pet_info: listingPetInfo,
      // Summary
      diagnosis: Object.keys(detailPetFields).length > 0
        ? 'PET DATA FOUND — fields: ' + Object.keys(detailPetFields).join(', ')
        : listingPetInfo && Object.keys(listingPetInfo).some(k => k.includes('pet') || k.includes('Pet'))
          ? 'PET POLICY ON LISTING — but no per-reservation pet data. You may need a Guesty custom field for guests to indicate pets at booking time.'
          : 'NO PET DATA — Guesty has no pet fields on reservations or listings. Options: 1) Add a custom field in Guesty Settings → Custom Fields, 2) Use Guesty Automation to tag reservations, 3) Manual tagging in FCP-PMR.',
      _raw_sample_keys: topKeys.join(', '),
    });
  } catch (err) {
    return json({ error: err.message });
  }
}

async function syncGuestyApi(request, env) {
  const body = await request.json().catch(() => ({}));
  const fullSync = body.full === true;

  // On full resync, reset pet-check flags so enrichment re-scans all reservations
  if (fullSync) {
    try { await env.DB.prepare(`UPDATE guesty_reservations SET has_pets = 0 WHERE has_pets = -1`).run(); } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L8845', e.message); }
  }

  // Determine date range
  let lastSyncTime = null;
  if (!fullSync) {
    const ls = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_last_api_sync'`).first();
    lastSyncTime = ls?.value || null;
  }

  let allReservations = [];
  let skip = 0;
  const limit = 100;
  const fields = '_id confirmationCode checkInDateLocalized checkOutDateLocalized nightsCount guestsCount numberOfGuests source status money.hostPayout money.totalTaxes money.invoiceItems money.hostServiceFeeIncTax money.settingsSnapshot.additionalFees guest._id guest.fullName guest.email guest.phone guest.hometown guest.address.full guest.address.city guest.address.state guest.address.country guest.customFields listing.title listingId createdAt lastUpdatedAt customFields guestNote notes specialRequests';
  let hasMore = true;

  // Build filters
  const filters = [];
  if (lastSyncTime) {
    filters.push(JSON.stringify({ operator: '$gte', field: 'lastUpdatedAt', value: lastSyncTime }));
  }

  try {
    while (hasMore) {
      const params = { limit, skip, fields, sort: '_id' };
      if (filters.length > 0) params.filters = '[' + filters.join(',') + ']';
      const data = await guestyApiFetch(env, '/v1/reservations', params);
      const results = data.results || [];
      allReservations.push(...results);
      skip += limit;
      // Guesty returns count for total matching; stop when we've fetched all
      hasMore = results.length === limit && (data.count ? skip < data.count : true);
      // Safety cap: 5000 reservations per sync
      if (allReservations.length >= 5000) { hasMore = false; }
    }
  } catch (err) {
    await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_last_sync_error', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(err.message, err.message).run();
    return json({ error: 'Guesty API sync failed: ' + err.message }, 500);
  }

  // Clear any previous sync error since we successfully fetched data
  try { await env.DB.prepare(`DELETE FROM app_settings WHERE key = 'guesty_last_sync_error'`).run(); } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L8886', e.message); }

  // Process and upsert reservations
  let imported = 0, updated = 0, skipped = 0, errors = 0;
  const listingNames = new Set();
  const listingMap = {}; // listingId → { title, address }
  const now = new Date().toISOString();

  for (const r of allReservations) {
    try {
      const code = r.confirmationCode || ('GY-' + (r._id || '').substring(0, 10));
      const listingTitle = r.listing?.title || '';
      const listingId = r.listingId || '';
      const checkIn = r.checkInDateLocalized || '';
      const checkOut = r.checkOutDateLocalized || '';
      const nights = r.nightsCount || 0;
      const guestCount = r.guestsCount || 0;
      const guestName = r.guest?.fullName || '';
      const channel = r.source || '';
      const status = r.status || '';
      const bookingDate = r.createdAt || '';

      // Financial fields from money object
      const hostPayout = r.money?.hostPayout || 0;
      const totalTaxes = r.money?.totalTaxes || 0;
      const platformFee = r.money?.hostServiceFeeIncTax || 0;

      // Extract accommodation fare and cleaning fee from invoice items
      let accommodationFare = 0;
      let cleaningFee = 0;
      let subtotal = 0;
      const invoiceItems = r.money?.invoiceItems || [];
      for (const item of invoiceItems) {
        const t = (item.type || item.title || '').toUpperCase();
        const amt = item.amount || 0;
        if (t === 'ACCOMMODATION_FARE' || t === 'AF' || t === 'ROOM_REVENUE') accommodationFare += amt;
        else if (t === 'CLEANING' || t === 'CLEANING_FEE' || t === 'CF') cleaningFee += amt;
        subtotal += amt;
      }
      // Fallback: if no invoice items but we have hostPayout, estimate
      if (accommodationFare === 0 && hostPayout > 0) accommodationFare = hostPayout;

      // Pet detection from Guesty API fields
      var apiHasPets = 0;
      var apiPetType = null;
      var apiNotes = '';

      // PRIMARY: Check numberOfGuests.numberOfPets (most reliable — actual pet count)
      var numPets = r.numberOfGuests?.numberOfPets || 0;
      if (numPets > 0) {
        apiHasPets = 1;
        apiPetType = numPets + (numPets === 1 ? ' pet' : ' pets');
      }
      // Also check stay[].numberOfGuests.numberOfPets
      if (!apiHasPets && Array.isArray(r.stay)) {
        for (var si of r.stay) {
          var sp = si?.numberOfGuests?.numberOfPets || 0;
          if (sp > 0) { apiHasPets = 1; apiPetType = sp + (sp === 1 ? ' pet' : ' pets'); break; }
        }
      }

      // SECONDARY: Check money.settingsSnapshot.additionalFees for PET type fees charged
      if (!apiHasPets) {
        var addFees = r.money?.settingsSnapshot?.additionalFees || [];
        for (var af of addFees) {
          if ((af.type || '').toUpperCase() === 'PET' || (af.name || '').toLowerCase().includes('pet')) {
            // Fee exists on this reservation — but does the guest actually have pets?
            // The fee being in the snapshot means pet fee CAN apply, but numberOfPets=0 means they didn't bring one
            // Only flag if numberOfPets wasn't already checked (i.e. field was missing, not 0)
            if (r.numberOfGuests?.numberOfPets === undefined) {
              apiHasPets = 1;
              apiPetType = 'pet fee applied';
            }
            break;
          }
        }
      }

      // TERTIARY: Check invoice items for actual pet fee charges
      if (!apiHasPets) {
        for (var ii of invoiceItems) {
          var iiType = ((ii.type || ii.title || '') + '').toUpperCase();
          if (iiType === 'PET' || iiType === 'PET_FEE' || iiType.includes('PET')) {
            var iiAmt = ii.amount || 0;
            if (iiAmt > 0) { apiHasPets = 1; apiPetType = 'pet fee $' + iiAmt; break; }
          }
        }
      }

      // Check customFields array
      var customFields = r.customFields || r.custom_fields || [];
      if (Array.isArray(customFields)) {
        for (var cf of customFields) {
          var cfName = ((cf.fieldId || cf.name || cf.key || '') + '').toLowerCase();
          var cfVal = ((cf.value || '') + '').toLowerCase();
          if (cfName.match(/pet|animal|dog|cat/) || cfVal.match(/pet|dog|cat|yes/)) {
            if (cfVal && cfVal !== 'no' && cfVal !== '0' && cfVal !== 'false' && cfVal !== 'n/a') { apiHasPets = 1; apiPetType = cf.value; }
          }
        }
      }
      // Check guest custom fields
      if (r.guest?.customFields) {
        for (var gcf of (Array.isArray(r.guest.customFields) ? r.guest.customFields : [])) {
          var gcfN = ((gcf.fieldId || gcf.name || '') + '').toLowerCase();
          var gcfV = ((gcf.value || '') + '').toLowerCase();
          if (gcfN.match(/pet|animal/) && gcfV && gcfV !== 'no' && gcfV !== '0') { apiHasPets = 1; apiPetType = gcf.value; }
        }
      }
      // Check notes/specialRequests
      if (r.guestNote || r.notes || r.specialRequests) {
        apiNotes = (r.guestNote || '') + ' ' + (r.notes || '') + ' ' + (r.specialRequests || '');
        if (/\b(pet|dog|cat|puppy|kitten|animal)\b/i.test(apiNotes)) apiHasPets = 1;
      }
      // Also check guest name
      if (/\b(pet|dog|cat|puppy|kitten|animal|pup)\b/i.test(guestName)) apiHasPets = 1;

      if (!checkIn) { skipped++; continue; }
      if (listingTitle) {
        listingNames.add(listingTitle);
        listingMap[listingTitle] = { id: listingId, title: listingTitle };
      }

      // Check if exists for imported vs updated count
      const existing = await env.DB.prepare(`SELECT id FROM guesty_reservations WHERE confirmation_code = ?`).bind(code).first();

      await env.DB.prepare(`INSERT INTO guesty_reservations (confirmation_code, guesty_id, listing_name, check_in, check_out, nights_count, guest_count, guest_name, channel, status, accommodation_fare, cleaning_fee, total_taxes, host_payout, platform_fee, subtotal, currency, booking_date, source_file, last_synced_at, has_pets, pet_type, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(confirmation_code) DO UPDATE SET listing_name=excluded.listing_name, check_in=excluded.check_in, check_out=excluded.check_out, nights_count=excluded.nights_count, guest_count=excluded.guest_count, guest_name=excluded.guest_name, channel=excluded.channel, status=excluded.status, accommodation_fare=excluded.accommodation_fare, cleaning_fee=excluded.cleaning_fee, total_taxes=excluded.total_taxes, host_payout=excluded.host_payout, platform_fee=excluded.platform_fee, subtotal=excluded.subtotal, booking_date=excluded.booking_date, guesty_id=excluded.guesty_id, last_synced_at=excluded.last_synced_at, has_pets=CASE WHEN excluded.has_pets > 0 THEN excluded.has_pets ELSE guesty_reservations.has_pets END, pet_type=COALESCE(excluded.pet_type, guesty_reservations.pet_type), notes=COALESCE(excluded.notes, guesty_reservations.notes)`)
        .bind(code, r._id || null, listingTitle, checkIn, checkOut, nights, guestCount, guestName, channel, status, accommodationFare, cleaningFee, totalTaxes, hostPayout, platformFee, subtotal, 'USD', bookingDate, 'guesty_api', now, apiHasPets, apiPetType, apiNotes.trim() || null).run();

      if (existing) updated++;
      else imported++;

      // Upsert guest record with address/hometown/country if available
      try {
        const gId = r.guest?._id || r.guestId;
        if (gId) {
          const gHometown = r.guest?.hometown || r.guest?.address?.city || '';
          const gCountry = r.guest?.address?.country || '';
          const gState = r.guest?.address?.state || '';
          const gFull = gHometown + (gState ? ', ' + gState : '') + (gCountry && gCountry !== 'US' && gCountry !== 'United States' ? ', ' + gCountry : '');
          await env.DB.prepare(`INSERT INTO guesty_guests (guesty_id, full_name, email, phone, hometown, country, first_seen, last_seen) VALUES (?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(guesty_id) DO UPDATE SET full_name=COALESCE(NULLIF(excluded.full_name,''), full_name), email=COALESCE(NULLIF(excluded.email,''), email), phone=COALESCE(NULLIF(excluded.phone,''), phone), hometown=COALESCE(NULLIF(excluded.hometown,''), hometown), country=COALESCE(NULLIF(excluded.country,''), country), last_seen=datetime('now')`)
            .bind(gId, guestName, r.guest?.email || r.guest?.emails?.[0] || '', r.guest?.phone || r.guest?.phones?.[0] || '', gFull || gHometown, gCountry).run();
        }
      } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9028', e.message); }
    } catch (e) { errors++; }
  }

  // Register discovered listings
  for (const name of listingNames) {
    try {
      const info = listingMap[name] || {};
      const gId = info.id || 'api_' + name.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
      const existing = await env.DB.prepare(`SELECT id, guesty_listing_id, property_id FROM guesty_listings WHERE listing_name = ?`).bind(name).first();
      if (existing && existing.guesty_listing_id !== gId) {
        await env.DB.prepare(`UPDATE guesty_listings SET guesty_listing_id = ? WHERE id = ?`).bind(gId, existing.id).run();
      } else if (!existing) {
        await env.DB.prepare(`INSERT INTO guesty_listings (guesty_listing_id, listing_name) VALUES (?, ?) ON CONFLICT(guesty_listing_id) DO UPDATE SET listing_name=excluded.listing_name`)
          .bind(gId, name).run();
      }
    } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9044', e.message); }
  }

  // Auto-match any new listings
  let matchResults = { matched: 0 };
  try { matchResults = await autoMatchGuestyListings(env); } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9049', e.message); }

  // Update property_id on reservations based on listing matches
  try {
    const { results: matched } = await env.DB.prepare(`SELECT listing_name, property_id FROM guesty_listings WHERE property_id IS NOT NULL`).all();
    for (const m of (matched || [])) {
      await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE listing_name = ? AND property_id IS NULL`).bind(m.property_id, m.listing_name).run();
    }
  } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9057', e.message); }

  // Save sync metadata
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_last_api_sync', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(now, now).run();
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_last_sync_count', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(String(allReservations.length), String(allReservations.length)).run();
  await env.DB.prepare(`DELETE FROM app_settings WHERE key = 'guesty_last_sync_error'`).run();

  // ── PET ENRICHMENT PASS (runs BEFORE processGuestyData so intelligence gets correct pet flags) ──
  let petEnriched = 0;
  let petScanned = 0;
  let petErrors = 0;
  try {
    // PART 1: API-check reservations that have guesty_id (from API sync)
    const { results: uncheckedApi } = await env.DB.prepare(
      `SELECT id, guesty_id, confirmation_code FROM guesty_reservations WHERE guesty_id IS NOT NULL AND has_pets = 0 ORDER BY check_in DESC LIMIT 50`
    ).all();

    for (const res of (uncheckedApi || [])) {
      petScanned++;
      try {
        const detail = await guestyApiFetch(env, '/v1/reservations/' + res.guesty_id);
        var detPets = 0;
        var detPetType = null;

        var np = detail.numberOfGuests?.numberOfPets || 0;
        if (np > 0) { detPets = 1; detPetType = np + (np === 1 ? ' pet' : ' pets'); }

        if (!detPets && Array.isArray(detail.stay)) {
          for (var stayItem of detail.stay) {
            var snp = stayItem?.numberOfGuests?.numberOfPets || 0;
            if (snp > 0) { detPets = 1; detPetType = snp + (snp === 1 ? ' pet' : ' pets'); break; }
          }
        }

        var detPetFee = 0;
        if (!detPets && detail.money?.invoiceItems) {
          for (var inv of detail.money.invoiceItems) {
            var invT = ((inv.type || inv.title || '') + '').toUpperCase();
            if ((invT === 'PET' || invT === 'PET_FEE' || invT.includes('PET')) && (inv.amount || 0) > 0) {
              detPets = 1; detPetFee = inv.amount || 0; detPetType = 'pet fee $' + detPetFee; break;
            }
          }
        }

        if (!detPets) {
          var detNotes = (detail.guestNote || '') + ' ' + (detail.notes || '') + ' ' + (detail.specialRequests || '');
          if (/\b(pet|dog|cat|puppy|kitten|animal|service animal)\b/i.test(detNotes)) {
            detPets = 1; detPetType = 'mentioned in notes';
          }
        }

        await env.DB.prepare(`UPDATE guesty_reservations SET has_pets = ?, pet_type = COALESCE(?, pet_type), pet_fee = CASE WHEN ? > 0 THEN ? ELSE pet_fee END WHERE id = ?`)
          .bind(detPets > 0 ? 1 : -1, detPetType, detPetFee, detPetFee, res.id).run();
        if (detPets > 0) petEnriched++;
      } catch (petErr) {
        petErrors++;
        await env.DB.prepare(`UPDATE guesty_reservations SET has_pets = -1 WHERE id = ?`).bind(res.id).run();
      }
    }

    // PART 2: Text-scan CSV-only reservations using data already in the DB (NO API calls)
    // These 422 rows don't exist in Guesty API — scan guest_name, notes, pet_type for pet keywords
    const { results: csvRows } = await env.DB.prepare(
      `SELECT id, guest_name, notes, pet_type FROM guesty_reservations WHERE guesty_id IS NULL AND has_pets = 0 LIMIT 500`
    ).all();

    const petRx = /\b(pet|pets|dog|dogs|cat|cats|puppy|puppies|kitten|animal|animals|k9|canine|feline|pup|furry friend|service animal)\b/i;
    for (const row of (csvRows || [])) {
      petScanned++;
      var csvPet = 0;
      var csvPetType = null;
      var textToScan = (row.guest_name || '') + ' ' + (row.notes || '') + ' ' + (row.pet_type || '');
      if (petRx.test(textToScan)) {
        csvPet = 1;
        csvPetType = 'detected in: ' + (petRx.test(row.guest_name || '') ? 'guest name' : petRx.test(row.notes || '') ? 'notes' : 'pet_type field');
      }
      // Also check if pet_type column has any value
      if (!csvPet && row.pet_type && row.pet_type.trim() !== '') {
        csvPet = 1;
        csvPetType = row.pet_type;
      }
      await env.DB.prepare(`UPDATE guesty_reservations SET has_pets = ? WHERE id = ?`)
        .bind(csvPet > 0 ? 1 : -1, row.id).run();
      if (csvPet > 0) {
        await env.DB.prepare(`UPDATE guesty_reservations SET pet_type = ? WHERE id = ? AND pet_type IS NULL`)
          .bind(csvPetType, row.id).run();
        petEnriched++;
      }
    }
  } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9146', e.message); }

  // NOW process into monthly actuals + rebuild guest intelligence (AFTER pet enrichment)
  let processResult = null;
  try { processResult = await processGuestyData(env); } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9150', e.message); }
  let rebuildResult = null;
  try { rebuildResult = await rebuildIntelligence(new Request('http://x', { method: 'POST', body: JSON.stringify({ sections: ['guests'] }) }), env); } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9152', e.message); }

    var resultMsg = '';
    // Pet diagnostic counts
    let petCheckedThisSync = 0;
    let petAlreadyChecked = 0;
    let petTotal = 0;
    try {
      const pc = await env.DB.prepare(`SELECT 
        SUM(CASE WHEN has_pets = 1 THEN 1 ELSE 0 END) as with_pets,
        SUM(CASE WHEN has_pets = -1 THEN 1 ELSE 0 END) as checked_no_pets,
        SUM(CASE WHEN has_pets = 0 THEN 1 ELSE 0 END) as unchecked,
        COUNT(*) as total
        FROM guesty_reservations WHERE guesty_id IS NOT NULL`).first();
      petTotal = pc?.total || 0;
      petAlreadyChecked = (pc?.with_pets || 0) + (pc?.checked_no_pets || 0);
      petCheckedThisSync = petEnriched;
    } catch (e) { syslog(env, 'error', 'syncGuestyApi', 'L9169', e.message); }

    if (allReservations.length === 0 && !fullSync) {
      resultMsg = 'No new or updated reservations since last sync. Use "Full Re-sync" to re-fetch all data.';
    } else {
      resultMsg = (fullSync ? 'Full sync' : 'Incremental sync') + ': ' + imported + ' new, ' + updated + ' updated' + (errors > 0 ? ', ' + errors + ' errors' : '') + ' from ' + allReservations.length + ' reservations.' + (matchResults.matched > 0 ? ' Auto-matched ' + matchResults.matched + ' listings.' : '') + (processResult ? ' Monthly actuals updated.' : '') + (rebuildResult ? ' Guest intelligence rebuilt.' : '');
    }
    // Always append pet status
    resultMsg += ' 🐾 Pet scan: checked ' + petScanned + ' reservations, ' + petEnriched + ' had pets' + (petErrors > 0 ? ', ' + petErrors + ' errors' : '') + '.';

    return json({
    ok: true,
    mode: fullSync ? 'full' : 'incremental',
    fetched: allReservations.length,
    imported, updated, skipped, errors,
    auto_matched: matchResults.matched,
    auto_processed: processResult ? true : false,
    pet_scan: {
      scanned: petScanned,
      with_pets: petEnriched,
      errors: petErrors,
      total_with_guesty_id: petTotal,
      already_checked: petAlreadyChecked,
      note: petScanned === 0 ? 'No unchecked reservations found — all already scanned. If you expected pets, check the debug tool.' : petEnriched === 0 ? 'Checked ' + petScanned + ' reservations via detail API — none had numberOfGuests.numberOfPets > 0 or pet fee charges. Your guests have not added pets to their bookings.' : petEnriched + ' reservations had pets'
    },
    message: resultMsg
  });
}

async function syncGuestyListingsApi(env) {
  let allListings = [];
  let skip = 0;
  const limit = 100;
  let hasMore = true;

  try {
    while (hasMore) {
      const data = await guestyApiFetch(env, '/v1/listings', { limit, skip, fields: '_id title address.full address.street address.city address.state address.zipcode nickname propertyType bedrooms bathrooms accommodates picture.thumbnail pictures' });
      const results = data.results || [];
      allListings.push(...results);
      skip += limit;
      hasMore = results.length === limit;
      if (allListings.length >= 500) hasMore = false;
    }
  } catch (err) {
    return json({ error: 'Failed to fetch listings: ' + err.message }, 500);
  }

  let upserted = 0, matched = 0, photosUpdated = 0;
  for (const l of allListings) {
    try {
      const gId = l._id;
      const title = l.title || l.nickname || '';
      const addr = l.address?.full || (l.address?.street || '') + ', ' + (l.address?.city || '') + ', ' + (l.address?.state || '');
      const city = l.address?.city || '';
      const state = l.address?.state || '';
      const zip = l.address?.zipcode || '';
      const pType = l.propertyType || '';
      const beds = l.bedrooms || null;
      const baths = l.bathrooms || null;
      const accommodates = l.accommodates || null;
      const thumbnail = l.picture?.thumbnail || '';
      // Collect picture URLs (original size preferred)
      const pics = (l.pictures || []).map(p => p.original || p.large || p.thumbnail || '').filter(Boolean);
      const picsJson = pics.length > 0 ? JSON.stringify(pics) : null;
      // Capture listing description
      const desc = l.publicDescription?.summary || l.publicDescription?.space || l.publicDescription?.notes || l.title || '';

      // Check if a listing with this name already exists (from CSV import with different ID)
      const existingByName = await env.DB.prepare(`SELECT id, guesty_listing_id, property_id FROM guesty_listings WHERE listing_name = ?`).bind(title).first();
      if (existingByName && existingByName.guesty_listing_id !== gId) {
        // Update existing row with the real Guesty API ID — preserve property_id link
        await env.DB.prepare(`UPDATE guesty_listings SET guesty_listing_id = ?, listing_address = COALESCE(NULLIF(?, ''), listing_address), listing_city = COALESCE(NULLIF(?, ''), listing_city), listing_state = COALESCE(NULLIF(?, ''), listing_state), listing_zip = COALESCE(NULLIF(?, ''), listing_zip), listing_property_type = COALESCE(NULLIF(?, ''), listing_property_type), listing_bedrooms = COALESCE(?, listing_bedrooms), listing_bathrooms = COALESCE(?, listing_bathrooms), listing_accommodates = COALESCE(?, listing_accommodates), listing_thumbnail = COALESCE(NULLIF(?, ''), listing_thumbnail), listing_pictures_json = COALESCE(?, listing_pictures_json), listing_description = COALESCE(NULLIF(?, ''), listing_description) WHERE id = ?`)
          .bind(gId, addr, city, state, zip, pType, beds, baths, accommodates, thumbnail, picsJson, desc, existingByName.id).run();
        upserted++;
        continue;
      }

      // Normal upsert by guesty_listing_id
      await env.DB.prepare(`INSERT INTO guesty_listings (guesty_listing_id, listing_name, listing_address, listing_city, listing_state, listing_zip, listing_property_type, listing_bedrooms, listing_bathrooms, listing_accommodates, listing_thumbnail, listing_pictures_json, listing_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guesty_listing_id) DO UPDATE SET listing_name=excluded.listing_name, listing_address=COALESCE(NULLIF(excluded.listing_address, ''), listing_address), listing_city=COALESCE(NULLIF(excluded.listing_city, ''), listing_city), listing_state=COALESCE(NULLIF(excluded.listing_state, ''), listing_state), listing_zip=COALESCE(NULLIF(excluded.listing_zip, ''), listing_zip), listing_property_type=COALESCE(NULLIF(excluded.listing_property_type, ''), listing_property_type), listing_bedrooms=COALESCE(excluded.listing_bedrooms, listing_bedrooms), listing_bathrooms=COALESCE(excluded.listing_bathrooms, listing_bathrooms), listing_accommodates=COALESCE(excluded.listing_accommodates, listing_accommodates), listing_thumbnail=COALESCE(NULLIF(excluded.listing_thumbnail, ''), listing_thumbnail), listing_pictures_json=COALESCE(excluded.listing_pictures_json, listing_pictures_json), listing_description=COALESCE(NULLIF(excluded.listing_description, ''), listing_description)`)
        .bind(gId, title, addr, city, state, zip, pType, beds, baths, accommodates, thumbnail, picsJson, desc).run();
      upserted++;
    } catch {}
  }

  // Auto-match
  try { const r = await autoMatchGuestyListings(env); matched = r.matched; } catch {}

  // Auto-update property images from Guesty thumbnails
  try {
    const { results: linked } = await env.DB.prepare(`SELECT gl.listing_thumbnail, gl.listing_pictures_json, gl.property_id, gl.listing_name FROM guesty_listings gl WHERE gl.property_id IS NOT NULL AND gl.listing_thumbnail IS NOT NULL AND gl.listing_thumbnail != ''`).all();
    for (const l of (linked || [])) {
      try {
        // Set main image if empty
        const updated = await env.DB.prepare(`UPDATE properties SET image_url = ? WHERE id = ? AND (image_url IS NULL OR image_url = '')`).bind(l.listing_thumbnail, l.property_id).run();
        if (updated.meta.changes > 0) photosUpdated++;
        
        // Add to property_images if not already there
        const existing = await env.DB.prepare(`SELECT COUNT(*) as c FROM property_images WHERE property_id = ? AND source = 'guesty'`).bind(l.property_id).first();
        if (!existing || existing.c === 0) {
          let photos = [l.listing_thumbnail];
          if (l.listing_pictures_json) {
            try { const pics = JSON.parse(l.listing_pictures_json); photos.push(...pics.filter(u => u && u !== l.listing_thumbnail)); } catch {}
          }
          let order = 0;
          for (const url of photos) {
            await env.DB.prepare(`INSERT INTO property_images (property_id, image_url, caption, sort_order, source) VALUES (?, ?, ?, ?, 'guesty')`).bind(l.property_id, url, 'From Guesty', order++).run();
          }
        }
      } catch {}
    }
  } catch {}

  return json({ ok: true, listings_fetched: allListings.length, upserted, auto_matched: matched, photos_updated: photosUpdated, message: 'Synced ' + allListings.length + ' listings from Guesty API. ' + matched + ' auto-matched to properties.' + (photosUpdated > 0 ? ' Updated ' + photosUpdated + ' property photos.' : '') });
}

async function syncGuestyPhotos(request, env) {
  const body = await request.json().catch(() => ({}));
  const forceOverwrite = body.force === true;
  
  // Get all linked listings with photos
  const { results: linked } = await env.DB.prepare(`SELECT gl.listing_thumbnail, gl.listing_pictures_json, gl.property_id, gl.listing_name, p.image_url as current_image FROM guesty_listings gl JOIN properties p ON gl.property_id = p.id WHERE gl.property_id IS NOT NULL`).all();
  
  if (!linked || linked.length === 0) {
    return json({ ok: true, updated: 0, message: 'No linked listings found. Run Sync Listings first.' });
  }
  
  let propsUpdated = 0, photosAdded = 0, skipped = 0;
  for (const l of linked) {
    try {
      // Collect all photo URLs for this listing
      let photos = [];
      if (l.listing_thumbnail) photos.push(l.listing_thumbnail);
      if (l.listing_pictures_json) {
        try {
          const pics = JSON.parse(l.listing_pictures_json);
          for (const url of pics) {
            if (url && !photos.includes(url)) photos.push(url);
          }
        } catch {}
      }
      
      if (photos.length === 0) { skipped++; continue; }
      
      // Check what photos already exist for this property from guesty
      const { results: existing } = await env.DB.prepare(`SELECT image_url FROM property_images WHERE property_id = ? AND source = 'guesty'`).bind(l.property_id).all();
      const existingUrls = new Set((existing || []).map(e => e.image_url));
      
      if (!forceOverwrite && existingUrls.size > 0) {
        // Only add new photos not already present
        let added = 0;
        for (const url of photos) {
          if (!existingUrls.has(url)) {
            const maxOrder = await env.DB.prepare(`SELECT MAX(sort_order) as mx FROM property_images WHERE property_id = ?`).bind(l.property_id).first();
            await env.DB.prepare(`INSERT INTO property_images (property_id, image_url, caption, sort_order, source) VALUES (?, ?, ?, ?, 'guesty')`).bind(l.property_id, url, 'From Guesty: ' + (l.listing_name || ''), (maxOrder?.mx || 0) + 1).run();
            added++;
          }
        }
        photosAdded += added;
        if (added > 0) propsUpdated++;
        else skipped++;
      } else {
        // Force mode or no existing guesty photos — clear guesty photos and re-add
        if (forceOverwrite) {
          await env.DB.prepare(`DELETE FROM property_images WHERE property_id = ? AND source = 'guesty'`).bind(l.property_id).run();
        }
        const maxOrder = await env.DB.prepare(`SELECT MAX(sort_order) as mx FROM property_images WHERE property_id = ?`).bind(l.property_id).first();
        let order = (maxOrder?.mx || 0) + 1;
        for (const url of photos) {
          await env.DB.prepare(`INSERT INTO property_images (property_id, image_url, caption, sort_order, source) VALUES (?, ?, ?, ?, 'guesty')`).bind(l.property_id, url, 'From Guesty: ' + (l.listing_name || ''), order++).run();
          photosAdded++;
        }
        propsUpdated++;
      }
      
      // Set first photo as main image if property has none (or force overwrite)
      if (photos[0] && (forceOverwrite || !l.current_image)) {
        await env.DB.prepare(`UPDATE properties SET image_url = ? WHERE id = ?`).bind(photos[0], l.property_id).run();
      }
    } catch {}
  }
  
  return json({ ok: true, properties_updated: propsUpdated, photos_added: photosAdded, skipped, total: linked.length, message: 'Updated ' + propsUpdated + ' properties with ' + photosAdded + ' photos from Guesty.' + (skipped > 0 ? ' Skipped ' + skipped + ' already up to date.' : '') });
}


// ─── Sync Log Helper ─────────────────────────────────────────────────────
async function logSync(env, syncType, source, fn) {
  const logId = await env.DB.prepare(`INSERT INTO sync_log (sync_type, source) VALUES (?, ?)`).bind(syncType, source).run();
  const id = logId.meta.last_row_id;
  try {
    const result = await fn();
    const records = (result && typeof result === 'object') ? (result.fetched || result.imported || result.upserted || result.processed || 0) : 0;
    await env.DB.prepare(`UPDATE sync_log SET status = 'completed', records_processed = ?, completed_at = datetime('now') WHERE id = ?`).bind(records, id).run();
    return result;
  } catch (err) {
    await env.DB.prepare(`UPDATE sync_log SET status = 'error', error = ?, completed_at = datetime('now') WHERE id = ?`).bind(err.message, id).run();
    throw err;
  }
}

// ─── Guesty Webhook Handler ──────────────────────────────────────────────
async function handleGuestyWebhook(request, env) {
  await ensureSchema(env);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }

  // Validate webhook secret — REQUIRED for security
  const secret = await (async () => { try { return (await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_webhook_secret'`).first())?.value; } catch { return null; } })();
  if (!secret) return json({ error: 'Webhook secret not configured. Set guesty_webhook_secret in Admin settings.' }, 403);
  const provided = request.headers.get('x-webhook-secret') || request.headers.get('x-guesty-signature') || '';
  if (provided !== secret) return json({ error: 'Invalid webhook secret' }, 401);

  const event = body.event || 'unknown';
  const summary = event + ': ' + (body.reservation?.confirmationCode || body.listing?._id || body.guest?._id || '').substring(0, 30);

  // Log the webhook
  try { await env.DB.prepare(`INSERT INTO webhook_log (source, event_type, payload_summary, status) VALUES ('guesty', ?, ?, 'processing')`).bind(event, summary).run(); } catch {}

  try {
    switch (event) {
      case 'reservation.new':
      case 'reservation.updated': {
        const r = body.reservation;
        if (!r) break;
        const code = r.confirmationCode || ('GY-' + (r._id || '').substring(0, 10));
        const listingTitle = r.listing?.title || '';
        const listingId = r.listingId || '';
        const checkIn = r.checkInDateLocalized || '';
        const checkOut = r.checkOutDateLocalized || '';
        const nights = r.nightsCount || 0;
        const guestCount = (r.numberOfGuests?.numberOfAdults || 0) + (r.numberOfGuests?.numberOfChildren || 0) || r.guestsCount || 0;
        const guestName = r.guest?.fullName || '';
        const channel = r.source || r.integration?.platform || '';
        const status = r.status || '';
        const bookingDate = r.createdAt || '';
        const hostPayout = r.money?.hostPayout || 0;
        const totalTaxes = r.money?.totalTaxes || 0;
        const platformFee = r.money?.hostServiceFeeIncTax || 0;
        const totalPaid = r.money?.totalPaid || 0;
        const balanceDue = r.money?.balanceDue || 0;
        let accommodationFare = 0, cleaningFee = 0, subtotal = 0;
        for (const item of (r.money?.invoiceItems || [])) {
          const t = (item.type || item.title || '').toUpperCase();
          const amt = item.amount || 0;
          if (t === 'ACCOMMODATION_FARE' || t === 'AF' || t === 'ROOM_REVENUE') accommodationFare += amt;
          else if (t === 'CLEANING' || t === 'CLEANING_FEE' || t === 'CF') cleaningFee += amt;
          subtotal += amt;
        }
        if (accommodationFare === 0 && hostPayout > 0) accommodationFare = hostPayout;

        if (checkIn) {
          await env.DB.prepare(`INSERT INTO guesty_reservations (confirmation_code, guesty_id, listing_name, check_in, check_out, nights_count, guest_count, guest_name, channel, status, accommodation_fare, cleaning_fee, total_taxes, host_payout, platform_fee, subtotal, currency, booking_date, source_file, last_synced_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(confirmation_code) DO UPDATE SET listing_name=excluded.listing_name, check_in=excluded.check_in, check_out=excluded.check_out, nights_count=excluded.nights_count, guest_count=excluded.guest_count, guest_name=excluded.guest_name, channel=excluded.channel, status=excluded.status, accommodation_fare=excluded.accommodation_fare, cleaning_fee=excluded.cleaning_fee, total_taxes=excluded.total_taxes, host_payout=excluded.host_payout, platform_fee=excluded.platform_fee, subtotal=excluded.subtotal, booking_date=excluded.booking_date, guesty_id=excluded.guesty_id, last_synced_at=excluded.last_synced_at`)
            .bind(code, r._id || null, listingTitle, checkIn, checkOut, nights, guestCount, guestName, channel, status, accommodationFare, cleaningFee, totalTaxes, hostPayout, platformFee, subtotal, 'USD', bookingDate, 'webhook', new Date().toISOString()).run();

          // Auto-link property_id
          if (listingTitle) {
            const match = await env.DB.prepare(`SELECT property_id FROM guesty_listings WHERE listing_name = ? AND property_id IS NOT NULL`).bind(listingTitle).first();
            if (match) await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE confirmation_code = ? AND property_id IS NULL`).bind(match.property_id, code).run();
          }
        }

        // Upsert guest data (including hometown/country from address)
        if (r.guest?._id || r.guestId) {
          const gId = r.guest?._id || r.guestId;
          const gHometown = r.guest?.hometown || r.guest?.address?.city || '';
          const gCountry = r.guest?.address?.country || '';
          await env.DB.prepare(`INSERT INTO guesty_guests (guesty_id, full_name, email, phone, hometown, country, is_returning, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(guesty_id) DO UPDATE SET full_name=COALESCE(NULLIF(excluded.full_name,''), full_name), email=COALESCE(NULLIF(excluded.email,''), email), phone=COALESCE(NULLIF(excluded.phone,''), phone), hometown=COALESCE(NULLIF(excluded.hometown,''), hometown), country=COALESCE(NULLIF(excluded.country,''), country), last_seen=datetime('now'), total_stays=total_stays+1`)
            .bind(gId, guestName, r.guest?.email || '', r.guest?.phone || '', gHometown, gCountry, r.isReturningGuest ? 1 : 0).run();
        }
        break;
      }

      case 'listing.new':
      case 'listing.updated': {
        const l = body.listing;
        if (!l || !l._id) break;
        const title = l.title || l.nickname || '';
        const addr = l.address?.full || '';
        await env.DB.prepare(`INSERT INTO guesty_listings (guesty_listing_id, listing_name, listing_address) VALUES (?, ?, ?) ON CONFLICT(guesty_listing_id) DO UPDATE SET listing_name=COALESCE(NULLIF(excluded.listing_name,''), listing_name), listing_address=COALESCE(NULLIF(excluded.listing_address,''), listing_address)`)
          .bind(l._id, title, addr).run();
        break;
      }

      case 'listing.removed': {
        const l = body.listing;
        if (l?._id) {
          // Don't delete — just note it; property link should remain
          try { await env.DB.prepare(`UPDATE guesty_listings SET listing_name = listing_name || ' [REMOVED]' WHERE guesty_listing_id = ? AND listing_name NOT LIKE '%[REMOVED]%'`).bind(l._id).run(); } catch {}
        }
        break;
      }

      case 'listing.calendar.updated':
      case 'calendar.updated.v2': {
        // Calendar change — update our calendar table
        const calDays = body.calendar || [];
        for (const day of calDays) {
          if (!day.date || !day.listingId) continue;
          const propMatch = await env.DB.prepare(`SELECT property_id FROM guesty_listings WHERE guesty_listing_id = ?`).bind(day.listingId).first();
          await env.DB.prepare(`INSERT INTO guesty_calendar (guesty_listing_id, property_id, date, price, min_nights, status, is_base_price, currency, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(guesty_listing_id, date) DO UPDATE SET price=excluded.price, min_nights=excluded.min_nights, status=excluded.status, is_base_price=excluded.is_base_price, property_id=excluded.property_id, updated_at=datetime('now')`)
            .bind(day.listingId, propMatch?.property_id || null, day.date, day.price || null, day.minNights || 1, day.status || 'available', day.isBasePrice ? 1 : 0, day.currency || 'USD').run();
        }
        break;
      }

      case 'guest.created':
      case 'guest.updated': {
        const g = body.guest;
        if (!g?._id) break;
        await env.DB.prepare(`INSERT INTO guesty_guests (guesty_id, full_name, email, phone, hometown, first_seen, last_seen) VALUES (?,?,?,?,?,datetime('now'),datetime('now')) ON CONFLICT(guesty_id) DO UPDATE SET full_name=COALESCE(NULLIF(excluded.full_name,''), full_name), email=COALESCE(NULLIF(excluded.email,''), email), phone=COALESCE(NULLIF(excluded.phone,''), phone), hometown=COALESCE(NULLIF(excluded.hometown,''), hometown), last_seen=datetime('now')`)
          .bind(g._id, g.fullName || '', g.email || g.emails?.[0] || '', g.phone || g.phones?.[0] || '', g.hometown || '').run();
        break;
      }
    }

    // Update webhook log to success
    try { await env.DB.prepare(`UPDATE webhook_log SET status = 'processed' WHERE source = 'guesty' AND event_type = ? ORDER BY id DESC LIMIT 1`).bind(event).run(); } catch {}

  } catch (err) {
    try { await env.DB.prepare(`UPDATE webhook_log SET status = 'error', error = ? WHERE source = 'guesty' AND event_type = ? ORDER BY id DESC LIMIT 1`).bind(err.message, event).run(); } catch {}
  }

  return json({ ok: true, event });
}

// ─── Guesty Calendar Sync (API pull) ─────────────────────────────────────
async function syncGuestyCalendar(request, env) {
  const body = await request.json().catch(() => ({}));
  const daysAhead = body.days_ahead || 365;

  // Get all linked listings
  const { results: listings } = await env.DB.prepare(`SELECT guesty_listing_id, property_id FROM guesty_listings WHERE property_id IS NOT NULL`).all();
  if (!listings || listings.length === 0) return json({ ok: true, message: 'No linked listings', synced: 0 });

  const startDate = new Date().toISOString().split('T')[0];
  const endDate = new Date(Date.now() + daysAhead * 86400000).toISOString().split('T')[0];

  let totalDays = 0, listingsSynced = 0;
  for (const listing of listings) {
    try {
      const data = await guestyApiFetch(env, '/v1/availability-pricing/api/calendar/listings/' + listing.guesty_listing_id, { startDate, endDate });
      const days = data?.data?.days || data?.days || [];
      for (const day of days) {
        if (!day.date) continue;
        await env.DB.prepare(`INSERT INTO guesty_calendar (guesty_listing_id, property_id, date, price, min_nights, status, is_base_price, currency, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(guesty_listing_id, date) DO UPDATE SET price=excluded.price, min_nights=excluded.min_nights, status=excluded.status, is_base_price=excluded.is_base_price, property_id=excluded.property_id, updated_at=datetime('now')`)
          .bind(listing.guesty_listing_id, listing.property_id, day.date, day.price || null, day.minNights || 1, day.status || 'available', day.isBasePrice ? 1 : 0, day.currency || 'USD').run();
        totalDays++;
      }
      listingsSynced++;
    } catch (err) {
      console.error('[Calendar Sync] Error for ' + listing.guesty_listing_id + ': ' + err.message);
    }
  }

  // Clean up old calendar data (past dates > 30 days)
  try { await env.DB.prepare(`DELETE FROM guesty_calendar WHERE date < date('now', '-30 days')`).run(); } catch {}

  return json({ ok: true, listings_synced: listingsSynced, days_synced: totalDays, range: startDate + ' to ' + endDate, message: 'Synced calendar for ' + listingsSynced + ' listings (' + totalDays + ' days)' });
}

// ─── Get Calendar Data ───────────────────────────────────────────────────
async function getGuestyCalendarData(params, env) {
  const propertyId = params.get('property_id');
  const from = params.get('from') || new Date().toISOString().split('T')[0];
  const to = params.get('to') || new Date(Date.now() + 90 * 86400000).toISOString().split('T')[0];

  let query = `SELECT gc.*, gl.listing_name FROM guesty_calendar gc LEFT JOIN guesty_listings gl ON gc.guesty_listing_id = gl.guesty_listing_id WHERE gc.date >= ? AND gc.date <= ?`;
  const binds = [from, to];
  if (propertyId) { query += ` AND gc.property_id = ?`; binds.push(propertyId); }
  query += ` ORDER BY gc.date`;

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json({ calendar: results || [] });
}

// ─── Webhook Subscription Management ─────────────────────────────────────
async function subscribeGuestyWebhooks(request, env) {
  const body = await request.json().catch(() => ({}));
  const webhookUrl = body.webhook_url;
  if (!webhookUrl) return json({ error: 'webhook_url required' }, 400);

  // Generate a secret for validation
  const secret = 'wh_' + Date.now().toString(36) + '_' + Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(36)).join('').slice(0, 10);

  const events = [
    'reservation.new', 'reservation.updated',
    'listing.new', 'listing.updated', 'listing.removed',
    'listing.calendar.updated',
    'guest.created', 'guest.updated',
  ];

  const subscribed = [];
  const errors = [];
  for (const evt of events) {
    try {
      const resp = await guestyApiFetch(env, '/v1/webhooks', {}, 'POST', {
        url: webhookUrl,
        event: evt,
        secret: secret,
      });
      subscribed.push(evt);
    } catch (err) {
      errors.push({ event: evt, error: err.message });
    }
  }

  // Save webhook config
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_webhook_url', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(webhookUrl, webhookUrl).run();
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('guesty_webhook_secret', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`).bind(secret, secret).run();

  return json({ ok: true, subscribed, errors, secret, message: 'Subscribed to ' + subscribed.length + ' events.' + (errors.length > 0 ? ' ' + errors.length + ' failed.' : '') });
}

async function getGuestyWebhookStatus(env) {
  let url = null, secret = null, recentLogs = [], stats = [];
  try { const r = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_webhook_url'`).first(); url = r?.value || null; } catch {}
  try { const r = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_webhook_secret'`).first(); secret = r?.value || null; } catch {}
  try { const r = await env.DB.prepare(`SELECT * FROM webhook_log WHERE source = 'guesty' ORDER BY id DESC LIMIT 20`).all(); recentLogs = r.results || []; } catch {}
  try { const r = await env.DB.prepare(`SELECT event_type, COUNT(*) as count, MAX(created_at) as last_received FROM webhook_log WHERE source = 'guesty' GROUP BY event_type ORDER BY count DESC`).all(); stats = r.results || []; } catch {}
  return json({
    configured: !!url,
    webhook_url: url,
    has_secret: !!secret,
    recent_events: recentLogs,
    event_stats: stats,
  });
}

// ─── Sync Log & Manual Sync ──────────────────────────────────────────────
async function getSyncLog(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 50`).all();
    return json({ log: results || [] });
  } catch { return json({ log: [] }); }
}

async function runManualSync(request, env) {
  const { sync_type } = await request.json().catch(() => ({}));
  if (!sync_type) return json({ error: 'sync_type required' }, 400);

  try {
    switch (sync_type) {
      case 'guesty_reservations': {
        const fakeReq = { json: async () => ({ full: false }) };
        const result = await logSync(env, 'guesty_reservations', 'manual', () => syncGuestyApi(fakeReq, env));
        return result;
      }
      case 'guesty_reservations_full': {
        const fakeReq = { json: async () => ({ full: true }) };
        const result = await logSync(env, 'guesty_reservations_full', 'manual', () => syncGuestyApi(fakeReq, env));
        return result;
      }
      case 'guesty_listings': {
        const result = await logSync(env, 'guesty_listings', 'manual', () => syncGuestyListingsApi(env));
        return result;
      }
      case 'guesty_calendar': {
        const fakeReq = { json: async () => ({}) };
        const result = await logSync(env, 'guesty_calendar', 'manual', () => syncGuestyCalendar(fakeReq, env));
        return result;
      }
      case 'pricelabs_prices': {
        const result = await logSync(env, 'pricelabs_prices', 'manual', () => fetchAllPriceLabsPrices(env, null, false));
        return result;
      }
      case 'pricelabs_listings': {
        const result = await logSync(env, 'pricelabs_listings', 'manual', () => syncPriceLabsListings(env, null, false));
        return result;
      }
      case 'monthly_actuals': {
        const result = await logSync(env, 'monthly_actuals', 'manual', () => processGuestyData(env));
        return result;
      }
      case 'intelligence': {
        const fakeReq = { json: async () => ({ sections: ['guests', 'market', 'channels'] }) };
        const result = await logSync(env, 'intelligence', 'manual', () => rebuildIntelligence(fakeReq, env));
        return result;
      }
      default:
        return json({ error: 'Unknown sync_type: ' + sync_type }, 400);
    }
  } catch (err) {
    return json({ error: 'Sync failed: ' + err.message }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENCE ENGINE
// ═══════════════════════════════════════════════════════════════════════════

async function getIntelligenceDebug(env) {
  try {
    const totalRes = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations`).first();
    const byStatus = await env.DB.prepare(`SELECT COALESCE(status,'(null)') as status, COUNT(*) as c FROM guesty_reservations GROUP BY status ORDER BY c DESC`).all();
    const withGuestName = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE guest_name IS NOT NULL AND guest_name != ''`).first();
    const withoutGuestName = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE guest_name IS NULL OR guest_name = ''`).first();
    const bySource = await env.DB.prepare(`SELECT COALESCE(source_file,'(null)') as source, COUNT(*) as c FROM guesty_reservations GROUP BY source_file ORDER BY c DESC`).all();
    const byChannel = await env.DB.prepare(`SELECT COALESCE(channel,'(null)') as channel, COUNT(*) as c FROM guesty_reservations GROUP BY channel ORDER BY c DESC`).all();
    const totalGuests = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_guests`).first();
    const totalStays = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE guest_id IS NOT NULL AND ${LIVE_STATUS_SQL}`).first();
    const guestsWithStays = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_guests WHERE total_stays > 0`).first();
    const sampleRes = await env.DB.prepare(`SELECT confirmation_code, guest_name, status, channel, source_file, check_in, nights_count, accommodation_fare, host_payout FROM guesty_reservations ORDER BY check_in DESC LIMIT 5`).all();
    // Check excluded statuses
    const excluded = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE LOWER(COALESCE(status,'')) IN ()`).first();
    const eligible = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE guest_name IS NOT NULL AND guest_name != '' AND ${LIVE_STATUS_SQL}`).first();

    return json({
      total_reservations: totalRes?.c || 0,
      with_guest_name: withGuestName?.c || 0,
      without_guest_name: withoutGuestName?.c || 0,
      excluded_by_status: excluded?.c || 0,
      eligible_for_intel: eligible?.c || 0,
      by_status: byStatus.results || [],
      by_source: bySource.results || [],
      by_channel: byChannel.results || [],
      guest_profiles: totalGuests?.c || 0,
      guest_stays: totalStays?.c || 0, // now reads live from guesty_reservations
      guests_with_stays: guestsWithStays?.c || 0,
      sample_reservations: sampleRes.results || [],
    });
  } catch (err) { return json({ error: err.message }); }
}

async function getGuestIntelligence(params, env) {
  const propertyId = params.get('property_id');
  const period = params.get('period') || 'all'; // all, ytd, 12mo, 6mo, 3mo, month

  // Compute date filter based on period
  const now = new Date();
  let dateFrom = null;
  let dateTo = now.toISOString().split('T')[0];
  let periodLabel = 'All Time';
  if (period === 'ytd') { dateFrom = now.getFullYear() + '-01-01'; periodLabel = 'Year to Date'; }
  else if (period === '12mo') { dateFrom = new Date(now.getTime() - 365 * 86400000).toISOString().split('T')[0]; periodLabel = 'Last 12 Months'; }
  else if (period === '6mo') { dateFrom = new Date(now.getTime() - 182 * 86400000).toISOString().split('T')[0]; periodLabel = 'Last 6 Months'; }
  else if (period === '3mo') { dateFrom = new Date(now.getTime() - 91 * 86400000).toISOString().split('T')[0]; periodLabel = 'Last 3 Months'; }
  else if (period === 'month') { dateFrom = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01'; periodLabel = 'This Month'; }
  // SQL fragment for filtering guesty_reservations directly (no materialized view)
  const LIVE_STATUS = `${LIVE_STATUS_GR}`;
  // Safety: ensure dateFrom is strictly YYYY-MM-DD format before interpolation
  if (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) dateFrom = null;
  const grDateFilter = dateFrom ? ` AND gr.check_in >= '${dateFrom}'` : '';
  const grDateFilter2 = dateFrom ? ` AND gr2.check_in >= '${dateFrom}'` : '';
  const grDateFilterBare = dateFrom ? ` AND check_in >= '${dateFrom}'` : '';

  const result = { top_guests: [], pet_stats: {}, returning_rate: { total: 0, returning: 0, pct: 0 }, origins: [], channel_preferences: [], avg_group_size: 0, max_group_size: 0, stay_distribution: [], platforms: [], total_stays: 0, period: period, period_label: periodLabel, date_from: dateFrom, date_to: dateTo, _filter: grDateFilterBare || '(none — all time)' };

  // Top guests by revenue — include properties stayed at (filtered by period)
  try {
    let topQuery = `SELECT g.id, g.full_name, g.is_returning, g.has_pets, g.preferred_channel,
      (SELECT COUNT(*) FROM guesty_reservations gr WHERE gr.guest_id = g.id AND ${LIVE_STATUS}${grDateFilter}) as stay_count,
      (SELECT SUM(accommodation_fare) FROM guesty_reservations gr WHERE gr.guest_id = g.id AND ${LIVE_STATUS}${grDateFilter}) as total_rev,
      (SELECT ROUND(AVG(nights_count),1) FROM guesty_reservations gr WHERE gr.guest_id = g.id AND ${LIVE_STATUS}${grDateFilter}) as avg_nights,
      (SELECT GROUP_CONCAT(prop_label, ' | ') FROM (SELECT DISTINCT CASE WHEN p.unit_number IS NOT NULL AND p.unit_number != '' THEN p.unit_number || ' — ' || COALESCE(p.address, p.name) ELSE COALESCE(p.address, p.name, 'Property') END as prop_label
       FROM guesty_reservations gr2 LEFT JOIN properties p ON gr2.property_id = p.id
       WHERE gr2.guest_id = g.id AND gr2.property_id IS NOT NULL${grDateFilter2})) as properties_stayed
      FROM guesty_guests g WHERE (SELECT COUNT(*) FROM guesty_reservations gr WHERE gr.guest_id = g.id AND ${LIVE_STATUS}${grDateFilter}) > 0 ORDER BY total_rev DESC LIMIT 25`;
    const { results } = await env.DB.prepare(topQuery).all();
    result.top_guests = results || [];
  } catch (err) { result._errors = (result._errors || []).concat('top_guests: ' + err.message); }

  // Pet stats (filtered)
  try {
    const petStats = await env.DB.prepare(`SELECT COUNT(*) as total_pet_bookings, COUNT(DISTINCT guest_id) as unique_pet_guests, SUM(accommodation_fare) as pet_booking_revenue, SUM(COALESCE(pet_fee, 0)) as pet_fee_revenue FROM guesty_reservations WHERE has_pets = 1 AND ${LIVE_STATUS_SQL}${grDateFilterBare}`).first();
    result.pet_stats = petStats || {};
  } catch (err) { result._errors = (result._errors || []).concat('pet_stats: ' + err.message); }

  // Returning guest rate
  try {
    const ret = await env.DB.prepare(`SELECT COUNT(DISTINCT gr.guest_id) as total, SUM(CASE WHEN g.total_stays > 1 THEN 1 ELSE 0 END) as returning_count FROM (SELECT DISTINCT guest_id FROM guesty_reservations WHERE guest_id IS NOT NULL AND ${LIVE_STATUS_SQL}${grDateFilterBare}) gr LEFT JOIN guesty_guests g ON g.id = gr.guest_id`).first();
    result.returning_rate = ret ? { total: ret.total || 0, returning: ret.returning_count || 0, pct: (ret.total || 0) > 0 ? Math.round((ret.returning_count || 0) / ret.total * 100) : 0 } : { total: 0, returning: 0, pct: 0 };
  } catch (err) { result._errors = (result._errors || []).concat('returning: ' + err.message); }

  // Guest origin
  try {
    const { results: origins } = await env.DB.prepare(`SELECT COALESCE(g.country, g.hometown, 'Unknown') as origin, COUNT(DISTINCT g.id) as count, SUM(gr.accommodation_fare) as revenue FROM guesty_reservations gr JOIN guesty_guests g ON gr.guest_id = g.id WHERE ${LIVE_STATUS_GR}${grDateFilterBare.replace(/check_in/g, 'gr.check_in')} GROUP BY origin ORDER BY revenue DESC LIMIT 15`).all();
    result.origins = origins || [];
  } catch (err) { result._errors = (result._errors || []).concat('origins: ' + err.message); }

  // Channel preference (filtered)
  try {
    const { results: channelPrefs } = await env.DB.prepare(`SELECT channel, COUNT(*) as stays, COUNT(DISTINCT guest_id) as guests, SUM(accommodation_fare) as revenue FROM guesty_reservations WHERE channel IS NOT NULL AND channel != '' AND ${LIVE_STATUS_SQL}${grDateFilterBare} GROUP BY channel ORDER BY revenue DESC`).all();
    result.channel_preferences = channelPrefs || [];
  } catch (err) { result._errors = (result._errors || []).concat('channels: ' + err.message); }

  // Avg group size (filtered)
  try {
    const avgGroup = await env.DB.prepare(`SELECT AVG(guest_count) as avg_guests, MAX(guest_count) as max_guests FROM guesty_reservations WHERE guest_count > 0 AND ${LIVE_STATUS_SQL}${grDateFilterBare}`).first();
    result.avg_group_size = avgGroup?.avg_guests ? Math.round(avgGroup.avg_guests * 10) / 10 : 0;
    result.max_group_size = avgGroup?.max_guests || 0;
  } catch (err) { result._errors = (result._errors || []).concat('group: ' + err.message); }

  // Stay length distribution (filtered)
  try {
    const { results: stayDist } = await env.DB.prepare(`SELECT CASE WHEN nights_count <= 2 THEN 'Weekend (1-2)' WHEN nights_count <= 4 THEN 'Short (3-4)' WHEN nights_count <= 7 THEN 'Week (5-7)' WHEN nights_count <= 14 THEN 'Extended (8-14)' WHEN nights_count <= 30 THEN 'Monthly (15-30)' ELSE 'Long-term (30+)' END as bucket, COUNT(*) as count, SUM(accommodation_fare) as revenue, AVG(accommodation_fare) as avg_rev FROM guesty_reservations WHERE ${LIVE_STATUS_SQL}${grDateFilterBare} GROUP BY bucket ORDER BY count DESC`).all();
    result.stay_distribution = stayDist || [];
  } catch (err) { result._errors = (result._errors || []).concat('distribution: ' + err.message); }

  // Platform/source breakdown (filtered)
  try {
    const { results: platforms } = await env.DB.prepare(`SELECT COALESCE(source_file, 'unknown') as platform, COUNT(*) as stays, COUNT(DISTINCT guest_id) as guests, SUM(accommodation_fare) as revenue FROM guesty_reservations WHERE ${LIVE_STATUS_SQL}${grDateFilterBare} GROUP BY platform ORDER BY stays DESC`).all();
    result.platforms = platforms || [];
  } catch (err) { result._errors = (result._errors || []).concat('platforms: ' + err.message); }

  // Total stays (filtered)
  try {
    const totalStays = await env.DB.prepare(`SELECT COUNT(*) as c, SUM(accommodation_fare) as rev, MIN(check_in) as earliest, MAX(check_in) as latest FROM guesty_reservations WHERE ${LIVE_STATUS_SQL}${grDateFilterBare}`).first();
    result.total_stays = totalStays?.c || 0;
    result.total_revenue = Math.round(totalStays?.rev || 0);
    result.data_range = { earliest: totalStays?.earliest, latest: totalStays?.latest };
  } catch (err) { result._errors = (result._errors || []).concat('total: ' + err.message); }

  // Demand segment breakdown
  try {
    const { results: segments } = await env.DB.prepare(`SELECT demand_segment, COUNT(*) as count, SUM(accommodation_fare) as revenue, AVG(nights_count) as avg_nights, AVG(accommodation_fare) as avg_rev FROM guesty_reservations WHERE demand_segment IS NOT NULL AND ${LIVE_STATUS_SQL}${grDateFilterBare} GROUP BY demand_segment ORDER BY revenue DESC`).all();
    result.demand_segments = segments || [];
  } catch (err) { result._errors = (result._errors || []).concat('segments: ' + err.message); }

  return json(result);
}

async function getMarketIntelligence(params, env) {
  const city = params.get('city');
  const state = params.get('state');
  try {
    let query = `SELECT * FROM market_intelligence WHERE 1=1`;
    const binds = [];
    if (city) { query += ` AND LOWER(city) = LOWER(?)`; binds.push(city); }
    if (state) { query += ` AND state = ?`; binds.push(state); }
    query += ` ORDER BY city, state, property_type, bedrooms, metric_key`;
    const { results } = await env.DB.prepare(query).bind(...binds).all();

    // Also get available markets
    const { results: markets } = await env.DB.prepare(`SELECT DISTINCT city, state, COUNT(*) as metrics FROM market_intelligence GROUP BY city, state ORDER BY city`).all();

    return json({ metrics: results || [], markets: markets || [] });
  } catch (err) { return json({ error: err.message, metrics: [], markets: [] }); }
}

async function getChannelIntelligence(params, env) {
  const propertyId = params.get('property_id');
  const period = params.get('period');
  try {
    let query = `SELECT ci.*, p.name as prop_name, p.address as prop_address FROM channel_intelligence ci LEFT JOIN properties p ON ci.property_id = p.id WHERE 1=1`;
    const binds = [];
    if (propertyId) { query += ` AND ci.property_id = ?`; binds.push(propertyId); }
    if (period) { query += ` AND ci.period = ?`; binds.push(period); }
    query += ` ORDER BY ci.total_revenue DESC`;
    const { results } = await env.DB.prepare(query).bind(...binds).all();

    // Portfolio-wide channel summary
    const { results: portfolio } = await env.DB.prepare(`SELECT channel, SUM(reservations) as reservations, SUM(total_revenue) as revenue, SUM(total_payout) as payout, SUM(cancellations) as cancellations, SUM(pet_bookings) as pet_bookings, AVG(avg_adr) as avg_adr, AVG(avg_nights) as avg_nights FROM channel_intelligence GROUP BY channel ORDER BY revenue DESC`).all();

    return json({ by_property: results || [], portfolio: portfolio || [] });
  } catch (err) { return json({ error: err.message, by_property: [], portfolio: [] }); }
}

async function rebuildIntelligence(request, env) {
  const body = await request.json().catch(() => ({}));
  const sections = body.sections || ['guests', 'market', 'channels'];
  const results = {};

  // ── GUEST INTELLIGENCE ──────────────────────────────────────────────────
  if (sections.includes('guests')) {
    try {
      // Clear guest_id links on reservations (will be re-stamped below)
      await env.DB.prepare(`UPDATE guesty_reservations SET guest_id = NULL`).run();
      // Reset all guest profile stats (will be repopulated below)
      await env.DB.prepare(`UPDATE guesty_guests SET total_stays = 0, total_revenue = 0, avg_stay_nights = 0, avg_spend = 0, is_returning = 0`).run();

      // Grab ALL reservations with a guest name, EXCLUDING only canceled/declined/expired
      // This is platform-agnostic — works for Guesty, Hostaway, OwnerRez, direct booking CSV, etc.
      const { results: reservations } = await env.DB.prepare(
        `SELECT gr.*, gl.property_id as linked_prop_id
         FROM guesty_reservations gr
         LEFT JOIN guesty_listings gl ON gr.listing_name = gl.listing_name
         WHERE gr.guest_name IS NOT NULL AND gr.guest_name != ''
           AND ${LIVE_STATUS_GR}`
      ).all();

      // Also grab from any future booking tables (direct bookings, other PMS)
      // This JOIN structure lets us extend later without rewriting

      // Group by guest name to build profiles
      const guestMap = {};
      for (const r of (reservations || [])) {
        const name = (r.guest_name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (!guestMap[key]) guestMap[key] = { name, stays: [], channels: {}, platforms: {}, totalRev: 0, totalNights: 0 };
        guestMap[key].stays.push(r);
        guestMap[key].totalRev += (r.host_payout || r.accommodation_fare || 0);
        guestMap[key].totalNights += (r.nights_count || 0);
        const ch = r.channel || 'Direct';
        guestMap[key].channels[ch] = (guestMap[key].channels[ch] || 0) + 1;
        // Track platform source (guesty_api, csv, direct, hostaway, etc.)
        const plat = r.source_file || 'unknown';
        guestMap[key].platforms[plat] = (guestMap[key].platforms[plat] || 0) + 1;
      }

      // Upsert guests and create stays
      let guestsProcessed = 0, staysCreated = 0;
      for (const key in guestMap) {
        const g = guestMap[key];
        const topChannel = Object.entries(g.channels).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        const avgNights = g.stays.length > 0 ? Math.round(g.totalNights / g.stays.length * 10) / 10 : 0;
        const avgSpend = g.stays.length > 0 ? Math.round(g.totalRev / g.stays.length) : 0;

        // Check for pet mentions: has_pets column, guest name patterns, notes fields
        // Guesty often stores pets in guest name like "John + Dog", or in notes/custom fields
        const petPatterns = /\b(pet|pets|dog|dogs|cat|cats|puppy|kitten|animal|k9|canine|feline|furry|pup)\b/i;
        const hasPets = g.stays.some(s =>
          (s.has_pets === 1 || s.has_pets === '1') ||
          petPatterns.test(s.guest_name || '') ||
          petPatterns.test(s.notes || '') ||
          petPatterns.test(s.custom_fields || '') ||
          petPatterns.test(s.special_requests || '') ||
          (s.pet_type && s.pet_type !== '')
        );

        // Find or create guest
        let guestId;
        const existingByGuestyId = g.stays.find(s => s.guesty_id);
        if (existingByGuestyId) {
          const existing = await env.DB.prepare(`SELECT id FROM guesty_guests WHERE guesty_id = ?`).bind(existingByGuestyId.guesty_id).first();
          if (existing) {
            guestId = existing.id;
            await env.DB.prepare(`UPDATE guesty_guests SET full_name = ?, total_stays = ?, total_revenue = ?, avg_stay_nights = ?, avg_spend = ?, preferred_channel = ?, has_pets = ?, is_returning = ?, last_seen = ? WHERE id = ?`)
              .bind(g.name, g.stays.length, Math.round(g.totalRev), avgNights, avgSpend, topChannel, hasPets ? 1 : 0, g.stays.length > 1 ? 1 : 0, g.stays[g.stays.length - 1].check_in, guestId).run();
          }
        }
        if (!guestId) {
          const guestyId = existingByGuestyId?.guesty_id || 'name_' + key.replace(/[^a-z0-9]/g, '_').substring(0, 50);
          const ins = await env.DB.prepare(`INSERT INTO guesty_guests (guesty_id, full_name, total_stays, total_revenue, avg_stay_nights, avg_spend, preferred_channel, has_pets, is_returning, first_seen, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(guesty_id) DO UPDATE SET full_name=excluded.full_name, total_stays=excluded.total_stays, total_revenue=excluded.total_revenue, avg_stay_nights=excluded.avg_stay_nights, avg_spend=excluded.avg_spend, preferred_channel=excluded.preferred_channel, has_pets=excluded.has_pets, is_returning=excluded.is_returning, last_seen=excluded.last_seen`)
            .bind(guestyId, g.name, g.stays.length, Math.round(g.totalRev), avgNights, avgSpend, topChannel, hasPets ? 1 : 0, g.stays.length > 1 ? 1 : 0, g.stays[0].check_in, g.stays[g.stays.length - 1].check_in).run();
          guestId = ins.meta.last_row_id || (await env.DB.prepare(`SELECT id FROM guesty_guests WHERE guesty_id = ?`).bind(guestyId).first())?.id;
        }
        guestsProcessed++;

        // Stamp guest_id onto guesty_reservations (live data — no materialized view)
        for (const s of g.stays) {
          await env.DB.prepare(`UPDATE guesty_reservations SET guest_id = ? WHERE confirmation_code = ?`)
            .bind(guestId, s.confirmation_code).run();
          staysCreated++;
        }
      }
      results.guests = { processed: guestsProcessed, stays: staysCreated };
    } catch (err) { results.guests = { error: err.message }; }
  }

  // ── DEMAND SEGMENT CLASSIFICATION ──────────────────────────────────────
  if (sections.includes('guests') || sections.includes('segments')) {
    try {
      const { results: unclassified } = await env.DB.prepare(
        `SELECT id, nights_count, guest_count, channel, check_in, booking_date, notes, guest_name, accommodation_fare
         FROM guesty_reservations
         WHERE demand_segment IS NULL
           AND ${LIVE_STATUS_SQL}`
      ).all();

      let classified = 0;
      for (const r of (unclassified || [])) {
        const nights = r.nights_count || 0;
        const guests = r.guest_count || 0;
        const channel = (r.channel || '').toLowerCase();
        const notes = (r.notes || '' ).toLowerCase() + ' ' + (r.guest_name || '').toLowerCase();
        const checkIn = r.check_in || '';
        const bookingDate = r.booking_date || '';
        const fare = r.accommodation_fare || 0;
        const adr = nights > 0 ? fare / nights : 0;

        // Lead time in days
        let leadDays = null;
        if (bookingDate && checkIn) {
          try { leadDays = Math.round((new Date(checkIn) - new Date(bookingDate)) / 86400000); } catch (e) { syslog(env, 'error', 'rebuildIntelligence', 'L9944', e.message); }
        }

        // Month for seasonality
        const month = checkIn ? parseInt(checkIn.substring(5, 7)) : 0;
        const isWeekday = checkIn ? [1,2,3,4].includes(new Date(checkIn + 'T12:00:00Z').getUTCDay()) : false;

        // Classification logic — pattern matching on available signals
        let segment = 'vacation_str'; // default

        // Text pattern matching (strongest signal)
        if (/\b(insurance|claim|displaced|fire|flood|storm|fema|emergency|temporary housing)\b/.test(notes)) {
          segment = 'insurance';
        } else if (/\b(travel\s*nurs|nurse|healthcare|medical|hospital|rn\b|lpn\b|cna\b|assignment)\b/.test(notes)) {
          segment = 'travel_nurse';
        } else if (/\b(corporate|business|work|company|relocat|transfer|consult)\b/.test(notes)) {
          segment = 'corporate';
        } else if (/\b(relocat|moving|new\s*home|house\s*hunt|transition|between\s*homes)\b/.test(notes)) {
          segment = 'relocation';
        }
        // Stay length patterns (if no text match)
        else if (nights >= 90) {
          segment = 'long_term';
        } else if (nights >= 28) {
          // Monthly stays: likely corporate, travel nurse, or insurance
          segment = guests <= 2 ? 'corporate' : 'midterm_family';
        } else if (nights >= 14) {
          // 2-4 weeks: midterm — could be corporate or extended vacation
          segment = (guests <= 2 && isWeekday) ? 'corporate' : 'extended_vacation';
        } else if (nights >= 5 && nights <= 7) {
          segment = 'vacation_str'; // classic week vacation
        } else if (nights <= 2) {
          // Weekend: vacation/getaway
          segment = 'weekend_getaway';
        } else {
          // 3-4 nights
          segment = 'short_vacation';
        }

        // Last-minute override: very short lead time + weekday = likely insurance/emergency
        if (leadDays !== null && leadDays <= 2 && nights >= 7) {
          segment = 'insurance'; // emergency placement
        }

        await env.DB.prepare(`UPDATE guesty_reservations SET demand_segment = ? WHERE id = ?`).bind(segment, r.id).run();
        classified++;
      }
      results.segments = { classified };
    } catch (err) { results.segments = { error: err.message }; }
  }

  // ── MARKET INTELLIGENCE ─────────────────────────────────────────────────
  if (sections.includes('market')) {
    try {
      await env.DB.prepare(`DELETE FROM market_intelligence`).run();
      // Aggregate from monthly_actuals + properties
      const { results: propActuals } = await env.DB.prepare(`SELECT p.city, p.state, p.property_type, p.bedrooms, ma.month, ma.total_revenue, ma.booked_nights, ma.available_nights, ma.occupancy_pct, ma.avg_nightly_rate, ma.host_payout, ma.num_reservations FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE p.is_research != 1 OR p.is_research IS NULL`).all();

      const markets = {};
      for (const row of (propActuals || [])) {
        const key = (row.city || 'Unknown') + '|' + (row.state || '') + '|' + (row.property_type || 'all') + '|' + (row.bedrooms || 0);
        if (!markets[key]) markets[key] = { city: row.city, state: row.state, type: row.property_type, beds: row.bedrooms, months: [], totalRev: 0, totalPayout: 0, totalNights: 0, totalAvail: 0, totalBookings: 0 };
        markets[key].months.push(row);
        markets[key].totalRev += (row.total_revenue || 0);
        markets[key].totalPayout += (row.host_payout || 0);
        markets[key].totalNights += (row.booked_nights || 0);
        markets[key].totalAvail += (row.available_nights || 30);
        markets[key].totalBookings += (row.num_reservations || 0);
      }

      let metricsInserted = 0;
      const stmt = env.DB.prepare(`INSERT INTO market_intelligence (city, state, property_type, bedrooms, metric_key, metric_value, sample_size, period, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(city, state, property_type, bedrooms, metric_key, period) DO UPDATE SET metric_value=excluded.metric_value, sample_size=excluded.sample_size, updated_at=datetime('now')`);

      for (const key in markets) {
        const m = markets[key];
        const n = m.months.length;
        const avgOcc = m.totalAvail > 0 ? Math.round(m.totalNights / m.totalAvail * 100) : 0;
        const avgAdr = m.totalNights > 0 ? Math.round(m.totalRev / m.totalNights) : 0;
        const avgMonthlyRev = n > 0 ? Math.round(m.totalRev / n) : 0;
        const avgMonthlyPayout = n > 0 ? Math.round(m.totalPayout / n) : 0;

        const binds = [m.city, m.state, m.type || 'all', m.beds || 0];
        await stmt.bind(...binds, 'avg_occupancy_pct', avgOcc, n, 'all_time').run();
        await stmt.bind(...binds, 'avg_adr', avgAdr, n, 'all_time').run();
        await stmt.bind(...binds, 'avg_monthly_revenue', avgMonthlyRev, n, 'all_time').run();
        await stmt.bind(...binds, 'avg_monthly_payout', avgMonthlyPayout, n, 'all_time').run();
        await stmt.bind(...binds, 'avg_bookings_per_month', n > 0 ? Math.round(m.totalBookings / n * 10) / 10 : 0, n, 'all_time').run();
        await stmt.bind(...binds, 'total_months_data', n, n, 'all_time').run();
        metricsInserted += 6;

        // Per-month seasonality
        const byMonth = {};
        m.months.forEach(mo => {
          const mn = parseInt(mo.month.substring(5, 7));
          if (!byMonth[mn]) byMonth[mn] = { rev: 0, nights: 0, avail: 0, count: 0 };
          byMonth[mn].rev += (mo.total_revenue || 0);
          byMonth[mn].nights += (mo.booked_nights || 0);
          byMonth[mn].avail += (mo.available_nights || 30);
          byMonth[mn].count++;
        });
        for (const mn in byMonth) {
          const bm = byMonth[mn];
          await stmt.bind(...binds, 'seasonal_occupancy_' + mn, bm.avail > 0 ? Math.round(bm.nights / bm.avail * 100) : 0, bm.count, 'month_' + mn).run();
          await stmt.bind(...binds, 'seasonal_adr_' + mn, bm.nights > 0 ? Math.round(bm.rev / bm.nights) : 0, bm.count, 'month_' + mn).run();
          metricsInserted += 2;
        }
      }
      results.market = { metrics_inserted: metricsInserted, markets: Object.keys(markets).length };
    } catch (err) { results.market = { error: err.message }; }
  }

  // ── CHANNEL INTELLIGENCE ────────────────────────────────────────────────
  if (sections.includes('channels')) {
    try {
      await env.DB.prepare(`DELETE FROM channel_intelligence`).run();
      const { results: reservations } = await env.DB.prepare(
        `SELECT gr.*, gl.property_id as linked_prop_id FROM guesty_reservations gr
         LEFT JOIN guesty_listings gl ON gr.listing_name = gl.listing_name
         WHERE ${LIVE_STATUS_GR}`
      ).all();

      const channels = {};
      for (const r of (reservations || [])) {
        const ch = r.channel || 'Direct';
        const propId = r.property_id || r.linked_prop_id || 0;
        const period = 'all_time';
        const key = propId + '|' + ch + '|' + period;
        if (!channels[key]) channels[key] = { propId, channel: ch, period, count: 0, rev: 0, payout: 0, nights: 0, cancels: 0, pets: 0, guests: 0, leadDays: 0 };
        channels[key].count++;
        channels[key].rev += (r.accommodation_fare || 0);
        channels[key].payout += (r.host_payout || 0);
        channels[key].nights += (r.nights_count || 0);
        channels[key].guests += (r.guest_count || 0);
        channels[key].pets += (r.has_pets || 0);
        // Lead time: booking_date to check_in
        if (r.booking_date && r.check_in) {
          const lead = Math.round((new Date(r.check_in) - new Date(r.booking_date)) / 86400000);
          if (lead >= 0 && lead < 365) channels[key].leadDays += lead;
        }
      }

      // Also count cancellations
      const { results: cancels } = await env.DB.prepare(`SELECT channel, property_id, COUNT(*) as c FROM guesty_reservations WHERE status = 'canceled' GROUP BY channel, property_id`).all();
      for (const c of (cancels || [])) {
        const key = (c.property_id || 0) + '|' + (c.channel || 'Direct') + '|all_time';
        if (channels[key]) channels[key].cancels += c.c;
      }

      let inserted = 0;
      for (const key in channels) {
        const c = channels[key];
        const avgAdr = c.nights > 0 ? Math.round(c.rev / c.nights) : 0;
        const avgNights = c.count > 0 ? Math.round(c.nights / c.count * 10) / 10 : 0;
        const avgLead = c.count > 0 ? Math.round(c.leadDays / c.count) : 0;
        const avgGuests = c.count > 0 ? Math.round(c.guests / c.count * 10) / 10 : 0;
        const cancelRate = (c.count + c.cancels) > 0 ? Math.round(c.cancels / (c.count + c.cancels) * 100) : 0;

        await env.DB.prepare(`INSERT INTO channel_intelligence (property_id, channel, period, reservations, total_revenue, total_payout, avg_adr, avg_nights, avg_lead_days, cancellations, cancel_rate, pet_bookings, avg_guest_count, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(property_id, channel, period) DO UPDATE SET reservations=excluded.reservations, total_revenue=excluded.total_revenue, total_payout=excluded.total_payout, avg_adr=excluded.avg_adr, avg_nights=excluded.avg_nights, avg_lead_days=excluded.avg_lead_days, cancellations=excluded.cancellations, cancel_rate=excluded.cancel_rate, pet_bookings=excluded.pet_bookings, avg_guest_count=excluded.avg_guest_count, updated_at=datetime('now')`)
          .bind(c.propId || null, c.channel, c.period, c.count, Math.round(c.rev), Math.round(c.payout), avgAdr, avgNights, avgLead, c.cancels, cancelRate, c.pets, avgGuests).run();
        inserted++;
      }
      results.channels = { channel_records: inserted };
    } catch (err) { results.channels = { error: err.message }; }
  }

  // ── PRICING DISCREPANCY DETECTION ────────────────────────────────────────
  // Compare PriceLabs recommended prices vs what's actually live in Guesty calendar
  try {
    const { results: linked } = await env.DB.prepare(`SELECT pl.pl_listing_id, gl.guesty_listing_id, gl.property_id FROM pricelabs_listings pl JOIN guesty_listings gl ON pl.property_id = gl.property_id WHERE gl.guesty_listing_id IS NOT NULL AND pl.property_id IS NOT NULL`).all();
    let discrepancies = 0;
    for (const link of (linked || [])) {
      // Get PriceLabs rates for this listing
      const { results: plRates } = await env.DB.prepare(`SELECT rate_date, price FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= date('now') ORDER BY rate_date`).bind(link.pl_listing_id).all();
      for (const plr of (plRates || [])) {
        // Update guesty_calendar with PL recommended price and calculate discrepancy
        const gcRow = await env.DB.prepare(`SELECT price FROM guesty_calendar WHERE guesty_listing_id = ? AND date = ?`).bind(link.guesty_listing_id, plr.rate_date).first();
        if (gcRow && gcRow.price && plr.price) {
          const disc = Math.round(gcRow.price - plr.price);
          await env.DB.prepare(`UPDATE guesty_calendar SET pl_recommended_price = ?, price_discrepancy = ? WHERE guesty_listing_id = ? AND date = ?`)
            .bind(plr.price, disc, link.guesty_listing_id, plr.rate_date).run();
          if (Math.abs(disc) > 5) discrepancies++;
        }
      }
    }
    results.pricing = { discrepancies_found: discrepancies };
  } catch (err) { results.pricing = { error: err.message }; }

  return json({ ok: true, results, message: 'Intelligence rebuild complete.' });
}

// ── AI CONTEXT: Returns intelligence data formatted for AI prompts ───────
async function getIntelligenceContext(params, env) {
  const propertyId = params.get('property_id');
  const city = params.get('city');
  const state = params.get('state');

  let context = '=== PORTFOLIO INTELLIGENCE (from actual data) ===\n\n';

  // Market benchmarks
  try {
    let mq = `SELECT * FROM market_intelligence WHERE period = 'all_time'`;
    const mb = [];
    if (city) { mq += ` AND LOWER(city) = LOWER(?)`; mb.push(city); }
    if (state) { mq += ` AND state = ?`; mb.push(state); }
    mq += ` ORDER BY city, bedrooms, metric_key`;
    const { results: metrics } = await env.DB.prepare(mq).bind(...mb).all();
    if (metrics && metrics.length > 0) {
      context += '── Market Benchmarks (from your properties) ──\n';
      const grouped = {};
      metrics.forEach(m => {
        const k = m.city + ', ' + m.state + ' | ' + (m.property_type || 'all') + ' | ' + m.bedrooms + 'BR';
        if (!grouped[k]) grouped[k] = {};
        grouped[k][m.metric_key] = m.metric_value;
      });
      for (const k in grouped) {
        const g = grouped[k];
        context += k + ': Occ ' + (g.avg_occupancy_pct || 0) + '%, ADR $' + (g.avg_adr || 0) + ', Monthly Rev $' + (g.avg_monthly_revenue || 0) + ', Payout $' + (g.avg_monthly_payout || 0) + '\n';
      }
      context += '\n';
    }
  } catch {}

  // Channel performance
  try {
    const { results: channels } = await env.DB.prepare(`SELECT channel, SUM(reservations) as bookings, ROUND(AVG(avg_adr)) as adr, ROUND(AVG(avg_nights),1) as nights, ROUND(AVG(cancel_rate)) as cancel_pct, SUM(pet_bookings) as pets FROM channel_intelligence GROUP BY channel ORDER BY SUM(total_revenue) DESC`).all();
    if (channels && channels.length > 0) {
      context += '── Channel Performance ──\n';
      channels.forEach(c => { context += c.channel + ': ' + c.bookings + ' bookings, $' + c.adr + ' ADR, ' + c.nights + ' avg nights, ' + c.cancel_pct + '% cancel rate' + (c.pets > 0 ? ', ' + c.pets + ' pet bookings' : '') + '\n'; });
      context += '\n';
    }
  } catch {}

  // Guest insights
  try {
    const returning = await env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN total_stays > 1 THEN 1 ELSE 0 END) as returning_count FROM guesty_guests WHERE total_stays > 0`).first();
    const petGuests = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_guests WHERE has_pets = 1`).first();
    const avgGroup = await env.DB.prepare(`SELECT AVG(guest_count) as avg FROM guesty_reservations WHERE guest_count > 0 AND ${LIVE_STATUS_SQL}`).first();
    if (returning) {
      context += '── Guest Profile ──\n';
      context += 'Returning guest rate: ' + (returning.total > 0 ? Math.round(returning.returning_count / returning.total * 100) : 0) + '% (' + (returning.returning_count || 0) + ' of ' + (returning.total || 0) + ')\n';
      context += 'Guests with pets: ' + (petGuests?.c || 0) + '\n';
      context += 'Avg group size: ' + (avgGroup?.avg ? Math.round(avgGroup.avg * 10) / 10 : 0) + ' guests\n\n';
    }
  } catch {}

  // Pricing discrepancy alerts
  try {
    const { results: discrepancies } = await env.DB.prepare(`SELECT gc.date, gc.price as guesty_price, gc.pl_recommended_price, gc.price_discrepancy, gl.listing_name, gc.property_id FROM guesty_calendar gc JOIN guesty_listings gl ON gc.guesty_listing_id = gl.guesty_listing_id WHERE gc.price_discrepancy IS NOT NULL AND ABS(gc.price_discrepancy) > 10 AND gc.date >= date('now') AND gc.date <= date('now', '+30 days') ORDER BY ABS(gc.price_discrepancy) DESC LIMIT 10`).all();
    if (discrepancies && discrepancies.length > 0) {
      context += '── Pricing Discrepancies (Guesty live vs PriceLabs recommended) ──\n';
      context += '⚠ These dates have significant price differences between what is live and what PriceLabs recommends:\n';
      discrepancies.forEach(d => {
        context += '  ' + d.listing_name + ' ' + d.date + ': Live $' + Math.round(d.guesty_price) + ' vs PL recommended $' + Math.round(d.pl_recommended_price) + ' (diff $' + d.price_discrepancy + ')\n';
      });
      context += '\n';
    }
  } catch {}

  context += '── Data Source Rules ──\n';
  context += 'Revenue/Actuals: ALWAYS from Guesty (source of truth for real bookings and money)\n';
  context += 'Recommended pricing: From PriceLabs dynamic pricing engine\n';
  context += 'Live calendar prices: From Guesty calendar (what guests actually see)\n';
  context += 'Market benchmarks: Aggregated from our own portfolio actual performance\n';
  context += 'Never mix PriceLabs recommended prices with Guesty actual revenue in calculations.\n\n';

  return json({ context, timestamp: new Date().toISOString() });
}


async function getMonthlyActuals(env) {
  const { results } = await env.DB.prepare(`SELECT ma.*, p.name as prop_name, p.address as prop_address, p.unit_number, p.city, p.state FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id ORDER BY ma.month DESC, p.address`).all();
  return json({ actuals: results });
}

async function getPortfolioActuals(env) {
  try {
    const now = new Date();
    const currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const thisYear = now.getFullYear() + '-01';
    const lastYear = (now.getFullYear() - 1) + '-01';
    const lastYearEnd = (now.getFullYear() - 1) + '-12';
    // Only count non-research, non-managed properties that are linked
    const ytd = await env.DB.prepare(`SELECT SUM(ma.total_revenue) as rev, SUM(ma.booked_nights) as nights, SUM(ma.available_nights) as avail, SUM(ma.host_payout) as payout, COUNT(DISTINCT ma.property_id) as props, COUNT(*) as month_entries FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE ma.month >= ? AND ma.month <= ? AND (p.is_research != 1 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL)`).bind(thisYear, currentMonth).first();
    const ly = await env.DB.prepare(`SELECT SUM(ma.total_revenue) as rev, SUM(ma.booked_nights) as nights, SUM(ma.available_nights) as avail, SUM(ma.host_payout) as payout, COUNT(DISTINCT ma.property_id) as props, COUNT(*) as month_entries FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE ma.month >= ? AND ma.month <= ? AND (p.is_research != 1 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL)`).bind(lastYear, lastYearEnd).first();
    return {
      ytd_revenue: Math.round(ytd?.rev || 0),
      ytd_payout: Math.round(ytd?.payout || 0),
      ytd_occ: ytd?.avail > 0 ? Math.round((ytd?.nights || 0) / ytd.avail * 100) : 0,
      ytd_adr: ytd?.nights > 0 ? Math.round((ytd?.rev || 0) / ytd.nights) : 0,
      ytd_properties: ytd?.props || 0,
      ytd_months: ytd?.month_entries || 0,
      last_year_revenue: Math.round(ly?.rev || 0),
      last_year_payout: Math.round(ly?.payout || 0),
      last_year_occ: ly?.avail > 0 ? Math.round((ly?.nights || 0) / ly.avail * 100) : 0,
      last_year_properties: ly?.props || 0,
      source: 'Guesty monthly_actuals',
      period_ytd: thisYear + ' to ' + currentMonth,
      period_ly: lastYear + ' to ' + lastYearEnd,
    };
  } catch { return null; }
}

function getPriceLabsCustomizationsForPrompt(property) {
  // Format stored PriceLabs customization rules for AI context
  if (!property.pl_customizations_json) return '';
  try {
    const rules = JSON.parse(property.pl_customizations_json);
    if (!rules || Object.keys(rules).length === 0) return '';
    let ctx = '\nCURRENT PRICELABS CUSTOMIZATIONS (what is already configured — your recommendations should reference these):\n';
    if (rules.group_name) ctx += '  Group: ' + rules.group_name + '\n';
    if (rules.demand_sensitivity) ctx += '  Demand Factor Sensitivity: ' + rules.demand_sensitivity + '\n';
    if (rules.last_minute) ctx += '  Last Minute Discount: ' + rules.last_minute + '\n';
    if (rules.far_out_premium) ctx += '  Far Out Premium: ' + rules.far_out_premium + '\n';
    if (rules.booking_recency) ctx += '  Booking Recency Factor: ' + rules.booking_recency + '\n';
    if (rules.weekly_discount) ctx += '  Weekly Discount: ' + rules.weekly_discount + '\n';
    if (rules.monthly_discount) ctx += '  Monthly Discount: ' + rules.monthly_discount + '\n';
    if (rules.weekend_days) ctx += '  Weekend Days: ' + rules.weekend_days + '\n';
    if (rules.occupancy_adjustment) ctx += '  Occupancy Based Adjustment: ' + rules.occupancy_adjustment + '\n';
    if (rules.portfolio_occupancy) ctx += '  Portfolio Occupancy Profile: ' + rules.portfolio_occupancy + '\n';
    if (rules.orphan_day) ctx += '  Orphan Day Pricing: ' + rules.orphan_day + '\n';
    if (rules.min_stay_rules) ctx += '  Min Stay Rules: ' + rules.min_stay_rules + '\n';
    if (rules.seasonal_profile) ctx += '  Seasonal Profile: ' + rules.seasonal_profile + '\n';
    if (rules.day_of_week) ctx += '  Day of Week Adjustments: ' + rules.day_of_week + '\n';
    if (rules.notes) ctx += '  Manager Notes: ' + rules.notes + '\n';
    ctx += '  IMPORTANT: When recommending PriceLabs changes, be SPECIFIC — reference the exact customization name (e.g., "Change Demand Factor Sensitivity from Moderately Conservative to Aggressive") and explain WHY for this property specifically vs the current group setting.\n';
    return ctx;
  } catch { return ''; }
}

async function getMarketAndTrendContextForPrompt(propertyId, property, env) {
  // Enriches AI prompts with market profile data, performance trends, algo targets,
  // platform presence, and one-time expenses — data that was previously invisible to AI.
  let context = '';
  const city = property.city, state = property.state;

  try {
    // ── 1. Market Profile (STR landscape, demographics, demand drivers) ──────
    if (city && state) {
      const mp = await env.DB.prepare(
        `SELECT str_listing_count, str_avg_adr, str_median_adr, str_avg_occupancy,
                str_avg_rating, str_superhost_pct, str_bedroom_mix, str_property_type_mix,
                ltr_avg_rent, ltr_listing_count, population, median_income, median_home_value,
                top_employers, tourism_drivers, str_regulations, demand_drivers, ai_summary,
                snapshot_date
         FROM market_profiles WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)
         ORDER BY snapshot_date DESC LIMIT 1`
      ).bind(city, state).first();

      if (mp) {
        context += '\nMARKET PROFILE (' + city + ', ' + state + '):\n';
        if (mp.str_listing_count) context += 'STR landscape: ' + mp.str_listing_count + ' active listings | Avg ADR $' + Math.round(mp.str_avg_adr || 0) + '/nt | Median ADR $' + Math.round(mp.str_median_adr || 0) + '/nt | Avg occupancy ' + Math.round((mp.str_avg_occupancy || 0) * 100) + '%\n';
        if (mp.str_avg_rating) context += 'Market quality: Avg rating ' + mp.str_avg_rating + ' | ' + Math.round(mp.str_superhost_pct || 0) + '% superhosts\n';
        if (mp.str_bedroom_mix) context += 'Bedroom mix: ' + mp.str_bedroom_mix + '\n';
        if (mp.str_property_type_mix) context += 'Property types: ' + mp.str_property_type_mix + '\n';
        if (mp.ltr_avg_rent) context += 'LTR comparison: Avg rent $' + Math.round(mp.ltr_avg_rent) + '/mo (' + (mp.ltr_listing_count || 0) + ' listings)\n';
        if (mp.population || mp.median_income) context += 'Demographics: ' + (mp.population ? 'Pop ' + mp.population.toLocaleString() : '') + (mp.median_income ? ' | Median income $' + mp.median_income.toLocaleString() : '') + (mp.median_home_value ? ' | Median home $' + mp.median_home_value.toLocaleString() : '') + '\n';
        if (mp.demand_drivers) context += 'Demand drivers: ' + mp.demand_drivers + '\n';
        if (mp.tourism_drivers) context += 'Tourism: ' + mp.tourism_drivers + '\n';
        if (mp.str_regulations) context += 'STR regulations: ' + mp.str_regulations + '\n';
        if (mp.ai_summary) context += 'Market summary: ' + (mp.ai_summary.length > 400 ? mp.ai_summary.substring(0, 400) + '...' : mp.ai_summary) + '\n';
        context += 'USE THIS: Position this property relative to the market. If priced above market avg ADR, justify with amenities/quality. If below, explain the opportunity.\n';
      }
    }
  } catch {}

  try {
    // ── 2. Performance Trend (snapshots over time — is property improving?) ──
    const { results: snapshots } = await env.DB.prepare(
      `SELECT snapshot_date, blended_adr, occupancy_30d, market_occ_30d,
              est_monthly_revenue, est_monthly_expenses, est_monthly_net
       FROM performance_snapshots WHERE property_id = ?
       ORDER BY snapshot_date DESC LIMIT 6`
    ).bind(propertyId).all();

    if (snapshots && snapshots.length >= 2) {
      context += '\nPERFORMANCE TREND (last ' + snapshots.length + ' snapshots):\n';
      const latest = snapshots[0], oldest = snapshots[snapshots.length - 1];
      const adrChange = (latest.blended_adr || 0) - (oldest.blended_adr || 0);
      const netChange = (latest.est_monthly_net || 0) - (oldest.est_monthly_net || 0);

      snapshots.reverse().forEach(s => {
        context += '  ' + s.snapshot_date + ': $' + Math.round(s.blended_adr || 0) + ' ADR | ' + (s.occupancy_30d || '?') + ' occ' + (s.market_occ_30d ? ' (mkt ' + s.market_occ_30d + ')' : '') + ' | Net $' + Math.round(s.est_monthly_net || 0) + '/mo\n';
      });

      if (adrChange > 0) context += 'TREND: ADR improving (+$' + Math.round(adrChange) + '/nt over period). ';
      else if (adrChange < 0) context += 'TREND: ADR declining (-$' + Math.abs(Math.round(adrChange)) + '/nt over period). ';
      if (netChange > 0) context += 'Net income improving (+$' + Math.round(netChange) + '/mo).\n';
      else if (netChange < 0) context += 'Net income declining (-$' + Math.abs(Math.round(netChange)) + '/mo). Investigate cause.\n';
      else context += '\n';
    }
  } catch {}

  try {
    // ── 3. Algo Template / Pricing Targets ──────────────────────────────────
    const override = await env.DB.prepare(
      `SELECT ao.*, at.name as template_name, at.occupancy_target, at.weekend_premium,
              at.peak_season_markup, at.low_season_discount, at.min_rate, at.max_rate,
              at.last_minute_discount_pct, at.orphan_day_discount_pct
       FROM property_algo_overrides ao
       LEFT JOIN algo_templates at ON ao.template_id = at.id
       WHERE ao.property_id = ?`
    ).bind(propertyId).first();

    if (override) {
      context += '\nPRICING ALGORITHM TARGETS:\n';
      if (override.template_name) context += 'Template: "' + override.template_name + '"\n';
      const occTarget = override.occupancy_target_override || override.occupancy_target;
      if (occTarget) context += 'Occupancy target: ' + Math.round(occTarget * 100) + '%\n';
      if (override.weekend_premium) context += 'Weekend premium: +' + Math.round(override.weekend_premium * 100) + '%\n';
      if (override.peak_season_markup) context += 'Peak season markup: +' + Math.round(override.peak_season_markup * 100) + '%\n';
      if (override.low_season_discount) context += 'Low season discount: -' + Math.round(override.low_season_discount * 100) + '%\n';
      if (override.min_rate) context += 'Rate floor: $' + override.min_rate + '/nt\n';
      if (override.max_rate) context += 'Rate ceiling: $' + override.max_rate + '/nt\n';
      if (override.last_minute_discount_pct) context += 'Last-minute discount: ' + override.last_minute_discount_pct + '%\n';
      if (override.orphan_day_discount_pct) context += 'Orphan day discount: ' + override.orphan_day_discount_pct + '%\n';
      context += 'IMPORTANT: Your recommended pricing MUST respect the min/max rate boundaries if set. Align seasonal adjustments with the peak/low season markups already configured.\n';
    }
  } catch {}

  try {
    // ── 4. Listing Content (description, photos — for quality assessment) ────
    const gl = await env.DB.prepare(
      `SELECT listing_description, listing_pictures_json, listing_thumbnail, listing_name
       FROM guesty_listings WHERE property_id = ?`
    ).bind(propertyId).first();

    if (gl) {
      var contentIssues = [];
      var contentStrengths = [];
      var photoCount = 0;
      if (gl.listing_pictures_json) {
        try { photoCount = JSON.parse(gl.listing_pictures_json).length; } catch {}
      }
      if (gl.listing_thumbnail) photoCount = Math.max(photoCount, 1);

      if (photoCount > 0) {
        context += '\nLISTING CONTENT:\n';
        context += 'Photos: ' + photoCount + (photoCount < 15 ? ' (LOW — listings with 20+ photos get 40% more engagement)' : photoCount < 25 ? ' (adequate)' : ' (excellent)') + '\n';
        if (photoCount < 15) contentIssues.push('Too few photos (' + photoCount + ') — add more, especially of bedrooms, kitchen, bathroom, outdoor spaces');
        else contentStrengths.push(photoCount + ' photos');
      } else {
        contentIssues.push('No listing photos found — critical for booking conversion');
      }

      if (gl.listing_description) {
        var descLen = gl.listing_description.length;
        context += 'Description: ' + descLen + ' chars';
        if (descLen < 200) { context += ' (SHORT — expand with amenity highlights, neighborhood info, guest experience details)\n'; contentIssues.push('Description too short (' + descLen + ' chars)'); }
        else if (descLen < 500) { context += ' (adequate but could be richer)\n'; }
        else { context += ' (good length)\n'; contentStrengths.push('Detailed description'); }
        context += 'Current description: "' + gl.listing_description.substring(0, 300) + (descLen > 300 ? '...' : '') + '"\n';
        context += 'EVALUATE: Does this description highlight the property\'s best features? Does it mention nearby attractions, unique amenities, or the guest experience? Suggest specific improvements.\n';
      } else {
        contentIssues.push('No listing description captured — sync Guesty listings to pull it');
      }

      if (contentIssues.length > 0) {
        context += 'LISTING ISSUES TO ADDRESS: ' + contentIssues.join(' | ') + '\n';
      }
    }
  } catch {}

  try {
    // ── 5. Platform Presence (where is this property listed?) ────────────────
    const { results: platforms } = await env.DB.prepare(
      `SELECT platform, nightly_rate, cleaning_fee, rating, review_count, min_nights,
              superhost, listing_status, last_scraped
       FROM property_platforms WHERE property_id = ? ORDER BY platform`
    ).bind(propertyId).all();

    if (platforms && platforms.length > 0) {
      context += '\nPLATFORM PRESENCE:\n';
      platforms.forEach(p => {
        context += '  ' + (p.platform || 'Unknown') + ': $' + (p.nightly_rate || '?') + '/nt' +
          (p.cleaning_fee ? ' + $' + p.cleaning_fee + ' clean' : '') +
          (p.rating ? ' | ' + p.rating + ' rating' : '') +
          (p.review_count ? ' (' + p.review_count + ' reviews)' : '') +
          (p.min_nights ? ' | min ' + p.min_nights + 'nt' : '') +
          (p.superhost ? ' | Superhost' : '') +
          (p.listing_status ? ' [' + p.listing_status + ']' : '') + '\n';
      });
      if (platforms.length === 1) context += 'NOTE: Only listed on 1 platform. Multi-platform distribution could increase occupancy and reduce channel dependency.\n';
      // Check for rate parity issues
      const rates = platforms.filter(p => p.nightly_rate > 0).map(p => p.nightly_rate);
      if (rates.length > 1) {
        const maxDiff = Math.max(...rates) - Math.min(...rates);
        if (maxDiff > 15) context += 'WARNING: $' + Math.round(maxDiff) + ' rate difference across platforms. Most OTAs penalize rate disparity. Consider aligning base rates.\n';
      }
    }
  } catch {}

  try {
    // ── 6. One-Time Expenses / Capital Improvements ─────────────────────────
    const { results: expenses } = await env.DB.prepare(
      `SELECT name, amount, category, date_incurred, notes
       FROM property_expenses WHERE property_id = ? ORDER BY date_incurred DESC LIMIT 10`
    ).bind(propertyId).all();

    if (expenses && expenses.length > 0) {
      const totalExpenses = expenses.reduce((a, e) => a + (e.amount || 0), 0);
      context += '\nCAPITAL IMPROVEMENTS & ONE-TIME COSTS ($' + Math.round(totalExpenses).toLocaleString() + ' total):\n';
      expenses.forEach(e => {
        context += '  ' + (e.name || 'Expense') + ': $' + Math.round(e.amount || 0).toLocaleString() +
          (e.category && e.category !== 'other' ? ' [' + e.category + ']' : '') +
          (e.date_incurred ? ' (' + e.date_incurred + ')' : '') +
          (e.notes ? ' — ' + e.notes.substring(0, 80) : '') + '\n';
      });
      // Check for recent renovations that justify premium pricing
      const sixMonthsAgo = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0];
      const recentUpgrades = expenses.filter(e => e.date_incurred && e.date_incurred >= sixMonthsAgo && (e.amount || 0) > 500);
      if (recentUpgrades.length > 0) {
        context += 'RECENT UPGRADES: ' + recentUpgrades.map(e => e.name + ' ($' + Math.round(e.amount).toLocaleString() + ')').join(', ') + ' — these justify premium positioning vs similar listings without upgrades.\n';
      }
    }
  } catch {}

  return context;
}

async function getGuestIntelForPrompt(propertyId, city, state, env) {
  // PRIVACY: This function ONLY returns aggregate statistics — never individual guest names,
  // emails, phone numbers, confirmation codes, or any personally identifiable information.
  // All data is anonymized counts, averages, and percentages.
  const LIVE = `${LIVE_STATUS_SQL}`;
  let context = '';
  try {
    // Per-property guest stats (if property_id known)
    if (propertyId) {
      const propGuests = await env.DB.prepare(`SELECT COUNT(DISTINCT guest_id) as guests, COUNT(*) as stays, SUM(accommodation_fare) as rev, AVG(nights_count) as avg_nights, AVG(guest_count) as avg_group, SUM(CASE WHEN has_pets = 1 THEN 1 ELSE 0 END) as pet_stays FROM guesty_reservations WHERE property_id = ? AND ${LIVE}`).bind(propertyId).first();
      if (propGuests && propGuests.stays > 0) {
        context += '\nGUEST INTELLIGENCE (this property):\n';
        context += 'Total stays: ' + propGuests.stays + ' | Unique guests: ' + propGuests.guests + ' | Revenue: $' + Math.round(propGuests.rev || 0).toLocaleString() + '\n';
        context += 'Avg stay: ' + Math.round((propGuests.avg_nights || 0) * 10) / 10 + ' nights | Avg group: ' + Math.round((propGuests.avg_group || 0) * 10) / 10 + ' guests\n';
        if (propGuests.pet_stays > 0) context += 'Pet stays: ' + propGuests.pet_stays + ' (' + Math.round(propGuests.pet_stays / propGuests.stays * 100) + '% of bookings) — pet-friendly pricing applicable\n';

        // Returning guests for this property
        const returning = await env.DB.prepare(`SELECT COUNT(*) as c FROM (SELECT guest_id, COUNT(*) as sc FROM guesty_reservations WHERE property_id = ? AND ${LIVE} AND guest_id IS NOT NULL GROUP BY guest_id HAVING sc > 1)`).bind(propertyId).first();
        if (returning && returning.c > 0) context += 'Returning guests: ' + returning.c + ' (' + Math.round(returning.c / propGuests.guests * 100) + '% return rate)\n';

        // Stay length distribution
        const { results: dist } = await env.DB.prepare(`SELECT CASE WHEN nights_count <= 2 THEN 'Weekend' WHEN nights_count <= 7 THEN 'Week' WHEN nights_count <= 30 THEN 'Monthly' ELSE 'Long-term' END as bucket, COUNT(*) as ct, ROUND(AVG(accommodation_fare)) as avg_rev FROM guesty_reservations WHERE property_id = ? AND ${LIVE} GROUP BY bucket ORDER BY ct DESC`).bind(propertyId).all();
        if (dist && dist.length > 0) {
          context += 'Stay patterns: ' + dist.map(d => d.bucket + ' ' + d.ct + ' stays ($' + (d.avg_rev || 0) + ' avg)').join(', ') + '\n';
        }

        // Top channels for this property
        const { results: chans } = await env.DB.prepare(`SELECT channel, COUNT(*) as ct, SUM(accommodation_fare) as rev FROM guesty_reservations WHERE property_id = ? AND channel IS NOT NULL AND ${LIVE} GROUP BY channel ORDER BY rev DESC LIMIT 4`).bind(propertyId).all();
        if (chans && chans.length > 0) {
          context += 'Channels: ' + chans.map(c => c.channel + ' ' + c.ct + ' bookings ($' + Math.round(c.rev || 0).toLocaleString() + ')').join(', ') + '\n';
        }

        // Demand segments for this property
        const { results: propSegs } = await env.DB.prepare(`SELECT demand_segment, COUNT(*) as ct, SUM(accommodation_fare) as rev, AVG(nights_count) as avg_n FROM guesty_reservations WHERE property_id = ? AND demand_segment IS NOT NULL AND ${LIVE} GROUP BY demand_segment ORDER BY rev DESC`).bind(propertyId).all();
        if (propSegs && propSegs.length > 0) {
          context += 'Demand segments: ' + propSegs.map(s => s.demand_segment.replace(/_/g, ' ') + ' ' + s.ct + ' bookings ($' + Math.round(s.rev || 0).toLocaleString() + ', ' + Math.round(s.avg_n || 0) + ' avg nights)').join(', ') + '\n';
          context += 'INSIGHT: Target the highest-revenue segments in your pricing strategy. Adjust minimum stays, pricing tiers, and marketing to attract more of your most profitable guest types.\n';
        }
      }
    }

    // Portfolio-wide channel performance
    const { results: allChannels } = await env.DB.prepare(`SELECT channel, SUM(reservations) as bookings, ROUND(AVG(avg_adr)) as adr, ROUND(AVG(avg_nights),1) as nights, ROUND(AVG(cancel_rate)) as cancel_pct FROM channel_intelligence WHERE period = 'all_time' GROUP BY channel ORDER BY SUM(total_revenue) DESC LIMIT 5`).all();
    if (allChannels && allChannels.length > 0) {
      context += '\nCHANNEL PERFORMANCE (portfolio-wide):\n';
      allChannels.forEach(c => { context += c.channel + ': ' + c.bookings + ' bookings, $' + c.adr + ' ADR, ' + c.nights + ' avg nights, ' + c.cancel_pct + '% cancel rate\n'; });
    }

    // Portfolio guest profile summary
    const guestSummary = await env.DB.prepare(`SELECT COUNT(DISTINCT guest_id) as total_guests, SUM(CASE WHEN has_pets = 1 THEN 1 ELSE 0 END) as pet_stays, ROUND(AVG(guest_count),1) as avg_group FROM guesty_reservations WHERE ${LIVE}`).first();
    const returningAll = await env.DB.prepare(`SELECT COUNT(*) as c FROM (SELECT guest_id FROM guesty_reservations WHERE ${LIVE} AND guest_id IS NOT NULL GROUP BY guest_id HAVING COUNT(*) > 1)`).first();
    if (guestSummary && guestSummary.total_guests > 0) {
      context += '\nPORTFOLIO GUEST PROFILE:\n';
      context += 'Total unique guests: ' + guestSummary.total_guests + ' | Returning: ' + (returningAll?.c || 0) + ' (' + Math.round((returningAll?.c || 0) / guestSummary.total_guests * 100) + '%)\n';
      context += 'Avg group size: ' + (guestSummary.avg_group || 0) + ' | Pet bookings: ' + (guestSummary.pet_stays || 0) + '\n';
    }
  } catch (e) { context += '\n[Guest intelligence unavailable: ' + e.message + ']\n'; }
  return context;
}

async function getPortfolioContextForPrompt(property, env) {
  // Builds a read-only portfolio awareness block for AI prompts.
  // PURPOSE: Give the AI market intelligence from sibling/nearby units so it can
  // calibrate recommendations — NOT to constrain pricing. Each property is priced independently.
  const lines = [];
  const pid = property.id;

  try {
    // ── 1. Same-building siblings (parent_id match) ──────────────────────────
    if (property.parent_id) {
      const parent = await env.DB.prepare(
        `SELECT address, unit_number, property_type FROM properties WHERE id = ?`
      ).bind(property.parent_id).first();

      const { results: siblings } = await env.DB.prepare(
        `SELECT p.id, p.unit_number, p.bedrooms, p.bathrooms, p.sqft, p.listing_status,
                pl.base_price as pl_base, pl.min_price as pl_min, pl.max_price as pl_max,
                pl.recommended_base_price as pl_rec, pl.occupancy_next_30 as occ_30,
                pl.market_occupancy_next_30 as mkt_occ_30, pl.group_name as pl_group,
                (SELECT base_nightly_rate FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as strat_rate,
                (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as strat_monthly,
                (SELECT AVG(total_revenue) FROM monthly_actuals WHERE property_id = p.id) as actual_monthly_avg,
                (SELECT AVG(occupancy_pct) FROM monthly_actuals WHERE property_id = p.id) as actual_occ_avg,
                (SELECT AVG(avg_nightly_rate) FROM monthly_actuals WHERE property_id = p.id) as actual_adr
         FROM properties p
         LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
         WHERE p.parent_id = ? AND p.id != ?
         ORDER BY p.unit_number`
      ).bind(property.parent_id, pid).all();

      if (siblings.length > 0) {
        lines.push('');
        lines.push('PORTFOLIO CONTEXT — BUILDING SIBLINGS (for awareness only — price this unit on its own merits):');
        lines.push('Building: ' + (parent?.address || 'same building') + ' | This unit: ' + (property.unit_number || '?') + ' (' + (property.bedrooms || '?') + 'BR/' + (property.bathrooms || '?') + 'BA' + (property.sqft ? ' ' + property.sqft + 'sqft' : '') + ')');
        lines.push('');

        for (const s of siblings) {
          const unitDesc = 'Unit ' + (s.unit_number || '?') + ' | ' +
            (s.bedrooms || '?') + 'BR/' + (s.bathrooms || '?') + 'BA' +
            (s.sqft ? ' ' + s.sqft + 'sqft' : '') +
            (s.listing_status ? ' [' + s.listing_status + ']' : '');

          const plLine = s.pl_base
            ? 'PriceLabs: base $' + s.pl_base + '/nt | min $' + (s.pl_min || '?') + ' | max $' + (s.pl_max || '?') +
              (s.pl_rec && s.pl_rec !== s.pl_base ? ' | PL rec $' + s.pl_rec + '/nt' : '') +
              (s.occ_30 ? ' | occ 30d ' + s.occ_30 + (s.mkt_occ_30 ? ' (mkt ' + s.mkt_occ_30 + ')' : '') : '') +
              (s.pl_group ? ' | group "' + s.pl_group + '"' : '')
            : 'PriceLabs: not linked';

          const actualLine = s.actual_monthly_avg
            ? 'Actuals: $' + Math.round(s.actual_adr || 0) + '/nt ADR | ' +
              Math.round((s.actual_occ_avg || 0) * 100) + '% occ avg | $' + Math.round(s.actual_monthly_avg) + '/mo avg revenue'
            : (s.strat_rate ? 'Strategy: $' + s.strat_rate + '/nt | proj $' + Math.round(s.strat_monthly || 0) + '/mo' : 'No data yet');

          lines.push('  • ' + unitDesc);
          lines.push('    ' + plLine);
          lines.push('    ' + actualLine);
        }

        // PriceLabs group context — if siblings share a group name
        const groupNames = [...new Set(siblings.filter(s => s.pl_group).map(s => s.pl_group))];
        if (groupNames.length > 0) {
          lines.push('');
          lines.push('  PriceLabs Group Rule note: Siblings in group(s) "' + groupNames.join('", "') + '". Group rules in PriceLabs apply globally to all members — this unit may inherit min/max/gap-filling rules set at the group level. The API does not expose individual rule details; check your PriceLabs dashboard for group-level overrides that may affect this unit.');
        }

        lines.push('');
        lines.push('  → Use sibling data to calibrate market ceiling and occupancy expectations for this building.');
        lines.push('  → DO NOT copy sibling rates. If this unit is larger/smaller/better/worse, price accordingly and explain why.');
        lines.push('  → If multiple units show low occupancy simultaneously, consider whether self-competition is a factor.');
      }
    }

    // ── 2. Nearby managed properties (within ~0.5 miles, not same building) ─
    if (property.latitude && property.longitude) {
      // Haversine approx: 0.5 miles ≈ 0.00725 degrees lat, ~0.009 degrees lng at US latitudes
      const latDelta = 0.0073;
      const lngDelta = 0.009;
      const { results: nearby } = await env.DB.prepare(
        `SELECT p.id, p.address, p.unit_number, p.bedrooms, p.bathrooms, p.sqft,
                p.latitude, p.longitude, p.listing_status, p.rental_type,
                pl.base_price as pl_base, pl.group_name as pl_group,
                pl.occupancy_next_30 as occ_30, pl.market_occupancy_next_30 as mkt_occ_30,
                (SELECT AVG(total_revenue) FROM monthly_actuals WHERE property_id = p.id) as actual_monthly,
                (SELECT AVG(avg_nightly_rate) FROM monthly_actuals WHERE property_id = p.id) as actual_adr,
                (SELECT AVG(occupancy_pct) FROM monthly_actuals WHERE property_id = p.id) as actual_occ
         FROM properties p
         LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
         WHERE p.id != ?
           AND (p.parent_id IS NULL OR p.parent_id != ?)
           AND p.latitude BETWEEN ? AND ?
           AND p.longitude BETWEEN ? AND ?
           AND p.is_research = 0
         ORDER BY ABS(p.latitude - ?) + ABS(p.longitude - ?) ASC
         LIMIT 5`
      ).bind(
        pid, property.parent_id || -1,
        property.latitude - latDelta, property.latitude + latDelta,
        property.longitude - lngDelta, property.longitude + lngDelta,
        property.latitude, property.longitude
      ).all();

      if (nearby.length > 0) {
        lines.push('');
        lines.push('PORTFOLIO CONTEXT — NEARBY MANAGED PROPERTIES (within ~0.5 miles, for awareness only):');
        for (const n of nearby) {
          // rough distance in miles
          const dlat = (n.latitude - property.latitude) * 69;
          const dlng = (n.longitude - property.longitude) * 54.6;
          const distMi = Math.round(Math.sqrt(dlat * dlat + dlng * dlng) * 10) / 10;

          const desc = (n.address || 'nearby') + (n.unit_number ? ' #' + n.unit_number : '') +
            ' | ' + (n.bedrooms || '?') + 'BR | ' + (distMi || '<0.1') + 'mi away' +
            (n.listing_status ? ' [' + n.listing_status + ']' : '') +
            (n.rental_type === 'ltr' ? ' [LTR]' : ' [STR]');

          const revLine = n.actual_monthly
            ? '$' + Math.round(n.actual_adr || 0) + '/nt ADR | ' + Math.round((n.actual_occ || 0) * 100) + '% occ | $' + Math.round(n.actual_monthly) + '/mo actual'
            : n.pl_base ? 'PriceLabs base $' + n.pl_base + '/nt' + (n.occ_30 ? ' | occ ' + n.occ_30 : '') : 'No revenue data';

          lines.push('  • ' + desc);
          lines.push('    ' + revLine);
        }
        lines.push('');
        lines.push('  → Nearby properties compete for the same guests. If you are priced significantly higher with similar specs, explain the premium. If occupancy is low across multiple nearby properties, this may indicate a market-level issue rather than a pricing one.');
      }
    }

  } catch (e) {
    // Non-fatal — portfolio context is bonus intelligence, not required
    lines.push('\n[Portfolio context unavailable: ' + e.message + ']');
  }

  return lines.join('\n');
}

async function getGuestyActualsForPrompt(propertyId, city, state, env) {
  let result = '';

  // Current month key — used to exclude partial month from averages
  const now = new Date();
  const currentMonth = now.getUTCFullYear() + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = now.getUTCDate();
  const daysInCurrentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();

  try {
    // Pull all completed months (excluding current partial month from aggregates)
    // monthly_actuals is only written by processGuestyData which uses confirmed+closed only — safe to read directly
    const { results: allActuals } = await env.DB.prepare(
      `SELECT month, booked_nights, available_nights, occupancy_pct, total_revenue, avg_nightly_rate, num_reservations, avg_stay_length
       FROM monthly_actuals WHERE property_id = ? ORDER BY month`
    ).bind(propertyId).all();

    if (allActuals && allActuals.length > 0) {
      // Separate completed months from current partial month
      const completedMonths = allActuals.filter(m => m.month < currentMonth);
      const partialMonth = allActuals.find(m => m.month === currentMonth);

      if (completedMonths.length > 0) {
        // Compute averages ONLY from completed months — prevents partial month from dragging down stats
        const totalRev = completedMonths.reduce((a, m) => a + (m.total_revenue || 0), 0);
        const totalNights = completedMonths.reduce((a, m) => a + (m.booked_nights || 0), 0);
        const totalAvail = completedMonths.reduce((a, m) => a + (m.available_nights || 30), 0);
        const avgMonthlyRev = Math.round(totalRev / completedMonths.length);
        const avgOcc = totalAvail > 0 ? Math.round(totalNights / totalAvail * 100) : 0;
        const avgADR = totalNights > 0 ? Math.round(totalRev / totalNights) : 0;

        result += `ACTUAL REVENUE (Guesty, ${completedMonths.length} completed months): `;
        result += `Avg $${avgMonthlyRev}/mo | Overall ${avgOcc}% occupancy | $${avgADR} ADR\n`;

        // Last 12 completed months — labeled clearly, never includes current partial
        const recent = completedMonths.slice(-12);
        result += 'Completed months: ' + recent.map(a =>
          `${a.month}: $${Math.round(a.total_revenue || 0)} (${Math.round((a.occupancy_pct || 0) * 100)}% occ, $${Math.round(a.avg_nightly_rate || 0)}/nt, ${a.num_reservations || 0} stays)`
        ).join(' | ') + '\n';
      }

      // Current partial month shown separately and explicitly flagged as incomplete
      if (partialMonth) {
        const partialOcc = Math.round((partialMonth.occupancy_pct || 0) * 100);
        result += `CURRENT MONTH (${currentMonth}, day ${dayOfMonth}/${daysInCurrentMonth} — PARTIAL, do NOT extrapolate as full-month performance): `;
        result += `$${Math.round(partialMonth.total_revenue || 0)} so far, ${partialMonth.booked_nights || 0} nights booked, ${partialOcc}% occ-to-date\n`;
      }
    }
  } catch (e) { syslog(env, 'error', 'getGuestyActualsForPrompt', 'L10707', e.message); }

  // Reservation-level booking patterns — ONLY confirmed+closed, matching processGuestyData filter
  // Read-only from guesty_reservations, never modifies any table
  try {
    // Stay length distribution
    const stayStats = await env.DB.prepare(
      `SELECT AVG(nights_count) as avg_nights, MIN(nights_count) as min_nights, MAX(nights_count) as max_nights,
              COUNT(*) as total_stays,
              SUM(CASE WHEN nights_count = 1 THEN 1 ELSE 0 END) as one_night,
              SUM(CASE WHEN nights_count BETWEEN 2 AND 3 THEN 1 ELSE 0 END) as two_three_night,
              SUM(CASE WHEN nights_count BETWEEN 4 AND 7 THEN 1 ELSE 0 END) as four_seven_night,
              SUM(CASE WHEN nights_count >= 8 THEN 1 ELSE 0 END) as long_stay
       FROM guesty_reservations
       WHERE property_id = ? AND ${LIVE_STATUS_SQL} AND nights_count > 0`
    ).bind(propertyId).first();

    if (stayStats && stayStats.total_stays > 0) {
      const avg = Math.round((stayStats.avg_nights || 0) * 10) / 10;
      const total = stayStats.total_stays;
      result += `BOOKING PATTERNS (${total} confirmed stays):\n`;
      result += `  Avg stay: ${avg} nights | Min: ${stayStats.min_nights} | Max: ${stayStats.max_nights}\n`;
      result += `  Stay length mix: 1-night ${Math.round(stayStats.one_night/total*100)}% | 2-3 nights ${Math.round(stayStats.two_three_night/total*100)}% | 4-7 nights ${Math.round(stayStats.four_seven_night/total*100)}% | 8+ nights ${Math.round(stayStats.long_stay/total*100)}%\n`;
      if (avg < 2.5) result += `  NOTE: Short avg stay (${avg}n) — minimum night requirement increase could meaningfully raise ADR and reduce turnover costs\n`;
      if (avg > 6) result += `  NOTE: Long avg stay (${avg}n) — guest experience and mid-stay service matter more than check-in/out optimization\n`;
    }

    // Channel revenue mix — confirmed+closed only, same as pipeline
    const { results: channelData } = await env.DB.prepare(
      `SELECT channel,
              COUNT(*) as stays,
              ROUND(AVG(host_payout),0) as avg_payout,
              ROUND(SUM(host_payout),0) as total_payout,
              ROUND(AVG(nights_count),1) as avg_nights,
              ROUND(AVG(CASE WHEN nights_count > 0 THEN accommodation_fare/nights_count ELSE 0 END),0) as avg_adr
       FROM guesty_reservations
       WHERE property_id = ? AND ${LIVE_STATUS_SQL} AND host_payout > 0
       GROUP BY channel ORDER BY total_payout DESC`
    ).bind(propertyId).all();

    if (channelData && channelData.length > 0) {
      const totalPayout = channelData.reduce((a, c) => a + (c.total_payout || 0), 0);
      result += 'CHANNEL MIX (by host payout):\n';
      for (const ch of channelData) {
        const share = totalPayout > 0 ? Math.round((ch.total_payout || 0) / totalPayout * 100) : 0;
        result += `  ${ch.channel || 'Unknown'}: ${ch.stays} stays (${share}% of revenue) | Avg payout $${ch.avg_payout}/stay | Avg ADR $${ch.avg_adr}/nt | Avg stay ${ch.avg_nights}n\n`;
      }
      // Flag if heavily concentrated in one channel (diversification risk)
      const topShare = totalPayout > 0 ? Math.round((channelData[0].total_payout || 0) / totalPayout * 100) : 0;
      if (channelData.length === 1 || topShare >= 85) {
        result += `  NOTE: ${topShare}% of revenue from single channel (${channelData[0].channel}) — listing on additional platforms could reduce dependency risk\n`;
      }
    }

    // Cancellation rate — uses all statuses for accurate rate, but DOES NOT mix revenue/nights data
    const cancelStats = await env.DB.prepare(
      `SELECT
         SUM(CASE WHEN ${LIVE_STATUS_SQL} THEN 1 ELSE 0 END) as confirmed_count,
         SUM(CASE WHEN LOWER(COALESCE(status,'')) IN ('canceled','cancelled') THEN 1 ELSE 0 END) as canceled_count
       FROM guesty_reservations WHERE property_id = ?`
    ).bind(propertyId).first();

    if (cancelStats && cancelStats.confirmed_count > 0) {
      const total = (cancelStats.confirmed_count || 0) + (cancelStats.canceled_count || 0);
      const cancelRate = total > 0 ? Math.round((cancelStats.canceled_count || 0) / total * 100) : 0;
      result += `CANCELLATIONS: ${cancelRate}% rate (${cancelStats.canceled_count || 0} cancelled of ${total} total requests)`;
      if (cancelRate > 15) result += ` — HIGH: consider stricter cancellation policy`;
      else if (cancelRate < 5) result += ` — LOW: flexible policy working well`;
      result += '\n';
    }

    // Guest count patterns — for upsell/capacity insights
    const guestStats = await env.DB.prepare(
      `SELECT ROUND(AVG(guest_count),1) as avg_guests, MAX(guest_count) as max_guests,
              SUM(CASE WHEN guest_count >= 4 THEN 1 ELSE 0 END) as large_groups,
              COUNT(*) as total
       FROM guesty_reservations
       WHERE property_id = ? AND ${LIVE_STATUS_SQL} AND guest_count > 0`
    ).bind(propertyId).first();

    if (guestStats && guestStats.total > 0 && guestStats.avg_guests > 0) {
      result += `GUEST PROFILE: Avg ${guestStats.avg_guests} guests | Max ${guestStats.max_guests} | Large groups (4+): ${Math.round((guestStats.large_groups||0)/guestStats.total*100)}% of stays\n`;
    }

  } catch (e) { syslog(env, 'error', 'getGuestyActualsForPrompt', 'L10791', e.message); }

  // Seasonality from market_seasonality (derived from all properties in this market, not just this one)
  try {
    if (city && state) {
      const { results: season } = await env.DB.prepare(
        `SELECT month_number, avg_adr, multiplier, avg_occupancy, sample_size
         FROM market_seasonality WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY month_number`
      ).bind(city, state).all();
      if (season && season.length >= 6) {
        const mn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const minSample = Math.min(...season.map(s => s.sample_size || 0));
        result += `MARKET SEASONALITY ${city}, ${state}`;
        if (minSample < 3) result += ` (limited sample — ${minSample} properties, treat as directional only)`;
        result += ':\n  ' + season.map(s =>
          `${mn[(s.month_number || 1) - 1]}: ${(s.multiplier || 1).toFixed(2)}x | $${Math.round(s.avg_adr || 0)}/nt | ${Math.round((s.avg_occupancy || 0) * 100)}% occ`
        ).join(' | ') + '\n';
      }
    }
  } catch (e) { syslog(env, 'error', 'getGuestyActualsForPrompt', 'L10810', e.message); }

  return result;
}

async function getMonthlyTargetsForPrompt(propertyId, property, env) {
  let result = '';
  try {
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const yr = new Date().getFullYear(); const daysInMonth = [31, new Date(yr, 2, 0).getDate(), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb: correct leap year calc

    // Get property costs
    let monthlyCost = 0;
    if (property.ownership_type === 'rental') {
      monthlyCost = property.monthly_rent_cost || 0;
    } else {
      monthlyCost = (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0);
    }
    monthlyCost += (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0);
    // Add services
    try { const svcSum = await env.DB.prepare(`SELECT SUM(monthly_cost) as total FROM property_services WHERE property_id = ?`).bind(propertyId).first(); monthlyCost += (svcSum?.total || 0); } catch {}

    if (monthlyCost <= 0) return '';

    const annualTarget = monthlyCost * 12 * 1.15; // costs + 15%

    // Get seasonality
    let seasonMult = {};
    let multSum = 0;
    if (property.city && property.state) {
      const { results: season } = await env.DB.prepare(`SELECT month_number, multiplier, avg_occupancy FROM market_seasonality WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY month_number`).bind(property.city, property.state).all();
      for (const s of (season || [])) { seasonMult[s.month_number] = { mult: s.multiplier || 1, occ: s.avg_occupancy || 0.4 }; multSum += (s.multiplier || 1); }
    }
    if (multSum === 0) { for (let i = 1; i <= 12; i++) { seasonMult[i] = { mult: 1, occ: 0.4 }; } multSum = 12; }

    // Get actual history for occupancy
    const { results: actuals } = await env.DB.prepare(`SELECT month, occupancy_pct, total_revenue FROM monthly_actuals WHERE property_id = ? ORDER BY month`).bind(propertyId).all();
    const occByMonth = {};
    for (const a of (actuals || [])) { const mn = parseInt(a.month.substring(5)); occByMonth[mn] = a.occupancy_pct || 0; }

    result = 'MONTHLY REVENUE TARGETS (you MUST align pricing strategy to hit these):\n';
    result += 'Monthly expenses: $' + Math.round(monthlyCost) + ' | Annual target: $' + Math.round(annualTarget) + ' (costs + 15% margin)\n';
    for (let mn = 1; mn <= 12; mn++) {
      const sm = seasonMult[mn] || { mult: 1, occ: 0.4 };
      const target = annualTarget * sm.mult / multSum;
      const occ = occByMonth[mn] || sm.occ || 0.4;
      const reqADR = occ > 0 ? Math.round(target / (daysInMonth[mn - 1] * occ)) : 0;
      result += monthNames[mn - 1] + ': target $' + Math.round(target) + ', need $' + reqADR + '/nt at ' + Math.round(occ * 100) + '% occ (' + sm.mult.toFixed(1) + 'x season)\n';
    }
    result += 'CRITICAL: Your base price and seasonal adjustments MUST be set so that each month can realistically hit its target. If the required ADR for a month seems unrealistic, suggest ways to increase occupancy or reduce costs instead.\n';
  } catch {}
  return result;
}

async function autoFetchAmenities(propertyId, env) {
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ?`).bind(propertyId).all();
  const { results: existingAmenities } = await env.DB.prepare(`SELECT a.name FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(propertyId).all();
  const existingNames = new Set(existingAmenities.map(a => a.name.toLowerCase()));

  // Get all known amenities from DB
  const { results: allAmenities } = await env.DB.prepare(`SELECT * FROM amenities`).all();
  const amenityMap = {};
  for (const a of allAmenities) amenityMap[a.name.toLowerCase()] = a;

  let foundAmenities = new Set();
  let sources = [];

  // Scrape platform listing pages for amenity mentions
  const urls = platforms.filter(p => p.listing_url).map(p => ({ url: p.listing_url, platform: p.platform }));
  if (property.listing_url) urls.push({ url: property.listing_url, platform: 'direct' });

  for (const u of urls.slice(0, 3)) {
    try {
      const resp = await fetch(u.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html' }, redirect: 'follow' });
      if (!resp.ok) continue;
      const html = (await resp.text()).toLowerCase();
      sources.push(u.platform);

      // Match known amenity names against page content
      for (const name in amenityMap) {
        if (html.includes(name) || html.includes(name.replace(/ /g, '-')) || html.includes(name.replace(/ /g, '_'))) {
          foundAmenities.add(name);
        }
      }
      // Common patterns
      const patterns = [
        [/(?:hot tub|jacuzzi|spa)/i, 'hot tub'], [/(?:swimming pool|pool access|private pool)/i, 'pool'],
        [/(?:ev charger|ev charging|electric vehicle)/i, 'ev charger'], [/(?:fire ?pit)/i, 'fire pit'],
        [/(?:game room|billiards|pool table)/i, 'game room'], [/(?:gym|fitness|workout)/i, 'gym'],
        [/(?:washer|laundry|washing machine)/i, 'washer/dryer'], [/(?:dishwasher)/i, 'dishwasher'],
        [/(?:pet[- ]?friendly|dogs? (?:allowed|welcome)|pets? (?:allowed|welcome))/i, 'pet friendly'],
        [/(?:wifi|wi-fi|high[- ]?speed internet)/i, 'wifi'], [/(?:parking|garage|driveway)/i, 'parking'],
        [/(?:air condition|central air|ac unit|a\/c)/i, 'air conditioning'],
        [/(?:fireplace|wood stove)/i, 'fireplace'], [/(?:balcony|patio|deck|porch)/i, 'patio/balcony'],
        [/(?:bbq|grill|barbecue)/i, 'bbq grill'], [/(?:coffee maker|keurig|nespresso)/i, 'coffee maker'],
        [/(?:smart tv|netflix|roku|streaming)/i, 'smart tv'], [/(?:keyless|smart lock|self check)/i, 'keyless entry'],
        [/(?:workspace|dedicated desk|work from home|office)/i, 'workspace'],
        [/(?:waterfront|lake view|ocean view|beach)/i, 'waterfront'], [/(?:mountain view|scenic view)/i, 'mountain view'],
      ];
      for (const [regex, name] of patterns) {
        if (regex.test(html)) foundAmenities.add(name);
      }
    } catch {}
  }

  // For research properties with no platforms, try a Google search
  if (urls.length === 0 && env.SEARCHAPI_KEY) {
    try {
      const q = property.address + ' ' + property.city + ' ' + property.state + ' amenities';
      const params = new URLSearchParams({ engine: 'google', q });
      await trackApiCall(env, 'searchapi', 'amenity_search', true);
      const resp = await fetch('https://www.searchapi.io/api/v1/search?' + params.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
      });
      if (resp.ok) {
        const data = await resp.json();
        const text = ((data.answer_box?.snippet || '') + ' ' + (data.organic_results || []).slice(0, 3).map(r => (r.snippet || '') + ' ' + (r.title || '')).join(' ')).toLowerCase();
        sources.push('google');
        for (const name in amenityMap) {
          if (text.includes(name)) foundAmenities.add(name);
        }
      }
    } catch {}
  }

  // Link found amenities to property
  let added = 0;
  for (const name of foundAmenities) {
    if (existingNames.has(name)) continue;
    const amenity = amenityMap[name];
    if (!amenity) continue;
    try {
      await env.DB.prepare(`INSERT OR IGNORE INTO property_amenities (property_id, amenity_id) VALUES (?, ?)`).bind(propertyId, amenity.id).run();
      added++;
    } catch {}
  }

  return json({
    found: Array.from(foundAmenities),
    added,
    already_had: existingNames.size,
    total: existingNames.size + added,
    sources,
    message: added > 0 ? 'Added ' + added + ' amenities from ' + sources.join(', ') : 'No new amenities found',
  });
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function getDashboard(env, uid) {
  const now = new Date();
  const thisMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const lastMonth = now.getMonth() === 0 ? (now.getFullYear() - 1) + '-12' : now.getFullYear() + '-' + String(now.getMonth()).padStart(2, '0');
  const lastYearMonth = (now.getFullYear() - 1) + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const today = now.toISOString().split('T')[0];
  const in14d = new Date(now.getTime() + 14 * 86400000).toISOString().split('T')[0];
  const in30d = new Date(now.getTime() + 30 * 86400000).toISOString().split('T')[0];

  const d = {};

  try {
    // 1. Portfolio summary
    const portfolioSQL = `SELECT
      COUNT(*) as total,
      SUM(CASE WHEN is_research = 1 THEN 1 ELSE 0 END) as research,
      SUM(CASE WHEN (is_research = 0 OR is_research IS NULL) AND (is_managed = 0 OR is_managed IS NULL) AND parent_id IS NULL THEN 1 ELSE 0 END) as non_research,
      SUM(CASE WHEN listing_status = 'active' AND (is_research = 0 OR is_research IS NULL) AND (is_managed = 0 OR is_managed IS NULL) THEN 1 ELSE 0 END) as active_status,
      SUM(CASE WHEN (listing_status IS NULL OR listing_status = '' OR listing_status = 'active') AND (is_research = 0 OR is_research IS NULL) AND (is_managed = 0 OR is_managed IS NULL) AND parent_id IS NULL THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN listing_status = 'inactive' AND (is_research = 0 OR is_research IS NULL) AND (is_managed = 0 OR is_managed IS NULL) THEN 1 ELSE 0 END) as inactive,
      SUM(CASE WHEN parent_id IS NOT NULL THEN 1 ELSE 0 END) as units,
      SUM(CASE WHEN (is_research = 0 OR is_research IS NULL) AND (is_managed = 0 OR is_managed IS NULL) THEN COALESCE(estimated_value, purchase_price, 0) ELSE 0 END) as total_value,
      SUM(CASE WHEN (is_research = 0 OR is_research IS NULL) AND (is_managed = 0 OR is_managed IS NULL) THEN COALESCE(purchase_price, 0) ELSE 0 END) as total_purchase,
      SUM(CASE WHEN is_managed = 1 OR ownership_type = 'managed' THEN 1 ELSE 0 END) as managed,
      SUM(CASE WHEN (is_managed = 0 OR is_managed IS NULL) AND (is_research = 0 OR is_research IS NULL) AND ownership_type = 'rental' AND parent_id IS NULL THEN 1 ELSE 0 END) as rented,
      SUM(CASE WHEN (is_managed = 0 OR is_managed IS NULL) AND (is_research = 0 OR is_research IS NULL) AND (ownership_type IS NULL OR ownership_type = '' OR ownership_type = 'purchased' OR ownership_type = 'owned') AND parent_id IS NULL THEN 1 ELSE 0 END) as owned
      FROM properties p`;
    const propSummary = uid
      ? await env.DB.prepare(portfolioSQL + ` WHERE (p.user_id = ? OR p.user_id IS NULL)`).bind(uid).first()
      : await env.DB.prepare(portfolioSQL).first();
    d.portfolio = propSummary || {};

    // Active listings (from Guesty + PriceLabs)
    try {
      const gl = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_listings`).first();
      const pl = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings`).first();
      d.portfolio.active_listings = (gl?.c || 0);
      d.portfolio.pl_listings = (pl?.c || 0);
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L10998', e.message); }

    // Portfolio financials — investment, equity, monthly costs
    try {
      const notManaged = `(is_managed = 0 OR is_managed IS NULL) AND (is_research = 0 OR is_research IS NULL)`;
      const finSQL = `SELECT
        SUM(CASE WHEN ${notManaged} THEN
          CASE WHEN parent_id IS NOT NULL THEN
            COALESCE(expense_electric, 0) + COALESCE(expense_gas, 0) + COALESCE(expense_water, 0) + COALESCE(expense_internet, 0) + COALESCE(expense_trash, 0) + COALESCE(expense_other, 0) + COALESCE(monthly_rent_cost, 0)
          ELSE
            COALESCE(monthly_mortgage, 0) + COALESCE(monthly_insurance, 0) + COALESCE(hoa_monthly, 0) + COALESCE(monthly_rent_cost, 0) + ROUND(COALESCE(annual_taxes, 0) / 12.0) + COALESCE(expense_electric, 0) + COALESCE(expense_gas, 0) + COALESCE(expense_water, 0) + COALESCE(expense_internet, 0) + COALESCE(expense_trash, 0) + COALESCE(expense_other, 0)
          END
        ELSE 0 END) as monthly_cost,
        SUM(CASE WHEN ${notManaged} AND parent_id IS NULL THEN COALESCE(loan_amount, 0) ELSE 0 END) as total_debt
        FROM properties p`;
      const finSummary = uid
        ? await env.DB.prepare(finSQL + ` WHERE (p.user_id = ? OR p.user_id IS NULL)`).bind(uid).first()
        : await env.DB.prepare(finSQL).first();
      // Add property_services costs (Guesty, PriceLabs, locks, etc.) — not included in the properties table
      let svcCostTotal = 0;
      try {
        const svcSum = await env.DB.prepare(`SELECT SUM(ps.monthly_cost) as total FROM property_services ps JOIN properties p ON ps.property_id = p.id WHERE ${notManaged.replace(/p\./g, 'p.')} AND (p.is_research != 1 OR p.is_research IS NULL)`).first();
        svcCostTotal = Math.round(svcSum?.total || 0);
      } catch (e) { syslog(env, 'error', 'getDashboard', 'L11018', e.message); }
      d.portfolio.monthly_cost = Math.round((finSummary?.monthly_cost || 0) + svcCostTotal);
      d.portfolio.total_debt = Math.round(finSummary?.total_debt || 0);
      d.portfolio.equity = Math.round((d.portfolio.total_value || 0) - (d.portfolio.total_purchase || 0));
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11022', e.message); }

    // 2. Monthly actuals — this month, last month, same month last year
    // CRITICAL: Exclude managed and research properties from portfolio revenue
    const revFilter = `ma.property_id IN (SELECT id FROM properties WHERE (is_managed = 0 OR is_managed IS NULL) AND (is_research != 1 OR is_research IS NULL))`;
    let thisMonthActuals;
    try {
      thisMonthActuals = await env.DB.prepare(`SELECT SUM(total_revenue) as rev, SUM(host_payout) as payout, SUM(booked_nights) as nights, SUM(available_nights) as avail, SUM(num_reservations) as bookings, SUM(elapsed_booked_nights) as elapsed_nights, MAX(elapsed_days) as elapsed_days FROM monthly_actuals ma WHERE month = ? AND ${revFilter}`).bind(thisMonth).first();
    } catch {
      // elapsed columns may not exist yet — fall back without them
      thisMonthActuals = await env.DB.prepare(`SELECT SUM(total_revenue) as rev, SUM(host_payout) as payout, SUM(booked_nights) as nights, SUM(available_nights) as avail, SUM(num_reservations) as bookings FROM monthly_actuals ma WHERE month = ? AND ${revFilter}`).bind(thisMonth).first();
    }
    const lastMonthActuals = await env.DB.prepare(`SELECT SUM(total_revenue) as rev, SUM(host_payout) as payout, SUM(booked_nights) as nights, SUM(available_nights) as avail FROM monthly_actuals ma WHERE month = ? AND ${revFilter}`).bind(lastMonth).first();
    const lastYearActuals = await env.DB.prepare(`SELECT SUM(total_revenue) as rev, SUM(host_payout) as payout, SUM(booked_nights) as nights, SUM(available_nights) as avail FROM monthly_actuals ma WHERE month = ? AND ${revFilter}`).bind(lastYearMonth).first();

    // YTD
    const ytdFrom = now.getFullYear() + '-01';
    const ytd = await env.DB.prepare(`SELECT SUM(total_revenue) as rev, SUM(host_payout) as payout, SUM(booked_nights) as nights, SUM(available_nights) as avail, COUNT(DISTINCT property_id) as props FROM monthly_actuals ma WHERE month >= ? AND month <= ? AND ${revFilter}`).bind(ytdFrom, thisMonth).first();

    d.revenue = {
      this_month: { rev: Math.round(thisMonthActuals?.rev || 0), payout: Math.round(thisMonthActuals?.payout || 0), nights: thisMonthActuals?.nights || 0, avail: thisMonthActuals?.avail || 0, bookings: thisMonthActuals?.bookings || 0, elapsed_nights: thisMonthActuals?.elapsed_nights || 0, elapsed_days: thisMonthActuals?.elapsed_days || 0 },
      last_month: { rev: Math.round(lastMonthActuals?.rev || 0), payout: Math.round(lastMonthActuals?.payout || 0) },
      last_year: { rev: Math.round(lastYearActuals?.rev || 0), payout: Math.round(lastYearActuals?.payout || 0) },
      ytd: { rev: Math.round(ytd?.rev || 0), payout: Math.round(ytd?.payout || 0), nights: ytd?.nights || 0, avail: ytd?.avail || 0, props: ytd?.props || 0 },
      month_over_month: lastMonthActuals?.rev > 0 ? Math.round(((thisMonthActuals?.rev || 0) - lastMonthActuals.rev) / lastMonthActuals.rev * 100) : null,
      year_over_year: lastYearActuals?.rev > 0 ? Math.round(((thisMonthActuals?.rev || 0) - lastYearActuals.rev) / lastYearActuals.rev * 100) : null,
      payout_mom: lastMonthActuals?.payout > 0 ? Math.round(((thisMonthActuals?.payout || 0) - lastMonthActuals.payout) / lastMonthActuals.payout * 100) : null,
      this_month_label: thisMonth,
      last_month_label: lastMonth,
    };

    // 3. Upcoming bookings (next 14 days) — live from guesty_reservations
    const { results: upcoming } = await env.DB.prepare(`SELECT gr.check_in, gr.check_out, gr.nights_count as nights, gr.guest_count as guests, gr.source_file as platform, gr.channel, gr.accommodation_fare as revenue, gr.guest_name, p.address, p.unit_number, p.name as prop_name FROM guesty_reservations gr LEFT JOIN properties p ON gr.property_id = p.id WHERE gr.check_in >= ? AND gr.check_in <= ? AND ${LIVE_STATUS_GR} ORDER BY gr.check_in LIMIT 20`).bind(today, in14d).all();
    d.upcoming_checkins = upcoming || [];

    // Upcoming checkouts
    const { results: checkouts } = await env.DB.prepare(`SELECT gr.check_out, gr.nights_count as nights, gr.channel, gr.accommodation_fare as revenue, gr.guest_name, p.address, p.unit_number FROM guesty_reservations gr LEFT JOIN properties p ON gr.property_id = p.id WHERE gr.check_out >= ? AND gr.check_out <= ? AND ${LIVE_STATUS_GR} ORDER BY gr.check_out LIMIT 10`).bind(today, in14d).all();
    d.upcoming_checkouts = checkouts || [];

    // 4. Pricing discrepancies (next 30 days)
    const { results: discrepancies } = await env.DB.prepare(`SELECT gc.date, gc.price as guesty_price, gc.pl_recommended_price, gc.price_discrepancy, gl.listing_name, gc.property_id FROM guesty_calendar gc JOIN guesty_listings gl ON gc.guesty_listing_id = gl.guesty_listing_id WHERE gc.price_discrepancy IS NOT NULL AND ABS(gc.price_discrepancy) > 10 AND gc.date >= ? AND gc.date <= ? ORDER BY ABS(gc.price_discrepancy) DESC LIMIT 10`).bind(today, in30d).all();
    d.price_discrepancies = discrepancies || [];

    // 5. Action items
    const actions = [];
    // Unlinked listings
    const unlinked = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_listings WHERE property_id IS NULL`).first();
    if (unlinked?.c > 0) actions.push({ type: 'warning', icon: 'link', text: unlinked.c + ' Guesty listing' + (unlinked.c > 1 ? 's' : '') + ' not linked to properties', action: 'switchView("pms");showPmsDetail("guesty")', priority: 2 });
    // Properties without analysis
    const noAnalysis = await env.DB.prepare(`SELECT p.id, CASE WHEN p.unit_number IS NOT NULL AND p.unit_number != '' THEN p.unit_number || ' — ' || COALESCE(p.platform_listing_name, p.name, p.address, 'Property') ELSE COALESCE(p.platform_listing_name, p.name, p.address, 'Property #' || p.id) END as label FROM properties p WHERE p.is_research != 1 AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) AND (is_managed = 0 OR is_managed IS NULL) AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active') AND (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) = 0 LIMIT 20`).all();
    if (noAnalysis?.results?.length > 0) {
      const naIds = noAnalysis.results.map(r => r.id);
      const naLabels = noAnalysis.results.map(r => ({ id: r.id, label: r.label }));
      actions.push({ type: 'info', icon: 'pieChart', text: naIds.length + ' propert' + (naIds.length > 1 ? 'ies' : 'y') + ' with no pricing analysis', action: 'dashAction_openProperty', property_ids: naIds, property_labels: naLabels, target_tab: 'pricing', priority: 3 });
    }
    // Price discrepancies
    if (discrepancies.length > 0) {
      const majorDisc = discrepancies.filter(d => Math.abs(d.price_discrepancy) > 25);
      if (majorDisc.length > 0) {
        const discPropIds = [...new Set(majorDisc.map(d => d.property_id))];
        const discLabels = discPropIds.map(pid => {
          const d = majorDisc.find(x => x.property_id === pid);
          return { id: pid, label: (d?.listing_name || 'Property #' + pid).substring(0, 30) };
        });
        actions.push({ type: 'danger', icon: 'dollarSign', text: majorDisc.length + ' major pricing discrepanc' + (majorDisc.length > 1 ? 'ies' : 'y') + ' (>$25) in next 30 days', action: 'dashAction_openProperty', property_ids: discPropIds, property_labels: discLabels, target_tab: 'calendar', priority: 1 });
      }
    }
    // Guest intelligence empty
    const guestCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_guests WHERE total_stays > 0`).first();
    const resCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations`).first();
    if (guestCount?.c === 0 && resCount?.c > 0) actions.push({ type: 'info', icon: 'users', text: 'Guest intelligence not built yet (' + resCount.c + ' reservations available)', action: 'switchView("intel");switchIntelTab("guests")', priority: 2 });

    // Stale analysis (properties last analyzed > 30 days ago)
    try {
      const staleAnalysis = await env.DB.prepare(`SELECT p.id, CASE WHEN p.unit_number IS NOT NULL AND p.unit_number != '' THEN p.unit_number || ' — ' || COALESCE(p.platform_listing_name, p.name, p.address, 'Property') ELSE COALESCE(p.platform_listing_name, p.name, p.address, 'Property #' || p.id) END as label FROM properties p WHERE p.is_research != 1 AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) AND (is_managed = 0 OR is_managed IS NULL) AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active') AND (SELECT MAX(created_at) FROM pricing_strategies ps WHERE ps.property_id = p.id) < datetime('now', '-30 days') LIMIT 20`).all();
      if (staleAnalysis?.results?.length > 0) {
        const saIds = staleAnalysis.results.map(r => r.id);
        const saLabels = staleAnalysis.results.map(r => ({ id: r.id, label: r.label }));
        actions.push({ type: 'warning', icon: 'refresh', text: saIds.length + ' propert' + (saIds.length > 1 ? 'ies' : 'y') + ' not analyzed in 30+ days — market conditions may have shifted', action: 'dashAction_openProperty', property_ids: saIds, property_labels: saLabels, target_tab: 'pricing', priority: 3 });
      }
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11096', e.message); }

    // Low occupancy this month (below 40%) — ALSO catch properties with NO bookings at all
    try {
      // First: properties WITH monthly_actuals but low occupancy
      // Only flag current month if we're past the 15th (avoids partial-month false positives)
      const dayOfMonth = now.getDate();
      const useCurrentMonth = dayOfMonth >= 15;
      const occCheckMonth = useCurrentMonth ? thisMonth : lastMonth;
      const lowOcc = await env.DB.prepare(`SELECT ma.property_id as id, CASE WHEN p.unit_number IS NOT NULL AND p.unit_number != '' THEN p.unit_number || ' — ' || COALESCE(p.platform_listing_name, p.name, p.address, 'Property') ELSE COALESCE(p.platform_listing_name, p.name, p.address, 'Property #' || p.id) END as label, ma.occupancy_pct FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE ma.month = ? AND ma.occupancy_pct < 0.40 AND ma.available_nights > 0 AND (p.is_research != 1 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL) AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active') AND (p.rental_type IS NULL OR p.rental_type != 'ltr') AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) LIMIT 20`).bind(occCheckMonth).all();

      // Second: Guesty-linked properties with NO monthly_actuals AND no upcoming reservations
      // Cross-check against guesty_reservations to avoid false positives
      const noBookings = await env.DB.prepare(`SELECT p.id, CASE WHEN p.unit_number IS NOT NULL AND p.unit_number != '' THEN p.unit_number || ' — ' || COALESCE(p.platform_listing_name, p.name, p.address, 'Property') ELSE COALESCE(p.platform_listing_name, p.name, p.address, 'Property #' || p.id) END as label FROM properties p WHERE (p.is_research != 1 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL) AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active') AND (p.rental_type IS NULL OR p.rental_type != 'ltr') AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) AND EXISTS (SELECT 1 FROM guesty_listings gl WHERE gl.property_id = p.id) AND p.id NOT IN (SELECT property_id FROM monthly_actuals WHERE month = ?) AND p.id NOT IN (SELECT DISTINCT property_id FROM guesty_reservations WHERE property_id IS NOT NULL AND check_out >= ? AND ${LIVE_STATUS_SQL}) LIMIT 20`).bind(occCheckMonth, today).all();

      // Combine both lists
      const allLow = [];
      for (const r of (lowOcc?.results || [])) {
        allLow.push({ id: r.id, label: r.label + ' (' + Math.round((r.occupancy_pct || 0) * 100) + '%)', occ: Math.round((r.occupancy_pct || 0) * 100) });
      }
      for (const r of (noBookings?.results || [])) {
        if (!allLow.find(x => x.id === r.id)) {
          allLow.push({ id: r.id, label: r.label + ' (0%)', occ: 0 });
        }
      }

      if (allLow.length > 0) {
        const loIds = allLow.map(r => r.id);
        const loLabels = allLow.map(r => ({ id: r.id, label: r.label }));
        actions.push({ type: 'warning', icon: 'trendDown', text: allLow.length + ' propert' + (allLow.length > 1 ? 'ies' : 'y') + ' below 40% occupancy this month — review pricing', action: 'dashAction_openProperty', property_ids: loIds, property_labels: loLabels, target_tab: 'pricing', priority: 2 });
      }
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11127', e.message); }

    // Demand segments insight — if segments exist, show top revenue segment
    try {
      const topSeg = await env.DB.prepare(`SELECT demand_segment, COUNT(*) as ct, SUM(accommodation_fare) as rev FROM guesty_reservations WHERE demand_segment IS NOT NULL AND ${LIVE_STATUS_SQL} GROUP BY demand_segment ORDER BY rev DESC LIMIT 1`).first();
      if (topSeg && topSeg.ct >= 3) {
        const segLabel = (topSeg.demand_segment || '').replace(/_/g, ' ');
        actions.push({ type: 'info', icon: 'target', text: 'Top demand segment: ' + segLabel + ' (' + topSeg.ct + ' bookings, $' + Math.round(topSeg.rev).toLocaleString() + ' revenue) — optimize pricing for this audience', action: 'switchView("intel");switchIntelTab("guests")', priority: 4 });
      }
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11136', e.message); }

    // Unclassified reservations
    try {
      const unclassified = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE demand_segment IS NULL AND ${LIVE_STATUS_SQL}`).first();
      if (unclassified?.c > 10) actions.push({ type: 'info', icon: 'tag', text: unclassified.c + ' reservations not yet classified — rebuild intelligence to analyze demand segments', action: 'dashAction_rebuildIntel', priority: 4 });
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11142', e.message); }

    // PriceLabs not synced recently
    try {
      const plStale = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings WHERE last_synced < datetime('now', '-7 days')`).first();
      if (plStale?.c > 0) actions.push({ type: 'warning', icon: 'pieChart', text: plStale.c + ' PriceLabs listing' + (plStale.c > 1 ? 's' : '') + ' not synced in 7+ days', action: 'switchView("pms");showPmsDetail("pricelabs")', priority: 2 });
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11148', e.message); }

    // 5a-2. Market alerts — significant changes in tracked markets
    try {
      const { results: mktAlerts } = await env.DB.prepare(`SELECT mp.city, mp.state, mp.adr_trend_3mo, mp.listing_count_trend_3mo, mp.new_listings_30d, mp.str_avg_adr, mp.str_listing_count, mw.avg_price as prev_avg_price FROM market_profiles mp JOIN market_watchlist mw ON LOWER(mp.city) = LOWER(mw.city) AND LOWER(mp.state) = LOWER(mw.state) WHERE mp.adr_trend_3mo IS NOT NULL OR mp.listing_count_trend_3mo IS NOT NULL`).all();
      for (const m of (mktAlerts || [])) {
        // ADR shift > 15%
        if (m.adr_trend_3mo && Math.abs(m.adr_trend_3mo) >= 15) {
          var dir = m.adr_trend_3mo > 0 ? 'up' : 'down';
          var aType = m.adr_trend_3mo > 0 ? 'info' : 'warning';
          actions.push({ type: aType, icon: dir === 'up' ? 'trendUp' : 'trendDown', text: m.city + ', ' + m.state + ' ADR ' + dir + ' ' + Math.abs(m.adr_trend_3mo) + '% ($' + Math.round(m.str_avg_adr || 0) + '/nt) — review pricing strategy', action: 'switchView("market")', priority: 3 });
        }
        // Listing count change > 20%
        if (m.listing_count_trend_3mo && Math.abs(m.listing_count_trend_3mo) >= 20) {
          var lDir = m.listing_count_trend_3mo > 0 ? 'increased' : 'decreased';
          var lType = m.listing_count_trend_3mo > 0 ? 'warning' : 'info';
          actions.push({ type: lType, icon: 'radar', text: m.city + ', ' + m.state + ' listings ' + lDir + ' ' + Math.abs(m.listing_count_trend_3mo) + '% (' + (m.str_listing_count || 0) + ' active) — competition shift', action: 'switchView("market")', priority: 3 });
        }
        // High new listing volume (> 10 new in 30 days)
        if ((m.new_listings_30d || 0) >= 10) {
          actions.push({ type: 'info', icon: 'layers', text: m.city + ', ' + m.state + ': ' + m.new_listings_30d + ' new listings in 30 days — watch for saturation', action: 'switchView("market")', priority: 4 });
        }
      }
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11171', e.message); }

    // 5a-3. Pricing Intelligence — integrates AI analysis + live PriceLabs + actuals + price history
    try {
      const thisMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const lmDate = new Date(now); lmDate.setMonth(lmDate.getMonth() - 1);
      const lastMonth = lmDate.getFullYear() + '-' + String(lmDate.getMonth() + 1).padStart(2, '0');
      const todayStr = now.toISOString().split('T')[0];
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0];
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 86400000).toISOString().split('T')[0];

      // Get all properties with PriceLabs + actuals + latest AI analysis + price history
      const { results: pricingProps } = await env.DB.prepare(`
        SELECT p.id, p.parent_id, COALESCE(p.platform_listing_name, p.name, p.address) as name, p.unit_number,
          p.city, p.state, p.bedrooms, p.rental_type,
          pl.base_price, pl.recommended_base_price as rec_base, pl.min_price, pl.max_price,
          pl.occupancy_next_7 as occ_7d, pl.occupancy_next_30 as occ_30d,
          pl.market_occupancy_next_30 as mkt_occ_30d,
          ps.base_nightly_rate as ai_rate, ps.projected_occupancy as ai_occ,
          ps.projected_monthly_avg as ai_monthly, ps.strategy_name as ai_strategy,
          ps.created_at as ai_date,
          (SELECT total_revenue FROM monthly_actuals WHERE property_id = p.id AND month = ? LIMIT 1) as this_month_rev,
          (SELECT COALESCE(elapsed_booked_nights, booked_nights) FROM monthly_actuals WHERE property_id = p.id AND month = ? LIMIT 1) as this_month_nights,
          (SELECT total_revenue FROM monthly_actuals WHERE property_id = p.id AND month = ? LIMIT 1) as last_month_rev,
          (SELECT booked_nights FROM monthly_actuals WHERE property_id = p.id AND month = ? LIMIT 1) as last_month_nights,
          (SELECT AVG(total_revenue) FROM monthly_actuals WHERE property_id = p.id) as avg_monthly_rev,
          (SELECT base_price FROM price_history WHERE property_id = p.id AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1) as price_7d_ago,
          (SELECT base_price FROM price_history WHERE property_id = p.id AND snapshot_date <= ? ORDER BY snapshot_date DESC LIMIT 1) as price_14d_ago,
          (SELECT MIN(snapshot_date) FROM price_history WHERE property_id = p.id AND base_price != COALESCE(pl.base_price, 0) AND snapshot_date >= ?) as last_price_change_date
        FROM properties p
        LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
        LEFT JOIN (SELECT property_id, base_nightly_rate, projected_occupancy, projected_monthly_avg, strategy_name, created_at FROM pricing_strategies WHERE id IN (SELECT MAX(id) FROM pricing_strategies GROUP BY property_id)) ps ON ps.property_id = p.id
        WHERE (p.is_research != 1 OR p.is_research IS NULL)
          AND (p.is_managed = 0 OR p.is_managed IS NULL)
          AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active')
          AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
      `).bind(thisMonth, thisMonth, lastMonth, lastMonth, sevenDaysAgo, fourteenDaysAgo, fourteenDaysAgo).all();

      // Get peak/low months from market profiles for seasonality
      const { results: mktSeasons } = await env.DB.prepare(`SELECT city, state, peak_months, low_months, peak_multiplier FROM market_profiles WHERE peak_months IS NOT NULL`).all();
      const seasonMap = {};
      for (const m of (mktSeasons || [])) {
        seasonMap[(m.city || '').toLowerCase() + ',' + (m.state || '').toLowerCase()] = m;
      }
      const currentMonthNum = now.getMonth() + 1;

      // Get latest revenue optimization quick_wins per property
      const { results: optReports } = await env.DB.prepare(`SELECT property_id, report_data FROM analysis_reports WHERE report_type = 'revenue_optimization' AND id IN (SELECT MAX(id) FROM analysis_reports WHERE report_type = 'revenue_optimization' GROUP BY property_id)`).all();
      const optMap = {};
      for (const r of (optReports || [])) {
        try { const d2 = JSON.parse(r.report_data); optMap[r.property_id] = d2.optimization || {}; } catch (e) { syslog(env, 'error', 'getDashboard', 'L11221', e.message); }
      }

      const seenInsights = new Set();
      let _dashFwdResMap = null; // lazy-loaded: Set of property_ids with forward reservations

      for (const p of (pricingProps || [])) {
        const label = p.unit_number ? p.unit_number + ' — ' + p.name : p.name;
        const isLtr = p.rental_type === 'ltr';
        const occ30 = p.occ_30d ? parseInt(p.occ_30d) : null;
        const mktOcc = p.mkt_occ_30d ? parseInt(p.mkt_occ_30d) : null;
        const aiRate = p.ai_rate || null;
        const aiMonthly = p.ai_monthly || null;
        const actualMonthly = p.avg_monthly_rev || null;
        const opt = optMap[p.id] || null;

        // Detect if price was recently changed (within 7 days)
        const priceJustChanged = p.price_7d_ago && p.base_price && Math.abs(p.base_price - p.price_7d_ago) > 5;
        const daysSinceChange = p.last_price_change_date ? Math.round((now.getTime() - new Date(p.last_price_change_date).getTime()) / 86400000) : null;

        // Seasonality context
        const mktKey = ((p.city || '') + ',' + (p.state || '')).toLowerCase();
        const season = seasonMap[mktKey];
        const peakMonths = season && season.peak_months ? season.peak_months.split(',').map(m => parseInt(m.trim())) : [];
        const lowMonths = season && season.low_months ? season.low_months.split(',').map(m => parseInt(m.trim())) : [];
        const isApproachingPeak = peakMonths.some(pm => pm === currentMonthNum + 1 || pm === currentMonthNum + 2);
        const isInPeak = peakMonths.includes(currentMonthNum);
        const isInLow = lowMonths.includes(currentMonthNum);

        // Insight 1: AI recommended rate vs current PriceLabs base
        if (aiRate && p.base_price && Math.abs(aiRate - p.base_price) > 10) {
          const diff = aiRate - p.base_price;
          if (diff > 0) {
            actions.push({ type: 'info', icon: 'trendUp', text: label + ': AI analysis recommends $' + aiRate + '/nt but current base is $' + p.base_price + ' — potential +$' + Math.round(diff * 30 * (p.ai_occ || 0.5)) + '/mo', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'pricing', priority: 2 });
            seenInsights.add(p.id + '_rate');
          }
        }

        // Insight 2: Actual revenue vs AI projection
        if (aiMonthly > 0 && actualMonthly > 0) {
          const pctOfTarget = Math.round(actualMonthly / aiMonthly * 100);
          if (pctOfTarget < 60) {
            actions.push({ type: 'warning', icon: 'target', text: label + ': actual $' + Math.round(actualMonthly).toLocaleString() + '/mo is ' + pctOfTarget + '% of AI target $' + Math.round(aiMonthly).toLocaleString() + ' — underperforming', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'research', priority: 2 });
          } else if (pctOfTarget > 120) {
            actions.push({ type: 'info', icon: 'trendUp', text: label + ': actual $' + Math.round(actualMonthly).toLocaleString() + '/mo exceeds target by ' + (pctOfTarget - 100) + '% — consider raising rates', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'pricing', priority: 3 });
          }
        }

        // Insight 3: Strong demand — raise rates (STR only)
        if (!isLtr && !seenInsights.has(p.id + '_rate') && occ30 !== null && mktOcc !== null && occ30 > mktOcc + 10 && p.base_price) {
          const targetRate = aiRate || p.rec_base || Math.round(p.base_price * 1.15);
          actions.push({ type: 'info', icon: 'trendUp', text: label + ': occ ' + occ30 + '% beats market ' + mktOcc + '% — room to raise toward $' + targetRate, action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'pricing', priority: 2 });
        }

        // Insight 4: Price dropped but bookings didn't improve — WITH change lag check
        // Only compare this vs last month after the 15th — earlier in the month, this_month will always look low
        var dayOfMonth = now.getDate();
        if (dayOfMonth >= 15 && p.base_price && (aiRate || p.rec_base) && p.base_price < (aiRate || p.rec_base) * 0.85 && (p.this_month_nights || 0) <= (p.last_month_nights || 0) && p.last_month_rev > 0) {
          if (priceJustChanged && daysSinceChange !== null && daysSinceChange < 10) {
            // Price changed recently — give it time
            actions.push({ type: 'info', icon: 'clock', text: label + ': rate changed ' + daysSinceChange + ' days ago to $' + p.base_price + ' — allow 10-14 days for booking pace to respond', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'pricing', priority: 4 });
          } else {
            // Price has been low for a while and it's not helping
            actions.push({ type: 'warning', icon: 'alertCircle', text: label + ': rate $' + p.base_price + ' is below AI rec $' + (aiRate || p.rec_base) + ' but bookings flat — check listing quality, photos, or visibility', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'platforms', priority: 1 });
          }
        }

        // Insight 5: Zero forward bookings — but verify against actual reservations first (STR only)
        // PriceLabs occ data can be stale, so check guesty_reservations too
        if (!isLtr && occ30 !== null && occ30 === 0 && p.base_price > 0) {
          if (!_dashFwdResMap) {
            // lazy-load: properties with any current or future reservations
            try {
              const { results: fwdRes } = await env.DB.prepare(`SELECT DISTINCT property_id FROM guesty_reservations WHERE property_id IS NOT NULL AND check_out >= ? AND ${LIVE_STATUS_SQL}`).bind(todayStr).all();
              _dashFwdResMap = new Set((fwdRes || []).map(r => r.property_id));
            } catch { _dashFwdResMap = new Set(); }
          }
          if (!_dashFwdResMap.has(p.id)) {
            actions.push({ type: 'danger', icon: 'alertCircle', text: label + ': 0% forward bookings at $' + p.base_price + '/nt — check calendar blocks, listing status, or platform visibility', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'calendar', priority: 1 });
          }
        }

        // Insight 6: Seasonality — approaching peak, don't discount
        if (isApproachingPeak && occ30 !== null && occ30 < 30 && p.base_price && p.rec_base && p.base_price < p.rec_base) {
          const peakLabel = peakMonths.map(m => ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m] || m).join('/');
          actions.push({ type: 'info', icon: 'calendar', text: label + ': peak season (' + peakLabel + ') approaching — avoid discounting now, bookings will come in closer to date at higher rates', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'pricing', priority: 3 });
        }

        // Insight 7: In peak season but underperforming
        if (isInPeak && occ30 !== null && mktOcc !== null && occ30 < mktOcc - 15) {
          actions.push({ type: 'warning', icon: 'calendar', text: label + ': in peak season but occ ' + occ30 + '% is ' + (mktOcc - occ30) + '% below market — urgent listing review needed', action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'platforms', priority: 1 });
        }

        // Insight 8: Quick wins from optimization
        if (opt && opt.quick_wins && opt.quick_wins.length > 0 && occ30 !== null && occ30 < 40) {
          const topWin = opt.quick_wins[0].substring(0, 80);
          actions.push({ type: 'info', icon: 'zap', text: label + ': quick win — ' + topWin, action: 'dashAction_openProperty', property_ids: [p.id], property_labels: [{ id: p.id, label: label }], target_tab: 'pricing', priority: 3 });
        }

        // Insight 9: Sibling comparison
        if (p.parent_id) {
          const siblings = (pricingProps || []).filter(s => s.parent_id === p.parent_id && s.id !== p.id);
          for (const sib of siblings) {
            const sibOcc = sib.occ_30d ? parseInt(sib.occ_30d) : null;
            if (occ30 !== null && sibOcc !== null && sibOcc > occ30 + 20 && occ30 < 30) {
              const sibLabel = sib.unit_number ? sib.unit_number + ' — ' + sib.name : sib.name;
              actions.push({ type: 'warning', icon: 'scale', text: label + ' (' + occ30 + '% occ) vs ' + (sib.unit_number || 'sibling') + ' (' + sibOcc + '%) — compare listings, photos, amenities', action: 'dashAction_openProperty', property_ids: [p.id, sib.id], property_labels: [{ id: p.id, label: label }, { id: sib.id, label: sibLabel }], target_tab: 'platforms', priority: 2 });
              break;
            }
          }
        }
      }
    } catch (e) { syslog(env, 'error', 'getDashboard', 'L11331', e.message); }

    d.actions = actions.sort((a, b) => a.priority - b.priority);

    // 5b. Problem properties — SAME health scoring as property cards
    // Uses: actual revenue, PL forward occupancy, market comparison, P&L, analysis staleness
    try {
      const problemProps = [];
      // Get all scoreable properties with their data
      const { results: allProps } = await env.DB.prepare(`
        SELECT p.id, COALESCE(p.platform_listing_name, p.name, p.address) as name, p.unit_number,
          p.city, p.state, p.bedrooms, p.rental_type, p.listing_status,
          p.monthly_mortgage, p.monthly_insurance, p.hoa_monthly, p.annual_taxes,
          p.monthly_rent_cost, p.expense_electric, p.expense_gas, p.expense_water,
          p.expense_internet, p.expense_trash, p.expense_other, p.parent_id,
          pl.base_price as pl_base_price, pl.recommended_base_price as pl_rec_base,
          pl.occupancy_next_30 as pl_occ_30d, pl.market_occupancy_next_30 as pl_mkt_occ_30d,
          (SELECT MAX(created_at) FROM pricing_strategies WHERE property_id = p.id) as last_analyzed,
          (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) as strategy_count
        FROM properties p
        LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id
        WHERE (p.is_research != 1 OR p.is_research IS NULL)
          AND (p.is_managed = 0 OR p.is_managed IS NULL)
          AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active')
          AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
      `).all();

      // Get actual revenue per property
      const tmFrom = new Date(); tmFrom.setMonth(tmFrom.getMonth() - 12);
      const fromMonth = tmFrom.getFullYear() + '-' + String(tmFrom.getMonth() + 1).padStart(2, '0');
      const { results: actData } = await env.DB.prepare(`SELECT property_id, ROUND(SUM(total_revenue) / COUNT(*)) as monthly_avg, ROUND(SUM(total_revenue) / NULLIF(SUM(booked_nights),0)) as adr FROM monthly_actuals WHERE month >= ? GROUP BY property_id`).bind(fromMonth).all();
      const actMap = {};
      for (const a of (actData || [])) actMap[a.property_id] = a;

      // Get services costs
      const { results: svcData } = await env.DB.prepare(`SELECT property_id, SUM(monthly_cost) as total FROM property_services GROUP BY property_id`).all();
      const svcMap = {};
      for (const s of (svcData || [])) svcMap[s.property_id] = s.total || 0;

      // Get building allocations
      const { results: bldData } = await env.DB.prepare(`SELECT p.id, p.monthly_mortgage, p.monthly_insurance, p.hoa_monthly, p.annual_taxes, (SELECT COUNT(*) FROM properties WHERE parent_id = p.id) as child_count FROM properties p WHERE p.id IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)`).all();
      const bldAlloc = {};
      for (const b of (bldData || [])) {
        if (b.child_count > 0) {
          const total = (b.monthly_mortgage || 0) + (b.monthly_insurance || 0) + (b.hoa_monthly || 0) + Math.round((b.annual_taxes || 0) / 12);
          bldAlloc[b.id] = Math.round(total / b.child_count);
        }
      }

      let healthCounts = { green: 0, yellow: 0, red: 0 };
      let _problemFwdResMap = null; // lazy-loaded forward reservation check

      for (const p of (allProps || [])) {
        const pLabel = p.unit_number ? p.unit_number + ' — ' + p.name : p.name;
        const actual = actMap[p.id];
        const actualMonthly = actual ? actual.monthly_avg : null;
        const plFwdOcc = p.pl_occ_30d ? parseInt(p.pl_occ_30d) : null;
        const mktOcc = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) : null;
        const yourOcc = plFwdOcc; // Use PL forward for this assessment
        const occGap = (yourOcc !== null && mktOcc !== null) ? yourOcc - mktOcc : null;

        // Monthly cost (same calc as property card)
        const isChild = !!p.parent_id;
        const ownCost = isChild ? 0 : ((p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + (p.hoa_monthly || 0) + Math.round((p.annual_taxes || 0) / 12));
        const utilities = (p.monthly_rent_cost || 0) + (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);
        const monthlyCost = ownCost + utilities + (svcMap[p.id] || 0) + (isChild && p.parent_id && bldAlloc[p.parent_id] ? bldAlloc[p.parent_id] : 0);

        const canScore = actualMonthly !== null || plFwdOcc !== null;
        if (!canScore) {
          // Can't score — flag if no analysis exists
          if (p.strategy_count === 0) {
            problemProps.push({ id: p.id, name: pLabel, city: p.city, state: p.state, beds: p.bedrooms, issue: 'no_analysis', severity: 'info', detail: 'No pricing strategy', target_tab: 'pricing' });
          }
          continue;
        }

        let score = 100;
        const reasons = [];

        // Net P&L
        if (actualMonthly !== null && monthlyCost > 0) {
          const realNet = actualMonthly - monthlyCost;
          if (realNet < 0) { score -= 50; reasons.push('losing $' + Math.abs(Math.round(realNet)).toLocaleString() + '/mo'); }
          else if (realNet < 200) { score -= 20; reasons.push('thin margin $' + Math.round(realNet).toLocaleString() + '/mo net'); }
        } else if (actualMonthly === null && monthlyCost > 0 && plFwdOcc !== null) {
          // Only flag if property truly has no reservations (not just missing monthly_actuals)
          if (!_problemFwdResMap) {
            try {
              const todayStr2 = now.toISOString().split('T')[0];
              const { results: fwdRes2 } = await env.DB.prepare(`SELECT DISTINCT property_id FROM guesty_reservations WHERE property_id IS NOT NULL AND check_out >= ? AND ${LIVE_STATUS_SQL}`).bind(todayStr2).all();
              _problemFwdResMap = new Set((fwdRes2 || []).map(r => r.property_id));
            } catch { _problemFwdResMap = new Set(); }
          }
          if (!_problemFwdResMap.has(p.id)) {
            score -= 25; reasons.push('no revenue recorded, costs $' + Math.round(monthlyCost).toLocaleString() + '/mo');
          }
        }

        // Occupancy vs market
        if (occGap !== null) {
          if (occGap < -20) { score -= 40; reasons.push('occ ' + yourOcc + '% vs market ' + mktOcc + '%'); }
          else if (occGap < -10) { score -= 20; reasons.push('occ lagging market by ' + Math.abs(occGap) + '%'); }
          else if (occGap < -5) { score -= 10; reasons.push('occ ' + yourOcc + '% vs market ' + mktOcc + '%'); }
        }

        // Very low forward bookings — but only if no actual forward reservations exist
        if (plFwdOcc !== null && plFwdOcc <= 5) {
          // Lazy-load forward reservation map (same as action items)
          if (!_problemFwdResMap) {
            try {
              const todayStr2 = now.toISOString().split('T')[0];
              const { results: fwdRes2 } = await env.DB.prepare(`SELECT DISTINCT property_id FROM guesty_reservations WHERE property_id IS NOT NULL AND check_out >= ? AND ${LIVE_STATUS_SQL}`).bind(todayStr2).all();
              _problemFwdResMap = new Set((fwdRes2 || []).map(r => r.property_id));
            } catch { _problemFwdResMap = new Set(); }
          }
          if (!_problemFwdResMap.has(p.id)) {
            score -= 25; reasons.push('only ' + plFwdOcc + '% forward bookings');
          }
        }

        // ADR vs recommendation
        if (p.pl_base_price && p.pl_rec_base && parseFloat(p.pl_rec_base) > parseFloat(p.pl_base_price) * 1.1) {
          score -= 10; reasons.push('PL recommends $' + p.pl_rec_base + '/nt vs current $' + p.pl_base_price);
        }

        // Stale analysis
        if (p.strategy_count === 0) { score -= 15; reasons.push('no pricing analysis'); }
        else if (p.last_analyzed && (Date.now() - new Date(p.last_analyzed).getTime()) > 30 * 86400000) {
          const daysSince = Math.round((Date.now() - new Date(p.last_analyzed).getTime()) / 86400000);
          score -= 10; reasons.push(daysSince + 'd since analysis');
        }

        // Classify
        if (score >= 80) { healthCounts.green++; }
        else if (score >= 50) {
          healthCounts.yellow++;
          const mainIssue = reasons.length > 0 ? reasons[0] : 'needs attention';
          problemProps.push({ id: p.id, name: pLabel, city: p.city, state: p.state, beds: p.bedrooms, issue: 'health_watch', severity: 'warning', detail: reasons.join(' · '), score, target_tab: 'pricing' });
        } else {
          healthCounts.red++;
          problemProps.push({ id: p.id, name: pLabel, city: p.city, state: p.state, beds: p.bedrooms, issue: 'health_critical', severity: 'danger', detail: reasons.join(' · '), score, target_tab: 'pricing' });
        }
      }

      // Also include pricing discrepancies
      const seenDiscProps = new Set();
      for (const disc of (discrepancies || []).filter(d => Math.abs(d.price_discrepancy) > 15)) {
        if (seenDiscProps.has(disc.property_id)) continue;
        seenDiscProps.add(disc.property_id);
        const discCount = discrepancies.filter(d2 => d2.property_id === disc.property_id && Math.abs(d2.price_discrepancy) > 15).length;
        if (!problemProps.find(x => x.id === disc.property_id))
          problemProps.push({ id: disc.property_id, name: disc.listing_name || 'Property', issue: 'price_discrepancy', severity: Math.abs(disc.price_discrepancy) > 25 ? 'danger' : 'warning', detail: discCount + ' date' + (discCount > 1 ? 's' : '') + ' off by >$' + Math.round(Math.abs(disc.price_discrepancy)), target_tab: 'calendar' });
      }

      d.problem_properties = problemProps;
      d.health_summary = healthCounts;
    } catch { d.problem_properties = []; d.health_summary = {}; }

    // 6. Channel breakdown (from channel_intelligence or reservations)
    const { results: channels } = await env.DB.prepare(`SELECT channel, SUM(reservations) as bookings, SUM(total_revenue) as revenue, SUM(total_payout) as payout, ROUND(AVG(avg_adr)) as adr FROM channel_intelligence WHERE period = 'all_time' AND property_id != 0 GROUP BY channel ORDER BY revenue DESC LIMIT 6`).all();
    d.channels = channels || [];

    // 7. Top properties by revenue (this month or YTD)
    const { results: topProps } = await env.DB.prepare(`SELECT p.id, COALESCE(p.platform_listing_name, p.name, p.address) as address, p.unit_number, p.city, p.state, p.bedrooms, p.rental_type, SUM(ma.total_revenue) as ytd_rev, SUM(ma.host_payout) as ytd_payout, SUM(ma.booked_nights) as ytd_nights, SUM(ma.available_nights) as ytd_avail, COUNT(*) as months FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE ma.month >= ? AND (p.is_managed = 0 OR p.is_managed IS NULL) AND (p.is_research != 1 OR p.is_research IS NULL) GROUP BY p.id ORDER BY ytd_rev DESC LIMIT 8`).bind(ytdFrom).all();
    d.top_properties = topProps || [];

    // 8. Integration health
    const guestyConn = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_access_token'`).first();
    const guestyLastSync = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_last_api_sync'`).first();
    const guestyError = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'guesty_last_sync_error'`).first();
    const guestyListings = await env.DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN property_id IS NOT NULL THEN 1 ELSE 0 END) as linked FROM guesty_listings`).first();
    const plStatus = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'apikey_PRICELABS_API_KEY'`).first();
    const plHasKey = !!env.PRICELABS_API_KEY || !!plStatus?.value;
    const plListingCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings`).first();
    const plLinkedCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM pricelabs_listings WHERE property_id IS NOT NULL`).first();
    const plLastSync = await env.DB.prepare(`SELECT MAX(last_synced) as ls FROM pricelabs_listings`).first();
    const lastSyncLog = await env.DB.prepare(`SELECT sync_type, source, status, records_processed, completed_at, error FROM sync_log ORDER BY id DESC LIMIT 5`).all();

    d.integrations = {
      guesty: { connected: !!guestyConn?.value, last_sync: guestyLastSync?.value || null, error: guestyError?.value || null, listings: guestyListings?.total || 0, linked: guestyListings?.linked || 0 },
      pricelabs: { connected: plHasKey || (plListingCount?.c || 0) > 0, last_sync: plLastSync?.ls || null, listings: plListingCount?.c || 0, linked: plLinkedCount?.c || 0 },
      recent_syncs: lastSyncLog.results || [],
    };

    // Last cron run summary for dashboard visibility
    try {
      const lastCron = await env.DB.prepare(`SELECT sync_type, status, completed_at FROM sync_log WHERE source = 'cron' AND completed_at IS NOT NULL ORDER BY id DESC LIMIT 1`).first();
      const lastMarketCrawl = await env.DB.prepare(`SELECT completed_at, records_processed FROM sync_log WHERE sync_type = 'market_crawl_profiles' ORDER BY id DESC LIMIT 1`).first();
      const lastIntelRebuild = await env.DB.prepare(`SELECT completed_at FROM sync_log WHERE sync_type = 'intelligence' ORDER BY id DESC LIMIT 1`).first();
      const lastAutoAnalysis = await env.DB.prepare(`SELECT completed_at, records_processed FROM sync_log WHERE sync_type = 'auto_analysis' ORDER BY id DESC LIMIT 1`).first();
      const masterCount = await env.DB.prepare(`SELECT COUNT(*) as c FROM master_listings WHERE status = 'active'`).first();
      // Check for markets needing AI enrichment and properties needing analysis
      const marketsNeedingDemo = await env.DB.prepare(`SELECT COUNT(*) as c FROM market_profiles WHERE demographics_json IS NULL OR demographics_json = ''`).first();
      const unanalyzedProps = await env.DB.prepare(`SELECT COUNT(*) as c FROM properties p WHERE p.is_research != 1 AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) AND (is_managed = 0 OR is_managed IS NULL) AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active') AND (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) = 0`).first();

      d.system_health = {
        last_cron: lastCron?.completed_at || null,
        last_cron_status: lastCron?.status || null,
        last_market_crawl: lastMarketCrawl?.completed_at || null,
        last_crawl_markets: lastMarketCrawl?.records_processed || 0,
        last_intel_rebuild: lastIntelRebuild?.completed_at || null,
        last_auto_analysis: lastAutoAnalysis?.completed_at || null,
        last_auto_analysis_count: lastAutoAnalysis?.records_processed || 0,
        master_listings_active: masterCount?.c || 0,
        markets_needing_enrichment: marketsNeedingDemo?.c || 0,
        unanalyzed_properties: unanalyzedProps?.c || 0,
      };
    } catch { d.system_health = {}; }

    // 9. Occupancy snapshot
    const occThis = (d.revenue.this_month.avail || 0) > 0 ? Math.round((d.revenue.this_month.nights || 0) / d.revenue.this_month.avail * 100) : null;
    const occLast = (lastMonthActuals?.avail || 0) > 0 ? Math.round((lastMonthActuals?.nights || 0) / lastMonthActuals.avail * 100) : null;
    d.occupancy = { this_month: occThis, last_month: occLast };

    // 10. API & AI usage summary
    try {
      d.api_costs = await getApiUsageSummary(env);
    } catch { d.api_costs = {}; }

    // 11. API key status (compact)
    try {
      const keyNames = ['RENTCAST_API_KEY','GOOGLE_PLACES_API_KEY','SEARCHAPI_KEY','PRICELABS_API_KEY','ANTHROPIC_API_KEY','OPENAI_API_KEY','GUESTY_CLIENT_ID','GUESTY_CLIENT_SECRET'];
      const keyStatus = {};
      for (const k of keyNames) {
        try {
          const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('apikey_' + k).first();
          keyStatus[k] = !!(row?.value || env[k]);
        } catch { keyStatus[k] = !!env[k]; }
      }
      keyStatus.WORKERS_AI = !!env.AI;
      d.api_keys = keyStatus;
    } catch { d.api_keys = {}; }

    // 8. Discoveries — proactive insights and improvement suggestions
    try {
      const discoveries = [];

      // a) Listing content gaps (photos, description)
      const { results: contentGaps } = await env.DB.prepare(`
        SELECT gl.property_id, gl.listing_name, gl.listing_description, gl.listing_pictures_json,
               COALESCE(p.platform_listing_name, p.name, p.address) as label, p.unit_number
        FROM guesty_listings gl JOIN properties p ON gl.property_id = p.id
        WHERE gl.property_id IS NOT NULL AND (p.is_research = 0 OR p.is_research IS NULL)
        AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
      `).all();

      for (const g of (contentGaps || [])) {
        var photoCount = 0;
        if (g.listing_pictures_json) { try { photoCount = JSON.parse(g.listing_pictures_json).length; } catch {} }
        var label = g.unit_number ? g.unit_number + ' — ' + g.label : g.label;
        if (photoCount > 0 && photoCount < 15) {
          discoveries.push({ type: 'improve', icon: 'camera', text: label + ': Only ' + photoCount + ' photos — listings with 20+ get significantly more bookings', action: 'dashAction_openProperty', property_ids: [g.property_id], property_labels: [{ id: g.property_id, label: label }], target_tab: 'details', priority: 3 });
        }
        if (g.listing_description && g.listing_description.length < 200) {
          discoveries.push({ type: 'improve', icon: 'edit', text: label + ': Listing description is only ' + g.listing_description.length + ' characters — expand with amenity highlights and neighborhood info', action: 'dashAction_openProperty', property_ids: [g.property_id], property_labels: [{ id: g.property_id, label: label }], target_tab: 'platforms', priority: 3 });
        }
      }

      // b) Amenity gaps — properties with few amenities vs market
      const { results: amenGaps } = await env.DB.prepare(`
        SELECT p.id, COALESCE(p.platform_listing_name, p.name, p.address) as label, p.unit_number,
               (SELECT COUNT(*) FROM property_amenities WHERE property_id = p.id) as amen_count
        FROM properties p
        WHERE (p.is_research = 0 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL)
        AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
        AND p.listing_status = 'active'
      `).all();
      for (const a of (amenGaps || [])) {
        if (a.amen_count === 0) {
          var al = a.unit_number ? a.unit_number + ' — ' + a.label : a.label;
          discoveries.push({ type: 'improve', icon: 'sparkle', text: al + ': No amenities tracked — add amenities to improve AI analysis accuracy and identify pricing opportunities', action: 'dashAction_openProperty', property_ids: [a.id], property_labels: [{ id: a.id, label: al }], target_tab: 'amenities', priority: 4 });
        }
      }

      // c) Revenue opportunities — properties beating market, could raise prices
      const { results: opportunities } = await env.DB.prepare(`
        SELECT p.id, COALESCE(p.platform_listing_name, p.name, p.address) as label, p.unit_number,
               pl.base_price, pl.occupancy_next_30, pl.market_occupancy_next_30,
               mp.str_avg_adr, mp.str_avg_occupancy
        FROM properties p
        JOIN pricelabs_listings pl ON pl.property_id = p.id
        LEFT JOIN market_profiles mp ON LOWER(mp.city) = LOWER(p.city) AND LOWER(mp.state) = LOWER(p.state)
        WHERE (p.is_research = 0 OR p.is_research IS NULL)
        AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
        AND pl.occupancy_next_30 IS NOT NULL AND pl.market_occupancy_next_30 IS NOT NULL
      `).all();
      for (const o of (opportunities || [])) {
        var myOcc = parseInt(o.occupancy_next_30) || 0;
        var mktOcc = parseInt(o.market_occupancy_next_30) || 0;
        if (myOcc > mktOcc + 10 && myOcc > 60) {
          var ol = o.unit_number ? o.unit_number + ' — ' + o.label : o.label;
          var potentialIncrease = Math.round(o.base_price * 0.1);
          discoveries.push({ type: 'opportunity', icon: 'trendUp', text: ol + ': Occupancy ' + myOcc + '% beats market ' + mktOcc + '% — room to raise base $' + o.base_price + ' by ~$' + potentialIncrease + '/nt without hurting bookings', action: 'dashAction_openProperty', property_ids: [o.id], property_labels: [{ id: o.id, label: ol }], target_tab: 'pricing', priority: 2 });
        }
        if (o.str_avg_adr && o.base_price < o.str_avg_adr * 0.8) {
          var ol2 = o.unit_number ? o.unit_number + ' — ' + o.label : o.label;
          discoveries.push({ type: 'opportunity', icon: 'dollarSign', text: ol2 + ': Base $' + o.base_price + '/nt is ' + Math.round((1 - o.base_price / o.str_avg_adr) * 100) + '% below market avg $' + Math.round(o.str_avg_adr) + ' — potential underpricing', action: 'dashAction_openProperty', property_ids: [o.id], property_labels: [{ id: o.id, label: ol2 }], target_tab: 'pricing', priority: 2 });
        }
      }

      // d) Review count alerts — low reviews hurt ranking
      const { results: reviewGaps } = await env.DB.prepare(`
        SELECT pp.property_id, pp.platform, pp.review_count, pp.rating,
               COALESCE(p.platform_listing_name, p.name, p.address) as label, p.unit_number
        FROM property_platforms pp JOIN properties p ON pp.property_id = p.id
        WHERE pp.review_count IS NOT NULL AND pp.review_count < 10
        AND (p.is_research = 0 OR p.is_research IS NULL)
      `).all();
      for (const r of (reviewGaps || [])) {
        var rl = r.unit_number ? r.unit_number + ' — ' + r.label : r.label;
        discoveries.push({ type: 'improve', icon: 'users', text: rl + ' on ' + r.platform + ': Only ' + r.review_count + ' reviews' + (r.rating ? ' (' + r.rating + ' rating)' : '') + ' — prioritize getting more guest reviews for ranking boost', action: 'dashAction_openProperty', property_ids: [r.property_id], property_labels: [{ id: r.property_id, label: rl }], target_tab: 'platforms', priority: 4 });
      }

      // e) Missing expenses on revenue-generating properties
      const { results: noExpenses } = await env.DB.prepare(`
        SELECT p.id, COALESCE(p.platform_listing_name, p.name, p.address) as label, p.unit_number
        FROM properties p
        WHERE (p.is_research = 0 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL)
        AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)
        AND (p.monthly_mortgage IS NULL OR p.monthly_mortgage = 0)
        AND (p.monthly_rent_cost IS NULL OR p.monthly_rent_cost = 0)
        AND p.ownership_type != 'managed'
        AND EXISTS (SELECT 1 FROM monthly_actuals WHERE property_id = p.id)
        LIMIT 5
      `).all();
      for (const ne of (noExpenses || [])) {
        var nel = ne.unit_number ? ne.unit_number + ' — ' + ne.label : ne.label;
        discoveries.push({ type: 'setup', icon: 'dollarSign', text: nel + ': Has revenue data but no expenses entered — add mortgage/rent/insurance for accurate profit tracking', action: 'dashAction_openProperty', property_ids: [ne.id], property_labels: [{ id: ne.id, label: nel }], target_tab: 'details', priority: 3 });
      }

      d.discoveries = discoveries.sort((a, b) => a.priority - b.priority);
    } catch { d.discoveries = []; }

    // ── Year Projection Chart Data ─────────────────────────────────────────
    try {
      const year = now.getFullYear();
      const currentMonthNum = now.getMonth() + 1;
      const projection = [];

      // 1. Actuals — monthly_actuals for this year (portfolio only, no managed/research)
      const { results: yearActuals } = await env.DB.prepare(
        `SELECT ma.month, SUM(ma.total_revenue) as revenue, SUM(ma.host_payout) as payout, SUM(ma.booked_nights) as nights, SUM(ma.available_nights) as avail FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE ma.month >= ? AND ma.month <= ? AND (p.is_managed = 0 OR p.is_managed IS NULL) AND (p.is_research != 1 OR p.is_research IS NULL) GROUP BY ma.month ORDER BY ma.month`
      ).bind(year + '-01', year + '-12').all();
      const actualMap = {};
      for (const a of (yearActuals || [])) actualMap[a.month] = { revenue: Math.round(a.revenue || 0), payout: Math.round(a.payout || 0), nights: a.nights || 0, avail: a.avail || 0 };

      // 2. Forward bookings — confirmed reservation nights that are AFTER today
      // Only count future nights to avoid double-counting with actuals
      const forwardMap = {};
      try {
        const { results: fwdRes } = await env.DB.prepare(
          `SELECT gr.check_in, gr.check_out, gr.nights_count, gr.accommodation_fare, gr.host_payout, gr.property_id FROM guesty_reservations gr JOIN properties p ON gr.property_id = p.id WHERE gr.check_out > ? AND ${LIVE_STATUS_GR} AND (p.is_managed = 0 OR p.is_managed IS NULL) AND (p.is_research != 1 OR p.is_research IS NULL)`
        ).bind(today).all();
        for (const r of (fwdRes || [])) {
          if (!r.check_in || !r.accommodation_fare) continue;
          const ciStr = (r.check_in || '').substring(0, 10);
          const coStr = (r.check_out || '').substring(0, 10);
          if (!ciStr.match(/^\d{4}-\d{2}-\d{2}$/)) continue;
          const [ciY, ciM, ciD] = ciStr.split('-').map(Number);
          const ci = new Date(Date.UTC(ciY, ciM - 1, ciD));
          let co;
          if (coStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
            const [coY, coM, coD] = coStr.split('-').map(Number);
            co = new Date(Date.UTC(coY, coM - 1, coD));
          } else { co = new Date(ci.getTime() + (r.nights_count || 1) * 86400000); }
          const totalNights = r.nights_count || Math.max(1, Math.round((co - ci) / 86400000));
          const nightlyRate = totalNights > 0 ? r.accommodation_fare / totalNights : 0;
          const nightlyPayout = totalNights > 0 ? (r.host_payout || r.accommodation_fare) / totalNights : 0;
          // Only count nights AFTER today (tomorrow onwards)
          const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
          let d2 = ci < tomorrow ? new Date(tomorrow) : new Date(ci);
          while (d2 < co) {
            const mk = d2.getUTCFullYear() + '-' + String(d2.getUTCMonth() + 1).padStart(2, '0');
            if (mk.startsWith(String(year))) {
              if (!forwardMap[mk]) forwardMap[mk] = { revenue: 0, payout: 0, nights: 0 };
              forwardMap[mk].revenue += nightlyRate;
              forwardMap[mk].payout += nightlyPayout;
              forwardMap[mk].nights++;
            }
            d2 = new Date(d2.getTime() + 86400000);
          }
        }
        for (const mk in forwardMap) {
          forwardMap[mk].revenue = Math.round(forwardMap[mk].revenue);
          forwardMap[mk].payout = Math.round(forwardMap[mk].payout);
        }
      } catch {}

      // 3. Target — from latest pricing strategies + seasonality multipliers
      let monthlyTarget = 0;
      try {
        const { results: strats } = await env.DB.prepare(
          `SELECT ps.projected_monthly_avg, ps.property_id FROM pricing_strategies ps JOIN properties p ON ps.property_id = p.id WHERE ps.id IN (SELECT MAX(id) FROM pricing_strategies GROUP BY property_id) AND (p.is_managed = 0 OR p.is_managed IS NULL) AND (p.is_research != 1 OR p.is_research IS NULL) AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) AND (p.listing_status IS NULL OR p.listing_status = '' OR p.listing_status = 'active')`
        ).all();
        for (const s of (strats || [])) monthlyTarget += (s.projected_monthly_avg || 0);
      } catch {}

      // Seasonality multipliers — average across markets
      const seasonMults = {};
      try {
        const { results: seasons } = await env.DB.prepare(
          `SELECT month_number, AVG(multiplier) as mult FROM market_seasonality GROUP BY month_number`
        ).all();
        for (const s of (seasons || [])) seasonMults[s.month_number] = s.mult || 1;
      } catch {}

      // Build 12-month array
      for (let m = 1; m <= 12; m++) {
        const mk = year + '-' + String(m).padStart(2, '0');
        const actual = actualMap[mk] || null;
        const fwd = forwardMap[mk] || null;
        const mult = seasonMults[m] || 1;
        const target = monthlyTarget > 0 ? Math.round(monthlyTarget * mult) : null;
        const isPast = m < currentMonthNum;
        const isCurrent = m === currentMonthNum;
        const isFuture = m > currentMonthNum;

        // Actual: show for past + current months (real revenue that happened)
        const actualVal = (isPast || isCurrent) && actual ? actual.revenue : null;
        // Booked: for current month = actual + remaining forward; for future months = just forward
        // This shows the TOTAL expected for the month (what happened + what's coming)
        let bookedVal = null;
        if (isCurrent && (fwd || actual)) {
          bookedVal = (actual ? actual.revenue : 0) + (fwd ? fwd.revenue : 0);
          // Only show booked if it differs from actual (i.e. there ARE forward bookings)
          if (bookedVal === actualVal) bookedVal = null;
        } else if (isFuture && fwd) {
          bookedVal = fwd.revenue;
        }

        projection.push({
          month: mk,
          month_num: m,
          actual: actualVal,
          actual_payout: (isPast || isCurrent) && actual ? actual.payout : null,
          booked: bookedVal,
          booked_payout: fwd ? fwd.payout : 0,
          target: target,
          is_past: isPast,
          is_current: isCurrent,
        });
      }
      d.year_projection = projection;
    } catch (e) { syslog(env, 'error', 'getDashboard', 'year_projection', e.message); d.year_projection = []; }

  } catch (err) { d.error = err.message; }

  return json(d);
}

// ─── Algo Templates ──────────────────────────────────────────────────────────
async function getAlgoTemplates(env) {
  const { results: templates } = await env.DB.prepare(`SELECT t.*, (SELECT COUNT(*) FROM properties p WHERE p.algo_template_id = t.id) as property_count FROM algo_templates t ORDER BY t.name`).all();
  return json({ templates: templates || [] });
}

async function upsertAlgoTemplate(request, env, existingId) {
  const b = await request.json().catch(() => ({}));
  if (!b.name) return json({ error: 'Template name required' }, 400);

  const fields = {
    name: b.name,
    description: b.description || null,
    occupancy_target: b.occupancy_target || 65,
    pricing_bias: b.pricing_bias || 'balanced',
    min_nightly_rate: b.min_nightly_rate || null,
    max_nightly_rate: b.max_nightly_rate || null,
    min_nights: b.min_nights || null,
    weekend_pct: b.weekend_pct || null,
    lastmin_pct: b.lastmin_pct || null,
    gap_pct: b.gap_pct || null,
    earlybird_pct: b.earlybird_pct || null,
    monthly_pct: b.monthly_pct || null,
    seasonal_profile: b.seasonal_profile || 'standard',
    peak_months: b.peak_months || null,
    low_months: b.low_months || null,
    peak_markup_pct: b.peak_markup_pct || 20,
    low_discount_pct: b.low_discount_pct || 15,
    notes: b.notes || null,
  };

  if (existingId) {
    await env.DB.prepare(`UPDATE algo_templates SET name=?, description=?, occupancy_target=?, pricing_bias=?, min_nightly_rate=?, max_nightly_rate=?, min_nights=?, weekend_pct=?, lastmin_pct=?, gap_pct=?, earlybird_pct=?, monthly_pct=?, seasonal_profile=?, peak_months=?, low_months=?, peak_markup_pct=?, low_discount_pct=?, notes=?, updated_at=datetime('now') WHERE id=?`)
      .bind(fields.name, fields.description, fields.occupancy_target, fields.pricing_bias, fields.min_nightly_rate, fields.max_nightly_rate, fields.min_nights, fields.weekend_pct, fields.lastmin_pct, fields.gap_pct, fields.earlybird_pct, fields.monthly_pct, fields.seasonal_profile, fields.peak_months, fields.low_months, fields.peak_markup_pct, fields.low_discount_pct, fields.notes, existingId).run();
    return json({ ok: true, id: parseInt(existingId), message: 'Template "' + fields.name + '" updated' });
  } else {
    const ins = await env.DB.prepare(`INSERT INTO algo_templates (name, description, occupancy_target, pricing_bias, min_nightly_rate, max_nightly_rate, min_nights, weekend_pct, lastmin_pct, gap_pct, earlybird_pct, monthly_pct, seasonal_profile, peak_months, low_months, peak_markup_pct, low_discount_pct, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(fields.name, fields.description, fields.occupancy_target, fields.pricing_bias, fields.min_nightly_rate, fields.max_nightly_rate, fields.min_nights, fields.weekend_pct, fields.lastmin_pct, fields.gap_pct, fields.earlybird_pct, fields.monthly_pct, fields.seasonal_profile, fields.peak_months, fields.low_months, fields.peak_markup_pct, fields.low_discount_pct, fields.notes).run();
    return json({ ok: true, id: ins.meta.last_row_id, message: 'Template "' + fields.name + '" created' });
  }
}

async function assignAlgoTemplate(request, env) {
  const b = await request.json().catch(() => ({}));
  const templateId = b.template_id; // null to unassign
  const propertyIds = b.property_ids || [];
  if (propertyIds.length === 0) return json({ error: 'property_ids required' }, 400);

  let updated = 0;
  for (const pid of propertyIds) {
    await env.DB.prepare(`UPDATE properties SET algo_template_id = ? WHERE id = ?`).bind(templateId, pid).run();
    updated++;
  }
  return json({ ok: true, updated, message: (templateId ? 'Assigned template to ' : 'Unassigned template from ') + updated + ' properties' });
}

// ─── Market Profiles ─────────────────────────────────────────────────────────

async function buildMarketProfile(city, state, env) {
  const cityL = city.toLowerCase().trim();
  const stateU = state.toUpperCase().trim();
  const stateL = stateU.toLowerCase();

  const profile = { city, state: stateU };

  // 1. STR landscape from master_listings
  try {
    const strStats = await env.DB.prepare(
      `SELECT COUNT(*) as count, AVG(nightly_rate) as avg_adr, AVG(rating) as avg_rating, AVG(review_count) as avg_reviews, SUM(CASE WHEN superhost = 1 THEN 1 ELSE 0 END) as superhosts FROM master_listings WHERE LOWER(city) = ? AND LOWER(state) = ? AND status = 'active'`
    ).bind(cityL, stateL.toLowerCase()).first();

    if (strStats) {
      profile.str_listing_count = strStats.count || 0;
      profile.str_avg_adr = Math.round((strStats.avg_adr || 0) * 100) / 100;
      profile.str_avg_rating = Math.round((strStats.avg_rating || 0) * 100) / 100;
      profile.str_avg_reviews = Math.round(strStats.avg_reviews || 0);
      profile.str_superhost_pct = strStats.count > 0 ? Math.round((strStats.superhosts || 0) / strStats.count * 100) : 0;
    }

    // Median ADR
    const { results: adrList } = await env.DB.prepare(
      `SELECT nightly_rate FROM master_listings WHERE LOWER(city) = ? AND LOWER(state) = ? AND status = 'active' AND nightly_rate > 0 ORDER BY nightly_rate`
    ).bind(cityL, stateL.toLowerCase()).all();
    if (adrList && adrList.length > 0) {
      const mid = Math.floor(adrList.length / 2);
      profile.str_median_adr = adrList.length % 2 ? adrList[mid].nightly_rate : Math.round((adrList[mid - 1].nightly_rate + adrList[mid].nightly_rate) / 2);
    }

    // Property type mix
    const { results: typeMix } = await env.DB.prepare(
      `SELECT property_type, COUNT(*) as ct FROM master_listings WHERE LOWER(city) = ? AND LOWER(state) = ? AND status = 'active' AND property_type IS NOT NULL GROUP BY property_type ORDER BY ct DESC`
    ).bind(cityL, stateL.toLowerCase()).all();
    if (typeMix && typeMix.length > 0) {
      const total = typeMix.reduce((s, t) => s + t.ct, 0);
      profile.str_property_mix = JSON.stringify(typeMix.map(t => ({ type: t.property_type, count: t.ct, pct: Math.round(t.ct / total * 100) })));
    }

    // Bedroom mix
    const { results: bedMix } = await env.DB.prepare(
      `SELECT bedrooms, COUNT(*) as ct FROM master_listings WHERE LOWER(city) = ? AND LOWER(state) = ? AND status = 'active' AND bedrooms IS NOT NULL GROUP BY bedrooms ORDER BY bedrooms`
    ).bind(cityL, stateL.toLowerCase()).all();
    if (bedMix && bedMix.length > 0) {
      const total = bedMix.reduce((s, b) => s + b.ct, 0);
      profile.str_bedroom_mix = JSON.stringify(bedMix.map(b => ({ beds: b.bedrooms, count: b.ct, pct: Math.round(b.ct / total * 100) })));
    }

    // Price bands
    const { results: bands } = await env.DB.prepare(
      `SELECT CASE WHEN nightly_rate < 75 THEN 'Under $75' WHEN nightly_rate < 125 THEN '$75-$125' WHEN nightly_rate < 200 THEN '$125-$200' WHEN nightly_rate < 300 THEN '$200-$300' WHEN nightly_rate < 500 THEN '$300-$500' ELSE '$500+' END as band, COUNT(*) as ct FROM master_listings WHERE LOWER(city) = ? AND LOWER(state) = ? AND status = 'active' AND nightly_rate > 0 GROUP BY band ORDER BY MIN(nightly_rate)`
    ).bind(cityL, stateL.toLowerCase()).all();
    if (bands && bands.length > 0) profile.str_price_bands = JSON.stringify(bands);

    // New listings in last 30 days
    const newListings = await env.DB.prepare(
      `SELECT COUNT(*) as c FROM master_listings WHERE LOWER(city) = ? AND LOWER(state) = ? AND first_seen >= datetime('now', '-30 days')`
    ).bind(cityL, stateL.toLowerCase()).first();
    profile.new_listings_30d = newListings?.c || 0;

    // Top hosts by listing count
    const { results: topH } = await env.DB.prepare(
      `SELECT host_name, COUNT(*) as ct, ROUND(AVG(rating), 2) as avg_rating FROM master_listings WHERE LOWER(city) = ? AND LOWER(state) = ? AND status = 'active' AND host_name IS NOT NULL AND host_name != '' GROUP BY host_name HAVING COUNT(*) >= 2 ORDER BY ct DESC LIMIT 8`
    ).bind(cityL, stateL.toLowerCase()).all();
    if (topH && topH.length > 0) {
      profile.str_top_hosts = JSON.stringify(topH.map(h => ({ name: h.host_name, listings: h.ct, rating: h.avg_rating })));
    }
  } catch {}

  // 2. LTR data from market_snapshots (RentCast)
  try {
    const ltr = await env.DB.prepare(
      `SELECT avg_daily_rate, median_daily_rate, active_listings FROM market_snapshots WHERE LOWER(city) = ? AND LOWER(state) = ? ORDER BY snapshot_date DESC LIMIT 1`
    ).bind(cityL, stateL.toLowerCase()).first();
    if (ltr) {
      profile.ltr_avg_rent = ltr.avg_daily_rate || null;
      profile.ltr_median_rent = ltr.median_daily_rate || null;
      profile.ltr_active_listings = ltr.active_listings || null;
    }
  } catch {}

  // 3. Your performance in this market
  try {
    const LIVE = `${LIVE_STATUS_SQL}`;
    const yourProps = await env.DB.prepare(
      `SELECT COUNT(*) as ct FROM properties WHERE LOWER(city) = ? AND LOWER(state) = ? AND (is_research != 1 OR is_research IS NULL) AND id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)`
    ).bind(cityL, stateL).first();
    profile.your_property_count = yourProps?.ct || 0;

    if (profile.your_property_count > 0) {
      // Your revenue and occupancy from monthly_actuals (last 12 months)
      const yourPerf = await env.DB.prepare(
        `SELECT CASE WHEN SUM(ma.booked_nights) > 0 THEN ROUND(SUM(ma.total_revenue) * 1.0 / SUM(ma.booked_nights), 2) ELSE 0 END as avg_adr, CASE WHEN SUM(ma.available_nights) > 0 THEN ROUND(SUM(ma.booked_nights) * 100.0 / SUM(ma.available_nights)) ELSE 0 END as avg_occ, SUM(ma.total_revenue) as total_rev FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE LOWER(p.city) = ? AND LOWER(p.state) = ? AND (p.is_research != 1 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL) AND ma.month >= strftime('%Y-%m', 'now', '-12 months')`
      ).bind(cityL, stateL).first();
      if (yourPerf) {
        profile.your_avg_adr = Math.round((yourPerf.avg_adr || 0) * 100) / 100;
        profile.your_avg_occupancy = Math.round(yourPerf.avg_occ || 0);
        profile.your_total_revenue = Math.round(yourPerf.total_rev || 0);
      }

      // Your market occupancy from PriceLabs
      const plOcc = await env.DB.prepare(
        `SELECT AVG(CAST(occupancy_next_30 AS REAL)) as your_occ, AVG(CAST(market_occupancy_next_30 AS REAL)) as mkt_occ FROM pricelabs_listings pl JOIN properties p ON pl.property_id = p.id WHERE LOWER(p.city) = ? AND LOWER(p.state) = ?`
      ).bind(cityL, stateL).first();
      if (plOcc && plOcc.mkt_occ) {
        profile.str_avg_occupancy = Math.round(plOcc.mkt_occ);
        if (plOcc.your_occ && !profile.your_avg_occupancy) profile.your_avg_occupancy = Math.round(plOcc.your_occ);
      }
    }
  } catch {}

  // 4. Seasonality
  try {
    const { results: seasons } = await env.DB.prepare(
      `SELECT month_number, multiplier, avg_occupancy, avg_adr FROM market_seasonality WHERE LOWER(city) = ? AND LOWER(state) = ? ORDER BY month_number`
    ).bind(cityL, stateL).all();
    if (seasons && seasons.length >= 6) {
      const peakThreshold = 1.1;
      const lowThreshold = 0.85;
      const peakMonths = seasons.filter(s => (s.multiplier || 1) >= peakThreshold).map(s => s.month_number);
      const lowMonths = seasons.filter(s => (s.multiplier || 1) <= lowThreshold).map(s => s.month_number);
      const maxMult = Math.max(...seasons.map(s => s.multiplier || 1));
      profile.peak_months = JSON.stringify(peakMonths);
      profile.low_months = JSON.stringify(lowMonths);
      profile.peak_multiplier = Math.round(maxMult * 100) / 100;
    }
  } catch {}

  // 5. ADR trend (3 month comparison from snapshots)
  try {
    const recent = await env.DB.prepare(
      `SELECT avg_daily_rate, active_listings, snapshot_date FROM market_snapshots WHERE LOWER(city) = ? AND LOWER(state) = ? ORDER BY snapshot_date DESC LIMIT 2`
    ).bind(cityL, stateL.toLowerCase()).all();
    if (recent.results && recent.results.length >= 2) {
      const newer = recent.results[0];
      const older = recent.results[1];
      if (older.avg_daily_rate > 0) profile.adr_trend_3mo = Math.round((newer.avg_daily_rate - older.avg_daily_rate) / older.avg_daily_rate * 100);
      if (older.active_listings > 0) profile.listing_count_trend_3mo = Math.round((newer.active_listings - older.active_listings) / older.active_listings * 100);
    }
  } catch {}

  // Upsert into market_profiles
  const fields = ['str_listing_count','str_avg_adr','str_median_adr','str_avg_occupancy','str_avg_rating','str_avg_reviews','str_property_mix','str_bedroom_mix','str_price_bands','str_top_hosts','str_superhost_pct','ltr_avg_rent','ltr_median_rent','ltr_active_listings','your_property_count','your_avg_adr','your_avg_occupancy','your_total_revenue','your_avg_rating','adr_trend_3mo','listing_count_trend_3mo','new_listings_30d','peak_months','low_months','peak_multiplier'];
  const setClauses = fields.map(f => `${f}=excluded.${f}`).join(',');
  const placeholders = fields.map(() => '?').join(',');
  const values = fields.map(f => profile[f] !== undefined ? profile[f] : null);

  await env.DB.prepare(
    `INSERT INTO market_profiles (city, state, ${fields.join(',')}, last_updated) VALUES (?, ?, ${placeholders}, datetime('now')) ON CONFLICT(city, state) DO UPDATE SET ${setClauses}, last_updated=datetime('now')`
  ).bind(city, stateU, ...values).run();

  return profile;
}

async function getMarketProfile(city, state, env) {
  // Build/refresh profile first
  await buildMarketProfile(city, state, env);

  // Fetch the profile
  const profile = await env.DB.prepare(`SELECT * FROM market_profiles WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`).bind(city, state).first();

  // Fetch seasonality data for the chart
  const { results: seasonality } = await env.DB.prepare(`SELECT month_number, multiplier, avg_occupancy, avg_adr FROM market_seasonality WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY month_number`).bind(city, state).all();

  // Fetch your properties in this market
  const { results: yourProperties } = await env.DB.prepare(
    `SELECT p.id, p.name, p.address, p.unit_number, p.bedrooms, p.bathrooms, p.property_type, p.rental_type, p.listing_status, p.is_managed, pl.base_price as pl_base, pl.recommended_base_price as pl_rec, pl.occupancy_next_30, pl.market_occupancy_next_30 FROM properties p LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id WHERE LOWER(p.city) = LOWER(?) AND LOWER(p.state) = LOWER(?) AND (p.is_research != 1 OR p.is_research IS NULL) AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)`
  ).bind(city, state).all();

  // Fetch recent snapshots for trend chart
  const { results: snapshots } = await env.DB.prepare(
    `SELECT snapshot_date, avg_daily_rate, median_daily_rate, avg_occupancy, active_listings FROM market_snapshots WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) ORDER BY snapshot_date DESC LIMIT 12`
  ).bind(city, state).all();

  // Monthly revenue trend — your actual performance by month in this market
  let monthlyRevenue = [];
  try {
    const { results: mr } = await env.DB.prepare(
      `SELECT ma.month, SUM(ma.total_revenue) as revenue, SUM(ma.booked_nights) as nights, SUM(ma.available_nights) as avail, ROUND(SUM(ma.total_revenue) * 1.0 / NULLIF(SUM(ma.booked_nights), 0)) as adr, ROUND(SUM(ma.booked_nights) * 100.0 / NULLIF(SUM(ma.available_nights), 0)) as occ FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE LOWER(p.city) = LOWER(?) AND LOWER(p.state) = LOWER(?) AND (p.is_research != 1 OR p.is_research IS NULL) AND (p.is_managed = 0 OR p.is_managed IS NULL) AND p.id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL) GROUP BY ma.month ORDER BY ma.month`
    ).bind(city, state).all();
    monthlyRevenue = mr || [];
  } catch {}

  // Top hosts — from master_listings crawl data
  let topHosts = [];
  try {
    const { results: hosts } = await env.DB.prepare(
      `SELECT host_name, COUNT(*) as listings, ROUND(AVG(rating), 2) as avg_rating, ROUND(AVG(nightly_rate)) as avg_rate, SUM(CASE WHEN superhost = 1 THEN 1 ELSE 0 END) as is_superhost FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND status = 'active' AND host_name IS NOT NULL AND host_name != '' GROUP BY host_name HAVING COUNT(*) >= 2 ORDER BY COUNT(*) DESC LIMIT 10`
    ).bind(city, state).all();
    topHosts = hosts || [];
  } catch {}

  // Market alerts relevant to this city
  let alerts = [];
  try {
    if (profile) {
      if (profile.adr_trend_3mo && Math.abs(profile.adr_trend_3mo) >= 10) {
        const dir = profile.adr_trend_3mo > 0 ? 'up' : 'down';
        alerts.push({ type: profile.adr_trend_3mo > 0 ? 'info' : 'warning', text: 'ADR trending ' + dir + ' ' + Math.abs(profile.adr_trend_3mo) + '% over 3 months' });
      }
      if (profile.listing_count_trend_3mo && Math.abs(profile.listing_count_trend_3mo) >= 15) {
        alerts.push({ type: profile.listing_count_trend_3mo > 0 ? 'warning' : 'info', text: 'Listing count ' + (profile.listing_count_trend_3mo > 0 ? 'increased' : 'decreased') + ' ' + Math.abs(profile.listing_count_trend_3mo) + '% — competition shift' });
      }
      if ((profile.new_listings_30d || 0) >= 8) {
        alerts.push({ type: 'warning', text: profile.new_listings_30d + ' new listings in last 30 days — watch for saturation' });
      }
      if (profile.your_avg_adr && profile.str_avg_adr && profile.your_avg_adr < profile.str_avg_adr * 0.85) {
        alerts.push({ type: 'danger', text: 'Your ADR ($' + Math.round(profile.your_avg_adr) + ') is ' + Math.round((1 - profile.your_avg_adr / profile.str_avg_adr) * 100) + '% below market ($' + Math.round(profile.str_avg_adr) + ') — review pricing' });
      }
      if (profile.your_avg_occupancy && profile.str_avg_occupancy && profile.your_avg_occupancy > profile.str_avg_occupancy + 15) {
        alerts.push({ type: 'info', text: 'Your occupancy (' + profile.your_avg_occupancy + '%) exceeds market (' + profile.str_avg_occupancy + '%) by ' + (profile.your_avg_occupancy - profile.str_avg_occupancy) + ' pts — room to raise rates' });
      }
    }
  } catch {}

  return json({ profile: profile || {}, seasonality: seasonality || [], your_properties: yourProperties || [], snapshots: snapshots || [], monthly_revenue: monthlyRevenue, top_hosts: topHosts, alerts });
}

async function getAllMarketProfiles(env) {
  // Get all unique markets from properties + watchlist
  const { results: propMarkets } = await env.DB.prepare(
    `SELECT DISTINCT city, state FROM properties WHERE city IS NOT NULL AND state IS NOT NULL AND (is_research != 1 OR is_research IS NULL) AND id NOT IN (SELECT DISTINCT parent_id FROM properties WHERE parent_id IS NOT NULL)`
  ).all();
  const { results: watchMarkets } = await env.DB.prepare(
    `SELECT DISTINCT city, state FROM market_watchlist`
  ).all();

  // Merge and dedupe
  const seen = new Set();
  const allMarkets = [];
  for (const m of [...(propMarkets || []), ...(watchMarkets || [])]) {
    const key = (m.city || '').toLowerCase() + '|' + (m.state || '').toUpperCase();
    if (!seen.has(key) && m.city && m.state) { seen.add(key); allMarkets.push({ city: m.city, state: m.state }); }
  }

  // Build/refresh profiles for all markets
  for (const m of allMarkets) {
    try { await buildMarketProfile(m.city, m.state, env); } catch {}
  }

  // Fetch all profiles
  const { results: profiles } = await env.DB.prepare(`SELECT * FROM market_profiles ORDER BY your_property_count DESC, city`).all();

  return json({ profiles: profiles || [], market_count: allMarkets.length });
}

async function enrichMarketProfile(request, env) {
  const { city, state } = await request.json();
  if (!city || !state) return json({ error: 'city and state required' }, 400);

  // Get current profile data
  const profile = await env.DB.prepare(`SELECT * FROM market_profiles WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`).bind(city, state).first();
  if (!profile) return json({ error: 'Profile not found — build it first' }, 404);

  // Build AI prompt with all available data
  const propertyMix = profile.str_property_mix ? JSON.parse(profile.str_property_mix) : [];
  const bedroomMix = profile.str_bedroom_mix ? JSON.parse(profile.str_bedroom_mix) : [];
  const priceBands = profile.str_price_bands ? JSON.parse(profile.str_price_bands) : [];
  const peakMonths = profile.peak_months ? JSON.parse(profile.peak_months) : [];
  const lowMonths = profile.low_months ? JSON.parse(profile.low_months) : [];
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const prompt = `You are an expert real estate market analyst specializing in short-term and long-term rental markets. Analyze this market comprehensively.

MARKET: ${city}, ${state}

STR LANDSCAPE:
  Active listings: ${profile.str_listing_count || 'unknown'}
  Avg ADR: $${profile.str_avg_adr || '?'}/night | Median ADR: $${profile.str_median_adr || '?'}/night
  Avg Rating: ${profile.str_avg_rating || '?'} | Avg Reviews: ${profile.str_avg_reviews || '?'}
  Superhost %: ${profile.str_superhost_pct || '?'}%
  New listings (30d): ${profile.new_listings_30d || 0}
  Property types: ${propertyMix.map(t => t.type + ' ' + t.pct + '%').join(', ') || 'unknown'}
  Bedroom mix: ${bedroomMix.map(b => b.beds + 'BR ' + b.pct + '%').join(', ') || 'unknown'}
  Price bands: ${priceBands.map(b => b.band + ': ' + b.ct).join(', ') || 'unknown'}

LTR DATA:
  Avg rent: $${profile.ltr_avg_rent || '?'}/mo | Median: $${profile.ltr_median_rent || '?'}/mo
  Active LTR listings: ${profile.ltr_active_listings || '?'}

SEASONALITY:
  Peak months: ${peakMonths.map(m => monthNames[m-1]).join(', ') || 'unknown'} (${profile.peak_multiplier || '?'}x multiplier)
  Low months: ${lowMonths.map(m => monthNames[m-1]).join(', ') || 'unknown'}

TRENDS:
  ADR trend (3mo): ${profile.adr_trend_3mo !== null ? profile.adr_trend_3mo + '%' : 'unknown'}
  Listing count trend: ${profile.listing_count_trend_3mo !== null ? profile.listing_count_trend_3mo + '%' : 'unknown'}

OPERATOR'S PORTFOLIO IN THIS MARKET:
  Properties: ${profile.your_property_count || 0}
  Their Avg ADR: $${profile.your_avg_adr || '?'}/night
  Their Occupancy: ${profile.your_avg_occupancy || '?'}%
  Their Total Revenue (12mo): $${profile.your_total_revenue ? profile.your_total_revenue.toLocaleString() : '?'}

Respond ONLY with valid JSON (no markdown, no backticks):
{
  "demand_drivers": ["list of 4-6 specific things that bring visitors/renters to this area — tourism attractions, hospitals, universities, military bases, corporate offices, events, etc."],
  "regulatory_notes": "2-4 sentences about STR regulations in this city/county — licensing requirements, restrictions, HOA prevalence, recent changes. If unknown, say so honestly.",
  "investment_thesis": "3-5 sentences: is this a good market to invest in? Why or why not? Consider supply/demand balance, ADR trends, competition level, and seasonality.",
  "competitive_position": "2-4 sentences about how the operator's portfolio compares to the market. If no properties here, give general advice for entering this market.",
  "recommendations": ["3-5 specific actionable recommendations — pricing adjustments, amenity additions, listing optimization, new property types to target, etc."],
  "risk_factors": ["2-4 specific risks — regulatory changes, oversupply, seasonal dependency, economic factors, etc."],
  "demographics": {
    "population": "estimated population of the city/metro area",
    "median_household_income": "estimated median household income",
    "top_employers": ["list of 3-5 major employers or industries in the area"],
    "tourism_profile": "2-3 sentences about tourism — annual visitor count if known, key attractions, events, conference centers, beaches, ski resorts, etc.",
    "area_character": "1-2 sentences — is this urban, suburban, rural, resort, college town, military town, medical hub, etc.?",
    "transportation": "nearest airports, distance to major cities, highway access, public transit availability",
    "growth_trend": "1-2 sentences — is the area growing, stable, or declining? New development, population trends?"
  }
}`;

  // Call AI
  const aiResult = await callAIWithFallback(env, 'market_enrich', prompt, 3000, 2000);
  if (!aiResult) return json({ error: 'AI call failed — check API keys and budget' }, 500);

  // Parse AI response
  let parsed;
  try {
    const cleaned = aiResult.text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return json({ error: 'AI returned invalid JSON', raw: aiResult.text.substring(0, 500) }, 500);
  }

  // Store enrichment
  await env.DB.prepare(
    `UPDATE market_profiles SET ai_demand_drivers = ?, ai_regulatory_notes = ?, ai_investment_thesis = ?, ai_competitive_position = ?, ai_recommendations = ?, ai_risk_factors = ?, demographics_json = ?, demographics_updated_at = datetime('now'), ai_enriched_at = datetime('now') WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`
  ).bind(
    JSON.stringify(parsed.demand_drivers || []),
    parsed.regulatory_notes || null,
    parsed.investment_thesis || null,
    parsed.competitive_position || null,
    JSON.stringify(parsed.recommendations || []),
    JSON.stringify(parsed.risk_factors || []),
    parsed.demographics ? JSON.stringify(parsed.demographics) : null,
    city, state
  ).run();

  return json({ ok: true, provider: aiResult.provider, enrichment: parsed });
}

// ─── Market Watchlist ────────────────────────────────────────────────────────
async function getMarketWatchlist(env) {
  const { results } = await env.DB.prepare(`SELECT mw.*, (SELECT COUNT(*) FROM properties p WHERE LOWER(p.city) = LOWER(mw.city) AND LOWER(p.state) = LOWER(mw.state) AND p.is_research = 0) as owned_properties, (SELECT COUNT(*) FROM properties p WHERE LOWER(p.city) = LOWER(mw.city) AND LOWER(p.state) = LOWER(mw.state) AND p.is_research = 1) as research_properties FROM market_watchlist mw ORDER BY mw.tier ASC, mw.city ASC`).all();
  return json({ watchlist: results || [] });
}

async function upsertWatchlistMarket(request, env) {
  const body = await request.json().catch(() => ({}));
  if (!body.city || !body.state) return json({ error: 'city and state required' }, 400);
  const tier = body.tier || 1;
  const freq = tier === 1 ? 'weekly' : tier === 2 ? 'biweekly' : 'monthly';
  const radius = body.radius_miles || 25;
  await env.DB.prepare(`INSERT INTO market_watchlist (city, state, tier, frequency, radius_miles, notes, auto_created, updated_at) VALUES (?,?,?,?,?,?,?,datetime('now')) ON CONFLICT(city, state) DO UPDATE SET tier = excluded.tier, frequency = excluded.frequency, radius_miles = excluded.radius_miles, notes = COALESCE(excluded.notes, notes), updated_at = datetime('now')`)
    .bind(body.city, body.state, tier, body.frequency || freq, radius, body.notes || null, body.auto_created || 0).run();
  return json({ ok: true, message: body.city + ', ' + body.state + ' added to watchlist (Tier ' + tier + ', ' + radius + 'mi radius)' });
}

// ─── Auto-crawl: Fetch STR listings from SearchAPI for a watchlist market ─────
// Called during daily cron for each due market. Populates master_listings so
// buildMarketProfile has real data to aggregate. Uses Airbnb engine only
// (VRBO/Booking via Google search don't yield structured pricing data).
// RentCast is NEVER called here — it is strictly LTR-only and reserved for
// explicit user-triggered market data refreshes.
async function crawlMarketListings(city, state, env) {
  if (!env.SEARCHAPI_KEY) return { crawled: 0, new: 0, updated: 0, skipped: 'no_api_key' };

  let found = 0, newL = 0, updL = 0;
  const searchQ = city + ', ' + state;

  // Helper: extract ALL available data from a SearchAPI Airbnb listing object
  function parseAirbnbListing(l) {
    // Nightly rate extraction (multiple possible formats)
    let nightlyRate = 0;
    let cleaningFee = 0;
    let serviceFee = 0;
    if (l.price) {
      nightlyRate = l.price.extracted_price || l.price.rate || 0;
      if (!nightlyRate && l.price.extracted_total_price) nightlyRate = Math.round(l.price.extracted_total_price / 3);
      if (l.price.price_details && Array.isArray(l.price.price_details)) {
        for (const d of l.price.price_details) {
          const lbl = (d.label || '').toLowerCase();
          if (lbl.includes('clean')) cleaningFee = Math.abs(d.amount || 0);
          if (lbl.includes('service')) serviceFee = Math.abs(d.amount || 0);
        }
      }
    }
    if (l.pricing) {
      nightlyRate = nightlyRate || l.pricing.nightly_rate || l.pricing.rate || 0;
    }
    if (nightlyRate <= 0) return null;

    // Amenities extraction
    let amenitiesJson = null;
    if (l.amenities && Array.isArray(l.amenities)) {
      amenitiesJson = JSON.stringify(l.amenities.slice(0, 50));
    } else if (l.amenity_ids && Array.isArray(l.amenity_ids)) {
      amenitiesJson = JSON.stringify(l.amenity_ids.slice(0, 50));
    } else if (l.previewAmenities || l.preview_amenities) {
      amenitiesJson = JSON.stringify((l.previewAmenities || l.preview_amenities).slice(0, 50));
    }

    // Photos extraction
    let photosJson = null;
    const photos = l.images || l.photos || l.pictures || l.xl_picture_urls || [];
    if (Array.isArray(photos) && photos.length > 0) {
      photosJson = JSON.stringify(photos.slice(0, 8).map(p => typeof p === 'string' ? p : (p.url || p.picture || p.thumbnail || '')).filter(Boolean));
    } else if (l.thumbnail || l.image || l.xl_picture_url) {
      photosJson = JSON.stringify([l.thumbnail || l.image || l.xl_picture_url]);
    }

    return {
      platform: 'airbnb', listing_type: 'str',
      platform_id: l.id ? String(l.id) : null,
      listing_url: l.link || l.listing_url || l.url || (l.id ? 'https://www.airbnb.com/rooms/' + l.id : null),
      title: (l.title || l.name || 'Airbnb listing').substring(0, 200),
      description: (l.description || l.subtitle || '').substring(0, 500) || null,
      host_name: l.host_name || (l.host ? l.host.name : null) || l.primary_host?.first_name || null,
      city, state,
      latitude: l.latitude || l.lat || (l.coordinate ? l.coordinate.latitude : null) || null,
      longitude: l.longitude || l.lng || (l.coordinate ? l.coordinate.longitude : null) || null,
      bedrooms: l.beds || l.bedroom_count || l.bedrooms || null,
      bathrooms: l.bathrooms || l.bathroom_count || null,
      sleeps: l.guest_capacity || l.guests || l.person_capacity || null,
      property_type: l.property_type || l.room_type || l.room_type_category || null,
      nightly_rate: Math.round(nightlyRate),
      weekly_rate: l.pricing?.weekly_rate || l.weekly_price || null,
      monthly_rate: l.pricing?.monthly_rate || l.monthly_price || null,
      cleaning_fee: Math.round(cleaningFee),
      service_fee: Math.round(serviceFee),
      rating: l.rating || l.overall_rating || l.star_rating || null,
      review_count: l.reviews || l.review_count || l.reviews_count || 0,
      superhost: (l.is_superhost || l.superhost || l.host?.is_superhost) ? 1 : 0,
      amenities_json: amenitiesJson,
      photos_json: photosJson,
      raw_data: JSON.stringify(l).substring(0, 4000),
    };
  }

  // ── Strategy: 2 targeted Airbnb searches with different bedroom filters ──
  // This gives broader market coverage than one unfiltered search.
  // Search 1: small units (1-2 BR) — studios, apartments, condos
  // Search 2: larger units (3+ BR) — houses, multi-BR
  const searchConfigs = [
    { label: '1-2BR', params: { min_bedrooms: '1', max_bedrooms: '2' } },
    { label: '3+BR', params: { min_bedrooms: '3' } },
  ];

  for (const config of searchConfigs) {
    try {
      const cin = new Date(Date.now() + 14 * 86400000);
      const cout = new Date(cin.getTime() + 3 * 86400000);
      const saParams = new URLSearchParams({
        engine: 'airbnb',
        q: searchQ,
        check_in_date: cin.toISOString().split('T')[0],
        check_out_date: cout.toISOString().split('T')[0],
        adults: '2',
        ...config.params,
      });
      await trackApiCall(env, 'searchapi', 'cron_airbnb_' + config.label, true);
      const saResp = await fetch('https://www.searchapi.io/api/v1/search?' + saParams.toString(), {
        headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY, 'Accept': 'application/json' }
      });
      if (saResp.ok) {
        const saData = await saResp.json();
        const listings = saData.properties || saData.results || [];
        for (const l of listings.slice(0, 20)) {
          const parsed = parseAirbnbListing(l);
          if (!parsed) continue;
          const res = await upsertMasterListing(env, parsed, null);
          found++;
          if (res.action === 'created') newL++; else updL++;
        }
      }
    } catch (e) {
      console.error('[CRON] Airbnb ' + config.label + ' crawl error for ' + city + ', ' + state + ':', e.message);
    }
  }

  // Log crawl job
  try {
    await env.DB.prepare(`INSERT INTO crawl_jobs (user_id, job_type, status, target_city, target_state, target_platform, listings_found, listings_new, listings_updated, started_at, completed_at) VALUES (NULL, 'auto_crawl', 'complete', ?, ?, 'airbnb', ?, ?, ?, datetime('now'), datetime('now'))`)
      .bind(city, state, found, newL, updL).run();
  } catch {}

  // Update watchlist with crawl stats
  try {
    await env.DB.prepare(`UPDATE market_watchlist SET listing_count = (SELECT COUNT(*) FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND status = 'active'), avg_price = (SELECT ROUND(AVG(nightly_rate), 2) FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND status = 'active' AND nightly_rate > 0), new_listings_30d = (SELECT COUNT(*) FROM master_listings WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?) AND first_seen >= datetime('now', '-30 days')) WHERE LOWER(city) = LOWER(?) AND LOWER(state) = LOWER(?)`)
      .bind(city, state, city, state, city, state, city, state).run();
  } catch {}

  return { crawled: found, new: newL, updated: updL };
}

async function autoPopulateWatchlist(env) {
  // Tier 1 — markets where you own/manage properties (not research)
  const { results: ownedMarkets } = await env.DB.prepare(`SELECT DISTINCT city, state FROM properties WHERE (is_research = 0 OR is_research IS NULL) AND city IS NOT NULL AND city != '' GROUP BY LOWER(city), LOWER(state)`).all();
  let added = 0;
  for (const m of (ownedMarkets || [])) {
    await env.DB.prepare(`INSERT INTO market_watchlist (city, state, tier, frequency, auto_created, updated_at) VALUES (?,?,1,'biweekly',1,datetime('now')) ON CONFLICT(city, state) DO UPDATE SET tier = MIN(tier, 1), frequency = 'biweekly', updated_at = datetime('now')`).bind(m.city, m.state).run();
    added++;
  }
  // Tier 2 — research property markets
  const { results: researchMarkets } = await env.DB.prepare(`SELECT DISTINCT city, state FROM properties WHERE is_research = 1 AND city IS NOT NULL AND city != '' GROUP BY LOWER(city), LOWER(state)`).all();
  for (const m of (researchMarkets || [])) {
    await env.DB.prepare(`INSERT INTO market_watchlist (city, state, tier, frequency, auto_created, updated_at) VALUES (?,?,2,'biweekly',1,datetime('now')) ON CONFLICT(city, state) DO NOTHING`).bind(m.city, m.state).run();
    added++;
  }
  return json({ ok: true, message: 'Auto-populated ' + added + ' markets from your properties' });
}

// ─── Property Calendar (unified view) ────────────────────────────────────────
async function getPropertyCalendar(propertyId, params, env) {
  const from = params.get('from') || new Date().toISOString().split('T')[0];
  const days = parseInt(params.get('days')) || 90;
  const to = params.get('to') || new Date(new Date(from).getTime() + days * 86400000).toISOString().split('T')[0];

  // 1. Guesty calendar data
  const { results: guestyDays } = await env.DB.prepare(
    `SELECT gc.date, gc.price as guesty_price, gc.status, gc.min_nights, gc.pl_recommended_price, gc.price_discrepancy FROM guesty_calendar gc WHERE gc.property_id = ? AND gc.date >= ? AND gc.date <= ? ORDER BY gc.date`
  ).bind(propertyId, from, to).all();

  // 2. PriceLabs rates
  let plRates = [];
  const plLink = await env.DB.prepare(`SELECT pl_listing_id FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();
  if (plLink) {
    const { results } = await env.DB.prepare(
      `SELECT rate_date as date, price as pl_price, min_stay as pl_min_stay, is_available as pl_available FROM pricelabs_rates WHERE pl_listing_id = ? AND rate_date >= ? AND rate_date <= ? ORDER BY rate_date`
    ).bind(plLink.pl_listing_id, from, to).all();
    plRates = results || [];
  }

  // 3. Latest strategy for projected rates
  const strategy = await env.DB.prepare(
    `SELECT base_nightly_rate, weekend_rate, peak_season_markup, low_season_discount, cleaning_fee, projected_occupancy, strategy_name FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(propertyId).first();

  // 4. Reservations for booking status overlay
  const { results: reservations } = await env.DB.prepare(
    `SELECT check_in, check_out, source_file as platform, channel, confirmation_code, accommodation_fare as revenue, guest_count as guests, demand_segment FROM guesty_reservations WHERE property_id = ? AND check_out >= ? AND check_in <= ? AND ${LIVE_STATUS_SQL} ORDER BY check_in`
  ).bind(propertyId, from, to).all();

  // Build lookup maps
  const guestyMap = {};
  for (const g of (guestyDays || [])) guestyMap[g.date] = g;
  const plMap = {};
  for (const p of plRates) plMap[p.date] = p;

  // Generate day-by-day calendar
  const calendar = [];
  const startDate = new Date(from + 'T00:00:00');
  const endDate = new Date(to + 'T00:00:00');
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const dow = d.getDay();
    const month = d.getMonth();
    const isWeekend = dow === 5 || dow === 6;

    const gc = guestyMap[dateStr] || {};
    const pl = plMap[dateStr] || {};

    // Strategy projected rate
    let stratRate = null;
    if (strategy) {
      let base = isWeekend && strategy.weekend_rate ? strategy.weekend_rate : strategy.base_nightly_rate;
      // Simple seasonal: peak = Jun-Aug, Dec; low = Jan-Mar
      if ([5, 6, 7, 11].includes(month) && strategy.peak_season_markup) {
        base = base * (1 + strategy.peak_season_markup / 100);
      } else if ([0, 1, 2].includes(month) && strategy.low_season_discount) {
        base = base * (1 - strategy.low_season_discount / 100);
      }
      stratRate = Math.round(base);
    }

    // Find reservation for this date
    let booking = null;
    for (const r of (reservations || [])) {
      if (dateStr >= r.check_in && dateStr < r.check_out) {
        booking = { platform: r.platform || r.channel, confirmation: r.confirmation_code, guests: r.guests, segment: r.demand_segment || null };
        break;
      }
    }

    // Determine status
    let status = 'available';
    if (booking) status = 'booked';
    else if (gc.status === 'blocked' || gc.status === 'unavailable') status = 'blocked';

    // Discrepancy calculation
    let discrepancy = null;
    let discrepancyLevel = 'none';
    const livePrice = gc.guesty_price || null;
    const recPrice = pl.pl_price || gc.pl_recommended_price || null;
    if (livePrice && recPrice && livePrice > 0 && recPrice > 0) {
      discrepancy = Math.round(livePrice - recPrice);
      const pctDiff = Math.abs(discrepancy) / recPrice * 100;
      if (pctDiff <= 5) discrepancyLevel = 'aligned';
      else if (pctDiff <= 15) discrepancyLevel = 'minor';
      else discrepancyLevel = 'major';
    }

    calendar.push({
      date: dateStr,
      dow,
      is_weekend: isWeekend,
      guesty_price: gc.guesty_price || null,
      guesty_status: gc.status || null,
      guesty_min_nights: gc.min_nights || null,
      pl_price: pl.pl_price || gc.pl_recommended_price || null,
      pl_min_stay: pl.pl_min_stay || null,
      pl_available: pl.pl_available !== undefined ? pl.pl_available : null,
      strategy_price: stratRate,
      status,
      booking,
      discrepancy,
      discrepancy_level: discrepancyLevel,
    });
  }

  return json({
    calendar,
    strategy: strategy ? { name: strategy.strategy_name, base: strategy.base_nightly_rate, weekend: strategy.weekend_rate, occ: strategy.projected_occupancy } : null,
    has_guesty: guestyDays.length > 0,
    has_pricelabs: plRates.length > 0,
    has_strategy: !!strategy,
    from,
    to,
  });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[arr[i] % chars.length];
  return code;
}

async function createShareCode(propertyId, request, env) {
  const body = await request.json().catch(() => ({}));
  const label = body.label || null;
  // Generate unique 5-char code
  let code = generateCode();
  let attempts = 0;
  while (attempts < 10) {
    try {
      await env.DB.prepare(`INSERT INTO property_shares (property_id, share_code, label) VALUES (?, ?, ?)`)
        .bind(propertyId, code, label).run();
      break;
    } catch { code = generateCode(); attempts++; }
  }
  const url = '/share/' + code;
  return json({ code, url, label, property_id: propertyId });
}

async function getShareCodes(propertyId, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM property_shares WHERE property_id = ? ORDER BY created_at DESC`).bind(propertyId).all();
  return json({ shares: results });
}

async function deleteShareCode(propertyId, request, env) {
  const body = await request.json().catch(() => ({}));
  if (body.code) {
    await env.DB.prepare(`DELETE FROM property_shares WHERE property_id = ? AND share_code = ?`).bind(propertyId, body.code).run();
  } else if (body.id) {
    await env.DB.prepare(`DELETE FROM property_shares WHERE property_id = ? AND id = ?`).bind(propertyId, body.id).run();
  }
  return json({ ok: true });
}

async function getSharedProperty(code, env) {
  const share = await env.DB.prepare(`SELECT * FROM property_shares WHERE share_code = ? AND (expires_at IS NULL OR expires_at > datetime('now'))`).bind(code).first();
  if (!share) return json({ error: 'Invalid or expired share link' }, 404);

  const pid = share.property_id;
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(pid).first();
  if (!property) return json({ error: 'Property not found' }, 404);

  // Gather all data
  const { results: amenities } = await env.DB.prepare(`SELECT a.* FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(pid).all();
  const { results: strategies } = await env.DB.prepare(`SELECT strategy_name, base_nightly_rate, weekend_rate, cleaning_fee, pet_fee, weekly_discount, monthly_discount, peak_season_markup, low_season_discount, min_nights, projected_occupancy, projected_annual_revenue, projected_monthly_avg, reasoning, ai_generated, created_at FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC LIMIT 10`).bind(pid).all();
  const { results: platforms } = await env.DB.prepare(`SELECT platform, listing_url, nightly_rate, cleaning_fee, rating, review_count, min_nights FROM property_platforms WHERE property_id = ?`).bind(pid).all();
  const { results: comparables } = await env.DB.prepare(`SELECT title, bedrooms, bathrooms, nightly_rate, rating, source, comp_type FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC LIMIT 15`).bind(pid).all();
  const { results: snapshots } = await env.DB.prepare(`SELECT snapshot_date, blended_adr, est_monthly_revenue, est_monthly_expenses, est_monthly_net, occupancy_30d, market_occ_30d FROM performance_snapshots WHERE property_id = ? ORDER BY snapshot_date DESC LIMIT 30`).bind(pid).all();
  const { results: reports } = await env.DB.prepare(`SELECT report_type, report_data, provider, created_at FROM analysis_reports WHERE property_id = ? ORDER BY created_at DESC LIMIT 30`).bind(pid).all();

  // PriceLabs data
  const plLink = await env.DB.prepare(`SELECT base_price, recommended_base_price, min_price, max_price, cleaning_fees, occupancy_next_7, market_occupancy_next_7, occupancy_next_30, market_occupancy_next_30, occupancy_next_60, market_occupancy_next_60, group_name, pl_listing_name, last_synced FROM pricelabs_listings WHERE property_id = ?`).bind(pid).first();

  // Compute financials including service costs
  // Get dynamic services
  const { results: propServices } = await env.DB.prepare(`SELECT name, monthly_cost FROM property_services WHERE property_id = ?`).bind(pid).all();
  const svcCost = (propServices || []).reduce((a, s) => a + s.monthly_cost, 0);
  const monthlyCost = (property.ownership_type === 'rental' ? (property.monthly_rent_cost || 0) : (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0)) + (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0) + svcCost;

  // Compute blended ADR from best available source
  let blendedADR = 0, estMonthlyRev = 0, estAnnualOcc = 0.50;
  if (plLink && plLink.base_price > 0) {
    const b = plLink.base_price, r = plLink.recommended_base_price || b, mx = plLink.max_price || b;
    blendedADR = Math.round(b * 0.4 + r * 0.3 + b * 1.2 * 0.2 + (b + mx) / 2 * 0.1);
    const fwd = plLink.occupancy_next_30 ? parseInt(plLink.occupancy_next_30) / 100 : 0;
    const mktFwd = plLink.market_occupancy_next_30 ? parseInt(plLink.market_occupancy_next_30) / 100 : 0;
    if (fwd >= 0.50) estAnnualOcc = fwd;
    else if (fwd > 0 && mktFwd > 0 && fwd > mktFwd) estAnnualOcc = Math.max(0.55, Math.min(0.70, fwd * 3.5));
    else if (fwd > 0) estAnnualOcc = Math.max(0.40, Math.min(0.60, fwd * 3));
  }
  // Fall back to strategies if no PriceLabs
  if (blendedADR === 0 && strategies && strategies.length > 0) {
    for (const s of strategies) {
      if (s.base_nightly_rate > 0 && (!s.min_nights || s.min_nights < 365)) {
        blendedADR = s.base_nightly_rate;
        if (s.projected_occupancy > 0) estAnnualOcc = s.projected_occupancy;
        break;
      }
    }
  }
  // Fall back to comparables
  if (blendedADR === 0 && comparables && comparables.length > 0) {
    const strComps = comparables.filter(c => c.nightly_rate > 0 && c.comp_type !== 'ltr');
    if (strComps.length > 0) blendedADR = Math.round(strComps.reduce((a, c) => a + c.nightly_rate, 0) / strComps.length);
  }
  if (blendedADR > 0) estMonthlyRev = Math.round(blendedADR * 30 * estAnnualOcc);

  // Parse reports
  // Only expose report metadata in shares, not the full AI analysis content
  const parsedReports = (reports || []).map(r => ({
    type: r.report_type,
    provider: r.provider,
    created_at: r.created_at,
    // Intentionally omit data/report_data — full AI analysis is not shared publicly
  }));

  return json({
    shared: true,
    share_label: share.label,
    property: {
      address: property.address, city: property.city, state: property.state, zip: property.zip,
      property_type: property.property_type, bedrooms: property.bedrooms, bathrooms: property.bathrooms,
      sqft: property.sqft, year_built: property.year_built, image_url: property.image_url,
      name: property.name, unit_number: property.unit_number,
      cleaning_fee: property.cleaning_fee, cleaning_cost: property.cleaning_cost,
      listing_url: property.listing_url, listing_status: property.listing_status,
      is_research: property.is_research, lot_acres: property.lot_acres,
      stories: property.stories, parking_spaces: property.parking_spaces,
    },
    financials: {
      monthly_expenses: Math.round(monthlyCost),
      ownership_type: property.ownership_type,
      estimated_value: property.estimated_value,
      purchase_price: property.purchase_price,
      monthly_mortgage: property.monthly_mortgage, monthly_insurance: property.monthly_insurance,
      annual_taxes: property.annual_taxes, hoa_monthly: property.hoa_monthly,
      monthly_rent_cost: property.monthly_rent_cost,
      expense_electric: property.expense_electric, expense_gas: property.expense_gas,
      expense_water: property.expense_water, expense_internet: property.expense_internet,
      expense_trash: property.expense_trash, expense_other: property.expense_other,
      blended_adr: blendedADR,
      est_annual_occ: Math.round(estAnnualOcc * 100),
      est_monthly_revenue: estMonthlyRev,
      est_monthly_net: estMonthlyRev - Math.round(monthlyCost),
      service_costs: Math.round(svcCost),
      services: (propServices || []).map(s => s.name + ' $' + s.monthly_cost),
    },
    amenities: amenities.map(a => ({ name: a.name, impact_score: a.impact_score, category: a.category })),
    strategies, platforms, comparables, snapshots, pricelabs: plLink, reports: parsedReports,
  });
}

function generatePWAIcon(size) {
  const s = parseInt(size) || 192;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
    <rect width="${s}" height="${s}" rx="${s * 0.15}" fill="#0f1117"/>
    <text x="50%" y="52%" text-anchor="middle" dominant-baseline="central" fill="#4ae3b5" font-family="sans-serif" font-weight="700" font-size="${s * 0.35}">FCP</text>
    <text x="50%" y="78%" text-anchor="middle" fill="#636d84" font-family="sans-serif" font-size="${s * 0.12}">PMR</text>
  </svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=604800' } });
}
const FRONTEND_HTML = "__FRONTEND_PLACEHOLDER__";
