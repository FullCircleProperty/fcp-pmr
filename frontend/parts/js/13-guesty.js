// Guesty Import

async function loadGuestyStats() {
  var el = document.getElementById('guestyStats');
  if (!el) return;
  try {
    // Load actuals data for filtering
    var actualsResp = await api('/api/guesty/actuals');
    allActualsData = actualsResp.actuals || [];

    // Load listings
    var statsResp = await api('/api/guesty/stats');
    window._guestyStatsData = statsResp;

    if (allActualsData.length === 0 && (statsResp.total_reservations || 0) === 0) {
      el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);">No Guesty data imported yet. Export a reservations CSV from Guesty and import it above.</div>';
      return;
    }

    // Render filtered stats
    renderFilteredStats();

    // Channel breakdown (from API - not filtered, shows totals)
    var chEl = document.getElementById('guestyChannelBreakdown');
    if (chEl && statsResp.by_channel && statsResp.by_channel.length > 0) {
      var ch = '';
      statsResp.by_channel.forEach(function(c) {
        var name = c.channel || 'Unknown';
        if (name.match(/^\d{4}-/) || name.length > 30) return;
        ch += '<div style="padding:4px 10px;background:var(--surface2);border-radius:6px;font-size:0.75rem;">';
        ch += '<strong>' + esc(name) + '</strong> · ' + c.c + ' bookings';
        if (c.payout) ch += ' · <span style="color:var(--accent);">$' + Math.round(c.payout).toLocaleString() + '</span>';
        ch += '</div>';
      });
      chEl.innerHTML = ch;
    }

    // Load listings
    loadGuestyListings();
  } catch (err) { el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">' + esc(err.message) + '</span>'; }
}

async function uploadGuestyCsv() {
  var input = document.getElementById('guestyCsvInput');
  var status = document.getElementById('guestyImportStatus');
  var preview = document.getElementById('guestyPreview');
  if (!input || !input.files || !input.files[0]) { toast('Select a CSV file', 'error'); return; }

  var file = input.files[0];
  if (status) { status.style.display = ''; status.innerHTML ='' + _ico('clock', 13) + ' Reading CSV...'; }

  var reader = new FileReader();
  reader.onload = async function(e) {
    var text = e.target.result;
    // Parse CSV
    var lines = text.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
    if (lines.length < 2) { status.innerHTML = '<span style="color:var(--danger);">CSV has no data rows.</span>'; return; }

    // Handle quoted CSV properly
    function parseCsvLine(line) {
      var result = [], current = '', inQuotes = false;
      for (var i = 0; i < line.length; i++) {
        var c = line[i];
        if (c === '"') { inQuotes = !inQuotes; continue; }
        if (c === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += c;
      }
      result.push(current.trim());
      return result;
    }

    var headers = parseCsvLine(lines[0]);
    var rows = [];
    for (var i = 1; i < lines.length; i++) {
      var row = parseCsvLine(lines[i]);
      if (row.length >= 3) rows.push(row); // skip empty/malformed
    }

    if (status) status.innerHTML ='' + _ico('clock', 13) + ' Parsed ' + rows.length + ' rows with ' + headers.length + ' columns. Importing...';

    // Show preview
    if (preview) {
      var ph = '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:4px;">PREVIEW (first 3 rows)</div>';
      ph += '<div style="overflow-x:auto;max-height:150px;"><table style="font-size:0.68rem;border-collapse:collapse;width:100%;">';
      ph += '<thead><tr style="background:var(--surface2);">' + headers.map(function(h) { return '<th style="padding:3px 6px;text-align:left;white-space:nowrap;color:var(--text3);">' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
      rows.slice(0, 3).forEach(function(r) {
        ph += '<tr>' + r.map(function(v) { return '<td style="padding:2px 6px;border-top:1px solid var(--border);white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis;">' + esc((v || '').substring(0, 40)) + '</td>'; }).join('') + '</tr>';
      });
      ph += '</tbody></table></div>';
      preview.style.display = '';
      preview.innerHTML = ph;
    }

    // Send to backend
    try {
      var d = await api('/api/guesty/import', 'POST', { headers: headers, rows: rows, file_name: file.name });
      var rh = '<div style="padding:12px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:8px;">';
      rh += '<div style="font-weight:600;color:var(--accent);margin-bottom:6px;">' + _ico('check', 13, 'var(--accent)') + ' Import Complete</div>';
      rh += '<div style="font-size:0.82rem;">' + d.imported + ' reservations imported, ' + d.skipped + ' skipped, ' + d.errors + ' errors</div>';
      rh += '<div style="font-size:0.82rem;">' + d.listings_found + ' listings found, ' + d.auto_matched + ' auto-matched to properties</div>';
      if (d.column_mapping) {
        rh += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">Columns mapped: ' + Object.entries(d.column_mapping).map(function(e) { return '<strong>' + e[0] + '</strong>→' + e[1]; }).join(', ') + '</div>';
      }
      rh += '</div>';
      if (status) status.innerHTML = rh;
      loadGuestyStats();
    } catch (err) {
      if (status) status.innerHTML = '<span style="color:var(--danger);">Import failed: ' + esc(err.message) + '</span>';
    }
  };
  reader.readAsText(file);
}

async function loadGuestyListings() {
  var el = document.getElementById('guestyListings');
  if (!el) return;
  try {
    var d = await api('/api/guesty/listings');
    var listings = d.listings || [];
    if (listings.length === 0) { el.innerHTML = ''; return; }

    // Collect already-linked property IDs so we can exclude them from dropdowns
    var linkedPropIds = new Set();
    listings.forEach(function(gl) { if (gl.property_id) linkedPropIds.add(gl.property_id); });

    var h = '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:6px;">GUESTY LISTING MATCHES (' + listings.length + ')</div>';
    listings.forEach(function(gl) {
      var matched = !!gl.property_id;
      h += '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:3px;background:var(--' + (matched ? 'bg' : 'surface2') + ');border-radius:6px;border:1px solid ' + (matched ? 'rgba(16,185,129,0.2)' : 'var(--border)') + ';">';
      h += '<span style="color:' + (matched ? 'var(--accent)' : '#f59e0b') + ';font-size:1rem;">' + (matched ? '✓' : '?') + '</span>';
      h += '<div style="flex:1;min-width:0;">';
      h += '<div style="font-size:0.82rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(gl.listing_name) + '</div>';
      h += '<div style="font-size:0.68rem;color:var(--text3);">' + (gl.reservation_count || 0) + ' reservations';
      if (gl.listing_address) h += ' · <span style="color:var(--text2);">' + esc(gl.listing_address) + '</span>';
      if (matched) h += ' · Linked to: <strong style="color:var(--accent);">' + esc(gl.prop_name || gl.prop_address || '') + (gl.prop_unit ? ' #' + gl.prop_unit : '') + '</strong>';
      if (gl.auto_matched) h += ' <span style="color:var(--purple);font-size:0.62rem;">(auto ' + Math.round((gl.match_score || 0) * 100) + '%)</span>';
      h += '</div></div>';

      if (matched) {
        h += '<button class="btn btn-xs" onclick="unlinkGuestyListing(\'' + esc(gl.guesty_listing_id) + '\')" style="font-size:0.68rem;">Unlink</button>';
      } else {
        h += '<select id="gl_link_' + gl.id + '" style="font-size:0.75rem;max-width:200px;"><option value="">Link to property...</option>';
        properties.forEach(function(p) {
          // Skip properties already linked to other Guesty listings
          if (linkedPropIds.has(p.id)) return;
          // Skip building parents (only show units/standalone)
          if (p.child_count > 0) return;
          // Skip research properties — they don't have Guesty listings
          if (p.is_research) return;
          var label = (p.unit_number ? p.unit_number + ' — ' : '') + (p.name || p.address || 'Property ' + p.id) + ' (' + (p.city || '') + ')';
          h += '<option value="' + p.id + '">' + esc(label) + '</option>';
        });
        h += '</select>';
        h += '<button class="btn btn-xs btn-primary" onclick="linkGuestyListing(\'' + esc(gl.guesty_listing_id) + '\', ' + gl.id + ')" style="font-size:0.68rem;">Link</button>';
        h += '<button class="btn btn-xs" onclick="showCreatePropertyFromListing(\'' + esc(gl.guesty_listing_id) + '\', ' + gl.id + ')" style="font-size:0.68rem;color:#60a5fa;" title="Create a new property from this listing\'s details">+ New</button>';
      }
      h += '</div>';
    });
    el.innerHTML = h;
  } catch {}
}

async function linkGuestyListing(guestyId, rowId) {
  var sel = document.getElementById('gl_link_' + rowId);
  if (!sel || !sel.value) { toast('Select a property', 'error'); return; }
  try {
    var d = await api('/api/guesty/listings/link', 'POST', { guesty_listing_id: guestyId, property_id: parseInt(sel.value) });
    var count = d.linked_reservations || 0;
    toast('Listing linked — ' + count + ' reservation' + (count !== 1 ? 's' : '') + ' matched. Monthly actuals rebuilt.');
    loadGuestyListings();
    loadGuestyStats();
  } catch (err) { toast(err.message, 'error'); }
}

async function unlinkGuestyListing(guestyId) {
  try {
    await api('/api/guesty/listings/unlink', 'POST', { guesty_listing_id: guestyId });
    toast('Listing unlinked');
    loadGuestyListings();
    loadGuestyStats();
  } catch (err) { toast(err.message, 'error'); }
}

async function processGuestyData() {
  showLoading('Processing Guesty data into monthly actuals and seasonality...');
  try {
    var d = await api('/api/guesty/process', 'POST');
    toast(d.message);
    loadGuestyStats();
    loadMonthlyActuals();
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

async function rematchGuestyListings() {
  showLoading('Re-matching Guesty listings to properties...');
  try {
    var d = await api('/api/guesty/rematch', 'POST');
    toast(d.message);
    loadGuestyStats();
    loadGuestyListings();
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

function loadPmsDashboard() {
  loadGuestyConnection();
  loadGuestyStats();
  loadMonthlyActuals();
  loadAlgoHealth();
  loadSyncDashboard();
}

var allActualsData = [];
var allGuestyReservations = [];
var actualsFilterMode = 'ytd';

function filterActuals(mode) {
  actualsFilterMode = mode;
  document.querySelectorAll('.actuals-filter').forEach(function(btn) {
    var btnMode = btn.textContent.toLowerCase().replace(/\s/g, '');
    btn.classList.toggle('active', btnMode === mode || (mode === 'custom' && btnMode === 'custom'));
  });
  renderFilteredStats();
  renderFilteredActuals();
}

function getFilterDateRange(mode) {
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  var from = '2000-01-01', to = '2099-12-31';
  switch (mode) {
    case 'thismonth':
      from = y + '-' + String(m).padStart(2, '0') + '-01';
      to = y + '-' + String(m).padStart(2, '0') + '-31';
      break;
    case 'lastmonth':
      var lm = m === 1 ? 12 : m - 1, ly = m === 1 ? y - 1 : y;
      from = ly + '-' + String(lm).padStart(2, '0') + '-01';
      to = ly + '-' + String(lm).padStart(2, '0') + '-31';
      break;
    case 'ytd':
      from = y + '-01-01'; to = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      break;
    case 'thisyear':
      from = y + '-01-01'; to = y + '-12-31';
      break;
    case 'lastyear':
      from = (y - 1) + '-01-01'; to = (y - 1) + '-12-31';
      break;
    case 'custom':
      var afv = (document.getElementById('actualsFrom') || {}).value || '';
      var atv = (document.getElementById('actualsTo') || {}).value || '';
      if (afv) from = afv.substring(0, 7) + '-01';
      if (atv) to = atv.substring(0, 7) + '-31';
      break;
    case 'all': break;
  }
  return { from: from, to: to };
}

function renderFilteredStats() {
  var el = document.getElementById('guestyStats');
  if (!el) return;
  var range = getFilterDateRange(actualsFilterMode);
  var fromMonth = range.from.substring(0, 7);
  var toMonth = range.to.substring(0, 7);

  // Filter actuals by date range
  var filtered = allActualsData.filter(function(a) { return a.month >= fromMonth && a.month <= toMonth; });

  // Aggregate
  var totalRev = 0, totalNights = 0, totalAvail = 0, totalPayout = 0, totalBookings = 0, totalCleaning = 0;
  var propTotals = {};
  filtered.forEach(function(a) {
    totalRev += a.total_revenue || 0;
    totalNights += a.booked_nights || 0;
    totalAvail += a.available_nights || 30;
    totalPayout += a.host_payout || 0;
    totalBookings += a.num_reservations || 0;
    totalCleaning += a.cleaning_revenue || 0;
    var pk = a.property_id;
    if (!propTotals[pk]) propTotals[pk] = { name: (a.unit_number ? a.unit_number + ' — ' : '') + (a.prop_name || a.prop_address), revenue: 0, nights: 0, available: 0, payout: 0, bookings: 0 };
    propTotals[pk].revenue += a.total_revenue || 0;
    propTotals[pk].nights += a.booked_nights || 0;
    propTotals[pk].available += a.available_nights || 30;
    propTotals[pk].payout += a.host_payout || 0;
    propTotals[pk].bookings += a.num_reservations || 0;
  });

  var propCount = Object.keys(propTotals).length;
  var overallOcc = totalAvail > 0 ? Math.round(totalNights / totalAvail * 100) : 0;
  var overallAdr = totalNights > 0 ? Math.round(totalRev / totalNights) : 0;

  // Period label — always show what time range is displayed
  var periodLabel = actualsFilterMode === 'thismonth' ? 'This Month' : actualsFilterMode === 'lastmonth' ? 'Last Month' : actualsFilterMode === 'ytd' ? 'Year to Date' : actualsFilterMode === 'thisyear' ? 'This Year' : actualsFilterMode === 'lastyear' ? 'Last Year' : actualsFilterMode === 'all' ? 'All Time' : 'Custom';
  var h = '<div style="padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;">';
  h += '<span style="font-size:0.85rem;font-weight:600;color:var(--accent);">' + _ico('calendar', 13) + ' ' + periodLabel + ': ' + fromMonth + ' to ' + toMonth + '</span>';
  h += '<span style="font-size:0.72rem;color:var(--text3);">' + propCount + ' properties · ' + filtered.length + ' monthly records · Source: Guesty confirmed only</span>';
  h += '</div>';

  if (filtered.length === 0) {
    h += '<div style="padding:12px;font-size:0.82rem;color:var(--text3);text-align:center;">No data for this period.</div>';
    el.innerHTML = h;
    return;
  }

  h += '<div class="market-grid" style="margin-bottom:10px;">';
  h += '<div class="market-stat"><div class="val" style="color:var(--accent);">$' + Math.round(totalRev).toLocaleString() + '</div><div class="lbl">Revenue</div></div>';
  h += '<div class="market-stat"><div class="val" style="color:var(--accent);">$' + Math.round(totalPayout).toLocaleString() + '</div><div class="lbl">Payout</div></div>';
  h += '<div class="market-stat"><div class="val">' + totalBookings + '</div><div class="lbl">Bookings</div></div>';
  h += '<div class="market-stat"><div class="val">' + totalNights + '</div><div class="lbl">Booked Nights</div></div>';
  h += '<div class="market-stat"><div class="val" style="color:' + (overallOcc >= 50 ? 'var(--accent)' : overallOcc >= 30 ? '#f59e0b' : 'var(--danger)') + ';">' + overallOcc + '%</div><div class="lbl">Avg Occupancy</div></div>';
  h += '<div class="market-stat"><div class="val">$' + overallAdr + '</div><div class="lbl">Avg ADR</div></div>';
  // Add cancellation/inquiry stats from API data
  var stats = window._guestyStatsData;
  if (stats) {
    if (stats.canceled_count > 0) h += '<div class="market-stat"><div class="val" style="color:var(--danger);">' + stats.canceled_count + '</div><div class="lbl">Cancellations (' + stats.cancellation_rate + '%)</div></div>';
    if (stats.inquiry_count > 0) h += '<div class="market-stat"><div class="val" style="color:#f59e0b;">' + stats.inquiry_count + '</div><div class="lbl">Inquiries (' + stats.conversion_rate + '% converted)</div></div>';
    h += '<div class="market-stat"><div class="val">' + stats.matched_listings + '/' + stats.total_listings + '</div><div class="lbl">Listings Matched</div></div>';
    if (stats.refund_summary && (stats.refund_summary.total_refunded > 0 || stats.refund_summary.total_canceled_payout > 0)) {
      var rs = stats.refund_summary;
      h += '<div class="market-stat"><div class="val" style="color:var(--danger);">$' + Math.round(rs.total_refunded || 0).toLocaleString() + '</div><div class="lbl">Total Refunded (' + rs.refund_count + ')</div></div>';
      if (rs.total_cancel_fees > 0) h += '<div class="market-stat"><div class="val" style="color:#f59e0b;">$' + Math.round(rs.total_cancel_fees).toLocaleString() + '</div><div class="lbl">Cancel Fees Retained</div></div>';
      if (rs.total_canceled_payout > 0) h += '<div class="market-stat"><div class="val" style="color:var(--danger);">$' + Math.round(rs.total_canceled_payout).toLocaleString() + '</div><div class="lbl">Lost Payout (Canceled)</div></div>';
    }
  }
  h += '</div>';
  h += '<div style="font-size:0.68rem;color:var(--text3);margin-bottom:8px;">Revenue = gross booking income (accommodation + cleaning fees) · Payout = what you receive after platform fees & commissions · ADR = avg nightly rate</div>';

  // Per-property summary
  var propList = Object.values(propTotals).sort(function(a, b) { return b.revenue - a.revenue; });
  if (propList.length > 0) {
    h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.75rem;"><thead><tr>';
    h += '<th>Property</th><th>Nights</th><th>Occ% ⓘ</th><th>ADR ⓘ</th><th>Revenue</th><th>Payout</th><th>Bookings</th>';
    h += '</tr></thead><tbody>';
    propList.forEach(function(p) {
      var occ = p.available > 0 ? Math.round(p.nights / p.available * 100) : 0;
      var adr = p.nights > 0 ? Math.round(p.revenue / p.nights) : 0;
      var occColor = occ >= 50 ? 'var(--accent)' : occ >= 30 ? '#f59e0b' : 'var(--danger)';
      h += '<tr><td style="font-weight:600;">' + esc(p.name) + '</td>';
      h += '<td>' + p.nights + '/' + p.available + '</td>';
      h += '<td style="color:' + occColor + ';font-weight:600;">' + occ + '%</td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + adr + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(p.revenue).toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(p.payout).toLocaleString() + '</td>';
      h += '<td>' + p.bookings + '</td></tr>';
    });
    // Total row
    h += '<tr style="background:rgba(167,139,250,0.06);font-weight:600;">';
    h += '<td style="color:var(--purple);">TOTAL</td>';
    h += '<td>' + totalNights + '/' + totalAvail + '</td>';
    h += '<td style="color:var(--purple);">' + overallOcc + '%</td>';
    h += '<td style="font-family:DM Mono,monospace;">$' + overallAdr + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--purple);">$' + Math.round(totalRev).toLocaleString() + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--purple);">$' + Math.round(totalPayout).toLocaleString() + '</td>';
    h += '<td>' + totalBookings + '</td></tr>';
    h += '</tbody></table></div>';
  }

  // Channel breakdown from filtered period
  h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;" id="guestyChannelBreakdown"></div>';

  el.innerHTML = h;
}

function renderFilteredActuals() {
  var range = getFilterDateRange(actualsFilterMode);
  var fromMonth = range.from.substring(0, 7);
  var toMonth = range.to.substring(0, 7);
  var filtered = allActualsData.filter(function(a) { return a.month >= fromMonth && a.month <= toMonth; });

  var sumEl = document.getElementById('actualsFilterSummary');
  if (sumEl) {
    var periodLabel = actualsFilterMode === 'thismonth' ? 'This Month' : actualsFilterMode === 'lastmonth' ? 'Last Month' : actualsFilterMode === 'ytd' ? 'YTD' : actualsFilterMode === 'thisyear' ? 'This Year' : actualsFilterMode === 'lastyear' ? 'Last Year' : actualsFilterMode === 'all' ? 'All Time' : 'Custom';
    if (filtered.length > 0) {
      var totalRev = 0, totalNights = 0, totalAvail = 0;
      filtered.forEach(function(a) { totalRev += a.total_revenue || 0; totalNights += a.booked_nights || 0; totalAvail += a.available_nights || 30; });
      var overallOcc = totalAvail > 0 ? Math.round(totalNights / totalAvail * 100) : 0;
      var overallAdr = totalNights > 0 ? Math.round(totalRev / totalNights) : 0;
      sumEl.innerHTML = '<span style="color:var(--accent);font-weight:600;">' + _ico('calendar', 13) + ' ' + periodLabel + '</span> · ' + fromMonth + ' to ' + toMonth + ' · ' +
        new Set(filtered.map(function(a) { return a.property_id; })).size + ' properties · ' +
        overallOcc + '% occ · $' + overallAdr + ' ADR · <span style="color:var(--accent);">$' + Math.round(totalRev).toLocaleString() + ' revenue</span>';
    } else {
      sumEl.innerHTML = '<span style="color:var(--accent);">' + _ico('calendar', 13) + ' ' + periodLabel + '</span> · ' + fromMonth + ' to ' + toMonth + ' · No data for this period';
    }
  }

  renderActualsTables(filtered);
}

function renderActualsTables(actuals) {
  var el = document.getElementById('monthlyActualsContent');
  if (!el) return;
  if (!actuals || actuals.length === 0) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:10px;">No data for this period.</div>';
    return;
  }

  var byProp = {};
  actuals.forEach(function(a) {
    var key = a.property_id;
    if (!byProp[key]) byProp[key] = { name: (a.unit_number ? a.unit_number + ' — ' : '') + (a.prop_name || a.prop_address), city: a.city, state: a.state, months: [] };
    byProp[key].months.push(a);
  });

  var h = '';
  var propIdx = 0;
  for (var propId in byProp) {
      var p = byProp[propId];
      var months = p.months.sort(function(a, b) { return a.month.localeCompare(b.month); });
      var totalRev = 0, totalNights = 0, totalPayout = 0;
      months.forEach(function(m) { totalRev += m.total_revenue || 0; totalNights += m.booked_nights || 0; totalPayout += m.host_payout || 0; });
      var avgOcc = months.length > 0 ? Math.round(months.reduce(function(a, m) { return a + (m.occupancy_pct || 0); }, 0) / months.length * 100) : 0;
      var avgAdr = totalNights > 0 ? Math.round(totalRev / totalNights) : 0;
      var tableId = 'actualsTable_' + propIdx;

      h += '<div style="margin-bottom:8px;">';
      // Property header — clickable to expand/collapse
      h += '<div data-prop-header="' + esc(p.name) + '" style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--surface2);border-radius:6px;cursor:pointer;border:1px solid var(--border);" onclick="toggleActualsProp(this.querySelector(\'.actuals-prop-toggle\'))">';
      h += '<div style="display:flex;align-items:center;gap:8px;">';
      h += '<button class="actuals-prop-toggle" data-target="' + tableId + '" onclick="event.stopPropagation();toggleActualsProp(this)" style="background:none;border:1px solid var(--border);border-radius:4px;width:22px;height:22px;font-size:0.85rem;cursor:pointer;color:var(--text2);display:flex;align-items:center;justify-content:center;">+</button>';
      h += '<strong style="font-size:0.85rem;">' + esc(p.name) + '</strong>';
      h += '</div>';
      h += '<div style="display:flex;gap:12px;font-size:0.72rem;color:var(--text3);align-items:center;">';
      h += '<span>' + esc(p.city) + ', ' + esc(p.state) + '</span>';
      h += '<span>' + months.length + ' mo</span>';
      h += '<span style="color:' + (avgOcc >= 50 ? 'var(--accent)' : avgOcc >= 30 ? '#f59e0b' : 'var(--danger)') + ';font-weight:600;">' + avgOcc + '% occ</span>';
      h += '<span>$' + avgAdr + ' ADR</span>';
      h += '<span style="color:var(--accent);font-weight:600;">$' + Math.round(totalRev).toLocaleString() + '</span>';
      h += '<span style="font-weight:600;">$' + Math.round(totalPayout).toLocaleString() + ' payout</span>';
      h += '</div>';
      h += '</div>';
      // Table — hidden by default
      h += '<div id="' + tableId + '" style="display:none;margin-top:2px;">';
      h += '<table class="comp-table" style="font-size:0.75rem;"><thead><tr>';
      var colInfo = {
        'Month': 'Calendar month',
        'Nights': 'Booked nights / available nights in month',
        'Occ%': 'Occupancy — % of available nights booked',
        'ADR': 'Average Daily Rate — revenue ÷ booked nights',
        'Revenue': 'Total nightly revenue (accommodation fare)',
        'Cleaning': 'Cleaning fees charged to guests',
        'Payout': 'Host payout after platform fees',
        'Bookings': 'Number of unique reservations',
        'Avg Stay': 'Average nights per booking in this month'
      };
      ['Month', 'Nights', 'Occ%', 'ADR', 'Revenue', 'Cleaning', 'Payout', 'Bookings', 'Avg Stay'].forEach(function(t) {
        h += '<th title="' + (colInfo[t] || '') + '">' + t + (colInfo[t] ? ' <span style="color:var(--text3);cursor:help;font-size:0.62rem;">ⓘ</span>' : '') + '</th>';
      });
      h += '</tr></thead><tbody>';
      var currentYear = '';
      var yearTotals = { nights: 0, available: 0, revenue: 0, cleaning: 0, payout: 0, bookings: 0 };
      months.forEach(function(m, idx) {
        var yr = m.month.substring(0, 4);
        // Year separator and totals for previous year
        if (currentYear && yr !== currentYear) {
          var yrOcc = yearTotals.available > 0 ? Math.round(yearTotals.nights / yearTotals.available * 100) : 0;
          var yrAdr = yearTotals.nights > 0 ? Math.round(yearTotals.revenue / yearTotals.nights) : 0;
          h += '<tr style="background:rgba(167,139,250,0.06);font-weight:600;">';
          h += '<td style="color:var(--purple);">' + currentYear + ' Total</td>';
          h += '<td>' + yearTotals.nights + '/' + yearTotals.available + '</td>';
          h += '<td style="color:var(--purple);">' + yrOcc + '%</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + yrAdr + '</td>';
          h += '<td style="font-family:DM Mono,monospace;color:var(--purple);">$' + Math.round(yearTotals.revenue).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(yearTotals.cleaning).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;color:var(--purple);">$' + Math.round(yearTotals.payout).toLocaleString() + '</td>';
          h += '<td>' + yearTotals.bookings + '</td><td></td></tr>';
          h += '<tr><td colspan="9" style="padding:2px;background:var(--border);"></td></tr>';
          yearTotals = { nights: 0, available: 0, revenue: 0, cleaning: 0, payout: 0, bookings: 0 };
        }
        currentYear = yr;
        yearTotals.nights += m.booked_nights || 0;
        yearTotals.available += m.available_nights || 30;
        yearTotals.revenue += m.total_revenue || 0;
        yearTotals.cleaning += m.cleaning_revenue || 0;
        yearTotals.payout += m.host_payout || 0;
        yearTotals.bookings += m.num_reservations || 0;

        var occColor = (m.occupancy_pct || 0) >= 0.6 ? 'var(--accent)' : (m.occupancy_pct || 0) >= 0.4 ? '#f59e0b' : 'var(--danger)';
        h += '<tr>';
        h += '<td style="font-weight:600;">' + m.month + '</td>';
        h += '<td>' + (m.booked_nights || 0) + '/' + (m.available_nights || 30) + '</td>';
        h += '<td style="color:' + occColor + ';font-weight:600;">' + Math.round((m.occupancy_pct || 0) * 100) + '%</td>';
        h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(m.avg_nightly_rate || 0) + '</td>';
        h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(m.total_revenue || 0).toLocaleString() + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(m.cleaning_revenue || 0).toLocaleString() + '</td>';
        h += '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">$' + Math.round(m.host_payout || 0).toLocaleString() + '</td>';
        h += '<td>' + (m.num_reservations || 0) + '</td>';
        h += '<td>' + (m.avg_stay_length || 0) + ' nights</td>';
        h += '</tr>';

        // Last row — show final year totals
        if (idx === months.length - 1) {
          var yrOcc2 = yearTotals.available > 0 ? Math.round(yearTotals.nights / yearTotals.available * 100) : 0;
          var yrAdr2 = yearTotals.nights > 0 ? Math.round(yearTotals.revenue / yearTotals.nights) : 0;
          h += '<tr style="background:rgba(167,139,250,0.06);font-weight:600;">';
          h += '<td style="color:var(--purple);">' + currentYear + ' Total</td>';
          h += '<td>' + yearTotals.nights + '/' + yearTotals.available + '</td>';
          h += '<td style="color:var(--purple);">' + yrOcc2 + '%</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + yrAdr2 + '</td>';
          h += '<td style="font-family:DM Mono,monospace;color:var(--purple);">$' + Math.round(yearTotals.revenue).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(yearTotals.cleaning).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;color:var(--purple);">$' + Math.round(yearTotals.payout).toLocaleString() + '</td>';
          h += '<td>' + yearTotals.bookings + '</td><td></td></tr>';
        }
      });
      h += '</tbody></table></div></div>';
      propIdx++;
    }

    el.innerHTML = h;

    // Float header setup
    var existingFloat = document.getElementById('monthlyActualsFloatHeader');
    if (existingFloat) existingFloat.remove();
    var floatHeader = document.createElement('div');
    floatHeader.id = 'monthlyActualsFloatHeader';
    floatHeader.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:100;display:none;background:var(--card);border-bottom:2px solid var(--accent);box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    floatHeader.innerHTML = '';
    var floatInner = document.createElement('div');
    floatInner.style.cssText = 'padding:4px 16px;';
    var floatName = document.createElement('strong');
    floatName.id = 'floatPropName';
    floatName.style.cssText = 'font-size:0.78rem;color:var(--accent);display:block;padding:2px 0;';
    floatInner.appendChild(floatName);

    // Clone the first table's thead to match exact column widths
    var firstTable = el.querySelector('table.comp-table');
    if (firstTable) {
      var cloneTable = firstTable.cloneNode(false);
      cloneTable.style.cssText = firstTable.style.cssText + ';margin:0;';
      // Clone colgroup if exists
      var colgroup = firstTable.querySelector('colgroup');
      if (colgroup) cloneTable.appendChild(colgroup.cloneNode(true));
      // Clone thead
      var thead = firstTable.querySelector('thead');
      if (thead) {
        var cloneThead = thead.cloneNode(true);
        cloneThead.querySelectorAll('th').forEach(function(th) {
          th.style.color = 'var(--text3)';
          th.style.fontWeight = '600';
          th.style.textTransform = 'uppercase';
          th.style.fontSize = '0.68rem';
        });
        cloneTable.appendChild(cloneThead);
      }
      floatInner.appendChild(cloneTable);
    }
    floatHeader.appendChild(floatInner);
    document.body.appendChild(floatHeader);

    if (window._monthlyScrollHandler) window.removeEventListener('scroll', window._monthlyScrollHandler);
    var scrollHandler = function() {
      var tables = el.querySelectorAll('table.comp-table');
      var propHeaders = el.querySelectorAll('[data-prop-header]');
      var show = false;
      var currentProp = '';
      for (var i = 0; i < propHeaders.length; i++) {
        var rect = propHeaders[i].getBoundingClientRect();
        var tableRect = tables[i] ? tables[i].getBoundingClientRect() : null;
        if (rect.top < 0 && tableRect && tableRect.bottom > 50) {
          show = true;
          currentProp = propHeaders[i].dataset.propHeader;
        }
      }
      floatHeader.style.display = show ? '' : 'none';
      var nameEl = document.getElementById('floatPropName');
      if (nameEl) nameEl.textContent = currentProp;
    };
    window._monthlyScrollHandler = scrollHandler;
    window.addEventListener('scroll', scrollHandler);
}

async function loadMonthlyActuals() {
  if (allActualsData.length === 0) {
    try {
      var d = await api('/api/guesty/actuals');
      allActualsData = d.actuals || [];
    } catch {}
  }
  if (allActualsData.length === 0) {
    var el = document.getElementById('monthlyActualsContent');
    if (el) el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:10px;">No monthly actuals yet. Import Guesty data and click "Process into Monthly Actuals".</div>';
    return;
  }
  renderFilteredActuals();
}


// ========== GUESTY API INTEGRATION ==========
var guestyConnectionData = null;

async function loadGuestyConnection() {
  try {
    guestyConnectionData = await api('/api/guesty/connection');
    renderGuestyConnectionPanel();
  } catch (err) {
    var el = document.getElementById('guestyApiPanel');
    if (el) el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">Error loading connection status</span>';
  }
}

function renderGuestyConnectionPanel() {
  var el = document.getElementById('guestyApiPanel');
  if (!el) return;
  var d = guestyConnectionData || {};
  var h = '';

  if (d.configured && d.connected_at) {
    // Connected state
    var syncAge = d.last_sync ? timeSince(new Date(d.last_sync)) : 'never';
    var tokenColor = d.token_valid ? 'var(--accent)' : '#f59e0b';
    var tokenLabel = d.token_valid ? '✓ Valid' :'' + _ico('alertTriangle', 13, '#f59e0b') + ' Expired (will auto-refresh)';

    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">';
    h += '<span style="width:10px;height:10px;border-radius:50%;background:var(--accent);display:inline-block;"></span>';
    h += '<span style="font-size:0.85rem;font-weight:600;color:var(--accent);">Connected to Guesty API</span>';
    h += '<span style="font-size:0.68rem;color:var(--text3);margin-left:auto;">since ' + fmtUTC(d.connected_at) + '</span>';
    h += '</div>';

    h += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">';
    h += '<div style="padding:8px;background:var(--bg);border-radius:6px;text-align:center;">';
    h += '<div style="font-size:0.68rem;color:var(--text3);text-transform:uppercase;">Token</div>';
    h += '<div style="font-size:0.82rem;color:' + tokenColor + ';font-weight:600;">' + tokenLabel + '</div>';
    h += '</div>';
    h += '<div style="padding:8px;background:var(--bg);border-radius:6px;text-align:center;">';
    h += '<div style="font-size:0.68rem;color:var(--text3);text-transform:uppercase;">Last Sync</div>';
    h += '<div style="font-size:0.82rem;font-weight:600;">' + syncAge + '</div>';
    h += '</div>';
    h += '<div style="padding:8px;background:var(--bg);border-radius:6px;text-align:center;">';
    h += '<div style="font-size:0.68rem;color:var(--text3);text-transform:uppercase;">Records</div>';
    h += '<div style="font-size:0.82rem;font-weight:600;">' + (d.last_sync_count != null ? d.last_sync_count : '—') + '</div>';
    h += '</div>';
    h += '</div>';

    if (d.last_sync_error) {
      h += '<div style="padding:8px 12px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;margin-bottom:10px;font-size:0.75rem;color:var(--danger);">';
      h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' Last sync error: ' + esc(d.last_sync_error);
      h += '</div>';
    }

    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
    h += '<button class="btn btn-sm btn-primary" onclick="syncGuestyApi(false)" id="guestySyncBtn" title="Pull reservations updated since last sync — fast, usually a few seconds">' + _ico('zap', 13) + ' Sync Now</button>';
    h += '<button class="btn btn-sm" onclick="syncGuestyApi(true)" title="Re-fetch ALL reservations from scratch — slower but ensures complete data">' + _ico('refresh', 13) + ' Full Re-sync</button>';
    h += '<button class="btn btn-sm" onclick="syncGuestyListingsApi()" title="Pull listing details (names, addresses) from Guesty API">' + _ico('receipt', 13) + ' Sync Listings</button>';
    h += '<button class="btn btn-sm" onclick="syncGuestyPhotos(false)" title="Pull listing photos from Guesty and set as property images (only fills empty ones)">' + _ico('camera', 13) + ' Pull Photos</button>';
    h += '<button class="btn btn-sm" onclick="showGuestySetup()" style="margin-left:auto;font-size:0.72rem;color:var(--text3);">' + _ico('settings', 13) + ' Reconfigure</button>';
    h += '</div>';

    // Help descriptions
    h += '<div style="margin-top:10px;padding:10px 12px;background:var(--bg);border-radius:6px;font-size:0.72rem;color:var(--text3);line-height:1.6;">';
    h += '<div><strong style="color:var(--text2);">' + _ico('zap', 13) + ' Sync Now</strong> — Pulls only reservations updated since last sync. Fast, run this regularly.</div>';
    h += '<div><strong style="color:var(--text2);">' + _ico('refresh', 13) + ' Full Re-sync</strong> — Re-fetches ALL reservations from Guesty. Use if data looks off or after first connect.</div>';
    h += '<div><strong style="color:var(--text2);">' + _ico('receipt', 13) + ' Sync Listings</strong> — Pulls listing names, addresses, photos & details from Guesty. Use to discover new listings or update info. Does NOT touch reservations or financials.</div>';
    h += '<div><strong style="color:var(--text2);">' + _ico('camera', 13) + ' Pull Photos</strong> — Sets Guesty listing photos as property images. Only fills properties without a photo. Use "Overwrite all" to replace existing photos too.</div>';
    h += '</div>';

    h += '<div id="guestyApiSyncStatus" style="margin-top:8px;font-size:0.82rem;"></div>';
  } else {
    // Not connected — show setup
    h += renderGuestySetupForm();
  }

  el.innerHTML = h;
}

function renderGuestySetupForm() {
  var h = '<div style="padding:16px;background:rgba(96,165,250,0.04);border:1px solid rgba(96,165,250,0.2);border-radius:8px;">';
  h += '<div style="font-size:0.85rem;font-weight:600;color:#60a5fa;margin-bottom:8px;">' + _ico('plug', 13) + ' Connect Guesty API</div>';
  h += '<p style="font-size:0.75rem;color:var(--text3);margin-bottom:12px;">Automate reservation syncing — no more CSV exports. In Guesty: go to <strong>Integrations → API & Webhooks → Create API Key</strong>. Copy your Client ID and Secret below.</p>';
  h += '<div style="display:flex;flex-direction:column;gap:8px;">';
  h += '<div style="display:flex;gap:8px;align-items:center;">';
  h += '<label style="font-size:0.78rem;color:var(--text2);width:100px;flex-shrink:0;">Client ID</label>';
  h += '<input type="text" id="guestyClientId" placeholder="0oaxxxxxxxxxx" style="flex:1;padding:6px 10px;font-size:0.82rem;font-family:DM Mono,monospace;">';
  h += '</div>';
  h += '<div style="display:flex;gap:8px;align-items:center;">';
  h += '<label style="font-size:0.78rem;color:var(--text2);width:100px;flex-shrink:0;">Client Secret</label>';
  h += '<input type="password" id="guestyClientSecret" placeholder="xxxxxxxxxxxx" style="flex:1;padding:6px 10px;font-size:0.82rem;font-family:DM Mono,monospace;">';
  h += '</div>';
  h += '<div style="display:flex;gap:8px;align-items:center;margin-top:4px;">';
  h += '<button class="btn btn-sm btn-primary" onclick="connectGuestyApi()" id="guestyConnectBtn">' + _ico('plug', 13) + ' Connect & Test</button>';
  h += '<span id="guestyConnectStatus" style="font-size:0.78rem;"></span>';
  h += '</div>';
  h += '</div></div>';
  return h;
}

function showGuestySetup() {
  var el = document.getElementById('guestyApiPanel');
  if (el) el.innerHTML = renderGuestySetupForm();
}

async function connectGuestyApi() {
  var id = (document.getElementById('guestyClientId') || {}).value || '';
  var secret = (document.getElementById('guestyClientSecret') || {}).value || '';
  var statusEl = document.getElementById('guestyConnectStatus');
  var btn = document.getElementById('guestyConnectBtn');
  if (!id || !secret) { toast('Both Client ID and Client Secret are required', 'error'); return; }

  if (btn) btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--text3);">' + _ico('clock', 13) + ' Testing connection...</span>';

  try {
    var d = await api('/api/guesty/connect', 'POST', { client_id: id, client_secret: secret });
    if (d.ok) {
      toast(d.message);
      loadGuestyConnection();
    } else {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(d.error || 'Connection failed') + '</span>';
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
  }
  if (btn) btn.disabled = false;
}

async function syncGuestyApi(full) {
  var statusEl = document.getElementById('guestyApiSyncStatus');
  var btn = document.getElementById('guestySyncBtn');
  if (btn) btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--text3);">' + _ico('clock', 13) + ' ' + (full ? 'Full re-sync' : 'Syncing') + ' from Guesty API...</span>';

  try {
    var d = await api('/api/guesty/api-sync', 'POST', { full: !!full });
    if (d.ok) {
      var msg = '' + _ico('check', 13, 'var(--accent)') + ' ' + d.message;
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--accent);font-size:0.82rem;">' + esc(msg) + '</span>';
      toast(d.message);
      // Refresh everything
      loadGuestyConnection();
      loadGuestyStats();
      loadMonthlyActuals();
    } else {
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(d.error || 'Sync failed') + '</span>';
      toast(d.error || 'Sync failed', 'error');
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  if (btn) btn.disabled = false;
}

async function syncGuestyListingsApi() {
  showLoading('Syncing listings from Guesty API...');
  try {
    var d = await api('/api/guesty/api-sync-listings', 'POST');
    if (d.ok) {
      toast(d.message);
      loadGuestyListings();
      loadProperties();
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

async function syncGuestyPhotos(force) {
  if (force && !confirm('This will overwrite existing property photos with Guesty listing photos. Continue?')) return;
  showLoading('Pulling photos from Guesty...');
  try {
    var d = await api('/api/guesty/sync-photos', 'POST', { force: !!force });
    if (d.ok) {
      toast(d.message);
      loadProperties();
      loadGuestyConnection();
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

function timeSince(date) {
  var seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  var minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  var days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return Math.floor(days / 30) + 'mo ago';
}

function scrollToGuestySection(id) {
  var el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function toggleAllActuals(expand) {
  document.querySelectorAll('#monthlyActualsContent .actuals-prop-toggle').forEach(function(el) {
    var target = document.getElementById(el.dataset.target);
    if (target) {
      target.style.display = expand ? '' : 'none';
      el.textContent = expand ? '−' : '+';
    }
  });
}

function toggleActualsProp(btn) {
  var target = document.getElementById(btn.dataset.target);
  if (target) {
    var show = target.style.display === 'none';
    target.style.display = show ? '' : 'none';
    btn.textContent = show ? '−' : '+';
  }
}

// Create new property from unlinked Guesty listing
function showCreatePropertyFromListing(listingId, rowId) {
  // Find listing data from the last loaded listings
  var el = document.getElementById('guestyListings');
  if (!el) return;

  // Fetch listing details from backend
  api('/api/guesty/listings').then(function(d) {
    var listing = (d.listings || []).find(function(l) { return l.guesty_listing_id === listingId; });
    if (!listing) { toast('Listing not found', 'error'); return; }

    // Parse address into parts if we have it
    var addrParts = (listing.listing_address || '').split(',').map(function(s) { return s.trim(); });
    var street = addrParts[0] || '';
    var city = listing.listing_city || addrParts[1] || '';
    var state = listing.listing_state || addrParts[2] || '';
    var zip = listing.listing_zip || '';

    // Map Guesty property type to our types
    var pType = 'single_family';
    var gType = (listing.listing_property_type || '').toLowerCase();
    if (gType.includes('apart') || gType.includes('condo')) pType = 'condo';
    else if (gType.includes('town')) pType = 'townhouse';
    else if (gType.includes('multi')) pType = 'multi_family';

    var h = '<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:200;display:flex;align-items:center;justify-content:center;" id="createPropModal">';
    h += '<div style="background:var(--card);border-radius:12px;padding:24px;max-width:500px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.3);">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">';
    h += '<h3 style="margin:0;color:#60a5fa;">Create Property from Listing</h3>';
    h += '<button onclick="document.getElementById(\'createPropModal\').remove()" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text3);">✕</button>';
    h += '</div>';

    h += '<p style="font-size:0.78rem;color:var(--text3);margin-bottom:14px;">This will create a new property in your portfolio and automatically link it to the Guesty listing <strong>"' + esc(listing.listing_name) + '"</strong>. Review the details below before creating.</p>';

    h += '<div style="display:flex;flex-direction:column;gap:10px;">';
    // Name
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">Property Name</label>';
    h += '<input type="text" id="cpf_name" value="' + esc(listing.listing_name || '') + '" style="width:100%;padding:6px 10px;font-size:0.82rem;"></div>';
    // Address
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">Street Address</label>';
    h += '<input type="text" id="cpf_address" value="' + esc(street) + '" style="width:100%;padding:6px 10px;font-size:0.82rem;"></div>';
    // City / State / Zip row
    h += '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;">';
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">City</label>';
    h += '<input type="text" id="cpf_city" value="' + esc(city) + '" style="width:100%;padding:6px 10px;font-size:0.82rem;"></div>';
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">State</label>';
    h += '<input type="text" id="cpf_state" value="' + esc(state) + '" style="width:100%;padding:6px 10px;font-size:0.82rem;"></div>';
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">Zip</label>';
    h += '<input type="text" id="cpf_zip" value="' + esc(zip) + '" style="width:100%;padding:6px 10px;font-size:0.82rem;"></div>';
    h += '</div>';
    // Type / Beds / Baths
    h += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">';
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">Property Type</label>';
    h += '<select id="cpf_type" style="width:100%;padding:6px 10px;font-size:0.82rem;">';
    ['single_family','condo','townhouse','multi_family','cabin','cottage','apartment'].forEach(function(t) {
      h += '<option value="' + t + '"' + (t === pType ? ' selected' : '') + '>' + t.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); }) + '</option>';
    });
    h += '</select></div>';
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">Bedrooms</label>';
    h += '<input type="number" id="cpf_beds" value="' + (listing.listing_bedrooms || '') + '" style="width:100%;padding:6px 10px;font-size:0.82rem;"></div>';
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">Bathrooms</label>';
    h += '<input type="number" id="cpf_baths" value="' + (listing.listing_bathrooms || '') + '" style="width:100%;padding:6px 10px;font-size:0.82rem;"></div>';
    h += '</div>';
    // Rental type
    h += '<div><label style="font-size:0.72rem;color:var(--text3);display:block;margin-bottom:2px;">Rental Type</label>';
    h += '<select id="cpf_rental_type" style="width:100%;padding:6px 10px;font-size:0.82rem;">';
    h += '<option value="str" selected>Short-Term Rental (STR)</option>';
    h += '<option value="ltr">Long-Term Rental (LTR)</option>';
    h += '<option value="mtr">Mid-Term Rental (MTR)</option>';
    h += '</select></div>';

    h += '</div>';

    // Source info
    h += '<div style="margin-top:12px;padding:8px 12px;background:var(--bg);border-radius:6px;font-size:0.72rem;color:var(--text3);">';
    h += 'Guesty listing ID: <code>' + esc(listingId) + '</code>';
    if (listing.reservation_count) h += ' · ' + listing.reservation_count + ' reservations will be auto-linked';
    if (listing.listing_accommodates) h += ' · Accommodates ' + listing.listing_accommodates + ' guests';
    h += '</div>';

    // Buttons
    h += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">';
    h += '<button class="btn btn-sm" onclick="document.getElementById(\'createPropModal\').remove()">Cancel</button>';
    h += '<button class="btn btn-sm btn-primary" onclick="confirmCreatePropertyFromListing(\'' + esc(listingId) + '\')">✓ Create & Link Property</button>';
    h += '</div>';

    h += '</div></div>';

    // Remove any existing modal
    var existing = document.getElementById('createPropModal');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', h);
  }).catch(function(err) { toast('Error: ' + err.message, 'error'); });
}

async function confirmCreatePropertyFromListing(guestyListingId) {
  var name = (document.getElementById('cpf_name') || {}).value || '';
  var address = (document.getElementById('cpf_address') || {}).value || '';
  var city = (document.getElementById('cpf_city') || {}).value || '';
  var state = (document.getElementById('cpf_state') || {}).value || '';
  var zip = (document.getElementById('cpf_zip') || {}).value || '';
  var pType = (document.getElementById('cpf_type') || {}).value || 'single_family';
  var beds = parseInt((document.getElementById('cpf_beds') || {}).value) || 1;
  var baths = parseInt((document.getElementById('cpf_baths') || {}).value) || 1;
  var rentalType = (document.getElementById('cpf_rental_type') || {}).value || 'str';

  if (!address || !city || !state) {
    toast('Address, city, and state are required', 'error');
    return;
  }

  try {
    // Create the property
    var d = await api('/api/properties', 'POST', {
      name: name,
      address: address,
      city: city,
      state: state,
      zip: zip,
      property_type: pType,
      bedrooms: beds,
      bathrooms: baths,
      rental_type: rentalType
    });

    if (d.id) {
      // Link to Guesty listing
      await api('/api/guesty/listings/link', 'POST', {
        guesty_listing_id: guestyListingId,
        property_id: d.id
      });

      toast('Property created and linked to Guesty listing');
      var modal = document.getElementById('createPropModal');
      if (modal) modal.remove();

      // Refresh data
      await loadProperties();
      loadGuestyListings();
      loadGuestyStats();
    } else {
      toast(d.error || 'Failed to create property', 'error');
    }
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

// ─── Sync Dashboard ──────────────────────────────────────────────────────
async function loadSyncDashboard() {
  var el = document.getElementById('syncDashboard');
  if (!el) return;
  try {
    var log = [];
    var wh = { configured: false, recent_events: [], event_stats: [] };
    try { var logResp = await api('/api/sync/log'); log = logResp.log || []; } catch (e) { console.warn('Sync log load failed:', e); }
    try { var whResp = await api('/api/guesty/webhooks/status'); wh = whResp || wh; } catch (e) { console.warn('Webhook status load failed:', e); }

    var h = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">';

    // Left: Manual Sync Buttons with descriptions
    h += '<div>';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">' + _ico('refresh', 13) + ' MANUAL SYNC</div>';

    var syncTypes = [
      { key: 'guesty_reservations', label:'' + _ico('zap', 13) + ' Reservations', desc: 'Auto-runs every 6 hours. Manual: run if you just made changes in Guesty and don\'t want to wait.' },
      { key: 'guesty_calendar', label:'' + _ico('calendar', 13) + ' Calendar', desc: 'Auto-runs daily at 6am UTC. Manual: run after changing rates in Guesty or to verify PriceLabs pushed correctly.' },
      { key: 'monthly_actuals', label:'' + _ico('trendUp', 13) + ' Rebuild Actuals', desc: 'Auto-runs daily at 6am UTC. Manual: run if actuals numbers look off or after a manual reservation sync.' },
    ];
    syncTypes.forEach(function(s) {
      h += '<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;">';
      h += '<button class="btn btn-xs" onclick="runSync(\'' + s.key + '\',this)" style="white-space:nowrap;flex-shrink:0;padding:4px 10px;">' + s.label + '</button>';
      h += '<span style="font-size:0.65rem;color:var(--text3);line-height:1.4;padding-top:2px;">' + s.desc + '</span>';
      h += '</div>';
    });

    // Last run times from log
    var lastRuns = {};
    log.forEach(function(l) {
      if (!lastRuns[l.sync_type] && l.status === 'completed') lastRuns[l.sync_type] = l;
    });
    var hasLastRuns = Object.keys(lastRuns).length > 0;
    if (hasLastRuns) {
      h += '<div style="margin-top:8px;padding:8px 10px;background:var(--bg);border-radius:6px;font-size:0.65rem;color:var(--text3);">';
      h += '<strong style="color:var(--text2);">Last successful runs:</strong><br>';
      for (var lt in lastRuns) {
        var lr = lastRuns[lt];
        var ago = lr.started_at ? timeSince(new Date(lr.started_at + 'Z')) : '—';
        var when = lr.started_at ? fmtUTC(lr.started_at) : '';
        h += '<span>' + esc(lt) + ': ' + ago + (when ? ' (' + when + ' EST)' : '') + ' · ' + esc(lr.source) + (lr.records_processed ? ' · ' + lr.records_processed + ' records' : '') + '</span><br>';
      }
      h += '</div>';
    }

    // Recent sync log
    if (log.length > 0) {
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);margin-bottom:4px;margin-top:10px;">RECENT SYNC LOG</div>';
      h += '<div style="max-height:200px;overflow-y:auto;">';
      log.slice(0, 15).forEach(function(l) {
        var icon = l.status === 'completed' ? '✓' : l.status === 'error' ? '✗' : '' + _ico('clock', 13) + '';
        var color = l.status === 'completed' ? 'var(--accent)' : l.status === 'error' ? 'var(--danger)' : 'var(--text3)';
        var ago = l.started_at ? timeSince(new Date(l.started_at + 'Z')) : '';
        h += '<div style="font-size:0.68rem;padding:2px 0;display:flex;gap:4px;color:var(--text3);">';
        h += '<span style="color:' + color + ';">' + icon + '</span>';
        h += '<span style="font-weight:600;">' + esc(l.sync_type) + '</span>';
        h += '<span>(' + esc(l.source) + ')</span>';
        if (l.records_processed) h += '<span>' + l.records_processed + ' records</span>';
        h += '<span style="margin-left:auto;">' + ago + '</span>';
        h += '</div>';
        if (l.error) h += '<div style="font-size:0.62rem;color:var(--danger);padding-left:16px;">' + esc(l.error.substring(0, 100)) + '</div>';
      });
      h += '</div>';
    }
    h += '</div>';

    // Right: Webhooks
    h += '<div>';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">' + _ico('bell', 13) + ' WEBHOOKS (Real-time)</div>';
    if (wh.configured) {
      h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">';
      h += '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block;"></span>';
      h += '<span style="font-size:0.78rem;color:var(--accent);font-weight:600;">Active</span>';
      h += '</div>';
      h += '<div style="font-size:0.68rem;color:var(--text3);margin-bottom:8px;">URL: ' + esc((wh.webhook_url || '').substring(0, 50)) + '...</div>';

      // Event stats
      if (wh.event_stats && wh.event_stats.length > 0) {
        h += '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">';
        wh.event_stats.forEach(function(s) {
          h += '<span style="font-size:0.62rem;padding:2px 6px;background:var(--surface2);border-radius:4px;">' + esc(s.event_type) + ': ' + s.count + '</span>';
        });
        h += '</div>';
      }

      // Recent webhook events
      if (wh.recent_events && wh.recent_events.length > 0) {
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);margin-bottom:4px;">RECENT EVENTS</div>';
        h += '<div style="max-height:150px;overflow-y:auto;">';
        wh.recent_events.slice(0, 10).forEach(function(e) {
          var icon = e.status === 'processed' ? '✓' : e.status === 'error' ? '✗' : '◎';
          var color = e.status === 'processed' ? 'var(--accent)' : e.status === 'error' ? 'var(--danger)' : '#60a5fa';
          var ago = e.created_at ? timeSince(new Date(e.created_at + 'Z')) : '';
          h += '<div style="font-size:0.65rem;padding:2px 0;display:flex;gap:4px;color:var(--text3);">';
          h += '<span style="color:' + color + ';">' + icon + '</span>';
          h += '<span style="font-weight:600;">' + esc(e.event_type || '') + '</span>';
          h += '<span>' + esc(e.payload_summary || '') + '</span>';
          h += '<span style="margin-left:auto;">' + ago + '</span>';
          h += '</div>';
        });
        h += '</div>';
      }
    } else {
      h += '<div style="padding:10px;background:var(--bg);border-radius:6px;font-size:0.75rem;color:var(--text3);margin-bottom:8px;">';
      h += 'Webhooks not configured. Set up for real-time reservation and calendar updates.';
      h += '</div>';
      h += '<div style="display:flex;flex-direction:column;gap:6px;">';
      h += '<input type="text" id="webhookUrl" placeholder="https://your-domain.com/api/webhooks/guesty" style="font-size:0.78rem;padding:6px 10px;">';
      h += '<button class="btn btn-sm btn-primary" onclick="setupWebhooks()">' + _ico('bell', 13) + ' Subscribe to Webhooks</button>';
      h += '</div>';
      h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:6px;">Your webhook URL is: <code>' + location.origin + '/api/webhooks/guesty</code></div>';
    }
    h += '</div>';
    h += '</div>';

    // Schedule info at bottom with next run times
    h += '<div style="margin-top:10px;padding:8px 12px;background:var(--bg);border-radius:6px;font-size:0.68rem;color:var(--text3);line-height:1.6;">';
    h += '<strong style="color:var(--text2);">' + _ico('clock', 13) + ' Auto-Sync Schedule (UTC)</strong><br>';
    var now = new Date();
    var utcH = now.getUTCHours();
    // Next 6h run
    var next6h = new Date(now);
    next6h.setUTCMinutes(0, 0, 0);
    next6h.setUTCHours(Math.ceil((utcH + 1) / 6) * 6);
    if (next6h <= now) next6h.setUTCHours(next6h.getUTCHours() + 6);
    // Next daily 6am
    var next6am = new Date(now);
    next6am.setUTCHours(6, 0, 0, 0);
    if (next6am <= now) next6am.setUTCDate(next6am.getUTCDate() + 1);
    // Next Monday 7am
    var nextMon = new Date(now);
    nextMon.setUTCHours(7, 0, 0, 0);
    var daysUntilMon = (1 - nextMon.getUTCDay() + 7) % 7 || 7;
    if (nextMon.getUTCDay() === 1 && nextMon > now) daysUntilMon = 0;
    nextMon.setUTCDate(nextMon.getUTCDate() + daysUntilMon);

    var tz = getTimezoneAbbr();
    h += 'Reservations — every 6h · next: <strong>' + fmtEST(next6h) + ' ' + tz + '</strong><br>';
    h += 'Calendar + Actuals — daily · next: <strong>' + fmtEST(next6am) + ' ' + tz + '</strong><br>';
    h += 'Listings & Photos — weekly Mon · next: <strong>' + fmtEST(nextMon) + ' ' + tz + '</strong>';
    h += '</div>';

    el.innerHTML = h;
  } catch (err) {
    el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">Error loading sync dashboard: ' + esc(err.message) + '</span>';
  }
}

async function runSync(syncType, btn) {
  if (btn) btn.disabled = true;
  toast('Running ' + syncType + '...');
  try {
    var d = await api('/api/sync/run', 'POST', { sync_type: syncType });
    toast(d.message || 'Sync complete');
    loadSyncDashboard();
    if (syncType.includes('reservation') || syncType === 'monthly_actuals') {
      loadGuestyStats();
      loadMonthlyActuals();
    }
  } catch (err) { toast('Sync failed: ' + err.message, 'error'); }
  if (btn) btn.disabled = false;
}

async function setupWebhooks() {
  var url = (document.getElementById('webhookUrl') || {}).value || (location.origin + '/api/webhooks/guesty');
  if (!url) { toast('Enter webhook URL', 'error'); return; }
  showLoading('Subscribing to Guesty webhooks...');
  try {
    var d = await api('/api/guesty/webhooks/subscribe', 'POST', { webhook_url: url });
    if (d.ok) {
      toast('Webhooks configured! ' + d.subscribed.length + ' events subscribed.');
      loadSyncDashboard();
    } else {
      toast(d.error || 'Failed', 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}
