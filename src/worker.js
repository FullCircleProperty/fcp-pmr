// FCP Property Market Research — Cloudflare Worker API
// With Auth, User Management, Admin Approval, DNS Config

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

async function trackAI(env, endpoint, provider, tokensApprox, success, errorMsg) {
  const costs = API_COSTS[provider] || {};
  const estCostCents = provider === 'anthropic' ? Math.round(tokensApprox * 1.5 / 1000 * 100) / 100 :
    provider === 'openai' ? Math.round(tokensApprox * 1.0 / 1000 * 100) / 100 : 0;
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
  pricing_compare: 'free',
};

// Smart AI router: picks the best provider based on task importance
async function pickAIProvider(env, taskName) {
  const tier = AI_TASK_TIER[taskName] || 'free';
  if (tier === 'premium') {
    if (env.ANTHROPIC_API_KEY && await checkBudget(env, 'anthropic')) return 'anthropic';
    if (env.OPENAI_API_KEY && await checkBudget(env, 'openai')) return 'openai';
    return env.AI ? 'workers_ai' : null;
  }
  if (env.AI) return 'workers_ai';
  if (env.ANTHROPIC_API_KEY && await checkBudget(env, 'anthropic')) return 'anthropic';
  if (env.OPENAI_API_KEY && await checkBudget(env, 'openai')) return 'openai';
  return null;
}

async function checkBudget(env, service) {
  try {
    const budgetRow = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('budget_' + service).first();
    const budget = budgetRow ? parseFloat(budgetRow.value) : 5.00;
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
        free_limit: info.free_limit < 999999 ? info.free_limit : null,
        remaining: info.free_limit < 999999 ? Math.max(0, info.free_limit - r.calls) : null,
        over_limit: info.free_limit < 999999 && r.calls > info.free_limit,
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
async function searchApiFetch(url, headers, env, endpoint) {
  await trackApiCall(env, 'searchapi', endpoint || 'search', true);
  return fetch(url, { headers });
}

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
      ['down_payment_pct','REAL'], ['zestimate','REAL'], ['zestimate_date','TEXT'], ['zillow_url','TEXT']
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
    // Guesty listing mapping
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS guesty_listings (id INTEGER PRIMARY KEY AUTOINCREMENT, guesty_listing_id TEXT UNIQUE, listing_name TEXT, listing_address TEXT, property_id INTEGER, auto_matched INTEGER DEFAULT 0, match_score REAL, created_at TEXT DEFAULT (datetime('now')))`).run();
    // Capital / one-time expenses
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS property_expenses (id INTEGER PRIMARY KEY AUTOINCREMENT, property_id INTEGER NOT NULL, name TEXT NOT NULL, amount REAL NOT NULL, category TEXT DEFAULT 'other', date_incurred TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')))`).run();
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
      if (!maExisting.has('taxes_you_owe')) await env.DB.prepare(`ALTER TABLE monthly_actuals ADD COLUMN taxes_you_owe REAL DEFAULT 0`).run();
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
    } catch {}
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

      // Hydrate API keys from DB into env (DB keys supplement env vars, env takes priority)
      try {
        const { results: dbKeys } = await env.DB.prepare(`SELECT key, value FROM app_settings WHERE key LIKE 'apikey_%'`).all();
        for (const row of (dbKeys || [])) {
          const envKey = row.key.replace('apikey_', '');
          if (!env[envKey] && row.value) env[envKey] = row.value;
        }
      } catch { /* app_settings may not exist yet */ }

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
      if (path.match(/^\/api\/properties\/\d+$/) && method === 'PUT') return await updateProperty(path.split('/').pop(), request, env, uid);
      if (path.match(/^\/api\/properties\/\d+$/) && method === 'DELETE') return await deleteProperty(path.split('/').pop(), env, uid);
      if (path.match(/^\/api\/properties\/\d+\/amenities$/) && method === 'GET') return await getPropertyAmenities(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/amenities$/) && method === 'POST') return await setPropertyAmenities(path.split('/')[3], request, env);
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
      if (path === '/api/keys/save' && method === 'POST') return await saveApiKey(request, env);
      if (path === '/api/keys/usage' && method === 'GET') return json({ usage: await getApiUsageSummary(env) });
      if (path === '/api/ai/status' && method === 'GET') return await getAiStatus(env);
      if (path === '/api/admin/rentcast-usage' && method === 'GET') return await getRentCastUsage(env);
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
      if (path.match(/^\/api\/properties\/\d+\/pl-strategy$/) && method === 'POST') return await generatePLStrategyRecommendation(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/revenue-optimize$/) && method === 'POST') return await generateRevenueOptimization(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/acquisition-analysis$/) && method === 'POST') return await generateAcquisitionAnalysis(path.split('/')[3], request, env);
      if (path.match(/^\/api\/properties\/\d+\/strategies$/) && method === 'GET') return await getStrategies(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/performance$/) && method === 'GET') return await getPerformanceHistory(path.split('/')[3], env);
      if (path.match(/^\/api\/properties\/\d+\/reports$/) && method === 'GET') return await getAnalysisReports(path.split('/')[3], env);
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
      // Capital expenses
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
    } catch (err) { console.error(err); return json({ error: err.message || 'Internal server error' }, 500); }
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
  return json({ message: 'Admin created with default password. You must change it on first login.', default_password: DEFAULT_ADMIN_PASSWORD });
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
  const userFilter = uid ? `WHERE (p.user_id = ${uid} OR p.user_id IS NULL)` : '';
  const { results } = await env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM property_amenities WHERE property_id = p.id) as amenity_count, (SELECT COUNT(*) FROM comparables WHERE property_id = p.id) as comparable_count, (SELECT COUNT(*) FROM pricing_strategies WHERE property_id = p.id) as strategy_count, (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as est_monthly_revenue, (SELECT COUNT(*) FROM properties WHERE parent_id = p.id) as child_count, (SELECT base_price FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_base_price, (SELECT recommended_base_price FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_rec_base, (SELECT min_price FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_min_price, (SELECT max_price FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_max_price, (SELECT cleaning_fees FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_cleaning, (SELECT occupancy_next_30 FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_occ_30d, (SELECT market_occupancy_next_30 FROM pricelabs_listings WHERE property_id = p.id LIMIT 1) as pl_mkt_occ_30d, (SELECT base_nightly_rate FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as analysis_nightly_rate, (SELECT cleaning_fee FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as analysis_cleaning, (SELECT projected_occupancy FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as analysis_occ, (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as analysis_monthly, (SELECT projected_annual_revenue FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as analysis_annual, (SELECT strategy_name FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as latest_strategy, (SELECT created_at FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as last_analyzed FROM properties p ${userFilter} ORDER BY p.parent_id ASC NULLS FIRST, p.updated_at DESC`).all();
  // Get performance trend data for badges
  let perfTrends = {};
  try {
    // Get latest 2 snapshots per property using simple approach
    const { results: allSnaps } = await env.DB.prepare(`SELECT property_id, snapshot_date, est_monthly_net, est_monthly_revenue, blended_adr FROM performance_snapshots ORDER BY snapshot_date DESC`).all();
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
  } catch {}

  return json({ properties: results, trends: perfTrends, actual_revenue: actualRevenue });
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
      const { results: season } = await env.DB.prepare(`SELECT month_number, avg_occupancy, avg_adr, multiplier, sample_size FROM market_seasonality WHERE city = ? AND state = ? ORDER BY month_number`).bind(property.city, property.state).all();
      seasonality = season || [];
    }
  } catch {}

  return json({ property, amenities, strategies, comparables, children, parent, pricelabs, pl_available: plAvailable, monthly_actuals: monthlyActuals, seasonality });
}

async function createProperty(request, env, uid) {
  const b = await request.json();
  try {
    const result = await env.DB.prepare(`INSERT INTO properties (user_id, name, address, city, state, zip, county, property_type, bedrooms, bathrooms, sqft, lot_acres, year_built, stories, purchase_price, estimated_value, annual_taxes, hoa_monthly, image_url, unit_number, ownership_type, monthly_mortgage, monthly_insurance, monthly_rent_cost, security_deposit, expense_electric, expense_gas, expense_water, expense_internet, expense_trash, expense_other, cleaning_fee, parent_id, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(uid || null, b.name || null, b.address, b.city, b.state, b.zip || null, b.county || null, b.property_type || 'single_family', b.bedrooms || 1, b.bathrooms || 1, b.sqft || null, b.lot_acres || null, b.year_built || null, b.stories || 1, b.purchase_price || null, b.estimated_value || null, b.annual_taxes || null, b.hoa_monthly || 0, b.image_url || null, b.unit_number || null, b.ownership_type || 'purchased', b.monthly_mortgage || 0, b.monthly_insurance || 0, b.monthly_rent_cost || 0, b.security_deposit || 0, b.expense_electric || 0, b.expense_gas || 0, b.expense_water || 0, b.expense_internet || 0, b.expense_trash || 0, b.expense_other || 0, b.cleaning_fee || 0, b.parent_id || null, b.latitude || null, b.longitude || null).run();
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
  for (const k of ['name','address','city','state','zip','property_type','bedrooms','bathrooms','sqft','lot_acres','year_built','stories','purchase_price','estimated_value','annual_taxes','hoa_monthly','listing_status','listing_url','image_url','unit_number','latitude','longitude','ownership_type','monthly_mortgage','monthly_insurance','monthly_rent_cost','security_deposit','expense_electric','expense_gas','expense_water','expense_internet','expense_trash','expense_other','cleaning_fee','cleaning_cost','service_guesty','service_lock','service_pricelabs','parent_id','parking_spaces','total_units_count','parcel_id','zoning','county','is_research','rental_type','purchase_date','loan_amount','interest_rate','loan_term_years','down_payment_pct','zestimate','zestimate_date','zillow_url']) {
    if (b[k] !== undefined) { fields.push(`${k} = ?`); values.push(b[k]); }
  }
  if (fields.length === 0) return json({ error: 'No fields to update' }, 400);
  fields.push(`updated_at = datetime('now')`);
  if (uid) { values.push(id, uid); await env.DB.prepare(`UPDATE properties SET ${fields.join(', ')} WHERE id = ? AND (user_id = ? OR user_id IS NULL)`).bind(...values).run(); }
  else { values.push(id); await env.DB.prepare(`UPDATE properties SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run(); }
  return json({ message: 'Property updated' });
}

async function deleteProperty(id, env, uid) {
  if (uid) await env.DB.prepare(`DELETE FROM properties WHERE id = ? AND (user_id = ? OR user_id IS NULL)`).bind(id, uid).run();
  else await env.DB.prepare(`DELETE FROM properties WHERE id = ?`).bind(id).run();
  return json({ message: 'Property deleted' });
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
  const stmt = env.DB.prepare(`DELETE FROM properties WHERE id = ?`);
  await env.DB.batch(ids.map(id => stmt.bind(id)));
  return json({ message: `Deleted ${ids.length} properties`, deleted: ids.length });
}

async function bulkEditProperties(request, env, uid) {
  const { ids, updates } = await request.json();
  if (!ids || !Array.isArray(ids) || ids.length === 0) return json({ error: 'ids array required' }, 400);
  if (!updates || typeof updates !== 'object') return json({ error: 'updates object required' }, 400);
  const allowed = ['property_type', 'listing_status', 'city', 'state', 'zip', 'bedrooms', 'bathrooms', 'sqft', 'lot_acres', 'year_built', 'purchase_price', 'estimated_value', 'annual_taxes', 'hoa_monthly'];
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
  if (city && state) { q += ` AND city = ? AND state = ?`; p.push(city, state); }
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
      }
    } catch (e) { /* AI optional */ }
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
      { name: 'Zillow Rentals', icon: '🏠', url: 'https://www.zillow.com/' + citySlug + '-' + stateSlug + '/rentals/' + (beds ? beds + '-_beds/' : '') },
      { name: 'Apartments.com', icon: '🏢', url: 'https://www.apartments.com/' + citySlug + '-' + stateSlug + '/' + (beds ? beds + '-bedrooms/' : '') },
      { name: 'Realtor.com', icon: '📋', url: 'https://www.realtor.com/apartments/' + citySlug + '_' + stateSlug + (beds ? '/beds-' + beds : '') },
      { name: 'Rent.com', icon: '🔑', url: 'https://www.rent.com/search?location=' + cityEnc + (beds ? '&beds=' + beds : '') },
      { name: 'Redfin Rentals', icon: '📊', url: 'https://www.redfin.com/city/' + citySlug + '-' + stateSlug + '/apartments-for-rent' + (beds ? '/filter/beds=' + beds : '') },
      { name: 'Trulia Rentals', icon: '🏘️', url: 'https://www.trulia.com/for_rent/' + citySlug + ',' + stateSlug + '/' + (beds ? beds + 'p_beds/' : '') },
      { name: 'HotPads', icon: '📍', url: 'https://hotpads.com/' + citySlug + '-' + stateSlug + '/apartments-for-rent' + (beds ? '?beds=' + beds : '') },
      { name: 'Furnished Finder', icon: '🛋️', url: 'https://www.furnishedfinder.com/housing/' + city.replace(/\s+/g, '-') + '-' + state },
    ];
  } else {
    results.search_links = [
      { name: 'Airbnb', icon: '🏡', url: 'https://www.airbnb.com/s/' + cityEnc + '/homes?adults=2' + (beds ? '&min_bedrooms=' + beds : '') + '&tab_id=home_tab' },
      { name: 'VRBO', icon: '🏖️', url: 'https://www.vrbo.com/search?destination=' + cityEnc + (beds ? '&minBedrooms=' + beds : '') },
      { name: 'Booking.com', icon: '📘', url: 'https://www.booking.com/searchresults.html?ss=' + cityEnc + '&no_rooms=1&nflt=ht_id%3D220' },
      { name: 'AirDNA', icon: '📈', url: 'https://www.airdna.co/vacation-rental-data/app/us/' + stateSlug + '/' + citySlug + '/overview' },
      { name: 'Furnished Finder', icon: '🛋️', url: 'https://www.furnishedfinder.com/housing/' + city.replace(/\s+/g, '-') + '-' + state },
      { name: 'AllTheRooms', icon: '🗺️', url: 'https://www.alltherooms.com/analytics/vacation-rental-data/' + citySlug + '-' + stateSlug },
      { name: 'Mashvisor', icon: '💹', url: 'https://www.mashvisor.com/market/' + stateSlug + '/' + citySlug },
      { name: 'Rabbu', icon: '🔍', url: 'https://www.rabbu.com/market/' + stateSlug + '/' + citySlug },
    ];
  }

  // ── RentCast: DISABLED for market search to conserve API calls ──
  // Use cached market snapshots instead. RentCast is reserved for property lookups only.
  // Market data can be refreshed via the dedicated "Refresh Market Data" button.
  {
    // Check for cached data first
    const cached = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE city = ? AND state = ? ORDER BY snapshot_date DESC LIMIT 1`).bind(city, state).first();
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
  const { results: histSnaps } = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE city = ? AND state = ? AND rental_type = ? ORDER BY snapshot_date DESC LIMIT 20`).bind(city, state, isLTR ? 'ltr' : 'str').all();
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
    searchLinks.push({ name: 'Zillow Rentals', icon: '🏠', url: 'https://www.zillow.com/' + citySlug + '-' + stateSlug + '/rentals/' + beds + '-_beds/' });
    searchLinks.push({ name: 'Apartments.com', icon: '🏢', url: 'https://www.apartments.com/' + citySlug + '-' + stateSlug + '/' + beds + '-bedrooms/' });
    searchLinks.push({ name: 'Realtor.com', icon: '📋', url: 'https://www.realtor.com/apartments/' + citySlug + '_' + stateSlug });
    searchLinks.push({ name: 'Rent.com', icon: '🔑', url: 'https://www.rent.com/search/' + cityEnc });
    searchLinks.push({ name: 'Redfin', icon: '📊', url: 'https://www.redfin.com/city/' + citySlug + '-' + stateSlug + '/apartments-for-rent' });
    searchLinks.push({ name: 'HotPads', icon: '📍', url: 'https://hotpads.com/' + citySlug + '-' + stateSlug + '/apartments-for-rent?beds=' + beds });
  } else {
    searchLinks.push({ name: 'Airbnb', icon: '🏡', url: 'https://www.airbnb.com/s/' + cityEnc + '/homes?adults=2&min_bedrooms=' + beds + '&tab_id=home_tab' });
    searchLinks.push({ name: 'VRBO', icon: '🏖️', url: 'https://www.vrbo.com/search?destination=' + cityEnc + '&minBedrooms=' + beds });
    searchLinks.push({ name: 'Booking.com', icon: '📘', url: 'https://www.booking.com/searchresults.html?ss=' + cityEnc + '&no_rooms=1&nflt=ht_id%3D220' });
    searchLinks.push({ name: 'Furnished Finder', icon: '🛋️', url: 'https://www.furnishedfinder.com/housing/' + (prop.city || '').replace(/\s+/g, '-') + '-' + prop.state });
    searchLinks.push({ name: 'AirDNA', icon: '📈', url: 'https://www.airdna.co/vacation-rental-data/app/us/' + stateSlug + '/' + citySlug + '/overview' });
    searchLinks.push({ name: 'Mashvisor', icon: '💹', url: 'https://www.mashvisor.com/market/' + stateSlug + '/' + citySlug });
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
      const cached = await env.DB.prepare(`SELECT median_daily_rate FROM market_snapshots WHERE city = ? AND state = ? ORDER BY snapshot_date DESC LIMIT 1`).bind(prop.city, prop.state).first();
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
      `SELECT * FROM master_listings WHERE city = ? AND state = ? AND listing_type = ? AND status = 'active' ORDER BY last_updated DESC LIMIT 20`
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
async function getApiKey(env, keyName) {
  // Env var takes priority (set via wrangler secret)
  if (env[keyName]) return env[keyName];
  // Fallback to DB-stored key
  try {
    const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('apikey_' + keyName).first();
    return row?.value || null;
  } catch { return null; }
}

async function checkApiKeyStatus(env) {
  const keyNames = ['RENTCAST_API_KEY', 'GOOGLE_PLACES_API_KEY', 'SEARCHAPI_KEY', 'PRICELABS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  const keys = {};
  const sources = {};
  for (const k of keyNames) {
    if (env[k]) {
      keys[k] = true;
      sources[k] = 'env';
    } else {
      try {
        const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = ?`).bind('apikey_' + k).first();
        keys[k] = !!(row?.value);
        sources[k] = row?.value ? 'db' : null;
      } catch {
        keys[k] = false;
        sources[k] = null;
      }
    }
  }
  keys.WORKERS_AI = !!env.AI;
  sources.WORKERS_AI = env.AI ? 'env' : null;
  return json({ keys, sources });
}

async function saveApiKey(request, env) {
  const { key, value } = await request.json();
  const allowed = ['RENTCAST_API_KEY', 'GOOGLE_PLACES_API_KEY', 'SEARCHAPI_KEY', 'PRICELABS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
  if (!allowed.includes(key)) return json({ error: 'Invalid key name' }, 400);
  if (!value || !value.trim()) {
    // Delete the key
    await env.DB.prepare(`DELETE FROM app_settings WHERE key = ?`).bind('apikey_' + key).run();
    return json({ message: key + ' removed' });
  }
  await env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')`)
    .bind('apikey_' + key, value.trim(), value.trim()).run();
  return json({ message: key + ' saved' });
}

async function getAiStatus(env) {
  const status = {
    workers_ai: { available: !!env.AI, provider: 'Cloudflare Workers AI', model: '@cf/meta/llama-3.1-70b-instruct', cost: 'Free (included with Workers)' },
    anthropic: { available: !!env.ANTHROPIC_API_KEY, provider: 'Anthropic', model: 'claude-sonnet-4-20250514', cost: 'Per-token billing' },
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

async function marketDeepDive(request, env) {
  const { city, state } = await request.json();
  if (!city || !state) return json({ error: 'city and state required' }, 400);

  // Get all snapshots for this city
  const { results: snaps } = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE city = ? AND state = ? ORDER BY snapshot_date DESC`).bind(city, state).all();
  // Get properties in this city
  const { results: props } = await env.DB.prepare(`SELECT * FROM properties WHERE city = ? AND state = ?`).bind(city, state).all();
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
      const prevInsights = await env.DB.prepare(`SELECT analysis, created_at FROM market_insights WHERE city = ? AND state = ? ORDER BY created_at DESC LIMIT 3`).bind(city, state).all();
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
  const { results: insights } = await env.DB.prepare(`SELECT * FROM market_insights WHERE city = ? AND state = ? ORDER BY created_at DESC LIMIT 10`).bind(city, state).all();

  return json({ city, state, snapshots: snaps, properties: props, comp_count: compCount, analysis, insights });
}

async function getMarketInsights(city, state, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM market_insights WHERE city = ? AND state = ? ORDER BY created_at DESC LIMIT 20`).bind(city, state).all();
  return json({ insights: results });
}
async function analyzePricing(propertyId, request, env) {
  const body = await request.json();
  const analysisType = body.analysis_type || 'str';
  const property = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(propertyId).first();
  if (!property) return json({ error: 'Property not found' }, 404);
  const { results: amenities } = await env.DB.prepare(`SELECT a.* FROM amenities a JOIN property_amenities pa ON pa.amenity_id = a.id WHERE pa.property_id = ?`).bind(propertyId).all();
  const { results: marketData } = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE city = ? AND state = ? ORDER BY snapshot_date DESC LIMIT 1`).bind(property.city, property.state).all();
  let { results: comparables } = await env.DB.prepare(`SELECT * FROM comparables WHERE property_id = ? ORDER BY scraped_at DESC`).bind(propertyId).all();
  const taxRate = await env.DB.prepare(`SELECT * FROM tax_rates WHERE state = ? LIMIT 1`).bind(property.state).first();
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

  // Seasonality data for this market
  let seasonData = [];
  try {
    const { results: s } = await env.DB.prepare(`SELECT month_number, multiplier, avg_occupancy, avg_adr FROM market_seasonality WHERE city = ? AND state = ? ORDER BY month_number`).bind(property.city, property.state).all();
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
  if (analysisType === 'str' || analysisType === 'both') {
    const strStrategies = generateAlgorithmicStrategies(property, amenities, marketData[0] || null, comparables, taxRate, plData, seasonData);
    all.push(...strStrategies);
    if (body.use_ai) {
      const aiProv = await pickAIProvider(env, 'pricing_analysis');
      if (aiProv) {
        const aiS = await generateAIStrategy(property, amenities, marketData[0], comparables, taxRate, aiProv, 'str', env, plData, platforms);
        if (aiS) { aiS.ai_provider = aiProv; all.push(aiS); }
      }
    }
  }

  // LTR strategies
  if (analysisType === 'ltr' || analysisType === 'both') {
    const ltrStrategies = generateLTRStrategies(property, amenities, marketData[0] || null, taxRate, comparables);
    all.push(...ltrStrategies);
    if (body.use_ai) {
      const aiProv2 = await pickAIProvider(env, 'pricing_analysis');
      if (aiProv2) {
        const aiL = await generateAIStrategy(property, amenities, marketData[0], comparables, taxRate, aiProv2, 'ltr', env, plData, platforms);
        if (aiL) { aiL.ai_provider = aiProv2; all.push(aiL); }
      }
    }
  }

  // Tag each strategy with rental_type so finance can filter STR vs LTR cleanly
  for (const s of all) {
    if (!s.rental_type) {
      s.rental_type = (s.min_nights >= 365 || (s.strategy_name || '').toUpperCase().includes('LTR')) ? 'ltr' : 'str';
    }
  }
  const stmt = env.DB.prepare(`INSERT INTO pricing_strategies (property_id, strategy_name, base_nightly_rate, weekend_rate, cleaning_fee, pet_fee, weekly_discount, monthly_discount, peak_season_markup, low_season_discount, min_nights, projected_occupancy, projected_annual_revenue, projected_monthly_avg, reasoning, ai_generated, rental_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  await env.DB.batch(all.map(s => stmt.bind(propertyId, s.strategy_name, s.base_nightly_rate, s.weekend_rate || 0, s.cleaning_fee || 0, s.pet_fee || 0, s.weekly_discount || 0, s.monthly_discount || 0, s.peak_season_markup || 0, s.low_season_discount || 0, s.min_nights || 1, s.projected_occupancy, s.projected_annual_revenue, s.projected_monthly_avg, s.reasoning, s.ai_generated ? 1 : 0, s.rental_type || 'str')));
  // Cleanup: keep only latest 5 strategy runs (each run produces 3-4 strategies)
  try {
    const { results: oldStrats } = await env.DB.prepare(`SELECT id FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC`).bind(propertyId).all();
    if (oldStrats && oldStrats.length > 20) {
      const keepIds = oldStrats.slice(0, 20).map(s => s.id);
      await env.DB.prepare(`DELETE FROM pricing_strategies WHERE property_id = ? AND id NOT IN (${keepIds.join(',')})`).bind(propertyId).run();
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
      await env.DB.prepare(`DELETE FROM analysis_reports WHERE property_id = ? AND report_type = 'pricing_analysis' AND id NOT IN (${keepIds.join(',')})`).bind(propertyId).run();
    }
  } catch {}

  return json({ property, amenities, market: marketData[0] || null, comparables_count: comparables.length, auto_fetch: autoFetchMsg, tax_rate: taxRate, strategies: all, analysis_type: analysisType, pricelabs: plData, platforms, sources, seasonality: seasonData, actuals: actualsData });
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
    const plOcc = parseInt(plData.occ_30d) / 100;
    const mktOcc = plData.mkt_occ_30d ? parseInt(plData.mkt_occ_30d) / 100 : 0;
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
  let clean = property.sqft ? Math.round(Math.max(75, Math.min(250, property.sqft * 0.06))) : 100;
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
  const avgStay = 3;

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

async function generateAIStrategy(property, amenities, market, comparables, taxRate, provider, mode, env, plData, platforms) {
  const modeLabel = mode === 'ltr' ? 'long-term rental (LTR)' : 'short-term vacation rental (STR)';

  const expenseInfo = property.ownership_type === 'rental'
    ? `COSTS: Rent $${property.monthly_rent_cost || 0}/mo`
    : `COSTS: Mortgage $${property.monthly_mortgage || 0}/mo | Insurance $${property.monthly_insurance || 0}/mo | Taxes $${property.annual_taxes || '?'}/yr | HOA $${property.hoa_monthly || 0}/mo`;
  const utilities = (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0);
  const totalMonthly = (property.ownership_type === 'rental' ? (property.monthly_rent_cost || 0) : (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0)) + utilities;

  // PriceLabs context
  let plContext = '';
  if (plData) {
    plContext = `\n\nPRICELABS DYNAMIC PRICING DATA (LIVE):
  Current Base Price: $${plData.base_price || '?'}/nt | PriceLabs Recommended: $${plData.recommended_base || '?'}/nt
  Price Range: Min $${plData.min_price || '?'} — Max $${plData.max_price || '?'}
  Cleaning Fee (current): $${plData.cleaning_fees || '?'}
  Strategy Group: ${plData.group || 'Default'}
  YOUR Occupancy: 7d ${plData.occ_7d || '?'} | 30d ${plData.occ_30d || '?'} | 60d ${plData.occ_60d || '?'}
  MARKET Occupancy: 7d ${plData.mkt_occ_7d || '?'} | 30d ${plData.mkt_occ_30d || '?'} | 60d ${plData.mkt_occ_60d || '?'}
  Sync Active: ${plData.push_enabled ? 'YES' : 'NO'} | PMS: ${plData.pms || '?'}
  Channels: ${(plData.channels || []).map(c => c.channel_name + ' #' + c.channel_listing_id).join(', ') || 'None'}`;
  }

  // Platform pricing context
  let platContext = '';
  if (platforms && platforms.length > 0) {
    platContext = `\n\nPLATFORM LISTINGS: ${platforms.map(p => p.platform + (p.nightly_rate ? ' $' + p.nightly_rate + '/nt' : '') + (p.rating ? ' ' + p.rating + '★' : '') + (p.review_count ? ' (' + p.review_count + ' reviews)' : '')).join(' | ')}`;
  }

  const prompt = `You are an expert ${modeLabel} revenue manager. Analyze this property with ALL available data and provide a comprehensive, profitable strategy.

PROPERTY: ${property.address}, ${property.city}, ${property.state} ${property.zip || ''}
Type: ${property.property_type} | ${property.bedrooms}BR/${property.bathrooms}BA | ${property.sqft || '?'}sqft
Ownership: ${property.ownership_type === 'rental' ? 'RENTED (arbitrage/sublet)' : 'OWNED'}
${property.listing_url ? 'Listing: ' + property.listing_url : ''}

${expenseInfo}
UTILITIES: $${utilities}/mo | TOTAL MONTHLY EXPENSES: $${totalMonthly}/mo
CLEANING: Guest pays $${property.cleaning_fee || 0} | Cleaner costs $${property.cleaning_cost || '? (not set)'} per turnover

AMENITIES (${amenities.length}): ${amenities.map(a => a.name + '(+' + (a.impact_score || 0) + '%)').join(', ') || 'None'}

MARKET: ${market ? 'Avg $' + (market.avg_daily_rate || '?') + '/mo | Median $' + (market.median_daily_rate || '?') + '/mo | ' + (market.active_listings || '?') + ' active listings' : 'No market data'}

COMPS (${comparables.length}): ${comparables.slice(0, 10).map(c => (c.source || '') + ' ' + (c.bedrooms || '?') + 'BR $' + (c.nightly_rate || 0) + (c.comp_type === 'ltr' ? '/mo' : '/nt') + (c.rating ? ' ' + c.rating + '★' : '')).join(' | ') || 'None'}
${plContext}${platContext}

${mode === 'str' ? 'For STR: Derive a nightly rate from all data points. Consider that STR typically earns 2-3.5x the daily LTR equivalent. Factor in PriceLabs data if available — their recommended base price is algorithmically calculated from market demand.' : ''}

Respond ONLY with JSON (no markdown, no backticks). Include a detailed "analysis" field with your full written analysis:
{
  ${mode === 'ltr' ? '"monthly_rent":N,' : '"base_nightly_rate":N,"weekend_rate":N,"cleaning_fee":N,"cleaning_fee_reasoning":"why this amount","pet_fee":N,"weekly_discount":N,"monthly_discount":N,"peak_season_markup":N,"low_season_discount":N,"min_nights":N,'}
  "projected_occupancy":0.XX,
  "projected_annual_revenue":N,
  "projected_monthly_avg":N,
  "breakeven_rate":N,
  "analysis":"A detailed 3-5 paragraph analysis covering: (1) Market positioning - how this property compares to comps and market rates, (2) Revenue projections - monthly and annual with occupancy assumptions, (3) Expense coverage - whether the strategy covers the $${totalMonthly}/mo costs and profit margin, (4) ${plData ? 'PriceLabs optimization - whether current PriceLabs settings are optimal and what to adjust' : 'Pricing optimization tips'}, (5) Key risks and seasonal considerations for ${property.city}, ${property.state}. Be specific with numbers.",
  "recommendations":["actionable recommendation 1","recommendation 2","recommendation 3"],
  "reasoning":"one-line summary"
}`;

  let aiResponse;
  try {
    if (provider === 'anthropic') {
      const k = env.ANTHROPIC_API_KEY; if (!k) throw new Error('ANTHROPIC_API_KEY not set');
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }) });
      aiResponse = (await r.json()).content?.[0]?.text;
    } else if (provider === 'openai') {
      const k = env.OPENAI_API_KEY; if (!k) throw new Error('OPENAI_API_KEY not set');
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 2500 }) });
      aiResponse = (await r.json()).choices?.[0]?.message?.content;
    } else if (provider === 'workers_ai') {
      if (!env.AI) throw new Error('Workers AI not configured');
      aiResponse = (await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 2500 })).response;
    }
  } catch (err) { await trackAI(env, 'pricing_analysis', provider, 0, false, err.message); return null; }
  if (!aiResponse) return null;
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
      return { strategy_name: stratName, base_nightly_rate: p.monthly_rent, weekend_rate: 0, cleaning_fee: 0, pet_fee: 0, weekly_discount: 0, monthly_discount: 0, peak_season_markup: 0, low_season_discount: 0, min_nights: 365, projected_occupancy: p.projected_occupancy || 0.92, projected_annual_revenue: p.projected_annual_revenue || p.monthly_rent * 12, projected_monthly_avg: p.monthly_rent, reasoning: (p.analysis || p.reasoning || ''), ai_generated: true, analysis: p.analysis, recommendations: p.recommendations, breakeven_rate: p.breakeven_rate };
    }
    const rate = p.base_nightly_rate || 150;
    const occ = p.projected_occupancy || 0.45;
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
  const market = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE city = ? AND state = ? ORDER BY snapshot_date DESC LIMIT 1`).bind(property.city, property.state).first();
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ?`).bind(propertyId).all();
  const { results: strategies } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC LIMIT 5`).bind(propertyId).all();

  // Property services (cleaning service, PM, etc.) — read-only, additive to expense picture
  let servicesMonthly = 0;
  let servicesList = '';
  try {
    const { results: services } = await env.DB.prepare(
      `SELECT service_name, monthly_cost FROM property_services WHERE property_id = ? ORDER BY monthly_cost DESC`
    ).bind(propertyId).all();
    if (services && services.length > 0) {
      servicesMonthly = services.reduce((a, s) => a + (s.monthly_cost || 0), 0);
      servicesList = services.map(s => `${s.service_name} $${s.monthly_cost}/mo`).join(', ');
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
    plData = { base_price: plLink.base_price, min_price: plLink.min_price, platform: plLink.pl_platform, pms: plLink.pl_pms, avg_30d: avg30?.avg ? Math.round(avg30.avg) : null, min_30d: avg30?.min, max_30d: avg30?.max, avg_90d: avg90?.avg ? Math.round(avg90.avg) : null, rates_count: avg30?.cnt || 0 };
  }

  // Building context — if this is a child unit, get sibling data
  let buildingContext = '';
  if (property.parent_id) {
    const parent = await env.DB.prepare(`SELECT * FROM properties WHERE id = ?`).bind(property.parent_id).first();
    const { results: siblings } = await env.DB.prepare(`SELECT p.*, (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as est_revenue, (SELECT base_nightly_rate FROM pricing_strategies WHERE property_id = p.id ORDER BY created_at DESC LIMIT 1) as est_rate FROM properties p WHERE p.parent_id = ? ORDER BY p.unit_number`).bind(property.parent_id).all();
    if (siblings.length > 1) {
      buildingContext = `\n\nBUILDING CONTEXT: This is Unit ${property.unit_number} in a ${siblings.length}-unit building at ${parent?.address || 'unknown'}.\n`;
      buildingContext += `Sibling units: ${siblings.map(s => `Unit ${s.unit_number || '?'} (${s.bedrooms || '?'}BR/${s.bathrooms || '?'}BA, ${s.sqft || '?'}sqft${s.est_rate ? ', current rate $' + s.est_rate + '/nt' : ''}${s.est_revenue ? ', $' + Math.round(s.est_revenue) + '/mo' : ''})`).join(', ')}`;
      buildingContext += `\nFor buildings with multiple units, the primary listing (typically "101" unit) should be the parent listing on PriceLabs. Other units are child listings with their own rates. Consider: units may differ in size, condition, or view — price accordingly.`;
    }
  }

  // Expenses — include property_services in total
  const monthlyCost = property.ownership_type === 'rental'
    ? (property.monthly_rent_cost || 0)
    : (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0);
  const utilities = (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0);
  const totalMonthly = monthlyCost + utilities + servicesMonthly;

  // Build comprehensive prompt
  const prompt = `You are an expert STR revenue manager specializing in PriceLabs dynamic pricing setup. Generate a comprehensive pricing strategy recommendation for this property.

PROPERTY: ${property.address}, ${property.city}, ${property.state} ${property.zip || ''}
Type: ${property.property_type} | ${property.bedrooms || '?'}BR / ${property.bathrooms || '?'}BA | ${property.sqft || '?'} sqft
Ownership: ${property.ownership_type === 'rental' ? 'RENTED (sublet/arbitrage)' : 'OWNED'}
${property.listing_url ? 'Listing: ' + property.listing_url : ''}

MONTHLY EXPENSES: $${totalMonthly}/mo total
${property.ownership_type === 'rental' ? '  Rent: $' + (property.monthly_rent_cost || 0) : '  Mortgage: $' + (property.monthly_mortgage || 0) + ' | Insurance: $' + (property.monthly_insurance || 0) + ' | Taxes: $' + Math.round((property.annual_taxes || 0) / 12) + '/mo | HOA: $' + (property.hoa_monthly || 0)}
  Utilities: $${utilities}/mo (elec $${property.expense_electric || 0}, gas $${property.expense_gas || 0}, water $${property.expense_water || 0}, internet $${property.expense_internet || 0}, trash $${property.expense_trash || 0})

AMENITIES (${amenities.length}): ${amenities.map(a => a.name + ' (+' + (a.impact_score || 0) + '%)').join(', ') || 'None listed'}

${plData ? `PRICELABS DATA:
  Base Price: $${plData.base_price || '?'}/nt | Min Price: $${plData.min_price || '?'}/nt
  30-day avg: $${plData.avg_30d || '?'}/nt | 90-day avg: $${plData.avg_90d || '?'}/nt
  30-day range: $${plData.min_30d || '?'} - $${plData.max_30d || '?'}
  Platform: ${plData.platform || '?'} | PMS: ${plData.pms || '?'} | Rate data: ${plData.rates_count} days` : 'PRICELABS: Not linked — recommendations will be based on market data and comps only.'}

PLATFORM LISTINGS: ${platforms.length > 0 ? platforms.map(p => p.platform + (p.nightly_rate ? ' $' + p.nightly_rate + '/nt' : '') + (p.rating ? ' ' + p.rating + '★' : '') + (p.review_count ? ' (' + p.review_count + ' reviews)' : '')).join(', ') : 'None'}

MARKET DATA: ${market ? 'Avg rent $' + (market.avg_daily_rate || '?') + '/mo | Median $' + (market.median_daily_rate || '?') + '/mo | ' + (market.active_listings || '?') + ' listings' : 'No market snapshots'}

COMP DATA (${comparables.length} comps): ${comparables.slice(0, 10).map(c => (c.source || '') + ' ' + (c.bedrooms || '?') + 'BR $' + (c.nightly_rate || 0) + (c.comp_type === 'ltr' ? '/mo' : '/nt') + (c.rating ? ' ' + c.rating + '★' : '')).join(' | ') || 'None'}

ALGORITHMIC STRATEGIES (from prior price analysis runs): ${strategies.length > 0 ? strategies.slice(0, 3).map(s => s.strategy_name + ': $' + s.base_nightly_rate + '/nt, occ ' + Math.round((s.projected_occupancy || 0) * 100) + '%, $' + Math.round(s.projected_monthly_avg || 0) + '/mo').join(' | ') : 'None generated yet'}
${servicesList ? 'PROPERTY SERVICES: ' + servicesList + ' ($' + Math.round(servicesMonthly) + '/mo total — already included in expense total above)\n' : ''}${buildingContext}
${await getGuestyActualsForPrompt(propertyId, property.city, property.state, env)}
${await getMonthlyTargetsForPrompt(propertyId, property, env)}
${prevStrategyContext}${prevOptContext}
DATA INTEGRITY NOTE: Monthly actuals above exclude the current in-progress month to prevent partial data from distorting averages. All booking pattern statistics use only confirmed and closed reservations. Base your recommendations on completed months only; do not extrapolate from any partial month figures shown.

Generate a COMPREHENSIVE PriceLabs pricing strategy recommendation. This is READ-ONLY advice — nothing will be changed automatically. Include ALL of the following:

Respond ONLY with JSON (no markdown, no backticks):
{
  "base_price": {number - recommended PriceLabs base price per night},
  "min_price": {number - absolute minimum price floor},
  "max_price": {number - maximum price ceiling for peak dates},
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
  "strategy_summary": "2-3 sentence summary of the overall approach",
  "key_recommendations": ["recommendation 1", "recommendation 2", "recommendation 3"],
  "risks": ["risk 1", "risk 2"]
}`;

  // Try AI providers in order
  let aiResponse = null;
  let provider = 'none';

  if (env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }) });
      const data = await r.json();
      aiResponse = data.content?.[0]?.text;
    } catch (e) { aiResponse = null; }
  }
  if (!aiResponse && env.OPENAI_API_KEY) {
    provider = 'openai';
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.OPENAI_API_KEY }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 3000 }) });
      const data = await r.json();
      aiResponse = data.choices?.[0]?.message?.content;
    } catch (e) { aiResponse = null; }
  }
  if (!aiResponse && env.AI) {
    provider = 'workers_ai';
    try {
      const data = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 3000 });
      aiResponse = data.response;
    } catch (e) { aiResponse = null; }
  }

  if (!aiResponse) {
    return json({ error: 'No AI provider available. Configure ANTHROPIC_API_KEY, OPENAI_API_KEY, or Workers AI.' }, 400);
  }
  await trackAI(env, 'pl_strategy', provider, 3000, true, null);
  await trackApiCall(env, provider === 'workers_ai' ? 'workers_ai' : provider, 'pl_strategy', true);

  // Parse response - robust extraction
  let strategy = null;
  try {
    let jsonStr = aiResponse;
    // Strip markdown fences
    jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    // Replace literal newlines — but carefully handle \\n that's already escaped
    jsonStr = jsonStr.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\\\\n/g, '\\n');
    try { strategy = JSON.parse(jsonStr); } catch {
      // Strip all newline escapes and control chars
      jsonStr = jsonStr.replace(/\\n/g, ' ').replace(/[\x00-\x1f]/g, ' ').replace(/,\s*([}\]])/g, '$1');
      strategy = JSON.parse(jsonStr);
    }
  } catch (e) {
    try {
      let cleaned = aiResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      const fb = cleaned.indexOf('{'), lb = cleaned.lastIndexOf('}');
      if (fb >= 0 && lb > fb) cleaned = cleaned.substring(fb, lb + 1);
      cleaned = cleaned.replace(/[\x00-\x1f]/g, ' ').replace(/,\s*([}\]])/g, '$1');
      strategy = JSON.parse(cleaned);
    } catch (e2) {
      // Return the raw AI text as a strategy summary so it's still useful
      return json({
        strategy: { strategy_summary: aiResponse.substring(0, 2000), key_recommendations: ['AI response could not be parsed into structured data — see summary above'], raw: true },
        property: { id: property.id, address: property.address, city: property.city, state: property.state },
        context: { provider, parse_error: true },
      });
    }
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
      `SELECT service_name, monthly_cost FROM property_services WHERE property_id = ? ORDER BY monthly_cost DESC`
    ).bind(propertyId).all();
    if (services && services.length > 0) {
      servicesMonthly = services.reduce((a, s) => a + (s.monthly_cost || 0), 0);
      servicesList = services.map(s => `${s.service_name} $${s.monthly_cost}/mo`).join(', ');
    }
  } catch {}

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
  } catch {}

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
  } catch {}

  let plData = null;
  const plLink = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();
  if (plLink) {
    let channels = [];
    try { channels = plLink.channel_details ? JSON.parse(plLink.channel_details) : []; } catch {}
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
  ${property.ownership_type === 'rental' ? 'Rent: $' + (property.monthly_rent_cost || 0) : 'Mortgage: $' + (property.monthly_mortgage || 0) + ' | Insurance: $' + (property.monthly_insurance || 0) + ' | Taxes: $' + Math.round((property.annual_taxes || 0) / 12) + '/mo | HOA: $' + (property.hoa_monthly || 0)}
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
${await getMonthlyTargetsForPrompt(propertyId, property, env)}
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
  "guest_experience_improvements": ["improvement 1", "improvement 2"],
  "quick_wins": ["something you can do today", "another quick win"],
  "ninety_day_plan": "A 3-4 sentence plan for the next 90 days to maximize revenue"
}`;

  let aiResponse = null;
  let provider = 'none';
  if (env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] }) });
      aiResponse = (await r.json()).content?.[0]?.text;
    } catch {}
  }
  if (!aiResponse && env.OPENAI_API_KEY) {
    provider = 'openai';
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.OPENAI_API_KEY }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 3000 }) });
      aiResponse = (await r.json()).choices?.[0]?.message?.content;
    } catch {}
  }
  if (!aiResponse && env.AI) {
    provider = 'workers_ai';
    try {
      const data = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: 3000 });
      aiResponse = data.response;
    } catch {}
  }
  if (!aiResponse) return json({ error: 'No AI provider available. Configure ANTHROPIC_API_KEY or OPENAI_API_KEY in API Keys settings, or ensure Workers AI is enabled.' }, 400);
  await trackAI(env, 'revenue_optimize', provider, 3000, true, null);
  await trackApiCall(env, provider, 'revenue_optimize', true);

  try {
    let jsonStr = aiResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const fb = jsonStr.indexOf('{'); const lb = jsonStr.lastIndexOf('}');
    if (fb >= 0 && lb > fb) jsonStr = jsonStr.substring(fb, lb + 1);
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    jsonStr = jsonStr.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\\\\n/g, '\\n');
    let result;
    try { result = JSON.parse(jsonStr); } catch {
      jsonStr = jsonStr.replace(/\\n/g, ' ').replace(/[\x00-\x1f]/g, ' ').replace(/,\s*([}\]])/g, '$1');
      result = JSON.parse(jsonStr);
    }
    const response = { optimization: result, property: { id: property.id, address: property.address, city: property.city }, monthly_expenses: monthlyCost, provider };
    try {
      await env.DB.prepare(`INSERT INTO analysis_reports (property_id, report_type, report_data, provider) VALUES (?, 'revenue_optimization', ?, ?)`)
        .bind(propertyId, JSON.stringify(response), provider).run();
    } catch {}
    return json(response);
  } catch (e) {
    const fallback = { optimization: { ninety_day_plan: aiResponse.substring(0, 2000), quick_wins: ['AI response could not be structured — see plan text above'] }, property: { id: property.id }, monthly_expenses: monthlyCost, provider };
    return json(fallback);
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
  const market = await env.DB.prepare(`SELECT * FROM market_snapshots WHERE city = ? AND state = ? ORDER BY snapshot_date DESC LIMIT 1`).bind(property.city, property.state).first();
  const { results: platforms } = await env.DB.prepare(`SELECT * FROM property_platforms WHERE property_id = ?`).bind(propertyId).all();
  const { results: strategies } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC LIMIT 3`).bind(propertyId).all();

  // Previous analysis for context
  const prevReport = await env.DB.prepare(`SELECT report_data FROM analysis_reports WHERE property_id = ? AND report_type = 'acquisition_analysis' ORDER BY created_at DESC LIMIT 1`).bind(propertyId).first();
  let prevAnalysis = '';
  if (prevReport) {
    try { const pd = JSON.parse(prevReport.report_data); prevAnalysis = pd.analysis ? JSON.stringify(pd.analysis).substring(0, 1000) : ''; } catch {}
  }

  // Look at similar properties in the portfolio for real performance data
  const { results: similar } = await env.DB.prepare(`SELECT p.*, pl.base_price as pl_base, pl.occupancy_next_30 as pl_occ, pl.market_occupancy_next_30 as pl_mkt_occ, pl.cleaning_fees as pl_clean FROM properties p LEFT JOIN pricelabs_listings pl ON pl.property_id = p.id WHERE p.city = ? AND p.state = ? AND p.id != ? AND p.is_research != 1`).bind(property.city, property.state, propertyId).all();

  // Get services
  let svcCost = 0;
  let svcList = [];
  try { const { results: svcs } = await env.DB.prepare(`SELECT name, monthly_cost FROM property_services WHERE property_id = ?`).bind(propertyId).all(); for (const s of (svcs||[])) { svcCost += s.monthly_cost; svcList.push(s.name + ' $' + s.monthly_cost); } } catch {}

  // PriceLabs data for this property
  const plLink = await env.DB.prepare(`SELECT * FROM pricelabs_listings WHERE property_id = ?`).bind(propertyId).first();

  // Performance history
  const { results: snapshots } = await env.DB.prepare(`SELECT snapshot_date, blended_adr, est_monthly_revenue, est_monthly_net FROM performance_snapshots WHERE property_id = ? ORDER BY snapshot_date DESC LIMIT 5`).bind(propertyId).all();

  // All market data for this city
  const { results: allMarket } = await env.DB.prepare(`SELECT avg_daily_rate, median_daily_rate, active_listings, snapshot_date FROM market_snapshots WHERE city = ? AND state = ? ORDER BY snapshot_date DESC LIMIT 5`).bind(property.city, property.state).all();

  // Master listings in area (real comps from crawls)
  const { results: masterComps } = await env.DB.prepare(`SELECT title, bedrooms, nightly_rate, rating, review_count, listing_type FROM master_listings WHERE city = ? AND state = ? AND status = 'active' ORDER BY review_count DESC LIMIT 10`).bind(property.city, property.state).all();

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
      const { results: season } = await env.DB.prepare(`SELECT month_number, avg_occupancy, avg_adr, multiplier FROM market_seasonality WHERE city = ? AND state = ? ORDER BY month_number`).bind(property.city, property.state).all();
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

MONTHLY COSTS: $${monthlyCost}/mo total
  ${property.ownership_type === 'rental' ? 'Rent: $' + (property.monthly_rent_cost || 0) : 'Mortgage: $' + (property.monthly_mortgage || 0) + ' | Insurance: $' + (property.monthly_insurance || 0) + ' | Taxes: $' + Math.round((property.annual_taxes || 0) / 12) + '/mo | HOA: $' + (property.hoa_monthly || 0)}
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

  let aiResponse = null;
  let provider = 'none';
  if (env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }) });
      aiResponse = (await r.json()).content?.[0]?.text;
    } catch {}
  }
  if (!aiResponse && env.OPENAI_API_KEY) {
    provider = 'openai';
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.OPENAI_API_KEY }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens }) });
      aiResponse = (await r.json()).choices?.[0]?.message?.content;
    } catch {}
  }
  if (!aiResponse && env.AI) {
    provider = 'workers_ai';
    try {
      const data = await env.AI.run('@cf/meta/llama-3.1-70b-instruct', { messages: [{ role: 'user', content: prompt }], max_tokens: workersMaxTokens });
      aiResponse = data.response;
    } catch {}
  }
  if (!aiResponse) return json({ error: 'No AI provider available. Configure ANTHROPIC_API_KEY or OPENAI_API_KEY in API Keys settings, or ensure Workers AI is enabled.' }, 400);
  await trackAI(env, 'acquisition_analysis', provider, 3000, true, null);
  await trackApiCall(env, provider, 'acquisition_analysis', true);

  try {
    let jsonStr = aiResponse.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
    const fb = jsonStr.indexOf('{'); const lb = jsonStr.lastIndexOf('}');
    if (fb >= 0 && lb > fb) jsonStr = jsonStr.substring(fb, lb + 1);
    // Fix common JSON issues from LLMs
    jsonStr = jsonStr.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
    // Replace literal newlines inside strings (common with Workers AI)
    jsonStr = jsonStr.replace(/\n/g, '\\n').replace(/\r/g, '').replace(/\t/g, '\\t');
    // Fix double-escaped newlines
    jsonStr = jsonStr.replace(/\\\\n/g, '\\n');
    let result;
    try { result = JSON.parse(jsonStr); } catch {
      jsonStr = jsonStr.replace(/[\\]n/g, ' ').replace(/[\x00-\x1f]/g, ' ');
      result = JSON.parse(jsonStr);
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
          let match = props[0];
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

      // RentCast AVM (value estimate, rate-limited)
      const avmParams = new URLSearchParams({ address: address });
      if (city) avmParams.set('city', city);
      if (state) avmParams.set('state', state);
      if (zip) avmParams.set('zipCode', zip);
      const rc2 = await rentCastFetch('https://api.rentcast.io/v1/avm/value?' + avmParams.toString(), rcKey, env, 'avm_value', city, state);
      if (rc2.limited) {
        result.lookups.push({ action: 'RentCast valuation', status: 'limit', detail: rc2.error });
      } else if (rc2.ok && rc2.data.price) {
        result.estimated_value = rc2.data.price;
        result.lookups.push({ action: 'RentCast valuation', status: 'ok', detail: '$' + rc2.data.price.toLocaleString() + (rc2.data.priceRangeLow ? ' (range: $' + rc2.data.priceRangeLow.toLocaleString() + '-$' + rc2.data.priceRangeHigh.toLocaleString() + ')' : '') });
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

        // Organic results — parse property details from snippets
        const snippets = (data.organic_results || []).slice(0, 5);
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

    // Also try a direct Zillow search for value
    if (!result.estimated_value) {
      try {
        await trackApiCall(env, 'searchapi', 'zillow_value', true);
        const zParams = new URLSearchParams({ engine: 'google', q: 'site:zillow.com ' + fullAddr });
        const zResp = await fetch('https://www.searchapi.io/api/v1/search?' + zParams.toString(), {
          headers: { 'Authorization': 'Bearer ' + env.SEARCHAPI_KEY }
        });
        if (zResp.ok) {
          const zData = await zResp.json();
          const zResults = (zData.organic_results || []).slice(0, 3);
          for (const z of zResults) {
            const text = (z.snippet || '') + ' ' + (z.title || '');
            const valM = text.match(/\$\s*([\d,]+(?:,\d{3})+)/);
            if (valM) {
              const v = parseInt(valM[1].replace(/,/g, ''));
              if (v > 50000) { result.estimated_value = v; result.lookups.push({ action: 'Zillow value', status: 'ok', detail: '$' + v.toLocaleString() }); break; }
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
  return json({ platforms: results });
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
      const scraped = await scrapePlatformListing(p.listing_url, p.platform, nights, guests, env, checkinStr, checkoutStr);
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
    insights.push({ type: 'cost', icon: '💰', text: cheapestTotal.platform + ' is cheapest for guests ($' + cheapestTotal.total_guest_pays + ' for ' + nights + ' nights) — $' + diff + ' less than ' + expensive.platform });
  }
  if (bestHostPayout && hostPayouts.length > 1) {
    const worstHost = hostPayouts.reduce((a, b) => a.host_payout < b.host_payout ? a : b);
    const diff = bestHostPayout.host_payout - worstHost.host_payout;
    if (diff > 0) insights.push({ type: 'revenue', icon: '📈', text: bestHostPayout.platform + ' gives you $' + diff + ' more per ' + nights + '-night booking vs ' + worstHost.platform + ' (host fees: ' + bestHostPayout.host_fee_pct + '% vs ' + worstHost.host_fee_pct + '%)' });
  }
  if (priceSpread > 15) {
    insights.push({ type: 'parity', icon: '⚠️', text: 'Rate spread of ' + priceSpread + '% across platforms — OTAs may flag price parity violations. Consider aligning base rates.' });
  } else if (priceSpread > 0 && priceSpread <= 15) {
    insights.push({ type: 'parity', icon: '✓', text: 'Rate spread of ' + priceSpread + '% — within acceptable parity range.' });
  }
  // Direct booking advantage
  const directPlat = comparison.find(c => c.platform === 'direct');
  if (directPlat && directPlat.nightly_rate > 0) {
    const airbnb = comparison.find(c => c.platform === 'airbnb');
    if (airbnb && airbnb.total_guest_pays > 0 && directPlat.total_guest_pays > 0) {
      const savings = airbnb.total_guest_pays - directPlat.total_guest_pays;
      if (savings > 0) insights.push({ type: 'direct', icon: '🏠', text: 'Direct booking saves guests $' + savings + ' (' + Math.round(savings / airbnb.total_guest_pays * 100) + '% off Airbnb) — great incentive for repeat guests' });
      else if (savings < 0) insights.push({ type: 'direct', icon: '⚠️', text: 'Direct booking is $' + Math.abs(savings) + ' MORE than Airbnb — consider lowering direct rate or removing service fees to incentivize direct bookings' });
    }
  }
  // Discount analysis
  comparison.forEach(c => {
    if (c.weekly_discount_pct > 0 || c.monthly_discount_pct > 0) {
      insights.push({ type: 'discount', icon: '🏷️', text: c.platform + ': ' + (c.weekly_discount_pct > 0 ? c.weekly_discount_pct + '% weekly' : '') + (c.weekly_discount_pct > 0 && c.monthly_discount_pct > 0 ? ' + ' : '') + (c.monthly_discount_pct > 0 ? c.monthly_discount_pct + '% monthly' : '') + ' discount' });
    }
  });
  // Missing platforms
  const allPlats = ['direct', 'airbnb', 'vrbo', 'booking'];
  const linkedPlats = comparison.map(c => c.platform);
  const missing = allPlats.filter(p => !linkedPlats.includes(p));
  if (missing.length > 0) {
    insights.push({ type: 'coverage', icon: '📋', text: 'Not yet linked: ' + missing.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(', ') + ' — add these to complete the comparison' });
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
    if (overpriced.length > 0) insights.push({ type: 'pricelabs', icon: '📊', text: overpriced.map(c => c.platform).join(', ') + ' priced ' + Math.abs(overpriced[0].pl_diff_pct) + '% above PriceLabs recommendation ($' + plRate.avg + '/nt avg). Consider lowering to match dynamic pricing.' });
    if (underpriced.length > 0) insights.push({ type: 'pricelabs', icon: '📊', text: underpriced.map(c => c.platform).join(', ') + ' priced ' + Math.abs(underpriced[0].pl_diff_pct) + '% below PriceLabs recommendation. You may be leaving money on the table.' });
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
  const searchTerm = address + ' ' + city + ' ' + state;
  const found = [];

  // Search Airbnb via SearchAPI
  if (env.SEARCHAPI_KEY) {
    try {
      const cin = new Date(Date.now() + 14 * 86400000);
      const cout = new Date(cin.getTime() + 3 * 86400000);
      const saParams = new URLSearchParams({
        engine: 'airbnb', q: searchTerm,
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
        for (const l of listings.slice(0, 5)) {
          let rate = 0;
          if (l.price && l.price.extracted_price) rate = l.price.extracted_price;
          else if (l.pricing && l.pricing.nightly_rate) rate = l.pricing.nightly_rate;
          else if (l.price && l.price.extracted_total_price) rate = Math.round(l.price.extracted_total_price / 3);
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
          });
        }
      }
    } catch {}

    // Search VRBO via SearchAPI Google Hotels engine
    try {
      const vrboParams = new URLSearchParams({ engine: 'google', q: 'site:vrbo.com ' + city + ' ' + state + ' ' + (prop.bedrooms || '') + ' bedroom' });
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
      const bkParams = new URLSearchParams({ engine: 'google', q: 'site:booking.com ' + city + ' ' + state + ' vacation rental ' + (prop.bedrooms || '') + ' bedroom' });
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

  // Also check if we already have listings in master_listings for this area
  try {
    const { results: mlResults } = await env.DB.prepare(
      `SELECT DISTINCT platform, listing_url, title, nightly_rate, rating FROM master_listings WHERE city = ? AND state = ? AND bedrooms = ? AND listing_url IS NOT NULL LIMIT 10`
    ).bind(city, state, prop.bedrooms || 1).all();
    for (const ml of mlResults) {
      const already = found.some(f => f.listing_url === ml.listing_url);
      if (!already) found.push({ platform: ml.platform, title: ml.title, listing_url: ml.listing_url, nightly_rate: ml.nightly_rate, rating: ml.rating, from_intel: true });
    }
  } catch {}

  return json({ property_id: propId, found, count: found.length, message: found.length > 0 ? 'Found ' + found.length + ' potential listings' : 'No listings found — try adding manually' });
}

// Scrape pricing data from a platform listing URL
async function scrapePlatformListing(url, platform, nights, guests, env, checkinStr, checkoutStr) {
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

  // ── VRBO: Fetch page directly — it's server-rendered HTML with useful data ──
  if (platform === 'vrbo') {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
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
        // Price patterns — VRBO sometimes includes price in meta or structured data
        const pricePatterns = [
          /\$(\d{2,4})\s*(?:\/|per)\s*night/i,
          /"price":\s*"?\$?(\d{2,4})"?/i,
          /avg.*?\$(\d{2,4})/i,
          /"amount":\s*"?(\d{2,4})"?/i,
        ];
        for (const pat of pricePatterns) {
          const m = html.match(pat);
          if (m) { result.nightly_rate = parseInt(m[1]); break; }
        }
        if (result.rating || result.review_count || result.nightly_rate) {
          result.raw_data = { source: 'vrbo_html', fetched: new Date().toISOString() };
          return result;
        }
      }
    } catch (e) { /* fall through */ }
  }

  // ── Booking.com: Try direct fetch first, then Google search via SearchAPI ──
  if (platform === 'booking') {
    // Try direct HTML fetch (sometimes works without CAPTCHA)
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
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
          const priceMatch = html.match(/\$\s*(\d{2,4})/i) || html.match(/"price":\s*"?(\d{2,4})"?/);
          if (priceMatch) result.nightly_rate = parseInt(priceMatch[1]);
          const ratingMatch = html.match(/(\d\.\d)\s*(?:\/\s*10|out of 10)/i) || html.match(/"ratingValue":\s*"?(\d\.\d+)"?/);
          if (ratingMatch) {
            const raw = parseFloat(ratingMatch[1]);
            result.rating = raw > 5 ? Math.round(raw / 2 * 10) / 10 : raw; // Booking uses /10
          }
          const revMatch = html.match(/([\d,]+)\s*(?:reviews?|ratings?|verified)/i);
          if (revMatch) result.review_count = parseInt(revMatch[1].replace(/,/g, ''));
          if (result.nightly_rate || result.rating) {
            result.raw_data = { source: 'booking_html', fetched: new Date().toISOString() };
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

async function plPost(path, env, body = {}) {
  if (!env.PRICELABS_API_KEY) throw new Error('PRICELABS_API_KEY not configured');
  await trackApiCall(env, 'pricelabs', path, true);
  const qs = new URLSearchParams({ api_key: env.PRICELABS_API_KEY });
  const resp = await fetch(PL_BASE + path + '?' + qs.toString(), {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error('PriceLabs API error ' + resp.status + ': ' + txt.substring(0, 200));
  }
  return resp.json();
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
    }
  } catch {}
}

async function getPerformanceHistory(propertyId, env) {
  const { results } = await env.DB.prepare(`SELECT * FROM performance_snapshots WHERE property_id = ? ORDER BY snapshot_date DESC LIMIT 90`).bind(propertyId).all();
  return json({ snapshots: results, count: results.length });
}

async function getAnalysisReports(propertyId, env) {
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
  const uf = uid ? ` WHERE (p.user_id = ${uid} OR p.user_id IS NULL)` : '';
  // Get all properties (excluding building parents — only count units/standalone)
  // STR revenue estimate: only use strategies where rental_type = 'str' OR min_nights < 365
  // This prevents LTR "Both" analysis runs from contaminating STR revenue projections
  const { results: props } = await env.DB.prepare(`SELECT p.*,
    (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'str' OR rental_type IS NULL) AND (min_nights IS NULL OR min_nights < 365) ORDER BY created_at DESC LIMIT 1) as est_monthly_revenue,
    (SELECT strategy_name FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'str' OR rental_type IS NULL) AND (min_nights IS NULL OR min_nights < 365) ORDER BY created_at DESC LIMIT 1) as latest_strategy,
    (SELECT projected_monthly_avg FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'ltr' OR min_nights >= 365) ORDER BY created_at DESC LIMIT 1) as est_ltr_revenue,
    (SELECT strategy_name FROM pricing_strategies WHERE property_id = p.id AND (rental_type = 'ltr' OR min_nights >= 365) ORDER BY created_at DESC LIMIT 1) as latest_ltr_strategy
    FROM properties p ${uf} ORDER BY p.city, p.state`).all();

  // Separate buildings from units/standalone
  const buildings = props.filter(p => p.total_units_count > 0 || props.some(c => c.parent_id && String(c.parent_id) === String(p.id)));
  const buildingIds = new Set(buildings.map(b => String(b.id)));

  // Active/live properties: included in portfolio totals (listing_status = 'active' OR null/draft if they have expenses set)
  // Draft/inactive with no expenses: still shown in table but excluded from totals to avoid inflating costs
  // Research: always excluded
  const units = props.filter(p => !buildingIds.has(String(p.id)) && !p.is_research);

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
  } catch {}

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
    // Inactive properties contribute $0 revenue (they're not earning)
    let monthlyRev = 0;
    let revSource = 'none';
    if (!isInactive) {
      if (isLtrProp) {
        // LTR: use LTR strategy estimate — PriceLabs doesn't apply here
        monthlyRev = p.est_ltr_revenue || 0;
        revSource = monthlyRev ? 'ltr_strategy' : 'none';
      } else {
        // STR: prefer PriceLabs, fall back to STR-only strategy estimate
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
      let rev = 0, revSource = 'none';
      if (!isInactive) {
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
        monthly_revenue: rev,
        monthly_cost: Math.round(totalCost),
        monthly_net: Math.round(rev - totalCost),
        service_cost: Math.round(svc),
        building_alloc: bldCost > 0 ? Math.round(bldCost) : null,
        services: propSvcs.map(s => s.name + ' $' + s.monthly_cost),
        latest_strategy: isLtrProp ? (p.latest_ltr_strategy || p.latest_strategy) : p.latest_strategy,
        rev_source: revSource,
      };
    }),
    // Monthly actuals for Actual vs Expected
    monthly_actuals: await getFinanceMonthlyActuals(env),
  });
}

async function getFinanceMonthlyActuals(env) {
  try {
    const { results } = await env.DB.prepare(`SELECT ma.property_id, ma.month, ma.total_revenue, ma.booked_nights, ma.available_nights, ma.occupancy_pct, ma.avg_nightly_rate, ma.host_payout, ma.cleaning_revenue, ma.total_taxes, ma.platform_commission, ma.taxes_you_owe, p.name as prop_name, p.address, p.unit_number, p.city, p.state FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE (p.is_research != 1 OR p.is_research IS NULL) ORDER BY ma.month`).all();
    // Also get seasonality for all markets
    const { results: season } = await env.DB.prepare(`SELECT city, state, month_number, multiplier FROM market_seasonality ORDER BY city, state, month_number`).all();
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
    // Update existing
    await env.DB.prepare(`UPDATE master_listings SET title=?, nightly_rate=?, monthly_rate=?, cleaning_fee=?, rating=?, review_count=?, superhost=?, last_updated=datetime('now'), last_scraped=datetime('now'), scrape_count=?, status='active' WHERE id=?`)
      .bind(listing.title || null, listing.nightly_rate || null, listing.monthly_rate || null, listing.cleaning_fee || 0, listing.rating || null, listing.review_count || 0, listing.superhost || 0, (existing.scrape_count || 1) + 1, existing.id).run();
    return { id: existing.id, action: 'updated' };
  }
  // Insert new
  const r = await env.DB.prepare(`INSERT INTO master_listings (user_id, platform, listing_type, platform_id, listing_url, title, description, host_name, city, state, zip, address, latitude, longitude, bedrooms, bathrooms, sleeps, sqft, property_type, nightly_rate, weekly_rate, monthly_rate, cleaning_fee, service_fee, rating, review_count, superhost, amenities_json, raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(uid || listing.user_id || null, listing.platform, listing.listing_type || 'str', listing.platform_id || null, listing.listing_url || null, listing.title || null, listing.description || null, listing.host_name || null, listing.city || null, listing.state || null, listing.zip || null, listing.address || null, listing.latitude || null, listing.longitude || null, listing.bedrooms || null, listing.bathrooms || null, listing.sleeps || null, listing.sqft || null, listing.property_type || null, listing.nightly_rate || null, listing.weekly_rate || null, listing.monthly_rate || null, listing.cleaning_fee || 0, listing.service_fee || 0, listing.rating || null, listing.review_count || 0, listing.superhost || 0, listing.amenities_json || null, listing.raw_data || null).run();
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
  if (city) { q += ` AND city = ?`; p.push(city); }
  if (state) { q += ` AND state = ?`; p.push(state); }
  if (type) { q += ` AND listing_type = ?`; p.push(type); }
  if (platform) { q += ` AND platform = ?`; p.push(platform); }
  if (beds) { q += ` AND bedrooms = ?`; p.push(parseInt(beds)); }
  q += ` ORDER BY last_updated DESC LIMIT 100`;
  const { results } = await env.DB.prepare(q).bind(...p).all();
  return json({ listings: results, count: results.length });
}

async function getMasterListingsStats(env, uid) {
  const uf = uid ? ` WHERE (user_id = ${uid} OR user_id IS NULL)` : '';
  const uf2 = uid ? ` AND (user_id = ${uid} OR user_id IS NULL)` : '';
  const total = await env.DB.prepare(`SELECT COUNT(*) as c FROM master_listings` + uf).first();
  const byPlatform = await env.DB.prepare(`SELECT platform, COUNT(*) as c FROM master_listings` + uf + ` GROUP BY platform ORDER BY c DESC`).all();
  const byCity = await env.DB.prepare(`SELECT city, state, COUNT(*) as c FROM master_listings` + uf + ` GROUP BY city, state ORDER BY c DESC LIMIT 20`).all();
  const byType = await env.DB.prepare(`SELECT listing_type, COUNT(*) as c FROM master_listings` + uf + ` GROUP BY listing_type`).all();
  const recent = await env.DB.prepare(`SELECT COUNT(*) as c FROM master_listings WHERE last_updated > datetime('now', '-7 days')` + uf2).first();
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
  const uf = uid ? ` WHERE (user_id = ${uid} OR user_id IS NULL)` : '';
  const { results } = await env.DB.prepare(`SELECT * FROM data_uploads` + uf + ` ORDER BY uploaded_at DESC LIMIT 50`).all();
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
  } catch (e) {
    await env.DB.prepare(`UPDATE crawl_jobs SET status='failed', error_message=?, completed_at=datetime('now') WHERE id=?`).bind(e.message, jobId).run();
    return json({ job_id: jobId, error: e.message });
  }

  return json({ job_id: jobId, listings_found: found, new: newL, updated: updL, message: 'Crawl complete: ' + found + ' listings (' + newL + ' new, ' + updL + ' updated)' });
}

async function getCrawlJobs(env, uid) {
  const uf = uid ? ` WHERE (user_id = ${uid} OR user_id IS NULL)` : '';
  const { results } = await env.DB.prepare(`SELECT *, CASE WHEN started_at IS NOT NULL AND completed_at IS NOT NULL THEN CAST((julianday(completed_at) - julianday(started_at)) * 86400 AS INTEGER) ELSE NULL END as duration_seconds FROM crawl_jobs` + uf + ` ORDER BY created_at DESC LIMIT 50`).all();
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

async function getStrategies(pid, env) { const { results } = await env.DB.prepare(`SELECT * FROM pricing_strategies WHERE property_id = ? ORDER BY created_at DESC`).bind(pid).all(); return json({ strategies: results }); }

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
  let zestimate = null, zestSource = '', zillowUrl = null;

  // Search Zillow for this property
  try {
    await trackApiCall(env, 'searchapi', 'zillow_zestimate', true);
    const resp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({ engine: 'google', q: fullAddr + ' zillow zestimate value' }).toString(), { headers: { 'Authorization': 'Bearer ' + apiKey } });
    if (resp.ok) {
      const data = await resp.json();
      // Check answer box first
      const snippet = (data.answer_box?.snippet || '') + ' ' + (data.answer_box?.answer || '');
      const priceMatch = snippet.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(?:K|M)?/);
      if (priceMatch) {
        let val = parseFloat(priceMatch[1].replace(/,/g, ''));
        if (snippet.toLowerCase().includes('m') && val < 100) val *= 1000000;
        else if (snippet.toLowerCase().includes('k') && val < 10000) val *= 1000;
        if (val > 10000) { zestimate = val; zestSource = 'Google answer box'; }
        // Grab Zillow URL from answer box if available
        if (data.answer_box?.link && data.answer_box.link.includes('zillow')) zillowUrl = data.answer_box.link;
      }
      // Check organic results for Zillow pages
      if (!zestimate) {
        for (const r of (data.organic_results || []).slice(0, 5)) {
          const text = (r.title || '') + ' ' + (r.snippet || '');
          // Look for price patterns: $500,000, $1,200,000
          const prices = text.match(/\$([\d,]+(?:,\d{3})+)/g) || [];
          for (const p of prices) {
            const val = parseFloat(p.replace(/[$,]/g, ''));
            if (val >= 50000 && val <= 50000000) {
              zestimate = val;
              zestSource = r.link && r.link.includes('zillow') ? 'Zillow' : r.source || 'Web';
              if (r.link && r.link.includes('zillow.com')) zillowUrl = r.link;
              break;
            }
          }
          if (zestimate) break;
        }
      }
    }
  } catch {}

  // Try a direct Zillow search if first attempt didn't find it
  if (!zestimate) {
    try {
      await trackApiCall(env, 'searchapi', 'zillow_direct', true);
      const resp = await fetch('https://www.searchapi.io/api/v1/search?' + new URLSearchParams({ engine: 'google', q: 'site:zillow.com ' + property.address + ' ' + property.city + ' ' + property.state }).toString(), { headers: { 'Authorization': 'Bearer ' + apiKey } });
      if (resp.ok) {
        const data = await resp.json();
        for (const r of (data.organic_results || []).slice(0, 3)) {
          const text = (r.title || '') + ' ' + (r.snippet || '');
          const prices = text.match(/\$([\d,]+(?:,\d{3})+)/g) || [];
          for (const p of prices) {
            const val = parseFloat(p.replace(/[$,]/g, ''));
            if (val >= 50000 && val <= 50000000) {
              zestimate = val;
              zestSource = 'Zillow';
              if (r.link && r.link.includes('zillow.com')) zillowUrl = r.link;
              break;
            }
          }
          if (zestimate) break;
        }
      }
    } catch {}
  }

  if (!zestimate) return json({ error: 'Could not find Zestimate for ' + fullAddr, address: fullAddr });

  // Save to property — also store zillow_url if we found one
  const today = new Date().toISOString().split('T')[0];
  const zillowSql = zillowUrl
    ? `UPDATE properties SET zestimate = ?, zestimate_date = ?, estimated_value = CASE WHEN estimated_value IS NULL OR estimated_value = 0 THEN ? ELSE estimated_value END, zillow_url = ? WHERE id = ?`
    : `UPDATE properties SET zestimate = ?, zestimate_date = ?, estimated_value = CASE WHEN estimated_value IS NULL OR estimated_value = 0 THEN ? ELSE estimated_value END WHERE id = ?`;
  const zillowBinds = zillowUrl ? [zestimate, today, zestimate, zillowUrl, propertyId] : [zestimate, today, zestimate, propertyId];
  await env.DB.prepare(zillowSql).bind(...zillowBinds).run();

  return json({
    zestimate: zestimate,
    source: zestSource,
    date: today,
    zillow_url: zillowUrl,
    address: fullAddr,
    previous_value: property.estimated_value,
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

function fuzzyMatchColumn(header, targets) {
  const h = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  // First pass: exact match only
  for (const t of targets) {
    const tn = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (h === tn) return true;
  }
  // Second pass: startsWith (but only if target is 6+ chars to avoid false matches)
  for (const t of targets) {
    const tn = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (tn.length >= 6 && h.startsWith(tn) && h.length <= tn.length + 4) return true;
  }
  return false;
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
  } catch {}

  for (const row of rows) {
    try {
      const code = get(row, 'confirmation_code') || ('GEN-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5));
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

      await env.DB.prepare(`INSERT INTO guesty_reservations (confirmation_code, listing_name, check_in, check_out, nights_count, guest_count, guest_name, channel, status, accommodation_fare, cleaning_fee, total_fees, total_taxes, host_payout, guest_total, platform_fee, currency, source_file) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(confirmation_code) DO UPDATE SET listing_name=excluded.listing_name, check_in=excluded.check_in, check_out=excluded.check_out, nights_count=excluded.nights_count, guest_count=excluded.guest_count, channel=excluded.channel, status=excluded.status, accommodation_fare=excluded.accommodation_fare, cleaning_fee=excluded.cleaning_fee, total_fees=excluded.total_fees, total_taxes=excluded.total_taxes, host_payout=excluded.host_payout, guest_total=excluded.guest_total, platform_fee=excluded.platform_fee`)
        .bind(code, listingName, checkIn, checkOut, nights, getNum(row, 'guest_count'), get(row, 'guest_name'), get(row, 'channel'), status, getNum(row, 'accommodation_fare'), getNum(row, 'cleaning_fee'), getNum(row, 'total_fees'), getNum(row, 'total_taxes'), getNum(row, 'host_payout'), getNum(row, 'guest_total'), getNum(row, 'platform_fee'), get(row, 'currency') || 'USD', fileName).run();
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
    } catch {}
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
  } catch {}

  // Auto-match listings to properties
  const matchResults = await autoMatchGuestyListings(env);

  return json({
    imported, skipped, errors, total: rows.length,
    columns_detected: Object.keys(colMap).length,
    column_mapping: Object.fromEntries(Object.entries(colMap).map(([k, v]) => [k, headers[v]])),
    listings_found: listingNames.size,
    auto_matched: matchResults.matched,
    message: `Imported ${imported} reservations, skipped ${skipped}, ${errors} errors. Found ${listingNames.size} listings, auto-matched ${matchResults.matched}.`
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
  const { results: props } = await env.DB.prepare(`SELECT id, name, address, city, state, unit_number, parent_id FROM properties WHERE is_research != 1 OR is_research IS NULL`).all();
  let matched = 0;

  for (const gl of (unmatched || [])) {
    let bestMatch = null, bestScore = 0;

    // Extract unit number from Guesty listing name or nickname
    // Patterns: "Middletown 101 / ...", "101 — 49 Park", "#2", "#101"
    const gName = gl.listing_name || '';
    const gAddr = gl.listing_address || '';
    let gUnit = null;
    // Try extracting from name: "Middletown 101" → "101", "Southford 103" → "103"
    const unitFromName = gName.match(/\b(\d{2,4})\b\s*[\/\-]/);
    if (unitFromName) gUnit = unitFromName[1];
    // Try from address: "49 Park Pl #2" → "2", "1455 Southford Rd #3" → "3"
    const unitFromAddr = gAddr.match(/#(\d+)/);
    if (unitFromAddr && !gUnit) gUnit = unitFromAddr[1];

    // Normalize the base address (strip unit number from Guesty address)
    const gBaseAddr = normalizeAddress(gAddr.replace(/#\d+/, '').replace(/,.*$/, ''));

    for (const p of (props || [])) {
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
        // Exact match: "101" === "101"
        if (gUnit === p.unit_number) unitMatch = 1;
        // Guesty uses apartment # not unit: "#2" matches "102" → need to check if addr has #2 and prop has 102
        else if (unitFromAddr && p.unit_number.endsWith(unitFromAddr[1])) unitMatch = 0.7;
      } else if (!gUnit && !p.unit_number) {
        // Both have no unit — standalone property match is fine
        unitMatch = 0.5;
      }

      // Combined score: address is base, unit is critical differentiator
      if (addrScore >= 0.5 && (cityMatch > 0 || addrScore >= 0.7)) {
        if (gUnit && p.unit_number) {
          // Multi-unit building: unit match is essential
          score = addrScore * 0.4 + unitMatch * 0.5 + cityMatch * 0.1;
        } else {
          // Standalone: just address + city
          score = addrScore * 0.7 + cityMatch * 0.2 + unitMatch * 0.1;
        }
      }

      // Also try matching listing name against property name directly
      if (p.name) {
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
  // Update reservations
  const gl = await env.DB.prepare(`SELECT listing_name FROM guesty_listings WHERE guesty_listing_id = ?`).bind(guesty_listing_id).first();
  if (gl) await env.DB.prepare(`UPDATE guesty_reservations SET property_id = ? WHERE listing_name = ?`).bind(property_id, gl.listing_name).run();
  return json({ ok: true });
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
  const confirmed = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE status IN ('confirmed','closed')`).first();
  const linked = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE property_id IS NOT NULL AND status IN ('confirmed','closed')`).first();
  const canceled = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE status = 'canceled'`).first();
  const inquiries = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_reservations WHERE status IN ('inquiry','expired','awaiting_payment')`).first();
  const listings = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_listings`).first();
  const matched = await env.DB.prepare(`SELECT COUNT(*) as c FROM guesty_listings WHERE property_id IS NOT NULL`).first();
  const dateRange = await env.DB.prepare(`SELECT MIN(check_in) as earliest, MAX(check_out) as latest FROM guesty_reservations`).first();
  const byChannel = await env.DB.prepare(`SELECT channel, COUNT(*) as c, SUM(host_payout) as payout FROM guesty_reservations WHERE status IN ('confirmed','closed') GROUP BY channel ORDER BY c DESC`).all();
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
  });
}

async function processGuestyData(env) {
  // Phase 1: Aggregate reservations into monthly_actuals per property
  // Clear existing actuals first to remove stale data from bad imports
  await env.DB.prepare(`DELETE FROM monthly_actuals`).run();
  
  const { results: linked } = await env.DB.prepare(`SELECT DISTINCT property_id FROM guesty_reservations WHERE property_id IS NOT NULL`).all();
  let processed = 0;

  for (const { property_id } of (linked || [])) {
    const { results: reservations } = await env.DB.prepare(`SELECT * FROM guesty_reservations WHERE property_id = ? AND status IN ('confirmed','closed') ORDER BY check_in`).bind(property_id).all();
    if (!reservations || reservations.length === 0) continue;

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
        if (!byMonth[monthKey]) byMonth[monthKey] = { nights: 0, revenue: 0, cleaning: 0, payout: 0, taxes: 0, commission: 0, taxes_you_owe: 0, reservations: new Set(), stayLengths: [] };
        // Only count each day once per property (prevent overlapping reservation double-count)
        if (!bookedDays[dayKey]) {
          bookedDays[dayKey] = true;
          byMonth[monthKey].nights++;
        }
        byMonth[monthKey].revenue += nightlyRate;
        if (!monthsThisRes[monthKey]) monthsThisRes[monthKey] = 0;
        monthsThisRes[monthKey]++;
        d = new Date(d.getTime() + 86400000);
      }

      // Count this reservation in each month it has nights, with actual nights in that month
      for (const mk in monthsThisRes) {
        byMonth[mk].reservations.add(r.confirmation_code);
        byMonth[mk].stayLengths.push(monthsThisRes[mk]); // nights THIS reservation had in THIS month
      }

      // Attribute cleaning fee, payout, taxes, and commission to check-in month
      const ciMonth = ci.getUTCFullYear() + '-' + String(ci.getUTCMonth() + 1).padStart(2, '0');
      if (byMonth[ciMonth]) {
        byMonth[ciMonth].cleaning += r.cleaning_fee || 0;
        byMonth[ciMonth].payout += r.host_payout || 0;
        byMonth[ciMonth].taxes += r.total_taxes || 0;
        byMonth[ciMonth].commission += r.platform_fee || 0;
        // Track if taxes are platform-remitted (Airbnb) vs you-remit (Booking, VRBO, Manual)
        var ch = (r.channel || '').toLowerCase();
        if (ch !== 'airbnb') byMonth[ciMonth].taxes_you_owe += r.total_taxes || 0;
      }
    }

    // Write to monthly_actuals
    for (const month in byMonth) {
      const m = byMonth[month];
      const daysInMonth = new Date(parseInt(month.split('-')[0]), parseInt(month.split('-')[1]), 0).getDate();
      // Cap nights at days in month
      const cappedNights = Math.min(m.nights, daysInMonth);
      const occ = Math.round(cappedNights / daysInMonth * 100) / 100;
      const adr = cappedNights > 0 ? Math.round(m.revenue / cappedNights * 100) / 100 : 0;
      const avgStay = m.stayLengths.length > 0 ? Math.round(m.stayLengths.reduce((a, b) => a + b, 0) / m.stayLengths.length * 10) / 10 : 0;
      await env.DB.prepare(`INSERT INTO monthly_actuals (property_id, month, booked_nights, available_nights, occupancy_pct, total_revenue, avg_nightly_rate, num_reservations, avg_stay_length, cleaning_revenue, host_payout, total_taxes, platform_commission, taxes_you_owe) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(property_id, month) DO UPDATE SET booked_nights=excluded.booked_nights, available_nights=excluded.available_nights, occupancy_pct=excluded.occupancy_pct, total_revenue=excluded.total_revenue, avg_nightly_rate=excluded.avg_nightly_rate, num_reservations=excluded.num_reservations, avg_stay_length=excluded.avg_stay_length, cleaning_revenue=excluded.cleaning_revenue, host_payout=excluded.host_payout, total_taxes=excluded.total_taxes, platform_commission=excluded.platform_commission, taxes_you_owe=excluded.taxes_you_owe, updated_at=datetime('now')`)
        .bind(property_id, month, cappedNights, daysInMonth, occ, Math.round(m.revenue), adr, m.reservations.size, avgStay, Math.round(m.cleaning), Math.round(m.payout), Math.round(m.taxes), Math.round(m.commission), Math.round(m.taxes_you_owe)).run();
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
    // Only count non-research properties that are linked
    const ytd = await env.DB.prepare(`SELECT SUM(ma.total_revenue) as rev, SUM(ma.booked_nights) as nights, SUM(ma.available_nights) as avail, SUM(ma.host_payout) as payout, COUNT(DISTINCT ma.property_id) as props, COUNT(*) as month_entries FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE ma.month >= ? AND ma.month <= ? AND (p.is_research != 1 OR p.is_research IS NULL)`).bind(thisYear, currentMonth).first();
    const ly = await env.DB.prepare(`SELECT SUM(ma.total_revenue) as rev, SUM(ma.booked_nights) as nights, SUM(ma.available_nights) as avail, SUM(ma.host_payout) as payout, COUNT(DISTINCT ma.property_id) as props, COUNT(*) as month_entries FROM monthly_actuals ma JOIN properties p ON ma.property_id = p.id WHERE ma.month >= ? AND ma.month <= ? AND (p.is_research != 1 OR p.is_research IS NULL)`).bind(lastYear, lastYearEnd).first();
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
  } catch {}

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
       WHERE property_id = ? AND status IN ('confirmed','closed') AND nights_count > 0`
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
       WHERE property_id = ? AND status IN ('confirmed','closed') AND host_payout > 0
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
         SUM(CASE WHEN status IN ('confirmed','closed') THEN 1 ELSE 0 END) as confirmed_count,
         SUM(CASE WHEN status = 'canceled' THEN 1 ELSE 0 END) as canceled_count
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
       WHERE property_id = ? AND status IN ('confirmed','closed') AND guest_count > 0`
    ).bind(propertyId).first();

    if (guestStats && guestStats.total > 0 && guestStats.avg_guests > 0) {
      result += `GUEST PROFILE: Avg ${guestStats.avg_guests} guests | Max ${guestStats.max_guests} | Large groups (4+): ${Math.round((guestStats.large_groups||0)/guestStats.total*100)}% of stays\n`;
    }

  } catch {}

  // Seasonality from market_seasonality (derived from all properties in this market, not just this one)
  try {
    if (city && state) {
      const { results: season } = await env.DB.prepare(
        `SELECT month_number, avg_adr, multiplier, avg_occupancy, sample_size
         FROM market_seasonality WHERE city = ? AND state = ? ORDER BY month_number`
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
  } catch {}

  return result;
}

async function getMonthlyTargetsForPrompt(propertyId, property, env) {
  let result = '';
  try {
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

    // Get property costs
    let monthlyCost = 0;
    if (property.ownership_type === 'rental') {
      monthlyCost = property.monthly_rent_cost || 0;
    } else {
      monthlyCost = (property.monthly_mortgage || 0) + (property.monthly_insurance || 0) + Math.round((property.annual_taxes || 0) / 12) + (property.hoa_monthly || 0);
    }
    monthlyCost += (property.expense_electric || 0) + (property.expense_gas || 0) + (property.expense_water || 0) + (property.expense_internet || 0) + (property.expense_trash || 0) + (property.expense_other || 0);
    // Add services
    try { const { results: svcs } = await env.DB.prepare(`SELECT SUM(monthly_cost) as total FROM property_services WHERE property_id = ?`).bind(propertyId).first(); monthlyCost += (svcs?.total || 0); } catch {}

    if (monthlyCost <= 0) return '';

    const annualTarget = monthlyCost * 12 * 1.15; // costs + 15%

    // Get seasonality
    let seasonMult = {};
    let multSum = 0;
    if (property.city && property.state) {
      const { results: season } = await env.DB.prepare(`SELECT month_number, multiplier, avg_occupancy FROM market_seasonality WHERE city = ? AND state = ? ORDER BY month_number`).bind(property.city, property.state).all();
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

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
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
  const share = await env.DB.prepare(`SELECT * FROM property_shares WHERE share_code = ?`).bind(code).first();
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
  const parsedReports = (reports || []).map(r => {
    let data = {};
    try { data = JSON.parse(r.report_data); } catch {}
    return { type: r.report_type, provider: r.provider, created_at: r.created_at, data };
  });

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
