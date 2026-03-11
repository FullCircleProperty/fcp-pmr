// ═══════════════════════════════════════════════════════════════════════════
// 16-marketing.js — Marketing Content Management (Admin-only)
// ═══════════════════════════════════════════════════════════════════════════

var _mktData = null;
var _mktStats = null;
var _mktSubTab = 'overview';

function loadMarketing() {
  var el = document.getElementById('marketingContent');
  if (!el) return;
  el.innerHTML = '<p style="color:var(--text3);text-align:center;padding:40px;">' + _ico('refresh', 16) + ' Loading marketing content...</p>';
  Promise.all([
    api('/api/admin/marketing'),
    api('/api/admin/marketing/stats')
  ]).then(function(results) {
    _mktData = results[0];
    _mktStats = results[1];
    _renderMarketing();
  }).catch(function(err) {
    el.innerHTML = '<div class="card" style="padding:20px;text-align:center;"><p style="color:var(--danger);">Error loading marketing: ' + esc(err.message || 'unknown') + '</p><button class="btn btn-sm" onclick="loadMarketing()" style="margin-top:8px;">Retry</button></div>';
  }).catch(function(e) { if (typeof toast !== 'undefined') toast(e.message || 'Error', 'error'); });
}

function _renderMarketing() {
  var el = document.getElementById('marketingContent');
  if (!el) return;
  var d = _mktData || {};
  var s = _mktStats || {};
  var content = d.content || {};
  var h = '';

  // ── Header ──
  h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px;">';
  h += '<div><h2 style="margin:0;font-size:1.1rem;">' + _ico('star', 18, 'var(--accent)') + ' Marketing Hub</h2>';
  h += '<p style="margin:2px 0 0;color:var(--text3);font-size:0.75rem;">' + (d.total || 0) + ' content items across ' + Object.keys(content).length + ' sections</p></div>';
  h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
  h += '<button class="btn btn-sm" onclick="_mktSeed()" title="Add missing defaults (won\'t overwrite your edits)">' + _ico('database', 13) + ' Seed Defaults</button>';
  h += '<button class="btn btn-sm btn-primary" onclick="_mktGenerate()" title="AI regenerate all content">' + _ico('star', 13) + ' AI Regenerate</button>';
  h += '<button class="btn btn-sm" onclick="_mktExportLanding()" title="Export landing page data">' + _ico('externalLink', 13) + ' Export Landing Page</button>';
  h += '<button class="btn btn-sm" onclick="_mktPreviewLanding()" title="Preview landing page">' + _ico('eye', 13) + ' Preview</button>';
  h += '</div></div>';

  // ── Sub-tabs ──
  h += '<div style="display:flex;gap:4px;margin-bottom:14px;flex-wrap:wrap;">';
  var tabs = [
    { key: 'overview', label: 'Overview', icon: 'home' },
    { key: 'hero', label: 'Hero & Brand', icon: 'star' },
    { key: 'features', label: 'Features', icon: 'layers' },
    { key: 'pricing', label: 'Pricing', icon: 'dollarSign' },
    { key: 'differentiators', label: 'vs Competition', icon: 'scale' },
    { key: 'audiences', label: 'Audiences', icon: 'radar' },
    { key: 'social', label: 'Social Media', icon: 'globe' },
    { key: 'screenshots', label: 'Screenshots', icon: 'camera' }
  ];
  tabs.forEach(function(t) {
    var active = _mktSubTab === t.key;
    h += '<button class="btn btn-xs' + (active ? ' btn-primary' : '') + '" onclick="_mktSubTab=\'' + t.key + '\';_renderMarketing()" style="font-size:0.72rem;">' + _ico(t.icon, 11) + ' ' + t.label + '</button>';
  });
  h += '</div>';

  // ── Content Area ──
  if (_mktSubTab === 'overview') h += _mktOverview(content, s);
  else if (_mktSubTab === 'hero') h += _mktHeroBrand(content);
  else if (_mktSubTab === 'features') h += _mktFeatures(content);
  else if (_mktSubTab === 'pricing') h += _mktPricing(content);
  else if (_mktSubTab === 'differentiators') h += _mktDifferentiators(content);
  else if (_mktSubTab === 'audiences') h += _mktAudiences(content);
  else if (_mktSubTab === 'social') h += _mktSocial(content);
  else if (_mktSubTab === 'screenshots') h += _mktScreenshots(s);

  el.innerHTML = h;
}

// ── Overview ─────────────────────────────────────────────────────────────
function _mktOverview(content, stats) {
  var h = '';
  // App stats for marketing
  h += '<div class="card" style="margin-bottom:12px;">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('radar', 15) + ' Live App Stats (for marketing copy)</h3></div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;padding:12px;">';
  var statItems = [
    { label: 'API Routes', value: stats.routes || '—', icon: 'link' },
    { label: 'DB Tables', value: stats.tables || '—', icon: 'database' },
    { label: 'Properties', value: stats.properties || '—', icon: 'home' },
    { label: 'Reservations', value: stats.reservations || '—', icon: 'calendar' },
    { label: 'AI Strategies', value: stats.strategies || '—', icon: 'dollarSign' },
    { label: 'AI Reports', value: stats.reports || '—', icon: 'star' },
    { label: 'Comps Tracked', value: stats.comps || '—', icon: 'scale' },
    { label: 'Markets Analyzed', value: stats.market_profiles || '—', icon: 'globe' }
  ];
  statItems.forEach(function(si) {
    h += '<div style="text-align:center;padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
    h += '<div style="font-family:DM Mono,monospace;font-size:1.1rem;font-weight:700;color:var(--accent);">' + si.value + '</div>';
    h += '<div style="font-size:0.68rem;color:var(--text3);margin-top:2px;">' + _ico(si.icon, 10) + ' ' + si.label + '</div>';
    h += '</div>';
  });
  h += '</div></div>';

  // Content summary
  h += '<div class="card">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('layers', 15) + ' Content Sections</h3></div>';
  var sections = Object.keys(content);
  if (sections.length === 0) {
    h += '<div style="padding:20px;text-align:center;color:var(--text3);">';
    h += '<p style="font-size:0.85rem;">No marketing content yet.</p>';
    h += '<button class="btn btn-primary btn-sm" onclick="_mktSeed()" style="margin-top:8px;">' + _ico('database', 13) + ' Seed Default Content</button>';
    h += '</div>';
  } else {
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;padding:12px;">';
    sections.forEach(function(sec) {
      var items = content[sec] || [];
      h += '<div style="padding:10px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);cursor:pointer;" onclick="_mktSubTab=\'' + esc(sec) + '\';_renderMarketing()">';
      h += '<div style="font-weight:600;font-size:0.82rem;color:var(--text);text-transform:capitalize;">' + esc(sec) + '</div>';
      h += '<div style="font-size:0.7rem;color:var(--text3);margin-top:2px;">' + items.length + ' items</div>';
      h += '</div>';
    });
    h += '</div>';
  }
  h += '</div>';
  return h;
}

// ── Hero & Brand ─────────────────────────────────────────────────────────
function _mktHeroBrand(content) {
  var brand = content.brand || [];
  var hero = content.hero || [];
  var h = '';

  h += '<div class="card" style="margin-bottom:12px;">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('star', 15) + ' Brand Identity</h3>';
  h += '<button class="btn btn-xs" onclick="_mktGenerate(\'brand\', \'Make brand copy more compelling and specific\')">' + _ico('star', 11) + ' AI Improve</button></div>';
  h += _mktEditableList(brand, 'brand');
  h += '</div>';

  h += '<div class="card">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('home', 15) + ' Hero Section</h3>';
  h += '<button class="btn btn-xs" onclick="_mktGenerate(\'hero\', \'Make hero headline punchier and more specific\')">' + _ico('star', 11) + ' AI Improve</button></div>';
  h += _mktEditableList(hero, 'hero');
  h += '</div>';

  // Live preview
  h += '<div class="card" style="margin-top:12px;">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('eye', 15) + ' Preview</h3></div>';
  h += '<div style="padding:24px;background:linear-gradient(135deg, #0f172a, #1e293b);border-radius:8px;text-align:center;">';
  var brandData = {};
  brand.forEach(function(b) { brandData[b.content_key] = b.content_value; });
  var heroData = {};
  hero.forEach(function(h2) { heroData[h2.content_key] = h2.content_value; });
  h += '<div style="font-size:0.72rem;color:#6366f1;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">' + esc(brandData.product_name || 'FCP-PMR') + '</div>';
  h += '<h1 style="color:#f8fafc;font-size:1.4rem;margin:0 0 8px;line-height:1.3;">' + esc(heroData.headline || 'Your headline here') + '</h1>';
  h += '<p style="color:#94a3b8;font-size:0.82rem;max-width:500px;margin:0 auto 16px;line-height:1.5;">' + esc(heroData.subheadline || 'Your subheadline here') + '</p>';
  h += '<div style="display:flex;gap:8px;justify-content:center;">';
  h += '<button style="background:#6366f1;color:white;border:none;padding:8px 20px;border-radius:6px;font-size:0.82rem;font-weight:600;">' + esc(heroData.cta_primary || 'Get Started') + '</button>';
  h += '<button style="background:transparent;color:#94a3b8;border:1px solid #334155;padding:8px 20px;border-radius:6px;font-size:0.82rem;">' + esc(heroData.cta_secondary || 'Learn More') + '</button>';
  h += '</div></div></div>';
  return h;
}

// ── Features ─────────────────────────────────────────────────────────────
function _mktFeatures(content) {
  var features = content.features || [];
  var h = '';
  h += '<div class="card">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('layers', 15) + ' Feature Cards (' + features.length + ')</h3>';
  h += '<button class="btn btn-xs" onclick="_mktGenerate(\'features\', \'Improve feature descriptions to be more benefit-focused and specific\')">' + _ico('star', 11) + ' AI Improve</button></div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;padding:12px;">';
  features.forEach(function(f) {
    var data = {};
    try { data = JSON.parse(f.content_value); } catch { data = { title: f.content_key, description: f.content_value }; }
    var col = data.color || 'var(--accent)';
    h += '<div style="padding:14px;background:var(--surface2);border-radius:10px;border:1px solid var(--border);border-left:3px solid ' + col + ';">';
    h += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">';
    h += _ico(data.icon || 'star', 16, col);
    h += '<span style="font-weight:700;font-size:0.85rem;color:var(--text);">' + esc(data.title || f.content_key) + '</span>';
    h += '</div>';
    h += '<p style="font-size:0.75rem;color:var(--text2);line-height:1.5;margin:0;">' + esc(data.description || '') + '</p>';
    var fLocked = f.is_locked;
    h += '<div style="display:flex;gap:4px;margin-top:8px;">';
    h += '<button class="btn btn-xs" onclick="_mktToggleLock(\'' + esc(f.section) + '\',\'' + esc(f.content_key) + '\',' + (fLocked ? 'false' : 'true') + ')" style="font-size:0.65rem;" title="' + (fLocked ? 'Unlock' : 'Lock') + '">' + _ico(fLocked ? 'lock' : 'unlock', 10, fLocked ? 'var(--danger)' : 'var(--text3)') + '</button>';
    h += '<button class="btn btn-xs" onclick="_mktEditItem(\'' + esc(f.section) + '\',\'' + esc(f.content_key) + '\')" style="font-size:0.65rem;">' + _ico('edit', 10) + ' Edit</button>';
    h += '</div>';
    h += '</div>';
  });
  h += '</div></div>';
  return h;
}

// ── Pricing ──────────────────────────────────────────────────────────────
function _mktPricing(content) {
  var pricing = content.pricing || [];
  var h = '';
  h += '<div class="card">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('dollarSign', 15) + ' Pricing Tiers</h3>';
  h += '<button class="btn btn-xs" onclick="_mktGenerate(\'pricing\', \'Refine pricing copy to be more compelling\')">' + _ico('star', 11) + ' AI Improve</button></div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;padding:12px;">';
  pricing.forEach(function(p) {
    var data = {};
    try { data = JSON.parse(p.content_value); } catch { data = { name: p.content_key }; }
    var hl = data.highlight ? 'border:2px solid var(--accent);' : 'border:1px solid var(--border);';
    h += '<div style="padding:16px;background:var(--surface2);border-radius:10px;' + hl + 'position:relative;">';
    if (data.highlight) h += '<div style="position:absolute;top:-10px;right:14px;background:var(--accent);color:white;font-size:0.6rem;font-weight:700;padding:2px 10px;border-radius:10px;text-transform:uppercase;">Most Popular</div>';
    h += '<h4 style="margin:0 0 4px;font-size:0.95rem;color:var(--text);">' + esc(data.name || '') + '</h4>';
    h += '<div style="font-size:1.5rem;font-weight:800;color:var(--accent);font-family:DM Mono,monospace;">' + esc(data.price || '') + '<span style="font-size:0.7rem;color:var(--text3);font-weight:400;">' + esc(data.period || '') + '</span></div>';
    h += '<p style="font-size:0.72rem;color:var(--text2);margin:6px 0 10px;line-height:1.4;">' + esc(data.description || '') + '</p>';
    if (data.features) {
      data.features.forEach(function(feat) {
        h += '<div style="font-size:0.72rem;color:var(--text);padding:3px 0;display:flex;align-items:center;gap:4px;">' + _ico('check', 11, '#10b981') + ' ' + esc(feat) + '</div>';
      });
    }
    var pLocked = p.is_locked;
    h += '<div style="display:flex;gap:4px;margin-top:10px;">';
    h += '<button class="btn btn-xs" onclick="_mktToggleLock(\'' + esc(p.section) + '\',\'' + esc(p.content_key) + '\',' + (pLocked ? 'false' : 'true') + ')" style="font-size:0.65rem;" title="' + (pLocked ? 'Unlock' : 'Lock') + '">' + _ico(pLocked ? 'lock' : 'unlock', 10, pLocked ? 'var(--danger)' : 'var(--text3)') + '</button>';
    h += '<button class="btn btn-xs" onclick="_mktEditItem(\'' + esc(p.section) + '\',\'' + esc(p.content_key) + '\')" style="font-size:0.65rem;">' + _ico('edit', 10) + ' Edit</button>';
    h += '</div>';
    h += '</div>';
  });
  h += '</div></div>';
  return h;
}

// ── vs Competition ───────────────────────────────────────────────────────
function _mktDifferentiators(content) {
  var diffs = content.differentiators || [];
  var h = '';
  h += '<div class="card">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('scale', 15) + ' vs Competition</h3>';
  h += '<button class="btn btn-xs" onclick="_mktGenerate(\'differentiators\', \'Make competitive comparisons sharper and more specific\')">' + _ico('star', 11) + ' AI Improve</button></div>';
  h += '<div style="display:flex;flex-direction:column;gap:8px;padding:12px;">';
  diffs.forEach(function(d) {
    var data = {};
    try { data = JSON.parse(d.content_value); } catch { data = { competitor: d.content_key }; }
    h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);display:grid;grid-template-columns:140px 1fr 1fr;gap:12px;align-items:start;">';
    h += '<div><div style="font-weight:700;font-size:0.85rem;color:var(--text);">' + esc(data.competitor || '') + '</div>';
    h += '<div style="font-size:0.72rem;color:var(--danger);font-weight:600;margin-top:2px;">' + esc(data.their_price || '') + '</div></div>';
    h += '<div style="font-size:0.72rem;color:var(--text3);line-height:1.5;">' + _ico('x', 11, 'var(--danger)') + ' ' + esc(data.their_limitation || '') + '</div>';
    h += '<div style="font-size:0.72rem;color:var(--text);line-height:1.5;">' + _ico('check', 11, '#10b981') + ' ' + esc(data.our_advantage || '') + '</div>';
    h += '</div>';
  });
  h += '</div></div>';
  return h;
}

// ── Audiences ────────────────────────────────────────────────────────────
function _mktAudiences(content) {
  var audiences = content.audiences || [];
  var h = '';
  h += '<div class="card">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('radar', 15) + ' Target Audiences</h3>';
  h += '<button class="btn btn-xs" onclick="_mktGenerate(\'audiences\', \'Make audience descriptions more specific with concrete pain points\')">' + _ico('star', 11) + ' AI Improve</button></div>';
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;padding:12px;">';
  audiences.forEach(function(a) {
    var data = {};
    try { data = JSON.parse(a.content_value); } catch { data = { title: a.content_key }; }
    h += '<div style="padding:14px;background:var(--surface2);border-radius:10px;border:1px solid var(--border);">';
    h += '<h4 style="margin:0 0 6px;font-size:0.88rem;color:var(--text);">' + esc(data.title || '') + '</h4>';
    h += '<p style="font-size:0.72rem;color:var(--text2);line-height:1.4;margin:0 0 8px;">' + esc(data.description || '') + '</p>';
    if (data.pain) {
      h += '<div style="font-size:0.7rem;margin-bottom:6px;"><span style="color:var(--danger);font-weight:600;">' + _ico('alertTriangle', 11, 'var(--danger)') + ' Pain:</span> <span style="color:var(--text3);">' + esc(data.pain) + '</span></div>';
    }
    if (data.solution) {
      h += '<div style="font-size:0.7rem;"><span style="color:#10b981;font-weight:600;">' + _ico('check', 11, '#10b981') + ' Solution:</span> <span style="color:var(--text);">' + esc(data.solution) + '</span></div>';
    }
    h += '</div>';
  });
  h += '</div></div>';
  return h;
}

// ── Social Media ─────────────────────────────────────────────────────────
function _mktSocial(content) {
  var social = content.social || [];
  var h = '';
  h += '<div class="card">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('globe', 15) + ' Social Media Snippets</h3>';
  h += '<button class="btn btn-xs" onclick="_mktGenerate(\'social\', \'Write more engaging social posts with specific numbers and hooks\')">' + _ico('star', 11) + ' AI Improve</button></div>';
  h += '<div style="display:flex;flex-direction:column;gap:10px;padding:12px;">';
  social.forEach(function(s) {
    var platform = s.content_key.startsWith('twitter') ? 'Twitter/X' : s.content_key.startsWith('linkedin') ? 'LinkedIn' : s.content_key.startsWith('instagram') ? 'Instagram' : 'Post';
    var charLimit = s.content_key.startsWith('twitter') ? 280 : 3000;
    var len = (s.content_value || '').length;
    h += '<div style="padding:12px;background:var(--surface2);border-radius:8px;border:1px solid var(--border);">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
    h += '<span style="font-size:0.72rem;font-weight:600;color:var(--accent);">' + platform + '</span>';
    h += '<span style="font-size:0.62rem;color:' + (len > charLimit ? 'var(--danger)' : 'var(--text3)') + ';">' + len + '/' + charLimit + '</span>';
    h += '</div>';
    h += '<p style="font-size:0.78rem;color:var(--text);line-height:1.5;margin:0;white-space:pre-wrap;">' + esc(s.content_value || '') + '</p>';
    h += '<div style="display:flex;gap:4px;margin-top:8px;">';
    h += '<button class="btn btn-xs" onclick="navigator.clipboard.writeText(' + JSON.stringify(s.content_value || '').replace(/'/g, "\\'") + ');toast(\'Copied!\')" style="font-size:0.62rem;">' + _ico('receipt', 10) + ' Copy</button>';
    h += '<button class="btn btn-xs" onclick="_mktEditItem(\'' + esc(s.section) + '\',\'' + esc(s.content_key) + '\')" style="font-size:0.62rem;">' + _ico('edit', 10) + ' Edit</button>';
    h += '</div></div>';
  });
  h += '</div></div>';
  return h;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function _mktEditableList(items, section) {
  var h = '<div style="padding:12px;">';
  items.forEach(function(item) {
    var locked = item.is_locked;
    h += '<div style="display:flex;gap:8px;align-items:start;padding:6px 0;border-bottom:1px solid var(--border);' + (locked ? 'opacity:0.7;' : '') + '">';
    h += '<span style="font-size:0.7rem;color:var(--text3);min-width:100px;font-family:DM Mono,monospace;">' + esc(item.content_key) + '</span>';
    h += '<span style="font-size:0.78rem;color:var(--text);flex:1;line-height:1.4;">' + esc(item.content_value || '') + '</span>';
    h += '<button class="btn btn-xs" onclick="_mktToggleLock(\'' + esc(section) + '\',\'' + esc(item.content_key) + '\',' + (locked ? 'false' : 'true') + ')" style="flex-shrink:0;" title="' + (locked ? 'Unlock — AI can modify' : 'Lock — AI will skip this') + '">' + _ico(locked ? 'lock' : 'unlock', 10, locked ? 'var(--danger)' : 'var(--text3)') + '</button>';
    h += '<button class="btn btn-xs" onclick="_mktEditItem(\'' + esc(section) + '\',\'' + esc(item.content_key) + '\')" style="flex-shrink:0;">' + _ico('edit', 10) + '</button>';
    h += '</div>';
  });
  if (items.length === 0) h += '<p style="color:var(--text3);font-size:0.78rem;text-align:center;">No content. Click "Seed Defaults" to populate.</p>';
  h += '</div>';
  return h;
}

function _mktToggleLock(section, key, locked) {
  api('/api/admin/marketing/lock', 'POST', { section: section, content_key: key, locked: locked })
    .then(function() { toast(key + (locked ? ' locked — AI will skip it' : ' unlocked')); loadMarketing(); })
    .catch(function(err) { toast('Error: ' + (err.message || 'unknown'), 'error'); });
}

function _mktEditItem(section, key) {
  var items = (_mktData && _mktData.content && _mktData.content[section]) || [];
  var item = items.find(function(i) { return i.content_key === key; });
  var currentValue = item ? item.content_value : '';
  var newValue = prompt('Edit ' + section + '.' + key + ':', currentValue);
  if (newValue === null) return;
  api('/api/admin/marketing', 'POST', { section: section, content_key: key, content_value: newValue, sort_order: item ? item.sort_order : 0 })
    .then(function() { toast('Updated ' + key); loadMarketing(); })
    .catch(function(err) { toast('Error: ' + (err.message || 'unknown'), 'error'); });
}

function _mktSeed() {
  if (!confirm('This will add any missing default content. Your existing customized items will NOT be overwritten. Continue?')) return;
  var btn = event && event.target; if (btn) btn.disabled = true;
  api('/api/admin/marketing/seed', 'POST')
    .then(function(r) { toast('Seeded ' + (r.count || 0) + ' items'); loadMarketing(); })
    .catch(function(err) { toast('Error: ' + (err.message || 'unknown'), 'error'); })
    .finally(function() { if (btn) btn.disabled = false; });
}

function _mktGenerate(section, instructions) {
  var sec = section || null;
  var instr = instructions || null;
  if (!sec && !instr) {
    instr = prompt('What should the AI focus on improving?', 'Make all copy more specific, compelling, and benefit-focused. Use concrete numbers from the live app stats.');
    if (!instr) return;
  }
  var btn = event && event.target; if (btn) btn.disabled = true;
  toast('AI generating... this may take a moment', 'info');
  api('/api/admin/marketing/generate', 'POST', { section: sec, instructions: instr })
    .then(function(r) {
      toast('AI updated ' + (r.applied || 0) + ' items (' + (r.provider || 'unknown') + ')');
      loadMarketing();
    })
    .catch(function(err) { toast('Error: ' + (err.message || 'unknown'), 'error'); })
    .finally(function() { if (btn) btn.disabled = false; });
}

function _mktExportLanding() {
  api('/api/admin/marketing/landing-page')
    .then(function(data) {
      var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'fcp-pmr-landing-page.json'; a.click();
      URL.revokeObjectURL(url);
      toast('Exported landing page data');
    })
    .catch(function(err) { toast('Error: ' + (err.message || 'unknown'), 'error'); });
}

function _mktPreviewLanding() {
  api('/api/admin/marketing/landing-page')
    .then(function(data) {
      var w = window.open('', '_blank');
      if (!w) { toast('Popup blocked — allow popups for this site', 'error'); return; }
      w.document.write(_mktBuildLandingHTML(data));
      w.document.close();
    })
    .catch(function(err) { toast('Error: ' + (err.message || 'unknown'), 'error'); });
}

function _mktBuildLandingHTML(data) {
  var brand = data.brand || {};
  var hero = data.hero || {};
  var features = data.features || [];
  var pricing = data.pricing || [];
  var diffs = data.differentiators || [];

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">';
  html += '<title>' + (brand.product_name || 'FCP-PMR') + ' — ' + (brand.tagline || '') + '</title>';
  html += '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">';
  html += '<style>';
  html += '*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.6}';
  html += '.container{max-width:1100px;margin:0 auto;padding:0 24px}';
  html += '.hero{padding:80px 0 60px;text-align:center}';
  html += '.hero h1{font-size:2.5rem;font-weight:800;background:linear-gradient(135deg,#f8fafc,#94a3b8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;line-height:1.2;margin-bottom:16px}';
  html += '.hero p{font-size:1.1rem;color:#94a3b8;max-width:600px;margin:0 auto 32px}';
  html += '.btn-primary{background:#6366f1;color:white;border:none;padding:12px 32px;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;transition:background 0.2s}';
  html += '.btn-primary:hover{background:#4f46e5}';
  html += '.btn-secondary{background:transparent;color:#94a3b8;border:1px solid #334155;padding:12px 32px;border-radius:8px;font-size:1rem;cursor:pointer}';
  html += '.section{padding:60px 0}.section h2{font-size:1.8rem;font-weight:800;text-align:center;margin-bottom:40px;color:#f8fafc}';
  html += '.grid{display:grid;gap:20px}.grid-3{grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}.grid-4{grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}';
  html += '.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px}';
  html += '.card h3{font-size:1.1rem;font-weight:700;margin-bottom:8px;color:#f8fafc}';
  html += '.card p{font-size:0.9rem;color:#94a3b8}';
  html += '.badge{display:inline-block;font-size:0.7rem;font-weight:600;padding:2px 10px;border-radius:12px;text-transform:uppercase;letter-spacing:0.5px}';
  html += '.highlight{border-color:#6366f1;position:relative}.highlight::before{content:"Most Popular";position:absolute;top:-12px;right:16px;background:#6366f1;color:white;font-size:0.65rem;font-weight:700;padding:3px 12px;border-radius:10px;text-transform:uppercase}';
  html += '.price{font-family:"DM Mono",monospace;font-size:2.2rem;font-weight:800;color:#6366f1}.price-period{font-size:0.9rem;color:#64748b;font-weight:400}';
  html += '.check{color:#10b981;margin-right:6px}';
  html += 'footer{padding:40px 0;text-align:center;color:#475569;font-size:0.85rem;border-top:1px solid #1e293b}';
  html += '@media(max-width:768px){.hero h1{font-size:1.8rem}.grid-3,.grid-4{grid-template-columns:1fr}}';
  html += '</style></head><body>';

  // Hero
  html += '<section class="hero"><div class="container">';
  html += '<div style="font-size:0.8rem;color:#6366f1;font-weight:600;letter-spacing:3px;text-transform:uppercase;margin-bottom:12px;">' + (brand.product_name || 'FCP-PMR') + '</div>';
  html += '<h1>' + (hero.headline || '') + '</h1>';
  html += '<p>' + (hero.subheadline || '') + '</p>';
  html += '<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">';
  html += '<button class="btn-primary">' + (hero.cta_primary || 'Get Started') + '</button>';
  html += '<button class="btn-secondary">' + (hero.cta_secondary || 'Learn More') + '</button>';
  html += '</div></div></section>';

  // Features
  if (features.length > 0) {
    html += '<section class="section" style="background:#0d1117;"><div class="container">';
    html += '<h2>Everything You Need. Nothing You Don\'t.</h2>';
    html += '<div class="grid grid-4">';
    features.forEach(function(f) {
      html += '<div class="card" style="border-left:3px solid ' + (f.color || '#6366f1') + ';">';
      html += '<h3>' + (f.title || '') + '</h3>';
      html += '<p>' + (f.description || '') + '</p>';
      html += '</div>';
    });
    html += '</div></div></section>';
  }

  // Pricing
  if (pricing.length > 0) {
    html += '<section class="section"><div class="container">';
    html += '<h2>Simple, Transparent Pricing</h2>';
    html += '<div class="grid grid-3">';
    pricing.forEach(function(p) {
      html += '<div class="card' + (p.highlight ? ' highlight' : '') + '">';
      html += '<h3>' + (p.name || '') + '</h3>';
      html += '<div class="price">' + (p.price || '') + '<span class="price-period">' + (p.period || '') + '</span></div>';
      html += '<p style="margin:12px 0 16px;">' + (p.description || '') + '</p>';
      if (p.features) p.features.forEach(function(feat) {
        html += '<div style="font-size:0.85rem;padding:4px 0;"><span class="check">✓</span> ' + feat + '</div>';
      });
      html += '</div>';
    });
    html += '</div></div></section>';
  }

  // Differentiators
  if (diffs.length > 0) {
    html += '<section class="section" style="background:#0d1117;"><div class="container">';
    html += '<h2>How We Compare</h2>';
    html += '<div class="grid" style="grid-template-columns:1fr;gap:12px;">';
    diffs.forEach(function(d) {
      html += '<div class="card" style="display:grid;grid-template-columns:160px 1fr 1fr;gap:16px;align-items:start;">';
      html += '<div><strong style="font-size:1rem;color:#f8fafc;">' + (d.competitor || '') + '</strong>';
      html += '<div style="color:#ef4444;font-size:0.85rem;font-weight:600;margin-top:4px;">' + (d.their_price || '') + '</div></div>';
      html += '<div style="color:#94a3b8;font-size:0.85rem;">✗ ' + (d.their_limitation || '') + '</div>';
      html += '<div style="color:#10b981;font-size:0.85rem;">✓ ' + (d.our_advantage || '') + '</div>';
      html += '</div>';
    });
    html += '</div></div></section>';
  }

  html += '<footer><div class="container">&copy; ' + new Date().getFullYear() + ' Full Circle Property. Built with ❤️ on Cloudflare Workers.</div></footer>';
  html += '</body></html>';
  return html;
}

// ═══════════════════════════════════════════════════════════════════════════
// Screenshots — Styled mockups of each app view for marketing
// ═══════════════════════════════════════════════════════════════════════════

function _mktScreenshots(stats) {
  var h = '';
  h += '<div class="card" style="margin-bottom:12px;">';
  h += '<div class="card-header"><h3 style="font-size:0.85rem;">' + _ico('camera', 15) + ' App Screenshots</h3>';
  h += '<div style="display:flex;gap:4px;">';
  h += '<button class="btn btn-xs" onclick="_mktExportAllScreenshots()" title="Open all screenshots in new windows for saving">' + _ico('externalLink', 11) + ' Export All</button>';
  h += '</div></div>';
  h += '<p style="font-size:0.72rem;color:var(--text3);padding:0 12px 8px;">Click any screenshot to open it full-size in a new window. Right-click → Save As to download as an image.</p>';
  h += '</div>';

  var screens = [
    { id: 'dashboard', title: 'Portfolio Dashboard', desc: 'Real-time KPIs, revenue tracking, action items, and upcoming bookings at a glance.', fn: '_mktScreenDashboard' },
    { id: 'properties', title: 'Property Portfolio', desc: 'Rich property cards with status clusters, health scores, revenue data, and quick actions.', fn: '_mktScreenProperties' },
    { id: 'pricing', title: 'AI Pricing Strategy', desc: 'AI-generated pricing recommendations with PriceLabs comparison, seasonal adjustments, and market positioning.', fn: '_mktScreenPricing' },
    { id: 'market', title: 'Market Intelligence', desc: 'Deep market profiles with demographics, tourism data, competitor analysis, and trend monitoring.', fn: '_mktScreenMarket' },
    { id: 'finances', title: 'Portfolio Finances', desc: 'P&L tracking, expense management, owner statements, and investment performance across your entire portfolio.', fn: '_mktScreenFinances' },
    { id: 'listing_health', title: 'Listing Health Score', desc: 'Category-by-category listing quality analysis with AI recommendations and actionable improvements.', fn: '_mktScreenListingHealth' },
    { id: 'intel', title: 'Guest Intelligence', desc: 'Booking patterns, returning guests, channel attribution, pet tracking, and stay duration analysis.', fn: '_mktScreenIntel' },
    { id: 'integrations', title: 'PMS Integrations', desc: 'Guesty + PriceLabs sync dashboard with reservation imports, calendar view, and algorithm health monitoring.', fn: '_mktScreenIntegrations' }
  ];

  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(440px,1fr));gap:14px;">';
  screens.forEach(function(s) {
    h += '<div class="card" style="padding:0;overflow:hidden;">';
    h += '<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">';
    h += '<div><div style="font-weight:700;font-size:0.82rem;color:var(--text);">' + s.title + '</div>';
    h += '<div style="font-size:0.65rem;color:var(--text3);margin-top:1px;">' + s.desc + '</div></div>';
    h += '<button class="btn btn-xs" onclick="_mktOpenScreenshot(\'' + s.fn + '\',\'' + esc(s.title) + '\')" style="flex-shrink:0;">' + _ico('externalLink', 11) + ' Open</button>';
    h += '</div>';
    // Inline mini-preview
    h += '<div style="padding:12px;background:#0f172a;cursor:pointer;min-height:200px;" onclick="_mktOpenScreenshot(\'' + s.fn + '\',\'' + esc(s.title) + '\')">';
    h += window[s.fn] ? window[s.fn](stats, true) : '<p style="color:#475569;font-size:0.72rem;text-align:center;">Preview not available</p>';
    h += '</div></div>';
  });
  h += '</div>';
  return h;
}

function _mktOpenScreenshot(fn, title) {
  if (!window[fn]) return;
  var content = window[fn](null, false);
  var w = window.open('', '_blank');
  if (!w) { toast('Popup blocked', 'error'); return; }
  w.document.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + title + ' — FCP-PMR</title>');
  w.document.write('<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">');
  w.document.write('<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,sans-serif;background:#0f1117;color:#e8ecf4;padding:32px;min-height:100vh}');
  w.document.write('.card{background:#1a1e28;border:1px solid #2e3446;border-radius:10px;padding:16px;margin-bottom:12px}');
  w.document.write('.card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}');
  w.document.write('.badge{display:inline-block;font-size:0.6rem;font-weight:600;padding:2px 8px;border-radius:4px;letter-spacing:0.3px}');
  w.document.write('.kpi{padding:14px 16px;background:#1a1e28;border-radius:10px;border:1px solid #2e3446}');
  w.document.write('.kpi-val{font-family:"DM Mono",monospace;font-size:1.35rem;font-weight:700;line-height:1.2}.kpi-label{font-size:0.65rem;font-weight:600;color:#636d84;text-transform:uppercase;letter-spacing:0.03em;margin-bottom:6px}.kpi-sub{font-size:0.68rem;color:#636d84;margin-top:3px}');
  w.document.write('.bar{height:6px;background:#1e222d;border-radius:3px;overflow:hidden}.bar-fill{height:100%;border-radius:3px}');
  w.document.write('.grid{display:grid;gap:10px}.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:1fr 1fr 1fr}.g4{grid-template-columns:1fr 1fr 1fr 1fr}.g5{grid-template-columns:repeat(5,1fr)}');
  w.document.write('.tag{display:inline-block;font-size:0.58rem;padding:2px 6px;border-radius:3px;margin:1px}');
  w.document.write('.section-hdr{font-size:0.72rem;font-weight:600;color:#636d84;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:8px;display:flex;align-items:center;gap:5px}');
  w.document.write('.watermark{position:fixed;bottom:16px;right:20px;font-size:0.7rem;color:#2e3446;font-weight:600;letter-spacing:1px}');
  w.document.write('.nav-tabs{display:flex;gap:2px;padding:6px;background:#181b23;border-radius:10px;margin-bottom:16px}.nav-tab{padding:6px 14px;border-radius:6px;font-size:0.75rem;color:#636d84;background:transparent;border:none;font-family:Inter,sans-serif;cursor:pointer}.nav-tab.active{background:#1a1e28;color:#4ae3b5;font-weight:600}');
  w.document.write('</style></head><body>');
  w.document.write('<div style="max-width:960px;margin:0 auto;">');
  // Simulated nav bar matching the real app
  w.document.write('<div class="nav-tabs">');
  var navItems = ['Dashboard','Properties','Pricing','Market','Comps','Platforms','Intel','Integrations','Finances'];
  var activeNav = title.split(' ')[0];
  navItems.forEach(function(n) {
    var isActive = title.toLowerCase().indexOf(n.toLowerCase()) >= 0 || (n === 'Dashboard' && title === 'Portfolio Dashboard');
    w.document.write('<div class="nav-tab' + (isActive ? ' active' : '') + '">' + n + '</div>');
  });
  w.document.write('</div>');
  w.document.write(content);
  w.document.write('</div><div class="watermark">FCP-PMR · fullcircle-property.com</div></body></html>');
  w.document.close();
}

function _mktExportAllScreenshots() {
  var fns = ['_mktScreenDashboard','_mktScreenProperties','_mktScreenPricing','_mktScreenMarket','_mktScreenFinances','_mktScreenListingHealth','_mktScreenIntel','_mktScreenIntegrations'];
  var titles = ['Dashboard','Properties','Pricing','Market','Finances','Listing Health','Guest Intel','Integrations'];
  fns.forEach(function(fn, i) { setTimeout(function() { _mktOpenScreenshot(fn, titles[i]); }, i * 300); });
}

// ── Individual Screen Mockups (match actual app views) ─────────────────

function _mktScreenDashboard(stats, mini) {
  var h = '';
  // Section header matching actual app
  h += '<div class="section-hdr">PORTFOLIO — 8 Active Properties · 6 Listings</div>';
  h += '<div class="grid g3" style="margin-bottom:14px;">';
  h += _mktKpi('INVESTMENT', '$485k', '', '#e8ecf4');
  h += _mktKpi('CURRENT VALUE', '$612k', '↑ $127k gain', '#a78bfa');
  h += _mktKpi('EQUITY', '$127k', '', '#4ae3b5');
  h += '</div>';

  h += '<div class="section-hdr">THIS MONTH — 2026-03 <span style="font-weight:400;">(10 of 31 days)</span></div>';
  h += '<div class="grid g4" style="margin-bottom:14px;">';
  h += _mktKpi('PAYOUT', '$4,218', '10 of 31 days', '#4ae3b5');
  h += _mktKpi('MONTHLY COSTS', '$2,840', '$34,080/yr', '#ef5c5c');
  h += _mktKpi('NET', '+$1,378', 'Month in progress — 21 days remaining', '#4ae3b5');
  h += _mktKpi('OCCUPANCY', '68%', 'vs 62% market', '#5b8def');
  h += '</div>';

  if (!mini) {
    h += '<div class="section-hdr">YTD — 2026</div>';
    h += '<div class="grid g4" style="margin-bottom:14px;">';
    h += _mktKpi('YTD REVENUE', '$12,654', '3 months', '#4ae3b5');
    h += _mktKpi('YTD PAYOUT', '$9,834', '', '#4ae3b5');
    h += _mktKpi('RUN RATE', '$50,616/yr', 'Based on YTD pace', '#a78bfa');
    h += _mktKpi('AVG OCCUPANCY', '72%', '8 active properties', '#5b8def');
    h += '</div>';

    // Action items card
    h += '<div class="card"><div class="card-header"><span style="font-weight:600;font-size:0.82rem;">Action Items</span><span class="badge" style="background:rgba(239,92,92,0.1);color:#ef5c5c;">3 items</span></div>';
    h += '<div style="padding:6px 0;border-bottom:1px solid #2e3446;font-size:0.78rem;display:flex;gap:8px;align-items:center;"><span style="color:#ef5c5c;">⚠</span> <span style="color:#e8ecf4;">2 major pricing discrepancies (>$25) in next 30 days</span></div>';
    h += '<div style="padding:6px 0;border-bottom:1px solid #2e3446;font-size:0.78rem;display:flex;gap:8px;align-items:center;"><span style="color:#f0b840;">↻</span> <span style="color:#e8ecf4;">3 properties not analyzed in 30+ days</span></div>';
    h += '<div style="padding:6px 0;font-size:0.78rem;display:flex;gap:8px;align-items:center;"><span style="color:#636d84;">ℹ</span> <span style="color:#9aa3b8;">Guest intelligence not built yet (441 reservations available)</span></div>';
    h += '</div>';

    // Upcoming check-ins
    h += '<div class="card"><div class="card-header"><span style="font-weight:600;font-size:0.82rem;">Upcoming Check-ins</span></div>';
    var bookings = [{date:'Mar 12',guest:'Sarah M.',prop:'82 Vine — Unit 1',nights:3,rev:'$447'},{date:'Mar 14',guest:'James K.',prop:'440 Beach Ave',nights:5,rev:'$1,125'},{date:'Mar 16',guest:'Ana R.',prop:'195 Liberty — 2A',nights:2,rev:'$298'}];
    bookings.forEach(function(b) {
      h += '<div style="display:grid;grid-template-columns:60px 1fr 120px 70px 80px;gap:8px;padding:5px 0;border-bottom:1px solid #2e3446;font-size:0.72rem;align-items:center;">';
      h += '<span style="color:#4ae3b5;font-weight:600;">' + b.date + '</span>';
      h += '<span style="color:#e8ecf4;">' + b.guest + '</span>';
      h += '<span style="color:#9aa3b8;">' + b.prop + '</span>';
      h += '<span style="color:#636d84;">' + b.nights + ' nights</span>';
      h += '<span style="color:#4ae3b5;font-family:DM Mono,monospace;text-align:right;">' + b.rev + '</span>';
      h += '</div>';
    });
    h += '</div>';
  }
  return h;
}

function _mktScreenProperties(stats, mini) {
  var h = '';
  var props = [
    { name: '195 Liberty St — Unit 2A', city: 'Middletown, CT', type: 'apartment', beds: 2, baths: 1, rev: 1420, cost: 980, occ: 72, health: 78, status: 'active', ownership: 'purchased' },
    { name: '82 Vine St — Unit 1', city: 'Berlin, CT', type: 'apartment', beds: 1, baths: 1, rev: 980, cost: 650, occ: 58, health: 65, status: 'active', ownership: 'purchased' },
    { name: '440 Beach Ave', city: 'Milford, CT', type: 'multi_family', beds: 6, baths: 3, rev: 3200, cost: 2100, occ: 81, health: 82, status: 'active', ownership: 'purchased' },
    { name: '18 Heritage Dr', city: 'Southbury, CT', type: 'single_family', beds: 3, baths: 2, rev: 2100, cost: 1400, occ: 65, health: 71, status: 'active', ownership: 'purchased' }
  ];

  props.forEach(function(p) {
    var net = p.rev - p.cost;
    var borderCol = net >= 300 ? 'rgba(74,227,181,0.6)' : net >= 0 ? 'rgba(240,184,64,0.5)' : 'rgba(239,68,68,0.45)';
    var hCol = p.health >= 70 ? '#4ae3b5' : p.health >= 40 ? '#f0b840' : '#ef5c5c';
    var typeRgb = p.type === 'apartment' ? '167,139,250' : p.type === 'multi_family' ? '167,139,250' : '59,130,246';
    h += '<div class="card" style="border-left:4px solid ' + borderCol + ';padding:12px 14px;">';
    h += '<div style="display:flex;gap:10px;align-items:start;">';
    // Thumbnail placeholder
    h += '<div style="width:56px;height:56px;background:#262b38;border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:0.6rem;color:#636d84;">IMG</div>';
    h += '<div style="flex:1;min-width:0;">';
    // Name + badges row
    h += '<div style="font-weight:700;font-size:0.85rem;color:#e8ecf4;margin-bottom:3px;">' + p.name + '</div>';
    h += '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px;">';
    h += '<span class="badge" style="background:rgba(' + typeRgb + ',0.1);color:rgb(' + typeRgb + ');">' + p.type.replace('_', ' ') + '</span>';
    h += '<span class="badge" style="background:rgba(74,227,181,0.1);color:#4ae3b5;border:1px solid rgba(74,227,181,0.25);">purchased</span>';
    h += '<span style="font-size:0.68rem;color:#636d84;">' + p.city + ' · ' + p.beds + 'bd/' + p.baths + 'ba</span>';
    h += '</div>';
    // Revenue row
    h += '<div style="display:flex;gap:12px;font-size:0.72rem;">';
    h += '<span style="color:#4ae3b5;font-family:DM Mono,monospace;font-weight:600;">$' + p.rev.toLocaleString() + '/mo</span>';
    h += '<span style="color:#636d84;">costs $' + p.cost.toLocaleString() + '</span>';
    h += '<span style="color:' + (net >= 0 ? '#4ae3b5' : '#ef5c5c') + ';font-weight:600;">net ' + (net >= 0 ? '+' : '') + '$' + net.toLocaleString() + '</span>';
    h += '</div>';
    h += '</div>';
    // Health score + occupancy cluster (right side)
    h += '<div style="text-align:center;flex-shrink:0;min-width:48px;">';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.82rem;font-weight:700;color:' + hCol + ';">' + p.health + '</div>';
    h += '<div style="font-size:0.55rem;color:#636d84;">HEALTH</div>';
    h += '<div style="height:3px;background:#1e222d;border-radius:2px;margin-top:3px;"><div style="height:100%;width:' + p.health + '%;background:' + hCol + ';border-radius:2px;"></div></div>';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.68rem;color:#5b8def;margin-top:4px;">' + p.occ + '%</div>';
    h += '<div style="font-size:0.55rem;color:#636d84;">OCC</div>';
    h += '</div>';
    h += '</div></div>';
  });
  return h;
}

function _mktScreenPricing(stats, mini) {
  var h = '';
  h += '<div class="card">';
  h += '<div class="card-header"><span style="font-weight:700;font-size:0.85rem;color:#e8ecf4;">AI Pricing Strategy — 82 Vine St Unit 1</span><span class="badge" style="background:rgba(167,139,250,0.1);color:#a78bfa;">Claude Sonnet</span></div>';
  h += '<div class="grid g3" style="margin-bottom:14px;">';
  h += _mktKpi('BASE NIGHTLY RATE', '$149', 'Recommended anchor price', '#4ae3b5');
  h += _mktKpi('MINIMUM', '$95', 'Floor for low-demand periods', '#f0b840');
  h += _mktKpi('MAXIMUM', '$225', 'Ceiling for peak demand', '#a78bfa');
  h += '</div>';
  if (!mini) {
    // Seasonal adjustments
    h += '<div class="section-hdr" style="margin-top:8px;">SEASONAL ADJUSTMENTS</div>';
    var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var adj = [-15,-10,-5,0,10,20,25,20,5,-5,-10,-15];
    h += '<div style="display:flex;gap:3px;margin-bottom:14px;">';
    months.forEach(function(m, i) {
      var col = adj[i] > 0 ? '#4ae3b5' : adj[i] < 0 ? '#ef5c5c' : '#636d84';
      var barH = Math.abs(adj[i]) * 2 + 4;
      h += '<div style="flex:1;text-align:center;">';
      h += '<div style="font-size:0.55rem;color:#636d84;margin-bottom:2px;">' + m + '</div>';
      h += '<div style="height:50px;display:flex;align-items:' + (adj[i] >= 0 ? 'flex-end' : 'flex-start') + ';justify-content:center;">';
      h += '<div style="width:100%;max-width:20px;height:' + barH + 'px;background:' + col + ';border-radius:2px;opacity:0.7;"></div></div>';
      h += '<div style="font-family:DM Mono,monospace;font-size:0.58rem;color:' + col + ';font-weight:600;">' + (adj[i] > 0 ? '+' : '') + adj[i] + '%</div>';
      h += '</div>';
    });
    h += '</div>';
    // PriceLabs comparison strip
    h += '<div class="section-hdr">PRICELABS COMPARISON</div>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding:10px;background:#0f1117;border-radius:8px;">';
    h += '<div style="text-align:center;"><div style="font-size:0.62rem;color:#636d84;">Your Base</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:#e8ecf4;">$149</div></div>';
    h += '<div style="text-align:center;"><div style="font-size:0.62rem;color:#636d84;">PL Recommends</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:#4ae3b5;">$155</div></div>';
    h += '<div style="text-align:center;"><div style="font-size:0.62rem;color:#636d84;">Market Avg</div><div style="font-family:DM Mono,monospace;font-size:1rem;font-weight:700;color:#f0b840;">$138</div></div>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function _mktScreenMarket(stats, mini) {
  var h = '<div class="card">';
  h += '<div class="card-header"><span style="font-weight:700;font-size:0.85rem;color:#e8ecf4;">Market Profile — Middletown, CT</span></div>';
  h += '<div class="grid g4" style="margin-bottom:14px;">';
  h += _mktKpi('AVG ADR', '$142', 'Nightly rate', '#5b8def');
  h += _mktKpi('AVG OCCUPANCY', '62%', 'Area average', '#4ae3b5');
  h += _mktKpi('ACTIVE LISTINGS', '84', 'Tracked STRs', '#f0b840');
  h += _mktKpi('YOY GROWTH', '↑ 5%', 'Listing growth', '#a78bfa');
  h += '</div>';
  if (!mini) {
    h += '<div class="section-hdr">DEMOGRAPHICS</div>';
    h += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.75rem;margin-bottom:14px;padding:10px;background:#0f1117;border-radius:8px;">';
    h += '<div><span style="color:#636d84;">Population:</span> <span style="color:#e8ecf4;">47,648</span></div>';
    h += '<div><span style="color:#636d84;">Median Income:</span> <span style="color:#e8ecf4;">$72,400</span></div>';
    h += '<div><span style="color:#636d84;">Tourism Profile:</span> <span style="color:#e8ecf4;">University town, river recreation</span></div>';
    h += '<div><span style="color:#636d84;">Peak Season:</span> <span style="color:#e8ecf4;">Jun–Sep, Oct (fall foliage)</span></div>';
    h += '</div>';
    h += '<div class="section-hdr">COMPETITOR ANALYSIS</div>';
    h += '<div style="font-size:0.75rem;color:#9aa3b8;padding:10px;background:#0f1117;border-radius:8px;">12 active STR listings tracked · 3 new in last 30 days · Avg rating: 4.6★ · 28% are superhosts</div>';
  }
  h += '</div>';
  return h;
}

function _mktScreenFinances(stats, mini) {
  var h = '<div class="card">';
  h += '<div class="card-header"><span style="font-weight:700;font-size:0.85rem;color:#e8ecf4;">Portfolio P&L — YTD 2026</span></div>';
  h += '<div class="grid g4" style="margin-bottom:14px;">';
  h += _mktKpi('TOTAL REVENUE', '$38,400', 'Gross from all properties', '#4ae3b5');
  h += _mktKpi('TOTAL EXPENSES', '$24,100', 'Mortgage, insurance, utilities', '#ef5c5c');
  h += _mktKpi('NET INCOME', '$14,300', 'After all costs', '#4ae3b5');
  h += _mktKpi('CASH-ON-CASH', '8.2%', 'Return on investment', '#5b8def');
  h += '</div>';
  if (!mini) {
    h += '<div class="section-hdr">PER-PROPERTY BREAKDOWN</div>';
    h += '<div style="padding:8px;background:#0f1117;border-radius:8px;">';
    h += '<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;padding:4px 0;border-bottom:1px solid #2e3446;font-size:0.62rem;color:#636d84;font-weight:600;text-transform:uppercase;">'; 
    h += '<div>Property</div><div style="text-align:right;">Revenue</div><div style="text-align:right;">Costs</div><div style="text-align:right;">Net</div></div>';
    var rows = [
      { name: '195 Liberty — 2A', rev: 12400, cost: 8200 },
      { name: '82 Vine — Unit 1', rev: 9800, cost: 6100 },
      { name: '440 Beach Ave', rev: 16200, cost: 9800 }
    ];
    rows.forEach(function(r) {
      var net = r.rev - r.cost;
      h += '<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:8px;padding:6px 0;border-bottom:1px solid #2e3446;font-size:0.75rem;">';
      h += '<div style="color:#e8ecf4;">' + r.name + '</div>';
      h += '<div style="color:#4ae3b5;text-align:right;font-family:DM Mono,monospace;">$' + r.rev.toLocaleString() + '</div>';
      h += '<div style="color:#ef5c5c;text-align:right;font-family:DM Mono,monospace;">$' + r.cost.toLocaleString() + '</div>';
      h += '<div style="color:#4ae3b5;text-align:right;font-weight:700;font-family:DM Mono,monospace;">+$' + net.toLocaleString() + '</div>';
      h += '</div>';
    });
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function _mktScreenListingHealth(stats, mini) {
  var h = '<div class="card">';
  h += '<div class="card-header"><span style="font-weight:700;font-size:0.85rem;color:#e8ecf4;">Listing Health — 82 Vine St Unit 1</span><span class="badge" style="background:rgba(240,184,64,0.1);color:#f0b840;font-weight:700;">72 / 100</span></div>';
  // Score ring + category mini bars (matching actual listing health UI)
  h += '<div style="display:flex;gap:16px;align-items:center;margin-bottom:14px;">';
  h += '<div style="text-align:center;"><div style="width:52px;height:52px;border-radius:50%;border:4px solid #f0b840;display:flex;align-items:center;justify-content:center;font-family:DM Mono,monospace;font-size:1.1rem;font-weight:800;color:#f0b840;">72</div><div style="font-size:0.55rem;color:#636d84;margin-top:3px;font-weight:600;">OVERALL</div></div>';
  h += '<div style="flex:1;display:grid;grid-template-columns:repeat(5,1fr);gap:6px;">';
  var cats = [{n:'Photos',s:85,c:'#4ae3b5'},{n:'Description',s:60,c:'#f0b840'},{n:'Amenities',s:75,c:'#4ae3b5'},{n:'Reviews',s:55,c:'#f0b840'},{n:'Platforms',s:65,c:'#f0b840'}];
  cats.forEach(function(c) {
    h += '<div style="text-align:center;"><div style="font-size:0.55rem;color:#636d84;margin-bottom:3px;">' + c.n + '</div>';
    h += '<div class="bar"><div class="bar-fill" style="width:' + c.s + '%;background:' + c.c + ';"></div></div>';
    h += '<div style="font-family:DM Mono,monospace;font-size:0.6rem;font-weight:600;color:' + c.c + ';margin-top:2px;">' + c.s + '</div></div>';
  });
  h += '</div></div>';
  if (!mini) {
    // Detailed rows matching actual listing health
    var details = [
      { cat: 'Photos', current: '22 / 25 target', rec: 'Add 3 more (missing: kitchen, exterior, entrance)', score: 85, color: '#4ae3b5' },
      { cat: 'Description', current: '320 chars / 800 target', rec: 'Too short — mention WiFi, check-in process, neighborhood', score: 60, color: '#f0b840' },
      { cat: 'Amenities', current: '18 tracked / 20 target', rec: 'Missing: Pool, Hot Tub', score: 75, color: '#4ae3b5' },
      { cat: 'Reviews', current: '12 reviews / 50 target', rec: 'Request feedback from recent 5-star guests', score: 55, color: '#f0b840' },
      { cat: 'Platforms', current: '2 active / 3 target', rec: 'Missing: Booking.com', score: 65, color: '#f0b840' }
    ];
    details.forEach(function(d) {
      h += '<div style="display:grid;grid-template-columns:90px 1fr 1fr 40px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid #2e3446;font-size:0.72rem;">';
      h += '<div style="color:#e8ecf4;font-weight:600;">' + d.cat + '</div>';
      h += '<div style="color:#9aa3b8;">' + d.current + '</div>';
      h += '<div style="color:#636d84;font-size:0.68rem;">' + d.rec + '</div>';
      h += '<div style="text-align:right;font-family:DM Mono,monospace;font-weight:700;color:' + d.color + ';">' + d.score + '</div>';
      h += '</div>';
    });
    // AI recommendation box
    h += '<div style="margin-top:10px;padding:10px;background:#0f1117;border-radius:8px;border-left:3px solid #a78bfa;">';
    h += '<div style="font-size:0.65rem;font-weight:600;color:#a78bfa;margin-bottom:4px;">AI RECOMMENDATION</div>';
    h += '<div style="font-size:0.72rem;color:#9aa3b8;line-height:1.5;">Expand description to 800+ chars with WiFi speed, check-in process, and neighborhood highlights. Target 25+ reviews by proactively messaging recent 5-star guests. Add Booking.com listing to capture European travelers.</div>';
    h += '</div>';
  }
  h += '</div>';
  return h;
}

function _mktScreenIntel(stats, mini) {
  var h = '<div class="card">';
  h += '<div class="card-header"><span style="font-weight:700;font-size:0.85rem;color:#e8ecf4;">Guest Intelligence</span></div>';
  h += '<div class="grid g4" style="margin-bottom:14px;">';
  h += _mktKpi('TOTAL GUESTS', '312', 'Unique guests', '#5b8def');
  h += _mktKpi('RETURN RATE', '18%', '56 returning guests', '#4ae3b5');
  h += _mktKpi('AVG STAY', '3.8 nights', 'Across all bookings', '#f0b840');
  h += _mktKpi('AVG REVENUE', '$787', 'Per booking', '#a78bfa');
  h += '</div>';
  if (!mini) {
    h += '<div class="grid g2">';
    // Channel attribution
    h += '<div><div class="section-hdr">CHANNEL ATTRIBUTION</div>';
    var channels = [{n:'Airbnb',pct:62,col:'#ff5a5f'},{n:'VRBO',pct:24,col:'#3b5998'},{n:'Direct',pct:9,col:'#4ae3b5'},{n:'Booking.com',pct:5,col:'#003580'}];
    channels.forEach(function(c) {
      h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
      h += '<span style="font-size:0.7rem;color:#e8ecf4;min-width:75px;">' + c.n + '</span>';
      h += '<div style="flex:1;"><div class="bar"><div class="bar-fill" style="width:' + c.pct + '%;background:' + c.col + ';"></div></div></div>';
      h += '<span style="font-size:0.68rem;color:#636d84;font-family:DM Mono,monospace;min-width:30px;text-align:right;">' + c.pct + '%</span>';
      h += '</div>';
    });
    h += '</div>';
    // Stay duration
    h += '<div><div class="section-hdr">STAY DURATION</div>';
    var durations = [{n:'Weekend (1-2)',pct:35},{n:'Short (3-7)',pct:42},{n:'Medium (8-29)',pct:18},{n:'Long (30+)',pct:5}];
    durations.forEach(function(d) {
      h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
      h += '<span style="font-size:0.7rem;color:#e8ecf4;min-width:95px;">' + d.n + '</span>';
      h += '<div style="flex:1;"><div class="bar"><div class="bar-fill" style="width:' + d.pct + '%;background:#4ae3b5;"></div></div></div>';
      h += '<span style="font-size:0.68rem;color:#636d84;font-family:DM Mono,monospace;min-width:30px;text-align:right;">' + d.pct + '%</span>';
      h += '</div>';
    });
    h += '</div></div>';
  }
  h += '</div>';
  return h;
}

function _mktScreenIntegrations(stats, mini) {
  var h = '<div class="grid g2">';
  var integrations = [
    { name: 'Guesty PMS', status: 'Connected', color: '#4ae3b5', detail: '441 reservations · 6 listings · Last sync: 2h ago', icon: 'link' },
    { name: 'PriceLabs', status: 'Connected', color: '#4ae3b5', detail: '6 listings · Daily price sync · Algo health: 94%', icon: 'dollarSign' },
    { name: 'RentCast', status: 'Active', color: '#5b8def', detail: 'LTR comps only · 12/50 calls used this month', icon: 'home' },
    { name: 'SearchAPI', status: 'Active', color: '#5b8def', detail: 'Zillow + STR comps · 23/80 budget calls used', icon: 'search' }
  ];
  integrations.forEach(function(ig) {
    h += '<div class="card" style="padding:14px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
    h += '<span style="font-weight:700;font-size:0.82rem;color:#e8ecf4;">' + ig.name + '</span>';
    h += '<span class="badge" style="background:' + ig.color + '20;color:' + ig.color + ';">' + ig.status + '</span>';
    h += '</div>';
    h += '<div style="font-size:0.72rem;color:#636d84;">' + ig.detail + '</div>';
    h += '</div>';
  });
  h += '</div>';
  return h;
}

// ── Helper for consistent KPI cards matching actual _dashKpi style ──────
function _mktKpi(label, value, sub, color) {
  return '<div class="kpi"><div class="kpi-label">' + label + '</div>' +
    '<div class="kpi-val" style="color:' + (color || '#e8ecf4') + ';">' + value + '</div>' +
    (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + '</div>';
}

// Marketing view is loaded via switchView() in 01-globals.js
