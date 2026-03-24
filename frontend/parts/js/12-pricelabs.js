// PriceLabs Integration — Preview-Confirm Sync Flow

async function loadPLStatus() {
  try {
    var d = await api('/api/pricelabs/status');
    var el = document.getElementById('priceLabsStatus');
    if (!el) return;
    if (!d.configured) {
      el.innerHTML = '<div style="padding:10px 14px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:8px;font-size:0.85rem;">' +
        '<strong>Not configured.</strong> Add your API key: <code style="font-size:0.78rem;background:var(--surface2);padding:2px 6px;border-radius:3px;">wrangler secret put PRICELABS_API_KEY</code>' +
        '<br><span style="font-size:0.78rem;color:var(--text3);">Email support@pricelabs.co to enable Customer API ($1/listing/mo)</span></div>';
      return;
    }
    var h = '<div class="market-grid" style="grid-template-columns:repeat(auto-fill,minmax(120px,1fr));">';
    h += '<div class="stat-card"><div class="stat-value">' + (d.listing_count || 0) + '</div><div class="stat-label">Listings</div></div>';
    h += '<div class="stat-card"><div class="stat-value">' + (d.linked_count || 0) + '</div><div class="stat-label">Linked</div></div>';
    h += '<div class="stat-card"><div class="stat-value">' + (d.rate_count || 0) + '</div><div class="stat-label">Rates Stored</div></div>';
    h += '<div class="stat-card"><div class="stat-value" style="font-size:0.85rem;">' + (d.last_sync ? fmtUTC(d.last_sync) : 'never') + '</div><div class="stat-label">Last Sync</div></div>';
    h += '</div>';
    el.innerHTML = h;
    loadPLListingMap();
  } catch (err) {
    var el = document.getElementById('priceLabsStatus');
    if (el) el.innerHTML = '<p style="color:var(--danger);font-size:0.85rem;">' + esc(err.message) + '</p>';
  }
}

async function syncPriceLabs() {
  var st = document.getElementById('plSyncStatus');
  if (st) st.innerHTML ='' + _ico('search', 13) + ' Fetching preview from PriceLabs...';
  showLoading('Previewing sync...');
  try {
    var d = await api('/api/pricelabs/sync?preview=1', 'POST');
    hideLoading();
    if (!d.preview) { toast('Unexpected response', 'error'); return; }
    showPLSyncPreview(d);
  } catch (err) {
    if (st) st.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
    hideLoading();
  }
}

function showPLSyncPreview(data) {
  var s = data.summary;
  var h = '<div style="max-width:700px;">';

  // Direction badge
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">';
  h += '<span style="font-size:1.3rem;">⬇️</span>';
  h += '<div><strong style="color:var(--accent);">PULL FROM PRICELABS</strong>';
  h += '<div style="font-size:0.78rem;color:var(--text3);">' + esc(data.description) + '</div></div>';
  h += '</div>';

  // Summary cards
  h += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;">';
  h += plSummaryCard(s.total_from_pricelabs, 'From PriceLabs', 'var(--purple)');
  h += plSummaryCard(s.new_listings, 'New', 'var(--accent)');
  h += plSummaryCard(s.updates, 'Updates', '#f59e0b');
  h += plSummaryCard(s.unchanged, 'Unchanged', 'var(--text3)');
  h += '</div>';

  // Safety guarantees
  h += '<div style="padding:10px 14px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:8px;margin-bottom:14px;">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">✓ SAFE — READ ONLY</div>';
  (data.what_is_safe || []).forEach(function(item) {
    h += '<div style="font-size:0.78rem;color:var(--text2);margin:3px 0;">• ' + esc(item) + '</div>';
  });
  h += '</div>';

  // Changes detail
  var changes = data.changes || [];
  if (changes.length > 0) {
    h += '<div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<table class="comp-table" style="margin:0;"><thead><tr><th>Action</th><th>Listing</th><th>Changes</th></tr></thead><tbody>';
    changes.forEach(function(c) {
      var actionBadge = c.action === 'add' ? '<span style="background:rgba(16,185,129,0.15);color:var(--accent);padding:2px 8px;border-radius:3px;font-size:0.72rem;font-weight:600;">NEW</span>'
        : c.action === 'update' ? '<span style="background:rgba(245,158,11,0.15);color:#f59e0b;padding:2px 8px;border-radius:3px;font-size:0.72rem;font-weight:600;">UPDATE</span>'
        : '<span style="color:var(--text3);font-size:0.72rem;">no change</span>';
      var diffHtml = '';
      if (c.action === 'add') {
        diffHtml = '<span style="font-size:0.72rem;color:var(--accent);">New listing: ' + esc(c.incoming.pl_platform || '?') + ', base $' + (c.incoming.base_price || '?') + '</span>';
      } else if (c.diffs && c.diffs.length > 0) {
        diffHtml = c.diffs.map(function(d) {
          var fromVal = d.from !== null && d.from !== undefined ? String(d.from) : '—';
          var toVal = d.to !== null && d.to !== undefined ? String(d.to) : '—';
          return '<span style="font-size:0.72rem;">' + esc(d.field) + ': <span style="color:var(--danger);text-decoration:line-through;">' + esc(fromVal) + '</span> → <span style="color:var(--accent);">' + esc(toVal) + '</span></span>';
        }).join('<br>');
      }
      var linkedBadge = c.linked_property_id ? ' <span style="font-size:0.62rem;background:var(--purple-dim);color:var(--purple);padding:1px 5px;border-radius:3px;">linked</span>' : '';
      h += '<tr><td>' + actionBadge + '</td><td style="font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;">' + esc(c.name || c.pl_listing_id) + linkedBadge + '</td><td>' + diffHtml + '</td></tr>';
    });
    h += '</tbody></table></div>';
  }

  // Orphans warning
  if (data.orphans && data.orphans.length > 0) {
    h += '<div style="padding:10px 14px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:#f59e0b;margin-bottom:4px;">' + _ico('alertCircle', 13, '#f59e0b') + ' ' + data.orphans.length + ' Local Listing(s) Not Found in PriceLabs</div>';
    data.orphans.forEach(function(o) {
      h += '<div style="font-size:0.78rem;color:var(--text2);">• ' + esc(o.name || o.pl_listing_id) + ' — <em>' + esc(o.note) + '</em></div>';
    });
    h += '</div>';
  }

  // Confirm / Cancel
  h += '<div style="display:flex;gap:10px;justify-content:flex-end;">';
  h += '<button class="btn btn-sm" onclick="closePLPreview()">Cancel</button>';
  if (s.new_listings > 0 || s.updates > 0) {
    h += '<button class="btn btn-sm btn-primary" onclick="executePLSync(\'sync\')">✓ Confirm Sync (' + (s.new_listings + s.updates) + ' changes)</button>';
  } else {
    h += '<button class="btn btn-sm" disabled style="opacity:0.5;">Nothing to sync</button>';
  }
  h += '</div>';
  h += '</div>';

  showPLModal('Sync Listings Preview', h);
}

async function fetchAllPLPrices() {
  var st = document.getElementById('plSyncStatus');
  if (st) st.innerHTML ='' + _ico('search', 13) + ' Previewing rate pull...';
  showLoading('Previewing price fetch...');
  try {
    var d = await api('/api/pricelabs/prices-all?preview=1', 'POST');
    hideLoading();
    if (!d.preview) { toast('Unexpected response', 'error'); return; }
    showPLPricesPreview(d);
  } catch (err) {
    if (st) st.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
    hideLoading();
  }
}

function showPLPricesPreview(data) {
  var s = data.summary;
  var h = '<div style="max-width:700px;">';

  // Direction badge
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;">';
  h += '<span style="font-size:1.3rem;">⬇️</span>';
  h += '<div><strong style="color:var(--accent);">PULL RATES FROM PRICELABS</strong>';
  h += '<div style="font-size:0.78rem;color:var(--text3);">' + esc(data.description) + '</div></div>';
  h += '</div>';

  // Summary cards
  h += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">';
  h += plSummaryCard(s.listings_to_fetch, 'Listings to Fetch', 'var(--purple)');
  h += plSummaryCard(s.listings_with_future_rates, 'Have Existing Rates', '#f59e0b');
  h += plSummaryCard(s.total_future_rates_at_risk, 'Rates to Refresh', 'var(--accent)');
  h += '</div>';

  // Safety guarantees
  h += '<div style="padding:10px 14px;background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.2);border-radius:8px;margin-bottom:14px;">';
  h += '<div style="font-size:0.78rem;font-weight:600;color:var(--accent);margin-bottom:6px;">✓ SAFE — READ ONLY</div>';
  (data.what_is_safe || []).forEach(function(item) {
    h += '<div style="font-size:0.78rem;color:var(--text2);margin:3px 0;">• ' + esc(item) + '</div>';
  });
  h += '</div>';

  // What gets overwritten
  if (data.what_gets_overwritten && data.what_gets_overwritten.length > 0) {
    h += '<div style="padding:10px 14px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-radius:8px;margin-bottom:14px;">';
    h += '<div style="font-size:0.78rem;font-weight:600;color:#f59e0b;margin-bottom:4px;">' + _ico('alertCircle', 13, '#f59e0b') + ' WHAT GETS REFRESHED</div>';
    data.what_gets_overwritten.forEach(function(w) {
      h += '<div style="font-size:0.78rem;color:var(--text2);margin:3px 0;">• ' + esc(w) + '</div>';
    });
    h += '</div>';
  }

  // Per-listing detail
  var listings = data.listings || [];
  if (listings.length > 0) {
    h += '<div style="max-height:300px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-bottom:14px;">';
    h += '<table class="comp-table" style="margin:0;"><thead><tr><th>Listing</th><th>Linked Property</th><th>Existing Rates</th><th>Rates to Refresh</th><th>Status</th></tr></thead><tbody>';
    listings.forEach(function(l) {
      var riskColor = l.future_rates_at_risk.count > 0 ? '#f59e0b' : 'var(--accent)';
      var statusBadge = l.future_rates_at_risk.count > 0
        ? '<span style="background:rgba(245,158,11,0.15);color:#f59e0b;padding:2px 6px;border-radius:3px;font-size:0.68rem;">REFRESH</span>'
        : '<span style="background:rgba(16,185,129,0.15);color:var(--accent);padding:2px 6px;border-radius:3px;font-size:0.68rem;">NEW DATA</span>';
      h += '<tr>';
      h += '<td style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;">' + esc(l.name || l.pl_listing_id) + '</td>';
      h += '<td style="font-size:0.78rem;">' + (l.linked_property ? esc(l.linked_property) : '<span style="color:var(--text3);">unlinked</span>') + '</td>';
      h += '<td style="font-size:0.78rem;font-family:DM Mono,monospace;">';
      if (l.existing_rates.total > 0) {
        h += l.existing_rates.total + ' rates';
        if (l.existing_rates.avg_price) h += ' (avg $' + l.existing_rates.avg_price + ')';
        if (l.existing_rates.date_range) h += '<br><span style="font-size:0.68rem;color:var(--text3);">' + l.existing_rates.date_range + '</span>';
      } else {
        h += '<span style="color:var(--text3);">none</span>';
      }
      h += '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + riskColor + ';">';
      if (l.future_rates_at_risk.count > 0) {
        h += l.future_rates_at_risk.count + ' rates';
        if (l.future_rates_at_risk.avg_price) h += ' (avg $' + l.future_rates_at_risk.avg_price + ')';
      } else {
        h += '0';
      }
      h += '</td>';
      h += '<td>' + statusBadge + '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div>';
  }

  // Confirm / Cancel
  h += '<div style="display:flex;gap:10px;justify-content:flex-end;">';
  h += '<button class="btn btn-sm" onclick="closePLPreview()">Cancel</button>';
  h += '<button class="btn btn-sm btn-primary" onclick="executePLSync(\'prices\')">✓ Confirm Pull Rates (' + s.listings_to_fetch + ' listings)</button>';
  h += '</div>';
  h += '</div>';

  showPLModal('Fetch Prices Preview', h);
}

async function executePLSync(type) {
  closePLPreview();
  var st = document.getElementById('plSyncStatus');
  if (type === 'sync') {
    if (st) st.innerHTML ='' + _ico('refresh', 13) + ' Syncing listings...';
    showLoading('Syncing PriceLabs...');
    try {
      var d = await api('/api/pricelabs/sync', 'POST');
      if (st) st.innerHTML = '<span style="color:var(--accent);">✓ ' + esc(d.message || 'Done') + '</span>';
      toast(d.message || 'Synced');
      loadPLStatus();
    } catch (err) {
      if (st) st.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
      toast(err.message, 'error');
    }
    hideLoading();
  } else if (type === 'prices') {
    if (st) st.innerHTML ='' + _ico('barChart', 13) + ' Fetching rates...';
    showLoading('Pulling PriceLabs rates...');
    try {
      var d = await api('/api/pricelabs/prices-all', 'POST');
      var msg = d.message || 'Done';
      if (d.failed > 0 && d.results) {
        // Show detailed errors
        var errDetail = '<div style="margin-top:8px;">';
        errDetail += '<span style="color:var(--accent);">✓ ' + (d.succeeded || 0) + ' updated</span>, <span style="color:var(--danger);">' + d.failed + ' failed</span>';
        d.results.forEach(function(r) {
          if (r.error) {
            errDetail += '<div style="font-size:0.72rem;padding:6px 10px;margin-top:6px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.15);border-radius:6px;">';
            errDetail += '<strong>' + esc(r.listing || r.id) + ':</strong> ' + esc(r.error);
            if (r.action_needed) {
              errDetail += '<div style="margin-top:6px;padding:8px 10px;background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);border-radius:6px;">';
              errDetail += '<div style="font-weight:600;color:#f59e0b;margin-bottom:4px;">Action Needed:</div>';
              r.action_needed.forEach(function(step) {
                errDetail += '<div style="font-size:0.72rem;margin:3px 0;">' + esc(step) + '</div>';
              });
              errDetail += '</div>';
            }
            if (r.note) errDetail += '<div style="font-size:0.68rem;color:var(--text3);margin-top:4px;">' + esc(r.note) + '</div>';
            if (r.endpoints_tried) {
              errDetail += '<div style="font-size:0.68rem;color:var(--text3);margin-top:4px;">Endpoints tried:';
              r.endpoints_tried.forEach(function(e) {
                var statusLabel = e.status === 'ok' ? '<span style="color:var(--accent);">200 OK</span>' : '<span style="color:var(--danger);">' + esc(e.status || 'error') + '</span>';
                errDetail += '<br>• ' + esc(e.endpoint) + ' → ' + statusLabel;
                if (e.sample) errDetail += '<br><code style="font-size:0.62rem;color:var(--text3);word-break:break-all;display:block;margin:2px 0 4px 16px;background:var(--surface);padding:3px 6px;border-radius:3px;">' + esc(e.sample.substring(0, 200)) + '</code>';
                if (e.error && !e.sample) errDetail += ' — ' + esc(e.error);
              });
              errDetail += '</div>';
            }
            if (r.tip) errDetail += '<div style="font-size:0.68rem;color:var(--warn);margin-top:3px;">' + esc(r.tip) + '</div>';
            errDetail += '</div>';
          }
        });
        errDetail += '</div>';
        if (st) st.innerHTML = errDetail;
      } else {
        if (st) st.innerHTML = '<span style="color:var(--accent);">✓ ' + esc(msg) + '</span>';
      }
      toast(msg);
      loadPLStatus();
    } catch (err) {
      if (st) st.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
      toast(err.message, 'error');
    }
    hideLoading();
  }
}

function showPLModal(title, contentHtml) {
  var existing = document.getElementById('plPreviewModal');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'plPreviewModal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.onclick = function(e) { if (e.target === overlay) closePLPreview(); };
  var modal = document.createElement('div');
  modal.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:780px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3);';
  modal.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;"><h2 style="margin:0;">' + esc(title) + '</h2><button class="btn btn-xs" onclick="closePLPreview()" style="font-size:1.1rem;padding:2px 8px;">✗</button></div>' + contentHtml;
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function closePLPreview() {
  var m = document.getElementById('plPreviewModal');
  if (m) m.remove();
}

function plSummaryCard(value, label, color) {
  return '<div style="text-align:center;padding:10px 6px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">' +
    '<div style="font-family:DM Mono,monospace;font-size:1.2rem;font-weight:700;color:' + color + ';">' + value + '</div>' +
    '<div style="font-size:0.68rem;color:var(--text3);">' + label + '</div></div>';
}

async function loadPLListingMap() {
  try {
    var d = await api('/api/pricelabs/summary');
    var listings = d.listings || [];
    var el = document.getElementById('plListingMap');
    if (!el) return;
    if (listings.length === 0) {
      el.innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No PriceLabs listings yet. Click "Sync Listings" to import from your PriceLabs account.</p>';
      return;
    }
    var h = '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:6px;">LISTING ↔ PROPERTY MAPPING</label>';
    h += '<div style="overflow-x:auto;"><table class="comp-table"><thead><tr><th>PriceLabs Listing</th><th>Base</th><th>Rec.</th><th>Min–Max</th><th>Clean</th><th>Occ 30d</th><th>Mkt 30d</th><th>Push</th><th>Linked Property</th><th></th></tr></thead><tbody>';
    // Collect property IDs already linked to a PL listing
    var linkedPropIds = {};
    listings.forEach(function(l) { if (l.property_id) linkedPropIds[l.property_id] = true; });

    listings.forEach(function(l) {
      var linked = l.property_id ? properties.find(function(p) { return p.id === l.property_id; }) : null;
      var linkedLabel = linked ? esc(getPropertyLabel(linked)) : '<span style="color:var(--text3);">Not linked</span>';
      var occ30 = l.occupancy_next_30 || l.occ_30d || null;
      var mktOcc30 = l.market_occupancy_next_30 || l.mkt_occ_30d || null;
      var occColor = occ30 && mktOcc30 && parseInt(occ30) > parseInt(mktOcc30) ? 'var(--accent)' : 'var(--text)';
      h += '<tr><td style="font-weight:600;max-width:180px;overflow:hidden;text-overflow:ellipsis;font-size:0.78rem;">' + esc(l.pl_listing_name || l.pl_listing_id) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--purple);font-weight:600;">' + (l.base_price ? '$' + l.base_price : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">' + (l.recommended_base_price ? '$' + l.recommended_base_price : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;font-size:0.72rem;">' + (l.min_price && l.max_price ? '$' + l.min_price + '–$' + l.max_price : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (l.cleaning_fees ? '$' + l.cleaning_fees : '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + occColor + ';font-weight:600;">' + (occ30 || '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;font-size:0.72rem;color:var(--text3);">' + (mktOcc30 || '—') + '</td>';
      h += '<td>' + (l.push_enabled ? '<span style="color:var(--accent);font-size:0.72rem;">✓ On</span>' : '<span style="color:var(--text3);font-size:0.72rem;">Off</span>') + '</td>';
      h += '<td style="font-size:0.78rem;">' + linkedLabel + '</td>';
      h += '<td>';
      if (l.property_id) {
        h += '<button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);padding:2px 6px;" onclick="unlinkPL(' + l.id + ')">Unlink</button>';
      } else {
        var opts = properties.filter(function(p) {
          var isBuilding = (p.property_type === 'multi_family' && !p.parent_id) || (p.child_count && p.child_count > 0);
          if (isBuilding) return false;
          if (p.parent_id && !p.unit_number) return false;
          if (p.is_research) return false;
          if (linkedPropIds[p.id]) return false;
          return true;
        });
        if (opts.length > 0) {
          h += '<select style="font-size:0.78rem;padding:2px 6px;width:160px;" onchange="linkPL(' + l.id + ', this.value)"><option value="">Link to...</option>';
          opts.forEach(function(p) {
            h += '<option value="' + p.id + '">' + esc(getPropertyLabel(p)) + '</option>';
          });
          h += '</select>';
        } else {
          h += '<span style="font-size:0.72rem;color:var(--text3);">No properties available</span>';
        }
      }
      h += '</td></tr>';
    });
    h += '</tbody></table></div>';
    el.innerHTML = h;
  } catch {}
}

async function linkPL(plDbId, propId) {
  if (!propId) return;
  try {
    await api('/api/pricelabs/listings/' + plDbId + '/link', 'POST', { property_id: parseInt(propId) });
    toast('Linked to property');
    loadPLListingMap();
  } catch (err) { toast(err.message, 'error'); }
}

async function unlinkPL(plDbId) {
  try {
    await api('/api/pricelabs/listings/' + plDbId + '/unlink', 'POST');
    toast('Unlinked');
    loadPLListingMap();
  } catch (err) { toast(err.message, 'error'); }
}

async function loadPLCalendar(propertyId) {
  var container = document.getElementById('plCalendarSection');
  if (!container) return;
  if (!propertyId) { container.style.display = 'none'; return; }
  try {
    var d = await api('/api/pricelabs/calendar?property_id=' + propertyId + '&days=90');
    if (!d.calendar || d.calendar.length === 0) { container.style.display = 'none'; return; }
    container.style.display = '';
    var h = '<div class="card-header"><h3>PriceLabs Dynamic Pricing</h3><span style="font-size:0.78rem;color:var(--text3);">' + d.rates_count + ' days loaded</span></div>';

    h += '<div class="market-grid" style="grid-template-columns:repeat(auto-fill,minmax(100px,1fr));margin-bottom:14px;">';
    h += '<div class="stat-card"><div class="stat-value">$' + d.summary.avg + '</div><div class="stat-label">Avg Rate</div></div>';
    h += '<div class="stat-card"><div class="stat-value">$' + d.summary.min + '</div><div class="stat-label">Min Rate</div></div>';
    h += '<div class="stat-card"><div class="stat-value">$' + d.summary.max + '</div><div class="stat-label">Max Rate</div></div>';
    h += '<div class="stat-card"><div class="stat-value">$' + d.summary.median + '</div><div class="stat-label">Median</div></div>';
    h += '</div>';

    if (d.monthly && d.monthly.length > 0) {
      h += '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:6px;">MONTHLY BREAKDOWN</label>';
      h += '<table class="comp-table" style="margin-bottom:14px;"><thead><tr><th>Month</th><th>Avg Rate</th><th>Min</th><th>Max</th><th>Avg Min Stay</th><th>Days</th><th>Proj Revenue (70% occ)</th></tr></thead><tbody>';
      d.monthly.forEach(function(m) {
        h += '<tr><td style="font-weight:600;">' + esc(m.month) + '</td>';
        h += '<td style="font-family:DM Mono,monospace;color:var(--accent);">$' + m.avg_rate + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">$' + m.min_rate + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">$' + m.max_rate + '</td>';
        h += '<td style="font-family:DM Mono,monospace;">' + m.avg_min_stay + '</td>';
        h += '<td>' + m.days + '</td>';
        h += '<td style="font-family:DM Mono,monospace;font-weight:600;color:var(--accent);">$' + m.projected_revenue.toLocaleString() + '</td></tr>';
      });
      h += '</tbody></table>';
    }

    if (d.dow_analysis && d.dow_analysis.length > 0) {
      h += '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:6px;">DAY-OF-WEEK RATES</label>';
      h += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;">';
      d.dow_analysis.forEach(function(dw) {
        var isWeekend = dw.day === 'Fri' || dw.day === 'Sat';
        h += '<div style="flex:1;min-width:60px;text-align:center;padding:10px 6px;background:' + (isWeekend ? 'rgba(167,139,250,0.1)' : 'var(--surface2)') + ';border-radius:8px;border:1px solid var(--border);">';
        h += '<div style="font-size:0.72rem;color:var(--text3);">' + dw.day + '</div>';
        h += '<div style="font-family:DM Mono,monospace;font-weight:700;font-size:1rem;color:' + (isWeekend ? 'var(--purple)' : 'var(--accent)') + ';">$' + dw.avg_rate + '</div>';
        h += '</div>';
      });
      h += '</div>';
    }

    var cal = d.calendar.slice(0, 30);
    if (cal.length > 0) {
      h += '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:6px;">NEXT 30 DAYS</label>';
      h += '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;">';
      var calMin = Math.min.apply(null, cal.map(function(c) { return c.price; }));
      var calMax = Math.max.apply(null, cal.map(function(c) { return c.price; }));
      var calRange = calMax - calMin || 1;
      cal.forEach(function(c) {
        var dayNum = c.rate_date.substring(8, 10);
        var intensity = Math.round((c.price - calMin) / calRange * 100);
        var bg = intensity > 70 ? 'rgba(239,68,68,0.15)' : intensity > 40 ? 'rgba(245,158,11,0.12)' : 'rgba(16,185,129,0.12)';
        var color = intensity > 70 ? 'var(--danger)' : intensity > 40 ? '#f59e0b' : 'var(--accent)';
        var avail = c.is_available ? '' : 'opacity:0.3;text-decoration:line-through;';
        h += '<div style="text-align:center;padding:4px 2px;background:' + bg + ';border-radius:4px;' + avail + '" title="' + c.rate_date + ': $' + c.price + '/nt, min ' + c.min_stay + ' nights">';
        h += '<div style="font-size:0.62rem;color:var(--text3);">' + dayNum + '</div>';
        h += '<div style="font-family:DM Mono,monospace;font-size:0.72rem;font-weight:600;color:' + color + ';">$' + c.price + '</div>';
        if (c.min_stay > 1) h += '<div style="font-size:0.65rem;color:var(--text3);">' + c.min_stay + 'n</div>';
        h += '</div>';
      });
      h += '</div>';
    }

    container.innerHTML = h;
  } catch (err) {
    container.style.display = 'none';
  }
}

function renderPLBenchmark(plData) {
  if (!plData || !plData.avg) return '';
  var h = '<div style="padding:12px 14px;margin-bottom:6px;border-radius:8px;background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.2);">';
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
  h += '<span style="font-size:1.1rem;">' + _ico('barChart', 13) + '</span>';
  h += '<strong style="color:var(--purple);">PriceLabs Recommended</strong>';
  h += '<span style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:var(--purple);">$' + plData.avg + '/nt</span>';
  h += '<span style="font-size:0.78rem;color:var(--text3);">(range $' + plData.min + ' – $' + plData.max + ')</span>';
  h += '</div>';
  if (plData.base_price) h += '<span style="font-size:0.78rem;color:var(--text3);margin-right:12px;">Base price: $' + plData.base_price + '</span>';
  if (plData.min_price) h += '<span style="font-size:0.78rem;color:var(--text3);">Min price: $' + plData.min_price + '</span>';
  h += '</div>';
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// PriceLabs Compare Panel — shown in the Pricing Strategy tab per property
// Shows: what PriceLabs has configured → what your analysis recommends → drift
// ─────────────────────────────────────────────────────────────────────────────

async function loadPLComparePanel(propId, analysisData) {
  var panel = document.getElementById('plComparePanel');
  if (!panel || !propId) return;

  panel.innerHTML = '<div style="padding:10px 14px;font-size:0.78rem;color:var(--text3);">' + _ico('clock', 13) + ' Loading PriceLabs data...</div>';

  var pl, strategies, prop;

  if (analysisData) {
    // Fresh analysis result passed directly
    pl = analysisData.pricelabs;
    strategies = analysisData.strategies || [];
    prop = analysisData.property || null;
  } else {
    // Load from property endpoint
    try {
      var d = await api('/api/properties/' + propId);
      pl = d.pricelabs;
      strategies = d.strategies || [];
      prop = d.property || null;
      if (d.siblings && d.siblings.length > 0) pl._siblings = d.siblings;
    } catch (err) {
      panel.innerHTML = '';
      return;
    }
  }

  if (!pl || !pl.linked) {
    panel.innerHTML = renderPLNotLinked(propId);
    return;
  }

  // Pick the best strategy: prefer pl-strategy result (explicit min/max), then AI STR, then highest projected
  var bestStrat = null;
  if (strategies && strategies.length > 0) {
    var strStrats = strategies.filter(function(s) { return !s.rental_type || s.rental_type === 'str'; });
    // 1st choice: strategy coming directly from pl-strategy button (has explicit min/max/base aligned to PL)
    var plStrat = strStrats.find(function(s) { return s.from_pl_strategy; });
    // 2nd choice: AI-generated strategy
    var aiStrat = strStrats.find(function(s) { return s.ai_generated && !s.from_pl_strategy; });
    // 3rd choice: highest projected revenue
    var highestStrat = strStrats.reduce(function(best, s) {
      return (!best || (s.projected_monthly_avg || 0) > (best.projected_monthly_avg || 0)) ? s : best;
    }, null);
    bestStrat = plStrat || aiStrat || highestStrat || strategies[0];
  }

  panel.innerHTML = renderPLComparePanel(pl, bestStrat, prop, strategies);
}

function renderPLNotLinked(propId) {
  return '<div style="padding:12px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;gap:12px;">' +
    '<span style="font-size:1.4rem;">' + _ico('barChart', 13) + '</span>' +
    '<div style="flex:1;">' +
      '<div style="font-size:0.82rem;font-weight:600;color:var(--text2);">PriceLabs not linked</div>' +
      '<div style="font-size:0.72rem;color:var(--text3);margin-top:2px;">Link a PriceLabs listing to see live pricing configuration and drift analysis.</div>' +
    '</div>' +
    '<a href="#" onclick="event.preventDefault();switchMainTab(\'pricelabs\')" class="btn btn-xs" style="color:var(--purple);border-color:var(--purple);white-space:nowrap;">Link PriceLabs →</a>' +
  '</div>';
}

function renderPLComparePanel(pl, bestStrat, prop, allStrats) {
  var now = new Date();
  var syncAge = pl.last_synced ? Math.round((now - new Date(pl.last_synced + (pl.last_synced.includes('Z') ? '' : 'Z'))) / 3600000) : null;
  var syncLabel = syncAge === null ? 'never synced' : syncAge < 1 ? 'synced just now' : syncAge < 24 ? 'synced ' + syncAge + 'h ago' : 'synced ' + Math.round(syncAge / 24) + 'd ago';
  var syncStale = syncAge !== null && syncAge > 48;

  // ── Parse PL values ──
  var plBase = pl.base_price || pl.base || 0;
  var plMin = pl.min_price || 0;
  var plMax = pl.max_price || 0;
  var plRec = pl.recommended_base_price || pl.recommended_base || pl.rec || 0;
  var plClean = pl.cleaning_fees || 0;
  var plOcc30 = pl.occupancy_next_30 ? (parseFloat(pl.occupancy_next_30) > 1 ? parseFloat(pl.occupancy_next_30) / 100 : parseFloat(pl.occupancy_next_30)) : null;
  var plMktOcc30 = pl.market_occupancy_next_30 ? (parseFloat(pl.market_occupancy_next_30) > 1 ? parseFloat(pl.market_occupancy_next_30) / 100 : parseFloat(pl.market_occupancy_next_30)) : null;
  var plOcc7 = pl.occupancy_next_7 ? (parseFloat(pl.occupancy_next_7) > 1 ? parseFloat(pl.occupancy_next_7) / 100 : parseFloat(pl.occupancy_next_7)) : null;

  // ── Parse strategy values ──
  // Prefer pl-strategy result (has explicit min/max) over analyze result (has base_nightly_rate only)
  var sBase = bestStrat ? (bestStrat.base_nightly_rate || 0) : 0;
  // Use explicit min/max if available (from pl-strategy), otherwise derive from base
  var sMin = bestStrat ? (bestStrat.min_price || Math.round(sBase * 0.65)) : 0;
  var sMax = bestStrat ? (bestStrat.max_price || bestStrat.weekend_rate || Math.round(sBase * 1.5)) : 0;
  var sClean = bestStrat ? (bestStrat.cleaning_fee || 0) : 0;
  var sMinNts = bestStrat ? (bestStrat.min_nights || 0) : 0;
  var sName = bestStrat ? (bestStrat.strategy_name || 'Analysis') : null;
  var sSource = bestStrat && bestStrat.from_pl_strategy ? '' + _ico('barChart', 13) + ' PL Strategy' : (bestStrat && bestStrat.ai_generated ? '' + _ico('sparkle', 13) + ' AI Analysis' : '' + _ico('settings', 13) + ' Algorithmic');

  // If property has a stored analysis nightly rate, use that as fallback
  var propBase = prop ? (prop.analysis_nightly_rate || prop.pl_base_price || 0) : 0;
  if (!sBase && propBase) sBase = propBase;

  // ── Build drift rows ──
  function driftRow(label, plVal, stratVal, fmt, tip, isSafe) {
    var hasPL = plVal > 0;
    var hasStrat = stratVal > 0;
    if (!hasPL && !hasStrat) return '';
    var diff = hasStrat && hasPL ? (stratVal - plVal) : null;
    var pct = diff !== null && plVal > 0 ? Math.round(diff / plVal * 100) : null;
    var driftColor = diff === null ? 'var(--text3)' : Math.abs(pct) <= 5 ? 'var(--accent)' : Math.abs(pct) <= 20 ? '#f59e0b' : 'var(--danger)';
    var driftIcon = diff === null ? '' : Math.abs(pct) <= 5 ? '✓' : diff > 0 ? '↑' : '↓';
    var driftLabel = diff === null ? '—' : (diff > 0 ? '+' : '') + fmt(diff);
    var safeTag = isSafe && diff !== null && Math.abs(pct) > 5
      ? ' <span style="font-size:0.58rem;background:rgba(16,185,129,0.12);color:var(--accent);padding:1px 4px;border-radius:3px;border:1px solid rgba(16,185,129,0.25);">pushable</span>'
      : '';
    var riskTag = !isSafe && diff !== null && Math.abs(pct) > 5
      ? ' <span style="font-size:0.58rem;background:rgba(239,68,68,0.1);color:var(--danger);padding:1px 4px;border-radius:3px;border:1px solid rgba(239,68,68,0.2);">manual only</span>'
      : '';

    return '<div style="display:grid;grid-template-columns:110px 1fr 1fr 80px 16px;gap:0;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;" title="' + (tip || '') + '">' +
      '<div style="font-size:0.72rem;color:var(--text3);font-weight:500;">' + label + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:0.82rem;color:' + (hasPL ? 'var(--purple)' : 'var(--text3)') + ';font-weight:600;">' + (hasPL ? fmt(plVal) : '—') + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:0.82rem;color:' + (hasStrat ? 'var(--accent)' : 'var(--text3)') + ';font-weight:600;">' + (hasStrat ? fmt(stratVal) : '—') + safeTag + riskTag + '</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:0.78rem;font-weight:700;color:' + driftColor + ';text-align:right;">' + driftIcon + ' ' + driftLabel + (pct !== null && Math.abs(pct) > 1 ? ' <span style="font-size:0.65rem;font-weight:400;">(' + pct + '%)</span>' : '') + '</div>' +
      '<div></div>' +
    '</div>';
  }

  function fmtDollar(v) { return '$' + Math.round(v).toLocaleString(); }
  function fmtNt(v) { return '$' + Math.round(v) + '/nt'; }
  function fmtPct(v) { return Math.round(v * 100) + '%'; }

  // ── Occupancy bar ──
  function occBar(label, val, mkt) {
    if (!val) return '';
    var pct = Math.round(val * 100);
    var mktPct = mkt ? Math.round(mkt * 100) : null;
    var color = val > (mkt || 0.5) ? 'var(--accent)' : 'var(--danger)';
    return '<div style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">' +
        '<span style="font-size:0.72rem;color:var(--text3);">' + label + '</span>' +
        '<span style="font-family:DM Mono,monospace;font-size:0.82rem;font-weight:700;color:' + color + ';">' + pct + '%' + (mktPct ? ' <span style="font-size:0.68rem;color:var(--text3);font-weight:400;">mkt ' + mktPct + '%</span>' : '') + '</span>' +
      '</div>' +
      '<div style="height:5px;background:var(--border);border-radius:3px;position:relative;">' +
        '<div style="height:100%;width:' + Math.min(pct, 100) + '%;background:' + color + ';border-radius:3px;"></div>' +
        (mktPct ? '<div style="position:absolute;top:-1px;left:' + Math.min(mktPct, 100) + '%;width:2px;height:7px;background:var(--text3);border-radius:1px;"></div>' : '') +
      '</div>' +
    '</div>';
  }

  // ── Channels ──
  var channelRows = '';
  if (pl.channels && pl.channels.length > 0) {
    channelRows = pl.channels.slice(0, 5).map(function(ch) {
      return '<span style="font-size:0.68rem;padding:2px 7px;border-radius:4px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);">' + esc(ch.channel_name || ch.name || ch) + (ch.avg_nightly_rate ? ' $' + Math.round(ch.avg_nightly_rate) + '/nt' : '') + '</span>';
    }).join(' ');
  }

  // ── Stale sync warning ──
  var staleWarning = syncStale
    ? '<div style="padding:7px 12px;background:rgba(245,158,11,0.06);border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.7rem;color:#f59e0b;">' + _ico('alertCircle', 13, '#f59e0b') + ' Data is ' + Math.round(syncAge / 24) + ' days old — <a href="#" onclick="event.preventDefault();syncPriceLabs()" style="color:#f59e0b;font-weight:600;">sync now</a> for current values</div>'
    : '';

  // ── No-strategy hint ──
  var noStratHint = !bestStrat
    ? '<div style="padding:10px 12px;background:rgba(245,158,11,0.06);border-top:1px solid var(--border);font-size:0.72rem;color:#f59e0b;">' + _ico('zap', 13) + ' Click <strong>' + _ico('barChart', 13) + ' Generate Strategy</strong> above to populate this comparison with AI recommendations. The strategy will show base, min, and max price recommendations directly aligned with PriceLabs.</div>'
    : '';

  // ── PL rec vs base callout ──
  var recCallout = '';
  if (plRec > 0 && plBase > 0 && plRec !== plBase) {
    var recDiff = plRec - plBase;
    var recColor = recDiff > 0 ? 'var(--accent)' : 'var(--danger)';
    var recMsg = recDiff > 0
      ? 'PriceLabs recommends raising your base by $' + Math.abs(recDiff) + ' to $' + plRec + ' based on current market demand.'
      : 'PriceLabs recommends lowering your base by $' + Math.abs(recDiff) + ' to $' + plRec + ' — consider if occupancy is low.';
    recCallout = '<div style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);background:rgba(167,139,250,0.04);display:flex;gap:8px;align-items:flex-start;">' +
      '<span style="font-size:1rem;">' + _ico('lightbulb', 13) + '</span>' +
      '<div style="font-size:0.72rem;color:var(--text2);">' + recMsg + '</div>' +
    '</div>';
  }

  // ── Build HTML ──
  var h = '';
  h += '<div style="border:1px solid rgba(167,139,250,0.25);border-radius:10px;overflow:hidden;background:var(--bg);">';

  // Header
  h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(167,139,250,0.06);border-bottom:1px solid rgba(167,139,250,0.15);">';
  h += '<div style="display:flex;align-items:center;gap:10px;">';
  h += '<span style="font-size:1.1rem;">' + _ico('barChart', 13) + '</span>';
  h += '<div>';
  h += '<div style="font-size:0.85rem;font-weight:700;color:var(--purple);">PriceLabs Configuration</div>';
  h += '<div style="font-size:0.65rem;color:var(--text3);">' + esc(pl.pl_listing_name || pl.name || 'Linked listing') + (pl.pl_platform ? ' · ' + pl.pl_platform : '') + ' · ' + syncLabel + '</div>';
  h += '</div></div>';
  h += '<div style="display:flex;gap:6px;align-items:center;">';
  var plDirectUrl = pl.pl_listing_id
    ? 'https://app.pricelabs.co/pricing?listings=' + encodeURIComponent(pl.pl_listing_id)
    : 'https://app.pricelabs.co/';
  h += '<button class="btn btn-xs" onclick="syncPriceLabs()" style="color:var(--purple);border-color:var(--purple);font-size:0.68rem;" title="Pull fresh data from PriceLabs API: base price, min/max, occupancy rates, and 90-day rate calendar. Does NOT change anything in PriceLabs — read-only pull.">↺ Sync data</button>';
  h += '<a href="' + plDirectUrl + '" target="_blank" rel="noopener" class="btn btn-xs" style="font-size:0.68rem;text-decoration:none;" title="Open this listing\'s Dynamic Pricing page in PriceLabs">Open in PriceLabs ↗</a>';
  h += '</div>';
  h += '</div>';

  // Stale warning
  h += staleWarning;

  // Column headers
  h += '<div style="display:grid;grid-template-columns:110px 1fr 1fr 80px 16px;gap:0;padding:5px 12px;border-bottom:1px solid var(--border);background:var(--surface2);">';
  h += '<div style="font-size:0.62rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Setting</div>';
  h += '<div style="font-size:0.62rem;color:var(--purple);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">PriceLabs Now</div>';
  h += '<div style="font-size:0.62rem;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">' + (sName ? esc(sName) : 'Your Analysis') + ' <span style="font-size:0.65rem;font-weight:400;color:var(--text3);">' + sSource + '</span></div>';
  h += '<div style="font-size:0.62rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;font-weight:600;text-align:right;">Drift</div>';
  h += '<div></div>';
  h += '</div>';

  // PL rec callout (above the rows if PL itself flags a change)
  h += recCallout;

  // Rows — base is "manual only" (risky), min/max are "pushable" (safe)
  h += driftRow('Base Price', plBase, sBase, fmtNt, 'The anchor PriceLabs uses for all dynamic adjustments. Changes shift all rates up or down.', false);
  if (plRec > 0) {
    h += '<div style="padding:4px 12px 6px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
      '<div style="font-size:0.65rem;color:var(--text3);">PriceLabs recommended base: <span style="color:var(--purple);font-weight:600;">$' + plRec + '/nt</span> · your analysis: <span style="color:var(--accent);font-weight:600;">' + (sBase ? '$' + sBase + '/nt' : '—') + '</span></div>' +
    '</div>';
  }
  h += driftRow('Min Price', plMin, sMin, fmtNt, 'Your pricing floor. Safe to update — PriceLabs will never go below this.', true);
  h += driftRow('Max Price', plMax, sMax, fmtNt, 'Your ceiling. Safe to update — PriceLabs will never exceed this.', true);
  h += driftRow('Cleaning Fee', plClean, sClean, fmtDollar, 'Cleaning fee per stay. Verify against your actual costs.', true);

  // ── Data Sources — explains WHY numbers are what they are ──
  var dsLines = [];

  // PriceLabs side
  if (plBase > 0) dsLines.push({ side: 'pl', text: 'Base $' + plBase + '/nt set in PriceLabs dashboard (anchor, not average rate — dynamic adjustments apply on top)' });
  if (plRec > 0 && plRec !== plBase) dsLines.push({ side: 'pl', text: 'PL algorithm recommends $' + plRec + '/nt — difference means their model sees demand diverging from your anchor' });
  if (plOcc30 !== null) dsLines.push({ side: 'pl', text: 'Forward occupancy next 30d: ' + Math.round(plOcc30 * 100) + '% (your listing) vs ' + (plMktOcc30 ? Math.round(plMktOcc30 * 100) + '% (market)' : 'market n/a') + ' — forward bookings are typically 10–30% at any point; annualized target is 50–75%' });

  // Strategy/Analysis side
  if (bestStrat) {
    var sProvLabel = bestStrat.from_pl_strategy ? 'PL Strategy AI' : (bestStrat.ai_generated ? 'Price Analysis AI' : 'Algorithmic model');
    dsLines.push({ side: 'analysis', text: 'Source: ' + sProvLabel + ' (' + (bestStrat.strategy_name || 'Latest run') + ')' });
    if (bestStrat.ai_generated) {
      dsLines.push({ side: 'analysis', text: 'AI sets base_price = PriceLabs anchor (not your target average). Actual ADR will be 15–35% higher after dynamic markups, weekends, holidays.' });
    }
    if (bestStrat.min_price && bestStrat.max_price) {
      dsLines.push({ side: 'analysis', text: 'Min/max explicitly set by strategy: $' + bestStrat.min_price + '–$' + bestStrat.max_price + '/nt guardrail range' });
    } else if (sMin > 0 && sMax > 0) {
      dsLines.push({ side: 'analysis', text: 'Min/max derived from base (×0.65 / ×1.5) — run Generate Strategy for explicit guardrails' });
    }
  } else {
    dsLines.push({ side: 'analysis', text: 'No strategy yet — values showing are from property base data only. Run Price Analysis or Generate Strategy for real recommendations.' });
  }

  // Why they differ
  if (bestStrat && plBase > 0 && sBase > 0 && Math.abs(sBase - plBase) > 10) {
    var diff = sBase - plBase;
    if (diff > 0) {
      dsLines.push({ side: 'diff', text: 'Analysis is $' + diff + ' higher: AI saw your expenses/market and recommends raising the anchor. Consider whether your current base is leaving money behind.' });
    } else {
      dsLines.push({ side: 'diff', text: 'Analysis is $' + Math.abs(diff) + ' lower: AI saw your market and recommends a lower anchor to drive occupancy. Your current PL base may be priced above market.' });
    }
  }

  if (dsLines.length > 0) {
    var dsId = 'ds_' + Math.random().toString(36).substring(2, 8);
    h += '<div style="border-top:1px solid var(--border);">';
    h += '<div onclick="toggleCollapsible(\'' + dsId + '\',this)" style="cursor:pointer;padding:7px 12px;display:flex;align-items:center;gap:6px;font-size:0.68rem;color:var(--text3);user-select:none;background:var(--surface2);">';
    h += '<span>▸</span> <strong>' + _ico('target', 13) + ' How these numbers were determined</strong>';
    h += '</div>';
    h += '<div id="' + dsId + '" style="display:none;padding:10px 14px;background:var(--bg);">';
    dsLines.forEach(function(dl) {
      var dotColor = dl.side === 'pl' ? 'var(--purple)' : dl.side === 'analysis' ? 'var(--accent)' : '#f59e0b';
      var dotLabel = dl.side === 'pl' ? '' + _ico('sparkle', 13, 'var(--purple)') + ' PriceLabs' : dl.side === 'analysis' ? '' + _ico('check', 13, 'var(--accent)') + ' Analysis' :'' + _ico('zap', 13) + ' Drift';
      h += '<div style="display:flex;gap:8px;margin-bottom:6px;font-size:0.72rem;line-height:1.45;">';
      h += '<span style="color:' + dotColor + ';font-size:0.62rem;white-space:nowrap;padding-top:1px;">' + dotLabel + '</span>';
      h += '<span style="color:var(--text2);">' + esc(dl.text) + '</span>';
      h += '</div>';
    });
    h += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:0.68rem;color:var(--text3);">';
    h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' <strong>Key concept:</strong> Base price in PriceLabs is an <em>anchor</em>, not your average nightly rate. PriceLabs dynamically adjusts ±30–80% from this anchor based on demand, weekends, seasons, and lead time. Your actual average daily rate (ADR) from Guesty bookings is the real revenue signal.';
    h += '</div>';
    h += '</div>';
    h += '</div>';
  }

  // Min nights from strategy
  var sMinNights = bestStrat ? (bestStrat.min_nights || 0) : 0;
  if (sMinNights > 0) {
    h += '<div style="display:grid;grid-template-columns:110px 1fr 1fr 80px 16px;gap:0;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;">' +
      '<div style="font-size:0.72rem;color:var(--text3);font-weight:500;">Min Nights</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:0.82rem;color:var(--purple);font-weight:600;">' + (pl.min_nights || '—') + 'n</div>' +
      '<div style="font-family:DM Mono,monospace;font-size:0.82rem;color:var(--accent);font-weight:600;">' + sMinNights + 'n <span style="font-size:0.58rem;background:rgba(16,185,129,0.12);color:var(--accent);padding:1px 4px;border-radius:3px;border:1px solid rgba(16,185,129,0.25);">pushable</span></div>' +
      '<div style="font-family:DM Mono,monospace;font-size:0.78rem;color:var(--text3);text-align:right;">—</div>' +
      '<div></div>' +
    '</div>';
  }

  // Occupancy bars
  h += occBar('Occupancy · next 7d', plOcc7, null);
  h += occBar('Occupancy · next 30d', plOcc30, plMktOcc30);

  // Channels
  if (channelRows) {
    h += '<div style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04);">';
    h += '<div style="font-size:0.65rem;color:var(--text3);margin-bottom:5px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Active Channels</div>';
    h += '<div style="display:flex;gap:5px;flex-wrap:wrap;">' + channelRows + '</div>';
    h += '</div>';
  }

  // Push enabled status
  if (pl.push_enabled !== undefined) {
    var pushOn = !!pl.push_enabled;
    h += '<div style="padding:7px 12px;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-size:0.72rem;color:var(--text3);">Rate Push to Platforms</span>' +
      '<span style="font-size:0.72rem;font-weight:600;color:' + (pushOn ? 'var(--accent)' : 'var(--danger)') + ';">' + (pushOn ? '✓ Enabled' : '✗ Disabled') + '</span>' +
    '</div>';
    if (pl.last_date_pushed) {
      h += '<div style="padding:3px 12px 7px;border-bottom:1px solid rgba(255,255,255,0.04);">' +
        '<div style="font-size:0.65rem;color:var(--text3);">Last pushed: ' + pl.last_date_pushed + '</div>' +
      '</div>';
    }
  }

  // Tags / group
  if (pl.group_name || (pl.tags && pl.tags !== '[]')) {
    var tagStr = '';
    try {
      var tags = typeof pl.tags === 'string' ? JSON.parse(pl.tags || '[]') : (pl.tags || []);
      tagStr = tags.slice(0, 5).map(function(t) {
        return '<span style="font-size:0.65rem;padding:2px 6px;border-radius:4px;background:var(--surface2);border:1px solid var(--border);color:var(--text3);">' + esc(t) + '</span>';
      }).join(' ');
    } catch {}
    h += '<div style="padding:7px 12px;border-bottom:1px solid rgba(255,255,255,0.04);">';
    if (pl.group_name) h += '<div style="font-size:0.68rem;color:var(--text3);margin-bottom:3px;">Group: <strong style="color:var(--text2);">' + esc(pl.group_name) + '</strong></div>';
    if (tagStr) h += '<div style="display:flex;gap:4px;flex-wrap:wrap;">' + tagStr + '</div>';
    h += '</div>';
  }

  // No strategy hint
  h += noStratHint;

  // Footer — drift summary
  var drifts = [];
  if (plBase > 0 && sBase > 0 && Math.abs(sBase - plBase) > 5) drifts.push('base $' + Math.abs(sBase - plBase) + ' ' + (sBase > plBase ? 'low' : 'high'));
  if (plMin > 0 && sMin > 0 && Math.abs(sMin - plMin) > 5) drifts.push('min $' + Math.abs(sMin - plMin) + ' ' + (sMin > plMin ? 'low' : 'high'));
  if (plMax > 0 && sMax > 0 && Math.abs(sMax - plMax) > 5) drifts.push('max $' + Math.abs(sMax - plMax) + ' ' + (sMax > plMax ? 'low' : 'high'));

  // ── Portfolio / siblings panel ───────────────────────────────────────────
  var siblings = pl._siblings || [];
  if (siblings.length > 0) {
    var sibId = 'sib_' + Math.random().toString(36).substring(2, 7);
    h += '<div style="border-top:1px solid var(--border);">';
    h += '<div onclick="toggleCollapsible(\'' + sibId + '\',this)" style="cursor:pointer;padding:7px 12px;display:flex;align-items:center;gap:6px;font-size:0.68rem;color:var(--text3);user-select:none;background:var(--surface2);">';
    h += '<span>▸</span> <strong>' + _ico('building', 13) + ' ' + siblings.length + ' sibling unit' + (siblings.length > 1 ? 's' : '') + ' in this building</strong>';
    h += '<span style="margin-left:auto;font-size:0.62rem;">click to compare</span>';
    h += '</div>';
    h += '<div id="' + sibId + '" style="display:none;">';

    // Mini column header
    h += '<div style="display:grid;grid-template-columns:80px 1fr 1fr 1fr;gap:0;padding:4px 12px;background:var(--surface2);border-bottom:1px solid rgba(255,255,255,0.04);">';
    h += '<div style="font-size:0.6rem;color:var(--text3);text-transform:uppercase;font-weight:600;">Unit</div>';
    h += '<div style="font-size:0.6rem;color:var(--purple);text-transform:uppercase;font-weight:600;">PL Base</div>';
    h += '<div style="font-size:0.6rem;color:var(--accent);text-transform:uppercase;font-weight:600;">Actual ADR</div>';
    h += '<div style="font-size:0.6rem;color:var(--text3);text-transform:uppercase;font-weight:600;">Occ 30d</div>';
    h += '</div>';

    siblings.forEach(function(s) {
      var occColor = 'var(--text3)';
      if (s.pl_occ_30 && s.pl_mkt_occ_30) {
        occColor = parseInt(s.pl_occ_30) >= parseInt(s.pl_mkt_occ_30) ? 'var(--accent)' : 'var(--danger)';
      }
      h += '<div style="display:grid;grid-template-columns:80px 1fr 1fr 1fr;gap:0;padding:6px 12px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;">';
      h += '<div style="font-size:0.72rem;font-weight:600;color:var(--text2);">Unit ' + esc(s.unit_number || '?') + '</div>';
      // PL base
      h += '<div style="font-family:DM Mono,monospace;font-size:0.78rem;color:var(--purple);">' + (s.pl_base ? '$' + s.pl_base + '/nt' : '<span style="color:var(--text3);">—</span>') + '</div>';
      // Actual ADR
      h += '<div style="font-family:DM Mono,monospace;font-size:0.78rem;color:var(--accent);">' + (s.actual_adr ? '$' + Math.round(s.actual_adr) + '/nt' : '<span style="color:var(--text3);">no data</span>') + (s.actual_monthly ? '<br><span style="font-size:0.65rem;color:var(--text3);">$' + Math.round(s.actual_monthly) + '/mo avg</span>' : '') + '</div>';
      // Occ
      h += '<div style="font-size:0.78rem;font-weight:600;color:' + occColor + ';">' + (s.pl_occ_30 ? s.pl_occ_30 + '%' : s.actual_occ ? Math.round(s.actual_occ * 100) + '%' : '—') + (s.pl_mkt_occ_30 ? '<br><span style="font-size:0.62rem;color:var(--text3);">mkt ' + s.pl_mkt_occ_30 + '%</span>' : '') + '</div>';
      h += '</div>';
    });

    // Group note if any siblings share a PL group
    var sibGroups = [...new Set(siblings.filter(function(s){return s.pl_group;}).map(function(s){return s.pl_group;}))];
    if (sibGroups.length > 0) {
      h += '<div style="padding:6px 12px 8px;font-size:0.68rem;color:#f59e0b;background:rgba(245,158,11,0.05);">';
      h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' PriceLabs group rule: sibling(s) are in group <strong>"' + esc(sibGroups.join('", "')) + '"</strong>. Group-level rules (min nights, gap filling, seasonal adjustments) apply to all members and override individual settings. Review in your <a href="https://app.pricelabs.co/" target="_blank" rel="noopener" style="color:#f59e0b;">PriceLabs dashboard</a>.';
      h += '</div>';
    }

    h += '<div style="padding:6px 12px 8px;font-size:0.68rem;color:var(--text3);">';
    h +='' + _ico('zap', 13) + ' Each unit is priced independently — use sibling data to calibrate market ceiling, not to copy rates. If occupancy is low across multiple units simultaneously, consider staggering pricing or checking market-level demand.';
    h += '</div>';

    h += '</div></div>'; // close collapsible + wrapper
  }

  h += '<div style="padding:8px 12px;background:var(--surface2);display:flex;justify-content:space-between;align-items:center;font-size:0.68rem;color:var(--text3);">';
  if (drifts.length > 0 && bestStrat) {
    h += '<span>' + _ico('zap', 13) + ' Analysis vs PriceLabs: ' + drifts.join(' · ') + '</span>';
  } else if (bestStrat) {
    h += '<span style="color:var(--accent);">✓ Analysis and PriceLabs are closely aligned</span>';
  } else {
    h += '<span>Run Price Analysis to see drift</span>';
  }
  h += '<span>Fields marked <span style="color:var(--accent);font-weight:600;">pushable</span> can be updated in PriceLabs · <span style="color:var(--danger);">manual only</span> = change in PriceLabs dashboard</span>';
  h += '</div>';

  h += '</div>';
  return h;
}

// PriceLabs Sync Dashboard
function loadPLSyncDashboard() {
  var el = document.getElementById('plSyncDashboard');
  if (!el) return;

  var h = '<div style="font-size:0.78rem;font-weight:600;color:var(--text2);margin-bottom:8px;">' + _ico('refresh', 13) + ' SYNC & SCHEDULE</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">';

  // Left: Manual sync
  h += '<div>';
  var syncTypes = [
    { key: 'pricelabs_prices', label:'' + _ico('dollarSign', 13) + ' Sync Prices', desc: 'Auto-runs daily. Manual: run after adjusting settings in PriceLabs to see updated rates.' },
    { key: 'pricelabs_listings', label:'' + _ico('receipt', 13) + ' Sync Listings', desc: 'Auto-runs weekly. Manual: run after adding/removing listings in PriceLabs.' },
  ];
  syncTypes.forEach(function(s) {
    h += '<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px;">';
    h += '<button class="btn btn-xs" onclick="runPLSync(\'' + s.key + '\',this)" style="white-space:nowrap;flex-shrink:0;padding:4px 10px;">' + s.label + '</button>';
    h += '<span style="font-size:0.65rem;color:var(--text3);line-height:1.4;padding-top:2px;">' + s.desc + '</span>';
    h += '</div>';
  });
  h += '</div>';

  // Right: Schedule
  h += '<div>';
  var now = new Date();
  var utcH = now.getUTCHours();
  var next6am = new Date(now); next6am.setUTCHours(6, 0, 0, 0);
  if (next6am <= now) next6am.setUTCDate(next6am.getUTCDate() + 1);
  var nextMon = new Date(now); nextMon.setUTCHours(7, 0, 0, 0);
  var daysUntilMon = (1 - nextMon.getUTCDay() + 7) % 7 || 7;
  if (nextMon.getUTCDay() === 1 && nextMon > now) daysUntilMon = 0;
  nextMon.setUTCDate(nextMon.getUTCDate() + daysUntilMon);

  h += '<div style="padding:8px 10px;background:var(--bg);border-radius:6px;font-size:0.68rem;color:var(--text3);line-height:1.6;">';
  h += '<strong style="color:var(--text2);">' + _ico('clock', 13) + ' Auto-Sync Schedule</strong><br>';
  h += 'Prices — daily · next: <strong>' + fmtEST(next6am) + ' ' + getTimezoneAbbr() + '</strong><br>';
  h += 'Listings — weekly Mon · next: <strong>' + fmtEST(nextMon) + ' ' + getTimezoneAbbr() + '</strong>';
  h += '</div>';
  h += '</div>';

  h += '</div>';
  el.innerHTML = h;
}

async function runPLSync(syncType, btn) {
  if (btn) btn.disabled = true;
  toast('Running ' + syncType + '...');
  try {
    var d = await api('/api/sync/run', 'POST', { sync_type: syncType });
    toast(d.message || 'Sync complete');
    loadPLStatus();
  } catch (err) { toast('Sync failed: ' + err.message, 'error'); }
  if (btn) btn.disabled = false;
}
