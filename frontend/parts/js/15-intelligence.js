// Intelligence Dashboard — Guest, Market, Channel analytics

async function loadIntelligenceDashboard() {
  loadGuestIntelligence();
  loadMarketIntelligencePanel();
  loadChannelIntelligencePanel();
}

// ── GUEST INTELLIGENCE ────────────────────────────────────────────────────
var _guestPeriod = 'all';

async function loadGuestIntelligence(period) {
  var el = document.getElementById('guestIntelContent');
  if (!el) return;
  if (period !== undefined) _guestPeriod = period;
  try {
    var d = await api('/api/intelligence/guests?period=' + _guestPeriod);
    var h = '';

    // ── Timeframe filter bar ──
    var periods = [['all','All Time'],['ytd','YTD'],['12mo','12 Mo'],['6mo','6 Mo'],['3mo','3 Mo'],['month','This Month']];
    h += '<div style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">';
    h += '<span style="font-size:0.72rem;color:var(--text3);margin-right:4px;">Period:</span>';
    periods.forEach(function(pr) {
      var active = _guestPeriod === pr[0];
      h += '<button onclick="loadGuestIntelligence(\'' + pr[0] + '\')" class="btn btn-xs" style="font-size:0.7rem;padding:3px 10px;' + (active ? 'background:var(--accent);color:#000;font-weight:700;' : '') + '">' + pr[1] + '</button>';
    });
    // Show data range
    if (d.data_range && d.data_range.earliest) {
      h += '<span style="margin-left:auto;font-size:0.68rem;color:var(--text3);">' + _ico('calendar', 13) + ' ' + esc(d.data_range.earliest) + ' → ' + esc(d.data_range.latest || 'now') + '</span>';
    }
    h += '</div>';

    var periodTag = d.period_label ? ' <span style="font-size:0.62rem;font-weight:400;color:var(--text3);">(' + esc(d.period_label) + ')</span>' : '';

    // Check if API returned an error
    if (d.error) {
      el.innerHTML = h + '<div style="padding:16px;color:var(--danger);font-size:0.82rem;">API Error: ' + esc(d.error) + '</div>';
      return;
    }

    // Show partial query errors if any
    if (d._errors && d._errors.length > 0) {
      h += '<div style="padding:8px 12px;margin-bottom:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:6px;font-size:0.72rem;color:var(--danger);">' + _ico('alertCircle', 13, '#f59e0b') + ' Partial data — some queries failed: ' + d._errors.map(function(e) { return esc(e); }).join(' · ') + '</div>';
    }

    // Check if we actually have meaningful data — use multiple signals
    var guestTotal = (d.returning_rate && d.returning_rate.total) || 0;
    var staysTotal = d.total_stays || 0;
    var topGuestCount = (d.top_guests || []).length;
    var hasData = guestTotal > 0 || staysTotal > 0 || topGuestCount > 0;

    // Detect "data exists but guest profiles not linked" state
    var needsRebuild = staysTotal > 0 && guestTotal === 0 && topGuestCount === 0;
    if (needsRebuild) {
      h += '<div style="padding:12px 16px;margin-bottom:14px;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.25);border-radius:8px;display:flex;align-items:center;gap:12px;">';
      h += '<span style="font-size:1.3rem;">' + _ico('alertCircle', 13, '#f59e0b') + '</span>';
      h += '<div style="flex:1;font-size:0.8rem;">';
      h += '<div style="font-weight:700;color:#f59e0b;margin-bottom:2px;">Guest profiles need rebuilding</div>';
      h += '<div style="color:var(--text2);">' + staysTotal + ' reservations found with $' + (d.total_revenue || 0).toLocaleString() + ' revenue, but guest profiles aren\'t linked yet. Click <strong>Rebuild All</strong> to create guest profiles and enable returning guest tracking, top guests, and origin analytics.</div>';
      h += '</div>';
      h += '<button class="btn btn-sm btn-primary" onclick="runIntelRebuild()" style="flex-shrink:0;">' + _ico('refresh', 13) + ' Rebuild Now</button>';
      h += '</div>';
    }

    if (!hasData) {
      // Fetch debug info to show what's going on
      var debugInfo = '';
      try {
        var dbg = await api('/api/intelligence/debug');
        debugInfo = '<div style="margin-top:16px;padding:12px;background:var(--surface2);border-radius:8px;text-align:left;font-size:0.75rem;color:var(--text2);line-height:1.6;">';
        debugInfo += '<div style="font-weight:600;margin-bottom:6px;color:var(--text);">' + _ico('search', 13) + ' Diagnostics</div>';
        debugInfo += '<div>Reservations in database: <strong>' + (dbg.total_reservations || 0) + '</strong></div>';
        debugInfo += '<div>With guest name: <strong>' + (dbg.with_guest_name || 0) + '</strong> · Without: ' + (dbg.without_guest_name || 0) + '</div>';
        debugInfo += '<div>Excluded (canceled/declined): <strong>' + (dbg.excluded_by_status || 0) + '</strong></div>';
        debugInfo += '<div>Eligible for intelligence: <strong style="color:var(--accent);">' + (dbg.eligible_for_intel || 0) + '</strong></div>';
        if (dbg.by_status && dbg.by_status.length > 0) {
          debugInfo += '<div style="margin-top:4px;">Statuses: ' + dbg.by_status.map(function(s) { return esc(s.status) + ' (' + s.c + ')'; }).join(' · ') + '</div>';
        }
        if (dbg.by_source && dbg.by_source.length > 0) {
          debugInfo += '<div>Sources: ' + dbg.by_source.map(function(s) { return esc(s.source) + ' (' + s.c + ')'; }).join(' · ') + '</div>';
        }
        debugInfo += '<div>Guest profiles: ' + (dbg.guest_profiles || 0) + ' · Stays: ' + (dbg.guest_stays || 0) + '</div>';
        if (dbg.eligible_for_intel > 0) {
          debugInfo += '<div style="margin-top:6px;color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' You have ' + dbg.eligible_for_intel + ' eligible reservations. Click <strong>Build Intelligence</strong> to process them.</div>';
        } else if (dbg.total_reservations > 0 && dbg.with_guest_name === 0) {
          debugInfo += '<div style="margin-top:6px;color:var(--danger);">' + _ico('alertCircle', 13, '#f59e0b') + ' Reservations exist but none have guest names. Check your CSV column mapping or Guesty API sync.</div>';
        } else if (dbg.total_reservations === 0) {
          debugInfo += '<div style="margin-top:6px;color:var(--text3);">No reservations found. Sync from your PMS or upload a reservation CSV.</div>';
        }
        debugInfo += '</div>';
      } catch {}

      el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:0.85rem;">' +
        '<div style="font-size:1.5rem;margin-bottom:8px;">' + _ico('users', 13) + '</div>' +
        '<div style="margin-bottom:6px;">No guest intelligence data yet.</div>' +
        '<div style="font-size:0.78rem;margin-bottom:12px;">Guest intelligence is built from reservation data from any connected platform:</div>' +
        '<div style="text-align:left;display:inline-block;font-size:0.78rem;line-height:1.8;">' +
        '1. Connect a PMS (Guesty, Hostaway, etc.) in <a href="#" onclick="event.preventDefault();switchView(\'pms\')" style="color:var(--accent);">Integrations</a> or upload a CSV<br>' +
        '2. Sync reservations — make sure they include guest names<br>' +
        '3. Click <strong>Build Intelligence</strong> to process reservation data into guest profiles</div>' +
        '<div style="margin-top:14px;display:flex;gap:8px;justify-content:center;">' +
        '<button class="btn btn-sm btn-primary" onclick="runIntelRebuild()">Build Intelligence</button>' +
        '</div>' +
        debugInfo +
        '</div>';
      return;
    }

    // Summary cards — with period labels
    h += '<div class="market-grid" style="margin-bottom:14px;">';
    h += '<div class="market-stat"><div class="val" style="color:var(--accent);">' + (d.returning_rate.pct || 0) + '%</div><div class="lbl">Returning Guests' + periodTag + '</div></div>';
    h += '<div class="market-stat"><div class="val">' + (d.returning_rate.total || 0) + '</div><div class="lbl">Total Guests' + periodTag + '</div></div>';
    h += '<div class="market-stat"><div class="val">' + (d.total_stays || 0) + '</div><div class="lbl">Total Stays' + periodTag + '</div></div>';
    h += '<div class="market-stat"><div class="val" style="color:var(--accent);">$' + (d.total_revenue || 0).toLocaleString() + '</div><div class="lbl">Revenue' + periodTag + '</div></div>';
    h += '<div class="market-stat"><div class="val">' + (d.avg_group_size || 0) + '</div><div class="lbl">Avg Group Size' + periodTag + '</div></div>';
    h += '<div class="market-stat"><div class="val">' + (d.max_group_size || 0) + '</div><div class="lbl">Max Group</div></div>';
    var petStats = d.pet_stats || {};
    h += '<div class="market-stat"><div class="val" style="color:#f59e0b;">' + (petStats.total_pet_bookings || 0) + '</div><div class="lbl">' + _ico('paw', 13) + ' Pet Bookings' + periodTag + '</div></div>';
    if (petStats.pet_fee_revenue > 0) h += '<div class="market-stat"><div class="val" style="color:var(--accent);">$' + Math.round(petStats.pet_fee_revenue).toLocaleString() + '</div><div class="lbl">' + _ico('paw', 13) + ' Pet Fee Revenue' + periodTag + '</div></div>';
    if (petStats.pet_booking_revenue > 0) h += '<div class="market-stat"><div class="val" style="color:var(--text2);">$' + Math.round(petStats.pet_booking_revenue).toLocaleString() + '</div><div class="lbl">' + _ico('paw', 13) + ' Total w/ Pets' + periodTag + '</div></div>';
    h += '</div>';

    // Pet debug — help diagnose when 0
    if ((petStats.total_pet_bookings || 0) === 0) {
      h += '<div style="margin-bottom:10px;padding:8px 12px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);border-radius:6px;font-size:0.72rem;color:var(--text2);">';
      h += '' + _ico('paw', 13) + ' <strong>No pet bookings found.</strong> ';
      h += 'The pet fee is configured on your listing, but no guests have added pets to their reservations yet. ';
      h += '<a href="#" onclick="event.preventDefault();debugGuestyPets()" style="color:var(--accent);">Deep scan API →</a>';
      h += ' · <a href="#" onclick="event.preventDefault();debugPetDbStatus()" style="color:var(--accent);">Check DB status →</a>';
      h += '</div>';
    }

    // Data sources (platform breakdown)
    if (d.platforms && d.platforms.length > 0) {
      h += '<div style="margin-bottom:14px;display:flex;gap:6px;flex-wrap:wrap;font-size:0.72rem;">';
      h += '<span style="color:var(--text3);">Data from:</span>';
      d.platforms.forEach(function(p) {
        var pColor = p.platform === 'guesty' ? '#60a5fa' : p.platform === 'direct' ? '#10b981' : p.platform === 'csv_import' ? '#f59e0b' : '#a78bfa';
        h += '<span style="padding:2px 8px;border-radius:4px;background:' + pColor + '15;color:' + pColor + ';border:1px solid ' + pColor + '30;">';
        h += esc(p.platform) + ' · ' + p.stays + ' stays · ' + p.guests + ' guests';
        if (p.revenue > 0) h += ' · $' + Math.round(p.revenue).toLocaleString();
        h += '</span>';
      });
      h += '</div>';
    }

    // Demand segments
    if (d.demand_segments && d.demand_segments.length > 0) {
      var segLabels = {
        vacation_str: { name: '' + _ico('home', 13) + ' Vacation STR', color: '#10b981' },
        weekend_getaway: { name: '' + _ico('sparkle', 13, '#60a5fa') + ' Weekend Getaway', color: '#60a5fa' },
        short_vacation: { name: '' + _ico('globe', 13, '#34d399') + ' Short Vacation', color: '#34d399' },
        extended_vacation: { name: '' + _ico('calendar', 13, '#6ee7b7') + ' Extended Vacation', color: '#6ee7b7' },
        corporate: { name: '' + _ico('briefcase', 13) + ' Corporate', color: '#a78bfa' },
        travel_nurse: { name: '' + _ico('heart', 13, '#f472b6') + ' Travel Nurse', color: '#f472b6' },
        insurance: { name: '' + _ico('shield', 13, '#fb923c') + ' Insurance/Displaced', color: '#fb923c' },
        relocation: { name: '' + _ico('package', 13) + ' Relocation', color: '#fbbf24' },
        midterm_family: { name: '' + _ico('users', 13, '#38bdf8') + ' Midterm Family', color: '#38bdf8' },
        long_term: { name:'' + _ico('home', 13) + ' Long-Term', color: '#818cf8' }
      };
      var totalSegRev = 0;
      d.demand_segments.forEach(function(s) { totalSegRev += (s.revenue || 0); });

      h += '<div style="margin-bottom:14px;">';
      h += '<div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:8px;">DEMAND SEGMENTS</div>';
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">';
      d.demand_segments.forEach(function(s) {
        var info = segLabels[s.demand_segment] || { name: s.demand_segment, color: 'var(--text2)' };
        var revPct = totalSegRev > 0 ? Math.round((s.revenue || 0) / totalSegRev * 100) : 0;
        h += '<div style="padding:10px 12px;background:var(--surface2);border-left:3px solid ' + info.color + ';border-radius:6px;">';
        h += '<div style="font-size:0.78rem;font-weight:700;color:' + info.color + ';">' + info.name + '</div>';
        h += '<div style="display:flex;justify-content:space-between;margin-top:4px;font-size:0.72rem;">';
        h += '<span style="color:var(--text3);">' + s.count + ' booking' + (s.count !== 1 ? 's' : '') + '</span>';
        h += '<span style="font-family:DM Mono,monospace;font-weight:600;">$' + Math.round(s.revenue || 0).toLocaleString() + '</span>';
        h += '</div>';
        h += '<div style="display:flex;justify-content:space-between;margin-top:2px;font-size:0.65rem;color:var(--text3);">';
        h += '<span>' + Math.round(s.avg_nights || 0) + ' avg nights</span>';
        h += '<span>' + revPct + '% of revenue</span>';
        h += '</div>';
        h += '<div style="height:3px;background:var(--bg);border-radius:2px;margin-top:4px;"><div style="height:100%;width:' + revPct + '%;background:' + info.color + ';border-radius:2px;"></div></div>';
        h += '</div>';
      });
      h += '</div></div>';
    }

    // Stay length distribution
    if (d.stay_distribution && d.stay_distribution.length > 0) {
      h += '<div style="margin-bottom:14px;">';
      h += '<div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px;">STAY LENGTH DISTRIBUTION</div>';
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
      d.stay_distribution.forEach(function(s) {
        var maxCount = Math.max.apply(null, d.stay_distribution.map(function(x) { return x.count; }));
        var pct = maxCount > 0 ? Math.round(s.count / maxCount * 100) : 0;
        h += '<div style="flex:1;min-width:100px;padding:8px;background:var(--surface2);border-radius:6px;text-align:center;">';
        h += '<div style="font-size:0.85rem;font-weight:700;color:var(--accent);">' + s.count + '</div>';
        h += '<div style="font-size:0.65rem;color:var(--text3);">' + esc(s.bucket) + '</div>';
        h += '<div style="font-size:0.65rem;color:var(--text3);">$' + Math.round(s.avg_rev || 0).toLocaleString() + ' avg</div>';
        h += '<div style="height:4px;background:var(--bg);border-radius:2px;margin-top:4px;"><div style="height:100%;width:' + pct + '%;background:var(--accent);border-radius:2px;"></div></div>';
        h += '</div>';
      });
      h += '</div></div>';
    }

    // Guest origins
    if (d.origins && d.origins.length > 0) {
      h += '<div style="margin-bottom:14px;">';
      h += '<div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px;">GUEST ORIGINS</div>';
      h += '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
      d.origins.forEach(function(o) {
        h += '<span style="padding:3px 8px;background:var(--surface2);border-radius:4px;font-size:0.72rem;">' + esc(o.origin) + ' <strong>' + o.count + '</strong>' + (o.revenue ? ' · $' + Math.round(o.revenue).toLocaleString() : '') + '</span>';
      });
      h += '</div></div>';
    }

    // Top guests table
    if (d.top_guests && d.top_guests.length > 0) {
      h += '<div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px;">TOP GUESTS BY REVENUE</div>';
      h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.75rem;"><thead><tr>';
      h += '<th>Guest</th><th>Stays</th><th>Revenue</th><th>Avg Stay</th><th>Properties</th><th>Channel</th><th>' + _ico('paw', 13) + '</th>';
      h += '</tr></thead><tbody>';
      d.top_guests.slice(0, 15).forEach(function(g) {
        h += '<tr><td style="font-weight:600;">' + esc(g.full_name || '—') + (g.is_returning ? ' <span style="color:var(--accent);font-size:0.65rem;">↩</span>' : '') + '</td>';
        h += '<td>' + (g.stay_count || g.total_stays || 0) + '</td>';
        h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(g.total_rev || g.total_revenue || 0).toLocaleString() + '</td>';
        h += '<td>' + (g.avg_nights || g.avg_stay_nights || 0) + ' nights</td>';
        // Properties stayed at
        h += '<td style="font-size:0.68rem;max-width:200px;">';
        if (g.properties_stayed) {
          var propList = g.properties_stayed.split(' | ');
          h += propList.map(function(p) {
            return '<span style="display:inline-block;padding:1px 5px;margin:1px;background:var(--surface2);border-radius:3px;white-space:nowrap;" title="' + esc(p) + '">' + esc(p.length > 25 ? p.substring(0, 25) + '…' : p) + '</span>';
          }).join('');
        } else {
          h += '<span style="color:var(--text3);">—</span>';
        }
        h += '</td>';
        h += '<td>' + esc(g.preferred_channel || '—') + '</td>';
        h += '<td>' + (g.has_pets ? '' + _ico('paw', 13) + '' : '') + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }

    if (!d.top_guests || d.top_guests.length === 0) {
      if (needsRebuild) {
        h += '<div style="padding:16px;text-align:center;color:var(--text3);font-size:0.82rem;">' + _ico('arrowRight', 13) + ' Click <strong>Rebuild Now</strong> above to generate guest profiles and top guest rankings.</div>';
      } else {
        h += '<div style="padding:16px;text-align:center;color:var(--text3);font-size:0.82rem;">No guest data yet. <button class="btn btn-xs btn-primary" onclick="runIntelRebuild()">Build Intelligence</button></div>';
      }
    }

    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">' + esc(err.message) + '</span>'; }
}

// ── MARKET INTELLIGENCE ───────────────────────────────────────────────────
async function loadMarketIntelligencePanel() {
  var el = document.getElementById('marketIntelContent');
  if (!el) return;
  try {
    var d = await api('/api/intelligence/market');
    var h = '';

    if (d.markets && d.markets.length > 0) {
      h += '<div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px;">YOUR MARKET BENCHMARKS</div>';
      h += '<div style="font-size:0.65rem;color:var(--text3);margin-bottom:8px;">Based on actual performance data from your portfolio. Used by AI for pricing recommendations and acquisition analysis.</div>';

      // Group metrics by market
      var byMarket = {};
      (d.metrics || []).forEach(function(m) {
        var key = m.city + ', ' + m.state;
        if (!byMarket[key]) byMarket[key] = {};
        var subKey = (m.property_type || 'all') + '|' + (m.bedrooms || 0);
        if (!byMarket[key][subKey]) byMarket[key][subKey] = { type: m.property_type, beds: m.bedrooms, metrics: {} };
        byMarket[key][subKey].metrics[m.metric_key] = m.metric_value;
      });

      for (var market in byMarket) {
        h += '<div style="margin-bottom:12px;padding:10px;background:var(--surface2);border-radius:8px;">';
        h += '<div style="font-size:0.82rem;font-weight:600;color:#60a5fa;margin-bottom:6px;">' + _ico('mapPin', 13) + ' ' + esc(market) + '</div>';
        h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.72rem;"><thead><tr>';
        h += '<th>Type</th><th>BR</th><th>Occ%</th><th>ADR</th><th>Monthly Rev</th><th>Monthly Payout</th><th>Data Points</th>';
        h += '</tr></thead><tbody>';
        for (var subKey in byMarket[market]) {
          var s = byMarket[market][subKey];
          var m = s.metrics;
          h += '<tr><td>' + esc(s.type || 'all') + '</td>';
          h += '<td>' + (s.beds || '—') + '</td>';
          h += '<td style="font-weight:600;color:' + ((m.avg_occupancy_pct || 0) >= 50 ? 'var(--accent)' : '#f59e0b') + ';">' + (m.avg_occupancy_pct || 0) + '%</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + (m.avg_adr || 0) + '</td>';
          h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + (m.avg_monthly_revenue || 0).toLocaleString() + '</td>';
          h += '<td style="font-family:DM Mono,monospace;">$' + (m.avg_monthly_payout || 0).toLocaleString() + '</td>';
          h += '<td>' + (m.total_months_data || 0) + ' months</td></tr>';
        }
        h += '</tbody></table></div></div>';
      }
    }

    if (!d.metrics || d.metrics.length === 0) {
      h += '<div style="padding:16px;text-align:center;color:var(--text3);font-size:0.82rem;">No market data yet. Import Guesty data and <button class="btn btn-xs btn-primary" onclick="runIntelRebuild()">Build Intelligence</button></div>';
    }

    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">' + esc(err.message) + '</span>'; }
}

// ── CHANNEL INTELLIGENCE ──────────────────────────────────────────────────
async function loadChannelIntelligencePanel() {
  var el = document.getElementById('channelIntelContent');
  if (!el) return;
  try {
    var d = await api('/api/intelligence/channels');
    var h = '';

    // Portfolio-wide channel summary
    if (d.portfolio && d.portfolio.length > 0) {
      h += '<div style="font-size:0.75rem;font-weight:600;color:var(--text2);margin-bottom:6px;">CHANNEL PERFORMANCE (Portfolio-wide)</div>';
      h += '<div style="overflow-x:auto;"><table class="comp-table" style="font-size:0.75rem;"><thead><tr>';
      h += '<th>Channel</th><th>Bookings</th><th>Revenue</th><th>Payout</th><th>Avg ADR</th><th>Avg Stay</th><th>Cancels</th><th>' + _ico('paw', 13) + ' Pets</th>';
      h += '</tr></thead><tbody>';
      d.portfolio.forEach(function(c) {
        h += '<tr><td style="font-weight:600;">' + esc(c.channel) + '</td>';
        h += '<td>' + (c.reservations || 0) + '</td>';
        h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + Math.round(c.revenue || 0).toLocaleString() + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(c.payout || 0).toLocaleString() + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">$' + Math.round(c.avg_adr || 0) + '</td>';
        h += '<td>' + (c.avg_nights || 0) + ' nights</td>';
        h += '<td style="color:' + ((c.cancellations || 0) > 0 ? 'var(--danger)' : 'var(--text3)') + ';">' + (c.cancellations || 0) + '</td>';
        h += '<td>' + (c.pet_bookings || 0) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }

    if (!d.portfolio || d.portfolio.length === 0) {
      h += '<div style="padding:16px;text-align:center;color:var(--text3);font-size:0.82rem;">No channel data yet. <button class="btn btn-xs btn-primary" onclick="runIntelRebuild()">Build Intelligence</button></div>';
    }

    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<span style="color:var(--danger);font-size:0.78rem;">' + esc(err.message) + '</span>'; }
}

async function runIntelRebuild() {
  showLoading('Building intelligence from your data...');
  try {
    var d = await api('/api/intelligence/rebuild', 'POST', { sections: ['guests', 'market', 'channels'] });
    toast(d.message || 'Intelligence rebuilt');
    // Refresh whichever intel sub-tab is currently visible
    if (typeof _currentIntelTab !== 'undefined') {
      loadIntelSubTabContent(_currentIntelTab);
    } else {
      loadGuestIntelligence();
      loadMarketIntelligencePanel();
      loadChannelIntelligencePanel();
    }
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
  hideLoading();
}

async function debugGuestyPets() {
  showLoading('Checking Guesty API for pet fields...');
  try {
    var d = await api('/api/guesty/debug-reservation');
    hideLoading();
    var msg = '<div style="padding:12px;background:var(--surface2);border-radius:8px;font-size:0.75rem;line-height:1.6;max-height:70vh;overflow-y:auto;">';
    msg += '<div style="font-weight:700;margin-bottom:6px;font-size:0.88rem;">' + _ico('search', 13) + ' Guesty Pet Field Deep Scan</div>';
    if (d.error) {
      msg += '<div style="color:var(--danger);">Error: ' + esc(d.error) + '</div>';
    } else {
      msg += '<div>Guest: <strong>' + esc(d.guest_name || '—') + '</strong> · Code: ' + esc(d.confirmation_code || '—') + ' · Total reservations: ' + (d.total_reservations || 0) + '</div>';

      // DIAGNOSIS — big bold result
      msg += '<div style="margin-top:10px;padding:12px;border-radius:8px;font-size:0.82rem;font-weight:600;';
      if ((d.diagnosis || '').startsWith('PET DATA FOUND')) {
        msg += 'background:rgba(16,185,129,0.1);border:2px solid rgba(16,185,129,0.3);color:var(--accent);">';
        msg += '' + _ico('check', 13, 'var(--accent)') + ' ' + esc(d.diagnosis);
      } else if ((d.diagnosis || '').startsWith('PET POLICY ON LISTING')) {
        msg += 'background:rgba(245,158,11,0.1);border:2px solid rgba(245,158,11,0.3);color:#f59e0b;">';
        msg +='' + _ico('alertTriangle', 13, '#f59e0b') + ' ' + esc(d.diagnosis);
      } else {
        msg += 'background:rgba(239,68,68,0.08);border:2px solid rgba(239,68,68,0.25);color:var(--danger);">';
        msg += '' + _ico('x', 13, 'var(--danger)') + ' ' + esc(d.diagnosis);
      }
      msg += '</div>';

      // Detail endpoint results (most important)
      var det = d.detail_endpoint || {};
      msg += '<div style="margin-top:14px;padding:10px;background:var(--bg);border-radius:6px;border:1px solid var(--border);">';
      msg += '<div style="font-weight:700;color:#60a5fa;margin-bottom:6px;">' + _ico('receipt', 13) + ' Individual Reservation Detail (GET /v1/reservations/{id})</div>';
      if (det.error) {
        msg += '<div style="color:var(--danger);">Error: ' + esc(det.error) + '</div>';
      } else {
        msg += '<div style="color:var(--text3);">Fields returned: <strong>' + (det.keys_count || 0) + '</strong> (vs ' + ((d.list_endpoint || {}).keys || []).length + ' from list endpoint)</div>';
        // Pet fields found
        var detPetKeys = Object.keys(det.pet_related_fields || {});
        if (detPetKeys.length > 0) {
          msg += '<div style="margin-top:6px;font-weight:600;color:var(--accent);">' + _ico('paw', 13) + ' Pet/Custom/Note fields found (' + detPetKeys.length + '):</div>';
          detPetKeys.forEach(function(k) {
            msg += '<div style="margin-left:8px;"><span style="color:var(--accent);font-family:DM Mono,monospace;">' + esc(k) + '</span>: <strong>' + esc(String(det.pet_related_fields[k])).substring(0, 300) + '</strong></div>';
          });
        } else {
          msg += '<div style="margin-top:6px;color:var(--text3);">No pet/custom/note fields found on this reservation.</div>';
        }
        // Interesting fields
        if (det.interesting_fields && Object.keys(det.interesting_fields).length > 0) {
          msg += '<div style="margin-top:8px;font-weight:600;">Interesting fields on this reservation:</div>';
          for (var ifk in det.interesting_fields) {
            msg += '<div style="margin-left:8px;"><span style="color:var(--purple);font-family:DM Mono,monospace;">' + esc(ifk) + '</span>: ' + esc(det.interesting_fields[ifk]) + '</div>';
          }
        }
        // Specific checks
        msg += '<div style="margin-top:8px;font-weight:600;">Specific field checks (detail endpoint):</div>';
        msg += '<div style="margin-left:8px;">customFields: ' + (det.customFields ? '' + _ico('check', 13, 'var(--accent)') + ' ' + esc(JSON.stringify(det.customFields)).substring(0, 200) : '' + _ico('x', 13, 'var(--danger)') + ' empty/missing') + '</div>';
        msg += '<div style="margin-left:8px;">guest.customFields: ' + (det.guest_customFields ? '' + _ico('check', 13, 'var(--accent)') + ' ' + esc(JSON.stringify(det.guest_customFields)).substring(0, 200) : '' + _ico('x', 13, 'var(--danger)') + ' empty/missing') + '</div>';
        msg += '<div style="margin-left:8px;">guestNote: ' + (det.guestNote ? '' + _ico('check', 13, 'var(--accent)') + ' "' + esc(String(det.guestNote)).substring(0, 150) + '"' : '' + _ico('x', 13, 'var(--danger)') + ' empty') + '</div>';
        msg += '<div style="margin-left:8px;">notes: ' + (det.notes ? '' + _ico('check', 13, 'var(--accent)') + ' "' + esc(String(det.notes)).substring(0, 150) + '"' : '' + _ico('x', 13, 'var(--danger)') + ' empty') + '</div>';
        msg += '<div style="margin-left:8px;">specialRequests: ' + (det.specialRequests ? '' + _ico('check', 13, 'var(--accent)') + ' "' + esc(String(det.specialRequests)).substring(0, 150) + '"' : '' + _ico('x', 13, 'var(--danger)') + ' empty') + '</div>';
      }
      msg += '</div>';

      // Listing-level pet info
      if (d.listing_pet_info && Object.keys(d.listing_pet_info).length > 0) {
        msg += '<div style="margin-top:10px;padding:10px;background:rgba(245,158,11,0.06);border-radius:6px;border:1px solid rgba(245,158,11,0.2);">';
        msg += '<div style="font-weight:700;color:#f59e0b;margin-bottom:6px;">' + _ico('home', 13) + ' Listing-Level Pet Info</div>';
        for (var lk in d.listing_pet_info) {
          msg += '<div style="margin-left:8px;"><span style="color:#f59e0b;font-family:DM Mono,monospace;">' + esc(lk) + '</span>: ' + esc(String(d.listing_pet_info[lk])).substring(0, 300) + '</div>';
        }
        msg += '</div>';
      }

      // Next steps
      msg += '<div style="margin-top:14px;padding:10px 12px;background:var(--bg);border-radius:6px;border:1px solid var(--border);">';
      msg += '<div style="font-weight:700;margin-bottom:6px;">' + _ico('edit', 13) + ' Next Steps</div>';
      if (detPetKeys.length > 0) {
        msg += '<div style="color:var(--accent);">1. Pet data exists! We can wire it into the sync pipeline.</div>';
        msg += '<div style="color:var(--text2);">2. Share these field names with Claude to update the import logic.</div>';
      } else {
        msg += '<div style="color:var(--text2);">1. <strong>In Guesty:</strong> Go to Settings → Custom Fields → Create a field like "Has Pets" (Yes/No) or "Pet Type" (text)</div>';
        msg += '<div style="color:var(--text2);">2. <strong>Or:</strong> Use Guesty Automations to auto-tag reservations that mention pets in guest messages</div>';
        msg += '<div style="color:var(--text2);">3. <strong>Or:</strong> Manually tag pet bookings in FCP-PMR (coming soon)</div>';
        msg += '<div style="color:var(--text3);margin-top:6px;">Most Guesty accounts don\'t have pet fields by default. This is normal — pet tracking requires custom field setup in Guesty.</div>';
      }
      msg += '</div>';
    }
    msg += '</div>';
    showModal('Guesty Pet Field Debug', msg);
  } catch (err) {
    hideLoading();
    toast('Debug failed: ' + err.message, 'error');
  }
}

async function debugPetDbStatus() {
  try {
    showLoading('Checking pet data in database...');
    var d = await api('/api/guesty/debug-pets');
    hideLoading();
    var s = d.reservation_stats || {};
    var msg = '<div style="padding:12px;background:var(--surface2);border-radius:8px;font-size:0.75rem;line-height:1.8;max-height:70vh;overflow-y:auto;">';
    msg += '<div style="font-weight:700;font-size:0.88rem;margin-bottom:8px;">' + _ico('paw', 13) + ' Pet Data — Database Status</div>';
    msg += '<div style="padding:10px;background:var(--bg);border-radius:6px;border:1px solid var(--border);margin-bottom:10px;">';
    msg += '<div><strong>Total reservations:</strong> ' + (s.total_reservations || 0) + '</div>';
    msg += '<div><strong>With Guesty ID:</strong> ' + (s.with_guesty_id || 0) + ' <span style="color:var(--text3);">(can be pet-checked via API)</span></div>';
    msg += '<div><strong>Without Guesty ID:</strong> ' + (s.without_guesty_id || 0) + ' <span style="color:var(--text3);">(CSV-only, needs API lookup)</span></div>';
    msg += '<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;">';
    msg += '<div style="color:var(--accent);font-weight:700;">' + _ico('check', 13, 'var(--accent)') + ' Has pets: ' + (s.has_pets || 0) + '</div>';
    msg += '<div style="color:var(--text3);">' + _ico('x', 13, 'var(--danger)') + ' Checked, no pets: ' + (s.checked_no_pets || 0) + '</div>';
    msg += '<div style="color:#f59e0b;">' + _ico('clock', 13) + ' Not yet checked: ' + (s.unchecked || 0) + '</div>';
    msg += '</div></div>';
    msg += '<div><strong>guest_stays with pets:</strong> ' + (d.guest_stays_with_pets || 0) + ' <span style="color:var(--text3);">(this is what the UI reads)</span></div>';
    if (d.pet_reservations && d.pet_reservations.length > 0) {
      msg += '<div style="margin-top:10px;font-weight:600;">Reservations with pets:</div>';
      d.pet_reservations.forEach(function(r) {
        msg += '<div style="margin-left:8px;">' + esc(r.guest_name || '—') + ' · ' + esc(r.confirmation_code || '') + ' · ' + esc(r.check_in || '') + ' · <span style="color:var(--accent);">' + esc(r.pet_type || 'yes') + '</span></div>';
      });
    }
    msg += '</div>';
    showModal('Pet Database Status', msg);
  } catch (err) {
    hideLoading();
    toast('Failed: ' + err.message, 'error');
  }
}
