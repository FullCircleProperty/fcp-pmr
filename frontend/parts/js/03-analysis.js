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
    const d = await api('/api/properties/' + pid + '/analyze', 'POST', { use_ai: aiEnabled, quality: aiQuality, analysis_type: analysisType });
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
      h += '<div style="font-weight:600;color:var(--purple);font-size:0.82rem;margin-bottom:8px;">' + _ico('barChart', 13) + ' PriceLabs Live Data</div>';
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
      const provLabel = { anthropic: 'Claude', openai: 'GPT-4o', workers_ai: 'Workers AI' }[s.ai_provider] || 'AI';
      h += '<div class="strategy-card' + (ai ? ' ai' : '') + '">';
      h += '<h3>' + esc(s.strategy_name) + (ai ? ' <span class="ai-badge">' + _ico('sparkle', 13, 'var(--purple)') + ' ' + esc(provLabel) + '</span>' : '') + (isLTR ? ' <span class="ltr-label">LTR</span>' : '') + '</h3>';
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
      if (s.reasoning || s.analysis) {
        h += '<div style="margin-top:10px;padding:10px 12px;background:' + (ai ? 'rgba(167,139,250,0.08)' : 'var(--bg)') + ';border-radius:6px;font-size:0.82rem;line-height:1.55;color:var(--text2);">';
        if (ai) h += '<span style="color:var(--purple);font-weight:600;font-size:0.75rem;display:block;margin-bottom:4px;">' + _ico('sparkle', 13, 'var(--purple)') + ' AI ANALYSIS</span>';
        // Show full analysis with paragraph breaks — detect raw JSON and parse it
        var analysisText = s.analysis || s.reasoning || '';
        // If reasoning/analysis is raw JSON, try to extract the analysis text from it
        if (typeof analysisText === 'string' && analysisText.trim().charAt(0) === '{') {
          try {
            var parsed = JSON.parse(analysisText);
            analysisText = parsed.analysis || parsed.strategy_summary || parsed.reasoning || '';
            // Also extract recommendations if present
            if (!s.recommendations && parsed.recommendations) s.recommendations = parsed.recommendations;
            if (!s.cleaning_fee_reasoning && parsed.cleaning_fee_reasoning) s.cleaning_fee_reasoning = parsed.cleaning_fee_reasoning;
          } catch(e) {
            // If JSON parse fails, try to extract analysis field with regex
            var am = analysisText.match(/"analysis"\s*:\s*"((?:[^"\\]|\\.)*)"/);
            if (am) analysisText = am[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
            else analysisText = analysisText.substring(0, 500) + '...';
          }
        }
        if (analysisText) {
          analysisText.split(/\n\n|\n/).forEach(function(para) {
            if (para.trim()) h += '<p style="margin:0 0 8px 0;">' + esc(para.trim()) + '</p>';
          });
        }
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
        h += '<div style="margin-top:6px;font-size:0.72rem;color:var(--text3);">' + _ico('zap', 13) + ' Cleaning: ' + esc(s.cleaning_fee_reasoning) + '</div>';
      }
      // Breakeven
      if (s.breakeven_rate) {
        h += '<div style="margin-top:6px;font-size:0.72rem;color:var(--text3);">' + _ico('barChart', 13) + ' Breakeven rate: $' + s.breakeven_rate + '/nt</div>';
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
    if (d.ai_error) {
      var hasFallback = (d.strategies || []).some(function(s) { return s.ai_provider === 'workers_ai' && s.ai_generated; });
      if (hasFallback) {
        // Fallback succeeded — show soft warning not hard error
        h += '<div style="margin-top:8px;padding:10px 14px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.3);border-radius:8px;font-size:0.78rem;color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' <strong>Claude unavailable — fell back to Workers AI (Llama):</strong> ' + esc(d.ai_error.split('—')[0].trim()) + '</div>';
      } else {
        h += '<div style="margin-top:8px;padding:10px 14px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;font-size:0.8rem;color:var(--danger);">' + _ico('alertCircle', 13, '#f59e0b') + ' <strong>AI Strategy Failed:</strong> ' + esc(d.ai_error) + '</div>';
      }
    }
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
      var icon = s.status === 'ok' ? '✓' : s.status === 'limit' ? '' + _ico('alertCircle', 13, '#f59e0b') + '' : '✗';
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
        return '<div style="margin-bottom:12px;"><strong style="color:var(--purple);">' + _ico('sparkle', 13, 'var(--purple)') + ' ' + esc(a.city) + ', ' + esc(a.state) + ':</strong><div style="margin-top:4px;white-space:pre-wrap;">' + esc(a.text) + '</div></div>';
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
      linkHtml += '<a href="' + esc(l.url) + '" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;text-decoration:none;color:var(--text);font-size:0.82rem;transition:border-color 0.15s;" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">' + _ico(l.icon || 'link', 13) + ' ' + esc(l.name) + ' <span style="color:var(--accent);font-size:0.72rem;">→</span></a>';
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


// ── PRICING OVERVIEW (All Properties Subtab) ───────────────────────────────

var _poSort = { col: null, asc: true };
var _poFilter = 'all';

function switchAnalyzeTab(tab) {
  document.querySelectorAll('[data-atab]').forEach(function(b) {
    var isActive = b.getAttribute('data-atab') === tab;
    b.classList.toggle('active', isActive);
    b.style.borderBottom = isActive ? '2px solid var(--accent)' : '2px solid transparent';
  });
  ['overview', 'analyze'].forEach(function(t) {
    var el = document.getElementById('analyzeTab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'overview') loadPricingOverview();
}

var _pricingOverviewCache = null;

async function loadPricingOverview(forceRefresh) {
  var container = document.getElementById('pricingOverviewContent');
  if (!container) return;
  if (_pricingOverviewCache && !forceRefresh) { renderPricingOverview(_pricingOverviewCache, container); return; }
  container.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">' + _ico('loader',14) + ' Loading pricing data...</p>';
  try {
    var d = await api('/api/pricing/overview');
    _pricingOverviewCache = d;
    renderPricingOverview(d, container);
  } catch (err) {
    container.innerHTML = '<p style="color:var(--danger);">Error loading pricing overview: ' + esc(err.message) + '</p>';
  }
}

function renderPricingOverview(d, container) {
  var props = d.properties || [];
  if (props.length === 0) { container.innerHTML = '<p style="color:var(--text3);">No active properties found.</p>'; return; }

  // Apply filter
  var filtered = props;
  if (_poFilter === 'underpriced') filtered = props.filter(function(p) { return p.rate_context && (p.rate_context.classification === 'underpriced_high_occ' || p.rate_context.classification === 'possibly_underpriced'); });
  else if (_poFilter === 'overpriced') filtered = props.filter(function(p) { return p.rate_context && p.rate_context.classification === 'overpriced_low_occ'; });
  else if (_poFilter === 'stale') filtered = props.filter(function(p) { return _analysisAge(p) > 14; });
  else if (_poFilter === 'unanalyzed') filtered = props.filter(function(p) { return !p.latest_analysis; });

  // Apply sort
  if (_poSort.col) {
    filtered = filtered.slice().sort(function(a, b) {
      var va = _poSortVal(a, _poSort.col);
      var vb = _poSortVal(b, _poSort.col);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      var r = va < vb ? -1 : va > vb ? 1 : 0;
      return _poSort.asc ? r : -r;
    });
  }

  // Summary KPIs
  var withPL = props.filter(function(p) { return p.pricelabs; }).length;
  var withAnalysis = props.filter(function(p) { return p.latest_analysis; }).length;
  var underpriced = props.filter(function(p) { return p.rate_context && (p.rate_context.classification === 'underpriced_high_occ' || p.rate_context.classification === 'possibly_underpriced'); }).length;
  var overpriced = props.filter(function(p) { return p.rate_context && p.rate_context.classification === 'overpriced_low_occ'; }).length;
  var staleCount = props.filter(function(p) { return _analysisAge(p) > 14; }).length;
  var totalRev3mo = 0; var totalNights3mo = 0; var propsWithActuals = 0;
  props.forEach(function(p) {
    if (p.actuals) { totalRev3mo += (p.actuals.rev_3mo || 0); totalNights3mo += (p.actuals.nights || 0); propsWithActuals++; }
  });
  var avgPortAdr = totalNights3mo > 0 ? Math.round(totalRev3mo / totalNights3mo) : 0;

  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px;">';
  h += _poKpi('Properties', props.length, 'home', 'var(--accent)');
  h += _poKpi('PriceLabs', withPL + '/' + props.length, 'link', '#8b5cf6');
  h += _poKpi('Analyzed', withAnalysis + '/' + props.length, 'sparkle', '#06b6d4');
  h += _poKpi('Avg ADR', avgPortAdr > 0 ? '$' + avgPortAdr : '—', 'dollarSign', '#10b981');
  h += _poKpi('3mo Revenue', totalRev3mo > 0 ? '$' + Math.round(totalRev3mo).toLocaleString() : '—', 'trendingUp', '#059669');
  if (underpriced > 0) h += _poKpi('Underpriced', underpriced, 'trendingDown', '#f59e0b');
  if (overpriced > 0) h += _poKpi('Overpriced', overpriced, 'alertTriangle', '#ef4444');
  if (staleCount > 0) h += _poKpi('Stale Analysis', staleCount, 'clock', '#f97316');
  h += '</div>';

  // Filter bar
  h += '<div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">';
  h += '<span style="font-size:0.72rem;color:var(--text3);margin-right:4px;">Filter:</span>';
  var filters = [['all','All ('+props.length+')'],['underpriced','Underpriced'],['overpriced','Overpriced'],['stale','Stale (>14d)'],['unanalyzed','No Analysis']];
  filters.forEach(function(f) {
    var active = _poFilter === f[0];
    h += '<button class="btn btn-xs' + (active ? ' btn-primary' : '') + '" onclick="_poFilter=\'' + f[0] + '\';renderPricingOverview(_pricingOverviewCache,document.getElementById(\'pricingOverviewContent\'));" style="font-size:0.7rem;">' + f[1] + '</button>';
  });
  h += '<div style="flex:1;"></div>';
  h += '<button class="btn btn-xs" onclick="_runReanalyzeAll();" title="Re-run unified AI analysis on all active properties">' + _ico('zap',12) + ' Re-analyze All</button>';
  h += '<button class="btn btn-xs" onclick="_runPricingHealthCheck();" title="Run daily pricing health check">' + _ico('heartPulse',12) + ' Health Check</button>';
  h += '<button class="btn btn-xs" onclick="_pricingOverviewCache=null;loadPricingOverview(true);" title="Refresh data">' + _ico('refresh',12) + ' Refresh</button>';
  h += '</div>';

  // Table
  h += '<div class="card" style="overflow-x:auto;padding:0;">';
  h += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;" id="poTable">';
  h += '<thead><tr style="background:var(--bg2);border-bottom:2px solid var(--border);text-align:left;">';
  var cols = [
    ['label','Property',180,'left'],
    ['health','Health',75,'center'],
    ['pl_base','Rate (PL)',70,'right'],
    ['pl_min','Min',60,'right'],
    ['pl_max','Max',60,'right'],
    ['actual_adr','ADR',70,'right'],
    ['actual_occ','Occ',50,'right'],
    ['mkt_occ','Mkt',50,'right'],
    ['rev_3mo','Rev 3mo',80,'right'],
    ['cleaning','Cleaning',90,'right'],
    ['pet_fee','Pet Fee',80,'right'],
    ['extra_guest','Extra Guest',100,'right'],
    ['min_nights','Min Nts',60,'right'],
    ['discounts','Discounts',95,'center'],
    ['age','Analyzed',65,'center'],
    ['actions','',70,'center']
  ];
  cols.forEach(function(c) {
    var arrow = _poSort.col === c[0] ? (_poSort.asc ? ' ↑' : ' ↓') : '';
    var sortable = c[0] !== 'actions' && c[0] !== 'discounts';
    h += '<th style="padding:8px 6px;font-weight:600;text-align:' + c[3] + ';min-width:' + c[2] + 'px;white-space:nowrap;font-size:0.7rem;cursor:' + (sortable ? 'pointer' : 'default') + ';" ' + (sortable ? 'onclick="_poToggleSort(\'' + c[0] + '\')"' : '') + '>' + c[1] + arrow + '</th>';
  });
  h += '</tr></thead><tbody>';

  // Data rows
  filtered.forEach(function(p, i) {
    h += _poRow(p, i);
  });

  // Totals row
  if (filtered.length > 1) {
    h += _poTotalsRow(filtered);
  }

  h += '</tbody></table></div>';

  // Recommendation cards
  var analyzed = filtered.filter(function(p) { return p.recommendations && p.recommendations.length > 0; });
  if (analyzed.length > 0) {
    h += '<div style="margin-top:20px;">';
    h += '<h3 style="font-size:0.88rem;margin-bottom:12px;color:var(--text2);">' + _ico('sparkle',16,'var(--accent)') + ' Analysis Recommendations</h3>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;">';
    analyzed.forEach(function(p) {
      p.recommendations.forEach(function(r) {
        h += _poRecCard(p, r);
      });
    });
    h += '</div></div>';
  }

  // Unanalyzed prompt
  var unanalyzed = filtered.filter(function(p) { return !p.latest_analysis; });
  if (unanalyzed.length > 0 && _poFilter !== 'unanalyzed') {
    h += '<div class="card" style="margin-top:16px;border-left:3px solid var(--warning);padding:14px;">';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' + _ico('alertTriangle',15,'var(--warning)') + '<span style="font-weight:600;font-size:0.85rem;">' + unanalyzed.length + ' properties without pricing analysis</span></div>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
    unanalyzed.forEach(function(p) {
      h += '<button class="btn btn-xs" onclick="_poRunAnalysis(' + p.id + ')">' + esc(p.label) + '</button>';
    });
    h += '</div></div>';
  }

  container.innerHTML = h;
}

function _poRow(p, i) {
  var bg = i % 2 === 0 ? 'var(--bg1)' : 'var(--bg2)';
  var pl = p.pricelabs || {};
  var ai = p.latest_analysis || {};
  var act = p.actuals || {};
  var rc = p.rate_context;
  var gs = p.guesty_settings || {};

  // Health badge
  var healthBadge = '<span style="color:var(--text3);font-size:0.68rem;">—</span>';
  if (rc) {
    var hmap = {
      'underpriced_high_occ': ['#f59e0b','Underpriced'],
      'possibly_underpriced': ['#eab308','Check'],
      'overpriced_low_occ': ['#ef4444','Overpriced'],
      'well_priced': ['#10b981','Good']
    };
    var hinfo = hmap[rc.classification] || ['#6b7280','—'];
    healthBadge = '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:0.65rem;font-weight:600;color:#fff;background:' + hinfo[0] + ';" title="ADR gap: ' + (rc.gap_pct > 0 ? '+' : '') + rc.gap_pct + '% over ' + rc.months + ' months">' + hinfo[1] + '</span>';
  }

  // Occupancy with market comparison color
  var occDisplay = act.occ ? act.occ + '%' : '—';
  var mktOcc = pl.mkt_occ_30d ? (parseFloat(pl.mkt_occ_30d) * 100).toFixed(0) + '%' : '—';
  var occStyle = '';
  if (act.occ && pl.mkt_occ_30d) {
    var mktVal = parseFloat(pl.mkt_occ_30d) * 100;
    if (act.occ >= mktVal) occStyle = 'color:#10b981;font-weight:600;';
    else if (act.occ < mktVal - 10) occStyle = 'color:#ef4444;font-weight:600;';
  }

  // Rev 3mo
  var rev3 = act.rev_3mo ? '$' + Math.round(act.rev_3mo).toLocaleString() : '—';

  // ── COMPACT CELLS WITH DISAGREEMENT INDICATORS ──

  // Rate: PriceLabs dynamic rate + AI disagreement
  var rateCell = _$(pl.base);
  if (pl.base && ai.base && Math.abs(ai.base - pl.base) >= 5) {
    var rdiff = Math.round(ai.base - pl.base);
    var rcol = rdiff > 0 ? '#10b981' : '#ef4444';
    rateCell += '<div style="font-size:0.6rem;color:' + rcol + ';" title="AI recommends $' + ai.base + '">AI ' + (rdiff > 0 ? '+' : '') + '$' + rdiff + '</div>';
  }

  // Cleaning: Guesty setting + AI disagreement
  var cleanVal = _$(p.cleaning_fee);
  var cleanSrc = p.cleaning_source;
  var cleanTip = cleanSrc === 'guesty' ? 'Guesty listing' : cleanSrc === 'property' ? 'Property setting' : cleanSrc === 'guesty_avg' ? 'Guesty avg' : cleanSrc === 'pricelabs' ? 'PriceLabs' : cleanSrc === 'ai_rec' ? 'AI rec' : '';
  if (cleanSrc !== 'guesty' && cleanSrc !== 'none') cleanVal += '<sup style="font-size:0.5rem;color:var(--text3);">*</sup>';
  if (p.cleaning_fee && ai.cleaning && Math.abs(ai.cleaning - p.cleaning_fee) >= 10) {
    var cdiff = Math.round(ai.cleaning - p.cleaning_fee);
    cleanVal += '<div style="font-size:0.6rem;color:' + (cdiff > 0 ? '#10b981' : '#ef4444') + ';" title="AI recommends $' + ai.cleaning + '">AI ' + (cdiff > 0 ? '+' : '') + '$' + cdiff + '</div>';
  }

  // Pet fee: Guesty setting + AI disagreement
  var petVal = _$(p.pet_fee);
  var petSrc = p.pet_fee_source;
  var petTip = petSrc === 'guesty' ? 'Guesty listing' : petSrc === 'guesty_avg' ? 'Guesty avg' : petSrc === 'ai_analysis' ? 'AI rec' : '';
  if (petSrc !== 'guesty' && petSrc !== 'none') petVal += '<sup style="font-size:0.5rem;color:var(--text3);">*</sup>';
  if (p.pet_fee && ai.pet_fee && Math.abs(ai.pet_fee - p.pet_fee) >= 10) {
    var pdiff = Math.round(ai.pet_fee - p.pet_fee);
    petVal += '<div style="font-size:0.6rem;color:' + (pdiff > 0 ? '#10b981' : '#ef4444') + ';" title="AI recommends $' + ai.pet_fee + '">AI ' + (pdiff > 0 ? '+' : '') + '$' + pdiff + '</div>';
  }

  // Extra guest: Guesty setting with threshold
  var egVal = '—';
  var egTip = '';
  if (p.extra_guest_fee && p.extra_guest_fee > 0) {
    var threshold = gs.guests_included || '?';
    egVal = '$' + p.extra_guest_fee + '/nt';
    egTip = 'After ' + threshold + ' guests · Guesty listing';
    egVal += '<div style="font-size:0.58rem;color:var(--text3);">after ' + threshold + 'g</div>';
  } else if (p.recommendations) {
    for (var ri = 0; ri < p.recommendations.length; ri++) {
      if (p.recommendations[ri].extra_guest && p.recommendations[ri].extra_guest > 0) {
        egVal = '<span style="color:var(--text3);">$' + p.recommendations[ri].extra_guest + '/nt</span>';
        egTip = 'AI recommendation (not set in Guesty)';
        egVal += '<div style="font-size:0.58rem;color:var(--warning);">AI rec</div>';
        break;
      }
    }
  }

  // Min nights: Guesty default, note if PL overrides per-date
  var cm = p.calendar_min_nights;
  var minNDisplay = '—';
  var minNTip = '';
  if (gs.min_nights) {
    minNDisplay = String(gs.min_nights);
    minNTip = 'Guesty default';
    if (cm && cm.min !== cm.max) {
      minNDisplay += '<div style="font-size:0.58rem;color:var(--text3);">' + cm.min + '-' + cm.max + 'd</div>';
      minNTip += ' (PL overrides: ' + cm.min + '-' + cm.max + ' next 30d)';
    }
  } else if (cm) {
    minNDisplay = cm.min === cm.max ? String(cm.min) : cm.min + '-' + cm.max;
    minNTip = 'Guesty calendar (next 30d)';
  } else if (ai.min_nights) {
    minNDisplay = '<span style="color:var(--text3);">' + ai.min_nights + '</span>';
    minNTip = 'AI recommendation';
  }

  // Discounts: Guesty weekly/monthly + AI disagreement
  var discDisplay = '';
  var wDisc = gs.weekly_factor ? Math.round((1 - gs.weekly_factor) * 100) : null;
  var mDisc = gs.monthly_factor ? Math.round((1 - gs.monthly_factor) * 100) : null;
  if (wDisc || mDisc) {
    var parts = [];
    if (wDisc) parts.push('W:' + wDisc + '%');
    if (mDisc) parts.push('M:' + mDisc + '%');
    discDisplay = '<span style="font-size:0.68rem;color:var(--text2);">' + parts.join(' · ') + '</span>';
    // AI disagreement on discounts
    if (ai.weekly_disc && wDisc && Math.abs(ai.weekly_disc - wDisc) >= 5) {
      discDisplay += '<div style="font-size:0.55rem;color:var(--accent);">AI W:' + ai.weekly_disc + '%</div>';
    }
  } else if (ai.weekly_disc || ai.monthly_disc) {
    var aParts = [];
    if (ai.weekly_disc) aParts.push('W:' + ai.weekly_disc + '%');
    if (ai.monthly_disc) aParts.push('M:' + ai.monthly_disc + '%');
    discDisplay = '<span style="font-size:0.68rem;color:var(--text3);">' + aParts.join(' · ') + '</span>';
    discDisplay += '<div style="font-size:0.55rem;color:var(--warning);">AI rec</div>';
  }
  if (ai.peak_markup && ai.peak_markup > 0) {
    discDisplay += (discDisplay ? '<br>' : '') + '<span style="font-size:0.6rem;color:#f59e0b;">Peak +' + ai.peak_markup + '%</span>';
  }
  if (!discDisplay) discDisplay = '<span style="color:var(--text3);font-size:0.68rem;">—</span>';

  // Analysis age
  var ageDays = _analysisAge(p);
  var ageBadge = '<span style="color:var(--text3);font-size:0.68rem;">Never</span>';
  if (ai.date) {
    var aColor = ageDays <= 7 ? '#10b981' : ageDays <= 14 ? '#eab308' : '#ef4444';
    ageBadge = '<span style="color:' + aColor + ';font-size:0.7rem;font-weight:500;" title="' + esc(ai.date) + '">' + _timeAgo(ai.date) + '</span>';
  }

  // ── BUILD ROW ──
  var h = '<tr style="background:' + bg + ';border-bottom:1px solid var(--border);" onmouseover="this.style.background=\'var(--bg3)\'" onmouseout="this.style.background=\'' + bg + '\'">';
  // Property name
  h += '<td style="padding:7px 8px;position:sticky;left:0;background:inherit;z-index:1;">';
  h += '<a href="#" onclick="event.preventDefault();switchView(\'properties\');setTimeout(function(){loadPropertyDetail(' + p.id + ')},100);" style="color:var(--accent);text-decoration:none;font-weight:500;font-size:0.78rem;">' + esc(p.label) + '</a>';
  if (p.city) h += '<div style="font-size:0.65rem;color:var(--text3);">' + esc(p.city) + (p.state ? ', ' + p.state : '') + (p.bedrooms ? ' · ' + p.bedrooms + 'BR' : '') + (p.max_guests ? '/' + p.max_guests + 'g' : '') + '</div>';
  h += '</td>';
  h += '<td style="padding:7px 6px;text-align:center;">' + healthBadge + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;" title="PriceLabs dynamic rate">' + rateCell + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;" title="PriceLabs min floor">' + _$(pl.min) + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;" title="PriceLabs max ceiling">' + _$(pl.max) + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-weight:600;font-variant-numeric:tabular-nums;">' + _$(act.adr) + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;' + occStyle + '">' + occDisplay + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;color:var(--text3);font-size:0.72rem;">' + mktOcc + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;font-size:0.75rem;">' + rev3 + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;" title="' + cleanTip + '">' + cleanVal + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;" title="' + petTip + '">' + petVal + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;font-size:0.72rem;" title="' + egTip + '">' + egVal + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;" title="' + minNTip + '">' + minNDisplay + '</td>';
  h += '<td style="padding:7px 6px;text-align:center;">' + discDisplay + '</td>';
  h += '<td style="padding:7px 6px;text-align:center;">' + ageBadge + '</td>';
  h += '<td style="padding:7px 6px;text-align:center;white-space:nowrap;">';
  h += '<button class="btn btn-xs" onclick="_poRunAnalysis(' + p.id + ')" title="Run analysis" style="padding:3px 6px;">' + _ico('sparkle',12) + '</button> ';
  h += '<button class="btn btn-xs" onclick="switchView(\'properties\');setTimeout(function(){loadPropertyDetail(' + p.id + ')},100);" title="View" style="padding:3px 6px;">' + _ico('eye',12) + '</button>';
  h += '</td>';
  h += '</tr>';
  return h;
}

function _poTotalsRow(filtered) {
  var totals = { plBase: [], plMin: [], plMax: [], adr: [], occ: [], mktOcc: [], rev: 0, cleaning: [], pet: [], eg: [] };
  filtered.forEach(function(p) {
    var pl = p.pricelabs || {};
    var act = p.actuals || {};
    if (pl.base) totals.plBase.push(pl.base);
    if (pl.min) totals.plMin.push(pl.min);
    if (pl.max) totals.plMax.push(pl.max);
    if (act.adr) totals.adr.push(act.adr);
    if (act.occ) totals.occ.push(act.occ);
    if (pl.mkt_occ_30d) totals.mktOcc.push(parseFloat(pl.mkt_occ_30d) * 100);
    if (act.rev_3mo) totals.rev += act.rev_3mo;
    if (p.cleaning_fee) totals.cleaning.push(p.cleaning_fee);
    if (p.pet_fee) totals.pet.push(p.pet_fee);
    if (p.extra_guest_fee) totals.eg.push(p.extra_guest_fee);
  });
  var avg = function(arr) { return arr.length > 0 ? Math.round(arr.reduce(function(s,v){return s+v;},0) / arr.length) : null; };

  var h = '<tr style="background:var(--bg2);border-top:2px solid var(--border);font-weight:600;font-size:0.75rem;">';
  h += '<td style="padding:8px;position:sticky;left:0;background:var(--bg2);z-index:1;">Portfolio Avg / Total</td>';
  h += '<td></td>'; // health
  h += _poCell(avg(totals.plBase));
  h += _poCell(avg(totals.plMin));
  h += _poCell(avg(totals.plMax));
  h += '<td style="padding:7px 6px;text-align:right;">' + _$(avg(totals.adr)) + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;">' + (totals.occ.length > 0 ? Math.round(avg(totals.occ)) + '%' : '—') + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;color:var(--text3);">' + (totals.mktOcc.length > 0 ? Math.round(avg(totals.mktOcc)) + '%' : '—') + '</td>';
  h += '<td style="padding:7px 6px;text-align:right;">$' + Math.round(totals.rev).toLocaleString() + '</td>';
  h += _poCell(avg(totals.cleaning));
  h += _poCell(avg(totals.pet));
  h += '<td style="padding:7px 6px;text-align:right;font-size:0.72rem;">' + (totals.eg.length > 0 ? '$' + avg(totals.eg) + '/nt' : '—') + '</td>';
  h += '<td colspan="3"></td>'; // min nts, discounts, analyzed
  h += '<td></td>'; // actions
  h += '</tr>';
  return h;
}

function _poRecCard(p, r) {
  var h = '<div class="card" style="padding:14px;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">';
  h += '<div><span style="font-weight:600;font-size:0.82rem;color:var(--text1);">' + esc(p.label) + '</span>';
  h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">' + esc(r.type) + (r.strategy_name ? ' — ' + esc(r.strategy_name) : '') + ' · ' + _timeAgo(r.date) + '</div></div>';
  if (r.provider) h += '<span style="font-size:0.62rem;padding:2px 6px;border-radius:8px;background:var(--bg3);color:var(--text3);">' + esc(r.provider) + '</span>';
  h += '</div>';
  if (r.base || r.min || r.max || r.cleaning || r.pet || r.extra_guest) {
    h += '<div style="display:flex;gap:10px;margin-bottom:8px;flex-wrap:wrap;">';
    if (r.base) h += _poRecChip('Base', '$' + r.base, 'var(--accent)');
    if (r.min) h += _poRecChip('Min', '$' + r.min, 'var(--text2)');
    if (r.max) h += _poRecChip('Max', '$' + r.max, 'var(--text2)');
    if (r.cleaning) h += _poRecChip('Clean', '$' + r.cleaning, '#8b5cf6');
    if (r.pet) h += _poRecChip('Pet', '$' + r.pet, '#f59e0b');
    if (r.extra_guest) h += _poRecChip('Extra Guest', '$' + r.extra_guest, '#06b6d4');
    h += '</div>';
  }
  if (r.summary) h += '<p style="font-size:0.76rem;color:var(--text2);line-height:1.4;margin:0;">' + esc(r.summary) + '</p>';
  h += '</div>';
  return h;
}

function _poRecChip(label, value, color) {
  return '<div style="font-size:0.7rem;"><span style="color:var(--text3);">' + label + ' </span><span style="font-weight:600;color:' + color + ';">' + value + '</span></div>';
}

function _poRunAnalysis(pid) {
  switchAnalyzeTab('analyze');
  setTimeout(function() {
    var s = document.getElementById('analyzePropertySelect');
    if (s) { s.value = pid; onAnalyzePropertyChange(); }
  }, 100);
}

function _poToggleSort(col) {
  if (_poSort.col === col) _poSort.asc = !_poSort.asc;
  else { _poSort.col = col; _poSort.asc = true; }
  renderPricingOverview(_pricingOverviewCache, document.getElementById('pricingOverviewContent'));
}

function _poSortVal(p, col) {
  var pl = p.pricelabs || {};
  var ai = p.latest_analysis || {};
  var act = p.actuals || {};
  switch (col) {
    case 'label': return (p.label || '').toLowerCase();
    case 'health': var cm = {'underpriced_high_occ':1,'possibly_underpriced':2,'overpriced_low_occ':3,'well_priced':4}; return p.rate_context ? (cm[p.rate_context.classification] || 5) : 6;
    case 'pl_base': return pl.base || null;
    case 'pl_min': return pl.min || null;
    case 'pl_max': return pl.max || null;
    case 'actual_adr': return act.adr || null;
    case 'actual_occ': return act.occ || null;
    case 'mkt_occ': return pl.mkt_occ_30d ? parseFloat(pl.mkt_occ_30d) * 100 : null;
    case 'rev_3mo': return act.rev_3mo || null;
    case 'cleaning': return p.cleaning_fee || null;
    case 'pet_fee': return p.pet_fee || null;
    case 'extra_guest': return p.extra_guest_fee || null;
    case 'min_nights': var _gs = p.guesty_settings || {}; return _gs.min_nights || (p.calendar_min_nights ? p.calendar_min_nights.min : null) || (ai.min_nights || null);
    case 'age': return _analysisAge(p);
    default: return null;
  }
}

function _analysisAge(p) {
  if (!p.latest_analysis || !p.latest_analysis.date) return 9999;
  return Math.floor((new Date() - new Date(p.latest_analysis.date)) / 86400000);
}

function _poKpi(label, value, icon, color) {
  return '<div style="background:var(--bg2);border-radius:10px;padding:12px 14px;border:1px solid var(--border);">'
    + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">'
    + _ico(icon, 14, color) + '<span style="font-size:0.68rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.4px;">' + label + '</span></div>'
    + '<div style="font-size:1.3rem;font-weight:700;color:var(--text1);font-variant-numeric:tabular-nums;">' + value + '</div></div>';
}

function _poCell(val) {
  var display = _$(val);
  return '<td style="padding:7px 6px;text-align:right;font-variant-numeric:tabular-nums;">' + display + '</td>';
}

function _$(val) {
  if (val === null || val === undefined || val === 0) return '<span style="color:var(--text3);">—</span>';
  return '$' + (typeof val === 'number' ? val.toLocaleString(undefined, {maximumFractionDigits:0}) : val);
}

function _timeAgo(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr);
  var now = new Date();
  var diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 7) return diff + 'd ago';
  if (diff < 30) return Math.floor(diff / 7) + 'w ago';
  if (diff < 365) return Math.floor(diff / 30) + 'mo ago';
  return Math.floor(diff / 365) + 'y ago';
}

// ── Pricing Health Check ─────────────────────────────────────────────────────
async function _runReanalyzeAll() {
  if (!confirm('Re-run unified AI pricing analysis on ALL active properties?\n\nThis will use AI API credits for each property (~$0.02-0.05 each). Properties are analyzed sequentially.')) return;
  var container = document.getElementById('pricingOverviewContent');
  if (!container) return;
  var oldHtml = container.innerHTML;
  container.innerHTML = '<div style="text-align:center;padding:30px;"><div class="spinner"></div><p style="color:var(--text3);margin-top:12px;">Running unified analysis on all properties... This may take a few minutes.</p></div>';
  try {
    var d = await api('/api/analyze/bulk', 'POST', { analysis_type: 'str', quality: 'standard', max: 20, reanalyze_all: true });
    var h = '<div class="card" style="padding:16px;margin-bottom:16px;">';
    h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">';
    h += _ico('zap', 20, 'var(--accent)');
    h += '<h3 style="margin:0;font-size:1rem;">Bulk Re-Analysis Results</h3>';
    h += '<div style="flex:1;"></div>';
    h += '<button class="btn btn-xs" onclick="_pricingOverviewCache=null;loadPricingOverview(true);">← Back to Overview</button>';
    h += '</div>';
    h += '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">';
    h += '<span class="badge" style="background:#f0fdf4;color:#16a34a;padding:6px 12px;">' + _ico('check', 13) + ' ' + (d.analyzed || 0) + ' analyzed</span>';
    if ((d.failed || 0) > 0) h += '<span class="badge" style="background:#fef2f2;color:#dc2626;padding:6px 12px;">' + _ico('alertTriangle', 13) + ' ' + d.failed + ' failed</span>';
    h += '<span class="badge" style="background:var(--bg2);padding:6px 12px;">' + (d.total || 0) + ' total</span>';
    h += '</div>';
    if (d.results && d.results.length > 0) {
      h += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
      h += '<thead><tr style="background:var(--bg2);border-bottom:2px solid var(--border);"><th style="padding:7px 8px;text-align:left;">Property</th><th style="padding:7px 8px;text-align:center;">Status</th><th style="padding:7px 8px;text-align:left;">Details</th></tr></thead><tbody>';
      d.results.forEach(function(r) {
        var statusColor = r.status === 'ok' ? 'var(--accent)' : 'var(--danger)';
        var statusIcon = r.status === 'ok' ? _ico('check', 13, statusColor) : _ico('x', 13, statusColor);
        h += '<tr style="border-bottom:1px solid var(--border);">';
        h += '<td style="padding:6px 8px;">' + esc(r.label || 'Property #' + r.id) + '</td>';
        h += '<td style="padding:6px 8px;text-align:center;">' + statusIcon + '</td>';
        h += '<td style="padding:6px 8px;color:var(--text3);">' + (r.status === 'ok' ? r.strategies + ' strategies' : esc(r.error || r.status)) + '</td>';
        h += '</tr>';
      });
      h += '</tbody></table>';
    }
    h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:10px;">' + esc(d.message || '') + '</div>';
    h += '</div>';
    container.innerHTML = h;
  } catch (err) {
    container.innerHTML = oldHtml;
    toast('Bulk re-analysis failed: ' + err.message, 'error');
  }
}

async function _runPricingHealthCheck() {
  var container = document.getElementById('pricingOverviewContent');
  if (!container) return;
  var oldHtml = container.innerHTML;
  container.innerHTML = '<div style="text-align:center;padding:30px;"><div class="spinner"></div><p style="color:var(--text3);margin-top:12px;">Running pricing health check across all properties...</p></div>';
  try {
    var d = await api('/api/pricing/health-check', 'POST', {});
    var h = '<div class="card" style="padding:16px;margin-bottom:16px;">';
    h += '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">';
    h += _ico('heartPulse',20,'var(--accent)');
    h += '<h3 style="margin:0;font-size:1rem;">Pricing Health Check Results</h3>';
    h += '<div style="flex:1;"></div>';
    h += '<button class="btn btn-xs" onclick="renderPricingOverview(_pricingOverviewCache,document.getElementById(\'pricingOverviewContent\'));">← Back to Overview</button>';
    h += '</div>';

    // Summary badges
    h += '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">';
    h += '<span class="badge" style="background:var(--bg2);padding:6px 12px;">' + _ico('home',13) + ' ' + (d.checked||0) + ' checked</span>';
    if ((d.divergent||0) > 0) h += '<span class="badge" style="background:#fef2f2;color:#dc2626;padding:6px 12px;">' + _ico('alertTriangle',13) + ' ' + d.divergent + ' divergent</span>';
    h += '<span class="badge" style="background:#f0fdf4;color:#16a34a;padding:6px 12px;">' + _ico('check',13) + ' ' + (d.healthy||0) + ' healthy</span>';
    h += '</div>';

    // Property details table
    var checks = d.checks || [];
    if (checks.length > 0) {
      h += '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
      h += '<thead><tr style="background:var(--bg2);border-bottom:2px solid var(--border);">';
      h += '<th style="padding:7px 8px;text-align:left;">Property</th>';
      h += '<th style="padding:7px 8px;text-align:center;">Status</th>';
      h += '<th style="padding:7px 8px;text-align:left;">Issues</th></tr></thead><tbody>';
      // Sort: divergent first, then warning, then healthy
      var order = {divergent:0, error:1, warning:2, healthy:3};
      checks.sort(function(a,b) { return (order[a.severity]||9) - (order[b.severity]||9); });
      checks.forEach(function(c) {
        var sevColor = c.severity === 'divergent' ? '#dc2626' : c.severity === 'warning' ? '#f59e0b' : c.severity === 'error' ? '#ef4444' : '#16a34a';
        var sevIcon = c.severity === 'divergent' ? 'alertTriangle' : c.severity === 'warning' ? 'clock' : c.severity === 'error' ? 'xCircle' : 'check';
        h += '<tr style="border-bottom:1px solid var(--border);">';
        h += '<td style="padding:7px 8px;"><a href="#" onclick="showPropertyDetail(' + c.id + ');return false;" style="color:var(--accent);">' + esc(c.label) + '</a></td>';
        h += '<td style="padding:7px 8px;text-align:center;">';
        h += '<span style="color:' + sevColor + ';font-weight:600;font-size:0.72rem;text-transform:uppercase;">' + _ico(sevIcon,12,sevColor) + ' ' + esc(c.severity) + '</span></td>';
        h += '<td style="padding:7px 8px;">';
        if (c.issues && c.issues.length > 0) {
          c.issues.forEach(function(iss) {
            var issColor = ['pl_ai_divergence','adr_below_set','no_analysis'].indexOf(iss.type) >= 0 ? '#dc2626' : '#92400e';
            h += '<div style="font-size:0.72rem;color:' + issColor + ';margin-bottom:2px;">' + _ico('chevronRight',10,issColor) + ' ' + esc(iss.detail) + '</div>';
          });
        } else {
          h += '<span style="color:var(--text3);font-size:0.72rem;">No issues detected</span>';
        }
        h += '</td></tr>';
      });
      h += '</tbody></table>';
    }
    h += '</div>';
    container.innerHTML = h;
  } catch (err) {
    container.innerHTML = oldHtml;
    toast('Health check failed: ' + err.message, 'danger');
  }
}
