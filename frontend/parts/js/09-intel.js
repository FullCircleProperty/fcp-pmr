// Intel / Data Dump
let intelCrawlType = 'str';

async function loadIntelDashboard() {
  loadIntelStats();
  loadIntelUploads();
  loadIntelListings();
  loadCrawlJobs();
  loadGuestyStats();
}

async function loadIntelStats() {
  try {
    var d = await api('/api/intel/listings/stats');
    var h = '';
    h += '<div class="market-stat"><div class="val">' + (d.total || 0).toLocaleString() + '</div><div class="lbl">Total Listings</div></div>';
    h += '<div class="market-stat"><div class="val">' + (d.recent_7d || 0) + '</div><div class="lbl">Updated (7d)</div></div>';
    var platforms = (d.by_platform || []).map(function(p) { return p.platform + ' (' + p.c + ')'; }).join(' · ');
    if (platforms) h += '<div class="market-stat"><div class="val" style="font-size:0.82rem;">' + esc(platforms) + '</div><div class="lbl">Platforms</div></div>';
    var cities = (d.by_city || []).slice(0, 5).map(function(c) { return c.city + ' (' + c.c + ')'; }).join(' · ');
    if (cities) h += '<div class="market-stat"><div class="val" style="font-size:0.82rem;">' + esc(cities) + '</div><div class="lbl">Top Markets</div></div>';
    document.getElementById('intelStats').innerHTML = h;
  } catch {}
}

async function handleIntelUpload() {
  var input = document.getElementById('intelFileInput');
  var files = input.files;
  if (!files || files.length === 0) return;
  var statusEl = document.getElementById('intelUploadStatus');
  statusEl.style.display = '';
  statusEl.innerHTML = '';

  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    statusEl.innerHTML += '<div style="color:var(--text3);">Uploading ' + esc(f.name) + '...</div>';
    try {
      var formData = new FormData();
      formData.append('file', f);
      var resp = await fetch('/api/intel/upload', {
        method: 'POST', body: formData,
        headers: authToken ? { 'Authorization': 'Bearer ' + authToken } : {}
      });
      var d = await resp.json();
      if (d.error) {
        statusEl.innerHTML += '<div style="color:var(--danger);">✗ ' + esc(f.name) + ': ' + esc(d.error) + '</div>';
      } else {
        var color = d.listings_extracted > 0 ? 'var(--accent)' : 'var(--text2)';
        statusEl.innerHTML += '<div style="color:' + color + ';">✓ ' + esc(f.name) + ' — ' + (d.listings_extracted || 0) + ' listings extracted' + (d.ai_summary ? ' · ' + esc(d.ai_summary).substring(0, 150) : '') + '</div>';
      }
    } catch (err) {
      statusEl.innerHTML += '<div style="color:var(--danger);">✗ ' + esc(f.name) + ': ' + esc(err.message) + '</div>';
    }
  }
  input.value = '';
  toast('Upload complete');
  loadIntelStats();
  loadIntelUploads();
  loadIntelListings();
}

async function importIntelUrls() {
  var textarea = document.getElementById('intelUrlList');
  var raw = (textarea ? textarea.value : '').trim();
  if (!raw) { toast('Paste some URLs first', 'error'); return; }
  var urls = raw.split('\n').map(function(u) { return u.trim(); }).filter(function(u) { return u && u.startsWith('http'); });
  if (urls.length === 0) { toast('No valid URLs found', 'error'); return; }

  var statusEl = document.getElementById('intelUrlStatus');
  statusEl.textContent = 'Importing ' + urls.length + ' URLs...';
  showLoading('Processing URLs...');

  try {
    var d = await api('/api/intel/import-urls', 'POST', { urls: urls });
    statusEl.innerHTML = '<span style="color:var(--accent);">✓ ' + esc(d.message || 'Done') + '</span>';
    toast(d.message || 'URLs imported');
    textarea.value = '';
    loadIntelStats();
    loadIntelListings();
    loadCrawlJobs();
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  hideLoading();
}

function setCrawlType(type) {
  intelCrawlType = type;
  document.getElementById('crawlStrBtn').classList.toggle('active', type === 'str');
  document.getElementById('crawlLtrBtn').classList.toggle('active', type === 'ltr');
}

async function triggerIntelCrawl() {
  var city = (document.getElementById('intelCrawlCity').value || '').trim();
  var state = (document.getElementById('intelCrawlState').value || '').trim().toUpperCase();
  if (!city || !state) { toast('Enter city and state', 'error'); return; }
  var statusEl = document.getElementById('intelCrawlStatus');
  statusEl.textContent = 'Crawling ' + city + ', ' + state + '...';
  showLoading('Crawling ' + city + '...');
  try {
    var d = await api('/api/intel/crawl', 'POST', { city: city, state: state, listing_type: intelCrawlType });
    statusEl.innerHTML = '<span style="color:var(--accent);">✓ ' + esc(d.message || 'Done') + '</span>';
    toast(d.message || 'Crawl complete');
    loadIntelStats();
    loadIntelListings();
    loadCrawlJobs();
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--danger);">✗ ' + esc(err.message) + '</span>';
    toast(err.message, 'error');
  }
  hideLoading();
}

async function loadIntelUploads() {
  try {
    var d = await api('/api/intel/uploads');
    var uploads = d.uploads || [];
    if (uploads.length === 0) { document.getElementById('intelUploadsList').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No uploads yet. Drop a file above to get started.</p>'; return; }
    var h = '<table class="comp-table"><thead><tr><th>File</th><th>Type</th><th>Listings</th><th>Status</th><th>When</th></tr></thead><tbody>';
    uploads.forEach(function(u) {
      var statusColor = u.status === 'complete' ? 'var(--accent)' : u.status === 'failed' ? 'var(--danger)' : 'var(--text3)';
      h += '<tr><td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(u.filename || '—') + '</td>';
      h += '<td>' + esc(u.upload_type) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;">' + (u.listings_extracted || 0) + '</td>';
      h += '<td style="color:' + statusColor + ';">' + esc(u.status) + '</td>';
      h += '<td style="font-size:0.75rem;color:var(--text3);">' + (u.uploaded_at || '').substring(0, 16) + '</td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('intelUploadsList').innerHTML = h;
  } catch {}
}

async function loadIntelListings() {
  try {
    var params = [];
    var city = (document.getElementById('intelFilterCity') || {}).value;
    var state = (document.getElementById('intelFilterState') || {}).value;
    var platform = (document.getElementById('intelFilterPlatform') || {}).value;
    var type = (document.getElementById('intelFilterType') || {}).value;
    if (city) params.push('city=' + encodeURIComponent(city));
    if (state) params.push('state=' + encodeURIComponent(state.toUpperCase()));
    if (platform) params.push('platform=' + encodeURIComponent(platform));
    if (type) params.push('type=' + encodeURIComponent(type));
    var d = await api('/api/intel/listings' + (params.length ? '?' + params.join('&') : ''));
    var listings = d.listings || [];
    if (listings.length === 0) { document.getElementById('intelListingsTable').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No listings in database. Upload data, import URLs, or run a crawl.</p>'; return; }
    var h = '<div style="font-size:0.78rem;color:var(--text3);margin-bottom:6px;">' + d.count + ' listings shown (max 100)</div>';
    h += '<table class="comp-table"><thead><tr><th>Listing</th><th>Platform</th><th>City</th><th>BR</th><th>Rate</th><th>Rating</th><th>Updated</th></tr></thead><tbody>';
    listings.forEach(function(l) {
      var rate = l.nightly_rate ? '$' + Math.round(l.nightly_rate) + '/nt' : l.monthly_rate ? '$' + Math.round(l.monthly_rate) + '/mo' : '—';
      var ratingStr = l.rating ? l.rating.toFixed(1) + '★' + (l.review_count ? '(' + l.review_count + ')' : '') : '—';
      var platformIcon = { airbnb: '🏡', vrbo: '🏖️', booking: '📘', rentcast: '🔑', zillow: '🏠', manual: '✏️', csv_import: '📊' }[l.platform] || '📋';
      var titleDisplay = l.listing_url ? '<a href="' + esc(l.listing_url) + '" target="_blank" style="color:var(--accent);">' + esc((l.title || 'Listing').substring(0, 40)) + '</a>' : esc((l.title || 'Listing').substring(0, 40));
      h += '<tr><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + titleDisplay + '</td>';
      h += '<td>' + platformIcon + ' ' + esc(l.platform) + '</td>';
      h += '<td>' + esc((l.city || '') + (l.state ? ', ' + l.state : '')) + '</td>';
      h += '<td>' + (l.bedrooms || '—') + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);font-weight:600;">' + rate + '</td>';
      h += '<td>' + ratingStr + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">' + (l.last_updated || '').substring(0, 10) + '</td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('intelListingsTable').innerHTML = h;
  } catch {}
}

async function loadCrawlJobs() {
  try {
    var d = await api('/api/intel/crawl-jobs');
    var jobs = d.jobs || [];
    if (jobs.length === 0) { document.getElementById('intelCrawlJobs').innerHTML = '<p style="color:var(--text3);font-size:0.85rem;">No crawl jobs yet.</p>'; return; }
    var h = '<table class="comp-table"><thead><tr><th>Type</th><th>Target</th><th>Found</th><th>New</th><th>Status</th><th>Started</th><th>Duration</th><th></th></tr></thead><tbody>';
    jobs.slice(0, 30).forEach(function(j) {
      var statusColor = j.status === 'complete' ? 'var(--accent)' : j.status === 'failed' ? 'var(--danger)' : j.status === 'running' ? 'var(--purple)' : 'var(--text3)';
      var statusIcon = j.status === 'complete' ? '✓' : j.status === 'failed' ? '✗' : j.status === 'running' ? '⟳' : '⏳';
      var target = j.target_city ? j.target_city + ', ' + j.target_state : j.target_url ? j.target_url.substring(0, 50) : '—';
      var platform = j.target_platform ? ' <span style="font-size:0.7rem;background:var(--surface2);padding:1px 5px;border-radius:3px;">' + esc(j.target_platform) + '</span>' : '';
      // Duration
      var duration = '—';
      if (j.duration_seconds !== null && j.duration_seconds !== undefined) {
        if (j.duration_seconds < 60) duration = j.duration_seconds + 's';
        else if (j.duration_seconds < 3600) duration = Math.floor(j.duration_seconds / 60) + 'm ' + (j.duration_seconds % 60) + 's';
        else duration = Math.floor(j.duration_seconds / 3600) + 'h ' + Math.floor((j.duration_seconds % 3600) / 60) + 'm';
      } else if (j.status === 'running' && j.started_at) {
        var elapsed = Math.round((Date.now() - new Date(j.started_at + 'Z').getTime()) / 1000);
        duration = elapsed + 's (running)';
      }
      // Started timestamp
      var started = j.started_at ? j.started_at.substring(0, 16).replace('T', ' ') : (j.created_at || '').substring(0, 16).replace('T', ' ');
      // Error tooltip
      var errorTip = j.error_message ? ' title="' + esc(j.error_message) + '"' : '';
      h += '<tr><td>' + esc(j.job_type) + platform + '</td>';
      h += '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(target) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;text-align:center;">' + (j.listings_found || 0) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;color:var(--accent);text-align:center;">' + (j.listings_new || 0) + '</td>';
      h += '<td style="color:' + statusColor + ';"' + errorTip + '>' + statusIcon + ' ' + esc(j.status) + '</td>';
      h += '<td style="font-size:0.72rem;color:var(--text3);">' + esc(started) + '</td>';
      h += '<td style="font-family:DM Mono,monospace;font-size:0.78rem;">' + duration + '</td>';
      h += '<td><button class="btn btn-xs" style="color:var(--danger);border-color:var(--danger);padding:2px 6px;" onclick="deleteCrawlJob(' + j.id + ')" title="Delete">✗</button></td></tr>';
    });
    h += '</tbody></table>';
    document.getElementById('intelCrawlJobs').innerHTML = h;
  } catch {}
}

async function deleteCrawlJob(id) {
  if (!confirm('Delete this crawl job?')) return;
  try {
    await api('/api/intel/crawl-jobs/' + id, 'DELETE');
    toast('Crawl job deleted');
    loadCrawlJobs();
  } catch (err) { toast(err.message, 'error'); }
}

// Drag and drop support
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function() {
    var zone = document.getElementById('intelDropZone');
    if (!zone) return;
    zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.style.borderColor = 'var(--accent)'; zone.style.background = 'var(--accent-dim)'; });
    zone.addEventListener('dragleave', function(e) { e.preventDefault(); zone.style.borderColor = 'var(--border)'; zone.style.background = 'var(--bg)'; });
    zone.addEventListener('drop', function(e) {
      e.preventDefault(); zone.style.borderColor = 'var(--border)'; zone.style.background = 'var(--bg)';
      var input = document.getElementById('intelFileInput');
      if (e.dataTransfer.files.length > 0) { input.files = e.dataTransfer.files; handleIntelUpload(); }
    });
  });
}
