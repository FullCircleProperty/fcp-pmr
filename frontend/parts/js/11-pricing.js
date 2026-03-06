// Platform Pricing Comparison
let pricingPropertyId = null;
let pricingEditId = null;

var PLAT_ICONS = { direct: '🏠', airbnb: '🏡', vrbo: '🏖️', booking: '📘', furnished_finder: '🛋️' };
var PLAT_NAMES = { direct: 'Direct Booking', airbnb: 'Airbnb', vrbo: 'VRBO', booking: 'Booking.com', furnished_finder: 'Furnished Finder' };
var PLAT_COLORS = { direct: '#10b981', airbnb: '#ff5a5f', vrbo: '#3b82f6', booking: '#003b95', furnished_finder: '#f59e0b' };

function loadPricingView() {
  var sel = document.getElementById('pricingPropertySelect');
  if (!sel) return;
  // Set default checkin to 2 weeks from now
  var checkinEl = document.getElementById('pricingCheckin');
  if (checkinEl && !checkinEl.value) {
    var d14 = new Date(Date.now() + 14 * 86400000);
    checkinEl.value = d14.toISOString().split('T')[0];
  }
  sel.innerHTML = '<option value="">-- Select Property --</option>';
  properties.forEach(function(p) {
    if (p.parent_id && !p.unit_number) return;
    var label = getPropertyLabel(p) + ' (' + (p.city || '') + ', ' + (p.state || '') + ')';
    sel.innerHTML += '<option value="' + p.id + '"' + (pricingPropertyId == p.id ? ' selected' : '') + '>' + esc(label) + '</option>';
  });
  if (pricingPropertyId) loadPlatformList();
}

function onPricingPropertyChange() {
  var sel = document.getElementById('pricingPropertySelect');
  pricingPropertyId = sel ? sel.value : null;
  document.getElementById('pricingResults').style.display = 'none';
  if (pricingPropertyId) loadPlatformList();
  else document.getElementById('platformList').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Select a property to manage platform listings.</p>';
}

async function loadPlatformList() {
  if (!pricingPropertyId) return;
  try {
    var d = await api('/api/properties/' + pricingPropertyId + '/platforms');
    var plats = d.platforms || [];
    if (plats.length === 0) {
      document.getElementById('platformList').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No platforms linked yet. Click "+ Add Platform" to connect your listings.</p>';
      return;
    }
    var hasUrls = plats.some(function(p) { return !!p.listing_url; });
    var h = '';
    if (hasUrls) {
      h += '<div style="display:flex;justify-content:flex-end;margin-bottom:8px;">';
      h += '<button class="btn btn-xs btn-purple" onclick="scrapeAllPlatforms()" id="scrapeAllBtn">🔄 Scrape All Pricing</button>';
      h += '</div>';
    }
    h += '<table class="comp-table"><thead><tr><th>Platform</th><th>Listing URL</th><th>Nightly</th><th>Cleaning</th><th>Rating</th><th>Reviews</th><th>Last Scraped</th><th></th></tr></thead><tbody>';
    plats.forEach(function(p) {
      var icon = PLAT_ICONS[p.platform] || '📋';
      var name = PLAT_NAMES[p.platform] || p.platform;
      var color = PLAT_COLORS[p.platform] || 'var(--text)';
      var urlShort = p.listing_url ? p.listing_url.replace(/^https?:\/\/(www\.)?/, '').substring(0, 45) + (p.listing_url.length > 55 ? '...' : '') : '';
      var link = p.listing_url ? '<a href="' + esc(p.listing_url) + '" target="_blank" style="color:var(--text2);font-size:0.78rem;">' + esc(urlShort) + '</a>' : '<span style="color:var(--text3);font-size:0.78rem;">No URL</span>';
      h += '<tr><td style="color:' + color + ';font-weight:600;white-space:nowrap;">' + icon + ' ' + esc(name) + '</td>';
      h += '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;">' + link + '</td>';
      h += '<td style="font-family:DM Mono,monospace;font-weight:600;">' + (p.nightly_rate ? '$' + Math.round(p.nightly_rate) : '<span style="color:var(--text3);">—</span>') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (p.cleaning_fee > 0 ? '$' + Math.round(p.cleaning_fee) : '—') + '</td>';
      h += '<td>' + (p.rating ? Number(p.rating).toFixed(1) + '★' : '—') + '</td>';
      h += '<td style="font-size:0.78rem;">' + (p.review_count > 0 ? p.review_count : '—') + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">' + (p.last_scraped ? p.last_scraped.substring(0, 10) : '<span style="color:var(--warn);">never</span>') + '</td>';
      h += '<td style="white-space:nowrap;"><button class="btn btn-xs" onclick="editPlatform(' + p.id + ')" title="Edit URL">✎</button> <button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);" onclick="deletePlatform(' + p.id + ')" title="Delete">✗</button></td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('platformList').innerHTML = h;
  } catch (err) {
    document.getElementById('platformList').innerHTML = '<p style="color:var(--danger);">' + esc(err.message) + '</p>';
  }
}

async function scrapeAllPlatforms() {
  if (!pricingPropertyId) return;
  var btn = document.getElementById('scrapeAllBtn');
  if (btn) btn.textContent = '⏳ Scraping...';
  showLoading('Scraping platform pricing...');
  try {
    var d = await api('/api/properties/' + pricingPropertyId + '/platforms/scrape', 'POST');
    toast(d.message || 'Done');
    // Show results
    var results = d.results || [];
    var ok = results.filter(function(r) { return r.status === 'ok'; });
    var fail = results.filter(function(r) { return r.status !== 'ok' && r.status !== 'skip'; });
    if (fail.length > 0) {
      var failMsg = fail.map(function(r) { return r.platform + ': ' + (r.detail || 'no data found'); }).join(', ');
      toast('Some platforms had no data: ' + failMsg, 'error');
    }
    loadPlatformList();
  } catch (err) {
    toast(err.message, 'error');
  }
  if (btn) btn.textContent = '🔄 Scrape All Pricing';
  hideLoading();
}

function togglePlatformForm() {
  var form = document.getElementById('addPlatformForm');
  form.style.display = form.style.display === 'none' ? '' : 'none';
  pricingEditId = null;
}

async function savePlatform() {
  if (!pricingPropertyId) { toast('Select a property first', 'error'); return; }
  var platform = document.getElementById('pp_platform').value;
  var url = document.getElementById('pp_url').value.trim() || null;
  // Default fee structures per platform
  var defaults = { direct: { h: 0, g: 0 }, airbnb: { h: 3, g: 14.2 }, vrbo: { h: 5, g: 12 }, booking: { h: 15, g: 0 }, furnished_finder: { h: 0, g: 0 } };
  var d = defaults[platform] || { h: 0, g: 0 };
  var data = {
    platform: platform,
    listing_url: url,
    platform_fee_pct: d.h,
    guest_fee_pct: d.g,
  };
  try {
    if (pricingEditId) {
      await api('/api/properties/' + pricingPropertyId + '/platforms/' + pricingEditId, 'PUT', data);
      toast('Platform updated');
    } else {
      await api('/api/properties/' + pricingPropertyId + '/platforms', 'POST', data);
      toast('Platform added');
    }
    togglePlatformForm();
    loadPlatformList();
  } catch (err) { toast(err.message, 'error'); }
}

async function editPlatform(id) {
  try {
    var d = await api('/api/properties/' + pricingPropertyId + '/platforms');
    var p = (d.platforms || []).find(function(x) { return x.id === id; });
    if (!p) return;
    pricingEditId = id;
    document.getElementById('addPlatformForm').style.display = '';
    document.getElementById('pp_platform').value = p.platform;
    document.getElementById('pp_url').value = p.listing_url || '';
  } catch {}
}

async function deletePlatform(id) {
  if (!confirm('Remove this platform?')) return;
  try {
    await api('/api/properties/' + pricingPropertyId + '/platforms/' + id, 'DELETE');
    toast('Platform removed');
    loadPlatformList();
  } catch (err) { toast(err.message, 'error'); }
}

async function scrapePlatforms() {
  if (!pricingPropertyId) { toast('Select a property', 'error'); return; }
  document.getElementById('pricingStatus').innerHTML = '🔄 Scraping platform URLs...';
  showLoading('Scraping platforms...');
  try {
    var d = await api('/api/properties/' + pricingPropertyId + '/platforms/scrape', 'POST');
    document.getElementById('pricingStatus').innerHTML = '<span style="color:var(--accent);">✓ ' + esc(d.message || 'Done') + '</span>';
    toast(d.message || 'Scraped');
    loadPlatformList();
  } catch (err) {
    document.getElementById('pricingStatus').innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  hideLoading();
}

async function runPricingComparison() {
  if (!pricingPropertyId) { toast('Select a property', 'error'); return; }
  var nights = parseInt(document.getElementById('pricingNights').value) || 3;
  var guests = parseInt(document.getElementById('pricingGuests').value) || 2;
  var checkinEl = document.getElementById('pricingCheckin');
  var checkin = checkinEl && checkinEl.value ? checkinEl.value : null;

  // Default checkin to 2 weeks from now if not set
  if (!checkin) {
    var d14 = new Date(Date.now() + 14 * 86400000);
    checkin = d14.toISOString().split('T')[0];
    if (checkinEl) checkinEl.value = checkin;
  }

  document.getElementById('pricingStatus').innerHTML = '⏳ Running comparison...';
  showLoading('Analyzing pricing...');
  try {
    var d = await api('/api/properties/' + pricingPropertyId + '/platforms/compare', 'POST', { nights: nights, guests: guests, checkin: checkin });
    document.getElementById('pricingResults').style.display = '';
    document.getElementById('pricingStatus').innerHTML = '';

    // Show dates used
    var cin = d.checkin || checkin;
    var cout = d.checkout || new Date(new Date(cin).getTime() + nights * 86400000).toISOString().split('T')[0];
    var cinDate = new Date(cin + 'T12:00:00');
    var coutDate = new Date(cout + 'T12:00:00');
    var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var monNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var cinLabel = dayNames[cinDate.getDay()] + ' ' + monNames[cinDate.getMonth()] + ' ' + cinDate.getDate();
    var coutLabel = dayNames[coutDate.getDay()] + ' ' + monNames[coutDate.getMonth()] + ' ' + coutDate.getDate();
    document.getElementById('pricingNightsLabel').innerHTML = '📅 <strong>' + cinLabel + ' → ' + coutLabel + '</strong> (' + nights + ' nights, ' + guests + ' guests)';

    renderGuestCostTable(d.comparison, nights);
    // Show scrape results summary
    if (d.scrape_results) {
      var ok = d.scrape_results.filter(function(r) { return r.status === 'ok'; });
      var nodata = d.scrape_results.filter(function(r) { return r.status === 'no_data' || r.status === 'error'; });
      var scrapeHtml = '<div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;font-size:0.78rem;';
      if (nodata.length > 0 && ok.length === 0) {
        scrapeHtml += 'background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:var(--warn);">';
        scrapeHtml += '⚠ Could not scrape pricing — using previously stored data. Make sure URLs are correct and SearchAPI key is configured.';
      } else if (nodata.length > 0) {
        scrapeHtml += 'background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:var(--text2);">';
        scrapeHtml += '✓ Scraped ' + ok.length + ' platform(s). ';
        scrapeHtml += nodata.map(function(r) { return '<strong>' + (PLAT_NAMES[r.platform] || r.platform) + '</strong>: no data'; }).join(', ');
      } else if (ok.length > 0) {
        scrapeHtml += 'background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);color:var(--accent);">';
        scrapeHtml += '✓ Live pricing scraped for all ' + ok.length + ' platform(s)';
      } else {
        scrapeHtml += 'background:var(--surface2);border:1px solid var(--border);color:var(--text3);">';
        scrapeHtml += 'No URLs to scrape — showing manually entered data';
      }
      scrapeHtml += '</div>';
      var ct = document.getElementById('pricingCompTable');
      if (ct) ct.insertAdjacentHTML('beforebegin', scrapeHtml);
    }
    // Refresh platform list to show updated scraped data
    loadPlatformList();
    // Show PriceLabs benchmark if available
    if (d.pricelabs && typeof renderPLBenchmark === 'function') {
      var benchHtml = renderPLBenchmark(d.pricelabs, d.comparison);
      if (benchHtml) {
        var ct = document.getElementById('pricingCompTable');
        if (ct) ct.insertAdjacentHTML('beforebegin', benchHtml);
      }
    }
    renderHostRevenueTable(d.comparison, nights);
    renderDiscountTable(d.comparison);
    renderPricingInsights(d.insights || []);
    renderPricingAi(d.ai_analysis);
    toast('Comparison complete');
  } catch (err) {
    document.getElementById('pricingStatus').innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  hideLoading();
}

function renderGuestCostTable(comps, nights) {
  if (!comps || comps.length === 0) { document.getElementById('pricingCompTable').innerHTML = '<p style="color:var(--text3);">No data</p>'; return; }
  var cheapest = comps.reduce(function(a, b) { return (a.total_guest_pays || Infinity) < (b.total_guest_pays || Infinity) ? a : b; });
  var hasPL = comps.some(function(c) { return c.pl_diff !== undefined; });
  var h = '<table class="comp-table"><thead><tr><th>Platform</th><th>' + nights + '× Nightly</th><th>Cleaning</th><th>Platform Fee</th><th>Guest Fee</th><th>Tax</th><th style="font-weight:700;">Total Guest Pays</th><th>Avg/Night</th>' + (hasPL ? '<th>vs PriceLabs</th>' : '') + '</tr></thead><tbody>';
  comps.forEach(function(c) {
    var icon = PLAT_ICONS[c.platform] || '📋';
    var color = PLAT_COLORS[c.platform] || 'var(--text)';
    var isCheapest = c.platform === cheapest.platform && c.total_guest_pays > 0;
    var rowStyle = isCheapest ? 'background:rgba(16,185,129,0.06);' : '';
    var badge = isCheapest ? ' <span style="font-size:0.65rem;background:var(--accent);color:var(--bg);padding:1px 5px;border-radius:3px;vertical-align:middle;">BEST</span>' : '';
    h += '<tr style="' + rowStyle + '"><td style="color:' + color + ';font-weight:600;">' + icon + ' ' + (PLAT_NAMES[c.platform] || c.platform) + badge + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">$' + (c.subtotal || 0) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (c.cleaning_fee > 0 ? '$' + c.cleaning_fee : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (c.platform_fee > 0 ? '$' + c.platform_fee : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (c.guest_fee > 0 ? '$' + c.guest_fee : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (c.tax_amount > 0 ? '$' + c.tax_amount : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;font-weight:700;font-size:1rem;color:' + color + ';">$' + (c.total_guest_pays || 0) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--text2);">$' + (c.avg_per_night || 0) + '</td>';
    if (hasPL) {
      if (c.pl_diff !== undefined && c.pl_diff !== null) {
        var plColor = c.pl_diff > 0 ? 'var(--danger)' : c.pl_diff < 0 ? 'var(--accent)' : 'var(--text3)';
        var plSign = c.pl_diff > 0 ? '+' : '';
        h += '<td style="font-family:DM Mono,monospace;color:' + plColor + ';font-size:0.82rem;">' + plSign + '$' + c.pl_diff + ' (' + plSign + c.pl_diff_pct + '%)</td>';
      } else {
        h += '<td>—</td>';
      }
    }
    h += '</tr>';
  });
  h += '</tbody></table>';
  document.getElementById('pricingCompTable').innerHTML = h;
}

function renderHostRevenueTable(comps, nights) {
  if (!comps || comps.length === 0) { document.getElementById('pricingHostTable').innerHTML = ''; return; }
  var best = comps.reduce(function(a, b) { return (a.host_payout || 0) > (b.host_payout || 0) ? a : b; });
  var h = '<table class="comp-table"><thead><tr><th>Platform</th><th>Gross (' + nights + ' nights)</th><th>Host Fee</th><th style="font-weight:700;">You Receive</th><th>Weekly Rate</th><th>Monthly Rate</th></tr></thead><tbody>';
  comps.forEach(function(c) {
    var icon = PLAT_ICONS[c.platform] || '📋';
    var color = PLAT_COLORS[c.platform] || 'var(--text)';
    var isBest = c.platform === best.platform && c.host_payout > 0;
    var rowStyle = isBest ? 'background:rgba(16,185,129,0.06);' : '';
    var badge = isBest ? ' <span style="font-size:0.65rem;background:var(--accent);color:var(--bg);padding:1px 5px;border-radius:3px;">BEST</span>' : '';
    var hostFee = c.subtotal > 0 ? Math.round(c.subtotal * c.host_fee_pct / 100) : 0;
    h += '<tr style="' + rowStyle + '"><td style="color:' + color + ';font-weight:600;">' + icon + ' ' + (PLAT_NAMES[c.platform] || c.platform) + badge + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">$' + ((c.subtotal || 0) + (c.cleaning_fee || 0)) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">-$' + hostFee + ' <span style="font-size:0.72rem;">(' + c.host_fee_pct + '%)</span></td>';
    h += '<td style="font-family:DM Mono,monospace;font-weight:700;font-size:1rem;color:var(--accent);">$' + (c.host_payout || 0) + badge + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (c.weekly_rate > 0 ? '$' + c.weekly_rate + (c.weekly_discount_pct > 0 ? ' <span style="color:var(--accent);font-size:0.72rem;">(-' + c.weekly_discount_pct + '%)</span>' : '') : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (c.monthly_rate > 0 ? '$' + c.monthly_rate + (c.monthly_discount_pct > 0 ? ' <span style="color:var(--accent);font-size:0.72rem;">(-' + c.monthly_discount_pct + '%)</span>' : '') : '—') + '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('pricingHostTable').innerHTML = h;
}

function renderDiscountTable(comps) {
  if (!comps || comps.length === 0) { document.getElementById('pricingDiscountTable').innerHTML = ''; return; }
  var h = '<table class="comp-table"><thead><tr><th>Platform</th><th>Min Nights</th><th>Weekly</th><th>Monthly</th><th>Last Minute</th><th>Early Bird</th><th>Cancel Policy</th><th>Instant Book</th></tr></thead><tbody>';
  comps.forEach(function(c) {
    var icon = PLAT_ICONS[c.platform] || '📋';
    var color = PLAT_COLORS[c.platform] || 'var(--text)';
    h += '<tr><td style="color:' + color + ';font-weight:600;">' + icon + ' ' + (PLAT_NAMES[c.platform] || c.platform) + '</td>';
    h += '<td style="text-align:center;">' + (c.min_nights || '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;text-align:center;">' + (c.weekly_discount_pct > 0 ? c.weekly_discount_pct + '%' : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;text-align:center;">' + (c.monthly_discount_pct > 0 ? c.monthly_discount_pct + '%' : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;text-align:center;">' + (c.last_minute_discount_pct > 0 ? c.last_minute_discount_pct + '%' : '—') + '</td>';
    h += '<td style="font-family:DM Mono,monospace;text-align:center;">' + (c.early_bird_discount_pct > 0 ? c.early_bird_discount_pct + '%' : '—') + '</td>';
    h += '<td style="text-align:center;">' + (c.cancellation_policy ? esc(c.cancellation_policy.replace('_', ' ')) : '—') + '</td>';
    h += '<td style="text-align:center;">' + (c.instant_book ? '✓' : '—') + '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('pricingDiscountTable').innerHTML = h;
}

function renderPricingInsights(insights) {
  if (!insights || insights.length === 0) { document.getElementById('pricingInsights').innerHTML = '<p style="color:var(--text3);">Add platform data to generate insights.</p>'; return; }
  var h = '';
  insights.forEach(function(i) {
    var bg = i.type === 'cost' ? 'rgba(16,185,129,0.06)' : i.type === 'revenue' ? 'rgba(59,130,246,0.06)' : i.type === 'parity' ? (i.icon === '⚠️' ? 'rgba(239,68,68,0.06)' : 'rgba(16,185,129,0.06)') : i.type === 'direct' ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)';
    h += '<div style="padding:10px 14px;margin-bottom:6px;border-radius:8px;background:' + bg + ';font-size:0.85rem;"><span style="margin-right:6px;">' + (i.icon || '📊') + '</span>' + esc(i.text) + '</div>';
  });
  document.getElementById('pricingInsights').innerHTML = h;
}

function renderPricingAi(text) {
  var card = document.getElementById('pricingAiCard');
  var el = document.getElementById('pricingAiAnalysis');
  if (!text) { if (card) card.style.display = 'none'; return; }
  if (card) card.style.display = '';
  el.innerHTML = '<div style="white-space:pre-wrap;font-size:0.85rem;line-height:1.6;color:var(--text);background:var(--bg);padding:14px;border-radius:8px;border:1px solid var(--border);">' + esc(text) + '</div>';
}

// Property Platforms (inside property editor)
var propPlatEditId = null;

async function loadPropertyPlatforms(propId) {
  var content = document.getElementById('propPlatformsContent');
  var list = document.getElementById('propPlatformsList');
  var search = document.getElementById('propPlatformSearch');
  var addArea = document.getElementById('propPlatformAdd');
  if (!propId) {
    if (content) content.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save the property first to manage platform links.</p>';
    if (list) list.innerHTML = '';
    if (search) search.style.display = 'none';
    return;
  }
  if (search) search.style.display = '';
  try {
    var d = await api('/api/properties/' + propId + '/platforms');
    var plats = d.platforms || [];
    if (content) content.innerHTML = '';
    if (plats.length === 0) {
      if (list) list.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;margin-bottom:10px;">No platforms linked. Use auto-search or add manually.</p>';
    } else {
      var h = '<table class="comp-table" style="margin-bottom:10px;"><thead><tr><th>Platform</th><th>URL</th><th>Nightly</th><th>Cleaning</th><th>Rating</th><th></th></tr></thead><tbody>';
      plats.forEach(function(p) {
        var icon = PLAT_ICONS[p.platform] || '📋';
        var name = PLAT_NAMES[p.platform] || p.platform;
        var color = PLAT_COLORS[p.platform] || 'var(--text)';
        var urlShort = p.listing_url ? p.listing_url.substring(0, 45) + (p.listing_url.length > 45 ? '...' : '') : '—';
        var urlLink = p.listing_url ? '<a href="' + esc(p.listing_url) + '" target="_blank" style="color:var(--text2);font-size:0.78rem;">' + esc(urlShort) + '</a>' : '<span style="color:var(--text3);">—</span>';
        h += '<tr><td style="color:' + color + ';font-weight:600;white-space:nowrap;">' + icon + ' ' + esc(name) + '</td>';
        h += '<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;">' + urlLink + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">' + (p.nightly_rate ? '$' + p.nightly_rate : '—') + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">' + (p.cleaning_fee > 0 ? '$' + p.cleaning_fee : '—') + '</td>';
        h += '<td>' + (p.rating ? p.rating.toFixed(1) + '★' : '—') + '</td>';
        h += '<td><button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);padding:2px 6px;" onclick="deletePropPlatform(' + p.id + ')" title="Remove">✗</button></td></tr>';
      });
      h += '</tbody></table>';
      if (list) list.innerHTML = h;
    }
    // Show add button
    if (content) content.innerHTML += '<button class="btn btn-xs" onclick="togglePropPlatformAdd()" style="margin-bottom:10px;">+ Add Platform Manually</button>';
  } catch (err) {
    if (list) list.innerHTML = '<p style="color:var(--danger);">' + esc(err.message) + '</p>';
  }
}

function togglePropPlatformAdd() {
  var form = document.getElementById('propPlatformAdd');
  form.style.display = form.style.display === 'none' ? '' : 'none';
  propPlatEditId = null;
}

async function savePropPlatform() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save the property first', 'error'); return; }
  var platform = document.getElementById('ppl_platform').value;
  var defaults = { direct: { h: 0, g: 0 }, airbnb: { h: 3, g: 14.2 }, vrbo: { h: 5, g: 12 }, booking: { h: 15, g: 0 }, furnished_finder: { h: 0, g: 0 } };
  var d = defaults[platform] || { h: 0, g: 0 };
  var data = {
    platform: platform,
    listing_url: document.getElementById('ppl_url').value.trim() || null,
    platform_fee_pct: d.h,
    guest_fee_pct: d.g,
  };
  try {
    await api('/api/properties/' + editId + '/platforms', 'POST', data);
    toast('Platform added');
    togglePropPlatformAdd();
    loadPropertyPlatforms(editId);
  } catch (err) { toast(err.message, 'error'); }
}

async function deletePropPlatform(id) {
  if (!confirm('Remove this platform link?')) return;
  var editId = (document.getElementById('f_editId') || {}).value;
  try {
    await api('/api/properties/' + editId + '/platforms/' + id, 'DELETE');
    toast('Removed');
    loadPropertyPlatforms(editId);
  } catch (err) { toast(err.message, 'error'); }
}

async function autoSearchPlatforms() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save the property first', 'error'); return; }
  var statusEl = document.getElementById('platformSearchStatus');
  if (statusEl) statusEl.textContent = 'Searching Airbnb, VRBO, Booking.com...';
  showLoading('Searching platforms...');
  try {
    var d = await api('/api/properties/' + editId + '/platforms/search', 'POST');
    var found = d.found || [];
    if (found.length === 0) {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--text3);">No listings found. Add manually below.</span>';
      toast('No platform listings found for this address', 'info');
      hideLoading();
      return;
    }
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent);">Found ' + found.length + ' potential listings</span>';
    // Show results as cards with thumbnails and view/link buttons
    var list = document.getElementById('propPlatformsList');
    var h = '<div style="margin-bottom:14px;"><label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:6px;">FOUND LISTINGS — preview before linking</label>';
    found.forEach(function(f, i) {
      var icon = PLAT_ICONS[f.platform] || '📋';
      var color = PLAT_COLORS[f.platform] || 'var(--text)';
      var name = PLAT_NAMES[f.platform] || f.platform;
      var rateStr = f.nightly_rate ? '$' + f.nightly_rate + '/nt' : '';
      var ratingStr = f.rating ? f.rating.toFixed(1) + '★' : '';
      var reviewStr = f.review_count ? '(' + f.review_count + ')' : '';
      var fromIntel = f.from_intel ? ' <span style="font-size:0.6rem;background:var(--surface2);padding:1px 4px;border-radius:3px;">intel DB</span>' : '';
      var bedsStr = f.bedrooms ? f.bedrooms + 'BR' : '';
      var superhostStr = f.superhost ? ' 🏆' : '';

      h += '<div style="display:flex;gap:12px;align-items:stretch;padding:10px 14px;margin-bottom:6px;border-radius:8px;border:1px solid var(--border);background:var(--surface2);" id="foundPlat' + i + '">';

      // Thumbnail
      if (f.image_url) {
        h += '<div style="width:80px;height:60px;border-radius:6px;overflow:hidden;flex-shrink:0;background:var(--bg);">';
        h += '<img src="' + esc(f.image_url) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML=\'<div style=padding:15px;text-align:center;color:var(--text3);font-size:1.2rem;>' + icon + '</div>\'">';
        h += '</div>';
      } else {
        h += '<div style="width:80px;height:60px;border-radius:6px;background:var(--bg);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1.5rem;">' + icon + '</div>';
      }

      // Info
      h += '<div style="flex:1;min-width:0;">';
      h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">';
      h += '<span style="color:' + color + ';font-weight:600;font-size:0.78rem;">' + esc(name) + '</span>';
      if (bedsStr) h += '<span style="font-size:0.68rem;color:var(--text3);">' + bedsStr + '</span>';
      if (superhostStr) h += '<span style="font-size:0.72rem;">' + superhostStr + '</span>';
      h += fromIntel;
      h += '</div>';
      h += '<div style="font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:350px;">' + esc(f.title || '') + '</div>';
      h += '<div style="display:flex;gap:8px;margin-top:3px;font-size:0.75rem;">';
      if (rateStr) h += '<span style="font-family:DM Mono,monospace;font-weight:600;color:var(--accent);">' + rateStr + '</span>';
      if (ratingStr) h += '<span style="color:var(--text2);">' + ratingStr + ' ' + reviewStr + '</span>';
      h += '</div>';
      h += '</div>';

      // Action buttons
      h += '<div style="display:flex;flex-direction:column;gap:4px;justify-content:center;flex-shrink:0;">';
      if (f.listing_url) {
        h += '<a href="' + esc(f.listing_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="btn btn-xs" style="font-size:0.72rem;padding:4px 10px;text-decoration:none;text-align:center;">👁 View</a>';
      }
      h += '<button class="btn btn-xs" style="font-size:0.72rem;padding:4px 10px;color:var(--accent);border-color:var(--accent);" onclick="linkFoundPlatform(' + i + ')">+ Link</button>';
      h += '</div>';

      h += '</div>';
    });
    h += '</div>';
    if (list) list.innerHTML = h;
    // Store found results for linking
    window._foundPlatforms = found;
    toast('Found ' + found.length + ' listings');
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  hideLoading();
}

async function linkFoundPlatform(idx) {
  var found = (window._foundPlatforms || [])[idx];
  if (!found) return;
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) return;
  var defaults = { direct: { h: 0, g: 0 }, airbnb: { h: 3, g: 14.2 }, vrbo: { h: 5, g: 12 }, booking: { h: 15, g: 0 }, furnished_finder: { h: 0, g: 0 } };
  var d = defaults[found.platform] || { h: 0, g: 0 };
  try {
    await api('/api/properties/' + editId + '/platforms', 'POST', {
      platform: found.platform,
      listing_url: found.listing_url || null,
      nightly_rate: found.nightly_rate || null,
      platform_fee_pct: d.h,
      guest_fee_pct: d.g,
      rating: found.rating || null,
      review_count: found.review_count || 0,
    });
    toast(PLAT_NAMES[found.platform] + ' linked!');
    var card = document.getElementById('foundPlat' + idx);
    if (card) {
      card.style.opacity = '0.5';
      card.style.pointerEvents = 'none';
      card.style.borderColor = 'var(--accent)';
      var btns = card.querySelectorAll('.btn');
      if (btns.length > 0) btns[btns.length - 1].textContent = '✓ Linked';
    }
    loadPropertyPlatforms(editId);
  } catch (err) { toast(err.message, 'error'); }
}
