// ═══════════════════════════════════════════════════════════════════════════
// 19 — HOSTFULLY IMPORT PIPELINE
// ═══════════════════════════════════════════════════════════════════════════

var _importState = {
  step: 'upload', // upload | map | review | commit
  batchId: null,
  stats: null,
  mappings: null,
  properties: null,
  stagedRows: null,
  summary: null,
};

async function loadImportTab() {
  var el = document.getElementById('importContent');
  if (!el) return;

  // Load stats and batches in parallel
  var [statsRes, batchesRes] = await Promise.all([
    api('/api/import/stats').catch(function() { return {}; }),
    api('/api/import/batches').catch(function() { return { batches: [] }; }),
  ]);

  var h = '';
  h += '<div style="max-width:1100px;margin:0 auto;padding:0 16px;">';

  // Header
  h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">';
  h += '<div style="display:flex;align-items:center;gap:10px;">';
  h += _ico('upload', 22, 'var(--accent)');
  h += '<h2 style="margin:0;font-size:1.2rem;">Historical Data Import</h2>';
  h += '</div>';
  h += '<div style="font-size:0.78rem;color:var(--text3);">Import pre-Guesty reservation data (Hostfully CSV)</div>';
  h += '</div>';

  // Stats summary if we have data
  var st = statsRes.totals || {};
  if (st.total > 0) {
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">';
    h += _importStatCard('Total Rows', st.total, 'database');
    h += _importStatCard('Approved', st.approved || 0, 'checkCircle', 'var(--success)');
    h += _importStatCard('Revenue', '$' + Math.round(st.approved_revenue || 0).toLocaleString(), 'dollarSign', 'var(--accent)');
    h += _importStatCard('Unmapped', st.unmapped || 0, 'alertTriangle', st.unmapped > 0 ? 'var(--warning)' : 'var(--text3)');
    h += '</div>';
  }

  // Step wizard
  h += _importStepWizard();

  // Step content
  h += '<div id="importStepContent"></div>';

  // Import history
  if (batchesRes.batches && batchesRes.batches.length > 0) {
    h += '<div style="margin-top:32px;border-top:1px solid var(--border);padding-top:20px;">';
    h += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px;">';
    h += '<h3 style="font-size:0.95rem;margin:0;display:flex;align-items:center;gap:6px;">' + _ico('clock', 16, 'var(--text3)') + ' Import History</h3>';
    h += '<button class="btn btn-sm" onclick="_importClearAll()" style="font-size:0.72rem;padding:4px 12px;color:var(--danger);border-color:var(--danger);">' + _ico('trash', 13, 'var(--danger)') + ' Clear All & Start Fresh</button>';
    h += '</div>';
    h += '<div style="overflow-x:auto;">';
    h += '<table style="width:100%;font-size:0.82rem;border-collapse:collapse;">';
    h += '<thead><tr style="border-bottom:1px solid var(--border);">';
    h += '<th style="text-align:left;padding:8px 10px;color:var(--text3);font-weight:600;">Batch</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Date</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Total</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Pending</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Dupes</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">New</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Conflicts</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Approved</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Rejected</th>';
    h += '<th style="text-align:right;padding:8px 10px;color:var(--text3);">Actions</th>';
    h += '</tr></thead><tbody>';
    batchesRes.batches.forEach(function(b) {
      var dt = b.imported_at ? new Date(b.imported_at).toLocaleDateString() : '—';
      h += '<tr style="border-bottom:1px solid var(--border);">';
      h += '<td style="padding:8px 10px;font-family:monospace;font-size:0.75rem;">' + esc(b.import_batch) + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;">' + dt + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;font-weight:600;">' + b.total_rows + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;color:var(--text3);">' + (b.pending || 0) + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;color:var(--text3);">' + (b.duplicates || 0) + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;color:var(--success);">' + (b.new_matched || 0) + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;color:var(--warning);">' + (b.conflicts || 0) + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;color:var(--accent);">' + (b.approved || 0) + '</td>';
      h += '<td style="text-align:center;padding:8px 6px;color:var(--danger);">' + (b.rejected || 0) + '</td>';
      h += '<td style="text-align:right;padding:8px 10px;">';
      if (b.approved > 0) h += '<button class="btn btn-sm" style="font-size:0.72rem;padding:3px 8px;" onclick="rollbackBatch(\'' + esc(b.import_batch) + '\')">Rollback</button>';
      h += '</td>';
      h += '</tr>';
    });
    h += '</tbody></table></div></div>';
  }

  h += '</div>';
  el.innerHTML = h;

  // Load initial step
  _importSetStep('upload');
}

function _importStatCard(label, value, icon, color) {
  color = color || 'var(--text)';
  return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">' +
    '<div style="font-size:0.72rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">' + label + '</div>' +
    '<div style="font-size:1.3rem;font-weight:700;color:' + color + ';display:flex;align-items:center;gap:6px;">' + _ico(icon, 16, color) + ' ' + value + '</div>' +
    '</div>';
}

function _importStepWizard() {
  var steps = [
    { id: 'upload', label: 'Upload CSV', icon: 'upload' },
    { id: 'map', label: 'Map Properties', icon: 'mapPin' },
    { id: 'review', label: 'Review & Approve', icon: 'checkSquare' },
    { id: 'commit', label: 'Commit', icon: 'database' },
  ];
  var h = '<div id="importWizardSteps" style="display:flex;gap:2px;margin-bottom:20px;background:var(--surface2);border-radius:10px;overflow:hidden;border:1px solid var(--border);">';
  steps.forEach(function(s, i) {
    h += '<button id="importStep_' + s.id + '" class="import-step-btn" data-step="' + s.id + '" onclick="_importSetStep(\'' + s.id + '\')" ' +
      'style="flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 8px;border:none;background:transparent;color:var(--text3);cursor:pointer;font-size:0.82rem;font-weight:500;transition:all 0.2s;position:relative;">' +
      '<span style="display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--bg);font-size:0.7rem;font-weight:700;color:var(--text3);flex-shrink:0;">' + (i + 1) + '</span>' +
      '<span class="step-label">' + s.label + '</span>' +
      '</button>';
  });
  h += '</div>';
  return h;
}

function _importSetStep(step) {
  _importState.step = step;
  // Update wizard button styles
  document.querySelectorAll('.import-step-btn').forEach(function(btn) {
    var isActive = btn.dataset.step === step;
    btn.style.background = isActive ? 'var(--accent)' : 'transparent';
    btn.style.color = isActive ? '#fff' : 'var(--text3)';
    var circle = btn.querySelector('span');
    if (circle) {
      circle.style.background = isActive ? 'rgba(255,255,255,0.25)' : 'var(--bg)';
      circle.style.color = isActive ? '#fff' : 'var(--text3)';
    }
  });

  var el = document.getElementById('importStepContent');
  if (!el) return;

  if (step === 'upload') _renderUploadStep(el);
  else if (step === 'map') _renderMapStep(el);
  else if (step === 'review') _renderReviewStep(el);
  else if (step === 'commit') _renderCommitStep(el);
}

// ── Step 1: Upload CSV ──────────────────────────────────────────────────

function _renderUploadStep(el) {
  var h = '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:28px;">';
  h += '<h3 style="margin:0 0 6px;font-size:1rem;">Upload Hostfully CSV</h3>';
  h += '<p style="color:var(--text3);font-size:0.82rem;margin:0 0 20px;">Export your Hostfully reservation data as CSV and upload it here. Column headers are matched by name — order doesn\'t matter.</p>';

  // Drop zone
  h += '<div id="importDropZone" ondrop="_importHandleDrop(event)" ondragover="_importDragOver(event)" ondragleave="_importDragLeave(event)" ' +
    'style="border:2px dashed var(--border);border-radius:10px;padding:40px 20px;text-align:center;cursor:pointer;transition:all 0.2s;" onclick="document.getElementById(\'importFileInput\').click()">';
  h += '<div style="margin-bottom:12px;">' + _ico('upload', 36, 'var(--text3)') + '</div>';
  h += '<div style="font-size:0.9rem;color:var(--text2);margin-bottom:6px;">Drop CSV file here or click to browse</div>';
  h += '<div style="font-size:0.75rem;color:var(--text3);">Supports: .csv files exported from Hostfully</div>';
  h += '<input type="file" id="importFileInput" accept=".csv" style="display:none;" onchange="_importFileSelected(this)">';
  h += '</div>';

  // Status area
  h += '<div id="importUploadStatus" style="margin-top:16px;"></div>';
  h += '</div>';
  el.innerHTML = h;
}

function _importDragOver(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--accent)';
  e.currentTarget.style.background = 'rgba(74,227,181,0.05)';
}

function _importDragLeave(e) {
  e.currentTarget.style.borderColor = 'var(--border)';
  e.currentTarget.style.background = 'transparent';
}

function _importHandleDrop(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--border)';
  e.currentTarget.style.background = 'transparent';
  var file = e.dataTransfer.files[0];
  if (file) _importProcessFile(file);
}

function _importFileSelected(input) {
  var file = input.files[0];
  if (file) _importProcessFile(file);
}

async function _importProcessFile(file) {
  var statusEl = document.getElementById('importUploadStatus');
  if (!statusEl) return;
  statusEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px;padding:12px;background:var(--bg);border-radius:8px;">' +
    '<div class="spinner" style="width:18px;height:18px;"></div>' +
    '<span style="font-size:0.85rem;">Parsing ' + esc(file.name) + ' (' + Math.round(file.size / 1024) + ' KB)...</span></div>';

  try {
    var text = await file.text();
    var result = await api('/api/import/hostfully', 'POST', { csv: text });

    if (result.error) {
      statusEl.innerHTML = '<div style="padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;color:#ef4444;font-size:0.85rem;">' +
        _ico('alertTriangle', 14, '#ef4444') + ' ' + esc(result.error) + '</div>';
      return;
    }

    _importState.batchId = result.batch_id;

    var h = '<div style="padding:16px;background:rgba(74,227,181,0.08);border:1px solid rgba(74,227,181,0.25);border-radius:10px;">';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' + _ico('checkCircle', 18, 'var(--success)') + '<strong style="color:var(--success);">Upload Successful</strong></div>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;">';
    h += '<div style="font-size:0.82rem;"><span style="color:var(--text3);">Rows parsed:</span> <strong>' + result.rows_parsed + '</strong></div>';
    h += '<div style="font-size:0.82rem;"><span style="color:var(--text3);">Inserted:</span> <strong>' + result.rows_inserted + '</strong></div>';
    h += '<div style="font-size:0.82rem;"><span style="color:var(--text3);">Skipped:</span> <strong>' + result.rows_skipped + '</strong></div>';
    if (result.airbnb_skipped > 0) {
      h += '<div style="font-size:0.82rem;"><span style="color:var(--text3);">Airbnb (auto-skipped):</span> <strong style="color:var(--text3);">' + result.airbnb_skipped + '</strong></div>';
    }
    h += '<div style="font-size:0.82rem;"><span style="color:var(--text3);">Properties:</span> <strong>' + result.unique_properties + '</strong></div>';
    h += '</div>';

    if (result.errors && result.errors.length > 0) {
      h += '<details style="margin-top:8px;"><summary style="cursor:pointer;font-size:0.78rem;color:var(--warning);">' + result.errors.length + ' parsing warnings</summary>';
      h += '<div style="margin-top:6px;font-size:0.75rem;color:var(--text3);max-height:120px;overflow-y:auto;">';
      result.errors.forEach(function(e) { h += '<div>' + esc(e) + '</div>'; });
      h += '</div></details>';
    }

    // Column detection info
    if (result.column_detection) {
      var cd = result.column_detection;
      var missing = [];
      if (!cd.airbnb_confirmation) missing.push('Airbnb Confirmation Code');
      if (!cd.check_out) missing.push('Check-out Date');
      if (!cd.total_amount) missing.push('Total Amount');

      h += '<details style="margin-top:8px;"><summary style="cursor:pointer;font-size:0.78rem;color:' + (missing.length > 0 ? 'var(--warning)' : 'var(--text3)') + ';">Column Detection' + (missing.length > 0 ? ' ⚠ ' + missing.length + ' missing' : ' ✓') + '</summary>';
      h += '<div style="margin-top:6px;font-size:0.75rem;color:var(--text3);">';
      var colItems = [
        ['Property Name', cd.property_name],
        ['Airbnb Confirmation', cd.airbnb_confirmation],
        ['Check-in', cd.check_in],
        ['Check-out', cd.check_out],
        ['Source/Channel', cd.source],
        ['Rental Amount', cd.rental_amount],
        ['Total Amount', cd.total_amount],
      ];
      colItems.forEach(function(ci) {
        var found = ci[1];
        h += '<div style="display:flex;gap:6px;padding:2px 0;">';
        h += '<span style="color:' + (found ? 'var(--success)' : 'var(--danger)') + ';">' + (found ? '✓' : '✗') + '</span>';
        h += '<span>' + ci[0] + ': ' + (found ? '<code style="background:var(--bg);padding:1px 4px;border-radius:3px;">' + esc(found) + '</code>' : '<em>not found</em>') + '</span>';
        h += '</div>';
      });
      h += '</div></details>';
    }

    // Show detected properties
    if (result.properties && result.properties.length > 0) {
      h += '<div style="margin-top:12px;"><div style="font-size:0.78rem;color:var(--text3);margin-bottom:6px;">DETECTED PROPERTIES:</div>';
      h += '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
      result.properties.forEach(function(p) {
        h += '<span style="display:inline-flex;align-items:center;gap:4px;padding:3px 10px;background:var(--bg);border-radius:12px;font-size:0.75rem;">' +
          esc(p.hostfully_property_name) + ' <span style="color:var(--accent);font-weight:600;">(' + p.row_count + ')</span></span>';
      });
      h += '</div></div>';
    }

    h += '<div style="margin-top:16px;text-align:right;">';
    h += '<button class="btn btn-primary" onclick="_importSetStep(\'map\')" style="padding:8px 20px;">Next: Map Properties →</button>';
    h += '</div>';
    h += '</div>';
    statusEl.innerHTML = h;
  } catch (err) {
    statusEl.innerHTML = '<div style="padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;color:#ef4444;font-size:0.85rem;">' +
      _ico('alertTriangle', 14, '#ef4444') + ' Upload failed: ' + esc(err.message || 'Unknown error') + '</div>';
  }
}

// ── Step 2: Map Properties ──────────────────────────────────────────────

async function _renderMapStep(el) {
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3);"><div class="spinner" style="width:24px;height:24px;margin:0 auto 12px;"></div>Loading property mappings...</div>';

  try {
    var data = await api('/api/import/property-mappings');
    _importState.mappings = data.mappings || [];
    _importState.properties = data.properties || [];

    var unmapped = data.unmapped || [];
    var h = '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:24px;">';
    h += '<h3 style="margin:0 0 6px;font-size:1rem;">Map Hostfully Properties</h3>';
    h += '<p style="color:var(--text3);font-size:0.82rem;margin:0 0 16px;">Match each Hostfully property name to a PMR property. Mappings are saved and reused for future imports.</p>';

    if (unmapped.length === 0 && _importState.mappings.length === 0) {
      h += '<div style="padding:20px;text-align:center;color:var(--text3);font-size:0.85rem;">No Hostfully properties found. Upload a CSV first.</div>';
      h += '</div>';
      el.innerHTML = h;
      return;
    }

    // Build property options HTML once
    var propOpts = '<option value="">— Select PMR Property —</option>';
    (_importState.properties || []).forEach(function(p) {
      var label = p.unit_number ? p.unit_number + ' — ' : '';
      label += p.platform_listing_name || p.name || p.address || 'Property #' + p.id;
      if (p.city) label += ' (' + p.city + ')';
      propOpts += '<option value="' + p.id + '">' + esc(label) + '</option>';
    });

    // Unmapped properties
    if (unmapped.length > 0) {
      h += '<div style="margin-bottom:20px;">';
      h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">' + _ico('alertTriangle', 15, 'var(--warning)') + '<span style="font-size:0.85rem;font-weight:600;color:var(--warning);">' + unmapped.length + ' Unmapped Properties</span></div>';

      unmapped.forEach(function(u, idx) {
        h += '<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg);border-radius:8px;margin-bottom:6px;flex-wrap:wrap;">';
        h += '<div style="flex:1;min-width:200px;">';
        h += '<div style="font-size:0.85rem;font-weight:500;">' + esc(u.hostfully_property_name) + '</div>';
        h += '<div style="font-size:0.72rem;color:var(--text3);">' + u.row_count + ' reservations</div>';
        h += '</div>';
        h += '<select id="mapProp_' + idx + '" data-extname="' + esc(u.hostfully_property_name) + '" style="flex:1;min-width:200px;padding:7px 10px;font-size:0.82rem;background:var(--surface);border:1px solid var(--border);border-radius:6px;color:var(--text);">' + propOpts + '</select>';
        h += '</div>';
      });
      h += '</div>';
    }

    // Already mapped
    if (_importState.mappings.length > 0) {
      h += '<details style="margin-bottom:16px;"><summary style="cursor:pointer;font-size:0.85rem;font-weight:500;color:var(--accent);">' + _importState.mappings.length + ' Already Mapped</summary>';
      h += '<div style="margin-top:8px;">';
      _importState.mappings.forEach(function(m) {
        var pLabel = m.unit_number ? m.unit_number + ' — ' : '';
        pLabel += m.platform_listing_name || m.property_name || m.property_address || 'Property #' + m.property_id;
        h += '<div style="display:flex;justify-content:space-between;padding:6px 10px;font-size:0.82rem;border-bottom:1px solid var(--border);">';
        h += '<span style="color:var(--text2);">' + esc(m.external_name) + '</span>';
        h += '<span style="color:var(--accent);">→ ' + esc(pLabel) + '</span>';
        h += '</div>';
      });
      h += '</div></details>';
    }

    // Actions
    h += '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;">';
    h += '<button class="btn btn-secondary" onclick="_importSetStep(\'upload\')" style="padding:8px 16px;">← Back</button>';
    if (unmapped.length > 0) {
      h += '<button class="btn btn-primary" onclick="_importSaveMappings()" style="padding:8px 20px;">Save Mappings</button>';
    }
    h += '<button class="btn btn-primary" onclick="_importRunDedup()" style="padding:8px 20px;">Run Dedup & Continue →</button>';
    h += '</div>';

    h += '</div>';
    el.innerHTML = h;
  } catch (err) {
    el.innerHTML = '<div style="padding:16px;color:#ef4444;">Error loading mappings: ' + esc(err.message) + '</div>';
  }
}

async function _importSaveMappings() {
  var mappings = [];
  document.querySelectorAll('[id^="mapProp_"]').forEach(function(sel) {
    var propId = parseInt(sel.value);
    var extName = sel.dataset.extname;
    if (propId && extName) mappings.push({ external_name: extName, property_id: propId });
  });

  if (mappings.length === 0) {
    toast('Select at least one property mapping', 'warn');
    return;
  }

  try {
    var result = await api('/api/import/property-mappings', 'POST', { mappings: mappings });
    toast('Saved ' + result.saved + ' mappings', 'ok');
    // Reload step to show updated state
    _renderMapStep(document.getElementById('importStepContent'));
  } catch (err) {
    toast('Failed to save: ' + err.message, 'error');
  }
}

async function _importRunDedup() {
  var el = document.getElementById('importStepContent');
  el.innerHTML = '<div style="text-align:center;padding:40px;"><div class="spinner" style="width:24px;height:24px;margin:0 auto 12px;"></div><div style="color:var(--text3);font-size:0.85rem;">Running deduplication engine...</div><div style="color:var(--text3);font-size:0.75rem;margin-top:4px;">Matching against Guesty reservations by confirmation code, dates, and amounts</div></div>';

  try {
    var result = await api('/api/import/run-dedup', 'POST', { batch_id: _importState.batchId, re_run: true });
    _importState.stats = result.stats;
    toast('Dedup complete: ' + (result.stats.duplicates || 0) + ' duplicates, ' + (result.stats.new_matched || 0) + ' new, ' + (result.stats.conflicts || 0) + ' conflicts', 'ok');
    _importSetStep('review');
  } catch (err) {
    el.innerHTML = '<div style="padding:16px;color:#ef4444;">Dedup failed: ' + esc(err.message) + '</div>';
  }
}

// ── Step 3: Review & Approve ────────────────────────────────────────────

async function _renderReviewStep(el) {
  el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3);"><div class="spinner" style="width:24px;height:24px;margin:0 auto 12px;"></div>Loading staged reservations...</div>';

  try {
    var data = await api('/api/import/staged');
    _importState.stagedRows = data.rows || [];
    _importState.summary = data.summary || {};
    var s = _importState.summary;

    var h = '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:24px;">';
    h += '<h3 style="margin:0 0 12px;font-size:1rem;">Review Staged Reservations</h3>';

    // Status summary cards
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:16px;">';
    h += _importReviewCard('Total', s.total || 0, 'var(--text)');
    h += _importReviewCard('Pending', s.pending || 0, 'var(--text3)');
    h += _importReviewCard('Duplicates', s.duplicate || 0, '#6b7280');
    h += _importReviewCard('New', s.matched || 0, 'var(--success)');
    h += _importReviewCard('Conflicts', s.conflict || 0, 'var(--warning)');
    h += _importReviewCard('Approved', s.approved || 0, 'var(--accent)');
    h += _importReviewCard('Rejected', s.rejected || 0, 'var(--danger)');
    h += '</div>';

    // Bulk actions
    h += '<div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">';
    h += '<span style="font-size:0.78rem;color:var(--text3);margin-right:4px;">Bulk:</span>';
    if (s.matched > 0) h += '<button class="btn btn-sm btn-primary" onclick="_importBulkApprove(\'matched\')" style="font-size:0.75rem;padding:4px 10px;">Approve All New (' + s.matched + ')</button>';
    if (s.duplicate > 0) h += '<button class="btn btn-sm" onclick="_importBulkReject(\'duplicate\')" style="font-size:0.75rem;padding:4px 10px;">Reject All Duplicates (' + s.duplicate + ')</button>';
    if (s.pending > 0) h += '<button class="btn btn-sm" onclick="_importBulkApprove(\'pending\')" style="font-size:0.75rem;padding:4px 10px;">Approve All Pending (' + s.pending + ')</button>';

    // Filter
    h += '<div style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">';
    h += '<label style="font-size:0.75rem;color:var(--text3);">Status:</label>';
    h += '<select id="importStatusFilter" onchange="_importFilterRows()" style="padding:4px 8px;font-size:0.78rem;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);">';
    h += '<option value="">All</option><option value="pending">Pending</option><option value="matched">New</option><option value="duplicate">Duplicate</option><option value="conflict">Conflict</option><option value="approved">Approved</option><option value="rejected">Rejected</option>';
    h += '</select>';

    // Source filter — build from actual data
    var sources = {};
    (_importState.stagedRows || []).forEach(function(r) { if (r.source) sources[r.source] = (sources[r.source] || 0) + 1; });
    var sourceKeys = Object.keys(sources).sort();
    if (sourceKeys.length > 1) {
      h += '<label style="font-size:0.75rem;color:var(--text3);margin-left:8px;">Source:</label>';
      h += '<select id="importSourceFilter" onchange="_importFilterRows()" style="padding:4px 8px;font-size:0.78rem;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);">';
      h += '<option value="">All</option>';
      sourceKeys.forEach(function(s) { h += '<option value="' + esc(s.toLowerCase()) + '">' + esc(s) + ' (' + sources[s] + ')</option>'; });
      h += '</select>';
    }
    h += '</div>';
    h += '</div>';

    // Table
    h += '<div style="overflow-x:auto;max-height:500px;overflow-y:auto;">';
    h += '<table style="width:100%;font-size:0.78rem;border-collapse:collapse;">';
    h += '<thead style="position:sticky;top:0;background:var(--surface2);z-index:1;"><tr style="border-bottom:1px solid var(--border);">';
    h += '<th style="text-align:left;padding:8px 6px;color:var(--text3);font-weight:600;">Status</th>';
    h += '<th style="text-align:left;padding:8px 6px;color:var(--text3);">Property</th>';
    h += '<th style="text-align:left;padding:8px 6px;color:var(--text3);">Guest</th>';
    h += '<th style="text-align:left;padding:8px 6px;color:var(--text3);">Source</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Check-in</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Nights</th>';
    h += '<th style="text-align:right;padding:8px 6px;color:var(--text3);">Revenue</th>';
    h += '<th style="text-align:right;padding:8px 6px;color:var(--text3);">Payout</th>';
    h += '<th style="text-align:center;padding:8px 6px;color:var(--text3);">Reason</th>';
    h += '<th style="text-align:right;padding:8px 6px;color:var(--text3);">Action</th>';
    h += '</tr></thead>';
    h += '<tbody id="importRowsBody">';
    h += _importRenderRows(_importState.stagedRows);
    h += '</tbody></table></div>';

    // Navigation
    h += '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap;">';
    h += '<button class="btn btn-secondary" onclick="_importSetStep(\'map\')" style="padding:8px 16px;">← Back</button>';
    h += '<button class="btn btn-primary" onclick="_importSetStep(\'commit\')" style="padding:8px 20px;">Next: Commit →</button>';
    h += '</div>';

    h += '</div>';
    el.innerHTML = h;
  } catch (err) {
    el.innerHTML = '<div style="padding:16px;color:#ef4444;">Error loading staged data: ' + esc(err.message) + '</div>';
  }
}

function _importRenderRows(rows) {
  if (!rows || rows.length === 0) return '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--text3);">No rows</td></tr>';
  var h = '';
  rows.forEach(function(r) {
    var statusColor = { pending: 'var(--text3)', duplicate: '#6b7280', matched: 'var(--success)', conflict: 'var(--warning)', approved: 'var(--accent)', rejected: 'var(--danger)' }[r.status] || 'var(--text3)';
    var statusLabel = { pending: 'Pending', duplicate: 'Duplicate', matched: 'New', conflict: 'Conflict', approved: 'Approved', rejected: 'Rejected' }[r.status] || r.status;
    var propLabel = r.unit_number ? r.unit_number + ' — ' : '';
    propLabel += r.platform_listing_name || r.property_name || r.property_address || r.hostfully_property_name || '—';

    h += '<tr data-import-status="' + r.status + '" data-import-source="' + esc((r.source || '').toLowerCase()) + '" style="border-bottom:1px solid var(--border);">';
    h += '<td style="padding:6px;"><span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:600;color:#fff;background:' + statusColor + ';">' + statusLabel + '</span></td>';
    h += '<td style="padding:6px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(propLabel) + '">' + esc(propLabel) + '</td>';
    h += '<td style="padding:6px;">' + esc((r.guest_first || '') + ' ' + (r.guest_last || '')).trim() + '</td>';
    h += '<td style="padding:6px;">' + esc(r.source || '—') + '</td>';
    h += '<td style="text-align:center;padding:6px;">' + (r.check_in || '—') + '</td>';
    h += '<td style="text-align:center;padding:6px;">' + (r.nights || '—') + '</td>';
    h += '<td style="text-align:right;padding:6px;font-family:monospace;">$' + Math.round(r.rental_amount || 0).toLocaleString() + '</td>';
    h += '<td style="text-align:right;padding:6px;font-family:monospace;">$' + Math.round(r.host_payout || 0).toLocaleString() + '</td>';
    h += '<td style="text-align:center;padding:6px;font-size:0.7rem;color:var(--text3);max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="' + esc(r.dedup_reason || '') + '">' + esc(r.dedup_reason || '—') + '</td>';
    h += '<td style="text-align:right;padding:6px;white-space:nowrap;">';
    if (r.status !== 'approved') h += '<button class="btn btn-sm" onclick="_importApproveRow(' + r.id + ')" style="font-size:0.68rem;padding:2px 6px;color:var(--success);border-color:var(--success);" title="Approve">✓</button> ';
    if (r.status !== 'rejected') h += '<button class="btn btn-sm" onclick="_importRejectRow(' + r.id + ')" style="font-size:0.68rem;padding:2px 6px;color:var(--danger);border-color:var(--danger);" title="Reject">✗</button>';
    h += '</td>';
    h += '</tr>';
  });
  return h;
}

function _importReviewCard(label, count, color) {
  // Map display label → actual status value for filtering
  var filterMap = { 'Total': '', 'Pending': 'pending', 'Duplicates': 'duplicate', 'New': 'matched', 'Conflicts': 'conflict', 'Approved': 'approved', 'Rejected': 'rejected' };
  var filterVal = filterMap[label] || '';
  return '<div style="text-align:center;padding:10px;background:var(--bg);border-radius:8px;cursor:pointer;" onclick="var f=document.getElementById(\'importStatusFilter\');if(f){f.value=\'' + filterVal + '\';_importFilterRows();}">' +
    '<div style="font-size:1.2rem;font-weight:700;color:' + color + ';">' + count + '</div>' +
    '<div style="font-size:0.7rem;color:var(--text3);">' + label + '</div></div>';
}

function _importFilterRows() {
  var statusFilter = document.getElementById('importStatusFilter').value;
  var sourceEl = document.getElementById('importSourceFilter');
  var sourceFilter = sourceEl ? sourceEl.value : '';
  document.querySelectorAll('#importRowsBody tr[data-import-status]').forEach(function(row) {
    var statusMatch = !statusFilter || row.dataset.importStatus === statusFilter;
    var sourceMatch = !sourceFilter || row.dataset.importSource === sourceFilter;
    row.style.display = (statusMatch && sourceMatch) ? '' : 'none';
  });
}

async function _importApproveRow(id) {
  try {
    await api('/api/import/approve', 'POST', { ids: [id] });
    _renderReviewStep(document.getElementById('importStepContent'));
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function _importRejectRow(id) {
  try {
    await api('/api/import/reject', 'POST', { ids: [id] });
    _renderReviewStep(document.getElementById('importStepContent'));
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function _importBulkApprove(statusFilter) {
  if (!confirm('Approve all "' + statusFilter + '" rows?')) return;
  try {
    var result = await api('/api/import/approve', 'POST', { status_filter: statusFilter });
    toast('Approved ' + result.affected + ' rows', 'ok');
    _renderReviewStep(document.getElementById('importStepContent'));
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function _importBulkReject(statusFilter) {
  if (!confirm('Reject all "' + statusFilter + '" rows?')) return;
  try {
    var result = await api('/api/import/reject', 'POST', { status_filter: statusFilter });
    toast('Rejected ' + result.affected + ' rows', 'ok');
    _renderReviewStep(document.getElementById('importStepContent'));
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ── Step 4: Commit ──────────────────────────────────────────────────────

async function _renderCommitStep(el) {
  // Refresh summary
  var data = await api('/api/import/staged').catch(function() { return { summary: {} }; });
  var s = data.summary || {};

  var h = '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:28px;">';
  h += '<h3 style="margin:0 0 12px;font-size:1rem;">Commit Import</h3>';
  h += '<p style="color:var(--text3);font-size:0.82rem;margin:0 0 20px;">This will rebuild monthly actuals by merging Guesty data with your approved Hostfully reservations. The process is idempotent — running it again produces the same result.</p>';

  // Summary
  h += '<div style="background:var(--bg);border-radius:10px;padding:16px;margin-bottom:20px;">';
  h += '<div style="font-size:0.78rem;color:var(--text3);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:10px;">COMMIT SUMMARY</div>';
  h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.85rem;">';
  h += '<div>Approved reservations: <strong style="color:var(--accent);">' + (s.approved || 0) + '</strong></div>';
  h += '<div>Pending (won\'t be included): <strong>' + (s.pending || 0) + '</strong></div>';
  h += '<div>Duplicates rejected: <strong>' + (s.duplicate || 0) + '</strong></div>';
  h += '<div>Conflicts: <strong style="color:var(--warning);">' + (s.conflict || 0) + '</strong></div>';
  h += '</div>';
  h += '</div>';

  if ((s.conflict || 0) > 0) {
    h += '<div style="padding:10px 14px;margin-bottom:16px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);border-radius:8px;font-size:0.82rem;color:var(--warning);">' +
      _ico('alertTriangle', 14, 'var(--warning)') + ' ' + s.conflict + ' conflicts remain unresolved. Go back to Review to approve or reject them before committing.</div>';
  }

  if ((s.pending || 0) > 0) {
    h += '<div style="padding:10px 14px;margin-bottom:16px;background:rgba(107,114,128,0.1);border:1px solid rgba(107,114,128,0.25);border-radius:8px;font-size:0.82rem;color:var(--text3);">' +
      _ico('info', 14, 'var(--text3)') + ' ' + s.pending + ' rows are still pending. Run dedup first or approve/reject them manually.</div>';
  }

  h += '<div id="importCommitStatus"></div>';

  h += '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap;">';
  h += '<button class="btn btn-secondary" onclick="_importSetStep(\'review\')" style="padding:8px 16px;">← Back</button>';
  h += '<button class="btn btn-primary" id="importCommitBtn" onclick="_importDoCommit()" style="padding:10px 24px;font-size:0.9rem;">' +
    _ico('database', 15, '#fff') + ' Rebuild Monthly Actuals</button>';
  h += '</div>';

  h += '</div>';
  el.innerHTML = h;
}

async function _importDoCommit() {
  var btn = document.getElementById('importCommitBtn');
  var statusEl = document.getElementById('importCommitStatus');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;display:inline-block;"></div> Rebuilding...'; }

  try {
    var result = await api('/api/import/commit', 'POST', {});

    var h = '<div style="padding:16px;background:rgba(74,227,181,0.08);border:1px solid rgba(74,227,181,0.25);border-radius:10px;margin-top:12px;">';
    h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' + _ico('checkCircle', 20, 'var(--success)') + '<strong style="color:var(--success);font-size:0.95rem;">Commit Successful</strong></div>';
    h += '<div style="font-size:0.85rem;color:var(--text2);">';
    h += 'Guesty actuals rebuilt: <strong>✓</strong><br>';
    h += 'Hostfully reservations merged: <strong>' + result.hostfully_merged + '</strong><br>';
    h += 'Property-months affected: <strong>' + result.property_months_affected + '</strong>';
    h += '</div>';
    h += '<div style="margin-top:12px;font-size:0.78rem;color:var(--text3);">Monthly actuals now include both Guesty and Hostfully data. YoY Performance should reflect the complete history.</div>';
    h += '</div>';
    if (statusEl) statusEl.innerHTML = h;

    if (btn) { btn.disabled = false; btn.innerHTML = _ico('checkCircle', 15, '#fff') + ' Done — Rebuild Again'; }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = '<div style="padding:12px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;color:#ef4444;font-size:0.85rem;margin-top:12px;">Commit failed: ' + esc(err.message) + '</div>';
    if (btn) { btn.disabled = false; btn.innerHTML = _ico('database', 15, '#fff') + ' Retry Commit'; }
  }
}

// ── Rollback ────────────────────────────────────────────────────────────

async function rollbackBatch(batchId) {
  if (!confirm('Rollback batch ' + batchId + '? This will reject all rows in this batch and rebuild monthly actuals without them.')) return;
  try {
    var result = await api('/api/import/rollback', 'POST', { batch_id: batchId });
    toast('Rolled back ' + result.affected + ' rows. Actuals rebuilt.', 'ok');
    loadImportTab(); // Reload entire tab
  } catch (err) {
    toast('Rollback failed: ' + err.message, 'error');
  }
}

async function _importClearAll() {
  if (!confirm('⚠️ CLEAR ALL IMPORT DATA?\n\nThis will permanently delete:\n• All Hostfully reservations\n• All property name mappings\n\nMonthly actuals will be rebuilt from Guesty data only.\n\nThis cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Type OK to confirm you want to delete all import data and start fresh.')) return;

  try {
    var result = await api('/api/import/clear-all', 'POST', { confirm: 'DELETE_ALL_IMPORT_DATA' });
    toast('Cleared ' + result.deleted_reservations + ' reservations and ' + result.deleted_mappings + ' mappings. Actuals rebuilt.', 'ok');
    _importState.batchId = null;
    _importState.stats = null;
    _importState.stagedRows = null;
    _importState.summary = null;
    loadImportTab(); // Full reload
  } catch (err) {
    toast('Clear failed: ' + err.message, 'error');
  }
}
