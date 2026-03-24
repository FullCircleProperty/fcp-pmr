// Dashboard — main landing page
// Loads from GET /api/dashboard — one call, all KPIs

async function loadDashboard() {
  var el = document.getElementById('dashboardContent');
  if (!el) return;

  try {
    var d = await api('/api/dashboard');
    renderDashboard(d);
  } catch (err) {
    el.innerHTML = '<div style="color:var(--danger);padding:20px;">' + esc(err.message) + '</div>';
  }
}

function renderDashboard(d) {
  var el = document.getElementById('dashboardContent');
  if (!el) return;
  var h = '';

  // ── ROW 1: Portfolio Overview ────────────────────────────────────────────
  var rev = d.revenue || {};
  var tm = rev.this_month || {};
  var lm = rev.last_month || {};
  var ytd = rev.ytd || {};
  var occ = d.occupancy || {};
  var port = d.portfolio || {};
  var mom = rev.month_over_month;
  var payMom = rev.payout_mom;
  var yoy = rev.year_over_year;

  // Properties count line
  var propActive = port.active || 0;
  var propOwned = port.owned || 0;
  var propRented = port.rented || 0;
  var propManaged = port.managed || 0;
  var propBreakdown = [];
  if (propOwned > 0) propBreakdown.push(_ico('home', 13, 'var(--accent)') + ' ' + propOwned + ' owned');
  if (propRented > 0) propBreakdown.push(_ico('key', 13, '#f0b840') + ' ' + propRented + ' rented');
  if (propManaged > 0) propBreakdown.push(_ico('handshake', 13, '#5b8def') + ' ' + propManaged + ' managed');
  var propExtra = [];
  if (port.inactive > 0) propExtra.push(port.inactive + ' inactive');
  if (port.research > 0) propExtra.push(port.research + ' research');
  if (port.units > 0) propExtra.push(port.units + ' units');

  var totalInvest = port.total_purchase || 0;
  var totalVal = port.total_value || 0;
  var equity = port.equity || 0;
  var monthlyCosts = port.monthly_cost || 0;

  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;display:flex;align-items:center;gap:5px;">' + _ico('building', 14, 'var(--text3)') + ' PORTFOLIO — ' + propActive + ' Active Properties' + (port.active_listings > 0 ? ' · ' + port.active_listings + ' Listings' : '') + '</div>';
  if (propBreakdown.length > 0 || propExtra.length > 0) {
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;font-size:0.72rem;">';
    propBreakdown.forEach(function(b) { h += '<span style="color:var(--text2);">' + b + '</span>'; });
    if (propExtra.length > 0) h += '<span style="color:var(--text3);">' + propExtra.join(' · ') + '</span>';
    h += '</div>';
  }

  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;">';
  h += _dashKpi('Investment', totalInvest > 0 ? '$' + Math.round(totalInvest / 1000).toLocaleString() + 'k' : '—', '', 'var(--text)', 'Total purchase price of all owned properties');
  h += _dashKpi('Current Value', totalVal > 0 ? '$' + Math.round(totalVal / 1000).toLocaleString() + 'k' : '—', totalVal > totalInvest && totalInvest > 0 ? '↑ $' + Math.round((totalVal - totalInvest) / 1000).toLocaleString() + 'k gain' : '', '#a78bfa', 'Sum of estimated values (or purchase price if no estimate)');
  h += _dashKpi('Equity', equity !== 0 ? '$' + Math.round(equity / 1000).toLocaleString() + 'k' : '—', '', equity > 0 ? 'var(--accent)' : 'var(--text)', 'Current value minus purchase price — your paper gain/loss');
  h += '</div>';

  // ── ROW 2: This Month P&L — the key snapshot ──────────────────────────
  var monthLabel = rev.this_month_label || new Date().toISOString().substring(0, 7);
  var daysElapsed = new Date().getDate();
  var daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  var monthProgress = Math.round(daysElapsed / daysInMonth * 100);
  // Pro-rate costs for partial month comparison
  var proRatedCosts = monthlyCosts > 0 ? Math.round(monthlyCosts * daysElapsed / daysInMonth) : 0;

  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;display:flex;align-items:center;gap:5px;">' + _ico('activity', 14, 'var(--text3)') + ' THIS MONTH — ' + monthLabel + ' <span style="font-weight:400;color:var(--text3);">(' + daysElapsed + ' of ' + daysInMonth + ' days)</span></div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;">';

  // Payout is what you actually receive — lead with this
  h += _dashKpi('Payout', '$' + (tm.payout || 0).toLocaleString(), daysElapsed + ' of ' + daysInMonth + ' days', 'var(--accent)', 'Host payout from Guesty — money received after platform fees and commissions.');

  // Full monthly fixed costs
  if (monthlyCosts > 0) {
    h += _dashKpi('Monthly Costs', '$' + monthlyCosts.toLocaleString(), '$' + (monthlyCosts * 12).toLocaleString() + '/yr', 'var(--danger)', 'Total fixed monthly costs: mortgage, insurance, taxes, HOA, utilities, services.');
  }

  // Net — payout so far minus full month costs
  if (monthlyCosts > 0 && (tm.payout || 0) > 0) {
    var thisMonthNet = (tm.payout || 0) - monthlyCosts;
    var pacingNote = daysElapsed < daysInMonth ? 'Month in progress — ' + (daysInMonth - daysElapsed) + ' days remaining' : 'Full month';
    h += _dashKpi('Net', (thisMonthNet >= 0 ? '+' : '') + '$' + Math.round(thisMonthNet).toLocaleString(), pacingNote, thisMonthNet >= 0 ? 'var(--accent)' : 'var(--danger)', 'Payout received this month minus full monthly fixed costs. ' + (daysElapsed < daysInMonth ? 'Still ' + (daysInMonth - daysElapsed) + ' days left to earn.' : ''));
  }

  // Occupancy + ADR
  // Occupancy — show both the full-month booked rate and the elapsed actual
  var occConfirmed = tm.avail > 0 ? Math.round(tm.nights / tm.avail * 100) : null;
  var occElapsed = (tm.elapsed_days || 0) > 0 ? Math.round((tm.elapsed_nights || 0) / tm.elapsed_days * 100) : null;
  var occSub = '';
  if (occElapsed !== null && occConfirmed !== null && occElapsed !== occConfirmed) {
    occSub = 'So far: ' + occElapsed + '% | Booked: ' + occConfirmed + '%';
  } else if (occ.last_month != null) {
    occSub = 'Last mo: ' + occ.last_month + '%';
  }
  h += _dashKpi('Occupancy', occConfirmed !== null ? occConfirmed + '%' : '—', occSub, occConfirmed >= 70 ? 'var(--accent)' : occConfirmed >= 50 ? '#f0b840' : occConfirmed !== null ? 'var(--danger)' : 'var(--text3)', 'Confirmed nights booked this month / total days. \"So far\" shows only elapsed days.');

  // Bookings
  var nightsSub = (tm.nights || 0) + ' nights booked';
  if ((tm.elapsed_nights || 0) > 0 && tm.elapsed_nights < tm.nights) nightsSub = (tm.elapsed_nights || 0) + ' stayed, ' + ((tm.nights || 0) - (tm.elapsed_nights || 0)) + ' upcoming';
  h += _dashKpi('Bookings', (tm.bookings || 0).toString(), nightsSub, 'var(--text)', 'Reservations with check-in this month');

  // MoM comparison
  if (lm.payout > 0) {
    var payoutMom = Math.round(((tm.payout || 0) - lm.payout) / lm.payout * 100);
    var payoutMomColor = payoutMom >= 0 ? 'var(--accent)' : 'var(--danger)';
    h += _dashKpi('vs Last Mo', (payoutMom >= 0 ? '+' : '') + payoutMom + '%', 'Last: $' + lm.payout.toLocaleString(), payoutMomColor, 'Payout this month vs last month. Note: current month may be in progress.');
  }

  h += '</div>';

  // ── ROW 3: Year to Date ────────────────────────────────────────────────
  var ytdMonths = new Date().getMonth() + 1;
  var ytdCosts = monthlyCosts * ytdMonths;

  h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;display:flex;align-items:center;gap:5px;">' + _ico('barChart', 14, 'var(--text3)') + ' YEAR TO DATE — ' + new Date().getFullYear() + ' (' + ytdMonths + ' months)</div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px;">';

  h += _dashKpi('YTD Payout', '$' + (ytd.payout || 0).toLocaleString(), ytd.props ? ytd.props + ' properties' : '', 'var(--accent)', 'Total host payout year-to-date — money received after platform fees.');

  h += _dashKpi('YTD Costs', ytdCosts > 0 ? '$' + Math.round(ytdCosts).toLocaleString() : '—', ytdMonths + ' months × $' + monthlyCosts.toLocaleString(), 'var(--danger)', 'Total fixed costs year-to-date: monthly costs × months elapsed.');

  // YTD net profit
  var ytdNet = (ytd.payout || 0) - ytdCosts;
  if (ytdCosts > 0) {
    h += _dashKpi('YTD Profit', (ytdNet >= 0 ? '+' : '') + '$' + Math.round(ytdNet).toLocaleString(), ytdNet >= 0 ? 'Profitable' : 'Operating at a loss', ytdNet >= 0 ? 'var(--accent)' : 'var(--danger)', 'YTD payout minus YTD fixed costs. Does not include property appreciation or tax deductions.');
  }

  // YTD occupancy
  var ytdOcc = (ytd.avail || 0) > 0 ? Math.round((ytd.nights || 0) / ytd.avail * 100) : null;
  h += _dashKpi('YTD Occupancy', ytdOcc !== null ? ytdOcc + '%' : '—', (ytd.nights || 0).toLocaleString() + ' / ' + (ytd.avail || 0).toLocaleString() + ' nights', ytdOcc >= 60 ? 'var(--accent)' : ytdOcc >= 40 ? '#f0b840' : 'var(--text3)', 'Year-to-date occupancy across portfolio');

  // YoY
  var yoyLabel = yoy != null ? (yoy >= 0 ? '+' : '') + yoy + '%' : '—';
  h += _dashKpi('YoY Change', yoyLabel, yoy != null ? 'vs same month last year' : 'No prior year data', yoy > 0 ? 'var(--accent)' : yoy < 0 ? 'var(--danger)' : 'var(--text3)', 'Revenue change vs same month last year');

  // EOY Projection — at current pace, where do we land?
  var runRate = ytdMonths > 0 && ytd.payout > 0 ? Math.round(ytd.payout / ytdMonths * 12) : 0;
  var annualCosts = monthlyCosts * 12;
  var monthsRemaining = 12 - ytdMonths;
  if (runRate > 0) {
    var projectedNet = runRate - annualCosts;
    var projNetColor = projectedNet >= 0 ? 'var(--accent)' : 'var(--danger)';
    h += '</div>';
    h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px;display:flex;align-items:center;gap:5px;">' + _ico('trendUp', 14, '#a78bfa') + ' EOY PROJECTION — at current pace (' + monthsRemaining + ' months remaining)</div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px;">';
    h += _dashKpi('Projected Payout', '$' + runRate.toLocaleString(), 'Based on $' + Math.round(ytd.payout / ytdMonths).toLocaleString() + '/mo avg', '#a78bfa', 'YTD payout ÷ ' + ytdMonths + ' months × 12. Assumes current booking pace continues.');
    h += _dashKpi('Annual Costs', '$' + annualCosts.toLocaleString(), '$' + monthlyCosts.toLocaleString() + ' × 12 months', 'var(--danger)', 'Total fixed costs for the full year.');
    h += _dashKpi('Projected Net', (projectedNet >= 0 ? '+' : '') + '$' + Math.round(projectedNet).toLocaleString(), projectedNet >= 0 ? 'On track to profit' : 'On track for a loss', projNetColor, 'Projected annual payout minus annual costs. Does not include appreciation, tax deductions, or one-time expenses.');
    if (annualCosts > 0) {
      var breakEvenMonthly = Math.round(annualCosts / 12);
      var currentMonthlyPayout = Math.round(ytd.payout / ytdMonths);
      var coveragePct = Math.round(currentMonthlyPayout / breakEvenMonthly * 100);
      h += _dashKpi('Cost Coverage', coveragePct + '%', '$' + currentMonthlyPayout.toLocaleString() + ' of $' + breakEvenMonthly.toLocaleString() + ' needed', coveragePct >= 100 ? 'var(--accent)' : coveragePct >= 75 ? '#f0b840' : 'var(--danger)', 'Average monthly payout as a percentage of monthly costs. 100% = breakeven, above = profitable.');
    }
  }

  h += '</div>';

  // ── Year Projection Chart ─────────────────────────────────────────────
  var proj = d.year_projection || [];
  if (proj.length === 12) {
    var mNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var maxVal = 0;
    proj.forEach(function(p) {
      if (p.actual > maxVal) maxVal = p.actual;
      if (p.booked > maxVal) maxVal = p.booked;
      if (p.target > maxVal) maxVal = p.target;
    });
    // Pad max for headroom
    maxVal = maxVal > 0 ? Math.ceil(maxVal * 1.15 / 1000) * 1000 : 10000;

    var chartH = 240;
    var chartW = '100%';

    h += '<div class="card" style="margin-bottom:16px;padding:14px 16px;position:relative;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);display:flex;align-items:center;gap:6px;">' + _ico('trendUp', 15, 'var(--accent)') + ' ' + new Date().getFullYear() + ' REVENUE PROJECTION</div>';
    h += '<div style="display:flex;gap:12px;font-size:0.72rem;">';
    h += '<span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:3px;background:var(--accent);border-radius:1px;display:inline-block;"></span> Actual</span>';
    h += '<span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:3px;background:#60a5fa;border-radius:1px;display:inline-block;border:1px dashed #60a5fa;background:transparent;"></span> Booked</span>';
    h += '<span style="display:flex;align-items:center;gap:4px;"><span style="width:12px;height:3px;background:transparent;border-bottom:2px dotted #f59e0b;display:inline-block;"></span> Target</span>';
    h += '</div></div>';

    // SVG chart — wide viewBox matches typical card aspect ratio
    var svgW = 1200;
    var svgH = 200;
    var padL = 52, padR = 16, padT = 16, padB = 28;
    var plotW = svgW - padL - padR;
    var plotH = svgH - padT - padB;

    h += '<div>';
    h += '<svg viewBox="0 0 ' + svgW + ' ' + svgH + '" style="width:100%;height:auto;display:block;" xmlns="http://www.w3.org/2000/svg">';

    // Grid lines + Y axis labels
    var gridSteps = 4;
    for (var g = 0; g <= gridSteps; g++) {
      var gy = padT + plotH - (g / gridSteps * plotH);
      var gVal = Math.round(maxVal * g / gridSteps);
      var gLabel = gVal >= 1000 ? '$' + Math.round(gVal / 1000) + 'k' : '$' + gVal;
      h += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (svgW - padR) + '" y2="' + gy + '" stroke="var(--border)" stroke-width="0.5" />';
      h += '<text x="' + (padL - 4) + '" y="' + (gy + 4) + '" text-anchor="end" fill="var(--text3)" font-size="11">' + gLabel + '</text>';
    }

    // Build line paths — hover tooltips instead of static labels for clean visuals
    var actualPts = [], bookedPts = [], targetPts = [];
    var barW = plotW / 12;
    var lastActualX = 0, lastActualY = 0;
    var dotsBuf = [];
    var hoverZones = []; // invisible hit areas per month
    var fmtVal = function(v) { return '$' + (v >= 1000 ? Math.round(v / 1000) + 'k' : v); };
    var fmtFull = function(v) { return '$' + Math.round(v).toLocaleString(); };
    var toY = function(v) { return padT + plotH - (v / maxVal * plotH); };
    var projId = 'projChart_' + Date.now();

    // Store data for tooltip access
    var _projData = [];

    proj.forEach(function(p, i) {
      var cx = padL + barW * i + barW / 2;

      // Month labels
      h += '<text x="' + cx + '" y="' + (svgH - 5) + '" text-anchor="middle" fill="var(--text3)" font-size="12" font-weight="' + (p.is_current ? '700' : '400') + '">' + mNames[i] + '</text>';

      if (p.is_current) {
        h += '<rect x="' + (padL + barW * i) + '" y="' + padT + '" width="' + barW + '" height="' + plotH + '" fill="var(--accent)" opacity="0.04" rx="3" />';
      }

      // Collect line points
      if (p.target != null && p.target > 0) targetPts.push({ x: cx, y: toY(p.target), val: p.target, month: i });
      if (p.actual != null) { actualPts.push(cx + ',' + toY(p.actual)); lastActualX = cx; lastActualY = toY(p.actual); }
      var hasBooked = !p.is_past && p.booked != null && p.booked > 0;
      if (hasBooked) bookedPts.push(cx + ',' + toY(p.booked));

      // Dots
      if (p.actual != null && p.actual > 0) dotsBuf.push('<circle cx="' + cx + '" cy="' + toY(p.actual) + '" r="4" fill="var(--accent)" />');
      if (hasBooked) dotsBuf.push('<circle cx="' + cx + '" cy="' + toY(p.booked) + '" r="3.5" fill="#60a5fa" stroke="var(--bg)" stroke-width="1.5" />');
      if (p.target != null && p.target > 0) dotsBuf.push('<circle cx="' + cx + '" cy="' + toY(p.target) + '" r="2.5" fill="#f59e0b" opacity="0.7" />');

      // All labels shown on hover — clean chart with just dots and lines

      // Invisible hover zone per month column
      hoverZones.push('<rect x="' + (padL + barW * i) + '" y="' + padT + '" width="' + barW + '" height="' + plotH + '" fill="transparent" data-mi="' + i + '" style="cursor:crosshair;" />');

      _projData.push({ month: mNames[i], actual: p.actual, booked: p.booked, target: p.target, is_past: p.is_past, is_current: p.is_current });
    });

    // === RENDER ORDER: area fill > lines > dots+labels > hover zones (on top for mouse events) ===

    if (actualPts.length > 1) {
      var bottomY = padT + plotH;
      var areaPath = actualPts[0].split(',')[0] + ',' + bottomY + ' ' + actualPts.join(' ') + ' ' + actualPts[actualPts.length - 1].split(',')[0] + ',' + bottomY;
      h += '<polygon points="' + areaPath + '" fill="var(--accent)" opacity="0.06" />';
    }

    var targetPtStr = targetPts.map(function(t) { return t.x + ',' + t.y; });
    if (targetPtStr.length > 1) h += '<polyline points="' + targetPtStr.join(' ') + '" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="3,3" opacity="0.7" stroke-linejoin="round" />';
    if (bookedPts.length > 1) h += '<polyline points="' + bookedPts.join(' ') + '" fill="none" stroke="#60a5fa" stroke-width="2" stroke-dasharray="6,3" stroke-linejoin="round" />';
    if (bookedPts.length >= 1 && actualPts.length > 0) {
      var fbX = bookedPts[0].split(',')[0], fbY = bookedPts[0].split(',')[1];
      if (Math.abs(parseFloat(fbX) - lastActualX) > 5) h += '<line x1="' + lastActualX + '" y1="' + lastActualY + '" x2="' + fbX + '" y2="' + fbY + '" stroke="#60a5fa" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.6" />';
    }
    if (actualPts.length > 1) h += '<polyline points="' + actualPts.join(' ') + '" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" />';

    h += dotsBuf.join('');
    h += hoverZones.join('');

    // Vertical guide line (hidden, shown on hover via JS)
    h += '<line id="' + projId + '_guide" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + plotH) + '" stroke="var(--text3)" stroke-width="1" stroke-dasharray="3,2" opacity="0" />';

    h += '</svg>';

    // Tooltip div (hidden by default, positioned absolute over chart)
    h += '<div id="' + projId + '_tip" style="display:none;position:absolute;pointer-events:none;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:0.78rem;box-shadow:0 4px 12px rgba(0,0,0,0.3);z-index:100;min-width:160px;line-height:1.7;"></div>';
    if (actualPts.length === 0) {
      h += '<div style="font-size:0.72rem;color:#f59e0b;padding:6px 0;">' + _ico('alertTriangle', 13, '#f59e0b') + ' No actual revenue data — go to Integrations → Process Monthly Actuals to rebuild from Guesty.</div>';
    }
    h += '</div>';

    // Wire up hover events after render
    window._projData = _projData;
    window._projId = projId;
    window._projFmtFull = fmtFull;
    setTimeout(function() {
      var wrap = document.getElementById(projId + '_tip');
      if (!wrap) return;
      var container = wrap.parentElement;
      var svg = container.querySelector('svg');
      if (!svg) return;
      svg.querySelectorAll('rect[data-mi]').forEach(function(zone) {
        zone.addEventListener('mouseenter', function(e) {
          var mi = parseInt(zone.getAttribute('data-mi'));
          var d = window._projData[mi];
          if (!d) return;
          // Show vertical guide line at column center
          var guide = document.getElementById(window._projId + '_guide');
          var zx = parseFloat(zone.getAttribute('x')) + parseFloat(zone.getAttribute('width')) / 2;
          if (guide) { guide.setAttribute('x1', zx); guide.setAttribute('x2', zx); guide.setAttribute('opacity', '0.4'); }
          zone.setAttribute('fill', 'var(--text3)'); zone.setAttribute('opacity', '0.06');
          var tip = '';
          tip += '<div style="font-weight:700;font-size:0.85rem;margin-bottom:4px;color:var(--text);">' + d.month + (d.is_current ? ' (current)' : d.is_past ? '' : ' (future)') + '</div>';
          if (d.actual != null && d.actual > 0) tip += '<div style="color:var(--accent);">\u25CF Actual: <strong>' + window._projFmtFull(d.actual) + '</strong></div>';
          if (d.booked != null && d.booked > 0) tip += '<div style="color:#60a5fa;">\u25CB Booked: <strong>' + window._projFmtFull(d.booked) + '</strong></div>';
          if (d.target != null && d.target > 0) tip += '<div style="color:#f59e0b;">\u25CC Target: <strong>' + window._projFmtFull(d.target) + '</strong></div>';
          if (d.target && d.actual != null && d.actual > 0) {
            var diff = d.actual - d.target;
            var pct = Math.round(diff / d.target * 100);
            tip += '<div style="margin-top:3px;font-size:0.72rem;color:' + (diff >= 0 ? 'var(--accent)' : 'var(--danger)') + ';">' + (diff >= 0 ? '\u2191' : '\u2193') + ' ' + Math.abs(pct) + '% ' + (diff >= 0 ? 'above' : 'below') + ' target</div>';
          } else if (d.target && d.booked != null && d.booked > 0 && !d.is_past) {
            var bDiff = d.booked - d.target;
            var bPct = Math.round(bDiff / d.target * 100);
            tip += '<div style="margin-top:3px;font-size:0.72rem;color:' + (bDiff >= 0 ? 'var(--accent)' : '#f59e0b') + ';">' + (bDiff >= 0 ? '\u2191 ' + bPct + '% of target booked' : Math.abs(bPct) + '% gap to fill') + '</div>';
          }
          wrap.innerHTML = tip;
          wrap.style.display = '';
        });
        zone.addEventListener('mousemove', function(e) {
          var rect = container.getBoundingClientRect();
          var x = e.clientX - rect.left + 12;
          var y = e.clientY - rect.top - 10;
          if (x + 180 > rect.width) x = x - 190;
          wrap.style.left = x + 'px';
          wrap.style.top = y + 'px';
        });
        zone.addEventListener('mouseleave', function() {
          wrap.style.display = 'none';
          var guide = document.getElementById(window._projId + '_guide');
          if (guide) guide.setAttribute('opacity', '0');
          zone.setAttribute('fill', 'transparent'); zone.setAttribute('opacity', '1');
        });
      });
    }, 100);

    // Summary row
    var ytdActual = 0, ytdTarget = 0, totalBooked = 0;
    var curMonthNum = new Date().getMonth() + 1;
    proj.forEach(function(p) {
      if (p.actual != null) ytdActual += p.actual;
      if (p.target != null) ytdTarget += p.target;
      if (p.booked != null && p.booked > 0 && !p.is_past) totalBooked += p.booked;
    });
    h += '<div style="display:flex;gap:16px;font-size:0.75rem;color:var(--text3);margin-top:8px;flex-wrap:wrap;">';
    if (ytdActual > 0) h += '<span>YTD actual: <strong style="color:var(--accent);">$' + ytdActual.toLocaleString() + '</strong></span>';
    if (totalBooked > 0) h += '<span>Forward booked: <strong style="color:#60a5fa;">$' + totalBooked.toLocaleString() + '</strong></span>';
    if (ytdTarget > 0) {
      var proRataTarget = Math.round(ytdTarget * curMonthNum / 12);
      var pctOfTarget = proRataTarget > 0 ? Math.round(ytdActual / proRataTarget * 100) : 0;
      h += '<span>Annual target: <strong style="color:#f59e0b;">$' + ytdTarget.toLocaleString() + '</strong></span>';
      h += '<span>Pace: <strong style="color:' + (pctOfTarget >= 90 ? 'var(--accent)' : pctOfTarget >= 70 ? '#f59e0b' : 'var(--danger)') + ';">' + pctOfTarget + '% of target</strong></span>';
    }
    h += '</div>';
    h += '</div>';
  }

  // ── ROW 2: Action Items ────────────────────────────────────────────────
  var actions = d.actions || [];
  // Store action data globally so onclick handlers can reference property_ids
  window._dashActions = actions;
  window._dashDiscoveries = d.discoveries || [];
  if (actions.length > 0) {
    var MAX_VISIBLE = 5;
    var hasMore = actions.length > MAX_VISIBLE;
    h += '<div class="card" style="margin-bottom:16px;padding:12px 16px;border-left:4px solid #f59e0b;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:#f0b840;display:flex;align-items:center;gap:6px;">' + _ico('zap', 16, '#f0b840') + ' ACTION ITEMS <span style="font-weight:400;color:var(--text3);">(' + actions.length + ')</span></div>';
    if (hasMore) h += '<button class="btn btn-xs" style="font-size:0.65rem;padding:2px 8px;" onclick="toggleActionItems()" id="actionToggleBtn">Show all ' + actions.length + '</button>';
    h += '</div>';
    actions.forEach(function(a, idx) {
      var borderColor = a.type === 'danger' ? 'var(--danger)' : a.type === 'warning' ? '#f59e0b' : 'var(--accent)';
      var hasProps = a.property_ids && a.property_ids.length > 0;
      var propCount = hasProps ? a.property_ids.length : 0;
      var hidden = hasMore && idx >= MAX_VISIBLE ? ' style="display:none;"' : '';
      h += '<div class="dash-action-item" data-aidx="' + idx + '"' + (hasMore && idx >= MAX_VISIBLE ? ' style="display:none;"' : '') + '>';
      h += '<div onclick="handleDashAction(' + idx + ')" style="display:flex;align-items:center;gap:10px;padding:8px 10px;margin-bottom:4px;border-radius:6px;cursor:pointer;border-left:3px solid ' + borderColor + ';background:var(--surface2);transition:background 0.15s;" onmouseenter="this.style.background=\'var(--bg)\'" onmouseleave="this.style.background=\'var(--surface2)\'">';
      h += '<span style="flex-shrink:0;opacity:0.85;">' + _ico(a.icon || 'alert', 18, borderColor) + '</span>';
      h += '<div style="flex:1;min-width:0;">';
      h += '<span style="font-size:0.82rem;color:var(--text);">' + esc(a.text) + '</span>';
      // Show which properties are affected as clickable chips
      var propLabels = a.property_labels || [];
      if (hasProps && propCount <= 5) {
        h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">';
        a.property_ids.forEach(function(pid, pidx) {
          var chipLabel = (propLabels[pidx] && propLabels[pidx].label) ? propLabels[pidx].label : 'Property #' + pid;
          if (chipLabel.length > 30) chipLabel = chipLabel.substring(0, 28) + '..';
          h += '<span onclick="event.stopPropagation();openProperty(' + pid + ',\'' + (a.target_tab || 'details') + '\')" style="font-size:0.65rem;padding:1px 6px;border-radius:3px;background:var(--bg);color:var(--accent);cursor:pointer;border:1px solid var(--border);white-space:nowrap;" onmouseenter="this.style.background=\'var(--accent)\';this.style.color=\'#fff\'" onmouseleave="this.style.background=\'var(--bg)\';this.style.color=\'var(--accent)\'" title="Open ' + esc(chipLabel) + '">' + esc(chipLabel) + '</span>';
        });
        h += '</div>';
      } else if (hasProps) {
        h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:2px;">Click to open first property · ' + propCount + ' total affected</div>';
      }
      h += '</div>';
      // Add "Analyze All" button for no-analysis action items
      if (a.icon === 'pieChart' && a.text && a.text.includes('no pricing analysis')) {
        h += '<button class="btn btn-xs" style="margin-left:8px;flex-shrink:0;font-size:0.68rem;padding:3px 10px;background:var(--accent);color:#fff;border-color:var(--accent);" onclick="event.stopPropagation();runBulkAnalysis()">' + _ico('zap', 12, '#fff') + ' Analyze All</button>';
      } else {
        h += '<span style="margin-left:auto;flex-shrink:0;opacity:0.6;">' + _ico('chevronRight', 14, 'var(--accent)') + '</span>';
      }
      h += '</div></div>';
    });
    h += '</div>';
  }

  // ── Setup Prompts — things that need manual action ────────────────────
  var sys = d.system_health || {};
  var setupItems = [];
  if (sys.markets_needing_enrichment > 0) {
    setupItems.push({ icon: 'globe', color: '#60a5fa', text: sys.markets_needing_enrichment + ' market' + (sys.markets_needing_enrichment > 1 ? 's' : '') + ' need AI enrichment for demographics', action: 'switchView(\'market\')', btn: 'Go to Markets' });
  }
  if (sys.unanalyzed_properties > 0) {
    setupItems.push({ icon: 'pieChart', color: 'var(--accent)', text: sys.unanalyzed_properties + ' propert' + (sys.unanalyzed_properties > 1 ? 'ies' : 'y') + ' need pricing analysis', action: 'runBulkAnalysis()', btn: 'Analyze All' });
  }
  if (setupItems.length > 0) {
    h += '<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;">';
    setupItems.forEach(function(item) {
      h += '<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;border-left:3px solid ' + item.color + ';">';
      h += '<span>' + _ico(item.icon, 16, item.color) + '</span>';
      h += '<span style="flex:1;font-size:0.78rem;color:var(--text);">' + item.text + '</span>';
      h += '<button class="btn btn-xs" style="flex-shrink:0;background:' + item.color + ';color:#fff;border-color:' + item.color + ';font-size:0.68rem;padding:3px 10px;" onclick="' + item.action + '">' + item.btn + '</button>';
      h += '</div>';
    });
    h += '</div>';
  }

  // ── Problem Properties Overview ──────────────────────────────────────────
  var problems = d.problem_properties || [];
  if (problems.length > 0) {
    h += '<div class="card" style="margin-bottom:16px;padding:12px 16px;border-left:4px solid var(--danger);">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
    var hs = d.health_summary || {};
    h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--danger);display:flex;align-items:center;gap:6px;">' + _ico('alertCircle', 16, 'var(--danger)') + ' PROPERTY HEALTH</div>';
    h += '<div style="display:flex;gap:8px;font-size:0.72rem;">';
    if (hs.red > 0) h += '<span style="color:var(--danger);font-weight:600;">' + _ico('alertCircle', 12, 'var(--danger)') + ' ' + hs.red + ' Act Now</span>';
    if (hs.yellow > 0) h += '<span style="color:#f0b840;font-weight:600;">' + _ico('eye', 12, '#f0b840') + ' ' + hs.yellow + ' Watch</span>';
    if (hs.green > 0) h += '<span style="color:var(--accent);">' + _ico('check', 12, 'var(--accent)') + ' ' + hs.green + ' Healthy</span>';
    h += '</div></div>';
    h += '<span style="font-size:0.68rem;color:var(--text3);">' + problems.length + ' issue' + (problems.length > 1 ? 's' : '') + '</span>';
    h += '</div>';

    // Group by issue type for a nice header
    var issueGroups = {};
    problems.forEach(function(p) { if (!issueGroups[p.issue]) issueGroups[p.issue] = []; issueGroups[p.issue].push(p); });

    var issueLabels = {
      health_critical: { svg: _ico('alertCircle', 14, 'var(--danger)'), label: 'Act Now', color: 'var(--danger)' },
      health_watch: { svg: _ico('eye', 14, '#f0b840'), label: 'Watch', color: '#f0b840' },
      low_occupancy: { svg: _ico('trendDown', 14, '#f0b840'), label: 'Low Occupancy', color: '#f0b840' },
      price_discrepancy: { svg: _ico('alertCircle', 14, 'var(--danger)'), label: 'Pricing Discrepancies', color: 'var(--danger)' },
      no_analysis: { svg: _ico('pieChart', 14, 'var(--accent)'), label: 'No Pricing Analysis', color: 'var(--accent)' },
      stale_analysis: { svg: _ico('refresh', 14, '#f0b840'), label: 'Stale Analysis (30+ days)', color: '#f0b840' },
    };

    var issueOrder = ['health_critical', 'price_discrepancy', 'health_watch', 'no_analysis'];
    issueOrder.forEach(function(issueKey) {
      var group = issueGroups[issueKey];
      if (!group || group.length === 0) return;
      var info = issueLabels[issueKey] || { svg: _ico('alert', 14), label: issueKey, color: 'var(--text3)' };

      h += '<div style="margin-bottom:10px;">';
      h += '<div style="font-size:0.7rem;font-weight:600;color:' + info.color + ';margin-bottom:4px;display:flex;align-items:center;gap:5px;">' + info.svg + ' ' + info.label + ' <span style="font-weight:400;color:var(--text3);">(' + group.length + ')</span>';
      if (issueKey === 'no_analysis') h += '<button class="btn btn-xs" style="margin-left:auto;font-size:0.62rem;padding:2px 8px;" onclick="runBulkAnalysis()">' + _ico('zap', 11, 'var(--accent)') + ' Analyze All</button>';
      h += '</div>';
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px;">';

      group.forEach(function(p) {
        var sevBorder = p.severity === 'danger' ? 'var(--danger)' : p.severity === 'warning' ? '#f59e0b' : 'var(--accent)';
        var sevBg = p.severity === 'danger' ? 'rgba(239,68,68,0.04)' : p.severity === 'warning' ? 'rgba(245,158,11,0.04)' : 'var(--surface2)';
        h += '<div onclick="openProperty(' + p.id + ',\'' + (p.target_tab || 'details') + '\')" style="padding:10px 12px;border-radius:8px;cursor:pointer;background:' + sevBg + ';border-left:3px solid ' + sevBorder + ';transition:background 0.15s;" onmouseenter="this.style.background=\'var(--bg)\'" onmouseleave="this.style.background=\'' + sevBg + '\'">';
        // Property name + location
        h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
        h += '<div style="font-size:0.8rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%;" title="' + esc(p.name || '') + '">' + esc((p.name || 'Property').substring(0, 24)) + '</div>';
        if (p.score !== undefined) h += '<span style="font-size:0.62rem;padding:1px 6px;border-radius:3px;font-weight:600;background:' + sevBorder + ';color:#fff;">' + p.score + '/100</span>';
        h += '</div>';
        // City + beds
        var meta = [];
        if (p.city) meta.push(p.city);
        if (p.beds) meta.push(p.beds + 'BR');
        if (meta.length > 0) h += '<div style="font-size:0.68rem;color:var(--text3);margin-bottom:6px;">' + esc(meta.join(' · ')) + '</div>';
        // Issue pills — split detail into separate items
        var details = (p.detail || '').split(' · ').filter(Boolean);
        if (details.length > 0) {
          h += '<div style="display:flex;flex-wrap:wrap;gap:3px;">';
          details.slice(0, 3).forEach(function(d) {
            var pillColor = d.includes('losing') || d.includes('0%') ? 'rgba(239,68,68,0.12)' : d.includes('occ') ? 'rgba(245,158,11,0.12)' : 'rgba(96,165,250,0.12)';
            var pillText = d.includes('losing') || d.includes('0%') ? 'var(--danger)' : d.includes('occ') ? '#f0b840' : 'var(--text2)';
            h += '<span style="font-size:0.62rem;padding:2px 6px;border-radius:3px;background:' + pillColor + ';color:' + pillText + ';white-space:nowrap;">' + esc(d) + '</span>';
          });
          if (details.length > 3) h += '<span style="font-size:0.62rem;color:var(--text3);">+' + (details.length - 3) + '</span>';
          h += '</div>';
        }
        h += '</div>';
      });

      h += '</div></div>';
    });

    h += '</div>';
  }

  // ── Discoveries — proactive insights & improvement suggestions ────────
  var discoveries = d.discoveries || [];
  if (discoveries.length > 0) {
    var MAX_DISC = 4;
    var hasMoreDisc = discoveries.length > MAX_DISC;
    h += '<div class="card" style="margin-bottom:16px;padding:12px 16px;border-left:4px solid var(--purple);">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:var(--purple);display:flex;align-items:center;gap:6px;">' + _ico('lightbulb', 16, 'var(--purple)') + ' DISCOVERIES & IMPROVEMENTS <span style="font-weight:400;color:var(--text3);">(' + discoveries.length + ')</span></div>';
    if (hasMoreDisc) h += '<button class="btn btn-xs" style="font-size:0.65rem;padding:2px 8px;" onclick="toggleDiscoveries()" id="discToggleBtn">Show all ' + discoveries.length + '</button>';
    h += '</div>';
    discoveries.forEach(function(disc, idx) {
      var typeColors = { opportunity: 'var(--accent)', improve: 'var(--purple)', setup: '#60a5fa' };
      var typeLabels = { opportunity: 'Opportunity', improve: 'Improve', setup: 'Setup' };
      var borderColor = typeColors[disc.type] || 'var(--purple)';
      var typeLabel = typeLabels[disc.type] || 'Insight';
      var hasProps = disc.property_ids && disc.property_ids.length > 0;
      h += '<div class="dash-disc-item"' + (hasMoreDisc && idx >= MAX_DISC ? ' style="display:none;"' : '') + '>';
      h += '<div onclick="handleDashAction_disc(' + idx + ')" style="display:flex;align-items:center;gap:10px;padding:7px 10px;margin-bottom:3px;border-radius:6px;cursor:pointer;border-left:3px solid ' + borderColor + ';background:var(--surface2);transition:background 0.15s;" onmouseenter="this.style.background=\'var(--bg)\'" onmouseleave="this.style.background=\'var(--surface2)\'">';
      h += '<span style="flex-shrink:0;opacity:0.85;">' + _ico(disc.icon || 'lightbulb', 16, borderColor) + '</span>';
      h += '<div style="flex:1;min-width:0;">';
      h += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:2px;">';
      h += '<span style="font-size:0.58rem;padding:1px 5px;border-radius:3px;background:' + borderColor + ';color:#fff;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;">' + typeLabel + '</span>';
      h += '</div>';
      h += '<span style="font-size:0.78rem;color:var(--text);">' + esc(disc.text) + '</span>';
      if (hasProps && disc.property_labels) {
        h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;">';
        disc.property_ids.forEach(function(pid, pidx) {
          var chipLabel = (disc.property_labels[pidx] && disc.property_labels[pidx].label) ? disc.property_labels[pidx].label : 'Property';
          if (chipLabel.length > 30) chipLabel = chipLabel.substring(0, 28) + '..';
          h += '<span onclick="event.stopPropagation();openProperty(' + pid + ',\'' + (disc.target_tab || 'details') + '\')" style="font-size:0.62rem;padding:1px 6px;border-radius:3px;background:var(--bg);color:var(--purple);cursor:pointer;border:1px solid var(--border);white-space:nowrap;" onmouseenter="this.style.background=\'var(--purple)\';this.style.color=\'#fff\'" onmouseleave="this.style.background=\'var(--bg)\';this.style.color=\'var(--purple)\'">' + esc(chipLabel) + '</span>';
        });
        h += '</div>';
      }
      h += '</div>';
      h += '<span style="margin-left:auto;flex-shrink:0;opacity:0.6;">' + _ico('chevronRight', 14, borderColor) + '</span>';
      h += '</div></div>';
    });
    h += '</div>';
  }

  // ── ROW 3: Two-column — Upcoming / Pricing Alerts ─────────────────────
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:16px;">';

  // Left: Upcoming check-ins/outs
  h += '<div class="card" style="padding:12px 16px;max-height:320px;overflow-y:auto;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;position:sticky;top:0;background:var(--card);padding-bottom:4px;">';
  h += '<span style="font-size:0.78rem;font-weight:600;color:var(--text2);">' + _ico('calendar', 14) + ' UPCOMING (14 DAYS)</span>';
  h += '<span style="font-size:0.68rem;color:var(--text3);">' + (d.upcoming_checkins || []).length + ' check-ins</span>';
  h += '</div>';
  var checkins = d.upcoming_checkins || [];
  if (checkins.length === 0) {
    h += '<div style="color:var(--text3);font-size:0.82rem;padding:8px 0;">No upcoming check-ins</div>';
  } else {
    checkins.slice(0, 6).forEach(function(b) {
      var propLabel = b.unit_number ? b.unit_number + ' — ' + (b.address || '') : (b.address || b.prop_name || 'Property');
      h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:0.78rem;">';
      h += '<div>';
      h += '<div style="font-weight:600;color:var(--text);">' + esc(b.guest_name || 'Guest') + '</div>';
      h += '<div style="font-size:0.68rem;color:var(--text3);">' + esc(propLabel).substring(0, 35) + '</div>';
      h += '</div>';
      h += '<div style="text-align:right;">';
      h += '<div style="font-family:DM Mono,monospace;color:var(--accent);font-size:0.75rem;">' + fmtUTC(b.check_in).substring(0, 6) + '</div>';
      h += '<div style="font-size:0.65rem;color:var(--text3);">' + (b.nights || 0) + 'nt · ' + esc(b.channel || 'Direct') + '</div>';
      h += '</div>';
      h += '</div>';
    });
    if (checkins.length > 6) h += '<div style="font-size:0.72rem;color:var(--text3);text-align:center;padding-top:6px;">+' + (checkins.length - 6) + ' more</div>';
  }
  h += '</div>';

  // Right: Pricing discrepancies
  h += '<div class="card" style="padding:12px 16px;max-height:320px;overflow-y:auto;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;position:sticky;top:0;background:var(--card);padding-bottom:4px;">';
  h += '<span style="font-size:0.78rem;font-weight:600;color:var(--text2);">' + _ico('alertCircle', 14) + ' PRICING ALERTS</span>';
  var discCount = (d.price_discrepancies || []).length;
  h += '<span style="font-size:0.68rem;color:' + (discCount > 0 ? 'var(--danger)' : 'var(--text3)') + ';">' + discCount + ' discrepancies</span>';
  h += '</div>';
  var discs = d.price_discrepancies || [];
  if (discs.length === 0) {
    h += '<div style="color:var(--text3);font-size:0.82rem;padding:8px 0;">No pricing discrepancies — Guesty and PriceLabs are aligned ' + _ico('check', 13, 'var(--accent)') + '</div>';
  } else {
    discs.slice(0, 6).forEach(function(disc) {
      var diffColor = Math.abs(disc.price_discrepancy) > 25 ? 'var(--danger)' : '#f59e0b';
      h += '<div onclick="openProperty(' + disc.property_id + ',\'calendar\')" style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);font-size:0.78rem;cursor:pointer;" title="Click to open property calendar">';
      h += '<div>';
      h += '<div style="font-weight:600;color:var(--text);">' + esc((disc.listing_name || '').substring(0, 30)) + '</div>';
      h += '<div style="font-size:0.68rem;color:var(--text3);">' + esc(disc.date) + '</div>';
      h += '</div>';
      h += '<div style="text-align:right;">';
      h += '<div style="font-family:DM Mono,monospace;color:' + diffColor + ';font-weight:600;">' + (disc.price_discrepancy > 0 ? '+' : '') + '$' + disc.price_discrepancy + '</div>';
      h += '<div style="font-size:0.62rem;color:var(--text3);">G $' + Math.round(disc.guesty_price) + ' vs P $' + Math.round(disc.pl_recommended_price) + '</div>';
      h += '</div>';
      h += '</div>';
    });
  }
  h += '</div>';
  h += '</div>';

  // ── ROW 4: Two-column — Channel Mix / Top Properties ──────────────────
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:16px;">';

  // Left: Channel breakdown
  h += '<div class="card" style="padding:12px 16px;">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:10px;">' + _ico('pieChart', 14) + ' CHANNEL PERFORMANCE</div>';
  var channels = d.channels || [];
  if (channels.length === 0) {
    h += '<div style="color:var(--text3);font-size:0.82rem;padding:8px 0;">No channel data. <a href="#" onclick="event.preventDefault();switchView(\'intel\');switchIntelTab(\'channels\')" style="color:var(--accent);">Build intelligence →</a></div>';
  } else {
    var maxRev = Math.max.apply(null, channels.map(function(c) { return c.revenue || 0; }));
    channels.forEach(function(c) {
      var pct = maxRev > 0 ? Math.round((c.revenue || 0) / maxRev * 100) : 0;
      var channelColor = (c.channel || '').match(/airbnb/i) ? '#ff5a5f' : (c.channel || '').match(/vrbo|homeaway/i) ? '#3b5998' : (c.channel || '').match(/booking/i) ? '#003580' : (c.channel || '').match(/direct/i) ? '#10b981' : '#a78bfa';
      h += '<div style="margin-bottom:8px;">';
      h += '<div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:2px;">';
      h += '<span style="font-weight:600;color:var(--text);">' + esc(c.channel || 'Unknown') + '</span>';
      h += '<span style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(c.revenue || 0).toLocaleString() + ' · ' + (c.bookings || 0) + ' bookings</span>';
      h += '</div>';
      h += '<div style="height:6px;background:var(--bg);border-radius:3px;"><div style="height:100%;width:' + pct + '%;background:' + channelColor + ';border-radius:3px;transition:width 0.3s;"></div></div>';
      h += '</div>';
    });
    h += '<div style="font-size:0.68rem;color:var(--text3);text-align:right;"><a href="#" onclick="event.preventDefault();switchView(\'intel\');switchIntelTab(\'channels\')" style="color:var(--accent);">Full details →</a></div>';
  }
  h += '</div>';

  // Right: Top properties
  h += '<div class="card" style="padding:12px 16px;">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:10px;">' + _ico('trendUp', 14) + ' TOP PROPERTIES (YTD)</div>';
  var topProps = d.top_properties || [];
  if (topProps.length === 0) {
    h += '<div style="color:var(--text3);font-size:0.82rem;padding:8px 0;">No revenue data yet</div>';
  } else {
    topProps.slice(0, 6).forEach(function(p) {
      var propLabel = p.unit_number ? p.unit_number + ' — ' + (p.address || '') : (p.address || 'Property');
      var ytdOcc = (p.ytd_avail || 0) > 0 ? Math.round((p.ytd_nights || 0) / p.ytd_avail * 100) : 0;
      h += '<div onclick="openProperty(' + p.id + ')" style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);cursor:pointer;font-size:0.78rem;">';
      h += '<div style="max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">';
      h += '<span style="font-weight:600;color:var(--text);" title="' + esc(propLabel) + '">' + esc(propLabel).substring(0, 30) + '</span>';
      h += '<span style="font-size:0.65rem;color:var(--text3);margin-left:6px;">' + esc(p.city || '') + '</span>';
      h += '</div>';
      h += '<div style="display:flex;gap:10px;align-items:center;">';
      h += '<span style="font-size:0.68rem;color:' + (ytdOcc >= 60 ? 'var(--accent)' : '#f59e0b') + ';">' + ytdOcc + '%</span>';
      h += '<span style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">$' + Math.round(p.ytd_rev || 0).toLocaleString() + '</span>';
      h += '</div>';
      h += '</div>';
    });
    h += '<div style="font-size:0.68rem;color:var(--text3);text-align:right;padding-top:6px;"><a href="#" onclick="event.preventDefault();switchView(\'finances\')" style="color:var(--accent);">Full P&L →</a></div>';
  }
  h += '</div>';
  h += '</div>';

  // ── ROW 5: Integration Status ──────────────────────────────────────────
  var intg = d.integrations || {};
  h += '<div class="card" style="padding:12px 16px;margin-bottom:16px;">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:10px;">' + _ico('link', 14) + ' INTEGRATION STATUS</div>';
  h += '<div style="display:flex;gap:16px;flex-wrap:wrap;">';

  // Guesty
  var gStatus = intg.guesty || {};
  var gColor = gStatus.error ? 'var(--danger)' : gStatus.connected ? 'var(--accent)' : 'var(--text3)';
  h += '<div onclick="switchView(\'pms\');showPmsDetail(\'guesty\')" style="flex:1;min-width:180px;padding:10px;border-radius:8px;background:var(--surface2);cursor:pointer;border-left:3px solid ' + gColor + ';">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
  h += '<span style="font-weight:600;font-size:0.85rem;">' + _ico('building', 15) + ' Guesty</span>';
  h += '<span style="font-size:0.68rem;color:' + gColor + ';">' + (gStatus.error ? '✗ Error' : gStatus.connected ? '● Connected' : '○ Not set up') + '</span>';
  h += '</div>';
  if (gStatus.last_sync) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">Last sync: ' + fmtUTC(gStatus.last_sync) + '</div>';
  if (gStatus.listings > 0) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">' + gStatus.listings + ' listings' + (gStatus.linked > 0 ? ' · ' + gStatus.linked + ' linked' : '') + '</div>';
  if (gStatus.error) h += '<div style="font-size:0.68rem;color:var(--danger);margin-top:2px;">' + esc(gStatus.error).substring(0, 50) + '</div>';
  h += '</div>';

  // PriceLabs
  var plSt = intg.pricelabs || {};
  var plColor = plSt.connected ? 'var(--accent)' : 'var(--text3)';
  h += '<div onclick="switchView(\'pms\');showPmsDetail(\'pricelabs\')" style="flex:1;min-width:180px;padding:10px;border-radius:8px;background:var(--surface2);cursor:pointer;border-left:3px solid ' + plColor + ';">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
  h += '<span style="font-weight:600;font-size:0.85rem;">' + _ico('barChart', 15) + ' PriceLabs</span>';
  h += '<span style="font-size:0.68rem;color:' + plColor + ';">' + (plSt.connected ? '● Connected' : '○ Not set up') + '</span>';
  h += '</div>';
  if (plSt.listings > 0) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">' + plSt.listings + ' listings' + (plSt.linked > 0 ? ' · ' + plSt.linked + ' linked' : '') + '</div>';
  if (plSt.last_sync) h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">Last sync: ' + fmtUTC(plSt.last_sync) + '</div>';
  h += '</div>';

  h += '</div>';

  // Recent syncs
  var syncs = intg.recent_syncs || [];
  if (syncs.length > 0) {
    h += '<div style="margin-top:10px;font-size:0.72rem;color:var(--text3);">';
    h += '<div style="font-weight:600;margin-bottom:4px;">Recent activity:</div>';
    syncs.slice(0, 3).forEach(function(s) {
      var sColor = s.status === 'completed' ? 'var(--accent)' : s.status === 'failed' ? 'var(--danger)' : 'var(--text3)';
      h += '<div style="display:flex;gap:8px;padding:2px 0;">';
      h += '<span style="color:' + sColor + ';">' + (s.status === 'completed' ? '✓' : s.status === 'failed' ? '✗' : '' + _ico('clock', 13) + '') + '</span>';
      h += '<span>' + esc(s.sync_type) + ' (' + esc(s.source) + ')</span>';
      if (s.records_processed > 0) h += '<span>' + s.records_processed + ' records</span>';
      if (s.completed_at) h += '<span style="margin-left:auto;">' + fmtUTC(s.completed_at) + '</span>';
      h += '</div>';
    });
    h += '</div>';
  }
  h += '</div>';

  // ── System Health Bar ─────────────────────────────────────────────────
  if (sys.last_cron || sys.last_market_crawl) {
    h += '<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;padding:10px 14px;background:var(--card);border:1px solid var(--border);border-radius:10px;font-size:0.72rem;align-items:center;">';
    h += '<span style="font-weight:600;color:var(--text3);display:flex;align-items:center;gap:4px;">' + _ico('activity', 13, 'var(--accent)') + ' System</span>';
    if (sys.last_cron) {
      var cronAge = Math.round((Date.now() - new Date(sys.last_cron + 'Z').getTime()) / 3600000);
      var cronColor = cronAge < 8 ? 'var(--accent)' : cronAge < 25 ? 'var(--text2)' : 'var(--danger)';
      h += '<span style="color:' + cronColor + ';">' + _ico('clock', 12, cronColor) + ' Cron: ' + (cronAge < 1 ? '<1hr ago' : cronAge + 'hr ago') + (sys.last_cron_status === 'error' ? ' ✗' : '') + '</span>';
    }
    if (sys.last_market_crawl) {
      var crawlAge = Math.round((Date.now() - new Date(sys.last_market_crawl + 'Z').getTime()) / 86400000);
      h += '<span style="color:var(--text2);">' + _ico('radar', 12) + ' Crawl: ' + (crawlAge < 1 ? 'Today' : crawlAge + 'd ago') + ' (' + (sys.last_crawl_markets || 0) + ' markets)</span>';
    }
    if (sys.last_intel_rebuild) {
      var intelAge = Math.round((Date.now() - new Date(sys.last_intel_rebuild + 'Z').getTime()) / 86400000);
      h += '<span style="color:var(--text2);">' + _ico('sparkle', 12) + ' Intel: ' + (intelAge < 1 ? 'Today' : intelAge + 'd ago') + '</span>';
    }
    if (sys.last_auto_analysis) {
      var aaAge = Math.round((Date.now() - new Date(sys.last_auto_analysis + 'Z').getTime()) / 86400000);
      h += '<span style="color:var(--text2);">' + _ico('zap', 12) + ' Auto-analysis: ' + (aaAge < 1 ? 'Today' : aaAge + 'd ago') + (sys.last_auto_analysis_count > 0 ? ' (' + sys.last_auto_analysis_count + ')' : '') + '</span>';
    }
    if (sys.master_listings_active > 0) {
      h += '<span style="color:var(--text3);">' + _ico('database', 12) + ' ' + sys.master_listings_active + ' listings</span>';
    }
    h += '</div>';

  }

  // ── ROW 7: API & AI Services ───────────────────────────────────────────
  var apiCosts = d.api_costs || {};
  var apiKeys = d.api_keys || {};
  var hasAnyApi = Object.keys(apiCosts).length > 0 || Object.keys(apiKeys).length > 0;
  if (hasAnyApi) {
    h += '<div class="card" style="padding:12px 16px;margin-bottom:16px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">';
    h += '<span style="font-size:0.78rem;font-weight:600;color:var(--text2);">' + _ico('cpu', 14) + ' API & AI SERVICES</span>';
    // Total monthly cost
    var totalApiCost = 0;
    Object.values(apiCosts).forEach(function(s) { totalApiCost += (s.cost_cents || 0); });
    if (totalApiCost > 0) h += '<span style="font-size:0.72rem;font-family:DM Mono,monospace;color:var(--accent);">$' + (totalApiCost / 100).toFixed(2) + ' this month</span>';
    h += '</div>';

    h += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
    // Key services to show
    var svcDisplay = [
      { key: 'ANTHROPIC_API_KEY', name: 'Anthropic', iconName: 'sparkle', costKey: 'anthropic' },
      { key: 'OPENAI_API_KEY', name: 'OpenAI', iconName: 'cpu', costKey: 'openai' },
      { key: 'WORKERS_AI', name: 'Workers AI', iconName: 'zap', costKey: 'workers_ai' },
      { key: 'PRICELABS_API_KEY', name: 'PriceLabs', iconName: 'barChart', costKey: 'pricelabs_fixed' },
      { key: 'GUESTY_CLIENT_ID', name: 'Guesty', iconName: 'building', costKey: 'guesty' },
      { key: 'RENTCAST_API_KEY', name: 'RentCast', iconName: 'home', costKey: 'rentcast' },
      { key: 'GOOGLE_PLACES_API_KEY', name: 'Places', iconName: 'mapPin', costKey: 'google_places' },
      { key: 'SEARCHAPI_KEY', name: 'SearchAPI', iconName: 'search', costKey: 'searchapi' },
    ];
    svcDisplay.forEach(function(svc) {
      var configured = apiKeys[svc.key];
      var usage = apiCosts[svc.costKey] || {};
      var calls = usage.calls || 0;
      var cost = usage.cost_cents || 0;
      var overLimit = usage.over_limit;
      var budgetPct = usage.budget_pct || 0;
      var dotColor = !configured ? 'var(--text3)' : overLimit ? 'var(--danger)' : 'var(--accent)';
      var bgColor = overLimit ? 'rgba(239,68,68,0.06)' : 'var(--surface2)';

      h += '<div style="padding:6px 10px;border-radius:6px;background:' + bgColor + ';border:1px solid var(--border);font-size:0.72rem;min-width:90px;">';
      h += '<div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;">';
      h += '<span style="width:6px;height:6px;border-radius:50%;background:' + dotColor + ';flex-shrink:0;"></span>';
      h += '<span style="font-weight:600;color:var(--text);">' + _ico(svc.iconName || 'cpu', 13) + ' ' + svc.name + '</span>';
      h += '</div>';
      if (configured && calls > 0) {
        h += '<div style="color:var(--text3);">' + calls + ' calls';
        if (cost > 0) h += ' · $' + (cost / 100).toFixed(2);
        h += '</div>';
        if (budgetPct > 0) {
          var barColor = budgetPct >= 90 ? 'var(--danger)' : budgetPct >= 60 ? '#f59e0b' : 'var(--accent)';
          h += '<div style="height:3px;background:var(--bg);border-radius:2px;margin-top:3px;"><div style="height:100%;width:' + Math.min(budgetPct, 100) + '%;background:' + barColor + ';border-radius:2px;"></div></div>';
        }
        if (usage.free_limit) h += '<div style="color:var(--text3);font-size:0.65rem;">' + (usage.remaining || 0) + '/' + usage.free_limit + ' remaining</div>';
      } else if (configured) {
        h += '<div style="color:var(--text3);">Ready</div>';
      } else {
        h += '<div style="color:var(--text3);">Not configured</div>';
      }
      h += '</div>';
    });
    h += '</div>';
    h += '<div style="margin-top:6px;text-align:right;font-size:0.68rem;"><a href="#" onclick="event.preventDefault();switchView(\'settings\')" style="color:var(--accent);">Manage API keys →</a></div>';
    h += '</div>';
  }

  // ── Smart Portfolio Refresh ────────────────────────────────────────────
  h += '<div class="card" style="margin-bottom:16px;padding:14px 16px;border-left:4px solid #60a5fa;">';
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:#60a5fa;display:flex;align-items:center;gap:6px;">' + _ico('refresh', 16, '#60a5fa') + ' DATA FRESHNESS</div>';
  h += '<button class="btn btn-xs btn-primary" onclick="btnGuard(this);loadRefreshPanel()" id="btnRefreshPanel">' + _ico('activity', 12) + ' Check & Update</button>';
  h += '</div>';
  h += '<div style="font-size:0.72rem;color:var(--text3);">Shows what\'s fresh, what\'s stale, and lets you update selectively. Free updates auto-selected when stale.</div>';
  h += '<div id="refreshPanel" style="display:none;margin-top:10px;"></div>';
  h += '</div>';

  el.innerHTML = h;
}

function _dashKpi(label, value, sub, color, tooltip) {
  return '<div title="' + esc(tooltip || '') + '" style="padding:14px 16px;background:var(--card);border:1px solid var(--border);border-radius:10px;cursor:help;">' +
    '<div style="font-size:0.65rem;font-weight:600;color:var(--text3);text-transform:uppercase;letter-spacing:0.03em;margin-bottom:6px;">' + esc(label) + '</div>' +
    '<div style="font-size:1.35rem;font-weight:700;color:' + (color || 'var(--text)') + ';font-family:DM Mono,monospace;line-height:1.2;">' + value + '</div>' +
    (sub ? '<div style="font-size:0.68rem;color:var(--text3);margin-top:3px;">' + esc(sub) + '</div>' : '') +
    '</div>';
}

// ── Dashboard Action Item Deep-Link Handler ─────────────────────────────────
function handleDashAction(idx) {
  var actions = window._dashActions || [];
  var a = actions[idx];
  if (!a) return;

  var actionType = a.action || '';
  var propIds = a.property_ids || [];
  var targetTab = a.target_tab || 'details';

  // Type 1: Open a specific property (with tab)
  if (actionType === 'dashAction_openProperty' && propIds.length > 0) {
    // Open the first affected property directly to the right tab
    openProperty(propIds[0], targetTab);
    return;
  }

  // Type 2: Rebuild intelligence
  if (actionType === 'dashAction_rebuildIntel') {
    switchView('intel');
    switchIntelTab('guests');
    // Auto-trigger rebuild after a short delay for the view to render
    setTimeout(function() {
      var rebuildBtn = document.querySelector('#intelTab-guests button[onclick*="rebuildIntelligence"], #intelTab-guests .btn');
      if (rebuildBtn) rebuildBtn.click();
      else toast('Navigate to Intel → Guests and click Rebuild', 'info');
    }, 400);
    return;
  }

  // Type 3: Legacy inline JS action strings (for actions that still use switchView directly)
  if (actionType && actionType.indexOf('switchView') === 0) {
    try { eval(actionType); } catch (e) { console.error('Action failed:', e); }
    return;
  }

  // Fallback: try to eval the action string
  if (actionType) {
    try { eval(actionType); } catch (e) { console.error('Action failed:', e); }
  }
}

// ── Bulk Pricing Analysis — analyze all unanalyzed properties ──────────────
function toggleActionItems() {
  var items = document.querySelectorAll('.dash-action-item');
  var btn = document.getElementById('actionToggleBtn');
  var expanded = btn && btn.dataset.expanded === '1';
  items.forEach(function(el) {
    var idx = parseInt(el.dataset.aidx || 0);
    if (idx >= 5) el.style.display = expanded ? 'none' : '';
  });
  if (btn) {
    btn.dataset.expanded = expanded ? '0' : '1';
    btn.textContent = expanded ? 'Show all ' + items.length : 'Show less';
  }
}

function toggleDiscoveries() {
  var items = document.querySelectorAll('.dash-disc-item');
  var btn = document.getElementById('discToggleBtn');
  var expanded = btn && btn.dataset.expanded === '1';
  items.forEach(function(el, idx) {
    if (idx >= 4) el.style.display = expanded ? 'none' : '';
  });
  if (btn) {
    btn.dataset.expanded = expanded ? '0' : '1';
    btn.textContent = expanded ? 'Show all ' + items.length : 'Show less';
  }
}

function handleDashAction_disc(idx) {
  var discoveries = (window._dashDiscoveries || []);
  var disc = discoveries[idx];
  if (!disc) return;
  if (disc.action === 'dashAction_openProperty' && disc.property_ids && disc.property_ids.length > 0) {
    openProperty(disc.property_ids[0], disc.target_tab || 'details');
  }
}

async function runBulkAnalysis() {
  if (!confirm('Run AI pricing analysis on all unanalyzed properties? This uses API credits.')) return;
  var btn = event.target;
  btn.disabled = true;
  btn.innerHTML = _ico('refresh', 11) + ' Running...';
  toast('Starting bulk pricing analysis...', 'info');
  try {
    var d = await api('/api/analyze/bulk', 'POST', { analysis_type: 'str', quality: 'standard', max: 10 });
    if (d.analyzed > 0) {
      toast(d.message, 'success');
    } else {
      toast(d.message || 'No properties to analyze', 'info');
    }
    // Refresh dashboard to update action items and problem properties
    setTimeout(loadDashboard, 1000);
  } catch (err) {
    toast('Bulk analysis failed: ' + err.message, 'error');
  }
  btn.disabled = false;
  btn.innerHTML = _ico('zap', 11, 'var(--accent)') + ' Analyze All';
}

// ── Smart Portfolio Refresh ────────────────────────────────────────────────

var _refreshSteps = null;

async function loadRefreshPanel() {
  var el = document.getElementById('refreshPanel');
  if (!el) return;
  el.style.display = '';
  el.innerHTML = '<div style="color:var(--text3);font-size:0.78rem;">Checking data freshness...</div>';

  try {
    var d = await api('/api/portfolio/full-refresh', 'POST', { dry_run: true });
    _refreshSteps = d.steps || [];
    var intg = d.integrations || {};
    var budget = d.searchapi_budget || {};
    var summary = d.summary || {};

    var h = '';

    // Integration status bar
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;font-size:0.72rem;">';
    h += '<span style="color:' + (intg.guesty ? 'var(--accent)' : 'var(--danger)') + ';">' + _ico(intg.guesty ? 'check' : 'x', 11) + ' Guesty</span>';
    h += '<span style="color:' + (intg.pricelabs ? 'var(--accent)' : 'var(--danger)') + ';">' + _ico(intg.pricelabs ? 'check' : 'x', 11) + ' PriceLabs</span>';
    h += '<span style="color:' + (intg.searchapi ? 'var(--accent)' : 'var(--text3)') + ';">' + _ico(intg.searchapi ? 'check' : 'x', 11) + ' SearchAPI (' + budget.remaining + '/' + budget.limit + ' calls left)</span>';
    h += '</div>';

    // Group steps
    var groups = { sync: { label: 'DATA SYNC', icon: 'refresh', color: '#60a5fa' }, compute: { label: 'REBUILD & COMPUTE', icon: 'cpu', color: 'var(--purple)' }, crawl: { label: 'MARKET RESEARCH', icon: 'radar', color: '#f59e0b' }, maintenance: { label: 'MAINTENANCE', icon: 'trash', color: 'var(--text3)' } };

    for (var gKey in groups) {
      var grp = groups[gKey];
      var grpSteps = _refreshSteps.filter(function(s) { return s.group === gKey; });
      if (grpSteps.length === 0) continue;

      h += '<div style="margin-bottom:10px;">';
      h += '<div style="font-size:0.65rem;font-weight:700;color:' + grp.color + ';text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">' + _ico(grp.icon, 11, grp.color) + ' ' + grp.label + '</div>';

      grpSteps.forEach(function(s) {
        var freshColor = s.status === 'fresh' ? 'var(--accent)' : s.status === 'aging' ? '#f59e0b' : s.status === 'unavailable' ? 'var(--text3)' : 'var(--danger)';
        var freshLabel = s.status === 'fresh' ? 'Fresh' : s.status === 'aging' ? 'Aging' : s.status === 'unavailable' ? 'N/A' : 'Stale';
        var timeLabel = s.hours_ago !== null ? (s.hours_ago < 1 ? '<1h ago' : s.hours_ago < 24 ? s.hours_ago + 'h ago' : Math.round(s.hours_ago / 24) + 'd ago') : 'Never synced';
        var costBadge = s.cost === 'paid' ? '<span style="font-size:0.58rem;background:rgba(245,158,11,0.15);color:#f59e0b;padding:1px 5px;border-radius:3px;font-weight:700;">~' + (s.searchapi_est || '?') + ' API calls</span>' : '<span style="font-size:0.58rem;color:var(--text3);">Free</span>';
        var isDisabled = !s.available;
        var isChecked = s.selected;

        h += '<label style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:var(--bg);border:1px solid var(--border);border-radius:5px;margin-bottom:3px;cursor:' + (isDisabled ? 'not-allowed' : 'pointer') + ';opacity:' + (isDisabled ? '0.5' : '1') + ';" onmouseenter="this.style.background=\'var(--surface2)\'" onmouseleave="this.style.background=\'var(--bg)\'">';

        h += '<input type="checkbox" data-step-id="' + s.id + '" ' + (isChecked ? 'checked' : '') + ' ' + (isDisabled ? 'disabled' : '') + ' onchange="updateRefreshCost()" style="accent-color:var(--accent);flex-shrink:0;">';

        // Freshness bar
        h += '<div style="width:4px;height:28px;border-radius:2px;background:' + freshColor + ';flex-shrink:0;opacity:0.7;"></div>';

        h += '<div style="flex:1;min-width:0;">';
        h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        h += '<span style="font-size:0.75rem;font-weight:600;color:var(--text);">' + esc(s.name) + '</span>';
        h += '<span style="font-size:0.62rem;color:' + freshColor + ';font-weight:700;">' + freshLabel + ' · ' + timeLabel + '</span>';
        h += '</div>';
        h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:1px;">';
        h += '<span style="font-size:0.65rem;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70%;">' + esc(s.benefit) + '</span>';
        h += costBadge;
        h += '</div>';
        if (!s.available) h += '<div style="font-size:0.6rem;color:var(--danger);">' + _ico('x', 10, 'var(--danger)') + ' ' + esc(s.skip_reason) + '</div>';
        h += '</div></label>';
      });
      h += '</div>';
    }

    // Cost summary + action bar
    h += '<div id="refreshCostBar" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;margin-top:6px;">';
    h += '<div id="refreshCostSummary" style="font-size:0.72rem;color:var(--text2);"></div>';
    h += '<div style="display:flex;gap:6px;">';
    h += '<button class="btn btn-xs" onclick="selectAllRefresh(true)">Select stale</button>';
    h += '<button class="btn btn-xs" onclick="selectAllRefresh(false)">Clear all</button>';
    h += '<button class="btn btn-xs btn-primary" onclick="btnGuard(this);runSmartRefresh(this)" id="btnRunRefresh">' + _ico('refresh', 12) + ' Update Selected</button>';
    h += '</div></div>';

    // Cron info
    h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:6px;">' + _ico('clock', 10, 'var(--text3)') + ' Auto-sync runs daily at 6am ET (Guesty every 6h, listings weekly Monday). SearchAPI crawls are always manual.</div>';

    // Progress area
    h += '<div id="refreshRunLog" style="display:none;margin-top:10px;"></div>';

    el.innerHTML = h;
    updateRefreshCost();
  } catch (err) {
    el.innerHTML = '<div style="color:var(--danger);font-size:0.78rem;">Error: ' + esc(err.message) + '</div>';
  }
}

function updateRefreshCost() {
  var el = document.getElementById('refreshCostSummary');
  if (!el || !_refreshSteps) return;
  var checks = document.querySelectorAll('[data-step-id]');
  var selected = 0, freeCount = 0, paidCount = 0, apiCalls = 0;
  checks.forEach(function(cb) {
    if (cb.checked) {
      selected++;
      var step = _refreshSteps.find(function(s) { return s.id === cb.dataset.stepId; });
      if (step) {
        if (step.cost === 'paid') { paidCount++; apiCalls += (step.searchapi_est || 0); }
        else freeCount++;
      }
    }
  });
  var parts = [];
  parts.push(selected + ' selected');
  if (freeCount > 0) parts.push(freeCount + ' free');
  if (paidCount > 0) parts.push(paidCount + ' paid (~' + apiCalls + ' API calls)');
  el.innerHTML = parts.join(' · ');
  var btn = document.getElementById('btnRunRefresh');
  if (btn) btn.disabled = selected === 0;
}

function selectAllRefresh(staleOnly) {
  var checks = document.querySelectorAll('[data-step-id]');
  checks.forEach(function(cb) {
    if (cb.disabled) return;
    if (staleOnly) {
      var step = _refreshSteps.find(function(s) { return s.id === cb.dataset.stepId; });
      cb.checked = step && step.recommended;
    } else {
      cb.checked = false;
    }
  });
  updateRefreshCost();
}

async function runSmartRefresh(btn) {
  var checks = document.querySelectorAll('[data-step-id]');
  var selected = [];
  checks.forEach(function(cb) { if (cb.checked) selected.push(cb.dataset.stepId); });
  if (selected.length === 0) { toast('No steps selected'); return; }

  var logEl = document.getElementById('refreshRunLog');
  if (logEl) {
    logEl.style.display = '';
    logEl.innerHTML = '<div style="padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;">' +
      '<div style="font-size:0.78rem;font-weight:600;color:#60a5fa;margin-bottom:4px;">' + _ico('activity', 14, '#60a5fa') + ' Running ' + selected.length + ' updates...</div>' +
      '<div style="font-size:0.72rem;color:var(--text3);">This may take a few minutes.</div></div>';
  }
  if (btn) { btn.disabled = true; btn.innerHTML = _ico('refresh', 12) + ' Running...'; }

  try {
    var d = await api('/api/portfolio/full-refresh', 'POST', { steps: selected });
    var log = d.log || [];
    var h = '';

    log.forEach(function(entry) {
      var icon = entry.status === 'ok' ? _ico('check', 11, 'var(--accent)')
        : entry.status === 'skipped' ? _ico('minus', 11, 'var(--text3)')
        : entry.status === 'warn' ? _ico('alertTriangle', 11, '#f59e0b')
        : _ico('x', 11, 'var(--danger)');
      var color = entry.status === 'ok' ? 'var(--accent)' : entry.status === 'error' ? 'var(--danger)' : 'var(--text3)';
      var time = entry.ms > 0 ? ' (' + (entry.ms / 1000).toFixed(1) + 's)' : '';
      h += '<div style="display:flex;align-items:flex-start;gap:6px;padding:2px 0;font-size:0.72rem;">';
      h += '<span style="flex-shrink:0;margin-top:1px;">' + icon + '</span>';
      h += '<span style="font-weight:600;min-width:130px;color:' + color + ';">' + esc(entry.name || entry.step) + '</span>';
      h += '<span style="color:var(--text2);">' + esc(entry.detail || entry.reason || '') + time + '</span>';
      h += '</div>';
    });

    var totalSec = Math.round((d.total_ms || 0) / 1000);
    var okCount = d.steps_completed || 0;
    var errCount = d.steps_errored || 0;
    var sc = errCount > 0 ? 'var(--danger)' : 'var(--accent)';
    h += '<div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;font-weight:600;font-size:0.75rem;color:' + sc + ';">';
    h += _ico(errCount > 0 ? 'alertTriangle' : 'check', 13, sc) + ' Done in ' + totalSec + 's — ' + okCount + ' completed' + (errCount > 0 ? ', ' + errCount + ' errors' : '');
    h += '</div>';

    if (logEl) logEl.innerHTML = '<div style="padding:10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;font-family:DM Mono,monospace;">' + h + '</div>';
    toast('Refresh complete — ' + okCount + ' steps in ' + totalSec + 's');
    setTimeout(function() { loadDashboard(); }, 2500);
  } catch (err) {
    if (logEl) logEl.innerHTML = '<div style="padding:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;color:var(--danger);font-size:0.78rem;">' + _ico('x', 14, 'var(--danger)') + ' Failed: ' + esc(err.message) + '</div>';
    toast('Refresh failed: ' + err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.innerHTML = _ico('refresh', 12) + ' Update Selected'; }
}
