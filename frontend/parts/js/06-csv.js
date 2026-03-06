// CSV Import
function showCSVUpload() { document.getElementById('csvUploadArea').style.display = 'block'; }
function hideCSVUpload() { document.getElementById('csvUploadArea').style.display = 'none'; csvRows = []; }

function handleCSVFile(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target.result;
    csvRows = parseCSV(text);
    const preview = document.getElementById('csvPreview');
    if (csvRows.length === 0) { preview.innerHTML = '<div class="auth-message error">No valid rows found. Check CSV format.</div>'; return; }
    const cols = Object.keys(csvRows[0]);
    let h = '<div style="overflow-x:auto;"><table class="comp-table"><thead><tr>' + cols.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>';
    csvRows.slice(0, 5).forEach(r => {
      h += '<tr>' + cols.map(c => '<td>' + esc(r[c] || '') + '</td>').join('') + '</tr>';
    });
    if (csvRows.length > 5) h += '<tr><td colspan="' + cols.length + '" style="color:var(--text3)">...and ' + (csvRows.length - 5) + ' more rows</td></tr>';
    h += '</tbody></table></div>';
    preview.innerHTML = h;
    document.getElementById('csvActions').style.display = 'block';
    document.getElementById('csvCount').textContent = csvRows.length + ' properties found';
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  if (lines.length < 2) return [];
  // Detect delimiter
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delim).map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase().replace(/\s+/g, '_'));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(delim).map(v => v.replace(/^["']|["']$/g, '').trim());
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });
    if (row.address && row.city && row.state) rows.push(row);
  }
  return rows;
}

async function doCSVImport() {
  if (csvRows.length === 0) { toast('No rows to import', 'error'); return; }
  showLoading('Importing ' + csvRows.length + ' properties...');
  try {
    const d = await api('/api/properties/import-csv', 'POST', { rows: csvRows });
    toast('Imported ' + d.imported + ' properties' + (d.skipped > 0 ? ', ' + d.skipped + ' skipped' : ''));
    if (d.errors && d.errors.length > 0) d.errors.slice(0, 3).forEach(e => toast(e, 'warn'));
    hideCSVUpload();
    await loadProperties();
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

