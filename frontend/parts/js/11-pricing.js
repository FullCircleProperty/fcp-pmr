// Platform Pricing Comparison
let pricingPropertyId = null;
let pricingEditId = null;

var PLAT_ICONS = { direct: _ico('home',15,'#10b981'), airbnb: _ico('home',15,'#ff5a5f'), vrbo: _ico('home',15,'#3b82f6'), booking: _ico('globe',15,'#003b95'), furnished_finder: _ico('layers',15,'#f59e0b') };
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
      h += '<button class="btn btn-xs btn-purple" onclick="scrapeAllPlatforms()" id="scrapeAllBtn">' + _ico('refresh', 13) + ' Scrape All Pricing</button>';
      h += '</div>';
    }
    h += '<table class="comp-table"><thead><tr><th>Platform</th><th>Listing URL</th><th>Nightly</th><th>Cleaning</th><th>Rating</th><th>Reviews</th><th>Last Scraped</th><th></th></tr></thead><tbody>';
    plats.forEach(function(p) {
      var icon = PLAT_ICONS[p.platform] || '' + _ico('clipboard', 13) + '';
      var name = PLAT_NAMES[p.platform] || p.platform;
      var color = PLAT_COLORS[p.platform] || 'var(--text)';
      var urlShort = p.listing_url ? p.listing_url.replace(/^https?:\/\/(www\.)?/, '').substring(0, 45) + (p.listing_url.length > 55 ? '...' : '') : '';
      var link = p.listing_url ? '<a href="' + esc(p.listing_url) + '" target="_blank" style="color:var(--text2);font-size:0.78rem;">' + esc(urlShort) + '</a>' : '<span style="color:var(--text3);font-size:0.78rem;">No URL</span>';
      h += '<tr><td style="color:' + color + ';font-weight:600;white-space:nowrap;">' + icon + ' ' + esc(name) + '</td>';
      h += '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;">' + link + '</td>';
      var rateLabel = '';
      var rateVal = p.nightly_rate ? Math.round(p.nightly_rate) : 0;
      if (p.rate_source === 'manual' && rateVal > 0) {
        // Manual override — trusted, show with edit pencil
        rateLabel = '<span onclick="inlineEditRate(' + p.id + ', this)" style="cursor:pointer;" title="Click to edit (manual override)">$' + rateVal + ' <span style="font-size:0.6rem;color:var(--text2);">✎</span></span>';
      } else if (p.rate_source === 'live' && rateVal > 0) {
        // Live API rate — trusted
        rateLabel = '$' + rateVal + ' <span style="font-size:0.6rem;color:var(--accent);" title="Live rate from platform API">✓</span>';
      } else if (p.rate_source === 'estimate' && rateVal > 0) {
        // Google estimate — unreliable, show dimmed with warning
        rateLabel = '<span style="opacity:0.4;" title="Estimated from Google — click to enter actual rate">~$' + rateVal + '</span> <span onclick="inlineEditRate(' + p.id + ', this)" style="cursor:pointer;font-size:0.6rem;color:var(--warn);" title="Click to enter actual rate">✎ set</span>';
      } else {
        // No rate — show edit prompt
        rateLabel = '<span onclick="inlineEditRate(' + p.id + ', this)" style="cursor:pointer;color:var(--text3);" title="Click to enter nightly rate">— ✎</span>';
      }
      h += '<td style="font-family:DM Mono,monospace;font-weight:600;" data-plat-id="' + p.id + '">' + rateLabel + '</td>';
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
  if (btn) btn.innerHTML ='' + _ico('clock', 13) + ' Scraping...';
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
  if (btn) btn.innerHTML ='' + _ico('refresh', 13) + ' Scrape All Pricing';
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

function inlineEditRate(platId, el) {
  var td = el.closest('td');
  var current = td.textContent.replace(/[^0-9]/g, '') || '';
  td.innerHTML = '<input type="number" value="' + current + '" min="0" max="9999" style="width:80px;padding:3px 6px;font-size:0.82rem;font-family:DM Mono,monospace;background:var(--bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);" onblur="saveInlineRate(' + platId + ', this, false)" onkeydown="if(event.key===\'Enter\')this.blur()" autofocus placeholder="$/nt">';
  td.querySelector('input').focus();
}

function inlineEditPropRate(platId, el) {
  var td = el.closest('td');
  var current = td.textContent.replace(/[^0-9]/g, '') || '';
  td.innerHTML = '<input type="number" value="' + current + '" min="0" max="9999" style="width:80px;padding:3px 6px;font-size:0.82rem;font-family:DM Mono,monospace;background:var(--bg);border:1px solid var(--accent);border-radius:4px;color:var(--text);" onblur="saveInlineRate(' + platId + ', this, true)" onkeydown="if(event.key===\'Enter\')this.blur()" autofocus placeholder="$/nt">';
  td.querySelector('input').focus();
}

async function saveInlineRate(platId, input, isPropDetail) {
  var val = parseInt(input.value) || 0;
  var propId = isPropDetail ? (document.getElementById('f_editId') || {}).value : pricingPropertyId;
  if (!propId) return;
  try {
    await api('/api/properties/' + propId + '/platforms/' + platId, 'PUT', {
      nightly_rate: val > 0 ? val : null,
      rate_source: val > 0 ? 'manual' : null,
    });
    toast(val > 0 ? 'Rate set to $' + val + '/nt' : 'Rate cleared');
    if (isPropDetail) loadPropertyPlatforms(propId);
    else loadPlatformList();
  } catch (err) { toast(err.message, 'error'); }
}

async function scrapePlatforms() {
  if (!pricingPropertyId) { toast('Select a property', 'error'); return; }
  document.getElementById('pricingStatus').innerHTML ='' + _ico('refresh', 13) + ' Scraping platform URLs...';
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

  document.getElementById('pricingStatus').innerHTML ='' + _ico('clock', 13) + ' Running comparison...';
  showLoading('Analyzing pricing...');
  try {
    var pets = parseInt(document.getElementById('pricingPets')?.value || '0') || 0;
  var d = await api('/api/properties/' + pricingPropertyId + '/platforms/compare', 'POST', { nights: nights, guests: guests, checkin: checkin, pets: pets });
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
    document.getElementById('pricingNightsLabel').innerHTML ='' + _ico('calendar', 13) + ' <strong>' + cinLabel + ' → ' + coutLabel + '</strong> (' + nights + ' nights, ' + guests + ' guests)';

    renderGuestCostTable(d.comparison, nights);
    // Show scrape results summary
    if (d.scrape_results) {
      var ok = d.scrape_results.filter(function(r) { return r.status === 'ok'; });
      var nodata = d.scrape_results.filter(function(r) { return r.status === 'no_data' || r.status === 'error'; });
      var scrapeHtml = '<div style="margin-bottom:10px;padding:8px 12px;border-radius:8px;font-size:0.78rem;';
      if (nodata.length > 0 && ok.length === 0) {
        scrapeHtml += 'background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);color:var(--warn);">';
        scrapeHtml +='' + _ico('alertTriangle', 13, '#f59e0b') + ' Could not scrape pricing — using previously stored data. Make sure URLs are correct and SearchAPI key is configured.';
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
    var icon = PLAT_ICONS[c.platform] || '' + _ico('clipboard', 13) + '';
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
    var icon = PLAT_ICONS[c.platform] || '' + _ico('clipboard', 13) + '';
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
    var icon = PLAT_ICONS[c.platform] || '' + _ico('clipboard', 13) + '';
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
    var bg = i.type === 'cost' ? 'rgba(16,185,129,0.06)' : i.type === 'revenue' ? 'rgba(59,130,246,0.06)' : i.type === 'parity' ? (i.icon === 'alertTriangle' ? 'rgba(239,68,68,0.06)' : 'rgba(16,185,129,0.06)') : i.type === 'direct' ? 'rgba(16,185,129,0.06)' : 'rgba(245,158,11,0.06)';
    var iconSvg = i.icon ? _ico(i.icon, 13) : _ico('barChart', 13);
    h += '<div style="padding:10px 14px;margin-bottom:6px;border-radius:8px;background:' + bg + ';font-size:0.85rem;"><span style="margin-right:6px;">' + iconSvg + '</span>' + esc(i.text) + '</div>';
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
  var nameBox = document.getElementById('platformListingNameBox');
  var nameInput = document.getElementById('platformListingNameInput');
  var nameHint = document.getElementById('platformListingNameHint');
  if (!propId) {
    if (content) content.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save the property first to manage platform links.</p>';
    if (list) list.innerHTML = '';
    if (search) search.style.display = 'none';
    if (nameBox) nameBox.style.display = 'none';
    return;
  }
  if (search) search.style.display = '';
  if (nameBox) nameBox.style.display = '';
  try {
    var d = await api('/api/properties/' + propId + '/platforms');
    var plats = d.platforms || [];
    // Populate listing name field
    var guestyName = d.guesty_listing_name || '';
    var savedName = d.platform_listing_name || '';
    if (nameInput) {
      nameInput.value = savedName || guestyName;
      window._originalPlatformName = nameInput.value;
    }
    if (nameHint) {
      if (guestyName && savedName && savedName !== guestyName) {
        nameHint.innerHTML = '✏️ Manually set &nbsp;·&nbsp; Guesty name: <em>' + esc(guestyName) + '</em>';
      } else if (guestyName && !savedName) {
        nameHint.innerHTML = '⬆️ Auto-filled from Guesty — edit if needed';
      } else if (!guestyName && !savedName) {
        nameHint.innerHTML = 'Enter the name exactly as it appears on Airbnb, VRBO, etc. for best search results.';
      } else {
        nameHint.innerHTML = '';
      }
    }
    if (content) content.innerHTML = '';
    if (plats.length === 0) {
      if (list) list.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;margin-bottom:10px;">No platforms linked. Use auto-search or add manually.</p>';
    } else {
      var h = '<table class="comp-table" style="margin-bottom:10px;"><thead><tr><th>Platform</th><th>URL</th><th>Nightly</th><th>Cleaning</th><th>Rating</th><th></th></tr></thead><tbody>';
      plats.forEach(function(p) {
        var icon = PLAT_ICONS[p.platform] || '' + _ico('clipboard', 13) + '';
        var name = PLAT_NAMES[p.platform] || p.platform;
        var color = PLAT_COLORS[p.platform] || 'var(--text)';
        var urlShort = p.listing_url ? p.listing_url.substring(0, 45) + (p.listing_url.length > 45 ? '...' : '') : '—';
        var urlLink = p.listing_url ? '<a href="' + esc(p.listing_url) + '" target="_blank" style="color:var(--text2);font-size:0.78rem;">' + esc(urlShort) + '</a>' : '<span style="color:var(--text3);">—</span>';
        h += '<tr><td style="color:' + color + ';font-weight:600;white-space:nowrap;">' + icon + ' ' + esc(name) + '</td>';
        h += '<td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;">' + urlLink + '</td>';
        var prv = p.nightly_rate ? Math.round(p.nightly_rate) : 0;
        var propRateLabel = '';
        if (p.rate_source === 'manual' && prv > 0) {
          propRateLabel = '<span onclick="inlineEditPropRate(' + p.id + ', this)" style="cursor:pointer;" title="Manual override — click to edit">$' + prv + ' <span style="font-size:0.6rem;color:var(--text2);">✎</span></span>';
        } else if (p.rate_source === 'live' && prv > 0) {
          propRateLabel = '$' + prv + ' <span style="font-size:0.6rem;color:var(--accent);">✓</span>';
        } else if (p.rate_source === 'estimate' && prv > 0) {
          propRateLabel = '<span style="opacity:0.4;">~$' + prv + '</span> <span onclick="inlineEditPropRate(' + p.id + ', this)" style="cursor:pointer;font-size:0.6rem;color:var(--warn);">✎ set</span>';
        } else {
          propRateLabel = '<span onclick="inlineEditPropRate(' + p.id + ', this)" style="cursor:pointer;color:var(--text3);">— ✎</span>';
        }
        h += '<td style="font-family:DM Mono,monospace;">' + propRateLabel + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">' + (p.cleaning_fee > 0 ? '$' + p.cleaning_fee : '—') + '</td>';
        h += '<td>' + (p.rating ? p.rating.toFixed(1) + '★' : '—') + '</td>';
        h += '<td><button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);padding:2px 6px;" onclick="deletePropPlatform(' + p.id + ')" title="Remove">✗</button></td></tr>';
      });
      h += '</tbody></table>';
      if (list) list.innerHTML = h;
    }
    // Show add button
    if (content) content.innerHTML += '<button class="btn btn-xs" onclick="togglePropPlatformAdd()" style="margin-bottom:10px;">+ Add Platform Manually</button>';
    // Render platform intelligence for linked platforms
    var intelPanel = document.getElementById('platformIntelPanel');
    if (intelPanel && plats.length > 0) {
      var intelHtml = '';
      var seenPlatforms = new Set();
      plats.forEach(function(p) {
        if (!seenPlatforms.has(p.platform) && PLATFORM_INTEL[p.platform]) {
          seenPlatforms.add(p.platform);
          intelHtml += renderPlatformIntel(p.platform);
        }
      });
      // Also show intel for platforms NOT yet linked — opportunity to expand
      var allPlatforms = ['airbnb', 'vrbo', 'booking', 'furnished_finder', 'direct'];
      var unlinked = allPlatforms.filter(function(pl) { return !seenPlatforms.has(pl); });
      if (unlinked.length > 0) {
        intelHtml += '<div style="margin-top:10px;padding:10px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;">';
        intelHtml += '<div style="font-size:0.76rem;font-weight:600;color:var(--text3);margin-bottom:6px;">Not yet listed on:</div>';
        unlinked.forEach(function(pl) {
          var name = PLAT_NAMES[pl] || pl;
          intelHtml += '<button class="btn btn-xs" style="margin:2px 4px;" onclick="document.getElementById(\'ppl_platform\').value=\'' + pl + '\';togglePropPlatformAdd()">' + (PLAT_ICONS[pl] || '') + ' Add ' + name + '</button>';
        });
        intelHtml += '</div>';
      }
      intelPanel.innerHTML = intelHtml;
    }
  } catch (err) {
    if (list) list.innerHTML = '<p style="color:var(--danger);">' + esc(err.message) + '</p>';
  }
}

function togglePropPlatformAdd() {
  var form = document.getElementById('propPlatformAdd');
  form.style.display = form.style.display === 'none' ? '' : 'none';
  propPlatEditId = null;
}

async function scrapePropPlatforms() {
  var propId = (document.getElementById('f_editId') || {}).value;
  if (!propId) { toast('Save the property first', 'error'); return; }
  var statusEl = document.getElementById('platformSearchStatus');
  if (statusEl) statusEl.textContent = 'Scraping all platforms...';
  showLoading('Scraping platform pricing...');
  try {
    var d = await api('/api/properties/' + propId + '/platforms/scrape', 'POST');
    toast(d.message || 'Done');
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent);">' + esc(d.message || 'Scraped') + '</span>';
    loadPropertyPlatforms(propId);
  } catch (err) {
    toast(err.message, 'error');
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">' + esc(err.message) + '</span>';
  }
  hideLoading();
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

function onPlatformNameInput() {
  var input = document.getElementById('platformListingNameInput');
  var btn = document.getElementById('savePlatformNameBtn');
  if (!input || !btn) return;
  var changed = input.value.trim() !== (window._originalPlatformName || '').trim();
  btn.style.display = changed ? '' : 'none';
}

async function savePlatformListingName() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) return;
  var input = document.getElementById('platformListingNameInput');
  var name = input ? input.value.trim() : '';
  try {
    await api('/api/properties/' + editId, 'PATCH', { platform_listing_name: name });
    window._originalPlatformName = name;
    var btn = document.getElementById('savePlatformNameBtn');
    if (btn) btn.style.display = 'none';
    var hint = document.getElementById('platformListingNameHint');
    if (hint) hint.innerHTML = '' + _ico('check', 13, 'var(--accent)') + ' Saved';
    setTimeout(function() {
      if (hint) hint.innerHTML = '';
    }, 2000);
    toast('Listing name saved');
  } catch (err) { toast(err.message, 'error'); }
}

async function autoSearchPlatforms() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save the property first', 'error'); return; }
  var statusEl = document.getElementById('platformSearchStatus');
  var nameInput = document.getElementById('platformListingNameInput');
  var listingName = nameInput ? nameInput.value.trim() : '';
  // Auto-save the listing name before searching if it changed
  if (listingName && listingName !== (window._originalPlatformName || '').trim()) {
    await savePlatformListingName();
  }
  var searchLabel = listingName ? '"' + listingName + '"' : 'property address';
  if (statusEl) statusEl.textContent = 'Searching for ' + searchLabel + '...';
  showLoading('Searching platforms for ' + searchLabel + '...');
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
      var icon = PLAT_ICONS[f.platform] || '' + _ico('clipboard', 13) + '';
      var color = PLAT_COLORS[f.platform] || 'var(--text)';
      var name = PLAT_NAMES[f.platform] || f.platform;
      var rateStr = f.nightly_rate ? '$' + f.nightly_rate + '/nt' : '';
      var ratingStr = f.rating ? f.rating.toFixed(1) + '★' : '';
      var reviewStr = f.review_count ? '(' + f.review_count + ')' : '';
      var fromIntel = f.from_intel ? ' <span style="font-size:0.6rem;background:var(--surface2);padding:1px 4px;border-radius:3px;">intel DB</span>' : '';
      var bedsStr = f.bedrooms ? f.bedrooms + 'BR' : '';
      var superhostStr = f.superhost ? ' ' + _ico('trophy', 13) + '' : '';

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
      var matchBadge = '';
      if (f.name_match === 'exact') matchBadge = ' <span style="font-size:0.6rem;background:rgba(16,185,129,0.15);color:var(--accent);padding:1px 5px;border-radius:3px;border:1px solid rgba(16,185,129,0.3);">exact match</span>';
      else if (f.name_match === 'partial') matchBadge = ' <span style="font-size:0.6rem;background:rgba(245,158,11,0.15);color:#f59e0b;padding:1px 5px;border-radius:3px;border:1px solid rgba(245,158,11,0.3);">partial match</span>';
      h += '<div style="font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:350px;">' + esc(f.title || '') + matchBadge + '</div>';
      h += '<div style="display:flex;gap:8px;margin-top:3px;font-size:0.75rem;">';
      if (rateStr) h += '<span style="font-family:DM Mono,monospace;font-weight:600;color:var(--accent);">' + rateStr + '</span>';
      if (ratingStr) h += '<span style="color:var(--text2);">' + ratingStr + ' ' + reviewStr + '</span>';
      h += '</div>';
      h += '</div>';

      // Action buttons
      h += '<div style="display:flex;flex-direction:column;gap:4px;justify-content:center;flex-shrink:0;">';
      if (f.listing_url) {
        h += '<a href="' + esc(f.listing_url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation();" class="btn btn-xs" style="font-size:0.72rem;padding:4px 10px;text-decoration:none;text-align:center;">' + _ico('eye', 13) + ' View</a>';
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

// ── Integrations Tab ────────────────────────────────────────────────────────

async function loadIntegrationsTab(propId) {
  if (!propId) return;
  // Always start on the grid view
  backToIntegrations();
  try {
    var d = await api('/api/properties/' + propId);
    var p = d.property || {};
    var pl = d.pricelabs || {};
    var actual = (window._actualRevenue || {})[propId];

    // ── Guesty — card grid stats ──
    var guCardBadge = document.getElementById('intgCard-guesty-badge');
    var guCardStats = document.getElementById('intgCard-guesty-stats');
    if (actual && actual.monthly_avg > 0) {
      if (guCardBadge) guCardBadge.innerHTML = '<span style="font-size:0.65rem;color:var(--accent);background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);border-radius:4px;padding:1px 6px;">● Connected</span>';
      if (guCardStats) guCardStats.innerHTML =
        '<strong style="color:var(--text);">$' + Math.round(actual.monthly_avg).toLocaleString() + '/mo</strong>' +
        (actual.avg_occ ? ' &nbsp;·&nbsp; ' + Math.round(actual.avg_occ * 100) + '% occ' : '') +
        (actual.months_of_data ? '<br><span style="color:var(--text3);">' + actual.months_of_data + ' months of data</span>' : '');
    } else {
      if (guCardBadge) guCardBadge.innerHTML = '<span style="font-size:0.65rem;color:var(--text3);background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;">○ No actuals</span>';
      if (guCardStats) guCardStats.textContent = 'No actuals imported yet';
    }

    // ── PriceLabs — card grid stats ──
    var plCardBadge = document.getElementById('intgCard-pricelabs-badge');
    var plCardStats = document.getElementById('intgCard-pricelabs-stats');

    // ── Algorithm — card grid stats ──
    var algoCardBadge = document.getElementById('intgCard-algorithm-badge');
    var algoCardStats = document.getElementById('intgCard-algorithm-stats');

    // ── Guesty detail ──
    var guBadge = document.getElementById('guestyPropLinkBadge');
    var guSummary = document.getElementById('guestyPropActualsSummary');
    var guSummary = document.getElementById('guestyPropActualsSummary');
    if (actual && actual.monthly_avg > 0) {
      if (guBadge) guBadge.innerHTML = '<span style="color:var(--accent);background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);border-radius:4px;padding:1px 6px;">● Connected</span>';
      if (guSummary) guSummary.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;">' +
        _iStatCard('Avg Monthly Revenue', '$' + Math.round(actual.monthly_avg).toLocaleString(), 'var(--accent)') +
        (actual.avg_adr ? _iStatCard('Avg ADR', '$' + Math.round(actual.avg_adr), '') : '') +
        (actual.avg_occ ? _iStatCard('Avg Occupancy', Math.round(actual.avg_occ * 100) + '%', '') : '') +
        (actual.months_of_data ? _iStatCard('Months of Data', actual.months_of_data, '') : '') +
        '</div>';
    } else {
      if (guBadge) guBadge.innerHTML = '<span style="color:var(--text3);background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;">○ No actuals</span>';
      if (guSummary) guSummary.innerHTML = '<span style="color:var(--text3);font-size:0.82rem;">No Guesty actuals imported yet. <a href="#" onclick="switchView(\'pms\');return false;" style="color:#60a5fa;">Import CSV →</a></span>';
    }

    // ── PriceLabs card ──
    var plBadge = document.getElementById('plPropLinkBadge');
    var plSummary = document.getElementById('plPropSummary');
    var plSyncBtn = document.getElementById('plPropSyncBtn');
    var plOpenBtn = document.getElementById('plPropOpenBtn');
    var plLinkBox = document.getElementById('plPropLinkBox');
    var algoOpenBtn = document.getElementById('algoOpenPLBtn');

    if (pl && pl.linked) {
      if (plBadge) plBadge.innerHTML = '<span style="color:var(--purple);background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);border-radius:4px;padding:1px 6px;">● Linked</span>';
      if (plSyncBtn) plSyncBtn.style.display = '';
      if (plOpenBtn) plOpenBtn.style.display = '';
      if (plLinkBox) plLinkBox.style.display = 'none';
      if (algoOpenBtn) algoOpenBtn.style.display = '';
      var plData = pl.data || {};
      var base = plData.base_price || p.pl_base_price;
      var min = plData.min_price || p.pl_min_price;
      var max = plData.max_price || p.pl_max_price;
      var rec = plData.recommended_base_price || p.pl_rec_base;
      var occ30 = p.pl_occ_30d;
      var mkt30 = p.pl_mkt_occ_30d;
      if (plSummary) plSummary.innerHTML =
        '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;">' +
        (base ? _iStatCard('Base Price', '$' + base + '/nt', 'var(--purple)') : '') +
        (min ? _iStatCard('Min Price', '$' + min + '/nt', '') : '') +
        (max ? _iStatCard('Max Price', '$' + max + '/nt', '') : '') +
        (rec ? _iStatCard('PL Recommended', '$' + rec + '/nt', rec > base ? 'var(--accent)' : 'var(--text2)') : '') +
        (occ30 ? _iStatCard('Your Occ 30d', occ30 + '%', parseInt(occ30) >= parseInt(mkt30||0) ? 'var(--accent)' : 'var(--danger)') : '') +
        (mkt30 ? _iStatCard('Market Occ 30d', mkt30 + '%', '') : '') +
        '</div>';

      // ── Algorithm card: PriceLabs settings section ──
      var algoContent = document.getElementById('algoPLSettingsContent');
      if (algoContent) {
        var group = plData.group_name || p.pl_group_name;
        var lastSync = p.pl_last_synced || plData.last_synced;
        algoContent.innerHTML =
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px;margin-bottom:8px;">' +
          (base ? _iStatCard('Base', '$' + base, 'var(--purple)') : '') +
          (min ? _iStatCard('Min', '$' + min, '') : '') +
          (max ? _iStatCard('Max', '$' + max, '') : '') +
          (rec ? _iStatCard('Recommended', '$' + rec, rec > base ? 'var(--accent)' : 'var(--text2)') : '') +
          '</div>' +
          (group ? '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:4px;">Group: <strong style="color:var(--text2);">' + esc(group) + '</strong></div>' : '') +
          (lastSync ? '<div style="font-size:0.65rem;color:var(--text3);">Last synced: ' + fmtUTC(lastSync) + '</div>' : '');
      }
    } else {
      if (plBadge) plBadge.innerHTML = '<span style="color:var(--text3);background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;">○ Not linked</span>';
      if (plSyncBtn) plSyncBtn.style.display = 'none';
      if (plOpenBtn) plOpenBtn.style.display = 'none';
      if (algoOpenBtn) algoOpenBtn.style.display = 'none';
      if (plLinkBox) {
        plLinkBox.style.display = '';
        // Populate selector with available PL listings
        var sel = document.getElementById('plPropLinkSelect');
        if (sel && d.pl_available && d.pl_available.length) {
          d.pl_available.forEach(function(l) {
            var opt = document.createElement('option');
            opt.value = l.id;
            opt.textContent = (l.name || l.pl_listing_id) + (l.platform ? ' (' + l.platform + ')' : '') + (l.base_price ? ' — $' + l.base_price + '/nt' : '');
            sel.appendChild(opt);
          });
        }
      }
    }

    // ── PriceLabs — card grid stats ──
    if (pl && pl.linked) {
      if (plCardBadge) plCardBadge.innerHTML = '<span style="font-size:0.65rem;color:#a78bfa;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.25);border-radius:4px;padding:1px 6px;">● Linked</span>';
      var plD = pl.data || {};
      var cBase = plD.base_price || p.pl_base_price;
      var cOcc  = p.pl_occ_30d;
      var cMkt  = p.pl_mkt_occ_30d;
      if (plCardStats) plCardStats.innerHTML =
        (cBase ? '<strong style="color:var(--text);">$' + cBase + '/nt base</strong>' : '') +
        (cOcc  ? ' &nbsp;·&nbsp; ' + cOcc + '% occ' : '') +
        (cMkt  ? '<br><span style="color:var(--text3);">Market: ' + cMkt + '% occ</span>' : '');
    } else {
      if (plCardBadge) plCardBadge.innerHTML = '<span style="font-size:0.65rem;color:var(--text3);background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;">○ Not linked</span>';
      if (plCardStats) plCardStats.textContent = 'Link a PriceLabs listing to get started';
    }

    // ── Algorithm overrides: load saved values ──
    loadAlgoOverrides(propId);

    // ── Algorithm — card grid stats (after overrides loaded) ──
    setTimeout(function() {
      var minN = document.getElementById('algo_min_nights');
      var wkd  = document.getElementById('algo_weekend_pct');
      var lm   = document.getElementById('algo_lastmin_pct');
      var hasOverrides = (minN && minN.value) || (wkd && wkd.value) || (lm && lm.value);
      if (algoCardBadge) algoCardBadge.innerHTML = hasOverrides
        ? '<span style="font-size:0.65rem;color:var(--accent);background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.25);border-radius:4px;padding:1px 6px;">● Configured</span>'
        : '<span style="font-size:0.65rem;color:var(--text3);background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;">○ Defaults</span>';
      if (algoCardStats) algoCardStats.innerHTML =
        (minN && minN.value ? 'Min ' + minN.value + ' nights' : 'No overrides set') +
        (wkd && wkd.value ? ' &nbsp;·&nbsp; +' + wkd.value + '% wknd' : '') +
        (lm && lm.value ? ' &nbsp;·&nbsp; −' + lm.value + '% last-min' : '');
    }, 300);

    // ── System card: AI provider status ──
    try {
      var anthKey = await api('/api/admin/settings/apikey_ANTHROPIC_API_KEY');
      var oaiKey  = await api('/api/admin/settings/apikey_OPENAI_API_KEY');
      var hasAnthropic = anthKey && anthKey.value;
      var hasOpenAI    = oaiKey  && oaiKey.value;
      var label = document.getElementById('aiProviderStatusLabel');
      var sub   = document.getElementById('aiProviderStatusSub');
      if (label) label.textContent = hasAnthropic ? 'Claude (Anthropic)' : hasOpenAI ? 'GPT-4o (OpenAI)' : 'Not configured';
      if (label) label.style.color = (hasAnthropic || hasOpenAI) ? 'var(--accent)' : 'var(--danger)';
      if (sub)   sub.textContent   = (hasAnthropic && hasOpenAI) ? 'Anthropic + OpenAI configured' : hasAnthropic ? 'Anthropic configured' : hasOpenAI ? 'OpenAI configured' : 'Add keys in Admin → Settings';
    } catch {}

    // API calls today — use usage-alerts endpoint which exists
    try {
      var callsEl = document.getElementById('propApiCallsToday');
      var alerts = await api('/api/usage-alerts');
      if (callsEl && alerts && alerts.this_month !== undefined) {
        callsEl.textContent = (alerts.this_month || 0).toLocaleString() + ' this month';
      }
    } catch {}

  } catch (err) { console.error('loadIntegrationsTab:', err); }
}

function _iStatCard(label, val, color) {
  return '<div style="padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;text-align:center;">' +
    '<div style="font-size:0.58rem;color:var(--text3);margin-bottom:2px;text-transform:uppercase;letter-spacing:0.04em;">' + label + '</div>' +
    '<div style="font-family:DM Mono,monospace;font-size:0.95rem;font-weight:700;color:' + (color || 'var(--text)') + ';">' + val + '</div>' +
    '</div>';
}

function openPriceLabsForProp() {
  var p = properties.find(function(x) { return x.id == (document.getElementById('f_editId') || {}).value; });
  if (!p || !p.pl_listing_id) { toast('No PriceLabs listing linked', 'error'); return; }
  window.open('https://app.pricelabs.co/pricing?listings=' + encodeURIComponent(p.pl_listing_id), '_blank');
}

async function linkPropToPriceLabs() {
  var editId = (document.getElementById('f_editId') || {}).value;
  var sel = document.getElementById('plPropLinkSelect');
  if (!editId || !sel || !sel.value) { toast('Select a PriceLabs listing first', 'error'); return; }
  try {
    await api('/api/pricelabs/listings/' + sel.value + '/link', 'POST', { property_id: parseInt(editId) });
    toast('PriceLabs linked!');
    loadIntegrationsTab(editId);
  } catch (err) { toast(err.message, 'error'); }
}

async function saveAlgoOverrides() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var overrides = {
    min_nights:    (document.getElementById('algo_min_nights') || {}).value || null,
    weekend_pct:   (document.getElementById('algo_weekend_pct') || {}).value || null,
    lastmin_pct:   (document.getElementById('algo_lastmin_pct') || {}).value || null,
    gap_pct:       (document.getElementById('algo_gap_pct') || {}).value || null,
    earlybird_pct: (document.getElementById('algo_earlybird_pct') || {}).value || null,
    monthly_pct:   (document.getElementById('algo_monthly_pct') || {}).value || null,
    notes:         (document.getElementById('algo_notes') || {}).value || '',
  };
  try {
    await api('/api/properties/' + editId + '/algo-overrides', 'POST', overrides);
    var st = document.getElementById('algoSaveStatus');
    if (st) { st.textContent = '✓ Saved'; setTimeout(function() { st.textContent = ''; }, 2000); }
  } catch (err) { toast(err.message, 'error'); }
}

async function loadAlgoOverrides(propId) {
  try {
    var d = await api('/api/properties/' + propId + '/algo-overrides');
    if (!d || !d.overrides) return;
    var o = d.overrides;
    var fields = ['min_nights','weekend_pct','lastmin_pct','gap_pct','earlybird_pct','monthly_pct','notes'];
    fields.forEach(function(f) {
      var el = document.getElementById('algo_' + f);
      if (el && o[f] != null) el.value = o[f];
    });
  } catch {}
}

async function syncPriceLabsFromPropTab() {
  // Wrapper that gives feedback within the property integrations tab
  var btn = document.getElementById('plPropSyncBtn');
  var summary = document.getElementById('plPropSummary');
  if (btn) { btn.disabled = true; btn.innerHTML ='' + _ico('clock', 13) + ' Syncing...'; }
  try {
    await syncPriceLabs(); // runs the full sync flow (preview → confirm)
    // After sync, reload the integrations tab to reflect new data
    var editId = (document.getElementById('f_editId') || {}).value;
    if (editId) {
      await loadProperties(); // refresh global properties list
      loadIntegrationsTab(editId);
    }
  } catch (err) {
    toast(err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.innerHTML ='' + _ico('refresh', 13) + ' Sync'; }
}

// ── Integrations tab navigation ─────────────────────────────────────────────

function showIntegrationDetail(name) {
  // Hide grid, show detail wrapper
  var grid = document.getElementById('intgGrid');
  var detail = document.getElementById('intgDetail');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = '';

  // Hide all detail panels, show the requested one
  ['guesty','pricelabs','algorithm','system'].forEach(function(n) {
    var el = document.getElementById('intgDetail-' + n);
    if (el) el.style.display = n === name ? '' : 'none';
  });

  // Store current for back button
  window._currentIntgDetail = name;
}

function backToIntegrations() {
  var grid = document.getElementById('intgGrid');
  var detail = document.getElementById('intgDetail');
  if (grid) grid.style.display = '';
  if (detail) detail.style.display = 'none';
  window._currentIntgDetail = null;
}

// ── Main Integrations page navigation ────────────────────────────────────────

function showPmsDetail(name) {
  // Redirect moved panels to Intel hub
  if (name === 'algo') { switchView('intel'); switchIntelTab('algo'); return; }
  if (name === 'intelligence') { switchView('intel'); switchIntelTab('guests'); return; }

  var grid   = document.getElementById('pmsGrid');
  var detail = document.getElementById('pmsDetail');
  if (grid)   grid.style.display   = 'none';
  if (detail) detail.style.display = '';
  ['guesty','pricelabs','cloudflare'].forEach(function(n) {
    var el = document.getElementById('pmsDetail-' + n);
    if (el) el.style.display = n === name ? '' : 'none';
  });
  // Load data for the selected panel
  if (name === 'guesty') {
    loadGuestyConnection();
    loadGuestyStats();
    loadMonthlyActuals();
    loadSyncDashboard();
  }
  if (name === 'pricelabs') {
    loadPLStatus();
    loadPLSyncDashboard();
  }
  if (name === 'cloudflare') {
    loadCfDetail();
  }
}

function backToPmsGrid() {
  var grid   = document.getElementById('pmsGrid');
  var detail = document.getElementById('pmsDetail');
  if (grid)   grid.style.display   = '';
  if (detail) detail.style.display = 'none';
  loadPmsCardStats();
}

async function loadPmsCardStats() {
  var gd = await api('/api/guesty/stats').catch(function() { return null; });
  var pd = await api('/api/pricelabs/status').catch(function() { return null; });
  var ad = await api('/api/guesty/actuals').catch(function() { return null; });

  // ── Guesty ──────────────────────────────────────────────────────────────
  var guBadge = document.getElementById('pmsCard-guesty-badge');
  var guStats = document.getElementById('pmsCard-guesty-stats');
  var totalRes  = gd ? (gd.total_reservations || 0) : 0;
  var confirmed = gd ? (gd.confirmed_reservations || 0) : 0;
  var listings  = gd ? (gd.total_listings || 0) : 0;
  var matched   = gd ? (gd.matched_listings || 0) : 0;
  var byChannel = gd ? (gd.by_channel || []) : [];
  var cancelRate = gd ? (gd.cancellation_rate || 0) : 0;
  var dateRange  = gd ? (gd.date_range || {}) : {};

  // Compute YTD metrics from actuals
  var actuals = ad ? (ad.actuals || []) : [];
  var now = new Date();
  var ytdFrom = now.getFullYear() + '-01';
  var ytdTo = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  var ytdActuals = actuals.filter(function(a) { return a.month >= ytdFrom && a.month <= ytdTo; });
  var ytdRev = 0, ytdNights = 0, ytdAvail = 0, ytdPayout = 0;
  ytdActuals.forEach(function(a) { ytdRev += a.total_revenue || 0; ytdNights += a.booked_nights || 0; ytdAvail += a.available_nights || 30; ytdPayout += a.host_payout || 0; });
  var ytdOcc = ytdAvail > 0 ? Math.round(ytdNights / ytdAvail * 100) : 0;
  var ytdAdr = ytdNights > 0 ? Math.round(ytdRev / ytdNights) : 0;

  if (totalRes > 0) {
    if (guBadge) guBadge.innerHTML = ispBadge('● Active', '#60a5fa');
    var html = '';
    // Show YTD financial metrics if we have actuals
    if (ytdRev > 0) {
      html += '<div class="intg-meta" style="font-weight:600;color:#60a5fa;margin-bottom:4px;">' + _ico('calendar', 13) + ' Year to Date (' + now.getFullYear() + ')</div>';
      html += '<div class="intg-stat-grid">';
      html += ispPill('Revenue', '$' + Math.round(ytdRev).toLocaleString(), 'var(--accent)');
      html += ispPill('Payout', '$' + Math.round(ytdPayout).toLocaleString(), 'var(--accent)');
      html += ispPill('Occupancy', ytdOcc + '%', ytdOcc >= 50 ? 'var(--accent)' : ytdOcc >= 30 ? '#f59e0b' : 'var(--danger)');
      html += ispPill('ADR', '$' + ytdAdr, 'var(--text)');
      html += '</div>';
      html += '<div class="intg-meta" style="font-size:0.65rem;color:var(--text3);">Revenue = gross booking income (accommodation + cleaning) · Payout = what you receive after platform fees & commissions</div>';
    }
    // Operational stats
    html += '<div class="intg-stat-grid" style="margin-top:6px;">';
    html += ispPill('Confirmed', confirmed.toLocaleString(), '#60a5fa');
    html += ispPill('Cancel Rate', cancelRate + '%', cancelRate > 15 ? 'var(--danger)' : 'var(--text)');
    html += ispPill('Listings', matched + '/' + listings + ' linked');
    html += '</div>';
    if (byChannel.length) {
      html += '<div class="intg-meta">Channels: ' + byChannel.slice(0,4).map(function(c){ return esc(c.channel||'Direct') + ' (' + c.c + ')'; }).join(' · ') + '</div>';
    }
    if (guStats) guStats.innerHTML = html;
  } else {
    if (guBadge) guBadge.innerHTML = ispBadge('○ No data', 'var(--text3)');
    if (guStats) guStats.innerHTML = '<div style="padding:8px 0;color:var(--text3);">No reservations imported yet. <a href="#" onclick="showPmsDetail(\'guesty\');return false;" style="color:#60a5fa;">Import Guesty CSV →</a></div>';
  }

  // ── PriceLabs ────────────────────────────────────────────────────────────
  var plBadge = document.getElementById('pmsCard-pricelabs-badge');
  var plStats = document.getElementById('pmsCard-pricelabs-stats');
  var total2   = pd ? (pd.listing_count || 0) : 0;
  var linkedPL = pd ? (pd.linked_count || 0) : 0;
  var unlinked = total2 - linkedPL;
  var lastSync = pd ? pd.last_sync : null;
  var rateCount = pd ? (pd.rate_count || 0) : 0;

  if (total2 > 0) {
    if (plBadge) plBadge.innerHTML = ispBadge('● ' + total2 + ' listings', '#a78bfa');
    var html2 = '<div class="intg-stat-grid">';
    html2 += ispPill('Listings Synced', total2, '#a78bfa');
    html2 += ispPill('Linked to Properties', linkedPL + ' / ' + total2, linkedPL === total2 ? 'var(--accent)' : '#f59e0b');
    if (rateCount > 0) html2 += ispPill('Rates Stored', rateCount.toLocaleString());
    html2 += '</div>';
    if (lastSync) html2 += '<div class="intg-meta">Last synced: ' + fmtUTC(lastSync) + '</div>';
    if (unlinked > 0) html2 += '<div class="intg-meta" style="color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' ' + unlinked + ' listing' + (unlinked > 1 ? 's' : '') + ' not linked to a property</div>';
    if (plStats) plStats.innerHTML = html2;
  } else {
    if (plBadge) plBadge.innerHTML = ispBadge('○ Not synced', 'var(--text3)');
    if (plStats) plStats.innerHTML = '<div style="padding:8px 0;color:var(--text3);">No PriceLabs listings synced yet. <a href="#" onclick="showPmsDetail(\'pricelabs\');return false;" style="color:#a78bfa;">Sync now →</a></div>';
  }

  // ── Cloudflare card ──────────────────────────────────────────────────────
  var cfBadge = document.getElementById('pmsCard-cf-badge');
  var cfStats = document.getElementById('pmsCard-cf-stats');
  try {
    var cfd = await api('/api/cf-usage');
    if (cfd && cfd.today) {
      var todayReq = cfd.today.requests || 0;
      var monthReq = cfd.this_month ? (cfd.this_month.requests || 0) : 0;
      var dbRows   = cfd.database ? (cfd.database.total_rows || 0) : 0;
      var todayPct = cfd.today.pct_of_limit || 0;
      if (cfBadge) cfBadge.innerHTML = ispBadge('● Active', '#f6821f');
      var cfh = '<div class="intg-stat-grid">';
      cfh += ispPill('Requests Today', todayReq.toLocaleString(), todayPct > 80 ? 'var(--danger)' : todayPct > 50 ? '#f59e0b' : '#f6821f');
      cfh += ispPill('This Month', monthReq.toLocaleString());
      cfh += ispPill('DB Rows', dbRows.toLocaleString());
      cfh += ispPill('Daily Limit Used', todayPct + '%', todayPct > 80 ? 'var(--danger)' : 'var(--accent)');
      cfh += '</div>';
      if (cfStats) cfStats.innerHTML = cfh;
    } else {
      if (cfBadge) cfBadge.innerHTML = ispBadge('○ No data', 'var(--text3)');
      if (cfStats) cfStats.innerHTML = '<div style="padding:8px 0;color:var(--text3);">Could not load usage data.</div>';
    }
  } catch(e) {
    if (cfBadge) cfBadge.innerHTML = ispBadge('● Active', '#f6821f');
    if (cfStats) cfStats.innerHTML = '<div style="padding:8px 0;color:var(--text3);">Workers · D1 · $5/mo flat</div>';
  }
}

function ispBadge(text, color) {
  return '<span style="font-size:0.68rem;color:' + color + ';background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:2px 8px;white-space:nowrap;">' + text + '</span>';
}

function ispPill(label, val, color) {
  return '<div class="intg-stat-pill"><div class="isp-label">' + label + '</div><div class="isp-val" style="color:' + (color||'var(--text)') + ';">' + val + '</div></div>';
}

function badge(text, color, bg, border) {
  return '<span style="font-size:0.68rem;color:' + color + ';background:' + bg + ';border:1px solid ' + border + ';border-radius:4px;padding:2px 8px;white-space:nowrap;">' + text + '</span>';
}

function statRow(label, val) {
  return '<div style="display:flex;justify-content:space-between;align-items:baseline;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">' +
    '<span style="font-size:0.78rem;color:var(--text3);">' + label + '</span>' +
    '<span style="font-size:0.88rem;font-weight:600;color:var(--text2);">' + val + '</span>' +
    '</div>';
}

function fmtDate(d) {
  if (!d) return '—';
  return d.substring(0, 7);
}


async function loadPLListingsGrid() {
  var el = document.getElementById('plListingsGrid');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;">Loading...</div>';
  try {
    var d = await api('/api/pricelabs/listings');
    var listings = d.listings || [];
    if (!listings.length) {
      el.innerHTML = '<p style="color:var(--text3);">No PriceLabs listings synced yet. Click Sync All above.</p>';
      return;
    }
    var h = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;">';
    listings.forEach(function(l) {
      var linked = l.property_id;
      h += '<div style="padding:12px;background:var(--bg);border:1px solid ' + (linked ? 'rgba(167,139,250,0.3)' : 'var(--border)') + ';border-radius:8px;">';
      h += '<div style="font-size:0.82rem;font-weight:600;color:var(--text2);margin-bottom:6px;">' + esc(l.name || l.pl_listing_id) + '</div>';
      if (l.base_price) h += '<div style="font-size:0.78rem;color:var(--text3);">Base: <strong style="color:var(--text);">$' + l.base_price + '/nt</strong></div>';
      if (l.min_price)  h += '<div style="font-size:0.78rem;color:var(--text3);">Min: $' + l.min_price + ' &nbsp; Max: $' + (l.max_price || '—') + '</div>';
      h += '<div style="margin-top:6px;font-size:0.68rem;">' + (linked ? '<span style="color:var(--accent);">● Linked to property</span>' : '<span style="color:var(--text3);">○ Not linked</span>') + '</div>';
      h += '</div>';
    });
    h += '</div>';
    el.innerHTML = h;
  } catch(err) {
    el.innerHTML = '<p style="color:var(--danger);">' + esc(err.message) + '</p>';
  }
}

async function loadCfDetail() {
  var el = document.getElementById('cfDetailContent');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;">Loading...</div>';
  try {
    var d = await api('/api/cf-usage');
    var todayPct = d.today.pct_of_limit || 0;
    var todayColor = todayPct > 80 ? 'var(--danger)' : todayPct > 50 ? '#f59e0b' : 'var(--accent)';
    var h = '<div class="intg-stat-grid" style="margin-bottom:14px;">';
    h += ispPill('Requests Today', (d.today.requests || 0).toLocaleString(), todayColor);
    h += ispPill('API Calls Today', (d.today.api_requests || 0).toLocaleString());
    h += ispPill('This Month', (d.this_month ? (d.this_month.requests || 0) : 0).toLocaleString());
    h += ispPill('Avg/Day', '~' + (d.this_month ? (d.this_month.avg_per_day || 0) : 0).toLocaleString());
    h += ispPill('DB Rows', (d.database ? (d.database.total_rows || 0) : 0).toLocaleString());
    h += ispPill('Tables', (d.database ? (d.database.table_count || 0) : 0));
    h += '</div>';

    h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:4px;">Daily limit: ' + (d.today.requests || 0).toLocaleString() + ' / ' + (d.limits ? (d.limits.requests_per_day || 333333) : 333333).toLocaleString() + ' (' + todayPct + '%)</div>';
    h += '<div style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;margin-bottom:14px;"><div style="height:100%;width:' + Math.min(todayPct, 100) + '%;background:' + todayColor + ';border-radius:3px;"></div></div>';

    if (d.last_7_days && d.last_7_days.length > 0) {
      var maxReqs = Math.max.apply(null, d.last_7_days.map(function(r) { return r.requests || 0; }));
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:6px;font-weight:600;">LAST 7 DAYS</div>';
      h += '<div style="display:flex;gap:4px;align-items:flex-end;height:50px;margin-bottom:14px;">';
      d.last_7_days.forEach(function(day) {
        var pct = maxReqs > 0 ? Math.round((day.requests || 0) / maxReqs * 100) : 0;
        h += '<div style="flex:1;text-align:center;">';
        h += '<div style="background:#f6821f;border-radius:3px 3px 0 0;height:' + Math.max(pct, 3) + '%;min-height:3px;opacity:0.75;" title="' + (day.date || '') + ': ' + (day.requests || 0) + ' requests"></div>';
        h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:2px;">' + (day.date || '').substring(5) + '</div></div>';
      });
      h += '</div>';
    }

    h += '<div style="padding:10px 14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);font-size:0.72rem;color:var(--text3);line-height:1.8;">';
    h += '<div style="font-weight:600;color:var(--text2);margin-bottom:4px;">Plan limits</div>';
    h += '<div>Workers Paid: 10M requests/month</div>';
    h += '<div>D1 Database: 25M reads/day · 50M writes/day · 5GB storage</div>';
    h += '<div style="color:var(--accent);font-weight:600;margin-top:4px;">$5/month flat</div>';
    h += '</div>';
    el.innerHTML = h;
  } catch(e) {
    el.innerHTML = '<div style="color:var(--danger);font-size:0.82rem;">Failed to load: ' + esc(e.message) + '</div>';
  }
}
