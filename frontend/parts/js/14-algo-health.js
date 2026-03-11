// Algorithm Health Dashboard
// Compares projected revenue/occupancy/ADR/seasonality against Guesty actuals
// Lives in the PMS tab — actuals are the source of truth here

var algoHealthData = null;

async function loadAlgoHealth() {
  var el = document.getElementById('algoHealthContent');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;padding:10px;">Computing accuracy scores...</div>';

  try {
    // Fetch: actuals, properties, seasonality, templates, overrides
    var [actualsResp, finResp, tplResp] = await Promise.all([
      api('/api/guesty/actuals'),
      api('/api/finances/summary'),
      api('/api/algo-templates'),
    ]);

    var actuals = actualsResp.actuals || [];
    var props = (finResp.properties || []);
    var maData = finResp.monthly_actuals || {};
    var seasonality = (maData.seasonality || finResp.seasonality || []);
    var templates = tplResp.templates || [];

    if (actuals.length === 0) {
      el.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;padding:10px;">No Guesty actuals yet. Import and process reservation data first.</div>';
      return;
    }

    // Build template lookup
    var tplMap = {};
    templates.forEach(function(t) { tplMap[t.id] = t; });

    algoHealthData = computeAlgoHealth(actuals, props, seasonality, tplMap);
    renderAlgoHealth(algoHealthData);
  } catch (err) {
    el.innerHTML = '<div style="color:var(--danger);font-size:0.82rem;padding:10px;">Error: ' + esc(err.message) + '</div>';
  }
}

function computeAlgoHealth(actuals, props, seasonality, tplMap) {
  // Build lookups
  var propMap = {};
  props.forEach(function(p) { propMap[p.id] = p; });

  // Seasonality lookup: city_state_monthNum → multiplier
  var seasonMap = {};
  seasonality.forEach(function(s) {
    var key = (s.city || '').toLowerCase() + '_' + (s.state || '').toLowerCase() + '_' + s.month_number;
    seasonMap[key] = s.multiplier || 1.0;
  });

  // Group actuals by property
  var byProp = {};
  actuals.forEach(function(a) {
    var pk = a.property_id;
    if (!byProp[pk]) byProp[pk] = {
      id: pk,
      name: (a.unit_number ? a.unit_number + ' — ' : '') + (a.prop_name || a.prop_address || 'Property ' + pk),
      city: a.city, state: a.state,
      months: []
    };
    byProp[pk].months.push(a);
  });

  // Helper: resolve effective settings for a property (template → defaults)
  function getEffectiveSettings(prop) {
    var tpl = (prop.algo_template_id && tplMap) ? tplMap[prop.algo_template_id] : null;
    var occTarget = (tpl && tpl.occupancy_target) ? tpl.occupancy_target / 100 : 0.65;
    var pricingBias = (tpl && tpl.pricing_bias) ? tpl.pricing_bias : 'balanced';
    var seasonalProfile = (tpl && tpl.seasonal_profile) ? tpl.seasonal_profile : 'standard';
    var peakMonths = [];
    var lowMonths = [];
    var peakMarkup = 0.20;
    var lowDiscount = 0.15;

    if (tpl) {
      if (tpl.peak_months) peakMonths = tpl.peak_months.split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return n > 0 && n <= 12; });
      if (tpl.low_months) lowMonths = tpl.low_months.split(',').map(function(s) { return parseInt(s.trim()); }).filter(function(n) { return n > 0 && n <= 12; });
      if (tpl.peak_markup_pct) peakMarkup = tpl.peak_markup_pct / 100;
      if (tpl.low_discount_pct) lowDiscount = tpl.low_discount_pct / 100;
    }

    // Standard seasonal defaults if no template
    if (peakMonths.length === 0 && (seasonalProfile === 'standard' || !tpl)) peakMonths = [6, 7, 8, 12];
    if (lowMonths.length === 0 && (seasonalProfile === 'standard' || !tpl)) lowMonths = [1, 2, 3];
    if (seasonalProfile === 'winter') { peakMonths = [11, 12, 1, 2]; lowMonths = [5, 6, 7, 8]; }
    if (seasonalProfile === 'flat') { peakMonths = []; lowMonths = []; peakMarkup = 0; lowDiscount = 0; }

    return {
      occTarget: occTarget,
      pricingBias: pricingBias,
      seasonalProfile: seasonalProfile,
      peakMonths: peakMonths,
      lowMonths: lowMonths,
      peakMarkup: peakMarkup,
      lowDiscount: lowDiscount,
      templateName: tpl ? tpl.name : null,
      templateId: tpl ? tpl.id : null,
      minRate: tpl ? tpl.min_nightly_rate : null,
      maxRate: tpl ? tpl.max_nightly_rate : null,
    };
  }

  var results = [];

  Object.values(byProp).forEach(function(pg) {
    var prop = propMap[pg.id];
    if (!prop) return;

    var plMonthly = prop.monthly_revenue || 0; // PriceLabs / user projection
    if (plMonthly === 0) return; // Can't compare without a projection

    var settings = getEffectiveSettings(prop);
    var revErrors = [], occErrors = [], adrErrors = [], seasonErrors = [];

    // Compute monthly avg for normalization
    var monthlyRevs = pg.months.map(function(m) { return m.total_revenue || 0; });
    var propAvgRev = monthlyRevs.length > 0 ? monthlyRevs.reduce(function(a,b){return a+b;},0) / monthlyRevs.length : 0;

    pg.months.forEach(function(m) {
      var mn = parseInt((m.month || '').substring(5));
      var seasonKey = (pg.city || '').toLowerCase() + '_' + (pg.state || '').toLowerCase() + '_' + mn;

      // Seasonality multiplier: try table first, then template settings, then 1.0
      var seasonMult = seasonMap[seasonKey];
      if (seasonMult === undefined) {
        // Use template seasonal settings
        if (settings.peakMonths.indexOf(mn) >= 0) seasonMult = 1 + settings.peakMarkup;
        else if (settings.lowMonths.indexOf(mn) >= 0) seasonMult = 1 - settings.lowDiscount;
        else seasonMult = 1.0;
      }

      // Projected revenue: PriceLabs monthly × seasonality multiplier
      var projRev = plMonthly * seasonMult;
      var actualRev = m.total_revenue || 0;

      // Revenue accuracy
      if (projRev > 0) {
        revErrors.push((actualRev - projRev) / projRev);
      }

      // Occupancy: use template target instead of hardcoded 65%
      var actualOcc = m.occupancy_pct || 0;
      var projOcc = settings.occTarget;
      occErrors.push(actualOcc - projOcc);

      // ADR accuracy: projected ADR = monthly / (30 × occupancy target)
      var projAdr = plMonthly / (30 * settings.occTarget);
      var actualAdr = m.avg_nightly_rate || 0;
      if (projAdr > 0 && actualAdr > 0) {
        adrErrors.push((actualAdr - projAdr) / projAdr);
      }

      // Seasonality fit
      if (propAvgRev > 0 && actualRev > 0) {
        var actualMult = actualRev / propAvgRev;
        seasonErrors.push(actualMult - seasonMult);
      }
    });

    function avg(arr) { return arr.length > 0 ? arr.reduce(function(a,b){return a+b;},0)/arr.length : null; }
    function pct(v) { return v !== null ? Math.round(v * 100) : null; }
    function accScore(errPct) {
      if (errPct === null) return null;
      var abs = Math.abs(errPct);
      return Math.max(0, Math.round(100 - abs * 100));
    }

    var revMeanErr = avg(revErrors);
    var occMeanErr = avg(occErrors);
    var adrMeanErr = avg(adrErrors);
    var seasonMeanErr = avg(seasonErrors);

    results.push({
      id: pg.id,
      name: pg.name,
      city: pg.city, state: pg.state,
      monthCount: pg.months.length,
      plMonthly: plMonthly,
      // Scores
      revScore: accScore(revMeanErr),
      revBias: pct(revMeanErr),
      occScore: accScore(occMeanErr),
      occBias: pct(occMeanErr),
      adrScore: accScore(adrMeanErr),
      adrBias: pct(adrMeanErr),
      seasonScore: accScore(seasonMeanErr),
      seasonBias: seasonMeanErr !== null ? Math.round(seasonMeanErr * 100) / 100 : null,
      // Effective settings (for display)
      settings: settings,
      _revErr: revMeanErr,
      _occErr: occMeanErr,
    });
  });

  // Sort by weakest revenue accuracy first
  results.sort(function(a, b) {
    var as = a.revScore !== null ? a.revScore : 100;
    var bs = b.revScore !== null ? b.revScore : 100;
    return as - bs;
  });

  // Portfolio-level summary
  var allRevScores = results.filter(function(r) { return r.revScore !== null; }).map(function(r) { return r.revScore; });
  var allOccScores = results.filter(function(r) { return r.occScore !== null; }).map(function(r) { return r.occScore; });
  var allAdrScores = results.filter(function(r) { return r.adrScore !== null; }).map(function(r) { return r.adrScore; });
  var allSeasonScores = results.filter(function(r) { return r.seasonScore !== null; }).map(function(r) { return r.seasonScore; });
  function pavg(arr) { return arr.length > 0 ? Math.round(arr.reduce(function(a,b){return a+b;},0)/arr.length) : null; }

  // Count settings sources
  var withTemplate = results.filter(function(r) { return r.settings.templateName; }).length;
  var withDefault = results.length - withTemplate;

  return {
    properties: results,
    portfolio: {
      revScore: pavg(allRevScores),
      occScore: pavg(allOccScores),
      adrScore: pavg(allAdrScores),
      seasonScore: pavg(allSeasonScores),
      propCount: results.length,
      monthCount: actuals.length,
      withTemplate: withTemplate,
      withDefault: withDefault,
    }
  };
}

function renderAlgoHealth(data) {
  var el = document.getElementById('algoHealthContent');
  if (!el) return;

  var port = data.portfolio;
  var props = data.properties;

  function scoreColor(s) {
    if (s === null) return 'var(--text3)';
    if (s >= 80) return 'var(--accent)';
    if (s >= 60) return '#f59e0b';
    return 'var(--danger)';
  }
  function scoreLabel(s) {
    if (s === null) return '—';
    if (s >= 80) return '✓ Good';
    if (s >= 60) return '' + _ico('alertTriangle', 13, '#f59e0b') + ' Fair';
    return '✗ Off';
  }
  function biasLabel(bias, unit) {
    if (bias === null || bias === undefined) return '—';
    var sign = bias >= 0 ? '+' : '';
    return sign + bias + unit;
  }
  function biasColor(bias) {
    if (bias === null || bias === undefined) return 'var(--text3)';
    var abs = Math.abs(bias);
    if (abs <= 10) return 'var(--accent)';
    if (abs <= 25) return '#f59e0b';
    return 'var(--danger)';
  }
  function scoreGauge(score) {
    if (score === null) return '';
    var color = scoreColor(score);
    return '<div style="display:inline-block;width:48px;height:6px;background:var(--bg);border-radius:3px;vertical-align:middle;margin-left:6px;">' +
      '<div style="width:' + Math.min(score, 100) + '%;height:100%;background:' + color + ';border-radius:3px;"></div></div>';
  }

  var h = '';

  // Portfolio summary scores
  h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;">';
  var metrics = [
    { label: 'Revenue Accuracy', score: port.revScore, tip: 'How close projected monthly revenue is to Guesty actuals. Projection = PriceLabs monthly × seasonality.' },
    { label: 'Occupancy Fit', score: port.occScore, tip: 'How close actual occupancy is to the target set in each property\'s template (or 65% default).' },
    { label: 'ADR Accuracy', score: port.adrScore, tip: 'How close projected ADR (monthly ÷ 30 × occ target) is to actual nightly rate from Guesty.' },
    { label: 'Seasonality Fit', score: port.seasonScore, tip: 'How well seasonality multipliers (from data or template peak/low months) track actual month-to-month revenue swings.' },
  ];
  metrics.forEach(function(m) {
    var color = scoreColor(m.score);
    h += '<div title="' + esc(m.tip) + '" style="padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;cursor:help;">';
    h += '<div style="font-size:0.65rem;font-weight:600;color:var(--text3);margin-bottom:6px;text-transform:uppercase;">' + esc(m.label) + '</div>';
    h += '<div style="font-size:1.5rem;font-weight:700;color:' + color + ';font-family:DM Mono,monospace;">' + (m.score !== null ? m.score + '%' : '—') + '</div>';
    h += '<div style="font-size:0.72rem;color:' + color + ';margin-top:2px;">' + scoreLabel(m.score) + '</div>';
    h += '</div>';
  });
  h += '</div>';

  // Settings source summary
  h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">';
  h += '<span>' + port.propCount + ' properties · ' + port.monthCount + ' monthly actuals</span>';
  if (port.withTemplate > 0) h += '<span style="color:#a78bfa;">' + _ico('receipt', 13) + ' ' + port.withTemplate + ' using templates</span>';
  if (port.withDefault > 0) h += '<span style="color:var(--text3);">' + _ico('settings', 13) + ' ' + port.withDefault + ' using defaults (65% occ, standard season)</span>';
  h += '</div>';

  if (props.length === 0) {
    h += '<div style="color:var(--text3);font-size:0.82rem;">No properties with projections found. Set a monthly revenue target in property settings.</div>';
    el.innerHTML = h;
    return;
  }

  // Per-property table
  h += '<div style="overflow-x:auto;">';
  h += '<table class="comp-table" style="font-size:0.78rem;">';
  h += '<thead><tr>';
  h += '<th>Property</th>';
  h += '<th title="What settings are driving this property\'s scores">Settings</th>';
  h += '<th title="How close projected revenue is to actual">Rev Score</th>';
  h += '<th title="Whether projections tend to over- or under-estimate">Rev Bias</th>';
  h += '<th title="Actual occupancy vs target">Occ Score</th>';
  h += '<th title="Actual vs projected ADR">ADR Score</th>';
  h += '<th title="How well seasonality multipliers track reality">Season Fit</th>';
  h += '<th>Months</th>';
  h += '<th>Calibration Tip</th>';
  h += '</tr></thead><tbody>';

  props.forEach(function(p) {
    var s = p.settings;

    // Derive calibration tip — now uses actual target, not hardcoded 65%
    var tip = '';
    var occTargetPct = Math.round(s.occTarget * 100);
    if (p.revScore !== null && p.revScore < 60) {
      if (p.revBias !== null && p.revBias > 15) tip ='' + _ico('trendUp', 13) + ' Projection too low — raise monthly target by ~' + p.revBias + '%';
      else if (p.revBias !== null && p.revBias < -15) tip = '' + _ico('trendDown', 13) + ' Projection too high — lower monthly target by ~' + Math.abs(p.revBias) + '%';
      else tip ='' + _ico('alertTriangle', 13, '#f59e0b') + ' High variance — check seasonality data';
    } else if (p.occScore !== null && p.occScore < 60) {
      if (p.occBias !== null && p.occBias < -10) tip ='' + _ico('home', 13) + ' Occupancy below ' + occTargetPct + '% target — adjust pricing or lower target';
      else if (p.occBias !== null && p.occBias > 10) tip = '✓ Occupancy exceeds ' + occTargetPct + '% target — could push rates higher';
    } else if (p.adrScore !== null && p.adrScore < 60) {
      tip ='' + _ico('dollarSign', 13) + ' ADR mismatch — review base price vs actuals';
    } else if (p.seasonScore !== null && p.seasonScore < 60) {
      tip ='' + _ico('calendar', 13) + ' Seasonal multipliers need tuning — try custom peak/low months in template';
    } else if (p.revScore !== null && p.revScore >= 80) {
      tip = '' + _ico('check', 13, 'var(--accent)') + ' Well calibrated';
    }

    // Settings cell
    var settingsHtml = '';
    if (s.templateName) {
      settingsHtml += '<span style="font-size:0.68rem;padding:1px 5px;border-radius:3px;color:#a78bfa;border:1px solid rgba(167,139,250,0.3);background:rgba(167,139,250,0.08);">' + _ico('receipt', 13) + ' ' + esc(s.templateName) + '</span>';
    } else {
      settingsHtml += '<span style="font-size:0.68rem;color:var(--text3);">' + _ico('settings', 13) + ' Defaults</span>';
    }
    settingsHtml += '<div style="font-size:0.62rem;color:var(--text3);margin-top:2px;line-height:1.4;">';
    settingsHtml += occTargetPct + '% occ · ' + esc(s.pricingBias);
    if (s.minRate) settingsHtml += ' · $' + s.minRate + ' floor';
    if (s.maxRate) settingsHtml += ' · $' + s.maxRate + ' cap';
    settingsHtml += '<br>' + esc(s.seasonalProfile) + ' season';
    if (s.peakMonths.length > 0) settingsHtml += ' · peak:' + s.peakMonths.join(',');
    if (s.lowMonths.length > 0) settingsHtml += ' · low:' + s.lowMonths.join(',');
    settingsHtml += '</div>';

    var revColor = scoreColor(p.revScore);
    h += '<tr>';
    h += '<td style="font-weight:600;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(p.name) + '">' + esc(p.name) + '<div style="font-size:0.65rem;color:var(--text3);">' + esc(p.city) + ', ' + esc(p.state) + ' · $' + Math.round(p.plMonthly).toLocaleString() + '/mo</div></td>';
    h += '<td style="min-width:130px;">' + settingsHtml + '</td>';
    h += '<td><span style="color:' + revColor + ';font-weight:600;">' + (p.revScore !== null ? p.revScore + '%' : '—') + '</span>' + scoreGauge(p.revScore) + '</td>';
    h += '<td style="color:' + biasColor(p.revBias) + ';font-family:DM Mono,monospace;">' + biasLabel(p.revBias, '%') + '</td>';
    h += '<td style="color:' + scoreColor(p.occScore) + ';">' + (p.occScore !== null ? p.occScore + '%' : '—') + '<div style="font-size:0.6rem;color:var(--text3);">vs ' + occTargetPct + '%</div></td>';
    h += '<td style="color:' + scoreColor(p.adrScore) + ';">' + (p.adrScore !== null ? p.adrScore + '%' : '—') + '</td>';
    h += '<td style="color:' + scoreColor(p.seasonScore) + ';">' + (p.seasonScore !== null ? p.seasonScore + '%' : '—') + '</td>';
    h += '<td style="color:var(--text3);">' + p.monthCount + '</td>';
    h += '<td style="font-size:0.72rem;color:var(--text2);max-width:200px;">' + (tip || '<span style="color:var(--text3);">—</span>') + '</td>';
    h += '</tr>';
  });

  h += '</tbody></table></div>';

  h += '<div style="margin-top:10px;font-size:0.7rem;color:var(--text3);line-height:1.6;">';
  h += '<strong>How scores work:</strong> 100% = perfect match · 80%+ = well calibrated · 60–79% = acceptable · &lt;60% = needs attention.<br>';
  h += '<strong>Settings column:</strong> Shows template name (' + _ico('clipboard', 13) + ') or defaults (' + _ico('settings', 13) + '). Occupancy target, pricing bias, rate guardrails, and seasonal profile are used in score calculations. Assign a template to customize per property.';
  h += '</div>';

  el.innerHTML = h;
}

// ── ALGO TEMPLATES ──────────────────────────────────────────────────────────

async function loadAlgoTemplates() {
  var el = document.getElementById('algoTemplatesList');
  if (!el) return;
  try {
    var d = await api('/api/algo-templates');
    var templates = d.templates || [];
    if (templates.length === 0) {
      el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3);font-size:0.85rem;">' +
        '<div style="font-size:1.3rem;margin-bottom:6px;">' + _ico('clipboard', 13) + '</div>' +
        'No templates yet. Create your first pricing template to standardize strategies across properties.' +
        '</div>';
      return;
    }

    var h = '<div style="display:grid;gap:10px;">';
    templates.forEach(function(t) {
      var biasColors = { balanced: '#60a5fa', aggressive: '#f59e0b', conservative: '#10b981', premium: '#a78bfa' };
      var biasColor = biasColors[t.pricing_bias] || 'var(--text3)';
      var rules = [];
      if (t.min_nights) rules.push('Min ' + t.min_nights + 'nt');
      if (t.weekend_pct) rules.push('+' + t.weekend_pct + '% wknd');
      if (t.lastmin_pct) rules.push('-' + t.lastmin_pct + '% last-min');
      if (t.gap_pct) rules.push('-' + t.gap_pct + '% gap');
      if (t.earlybird_pct) rules.push('-' + t.earlybird_pct + '% early');
      if (t.monthly_pct) rules.push('-' + t.monthly_pct + '% monthly');

      h += '<div style="padding:12px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">';
      h += '<div style="flex:1;min-width:200px;">';
      h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">';
      h += '<span style="font-weight:700;font-size:0.92rem;">' + esc(t.name) + '</span>';
      h += '<span style="font-size:0.65rem;padding:1px 6px;border-radius:4px;color:' + biasColor + ';border:1px solid ' + biasColor + ';background:' + biasColor + '15;">' + esc(t.pricing_bias || 'balanced') + '</span>';
      h += '<span style="font-size:0.65rem;color:var(--text3);">' + (t.property_count || 0) + ' properties</span>';
      h += '</div>';
      if (t.description) h += '<div style="font-size:0.75rem;color:var(--text2);margin-bottom:4px;">' + esc(t.description) + '</div>';
      h += '<div style="font-size:0.72rem;color:var(--text3);display:flex;gap:8px;flex-wrap:wrap;">';
      h += '<span>Occ target: <strong>' + (t.occupancy_target || 65) + '%</strong></span>';
      if (t.min_nightly_rate) h += '<span>Floor: <strong>$' + t.min_nightly_rate + '</strong></span>';
      if (t.max_nightly_rate) h += '<span>Ceiling: <strong>$' + t.max_nightly_rate + '</strong></span>';
      h += '<span>Season: ' + esc(t.seasonal_profile || 'standard') + '</span>';
      h += '</div>';
      if (rules.length > 0) {
        h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">' + rules.join(' · ') + '</div>';
      }
      h += '</div>';
      h += '<div style="display:flex;gap:6px;flex-shrink:0;">';
      h += '<button class="btn btn-xs" onclick="showAssignTemplateModal(' + t.id + ')" title="Assign this template to one or more properties">Assign</button>';
      h += '<button class="btn btn-xs" onclick="editAlgoTemplate(' + t.id + ')" title="Edit template settings">Edit</button>';
      h += '<button class="btn btn-xs btn-danger" onclick="deleteAlgoTemplate(' + t.id + ')" title="Delete this template (unassigns from all properties)">✕</button>';
      h += '</div>';
      h += '</div>';
    });
    h += '</div>';
    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">' + esc(err.message) + '</span>'; }
}

function showTemplateEditor(template) {
  var editor = document.getElementById('templateEditor');
  if (!editor) return;
  editor.style.display = '';
  var title = document.getElementById('templateEditorTitle');
  if (title) title.textContent = template ? 'Edit Template' : 'New Template';

  var t = template || {};
  var sv = function(id, val) { var el = document.getElementById(id); if (el) el.value = val != null ? val : ''; };
  sv('tpl_id', t.id || '');
  sv('tpl_name', t.name || '');
  sv('tpl_description', t.description || '');
  sv('tpl_occupancy_target', t.occupancy_target || 65);
  sv('tpl_pricing_bias', t.pricing_bias || 'balanced');
  sv('tpl_min_nightly_rate', t.min_nightly_rate || '');
  sv('tpl_max_nightly_rate', t.max_nightly_rate || '');
  sv('tpl_min_nights', t.min_nights || '');
  sv('tpl_weekend_pct', t.weekend_pct || '');
  sv('tpl_lastmin_pct', t.lastmin_pct || '');
  sv('tpl_gap_pct', t.gap_pct || '');
  sv('tpl_earlybird_pct', t.earlybird_pct || '');
  sv('tpl_monthly_pct', t.monthly_pct || '');
  sv('tpl_seasonal_profile', t.seasonal_profile || 'standard');
  sv('tpl_peak_months', t.peak_months || '');
  sv('tpl_low_months', t.low_months || '');
  sv('tpl_peak_markup_pct', t.peak_markup_pct || 20);
  sv('tpl_low_discount_pct', t.low_discount_pct || 15);
  sv('tpl_notes', t.notes || '');
  editor.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideTemplateEditor() {
  var editor = document.getElementById('templateEditor');
  if (editor) editor.style.display = 'none';
}

async function editAlgoTemplate(id) {
  try {
    var d = await api('/api/algo-templates/' + id);
    if (d.template) showTemplateEditor(d.template);
    else toast('Template not found', 'error');
  } catch (err) { toast(err.message, 'error'); }
}

async function saveAlgoTemplate() {
  var gv = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
  var name = gv('tpl_name');
  if (!name) { toast('Template name is required', 'error'); return; }

  var body = {
    name: name,
    description: gv('tpl_description'),
    occupancy_target: parseFloat(gv('tpl_occupancy_target')) || 65,
    pricing_bias: gv('tpl_pricing_bias') || 'balanced',
    min_nightly_rate: parseFloat(gv('tpl_min_nightly_rate')) || null,
    max_nightly_rate: parseFloat(gv('tpl_max_nightly_rate')) || null,
    min_nights: parseInt(gv('tpl_min_nights')) || null,
    weekend_pct: parseFloat(gv('tpl_weekend_pct')) || null,
    lastmin_pct: parseFloat(gv('tpl_lastmin_pct')) || null,
    gap_pct: parseFloat(gv('tpl_gap_pct')) || null,
    earlybird_pct: parseFloat(gv('tpl_earlybird_pct')) || null,
    monthly_pct: parseFloat(gv('tpl_monthly_pct')) || null,
    seasonal_profile: gv('tpl_seasonal_profile') || 'standard',
    peak_months: gv('tpl_peak_months') || null,
    low_months: gv('tpl_low_months') || null,
    peak_markup_pct: parseFloat(gv('tpl_peak_markup_pct')) || 20,
    low_discount_pct: parseFloat(gv('tpl_low_discount_pct')) || 15,
    notes: gv('tpl_notes') || null,
  };

  var existingId = gv('tpl_id');
  try {
    var d;
    if (existingId) {
      d = await api('/api/algo-templates/' + existingId, 'PUT', body);
    } else {
      d = await api('/api/algo-templates', 'POST', body);
    }
    toast(d.message || 'Template saved');
    hideTemplateEditor();
    loadAlgoTemplates();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function deleteAlgoTemplate(id) {
  try {
    var d = await api('/api/algo-templates/' + id);
    var name = d.template ? d.template.name : 'this template';
    if (!confirm('Delete template "' + name + '"? This will unassign it from all properties.')) return;
    await api('/api/algo-templates/' + id, 'DELETE');
    toast('Template deleted');
    loadAlgoTemplates();
  } catch (err) { toast(err.message, 'error'); }
}

async function showAssignTemplateModal(templateId) {
  // Fetch template name
  var templateName = 'Template #' + templateId;
  try {
    var td = await api('/api/algo-templates/' + templateId);
    if (td.template) templateName = td.template.name;
  } catch {}

  // Build a modal with checkboxes for all properties
  var props = window.properties || [];
  if (props.length === 0) { toast('No properties loaded', 'error'); return; }

  var h = '<div style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;" id="assignTemplateModal" onclick="if(event.target===this)this.remove()">';
  h += '<div style="background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:500px;width:90%;max-height:80vh;overflow-y:auto;" onclick="event.stopPropagation()">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">';
  h += '<h3 style="font-size:0.95rem;">Assign "' + esc(templateName) + '"</h3>';
  h += '<button class="btn btn-xs" onclick="document.getElementById(\'assignTemplateModal\').remove()">✕</button>';
  h += '</div>';
  h += '<p style="font-size:0.72rem;color:var(--text3);margin-bottom:10px;">Select properties to assign this template. Properties with existing templates will be reassigned.</p>';
  h += '<div style="margin-bottom:10px;"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.82rem;"><input type="checkbox" id="assignSelectAll" onchange="document.querySelectorAll(\'.assign-prop-cb\').forEach(function(c){c.checked=this.checked}.bind(this))"> Select All</label></div>';
  h += '<div style="display:flex;flex-direction:column;gap:4px;">';

  props.filter(function(p) { return !p.parent_id || p.parent_id === 0; }).forEach(function(p) {
    var isAssigned = p.algo_template_id == templateId;
    var currentTpl = p.algo_template_id ? ' <span style="font-size:0.65rem;color:var(--text3);">(template #' + p.algo_template_id + ')</span>' : '';
    h += '<label style="display:flex;align-items:center;gap:8px;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:0.82rem;' + (isAssigned ? 'background:rgba(16,185,129,0.08);' : '') + '">';
    h += '<input type="checkbox" class="assign-prop-cb" value="' + p.id + '"' + (isAssigned ? ' checked' : '') + '>';
    h += '<span>' + esc(p.address || p.name || 'Property ' + p.id) + (p.unit_number ? ' #' + esc(p.unit_number) : '') + '</span>';
    h += currentTpl;
    h += '</label>';
  });

  h += '</div>';
  h += '<div style="display:flex;gap:8px;margin-top:14px;">';
  h += '<button class="btn btn-sm btn-primary" onclick="doAssignTemplate(' + templateId + ')">Assign Selected</button>';
  h += '<button class="btn btn-sm" onclick="document.getElementById(\'assignTemplateModal\').remove()">Cancel</button>';
  h += '</div>';
  h += '</div></div>';

  document.body.insertAdjacentHTML('beforeend', h);
}

async function doAssignTemplate(templateId) {
  var checkboxes = document.querySelectorAll('.assign-prop-cb:checked');
  var ids = [];
  checkboxes.forEach(function(cb) { ids.push(parseInt(cb.value)); });
  if (ids.length === 0) { toast('Select at least one property', 'error'); return; }

  try {
    var d = await api('/api/algo-templates/assign', 'POST', { template_id: templateId, property_ids: ids });
    toast(d.message || 'Assigned');
    var modal = document.getElementById('assignTemplateModal');
    if (modal) modal.remove();
    loadAlgoTemplates();
    loadProperties(); // refresh property list to show updated template assignments
  } catch (err) { toast(err.message, 'error'); }
}