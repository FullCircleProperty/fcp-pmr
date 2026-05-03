// ─── Premium SVG Icon System (Lucide-inspired, 18×18, 1.5px stroke) ────────
// Returns inline SVG strings. Usage: _ico('dashboard') or _ico('home', 14, '#4ae3b5')
var _ICON_PATHS = {
  // Navigation
  dashboard:    'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1',
  grid:         'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  home:         'M3 10.5L12 3l9 7.5M5 10v9a1 1 0 001 1h4v-5h4v5h4a1 1 0 001-1v-9',
  building:     'M3 21V5a2 2 0 012-2h6a2 2 0 012 2v16M13 21V9a2 2 0 012-2h4a2 2 0 012 2v12M7 7h.01M7 11h.01M7 15h.01M17 11h.01M17 15h.01',
  tag:          'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  compass:      'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z',
  scale:        'M12 3v17.5M4 8l4 4H4zM20 8l-4 4h4zM8 8h8M5.2 20h13.6',
  search:       'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
  link:         'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
  wallet:       'M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4M4 6v12a2 2 0 002 2h14v-4M18 12a2 2 0 000 4h4v-4h-4z',
  handshake:    'M7 11l-1.7 1.7a1 1 0 000 1.4l3.6 3.6a1 1 0 001.4 0L12 16M17 11l1.7 1.7a1 1 0 010 1.4l-3.6 3.6a1 1 0 01-1.4 0L12 16M3 7h4l3-3 3 3M21 7h-4l-3-3-3 3',
  settings:     'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
  // Status / Actions
  alert:        'M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z',
  alertCircle:  'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM12 8v4M12 16h.01',
  check:        'M20 6L9 17l-5-5',
  zap:          'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  trendUp:      'M23 6l-9.5 9.5-5-5L1 18',
  trendDown:    'M23 18l-9.5-9.5-5 5L1 6',
  arrowRight:   'M5 12h14M12 5l7 7-7 7',
  refresh:      'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15',
  clock:        'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM12 6v6l4 2',
  eye:          'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
  // Finance
  handCoins:    'M11 15h2a2 2 0 100-4h-3c-1.1 0-2-.9-2-2s.9-2 2-2h3M10 20.5a1 1 0 01-1-1v-3a1 1 0 012 0v3a1 1 0 01-1 1zM14 20.5a1 1 0 01-1-1v-3a1 1 0 012 0v3a1 1 0 01-1 1zM18 3a2 2 0 100 4 2 2 0 000-4z',
  dollarSign:   'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  receipt:      'M4 2v20l4-2 4 2 4-2 4 2V2l-4 2-4-2-4 2L4 2zM8 10h8M8 14h4',
  lock:         'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4',
  unlock:       'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 019.9-1',
  camera:       'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  pieChart:     'M21.21 15.89A10 10 0 118 2.83M22 12A10 10 0 0012 2v10z',
  barChart:     'M12 20V10M18 20V4M6 20v-4',
  activity:     'M22 12h-4l-3 9L9 3l-3 9H2',
  // Data / Intel
  database:     'M12 2C6.5 2 2 4.01 2 6.5S6.5 11 12 11s10-2.01 10-4.5S17.5 2 12 2zM2 6.5v5c0 2.49 4.5 4.5 10 4.5s10-2.01 10-4.5v-5M2 11.5v5c0 2.49 4.5 4.5 10 4.5s10-2.01 10-4.5v-5',
  globe:        'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10',
  radar:        'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4zM12 2v4M12 18v4M2 12h4M18 12h4',
  target:       'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM12 18a6 6 0 100-12 6 6 0 000 12zM12 14a2 2 0 100-4 2 2 0 000 4z',
  users:        'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M23 21v-2a4 4 0 00-3-3.87M9 7a4 4 0 100-8 4 4 0 000 8zM16 3.13a4 4 0 010 7.75',
  user:         'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 7a4 4 0 100-8 4 4 0 000 8z',
  calendar:     'M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zM16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01',
  map:          'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v16M16 6v16',
  mapPin:       'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0zM12 13a3 3 0 100-6 3 3 0 000 6z',
  // UI
  sparkle:      'M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z',
  lightbulb:    'M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z',
  bookOpen:     'M2 3h6a4 4 0 014 4v14a3 3 0 00-3-3H2zM22 3h-6a4 4 0 00-4 4v14a3 3 0 013-3h7z',
  helpCircle:   'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01',
  info:         'M12 22C6.5 22 2 17.5 2 12S6.5 2 12 2s10 4.5 10 10-4.5 10-10 10zM12 16v-4M12 8h.01',
  externalLink: 'M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3',
  chevronRight: 'M9 18l6-6-6-6',
  x:            'M18 6L6 18M6 6l12 12',
  xCircle:      'M12 2a10 10 0 100 20 10 10 0 000-20zm3.54 6.46L12 11.59 8.46 8.46a1 1 0 00-1.42 1.42L10.59 12l-3.54 3.54a1 1 0 101.42 1.42L12 13.41l3.54 3.54a1 1 0 001.42-1.42L13.41 12l3.54-3.54a1 1 0 00-1.42-1.42z',
  layers:       'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  shield:       'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  // Extended icons for modern UI
  edit:         'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z',
  trash:        'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14M10 11v6M14 11v6',
  tool:         'M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z',
  package:      'M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12',
  flame:        'M12 22c-4.97 0-9-2.69-9-6s4.03-9 9-14c4.97 5 9 10.69 9 14s-4.03 6-9 6z',
  droplet:      'M12 2.69l5.66 5.66a8 8 0 11-11.31 0z',
  wifi:         'M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0M12 20h.01',
  undo:         'M3 7v6h6M3 13a9 9 0 0115.36-6.36',
  snowflake:    'M12 2v20M2 12h20M4.93 4.93l14.14 14.14M19.07 4.93L4.93 19.07',
  plug:         'M12 22v-5M9 7V2M15 7V2M5 12h14a2 2 0 002-2V7H3v3a2 2 0 002 2z',
  bell:         'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9zM13.73 21a2 2 0 01-3.46 0',
  camera:       'M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2zM12 17a4 4 0 100-8 4 4 0 000 8z',
  paw:          'M12 21c-1.5 0-3-.5-4-1.5S6 17 6 15c0-1.5 2.5-4 6-4s6 2.5 6 4-1 3-2 4.5-2.5 1.5-4 1.5zM7.5 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM16.5 10a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM4 14a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM20 14a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  briefcase:    'M20 7H4a2 2 0 00-2 2v10a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2zM16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16',
  clipboard:    'M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2M9 2h6a1 1 0 011 1v1a1 1 0 01-1 1H9a1 1 0 01-1-1V3a1 1 0 011-1z',
  fileText:     'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  heart:        'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 000-7.78z',
  heartPulse:   'M19.5 12.572l-7.5 7.428-7.5-7.428A5 5 0 0112 5.006a5 5 0 017.5 7.566zM6 12h2l2-3 2 5 2-3h2',
  trophy:       'M6 9H4.5a2.5 2.5 0 010-5H6M18 9h1.5a2.5 2.5 0 000-5H18M4 22h16M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22M18 2H6v7a6 6 0 0012 0V2z',
  alertTriangle:'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01',
  cloud:        'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z',
  cpu:          'M6 4h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
  key:          'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4',
  star:         'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  plus:         'M12 5v14M5 12h14',
  minus:        'M5 12h14',
  loader:       'M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83',
  upload:       'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
  checkCircle:  'M22 11.08V12a10 10 0 11-5.93-9.14M22 4L12 14.01l-3-3',
  checkSquare:  'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
};

function _ico(name, size, color) {
  var s = size || 18;
  var c = color || 'currentColor';
  var p = _ICON_PATHS[name];
  if (!p) return '<span style="display:inline-flex;width:' + s + 'px;height:' + s + 'px;"></span>';
  return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="' + c + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0;"><path d="' + p + '"/></svg>';
}

// Tab icon shorthand — smaller icon for nav tabs
function _tabIco(name) { return _ico(name, 15) + ' '; }

// ── Light/Dark Theme Toggle ────────────────────────────────────────────
function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme');
  var next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('pmr_theme', next);
}

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  var btn = document.getElementById('themeToggleBtn');
  if (btn) btn.textContent = theme === 'light' ? '🌙' : '☀️';
}

// Apply saved theme immediately (before DOMContentLoaded to avoid flash)
(function() {
  var saved = localStorage.getItem('pmr_theme');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
})();

// Format UTC timestamp from DB into configured timezone
var APP_TIMEZONE = 'America/New_York'; // default, overridden by admin setting on load
function fmtUTC(utcStr, includeSeconds) {
  if (!utcStr) return '';
  try {
    var d = new Date(utcStr.replace(' ', 'T') + (utcStr.includes('T') ? '' : 'Z'));
    var opts = { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE };
    if (includeSeconds) opts.second = '2-digit';
    return d.toLocaleString('en-US', opts);
  } catch(e) { return utcStr; }
}
function fmtEST(date) {
  if (!date) return '';
  try {
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: APP_TIMEZONE });
  } catch(e) { return date.toString(); }
}
function fmtDateOnly(utcStr) {
  if (!utcStr) return '';
  try {
    var d = new Date(utcStr.replace(' ', 'T') + (utcStr.includes('T') ? '' : 'Z'));
    return d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', timeZone: APP_TIMEZONE });
  } catch(e) { return utcStr; }
}
function getTimezoneAbbr() {
  try {
    var d = new Date();
    var parts = d.toLocaleString('en-US', { timeZone: APP_TIMEZONE, timeZoneName: 'short' }).split(' ');
    return parts[parts.length - 1]; // "EST" or "EDT"
  } catch(e) { return 'EST'; }
}
async function loadTimezone() {
  // Timezone is loaded via initBranding on app start — this is a fallback
  try {
    var d = await api('/api/admin/settings/branding');
    var branding = {};
    try { branding = JSON.parse(d.value || '{}'); } catch {}
    if (branding.timezone) APP_TIMEZONE = branding.timezone;
  } catch {}
}

// Global State
const API = '';
let authToken = null;
let currentUser = null;
let properties = [];
let amenities = [];
let aiEnabled = true;
let aiQuality = 'best'; // 'best' = paid AI first (Claude/GPT), 'economy' = Workers AI only
let selectedAmenities = new Set();
let analysisType = 'str';
let acDebounce = null;
let csvRows = [];
let selectedProps = new Set();
let propSortKey = 'address_asc';
let currentOwnership = 'purchased';
let currentFinancing = 'conventional';
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
    // Inject SVG icons into tabs
    document.querySelectorAll('#mainTabs .tab[data-icon]').forEach(function(tab) {
      var iconName = tab.getAttribute('data-icon');
      if (iconName && typeof _ico === 'function' && tab.textContent.indexOf('\u200b') === -1) {
        tab.innerHTML = '<span style="display:inline-flex;align-items:center;gap:5px;">' + _ico(iconName, 15) + '<span>' + tab.textContent.trim() + '</span></span>';
      }
    });
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
  if (currentUser.role === 'admin') { var mt = document.getElementById('marketingTab'); if (mt) mt.style.display = ''; }

  // Load timezone from admin settings before rendering any dates
  loadTimezone();

  // Restore AI preferences
  var savedAI = localStorage.getItem('pmr_ai_enabled');
  var savedQuality = localStorage.getItem('pmr_ai_quality');
  if (savedAI !== null) aiEnabled = savedAI === 'true';
  if (savedQuality) aiQuality = savedQuality;

  // Set AI toggle UI state
  document.getElementById('aiToggle').classList.toggle('active', aiEnabled);
  document.getElementById('aiProviderOptions').style.display = aiEnabled ? 'flex' : 'none';
  document.querySelectorAll('.ai-option').forEach(function(o) { o.classList.toggle('selected', o.dataset.quality === aiQuality); });

  // Load branding from DB
  initBranding();
  loadAdminAIState();

  // Sync theme toggle button
  var savedTheme = localStorage.getItem('pmr_theme') || 'dark';
  applyTheme(savedTheme);

  // Show version badge subtly
  api('/api/version').then(function(v) {
    var el = document.getElementById('appVersionBadge');
    if (el && v && v.version) el.textContent = 'v' + v.version;
  }).catch(function() {});

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
      if (opt.dataset.quality) {
        aiQuality = opt.dataset.quality;
        localStorage.setItem('pmr_ai_quality', aiQuality);
      }
    };
  });
  loadProperties();
  loadAmenities();
  loadDashboard();
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
function closeGenericModal() { document.getElementById('genericModal').style.display = 'none'; }
function showModal(title, bodyHtml) {
  document.getElementById('genericModalTitle').textContent = title;
  document.getElementById('genericModalBody').innerHTML = bodyHtml;
  document.getElementById('genericModal').style.display = 'flex';
}

// Generic collapsible toggle — used by compare panel and strategy cards
// el: id of element to show/hide, btn: the clicked element (optional), linkEl: <a> element (optional)
function toggleCollapsible(elId, btn, linkEl, showLabel, hideLabel) {
  var el = document.getElementById(elId);
  if (!el) return;
  var visible = el.style.display !== 'none' && el.style.display !== '';
  el.style.display = visible ? 'none' : '';
  if (btn) {
    var arrow = btn.querySelector('span');
    if (arrow) arrow.textContent = visible ? '▸' : '▾';
  }
  if (linkEl && showLabel && hideLabel) {
    linkEl.textContent = visible ? (showLabel || '▸ Show') : (hideLabel || '▾ Hide');
  }
}

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

// ── Double-click protection ──
// Usage: <button onclick="btnGuard(this, function(btn) { api(...).then(...).finally(function(){ btn.disabled=false; }) })">
// Or for event-based: btnGuard(event.target, fn)
// Disables the button immediately, re-enables after the callback's promise resolves.
function btnGuard(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  var origText = btn.innerHTML;
  try {
    var result = fn(btn);
    if (result && typeof result.then === 'function') {
      result.then(function() { btn.disabled = false; }).catch(function() { btn.disabled = false; });
    } else {
      // Synchronous or no promise — re-enable after short delay
      setTimeout(function() { btn.disabled = false; }, 1000);
    }
  } catch (e) {
    btn.disabled = false;
    throw e;
  }
}

// View Switching
// ── Navigation history stack ──
var _navHistory = [];   // [{type:'view',name:'properties'} | {type:'property',id:123,tab:'details'}]
var _navMaxDepth = 30;
var _navIgnoreNext = false; // set true when navigating backward to avoid double-push

function _navPush(entry) {
  if (_navIgnoreNext) { _navIgnoreNext = false; return; }
  // Avoid duplicate consecutive entries
  var last = _navHistory[_navHistory.length - 1];
  if (last && last.type === entry.type && last.name === entry.name && last.id === entry.id && last.tab === entry.tab) return;
  _navHistory.push(entry);
  if (_navHistory.length > _navMaxDepth) _navHistory.shift();
  _updateBackBtn();
}

function _updateBackBtn() {
  var btn = document.getElementById('globalBackBtn');
  if (!btn) return;
  // Show back if there's somewhere to go (stack has >1 entry, since last entry is current)
  if (_navHistory.length > 1) {
    btn.style.display = 'flex';
    var prev = _navHistory[_navHistory.length - 2];
    var label = prev.type === 'property' ? ('← ' + (prev.label || 'Property')) : ('← ' + _viewLabel(prev.name));
    btn.title = label;
    btn.querySelector('span').textContent = label;
  } else {
    btn.style.display = 'none';
  }
}

function _viewLabel(name) {
  return {properties:'Properties',finances:'Finances',analyze:'Price Analysis',market:'Market',comparables:'Comps',pricing:'Platform Pricing',intel:'Intel',pms:'PMS',admin:'Admin',pricelabs:'PriceLabs'}[name] || name;
}

function goBack() {
  if (_navHistory.length < 2) return;
  _navHistory.pop(); // remove current
  var prev = _navHistory[_navHistory.length - 1];
  _navIgnoreNext = true;
  if (prev.type === 'view') {
    switchView(prev.name);
  } else if (prev.type === 'property') {
    openProperty(prev.id, prev.tab || 'details');
  }
  _navIgnoreNext = false;
  _updateBackBtn();
}

async function refreshCurrentView() {
  var btn = document.getElementById('refreshBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '↻ ...'; }
  try {
    // Reload core data
    await loadProperties();
    // Re-trigger current view's data load
    var activeView = document.querySelector('.view.active');
    var name = activeView ? activeView.id.replace('view-', '') : 'dashboard';
    switchView(name);
    toast('Data refreshed');
  } catch (err) {
    toast('Refresh failed: ' + err.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.innerHTML = '↻ Refresh'; }
}

function switchView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('#mainTabs .tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  // Sync mobile bottom nav active state
  var mobileMap = { dashboard: 'dashboard', properties: 'properties', addProperty: 'properties', finances: 'finances', intel: 'intel' };
  var mobileView = mobileMap[name] || null;
  document.querySelectorAll('.mnav-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.mview === mobileView); });
  var mm = document.getElementById('mobileMoreMenu'); if (mm) mm.style.display = 'none';
  if (name === 'dashboard') loadDashboard();
  if (name === 'market') { loadMarketData(); loadMarketProfiles(); }
  if (name === 'comparables') loadComparables();
  if (name === 'analyze') { populateAnalyzeSelects(); loadPricingOverview(); }
  if (name === 'admin') { loadAdminUsers(); loadAdminUserSelect(); loadBudgetSettings(); loadAlertThresholds(); }
  if (name === 'intel') { loadIntelDashboard(); loadIntelSubTabContent(); }
  if (name === 'pms') { backToPmsGrid(); loadPmsCardStats(); }
  // Clean up monthly actuals float header when leaving PMS
  if (name !== 'pms') {
    var fh = document.getElementById('monthlyActualsFloatHeader');
    if (fh) fh.style.display = 'none';
  }
  if (name === 'finances') { loadFinances(); setTimeout(initDatePickers, 100); }
  if (name === 'portfolio') loadPortfolioIntel();
  if (name === 'bills') loadBillsTab();
  if (name === 'private-loans') loadPrivateLoansTab();
  if (name === 'management') loadManagement();
  if (name === 'pms') { setTimeout(initDatePickers, 100); }
  if (name === 'pricing') loadPricingView();
  if (name === 'marketing') loadMarketing();
  if (name === 'import') loadImportTab();
  _navPush({ type: 'view', name: name });
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
  h += '<div style="font-size:3rem;margin-bottom:12px;">' + _ico('link', 13) + '</div>';
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
  }).catch(function(e) { if (typeof toast !== 'undefined') toast(e.message || 'Error', 'error'); });
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
  if (p.is_research) h += '<span style="font-size:0.72rem;padding:3px 10px;background:rgba(167,139,250,0.15);color:#a78bfa;border-radius:20px;">Research</span>';
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
  function mc(l,v,c,s){return '<div style="text-align:center;padding:12px 6px;background:#1a1d27;border-radius:10px;border:1px solid #2d3348;"><div style="font-size:0.66rem;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;margin-bottom:3px;">'+l+'</div><div style="font-family:monospace;font-size:1.1rem;font-weight:700;color:'+(c||'#e2e8f0')+';">'+v+'</div>'+(s?'<div style="font-size:0.65rem;color:#6b7280;margin-top:1px;">'+s+'</div>':'')+'</div>';}
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
  h += '<h2 style="font-size:1.1rem;margin:0 0 14px;">' + _ico('barChart', 16, 'var(--accent)') + ' STR Financial Projections' + (adrSource ? ' <span style="font-size:0.72rem;font-weight:400;color:#6b7280;">(' + adrSource + ')</span>' : '') + '</h2>';
  function plr(label, val, color, note) {
    return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:0.82rem;'+(color?'color:'+color+';':'')+'">' +
      '<span>'+label+(note?' <span style="font-size:0.62rem;color:#6b7280;">('+note+')</span>':'')+'</span>' +
      '<span style="font-family:monospace;font-weight:600;">$'+Math.round(val).toLocaleString()+'/mo &middot; $'+Math.round(val*12).toLocaleString()+'/yr</span></div>';
  }
  h += '<div style="font-size:0.72rem;font-weight:600;color:#4ae3b5;margin-bottom:4px;">REVENUE' + (adrSource ? ' <span style="font-weight:400;color:#6b7280;">(' + adrSource + ')</span>' : '') + '</div>';
  if (strNightlyRev > 0) h += plr('Nightly Revenue', strNightlyRev, '#4ae3b5', '$'+strADR+'/nt ADR &times; '+Math.round(strOcc*30)+' nights @ '+Math.round(strOcc*100)+'% occ');
  else if (strADR === 0) h += '<div style="font-size:0.78rem;color:#f59e0b;padding:8px 0;">' + _ico('alertCircle', 13, '#f59e0b') + ' No nightly rate data — run Price Analysis or sync PriceLabs to get STR projections</div>';
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
    h += '<h2 style="font-size:1.1rem;margin:0 0 14px;">' + _ico('scale', 13) + ' STR vs LTR Comparison</h2>';
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
    if (strAdv > 200) h += '' + _ico('check', 13, 'var(--accent)') + ' STR earns <strong style="color:#4ae3b5;">+$'+Math.round(strAdv).toLocaleString()+'/mo more</strong> than LTR.';
    else if (strAdv > 0) h +='' + _ico('alertTriangle', 13, '#f59e0b') + ' STR is only +$'+Math.round(strAdv).toLocaleString()+'/mo more. Factor in management effort.';
    else h += '' + _ico('x', 13, 'var(--danger)') + ' LTR would earn <strong style="color:#ef4444;">$'+Math.abs(Math.round(strAdv)).toLocaleString()+'/mo more</strong> with less work.';
    h += ' LTR est: ~$'+ltrEstimate.toLocaleString()+'/mo. LTR has no platform fees, cleaning, or supplies.</div>';
    h += '</div>';
  }

  // ─── STRATEGIES — FULL DATA ───
  if (d.strategies && d.strategies.length > 0) {
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;">' + _ico('dollarSign', 16) + ' Pricing Strategies ('+d.strategies.length+')</h2>';
    d.strategies.forEach(function(s) {
      var ai = s.ai_generated, isLTR = s.min_nights >= 365;
      h += '<div style="padding:14px;margin-bottom:8px;background:'+(ai?'rgba(167,139,250,0.04)':'#141721')+';border:1px solid '+(ai?'rgba(167,139,250,0.15)':'#2d3348')+';border-radius:10px;">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><div style="display:flex;gap:6px;align-items:center;"><strong>'+e(s.strategy_name)+'</strong>';
      if (ai) h += '<span style="font-size:0.6rem;padding:2px 6px;background:rgba(167,139,250,0.15);color:#a78bfa;border-radius:3px;">AI</span>';
      if (isLTR) h += '<span style="font-size:0.6rem;padding:2px 6px;background:rgba(59,130,246,0.15);color:#60a5fa;border-radius:3px;">LTR</span>';
      h += '</div><span style="font-size:0.68rem;color:#6b7280;">'+fmtUTC(s.created_at||'')+'</span></div>';
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
    var pIcons = {airbnb:_ico('home',15),vrbo:_ico('home',15),booking:_ico('globe',15),direct:'' + _ico('home', 13) + '',furnished_finder:_ico('layers',15)};
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;">' + _ico('globe', 13) + ' Platform Listings</h2>';
    d.platforms.forEach(function(pl) {
      h += '<div style="display:flex;gap:12px;align-items:center;padding:12px;margin-bottom:6px;background:#141721;border-radius:8px;">';
      h += '<span style="font-size:1.3rem;">'+(pIcons[pl.platform]||'' + _ico('clipboard', 13) + '')+'</span>';
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
      h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;"><span style="color:#4ae3b5;">' + _ico('barChart', 16, 'var(--accent)') + ' STR Comparables</span> <span style="font-size:0.75rem;color:#6b7280;">(' + strComps.length + ' short-term rentals)</span></h2>';
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
      h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;"><span style="color:#60a5fa;">' + _ico('home', 16, '#60a5fa') + ' LTR Comparables</span> <span style="font-size:0.75rem;color:#6b7280;">(' + ltrComps.length + ' long-term rentals)</span></h2>';
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
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 14px;">' + _ico('barChart', 16, '#a78bfa') + ' PriceLabs Data</h2>';
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
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 6px;">' + _ico('trendUp', 16) + ' Performance History ('+d.snapshots.length+' snapshots)</h2>';
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
    var typeN = {pl_strategy:'' + _ico('barChart', 13) + ' Pricing Strategy',revenue_optimization:'' + _ico('trendUp', 13) + ' Revenue Optimization',acquisition_analysis:'' + _ico('home', 13) + ' Acquisition Analysis',platform_comparison:'' + _ico('dollarSign', 13) + ' Platform Comparison'};
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
      h += '<div style="display:flex;justify-content:space-between;margin-bottom:10px;"><strong style="font-size:0.92rem;">' + (typeN[r.type]||r.type) + '</strong><span style="font-size:0.68rem;color:#6b7280;">' + fmtUTC(r.created_at||'') + ' · ' + e(r.provider||'') + '</span></div>';
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
      h += '<span style="font-size:0.68rem;color:#6b7280;">' + fmtUTC(r.created_at||'') + ' · ' + e(r.provider||'') + '</span></div>';
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
    h += '<div style="' + C + '"><h2 style="font-size:1.1rem;margin:0 0 12px;">' + _ico('sparkle', 13) + ' Amenities ('+d.amenities.length+')</h2>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
    d.amenities.forEach(function(a){h+='<span style="padding:5px 12px;background:#2d3348;border-radius:20px;font-size:0.75rem;">'+e(a.name)+(a.impact_score?' <span style="color:#4ae3b5;">+'+a.impact_score+'%</span>':'')+'</span>';});
    h += '</div></div>';
  }

  // ─── EXPORT BUTTONS ───
  h += '<div style="display:flex;justify-content:center;gap:8px;margin:20px 0;">';
  h += '<button onclick="sharedScreenshot()" style="padding:6px 14px;background:#1e2130;border:1px solid #2d3348;border-radius:6px;color:#e2e8f0;cursor:pointer;font-size:0.78rem;">Screenshot</button>';
  h += '<button onclick="sharedPrint()" style="padding:6px 14px;background:#1e2130;border:1px solid #2d3348;border-radius:6px;color:#e2e8f0;cursor:pointer;font-size:0.78rem;">' + _ico('fileText', 13) + ' Print</button>';
  h += '<button onclick="sharedPDF()" style="padding:6px 14px;background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);border-radius:6px;color:#a78bfa;cursor:pointer;font-size:0.78rem;">' + _ico('fileText', 13) + ' PDF</button>';
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
    if (s.risks && s.risks.length) { h += '<div style="margin-top:6px;">'; s.risks.forEach(function(r) { h += '<div style="font-size:0.82rem;color:#f59e0b;margin:3px 0;">' + _ico('alertCircle', 13, '#f59e0b') + ' ' + e(r) + '</div>'; }); h += '</div>'; }
  }
  // Revenue Optimization
  if (r.type === 'revenue_optimization' && rd.optimization) {
    var o = rd.optimization;
    h += '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;margin-bottom:10px;padding:10px;background:rgba(16,185,129,0.04);border-radius:6px;">';
    h += '<div style="text-align:center;"><div style="font-size:0.6rem;color:#6b7280;">Current</div><div style="font-family:monospace;font-size:1rem;">$' + (o.current_monthly_revenue || 0).toLocaleString() + '/mo</div></div>';
    h += '<span style="font-size:1.5rem;color:#6b7280;">→</span>';
    h += '<div style="text-align:center;"><div style="font-size:0.6rem;color:#4ae3b5;">Target</div><div style="font-family:monospace;font-size:1rem;color:#4ae3b5;">$' + (o.target_monthly_revenue || 0).toLocaleString() + '/mo</div></div>';
    h += '<span style="padding:4px 12px;background:rgba(16,185,129,0.15);color:#4ae3b5;border-radius:20px;font-weight:700;">+' + (o.revenue_increase_pct || 0) + '%</span></div>';
    if (o.quick_wins && o.quick_wins.length) { o.quick_wins.forEach(function(w) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;">' + _ico('zap', 13) + ' ' + e(w) + '</div>'; }); }
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
      function sac(l,v,c) { return '<div style="text-align:center;padding:6px;background:#1a1d27;border-radius:6px;border:1px solid #2d3348;"><div style="font-size:0.65rem;color:#6b7280;">' + l + '</div><div style="font-family:monospace;font-size:0.88rem;font-weight:700;color:' + (c || '#e2e8f0') + ';">' + v + '</div></div>'; }
      if (a.projected_nightly_rate) h += sac('Rate', '$' + a.projected_nightly_rate + '/nt', '#4ae3b5');
      if (a.projected_occupancy_pct) h += sac('Occ', a.projected_occupancy_pct + '%');
      if (a.projected_monthly_revenue) h += sac('Revenue', '$' + a.projected_monthly_revenue.toLocaleString());
      if (a.projected_monthly_net != null) h += sac('Net', (a.projected_monthly_net >= 0 ? '+' : '') + '$' + a.projected_monthly_net.toLocaleString(), a.projected_monthly_net >= 0 ? '#4ae3b5' : '#ef4444');
      if (a.cap_rate_pct) h += sac('Cap Rate', a.cap_rate_pct + '%');
      if (a.breakeven_occupancy_pct) h += sac('Breakeven', a.breakeven_occupancy_pct + '%');
      h += '</div>';
    }
    // SWOT
    [['Strengths', a.strengths, '#4ae3b5', _ico('trendUp',14)], ['Weaknesses', a.weaknesses, '#ef4444', '' + _ico('alertCircle', 13, '#f59e0b') + ''], ['Opportunities', a.opportunities, '#a78bfa', '' + _ico('target', 13) + ''], ['Threats', a.threats, '#f59e0b', _ico('alertTriangle',14)]].forEach(function(sw) {
      if (sw[1] && sw[1].length) { h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:' + sw[2] + ';">' + sw[3] + ' ' + sw[0] + ':</strong></div>'; sw[1].forEach(function(s) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;line-height:1.4;">• ' + e(s) + '</div>'; }); }
    });
    // Regulations
    if (a.regulations) {
      var reg = a.regulations;
      h += '<div style="margin:10px 0;padding:10px;background:#1a1d27;border-radius:6px;">';
      h += '<strong style="font-size:0.78rem;color:#d1d5db;">' + _ico('receipt', 14) + ' Regulations:</strong> ';
      h += '<span style="color:' + (reg.str_allowed === true ? '#4ae3b5' : reg.str_allowed === false ? '#ef4444' : '#f59e0b') + ';">STR: ' + (reg.str_allowed === true ? '' + _ico('check', 13, 'var(--accent)') + ' Allowed' : reg.str_allowed === false ? '' + _ico('x', 13, 'var(--danger)') + ' Not allowed' : '' + _ico('helpCircle', 13, '#f59e0b') + ' Check') + '</span>';
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
      h += '<strong style="color:#d1d5db;">' + _ico('trendUp', 14) + ' Future:</strong> ';
      if (a.future_value.appreciation_pct_annual) h += e(a.future_value.appreciation_pct_annual) + '%/yr · ';
      if (a.future_value.value_in_3_years) h += '3yr: $' + Math.round(a.future_value.value_in_3_years).toLocaleString() + ' · ';
      if (a.future_value.value_in_5_years) h += '5yr: $' + Math.round(a.future_value.value_in_5_years).toLocaleString();
      if (a.future_value.area_development) h += '<div style="color:#9ca3af;margin-top:3px;">' + e(a.future_value.area_development) + '</div>';
      h += '</div>';
    }
    // Upgrades
    if (a.upgrades && a.upgrades.length) {
      h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#a78bfa;">' + _ico('tool', 13) + ' Upgrades:</strong></div>';
      a.upgrades.forEach(function(u) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;">' + e(u.name) + ': $' + (u.cost || 0).toLocaleString() + ' → +$' + (u.monthly_increase || 0) + '/mo (' + e(u.roi || '') + ')' + (u.description ? ' — <span style="color:#9ca3af;">' + e(u.description) + '</span>' : '') + '</div>'; });
    }
    if (a.sale_comps && a.sale_comps.length) {
      h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#f59e0b;">' + _ico('tag', 13) + ' For Sale Nearby:</strong></div>';
      a.sale_comps.forEach(function(c) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:3px 0;">' + e(c.description) + ' — <span style="color:#f59e0b;font-family:monospace;">$' + (c.price || 0).toLocaleString() + '</span>' + (c.listing_url ? ' <a href="' + e(c.listing_url) + '" target="_blank" style="color:#4ae3b5;font-size:0.72rem;">View →</a>' : '') + '</div>'; });
    }
    // Conditions, breakers, outlook, recommendation
    if (a.conditions_for_go && a.conditions_for_go.length) { h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#4ae3b5;">✓ Conditions:</strong></div>'; a.conditions_for_go.forEach(function(c) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:2px 0;">• ' + e(c) + '</div>'; }); }
    if (a.deal_breakers && a.deal_breakers.length) { h += '<div style="margin:8px 0;"><strong style="font-size:0.78rem;color:#ef4444;">✗ Deal Breakers:</strong></div>'; a.deal_breakers.forEach(function(c) { h += '<div style="font-size:0.82rem;color:#d1d5db;margin:2px 0;">• ' + e(c) + '</div>'; }); }
    if (a.market_outlook) h += '<div style="margin:8px 0;font-size:0.85rem;line-height:1.5;"><strong style="color:#d1d5db;">' + _ico('globe', 13) + ' Market:</strong> <span style="color:#9ca3af;">' + e(a.market_outlook) + '</span></div>';
    if (a.comparable_performance) h += '<div style="margin:6px 0;font-size:0.85rem;line-height:1.5;"><strong style="color:#d1d5db;">' + _ico('barChart', 14) + ' vs. Comps:</strong> <span style="color:#9ca3af;">' + e(a.comparable_performance) + '</span></div>';
    if (a.recommendation) h += '<div style="margin-top:10px;padding:12px;background:rgba(255,255,255,0.02);border:1px solid #2d3348;border-radius:6px;font-size:0.88rem;color:#d1d5db;line-height:1.6;"><strong style="color:' + vc + ';">' + _ico('receipt', 14) + ' Recommendation:</strong> ' + e(a.recommendation) + '</div>';
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

// ─── Contextual Help Guide Panel ──────────────────────────────────────────────
var _helpOpen = false;
document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && _helpOpen) toggleHelpGuide(); });

function toggleHelpGuide() {
  _helpOpen = !_helpOpen;
  var panel = document.getElementById('helpPanel');
  var overlay = document.getElementById('helpOverlay');
  var btn = document.getElementById('helpGuideBtn');
  if (!panel) return;

  if (_helpOpen) {
    // Determine current view
    var activeView = '';
    document.querySelectorAll('#mainTabs .tab').forEach(function(t) {
      if (t.classList.contains('active')) activeView = t.dataset.view || '';
    });
    // Check if we're in a property detail
    var editId = (document.getElementById('f_editId') || {}).value;
    var inPropDetail = document.getElementById('view-addProperty') && document.getElementById('view-addProperty').classList.contains('active');
    if (inPropDetail) activeView = editId ? 'propertyDetail' : 'addProperty';

    var viewLabel = document.getElementById('helpPanelViewName');
    var content = document.getElementById('helpPanelContent');
    if (viewLabel) viewLabel.textContent = _helpViewLabel(activeView);
    if (content) content.innerHTML = _helpViewContent(activeView);

    overlay.style.display = 'block';
    panel.style.display = 'block';
    setTimeout(function() { panel.style.right = '0'; }, 10);
    btn.innerHTML = '✕';
  } else {
    panel.style.right = '-400px';
    overlay.style.display = 'none';
    setTimeout(function() { panel.style.display = 'none'; }, 300);
    btn.innerHTML = '?';
  }
}

function _helpViewLabel(view) {
  var labels = {
    dashboard: 'Dashboard',
    properties: 'Properties',
    addProperty: 'Add / Edit Property',
    propertyDetail: 'Property Detail',
    analyze: 'Price Analysis',
    market: 'Market Research',
    comparables: 'Comparables',
    pricing: 'Platform Pricing',
    intel: 'Market Intelligence',
    pms: 'Integrations',
    finances: 'Finances',
    management: 'Management',
    admin: 'Admin',
  };
  return labels[view] || view;
}

function _helpViewContent(view) {
  var s = _helpSection; // shortcut

  var guides = {
    dashboard: '<p style="color:var(--text3);margin-bottom:12px;">Your command center — everything that needs your attention at a glance.</p>' +
      s('' + _ico('barChart', 13) + ' Portfolio Overview', 'Shows your total properties, investment value, equity gain/loss, and monthly fixed costs. These come from the property details you entered.') +
      s('' + _ico('dollarSign', 13) + ' Revenue Cards', 'This month vs last month gross revenue, host payout (after platform fees), bookings count, and month-over-month change. Data comes from Guesty reservation sync.') +
      s('' + _ico('calendar', 13) + ' Year to Date', 'Cumulative revenue, payout, and occupancy for the calendar year. Run Rate projects your annual revenue based on current pace.') +
      s('' + _ico('alertTriangle', 13, '#f59e0b') + ' Action Items', 'Clickable alerts for things that need your attention — pricing mismatches, unanalyzed properties, low occupancy. Click any item to jump directly to the affected property and tab.') +
      s('' + _ico('alertCircle', 13, 'var(--danger)') + ' Problem Properties', 'Properties with specific issues: low occupancy, pricing discrepancies, missing analysis, or stale strategies. Click any row to open that property\'s relevant tab.') +
      s('' + _ico('calendar', 13) + ' Upcoming Check-ins', 'Next 14 days of guest arrivals from Guesty. Shows guest name, property, dates, and channel.') +
      s('' + _ico('dollarSign', 13) + ' Pricing Alerts', 'Dates where Guesty\'s set price differs from PriceLabs recommended price by >$10. Click any to open that property\'s calendar.') +
      s('' + _ico('radar', 13) + ' Integration Status', 'Live status of Guesty and PriceLabs connections. Click to go to integration settings.') +
      s('' + _ico('key', 13) + ' API Services', 'Usage and cost tracking for all external APIs. Green dot = configured, bar shows usage vs limits.') +
      s('' + _ico('zap', 13) + ' Tips', 'Run <strong>Guesty Full Sync</strong> in Integrations first to populate revenue data. Then <strong>Rebuild Intelligence</strong> in Intel to generate demand segments and channel analysis.', 'accent'),

    properties: '<p style="color:var(--text3);margin-bottom:12px;">Your property portfolio — add, edit, and manage all properties.</p>' +
      s('' + _ico('receipt', 13) + ' Property List', 'All your properties displayed as cards. Sort by address, city, type, beds, sqft, or value. Filter by city.') +
      s('' + _ico('home', 13) + ' Property Cards', 'Click any card to open its full detail view. Cards show address, beds/baths, listing status, and key financials.') +
      s('' + _ico('zap', 13) + ' Adding Properties', 'Click <strong>+ Add Property</strong> to create manually. Or use <strong>CSV Import</strong> for bulk import. Properties auto-add their city to the market watchlist.') +
      s('' + _ico('search', 13) + ' Lookup', 'After adding, use the <strong>Lookup</strong> feature to auto-fill property data from public records — beds, baths, sqft, year built, taxes.') +
      s('' + _ico('building', 13) + ' Multi-Family', 'For buildings with units, create the building first, then add units under it. Units inherit the building address but have their own listings and financials.') +
      s('' + _ico('barChart', 13) + ' Status Filter', 'Properties with status "research" are excluded from portfolio calculations. Managed properties are shown separately in the Management tab.') +
      s('' + _ico('zap', 13) + ' Tips', 'Set <strong>Ownership Type</strong> correctly — it affects how financials are calculated. "Managed" properties appear in the Management tab with fee tracking.', 'accent'),

    addProperty: '<p style="color:var(--text3);margin-bottom:12px;">Add a new property to your portfolio.</p>' +
      s('' + _ico('receipt', 13) + ' Required Fields', 'At minimum, enter the <strong>address, city, and state</strong>. Everything else can be filled in later or via Lookup.') +
      s('' + _ico('search', 13) + ' Auto-Lookup', 'After saving, use the Lookup button to auto-fill property data from public records — beds, baths, sqft, year built, taxes, estimated value.') +
      s('' + _ico('building', 13) + ' Building + Units', 'For multi-family, create the building first. Then add units from the building\'s detail view. Units inherit the building address.') +
      s('' + _ico('dollarSign', 13) + ' Expenses', 'Enter mortgage, insurance, taxes, HOA, and utilities to get accurate profit/loss calculations in the Finances view.') +
      s('' + _ico('zap', 13) + ' Tips', 'Set <strong>Is Research</strong> for properties you\'re exploring — they\'re excluded from portfolio calculations. Set <strong>Managed for Owner</strong> for properties you manage with a fee.', 'accent'),

    propertyDetail: '<p style="color:var(--text3);margin-bottom:12px;">Full detail view for a single property — multiple tabs for different aspects.</p>' +
      s('' + _ico('edit', 13) + ' Details Tab', 'Edit all property fields: address, type, beds/baths, sqft, purchase price, estimated value, expenses. Save changes with the button at bottom.') +
      s('' + _ico('home', 13) + ' Amenities Tab', 'Track amenities that affect pricing — pool, hot tub, washer/dryer, parking, etc. These feed into AI pricing analysis.') +
      s('' + _ico('receipt', 13) + ' History Tab', 'Shows pricing strategies, comparable analyses, and AI analyses run for this property over time.') +
      s('' + _ico('barChart', 13) + ' Pricing Tab', 'Run or view AI pricing analysis. Shows recommended nightly rates, seasonal adjustments, competitive positioning, and revenue projections.') +
      s('' + _ico('dollarSign', 13) + ' Finance Tab', 'Monthly actuals from Guesty — revenue, occupancy, ADR, payout. Shows trend charts and year-over-year comparison.') +
      s('' + _ico('calendar', 13) + ' Calendar Tab', 'Day-by-day view of Guesty prices, PriceLabs recommended prices, and bookings. Highlights discrepancies between the two.') +
      s('' + _ico('link', 13) + ' Platforms Tab', 'Find and link your property across Airbnb, VRBO, Booking.com, and Furnished Finder. Shows matched listings with pricing comparison.') +
      s('' + _ico('search', 13) + ' Research Tab', 'Consolidated intelligence view — performance trend chart, competitive position vs comps, seasonality pattern, analysis timeline, and market context card showing how this property compares to its local market. Links to the full market profile.') +
      s('' + _ico('zap', 13) + ' Tips', 'The <strong>Pricing Tab</strong> is where AI analysis happens. Make sure you\'ve filled in beds, baths, sqft, and location accurately first — the AI uses all of it.', 'accent'),

    analyze: '<p style="color:var(--text3);margin-bottom:12px;">Run AI-powered pricing analysis for any property.</p>' +
      s('' + _ico('target', 13) + ' How It Works', 'Select a property, choose STR or LTR analysis type, then click <strong>Analyze</strong>. The AI examines your property details, market comps, seasonality, and expenses to recommend pricing.') +
      s('' + _ico('barChart', 13) + ' Results Include', 'Base nightly rate, weekend premium, seasonal adjustments, cleaning fee recommendation, projected occupancy, revenue estimates, and competitive positioning.') +
      s('' + _ico('sparkle', 13) + ' AI Models', 'Uses your configured AI provider (Anthropic Claude or Workers AI). The analysis considers your property amenities, local comps, and market seasonality data.') +
      s('' + _ico('zap', 13) + ' Tips', 'Run analysis periodically (monthly) to stay current with market shifts. Results are saved to the property\'s History tab for comparison over time.', 'accent'),

    market: '<p style="color:var(--text3);margin-bottom:12px;">Research any market — search for rental data, view market profiles, and track trends.</p>' +
      s('' + _ico('search', 13) + ' Market Search', 'Enter a city and state, select STR or LTR, and search. Returns cached market data, platform search links, and optional AI analysis.') +
      s('' + _ico('barChart', 13) + ' Market Profiles', 'Data-driven profiles for each watchlist city — STR listing count, average ADR, occupancy, property/bedroom mix, seasonality, and your performance vs market.') +
      s('' + _ico('trendUp', 13) + ' Snapshots', 'Historical data points showing how market metrics change over time. New snapshots are created from RentCast data (LTR only) or crawled listings.') +
      s('' + _ico('link', 13) + ' Search Links', 'Quick links to Airbnb, VRBO, Zillow, AirDNA, and other platforms pre-filtered for your search criteria.') +
      s('' + _ico('zap', 13) + ' Tips', 'Market profiles auto-populate during the daily 6am cron. The system crawls Airbnb and VRBO via SearchAPI and aggregates the data. RentCast is only used for LTR data.', 'accent'),

    comparables: '<p style="color:var(--text3);margin-bottom:12px;">View and manage comparable properties for pricing reference.</p>' +
      s('' + _ico('receipt', 13) + ' How Comps Work', 'Select a property and fetch comps. The system searches Airbnb via SearchAPI, checks the master listings database, and generates rate estimates.') +
      s('' + _ico('home', 13) + ' Comp Sources', 'Real Airbnb listings (via SearchAPI), master listings database (from crawls), LTR data (from RentCast for LTR mode), and algorithmic estimates.') +
      s('' + _ico('zap', 13) + ' Manual Comps', 'Paste any listing URL to add it as a comp. You can also manually enter comp data.') +
      s('' + _ico('zap', 13) + ' Tips', 'Comps are filtered to ±1 bedroom of your property. The more comps you have, the better your AI pricing analysis will be.', 'accent'),

    pricing: '<p style="color:var(--text3);margin-bottom:12px;">Manage platform pricing across Guesty and PriceLabs.</p>' +
      s('' + _ico('barChart', 13) + ' Calendar Sync', 'Shows your Guesty calendar prices alongside PriceLabs recommended prices. Highlights dates where prices diverge significantly.') +
      s('' + _ico('dollarSign', 13) + ' Price Discrepancies', 'Red highlights = Guesty price differs from PriceLabs by >$10. These are opportunities to align your pricing with market-driven recommendations.') +
      s('' + _ico('receipt', 13) + ' Algo Templates', 'Create reusable pricing templates with occupancy targets, weekend premiums, seasonal adjustments, and min/max rates. Assign templates to properties.') +
      s('' + _ico('refresh', 13) + ' Algo Health', 'Dashboard showing how each property\'s actual performance compares to its algorithm template targets.') +
      s('' + _ico('zap', 13) + ' Tips', 'PriceLabs handles dynamic pricing automatically. Use this view to monitor whether Guesty is actually using PriceLabs recommendations and to catch any sync issues.', 'accent'),

    intel: '<p style="color:var(--text3);margin-bottom:12px;">Market intelligence — crawled data, guest analytics, demand segments, and market monitoring.</p>' +
      s('' + _ico('radar', 13) + ' Data Hub', 'Upload screenshots, CSVs, HAR files, or PDFs for AI processing. Import listing URLs to add to the master database. View all crawled listings.') +
      s('' + _ico('users', 13) + ' Guest Intelligence', 'Analyzes guest data from Guesty — repeat guests, geographic origins, booking lead times, average stays, and demand segmentation.') +
      s('' + _ico('map', 13) + ' Market Intelligence', 'Per-market profiles built from crawled data. Shows STR landscape, property mix, pricing bands, and your performance vs market.') +
      s('' + _ico('radar', 13) + ' Channel Intelligence', 'Breaks down performance by booking channel — Airbnb vs VRBO vs Booking.com vs Direct. Shows revenue, ADR, and booking volume per channel.') +
      s('' + _ico('eye', 13) + ' Market Monitoring', 'Watchlist of cities you track. The Crawl Intelligence Engine searches Airbnb for active listings using 2 targeted searches per market (1-2BR and 3+BR), capturing rates, ratings, amenities, photos, and property type. Data feeds market profiles, AI analysis, and competitive positioning. Auto-runs daily 6am UTC with budget guard. Click Crawl for any market instantly.') +
      s('' + _ico('settings', 13) + ' Algo Health', 'Compares actual property performance against algorithm template targets. Shows where you\'re over/under-performing.') +
      s('' + _ico('refresh', 13) + ' Rebuild Intelligence', 'Click <strong>Rebuild All</strong> to reprocess all reservation data. This updates demand segments, channel stats, and guest profiles. Safe to run multiple times.') +
      s('' + _ico('zap', 13) + ' Tips', 'Run <strong>Rebuild Intelligence</strong> after any Guesty sync to keep analytics current. The watchlist auto-populates from your property cities.', 'accent'),

    pms: '<p style="color:var(--text3);margin-bottom:12px;">Connect and manage your property management systems and pricing tools.</p>' +
      s('' + _ico('building', 13) + ' Guesty', 'Connect your Guesty account with Client ID + Secret. Sync listings, reservations, calendar, and financials. Full sync pulls all historical data; quick sync gets recent changes.') +
      s('' + _ico('barChart', 13) + ' PriceLabs', 'Connect with your PriceLabs API key. Syncs recommended prices and market occupancy data. Link PriceLabs listings to your properties.') +
      s('' + _ico('link', 13) + ' Linking', 'After syncing, link each Guesty/PriceLabs listing to the correct property in your database. This is required for revenue data and calendar to flow correctly.') +
      s('' + _ico('calendar', 13) + ' Monthly Actuals', 'After linking and syncing, monthly actuals (revenue, occupancy, ADR) are calculated automatically and appear in property Finance tabs and the Finances view.') +
      s('' + _ico('zap', 13) + ' Tips', 'Run <strong>Full Sync</strong> on first setup to pull all history. After that, the daily cron runs quick syncs automatically at 6am.', 'accent'),

    finances: '<p style="color:var(--text3);margin-bottom:12px;">Portfolio-wide financial overview with period filtering.</p>' +
      s('' + _ico('barChart', 13) + ' Overview', 'Portfolio value, equity, monthly costs, and cap rate. These come from the property details you entered.') +
      s('' + _ico('trendUp', 13) + ' Revenue Performance', 'Charts and tables showing monthly revenue, occupancy, and ADR across your portfolio. Filter by period (YTD, this month, last year, etc).') +
      s('' + _ico('home', 13) + ' Property Breakdown', 'Per-property revenue, occupancy, and profitability. Click any property to open its detail view.') +
      s('' + _ico('calendar', 13) + ' Period Selector', 'Switch between YTD, This Month, Last Month, This Year, Last Year, All Time, or set a custom date range.') +
      s('' + _ico('zap', 13) + ' Tips', 'Revenue data comes from Guesty sync → monthly actuals calculation. If numbers look wrong, check that Guesty listings are properly linked to properties.', 'accent'),

    management: '<p style="color:var(--text3);margin-bottom:12px;">Track properties you manage for other owners — fees, payouts, and statements.</p>' +
      s('' + _ico('handshake', 13) + ' Managed Properties', 'Properties with ownership type "Managed for Owner." Each shows the owner name, fee percentage, and fee basis (gross or net profit).') +
      s('' + _ico('dollarSign', 13) + ' Fee Calculation', 'Revenue - Expenses = Net Profit. Your management fee is calculated on either gross revenue or net profit, per your agreement with each owner.') +
      s('' + _ico('user', 13) + ' Owner Statements', 'Per-owner cards showing total gross, expenses, your fee, and owner payout. Click <strong>Export PDF Statement</strong> to generate a professional PDF.') +
      s('' + _ico('fileText', 13) + ' PDF Export', 'Generates a downloadable PDF with financial summary, property detail table, monthly breakdowns, and fee notes. Respects the active period filter.') +
      s('' + _ico('calendar', 13) + ' Period Filter', 'Filter by YTD, This Month, Last Month, etc. PDF exports use whichever period is selected.') +
      s('' + _ico('zap', 13) + ' Tips', 'Set the fee basis per property — "gross" charges % of total revenue, "net_profit" charges % of revenue minus expenses. The PDF is suitable for sending directly to property owners.', 'accent'),

    admin: '<p style="color:var(--text3);margin-bottom:12px;">System administration — users, API keys, and budgets.</p>' +
      s('' + _ico('users', 13) + ' User Management', 'Create and manage user accounts. Approve registrations. Set roles.') +
      s('' + _ico('key', 13) + ' API Keys', 'Configure API keys for external services: Guesty, PriceLabs, RentCast, SearchAPI, Google Places, Anthropic, OpenAI.') +
      s('' + _ico('dollarSign', 13) + ' Budgets', 'Set monthly spending limits for API services to prevent unexpected costs.') +
      s('' + _ico('zap', 13) + ' Tips', 'Store API keys in Admin → Settings rather than wrangler.toml. The app checks the database first, then falls back to environment variables.', 'accent'),
  };

  return guides[view] || '<p style="color:var(--text3);padding:20px 0;">Select a tab to see its guide. The help content updates based on which page you\'re viewing.</p>';
}

function _helpSection(title, body, type) {
  var borderColor = type === 'accent' ? 'var(--accent)' : 'var(--border)';
  var bg = type === 'accent' ? 'rgba(74,227,181,0.06)' : 'var(--surface2)';
  var iconColor = type === 'accent' ? 'var(--accent)' : 'var(--text3)';
  // Extract icon hint from title prefix if present
  var titleHtml = title;
  return '<div style="margin-bottom:10px;padding:10px 12px;border-radius:8px;background:' + bg + ';border-left:3px solid ' + borderColor + ';">' +
    '<div style="font-size:0.78rem;font-weight:700;color:var(--text);margin-bottom:4px;">' + titleHtml + '</div>' +
    '<div style="font-size:0.77rem;color:var(--text2);line-height:1.55;">' + body + '</div>' +
    '</div>';
}

// ── Mobile Bottom Navigation ──────────────────────────────────────────────
function setMobileActive(btn) {
  document.querySelectorAll('.mnav-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  // Close more menu if open
  var mm = document.getElementById('mobileMoreMenu');
  if (mm) mm.style.display = 'none';
}

function toggleMobileMore() {
  var mm = document.getElementById('mobileMoreMenu');
  if (!mm) return;
  if (mm.style.display === 'none' || !mm.style.display) {
    var grid = mm.querySelector('div');
    if (grid) {
      var items = [
        { label: 'Pricing', icon: 'dollarSign', view: 'analyze' },
        { label: 'Market', icon: 'globe', view: 'market' },
        { label: 'Comps', icon: 'scale', view: 'comparables' },
        { label: 'Platforms', icon: 'layers', view: 'pricing' },
        { label: 'Integrations', icon: 'link', view: 'pms' },
        { label: 'Admin', icon: 'settings', view: 'admin' },
      ];
      if (currentUser && currentUser.role === 'admin') {
        items.splice(5, 0, { label: 'Marketing', icon: 'star', view: 'marketing' });
      }
      grid.innerHTML = items.map(function(item) {
        return '<button class="more-item" onclick="switchView(\'' + item.view + '\');setMobileActive(null);toggleMobileMore()">' + _ico(item.icon, 18) + '<span>' + item.label + '</span></button>';
      }).join('');
    }
    mm.style.display = '';
  } else {
    mm.style.display = 'none';
  }
}

// Sync mobile nav active state when switching views from non-mobile triggers

// ── Platform Intelligence Knowledge Base ──────────────────────────────────
var PLATFORM_INTEL = {
  airbnb: {
    name: 'Airbnb',
    algorithm: [
      'Search ranking heavily weights booking velocity — new listings get a 2-4 week boost, then ranking depends on conversion rate',
      'Instant Book enabled = significant ranking boost. Listings requiring approval rank lower',
      'Response time under 1 hour and acceptance rate above 88% are ranking factors',
      'Superhost status gives a search filter badge and ~5-10% visibility boost',
      'Smart Pricing turned ON signals to Airbnb you trust their algo — some hosts report better placement',
      'Calendar freshness matters — blocked or unupdated calendars drop in search',
      'Reviews within the last 90 days matter more than lifetime average'
    ],
    pricing_tips: [
      'First 3 bookings are critical — consider 10-20% launch discount to build velocity and reviews',
      'Lowering price below market by 5-10% improves search rank BUT Airbnb penalizes frequent large price swings',
      'Weekly (10-15%) and monthly (20-30%) discounts improve ranking in "stays" search',
      'Last-minute discounts (within 7 days) fill gaps without hurting your base rate perception',
      'Orphan day discounts (1-2 night gaps) dramatically improve calendar efficiency',
      'Raising prices 20%+ above market? You need 4.8+ rating and Superhost to convert'
    ],
    listing_factors: [
      'First photo determines click-through rate — use a wide-angle hero shot of the best room',
      'Minimum 20 photos, ideally 30+. Listings with fewer than 15 photos see 40% less engagement',
      'Title: lead with unique feature, not generic ("Lakefront Cabin" not "Cozy 2BR")',
      'Description: first 2 sentences appear in preview. Front-load the value proposition',
      'Amenities completeness: check every amenity that applies — this affects search filters',
      'Self check-in (lockbox/keypad) is a major filter and significantly increases bookings'
    ],
    what_hurts: [
      'Cancellations by host destroy ranking for 30+ days',
      'Response time over 24 hours tanks your visibility',
      'Outdated calendar (not updated in 14+ days) drops search position',
      'Reviews below 4.0 effectively hide you from most searches',
      'High price + low reviews = algorithmic death spiral'
    ]
  },
  vrbo: {
    name: 'VRBO',
    algorithm: [
      'Best Match ranking = booking history + traveler preferences + listing quality score',
      'Instant Book is weighted very heavily — VRBO pushes IB listings significantly higher',
      'Premier Host program gives badge and priority in search results',
      'Listing quality score based on: photos, description completeness, amenity checklist, reviews',
      'Accepts longer-stay bookings more than Airbnb — families and groups prefer VRBO',
      'VRBO charges guests a service fee — pricing psychology differs from Airbnb'
    ],
    pricing_tips: [
      'VRBO guests tend to book further in advance (30-60 days) vs Airbnb (7-21 days)',
      'Monthly and weekly discounts are very effective on VRBO — family travelers look for value',
      'Cleaning fees displayed prominently — keep them reasonable or build into nightly rate',
      'Damage deposits/waivers affect conversion — lower is better for bookings'
    ],
    listing_factors: [
      'VRBO allows more photos than Airbnb — use them all. 40+ photos perform best',
      'Property type matters more on VRBO — "Entire home" gets vastly more traffic than "Room"',
      'Highlight family-friendly features: kid beds, high chairs, fenced yard, pool',
      'VRBO description allows HTML formatting — use headers and bullet points for readability'
    ],
    what_hurts: [
      'Not having Instant Book enabled is the #1 ranking penalty on VRBO',
      'Cancellations hurt even more on VRBO than Airbnb',
      'Low photo count (<15) severely limits visibility',
      'Not responding to inquiries within 24 hours drops ranking sharply'
    ]
  },
  booking: {
    name: 'Booking.com',
    algorithm: [
      'Commission rate affects ranking — higher commission (15-18%) = higher placement. Default 15%',
      'Genius program (top-rated hosts) provides massive visibility boost and a loyalty badge',
      'Mobile rate discounts (10% off for mobile users) improve ranking significantly',
      'Free cancellation policies rank higher than strict policies',
      'Booking.com heavily favors availability — blocked dates hurt you more than on Airbnb'
    ],
    pricing_tips: [
      'Booking.com guests expect to see the total price upfront — avoid hidden fees',
      'Rate parity: Booking.com monitors your prices on other platforms. Match or face penalties',
      'Genius deals (10-15% discount for Genius members) are a strong conversion driver',
      'Country manager promotions (regional deals) can provide free marketing'
    ],
    listing_factors: [
      'Star rating system is out of 10, not 5 — 8.5+ is excellent, below 8.0 hurts visibility',
      'Photo quality requirements are higher — Booking.com may reject low-resolution images',
      'Property facilities checklist is extensive — complete every applicable field',
      'Highlight parking availability — Booking.com guests ask about parking more than any other platform'
    ],
    what_hurts: [
      'Overbookings/cancellations by host can result in temporary suspension',
      'Low review scores (below 7.0) dramatically reduce visibility',
      'Not offering free cancellation limits the guest pool significantly',
      'Slow response to guest messages affects your ranking score'
    ]
  },
  furnished_finder: {
    name: 'Furnished Finder',
    algorithm: [
      'Primarily used by traveling nurses, medical professionals, and corporate relocations',
      'No booking fees for hosts — flat monthly subscription model',
      'Search ranking based on: completeness of listing, response rate, and recency of updates',
      'MTR (mid-term rental) focused: 30+ night stays. Not suitable for nightly STR'
    ],
    pricing_tips: [
      'Price per month, not per night — guests compare against apartment rental market',
      'Include utilities in the price — traveling professionals want predictable monthly costs',
      'Discount for 3+ month stays — medical assignments typically run 13 weeks',
      'Pet-friendly listings see significantly more inquiries on Furnished Finder'
    ],
    listing_factors: [
      'Emphasize proximity to hospitals, medical centers, and corporate offices',
      'Highlight included amenities: WiFi, washer/dryer, fully stocked kitchen',
      'Monthly pricing should be clearly stated — guests filter by budget',
      'Background check and lease terms should be straightforward — nurses are vetted professionals'
    ],
    what_hurts: [
      'Not responding to inquiries within 48 hours — traveling nurses book quickly',
      'Requiring minimum stays over 90 days limits your pool significantly',
      'Not including utilities in the listed price confuses comparison shoppers',
      'Poor photos of bedroom and kitchen — these are the two most important rooms for MTR guests'
    ]
  },
  direct: {
    name: 'Direct Booking',
    algorithm: [
      'No algorithm — your website, your rules. Traffic comes from marketing, repeat guests, and referrals',
      'Google Business Profile listing can drive local search traffic to your direct booking site',
      'Repeat guest rate is the key metric — 20-30% repeat rate is excellent for STR',
      'No platform fees (save 3-15%) but you handle payments, insurance, and guest vetting'
    ],
    pricing_tips: [
      'Price 5-10% below your Airbnb rate — guests save on service fees, you save on commission',
      'Offer loyalty discounts for repeat guests (10-15% off)',
      'Package deals (weekly rates, seasonal specials) work well for direct bookings',
      'Accept multiple payment methods — Stripe, PayPal, Venmo increase conversion'
    ],
    listing_factors: [
      'Professional website with SSL, mobile-responsive, and fast load times',
      'Include a booking calendar widget — guests need to see availability instantly',
      'Guest reviews/testimonials on your site build trust outside platform credibility',
      'Clear cancellation policy, house rules, and check-in instructions upfront'
    ],
    what_hurts: [
      'No reviews visible = no trust. Import reviews from platforms to your site',
      'Slow or broken booking process — every extra click loses guests',
      'No damage protection — consider requiring a deposit or using a service like Autohost',
      'Not collecting guest emails = losing your most valuable marketing asset'
    ]
  }
};

function renderPlatformIntel(platform) {
  var p = PLATFORM_INTEL[platform];
  if (!p) return '';
  var h = '<div style="padding:14px;background:linear-gradient(165deg,var(--surface),var(--card));border:1px solid var(--border);border-radius:10px;margin-bottom:14px;">';
  h += '<div style="font-size:0.88rem;font-weight:700;color:var(--accent);margin-bottom:10px;">' + _ico('sparkle', 16, 'var(--accent)') + ' ' + esc(p.name) + ' — Platform Intelligence</div>';

  var sections = [
    { title: 'How the Algorithm Works', items: p.algorithm, icon: 'cpu', color: '#60a5fa' },
    { title: 'Pricing Strategy', items: p.pricing_tips, icon: 'dollarSign', color: 'var(--accent)' },
    { title: 'Listing Optimization', items: p.listing_factors, icon: 'edit', color: '#a78bfa' },
    { title: 'What Hurts Your Ranking', items: p.what_hurts, icon: 'alertTriangle', color: 'var(--danger)' }
  ];

  sections.forEach(function(s) {
    h += '<div style="margin-bottom:10px;">';
    h += '<div style="font-size:0.76rem;font-weight:600;color:' + s.color + ';margin-bottom:4px;display:flex;align-items:center;gap:4px;">' + _ico(s.icon, 13, s.color) + ' ' + s.title + '</div>';
    s.items.forEach(function(item) {
      h += '<div style="font-size:0.76rem;color:var(--text2);padding:2px 0 2px 16px;border-left:2px solid var(--border);margin-bottom:2px;">' + esc(item) + '</div>';
    });
    h += '</div>';
  });
  h += '</div>';
  return h;
}
