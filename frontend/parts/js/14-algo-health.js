// Algorithm Health Dashboard
// Compares projected revenue/occupancy/ADR/seasonality against Guesty actuals
// Lives in the PMS tab — actuals are the source of truth here

var algoHealthData = null;

async function loadAlgoHealth() {
  var el = document.getElementById('algoHealthContent');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;padding:10px;">Computing accuracy scores...</div>';

  try {
    // Need: actuals, properties (for projections), seasonality
    var [actualsResp, finResp] = await Promise.all([
      api('/api/guesty/actuals'),
      api('/api/finances/summary')
    ]);

    var actuals = actualsResp.actuals || [];
    var props = (finResp.properties || []);
    var maData = finResp.monthly_actuals || {};
    var seasonality = (maData.seasonality || finResp.seasonality || []);

    if (actuals.length === 0) {
      el.innerHTML = '<div style="color:var(--text3);font-size:0.82rem;padding:10px;">No Guesty actuals yet. Import and process reservation data first.</div>';
      return;
    }

    algoHealthData = computeAlgoHealth(actuals, props, seasonality);
    renderAlgoHealth(algoHealthData);
  } catch (err) {
    el.innerHTML = '<div style="color:var(--danger);font-size:0.82rem;padding:10px;">Error: ' + esc(err.message) + '</div>';
  }
}

function computeAlgoHealth(actuals, props, seasonality) {
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

  var results = [];

  Object.values(byProp).forEach(function(pg) {
    var prop = propMap[pg.id];
    if (!prop) return;

    var plMonthly = prop.monthly_revenue || 0; // PriceLabs / user projection
    if (plMonthly === 0) return; // Can't compare without a projection

    var revErrors = [], occErrors = [], adrErrors = [], seasonErrors = [];

    // Compute monthly avg for normalization
    var monthlyRevs = pg.months.map(function(m) { return m.total_revenue || 0; });
    var propAvgRev = monthlyRevs.length > 0 ? monthlyRevs.reduce(function(a,b){return a+b;},0) / monthlyRevs.length : 0;

    pg.months.forEach(function(m) {
      var mn = parseInt((m.month || '').substring(5));
      var seasonKey = (pg.city || '').toLowerCase() + '_' + (pg.state || '').toLowerCase() + '_' + mn;
      var seasonMult = seasonMap[seasonKey] || 1.0;

      // Projected revenue: PriceLabs monthly × seasonality multiplier
      var projRev = plMonthly * seasonMult;
      var actualRev = m.total_revenue || 0;

      // Revenue accuracy
      if (projRev > 0) {
        revErrors.push((actualRev - projRev) / projRev); // positive = under-projected, negative = over-projected
      }

      // Occupancy: project 65% as baseline (common STR assumption), compare to actual
      var actualOcc = m.occupancy_pct || 0; // 0–1
      var projOcc = 0.65; // baseline assumption
      occErrors.push(actualOcc - projOcc);

      // ADR accuracy: projected ADR = monthly / (30 × occupancy assumption)
      var projAdr = plMonthly / (30 * 0.65);
      var actualAdr = m.avg_nightly_rate || 0;
      if (projAdr > 0 && actualAdr > 0) {
        adrErrors.push((actualAdr - projAdr) / projAdr);
      }

      // Seasonality fit: expected multiplier vs what revenue ratio actually was vs property avg
      if (propAvgRev > 0 && actualRev > 0) {
        var actualMult = actualRev / propAvgRev;
        seasonErrors.push(actualMult - seasonMult);
      }
    });

    function avg(arr) { return arr.length > 0 ? arr.reduce(function(a,b){return a+b;},0)/arr.length : null; }
    function pct(v) { return v !== null ? Math.round(v * 100) : null; }
    function accScore(errPct) {
      // Convert mean absolute error% to accuracy score 0–100
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
      // Revenue
      revScore: accScore(revMeanErr),
      revBias: pct(revMeanErr), // + = we under-project (actual > projected), - = over-project
      // Occupancy
      occScore: accScore(occMeanErr),
      occBias: pct(occMeanErr), // + = actual occ higher than 65% baseline
      // ADR
      adrScore: accScore(adrMeanErr),
      adrBias: pct(adrMeanErr),
      // Seasonality
      seasonScore: accScore(seasonMeanErr),
      seasonBias: seasonMeanErr !== null ? Math.round(seasonMeanErr * 100) / 100 : null,
      // Raw for sorting
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

  return {
    properties: results,
    portfolio: {
      revScore: pavg(allRevScores),
      occScore: pavg(allOccScores),
      adrScore: pavg(allAdrScores),
      seasonScore: pavg(allSeasonScores),
      propCount: results.length,
      monthCount: actuals.length,
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
    if (s >= 60) return '⚠ Fair';
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
    { label: 'Occupancy Fit', score: port.occScore, tip: 'How close actual occupancy is to the 65% baseline assumption used in projections.' },
    { label: 'ADR Accuracy', score: port.adrScore, tip: 'How close projected ADR (monthly ÷ 30 × occ) is to actual nightly rate from Guesty.' },
    { label: 'Seasonality Fit', score: port.seasonScore, tip: 'How well our seasonality multipliers track actual month-to-month revenue swings.' },
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

  h += '<div style="font-size:0.72rem;color:var(--text3);margin-bottom:12px;">';
  h += port.propCount + ' properties · ' + port.monthCount + ' monthly actuals · Accuracy = how close estimates are to Guesty confirmed bookings';
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
  h += '<th title="How close projected revenue is to actual">Rev Score</th>';
  h += '<th title="Whether projections tend to over- or under-estimate">Rev Bias</th>';
  h += '<th title="Actual occupancy vs 65% baseline">Occ Score</th>';
  h += '<th title="Actual vs projected ADR">ADR Score</th>';
  h += '<th title="How well seasonality multipliers track reality">Season Fit</th>';
  h += '<th>Months</th>';
  h += '<th>Projection</th>';
  h += '<th>Calibration Tip</th>';
  h += '</tr></thead><tbody>';

  props.forEach(function(p) {
    // Derive calibration tip
    var tip = '';
    var revBiasAbs = p.revBias !== null ? Math.abs(p.revBias) : 0;
    if (p.revScore !== null && p.revScore < 60) {
      if (p.revBias !== null && p.revBias > 15) tip = '📈 Projection too low — raise monthly target by ~' + p.revBias + '%';
      else if (p.revBias !== null && p.revBias < -15) tip = '📉 Projection too high — lower monthly target by ~' + Math.abs(p.revBias) + '%';
      else tip = '⚠ High variance — check seasonality data';
    } else if (p.occScore !== null && p.occScore < 60) {
      if (p.occBias !== null && p.occBias < -10) tip = '🏠 Occupancy below 65% — adjust strategy or pricing';
      else if (p.occBias !== null && p.occBias > 10) tip = '✓ Occupancy exceeds baseline — could push rates higher';
    } else if (p.adrScore !== null && p.adrScore < 60) {
      tip = '💰 ADR mismatch — review PriceLabs base price vs actuals';
    } else if (p.seasonScore !== null && p.seasonScore < 60) {
      tip = '📅 Seasonality multipliers need tuning for this market';
    } else if (p.revScore !== null && p.revScore >= 80) {
      tip = '✅ Well calibrated';
    }

    var revColor = scoreColor(p.revScore);
    h += '<tr>';
    h += '<td style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(p.name) + '">' + esc(p.name) + '<div style="font-size:0.65rem;color:var(--text3);">' + esc(p.city) + ', ' + esc(p.state) + '</div></td>';
    h += '<td><span style="color:' + revColor + ';font-weight:600;">' + (p.revScore !== null ? p.revScore + '%' : '—') + '</span>' + scoreGauge(p.revScore) + '</td>';
    h += '<td style="color:' + biasColor(p.revBias) + ';font-family:DM Mono,monospace;">' + biasLabel(p.revBias, '%') + '</td>';
    h += '<td style="color:' + scoreColor(p.occScore) + ';">' + (p.occScore !== null ? p.occScore + '%' : '—') + '</td>';
    h += '<td style="color:' + scoreColor(p.adrScore) + ';">' + (p.adrScore !== null ? p.adrScore + '%' : '—') + '</td>';
    h += '<td style="color:' + scoreColor(p.seasonScore) + ';">' + (p.seasonScore !== null ? p.seasonScore + '%' : '—') + '</td>';
    h += '<td style="color:var(--text3);">' + p.monthCount + '</td>';
    h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(p.plMonthly).toLocaleString() + '/mo</td>';
    h += '<td style="font-size:0.72rem;color:var(--text2);max-width:220px;">' + (tip || '<span style="color:var(--text3);">—</span>') + '</td>';
    h += '</tr>';
  });

  h += '</tbody></table></div>';

  h += '<div style="margin-top:10px;font-size:0.7rem;color:var(--text3);line-height:1.6;">';
  h += '<strong>How scores work:</strong> 100% = perfect match · 80%+ = well calibrated · 60–79% = acceptable variance · &lt;60% = needs attention. ';
  h += 'Rev Bias: positive = we under-projected (actual higher than expected), negative = over-projected. ';
  h += 'Requires PriceLabs monthly projection set on each property.';
  h += '</div>';

  el.innerHTML = h;
}
