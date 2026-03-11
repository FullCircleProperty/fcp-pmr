// Finances

var finData = null;
var finPeriod = 'ytd';

async function loadFinances() {
  try {
    var d = await api('/api/finances/summary');
    finData = d;
    // Unpack monthly_actuals which now returns {actuals, seasonality}
    var maData = d.monthly_actuals || {};
    finData.monthly_actuals = maData.actuals || maData || [];
    finData.seasonality = maData.seasonality || [];
    // Build smart expectations
    buildSmartExpectations();
    renderPortfolioOverview(d.portfolio);
    renderFinActuals();
    renderFinProjections(d.portfolio);
    renderFinActualVsExpected(d.portfolio);
    renderServiceBreakdown(d.portfolio);
    loadCapitalExpenses();
    renderFinanceByCity(d.by_city || []);
    renderFinancePropertyTable(d.properties || []);
    renderApiCosts(d.api_costs || {});
    loadUsageAlerts();
  } catch (err) {
    var el = document.getElementById('finPortfolioOverview');
    if (el) el.innerHTML = '<p style="color:var(--danger);">Error: ' + esc(err.message) + '</p>';
  }
}

// Build smart expectations per property per month
// Priority: 1) same month last year actual, 2) property historical avg × seasonality, 3) PriceLabs projection × seasonality
var finExpectations = {}; // key: propertyId_month → { expected, source }

function buildSmartExpectations() {
  finExpectations = {};
  if (!finData) return;
  var actuals = finData.monthly_actuals || [];
  var props = finData.properties || [];
  var season = finData.seasonality || [];
  var now = new Date();
  var currentYear = now.getFullYear();
  var currentMonth = currentYear + '-' + String(now.getMonth() + 1).padStart(2, '0');

  // Build seasonality lookup: city_state_monthNum → {mult, occ, adr}
  var seasonMap = {};
  var seasonOccMap = {};
  season.forEach(function(s) {
    var key = (s.city || '').toLowerCase() + '_' + (s.state || '').toLowerCase() + '_' + s.month_number;
    seasonMap[key] = s.multiplier || 1.0;
    if (s.avg_occupancy) seasonOccMap[key] = s.avg_occupancy;
  });

  // Build per-property actual history
  var propHistory = {};
  actuals.forEach(function(a) {
    var pk = String(a.property_id);
    if (!propHistory[pk]) propHistory[pk] = { months: {}, city: a.city, state: a.state, totalRev: 0, monthCount: 0, byMonthNum: {} };
    if (a.month < currentMonth) { // exclude partial current month from averages
      propHistory[pk].months[a.month] = a.total_revenue || 0;
      propHistory[pk].totalRev += a.total_revenue || 0;
      propHistory[pk].monthCount++;
      var mn = parseInt(a.month.substring(5));
      if (!propHistory[pk].byMonthNum[mn]) propHistory[pk].byMonthNum[mn] = [];
      propHistory[pk].byMonthNum[mn].push(a.total_revenue || 0);
    }
  });

  var propsMap = {};
  props.forEach(function(p) { propsMap[String(p.id)] = p; });

  var daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  for (var pk in propHistory) {
    var ph = propHistory[pk];
    var prop = propsMap[pk];
    var monthlyCost = prop ? (prop.monthly_cost || 0) : 0;

    // ── Market-based blended ADR (same logic as property target grid) ──
    var base = prop ? (prop.pl_base_price || 0) : 0;
    var rec = prop ? (prop.pl_rec_base || 0) : 0;
    var max = prop ? (prop.pl_max_price || base) : 0;
    var blendedADR = 0;
    if (base > 0) {
      blendedADR = Math.round(base * 0.4 + (rec || base) * 0.3 + Math.round(base * 1.2) * 0.2 + Math.round((base + max) / 2) * 0.1);
    }
    // Fallback: use analysis nightly rate from pricing strategy
    if (!blendedADR && prop && prop.analysis_nightly_rate) blendedADR = prop.analysis_nightly_rate;

    // ── Annual occupancy estimate (same logic as property target grid) ──
    var plFwdOcc = prop && prop.pl_occ_30d ? parseInt(prop.pl_occ_30d) / 100 : 0;
    var plMktOcc = prop && prop.pl_mkt_occ_30d ? parseInt(prop.pl_mkt_occ_30d) / 100 : 0;
    var annualOcc = 0.50;
    if (prop && prop.analysis_occ && prop.analysis_occ > 0.2) annualOcc = prop.analysis_occ;
    if (plFwdOcc >= 0.50) annualOcc = plFwdOcc;
    else if (plFwdOcc > 0 && plMktOcc > 0 && plFwdOcc > plMktOcc) annualOcc = Math.max(0.55, Math.min(0.70, plFwdOcc * 3.5));
    else if (plFwdOcc > 0) annualOcc = Math.max(0.40, Math.min(0.60, plFwdOcc * 3));

    // ── Fallback: use est_monthly_revenue from latest pricing strategy ──
    var stratMonthly = prop ? (prop.est_monthly_revenue || 0) : 0;

    // Get all seasonality multipliers for this market to compute multSum
    var cityState = (ph.city || '').toLowerCase() + '_' + (ph.state || '').toLowerCase();
    var allMults = [];
    for (var sm = 1; sm <= 12; sm++) allMults.push(seasonMap[cityState + '_' + sm] || 1.0);
    var multSum = allMults.reduce(function(a, b) { return a + b; }, 0) || 12;
    var hasSeasonality = allMults.some(function(m) { return m !== 1.0; });

    // ── Generate expectations for all months with actuals ──
    for (var month in ph.months) {
      var mn = parseInt(month.substring(5));
      var yr = parseInt(month.substring(0, 4));
      var mult = seasonMap[cityState + '_' + mn] || 1.0;
      var avgMult = multSum / 12;

      var expected = 0;
      var source = '';

      // Priority 1: same month previous year actual
      var lastYearMonth = (yr - 1) + month.substring(4);
      if (ph.months[lastYearMonth] !== undefined) {
        expected = ph.months[lastYearMonth];
        source = 'last year actual';
      }
      // Priority 2: historical average for this month (2+ data points)
      else if (ph.byMonthNum[mn] && ph.byMonthNum[mn].length >= 2) {
        expected = ph.byMonthNum[mn].reduce(function(a, b) { return a + b; }, 0) / ph.byMonthNum[mn].length;
        source = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mn] + ' historical avg';
      }
      // Priority 3: market-based ADR × seasonal occupancy × days (matches property target grid)
      else if (blendedADR > 0) {
        var mktOcc = seasonOccMap[cityState + '_' + mn] || (hasSeasonality ? Math.max(0.15, Math.min(0.95, annualOcc * (mult / avgMult))) : annualOcc);
        expected = Math.round(blendedADR * daysInMonth[mn - 1] * mktOcc);
        source = 'market rate × ' + Math.round(mktOcc * 100) + '% occ';
      }
      // Priority 4: strategy monthly estimate × seasonality
      else if (stratMonthly > 0) {
        expected = Math.round(stratMonthly * mult / avgMult);
        source = 'strategy est × ' + mult.toFixed(1) + 'x season';
      }

      // Cost floor
      if (monthlyCost > 0) {
        var annualCostTarget = monthlyCost * 12 * 1.15;
        var seasonFloor = Math.max(annualCostTarget * mult / multSum, monthlyCost);
        if (expected < seasonFloor) { expected = Math.round(seasonFloor); source += ' (↑ cost floor)'; }
      }

      finExpectations[pk + '_' + month] = { expected: Math.round(expected), source: source };
    }
  }
}

function setFinPeriod(mode) {
  finPeriod = mode;
  document.querySelectorAll('.fin-period').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-period') === mode);
  });
  renderFinActuals();
  renderFinActualVsExpected(finData ? finData.portfolio : null);
}

function getFinDateRange(mode) {
  var now = new Date();
  var y = now.getFullYear(), m = now.getMonth() + 1;
  var from = '2000-01', to = '2099-12';
  switch (mode) {
    case 'thismonth': from = to = y + '-' + String(m).padStart(2, '0'); break;
    case 'lastmonth': var lm = m === 1 ? 12 : m - 1; var ly2 = m === 1 ? y - 1 : y; from = to = ly2 + '-' + String(lm).padStart(2, '0'); break;
    case 'ytd': from = y + '-01'; to = y + '-' + String(m).padStart(2, '0'); break;
    case 'thisyear': from = y + '-01'; to = y + '-12'; break;
    case 'lastyear': from = (y - 1) + '-01'; to = (y - 1) + '-12'; break;
    case 'custom':
      var fv = (document.getElementById('finFrom') || {}).value || '';
      var tv = (document.getElementById('finTo') || {}).value || '';
      if (fv) from = fv.substring(0, 7);
      if (tv) to = tv.substring(0, 7);
      break;
    case 'all': break;
  }
  return { from: from, to: to };
}

function renderPortfolioOverview(p) {
  if (!p) return;
  var h = '';
  h += finStat('$' + fmtNum(p.total_estimated_value), 'Portfolio Value');
  h += finStat('$' + fmtNum(p.total_equity), 'Total Equity', p.total_equity >= 0 ? 'var(--accent)' : 'var(--danger)');
  h += finStat(p.property_count, 'Properties' + (p.building_count > 0 ? ' (' + p.building_count + ' bldgs)' : ''));
  h += finStat('$' + fmtNum(p.monthly_cost), 'Monthly Expenses <span style="font-size:0.6rem;color:var(--text3);">(recurring)</span>', 'var(--danger)');
  if (p.monthly_services > 0) h += finStat('$' + fmtNum(p.monthly_services), 'Incl. Services', 'var(--purple)');
  h += finStat(p.avg_cap_rate.toFixed(1) + '%', 'Cap Rate <span style="font-size:0.6rem;color:var(--text3);">(annual)</span>', p.avg_cap_rate >= 5 ? 'var(--accent)' : 'var(--text2)');
  document.getElementById('finPortfolioOverview').innerHTML = h;
}

function renderFinActuals() {
  var el = document.getElementById('finActualPerformance');
  if (!el || !finData) return;
  var actuals = finData.monthly_actuals || [];
  if (actuals.length === 0) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:8px;">No actual data yet. Import Guesty reservations on the PMS tab.</div>';
    return;
  }

  var range = getFinDateRange(finPeriod);
  var filtered = actuals.filter(function(a) { return a.month >= range.from && a.month <= range.to; });

  if (filtered.length === 0) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:8px;">No actual data for this period (' + range.from + ' to ' + range.to + ').</div>';
    return;
  }

  var totalRev = 0, totalNights = 0, totalAvail = 0, totalPayout = 0, totalBookings = 0;
  var totalCleaning = 0, totalTaxes = 0, totalCommission = 0, totalTaxesYouOwe = 0;
  var totalRefunded = 0, totalCancelFees = 0;
  var byProp = {};
  filtered.forEach(function(a) {
    totalRev += a.total_revenue || 0;
    totalNights += a.booked_nights || 0;
    totalAvail += a.available_nights || 30;
    totalPayout += a.host_payout || 0;
    totalBookings += a.num_reservations || 0;
    totalCleaning += a.cleaning_revenue || 0;
    totalTaxes += a.total_taxes || 0;
    totalCommission += a.platform_commission || 0;
    totalTaxesYouOwe += a.taxes_you_owe || 0;
    totalRefunded += a.total_refunded || 0;
    totalCancelFees += a.cancellation_fees || 0;
    var pk = a.property_id;
    if (!byProp[pk]) byProp[pk] = { name: (a.unit_number ? a.unit_number + ' — ' : '') + (a.prop_name || a.address), payout: 0, nights: 0, avail: 0 };
    byProp[pk].payout += a.host_payout || 0;
    byProp[pk].nights += a.booked_nights || 0;
    byProp[pk].avail += a.available_nights || 30;
  });

  var occ = totalAvail > 0 ? Math.round(totalNights / totalAvail * 100) : 0;
  var adr = totalNights > 0 ? Math.round(totalRev / totalNights) : 0;
  var uniqueMonths = new Set(filtered.map(function(a) { return a.month; })).size;
  var avgMonthlyPayout = uniqueMonths > 0 ? Math.round(totalPayout / uniqueMonths) : 0;

  var periodLabel = finPeriod === 'thismonth' ? 'This Month' : finPeriod === 'lastmonth' ? 'Last Month' : finPeriod === 'ytd' ? 'Year to Date' : finPeriod === 'thisyear' ? 'This Year' : finPeriod === 'lastyear' ? 'Last Year' : finPeriod === 'all' ? 'All Time' : 'Custom';
  var h = '<div style="padding:6px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">';
  h += '<span style="font-size:0.82rem;font-weight:600;color:var(--accent);">' + _ico('calendar', 13) + ' ' + periodLabel + ': ' + range.from + ' to ' + range.to + '</span>';
  h += '<span style="font-size:0.68rem;color:var(--text3);">' + Object.keys(byProp).length + ' properties · ' + uniqueMonths + ' months · Guesty confirmed only</span></div>';

  // Top metrics — what hit the bank
  h += '<div class="market-grid" style="margin-bottom:10px;">';
  h += finStat('$' + fmtNum(totalPayout), '' + _ico('dollarSign', 13) + ' In Your Bank', 'var(--accent)');
  h += finStat('$' + fmtNum(avgMonthlyPayout), 'Avg Monthly', 'var(--accent)');
  h += finStat(occ + '%', 'Occupancy', occ >= 50 ? 'var(--accent)' : occ >= 30 ? '#f59e0b' : 'var(--danger)');
  h += finStat('$' + adr, 'ADR');
  h += finStat(totalNights + '', 'Booked Nights');
  h += finStat(totalBookings + '', 'Bookings');
  h += '</div>';

  // Money flow breakdown — show a proper equation that adds up
  h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;font-size:0.78rem;">';
  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">MONEY FLOW — What Came In</div>';

  function flowRow(label, amount, color, indent) {
    return '<div style="display:flex;justify-content:space-between;padding:2px ' + (indent ? '0 2px 16px' : '0') + ';' + (color ? 'color:' + color + ';' : '') + '"><span>' + label + '</span><span style="font-family:DM Mono,monospace;">' + (amount < 0 ? '-' : '') + '$' + Math.abs(Math.round(amount)).toLocaleString() + '</span></div>';
  }

  // Gross income
  h += flowRow('Accommodation Revenue', totalRev);
  if (totalCleaning > 0) h += flowRow('+ Cleaning Fees Collected', totalCleaning);
  if (totalTaxesYouOwe > 0) h += flowRow('+ Taxes Collected (non-Airbnb)', totalTaxesYouOwe, '#f59e0b');
  // Deductions
  if (totalCommission > 0) h += flowRow('− Platform Commissions', -totalCommission, 'var(--danger)');
  if (totalRefunded > 0) h += flowRow('− Guest Refunds', -totalRefunded, 'var(--danger)');
  if (totalCancelFees > 0) h += flowRow('+ Cancellation Fees Retained', totalCancelFees, '#f59e0b');
  // Total line
  h += '<div style="border-top:2px solid var(--border);margin:6px 0;"></div>';
  h += '<div style="display:flex;justify-content:space-between;font-weight:700;font-size:0.85rem;"><span style="color:var(--accent);">= Total Deposited to Bank</span><span style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(totalPayout).toLocaleString() + '</span></div>';
  // Verification line — show the math
  var calcTotal = totalRev + totalCleaning + totalTaxesYouOwe - totalCommission - totalRefunded + totalCancelFees;
  var diff = Math.abs(Math.round(totalPayout) - Math.round(calcTotal));
  if (diff > 10 && totalPayout > 0) {
    h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:4px;">Note: bank deposit ($' + Math.round(totalPayout).toLocaleString() + ') differs from sum above ($' + Math.round(calcTotal).toLocaleString() + ') by $' + diff.toLocaleString() + ' — this is typically Airbnb-remitted taxes that pass through but aren\'t your money.</div>';
  }
  h += '</div>';

  // Tax breakdown (informational)
  if (totalTaxes > 0) {
    var airbnbTaxes = totalTaxes - totalTaxesYouOwe;
    h += '<div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:0.75rem;margin-bottom:8px;">';
    h += '<div style="font-size:0.68rem;font-weight:600;color:var(--text3);margin-bottom:4px;">TAX SUMMARY</div>';
    if (airbnbTaxes > 0) h += '<div style="display:flex;justify-content:space-between;padding:1px 0;color:var(--text3);"><span>Airbnb-remitted taxes (handled for you)</span><span style="font-family:DM Mono,monospace;">$' + Math.round(airbnbTaxes).toLocaleString() + '</span></div>';
    if (totalTaxesYouOwe > 0) h += '<div style="display:flex;justify-content:space-between;padding:1px 0;color:#f59e0b;"><span>' + _ico('alertCircle', 13, '#f59e0b') + ' Taxes you collected (must remit)</span><span style="font-family:DM Mono,monospace;">$' + Math.round(totalTaxesYouOwe).toLocaleString() + '</span></div>';
    h += '</div>';
  }

  el.innerHTML = h;
}

function renderFinProjections(p) {
  var el = document.getElementById('finProjections');
  if (!el || !p) return;
  var now = new Date();
  var monthsLeft = 12 - now.getMonth();
  var monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var thisMonth = monthNames[now.getMonth()] + ' ' + now.getFullYear();
  var thisYear = now.getFullYear();

  var h = '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:8px;">' + _ico('target', 13) + ' STR revenue: PriceLabs forward rates × smart occupancy. LTR revenue: LTR strategy estimates. Inactive properties excluded from revenue. All figures are estimates, not guaranteed.</div>';
  h += '<table class="comp-table" style="font-size:0.82rem;"><thead><tr><th></th><th>This Month <span style="font-weight:400;color:var(--text3);">(' + thisMonth + ')</span></th><th>This Year <span style="font-weight:400;color:var(--text3);">(' + thisYear + ')</span></th><th>Annual (12mo rolling)</th></tr></thead><tbody>';
  h += '<tr><td style="font-weight:600;">Est. Revenue</td>';
  h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(p.monthly_revenue).toLocaleString() + '</td>';
  h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(p.annual_revenue).toLocaleString() + '</td>';
  h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(p.monthly_revenue * 12).toLocaleString() + '</td></tr>';
  h += '<tr><td style="font-weight:600;">Est. Expenses</td>';
  h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + Math.round(p.monthly_cost).toLocaleString() + '</td>';
  h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + Math.round(p.annual_cost).toLocaleString() + '</td>';
  h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + Math.round(p.monthly_cost * 12).toLocaleString() + '</td></tr>';
  var nc = p.monthly_net >= 0 ? 'var(--accent)' : 'var(--danger)';
  h += '<tr style="font-weight:700;"><td>Est. Net Income</td>';
  h += '<td style="font-family:DM Mono,monospace;color:' + nc + ';">' + (p.monthly_net >= 0 ? '+' : '') + '$' + Math.round(p.monthly_net).toLocaleString() + '</td>';
  h += '<td style="font-family:DM Mono,monospace;color:' + nc + ';">' + (p.annual_net >= 0 ? '+' : '') + '$' + Math.round(p.annual_net).toLocaleString() + '</td>';
  h += '<td style="font-family:DM Mono,monospace;color:' + nc + ';">' + (p.monthly_net * 12 >= 0 ? '+' : '') + '$' + Math.round(p.monthly_net * 12).toLocaleString() + '</td></tr>';
  h += '</tbody></table>';

  el.innerHTML = h;
}

function renderFinActualVsExpected(portfolio) {
  var el = document.getElementById('finActualVsExpected');
  if (!el || !finData) return;
  var actuals = finData.monthly_actuals || [];
  if (actuals.length === 0 || !portfolio) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:8px;">Need Guesty actuals to compare. Import on PMS tab.</div>';
    return;
  }

  var range = getFinDateRange(finPeriod);
  var filtered = actuals.filter(function(a) { return a.month >= range.from && a.month <= range.to; });
  if (filtered.length === 0) { el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:8px;">No data for this period.</div>'; return; }

  var now = new Date();
  var currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  var monthNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Aggregate by month with smart expectations
  var byMonth = {};
  filtered.forEach(function(a) {
    if (!byMonth[a.month]) byMonth[a.month] = { revenue: 0, expected: 0, sources: {} };
    byMonth[a.month].revenue += a.total_revenue || 0;
    var eKey = a.property_id + '_' + a.month;
    var exp = finExpectations[eKey];
    if (exp) {
      byMonth[a.month].expected += exp.expected;
      byMonth[a.month].sources[exp.source] = (byMonth[a.month].sources[exp.source] || 0) + 1;
    }
  });
  var months = Object.keys(byMonth).sort();

  var h = '';
  if (months.length > 0) {
    var totalActual = 0, totalExpected = 0;
    h += '<div style="font-size:0.68rem;color:var(--text3);margin-bottom:6px;">Expected based on: same month last year \u2192 seasonal avg \u2192 property avg \u00d7 seasonality \u2192 PriceLabs estimate</div>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">';
    months.forEach(function(m) {
      var actual = Math.round(byMonth[m].revenue);
      var expected = byMonth[m].expected || Math.round(portfolio.monthly_revenue || 0);
      var isCurrent = m === currentMonth;
      var mn = parseInt(m.substring(5));
      var mName = monthNames[mn] || m.substring(5);

      // For current partial month: scale expected to days elapsed, show pace
      var daysInThisMonth = new Date(parseInt(m.substring(0,4)), mn, 0).getDate();
      var daysElapsed = isCurrent ? now.getDate() : daysInThisMonth;
      var scaledExpected = isCurrent ? Math.round(expected * daysElapsed / daysInThisMonth) : expected;
      var paceMonthly = isCurrent && daysElapsed > 0 ? Math.round(actual / daysElapsed * daysInThisMonth) : null;
      var pct = scaledExpected > 0 ? Math.round(actual / scaledExpected * 100) : 0;
      var diff = actual - scaledExpected;

      var bg = isCurrent ? 'rgba(245,158,11,0.1)' : pct >= 95 ? 'rgba(16,185,129,0.06)' : pct >= 75 ? 'rgba(245,158,11,0.06)' : 'rgba(239,68,68,0.06)';
      var tc = isCurrent ? '#f59e0b' : pct >= 95 ? 'var(--accent)' : pct >= 75 ? '#f59e0b' : 'var(--danger)';
      var border = isCurrent ? 'rgba(245,158,11,0.3)' : pct >= 95 ? 'rgba(16,185,129,0.2)' : pct >= 75 ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)';
      var icon = isCurrent ? '\ud83d\udcca' : pct >= 110 ? '\ud83d\ude80' : pct >= 95 ? '\u2705' : pct >= 75 ? '\u26a0\ufe0f' : '\u274c';
      totalActual += actual;
      totalExpected += scaledExpected; // use scaled for summary too
      var srcTip = Object.keys(byMonth[m].sources).join(', ') || 'PriceLabs est';
      h += '<div style="flex:1;min-width:100px;padding:8px 6px;background:' + bg + ';border-radius:8px;text-align:center;border:1px solid ' + border + ';cursor:pointer;transition:opacity 0.15s;" title="Click to see property breakdown" onclick="showMonthDrilldown(\'' + m + '\')" onmouseenter="this.style.opacity=0.8" onmouseleave="this.style.opacity=1">';
      h += '<div style="font-size:0.75rem;color:var(--text2);font-weight:600;">' + mName + ' ' + m.substring(0, 4) + (isCurrent ? ' *' : '') + '</div>';
      h += '<div style="font-size:0.9rem;margin:3px 0;">' + icon + '</div>';
      h += '<div style="font-family:DM Mono,monospace;font-size:0.85rem;font-weight:700;color:' + tc + ';">$' + (actual / 1000).toFixed(1) + 'K</div>';
      if (isCurrent) {
        h += '<div style="font-size:0.62rem;color:var(--text3);">exp $' + (scaledExpected / 1000).toFixed(1) + 'K (' + daysElapsed + '/' + daysInThisMonth + 'd)</div>';
        if (paceMonthly) h += '<div style="font-size:0.6rem;color:var(--text3);">pace → $' + (paceMonthly / 1000).toFixed(1) + 'K/mo</div>';
      } else {
        h += '<div style="font-size:0.62rem;color:var(--text3);">expected $' + (expected / 1000).toFixed(1) + 'K</div>';
      }
      h += '<div style="font-family:DM Mono,monospace;font-size:0.72rem;font-weight:600;color:' + tc + ';">' + (diff >= 0 ? '+' : '') + '$' + (Math.abs(diff) >= 1000 ? (diff / 1000).toFixed(1) + 'K' : diff.toLocaleString()) + '</div>';
      h += '</div>';
    });
    h += '</div>';
    var totalPct = totalExpected > 0 ? Math.round(totalActual / totalExpected * 100) : 0;
    var totalDiff = totalActual - totalExpected;
    var sc = totalPct >= 95 ? 'var(--accent)' : totalPct >= 75 ? '#f59e0b' : 'var(--danger)';
    var summaryIcon = totalPct >= 110 ? '\ud83d\ude80 Exceeding targets' : totalPct >= 95 ? '\u2705 On track' : totalPct >= 75 ? '\u26a0\ufe0f Slightly behind' : '\u274c Below target';
    // Build a human-readable period description using actual month names
    var fullMonthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    function fmtYearMonth(ym) {
      var y = parseInt(ym.substring(0, 4)), m = parseInt(ym.substring(5, 7));
      return (fullMonthNames[m - 1] || ym) + ' ' + y;
    }
    var sortedMonths = months.slice().sort();
    var periodDesc;
    if (sortedMonths.length === 1) {
      periodDesc = fmtYearMonth(sortedMonths[0]);
    } else if (finPeriod === 'ytd') {
      periodDesc = fmtYearMonth(sortedMonths[0]) + ' – ' + fmtYearMonth(sortedMonths[sortedMonths.length - 1]) + ' (YTD)';
    } else if (finPeriod === 'thismonth') {
      periodDesc = fmtYearMonth(sortedMonths[0]);
    } else if (finPeriod === 'lastmonth') {
      periodDesc = fmtYearMonth(sortedMonths[0]);
    } else {
      periodDesc = fmtYearMonth(sortedMonths[0]) + ' – ' + fmtYearMonth(sortedMonths[sortedMonths.length - 1]);
    }
    h += '<div style="padding:10px 14px;background:var(--bg);border-radius:6px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    h += '<div><span style="font-size:0.88rem;font-weight:700;color:' + sc + ';">' + summaryIcon + '</span>';
    h += '<div style="font-size:0.7rem;color:var(--text3);margin-top:2px;">' + _ico('calendar', 13) + ' ' + periodDesc + '</div></div>';
    h += '<div style="text-align:right;">';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.88rem;"><span style="color:var(--accent);">$' + Math.round(totalActual).toLocaleString() + '</span> actual vs <span style="color:var(--text2);">$' + Math.round(totalExpected).toLocaleString() + '</span> expected</div>';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.85rem;font-weight:700;color:' + sc + ';">' + (totalDiff >= 0 ? '+' : '') + '$' + Math.round(totalDiff).toLocaleString() + ' (' + totalPct + '%)</div>';
    h += '</div></div></div>';
  }

  // Property Scoreboard — ALL non-research properties, not just ones with Guesty data
  var byProp = {};

  // Start with actuals data
  // For current partial month: scale expected to days elapsed so comparison is fair
  var nowDay = now.getDate();
  var currentMonthDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  filtered.forEach(function(a) {
    var pk = a.property_id;
    if (!byProp[pk]) byProp[pk] = { id: pk, name: (a.unit_number ? a.unit_number + ' — ' : '') + (a.prop_name || a.address), actual: 0, expected: 0, months: 0, sources: [], hasActuals: true, monthlyCost: 0, isPartial: false };
    byProp[pk].actual += a.total_revenue || 0;
    byProp[pk].months++;
    var eKey = pk + '_' + a.month;
    var exp = finExpectations[eKey];
    if (exp) {
      // Scale current month expected to days elapsed
      var scaledExp = (a.month === currentMonth)
        ? Math.round(exp.expected * nowDay / currentMonthDays)
        : exp.expected;
      if (a.month === currentMonth) byProp[pk].isPartial = true;
      byProp[pk].expected += scaledExp;
      if (byProp[pk].sources.indexOf(exp.source) < 0) byProp[pk].sources.push(exp.source);
    }
  });

  // Add ALL non-research properties including ones with no bookings
  var props = finData.properties || [];
  var range2 = getFinDateRange(finPeriod);
  var rangeMonths = 1;
  if (range2.from && range2.to) {
    var rfy = parseInt(range2.from.substring(0, 4)) || 2026, rfm = parseInt(range2.from.substring(5, 7)) || 1;
    var rty = parseInt(range2.to.substring(0, 4)) || 2026, rtm = parseInt(range2.to.substring(5, 7)) || 12;
    rangeMonths = Math.max(1, (rty - rfy) * 12 + (rtm - rfm) + 1);
  }

  props.forEach(function(p) {
    var pk = p.id;
    if (!byProp[pk]) {
      var label = (p.unit_number ? p.unit_number + ' \u2014 ' : '') + (p.name || p.address || 'Property ' + pk);
      var mc = p.monthly_cost || 0;
      var monthlyExp = Math.max(p.monthly_revenue || 0, Math.round(mc * 1.15));
      // Scale last month of range if it's current partial month
      var adjustedExpected = monthlyExp * (rangeMonths - 1) + Math.round(monthlyExp * nowDay / currentMonthDays);
      var adjustedExpected2 = range2.to >= currentMonth ? adjustedExpected : monthlyExp * rangeMonths;
      byProp[pk] = { id: pk, name: label, actual: 0, expected: adjustedExpected2, months: rangeMonths, sources: ['no bookings yet'], hasActuals: false, monthlyCost: mc, isPartial: range2.to >= currentMonth };
    } else if (byProp[pk].expected === 0) {
      var mc2 = p.monthly_cost || 0;
      byProp[pk].expected = Math.max((p.monthly_revenue || 0), Math.round(mc2 * 1.15)) * byProp[pk].months;
      byProp[pk].sources = ['cost floor'];
      byProp[pk].monthlyCost = mc2;
    }
  });

  var propList = Object.values(byProp).filter(function(p) { return p.expected > 0; }).sort(function(a, b) { return (b.actual / (b.expected || 1)) - (a.actual / (a.expected || 1)); });

  if (propList.length > 0) {
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:6px;">Property Scoreboard (' + propList.length + ' properties)</div>';
    h += '<div style="display:grid;gap:5px;">';
    propList.forEach(function(p) {
      var pct = p.expected > 0 ? Math.round(p.actual / p.expected * 100) : 0;
      var diff = Math.round(p.actual - p.expected);
      var c = pct >= 100 ? 'var(--accent)' : pct >= 80 ? '#f59e0b' : 'var(--danger)';
      var icon = pct >= 110 ? '\ud83d\ude80' : pct >= 100 ? '\ud83d\udfe2' : pct >= 80 ? '\ud83d\udfe1' : '\ud83d\udd34';
      var avgExp = p.months > 0 ? Math.round(p.expected / p.months) : 0;
      var badge = '';
      if (!p.hasActuals) {
        badge = ' <span style="font-size:0.6rem;background:rgba(245,158,11,0.15);color:#f59e0b;padding:1px 5px;border-radius:3px;">NEW</span>';
        icon = '\u26a0\ufe0f';
        c = '#f59e0b';
      }
      h += '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg);border-radius:6px;border:1px solid var(--border);border-left:4px solid ' + c + ';">';
      h += '<span style="font-size:0.82rem;">' + icon + '</span>';
      h += '<div style="flex:1;min-width:0;">';
      h += '<div style="font-size:0.78rem;font-weight:600;">' + esc(p.name) + badge + '</div>';
      h += '<div style="font-size:0.58rem;color:var(--text3);">';
      if (p.hasActuals) {
        var completedMonths = p.isPartial ? p.months - 1 : p.months;
        var partialNote = p.isPartial ? ' · day ' + nowDay + '/' + currentMonthDays : '';
        var paceNote = '';
        if (p.isPartial && nowDay > 0) {
          // Pace = what this month's actual would be if it continued at current rate
          // We need the current month actual only — approximate from total if mixed period
          var paceMonthly = Math.round(p.actual / nowDay * currentMonthDays);
          paceNote = ' · pace $' + paceMonthly.toLocaleString() + '/mo';
        }
        h += p.months + ' mo' + partialNote + ' · ~$' + avgExp.toLocaleString() + '/mo exp' + paceNote + ' · <em>' + p.sources.join(', ') + '</em>';
      } else {
        h += 'Costing $' + Math.round(p.monthlyCost || 0).toLocaleString() + '/mo · needs $' + avgExp.toLocaleString() + '/mo revenue to cover costs';
      }
      h += '</div></div>';
      h += '<div style="width:70px;height:5px;background:var(--surface2);border-radius:3px;overflow:hidden;"><div style="height:100%;width:' + Math.min(pct, 150) + '%;background:' + c + ';border-radius:3px;"></div></div>';
      h += '<div style="text-align:right;min-width:110px;">';
      h += '<div style="font-family:DM Mono,monospace;font-size:0.72rem;"><span style="color:' + (p.actual > 0 ? 'var(--accent)' : 'var(--danger)') + ';">$' + Math.round(p.actual).toLocaleString() + '</span> <span style="color:var(--text3);">/ $' + Math.round(p.expected).toLocaleString() + '</span></div>';
      h += '<div style="font-family:DM Mono,monospace;font-size:0.68rem;font-weight:700;color:' + c + ';">' + (diff >= 0 ? '+' : '') + '$' + diff.toLocaleString() + ' (' + pct + '%)</div>';
      h += '</div></div>';
    });
    h += '</div>';
  }

  el.innerHTML = h;
}


function renderServiceBreakdown(p) {
  var el = document.getElementById('finServiceBreakdown');
  if (!el) return;
  var sb = p.service_breakdown;
  if (!sb || !sb.length || p.monthly_services <= 0) { el.innerHTML = ''; return; }
  var h = '<div class="card" style="margin-top:14px;">';
  h += '<h3 style="margin-bottom:10px;">Monthly Service Costs</h3>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:12px;">';

  sb.forEach(function(s) {
    h += '<div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
    h += '<span style="font-weight:600;font-size:0.85rem;">' + esc(s.name) + '</span>';
    h += '<span style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:var(--purple);">$' + Math.round(s.monthly) + '/mo</span></div>';
    h += '<div style="font-size:0.72rem;color:var(--text3);">' + s.count + ' properties &middot; $' + Math.round(s.monthly * 12) + '/yr</div></div>';
  });
  h += '</div>';

  h += '<div style="display:flex;justify-content:space-between;padding:10px 14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
  h += '<span style="font-weight:600;">Total Service Costs</span>';
  h += '<div style="font-family:DM Mono,monospace;text-align:right;">';
  h += '<span style="font-size:1.05rem;font-weight:700;color:var(--purple);">$' + p.monthly_services + '/mo</span>';
  h += '<span style="font-size:0.82rem;color:var(--text3);margin-left:8px;">$' + (p.monthly_services * 12) + '/yr</span>';
  h += '</div></div></div>';
  el.innerHTML = h;
}

function renderApiCosts(costs) {
  var el = document.getElementById('finApiCosts');
  if (!el) return;
  var services = Object.keys(costs);
  if (services.length === 0) { el.innerHTML = ''; return; }
  var totalCents = 0;
  var h = '<div style="margin-top:20px;"><label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:8px;">API & SERVICE COSTS (THIS MONTH)</label>';
  h += '<table class="comp-table"><thead><tr><th>Service</th><th>Usage</th><th>Plan / Limit</th><th>Status</th><th>Est. Cost</th></tr></thead><tbody>';

  // Separate variable-use services from fixed costs
  var fixedRows = [];
  services.forEach(function(k) {
    var s = costs[k];
    if (!s || (!s.calls && !s.listings && !s.fixed)) return;

    if (s.fixed) {
      fixedRows.push({ k: k, s: s });
      totalCents += s.cost_cents || 0;
      return;
    }

    var statusHtml = '';
    if (s.over_limit) {
      statusHtml = '<span style="color:var(--danger);font-weight:600;">' + _ico('alertCircle', 13, '#f59e0b') + ' Over ' + (s.budget_dollars ? 'budget' : 'limit') + '</span>';
    } else if (s.budget_dollars) {
      // Paid AI service with budget
      var bPct = s.budget_pct || 0;
      var bColor = bPct >= 90 ? 'var(--danger)' : bPct >= 70 ? '#f59e0b' : 'var(--accent)';
      statusHtml = '<span style="color:' + bColor + ';">$' + (s.budget_remaining || 0).toFixed(2) + ' left (' + bPct + '%)</span>';
    } else if (s.free_limit && s.remaining !== undefined) {
      var pct = Math.round(s.calls / s.free_limit * 100);
      statusHtml = '<span style="color:' + (pct > 80 ? '#f59e0b' : 'var(--accent)') + ';">' + s.remaining + ' remaining</span>';
    } else if (s.listings) {
      statusHtml = s.listings + ' listings';
    } else {
      statusHtml = '<span style="color:var(--accent);">✓</span>';
    }
    var cost = (s.cost_cents || 0) / 100;
    totalCents += s.cost_cents || 0;
    var planText = s.budget_dollars ? '$' + s.budget_dollars.toFixed(0) + '/mo budget' : s.free_limit ? s.free_limit + '/mo free' : s.listings ? '$1/listing' : '—';
    h += '<tr><td style="font-weight:600;">' + esc(s.label || k) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (s.calls != null ? s.calls : s.listings || 0) + (s.tokens ? ' <span style="font-size:0.68rem;color:var(--text3);">(' + Math.round(s.tokens / 1000) + 'K tok)</span>' : '') + '</td>';
    h += '<td style="font-size:0.78rem;">' + planText + '</td>';
    h += '<td style="font-size:0.78rem;">' + statusHtml + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (cost > 0 ? 'var(--danger)' : 'var(--accent)') + ';">$' + cost.toFixed(2) + '</td></tr>';
  });

  // Fixed infrastructure rows — always shown with a distinct style
  if (fixedRows.length > 0) {
    h += '<tr style="background:rgba(99,102,241,0.04);"><td colspan="5" style="font-size:0.68rem;color:var(--text3);padding:4px 8px;letter-spacing:0.05em;">FIXED INFRASTRUCTURE</td></tr>';
    fixedRows.forEach(function(item) {
      var s = item.s;
      var cost = (s.cost_cents || 0) / 100;
      h += '<tr style="background:rgba(99,102,241,0.04);">';
      h += '<td style="font-weight:600;">' + _ico('cloud', 13) + ' ' + esc(s.label || item.k) + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">fixed</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">' + esc(s.note || '') + '</td>';
      h += '<td><span style="color:var(--accent);">✓ active</span></td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + cost.toFixed(2) + '</td></tr>';
    });
  }

  h += '</tbody></table>';

  // Limit behavior explanation
  h += '<div style="margin-top:10px;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:0.72rem;color:var(--text3);line-height:1.6;">';
  h += '<div style="font-weight:600;color:var(--text2);margin-bottom:4px;">What happens at limits?</div>';
  h += '<div><strong>Anthropic / OpenAI</strong> — Budget-based. When monthly budget is reached, AI analysis falls back to free Workers AI (lower quality but still functional). Adjust budgets in Admin → API Budgets.</div>';
  h += '<div><strong>RentCast</strong> — 50 free calls/month. After that, lookups for long-term rental comps will fail until next month. Only used for LTR comps, never STR.</div>';
  h += '<div><strong>SearchAPI</strong> — 100 free calls/month. Used for Zillow Zestimates and Google searches. After limit, these features return errors until reset.</div>';
  h += '<div><strong>Google Places</strong> — 1,000 free/month. Used for property lookups and nearby amenities. After limit, lookup features stop working.</div>';
  h += '<div><strong>Cloudflare Workers</strong> — 10M requests/month on paid plan ($5/mo). App goes offline if exceeded (extremely unlikely at normal usage).</div>';
  h += '</div>';

  h += '<div style="display:flex;justify-content:flex-end;margin-top:8px;padding:8px 14px;background:var(--surface2);border-radius:6px;">';
  h += '<span style="font-size:0.85rem;margin-right:12px;">Est. Monthly Total:</span>';
  h += '<span style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:' + (totalCents > 1000 ? 'var(--danger)' : 'var(--accent)') + ';">$' + (totalCents / 100).toFixed(2) + '/mo</span></div>';
  h += '</div>';
  el.innerHTML = h;

  // Load Cloudflare usage
  loadCfUsage();
}

async function loadCfUsage() {
  try {
    var d = await api('/api/cf-usage');
    var el = document.getElementById('finApiCosts');
    if (!el) return;

    var cfh = '<div style="margin-top:14px;padding:14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">';
    cfh += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">' + _ico('cloud', 13) + ' CLOUDFLARE WORKERS USAGE</div>';

    var todayPct = d.today.pct_of_limit || 0;
    var todayColor = todayPct > 80 ? 'var(--danger)' : todayPct > 50 ? '#f59e0b' : 'var(--accent)';
    cfh += '<div class="market-grid" style="margin-bottom:10px;">';
    cfh += '<div class="market-stat"><div class="val" style="color:' + todayColor + ';">' + (d.today.requests || 0).toLocaleString() + '</div><div class="lbl">Requests Today</div></div>';
    cfh += '<div class="market-stat"><div class="val">' + (d.today.api_requests || 0).toLocaleString() + '</div><div class="lbl">API Calls Today</div></div>';
    cfh += '<div class="market-stat"><div class="val">' + (d.this_month.requests || 0).toLocaleString() + '</div><div class="lbl">This Month</div></div>';
    cfh += '<div class="market-stat"><div class="val">~' + (d.this_month.avg_per_day || 0).toLocaleString() + '</div><div class="lbl">Avg/Day</div></div>';
    cfh += '<div class="market-stat"><div class="val">' + (d.database.total_rows || 0).toLocaleString() + '</div><div class="lbl">DB Rows</div></div>';
    cfh += '<div class="market-stat"><div class="val">' + (d.database.table_count || 0) + '</div><div class="lbl">Tables</div></div>';
    cfh += '</div>';

    cfh += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:4px;">Daily: ' + (d.today.requests || 0).toLocaleString() + ' / ' + (d.limits.requests_per_day || 333333).toLocaleString() + ' (' + todayPct + '%)</div>';
    cfh += '<div style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;margin-bottom:8px;">';
    cfh += '<div style="height:100%;width:' + Math.min(todayPct, 100) + '%;background:' + todayColor + ';border-radius:3px;"></div></div>';

    if (d.last_7_days && d.last_7_days.length > 0) {
      var maxReqs = Math.max.apply(null, d.last_7_days.map(function(r) { return r.requests || 0; }));
      cfh += '<div style="font-size:0.68rem;color:var(--text3);margin-bottom:4px;">Last 7 days</div>';
      cfh += '<div style="display:flex;gap:3px;align-items:flex-end;height:40px;">';
      d.last_7_days.forEach(function(day) {
        var pct = maxReqs > 0 ? Math.round((day.requests || 0) / maxReqs * 100) : 0;
        cfh += '<div style="flex:1;text-align:center;"><div style="background:var(--accent);border-radius:2px 2px 0 0;height:' + Math.max(pct, 3) + '%;min-height:2px;opacity:0.7;" title="' + day.date + ': ' + (day.requests || 0) + ' requests"></div>';
        cfh += '<div style="font-size:0.5rem;color:var(--text3);margin-top:1px;">' + (day.date || '').substring(5) + '</div></div>';
      });
      cfh += '</div>';
    }

    cfh += '<div style="margin-top:8px;padding:6px 10px;background:var(--surface2);border-radius:6px;font-size:0.68rem;color:var(--text3);">';
    cfh += '' + _ico('cloud', 13) + ' Workers Paid: 10M req/mo · D1: 25M reads/day, 50M writes/day, 5GB storage · $5/mo flat</div>';
    cfh += '</div>';

    el.innerHTML += cfh;
  } catch {}
}

async function loadUsageAlerts() {
  try {
    var d = await api('/api/usage-alerts');
    var alerts = d.alerts || [];
    var el = document.getElementById('finApiCosts');
    if (!el || alerts.length === 0) return;
    var h = '<div style="margin-top:10px;">';
    alerts.forEach(function(a) {
      var bg = a.level === 'critical' ? 'rgba(239,68,68,0.08)' : a.level === 'warning' ? 'rgba(245,158,11,0.08)' : 'rgba(96,165,250,0.06)';
      var border = a.level === 'critical' ? 'rgba(239,68,68,0.3)' : a.level === 'warning' ? 'rgba(245,158,11,0.3)' : 'rgba(96,165,250,0.2)';
      var icon = a.level === 'critical' ? '' + _ico('alertCircle', 13, 'var(--danger)') + '' : a.level === 'warning' ? '' + _ico('alertCircle', 13, '#f59e0b') + '' : '' + _ico('info', 13, 'var(--blue)') + '';
      var tc = a.level === 'critical' ? 'var(--danger)' : a.level === 'warning' ? '#f59e0b' : 'var(--text2)';
      h += '<div style="padding:6px 10px;background:' + bg + ';border:1px solid ' + border + ';border-radius:6px;margin-bottom:4px;font-size:0.75rem;display:flex;align-items:center;gap:6px;">';
      h += '<span>' + icon + '</span><span style="color:' + tc + ';"><strong>' + esc(a.service) + ':</strong> ' + esc(a.msg) + '</span></div>';
    });
    // AI cost summary
    if (d.ai_summary && d.ai_summary.total_calls > 0) {
      h += '<div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-top:8px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:4px;">' + _ico('sparkle', 13) + ' AI COSTS THIS MONTH</div>';
      h += '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.78rem;">';
      h += '<span>Total: <strong style="font-family:DM Mono,monospace;color:' + (d.ai_summary.total_cost > 10 ? '#f59e0b' : 'var(--accent)') + ';">$' + d.ai_summary.total_cost.toFixed(2) + '</strong></span>';
      h += '<span>' + d.ai_summary.total_calls + ' calls</span>';
      (d.ai_summary.by_provider || []).forEach(function(p) {
        var provCost = ((p.cost || 0) / 100).toFixed(2);
        h += '<span style="color:var(--text3);">' + esc(p.provider) + ': ' + p.calls + ' calls, ~' + Math.round((p.tokens || 0) / 1000) + 'K tokens, $' + provCost + '</span>';
      });
      h += '</div></div>';
    }
    h += '</div>';
    el.innerHTML += h;
  } catch {}
}

function finStat(val, lbl, color) {
  return '<div class="market-stat"><div class="val"' + (color ? ' style="color:' + color + ';"' : '') + '>' + val + '</div><div class="lbl">' + lbl + '</div></div>';
}

function fmtNum(n) {
  if (n === null || n === undefined) return '0';
  n = Math.round(n);
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1) + 'K';
  return n.toLocaleString();
}

function renderFinanceByCity(cities) {
  if (!cities || cities.length === 0) { document.getElementById('finByCity').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No data yet.</p>'; return; }
  var h = '<table class="comp-table"><thead><tr><th>Market</th><th>Properties</th><th>Value</th><th>Revenue/mo</th><th>Cost/mo</th><th>Net/mo</th></tr></thead><tbody>';
  cities.forEach(function(c) {
    var net = (c.revenue || 0) - (c.cost || 0);
    var netColor = net >= 0 ? 'var(--accent)' : 'var(--danger)';
    h += '<tr><td>' + esc(c.city || '?') + ', ' + esc(c.state || '') + '</td>';
    h += '<td style="text-align:center;">' + c.count + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">$' + fmtNum(c.value) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + fmtNum(c.revenue) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + fmtNum(c.cost) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + netColor + ';font-weight:600;">$' + fmtNum(net) + '</td></tr>';
  });
  h += '</tbody></table>';
  document.getElementById('finByCity').innerHTML = h;
}

function renderFinancePropertyTable(props) {
  if (!props || props.length === 0) { document.getElementById('finPropertyTable').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Add properties with financial data to see P&L breakdown.</p>'; return; }

  // Split active vs inactive so they don't mix in the totals
  var activeProps = props.filter(function(p) { return !p.is_inactive; });
  var inactiveProps = props.filter(function(p) { return p.is_inactive; });

  function buildTable(list, showTotals) {
    var h = '<table class="comp-table"><thead><tr><th>Property</th><th>Type</th><th>Rev/mo</th><th>Cost/mo</th><th>Services</th><th>Net/mo</th><th>Annual Net</th></tr></thead><tbody>';
    var totalRev = 0, totalCost = 0, totalSvc = 0;
    list.forEach(function(p) {
      var netColor = (p.monthly_net || 0) >= 0 ? 'var(--accent)' : 'var(--danger)';
      var annNet = Math.round((p.monthly_net || 0) * 12);
      totalRev += p.monthly_revenue || 0;
      totalCost += p.monthly_cost || 0;
      totalSvc += p.service_cost || 0;
      var label = p.unit_number ? (p.unit_number + ' — ' + (p.name || p.city)) : (p.name || p.city || 'Property');
      var svcTip = (p.services || []).join(', ') || 'none';
      var typeBadge = p.rental_type === 'ltr'
        ? '<span style="font-size:0.6rem;background:rgba(96,165,250,0.15);color:#60a5fa;padding:1px 4px;border-radius:3px;margin-left:4px;">LTR</span>'
        : '<span style="font-size:0.6rem;background:rgba(167,139,250,0.1);color:var(--purple);padding:1px 4px;border-radius:3px;margin-left:4px;">STR</span>';
      var revSrcTip = { pricelabs: 'PriceLabs forward rate', str_estimate: 'STR strategy estimate', ltr_estimate: 'LTR strategy estimate', none: 'No estimate yet' }[p.rev_source] || '';
      var cityState = (p.city || '') + (p.state ? ', ' + p.state : '');
      h += '<tr' + (p.is_inactive ? ' style="opacity:0.6;"' : '') + '>';
      h += '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(cityState) + '">' + esc(label) + typeBadge + '</td>';
      h += '<td style="font-size:0.78rem;">' + esc(p.property_type || '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);" title="' + revSrcTip + '">' + (p.monthly_revenue > 0 ? '$' + fmtNum(p.monthly_revenue) + '<div style="font-size:0.58rem;color:var(--text3);">' + revSrcTip + '</div>' : '<span style="color:var(--text3);">—</span>') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">' + (p.monthly_cost > 0 ? '$' + fmtNum(p.monthly_cost) : '<span style="color:var(--text3);">—</span>') + (p.building_alloc ? '<div style="font-size:0.6rem;color:#f59e0b;">incl. bldg $' + p.building_alloc + '</div>' : '') + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--purple);" title="' + esc(svcTip) + '">' + (p.service_cost > 0 ? '$' + p.service_cost : '<span style="color:var(--text3);">—</span>') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + netColor + ';font-weight:600;">' + (p.monthly_net !== 0 ? '$' + fmtNum(p.monthly_net) : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + netColor + ';">' + (annNet !== 0 ? '$' + fmtNum(annNet) : '—') + '</td></tr>';
    });
    if (showTotals) {
      var totalNet = totalRev - totalCost;
      var totColor = totalNet >= 0 ? 'var(--accent)' : 'var(--danger)';
      h += '<tr style="border-top:2px solid var(--border);font-weight:700;"><td colspan="2" style="text-align:right;">TOTAL</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + fmtNum(totalRev) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + fmtNum(totalCost) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--purple);">$' + fmtNum(totalSvc) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + totColor + ';">$' + fmtNum(totalNet) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + totColor + ';">$' + fmtNum(totalNet * 12) + '</td></tr>';
    }
    h += '</tbody></table>';
    return h;
  }

  var h = '';
  if (activeProps.length > 0) {
    h += buildTable(activeProps, true);
  }
  if (inactiveProps.length > 0) {
    h += '<div style="margin-top:14px;padding:8px 12px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.15);border-radius:6px;">';
    h += '<div style="font-size:0.72rem;font-weight:600;color:var(--danger);margin-bottom:6px;">⏹ INACTIVE PROPERTIES — Expenses still running, revenue excluded from totals</div>';
    h += buildTable(inactiveProps, false);
    h += '</div>';
  }

  document.getElementById('finPropertyTable').innerHTML = h;
}

// Admin: View as User

async function loadAdminUserSelect() {
  try {
    var d = await apiAuth('/api/admin/users-list');
    var sel = document.getElementById('adminViewAsUser');
    if (!sel) return;
    sel.innerHTML = '<option value="">All Data (Admin View)</option>';
    (d.users || []).forEach(function(u) {
      var label = esc(u.display_name || u.email) + ' (' + u.property_count + ' props, ' + u.listing_count + ' listings)';
      sel.innerHTML += '<option value="' + u.id + '"' + (viewAsUserId == u.id ? ' selected' : '') + '>' + label + '</option>';
    });
  } catch {}
}

function setViewAsUser(val) {
  viewAsUserId = val ? parseInt(val) : null;
  var statusEl = document.getElementById('viewAsStatus');
  if (viewAsUserId) {
    var sel = document.getElementById('adminViewAsUser');
    var name = sel ? sel.options[sel.selectedIndex].text : 'User ' + viewAsUserId;
    if (statusEl) statusEl.innerHTML ='' + _ico('search', 13) + ' Viewing as: <strong>' + esc(name) + '</strong> — all tabs show their data';
    toast('Now viewing as ' + name);
  } else {
    if (statusEl) statusEl.textContent = '';
    toast('Switched back to admin view (all data)');
  }
  // Refresh current views
  loadProperties();
}

async function loadCapitalExpenses() {
  var el = document.getElementById('finCapitalExpenses');
  if (!el) return;
  try {
    var d = await api('/api/expenses/summary');
    if (d.count === 0) { el.innerHTML = ''; return; }
    var catIcons = {closing:'' + _ico('clipboard', 13) + '',renovation:'' + _ico('tool', 13) + '',repair:_ico('tool',13),furniture:_ico('layers',15),appliance:'' + _ico('zap', 13) + '',legal:'' + _ico('receipt', 13) + '',other:_ico('target',13)};
    var h = '<div class="card" style="margin-top:14px;">';
    h += '<h3 style="margin-bottom:10px;">' + _ico('dollarSign', 13) + ' Capital Expenses</h3>';

    // Category breakdown
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:12px;">';
    d.by_category.forEach(function(c) {
      var icon = catIcons[c.category] || _ico('target',13);
      h += '<div style="padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
      h += '<span style="font-size:0.82rem;">' + icon + ' ' + esc(c.category) + '</span>';
      h += '<span style="font-family:DM Mono,monospace;font-weight:700;color:var(--purple);">$' + Math.round(c.total).toLocaleString() + '</span></div>';
      h += '<div style="font-size:0.68rem;color:var(--text3);">' + c.count + ' expenses</div></div>';
    });
    h += '</div>';

    // Totals
    h += '<div style="display:flex;justify-content:space-between;padding:10px 14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:10px;">';
    h += '<div><span style="font-weight:600;">Total Capital Invested</span>';
    if (d.this_year_total > 0) h += '<div style="font-size:0.68rem;color:var(--text3);">This year: $' + Math.round(d.this_year_total).toLocaleString() + '</div>';
    h += '</div>';
    h += '<span style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:var(--purple);">$' + Math.round(d.total).toLocaleString() + '</span></div>';

    // By property
    if (d.by_property.length > 0) {
      h += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">By property: ';
      h += d.by_property.map(function(p) { return esc(p.name || '') + (p.unit ? ' #' + p.unit : '') + ' $' + Math.round(p.total).toLocaleString(); }).join(' · ');
      h += '</div>';
    }

    h += '</div>';
    el.innerHTML = h;
  } catch { el.innerHTML = ''; }
}

// Month drill-down modal — shows per-property breakdown for a clicked month
function showMonthDrilldown(month) {
  if (!finData) return;
  var actuals = finData.monthly_actuals || [];
  var props = finData.properties || [];
  var now = new Date();
  var currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  var isCurrent = month === currentMonth;
  var mn = parseInt(month.substring(5));
  var yr = parseInt(month.substring(0, 4));
  var monthNames = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
  var mLabel = monthNames[mn] + ' ' + yr;
  var daysInMonth = new Date(yr, mn, 0).getDate();
  var daysElapsed = isCurrent ? now.getDate() : daysInMonth;

  // Get actuals for this month
  var monthActuals = actuals.filter(function(a) { return a.month === month; });

  // Build per-property rows
  var rows = [];
  var totalRev = 0, totalNights = 0, totalPayout = 0;

  // Properties with actuals
  monthActuals.forEach(function(a) {
    var propName = (a.unit_number ? a.unit_number + ' — ' : '') + (a.prop_name || a.address || 'Property ' + a.property_id);
    var exp = finExpectations[a.property_id + '_' + month];
    var fullExp = exp ? exp.expected : 0;
    var scaledExp = (isCurrent && fullExp > 0) ? Math.round(fullExp * daysElapsed / daysInMonth) : fullExp;
    var pct = scaledExp > 0 ? Math.round((a.total_revenue || 0) / scaledExp * 100) : null;
    var occ = Math.round((a.occupancy_pct || 0) * 100);
    rows.push({
      name: propName,
      city: a.city || '',
      revenue: a.total_revenue || 0,
      payout: a.host_payout || 0,
      nights: a.booked_nights || 0,
      occ: occ,
      adr: a.avg_nightly_rate || 0,
      expected: scaledExp,
      fullExpected: fullExp,
      pct: pct,
      hasActuals: true,
      expSource: exp ? exp.source : '',
    });
    totalRev += a.total_revenue || 0;
    totalNights += a.booked_nights || 0;
    totalPayout += a.host_payout || 0;
  });

  // Properties with no actuals this month — still show them
  var propsWithActuals = new Set(monthActuals.map(function(a) { return String(a.property_id); }));
  props.forEach(function(p) {
    if (!propsWithActuals.has(String(p.id))) {
      var propName = (p.unit_number ? p.unit_number + ' — ' : '') + (p.name || p.address || 'Property ' + p.id);
      var exp = finExpectations[p.id + '_' + month];
      var fullExp = exp ? exp.expected : (p.monthly_cost ? Math.round(p.monthly_cost * 1.15) : 0);
      var scaledExp = (isCurrent && fullExp > 0) ? Math.round(fullExp * daysElapsed / daysInMonth) : fullExp;
      rows.push({
        name: propName,
        city: p.city || '',
        revenue: 0,
        payout: 0,
        nights: 0,
        occ: 0,
        adr: 0,
        expected: scaledExp,
        fullExpected: fullExp,
        pct: 0,
        hasActuals: false,
        expSource: exp ? exp.source : 'cost floor',
      });
    }
  });

  // Sort: highest revenue first, then zeros
  rows.sort(function(a, b) { return b.revenue - a.revenue; });

  // Build modal HTML
  var overallPct = rows.reduce(function(s, r) { return s + r.expected; }, 0);
  var overallPctVal = overallPct > 0 ? Math.round(totalRev / overallPct * 100) : 0;
  var sc = overallPctVal >= 95 ? 'var(--accent)' : overallPctVal >= 75 ? '#f59e0b' : 'var(--danger)';

  var h = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">';
  h += '<div>';
  h += '<div style="font-size:1.1rem;font-weight:700;">' + _ico('calendar', 13) + ' ' + mLabel + (isCurrent ? ' <span style="font-size:0.7rem;color:#f59e0b;font-weight:400;">day ' + daysElapsed + '/' + daysInMonth + ' (in progress)</span>' : '') + '</div>';
  h += '<div style="font-size:0.75rem;color:var(--text3);margin-top:3px;">Click a property to open it</div>';
  h += '</div>';
  h += '<div style="text-align:right;">';
  h += '<div style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:var(--accent);">$' + Math.round(totalRev).toLocaleString() + '</div>';
  h += '<div style="font-size:0.68rem;color:var(--text3);">' + totalNights + ' nights booked · $' + Math.round(totalPayout).toLocaleString() + ' payout</div>';
  h += '<div style="font-size:0.72rem;font-weight:600;color:' + sc + ';">' + overallPctVal + '% of ' + (isCurrent ? 'scaled ' : '') + 'target</div>';
  h += '</div></div>';

  // Table header
  h += '<div style="display:grid;grid-template-columns:1fr 60px 70px 55px 60px 80px;gap:0;font-size:0.65rem;color:var(--text3);font-weight:600;padding:4px 8px;border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:0.04em;">';
  h += '<div>Property</div><div style="text-align:right;">Revenue</div><div style="text-align:right;">Expected</div><div style="text-align:right;">vs exp</div><div style="text-align:right;">Nights</div><div style="text-align:right;">ADR / Occ</div>';
  h += '</div>';

  rows.forEach(function(r) {
    var diff = r.revenue - r.expected;
    var c = r.pct === null ? 'var(--text3)' : r.pct >= 100 ? 'var(--accent)' : r.pct >= 75 ? '#f59e0b' : 'var(--danger)';
    var icon = !r.hasActuals ? '⬜' : r.pct >= 110 ? _ico('trendUp',13,'var(--accent)') : r.pct >= 100 ? '' + _ico('check', 13, 'var(--accent)') + '' : r.pct >= 75 ? '' + _ico('alertCircle', 13, '#f59e0b') + '' : '' + _ico('alertCircle', 13, 'var(--danger)') + '';
    h += '<div style="display:grid;grid-template-columns:1fr 60px 70px 55px 60px 80px;gap:0;padding:7px 8px;border-bottom:1px solid rgba(255,255,255,0.04);cursor:pointer;transition:background 0.1s;" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'\'">';
    h += '<div style="min-width:0;"><div style="font-size:0.75rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + icon + ' ' + esc(r.name) + '</div>';
    if (r.city) h += '<div style="font-size:0.6rem;color:var(--text3);">' + esc(r.city) + (r.expSource ? ' · ' + esc(r.expSource) : '') + '</div>';
    h += '</div>';
    h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.75rem;font-weight:600;color:' + (r.revenue > 0 ? 'var(--accent)' : 'var(--text3)') + ';">$' + Math.round(r.revenue).toLocaleString() + '</div>';
    h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.72rem;color:var(--text3);">' + (r.expected > 0 ? '$' + Math.round(r.expected).toLocaleString() : '—') + '</div>';
    h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.72rem;font-weight:600;color:' + c + ';">' + (r.pct !== null ? (diff >= 0 ? '+' : '') + '$' + Math.abs(Math.round(diff)).toLocaleString() : '—') + '</div>';
    h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.72rem;color:var(--text2);">' + (r.nights > 0 ? r.nights + 'n' : '—') + '</div>';
    h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.72rem;color:var(--text2);">' + (r.adr > 0 ? '$' + Math.round(r.adr) + ' · ' + r.occ + '%' : '—') + '</div>';
    h += '</div>';
  });

  // Summary row
  h += '<div style="display:grid;grid-template-columns:1fr 60px 70px 55px 60px 80px;gap:0;padding:8px 8px;background:var(--surface2);border-radius:0 0 6px 6px;font-weight:700;">';
  h += '<div style="font-size:0.72rem;">Total (' + rows.length + ' properties)</div>';
  h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.75rem;color:var(--accent);">$' + Math.round(totalRev).toLocaleString() + '</div>';
  h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.72rem;color:var(--text3);">$' + Math.round(overallPct).toLocaleString() + '</div>';
  var totalDiff = totalRev - overallPct;
  h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.72rem;color:' + sc + ';">' + (totalDiff >= 0 ? '+' : '') + '$' + Math.abs(Math.round(totalDiff)).toLocaleString() + '</div>';
  h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.72rem;color:var(--text2);">' + totalNights + 'n</div>';
  h += '<div></div>';
  h += '</div>';

  document.getElementById('genericModalTitle').textContent = mLabel + ' Breakdown';
  document.getElementById('genericModalBody').innerHTML = h;
  document.getElementById('genericModal').style.display = 'flex';
}

// ── MANAGED PROPERTIES FINANCE ───────────────────────────────────────────

// ── MANAGED PROPERTIES FINANCE ───────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// MANAGEMENT VIEW — managed properties for other owners
// ═══════════════════════════════════════════════════════════════════════════

var mgmtData = null;
var mgmtPeriod = 'all';

async function loadManagement() {
  var el = document.getElementById('managementContent');
  if (!el) return;
  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);">Loading managed properties...</div>';
  try {
    var d = await api('/api/finances/summary');
    mgmtData = d.managed;
    if (!mgmtData || mgmtData.count === 0) {
      el.innerHTML = '<div style="padding:30px;text-align:center;">' +
        '<div style="font-size:1.5rem;margin-bottom:8px;">' + _ico('handshake', 13) + '</div>' +
        '<div style="color:var(--text3);font-size:0.88rem;margin-bottom:6px;">No managed properties yet.</div>' +
        '<div style="color:var(--text3);font-size:0.78rem;">To manage a property for another owner, create a property and set ownership to <strong>Managed for Owner</strong>.</div>' +
        '</div>';
      return;
    }
    renderManagement();
  } catch (err) {
    el.innerHTML = '<p style="color:var(--danger);">Error: ' + esc(err.message) + '</p>';
  }
}

function setMgmtPeriod(mode) {
  mgmtPeriod = mode;
  document.querySelectorAll('.mgmt-period').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-period') === mode);
  });
  renderManagement();
}

function renderManagement() {
  var el = document.getElementById('managementContent');
  if (!el || !mgmtData) return;
  var managed = mgmtData;

  var range = getFinDateRange(mgmtPeriod);
  var periodLabel = mgmtPeriod === 'thismonth' ? 'This Month' : mgmtPeriod === 'lastmonth' ? 'Last Month' : mgmtPeriod === 'ytd' ? 'Year to Date' : mgmtPeriod === 'thisyear' ? 'This Year' : mgmtPeriod === 'lastyear' ? 'Last Year' : mgmtPeriod === 'all' ? 'All Time' : 'Custom';

  // Recalculate from monthly_breakdown filtered by period
  var totalGross = 0, totalExpenses = 0, totalFee = 0, totalOwnerPayout = 0;
  var byOwner = {};
  var filteredProps = [];

  managed.properties.forEach(function(p) {
    // Use full_calendar which includes zero-revenue months
    var calendar = (p.full_calendar || p.monthly_breakdown || []).filter(function(m) { return m.month >= range.from && m.month <= range.to; });
    var monthCount = calendar.length;
    var gross = 0, periodExpenses = 0, periodFees = 0;
    calendar.forEach(function(m) {
      gross += (m.total_revenue || 0);
      periodExpenses += (m.expenses || 0);
      periodFees += (m.total_fee || 0);
    });
    // If no full_calendar, fall back to old calculation
    if (!p.full_calendar) {
      periodExpenses = monthCount > 0 ? (p.expenses || 0) * monthCount : 0;
      var feeBase = p.fee_basis === 'net_profit' ? Math.max(0, gross - periodExpenses) : gross;
      periodFees = Math.round(feeBase * p.fee_pct / 100) + (p.base_fee || 0) * monthCount;
    }
    var ownerPayout = Math.round(gross - periodExpenses - periodFees);
    var lastBalance = calendar.length > 0 ? (calendar[calendar.length - 1].running_balance || 0) : 0;

    totalGross += gross;
    totalExpenses += periodExpenses;
    totalFee += periodFees;
    totalOwnerPayout += ownerPayout;

    var ownerName = p.owner_name || 'Unknown Owner';
    if (!byOwner[ownerName]) byOwner[ownerName] = { owner: ownerName, properties: [], totalGross: 0, totalExpenses: 0, totalFee: 0, totalPayout: 0 };
    byOwner[ownerName].properties.push(p.name || p.address);
    byOwner[ownerName].totalGross += gross;
    byOwner[ownerName].totalExpenses += periodExpenses;
    byOwner[ownerName].totalFee += periodFees;
    byOwner[ownerName].totalPayout += ownerPayout;

    filteredProps.push({
      id: p.id, name: p.name, unit_number: p.unit_number, owner_name: ownerName,
      fee_pct: p.fee_pct, fee_basis: p.fee_basis, base_fee: p.base_fee || 0,
      gross: Math.round(gross), expenses: Math.round(periodExpenses),
      net_profit: Math.round(Math.max(0, gross - periodExpenses)),
      fee: periodFees, owner_payout: ownerPayout,
      months: calendar, month_count: monthCount,
      running_balance: lastBalance,
      reservations: (p.reservations || []).filter(function(r) { return r.check_in >= range.from && r.check_in <= range.to + '-31'; }),
      fee_pct_val: p.fee_pct, fee_basis_val: p.fee_basis
    });
  });

  var totalNetProfit = Math.max(0, totalGross - totalExpenses);
  var h = '';

  // Period filter
  h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;align-items:center;">';
  h += '<span style="font-size:0.75rem;color:var(--text3);font-weight:600;">Period:</span>';
  ['ytd','thismonth','lastmonth','thisyear','lastyear','all'].forEach(function(p) {
    var labels = {ytd:'YTD',thismonth:'This Month',lastmonth:'Last Month',thisyear:'This Year',lastyear:'Last Year',all:'All Time'};
    h += '<button class="btn btn-xs mgmt-period' + (mgmtPeriod === p ? ' active' : '') + '" data-period="' + p + '" onclick="setMgmtPeriod(\'' + p + '\')">' + labels[p] + '</button>';
  });
  h += '<span style="font-size:0.72rem;color:var(--text3);margin-left:auto;">' + periodLabel + ': ' + range.from + ' \u2192 ' + range.to + '</span>';
  h += '</div>';

  // Summary cards
  h += '<div class="market-grid" style="margin-bottom:16px;">';
  h += '<div class="market-stat"><div class="val">' + managed.count + '</div><div class="lbl">Managed Properties</div></div>';
  h += '<div class="market-stat"><div class="val" style="color:var(--text2);">$' + Math.round(totalGross).toLocaleString() + '</div><div class="lbl">Gross Revenue</div></div>';
  h += '<div class="market-stat"><div class="val" style="color:var(--danger);">-$' + Math.round(totalExpenses).toLocaleString() + '</div><div class="lbl">Expenses</div></div>';
  h += '<div class="market-stat"><div class="val">$' + Math.round(totalNetProfit).toLocaleString() + '</div><div class="lbl">Net Profit</div></div>';
  h += '<div class="market-stat"><div class="val" style="color:var(--accent);font-weight:800;">$' + Math.round(totalFee).toLocaleString() + '</div><div class="lbl">Your Fee Income</div></div>';
  h += '<div class="market-stat"><div class="val" style="color:#60a5fa;">$' + Math.round(totalOwnerPayout).toLocaleString() + '</div><div class="lbl">Owner Keeps</div></div>';
  h += '</div>';

  if (totalGross === 0 && mgmtPeriod !== 'all') {
    h += '<div style="padding:12px;text-align:center;color:var(--text3);font-size:0.82rem;background:var(--bg);border-radius:8px;margin-bottom:14px;">No managed property revenue in this period. Try <a href="#" onclick="event.preventDefault();setMgmtPeriod(\'all\')" style="color:var(--accent);">All Time</a> or <a href="#" onclick="event.preventDefault();setMgmtPeriod(\'lastyear\')" style="color:var(--accent);">Last Year</a>.</div>';
  }

  h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:14px;padding:6px 10px;background:var(--bg);border-radius:6px;">Revenue \u2212 expenses = net profit \u2192 fee % applied \u2192 remainder to owner.</div>';

  // Per-owner statement cards
  var ownerList = Object.values(byOwner).filter(function(o) { return o.totalGross > 0 || mgmtPeriod === 'all'; });
  if (ownerList.length > 0) {
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">';
    h += '<div style="font-size:0.78rem;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:0.04em;">Owner Statements \u2014 ' + periodLabel + '</div>';
    h += '<button class="btn btn-xs" style="font-size:0.68rem;" onclick="exportAllOwnerStatements()"><span style="margin-right:4px;">' + _ico('fileText', 13) + '</span>Export All PDFs</button>';
    h += '</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;margin-bottom:18px;">';
    ownerList.forEach(function(o) {
      h += '<div style="padding:14px 18px;background:var(--surface);border:1px solid var(--border);border-left:4px solid #60a5fa;border-radius:10px;">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
      h += '<span style="font-weight:700;font-size:0.92rem;color:var(--text);">\uD83D\uDC64 ' + esc(o.owner) + '</span>';
      h += '<span style="font-size:0.7rem;color:var(--text3);">' + o.properties.length + ' propert' + (o.properties.length === 1 ? 'y' : 'ies') + '</span>';
      h += '</div>';
      h += '<div style="font-size:0.8rem;font-family:DM Mono,monospace;">';
      h += '<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--text3);">Gross Revenue</span><span>$' + Math.round(o.totalGross).toLocaleString() + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--danger);"><span>\u2212 Expenses</span><span>-$' + Math.round(o.totalExpenses).toLocaleString() + '</span></div>';
      var oNet = o.totalGross - o.totalExpenses;
      h += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px dashed var(--border);margin-top:3px;padding-top:5px;"><span style="color:var(--text2);">= Net Profit</span><span style="font-weight:600;">$' + Math.round(oNet).toLocaleString() + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:3px 0;color:var(--accent);"><span>Your Fee</span><span style="font-weight:700;">$' + Math.round(o.totalFee).toLocaleString() + '</span></div>';
      h += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-top:1px solid var(--border);margin-top:3px;padding-top:5px;"><span style="color:#60a5fa;">\u2192 Owner Keeps</span><span style="font-weight:700;color:#60a5fa;">$' + Math.round(o.totalPayout).toLocaleString() + '</span></div>';
      h += '</div>';
      h += '<div style="margin-top:8px;font-size:0.7rem;color:var(--text3);">' + o.properties.map(function(p) { return esc(p); }).join(' \u00b7 ') + '</div>';
      h += '<button class="btn btn-xs" style="margin-top:8px;font-size:0.68rem;" onclick="exportOwnerStatementPDF(\'' + esc(o.owner).replace(/'/g, "\\'") + '\')"><span style="margin-right:4px;">' + _ico('fileText', 13) + '</span>Export PDF Statement</button>';
      h += '</div>';
    });
    h += '</div>';
  }

  // Property detail table
  if (filteredProps.length > 0) {
    h += '<div style="font-size:0.78rem;font-weight:700;color:var(--text2);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em;">Property Detail</div>';
    h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.78rem;"><thead><tr>';
    h += '<th>Property</th><th>Owner</th><th>Fee</th><th>Gross</th><th>Expenses</th><th>Net</th><th>Your Fee</th><th>Owner</th><th>Months</th>';
    h += '</tr></thead><tbody>';
    filteredProps.forEach(function(p) {
      var propLabel = (p.unit_number ? p.unit_number + ' \u2014 ' : '') + esc(p.name);
      h += '<tr onclick="openProperty(' + p.id + ')" style="cursor:pointer;">';
      h += '<td style="font-weight:600;">' + propLabel + '</td>';
      h += '<td>' + esc(p.owner_name) + '</td>';
      h += '<td>' + p.fee_pct + '% <span style="font-size:0.62rem;color:var(--text3);">' + (p.fee_basis === 'net_profit' ? 'net' : 'gross') + '</span></td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + p.gross.toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">-$' + p.expenses.toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + p.net_profit.toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:700;">$' + p.fee.toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:#60a5fa;">$' + p.owner_payout.toLocaleString() + '</td>';
      h += '<td style="font-size:0.7rem;color:var(--text3);">' + p.month_count + '</td>';
      h += '</tr>';
      if (p.months.length > 0) {
        h += '<tr><td colspan="9" style="padding:0;">';
        h += '<div style="display:flex;gap:4px;flex-wrap:wrap;padding:5px 8px;background:var(--bg);font-size:0.68rem;">';
        p.months.forEach(function(m) {
          var mGross = Math.round(m.total_revenue || 0);
          var mFee = Math.round(m.total_fee || 0);
          var mOwnerNet = Math.round(m.owner_net || (mGross - (m.expenses || 0) - mFee));
          var mBal = Math.round(m.running_balance || 0);
          var noRevenue = mGross === 0;
          var chipBg = noRevenue ? 'rgba(239,92,92,0.1)' : 'var(--surface2)';
          var chipBorder = noRevenue ? '1px solid rgba(239,92,92,0.2)' : 'none';
          h += '<span style="padding:2px 8px;background:' + chipBg + ';border:' + chipBorder + ';border-radius:4px;" title="Revenue: $' + mGross.toLocaleString() + ' | Expenses: $' + Math.round(m.expenses || 0).toLocaleString() + ' | Fee: $' + mFee.toLocaleString() + (m.base_fee ? ' (incl $' + m.base_fee + ' base)' : '') + ' | Owner net: $' + mOwnerNet.toLocaleString() + ' | Balance: $' + mBal.toLocaleString() + '">';
          h += m.month + ': ';
          if (noRevenue) {
            h += '<span style="color:var(--danger);">$0 rev</span> → <span style="color:var(--danger);">-$' + Math.abs(mOwnerNet).toLocaleString() + '</span>';
          } else {
            h += '$' + mGross.toLocaleString() + ' → <span style="color:var(--accent);">$' + mFee.toLocaleString() + ' fee</span>';
          }
          if (mBal !== 0) h += ' <span style="color:' + (mBal >= 0 ? 'var(--accent)' : 'var(--danger)') + ';font-weight:600;">bal $' + mBal.toLocaleString() + '</span>';
          h += '</span>';
        });
        h += '</div></td></tr>';
      }
      // Reservation detail (expandable)
      if (p.reservations && p.reservations.length > 0) {
        var rid = 'mgmtRes_' + p.id;
        h += '<tr><td colspan="9" style="padding:0;">';
        h += '<div style="padding:4px 8px;background:var(--surface2);border-top:1px solid var(--border);">';
        h += '<a href="#" onclick="event.preventDefault();var el=document.getElementById(\'' + rid + '\');el.style.display=el.style.display===\'none\'?\'\':\'none\'" style="font-size:0.68rem;color:var(--accent);">' + _ico('receipt', 11, 'var(--accent)') + ' ' + p.reservations.length + ' reservations — click to expand</a>';
        h += '<div id="' + rid + '" style="display:none;margin-top:6px;overflow-x:auto;">';
        h += '<table class="comp-table" style="font-size:0.68rem;"><thead><tr><th>Guest</th><th>Check-in</th><th>Check-out</th><th>Nights</th><th>Channel</th><th>Revenue</th><th>Clean</th><th>Commission</th><th>Payout</th></tr></thead><tbody>';
        p.reservations.forEach(function(r) {
          h += '<tr>';
          h += '<td style="font-weight:600;">' + esc(r.guest_name || 'Guest') + '</td>';
          h += '<td>' + (r.check_in || '').substring(0, 10) + '</td>';
          h += '<td>' + (r.check_out || '').substring(0, 10) + '</td>';
          h += '<td style="text-align:center;">' + (r.nights_count || 0) + '</td>';
          h += '<td>' + esc(r.channel || '—') + '</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(r.accommodation_fare || 0).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(r.cleaning_fee || 0).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">-$' + Math.round(r.platform_fee || 0).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;color:#60a5fa;font-weight:600;">$' + Math.round(r.host_payout || 0).toLocaleString() + '</td>';
          h += '</tr>';
        });
        h += '</tbody></table></div></div></td></tr>';
      }
    });
    h += '</tbody></table></div>';
  }

  el.innerHTML = h;
}

// ─── Owner Statement PDF Export ─────────────────────────────────────────────
function exportOwnerStatementPDF(ownerName) {
  if (!mgmtData || !mgmtData.properties) return toast('No management data loaded', 'error');
  if (typeof window.jspdf === 'undefined') return toast('PDF library not loaded. Please refresh.', 'error');

  var range = getFinDateRange(mgmtPeriod);
  var periodLabel = mgmtPeriod === 'thismonth' ? 'This Month' : mgmtPeriod === 'lastmonth' ? 'Last Month' : mgmtPeriod === 'ytd' ? 'Year to Date' : mgmtPeriod === 'thisyear' ? 'This Year' : mgmtPeriod === 'lastyear' ? 'Last Year' : mgmtPeriod === 'all' ? 'All Time' : 'Custom';

  // Filter properties for this owner
  var ownerProps = mgmtData.properties.filter(function(p) {
    return (p.owner_name || 'Unknown Owner') === ownerName;
  });
  if (ownerProps.length === 0) return toast('No properties found for ' + ownerName, 'error');

  // Calculate period-filtered financials per property
  var propRows = [];
  var totalGross = 0, totalExpenses = 0, totalFee = 0, totalOwnerPayout = 0;

  ownerProps.forEach(function(p) {
    var months = (p.monthly_breakdown || []).filter(function(m) { return m.month >= range.from && m.month <= range.to; });
    var monthCount = months.length;
    var gross = 0;
    months.forEach(function(m) { gross += (m.total_revenue || 0); });
    var expenses = monthCount > 0 ? (p.expenses || 0) * monthCount : 0;
    var feeBase = p.fee_basis === 'net_profit' ? Math.max(0, gross - expenses) : gross;
    var fee = Math.round(feeBase * p.fee_pct / 100);
    var ownerPayout = Math.round(gross - expenses - fee);

    totalGross += gross;
    totalExpenses += expenses;
    totalFee += fee;
    totalOwnerPayout += ownerPayout;

    propRows.push({
      name: p.name || p.address || 'Property',
      unit: p.unit_number || '',
      feePct: p.fee_pct,
      feeBasis: p.fee_basis || 'gross',
      gross: Math.round(gross),
      expenses: Math.round(expenses),
      netProfit: Math.round(Math.max(0, gross - expenses)),
      fee: fee,
      ownerPayout: ownerPayout,
      months: months,
      monthCount: monthCount,
      reservations: (p.reservations || []).filter(function(r) { return r.check_in >= range.from && r.check_in <= range.to + '-31'; })
    });
  });

  var totalNetProfit = Math.max(0, totalGross - totalExpenses);

  // Helper: format dollar value, handling negatives properly as -$X instead of $-X
  function fmtPdfDollar(val) { var v = Math.round(val); return v < 0 ? '-$' + Math.abs(v).toLocaleString() : '$' + v.toLocaleString(); }

  // ── Build PDF with jsPDF ──
  var doc = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'letter' });
  var pageW = doc.internal.pageSize.getWidth();
  var pageH = doc.internal.pageSize.getHeight();
  var marginL = 20;
  var marginR = 20;
  var contentW = pageW - marginL - marginR;
  var y = 20;

  // ── Header ──
  doc.setFillColor(15, 17, 23);
  doc.rect(0, 0, pageW, 42, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('OWNER STATEMENT', marginL, 18);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Full Circle Property Management', marginL, 26);
  doc.setFontSize(9);
  doc.text('Statement Period: ' + range.from + ' to ' + range.to + ' (' + periodLabel + ')', marginL, 33);
  doc.text('Generated: ' + new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), marginL, 38);
  y = 50;

  // ── Owner Info ──
  doc.setTextColor(40, 40, 40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Prepared for: ' + ownerName, marginL, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(ownerProps.length + ' managed propert' + (ownerProps.length === 1 ? 'y' : 'ies'), marginL, y);
  y += 10;

  // ── Summary Box ──
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(marginL, y, contentW, 36, 3, 3, 'F');
  doc.setDrawColor(200, 205, 215);
  doc.roundedRect(marginL, y, contentW, 36, 3, 3, 'S');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(60, 60, 60);
  doc.text('FINANCIAL SUMMARY', marginL + 6, y + 8);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  var col1 = marginL + 6;
  var col2 = marginL + contentW / 2 + 6;
  var sy = y + 15;

  doc.setTextColor(80, 80, 80);
  doc.text('Gross Revenue:', col1, sy);
  doc.setFont('helvetica', 'bold');
  doc.text('$' + Math.round(totalGross).toLocaleString(), col1 + 55, sy);
  doc.setFont('helvetica', 'normal');

  doc.text('Expenses:', col2, sy);
  doc.setTextColor(200, 50, 50);
  doc.setFont('helvetica', 'bold');
  doc.text('-$' + Math.round(totalExpenses).toLocaleString(), col2 + 55, sy);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  sy += 7;

  doc.text('Net Profit:', col1, sy);
  doc.setFont('helvetica', 'bold');
  doc.text('$' + Math.round(totalNetProfit).toLocaleString(), col1 + 55, sy);
  doc.setFont('helvetica', 'normal');

  doc.text('Management Fee:', col2, sy);
  doc.setTextColor(79, 70, 229);
  doc.setFont('helvetica', 'bold');
  doc.text('-$' + Math.round(totalFee).toLocaleString(), col2 + 55, sy);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(80, 80, 80);
  sy += 9;

  doc.setDrawColor(180, 185, 200);
  doc.line(col1, sy - 3, marginL + contentW - 6, sy - 3);

  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 64, 175);
  doc.text('Owner Payout:  ' + fmtPdfDollar(Math.round(totalOwnerPayout)), col1, sy + 3);

  y += 44;

  // ── Property Detail Table ──
  doc.setTextColor(40, 40, 40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('PROPERTY DETAIL', marginL, y);
  y += 4;

  var tableHead = [['Property', 'Fee %', 'Basis', 'Gross', 'Expenses', 'Net Profit', 'Mgmt Fee', 'Owner Payout']];
  var tableBody = propRows.map(function(p) {
    var label = p.unit ? p.unit + ' - ' + p.name : p.name;
    return [
      label.length > 28 ? label.substring(0, 26) + '..' : label,
      p.feePct + '%',
      p.feeBasis === 'net_profit' ? 'Net' : 'Gross',
      '$' + p.gross.toLocaleString(),
      '-$' + p.expenses.toLocaleString(),
      '$' + p.netProfit.toLocaleString(),
      '-$' + p.fee.toLocaleString(),
      fmtPdfDollar(p.ownerPayout)
    ];
  });
  // Totals row
  tableBody.push([
    'TOTAL', '', '',
    '$' + Math.round(totalGross).toLocaleString(),
    '-$' + Math.round(totalExpenses).toLocaleString(),
    '$' + Math.round(totalNetProfit).toLocaleString(),
    '-$' + Math.round(totalFee).toLocaleString(),
    fmtPdfDollar(Math.round(totalOwnerPayout))
  ]);

  doc.autoTable({
    startY: y,
    head: tableHead,
    body: tableBody,
    margin: { left: marginL, right: marginR },
    theme: 'grid',
    headStyles: { fillColor: [15, 17, 23], textColor: [255, 255, 255], fontSize: 7.5, fontStyle: 'bold', halign: 'center' },
    bodyStyles: { fontSize: 7.5, cellPadding: 2.5 },
    columnStyles: {
      0: { halign: 'left', cellWidth: 42 },
      1: { halign: 'center', cellWidth: 14 },
      2: { halign: 'center', cellWidth: 14 },
      3: { halign: 'right' },
      4: { halign: 'right', textColor: [200, 50, 50] },
      5: { halign: 'right' },
      6: { halign: 'right', textColor: [79, 70, 229] },
      7: { halign: 'right', textColor: [30, 64, 175], fontStyle: 'bold' },
    },
    didParseCell: function(data) {
      if (data.row.index === tableBody.length - 1) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = [240, 242, 246];
      }
    },
  });

  y = doc.lastAutoTable.finalY + 8;

  // ── Monthly Breakdown per property ──
  propRows.forEach(function(p) {
    if (p.months.length === 0) return;
    if (y > pageH - 50) { doc.addPage(); y = 20; }

    doc.setTextColor(40, 40, 40);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text((p.unit ? p.unit + ' - ' : '') + p.name + ' \u2014 Monthly Breakdown', marginL, y);
    y += 3;

    var mHead = [['Month', 'Revenue', 'Nights', 'Occupancy', 'ADR', 'Expenses', 'Fee (' + p.feePct + '% ' + (p.feeBasis === 'net_profit' ? 'net' : 'gross') + ')', 'Owner']];
    var mBody = p.months.map(function(m) {
      var mGross = Math.round(m.total_revenue || 0);
      var mExp = p.expenses > 0 && p.monthCount > 0 ? Math.round(p.expenses / p.monthCount) : 0;
      var mFeeBase = p.feeBasis === 'net_profit' ? Math.max(0, mGross - mExp) : mGross;
      var mFee = Math.round(mFeeBase * p.feePct / 100);
      var mOwner = mGross - mExp - mFee;
      return [
        m.month,
        '$' + mGross.toLocaleString(),
        String(m.booked_nights || 0),
        (m.occupancy_pct || 0) + '%',
        '$' + Math.round(m.avg_nightly_rate || 0),
        '-$' + mExp.toLocaleString(),
        '-$' + mFee.toLocaleString(),
        fmtPdfDollar(mOwner)
      ];
    });

    doc.autoTable({
      startY: y,
      head: mHead,
      body: mBody,
      margin: { left: marginL, right: marginR },
      theme: 'striped',
      headStyles: { fillColor: [60, 70, 90], textColor: [255, 255, 255], fontSize: 7, fontStyle: 'bold', halign: 'center' },
      bodyStyles: { fontSize: 7, cellPadding: 2 },
      columnStyles: {
        0: { halign: 'left' },
        1: { halign: 'right' },
        2: { halign: 'center' },
        3: { halign: 'center' },
        4: { halign: 'right' },
        5: { halign: 'right', textColor: [200, 50, 50] },
        6: { halign: 'right', textColor: [79, 70, 229] },
        7: { halign: 'right', textColor: [30, 64, 175], fontStyle: 'bold' },
      },
    });

    y = doc.lastAutoTable.finalY + 8;

    // Reservation detail for this property
    if (p.reservations && p.reservations.length > 0) {
      if (y > pageH - 40) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(80, 80, 80);
      doc.text('Reservation Detail (' + p.reservations.length + ' bookings)', marginL + 4, y);
      y += 3;

      var rHead = [['Guest', 'Check-in', 'Check-out', 'Nights', 'Channel', 'Revenue', 'Cleaning', 'Commission', 'Payout']];
      var rBody = p.reservations.map(function(r) {
        return [
          (r.guest_name || 'Guest').substring(0, 20),
          (r.check_in || '').substring(0, 10),
          (r.check_out || '').substring(0, 10),
          String(r.nights_count || 0),
          (r.channel || '—').substring(0, 12),
          '$' + Math.round(r.accommodation_fare || 0).toLocaleString(),
          '$' + Math.round(r.cleaning_fee || 0).toLocaleString(),
          '-$' + Math.round(r.platform_fee || 0).toLocaleString(),
          '$' + Math.round(r.host_payout || 0).toLocaleString()
        ];
      });

      doc.autoTable({
        startY: y,
        head: rHead,
        body: rBody,
        margin: { left: marginL + 4, right: marginR },
        theme: 'striped',
        headStyles: { fillColor: [90, 100, 120], textColor: [255, 255, 255], fontSize: 6.5, fontStyle: 'bold', halign: 'center' },
        bodyStyles: { fontSize: 6.5, cellPadding: 1.5 },
        columnStyles: {
          0: { halign: 'left', cellWidth: 28 },
          1: { halign: 'center', cellWidth: 20 },
          2: { halign: 'center', cellWidth: 20 },
          3: { halign: 'center', cellWidth: 12 },
          4: { halign: 'center', cellWidth: 18 },
          5: { halign: 'right' },
          6: { halign: 'right' },
          7: { halign: 'right', textColor: [200, 50, 50] },
          8: { halign: 'right', textColor: [30, 64, 175], fontStyle: 'bold' },
        },
      });
      y = doc.lastAutoTable.finalY + 6;
    }
  });

  // ── Fee Calculation Notes ──
  if (y > pageH - 40) { doc.addPage(); y = 20; }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  doc.text('FEE CALCULATION NOTES', marginL, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  propRows.forEach(function(p) {
    var note = (p.unit ? p.unit + ' - ' : '') + p.name + ': ' + p.feePct + '% of ' + (p.feeBasis === 'net_profit' ? 'net profit (revenue minus expenses)' : 'gross revenue');
    doc.text(note, marginL, y);
    y += 4;
  });

  y += 4;
  doc.setDrawColor(200, 205, 215);
  doc.line(marginL, y, pageW - marginR, y);
  y += 5;
  doc.setFontSize(7);
  doc.setTextColor(140, 140, 140);
  doc.text('This statement was generated by FCP-PMR on ' + new Date().toLocaleString() + '.', marginL, y);
  doc.text('All amounts in USD. Please review and contact your property manager with any questions.', marginL, y + 4);

  // ── Footer on each page ──
  var totalPages = doc.internal.getNumberOfPages();
  for (var i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(160, 160, 160);
    doc.text('Page ' + i + ' of ' + totalPages, pageW / 2, pageH - 8, { align: 'center' });
    doc.text('Full Circle Property Management', marginL, pageH - 8);
  }

  // ── Save ──
  var fname = 'Owner_Statement_' + ownerName.replace(/[^a-zA-Z0-9]/g, '_') + '_' + range.from + '_to_' + range.to + '.pdf';
  doc.save(fname);
  toast('PDF statement downloaded: ' + fname, 'success');
}

function exportAllOwnerStatements() {
  if (!mgmtData || !mgmtData.properties) return toast('No management data loaded', 'error');
  // Get unique owner names
  var owners = {};
  mgmtData.properties.forEach(function(p) {
    var name = p.owner_name || 'Unknown Owner';
    owners[name] = true;
  });
  var ownerList = Object.keys(owners);
  if (ownerList.length === 0) return toast('No owners found', 'error');
  ownerList.forEach(function(owner, idx) {
    setTimeout(function() { exportOwnerStatementPDF(owner); }, idx * 500);
  });
  toast('Generating ' + ownerList.length + ' PDF statement(s)...', 'info');
}