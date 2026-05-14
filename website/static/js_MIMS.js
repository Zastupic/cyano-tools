// MIMS full script — robust ASC/ASCI + CSV parsing with correct unit mapping,
// plotting (Plotly), normalization, linear regression, table and XLSX export.
// (Make sure Plotly, PapaParse and XLSX are loaded on the page.)

// ======================
// 0) Globals
// ======================
let selectedFile = null;
let mimsRawData = [];            // array of { Time, min, <field>: value, ... }
let mimsXField = "";             // 'min'
let mimsYFields = [];            // canonical field names (no units appended)
let mimsFieldUnits = {};         // map canonical field -> unit string (e.g. 'A', 'mbar', '%')
let mimsFieldColors = {};        // map canonical field -> color (string)
let currentZoomRange = null;
let regressionResults = [];      // list of regression objects
let rawTraceIndicesBySelection = new Map();
let normTraceIndicesBySelection = new Map();
let selectionCounter = 0;
let regressionSortKey = 'time';  // 'id' or 'time'
let regressionSortDir = 'asc';   // 'asc' or 'desc'
let mimsCalibrations = {};       // signal -> { type, slope, intercept, unit, calR2, nPoints, points }
let mimsNormFactor = null;       // { mode:'single'|'multi', unit, value?, samples? } or null
let normMode = 'single';         // UI mode before Apply: 'single' | 'multi'
let normMultiDraft = [];         // editable rows for multi mode: [{name,start,end,value}]
let normSingleDraft = { value: '', unit: '' }; // editable draft for single mode
let clickRegressionMode = false; // click-to-place regression mode
let photoMode = false;           // photosynthesis rate calculation mode
let regressionConditions = {};   // selectionId -> 'light' | 'dark' | null
let newRegressionCondition = null; // pre-selected condition for the next regression

// ======================
// 1) Helpers
// ======================
function splitColumnsPreserve(line) {
  // Preserve empty tokens. Prefer tab-splitting; otherwise split by 2+ spaces.
  if (line.indexOf('\t') >= 0) {
    // preserve exact tokens (don't trim to preserve empties; trim later)
    return line.split('\t').map(s => s === undefined ? '' : s);
  } else {
    // split by two or more spaces (keeps empty leading/trailing tokens)
    return line.split(/\s{2,}/).map(s => s === undefined ? '' : s);
  }
}

function trimTokens(arr) {
  return arr.map(t => (t === null || t === undefined) ? '' : String(t).trim());
}

function parseNumberStringToFloat(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (t === '') return null;
  // replace comma decimal with dot, allow scientific notation
  const n = Number(t.replace(/,/g, '.'));
  return Number.isFinite(n) ? n : null;
}

function ensureUniqueLabel(base, existing) {
  if (!existing.has(base)) { existing.add(base); return base; }
  let i = 2;
  while (existing.has(`${base}_${i}`)) i++;
  const lbl = `${base}_${i}`;
  existing.add(lbl);
  return lbl;
}

// Replace all "/" with "_" in a string
function replaceAllSlashesInString(s) {
    if (s === null || s === undefined) return s;
    return String(s).replace(/\//g, "_");
}

// ======================
// 2) ASC/ASCI parsing (robust) -> returns { data, fields, xField, yFields }
// ======================
function parseAsciiContent(content) {
  const lines = content.split(/\r\n|\r|\n/g);
  // 1. Pre-scan for Quadstar "Datablock" units (e.g., Datablock 0 Ion Current [A])
  const channelMeta = {}; // Map of '0/0' -> { unit: 'A', name: 'Ion Current' }
  let currentUnit = null;
  let currentName = null;
  for (const line of lines) {
    if (line.trim().startsWith('Datablock')) {
      // Extract unit inside brackets, e.g. [A] or [mbar]
      const unitMatch = line.match(/\[([^\]]+)\]/);
      currentUnit = unitMatch ? unitMatch[1].trim() : null;

      // Extract the name before the unit
      const beforeBracket = unitMatch ? line.substring(0, unitMatch.index).trim() : line.trim();
      const beforeParts = beforeBracket.split(/\s+/);
      currentName = beforeParts.slice(2).join(' ').trim(); // e.g., "Ion Current" or "PKR"
    } else {
      // Look for channel ID lines starting with 'x/y'
      const parts = splitColumnsPreserve(line).map(s => s.trim());
      if (parts.length >= 2 && parts[0].match(/^'\d+\/\d+'$/) && currentUnit) {
        const id = parts[0];
        const denomStr = parts[1];
        const denom = parseFloat(denomStr);
        channelMeta[id] = { unit: currentUnit, name: currentName };
        if (!isNaN(denom)) {
          channelMeta[id].denom = denom;
        }
      }
    }
  }

  // Find header index: line that contains 'Time' and 'Relative [s]' ideally
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/Time\s+Relative\s*\[s\]|Time\s*\[s\]|RelTime\s*\[s\]/i.test(L)) { headerIndex = i; break; }
  }
  if (headerIndex === -1) {
    // Fallback: line containing 'Time' and 'Concentration' or 'Ion Current' etc.
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/\bTime\b/i.test(L) && /(Ion Current|Concentration|Pressure|Relative)/i.test(L)) { headerIndex = i; break; }
    }
  }
  if (headerIndex === -1) {
    return { data: [], fields: [], xField: null, yFields: [] };
  }

  const channelLine = (lines[headerIndex - 1] || '');
  const headerLine = (lines[headerIndex] || '');
  const dataLines = lines.slice(headerIndex + 1).filter(l => l.trim() !== '');

  // Split header & channel lines preserving columns
  let headerCols = splitColumnsPreserve(headerLine);
  let channelCols = splitColumnsPreserve(channelLine);
  headerCols = trimTokens(headerCols);
  channelCols = trimTokens(channelCols);

  // Pad channelCols to same length as headerCols
  while (channelCols.length < headerCols.length) channelCols.push('');

  // Find all Time Relative indices
  const timeRelRegex = /Time\s+Relative\s*\[s\]|Time\s*\[s\]|RelTime\s*\[s\]/i;
  const timeIndices = [];
  for (let i = 0; i < headerCols.length; i++) {
    if (timeRelRegex.test(headerCols[i])) timeIndices.push(i);
  }
  console.log('Header columns:', headerCols); // DEBUG: Check exact header strings
  console.log('Time indices (should include RelTime[s] column):', timeIndices); // DEBUG: If empty, regex didn't match

  // For each timeRelative index, pick the measurement column(s) to the right
  let measurementIndices = [];
  if (timeIndices.length === 1) {
    // Single time column format: take all subsequent non-empty columns as measurements
    const ti = timeIndices[0];
    for (let j = ti + 1; j < headerCols.length; j++) {
      const c = headerCols[j] || '';
      if (c.trim() !== '') {
        measurementIndices.push(j);
      }
    }
  } else {
    // Original logic: one measurement per time column
    timeIndices.forEach(ti => {
      let found = null;
      for (let j = ti + 1; j < Math.min(headerCols.length, ti + 6); j++) {
        const c = headerCols[j] || '';
        if (!/\bTime\b/i.test(c) && c.trim() !== '') { found = j; break; }
      }
      if (found !== null) measurementIndices.push(found);
    });
  }

  // Fallback: any non-Time columns
  if (measurementIndices.length === 0) {
    for (let i = 0; i < headerCols.length; i++) {
      if (!/\bTime\b/i.test(headerCols[i]) && headerCols[i].trim() !== '') measurementIndices.push(i);
    }
  }

  // Unique & sorted
  const uniqMeas = Array.from(new Set(measurementIndices)).sort((a,b) => a - b);

  // Build canonical labels using column index alignment with channelCols
  const labels = []; // objects: { label, colIdx, unit }
  const usedLabels = new Set();
  uniqMeas.forEach(colIdx => {
    const headerLabel = headerCols[colIdx] || `Signal${colIdx}`;
    // Check if this header matches a known Quadstar identifier (e.g. '0/0')
    let metaUnit = null;
    let metaName = null;
    let metaDenom = null;
    if (channelMeta[headerLabel]) {
      metaUnit = channelMeta[headerLabel].unit;
      metaName = channelMeta[headerLabel].name;
      metaDenom = channelMeta[headerLabel].denom;
    }
    const unitMatch = headerLabel.match(/\[([^\]]+)\]/);
    const unit = metaUnit || (unitMatch ? unitMatch[1].trim() : null);

    // Channel label may appear above the block's first column; try same col, then left offsets
    let channelToken = '';
    const leftOffsets = [0, -1, -2, -3];
    for (const off of leftOffsets) {
      const idx = colIdx + off;
      if (idx >= 0 && idx < channelCols.length) {
        const token = channelCols[idx];
        if (token && token.trim() !== '') { channelToken = token.trim(); break; }
      }
    }

    const cleanedHeader = headerLabel.replace(/\s*\[[^\]]+\]/, '').trim().replace(/['"]/g, ''); // Remove quotes
    let baseLabel = metaName ? `${metaName} ${metaDenom || cleanedHeader}` : (channelToken || cleanedHeader || `Signal${colIdx}`);
    // Ensure uniqueness
    const label = ensureUniqueLabel(baseLabel, usedLabels);
    labels.push({ label, colIdx, unit });
    mimsFieldUnits[label] = unit;
  });

  // Parse data rows. For each row choose canonical time as the first available TimeRelative value (scanning timeIndices).
  const data = [];
  for (const line of dataLines) {
    const parts = splitColumnsPreserve(line).map(p => (p === undefined ? '' : String(p).trim()));
    while (parts.length < headerCols.length) parts.push('');
    // Find first available time from timeIndices
    let timeVal = null;
    for (const ti of timeIndices) {
      const raw = parts[ti] !== undefined ? parts[ti] : '';
      const parsed = parseNumberStringToFloat(raw);
      if (parsed !== null) { timeVal = parsed; break; }
    }
    // Fallback: any 'Time' column
    if (timeVal === null) {
      for (let i = 0; i < headerCols.length; i++) {
        if (/\bTime\b/i.test(headerCols[i])) {
          const parsed = parseNumberStringToFloat(parts[i]);
          if (parsed !== null) { timeVal = parsed; break; }
        }
      }
    }
    if (timeVal === null) {
      console.log('Skipping row due to no valid timeVal:', parts); // DEBUG: If rows are skipped, log why
      continue; // skip line without usable time
    }

    const row = { Time: timeVal };
    labels.forEach(({ label, colIdx }) => {
      const raw = parts[colIdx] !== undefined ? parts[colIdx] : '';
      row[label] = parseNumberStringToFloat(raw);
    });
    row.min = row.Time !== null ? row.Time / 60 : null;
    data.push(row);
  }

  const yFields = labels.map(o => o.label);
  const fields = ['min', ...yFields];
  const xField = 'min';
  const fieldUnits = {};
  labels.forEach(o => fieldUnits[o.label] = o.unit);

  return { data, fields, xField, yFields, fieldUnits };
}

// ======================
// 3) Full parse wrapper (CSV + ASC) — signature: parseMIMSFile(file, callback(result))
// result: { data, fields, xField, yFields }
// ======================
function parseMIMSFile(file, callback) {
  const reader = new FileReader();
  reader.onload = function(e) {
    const content = e.target.result;
    const fname = (file.name || '').toLowerCase();

    // ASC/ASCI (MS GAS)
    if (fname.endsWith('.asc') || fname.endsWith('.asci')) {
      // quick sanity check
      if (!/Time\s+Relative\s*\[s\]/i.test(content) && !/Time\s*\[s\]/i.test(content) && !/RelTime\s*\[s\]/i.test(content)) {
      // === CHANGE MADE HERE === if (!/Time\s+Relative\s*\[s\]/i.test(content) && !/Time\s*\[s\]/i.test(content)) {
        document.getElementById('mims-error-alert').innerHTML = `<div class="alert alert-danger">Missing \"Time Relative [s]\" header in ASC/ASCI file.</div>`;
        return;
      }
      try {
        const parsed = parseAsciiContent(content);
        if (!parsed || !parsed.data || parsed.data.length === 0) {
          document.getElementById('mims-error-alert').innerHTML = `<div class="alert alert-danger">No data parsed from ASC/ASCI file.</div>`;
          return;
        }
        // copy units map to global
        mimsFieldUnits = parsed.fieldUnits || {};
        callback({ data: parsed.data, fields: parsed.fields, xField: parsed.xField, yFields: parsed.yFields });
      } catch (err) {
        document.getElementById('mims-error-alert').innerHTML = `<div class="alert alert-danger">Parsing error: ${err.message}</div>`;
      }
      return;
    }

    // CSV (HPR40)
    const pattern = /"Time"\s*,\s*"ms"/gi;
    const matches = [...content.matchAll(pattern)];
    if (matches.length < 1) {
      document.getElementById('mims-error-alert').innerHTML = `<div class="alert alert-danger">Missing "Time" and "ms" columns in CSV.</div>`;
      return;
    }
    const startIndex = matches[0].index;
    const usableContent = content.slice(startIndex);
    Papa.parse(usableContent, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: function(results) {
        let data = results.data;
        let fields = results.meta.fields;
        // drop empty columns
        fields = fields.filter(field => data.some(row => {
          const v = row[field]; return v !== null && v !== undefined && v !== '' && !Number.isNaN(v);
        }));
        // add min column
        data.forEach(row => { row['min'] = typeof row['ms'] === 'number' ? row['ms'] / 60000 : null; });
        const msIndex = fields.indexOf('ms');
        if (msIndex !== -1) fields = [...fields.slice(0, msIndex + 1), 'min', ...fields.slice(msIndex + 1)];
        else fields.push('min');
        const xField = fields.includes('min') ? 'min' : (fields.includes('ms') ? 'ms' : 'Time');
        const yFields = fields.filter(f => !['Time','ms','min'].includes(f));
        // extract units
        yFields.forEach(f => {
          const match = (''+f).match(/\[([^\]]+)\]/);
          mimsFieldUnits[f] = match ? match[1] : null;
        });
        callback({ data, fields, xField, yFields });
      },
      error: function(err) {
        document.getElementById('mims-error-alert').innerHTML = `<div class="alert alert-danger">CSV parsing error: ${err.message}</div>`;
      }
    });
  };
  reader.readAsText(file);
}

// ======================
// 4) Plot raw MIMS data
// ======================
function plotMIMSData({ data, xField, yFields }) {
  mimsRawData = data; mimsXField = xField; mimsYFields = yFields;

  // create traces with unit in legend but keep canonical field identifiers in mimsYFields
  const traces = yFields.map((field) => {
    const unit = mimsFieldUnits[field] || null;
    return {
      x: data.map(row => row[xField]),
      y: data.map(row => row[field]),
      mode: 'lines',
      name: unit ? `${field} [${unit}]` : field,
      line: { width: 2 }
    };
  });

  const rawPlotTitle = {
    text: `Raw MIMS data<br><span style="font-size:0.85em;">${selectedFile ? selectedFile.name : ''}</span>`,
    font: { size: 13 }
  };

  Plotly.newPlot('raw-plot-div', traces, {
    title: rawPlotTitle,
    xaxis: { title: xField === 'min' ? 'Time (min)' : xField },
    yaxis: { title: 'Signal', tickformat: '.1e' },
    //legend: { orientation: 'h' }
  }).then(plot => {
    // store colors by canonical field (index-based)
    plot.data.forEach((trace, i) => {
      const field = yFields[i];
      mimsFieldColors[field] = trace.line && trace.line.color ? trace.line.color : undefined;
    });
    document.getElementById('raw-container').style.display = 'block';
    document.getElementById('preview-label').style.display = 'block';
    updateRawYAxisLabel();
    const rawEl = document.getElementById('raw-plot-div');
    rawEl.on('plotly_click', handlePlotClick);
  });

  populateNormalizationDropdown(yFields);
  document.getElementById('normalization-controls').style.display = 'block';
  requestAnimationFrame(() => Plotly.Plots.resize('raw-plot-div'));
}

function updateRawYAxisLabel() {
  const units = Array.from(new Set(mimsYFields.map(f => mimsFieldUnits[f] || null)));
  let title = 'Signal';
  if (units.length === 1 && units[0]) title = `Signal (${units[0]})`;
  else if (units.length > 1) title = 'Signal (mixed units)';
  else title = 'Signal (unit not found)';
  Plotly.relayout('raw-plot-div', { 'yaxis.title.text': title }).catch(()=>{});
}

function updateNormYAxisLabel() {
  const units = Array.from(new Set(mimsYFields.map(f => mimsFieldUnits[f] || null)));
  let title = 'Drift-corrected signal';
  if (units.length === 1 && units[0]) title = `Drift-corrected signal (${units[0]})`;
  else if (units.length > 1) title = 'Drift-corrected signal (mixed units)';
  else title = 'Drift-corrected signal (unit not found)';
  Plotly.relayout('normalized-plot-div', { 'yaxis.title.text': title }).catch(()=>{});
}

// ======================
// 5) Normalization UI & plotting
// ======================
function populateNormalizationDropdown(yFields) {
  const normalizeSelect = document.getElementById('normalize-by-select');
  normalizeSelect.innerHTML = '';

  // Preference order for auto-selection: saved value > Ar/N2 keywords > first field
  const savedRef = localStorage.getItem('mims_lastRefSignal');
  let bestMatchIndex = 0;

  yFields.forEach((field, i) => {
    const opt = document.createElement('option');
    const unit = mimsFieldUnits[field];
    opt.value = field;
    opt.textContent = unit ? `${field} [${unit}]` : field;
    normalizeSelect.appendChild(opt);

    // Prefer saved selection (exact match)
    if (savedRef && field === savedRef) { bestMatchIndex = i; }
    // Fallback: prefer Ar/Argon/N2/N signal keywords if no saved match yet
    else if (!savedRef || bestMatchIndex === 0) {
      const fl = field.toLowerCase();
      if (/\bar\b|argon|^n2$|^n$|^n\s|nitrogen/.test(fl)) { bestMatchIndex = i; }
    }
  });

  normalizeSelect.selectedIndex = bestMatchIndex;

  // Restore or set sensible default baseline time
  const savedTime = localStorage.getItem('mims_lastNormTime');
  const timepointInput = document.getElementById('norm-timepoint');
  if (savedTime !== null && savedTime !== '') {
    timepointInput.value = savedTime;
  } else {
    // Default: second data point time to avoid t=0 and first-point noise
    const validTimes = mimsRawData
      .map(r => r[mimsXField])
      .filter(t => typeof t === 'number')
      .sort((a, b) => a - b);
    const secondValidTime = validTimes.length >= 2 ? validTimes[1] : validTimes[0];
    timepointInput.value = secondValidTime !== undefined ? secondValidTime.toFixed(4) : '';
  }
}

document.getElementById('normalize-button').addEventListener('click', function() {
  // Persist user selections for next session / next file
  const refField = document.getElementById('normalize-by-select').value;
  const tpVal = document.getElementById('norm-timepoint').value;
  if (refField) localStorage.setItem('mims_lastRefSignal', refField);
  if (tpVal !== '') localStorage.setItem('mims_lastNormTime', tpVal);
  plotNormalizedData();
});

// Persist reference signal selection on change
document.getElementById('normalize-by-select').addEventListener('change', function() {
  if (this.value) localStorage.setItem('mims_lastRefSignal', this.value);
});

// Persist timepoint on change
document.getElementById('norm-timepoint').addEventListener('change', function() {
  if (this.value !== '') localStorage.setItem('mims_lastNormTime', this.value);
});

function plotNormalizedData() {
  const refField = document.getElementById('normalize-by-select').value;
  const data = mimsRawData; const xField = mimsXField; const yFields = mimsYFields;
  const errorDiv = document.getElementById('norm-timepoint-error');
  if (errorDiv) errorDiv.textContent = '';

  // --- Validate and find refInitialValue ---
  const tpInput = document.getElementById('norm-timepoint');
  const tpValue = tpInput ? parseFloat(tpInput.value) : NaN;

  const allTimes = data.map(r => r[xField]).filter(t => typeof t === 'number');
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);

  if (isNaN(tpValue) || tpValue < minTime || tpValue > maxTime) {
    if (errorDiv) errorDiv.textContent =
      `Time point ${tpValue} is outside measured range [${minTime.toFixed(2)}, ${maxTime.toFixed(2)}] min. Please select a valid value.`;
    return; // don't plot
  }

  // Find row closest to selected time point
  let refRowIndex = 0;
  let bestDiff = Infinity;
  data.forEach((row, i) => {
    const diff = Math.abs((row[xField] || 0) - tpValue);
    if (diff < bestDiff) { bestDiff = diff; refRowIndex = i; }
  });
  const refInitialValue = data[refRowIndex][refField];
  if (typeof refInitialValue !== 'number' || refInitialValue === 0) {
    if (errorDiv) errorDiv.textContent =
      `Reference signal "${refField}" has no valid value at time ${tpValue.toFixed(2)} min.`;
    return;
  }

  // --- Clear previous regressions (they used old normalization) ---
  clearRegressionTracesFromPlots();
  regressionResults = [];
  refreshRegressionTable();
  selectionCounter = 0;
  currentZoomRange = null;

  // --- Build normalized traces ---
  const traces = yFields.map(field => {
    const yValues = data.map(row => {
      const val = row[field]; const refVal = row[refField];
      return (typeof val === 'number' && typeof refVal === 'number' && refVal !== 0)
        ? val / (refVal / refInitialValue)
        : null;
    });
    const unit = mimsFieldUnits[field] || null; const refUnit = mimsFieldUnits[refField] || null;
    const left = unit ? `${field} [${unit}]` : field;
    const right = refUnit ? `${refField} [${refUnit}]` : refField;
    return {
      x: data.map(row => row[xField]),
      y: yValues,
      mode: 'lines',
      name: `${left} / ${right}`,
      line: { width: 2, dash: field === refField ? 'dot' : 'solid', color: mimsFieldColors[field] || undefined }
    };
  });

  const normPlotTitle = {
    text: [
      'Normalized MIMS signals',
      `<span style="font-size:0.85em;">drift-corrected using ${refField}, baseline at t = ${tpValue.toFixed(2)} min</span>`,
      `<span style="font-size:0.85em;">${selectedFile ? selectedFile.name : ''}</span>`
    ].join('<br>'),
    font: { size: 13 }
  };

  Plotly.newPlot('normalized-plot-div', traces, {
    title: normPlotTitle,
    xaxis: { title: xField === 'min' ? 'Time (min)' : xField },
    yaxis: { title: 'Drift-corrected signal', tickformat: '.1e' }
  }).then(() => {
    updateNormYAxisLabel();
    const np = document.getElementById('normalized-plot-div');
    np.on('plotly_relayout', function(eventData) {
      if (eventData['xaxis.range[0]'] !== undefined && eventData['xaxis.range[1]'] !== undefined) {
        currentZoomRange = { x0: parseFloat(eventData['xaxis.range[0]']), x1: parseFloat(eventData['xaxis.range[1]']) };
      }
    });
    np.on('plotly_click', handlePlotClick);
  });

  document.getElementById('normalized-container').style.display = 'block';
  document.getElementById('normalized-preview-label').style.display = 'block';
  document.getElementById('find-coefficients-label').style.display = 'block';
  document.getElementById('early-xlsx-download-section').style.display = 'block';
  const interpGuide = document.getElementById('mims-interpretation-guide');
  if (interpGuide) interpGuide.style.display = 'block';

  requestAnimationFrame(() => {
    document.getElementById('regression-controls-row').style.display = 'flex';
    document.getElementById('photo-mode-row').style.display = 'flex';
    // Activate click mode by default
    if (!clickRegressionMode) toggleClickMode();
    Plotly.Plots.resize('normalized-plot-div');
  });
}


// ======================
// 6) Regression fitting
// ======================

// Click-to-place mode
function handlePlotClick(eventData) {
  if (!eventData || !eventData.points || !eventData.points.length) return;
  const pt = eventData.points[0];

  // Clicking a regression fit line → delete that regression
  if (pt.data && pt.data.name) {
    const match = pt.data.name.match(/^Selection (\d+) Fit:/);
    if (match) {
      deleteRegression(parseInt(match[1]));
      return;
    }
  }

  // Otherwise: place new regression at click point (only when click mode is on)
  if (!clickRegressionMode) return;
  const xCenter = parseFloat(pt.x);
  if (isNaN(xCenter)) return;
  const inputEl = document.getElementById('click-window-input');
  const windowMin = (inputEl && parseFloat(inputEl.value) > 0) ? parseFloat(inputEl.value) : 2;
  const half = windowMin / 2;
  applyLinearRegression(xCenter - half, xCenter + half);
}

function toggleClickMode() {
  clickRegressionMode = !clickRegressionMode;
  const btn = document.getElementById('click-mode-btn');
  if (btn) {
    btn.classList.toggle('btn-warning', clickRegressionMode);
    btn.classList.toggle('btn-outline-warning', !clickRegressionMode);
    btn.textContent = clickRegressionMode ? '🎯 Click mode ON — click a plot to place regression' : '🎯 Click mode';
  }
}

document.getElementById('confirm-selection-button').addEventListener('click', function() {
  if (!currentZoomRange) { alert('Please zoom in on the normalized plot to select a range first.'); return; }
  applyLinearRegression(currentZoomRange.x0, currentZoomRange.x1);
});

document.getElementById('clear-regressions-in-table-button').addEventListener('click', function() {
  if (regressionResults.length === 0) { alert('No selections to clear.'); return; }
  const selectionIds = regressionResults.map(r => r.selectionId);
  const maxSelectionId = Math.max(...selectionIds);
  const rawIndicesToRemove = rawTraceIndicesBySelection.get(maxSelectionId) || [];
  const normIndicesToRemove = normTraceIndicesBySelection.get(maxSelectionId) || [];
  if (rawIndicesToRemove.length) try { Plotly.deleteTraces('raw-plot-div', rawIndicesToRemove); } catch(e){ console.error(e); }
  if (normIndicesToRemove.length) try { Plotly.deleteTraces('normalized-plot-div', normIndicesToRemove); } catch(e){ console.error(e); }
  regressionResults = regressionResults.filter(r => r.selectionId !== maxSelectionId);
  rawTraceIndicesBySelection.delete(maxSelectionId); normTraceIndicesBySelection.delete(maxSelectionId);
  refreshRegressionTable();
});

function applyLinearRegression(x0, x1) {
  selectionCounter++;
  const data = mimsRawData; const xField = mimsXField; const yFields = mimsYFields;
  const refField = document.getElementById('normalize-by-select').value;
  const filtered = data.filter(row => typeof row[xField] === 'number' && row[xField] >= x0 && row[xField] <= x1);
  if (filtered.length < 2) { alert('Not enough data points in selected range.'); selectionCounter--; return; }

  const rawRegressionTraces = [];
  const normRegressionTraces = [];

  const tpValue = parseFloat(document.getElementById('norm-timepoint').value);
  let refRowIndex = 0, bestDiff = Infinity;
  data.forEach((row, i) => {
    const diff = Math.abs((row[xField] || 0) - tpValue);
    if (diff < bestDiff) { bestDiff = diff; refRowIndex = i; }
  });
  const refInitialValue = data[refRowIndex][refField];

  yFields.forEach(field => {
    // gather valid pairs
    const pairs = filtered.map(r => ({ x: r[xField], y: r[field] })).filter(p => typeof p.x === 'number' && typeof p.y === 'number');
    if (pairs.length < 2) {
      regressionResults.push({
        selectionId: selectionCounter, signal: field, unit: mimsFieldUnits[field] || null,
        start_time: x0, start_time_ms: Math.round(x0 * 60 * 1000), end_time: x1, end_time_ms: Math.round(x1 * 60 * 1000),
        slopeRaw: NaN, r2Raw: NaN, slopeNorm: NaN, r2Norm: NaN
      });
      return;
    }

    const x = pairs.map(p => p.x);
    const yRaw = pairs.map(p => p.y);
    const n = x.length;
    const sumX = x.reduce((a,b) => a+b, 0);
    const sumY = yRaw.reduce((a,b) => a+b, 0);
    const sumXY = x.reduce((s, xi, i) => s + xi * yRaw[i], 0);
    const sumXX = x.reduce((s, xi) => s + xi*xi, 0);
    const denom = (n * sumXX - sumX * sumX);
    const slopeRaw = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : NaN;
    const interceptRaw = denom !== 0 ? (sumY - slopeRaw * sumX) / n : NaN;
    const yPredRaw = x.map(xi => slopeRaw * xi + interceptRaw);
    const ssTotRaw = yRaw.reduce((s, yi) => s + Math.pow(yi - (sumY / n), 2), 0);
    const ssResRaw = yRaw.reduce((s, yi, i) => s + Math.pow(yi - yPredRaw[i], 2), 0);
    const r2Raw = ssTotRaw !== 0 ? 1 - (ssResRaw / ssTotRaw) : NaN;

    rawRegressionTraces.push({
      x: [x0, x1],
      y: [slopeRaw * x0 + interceptRaw, slopeRaw * x1 + interceptRaw],
      mode: 'lines',
      name: `Selection ${selectionCounter} Fit: ${field} ${mimsFieldUnits[field] ? '[' + mimsFieldUnits[field] + ']' : ''}`,
      line: { dash: 'dot', width: 2, color: mimsFieldColors[field] || 'black' },
      hovertemplate: `<b>Selection ${selectionCounter} — ${field}</b><br>Click to remove<extra></extra>`
    });

    // normalized
    let slopeNorm = NaN, r2Norm = NaN;
    const normPairs = filtered.map(r => {
      const val = r[field], ref = r[refField];
      return { x: r[xField], y: (typeof val === 'number' && typeof ref === 'number' && ref !== 0) ? val / (ref / refInitialValue) : null };
    }).filter(p => typeof p.x === 'number' && typeof p.y === 'number');

    if (normPairs.length >= 2) {
      const xn = normPairs.map(p => p.x);
      const yn = normPairs.map(p => p.y);
      const nn = xn.length;
      const sumXn = xn.reduce((a,b)=>a+b,0);
      const sumYn = yn.reduce((a,b)=>a+b,0);
      const sumXYn = xn.reduce((s, xi, i) => s + xi * yn[i], 0);
      const sumXXn = xn.reduce((s, xi) => s + xi * xi, 0);
      const denomN = (nn * sumXXn - sumXn * sumXn);
      slopeNorm = denomN !== 0 ? (nn * sumXYn - sumXn * sumYn) / denomN : NaN;
      const interceptNorm = denomN !== 0 ? (sumYn - slopeNorm * sumXn) / nn : NaN;
      const yPredNorm = xn.map(xi => slopeNorm * xi + interceptNorm);
      const ssTotNorm = yn.reduce((s, yi) => s + Math.pow(yi - (sumYn / nn), 2), 0);
      const ssResNorm = yn.reduce((s, yi, i) => s + Math.pow(yi - yPredNorm[i], 2), 0);
      r2Norm = ssTotNorm !== 0 ? 1 - (ssResNorm / ssTotNorm) : NaN;

      normRegressionTraces.push({
        x: [x0, x1],
        y: [slopeNorm * x0 + interceptNorm, slopeNorm * x1 + interceptNorm],
        mode: 'lines',
        name: `Selection ${selectionCounter} Fit: ${field}/${refField}`,
        line: { dash: 'dot', width: 2, color: mimsFieldColors[field] || 'black' },
        hovertemplate: `<b>Selection ${selectionCounter} — ${field}</b><br>Click to remove<extra></extra>`
      });

    }

    const slopeRawUnit = mimsFieldUnits[field] ? `${mimsFieldUnits[field]}/min` : 'a.u./min';

    regressionResults.push({
      selectionId: selectionCounter, signal: field, unit: mimsFieldUnits[field] || null,
      start_time: x0, start_time_ms: Math.round(x0 * 60 * 1000), end_time: x1, end_time_ms: Math.round(x1 * 60 * 1000),
      slopeRaw, slopeRawUnit, r2Raw, slopeNorm, r2Norm
    });
  });

  // add traces to plots and record indices
  const rawPlot = document.getElementById('raw-plot-div');
  const normPlot = document.getElementById('normalized-plot-div');
  const rawCurrentTraceCount = rawPlot && rawPlot.data ? rawPlot.data.length : 0;
  const normCurrentTraceCount = normPlot && normPlot.data ? normPlot.data.length : 0;

  Plotly.addTraces('raw-plot-div', rawRegressionTraces).then(() => {
    const newRawIndices = Array.from({ length: rawRegressionTraces.length }, (_, i) => rawCurrentTraceCount + i);
    rawTraceIndicesBySelection.set(selectionCounter, newRawIndices);
  }).catch(err => console.error(err));

  Plotly.addTraces('normalized-plot-div', normRegressionTraces).then(() => {
    const newNormIndices = Array.from({ length: normRegressionTraces.length }, (_, i) => normCurrentTraceCount + i);
    normTraceIndicesBySelection.set(selectionCounter, newNormIndices);
  }).catch(err => console.error(err));

  if (photoMode && newRegressionCondition) regressionConditions[selectionCounter] = newRegressionCondition;
  regressionResults.sort((a,b) => a.start_time - b.start_time);
  refreshRegressionTable();
}

// ======================
// 7) Regression table
// ======================
function refreshRegressionTable() {
  const tableDiv = document.getElementById('regression-results-table');
  const downloadDiv = document.getElementById('xlsx-download-section');
  const earlyDownloadDiv = document.getElementById('early-xlsx-download-section');

  if (regressionResults.length === 0) {
    if (tableDiv) tableDiv.innerHTML = '';
    if (downloadDiv) downloadDiv.style.display = 'none';
    if (earlyDownloadDiv && document.getElementById('normalized-container').style.display === 'block') {
      earlyDownloadDiv.style.display = 'block';
    }
    const tabsCont = document.getElementById('results-tabs-container');
    if (tabsCont) tabsCont.style.display = 'none';
    renderCalibrationSection();
    renderNormFactorSection();
    renderSlopeCharts();
    renderPhotoRates();
    renderCalibratedPlots();
    renderRecalcTab();
    return;
  }

  // Swap buttons: hide early download, show summary download
  if (earlyDownloadDiv) earlyDownloadDiv.style.display = 'none';
  if (downloadDiv) downloadDiv.style.display = 'block';

  const grouped = {};
  regressionResults.forEach(r => {
    if (!grouped[r.selectionId]) grouped[r.selectionId] = [];
    grouped[r.selectionId].push(r);
  });
  let selectionIds = Object.keys(grouped).map(Number);

  // Sort selection IDs per current sort settings
  if (regressionSortKey === 'id') {
    selectionIds.sort((a, b) => regressionSortDir === 'asc' ? a - b : b - a);
  } else {
    selectionIds.sort((a, b) => {
      const tA = grouped[a][0].start_time;
      const tB = grouped[b][0].start_time;
      return regressionSortDir === 'asc' ? tA - tB : tB - tA;
    });
  }

  const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || 'HPR40';

  function r2Badge(val) {
    if (typeof val !== 'number' || Number.isNaN(val)) return `<span class="badge badge-secondary">—</span>`;
    const display = val.toFixed(4);
    if (val >= 0.99) return `<span class="badge badge-success">${display}</span>`;
    if (val >= 0.95) return `<span class="badge badge-warning text-dark">${display}</span>`;
    return `<span class="badge badge-danger">${display}</span>`;
  }

  function slopeStr(v) {
    return (typeof v === 'number' && !Number.isNaN(v)) ? v.toExponential(3) : '—';
  }

  // Check if any signal has an active calibration
  const uniqueSignals = [...new Set(regressionResults.map(r => r.signal))];
  const hasCal = uniqueSignals.some(s => mimsCalibrations[s] && mimsCalibrations[s].type !== 'none');

  // Sort toolbar
  const sortDir = regressionSortDir === 'asc' ? '&#9650;' : '&#9660;';
  let html = `
  <div class="d-flex align-items-center mb-2" style="gap:6px; flex-wrap:wrap;">
    <span class="small text-muted font-weight-bold mr-1">Sort:</span>
    <button class="btn btn-sm ${regressionSortKey === 'id' ? 'btn-secondary' : 'btn-outline-secondary'}"
            onclick="setRegressionSort('id')" style="font-size:0.8em; padding:2px 8px;">
      # ${regressionSortKey === 'id' ? sortDir : '&#8597;'}
    </button>
    <button class="btn btn-sm ${regressionSortKey === 'time' ? 'btn-secondary' : 'btn-outline-secondary'}"
            onclick="setRegressionSort('time')" style="font-size:0.8em; padding:2px 8px;">
      Time ${regressionSortKey === 'time' ? sortDir : '&#8597;'}
    </button>
  </div>
  <div id="regression-accordion">`;

  selectionIds.forEach((sel) => {
    const rows = grouped[sel];
    const first = rows[0];
    const startMin = first.start_time.toFixed(2);
    const endMin = first.end_time.toFixed(2);
    const timeExtra = selectedModel === 'HPR40'
      ? ` &nbsp;<small class="text-muted">(${first.start_time_ms} – ${first.end_time_ms} ms)</small>`
      : '';
    const collapseId = `regression-collapse-${sel}`;
    const headingId  = `regression-heading-${sel}`;
    const cond = regressionConditions[sel] || null;
    const condBadge = cond === 'light' ? ` <span class="badge badge-warning ml-1">&#9728; Light</span>`
                    : cond === 'dark'  ? ` <span class="badge badge-secondary ml-1">&#9790; Dark</span>` : '';

    html += `
    <div class="card mb-2 shadow-sm">
      <div class="card-header p-0" id="${headingId}" style="background:#f0f4ff;">
        <div class="d-flex align-items-center">
          <button class="btn btn-link collapsed flex-grow-1 text-left d-flex align-items-center px-3 py-2"
                  type="button"
                  data-toggle="collapse"
                  data-target="#${collapseId}"
                  aria-expanded="false"
                  aria-controls="${collapseId}"
                  style="text-decoration:none; color:inherit;">
            <span class="flex-grow-1">
              <strong>Regression coefficients #${sel}</strong>${condBadge}
              <span class="text-muted ml-2" style="font-size:0.88em;">&#9201; ${startMin} – ${endMin} min${timeExtra}</span>
            </span>
            <span style="font-size:0.8em; margin-right:4px;">&#9660;</span>
          </button>
          ${photoMode ? (() => {
            const cond = regressionConditions[sel] || null;
            return `<div class="btn-group btn-group-sm mr-1" role="group" style="white-space:nowrap;">
              <button type="button" class="btn ${cond === 'light' ? 'btn-warning' : 'btn-outline-secondary'}"
                      style="font-size:0.75em; padding:1px 7px;"
                      onclick="setPhotoCondition(${sel},'light')">&#9728; Light</button>
              <button type="button" class="btn ${cond === 'dark' ? 'btn-secondary' : 'btn-outline-secondary'}"
                      style="font-size:0.75em; padding:1px 7px;"
                      onclick="setPhotoCondition(${sel},'dark')">&#9790; Dark</button>
            </div>`;
          })() : ''}
          <button class="btn btn-sm btn-outline-danger mr-2"
                  style="font-size:0.78em; padding:2px 8px; white-space:nowrap;"
                  onclick="deleteRegression(${sel})" title="Remove regression #${sel}">&#10005; Remove</button>
        </div>
      </div>
      <div id="${collapseId}" class="collapse"
           aria-labelledby="${headingId}">
        <div class="card-body p-0">
          <table class="table table-sm table-hover mb-0" style="font-size:0.88em;">
            <thead class="thead-light">
              <tr>
                <th style="width:20%">Signal</th>
                <th>Slope raw data<br><small>(signal/min)</small></th>
                <th>R² raw</th>
                <th>Slope normalized data<br><small>(signal/min)</small></th>
                <th>R² normalized</th>
                ${hasCal ? '<th>Calibrated rate</th>' : ''}
                ${mimsNormFactor ? `<th>Rate / ${mimsNormFactor.unit}</th>` : ''}
                ${mimsNormFactor && mimsNormFactor.mode === 'multi' ? '<th>Sample</th>' : ''}
              </tr>
            </thead>
            <tbody>`;

    rows.forEach(r => {
      const unit = r.unit ? ` [${r.unit}]` : '';
      let calCell = '';
      if (hasCal) {
        const cal = mimsCalibrations[r.signal];
        if (cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope)) {
          const baseSlope = (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : r.slopeRaw;
          if (typeof baseSlope === 'number' && !isNaN(baseSlope)) {
            const rate = baseSlope * cal.slope;
            const rateUnit = cal.unit || 'r.u.';
            const calNote = cal.type === 'points'
              ? `<small class="text-muted d-block">${cal.nPoints} pts, cal R²=${typeof cal.calR2 === 'number' ? cal.calR2.toFixed(3) : '?'}</small>`
              : `<small class="text-muted d-block">manual</small>`;
            calCell = `<td><code>${rate.toExponential(3)} ${rateUnit}/min</code>${calNote}</td>`;
          } else {
            calCell = `<td><span class="badge badge-secondary">—</span></td>`;
          }
        } else {
          calCell = `<td><span class="text-muted small">no cal.</span></td>`;
        }
      }
      const rc = recalcRate(r);
      const rcCell = mimsNormFactor
        ? `<td>${rc ? `<code>${rc.value.toExponential(3)}</code><small class="text-muted d-block">${rc.unit}</small>` : '<span class="badge badge-secondary">—</span>'}</td>`
        : '';
      const sampleCell = (mimsNormFactor && mimsNormFactor.mode === 'multi')
        ? `<td><small>${rc && rc.sampleName ? rc.sampleName : '<span class="text-muted">—</span>'}</small></td>`
        : '';
      html += `
              <tr>
                <td><code>${r.signal}${unit}</code></td>
                <td><code>${slopeStr(r.slopeRaw)}</code></td>
                <td>${r2Badge(r.r2Raw)}</td>
                <td><code>${slopeStr(r.slopeNorm)}</code></td>
                <td>${r2Badge(r.r2Norm)}</td>
                ${calCell}
                ${rcCell}
                ${sampleCell}
              </tr>`;
    });

    html += `
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  });

  html += `</div>`;

  if (tableDiv) tableDiv.innerHTML = html;
  const tabsCont = document.getElementById('results-tabs-container');
  if (tabsCont) tabsCont.style.display = 'block';
  renderCalibrationSection();
  renderNormFactorSection();
  renderSlopeCharts();
  renderPhotoRates();
  renderCalibratedPlots();
  renderRecalcTab();
}

// ======================
// 8) Clear all regression traces from plots (name-based, robust to index shifts)
// ======================
function clearRegressionTracesFromPlots() {
  ['raw-plot-div', 'normalized-plot-div'].forEach(divId => {
    const el = document.getElementById(divId);
    if (!el || !el.data) return;
    const toRemove = [];
    el.data.forEach((t, i) => {
      if (t.name && /^Selection \d+ Fit:/.test(t.name)) toRemove.push(i);
    });
    if (toRemove.length) {
      try { Plotly.deleteTraces(divId, toRemove.sort((a, b) => b - a)); } catch(e){ console.error(e); }
    }
  });
  rawTraceIndicesBySelection.clear();
  normTraceIndicesBySelection.clear();
}

// Delete a single regression by ID (name-based trace lookup)
function deleteRegression(selectionId) {
  ['raw-plot-div', 'normalized-plot-div'].forEach(divId => {
    const el = document.getElementById(divId);
    if (!el || !el.data) return;
    const toRemove = [];
    el.data.forEach((t, i) => {
      if (t.name && t.name.startsWith(`Selection ${selectionId} Fit:`)) toRemove.push(i);
    });
    if (toRemove.length) {
      try { Plotly.deleteTraces(divId, toRemove.sort((a, b) => b - a)); } catch(e){ console.error(e); }
    }
  });
  regressionResults = regressionResults.filter(r => r.selectionId !== selectionId);
  rawTraceIndicesBySelection.delete(selectionId);
  normTraceIndicesBySelection.delete(selectionId);
  refreshRegressionTable();
}

// Toggle sort key / direction for the regression accordion
function setRegressionSort(key) {
  if (regressionSortKey === key) {
    regressionSortDir = regressionSortDir === 'asc' ? 'desc' : 'asc';
  } else {
    regressionSortKey = key;
    regressionSortDir = 'asc';
  }
  refreshRegressionTable();
}

// ======================
// 9) XLSX export (with chart images via ExcelJS)
// ======================
document.getElementById('download-xlsx').addEventListener('click', async function() {
  if (!mimsRawData.length) { alert('No data available for export.'); return; }

  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Exporting…';

  try {
    const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || 'HPR40';
    const refField = document.getElementById('normalize-by-select').value;
    const baseName = selectedFile ? selectedFile.name.replace(/\.[^/.]+$/, '') : 'MIMS_Analysis';

    // --- Build data arrays (same logic as before) ---
    const tpValue = parseFloat(document.getElementById('norm-timepoint').value);
    let refRowIndex = 0, bestDiff = Infinity;
    mimsRawData.forEach((row, i) => {
      const diff = Math.abs((row[mimsXField] || 0) - tpValue);
      if (diff < bestDiff) { bestDiff = diff; refRowIndex = i; }
    });
    const refInitialValue = mimsRawData[refRowIndex][refField];

    const dataRows = mimsRawData.map(row => {
      const out = {};
      if (selectedModel === 'HPR40') out['Time (ms)'] = row['ms'];
      else out['Time (s)'] = row['Time'];
      out['Time (min)'] = row['min'] !== undefined && row['min'] !== null ? parseFloat(row['min'].toFixed(2)) : null;
      mimsYFields.forEach(field => {
        const unit = mimsFieldUnits[field] || '';
        out[unit ? `${field} [${unit}]` : field] = row[field];
      });
      mimsYFields.forEach(field => {
        const val = row[field]; const refVal = row[refField];
        if (typeof val === 'number' && typeof refVal === 'number' && refVal !== 0)
          out[`${field}/${refField}_normalized`] = val / (refVal / refInitialValue);
      });
      return out;
    });

    const regressionRows = regressionResults.map(r => {
      const row = { 'Selection #': r.selectionId };
      if (selectedModel.includes('HPR40')) { row['Start Time (ms)'] = r.start_time_ms; row['End Time (ms)'] = r.end_time_ms; }
      else { row['Start Time (s)'] = r.start_time; row['End Time (s)'] = r.end_time; }
      row['Start Time (min)'] = typeof r.start_time === 'number' ? parseFloat(r.start_time.toFixed(2)) : '';
      row['End Time (min)']   = typeof r.end_time   === 'number' ? parseFloat(r.end_time.toFixed(2))   : '';
      row['Signal'] = r.signal;
      if (photoMode) row['Condition'] = regressionConditions[r.selectionId] || '';
      row['Slope Raw (per min)']        = typeof r.slopeRaw  === 'number' && !isNaN(r.slopeRaw)  ? r.slopeRaw  : null;
      row['Slope Normalized (per min)'] = typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm) ? r.slopeNorm : null;
      row['R2 Raw']        = typeof r.r2Raw  === 'number' && !isNaN(r.r2Raw)  ? r.r2Raw  : null;
      row['R2 Normalized'] = typeof r.r2Norm === 'number' && !isNaN(r.r2Norm) ? r.r2Norm : null;
      const cal = mimsCalibrations[r.signal];
      if (cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope)) {
        const baseSlope = typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm) ? r.slopeNorm : r.slopeRaw;
        if (typeof baseSlope === 'number' && !isNaN(baseSlope)) {
          row[`Calibrated Rate (${cal.unit || 'r.u.'}/min)`] = baseSlope * cal.slope;
          if (cal.type === 'points') row['Calibration R2'] = typeof cal.calR2 === 'number' ? cal.calR2 : null;
          if (mimsNormFactor) row[`Calibrated Rate / ${mimsNormFactor.unit} / min`] = (baseSlope * cal.slope) / mimsNormFactor.value;
        }
      } else if (mimsNormFactor) {
        const baseSlope = typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm) ? r.slopeNorm : r.slopeRaw;
        if (typeof baseSlope === 'number' && !isNaN(baseSlope))
          row[`Rate / ${mimsNormFactor.unit} / min`] = baseSlope / mimsNormFactor.value;
      }
      return row;
    });

    const calEntries = Object.entries(mimsCalibrations).filter(([, c]) => c && c.type !== 'none');
    const calRows = [];
    calEntries.forEach(([signal, cal]) => {
      const base = {
        'Signal': signal,
        'Calibration Type': cal.type === 'manual' ? 'Manual (slope/intercept)' : 'Multi-point linear fit',
        'Target Unit': cal.unit || '',
        'Slope (unit / signal/min)': typeof cal.slope === 'number' ? cal.slope : null,
        'Intercept': typeof cal.intercept === 'number' ? cal.intercept : null,
      };
      if (cal.type === 'points') { base['N Points'] = cal.nPoints || null; base['Calibration R2'] = typeof cal.calR2 === 'number' ? cal.calR2 : null; }
      calRows.push(base);
      if (cal.type === 'points' && Array.isArray(cal.points) && cal.points.length > 0) {
        calRows.push({ 'Signal': '', 'Calibration Type': '--- Points used ---', 'Target Unit': 'Signal value', 'Slope (unit / signal/min)': cal.unit || 'Concentration' });
        cal.points.forEach(([x, y]) => calRows.push({ 'Signal': '', 'Calibration Type': '', 'Target Unit': '', 'Slope (unit / signal/min)': x, 'Intercept': y }));
      }
    });

    // --- Ensure all chart sections are rendered before capture ---
    renderSlopeCharts();
    renderPhotoRatePlots();
    renderCalibratedPlots();
    renderRecalcTab();
    // Wait for two animation frames so requestAnimationFrame inside each render completes
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // --- Collect chart images: one combined image per section ---
    const CHART_W = 900, CHART_H = 420, COLS = 2;

    // Stitch an array of base64 PNGs into one grid image.
    // Uses explicit drawImage(img, x, y, w, h) so each chart occupies exactly
    // CHART_W × CHART_H regardless of the PNG's native pixel dimensions.
    const stitchImages = async (base64Array) => {
      if (!base64Array.length) return null;
      const cols = Math.min(COLS, base64Array.length);
      const rowCount = Math.ceil(base64Array.length / cols);
      const canvas = document.createElement('canvas');
      canvas.width  = CHART_W * cols;
      canvas.height = CHART_H * rowCount;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < base64Array.length; i++) {
        const img = new Image();
        await new Promise(resolve => { img.onload = resolve; img.src = 'data:image/png;base64,' + base64Array[i]; });
        const cx = (i % cols) * CHART_W;
        const cy = Math.floor(i / cols) * CHART_H;
        ctx.drawImage(img, cx, cy, CHART_W, CHART_H);  // explicit target size prevents overflow
      }
      return canvas.toDataURL('image/png').split(',')[1];
    };

    const chartSections = [
      { id: 'slope-charts-section',      sheetName: 'Slope plots' },
      { id: 'photo-rates-plots-section', sheetName: 'Photo rate plots' },
      { id: 'calibrated-plots-section',  sheetName: 'Calibrated plots' },
      { id: 'recalc-section',            sheetName: 'Recalculated plots' }
    ];
    const chartImages = []; // [{sheetName, base64, totalW, totalH}]
    for (const { id, sheetName } of chartSections) {
      const sec = document.getElementById(id);
      if (!sec) continue;
      const plots = sec.querySelectorAll('.js-plotly-plot');
      if (!plots.length) continue;
      const pngList = [];
      for (const plotDiv of plots) {
        try {
          // scale:1 → PNG is exactly CHART_W×CHART_H px; no mismatch when drawing on canvas
          const png = await Plotly.toImage(plotDiv, { format: 'png', width: CHART_W, height: CHART_H, scale: 1 });
          pngList.push(png.split(',')[1]);
        } catch(e) { /* skip if toImage fails */ }
      }
      if (!pngList.length) continue;
      const combined = await stitchImages(pngList);
      if (combined) {
        const cols = Math.min(COLS, pngList.length);
        const rowCount = Math.ceil(pngList.length / cols);
        chartImages.push({ sheetName, base64: combined, totalW: CHART_W * cols, totalH: CHART_H * rowCount });
      }
    }

    // --- Build ExcelJS workbook ---
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'MIMS App';
    workbook.created = new Date();

    const sanitizeCell = v => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' && (!isFinite(v) || isNaN(v))) return null;
      return v;
    };

    const addDataSheet = (name, rows) => {
      if (!rows.length) return;
      const ws = workbook.addWorksheet(name);
      // Collect all unique headers from ALL rows (not just row[0]) to catch
      // calibrated columns that may only appear in some rows
      const headerSet = new Set();
      rows.forEach(r => Object.keys(r).forEach(k => headerSet.add(k)));
      const headers = [...headerSet];
      ws.addRow(headers).font = { bold: true };
      rows.forEach(r => ws.addRow(headers.map(h => sanitizeCell(r[h]))));
      ws.columns.forEach((col, i) => {
        const maxLen = Math.min(40, Math.max(headers[i].length, ...rows.map(r => String(r[headers[i]] ?? '').length)));
        col.width = maxLen + 2;
      });
    };

    addDataSheet('Data', dataRows);
    addDataSheet('Regression Table', regressionRows);
    if (calRows.length) addDataSheet('Calibration', calRows);

    // Photosynthesis rates sheet (if any light regressions exist)
    const photoLights = regressionResults.filter(r => regressionConditions[r.selectionId] === 'light');
    if (photoLights.length > 0) {
      const photoDarks = regressionResults.filter(r => regressionConditions[r.selectionId] === 'dark');
      const photoRows = [];
      const uniqueSigsPhoto = [...new Set(photoLights.map(r => r.signal))];
      uniqueSigsPhoto.forEach(signal => {
        const sigLights = photoLights.filter(r => r.signal === signal);
        const sigDarks  = photoDarks.filter(r => r.signal === signal);
        const cal = mimsCalibrations[signal];
        const hasCal = cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
        const baseSlope = r => (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : r.slopeRaw;

        sigLights.forEach(light => {
          const lMid = (light.start_time + light.end_time) / 2;
          const paired = sigDarks.length > 0 ? sigDarks.reduce((best, d) =>
            Math.abs((d.start_time + d.end_time) / 2 - lMid) < Math.abs((best.start_time + best.end_time) / 2 - lMid) ? d : best) : null;
          const ls = baseSlope(light);
          const ds = paired ? baseSlope(paired) : null;
          const net   = ls;
          const resp  = ds != null ? ds : null;
          const gross = ds != null ? ls - ds : null;
          const row = {
            'Signal': signal,
            'Light #': light.selectionId,
            'Light start (min)': parseFloat(light.start_time.toFixed(2)),
            'Light end (min)':   parseFloat(light.end_time.toFixed(2)),
            'Dark #': paired ? paired.selectionId : '',
            'Net slope (r.u./min)':   typeof net   === 'number' ? net   : null,
            'Resp. slope (r.u./min)': typeof resp  === 'number' ? resp  : null,
            'Gross slope (r.u./min)': typeof gross === 'number' ? gross : null,
          };
          if (hasCal) {
            const u = cal.unit || 'r.u.';
            row[`Net (${u}/min)`]   = typeof net   === 'number' ? net   * cal.slope : null;
            row[`Resp. (${u}/min)`] = typeof resp  === 'number' ? resp  * cal.slope : null;
            row[`Gross (${u}/min)`] = typeof gross === 'number' ? gross * cal.slope : null;
          }
          if (mimsNormFactor) {
            const nfu = mimsNormFactor.unit;
            const toRC = (v, s) => (typeof v === 'number' && !isNaN(v)) ? (hasCal ? v * s : v) / mimsNormFactor.value : null;
            const s = hasCal ? cal.slope : 1;
            row[`Net / ${nfu} / min`]   = toRC(net,   s);
            row[`Resp. / ${nfu} / min`] = toRC(resp,  s);
            row[`Gross / ${nfu} / min`] = toRC(gross, s);
          }
          photoRows.push(row);
        });
      });
      if (photoRows.length > 0) addDataSheet('Photosynthesis Rates', photoRows);
    }

    // Recalculated rates sheet (if normalization factor is active)
    if (mimsNormFactor) {
      const isMultiNorm = mimsNormFactor.mode === 'multi';

      // Per-regression recalculated slopes
      const recalcSlopeRows = regressionResults.map(r => {
        const rc   = recalcRate(r);
        const cond = regressionConditions[r.selectionId] || '';
        const row  = {
          'Signal':      r.signal,
          'Selection #': r.selectionId,
          'Start (min)': parseFloat(r.start_time.toFixed(2)),
          'End (min)':   parseFloat(r.end_time.toFixed(2)),
          'Condition':   cond,
        };
        if (isMultiNorm) row['Sample'] = rc ? (rc.sampleName || '') : '';
        row['Recalc. rate'] = sanitizeCell(rc ? rc.value : null);
        row['Unit']         = rc ? rc.unit : '';
        return row;
      });
      addDataSheet('Recalculated Slopes', recalcSlopeRows);

      // Recalculated photosynthesis rates (calibrated signals only, if photoMode)
      if (photoMode) {
        const rcLights = regressionResults.filter(r => regressionConditions[r.selectionId] === 'light');
        const rcDarks  = regressionResults.filter(r => regressionConditions[r.selectionId] === 'dark');
        const rcPhotoRows = [];
        [...new Set(rcLights.map(r => r.signal))].forEach(signal => {
          const cal = mimsCalibrations[signal];
          const hasCal = cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
          if (!hasCal) return; // recalculated photo rates only meaningful for calibrated signals
          rcLights.filter(r => r.signal === signal).forEach(light => {
            const lMid   = (light.start_time + light.end_time) / 2;
            const paired = rcDarks.filter(r => r.signal === signal).length > 0
              ? rcDarks.filter(r => r.signal === signal).reduce((best, d) =>
                  Math.abs((d.start_time + d.end_time) / 2 - lMid) <
                  Math.abs((best.start_time + best.end_time) / 2 - lMid) ? d : best)
              : null;
            const rcLight = recalcRate(light);
            const rcDark  = paired ? recalcRate(paired) : null;
            const net     = rcLight ? rcLight.value : null;
            const resp    = rcDark  ? rcDark.value  : null;
            const gross   = (net != null && resp != null) ? net - resp : null;
            const unit    = rcLight ? rcLight.unit : (rcDark ? rcDark.unit : '');
            const row = {
              'Signal':            signal,
              'Light #':           light.selectionId,
              'Light start (min)': parseFloat(light.start_time.toFixed(2)),
              'Light end (min)':   parseFloat(light.end_time.toFixed(2)),
              'Dark #':            paired ? paired.selectionId : '',
            };
            if (isMultiNorm) row['Sample'] = rcLight ? (rcLight.sampleName || '') : '';
            row['Net rate']   = sanitizeCell(net);
            row['Resp. rate'] = sanitizeCell(resp);
            row['Gross rate'] = sanitizeCell(gross);
            row['Unit']       = unit;
            rcPhotoRows.push(row);
          });
        });
        if (rcPhotoRows.length > 0) addDataSheet('Recalculated Photo Rates', rcPhotoRows);
      }
    }

    // Add chart image sheets (one combined image per section)
    // Use tl+br two-cell anchor (more reliable than ext in ExcelJS)
    // Excel default column width ≈ 72px, default row height ≈ 20px
    const COL_PX = 72, ROW_PX = 20;
    for (const { sheetName, base64, totalW, totalH } of chartImages) {
      const ws = workbook.addWorksheet(sheetName);
      const imageId = workbook.addImage({ base64, extension: 'png' });
      const brCol = Math.ceil(totalW / COL_PX) + 1;
      const brRow = Math.ceil(totalH / ROW_PX) + 1;
      ws.addImage(imageId, { tl: { col: 0, row: 0 }, br: { col: brCol, row: brRow } });
    }

    // Write and download
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${baseName}_analyzed.xlsx`; a.click();
    URL.revokeObjectURL(url);

  } catch (err) {
    console.error('XLSX export error:', err);
    alert('Export failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Download summary .XLSX file';
  }
});

// ======================
// 9b) Early data-only XLSX export (no regression sheet)
// ======================
document.getElementById('download-early-xlsx').addEventListener('click', function() {
  if (!mimsRawData.length) { alert('No data available for export.'); return; }
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: 'MIMS Data Export', Author: 'MIMS App', CreatedDate: new Date() };
  const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || 'HPR40';
  const refField = document.getElementById('normalize-by-select').value;
  const tpValue = parseFloat(document.getElementById('norm-timepoint').value);

  let refRowIndex = 0, bestDiff = Infinity;
  mimsRawData.forEach((row, i) => {
    const diff = Math.abs((row[mimsXField] || 0) - tpValue);
    if (diff < bestDiff) { bestDiff = diff; refRowIndex = i; }
  });
  const refInitialValue = mimsRawData[refRowIndex][refField];

  const dataSheet = mimsRawData.map(row => {
    const out = {};
    if (selectedModel === 'HPR40') out['Time (ms)'] = row['ms'];
    else out['Time (s)'] = row['Time'];
    out['Time (min)'] = row['min'] !== undefined && row['min'] !== null ? row['min'].toFixed(2) : null;
    mimsYFields.forEach(field => {
      const unit = mimsFieldUnits[field] || '';
      out[unit ? `${field} [${unit}]` : field] = row[field];
    });
    mimsYFields.forEach(field => {
      const val = row[field]; const refVal = row[refField];
      if (typeof val === 'number' && typeof refVal === 'number' && refVal !== 0)
        out[`${field}/${refField}_normalized`] = val / (refVal / refInitialValue);
    });
    return out;
  });

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dataSheet), 'Data');
  const baseName = selectedFile ? selectedFile.name.replace(/\.[^/.]+$/, '') : 'MIMS_Data';
  XLSX.writeFile(wb, `${baseName}_data.xlsx`);
});
// ======================
// 10) Photosynthesis rate calculation
// ======================
function togglePhotoMode() {
  photoMode = !photoMode;
  if (!photoMode) { newRegressionCondition = null; regressionConditions = {}; }
  const btn = document.getElementById('photo-mode-btn');
  if (btn) {
    btn.classList.toggle('btn-success', photoMode);
    btn.classList.toggle('btn-outline-success', !photoMode);
    btn.textContent = photoMode ? '🌿 Photosynthesis mode ON' : '🌿 Photosynthesis rates';
  }
  // Show/hide photo tabs
  ['tab-photo-li', 'tab-photoplot-li'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = photoMode ? 'block' : 'none';
  });
  // If turning off and a photo tab is active, switch to slope-plots tab
  if (!photoMode) {
    const activeLink = document.querySelector('#resultsTabs .nav-link.active');
    if (activeLink && (activeLink.getAttribute('href') === '#tab-photo' || activeLink.getAttribute('href') === '#tab-photo-plots')) {
      const slopeLink = document.querySelector('a[href="#tab-slope-plots"]');
      if (slopeLink) $(slopeLink).tab('show');
    }
  }
  // Show/hide pre-select group
  const preselectGroup = document.getElementById('photo-preselect-group');
  if (preselectGroup) preselectGroup.style.display = photoMode ? 'flex' : 'none';
  if (photoMode) setNewRegCond('light'); else refreshRegressionTable();
}

function setNewRegCond(cond) {
  newRegressionCondition = cond;
  ['preselect-none-btn', 'preselect-light-btn', 'preselect-dark-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('btn-secondary', 'btn-warning', 'btn-outline-secondary', 'btn-outline-warning'); }
  });
  const noneBtn  = document.getElementById('preselect-none-btn');
  const lightBtn = document.getElementById('preselect-light-btn');
  const darkBtn  = document.getElementById('preselect-dark-btn');
  if (cond === 'light') {
    if (lightBtn) lightBtn.classList.add('btn-warning');
    if (noneBtn)  noneBtn.classList.add('btn-outline-secondary');
    if (darkBtn)  darkBtn.classList.add('btn-outline-secondary');
  } else if (cond === 'dark') {
    if (darkBtn)  darkBtn.classList.add('btn-secondary');
    if (noneBtn)  noneBtn.classList.add('btn-outline-secondary');
    if (lightBtn) lightBtn.classList.add('btn-outline-warning');
  } else {
    if (noneBtn)  noneBtn.classList.add('btn-secondary');
    if (lightBtn) lightBtn.classList.add('btn-outline-warning');
    if (darkBtn)  darkBtn.classList.add('btn-outline-secondary');
  }
  refreshRegressionTable();
}

function setPhotoCondition(selectionId, condition) {
  // Toggle off if already selected
  regressionConditions[selectionId] = (regressionConditions[selectionId] === condition) ? null : condition;
  refreshRegressionTable();
}

function renderPhotoRates() {
  const section = document.getElementById('photo-rates-section');
  if (!section) return;

  if (!photoMode || regressionResults.length === 0) {
    section.innerHTML = '';
    return;
  }

  const uniqueSignals = [...new Set(regressionResults.map(r => r.signal))];
  const lights = regressionResults.filter(r => regressionConditions[r.selectionId] === 'light');
  const darks  = regressionResults.filter(r => regressionConditions[r.selectionId] === 'dark');

  if (lights.length === 0 && darks.length === 0) {
    section.innerHTML = '';
    return;
  }

  // For each signal, pair each light with the nearest dark by midpoint time
  const rows = [];
  uniqueSignals.forEach(signal => {
    const sigLights = lights.filter(r => r.signal === signal);
    const sigDarks  = darks.filter(r => r.signal === signal);

    sigLights.forEach(light => {
      const lMid = (light.start_time + light.end_time) / 2;
      // Find nearest dark
      let paired = null;
      if (sigDarks.length > 0) {
        paired = sigDarks.reduce((best, d) => {
          const dMid = (d.start_time + d.end_time) / 2;
          const bestMid = (best.start_time + best.end_time) / 2;
          return Math.abs(dMid - lMid) < Math.abs(bestMid - lMid) ? d : best;
        });
      }

      const base = (s) => (typeof s.slopeNorm === 'number' && !isNaN(s.slopeNorm)) ? s.slopeNorm : s.slopeRaw;
      const lightSlope = base(light);
      const darkSlope  = paired ? base(paired) : null;

      // Net = light slope; Resp = dark slope; Gross = light − dark
      const net   = lightSlope;
      const resp  = darkSlope != null ? darkSlope : null;
      const gross = darkSlope != null ? lightSlope - darkSlope : null;

      // Calibrated equivalents
      const cal = mimsCalibrations[signal];
      const hasCal = cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
      const toReal = v => (hasCal && v != null) ? v * cal.slope : null;

      rows.push({ signal, light, paired,
        net, resp, gross,
        netCal: toReal(net), respCal: toReal(resp), grossCal: toReal(gross),
        unit: hasCal ? (cal.unit || 'r.u.') : null });
    });

    // Dark-only entries (no matching light) — show respiration alone
    if (sigLights.length === 0) {
      sigDarks.forEach(dark => {
        const darkSlope = (typeof dark.slopeNorm === 'number' && !isNaN(dark.slopeNorm)) ? dark.slopeNorm : dark.slopeRaw;
        const resp = darkSlope;
        const cal = mimsCalibrations[signal];
        const hasCal = cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
        const toReal = v => (hasCal && v != null) ? v * cal.slope : null;
        rows.push({ signal, light: null, paired: dark,
          net: null, resp, gross: null,
          netCal: null, respCal: toReal(resp), grossCal: null,
          unit: hasCal ? (cal.unit || 'r.u.') : null });
      });
    }
  });

  if (rows.length === 0) {
    section.innerHTML = '';
    return;
  }

  const hasAnyCal = rows.some(r => r.unit != null);
  const hasNorm   = mimsNormFactor != null;
  const nfUnit    = hasNorm ? mimsNormFactor.unit : '';
  const fmtSlope  = v => (v != null && typeof v === 'number' && !isNaN(v)) ? v.toExponential(3) : '—';

  // Compute recalculated photo rates for a row (uses getSampleForRegression for multi)
  const photoRecalc = (r, netVal, respVal, grossVal) => {
    if (!hasNorm) return null;
    const sample = getSampleForRegression(r.light || r.paired);
    if (!sample) return null;
    const cal = mimsCalibrations[r.signal];
    const hasCal = cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
    const toRC = v => (v != null && typeof v === 'number' && !isNaN(v))
      ? ((hasCal ? v * cal.slope : v) / sample.value)
      : null;
    const rcUnit = hasCal ? `${cal.unit || 'r.u.'} / ${nfUnit} / min` : `r.u. / ${nfUnit} / min`;
    return { net: toRC(netVal), resp: toRC(respVal), gross: toRC(grossVal), unit: rcUnit, sampleName: sample.name };
  };

  let html = `
  <p class="text-muted small mb-2">
    <strong>Net rate</strong> = light slope &nbsp;|&nbsp;
    <strong>Respiration</strong> = dark slope &nbsp;|&nbsp;
    <strong>Gross rate</strong> = light slope &minus; dark slope<br>
    Dark regression paired with nearest light regression (by time). All slopes from normalized signal.
  </p>
  <div class="table-responsive">
  <table class="table table-sm table-bordered" style="font-size:0.85em;">
    <thead class="thead-light">
      <tr>
        <th>Signal</th>
        <th>Light #</th><th>Light window (min)</th>
        <th>Dark #</th><th>Dark window (min)</th>
        <th>Net (r.u./min)</th>
        <th>Respiration (r.u./min)</th>
        <th>Gross (r.u./min)</th>
        ${hasAnyCal ? '<th>Net (cal.)</th><th>Resp. (cal.)</th><th>Gross (cal.)</th>' : ''}
        ${hasNorm ? `<th>Net / ${nfUnit}</th><th>Resp. / ${nfUnit}</th><th>Gross / ${nfUnit}</th>` : ''}
        ${hasNorm && mimsNormFactor.mode === 'multi' ? '<th>Sample</th>' : ''}
      </tr>
    </thead>
    <tbody>`;

  rows.forEach(r => {
    const lWin  = r.light  ? `${r.light.start_time.toFixed(2)}–${r.light.end_time.toFixed(2)}`   : '—';
    const dWin  = r.paired ? `${r.paired.start_time.toFixed(2)}–${r.paired.end_time.toFixed(2)}` : '—';
    const lId   = r.light  ? `#${r.light.selectionId}`   : '—';
    const dId   = r.paired ? `#${r.paired.selectionId}`  : '—';
    const calUnit = r.unit || '—';
    const rc = photoRecalc(r, r.net, r.resp, r.gross);
    html += `
      <tr>
        <td><strong>${r.signal}</strong></td>
        <td>${lId}</td><td>${lWin}</td>
        <td>${dId}</td><td>${dWin}</td>
        <td>${fmtSlope(r.net)}</td>
        <td>${fmtSlope(r.resp)}</td>
        <td>${fmtSlope(r.gross)}</td>
        ${hasAnyCal ? `<td>${fmtSlope(r.netCal)} ${r.unit ? calUnit+'/min' : ''}</td><td>${fmtSlope(r.respCal)} ${r.unit ? calUnit+'/min' : ''}</td><td>${fmtSlope(r.grossCal)} ${r.unit ? calUnit+'/min' : ''}</td>` : ''}
        ${hasNorm ? `<td>${fmtSlope(rc && rc.net)}</td><td>${fmtSlope(rc && rc.resp)}</td><td>${fmtSlope(rc && rc.gross)}</td>` : ''}
        ${hasNorm && mimsNormFactor.mode === 'multi' ? `<td><small>${rc && rc.sampleName ? rc.sampleName : '<span class="text-muted">—</span>'}</small></td>` : ''}
      </tr>`;
  });

  html += `
    </tbody>
  </table>
  </div>`;

  section.innerHTML = html;
  renderPhotoRatePlots();
}

// ======================
// 11) Photosynthesis rate scatter plots (Net, Respiration, Gross per signal)
// ======================
function renderPhotoRatePlots() {
  const section = document.getElementById('photo-rates-plots-section');
  if (!section) return;

  const lights = regressionResults.filter(r => regressionConditions[r.selectionId] === 'light');
  const uniqueSignals = [...new Set(lights.map(r => r.signal))];

  if (!photoMode || lights.length === 0) {
    section.innerHTML = '';
    // hide tab
    const li = document.getElementById('tab-photoplot-li');
    if (li) li.style.display = 'none';
    return;
  }

  // Show photo-plot tab
  const li = document.getElementById('tab-photoplot-li');
  if (li) li.style.display = 'block';

  const COLOR_NET  = '#1f77b4';  // blue
  const COLOR_RESP = '#d62728';  // red
  const COLOR_GROSS= '#2ca02c';  // green

  let html = `<div style="display:flex; flex-wrap:wrap; gap:12px;">`;
  uniqueSignals.forEach(signal => {
    const safeId = `photo-rate-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
    html += `
    <div style="flex:0 0 calc(47% - 6px); min-width:300px;
                border:1px solid #dee2e6; border-radius:6px;
                background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.07); overflow:hidden;">
      <div id="${safeId}" style="height:320px;"></div>
    </div>`;
  });
  html += `</div>`;
  section.innerHTML = html;

  requestAnimationFrame(() => {
    uniqueSignals.forEach(signal => {
      const safeId = `photo-rate-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const sigLights = lights.filter(r => r.signal === signal);
      const sigDarks  = regressionResults.filter(r => regressionConditions[r.selectionId] === 'dark' && r.signal === signal);

      const base = r => (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : r.slopeRaw;
      const cal = mimsCalibrations[signal];
      const hasCal = cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
      const toReal = v => (hasCal && v != null) ? v * cal.slope : v;
      const yUnit = hasCal ? `${cal.unit || 'r.u.'}/min` : 'r.u./min';

      const xVals = [], netY = [], respY = [], grossY = [], hoverNet = [], hoverResp = [], hoverGross = [];

      sigLights.forEach(light => {
        const lMid = (light.start_time + light.end_time) / 2;
        const paired = sigDarks.length > 0 ? sigDarks.reduce((best, d) => {
          return Math.abs((d.start_time + d.end_time) / 2 - lMid) < Math.abs((best.start_time + best.end_time) / 2 - lMid) ? d : best;
        }) : null;

        const lightSlope = base(light);
        const darkSlope  = paired ? base(paired) : null;
        const net   = toReal(lightSlope);
        const resp  = darkSlope != null ? toReal(darkSlope) : null;
        const gross = darkSlope != null ? toReal(lightSlope - darkSlope) : null;
        const lbl = `#${light.selectionId}: ${light.start_time.toFixed(1)}–${light.end_time.toFixed(1)} min`;
        const dlbl = paired ? `paired with dark #${paired.selectionId}` : 'no dark paired';

        xVals.push(lMid);
        netY.push(net);   respY.push(resp);   grossY.push(gross);
        hoverNet.push(`<b>${lbl}</b><br>Net: ${net != null ? net.toExponential(3) : '—'} ${yUnit}<br>${dlbl}`);
        hoverResp.push(`<b>${lbl}</b><br>Respiration: ${resp != null ? resp.toExponential(3) : '—'} ${yUnit}<br>${dlbl}`);
        hoverGross.push(`<b>${lbl}</b><br>Gross: ${gross != null ? gross.toExponential(3) : '—'} ${yUnit}<br>${dlbl}`);
      });

      const mkTrace = (name, y, hover, color, symbol) => ({
        x: xVals, y, text: hover, mode: 'markers', type: 'scatter', name, hoverinfo: 'text',
        marker: { size: 12, color, symbol, line: { width: 2.5, color } }
      });

      const traces = [
        mkTrace('Net', netY, hoverNet, COLOR_NET, 'circle-open'),
        mkTrace('Respiration', respY, hoverResp, COLOR_RESP, 'square-open'),
        mkTrace('Gross', grossY, hoverGross, COLOR_GROSS, 'diamond-open')
      ];

      Plotly.newPlot(safeId, traces, {
        title: { text: signal, font: { size: 15, color: '#2c3e50' }, x: 0.5 },
        paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
        xaxis: { title: { text: 'Light midpoint time (min)', standoff: 10 }, zeroline: false, showgrid: true, gridcolor: '#e9ecef' },
        yaxis: { title: { text: yUnit, standoff: 8 }, tickformat: '.1e', zeroline: true, zerolinecolor: '#ccc' },
        margin: { t: 40, b: 70, l: 85, r: 20 },
        hovermode: 'closest',
        legend: { orientation: 'h', y: -0.32, x: 0.5, xanchor: 'center', font: { size: 10 } }
      }, { responsive: true, displayModeBar: false });
    });
  });
}

// ======================
// 12b) Calibrated plots tab — one chart per calibrated signal
// ======================
function renderCalibratedPlots() {
  const section = document.getElementById('calibrated-plots-section');
  const tabLi   = document.getElementById('tab-calplot-li');
  if (!section) return;

  const calibratedSignals = regressionResults.length
    ? [...new Set(regressionResults.map(r => r.signal))].filter(sig => {
        const cal = mimsCalibrations[sig];
        return cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
      })
    : [];

  if (calibratedSignals.length === 0) {
    section.innerHTML = '';
    if (tabLi) tabLi.style.display = 'none';
    return;
  }
  if (tabLi) tabLi.style.display = 'block';

  const COLOR_CAL  = '#2ca02c';
  const COLOR_NET  = '#1f77b4';
  const COLOR_RESP = '#d62728';
  const COLOR_GROSS= '#2ca02c';

  let html = `<div style="display:flex; flex-wrap:wrap; gap:12px;">`;
  calibratedSignals.forEach(signal => {
    const safeId = `cal-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
    html += `
    <div style="flex:0 0 calc(47% - 6px); min-width:300px;
                border:1px solid #dee2e6; border-radius:6px;
                background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.07); overflow:hidden;">
      <div id="${safeId}" style="height:320px;"></div>
    </div>`;
    if (photoMode) {
      const safePhId = `cal-photo-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
      html += `
    <div style="flex:0 0 calc(47% - 6px); min-width:300px;
                border:1px solid #dee2e6; border-radius:6px;
                background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.07); overflow:hidden;">
      <div id="${safePhId}" style="height:320px;"></div>
    </div>`;
    }
  });
  html += `</div>`;
  section.innerHTML = html;

  requestAnimationFrame(() => {
    calibratedSignals.forEach(signal => {
      const cal    = mimsCalibrations[signal];
      const safeId = `cal-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const pts    = regressionResults.filter(r => r.signal === signal);
      const x      = pts.map(r => +((r.start_time + r.end_time) / 2).toFixed(3));
      const label  = pts.map(r => `#${r.selectionId}: ${r.start_time.toFixed(1)}–${r.end_time.toFixed(1)} min`);
      const base   = r => (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : r.slopeRaw;
      const unit   = cal.unit || 'r.u.';

      const calTrace = {
        x,
        y: pts.map(r => { const b = base(r); return typeof b === 'number' ? b * cal.slope : null; }),
        text: pts.map((r, i) => {
          const b = base(r);
          const val = typeof b === 'number' ? b * cal.slope : null;
          const cond = regressionConditions[r.selectionId];
          const condStr = cond ? ` [${cond}]` : '';
          return `<b>${label[i]}${condStr}</b><br>Rate: ${val != null ? val.toExponential(3) : '—'} ${unit}/min<br>R²: ${typeof r.r2Norm === 'number' ? r.r2Norm.toFixed(4) : '—'}`;
        }),
        mode: 'markers', type: 'scatter', name: `${unit}/min`, hoverinfo: 'text',
        marker: { size: 12, color: COLOR_CAL, symbol: 'circle-open', line: { width: 2.5, color: COLOR_CAL } }
      };

      Plotly.newPlot(safeId, [calTrace], {
        title: { text: `${signal} — calibrated slopes`, font: { size: 15, color: '#2c3e50' }, x: 0.5 },
        paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
        xaxis: { title: { text: 'Midpoint time (min)', standoff: 10 }, zeroline: false, showgrid: true, gridcolor: '#e9ecef' },
        yaxis: { title: { text: `${unit}/min`, standoff: 8 }, tickformat: '.1e', zeroline: true, zerolinecolor: '#ccc',
                 color: COLOR_CAL, tickfont: { color: COLOR_CAL }, titlefont: { color: COLOR_CAL } },
        margin: { t: 45, b: 70, l: 90, r: 20 },
        hovermode: 'closest',
        legend: { orientation: 'h', y: -0.32, x: 0.5, xanchor: 'center', font: { size: 10 } }
      }, { responsive: true, displayModeBar: false });

      // Calibrated photosynthesis rates chart (if photoMode)
      if (photoMode) {
        const safePhId = `cal-photo-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const lights = pts.filter(r => regressionConditions[r.selectionId] === 'light');
        const darks  = pts.filter(r => regressionConditions[r.selectionId] === 'dark');

        if (lights.length > 0) {
          const xVals=[], netY=[], respY=[], grossY=[], hNet=[], hResp=[], hGross=[];
          lights.forEach(light => {
            const lMid = (light.start_time + light.end_time) / 2;
            const paired = darks.length > 0 ? darks.reduce((best, d) =>
              Math.abs((d.start_time + d.end_time) / 2 - lMid) < Math.abs((best.start_time + best.end_time) / 2 - lMid) ? d : best) : null;
            const ls = base(light);
            const ds = paired ? base(paired) : null;
            const net   = typeof ls === 'number' ? ls * cal.slope : null;
            const resp  = ds != null ? ds * cal.slope : null;
            const gross = ds != null ? (ls - ds) * cal.slope : null;
            const lbl = `#${light.selectionId}: ${light.start_time.toFixed(1)}–${light.end_time.toFixed(1)} min`;
            const dlbl = paired ? `paired with dark #${paired.selectionId}` : 'no dark paired';
            xVals.push(lMid);
            netY.push(net); respY.push(resp); grossY.push(gross);
            hNet.push(`<b>${lbl}</b><br>Net: ${net != null ? net.toExponential(3) : '—'} ${unit}/min<br>${dlbl}`);
            hResp.push(`<b>${lbl}</b><br>Respiration: ${resp != null ? resp.toExponential(3) : '—'} ${unit}/min<br>${dlbl}`);
            hGross.push(`<b>${lbl}</b><br>Gross: ${gross != null ? gross.toExponential(3) : '—'} ${unit}/min<br>${dlbl}`);
          });
          const mkT = (name, y, hover, color, symbol) => ({
            x: xVals, y, text: hover, mode: 'markers', type: 'scatter', name, hoverinfo: 'text',
            marker: { size: 12, color, symbol, line: { width: 2.5, color } }
          });
          Plotly.newPlot(safePhId, [
            mkT('Net', netY, hNet, COLOR_NET, 'circle-open'),
            mkT('Respiration', respY, hResp, COLOR_RESP, 'square-open'),
            mkT('Gross', grossY, hGross, COLOR_GROSS, 'diamond-open')
          ], {
            title: { text: `${signal} — photosynthesis rates (${unit}/min)`, font: { size: 15, color: '#2c3e50' }, x: 0.5 },
            paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
            xaxis: { title: { text: 'Light midpoint time (min)', standoff: 10 }, zeroline: false, showgrid: true, gridcolor: '#e9ecef' },
            yaxis: { title: { text: `${unit}/min`, standoff: 8 }, tickformat: '.1e', zeroline: true, zerolinecolor: '#ccc' },
            margin: { t: 45, b: 70, l: 90, r: 20 },
            hovermode: 'closest',
            legend: { orientation: 'h', y: -0.32, x: 0.5, xanchor: 'center', font: { size: 10 } }
          }, { responsive: true, displayModeBar: false });
        } else {
          document.getElementById(safePhId).innerHTML =
            '<div class="text-muted small p-3">No light regressions tagged — enable photosynthesis mode and tag regressions.</div>';
        }
      }
    });
  });
}

// Resize Plotly charts when a Bootstrap 4 tab becomes visible (jQuery event)
$(document).on('shown.bs.tab', '#resultsTabs a[data-toggle="tab"]', function() {
  ['slope-charts-section', 'photo-rates-plots-section', 'calibrated-plots-section', 'recalc-section'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.querySelectorAll('.js-plotly-plot').forEach(p => { try { Plotly.Plots.resize(p); } catch(e){} });
  });
});

// ======================
// 12) Slope summary scatter charts — one plot per signal, dual Y-axes
// ======================
function renderSlopeCharts() {
  const section = document.getElementById('slope-charts-section');
  if (!section) return;

  if (regressionResults.length === 0) {
    section.innerHTML = '';
    return;
  }

  const uniqueSignals = [...new Set(regressionResults.map(r => r.signal))];

  // Fixed colors: raw=blue, normalized=orange
  const COLOR_RAW  = '#1f77b4';
  const COLOR_NORM = '#ff7f0e';

  // Build one card per signal in a flex-wrap row (~47% each → 2 per row)
  let html = `<hr><p class="mb-1"><strong>Regression slope summary</strong></p>
  <div style="display:flex; flex-wrap:wrap; gap:12px;">`;
  uniqueSignals.forEach(signal => {
    const safeId = `slope-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
    html += `
    <div style="flex:0 0 calc(47% - 6px); min-width:300px;
                border:1px solid #dee2e6; border-radius:6px;
                background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.07); overflow:hidden;">
      <div id="${safeId}" style="height:320px;"></div>
    </div>`;
  });
  html += `</div>`;
  section.innerHTML = html;

  requestAnimationFrame(() => {
    uniqueSignals.forEach(signal => {
      const safeId = `slope-chart-${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const pts = regressionResults.filter(r => r.signal === signal);
      const x = pts.map(r => +((r.start_time + r.end_time) / 2).toFixed(3));
      const label = pts.map(r => `#${r.selectionId}: ${r.start_time.toFixed(1)}–${r.end_time.toFixed(1)} min`);

      // Trace 1: Raw slope — primary Y (left), blue circles
      const rawTrace = {
        x,
        y: pts.map(r => (typeof r.slopeRaw === 'number' && !isNaN(r.slopeRaw)) ? r.slopeRaw : null),
        text: pts.map((r, i) =>
          `<b>${label[i]}</b><br>Raw slope: ${typeof r.slopeRaw === 'number' ? r.slopeRaw.toExponential(3) : '—'} a.u./min<br>R²: ${typeof r.r2Raw === 'number' ? r.r2Raw.toFixed(4) : '—'}`
        ),
        mode: 'markers', type: 'scatter', name: 'Raw', yaxis: 'y', hoverinfo: 'text',
        marker: { size: 12, color: COLOR_RAW, symbol: 'circle-open', line: { width: 2.5, color: COLOR_RAW } }
      };

      // Trace 2: Normalized slope — secondary Y (right), orange diamonds
      const normTrace = {
        x,
        y: pts.map(r => (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : null),
        text: pts.map((r, i) =>
          `<b>${label[i]}</b><br>Norm slope: ${typeof r.slopeNorm === 'number' ? r.slopeNorm.toExponential(3) : '—'} r.u./min<br>R²: ${typeof r.r2Norm === 'number' ? r.r2Norm.toFixed(4) : '—'}`
        ),
        mode: 'markers', type: 'scatter', name: 'Normalized', yaxis: 'y2', hoverinfo: 'text',
        marker: { size: 12, color: COLOR_NORM, symbol: 'diamond-open', line: { width: 2.5, color: COLOR_NORM } }
      };

      const traces = [rawTrace, normTrace];

      const layout = {
        title: { text: signal, font: { size: 15, color: '#2c3e50' }, x: 0.5 },
        paper_bgcolor: '#ffffff',
        plot_bgcolor:  '#ffffff',
        xaxis: {
          title: { text: 'Midpoint time (min)', standoff: 10 },
          zeroline: false, showgrid: true, gridcolor: '#e9ecef', domain: [0, 0.84]
        },
        yaxis: {
          title: { text: 'Raw slope (a.u./min)', standoff: 8 },
          tickformat: '.1e', side: 'left', zeroline: true, zerolinecolor: '#ccc',
          color: COLOR_RAW, tickfont: { color: COLOR_RAW }, titlefont: { color: COLOR_RAW }
        },
        yaxis2: {
          title: { text: 'Norm. slope (r.u./min)', standoff: 8 },
          tickformat: '.1e', side: 'right', overlaying: 'y', zeroline: false,
          showgrid: false, color: COLOR_NORM, tickfont: { color: COLOR_NORM }, titlefont: { color: COLOR_NORM }
        },
        margin: { t: 40, b: 70, l: 90, r: 90 },
        hovermode: 'closest',
        legend: { orientation: 'h', y: -0.32, x: 0.5, xanchor: 'center', font: { size: 10 } }
      };

      Plotly.newPlot(safeId, traces, layout, { responsive: true, displayModeBar: false });
    });
  });
}

// ======================
// 11) Calibration & Unit Conversion
// ======================
function renderCalibrationSection() {
  const calDiv = document.getElementById('calibration-section');
  if (!calDiv) return;

  if (regressionResults.length === 0) {
    calDiv.style.display = 'none';
    calDiv.innerHTML = '';
    return;
  }

  const uniqueSignals = [...new Set(regressionResults.map(r => r.signal))];
  calDiv.style.display = 'block';

  let html = `
  <div class="card shadow-sm mt-3" id="calibration-card">
    <div class="card-header d-flex justify-content-between align-items-center"
         style="background:#f0fff4; cursor:pointer;"
         data-toggle="collapse" data-target="#calibration-body" aria-expanded="false">
      <span>
        <strong>Unit Conversion &amp; Calibration</strong>
        <span class="text-muted ml-2 small">Optional — convert slopes to real concentration or rate units</span>
      </span>
      <span class="small">&#9660;</span>
    </div>
    <div id="calibration-body" class="collapse">
      <div class="card-body">
        <p class="text-muted small mb-3">
          Provide a calibration factor to convert signal derivatives (slope in signal/min) to real rates
          (e.g. µmol O₂/L/min). Enter the calibration <strong>slope <em>a</em></strong> from a linear
          calibration: <em>concentration = a &times; signal + b</em>.<br>
          The reported calibrated rate = regression slope (normalized) &times; <em>a</em>.<br>
          Use <strong>Manual</strong> to enter the slope directly, or <strong>Calibration points</strong>
          to fit a line from your own calibration data (e.g. from known gas concentrations).
        </p>`;

  uniqueSignals.forEach(signal => {
    const cal = mimsCalibrations[signal] || { type: 'none' };
    const signalUnit = mimsFieldUnits[signal] ? ` [${mimsFieldUnits[signal]}]` : '';
    const safeId = `cal_${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;

    const manualVisible = cal.type === 'manual' ? '' : 'style="display:none;"';
    const pointsVisible = cal.type === 'points' ? '' : 'style="display:none;"';
    const pointsText = (cal.points || []).map(p => p.join(', ')).join('\n');
    const manualSlope = (typeof cal.slope === 'number' && cal.type === 'manual') ? cal.slope : '';
    const manualIntercept = (typeof cal.intercept === 'number' && cal.type === 'manual') ? cal.intercept : 0;
    const calUnit = cal.unit || '';
    const fitInfo = (cal.type === 'points' && typeof cal.slope === 'number' && !isNaN(cal.slope))
      ? `<span class="badge badge-success mt-1 d-inline-block" style="font-size:0.78em;">
           Fit: y = ${cal.slope.toExponential(3)} &times; x + ${(cal.intercept || 0).toExponential(3)},
           R&sup2; = ${typeof cal.calR2 === 'number' ? cal.calR2.toFixed(4) : '?'}
         </span>`
      : '';

    html += `
    <div class="border rounded p-2 mb-2 bg-white">
      <div class="d-flex align-items-center flex-wrap mb-2" style="gap:8px;">
        <strong class="small">${signal}${signalUnit}</strong>
        <select class="form-control form-control-sm" style="width:auto; max-width:220px;"
                id="${safeId}_type"
                onchange="updateCalibrationInputs('${signal}', '${safeId}')">
          <option value="none" ${cal.type === 'none' ? 'selected' : ''}>No calibration</option>
          <option value="manual" ${cal.type === 'manual' ? 'selected' : ''}>Manual (enter slope)</option>
          <option value="points" ${cal.type === 'points' ? 'selected' : ''}>Calibration points (fit)</option>
        </select>
      </div>

      <div id="${safeId}_manual" class="mt-1" ${manualVisible}>
        <div class="form-row">
          <div class="col-sm-3 mb-2">
            <label class="small text-muted mb-0">Calibration slope <em>a</em> (conc / signal)</label>
            <input type="number" class="form-control form-control-sm" id="${safeId}_slope"
                   step="any" value="${manualSlope}" placeholder="e.g. 1.25e7">
          </div>
          <div class="col-sm-2 mb-2">
            <label class="small text-muted mb-0">Intercept <em>b</em></label>
            <input type="number" class="form-control form-control-sm" id="${safeId}_intercept"
                   step="any" value="${manualIntercept}" placeholder="0">
          </div>
          <div class="col-sm-3 mb-2">
            <label class="small text-muted mb-0">Result unit (concentration unit)</label>
            <input type="text" class="form-control form-control-sm" id="${safeId}_unit_manual"
                   value="${calUnit}" placeholder="e.g. µmol/L">
          </div>
        </div>
      </div>

      <div id="${safeId}_points" class="mt-1" ${pointsVisible}>
        <div class="form-row">
          <div class="col-sm-5 mb-2">
            <label class="small text-muted mb-0">
              Calibration pairs (signal value, concentration) — one pair per line:
            </label>
            <textarea class="form-control form-control-sm" id="${safeId}_pointstext"
                      rows="4" style="font-family:monospace;"
                      placeholder="0, 0&#10;1.2e-10, 50&#10;3.5e-10, 150">${pointsText}</textarea>
            <small class="text-muted">Separate signal and concentration with comma or tab.</small>
            <div>${fitInfo}</div>
          </div>
          <div class="col-sm-3 mb-2">
            <label class="small text-muted mb-0">Result unit (concentration unit)</label>
            <input type="text" class="form-control form-control-sm" id="${safeId}_unit_points"
                   value="${calUnit}" placeholder="e.g. µmol/L">
            <small class="text-muted d-block mt-1">
              Rate = slope &times; <em>a</em> [unit/min].
            </small>
          </div>
        </div>
      </div>
    </div>`;
  });

  html += `
        <button class="btn btn-success btn-sm mt-2" onclick="applyCalibration()">
          Apply Calibration
        </button>
        <span class="text-muted small ml-2">Updates the regression table and XLSX export with calibrated rates.</span>
      </div>
    </div>
  </div>`;

  calDiv.innerHTML = html;
}

function updateCalibrationInputs(_signal, safeId) {
  const type = document.getElementById(`${safeId}_type`).value;
  const manualDiv = document.getElementById(`${safeId}_manual`);
  const pointsDiv = document.getElementById(`${safeId}_points`);
  if (manualDiv) manualDiv.style.display = type === 'manual' ? '' : 'none';
  if (pointsDiv) pointsDiv.style.display = type === 'points' ? '' : 'none';
}

function applyCalibration() {
  const uniqueSignals = [...new Set(regressionResults.map(r => r.signal))];

  uniqueSignals.forEach(signal => {
    const safeId = `cal_${signal.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const typeEl = document.getElementById(`${safeId}_type`);
    if (!typeEl) return;
    const type = typeEl.value;

    if (type === 'none') {
      mimsCalibrations[signal] = { type: 'none' };
      return;
    }

    const unitInput = document.getElementById(`${safeId}_unit_${type}`) || document.getElementById(`${safeId}_unit_manual`);
    const unit = (unitInput || {}).value || '';

    if (type === 'manual') {
      const slope = parseFloat((document.getElementById(`${safeId}_slope`) || {}).value);
      const intercept = parseFloat((document.getElementById(`${safeId}_intercept`) || {}).value) || 0;
      if (isNaN(slope)) { alert(`Calibration for "${signal}": slope is not a valid number.`); return; }
      mimsCalibrations[signal] = { type: 'manual', slope, intercept, unit };
      return;
    }

    if (type === 'points') {
      const textarea = document.getElementById(`${safeId}_pointstext`);
      if (!textarea) return;
      const lines = textarea.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      const points = [];
      lines.forEach(line => {
        const parts = line.split(/[,\t]+/).map(p => parseFloat(p.trim()));
        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          points.push([parts[0], parts[1]]);
        }
      });
      if (points.length < 2) {
        alert(`Calibration for "${signal}": need at least 2 valid pairs.`);
        return;
      }
      // Linear regression on calibration points
      const xs = points.map(p => p[0]);
      const ys = points.map(p => p[1]);
      const n = xs.length;
      const sumX = xs.reduce((a, b) => a + b, 0);
      const sumY = ys.reduce((a, b) => a + b, 0);
      const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0);
      const sumXX = xs.reduce((s, x) => s + x * x, 0);
      const denom = n * sumXX - sumX * sumX;
      const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : NaN;
      const intercept = denom !== 0 ? (sumY - slope * sumX) / n : NaN;
      const yMean = sumY / n;
      const ssTot = ys.reduce((s, y) => s + Math.pow(y - yMean, 2), 0);
      const ssRes = ys.reduce((s, y, i) => s + Math.pow(y - (slope * xs[i] + intercept), 2), 0);
      const calR2 = ssTot !== 0 ? 1 - ssRes / ssTot : NaN;
      mimsCalibrations[signal] = { type: 'points', slope, intercept, unit, calR2, nPoints: n, points };
    }
  });

  refreshRegressionTable();
}

// ======================
// 13) Normalisation Factor (per-biomass / per-OD / per-cell-count etc.)
// ======================

// Persist draft from current DOM inputs so re-renders don't lose edits
function _saveNormDraftFromDOM() {
  if (normMode === 'single') {
    const v = document.getElementById('normfactor-value');
    const u = document.getElementById('normfactor-unit');
    if (v) normSingleDraft.value = v.value;
    if (u) normSingleDraft.unit  = u.value;
  } else {
    const n = normMultiDraft.length;
    for (let i = 0; i < n; i++) {
      const nm = document.getElementById(`norm-row-${i}-name`);
      const st = document.getElementById(`norm-row-${i}-start`);
      const en = document.getElementById(`norm-row-${i}-end`);
      const vl = document.getElementById(`norm-row-${i}-value`);
      if (nm) normMultiDraft[i].name  = nm.value;
      if (st) normMultiDraft[i].start = st.value;
      if (en) normMultiDraft[i].end   = en.value;
      if (vl) normMultiDraft[i].value = vl.value;
    }
    const u = document.getElementById('normfactor-unit');
    if (u) normSingleDraft.unit = u.value; // shared unit field
  }
}

function normSwitchMode(mode) {
  _saveNormDraftFromDOM();
  normMode = mode;
  renderNormFactorSection();
}

function normAddRow() {
  _saveNormDraftFromDOM();
  normMultiDraft.push({ name: '', start: '', end: '', value: '' });
  renderNormFactorSection();
}

function normRemoveRow(i) {
  _saveNormDraftFromDOM();
  normMultiDraft.splice(i, 1);
  renderNormFactorSection();
}

function renderNormFactorSection() {
  _saveNormDraftFromDOM();
  const div = document.getElementById('normfactor-section');
  if (!div) return;

  if (regressionResults.length === 0) {
    div.style.display = 'none';
    div.innerHTML = '';
    return;
  }
  div.style.display = 'block';

  const active = mimsNormFactor != null;
  const bodyEl = document.getElementById('normfactor-body');
  const wasOpen = bodyEl ? bodyEl.classList.contains('show') : active;
  const unit   = normSingleDraft.unit || (mimsNormFactor ? mimsNormFactor.unit : '');
  let activeBadge = '';
  if (active) {
    activeBadge = mimsNormFactor.mode === 'multi'
      ? `<span class="badge badge-primary ml-2">Active: ${mimsNormFactor.samples.length} samples / ${mimsNormFactor.unit}</span>`
      : `<span class="badge badge-primary ml-2">Active: per ${mimsNormFactor.unit}</span>`;
  }

  // --- Single mode panel ---
  const singleVal = normSingleDraft.value || (active && mimsNormFactor.mode === 'single' ? mimsNormFactor.value : '');
  const singlePanel = `
    <p class="text-muted small mb-2">
      Divide all regression slopes (and calibrated rates if calibration is active) by a constant.<br>
      Example: value&nbsp;=&nbsp;0.125, unit&nbsp;=&nbsp;gDW &rarr; rate in mmol O&#8322;&nbsp;/&nbsp;gDW&nbsp;/&nbsp;min.
    </p>
    <div class="form-inline" style="gap:8px; flex-wrap:wrap; align-items:center;">
      <div class="input-group input-group-sm">
        <div class="input-group-prepend"><span class="input-group-text">Value</span></div>
        <input type="number" id="normfactor-value" class="form-control" style="width:110px;"
               step="any" min="0" placeholder="e.g. 0.125" value="${singleVal}">
      </div>
      <div class="input-group input-group-sm">
        <div class="input-group-prepend"><span class="input-group-text">Unit</span></div>
        <input type="text" id="normfactor-unit" class="form-control" style="width:110px;"
               placeholder="e.g. gDW" value="${unit}">
      </div>
    </div>`;

  // --- Multi mode panel ---
  if (normMultiDraft.length === 0 && active && mimsNormFactor.mode === 'multi') {
    normMultiDraft = mimsNormFactor.samples.map(s => ({ name: s.name, start: s.start === 0 ? '0' : s.start, end: s.end === Infinity ? '' : s.end, value: s.value }));
  }
  const multiRows = normMultiDraft.map((row, i) => `
    <tr>
      <td><input type="text"   class="form-control form-control-sm" id="norm-row-${i}-name"
                 value="${row.name}"  placeholder="e.g. Strain A"></td>
      <td><input type="number" class="form-control form-control-sm" id="norm-row-${i}-start"
                 value="${row.start}" step="any" placeholder="0" style="width:80px;"></td>
      <td><input type="number" class="form-control form-control-sm" id="norm-row-${i}-end"
                 value="${row.end}"   step="any" placeholder="∞" style="width:80px;"></td>
      <td><input type="number" class="form-control form-control-sm" id="norm-row-${i}-value"
                 value="${row.value}" step="any" min="0" placeholder="0.1" style="width:90px;"></td>
      <td><button class="btn btn-sm btn-outline-danger" onclick="normRemoveRow(${i})">&#10005;</button></td>
    </tr>`).join('');

  const multiPanel = `
    <p class="text-muted small mb-2">
      Assign a normalisation value to each time interval. Each regression is assigned to the interval
      containing its midpoint. Leave End blank for open-ended intervals.
    </p>
    <div class="input-group input-group-sm mb-2" style="width:auto;">
      <div class="input-group-prepend"><span class="input-group-text">Unit for all samples</span></div>
      <input type="text" id="normfactor-unit" class="form-control" style="width:110px;"
             placeholder="e.g. gDW" value="${unit}">
    </div>
    <div class="table-responsive">
    <table class="table table-sm table-bordered mb-1" style="font-size:0.87em;">
      <thead class="thead-light">
        <tr><th>Sample name</th><th>Start (min)</th><th>End (min)</th><th>Value</th><th></th></tr>
      </thead>
      <tbody>${multiRows}</tbody>
    </table>
    </div>
    <button class="btn btn-sm btn-outline-secondary mb-1" onclick="normAddRow()">+ Add row</button>
    <p class="text-muted small mt-1 mb-0">Tip: intervals are matched by regression midpoint time. Overlapping intervals use the first match.</p>`;

  div.innerHTML = `
  <div class="card shadow-sm mt-3">
    <div class="card-header d-flex justify-content-between align-items-center"
         style="background:#f5f0ff; cursor:pointer;"
         data-toggle="collapse" data-target="#normfactor-body" aria-expanded="${wasOpen ? 'true' : 'false'}">
      <span>
        <strong>Normalise rates by sample property</strong>
        <span class="text-muted ml-2 small">Optional — divide by dry weight, cell count, OD, volume, etc.</span>
        ${activeBadge}
      </span>
      <span class="small">&#9660;</span>
    </div>
    <div id="normfactor-body" class="collapse${wasOpen ? ' show' : ''}">
      <div class="card-body">
        <!-- Mode toggle -->
        <div class="btn-group btn-group-sm mb-3" role="group">
          <button type="button" class="btn ${normMode === 'single' ? 'btn-primary' : 'btn-outline-primary'}"
                  onclick="normSwitchMode('single')">Single value</button>
          <button type="button" class="btn ${normMode === 'multi' ? 'btn-primary' : 'btn-outline-primary'}"
                  onclick="normSwitchMode('multi')">Multiple samples</button>
        </div>
        <!-- Mode-specific panel -->
        <div id="normfactor-panel">
          ${normMode === 'single' ? singlePanel : multiPanel}
        </div>
        <!-- Action buttons -->
        <div class="mt-2 d-flex" style="gap:6px;">
          <button class="btn btn-sm btn-primary" onclick="applyNormFactor()">Apply</button>
          <button class="btn btn-sm btn-outline-secondary" onclick="clearNormFactor()">Clear</button>
        </div>
        <p class="text-muted small mt-2 mb-0">
          Common units: gDW &nbsp;|&nbsp; gFW &nbsp;|&nbsp; OD<sub>750</sub> &nbsp;|&nbsp;
          10<sup>6</sup>&nbsp;cells &nbsp;|&nbsp; mL &nbsp;|&nbsp; mg&nbsp;Chl
        </p>
      </div>
    </div>
  </div>`;
}

function applyNormFactor() {
  _saveNormDraftFromDOM();
  const unit = normSingleDraft.unit.trim() || 'unit';

  if (normMode === 'single') {
    const value = parseFloat(normSingleDraft.value);
    if (isNaN(value) || value <= 0) { alert('Normalisation value must be a positive number.'); return; }
    mimsNormFactor = { mode: 'single', value, unit };

  } else {
    // Parse multi rows
    const samples = normMultiDraft.map((row, i) => {
      const name  = row.name.trim() || `Sample ${i + 1}`;
      const start = parseFloat(row.start);
      const end   = parseFloat(row.end);
      const value = parseFloat(row.value);
      return { name, start: isNaN(start) ? 0 : start, end: isNaN(end) ? Infinity : end, value };
    }).filter(s => !isNaN(s.value) && s.value > 0);

    if (samples.length === 0) { alert('Add at least one sample row with a valid value.'); return; }

    // Warn on overlapping intervals
    for (let i = 0; i < samples.length; i++) {
      for (let j = i + 1; j < samples.length; j++) {
        if (samples[i].start < samples[j].end && samples[j].start < samples[i].end) {
          if (!confirm(`Intervals "${samples[i].name}" and "${samples[j].name}" overlap. First match will be used. Continue?`)) return;
          break;
        }
      }
    }
    mimsNormFactor = { mode: 'multi', unit, samples };
  }

  refreshRegressionTable();
  renderNormFactorSection();
}

function clearNormFactor() {
  mimsNormFactor = null;
  normMode = 'single';
  normMultiDraft = [];
  normSingleDraft = { value: '', unit: normSingleDraft.unit }; // preserve unit label
  const recalcLi = document.getElementById('tab-recalc-li');
  if (recalcLi) recalcLi.style.display = 'none';
  const activeLink = document.querySelector('#resultsTabs .nav-link.active');
  if (activeLink && activeLink.getAttribute('href') === '#tab-recalc') {
    $(document.querySelector('a[href="#tab-slope-plots"]')).tab('show');
  }
  refreshRegressionTable();
  renderNormFactorSection();
}

// Return the matching sample info for a regression, or null if no norm factor / no interval match.
// Returns { name, value, unit } — name is null in single mode.
function getSampleForRegression(r) {
  if (!mimsNormFactor) return null;
  if (mimsNormFactor.mode === 'single') {
    return { name: null, value: mimsNormFactor.value, unit: mimsNormFactor.unit };
  }
  const mid = (r.start_time + r.end_time) / 2;
  const s = mimsNormFactor.samples.find(s => mid >= s.start && mid < s.end);
  return s ? { name: s.name, value: s.value, unit: mimsNormFactor.unit } : null;
}

// Compute recalculated rate for a regression row.
// Returns { value, unit, sampleName } or null.
function recalcRate(r) {
  const sample = getSampleForRegression(r);
  if (!sample) return null;
  const cal = mimsCalibrations[r.signal];
  const hasCal = cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
  const s = (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : r.slopeRaw;
  if (typeof s !== 'number' || isNaN(s)) return null;
  const base = hasCal ? s * cal.slope : s;
  const rateUnit = hasCal ? `${cal.unit || 'r.u.'} / ${sample.unit} / min` : `r.u. / ${sample.unit} / min`;
  return { value: base / sample.value, unit: rateUnit, sampleName: sample.name };
}

// ======================
// 13b) Recalculated tab: slope + photo plots
// ======================
function renderRecalcTab() {
  const section = document.getElementById('recalc-section');
  const tabLi   = document.getElementById('tab-recalc-li');
  if (!section) return;

  if (!mimsNormFactor || regressionResults.length === 0) {
    section.innerHTML = '';
    if (tabLi) tabLi.style.display = 'none';
    // Switch away if active
    const activeLink = document.querySelector('#resultsTabs .nav-link.active');
    if (activeLink && activeLink.getAttribute('href') === '#tab-recalc') {
      const slopeLink = document.querySelector('a[href="#tab-slope-plots"]');
      if (slopeLink) $(slopeLink).tab('show');
    }
    return;
  }
  const { value: nfVal, unit: nfUnit } = mimsNormFactor;

  // Only show signals that have an active calibration
  const isCalibrated = sig => {
    const cal = mimsCalibrations[sig];
    return cal && cal.type !== 'none' && typeof cal.slope === 'number' && !isNaN(cal.slope);
  };
  const allSignals     = [...new Set(regressionResults.map(r => r.signal))];
  const calSignals     = allSignals.filter(isCalibrated);
  const lights         = regressionResults.filter(r => regressionConditions[r.selectionId] === 'light');
  const calPhotoSigs   = photoMode ? [...new Set(lights.map(r => r.signal))].filter(isCalibrated) : [];

  // Nothing calibrated → hide tab
  if (calSignals.length === 0 && calPhotoSigs.length === 0) {
    section.innerHTML = '<p class="text-muted small p-2">No calibration active. Apply calibration in the section below to see recalculated plots.</p>';
    if (tabLi) tabLi.style.display = 'block'; // keep tab visible so user sees the message
    return;
  }
  if (tabLi) tabLi.style.display = 'block';

  const rateUnitFor = sig => {
    const cal = mimsCalibrations[sig];
    return `${cal.unit || 'r.u.'} / ${nfUnit} / min`;
  };

  const isMulti = mimsNormFactor.mode === 'multi';
  const SAMPLE_PALETTE = ['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf'];
  const sampleNames    = isMulti ? mimsNormFactor.samples.map(s => s.name) : [];
  const sampleColor    = name => isMulti ? SAMPLE_PALETTE[sampleNames.indexOf(name) % SAMPLE_PALETTE.length] : '#7b2d8b';

  const COLOR_NET   = '#1f77b4';
  const COLOR_RESP  = '#d62728';
  const COLOR_GROSS = '#2ca02c';

  const descLine = isMulti
    ? `Calibrated rates normalised per sample (${sampleNames.join(', ')}) in <strong>${nfUnit}</strong>.`
    : `Calibrated rates normalised by <strong>${nfVal} ${nfUnit}</strong>.`;
  let html = `<p class="text-muted small mb-1">${descLine}</p>`;

  if (calSignals.length > 0) {
    html += `<hr><p class="mb-1"><strong>Regression slopes / ${nfUnit}</strong></p>
    <div style="display:flex; flex-wrap:wrap; gap:12px;">`;
    calSignals.forEach(sig => {
      const safeId = `recalc-slope-${sig.replace(/[^a-zA-Z0-9]/g, '_')}`;
      html += `<div style="flex:0 0 calc(47% - 6px); min-width:300px; border:1px solid #dee2e6; border-radius:6px; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.07); overflow:hidden;"><div id="${safeId}" style="height:320px;"></div></div>`;
    });
    html += `</div>`;
  }

  if (calPhotoSigs.length > 0) {
    html += `<hr><p class="mb-1"><strong>Photosynthesis rates / ${nfUnit}</strong></p>
    <div style="display:flex; flex-wrap:wrap; gap:12px;">`;
    calPhotoSigs.forEach(sig => {
      const safeId = `recalc-photo-${sig.replace(/[^a-zA-Z0-9]/g, '_')}`;
      html += `<div style="flex:0 0 calc(47% - 6px); min-width:300px; border:1px solid #dee2e6; border-radius:6px; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,0.07); overflow:hidden;"><div id="${safeId}" style="height:320px;"></div></div>`;
    });
    html += `</div>`;
  }

  section.innerHTML = html;

  requestAnimationFrame(() => {
    // Helper: build one trace per sample (multi) or one trace total (single)
    const makeTracesBySample = (pts, yFn, hoverFn, symbol) => {
      if (!isMulti) {
        const color = '#7b2d8b';
        return [{
          x: pts.map(r => +((r.start_time + r.end_time) / 2).toFixed(3)),
          y: pts.map(yFn), text: pts.map(hoverFn),
          mode: 'markers', type: 'scatter', name: nfUnit, hoverinfo: 'text',
          marker: { size: 12, color, symbol, line: { width: 2.5, color } }
        }];
      }
      // Group by sample name; unassigned points shown in grey
      const groups = {};
      pts.forEach(r => {
        const s = getSampleForRegression(r);
        const key = s ? s.name : '__unassigned__';
        if (!groups[key]) groups[key] = [];
        groups[key].push(r);
      });
      return Object.entries(groups).map(([name, rows]) => {
        const color = name === '__unassigned__' ? '#cccccc' : sampleColor(name);
        const label = name === '__unassigned__' ? 'Unassigned' : name;
        return {
          x: rows.map(r => +((r.start_time + r.end_time) / 2).toFixed(3)),
          y: rows.map(yFn), text: rows.map(hoverFn),
          mode: 'markers', type: 'scatter', name: label, hoverinfo: 'text',
          marker: { size: 12, color, symbol, line: { width: 2.5, color } }
        };
      });
    };

    // Calibrated slope scatter plots
    calSignals.forEach(sig => {
      const safeId = `recalc-slope-${sig.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const cal    = mimsCalibrations[sig];
      const pts    = regressionResults.filter(r => r.signal === sig);
      const yUnit  = rateUnitFor(sig);
      const baseS  = r => (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : r.slopeRaw;
      const yFn    = r => {
        const s = getSampleForRegression(r);
        const b = baseS(r);
        return (s && typeof b === 'number') ? (b * cal.slope) / s.value : null;
      };
      const hFn = r => {
        const v = yFn(r);
        const s = getSampleForRegression(r);
        const lbl = `#${r.selectionId}: ${r.start_time.toFixed(1)}–${r.end_time.toFixed(1)} min`;
        const cond = regressionConditions[r.selectionId];
        const sname = s ? ` [${s.name || nfUnit}]` : ' [unassigned]';
        return `<b>${lbl}${cond ? ` [${cond}]` : ''}${isMulti ? sname : ''}</b><br>Rate: ${v != null ? v.toExponential(3) : '—'} ${yUnit}`;
      };

      Plotly.newPlot(safeId, makeTracesBySample(pts, yFn, hFn, 'circle-open'), {
        title: { text: sig, font: { size: 15, color: '#2c3e50' }, x: 0.5 },
        paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
        xaxis: { title: { text: 'Midpoint time (min)', standoff: 10 }, zeroline: false, showgrid: true, gridcolor: '#e9ecef' },
        yaxis: { title: { text: yUnit, standoff: 8 }, tickformat: '.2e', zeroline: true, zerolinecolor: '#ccc' },
        margin: { t: 45, b: 70, l: 110, r: 20 },
        hovermode: 'closest',
        legend: { orientation: 'h', y: -0.32, x: 0.5, xanchor: 'center', font: { size: 10 } }
      }, { responsive: true, displayModeBar: false });
    });

    // Calibrated photosynthesis rate plots
    if (calPhotoSigs.length > 0) {
      const photoDarks = regressionResults.filter(r => regressionConditions[r.selectionId] === 'dark');

      calPhotoSigs.forEach(sig => {
        const safeId    = `recalc-photo-${sig.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const cal       = mimsCalibrations[sig];
        const sigLights = lights.filter(r => r.signal === sig);
        const sigDarks  = photoDarks.filter(r => r.signal === sig);
        const yUnit     = rateUnitFor(sig);
        const baseSlope = r => (typeof r.slopeNorm === 'number' && !isNaN(r.slopeNorm)) ? r.slopeNorm : r.slopeRaw;

        // Build per-light-regression rows with computed net/resp/gross
        const photoRows = sigLights.map(light => {
          const lMid   = (light.start_time + light.end_time) / 2;
          const paired = sigDarks.length > 0 ? sigDarks.reduce((best, d) =>
            Math.abs((d.start_time + d.end_time) / 2 - lMid) < Math.abs((best.start_time + best.end_time) / 2 - lMid) ? d : best) : null;
          const s   = getSampleForRegression(light);
          const div = s ? s.value : null;
          const toRC = v => (v != null && div) ? (v * cal.slope) / div : null;
          const ls  = baseSlope(light);
          const ds  = paired ? baseSlope(paired) : null;
          return { light, paired, lMid, s,
            net: toRC(ls), resp: ds != null ? toRC(ds) : null, gross: ds != null ? toRC(ls - ds) : null };
        });

        // Build traces: in multi mode, group by sample name within each rate type
        const mkPhotoTraces = (rateKey, label, color, sym) => {
          if (!isMulti) {
            return [{
              x: photoRows.map(p => p.lMid),
              y: photoRows.map(p => p[rateKey]),
              text: photoRows.map(p => {
                const dlbl = p.paired ? `paired dark #${p.paired.selectionId}` : 'no dark paired';
                return `<b>#${p.light.selectionId}</b><br>${label}: ${p[rateKey] != null ? p[rateKey].toExponential(3) : '—'} ${yUnit}<br>${dlbl}`;
              }),
              mode: 'markers', type: 'scatter', name: label, hoverinfo: 'text',
              marker: { size: 12, color, symbol: sym, line: { width: 2.5, color } }
            }];
          }
          const groups = {};
          photoRows.forEach(p => {
            const key = p.s ? p.s.name : '__unassigned__';
            if (!groups[key]) groups[key] = [];
            groups[key].push(p);
          });
          return Object.entries(groups).map(([name, rows]) => {
            const c = name === '__unassigned__' ? '#cccccc' : sampleColor(name);
            return {
              x: rows.map(p => p.lMid), y: rows.map(p => p[rateKey]),
              text: rows.map(p => {
                const dlbl = p.paired ? `paired dark #${p.paired.selectionId}` : 'no dark paired';
                return `<b>#${p.light.selectionId} [${name === '__unassigned__' ? 'unassigned' : name}]</b><br>${label}: ${p[rateKey] != null ? p[rateKey].toExponential(3) : '—'} ${yUnit}<br>${dlbl}`;
              }),
              mode: 'markers', type: 'scatter',
              name: `${label} — ${name === '__unassigned__' ? 'Unassigned' : name}`, hoverinfo: 'text',
              marker: { size: 12, color: c, symbol: sym, line: { width: 2.5, color: c } }
            };
          });
        };

        const traces = [
          ...mkPhotoTraces('net',   'Net',         COLOR_NET,   'circle-open'),
          ...mkPhotoTraces('resp',  'Respiration', COLOR_RESP,  'square-open'),
          ...mkPhotoTraces('gross', 'Gross',       COLOR_GROSS, 'diamond-open')
        ];

        Plotly.newPlot(safeId, traces, {
          title: { text: `${sig} — photosynthesis rates`, font: { size: 15, color: '#2c3e50' }, x: 0.5 },
          paper_bgcolor: '#ffffff', plot_bgcolor: '#ffffff',
          xaxis: { title: { text: 'Light midpoint time (min)', standoff: 10 }, zeroline: false, showgrid: true, gridcolor: '#e9ecef' },
          yaxis: { title: { text: yUnit, standoff: 8 }, tickformat: '.2e', zeroline: true, zerolinecolor: '#ccc' },
          margin: { t: 45, b: 70, l: 110, r: 20 },
          hovermode: 'closest',
          legend: { orientation: 'h', y: -0.32, x: 0.5, xanchor: 'center', font: { size: 10 } }
        }, { responsive: true, displayModeBar: false });
      });
    }
  });
}

// ======================
document.getElementById('MIMS_file').addEventListener('change', function (ev) {
  selectedFile = ev.target.files[0];
  const label = document.querySelector('label[for="MIMS_file"]');
  if (label && selectedFile) label.textContent = selectedFile.name;
  // reset UI bits
  document.getElementById('raw-container').style.display = 'none';
  document.getElementById('normalized-container').style.display = 'none';
  document.getElementById('preview-label').style.display = 'none';
  document.getElementById('normalized-preview-label').style.display = 'none';
  document.getElementById('normalization-controls').style.display = 'none';
  document.getElementById('regression-results-table').innerHTML = '';
  document.getElementById('find-coefficients-label').style.display = 'none';
  document.getElementById('regression-controls-row').style.display = 'none';
  document.getElementById('photo-mode-row').style.display = 'none';
  clickRegressionMode = false;
  document.getElementById('xlsx-download-section').style.display = 'none';
  document.getElementById('early-xlsx-download-section').style.display = 'none';
  regressionResults = []; currentZoomRange = null; rawTraceIndicesBySelection.clear(); normTraceIndicesBySelection.clear(); selectionCounter = 0;
  mimsCalibrations = {}; regressionConditions = {}; photoMode = false; newRegressionCondition = null;
  mimsNormFactor = null; normMode = 'single'; normMultiDraft = []; normSingleDraft = { value: '', unit: '' };
  const photoBtn = document.getElementById('photo-mode-btn');
  if (photoBtn) { photoBtn.classList.remove('btn-success'); photoBtn.classList.add('btn-outline-success'); photoBtn.textContent = '🌿 Photosynthesis rates'; }
  const preselectGrp = document.getElementById('photo-preselect-group');
  if (preselectGrp) preselectGrp.style.display = 'none';
  ['tab-photo-li', 'tab-photoplot-li'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
  const err = document.getElementById('mims-error-alert'); if (err) err.innerHTML = '';
  // Auto-preview immediately after file selection
  if (selectedFile) {
    const errDiv = document.getElementById('mims-error-alert'); if (errDiv) errDiv.innerHTML = '';
    const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || '';
    const ext = (selectedFile.name.split('.').pop() || '').toLowerCase();
    const isCSV = ext === 'csv';
    const isASCI = ext === 'asc' || ext === 'asci';
    let valid = false;
    if (selectedModel.includes('HPR40') && isCSV) valid = true;
    if ((selectedModel.includes('MSGAS') || selectedModel.includes('QMS')) && isASCI) valid = true;
    if (!valid) { if (errDiv) errDiv.innerHTML = `<div class="alert alert-danger">Invalid file type for selected model.</div>`; return; }
    parseMIMSFile(selectedFile, function(result) {
      if (!result || !result.data || result.data.length === 0) {
        document.getElementById('mims-error-alert').innerHTML = `<div class="alert alert-danger">No data parsed.</div>`;
        return;
      }
      if (result.fieldUnits) Object.assign(mimsFieldUnits, result.fieldUnits);
      plotMIMSData(result);
    });
  }
});