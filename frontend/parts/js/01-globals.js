// Global State
const API = '';
let authToken = null;
let currentUser = null;
let properties = [];
let amenities = [];
let aiEnabled = true;
let aiProvider = 'workers_ai';
let selectedAmenities = new Set();
let analysisType = 'str';
let acDebounce = null;
let csvRows = [];
let selectedProps = new Set();
let propSortKey = 'address_asc';
let currentOwnership = 'purchased';
let compType = 'str';
let marketAiEnabled = true;
let compAiEnabled = true;
let viewAsUserId = null; // admin only: view data as specific user
let marketCities = [];

// Screens & Init
function showScreen(name) {
  ['init','login','register','changepw'].forEach(s => {
    document.getElementById('screen-' + s).style.display = 'none';
  });
  document.getElementById('mainApp').style.display = 'none';
  if (name === 'app') {
    document.getElementById('mainApp').style.display = 'block';
  } else {
    document.getElementById('screen-' + name).style.display = 'flex';
  }
}

let startupComplete = false;

document.addEventListener('DOMContentLoaded', async () => {
  // Check for public share view
  if (window.location.pathname === '/share' || window.location.pathname === '/share/') {
    showShareEntry();
    return;
  }
  var shareMatch = window.location.pathname.match(/^\/share\/([a-zA-Z0-9]{5})$/);
  if (shareMatch) {
    // Code was in URL — load it but replace URL to hide code
    window.history.replaceState({}, '', '/share');
    showShareEntry(shareMatch[1]);
    return;
  }

  authToken = localStorage.getItem('pmr_token');

  // Check if system is initialized
  try {
    const data = await apiPublic('/api/auth/init');
    if (!data.initialized) { showScreen('init'); return; }
  } catch {
    if (!authToken) { showScreen('login'); return; }
  }

  if (authToken) {
    try {
      const me = await apiAuth('/api/auth/me');
      currentUser = me.user;
      if (currentUser.must_change_password) { showScreen('changepw'); return; }
      startupComplete = true;
      enterApp();
      return;
    } catch (err) {
      // Only clear token on explicit 401 auth rejection
      if (err && err.message === 'AUTH_EXPIRED') {
        localStorage.removeItem('pmr_token');
        authToken = null;
      } else {
        // Any other error (network, 500, etc) - don't wipe token
        showScreen('login');
        return;
      }
    }
  }
  showScreen('login');
});

function enterApp() {
  showScreen('app');
  document.getElementById('userBadge').innerHTML =
    esc(currentUser.display_name) + ' <span class="role">' + esc(currentUser.role) + '</span>';
  if (currentUser.role === 'admin') document.getElementById('adminTab').style.display = '';

  // Restore AI preferences
  var savedAI = localStorage.getItem('pmr_ai_enabled');
  var savedProvider = localStorage.getItem('pmr_ai_provider');
  if (savedAI !== null) aiEnabled = savedAI === 'true';
  if (savedProvider) aiProvider = savedProvider;

  // Set AI toggle UI state
  document.getElementById('aiToggle').classList.toggle('active', aiEnabled);
  document.getElementById('aiProviderOptions').style.display = aiEnabled ? 'flex' : 'none';
  document.querySelectorAll('.ai-option').forEach(function(o) { o.classList.toggle('selected', o.dataset.provider === aiProvider); });

  // Load branding from DB
  initBranding();
  loadAdminAIState();

  document.querySelectorAll('#mainTabs .tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('#mainTabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      switchView(tab.dataset.view);
    };
  });
  document.querySelectorAll('.ai-option').forEach(opt => {
    opt.onclick = () => {
      document.querySelectorAll('.ai-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      aiProvider = opt.dataset.provider;
      localStorage.setItem('pmr_ai_provider', aiProvider);
    };
  });
  loadProperties();
  loadAmenities();
}

// Auth Actions
async function doInit() {
  const email = document.getElementById('init_email').value.trim();
  const name = document.getElementById('init_name').value.trim();
  if (!email) { showAuthMsg('initMsg', 'Email is required', 'error'); return; }
  try {
    const data = await apiPublic('/api/auth/init', 'POST', { email, display_name: name || 'Admin' });
    const pw = data.default_password;
    document.getElementById('initMsg').innerHTML =
      '<div style="background:var(--card);border:1px solid var(--accent);border-radius:8px;padding:16px;margin-top:12px">' +
      '<div style="color:var(--accent);font-weight:600;margin-bottom:8px">Admin account created!</div>' +
      '<div style="margin-bottom:8px">Your temporary password:</div>' +
      '<div style="background:var(--bg);padding:10px 14px;border-radius:6px;font-family:DM Mono,monospace;font-size:1.1em;letter-spacing:1px;display:flex;align-items:center;gap:10px">' +
      '<span id="initPwDisplay">' + pw + '</span>' +
      '<button onclick="navigator.clipboard.writeText(\'' + pw + '\');this.textContent=\'Copied!\';setTimeout(()=>this.textContent=\'Copy\',2000)" ' +
      'style="background:var(--accent);color:var(--bg);border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:0.85em">Copy</button>' +
      '</div>' +
      '<div style="margin-top:10px;font-size:0.85em;opacity:0.7">Save this password — you will need to change it on first login.</div>' +
      '<button onclick="showScreen(\'login\')" style="margin-top:14px;background:var(--accent);color:var(--bg);border:none;padding:8px 24px;border-radius:6px;cursor:pointer;font-weight:500">Continue to Login</button>' +
      '</div>';
    document.getElementById('initMsg').style.display = 'block';
  } catch (err) { showAuthMsg('initMsg', err.message, 'error'); }
}

async function doLogin() {
  const email = document.getElementById('login_email').value.trim();
  const password = document.getElementById('login_pass').value;
  if (!email || !password) { showAuthMsg('loginMsg', 'Enter email and password', 'error'); return; }
  try {
    const data = await apiPublic('/api/auth/login', 'POST', { email, password });
    authToken = data.token;
    currentUser = data.user;
    localStorage.setItem('pmr_token', authToken);
    if (currentUser.must_change_password) { showScreen('changepw'); return; }
    enterApp();
  } catch (err) { showAuthMsg('loginMsg', err.message, 'error'); }
}

async function doRegister() {
  const name = document.getElementById('reg_name').value.trim();
  const email = document.getElementById('reg_email').value.trim();
  const password = document.getElementById('reg_pass').value;
  if (!name || !email || !password) { showAuthMsg('registerMsg', 'All fields required', 'error'); return; }
  if (password.length < 8) { showAuthMsg('registerMsg', 'Password must be at least 8 characters', 'error'); return; }
  try {
    const data = await apiPublic('/api/auth/register', 'POST', { email, display_name: name, password });
    showAuthMsg('registerMsg', data.message, 'success');
  } catch (err) { showAuthMsg('registerMsg', err.message, 'error'); }
}

async function doChangePassword() {
  const pw = document.getElementById('cp_new').value;
  const confirm = document.getElementById('cp_confirm').value;
  if (!pw || pw.length < 8) { showAuthMsg('changepwMsg', 'Password must be at least 8 characters', 'error'); return; }
  if (pw !== confirm) { showAuthMsg('changepwMsg', 'Passwords do not match', 'error'); return; }
  try {
    await apiAuth('/api/auth/change-password', 'POST', { new_password: pw });
    currentUser.must_change_password = 0;
    showAuthMsg('changepwMsg', 'Password changed! Redirecting...', 'success');
    setTimeout(() => enterApp(), 1000);
  } catch (err) { showAuthMsg('changepwMsg', err.message, 'error'); }
}

async function doLogout() {
  try { await apiAuth('/api/auth/logout', 'POST'); } catch {}
  authToken = null; currentUser = null;
  localStorage.removeItem('pmr_token');
  showScreen('login');
}

function showAuthMsg(id, msg, type) {
  document.getElementById(id).innerHTML = '<div class="auth-message ' + type + '">' + esc(msg) + '</div>';
}

// Password Modal
function showPasswordModal() {
  document.getElementById('pwModal').style.display = 'flex';
  document.getElementById('pwModalMsg').innerHTML = '';
  document.getElementById('pw_cur').value = '';
  document.getElementById('pw_new').value = '';
}
function hidePasswordModal() { document.getElementById('pwModal').style.display = 'none'; }

async function doModalChangePassword() {
  const cur = document.getElementById('pw_cur').value;
  const pw = document.getElementById('pw_new').value;
  if (!cur || !pw) { document.getElementById('pwModalMsg').innerHTML = '<div class="auth-message error">Both fields required</div>'; return; }
  if (pw.length < 8) { document.getElementById('pwModalMsg').innerHTML = '<div class="auth-message error">Min 8 characters</div>'; return; }
  try {
    await apiAuth('/api/auth/change-password', 'POST', { current_password: cur, new_password: pw });
    toast('Password updated'); hidePasswordModal();
  } catch (err) { document.getElementById('pwModalMsg').innerHTML = '<div class="auth-message error">' + esc(err.message) + '</div>'; }
}

async function doAdminChangePassword() {
  const cur = document.getElementById('admin_curpw').value;
  const pw = document.getElementById('admin_newpw').value;
  if (!cur || !pw) { toast('Both fields required', 'error'); return; }
  try {
    await apiAuth('/api/auth/change-password', 'POST', { current_password: cur, new_password: pw });
    toast('Password updated');
    document.getElementById('admin_curpw').value = '';
    document.getElementById('admin_newpw').value = '';
  } catch (err) { toast(err.message, 'error'); }
}

// Admin: User Management
async function loadAdminUsers() {
  try {
    const data = await apiAuth('/api/admin/users');
    const users = data.users || [];
    if (users.length === 0) { document.getElementById('adminUserList').innerHTML = '<p style="color:var(--text3)">No users</p>'; return; }
    let h = '<table class="user-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last Login</th><th>Actions</th></tr></thead><tbody>';
    users.forEach(u => {
      h += '<tr><td>' + esc(u.display_name) + '</td><td>' + esc(u.email) + '</td>';
      h += '<td><span class="role-' + u.role + '">' + esc(u.role) + '</span></td>';
      h += '<td style="font-size:0.75rem;color:var(--text3)">' + (u.last_login || 'never') + '</td><td><div class="btn-group">';
      if (u.role === 'pending') {
        h += '<button class="btn btn-xs btn-primary" onclick="adminApprove(' + u.id + ')">Approve</button>';
        h += '<button class="btn btn-xs btn-danger" onclick="adminReject(' + u.id + ')">Reject</button>';
      } else if (u.id !== currentUser.id) {
        const nr = u.role === 'admin' ? 'user' : 'admin';
        h += '<button class="btn btn-xs btn-purple" onclick="adminSetRole(' + u.id + ',&quot;' + nr + '&quot;)">→ ' + nr + '</button>';
        h += '<button class="btn btn-xs btn-warn" onclick="adminResetPw(' + u.id + ')">Reset PW</button>';
        h += '<button class="btn btn-xs btn-danger" onclick="adminDelete(' + u.id + ')">Delete</button>';
      } else {
        h += '<span style="font-size:0.72rem;color:var(--text3)">You</span>';
      }
      h += '</div></td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('adminUserList').innerHTML = h;
  } catch (err) { toast(err.message, 'error'); }
}

async function adminApprove(id) {
  try { await apiAuth('/api/admin/users/' + id + '/approve', 'POST'); toast('User approved'); loadAdminUsers(); } catch (e) { toast(e.message, 'error'); }
}
async function adminReject(id) {
  if (!confirm('Reject and delete this user?')) return;
  try { await apiAuth('/api/admin/users/' + id + '/reject', 'POST'); toast('User rejected'); loadAdminUsers(); } catch (e) { toast(e.message, 'error'); }
}
async function adminSetRole(id, role) {
  try { await apiAuth('/api/admin/users/' + id + '/role', 'POST', { role }); toast('Role updated'); loadAdminUsers(); } catch (e) { toast(e.message, 'error'); }
}
async function adminResetPw(id) {
  if (!confirm("Reset this user's password? They will be forced to change it on next login.")) return;
  try {
    const data = await apiAuth('/api/admin/users/' + id + '/reset-password', 'POST');
    toast(data.message + ' — Temp password: ' + data.temp_password, 'warn');
    loadAdminUsers();
  } catch (e) { toast(e.message, 'error'); }
}
async function adminDelete(id) {
  if (!confirm('Permanently delete this user?')) return;
  try { await apiAuth('/api/admin/users/' + id, 'DELETE'); toast('User deleted'); loadAdminUsers(); } catch (e) { toast(e.message, 'error'); }
}

// Admin: DNS
async function setupDNS() {
  const token = document.getElementById('dns_token').value.trim();
  const zone = document.getElementById('dns_zone').value.trim();
  const sub = document.getElementById('dns_sub').value.trim() || 'pmr';
  const route = document.getElementById('dns_route').value.trim();
  if (!token || !zone) { toast('API token and Zone ID required', 'error'); return; }
  showLoading('Configuring DNS...');
  try {
    const data = await apiAuth('/api/admin/dns/setup', 'POST', {
      cf_api_token: token, zone_id: zone, subdomain: sub, worker_route: route || undefined
    });
    let h = '';
    (data.steps || []).forEach(s => {
      const icon = s.status === 'ok' ? '✔' : s.status === 'skip' ? '⊘' : '✖';
      h += '<div class="dns-step"><span class="status-' + s.status + '">' + icon + '</span>' +
        '<strong>' + esc(s.action) + '</strong> — ' + esc(s.detail) + '</div>';
    });
    if (data.domain) h += '<div style="margin-top:12px;font-size:0.9rem;">Live at: <a href="' + esc(data.domain) + '" target="_blank">' + esc(data.domain) + '</a></div>';
    if (data.message) h += '<div style="margin-top:8px;font-size:0.82rem;color:var(--text2);">' + esc(data.message) + '</div>';
    document.getElementById('dnsResults').innerHTML = h;
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

// API Helpers
async function apiPublic(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(API + path, opts);
  const data = await res.json().catch(() => ({ error: 'Request failed' }));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function apiAuth(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken } };
  if (body) opts.body = JSON.stringify(body);
  let res;
  try { res = await fetch(API + path, opts); } catch (e) { throw new Error('Network error — check your connection'); }
  const data = await res.json().catch(() => ({ error: 'Request failed' }));
  if (res.status === 401 && data.code === 'AUTH_REQUIRED') {
    // During startup, just signal the error - don't nuke the session
    throw new Error('AUTH_EXPIRED');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function api(path, method = 'GET', body = null) {
  // Admin view-as: inject as_user query param
  if (viewAsUserId && currentUser && currentUser.role === 'admin') {
    var sep = path.includes('?') ? '&' : '?';
    path = path + sep + 'as_user=' + viewAsUserId;
  }
  return apiAuth(path, method, body);
}

function toast(message, type = 'success') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  if (message.includes('Temp password')) {
    t.innerHTML = message + ' <button onclick="this.parentElement.remove()" style="margin-left:10px;background:none;border:1px solid currentColor;color:inherit;padding:2px 8px;border-radius:4px;cursor:pointer">Dismiss</button>';
  } else {
    t.textContent = message;
    setTimeout(function() { t.remove(); }, 5000);
  }
  c.appendChild(t);
}

function showLoading(msg) {
  const el = document.createElement('div'); el.className = 'loading-overlay'; el.id = 'loadingOverlay';
  el.innerHTML = '<div class="spinner"></div><p>' + msg + '</p>';
  document.body.appendChild(el);
}
function hideLoading() { const el = document.getElementById('loadingOverlay'); if (el) el.remove(); }

// View Switching
function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  if (name === 'market') loadMarketData();
  if (name === 'comparables') loadComparables();
  if (name === 'analyze') populateAnalyzeSelects();
  if (name === 'admin') { loadAdminUsers(); loadAdminUserSelect(); loadPLStatus(); loadBudgetSettings(); }
  if (name === 'intel') loadIntelDashboard();
  if (name === 'pms') loadPmsDashboard();
  // Clean up monthly actuals float header when leaving PMS
  if (name !== 'pms') {
    var fh = document.getElementById('monthlyActualsFloatHeader');
    if (fh) fh.style.display = 'none';
  }
  if (name === 'finances') { loadFinances(); setTimeout(initDatePickers, 100); }
  if (name === 'pms') { loadPmsDashboard(); setTimeout(initDatePickers, 100); }
  if (name === 'pricing') loadPricingView();
}

function initDatePickers() {
  if (typeof flatpickr === 'undefined') return;
  var fpConfig = {
    theme: 'dark',
    dateFormat: 'Y-m-d',
    altInput: true,
    altFormat: 'M j, Y',
    animate: true,
    disableMobile: true,
  };
  // Finance pickers
  var finFromEl = document.getElementById('finFrom');
  var finToEl = document.getElementById('finTo');
  if (finFromEl && !finFromEl._flatpickr) {
    flatpickr(finFromEl, Object.assign({}, fpConfig, { onChange: function() { setFinPeriod('custom'); } }));
  }
  if (finToEl && !finToEl._flatpickr) {
    flatpickr(finToEl, Object.assign({}, fpConfig, { onChange: function() { setFinPeriod('custom'); } }));
  }
  // PMS pickers
  var actFromEl = document.getElementById('actualsFrom');
  var actToEl = document.getElementById('actualsTo');
  if (actFromEl && !actFromEl._flatpickr) {
    flatpickr(actFromEl, Object.assign({}, fpConfig, { onChange: function() { filterActuals('custom'); } }));
  }
  if (actToEl && !actToEl._flatpickr) {
    flatpickr(actToEl, Object.assign({}, fpConfig, { onChange: function() { filterActuals('custom'); } }));
  }
}

function showShareEntry(prefillCode) {
  var h = '<div style="max-width:440px;margin:80px auto;text-align:center;font-family:Inter,system-ui,sans-serif;color:#e2e8f0;padding:0 16px;">';
  h += '<div style="font-size:3rem;margin-bottom:12px;">🔗</div>';
  h += '<h2 style="margin:0 0 6px;font-size:1.3rem;">View Shared Property</h2>';
  h += '<p style="color:#9ca3af;margin:0 0 24px;font-size:0.88rem;">Enter the 5-character access code you were given.</p>';
  h += '<div style="padding:24px;background:#1a1d27;border:1px solid #2d3348;border-radius:12px;">';
  h += '<input type="text" id="shareCodeInput" maxlength="5" placeholder="XXXXX" autofocus style="width:100%;padding:16px;font-size:1.8rem;font-family:monospace;letter-spacing:8px;text-align:center;background:#0f1117;border:2px solid #2d3348;border-radius:8px;color:#e2e8f0;outline:none;">';
  h += '<div id="shareError" style="color:#ef4444;font-size:0.78rem;margin-top:8px;display:none;"></div>';
  h += '<button id="shareGoBtn" onclick="goToShare()" style="width:100%;margin-top:12px;padding:14px;background:#4ae3b5;color:#0f1117;border:none;border-radius:8px;font-size:1rem;font-weight:700;cursor:pointer;">View Property</button>';
  h += '</div>';
  h += '<a href="/" style="display:inline-block;margin-top:20px;color:#4ae3b5;font-size:0.82rem;text-decoration:none;">← Back to app</a></div>';
  document.body.innerHTML = h;
  var inp = document.getElementById('shareCodeInput');
  if (inp) {
    inp.addEventListener('input', function() {
      this.value = this.value.replace(/[^a-zA-Z0-9]/g, '');
      if (this.value.length === 5) goToShare();
    });
    // If pre-filled, auto-load
    if (prefillCode) {
      inp.value = prefillCode;
      goToShare();
    }
  }
}

function goToShare() {
  var c = (document.getElementById('shareCodeInput') || {}).value || '';
  c = c.trim();
  if (c.length !== 5) return;
  var btn = document.getElementById('shareGoBtn');
  var errEl = document.getElementById('shareError');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  if (errEl) errEl.style.display = 'none';
  // Fetch via JS — code never goes in the URL
  fetch('/api/share/' + c).then(function(r) { return r.json(); }).then(function(d) {
    if (d.error) {
      if (errEl) { errEl.textContent = d.error; errEl.style.display = ''; }
      if (btn) { btn.disabled = false; btn.textContent = 'View Property'; }
    } else {
      renderSharePage(d);
    }
  }).catch(function(e) {
    if (errEl) { errEl.textContent = e.message || 'Failed to load'; errEl.style.display = ''; }
    if (btn) { btn.disabled = false; btn.textContent = 'View Property'; }
  });
}

function renderSharePage(d) {
  var p = d.property, f = d.financials, pl = d.pricelabs;
  function e(s) { var x = document.createElement('div'); x.textContent = s || ''; return x.innerHTML; }
  var C = 'background:#1a1d27;border:1px solid #2d3348;border-radius:12px;padding:20px;margin-bottom:16px;';
  var h = '';

  // ─── HEADER ───
  h += '<div style="' + C + '">';
  h += '<div style="display:flex;gap:16px;align-items:flex-start;">';
  if (p.image_url) h += '<img src="' + e(p.image_url) + '" style="width:160px;height:110px;object-fit:cover;border-radius:10px;flex-shrink:0;" onerror="this.style.display=\'none\'">';
  h += '<div style="flex:1;"><h1 style="font-size:1.5rem;margin:0 0 4px;">' + e(p.name || p.address) + '</h1>';
  var mapQ = encodeURIComponent([p.address, p.city, p.state, p.zip].filter(Boolean).join(', '));
  h += '<p style="font-size:0.9rem;color:#9ca3af;margin:0;"><a href="https://www.google.com/maps/search/' + mapQ + '" target="_blank" rel="noopener" style="color:#9ca3af;text-decoration:none;border-bottom:1px dashed #4b5563;" title="Open in Google Maps">' + e(p.address) + (p.unit_number ? ' #' + e(p.unit_number) : '') + '</a> &middot; ' + e(p.city) + ', ' + e(p.state) + (p.zip ? ' ' + e(p.zip) : '') + '</p>';
  h += '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">';
  [p.bedrooms + ' bed / ' + p.bathrooms + ' bath', p.sqft ? p.sqft.toLocaleString() + ' sqft' : null, p.property_type ? p.property_type.replace(/_/g,' ') : null, p.year_built ? 'Built ' + p.year_built : null, p.lot_acres ? p.lot_acres + ' acres' : null, p.stories ? p.stories + ' stories' : null, p.parking_spaces ? p.parking_spaces + ' parking' : null].filter(Boolean).forEach(function(b) {
    h += '<span style="font-size:0.72rem;padding:3px 10px;background:#2d3348;border-radius:20px;">' + e(b) + '</span>';
  });
  if (p.is_research) h += '<span style="font-size:0.72rem;padding:3px 10px;background:rgba(167,139,250,0.15);color:#a78bfa;border-radius:20px;">🔬 Research</span>';
  if (p.listing_status === 'active') h += '<span style="font-size:0.72rem;padding:3px 10px;background:rgba(16,185,129,0.15);color:#4ae3b5;border-radius:20px;">● Live</span>';
  h += '</div>';
  if (p.listing_url) h += '<div style="margin-top:6px;"><a href="' + e(p.listing_url) + '" target="_blank" style="font-size:0.78rem;color:#a78bfa;">View listing →</a></div>';
  h += '</div></div></div>';

  // ─── COMPUTE STR NUMBERS FIRST (used by metrics AND P&L) ───
  var strADR = f.blended_adr || 0;
  var strOcc = (f.est_annual_occ || 50) / 100;
  var adrSource = '';
  if (strADR > 0) { adrSource = 'PriceLabs blended'; }
  else if (pl && pl.base_price > 0) { strADR = pl.base_price; adrSource = 'PriceLabs base'; }
  if (strADR === 0 && d.strategies && d.strategies.length > 0) {
    for (var si = 0; si < d.strategies.length; si++) {
      var strat = d.strategies[si];
      if (strat.base_nightly_rate > 0 && (!strat.min_nights || strat.min_nights < 365)) {
        strADR = strat.base_nightly_rate;
        if (strat.projected_occupancy > 0) strOcc = strat.projected_occupancy;
        adrSource = strat.strategy_name || 'Strategy';
        break;
      }
    }
  }
  if (strADR === 0 && d.comparables && d.comparables.length > 0) {
    var compRates = d.comparables.filter(function(c) { return c.nightly_rate > 0 && c.comp_type !== 'ltr'; }).map(function(c) { return c.nightly_rate; });
    if (compRates.length > 0) { strADR = Math.round(compRates.reduce(function(a,b){return a+b;},0)/compRates.length); adrSource = 'Avg of '+compRates.length+' comps'; }
  }
  if (strADR === 0 && d.reports) {
    for (var ri = 0; ri < d.reports.length; ri++) {
      var rpt = d.reports[ri];
      if (rpt.type === 'pl_strategy' && rpt.data && rpt.data.strategy && rpt.data.strategy.base_price > 0) {
        strADR = rpt.data.strategy.base_price;
        if (rpt.data.strategy.projected_occupancy > 0) strOcc = rpt.data.strategy.projected_occupancy;
        adrSource = 'AI Strategy'; break;
      }
      if (rpt.type === 'acquisition_analysis' && rpt.data && rpt.data.analysis && rpt.data.analysis.projected_nightly_rate > 0) {
        strADR = rpt.data.analysis.projected_nightly_rate;
        if (rpt.data.analysis.projected_occupancy_pct > 0) strOcc = rpt.data.analysis.projected_occupancy_pct / 100;
        adrSource = 'Acquisition Analysis'; break;
      }
    }
  }
  var strNightlyRev = Math.round(strADR * 30 * strOcc);
  var cleanFee = p.cleaning_fee || (pl ? pl.cleaning_fees : 0) || 0;
  var cleanCost = p.cleaning_cost || (cleanFee > 0 ? Math.round(cleanFee * 0.7) : 0);
  var avgStay = 3;
  var turnovers = strOcc > 0 ? Math.round(strOcc * 30 / avgStay) : 0;
  var strCleanRev = Math.round(cleanFee * turnovers);
  var strTotalRev = strNightlyRev + strCleanRev;
  var strCleanCost = Math.round(cleanCost * turnovers);
  var supplies = Math.round(strTotalRev * 0.02);
  var fixedExpense = f.monthly_expenses - (f.service_costs || 0);
  var varExpense = strCleanCost + supplies;
  var strTotalExpense = fixedExpense + varExpense + (f.service_costs || 0);
  var strNet = strTotalRev - strTotalExpense;

  // ─── KEY METRICS (using computed values) ───
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:16px;">';
  function mc(l,v,c,s){return '<div style="text-align:center;padding:12px 6px;background:#1a1d27;border-radius:10px;border:1px solid #2d3348;"><div style="font-size:0.6rem;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;margin-bottom:3px;">'+l+'</div><div style="font-family:monospace;font-size:1.1rem;font-weight:700;color:'+(c||'#e2e8f0')+';">'+v+'</div>'+(s?'<div style="font-size:0.55rem;color:#6b7280;margin-top:1px;">'+s+'</div>':'')+'</div>';}
  if (strADR > 0) h += mc('Nightly Rate','$'+strADR+'/nt','#4ae3b5',adrSource);
  if (pl) {
    if (pl.recommended_base_price) h += mc('Recommended','$'+pl.recommended_base_price+'/nt','#4ae3b5','PriceLabs');
    h += mc('Min–Max','$'+(pl.min_price||0)+'–$'+(pl.max_price||0),'#e2e8f0','price range');
    if (pl.occupancy_next_30) h += mc('Occ 30d',pl.occupancy_next_30,'#4ae3b5','mkt: '+(pl.market_occupancy_next_30||'?'));
  }
  h += mc('Est. Occupancy',Math.round(strOcc*100)+'%','#4ae3b5','annual');
  if (strTotalRev > 0) h += mc('STR Revenue','$'+strTotalRev.toLocaleString()+'/mo','#4ae3b5','$'+(strTotalRev*12).toLocaleString()+'/yr');
  h += mc('Expenses','$'+f.monthly_expenses.toLocaleString()+'/mo','#ef4444','$'+(f.monthly_expenses*12).toLocaleString()+'/yr');
  h += mc('STR Net',(strNet>=0?'+':'')+'$'+strNet.toLocaleString()+'/mo',strNet>=0?'#4ae3b5':'#ef4444','$'+(strNet*12).toLocaleString()+'/yr');
  if (f.estimated_value) h += mc('Value','$'+f.estimated_value.toLocaleString(),'#e2e8f0');
  if (f.purchase_price) h += mc('Purchase','$'+f.purchase_price.toLocaleString(),'#9ca3af');
  h += '</div>';

  // ─── FULL P&L BREAKDOWN (using pre-computed values) ───

  h += '<div style="' + C + '">';
  h += '<h2 style="font-size:1.1rem;margin:0 0 14px;">📊 STR Financial Projections' + (adrSource ? ' <span style="font-size:0.72rem;font-weight:400;color:#6b7280;">(' + adrSource + ')</span>' : '') + '</h2>';
  function plr(label, val, color, note) {
    return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:0.82rem;'+(color?'color:'+color+';':'')+'">' +
      '<span>'+label+(note?' <span style="font-size:0.62rem;color:#6b7280;">('+note+')</span>':'')+'</span>' +
      '<span style="font-family:monospace;font-weight:600;">$'+Math.round(val).toLocaleString()+'/mo &middot; $'+Math.round(val*12).toLocaleString()+'/yr</span></div>';
  }
  h += '<div style="font-size:0.72rem;font-weight:600;color:#4ae3b5;margin-bottom:4px;">REVENUE' + (adrSource ? ' <span style="font-weight:400;color:#6b7280;">(' + adrSource + ')</span>' : '') + '</div>';
  if (strNightlyRev > 0) h += plr('Nightly Revenue', strNightlyRev, '#4ae3b5', '$'+strADR+'/nt ADR &times; '+Math.round(strOcc*30)+' nights @ '+Math.round(strOcc*100)+'% occ');
  else if (strADR === 0) h += '<div style="font-size:0.78rem;color:#f59e0b;padding:8px 0;">⚠ No nightly rate data — run Price Analysis or sync PriceLabs to get STR projections</div>';
  if (strCleanRev > 0) h += plr('Cleaning Fee Revenue', strCleanRev, '#4ae3b5', '$'+cleanFee+' &times; '+turnovers+' turnovers');
  h += '<div style="border-top:1px solid #2d3348;margin:4px 0;"></div>';
  h += plr('Total STR Revenue', strTotalRev, '#4ae3b5');

  h += '<div style="font-size:0.72rem;font-weight:600;color:#ef4444;margin:10px 0 4px;">FIXED EXPENSES</div>';
  if (f.ownership_type === 'rental') {
    if (f.monthly_rent_cost) h += plr('Rent', f.monthly_rent_cost, '', 'set');
  } else {
    if (f.monthly_mortgage) h += plr('Mortgage', f.monthly_mortgage, '');
    if (f.monthly_insurance) h += plr('Insurance', f.monthly_insurance, '');
    if (f.annual_taxes) h += plr('Taxes', Math.round(f.annual_taxes/12), '', '$'+f.annual_taxes.toLocaleString()+'/yr');
    if (f.hoa_monthly) h += plr('HOA', f.hoa_monthly, '');
  }
  var utils = (f.expense_electric||0)+(f.expense_gas||0)+(f.expense_water||0)+(f.expense_internet||0)+(f.expense_trash||0)+(f.expense_other||0);
  if (utils > 0) h += plr('Utilities', utils, '', 'electric+gas+water+internet+trash');
  if (f.service_costs > 0) h += plr('Services', f.service_costs, '#a78bfa', (f.services||[]).join(', '));

  h += '<div style="font-size:0.72rem;font-weight:600;color:#ef4444;margin:10px 0 4px;">VARIABLE EXPENSES (STR)</div>';
  if (strCleanCost > 0) h += plr('Cleaning Cost', strCleanCost, '', '$'+cleanCost+' &times; '+turnovers+' turnovers');
  if (supplies > 0) h += plr('Supplies (~2%)', supplies, '', 'toiletries, linens');

  h += '<div style="border-top:2px solid #2d3348;margin:6px 0;"></div>';
  h += plr('Total Expenses', strTotalExpense, '#ef4444');
  h += '<div style="border-top:3px solid '+(strNet>=0?'#4ae3b5':'#ef4444')+';margin:8px 0;"></div>';
  var netC = strNet >= 0 ? '#4ae3b5' : '#ef4444';
  h += '<div style="display:flex;justify-content:space-between;font-size:1.05rem;font-weight:700;color:'+netC+';"><span>STR NET INCOME</span><span style="font-family:monospace;">'+(strNet>=0?'+':'')+'$'+strNet.toLocaleString()+'/mo &middot; '+(strNet>=0?'+':'')+'$'+(strNet*12).toLocaleString()+'/yr</span></div>';
  h += '</div>';

  // ─── STR vs LTR COMPARISON ───
  var ltrEstimate = strADR > 0 ? Math.round(strADR * 30 * 0.33) : 0;
  if (ltrEstimate < 800 && f.estimated_value) ltrEstimate = Math.round(f.estimated_value * 0.007);
  if (strTotalRev > 0 || ltrEstimate > 0) {
    var ltrExpense = fixedExpense + (f.service_costs || 0); // no variable STR costs
    var ltrNet = ltrEstimate - ltrExpense;
    var strAdv = strNet - ltrNet;
    h += '<div style="' + C + '">';
    h += '<h2 style="font-size:1.1rem;margin:0 0 14px;">⚖️ STR vs LTR Comparison</h2>';
    h += '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;"><thead><tr style="border-bottom:2px solid #2d3348;"><th style="text-align:left;padding:6px;color:#6b7280;"></th><th style="text-align:right;padding:6px;color:#4ae3b5;">Short-Term (STR)</th><th style="text-align:right;padding:6px;color:#60a5fa;">Long-Term (LTR)</th><th style="text-align:right;padding:6px;color:#6b7280;">Difference</th></tr></thead><tbody>';
    function cRow(label, sv, lv) {
      var d = sv-lv, dc = d>0?'#4ae3b5':d<0?'#ef4444':'#6b7280';
      return '<tr style="border-bottom:1px solid #1e2130;"><td style="padding:6px;font-weight:600;">'+label+'</td><td style="padding:6px;text-align:right;font-family:monospace;color:#4ae3b5;">$'+Math.round(sv).toLocaleString()+'</td><td style="padding:6px;text-align:right;font-family:monospace;color:#60a5fa;">$'+Math.round(lv).toLocaleString()+'</td><td style="padding:6px;text-align:right;font-family:monospace;color:'+dc+';font-weight:600;">'+(d>0?'+':'')+'$'+Math.round(d).toLocaleString()+'</td></tr>';
    }
    h += cRow('Monthly Revenue', strTotalRev, ltrEstimate);
    h += cRow('Monthly Expenses', strTotalExpense, ltrExpense);
    h += '<tr style="border-top:2px solid #2d3348;"><td style="padding:6px;font-weight:700;">Monthly Net</td>';
    h += '<td style="padding:6px;text-align:right;font-family:monospace;font-weight:700;color:'+(strNet>=0?'#4ae3b5':'#ef4444')+';">'+(strNet>=0?'+':'')+'$'+Math.round(strNet).toLocaleString()+'</td>';
    h += '<td style="padding:6px;text-align:right;font-family:monospace;font-weight:700;color:'+(ltrNet>=0?'#60a5fa':'#ef4444')+';">'+(ltrNet>=0?'+':'')+'$'+Math.round(ltrNet).toLocaleString()+'</td>';
    h += '<td style="padding:6px;text-align:right;font-family:monospace;font-weight:700;color:'+(strAdv>0?'#4ae3b5':'#ef4444')+';">'+(strAdv>0?'+':'')+'$'+Math.round(strAdv).toLocaleString()+'</td></tr>';
    h += '<tr style="border-top:1px solid #1e2130;"><td style="padding:6px;font-weight:700;">Annual Net</td>';
    h += '<td style="padding:6px;text-align:right;font-family:monospace;color:'+(strNet>=0?'#4ae3b5':'#ef4444')+';">'+(strNet>=0?'+':'')+'$'+Math.round(strNet*12).toLocaleString()+'</td>';
    h += '<td style="padding:6px;text-align:right;font-family:monospace;color:'+(ltrNet>=0?'#60a5fa':'#ef4444')+';">'+(ltrNet>=0?'+':'')+'$'+Math.round(ltrNet*12).toLocaleString()+'</td>';
    h += '<td style="padding:6px;text-align:right;font-family:monospace;color:'+(strAdv>0?'#4ae3b5':'#ef4444')+';">'+(strAdv>0?'+':'')+'$'+Math.round(strAdv*12).toLocaleString()+'</td></tr>';
    h += '</tbody></table>';
    h += '<div style="margin-top:8px;font-size:0.75rem;color:#6b7280;">';
    if (strAdv > 200) h += '✅ STR earns <strong style="color:#4ae3b5;">+$'+Math.round(strAdv).toLocaleString()+'/mo more</strong> than LTR.';
    else if (strAdv > 0) h += '⚠️ STR is only +$'+Math.round(strAdv).toLocaleString()+'/mo more. Factor in management effort.';
    else h += '❌ LTR would earn <strong style="color:#ef4444;">$'+Math.abs(Math.round(strAdv)).toLocaleString()+'/mo more</strong> with less work.';
    h += ' LTR est: ~$'+ltrEstimate.toLocaleString()+'/mo. LTR has no platform fees, cleaning, or supplies.</div>';
    h += '</div>';
  }

  // ─── STRATEGIES — FULL DATA ───
  if (d.strategies && d.strategies.length > 0) {
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;">💰 Pricing Strategies ('+d.strategies.length+')</h2>';
    d.strategies.forEach(function(s) {
      var ai = s.ai_generated, isLTR = s.min_nights >= 365;
      h += '<div style="padding:14px;margin-bottom:8px;background:'+(ai?'rgba(167,139,250,0.04)':'#141721')+';border:1px solid '+(ai?'rgba(167,139,250,0.15)':'#2d3348')+';border-radius:10px;">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><div style="display:flex;gap:6px;align-items:center;"><strong>'+e(s.strategy_name)+'</strong>';
      if (ai) h += '<span style="font-size:0.6rem;padding:2px 6px;background:rgba(167,139,250,0.15);color:#a78bfa;border-radius:3px;">AI</span>';
      if (isLTR) h += '<span style="font-size:0.6rem;padding:2px 6px;background:rgba(59,130,246,0.15);color:#60a5fa;border-radius:3px;">LTR</span>';
      h += '</div><span style="font-size:0.68rem;color:#6b7280;">'+(s.created_at||'').substring(0,16).replace('T',' ')+'</span></div>';
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;font-size:0.82rem;margin-bottom:8px;">';
      function sv(l,v,c){return '<div><div style="font-size:0.58rem;color:#6b7280;">'+l+'</div><div style="font-family:monospace;font-weight:600;color:'+(c||'#e2e8f0')+';">'+v+'</div></div>';}
      h += sv('Rate','$'+s.base_nightly_rate+(isLTR?'/mo':'/nt'),'#4ae3b5');
      if (!isLTR) { h += sv('Weekend','$'+s.weekend_rate+'/nt'); h += sv('Cleaning','$'+(s.cleaning_fee||0)); }
      h += sv('Occupancy',Math.round(s.projected_occupancy*100)+'%');
      h += sv('Monthly','$'+(s.projected_monthly_avg||0).toLocaleString(),'#4ae3b5');
      h += sv('Annual','$'+(s.projected_annual_revenue||0).toLocaleString());
      if (!isLTR) {
        h += sv('Min Nights',s.min_nights||1);
        if (s.weekly_discount) h += sv('Weekly Disc','-'+s.weekly_discount+'%');
        if (s.monthly_discount) h += sv('Monthly Disc','-'+s.monthly_discount+'%');
        if (s.peak_season_markup) h += sv('Peak','+'+s.peak_season_markup+'%');
        if (s.low_season_discount) h += sv('Low Season','-'+s.low_season_discount+'%');
        if (s.pet_fee) h += sv('Pet Fee','$'+s.pet_fee);
      }
      h += '</div>';
      if (s.reasoning) {
        h += '<div style="padding:10px 12px;background:rgba(255,255,255,0.02);border-radius:6px;font-size:0.78rem;color:#9ca3af;line-height:1.6;">';
        s.reasoning.split(/\n\n|\n/).forEach(function(para) { if (para.trim()) h += '<p style="margin:0 0 6px;">'+e(para.trim())+'</p>'; });
        h += '</div>';
      }
      h += '</div>';
    });
    h += '</div>';
  }

  // ─── PLATFORMS — FULL DATA ───
  if (d.platforms && d.platforms.length > 0) {
    var pIcons = {airbnb:'🏡',vrbo:'🏖️',booking:'📘',direct:'🏠',furnished_finder:'🛋️'};
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;">🌐 Platform Listings</h2>';
    d.platforms.forEach(function(pl) {
      h += '<div style="display:flex;gap:12px;align-items:center;padding:12px;margin-bottom:6px;background:#141721;border-radius:8px;">';
      h += '<span style="font-size:1.3rem;">'+(pIcons[pl.platform]||'📋')+'</span>';
      h += '<div style="flex:1;"><strong>'+e(pl.platform.charAt(0).toUpperCase()+pl.platform.slice(1))+'</strong>';
      var dets = [];
      if (pl.nightly_rate) dets.push('<span style="color:#4ae3b5;font-weight:600;">$'+pl.nightly_rate+'/nt</span>');
      if (pl.cleaning_fee) dets.push('Clean $'+pl.cleaning_fee);
      if (pl.rating) dets.push(pl.rating+'★');
      if (pl.review_count) dets.push(pl.review_count+' reviews');
      if (pl.min_nights) dets.push('Min '+pl.min_nights+'nt');
      if (dets.length) h += '<div style="font-size:0.82rem;color:#9ca3af;margin-top:2px;">'+dets.join(' &middot; ')+'</div>';
      h += '</div>';
      if (pl.listing_url) h += '<a href="'+e(pl.listing_url)+'" target="_blank" style="padding:6px 14px;background:#2d3348;color:#4ae3b5;border-radius:6px;font-size:0.78rem;text-decoration:none;">View →</a>';
      h += '</div>';
    });
    h += '</div>';
  }

  // ─── COMPARABLES — SEPARATED BY TYPE ───
  if (d.comparables && d.comparables.length > 0) {
    var strComps = d.comparables.filter(function(c) { return c.comp_type !== 'ltr'; });
    var ltrComps = d.comparables.filter(function(c) { return c.comp_type === 'ltr'; });

    if (strComps.length > 0) {
      h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;"><span style="color:#4ae3b5;">📊 STR Comparables</span> <span style="font-size:0.75rem;color:#6b7280;">(' + strComps.length + ' short-term rentals)</span></h2>';
      h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.8rem;"><thead><tr style="border-bottom:2px solid #2d3348;color:#6b7280;">';
      ['Source','Title','BR/BA','Nightly Rate','Rating'].forEach(function(t){h+='<th style="text-align:left;padding:6px;font-size:0.68rem;text-transform:uppercase;">'+t+'</th>';});
      h += '</tr></thead><tbody>';
      strComps.forEach(function(c,i) {
        h += '<tr style="border-bottom:1px solid #1e2130;'+(i%2?'background:rgba(255,255,255,0.01);':'')+'">';
        h += '<td style="padding:6px;"><span style="font-size:0.65rem;padding:2px 6px;background:rgba(74,227,181,0.1);color:#4ae3b5;border-radius:3px;">' + e(c.source||'STR') + '</span></td>';
        h += '<td style="padding:6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+e(c.title||'')+'</td>';
        h += '<td style="padding:6px;">'+(c.bedrooms||'?')+'/'+(c.bathrooms||'?')+'</td>';
        h += '<td style="padding:6px;font-family:monospace;color:#4ae3b5;font-weight:600;">$'+(c.nightly_rate||0)+'/nt</td>';
        h += '<td style="padding:6px;">'+(c.rating?c.rating+'★':'—')+'</td></tr>';
      });
      h += '</tbody></table></div></div>';
    }

    if (ltrComps.length > 0) {
      h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;"><span style="color:#60a5fa;">🏠 LTR Comparables</span> <span style="font-size:0.75rem;color:#6b7280;">(' + ltrComps.length + ' long-term rentals)</span></h2>';
      h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.8rem;"><thead><tr style="border-bottom:2px solid #2d3348;color:#6b7280;">';
      ['Source','Title','BR/BA','Monthly Rent','Rating'].forEach(function(t){h+='<th style="text-align:left;padding:6px;font-size:0.68rem;text-transform:uppercase;">'+t+'</th>';});
      h += '</tr></thead><tbody>';
      ltrComps.forEach(function(c,i) {
        h += '<tr style="border-bottom:1px solid #1e2130;'+(i%2?'background:rgba(255,255,255,0.01);':'')+'">';
        h += '<td style="padding:6px;"><span style="font-size:0.65rem;padding:2px 6px;background:rgba(96,165,250,0.1);color:#60a5fa;border-radius:3px;">' + e(c.source||'LTR') + '</span></td>';
        h += '<td style="padding:6px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+e(c.title||'')+'</td>';
        h += '<td style="padding:6px;">'+(c.bedrooms||'?')+'/'+(c.bathrooms||'?')+'</td>';
        h += '<td style="padding:6px;font-family:monospace;color:#60a5fa;font-weight:600;">$'+(c.nightly_rate||0)+'/mo</td>';
        h += '<td style="padding:6px;">'+(c.rating?c.rating+'★':'—')+'</td></tr>';
      });
      h += '</tbody></table></div></div>';
    }
  }

  // ─── PRICELABS FULL DATA ───
  if (pl) {
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;">📊 PriceLabs Data</h2>';
    h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;font-size:0.82rem;">';
    function pd(l,v){return '<div style="padding:8px;background:#141721;border-radius:6px;"><div style="font-size:0.62rem;color:#6b7280;">'+l+'</div><div style="font-family:monospace;font-weight:600;">'+v+'</div></div>';}
    h += pd('Listing Name', e(pl.pl_listing_name||'—'));
    h += pd('Base Price', '$'+(pl.base_price||0)+'/nt');
    h += pd('Recommended', '$'+(pl.recommended_base_price||0)+'/nt');
    h += pd('Min Price', '$'+(pl.min_price||0));
    h += pd('Max Price', '$'+(pl.max_price||0));
    h += pd('Cleaning', '$'+(pl.cleaning_fees||0));
    h += pd('Group', e(pl.group_name||'Default'));
    h += pd('Occ 7d', (pl.occupancy_next_7||'—')+' (mkt: '+(pl.market_occupancy_next_7||'?')+')');
    h += pd('Occ 30d', (pl.occupancy_next_30||'—')+' (mkt: '+(pl.market_occupancy_next_30||'?')+')');
    h += pd('Occ 60d', (pl.occupancy_next_60||'—')+' (mkt: '+(pl.market_occupancy_next_60||'?')+')');
    if (pl.last_synced) h += pd('Last Synced', pl.last_synced.substring(0,16));
    h += '</div></div>';
  }

  // ─── PERFORMANCE HISTORY — ALL SNAPSHOTS ───
  if (d.snapshots && d.snapshots.length > 0) {
    var first = d.snapshots[d.snapshots.length-1], last = d.snapshots[0];
    var netCh = (last.est_monthly_net||0)-(first.est_monthly_net||0);
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 6px;">📈 Performance History ('+d.snapshots.length+' snapshots)</h2>';
    h += '<p style="font-size:0.78rem;color:#9ca3af;margin:0 0 12px;">Since '+first.snapshot_date+': Net change <strong style="color:'+(netCh>=0?'#4ae3b5':'#ef4444')+';">'+(netCh>=0?'+':'')+' $'+netCh.toLocaleString()+'/mo</strong></p>';
    h += '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.78rem;"><thead><tr style="border-bottom:2px solid #2d3348;color:#6b7280;">';
    ['Date','ADR','Fwd Occ','Market','Revenue','Expenses','Net'].forEach(function(t){h+='<th style="text-align:left;padding:5px;font-size:0.65rem;text-transform:uppercase;">'+t+'</th>';});
    h += '</tr></thead><tbody>';
    d.snapshots.forEach(function(s) {
      var nc = (s.est_monthly_net||0)>=0?'#4ae3b5':'#ef4444';
      h += '<tr style="border-bottom:1px solid #1e2130;">';
      h += '<td style="padding:5px;">'+s.snapshot_date+'</td>';
      h += '<td style="padding:5px;font-family:monospace;">$'+(s.blended_adr||0)+'</td>';
      h += '<td style="padding:5px;">'+(s.occupancy_30d||'—')+'</td>';
      h += '<td style="padding:5px;color:#6b7280;">'+(s.market_occ_30d||'—')+'</td>';
      h += '<td style="padding:5px;font-family:monospace;color:#4ae3b5;">$'+(s.est_monthly_revenue||0).toLocaleString()+'</td>';
      h += '<td style="padding:5px;font-family:monospace;color:#ef4444;">$'+(s.est_monthly_expenses||0).toLocaleString()+'</td>';
      h += '<td style="padding:5px;font-family:monospace;color:'+nc+';font-weight:600;">$'+(s.est_monthly_net||0).toLocaleString()+'</td></tr>';
    });
    h += '</tbody></table></div></div>';
  }

  // ─── AI REPORTS — TABBED: Latest + History ───
  if (d.reports && d.reports.length > 0) {
    var typeN = {pl_strategy:'📊 Pricing Strategy',revenue_optimization:'🚀 Revenue Optimization',acquisition_analysis:'🏠 Acquisition Analysis',platform_comparison:'💰 Platform Comparison'};
    // Find latest of each type
    var latest = {};
    d.reports.forEach(function(r) { if (!latest[r.type]) latest[r.type] = r; });

    h += '<div style="' + C + '">';
    h += '<div style="display:flex;gap:0;border-bottom:2px solid #2d3348;margin-bottom:14px;">';
    h += '<button onclick="shareTab(\'sr_latest\')" class="sr-tab sr-tab-active" style="padding:8px 16px;border:none;background:none;color:#4ae3b5;font-weight:600;font-size:0.82rem;cursor:pointer;border-bottom:2px solid #4ae3b5;margin-bottom:-2px;">Latest Reports</button>';
    h += '<button onclick="shareTab(\'sr_history\')" class="sr-tab" style="padding:8px 16px;border:none;background:none;color:#6b7280;font-size:0.82rem;cursor:pointer;">History (' + d.reports.length + ')</button>';
    h += '</div>';

    // ── Latest tab ──
    h += '<div id="sr_latest">';
    for (var rtype in latest) {
      var r = latest[rtype], rd = r.data || {};
      h += '<div style="padding:14px;margin-bottom:10px;background:#141721;border:1px solid #2d3348;border-radius:10px;">';
      h += '<div style="display:flex;justify-content:space-between;margin-bottom:10px;"><strong style="font-size:0.92rem;">' + (typeN[r.type]||r.type) + '</strong><span style="font-size:0.68rem;color:#6b7280;">' + (r.created_at||'').substring(0,16).replace('T',' ') + ' · ' + e(r.provider||'') + '</span></div>';
      h += renderSharedReport(r, rd, e);
      h += '</div>';
    }
    h += '</div>';

    // ── History tab ──
    h += '<div id="sr_history" style="display:none;">';
    d.reports.forEach(function(r, idx) {
      var rd = r.data || {};
      h += '<div style="padding:12px;margin-bottom:8px;background:#141721;border:1px solid #2d3348;border-radius:8px;">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
      h += '<strong style="font-size:0.85rem;">' + (typeN[r.type]||r.type) + '</strong>';
      h += '<span style="font-size:0.68rem;color:#6b7280;">' + (r.created_at||'').substring(0,16).replace('T',' ') + ' · ' + e(r.provider||'') + '</span></div>';
      // Compact summary for history
      if (r.type === 'acquisition_analysis' && rd.analysis) {
        var a = rd.analysis;
        var vc = a.verdict==='GO'?'#4ae3b5':a.verdict==='NO-GO'?'#ef4444':'#f59e0b';
        h += '<span style="font-weight:700;color:' + vc + ';">' + e(a.verdict) + '</span> — ' + '<span style="font-size:0.78rem;color:#9ca3af;">' + e((a.summary||'').substring(0,150)) + '</span>';
        if (a.projected_monthly_net) h += ' <span style="font-family:monospace;color:' + (a.projected_monthly_net>=0?'#4ae3b5':'#ef4444') + ';">' + (a.projected_monthly_net>=0?'+':'') + '$' + a.projected_monthly_net.toLocaleString() + '/mo</span>';
      } else if (r.type === 'pl_strategy' && rd.strategy) {
        var s = rd.strategy;
        h += '<span style="font-size:0.78rem;color:#9ca3af;">' + e((s.strategy_summary||'').substring(0,150)) + '</span>';
        if (s.base_price) h += ' <span style="font-family:monospace;color:#4ae3b5;">$' + s.base_price + '/nt</span>';
      } else if (r.type === 'revenue_optimization' && rd.optimization) {
        var o = rd.optimization;
        h += '<span style="font-size:0.78rem;color:#9ca3af;">Target: $' + (o.target_monthly_revenue||0).toLocaleString() + '/mo (+' + (o.revenue_increase_pct||0) + '%)</span>';
      }
      // Expand button
      h += '<div style="margin-top:6px;"><button onclick="this.parentElement.nextElementSibling.style.display=this.parentElement.nextElementSibling.style.display===\'none\'?\'block\':\'none\';this.textContent=this.textContent===\'▸ Show details\'?\'▾ Hide details\':\'▸ Show details\'" style="background:none;border:none;color:#4ae3b5;cursor:pointer;font-size:0.72rem;padding:0;">▸ Show details</button></div>';
      h += '<div style="display:none;margin-top:8px;">' + renderSharedReport(r, rd, e) + '</div>';
      h += '</div>';
    });
    h += '</div>';
    h += '</div>';
  }

  // ─── AMENITIES ───
  if (d.amenities && d.amenities.length > 0) {
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 12px;">✨ Amenities ('+d.amenities.length+')</h2>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
    d.amenities.forEach(function(a){h+='<span style="padding:5px 12px;background:#2d3348;border-radius:20px;font-size:0.75rem;">'+e(a.name)+(a.impact_score?' <span style="color:#4ae3b5;">+'+a.impact_score+'%</span>':'')+'</span>';});
    h += '</div></div>';
  }

  // ─── EXPORT BUTTONS ───
  h += '<div style="display:flex;justify-content:center;gap:8px;margin:20px 0;">';
  h += '<button onclick="sharedScreenshot()" style="padding:6px 14px;background:#1e2130;border:1px solid #2d3348;border-radius:6px;color:#e2e8f0;cursor:pointer;font-size:0.78rem;">📸 Screenshot</button>';
  h += '<button onclick="sharedPrint()" style="padding:6px 14px;background:#1e2130;border:1px solid #2d3348;border-radius:6px;color:#e2e8f0;cursor:pointer;font-size:0.78rem;">🖨️ Print</button>';
  h += '<button onclick="sharedPDF()" style="padding:6px 14px;background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);border-radius:6px;color:#a78bfa;cursor:pointer;font-size:0.78rem;">📄 PDF</button>';
  h += '</div>';

  // ─── FOOTER ───
  h += '<div style="text-align:center;padding:24px;font-size:0.72rem;color:#4b5563;">Property Market Research &middot; Complete shared view<br><a href="/" style="color:#4ae3b5;text-decoration:none;">Login to manage →</a></div>';

  document.body.innerHTML = '<div style="max-width:960px;margin:0 auto;padding:24px 16px;font-family:Inter,system-ui,sans-serif;color:#e2e8f0;background:#0f1117;min-height:100vh;">' + h + '</div>';
  document.title = (p.name || p.address) + ' — Property Analysis';
}

function shareTab(tabId) {
  ['sr_latest','sr_history'].forEach(function(id) { var el = document.getElementById(id); if (el) el.style.display = id === tabId ? '' : 'none'; });
  document.querySelectorAll('.sr-tab').forEach(function(btn) {
    var active = btn.getAttribute('onclick').indexOf(tabId) >= 0;
    btn.style.color = active ? '#4ae3b5' : '#6b7280';
    btn.style.borderBottom = active ? '2px solid #4ae3b5' : 'none';
    btn.style.marginBottom = active ? '-2px' : '0';
  });
}

function renderSharedReport(r, rd, e) {
  var h = '';
  // PL Strategy
  if (r.type === 'pl_strategy' && rd.strategy) {
    var s = rd.strategy;
    if (s.strategy_summary) h += '<div style="padding:10px;background:rgba(167,139,250,0.04);border-radius:6px;margin-bottom:8px;font-size:0.85rem;line-height:1.6;">' + e(s.strategy_summary) + '</div>';
    if (s.base_price || s.projected_monthly_revenue) {
      h += '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:0.82rem;margin-bottom:8px;">';
      if (s.base_price) h += '<span>Base: <strong style="color:#4ae3b5;">$' + s.base_price + '/nt</strong></span>';
      if (s.projected_occupancy) h += '<span>Occ: ' + Math.round(s.projected_occupancy * 100) + '%</span>';
      if (s.projected_monthly_revenue) h += '<span>Revenue: <strong style="color:#4ae3b5;">$' + s.projected_monthly_revenue.toLocaleString() + '/mo</strong></span>';
      if (s.breakeven_occupancy) h += '<span>Breakeven: ' + Math.round(s.breakeven_occupancy * 100) + '%</span>';
      h += '</div>';
    }
    if (s.key_recommendations && s.key_recommendations.length) { s.key_recommendations.forEach(function(r) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;">✓ ' + e(r) + '</div>'; }); }
    if (s.risks && s.risks.length) { h += '<div style="margin-top:6px;">'; s.risks.forEach(function(r) { h += '<div style="font-size:0.82rem;color:#f59e0b;margin:3px 0;">⚠ ' + e(r) + '</div>'; }); h += '</div>'; }
  }
  // Revenue Optimization
  if (r.type === 'revenue_optimization' && rd.optimization) {
    var o = rd.optimization;
    h += '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:10px;padding:10px;background:rgba(16,185,129,0.04);border-radius:6px;">';
    h += '<div style="text-align:center;"><div style="font-size:0.6rem;color:#6b7280;">Current</div><div style="font-family:monospace;font-size:1rem;">$' + (o.current_monthly_revenue || 0).toLocaleString() + '/mo</div></div>';
    h += '<span style="font-size:1.5rem;color:#6b7280;">→</span>';
    h += '<div style="text-align:center;"><div style="font-size:0.6rem;color:#4ae3b5;">Target</div><div style="font-family:monospace;font-size:1rem;color:#4ae3b5;">$' + (o.target_monthly_revenue || 0).toLocaleString() + '/mo</div></div>';
    h += '<span style="padding:4px 12px;background:rgba(16,185,129,0.15);color:#4ae3b5;border-radius:20px;font-weight:700;">+' + (o.revenue_increase_pct || 0) + '%</span></div>';
    if (o.quick_wins && o.quick_wins.length) { o.quick_wins.forEach(function(w) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;">⚡ ' + e(w) + '</div>'; }); }
    if (o.ninety_day_plan) h += '<div style="margin-top:8px;padding:10px;background:rgba(167,139,250,0.04);border-radius:6px;font-size:0.85rem;color:#d1d5db;line-height:1.5;"><strong style="color:#a78bfa;">90-Day Plan:</strong> ' + e(o.ninety_day_plan) + '</div>';
  }
  // Acquisition Analysis — full content
  if (r.type === 'acquisition_analysis' && rd.analysis) {
    var a = rd.analysis;
    var vc = a.verdict === 'GO' ? '#4ae3b5' : a.verdict === 'NO-GO' ? '#ef4444' : '#f59e0b';
    h += '<div style="text-align:center;padding:14px;background:rgba(255,255,255,0.02);border-radius:8px;margin-bottom:10px;">';
    h += '<div style="font-size:1.5rem;font-weight:800;color:' + vc + ';">' + e(a.verdict) + '</div>';
    if (a.confidence) h += '<div style="font-size:0.72rem;color:#6b7280;">Confidence: ' + e(a.confidence) + '</div>';
    if (a.summary) h += '<div style="font-size:0.88rem;color:#d1d5db;margin-top:6px;line-height:1.6;">' + e(a.summary) + '</div>';
    h += '</div>';
    // Metrics grid
    if (a.projected_nightly_rate || a.projected_monthly_revenue) {
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:10px;">';
      function sac(l,v,c) { return '<div style="text-align:center;padding:6px;background:#1a1d27;border-radius:6px;border:1px solid #2d3348;"><div style="font-size:0.55rem;color:#6b7280;">' + l + '</div><div style="font-family:monospace;font-size:0.88rem;font-weight:700;color:' + (c || '#e2e8f0') + ';">' + v + '</div></div>'; }
      if (a.projected_nightly_rate) h += sac('Rate', '$' + a.projected_nightly_rate + '/nt', '#4ae3b5');
      if (a.projected_occupancy_pct) h += sac('Occ', a.projected_occupancy_pct + '%');
      if (a.projected_monthly_revenue) h += sac('Revenue', '$' + a.projected_monthly_revenue.toLocaleString());
      if (a.projected_monthly_net != null) h += sac('Net', (a.projected_monthly_net >= 0 ? '+' : '') + '$' + a.projected_monthly_net.toLocaleString(), a.projected_monthly_net >= 0 ? '#4ae3b5' : '#ef4444');
      if (a.cap_rate_pct) h += sac('Cap Rate', a.cap_rate_pct + '%');
      if (a.breakeven_occupancy_pct) h += sac('Breakeven', a.breakeven_occupancy_pct + '%');
      h += '</div>';
    }
    // SWOT
    [['Strengths', a.strengths, '#4ae3b5', '💪'], ['Weaknesses', a.weaknesses, '#ef4444', '⚠️'], ['Opportunities', a.opportunities, '#a78bfa', '🎯'], ['Threats', a.threats, '#f59e0b', '🔥']].forEach(function(sw) {
      if (sw[1] && sw[1].length) { h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:' + sw[2] + ';">' + sw[3] + ' ' + sw[0] + ':</strong></div>'; sw[1].forEach(function(s) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;line-height:1.4;">• ' + e(s) + '</div>'; }); }
    });
    // Regulations
    if (a.regulations) {
      var reg = a.regulations;
      h += '<div style="margin:10px 0;padding:10px;background:#1a1d27;border-radius:6px;">';
      h += '<strong style="font-size:0.78rem;color:#d1d5db;">📜 Regulations:</strong> ';
      h += '<span style="color:' + (reg.str_allowed === true ? '#4ae3b5' : reg.str_allowed === false ? '#ef4444' : '#f59e0b') + ';">STR: ' + (reg.str_allowed === true ? '✅ Allowed' : reg.str_allowed === false ? '❌ Not allowed' : '❓ Check') + '</span>';
      if (reg.permit_required === true) h += ' · Permit required';
      if (reg.occupancy_tax_pct) h += ' · ' + reg.occupancy_tax_pct + '% tax';
      if (reg.notes) h += '<div style="font-size:0.82rem;color:#9ca3af;margin-top:4px;line-height:1.4;">' + e(reg.notes) + '</div>';
      h += '</div>';
    }
    // Area demand
    if (a.area_demand) {
      var ad = a.area_demand;
      h += '<div style="margin:8px 0;">';
      if (ad.str_demand_drivers && ad.str_demand_drivers.length) { h += '<div style="font-size:0.78rem;color:#4ae3b5;font-weight:600;">STR demand:</div>'; ad.str_demand_drivers.forEach(function(d) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:2px 0;">• ' + e(d) + '</div>'; }); }
      if (ad.ltr_demand_drivers && ad.ltr_demand_drivers.length) { h += '<div style="font-size:0.78rem;color:#60a5fa;font-weight:600;margin-top:6px;">LTR demand:</div>'; ad.ltr_demand_drivers.forEach(function(d) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:2px 0;">• ' + e(d) + '</div>'; }); }
      if (ad.seasonal_patterns) h += '<div style="font-size:0.82rem;color:#9ca3af;margin-top:4px;"><strong>Seasons:</strong> ' + e(ad.seasonal_patterns) + '</div>';
      h += '</div>';
    }
    // Future value
    if (a.future_value && (a.future_value.value_in_3_years || a.future_value.value_in_5_years)) {
      h += '<div style="margin:8px 0;font-size:0.82rem;">';
      h += '<strong style="color:#d1d5db;">📈 Future:</strong> ';
      if (a.future_value.appreciation_pct_annual) h += e(a.future_value.appreciation_pct_annual) + '%/yr · ';
      if (a.future_value.value_in_3_years) h += '3yr: $' + Math.round(a.future_value.value_in_3_years).toLocaleString() + ' · ';
      if (a.future_value.value_in_5_years) h += '5yr: $' + Math.round(a.future_value.value_in_5_years).toLocaleString();
      if (a.future_value.area_development) h += '<div style="color:#9ca3af;margin-top:3px;">' + e(a.future_value.area_development) + '</div>';
      h += '</div>';
    }
    // Upgrades
    if (a.upgrades && a.upgrades.length) {
      h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#a78bfa;">🔧 Upgrades:</strong></div>';
      a.upgrades.forEach(function(u) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;">' + e(u.name) + ': $' + (u.cost || 0).toLocaleString() + ' → +$' + (u.monthly_increase || 0) + '/mo (' + e(u.roi || '') + ')' + (u.description ? ' — <span style="color:#9ca3af;">' + e(u.description) + '</span>' : '') + '</div>'; });
    }
    if (a.sale_comps && a.sale_comps.length) {
      h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#f59e0b;">🏷️ For Sale Nearby:</strong></div>';
      a.sale_comps.forEach(function(c) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;">' + e(c.description) + ' — <span style="color:#f59e0b;font-family:monospace;">$' + (c.price || 0).toLocaleString() + '</span>' + (c.listing_url ? ' <a href="' + e(c.listing_url) + '" target="_blank" style="color:#4ae3b5;font-size:0.72rem;">View →</a>' : '') + '</div>'; });
    }
    // Conditions, breakers, outlook, recommendation
    if (a.conditions_for_go && a.conditions_for_go.length) { h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#4ae3b5;">✓ Conditions:</strong></div>'; a.conditions_for_go.forEach(function(c) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:2px 0;">• ' + e(c) + '</div>'; }); }
    if (a.deal_breakers && a.deal_breakers.length) { h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#ef4444;">✗ Deal Breakers:</strong></div>'; a.deal_breakers.forEach(function(c) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:2px 0;">• ' + e(c) + '</div>'; }); }
    if (a.market_outlook) h += '<div style="margin:8px 0;font-size:0.85rem;line-height:1.5;"><strong style="color:#d1d5db;">🌍 Market:</strong> <span style="color:#9ca3af;">' + e(a.market_outlook) + '</span></div>';
    if (a.comparable_performance) h += '<div style="margin:6px 0;font-size:0.85rem;line-height:1.5;"><strong style="color:#d1d5db;">📊 vs. Comps:</strong> <span style="color:#9ca3af;">' + e(a.comparable_performance) + '</span></div>';
    if (a.recommendation) h += '<div style="margin-top:10px;padding:12px;background:rgba(255,255,255,0.02);border:1px solid #2d3348;border-radius:6px;font-size:0.88rem;color:#d1d5db;line-height:1.6;"><strong style="color:' + vc + ';">📋 Recommendation:</strong> ' + e(a.recommendation) + '</div>';
  }
  // Platform Comparison
  if (r.type === 'platform_comparison' && rd.comparison) {
    h += '<div style="font-size:0.82rem;color:#9ca3af;">' + (rd.nights || 3) + ' nights · Best for guest: ' + (rd.summary?.cheapest_for_guest || '—') + ' · Best payout: ' + (rd.summary?.best_host_payout || '—') + '</div>';
  }
  return h;
}

function sharedPrint() {
  var content = document.body.querySelector('div[style*="max-width:960px"]');
  if (!content) return;
  var w = window.open('', '_blank');
  w.document.write('<!DOCTYPE html><html><head><title>' + document.title + '</title><style>');
  w.document.write('* { box-sizing:border-box;margin:0;padding:0; } body { font-family:-apple-system,sans-serif;color:#1a1a1a;padding:24px;max-width:900px;margin:0 auto;font-size:12px;line-height:1.5; }');
  w.document.write('div,span,td,th,p,strong { color:#1a1a1a !important; } [style*="background"] { background:white !important; } [style*="border"] { border-color:#ddd !important; }');
  w.document.write('table { border-collapse:collapse;width:100%; } th,td { padding:4px 8px;border-bottom:1px solid #eee;text-align:left; }');
  w.document.write('button { display:none !important; } [style*="color:#4ae3b5"],[style*="color: #4ae3b5"] { color:#0a7c5a !important; } [style*="color:#ef4444"] { color:#c0392b !important; } [style*="color:#a78bfa"] { color:#6b21a8 !important; } [style*="color:#f59e0b"] { color:#b45309 !important; }');
  w.document.write('@media print { body { padding:0; } @page { margin:0.5in; } }');
  w.document.write('</style></head><body>');
  w.document.write(content.innerHTML);
  w.document.write('</body></html>');
  w.document.close();
  setTimeout(function() { w.print(); }, 500);
}

function sharedPDF() { sharedPrint(); }

function sharedScreenshot() {
  var content = document.body.querySelector('div[style*="max-width:960px"]');
  if (!content) return;
  // Load html2canvas
  if (window.html2canvas) { doSharedCapture(content); return; }
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload = function() { doSharedCapture(content); };
  document.head.appendChild(s);
}

function doSharedCapture(content) {
  html2canvas(content, { backgroundColor:'#0f1117', scale:2, useCORS:true, logging:false }).then(function(canvas) {
    var link = document.createElement('a');
    link.download = (document.title || 'property-report').replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  });
}
