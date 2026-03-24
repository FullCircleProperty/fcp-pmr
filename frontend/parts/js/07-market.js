// API Key Status Check
async function checkApiKeys() {
  var el = document.getElementById('apiKeyStatus');
  if (!el) return;
  try {
    var d = await api('/api/keys/status');
    var keys = d.keys || {};
    var sources = d.sources || {};
    var names = {
      RENTCAST_API_KEY: { label: 'RentCast', desc: 'Property data & valuations', url: 'https://rentcast.io/api', note: 'Free 50 calls/mo', limitKey: 'rentcast', defaultLimit: 50 },
      GOOGLE_PLACES_API_KEY: { label: 'Google Places', desc: 'Address autocomplete & geocoding', url: 'https://console.cloud.google.com', note: '$5/1K requests', limitKey: 'google_places', defaultLimit: 1000 },
      SEARCHAPI_KEY: { label: 'SearchAPI.io', desc: 'Airbnb data, intel crawls & scraping', url: 'https://searchapi.io', note: 'Free 100/mo', limitKey: 'searchapi', defaultLimit: 100 },
      PRICELABS_API_KEY: { label: 'PriceLabs', desc: 'Dynamic pricing & rate optimization', url: 'https://pricelabs.co', note: '$1/listing/mo' },
      ANTHROPIC_API_KEY: { label: 'Anthropic Claude', desc: 'Premium AI analysis', url: 'https://console.anthropic.com', note: 'Per-token billing', testable: true },
      OPENAI_API_KEY: { label: 'OpenAI GPT', desc: 'Alternative AI provider', url: 'https://platform.openai.com', note: 'Per-token billing', testable: true },
    };
    var h = '<div style="display:grid;gap:10px;">';
    // AI Status Banner — show active provider and limitations
    var hasAnthropic = keys['ANTHROPIC_API_KEY'];
    var hasOpenAI = keys['OPENAI_API_KEY'];
    var hasWorkersAI = keys['WORKERS_AI'];
    var activeAI = hasAnthropic ? 'Anthropic Claude' : hasOpenAI ? 'OpenAI GPT-4o' : hasWorkersAI ? 'Workers AI (Free)' : 'None';
    var aiColor = hasAnthropic ? 'var(--accent)' : hasOpenAI ? 'var(--accent)' : hasWorkersAI ? '#f59e0b' : 'var(--danger)';

    h += '<div style="padding:14px;background:var(--bg);border:2px solid ' + (hasAnthropic || hasOpenAI ? 'rgba(16,185,129,0.3)' : hasWorkersAI ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.3)') + ';border-radius:10px;margin-bottom:4px;">';
    h += '<div style="font-size:0.85rem;font-weight:600;margin-bottom:8px;">' + _ico('sparkle', 13, 'var(--purple)') + ' AI Provider Status</div>';
    h += '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">';
    h += '<div><span style="font-size:0.72rem;color:var(--text3);">Active:</span> <strong style="color:' + aiColor + ';">' + activeAI + '</strong></div>';
    h += '<div style="font-size:0.72rem;color:var(--text3);">Chain: ';
    h += '<span style="color:' + (hasAnthropic ? 'var(--accent)' : 'var(--text3)') + ';">Anthropic</span> → ';
    h += '<span style="color:' + (hasOpenAI ? 'var(--accent)' : 'var(--text3)') + ';">OpenAI</span> → ';
    h += '<span style="color:' + (hasWorkersAI ? '#f59e0b' : 'var(--text3)') + ';">Workers AI</span>';
    h += '</div></div>';

    if (!hasAnthropic && !hasOpenAI && hasWorkersAI) {
      h += '<div style="padding:10px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font-size:0.78rem;color:#f59e0b;line-height:1.5;">';
      h += '<strong>' + _ico('alertCircle', 13, '#f59e0b') + ' Running on Workers AI (Free Tier) — Limitations:</strong><br>';
      h += '• <strong>Max ~4,000 output tokens</strong> — acquisition reports may be truncated or missing sections<br>';
      h += '• <strong>Smaller model</strong> (Llama 3.1 70B) — less accurate financial projections and market analysis<br>';
      h += '• <strong>JSON formatting issues</strong> — may produce unparseable responses more often<br>';
      h += '• <strong>No web knowledge after training cutoff</strong> — regulations and market data less reliable<br>';
      h += '• <strong>Rate limited</strong> — may fail under heavy use<br>';
      h += '<br>' + _ico('lightbulb', 13) + ' <strong>For best results:</strong> Add an <strong>Anthropic</strong> or <strong>OpenAI</strong> API key. Claude Sonnet produces significantly better acquisition analyses with accurate financials and detailed recommendations.';
      h += '</div>';
    } else if (hasAnthropic) {
      h += '<div style="font-size:0.72rem;color:var(--accent);">' + _ico('check', 13, 'var(--accent)') + ' Best AI quality — Claude Sonnet 4 produces detailed reports with accurate analysis. <span style="color:var(--text3);">~$0.002–0.005 per analysis</span></div>';
    } else if (hasOpenAI) {
      h += '<div style="font-size:0.72rem;color:var(--accent);">' + _ico('check', 13, 'var(--accent)') + ' Good AI quality — GPT-4o-mini for analysis. Anthropic Claude recommended for best results.</div>';
    }
    h += '</div>';

    // Workers AI (always free, no key)
    h += '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
    h += '<span style="color:' + (hasWorkersAI ? 'var(--accent)' : 'var(--danger)') + ';font-size:1.2em;">' + (hasWorkersAI ? '✓' : '✗') + '</span>';
    h += '<div style="flex:1;"><strong style="font-size:0.85rem;">Workers AI</strong> <span style="font-size:0.72rem;color:var(--text3);">Free fallback · Llama 3.1 70B · ~4K token limit</span></div>';
    h += '<span style="font-size:0.68rem;color:' + (hasWorkersAI ? 'var(--accent)' : 'var(--danger)') + ';background:' + (hasWorkersAI ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)') + ';padding:2px 8px;border-radius:3px;">' + (hasWorkersAI ? 'ACTIVE' : 'NOT BOUND') + '</span>';
    h += '</div>';
    for (var k in names) {
      var ok = keys[k];
      var src = sources[k];
      var info = names[k];
      h += '<div style="padding:10px 12px;background:var(--surface2);border-radius:8px;border:1px solid ' + (ok ? 'rgba(16,185,129,0.2)' : 'var(--border)') + ';">';
      h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:' + (ok ? '0' : '8px') + ';">';
      h += '<span style="color:' + (ok ? 'var(--accent)' : 'var(--text3)') + ';font-size:1.2em;">' + (ok ? '✓' : '○') + '</span>';
      h += '<div style="flex:1;"><strong style="font-size:0.85rem;">' + info.label + '</strong> <span style="font-size:0.72rem;color:var(--text3);">' + info.desc + '</span></div>';
      if (ok) {
        h += '<span style="font-size:0.72rem;background:rgba(16,185,129,0.15);color:var(--accent);padding:1px 6px;border-radius:3px;">' + (src === 'env' ? 'ENV' : 'DB') + '</span> ';
        if (info.testable) h += '<button class="btn btn-xs" style="font-size:0.68rem;padding:1px 8px;" onclick="testApiKey(\'' + k + '\')">Test</button> ';
        h += '<button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);font-size:0.68rem;padding:1px 6px;" onclick="removeApiKey(\'' + k + '\')">Remove</button>';
        h += '</div>';
        if (info.testable) h += '<div id="keytest_' + k + '" style="margin-top:6px;font-size:0.75rem;display:none;"></div>';
      } else {
        h += '<a href="' + info.url + '" target="_blank" style="font-size:0.68rem;color:var(--purple);">' + info.note + ' →</a>';
        h += '</div>';
      }
      if (!ok) {
        h += '<div style="display:flex;gap:6px;align-items:center;">';
        h += '<input type="password" id="apikey_' + k + '" placeholder="Paste your ' + info.label + ' API key" style="flex:1;font-size:0.78rem;padding:5px 8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:DM Mono,monospace;">';
        h += '<button class="btn btn-xs btn-primary" style="padding:4px 12px;" onclick="saveApiKey(\'' + k + '\')">Save</button>';
        h += '</div>';
      }
      if (info.limitKey) {
        h += '<div style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:0.75rem;">';
        h += '<span style="color:var(--text3);">Monthly limit:</span>';
        h += '<input type="number" id="apilimit_' + info.limitKey + '" value="' + (info.defaultLimit || 100) + '" style="width:70px;padding:3px 6px;font-size:0.75rem;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);">';
        h += '<button class="btn btn-xs" style="padding:2px 8px;font-size:0.68rem;" onclick="saveApiLimit(\'' + info.limitKey + '\')">Set</button>';
        h += '<span id="apilimit_status_' + info.limitKey + '" style="color:var(--accent);font-size:0.68rem;"></span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<p style="color:var(--danger)">' + esc(err.message) + '</p>'; }
  // Load usage stats
  loadApiUsage();
}

async function loadApiUsage() {
  var el = document.getElementById('apiUsageStatus');
  if (!el) return;
  try {
    var d = await api('/api/keys/usage');
    var u = d.usage || {};
    var h = '<label style="font-size:0.78rem;color:var(--text2);display:block;margin:14px 0 8px;">API USAGE THIS MONTH</label>';
    h += '<div style="display:grid;gap:6px;">';
    var totalCents = 0;
    var services = ['rentcast','searchapi','google_places','anthropic','openai','workers_ai','pricelabs'];
    services.forEach(function(svc) {
      var s = u[svc];
      if (!s) return;
      var pct = s.free_limit ? Math.min(100, Math.round(s.calls / s.free_limit * 100)) : null;
      var barColor = pct && pct >= 90 ? 'var(--danger)' : pct && pct >= 70 ? '#f59e0b' : 'var(--accent)';
      h += '<div style="padding:8px 12px;background:var(--surface2);border-radius:6px;border:1px solid ' + (s.over_limit ? 'rgba(239,68,68,0.3)' : 'var(--border)') + ';">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
      h += '<span style="font-size:0.78rem;font-weight:600;">' + esc(s.label) + '</span>';
      h += '<span style="font-family:DM Mono,monospace;font-size:0.78rem;">' + s.calls + ' calls' + (s.free_limit ? ' / ' + s.free_limit + ' free' : '') + '</span>';
      h += '</div>';
      if (s.free_limit) {
        h += '<div style="height:4px;background:var(--border);border-radius:2px;margin-top:4px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:' + barColor + ';border-radius:2px;"></div></div>';
        if (s.over_limit) h += '<div style="font-size:0.68rem;color:var(--danger);margin-top:2px;">' + _ico('alertCircle', 13, '#f59e0b') + ' Over free tier — est. $' + (s.cost_cents / 100).toFixed(2) + ' overage</div>';
        else if (s.remaining !== null) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">' + s.remaining + ' free calls remaining</div>';
      } else if (s.cost_cents > 0) {
        var costDollars = (s.cost_cents / 100).toFixed(3);
        var budgetDollars = (svc === 'anthropic' || svc === 'openai') ? (s.budget_dollars != null ? s.budget_dollars : 20) : null;
        var budgetStr = budgetDollars != null ? ' of $' + budgetDollars.toFixed(0) + ' budget' : '';
        var budgetPct = budgetDollars ? Math.min(100, Math.round(s.cost_cents / 100 / budgetDollars * 100)) : 0;
        var budgetColor = budgetPct >= 90 ? 'var(--danger)' : budgetPct >= 70 ? '#f59e0b' : 'var(--accent)';
        h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">Est. cost: $' + costDollars + budgetStr + '</div>';
        if (budgetDollars) {
          h += '<div style="height:3px;background:var(--border);border-radius:2px;margin-top:3px;overflow:hidden;"><div style="height:100%;width:' + budgetPct + '%;background:' + budgetColor + ';border-radius:2px;"></div></div>';
          var remaining = (budgetDollars - s.cost_cents / 100).toFixed(2);
          h += '<div style="font-size:0.75rem;color:' + (budgetPct >= 90 ? 'var(--danger)' : 'var(--text3)') + ';margin-top:2px;">$' + remaining + ' remaining this month</div>';
        }
      }
      // Per-endpoint breakdown
      if (s.by_endpoint && s.by_endpoint.length > 0) {
        h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">';
        s.by_endpoint.forEach(function(e) {
          h += '<span style="font-size:0.72rem;padding:1px 5px;background:var(--surface);border:1px solid var(--border);border-radius:3px;color:var(--text3);">' + esc(e.endpoint) + ' ×' + e.calls + '</span>';
        });
        h += '</div>';
      }
      h += '</div>';
      totalCents += s.cost_cents || 0;
    });
    // PriceLabs fixed
    if (u.pricelabs_fixed && u.pricelabs_fixed.listings > 0) {
      h += '<div style="padding:8px 12px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);">';
      h += '<div style="display:flex;justify-content:space-between;"><span style="font-size:0.78rem;font-weight:600;">PriceLabs (fixed)</span>';
      h += '<span style="font-family:DM Mono,monospace;font-size:0.78rem;">' + u.pricelabs_fixed.listings + ' listings × $1/mo</span></div>';
      h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">$' + (u.pricelabs_fixed.cost_cents / 100).toFixed(2) + '/mo</div></div>';
      totalCents += u.pricelabs_fixed.cost_cents || 0;
    }
    h += '</div>';
    h += '<div style="margin-top:10px;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;display:flex;justify-content:space-between;align-items:center;">';
    h += '<span style="font-size:0.85rem;font-weight:600;">Est. Total API Cost This Month</span>';
    h += '<span style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:' + (totalCents > 500 ? 'var(--danger)' : 'var(--accent)') + ';">$' + (totalCents / 100).toFixed(2) + '</span></div>';
    el.innerHTML = h;
  } catch {}
}

async function saveApiLimit(service) {
  var val = parseInt((document.getElementById('apilimit_' + service) || {}).value);
  if (isNaN(val) || val < 0) { toast('Enter a valid number', 'error'); return; }
  try {
    await api('/api/admin/settings', 'POST', { key: service + '_monthly_limit', value: String(val) });
    var s = document.getElementById('apilimit_status_' + service);
    if (s) s.textContent = '✓ Saved';
    toast(service + ' limit set to ' + val);
  } catch (err) { toast(err.message, 'error'); }
}

async function saveApiKey(keyName) {
  var input = document.getElementById('apikey_' + keyName);
  if (!input || !input.value.trim()) { toast('Enter an API key', 'error'); return; }
  showLoading('Saving...');
  try {
    var d = await api('/api/keys/save', 'POST', { key: keyName, value: input.value.trim() });
    toast(d.message || 'Saved');
    checkApiKeys();
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

async function testApiKey(keyName) {
  var el = document.getElementById('keytest_' + keyName);
  if (!el) return;
  el.style.display = '';
  el.innerHTML = '<span style="color:var(--text3);">' + _ico('clock', 13) + ' Testing key against live API...</span>';
  try {
    var d = await api('/api/keys/test?key=' + encodeURIComponent(keyName));
    var ping = d.ping;
    var keyOk = ping && ping.ok;
    var msg = '';
    if (!d.keyInEnv) {
      msg = '<span style="color:var(--danger);">' + _ico('x', 13, 'var(--danger)') + ' Key not found in worker env — DB save may not have taken effect. Try re-saving.</span>';
    } else if (!ping) {
      msg = '<span style="color:var(--danger);">' + _ico('x', 13, 'var(--danger)') + ' Key found in env (preview: ' + (d.keyPreview||'?') + ') but test ping not run.</span>';
    } else if (keyOk) {
      msg = '<span style="color:var(--accent);">' + _ico('check', 13, 'var(--accent)') + ' Key works! Live API responded OK (HTTP ' + ping.status + '). AI is ready.</span>';
    } else {
      msg = '<span style="color:var(--danger);">' + _ico('x', 13, 'var(--danger)') + ' Key found (preview: ' + (d.keyPreview||'?') + ') but API rejected it — HTTP ' + ping.status + ': ' + esc(ping.body||'unknown error') + '</span>';
    }
    if (d.budgetOk === false) msg += '<br><span style="color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' Budget limit reached this month — increase it in AI Settings.</span>';
    el.innerHTML = '<div style="padding:6px 10px;background:var(--surface);border-radius:6px;border:1px solid var(--border);">' + msg + '</div>';
  } catch(err) {
    el.innerHTML = '<span style="color:var(--danger);">' + _ico('x', 13, 'var(--danger)') + ' Test failed: ' + esc(err.message) + '</span>';
  }
}

async function removeApiKey(keyName) {
  if (!confirm('Remove ' + keyName + '? This only removes the UI-saved key. Environment variables set via wrangler are unaffected.')) return;
  try {
    var d = await api('/api/keys/save', 'POST', { key: keyName, value: '' });
    toast(d.message || 'Removed');
    checkApiKeys();
  } catch (err) { toast(err.message, 'error'); }
}

// Live expense calculation
document.addEventListener('input', function(e) {
  var expenseIds = ['f_mortgage','f_insurance','f_taxes','f_hoa','f_monthly_rent','f_electric','f_gas','f_water','f_internet','f_trash','f_other_expense'];
  if (expenseIds.indexOf(e.target.id) >= 0) updateCostSummary();
});

// Analysis Type
function setAnalysisType(type) {
  analysisType = type;
  document.querySelectorAll('.analysis-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
}

function onAnalyzePropertyChange() {
  var pid = document.getElementById('analyzePropertySelect').value;
  if (!pid) return;
  // Load amenities for this property
  loadPropertyAmenities(pid);
  // Load PriceLabs calendar if linked
  if (typeof loadPLCalendar === 'function') loadPLCalendar(pid);
}

async function loadPropertyAmenities(pid) {
  try {
    var d = await api('/api/properties/' + pid + '/amenities');
    selectedAmenities = new Set((d.amenity_ids || []).map(function(id) { return id; }));
    renderAmenityChips();
    var statusEl = document.getElementById('amenitySaveStatus');
    if (statusEl) statusEl.textContent = selectedAmenities.size > 0 ? '(' + selectedAmenities.size + ' selected)' : '';
  } catch { selectedAmenities = new Set(); renderAmenityChips(); }
}

// Market AI toggle
function toggleMarketAI() {
  marketAiEnabled = !marketAiEnabled;
  var el = document.getElementById('marketAiToggle');
  if (el) el.classList.toggle('active', marketAiEnabled);
}

// Comp AI toggle
function toggleCompAI() {
  compAiEnabled = !compAiEnabled;
  var el = document.getElementById('compAiToggle');
  if (el) el.classList.toggle('active', compAiEnabled);
}

// Market city management — now backed by watchlist DB, not localStorage
async function loadMarketCities() {
  // Auto-populate watchlist from property cities (idempotent)
  try { await api('/api/watchlist/auto-populate', 'POST'); } catch {}
  // Load from watchlist
  try {
    var d = await api('/api/watchlist');
    var wl = d.watchlist || [];
    marketCities = wl.map(function(w) { return { city: w.city, state: w.state, tier: w.tier }; });
  } catch {
    marketCities = [];
  }
  renderMarketCities();
}

function renderMarketCities() {
  var el = document.getElementById('marketCities');
  if (!el) return;
  el.innerHTML = marketCities.map(function(c, i) {
    var tierColor = c.tier === 1 ? 'var(--accent)' : c.tier === 2 ? '#f59e0b' : 'var(--text3)';
    return '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-left:2px solid ' + tierColor + ';border-radius:16px;font-size:0.78rem;color:var(--text2);">' + esc(c.city) + ', ' + esc(c.state) + ' <span onclick="removeMarketCity(' + i + ')" style="cursor:pointer;color:var(--text3);font-size:0.9em;">✕</span></span>';
  }).join('');
}

async function addMarketCity() {
  var city = (document.getElementById('addCityInput') || {}).value.trim();
  var state = (document.getElementById('addStateInput') || {}).value.trim().toUpperCase();
  if (!city || !state) { toast('Enter city and state', 'error'); return; }
  try {
    await api('/api/watchlist', 'POST', { city: city, state: state, tier: 3, frequency: 'monthly' });
    document.getElementById('addCityInput').value = '';
    document.getElementById('addStateInput').value = '';
    loadMarketCities();
    toast(city + ', ' + state + ' added to watchlist');
  } catch (err) { toast(err.message, 'error'); }
}

async function removeMarketCity(idx) {
  var c = marketCities[idx];
  if (!c) return;
  // Find watchlist ID for this city
  try {
    var d = await api('/api/watchlist');
    var match = (d.watchlist || []).find(function(w) { return w.city.toLowerCase() === c.city.toLowerCase() && w.state.toLowerCase() === c.state.toLowerCase(); });
    if (match) {
      await api('/api/watchlist/' + match.id, 'DELETE');
      toast(c.city + ' removed from watchlist');
    }
  } catch (err) { toast(err.message, 'error'); }
  loadMarketCities();
}

// Market Deep Dive
var currentDeepDiveCity = null;
var currentDeepDiveState = null;

async function openMarketDeepDive(city, state) {
  currentDeepDiveCity = city;
  currentDeepDiveState = state;
  var panel = document.getElementById('marketDeepDive');
  var title = document.getElementById('deepDiveTitle');
  var dataEl = document.getElementById('deepDiveData');
  var historyEl = document.getElementById('deepDiveAiHistory');
  if (!panel) return;
  panel.style.display = '';
  if (title) title.textContent = city + ', ' + state + ' — Deep Dive';
  if (dataEl) dataEl.innerHTML = '<p style="color:var(--text3);">Loading...</p>';
  if (historyEl) historyEl.innerHTML = '';

  // Load existing insights
  try {
    var d = await api('/api/market/insights/' + encodeURIComponent(city) + '/' + encodeURIComponent(state));
    var insights = d.insights || [];
    renderDeepDiveHistory(insights);
  } catch {}

  // Show snapshot history
  try {
    var md = await api('/api/market');
    var snaps = (md.snapshots || []).filter(function(s) { return s.city === city && s.state === state; });
    var h = '<h4 style="margin-bottom:10px;font-size:0.88rem;">Data History (' + snaps.length + ' snapshots)</h4>';
    if (snaps.length > 0) {
      h += '<table class="comp-table"><thead><tr><th>Date</th><th>Avg Rate</th><th>Median</th><th>Occupancy</th><th>Listings</th><th>Source</th></tr></thead><tbody>';
      snaps.forEach(function(s) {
        h += '<tr><td>' + (s.snapshot_date || '').substring(0, 10) + '</td><td>' + (s.avg_daily_rate ? '$' + s.avg_daily_rate : '—') + '</td><td>' + (s.median_daily_rate ? '$' + s.median_daily_rate : '—') + '</td><td>' + (s.avg_occupancy ? Math.round(s.avg_occupancy * 100) + '%' : '—') + '</td><td>' + (s.active_listings || '—') + '</td><td>' + esc(s.data_source || '') + '</td></tr>';
      });
      h += '</tbody></table>';
    } else {
      h += '<p style="color:var(--text3);font-size:0.85rem;">No data snapshots yet. Pull market data first.</p>';
    }
    if (dataEl) dataEl.innerHTML = h;
  } catch {}

  panel.scrollIntoView({ behavior: 'smooth' });
}

function renderDeepDiveHistory(insights) {
  var el = document.getElementById('deepDiveAiHistory');
  if (!el) return;
  if (insights.length === 0) {
    el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No AI analyses yet. Click "Run AI Deep Analysis" to generate one.</p>';
    return;
  }
  var h = '<h4 style="margin-bottom:10px;font-size:0.88rem;">AI Analysis History (' + insights.length + ')</h4>';
  insights.forEach(function(ins) {
    var date = fmtUTC(ins.created_at);
    h += '<div style="margin-bottom:12px;padding:14px;background:var(--purple-dim);border:1px solid rgba(167,139,250,0.2);border-radius:8px;">';
    h += '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:var(--purple);font-weight:600;font-size:0.82rem;">' + _ico('sparkle', 13, 'var(--purple)') + ' AI Analysis</span><span style="color:var(--text3);font-size:0.75rem;">' + date + '</span></div>';
    h += '<div style="font-size:0.85rem;color:var(--text);line-height:1.6;white-space:pre-wrap;">' + esc(ins.analysis) + '</div>';
    h += '</div>';
  });
  el.innerHTML = h;
}

async function runMarketAiDeepDive() {
  if (!currentDeepDiveCity || !currentDeepDiveState) return;
  showLoading('Running AI deep analysis for ' + currentDeepDiveCity + '...');
  try {
    var d = await api('/api/market/deep-dive', 'POST', { city: currentDeepDiveCity, state: currentDeepDiveState });
    if (d.insights) renderDeepDiveHistory(d.insights);
    if (d.analysis) toast('AI analysis saved for ' + currentDeepDiveCity);
    else toast('AI analysis not available — check Workers AI binding', 'warn');
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

function closeMarketDeepDive() {
  var panel = document.getElementById('marketDeepDive');
  if (panel) panel.style.display = 'none';
}


// ═══════════════════════════════════════════════════════════════════════════
// MARKET INTELLIGENCE — Profiles, Comparison, AI Enrichment
// ═══════════════════════════════════════════════════════════════════════════

var _mktProfiles = [];
var _currentMktCity = null;
var _currentMktState = null;

async function loadMarketProfiles() {
  var el = document.getElementById('marketProfilesGrid');
  if (!el) return;
  el.innerHTML = '<div style="padding:12px;text-align:center;color:var(--text3);">Building market profiles...</div>';
  try {
    var d = await api('/api/market/profiles');
    _mktProfiles = d.profiles || [];
    renderMarketGrid();
    var btn = document.getElementById('mktCompareBtn');
    if (btn) btn.style.display = _mktProfiles.length >= 2 ? '' : 'none';
  } catch (err) {
    el.innerHTML = '<div style="color:var(--danger);padding:12px;">' + esc(err.message) + '</div>';
  }
}

function renderMarketGrid() {
  var el = document.getElementById('marketProfilesGrid');
  if (!el) return;
  if (_mktProfiles.length === 0) {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);">No markets found. Add properties or watchlist cities to build market profiles.</div>';
    return;
  }

  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;">';
  _mktProfiles.forEach(function(p) {
    var hasYour = (p.your_property_count || 0) > 0;
    var borderColor = hasYour ? 'var(--accent)' : 'var(--border)';
    var yourVsMkt = '';
    if (hasYour && p.your_avg_adr && p.str_avg_adr) {
      var diff = p.your_avg_adr - p.str_avg_adr;
      yourVsMkt = diff >= 0 ? '<span style="color:var(--accent);">\u2191 $' + Math.round(diff) + ' above market</span>' : '<span style="color:var(--danger);">\u2193 $' + Math.abs(Math.round(diff)) + ' below market</span>';
    }
    var aiTag = p.ai_enriched_at ? '<span style="font-size:0.7rem;padding:2px 6px;background:rgba(167,139,250,0.15);color:#a78bfa;border-radius:3px;">' + _ico('sparkle', 13, 'var(--purple)') + ' AI</span>' : '';

    h += '<div onclick="openMarketProfile(\'' + esc(p.city) + '\',\'' + esc(p.state) + '\')" style="padding:16px 18px;background:var(--surface);border:1px solid ' + borderColor + ';border-radius:10px;cursor:pointer;transition:border-color 0.15s;" onmouseenter="this.style.borderColor=\'var(--accent)\'" onmouseleave="this.style.borderColor=\'' + borderColor + '\'">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
    h += '<div><span style="font-weight:700;font-size:1.05rem;">' + esc(p.city) + '</span><span style="color:var(--text3);margin-left:6px;font-size:0.9rem;">' + esc(p.state) + '</span> ' + aiTag + '</div>';
    if (hasYour) h += '<span style="font-size:0.78rem;background:rgba(16,185,129,0.12);color:var(--accent);padding:3px 8px;border-radius:4px;font-weight:600;">' + p.your_property_count + ' propert' + (p.your_property_count === 1 ? 'y' : 'ies') + '</span>';
    h += '</div>';

    // Key metrics
    h += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:10px;">';
    h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.05rem;color:var(--text);">' + (p.str_listing_count || '\u2014') + '</div><div style="font-size:0.72rem;color:var(--text3);">STR Listings</div></div>';
    h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.05rem;color:var(--accent);">$' + Math.round(p.str_avg_adr || 0) + '</div><div style="font-size:0.72rem;color:var(--text3);">Avg ADR</div></div>';
    h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.05rem;color:' + ((p.str_avg_occupancy || 0) >= 60 ? 'var(--accent)' : '#f59e0b') + ';">' + (p.str_avg_occupancy || '\u2014') + '%</div><div style="font-size:0.72rem;color:var(--text3);">Occupancy</div></div>';
    h += '</div>';

    // Your performance vs market
    if (yourVsMkt) h += '<div style="font-size:0.82rem;margin-bottom:6px;">' + yourVsMkt + '</div>';

    // Trend and new listings
    var trendParts = [];
    if (p.adr_trend_3mo !== null && p.adr_trend_3mo !== undefined) trendParts.push('ADR ' + (p.adr_trend_3mo >= 0 ? '\u2191' : '\u2193') + Math.abs(p.adr_trend_3mo) + '%');
    if (p.new_listings_30d > 0) trendParts.push(p.new_listings_30d + ' new listings/30d');
    if (p.str_avg_rating) trendParts.push('\u2605 ' + p.str_avg_rating);
    if (trendParts.length > 0) h += '<div style="font-size:0.78rem;color:var(--text3);">' + trendParts.join(' \u00b7 ') + '</div>';

    h += '</div>';
  });
  h += '</div>';
  el.innerHTML = h;
}

async function openMarketProfile(city, state) {
  _currentMktCity = city;
  _currentMktState = state;
  document.getElementById('marketProfilesSection').style.display = 'none';
  document.getElementById('marketCompareSection').style.display = 'none';
  var detail = document.getElementById('marketProfileDetail');
  detail.style.display = '';
  document.getElementById('mktProfileTitle').textContent = city + ', ' + state + ' — Market Profile';
  document.getElementById('mktProfileContent').innerHTML = '<div style="padding:16px;text-align:center;color:var(--text3);">Loading profile...</div>';

  try {
    var d = await api('/api/market/profile?city=' + encodeURIComponent(city) + '&state=' + encodeURIComponent(state));
    // Show last updated in title
    var prof = d.profile || {};
    var titleEl = document.getElementById('mktProfileTitle');
    if (titleEl) {
      var lastUp = prof.last_updated ? ' <span style="font-size:0.75rem;font-weight:400;color:var(--text3);">Updated ' + fmtUTC(prof.last_updated) + '</span>' : '';
      titleEl.innerHTML = esc(city) + ', ' + esc(state) + lastUp;
    }
    renderMarketProfile(d);
  } catch (err) {
    document.getElementById('mktProfileContent').innerHTML = '<div style="color:var(--danger);">' + esc(err.message) + '</div>';
  }
}

function closeMarketProfile() {
  document.getElementById('marketProfileDetail').style.display = 'none';
  document.getElementById('marketProfilesSection').style.display = '';
}

function renderMarketProfile(d) {
  var el = document.getElementById('mktProfileContent');
  if (!el) return;
  var p = d.profile || {};
  var h = '';

  // Check if we have real STR landscape data (from crawls/master_listings)
  var hasStrData = (p.str_listing_count || 0) > 0 || (p.str_avg_adr || 0) > 0;
  // Check if we have your performance data
  var hasYourData = (p.your_property_count || 0) > 0 && ((p.your_avg_adr || 0) > 0 || (p.your_total_revenue || 0) > 0);

  // ── Alerts ──────────────────────────────────────────────────────────────
  var alerts = d.alerts || [];
  if (alerts.length > 0) {
    h += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px;">';
    alerts.forEach(function(a) {
      var clr = a.type === 'danger' ? 'var(--danger)' : a.type === 'warning' ? '#f59e0b' : 'var(--accent)';
      var bg = a.type === 'danger' ? 'rgba(239,68,68,0.08)' : a.type === 'warning' ? 'rgba(245,158,11,0.08)' : 'rgba(16,185,129,0.08)';
      h += '<div style="padding:8px 12px;background:' + bg + ';border:1px solid ' + clr + '33;border-radius:6px;font-size:0.78rem;color:' + clr + ';">' + _ico('alertCircle', 13, clr) + ' ' + esc(a.text) + '</div>';
    });
    h += '</div>';
  }

  // ── Overview cards ─────────────────────────────────────────────────────
  if (hasStrData) {
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px;">';
    if (p.str_listing_count) h += _mktStat(p.str_listing_count, 'STR Listings');
    if (p.str_avg_adr) h += _mktStat('$' + Math.round(p.str_avg_adr), 'Avg ADR');
    if (p.str_median_adr) h += _mktStat('$' + Math.round(p.str_median_adr), 'Median ADR');
    if (p.str_avg_occupancy) h += _mktStat(String(p.str_avg_occupancy).replace(/%/g, '') + '%', 'Occupancy');
    if (p.str_avg_rating) h += _mktStat('\u2605 ' + p.str_avg_rating, 'Avg Rating');
    if (p.str_superhost_pct) h += _mktStat(p.str_superhost_pct + '%', 'Superhosts');
    if (p.new_listings_30d) h += _mktStat(p.new_listings_30d, 'New (30d)');
    if (p.ltr_avg_rent) h += _mktStat('$' + Math.round(p.ltr_avg_rent), 'LTR Avg Rent');
    h += '</div>';
  } else {
    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:16px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">';
    h += '<div>';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--text2);margin-bottom:6px;">' + _ico('search', 14, 'var(--text2)') + ' Market landscape data not yet available</div>';
    h += '<div style="font-size:0.75rem;color:var(--text3);line-height:1.5;">Listing counts, average ADR, ratings, and property type breakdowns come from crawled Airbnb/VRBO data. Click Crawl to pull the latest data for ' + esc(p.city || '') + '. Uses ~2 SearchAPI calls.</div>';
    h += '</div>';
    h += '<button class="btn btn-sm" onclick="crawlCurrentMarket()" id="mktCrawlBtn" style="white-space:nowrap;flex-shrink:0;">' + _ico('search', 13) + ' Crawl ' + esc(p.city || 'Market') + '</button>';
    h += '</div></div>';
  }

  // ── Your Performance vs Market ─────────────────────────────────────────
  if (p.your_property_count > 0 && hasYourData) {
    h += '<div class="prop-section green" style="margin-bottom:14px;">';
    h += '<div class="prop-section-hdr"><span class="icon">' + _ico('trendUp', 13) + '</span><span style="color:#10b981;">Your Performance' + (hasStrData ? ' vs Market' : '') + '</span></div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;">';
    if (hasStrData) {
      h += _mktVsCard('ADR', p.your_avg_adr, p.str_avg_adr, '$');
      if (p.str_avg_occupancy) h += _mktVsCard('Occupancy', p.your_avg_occupancy, p.str_avg_occupancy, '%');
    } else {
      if (p.your_avg_adr) h += '<div style="padding:10px;background:var(--bg);border-radius:6px;text-align:center;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.1rem;color:var(--accent);">$' + Math.round(p.your_avg_adr) + '/nt</div><div style="font-size:0.75rem;color:var(--text3);">Your Avg ADR</div></div>';
      if (p.your_avg_occupancy) h += '<div style="padding:10px;background:var(--bg);border-radius:6px;text-align:center;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.1rem;">' + p.your_avg_occupancy + '%</div><div style="font-size:0.75rem;color:var(--text3);">Your Occupancy</div></div>';
    }
    h += '<div style="padding:10px;background:var(--bg);border-radius:6px;text-align:center;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.1rem;color:var(--accent);">$' + (p.your_total_revenue || 0).toLocaleString() + '</div><div style="font-size:0.75rem;color:var(--text3);">Your Revenue (12mo)</div></div>';
    h += '<div style="padding:10px;background:var(--bg);border-radius:6px;text-align:center;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.1rem;">' + p.your_property_count + '</div><div style="font-size:0.75rem;color:var(--text3);">Your Properties</div></div>';
    h += '</div></div>';
  }

  // ── Your Monthly Revenue Trend ─────────────────────────────────────────
  var monthlyRev = d.monthly_revenue || [];
  if (monthlyRev.length >= 3) {
    h += '<div class="prop-section green" style="margin-bottom:14px;">';
    h += '<div class="prop-section-hdr"><span class="icon">' + _ico('dollarSign', 13) + '</span><span style="color:#10b981;">Monthly Revenue Trend</span></div>';
    var maxRev = Math.max.apply(null, monthlyRev.map(function(m) { return m.revenue || 0; }));
    h += '<div style="display:flex;gap:3px;align-items:flex-end;height:120px;padding:4px 0;">';
    var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    monthlyRev.forEach(function(m) {
      var rev = m.revenue || 0;
      var pct = maxRev > 0 ? Math.max(Math.round(rev / maxRev * 100), 3) : 3;
      var occ = m.occ ? Math.round(m.occ) : 0;
      var adr = m.adr ? Math.round(m.adr) : 0;
      var monthNum = parseInt(m.month.split('-')[1]);
      var mLabel = mNames[monthNum - 1] || m.month;
      var yrSuffix = m.month.substring(2, 4);
      h += '<div style="flex:1;text-align:center;min-width:0;" title="' + m.month + ': $' + rev.toLocaleString() + ' rev, ' + occ + '% occ, $' + adr + ' ADR">';
      h += '<div style="font-size:0.68rem;color:var(--accent);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (rev > 0 ? '$' + (rev >= 1000 ? Math.round(rev / 1000) + 'k' : rev) : '') + '</div>';
      h += '<div style="background:var(--accent);border-radius:3px 3px 0 0;height:' + pct + '%;opacity:0.7;"></div>';
      h += '<div style="font-size:0.7rem;color:var(--text3);margin-top:2px;">' + mLabel + '</div>';
      h += '<div style="font-size:0.72rem;color:var(--text3);">\u2019' + yrSuffix + '</div>';
      h += '</div>';
    });
    h += '</div>';
    // Summary stats
    var totalRev = monthlyRev.reduce(function(a, m) { return a + (m.revenue || 0); }, 0);
    var avgRev = Math.round(totalRev / monthlyRev.length);
    var lastThree = monthlyRev.slice(-3);
    var recentAvg = lastThree.length > 0 ? Math.round(lastThree.reduce(function(a, m) { return a + (m.revenue || 0); }, 0) / lastThree.length) : 0;
    var trendDir = recentAvg > avgRev ? 'trending up' : recentAvg < avgRev * 0.85 ? 'trending down' : 'stable';
    var trendColor = trendDir === 'trending up' ? 'var(--accent)' : trendDir === 'trending down' ? 'var(--danger)' : 'var(--text3)';
    h += '<div style="display:flex;gap:16px;font-size:0.72rem;color:var(--text3);margin-top:6px;flex-wrap:wrap;">';
    h += '<span>Avg: <strong style="color:var(--text);">$' + avgRev.toLocaleString() + '/mo</strong></span>';
    h += '<span>Last 3mo avg: <strong style="color:' + trendColor + ';">$' + recentAvg.toLocaleString() + '/mo</strong> (' + trendDir + ')</span>';
    h += '<span>Total: <strong style="color:var(--text);">$' + totalRev.toLocaleString() + '</strong></span>';
    h += '</div></div>';
  }

  // ── STR Landscape ──────────────────────────────────────────────────────
  h += '<div class="prop-section blue" style="margin-bottom:14px;">';
  h += '<div class="prop-section-hdr"><span class="icon">' + _ico('home', 13) + '</span><span style="color:#60a5fa;">STR Landscape</span></div>';

  var typeMix = _mktJson(p.str_property_mix, []);
  var bedMix = _mktJson(p.str_bedroom_mix, []);
  var priceBands = _mktJson(p.str_price_bands, []);

  if (typeMix.length > 0) {
    h += '<div style="margin-bottom:12px;"><div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">Property Types</div>';
    h += '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
    typeMix.forEach(function(t) {
      h += '<span style="padding:4px 10px;background:var(--bg);border-radius:4px;font-size:0.75rem;">' + esc(t.type || '?') + ' <strong>' + t.pct + '%</strong> <span style="color:var(--text3);">(' + t.count + ')</span></span>';
    });
    h += '</div></div>';
  }

  if (bedMix.length > 0) {
    h += '<div style="margin-bottom:12px;"><div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">Bedroom Distribution</div>';
    h += '<div style="display:flex;gap:3px;align-items:flex-end;height:60px;">';
    var maxBed = Math.max.apply(null, bedMix.map(function(b) { return b.count; }));
    bedMix.forEach(function(b) {
      var ht = maxBed > 0 ? Math.max(Math.round(b.count / maxBed * 100), 5) : 5;
      h += '<div style="flex:1;text-align:center;"><div style="background:var(--accent);border-radius:3px 3px 0 0;height:' + ht + '%;opacity:0.7;"></div>';
      h += '<div style="font-size:0.6rem;color:var(--text3);margin-top:2px;">' + b.beds + 'BR</div>';
      h += '<div style="font-size:0.75rem;color:var(--text3);">' + b.pct + '%</div></div>';
    });
    h += '</div></div>';
  }

  if (priceBands.length > 0) {
    h += '<div style="margin-bottom:8px;"><div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">Price Bands</div>';
    h += '<div style="display:flex;gap:3px;align-items:flex-end;height:50px;">';
    var maxBand = Math.max.apply(null, priceBands.map(function(b) { return b.ct; }));
    priceBands.forEach(function(b) {
      var ht = maxBand > 0 ? Math.max(Math.round(b.ct / maxBand * 100), 5) : 5;
      h += '<div style="flex:1;text-align:center;"><div style="background:#60a5fa;border-radius:3px 3px 0 0;height:' + ht + '%;opacity:0.6;"></div>';
      h += '<div style="font-size:0.75rem;color:var(--text3);margin-top:2px;">' + esc(b.band) + '</div>';
      h += '<div style="font-size:0.75rem;color:var(--text3);">' + b.ct + '</div></div>';
    });
    h += '</div></div>';
  }

  // Rate Matrix — bed/bath breakdown
  var rateMatrix = _mktJson(p.rate_matrix_json, null);
  if (rateMatrix && rateMatrix.entries && rateMatrix.entries.length > 0) {
    h += '<div style="margin-top:12px;margin-bottom:12px;">';
    h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">' + _ico('dollarSign', 13) + ' Rate Matrix <span style="color:var(--text3);font-weight:400;">(' + rateMatrix.total_listings + ' listings)</span></div>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:0.75rem;">';
    h += '<thead><tr style="border-bottom:1px solid var(--border);"><th style="text-align:left;padding:4px 8px;color:var(--text3);font-weight:500;">Beds/Baths</th><th style="text-align:right;padding:4px 8px;color:var(--text3);font-weight:500;">Median</th><th style="text-align:right;padding:4px 8px;color:var(--text3);font-weight:500;">Range (p25-p75)</th><th style="text-align:right;padding:4px 8px;color:var(--text3);font-weight:500;">Listings</th></tr></thead><tbody>';
    rateMatrix.entries.forEach(function(e) {
      h += '<tr style="border-bottom:1px solid var(--border2);"><td style="padding:4px 8px;font-weight:600;">' + e.beds + 'BR / ' + e.baths + 'BA</td>';
      h += '<td style="text-align:right;padding:4px 8px;font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">$' + e.median + '</td>';
      h += '<td style="text-align:right;padding:4px 8px;font-family:DM Mono,monospace;color:var(--text2);">$' + e.p25 + ' – $' + e.p75 + '</td>';
      h += '<td style="text-align:right;padding:4px 8px;color:var(--text3);">' + e.count + '</td></tr>';
    });
    h += '</tbody></table>';
    if (rateMatrix.increments && (rateMatrix.increments.per_bedroom || rateMatrix.increments.per_bathroom)) {
      h += '<div style="margin-top:6px;font-size:0.72rem;color:var(--text3);">';
      if (rateMatrix.increments.per_bedroom) h += _ico('plus', 11) + ' <strong>$' + rateMatrix.increments.per_bedroom + '</strong>/bedroom  ';
      if (rateMatrix.increments.per_bathroom) h += _ico('plus', 11) + ' <strong>$' + rateMatrix.increments.per_bathroom + '</strong>/bathroom';
      h += '</div>';
    }
    h += '</div>';
  }

  // Top hosts in market
  var topHosts = d.top_hosts || [];
  if (topHosts.length > 0) {
    h += '<div style="margin-top:12px;"><div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">Top Hosts (2+ listings)</div>';
    h += '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
    topHosts.forEach(function(host) {
      h += '<span style="padding:4px 10px;background:var(--bg);border-radius:4px;font-size:0.72rem;">' + esc(host.host_name || host.name || '?') + ' <strong>' + (host.listings || host.ct || 0) + '</strong> listings';
      if (host.avg_rating) h += ' <span style="color:var(--text3);">\u2605' + host.avg_rating + '</span>';
      if (host.avg_rate) h += ' <span style="color:var(--text3);">$' + Math.round(host.avg_rate) + '/nt</span>';
      h += '</span>';
    });
    h += '</div></div>';
  }
  h += '</div>';

  // ── Snapshot Trend ─────────────────────────────────────────────────────
  var snaps = (d.snapshots || []).reverse();
  if (snaps.length >= 2) {
    h += '<div class="prop-section amber" style="margin-bottom:14px;">';
    h += '<div class="prop-section-hdr"><span class="icon">' + _ico('trendUp', 13) + '</span><span style="color:#f59e0b;">Market Data Trend</span><span class="sub">' + snaps.length + ' snapshots</span></div>';
    var maxSnAdr = Math.max.apply(null, snaps.map(function(s) { return s.avg_daily_rate || 0; }));
    h += '<div style="display:flex;gap:4px;align-items:flex-end;height:90px;">';
    snaps.forEach(function(s) {
      var val = s.avg_daily_rate || 0;
      var pct = maxSnAdr > 0 ? Math.max(Math.round(val / maxSnAdr * 100), 5) : 5;
      var dateLabel = (s.snapshot_date || '').substring(5, 10);
      h += '<div style="flex:1;text-align:center;" title="' + (s.snapshot_date || '') + ': $' + Math.round(val) + ' ADR, ' + (s.active_listings || '?') + ' listings">';
      h += '<div style="font-size:0.68rem;color:#f59e0b;font-weight:600;">' + (val > 0 ? '$' + Math.round(val) : '') + '</div>';
      h += '<div style="background:#f59e0b;border-radius:3px 3px 0 0;height:' + pct + '%;opacity:0.6;"></div>';
      h += '<div style="font-size:0.7rem;color:var(--text3);margin-top:2px;">' + dateLabel + '</div>';
      h += '</div>';
    });
    h += '</div>';
    // First vs last comparison
    var first = snaps[0], last = snaps[snaps.length - 1];
    if (first.avg_daily_rate && last.avg_daily_rate) {
      var adrChange = Math.round((last.avg_daily_rate - first.avg_daily_rate) / first.avg_daily_rate * 100);
      var adrDir = adrChange >= 0 ? '\u2191' : '\u2193';
      var adrClr = adrChange >= 0 ? 'var(--accent)' : 'var(--danger)';
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">ADR: $' + Math.round(first.avg_daily_rate) + ' \u2192 $' + Math.round(last.avg_daily_rate) + ' <span style="color:' + adrClr + ';">' + adrDir + Math.abs(adrChange) + '%</span></div>';
    }
    h += '</div>';
  }

  // ── Seasonality ────────────────────────────────────────────────────────
  var seasons = d.seasonality || [];
  if (seasons.length >= 6) {
    h += '<div class="prop-section amber" style="margin-bottom:14px;">';
    h += '<div class="prop-section-hdr"><span class="icon">' + _ico('calendar', 13) + '</span><span style="color:#f59e0b;">Pricing Power by Month</span></div>';
    h += '<div style="font-size:0.7rem;color:var(--text3);margin-bottom:8px;">Average nightly rate by month from your booking data. <strong style="color:var(--accent);">Green</strong> = above annual average, <strong style="color:var(--danger);">red</strong> = below.</div>';
    var mNames2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    h += '<div style="display:flex;gap:3px;align-items:flex-end;height:100px;">';
    var maxMult = Math.max.apply(null, seasons.map(function(s) { return s.multiplier || 1; }));
    seasons.forEach(function(s) {
      var mult = s.multiplier || 1;
      var pct = maxMult > 0 ? Math.round(mult / maxMult * 100) : 50;
      var clr = mult >= 1.1 ? 'var(--accent)' : mult <= 0.85 ? 'var(--danger)' : '#f59e0b';
      var diffPct = Math.round((mult - 1) * 100);
      var diffLabel = diffPct > 0 ? '+' + diffPct + '%' : diffPct === 0 ? 'avg' : diffPct + '%';
      h += '<div style="flex:1;text-align:center;" title="' + mNames2[(s.month_number || 1) - 1] + ': ' + (s.avg_adr ? '$' + Math.round(s.avg_adr) + '/nt' : 'no data') + ' (' + diffLabel + ' vs annual avg)">';
      h += '<div style="font-size:0.7rem;color:' + clr + ';font-weight:600;">' + (s.avg_adr ? '$' + Math.round(s.avg_adr) : '') + '</div>';
      h += '<div style="background:' + clr + ';border-radius:3px 3px 0 0;height:' + Math.max(pct, 5) + '%;opacity:0.7;"></div>';
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:2px;">' + mNames2[(s.month_number || 1) - 1] + '</div>';
      h += '<div style="font-size:0.75rem;color:' + clr + ';">' + diffLabel + '</div>';
      h += '</div>';
    });
    h += '</div></div>';
  }

  // ── Your properties in this market ─────────────────────────────────────
  var yourProps = d.your_properties || [];
  if (yourProps.length > 0) {
    h += '<div class="prop-section neutral" style="margin-bottom:14px;">';
    h += '<div class="prop-section-hdr"><span class="icon">' + _ico('home', 13) + '</span><span style="color:var(--text2);">Your Properties in ' + esc(p.city) + '</span></div>';
    h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.75rem;"><thead><tr><th>Property</th><th>Type</th><th>Beds</th><th>PL Base</th><th>PL Rec</th><th>Your Occ</th><th>Mkt Occ</th></tr></thead><tbody>';
    yourProps.forEach(function(pr) {
      var label = pr.unit_number ? pr.unit_number + ' \u2014 ' + (pr.address || '') : (pr.name || pr.address || '?');
      h += '<tr onclick="openProperty(' + pr.id + ')" style="cursor:pointer;">';
      h += '<td style="font-weight:600;">' + esc(label).substring(0, 30) + '</td>';
      h += '<td>' + esc(pr.property_type || '') + '</td>';
      h += '<td>' + (pr.bedrooms || '?') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (pr.pl_base ? '$' + pr.pl_base : '\u2014') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (pr.pl_rec ? '$' + pr.pl_rec : '\u2014') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (pr.occupancy_next_30 ? String(pr.occupancy_next_30).replace(/%/g, '') + '%' : '\u2014') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (pr.market_occupancy_next_30 ? String(pr.market_occupancy_next_30).replace(/%/g, '') + '%' : '\u2014') + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div></div>';
  }

  // ── AI Analysis (Tier 3) ───────────────────────────────────────────────
  if (p.ai_enriched_at) {
    h += '<div class="prop-section purple" style="margin-bottom:14px;">';
    h += '<div class="prop-section-hdr"><span class="icon">' + _ico('sparkle', 13, 'var(--purple)') + '</span><span style="color:var(--purple);">AI Market Analysis</span><span class="sub">Enriched ' + fmtUTC(p.ai_enriched_at) + '</span></div>';

    var drivers = _mktJson(p.ai_demand_drivers, []);
    if (drivers.length > 0) {
      h += '<div style="margin-bottom:10px;"><strong style="font-size:0.78rem;color:var(--text2);">Demand Drivers:</strong>';
      h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">';
      drivers.forEach(function(dd) { h += '<span style="padding:3px 8px;background:var(--bg);border-radius:4px;font-size:0.75rem;">' + esc(dd) + '</span>'; });
      h += '</div></div>';
    }

    if (p.ai_regulatory_notes) h += '<div style="margin-bottom:10px;"><strong style="font-size:0.78rem;color:var(--text2);">Regulations:</strong><div style="font-size:0.78rem;color:var(--text);line-height:1.5;margin-top:3px;">' + esc(p.ai_regulatory_notes) + '</div></div>';
    if (p.ai_investment_thesis) h += '<div style="margin-bottom:10px;"><strong style="font-size:0.78rem;color:var(--text2);">Investment Thesis:</strong><div style="font-size:0.78rem;color:var(--text);line-height:1.5;margin-top:3px;">' + esc(p.ai_investment_thesis) + '</div></div>';
    if (p.ai_competitive_position) h += '<div style="margin-bottom:10px;"><strong style="font-size:0.78rem;color:var(--text2);">Competitive Position:</strong><div style="font-size:0.78rem;color:var(--text);line-height:1.5;margin-top:3px;">' + esc(p.ai_competitive_position) + '</div></div>';

    var recs = _mktJson(p.ai_recommendations, []);
    if (recs.length > 0) {
      h += '<div style="margin-bottom:10px;"><strong style="font-size:0.78rem;color:var(--text2);">Recommendations:</strong>';
      recs.forEach(function(r) { h += '<div style="padding:4px 0 4px 12px;font-size:0.78rem;color:var(--text);border-left:2px solid var(--accent);margin-top:4px;">' + esc(r) + '</div>'; });
      h += '</div>';
    }

    var risks = _mktJson(p.ai_risk_factors, []);
    if (risks.length > 0) {
      h += '<div><strong style="font-size:0.78rem;color:var(--text2);">Risk Factors:</strong>';
      risks.forEach(function(r) { h += '<div style="padding:4px 0 4px 12px;font-size:0.78rem;color:var(--danger);border-left:2px solid var(--danger);margin-top:4px;">' + esc(r) + '</div>'; });
      h += '</div>';
    }
    h += '</div>';

    // Demographics section
    var demo = _mktJson(p.demographics_json, null);
    if (demo) {
      h += '<div class="prop-section blue" style="margin-bottom:14px;">';
      h += '<div class="prop-section-hdr"><span class="icon">' + _ico('globe', 15) + '</span><span style="color:#60a5fa;">Area Demographics & Profile</span><span class="sub">Updated ' + fmtUTC(p.demographics_updated_at || p.ai_enriched_at) + '</span></div>';
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-bottom:10px;">';
      if (demo.population) h += '<div style="padding:8px 10px;background:var(--bg);border-radius:6px;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:0.9rem;">' + esc(demo.population) + '</div><div style="font-size:0.6rem;color:var(--text3);">Population</div></div>';
      if (demo.median_household_income) h += '<div style="padding:8px 10px;background:var(--bg);border-radius:6px;"><div style="font-family:DM Mono,monospace;font-weight:700;font-size:0.9rem;">' + esc(demo.median_household_income) + '</div><div style="font-size:0.6rem;color:var(--text3);">Median Income</div></div>';
      if (demo.area_character) h += '<div style="padding:8px 10px;background:var(--bg);border-radius:6px;grid-column:span 2;"><div style="font-size:0.78rem;color:var(--text);">' + esc(demo.area_character) + '</div><div style="font-size:0.6rem;color:var(--text3);">Area Character</div></div>';
      h += '</div>';
      if (demo.top_employers && demo.top_employers.length > 0) {
        h += '<div style="margin-bottom:8px;"><strong style="font-size:0.72rem;color:var(--text2);">' + _ico('building', 12) + ' Top Employers / Industries:</strong>';
        h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">';
        demo.top_employers.forEach(function(e) { h += '<span style="padding:3px 8px;background:var(--bg);border-radius:4px;font-size:0.72rem;color:var(--text);">' + esc(e) + '</span>'; });
        h += '</div></div>';
      }
      if (demo.tourism_profile) h += '<div style="margin-bottom:8px;"><strong style="font-size:0.72rem;color:var(--text2);">' + _ico('mapPin', 12) + ' Tourism:</strong><div style="font-size:0.75rem;color:var(--text);line-height:1.5;margin-top:3px;">' + esc(demo.tourism_profile) + '</div></div>';
      if (demo.transportation) h += '<div style="margin-bottom:8px;"><strong style="font-size:0.72rem;color:var(--text2);">' + _ico('compass', 12) + ' Transportation:</strong><div style="font-size:0.75rem;color:var(--text);line-height:1.5;margin-top:3px;">' + esc(demo.transportation) + '</div></div>';
      if (demo.growth_trend) h += '<div><strong style="font-size:0.72rem;color:var(--text2);">' + _ico('trendUp', 12) + ' Growth Trend:</strong><div style="font-size:0.75rem;color:var(--text);line-height:1.5;margin-top:3px;">' + esc(demo.growth_trend) + '</div></div>';
      h += '</div>';
    }
  } else {
    h += '<div style="padding:14px;background:var(--purple-dim);border:1px solid rgba(167,139,250,0.2);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:6px;">' + _ico('sparkle', 14, 'var(--purple)') + ' AI Market Analysis</div>';
    h += '<div style="font-size:0.75rem;color:var(--text2);line-height:1.5;margin-bottom:10px;">AI will analyze this market and generate: demand drivers, investment thesis, competitive positioning, regulatory notes, demographics, and actionable recommendations. Uses your property data + market knowledge.</div>';
    h += '<button class="btn btn-sm btn-purple" onclick="enrichCurrentMarket()">' + _ico('sparkle', 13, '#fff') + ' Run AI Market Analysis</button>';
    h += '</div>';
  }

  el.innerHTML = h;
}

function _mktJson(str, fallback) { try { return str ? JSON.parse(str) : fallback; } catch { return fallback; } }

function _mktStat(val, label) {
  return '<div style="text-align:center;padding:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;">' +
    '<div style="font-family:DM Mono,monospace;font-weight:700;font-size:1.1rem;">' + val + '</div>' +
    '<div style="font-size:0.78rem;color:var(--text3);margin-top:3px;">' + label + '</div></div>';
}

function _mktVsCard(label, yours, market, unit) {
  var y = yours || 0;
  var m = market || 0;
  var diff = y - m;
  var diffColor = diff >= 0 ? 'var(--accent)' : 'var(--danger)';
  var arrow = diff >= 0 ? '↑' : '↓';
  return '<div style="padding:10px;background:var(--bg);border-radius:6px;text-align:center;">' +
    '<div style="font-size:0.75rem;color:var(--text3);margin-bottom:4px;">' + label + '</div>' +
    '<div style="display:flex;justify-content:center;gap:12px;font-family:DM Mono,monospace;">' +
    '<div><div style="font-weight:700;color:var(--accent);">' + (unit === '$' ? '$' : '') + Math.round(y) + (unit === '%' ? '%' : '') + '</div><div style="font-size:0.68rem;color:var(--text3);">You</div></div>' +
    '<div><div style="font-weight:700;color:var(--text2);">' + (unit === '$' ? '$' : '') + Math.round(m) + (unit === '%' ? '%' : '') + '</div><div style="font-size:0.68rem;color:var(--text3);">Market</div></div>' +
    '</div>' +
    '<div style="font-size:0.68rem;color:' + diffColor + ';margin-top:4px;">' + arrow + ' ' + Math.abs(Math.round(diff)) + (unit === '%' ? ' pts' : '') + '</div>' +
    '</div>';
}

async function crawlCurrentMarket() {
  if (!_currentMktCity || !_currentMktState) return;
  var btn = document.getElementById('mktCrawlBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = _ico('clock', 13) + ' Crawling...'; }
  showLoading('Crawling Airbnb/VRBO listings for ' + _currentMktCity + '...');
  try {
    var d = await api('/api/intel/crawl', 'POST', { city: _currentMktCity, state: _currentMktState, platform: 'airbnb', listing_type: 'str' });
    if (d.error) {
      toast(d.error, 'error');
    } else {
      toast('Crawl complete: ' + (d.new || d.listings_new || 0) + ' new, ' + (d.updated || d.listings_updated || 0) + ' updated listings (' + (d.listings_found || 0) + ' total found)');
      // Refresh the profile to show new data
      openMarketProfile(_currentMktCity, _currentMktState);
    }
  } catch (err) { toast(err.message, 'error'); }
  if (btn) { btn.disabled = false; btn.innerHTML = _ico('search', 13) + ' Crawl ' + _currentMktCity; }
  hideLoading();
}

async function enrichCurrentMarket() {
  if (!_currentMktCity || !_currentMktState) return;
  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML ='' + _ico('clock', 13) + ' Analyzing...';
  try {
    var d = await api('/api/market/profile/enrich', 'POST', { city: _currentMktCity, state: _currentMktState });
    if (d.ok) {
      toast('AI analysis complete for ' + _currentMktCity + ' (' + d.provider + ')');
      openMarketProfile(_currentMktCity, _currentMktState);
    } else {
      toast(d.error || 'Enrichment failed', 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  btn.disabled = false;
  btn.innerHTML ='' + _ico('sparkle', 13) + ' AI Analysis';
}

// Tier 2: Market Comparison
function toggleMarketCompare() {
  var grid = document.getElementById('marketProfilesSection');
  var detail = document.getElementById('marketProfileDetail');
  var compare = document.getElementById('marketCompareSection');
  if (compare.style.display === 'none') {
    grid.style.display = 'none';
    detail.style.display = 'none';
    compare.style.display = '';
    renderMarketComparison();
  } else {
    compare.style.display = 'none';
    grid.style.display = '';
  }
}

function renderMarketComparison() {
  var el = document.getElementById('mktCompareContent');
  if (!el || _mktProfiles.length === 0) return;

  var h = '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.75rem;"><thead><tr>';
  h += '<th>Market</th><th>Your Props</th><th>STR Count</th><th>Avg ADR</th><th>Your ADR</th><th>Occupancy</th><th>Your Occ</th><th>Your Rev</th><th>Rating</th><th>Superhosts</th><th>New/30d</th><th>AI</th>';
  h += '</tr></thead><tbody>';

  _mktProfiles.forEach(function(p) {
    var hasYour = (p.your_property_count || 0) > 0;
    var adrDiff = (p.your_avg_adr && p.str_avg_adr) ? p.your_avg_adr - p.str_avg_adr : null;
    var occDiff = (p.your_avg_occupancy && p.str_avg_occupancy) ? p.your_avg_occupancy - p.str_avg_occupancy : null;

    h += '<tr onclick="openMarketProfile(\'' + esc(p.city) + '\',\'' + esc(p.state) + '\')" style="cursor:pointer;">';
    h += '<td style="font-weight:700;">' + esc(p.city) + ', ' + esc(p.state) + '</td>';
    h += '<td>' + (p.your_property_count || 0) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (p.str_listing_count || '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(p.str_avg_adr || 0) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (adrDiff !== null && adrDiff >= 0 ? 'var(--accent)' : adrDiff !== null ? 'var(--danger)' : 'var(--text3)') + ';">' + (p.your_avg_adr ? '$' + Math.round(p.your_avg_adr) : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (p.str_avg_occupancy || '—') + '%</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (occDiff !== null && occDiff >= 0 ? 'var(--accent)' : occDiff !== null ? 'var(--danger)' : 'var(--text3)') + ';">' + (p.your_avg_occupancy ? p.your_avg_occupancy + '%' : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">' + (p.your_total_revenue ? '$' + p.your_total_revenue.toLocaleString() : '—') + '</td>';
    h += '<td>' + (p.str_avg_rating ? '★ ' + p.str_avg_rating : '—') + '</td>';
    h += '<td>' + (p.str_superhost_pct || 0) + '%</td>';
    h += '<td>' + (p.new_listings_30d || 0) + '</td>';
    h += '<td>' + (p.ai_enriched_at ? '' + _ico('sparkle', 13, 'var(--purple)') + '' : '—') + '</td>';
    h += '</tr>';
  });

  h += '</tbody></table></div>';
  el.innerHTML = h;
}
