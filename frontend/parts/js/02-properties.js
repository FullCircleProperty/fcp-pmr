// Properties

// Centralized property display name: custom name > "Address - Unit#" > "Address"
function getPropertyLabel(p) {
  var base = p.name || p.address || 'Untitled';
  if (p.unit_number) return base + ' — Unit ' + p.unit_number;
  return base;
}

function toggleMortCalc() {
  var body = document.getElementById('mortCalcBody');
  var arrow = document.getElementById('mortCalcArrow');
  if (!body) return;
  body.style.display = body.style.display === 'none' ? '' : 'none';
  if (arrow) arrow.textContent = body.style.display === 'none' ? '▸' : '▾';
}

function calcMortgage() {
  var price = parseFloat((document.getElementById('f_price') || {}).value) || 0;
  var downPct = parseFloat((document.getElementById('mc_down_pct') || {}).value);
  if (isNaN(downPct)) downPct = 20;
  var rate = parseFloat((document.getElementById('mc_rate') || {}).value) || 7.0;
  var termYrs = parseInt((document.getElementById('mc_term') || {}).value) || 30;

  if (price <= 0) return;

  // Auto-open the calculator when user enters a purchase price
  var body = document.getElementById('mortCalcBody');
  var arrow = document.getElementById('mortCalcArrow');
  if (body && body.style.display === 'none' && price > 0) {
    body.style.display = '';
    if (arrow) arrow.textContent = '▾';
  }

  var downAmt = Math.round(price * downPct / 100);
  var loan = price - downAmt;
  var el;

  el = document.getElementById('mc_down_amt');
  if (el && document.activeElement !== el) el.value = downAmt;
  el = document.getElementById('mc_loan');
  if (el) el.value = loan;

  if (loan <= 0 || rate <= 0) {
    el = document.getElementById('mc_monthly');
    if (el) el.value = 0;
    return;
  }

  // Standard amortization: M = P * [r(1+r)^n] / [(1+r)^n - 1]
  var monthlyRate = rate / 100 / 12;
  var numPayments = termYrs * 12;
  var monthly = loan * (monthlyRate * Math.pow(1 + monthlyRate, numPayments)) / (Math.pow(1 + monthlyRate, numPayments) - 1);
  monthly = Math.round(monthly);

  el = document.getElementById('mc_monthly');
  if (el) el.value = monthly;

  // Auto-apply to mortgage field
  var autoApply = document.getElementById('mc_auto_apply');
  if (autoApply && autoApply.checked) {
    var mortEl = document.getElementById('f_mortgage');
    if (mortEl) {
      mortEl.value = monthly;
      if (typeof updateCostSummary === 'function') updateCostSummary();
    }
  }

  // Summary
  var totalPaid = monthly * numPayments;
  var totalInterest = totalPaid - loan;
  var summaryEl = document.getElementById('mortCalcSummary');
  if (summaryEl) {
    summaryEl.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap;">' +
      '<span>Down: <strong>$' + downAmt.toLocaleString() + '</strong> (' + downPct + '%)</span>' +
      '<span>Loan: <strong>$' + loan.toLocaleString() + '</strong></span>' +
      '<span>Monthly P&I: <strong style="color:var(--accent);">$' + monthly.toLocaleString() + '</strong></span>' +
      '<span>Total Interest: <strong style="color:var(--danger);">$' + totalInterest.toLocaleString() + '</strong> over ' + termYrs + 'yr</span>' +
      '</div>';
  }
}

function calcMortgageFromAmt() {
  var price = parseFloat((document.getElementById('f_price') || {}).value) || 0;
  var downAmt = parseFloat((document.getElementById('mc_down_amt') || {}).value) || 0;
  if (price > 0 && downAmt > 0) {
    var pct = Math.round(downAmt / price * 1000) / 10;
    var el = document.getElementById('mc_down_pct');
    if (el) el.value = pct;
  }
  calcMortgage();
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

  // ── Compute blended average nightly rate ──
  // Base alone is misleading — actual revenue includes weekend premiums, seasonal markups, and PriceLabs dynamic adjustments
  var base = p.pl_base_price || 0;
  var rec = p.pl_rec_base || base;
  var min = p.pl_min_price || base;
  var max = p.pl_max_price || base;
  var cleaning = p.pl_cleaning || p.cleaning_fee || 0;

  // Blended ADR estimate: weighted average
  // ~40% at base (weekdays), ~30% at rec/mid (demand-adjusted), ~20% at weekend premium (~1.2x), ~10% at peak
  var blendedADR = 0;
  var adrSource = '';
  if (base > 0 && max > 0) {
    var weekdayRate = base;
    var demandRate = rec > 0 ? rec : base;
    var weekendRate = Math.round(base * 1.2);
    var peakRate = Math.round((base + max) / 2);
    blendedADR = Math.round(weekdayRate * 0.4 + demandRate * 0.3 + weekendRate * 0.2 + peakRate * 0.1);
    adrSource = 'Blended from PriceLabs: base $' + base + ' (40%) + recommended $' + demandRate + ' (30%) + weekend est $' + weekendRate + ' (20%) + peak est $' + peakRate + ' (10%)';
  } else if (p.analysis_nightly_rate > 0) {
    blendedADR = p.analysis_nightly_rate;
    adrSource = 'From pricing analysis';
  }

  // Occupancy — PriceLabs forward-looking numbers are booking pace, NOT annual occupancy
  // A property showing "13% occ next 30d" is normal — bookings come in closer to date
  // For revenue projection, use realistic annual average occupancy for STR
  var plFwdOcc = p.pl_occ_30d ? parseInt(p.pl_occ_30d) / 100 : 0;
  var plMktFwdOcc = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) / 100 : 0;

  // Estimate actual annual occupancy:
  // If PL forward occ is very low (<30%), it's just booking pace — use regional estimate
  // If PL forward occ is high (>50%), property is performing well — use it
  var annualOcc = 0.50; // default: 50% for STR
  var occSource = '';
  if (p.analysis_occ && p.analysis_occ > 0.2) {
    annualOcc = p.analysis_occ;
    occSource = 'From analysis: ' + Math.round(annualOcc * 100) + '%';
  }
  if (plFwdOcc >= 0.50) {
    // High forward occupancy means strong demand — use it
    annualOcc = plFwdOcc;
    occSource = 'PriceLabs 30d forward: ' + Math.round(plFwdOcc * 100) + '% (strong pace)';
  } else if (plFwdOcc > 0 && plMktFwdOcc > 0 && plFwdOcc > plMktFwdOcc) {
    // Outperforming market — estimate annual at ~55-65%
    annualOcc = Math.max(0.55, Math.min(0.70, plFwdOcc * 3.5));
    occSource = 'Est. ' + Math.round(annualOcc * 100) + '% annual (outperforming market ' + Math.round(plFwdOcc * 100) + '% vs ' + Math.round(plMktFwdOcc * 100) + '%)';
  } else if (plFwdOcc > 0) {
    // Underperforming or no market comparison — estimate conservatively
    annualOcc = Math.max(0.40, Math.min(0.60, plFwdOcc * 3));
    occSource = 'Est. ' + Math.round(annualOcc * 100) + '% annual (PL forward: ' + Math.round(plFwdOcc * 100) + '%)';
  } else {
    occSource = 'Default estimate: 50% (no occupancy data)';
  }

  var occ30 = annualOcc; // use for all revenue calcs
  var mktOcc30 = plMktFwdOcc;

  // Revenue projections
  var monthlyBaseRev = base > 0 ? Math.round(base * 30 * occ30) : 0;
  var monthlyBlendedRev = blendedADR > 0 ? Math.round(blendedADR * 30 * occ30) : 0;
  // Turnovers estimate: occupancy × 30 days / avg stay length (~3 nights)
  var avgStay = 3;
  var turnovers = Math.round(occ30 * 30 / avgStay);
  var monthlyCleanRev = cleaning > 0 ? Math.round(cleaning * turnovers) : 0;
  var totalMonthlyRev = monthlyBlendedRev + monthlyCleanRev;

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
  if (p.pl_base_price) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(167,139,250,0.1);color:var(--purple);border:1px solid rgba(167,139,250,0.2);">📊 PriceLabs data</span>';
  if (p.analysis_nightly_rate) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(16,185,129,0.1);color:var(--accent);border:1px solid rgba(16,185,129,0.2);">🤖 Analysis data</span>';
  if (p.pl_occ_30d) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(59,130,246,0.1);color:var(--blue);border:1px solid rgba(59,130,246,0.2);">📈 Live occupancy</span>';
  if (!p.pl_base_price && !p.analysis_nightly_rate) h += '<span style="font-size:0.68rem;padding:2px 8px;border-radius:4px;background:rgba(245,158,11,0.1);color:#f59e0b;border:1px solid rgba(245,158,11,0.2);">⚠ No pricing data — run analysis or sync PriceLabs</span>';
  h += '</div>';

  // ── Key Metrics ──
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:16px;">';
  function fc(label, val, color, sub, src) {
    return '<div style="text-align:center;padding:10px 6px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">' +
      '<div style="font-size:0.62rem;color:var(--text3);">' + label + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:' + (color || 'var(--text)') + ';">' + val + '</div>' +
      (sub ? '<div style="font-size:0.58rem;color:var(--text3);">' + sub + '</div>' : '') +
      (src ? '<div style="font-size:0.55rem;color:' + (src.includes('PriceLabs') ? 'var(--purple)' : src.includes('Analysis') ? 'var(--accent)' : 'var(--text3)') + ';">' + src + '</div>' : '') +
      '</div>';
  }

  if (blendedADR > 0) h += fc('Blended ADR', '$' + blendedADR + '/nt', 'var(--accent)', base > 0 ? 'base $' + base + ' · max $' + max : '', 'PriceLabs blended');
  else if (base > 0) h += fc('Base Rate', '$' + base + '/nt', 'var(--purple)', '', 'PriceLabs');
  h += fc('Est. Annual Occ', Math.round(occ30 * 100) + '%', occ30 >= 0.50 ? 'var(--accent)' : '#f59e0b', occSource.substring(0, 40), '');
  if (plFwdOcc > 0) h += fc('PL Forward 30d', Math.round(plFwdOcc * 100) + '%', plFwdOcc > plMktFwdOcc ? 'var(--accent)' : 'var(--danger)', plMktFwdOcc > 0 ? 'market ' + Math.round(plMktFwdOcc * 100) + '%' : '', 'booking pace');
  h += fc('Monthly Revenue', '$' + totalMonthlyRev.toLocaleString(), 'var(--accent)', 'nightly + cleaning', blendedADR > 0 ? 'Blended rate' : 'Base rate');
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

  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--accent);margin-bottom:4px;">REVENUE</div>';
  if (monthlyBlendedRev > 0) h += plRow('Nightly Revenue', monthlyBlendedRev, monthlyBlendedRev * 12, 'var(--accent)', true, '$' + blendedADR + ' ADR × ' + Math.round(occ30 * 30) + ' nights');
  if (monthlyCleanRev > 0) h += plRow('Cleaning Fee Revenue', monthlyCleanRev, monthlyCleanRev * 12, 'var(--accent)', true, '$' + cleaning + ' × ' + turnovers + ' turnovers');
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
    h += '<div style="font-size:0.72rem;font-weight:600;color:#f59e0b;margin-bottom:6px;">🏢 BUILDING OWNERSHIP SHARE</div>';
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
    var catIcons2 = {closing:'📋',renovation:'🔨',repair:'🔧',furniture:'🛋️',appliance:'⚡',legal:'📜',other:'📌'};
    var totalCapital = 0;
    propExpenses.forEach(function(e) { totalCapital += e.amount || 0; });
    var allInCost = (p.purchase_price || 0) + totalCapital;

    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:8px;">💰 CAPITAL INVESTMENT</div>';

    propExpenses.forEach(function(e) {
      var icon = catIcons2[e.category] || '📌';
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
      h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Capital Payback</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:' + (paybackMonths <= 24 ? 'var(--accent)' : paybackMonths <= 48 ? '#f59e0b' : 'var(--danger)') + ';">' + paybackMonths + ' mo</div><div style="font-size:0.55rem;color:var(--text3);">~' + Math.round(paybackMonths / 12 * 10) / 10 + ' years</div></div>';
      if (cashOnCash !== 0) h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Cash-on-Cash ROI</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:' + (cashOnCash >= 8 ? 'var(--accent)' : cashOnCash >= 4 ? '#f59e0b' : 'var(--danger)') + ';">' + cashOnCash + '%</div></div>';
      h += '</div>';
    } else if (monthlyNet <= 0 && totalCapital > 0) {
      h += '<div style="font-size:0.78rem;color:var(--danger);margin-top:6px;">⚠ Currently not profitable — capital payback cannot be estimated.</div>';
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
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--accent);margin-bottom:8px;">🏦 EQUITY POSITION</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin-bottom:8px;">';

    function eqCard(label, val, color, sub) { return '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">' + label + '</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:' + (color || 'var(--text)') + ';">' + val + '</div>' + (sub ? '<div style="font-size:0.55rem;color:var(--text3);">' + sub + '</div>' : '') + '</div>'; }

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
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--accent);margin-bottom:8px;">📊 ACTUAL PERFORMANCE (Guesty · ' + actuals.length + ' months)</div>';

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
        h += '<div style="font-size:0.55rem;color:var(--text3);margin-top:2px;">' + (a.month || '').substring(5) + '</div></div>';
      });
      h += '</div>';
    }
    h += '</div>';
  }

  // ── Seasonality Pattern ──
  var seasonality = window._propSeasonality || [];
  if (seasonality.length >= 6) {
    h += '<div style="padding:14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:8px;">📅 SEASONALITY (' + esc(p.city) + ', ' + esc(p.state) + ')</div>';
    var monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    h += '<div style="display:flex;gap:2px;align-items:flex-end;height:80px;margin-bottom:6px;">';
    var maxMult = Math.max.apply(null, seasonality.map(function(s) { return s.multiplier || 1; }));
    seasonality.forEach(function(s) {
      var pct = maxMult > 0 ? Math.round((s.multiplier || 1) / maxMult * 100) : 50;
      var color = (s.multiplier || 1) >= 1.1 ? 'var(--accent)' : (s.multiplier || 1) <= 0.8 ? 'var(--danger)' : '#f59e0b';
      h += '<div style="flex:1;text-align:center;">';
      h += '<div style="font-size:0.55rem;color:var(--text3);">' + (s.multiplier ? s.multiplier.toFixed(1) + 'x' : '') + '</div>';
      h += '<div style="background:' + color + ';border-radius:3px 3px 0 0;height:' + Math.max(pct, 5) + '%;min-height:3px;opacity:0.7;" title="' + monthNames[(s.month_number || 1) - 1] + ': ' + (s.avg_adr ? '$' + Math.round(s.avg_adr) + ' ADR' : '') + ' · ' + (s.avg_occupancy ? Math.round(s.avg_occupancy * 100) + '% occ' : '') + '"></div>';
      h += '<div style="font-size:0.55rem;color:var(--text3);margin-top:2px;">' + monthNames[(s.month_number || 1) - 1] + '</div></div>';
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
    h += '<div style="font-size:0.82rem;font-weight:600;color:#f59e0b;margin-bottom:6px;">🎯 12-MONTH REVENUE TARGETS</div>';

    // Show what the targets are actually based on — transparent about data quality
    var basisColor = meta.targetBasis && meta.targetBasis.includes('cost floor') && !meta.targetBasis.includes('market') ? '#f59e0b' : 'var(--text3)';
    h += '<div style="font-size:0.68rem;color:' + basisColor + ';margin-bottom:6px;padding:6px 8px;background:var(--bg);border-radius:4px;border:1px solid var(--border);">';
    h += '📐 <strong>Target basis:</strong> ' + esc(meta.targetBasis || 'cost coverage') + '<br>';
    if (meta.baseADR > 0) {
      h += '📊 <strong>Rate source:</strong> ' + esc(meta.adrSource || 'pricing analysis') + ' ($' + meta.baseADR + '/nt base, scaled by season per month)<br>';
    } else {
      h += '⚠️ <strong>No rate data yet</strong> — run Price Analysis or connect PriceLabs to get market-based targets. Required ADR column will be blank.<br>';
    }
    if (!meta.hasSeasonality) {
      h += '⚠️ <strong>No seasonality data</strong> — import Guesty reservations to calibrate seasonal targets for ' + esc((p.city || '') + ', ' + (p.state || '')) + '.<br>';
    }
    if (!meta.hasActuals) {
      h += 'ℹ️ Occupancy estimates based on ' + (meta.hasSeasonality ? 'market averages' : 'default 40%') + ' — will sharpen as Guesty data accumulates.';
    }
    h += '</div>';

    if (meta.marketEstimate > 0 && meta.costFloor > 0 && meta.marketEstimate < meta.costFloor) {
      h += '<div style="font-size:0.72rem;color:var(--danger);padding:6px 8px;background:rgba(239,68,68,0.06);border-radius:4px;border:1px solid rgba(239,68,68,0.2);margin-bottom:6px;">';
      h += '⚠️ <strong>Market estimate ($' + Math.round(meta.marketEstimate / 12).toLocaleString() + '/mo) is below your expenses ($' + Math.round(meta.costFloor / 12 / 1.15).toLocaleString() + '/mo).</strong> Either pricing is too low, occupancy is overestimated, or this market may not cover costs at current rates. Run Price Analysis to get an updated rate recommendation.';
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
      var statusIcon = !isPast && !isCurrent ? '—' : isCurrent ? '📊' : pct >= 95 ? '🚀' : pct >= 80 ? '✅' : pct >= 60 ? '⚠️' : '❌';
      var rowBg = isCurrent ? 'background:rgba(245,158,11,0.06);' : '';
      var gapColor = t.gap > 20 ? 'var(--danger)' : t.gap < -20 ? 'var(--accent)' : 'var(--text2)';
      var statusColor = pct >= 95 ? 'var(--accent)' : pct >= 80 ? 'var(--accent)' : pct >= 60 ? '#f59e0b' : 'var(--danger)';
      var occTip = t.occSource ? ' title="' + esc(t.occSource) + '"' : '';

      h += '<tr style="' + rowBg + '">';
      h += '<td style="font-weight:600;">' + t.monthName + (isCurrent ? ' *' : '') + (t.seasonMult !== 1.0 ? '<div style="font-size:0.55rem;color:var(--text3);">' + t.seasonMult.toFixed(2) + 'x</div>' : '') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:#f59e0b;">$' + Math.round(t.target).toLocaleString() + '</td>';
      h += '<td' + occTip + '>' + t.expectedOcc + '%<div style="font-size:0.55rem;color:var(--text3);">' + esc(t.occSource || '') + '</div></td>';
      h += '<td style="font-family:DM Mono,monospace;font-weight:600;">' + (t.requiredADR > 0 ? '$' + Math.round(t.requiredADR) : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (t.currentRate > 0 ? '$' + Math.round(t.currentRate) : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + gapColor + ';">' + (t.currentRate > 0 && t.requiredADR > 0 ? (t.gap > 0 ? '+$' + Math.round(t.gap) : '-$' + Math.abs(Math.round(t.gap))) : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;' + (actualRev > 0 ? 'color:var(--accent);' : '') + '">' + (actualRev > 0 ? '$' + Math.round(actualRev).toLocaleString() : (isPast ? '<span style="color:var(--danger);">$0</span>' : '—')) + '</td>';
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
    h += '<div style="font-weight:600;font-size:0.85rem;margin-bottom:12px;">📊 STR vs LTR Comparison</div>';
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
    if (strAdvantage > 200) h += '✅ STR is earning <strong style="color:var(--accent);">+$' + Math.round(strAdvantage).toLocaleString() + '/mo more</strong> than LTR would. STR is the right call.';
    else if (strAdvantage > 0) h += '⚠️ STR is only <strong>+$' + Math.round(strAdvantage).toLocaleString() + '/mo</strong> more than LTR. Factor in management time and effort.';
    else h += '❌ LTR would earn <strong style="color:var(--danger);">$' + Math.abs(Math.round(strAdvantage)).toLocaleString() + '/mo more</strong> with less work. Consider switching to long-term.';
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
      el.innerHTML = '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);font-size:0.78rem;color:var(--text3);">📈 Performance tracking started. Sync PriceLabs regularly to build history — trends will appear here after 2+ data points.</div>';
      return;
    }

    var h = '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
    h += '<div style="font-weight:600;font-size:0.85rem;margin-bottom:10px;">📈 Performance Trend (' + snaps.length + ' snapshots)</div>';

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
    if (p.pl_rec_base) h += snapCard('PL Recommended', '$' + p.pl_rec_base + '/nt', p.pl_rec_base > p.pl_base_price ? '↑ raise $' + (p.pl_rec_base - p.pl_base_price) : p.pl_rec_base < p.pl_base_price ? '↓ lower $' + (p.pl_base_price - p.pl_rec_base) : 'on target', p.pl_rec_base > p.pl_base_price ? 'var(--accent)' : 'var(--purple)');
  }

  // Occupancy
  if (p.pl_occ_30d) {
    var yourOcc = parseInt(p.pl_occ_30d);
    var mktOcc = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) : 0;
    h += snapCard('Your Occupancy', yourOcc + '%', mktOcc ? 'market: ' + mktOcc + '%' : '', yourOcc > mktOcc ? 'var(--accent)' : 'var(--danger)');
  }

  // Current projected revenue
  var plRev = 0;
  if (p.pl_base_price && p.pl_occ_30d) {
    plRev = Math.round(p.pl_base_price * 30 * parseInt(p.pl_occ_30d) / 100);
    h += snapCard('Current Revenue', '$' + plRev.toLocaleString() + '/mo', '$' + (plRev * 12).toLocaleString() + '/yr', 'var(--accent)');
  }

  // Analysis projected
  if (p.analysis_monthly && p.analysis_monthly > 0) {
    var diff = p.analysis_monthly - (plRev || 0);
    h += snapCard('Analysis Projects', '$' + Math.round(p.analysis_monthly).toLocaleString() + '/mo', p.analysis_nightly_rate ? '$' + p.analysis_nightly_rate + '/nt @ ' + Math.round((p.analysis_occ || 0.5) * 100) + '%' : '', diff > 0 ? 'var(--accent)' : 'var(--text2)');
    if (plRev > 0 && Math.abs(diff) > 50) {
      h += snapCard('Revenue Gap', (diff > 0 ? '+' : '') + '$' + diff.toLocaleString() + '/mo', (diff > 0 ? '+' : '') + '$' + (diff * 12).toLocaleString() + '/yr', diff > 0 ? 'var(--accent)' : 'var(--danger)');
    }
  }

  // Monthly expenses
  var cost = 0;
  if (p.ownership_type === 'rental') cost = p.monthly_rent_cost || 0;
  else cost = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0);
  cost += (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);
  if (cost > 0) {
    var netRev = (plRev || p.analysis_monthly || 0) - cost;
    h += snapCard('Expenses', '$' + Math.round(cost).toLocaleString() + '/mo', '', 'var(--danger)');
    h += snapCard('Net Income', (netRev >= 0 ? '+' : '') + '$' + Math.round(netRev).toLocaleString() + '/mo', '$' + (Math.round(netRev) * 12).toLocaleString() + '/yr', netRev >= 0 ? 'var(--accent)' : 'var(--danger)');
  }

  h += '</div></div>';
  el.innerHTML = h;
}

async function generateRevenueOptimization() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var btn = document.getElementById('genOptBtn');
  var res = document.getElementById('revenueOptResults');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyzing...'; }
  showLoading('AI analyzing revenue optimization opportunities...');
  try {
    var d = await api('/api/properties/' + editId + '/revenue-optimize', 'POST');
    renderRevenueOptimization(d, res);
    toast('Optimization analysis complete');
  } catch (err) {
    if (res) res.innerHTML = '<div style="color:var(--danger);padding:10px;">' + esc(err.message) + '</div>';
    toast(err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '🚀 Optimize Revenue'; }
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
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">⚡ QUICK WINS (do today)</div>';
    o.quick_wins.forEach(function(w) { h += '<div style="font-size:0.78rem;margin:4px 0;">✓ ' + esc(w) + '</div>'; });
    h += '</div>';
  }

  // Occupancy improvements
  if (o.occupancy_improvements && o.occupancy_improvements.length > 0) {
    h += '<div style="padding:12px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:12px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:6px;">📈 INCREASE OCCUPANCY</div>';
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
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">💰 INCREASE REVENUE</div>';
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
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:6px;">⚙️ PRICELABS ADJUSTMENTS</div>';
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
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:4px;">📝 LISTING IMPROVEMENTS</div>';
      o.listing_improvements.forEach(function(i) { h += '<div style="font-size:0.75rem;margin:3px 0;">• ' + esc(i) + '</div>'; });
      h += '</div>';
    }
    if (o.guest_experience_improvements && o.guest_experience_improvements.length > 0) {
      h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);margin-bottom:4px;">🏠 GUEST EXPERIENCE</div>';
      o.guest_experience_improvements.forEach(function(i) { h += '<div style="font-size:0.75rem;margin:3px 0;">• ' + esc(i) + '</div>'; });
      h += '</div>';
    }
    h += '</div>';
  }

  // 90-day plan
  if (o.ninety_day_plan) {
    h += '<div style="padding:14px;background:linear-gradient(135deg,rgba(167,139,250,0.06),rgba(16,185,129,0.06));border:1px solid rgba(167,139,250,0.2);border-radius:8px;margin-bottom:12px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:6px;">🎯 90-DAY PLAN</div>';
    h += '<div style="font-size:0.82rem;line-height:1.5;color:var(--text);">' + esc(o.ninety_day_plan) + '</div>';
    h += '</div>';
  }

  h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:8px;">Generated by ' + esc(d.provider || 'AI') + ' · Read-only recommendations — no prices changed.</div>';
  container.innerHTML = h;
}

async function generateAcquisitionAnalysis() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var btn = document.getElementById('genAcqBtn');
  var res = document.getElementById('acquisitionResults');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyzing...'; }
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
  if (btn) { btn.disabled = false; btn.textContent = '🏠 Update Analysis'; }
  hideLoading();
}

function renderAcquisitionAnalysis(d, container) {
  if (!container || !d.analysis) return;
  var a = d.analysis;
  var h = '';

  // Change button to "Update" since we have data
  var acqBtn = document.getElementById('genAcqBtn');
  if (acqBtn) acqBtn.innerHTML = '🏠 Update Analysis';

  // Verdict banner
  var vc = a.verdict === 'GO' ? 'var(--accent)' : a.verdict === 'NO-GO' ? 'var(--danger)' : '#f59e0b';
  var vBg = a.verdict === 'GO' ? 'rgba(16,185,129,0.08)' : a.verdict === 'NO-GO' ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)';
  var vBdr = a.verdict === 'GO' ? 'rgba(16,185,129,0.3)' : a.verdict === 'NO-GO' ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)';
  var vIcon = a.verdict === 'GO' ? '✅' : a.verdict === 'NO-GO' ? '❌' : '⚠️';
  h += '<div style="padding:18px;background:' + vBg + ';border:2px solid ' + vBdr + ';border-radius:10px;margin-bottom:14px;text-align:center;">';
  h += '<div style="font-size:2rem;">' + vIcon + '</div>';
  h += '<div style="font-size:1.3rem;font-weight:700;color:' + vc + ';margin:4px 0;">' + esc(a.verdict) + '</div>';
  h += '<div style="font-size:0.75rem;color:var(--text3);">Confidence: ' + esc(a.confidence || 'medium') + '</div>';
  h += '<div style="font-size:0.88rem;color:var(--text);margin-top:8px;line-height:1.6;">' + esc(a.summary || '') + '</div>';
  h += '</div>';

  // Considerations dialog
  h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
  h += '<strong style="font-size:0.82rem;">📝 Considerations for Next Update</strong>';
  h += '<button class="btn btn-xs" onclick="saveAcqConsiderations()">Save</button></div>';
  h += '<textarea id="acqConsiderations" placeholder="Add notes for AI to consider next time: e.g. \'property needs new roof ~$15K\', \'zoning allows ADU\', \'HOA restricts STR\', \'seller willing to negotiate\'..." style="width:100%;height:60px;font-size:0.78rem;padding:8px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);resize:vertical;">' + esc(window._acqConsiderations || '') + '</textarea>';
  h += '</div>';

  // Financial projections grid
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin-bottom:14px;">';
  function ac(l,v,c,s){return '<div style="text-align:center;padding:10px 6px;background:var(--surface2);border-radius:6px;border:1px solid var(--border);"><div style="font-size:0.6rem;color:var(--text3);">'+l+'</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:'+(c||'var(--text)')+';">'+v+'</div>'+(s?'<div style="font-size:0.55rem;color:var(--text3);">'+s+'</div>':'')+'</div>';}
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
  [['Strengths', a.strengths, 'var(--accent)', '💪'], ['Weaknesses', a.weaknesses, 'var(--danger)', '⚠️'], ['Opportunities', a.opportunities, 'var(--purple)', '🎯'], ['Threats', a.threats, '#f59e0b', '🔥']].forEach(function(sw) {
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
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:8px;">🔧 RECOMMENDED UPGRADES</div>';
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
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--accent);margin-bottom:8px;">📊 STR COMPARABLES</div>';
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
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--blue);margin-bottom:8px;">🏠 LTR COMPARABLES</div>';
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
    h += '<div style="font-size:0.82rem;font-weight:600;color:#f59e0b;margin-bottom:8px;">🏷️ NEARBY PROPERTIES FOR SALE</div>';
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
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">💰 REVENUE PROJECTIONS BY STRATEGY</div>';
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
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">📜 LOCAL REGULATIONS</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:10px;">';
    var strOk = reg.str_allowed === true ? 'var(--accent)' : reg.str_allowed === false ? 'var(--danger)' : '#f59e0b';
    h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">STR Allowed</div><div style="font-weight:700;color:' + strOk + ';">' + (reg.str_allowed === true ? '✅ Yes' : reg.str_allowed === false ? '❌ No' : '❓ Check') + '</div></div>';
    h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Permit Required</div><div style="font-weight:700;">' + (reg.permit_required === true ? '📋 Yes' : reg.permit_required === false ? 'No' : '❓ Check') + '</div></div>';
    if (reg.occupancy_tax_pct) h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Occupancy Tax</div><div style="font-weight:700;">' + reg.occupancy_tax_pct + '%</div></div>';
    if (reg.max_occupancy_days) h += '<div style="text-align:center;padding:8px;background:var(--bg);border-radius:6px;"><div style="font-size:0.6rem;color:var(--text3);">Max Days/Year</div><div style="font-weight:700;">' + reg.max_occupancy_days + '</div></div>';
    h += '</div>';
    if (reg.notes) h += '<div style="font-size:0.85rem;color:var(--text);line-height:1.6;">' + esc(reg.notes) + '</div>';
    h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:8px;">⚠️ Always verify regulations with the local municipality before purchasing. AI-sourced data may not be current.</div>';
    h += '</div>';
  }

  // ── Area Demand Analysis ──
  if (a.area_demand) {
    var ad = a.area_demand;
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);margin-bottom:14px;">';
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">🏙️ AREA DEMAND ANALYSIS</div>';
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
    h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">📈 FUTURE VALUE PROJECTION</div>';
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
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--text2);margin-bottom:6px;">🌍 MARKET OUTLOOK</div>';
    h += '<div style="font-size:0.88rem;color:var(--text);line-height:1.6;">' + esc(a.market_outlook) + '</div></div>';
  }
  if (a.comparable_performance) {
    h += '<div style="padding:14px;background:var(--surface2);border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--text2);margin-bottom:6px;">📊 VS. COMPARABLES</div>';
    h += '<div style="font-size:0.88rem;color:var(--text);line-height:1.6;">' + esc(a.comparable_performance) + '</div></div>';
  }

  // Final recommendation
  if (a.recommendation) {
    h += '<div style="padding:16px;background:' + vBg + ';border:2px solid ' + vBdr + ';border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:' + vc + ';margin-bottom:6px;">📋 FINAL RECOMMENDATION</div>';
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
    if (latest.pricing_analysis) savedInfo.push('🔍 Price Analysis: ' + latest.pricing_analysis.created_at.substring(0, 16).replace('T', ' '));
    if (latest.pl_strategy) savedInfo.push('📊 Strategy: ' + latest.pl_strategy.created_at.substring(0, 16).replace('T', ' '));
    if (latest.revenue_optimization) savedInfo.push('🚀 Optimization: ' + latest.revenue_optimization.created_at.substring(0, 16).replace('T', ' '));
    if (latest.acquisition_analysis) savedInfo.push('🏠 Acquisition: ' + latest.acquisition_analysis.created_at.substring(0, 16).replace('T', ' '));

    if (savedInfo.length > 0 && st) {
      st.innerHTML = '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:8px;">Saved reports: ' + savedInfo.join(' · ') + '</div>';
    }

    // Restore latest pricing analysis (from Run Price Analysis button) — highest priority
    var resultsEl = document.getElementById('plStrategyResults');
    if (resultsEl && !resultsEl.innerHTML && latest.pricing_analysis && latest.pricing_analysis.data) {
      var pd = latest.pricing_analysis.data;
      var h = '';
      // Restored banner
      var ago = Math.round((Date.now() - new Date(latest.pricing_analysis.created_at).getTime()) / 86400000);
      var agoText = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago + ' days ago';
      h += '<div style="font-size:0.7rem;color:var(--text3);padding:4px 8px;background:var(--bg);border:1px solid var(--border);border-radius:4px;margin-bottom:8px;">🔄 Restored from ' + agoText + ' · ' + latest.pricing_analysis.created_at.substring(0, 16).replace('T', ' ') + ' · <em>Run Price Analysis to refresh</em></div>';
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
          h += '<div style="font-size:0.55rem;color:var(--text3);margin-top:2px;">' + mNames[(s.month_number || 1) - 1] + '</div>';
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

    // Restore latest PL strategy if pricing analysis isn't available and container is still empty
    if (resultsEl && !resultsEl.innerHTML && latest.pl_strategy && latest.pl_strategy.data && latest.pl_strategy.data.strategy && !latest.pl_strategy.data.context?.parse_error) {
      renderPLStrategy(latest.pl_strategy.data, resultsEl);
    }
    // Restore latest revenue optimization
    var optRes = document.getElementById('revenueOptResults');
    if (optRes && !optRes.innerHTML && latest.revenue_optimization && latest.revenue_optimization.data && latest.revenue_optimization.data.optimization) {
      renderRevenueOptimization(latest.revenue_optimization.data, optRes);
    }
    // Restore latest acquisition analysis
    var acqRes = document.getElementById('acquisitionResults');
    if (acqRes && !acqRes.innerHTML && latest.acquisition_analysis && latest.acquisition_analysis.data && latest.acquisition_analysis.data.analysis) {
      renderAcquisitionAnalysis(latest.acquisition_analysis.data, acqRes);
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
  if (btn) btn.textContent = '⏳ Generating...';
  if (st) st.innerHTML = '🤖 Analyzing property data, market conditions, comps, and PriceLabs data...';
  if (res) res.innerHTML = ''; // Clear old results
  showLoading('Generating pricing strategy...');
  try {
    var d = await api('/api/properties/' + editId + '/pl-strategy', 'POST');
    if (st) st.innerHTML = '';
    renderPLStrategy(d, res);
    toast('Strategy generated');
  } catch (err) {
    var errMsg = err.message || 'Unknown error';
    var helpHtml = errMsg.includes('AI provider') ? '<div style="margin-top:6px;padding:8px 12px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.2);border-radius:6px;font-size:0.78rem;">💡 Go to <strong>Admin → API Keys</strong> and add your Anthropic or OpenAI API key. Workers AI (free) should also work if enabled on your Cloudflare account.</div>' : '';
    if (st) st.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(errMsg) + '</span>' + helpHtml;
    toast(errMsg, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = '📊 Generate Strategy'; }
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
    h += '<div style="font-size:0.85rem;color:var(--text);">' + esc(s.strategy_summary) + '</div>';
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
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--danger);margin-bottom:4px;">🔥 PEAK SEASON (+' + (s.peak_season_markup_pct || 0) + '%)</div>';
      h += '<div style="font-size:0.78rem;">' + s.peak_season_months.join(', ') + '</div></div>';
    }
    if (s.low_season_months && s.low_season_months.length > 0) {
      h += '<div style="padding:10px 14px;background:rgba(59,130,246,0.05);border:1px solid rgba(59,130,246,0.15);border-radius:8px;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--blue);margin-bottom:4px;">❄️ LOW SEASON (-' + (s.low_season_discount_pct || 0) + '%)</div>';
      h += '<div style="font-size:0.78rem;">' + s.low_season_months.join(', ') + '</div></div>';
    }
    h += '</div>';
  }

  // PriceLabs setup steps
  if (s.pricelabs_setup_steps && s.pricelabs_setup_steps.length > 0) {
    h += '<div style="padding:14px;background:rgba(167,139,250,0.04);border:1px solid rgba(167,139,250,0.15);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);margin-bottom:8px;">📋 PRICELABS SETUP STEPS</div>';
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
    h += '<div style="font-size:0.78rem;font-weight:600;color:#f59e0b;margin-bottom:8px;">⚠ RISKS</div>';
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
  try { const d = await api('/api/properties'); properties = d.properties || []; propTrends = d.trends || {}; window._actualRevenue = d.actual_revenue || {}; renderProperties(); }
  catch { properties = []; propTrends = {}; renderProperties(); }
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
  // Separate buildings from standalone
  var buildingIds = new Set();
  var childIds = new Set();
  sorted.forEach(function(p) {
    if (p.child_count > 0 || p.total_units_count > 0) buildingIds.add(p.id);
    if (p.parent_id) childIds.add(p.id);
  });

  var buildings = sorted.filter(function(p) { return buildingIds.has(p.id); });
  var standalone = sorted.filter(function(p) { return !buildingIds.has(p.id) && !childIds.has(p.id) && !p.is_research; });
  var research = sorted.filter(function(p) { return !buildingIds.has(p.id) && !childIds.has(p.id) && p.is_research; });

  var html = '';

  // ── BUILDINGS SECTION ──
  if (buildings.length > 0) {
    html += '<div style="margin-bottom:20px;">';
    html += '<div style="font-size:0.72rem;font-weight:600;color:var(--purple);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;padding:0 4px;">🏢 Buildings & Units (' + buildings.length + ' buildings)</div>';
    buildings.forEach(function(bld) {
      var children = sorted.filter(function(p) { return String(p.parent_id) === String(bld.id); });
      html += renderPropertyCard(bld, true, false);
      children.forEach(function(child) {
        html += renderPropertyCard(child, false, true);
      });
    });
    html += '</div>';
  }

  // ── STANDALONE SECTION ──
  if (standalone.length > 0) {
    html += '<div style="margin-bottom:20px;">';
    html += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;padding:0 4px;">🏠 Properties (' + standalone.length + ')</div>';
    standalone.forEach(function(p) {
      html += renderPropertyCard(p, false, false);
    });
    html += '</div>';
  }

  // ── RESEARCH SECTION ──
  if (research.length > 0) {
    html += '<div style="margin-bottom:20px;">';
    html += '<div style="font-size:0.72rem;font-weight:600;color:var(--purple);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;padding:0 4px;">🔬 Research (' + research.length + ')</div>';
    research.forEach(function(p) {
      html += renderPropertyCard(p, false, false);
    });
    html += '</div>';
  }

  list.innerHTML = html;
}

function renderPropertyCard(p, isBuilding, isChild) {
    var tl = p.property_type ? p.property_type.replace('_', ' ') : '';
    var typeIcons = {single_family:'🏠',apartment:'🏬',condo:'🏙️',townhouse:'🏘️',multi_family:'🏢',cabin:'🏕️',cottage:'🛖',villa:'🏡',mobile_home:'🚐'};
    var typeColors = {single_family:'59,130,246',apartment:'167,139,250',condo:'14,165,233',townhouse:'234,179,8',multi_family:'167,139,250',cabin:'180,83,9',cottage:'22,163,74',villa:'168,85,247',mobile_home:'107,114,128'};
    var typeIcon = typeIcons[p.property_type] || '🏠';
    var typeRgb = typeColors[p.property_type] || '148,163,184';
    var typeBadge = tl ? '<span class="badge" style="background:rgba(' + typeRgb + ',0.1);color:rgb(' + typeRgb + ');">' + typeIcon + ' ' + tl + '</span>' : '';
    var ownerBadge = p.ownership_type === 'rental' ? '<span class="badge" style="background:rgba(245,158,11,0.1);color:#f59e0b;">🔑 renting</span>' : '';
    var checked = selectedProps.has(p.id) ? ' checked' : '';
    var thumb = p.image_url ? '<div style="width:60px;height:60px;border-radius:6px;overflow:hidden;flex-shrink:0;"><img src="' + esc(p.image_url) + '" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.style.display=\'none\'"></div>' : '';
    var label = getPropertyLabel(p);
    var indent = isChild ? 'margin-left:28px;border-left:3px solid rgba(' + typeRgb + ',0.3);' : '';
    var buildingStyle = isBuilding ? 'border-left:4px solid rgb(' + typeRgb + ');background:linear-gradient(90deg,rgba(' + typeRgb + ',0.03),transparent);' : '';
    var standaloneAccent = (!isBuilding && !isChild) ? 'border-left:3px solid rgba(' + typeRgb + ',0.25);' : '';
    var childBadge = isBuilding ? '<span class="badge" style="background:rgba(' + typeRgb + ',0.15);color:rgb(' + typeRgb + ');">🏢 ' + (p.child_count || p.total_units_count || 0) + ' units</span>' : '';
    var unitBadge = isChild ? '<span style="font-size:0.68rem;color:rgb(' + typeRgb + ');background:rgba(' + typeRgb + ',0.1);padding:1px 6px;border-radius:3px;">↳ unit</span>' : '';
    var coordHtml = (p.latitude && p.longitude) ? '<span style="font-size:0.68rem;color:var(--text3);" title="' + p.latitude + ', ' + p.longitude + '">📍</span>' : '';

    // Calculate monthly cost
    var monthlyCost = 0;
    if (p.ownership_type === 'rental') {
      monthlyCost = p.monthly_rent_cost || 0;
    } else {
      monthlyCost = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0);
    }
    monthlyCost += (p.expense_electric || 0) + (p.expense_gas || 0) + (p.expense_water || 0) + (p.expense_internet || 0) + (p.expense_trash || 0) + (p.expense_other || 0);

    var monthlyRev = p.est_monthly_revenue || 0;

    // Compute PriceLabs projected revenue using blended ADR and smart occupancy
    var plMonthlyRev = 0;
    var cardADR = 0;
    if (p.pl_base_price) {
      var plFwd = p.pl_occ_30d ? parseInt(p.pl_occ_30d) / 100 : 0;
      var plMktFwd = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) / 100 : 0;
      // Smart occupancy: same logic as finance tab
      var cardOcc = p.analysis_occ && p.analysis_occ > 0.2 ? p.analysis_occ : 0.50;
      if (plFwd >= 0.50) cardOcc = plFwd;
      else if (plFwd > 0 && plMktFwd > 0 && plFwd > plMktFwd) cardOcc = Math.max(0.55, Math.min(0.70, plFwd * 3.5));
      else if (plFwd > 0) cardOcc = Math.max(0.40, Math.min(0.60, plFwd * 3));

      var plB = p.pl_base_price, plM = p.pl_max_price || plB, plR = p.pl_rec_base || plB;
      cardADR = Math.round(plB * 0.4 + plR * 0.3 + plB * 1.2 * 0.2 + (plB + plM) / 2 * 0.1);
      plMonthlyRev = Math.round(cardADR * 30 * cardOcc);
      if (plMonthlyRev > 0) monthlyRev = plMonthlyRev;
    }

    // Analysis projected revenue
    var analysisMonthly = p.analysis_monthly || 0;
    var net = monthlyRev - monthlyCost;

    // Revenue & pricing section (not shown for research-only)
    var revHtml = '';
    var actualRev = (window._actualRevenue || {})[p.id];
    if (!p.is_research && (p.pl_base_price || monthlyRev > 0 || analysisMonthly > 0 || actualRev)) {
      revHtml += '<div style="margin-top:6px;padding:8px 10px;background:var(--surface2);border-radius:6px;font-size:0.75rem;">';

      // Row 0: Actual revenue from Guesty (most important — real data)
      if (actualRev && actualRev.monthly_avg > 0) {
        revHtml += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        revHtml += '<span style="color:var(--accent);">✅ Actual (' + actualRev.months + 'mo avg)</span>';
        revHtml += '<span style="font-family:DM Mono,monospace;">';
        revHtml += '<strong style="color:var(--accent);">$' + actualRev.adr + '/nt</strong>';
        revHtml += ' · <span style="color:' + (actualRev.occ >= 50 ? 'var(--accent)' : actualRev.occ >= 30 ? '#f59e0b' : 'var(--danger)') + ';">' + actualRev.occ + '% occ</span>';
        revHtml += ' → <strong style="color:var(--accent);">$' + actualRev.monthly_avg.toLocaleString() + '/mo</strong>';
        revHtml += '</span></div>';
      }

      // Row 1: Current pricing (PriceLabs or set)
      if (p.pl_base_price) {
        revHtml += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        revHtml += '<span style="color:var(--text3);">📊 Current (PriceLabs)</span>';
        revHtml += '<span style="font-family:DM Mono,monospace;">';
        revHtml += '<strong style="color:var(--purple);">$' + p.pl_base_price + '/nt</strong>';
        if (cardADR > 0 && cardADR !== p.pl_base_price) revHtml += ' <span style="color:var(--text3);font-size:0.68rem;">(~$' + cardADR + ' ADR)</span>';
        if (p.pl_occ_30d) {
          var yourOcc = parseInt(p.pl_occ_30d);
          var mktOcc = p.pl_mkt_occ_30d ? parseInt(p.pl_mkt_occ_30d) : 0;
          revHtml += ' · <span style="color:' + (yourOcc >= mktOcc ? 'var(--accent)' : 'var(--danger)') + ';">' + yourOcc + '% occ</span>';
          if (mktOcc) revHtml += ' <span style="color:var(--text3);">(mkt ' + mktOcc + '%)</span>';
        }
        revHtml += ' → <strong style="color:var(--accent);">$' + plMonthlyRev.toLocaleString() + '/mo</strong>';
        revHtml += '</span></div>';

        // PriceLabs recommended vs current
        if (p.pl_rec_base && Math.abs(p.pl_rec_base - p.pl_base_price) > 2) {
          var recDiff = p.pl_rec_base - p.pl_base_price;
          var recRev = p.pl_occ_30d ? Math.round(p.pl_rec_base * 30 * parseInt(p.pl_occ_30d) / 100) : 0;
          var revDiff = recRev - plMonthlyRev;
          revHtml += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">';
          revHtml += '<span style="color:var(--text3);">💡 PL Recommended</span>';
          revHtml += '<span style="font-family:DM Mono,monospace;color:' + (recDiff > 0 ? 'var(--accent)' : '#f59e0b') + ';">$' + p.pl_rec_base + '/nt (' + (recDiff > 0 ? '+' : '') + '$' + recDiff + ')';
          if (recRev > 0) revHtml += ' → $' + recRev.toLocaleString() + '/mo (' + (revDiff > 0 ? '+' : '') + '$' + revDiff.toLocaleString() + ')';
          revHtml += '</span></div>';
        }
      }

      // Row 2: Analysis projection (if different from current)
      if (p.analysis_nightly_rate && p.analysis_nightly_rate > 0 && analysisMonthly > 0) {
        var analOcc = p.analysis_occ ? Math.round(p.analysis_occ * 100) : 0;
        var analDiff = analysisMonthly - monthlyRev;
        revHtml += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;' + (Math.abs(analDiff) > 100 ? 'padding-top:2px;border-top:1px dashed var(--border);' : '') + '">';
        revHtml += '<span style="color:var(--text3);">🤖 Analysis (' + esc(p.latest_strategy || 'Latest') + ')</span>';
        revHtml += '<span style="font-family:DM Mono,monospace;">$' + p.analysis_nightly_rate + '/nt';
        if (analOcc) revHtml += ' · ' + analOcc + '% occ';
        revHtml += ' → <strong style="color:' + (analDiff >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">$' + analysisMonthly.toLocaleString() + '/mo</strong>';
        if (monthlyRev > 0 && Math.abs(analDiff) > 50) {
          revHtml += ' <span style="color:' + (analDiff > 0 ? 'var(--accent)' : 'var(--danger)') + ';font-weight:700;">(' + (analDiff > 0 ? '+' : '') + '$' + analDiff.toLocaleString() + ')</span>';
        }
        revHtml += '</span></div>';
      }

      // Row 3: Expenses & Net
      if (monthlyCost > 0) {
        revHtml += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px;padding-top:3px;border-top:1px solid var(--border);">';
        revHtml += '<span style="color:var(--text3);">Expenses</span>';
        revHtml += '<span style="font-family:DM Mono,monospace;">';
        revHtml += '<span style="color:var(--danger);">-$' + Math.round(monthlyCost).toLocaleString() + '/mo</span>';
        revHtml += ' → <strong style="color:' + (net >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (net >= 0 ? '+' : '') + '$' + Math.round(net).toLocaleString() + ' net</strong>';
        revHtml += '</span></div>';
      }

      revHtml += '</div>';
    }
    // Simple financial line for properties without PL data
    else if (!p.is_research && (monthlyCost > 0 || monthlyRev > 0)) {
      revHtml += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;font-size:0.78rem;font-family:\'DM Mono\',monospace;">';
      if (monthlyRev > 0) revHtml += '<span style="color:var(--accent);font-weight:600;">↑ $' + Math.round(monthlyRev).toLocaleString() + '/mo</span>';
      if (monthlyCost > 0) revHtml += '<span style="color:var(--danger);">↓ $' + Math.round(monthlyCost).toLocaleString() + '/mo</span>';
      if (monthlyRev > 0 && monthlyCost > 0) {
        var netColor = net >= 0 ? 'var(--accent)' : 'var(--danger)';
        revHtml += '<span style="color:' + netColor + ';font-weight:700;">' + (net >= 0 ? '+' : '') + '$' + Math.round(net).toLocaleString() + ' net</span>';
      }
      revHtml += '</div>';
    }
    // Research property — show projected revenue and profitability
    else if (p.is_research) {
      var resRev = analysisMonthly || monthlyRev;
      var resCost = monthlyCost;
      var resNet = resRev - resCost;
      revHtml += '<div style="margin-top:6px;padding:8px 10px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.15);border-radius:6px;font-size:0.75rem;">';
      revHtml += '<div style="display:flex;justify-content:space-between;align-items:center;">';
      revHtml += '<span style="color:var(--purple);font-weight:600;">🔬 Research Projections</span>';
      if (resRev > 0) {
        revHtml += '<span style="font-family:DM Mono,monospace;">';
        if (p.analysis_nightly_rate) revHtml += '$' + p.analysis_nightly_rate + '/nt → ';
        revHtml += '<strong style="color:var(--accent);">$' + Math.round(resRev).toLocaleString() + '/mo</strong>';
        if (resCost > 0) revHtml += ' · <span style="color:' + (resNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';font-weight:700;">' + (resNet >= 0 ? '+' : '') + '$' + Math.round(resNet).toLocaleString() + ' net</span>';
        revHtml += '</span>';
      } else {
        revHtml += '<span style="color:var(--text3);">Run analysis to see projections</span>';
      }
      revHtml += '</div>';
      if (resRev > 0 && resCost > 0) {
        var verdict = resNet > 500 ? '✅ Looks profitable' : resNet > 0 ? '⚠️ Marginal' : '❌ Projected loss';
        revHtml += '<div style="margin-top:4px;font-size:0.72rem;color:' + (resNet > 500 ? 'var(--accent)' : resNet > 0 ? '#f59e0b' : 'var(--danger)') + ';font-weight:600;">' + verdict + ' · $' + (resNet * 12).toLocaleString() + '/yr</div>';
      }
      revHtml += '</div>';
    }

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
        trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">📈 +$' + Math.abs(Math.round(netDelta)).toLocaleString() + '</span>';
      } else if (profitable && declining) {
        trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">📉 -$' + Math.abs(Math.round(netDelta)).toLocaleString() + '</span>';
      } else if (profitable) {
        trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">✅ +$' + Math.round(t.latest_net).toLocaleString() + '/mo</span>';
      } else if (!profitable && improving) {
        trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">📈 -$' + Math.abs(Math.round(t.latest_net)).toLocaleString() + '/mo</span>';
      } else if (!profitable) {
        trendHtml = '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--danger);">❌ -$' + Math.abs(Math.round(t.latest_net)).toLocaleString() + '/mo</span>';
      }
    } else if (t && t.latest_net !== null && p.is_research) {
      if (t.latest_net >= 500) trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">✅ +$' + Math.round(t.latest_net).toLocaleString() + '/mo</span>';
      else if (t.latest_net >= 0) trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">⚠️ +$' + Math.round(t.latest_net).toLocaleString() + '/mo</span>';
      else trendHtml = '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--danger);">❌ -$' + Math.abs(Math.round(t.latest_net)).toLocaleString() + '/mo</span>';
    } else if (p.is_research && analysisMonthly > 0) {
      var resNet = analysisMonthly - monthlyCost;
      if (resNet >= 500) trendHtml = '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">✅ +$' + Math.round(resNet).toLocaleString() + '/mo</span>';
      else if (resNet >= 0) trendHtml = '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">⚠️ +$' + Math.round(resNet).toLocaleString() + '/mo</span>';
      else trendHtml = '<span class="badge" style="background:rgba(239,68,68,0.15);color:var(--danger);">❌ -$' + Math.abs(Math.round(resNet)).toLocaleString() + '/mo</span>';
    }

    return '<div class="property-card" style="position:relative;' + indent + buildingStyle + standaloneAccent + '">' +
      '<label class="prop-select" onclick="event.stopPropagation()" style="position:absolute;top:12px;left:12px;display:' + (bulkMode ? 'block' : 'none') + ';"><input type="checkbox" onchange="togglePropSelect(' + p.id + ')"' + checked + '></label>' +
      '<div style="margin-left:' + (bulkMode ? '28' : '0') + 'px;cursor:pointer;display:flex;gap:12px;align-items:center;flex:1;min-width:0;" onclick="openProperty(' + p.id + ')">' +
      thumb +
      '<div style="flex:1;min-width:0;"><h3>' + (isBuilding ? '🏢 ' : '') + esc(label) + ' ' + coordHtml + ' ' + unitBadge + '</h3><p>' + mapLink(p.address, p.city, p.state, p.zip) + (p.unit_number && !p.name ? '' : p.unit_number ? ' #' + esc(p.unit_number) : '') + ' · ' + esc(p.city) + ', ' + esc(p.state) + (p.zip ? ' ' + esc(p.zip) : '') + (p.zillow_url ? ' · <a href="' + esc(p.zillow_url) + '" target="_blank" onclick="event.stopPropagation();" style="color:var(--text3);font-size:0.72rem;text-decoration:none;" title="View on Zillow">🏠 Zillow</a>' : '') + '</p>' +
      '<div class="meta">' + typeBadge + ownerBadge +
      '<span>' + (p.bedrooms || 0) + 'BR / ' + (p.bathrooms || 0) + 'BA</span>' +
      (p.sqft ? '<span>' + p.sqft.toLocaleString() + ' sqft</span>' : '') +
      (p.estimated_value ? '<span>$' + p.estimated_value.toLocaleString() + '</span>' : '') +
      childBadge +
      (p.strategy_count > 0 ? '<span class="badge">' + p.strategy_count + ' strategies</span>' : '') +
      (p.last_analyzed ? '<span class="badge" style="background:rgba(96,165,250,0.12);color:rgba(96,165,250,0.9);font-size:0.62rem;" title="Last price analysis">🔍 ' + p.last_analyzed.substring(0, 10) + '</span>' : '<span class="badge" style="background:rgba(239,68,68,0.1);color:var(--danger);font-size:0.62rem;">⚠ Not analyzed</span>') +
      (p.listing_status === 'active' ? '<span class="badge" style="background:rgba(16,185,129,0.15);color:var(--accent);">● Live</span>' : p.listing_status === 'paused' ? '<span class="badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;">⏸ Paused</span>' : p.listing_status === 'inactive' ? '<span class="badge" style="background:rgba(239,68,68,0.12);color:var(--danger);">⏹ Inactive</span>' : '') +
      (p.rental_type === 'ltr' ? '<span class="badge" style="background:rgba(96,165,250,0.15);color:#60a5fa;">LTR</span>' : '<span class="badge" style="background:rgba(167,139,250,0.1);color:var(--purple);">STR</span>') +
      (p.is_research ? '<span class="badge" style="background:rgba(167,139,250,0.15);color:var(--purple);">🔬 Research</span>' : '') +
      trendHtml +
      '</div>' +
      revHtml +
      '</div></div>' +
      '<div style="position:absolute;top:10px;right:10px;display:flex;gap:4px;">' +
      '<button class="btn btn-xs" onclick="event.stopPropagation();openProperty(' + p.id + ')" title="Edit" style="padding:2px 8px;">✎</button>' +
      '<button class="btn btn-xs btn-danger" onclick="event.stopPropagation();deleteOneProp(' + p.id + ')" title="Delete" style="padding:2px 8px;">✕</button>' +
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

async function runPropertyPriceAnalysis() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save property first', 'error'); return; }
  var statusEl = document.getElementById('plStrategyStatus');
  var resultsEl = document.getElementById('plStrategyResults');
  // Show what AI provider will be used and estimated cost
  var providerNote = '';
  try {
    var keys = await api('/api/admin/api-keys');
    if (keys.ANTHROPIC_API_KEY) providerNote = '🤖 Using Anthropic Claude (~$0.08/call)';
    else if (keys.OPENAI_API_KEY) providerNote = '🤖 Using OpenAI GPT-4o (~$0.06/call)';
    else providerNote = '🤖 Using Workers AI (free, limited accuracy)';
  } catch {}
  if (statusEl) statusEl.innerHTML = '⏳ Running price analysis... ' + providerNote;
  try {
    var d = await api('/api/properties/' + editId + '/analyze', 'POST', { use_ai: true, analysis_type: 'str' });
    if (statusEl) statusEl.innerHTML = '';

    if (resultsEl) {
      var h = '';

      // Data sources used
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

      // Seasonality from analysis
      if (d.seasonality && d.seasonality.length >= 6) {
        var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        h += '<div style="padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;">';
        h += '<div style="font-size:0.72rem;font-weight:600;color:var(--purple);margin-bottom:6px;">SEASONAL RATE ADJUSTMENTS (from actual booking data)</div>';
        h += '<div style="display:flex;gap:2px;align-items:flex-end;height:60px;">';
        var maxM = Math.max.apply(null, d.seasonality.map(function(s) { return s.multiplier || 1; }));
        d.seasonality.forEach(function(s) {
          var pct = maxM > 0 ? Math.round((s.multiplier || 1) / maxM * 100) : 50;
          var clr = (s.multiplier || 1) >= 1.1 ? 'var(--accent)' : (s.multiplier || 1) <= 0.85 ? 'var(--danger)' : '#f59e0b';
          h += '<div style="flex:1;text-align:center;"><div style="background:' + clr + ';border-radius:3px 3px 0 0;height:' + Math.max(pct, 5) + '%;min-height:3px;opacity:0.7;" title="' + mNames[(s.month_number || 1) - 1] + ': ' + (s.multiplier || 1).toFixed(2) + 'x, $' + Math.round(s.avg_adr || 0) + '/nt, ' + Math.round((s.avg_occupancy || 0) * 100) + '% occ"></div>';
          h += '<div style="font-size:0.55rem;color:var(--text3);margin-top:2px;">' + mNames[(s.month_number || 1) - 1] + '</div>';
          h += '<div style="font-size:0.5rem;color:' + clr + ';">' + (s.multiplier || 1).toFixed(1) + 'x</div></div>';
        });
        h += '</div></div>';
      }

      // Strategies
      if (d.strategies && d.strategies.length > 0) {
        h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">PRICING STRATEGIES (' + d.strategies.length + ')</div>';
        d.strategies.forEach(function(s) {
          var isAI = s.ai_generated;
          var borderColor = isAI ? 'var(--purple)' : 'var(--accent)';
          h += '<div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-left:4px solid ' + borderColor + ';border-radius:8px;margin-bottom:8px;">';
          h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
          h += '<div><strong style="font-size:0.85rem;">' + esc(s.strategy_name || 'Strategy') + '</strong>';
          h += ' <span style="font-size:0.6rem;background:rgba(' + (isAI ? '167,139,250' : '16,185,129') + ',0.15);color:' + borderColor + ';padding:1px 6px;border-radius:3px;">' + (isAI ? '🤖 AI' : '📊 Algorithmic') + '</span></div>';
          h += '<span style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:var(--accent);">$' + Math.round(s.projected_monthly_avg || 0).toLocaleString() + '/mo</span>';
          h += '</div>';

          h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:8px;">';
          h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.base_nightly_rate || 0) + '</div><div style="font-size:0.58rem;color:var(--text3);">Base /nt</div></div>';
          if (s.weekend_rate) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + s.weekend_rate + '</div><div style="font-size:0.58rem;color:var(--text3);">Weekend /nt</div></div>';
          h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.cleaning_fee || 0) + '</div><div style="font-size:0.58rem;color:var(--text3);">Cleaning</div></div>';
          h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">' + Math.round((s.projected_occupancy || 0) * 100) + '%</div><div style="font-size:0.58rem;color:var(--text3);">Occupancy</div></div>';
          if (s.peak_season_markup) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;color:var(--accent);">+' + s.peak_season_markup + '%</div><div style="font-size:0.58rem;color:var(--text3);">Peak Season</div></div>';
          if (s.low_season_discount) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;color:var(--danger);">-' + s.low_season_discount + '%</div><div style="font-size:0.58rem;color:var(--text3);">Low Season</div></div>';
          h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + Math.round(s.projected_annual_revenue || 0).toLocaleString() + '</div><div style="font-size:0.58rem;color:var(--text3);">Annual Rev</div></div>';
          h += '</div>';

          if (s.reasoning) h += '<div style="font-size:0.72rem;color:var(--text3);line-height:1.4;">' + esc(s.reasoning).substring(0, 500) + '</div>';
          if (s.analysis) h += '<div style="font-size:0.72rem;color:var(--text2);margin-top:6px;padding-top:6px;border-top:1px solid var(--border);line-height:1.4;">' + esc(s.analysis).substring(0, 800) + '</div>';
          h += '</div>';
        });
      }

      resultsEl.innerHTML = h;
    }

    await loadProperties();
    renderRevenueSnapshot(editId);
    var lastRunEl = document.getElementById('pricingLastRun');
    if (lastRunEl) lastRunEl.innerHTML = 'Last analysis: <strong>' + new Date().toISOString().replace('T', ' ').substring(0, 16) + '</strong> · ' + (d.strategies || []).length + ' strategies generated';
    toast('Price analysis complete — ' + (d.strategies || []).length + ' strategies generated');
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger);">❌ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
}

async function loadSavedStrategies(propId) {
  var resultsEl = document.getElementById('plStrategyResults');
  var lastRunEl = document.getElementById('pricingLastRun');
  if (!resultsEl) return;
  if (resultsEl.innerHTML.length > 100) return;
  try {
    var d = await api('/api/properties/' + propId);
    var strats = d.strategies || [];
    if (strats.length === 0) {
      if (lastRunEl) lastRunEl.innerHTML = '\u26a0\ufe0f No analysis run yet \u2014 click \ud83d\udd0d Run Price Analysis';
      return;
    }
    var runs = {};
    strats.forEach(function(s) {
      var runKey = (s.created_at || '').substring(0, 16);
      if (!runs[runKey]) runs[runKey] = [];
      runs[runKey].push(s);
    });
    var runKeys = Object.keys(runs).sort().reverse();
    if (lastRunEl && runKeys.length > 0) {
      var dt = runKeys[0].replace('T', ' ');
      var ago = Math.round((Date.now() - new Date(runKeys[0]).getTime()) / 86400000);
      var agoText = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : ago + ' days ago';
      lastRunEl.innerHTML = 'Last analysis: <strong>' + dt + '</strong> (' + agoText + ') \u00b7 ' + runKeys.length + ' runs saved';
    }
    var h = '';
    var latestStrats = runs[runKeys[0]] || [];
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:8px;">LATEST ANALYSIS \u2014 ' + runKeys[0].replace('T', ' ') + '</div>';
    latestStrats.forEach(function(s) { h += renderStrategyCard(s); });
    if (runKeys.length > 1) {
      var historyRuns = runKeys.slice(1, 5);
      h += '<details style="margin-top:14px;"><summary style="cursor:pointer;font-size:0.78rem;font-weight:600;color:var(--text2);padding:6px 0;">\ud83d\udcdc Previous Analyses (' + historyRuns.length + ' older)</summary>';
      historyRuns.forEach(function(rk) {
        var rStrats = runs[rk] || [];
        h += '<div style="margin-top:10px;padding:10px;background:var(--bg);border:1px solid var(--border);border-radius:8px;opacity:0.8;">';
        h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:6px;">' + rk.replace('T', ' ') + ' \u00b7 ' + rStrats.length + ' strategies</div>';
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
  var provLabel = ({anthropic:'Claude',openai:'GPT-4o',workers_ai:'Workers AI'})[s.ai_provider] || (isAI ? 'AI' : 'Algo');
  var h = '<div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-left:4px solid ' + bc + ';border-radius:8px;margin-bottom:8px;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
  h += '<div><strong style="font-size:0.85rem;">' + esc(s.strategy_name || 'Strategy') + '</strong>';
  h += ' <span style="font-size:0.6rem;background:rgba(' + (isAI ? '167,139,250' : '16,185,129') + ',0.15);color:' + bc + ';padding:1px 6px;border-radius:3px;">' + (isAI ? '🤖 ' : '📊 ') + esc(provLabel) + '</span>';
  if (isLTR) h += ' <span style="font-size:0.6rem;background:rgba(59,130,246,0.15);color:#60a5fa;padding:1px 6px;border-radius:3px;">LTR</span>';
  h += '</div>';
  h += '<span style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:var(--accent);">$' + Math.round(s.projected_monthly_avg || 0).toLocaleString() + '/mo</span>';
  h += '</div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;margin-bottom:8px;">';
  if (isLTR) {
    h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.base_nightly_rate || 0).toLocaleString() + '</div><div style="font-size:0.55rem;color:var(--text3);">Monthly Rent</div></div>';
  } else {
    h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.base_nightly_rate || 0) + '</div><div style="font-size:0.55rem;color:var(--text3);">Base /nt</div></div>';
    if (s.weekend_rate) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + s.weekend_rate + '</div><div style="font-size:0.55rem;color:var(--text3);">Weekend</div></div>';
    h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.cleaning_fee || 0) + '</div><div style="font-size:0.55rem;color:var(--text3);">Cleaning</div></div>';
  }
  h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">' + Math.round((s.projected_occupancy || 0) * 100) + '%</div><div style="font-size:0.55rem;color:var(--text3);">Occupancy</div></div>';
  if (s.peak_season_markup) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;color:var(--accent);">+' + s.peak_season_markup + '%</div><div style="font-size:0.55rem;color:var(--text3);">Peak</div></div>';
  if (s.low_season_discount) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;color:var(--danger);">-' + s.low_season_discount + '%</div><div style="font-size:0.55rem;color:var(--text3);">Low</div></div>';
  h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + Math.round(s.projected_annual_revenue || 0).toLocaleString() + '</div><div style="font-size:0.55rem;color:var(--text3);">Annual</div></div>';
  h += '</div>';
  // Full analysis text — show all of it, expandable if long
  var fullText = s.analysis || s.reasoning || '';
  if (fullText) {
    if (fullReasoning || fullText.length <= 600) {
      h += '<div style="font-size:0.78rem;color:var(--text2);line-height:1.5;margin-top:6px;">';
      fullText.split(/\n\n|\n/).forEach(function(para) { if (para.trim()) h += '<p style="margin:0 0 6px 0;">' + esc(para.trim()) + '</p>'; });
      h += '</div>';
    } else {
      var uid = 'sc_' + Math.random().toString(36).substring(2,8);
      h += '<div style="font-size:0.78rem;color:var(--text2);line-height:1.5;margin-top:6px;">';
      h += '<span id="' + uid + 's">' + esc(fullText.substring(0, 500)) + '... ';
      h += '<a href="#" onclick="event.preventDefault();document.getElementById(\'' + uid + 'f\').style.display=\'\';document.getElementById(\'' + uid + 's\').style.display=\'none\';" style="color:var(--purple);">Show full analysis ↓</a></span>';
      h += '<span id="' + uid + 'f" style="display:none;">';
      fullText.split(/\n\n|\n/).forEach(function(para) { if (para.trim()) h += '<p style="margin:0 0 6px 0;">' + esc(para.trim()) + '</p>'; });
      h += '</span></div>';
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
    if (a.month >= currentMonth) return; // exclude partial current month
    var mn = parseInt(a.month.substring(5));
    var yr = parseInt(a.month.substring(0, 4));
    if (!histByMonth[mn]) histByMonth[mn] = { revs: [], occs: [], adrs: [] };
    histByMonth[mn].revs.push(a.total_revenue || 0);
    histByMonth[mn].occs.push(a.occupancy_pct || 0);
    if (a.avg_nightly_rate > 0) histByMonth[mn].adrs.push(a.avg_nightly_rate);
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
  if (zInfo) zInfo.textContent = '⏳ Searching Zillow...';
  try {
    var d = await api('/api/properties/' + editId + '/zestimate', 'POST');
    if (d.zestimate) {
      document.getElementById('f_value').value = d.zestimate;
      var zLink = d.zillow_url ? ' · <a href="' + esc(d.zillow_url) + '" target="_blank" style="color:var(--accent);">View on Zillow ↗</a>' : '';
      if (zInfo) zInfo.innerHTML = '✅ Zestimate: <strong>$' + d.zestimate.toLocaleString() + '</strong> from ' + esc(d.source) + ' (' + d.date + ')' + (d.previous_value ? ' · was $' + d.previous_value.toLocaleString() : '') + zLink;
      toast('Zestimate: $' + d.zestimate.toLocaleString());
    } else {
      if (zInfo) zInfo.textContent = '❌ Could not find Zestimate';
      toast('No Zestimate found', 'error');
    }
  } catch (err) {
    if (zInfo) zInfo.textContent = '❌ ' + err.message;
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
  var catIcons = {closing:'📋',renovation:'🔨',repair:'🔧',furniture:'🛋️',appliance:'⚡',legal:'📜',other:'📌'};
  var catColors = {closing:'96,165,250',renovation:'167,139,250',repair:'245,158,11',furniture:'16,185,129',appliance:'59,130,246',legal:'148,163,184',other:'107,114,128'};
  var total = 0;
  var h = '';
  propExpenses.forEach(function(e) {
    total += e.amount || 0;
    var icon = catIcons[e.category] || '📌';
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
  h += '<h3 style="margin:0;">📋 Copy from ' + esc(data.source.name) + '</h3>';
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
      var overwrite = f.would_overwrite ? ' <span style="font-size:0.65rem;color:#f59e0b;">⚠ overwrites: ' + (f.is_money ? '$' + Number(f.target_value).toLocaleString() : f.target_value) + '</span>' : '';
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
      h += '<button class="btn btn-xs" onclick="navigator.clipboard.writeText(\'' + esc(s.share_code) + '\');toast(\'Code copied!\')" style="white-space:nowrap;">📋 Copy Code</button>';
      h += '</div>';
      // Instructions
      h += '<div style="font-size:0.72rem;color:var(--text3);padding:6px 10px;background:var(--surface2);border-radius:6px;margin-bottom:8px;">';
      h += '💡 Share this code — the viewer enters it at <strong>' + window.location.origin + '/share</strong> to view. The code is not in the URL for privacy.';
      h += '</div>';
      // Actions
      h += '<div style="display:flex;gap:6px;">';
      h += '<a href="/share/' + esc(s.share_code) + '" target="_blank" class="btn btn-xs" style="text-decoration:none;">👁 Preview</a>';
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

async function doBulkEdit() {
  if (selectedProps.size === 0) { toast('No properties selected', 'error'); return; }
  var field = document.getElementById('bulkField').value;
  var value = document.getElementById('bulkValue').value.trim();
  if (!field) { toast('Select a field to edit', 'error'); return; }
  if (value === '') { toast('Enter a value', 'error'); return; }
  var numFields = ['bedrooms', 'bathrooms'];
  var updates = {};
  updates[field] = numFields.indexOf(field) >= 0 ? parseFloat(value) : value;
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
  ['f_name','f_address','f_city','f_state','f_zip','f_beds','f_baths','f_sqft','f_lot','f_year','f_price','f_value','f_taxes','f_hoa','f_image','f_unit','f_mortgage','f_insurance','f_monthly_rent','f_deposit','f_electric','f_gas','f_water','f_internet','f_trash','f_other_expense','f_cleaning','f_cleaning_cost','f_stories','f_lat','f_lng','f_parking','f_parcel','f_zoning','f_county'].forEach(function(id) { var el = document.getElementById(id); if (el) el.value = ''; });
  sv('f_type', 'single_family');
  setOwnership('purchased');
  toggleUnitField();
  updateImagePreview();
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
  var amenitiesTab = document.querySelector('#propSubTabs [data-ptab="amenities"]'); if (amenitiesTab) amenitiesTab.style.display = '';
  var histEl = document.getElementById('propHistoryContent'); if (histEl) histEl.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save the property first, then run an analysis to see history here.</p>';
  var amenEl = document.getElementById('propAmenitiesContent'); if (amenEl) amenEl.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save the property first to manage amenities.</p>';
  var unitsEl = document.getElementById('unitsList'); if (unitsEl) unitsEl.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">Save as Multi-Family first, then add units.</p>';
  var sumEl = document.getElementById('unitsSummary'); if (sumEl) sumEl.innerHTML = '';
  switchPropTab('details');
  switchView('addProperty');
}

async function openProperty(id) {
  showLoading('Loading...');
  try {
    var d = await api('/api/properties/' + id); var p = d.property;
    window._propMonthlyActuals = d.monthly_actuals || [];
    window._propSeasonality = d.seasonality || [];
    var sv = function(elId, val) { var el = document.getElementById(elId); if (el) el.value = val || ''; };
    var st = function(elId, val) { var el = document.getElementById(elId); if (el) el.textContent = val || ''; };
    sv('f_editId', p.id);
    st('formTitle', p.parent_id ? 'Edit Unit' : 'Edit Property');
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
    sv('f_hoa', p.hoa_monthly);
    sv('f_image', p.image_url);
    sv('f_unit', p.unit_number);
    sv('f_mortgage', p.monthly_mortgage);
    sv('f_insurance', p.monthly_insurance);
    sv('f_purchase_date', p.purchase_date);
    // Populate mortgage calc with saved loan details
    if (p.down_payment_pct) sv('mc_down_pct', p.down_payment_pct);
    if (p.interest_rate) sv('mc_rate', p.interest_rate);
    if (p.loan_term_years) sv('mc_term', p.loan_term_years);
    // Show zestimate info
    var zInfo = document.getElementById('zestimateInfo');
    if (zInfo && p.zestimate) {
      var zLink2 = p.zillow_url ? ' · <a href="' + esc(p.zillow_url) + '" target="_blank" style="color:var(--accent);">View on Zillow ↗</a>' : '';
      zInfo.innerHTML = 'Zestimate: $' + p.zestimate.toLocaleString() + (p.zestimate_date ? ' (' + p.zestimate_date + ')' : '') + zLink2;
    }
    // Initialize mortgage calculator from existing data
    var mcBody = document.getElementById('mortCalcBody');
    if (mcBody) mcBody.style.display = 'none';
    var mcArrow = document.getElementById('mortCalcArrow');
    if (mcArrow) mcArrow.textContent = '▸';
    // If we have a purchase price, pre-fill the calculator
    if (p.purchase_price > 0 && p.monthly_mortgage > 0) {
      // Keep auto-apply OFF when loading existing data (so we don't overwrite)
      var autoEl = document.getElementById('mc_auto_apply');
      if (autoEl) autoEl.checked = false;
      calcMortgage();
      if (autoEl) autoEl.checked = true;
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
    var resEl = document.getElementById('f_research');
    if (resEl) resEl.checked = !!p.is_research;
    setOwnership(p.ownership_type || 'purchased');
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
        var propCost = 0;
        if (p.ownership_type === 'rental') {
          propCost = p.monthly_rent_cost || 0;
        } else {
          propCost = (p.monthly_mortgage || 0) + (p.monthly_insurance || 0) + Math.round((p.annual_taxes || 0) / 12) + (p.hoa_monthly || 0);
        }
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
          // Cost breakdown
          if (propTotalCost > 0) {
            ph += '<div style="font-size:0.78rem;color:var(--text2);">';
            if (propCost > 0) {
              if (p.ownership_type === 'rental') {
                ph += '<span>Rent: $' + (p.monthly_rent_cost || 0).toLocaleString() + '</span>';
              } else {
                var parts = [];
                if (p.monthly_mortgage) parts.push('Mortgage $' + p.monthly_mortgage.toLocaleString());
                if (p.monthly_insurance) parts.push('Ins $' + p.monthly_insurance.toLocaleString());
                if (p.annual_taxes) parts.push('Tax $' + Math.round(p.annual_taxes / 12).toLocaleString());
                if (p.hoa_monthly) parts.push('HOA $' + p.hoa_monthly.toLocaleString());
                ph += '<span>' + parts.join(' · ') + '</span>';
              }
            }
            if (propUtil > 0) ph += (propCost > 0 ? ' · ' : '') + '<span>Utils $' + Math.round(propUtil).toLocaleString() + '</span>';
            ph += '</div>';
          }
          // Annual
          if (propRev > 0) {
            var annNet = propNet * 12;
            var cap = (p.estimated_value || p.purchase_price) ? Math.round(annNet / (p.estimated_value || p.purchase_price) * 10000) / 100 : 0;
            ph += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:0.78rem;color:var(--text2);">';
            ph += '<span>$' + Math.round(propRev * 12).toLocaleString() + '/yr rev</span>';
            if (propTotalCost > 0) ph += '<span style="font-weight:600;color:' + (annNet >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">$' + Math.round(annNet).toLocaleString() + '/yr net</span>';
            if (cap) ph += '<span>Cap: ' + cap + '%</span>';
            ph += '</div>';
          }
          ph += '</div>';
          buildingSumEl.innerHTML = ph;
          buildingSumEl.style.display = '';
        } else {
          buildingSumEl.style.display = 'none';
          buildingSumEl.innerHTML = '';
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
        coordStr = '📍 ' + p.latitude.toFixed(6) + ', ' + p.longitude.toFixed(6) + ' <a href="https://maps.google.com/?q=' + p.latitude + ',' + p.longitude + '" target="_blank" style="font-size:0.72rem;">Open Map →</a>';
      } else {
        coordStr = '📍 No coordinates — enter manually below or run Lookup';
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
          var aiTag = latest.ai_generated ? '<span style="color:var(--purple);font-size:0.72rem;">✦ AI</span> ' : '';
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
        plh += '<label style="font-size:0.78rem;color:var(--purple);font-weight:600;">📊 PRICELABS — LINKED</label>';
        var syncInfo = [];
        if (pl.last_synced) syncInfo.push('Synced: ' + pl.last_synced.substring(0, 16).replace('T', ' '));
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
            var icon = ch.channel_name === 'airbnb' ? '🏠' : ch.channel_name === 'bookingcom' ? '📘' : '📋';
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
        plh += '<label style="font-size:0.78rem;color:var(--purple);font-weight:600;">📊 PRICELABS</label>';
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
        plh += '<span style="font-size:0.78rem;color:var(--text3);">📊 PriceLabs listings available — link one in the PriceLabs tab to see dynamic pricing data here.</span>';
        plh += '</div>';
        window._plPropertyData = null;
      } else {
        plh = '';
        window._plPropertyData = null;
      }
      plEl.innerHTML = plh;
      plEl.style.display = plh ? '' : 'none';
    }

    switchPropTab('details');
    switchView('addProperty');
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

function switchPropTab(tab) {
  ['details','amenities','history','units','platforms','pricing','finance'].forEach(function(t) {
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
    }
    var acqBtn = document.getElementById('genAcqBtn');
    if (acqBtn) {
      var resEl = document.getElementById('f_research');
      acqBtn.style.display = (resEl && resEl.checked) ? '' : 'none';
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
      var date = (s.created_at || '').substring(0, 16).replace('T', ' ');
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
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning...'; }
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
  if (btn) { btn.disabled = false; btn.textContent = '🔍 Auto-Detect Amenities'; }
}

function renderPropertyAmenities(currentAmenities, propertyId) {
  var el = document.getElementById('propAmenitiesContent');
  if (!el) return;
  propAmenitySet = new Set(currentAmenities.map(function(a) { return a.id; }));
  var h = '<div style="margin-bottom:14px;">';
  h += '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:8px;">SELECTED: ' + propAmenitySet.size + ' amenities</label>';
  h += '<div class="chip-container">';
  amenities.forEach(function(a) {
    var sel = propAmenitySet.has(a.id) ? ' selected' : '';
    h += '<div class="chip' + sel + '" onclick="togglePropAmenity(' + a.id + ',' + propertyId + ')">' + esc(a.name) + '<span class="score">+' + a.impact_score + '%</span></div>';
  });
  h += '</div></div>';
  var totalBoost = 0;
  propAmenitySet.forEach(function(id) {
    var am = amenities.find(function(a) { return a.id === id; });
    if (am) totalBoost += am.impact_score;
  });
  h += '<div style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
  h += '<span style="font-size:0.85rem;">Total Price Impact</span>';
  h += '<span style="color:var(--accent);font-weight:700;font-size:1.1em;">+' + totalBoost + '%</span>';
  h += '</div>';
  if (propAmenitySet.size > 0) {
    h += '<div style="margin-top:6px;font-size:0.78rem;color:var(--text3);">';
    var selectedNames = [];
    propAmenitySet.forEach(function(id) { var am = amenities.find(function(a) { return a.id === id; }); if (am) selectedNames.push(am.name); });
    h += selectedNames.join(', ');
    h += '</div>';
  }
  h += '</div>';
  h += '<button class="btn btn-primary btn-sm" onclick="savePropAmenities(' + propertyId + ')">Save Amenities</button>';
  h += ' <span id="propAmenSaveStatus" style="font-size:0.78rem;color:var(--accent);"></span>';
  el.innerHTML = h;
}

function togglePropAmenity(amenityId, propertyId) {
  if (propAmenitySet.has(amenityId)) propAmenitySet.delete(amenityId);
  else propAmenitySet.add(amenityId);
  var currentList = [];
  propAmenitySet.forEach(function(id) { var am = amenities.find(function(a) { return a.id === id; }); if (am) currentList.push(am); });
  renderPropertyAmenities(currentList, propertyId);
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
    var thumb = c.image_url ? '<img src="' + esc(c.image_url) + '" style="width:64px;height:64px;object-fit:cover;border-radius:6px;flex-shrink:0;" onerror="this.style.display=\'none\'">' : '<div style="width:64px;height:64px;background:var(--bg);border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:1.2rem;color:var(--text3);">🏠</div>';
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
    annual_taxes: parseFloat(gv('f_taxes')) || null, hoa_monthly: parseFloat(gv('f_hoa')) || 0,
    image_url: gv('f_image').trim() || null, unit_number: gv('f_unit') || null,
    ownership_type: currentOwnership,
    monthly_mortgage: parseFloat(gv('f_mortgage')) || 0,
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
    down_payment_pct: parseFloat(gv('mc_down_pct')) || null,
    interest_rate: parseFloat(gv('mc_rate')) || null,
    loan_term_years: parseInt(gv('mc_term')) || null,
    loan_amount: parseFloat(gv('mc_loan')) || null,
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
  var url = (document.getElementById('f_image') || {}).value || '';
  var area = document.getElementById('imagePreviewArea');
  var img = document.getElementById('imagePreview');
  if (url && area && img) { img.src = url; area.style.display = 'block'; img.onerror = function() { area.style.display = 'none'; }; }
  else if (area) { area.style.display = 'none'; }
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

async function handleImageUpload(input) {
  var file = input.files[0];
  if (!file) return;
  var statusEl = document.getElementById('uploadStatus');
  if (file.size > 2 * 1024 * 1024) { if (statusEl) statusEl.textContent = 'File too large (max 2MB)'; toast('File too large', 'error'); return; }
  if (statusEl) statusEl.textContent = 'Uploading...';
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
    document.getElementById('f_image').value = data.url;
    updateImagePreview();
    if (statusEl) statusEl.textContent = 'Uploaded: ' + file.name;
    toast('Image uploaded');
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    toast(err.message, 'error');
  }
  input.value = '';
}

function setOwnership(type) {
  currentOwnership = type;
  document.querySelectorAll('.ownership-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.own === type); });
  var fp = document.getElementById('financePurchased');
  var fr = document.getElementById('financeRental');
  if (fp) fp.style.display = type === 'purchased' ? '' : 'none';
  if (fr) fr.style.display = type === 'rental' ? '' : 'none';
  updateCostSummary();
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
  } else {
    var rent = gv('f_monthly_rent'); if (rent) { items.push('Rent $' + rent.toLocaleString()); fixed += rent; }
  }
  var util = gv('f_electric') + gv('f_gas') + gv('f_water') + gv('f_internet') + gv('f_trash') + gv('f_other_expense');
  if (util) items.push('Utilities $' + util.toLocaleString());
  // Service subscriptions (dynamic)
  var svcCost = getServicesCost();
  if (svcCost > 0) items.push('Services $' + Math.round(svcCost));
  var total = fixed + util + svcCost;
  if (total > 0) {
    var h = '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:center;">';
    h += '<div style="font-size:0.82rem;color:var(--text3);">' + items.join(' + ') + '</div>';
    h += '<div style="font-weight:600;color:var(--accent);font-size:1.05em;">$' + total.toLocaleString() + '/mo total cost</div></div>';
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
var propDialogAiProvider = null; // null = use global aiProvider

async function showPropAnalysisDialog() {
  var editId = (document.getElementById('f_editId') || {}).value;
  if (!editId) { toast('Save property first', 'error'); return; }

  // Sync to current global AI state
  propDialogAiEnabled = aiEnabled;
  propDialogAiProvider = aiProvider;
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
    o.classList.toggle('selected', o.dataset.provider === propDialogAiProvider);
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

function setPropDialogProvider(provider) {
  propDialogAiProvider = provider;
  document.querySelectorAll('#propDialogAiOptions .ai-option').forEach(function(o) {
    o.classList.toggle('selected', o.dataset.provider === provider);
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
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running...'; }
  if (statusEl) statusEl.textContent = 'Fetching market data and running analysis...';

  try {
    var d = await api('/api/properties/' + editId + '/analyze', 'POST', {
      use_ai: propDialogAiEnabled,
      ai_provider: propDialogAiProvider || aiProvider,
      analysis_type: propDialogAnalysisType
    });

    closePropAnalysisDialog();

    var resultsEl = document.getElementById('plStrategyResults');
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
        h += '🤖 AI by: <strong>' + Array.from(usedProviders).map(function(p) { return provLabels[p] || p; }).join(', ') + '</strong>';
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
          h += '<div style="font-size:0.55rem;color:var(--text3);margin-top:2px;">' + mNames[(s.month_number || 1) - 1] + '</div>';
          h += '<div style="font-size:0.5rem;color:' + clr + ';">' + (s.multiplier || 1).toFixed(1) + 'x</div></div>';
        });
        h += '</div></div>';
      }

      // Strategies
      if (d.strategies && d.strategies.length > 0) {
        h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">PRICING STRATEGIES (' + d.strategies.length + ')</div>';
        d.strategies.forEach(function(s) {
          var isAI = s.ai_generated;
          var isLTR = s.min_nights >= 365 || (s.strategy_name || '').includes('LTR');
          var borderColor = isAI ? 'var(--purple)' : 'var(--accent)';
          var provLabel = { anthropic: 'Claude', openai: 'GPT-4o', workers_ai: 'Workers AI' }[s.ai_provider] || s.ai_provider || '';
          h += '<div style="padding:12px;background:var(--bg);border:1px solid var(--border);border-left:4px solid ' + borderColor + ';border-radius:8px;margin-bottom:8px;">';
          h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
          h += '<div><strong style="font-size:0.85rem;">' + esc(s.strategy_name || 'Strategy') + '</strong>';
          if (isAI) h += ' <span style="font-size:0.6rem;background:rgba(167,139,250,0.15);color:var(--purple);padding:1px 6px;border-radius:3px;">🤖 ' + esc(provLabel) + '</span>';
          else h += ' <span style="font-size:0.6rem;background:rgba(16,185,129,0.15);color:var(--accent);padding:1px 6px;border-radius:3px;">📊 Algorithmic</span>';
          if (isLTR) h += ' <span style="font-size:0.6rem;background:rgba(59,130,246,0.15);color:var(--blue);padding:1px 6px;border-radius:3px;">LTR</span>';
          h += '</div>';
          h += '<span style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:var(--accent);">$' + Math.round(s.projected_monthly_avg || 0).toLocaleString() + '/mo</span>';
          h += '</div>';
          h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:8px;">';
          if (isLTR) {
            h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.base_nightly_rate || 0).toLocaleString() + '</div><div style="font-size:0.58rem;color:var(--text3);">Monthly Rent</div></div>';
          } else {
            h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.base_nightly_rate || 0) + '</div><div style="font-size:0.58rem;color:var(--text3);">Base /nt</div></div>';
            if (s.weekend_rate) h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + s.weekend_rate + '</div><div style="font-size:0.58rem;color:var(--text3);">Weekend /nt</div></div>';
            h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + (s.cleaning_fee || 0) + '</div><div style="font-size:0.58rem;color:var(--text3);">Cleaning</div></div>';
          }
          h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">' + Math.round((s.projected_occupancy || 0) * 100) + '%</div><div style="font-size:0.58rem;color:var(--text3);">Occupancy</div></div>';
          h += '<div style="text-align:center;padding:4px;background:var(--surface2);border-radius:4px;"><div style="font-family:DM Mono,monospace;font-weight:700;">$' + Math.round(s.projected_annual_revenue || 0).toLocaleString() + '</div><div style="font-size:0.58rem;color:var(--text3);">Annual Rev</div></div>';
          h += '</div>';
          if (s.reasoning) h += '<div style="font-size:0.72rem;color:var(--text3);line-height:1.4;">' + esc(s.reasoning).substring(0, 500) + '</div>';
          if (s.analysis) h += '<div style="font-size:0.72rem;color:var(--text2);margin-top:6px;padding-top:6px;border-top:1px solid var(--border);line-height:1.4;">' + esc(s.analysis).substring(0, 800) + '</div>';
          h += '</div>';
        });
      }

      resultsEl.innerHTML = h;
    }

    await loadProperties();
    renderRevenueSnapshot(editId);
    var lastRunEl = document.getElementById('pricingLastRun');
    if (lastRunEl) lastRunEl.innerHTML = 'Last analysis: <strong>' + new Date().toISOString().replace('T', ' ').substring(0, 16) + '</strong> · ' + (d.strategies || []).length + ' strategies · ' + propDialogAnalysisType.toUpperCase();
    toast('Price analysis complete — ' + (d.strategies || []).length + ' strategies generated');
  } catch (err) {
    if (statusEl) statusEl.textContent = '❌ ' + err.message;
    if (btn) { btn.disabled = false; btn.textContent = 'Run Analysis'; }
    toast(err.message, 'error');
    return;
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Run Analysis'; }
}
