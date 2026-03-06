// Amenities
async function loadAmenities() {
  try { const d = await api('/api/amenities'); amenities = d.amenities || []; renderAmenityChips(); } catch { amenities = []; }
}

function renderAmenityChips() {
  const c = document.getElementById('amenityChips'); if (!c) return;
  c.innerHTML = amenities.map(a => {
    const sel = selectedAmenities.has(a.id) ? ' selected' : '';
    return '<div class="chip' + sel + '" onclick="toggleAmenity(' + a.id + ')">' + esc(a.name) + '<span class="score">+' + a.impact_score + '%</span></div>';
  }).join('');
}

function toggleAmenity(id) {
  selectedAmenities.has(id) ? selectedAmenities.delete(id) : selectedAmenities.add(id);
  renderAmenityChips();
}

async function saveSelectedAmenities() {
  const pid = document.getElementById('analyzePropertySelect').value;
  if (!pid) { toast('Select a property first', 'error'); return; }
  try { await api('/api/properties/' + pid + '/amenities', 'POST', { amenity_ids: Array.from(selectedAmenities) }); toast('Amenities saved'); }
  catch (err) { toast(err.message, 'error'); }
}

// Analysis
function toggleAI() {
  aiEnabled = !aiEnabled;
  localStorage.setItem('pmr_ai_enabled', aiEnabled);
  document.getElementById('aiToggle').classList.toggle('active', aiEnabled);
  document.getElementById('aiProviderOptions').style.display = aiEnabled ? 'flex' : 'none';
}

function populateAnalyzeSelects() {
  var sel = document.getElementById('analyzePropertySelect');
  var opts = '<option value="">-- Select a property --</option>' +
    properties.map(function(p) { return '<option value="' + p.id + '">' + esc(getPropertyLabel(p)) + '</option>'; }).join('');
  sel.innerHTML = opts;
  var cSel = document.getElementById('c_property');
  if (cSel) cSel.innerHTML = '<option value="">-- Select --</option>' +
    properties.map(function(p) { return '<option value="' + p.id + '">' + esc(getPropertyLabel(p)) + '</option>'; }).join('');
  var compSel = document.getElementById('compPropertySelect');
  if (compSel) compSel.innerHTML = '<option value="">-- Select property --</option>' +
    properties.map(function(p) { return '<option value="' + p.id + '">' + esc(getPropertyLabel(p)) + '</option>'; }).join('');
}

async function runAnalysis() {
  const pid = document.getElementById('analyzePropertySelect').value;
  if (!pid) { toast('Select a property first', 'error'); return; }
  showLoading('Running pricing analysis...');
  try {
    const d = await api('/api/properties/' + pid + '/analyze', 'POST', { use_ai: aiEnabled, ai_provider: aiProvider, analysis_type: analysisType });
    const prop = d.property || {};
    let h = '';
    if (d.market) {
      const m = d.market;
      h += '<div class="card"><h3 style="margin-bottom:12px">Market Context</h3><div class="market-grid">';
      if (m.avg_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(m.avg_daily_rate).toLocaleString() + '</div><div class="lbl">Avg Rent/mo</div></div>';
      if (m.median_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(m.median_daily_rate).toLocaleString() + '</div><div class="lbl">Median Rent/mo</div></div>';
      if (m.avg_occupancy) h += '<div class="market-stat"><div class="val">' + Math.round(m.avg_occupancy * 100) + '%</div><div class="lbl">Occupancy</div></div>';
      if (m.active_listings) h += '<div class="market-stat"><div class="val">' + m.active_listings + '</div><div class="lbl">Listings</div></div>';
      h += '</div></div>';
    }
    // Show property's preset values vs suggested for comparison
    if (prop.cleaning_fee || prop.base_nightly_rate) {
      h += '<div class="card" style="margin-bottom:14px;"><h3 style="margin-bottom:10px;">Your Current Settings</h3><div class="market-grid">';
      if (prop.cleaning_fee) h += '<div class="market-stat"><div class="val">$' + prop.cleaning_fee + '</div><div class="lbl">Your Cleaning Fee</div></div>';
      h += '</div></div>';
    }
    h += '<div class="strategies-grid">';
    // PriceLabs data card if available
    if (d.pricelabs) {
      var pl = d.pricelabs;
      h += '<div style="grid-column:1/-1;padding:14px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:8px;margin-bottom:10px;">';
      h += '<div style="font-weight:600;color:var(--purple);font-size:0.82rem;margin-bottom:8px;">📊 PriceLabs Live Data</div>';
      h += '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:0.82rem;">';
      if (pl.base_price) h += '<span>Base: <strong>$' + pl.base_price + '/nt</strong></span>';
      if (pl.recommended_base) h += '<span>Rec: <strong style="color:var(--accent);">$' + pl.recommended_base + '/nt</strong></span>';
      if (pl.min_price) h += '<span>Min: $' + pl.min_price + '</span>';
      if (pl.max_price) h += '<span>Max: $' + pl.max_price + '</span>';
      if (pl.cleaning_fees) h += '<span>Clean: $' + pl.cleaning_fees + '</span>';
      if (pl.occ_30d) h += '<span>Your 30d Occ: <strong>' + pl.occ_30d + '</strong> (mkt: ' + (pl.mkt_occ_30d || '?') + ')</span>';
      h += '</div></div>';
    }
    (d.strategies || []).forEach(s => {
      const ai = s.ai_generated;
      const isLTR = s.min_nights >= 365 || s.strategy_name.includes('LTR');
      const provLabel = { anthropic: 'Claude', openai: 'GPT-4o', workers_ai: 'Workers AI' }[s.ai_provider] || s.ai_provider || 'AI';
      h += '<div class="strategy-card' + (ai ? ' ai' : '') + '">';
      h += '<h3>' + esc(s.strategy_name) + (ai ? ' <span class="ai-badge">✦ ' + esc(provLabel) + '</span>' : '') + (isLTR ? ' <span class="ltr-label">LTR</span>' : '') + '</h3>';
      if (isLTR) {
        h += '<div class="strategy-stat"><span>Monthly Rent</span><span class="val">$' + (s.base_nightly_rate || 0).toLocaleString() + '</span></div>';
        h += '<div class="strategy-stat"><span>Vacancy</span><span class="val">' + Math.round((1 - s.projected_occupancy) * 100) + '%</span></div>';
      } else {
        h += '<div class="strategy-stat"><span>Nightly Rate</span><span class="val">$' + s.base_nightly_rate + '</span></div>';
        h += '<div class="strategy-stat"><span>Weekend Rate</span><span class="val">$' + s.weekend_rate + '</span></div>';
        var sugClean = s.cleaning_fee || 0;
        var yourClean = prop.cleaning_fee || 0;
        var cleanLabel = 'Suggested Cleaning';
        if (yourClean > 0 && yourClean !== sugClean) {
          cleanLabel = 'Cleaning <span style="font-size:0.72rem;color:var(--text3);">(yours: $' + yourClean + ')</span>';
        }
        h += '<div class="strategy-stat"><span>' + cleanLabel + '</span><span class="val">$' + sugClean + '</span></div>';
        h += '<div class="strategy-stat"><span>Occupancy</span><span class="val">' + Math.round(s.projected_occupancy * 100) + '%</span></div>';
      }
      h += '<div class="strategy-stat" style="border-top:2px solid var(--border);padding-top:10px;"><span>Annual Revenue</span><span class="val" style="font-size:1.05em;color:var(--accent);">$' + (s.projected_annual_revenue || 0).toLocaleString() + '</span></div>';
      h += '<div class="strategy-stat"><span>Monthly Avg</span><span class="val" style="font-size:1.05em;color:var(--accent);">$' + (s.projected_monthly_avg || 0).toLocaleString() + '</span></div>';
      if (!isLTR) {
        h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;font-size:0.78rem;color:var(--text3);">';
        h += '<span>Min ' + s.min_nights + 'nt</span>';
        h += '<span>Wk -' + s.weekly_discount + '%</span>';
        h += '<span>Mo -' + s.monthly_discount + '%</span>';
        h += '<span>Peak +' + (s.peak_season_markup || 0) + '%</span>';
        h += '<span>Low -' + (s.low_season_discount || 0) + '%</span>';
        if (s.pet_fee) h += '<span>Pet $' + s.pet_fee + '</span>';
        h += '</div>';
      }
      if (s.reasoning) {
        h += '<div style="margin-top:10px;padding:10px 12px;background:' + (ai ? 'rgba(167,139,250,0.08)' : 'var(--bg)') + ';border-radius:6px;font-size:0.82rem;line-height:1.55;color:var(--text2);">';
        if (ai) h += '<span style="color:var(--purple);font-weight:600;font-size:0.75rem;display:block;margin-bottom:4px;">✦ AI ANALYSIS</span>';
        // Show full analysis with paragraph breaks
        var analysisText = s.analysis || s.reasoning || '';
        analysisText.split(/\n\n|\n/).forEach(function(para) {
          if (para.trim()) h += '<p style="margin:0 0 8px 0;">' + esc(para.trim()) + '</p>';
        });
        h += '</div>';
      }
      // Recommendations
      if (s.recommendations && s.recommendations.length > 0) {
        h += '<div style="margin-top:8px;padding:10px 12px;background:rgba(16,185,129,0.04);border:1px solid rgba(16,185,129,0.12);border-radius:6px;">';
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--accent);margin-bottom:4px;">RECOMMENDATIONS</div>';
        s.recommendations.forEach(function(r) { h += '<div style="font-size:0.78rem;margin:3px 0;">• ' + esc(r) + '</div>'; });
        h += '</div>';
      }
      // Cleaning fee reasoning
      if (s.cleaning_fee_reasoning) {
        h += '<div style="margin-top:6px;font-size:0.72rem;color:var(--text3);">💡 Cleaning: ' + esc(s.cleaning_fee_reasoning) + '</div>';
      }
      // Breakeven
      if (s.breakeven_rate) {
        h += '<div style="margin-top:6px;font-size:0.72rem;color:var(--text3);">📊 Breakeven rate: $' + s.breakeven_rate + '/nt</div>';
      }
      h += '</div>';
    });
    h += '</div>';
    // Show comps count + auto-fetch info
    var compMsg = 'Analysis used ' + (d.comparables_count || 0) + ' comparable(s).';
    if (d.auto_fetch) compMsg += ' ' + esc(d.auto_fetch);
    var usedProviders = new Set();
    (d.strategies || []).forEach(function(s) { if (s.ai_provider) usedProviders.add(s.ai_provider); });
    var provLabels2 = { anthropic: 'Claude (Anthropic)', openai: 'GPT-4o (OpenAI)', workers_ai: 'Workers AI (Cloudflare)' };
    if (usedProviders.size > 0) compMsg += ' · AI: ' + Array.from(usedProviders).map(function(p) { return provLabels2[p] || p; }).join(', ');
    h += '<div style="margin-top:10px;font-size:0.82rem;color:var(--text3);">' + compMsg + '</div>';
    document.getElementById('analysisResults').innerHTML = h;
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

// Market Data
var marketType = 'str'; // str or ltr

function setMarketType(type) {
  marketType = type;
  document.querySelectorAll('.mkt-type-btn').forEach(function(b) {
    var active = b.dataset.mtype === type;
    b.classList.toggle('active', active);
    b.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    b.style.color = active ? 'var(--accent)' : 'var(--text3)';
  });
  // Update max price label
  var mpWrap = document.getElementById('mktMaxPriceWrap');
  if (mpWrap) {
    var label = mpWrap.querySelector('label');
    if (label) label.textContent = type === 'ltr' ? 'Max Rent ($)' : 'Max Nightly ($)';
  }
  // Reload historical with new type
  loadMarketData();
}

function toggleMarketForm() {
  const f = document.getElementById('addMarketForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
}

async function loadMarketData() {
  loadMarketCities();
  try {
    var d = await api('/api/market?rental_type=' + marketType);
    var snaps = d.snapshots || [];
    var el = document.getElementById('marketList');
    if (!el) return;
    if (snaps.length === 0) {
      el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No ' + (marketType === 'ltr' ? 'long-term' : 'short-term') + ' market data yet. Select a city and click "Search Market" above.</p>';
      return;
    }
    // Group by city
    var byCityMap = {};
    snaps.forEach(function(m) {
      var key = m.city + '|' + m.state;
      if (!byCityMap[key]) byCityMap[key] = { city: m.city, state: m.state, snaps: [] };
      byCityMap[key].snaps.push(m);
    });
    var cities = Object.values(byCityMap);
    var h = '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:8px;">HISTORICAL DATA (' + snaps.length + ' snapshots)</label>';
    cities.forEach(function(c) {
      var latest = c.snaps[0];
      var rateLabel = marketType === 'ltr' ? 'Monthly Rent' : 'Avg Rate';
      h += '<div style="margin-bottom:16px;padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;cursor:pointer;" onclick="openMarketDeepDive(\'' + esc(c.city).replace(/'/g, "\\'") + '\',\'' + esc(c.state).replace(/'/g, "\\'") + '\')">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
      h += '<h4 style="font-size:0.95rem;">' + esc(c.city) + ', ' + esc(c.state) + '</h4>';
      h += '<span style="color:var(--accent);font-size:0.72rem;">Deep dive →</span>';
      h += '</div>';
      h += '<div class="market-grid">';
      if (latest.avg_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(latest.avg_daily_rate).toLocaleString() + '</div><div class="lbl">' + rateLabel + '</div></div>';
      if (latest.median_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(latest.median_daily_rate).toLocaleString() + '</div><div class="lbl">Median</div></div>';
      if (latest.avg_occupancy) h += '<div class="market-stat"><div class="val">' + Math.round(latest.avg_occupancy * 100) + '%</div><div class="lbl">Occupancy</div></div>';
      if (latest.active_listings) h += '<div class="market-stat"><div class="val">' + latest.active_listings.toLocaleString() + '</div><div class="lbl">Listings</div></div>';
      h += '</div>';
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">' + esc(latest.data_source || 'manual') + ' · ' + (latest.snapshot_date || '').substring(0, 10) + ' · ' + c.snaps.length + ' snapshot' + (c.snaps.length > 1 ? 's' : '') + '</div>';
      h += '</div>';
    });
    el.innerHTML = h;
  } catch (err) { toast(err.message, 'error'); }
}

async function runMarketSearch() {
  if (marketCities.length === 0) { toast('Add at least one city first', 'error'); return; }
  var beds = document.getElementById('mktFilterBeds').value || null;
  var baths = document.getElementById('mktFilterBaths').value || null;
  var propType = document.getElementById('mktFilterType').value || null;
  var maxPrice = document.getElementById('mktFilterMaxPrice').value || null;
  var radius = document.getElementById('mktFilterRadius').value || 10;

  var statusEl = document.getElementById('marketSearchStatus');
  var aiEl = document.getElementById('marketAiAnalysis');
  var linksEl = document.getElementById('marketSearchLinks');
  var linkGrid = document.getElementById('marketLinkGrid');
  var dataEl = document.getElementById('marketDataSection');

  // Run search for each city
  var allResults = [];
  for (var i = 0; i < marketCities.length; i++) {
    var c = marketCities[i];
    if (statusEl) statusEl.textContent = 'Searching ' + c.city + ', ' + c.state + ' (' + (i + 1) + '/' + marketCities.length + ')...';
    showLoading('Searching ' + c.city + ', ' + c.state + '...');
    try {
      var d = await api('/api/market/search', 'POST', {
        city: c.city, state: c.state, rental_type: marketType,
        bedrooms: beds ? parseInt(beds) : null,
        bathrooms: baths ? parseFloat(baths) : null,
        property_type: propType, max_price: maxPrice ? parseInt(maxPrice) : null,
        radius_miles: parseInt(radius), use_ai: marketAiEnabled
      });
      allResults.push({ city: c.city, state: c.state, data: d });
    } catch (err) {
      allResults.push({ city: c.city, state: c.state, error: err.message });
    }
  }
  hideLoading();

  // Render results
  var statusParts = [];
  var allLinks = [];
  var allListings = [];
  var aiTexts = [];

  allResults.forEach(function(r) {
    if (r.error) {
      statusParts.push(r.city + ': ' + r.error);
      return;
    }
    var d = r.data;
    // Sources
    (d.sources || []).forEach(function(s) {
      var icon = s.status === 'ok' ? '✓' : s.status === 'limit' ? '⚠' : '✗';
      statusParts.push(icon + ' ' + r.city + '/' + s.name + (s.detail ? ': ' + s.detail : ''));
    });
    // Search links
    (d.search_links || []).forEach(function(l) {
      l.city = r.city;
      l.state = r.state;
      allLinks.push(l);
    });
    // Listings
    (d.listings || []).forEach(function(l) {
      l._city = r.city;
      allListings.push(l);
    });
    // AI
    if (d.ai_analysis) aiTexts.push({ city: r.city, state: r.state, text: d.ai_analysis });
    // RC usage
    if (d.rc_usage) {
      statusParts.push('RentCast: ' + d.rc_usage.used + '/' + d.rc_usage.limit + ' calls used');
    }
  });

  // Status
  if (statusEl) statusEl.innerHTML = statusParts.map(function(s) { return '<div>' + esc(s) + '</div>'; }).join('');

  // AI Analysis
  if (aiEl) {
    if (aiTexts.length > 0) {
      aiEl.innerHTML = aiTexts.map(function(a) {
        return '<div style="margin-bottom:12px;"><strong style="color:var(--purple);">✦ ' + esc(a.city) + ', ' + esc(a.state) + ':</strong><div style="margin-top:4px;white-space:pre-wrap;">' + esc(a.text) + '</div></div>';
      }).join('');
      aiEl.style.display = '';
    } else { aiEl.style.display = 'none'; }
  }

  // Search Links — grouped by city
  if (linksEl && linkGrid && allLinks.length > 0) {
    var linkHtml = '';
    var seenCities = {};
    allLinks.forEach(function(l) {
      var key = l.city + '|' + l.state;
      if (!seenCities[key]) {
        seenCities[key] = true;
        linkHtml += '<div style="grid-column:1/-1;font-size:0.78rem;color:var(--text2);font-weight:600;margin-top:' + (linkHtml ? '10px' : '0') + ';">' + esc(l.city) + ', ' + esc(l.state) + '</div>';
      }
      linkHtml += '<a href="' + esc(l.url) + '" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;text-decoration:none;color:var(--text);font-size:0.82rem;transition:border-color 0.15s;" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">' + (l.icon || '🔗') + ' ' + esc(l.name) + ' <span style="color:var(--accent);font-size:0.72rem;">→</span></a>';
    });
    linkGrid.innerHTML = linkHtml;
    linksEl.style.display = '';
  } else if (linksEl) { linksEl.style.display = 'none'; }

  // Listings table
  if (dataEl && allListings.length > 0) {
    var isLTR = marketType === 'ltr';
    var lh = '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:8px;">LISTINGS FOUND (' + allListings.length + ')</label>';
    lh += '<div style="overflow-x:auto;"><table class="comp-table"><thead><tr><th>Address</th><th>Beds/Bath</th><th>Sqft</th><th>' + (isLTR ? 'Rent' : 'Rate') + '</th><th>Type</th><th>Days Listed</th></tr></thead><tbody>';
    allListings.forEach(function(l) {
      lh += '<tr>';
      lh += '<td>' + (l.url ? '<a href="' + esc(l.url) + '" target="_blank" style="color:var(--accent);">' + esc((l.address || 'Listing').substring(0, 40)) + '</a>' : esc((l.address || 'Listing').substring(0, 40))) + '</td>';
      lh += '<td>' + (l.bedrooms || '?') + '/' + (l.bathrooms || '?') + '</td>';
      lh += '<td>' + (l.sqft ? l.sqft.toLocaleString() : '—') + '</td>';
      lh += '<td style="color:var(--accent);font-weight:600;font-family:DM Mono,monospace;">$' + (l.price || 0).toLocaleString() + '</td>';
      lh += '<td style="font-size:0.78rem;">' + esc((l.property_type || '').replace(/_/g, ' ')) + '</td>';
      lh += '<td>' + (l.days_on_market || '—') + '</td>';
      lh += '</tr>';
    });
    lh += '</tbody></table></div>';
    // Summary stats
    var prices = allListings.map(function(l) { return l.price || 0; }).filter(function(p) { return p > 0; });
    if (prices.length > 0) {
      var avg = Math.round(prices.reduce(function(a, b) { return a + b; }, 0) / prices.length);
      var minP = Math.min.apply(null, prices);
      var maxP = Math.max.apply(null, prices);
      lh = '<div class="market-grid" style="margin-bottom:14px;">' +
        '<div class="market-stat"><div class="val">$' + avg.toLocaleString() + '</div><div class="lbl">Avg ' + (isLTR ? 'Rent' : 'Rate') + '</div></div>' +
        '<div class="market-stat"><div class="val">$' + minP.toLocaleString() + ' - $' + maxP.toLocaleString() + '</div><div class="lbl">Range</div></div>' +
        '<div class="market-stat"><div class="val">' + allListings.length + '</div><div class="lbl">Listings</div></div>' +
        '</div>' + lh;
    }
    dataEl.innerHTML = lh;
    dataEl.style.display = '';
  } else if (dataEl) { dataEl.style.display = 'none'; }

  // Refresh historical
  await loadMarketData();
  toast('Market search complete');
}

async function fetchMarketFromAPI() {
  var statusEl = document.getElementById('marketFetchStatus');
  if (statusEl) statusEl.textContent = 'Pulling market data...';
  showLoading('Fetching market data...');
  try {
    var d = await api('/api/market/fetch', 'POST', { cities: marketCities, use_ai: marketAiEnabled });
    var msg = d.message || 'Done';
    if (d.fetched) {
      msg += ' — ';
      d.fetched.forEach(function(f) { msg += f.city + ': ' + f.status + '; '; });
    }
    if (d.rc_usage) msg += ' [RentCast: ' + d.rc_usage.used + '/' + d.rc_usage.limit + ']';
    if (statusEl) statusEl.innerHTML = esc(msg);
    toast(d.message || 'Market data updated');
    await loadMarketData();
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    toast(err.message, 'error');
  }
  hideLoading();
}

async function saveMarketSnapshot() {
  const body = {
    city: document.getElementById('m_city').value, state: document.getElementById('m_state').value.toUpperCase(),
    avg_daily_rate: parseFloat(document.getElementById('m_adr').value) || null,
    median_daily_rate: parseFloat(document.getElementById('m_median').value) || null,
    avg_occupancy: (parseFloat(document.getElementById('m_occ').value) || 0) / 100,
    active_listings: parseInt(document.getElementById('m_listings').value) || null,
    peak_month: document.getElementById('m_peak').value, low_month: document.getElementById('m_low').value,
    data_source: document.getElementById('m_source').value || 'manual',
  };
  if (!body.city || !body.state) { toast('City and state required', 'error'); return; }
  try { await api('/api/market', 'POST', body); toast('Snapshot added'); toggleMarketForm(); loadMarketData(); }
  catch (err) { toast(err.message, 'error'); }
}

// Comparables
function toggleCompForm() {
  const f = document.getElementById('addCompForm');
  f.style.display = f.style.display === 'none' ? 'block' : 'none';
  populateAnalyzeSelects();
}

function setCompType(type) {
  compType = type;
  document.querySelectorAll('.comp-type-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.ctype === type); });
  var rl = document.getElementById('compRateLabel');
  if (rl) rl.textContent = type === 'ltr' ? 'Monthly Rent ($)' : 'Nightly Rate ($)';
  // Reload comps filtered by new type
  var pid = (document.getElementById('compPropertySelect') || {}).value;
  if (pid) loadPropertyComps(pid);
  // Clear fetch status
  var st = document.getElementById('compFetchStatus');
  if (st) st.innerHTML = '';
}

