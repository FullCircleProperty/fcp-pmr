function onAddressInput(val) {
  clearTimeout(acDebounce);
  if (!val || val.length < 3) { document.getElementById('addressSuggestions').style.display = 'none'; return; }
  acDebounce = setTimeout(() => fetchAutocomplete(val), 300);
}

async function fetchAutocomplete(query) {
  try {
    const d = await api('/api/places/autocomplete?q=' + encodeURIComponent(query));
    const box = document.getElementById('addressSuggestions');
    if (!d.predictions || d.predictions.length === 0) { box.style.display = 'none'; return; }
    box.innerHTML = d.predictions.map(p =>
      '<div class="ac-item" onclick="selectPlace(&quot;' + p.place_id + '&quot;,&quot;' + esc(p.description).replace(/"/g, '') + '&quot;)">' + esc(p.description) + '</div>'
    ).join('');
    box.style.display = 'block';
  } catch { document.getElementById('addressSuggestions').style.display = 'none'; }
}

async function selectPlace(placeId, desc) {
  document.getElementById('addressSuggestions').style.display = 'none';
  document.getElementById('f_address').value = desc;
  try {
    const d = await api('/api/places/details?place_id=' + encodeURIComponent(placeId));
    if (d.address) document.getElementById('f_address').value = d.address;
    if (d.city) document.getElementById('f_city').value = d.city;
    if (d.state) document.getElementById('f_state').value = d.state;
    if (d.zip) document.getElementById('f_zip').value = d.zip;
    if (d.latitude) document.getElementById('f_lat').value = d.latitude;
    if (d.longitude) document.getElementById('f_lng').value = d.longitude;
    if (d.county) document.getElementById('f_county').value = d.county;
    toast('Address autofilled');
  } catch (err) { toast('Could not fetch place details', 'error'); }
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('#f_address') && !e.target.closest('#addressSuggestions')) {
    const box = document.getElementById('addressSuggestions');
    if (box) box.style.display = 'none';
  }
});

// Property Lookup
// Unit Picker Modal (for multi-unit lookup results)
var pendingUnits = [];

function showUnitPicker(units) {
  pendingUnits = units.map(function(u, i) {
    return { idx: i, selected: true, unit_number: u.unit_number || 'Unit ' + (i + 1), bedrooms: u.bedrooms || 1, bathrooms: u.bathrooms || 1, sqft: u.sqft || null, property_type: u.property_type || 'apartment' };
  });
  renderUnitPicker();
  document.getElementById('unitPickerModal').style.display = 'flex';
}

function closeUnitPicker() {
  document.getElementById('unitPickerModal').style.display = 'none';
  pendingUnits = [];
}

function unitPickerSelectAll(sel) {
  pendingUnits.forEach(function(u) { u.selected = sel; });
  renderUnitPicker();
}

function togglePickerUnit(idx) {
  pendingUnits[idx].selected = !pendingUnits[idx].selected;
  renderUnitPicker();
}

function updatePickerUnitName(idx, val) {
  pendingUnits[idx].unit_number = val;
}

function renderUnitPicker() {
  var el = document.getElementById('unitPickerList');
  var selCount = pendingUnits.filter(function(u) { return u.selected; }).length;
  var h = '';
  pendingUnits.forEach(function(u, i) {
    var bg = u.selected ? 'var(--accent-dim)' : 'var(--surface2)';
    var border = u.selected ? 'rgba(74,227,181,0.3)' : 'var(--border)';
    var typeLabel = (u.property_type || 'apartment').replace(/_/g, ' ');
    h += '<div style="display:flex;gap:10px;align-items:center;padding:10px 12px;background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;margin-bottom:6px;transition:all 0.15s;">';
    h += '<input type="checkbox" ' + (u.selected ? 'checked' : '') + ' onchange="togglePickerUnit(' + i + ')" style="width:18px;height:18px;cursor:pointer;">';
    h += '<input type="text" value="' + esc(u.unit_number) + '" onchange="updatePickerUnitName(' + i + ',this.value)" style="width:100px;padding:4px 8px;font-size:0.85rem;font-weight:600;" title="Rename unit">';
    h += '<span style="font-size:0.82rem;color:var(--text2);">' + (u.bedrooms || '?') + 'BR / ' + (u.bathrooms || '?') + 'BA</span>';
    if (u.sqft) h += '<span style="font-size:0.78rem;color:var(--text3);">' + u.sqft.toLocaleString() + ' sqft</span>';
    h += '<span style="font-size:0.72rem;color:var(--text3);margin-left:auto;">' + typeLabel + '</span>';
    h += '</div>';
  });
  el.innerHTML = h;
  document.getElementById('unitPickerSummary').textContent = selCount + ' of ' + pendingUnits.length + ' units selected';
}

async function importSelectedUnits() {
  var editId = document.getElementById('f_editId').value;
  if (!editId) { toast('Save the building first', 'error'); return; }
  var selected = pendingUnits.filter(function(u) { return u.selected; });
  if (selected.length === 0) { toast('Select at least one unit', 'error'); return; }
  try {
    showLoading('Creating ' + selected.length + ' units...');
    var units = selected.map(function(u) {
      return { unit_number: u.unit_number, bedrooms: u.bedrooms, bathrooms: u.bathrooms, sqft: u.sqft, property_type: u.property_type || 'apartment' };
    });
    var d = await api('/api/properties/' + editId + '/add-units-batch', 'POST', { units: units });
    toast(d.message || selected.length + ' units created');
    closeUnitPicker();
    await loadProperties();
    await openProperty(parseInt(editId));
    switchPropTab('units');
  } catch (err) { toast(err.message, 'error'); }
  hideLoading();
}

// Lookup Confirmation Dialog
var pendingLookupData = null;
var pendingLookupChanges = [];

function closeLookupConfirm() {
  document.getElementById('lookupConfirmModal').style.display = 'none';
  pendingLookupData = null;
  pendingLookupChanges = [];
}

function lookupConfirmSelectAll(sel) {
  pendingLookupChanges.forEach(function(c) { c.selected = sel; });
  renderLookupConfirm();
}

function toggleLookupChange(idx) {
  pendingLookupChanges[idx].selected = !pendingLookupChanges[idx].selected;
  renderLookupConfirm();
}

function renderLookupConfirm() {
  var el = document.getElementById('lookupConfirmList');
  var selCount = pendingLookupChanges.filter(function(c) { return c.selected; }).length;
  var h = '';
  pendingLookupChanges.forEach(function(c, i) {
    var bg = c.selected ? 'var(--accent-dim)' : 'var(--surface2)';
    var border = c.selected ? 'rgba(74,227,181,0.3)' : 'var(--border)';
    h += '<div style="display:flex;gap:10px;align-items:center;padding:8px 12px;background:' + bg + ';border:1px solid ' + border + ';border-radius:8px;margin-bottom:4px;transition:all 0.15s;">';
    h += '<input type="checkbox" ' + (c.selected ? 'checked' : '') + ' onchange="toggleLookupChange(' + i + ')" style="width:18px;height:18px;cursor:pointer;flex-shrink:0;">';
    h += '<div style="flex:1;min-width:0;">';
    h += '<div style="font-size:0.82rem;font-weight:600;color:var(--text1);">' + esc(c.label) + '</div>';
    h += '<div style="font-size:0.78rem;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">';
    if (c.isNew) {
      h += '<span style="color:var(--accent);font-weight:500;">NEW</span> ';
      h += '<span style="color:var(--accent);">' + esc(String(c.newVal)) + '</span>';
    } else {
      h += '<span style="text-decoration:line-through;color:var(--text3);">' + esc(String(c.oldVal)) + '</span>';
      h += '<span style="color:var(--text3);">→</span>';
      h += '<span style="color:var(--accent);font-weight:500;">' + esc(String(c.newVal)) + '</span>';
    }
    h += '</div></div></div>';
  });
  el.innerHTML = h;
  document.getElementById('lookupConfirmSummary').textContent = selCount + ' of ' + pendingLookupChanges.length + ' changes selected';
}

function showLookupConfirm(lookupData) {
  pendingLookupData = lookupData;
  pendingLookupChanges = [];

  var fieldMap = [
    { key: 'city', elId: 'f_city', label: 'City' },
    { key: 'state', elId: 'f_state', label: 'State' },
    { key: 'zip', elId: 'f_zip', label: 'ZIP Code' },
    { key: 'bedrooms', elId: 'f_beds', label: 'Bedrooms' },
    { key: 'bathrooms', elId: 'f_baths', label: 'Bathrooms' },
    { key: 'sqft', elId: 'f_sqft', label: 'Sq Ft' },
    { key: 'lot_acres', elId: 'f_lot', label: 'Lot (acres)' },
    { key: 'year_built', elId: 'f_year', label: 'Year Built' },
    { key: 'estimated_value', elId: 'f_value', label: 'Estimated Value' },
    { key: 'annual_taxes', elId: 'f_taxes', label: 'Annual Taxes' },
    { key: 'property_type', elId: 'f_type', label: 'Property Type' },
    { key: 'unit_number', elId: 'f_unit', label: 'Unit Number' },
    { key: 'image_url', elId: 'f_image', label: 'Image URL' },
    { key: 'latitude', elId: 'f_lat', label: 'Latitude' },
    { key: 'longitude', elId: 'f_lng', label: 'Longitude' },
    { key: 'stories', elId: 'f_stories', label: 'Stories' },
    { key: 'parking_spaces', elId: 'f_parking', label: 'Parking Spaces' },
    { key: 'parcel_id', elId: 'f_parcel', label: 'Parcel ID' },
    { key: 'zoning', elId: 'f_zoning', label: 'Zoning' },
    { key: 'county', elId: 'f_county', label: 'County' }
  ];

  fieldMap.forEach(function(f) {
    var newVal = lookupData[f.key];
    if (!newVal && newVal !== 0) return; // skip empty lookup values
    // Special: don't override multi_family with a different type
    if (f.key === 'property_type') {
      var curType = (document.getElementById('f_type') || {}).value || '';
      if (curType === 'multi_family') return;
    }
    var el = document.getElementById(f.elId);
    if (!el) return;
    var oldVal = el.value || '';
    var newStr = String(newVal);
    if (oldVal === newStr) return; // no change
    var isEmpty = !oldVal || oldVal === '0' || oldVal === '';
    pendingLookupChanges.push({
      key: f.key, elId: f.elId, label: f.label,
      oldVal: oldVal, newVal: newStr,
      isNew: isEmpty,
      selected: isEmpty // pre-check empty fields, uncheck existing
    });
  });

  if (pendingLookupChanges.length === 0) {
    // No changes — still handle the rest (lookups summary, available units)
    finalizeLookup(lookupData);
    return;
  }

  renderLookupConfirm();
  document.getElementById('lookupConfirmModal').style.display = 'flex';
}

function applyLookupConfirmed() {
  var applied = 0;
  pendingLookupChanges.forEach(function(c) {
    if (!c.selected) return;
    var el = document.getElementById(c.elId);
    if (el) { el.value = c.newVal; applied++; }
  });
  // Handle image preview if image was updated
  var imgChange = pendingLookupChanges.find(function(c) { return c.key === 'image_url' && c.selected; });
  if (imgChange) updateImagePreview();
  toggleUnitField();
  closeLookupConfirm();
  toast(applied + ' field' + (applied !== 1 ? 's' : '') + ' updated');
  finalizeLookup(pendingLookupData);
}

async function finalizeLookup(d) {
  if (!d) return;
  var status = document.getElementById('lookupStatus');

  // If this is a building with units, save and push shared data to units
  var editId = document.getElementById('f_editId').value;
  if (editId && document.getElementById('f_type').value === 'multi_family') {
    try {
      var buildBody = {
        address: document.getElementById('f_address').value, city: document.getElementById('f_city').value,
        state: document.getElementById('f_state').value, zip: document.getElementById('f_zip').value,
        latitude: parseFloat(document.getElementById('f_lat').value) || null,
        longitude: parseFloat(document.getElementById('f_lng').value) || null,
        year_built: parseInt(document.getElementById('f_year').value) || null,
        image_url: document.getElementById('f_image').value || null,
        estimated_value: parseFloat(document.getElementById('f_value').value) || null,
        annual_taxes: parseFloat(document.getElementById('f_taxes').value) || null,
        lot_acres: parseFloat(document.getElementById('f_lot').value) || null,
        sqft: parseInt(document.getElementById('f_sqft').value) || null,
        stories: parseInt(document.getElementById('f_stories').value) || null,
        parking_spaces: parseInt(document.getElementById('f_parking').value) || null,
        parcel_id: document.getElementById('f_parcel').value || null,
        zoning: document.getElementById('f_zoning').value || null,
      };
      await api('/api/properties/' + editId, 'PUT', buildBody);
      var pushResult = await api('/api/properties/' + editId + '/push-to-units', 'POST');
      if (pushResult.updated > 0) {
        toast(pushResult.updated + ' units updated with building data');
      }
    } catch {}
  }

  // Show lookup results summary
  var lookups = d.lookups || [];
  if (lookups.length > 0) {
    var summary = lookups.map(function(s) {
      var icon = s.status === 'ok' ? '&#10004;' : s.status === 'skip' ? '&#8709;' : '&#10006;';
      return '<div style="font-size:0.82rem;margin:2px 0;"><strong>' + s.action + '</strong> ' + icon + ' ' + (s.detail || '') + '</div>';
    }).join('');
    status.innerHTML = summary;
    if (d.estimated_rent) {
      status.innerHTML += '<div style="font-size:0.82rem;margin-top:4px;color:var(--accent);">Est. rent: <strong>$' + d.estimated_rent.toLocaleString() + '/mo</strong></div>';
    }
  } else {
    status.textContent = 'Lookup complete';
  }

  // Handle available units flow
  await handleAvailableUnits(d);
}

async function handleAvailableUnits(d) {
  var editId = document.getElementById('f_editId').value;
  var isMultiFamily = document.getElementById('f_type').value === 'multi_family';
  if (!d.available_units || d.available_units.length === 0 || !isMultiFamily) return;

  // If building not saved yet, save it first so we can create child units
  if (!editId) {
    try {
      var gvf = function(id) { return (document.getElementById(id) || {}).value || ''; };
      var newBody = {
        address: gvf('f_address'), city: gvf('f_city'), state: gvf('f_state').toUpperCase(), zip: gvf('f_zip'),
        property_type: 'multi_family', bedrooms: 0, bathrooms: 0,
        sqft: parseInt(gvf('f_sqft')) || null, lot_acres: parseFloat(gvf('f_lot')) || null,
        year_built: parseInt(gvf('f_year')) || null, estimated_value: parseFloat(gvf('f_value')) || null,
        annual_taxes: parseFloat(gvf('f_taxes')) || null, image_url: gvf('f_image') || null,
        ownership_type: currentOwnership,
        latitude: parseFloat(gvf('f_lat')) || null, longitude: parseFloat(gvf('f_lng')) || null,
        stories: parseInt(gvf('f_stories')) || null,
        parking_spaces: parseInt(gvf('f_parking')) || null, parcel_id: gvf('f_parcel') || null, zoning: gvf('f_zoning') || null,
      };
      if (newBody.address && newBody.city && newBody.state) {
        var saveRes = await api('/api/properties', 'POST', newBody);
        if (saveRes.id) {
          editId = saveRes.id;
          document.getElementById('f_editId').value = editId;
          await loadProperties();
          toast('Building saved');
        }
      }
    } catch {}
  }
  if (editId) {
    // Check which units already exist
    try {
      var propData = await api('/api/properties/' + editId);
      var existingUnits = (propData.children || []).map(function(c) { return (c.unit_number || '').toLowerCase(); });
      var newUnits = d.available_units.filter(function(u) {
        var uNum = (u.unit_number || '').toLowerCase();
        return !uNum || !existingUnits.includes(uNum);
      });
      if (newUnits.length > 0) {
        showUnitPicker(newUnits);
      } else {
        toast(d.available_units.length + ' units found but all already exist');
      }
    } catch { showUnitPicker(d.available_units); }
  }
}

async function lookupPropertyData() {
  var addr = document.getElementById('f_address').value;
  var city = document.getElementById('f_city').value;
  var state = document.getElementById('f_state').value;
  var zip = document.getElementById('f_zip').value;
  var unit = (document.getElementById('f_unit') || {}).value || '';
  var propType = document.getElementById('f_type').value;
  if (!addr) { toast('Enter an address first', 'error'); return; }

  var status = document.getElementById('lookupStatus');
  status.textContent = 'Looking up property data...';
  try {
    var d = await api('/api/properties/lookup', 'POST', { address: addr, city: city, state: state, zip: zip, unit_number: unit, property_type: propType });

    // Show confirmation dialog instead of directly filling fields
    showLookupConfirm(d);
    toast('Property data loaded');
  } catch (err) { status.textContent = err.message; toast(err.message, 'error'); }
}

