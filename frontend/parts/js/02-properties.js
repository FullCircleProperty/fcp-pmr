// Properties

// Centralized property display name: custom name > "Address - Unit#" > "Address"
function getPropertyLabel(p) {
  var base = p.name || p.address || 'Untitled';
  if (p.unit_number) return base + ' — Unit ' + p.unit_number;
  return base;
}

function toggleMortCalc() {}
function calcMortgage() {}
function calcMortgageFromAmt() {}

// Load linked loans for property form
async function loadPropLinkedLoans(propertyId) {
  var el = document.getElementById('propLinkedLoansBody');
  if (!el) return;
  if (!propertyId) { el.innerHTML = '<span style="color:var(--text3);">Save the property first, then add loans via the Loans tab.</span>'; return; }
  try {
    var d = await api('/api/loans');
    var linked = (d.loans || []).filter(function(l) { return String(l.property_id) === String(propertyId) && l.status === 'active'; });
    if (linked.length === 0) {
      el.innerHTML = '<span style="color:var(--text3);">No active loans linked.</span> <button class="btn btn-xs" onclick="switchView(\'private-loans\')" type="button">Add in Loans tab →</button>';
      return;
    }
    var h = '<div style="display:flex;flex-direction:column;gap:6px;">';
    var totalMo = 0;
    linked.forEach(function(l) {
      totalMo += l.monthly_payment || 0;
      h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);">';
      h += '<div><strong style="color:var(--accent);font-size:0.78rem;">' + esc(l.lender_name) + '</strong>';
      h += ' <span style="font-size:0.65rem;color:var(--text3);">' + (l.interest_rate || 0) + '% · ' + esc(l.payment_type || 'fixed') + '</span></div>';
      h += '<div style="text-align:right;font-family:DM Mono,monospace;font-size:0.78rem;"><div style="color:var(--text);">$' + (l.monthly_payment || 0).toLocaleString() + '/mo</div>';
      h += '<div style="font-size:0.65rem;color:var(--text3);">Bal: $' + (l.computed_balance || 0).toLocaleString() + '</div></div>';
      h += '</div>';
    });
    if (linked.length > 1) {
      h += '<div style="text-align:right;font-size:0.72rem;color:var(--text2);font-weight:600;">Total: $' + totalMo.toLocaleString() + '/mo</div>';
    }
    h += '</div>';
    el.innerHTML = h;
  } catch (e) { el.innerHTML = '<span style="color:var(--text3);">Could not load loans.</span>'; }
}

function applyPriceLabsToProperty() {
  var pl = window._plPropertyData;
  if (!pl) { toast('No PriceLabs data available', 'error'); return; }
  var applied = [];
  var sv = function(id, val) { var el = document.getElementById(id); if (el && val && (!el.value || el.value === '0' || el.value === '')) { el.value = val; return true; } return false; };

  if (pl.bedrooms && sv('f_beds', pl.bedrooms)) applied.push('Bedrooms → ' + pl.bedrooms);
  if (pl.cleaning_fees && sv('f_cleaning', pl.cleaning_fees)) applied.push('Cleaning fee → $' + pl.cleaning_fees);
  if (pl.projected_monthly && sv('f_value', Math.round(pl.projected_monthly * 12 / 0.08)))
    applied.push('Est. value → $' + Math.round(pl.projected_monthly * 12 / 0.08).toLocaleString() + ' (from $' + pl.projected_monthly.toLocaleString() + '/mo at 8% cap)');

  if (applied.length > 0) {
    toast('Applied: ' + applied.join(' | '));
    updateCostSummary();
  } else {
    toast('All property fields already have values. PriceLabs data shown above for reference.', 'info');
  }
}

function renderPropertyFinance(propId) {
  var el = document.getElementById('propFinanceContent');
  if (!el) return;
  var p = properties.find(function(x) { return x.id == propId; });
  if (!p) { el.innerHTML = '<p style="color:var(--text3);">Property not found.</p>'; return; }

  var h = '';

  // ── Actual revenue from Guesty (ground truth) ──
  var actualData = (window._actualRevenue || {})[p.id];
  var hasActuals = actualData && (actualData.monthly_avg > 0 || actualData.this_month_rev > 0);
  var actualMonthlyAvg = hasActuals ? (actualData.monthly_avg || 0) : 0;
  var actualADR = hasActuals ? (actualData.avg_adr || 0) : 0;
  var actualOcc = hasActuals ? (actualData.avg_occ || 0) : 0;
  var thisMonthRev = actualData ? (actualData.this_month_rev || 0) : 0;
  var thisMonthOcc = actualData ? (actualData.this_month_occ || 0) : 0;
  var lastMonthRev = actualData ? (actualData.last_month_rev || 0) : 0;

  // ── PriceLabs projection data ──
  var base = p.pl_base_price || 0;
  var rec = p.pl_rec_base || base;
  var min = p.pl_min_price || base;
  var max = p.pl_max_price || base;
  var cleaning = p.pl_cleaning || p.cleaning_fee || 0;

  // Blended ADR estimate for projections
  var blendedADR = 0;
  var adrSource = '';
  if (actualADR > 0) {
    blendedADR = actualADR;
    adrSource = 'Actual ADR from Guesty';
  } else if (base > 0 && max > 0) {
    var weekdayRate = base;
    var demandRate = rec > 0 ? rec : base;
    var weekendRate = Math.round(base * 1.2);
    var peakRate = Math.round((base + max) / 2);
    blendedADR = Math.round(weekdayRate * 0.4 + demandRate * 0.3 + weekendRate * 0.2 + peakRate * 0.1);
    adrSource = 'Blended from PriceLabs (projected)';
  } else if (p.analysis_nightly_rate > 0) {
    blendedADR = p.analysis_nightly_rate;
    adrSource = 'From pricing analysis (projected)';
  }

  // Occupancy — use actual if available
  var plFwdOcc = p.pl_occ_30d ? parseInt(p.pl_occ_30d) / 100 : 0;
  var plMktFwdOcc = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) / 100 : 0;
  var annualOcc = 0.50;
  var occSource = '';
  if (actualOcc > 0.05) {
    annualOcc = actualOcc;
    occSource = 'Actual from Guesty: ' + Math.round(actualOcc * 100) + '%';
  } else if (p.analysis_occ && p.analysis_occ > 0.2) {
    annualOcc = p.analysis_occ;
    occSource = 'From analysis: ' + Math.round(annualOcc * 100) + '% (projected)';
  } else if (plFwdOcc >= 0.50) {
    annualOcc = plFwdOcc;
    occSource = 'PriceLabs 30d forward: ' + Math.round(plFwdOcc * 100) + '% (projected)';
  } else if (plFwdOcc > 0 && plMktFwdOcc > 0 && plFwdOcc > plMktFwdOcc) {
    annualOcc = Math.max(0.55, Math.min(0.70, plFwdOcc * 3.5));
    occSource = 'Est. ' + Math.round(annualOcc * 100) + '% annual (projected)';
  } else if (plFwdOcc > 0) {
    annualOcc = Math.max(0.40, Math.min(0.60, plFwdOcc * 3));
    occSource = 'Est. ' + Math.round(annualOcc * 100) + '% annual (projected)';
  } else {
    occSource = 'Default estimate: 50% (no data)';
  }

  var occ30 = annualOcc;
  var mktOcc30 = plMktFwdOcc;

  // Revenue: use actual if available, otherwise project
  var useActualRev = hasActuals && actualMonthlyAvg > 0;
  var monthlyRev = useActualRev ? actualMonthlyAvg : 0;
  var revSource = '';

  // Projected revenue (always compute for comparison)
  var turnovers = Math.round(occ30 * 30 / 3);
  var monthlyBlendedRev = blendedADR > 0 ? Math.round(blendedADR * 30 * occ30) : 0;
  var monthlyCleanRev = cleaning > 0 ? Math.round(cleaning * turnovers) : 0;
  var projectedMonthlyRev = monthlyBlendedRev + monthlyCleanRev;

  if (useActualRev) {
    monthlyRev = actualMonthlyAvg;
    revSource = 'actual';
  } else {
    monthlyRev = projectedMonthlyRev;
    revSource = 'projected';
  }
  var totalMonthlyRev = monthlyRev;

  // Expenses
  var cleanerPay = p.cleaning_cost || 0; // what you pay the cleaner per turnover
  var mortgageOrRent = p.ownership_type === 'rental' ? (p.monthly_rent_cost || 0) : (p.monthly_mortgage || 0);
  var insurance = p.monthly_insurance || 0;
  var taxes = Math.round((p.annual_taxes || 0) / 12);
  var hoa = p.hoa_monthly || 0;
  var elec = p.expense_electric || 0, gas = p.expense_gas || 0, water = p.expense_water || 0;
  var internet = p.expense_internet || 0, trash = p.expense_trash || 0, other = p.expense_other || 0;
  var totalUtils = elec + gas + water + internet + trash + other;
  // Service subscriptions (dynamic from property_services table)
  var totalServices = getServicesCost();
  // Building ownership cost allocation for child units
  // Only mortgage, insurance, taxes, HOA — NOT utilities (those are unit-level)
  var bldOwnershipShare = 0;
  var bldOwnershipDetail = '';
  var bldSiblingCount = 0;
  if (p.parent_id) {
    var parent = properties.find(function(x) { return String(x.id) === String(p.parent_id); });
    if (parent) {
      bldSiblingCount = properties.filter(function(x) { return String(x.parent_id) === String(p.parent_id); }).length || 1;
      var parentMort = parent.monthly_mortgage || 0;
      var parentIns = parent.monthly_insurance || 0;
      var parentTax = Math.round((parent.annual_taxes || 0) / 12);
      var parentHoa = parent.hoa_monthly || 0;
      var parentOwnership = parentMort + parentIns + parentTax + parentHoa;
      bldOwnershipShare = Math.round(parentOwnership / bldSiblingCount);
      var details = [];
      if (parentMort > 0) details.push('mortgage $' + Math.round(parentMort / bldSiblingCount).toLocaleString());
      if (parentIns > 0) details.push('insurance $' + Math.round(parentIns / bldSiblingCount));
      if (parentTax > 0) details.push('taxes $' + Math.round(parentTax / bldSiblingCount));
      if (parentHoa > 0) details.push('HOA $' + Math.round(parentHoa / bldSiblingCount));
      bldOwnershipDetail = (parent.name || parent.address || 'Building') + ': $' + parentOwnership.toLocaleString() + '/mo ÷ ' + bldSiblingCount + ' units';
    }
  }
  // For child units with building allocation, ownership costs (mortgage/insurance/taxes/HOA)
  // come from the building — don't count them on the unit
  var isChildUnit = p.parent_id && bldOwnershipShare > 0;
  if (isChildUnit) { mortgageOrRent = 0; insurance = 0; taxes = 0; hoa = 0; }
  // Unit operating expenses (what it costs to run this unit)
  var totalOperatingExpense = mortgageOrRent + insurance + taxes + hoa + totalUtils + totalServices;
  var monthlyCleanCost = cleanerPay > 0 ? Math.round(cleanerPay * turnovers) : Math.round(monthlyCleanRev * 0.7);
  var cleaningProfit = monthlyCleanRev - monthlyCleanCost;
  var supplies = Math.round(totalMonthlyRev * 0.02);
  var totalVariableExpense = monthlyCleanCost + supplies;
  var totalUnitExpense = totalOperatingExpense + totalVariableExpense;
  var operatingProfit = totalMonthlyRev - totalUnitExpense;
  // True net after building share
  var totalExpense = totalUnitExpense + bldOwnershipShare;
  var monthlyNet = totalMonthlyRev - totalExpense;
  var annualNet = monthlyNet * 12;

  // ── Data source badges ──
  h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">';
  if (hasActuals) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(16,185,129,0.1);color:var(--accent);border:1px solid rgba(16,185,129,0.2);">' + _ico('database', 13) + ' Guesty actuals</span>';
  if (p.pl_base_price) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(167,139,250,0.1);color:var(--purple);border:1px solid rgba(167,139,250,0.2);">' + _ico('barChart', 13) + ' PriceLabs</span>';
  if (p.analysis_nightly_rate) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(59,130,246,0.1);color:var(--blue);border:1px solid rgba(59,130,246,0.2);">' + _ico('sparkle', 13) + ' Analysis</span>';
  if (!hasActuals && !p.pl_base_price && !p.analysis_nightly_rate) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(245,158,11,0.1);color:#f59e0b;border:1px solid rgba(245,158,11,0.2);">' + _ico('alertCircle', 13, '#f59e0b') + ' No data — run analysis, sync PriceLabs, or sync Guesty</span>';
  if (!hasActuals && (p.pl_base_price || p.analysis_nightly_rate)) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(245,158,11,0.1);color:#f59e0b;border:1px solid rgba(245,158,11,0.2);">' + _ico('alertTriangle', 13, '#f59e0b') + ' All numbers are projections — no booking data yet</span>';
  h += '</div>';

  // ── Key Metrics ──
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:16px;">';
  function fc(label, val, color, sub, src) {
    return '<div style="text-align:center;padding:10px 6px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">' +
      '<div style="font-size:0.62rem;color:var(--text3);">' + label + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:' + (color || 'var(--text)') + ';">' + val + '</div>' +
      (sub ? '<div style="font-size:0.58rem;color:var(--text3);">' + sub + '</div>' : '') +
      (src ? '<div style="font-size:0.65rem;color:' + (src.includes('PriceLabs') ? 'var(--purple)' : src.includes('Analysis') ? 'var(--accent)' : 'var(--text3)') + ';">' + src + '</div>' : '') +
      '</div>';
  }

  if (blendedADR > 0) h += fc(actualADR > 0 ? 'Actual ADR' : 'Est. ADR', '$' + blendedADR + '/nt', 'var(--accent)', base > 0 ? 'PL base $' + base : '', adrSource.includes('Actual') ? 'Guesty' : 'projected');
  else if (base > 0) h += fc('Base Rate', '$' + base + '/nt', 'var(--purple)', '', 'PriceLabs');
  h += fc(actualOcc > 0.05 ? 'Actual Occ' : 'Est. Occ', Math.round(occ30 * 100) + '%', occ30 >= 0.50 ? 'var(--accent)' : '#f59e0b', occSource.substring(0, 40), actualOcc > 0.05 ? 'Guesty' : 'projected');
  if (plFwdOcc > 0) h += fc('PL Forward 30d', Math.round(plFwdOcc * 100) + '%', plFwdOcc > plMktFwdOcc ? 'var(--accent)' : 'var(--danger)', plMktFwdOcc > 0 ? 'market ' + Math.round(plMktFwdOcc * 100) + '%' : '', 'booking pace');
  h += fc(useActualRev ? 'Avg Monthly Rev' : 'Proj Monthly Rev', '$' + totalMonthlyRev.toLocaleString(), 'var(--accent)', useActualRev ? 'from Guesty actuals' : 'projected', useActualRev ? 'actual' : 'estimate');
  if (useActualRev && projectedMonthlyRev > 0) {
    var vsProj = totalMonthlyRev - projectedMonthlyRev;
    h += fc('vs Projection', (vsProj >= 0 ? '+' : '') + '$' + vsProj.toLocaleString(), vsProj >= 0 ? 'var(--accent)' : 'var(--danger)', 'proj: $' + projectedMonthlyRev.toLocaleString(), vsProj >= 0 ? 'ahead' : 'behind');
  }
  h += fc('Monthly Expenses', '$' + totalExpense.toLocaleString(), 'var(--danger)', 'fixed + variable', '');
  h += fc('Monthly Net', (monthlyNet >= 0 ? '+' : '') + '$' + monthlyNet.toLocaleString(), monthlyNet >= 0 ? 'var(--accent)' : 'var(--danger)', '', '');
  h += fc('Annual Net', (annualNet >= 0 ? '+' : '') + '$' + annualNet.toLocaleString(), annualNet >= 0 ? 'var(--accent)' : 'var(--danger)', '', '');
  if (p.estimated_value && annualNet > 0) h += fc('Cap Rate', (Math.round(annualNet / p.estimated_value * 1000) / 10) + '%', annualNet / p.estimated_value > 0.05 ? 'var(--accent)' : '#f59e0b', '$' + p.estimated_value.toLocaleString() + ' value', '');
  var breakEvenOcc = totalExpense > 0 && blendedADR > 0 ? Math.round(totalExpense / (blendedADR * 30) * 100) : 0;
  if (breakEvenOcc > 0) h += fc('Breakeven Occ', breakEvenOcc + '%', breakEvenOcc < Math.round(occ30 * 100) ? 'var(--accent)' : 'var(--danger)', breakEvenOcc < Math.round(occ30 * 100) ? Math.round(occ30 * 100) - breakEvenOcc + '% buffer' : 'at risk', '');
  h += '</div>';

  // ── P&L Table ──
  h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
  h += '<div style="font-weight:600;font-size:0.85rem;margin-bottom:10px;">Monthly P&L Breakdown</div>';

  function plRow(label, monthly, annual, color, indent, source) {
    return '<div style="display:flex;justify-content:space-between;padding:3px 0;' + (indent ? 'padding-left:16px;' : '') + 'font-size:0.78rem;' + (color ? 'color:' + color + ';' : '') + '">' +
      '<span>' + label + (source ? ' <span style="font-size:0.6rem;color:var(--text3);">(' + source + ')</span>' : '') + '</span>' +
      '<span style="font-family:DM Mono,monospace;font-weight:' + (indent ? '400' : '600') + ';">' +
      '$' + Math.round(monthly).toLocaleString() + '/mo · $' + Math.round(annual).toLocaleString() + '/yr</span></div>';
  }

  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--accent);margin-bottom:4px;">REVENUE' + (useActualRev ? ' (actual from Guesty)' : ' (projected)') + '</div>';
  if (useActualRev) {
    h += plRow('Avg Monthly Revenue', totalMonthlyRev, totalMonthlyRev * 12, 'var(--accent)', true, actualData.months + ' months of data');
    if (thisMonthRev > 0) h += plRow('This Month', thisMonthRev, 0, 'var(--accent)', true, thisMonthOcc > 0 ? thisMonthOcc + '% occ' : '');
  } else {
    if (monthlyBlendedRev > 0) h += plRow('Nightly Revenue', monthlyBlendedRev, monthlyBlendedRev * 12, 'var(--accent)', true, '$' + blendedADR + ' ADR × ' + Math.round(occ30 * 30) + ' nights (est.)');
    if (monthlyCleanRev > 0) h += plRow('Cleaning Fee Revenue', monthlyCleanRev, monthlyCleanRev * 12, 'var(--accent)', true, '$' + cleaning + ' × ' + turnovers + ' turnovers (est.)');
  }
  h += '<div style="border-top:1px solid var(--border);margin:4px 0;"></div>';
  h += plRow('Total Revenue', totalMonthlyRev, totalMonthlyRev * 12, 'var(--accent)', false);

  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--danger);margin-top:10px;margin-bottom:4px;">FIXED EXPENSES</div>';
  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--danger);margin-top:10px;margin-bottom:4px;">UNIT OPERATING EXPENSES</div>';
  if (mortgageOrRent > 0) h += plRow(p.ownership_type === 'rental' ? 'Rent' : 'Mortgage', mortgageOrRent, mortgageOrRent * 12, '', true, 'set');
  if (insurance > 0) h += plRow('Insurance', insurance, insurance * 12, '', true, 'set');
  if (taxes > 0) h += plRow('Taxes', taxes, taxes * 12, '', true, '$' + (p.annual_taxes || 0).toLocaleString() + '/yr');
  if (hoa > 0) h += plRow('HOA', hoa, hoa * 12, '', true, 'set');
  if (totalUtils > 0) h += plRow('Utilities', totalUtils, totalUtils * 12, '', true, 'elec+gas+water+net+trash');
  if (totalServices > 0) {
    var svcDetail = propServices.map(function(s) { return s.name + ' $' + s.monthly_cost; }).join(' + ');
    h += plRow('Services', totalServices, Math.round(totalServices * 12), '', true, svcDetail);
  }
  h += plRow('Cleaning Cost', monthlyCleanCost, monthlyCleanCost * 12, '', true, cleanerPay > 0 ? '$' + cleanerPay + ' × ' + turnovers + ' turnovers' : 'est. 70% of fee');
  if (cleaningProfit !== 0) h += plRow('Cleaning Profit/Loss', cleaningProfit, cleaningProfit * 12, cleaningProfit > 0 ? 'var(--accent)' : 'var(--danger)', true, 'fee $' + cleaning + ' − cost $' + (cleanerPay || Math.round(cleaning * 0.7)));
  if (supplies > 0) h += plRow('Supplies & Consumables (~2%)', supplies, supplies * 12, '', true, 'toiletries, linens');

  h += '<div style="border-top:1px solid var(--border);margin:6px 0;"></div>';
  h += plRow('Unit Operating Expenses', totalUnitExpense, totalUnitExpense * 12, 'var(--danger)', false);

  // Operating profit line
  h += '<div style="border-top:2px solid var(--border);margin:8px 0;"></div>';
  var opColor = operatingProfit >= 0 ? 'var(--accent)' : 'var(--danger)';
  h += '<div style="display:flex;justify-content:space-between;font-size:0.85rem;font-weight:700;color:' + opColor + ';">';
  h += '<span>UNIT OPERATING PROFIT</span><span style="font-family:DM Mono,monospace;">' + (operatingProfit >= 0 ? '+' : '') + '$' + operatingProfit.toLocaleString() + '/mo · ' + (operatingProfit >= 0 ? '+' : '') + '$' + (operatingProfit * 12).toLocaleString() + '/yr</span></div>';

  // Building ownership share (only for child units)
  if (bldOwnershipShare > 0) {
    h += '<div style="margin-top:12px;padding:12px;background:rgba(245,158,11,0.04);border:1px solid rgba(245,158,11,0.15);border-radius:8px;">';
    h += '<div style="font-size:0.72rem;font-weight:600;color:#f59e0b;margin-bottom:6px;">' + _ico('building', 14, '#f59e0b') + ' BUILDING OWNERSHIP SHARE</div>';
    h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:6px;">' + esc(bldOwnershipDetail) + '</div>';
    h += plRow('This unit\'s share', bldOwnershipShare, bldOwnershipShare * 12, '#f59e0b', false, bldSiblingCount + ' units splitting ownership costs');
    h += '</div>';

    h += '<div style="border-top:3px solid ' + (monthlyNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';margin:10px 0;"></div>';
    var netColor = monthlyNet >= 0 ? 'var(--accent)' : 'var(--danger)';
    h += '<div style="display:flex;justify-content:space-between;font-size:0.92rem;font-weight:700;color:' + netColor + ';">';
    h += '<span>TRUE NET INCOME</span><span style="font-family:DM Mono,monospace;">' + (monthlyNet >= 0 ? '+' : '') + '$' + monthlyNet.toLocaleString() + '/mo · ' + (annualNet >= 0 ? '+' : '') + '$' + annualNet.toLocaleString() + '/yr</span></div>';
  } else {
    h += '<div style="border-top:3px solid ' + (monthlyNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';margin:10px 0;"></div>';
    var netColor = monthlyNet >= 0 ? 'var(--accent)' : 'var(--danger)';
    h += '<div style="display:flex;justify-content:space-between;font-size:0.92rem;font-weight:700;color:' + netColor + ';">';
    h += '<span>NET INCOME</span><span style="font-family:DM Mono,monospace;">' + (monthlyNet >= 0 ? '+' : '') + '$' + monthlyNet.toLocaleString() + '/mo · ' + (annualNet >= 0 ? '+' : '') + '$' + annualNet.toLocaleString() + '/yr</span></div>';
  }
  h += '</div>';

  // ── Capital Expenses & Investment Summary ──
  if (propExpenses && propExpenses.length > 0) {
    var catIcons2 = {closing:'' + _ico('clipboard', 13) + '',renovation:'' + _ico('tool', 13) + '',repair:_ico('tool',13),furniture:_ico('layers',15),appliance:'' + _ico('zap', 13) + '',legal:'' + _ico('receipt', 13) + '',other:_ico('target',13)};
    var totalCapital = 0;
    propExpenses.forEach(function(e) { totalCapital += e.amount || 0; });
    var allInCost = (p.purchase_price || 0) + totalCapital;

    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:8px;">' + _ico('dollarSign', 13) + ' CAPITAL INVESTMENT</div>';

    propExpenses.forEach(function(e) {
      var icon = catIcons2[e.category] || _ico('target',13);
      h += '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.82rem;">';
      h += '<span>' + icon + ' ' + esc(e.name) + ' <span style="color:var(--text3);font-size:0.68rem;">' + esc(e.category || '') + (e.date_incurred ? ' · ' + e.date_incurred : '') + '</span></span>';
      h += '<span style="font-family:DM Mono,monospace;">$' + (e.amount || 0).toLocaleString() + '</span></div>';
    });

    h += '<div style="border-top:1px solid var(--border);margin:6px 0;"></div>';
    h += '<div style="display:flex;justify-content:space-between;font-size:0.85rem;font-weight:600;">';
    h += '<span>Total Capital</span><span style="font-family:DM Mono,monospace;color:var(--purple);">$' + totalCapital.toLocaleString() + '</span></div>';

    if (p.purchase_price > 0) {
      h += '<div style="display:flex;justify-content:space-between;font-size:0.85rem;font-weight:600;margin-top:4px;">';
      h += '<span>All-In Cost</span><span style="font-family:DM Mono,monospace;">$' + allInCost.toLocaleString() + '</span></div>';
      h += '<div style="font-size:0.68rem;color:var(--text3);">Purchase $' + p.purchase_price.toLocaleString() + ' + Capital $' + totalCapital.toLocaleString() + '</div>';
    }

    if (monthlyNet > 0 && totalCapital > 0) {
      var paybackMonths = Math.ceil(totalCapital / monthlyNet);
      var cashOnCash = allInCost > 0 ? Math.round(annualNet / allInCost * 10000) / 100 : 0;
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-top:8px;">';
      h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Capital Payback</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:' + (paybackMonths <= 24 ? 'var(--accent)' : paybackMonths <= 48 ? '#f59e0b' : 'var(--danger)') + ';">' + paybackMonths + ' mo</div><div style="font-size:0.65rem;color:var(--text3);">~' + Math.round(paybackMonths / 12 * 10) / 10 + ' years</div></div>';
      if (cashOnCash !== 0) h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Cash-on-Cash ROI</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:' + (cashOnCash >= 8 ? 'var(--accent)' : cashOnCash >= 4 ? '#f59e0b' : 'var(--danger)') + ';">' + cashOnCash + '%</div></div>';
      h += '</div>';
    } else if (monthlyNet <= 0 && totalCapital > 0) {
      h += '<div style="font-size:0.78rem;color:var(--danger);margin-top:6px;">' + _ico('alertCircle', 13, '#f59e0b') + ' Currently not profitable — capital payback cannot be estimated.</div>';
    }
    h += '</div>';
  }

  // ── Equity Position (owned properties only) ──
  if (p.ownership_type !== 'rental' && p.purchase_price > 0) {
    var currentValue = p.zestimate || p.estimated_value || p.purchase_price;
    var appreciation = currentValue - p.purchase_price;
    var appreciationPct = Math.round(appreciation / p.purchase_price * 10000) / 100;
    // Estimate remaining loan balance
    var loanOrig = p.loan_amount || (p.purchase_price * (1 - (p.down_payment_pct || 20) / 100));
    var rate = (p.interest_rate || 7) / 100 / 12;
    var termMonths = (p.loan_term_years || 30) * 12;
    var monthsElapsed = 0;
    if (p.purchase_date) {
      var pd = new Date(p.purchase_date);
      if (!isNaN(pd)) monthsElapsed = Math.max(0, Math.round((Date.now() - pd.getTime()) / (30.44 * 86400000)));
    }
    var remainingBalance = loanOrig;
    if (rate > 0 && monthsElapsed > 0) {
      var payment = loanOrig * rate * Math.pow(1 + rate, termMonths) / (Math.pow(1 + rate, termMonths) - 1);
      remainingBalance = loanOrig * Math.pow(1 + rate, monthsElapsed) - payment * (Math.pow(1 + rate, monthsElapsed) - 1) / rate;
      remainingBalance = Math.max(0, Math.round(remainingBalance));
    }
    var equity = Math.round(currentValue - remainingBalance);
    var totalCapExp = 0;
    if (propExpenses && propExpenses.length > 0) propExpenses.forEach(function(e) { totalCapExp += e.amount || 0; });

    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--accent);margin-bottom:8px;">' + _ico('home', 13) + ' EQUITY POSITION</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:8px;">';

    function eqCard(label, val, color, sub) { return '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">' + label + '</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:' + (color || 'var(--text)') + ';">' + val + '</div>' + (sub ? '<div style="font-size:0.65rem;color:var(--text3);">' + sub + '</div>' : '') + '</div>'; }

    h += eqCard('Purchase Price', '$' + p.purchase_price.toLocaleString(), 'var(--text2)');
    h += eqCard('Current Value', '$' + currentValue.toLocaleString(), 'var(--accent)', p.zestimate ? ('Zestimate ' + (p.zestimate_date || '') + (p.zillow_url ? ' <a href="' + esc(p.zillow_url) + '" target="_blank" style="color:var(--accent);text-decoration:none;" onclick="event.stopPropagation()">↗</a>' : '')) : p.estimated_value ? 'manual est.' : '');
    h += eqCard('Appreciation', (appreciation >= 0 ? '+' : '') + '$' + appreciation.toLocaleString(), appreciation >= 0 ? 'var(--accent)' : 'var(--danger)', (appreciationPct >= 0 ? '+' : '') + appreciationPct + '%');
    h += eqCard('Loan Balance', '$' + remainingBalance.toLocaleString(), 'var(--text2)', monthsElapsed > 0 ? monthsElapsed + ' mo paid' : 'estimated');
    h += eqCard('Equity', '$' + equity.toLocaleString(), equity >= 0 ? 'var(--accent)' : 'var(--danger)', 'value − loan');
    if (totalCapExp > 0) h += eqCard('Total Invested', '$' + (p.purchase_price + totalCapExp).toLocaleString(), 'var(--purple)', 'purchase + capital');
    h += '</div>';

    if (p.zestimate && p.estimated_value && p.zestimate !== p.estimated_value) {
      h += '<div style="font-size:0.72rem;color:var(--text3);">Zestimate: $' + p.zestimate.toLocaleString() + ' · Your estimate: $' + p.estimated_value.toLocaleString() + ' · Diff: ' + (p.zestimate > p.estimated_value ? '+' : '') + '$' + (p.zestimate - p.estimated_value).toLocaleString() + '</div>';
    }
    h += '</div>';
  }

  // ── Actual Performance from Guesty ──
  var actuals = window._propMonthlyActuals || [];
  if (actuals.length > 0) {
    var totalActRev = 0, totalActNights = 0, totalActAvail = 0, totalActPayout = 0;
    actuals.forEach(function(a) { totalActRev += a.total_revenue || 0; totalActNights += a.booked_nights || 0; totalActAvail += a.available_nights || 30; totalActPayout += a.host_payout || 0; });
    var actOcc = totalActAvail > 0 ? Math.round(totalActNights / totalActAvail * 100) : 0;
    var actAdr = totalActNights > 0 ? Math.round(totalActRev / totalActNights) : 0;
    var actAvgMonthly = actuals.length > 0 ? Math.round(totalActRev / actuals.length) : 0;

    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--accent);margin-bottom:8px;">' + _ico('barChart', 13) + ' ACTUAL PERFORMANCE (Guesty · ' + actuals.length + ' months)</div>';

    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:10px;">';
    function actCard(l, v, c) { return '<div style="text-align:center;padding:6px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">' + l + '</div><div style="font-family:DM Mono,monospace;font-size:0.95rem;font-weight:700;color:' + (c || 'var(--text)') + ';">' + v + '</div></div>'; }
    h += actCard('Avg Monthly', '$' + actAvgMonthly.toLocaleString(), 'var(--accent)');
    h += actCard('Annual', '$' + Math.round(totalActRev).toLocaleString(), 'var(--accent)');
    h += actCard('Avg Occupancy', actOcc + '%', actOcc >= 50 ? 'var(--accent)' : '#f59e0b');
    h += actCard('Avg ADR', '$' + actAdr);
    h += actCard('Total Payout', '$' + Math.round(totalActPayout).toLocaleString());
    h += actCard('Booked Nights', totalActNights + '/' + totalActAvail);
    h += '</div>';

    // Actual vs Projected comparison
    if (totalMonthlyRev > 0) {
      var diff = actAvgMonthly - totalMonthlyRev;
      h += '<div style="font-size:0.78rem;padding:6px 10px;background:rgba(' + (diff >= 0 ? '16,185,129' : '239,68,68') + ',0.06);border-radius:6px;border:1px solid rgba(' + (diff >= 0 ? '16,185,129' : '239,68,68') + ',0.15);">';
      h += 'Actual $' + actAvgMonthly.toLocaleString() + '/mo vs Projected $' + Math.round(totalMonthlyRev).toLocaleString() + '/mo → ';
      h += '<strong style="color:' + (diff >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (diff >= 0 ? '+' : '') + '$' + diff.toLocaleString() + '/mo ' + (diff >= 0 ? '(beating projections)' : '(below projections)') + '</strong>';
      h += '</div>';
    }

    // Mini monthly chart (last 6 months)
    var recent = actuals.slice(-6);
    if (recent.length >= 2) {
      var maxRev = Math.max.apply(null, recent.map(function(a) { return a.total_revenue || 0; }));
      h += '<div style="display:flex;gap:4px;align-items:flex-end;height:60px;margin-top:10px;">';
      recent.forEach(function(a) {
        var pct = maxRev > 0 ? Math.round((a.total_revenue || 0) / maxRev * 100) : 0;
        var occ = Math.round((a.occupancy_pct || 0) * 100);
        h += '<div style="flex:1;text-align:center;"><div style="background:var(--accent);border-radius:3px 3px 0 0;height:' + Math.max(pct, 2) + '%;min-height:2px;" title="$' + Math.round(a.total_revenue || 0).toLocaleString() + ' · ' + occ + '% occ"></div>';
        h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:2px;">' + (a.month || '').substring(5) + '</div></div>';
      });
      h += '</div>';
    }
    h += '</div>';
  }

  // ── Seasonality Pattern ──
  var seasonality = window._propSeasonality || [];
  if (seasonality.length >= 6) {
    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:8px;">' + _ico('calendar', 13) + ' SEASONALITY (' + esc(p.city) + ', ' + esc(p.state) + ')</div>';
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    h += '<div style="display:flex;gap:2px;align-items:flex-end;height:80px;margin-bottom:6px;">';
    var maxMult = Math.max.apply(null, seasonality.map(function(s) { return s.multiplier || 1; }));
    seasonality.forEach(function(s) {
      var pct = maxMult > 0 ? Math.round((s.multiplier || 1) / maxMult * 100) : 50;
      var color = (s.multiplier || 1) >= 1.1 ? 'var(--accent)' : (s.multiplier || 1) <= 0.8 ? 'var(--danger)' : '#f59e0b';
      h += '<div style="flex:1;text-align:center;">';
      h += '<div style="font-size:0.65rem;color:var(--text3);">' + (s.multiplier ? s.multiplier.toFixed(1) + 'x' : '') + '</div>';
      h += '<div style="background:' + color + ';border-radius:3px 3px 0 0;height:' + Math.max(pct, 5) + '%;min-height:3px;opacity:0.7;" title="' + monthNames[(s.month_number || 1) - 1] + ': ' + (s.avg_adr ? '$' + Math.round(s.avg_adr) + ' ADR' : '') + ' · ' + (s.avg_occupancy ? Math.round(s.avg_occupancy * 100) + '% occ' : '') + '"></div>';
      h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:2px;">' + monthNames[(s.month_number || 1) - 1] + '</div></div>';
    });
    h += '</div>';
    h += '<div style="font-size:0.68rem;color:var(--text3);">Bar height = rate multiplier vs annual avg. Green = peak season, Red = low season. Based on ' + (seasonality[0].sample_size || 0) + ' property-months of data.</div>';
    h += '</div>';
  }

  // ── ADR Methodology Note ──
  if (adrSource) {
    h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;font-size:0.72rem;color:var(--text3);">';
    h += '<strong>ADR Calculation:</strong> ' + esc(adrSource);
    h += '<br>Base rate alone underestimates revenue — PriceLabs dynamically adjusts rates for weekends, events, and demand. This blended rate approximates actual average daily revenue.';
    h += '<br><br><strong>Occupancy:</strong> ' + esc(occSource);
    if (plFwdOcc > 0 && plFwdOcc < 0.40) {
      h += '<br>PriceLabs shows ' + Math.round(plFwdOcc * 100) + '% for the next 30 days — this is <strong>booking pace</strong>, not annual occupancy. Most bookings come within 1-2 weeks of check-in, so forward-looking numbers are always lower than actual realized occupancy. We use an estimated annual average for projections.';
    }
    h += '</div>';
  }

  // ── 12-Month Revenue Target Grid ──
  var targets = buildMonthlyTargets(p, actuals, seasonality, totalOperatingExpense, blendedADR, annualOcc);
  if (targets && targets.length > 0) {
    var meta = targets._meta || {};
    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:#f59e0b;margin-bottom:6px;">' + _ico('target', 13) + ' 12-MONTH REVENUE TARGETS</div>';

    // Show what the targets are actually based on — transparent about data quality
    var basisColor = meta.targetBasis && meta.targetBasis.includes('cost floor') && !meta.targetBasis.includes('market') ? '#f59e0b' : 'var(--text3)';
    h += '<div style="font-size:0.68rem;color:' + basisColor + ';margin-bottom:6px;padding:6px 8px;background:var(--bg);border-radius:4px;border:1px solid var(--border);">';
    h += '' + _ico('target', 13) + ' <strong>Target basis:</strong> ' + esc(meta.targetBasis || 'cost coverage') + '<br>';
    if (meta.baseADR > 0) {
      h +='' + _ico('barChart', 13) + ' <strong>Rate source:</strong> ' + esc(meta.adrSource || 'pricing analysis') + ' ($' + meta.baseADR + '/nt base, scaled by season per month)<br>';
    } else {
      h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' <strong>No rate data yet</strong> — run Price Analysis or connect PriceLabs to get market-based targets. Required ADR column will be blank.<br>';
    }
    if (!meta.hasSeasonality) {
      h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' <strong>No seasonality data</strong> — import Guesty reservations to calibrate seasonal targets for ' + esc((p.city || '') + ', ' + (p.state || '')) + '.<br>';
    }
    if (!meta.hasActuals) {
      h += '' + _ico('info', 13, 'var(--blue)') + ' Occupancy estimates based on ' + (meta.hasSeasonality ? 'market averages' : 'default 40%') + ' — will sharpen as Guesty data accumulates.';
    }
    h += '</div>';

    if (meta.marketEstimate > 0 && meta.costFloor > 0 && meta.marketEstimate < meta.costFloor) {
      h += '<div style="font-size:0.72rem;color:var(--danger);padding:6px 8px;background:rgba(239,68,68,0.06);border-radius:4px;border:1px solid rgba(239,68,68,0.2);margin-bottom:6px;">';
      h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' <strong>Market estimate ($' + Math.round(meta.marketEstimate / 12).toLocaleString() + '/mo) is below your expenses ($' + Math.round(meta.costFloor / 12 / 1.15).toLocaleString() + '/mo).</strong> Either pricing is too low, occupancy is overestimated, or this market may not cover costs at current rates. Run Price Analysis to get an updated rate recommendation.';
      h += '</div>';
    }

    var now2 = new Date();
    var currentMN = now2.getMonth() + 1;
    var currentYear2 = now2.getFullYear();
    var annualTarget = targets.reduce(function(s, t) { return s + t.target; }, 0);

    h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.72rem;"><thead><tr>';
    h += '<th>Month</th><th title="Revenue needed to cover expenses + 15% margin, weighted by seasonal demand">Target</th><th title="Expected occupancy for this month (actual history → market avg → default)">Exp Occ</th><th title="Nightly rate needed at expected occupancy to hit target">Req ADR</th><th title="Current estimated nightly rate (PriceLabs or analysis), scaled by season">Current</th><th title="Gap between what you\'re charging and what you need to charge">Gap</th><th>Actual</th><th>Status</th>';
    h += '</tr></thead><tbody>';

    targets.forEach(function(t) {
      var isCurrent = t.monthNum === currentMN;
      var isPast = (t.year < currentYear2) || (t.year === currentYear2 && t.monthNum < currentMN);
      var actualRev = t.actual || 0;
      var pct = t.target > 0 && actualRev > 0 ? Math.round(actualRev / t.target * 100) : 0;
      var statusIcon = !isPast && !isCurrent ? '—' : isCurrent ? '' + _ico('barChart', 13) + '' : pct >= 95 ? _ico('trendUp',13,'var(--accent)') : pct >= 80 ? _ico('check',13,'var(--accent)') : pct >= 60 ? '' + _ico('alertCircle', 13, '#f59e0b') + '' : _ico('x',13,'var(--danger)');
      var rowBg = isCurrent ? 'background:rgba(245,158,11,0.06);' : '';
      var gapColor = t.gap > 20 ? 'var(--danger)' : t.gap < -20 ? 'var(--accent)' : 'var(--text2)';
      var statusColor = pct >= 95 ? 'var(--accent)' : pct >= 80 ? 'var(--accent)' : pct >= 60 ? '#f59e0b' : 'var(--danger)';
      var occTip = t.occSource ? ' title="' + esc(t.occSource) + '"' : '';

      h += '<tr style="' + rowBg + '">';
      h += '<td style="font-weight:600;">' + t.monthName + (isCurrent ? ' *' : '') + (t.seasonMult !== 1.0 ? '<div style="font-size:0.65rem;color:var(--text3);">' + t.seasonMult.toFixed(2) + 'x</div>' : '') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:#f59e0b;">$' + Math.round(t.target).toLocaleString() + '</td>';
      h += '<td' + occTip + '>' + t.expectedOcc + '%<div style="font-size:0.65rem;color:var(--text3);">' + esc(t.occSource || '') + '</div></td>';
      h += '<td style="font-family:DM Mono,monospace;font-weight:600;">' + (t.requiredADR > 0 ? '$' + Math.round(t.requiredADR) : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (t.currentRate > 0 ? '$' + Math.round(t.currentRate) : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + gapColor + ';">' + (t.currentRate > 0 && t.requiredADR > 0 ? (t.gap > 0 ? '+$' + Math.round(t.gap) : '-$' + Math.abs(Math.round(t.gap))) : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;' + (actualRev > 0 ? 'color:var(--accent);' : '') + '">' + (actualRev > 0 ? '$' + Math.round(actualRev).toLocaleString() : (isPast || isCurrent ? '<span style="color:var(--text3);">$0</span>' : '—')) + '</td>';
      h += '<td>' + (actualRev > 0 ? '<span style="color:' + statusColor + ';">' + statusIcon + ' ' + pct + '%</span>' : statusIcon) + '</td>';
      h += '</tr>';
    });

    // Annual total row
    var totalActual = targets.reduce(function(s, t) { return s + (t.actual || 0); }, 0);
    h += '<tr style="background:rgba(245,158,11,0.08);font-weight:700;">';
    h += '<td style="color:#f59e0b;">Annual</td>';
    h += '<td style="font-family:DM Mono,monospace;color:#f59e0b;">$' + Math.round(annualTarget).toLocaleString() + '</td>';
    h += '<td></td><td></td><td></td><td></td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(totalActual).toLocaleString() + '</td>';
    h += '<td>' + (totalActual > 0 ? Math.round(totalActual / annualTarget * 100) + '%' : '') + '</td></tr>';
    h += '</tbody></table></div>';

    // Gap summary
    var monthsAbove = targets.filter(function(t) { return t.currentRate > 0 && t.requiredADR > 0 && t.gap <= 0; }).length;
    var monthsBelow = targets.filter(function(t) { return t.currentRate > 0 && t.requiredADR > 0 && t.gap > 0; }).length;
    if (monthsBelow > 0) {
      h += '<div style="font-size:0.72rem;color:var(--danger);margin-top:6px;">▲ ' + monthsBelow + ' month' + (monthsBelow > 1 ? 's' : '') + ' where current rate is below required ADR — raise prices or work to improve occupancy.</div>';
    }
    if (monthsAbove > 0) {
      h += '<div style="font-size:0.72rem;color:var(--accent);margin-top:2px;">✓ ' + monthsAbove + ' month' + (monthsAbove > 1 ? 's' : '') + ' where rate meets or exceeds target — focus on occupancy.</div>';
    }
    h += '<div style="font-size:0.62rem;color:var(--text3);margin-top:6px;">Targets update when you: run Price Analysis · import Guesty data · sync PriceLabs · or reopen this property.</div>';
    h += '</div>';

    // Store targets for AI prompts
    window._propTargets = targets;
  }

  // ── Comparison: Base vs Blended vs Analysis ──
  if (base > 0 && (blendedADR !== base || p.analysis_nightly_rate)) {
    h += '<div style="padding:12px 14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-weight:600;font-size:0.82rem;margin-bottom:8px;">Revenue Scenarios</div>';
    h += '<table class="comp-table" style="font-size:0.78rem;"><thead><tr><th>Scenario</th><th>Rate</th><th>Occ</th><th>Monthly</th><th>Annual</th><th>Source</th></tr></thead><tbody>';

    function scenRow(name, rate, occPct, source, highlight) {
      var mo = Math.round(rate * 30 * occPct / 100);
      var yr = mo * 12;
      return '<tr style="' + (highlight ? 'background:rgba(16,185,129,0.04);' : '') + '"><td style="font-weight:600;">' + name + '</td><td style="font-family:DM Mono,monospace;">$' + rate + '/nt</td><td>' + occPct + '%</td><td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">$' + mo.toLocaleString() + '</td><td style="font-family:DM Mono,monospace;">$' + yr.toLocaleString() + '</td><td style="font-size:0.68rem;color:var(--text3);">' + source + '</td></tr>';
    }

    h += scenRow('Base Only (conservative)', base, Math.round(occ30 * 100), 'PriceLabs base', false);
    if (blendedADR > 0 && blendedADR !== base) h += scenRow('Blended ADR (realistic)', blendedADR, Math.round(occ30 * 100), 'Weighted avg', true);
    if (rec > 0 && rec !== base) h += scenRow('At Recommended Rate', rec, Math.round(occ30 * 100), 'PriceLabs rec', false);
    if (p.analysis_nightly_rate && p.analysis_nightly_rate > 0) {
      var analOcc = p.analysis_occ ? Math.round(p.analysis_occ * 100) : Math.round(occ30 * 100);
      h += scenRow('Analysis Projection', p.analysis_nightly_rate, analOcc, p.latest_strategy || 'Analysis', false);
    }
    h += '</tbody></table></div>';
  }

  // ── STR vs LTR Comparison ──
  // Show what this property would make as LTR vs STR
  var ltrMonthlyRent = p.est_monthly_revenue || 0; // from pricing_strategies LTR estimate
  // Try to get LTR from comps or market
  if (!ltrMonthlyRent && p.analysis_monthly) ltrMonthlyRent = 0; // we don't have LTR specific
  // Estimate LTR from market data if available — typically base nightly × 30 × 0.33 for LTR equivalent
  var ltrEstimate = base > 0 ? Math.round(base * 30 * 0.33) : 0; // LTR = ~33% of STR daily rate × 30
  if (ltrEstimate < 800 && p.estimated_value) ltrEstimate = Math.round(p.estimated_value * 0.007); // 0.7% rule of thumb

  if (totalMonthlyRev > 0 || ltrEstimate > 0) {
    var strNet = monthlyNet;
    var ltrExpense = totalOperatingExpense; // LTR has no variable STR costs (platform fees, cleaning, supplies)
    var ltrNet = ltrEstimate - ltrExpense;
    var strAdvantage = strNet - ltrNet;

    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-weight:600;font-size:0.85rem;margin-bottom:12px;">' + _ico('barChart', 13) + ' STR vs LTR Comparison</div>';
    h += '<table class="comp-table" style="font-size:0.82rem;"><thead><tr><th></th><th style="color:var(--accent);">Short-Term (STR)</th><th style="color:var(--blue);">Long-Term (LTR)</th><th>Difference</th></tr></thead><tbody>';

    function cmpRow(label, strVal, ltrVal, note) {
      var diff = strVal - ltrVal;
      var dc = diff > 0 ? 'var(--accent)' : diff < 0 ? 'var(--danger)' : 'var(--text3)';
      return '<tr><td style="font-weight:600;">' + label + (note ? ' <span style="font-size:0.62rem;color:var(--text3);">(' + note + ')</span>' : '') + '</td>' +
        '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">$' + Math.round(strVal).toLocaleString() + '</td>' +
        '<td style="font-family:DM Mono,monospace;color:var(--blue);">$' + Math.round(ltrVal).toLocaleString() + '</td>' +
        '<td style="font-family:DM Mono,monospace;color:' + dc + ';font-weight:600;">' + (diff > 0 ? '+' : '') + '$' + Math.round(diff).toLocaleString() + '</td></tr>';
    }

    h += cmpRow('Monthly Revenue', totalMonthlyRev, ltrEstimate, 'est.');
    h += cmpRow('Monthly Expenses', totalExpense, ltrExpense, 'STR has variable costs');
    h += '<tr style="border-top:2px solid var(--border);"><td style="font-weight:700;">Monthly Net</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (strNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';font-weight:700;">' + (strNet >= 0 ? '+' : '') + '$' + Math.round(strNet).toLocaleString() + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (ltrNet >= 0 ? 'var(--blue)' : 'var(--danger)') + ';font-weight:700;">' + (ltrNet >= 0 ? '+' : '') + '$' + Math.round(ltrNet).toLocaleString() + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (strAdvantage > 0 ? 'var(--accent)' : 'var(--danger)') + ';font-weight:700;">' + (strAdvantage > 0 ? '+' : '') + '$' + Math.round(strAdvantage).toLocaleString() + '</td></tr>';

    h += '<tr style="border-top:1px solid var(--border);"><td style="font-weight:700;">Annual Net</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (strNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (strNet >= 0 ? '+' : '') + '$' + Math.round(strNet * 12).toLocaleString() + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (ltrNet >= 0 ? 'var(--blue)' : 'var(--danger)') + ';">' + (ltrNet >= 0 ? '+' : '') + '$' + Math.round(ltrNet * 12).toLocaleString() + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:' + (strAdvantage > 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (strAdvantage > 0 ? '+' : '') + '$' + Math.round(strAdvantage * 12).toLocaleString() + '</td></tr>';
    h += '</tbody></table>';

    h += '<div style="margin-top:8px;font-size:0.72rem;color:var(--text3);">';
    if (strAdvantage > 200) h += '' + _ico('check', 13, 'var(--accent)') + ' STR is earning <strong style="color:var(--accent);">+$' + Math.round(strAdvantage).toLocaleString() + '/mo more</strong> than LTR would. STR is the right call.';
    else if (strAdvantage > 0) h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' STR is only <strong>+$' + Math.round(strAdvantage).toLocaleString() + '/mo</strong> more than LTR. Factor in management time and effort.';
    else h += '' + _ico('x', 13, 'var(--danger)') + ' LTR would earn <strong style="color:var(--danger);">$' + Math.abs(Math.round(strAdvantage)).toLocaleString() + '/mo more</strong> with less work. Consider switching to long-term.';
    h += '<br>LTR estimate: ~$' + ltrEstimate.toLocaleString() + '/mo' + (ltrEstimate === Math.round((p.estimated_value || 0) * 0.007) ? ' (0.7% value rule)' : ' (33% of STR daily rate)') + '. LTR has no platform fees, cleaning costs, or supplies.';
    h += '</div></div>';
  }

  // Performance trend placeholder
  h += '<div id="perfTrendChart" style="margin-top:14px;"></div>';

  el.innerHTML = h;

  // Load performance history async
  loadPerformanceTrend(propId);
}

async function loadPerformanceTrend(propId) {
  var el = document.getElementById('perfTrendChart');
  if (!el) return;
  try {
    var d = await api('/api/properties/' + propId + '/performance');
    var snaps = (d.snapshots || []).reverse(); // oldest first
    if (snaps.length < 2) {
      el.innerHTML = '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);font-size:0.78rem;color:var(--text3);">' + _ico('trendUp', 13) + ' Performance tracking started. Sync PriceLabs regularly to build history — trends will appear here after 2+ data points.</div>';
      return;
    }

    var h = '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
    h += '<div style="font-weight:600;font-size:0.85rem;margin-bottom:10px;">' + _ico('trendUp', 13) + ' Performance Trend (' + snaps.length + ' snapshots)</div>';

    // Summary: first vs latest
    var first = snaps[0], last = snaps[snaps.length - 1];
    var revChange = (last.est_monthly_revenue || 0) - (first.est_monthly_revenue || 0);
    var netChange = (last.est_monthly_net || 0) - (first.est_monthly_net || 0);
    var adrChange = (last.blended_adr || 0) - (first.blended_adr || 0);

    h += '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:12px;font-size:0.78rem;">';
    h += '<span>Since ' + first.snapshot_date + ': ';
    h += 'ADR <strong style="color:' + (adrChange >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (adrChange >= 0 ? '+' : '') + '$' + adrChange + '</strong> · ';
    h += 'Revenue <strong style="color:' + (revChange >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (revChange >= 0 ? '+' : '') + '$' + revChange.toLocaleString() + '/mo</strong> · ';
    h += 'Net <strong style="color:' + (netChange >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (netChange >= 0 ? '+' : '') + '$' + netChange.toLocaleString() + '/mo</strong>';
    h += '</span></div>';

    // Table of snapshots
    h += '<div style="max-height:250px;overflow-y:auto;">';
    h += '<table class="comp-table" style="font-size:0.75rem;"><thead><tr><th>Date</th><th>Base</th><th>Rec.</th><th>ADR</th><th>Fwd Occ</th><th>Mkt Occ</th><th>Est Rev</th><th>Est Exp</th><th>Est Net</th></tr></thead><tbody>';
    snaps.forEach(function(s, i) {
      var prevNet = i > 0 ? snaps[i - 1].est_monthly_net : null;
      var netTrend = prevNet !== null ? (s.est_monthly_net > prevNet ? '↑' : s.est_monthly_net < prevNet ? '↓' : '→') : '';
      var netColor = (s.est_monthly_net || 0) >= 0 ? 'var(--accent)' : 'var(--danger)';
      h += '<tr><td>' + s.snapshot_date + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + (s.base_price || 0) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + (s.recommended_price || 0) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;font-weight:600;">$' + (s.blended_adr || 0) + '</td>';
      h += '<td>' + (s.occupancy_30d || '—') + '</td>';
      h += '<td style="color:var(--text3);">' + (s.market_occ_30d || '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + (s.est_monthly_revenue || 0).toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--danger);">$' + (s.est_monthly_expenses || 0).toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + netColor + ';font-weight:600;">' + netTrend + ' $' + (s.est_monthly_net || 0).toLocaleString() + '</td></tr>';
    });
    h += '</tbody></table></div></div>';
    el.innerHTML = h;
  } catch {}
}

function renderRevenueSnapshot(propId) {
  var el = document.getElementById('pricingRevenueSnapshot');
  if (!el) return;
  var p = properties.find(function(x) { return x.id == propId; });
  if (!p) { el.innerHTML = ''; return; }

  var hasData = p.pl_base_price || p.analysis_nightly_rate || p.est_monthly_revenue;
  if (!hasData) {
    el.innerHTML = '<div style="padding:16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;text-align:center;">' +
      '<div style="font-size:0.88rem;color:var(--text2);margin-bottom:4px;">No pricing data yet</div>' +
      '<div style="font-size:0.78rem;color:var(--text3);">Run a Price Analysis, sync PriceLabs, or click Generate Strategy below to get started.</div></div>';
    return;
  }

  var h = '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;">';

  function snapCard(label, val, sub, color) {
    return '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;border:1px solid var(--border);">' +
      '<div style="font-size:0.62rem;color:var(--text3);margin-bottom:2px;">' + label + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:1.05rem;font-weight:700;color:' + (color || 'var(--text)') + ';">' + val + '</div>' +
      (sub ? '<div style="font-size:0.6rem;color:var(--text3);margin-top:1px;">' + sub + '</div>' : '') + '</div>';
  }

  // Current PriceLabs rate
  if (p.pl_base_price) {
    h += snapCard('PriceLabs Base', '$' + p.pl_base_price + '/nt', 'set rate', 'var(--purple)');
    if (p.pl_rec_base && !isNaN(p.pl_rec_base) && Number(p.pl_rec_base) > 0) {
      var rec = Math.round(Number(p.pl_rec_base));
      h += snapCard('PL Recommended', '$' + rec + '/nt', rec > p.pl_base_price ? '↑ raise $' + (rec - p.pl_base_price) : rec < p.pl_base_price ? '↓ lower $' + (p.pl_base_price - rec) : 'on target', rec > p.pl_base_price ? 'var(--accent)' : 'var(--purple)');
    }
  }

  // Occupancy
  if (p.pl_occ_30d) {
    var yourOcc = parseInt(p.pl_occ_30d);
    var mktOcc = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) : 0;
    h += snapCard('Your Occupancy', yourOcc + '%', mktOcc ? 'market: ' + mktOcc + '%' : '', yourOcc > mktOcc ? 'var(--accent)' : 'var(--danger)');
  }

  // Current projected revenue
  // Actual revenue from Guesty (ground truth)
  var actualData = (window._actualRevenue || {})[p.id];
  var actualMonthlyAvg = actualData && actualData.monthly_avg > 0 ? actualData.monthly_avg : 0;
  var thisMonthRev = actualData && actualData.this_month_rev > 0 ? actualData.this_month_rev : 0;

  var plRev = 0;
  if (p.pl_base_price && p.pl_occ_30d) {
    plRev = Math.round(p.pl_base_price * 30 * parseInt(p.pl_occ_30d) / 100);
  }

  // Show ACTUAL revenue first (from Guesty), then PriceLabs projection separately
  if (actualMonthlyAvg > 0) {
    h += snapCard('Actual Revenue', '$' + actualMonthlyAvg.toLocaleString() + '/mo', thisMonthRev > 0 ? 'this month: $' + thisMonthRev.toLocaleString() : 'from Guesty actuals', 'var(--accent)');
  }
  if (plRev > 0) {
    h += snapCard(actualMonthlyAvg > 0 ? 'PL Projection' : 'Projected Revenue', '$' + plRev.toLocaleString() + '/mo', '$' + p.pl_base_price + '/nt × ' + parseInt(p.pl_occ_30d) + '% occ', actualMonthlyAvg > 0 ? 'var(--text2)' : 'var(--purple)');
  }

  // Analysis projected
  if (p.analysis_monthly && p.analysis_monthly > 0) {
    var compareBase = actualMonthlyAvg > 0 ? actualMonthlyAvg : plRev;
    var compareLabel = actualMonthlyAvg > 0 ? 'actual' : 'PL projection';
    var diff = compareBase > 0 ? Math.round(p.analysis_monthly) - compareBase : 0;
    h += snapCard('Analysis Projects', '$' + Math.round(p.analysis_monthly).toLocaleString() + '/mo', p.analysis_nightly_rate ? '$' + p.analysis_nightly_rate + '/nt @ ' + Math.round((p.analysis_occ || 0.5) * 100) + '%' : '', 'var(--text2)');
    if (compareBase > 0 && Math.abs(diff) > 50) {
      var gapSub = 'vs ' + compareLabel;
      if (diff < 0 && p.analysis_nightly_rate && p.pl_base_price && p.analysis_nightly_rate < p.pl_base_price) {
        gapSub = 'analysis stale — re-run';
      }
      h += snapCard('Revenue Gap', (diff > 0 ? '+' : '') + '$' + diff.toLocaleString() + '/mo', gapSub, diff > 0 ? 'var(--accent)' : 'var(--warn)');
    }
  }

  // Monthly expenses
  var cost = 0;
  var isManagedProp = p.is_managed || p.ownership_type === 'managed';
  if (isManagedProp) {
    var feeBasisLabel = (p.fee_basis || 'gross') === 'net_profit' ? '% of net profit' : '% of gross';
    h += snapCard('Status', '' + _ico('handshake', 13) + ' Managed', p.owner_name || 'Owner', '#60a5fa');
    if (p.management_fee_pct) h += snapCard('Mgmt Fee', p.management_fee_pct + '%', feeBasisLabel, 'var(--accent)');
  } else {
    if (p.ownership_type === 'rental') cost = p.monthly_rent_cost || 0;
    else cost = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0);
    cost += (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);
  }
  if (!isManagedProp && cost > 0) {
    var useActualForNet = actualMonthlyAvg > 0;
    var displayRev = useActualForNet ? actualMonthlyAvg : (plRev || p.analysis_monthly || 0);
    var netRev = displayRev - cost;
    var netLabel = useActualForNet ? 'Net Income' : (displayRev > 0 ? 'Est. Net Income' : 'Net Income');
    var netSub = useActualForNet ? '$' + (Math.round(netRev) * 12).toLocaleString() + '/yr · from actuals' : (displayRev > 0 ? '$' + (Math.round(netRev) * 12).toLocaleString() + '/yr · projected' : 'no revenue data');
    h += snapCard('Expenses', '$' + Math.round(cost).toLocaleString() + '/mo', '', 'var(--danger)');
    h += snapCard(netLabel, (netRev >= 0 ? '+' : '') + '$' + Math.round(netRev).toLocaleString() + '/mo', netSub, netRev >= 0 ? 'var(--accent)' : 'var(--danger)');
  }

  h += '</div></div>';

  // Restrictions & AI Notes banner (if any set)
  if (p.rental_restrictions || p.hoa_name || p.ai_notes) {
    h += '<div style="margin-top:10px;padding:10px 14px;border-radius:8px;border:1px solid rgba(245,158,11,0.25);background:rgba(245,158,11,0.04);font-size:0.78rem;">';
    if (p.hoa_name) h += '<div style="margin-bottom:4px;"><span style="color:#f59e0b;font-weight:600;">' + _ico('home', 13) + ' HOA:</span> ' + esc(p.hoa_name) + '</div>';
    if (p.rental_restrictions) h += '<div style="margin-bottom:4px;"><span style="color:var(--danger);font-weight:600;">' + _ico('alertCircle', 13, '#f59e0b') + ' Restrictions:</span> ' + esc(p.rental_restrictions) + '</div>';
    if (p.ai_notes) h += '<div><span style="color:var(--purple);font-weight:600;">' + _ico('sparkle', 13) + ' AI Notes:</span> ' + esc(p.ai_notes) + '</div>';
    h += '</div>';
  }

  el.innerHTML = h;
}

async function generateRevenueOptimization() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var btn = document.getElementById('genOptBtn');
  var res = document.getElementById('revenueOptResults');
  if (btn) { btn.disabled = true; btn.innerHTML ='' + _ico('clock', 13) + ' Analyzing...'; }
  showLoading('AI analyzing revenue optimization opportunities...');
  try {
    var d = await api('/api/properties/' + editId + '/revenue-optimize', 'POST');
    renderRevenueOptimization(d, res);
    // Invalidate research cache so Listing Health section picks up new AI recommendations
    if (_researchCache[editId]) delete _researchCache[editId];
    toast('Optimization analysis complete');
  } catch (err) {
    if (res) res.innerHTML = '<div style="color:var(--danger);padding:10px;">' + esc(err.message) + '</div>';
    toast(err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.innerHTML ='' + _ico('trendUp', 13) + ' Optimize Revenue'; }
  hideLoading();
}

function renderRevenueOptimization(d, container) {
  if (!container || !d.optimization) return;
  var o = d.optimization;
  var h = '';

  // Revenue target banner
  h += '<div style="padding:16px;background:linear-gradient(135deg,rgba(16,185,129,0.08),rgba(167,139,250,0.08));border:1px solid rgba(16,185,129,0.2);border-radius:10px;margin-bottom:14px;">';
  h += '<div style="display:flex;justify-content:space-around;flex-wrap:wrap;gap:14px;text-align:center;">';
  h += '<div><div style="font-size:0.65rem;color:var(--text3);">Current Revenue</div><div style="font-family:DM Mono,monospace;font-size:1.3rem;font-weight:700;color:var(--text);">$' + (o.current_monthly_revenue || 0).toLocaleString() + '<span style="font-size:0.7rem;color:var(--text3);">/mo</span></div><div style="font-size:0.65rem;color:var(--text3);">' + (o.current_occupancy_pct || 0) + '% occupancy</div></div>';
  h += '<div style="font-size:1.5rem;color:var(--text3);align-self:center;">→</div>';
  h += '<div><div style="font-size:0.65rem;color:var(--accent);">Target Revenue</div><div style="font-family:DM Mono,monospace;font-size:1.3rem;font-weight:700;color:var(--accent);">$' + (o.target_monthly_revenue || 0).toLocaleString() + '<span style="font-size:0.7rem;color:var(--text3);">/mo</span></div><div style="font-size:0.65rem;color:var(--accent);">' + (o.target_occupancy_pct || 0) + '% occupancy</div></div>';
  h += '<div style="align-self:center;padding:8px 14px;background:var(--accent);color:var(--bg);border-radius:8px;font-weight:700;font-size:1rem;">+' + (o.revenue_increase_pct || 0) + '%</div>';
  h += '</div></div>';

  // Quick wins
  if (o.quick_wins && o.quick_wins.length > 0) {
    h += '<div style="padding:12px 14px;background:rgba(16,185,129,0.05);border:1px solid rgba(16,185,129,0.15);border-radius:8px;margin-bottom:12px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">' + _ico('zap', 13) + ' QUICK WINS (do today)</div>';
    o.quick_wins.forEach(function(w) { h += '<div style="font-size:0.78rem;margin:4px 0;">✓ ' + esc(w) + '</div>'; });
    h += '</div>';
  }

  // Occupancy improvements
  if (o.occupancy_improvements && o.occupancy_improvements.length > 0) {
    h += '<div style="padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:6px;">' + _ico('trendUp', 13) + ' INCREASE OCCUPANCY</div>';
    o.occupancy_improvements.sort(function(a,b) { return (a.priority || 99) - (b.priority || 99); });
    o.occupancy_improvements.forEach(function(item) {
      var effortColor = item.effort === 'low' ? 'var(--accent)' : item.effort === 'high' ? 'var(--danger)' : '#f59e0b';
      h += '<div style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:0.78rem;">';
      h += '<span style="flex-shrink:0;padding:1px 6px;border-radius:3px;font-size:0.65rem;font-weight:600;background:' + effortColor + ';color:var(--bg);">' + (item.effort || 'med').toUpperCase() + '</span>';
      h += '<div><strong>' + esc(item.action) + '</strong>';
      if (item.impact) h += '<div style="color:var(--accent);font-size:0.72rem;">' + esc(item.impact) + '</div>';
      h += '</div></div>';
    });
    h += '</div>';
  }

  // Revenue improvements
  if (o.revenue_improvements && o.revenue_improvements.length > 0) {
    h += '<div style="padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">' + _ico('dollarSign', 13) + ' INCREASE REVENUE</div>';
    o.revenue_improvements.sort(function(a,b) { return (a.priority || 99) - (b.priority || 99); });
    o.revenue_improvements.forEach(function(item) {
      var effortColor = item.effort === 'low' ? 'var(--accent)' : item.effort === 'high' ? 'var(--danger)' : '#f59e0b';
      h += '<div style="display:flex;gap:8px;align-items:flex-start;margin:6px 0;font-size:0.78rem;">';
      h += '<span style="flex-shrink:0;padding:1px 6px;border-radius:3px;font-size:0.65rem;font-weight:600;background:' + effortColor + ';color:var(--bg);">' + (item.effort || 'med').toUpperCase() + '</span>';
      h += '<div><strong>' + esc(item.action) + '</strong>';
      if (item.impact) h += '<div style="color:var(--accent);font-size:0.72rem;">' + esc(item.impact) + '</div>';
      h += '</div></div>';
    });
    h += '</div>';
  }

  // PriceLabs settings adjustments
  if (o.pricing_adjustments && o.pricing_adjustments.length > 0) {
    h += '<div style="padding:12px 14px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:12px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:6px;">' + _ico('settings', 13) + ' PRICELABS ADJUSTMENTS</div>';
    h += '<table class="comp-table" style="font-size:0.78rem;"><thead><tr><th>Setting</th><th>Current</th><th>Recommended</th><th>Why</th></tr></thead><tbody>';
    o.pricing_adjustments.forEach(function(adj) {
      h += '<tr><td style="font-weight:600;">' + esc(adj.setting) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--text3);">' + esc(String(adj.current)) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">' + esc(String(adj.recommended)) + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text2);">' + esc(adj.reason) + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  // Listing & guest experience
  var listingImprovements = (o.listing_improvements || []).concat(o.guest_experience_improvements || []);
  if (listingImprovements.length > 0) {
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">';
    if (o.listing_improvements && o.listing_improvements.length > 0) {
      h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);">' + _ico('edit', 13) + ' LISTING IMPROVEMENTS</div>';
      h += '<a href="#" onclick="event.preventDefault();switchPropTab(\'research\')" style="font-size:0.62rem;color:var(--purple);">' + _ico('sparkle', 10, 'var(--purple)') + ' Full Health Report →</a>';
      h += '</div>';
      o.listing_improvements.forEach(function(i) { h += '<div style="font-size:0.75rem;margin:3px 0;">• ' + esc(i) + '</div>'; });
      h += '</div>';
    }
    if (o.guest_experience_improvements && o.guest_experience_improvements.length > 0) {
      h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:4px;">' + _ico('home', 13) + ' GUEST EXPERIENCE</div>';
      o.guest_experience_improvements.forEach(function(i) { h += '<div style="font-size:0.75rem;margin:3px 0;">• ' + esc(i) + '</div>'; });
      h += '</div>';
    }
    h += '</div>';
  }

  // 90-day plan
  if (o.ninety_day_plan) {
    var planText = o.ninety_day_plan;
    // AI sometimes returns raw JSON in this field — detect and clean it
    if (planText.indexOf('{') === 0 || planText.indexOf('```') >= 0 || planText.indexOf('"current_monthly_revenue"') >= 0) {
      // This is a JSON blob, not a plan — try to extract ninety_day_plan from it
      try {
        var cleaned = planText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        if (cleaned.indexOf('{') === 0) {
          var parsed = JSON.parse(cleaned);
          if (parsed.ninety_day_plan && typeof parsed.ninety_day_plan === 'string') {
            planText = parsed.ninety_day_plan;
          } else {
            planText = null; // garbage — don't display
          }
        }
      } catch { planText = null; }
    }
    if (planText && planText.length > 10) {
      h += '<div style="padding:14px;background:linear-gradient(135deg,rgba(167,139,250,0.06),rgba(16,185,129,0.06));border:1px solid rgba(167,139,250,0.2);border-radius:8px;margin-bottom:12px;">';
      h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:6px;">' + _ico('target', 13) + ' 90-DAY PLAN</div>';
      h += '<div style="font-size:0.82rem;line-height:1.5;color:var(--text);">' + esc(planText) + '</div>';
      h += '</div>';
    }
  }

  h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:8px;">Generated by ' + esc(d.provider || 'AI') + ' · Read-only recommendations — no prices changed.</div>';
  container.innerHTML = h;
}

async function generateAcquisitionAnalysis() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var btn = document.getElementById('genAcqBtn');
  var res = document.getElementById('acquisitionResults');
  if (btn) { btn.disabled = true; btn.innerHTML ='' + _ico('clock', 13) + ' Analyzing...'; }
  showLoading('AI evaluating acquisition opportunity...');
  try {
    var body = {};
    // Always read considerations directly from textarea
    var consEl = document.getElementById('acqConsiderations');
    var cons = consEl ? consEl.value.trim() : (window._acqConsiderations || '');
    if (cons) body.considerations = cons;
    var d = await api('/api/properties/' + editId + '/acquisition-analysis', 'POST', body);
    renderAcquisitionAnalysis(d, res);
    toast('Acquisition analysis complete');
  } catch (err) {
    if (res) res.innerHTML = '<div style="color:var(--danger);padding:10px;">' + esc(err.message) + '</div>';
    toast(err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.innerHTML ='' + _ico('home', 13) + ' Update Analysis'; }
  hideLoading();
}

function renderAcquisitionAnalysis(d, container) {
  if (!container || !d.analysis) return;
  var a = d.analysis;
  var h = '';

  // Change button to "Update" since we have data
  var acqBtn = document.getElementById('genAcqBtn');
  if (acqBtn) acqBtn.innerHTML ='' + _ico('home', 13) + ' Update Analysis';

  // Verdict banner
  var vc = a.verdict === 'GO' ? 'var(--accent)' : a.verdict === 'NO-GO' ? 'var(--danger)' : '#f59e0b';
  var vBg = a.verdict === 'GO' ? 'rgba(16,185,129,0.08)' : a.verdict === 'NO-GO' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)';
  var vBdr = a.verdict === 'GO' ? 'rgba(16,185,129,0.3)' : a.verdict === 'NO-GO' ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)';
  var vIcon = a.verdict === 'GO' ? _ico('check',13,'var(--accent)') : a.verdict === 'NO-GO' ? _ico('x',13,'var(--danger)') : '' + _ico('alertCircle', 13, '#f59e0b') + '';
  h += '<div style="padding:18px;background:' + vBg + ';border:2px solid ' + vBdr + ';border-radius:10px;margin-bottom:14px;text-align:center;">';
  h += '<div style="font-size:2rem;">' + vIcon + '</div>';
  h += '<div style="font-size:1.3rem;font-weight:700;color:' + vc + ';margin:4px 0;">' + esc(a.verdict) + '</div>';
  h += '<div style="font-size:0.75rem;color:var(--text3);">Confidence: ' + esc(a.confidence || 'medium') + '</div>';
  h += '<div style="font-size:0.88rem;color:var(--text);margin-top:8px;line-height:1.6;">' + esc(a.summary || '') + '</div>';
  h += '</div>';

  // Considerations dialog
  h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
  h += '<strong style="font-size:0.82rem;">' + _ico('edit', 13) + ' Considerations for Next Update</strong>';
  h += '<button class="btn btn-xs" onclick="saveAcqConsiderations()">Save</button></div>';
  h += '<textarea id="acqConsiderations" placeholder="Add notes for AI to consider next time: e.g. \'property needs new roof ~$15K\', \'zoning allows ADU\', \'HOA restricts STR\', \'seller willing to negotiate\'..." style="width:100%;height:60px;font-size:0.78rem;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);resize:vertical;">' + esc(window._acqConsiderations || '') + '</textarea>';
  h += '</div>';

  // Financial projections grid
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-bottom:14px;">';
  function ac(l,v,c,s){return '<div style="text-align:center;padding:10px 6px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);"><div style="font-size:0.6rem;color:var(--text3);">'+l+'</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:'+(c||'var(--text)')+';">'+v+'</div>'+(s?'<div style="font-size:0.65rem;color:var(--text3);">'+s+'</div>':'')+'</div>';}
  h += ac('Nightly Rate', '$' + (a.projected_nightly_rate || '?'), 'var(--purple)');
  h += ac('Occupancy', (a.projected_occupancy_pct || '?') + '%', 'var(--accent)');
  h += ac('Monthly Rev', '$' + (a.projected_monthly_revenue || 0).toLocaleString(), 'var(--accent)');
  h += ac('Monthly Net', (a.projected_monthly_net >= 0 ? '+' : '') + '$' + (a.projected_monthly_net || 0).toLocaleString(), a.projected_monthly_net >= 0 ? 'var(--accent)' : 'var(--danger)');
  h += ac('Annual Net', (a.projected_annual_net >= 0 ? '+' : '') + '$' + (a.projected_annual_net || 0).toLocaleString(), a.projected_annual_net >= 0 ? 'var(--accent)' : 'var(--danger)');
  if (a.cap_rate_pct) h += ac('Cap Rate', a.cap_rate_pct + '%', a.cap_rate_pct >= 5 ? 'var(--accent)' : 'var(--danger)');
  if (a.cash_on_cash_return_pct) h += ac('Cash-on-Cash', a.cash_on_cash_return_pct + '%', a.cash_on_cash_return_pct >= 8 ? 'var(--accent)' : '#f59e0b');
  h += ac('Breakeven', (a.breakeven_occupancy_pct || '?') + '%', 'var(--text2)', 'min occ');
  if (a.setup_costs_estimate) h += ac('Setup Cost', '$' + a.setup_costs_estimate.toLocaleString(), 'var(--text2)');
  if (a.payback_period_months) h += ac('Payback', a.payback_period_months + ' mo', 'var(--text2)');
  h += '</div>';

  // SWOT grid
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">';
  [['Strengths', a.strengths, 'var(--accent)', _ico('trendUp',14)], ['Weaknesses', a.weaknesses, 'var(--danger)', '' + _ico('alertCircle', 13, '#f59e0b') + ''], ['Opportunities', a.opportunities, 'var(--purple)', '' + _ico('target', 13) + ''], ['Threats', a.threats, '#f59e0b', _ico('alertTriangle',14)]].forEach(function(sw) {
    if (!sw[1] || sw[1].length === 0) return;
    h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
    h += '<div style="font-size:0.75rem;font-weight:600;color:' + sw[2] + ';margin-bottom:6px;">' + sw[3] + ' ' + sw[0].toUpperCase() + '</div>';
    sw[1].forEach(function(s) { h += '<div style="font-size:0.82rem;color:var(--text);margin:4px 0;line-height:1.4;">• ' + esc(s) + '</div>'; });
    h += '</div>';
  });
  h += '</div>';

  // Upgrade recommendations
  if (a.upgrades && a.upgrades.length > 0) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:8px;">' + _ico('tool', 13) + ' RECOMMENDED UPGRADES</div>';
    h += '<table class="comp-table" style="font-size:0.8rem;"><thead><tr><th>Upgrade</th><th>Est. Cost</th><th>Monthly +</th><th>ROI</th><th>Why</th></tr></thead><tbody>';
    a.upgrades.forEach(function(u) {
      h += '<tr><td style="font-weight:600;">' + esc(u.name || '') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + (u.cost || 0).toLocaleString() + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">+$' + (u.monthly_increase || 0).toLocaleString() + '/mo</td>';
      h += '<td style="color:var(--purple);">' + esc(u.roi || '') + '</td>';
      h += '<td style="font-size:0.75rem;color:var(--text3);max-width:200px;">' + esc(u.description || '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  // Comparable properties (STR + LTR)
  if (a.str_comps && a.str_comps.length > 0) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--accent);margin-bottom:8px;">' + _ico('barChart', 13) + ' STR COMPARABLES</div>';
    h += '<table class="comp-table" style="font-size:0.78rem;"><thead><tr><th>Property</th><th>BR/BA</th><th>Rate</th><th>Occ</th><th>Revenue</th></tr></thead><tbody>';
    a.str_comps.forEach(function(c) {
      h += '<tr><td>' + esc(c.description || c.name || '') + '</td><td>' + (c.bedrooms || '?') + '/' + (c.bathrooms || '?') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + (c.nightly_rate || 0) + '/nt</td>';
      h += '<td>' + (c.occupancy || '?') + '%</td>';
      h += '<td style="font-family:DM Mono,monospace;">$' + (c.monthly_revenue || 0).toLocaleString() + '/mo</td></tr>';
    });
    h += '</tbody></table></div>';
  }
  if (a.ltr_comps && a.ltr_comps.length > 0) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--blue);margin-bottom:8px;">' + _ico('home', 13) + ' LTR COMPARABLES</div>';
    h += '<table class="comp-table" style="font-size:0.78rem;"><thead><tr><th>Property</th><th>BR/BA</th><th>Monthly Rent</th></tr></thead><tbody>';
    a.ltr_comps.forEach(function(c) {
      h += '<tr><td>' + esc(c.description || c.name || '') + '</td><td>' + (c.bedrooms || '?') + '/' + (c.bathrooms || '?') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--blue);">$' + (c.monthly_rent || 0).toLocaleString() + '/mo</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  // Sale comps — nearby properties for sale
  if (a.sale_comps && a.sale_comps.length > 0) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:#f59e0b;margin-bottom:8px;">' + _ico('tag', 13) + ' NEARBY PROPERTIES FOR SALE</div>';
    h += '<table class="comp-table" style="font-size:0.78rem;"><thead><tr><th>Property</th><th>BR/BA</th><th>Sqft</th><th>Price</th><th>Link</th></tr></thead><tbody>';
    a.sale_comps.forEach(function(c) {
      h += '<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(c.description || '') + '</td>';
      h += '<td>' + (c.bedrooms || '?') + '/' + (c.bathrooms || '?') + '</td>';
      h += '<td>' + (c.sqft ? c.sqft.toLocaleString() : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:#f59e0b;font-weight:600;">$' + (c.price || 0).toLocaleString() + '</td>';
      h += '<td>' + (c.listing_url ? '<a href="' + esc(c.listing_url) + '" target="_blank" style="color:var(--accent);font-size:0.72rem;">View →</a>' : '—') + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }
  if (a.str_projection || a.ltr_projection || a.midterm_projection) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">' + _ico('dollarSign', 13) + ' REVENUE PROJECTIONS BY STRATEGY</div>';
    h += '<table class="comp-table" style="font-size:0.82rem;"><thead><tr><th></th><th style="color:var(--accent);">Short-Term</th><th style="color:var(--blue);">Mid-Term</th><th style="color:var(--purple);">Long-Term</th></tr></thead><tbody>';
    var sp = a.str_projection || {}, mp = a.midterm_projection || {}, lp = a.ltr_projection || {};
    function pv(v, fmt) { if (!v) return '<span style="color:var(--text3);">—</span>'; return fmt === '$' ? '$' + Math.round(v).toLocaleString() : v + (fmt || ''); }
    h += '<tr><td style="font-weight:600;">Monthly Revenue</td><td style="font-family:DM Mono,monospace;color:var(--accent);">' + pv(sp.annual_gross ? Math.round(sp.annual_gross / 12) : a.projected_monthly_revenue, '$') + '</td><td style="font-family:DM Mono,monospace;color:var(--blue);">' + pv(mp.monthly_rate, '$') + '</td><td style="font-family:DM Mono,monospace;color:var(--purple);">' + pv(lp.monthly_rent, '$') + '</td></tr>';
    h += '<tr><td style="font-weight:600;">Annual Gross</td><td>' + pv(sp.annual_gross, '$') + '</td><td>' + pv(mp.annual_gross, '$') + '</td><td>' + pv(lp.annual_gross, '$') + '</td></tr>';
    h += '<tr><td style="font-weight:600;">Annual Net</td><td style="color:' + ((sp.annual_net || 0) >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + pv(sp.annual_net, '$') + '</td><td style="color:' + ((mp.annual_net || 0) >= 0 ? 'var(--blue)' : 'var(--danger)') + ';">' + pv(mp.annual_net, '$') + '</td><td style="color:' + ((lp.annual_net || 0) >= 0 ? 'var(--purple)' : 'var(--danger)') + ';">' + pv(lp.annual_net, '$') + '</td></tr>';
    if (sp.avg_nightly_rate) h += '<tr><td>Avg Rate</td><td>$' + sp.avg_nightly_rate + '/nt</td><td>' + (mp.target_stays || '—') + '</td><td>—</td></tr>';
    if (sp.peak_rate) h += '<tr><td>Peak / Low</td><td>$' + sp.peak_rate + ' / $' + (sp.low_rate || '?') + '</td><td>—</td><td>—</td></tr>';
    if (sp.annual_occupancy_pct) h += '<tr><td>Occupancy</td><td>' + sp.annual_occupancy_pct + '%</td><td>—</td><td>' + (lp.vacancy_rate_pct ? (100 - lp.vacancy_rate_pct) + '%' : '—') + '</td></tr>';
    if (sp.best_case_monthly) h += '<tr><td>Best / Worst Mo</td><td style="color:var(--accent);">$' + sp.best_case_monthly.toLocaleString() + ' / $' + (sp.worst_case_monthly || 0).toLocaleString() + '</td><td>—</td><td>—</td></tr>';
    if (sp.peak_season_months) h += '<tr><td>Peak Season</td><td colspan="3" style="font-size:0.78rem;">' + esc(sp.peak_season_months) + '</td></tr>';
    h += '</tbody></table></div>';
  }

  // ── Regulations ──
  if (a.regulations) {
    var reg = a.regulations;
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">' + _ico('receipt', 13) + ' LOCAL REGULATIONS</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:10px;">';
    var strOk = reg.str_allowed === true ? 'var(--accent)' : reg.str_allowed === false ? 'var(--danger)' : '#f59e0b';
    h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">STR Allowed</div><div style="font-weight:700;color:' + strOk + ';">' + (reg.str_allowed === true ? '' + _ico('check', 13, 'var(--accent)') + ' Yes' : reg.str_allowed === false ? '' + _ico('x', 13, 'var(--danger)') + ' No' : '' + _ico('helpCircle', 13, '#f59e0b') + ' Check') + '</div></div>';
    h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Permit Required</div><div style="font-weight:700;">' + (reg.permit_required === true ? '' + _ico('receipt', 13) + ' Yes' : reg.permit_required === false ? 'No' : '' + _ico('helpCircle', 13, '#f59e0b') + ' Check') + '</div></div>';
    if (reg.occupancy_tax_pct) h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Occupancy Tax</div><div style="font-weight:700;">' + reg.occupancy_tax_pct + '%</div></div>';
    if (reg.max_occupancy_days) h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Max Days/Year</div><div style="font-weight:700;">' + reg.max_occupancy_days + '</div></div>';
    h += '</div>';
    if (reg.notes) h += '<div style="font-size:0.85rem;color:var(--text);line-height:1.6;">' + esc(reg.notes) + '</div>';
    h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:8px;">' + _ico('alertCircle', 13, '#f59e0b') + ' Always verify regulations with the local municipality before purchasing. AI-sourced data may not be current.</div>';
    h += '</div>';
  }

  // ── Area Demand Analysis ──
  if (a.area_demand) {
    var ad = a.area_demand;
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">' + _ico('building', 13) + ' AREA DEMAND ANALYSIS</div>';
    if (ad.str_demand_drivers && ad.str_demand_drivers.length) {
      h += '<div style="margin-bottom:8px;"><strong style="font-size:0.78rem;color:var(--accent);">What brings short-term visitors:</strong></div>';
      ad.str_demand_drivers.forEach(function(d) { h += '<div style="font-size:0.85rem;margin:3px 0;line-height:1.4;">• ' + esc(d) + '</div>'; });
    }
    if (ad.ltr_demand_drivers && ad.ltr_demand_drivers.length) {
      h += '<div style="margin:10px 0 8px;"><strong style="font-size:0.78rem;color:var(--blue);">What brings mid/long-term renters:</strong></div>';
      ad.ltr_demand_drivers.forEach(function(d) { h += '<div style="font-size:0.85rem;margin:3px 0;line-height:1.4;">• ' + esc(d) + '</div>'; });
    }
    if (ad.seasonal_patterns) h += '<div style="margin-top:10px;font-size:0.85rem;line-height:1.6;"><strong style="color:var(--text2);">Seasonal Patterns:</strong> ' + esc(ad.seasonal_patterns) + '</div>';
    if (ad.competition_level) h += '<div style="margin-top:6px;font-size:0.85rem;"><strong style="color:var(--text2);">Competition:</strong> ' + esc(ad.competition_level) + '</div>';
    h += '</div>';
  }

  // ── Future Value Projection ──
  if (a.future_value) {
    var fv = a.future_value;
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">' + _ico('trendUp', 13) + ' FUTURE VALUE PROJECTION</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:10px;">';
    if (fv.appreciation_pct_annual) h += ac('Annual Appreciation', fv.appreciation_pct_annual + '%', fv.appreciation_pct_annual > 0 ? 'var(--accent)' : 'var(--danger)');
    if (fv.value_in_3_years) h += ac('Value in 3 Years', '$' + Math.round(fv.value_in_3_years).toLocaleString(), 'var(--accent)');
    if (fv.value_in_5_years) h += ac('Value in 5 Years', '$' + Math.round(fv.value_in_5_years).toLocaleString(), 'var(--accent)');
    h += '</div>';
    if (fv.area_development) h += '<div style="font-size:0.85rem;line-height:1.6;margin-bottom:6px;"><strong style="color:var(--accent);">Development:</strong> ' + esc(fv.area_development) + '</div>';
    if (fv.risk_factors) h += '<div style="font-size:0.85rem;line-height:1.6;"><strong style="color:var(--danger);">Risk Factors:</strong> ' + esc(fv.risk_factors) + '</div>';
    h += '</div>';
  }

  // Conditions & deal breakers
  if (a.conditions_for_go && a.conditions_for_go.length > 0) {
    h += '<div style="padding:12px 14px;background:rgba(16,185,129,0.04);border:1px solid rgba(16,185,129,0.15);border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">✓ CONDITIONS FOR GO</div>';
    a.conditions_for_go.forEach(function(c) { h += '<div style="font-size:0.82rem;margin:4px 0;line-height:1.4;">• ' + esc(c) + '</div>'; });
    h += '</div>';
  }
  if (a.deal_breakers && a.deal_breakers.length > 0) {
    h += '<div style="padding:12px 14px;background:rgba(239,68,68,0.04);border:1px solid rgba(239,68,68,0.15);border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--danger);margin-bottom:6px;">✗ DEAL BREAKERS</div>';
    a.deal_breakers.forEach(function(c) { h += '<div style="font-size:0.82rem;margin:4px 0;line-height:1.4;">• ' + esc(c) + '</div>'; });
    h += '</div>';
  }

  // Market outlook & comp performance — BIGGER, readable
  if (a.market_outlook) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--text2);margin-bottom:6px;">' + _ico('globe', 13) + ' MARKET OUTLOOK</div>';
    h += '<div style="font-size:0.88rem;color:var(--text);line-height:1.6;">' + esc(a.market_outlook) + '</div></div>';
  }
  if (a.comparable_performance) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--text2);margin-bottom:6px;">' + _ico('barChart', 13) + ' VS. COMPARABLES</div>';
    h += '<div style="font-size:0.88rem;color:var(--text);line-height:1.6;">' + esc(a.comparable_performance) + '</div></div>';
  }

  // Final recommendation
  if (a.recommendation) {
    h += '<div style="padding:16px;background:' + vBg + ';border:2px solid ' + vBdr + ';border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:' + vc + ';margin-bottom:6px;">' + _ico('receipt', 13) + ' FINAL RECOMMENDATION</div>';
    h += '<div style="font-size:0.88rem;line-height:1.6;color:var(--text);">' + esc(a.recommendation) + '</div>';
    h += '</div>';
  }

  h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:8px;">Generated by ' + esc(d.provider || 'AI') + ' · ' + (d.updated_at || '') + '</div>';
  container.innerHTML = h;
}

async function saveAcqConsiderations() {
  var val = (document.getElementById('acqConsiderations') || {}).value || '';
  window._acqConsiderations = val;
  var editId = document.getElementById('f_editId').value;
  if (editId) {
    try { await api('/api/admin/settings', 'POST', { key: 'acq_notes_' + editId, value: val }); } catch {}
  }
  toast('Considerations saved — will be included in next analysis');
}

async function loadAcqConsiderations(propId) {
  try {
    var d = await api('/api/admin/settings/acq_notes_' + propId);
    if (d && d.value) {
      window._acqConsiderations = d.value;
      var el = document.getElementById('acqConsiderations');
      if (el) el.value = d.value;
    }
  } catch { /* no saved notes */ }
}

async function linkPLFromProperty() {
  var sel = document.getElementById('plLinkSelect');
  if (!sel || !sel.value) { toast('Select a PriceLabs listing', 'error'); return; }
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  try {
    await api('/api/pricelabs/listings/' + sel.value + '/link', 'POST', { property_id: parseInt(editId) });
    toast('PriceLabs listing linked');
    openProperty(editId);
  } catch (err) { toast(err.message, 'error'); }
}

async function loadSavedReports(propId) {
  try {
    var d = await api('/api/properties/' + propId + '/reports');
    var latest = d.latest || {};
    var st = document.getElementById('plStrategyStatus');

    // Show saved report timestamps
    var savedInfo = [];
    if (latest.pricing_analysis) savedInfo.push('' + _ico('search', 13) + ' Price Analysis: ' + fmtUTC(latest.pricing_analysis.created_at));
    if (latest.pl_strategy) savedInfo.push('' + _ico('barChart', 13) + ' Strategy: ' + fmtUTC(latest.pl_strategy.created_at));
    if (latest.revenue_optimization) savedInfo.push('' + _ico('trendUp', 13) + ' Optimization: ' + fmtUTC(latest.revenue_optimization.created_at));
    if (latest.acquisition_analysis) savedInfo.push('' + _ico('home', 13) + ' Acquisition: ' + fmtUTC(latest.acquisition_analysis.created_at));

    if (savedInfo.length > 0 && st) {
      st.innerHTML = '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:8px;">Saved reports: ' + savedInfo.join(' · ') + '</div>';
    }

    // Restore latest pricing analysis (from Run Price Analysis button) — highest priority
    var resultsEl = document.getElementById('priceAnalysisResults');
    if (resultsEl && latest.pricing_analysis && latest.pricing_analysis.data) {
      var pd = latest.pricing_analysis.data;
      var h = '';
      // Restored banner
      var ago = Math.round((Date.now() - new Date(latest.pricing_analysis.created_at + 'Z').getTime()) / 86400000);
      var agoText = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago + ' days ago';
      h += '<div style="font-size:0.7rem;color:var(--text3);padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;margin-bottom:8px;">' + _ico('refresh', 13) + ' Restored from ' + agoText + ' · ' + fmtUTC(latest.pricing_analysis.created_at) + ' · <em>Run Price Analysis to refresh</em></div>';
      // Sources
      if (pd.sources && pd.sources.length > 0) {
        h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">';
        pd.sources.forEach(function(s) {
          var color = s.status === 'none' || s.status === 'not linked' ? 'var(--text3)' : 'var(--accent)';
          var icon = s.status === 'none' || s.status === 'not linked' ? '○' : '●';
          h += '<span style="font-size:0.68rem;color:' + color + ';background:var(--bg);padding:2px 8px;border-radius:4px;border:1px solid var(--border);">' + icon + ' ' + esc(s.name) + ': ' + esc(s.status) + '</span>';
        });
        h += '</div>';
      }
      // Market
      if (pd.market) {
        h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;">';
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">MARKET CONTEXT</div>';
        h += '<div class="market-grid">';
        if (pd.market.avg_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(pd.market.avg_daily_rate).toLocaleString() + '</div><div class="lbl">Avg Rent/mo</div></div>';
        if (pd.market.median_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(pd.market.median_daily_rate).toLocaleString() + '</div><div class="lbl">Median Rent/mo</div></div>';
        if (pd.market.active_listings) h += '<div class="market-stat"><div class="val">' + pd.market.active_listings + '</div><div class="lbl">Active Listings</div></div>';
        h += '<div class="market-stat"><div class="val">' + (pd.comparables_count || 0) + '</div><div class="lbl">Comps Found</div></div>';
        h += '</div></div>';
      }
      // Seasonality chart
      if (pd.seasonality && pd.seasonality.length >= 6) {
        var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;">';
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--purple);margin-bottom:6px;">SEASONAL ADJUSTMENTS</div>';
        h += '<div style="display:flex;gap:2px;align-items:flex-end;height:60px;">';
        var maxM = Math.max.apply(null, pd.seasonality.map(function(s) { return s.multiplier || 1; }));
        pd.seasonality.forEach(function(s) {
          var pct = maxM > 0 ? Math.round((s.multiplier || 1) / maxM * 100) : 50;
          var clr = (s.multiplier || 1) >= 1.1 ? 'var(--accent)' : (s.multiplier || 1) <= 0.85 ? 'var(--danger)' : '#f59e0b';
          h += '<div style="flex:1;text-align:center;"><div style="background:' + clr + ';border-radius:3px 3px 0 0;height:' + Math.max(pct, 5) + '%;min-height:3px;opacity:0.7;" title="' + mNames[(s.month_number || 1) - 1] + ': ' + (s.multiplier || 1).toFixed(2) + 'x"></div>';
          h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:2px;">' + mNames[(s.month_number || 1) - 1] + '</div>';
          h += '<div style="font-size:0.5rem;color:' + clr + ';">' + (s.multiplier || 1).toFixed(1) + 'x</div></div>';
        });
        h += '</div></div>';
      }
      // Strategies - full render, no truncation
      if (pd.strategies && pd.strategies.length > 0) {
        h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">PRICING STRATEGIES (' + pd.strategies.length + ')</div>';
        pd.strategies.forEach(function(s) { h += renderStrategyCard(s, true); });
      }
      resultsEl.innerHTML = h;
    }

    // Restore latest PL strategy into plStrategyResults
    var plStratEl = document.getElementById('plStrategyResults');
    if (plStratEl && latest.pl_strategy && latest.pl_strategy.data && latest.pl_strategy.data.strategy && (!latest.pl_strategy.data.context?.parse_error || latest.pl_strategy.data.strategy.base_price)) {
      renderPLStrategy(latest.pl_strategy.data, plStratEl);
      // Add "last updated" banner
      var plAgo = _agoText(latest.pl_strategy.created_at);
      plStratEl.insertAdjacentHTML('afterbegin', '<div style="font-size:0.68rem;color:var(--text3);padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;margin-bottom:8px;">' + _ico('clock', 12) + ' Last run ' + plAgo + ' · ' + fmtUTC(latest.pl_strategy.created_at) + ' · <em>Click Generate Strategy to refresh</em></div>');
    }
    // Restore latest revenue optimization — ALWAYS show latest if available
    var optRes = document.getElementById('revenueOptResults');
    if (optRes && latest.revenue_optimization && latest.revenue_optimization.data && latest.revenue_optimization.data.optimization) {
      renderRevenueOptimization(latest.revenue_optimization.data, optRes);
      var optAgo = _agoText(latest.revenue_optimization.created_at);
      optRes.insertAdjacentHTML('afterbegin', '<div style="font-size:0.68rem;color:var(--text3);padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;margin-bottom:8px;">' + _ico('clock', 12) + ' Last run ' + optAgo + ' · ' + fmtUTC(latest.revenue_optimization.created_at) + ' · <em>Click Optimize Revenue to refresh</em></div>');
    }
    // Restore latest acquisition analysis — ALWAYS show latest if available
    var acqRes = document.getElementById('acquisitionResults');
    if (acqRes && latest.acquisition_analysis && latest.acquisition_analysis.data && latest.acquisition_analysis.data.analysis) {
      renderAcquisitionAnalysis(latest.acquisition_analysis.data, acqRes);
      var acqAgo = _agoText(latest.acquisition_analysis.created_at);
      acqRes.insertAdjacentHTML('afterbegin', '<div style="font-size:0.68rem;color:var(--text3);padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;margin-bottom:8px;">' + _ico('clock', 12) + ' Last run ' + acqAgo + ' · ' + fmtUTC(latest.acquisition_analysis.created_at) + ' · <em>Click to refresh</em></div>');
    }
    // Load saved considerations
    loadAcqConsiderations(propId);
  } catch {}
}

async function generatePLStrategy() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  renderRevenueSnapshot(editId);
  var btn = document.getElementById('genPLStratBtn');
  var st = document.getElementById('plStrategyStatus');
  var res = document.getElementById('plStrategyResults');
  if (btn) btn.disabled = true;
  if (btn) btn.innerHTML ='' + _ico('clock', 13) + ' Generating...';
  if (st) st.innerHTML ='' + _ico('sparkle', 13) + ' Analyzing property data, market conditions, comps, and PriceLabs data...';
  if (res) res.innerHTML = ''; // Clear old results
  showLoading('Generating pricing strategy...');
  try {
    var d = await api('/api/properties/' + editId + '/pl-strategy', 'POST');
    if (st) st.innerHTML = '';
    renderPLStrategy(d, res);
    // Refresh the compare panel: convert pl-strategy result into the shape loadPLComparePanel expects
    if (typeof loadPLComparePanel === 'function' && d && d.strategy) {
      var s = d.strategy;
      // Map pl-strategy output → strategy card shape the compare panel understands
      var syntheticStrat = {
        strategy_name: 'AI — PL Strategy',
        base_nightly_rate: s.base_price || 0,
        min_price: s.min_price || 0,
        max_price: s.max_price || 0,
        weekend_rate: s.base_price && s.weekend_adjustment ? Math.round(s.base_price * (1 + (s.weekend_adjustment || 20) / 100)) : (s.base_price ? Math.round(s.base_price * 1.2) : 0),
        cleaning_fee: s.cleaning_fee || 0,
        min_nights: s.min_nights_weekday || s.min_nights_weekend || 2,
        projected_occupancy: s.projected_occupancy || 0,
        projected_monthly_avg: s.projected_monthly_revenue || 0,
        projected_annual_revenue: s.projected_annual_revenue || 0,
        ai_generated: true,
        from_pl_strategy: true,
      };
      // Build a synthetic analysisData object the panel can consume
      var syntheticData = {
        pricelabs: d.context && d.context.pricelabs ? d.context.pricelabs : null,
        strategies: [syntheticStrat],
        property: d.property || null,
      };
      // If no PL data in context, load from property
      if (!syntheticData.pricelabs) {
        loadPLComparePanel(editId, null); // will fetch from property endpoint
      } else {
        loadPLComparePanel(editId, syntheticData);
      }
    }
    toast('Strategy generated');
  } catch (err) {
    var errMsg = err.message || 'Unknown error';
    var helpHtml = errMsg.includes('AI provider') ? '<div style="margin-top:6px;padding:8px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font-size:0.78rem;">' + _ico('zap', 13) + ' Go to <strong>Admin → API Keys</strong> and add your Anthropic or OpenAI API key. Workers AI (free) should also work if enabled on your Cloudflare account.</div>' : '';
    if (st) st.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(errMsg) + '</span>' + helpHtml;
    toast(errMsg, 'error');
  }
  if (btn) { btn.disabled = false; btn.innerHTML ='' + _ico('barChart', 13) + ' Generate Strategy'; }
  hideLoading();
}

function renderPLStrategy(d, container) {
  if (!container || !d.strategy) return;
  var s = d.strategy;
  var ctx = d.context || {};
  var h = '';

  // Summary
  if (s.strategy_summary) {
    h += '<div style="padding:14px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-weight:600;color:var(--purple);margin-bottom:6px;">Strategy Summary</div>';
    h += '<div style="font-size:0.85rem;color:var(--text);white-space:pre-wrap;line-height:1.6;">' + esc(s.strategy_summary) + '</div>';
    if (ctx.parse_error) {
      h += '<div style="margin-top:8px;padding:8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font-size:0.72rem;color:var(--danger);">';
      h += '<strong>Parse error:</strong> ' + esc(ctx.parse_detail || 'unknown') + '<br>';
      h += '<em>Check Admin → System Log for details. The AI returned text instead of JSON — try generating again.</em>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Core pricing grid
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:14px;">';
  function card(label, val, color, sub) {
    return '<div style="text-align:center;padding:10px 6px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">' +
      '<div style="font-size:0.65rem;color:var(--text3);margin-bottom:2px;">' + label + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:' + (color || 'var(--text)') + ';">' + val + '</div>' +
      (sub ? '<div style="font-size:0.62rem;color:var(--text3);margin-top:2px;">' + sub + '</div>' : '') +
      '</div>';
  }
  h += card('Base Price', '$' + (s.base_price || '?') + '/nt', 'var(--purple)');
  h += card('Min Price', '$' + (s.min_price || '?') + '/nt', 'var(--danger)', 'floor');
  h += card('Max Price', '$' + (s.max_price || '?') + '/nt', 'var(--accent)', 'ceiling');
  h += card('Cleaning Fee', '$' + (s.cleaning_fee || '?'), 'var(--text)');
  h += card('Weekend +', (s.weekend_adjustment || 0) + '%', '#f59e0b', 'Fri/Sat');
  h += card('Proj. Occupancy', Math.round((s.projected_occupancy || 0) * 100) + '%', 'var(--accent)');
  h += card('Proj. Monthly', '$' + (s.projected_monthly_revenue || 0).toLocaleString(), 'var(--accent)');
  h += card('Proj. Annual', '$' + (s.projected_annual_revenue || 0).toLocaleString(), 'var(--purple)');
  h += card('Breakeven Occ.', Math.round((s.breakeven_occupancy || 0) * 100) + '%', 'var(--danger)', '$' + (ctx.monthly_expenses || 0).toLocaleString() + '/mo costs');
  h += '</div>';

  // Cleaning fee reasoning
  if (s.cleaning_fee_reasoning) {
    h += '<div style="padding:10px 14px;background:var(--surface2);border-radius:8px;margin-bottom:14px;font-size:0.78rem;">';
    h += '<strong>Cleaning Fee Rationale:</strong> ' + esc(s.cleaning_fee_reasoning);
    h += '</div>';
  }

  // Discounts & Min nights
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">';
  h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">DISCOUNTS</div>';
  var discounts = [
    ['Weekly', (s.weekly_discount_pct || 0) + '%'],
    ['Monthly', (s.monthly_discount_pct || 0) + '%'],
    ['Last Minute', (s.last_minute_discount_pct || 0) + '%'],
    ['Early Bird', (s.early_bird_discount_pct || 0) + '%'],
    ['Orphan Day', (s.orphan_day_discount_pct || 0) + '%'],
  ];
  discounts.forEach(function(d) { h += '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin:4px 0;"><span style="color:var(--text3);">' + d[0] + '</span><span style="font-family:DM Mono,monospace;font-weight:600;">' + d[1] + '</span></div>'; });
  h += '</div>';

  h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">STAY REQUIREMENTS</div>';
  h += '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin:4px 0;"><span style="color:var(--text3);">Min Nights (Weekday)</span><span style="font-family:DM Mono,monospace;font-weight:600;">' + (s.min_nights_weekday || 2) + '</span></div>';
  h += '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin:4px 0;"><span style="color:var(--text3);">Min Nights (Weekend)</span><span style="font-family:DM Mono,monospace;font-weight:600;">' + (s.min_nights_weekend || 2) + '</span></div>';
  if (s.pet_fee > 0) h += '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin:4px 0;"><span style="color:var(--text3);">Pet Fee</span><span style="font-family:DM Mono,monospace;font-weight:600;">$' + s.pet_fee + '</span></div>';
  if (s.extra_guest_fee > 0) h += '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin:4px 0;"><span style="color:var(--text3);">Extra Guest Fee</span><span style="font-family:DM Mono,monospace;font-weight:600;">$' + s.extra_guest_fee + '/guest</span></div>';
  h += '</div>';
  h += '</div>';

  // Seasonality
  if (s.peak_season_months || s.low_season_months) {
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">';
    if (s.peak_season_months && s.peak_season_months.length > 0) {
      h += '<div style="padding:10px 14px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.15);border-radius:8px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--danger);margin-bottom:4px;">' + _ico('flame', 13, 'var(--danger)') + ' PEAK SEASON (+' + (s.peak_season_markup_pct || 0) + '%)</div>';
      h += '<div style="font-size:0.78rem;">' + s.peak_season_months.join(', ') + '</div></div>';
    }
    if (s.low_season_months && s.low_season_months.length > 0) {
      h += '<div style="padding:10px 14px;background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.15);border-radius:8px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--blue);margin-bottom:4px;">' + _ico('snowflake', 13, 'var(--blue)') + ' LOW SEASON (-' + (s.low_season_discount_pct || 0) + '%)</div>';
      h += '<div style="font-size:0.78rem;">' + s.low_season_months.join(', ') + '</div></div>';
    }
    h += '</div>';
  }

  // PriceLabs setup steps
  if (s.pricelabs_setup_steps && s.pricelabs_setup_steps.length > 0) {
    h += '<div style="padding:14px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:8px;">' + _ico('receipt', 13) + ' PRICELABS SETUP STEPS</div>';
    s.pricelabs_setup_steps.forEach(function(step, i) {
      h += '<div style="display:flex;gap:8px;margin:6px 0;font-size:0.78rem;">';
      h += '<span style="flex-shrink:0;width:22px;height:22px;border-radius:50%;background:var(--purple);color:var(--bg);display:flex;align-items:center;justify-content:center;font-size:0.68rem;font-weight:700;">' + (i + 1) + '</span>';
      h += '<span style="color:var(--text);line-height:1.4;">' + esc(step) + '</span></div>';
    });
    h += '</div>';
  }

  // Key recommendations
  if (s.key_recommendations && s.key_recommendations.length > 0) {
    h += '<div style="padding:14px;background:rgba(16,185,129,0.04);border:1px solid rgba(16,185,129,0.15);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:8px;">✓ KEY RECOMMENDATIONS</div>';
    s.key_recommendations.forEach(function(r) {
      h += '<div style="font-size:0.78rem;color:var(--text);margin:4px 0;">• ' + esc(r) + '</div>';
    });
    h += '</div>';
  }

  // Risks
  if (s.risks && s.risks.length > 0) {
    h += '<div style="padding:14px;background:rgba(245,158,11,0.04);border:1px solid rgba(245,158,11,0.15);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:#f59e0b;margin-bottom:8px;">' + _ico('alertCircle', 13, '#f59e0b') + ' RISKS</div>';
    s.risks.forEach(function(r) {
      h += '<div style="font-size:0.78rem;color:var(--text);margin:4px 0;">• ' + esc(r) + '</div>';
    });
    h += '</div>';
  }

  // Context footer
  h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:14px;padding-top:10px;border-top:1px solid var(--border);">';
  h += 'Generated using: ' + (ctx.provider || 'AI') + ' · ';
  h += (ctx.comps_count || 0) + ' comps · ' + (ctx.amenities_count || 0) + ' amenities · ' + (ctx.platforms_count || 0) + ' platforms';
  if (ctx.has_pricelabs) h += ' · PriceLabs linked';
  h += ' · <strong>Read-only recommendations — no prices were changed.</strong>';
  h += '</div>';

  container.innerHTML = h;
}

var propTrends = {};
async function loadProperties() {
  try { const d = await api('/api/properties'); properties = d.properties || []; propTrends = d.trends || {}; window._actualRevenue = d.actual_revenue || {}; window._marketProfiles = d.market_profiles || {}; renderProperties(); }
  catch { properties = []; propTrends = {}; renderProperties(); }
  // Show/hide Management tab based on managed properties
  var hasManaged = properties.some(function(p) { return p.is_managed === 1 || p.is_managed === '1' || p.ownership_type === 'managed'; });
  var mgmtTab = document.getElementById('managementTab');
  if (mgmtTab) mgmtTab.style.display = hasManaged ? '' : 'none';
}

var _propCompact = false;  // compact vs detailed card view

function togglePropView() {
  _propCompact = !_propCompact;
  var btn = document.getElementById('propViewToggle');
  if (btn) { btn.textContent = _propCompact ? '☰' : '⊞'; btn.title = _propCompact ? 'Switch to detailed view' : 'Switch to compact view'; }
  renderProperties();
}

function renderProperties() {
  var list = document.getElementById('propertyList');
  var empty = document.getElementById('propertyEmpty');
  var bulkBar = document.getElementById('bulkBar');

  // Populate city filter dropdown
  var cityFilter = document.getElementById('propFilterCity');
  if (cityFilter) {
    var cities = []; properties.forEach(function(p) { if (p.city && cities.indexOf(p.city) < 0) cities.push(p.city); });
    cities.sort();
    var curCity = cityFilter.value;
    cityFilter.innerHTML = '<option value="">All Cities</option>' + cities.map(function(c) { return '<option value="' + esc(c) + '"' + (c === curCity ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
  }

  if (properties.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; if (bulkBar) bulkBar.style.display = 'none'; return; }
  empty.style.display = 'none';
  if (bulkBar) bulkBar.style.display = bulkMode ? 'block' : 'none';
  updateBulkCount();

  // Filter
  var fCity = (document.getElementById('propFilterCity') || {}).value || '';
  var fType = (document.getElementById('propFilterType') || {}).value || '';
  var fSearch = ((document.getElementById('propSearch') || {}).value || '').toLowerCase();
  var filtered = properties.filter(function(p) {
    if (fCity && p.city !== fCity) return false;
    if (fType && p.property_type !== fType) return false;
    if (fSearch && (p.address + ' ' + p.city + ' ' + p.state + ' ' + (p.name || '')).toLowerCase().indexOf(fSearch) < 0) return false;
    return true;
  });

  // Sort
  var sorted = filtered.slice().sort(function(a, b) {
    switch (propSortKey) {
      case 'address_asc': return (a.address || '').localeCompare(b.address || '');
      case 'address_desc': return (b.address || '').localeCompare(a.address || '');
      case 'city_asc': return (a.city || '').localeCompare(b.city || '');
      case 'city_desc': return (b.city || '').localeCompare(a.city || '');
      case 'type_asc': return (a.property_type || '').localeCompare(b.property_type || '');
      case 'beds_desc': return (b.bedrooms || 0) - (a.bedrooms || 0);
      case 'beds_asc': return (a.bedrooms || 0) - (b.bedrooms || 0);
      case 'sqft_desc': return (b.sqft || 0) - (a.sqft || 0);
      case 'value_desc': return (b.estimated_value || 0) - (a.estimated_value || 0);
      default: return 0;
    }
  });
  // Identify buildings and children
  var buildingIds = new Set();
  var childIds = new Set();
  sorted.forEach(function(p) {
    if (p.child_count > 0 || p.total_units_count > 0) buildingIds.add(p.id);
    if (p.parent_id) childIds.add(p.id);
  });

  var buildings = sorted.filter(function(p) { return buildingIds.has(p.id); });
  var topLevel = sorted.filter(function(p) { return !childIds.has(p.id); }); // buildings + standalone + research (no children)
  var research = sorted.filter(function(p) { return !buildingIds.has(p.id) && !childIds.has(p.id) && p.is_research; });

  var groupBy = (document.getElementById('propGroupBy') || {}).value || 'type';
  var html = '';

  // ── Helper: render a section header ──
  function sectionHeader(icon, label, count, color) {
    return '<div style="font-size:0.72rem;font-weight:600;color:' + (color || 'var(--text3)') + ';text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;padding:4px 6px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">' +
      '<span>' + icon + ' ' + label + '</span>' +
      '<span style="font-weight:400;font-size:0.68rem;color:var(--text3);">' + count + ' ' + (count === 1 ? 'property' : 'properties') + '</span>' +
    '</div>';
  }

  // ── Helper: render one building + its children ──
  function renderBuilding(bld) {
    var ch = '';
    if (!_propCompact) {
      sorted.filter(function(p) { return String(p.parent_id) === String(bld.id); }).forEach(function(child) {
        ch += renderPropertyCard(child, false, true);
      });
    }
    return renderPropertyCard(bld, true, false) + ch;
  }

  if (groupBy === 'city') {
    // ── Group by city ──
    var cityGroups = {};
    topLevel.forEach(function(p) {
      var key = (p.city || 'Unknown') + ', ' + (p.state || '');
      if (!cityGroups[key]) cityGroups[key] = [];
      cityGroups[key].push(p);
    });
    Object.keys(cityGroups).sort().forEach(function(city) {
      var grp = cityGroups[city];
      html += '<div style="margin-bottom:20px;">';
      html += sectionHeader('' + _ico('mapPin', 13) + '', city, grp.length, 'var(--accent)');
      grp.forEach(function(p) {
        html += buildingIds.has(p.id) ? renderBuilding(p) : renderPropertyCard(p, false, false);
      });
      html += '</div>';
    });

  } else if (groupBy === 'status') {
    // ── Group by listing status ──
    var statusOrder = ['active', 'paused', 'inactive', ''];
    var statusLabels = { active: '● Live', paused: '⏸ Paused', inactive: '⏹ Inactive', '': 'No Status' };
    var statusColors = { active: 'var(--accent)', paused: '#f59e0b', inactive: 'var(--danger)', '': 'var(--text3)' };
    var statusGroups = {};
    topLevel.forEach(function(p) {
      var key = p.listing_status || '';
      if (!statusGroups[key]) statusGroups[key] = [];
      statusGroups[key].push(p);
    });
    statusOrder.forEach(function(status) {
      if (!statusGroups[status] || statusGroups[status].length === 0) return;
      var grp = statusGroups[status];
      html += '<div style="margin-bottom:20px;">';
      html += sectionHeader('', statusLabels[status], grp.length, statusColors[status]);
      grp.forEach(function(p) {
        html += buildingIds.has(p.id) ? renderBuilding(p) : renderPropertyCard(p, false, false);
      });
      html += '</div>';
    });

  } else if (groupBy === 'none') {
    // ── No grouping — flat list ──
    html += '<div style="margin-bottom:20px;">';
    topLevel.forEach(function(p) {
      html += buildingIds.has(p.id) ? renderBuilding(p) : renderPropertyCard(p, false, false);
    });
    html += '</div>';

  } else {
    // ── Default: group by type (Buildings / STR / LTR / Research) ──
    if (buildings.length > 0) {
      html += '<div style="margin-bottom:20px;">';
      html += sectionHeader('' + _ico('building', 13) + '', 'Buildings & Units', buildings.length, 'var(--purple)');
      buildings.forEach(function(bld) { html += renderBuilding(bld); });
      html += '</div>';
    }

    var isManaged = function(p) { return p.is_managed === 1 || p.is_managed === '1' || p.ownership_type === 'managed'; };
    var strProps = topLevel.filter(function(p) { return !buildingIds.has(p.id) && !p.is_research && !isManaged(p) && p.rental_type !== 'ltr'; });
    if (strProps.length > 0) {
      html += '<div style="margin-bottom:20px;">';
      html += sectionHeader('' + _ico('home', 13) + '', 'Short-Term Rentals', strProps.length, 'var(--text2)');
      strProps.forEach(function(p) { html += renderPropertyCard(p, false, false); });
      html += '</div>';
    }

    var ltrProps = topLevel.filter(function(p) { return !buildingIds.has(p.id) && !p.is_research && !isManaged(p) && p.rental_type === 'ltr'; });
    if (ltrProps.length > 0) {
      html += '<div style="margin-bottom:20px;">';
      html += sectionHeader('' + _ico('clipboard', 13) + '', 'Long-Term Rentals', ltrProps.length, '#60a5fa');
      ltrProps.forEach(function(p) { html += renderPropertyCard(p, false, false); });
      html += '</div>';
    }

    var managedProps = topLevel.filter(function(p) { return !buildingIds.has(p.id) && !p.is_research && isManaged(p); });
    if (managedProps.length > 0) {
      html += '<div style="margin-bottom:20px;">';
      html += sectionHeader('' + _ico('handshake', 13) + '', 'Managed for Owners', managedProps.length, '#60a5fa');
      html += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:8px;padding:0 4px;">These properties are managed for other owners. Their revenue and costs are NOT included in your portfolio totals.</div>';
      managedProps.forEach(function(p) { html += renderPropertyCard(p, false, false); });
      html += '</div>';
    }

    if (research.length > 0) {
      html += '<div style="margin-bottom:20px;">';
      html += sectionHeader('' + _ico('search', 13) + '', 'Research', research.length, 'var(--purple)');
      research.forEach(function(p) { html += renderPropertyCard(p, false, false); });
      html += '</div>';
    }
  }

  list.innerHTML = html;
}

function renderPropertyCard(p, isBuilding, isChild) {
    var tl = p.property_type ? p.property_type.replace('_', ' ') : '';
    var typeIcons = {single_family:'' + _ico('home', 13) + '',apartment:'' + _ico('building', 13) + '',condo:'' + _ico('building', 13) + '',townhouse:'' + _ico('home', 13) + '',multi_family:'' + _ico('building', 13) + '',cabin:'' + _ico('home', 13) + '',cottage:'' + _ico('home', 13) + '',villa:_ico('home',15),mobile_home:'' + _ico('home', 13) + ''};
    var typeColors = {single_family:'59,130,246',apartment:'167,139,250',condo:'14,165,233',townhouse:'234,179,8',multi_family:'167,139,250',cabin:'180,83,9',cottage:'22,163,74',villa:'168,85,247',mobile_home:'107,114,128'};
    var typeIcon = typeIcons[p.property_type] || '' + _ico('home', 13) + '';
    var typeRgb = typeColors[p.property_type] || '148,163,184';
    var typeBadge = tl ? '<span class="badge" style="background:rgba(' + typeRgb + ',0.1);color:rgb(' + typeRgb + ');">' + typeIcon + ' ' + tl + '</span>' : '';
    var ownerBadge = p.is_research
      ? '<span class="badge" style="background:rgba(167,139,250,0.1);color:var(--purple);border:1px solid rgba(167,139,250,0.25);">' + _ico('search', 13) + ' research</span>'
      : p.ownership_type === 'rental'
      ? '<span class="badge" style="background:rgba(245,158,11,0.1);color:#f59e0b;border:1px solid rgba(245,158,11,0.25);">' + _ico('key', 13) + ' renting</span>'
      : (p.ownership_type === 'owned' || p.ownership_type === 'purchased' || (!p.ownership_type && p.purchase_price > 0))
        ? '<span class="badge" style="background:rgba(16,185,129,0.1);color:var(--accent);border:1px solid rgba(16,185,129,0.25);">' + _ico('home', 13) + ' purchased</span>'
        : '';
    var checked = selectedProps.has(p.id) ? ' checked' : '';
    var thumb = p.image_url ? '<div style="width:60px;height:60px;border-radius:6px;overflow:hidden;flex-shrink:0;"><img src="' + esc(p.image_url) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.style.display=\'none\'"></div>' : '';
    var label = getPropertyLabel(p);
    var indent = isChild ? 'margin-left:28px;' : '';

    // ── Financial computation (must come before border color) ──
    var monthlyCost = 0;
    if (p.ownership_type === 'rental') {
      monthlyCost = p.monthly_rent_cost || 0;
    } else {
      monthlyCost = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0);
    }
    monthlyCost += (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);

    var monthlyRev = p.est_monthly_revenue || 0;
    var revIsActual = false; // true = Guesty actuals, false = projection
    var plMonthlyRev = 0;
    var cardADR = 0;

    // Priority 1: Actual revenue from Guesty monthly_actuals
    var cardActualData = (window._actualRevenue || {})[p.id];
    if (cardActualData && cardActualData.monthly_avg > 0) {
      monthlyRev = cardActualData.monthly_avg;
      revIsActual = true;
    } else {
      // Priority 2: PriceLabs blended projection
      if (p.pl_base_price) {
        var plB = parseFloat(p.pl_base_price) || 0;
        var plM = parseFloat(p.pl_max_price) || plB;
        var plR = parseFloat(p.pl_rec_base) || plB;
        var plFwdPct = p.pl_occ_30d ? parseInt(p.pl_occ_30d) : null;
        var plMktPct = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) : null;
        var cardOcc = null;
        if (plFwdPct !== null && plFwdPct > 10) cardOcc = plFwdPct / 100;
        else if (plFwdPct === null && plMktPct !== null) cardOcc = Math.min(plMktPct / 100, 0.55);
        if (cardOcc !== null && plB > 0) {
          cardADR = Math.round(plB * 0.4 + plR * 0.3 + plB * 1.2 * 0.2 + (plB + plM) / 2 * 0.1);
          plMonthlyRev = Math.round(cardADR * 30 * cardOcc);
          if (plMonthlyRev > 0) monthlyRev = plMonthlyRev;
        }
      }
    }
    var analysisMonthly = p.analysis_monthly || 0;
    var net = isNaN(monthlyRev) ? 0 : monthlyRev - monthlyCost;

    // Profitability-based left border for quick glance scanning
    // When using projections (not actuals), soften the colors to signal uncertainty
    var profitBorderColor = '';
    if (!p.is_research && (monthlyCost > 0 || monthlyRev > 0)) {
      if (revIsActual) {
        if (net >= 300) profitBorderColor = 'rgba(16,185,129,0.6)';       // profitable — green
        else if (net >= 0) profitBorderColor = 'rgba(245,158,11,0.5)';    // breakeven — amber
        else profitBorderColor = 'rgba(239,68,68,0.45)';                   // losing — red
      } else {
        // Projections: use dimmer borders to signal "estimated"
        if (net >= 300) profitBorderColor = 'rgba(16,185,129,0.3)';
        else if (net >= 0) profitBorderColor = 'rgba(245,158,11,0.25)';
        else profitBorderColor = 'rgba(239,68,68,0.25)';
      }
    }
    var borderLeft = isChild
      ? '3px solid ' + (profitBorderColor || 'rgba(' + typeRgb + ',0.3)')
      : isBuilding
        ? '4px solid rgb(' + typeRgb + ')'
        : '3px solid ' + (profitBorderColor || 'rgba(' + typeRgb + ',0.25)');
    var buildingStyle = isBuilding ? 'background:linear-gradient(90deg,rgba(' + typeRgb + ',0.03),transparent);' : '';
    var standaloneAccent = '';
    var childBadge = isBuilding ? '<span class="badge" style="background:rgba(' + typeRgb + ',0.15);color:rgb(' + typeRgb + ');">' + _ico('building', 13) + ' ' + (p.child_count || p.total_units_count || 0) + ' units</span>' : '';
    var unitBadge = isChild
      ? '<span style="font-size:0.68rem;font-weight:700;color:rgb(' + typeRgb + ');background:rgba(' + typeRgb + ',0.15);border:1px solid rgba(' + typeRgb + ',0.3);padding:2px 7px;border-radius:4px;letter-spacing:0.02em;">UNIT</span>'
      : '';
    var coordHtml = (p.latitude && p.longitude) ? '<span style="font-size:0.68rem;color:var(--text3);" title="' + p.latitude + ', ' + p.longitude + '">' + _ico('mapPin', 13) + '</span>' : '';

    // ── Health Score ─────────────────────────────────────────────────────────
    // Combines net profit + occupancy vs market into a traffic-light signal
    var healthScore = null; // null = no data
    var healthLabel = '';
    var healthColor = '';
    var healthBg = '';
    var healthBorder = '';
    var healthTooltip = '';
    var healthReasons = [];

    if (!p.is_research && !isBuilding) {
      // ── ACTUAL DATA ONLY — health is never based on projections or analysis estimates ──
      // Sources considered REAL:
      //   1. Guesty monthly actuals (actual_revenue from /api/properties)
      //   2. PriceLabs forward occupancy % (real bookings on calendar)
      // Sources explicitly EXCLUDED:
      //   - analysis projections (projected_monthly_avg, analysis_monthly)
      //   - estimated revenue (est_monthly_revenue)
      //   - any "smart occupancy" extrapolations

      var actualData  = (window._actualRevenue || {})[p.id];
      var actualMonthly  = (actualData && actualData.monthly_avg > 0) ? actualData.monthly_avg : null;
      var actualADR      = (actualData && actualData.avg_adr > 0) ? actualData.avg_adr : null;
      var actualOccPct   = (actualData && actualData.avg_occ > 0) ? Math.round(actualData.avg_occ * 100) : null;
      var plFwdOccPct    = p.pl_occ_30d ? parseInt(p.pl_occ_30d) : null;  // real forward bookings from PL
      var mktOccPct      = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) : null;
      var hasCosts       = monthlyCost > 0;

      // Use Guesty actual occ if available, otherwise PL forward occ
      var yourOccPct = actualOccPct !== null ? actualOccPct : plFwdOccPct;
      var occGap     = (yourOccPct !== null && mktOccPct !== null) ? yourOccPct - mktOccPct : null;

      // Only show health badge if we have at least ONE real data point
      // No actuals + no PL occ → property not live yet → no badge
      var canScore = actualMonthly !== null || plFwdOccPct !== null;

      if (canScore) {
        var score = 100;

        // ── Net P&L — actual revenue vs actual expenses only ──
        if (actualMonthly !== null && hasCosts) {
          var realNet = actualMonthly - monthlyCost;
          if (realNet < 0)        { score -= 50; healthReasons.push('losing $' + Math.abs(Math.round(realNet)).toLocaleString() + '/mo actual'); }
          else if (realNet < 200) { score -= 20; healthReasons.push('thin margin — $' + Math.round(realNet).toLocaleString() + '/mo net'); }
        } else if (actualMonthly === null && hasCosts && plFwdOccPct !== null) {
          // Has PL data (so it's live) but no Guesty actuals yet — expenses with unknown revenue
          score -= 25;
          healthReasons.push('no actual revenue recorded — expenses are $' + Math.round(monthlyCost).toLocaleString() + '/mo');
        }

        // ── Occupancy vs market ──
        if (occGap !== null) {
          if (occGap < -20)      { score -= 40; healthReasons.push('occ ' + yourOccPct + '% vs market ' + mktOccPct + '% (−' + Math.abs(occGap) + '%)'); }
          else if (occGap < -10) { score -= 20; healthReasons.push('occ lagging market by ' + Math.abs(occGap) + '%'); }
          else if (occGap < -5)  { score -= 10; healthReasons.push('occ ' + yourOccPct + '% vs market ' + mktOccPct + '%'); }
          else if (occGap >= 5)  { healthReasons.push('occ ' + yourOccPct + '% beating market +' + occGap + '%'); }
        }

        // ── Very low forward booking pace ──
        if (plFwdOccPct !== null && plFwdOccPct <= 5) {
          score -= 25;
          healthReasons.push('only ' + plFwdOccPct + '% forward bookings');
        }

        // ── ADR vs PriceLabs recommendation ──
        if (p.pl_base_price && p.pl_rec_base && parseFloat(p.pl_rec_base) > parseFloat(p.pl_base_price) * 1.1) {
          score -= 10;
          healthReasons.push('PL recommends raising base to $' + p.pl_rec_base + '/nt');
        }

        // Map score → tier
        if (score >= 80) {
          healthScore = 'green';
          healthLabel = '● Healthy';
          healthColor = '#10b981';
          healthBg    = 'rgba(16,185,129,0.1)';
          healthBorder= 'rgba(16,185,129,0.3)';
          healthTooltip = 'Performing well' + (healthReasons.length ? ': ' + healthReasons.join(' · ') : '');
        } else if (score >= 50) {
          healthScore = 'yellow';
          healthLabel = '● Watch';
          healthColor = '#f59e0b';
          healthBg    = 'rgba(245,158,11,0.1)';
          healthBorder= 'rgba(245,158,11,0.3)';
          healthTooltip = 'Needs attention: ' + healthReasons.join(' · ');
        } else {
          healthScore = 'red';
          healthLabel = '● Act Now';
          healthColor = '#ef4444';
          healthBg    = 'rgba(239,68,68,0.1)';
          healthBorder= 'rgba(239,68,68,0.3)';
          healthTooltip = 'Underperforming: ' + healthReasons.join(' · ');
        }
      }
    }

    var healthBadge = healthScore
      ? '<span onclick="event.stopPropagation();openProperty(' + p.id + ',\'pricing\')" title="' + healthTooltip.replace(/"/g, '&quot;') + '" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-size:0.75rem;font-weight:800;color:' + healthColor + ';background:' + healthBg + ';border:2px solid ' + healthBorder + ';padding:4px 10px;border-radius:6px;letter-spacing:0.02em;user-select:none;text-transform:uppercase;">' + healthLabel + '</span>'
      : '';

    // ─────────────────────────────────────────────────────────────────────────

    // Performance trend indicator
    var trendHtml = '';
    var t = propTrends[p.id];

    // If no snapshot data, compute from current PL data
    if (!t && p.pl_base_price && !p.is_research) {
      // Compute estimated net from current PL data
      var tPlB = p.pl_base_price, tPlR = p.pl_rec_base || tPlB, tPlM = p.pl_max_price || tPlB;
      var tADR = Math.round(tPlB * 0.4 + tPlR * 0.3 + tPlB * 1.2 * 0.2 + (tPlB + tPlM) / 2 * 0.1);
      var tFwd = p.pl_occ_30d ? parseInt(p.pl_occ_30d) / 100 : 0;
      var tMkt = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) / 100 : 0;
      var tOcc = 0.50;
      if (tFwd >= 0.50) tOcc = tFwd;
      else if (tFwd > 0 && tMkt > 0 && tFwd > tMkt) tOcc = Math.max(0.55, Math.min(0.70, tFwd * 3.5));
      else if (tFwd > 0) tOcc = Math.max(0.40, Math.min(0.60, tFwd * 3));
      var tRev = Math.round(tADR * 30 * tOcc);
      var tNet = tRev - monthlyCost;
      t = { latest_net: tNet, latest_rev: tRev, prev_net: null };
    }

    if (t && t.latest_net !== null && !p.is_research) {
      var profitable = t.latest_net >= 0;
      var improving = t.prev_net !== null && t.latest_net > t.prev_net;
      var declining = t.prev_net !== null && t.latest_net < t.prev_net;
      var netDelta = t.prev_net !== null ? t.latest_net - t.prev_net : 0;

      if (profitable && improving) {
        trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">' + _ico('trendUp', 13) + ' +$' + Math.abs(Math.round(netDelta)).toLocaleString() + '</span>';
      } else if (profitable && declining) {
        trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">' + _ico('trendDown', 13) + ' -$' + Math.abs(Math.round(netDelta)).toLocaleString() + '</span>';
      } else if (profitable) {
        trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">' + _ico('check', 13, 'var(--accent)') + ' +$' + Math.round(t.latest_net).toLocaleString() + '/mo</span>';
      } else if (!profitable && improving) {
        trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">' + _ico('trendUp', 13) + ' -$' + Math.abs(Math.round(t.latest_net)).toLocaleString() + '/mo</span>';
      } else if (!profitable) {
        trendHtml = '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--danger);">' + _ico('x', 13, 'var(--danger)') + ' -$' + Math.abs(Math.round(t.latest_net)).toLocaleString() + '/mo</span>';
      }
    } else if (t && t.latest_net !== null && p.is_research) {
      if (t.latest_net >= 500) trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">' + _ico('check', 13, 'var(--accent)') + ' +$' + Math.round(t.latest_net).toLocaleString() + '/mo</span>';
      else if (t.latest_net >= 0) trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' +$' + Math.round(t.latest_net).toLocaleString() + '/mo</span>';
      else trendHtml = '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--danger);">' + _ico('x', 13, 'var(--danger)') + ' -$' + Math.abs(Math.round(t.latest_net)).toLocaleString() + '/mo</span>';
    } else if (p.is_research && analysisMonthly > 0) {
      var resNet = analysisMonthly - monthlyCost;
      if (resNet >= 500) trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">' + _ico('check', 13, 'var(--accent)') + ' +$' + Math.round(resNet).toLocaleString() + '/mo</span>';
      else if (resNet >= 0) trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' +$' + Math.round(resNet).toLocaleString() + '/mo</span>';
      else trendHtml = '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--danger);">' + _ico('x', 13, 'var(--danger)') + ' -$' + Math.abs(Math.round(resNet)).toLocaleString() + '/mo</span>';
    }

    // ── COMPACT VIEW ── single-row card with just the essentials
    if (_propCompact) {
      var netColor = net >= 0 ? 'var(--accent)' : 'var(--danger)';
      var profitBorder = net >= 200 ? '3px solid rgba(16,185,129,0.5)' : net >= 0 ? '3px solid rgba(245,158,11,0.4)' : net < 0 ? '3px solid rgba(239,68,68,0.4)' : '3px solid var(--border)';
      var actualMark = '';
      var actR = (window._actualRevenue || {})[p.id];
      if (actR && actR.monthly_avg > 0) actualMark = '<span style="font-size:0.68rem;color:var(--accent);font-family:DM Mono,monospace;font-weight:600;">$' + actR.monthly_avg.toLocaleString() + '/mo</span>';
      else if (monthlyRev > 0) actualMark = '<span style="font-size:0.68rem;color:var(--text3);font-family:DM Mono,monospace;">~$' + Math.round(monthlyRev).toLocaleString() + '/mo</span>';

      return '<div onclick="openProperty(' + p.id + ')" style="cursor:pointer;display:flex;align-items:center;gap:10px;padding:7px 10px;background:var(--card);border:1px solid var(--border);border-left:' + profitBorder + ';border-radius:7px;margin-bottom:5px;' + indent + 'transition:background 0.1s;" onmouseenter="this.style.background=&quot;var(--surface2)&quot;" onmouseleave="this.style.background=&quot;var(--card)&quot;">' +
        (p.image_url ? '<img src="' + esc(p.image_url) + '" style="width:36px;height:36px;border-radius:4px;object-fit:cover;flex-shrink:0;" onerror="this.style.display=&quot;none&quot;">' : '<div style="width:36px;height:36px;border-radius:4px;background:rgba(' + typeRgb + ',0.1);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;">' + typeIcon + '</div>') +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:0.85rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
            (isChild ? '<span style="font-size:0.62rem;font-weight:800;color:rgb(' + typeRgb + ');background:rgba(' + typeRgb + ',0.15);border:1px solid rgba(' + typeRgb + ',0.3);padding:1px 5px;border-radius:3px;letter-spacing:0.04em;margin-right:5px;">UNIT</span>' : '') +
            esc(label) + '</div>' +
          '<div style="font-size:0.68rem;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(p.city) + ', ' + esc(p.state) + ' · ' + (p.bedrooms || 0) + 'BR/' + (p.bathrooms || 0) + 'BA' + (p.sqft ? ' · ' + p.sqft.toLocaleString() + 'sqft' : '') + '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
          actualMark +
          (net !== 0 && monthlyCost > 0 ? '<span title="' + (revIsActual ? 'Based on Guesty actuals' : 'Estimated from PriceLabs/analysis') + '" style="font-size:0.72rem;font-weight:700;color:' + netColor + ';font-family:DM Mono,monospace;' + (revIsActual ? '' : 'opacity:0.7;') + '">' + (revIsActual ? '' : '~') + (net >= 0 ? '+' : '') + '$' + Math.round(net).toLocaleString() + ' net</span>' : '') +
          trendHtml +
          healthBadge +
          (p.listing_status === 'active' ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--accent);display:inline-block;" title="Live"></span>' : p.listing_status === 'paused' ? '<span style="width:8px;height:8px;border-radius:50%;background:#f59e0b;display:inline-block;" title="Paused"></span>' : '') +
          '<button class="btn btn-xs" onclick="event.stopPropagation();openProperty(' + p.id + ')" style="padding:2px 7px;font-size:0.68rem;">✎</button>' +
        '</div>' +
      '</div>';
    }

    // ── Status variables ──
    var lsDot = p.listing_status === 'active' ? '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">● Live</span>'
      : p.listing_status === 'paused' ? '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">⏸ Paused</span>'
      : p.listing_status === 'inactive' ? '<span class="badge" style="background:rgba(239,68,68,0.12);color:var(--danger);">⏹ Off</span>'
      : '';
    var rtBadge = p.rental_type === 'ltr' ? '<span class="badge" style="background:rgba(96,165,250,0.15);color:#60a5fa;">LTR</span>' : '<span class="badge" style="background:rgba(167,139,250,0.1);color:var(--purple);">STR</span>';
    var healthGlow = '';
    if (healthBadge) {
      if (healthLabel && healthLabel.match(/ACT NOW/i)) healthGlow = ' health-glow-danger';
      else if (healthLabel && healthLabel.match(/WATCH/i)) healthGlow = ' health-glow-warn';
    }
    var healthBadgeStyled = healthBadge ? healthBadge.replace('style="', 'class="' + healthGlow + '" style="') : '';

    // ── CARD LAYOUT ──
    // ZONE 1: [thumb] Name + top-right health/status indicators
    // ZONE 2: Address + specs (compact)
    // ZONE 3: Financial grid — clear cells instead of dot-separated text

    // ── FINANCIAL GRID (structured cells for scanability) ──
    var finHtml = '';
    if (!isBuilding) {
      var actualRev = (window._actualRevenue || {})[p.id];

      if (!p.is_research) {
        var cells = [];
        var hasTm = actualRev && actualRev.this_month_payout !== undefined && actualRev.this_month_payout > 0;
        var predictedMonthly = p.analysis_monthly || (p.pl_base_price && p.pl_occ_30d ? Math.round(p.pl_base_price * 30 * parseInt(p.pl_occ_30d) / 100) : 0);

        if (hasTm) {
          // This Month payout — matches dashboard definition (money you receive)
          cells.push({label:'This Month', val:'$' + actualRev.this_month_payout.toLocaleString(), color:'var(--accent)', bold:true});
          // Actual vs Predicted
          if (predictedMonthly > 0) {
            var pctOfPredicted = Math.round(actualRev.this_month_payout / predictedMonthly * 100);
            var trackColor = pctOfPredicted >= 90 ? 'var(--accent)' : pctOfPredicted >= 60 ? '#f0b840' : 'var(--danger)';
            cells.push({label:'vs Predicted', val:pctOfPredicted + '%', sub:'of $' + predictedMonthly.toLocaleString(), color:trackColor});
          }
          // This month occupancy
          cells.push({label:'Occ', val:actualRev.this_month_occ + '%', color:actualRev.this_month_occ >= 50 ? 'var(--accent)' : actualRev.this_month_occ >= 30 ? '#f0b840' : 'var(--danger)'});
          // ADR
          cells.push({label:'ADR', val:'$' + actualRev.this_month_adr, color:'var(--text)'});
        } else if (actualRev && actualRev.monthly_avg > 0) {
          // No this-month data, show average
          cells.push({label:'Avg Revenue', val:'$' + actualRev.monthly_avg.toLocaleString(), sub:actualRev.months + 'mo avg', color:'var(--accent)'});
          cells.push({label:'ADR', val:'$' + actualRev.adr, color:'var(--text)'});
          cells.push({label:'Occ', val:actualRev.occ + '%', color:actualRev.occ >= 50 ? 'var(--accent)' : actualRev.occ >= 30 ? '#f0b840' : 'var(--danger)'});
        } else if (plMonthlyRev > 0) {
          cells.push({label:'Est Revenue', val:'~$' + plMonthlyRev.toLocaleString(), sub:'PriceLabs est', color:'var(--purple)'});
          if (p.pl_base_price) cells.push({label:'Base', val:'$' + p.pl_base_price + '/nt', color:'var(--text)'});
        } else if (predictedMonthly > 0) {
          cells.push({label:'Predicted', val:'$' + Math.round(predictedMonthly).toLocaleString() + '/mo', sub:'from analysis', color:'var(--purple)'});
        }

        // Expenses — always show if we have them
        if (monthlyCost > 0) {
          cells.push({label:'Expenses', val:'-$' + Math.round(monthlyCost).toLocaleString(), color:'var(--danger)'});
        }

        // Net — the bottom line using payout if available, else avg
        var netBase = hasTm ? actualRev.this_month_payout : (actualRev ? actualRev.monthly_avg : monthlyRev);
        if (monthlyCost > 0 && netBase > 0) {
          var netVal = netBase - monthlyCost;
          cells.push({label:'Net', val:(netVal >= 0 ? '+' : '') + '$' + Math.round(netVal).toLocaleString(), color:netVal >= 0 ? 'var(--accent)' : 'var(--danger)', bold:true});
        }

        // MoM trend if we have last month — using payout for consistency
        if (hasTm && actualRev.last_month_payout > 0) {
          var mom = Math.round((actualRev.this_month_payout - actualRev.last_month_payout) / actualRev.last_month_payout * 100);
          cells.push({label:'vs Last Mo', val:(mom >= 0 ? '+' : '') + mom + '%', color:mom >= 0 ? 'var(--accent)' : 'var(--danger)'});
        }

        if (cells.length > 0) {
          finHtml = '<div class="prop-fin" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:1px;margin-top:6px;background:var(--border);border-radius:6px;overflow:hidden;font-size:0.72rem;">';
          cells.forEach(function(c) {
            finHtml += '<div style="background:var(--surface2);padding:5px 8px;text-align:center;">';
            finHtml += '<div style="color:var(--text3);font-size:0.66rem;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:1px;">' + c.label + '</div>';
            finHtml += '<div style="font-family:DM Mono,monospace;font-weight:' + (c.bold ? '800' : '600') + ';color:' + c.color + ';font-size:' + (c.bold ? '0.82rem' : '0.76rem') + ';">' + c.val + '</div>';
            if (c.sub) finHtml += '<div style="font-size:0.56rem;color:var(--text3);">' + c.sub + '</div>';
            finHtml += '</div>';
          });
          finHtml += '</div>';

          // ── Data source hint + actionable next step ──
          var hintParts = [];
          var hintActions = [];

          if (hasTm) {
            hintParts.push(_ico('check', 10, 'var(--accent)') + ' Guesty actuals');
            if (!predictedMonthly) hintActions.push('<a href="#" onclick="event.stopPropagation();openProperty(' + p.id + ',\'pricing\')" style="color:var(--purple);text-decoration:none;">Run analysis</a> for vs-predicted');
            if (!actualRev.last_month_payout) hintActions.push('Last month data pending');
          } else if (actualRev && actualRev.monthly_avg > 0) {
            hintParts.push(_ico('barChart', 10, 'var(--text3)') + ' ' + actualRev.months + '-month avg from Guesty');
            hintActions.push('No bookings this month yet');
          } else if (plMonthlyRev > 0) {
            hintParts.push(_ico('barChart', 10, 'var(--purple)') + ' PriceLabs estimate');
            hintActions.push('<a href="#" onclick="event.stopPropagation();switchView(\'pms\')" style="color:var(--accent);text-decoration:none;">Sync Guesty</a> for real revenue');
          } else if (predictedMonthly > 0) {
            hintParts.push(_ico('sparkle', 10, 'var(--purple)') + ' AI projection');
            hintActions.push('<a href="#" onclick="event.stopPropagation();switchView(\'pms\')" style="color:var(--accent);text-decoration:none;">Link Guesty</a> for actuals');
          }

          if (!monthlyCost && (hasTm || (actualRev && actualRev.monthly_avg > 0))) {
            hintActions.push('<a href="#" onclick="event.stopPropagation();openProperty(' + p.id + ',\'details\')" style="color:#f0b840;text-decoration:none;">Add expenses</a> for net calc');
          }
          if (!p.analysis_nightly_rate && !p.pl_base_price) {
            hintActions.push('<a href="#" onclick="event.stopPropagation();openProperty(' + p.id + ',\'pricing\')" style="color:var(--purple);text-decoration:none;">Run price analysis</a>');
          }

          if (hintParts.length > 0 || hintActions.length > 0) {
            finHtml += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px;padding:0 2px;font-size:0.6rem;color:var(--text3);gap:8px;">';
            if (hintParts.length > 0) finHtml += '<span style="display:flex;align-items:center;gap:3px;">' + hintParts.join('') + '</span>';
            if (hintActions.length > 0) finHtml += '<span>' + hintActions.join(' · ') + '</span>';
            finHtml += '</div>';
          }
        } else if (!p.is_research) {
          // No financial data at all — show setup hints
          var setupHints = [];
          if (!actualRev) setupHints.push('<a href="#" onclick="event.stopPropagation();switchView(\'pms\')" style="color:var(--accent);text-decoration:none;">Link Guesty</a>');
          if (!p.pl_base_price) setupHints.push('<a href="#" onclick="event.stopPropagation();switchView(\'pms\')" style="color:var(--purple);text-decoration:none;">Sync PriceLabs</a>');
          if (!p.analysis_nightly_rate) setupHints.push('<a href="#" onclick="event.stopPropagation();openProperty(' + p.id + ',\'pricing\')" style="color:var(--purple);text-decoration:none;">Run analysis</a>');
          if (setupHints.length > 0) {
            finHtml = '<div style="margin-top:5px;padding:4px 8px;font-size:0.6rem;color:var(--text3);display:flex;align-items:center;gap:4px;">' + _ico('info', 10, 'var(--text3)') + ' No revenue data — ' + setupHints.join(' · ') + '</div>';
          }
        }
      } else {
        // Research — simplified
        var resRev = analysisMonthly || monthlyRev;
        var resNet = resRev - monthlyCost;
        if (resRev > 0) {
          var verdict = resNet > 500 ? _ico('check',13,'var(--accent)') : resNet > 0 ? '' + _ico('alertCircle', 13, '#f59e0b') + '' : _ico('x',13,'var(--danger)');
          finHtml = '<div class="prop-fin" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:1px;margin-top:6px;background:rgba(167,139,250,0.2);border-radius:6px;overflow:hidden;font-size:0.72rem;">';
          finHtml += '<div style="background:rgba(167,139,250,0.06);padding:5px 8px;text-align:center;"><div style="color:var(--text3);font-size:0.66rem;text-transform:uppercase;">Projected</div><div style="font-family:DM Mono,monospace;font-weight:700;color:var(--purple);">$' + Math.round(resRev).toLocaleString() + '/mo</div></div>';
          if (p.analysis_nightly_rate) finHtml += '<div style="background:rgba(167,139,250,0.06);padding:5px 8px;text-align:center;"><div style="color:var(--text3);font-size:0.66rem;text-transform:uppercase;">Rate</div><div style="font-family:DM Mono,monospace;font-weight:600;color:var(--text);">$' + p.analysis_nightly_rate + '/nt</div></div>';
          if (p.analysis_occ) finHtml += '<div style="background:rgba(167,139,250,0.06);padding:5px 8px;text-align:center;"><div style="color:var(--text3);font-size:0.66rem;text-transform:uppercase;">Occ</div><div style="font-family:DM Mono,monospace;font-weight:600;color:var(--text);">' + Math.round(p.analysis_occ * 100) + '%</div></div>';
          if (monthlyCost > 0) finHtml += '<div style="background:rgba(167,139,250,0.06);padding:5px 8px;text-align:center;"><div style="color:var(--text3);font-size:0.66rem;text-transform:uppercase;">Verdict</div><div style="font-family:DM Mono,monospace;font-weight:800;color:' + (resNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + verdict + ' ' + (resNet >= 0 ? '+' : '') + '$' + Math.round(resNet).toLocaleString() + '</div></div>';
          finHtml += '</div>';
        } else {
          finHtml = '<div style="margin-top:6px;padding:5px 10px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:6px;font-size:0.72rem;color:var(--text3);">' + _ico('search', 13) + ' Run analysis to see projections</div>';
        }
      }
    }

    // ── STATUS BADGES — only the truly important ones ──
    // Health + trend are the most glanceable, shown prominently next to the name
    // Secondary info (STR/LTR, strategy count, last analyzed) goes in the meta line
    var topRightBadges = '';
    if (healthBadgeStyled) topRightBadges += healthBadgeStyled;
    if (trendHtml) topRightBadges += trendHtml;
    if (lsDot) topRightBadges += lsDot;

    // Secondary badges — in the meta line, not floating
    var metaBadges = typeBadge + ownerBadge;
    metaBadges += rtBadge;
    if (p.strategy_count > 0) metaBadges += '<span class="badge">' + p.strategy_count + ' strat</span>';
    if (p.last_analyzed) metaBadges += '<span class="badge" style="background:rgba(96,165,250,0.12);color:rgba(96,165,250,0.9);font-size:0.62rem;">' + _ico('search', 13) + ' ' + p.last_analyzed.substring(0, 10) + '</span>';
    else if (!p.is_research) metaBadges += '<span class="badge" style="background:rgba(239,68,68,0.1);color:var(--danger);font-size:0.62rem;">' + _ico('alertCircle', 13, '#f59e0b') + ' Not analyzed</span>';
    if (p.is_managed || p.ownership_type === 'managed') metaBadges += '<span class="badge" style="background:rgba(96,165,250,0.15);color:#60a5fa;">' + _ico('handshake', 13) + ' Managed</span>';

    // Performance badge: ADR vs market
    if (!isBuilding && !p.is_research) {
      var mktKey = ((p.city || '') + ',' + (p.state || '')).toLowerCase();
      var mktD = (window._marketProfiles || {})[mktKey];
      var myAdr = actualData ? actualData.adr : (p.analysis_nightly_rate || (p.pl_base_price ? parseInt(p.pl_base_price) : 0));
      if (mktD && mktD.avg_adr > 0 && myAdr > 0) {
        var adrDiffPct = Math.round((myAdr - mktD.avg_adr) / mktD.avg_adr * 100);
        var bColor = adrDiffPct >= 5 ? 'var(--accent)' : adrDiffPct >= -5 ? '#60a5fa' : 'var(--danger)';
        var bBg = adrDiffPct >= 5 ? 'rgba(16,185,129,0.1)' : adrDiffPct >= -5 ? 'rgba(96,165,250,0.1)' : 'rgba(239,68,68,0.1)';
        var bLabel = adrDiffPct >= 5 ? '↑' : adrDiffPct >= -5 ? '≈' : '↓';
        metaBadges += '<span class="badge" style="background:' + bBg + ';color:' + bColor + ';font-size:0.62rem;" title="Your ADR $' + myAdr + ' vs market avg $' + Math.round(mktD.avg_adr) + '">' + bLabel + ' $' + myAdr + ' vs $' + Math.round(mktD.avg_adr) + ' mkt</span>';
      }
      // Occupancy vs market badge
      var myOcc = p.pl_occ_30d ? parseInt(String(p.pl_occ_30d).replace('%', '')) : (p.pl_occ_30 ? parseInt(String(p.pl_occ_30).replace('%', '')) : (actualData ? Math.round((actualData.occupancy || 0) * 100) : 0));
      var mktOcc = p.pl_mkt_occ_30d ? parseInt(String(p.pl_mkt_occ_30d).replace('%', '')) : (p.pl_mkt_occ_30 ? parseInt(String(p.pl_mkt_occ_30).replace('%', '')) : (mktD && mktD.avg_occ ? Math.round(mktD.avg_occ * 100) : 0));
      if (myOcc > 0 && mktOcc > 0) {
        var occGap = myOcc - mktOcc;
        var oColor = occGap >= 5 ? 'var(--accent)' : occGap >= -5 ? '#60a5fa' : 'var(--danger)';
        var oBg = occGap >= 5 ? 'rgba(16,185,129,0.1)' : occGap >= -5 ? 'rgba(96,165,250,0.1)' : 'rgba(239,68,68,0.1)';
        var oLabel = occGap >= 5 ? '↑' : occGap >= -5 ? '≈' : '↓';
        metaBadges += '<span class="badge" style="background:' + oBg + ';color:' + oColor + ';font-size:0.62rem;" title="Your occ ' + myOcc + '% vs market ' + mktOcc + '%">' + oLabel + ' ' + myOcc + '% vs ' + mktOcc + '% occ</span>';
      }
    }

    return '<div class="property-card" style="position:relative;border-left:' + borderLeft + ';' + indent + buildingStyle + standaloneAccent + '">' +
      // Edit/Delete — pinned far right
      '<div style="position:absolute;top:10px;right:10px;display:flex;gap:4px;z-index:2;">' +
        '<button class="btn btn-xs" onclick="event.stopPropagation();openProperty(' + p.id + ')" title="Edit" style="padding:2px 8px;">✎</button>' +
        '<button class="btn btn-xs btn-danger" onclick="event.stopPropagation();deleteOneProp(' + p.id + ')" title="Delete" style="padding:2px 8px;">✕</button>' +
      '</div>' +
      // Bulk select
      '<label class="prop-select" onclick="event.stopPropagation()" style="position:absolute;top:12px;left:12px;display:' + (bulkMode ? 'block' : 'none') + ';"><input type="checkbox" onchange="togglePropSelect(' + p.id + ')"' + checked + '></label>' +
      // Card content
      '<div style="cursor:pointer;margin-left:' + (bulkMode ? '28' : '0') + 'px;padding-right:70px;" onclick="openProperty(' + p.id + ')">' +
        // ── ZONE 1: Identity row — thumbnail + name + top-right indicators ──
        '<div style="display:flex;align-items:center;gap:10px;">' +
          thumb +
          '<div style="flex:1;min-width:0;">' +
            '<div style="display:flex;align-items:center;gap:8px;">' +
              '<h3 style="font-size:0.92rem;font-weight:700;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">' + (isBuilding ? '' + _ico('building', 13) + ' ' : '') + (isChild ? '<span style="color:rgb(' + typeRgb + ');">' + esc(p.name || label) + '</span>' : esc(p.name || label)) + ' ' + unitBadge + '</h3>' +
              (topRightBadges ? '<div style="display:flex;gap:4px;flex-shrink:0;">' + topRightBadges + '</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
        // ── ZONE 2: Address + specs + secondary badges ──
        '<div style="margin-top:3px;' + (thumb ? 'margin-left:72px;' : '') + '">' +
          '<p style="font-size:0.7rem;color:var(--text3);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mapLink(p.address, p.city, p.state, p.zip) + (p.unit_number ? ' #' + esc(p.unit_number) : '') + ' · ' + esc(p.city) + ', ' + esc(p.state) + (p.zip ? ' ' + esc(p.zip) : '') + ' ' + coordHtml +
            (p.zillow_url ? ' · <a href="' + esc(p.zillow_url) + '" target="_blank" onclick="event.stopPropagation();" style="color:var(--text3);text-decoration:none;">' + _ico('home', 13) + '</a>' : '') +
          '</p>' +
          '<div class="meta" style="margin-top:3px;">' + metaBadges +
            '<span>' + (p.bedrooms || 0) + 'BR/' + (p.bathrooms || 0) + 'BA</span>' +
            (p.sqft ? '<span>' + p.sqft.toLocaleString() + 'sf</span>' : '') +
            (p.estimated_value ? '<span>$' + p.estimated_value.toLocaleString() + '</span>' : '') +
            childBadge +
          '</div>' +
        '</div>' +
        // ── ZONE 3: Financial grid ──
        (finHtml ? '<div style="' + (thumb ? 'margin-left:72px;' : '') + '">' + finHtml + '</div>' : '') +
      '</div>' +
    '</div>';
}

function sortProperties() {
  propSortKey = document.getElementById('propSort').value;
  renderProperties();
}

function togglePropSelect(id) {
  if (selectedProps.has(id)) selectedProps.delete(id); else selectedProps.add(id);
  updateBulkCount();
}

function toggleSelectAll(checked) {
  if (checked) { properties.forEach(function(p) { selectedProps.add(p.id); }); }
  else { selectedProps.clear(); }
  renderProperties();
}

async function loadSavedStrategies(propId) {
  var resultsEl = document.getElementById('priceAnalysisResults');
  var lastRunEl = document.getElementById('pricingLastRun');
  if (!resultsEl) return;
  // Only skip reload if we JUST ran an analysis this session (fresh results on screen)
  // Check for a data-fresh attribute set by the live analysis runner
  if (resultsEl.getAttribute('data-fresh') === 'true') { resultsEl.removeAttribute('data-fresh'); return; }
  try {
    var d = await api('/api/properties/' + propId);
    var strats = d.strategies || [];
    if (strats.length === 0) {
      if (lastRunEl) lastRunEl.innerHTML = '\u26a0\ufe0f No analysis run yet \u2014 click \ud83d\udd0d Run Price Analysis';
      return;
    }
    var runs = {};
    strats.forEach(function(s) {
      var runKey = (s.created_at || '').substring(0, 19); // group by second, not minute
      if (!runs[runKey]) runs[runKey] = [];
      runs[runKey].push(s);
    });
    var runKeys = Object.keys(runs).sort().reverse();
    if (lastRunEl && runKeys.length > 0) {
      var dt = fmtUTC(runKeys[0]);
      var ago = Math.round((Date.now() - new Date(runKeys[0]).getTime()) / 86400000);
      var agoText = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago + ' days ago';
      lastRunEl.innerHTML = 'Last analysis: <strong>' + dt + '</strong> (' + agoText + ') \u00b7 ' + runKeys.length + ' runs saved';
    }
    var h = '';
    var latestStrats = runs[runKeys[0]] || [];
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:8px;">LATEST ANALYSIS \u2014 ' + fmtUTC(runKeys[0]) + '</div>';
    latestStrats.forEach(function(s) { h += renderStrategyCard(s); });
    if (runKeys.length > 1) {
      var historyRuns = runKeys.slice(1, 5);
      h += '<details style="margin-top:14px;"><summary style="cursor:pointer;font-size:0.78rem;font-weight:600;color:var(--text2);padding:6px 0;">\ud83d\udcdc Previous Analyses (' + historyRuns.length + ' older)</summary>';
      historyRuns.forEach(function(rk) {
        var rStrats = runs[rk] || [];
        h += '<div style="margin-top:10px;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;opacity:0.8;">';
        h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:6px;">' + fmtUTC(rk) + ' \u00b7 ' + rStrats.length + ' strategies</div>';
        rStrats.forEach(function(s) {
          h += '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.75rem;border-bottom:1px solid var(--border);">';
          h += '<span>' + (s.ai_generated ? '\ud83e\udd16' : '\ud83d\udcca') + ' ' + esc(s.strategy_name || 'Strategy') + '</span>';
          h += '<span style="font-family:DM Mono,monospace;">$' + (s.base_nightly_rate || 0) + '/nt \u00b7 ' + Math.round((s.projected_occupancy || 0) * 100) + '% \u00b7 $' + Math.round(s.projected_monthly_avg || 0).toLocaleString() + '/mo</span>';
          h += '</div>';
        });
        h += '</div>';
      });
      h += '</details>';
    }
    resultsEl.innerHTML = h;
  } catch {}
}

function renderStrategyCard(s, fullReasoning) {
  var isAI = s.ai_generated;
  var isLTR = s.min_nights >= 365 || (s.strategy_name || '').includes('LTR');
  var bc = isAI ? 'var(--purple)' : 'var(--accent)';
  var provLabel = ({anthropic:'Claude',openai:'GPT-4o',workers_ai:'Workers AI (fallback)'})[s.ai_provider] || (isAI ? 'AI' : 'Algorithmic');
  var uid = 'sc_' + Math.random().toString(36).substring(2,8);

  var h = '<div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-left:4px solid ' + bc + ';border-radius:8px;margin-bottom:8px;">';

  // Header
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
  h += '<div><strong style="font-size:0.85rem;">' + esc(s.strategy_name || 'Strategy') + '</strong>';
  h += ' <span style="font-size:0.6rem;background:rgba(' + (isAI ? '167,139,250' : '16,185,129') + ',0.15);color:' + bc + ';padding:1px 6px;border-radius:3px;">' + (isAI ? _ico('sparkle', 11) : _ico('barChart', 11)) + ' ' + esc(provLabel) + '</span>';
  if (isLTR) h += ' <span style="font-size:0.6rem;background:rgba(59,130,246,0.15);color:#60a5fa;padding:1px 6px;border-radius:3px;">LTR</span>';
  h += '</div>';
  h += '<span style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:var(--accent);">$' + Math.round(s.projected_monthly_avg || 0).toLocaleString() + '/mo</span>';
  h += '</div>';

  // Numbers grid
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;margin-bottom:8px;">';
  if (isLTR) {
    h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.base_nightly_rate || 0).toLocaleString() + '</div><div style="font-size:0.65rem;color:var(--text3);">Monthly Rent</div></div>';
  } else {
    h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.base_nightly_rate || 0) + '</div><div style="font-size:0.65rem;color:var(--text3);">Base /nt</div></div>';
    if (s.weekend_rate) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + s.weekend_rate + '</div><div style="font-size:0.65rem;color:var(--text3);">Weekend</div></div>';
    h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.cleaning_fee || 0) + '</div><div style="font-size:0.65rem;color:var(--text3);">Cleaning</div></div>';
  }
  h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">' + Math.round((s.projected_occupancy || 0) * 100) + '%</div><div style="font-size:0.65rem;color:var(--text3);">Occupancy</div></div>';
  if (s.peak_season_markup) { var peakRate = Math.round((s.base_nightly_rate || 0) * (1 + (s.peak_season_markup || 0) / 100)); h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;color:var(--accent);">+' + s.peak_season_markup + '%</div><div style="font-size:0.65rem;color:var(--text3);">Peak → $' + peakRate + '/nt</div></div>'; }
  if (s.low_season_discount) { var lowRate = Math.round((s.base_nightly_rate || 0) * (1 - (s.low_season_discount || 0) / 100)); h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;color:var(--danger);">-' + s.low_season_discount + '%</div><div style="font-size:0.65rem;color:var(--text3);">Low → $' + lowRate + '/nt</div></div>'; }
  h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + Math.round(s.projected_annual_revenue || 0).toLocaleString() + '</div><div style="font-size:0.65rem;color:var(--text3);">Annual</div></div>';
  h += '</div>';

  // ── HOW WE CALCULATED THIS — always visible, collapsible ──
  var calcLines = [];

  // Rate source (algorithmic has it in reasoning, AI we extract from analysis)
  var reasonText = s.reasoning || '';
  if (!isAI && reasonText) {
    // Algorithmic: reasoning IS the source note — parse out the key data points
    var rateMatch = reasonText.match(/PriceLabs\s+(?:base|recommended)\s+price\s+\$(\d+)/i)
      || reasonText.match(/(\d+)\s+STR comps\s+\(median\s+\$(\d+)/i)
      || reasonText.match(/Derived from\s+\$(\d+)\/mo/i);
    var occMatch = reasonText.match(/Occupancy:\s+(.+?)\./);
    var cleanMatch = reasonText.match(/Cleaning fee:\s+(.+?)\./);

    calcLines.push({ label: 'Base rate source', val: rateMatch ? reasonText.split('.')[0].replace(/^.*(PriceLabs|STR comps|Derived)/,'$1').trim() : reasonText.split('.')[0] });
    if (occMatch) calcLines.push({ label: 'Occupancy source', val: occMatch[1] });
    if (cleanMatch) calcLines.push({ label: 'Cleaning source', val: cleanMatch[1] });

    // Show revenue math
    var nights = Math.round((s.projected_occupancy || 0) * 365);
    var turnovers = s.cleaning_fee > 0 ? Math.round(nights / 3.5) : 0;
    var rateRevenue = Math.round((s.base_nightly_rate || 0) * nights);
    var cleanRevenue = turnovers * (s.cleaning_fee || 0);
    calcLines.push({ label: 'Revenue math', val: '$' + (s.base_nightly_rate || 0) + '/nt × ' + nights + ' nights/yr (' + Math.round((s.projected_occupancy||0)*100) + '% occ) = $' + rateRevenue.toLocaleString() + (cleanRevenue > 0 ? ' + $' + cleanRevenue.toLocaleString() + ' cleaning = $' + (rateRevenue + cleanRevenue).toLocaleString() + '/yr' : '') });
  } else if (isAI) {
    calcLines.push({ label: 'Generated by', val: provLabel + ' — see full analysis below' });
    if (s.min_price || s.max_price) calcLines.push({ label: 'PriceLabs guardrails', val: (s.min_price ? 'Min $' + s.min_price : '') + (s.max_price ? '  Max $' + s.max_price : '') });
    if (s.breakeven_rate) calcLines.push({ label: 'Breakeven rate', val: '$' + s.breakeven_rate + '/nt needed to cover expenses' });
    var nights2 = Math.round((s.projected_occupancy || 0) * 365);
    calcLines.push({ label: 'Revenue math', val: '$' + (s.base_nightly_rate || 0) + '/nt base × ' + nights2 + ' nights/yr (' + Math.round((s.projected_occupancy||0)*100) + '% occ) → $' + Math.round(s.projected_annual_revenue || 0).toLocaleString() + '/yr' });
  }

  if (calcLines.length > 0) {
    h += '<div style="margin-top:6px;padding:8px 10px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);">';
    h += '<div style="font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--text3);margin-bottom:6px;">' + _ico('target', 13) + ' How we got these numbers</div>';
    calcLines.forEach(function(cl) {
      h += '<div style="display:flex;gap:8px;font-size:0.72rem;margin-bottom:3px;line-height:1.4;">';
      h += '<span style="color:var(--text3);flex-shrink:0;min-width:120px;">' + esc(cl.label) + '</span>';
      h += '<span style="color:var(--text2);">' + esc(cl.val) + '</span>';
      h += '</div>';
    });
    if (s.recommendations && s.recommendations.length > 0) {
      h += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border);">';
      h += '<div style="font-size:0.65rem;font-weight:600;color:var(--text3);margin-bottom:4px;">KEY ACTIONS</div>';
      s.recommendations.slice(0,3).forEach(function(r) {
        h += '<div style="font-size:0.72rem;color:var(--text2);margin-bottom:2px;">• ' + esc(r) + '</div>';
      });
      h += '</div>';
    }
    h += '</div>';
  }

  // Full analysis text — always expandable, shown by default for fresh results
  var fullText = s.analysis || s.reasoning || '';
  // Detect raw JSON and extract the analysis text
  if (typeof fullText === 'string' && fullText.trim().charAt(0) === '{') {
    try {
      var parsed = JSON.parse(fullText);
      fullText = parsed.analysis || parsed.strategy_summary || parsed.reasoning || '';
      if (!s.recommendations && parsed.recommendations) s.recommendations = parsed.recommendations;
      if (!s.cleaning_fee_reasoning && parsed.cleaning_fee_reasoning) s.cleaning_fee_reasoning = parsed.cleaning_fee_reasoning;
    } catch(e) {
      var am = fullText.match(/"analysis"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (am) fullText = am[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      else fullText = fullText.substring(0, 500) + '...';
    }
  }
  if (fullText) {
    if (fullReasoning || fullText.length <= 400) {
      h += '<div style="font-size:0.78rem;color:var(--text2);line-height:1.5;margin-top:8px;">';
      fullText.split(/\n\n|\n/).forEach(function(para) { if (para.trim()) h += '<p style="margin:0 0 6px 0;">' + esc(para.trim()) + '</p>'; });
      h += '</div>';
    } else {
      h += '<div style="margin-top:6px;">';
      h += '<a href="#" onclick="event.preventDefault();toggleCollapsible(\'' + uid + 'f\',null,this,\'▸ Show full analysis\',\'▾ Hide analysis\')" style="font-size:0.72rem;color:var(--purple);">▸ Show full analysis</a>';
      h += '<div id="' + uid + 'f" style="display:none;font-size:0.78rem;color:var(--text2);line-height:1.5;margin-top:6px;">';
      fullText.split(/\n\n|\n/).forEach(function(para) { if (para.trim()) h += '<p style="margin:0 0 6px 0;">' + esc(para.trim()) + '</p>'; });
      h += '</div></div>';
    }
  }

  h += '</div>';
  return h;
}


function buildMonthlyTargets(p, actuals, seasonality, monthlyExpense, currentADR, currentOcc) {
  if (!p) return [];
  var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  var now = new Date();
  var currentYear = now.getFullYear();
  var currentMonthNum = now.getMonth() + 1;

  // ── Seasonality multipliers ──
  var seasonMult = {};
  var seasonOcc = {};
  var seasonADR = {};
  var multSum = 0;
  (seasonality || []).forEach(function(s) {
    seasonMult[s.month_number] = s.multiplier || 1.0;
    multSum += (s.multiplier || 1.0);
    if (s.avg_occupancy > 0) seasonOcc[s.month_number] = s.avg_occupancy;
    if (s.avg_adr > 0) seasonADR[s.month_number] = s.avg_adr;
  });
  if (multSum === 0) { for (var i = 1; i <= 12; i++) { seasonMult[i] = 1.0; } multSum = 12; }
  var hasSeasonality = Object.keys(seasonMult).length >= 6;

  // ── Actual history ──
  var histByMonth = {};
  var histByPropMonth = {};
  var currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  (actuals || []).forEach(function(a) {
    var mn = parseInt(a.month.substring(5));
    var yr = parseInt(a.month.substring(0, 4));
    // For historical averages: exclude current month (partial data skews averages)
    if (a.month < currentMonth) {
      if (!histByMonth[mn]) histByMonth[mn] = { revs: [], occs: [], adrs: [] };
      histByMonth[mn].revs.push(a.total_revenue || 0);
      histByMonth[mn].occs.push(a.occupancy_pct || 0);
      if (a.avg_nightly_rate > 0) histByMonth[mn].adrs.push(a.avg_nightly_rate);
    }
    // For actuals column: store per year-month (include current month — partial is better than $0)
    histByPropMonth[yr + '-' + mn] = { rev: a.total_revenue || 0, occ: a.occupancy_pct || 0, adr: a.avg_nightly_rate || 0 };
  });
  var hasActuals = Object.keys(histByMonth).length >= 3;

  // ── Best available ADR (market-informed, not cost-derived) ──
  // Priority: 1) PriceLabs blended, 2) last pricing analysis, 3) market seasonality avg ADR, 4) zero (show gap clearly)
  var baseADR = currentADR || 0;
  var adrSource = currentADR > 0 ? (p.pl_base_price > 0 ? 'PriceLabs' : 'Pricing analysis') : '';

  // If we have market ADR from seasonality, use it as sanity check / fallback
  var marketADRs = Object.values(seasonADR);
  var marketAvgADR = marketADRs.length > 0 ? marketADRs.reduce(function(a, b) { return a + b; }, 0) / marketADRs.length : 0;

  // ── Cost floor ── (the minimum the property MUST earn to break even + margin)
  var annualCost = monthlyExpense * 12;
  var costFloorAnnual = annualCost * 1.15; // 15% margin minimum

  // ── Market-based revenue target ──
  // Use best ADR × seasonal occupancy × days — this is what the market will actually support
  // If no ADR data at all, fall back to cost floor
  var annualMarketTarget = 0;
  if (baseADR > 0) {
    for (var mn2 = 1; mn2 <= 12; mn2++) {
      var occ2 = seasonOcc[mn2] || currentOcc || 0.4;
      // Scale occupancy by seasonality if we have it
      if (!seasonOcc[mn2] && hasSeasonality && currentOcc > 0) {
        var avgMult = multSum / 12;
        occ2 = Math.max(0.15, Math.min(0.95, currentOcc * (seasonMult[mn2] / avgMult)));
      }
      annualMarketTarget += Math.round(baseADR * daysInMonth[mn2 - 1] * occ2);
    }
  }

  // ── Final annual target: higher of cost floor or market estimate ──
  // If market target < cost floor, property may be underpriced or in a tough market
  var annualTarget = 0;
  var targetBasis = '';
  if (annualMarketTarget > 0 && costFloorAnnual > 0) {
    if (annualMarketTarget >= costFloorAnnual) {
      annualTarget = annualMarketTarget;
      targetBasis = 'market estimate';
    } else {
      // Market estimate is below cost floor — use cost floor but flag the shortfall
      annualTarget = costFloorAnnual;
      targetBasis = 'cost floor (market estimate $' + Math.round(annualMarketTarget / 12).toLocaleString() + '/mo falls short of expenses)';
    }
  } else if (costFloorAnnual > 0) {
    annualTarget = costFloorAnnual;
    targetBasis = monthlyExpense > 0 ? 'cost floor (no rate data yet — run Price Analysis to get market-based targets)' : 'no expense data';
  } else if (annualMarketTarget > 0) {
    annualTarget = annualMarketTarget;
    targetBasis = 'market estimate (no expense data)';
  } else {
    // Nothing to work with
    return [];
  }

  var targets = [];
  for (var mn = 1; mn <= 12; mn++) {
    var mult = seasonMult[mn] || 1.0;

    // Monthly target: distribute annual by season weight
    var monthTarget = annualTarget * mult / multSum;
    // Hard floor: never below that month's actual expenses
    monthTarget = Math.max(monthTarget, monthlyExpense);

    // ── Occupancy for this month ──
    // Priority: 1) actual history same month, 2) market seasonality, 3) scale current by season, 4) default
    var expectedOcc = 0.40;
    var occSource2 = 'default 40%';
    var lastYearData = histByPropMonth[(currentYear - 1) + '-' + mn];
    var monthHistory = histByMonth[mn];

    if (lastYearData && lastYearData.occ > 0) {
      expectedOcc = lastYearData.occ;
      occSource2 = 'last year actual';
    } else if (monthHistory && monthHistory.occs.length >= 2) {
      expectedOcc = monthHistory.occs.reduce(function(a, b) { return a + b; }, 0) / monthHistory.occs.length;
      occSource2 = 'historical avg';
    } else if (seasonOcc[mn] > 0) {
      expectedOcc = seasonOcc[mn];
      occSource2 = 'market avg';
    } else if (currentOcc > 0 && hasSeasonality) {
      var avgMult2 = multSum / 12;
      expectedOcc = Math.max(0.15, Math.min(0.95, currentOcc * (mult / avgMult2)));
      occSource2 = 'scaled from current';
    } else if (currentOcc > 0) {
      expectedOcc = currentOcc;
      occSource2 = 'current estimate';
    }
    expectedOcc = Math.max(0.15, Math.min(0.95, expectedOcc));

    // ── ADR for this month ──
    // Scale base ADR by seasonality multiplier if available
    var monthADR = baseADR;
    if (baseADR > 0 && hasSeasonality) {
      var avgMult3 = multSum / 12;
      monthADR = Math.round(baseADR * (mult / avgMult3));
    }
    // Override with actual historical ADR for this month if available and we have enough data
    if (monthHistory && monthHistory.adrs.length >= 2) {
      var histADR = monthHistory.adrs.reduce(function(a, b) { return a + b; }, 0) / monthHistory.adrs.length;
      // Blend: 60% actual history, 40% current rate estimate (so target responds to rate changes)
      monthADR = Math.round(histADR * 0.6 + (monthADR || histADR) * 0.4);
    }

    // ── Required ADR to hit target ──
    var days = daysInMonth[mn - 1];
    var requiredADR = expectedOcc > 0 ? Math.round(monthTarget / (days * expectedOcc)) : 0;

    // Gap: positive = you need to charge MORE than current estimated ADR
    var currentRate = monthADR || baseADR || 0;
    var gap = requiredADR - currentRate;

    // Actual revenue for this month (current year)
    var thisYearData = histByPropMonth[currentYear + '-' + mn];
    var actualRev = thisYearData ? thisYearData.rev : 0;

    // For current month: also check _actualRevenue which may have fresher data
    if (mn === currentMonthNum && actualRev === 0) {
      var arData = (window._actualRevenue || {})[p.id];
      if (arData && arData.this_month_rev > 0) {
        actualRev = arData.this_month_rev;
      }
    }

    // Flag if this month is partial (current month)
    var isCurrentMonth = mn === currentMonthNum && thisYearData;

    targets.push({
      monthNum: mn,
      monthName: monthNames[mn - 1],
      year: currentYear,
      target: Math.round(monthTarget),
      expectedOcc: Math.round(expectedOcc * 100),
      requiredADR: requiredADR,
      currentRate: currentRate,
      gap: gap,
      actual: actualRev,
      seasonMult: mult,
      isCurrentMonth: isCurrentMonth,
      occSource: occSource2,
    });
  }

  // Attach metadata for the UI to display
  targets._meta = {
    targetBasis: targetBasis,
    annualTarget: Math.round(annualTarget),
    costFloor: Math.round(costFloorAnnual),
    marketEstimate: Math.round(annualMarketTarget),
    hasSeasonality: hasSeasonality,
    hasActuals: hasActuals,
    adrSource: adrSource,
    baseADR: baseADR,
  };
  return targets;
}

function loadHtml2Canvas() {
  return new Promise(function(resolve, reject) {
    if (window.html2canvas) { resolve(window.html2canvas); return; }
    var s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
    s.onload = function() { resolve(window.html2canvas); };
    s.onerror = function() { reject(new Error('Failed to load html2canvas')); };
    document.head.appendChild(s);
  });
}

async function downloadFinanceScreenshot(mode) {
  var isPortfolio = mode === 'portfolio';
  var content = isPortfolio
    ? document.getElementById('view-finances')
    : document.getElementById('propFinanceContent');
  if (!content || !content.innerHTML) { toast('No finance data to capture', 'error'); return; }

  toast('Capturing screenshot...');
  try {
    var h2c = await loadHtml2Canvas();
    var canvas = await h2c(content, {
      backgroundColor: '#0f1117',
      scale: 2,
      useCORS: true,
      logging: false,
      windowWidth: 900,
    });

    // Add header to the canvas
    var editId = (document.getElementById('f_editId') || {}).value;
    var propName = '';
    if (!isPortfolio && editId) {
      var p = properties.find(function(x) { return x.id == editId; });
      propName = p ? (p.name || p.address || '') + (p.unit_number ? ' #' + p.unit_number : '') : '';
    }
    var title = isPortfolio ? 'Portfolio Finances' : propName;
    var date = new Date().toLocaleDateString();

    // Create final canvas with header
    var finalCanvas = document.createElement('canvas');
    var headerH = 60 * 2; // scale 2x
    finalCanvas.width = canvas.width;
    finalCanvas.height = canvas.height + headerH;
    var ctx = finalCanvas.getContext('2d');
    // Header background
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);
    ctx.fillStyle = '#141721';
    ctx.fillRect(0, 0, finalCanvas.width, headerH);
    // Header text
    ctx.fillStyle = '#e2e8f0';
    ctx.font = 'bold 28px -apple-system, sans-serif';
    ctx.fillText(title, 32, 44);
    ctx.fillStyle = '#6b7280';
    ctx.font = '20px -apple-system, sans-serif';
    ctx.fillText('FCP-PMR · ' + date, 32, 80);
    // Draw content below header
    ctx.drawImage(canvas, 0, headerH);

    // Download
    var link = document.createElement('a');
    var fileName = (isPortfolio ? 'portfolio-finances' : (propName || 'property-finance').toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '-' + new Date().toISOString().split('T')[0] + '.png';
    link.download = fileName;
    link.href = finalCanvas.toDataURL('image/png');
    link.click();
    toast('Screenshot saved: ' + fileName);
  } catch (err) {
    toast('Screenshot failed: ' + err.message, 'error');
  }
}

function downloadFinanceReport(mode) {
  var isPortfolio = mode.startsWith('portfolio');
  var content = isPortfolio
    ? document.getElementById('view-finances')
    : document.getElementById('propFinanceContent');
  if (!content) { toast('No finance data to export', 'error'); return; }

  var editId = (document.getElementById('f_editId') || {}).value;
  var propName = '';
  if (!isPortfolio && editId) {
    var p = properties.find(function(x) { return x.id == editId; });
    propName = p ? (p.name || p.address || '') + (p.unit_number ? ' #' + p.unit_number : '') : '';
  }
  var title = isPortfolio ? 'Portfolio Financial Report' : 'Financial Report — ' + propName;
  var date = new Date().toLocaleDateString();

  var printWindow = window.open('', '_blank');
  printWindow.document.write('<!DOCTYPE html><html><head><title>' + title + '</title>');
  printWindow.document.write('<style>');
  printWindow.document.write('* { box-sizing: border-box; margin: 0; padding: 0; }');
  printWindow.document.write('body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1a1a1a; padding: 24px; max-width: 900px; margin: 0 auto; font-size: 12px; line-height: 1.5; }');
  printWindow.document.write('h1 { font-size: 20px; margin-bottom: 4px; }');
  printWindow.document.write('h2, h3 { font-size: 14px; margin: 12px 0 6px; }');
  printWindow.document.write('.report-header { border-bottom: 2px solid #333; padding-bottom: 8px; margin-bottom: 16px; }');
  printWindow.document.write('.report-date { font-size: 11px; color: #666; }');
  // Convert dark theme colors to print-friendly
  printWindow.document.write('div, span, td, th, p, label, strong { color: #1a1a1a !important; }');
  printWindow.document.write('[style*="background"] { background: white !important; }');
  printWindow.document.write('[style*="border"] { border-color: #ddd !important; }');
  printWindow.document.write('table { border-collapse: collapse; width: 100%; }');
  printWindow.document.write('th, td { padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; }');
  printWindow.document.write('.badge { padding: 2px 6px; border-radius: 3px; font-size: 10px; border: 1px solid #ddd; }');
  printWindow.document.write('button, .btn, input, select, textarea { display: none !important; }');
  printWindow.document.write('.card { border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin-bottom: 12px; page-break-inside: avoid; }');
  printWindow.document.write('.card-header { display: flex; justify-content: space-between; margin-bottom: 8px; }');
  printWindow.document.write('@media print { body { padding: 0; } @page { margin: 0.5in; } }');
  // Make colored numbers visible in print
  printWindow.document.write('[style*="color: var(--accent)"], [style*="color:var(--accent)"], [style*="color:#4ae3b5"], [style*="color: rgb(16"] { color: #0a7c5a !important; }');
  printWindow.document.write('[style*="color: var(--danger)"], [style*="color:var(--danger)"], [style*="color:#ef4444"] { color: #c0392b !important; }');
  printWindow.document.write('[style*="color: var(--purple)"], [style*="color:var(--purple)"], [style*="color:#a78bfa"] { color: #6b21a8 !important; }');
  printWindow.document.write('[style*="color:#f59e0b"], [style*="color: #f59e0b"] { color: #b45309 !important; }');
  printWindow.document.write('</style></head><body>');
  printWindow.document.write('<div class="report-header"><h1>' + title + '</h1><div class="report-date">Generated: ' + date + ' · FCP Property Management & Rental Analysis</div></div>');
  printWindow.document.write(content.innerHTML);
  printWindow.document.write('</body></html>');
  printWindow.document.close();

  // Auto-trigger print for PDF save
  setTimeout(function() {
    printWindow.print();
  }, 500);
}

async function fetchZestimate() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var zInfo = document.getElementById('zestimateInfo');
  if (zInfo) zInfo.innerHTML ='' + _ico('clock', 13) + ' Searching Zillow...';
  try {
    var d = await api('/api/properties/' + editId + '/zestimate', 'POST');
    if (d.zestimate) {
      document.getElementById('f_value').value = d.zestimate;
      var zLink = d.zillow_url ? ' · <a href="' + esc(d.zillow_url) + '" target="_blank" style="color:var(--accent);">View on Zillow ↗</a>' : '';
      var extra = '';
      if (d.rent_zestimate) extra += ' · <span style="color:var(--purple);">Rent Zestimate: <strong>$' + Math.round(d.rent_zestimate).toLocaleString() + '/mo</strong></span>';
      var zd = d.zillow_data || {};
      var details = [];
      if (zd.sqft) details.push(zd.sqft.toLocaleString() + ' sqft');
      if (zd.year_built) details.push('Built ' + zd.year_built);
      if (zd.price_per_sqft) details.push('$' + zd.price_per_sqft + '/sqft');
      if (details.length) extra += ' · <span style="color:var(--text3);font-size:0.78rem;">' + details.join(' · ') + '</span>';
      if (zInfo) zInfo.innerHTML = '' + _ico('check', 13, 'var(--accent)') + ' <strong style="color:var(--accent);">$' + d.zestimate.toLocaleString() + '</strong> home value from ' + esc(d.source) + ' (' + d.date + ')' + extra + (d.previous_value && d.previous_value !== d.zestimate ? ' · <span style="color:var(--text3);">was $' + Math.round(d.previous_value).toLocaleString() + '</span>' : '') + zLink;
      toast('Zestimate: $' + d.zestimate.toLocaleString());
    } else {
      if (zInfo) zInfo.innerHTML = '' + _ico('x', 13, 'var(--danger)') + ' Could not find Zestimate — try adding Zillow URL to property';
      toast('No Zestimate found', 'error');
    }
  } catch (err) {
    if (zInfo) zInfo.innerHTML = '' + _ico('x', 13, 'var(--danger)') + ' ' + err.message;
    toast(err.message, 'error');
  }
}

var propExpenses = [];

async function loadPropertyExpenses(propId) {
  try {
    var d = await api('/api/properties/' + propId + '/expenses');
    propExpenses = d.expenses || [];
  } catch { propExpenses = []; }
  renderPropertyExpenses();
}

function renderPropertyExpenses() {
  var el = document.getElementById('propExpensesList');
  if (!el) return;
  if (propExpenses.length === 0) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:4px 0;">No capital expenses recorded yet.</div>';
    return;
  }
  var catIcons = {closing:'' + _ico('clipboard', 13) + '',renovation:'' + _ico('tool', 13) + '',repair:_ico('tool',13),furniture:_ico('layers',15),appliance:'' + _ico('zap', 13) + '',legal:'' + _ico('receipt', 13) + '',other:_ico('target',13)};
  var catColors = {closing:'96,165,250',renovation:'167,139,250',repair:'245,158,11',furniture:'16,185,129',appliance:'59,130,246',legal:'148,163,184',other:'107,114,128'};
  var total = 0;
  var h = '';
  propExpenses.forEach(function(e) {
    total += e.amount || 0;
    var icon = catIcons[e.category] || _ico('target',13);
    var rgb = catColors[e.category] || '107,114,128';
    h += '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;margin-bottom:3px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);border-left:3px solid rgba(' + rgb + ',0.5);">';
    h += '<span style="font-size:0.9rem;">' + icon + '</span>';
    h += '<div style="flex:1;min-width:0;">';
    h += '<div style="font-size:0.82rem;font-weight:600;">' + esc(e.name) + '</div>';
    h += '<div style="font-size:0.68rem;color:var(--text3);">' + esc(e.category || 'other') + (e.date_incurred ? ' · ' + e.date_incurred : '') + (e.notes ? ' · ' + esc(e.notes) : '') + '</div>';
    h += '</div>';
    h += '<span style="font-family:DM Mono,monospace;font-weight:600;color:rgb(' + rgb + ');">$' + (e.amount || 0).toLocaleString() + '</span>';
    h += '<button class="btn btn-xs btn-danger" onclick="removePropertyExpense(' + e.id + ')" style="padding:2px 6px;">✕</button>';
    h += '</div>';
  });
  // Total bar
  h += '<div style="display:flex;justify-content:space-between;padding:6px 10px;margin-top:4px;font-size:0.82rem;">';
  h += '<span style="font-weight:600;color:var(--text2);">Total Capital Invested</span>';
  h += '<span style="font-family:DM Mono,monospace;font-weight:700;color:var(--purple);">$' + total.toLocaleString() + '</span></div>';
  // Payback estimate
  var editId = (document.getElementById('f_editId') || {}).value;
  var p = editId ? properties.find(function(x) { return x.id == editId; }) : null;
  if (p && total > 0) {
    var monthlyNet = (p.est_monthly_revenue || 0) - ((p.monthly_rent_cost || 0) + (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0) + (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0));
    var allIn = (p.purchase_price || 0) + total;
    h += '<div style="font-size:0.72rem;color:var(--text3);padding:2px 10px;">';
    if (allIn > 0) h += 'All-in cost: $' + allIn.toLocaleString() + (p.purchase_price ? ' (purchase $' + p.purchase_price.toLocaleString() + ' + capital $' + total.toLocaleString() + ')' : '');
    if (monthlyNet > 0) h += ' · Payback: ~' + Math.ceil(total / monthlyNet) + ' months';
    h += '</div>';
  }
  el.innerHTML = h;
}

async function addPropertyExpense() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var name = (document.getElementById('newExpName') || {}).value || '';
  var amount = parseFloat((document.getElementById('newExpAmount') || {}).value) || 0;
  var category = (document.getElementById('newExpCategory') || {}).value || 'other';
  var date = (document.getElementById('newExpDate') || {}).value || '';
  if (!name.trim()) { toast('Enter expense name', 'error'); return; }
  if (amount <= 0) { toast('Enter amount', 'error'); return; }
  try {
    await api('/api/properties/' + editId + '/expenses', 'POST', { name: name.trim(), amount: amount, category: category, date_incurred: date || null });
    document.getElementById('newExpName').value = '';
    document.getElementById('newExpAmount').value = '';
    document.getElementById('newExpDate').value = '';
    await loadPropertyExpenses(editId);
    toast(name.trim() + ' added');
  } catch (err) { toast(err.message, 'error'); }
}

async function removePropertyExpense(expId) {
  try {
    await api('/api/expenses/' + expId, 'DELETE');
    var editId = document.getElementById('f_editId').value;
    if (editId) await loadPropertyExpenses(editId);
    toast('Expense removed');
  } catch (err) { toast(err.message, 'error'); }
}

var propServices = [];
var serviceCatalog = [];

async function loadServiceCatalog() {
  try {
    var d = await api('/api/service-catalog');
    serviceCatalog = d.catalog || [];
  } catch { serviceCatalog = []; }
  updateServiceDropdown();
}

function updateServiceDropdown() {
  var sel = document.getElementById('svcCatalogSelect');
  if (!sel) return;
  var editId = (document.getElementById('f_editId') || {}).value;
  var isChild = editId && properties.find(function(p) { return p.id == editId && p.parent_id; });
  var h = '<option value="">— Pick existing or type new —</option>';
  serviceCatalog.forEach(function(s) {
    var cost = isChild && s.child_cost ? s.child_cost : s.default_cost || 0;
    h += '<option value="' + esc(s.name) + '" data-cost="' + cost + '">' + esc(s.name) + ' — $' + cost + '/mo' + (isChild && s.child_cost ? ' (child rate)' : '') + '</option>';
  });
  sel.innerHTML = h;
}

function fillServiceFromCatalog() {
  var sel = document.getElementById('svcCatalogSelect');
  if (!sel || !sel.value) return;
  var opt = sel.options[sel.selectedIndex];
  document.getElementById('newSvcName').value = sel.value;
  document.getElementById('newSvcCost').value = opt.dataset.cost || '';
}

async function loadPropertyServices(propId) {
  try {
    var d = await api('/api/properties/' + propId + '/services');
    propServices = d.services || [];
  } catch { propServices = []; }
  renderPropertyServices();
  if (serviceCatalog.length === 0) loadServiceCatalog();
  else updateServiceDropdown();
}

function renderPropertyServices() {
  var el = document.getElementById('propServicesList');
  if (!el) return;
  if (propServices.length === 0) {
    el.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:4px 0;">No services yet. Add Guesty, PriceLabs, lock automation, etc.</div>';
    updateCostSummary();
    return;
  }
  var h = '', total = 0;
  propServices.forEach(function(s) {
    total += s.monthly_cost || 0;
    h += '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;margin-bottom:3px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);">';
    h += '<span style="flex:1;font-size:0.82rem;">' + esc(s.name) + '</span>';
    h += '<span style="font-family:DM Mono,monospace;font-weight:600;color:var(--purple);">$' + s.monthly_cost + '/mo</span>';
    h += '<button class="btn btn-xs btn-danger" onclick="removePropertyService(' + s.id + ')" style="padding:2px 6px;">✕</button>';
    h += '</div>';
  });
  h += '<div style="display:flex;justify-content:flex-end;padding:4px 10px;font-size:0.78rem;font-weight:600;color:var(--purple);">Total: $' + total.toFixed(2) + '/mo · $' + (total * 12).toFixed(0) + '/yr</div>';
  el.innerHTML = h;
  updateCostSummary();
}

async function addPropertyService() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var name = (document.getElementById('newSvcName') || {}).value || '';
  var cost = parseFloat((document.getElementById('newSvcCost') || {}).value) || 0;
  if (!name.trim()) { toast('Enter service name', 'error'); return; }
  if (cost <= 0) { toast('Enter monthly cost', 'error'); return; }
  try {
    await api('/api/properties/' + editId + '/services', 'POST', { name: name.trim(), monthly_cost: cost });
    document.getElementById('newSvcName').value = '';
    document.getElementById('newSvcCost').value = '';
    var sel = document.getElementById('svcCatalogSelect');
    if (sel) sel.value = '';
    await loadPropertyServices(editId);
    await loadServiceCatalog();
    toast(name.trim() + ' added');
  } catch (err) { toast(err.message, 'error'); }
}

async function removePropertyService(svcId) {
  try {
    await api('/api/services/' + svcId, 'DELETE');
    var editId = document.getElementById('f_editId').value;
    if (editId) await loadPropertyServices(editId);
    toast('Service removed');
  } catch (err) { toast(err.message, 'error'); }
}

function getServicesCost() {
  var total = 0;
  propServices.forEach(function(s) { total += s.monthly_cost || 0; });
  return total;
}

var bulkMode = false;

async function movePropertyToBuilding() {
  var editId = document.getElementById('f_editId').value;
  var bldSel = document.getElementById('moveToBuilding');
  if (!editId) { toast('Save property first', 'error'); return; }
  var parentId = bldSel ? (bldSel.value || null) : null;
  try {
    await api('/api/properties/' + editId, 'PUT', { parent_id: parentId ? parseInt(parentId) : null });
    toast(parentId ? 'Moved to building' : 'Set as standalone');
    await loadProperties();
    openProperty(editId);
  } catch (err) { toast(err.message, 'error'); }
}

function toggleBulkMode() {
  bulkMode = !bulkMode;
  var bar = document.getElementById('bulkBar');
  var btn = document.getElementById('bulkModeBtn');
  if (bar) bar.style.display = bulkMode ? 'block' : 'none';
  if (btn) { btn.textContent = bulkMode ? '✕ Cancel' : '☑ Select'; btn.className = bulkMode ? 'btn btn-sm btn-danger' : 'btn btn-sm'; }
  // Toggle checkbox visibility
  document.querySelectorAll('.prop-select').forEach(function(el) { el.style.display = bulkMode ? '' : 'none'; });
  if (!bulkMode) {
    selectedProps.clear();
    document.querySelectorAll('.prop-select input').forEach(function(cb) { cb.checked = false; });
    var sa = document.getElementById('selectAll'); if (sa) sa.checked = false;
    updateBulkCount();
  }
}

function populateCopyFromDropdown() {
  var sel = document.getElementById('copyFromProp');
  var bldSel = document.getElementById('moveToBuilding');
  var section = document.getElementById('copyFromSection');
  if (!sel) return;
  var editId = (document.getElementById('f_editId') || {}).value;
  // Copy from dropdown
  var h = '<option value="">— Select property —</option>';
  properties.forEach(function(p) {
    if (String(p.id) === String(editId)) return;
    var label = p.name || p.address || 'Property ' + p.id;
    if (p.unit_number) label = p.unit_number + ' — ' + label;
    h += '<option value="' + p.id + '">' + esc(label) + ' (' + esc(p.city || '') + ')</option>';
  });
  sel.innerHTML = h;
  // Building dropdown — show buildings + standalone properties that could be buildings
  if (bldSel) {
    var bh = '<option value="">— Standalone (no building) —</option>';
    var currentProp = properties.find(function(p) { return String(p.id) === String(editId); });
    properties.forEach(function(p) {
      if (String(p.id) === String(editId)) return;
      // Show properties that are buildings (have children) or could be buildings
      var isBuilding = p.child_count > 0 || properties.some(function(c) { return String(c.parent_id) === String(p.id); });
      if (isBuilding || p.total_units_count > 0) {
        var label = (p.name || p.address || 'Property ' + p.id) + ' (' + esc(p.city || '') + ')';
        bh += '<option value="' + p.id + '"' + (currentProp && String(currentProp.parent_id) === String(p.id) ? ' selected' : '') + '>' + esc(label) + '</option>';
      }
    });
    bldSel.innerHTML = bh;
  }
  if (section && editId) section.style.display = '';
}

async function copyFromProperty() {
  var editId = document.getElementById('f_editId').value;
  var sourceId = (document.getElementById('copyFromProp') || {}).value;
  if (!editId || !sourceId) { toast('Select a property to copy from', 'error'); return; }

  // Fetch preview
  try {
    var d = await api('/api/properties/' + editId + '/copy-preview/' + sourceId);
    showCopyDialog(d, editId, sourceId);
  } catch (err) { toast(err.message, 'error'); }
}

function showCopyDialog(data, targetId, sourceId) {
  // Create modal overlay
  var overlay = document.createElement('div');
  overlay.id = 'copyDialog';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

  var h = '<div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;max-width:650px;width:100%;max-height:85vh;overflow-y:auto;padding:24px;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">';
  h += '<h3 style="margin:0;">' + _ico('receipt', 13) + ' Copy from ' + esc(data.source.name) + '</h3>';
  h += '<button onclick="document.getElementById(\'copyDialog\').remove()" style="background:none;border:none;color:var(--text3);font-size:1.2rem;cursor:pointer;">✕</button></div>';
  h += '<p style="font-size:0.78rem;color:var(--text3);margin:0 0 14px;">Select what to copy to <strong>' + esc(data.target.name) + '</strong>:</p>';

  // Select all / none
  h += '<div style="display:flex;gap:8px;margin-bottom:12px;">';
  h += '<button class="btn btn-xs" onclick="document.querySelectorAll(\'#copyDialog input[type=checkbox]\').forEach(function(c){c.checked=true})">Select All</button>';
  h += '<button class="btn btn-xs" onclick="document.querySelectorAll(\'#copyDialog input[type=checkbox]\').forEach(function(c){c.checked=false})">Select None</button>';
  h += '</div>';

  // Fields section
  if (data.fields.length > 0) {
    h += '<div style="margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:6px;">EXPENSES & SETTINGS (' + data.fields.length + ')</div>';
    data.fields.forEach(function(f) {
      var val = f.is_money ? '$' + Number(f.source_value).toLocaleString() : f.source_value;
      var overwrite = f.would_overwrite ? ' <span style="font-size:0.65rem;color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' overwrites: ' + (f.is_money ? '$' + Number(f.target_value).toLocaleString() : f.target_value) + '</span>' : '';
      h += '<label style="display:flex;align-items:center;gap:8px;padding:5px 10px;margin-bottom:2px;border-radius:4px;cursor:pointer;font-size:0.82rem;" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'none\'">';
      h += '<input type="checkbox" class="copy-field" value="' + f.key + '" checked style="width:16px;height:16px;">';
      h += '<span style="flex:1;">' + esc(f.label) + '</span>';
      h += '<span style="font-family:DM Mono,monospace;color:var(--accent);">' + val + '</span>';
      h += overwrite;
      h += '</label>';
    });
    h += '</div>';
  }

  // Services section
  if (data.services.length > 0) {
    h += '<div style="margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:6px;">SERVICES (' + data.services.length + ')</div>';
    data.services.forEach(function(s) {
      var exists = s.already_exists ? ' <span style="font-size:0.65rem;color:var(--text3);">already exists — skip</span>' : '';
      h += '<label style="display:flex;align-items:center;gap:8px;padding:5px 10px;margin-bottom:2px;border-radius:4px;cursor:pointer;font-size:0.82rem;" onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'none\'">';
      h += '<input type="checkbox" class="copy-service" value="' + esc(s.name) + '"' + (s.already_exists ? '' : ' checked') + (s.already_exists ? ' disabled' : '') + ' style="width:16px;height:16px;">';
      h += '<span style="flex:1;">' + esc(s.name) + '</span>';
      h += '<span style="font-family:DM Mono,monospace;color:var(--purple);">$' + s.monthly_cost + '/mo</span>';
      h += exists;
      h += '</label>';
    });
    h += '</div>';
  }

  // Amenities section
  if (data.amenities.length > 0) {
    h += '<div style="margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">AMENITIES (' + data.amenities.length + ')</div>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:4px;">';
    data.amenities.forEach(function(a) {
      h += '<label style="display:flex;align-items:center;gap:4px;padding:4px 10px;background:var(--surface2);border-radius:20px;cursor:pointer;font-size:0.75rem;">';
      h += '<input type="checkbox" class="copy-amenity" value="' + a.id + '"' + (a.already_exists ? '' : ' checked') + (a.already_exists ? ' disabled' : '') + ' style="width:14px;height:14px;">';
      h += esc(a.name) + (a.already_exists ? ' <span style="color:var(--text3);">✓</span>' : '');
      h += '</label>';
    });
    h += '</div></div>';
  }

  if (data.fields.length === 0 && data.services.length === 0 && data.amenities.length === 0) {
    h += '<p style="color:var(--text3);text-align:center;padding:20px;">Nothing to copy — source property has no data.</p>';
  }

  // Action buttons
  h += '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:14px;border-top:1px solid var(--border);">';
  h += '<button class="btn btn-sm" onclick="document.getElementById(\'copyDialog\').remove()">Cancel</button>';
  h += '<button class="btn btn-sm btn-primary" onclick="executeCopy(' + targetId + ',' + sourceId + ')">Copy Selected</button>';
  h += '</div></div>';

  overlay.innerHTML = h;
  document.body.appendChild(overlay);
}

async function executeCopy(targetId, sourceId) {
  var fields = [], services = [], amenities = [];
  document.querySelectorAll('#copyDialog .copy-field:checked').forEach(function(c) { fields.push(c.value); });
  document.querySelectorAll('#copyDialog .copy-service:checked').forEach(function(c) { services.push(c.value); });
  document.querySelectorAll('#copyDialog .copy-amenity:checked').forEach(function(c) { amenities.push(parseInt(c.value)); });

  if (fields.length === 0 && services.length === 0 && amenities.length === 0) {
    toast('Nothing selected to copy', 'error');
    return;
  }

  try {
    var d = await api('/api/properties/' + targetId + '/copy-from/' + sourceId, 'POST', {
      fields: fields, services: services, amenities: amenities
    });
    document.getElementById('copyDialog').remove();
    toast('Copied ' + d.fields_copied + ' fields, ' + d.services_copied + ' services, ' + d.amenities_copied + ' amenities');
    openProperty(targetId);
  } catch (err) { toast(err.message, 'error'); }
}

function toggleSharePanel() {
  var panel = document.getElementById('sharePanel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
  if (panel.style.display !== 'none') loadShareLinks();
}

async function loadShareLinks() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) return;
  var el = document.getElementById('shareLinks');
  if (!el) return;
  try {
    var d = await api('/api/properties/' + editId + '/share');
    var shares = d.shares || [];
    if (shares.length === 0) {
      el.innerHTML = '<p style="color:var(--text3);font-size:0.78rem;">No share links yet. Create one to share this property as read-only.</p>';
      return;
    }
    var h = '';
    shares.forEach(function(s) {
      h += '<div style="padding:12px;margin-bottom:8px;background:var(--bg);border-radius:8px;border:1px solid var(--border);">';
      // Code display - prominent
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
      h += '<div><div style="font-size:0.65rem;color:var(--text3);margin-bottom:2px;">ACCESS CODE — give this to viewer</div>';
      h += '<code style="font-size:1.4rem;font-weight:700;color:var(--accent);letter-spacing:4px;user-select:all;">' + esc(s.share_code) + '</code></div>';
      h += '<button class="btn btn-xs" onclick="navigator.clipboard.writeText(\'' + esc(s.share_code) + '\');toast(\'Code copied!\')" style="white-space:nowrap;">' + _ico('receipt', 13) + ' Copy Code</button>';
      h += '</div>';
      // Instructions
      h += '<div style="font-size:0.72rem;color:var(--text3);padding:6px 10px;background:var(--surface2);border-radius:6px;margin-bottom:8px;">';
      h +='' + _ico('zap', 13) + ' Share this code — the viewer enters it at <strong>' + window.location.origin + '/share</strong> to view. The code is not in the URL for privacy.';
      h += '</div>';
      // Actions
      h += '<div style="display:flex;gap:6px;">';
      h += '<a href="/share/' + esc(s.share_code) + '" target="_blank" class="btn btn-xs" style="text-decoration:none;">' + _ico('eye', 13) + ' Preview</a>';
      h += '<button class="btn btn-xs btn-danger" onclick="deleteShareLink(\'' + esc(s.share_code) + '\')" title="Revoke access">Revoke</button>';
      h += '<span style="font-size:0.65rem;color:var(--text3);align-self:center;margin-left:auto;">Created ' + (s.created_at || '').substring(0, 10) + '</span>';
      h += '</div></div>';
    });
    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<p style="color:var(--danger);">' + esc(err.message) + '</p>'; }
}

async function createShareLink() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) return;
  try {
    var d = await api('/api/properties/' + editId + '/share', 'POST', {});
    toast('Share link created: ' + d.code);
    loadShareLinks();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteShareLink(code) {
  var editId = document.getElementById('f_editId').value;
  if (!editId) return;
  if (!confirm('Revoke share link ' + code + '? Anyone with this link will lose access.')) return;
  try {
    await api('/api/properties/' + editId + '/share', 'DELETE', { code: code });
    toast('Share link revoked');
    loadShareLinks();
  } catch (err) { toast(err.message, 'error'); }
}

function updateBulkCount() {
  var el = document.getElementById('bulkCount');
  if (el) el.textContent = selectedProps.size > 0 ? selectedProps.size + ' selected' : '';
  var sa = document.getElementById('selectAll');
  if (sa) sa.checked = selectedProps.size === properties.length && properties.length > 0;
  var tc = document.getElementById('propTotalCount');
  if (tc) tc.textContent = properties.length + ' properties';
  // Show/hide action buttons based on selection
  document.querySelectorAll('.bulk-action-btn').forEach(function(btn) {
    btn.style.display = selectedProps.size > 0 ? '' : 'none';
  });
}

async function deleteOneProp(id) {
  if (!confirm("Delete this property? This cannot be undone.")) return;
  try {
    await api('/api/properties/' + id, 'DELETE');
    toast('Property deleted');
    selectedProps.delete(id);
    await loadProperties();
  } catch (e) { toast(e.message, 'error'); }
}

async function doBulkDelete() {
  if (selectedProps.size === 0) { toast('No properties selected', 'error'); return; }
  if (!confirm("Delete " + selectedProps.size + " properties? This cannot be undone.")) return;
  try {
    await api('/api/properties/bulk-delete', 'POST', { ids: Array.from(selectedProps) });
    toast(selectedProps.size + ' properties deleted');
    selectedProps.clear();
    await loadProperties();
  } catch (e) { toast(e.message, 'error'); }
}

function updateBulkValueInput() {
  var field = (document.getElementById('bulkField') || {}).value;
  var wrap = document.getElementById('bulkValueWrap');
  if (!wrap) return;

  // Fields that should show a dropdown
  var dropdowns = {
    listing_status: [['active','Active'],['inactive','Inactive'],['draft','Draft'],['pending','Pending']],
    property_type: [['single_family','Single Family'],['condo','Condo'],['apartment','Apartment'],['townhouse','Townhouse'],['multi_family','Multi-Family'],['glamping','Glamping'],['studio','Studio']],
    rental_type: [['str','STR'],['ltr','LTR'],['mtr','MTR']],
    ownership_type: [['purchased','Purchased'],['rental','Rental'],['managed','Managed for Owner'],['partnership','Partnership']],
  };

  if (dropdowns[field]) {
    var opts = dropdowns[field].map(function(o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('');
    wrap.innerHTML = '<select id="bulkValue" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:0.82rem;width:140px;"><option value="">Select...</option>' + opts + '</select>';
  } else if (field === 'algo_template_id') {
    // Load templates into dropdown
    var opts2 = '<option value="">None (remove)</option>';
    api('/api/algo-templates').then(function(d) {
      (d.templates || []).forEach(function(t) { opts2 += '<option value="' + t.id + '">' + esc(t.name) + '</option>'; });
      wrap.innerHTML = '<select id="bulkValue" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:0.82rem;width:140px;">' + opts2 + '</select>';
    }).catch(function() {});
  } else {
    wrap.innerHTML = '<input id="bulkValue" placeholder="Value" style="background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:0.82rem;width:140px;">';
  }
}

async function doBulkEdit() {
  if (selectedProps.size === 0) { toast('No properties selected', 'error'); return; }
  var field = document.getElementById('bulkField').value;
  var value = document.getElementById('bulkValue').value;
  if (!field) { toast('Select a field to edit', 'error'); return; }
  if (value === '' && field !== 'algo_template_id') { toast('Enter a value', 'error'); return; }

  var numFields = ['bedrooms', 'bathrooms', 'sqft', 'lot_acres', 'year_built', 'stories', 'parking_spaces', 'purchase_price', 'estimated_value', 'annual_taxes', 'hoa_monthly', 'monthly_insurance', 'monthly_rent_cost', 'cleaning_fee', 'cleaning_cost', 'algo_template_id'];
  var updates = {};
  if (numFields.indexOf(field) >= 0) {
    updates[field] = value === '' ? null : parseFloat(value);
  } else {
    updates[field] = value;
  }

  if (!confirm('Update ' + field.replace(/_/g, ' ') + ' to "' + value + '" for ' + selectedProps.size + ' properties?')) return;

  try {
    await api('/api/properties/bulk-edit', 'POST', { ids: Array.from(selectedProps), updates: updates });
    toast(selectedProps.size + ' properties updated');
    document.getElementById('bulkValue').value = '';
    await loadProperties();
  } catch (e) { toast(e.message, 'error'); }
}

function toggleBulkEditPanel() {
  var panel = document.getElementById('bulkEditPanel');
  if (!panel) return;
  var show = panel.style.display === 'none';
  panel.style.display = show ? 'flex' : 'none';
}

function showAddProperty() {
  var sv = function(elId, val) { var el = document.getElementById(elId); if (el) el.value = val || ''; };
  var st = function(elId, val) { var el = document.getElementById(elId); if (el) el.textContent = val || ''; };
  sv('f_editId', '');
  currentPropertyId = null;
  _propertyImages = [];
  st('formTitle', 'Add New Property');
  var shareBtn = document.getElementById('shareBtn');
  if (shareBtn) shareBtn.style.display = 'none';
  var sharePanel = document.getElementById('sharePanel');
  if (sharePanel) sharePanel.style.display = 'none';
  propServices = [];
  propExpenses = [];
  var svcList = document.getElementById('propServicesList');
  if (svcList) svcList.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:4px 0;">No services yet. Add Guesty, PriceLabs, lock automation, etc.</div>';
  var expList = document.getElementById('propExpensesList');
  if (expList) expList.innerHTML = '<div style="font-size:0.78rem;color:var(--text3);padding:4px 0;">No capital expenses recorded yet.</div>';
  ['f_name','f_address','f_city','f_state','f_zip','f_beds','f_baths','f_sqft','f_lot','f_year','f_price','f_value','f_taxes','f_tax_rate_pct','f_hoa','f_image','f_unit','f_mortgage','f_insurance','f_monthly_rent','f_deposit','f_electric','f_gas','f_water','f_internet','f_trash','f_other_expense','f_cleaning','f_cleaning_cost','f_stories','f_lat','f_lng','f_parking','f_parcel','f_zoning','f_county'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  sv('f_type', 'single_family');
  setOwnership('purchased');
  toggleUnitField();
  updateImagePreview();
  renderPropertyGallery();
  _renderGuestyListingContent(d.guesty_listing);
  updateCostSummary();
  updateNamePreview();
  var coordEl = document.getElementById('coordDisplay'); if (coordEl) { coordEl.innerHTML = ''; coordEl.style.display = 'none'; }
  var parentB = document.getElementById('parentBanner'); if (parentB) parentB.style.display = 'none';
  var buildSum = document.getElementById('buildingSummary'); if (buildSum) { buildSum.style.display = 'none'; buildSum.innerHTML = ''; }
  // Show all fields by default (not in building mode)
  document.querySelectorAll('.unit-field').forEach(function(el) { el.style.display = ''; });
  document.querySelectorAll('.building-field').forEach(function(el) { el.style.display = 'none'; });
  var sqftLabel = document.getElementById('sqftLabel'); if (sqftLabel) sqftLabel.textContent = 'Sqft';
  var expLabel = document.getElementById('expenseLabel'); if (expLabel) expLabel.textContent = 'MONTHLY EXPENSES';
  var unitsTab = document.getElementById('unitsTab'); if (unitsTab) unitsTab.style.display = 'none';
  var propBanner = document.getElementById('propIdentityBanner'); if (propBanner) propBanner.style.display = 'none';
  var amenitiesTab = document.querySelector('#propSubTabs [data-ptab="amenities"]'); if (amenitiesTab) amenitiesTab.style.display = '';
  var histEl = document.getElementById('propHistoryContent'); if (histEl) histEl.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save the property first, then run an analysis to see history here.</p>';
  var amenEl = document.getElementById('propAmenitiesContent'); if (amenEl) amenEl.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save the property first to manage amenities.</p>';
  var unitsEl = document.getElementById('unitsList'); if (unitsEl) unitsEl.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save as Multi-Family first, then add units.</p>';
  var sumEl = document.getElementById('unitsSummary'); if (sumEl) sumEl.innerHTML = '';
  switchPropTab('details');
  switchView('addProperty');
}

async function openProperty(id, initialTab) {
  showLoading('Loading...');
  try {
    var d = await api('/api/properties/' + id); var p = d.property;
    _currentPropData = d; // cache for PL customizations etc
    window._propMonthlyActuals = d.monthly_actuals || [];
    window._propSeasonality = d.seasonality || [];
    var sv = function(elId, val) { var el = document.getElementById(elId); if (el) el.value = val || ''; };
    var st = function(elId, val) { var el = document.getElementById(elId); if (el) el.textContent = val || ''; };
    sv('f_editId', p.id);
    currentPropertyId = p.id;
    st('formTitle', p.parent_id ? 'Edit Unit' : 'Edit Property');

    // Populate persistent identity banner
    var banner = document.getElementById('propIdentityBanner');
    if (banner) {
      banner.style.display = '';
      var displayName = p.platform_listing_name || p.name || p.address || 'Property #' + p.id;
      if (p.unit_number) displayName = p.unit_number + ' — ' + displayName;
      var bannerName = document.getElementById('propBannerName');
      if (bannerName) bannerName.textContent = displayName;
      var bannerAddr = document.getElementById('propBannerAddress');
      if (bannerAddr) {
        var addrParts = [];
        if (p.address) addrParts.push(p.address);
        if (p.city) addrParts.push(p.city + (p.state ? ', ' + p.state : '') + (p.zip ? ' ' + p.zip : ''));
        bannerAddr.textContent = addrParts.join(' · ');
      }
      var bannerMeta = document.getElementById('propBannerMeta');
      if (bannerMeta) {
        var mh = '';
        var typeLabel = (p.property_type || '').replace(/_/g, ' ');
        if (typeLabel) mh += '<span style="font-size:0.68rem;padding:2px 8px;background:var(--surface3);border-radius:4px;color:var(--text2);">' + _ico('home', 11) + ' ' + typeLabel + '</span>';
        if (p.bedrooms) mh += '<span style="font-size:0.68rem;padding:2px 8px;background:var(--surface3);border-radius:4px;color:var(--text2);">' + p.bedrooms + 'BR / ' + (p.bathrooms || '?') + 'BA</span>';
        if (p.sqft) mh += '<span style="font-size:0.68rem;padding:2px 8px;background:var(--surface3);border-radius:4px;color:var(--text3);">' + parseInt(p.sqft).toLocaleString() + ' sqft</span>';
        var statusColor = (p.listing_status === 'active' || !p.listing_status) ? 'var(--accent)' : p.listing_status === 'inactive' ? 'var(--danger)' : 'var(--text3)';
        var statusLabel = p.listing_status || 'active';
        mh += '<span style="font-size:0.62rem;padding:2px 8px;background:' + statusColor + ';color:#fff;border-radius:4px;font-weight:600;text-transform:uppercase;">' + statusLabel + '</span>';
        if (p.is_managed === 1 || p.ownership_type === 'managed') {
          mh += '<span style="font-size:0.62rem;padding:2px 8px;background:var(--blue);color:#fff;border-radius:4px;font-weight:600;">' + _ico('handshake', 10, '#fff') + ' Managed</span>';
        }
        if (p.is_research === 1) {
          mh += '<span style="font-size:0.62rem;padding:2px 8px;background:var(--purple);color:#fff;border-radius:4px;font-weight:600;">' + _ico('search', 10, '#fff') + ' Research</span>';
        }
        // Latest analysis badge
        var latestStrat = (d.strategies && d.strategies.length > 0) ? d.strategies[0] : null;
        if (latestStrat) {
          var stratAge = Math.round((Date.now() - new Date(latestStrat.created_at + 'Z').getTime()) / 86400000);
          var stratAgeLabel = stratAge === 0 ? 'today' : stratAge === 1 ? 'yesterday' : stratAge + 'd ago';
          var stratColor = stratAge <= 7 ? 'var(--accent)' : stratAge <= 30 ? '#f0b840' : 'var(--text3)';
          mh += '<span style="font-size:0.62rem;padding:2px 8px;background:var(--surface3);border-radius:4px;color:' + stratColor + ';border:1px solid ' + stratColor + ';">' + _ico('dollarSign', 10, stratColor) + ' $' + (latestStrat.base_nightly_rate || 0) + '/nt · ' + Math.round((latestStrat.projected_occupancy || 0) * 100) + '% · $' + Math.round(latestStrat.projected_monthly_avg || 0).toLocaleString() + '/mo <span style="opacity:0.7;">(' + stratAgeLabel + ')</span></span>';
        } else {
          mh += '<span style="font-size:0.62rem;padding:2px 8px;background:rgba(245,158,11,0.1);border-radius:4px;color:#f0b840;border:1px solid rgba(245,158,11,0.2);">' + _ico('alert', 10, '#f0b840') + ' No analysis</span>';
        }
        bannerMeta.innerHTML = mh;
      }
    }
    var shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.style.display = '';
    var sharePanel = document.getElementById('sharePanel');
    if (sharePanel) sharePanel.style.display = 'none';
    sv('f_name', p.name);
    sv('f_address', p.address);
    sv('f_city', p.city);
    sv('f_state', p.state);
    sv('f_zip', p.zip);
    sv('f_type', p.property_type || 'single_family');
    sv('f_beds', p.bedrooms);
    sv('f_baths', p.bathrooms);
    sv('f_sqft', p.sqft);
    sv('f_lot', p.lot_acres);
    sv('f_year', p.year_built);
    sv('f_price', p.purchase_price);
    sv('f_value', p.estimated_value);
    sv('f_taxes', p.annual_taxes);
    sv('f_tax_rate_pct', p.tax_rate_pct);
    sv('f_hoa', p.hoa_monthly);
    sv('f_image', p.image_url);
    loadPropertyGallery(p.id);
    sv('f_unit', p.unit_number);
    sv('f_insurance', p.monthly_insurance);
    sv('f_purchase_date', p.purchase_date);
    sv('f_lease_start_date', p.lease_start_date);
    // Load linked loans from Loans tab
    loadPropLinkedLoans(p.id);
    // Show zestimate info
    var zInfo = document.getElementById('zestimateInfo');
    if (zInfo && p.zestimate) {
      var zLink2 = p.zillow_url ? ' · <a href="' + esc(p.zillow_url) + '" target="_blank" style="color:var(--accent);">View on Zillow ↗</a>' : '';
      zInfo.innerHTML = 'Zestimate: $' + p.zestimate.toLocaleString() + (p.zestimate_date ? ' (' + p.zestimate_date + ')' : '') + zLink2;
    }
    sv('f_monthly_rent', p.monthly_rent_cost);
    sv('f_deposit', p.security_deposit);
    sv('f_electric', p.expense_electric);
    sv('f_gas', p.expense_gas);
    sv('f_water', p.expense_water);
    sv('f_internet', p.expense_internet);
    sv('f_trash', p.expense_trash);
    sv('f_other_expense', p.expense_other);
    sv('f_cleaning', p.cleaning_fee);
    sv('f_cleaning_cost', p.cleaning_cost);
    // Load dynamic services
    loadPropertyServices(id);
    loadPropertyExpenses(id);
    populateCopyFromDropdown();
    sv('f_stories', p.stories);
    sv('f_lat', p.latitude);
    sv('f_lng', p.longitude);
    sv('f_parking', p.parking_spaces);
    sv('f_parcel', p.parcel_id);
    sv('f_zoning', p.zoning);
    sv('f_county', p.county);
    sv('f_listing_url', p.listing_url);
    sv('f_listing_status', p.listing_status);
    sv('f_rental_type', p.rental_type || 'str');
    sv('f_owner_name', p.owner_name);
    sv('f_mgmt_fee_pct', p.management_fee_pct);
    sv('f_mgmt_base_fee', p.management_base_fee);
    sv('f_rental_restrictions', p.rental_restrictions);
    sv('f_hoa_name', p.hoa_name);
    sv('f_ai_notes', p.ai_notes);
    // Set fee basis toggle
    var loadedBasis = p.fee_basis || 'gross';
    var fbHidden = document.getElementById('f_fee_basis');
    if (fbHidden) fbHidden.value = loadedBasis;
    document.querySelectorAll('.fee-basis-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.basis === loadedBasis); });
    var resEl = document.getElementById('f_research');
    if (resEl) resEl.checked = !!p.is_research;
    // Determine ownership: if is_managed, use 'managed'; otherwise existing logic
    var ownershipType = p.is_managed ? 'managed' : (p.ownership_type || 'purchased');
    setOwnership(ownershipType);
    setFinancing(p.financing_type || 'conventional');
    toggleUnitField();
    updateImagePreview();
    updateCostSummary();
    updateNamePreview();

    // Toggle building vs unit fields
    var isBuilding = p.property_type === 'multi_family' && !p.parent_id;
    var isUnit = !!p.parent_id;
    document.querySelectorAll('.unit-field').forEach(function(el) { el.style.display = isBuilding ? 'none' : ''; });
    document.querySelectorAll('.building-field').forEach(function(el) { el.style.display = isBuilding ? '' : 'none'; });
    var sqftLabel = document.getElementById('sqftLabel');
    if (sqftLabel) sqftLabel.textContent = isBuilding ? 'Total Sqft (building)' : 'Sqft';
    var expLabel = document.getElementById('expenseLabel');
    if (expLabel) expLabel.textContent = isBuilding ? 'BUILDING UTILITIES / SHARED COSTS' : 'MONTHLY EXPENSES';

    // Show parent banner if this is a child unit
    var parentBanner = document.getElementById('parentBanner');
    if (parentBanner) {
      if (d.parent) {
        parentBanner.style.display = '';
        parentBanner.innerHTML = 'Sub-unit of <a href="#" onclick="event.preventDefault();openProperty(' + d.parent.id + ')" style="font-weight:600;">' + esc(d.parent.address) + '</a>';
      } else { parentBanner.style.display = 'none'; }
    }

    // Building financial summary OR Property overview
    var buildingSumEl = document.getElementById('buildingSummary');
    if (buildingSumEl) {
      if (isBuilding && d.children && d.children.length > 0) {
        // ── BUILDING OVERVIEW ──
        var totalUnitRev = 0;
        var unitsWithRev = 0;
        var totalBeds = 0;
        var totalBaths = 0;
        var totalUnitSqft = 0;
        var totalUnitCosts = 0;
        d.children.forEach(function(c) {
          if (c.est_monthly_revenue > 0) { totalUnitRev += c.est_monthly_revenue; unitsWithRev++; }
          totalBeds += (c.bedrooms || 0);
          totalBaths += (c.bathrooms || 0);
          totalUnitSqft += (c.sqft || 0);
          // Per-unit costs (rent cost + utilities)
          var uCost = (c.monthly_rent_cost || 0) + (c.expense_electric || 0) + (c.expense_gas || 0) + (c.expense_water || 0) + (c.expense_internet || 0) + (c.expense_trash || 0) + (c.expense_other || 0);
          totalUnitCosts += uCost;
        });
        // Building-level expenses
        var bExp = 0;
        if (p.ownership_type === 'purchased') {
          bExp = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0);
        } else {
          bExp = (p.monthly_rent_cost || 0);
        }
        var bUtil = (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);
        var totalBldgCost = bExp + bUtil;
        var totalAllCosts = totalBldgCost + totalUnitCosts;
        var netIncome = totalUnitRev - totalAllCosts;

        var sh = '<div style="padding:16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;">';
        sh += '<h3 style="font-size:0.92rem;margin-bottom:12px;">Building Overview — ' + d.children.length + ' Units</h3>';
        sh += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:12px;">';
        sh += '<div><div style="font-size:0.72rem;color:var(--text3);">Total Beds</div><div style="font-weight:600;">' + totalBeds + '</div></div>';
        sh += '<div><div style="font-size:0.72rem;color:var(--text3);">Total Baths</div><div style="font-weight:600;">' + totalBaths + '</div></div>';
        if (totalUnitSqft > 0) sh += '<div><div style="font-size:0.72rem;color:var(--text3);">Unit Sqft</div><div style="font-weight:600;">' + totalUnitSqft.toLocaleString() + '</div></div>';
        sh += '<div><div style="font-size:0.72rem;color:var(--text3);">Analyzed</div><div style="font-weight:600;">' + unitsWithRev + '/' + d.children.length + '</div></div>';
        sh += '</div>';

        // Revenue / Cost / Net grid
        sh += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:12px;background:var(--bg);border-radius:6px;margin-bottom:10px;">';
        sh += '<div style="text-align:center;"><div style="font-size:0.72rem;color:var(--text3);">Total Revenue</div><div style="font-weight:700;color:var(--accent);font-family:\'DM Mono\',monospace;font-size:1.05rem;">$' + Math.round(totalUnitRev).toLocaleString() + '<span style="font-size:0.72rem;font-weight:400;color:var(--text3);">/mo</span></div></div>';
        sh += '<div style="text-align:center;"><div style="font-size:0.72rem;color:var(--text3);">Total Costs</div><div style="font-weight:700;color:var(--danger);font-family:\'DM Mono\',monospace;font-size:1.05rem;">$' + Math.round(totalAllCosts).toLocaleString() + '<span style="font-size:0.72rem;font-weight:400;color:var(--text3);">/mo</span></div></div>';
        var netColor = netIncome >= 0 ? 'var(--accent)' : 'var(--danger)';
        sh += '<div style="text-align:center;"><div style="font-size:0.72rem;color:var(--text3);">Net Income</div><div style="font-weight:700;color:' + netColor + ';font-family:\'DM Mono\',monospace;font-size:1.05rem;">' + (netIncome >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(netIncome)).toLocaleString() + '<span style="font-size:0.72rem;font-weight:400;color:var(--text3);">/mo</span></div></div>';
        sh += '</div>';

        // Cost breakdown
        if (totalAllCosts > 0) {
          sh += '<div style="font-size:0.78rem;color:var(--text2);margin-bottom:8px;">';
          if (totalBldgCost > 0) {
            sh += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">';
            sh += '<span>Building costs</span><span style="font-family:\'DM Mono\',monospace;">$' + Math.round(totalBldgCost).toLocaleString() + '/mo</span></div>';
            if (bExp > 0) {
              sh += '<div style="display:flex;justify-content:space-between;padding:2px 0 2px 12px;color:var(--text3);font-size:0.72rem;">';
              if (p.ownership_type === 'purchased') {
                var parts = [];
                if (p.monthly_mortgage) parts.push('Mortgage $' + p.monthly_mortgage.toLocaleString());
                if (p.monthly_insurance) parts.push('Insurance $' + p.monthly_insurance.toLocaleString());
                if (p.annual_taxes) parts.push('Taxes $' + Math.round(p.annual_taxes / 12).toLocaleString());
                if (p.hoa_monthly) parts.push('HOA $' + p.hoa_monthly.toLocaleString());
                sh += '<span>' + parts.join(' · ') + '</span>';
              } else {
                sh += '<span>Rent $' + (p.monthly_rent_cost || 0).toLocaleString() + '</span>';
              }
              sh += '</div>';
            }
            if (bUtil > 0) {
              sh += '<div style="display:flex;justify-content:space-between;padding:2px 0 2px 12px;color:var(--text3);font-size:0.72rem;">';
              sh += '<span>Utilities $' + Math.round(bUtil).toLocaleString() + '</span></div>';
            }
          }
          if (totalUnitCosts > 0) {
            sh += '<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">';
            sh += '<span>Unit costs (all units)</span><span style="font-family:\'DM Mono\',monospace;">$' + Math.round(totalUnitCosts).toLocaleString() + '/mo</span></div>';
          }
          sh += '</div>';
        }

        // Annual projections + metrics
        if (totalUnitRev > 0 || totalAllCosts > 0) {
          var annualNet = netIncome * 12;
          var capRate = (p.estimated_value || p.purchase_price) ? Math.round(annualNet / (p.estimated_value || p.purchase_price) * 10000) / 100 : 0;
          var cashOnCash = p.purchase_price ? Math.round(annualNet / p.purchase_price * 10000) / 100 : 0;
          sh += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:0.78rem;color:var(--text2);">';
          sh += '<span>Annual rev: $' + Math.round(totalUnitRev * 12).toLocaleString() + '</span>';
          sh += '<span>Annual costs: $' + Math.round(totalAllCosts * 12).toLocaleString() + '</span>';
          sh += '<span style="font-weight:600;color:' + netColor + ';">Annual net: $' + Math.round(annualNet).toLocaleString() + '</span>';
          if (capRate) sh += '<span>Cap: ' + capRate + '%</span>';
          if (cashOnCash) sh += '<span>CoC: ' + cashOnCash + '%</span>';
          sh += '</div>';
        }
        sh += '</div>';
        buildingSumEl.innerHTML = sh;
        buildingSumEl.style.display = '';

      } else if (!isBuilding && !isUnit) {
        // ── PROPERTY OVERVIEW (non-building, non-unit) ──
        var propRev = 0;
        var latestStrat = (d.strategies || [])[0];
        if (latestStrat) propRev = latestStrat.projected_monthly_avg || 0;
        var propIsManaged = p.is_managed || p.ownership_type === 'managed';

        if (propIsManaged) {
          var ph = '<div style="padding:16px;background:var(--surface2);border:1px solid rgba(96,165,250,0.3);border-radius:8px;">';
          ph += '<h3 style="font-size:0.92rem;margin-bottom:8px;">' + _ico('handshake', 13) + ' Managed Property</h3>';
          ph += '<div style="font-size:0.82rem;color:var(--text2);line-height:1.6;">';
          ph += 'Owner: <strong>' + esc(p.owner_name || 'Not set') + '</strong>';
          if (p.management_fee_pct) ph += ' · Management fee: <strong>' + p.management_fee_pct + '%</strong>';
          ph += '</div>';
          ph += '<div style="font-size:0.72rem;color:var(--text3);margin-top:6px;">Revenue and costs excluded from your portfolio totals.</div>';
          ph += '</div>';
          buildingSumEl.innerHTML = ph;
          buildingSumEl.style.display = '';
        } else {
          var propCost = 0;
          if (p.ownership_type === 'rental') { propCost = p.monthly_rent_cost || 0; }
          else { propCost = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0); }
          var propUtil = (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);
          var propTotalCost = propCost + propUtil;
          var propNet = propRev - propTotalCost;
          if (propRev > 0 || propTotalCost > 0) {
            var ph = '<div style="padding:16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;">';
            ph += '<h3 style="font-size:0.92rem;margin-bottom:12px;">Property Overview</h3>';
            ph += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:12px;background:var(--bg);border-radius:6px;margin-bottom:8px;">';
            ph += '<div style="text-align:center;"><div style="font-size:0.72rem;color:var(--text3);">Revenue</div><div style="font-weight:700;color:var(--accent);font-family:\'DM Mono\',monospace;font-size:1.05rem;">' + (propRev > 0 ? '$' + Math.round(propRev).toLocaleString() : '—') + '<span style="font-size:0.72rem;font-weight:400;color:var(--text3);">/mo</span></div></div>';
            ph += '<div style="text-align:center;"><div style="font-size:0.72rem;color:var(--text3);">Costs</div><div style="font-weight:700;color:' + (propTotalCost > 0 ? 'var(--danger)' : 'var(--text3)') + ';font-family:\'DM Mono\',monospace;font-size:1.05rem;">' + (propTotalCost > 0 ? '$' + Math.round(propTotalCost).toLocaleString() : '—') + '<span style="font-size:0.72rem;font-weight:400;color:var(--text3);">/mo</span></div></div>';
            if (propRev > 0 && propTotalCost > 0) {
              var pnColor = propNet >= 0 ? 'var(--accent)' : 'var(--danger)';
              ph += '<div style="text-align:center;"><div style="font-size:0.72rem;color:var(--text3);">Net</div><div style="font-weight:700;color:' + pnColor + ';font-family:\'DM Mono\',monospace;font-size:1.05rem;">' + (propNet >= 0 ? '+' : '-') + '$' + Math.abs(Math.round(propNet)).toLocaleString() + '<span style="font-size:0.72rem;font-weight:400;color:var(--text3);">/mo</span></div></div>';
            } else {
              ph += '<div style="text-align:center;"><div style="font-size:0.72rem;color:var(--text3);">Net</div><div style="font-weight:400;color:var(--text3);font-size:0.85rem;">Run analysis</div></div>';
            }
            ph += '</div>';
            if (propTotalCost > 0) {
              ph += '<div style="font-size:0.78rem;color:var(--text2);">';
              if (propCost > 0) {
                if (p.ownership_type === 'rental') { ph += '<span>Rent: $' + (p.monthly_rent_cost || 0).toLocaleString() + '</span>'; }
                else { var parts=[]; if(p.monthly_mortgage)parts.push('Mortgage $'+p.monthly_mortgage.toLocaleString()); if(p.monthly_insurance)parts.push('Ins $'+p.monthly_insurance.toLocaleString()); if(p.annual_taxes)parts.push('Tax $'+Math.round(p.annual_taxes/12).toLocaleString()); if(p.hoa_monthly)parts.push('HOA $'+p.hoa_monthly.toLocaleString()); ph+='<span>'+parts.join(' · ')+'</span>'; }
              }
              if (propUtil > 0) ph += (propCost > 0 ? ' · ' : '') + '<span>Utils $' + Math.round(propUtil).toLocaleString() + '</span>';
              ph += '</div>';
            }
            if (propRev > 0) { var annNet=propNet*12; var cap=(p.estimated_value||p.purchase_price)?Math.round(annNet/(p.estimated_value||p.purchase_price)*10000)/100:0; ph+='<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:0.78rem;color:var(--text2);">'; ph+='<span>$'+Math.round(propRev*12).toLocaleString()+'/yr rev</span>'; if(propTotalCost>0)ph+='<span style="font-weight:600;color:'+(annNet>=0?'var(--accent)':'var(--danger)')+';">$'+Math.round(annNet).toLocaleString()+'/yr net</span>'; if(cap)ph+='<span>Cap: '+cap+'%</span>'; ph+='</div>'; }
            ph += '</div>';
            buildingSumEl.innerHTML = ph;
            buildingSumEl.style.display = '';
          } else {
            buildingSumEl.style.display = 'none';
            buildingSumEl.innerHTML = '';
          }
        }

      } else {
        buildingSumEl.style.display = 'none';
        buildingSumEl.innerHTML = '';
      }
    }
    var strats = d.strategies || [];
    var coordEl = document.getElementById('coordDisplay');
    if (coordEl) {
      var coordStr = '';
      if (p.latitude && p.longitude) {
        coordStr = '' + _ico('mapPin', 13) + ' ' + p.latitude.toFixed(6) + ', ' + p.longitude.toFixed(6) + ' <a href="https://maps.google.com/?q=' + p.latitude + ',' + p.longitude + '" target="_blank" style="font-size:0.72rem;">Open Map →</a>';
      } else {
        coordStr = '' + _ico('mapPin', 13) + ' No coordinates — enter manually below or run Lookup';
      }
      if (strats.length > 0) {
        var latest = strats[0];
        var isLTR = latest.min_nights >= 365 || (latest.strategy_name || '').includes('LTR');
        coordStr += '<div style="margin-top:10px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;">';
        coordStr += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
        coordStr += '<span style="font-weight:600;font-size:0.85rem;color:var(--text);">Latest: ' + esc(latest.strategy_name) + '</span>';
        coordStr += '<span style="font-size:0.72rem;color:var(--text3);">' + (latest.created_at || '').substring(0, 10) + '</span></div>';
        coordStr += '<div style="display:flex;gap:16px;flex-wrap:wrap;font-size:0.85rem;">';
        if (isLTR) {
          coordStr += '<span><strong style="color:var(--accent);">$' + (latest.base_nightly_rate || 0).toLocaleString() + '/mo</strong></span>';
        } else {
          coordStr += '<span>$' + latest.base_nightly_rate + '/nt</span>';
          coordStr += '<span>Wknd $' + latest.weekend_rate + '</span>';
          coordStr += '<span>Occ ' + Math.round(latest.projected_occupancy * 100) + '%</span>';
        }
        coordStr += '<span style="color:var(--accent);font-weight:700;">$' + Math.round(latest.projected_monthly_avg || 0).toLocaleString() + '/mo</span>';
        coordStr += '<span style="color:var(--text3);">$' + Math.round(latest.projected_annual_revenue || 0).toLocaleString() + '/yr</span>';
        coordStr += '</div>';
        if (latest.reasoning) {
          var aiTag = latest.ai_generated ? '<span style="color:var(--purple);font-size:0.72rem;">' + _ico('sparkle', 13, 'var(--purple)') + ' AI</span> ' : '';
          coordStr += '<div style="margin-top:8px;font-size:0.78rem;color:var(--text2);line-height:1.5;">' + aiTag + esc(latest.reasoning).substring(0, 250) + (latest.reasoning.length > 250 ? '...' : '') + '</div>';
        }
        coordStr += '<div style="margin-top:6px;font-size:0.72rem;color:var(--text3);">' + strats.length + ' total strateg' + (strats.length === 1 ? 'y' : 'ies') + ' · ' + (d.comparables || []).length + ' comps — <a href="#" onclick="event.preventDefault();switchPropTab(\'history\')" style="color:var(--accent);">View history →</a></div>';
        coordStr += '</div>';
      }
      coordEl.innerHTML = coordStr;
      coordEl.style.display = '';
    }

    // Show/hide tabs based on property type
    var unitsTab = document.getElementById('unitsTab');
    var amenitiesTab = document.querySelector('#propSubTabs [data-ptab="amenities"]');
    var isParentBuilding = (p.property_type === 'multi_family' || (d.children && d.children.length > 0)) && !p.parent_id;
    var isChildUnit = !!p.parent_id;

    // Building: show Units tab, hide Amenities (amenities go on individual units)
    // Unit: show Amenities, hide Units
    // Regular property: show Amenities, hide Units
    if (unitsTab) unitsTab.style.display = isParentBuilding ? '' : 'none';
    if (amenitiesTab) amenitiesTab.style.display = isParentBuilding ? 'none' : '';

    // Load history
    renderPropertyHistory(d);

    // Load amenities tab
    renderPropertyAmenities(d.amenities || [], p.id);

    // Load units
    renderPropertyUnits(d.children || [], p);

    // PriceLabs linked data (not shown for buildings — PL links go on individual units)
    var plEl = document.getElementById('plPropertyInfo');
    if (plEl) {
      var plh = '';
      var isBldg = isBuilding || (d.children && d.children.length > 0);
      if (isBldg || p.is_research) {
        plh = '';
        window._plPropertyData = null;
      } else if (d.pricelabs && d.pricelabs.linked) {
        var pl = d.pricelabs;
        plh = '<div style="padding:14px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);border-radius:8px;">';
        plh += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
        plh += '<label style="font-size:0.78rem;color:var(--purple);font-weight:600;">' + _ico('barChart', 13) + ' PRICELABS — LINKED</label>';
        var syncInfo = [];
        if (pl.last_synced) syncInfo.push('Synced: ' + fmtUTC(pl.last_synced));
        if (pl.push_enabled) syncInfo.push('✓ Push enabled');
        if (pl.last_date_pushed) syncInfo.push('Pushed: ' + pl.last_date_pushed.substring(0, 10));
        plh += '<span style="font-size:0.68rem;color:var(--text3);">' + syncInfo.join(' · ') + '</span>';
        plh += '</div>';

        // Listing metadata
        var meta = [];
        if (pl.pl_listing_name) meta.push('<strong>' + esc(pl.pl_listing_name) + '</strong>');
        if (pl.pl_pms) meta.push('PMS: ' + esc(pl.pl_pms));
        if (pl.group_name) meta.push('Group: ' + esc(pl.group_name));
        if (pl.bedrooms) meta.push(pl.bedrooms + 'BR');
        if (pl.tags) meta.push('Tags: ' + esc(pl.tags));
        if (meta.length > 0) plh += '<div style="font-size:0.78rem;color:var(--text2);margin-bottom:10px;">' + meta.join(' · ') + '</div>';

        // Channel listings
        if (pl.channels && pl.channels.length > 0) {
          plh += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">';
          pl.channels.forEach(function(ch) {
            var icon = ch.channel_name === 'airbnb' ? '' + _ico('home', 13) + '' : ch.channel_name === 'bookingcom' ? _ico('globe',15) : '' + _ico('clipboard', 13) + '';
            plh += '<span style="font-size:0.72rem;padding:3px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;">' + icon + ' ' + esc(ch.channel_name) + ' <span style="color:var(--text3);">#' + esc(String(ch.channel_listing_id)) + '</span></span>';
          });
          plh += '</div>';
        }

        // Pricing grid
        function plCard(label, value, color, sub) {
          return '<div style="text-align:center;padding:6px;background:var(--surface);border-radius:6px;"><div style="font-size:0.65rem;color:var(--text3);">' + label + '</div><div style="font-family:DM Mono,monospace;font-weight:700;color:' + (color || 'var(--text)') + ';">' + value + '</div>' + (sub ? '<div style="font-size:0.58rem;color:var(--text3);">' + sub + '</div>' : '') + '</div>';
        }
        plh += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:6px;margin-bottom:10px;">';
        plh += plCard('Base Price', '$' + (pl.base_price || '—') + '/nt', 'var(--purple)');
        plh += plCard('Rec. Base', pl.recommended_base_price ? '$' + pl.recommended_base_price + '/nt' : '—', pl.recommended_base_price ? 'var(--accent)' : 'var(--text3)', 'PriceLabs suggests');
        plh += plCard('Min', '$' + (pl.min_price || '—'), 'var(--danger)', 'floor');
        plh += plCard('Max', '$' + (pl.max_price || '—'), 'var(--text2)', 'ceiling');
        plh += plCard('Cleaning', pl.cleaning_fees ? '$' + pl.cleaning_fees : '—', 'var(--text)');
        plh += plCard('Proj. Monthly', pl.projected_monthly ? '$' + pl.projected_monthly.toLocaleString() : '—', pl.projected_monthly ? 'var(--accent)' : 'var(--text3)');
        plh += '</div>';

        // Occupancy comparison grid
        if (pl.occupancy_next_7 || pl.occupancy_next_30) {
          plh += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;">';
          var occPeriods = [
            { label: '7-Day', yours: pl.occupancy_next_7, market: pl.market_occupancy_next_7 },
            { label: '30-Day', yours: pl.occupancy_next_30, market: pl.market_occupancy_next_30 },
            { label: '60-Day', yours: pl.occupancy_next_60, market: pl.market_occupancy_next_60 },
          ];
          occPeriods.forEach(function(o) {
            if (!o.yours) return;
            var yoursNum = parseInt(o.yours) || 0;
            var mktNum = parseInt(o.market) || 0;
            var diff = yoursNum - mktNum;
            var diffColor = diff > 0 ? 'var(--accent)' : diff < 0 ? 'var(--danger)' : 'var(--text3)';
            plh += '<div style="padding:8px;background:var(--surface);border-radius:6px;text-align:center;">';
            plh += '<div style="font-size:0.62rem;color:var(--text3);">' + o.label + ' Occupancy</div>';
            plh += '<div style="font-family:DM Mono,monospace;font-weight:700;font-size:1rem;color:var(--purple);">' + esc(o.yours) + '</div>';
            plh += '<div style="font-size:0.62rem;color:var(--text3);">Market: ' + esc(o.market || '—') + '</div>';
            if (diff !== 0) plh += '<div style="font-size:0.62rem;color:' + diffColor + ';font-weight:600;">' + (diff > 0 ? '+' : '') + diff + '% vs market</div>';
            plh += '</div>';
          });
          plh += '</div>';
        }

        plh += '<button class="btn btn-xs btn-purple" onclick="applyPriceLabsToProperty()" style="font-size:0.72rem;">Apply PriceLabs Data to Property Fields</button>';
        plh += '</div>';
        window._plPropertyData = pl;
      } else if (d.pricelabs && !d.pricelabs.linked && d.pricelabs.available_listings) {
        // PriceLabs has listings but none linked to this property
        var avail = d.pricelabs.available_listings;
        plh = '<div style="padding:14px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:8px;">';
        plh += '<label style="font-size:0.78rem;color:var(--purple);font-weight:600;">' + _ico('barChart', 13) + ' PRICELABS</label>';
        if (avail.length > 0) {
          plh += '<div style="font-size:0.78rem;color:var(--text2);margin:8px 0;">Link a PriceLabs listing to see dynamic pricing data here:</div>';
          plh += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
          plh += '<select id="plLinkSelect" style="font-size:0.78rem;padding:4px 8px;flex:1;min-width:200px;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);">';
          plh += '<option value="">Select a PriceLabs listing...</option>';
          avail.forEach(function(l) {
            plh += '<option value="' + l.id + '">' + esc(l.name || l.pl_listing_id) + (l.platform ? ' (' + l.platform + ')' : '') + (l.base_price ? ' — $' + l.base_price + '/nt' : '') + '</option>';
          });
          plh += '</select>';
          plh += '<button class="btn btn-xs btn-purple" onclick="linkPLFromProperty()">Link</button>';
          plh += '</div>';
        } else {
          plh += '<div style="font-size:0.78rem;color:var(--text3);margin-top:6px;">All PriceLabs listings are already linked. Sync more from the PriceLabs tab.</div>';
        }
        plh += '</div>';
        window._plPropertyData = null;
      } else if (d.pl_available) {
        plh = '<div style="padding:10px 14px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.1);border-radius:8px;">';
        plh += '<span style="font-size:0.78rem;color:var(--text3);">' + _ico('barChart', 13) + ' PriceLabs listings available — link one in the PriceLabs tab to see dynamic pricing data here.</span>';
        plh += '</div>';
        window._plPropertyData = null;
      } else {
        plh = '';
        window._plPropertyData = null;
      }
      plEl.innerHTML = plh;
      plEl.style.display = plh ? '' : 'none';
    }

    var _startTab = initialTab || 'details';
    switchPropTab(_startTab);
    switchView('addProperty');
    // Inject SVG icons into property section headers (replaces emoji)
    var _sectionIcons = { '🏷️': 'tag', '📡': 'link', '🏦': 'home', '🔑': 'key', '🤝': 'handshake', '💸': 'wallet', '⚙️': 'settings', '⚠️': 'alert', '🔨': 'layers', '📸': 'eye', '📈': 'trendUp', '🏘️': 'building', '🔍': 'search', '📊': 'barChart', '🏠': 'home', '📋': 'receipt' };
    document.querySelectorAll('#view-addProperty .prop-section-hdr .icon').forEach(function(el) {
      var txt = el.textContent.trim();
      if (_sectionIcons[txt]) el.innerHTML = _ico(_sectionIcons[txt], 15);
    });
    // Push to nav history so back button works
    var _propLabel = (p.name || p.address || ('Property #' + id));
    _navPush({ type: 'property', id: id, tab: _startTab, label: _propLabel });
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

function switchPropTab(tab) {
  ['details','amenities','history','units','platforms','pricing','finance','calendar','research'].forEach(function(t) {
    var el = document.getElementById('propTab-' + t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  // Render revenue snapshot when entering pricing tab
  if (tab === 'pricing') {
    var editId = document.getElementById('f_editId').value;
    if (editId) {
      renderRevenueSnapshot(editId);
      loadSavedReports(editId);
      loadSavedStrategies(editId);
      if (typeof loadPLComparePanel === 'function') loadPLComparePanel(editId, null);
      if (typeof loadPlCustomizations === 'function' && _currentPropData) loadPlCustomizations(_currentPropData);
    }
    var acqBtn = document.getElementById('genAcqBtn');
    var acqSection = document.getElementById('acquisitionSection');
    if (acqBtn) {
      var resEl = document.getElementById('f_research');
      var isResearch = resEl && resEl.checked;
      acqBtn.style.display = isResearch ? '' : 'none';
      if (acqSection) acqSection.style.display = isResearch ? '' : 'none';
    }
  }
  if (tab === 'finance') {
    var fEditId = document.getElementById('f_editId').value;
    if (fEditId) renderPropertyFinance(fEditId);
  }
  document.querySelectorAll('#propSubTabs .tab').forEach(function(btn) {
    var active = btn.dataset.ptab === tab;
    btn.classList.toggle('active', active);
    btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    btn.style.color = active ? 'var(--accent)' : 'var(--text3)';
  });
  if (tab === 'platforms') {
    var editId = (document.getElementById('f_editId') || {}).value;
    if (editId) loadPropertyPlatforms(editId);
  }
  if (tab === 'calendar') {
    var calEditId = (document.getElementById('f_editId') || {}).value;
    if (calEditId) loadPropertyCalendar(calEditId);
  }
  if (tab === 'research') {
    var resEditId = (document.getElementById('f_editId') || {}).value;
    if (resEditId) renderResearchTab(resEditId);
  }

}

function renderPropertyHistory(data) {
  var el = document.getElementById('propHistoryContent');
  if (!el) return;
  var strats = data.strategies || [];
  var comps = data.comparables || [];
  if (strats.length === 0 && comps.length === 0) {
    el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No analysis history yet. Run a pricing analysis first.</p>';
    return;
  }
  var h = '';
  // Previous pricing strategies
  if (strats.length > 0) {
    h += '<h4 style="margin-bottom:10px;font-size:0.88rem;">Pricing Analyses (' + strats.length + ')</h4>';
    h += '<div style="max-height:350px;overflow-y:auto;margin-bottom:20px;">';
    strats.forEach(function(s, i) {
      var date = fmtUTC(s.created_at);
      var isAi = s.ai_generated === 1;
      var isLTR = s.min_nights >= 365 || (s.strategy_name || '').includes('LTR');
      h += '<div style="padding:10px 14px;margin-bottom:6px;background:' + (isAi ? 'var(--purple-dim)' : 'var(--surface2)') + ';border:1px solid ' + (isAi ? 'rgba(167,139,250,0.2)' : 'var(--border)') + ';border-radius:8px;font-size:0.82rem;">';
      h += '<div style="display:flex;justify-content:space-between;margin-bottom:4px;"><strong>' + esc(s.strategy_name) + '</strong><span style="color:var(--text3);font-size:0.72rem;">' + date + '</span></div>';
      if (isLTR) {
        h += '<span style="color:var(--accent);">$' + (s.base_nightly_rate || 0).toLocaleString() + '/mo</span> · ';
      } else {
        h += '<span style="color:var(--accent);">$' + s.base_nightly_rate + '/nt</span> · $' + s.weekend_rate + ' wknd · ';
      }
      h += 'Occ: ' + Math.round(s.projected_occupancy * 100) + '% · <strong style="color:var(--accent);">$' + (s.projected_monthly_avg || 0).toLocaleString() + '/mo</strong>';
      if (s.cleaning_fee > 0) h += ' · Clean: $' + s.cleaning_fee;
      // Show full reasoning/analysis - expandable
      var fullText = s.reasoning || '';
      if (fullText.length > 200) {
        var shortText = fullText.substring(0, 200);
        h += '<div style="margin-top:6px;color:var(--text2);font-size:0.78rem;line-height:1.5;">';
        h += '<span id="hist_short_' + (s.id || i) + '">' + esc(shortText) + '... <a href="#" onclick="event.preventDefault();document.getElementById(\'hist_full_' + (s.id || i) + '\').style.display=\'\';document.getElementById(\'hist_short_' + (s.id || i) + '\').style.display=\'none\';" style="color:var(--purple);">Show more</a></span>';
        h += '<span id="hist_full_' + (s.id || i) + '" style="display:none;">';
        fullText.split(/\n\n|\n/).forEach(function(para) {
          if (para.trim()) h += '<p style="margin:0 0 6px 0;">' + esc(para.trim()) + '</p>';
        });
        h += '</span></div>';
      } else if (fullText) {
        h += '<div style="margin-top:6px;color:var(--text2);font-size:0.78rem;line-height:1.5;">' + esc(fullText) + '</div>';
      }
      h += '</div>';
    });
    h += '</div>';
  }
  // Previous comparables
  if (comps.length > 0) {
    h += '<h4 style="margin-bottom:10px;font-size:0.88rem;">Comparable History (' + comps.length + ')</h4>';
    h += '<table class="comp-table"><thead><tr><th>Date</th><th>Source</th><th>Title</th><th>BR/BA</th><th>Rate</th><th>Rating</th></tr></thead><tbody>';
    comps.slice(0, 30).forEach(function(c) {
      h += '<tr><td style="font-size:0.72rem;">' + (c.scraped_at || '').substring(0, 10) + '</td><td>' + esc(c.source || '') + '</td><td>' + esc((c.title || '').substring(0, 40)) + '</td><td>' + (c.bedrooms || '?') + '/' + (c.bathrooms || '?') + '</td><td style="color:var(--accent);font-weight:600;">$' + (c.nightly_rate || 0) + '</td><td>' + (c.rating ? c.rating + '★' : '—') + '</td></tr>';
    });
    h += '</tbody></table>';
  }
  el.innerHTML = h;
}

// Property amenities tab
var propAmenitySet = new Set();
async function autoFetchAmenities() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var btn = document.getElementById('autoAmenBtn');
  var status = document.getElementById('autoAmenStatus');
  if (btn) { btn.disabled = true; btn.innerHTML ='' + _ico('clock', 13) + ' Scanning...'; }
  if (status) status.innerHTML = 'Scanning platform listings and web for amenities...';
  try {
    var d = await api('/api/properties/' + editId + '/auto-amenities', 'POST');
    if (status) {
      var h = '';
      if (d.added > 0) h += '<span style="color:var(--accent);">✓ Added ' + d.added + ' amenities</span>';
      else h += '<span style="color:var(--text3);">No new amenities found</span>';
      h += ' · Sources: ' + (d.sources || []).join(', ');
      if (d.found && d.found.length > 0) h += '<br><span style="font-size:0.72rem;color:var(--text3);">Detected: ' + d.found.join(', ') + '</span>';
      status.innerHTML = h;
    }
    if (d.added > 0) {
      toast('Added ' + d.added + ' amenities!');
      // Reload amenities
      var propD = await api('/api/properties/' + editId);
      renderPropertyAmenities(propD.amenities || [], editId);
    }
  } catch (err) {
    if (status) status.innerHTML = '<span style="color:var(--danger);">' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.innerHTML ='' + _ico('search', 13) + ' Auto-Detect Amenities'; }
}

function renderPropertyAmenities(currentAmenities, propertyId) {
  var el = document.getElementById('propAmenitiesContent');
  if (!el) return;
  propAmenitySet = new Set(currentAmenities.map(function(a) { return a.id; }));

  // Group amenities by category
  var catOrder = ['outdoor','kitchen','entertainment','comfort','safety','workspace','location','parking','unique'];
  var catLabels = {outdoor:_ico('home',13) + ' Outdoor',kitchen:_ico('home',13) + ' Kitchen',entertainment:_ico('zap',13) + ' Entertainment',comfort:_ico('home',13) + ' Comfort',safety:_ico('shield',13) + ' Safety',workspace:_ico('cpu',13) + ' Workspace',location:_ico('mapPin',13) + ' Location',parking:_ico('mapPin',13) + ' Parking',unique:_ico('sparkle',13) + ' Unique / Special'};
  var grouped = {};
  amenities.forEach(function(a) {
    var c = a.category || 'unique';
    if (!grouped[c]) grouped[c] = [];
    grouped[c].push(a);
  });

  var totalBoost = 0;
  propAmenitySet.forEach(function(id) {
    var am = amenities.find(function(a) { return a.id === id; });
    if (am) totalBoost += (am.impact_score || 0);
  });

  var h = '';

  // ── Top bar: summary + bulk actions ──────────────────────────────────────
  h += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">';
  h += '<span style="font-size:0.82rem;font-weight:600;color:var(--text2);"><span id="amenSelCount">' + propAmenitySet.size + '</span> selected · <span style="color:var(--accent);">+<span id="amenBoostTotal">' + Math.round(totalBoost) + '</span>% impact</span></span>';
  h += '<div style="margin-left:auto;display:flex;gap:6px;align-items:center;">';
  h += '<input id="amenSearch" oninput="filterAmenityChips()" placeholder="Search amenities…" style="font-size:0.75rem;padding:4px 8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);width:160px;" autocomplete="off">';
  h += '<button class="btn btn-xs" onclick="bulkSelectAmenities(' + propertyId + ', true)">✓ All</button>';
  h += '<button class="btn btn-xs" onclick="bulkSelectAmenities(' + propertyId + ', false)">✕ None</button>';
  h += '<button class="btn btn-primary btn-sm" onclick="savePropAmenities(' + propertyId + ')">' + _ico('database', 13) + ' Save</button>';
  h += '<span id="propAmenSaveStatus" style="font-size:0.72rem;color:var(--accent);"></span>';
  h += '</div></div>';

  // ── Category sections ─────────────────────────────────────────────────────
  h += '<div id="amenCategoryList">';
  catOrder.forEach(function(cat) {
    var items = grouped[cat];
    if (!items || items.length === 0) return;
    var catSel = items.filter(function(a) { return propAmenitySet.has(a.id); }).length;
    h += '<div class="amen-cat-section" data-cat="' + cat + '" style="margin-bottom:14px;">';
    // Category header with toggle-all
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
    h += '<span style="font-size:0.78rem;font-weight:600;color:var(--text2);">' + (catLabels[cat] || cat) + '</span>';
    h += '<span style="font-size:0.68rem;color:var(--text3);">(' + catSel + '/' + items.length + ')</span>';
    h += '<button class="btn btn-xs" style="padding:1px 6px;font-size:0.62rem;" onclick="bulkSelectCategory(&quot;' + cat + '&quot;,' + propertyId + ',true)">all</button>';
    h += '<button class="btn btn-xs" style="padding:1px 6px;font-size:0.62rem;" onclick="bulkSelectCategory(&quot;' + cat + '&quot;,' + propertyId + ',false)">none</button>';
    h += '</div>';
    h += '<div class="chip-container">';
    items.forEach(function(a) {
      var sel = propAmenitySet.has(a.id) ? ' selected' : '';
      h += '<div class="chip' + sel + '" data-name="' + esc(a.name.toLowerCase()) + '" data-cat="' + cat + '" data-id="' + a.id + '" onclick="togglePropAmenity(' + a.id + ',' + propertyId + ')">' + esc(a.name) + '<span class="score">+' + a.impact_score + '%</span></div>';
    });
    h += '</div></div>';
  });
  h += '</div>';

  el.innerHTML = h;
}

function filterAmenityChips() {
  var q = (document.getElementById('amenSearch') || {}).value || '';
  q = q.toLowerCase().trim();
  document.querySelectorAll('#amenCategoryList .chip').forEach(function(chip) {
    var name = chip.getAttribute('data-name') || '';
    chip.style.display = (!q || name.includes(q)) ? '' : 'none';
  });
  // Hide empty category sections
  document.querySelectorAll('.amen-cat-section').forEach(function(sec) {
    var visible = sec.querySelectorAll('.chip:not([style*="display: none"]):not([style*="display:none"])').length;
    sec.style.display = visible ? '' : 'none';
  });
}

function bulkSelectAmenities(propertyId, select) {
  amenities.forEach(function(a) {
    if (select) propAmenitySet.add(a.id);
    else propAmenitySet.delete(a.id);
  });
  var currentList = [];
  propAmenitySet.forEach(function(id) { var am = amenities.find(function(a) { return a.id === id; }); if (am) currentList.push(am); });
  renderPropertyAmenities(currentList, propertyId);
}

function bulkSelectCategory(cat, propertyId, select) {
  amenities.filter(function(a) { return a.category === cat; }).forEach(function(a) {
    if (select) propAmenitySet.add(a.id);
    else propAmenitySet.delete(a.id);
  });
  var currentList = [];
  propAmenitySet.forEach(function(id) { var am = amenities.find(function(a) { return a.id === id; }); if (am) currentList.push(am); });
  renderPropertyAmenities(currentList, propertyId);
}

function togglePropAmenity(amenityId, propertyId) {
  if (propAmenitySet.has(amenityId)) propAmenitySet.delete(amenityId);
  else propAmenitySet.add(amenityId);
  // Update chip visual in place (avoid full re-render which loses search state)
  var chip = document.querySelector('#amenCategoryList .chip[data-id="' + amenityId + '"]');
  if (chip) {
    if (propAmenitySet.has(amenityId)) chip.classList.add('selected');
    else chip.classList.remove('selected');
  }
  // Update summary counts
  var totalBoost = 0;
  propAmenitySet.forEach(function(id) { var am = amenities.find(function(a) { return a.id === id; }); if (am) totalBoost += (am.impact_score || 0); });
  var selCount = document.getElementById('amenSelCount');
  var boostTotal = document.getElementById('amenBoostTotal');
  if (selCount) selCount.textContent = propAmenitySet.size;
  if (boostTotal) boostTotal.textContent = Math.round(totalBoost);
  // Update category sub-count
  if (chip) {
    var cat = chip.getAttribute('data-cat');
    var catSec = document.querySelector('.amen-cat-section[data-cat="' + cat + '"]');
    if (catSec) {
      var catItems = amenities.filter(function(a) { return a.category === cat; });
      var catSel = catItems.filter(function(a) { return propAmenitySet.has(a.id); }).length;
      var countSpan = catSec.querySelector('span[style*="color:var(--text3)"]');
      if (countSpan) countSpan.textContent = '(' + catSel + '/' + catItems.length + ')';
    }
  }
}

async function savePropAmenities(propertyId) {
  try {
    await api('/api/properties/' + propertyId + '/amenities', 'POST', { amenity_ids: Array.from(propAmenitySet) });
    var statusEl = document.getElementById('propAmenSaveStatus');
    if (statusEl) statusEl.textContent = 'Saved ✓';
    toast('Amenities saved (' + propAmenitySet.size + ')');
  } catch (err) { toast(err.message, 'error'); }
}

function renderPropertyUnits(children, parent) {
  var listEl = document.getElementById('unitsList');
  var summaryEl = document.getElementById('unitsSummary');
  if (!listEl) return;
  if (children.length === 0) {
    listEl.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No units added yet. Add units above.</p>';
    if (summaryEl) summaryEl.innerHTML = '';
    return;
  }
  var totalRev = 0;
  var h = '';
  var totalRentCost = 0;
  children.forEach(function(c) {
    var rev = c.est_monthly_revenue || 0;
    totalRev += rev;
    var unitLabel = getPropertyLabel(c);
    var thumb = c.image_url ? '<img src="' + esc(c.image_url) + '" style="width:64px;height:64px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display=\'none\'">' : '<div style="width:64px;height:64px;background:var(--bg);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1.2rem;color:var(--text3);">' + _ico('home', 13) + '</div>';
    // Per-unit costs
    var uRentCost = c.monthly_rent_cost || 0;
    var uUtil = (c.expense_electric || 0) + (c.expense_gas || 0) + (c.expense_water || 0) + (c.expense_internet || 0) + (c.expense_trash || 0) + (c.expense_other || 0);
    var uTotalCost = uRentCost + uUtil;
    totalRentCost += uTotalCost;
    var uNet = rev - uTotalCost;

    h += '<div style="display:flex;gap:12px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px;cursor:pointer;transition:border-color 0.15s;" onclick="openProperty(' + c.id + ')" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">';
    h += thumb;
    h += '<div style="flex:1;min-width:0;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
    h += '<span style="font-weight:700;font-size:0.95rem;">' + esc(unitLabel) + '</span>';
    // Revenue + cost inline
    h += '<div style="text-align:right;font-family:\'DM Mono\',monospace;">';
    if (rev > 0) {
      h += '<div style="color:var(--accent);font-weight:700;font-size:0.92rem;">$' + Math.round(rev).toLocaleString() + '/mo</div>';
    } else {
      h += '<div style="color:var(--text3);font-size:0.78rem;">No analysis</div>';
    }
    if (uTotalCost > 0) {
      h += '<div style="color:var(--danger);font-size:0.75rem;">-$' + Math.round(uTotalCost).toLocaleString() + ' cost</div>';
    }
    if (rev > 0 && uTotalCost > 0) {
      h += '<div style="color:' + (uNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';font-size:0.75rem;font-weight:600;">' + (uNet >= 0 ? '+' : '') + '$' + Math.round(uNet).toLocaleString() + ' net</div>';
    }
    h += '</div>';
    h += '</div>';
    h += '<div style="font-size:0.82rem;color:var(--text2);">' + (c.bedrooms || 0) + 'BR / ' + (c.bathrooms || 0) + 'BA' + (c.sqft ? ' · ' + c.sqft.toLocaleString() + ' sqft' : '') + ' · ' + esc((c.property_type || 'apartment').replace('_', ' ')) + '</div>';
    // Status badges
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">';
    if (c.amenity_count > 0) h += '<span style="font-size:0.7rem;padding:2px 6px;background:var(--accent-dim);color:var(--accent);border-radius:4px;">' + c.amenity_count + ' amenities</span>';
    if (c.comp_count > 0) h += '<span style="font-size:0.7rem;padding:2px 6px;background:var(--blue-dim);color:var(--blue);border-radius:4px;">' + c.comp_count + ' comps</span>';
    if (c.strategy_count > 0) h += '<span style="font-size:0.7rem;padding:2px 6px;background:var(--purple-dim);color:var(--purple);border-radius:4px;">' + c.strategy_count + ' strategies</span>';
    if (c.latest_strategy) h += '<span style="font-size:0.7rem;padding:2px 6px;background:var(--surface2);color:var(--text3);border-radius:4px;">' + esc(c.latest_strategy) + '</span>';
    if (c.amenity_count === 0 && c.strategy_count === 0) h += '<span style="font-size:0.7rem;color:var(--text3);">Click to set up amenities & run analysis →</span>';
    h += '</div>';
    h += '</div>';
    h += '<button class="btn btn-xs btn-danger" onclick="event.stopPropagation();deleteOneProp(' + c.id + ')" title="Delete" style="align-self:flex-start;margin-top:2px;">✕</button>';
    h += '</div>';
  });
  listEl.innerHTML = h;

  if (summaryEl) {
    var revenueUnits = children.filter(function(c) { return c.est_monthly_revenue > 0; });
    var avgRev = revenueUnits.length > 0 ? Math.round(totalRev / revenueUnits.length) : 0;
    var netIncome = totalRev - totalRentCost;
    // Also include building-level mortgage/insurance/taxes from parent
    var buildingCost = 0;
    if (parent) {
      buildingCost += (parent.monthly_mortgage || 0) + (parent.monthly_insurance || 0) + Math.round((parent.annual_taxes || 0) / 12) + (parent.hoa_monthly || 0);
    }
    var totalCost = totalRentCost + buildingCost;
    var netAfterCosts = totalRev - totalCost;

    var sh = '<div style="padding:14px;background:var(--accent-dim);border:1px solid rgba(74,227,181,0.2);border-radius:8px;">';
    sh += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    sh += '<span style="font-size:0.88rem;font-weight:600;">' + children.length + ' Units</span>';
    sh += '<span style="font-size:1.1rem;font-weight:700;color:var(--accent);font-family:\'DM Mono\',monospace;">$' + Math.round(totalRev).toLocaleString() + '/mo revenue</span>';
    sh += '</div>';
    if (totalRev > 0) {
      sh += '<div style="font-size:0.78rem;color:var(--text2);margin-top:4px;">Avg $' + avgRev.toLocaleString() + '/unit · Projected annual: $' + Math.round(totalRev * 12).toLocaleString() + '</div>';
    }
    if (totalCost > 0) {
      sh += '<div style="font-size:0.78rem;color:var(--text2);margin-top:4px;">';
      if (totalRentCost > 0) sh += 'Unit rent costs: $' + totalRentCost.toLocaleString() + '/mo';
      if (buildingCost > 0) sh += (totalRentCost > 0 ? ' + ' : '') + 'Building costs: $' + buildingCost.toLocaleString() + '/mo';
      sh += '</div>';
      sh += '<div style="font-size:0.88rem;font-weight:700;margin-top:4px;color:' + (netAfterCosts >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">Net: $' + Math.round(netAfterCosts).toLocaleString() + '/mo · $' + Math.round(netAfterCosts * 12).toLocaleString() + '/yr</div>';
    }
    sh += '</div>';
    summaryEl.innerHTML = sh;
  }
}

async function addChildUnit() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save the property first', 'error'); return; }
  var unitNum = (document.getElementById('newUnitNumber') || {}).value || '';
  var beds = parseInt((document.getElementById('newUnitBeds') || {}).value) || 1;
  var baths = parseFloat((document.getElementById('newUnitBaths') || {}).value) || 1;
  var sqft = parseInt((document.getElementById('newUnitSqft') || {}).value) || null;
  if (!unitNum) { toast('Enter a unit number', 'error'); return; }
  try {
    await api('/api/properties/' + editId + '/add-unit', 'POST', { unit_number: unitNum, bedrooms: beds, bathrooms: baths, sqft: sqft });
    toast('Unit ' + unitNum + ' created');
    // Clear inputs
    document.getElementById('newUnitNumber').value = '';
    document.getElementById('newUnitBeds').value = '';
    document.getElementById('newUnitBaths').value = '';
    document.getElementById('newUnitSqft').value = '';
    // Reload
    await openProperty(parseInt(editId));
    switchPropTab('units');
    await loadProperties();
  } catch (err) { toast(err.message, 'error'); }
}

async function pushToUnits() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save building first', 'error'); return; }
  try {
    // Save building data first via direct API
    var gv = function(id) { return (document.getElementById(id) || {}).value || ''; };
    await api('/api/properties/' + editId, 'PUT', {
      address: gv('f_address'), city: gv('f_city'), state: gv('f_state'), zip: gv('f_zip'),
      latitude: parseFloat(gv('f_lat')) || null, longitude: parseFloat(gv('f_lng')) || null,
      year_built: parseInt(gv('f_year')) || null, image_url: gv('f_image') || null,
      sqft: parseInt(gv('f_sqft')) || null, lot_acres: parseFloat(gv('f_lot')) || null,
      stories: parseInt(gv('f_stories')) || null, ownership_type: currentOwnership,
    });
    var d = await api('/api/properties/' + editId + '/push-to-units', 'POST');
    toast(d.message || 'Units synced');
    await openProperty(parseInt(editId));
    switchPropTab('units');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveProperty() {
  var editId = document.getElementById('f_editId').value;
  var gv = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
  var body = {
    name: gv('f_name').trim() || null,
    address: gv('f_address'), city: gv('f_city'), state: gv('f_state').toUpperCase(), zip: gv('f_zip'),
    county: gv('f_county') || null,
    property_type: gv('f_type'),
    bedrooms: parseInt(gv('f_beds')) || 1, bathrooms: parseFloat(gv('f_baths')) || 1,
    sqft: parseInt(gv('f_sqft')) || null, lot_acres: parseFloat(gv('f_lot')) || null,
    year_built: parseInt(gv('f_year')) || null,
    purchase_price: parseFloat(gv('f_price')) || null, estimated_value: parseFloat(gv('f_value')) || null,
    annual_taxes: parseFloat(gv('f_taxes')) || null, tax_rate_pct: parseFloat(gv('f_tax_rate_pct')) || null, hoa_monthly: parseFloat(gv('f_hoa')) || 0,
    image_url: gv('f_image').trim() || null, unit_number: gv('f_unit') || null,
    ownership_type: currentOwnership === 'managed' ? 'managed' : currentOwnership,
    financing_type: currentOwnership === 'purchased' ? currentFinancing : null,
    is_managed: currentOwnership === 'managed' ? 1 : 0,
    owner_name: gv('f_owner_name').trim() || null,
    management_fee_pct: parseFloat(gv('f_mgmt_fee_pct')) || null,
    management_base_fee: parseFloat(gv('f_mgmt_base_fee')) || 0,
    fee_basis: (document.getElementById('f_fee_basis') || {}).value || 'gross',
    rental_restrictions: gv('f_rental_restrictions').trim() || null,
    hoa_name: gv('f_hoa_name').trim() || null,
    ai_notes: gv('f_ai_notes').trim() || null,
    monthly_insurance: parseFloat(gv('f_insurance')) || 0,
    monthly_rent_cost: parseFloat(gv('f_monthly_rent')) || 0,
    security_deposit: parseFloat(gv('f_deposit')) || 0,
    expense_electric: parseFloat(gv('f_electric')) || 0,
    expense_gas: parseFloat(gv('f_gas')) || 0,
    expense_water: parseFloat(gv('f_water')) || 0,
    expense_internet: parseFloat(gv('f_internet')) || 0,
    expense_trash: parseFloat(gv('f_trash')) || 0,
    expense_other: parseFloat(gv('f_other_expense')) || 0,
    cleaning_fee: parseFloat(gv('f_cleaning')) || 0,
    cleaning_cost: parseFloat(gv('f_cleaning_cost')) || 0,
    service_guesty: document.getElementById('f_svc_guesty')?.checked ? 1 : 0,
    service_lock: document.getElementById('f_svc_lock')?.checked ? 1 : 0,
    service_pricelabs: document.getElementById('f_svc_pricelabs')?.checked ? 1 : 0,
    stories: parseInt(gv('f_stories')) || null,
    latitude: parseFloat(gv('f_lat')) || null,
    longitude: parseFloat(gv('f_lng')) || null,
    parking_spaces: parseInt(gv('f_parking')) || null,
    parcel_id: gv('f_parcel') || null,
    zoning: gv('f_zoning') || null,
    listing_url: gv('f_listing_url').trim() || null,
    listing_status: gv('f_listing_status') || null,
    rental_type: gv('f_rental_type') || 'str',
    is_research: document.getElementById('f_research') && document.getElementById('f_research').checked ? 1 : 0,
    purchase_date: gv('f_purchase_date') || null,
    lease_start_date: gv('f_lease_start_date') || null,
  };
  if (!body.address || !body.city || !body.state) { toast('Address, city, and state required', 'error'); return; }
  try {
    if (editId) {
      await api('/api/properties/' + editId, 'PUT', body);
      toast('Property updated');
      await loadProperties();
      switchView('properties');
    } else {
      var res = await api('/api/properties', 'POST', body);
      toast('Property created');
      await loadProperties();
      // Auto-reopen multi-family on Units tab so user can add units immediately
      if (body.property_type === 'multi_family' && res.id) {
        await openProperty(res.id);
        switchPropTab('units');
        toast('Now add your units below', 'info');
      } else if (res.id) {
        // Auto-search for platform listings
        await openProperty(res.id);
        switchPropTab('platforms');
        autoSearchPlatforms();
      } else {
        switchView('properties');
      }
    }
  } catch (err) { toast(err.message, 'error'); }
}

function toggleUnitField() {
  var type = document.getElementById('f_type').value;
  var unitGroup = document.getElementById('unitGroup');
  if (unitGroup) unitGroup.style.display = (type === 'apartment' || type === 'condo' || type === 'multi_family') ? '' : 'none';
  var editId = (document.getElementById('f_editId') || {}).value;
  var isBuilding = type === 'multi_family';
  // Show/hide units tab and amenities tab
  var unitsTab = document.getElementById('unitsTab');
  var amenitiesTab = document.querySelector('#propSubTabs [data-ptab="amenities"]');
  if (unitsTab) unitsTab.style.display = (isBuilding && editId) ? '' : 'none';
  if (amenitiesTab) amenitiesTab.style.display = isBuilding ? 'none' : '';
  // Toggle building vs unit fields
  document.querySelectorAll('.unit-field').forEach(function(el) { el.style.display = isBuilding ? 'none' : ''; });
  document.querySelectorAll('.building-field').forEach(function(el) { el.style.display = isBuilding ? '' : 'none'; });
  var sqftLabel = document.getElementById('sqftLabel');
  if (sqftLabel) sqftLabel.textContent = isBuilding ? 'Total Sqft (building)' : 'Sqft';
  var expLabel = document.getElementById('expenseLabel');
  if (expLabel) expLabel.textContent = isBuilding ? 'BUILDING UTILITIES / SHARED COSTS' : 'MONTHLY EXPENSES';
}

function updateImagePreview() {
  // Legacy — gallery handles previews now
}

function updateNamePreview() {
  var el = document.getElementById('namePreview');
  if (!el) return;
  var name = (document.getElementById('f_name') || {}).value || '';
  if (name) { el.textContent = 'Display: ' + name; return; }
  var addr = (document.getElementById('f_address') || {}).value || '';
  var unit = (document.getElementById('f_unit') || {}).value || '';
  var auto = addr || 'Untitled';
  if (unit) auto += ' - ' + unit;
  el.textContent = 'Auto: ' + auto;
}

// Property photo gallery
var _propertyImages = []; // { id, image_url, caption, source, sort_order }
var currentPropertyId = null;

async function loadPropertyGallery(propId) {
  _propertyImages = [];
  var el = document.getElementById('propertyGallery');
  if (!el) return;
  if (!propId) { renderPropertyGallery(); return; }
  try {
    var d = await api('/api/properties/' + propId + '/images');
    _propertyImages = d.images || [];
  } catch {}
  renderPropertyGallery();
}

function _renderGuestyListingContent(gl) {
  var section = document.getElementById('guestyListingSection');
  var el = document.getElementById('guestyListingContent');
  var srcEl = document.getElementById('guestyListingSource');
  if (!section || !el) return;
  if (!gl) { section.style.display = 'none'; return; }
  section.style.display = '';
  if (srcEl) srcEl.textContent = 'from Guesty' + (gl.guesty_listing_id ? ' · ' + gl.guesty_listing_id : '');

  var h = '';

  // Quick stats row
  var stats = [];
  if (gl.accommodates) stats.push(_ico('users', 12) + ' Sleeps ' + gl.accommodates);
  if (gl.bedrooms) stats.push(_ico('home', 12) + ' ' + gl.bedrooms + ' bed');
  if (gl.bathrooms) stats.push(gl.bathrooms + ' bath');
  if (gl.property_type) stats.push(_ico('tag', 12) + ' ' + esc(gl.property_type));
  if (stats.length > 0) {
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:0.75rem;color:var(--text2);margin-bottom:10px;">' + stats.join('<span style="color:var(--border);">·</span>') + '</div>';
  }

  // Description
  if (gl.description) {
    var desc = gl.description;
    var isLong = desc.length > 400;
    h += '<div style="margin-bottom:10px;">';
    h += '<div style="font-size:0.7rem;font-weight:600;color:var(--text3);margin-bottom:4px;">LISTING DESCRIPTION <span style="font-weight:400;">(' + desc.length + ' chars)</span></div>';
    h += '<div id="guestyDescText" style="font-size:0.78rem;color:var(--text);line-height:1.6;white-space:pre-wrap;' + (isLong ? 'max-height:120px;overflow:hidden;' : '') + '">' + esc(desc) + '</div>';
    if (isLong) {
      h += '<a href="#" onclick="event.preventDefault();var t=document.getElementById(\'guestyDescText\');if(t.style.maxHeight){t.style.maxHeight=\'\';this.textContent=\'Show less\'}else{t.style.maxHeight=\'120px\';this.textContent=\'Show more (' + desc.length + ' chars)\'}" style="font-size:0.7rem;color:var(--accent);">Show more (' + desc.length + ' chars)</a>';
    }
    h += '</div>';
  } else {
    h += '<div style="padding:8px;background:var(--surface2);border-radius:6px;border-left:3px solid var(--danger);margin-bottom:10px;">';
    h += '<div style="font-size:0.75rem;color:var(--danger);font-weight:600;">' + _ico('alertTriangle', 12, 'var(--danger)') + ' No description</div>';
    h += '<div style="font-size:0.7rem;color:var(--text3);margin-top:2px;">This listing has no description from Guesty. Sync your Guesty listings to pull it in, or write one directly in Guesty.</div>';
    h += '</div>';
  }

  // Guesty photos (if any, and different from local gallery)
  if (gl.photos && gl.photos.length > 0) {
    h += '<div style="font-size:0.7rem;font-weight:600;color:var(--text3);margin-bottom:4px;">GUESTY PHOTOS <span style="font-weight:400;">(' + gl.photos.length + ')</span></div>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;max-height:140px;overflow:hidden;" id="guestyPhotoGrid">';
    gl.photos.slice(0, 12).forEach(function(url) {
      h += '<img src="' + esc(url) + '" style="width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);cursor:pointer;" onclick="window.open(\'' + esc(url).replace(/'/g, "\\'") + '\')" onerror="this.style.display=\'none\'" loading="lazy">';
    });
    if (gl.photos.length > 12) {
      h += '<div style="width:60px;height:60px;background:var(--surface2);border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.68rem;color:var(--text3);border:1px solid var(--border);">+' + (gl.photos.length - 12) + '</div>';
    }
    h += '</div>';
  }

  el.innerHTML = h;
}

function renderPropertyGallery() {
  var el = document.getElementById('propertyGallery');
  if (!el) return;
  if (_propertyImages.length === 0) {
    el.innerHTML = '<div style="font-size:0.75rem;color:var(--text3);padding:8px;">No photos yet. Upload or pull from Guesty.</div>';
    return;
  }
  var h = '';
  _propertyImages.forEach(function(img, idx) {
    var isMain = idx === 0;
    h += '<div style="position:relative;width:100px;height:100px;border-radius:8px;overflow:hidden;border:2px solid ' + (isMain ? 'var(--accent)' : 'var(--border)') + ';flex-shrink:0;">';
    h += '<img src="' + esc(img.image_url) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.style.opacity=\'0.3\'">';
    // Delete button
    h += '<button onclick="deletePropertyImage(' + img.id + ')" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,0.6);color:white;border:none;border-radius:50%;width:20px;height:20px;font-size:0.65rem;cursor:pointer;display:flex;align-items:center;justify-content:center;" title="Remove photo">✕</button>';
    // Main badge
    if (isMain) h += '<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(16,185,129,0.85);color:white;font-size:0.6rem;text-align:center;padding:1px;">Main</div>';
    // Source badge
    if (img.source === 'guesty') h += '<div style="position:absolute;top:2px;left:2px;background:rgba(96,165,250,0.85);color:white;font-size:0.65rem;padding:0 3px;border-radius:2px;">G</div>';
    h += '</div>';
  });
  el.innerHTML = h;
  // Update hidden f_image with first image URL
  var hidden = document.getElementById('f_image');
  if (hidden && _propertyImages.length > 0) hidden.value = _propertyImages[0].image_url;
  else if (hidden) hidden.value = '';
}

async function deletePropertyImage(imageId) {
  if (!confirm('Remove this photo?')) return;
  try {
    await api('/api/properties/' + currentPropertyId + '/images/' + imageId, 'DELETE');
    _propertyImages = _propertyImages.filter(function(i) { return i.id !== imageId; });
    renderPropertyGallery();
    toast('Photo removed');
  } catch (err) { toast(err.message, 'error'); }
}

async function addImageFromUrl() {
  var input = document.getElementById('f_image_url_input');
  var url = (input || {}).value || '';
  if (!url) { toast('Paste a URL first', 'error'); return; }
  if (!currentPropertyId) {
    // New property — just add to hidden field, gallery not persisted yet
    var hidden = document.getElementById('f_image');
    if (hidden) hidden.value = url;
    toast('Image URL set — will be saved with property');
    if (input) input.value = '';
    return;
  }
  try {
    var d = await api('/api/properties/' + currentPropertyId + '/images', 'POST', { image_url: url, source: 'url' });
    _propertyImages.push({ id: d.id, image_url: url, source: 'url', sort_order: _propertyImages.length });
    renderPropertyGallery();
    toast('Photo added');
    if (input) input.value = '';
  } catch (err) { toast(err.message, 'error'); }
}

async function handleImageUpload(input) {
  var files = input.files;
  if (!files || files.length === 0) return;
  var statusEl = document.getElementById('uploadStatus');
  
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (file.size > 5 * 1024 * 1024) { toast('File too large: ' + file.name + ' (max 5MB)', 'error'); continue; }
    if (statusEl) statusEl.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '...';
    var formData = new FormData();
    formData.append('file', file);
    try {
      var res = await fetch('/api/images/upload', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + authToken },
        body: formData
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      
      if (currentPropertyId) {
        // Save to property_images
        var d = await api('/api/properties/' + currentPropertyId + '/images', 'POST', { image_url: data.url, source: 'upload' });
        _propertyImages.push({ id: d.id, image_url: data.url, source: 'upload', sort_order: _propertyImages.length });
      } else {
        // New property — set as main image
        var hidden = document.getElementById('f_image');
        if (hidden && !hidden.value) hidden.value = data.url;
      }
    } catch (err) { toast(err.message, 'error'); }
  }
  
  renderPropertyGallery();
  if (statusEl) statusEl.textContent = files.length > 1 ? files.length + ' photos uploaded' : 'Photo uploaded';
  toast(files.length > 1 ? files.length + ' photos uploaded' : 'Photo uploaded');
  input.value = '';
}

function setOwnership(type) {
  currentOwnership = type;
  document.querySelectorAll('.ownership-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.own === type); });
  var fp = document.getElementById('financePurchased');
  var fr = document.getElementById('financeRental');
  var fm = document.getElementById('financeManaged');
  if (fp) fp.style.display = type === 'purchased' ? '' : 'none';
  if (fr) fr.style.display = type === 'rental' ? '' : 'none';
  if (fm) fm.style.display = type === 'managed' ? '' : 'none';
  if (type === 'managed') updateManagedPreview();
  updateCostSummary();
}

function setFinancing(type) {
  currentFinancing = type;
  document.querySelectorAll('.financing-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.fin === type); });
}

function setFeeBasis(basis) {
  document.querySelectorAll('.fee-basis-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.basis === basis); });
  var hidden = document.getElementById('f_fee_basis');
  if (hidden) hidden.value = basis;
  updateManagedPreview();
  updateCostSummary();
}

// ─── PriceLabs Customizations ────────────────────────────────────────────────
function loadPlCustomizations(propData) {
  var section = document.getElementById('plCustomizationsSection');
  if (!section) return;
  var p = propData.property || propData;
  // Show section if PriceLabs is linked or property has saved customizations
  var hasPl = propData.pricelabs && propData.pricelabs.linked;
  var hasCustom = p.pl_customizations_json;
  section.style.display = (hasPl || hasCustom) ? '' : 'none';

  if (hasCustom) {
    try {
      var rules = JSON.parse(p.pl_customizations_json);
      var fields = {plc_group:'group_name',plc_demand:'demand_sensitivity',plc_last_minute:'last_minute',plc_far_out:'far_out_premium',plc_recency:'booking_recency',plc_weekly:'weekly_discount',plc_monthly:'monthly_discount',plc_occ_adj:'occupancy_adjustment',plc_portfolio:'portfolio_occupancy',plc_orphan:'orphan_day',plc_minstay:'min_stay_rules',plc_seasonal:'seasonal_profile',plc_dow:'day_of_week',plc_notes:'notes'};
      for (var fId in fields) {
        var el = document.getElementById(fId);
        if (el && rules[fields[fId]]) el.value = rules[fields[fId]];
      }
      // Weekend days checkboxes
      if (rules.weekend_days) {
        var days = rules.weekend_days.split(',').map(function(d) { return d.trim(); });
        document.querySelectorAll('.plc-wd').forEach(function(cb) { cb.checked = days.indexOf(cb.value) >= 0; });
      }
      var status = document.getElementById('plCustomStatus');
      if (status) status.textContent = Object.values(rules).filter(Boolean).length + ' rules configured';
    } catch {}
  }

  // Load action items if available
  loadPlActionItems(p.id || (document.getElementById('f_editId') || {}).value);
}

function savePlCustomizations(btnEl) {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) return;
  var rules = _getPlcRulesFromForm();
  if (btnEl) btnEl.disabled = true;
  api('/api/properties/' + editId, 'PATCH', { pl_customizations_json: JSON.stringify(rules) }).then(function() {
    var status = document.getElementById('plcSaveStatus');
    if (status) { status.textContent = 'Saved ✓'; setTimeout(function() { status.textContent = ''; }, 2000); }
    var countEl = document.getElementById('plCustomStatus');
    if (countEl) countEl.textContent = Object.values(rules).filter(Boolean).length + ' rules configured';
    toast('PriceLabs customizations saved');
  }).catch(function(err) { toast(err.message, 'error'); }).finally(function() { if (btnEl) btnEl.disabled = false; });
}

function _getPlcRulesFromForm() {
  var fields = {plc_group:'group_name',plc_demand:'demand_sensitivity',plc_last_minute:'last_minute',plc_far_out:'far_out_premium',plc_recency:'booking_recency',plc_weekly:'weekly_discount',plc_monthly:'monthly_discount',plc_occ_adj:'occupancy_adjustment',plc_portfolio:'portfolio_occupancy',plc_orphan:'orphan_day',plc_minstay:'min_stay_rules',plc_seasonal:'seasonal_profile',plc_dow:'day_of_week',plc_notes:'notes'};
  var rules = {};
  for (var fId in fields) {
    var el = document.getElementById(fId);
    if (el && el.value.trim()) rules[fields[fId]] = el.value.trim();
  }
  // Weekend days from checkboxes
  var weekendDays = [];
  document.querySelectorAll('.plc-wd:checked').forEach(function(cb) { weekendDays.push(cb.value); });
  if (weekendDays.length > 0) rules.weekend_days = weekendDays.join(', ');
  return rules;
}

function applyPlCustomizationsToAll(mode) {
  var rules = _getPlcRulesFromForm();
  var ruleCount = Object.values(rules).filter(Boolean).length;
  if (ruleCount === 0) { toast('Fill in the customizations first', 'error'); return; }
  var groupName = rules.group_name || '';
  var currentPropId = (document.getElementById('f_editId') || {}).value;

  // Fetch all PL-linked properties to show the preview
  showLoading('Loading properties...');
  api('/api/pricelabs/bulk-customizations-preview', 'POST', { rules: rules, mode: mode, group_name: groupName }).then(function(d) {
    hideLoading();
    if (!d.properties || d.properties.length === 0) { toast('No matching PriceLabs-linked properties found', 'error'); return; }
    _showPlcApplyModal(d.properties, rules, currentPropId);
  }).catch(function(err) { hideLoading(); toast(err.message, 'error'); });
}

function _showPlcApplyModal(properties, rules, currentPropId) {
  // Build the rule summary
  var ruleLabels = {group_name:'Group',demand_sensitivity:'Demand Factor',last_minute:'Last Minute',far_out_premium:'Far Out Premium',booking_recency:'Booking Recency',weekly_discount:'Weekly Discount',monthly_discount:'Monthly Discount',weekend_days:'Weekend Days',occupancy_adjustment:'Occupancy Adj.',portfolio_occupancy:'Portfolio Occ.',orphan_day:'Orphan Day',min_stay_rules:'Min Stay',seasonal_profile:'Seasonal Profile',day_of_week:'Day of Week Adj.',notes:'Notes'};
  var ruleEntries = Object.entries(rules).filter(function(e) { return e[1]; });

  var h = '<div style="max-height:70vh;overflow-y:auto;">';

  // Rules being applied
  h += '<div style="padding:10px 12px;background:var(--purple-dim);border:1px solid rgba(167,139,250,0.2);border-radius:8px;margin-bottom:14px;">';
  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--purple);margin-bottom:6px;">Rules to apply (' + ruleEntries.length + '):</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:0.72rem;">';
  ruleEntries.forEach(function(e) {
    var label = ruleLabels[e[0]] || e[0];
    if (e[0] === 'notes') return; // show notes separately
    h += '<div><span style="color:var(--text3);">' + esc(label) + ':</span> <strong>' + esc(String(e[1]).substring(0, 40)) + '</strong></div>';
  });
  h += '</div>';
  if (rules.notes) {
    h += '<div style="margin-top:4px;font-size:0.68rem;color:var(--text3);">Notes will NOT be overwritten on properties that already have their own notes.</div>';
  }
  h += '</div>';

  // Property selection table
  h += '<div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:8px;">Select properties to update:</div>';
  h += '<div style="display:flex;gap:8px;margin-bottom:8px;">';
  h += '<button class="btn btn-xs" onclick="document.querySelectorAll(\'.plc-apply-cb\').forEach(function(c){c.checked=true})">Select All</button>';
  h += '<button class="btn btn-xs" onclick="document.querySelectorAll(\'.plc-apply-cb\').forEach(function(c){c.checked=false})">Deselect All</button>';
  h += '<span style="font-size:0.68rem;color:var(--text3);align-self:center;">' + properties.length + ' PriceLabs-linked properties</span>';
  h += '</div>';

  h += '<div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;">';
  h += '<table class="comp-table" style="font-size:0.72rem;margin:0;"><thead><tr><th style="width:30px;"></th><th>Property</th><th>Current Group</th><th>Current Rules</th><th>Changes</th></tr></thead><tbody>';

  properties.forEach(function(p) {
    var isCurrent = String(p.id) === String(currentPropId);
    var existingRules = p.existing_rules || {};
    var existingCount = Object.values(existingRules).filter(Boolean).length;

    // Calculate what's changing
    var changes = [];
    ruleEntries.forEach(function(e) {
      if (e[0] === 'notes' && existingRules.notes) return; // preserve existing notes
      var oldVal = existingRules[e[0]] || '';
      if (oldVal !== e[1]) changes.push(ruleLabels[e[0]] || e[0]);
    });
    var changeLabel = changes.length === 0 ? '<span style="color:var(--accent);">No changes</span>' : '<span style="color:var(--purple);">' + changes.length + ' change' + (changes.length > 1 ? 's' : '') + '</span>';

    var label = p.unit_number ? p.unit_number + ' — ' + (p.name || p.address) : (p.name || p.address || 'Property #' + p.id);
    h += '<tr style="' + (isCurrent ? 'background:rgba(167,139,250,0.05);' : '') + '">';
    h += '<td style="text-align:center;"><input type="checkbox" class="plc-apply-cb" value="' + p.id + '" ' + (changes.length > 0 ? 'checked' : '') + '></td>';
    h += '<td style="font-weight:600;">' + esc(label).substring(0, 35) + (isCurrent ? ' <span style="font-size:0.6rem;color:var(--purple);">(current)</span>' : '') + '</td>';
    h += '<td style="font-size:0.68rem;">' + esc(p.pl_group || '—') + '</td>';
    h += '<td style="font-size:0.68rem;">' + (existingCount > 0 ? existingCount + ' rules' : '<span style="color:var(--text3);">None</span>') + '</td>';
    h += '<td style="font-size:0.68rem;">' + changeLabel + '</td>';
    h += '</tr>';

    // Show specific changes on hover/expand
    if (changes.length > 0) {
      h += '<tr class="plc-change-detail" style="display:none;"><td></td><td colspan="4" style="padding:4px 8px;font-size:0.65rem;background:var(--bg);">';
      changes.forEach(function(c) { h += '<span style="padding:1px 6px;background:var(--surface2);border-radius:3px;margin-right:4px;">' + esc(c) + '</span>'; });
      h += '</td></tr>';
    }
  });
  h += '</tbody></table></div>';

  // Actions
  h += '<div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">';
  h += '<button class="btn btn-sm" onclick="closeGenericModal()">Cancel</button>';
  h += '<button class="btn btn-sm btn-purple" onclick="_executePlcBulkApply()">Apply to Selected</button>';
  h += '</div>';
  h += '</div>';

  // Store rules for the execute function
  window._plcBulkRules = rules;
  showModal('Apply PriceLabs Customizations', h);
}

function _executePlcBulkApply() {
  var checkboxes = document.querySelectorAll('.plc-apply-cb:checked');
  var ids = [];
  checkboxes.forEach(function(cb) { ids.push(parseInt(cb.value)); });
  if (ids.length === 0) { toast('Select at least one property', 'error'); return; }
  var rules = window._plcBulkRules;
  if (!rules) return;

  // Disable the apply button
  var applyBtn = document.querySelector('.plc-bulk-apply-btn');
  if (applyBtn) applyBtn.disabled = true;

  closeGenericModal();
  showLoading('Applying PriceLabs rules to ' + ids.length + ' properties...');
  api('/api/pricelabs/bulk-customizations', 'POST', { rules: rules, property_ids: ids }).then(function(d) {
    hideLoading();
    toast('Applied to ' + (d.updated || 0) + ' of ' + ids.length + ' properties', 'success');
  }).catch(function(err) { hideLoading(); toast(err.message, 'error'); }).finally(function() { if (applyBtn) applyBtn.disabled = false; });
}

function loadPlActionItems(propId) {
  if (!propId) return;
  var el = document.getElementById('plActionItems');
  if (!el) return;
  // Check latest pl_strategy report for pricelabs_action_items
  api('/api/properties/' + propId + '/reports').then(function(d) {
    var latest = d.latest || {};
    var items = [];
    // From PL Strategy
    if (latest.pl_strategy && latest.pl_strategy.data) {
      var strat = latest.pl_strategy.data.strategy || latest.pl_strategy.data;
      if (strat.pricelabs_action_items) items = items.concat(strat.pricelabs_action_items);
    }
    // From Revenue Optimization (pricing_adjustments)
    if (latest.revenue_optimization && latest.revenue_optimization.data && latest.revenue_optimization.data.optimization) {
      var opt = latest.revenue_optimization.data.optimization;
      if (opt.pricing_adjustments) {
        opt.pricing_adjustments.forEach(function(adj) {
          items.push({ setting: adj.setting, current: adj.current, recommended: adj.recommended, reason: adj.reason, priority: 2, source: 'rev_opt' });
        });
      }
    }
    if (items.length === 0) { el.innerHTML = ''; return; }
    var h = '<div style="border-top:1px solid var(--border);padding-top:10px;">';
    h += '<div style="font-size:0.75rem;font-weight:600;color:var(--purple);margin-bottom:8px;">' + _ico('zap', 13, 'var(--purple)') + ' PriceLabs Action Items (' + items.length + ')</div>';
    items.sort(function(a,b) { return (a.priority || 99) - (b.priority || 99); });
    items.forEach(function(item, idx) {
      h += '<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 8px;margin-bottom:4px;background:var(--bg);border-radius:6px;border-left:2px solid var(--purple);font-size:0.75rem;">';
      h += '<div style="flex:1;">';
      h += '<strong>' + esc(item.setting || 'Setting') + '</strong>';
      if (item.current) h += '<span style="color:var(--text3);"> · Current: ' + esc(String(item.current)) + '</span>';
      h += '<div style="color:var(--accent);font-weight:600;">→ ' + esc(String(item.recommended || '')) + '</div>';
      if (item.reason) h += '<div style="color:var(--text3);font-size:0.7rem;margin-top:2px;">' + esc(item.reason) + '</div>';
      h += '</div></div>';
    });
    h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:6px;">Apply these changes in your PriceLabs dashboard. Run a new analysis after applying to see updated recommendations.</div>';
    h += '</div>';
    el.innerHTML = h;
  }).catch(function() {});
}

function updateManagedPreview() {
  var preview = document.getElementById('managedSplitPreview');
  if (!preview) return;
  var gv = function(id) { return parseFloat((document.getElementById(id) || {}).value) || 0; };
  var feePct = gv('f_mgmt_fee_pct');
  var baseFee = gv('f_mgmt_base_fee');
  var basis = (document.getElementById('f_fee_basis') || {}).value || 'gross';
  var ownerN = (document.getElementById('f_owner_name') || {}).value || 'Owner';
  if (feePct <= 0 && baseFee <= 0) { preview.innerHTML = '<span style="color:var(--text3);">Enter a fee % or base fee to see the split preview.</span>'; return; }

  var h = '';
  var baseLabel = baseFee > 0 ? ' + $' + baseFee + '/mo base fee' : '';
  if (basis === 'gross') {
    var youGet = Math.round(1000 * feePct / 100) + baseFee;
    h += '<div style="font-weight:600;margin-bottom:4px;">' + feePct + '% of Gross' + baseLabel + ' <span style="font-size:0.68rem;color:var(--text3);">(industry standard)</span></div>';
    h += '<div>For every <strong>$1,000</strong> gross: ';
    h += '<span style="color:var(--accent);font-weight:700;">You earn $' + youGet + '</span> · ';
    h += '<span style="color:var(--text2);">' + esc(ownerN) + ' receives $' + (1000 - youGet) + ' minus expenses</span></div>';
    if (baseFee > 0) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:4px;">Base fee of $' + baseFee + '/mo charged every month regardless of bookings. Months with $0 revenue: owner owes $' + Math.round(baseFee) + ' + expenses.</div>';
    else h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:4px;">Your fee is guaranteed regardless of expenses. Owner covers property costs from their share.</div>';
  } else {
    var expenses = gv('f_mortgage') + gv('f_insurance') + Math.round(gv('f_taxes') / 12) + gv('f_hoa') + gv('f_monthly_rent') + gv('f_electric') + gv('f_gas') + gv('f_water') + gv('f_internet') + gv('f_trash') + gv('f_other_expense');
    var netProfit = Math.max(0, 1000 - expenses);
    var youGet = Math.round(netProfit * feePct / 100) + baseFee;
    h += '<div style="font-weight:600;margin-bottom:4px;">' + feePct + '% of Net Profit' + baseLabel + ' <span style="font-size:0.68rem;color:var(--text3);">(profit-share)</span></div>';
    h += '<div>$1,000 gross';
    if (expenses > 0) h += ' − $' + expenses + ' expenses = $' + netProfit + ' net profit';
    h += '</div>';
    h += '<div><span style="color:var(--accent);font-weight:700;">You earn $' + youGet + '</span> · ';
    h += '<span style="color:var(--text2);">' + esc(ownerN) + ' keeps $' + (netProfit - youGet) + '</span></div>';
    if (baseFee > 0) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:4px;">Base fee of $' + baseFee + '/mo charged every month. Months with no profit: owner still owes $' + Math.round(baseFee) + '.</div>';
  }
  preview.innerHTML = h;
}

function updateCostSummary() {
  var el = document.getElementById('costSummary');
  if (!el) return;
  var gv = function(id) { return parseFloat((document.getElementById(id) || {}).value) || 0; };
  var fixed = 0; var items = [];
  if (currentOwnership === 'purchased') {
    var mort = gv('f_mortgage'); if (mort) { items.push('Mortgage $' + mort.toLocaleString()); fixed += mort; }
    var ins = gv('f_insurance'); if (ins) { items.push('Insurance $' + ins.toLocaleString()); fixed += ins; }
    var tax = Math.round(gv('f_taxes') / 12); if (tax) { items.push('Taxes $' + tax.toLocaleString() + '/mo'); fixed += tax; }
    var hoa = gv('f_hoa'); if (hoa) { items.push('HOA $' + hoa.toLocaleString()); fixed += hoa; }
  } else if (currentOwnership === 'rental') {
    var rent = gv('f_monthly_rent'); if (rent) { items.push('Rent $' + rent.toLocaleString()); fixed += rent; }
  } else if (currentOwnership === 'managed') {
    var feePct = gv('f_mgmt_fee_pct');
    var basis = (document.getElementById('f_fee_basis') || {}).value || 'gross';
    items.push('Managed @ ' + (feePct || 0) + '% of ' + (basis === 'net_profit' ? 'net profit' : 'gross'));
  }
  var util = gv('f_electric') + gv('f_gas') + gv('f_water') + gv('f_internet') + gv('f_trash') + gv('f_other_expense');
  if (util) items.push('Utilities $' + util.toLocaleString());
  var svcCost = getServicesCost();
  if (svcCost > 0) items.push('Services $' + Math.round(svcCost));
  var total = fixed + util + svcCost;
  if (total > 0 || currentOwnership === 'managed') {
    var h = '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:center;">';
    h += '<div style="font-size:0.82rem;color:var(--text3);">' + items.join(' + ') + '</div>';
    if (currentOwnership !== 'managed') {
      h += '<div style="font-weight:600;color:var(--accent);font-size:1.05em;">$' + total.toLocaleString() + '/mo total cost</div></div>';
    } else {
      h += '<div style="font-weight:600;color:#a78bfa;font-size:1.05em;">Management fee revenue model</div></div>';
    }
    if (svcCost > 0) {
      var svcNames = propServices.map(function(s) { return s.name + ' $' + s.monthly_cost; }).join(' · ');
      h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:4px;">Services: ' + svcNames + '</div>';
    }
    el.innerHTML = h;
    el.style.display = '';
  } else { el.style.display = 'none'; }
}


// ── Property Price Analysis Dialog ──
var propDialogAnalysisType = 'str';
var propDialogAiEnabled = true;
var propDialogQuality = null; // null = use global aiQuality

async function showPropAnalysisDialog() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save property first', 'error'); return; }

  // Sync to current global AI state
  propDialogAiEnabled = aiEnabled;
  propDialogQuality = aiQuality;
  propDialogAnalysisType = 'str';

  // Open dialog first so user sees it loading
  document.getElementById('propAnalysisModal').style.display = 'flex';
  var statusEl = document.getElementById('propAnalysisDialogStatus');
  if (statusEl) statusEl.textContent = 'Loading amenities...';

  // Load this property's saved amenities from server — critical so chips reflect reality
  try {
    var d = await api('/api/properties/' + editId + '/amenities');
    selectedAmenities = new Set((d.amenity_ids || []).map(function(id) { return id; }));
  } catch {
    selectedAmenities = new Set();
  }
  if (statusEl) statusEl.textContent = '';

  // Render amenity chips with the freshly loaded selection
  var chips = document.getElementById('propDialogAmenityChips');
  if (chips) {
    chips.innerHTML = amenities.map(function(a) {
      var sel = selectedAmenities.has(a.id) ? ' selected' : '';
      return '<div class="chip' + sel + '" onclick="togglePropDialogAmenity(' + a.id + ')">' + esc(a.name) + '<span class="score">+' + a.impact_score + '%</span></div>';
    }).join('');
  }

  // Sync AI toggle UI
  var tog = document.getElementById('propDialogAiToggle');
  if (tog) tog.classList.toggle('active', propDialogAiEnabled);
  var opts = document.getElementById('propDialogAiOptions');
  if (opts) opts.style.display = propDialogAiEnabled ? 'flex' : 'none';
  document.querySelectorAll('#propDialogAiOptions .ai-option').forEach(function(o) {
    o.classList.toggle('selected', o.dataset.quality === propDialogQuality);
  });

  // Reset type buttons
  setPropAnalysisType('str');

  var saveStatus = document.getElementById('propDialogAmenitySaveStatus');
  if (saveStatus) saveStatus.textContent = selectedAmenities.size > 0 ? '(' + selectedAmenities.size + ' saved)' : '';
}

function closePropAnalysisDialog() {
  document.getElementById('propAnalysisModal').style.display = 'none';
}

function setPropAnalysisType(type) {
  propDialogAnalysisType = type;
  document.querySelectorAll('.prop-atype-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.atype === type);
  });
  var note = document.getElementById('propAnalysisTypeNote');
  if (note) {
    var notes = {
      str: 'Compares nightly rates against STR comps (Airbnb/VRBO). AI generates base rate, weekend rate, cleaning fee, and occupancy targets.',
      ltr: 'Compares monthly rent against LTR comps (Zillow, RentCast). AI generates monthly rent, deposit, and vacancy estimates.',
      both: 'Runs both STR and LTR analyses. Useful for comparing rental strategies before committing to one approach.'
    };
    note.textContent = notes[type] || '';
  }
}

function togglePropDialogAI() {
  propDialogAiEnabled = !propDialogAiEnabled;
  var tog = document.getElementById('propDialogAiToggle');
  if (tog) tog.classList.toggle('active', propDialogAiEnabled);
  var opts = document.getElementById('propDialogAiOptions');
  if (opts) opts.style.display = propDialogAiEnabled ? 'flex' : 'none';
}

function setPropDialogQuality(q) {
  propDialogQuality = q;
  document.querySelectorAll('#propDialogAiOptions .ai-option').forEach(function(o) {
    o.classList.toggle('selected', o.dataset.quality === q);
  });
}

function togglePropDialogAmenity(id) {
  selectedAmenities.has(id) ? selectedAmenities.delete(id) : selectedAmenities.add(id);
  // Re-render all chips from the amenities array so selection state is always correct
  var chips = document.getElementById('propDialogAmenityChips');
  if (chips) {
    chips.innerHTML = amenities.map(function(a) {
      var sel = selectedAmenities.has(a.id) ? ' selected' : '';
      return '<div class="chip' + sel + '" onclick="togglePropDialogAmenity(' + a.id + ')">' + esc(a.name) + '<span class="score">+' + a.impact_score + '%</span></div>';
    }).join('');
  }
  // Update count
  var saveStatus = document.getElementById('propDialogAmenitySaveStatus');
  if (saveStatus) saveStatus.textContent = '(' + selectedAmenities.size + ' selected — unsaved)';
}

async function savePropDialogAmenities() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save property first', 'error'); return; }
  try {
    await api('/api/properties/' + editId + '/amenities', 'POST', { amenity_ids: Array.from(selectedAmenities) });
    var st = document.getElementById('propDialogAmenitySaveStatus');
    if (st) st.textContent = '✓ Saved (' + selectedAmenities.size + ')';
    setTimeout(function() {
      var s = document.getElementById('propDialogAmenitySaveStatus');
      if (s) s.textContent = '(' + selectedAmenities.size + ' saved)';
    }, 2000);
    toast('Amenities saved');
  } catch (err) { toast(err.message, 'error'); }
}

async function runPropAnalysisFromDialog() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var btn = document.getElementById('propAnalysisRunBtn');
  var statusEl = document.getElementById('propAnalysisDialogStatus');
  if (btn) { btn.disabled = true; btn.innerHTML ='' + _ico('clock', 13) + ' Running...'; }
  if (statusEl) statusEl.textContent = 'Fetching market data and running analysis...';

  try {
    var d = await api('/api/properties/' + editId + '/analyze', 'POST', {
      use_ai: propDialogAiEnabled,
      quality: propDialogQuality || aiQuality,
      analysis_type: propDialogAnalysisType
    });

    closePropAnalysisDialog();

    var resultsEl = document.getElementById('priceAnalysisResults');
    var statusOut = document.getElementById('plStrategyStatus');
    if (statusOut) statusOut.innerHTML = '';
    if (resultsEl) {
      var h = '';

      // AI provider attribution
      var usedProviders = new Set();
      (d.strategies || []).forEach(function(s) { if (s.ai_provider) usedProviders.add(s.ai_provider); });
      if (usedProviders.size > 0) {
        var provLabels = { anthropic: 'Claude (Anthropic)', openai: 'GPT-4o (OpenAI)', workers_ai: 'Workers AI (Cloudflare)' };
        h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:8px;padding:6px 10px;background:var(--bg);border-radius:6px;border:1px solid var(--border);">';
        h +='' + _ico('sparkle', 13) + ' AI by: <strong>' + Array.from(usedProviders).map(function(p) { return provLabels[p] || p; }).join(', ') + '</strong>';
        h += ' · Analysis type: <strong>' + propDialogAnalysisType.toUpperCase() + '</strong>';
        h += '</div>';
      }

      // Data sources
      if (d.sources) {
        h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">';
        d.sources.forEach(function(s) {
          var color = s.status === 'none' || s.status === 'not linked' ? 'var(--text3)' : 'var(--accent)';
          var icon = s.status === 'none' || s.status === 'not linked' ? '○' : '●';
          h += '<span style="font-size:0.68rem;color:' + color + ';background:var(--bg);padding:2px 8px;border-radius:4px;border:1px solid var(--border);">' + icon + ' ' + esc(s.name) + ': ' + esc(s.status) + '</span>';
        });
        h += '</div>';
      }

      // Market context
      if (d.market) {
        h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;">';
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:6px;">MARKET CONTEXT</div>';
        h += '<div class="market-grid">';
        if (d.market.avg_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(d.market.avg_daily_rate).toLocaleString() + '</div><div class="lbl">Avg Rent/mo</div></div>';
        if (d.market.median_daily_rate) h += '<div class="market-stat"><div class="val">$' + Math.round(d.market.median_daily_rate).toLocaleString() + '</div><div class="lbl">Median Rent/mo</div></div>';
        if (d.market.active_listings) h += '<div class="market-stat"><div class="val">' + d.market.active_listings + '</div><div class="lbl">Active Listings</div></div>';
        h += '<div class="market-stat"><div class="val">' + (d.comparables_count || 0) + '</div><div class="lbl">Comps Found</div></div>';
        h += '</div></div>';
      }

      // Seasonality chart
      if (d.seasonality && d.seasonality.length >= 6) {
        var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;">';
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--purple);margin-bottom:6px;">SEASONAL ADJUSTMENTS</div>';
        h += '<div style="display:flex;gap:2px;align-items:flex-end;height:60px;">';
        var maxM = Math.max.apply(null, d.seasonality.map(function(s) { return s.multiplier || 1; }));
        d.seasonality.forEach(function(s) {
          var pct = maxM > 0 ? Math.round((s.multiplier || 1) / maxM * 100) : 50;
          var clr = (s.multiplier || 1) >= 1.1 ? 'var(--accent)' : (s.multiplier || 1) <= 0.85 ? 'var(--danger)' : '#f59e0b';
          h += '<div style="flex:1;text-align:center;"><div style="background:' + clr + ';border-radius:3px 3px 0 0;height:' + Math.max(pct, 5) + '%;min-height:3px;opacity:0.7;" title="' + mNames[(s.month_number || 1) - 1] + ': ' + (s.multiplier || 1).toFixed(2) + 'x"></div>';
          h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:2px;">' + mNames[(s.month_number || 1) - 1] + '</div>';
          h += '<div style="font-size:0.5rem;color:' + clr + ';">' + (s.multiplier || 1).toFixed(1) + 'x</div></div>';
        });
        h += '</div></div>';
      }

      // AI error banner — show prominently if AI was requested but failed
      if (d.ai_error) {
        h += '<div style="padding:10px 14px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.3);border-radius:8px;margin-bottom:10px;display:flex;gap:10px;align-items:flex-start;">';
        h += '<span style="font-size:1.1rem;">' + _ico('alertCircle', 13, '#f59e0b') + '</span>';
        h += '<div><div style="font-size:0.82rem;font-weight:600;color:var(--danger);margin-bottom:2px;">AI Strategy Failed</div>';
        h += '<div style="font-size:0.78rem;color:var(--text2);">' + esc(d.ai_error) + '</div></div></div>';
      }

      // Strategies — use renderStrategyCard which properly shows full AI analysis text
      if (d.strategies && d.strategies.length > 0) {
        h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">PRICING STRATEGIES (' + d.strategies.length + ')</div>';
        d.strategies.forEach(function(s) { h += renderStrategyCard(s, true); });
      }

      // Unified analysis extras (PriceLabs setup, seasonal, optimization)
      if (d.unified) {
        var u = d.unified;

        // Seasonal strategy
        if (u.seasonal && (u.seasonal.peak_months || u.seasonal.low_months)) {
          var se = u.seasonal;
          h += '<div style="margin-top:14px;"><div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">' + _ico('calendar', 13) + ' SEASONAL STRATEGY</div>';
          h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">';
          if (se.peak_months && se.peak_months.length > 0) {
            h += '<div style="padding:10px 14px;background:rgba(239,68,68,0.05);border:1px solid rgba(239,68,68,0.15);border-radius:8px;">';
            h += '<div style="font-size:0.72rem;font-weight:600;color:var(--danger);margin-bottom:4px;">' + _ico('flame', 13, 'var(--danger)') + ' PEAK +' + (se.peak_markup_pct || 0) + '%' + (se.peak_rate ? ' → $' + se.peak_rate + '/nt' : '') + '</div>';
            h += '<div style="font-size:0.78rem;">' + se.peak_months.join(', ') + '</div></div>';
          }
          if (se.low_months && se.low_months.length > 0) {
            h += '<div style="padding:10px 14px;background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.15);border-radius:8px;">';
            h += '<div style="font-size:0.72rem;font-weight:600;color:var(--blue);margin-bottom:4px;">' + _ico('snowflake', 13, 'var(--blue)') + ' LOW -' + (se.low_discount_pct || 0) + '%' + (se.low_rate ? ' → $' + se.low_rate + '/nt' : '') + '</div>';
            h += '<div style="font-size:0.78rem;">' + se.low_months.join(', ') + '</div></div>';
          }
          h += '</div>';
          var discParts = [];
          if (se.orphan_day_discount_pct) discParts.push('Orphan day: -' + se.orphan_day_discount_pct + '%');
          if (se.last_minute_discount_pct) discParts.push('Last minute: -' + se.last_minute_discount_pct + '%');
          if (se.early_bird_discount_pct) discParts.push('Early bird: -' + se.early_bird_discount_pct + '%');
          if (discParts.length > 0) h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:8px;">' + discParts.join(' · ') + '</div>';
          h += '</div>';
        }

        // PriceLabs setup steps
        if (u.pricelabs && u.pricelabs.setup_steps && u.pricelabs.setup_steps.length > 0) {
          h += '<div style="padding:14px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:14px;">';
          h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:8px;">' + _ico('receipt', 13) + ' PRICELABS SETUP STEPS</div>';
          u.pricelabs.setup_steps.forEach(function(step, i) {
            h += '<div style="display:flex;gap:8px;margin:6px 0;font-size:0.78rem;">';
            h += '<span style="flex-shrink:0;width:22px;height:22px;border-radius:50%;background:var(--purple);color:var(--bg);display:flex;align-items:center;justify-content:center;font-size:0.68rem;font-weight:700;">' + (i+1) + '</span>';
            h += '<span style="color:var(--text);line-height:1.4;">' + esc(step) + '</span></div>';
          });
          h += '</div>';
        }

        // PriceLabs action items
        if (u.pricelabs && u.pricelabs.action_items && u.pricelabs.action_items.length > 0) {
          h += '<div style="padding:14px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:14px;">';
          h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:8px;">' + _ico('settings', 13) + ' PRICELABS ACTION ITEMS</div>';
          h += '<table class="comp-table" style="font-size:0.78rem;"><thead><tr><th>Setting</th><th>Current</th><th>Recommended</th><th>Why</th></tr></thead><tbody>';
          u.pricelabs.action_items.forEach(function(ai) {
            h += '<tr><td style="font-weight:600;">' + esc(ai.setting || '') + '</td>';
            h += '<td style="font-family:DM Mono,monospace;color:var(--text3);">' + esc(String(ai.current || '')) + '</td>';
            h += '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">' + esc(String(ai.recommended || '')) + '</td>';
            h += '<td style="font-size:0.72rem;color:var(--text2);">' + esc(ai.reason || '') + '</td></tr>';
          });
          h += '</tbody></table></div>';
        }

        // Quick wins
        if (u.optimization && u.optimization.quick_wins && u.optimization.quick_wins.length > 0) {
          h += '<div style="padding:12px 14px;background:rgba(16,185,129,0.05);border:1px solid rgba(16,185,129,0.15);border-radius:8px;margin-bottom:12px;">';
          h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">' + _ico('zap', 13) + ' QUICK WINS</div>';
          u.optimization.quick_wins.forEach(function(w) { h += '<div style="font-size:0.78rem;margin:4px 0;">✓ ' + esc(w) + '</div>'; });
          h += '</div>';
        }

        // Strategy summary
        if (u.strategy_summary) {
          h += '<div style="padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;font-size:0.82rem;color:var(--text);line-height:1.5;">';
          h += '<strong style="color:var(--purple);">Strategy Summary:</strong> ' + esc(u.strategy_summary);
          h += '</div>';
        }
      }

      resultsEl.innerHTML = h;
      resultsEl.setAttribute('data-fresh', 'true');
    }

    await loadProperties();
    // Invalidate research tab cache so it shows fresh analysis
    if (typeof _researchCache !== 'undefined' && _researchCache[editId]) delete _researchCache[editId];
    renderRevenueSnapshot(editId);
    // Refresh PL compare panel with latest analysis results
    if (typeof loadPLComparePanel === 'function') loadPLComparePanel(editId, d);
    var lastRunEl = document.getElementById('pricingLastRun');
    if (lastRunEl) lastRunEl.innerHTML = 'Last analysis: <strong>' + fmtUTC(new Date().toISOString()) + '</strong> · ' + (d.strategies || []).length + ' strategies · ' + propDialogAnalysisType.toUpperCase();
    toast('Price analysis complete — ' + (d.strategies || []).length + ' strategies generated');
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '' + _ico('x', 13, 'var(--danger)') + ' ' + err.message;
    if (btn) { btn.disabled = false; btn.textContent = 'Run Analysis'; }
    toast(err.message, 'error');
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Run Analysis'; }
}

// ─── Property Research Tab ──────────────────────────────────────────────────
var _researchCache = {};
var _currentPropData = null; // cached property data for PL customizations etc

async function renderResearchTab(propertyId) {
  var el = document.getElementById('propResearchContent');
  if (!el) return;

  var prop = null;
  try {
    if (_researchCache[propertyId] && (Date.now() - _researchCache[propertyId]._ts < 60000)) {
      prop = _researchCache[propertyId];
    } else {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);">' + _ico('refresh', 16) + ' Loading research data...</div>';
      prop = await api('/api/properties/' + propertyId);
      prop._ts = Date.now();
      _researchCache[propertyId] = prop;
    }
  } catch (err) {
    el.innerHTML = '<div style="color:var(--danger);padding:20px;">Error: ' + esc(err.message) + '</div>';
    return;
  }

  var p = prop.property || {};
  var strategies = prop.strategies || [];
  var comps = prop.comparables || [];
  var actuals = prop.monthly_actuals || [];
  var pl = prop.pricelabs || {};
  var seasonality = prop.seasonality || [];
  var h = '';

  // ── Section 1: Performance Trend ──────────────────────────────────────
  if (actuals.length > 0) {
    h += _researchSection(
      _ico('activity', 16, 'var(--accent)'), 'Performance Trend', 'var(--accent)',
      'Actual revenue from Guesty bookings. Each bar represents one month — <strong style="color:var(--accent);">green</strong> = 60%+ occupancy, <strong style="color:#f0b840;">amber</strong> = 40-59%, <strong style="color:var(--danger);">red</strong> = below 40%. Hover any bar for exact numbers.'
    );

    var totalRev = 0, totalNights = 0, totalAvail = 0, monthCount = actuals.length;
    actuals.forEach(function(a) { totalRev += (a.total_revenue || 0); totalNights += (a.booked_nights || 0); totalAvail += (a.available_nights || 0); });
    var avgMonthlyRev = monthCount > 0 ? Math.round(totalRev / monthCount) : 0;
    var overallOcc = totalAvail > 0 ? Math.round(totalNights / totalAvail * 100) : 0;
    var overallAdr = totalNights > 0 ? Math.round(totalRev / totalNights) : 0;
    var recent3 = actuals.slice(-3);
    var prior3 = actuals.slice(-6, -3);
    var r3Rev = 0; recent3.forEach(function(a) { r3Rev += a.total_revenue || 0; });
    var p3Rev = 0; prior3.forEach(function(a) { p3Rev += a.total_revenue || 0; });
    var revTrend = p3Rev > 0 ? Math.round((r3Rev - p3Rev) / p3Rev * 100) : null;

    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:12px;">';
    h += _researchKpi('Avg Monthly', '$' + avgMonthlyRev.toLocaleString(), monthCount + ' months of data');
    h += _researchKpi('Occupancy', overallOcc + '%', totalNights + ' booked / ' + totalAvail + ' available');
    h += _researchKpi('ADR', '$' + overallAdr, 'Average daily rate earned');
    h += _researchKpi('Total Revenue', '$' + Math.round(totalRev).toLocaleString(), 'Lifetime from Guesty');
    if (revTrend !== null) {
      var trendColor = revTrend > 0 ? 'var(--accent)' : revTrend < 0 ? 'var(--danger)' : 'var(--text3)';
      h += _researchKpi('3-Month Trend', (revTrend >= 0 ? '+' : '') + revTrend + '%', 'Recent 3mo vs prior 3mo', trendColor);
    }
    h += '</div>';

    // Bar chart
    var maxRev = Math.max.apply(null, actuals.map(function(a) { return a.total_revenue || 0; }));
    h += '<div style="overflow-x:auto;margin-bottom:4px;">';
    h += '<div style="display:flex;gap:3px;align-items:flex-end;min-height:100px;padding:4px 0;">';
    actuals.slice(-18).forEach(function(a) {
      var rev = a.total_revenue || 0;
      var pct = maxRev > 0 ? Math.max(4, Math.round(rev / maxRev * 90)) : 4;
      var occ = Math.round((a.occupancy_pct || 0) * 100);
      var occColor = occ >= 60 ? 'var(--accent)' : occ >= 40 ? '#f0b840' : 'var(--danger)';
      h += '<div style="flex:1;min-width:32px;text-align:center;" title="' + a.month + ': $' + Math.round(rev).toLocaleString() + ' revenue | ' + occ + '% occupancy | $' + Math.round(a.avg_nightly_rate || 0) + ' ADR | ' + (a.booked_nights || 0) + ' nights booked">';
      h += '<div style="font-size:0.65rem;color:var(--text3);margin-bottom:2px;">$' + (rev >= 1000 ? Math.round(rev / 1000) + 'k' : Math.round(rev)) + '</div>';
      h += '<div style="height:' + pct + 'px;background:' + occColor + ';border-radius:3px 3px 0 0;opacity:0.8;"></div>';
      var _mn = parseInt(a.month.substring(5));
      var _mNames = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var _mLabel = _mNames[_mn] || a.month.substring(5);
      if (_mn === 1) _mLabel += '<br><span style="font-size:0.55rem;opacity:0.7;">\'' + a.month.substring(2,4) + '</span>';
      h += '<div style="font-size:0.62rem;color:var(--text3);margin-top:2px;line-height:1.2;">' + _mLabel + '</div>';
      h += '</div>';
    });
    h += '</div></div>';
    h += '</div>';
  }

  // ── Section 2: Listing Health ─────────────────────────────────────────
  h += _researchSection(
    _ico('sparkle', 16, '#e879f9'), 'Listing Health', '#e879f9',
    'How your listing quality compares to best practices. Scores are based on photos, description, amenities, reviews, and platform coverage. Run a <strong>Revenue Optimization</strong> analysis on the Pricing tab to get AI-powered improvement suggestions.'
  );
  h += '<div id="listingHealthContent" style="text-align:center;padding:16px;color:var(--text3);font-size:0.78rem;">' + _ico('refresh', 14) + ' Loading listing health...</div>';
  h += '</div>';

  // Load listing health data asynchronously
  (function(pid) {
    api('/api/properties/' + pid + '/listing-health').then(function(lh) {
      var el = document.getElementById('listingHealthContent');
      if (!el) return;
      el.innerHTML = _renderListingHealth(lh, pid);
    }).catch(function(err) {
      var el = document.getElementById('listingHealthContent');
      if (el) el.innerHTML = '<div style="color:var(--text3);font-size:0.78rem;">Unable to load listing health: ' + esc(err.message || 'unknown error') + '</div>';
    });
  })(propertyId);

  // ── Section 3: Competitive Position ───────────────────────────────────
  var strComps = comps.filter(function(c) { return c.comp_type === 'str' && c.nightly_rate > 0 && !(c.source || '').includes('Estimate'); });
  if (strComps.length > 0 || (pl && pl.linked)) {
    h += _researchSection(
      _ico('target', 16, '#5b8def'), 'Competitive Position', '#5b8def',
      'How your pricing compares to real competitors in the area. Comp data comes from Airbnb crawls and manual fetches. "Your Rate" is from your latest pricing strategy or PriceLabs base price.'
    );

    if (strComps.length > 0) {
      var compRates = strComps.map(function(c) { return c.nightly_rate; }).sort(function(a, b) { return a - b; });
      var compAvg = Math.round(compRates.reduce(function(s, r) { return s + r; }, 0) / compRates.length);
      var compMedian = compRates[Math.floor(compRates.length / 2)];
      var compMin = compRates[0];
      var compMax = compRates[compRates.length - 1];
      var latestStrat = strategies.length > 0 ? strategies[0] : null;
      var yourRate = latestStrat ? latestStrat.base_nightly_rate : (pl.base_price || null);

      h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px;">';
      h += _researchKpi('Comp Average', '$' + compAvg + '/nt', strComps.length + ' comparable listings');
      h += _researchKpi('Comp Median', '$' + compMedian + '/nt', '50th percentile rate');
      h += _researchKpi('Market Range', '$' + compMin + ' – $' + compMax, 'Lowest to highest');
      if (yourRate) {
        var vsAvg = Math.round((yourRate - compAvg) / compAvg * 100);
        var vsColor = Math.abs(vsAvg) <= 10 ? 'var(--accent)' : vsAvg > 10 ? '#f0b840' : 'var(--danger)';
        var vsLabel = vsAvg > 10 ? 'Above market — room to increase bookings?' : vsAvg < -10 ? 'Below market — room to raise rates?' : 'Well positioned within market range';
        h += _researchKpi('Your Rate', '$' + yourRate + '/nt', vsLabel, vsColor);
      }
      h += '</div>';

      // Comp source breakdown
      var bySrc = {};
      strComps.forEach(function(c) { var s = c.source || 'Unknown'; if (!bySrc[s]) bySrc[s] = []; bySrc[s].push(c.nightly_rate); });
      var srcEntries = Object.entries(bySrc);
      if (srcEntries.length > 0) {
        h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">';
        srcEntries.forEach(function(e) {
          var srcAvg = Math.round(e[1].reduce(function(s, r) { return s + r; }, 0) / e[1].length);
          h += '<span style="font-size:0.68rem;padding:3px 8px;background:var(--surface2);border-radius:4px;color:var(--text2);">' + esc(e[0]) + ': $' + srcAvg + ' avg (' + e[1].length + ')</span>';
        });
        h += '</div>';
      }
    }

    if (pl && pl.linked) {
      h += '<div style="padding:10px 12px;background:var(--purple-dim);border:1px solid rgba(167,139,250,0.2);border-radius:8px;font-size:0.75rem;">';
      h += '<div style="font-weight:600;color:var(--purple);margin-bottom:4px;">' + _ico('barChart', 13, 'var(--purple)') + ' PriceLabs Live Data</div>';
      h += '<div style="display:flex;gap:14px;flex-wrap:wrap;color:var(--text2);">';
      if (pl.base_price) h += '<span>Base: <strong>$' + pl.base_price + '</strong>/nt</span>';
      if (pl.recommended_base_price) h += '<span>Recommended: <strong>$' + pl.recommended_base_price + '</strong>/nt</span>';
      if (pl.min_price && pl.max_price) h += '<span>Range: $' + pl.min_price + '–$' + pl.max_price + '</span>';
      if (pl.occupancy_next_30) h += '<span>Your Occ 30d: <strong>' + String(pl.occupancy_next_30).replace(/%/g, '') + '%</strong></span>';
      if (pl.market_occupancy_next_30) h += '<span>Market Occ: ' + String(pl.market_occupancy_next_30).replace(/%/g, '') + '%</span>';
      h += '</div></div>';
    }
    h += '</div>';
  }

  // ── Section 4: Seasonality ────────────────────────────────────────────
  if (seasonality.length >= 6) {
    h += _researchSection(
      _ico('calendar', 16, '#f0b840'), 'Seasonality — Pricing Power by Month', '#f0b840',
      'How nightly rates vary by month in this market, based on your actual booking data. Each bar shows the average ADR for that month. <strong style="color:var(--accent);">Green</strong> = rates run above average (charge more), <strong style="color:var(--danger);">red</strong> = rates run below average (compete harder). The % shows how far above or below the annual average.'
    );
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var maxMult = Math.max.apply(null, seasonality.map(function(s) { return s.multiplier || 1; }));
    h += '<div style="display:flex;gap:3px;align-items:flex-end;min-height:80px;">';
    seasonality.forEach(function(s) {
      var mult = s.multiplier || 1;
      var pct = Math.max(8, Math.round(mult / maxMult * 70));
      var color = mult >= 1.1 ? 'var(--accent)' : mult <= 0.85 ? 'var(--danger)' : '#f0b840';
      var diffPct = Math.round((mult - 1) * 100);
      var diffLabel = diffPct > 0 ? '+' + diffPct + '%' : diffPct === 0 ? 'avg' : diffPct + '%';
      h += '<div style="flex:1;text-align:center;" title="' + monthNames[s.month_number - 1] + ': ' + (s.avg_adr ? '$' + Math.round(s.avg_adr) + '/nt average' : 'no data') + ' (' + diffLabel + ' vs annual avg)">';
      h += '<div style="font-size:0.6rem;color:' + color + ';font-weight:600;margin-bottom:1px;">' + (s.avg_adr ? '$' + Math.round(s.avg_adr) : '—') + '</div>';
      h += '<div style="height:' + pct + 'px;background:' + color + ';border-radius:3px 3px 0 0;opacity:0.7;margin:0 auto;width:80%;"></div>';
      h += '<div style="font-size:0.62rem;color:var(--text3);margin-top:2px;">' + monthNames[s.month_number - 1] + '</div>';
      h += '<div style="font-size:0.52rem;color:' + color + ';">' + diffLabel + '</div>';
      h += '</div>';
    });
    h += '</div></div>';
  }

  // ── Section 5: Analysis Timeline ──────────────────────────────────────
  if (strategies.length > 0) {
    h += _researchSection(
      _ico('clock', 16, 'var(--text2)'), 'Analysis Timeline (' + strategies.length + ')', 'var(--text2)',
      'History of all pricing analyses run for this property. Each entry shows the recommended rate, projected occupancy, and estimated monthly revenue. The most recent analysis is what drives the "vs Predicted" comparison on the property card.'
    );

    strategies.slice(0, 8).forEach(function(s, i) {
      var date = fmtUTC(s.created_at);
      var isAi = s.ai_generated === 1;
      var borderColor = isAi ? 'var(--purple)' : 'var(--border)';
      var bgColor = isAi ? 'var(--purple-dim)' : 'var(--surface2)';
      h += '<div style="padding:10px 12px;margin-bottom:6px;background:' + bgColor + ';border-left:3px solid ' + borderColor + ';border-radius:0 8px 8px 0;font-size:0.78rem;">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
      h += '<span style="font-weight:600;color:var(--text);">' + esc(s.strategy_name || 'Analysis') + '</span>';
      h += '<span style="font-size:0.68rem;color:var(--text3);">' + date + (isAi ? ' · ' + _ico('sparkle', 11, 'var(--purple)') + ' AI' : '') + '</span>';
      h += '</div>';
      h += '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.75rem;color:var(--text2);">';
      h += '<span style="color:var(--accent);font-weight:600;">$' + (s.base_nightly_rate || 0) + '/nt</span>';
      if (s.weekend_rate) h += '<span>Wknd: $' + s.weekend_rate + '</span>';
      h += '<span>Occ: ' + Math.round((s.projected_occupancy || 0) * 100) + '%</span>';
      h += '<span style="font-weight:600;">$' + Math.round(s.projected_monthly_avg || 0).toLocaleString() + '/mo</span>';
      if (s.cleaning_fee) h += '<span>Clean: $' + s.cleaning_fee + '</span>';
      h += '</div>';
      if (s.reasoning && i === 0) {
        var preview = s.reasoning.substring(0, 200).replace(/\n/g, ' ');
        h += '<div style="margin-top:6px;font-size:0.72rem;color:var(--text3);line-height:1.45;">' + esc(preview) + (s.reasoning.length > 200 ? '... <em>(full text in History tab)</em>' : '') + '</div>';
      }
      h += '</div>';
    });
    if (strategies.length > 8) h += '<div style="font-size:0.72rem;color:var(--text3);text-align:center;padding:4px;">+' + (strategies.length - 8) + ' more — see History tab for full list</div>';
    h += '</div>';
  }

  // ── Section 6: Market Context Card ────────────────────────────────────
  if (p.city && p.state) {
    h += _researchSection(
      _ico('globe', 16, '#60a5fa'), 'Market Context — ' + esc(p.city) + ', ' + esc(p.state), '#60a5fa',
      'How this property\'s local market is performing overall. Data aggregated from crawled Airbnb listings and your portfolio actuals. Click through to the full Market Profile for demographics, AI analysis, and competitive landscape.'
    );
    h += '<div id="researchMarketContext" style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);font-size:0.78rem;color:var(--text3);">' + _ico('refresh', 14) + ' Loading market data...</div>';
    h += '</div>';

    api('/api/market/profile?city=' + encodeURIComponent(p.city) + '&state=' + encodeURIComponent(p.state)).then(function(mkt) {
      var mc = document.getElementById('researchMarketContext');
      if (!mc) return;
      var mp = mkt.profile || {};
      if (!mp.str_listing_count && !mp.str_avg_adr) {
        mc.innerHTML = '<div style="color:var(--text3);">No market data available yet for ' + esc(p.city) + '. <a href="#" onclick="event.preventDefault();switchView(\'market\')" style="color:var(--accent);">Go to Market tab to build a profile →</a></div>';
        return;
      }
      var mh = '';
      mh += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:8px;margin-bottom:10px;">';
      mh += _researchKpi('Listings', mp.str_listing_count || '—', 'Active STRs in area');
      mh += _researchKpi('Market ADR', '$' + Math.round(mp.str_avg_adr || 0), 'Average nightly rate');
      mh += _researchKpi('Median ADR', '$' + Math.round(mp.str_median_adr || 0), '50th percentile');
      if (mp.str_avg_occupancy) mh += _researchKpi('Market Occ', mp.str_avg_occupancy + '%', 'Area average');
      mh += _researchKpi('Avg Rating', (mp.str_avg_rating || '—') + '★', (mp.str_superhost_pct || 0) + '% superhosts');
      if (mp.new_listings_30d) mh += _researchKpi('New 30d', mp.new_listings_30d, 'New competitors');
      mh += '</div>';

      if (mp.your_property_count > 0 && mp.your_avg_adr > 0) {
        var adrDiff = Math.round(mp.your_avg_adr - (mp.str_avg_adr || 0));
        var adrColor = adrDiff >= 0 ? 'var(--accent)' : 'var(--danger)';
        mh += '<div style="padding:8px 10px;background:var(--bg);border-radius:6px;margin-bottom:8px;">';
        mh += '<span style="font-size:0.72rem;color:var(--text3);">Your ADR vs Market: </span>';
        mh += '<span style="font-weight:700;color:' + adrColor + ';">' + (adrDiff >= 0 ? '+' : '') + '$' + adrDiff + '</span>';
        mh += '<span style="font-size:0.72rem;color:var(--text3);"> ($' + Math.round(mp.your_avg_adr) + ' yours vs $' + Math.round(mp.str_avg_adr || 0) + ' market)</span>';
        mh += '</div>';
      }

      mh += '<div style="margin-top:8px;text-align:right;"><a href="#" onclick="event.preventDefault();switchView(\'market\');setTimeout(function(){openMarketProfile(\'' + esc(p.city).replace(/'/g, "\\'") + '\',\'' + esc(p.state).replace(/'/g, "\\'") + '\')},300)" style="color:var(--accent);font-size:0.72rem;">' + _ico('externalLink', 12, 'var(--accent)') + ' View Full Market Profile →</a></div>';
      mc.innerHTML = mh;
    }).catch(function() {
      var mc = document.getElementById('researchMarketContext');
      if (mc) mc.innerHTML = '<div style="color:var(--text3);">Unable to load market data.</div>';
    });
  }

  // ── Empty state ───────────────────────────────────────────────────────
  if (!h) {
    h = '<div style="padding:30px;text-align:center;color:var(--text3);">';
    h += '<div style="margin-bottom:8px;">' + _ico('search', 24, 'var(--text3)') + '</div>';
    h += '<div style="font-size:0.88rem;margin-bottom:4px;">No research data yet</div>';
    h += '<div style="font-size:0.78rem;">Run a <strong>Pricing Analysis</strong> on the Pricing tab and <strong>Fetch Comps</strong> on the Comparables tab to start building intelligence for this property.</div>';
    h += '</div>';
  }

  el.innerHTML = h;
}

// Research tab helpers
function _agoText(dateStr) {
  if (!dateStr) return '';
  var ago = Math.round((Date.now() - new Date(dateStr).getTime()) / 86400000);
  return ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago + ' days ago';
}

function _researchSection(icon, title, color, description) {
  return '<div style="margin-bottom:20px;border:1px solid var(--border);border-radius:10px;padding:14px 16px;background:var(--card);">' +
    '<div style="font-size:0.82rem;font-weight:700;color:' + color + ';margin-bottom:6px;display:flex;align-items:center;gap:6px;">' + icon + ' ' + title + '</div>' +
    '<div style="font-size:0.7rem;color:var(--text3);line-height:1.5;margin-bottom:12px;border-left:2px solid ' + color + ';padding-left:10px;">' + description + '</div>';
}

function _researchKpi(label, value, sub, color) {
  return '<div style="padding:8px 10px;background:var(--surface2);border-radius:6px;text-align:center;">' +
    '<div style="font-family:DM Mono,monospace;font-weight:700;font-size:0.95rem;color:' + (color || 'var(--text)') + ';">' + value + '</div>' +
    '<div style="font-size:0.62rem;font-weight:600;color:var(--text2);margin-top:2px;">' + esc(label) + '</div>' +
    (sub ? '<div style="font-size:0.65rem;color:var(--text3);margin-top:1px;">' + esc(sub) + '</div>' : '') +
    '</div>';
}

// ─── Listing Health Renderer ────────────────────────────────────────────────
function _lhStatusColor(status) {
  if (status === 'good') return 'var(--accent)';
  if (status === 'needs_work') return '#f0b840';
  return 'var(--danger)';
}
function _lhStatusLabel(status) {
  if (status === 'good') return 'Good';
  if (status === 'needs_work') return 'Needs Work';
  return 'Critical';
}
function _lhStatusIcon(status) {
  if (status === 'good') return _ico('check', 12, 'var(--accent)');
  if (status === 'needs_work') return _ico('alert', 12, '#f0b840');
  return _ico('alert', 12, 'var(--danger)');
}
function _lhScoreRing(score, size) {
  size = size || 52;
  var r = (size - 6) / 2;
  var circ = 2 * Math.PI * r;
  var offset = circ - (score / 100) * circ;
  var color = score >= 70 ? 'var(--accent)' : score >= 40 ? '#f0b840' : 'var(--danger)';
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" style="display:block;">' +
    '<circle cx="' + (size/2) + '" cy="' + (size/2) + '" r="' + r + '" fill="none" stroke="var(--border)" stroke-width="3"/>' +
    '<circle cx="' + (size/2) + '" cy="' + (size/2) + '" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + circ + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 ' + (size/2) + ' ' + (size/2) + ')"/>' +
    '<text x="' + (size/2) + '" y="' + (size/2 + 1) + '" text-anchor="middle" dominant-baseline="central" style="font-family:DM Mono,monospace;font-size:' + (size < 50 ? '0.65rem' : '0.82rem') + ';font-weight:700;fill:' + color + ';">' + score + '</text>' +
    '</svg>';
}

function _renderListingHealth(lh, propertyId) {
  if (!lh || !lh.categories) return '<div style="color:var(--text3);font-size:0.78rem;">No listing health data available.</div>';

  var h = '';
  var c = lh.categories;
  var ai = lh.ai_recommendations;

  // ── Overall Score Ring + Category Scores Bar ──────────────────────────
  h += '<div style="display:flex;gap:16px;align-items:center;margin-bottom:16px;">';
  h += '<div style="text-align:center;">';
  h += _lhScoreRing(lh.overall_score, 64);
  h += '<div style="font-size:0.62rem;font-weight:600;color:var(--text3);margin-top:3px;">OVERALL</div>';
  h += '</div>';

  // Category score mini-bars
  h += '<div style="flex:1;display:grid;grid-template-columns:repeat(5,1fr);gap:6px;">';
  var cats = [
    { key: 'photos', label: 'Photos', icon: 'eye' },
    { key: 'description', label: 'Description', icon: 'edit' },
    { key: 'amenities', label: 'Amenities', icon: 'settings' },
    { key: 'reviews', label: 'Reviews', icon: 'star' },
    { key: 'platform_coverage', label: 'Platforms', icon: 'globe' }
  ];
  cats.forEach(function(cat) {
    var d = c[cat.key] || {};
    var sc = d.score || 0;
    var col = _lhStatusColor(d.status || 'critical');
    h += '<div style="text-align:center;">';
    h += '<div style="font-size:0.6rem;color:var(--text3);margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + _ico(cat.icon, 10, col) + ' ' + cat.label + '</div>';
    h += '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">';
    h += '<div style="height:100%;width:' + sc + '%;background:' + col + ';border-radius:3px;transition:width 0.5s;"></div>';
    h += '</div>';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.62rem;font-weight:600;color:' + col + ';margin-top:2px;">' + sc + '</div>';
    h += '</div>';
  });
  h += '</div></div>';

  // ── Detailed Category Cards (Current vs Recommended grid) ─────────────
  // Each row: category | current state | recommendation | action
  h += '<div style="display:flex;flex-direction:column;gap:8px;">';

  // ── Photos ─────────────────────────────────────────────────────────────
  var ph = c.photos;
  h += _lhRow(
    _ico('eye', 14, _lhStatusColor(ph.status)) + ' Photos',
    ph.status,
    '<span style="font-family:DM Mono,monospace;font-weight:700;font-size:0.88rem;">' + ph.count + '</span> <span style="color:var(--text3);">/ ' + ph.target + ' target</span>' +
      (ph.local_count !== ph.guesty_count ? '<div style="font-size:0.65rem;color:var(--text3);margin-top:2px;">Local: ' + ph.local_count + ' · Guesty: ' + ph.guesty_count + '</div>' : ''),
    ph.count < ph.target
      ? 'Add ' + (ph.target - ph.count) + ' more photos' + (ph.missing_types.length > 0 ? '. Missing types: <strong>' + ph.missing_types.join(', ') + '</strong>' : '')
      : 'Photo count is excellent',
    (ai && ai.listing_health && ai.listing_health.photos) ? ai.listing_health.photos.recommendation : null,
    ph.count < ph.target ? '<a href="#" onclick="event.preventDefault();switchPropTab(\'details\');setTimeout(function(){var el=document.getElementById(\'propImagesSection\');if(el)el.scrollIntoView({behavior:\'smooth\'})},200)" style="color:var(--accent);font-size:0.7rem;white-space:nowrap;">' + _ico('camera', 11, 'var(--accent)') + ' Add photos</a>' : null
  );

  // ── Description ────────────────────────────────────────────────────────
  var desc = c.description;
  h += _lhRow(
    _ico('edit', 14, _lhStatusColor(desc.status)) + ' Description',
    desc.status,
    desc.has_description
      ? '<span style="font-family:DM Mono,monospace;font-weight:700;">' + desc.current_length + '</span> <span style="color:var(--text3);">chars / ' + desc.target_length + ' target</span>' +
        (desc.preview ? '<div style="font-size:0.68rem;color:var(--text3);margin-top:3px;line-height:1.4;font-style:italic;">"' + esc(desc.preview) + '"</div>' : '')
      : '<span style="color:var(--danger);font-weight:600;">No description</span> — sync from Guesty',
    desc.issues.length > 0 ? desc.issues.map(function(i) { return '• ' + esc(i); }).join('<br>') : 'Description meets best practices',
    (ai && ai.listing_health && ai.listing_health.description)
      ? (ai.listing_health.description.suggested_opener ? '<strong>Suggested opener:</strong> "' + esc(ai.listing_health.description.suggested_opener) + '"' : null)
      : null,
    null
  );

  // ── Amenities ──────────────────────────────────────────────────────────
  var am = c.amenities;
  h += _lhRow(
    _ico('settings', 14, _lhStatusColor(am.status)) + ' Amenities',
    am.status,
    '<span style="font-family:DM Mono,monospace;font-weight:700;font-size:0.88rem;">' + am.count + '</span> <span style="color:var(--text3);">tracked / ' + am.target + ' target</span>',
    am.missing_high_impact.length > 0
      ? 'Missing high-impact: <strong>' + am.missing_high_impact.slice(0, 5).join(', ') + '</strong>'
      : 'All high-impact amenities covered',
    (ai && ai.listing_health && ai.listing_health.amenities) ? ai.listing_health.amenities.recommendation : null,
    am.count < am.target ? '<a href="#" onclick="event.preventDefault();switchPropTab(\'amenities\')" style="color:var(--accent);font-size:0.7rem;white-space:nowrap;">' + _ico('settings', 11, 'var(--accent)') + ' Edit amenities</a>' : null
  );

  // ── Reviews ────────────────────────────────────────────────────────────
  var rv = c.reviews;
  h += _lhRow(
    _ico('star', 14, _lhStatusColor(rv.status)) + ' Reviews',
    rv.status,
    '<span style="font-family:DM Mono,monospace;font-weight:700;font-size:0.88rem;">' + rv.total_count + '</span> <span style="color:var(--text3);">reviews / ' + rv.target_count + ' target</span>' +
      (rv.avg_rating > 0 ? '<div style="font-size:0.72rem;margin-top:2px;">' + rv.avg_rating + '★ avg' + (rv.per_platform.length > 0 ? ' · ' + rv.per_platform.map(function(p) { return esc(p.platform) + ': ' + (p.rating || '—') + '★ (' + p.count + ')'; }).join(', ') : '') + '</div>' : ''),
    rv.total_count < rv.target_count
      ? 'Need ' + (rv.target_count - rv.total_count) + ' more reviews to reach target'
      : 'Strong review count — focus on maintaining quality',
    (ai && ai.listing_health && ai.listing_health.reviews) ? ai.listing_health.reviews.strategy : null,
    rv.per_platform.length > 0 ? '<a href="#" onclick="event.preventDefault();switchPropTab(\'platforms\')" style="color:var(--accent);font-size:0.7rem;white-space:nowrap;">' + _ico('globe', 11, 'var(--accent)') + ' View platforms</a>' : null
  );

  // ── Platform Coverage ──────────────────────────────────────────────────
  var pl = c.platform_coverage;
  h += _lhRow(
    _ico('globe', 14, _lhStatusColor(pl.status)) + ' Platforms',
    pl.status,
    '<span style="font-family:DM Mono,monospace;font-weight:700;font-size:0.88rem;">' + pl.active_count + '</span> <span style="color:var(--text3);">linked</span>' +
      (pl.platforms.length > 0 ? '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;">' + pl.platforms.map(function(p) { return '<span style="font-size:0.65rem;padding:1px 6px;background:var(--surface2);border-radius:3px;">' + esc(p.name) + (p.rate ? ' $' + Math.round(p.rate) : '') + '</span>'; }).join('') + '</div>' : ''),
    pl.missing.length > 0
      ? 'Not listed on: <strong>' + pl.missing.join(', ') + '</strong>'
      : 'Good multi-platform coverage',
    (ai && ai.listing_health && ai.listing_health.pricing_position) ? ai.listing_health.pricing_position.recommendation : null,
    pl.missing.length > 0 ? '<a href="#" onclick="event.preventDefault();switchPropTab(\'platforms\')" style="color:var(--accent);font-size:0.7rem;white-space:nowrap;">' + _ico('link', 11, 'var(--accent)') + ' Add platform</a>' : null
  );

  h += '</div>';

  // ── AI Recommendations Banner ──────────────────────────────────────────
  if (ai && ai.listing_improvements && ai.listing_improvements.length > 0 && !ai.listing_health) {
    // Fallback: show flat listing_improvements from revenue optimization
    h += '<div style="margin-top:12px;padding:10px 12px;background:var(--purple-dim);border:1px solid rgba(167,139,250,0.2);border-radius:8px;">';
    h += '<div style="font-size:0.72rem;font-weight:600;color:var(--purple);margin-bottom:6px;">' + _ico('sparkle', 12, 'var(--purple)') + ' AI Listing Suggestions</div>';
    ai.listing_improvements.forEach(function(imp) {
      h += '<div style="font-size:0.75rem;color:var(--text2);margin:3px 0;">• ' + esc(imp) + '</div>';
    });
    h += '</div>';
  }

  if (ai && ai._created_at) {
    h += '<div style="text-align:right;margin-top:8px;font-size:0.62rem;color:var(--text3);">AI recommendations from ' + fmtUTC(ai._created_at) + (ai._provider ? ' · ' + ai._provider : '') + '</div>';
  }

  return h;
}

function _lhRow(label, status, currentHtml, recommendHtml, aiHtml, actionHtml) {
  var borderColor = _lhStatusColor(status);
  var h = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;padding:10px 12px;background:var(--surface2);border-radius:8px;border-left:3px solid ' + borderColor + ';align-items:start;font-size:0.78rem;">';

  // Col 1: Category label + status badge
  h += '<div>';
  h += '<div style="font-weight:600;color:var(--text);margin-bottom:3px;display:flex;align-items:center;gap:4px;">' + label + '</div>';
  h += '<span style="font-size:0.6rem;padding:1px 6px;border-radius:3px;font-weight:600;background:' + borderColor + '20;color:' + borderColor + ';">' + _lhStatusIcon(status) + ' ' + _lhStatusLabel(status) + '</span>';
  h += '</div>';

  // Col 2: Current state
  h += '<div>';
  h += '<div style="font-size:0.6rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px;">Current</div>';
  h += '<div style="color:var(--text2);line-height:1.4;">' + currentHtml + '</div>';
  h += '</div>';

  // Col 3: Recommendation
  h += '<div>';
  h += '<div style="font-size:0.6rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:3px;">Recommendation</div>';
  h += '<div style="color:var(--text2);line-height:1.4;">' + recommendHtml + '</div>';
  if (aiHtml) {
    h += '<div style="margin-top:4px;padding:4px 8px;background:var(--purple-dim);border-radius:4px;font-size:0.7rem;color:var(--purple);line-height:1.4;">' + _ico('sparkle', 10, 'var(--purple)') + ' ' + aiHtml + '</div>';
  }
  h += '</div>';

  // Col 4: Action link
  h += '<div style="text-align:right;">';
  if (actionHtml) h += actionHtml;
  h += '</div>';

  h += '</div>';
  return h;
}
