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
  if (status) { status.style.display = ''; status.innerHTML = '⏳ Reading CSV...'; }

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

    if (status) status.innerHTML = '⏳ Parsed ' + rows.length + ' rows with ' + headers.length + ' columns. Importing...';

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
      rh += '<div style="font-weight:600;color:var(--accent);margin-bottom:6px;">✅ Import Complete</div>';
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
          var label = (p.unit_number ? p.unit_number + ' — ' : '') + (p.name || p.address || 'Property ' + p.id) + ' (' + (p.city || '') + ')';
          h += '<option value="' + p.id + '">' + esc(label) + '</option>';
        });
        h += '</select>';
        h += '<button class="btn btn-xs btn-primary" onclick="linkGuestyListing(\'' + esc(gl.guesty_listing_id) + '\', ' + gl.id + ')" style="font-size:0.68rem;">Link</button>';
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
    await api('/api/guesty/listings/link', 'POST', { guesty_listing_id: guestyId, property_id: parseInt(sel.value) });
    toast('Listing linked');
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
  loadGuestyStats();
  loadMonthlyActuals();
  loadAlgoHealth();
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
  h += '<span style="font-size:0.85rem;font-weight:600;color:var(--accent);">📅 ' + periodLabel + ': ' + fromMonth + ' to ' + toMonth + '</span>';
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
  }
  h += '</div>';

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
      sumEl.innerHTML = '<span style="color:var(--accent);font-weight:600;">📅 ' + periodLabel + '</span> · ' + fromMonth + ' to ' + toMonth + ' · ' +
        new Set(filtered.map(function(a) { return a.property_id; })).size + ' properties · ' +
        overallOcc + '% occ · $' + overallAdr + ' ADR · <span style="color:var(--accent);">$' + Math.round(totalRev).toLocaleString() + ' revenue</span>';
    } else {
      sumEl.innerHTML = '<span style="color:var(--accent);">📅 ' + periodLabel + '</span> · ' + fromMonth + ' to ' + toMonth + ' · No data for this period';
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
  for (var propId in byProp) {
      var p = byProp[propId];
      var months = p.months.sort(function(a, b) { return a.month.localeCompare(b.month); });
      var totalRev = 0, totalNights = 0, totalPayout = 0;
      months.forEach(function(m) { totalRev += m.total_revenue || 0; totalNights += m.booked_nights || 0; totalPayout += m.host_payout || 0; });
      var avgOcc = months.length > 0 ? Math.round(months.reduce(function(a, m) { return a + (m.occupancy_pct || 0); }, 0) / months.length * 100) : 0;
      var avgAdr = totalNights > 0 ? Math.round(totalRev / totalNights) : 0;

      h += '<div style="margin-bottom:24px;">';
      // Property header
      h += '<div data-prop-header="' + esc(p.name) + '" style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:2px solid var(--border);margin-bottom:4px;">';
      h += '<strong style="font-size:0.88rem;">' + esc(p.name) + '</strong>';
      h += '<span style="font-size:0.72rem;color:var(--text3);">' + esc(p.city) + ', ' + esc(p.state) + ' · ' + months.length + ' months · Avg occ ' + avgOcc + '% · ADR $' + avgAdr + ' · Total payout $' + Math.round(totalPayout).toLocaleString() + '</span>';
      h += '</div>';
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
      h += '</tbody></table></div>';
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
