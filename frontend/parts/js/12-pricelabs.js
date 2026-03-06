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
    h += '<div class="stat-card"><div class="stat-value" style="font-size:0.85rem;">' + (d.last_sync ? d.last_sync.substring(0, 16).replace('T', ' ') : 'never') + '</div><div class="stat-label">Last Sync</div></div>';
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
  if (st) st.innerHTML = '🔍 Fetching preview from PriceLabs...';
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
    h += '<div style="font-size:0.78rem;font-weight:600;color:#f59e0b;margin-bottom:4px;">⚠ ' + data.orphans.length + ' Local Listing(s) Not Found in PriceLabs</div>';
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
  if (st) st.innerHTML = '🔍 Previewing rate pull...';
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
    h += '<div style="font-size:0.78rem;font-weight:600;color:#f59e0b;margin-bottom:4px;">⚠ WHAT GETS REFRESHED</div>';
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
    if (st) st.innerHTML = '🔄 Syncing listings...';
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
    if (st) st.innerHTML = '📊 Fetching rates...';
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
        if (c.min_stay > 1) h += '<div style="font-size:0.55rem;color:var(--text3);">' + c.min_stay + 'n</div>';
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
  h += '<span style="font-size:1.1rem;">📊</span>';
  h += '<strong style="color:var(--purple);">PriceLabs Recommended</strong>';
  h += '<span style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:var(--purple);">$' + plData.avg + '/nt</span>';
  h += '<span style="font-size:0.78rem;color:var(--text3);">(range $' + plData.min + ' – $' + plData.max + ')</span>';
  h += '</div>';
  if (plData.base_price) h += '<span style="font-size:0.78rem;color:var(--text3);margin-right:12px;">Base price: $' + plData.base_price + '</span>';
  if (plData.min_price) h += '<span style="font-size:0.78rem;color:var(--text3);">Min price: $' + plData.min_price + '</span>';
  h += '</div>';
  return h;
}
