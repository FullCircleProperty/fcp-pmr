// Admin: RentCast Usage
async function loadRcUsage() {
  var el = document.getElementById('rcUsagePanel');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text3);">Loading...</p>';
  try {
    var d = await api('/api/admin/rentcast-usage');
    var pct = d.limit > 0 ? Math.round((d.used / d.limit) * 100) : 0;
    var barColor = pct >= 90 ? 'var(--danger)' : pct >= 70 ? '#f59e0b' : 'var(--accent)';
    var h = '';

    // Usage bar
    h += '<div style="margin-bottom:16px;">';
    h += '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:0.85rem;"><span><strong>' + d.used + '</strong> / ' + d.limit + ' calls used</span><span style="color:var(--text3);">' + d.remaining + ' remaining</span></div>';
    h += '<div style="height:10px;background:var(--bg);border-radius:5px;overflow:hidden;"><div style="height:100%;width:' + Math.min(pct, 100) + '%;background:' + barColor + ';border-radius:5px;transition:width 0.3s;"></div></div>';
    h += '<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:0.78rem;color:var(--text3);">';
    h += '<span>Resets: ' + d.reset_date + ' (' + d.days_until_reset + ' days)</span>';
    h += '<span>Overage: $' + d.overage_cost_per_call + '/call</span>';
    h += '</div></div>';

    // Warning if close to limit
    if (pct >= 80) {
      h += '<div style="padding:10px 14px;margin-bottom:14px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:8px;font-size:0.85rem;color:#ef4444;">';
      if (pct >= 100) h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' Limit reached! RentCast calls are blocked until ' + d.reset_date + '. Increase the limit below or wait for reset.';
      else h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' ' + d.remaining + ' calls remaining this month. Consider budgeting remaining calls carefully.';
      h += '</div>';
    }

    // Adjust limit
    h += '<div style="margin-bottom:16px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;">';
    h += '<label style="font-size:0.78rem;color:var(--text2);display:block;margin-bottom:6px;">MONTHLY CALL LIMIT</label>';
    h += '<div style="display:flex;gap:8px;align-items:center;">';
    h += '<input type="number" id="rcLimitInput" value="' + d.limit + '" min="0" max="10000" style="width:100px;padding:6px 10px;font-size:0.85rem;">';
    h += '<button class="btn btn-sm btn-primary" onclick="saveRcLimit()">Update</button>';
    h += '<span id="rcLimitStatus" style="font-size:0.78rem;color:var(--accent);"></span>';
    h += '</div>';
    h += '<div style="margin-top:6px;font-size:0.75rem;color:var(--text3);">Free tier: 50/mo. Each call over the limit costs ~$0.01. Set higher to allow more lookups, comps & market fetches.</div>';
    h += '</div>';

    // Usage by endpoint
    if (d.by_endpoint && Object.keys(d.by_endpoint).length > 0) {
      h += '<div style="margin-bottom:14px;"><h4 style="font-size:0.85rem;margin-bottom:6px;">By Feature</h4>';
      for (var ep in d.by_endpoint) {
        h += '<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:0.82rem;"><span>' + esc(ep.replace(/_/g, ' ')) + '</span><span style="color:var(--accent);font-family:monospace;">' + d.by_endpoint[ep] + '</span></div>';
      }
      h += '</div>';
    }

    // Daily breakdown
    if (d.daily && d.daily.length > 0) {
      h += '<div style="margin-bottom:14px;"><h4 style="font-size:0.85rem;margin-bottom:6px;">Daily Usage</h4>';
      h += '<div style="display:flex;gap:4px;align-items:flex-end;height:60px;">';
      var maxD = Math.max.apply(null, d.daily.map(function(x) { return x.c; }));
      d.daily.forEach(function(day) {
        var barH = maxD > 0 ? Math.max(4, (day.c / maxD) * 56) : 4;
        h += '<div title="' + day.d + ': ' + day.c + ' calls" style="flex:1;background:var(--accent);border-radius:2px 2px 0 0;height:' + barH + 'px;min-width:6px;"></div>';
      });
      h += '</div>';
      h += '<div style="display:flex;justify-content:space-between;font-size:0.65rem;color:var(--text3);margin-top:2px;"><span>' + (d.daily[0] || {}).d + '</span><span>' + (d.daily[d.daily.length - 1] || {}).d + '</span></div>';
      h += '</div>';
    }

    // Recent calls
    if (d.recent && d.recent.length > 0) {
      h += '<div><h4 style="font-size:0.85rem;margin-bottom:6px;">Recent Calls</h4>';
      h += '<div style="max-height:180px;overflow-y:auto;">';
      d.recent.forEach(function(r) {
        var ok = r.success === 1;
        h += '<div style="display:flex;gap:6px;align-items:center;padding:3px 0;font-size:0.75rem;border-bottom:1px solid var(--border);">';
        h += '<span style="color:' + (ok ? 'var(--accent)' : 'var(--danger)') + ';">' + (ok ? '✓' : '✗') + '</span>';
        h += '<span style="color:var(--text3);">' + fmtUTC(r.created_at) + '</span>';
        h += '<span>' + esc(r.endpoint || '') + '</span>';
        if (r.city) h += '<span style="color:var(--text3);">' + esc(r.city) + ', ' + esc(r.state) + '</span>';
        h += '</div>';
      });
      h += '</div></div>';
    }

    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<p style="color:var(--danger);">' + esc(err.message) + '</p>'; }
}

async function saveRcLimit() {
  var val = parseInt((document.getElementById('rcLimitInput') || {}).value);
  if (isNaN(val) || val < 0) { toast('Enter a valid number', 'error'); return; }
  try {
    await api('/api/admin/rentcast-config', 'POST', { monthly_limit: val });
    var statusEl = document.getElementById('rcLimitStatus');
    if (statusEl) statusEl.textContent = 'Saved ✓';
    toast('RentCast limit set to ' + val);
  } catch (err) { toast(err.message, 'error'); }
}

// Admin: AI Config
function setAdminAI(provider) {
  // provider arg kept for backward compat with any admin buttons, but quality is now the preference
  localStorage.setItem('pmr_ai_provider', provider); // keep for legacy
  document.querySelectorAll('.admin-ai-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.aiprov === provider);
  });
  var statusEl = document.getElementById('adminAiStatus');
  if (statusEl) statusEl.textContent = 'Noted — AI provider selected automatically based on quality preference ✓';
  updateActiveProviderDisplay(provider);
  toast('AI selection is now automatic — use Best/Economy in the analysis UI');
}

function loadAdminAIState() {
  document.querySelectorAll('.admin-ai-btn').forEach(function(b) {
    b.classList.toggle('active', false); // no longer a hard selection
  });
  updateActiveProviderDisplay(null);
}

function updateActiveProviderDisplay(provider) {
  var el = document.getElementById('adminActiveProvider');
  var note = document.getElementById('adminActiveProviderNote');
  if (!el) return;
  var labels = { anthropic: 'Claude (Anthropic)', openai: 'GPT-4o (OpenAI)', workers_ai: 'Workers AI (Cloudflare)' };
  var notes = { anthropic: '~$0.08/task · highest quality', openai: '~$0.06/task · high quality', workers_ai: 'Free · lower accuracy' };
  el.textContent = labels[provider] || provider;
  if (note) note.textContent = notes[provider] || '';
}

// Admin: Company Branding — persisted to D1 app_settings (not localStorage)
async function loadBranding() {
  try {
    var d = await api('/api/admin/settings/branding');
    var branding = {};
    try { branding = JSON.parse(d.value || '{}'); } catch {}
    var nameEl = document.getElementById('brandCompanyName');
    var subEl = document.getElementById('brandSubtitle');
    var logoEl = document.getElementById('brandLogoUrl');
    var favEl = document.getElementById('brandFaviconUrl');
    var tzEl = document.getElementById('brandTimezone');
    if (nameEl && branding.companyName) nameEl.value = branding.companyName;
    if (subEl && branding.subtitle) subEl.value = branding.subtitle;
    if (logoEl && branding.logoUrl) logoEl.value = branding.logoUrl;
    if (favEl && branding.faviconUrl) favEl.value = branding.faviconUrl;
    if (tzEl && branding.timezone) tzEl.value = branding.timezone;
    if (branding.timezone) APP_TIMEZONE = branding.timezone;
    if (branding.logoUrl) updateBrandPreviewThumb('brandLogoUrl', branding.logoUrl);
    if (branding.faviconUrl) updateBrandPreviewThumb('brandFaviconUrl', branding.faviconUrl);
    applyBranding(branding);
  } catch {}
}

// Load branding on app init (called from init flow)
async function initBranding() {
  try {
    var d = await api('/api/admin/settings/branding');
    var branding = {};
    try { branding = JSON.parse(d.value || '{}'); } catch {}
    if (branding.timezone) APP_TIMEZONE = branding.timezone;
    applyBranding(branding);
  } catch {}
}

function applyBranding(branding) {
  if (!branding) return;
  // Update header text — always left-aligned
  if (branding.companyName) {
    var h1 = document.querySelector('#headerBar h1');
    if (h1) h1.textContent = branding.companyName;
  }
  if (branding.subtitle) {
    var sub = document.querySelector('#headerBar .subtitle');
    if (sub) sub.textContent = branding.subtitle;
  }
  // Logo: insert into the existing left-side flex container, before the text block
  if (branding.logoUrl) {
    var headerLeft = document.querySelector('#headerBar > div');
    if (headerLeft) {
      var existingLogo = document.getElementById('headerLogo');
      if (!existingLogo) {
        var img = document.createElement('img');
        img.id = 'headerLogo';
        img.style.cssText = 'height:36px;border-radius:6px;flex-shrink:0;';
        img.onerror = function() { this.style.display = 'none'; };
        headerLeft.insertBefore(img, headerLeft.firstChild);
      }
      document.getElementById('headerLogo').src = branding.logoUrl;
      document.getElementById('headerLogo').style.display = '';
    }
  } else {
    var oldLogo = document.getElementById('headerLogo');
    if (oldLogo) oldLogo.style.display = 'none';
  }
  // Favicon
  if (branding.faviconUrl) {
    var link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = branding.faviconUrl;
  }
  // Update preview
  var preview = document.getElementById('brandPreview');
  if (preview) {
    var h = '<div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--surface2);border-radius:8px;">';
    if (branding.logoUrl) h += '<img src="' + esc(branding.logoUrl) + '" style="height:32px;border-radius:4px;" onerror="this.style.display=\'none\'">';
    h += '<div><strong>' + esc(branding.companyName || 'FCP-PMR') + '</strong>';
    if (branding.subtitle) h += '<div style="font-size:0.75rem;color:var(--text3);">' + esc(branding.subtitle) + '</div>';
    h += '</div>';
    if (branding.faviconUrl) h += '<img src="' + esc(branding.faviconUrl) + '" style="height:16px;margin-left:auto;" onerror="this.style.display=\'none\'">';
    h += '</div>';
    preview.innerHTML = h;
  }
}

async function saveBranding() {
  var branding = {
    companyName: (document.getElementById('brandCompanyName') || {}).value || '',
    subtitle: (document.getElementById('brandSubtitle') || {}).value || '',
    logoUrl: (document.getElementById('brandLogoUrl') || {}).value || '',
    faviconUrl: (document.getElementById('brandFaviconUrl') || {}).value || '',
    timezone: (document.getElementById('brandTimezone') || {}).value || 'America/New_York'
  };
  try {
    await api('/api/admin/settings', 'POST', { key: 'branding', value: JSON.stringify(branding) });
    APP_TIMEZONE = branding.timezone;
    applyBranding(branding);
    var statusEl = document.getElementById('brandSaveStatus');
    if (statusEl) statusEl.textContent = 'Saved ✓';
    toast('Branding saved — timezone set to ' + branding.timezone);
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
}

async function handleBrandImageUpload(input, targetFieldId) {
  var file = input.files[0];
  if (!file) return;
  var fieldName = targetFieldId === 'brandLogoUrl' ? 'Logo' : 'Favicon';
  var statusId = targetFieldId === 'brandLogoUrl' ? 'brandLogoStatus' : 'brandFaviconStatus';
  var statusEl = document.getElementById(statusId);
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
    document.getElementById(targetFieldId).value = data.url;
    updateBrandPreviewThumb(targetFieldId, data.url);
    if (statusEl) statusEl.textContent = 'Uploaded: ' + file.name;
    toast(fieldName + ' uploaded');
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    toast(err.message, 'error');
  }
  input.value = '';
}

function updateBrandPreviewThumb(fieldId, url) {
  var previewId = fieldId === 'brandLogoUrl' ? 'brandLogoPreview' : 'brandFaviconPreview';
  var el = document.getElementById(previewId);
  if (!el) return;
  if (url) {
    var h = fieldId === 'brandLogoUrl' ? 32 : 16;
    el.innerHTML = '<img src="' + esc(url) + '" style="height:' + h + 'px;border-radius:4px;border:1px solid var(--border);" onerror="this.style.display=\'none\'">';
  } else {
    el.innerHTML = '';
  }
}

// Admin: AI Status
async function loadAiStatus() {
  var el = document.getElementById('aiStatusPanel');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text3);">Loading...</p>';
  try {
    var d = await api('/api/ai/status');
    var s = d.status || {};
    var u = d.usage || {};
    var h = '';

    // Provider status
    h += '<div style="margin-bottom:16px;"><h4 style="font-size:0.88rem;margin-bottom:10px;">Providers</h4>';
    for (var key in s) {
      var p = s[key];
      h += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);font-size:0.85rem;">';
      h += '<span style="color:' + (p.available ? 'var(--accent)' : 'var(--danger)') + ';font-size:1.1em;">' + (p.available ? '✓' : '✗') + '</span>';
      h += '<strong>' + esc(p.provider) + '</strong>';
      h += '<span style="color:var(--text3);">Model: ' + esc(p.model) + '</span>';
      h += '<span style="color:var(--text3);">Cost: ' + esc(p.cost) + '</span>';
      h += '</div>';
    }
    h += '</div>';

    // Usage stats
    h += '<div style="margin-bottom:16px;"><h4 style="font-size:0.88rem;margin-bottom:10px;">Usage</h4>';
    h += '<div class="market-grid">';
    h += '<div class="market-stat"><div class="val">' + (u.total || 0) + '</div><div class="lbl">Total Calls</div></div>';
    h += '<div class="market-stat"><div class="val">' + (u.today || 0) + '</div><div class="lbl">Today</div></div>';
    h += '<div class="market-stat"><div class="val">' + (u.last7d || 0) + '</div><div class="lbl">Last 7 Days</div></div>';
    h += '<div class="market-stat"><div class="val" style="color:' + (u.errors > 0 ? 'var(--danger)' : 'var(--accent)') + ';">' + (u.errors || 0) + '</div><div class="lbl">Errors</div></div>';
    h += '</div></div>';

    // By endpoint
    if (u.by_endpoint && Object.keys(u.by_endpoint).length > 0) {
      h += '<div style="margin-bottom:16px;"><h4 style="font-size:0.88rem;margin-bottom:8px;">By Feature</h4>';
      for (var ep in u.by_endpoint) {
        h += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:0.82rem;"><span>' + esc(ep) + '</span><span style="color:var(--accent);font-family:monospace;">' + u.by_endpoint[ep] + '</span></div>';
      }
      h += '</div>';
    }

    // By provider
    if (u.by_provider && Object.keys(u.by_provider).length > 0) {
      h += '<div style="margin-bottom:16px;"><h4 style="font-size:0.88rem;margin-bottom:8px;">By Provider</h4>';
      for (var prov in u.by_provider) {
        var info = u.by_provider[prov];
        h += '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:0.82rem;"><span>' + esc(prov) + '</span><span style="color:var(--text2);">' + info.calls + ' calls, ~' + (info.tokens || 0).toLocaleString() + ' tokens</span></div>';
      }
      h += '</div>';
    }

    // Recent calls
    if (u.recent && u.recent.length > 0) {
      h += '<div><h4 style="font-size:0.88rem;margin-bottom:8px;">Recent Calls</h4>';
      h += '<div style="max-height:200px;overflow-y:auto;">';
      u.recent.forEach(function(r) {
        var ok = r.success === 1;
        h += '<div style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:0.78rem;border-bottom:1px solid var(--border);">';
        h += '<span style="color:' + (ok ? 'var(--accent)' : 'var(--danger)') + ';">' + (ok ? '✓' : '✗') + '</span>';
        h += '<span style="color:var(--text2);">' + fmtUTC(r.created_at) + '</span>';
        h += '<span>' + esc(r.endpoint) + '</span>';
        h += '<span style="color:var(--text3);">' + esc(r.provider) + '</span>';
        if (r.error_msg) h += '<span style="color:var(--danger);font-size:0.72rem;">' + esc(r.error_msg).substring(0, 60) + '</span>';
        h += '</div>';
      });
      h += '</div></div>';
    }

    el.innerHTML = h;
  } catch (err) { el.innerHTML = '<p style="color:var(--danger);">' + esc(err.message) + '</p>'; }
}

// Util
function esc(str) {
  if (str === null || str === undefined) return '';
  const d = document.createElement('div');
  d.textContent = String(str);
  return d.innerHTML;
}

function mapLink(address, city, state, zip) {
  var q = [address, city, state, zip].filter(Boolean).join(', ');
  return '<a href="https://www.google.com/maps/search/' + encodeURIComponent(q) + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dashed var(--text3);" title="Open in Google Maps">' + esc(address) + '</a>';
}

// PWA: Service Worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    // Minimal SW — just enables "Add to Home Screen"
    var swBlob = new Blob([
      'self.addEventListener("fetch", function(e) { e.respondWith(fetch(e.request)); });'
    ], { type: 'application/javascript' });
    var swUrl = URL.createObjectURL(swBlob);
    navigator.serviceWorker.register(swUrl).catch(function() {});
  });
}

// Budget & Limits
async function loadBudgetSettings() {
  var el = document.getElementById('budgetSettings');
  if (!el) return;
  try {
    var alerts = await api('/api/usage-alerts');
    var services = [
      { key: 'anthropic', label: 'Anthropic Claude AI', default_budget: 20.00, unit: '$/month' },
      { key: 'openai', label: 'OpenAI GPT', default_budget: 20.00, unit: '$/month' },
      { key: 'searchapi', label: 'SearchAPI (Google)', default_budget: 5.00, unit: '$/month' },
      { key: 'rentcast', label: 'RentCast', default_budget: 5.00, unit: '$/month' },
      { key: 'google_places', label: 'Google Places', default_budget: 5.00, unit: '$/month' },
    ];
    // Load saved budgets
    var budgets = {};
    try {
      for (var i = 0; i < services.length; i++) {
        var bk = 'budget_' + services[i].key;
        try { var bv = await api('/api/admin/settings/' + bk); budgets[services[i].key] = parseFloat(bv.value) || services[i].default_budget; } catch { budgets[services[i].key] = services[i].default_budget; }
      }
    } catch {}
    // Get current spend from ai_summary
    var aiByProv = {};
    if (alerts.ai_summary && alerts.ai_summary.by_provider) {
      alerts.ai_summary.by_provider.forEach(function(p) { aiByProv[p.provider] = (p.cost || 0) / 100; });
    }
    var h = '<table class="comp-table" style="font-size:0.82rem;"><thead><tr><th>Service</th><th>Monthly Budget</th><th>Spent</th><th>Remaining</th><th>Status</th></tr></thead><tbody>';
    services.forEach(function(s) {
      var budget = budgets[s.key] || s.default_budget;
      var spent = aiByProv[s.key] || 0;
      var remaining = Math.max(0, budget - spent);
      var pct = budget > 0 ? Math.round(spent / budget * 100) : 0;
      var statusColor = pct >= 90 ? 'var(--danger)' : pct >= 70 ? '#f59e0b' : 'var(--accent)';
      var statusIcon = pct >= 100 ? '' + _ico('alertCircle', 13, 'var(--danger)') + ' Over budget' : pct >= 90 ? '' + _ico('alertCircle', 13, '#f59e0b') + ' Near limit' : pct >= 70 ? '' + _ico('alertCircle', 13, '#f59e0b') + ' Watch' : '' + _ico('check', 13, 'var(--accent)') + ' OK';
      h += '<tr><td style="font-weight:600;">' + esc(s.label) + '</td>';
      h += '<td><input type="number" step="0.50" min="0" value="' + budget.toFixed(2) + '" style="width:80px;font-size:0.82rem;background:var(--surface2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:3px 6px;" onchange="saveBudget(\'' + s.key + '\',this.value)"> $/mo</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + (spent > 0 ? '#f59e0b' : 'var(--text3)') + ';">$' + spent.toFixed(2) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:' + statusColor + ';">$' + remaining.toFixed(2) + '</td>';
      h += '<td><span style="color:' + statusColor + ';">' + statusIcon + '</span></td></tr>';
    });
    h += '</tbody></table>';
    h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:6px;">Default: $5.00/month per service. When budget is reached, system falls back to free alternatives (Workers AI). Set to $0 to disable a paid service entirely.</div>';
    el.innerHTML = h;
    // Show alerts
    var alertEl = document.getElementById('budgetAlerts');
    if (alertEl && alerts.alerts && alerts.alerts.length > 0) {
      var ah = '';
      alerts.alerts.forEach(function(a) {
        var bg = a.level === 'critical' ? 'rgba(239,68,68,0.08)' : a.level === 'warning' ? 'rgba(245,158,11,0.08)' : 'rgba(96,165,250,0.06)';
        var icon = a.level === 'critical' ? '' + _ico('alertCircle', 13, 'var(--danger)') + '' : a.level === 'warning' ? '' + _ico('alertCircle', 13, '#f59e0b') + '' : '' + _ico('info', 13, 'var(--blue)') + '';
        ah += '<div style="padding:6px 10px;background:' + bg + ';border-radius:6px;margin-bottom:4px;font-size:0.75rem;">' + icon + ' <strong>' + esc(a.service) + ':</strong> ' + esc(a.msg) + '</div>';
      });
      alertEl.innerHTML = ah;
    }
  } catch (err) { el.innerHTML = '<span style="color:var(--danger);">Error: ' + esc(err.message) + '</span>'; }
}
async function saveBudget(service, value) {
  try {
    await api('/api/admin/settings', 'POST', { key: 'budget_' + service, value: String(parseFloat(value) || 0) });
    toast('Budget saved: ' + service + ' → $' + parseFloat(value).toFixed(2) + '/mo');
  } catch (err) { toast('Error saving: ' + err.message, 'error'); }
}


// Admin: Reset user password
async function adminResetPassword() {
  var userId = (document.getElementById('adminUserSelect') || {}).value || '';
  if (!userId) { toast('Select a user first', 'error'); return; }
  if (!confirm('Reset password for this user? A temporary password will be generated.')) return;
  try {
    var d = await api('/api/admin/users/' + userId + '/reset-password', 'POST');
    toast('Password reset. Temp password: ' + (d.temp_password || d.password || '(check logs)'));
    if (d.temp_password || d.password) {
      prompt('Temporary password (copy this):', d.temp_password || d.password);
    }
  } catch (err) { toast(err.message, 'error'); }
}

// Admin: Run DNS setup
async function runDnsSetup() {
  showLoading('Running DNS setup...');
  try {
    var d = await api('/api/admin/dns/setup', 'POST');
    toast(d.message || 'DNS setup complete');
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

// ── Bulk Tax Rate ──────────────────────────────────────────────────────────
function toggleBulkTaxState() {
  var scope = (document.getElementById('bulkTaxScope') || {}).value;
  var stateGroup = document.getElementById('bulkTaxStateGroup');
  if (stateGroup) stateGroup.style.display = scope === 'state' ? '' : 'none';
}

async function applyBulkTaxRate() {
  var rate = parseFloat((document.getElementById('bulkTaxRate') || {}).value);
  if (isNaN(rate) || rate < 0 || rate > 50) { toast('Enter a valid tax rate (0-50%)', 'error'); return; }
  var scope = (document.getElementById('bulkTaxScope') || {}).value || 'all';
  var state = (document.getElementById('bulkTaxState') || {}).value;
  if (scope === 'state' && !state) { toast('Enter a state code', 'error'); return; }

  var label = scope === 'state' ? 'all properties in ' + state.toUpperCase() : 'ALL properties';
  if (!confirm('Set tax rate to ' + rate + '% on ' + label + '?')) return;

  var resultEl = document.getElementById('bulkTaxResult');
  if (resultEl) resultEl.innerHTML = '<span style="color:var(--text3);">Updating...</span>';
  try {
    var payload = { tax_rate_pct: rate, scope: scope };
    if (scope === 'state') payload.state = state;
    var d = await api('/api/properties/bulk-tax-rate', 'POST', payload);
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--accent);">' + _ico('check', 13, 'var(--accent)') + ' ' + esc(d.message) + '</span>';
    toast(d.message, 'success');
  } catch (err) {
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--danger);">' + esc(err.message) + '</span>';
    toast('Failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// System Log Viewer (Admin tab)
// ═══════════════════════════════════════════════════════════════════════════

function loadSystemLog(level) {
  var el = document.getElementById('systemLogPanel');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text3);font-size:0.78rem;text-align:center;padding:12px;">' + _ico('refresh', 14) + ' Loading...</p>';
  var url = '/api/admin/system-log?limit=100';
  if (level) url += '&level=' + level;
  api(url).then(function(d) {
    var logs = d.logs || [];
    var counts = d.counts || {};
    var h = '';

    // Level filter buttons
    h += '<div style="display:flex;gap:4px;margin-bottom:10px;flex-wrap:wrap;">';
    h += '<button class="btn btn-xs' + (!level ? ' btn-primary' : '') + '" onclick="loadSystemLog()" style="font-size:0.68rem;">All (' + ((counts.error || 0) + (counts.warn || 0) + (counts.info || 0)) + ')</button>';
    h += '<button class="btn btn-xs' + (level === 'error' ? ' btn-primary' : '') + '" onclick="loadSystemLog(\'error\')" style="font-size:0.68rem;color:var(--danger);">' + _ico('alertTriangle', 10, 'var(--danger)') + ' Errors (' + (counts.error || 0) + ')</button>';
    h += '<button class="btn btn-xs' + (level === 'warn' ? ' btn-primary' : '') + '" onclick="loadSystemLog(\'warn\')" style="font-size:0.68rem;color:#f59e0b;">' + _ico('alertTriangle', 10, '#f59e0b') + ' Warns (' + (counts.warn || 0) + ')</button>';
    h += '<button class="btn btn-xs' + (level === 'info' ? ' btn-primary' : '') + '" onclick="loadSystemLog(\'info\')" style="font-size:0.68rem;">' + _ico('eye', 10) + ' Info (' + (counts.info || 0) + ')</button>';
    h += '<button class="btn btn-xs btn-danger" onclick="_clearSystemLog()" style="font-size:0.68rem;margin-left:auto;">' + _ico('trash', 10) + ' Clear</button>';
    h += '</div>';

    if (logs.length === 0) {
      h += '<p style="color:var(--text3);font-size:0.78rem;text-align:center;padding:20px;">No log entries' + (level ? ' at ' + level + ' level' : '') + '. That\'s a good thing.</p>';
    } else {
      h += '<div style="max-height:400px;overflow-y:auto;font-size:0.72rem;">';
      logs.forEach(function(log) {
        var col = log.level === 'error' ? 'var(--danger)' : log.level === 'warn' ? '#f59e0b' : 'var(--text3)';
        var ico = log.level === 'error' ? 'alertTriangle' : log.level === 'warn' ? 'alertTriangle' : 'eye';
        h += '<div style="padding:6px 8px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:70px 110px 1fr;gap:8px;align-items:start;">';
        h += '<span style="color:var(--text3);font-family:DM Mono,monospace;font-size:0.62rem;">' + (log.created_at || '').substring(5, 16).replace('T', ' ') + '</span>';
        h += '<span style="font-family:DM Mono,monospace;font-size:0.65rem;color:' + col + ';font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(log.source || '') + '">' + _ico(ico, 10, col) + ' ' + esc(log.source || '') + '</span>';
        h += '<div>';
        h += '<span style="color:var(--text);">' + esc(log.message || '') + '</span>';
        if (log.detail) h += '<div style="color:var(--text3);font-size:0.65rem;margin-top:2px;word-break:break-all;">' + esc(log.detail.substring(0, 200)) + '</div>';
        if (log.property_id) h += '<span style="color:var(--accent);font-size:0.62rem;margin-left:4px;">[prop:' + log.property_id + ']</span>';
        h += '</div></div>';
      });
      h += '</div>';
    }
    el.innerHTML = h;
  }).catch(function(err) {
    el.innerHTML = '<p style="color:var(--danger);font-size:0.78rem;">' + esc(err.message) + '</p>';
  });
}

function _clearSystemLog() {
  if (!confirm('Clear all system logs? This cannot be undone.')) return;
  api('/api/admin/system-log/clear', 'POST', {})
    .then(function() { toast('System log cleared'); loadSystemLog(); })
    .catch(function(err) { toast(err.message, 'error'); });
}
