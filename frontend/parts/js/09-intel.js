// Intel / Data Dump
let intelCrawlType = 'str';

async function loadIntelDashboard() {
  loadIntelStats();
  loadIntelUploads();
  loadIntelListings();
  loadCrawlJobs();
}

async function loadIntelStats() {
  try {
    var d = await api('/api/intel/listings/stats');
    var h = '';
    h += '<div class="market-stat"><div class="val">' + (d.total || 0).toLocaleString() + '</div><div class="lbl">Total Listings</div></div>';
    h += '<div class="market-stat"><div class="val">' + (d.recent_7d || 0) + '</div><div class="lbl">Updated (7d)</div></div>';
    var platforms = (d.by_platform || []).map(function(p) { return p.platform + ' (' + p.c + ')'; }).join(' · ');
    if (platforms) h += '<div class="market-stat"><div class="val" style="font-size:0.82rem;">' + esc(platforms) + '</div><div class="lbl">Platforms</div></div>';
    var cities = (d.by_city || []).slice(0, 5).map(function(c) { return c.city + ' (' + c.c + ')'; }).join(' · ');
    if (cities) h += '<div class="market-stat"><div class="val" style="font-size:0.82rem;">' + esc(cities) + '</div><div class="lbl">Top Markets</div></div>';
    document.getElementById('intelStats').innerHTML = h;
  } catch {}
}

async function handleIntelUpload() {
  var input = document.getElementById('intelFileInput');
  var files = input.files;
  if (!files || files.length === 0) return;
  var statusEl = document.getElementById('intelUploadStatus');
  statusEl.style.display = '';
  statusEl.innerHTML = '';

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    statusEl.innerHTML += '<div style="color:var(--text3);">Uploading ' + esc(f.name) + '...</div>';
    try {
      var formData = new FormData();
      formData.append('file', f);
      var resp = await fetch('/api/intel/upload', {
        method: 'POST', body: formData,
        headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {}
      });
      var d = await resp.json();
      if (d.error) {
        statusEl.innerHTML += '<div style="color:var(--danger);">✗ ' + esc(f.name) + ': ' + esc(d.error) + '</div>';
      } else {
        var color = d.listings_extracted > 0 ? 'var(--accent)' : 'var(--text2)';
        statusEl.innerHTML += '<div style="color:' + color + ';">✓ ' + esc(f.name) + ' — ' + (d.listings_extracted || 0) + ' listings extracted' + (d.ai_summary ? ' · ' + esc(d.ai_summary).substring(0, 150) : '') + '</div>';
      }
    } catch (err) {
      statusEl.innerHTML += '<div style="color:var(--danger);">✗ ' + esc(f.name) + ': ' + esc(err.message) + '</div>';
    }
  }
  input.value = '';
  toast('Upload complete');
  loadIntelStats();
  loadIntelUploads();
  loadIntelListings();
}

async function importIntelUrls() {
  var textarea = document.getElementById('intelUrlList');
  var raw = (textarea ? textarea.value : '').trim();
  if (!raw) { toast('Paste some URLs first', 'error'); return; }
  var urls = raw.split('\n').map(function(u) { return u.trim(); }).filter(function(u) { return u && u.startsWith('http'); });
  if (urls.length === 0) { toast('No valid URLs found', 'error'); return; }

  var statusEl = document.getElementById('intelUrlStatus');
  statusEl.textContent = 'Importing ' + urls.length + ' URLs...';
  showLoading('Processing URLs...');

  try {
    var d = await api('/api/intel/import-urls', 'POST', { urls: urls });
    statusEl.innerHTML = '<span style="color:var(--accent);">✓ ' + esc(d.message || 'Done') + '</span>';
    toast(d.message || 'URLs imported');
    textarea.value = '';
    loadIntelStats();
    loadIntelListings();
    loadCrawlJobs();
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  hideLoading();
}

function setCrawlType(type) {
  intelCrawlType = type;
  document.getElementById('crawlStrBtn').classList.toggle('active', type === 'str');
  document.getElementById('crawlLtrBtn').classList.toggle('active', type === 'ltr');
}

async function triggerIntelCrawl() {
  var city = (document.getElementById('intelCrawlCity').value || '').trim();
  var state = (document.getElementById('intelCrawlState').value || '').trim().toUpperCase();
  if (!city || !state) { toast('Enter city and state', 'error'); return; }
  var statusEl = document.getElementById('intelCrawlStatus');
  statusEl.textContent = 'Crawling ' + city + ', ' + state + '...';
  showLoading('Crawling ' + city + '...');
  try {
    var d = await api('/api/intel/crawl', 'POST', { city: city, state: state, listing_type: intelCrawlType });
    statusEl.innerHTML = '<span style="color:var(--accent);">✓ ' + esc(d.message || 'Done') + '</span>';
    toast(d.message || 'Crawl complete');
    loadIntelStats();
    loadIntelListings();
    loadCrawlJobs();
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  hideLoading();
}

async function loadIntelUploads() {
  try {
    var d = await api('/api/intel/uploads');
    var uploads = d.uploads || [];
    if (uploads.length === 0) { document.getElementById('intelUploadsList').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No uploads yet. Drop a file above to get started.</p>'; return; }
    var h = '<table class="comp-table"><thead><tr><th>File</th><th>Type</th><th>Listings</th><th>Status</th><th>When</th></tr></thead><tbody>';
    uploads.forEach(function(u) {
      var statusColor = u.status === 'complete' ? 'var(--accent)' : u.status === 'failed' ? 'var(--danger)' : 'var(--text3)';
      h += '<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.filename || '—') + '</td>';
      h += '<td>' + esc(u.upload_type) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (u.listings_extracted || 0) + '</td>';
      h += '<td style="color:' + statusColor + ';">' + esc(u.status) + '</td>';
      h += '<td style="font-size:0.75rem;color:var(--text3);">' + (u.uploaded_at || '').substring(0, 16) + '</td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('intelUploadsList').innerHTML = h;
  } catch {}
}

async function loadIntelListings() {
  try {
    var params = [];
    var city = (document.getElementById('intelFilterCity') || {}).value;
    var state = (document.getElementById('intelFilterState') || {}).value;
    var platform = (document.getElementById('intelFilterPlatform') || {}).value;
    var type = (document.getElementById('intelFilterType') || {}).value;
    if (city) params.push('city=' + encodeURIComponent(city));
    if (state) params.push('state=' + encodeURIComponent(state.toUpperCase()));
    if (platform) params.push('platform=' + encodeURIComponent(platform));
    if (type) params.push('type=' + encodeURIComponent(type));
    var d = await api('/api/intel/listings' + (params.length ? '?' + params.join('&') : ''));
    var listings = d.listings || [];
    if (listings.length === 0) { document.getElementById('intelListingsTable').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No listings in database. Upload data, import URLs, or run a crawl.</p>'; return; }
    var h = '<div style="font-size:0.78rem;color:var(--text3);margin-bottom:6px;">' + d.count + ' listings shown (max 100)</div>';
    h += '<table class="comp-table"><thead><tr><th>Listing</th><th>Platform</th><th>City</th><th>BR</th><th>Rate</th><th>Rating</th><th>Updated</th></tr></thead><tbody>';
    listings.forEach(function(l) {
      var rate = l.nightly_rate ? '$' + Math.round(l.nightly_rate) + '/nt' : l.monthly_rate ? '$' + Math.round(l.monthly_rate) + '/mo' : '—';
      var ratingStr = l.rating ? l.rating.toFixed(1) + '★' + (l.review_count ? '(' + l.review_count + ')' : '') : '—';
      var platformIcon = { airbnb: _ico('home',15), vrbo: _ico('home',15), booking: _ico('globe',15), rentcast: '' + _ico('key', 13) + '', zillow: '' + _ico('home', 13) + '', manual: '✏️', csv_import: '' + _ico('barChart', 13) + '' }[l.platform] || '' + _ico('clipboard', 13) + '';
      var titleDisplay = l.listing_url ? '<a href="' + esc(l.listing_url) + '" target="_blank" style="color:var(--accent);">' + esc((l.title || 'Listing').substring(0, 40)) + '</a>' : esc((l.title || 'Listing').substring(0, 40));
      h += '<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + titleDisplay + '</td>';
      h += '<td>' + platformIcon + ' ' + esc(l.platform) + '</td>';
      h += '<td>' + esc((l.city || '') + (l.state ? ', ' + l.state : '')) + '</td>';
      h += '<td>' + (l.bedrooms || '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">' + rate + '</td>';
      h += '<td>' + ratingStr + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">' + (l.last_updated || '').substring(0, 10) + '</td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('intelListingsTable').innerHTML = h;
  } catch {}
}

async function loadCrawlJobs() {
  try {
    var d = await api('/api/intel/crawl-jobs');
    var jobs = d.jobs || [];
    if (jobs.length === 0) { document.getElementById('intelCrawlJobs').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No crawl jobs yet.</p>'; return; }
    var h = '<table class="comp-table"><thead><tr><th>Type</th><th>Target</th><th>Found</th><th>New</th><th>Status</th><th>Started</th><th>Duration</th><th></th></tr></thead><tbody>';
    jobs.slice(0, 30).forEach(function(j) {
      var statusColor = j.status === 'complete' ? 'var(--accent)' : j.status === 'failed' ? 'var(--danger)' : j.status === 'running' ? 'var(--purple)' : 'var(--text3)';
      var statusIcon = j.status === 'complete' ? '✓' : j.status === 'failed' ? '✗' : j.status === 'running' ? '⟳' : '' + _ico('clock', 13) + '';
      var target = j.target_city ? j.target_city + ', ' + j.target_state : j.target_url ? j.target_url.substring(0, 50) : '—';
      var platform = j.target_platform ? ' <span style="font-size:0.7rem;background:var(--surface2);padding:1px 5px;border-radius:3px;">' + esc(j.target_platform) + '</span>' : '';
      // Duration
      var duration = '—';
      if (j.duration_seconds !== null && j.duration_seconds !== undefined) {
        if (j.duration_seconds < 60) duration = j.duration_seconds + 's';
        else if (j.duration_seconds < 3600) duration = Math.floor(j.duration_seconds / 60) + 'm ' + (j.duration_seconds % 60) + 's';
        else duration = Math.floor(j.duration_seconds / 3600) + 'h ' + Math.floor((j.duration_seconds % 3600) / 60) + 'm';
      } else if (j.status === 'running' && j.started_at) {
        var elapsed = Math.round((Date.now() - new Date(j.started_at + 'Z').getTime()) / 1000);
        duration = elapsed + 's (running)';
      }
      // Started timestamp
      var started = j.started_at ? fmtUTC(j.started_at) : fmtUTC(j.created_at);
      // Error tooltip
      var errorTip = j.error_message ? ' title="' + esc(j.error_message) + '"' : '';
      h += '<tr><td>' + esc(j.job_type) + platform + '</td>';
      h += '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(target) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;text-align:center;">' + (j.listings_found || 0) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);text-align:center;">' + (j.listings_new || 0) + '</td>';
      h += '<td style="color:' + statusColor + ';"' + errorTip + '>' + statusIcon + ' ' + esc(j.status) + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">' + esc(started) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;font-size:0.78rem;">' + duration + '</td>';
      h += '<td><button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);padding:2px 6px;" onclick="deleteCrawlJob(' + j.id + ')" title="Delete">✗</button></td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('intelCrawlJobs').innerHTML = h;
  } catch {}
}

async function deleteCrawlJob(id) {
  if (!confirm('Delete this crawl job?')) return;
  try {
    await api('/api/intel/crawl-jobs/' + id, 'DELETE');
    toast('Crawl job deleted');
    loadCrawlJobs();
  } catch (err) { toast(err.message, 'error'); }
}

// Drag and drop support
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function() {
    var zone = document.getElementById('intelDropZone');
    if (!zone) return;
    zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; zone.style.background = 'var(--accent-dim)'; });
    zone.addEventListener('dragleave', function(e) { e.preventDefault(); zone.style.borderColor = 'var(--border)'; zone.style.background = 'var(--bg)'; });
    zone.addEventListener('drop', function(e) {
      e.preventDefault(); zone.style.borderColor = 'var(--border)'; zone.style.background = 'var(--bg)';
      var input = document.getElementById('intelFileInput');
      if (e.dataTransfer.files.length > 0) { input.files = e.dataTransfer.files; handleIntelUpload(); }
    });
  });
}

// ── Intel Sub-Tab Switching ──────────────────────────────────────────────────
var _currentIntelTab = 'data';

function switchIntelTab(tab) {
  _currentIntelTab = tab;
  ['data','guests','markets','channels','monitoring','algo','insights'].forEach(function(t) {
    var el = document.getElementById('intelTab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('#intelSubTabs .tab').forEach(function(btn) {
    var active = btn.dataset.itab === tab;
    btn.classList.toggle('active', active);
    btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    btn.style.color = active ? 'var(--accent)' : 'var(--text3)';
  });
  loadIntelSubTabContent(tab);
}

function loadIntelSubTabContent(tab) {
  tab = tab || _currentIntelTab;
  if (tab === 'guests') loadGuestIntelligence();
  if (tab === 'markets') loadMarketIntelligencePanel();
  if (tab === 'channels') loadChannelIntelligencePanel();
  if (tab === 'monitoring') loadMarketWatchlist();
  if (tab === 'algo') { loadAlgoHealth(); loadAlgoTemplates(); }
  if (tab === 'insights') loadPortfolioInsights();
}

// ── Market Watchlist ──────────────────────────────────────────────────────────
async function loadMarketWatchlist() {
  var el = document.getElementById('watchlistContent');
  if (!el) return;
  try {
    // Fetch watchlist and crawl stats in parallel
    var [d, stats, usage] = await Promise.all([
      api('/api/watchlist'),
      api('/api/intel/listings/stats').catch(function() { return {}; }),
      api('/api/keys/usage').catch(function() { return { usage: {} }; }),
    ]);
    var list = d.watchlist || [];

    var h = '';

    // ── Crawl Intelligence Overview Panel ──
    var saUsage = (usage && usage.usage) ? (usage.usage.searchapi || usage.usage['searchapi'] || {}) : {};
    var saCalls = saUsage.calls || 0;
    var saLimit = saUsage.free_limit || 100;
    var saRemaining = saUsage.remaining !== undefined ? saUsage.remaining : (saLimit - saCalls);

    h += '<div style="margin-bottom:14px;padding:12px 14px;background:linear-gradient(135deg, var(--surface2), var(--card));border:1px solid var(--border);border-radius:10px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:10px;">';
    h += '<div style="font-size:0.8rem;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px;">' + _ico('radar', 16, 'var(--accent)') + ' Crawl Intelligence Engine</div>';
    h += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';

    // API budget indicator
    var budgetPct = saLimit > 0 ? Math.round(saCalls / saLimit * 100) : 0;
    var budgetColor = budgetPct >= 80 ? 'var(--danger)' : budgetPct >= 50 ? '#f0b840' : 'var(--accent)';
    h += '<div style="font-size:0.68rem;color:var(--text3);display:flex;align-items:center;gap:6px;">';
    h += _ico('zap', 12, budgetColor) + ' SearchAPI: <strong style="color:' + budgetColor + ';">' + saCalls + '/' + saLimit + '</strong> calls this month';
    h += '<div style="width:50px;height:4px;background:var(--bg);border-radius:2px;"><div style="width:' + Math.min(budgetPct, 100) + '%;height:100%;background:' + budgetColor + ';border-radius:2px;"></div></div>';
    if (budgetPct >= 100) {
      var nextMonth = new Date(); nextMonth.setMonth(nextMonth.getMonth() + 1, 1);
      h += '<span style="color:var(--danger);font-size:0.65rem;font-weight:600;"> Budget exceeded — resets ' + nextMonth.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '. Crawls paused.</span>';
    }
    h += '</div>';

    // Master listings count
    if (stats.total > 0) {
      h += '<span style="font-size:0.68rem;color:var(--text3);">' + _ico('database', 12) + ' ' + stats.total + ' listings tracked' + (stats.recent_7d > 0 ? ' · ' + stats.recent_7d + ' updated 7d' : '') + '</span>';
    }
    h += '</div></div>';

    // What it does - concise explanation
    h += '<div style="font-size:0.72rem;color:var(--text3);line-height:1.55;margin-bottom:8px;">';
    h += 'The crawler searches <strong style="color:var(--text2);">Airbnb via SearchAPI</strong> for active STR listings in your watched markets. ';
    h += 'Each crawl does <strong style="color:var(--text2);">2 targeted searches</strong> per market (1-2BR and 3+BR) capturing nightly rates, ratings, reviews, amenities, photos, and property details. ';
    h += 'This data feeds into <strong style="color:var(--text2);">market profiles</strong>, <strong style="color:var(--text2);">AI pricing analysis</strong>, and <strong style="color:var(--text2);">competitive positioning</strong>.';
    h += '</div>';

    // Schedule
    h += '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.68rem;color:var(--text3);">';
    h += '<span>' + _ico('clock', 11) + ' <strong>Auto:</strong> Daily 6am UTC for due markets</span>';
    h += '<span>' + _ico('target', 11) + ' <strong>Manual:</strong> Click Crawl on any market</span>';
    h += '<span>' + _ico('shield', 11) + ' <strong>Budget guard:</strong> Reserves 20 calls for manual use</span>';
    h += '</div>';

    // Platform breakdown if available
    if (stats.by_platform && stats.by_platform.length > 0) {
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">';
      stats.by_platform.forEach(function(p) {
        h += '<span style="font-size:0.65rem;padding:2px 8px;background:var(--surface3);border-radius:4px;color:var(--text2);">' + esc(p.platform || 'unknown') + ': ' + p.c + '</span>';
      });
      if (stats.by_city && stats.by_city.length > 0) {
        h += '<span style="font-size:0.65rem;padding:2px 8px;background:var(--surface3);border-radius:4px;color:var(--text3);">' + stats.by_city.length + ' markets with data</span>';
      }
      h += '</div>';
    }

    h += '</div>';

    if (list.length === 0) {
      h += '<div style="padding:20px;text-align:center;color:var(--text3);font-size:0.85rem;">No markets monitored yet. Click <strong>Auto-Populate</strong> to add markets from your properties, or add manually above.</div>';
      el.innerHTML = h;
      return;
    }
    // Group by tier
    [1, 2, 3].forEach(function(tier) {
      var tierItems = list.filter(function(m) { return m.tier === tier; });
      if (tierItems.length === 0) return;
      var tierLabel = tier === 1 ? '' + _ico('home', 13) + ' Tier 1 — Owned Markets (Bi-weekly)' : tier === 2 ? '' + _ico('search', 13) + ' Tier 2 — Research Markets (Bi-weekly)' : '' + _ico('eye', 13) + ' Tier 3 — Discovery Markets (Monthly)';
      var tierColor = tier === 1 ? '#10b981' : tier === 2 ? '#60a5fa' : '#a78bfa';
      h += '<div style="margin-bottom:16px;">';
      h += '<div style="font-size:0.78rem;font-weight:600;color:' + tierColor + ';margin-bottom:8px;">' + tierLabel + '</div>';
      h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.75rem;"><thead><tr>';
      h += '<th>Market</th><th>Radius</th><th>Properties</th><th>Listings Tracked</th><th>Avg Price</th><th>Trend</th><th>New (30d)</th><th>Last Crawl</th><th>Notes</th><th></th>';
      h += '</tr></thead><tbody>';
      tierItems.forEach(function(m) {
        var trendColor = (m.price_trend || 0) > 0 ? 'var(--accent)' : (m.price_trend || 0) < 0 ? 'var(--danger)' : 'var(--text3)';
        var trendArrow = (m.price_trend || 0) > 0 ? '↑' : (m.price_trend || 0) < 0 ? '↓' : '→';
        h += '<tr>';
        h += '<td style="font-weight:600;">' + esc(m.city) + ', ' + esc(m.state) + (m.auto_created ? ' <span style="font-size:0.6rem;color:var(--text3);">auto</span>' : '') + '</td>';
        h += '<td style="font-size:0.72rem;">' + (m.radius_miles || 25) + ' mi</td>';
        h += '<td>' + (m.owned_properties || 0) + ' owned' + (m.research_properties > 0 ? ' · ' + m.research_properties + ' research' : '') + '</td>';
        h += '<td>' + (m.listing_count || 0).toLocaleString() + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">' + (m.avg_price ? '$' + Math.round(m.avg_price).toLocaleString() : '—') + '</td>';
        h += '<td style="color:' + trendColor + ';font-weight:600;">' + trendArrow + ' ' + (m.price_trend ? (m.price_trend > 0 ? '+' : '') + m.price_trend + '%' : '—') + '</td>';
        h += '<td>' + (m.new_listings_30d || 0) + '</td>';
        h += '<td style="font-size:0.68rem;color:var(--text3);">' + (m.last_crawl ? fmtUTC(m.last_crawl) : 'Never') + '</td>';
        h += '<td style="font-size:0.68rem;color:var(--text3);max-width:120px;overflow:hidden;text-overflow:ellipsis;">' + esc(m.notes || '') + '</td>';
        h += '<td style="white-space:nowrap;"><button class="btn btn-xs" onclick="crawlWatchlistMarket(\'' + esc(m.city) + '\',\'' + esc(m.state) + '\')" title="Trigger an immediate STR crawl for this market">Crawl</button> <button class="btn btn-xs btn-danger" onclick="removeWatchlistMarket(' + m.id + ')" title="Remove from watchlist">✕</button></td>';
        h += '</tr>';
      });
      h += '</tbody></table></div></div>';
    });

    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">' + esc(err.message) + '</span>'; }
}

async function addWatchlistMarket() {
  var city = (document.getElementById('watchCity') || {}).value;
  var state = (document.getElementById('watchState') || {}).value;
  var tier = parseInt((document.getElementById('watchTier') || {}).value) || 3;
  var radius = parseInt((document.getElementById('watchRadius') || {}).value) || 25;
  var notes = (document.getElementById('watchNotes') || {}).value;
  if (!city || !state) { toast('City and state required', 'error'); return; }
  try {
    var d = await api('/api/watchlist', 'POST', { city: city, state: state.toUpperCase(), tier: tier, radius_miles: radius, notes: notes });
    toast(d.message || 'Added');
    document.getElementById('watchCity').value = '';
    document.getElementById('watchState').value = '';
    document.getElementById('watchNotes').value = '';
    loadMarketWatchlist();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function removeWatchlistMarket(id) {
  if (!confirm('Remove this market from the watchlist?')) return;
  try {
    await api('/api/watchlist/' + id, 'DELETE');
    toast('Removed');
    loadMarketWatchlist();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function autoPopulateWatchlist() {
  showLoading('Auto-populating watchlist from your properties...');
  try {
    var d = await api('/api/watchlist/auto-populate', 'POST');
    toast(d.message || 'Done');
    loadMarketWatchlist();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
  hideLoading();
}

async function crawlWatchlistMarket(city, state) {
  toast('Crawling ' + city + ', ' + state + '...');
  showLoading('Crawling ' + city + ', ' + state + '...');
  try {
    var d = await api('/api/intel/crawl', 'POST', { city: city, state: state, listing_type: 'str' });
    toast(d.message || 'Crawl complete');
    loadMarketWatchlist();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
  hideLoading();
}

// ── Property Calendar View ───────────────────────────────────────────────────
var _calendarMonth = null; // current month offset
var _calendarPropertyId = null;
var _calendarData = null;

function loadPropertyCalendar(propertyId) {
  _calendarPropertyId = propertyId;
  if (_calendarMonth === null) _calendarMonth = 0;
  fetchCalendarMonth();
}

function calendarNav(dir) {
  _calendarMonth += dir;
  fetchCalendarMonth();
}

async function fetchCalendarMonth() {
  var grid = document.getElementById('calendarGrid');
  var sources = document.getElementById('calendarSources');
  var summary = document.getElementById('calendarSummary');
  var label = document.getElementById('calendarMonthLabel');
  if (!grid) return;
  grid.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;padding:16px;">Loading calendar...</div>';

  var now = new Date();
  var targetMonth = new Date(now.getFullYear(), now.getMonth() + _calendarMonth, 1);
  var from = targetMonth.toISOString().split('T')[0];
  var lastDay = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0);
  var to = lastDay.toISOString().split('T')[0];
  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  if (label) label.textContent = monthNames[targetMonth.getMonth()] + ' ' + targetMonth.getFullYear();

  try {
    var d = await api('/api/properties/' + _calendarPropertyId + '/calendar?from=' + from + '&to=' + to);
    _calendarData = d;

    // Source indicators
    if (sources) {
      var sh = '';
      sh += '<span style="padding:2px 8px;border-radius:4px;background:' + (d.has_guesty ? 'rgba(96,165,250,0.15);color:#60a5fa' : 'var(--surface2);color:var(--text3)') + ';">Guesty ' + (d.has_guesty ? '✓' : '✗') + '</span>';
      sh += '<span style="padding:2px 8px;border-radius:4px;background:' + (d.has_pricelabs ? 'rgba(167,139,250,0.15);color:#a78bfa' : 'var(--surface2);color:var(--text3)') + ';">PriceLabs ' + (d.has_pricelabs ? '✓' : '✗') + '</span>';
      sh += '<span style="padding:2px 8px;border-radius:4px;background:' + (d.has_strategy ? 'rgba(251,191,36,0.15);color:#fbbf24' : 'var(--surface2);color:var(--text3)') + ';">Strategy ' + (d.has_strategy ? '✓' : '✗') + (d.strategy ? ' (' + esc(d.strategy.name) + ')' : '') + '</span>';
      sources.innerHTML = sh;
    }

    renderCalendarGrid(d.calendar, targetMonth);
    renderCalendarSummary(d);
  } catch (err) {
    grid.innerHTML = '<div style="color:var(--danger);font-size:0.82rem;">' + esc(err.message) + '</div>';
  }
}

function renderCalendarGrid(days, targetMonth) {
  var grid = document.getElementById('calendarGrid');
  if (!grid || !days) return;
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  var h = '<table style="width:100%;border-collapse:collapse;font-size:0.72rem;table-layout:fixed;">';
  // Header
  h += '<thead><tr>';
  dayNames.forEach(function(d) { h += '<th style="padding:6px 2px;text-align:center;color:var(--text3);font-weight:600;border-bottom:2px solid var(--border);">' + d + '</th>'; });
  h += '</tr></thead><tbody>';

  // Build day map
  var dayMap = {};
  days.forEach(function(d) { dayMap[d.date] = d; });

  // Start from first day of month
  var firstDow = targetMonth.getDay();
  var lastDate = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).getDate();
  // Empty cells before first day
  for (var i = 0; i < firstDow; i++) h += '<td style="padding:2px;border:1px solid var(--border);background:var(--bg);"></td>';
  var cellCount = firstDow;

  for (var day = 1; day <= lastDate; day++) {
    var dateStr = targetMonth.getFullYear() + '-' + String(targetMonth.getMonth() + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    var dd = dayMap[dateStr] || {};

    // Background color based on status
    var bgColor = 'var(--card)';
    var borderLeft = '';
    if (dd.status === 'booked') { bgColor = 'rgba(16,185,129,0.08)'; borderLeft = 'border-left:3px solid #10b981;'; }
    else if (dd.status === 'blocked') { bgColor = 'rgba(239,68,68,0.08)'; borderLeft = 'border-left:3px solid #ef4444;'; }
    else if (dd.is_weekend) { bgColor = 'rgba(251,191,36,0.04)'; }

    // Discrepancy dot
    var dot = '';
    if (dd.discrepancy_level === 'aligned') dot = '<span style="color:#10b981;font-size:0.65rem;">●</span>';
    else if (dd.discrepancy_level === 'minor') dot = '<span style="color:#f59e0b;font-size:0.65rem;">●</span>';
    else if (dd.discrepancy_level === 'major') dot = '<span style="color:#ef4444;font-size:0.65rem;">●</span>';

    h += '<td style="padding:3px 4px;border:1px solid var(--border);background:' + bgColor + ';vertical-align:top;min-height:70px;height:70px;' + borderLeft + '">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">';
    h += '<span style="font-weight:600;color:var(--text);">' + day + '</span>' + dot;
    h += '</div>';

    // Price rows
    if (dd.guesty_price) h += '<div style="color:#60a5fa;font-family:DM Mono,monospace;font-size:0.68rem;" title="Guesty live price">G $' + Math.round(dd.guesty_price) + '</div>';
    if (dd.pl_price) h += '<div style="color:#a78bfa;font-family:DM Mono,monospace;font-size:0.68rem;" title="PriceLabs recommended">P $' + Math.round(dd.pl_price) + '</div>';
    if (dd.strategy_price && !dd.guesty_price) h += '<div style="color:#fbbf24;font-family:DM Mono,monospace;font-size:0.68rem;" title="Strategy projected">S $' + dd.strategy_price + '</div>';

    // Booking info with segment badge
    if (dd.booking) {
      h += '<div style="font-size:0.58rem;color:#10b981;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(dd.booking.platform || '') + '">' + esc(dd.booking.platform || 'booked') + '</div>';
      if (dd.booking.segment) {
        var segColors = {vacation_str:'#10b981',weekend_getaway:'#60a5fa',corporate:'#a78bfa',travel_nurse:'#f472b6',insurance:'#fb923c',relocation:'#fbbf24',long_term:'#818cf8',midterm_family:'#38bdf8',extended_vacation:'#6ee7b7',short_vacation:'#34d399'};
        h += '<div style="font-size:0.5rem;color:' + (segColors[dd.booking.segment] || 'var(--text3)') + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (dd.booking.segment || '').replace(/_/g,' ') + '</div>';
      }
    }

    // Blocked date label
    if (dd.status === 'blocked') {
      h += '<div style="font-size:0.58rem;color:#ef4444;">blocked</div>';
    }

    // Discrepancy
    if (dd.discrepancy && dd.discrepancy_level !== 'aligned' && dd.discrepancy_level !== 'none') {
      var dColor = dd.discrepancy_level === 'minor' ? '#f59e0b' : '#ef4444';
      h += '<div style="font-size:0.58rem;color:' + dColor + ';font-family:DM Mono,monospace;">' + (dd.discrepancy > 0 ? '+' : '') + dd.discrepancy + '</div>';
    }

    h += '</td>';
    cellCount++;
    if (cellCount % 7 === 0) { h += '</tr><tr>'; }
  }
  // Fill remaining cells
  while (cellCount % 7 !== 0) { h += '<td style="padding:2px;border:1px solid var(--border);background:var(--bg);"></td>'; cellCount++; }
  h += '</tr></tbody></table>';
  grid.innerHTML = h;
}

function renderCalendarSummary(d) {
  var el = document.getElementById('calendarSummary');
  if (!el || !d.calendar) return;
  var cal = d.calendar;
  var booked = cal.filter(function(c) { return c.status === 'booked'; }).length;
  var blocked = cal.filter(function(c) { return c.status === 'blocked'; }).length;
  var available = cal.filter(function(c) { return c.status === 'available'; }).length;
  var total = cal.length;
  var occ = (total - blocked) > 0 ? Math.round(booked / (total - blocked) * 100) : 0;

  var gPrices = cal.filter(function(c) { return c.guesty_price > 0; }).map(function(c) { return c.guesty_price; });
  var pPrices = cal.filter(function(c) { return c.pl_price > 0; }).map(function(c) { return c.pl_price; });
  var aligned = cal.filter(function(c) { return c.discrepancy_level === 'aligned'; }).length;
  var minor = cal.filter(function(c) { return c.discrepancy_level === 'minor'; }).length;
  var major = cal.filter(function(c) { return c.discrepancy_level === 'major'; }).length;

  var avgG = gPrices.length > 0 ? Math.round(gPrices.reduce(function(a, b) { return a + b; }, 0) / gPrices.length) : 0;
  var avgP = pPrices.length > 0 ? Math.round(pPrices.reduce(function(a, b) { return a + b; }, 0) / pPrices.length) : 0;

  var h = '<div class="market-grid">';
  h += '<div class="market-stat"><div class="val" style="color:#10b981;">' + occ + '%</div><div class="lbl">Occupancy</div></div>';
  h += '<div class="market-stat"><div class="val" style="color:#10b981;">' + booked + '</div><div class="lbl">Booked Nights</div></div>';
  h += '<div class="market-stat"><div class="val">' + available + '</div><div class="lbl">Available</div></div>';
  if (blocked > 0) h += '<div class="market-stat"><div class="val" style="color:var(--danger);">' + blocked + '</div><div class="lbl">Blocked</div></div>';
  if (avgG > 0) h += '<div class="market-stat"><div class="val" style="color:#60a5fa;">$' + avgG + '</div><div class="lbl">Avg Guesty Rate</div></div>';
  if (avgP > 0) h += '<div class="market-stat"><div class="val" style="color:#a78bfa;">$' + avgP + '</div><div class="lbl">Avg PL Rate</div></div>';
  if (aligned + minor + major > 0) {
    h += '<div class="market-stat"><div class="val"><span style="color:#10b981;">' + aligned + '</span> / <span style="color:#f59e0b;">' + minor + '</span> / <span style="color:#ef4444;">' + major + '</span></div><div class="lbl">Aligned / Minor / Major</div></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

// ── Portfolio Insights Tab ────────────────────────────────────────────────

async function loadPortfolioInsights() {
  var el = document.getElementById('insightsContent');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;">Loading insights...</div>';

  try {
    var d = await api('/api/intelligence/insights');
    var metrics = d.metrics || [];
    var propRevpan = d.property_revpan || [];

    if (metrics.length === 0) {
      el.innerHTML = '<div style="padding:16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;text-align:center;">' +
        '<div style="font-size:0.88rem;color:var(--text2);margin-bottom:6px;">No insights data yet</div>' +
        '<div style="font-size:0.78rem;color:var(--text3);margin-bottom:10px;">Run an intelligence rebuild to generate advanced analytics from your Guesty + PriceLabs data.</div>' +
        '<button class="btn btn-primary btn-sm" onclick="btnGuard(this);api(\'/api/intelligence/rebuild\',\'POST\',{sections:[\'guests\',\'channels\',\'advanced\']}).then(function(){toast(\'Rebuild complete\');loadPortfolioInsights()}).catch(function(e){toast(e.message,\'error\')})">Rebuild Intelligence</button></div>';
      return;
    }

    // Parse metrics into a lookup
    var m = {};
    metrics.forEach(function(r) {
      var key = r.metric_key + (r.period !== 'all_time' ? '_' + r.period : '');
      m[key] = { v: r.metric_value, n: r.sample_size };
    });

    var h = '';

    // ── RevPAN Section ──
    if (m.revpan) {
      h += '<div style="margin-bottom:18px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('target', 14, 'var(--text3)') + ' REVENUE EFFICIENCY — RevPAN</div>';
      h += '<div class="market-grid">';
      h += '<div class="market-stat"><div class="val" style="color:var(--accent);">$' + m.revpan.v.toFixed(2) + '</div><div class="lbl">Portfolio RevPAN</div></div>';
      if (m.portfolio_adr) h += '<div class="market-stat"><div class="val">$' + Math.round(m.portfolio_adr.v) + '</div><div class="lbl">Portfolio ADR</div></div>';
      if (m.portfolio_occ) h += '<div class="market-stat"><div class="val">' + m.portfolio_occ.v + '%</div><div class="lbl">Portfolio Occupancy</div></div>';
      h += '</div>';
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:4px;">RevPAN = Revenue ÷ Available Nights. Combines ADR × occupancy into one number. Higher is better. Hotel industry gold standard.</div>';

      // Per-property RevPAN ranking
      if (propRevpan.length > 0) {
        h += '<div style="margin-top:10px;">';
        h += '<div style="font-size:0.68rem;font-weight:600;color:var(--text2);margin-bottom:4px;">Property RevPAN Ranking</div>';
        var maxRevpan = propRevpan[0].revpan || 1;
        propRevpan.forEach(function(p) {
          var pct = Math.round(p.revpan / maxRevpan * 100);
          var color = pct >= 75 ? 'var(--accent)' : pct >= 50 ? '#f59e0b' : 'var(--danger)';
          h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;font-size:0.75rem;">';
          h += '<span style="min-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text2);" title="' + esc(p.label) + '">' + esc(p.label) + '</span>';
          h += '<div style="flex:1;height:14px;background:var(--surface2);border-radius:3px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:' + color + ';border-radius:3px;transition:width 0.3s;"></div></div>';
          h += '<span style="font-family:DM Mono,monospace;font-weight:600;color:' + color + ';min-width:55px;text-align:right;">$' + p.revpan.toFixed(2) + '</span>';
          h += '<span style="font-size:0.62rem;color:var(--text3);min-width:35px;">' + p.months + 'mo</span>';
          h += '</div>';
        });
        h += '</div>';
      }
      h += '</div>';
    }

    // ── Booking Pace Section ──
    var paceTY = m.pace_bookings_ty_ytd;
    var paceLY = m.pace_bookings_ly_ytd;
    if (paceTY || paceLY) {
      h += '<div style="margin-bottom:18px;">';
      // Check if we have booking_date data or need to fall back to completed stays
      var hasBookingDates = m.pace_has_booking_dates_ytd && m.pace_has_booking_dates_ytd.v > 0;
      var compTY = m.completed_bookings_ty_ytd;
      var compLY = m.completed_bookings_ly_ytd;
      var compRevTY = m.completed_revenue_ty_ytd;
      var compRevLY = m.completed_revenue_ly_ytd;

      // Decide which dataset to show: forward pace (needs booking_date) or completed stays
      var showForwardPace = hasBookingDates && paceTY && paceLY && (paceTY.v > 0 || paceLY.v > 0);
      var showCompleted = compTY || compLY;

      if (showForwardPace) {
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('trendUp', 14, 'var(--text3)') + ' FORWARD BOOKING PACE — Year over Year</div>';
        h += '<div class="market-grid">';
        if (paceTY) h += '<div class="market-stat"><div class="val" style="color:var(--accent);">' + paceTY.v + '</div><div class="lbl">Forward Bookings TY</div></div>';
        if (paceLY) h += '<div class="market-stat"><div class="val">' + paceLY.v + '</div><div class="lbl">Same Date Last Year</div></div>';
        var revTY = m.pace_revenue_ty_ytd;
        var revLY = m.pace_revenue_ly_ytd;
        if (revTY) h += '<div class="market-stat"><div class="val" style="color:var(--accent);">$' + Math.round(revTY.v).toLocaleString() + '</div><div class="lbl">Revenue Booked TY</div></div>';
        if (revLY) h += '<div class="market-stat"><div class="val">$' + Math.round(revLY.v).toLocaleString() + '</div><div class="lbl">Revenue Booked LY</div></div>';
        var paceChg = m.pace_change_pct_ytd;
        if (paceChg) {
          var pColor = paceChg.v >= 0 ? 'var(--accent)' : 'var(--danger)';
          h += '<div class="market-stat"><div class="val" style="color:' + pColor + ';">' + (paceChg.v >= 0 ? '+' : '') + paceChg.v + '%</div><div class="lbl">Pace Change</div></div>';
        }
        h += '</div>';
        if (paceLY && paceLY.v === 0 && paceTY && paceTY.v > 0) {
          h += '<div style="padding:6px 10px;background:var(--surface2);border-radius:6px;font-size:0.72rem;color:var(--text3);margin-top:4px;">' + _ico('info', 11, 'var(--text3)') + ' Last year shows 0 — booking_date data may be missing for older reservations (CSV imports). See completed stays below for a fuller comparison.</div>';
        } else {
          h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:4px;">Forward bookings as of today vs same calendar date last year. Requires booking_date field.</div>';
        }
      } else {
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('trendUp', 14, 'var(--text3)') + ' BOOKING PACE — Year over Year</div>';
      }

      // Always show completed stays comparison (doesn't need booking_date)
      if (showCompleted) {
        if (showForwardPace) h += '<div style="margin-top:12px;">';
        h += '<div style="font-size:0.68rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px;">' + _ico('calendar', 12, 'var(--text3)') + ' COMPLETED STAYS — YTD vs Same Period Last Year</div>';
        h += '<div class="market-grid">';
        if (compTY) h += '<div class="market-stat"><div class="val" style="color:var(--accent);">' + compTY.v + '</div><div class="lbl">Stays YTD ' + new Date().getFullYear() + '</div></div>';
        if (compLY) h += '<div class="market-stat"><div class="val">' + compLY.v + '</div><div class="lbl">Same Period ' + (new Date().getFullYear() - 1) + '</div></div>';
        if (compRevTY) h += '<div class="market-stat"><div class="val" style="color:var(--accent);">$' + Math.round(compRevTY.v).toLocaleString() + '</div><div class="lbl">Revenue YTD ' + new Date().getFullYear() + '</div></div>';
        if (compRevLY) h += '<div class="market-stat"><div class="val">$' + Math.round(compRevLY.v).toLocaleString() + '</div><div class="lbl">Revenue Same Period LY</div></div>';
        if (compTY && compLY && compLY.v > 0) {
          var compChg = Math.round((compTY.v - compLY.v) / compLY.v * 100);
          var compColor = compChg >= 0 ? 'var(--accent)' : 'var(--danger)';
          h += '<div class="market-stat"><div class="val" style="color:' + compColor + ';">' + (compChg >= 0 ? '+' : '') + compChg + '%</div><div class="lbl">YoY Change</div></div>';
        }
        h += '</div>';
        h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:4px;">Actual check-ins Jan 1 through today, compared to same window last year. Does not require booking_date.</div>';
        if (showForwardPace) h += '</div>';
      }
      h += '</div>';
    }

    // ── Day-of-Week Patterns ──
    var dowDays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var hasDow = dowDays.some(function(d) { return m['dow_revenue_' + d]; });
    if (hasDow) {
      h += '<div style="margin-bottom:18px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('calendar', 14, 'var(--text3)') + ' CHECK-IN DAY PATTERNS</div>';
      var maxDowRev = 0;
      dowDays.forEach(function(d) { var v = m['dow_revenue_' + d]; if (v && v.v > maxDowRev) maxDowRev = v.v; });
      h += '<div style="display:flex;gap:6px;align-items:flex-end;height:120px;">';
      dowDays.forEach(function(d) {
        var v = m['dow_revenue_' + d];
        if (!v) return;
        var pct = maxDowRev > 0 ? Math.round(v.v / maxDowRev * 100) : 0;
        var isWeekend = d === 'Fri' || d === 'Sat';
        var barColor = isWeekend ? 'var(--accent)' : 'var(--purple)';
        h += '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;">';
        h += '<span style="font-size:0.58rem;font-family:DM Mono,monospace;color:var(--text2);">$' + Math.round(v.v) + '</span>';
        h += '<div style="width:100%;height:' + Math.max(pct, 5) + '%;background:' + barColor + ';border-radius:3px 3px 0 0;min-height:4px;opacity:0.8;"></div>';
        h += '<span style="font-size:0.62rem;color:var(--text3);font-weight:600;">' + d + '</span>';
        h += '<span style="font-size:0.55rem;color:var(--text3);">' + v.n + '</span>';
        h += '</div>';
      });
      h += '</div>';
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">Average revenue per booking by check-in day. Weekend check-ins often show lower avg revenue because stays are shorter (1-2 nights). Weekday check-ins average higher because they include longer corporate/mid-term stays.</div>';
      h += '</div>';
    }

    // ── Lead Time Trends ──
    var ltCurr = m.lead_time_avg_current_q;
    var ltPrev = m.lead_time_avg_prev_q;
    if (ltCurr || ltPrev) {
      h += '<div style="margin-bottom:18px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('clock', 14, 'var(--text3)') + ' BOOKING LEAD TIME</div>';
      h += '<div class="market-grid">';
      if (ltCurr) {
        h += '<div class="market-stat"><div class="val">' + Math.round(ltCurr.v) + ' days</div><div class="lbl">Current Quarter Avg' + (ltCurr.n ? ' (' + ltCurr.n + ' bookings)' : '') + '</div></div>';
        var lmPct = m.lead_time_pct_last_minute_current_q;
        if (lmPct) h += '<div class="market-stat"><div class="val" style="color:' + (lmPct.v > 30 ? 'var(--danger)' : 'var(--text)') + ';">' + Math.round(lmPct.v) + '%</div><div class="lbl">Last-Minute (&lt;7d)</div></div>';
        var advPct = m.lead_time_pct_advance_current_q;
        if (advPct) h += '<div class="market-stat"><div class="val">' + Math.round(advPct.v) + '%</div><div class="lbl">Advance (30d+)</div></div>';
      }
      if (ltPrev) h += '<div class="market-stat"><div class="val">' + Math.round(ltPrev.v) + ' days</div><div class="lbl">Previous Quarter Avg' + (ltPrev.n ? ' (' + ltPrev.n + ' bookings)' : '') + '</div></div>';
      h += '</div>';
      if (ltCurr && ltPrev && ltCurr.v < ltPrev.v - 3) {
        h += '<div style="padding:8px 12px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font-size:0.78rem;color:var(--danger);margin-top:6px;">' + _ico('alertTriangle', 13, 'var(--danger)') + ' Lead time shrinking by ' + Math.round(ltPrev.v - ltCurr.v) + ' days — guests booking closer to check-in. Consider reducing far-out discounts.</div>';
      }
      h += '</div>';
    }

    // ── Price Elasticity ──
    var elastUp = m.elasticity_price_up_occ_delta;
    var elastDown = m.elasticity_price_down_occ_delta;
    if (elastUp || elastDown) {
      h += '<div style="margin-bottom:18px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('dollarSign', 14, 'var(--text3)') + ' PRICE ELASTICITY SIGNALS</div>';
      h += '<div class="market-grid">';
      if (elastUp) {
        var upColor = elastUp.v >= -5 ? 'var(--accent)' : 'var(--danger)';
        h += '<div class="market-stat"><div class="val" style="color:' + upColor + ';">' + (elastUp.v >= 0 ? '+' : '') + elastUp.v + '%</div><div class="lbl">Occ After Price ↑ (' + elastUp.n + ')</div></div>';
      }
      if (elastDown) {
        h += '<div class="market-stat"><div class="val" style="color:var(--accent);">' + (elastDown.v >= 0 ? '+' : '') + elastDown.v + '%</div><div class="lbl">Occ After Price ↓ (' + elastDown.n + ')</div></div>';
      }
      h += '</div>';
      var interpretation = '';
      if (elastUp && elastUp.v >= -5) interpretation = 'Your market is price-insensitive — raising rates doesn\'t significantly hurt occupancy. Room to push pricing.';
      else if (elastUp && elastUp.v < -10) interpretation = 'Price-sensitive market — rate increases led to noticeable occupancy drops. Be surgical with increases.';
      if (interpretation) h += '<div style="font-size:0.72rem;color:var(--text2);margin-top:4px;">' + _ico('lightbulb', 12, '#f59e0b') + ' ' + interpretation + '</div>';
      h += '</div>';
    }

    // ── Guest Origins ──
    var originStates = metrics.filter(function(r) { return r.metric_key.indexOf('guest_origin_state_') === 0; }).sort(function(a, b) { return b.sample_size - a.sample_size; }).slice(0, 8);
    var originCountries = metrics.filter(function(r) { return r.metric_key.indexOf('guest_origin_country_') === 0; }).sort(function(a, b) { return b.sample_size - a.sample_size; }).slice(0, 5);
    if (originStates.length > 0) {
      h += '<div style="margin-bottom:18px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('mapPin', 14, 'var(--text3)') + ' GUEST ORIGINS — Top Feeder Markets</div>';
      var maxGuests = originStates[0].sample_size || 1;
      h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">';
      originStates.forEach(function(o) {
        var st = o.metric_key.replace('guest_origin_state_', '');
        var pct = Math.round(o.sample_size / maxGuests * 100);
        h += '<div style="display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--surface2);border-radius:4px;">';
        h += '<span style="font-weight:700;font-size:0.78rem;color:var(--text);min-width:24px;">' + st + '</span>';
        h += '<div style="flex:1;height:10px;background:var(--bg);border-radius:2px;overflow:hidden;"><div style="height:100%;width:' + pct + '%;background:var(--purple);border-radius:2px;"></div></div>';
        h += '<span style="font-size:0.68rem;color:var(--text2);min-width:55px;text-align:right;">' + o.sample_size + ' guests</span>';
        h += '</div>';
      });
      h += '</div>';
      if (originCountries.length > 1) {
        h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">Countries: ' + originCountries.map(function(c) { return c.metric_key.replace('guest_origin_country_', '') + ' (' + c.sample_size + ')'; }).join(' · ') + '</div>';
      }
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:4px;">Target listing descriptions and marketing toward these origin markets.</div>';
      h += '</div>';
    }

    // ── Rate Context — Pricing vs Occupancy ──
    var underpricedCount = m.underpriced_high_occ_count;
    var rateContextProps = metrics.filter(function(r) { return r.metric_key.indexOf('rate_context_prop_') === 0; });
    var underpricedEntries = metrics.filter(function(r) { return r.metric_key.indexOf('underpriced_') === 0 && r.metric_key.indexOf('_pid') > 0; });
    if (rateContextProps.length > 0 || underpricedCount) {
      h += '<div style="margin-bottom:18px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('dollarSign', 14, 'var(--text3)') + ' RATE CONTEXT — Did Pricing Drive Occupancy?</div>';

      // Count by classification
      var underpriced = rateContextProps.filter(function(r) { return r.period === 'underpriced_high_occ'; });
      var possiblyUnder = rateContextProps.filter(function(r) { return r.period === 'possibly_underpriced'; });
      var wellPriced = rateContextProps.filter(function(r) { return r.period === 'well_priced'; });
      var overpriced = rateContextProps.filter(function(r) { return r.period === 'overpriced_low_occ'; });

      h += '<div class="market-grid">';
      if (underpriced.length > 0) h += '<div class="market-stat"><div class="val" style="color:var(--danger);">' + underpriced.length + '</div><div class="lbl">Underpriced + High Occ</div></div>';
      if (possiblyUnder.length > 0) h += '<div class="market-stat"><div class="val" style="color:#f59e0b;">' + possiblyUnder.length + '</div><div class="lbl">Possibly Underpriced</div></div>';
      if (wellPriced.length > 0) h += '<div class="market-stat"><div class="val" style="color:var(--accent);">' + wellPriced.length + '</div><div class="lbl">Well Priced</div></div>';
      if (overpriced.length > 0) h += '<div class="market-stat"><div class="val" style="color:var(--purple);">' + overpriced.length + '</div><div class="lbl">Overpriced + Low Occ</div></div>';
      h += '</div>';

      // Show underpriced property details
      var underpricedAll = underpriced.concat(possiblyUnder);
      if (underpricedAll.length > 0) {
        h += '<div style="margin-top:8px;">';
        h += '<div style="font-size:0.68rem;font-weight:600;color:var(--danger);margin-bottom:4px;">' + _ico('alertTriangle', 12, 'var(--danger)') + ' Properties where high occupancy was driven by below-market pricing:</div>';
        underpricedAll.sort(function(a, b) { return a.metric_value - b.metric_value; }).forEach(function(p) {
          var pid = parseInt(p.metric_key.replace('rate_context_prop_', ''));
          var gap = Math.round(p.metric_value);
          var color = gap < -15 ? 'var(--danger)' : '#f59e0b';
          var propLabel = '';
          // Find property label from RevPAN data or properties
          if (propRevpan.length > 0) {
            var match = propRevpan.find(function(pr) { return pr.property_id === pid; });
            if (match) propLabel = match.label;
          }
          if (!propLabel) propLabel = 'Property #' + pid;
          h += '<div style="display:flex;align-items:center;gap:8px;padding:4px 8px;background:var(--surface2);border-radius:4px;margin-bottom:3px;font-size:0.75rem;cursor:pointer;" onclick="switchView(\'properties\');setTimeout(function(){openPropertyDetail(' + pid + ')},200)">';
          h += '<span style="color:var(--text2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(propLabel) + '</span>';
          h += '<span style="font-family:DM Mono,monospace;font-weight:700;color:' + color + ';">' + gap + '% vs set rate</span>';
          h += '<span style="font-size:0.62rem;color:var(--text3);">(' + p.sample_size + 'mo avg)</span>';
          h += '</div>';
        });
        h += '</div>';
      }

      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">Compares actual ADR (what guests paid) vs the base rate set in PriceLabs. High occupancy at low rates may indicate pricing too aggressively — bookings come in fast but at a revenue loss. Consider raising min prices or reducing PriceLabs last-minute discounts for flagged properties.</div>';
      h += '</div>';
    }

    // ── Cancellation Patterns ──
    var cancelMetrics = metrics.filter(function(r) { return r.metric_key.indexOf('cancel_rate_') === 0; }).sort(function(a, b) { return b.metric_value - a.metric_value; });
    if (cancelMetrics.length > 0) {
      h += '<div style="margin-bottom:18px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;">' + _ico('x', 14, 'var(--text3)') + ' CANCELLATION PATTERNS BY CHANNEL</div>';
      h += '<div class="market-grid">';
      cancelMetrics.forEach(function(cm) {
        var ch = cm.metric_key.replace('cancel_rate_', '').replace(/_/g, ' ');
        var rate = Math.round(cm.metric_value);
        var color = rate > 15 ? 'var(--danger)' : rate > 8 ? '#f59e0b' : 'var(--accent)';
        h += '<div class="market-stat"><div class="val" style="color:' + color + ';">' + rate + '%</div><div class="lbl">' + esc(ch) + ' (' + cm.sample_size + ' cancels)</div></div>';
      });
      h += '</div></div>';
    }

    if (!h) h = '<div style="padding:16px;text-align:center;color:var(--text3);">No advanced intel data found. Run a full intelligence rebuild.</div>';
    el.innerHTML = h;
  } catch (err) {
    el.innerHTML = '<p style="color:var(--danger);">Error: ' + esc(err.message) + '</p>';
  }
}
