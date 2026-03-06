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
    btn.classList.toggle('active', btn.textContent.toLowerCase().replace(/\s/g, '') === mode);
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
  h += finStat('$' + fmtNum(p.monthly_cost), 'Monthly Expenses', 'var(--danger)');
  if (p.monthly_services > 0) h += finStat('$' + fmtNum(p.monthly_services), 'Incl. Services', 'var(--purple)');
  h += finStat(p.avg_cap_rate.toFixed(1) + '%', 'Cap Rate', p.avg_cap_rate >= 5 ? 'var(--accent)' : 'var(--text2)');
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
  h += '<span style="font-size:0.82rem;font-weight:600;color:var(--accent);">📅 ' + periodLabel + ': ' + range.from + ' to ' + range.to + '</span>';
  h += '<span style="font-size:0.68rem;color:var(--text3);">' + Object.keys(byProp).length + ' properties · ' + uniqueMonths + ' months · Guesty confirmed only</span></div>';

  // Top metrics — what hit the bank
  h += '<div class="market-grid" style="margin-bottom:10px;">';
  h += finStat('$' + fmtNum(totalPayout), '💰 In Your Bank', 'var(--accent)');
  h += finStat('$' + fmtNum(avgMonthlyPayout), 'Avg Monthly', 'var(--accent)');
  h += finStat(occ + '%', 'Occupancy', occ >= 50 ? 'var(--accent)' : occ >= 30 ? '#f59e0b' : 'var(--danger)');
  h += finStat('$' + adr, 'ADR');
  h += finStat(totalNights + '', 'Booked Nights');
  h += finStat(totalBookings + '', 'Bookings');
  h += '</div>';

  // Money flow breakdown
  h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;font-size:0.78rem;">';
  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">MONEY FLOW — What Came In</div>';

  function flowRow(label, amount, color, indent) {
    return '<div style="display:flex;justify-content:space-between;padding:2px ' + (indent ? '0 2px 16px' : '0') + ';' + (color ? 'color:' + color + ';' : '') + '"><span>' + label + '</span><span style="font-family:DM Mono,monospace;">' + (amount < 0 ? '-' : '') + '$' + Math.abs(Math.round(amount)).toLocaleString() + '</span></div>';
  }

  h += flowRow('Accommodation Revenue', totalRev);
  if (totalCleaning > 0) h += flowRow('+ Cleaning Fees Collected', totalCleaning);
  if (totalCommission > 0) h += flowRow('− Platform Commissions', -totalCommission, 'var(--danger)');
  if (totalTaxes > 0) {
    var airbnbTaxes = totalTaxes - totalTaxesYouOwe;
    if (airbnbTaxes > 0) h += flowRow('Taxes handled by Airbnb', airbnbTaxes, 'var(--text3)', true);
    if (totalTaxesYouOwe > 0) h += flowRow('Taxes you collected (must remit)', totalTaxesYouOwe, '#f59e0b', true);
  }
  h += '<div style="border-top:2px solid var(--border);margin:6px 0;"></div>';
  h += '<div style="display:flex;justify-content:space-between;font-weight:700;font-size:0.85rem;"><span style="color:var(--accent);">= Total Deposited to Bank</span><span style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(totalPayout).toLocaleString() + '</span></div>';
  h += '</div>';

  // Tax liability warning
  if (totalTaxesYouOwe > 0) {
    h += '<div style="padding:8px 12px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font-size:0.75rem;margin-bottom:8px;">';
    h += '<span style="color:#f59e0b;">⚠️ <strong>Tax liability:</strong> $' + Math.round(totalTaxesYouOwe).toLocaleString() + ' collected from Booking.com/VRBO/direct guests — you must remit this to your tax authority.</span>';
    h += '<br><span style="color:var(--text3);">Airbnb taxes ($' + Math.round(totalTaxes - totalTaxesYouOwe).toLocaleString() + ') are automatically remitted by the platform.</span>';
    h += '</div>';
  }

  el.innerHTML = h;
}

function renderFinProjections(p) {
  var el = document.getElementById('finProjections');
  if (!el || !p) return;
  var now = new Date();
  var monthsLeft = 12 - now.getMonth();

  var h = '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:8px;">🎯 STR revenue: PriceLabs forward rates × smart occupancy. LTR revenue: LTR strategy estimates. Inactive properties excluded from revenue. All figures are estimates, not guaranteed.</div>';
  h += '<table class="comp-table" style="font-size:0.82rem;"><thead><tr><th></th><th>This Month</th><th>This Year (est.)</th><th>Annual (12mo)</th></tr></thead><tbody>';
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
      var pct = expected > 0 ? Math.round(actual / expected * 100) : 0;
      var diff = actual - expected;
      var isCurrent = m === currentMonth;
      var mn = parseInt(m.substring(5));
      var mName = monthNames[mn] || m.substring(5);
      var bg = isCurrent ? 'rgba(245,158,11,0.1)' : pct >= 95 ? 'rgba(16,185,129,0.06)' : pct >= 75 ? 'rgba(245,158,11,0.06)' : 'rgba(239,68,68,0.06)';
      var tc = isCurrent ? '#f59e0b' : pct >= 95 ? 'var(--accent)' : pct >= 75 ? '#f59e0b' : 'var(--danger)';
      var border = isCurrent ? 'rgba(245,158,11,0.3)' : pct >= 95 ? 'rgba(16,185,129,0.2)' : pct >= 75 ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)';
      var icon = isCurrent ? '\ud83d\udcca' : pct >= 110 ? '\ud83d\ude80' : pct >= 95 ? '\u2705' : pct >= 75 ? '\u26a0\ufe0f' : '\u274c';
      totalActual += actual;
      totalExpected += expected;
      var srcTip = Object.keys(byMonth[m].sources).join(', ') || 'PriceLabs est';
      h += '<div style="flex:1;min-width:100px;padding:8px 6px;background:' + bg + ';border-radius:8px;text-align:center;border:1px solid ' + border + ';" title="Based on: ' + srcTip + '">';
      h += '<div style="font-size:0.75rem;color:var(--text2);font-weight:600;">' + mName + ' ' + m.substring(0, 4) + (isCurrent ? ' *' : '') + '</div>';
      h += '<div style="font-size:0.9rem;margin:3px 0;">' + icon + '</div>';
      h += '<div style="font-family:DM Mono,monospace;font-size:0.85rem;font-weight:700;color:' + tc + ';">$' + (actual / 1000).toFixed(1) + 'K</div>';
      h += '<div style="font-size:0.62rem;color:var(--text3);">expected $' + (expected / 1000).toFixed(1) + 'K</div>';
      h += '<div style="font-family:DM Mono,monospace;font-size:0.72rem;font-weight:600;color:' + tc + ';">' + (diff >= 0 ? '+' : '') + '$' + (Math.abs(diff) >= 1000 ? (diff / 1000).toFixed(1) + 'K' : diff.toLocaleString()) + '</div>';
      h += '</div>';
    });
    h += '</div>';
    var totalPct = totalExpected > 0 ? Math.round(totalActual / totalExpected * 100) : 0;
    var totalDiff = totalActual - totalExpected;
    var sc = totalPct >= 95 ? 'var(--accent)' : totalPct >= 75 ? '#f59e0b' : 'var(--danger)';
    var summaryIcon = totalPct >= 110 ? '\ud83d\ude80 Exceeding targets' : totalPct >= 95 ? '\u2705 On track' : totalPct >= 75 ? '\u26a0\ufe0f Slightly behind' : '\u274c Below target';
    h += '<div style="padding:10px 14px;background:var(--bg);border-radius:6px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    h += '<div><span style="font-size:0.88rem;font-weight:700;color:' + sc + ';">' + summaryIcon + '</span></div>';
    h += '<div style="text-align:right;">';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.88rem;"><span style="color:var(--accent);">$' + Math.round(totalActual).toLocaleString() + '</span> actual vs <span style="color:var(--text2);">$' + Math.round(totalExpected).toLocaleString() + '</span> expected</div>';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.85rem;font-weight:700;color:' + sc + ';">' + (totalDiff >= 0 ? '+' : '') + '$' + Math.round(totalDiff).toLocaleString() + ' (' + totalPct + '%)</div>';
    h += '</div></div></div>';
  }

  // Property Scoreboard — ALL non-research properties, not just ones with Guesty data
  var byProp = {};

  // Start with actuals data
  filtered.forEach(function(a) {
    var pk = a.property_id;
    if (!byProp[pk]) byProp[pk] = { id: pk, name: (a.unit_number ? a.unit_number + ' \u2014 ' : '') + (a.prop_name || a.address), actual: 0, expected: 0, months: 0, sources: [], hasActuals: true, monthlyCost: 0 };
    byProp[pk].actual += a.total_revenue || 0;
    byProp[pk].months++;
    var eKey = pk + '_' + a.month;
    var exp = finExpectations[eKey];
    if (exp) { byProp[pk].expected += exp.expected; if (byProp[pk].sources.indexOf(exp.source) < 0) byProp[pk].sources.push(exp.source); }
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
      byProp[pk] = { id: pk, name: label, actual: 0, expected: monthlyExp * rangeMonths, months: rangeMonths, sources: ['no bookings yet'], hasActuals: false, monthlyCost: mc };
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
      if (p.hasActuals) h += p.months + ' mo \u00b7 ~$' + avgExp.toLocaleString() + '/mo expected \u00b7 <em>' + p.sources.join(', ') + '</em>';
      else h += 'Costing $' + Math.round(p.monthlyCost || 0).toLocaleString() + '/mo \u00b7 needs $' + avgExp.toLocaleString() + '/mo revenue to cover costs';
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
      statusHtml = '<span style="color:var(--danger);font-weight:600;">⚠ Over limit</span>';
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
    h += '<tr><td style="font-weight:600;">' + esc(s.label || k) + '</td>';
    h += '<td style="font-family:DM Mono,monospace;">' + (s.calls != null ? s.calls : s.listings || 0) + '</td>';
    h += '<td style="font-size:0.78rem;">' + (s.free_limit ? s.free_limit + '/mo free' : s.listings ? '$1/listing' : '—') + '</td>';
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
      h += '<td style="font-weight:600;">☁️ ' + esc(s.label || item.k) + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">fixed</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">' + esc(s.note || '') + '</td>';
      h += '<td><span style="color:var(--accent);">✓ active</span></td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + cost.toFixed(2) + '</td></tr>';
    });
  }

  h += '</tbody></table>';
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
    cfh += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">☁️ CLOUDFLARE WORKERS USAGE</div>';

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
    cfh += '☁️ Workers Paid: 10M req/mo · D1: 25M reads/day, 50M writes/day, 5GB storage · $5/mo flat</div>';
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
      var icon = a.level === 'critical' ? '🔴' : a.level === 'warning' ? '🟡' : 'ℹ️';
      var tc = a.level === 'critical' ? 'var(--danger)' : a.level === 'warning' ? '#f59e0b' : 'var(--text2)';
      h += '<div style="padding:6px 10px;background:' + bg + ';border:1px solid ' + border + ';border-radius:6px;margin-bottom:4px;font-size:0.75rem;display:flex;align-items:center;gap:6px;">';
      h += '<span>' + icon + '</span><span style="color:' + tc + ';"><strong>' + esc(a.service) + ':</strong> ' + esc(a.msg) + '</span></div>';
    });
    // AI cost summary
    if (d.ai_summary && d.ai_summary.total_calls > 0) {
      h += '<div style="padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:6px;margin-top:8px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:4px;">🤖 AI COSTS THIS MONTH</div>';
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
    if (statusEl) statusEl.innerHTML = '🔍 Viewing as: <strong>' + esc(name) + '</strong> — all tabs show their data';
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
    var catIcons = {closing:'📋',renovation:'🔨',repair:'🔧',furniture:'🛋️',appliance:'⚡',legal:'📜',other:'📌'};
    var h = '<div class="card" style="margin-top:14px;">';
    h += '<h3 style="margin-bottom:10px;">💰 Capital Expenses</h3>';

    // Category breakdown
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:12px;">';
    d.by_category.forEach(function(c) {
      var icon = catIcons[c.category] || '📌';
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
