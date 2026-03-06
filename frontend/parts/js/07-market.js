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
      ANTHROPIC_API_KEY: { label: 'Anthropic Claude', desc: 'Premium AI analysis', url: 'https://console.anthropic.com', note: 'Per-token billing' },
      OPENAI_API_KEY: { label: 'OpenAI GPT', desc: 'Alternative AI provider', url: 'https://platform.openai.com', note: 'Per-token billing' },
    };
    var h = '<div style="display:grid;gap:10px;">';
    // AI Status Banner — show active provider and limitations
    var hasAnthropic = keys['ANTHROPIC_API_KEY'];
    var hasOpenAI = keys['OPENAI_API_KEY'];
    var hasWorkersAI = keys['WORKERS_AI'];
    var activeAI = hasAnthropic ? 'Anthropic Claude' : hasOpenAI ? 'OpenAI GPT-4o' : hasWorkersAI ? 'Workers AI (Free)' : 'None';
    var aiColor = hasAnthropic ? 'var(--accent)' : hasOpenAI ? 'var(--accent)' : hasWorkersAI ? '#f59e0b' : 'var(--danger)';

    h += '<div style="padding:14px;background:var(--bg);border:2px solid ' + (hasAnthropic || hasOpenAI ? 'rgba(16,185,129,0.3)' : hasWorkersAI ? 'rgba(245,158,11,0.3)' : 'rgba(239,68,68,0.3)') + ';border-radius:10px;margin-bottom:4px;">';
    h += '<div style="font-size:0.85rem;font-weight:600;margin-bottom:8px;">🤖 AI Provider Status</div>';
    h += '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">';
    h += '<div><span style="font-size:0.72rem;color:var(--text3);">Active:</span> <strong style="color:' + aiColor + ';">' + activeAI + '</strong></div>';
    h += '<div style="font-size:0.72rem;color:var(--text3);">Chain: ';
    h += '<span style="color:' + (hasAnthropic ? 'var(--accent)' : 'var(--text3)') + ';">Anthropic</span> → ';
    h += '<span style="color:' + (hasOpenAI ? 'var(--accent)' : 'var(--text3)') + ';">OpenAI</span> → ';
    h += '<span style="color:' + (hasWorkersAI ? '#f59e0b' : 'var(--text3)') + ';">Workers AI</span>';
    h += '</div></div>';

    if (!hasAnthropic && !hasOpenAI && hasWorkersAI) {
      h += '<div style="padding:10px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font-size:0.78rem;color:#f59e0b;line-height:1.5;">';
      h += '<strong>⚠️ Running on Workers AI (Free Tier) — Limitations:</strong><br>';
      h += '• <strong>Max ~4,000 output tokens</strong> — acquisition reports may be truncated or missing sections<br>';
      h += '• <strong>Smaller model</strong> (Llama 3.1 70B) — less accurate financial projections and market analysis<br>';
      h += '• <strong>JSON formatting issues</strong> — may produce unparseable responses more often<br>';
      h += '• <strong>No web knowledge after training cutoff</strong> — regulations and market data less reliable<br>';
      h += '• <strong>Rate limited</strong> — may fail under heavy use<br>';
      h += '<br>💡 <strong>For best results:</strong> Add an <strong>Anthropic</strong> or <strong>OpenAI</strong> API key. Claude Sonnet produces significantly better acquisition analyses with accurate financials and detailed recommendations.';
      h += '</div>';
    } else if (hasAnthropic) {
      h += '<div style="font-size:0.72rem;color:var(--accent);">✅ Best AI quality — Claude Sonnet 4 produces detailed reports with accurate analysis.</div>';
    } else if (hasOpenAI) {
      h += '<div style="font-size:0.72rem;color:var(--accent);">✅ Good AI quality — GPT-4o-mini for analysis. Anthropic Claude recommended for best results.</div>';
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
        var srcBadge = src === 'env' ? '<span style="font-size:0.62rem;background:rgba(167,139,250,0.15);color:var(--purple);padding:1px 6px;border-radius:3px;">ENV</span>' : '<span style="font-size:0.62rem;background:rgba(16,185,129,0.15);color:var(--accent);padding:1px 6px;border-radius:3px;">SAVED</span>';
        h += srcBadge + ' ';
        h += '<button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);font-size:0.68rem;padding:1px 6px;" onclick="removeApiKey(\'' + k + '\')">Remove</button>';
      } else {
        h += '<a href="' + info.url + '" target="_blank" style="font-size:0.68rem;color:var(--purple);">' + info.note + ' →</a>';
      }
      h += '</div>';
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
        if (s.over_limit) h += '<div style="font-size:0.68rem;color:var(--danger);margin-top:2px;">⚠ Over free tier — est. $' + (s.cost_cents / 100).toFixed(2) + ' overage</div>';
        else if (s.remaining !== null) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">' + s.remaining + ' free calls remaining</div>';
      } else if (s.cost_cents > 0) {
        h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">Est. cost: $' + (s.cost_cents / 100).toFixed(2) + '</div>';
      }
      // Per-endpoint breakdown
      if (s.by_endpoint && s.by_endpoint.length > 0) {
        h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">';
        s.by_endpoint.forEach(function(e) {
          h += '<span style="font-size:0.62rem;padding:1px 5px;background:var(--surface);border:1px solid var(--border);border-radius:3px;color:var(--text3);">' + esc(e.endpoint) + ' ×' + e.calls + '</span>';
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

// Market city management
function loadMarketCities() {
  try { marketCities = JSON.parse(localStorage.getItem('pmr_market_cities') || '[]'); } catch { marketCities = []; }
  // Also add cities from properties
  properties.forEach(function(p) {
    if (p.city && p.state) {
      var key = p.city + ',' + p.state;
      if (!marketCities.some(function(c) { return c.city + ',' + c.state === key; })) {
        marketCities.push({ city: p.city, state: p.state });
      }
    }
  });
  renderMarketCities();
}

function renderMarketCities() {
  var el = document.getElementById('marketCities');
  if (!el) return;
  el.innerHTML = marketCities.map(function(c, i) {
    return '<span style="display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:16px;font-size:0.78rem;color:var(--text2);">' + esc(c.city) + ', ' + esc(c.state) + ' <span onclick="removeMarketCity(' + i + ')" style="cursor:pointer;color:var(--text3);font-size:0.9em;">✕</span></span>';
  }).join('');
}

function addMarketCity() {
  var city = (document.getElementById('addCityInput') || {}).value.trim();
  var state = (document.getElementById('addStateInput') || {}).value.trim().toUpperCase();
  if (!city || !state) { toast('Enter city and state', 'error'); return; }
  if (marketCities.some(function(c) { return c.city.toLowerCase() === city.toLowerCase() && c.state === state; })) { toast('City already added'); return; }
  marketCities.push({ city: city, state: state });
  localStorage.setItem('pmr_market_cities', JSON.stringify(marketCities));
  document.getElementById('addCityInput').value = '';
  document.getElementById('addStateInput').value = '';
  renderMarketCities();
}

function removeMarketCity(idx) {
  marketCities.splice(idx, 1);
  localStorage.setItem('pmr_market_cities', JSON.stringify(marketCities));
  renderMarketCities();
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
    var date = (ins.created_at || '').substring(0, 16).replace('T', ' ');
    h += '<div style="margin-bottom:12px;padding:14px;background:var(--purple-dim);border:1px solid rgba(167,139,250,0.2);border-radius:8px;">';
    h += '<div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span style="color:var(--purple);font-weight:600;font-size:0.82rem;">✦ AI Analysis</span><span style="color:var(--text3);font-size:0.75rem;">' + date + '</span></div>';
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

