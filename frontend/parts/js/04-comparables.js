function onCompPropertyChange() {
  var pid = document.getElementById('compPropertySelect').value;
  if (pid) loadPropertyComps(pid);
}

async function loadComparables() {
  if (properties.length === 0) await loadProperties();
  var sel = document.getElementById('compPropertySelect');
  if (sel) {
    sel.innerHTML = '<option value="">-- Select property --</option>' +
      properties.map(function(p) { return '<option value="' + p.id + '">' + esc(getPropertyLabel(p)) + '</option>'; }).join('');
  }
  if (sel && sel.value) loadPropertyComps(sel.value);
}

async function loadPropertyComps(pid) {
  try {
    var d = await api('/api/properties/' + pid + '/comparables');
    var allComps = d.comparables || [];
    var isSTR = compType !== 'ltr';

    // Filter by type
    var comps = allComps.filter(function(c) {
      if (isSTR) return c.comp_type === 'str' || (!c.comp_type && c.nightly_rate < 1000);
      return c.comp_type === 'ltr' || (!c.comp_type && c.nightly_rate >= 500);
    });

    if (comps.length === 0) {
      var emptyMsg = isSTR
        ? 'No STR comps yet. Click "Find Comps" to search, or add real comps from Airbnb/VRBO with "+ Manual".'
        : 'No LTR comps yet. Click "Find Comps" to pull listings and estimates, or add comps from Zillow/Apartments.com with "+ Manual".';
      document.getElementById('compList').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">' + emptyMsg + '</p>';
      document.getElementById('compMap').style.display = 'none';
      return;
    }

    var rateLabel = isSTR ? 'Nightly' : 'Monthly';
    var h = '';

    // Separate platform comps from estimates
    var platformComps = comps.filter(function(c) { return !c.source || (!c.source.includes('Estimate') && c.source !== 'Estimated (LTR→STR)'); });
    var estComps = comps.filter(function(c) { return c.source && (c.source.includes('Estimate') || c.source === 'Estimated (LTR→STR)'); });

    // ── High / Low / Market estimate card ──
    if (estComps.length > 0) {
      var estRates = estComps.map(function(c) { return c.nightly_rate || 0; }).filter(function(r) { return r > 0; }).sort(function(a, b) { return a - b; });
      if (estRates.length >= 2) {
        var estLow = estRates[0];
        var estHigh = estRates[estRates.length - 1];
        var estMid = estRates.length >= 3 ? estRates[Math.floor(estRates.length / 2)] : Math.round((estLow + estHigh) / 2);
        h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
        h += '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:8px;">ESTIMATED ' + (isSTR ? 'NIGHTLY' : 'MONTHLY') + ' RANGE</label>';
        h += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;text-align:center;">';
        h += '<div><div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px;">Low</div><div style="font-size:1.2rem;font-weight:700;color:var(--text2);font-family:\'DM Mono\',monospace;">$' + Math.round(estLow).toLocaleString() + '</div></div>';
        h += '<div style="background:var(--accent-dim);border-radius:6px;padding:4px 0;"><div style="font-size:0.72rem;color:var(--accent);margin-bottom:2px;">Market</div><div style="font-size:1.3rem;font-weight:700;color:var(--accent);font-family:\'DM Mono\',monospace;">$' + Math.round(estMid).toLocaleString() + '</div></div>';
        h += '<div><div style="font-size:0.72rem;color:var(--text3);margin-bottom:2px;">High</div><div style="font-size:1.2rem;font-weight:700;color:var(--text2);font-family:\'DM Mono\',monospace;">$' + Math.round(estHigh).toLocaleString() + '</div></div>';
        h += '</div>';
        h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;text-align:center;">' + (isSTR ? 'per night' : 'per month') + ' · Based on ' + (platformComps.length > 0 ? platformComps.length + ' area comps + ' : '') + 'regional data</div>';
        h += '</div>';
      }
    }

    // ── Platform comps table ──
    if (platformComps.length > 0) {
      h += '<div style="margin-bottom:14px;">';
      var sourceLabel = isSTR ? 'PLATFORM COMPS' : 'RENTAL LISTINGS';
      var sourceSummary = {};
      platformComps.forEach(function(c) { var s = c.source || 'Unknown'; sourceSummary[s] = (sourceSummary[s] || 0) + 1; });
      var sourceNames = Object.keys(sourceSummary).map(function(s) { return formatCompSource(s) + ' (' + sourceSummary[s] + ')'; }).join(' · ');
      h += '<label style="font-size:0.78rem;color:var(--accent);display:block;margin-bottom:6px;">' + sourceLabel + ' (' + platformComps.length + ')</label>';
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:6px;">Sources: ' + sourceNames + '</div>';
      h += buildCompTable(platformComps, rateLabel);
      h += '</div>';
    }

    // ── Estimate detail table (collapsed by default) ──
    if (estComps.length > 0) {
      h += '<div style="margin-bottom:14px;">';
      h += '<label style="font-size:0.78rem;color:var(--text3);display:block;margin-bottom:6px;">' + (isSTR ? 'ESTIMATED STR RATES' : 'ESTIMATED RENT RANGE') + '</label>';
      h += buildCompTable(estComps, rateLabel);
      if (platformComps.length === 0) {
        h += '<div style="padding:10px 14px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.25);border-radius:8px;font-size:0.82rem;color:var(--text2);margin-top:8px;">';
        h += '⚠ These are <strong>estimated</strong> rates based on regional data. Add real comps from ' + (isSTR ? 'Airbnb/VRBO/Booking.com' : 'Zillow/Apartments.com/Realtor.com') + ' using "+ Manual" or the search links for more accurate pricing.';
        h += '</div>';
      }
      h += '</div>';
    }

    // Summary stats from platform comps (not estimates)
    var statComps = platformComps.length > 0 ? platformComps : comps;
    var rates = statComps.map(function(c) { return c.nightly_rate || 0; }).filter(function(r) { return r > 0; });
    if (rates.length > 0) {
      var avg = Math.round(rates.reduce(function(a, b) { return a + b; }, 0) / rates.length);
      var minR = Math.min.apply(null, rates);
      var maxR = Math.max.apply(null, rates);
      var sorted = rates.slice().sort(function(a, b) { return a - b; });
      var med = sorted[Math.floor(sorted.length / 2)];
      h = '<div class="market-grid" style="margin-bottom:14px;">' +
        '<div class="market-stat"><div class="val">$' + med.toLocaleString() + '</div><div class="lbl">Median ' + rateLabel + '</div></div>' +
        '<div class="market-stat"><div class="val">$' + avg.toLocaleString() + '</div><div class="lbl">Avg ' + rateLabel + '</div></div>' +
        '<div class="market-stat"><div class="val">$' + minR.toLocaleString() + ' - $' + maxR.toLocaleString() + '</div><div class="lbl">Range</div></div>' +
        '<div class="market-stat"><div class="val">' + comps.length + '</div><div class="lbl">' + (isSTR ? 'STR' : 'LTR') + ' Comps</div></div>' +
        '</div>' + h;
    }

    document.getElementById('compList').innerHTML = h;
    document.getElementById('compMap').style.display = 'none';
  } catch (err) { toast(err.message, 'error'); }
}

function buildCompTable(comps, rateLabel) {
  var h = '<table class="comp-table"><thead><tr><th>Listing</th><th>Beds/Bath</th><th>' + rateLabel + '</th><th>Clean</th><th>Rating</th><th>Source</th></tr></thead><tbody>';
  comps.forEach(function(c) {
    var ratingStr = c.rating ? c.rating + '★' + (c.review_count ? ' (' + c.review_count + ')' : '') : '—';
    var sourceDisplay = formatCompSource(c.source);
    h += '<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc((c.title || 'Listing').substring(0, 45)) + '</td>' +
      '<td>' + (c.bedrooms || '?') + '/' + (c.bathrooms || '?') + '</td>' +
      '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">$' + (c.nightly_rate || 0).toLocaleString() + '</td>' +
      '<td>' + (c.cleaning_fee ? '$' + c.cleaning_fee : '—') + '</td>' +
      '<td>' + ratingStr + '</td>' +
      '<td>' + (c.source_url ? '<a href="' + esc(c.source_url) + '" target="_blank" style="color:var(--accent);">' + sourceDisplay + '</a>' : sourceDisplay) + '</td></tr>';
  });
  h += '</tbody></table>';
  return h;
}

function formatCompSource(source) {
  if (!source) return '';
  var s = source.toLowerCase();
  if (s.includes('airbnb')) return '🏡 Airbnb';
  if (s.includes('vrbo')) return '🏖️ VRBO';
  if (s.includes('booking')) return '📘 Booking';
  if (s.includes('furnished')) return '🛋️ Furnished Finder';
  if (s === 'estimated (ltr→str)') return '📊 STR Estimate';
  if (s.includes('estimate (low)')) return '📉 Low Estimate';
  if (s.includes('estimate (market)')) return '📊 Market Estimate';
  if (s.includes('estimate (high)')) return '📈 High Estimate';
  if (s.includes('estimate')) return '📊 Estimate';
  if (s.includes('rentcast')) return '🔑 RentCast';
  if (s.includes('zillow')) return '🏠 Zillow';
  if (s.includes('apartments')) return '🏢 Apartments.com';
  if (s.includes('realtor')) return '📋 Realtor.com';
  if (s.includes('rent.com')) return '🔑 Rent.com';
  if (s.includes('redfin')) return '📊 Redfin';
  if (s.includes('hotpads')) return '📍 HotPads';
  return esc(source);
}

async function fetchCompsFromAPI() {
  var pid = document.getElementById('compPropertySelect').value;
  if (!pid) { toast('Select a property first', 'error'); return; }
  var isSTR = compType !== 'ltr';
  var statusEl = document.getElementById('compFetchStatus');
  if (statusEl) statusEl.textContent = 'Searching for ' + (isSTR ? 'short-term' : 'long-term') + ' comps...';
  showLoading('Finding comparable listings...');
  try {
    var d = await api('/api/comparables/fetch', 'POST', { property_id: parseInt(pid), comp_type: compType, use_ai: compAiEnabled });
    var msg = d.message || 'Done';
    var srcHtml = '<div style="margin-top:6px;">';
    (d.sources || []).forEach(function(s) {
      var icon = s.status === 'ok' ? '✓' : s.status === 'skip' ? '∅' : s.status === 'limit' ? '⚠' : s.status === 'info' ? 'ℹ' : '✗';
      var color = s.status === 'ok' ? 'var(--accent)' : s.status === 'limit' ? '#fbbf24' : s.status === 'info' ? 'var(--blue,#60a5fa)' : 'var(--text3)';
      srcHtml += '<div style="font-size:0.78rem;color:' + color + ';">' + icon + ' ' + esc(s.name) + (s.detail ? ' — ' + esc(s.detail).substring(0, 150) : '') + '</div>';
    });
    srcHtml += '</div>';
    if (statusEl) statusEl.innerHTML = esc(msg) + srcHtml;

    // AI analysis
    var aiSource = (d.sources || []).find(function(s) { return s.name === 'AI Analysis' && s.status === 'ok'; });
    if (aiSource && aiSource.detail) {
      statusEl.innerHTML += '<div style="margin-top:10px;padding:12px;background:var(--purple-dim);border:1px solid rgba(167,139,250,0.25);border-radius:8px;color:var(--text);font-size:0.85rem;line-height:1.55;"><strong style="color:var(--purple);">✦ AI Analysis:</strong> ' + esc(aiSource.detail) + '</div>';
    }

    // Search links
    if (d.searchLinks && d.searchLinks.length > 0) {
      var linkHtml = '<div style="margin-top:12px;">';
      linkHtml += '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:6px;">' + (isSTR ? 'SEARCH STR PLATFORMS — add real comps from these:' : 'SEARCH LTR PLATFORMS:') + '</label>';
      linkHtml += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
      d.searchLinks.forEach(function(l) {
        linkHtml += '<a href="' + esc(l.url) + '" target="_blank" style="display:inline-flex;align-items:center;gap:4px;padding:6px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;text-decoration:none;color:var(--text);font-size:0.82rem;transition:border-color 0.15s;" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">' + (l.icon || '🔗') + ' ' + esc(l.name) + ' →</a>';
      });
      linkHtml += '</div></div>';
      statusEl.innerHTML += linkHtml;
    }

    toast(d.message || 'Comps loaded');
    await loadPropertyComps(pid);
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    toast(err.message, 'error');
  }
  hideLoading();
}

async function saveComparable() {
  var isSTR = compType !== 'ltr';
  const body = {
    property_id: document.getElementById('c_property').value,
    comp_type: isSTR ? 'str' : 'ltr',
    source: document.getElementById('c_source').value,
    source_url: document.getElementById('c_url').value,
    title: document.getElementById('c_title').value,
    host_name: document.getElementById('c_host').value,
    bedrooms: parseInt(document.getElementById('c_beds').value) || null,
    bathrooms: parseFloat(document.getElementById('c_baths').value) || null,
    sleeps: parseInt(document.getElementById('c_sleeps').value) || null,
    nightly_rate: parseFloat(document.getElementById('c_rate').value) || 0,
    cleaning_fee: parseFloat(document.getElementById('c_clean').value) || 0,
    rating: parseFloat(document.getElementById('c_rating').value) || null,
    review_count: parseInt(document.getElementById('c_reviews').value) || 0,
  };
  if (!body.source || !body.nightly_rate) { toast('Source and rate required', 'error'); return; }
  try { await api('/api/comparables', 'POST', body); toast('Comparable added'); toggleCompForm(); var sel = document.getElementById('compPropertySelect'); if (sel && sel.value) loadPropertyComps(sel.value); }
  catch (err) { toast(err.message, 'error'); }
}

async function parseCompUrl() {
  var urlInput = document.getElementById('c_paste_url');
  var url = (urlInput ? urlInput.value : '').trim();
  if (!url) { toast('Paste a listing URL first', 'error'); return; }
  if (!url.startsWith('http')) url = 'https://' + url;

  var statusEl = document.getElementById('parseUrlStatus');
  var btn = document.getElementById('parseUrlBtn');
  if (statusEl) { statusEl.style.display = ''; statusEl.innerHTML = '<span style="color:var(--text3);">Parsing URL...</span>'; }
  if (btn) { btn.disabled = true; btn.textContent = 'Parsing...'; }

  try {
    var d = await api('/api/comparables/parse-url', 'POST', { url: url });

    // Auto-fill form fields
    if (d.source) {
      var srcSel = document.getElementById('c_source');
      var options = srcSel ? Array.from(srcSel.options) : [];
      var match = options.find(function(o) { return o.value === d.source; });
      if (match) srcSel.value = d.source;
      else srcSel.value = 'Other';
    }
    if (d.source_url) document.getElementById('c_url').value = d.source_url;
    if (d.title) document.getElementById('c_title').value = d.title;
    if (d.host_name) document.getElementById('c_host').value = d.host_name;
    if (d.bedrooms) document.getElementById('c_beds').value = d.bedrooms;
    if (d.bathrooms) document.getElementById('c_baths').value = d.bathrooms;
    if (d.sleeps) document.getElementById('c_sleeps').value = d.sleeps;
    if (d.nightly_rate) document.getElementById('c_rate').value = d.nightly_rate;
    if (d.cleaning_fee) document.getElementById('c_clean').value = d.cleaning_fee;
    if (d.rating) document.getElementById('c_rating').value = d.rating;
    if (d.review_count) document.getElementById('c_reviews').value = d.review_count;

    // Status message
    var filled = [];
    if (d.title) filled.push('title');
    if (d.bedrooms) filled.push('beds');
    if (d.nightly_rate) filled.push('rate');
    if (d.rating) filled.push('rating');
    var statusMsg = '✓ Detected ' + esc(d.source) + '. ';
    if (d.ai_extracted) statusMsg += 'AI extracted: ' + filled.join(', ') + '. ';
    else if (filled.length > 0) statusMsg += 'Found: ' + filled.join(', ') + '. ';
    statusMsg += 'Review and fill in any missing fields, then click Save.';
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent);">' + statusMsg + '</span>';
    toast('URL parsed — ' + d.source + ' detected', 'success');
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">Failed: ' + esc(err.message) + '. Fill in fields manually.</span>';
    toast(err.message, 'error');
    // At minimum set the URL field
    document.getElementById('c_url').value = url;
    // Auto-detect source from URL
    var lower = url.toLowerCase();
    if (lower.includes('airbnb')) document.getElementById('c_source').value = 'Airbnb';
    else if (lower.includes('vrbo') || lower.includes('homeaway')) document.getElementById('c_source').value = 'VRBO';
    else if (lower.includes('booking.com')) document.getElementById('c_source').value = 'Booking.com';
    else if (lower.includes('zillow')) document.getElementById('c_source').value = 'Zillow';
    else if (lower.includes('furnished')) document.getElementById('c_source').value = 'Furnished Finder';
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Parse URL'; }
}

// Google Places Autocomplete
