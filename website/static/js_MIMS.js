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
  const traces = yFields.map((field, idx) => {
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
  Plotly.relayout('raw-plot-div', { 'yaxis.title.text': title }).catch(()=>{});
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
      `<span style="font-size:0.85em;">divided by ${refField} signal, self-normalized at t = ${tpValue.toFixed(2)} min</span>`,
      `<span style="font-size:0.85em;">${selectedFile ? selectedFile.name : ''}</span>`
    ].join('<br>'),
    font: { size: 13 }
  };

  Plotly.newPlot('normalized-plot-div', traces, {
    title: normPlotTitle,
    xaxis: { title: xField === 'min' ? 'Time (min)' : xField },
    yaxis: { title: `Signal / ${refField} (r.u.)`, tickformat: '.1e' }
  }).then(() => {
    const np = document.getElementById('normalized-plot-div');
    np.on('plotly_relayout', function(eventData) {
      if (eventData['xaxis.range[0]'] !== undefined && eventData['xaxis.range[1]'] !== undefined) {
        currentZoomRange = { x0: parseFloat(eventData['xaxis.range[0]']), x1: parseFloat(eventData['xaxis.range[1]']) };
      }
    });
  });

  document.getElementById('normalized-container').style.display = 'block';
  document.getElementById('normalized-preview-label').style.display = 'block';
  document.getElementById('find-coefficients-label').style.display = 'block';
  document.getElementById('early-xlsx-download-section').style.display = 'block';

  requestAnimationFrame(() => {
    document.getElementById('confirm-selection-button').style.display = 'inline-block';
    document.getElementById('clear-regressions-in-table-button').style.display = 'inline-block';
    Plotly.Plots.resize('normalized-plot-div');
  });
}


// ======================
// 6) Regression fitting
// ======================
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
      line: { dash: 'dot', width: 2, color: mimsFieldColors[field] || 'black' }
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
        line: { dash: 'dot', width: 2, color: mimsFieldColors[field] || 'black' }
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
    // Restore early download if normalized data exists
    if (earlyDownloadDiv && document.getElementById('normalized-container').style.display === 'block') {
      earlyDownloadDiv.style.display = 'block';
    }
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
  const selectionIds = Object.keys(grouped).map(Number).sort((a, b) => a - b);
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

  const lastSel = selectionIds[selectionIds.length - 1];
  let html = `<div id="regression-accordion">`;

  selectionIds.forEach(sel => {
    const rows = grouped[sel];
    const first = rows[0];
    const startMin = first.start_time.toFixed(2);
    const endMin = first.end_time.toFixed(2);
    const timeExtra = selectedModel === 'HPR40'
      ? ` &nbsp;<small class="text-muted">(${first.start_time_ms} – ${first.end_time_ms} ms)</small>`
      : '';
    const isLast = sel === lastSel;
    const collapseId = `regression-collapse-${sel}`;
    const headingId  = `regression-heading-${sel}`;

    html += `
    <div class="card mb-2 shadow-sm">
      <div class="card-header p-0" id="${headingId}" style="background:#f0f4ff;">
        <button class="btn btn-link btn-block text-left d-flex align-items-center justify-content-between px-3 py-2${isLast ? '' : ' collapsed'}"
                type="button"
                data-toggle="collapse"
                data-target="#${collapseId}"
                aria-expanded="${isLast ? 'true' : 'false'}"
                aria-controls="${collapseId}"
                style="text-decoration:none; color:inherit;">
          <span>
            <strong>Regression coefficients #${sel}</strong>
            <span class="text-muted ml-2" style="font-size:0.88em;">⏱ ${startMin} – ${endMin} min${timeExtra}</span>
          </span>
          <span style="font-size:0.8em;">${isLast ? '▲' : '▼'}</span>
        </button>
      </div>
      <div id="${collapseId}" class="${isLast ? 'collapse show' : 'collapse'}"
           aria-labelledby="${headingId}">
        <div class="card-body p-0">
          <table class="table table-sm table-hover mb-0" style="font-size:0.88em;">
            <thead class="thead-light">
              <tr>
                <th style="width:22%">Signal</th>
                <th>Slope raw data<br><small>(min⁻¹)</small></th>
                <th>R² raw</th>
                <th>Slope normalized data<br><small>(min⁻¹)</small></th>
                <th>R² normalized</th>
              </tr>
            </thead>
            <tbody>`;

    rows.forEach(r => {
      const unit = r.unit ? ` [${r.unit}]` : '';
      html += `
              <tr>
                <td><code>${r.signal}${unit}</code></td>
                <td><code>${slopeStr(r.slopeRaw)}</code></td>
                <td>${r2Badge(r.r2Raw)}</td>
                <td><code>${slopeStr(r.slopeNorm)}</code></td>
                <td>${r2Badge(r.r2Norm)}</td>
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
}

// ======================
// 8) Clear all regression traces from plots
// ======================
function clearRegressionTracesFromPlots() {
  const rawIndicesToRemove = [];
  const normIndicesToRemove = [];
  for (const [sel, idxs] of rawTraceIndicesBySelection) rawIndicesToRemove.push(...idxs);
  for (const [sel, idxs] of normTraceIndicesBySelection) normIndicesToRemove.push(...idxs);
  const validRaw = rawIndicesToRemove.filter(i => Number.isInteger(i) && i >= 0);
  const validNorm = normIndicesToRemove.filter(i => Number.isInteger(i) && i >= 0);
  if (validRaw.length) try { Plotly.deleteTraces('raw-plot-div', validRaw); } catch(e){console.error(e);} else console.log('No raw traces to remove');
  if (validNorm.length) try { Plotly.deleteTraces('normalized-plot-div', validNorm); } catch(e){console.error(e);} else console.log('No norm traces to remove');
  rawTraceIndicesBySelection.clear(); normTraceIndicesBySelection.clear();
}

// ======================
// 9) XLSX export
// ======================
document.getElementById('download-xlsx').addEventListener('click', function() {
  if (!mimsRawData.length) { alert('No data available for export.'); return; }
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: 'MIMS Analysis Results', Author: 'MIMS App', CreatedDate: new Date() };
  const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || 'HPR40';
  const refField = document.getElementById('normalize-by-select').value;

  // Data sheet
  const dataSheet = mimsRawData.map(row => {
    const combinedRow = {};
    // HPR40 uses milliseconds from 'ms' column
    if (selectedModel === 'HPR40') {
        combinedRow['Time (ms)'] = row['ms'];
    } 
    // QMS and MS GAS use seconds from 'Time' column
    else {
        combinedRow['Time (s)'] = row['Time'];
    }

    combinedRow['Time (min)'] = row['min'] !== undefined && row['min'] !== null ? row['min'].toFixed(2) : null;
    mimsYFields.forEach(field => {
      const unit = mimsFieldUnits[field] || '';
      const header = unit ? `${field} [${unit}]` : field;
      combinedRow[header] = row[field];
    });
    // normalized columns (unitless)
    const tpValue = parseFloat(document.getElementById('norm-timepoint').value);
    let refRowIndex = 0, bestDiff = Infinity;
    mimsRawData.forEach((row, i) => {
      const diff = Math.abs((row[mimsXField] || 0) - tpValue);
      if (diff < bestDiff) { bestDiff = diff; refRowIndex = i; }
    });
    const refInitialValue = mimsRawData[refRowIndex][refField];

    mimsYFields.forEach(field => {
      const val = row[field]; const refVal = row[refField];
      const normTitle = `${field}/${refField}_normalized`;
      if (typeof val === 'number' && typeof refVal === 'number' && refVal !== 0) combinedRow[normTitle] = val / (refVal / refInitialValue);
    });
    return combinedRow;
  });
  const dataSheetXLSX = XLSX.utils.json_to_sheet(dataSheet); XLSX.utils.book_append_sheet(wb, dataSheetXLSX, 'Data');

  // Regression sheet
  const regressionSheetData = regressionResults.map(r => {
    const row = {};
    row['Selection #'] = r.selectionId;
    if (selectedModel.includes('HPR40')) { 
        row['Start Time (ms)'] = r.start_time_ms; 
        row['End Time (ms)'] = r.end_time_ms; 
    } else { 
        // Covers both MS GAS and QMS
        row['Start Time (s)'] = r.start_time; 
        row['End Time (s)'] = r.end_time; 
    }
    row['Start Time (min)'] = typeof r.start_time === 'number' ? r.start_time.toFixed(2) : ''; row['End Time (min)'] = typeof r.end_time === 'number' ? r.end_time.toFixed(2) : '';
    row['Signal'] = r.signal; 
    // row['Unit'] = r.unit || 'a.u.';
    row['Slope Raw (per min)'] = typeof r.slopeRaw === 'number' && !Number.isNaN(r.slopeRaw) ? r.slopeRaw : null;
    // row['Slope Raw Unit'] = r.slopeRawUnit || '';
    row['Slope Normalized (per min)'] = typeof r.slopeNorm === 'number' && !Number.isNaN(r.slopeNorm) ? r.slopeNorm : null;
    row['R2 Raw'] = typeof r.r2Raw === 'number' && !Number.isNaN(r.r2Raw) ? r.r2Raw : null;
    row['R2 Normalized'] = typeof r.r2Norm === 'number' && !Number.isNaN(r.r2Norm) ? r.r2Norm : null;
    return row;
  });
  const regressionSheet = XLSX.utils.json_to_sheet(regressionSheetData); XLSX.utils.book_append_sheet(wb, regressionSheet, 'Regression Table');

  const baseName = selectedFile ? selectedFile.name.replace(/\.[^/.]+$/, '') : 'MIMS_Analysis';
  XLSX.writeFile(wb, `${baseName}_analyzed.xlsx`);
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
  document.getElementById('confirm-selection-button').style.display = 'none';
  document.getElementById('clear-regressions-in-table-button').style.display = 'none';
  document.getElementById('xlsx-download-section').style.display = 'none';
  document.getElementById('early-xlsx-download-section').style.display = 'none';
  regressionResults = []; currentZoomRange = null; rawTraceIndicesBySelection.clear(); normTraceIndicesBySelection.clear(); selectionCounter = 0;
  const err = document.getElementById('mims-error-alert'); if (err) err.innerHTML = '';
});

document.getElementById('show-image-button').addEventListener('click', function (ev) {
  ev.preventDefault();
  const errDiv = document.getElementById('mims-error-alert'); if (errDiv) errDiv.innerHTML = '';
  const fileInput = document.getElementById('MIMS_file'); const file = fileInput.files[0];
  if (!file) { if (errDiv) errDiv.innerHTML = `<div class="alert alert-danger">Please select a MIMS file first.</div>`; return; }
const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || '';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isCSV = ext === 'csv'; 
  const isASCI = ext === 'asc' || ext === 'asci';
  
  let valid = false;
  // HPR40 uses CSV
  if (selectedModel.includes('HPR40') && isCSV) valid = true;
  // Both MS GAS and QMS use ASC/ASCI files
  if ((selectedModel.includes('MSGAS') || selectedModel.includes('QMS')) && isASCI) valid = true;
  if (!valid) { if (errDiv) errDiv.innerHTML = `<div class="alert alert-danger">Invalid file type for selected model.</div>`; return; }

  parseMIMSFile(file, function(result) {
    if (!result || !result.data || result.data.length === 0) {
      document.getElementById('mims-error-alert').innerHTML = `<div class="alert alert-danger">No data parsed.</div>`;
      return;
    }
    // store units if parser provided them
    if (result.fieldUnits) Object.assign(mimsFieldUnits, result.fieldUnits);
    plotMIMSData(result);
  });
});