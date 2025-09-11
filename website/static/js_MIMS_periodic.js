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

// ======================
// 2) ASC/ASCI parsing (robust) -> returns { data, fields, xField, yFields }
// ======================
function parseAsciiContent(content) {
  const lines = content.split(/\r?\n/);
  // find header index: line that contains 'Time' and 'Relative [s]' ideally
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (/Time\s+Relative\s*\[s\]/i.test(L) || /Time\s*\[s\]/i.test(L)) { headerIndex = i; break; }
  }
  if (headerIndex === -1) {
    // fallback: line containing 'Time' and 'Concentration' or 'Ion Current' etc.
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

  // split header & channel lines preserving columns
  let headerCols = splitColumnsPreserve(headerLine);
  let channelCols = splitColumnsPreserve(channelLine);
  headerCols = trimTokens(headerCols);
  channelCols = trimTokens(channelCols);

  // pad channelCols to same length as headerCols
  while (channelCols.length < headerCols.length) channelCols.push('');

  // find all Time Relative indices
  const timeRelRegex = /Time\s+Relative\s*\[s\]|Time\s*\[s\]/i;
  const timeIndices = [];
  for (let i = 0; i < headerCols.length; i++) {
    if (timeRelRegex.test(headerCols[i])) timeIndices.push(i);
  }

  // for each timeRelative index pick the nearest measurement column to the right
  const measurementIndices = [];
  timeIndices.forEach(ti => {
    let found = null;
    // look a few columns to the right; measurement usually immediate after Time Relative
    for (let j = ti + 1; j < Math.min(headerCols.length, ti + 6); j++) {
      const c = headerCols[j] || '';
      if (!/\bTime\b/i.test(c) && c.trim() !== '') { found = j; break; }
    }
    if (found !== null) measurementIndices.push(found);
  });

  // fallback: any non-Time columns
  if (measurementIndices.length === 0) {
    for (let i = 0; i < headerCols.length; i++) {
      if (!/\bTime\b/i.test(headerCols[i]) && headerCols[i].trim() !== '') measurementIndices.push(i);
    }
  }

  // unique & sorted
  const uniqMeas = Array.from(new Set(measurementIndices)).sort((a,b) => a - b);

  // Build canonical labels using column index alignment with channelCols
  const labels = []; // objects: { label, colIdx, unit }
  const usedLabels = new Set();
  uniqMeas.forEach(colIdx => {
    const headerLabel = headerCols[colIdx] || `Signal${colIdx}`;
    const unitMatch = headerLabel.match(/\[([^\]]+)\]/);
    const unit = unitMatch ? unitMatch[1].trim() : null;

    // channel label may appear above the block's first column; try same col, then left offsets
    let channelToken = '';
    const leftOffsets = [0, -1, -2, -3];
    for (const off of leftOffsets) {
      const idx = colIdx + off;
      if (idx >= 0 && idx < channelCols.length) {
        const token = channelCols[idx];
        if (token && token.trim() !== '') { channelToken = token.trim(); break; }
      }
    }

    const cleanedHeader = headerLabel.replace(/\s*\[[^\]]+\]/, '').trim();
    let baseLabel = channelToken || cleanedHeader || `Signal${colIdx}`;
    // ensure uniqueness
    const label = ensureUniqueLabel(baseLabel, usedLabels);
    labels.push({ label, colIdx, unit });
    mimsFieldUnits[label] = unit;
  });

  // Parse data rows. For each row choose canonical time as the first available TimeRelative value (scanning timeIndices).
  const data = [];
  for (const line of dataLines) {
    const parts = splitColumnsPreserve(line).map(p => (p === undefined ? '' : String(p).trim()));
    while (parts.length < headerCols.length) parts.push('');
    // find first available time from timeIndices
    let timeVal = null;
    for (const ti of timeIndices) {
      const raw = parts[ti] !== undefined ? parts[ti] : '';
      const parsed = parseNumberStringToFloat(raw);
      if (parsed !== null) { timeVal = parsed; break; }
    }
    // fallback: any 'Time' column
    if (timeVal === null) {
      for (let i = 0; i < headerCols.length; i++) {
        if (/\bTime\b/i.test(headerCols[i])) {
          const parsed = parseNumberStringToFloat(parts[i]);
          if (parsed !== null) { timeVal = parsed; break; }
        }
      }
    }
    if (timeVal === null) continue; // skip line without usable time

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
      if (!/Time\s+Relative\s*\[s\]/i.test(content) && !/Time\s*\[s\]/i.test(content)) {
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

  Plotly.newPlot('raw-plot-div', traces, {
    title: 'Raw MIMS data: Signals vs Time',
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
  yFields.forEach(field => {
    const opt = document.createElement('option');
    const unit = mimsFieldUnits[field];
    opt.value = field;
    opt.textContent = unit ? `${field} [${unit}]` : field;
    normalizeSelect.appendChild(opt);
  });
}

document.getElementById('normalize-button').addEventListener('click', plotNormalizedData);

function plotNormalizedData() {
  const refField = document.getElementById('normalize-by-select').value;
  const data = mimsRawData; const xField = mimsXField; const yFields = mimsYFields;

  const traces = yFields.map(field => {
    const yValues = data.map(row => {
      const val = row[field]; const refVal = row[refField];
      return (typeof val === 'number' && typeof refVal === 'number' && refVal !== 0) ? val / refVal : null;
    });
    const unit = mimsFieldUnits[field] || null; const refUnit = mimsFieldUnits[refField] || null;
    const left = unit ? `${field} [${unit}]` : field; const right = refUnit ? `${refField} [${refUnit}]` : refField;
    return {
      x: data.map(row => row[xField]),
      y: yValues,
      mode: 'lines',
      name: `${left} / ${right}`,
      line: { width: 2, dash: field === refField ? 'dot' : 'solid', color: mimsFieldColors[field] || undefined }
    };
  });

  Plotly.newPlot('normalized-plot-div', traces, {
    title: `Normalized Signals (divided by ${refField})`,
    xaxis: { title: xField === 'min' ? 'Time (min)' : xField },
    yaxis: { title: `Signal / ${refField} (unitless)`, tickformat: '.1e' }
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
      return { x: r[xField], y: (typeof val === 'number' && typeof ref === 'number' && ref !== 0) ? val / ref : null };
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
  if (regressionResults.length === 0) {
    if (tableDiv) tableDiv.innerHTML = '';
    if (downloadDiv) downloadDiv.style.display = 'none';
    return;
  }
  if (downloadDiv) downloadDiv.style.display = 'block';

  const grouped = {};
  regressionResults.forEach(r => { if (!grouped[r.selectionId]) grouped[r.selectionId] = []; grouped[r.selectionId].push(r); });
  const selectionIds = Object.keys(grouped).map(Number).sort((a,b)=>a-b);

  let html = `<table class="table table-striped"><thead><tr>
    <th>Selection #</th><th>Start Time (ms)</th><th>Start Time (min)</th><th>End Time (ms)</th><th>End Time (min)</th>
    <th>Signal</th><th>Unit</th><th>Slope Raw</th><th>Slope Normalized (min<sup>-1</sup>)</th><th>R² Raw</th><th>R² Normalized</th>
  </tr></thead><tbody>`;

  selectionIds.forEach(sel => {
    grouped[sel].forEach(r => {
      const slopeRawStr = typeof r.slopeRaw === 'number' && !Number.isNaN(r.slopeRaw) ? `${r.slopeRaw.toExponential(3)} (${r.slopeRawUnit || 'per min'})` : '-';
      const slopeNormStr = typeof r.slopeNorm === 'number' && !Number.isNaN(r.slopeNorm) ? `${r.slopeNorm.toExponential(3)}` : '-';
      const r2RawStr = typeof r.r2Raw === 'number' && !Number.isNaN(r.r2Raw) ? r.r2Raw.toFixed(4) : '-';
      const r2NormStr = typeof r.r2Norm === 'number' && !Number.isNaN(r.r2Norm) ? r.r2Norm.toFixed(4) : '-';

      html += `<tr>
        <td>${r.selectionId}</td>
        <td>${r.start_time_ms}</td>
        <td>${r.start_time.toFixed(2)}</td>
        <td>${r.end_time_ms}</td>
        <td>${r.end_time.toFixed(2)}</td>
        <td>${r.signal}</td>
        <td>${r.unit || 'a.u.'}</td>
        <td>${slopeRawStr}</td>
        <td>${slopeNormStr}</td>
        <td>${r2RawStr}</td>
        <td>${r2NormStr}</td>
      </tr>`;
    });
  });

  html += '</tbody></table>';
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
  const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || 'HPR40 (Hiden Analytical)';
  const refField = document.getElementById('normalize-by-select').value;

  // Data sheet
  const dataSheet = mimsRawData.map(row => {
    const combinedRow = {};
    if (selectedModel === 'HPR40 (Hiden Analytical)') combinedRow['Time (ms)'] = row['ms'];
    else if (selectedModel === 'MS GAS (Photon System Instruments)') combinedRow['Time (s)'] = row['Time'];
    combinedRow['Time (min)'] = row['min'] !== undefined && row['min'] !== null ? row['min'].toFixed(2) : null;
    mimsYFields.forEach(field => {
      const unit = mimsFieldUnits[field] || '';
      const header = unit ? `${field} [${unit}]` : field;
      combinedRow[header] = row[field];
    });
    // normalized columns (unitless)
    mimsYFields.forEach(field => {
      const val = row[field]; const refVal = row[refField];
      const normTitle = `${field}/${refField}_normalized`;
      if (typeof val === 'number' && typeof refVal === 'number' && refVal !== 0) combinedRow[normTitle] = val / refVal; else combinedRow[normTitle] = null;
    });
    return combinedRow;
  });
  const dataSheetXLSX = XLSX.utils.json_to_sheet(dataSheet); XLSX.utils.book_append_sheet(wb, dataSheetXLSX, 'Data');

  // Regression sheet
  const regressionSheetData = regressionResults.map(r => {
    const row = {};
    row['Selection #'] = r.selectionId;
    if (selectedModel === 'HPR40 (Hiden Analytical)') { row['Start Time (ms)'] = r.start_time_ms; row['End Time (ms)'] = r.end_time_ms; }
    else if (selectedModel === 'MS GAS (Photon System Instruments)') { row['Start Time (s)'] = r.start_time; row['End Time (s)'] = r.end_time; }
    row['Start Time (min)'] = typeof r.start_time === 'number' ? r.start_time.toFixed(2) : ''; row['End Time (min)'] = typeof r.end_time === 'number' ? r.end_time.toFixed(2) : '';
    row['Signal'] = r.signal; 
    row['Unit'] = r.unit || 'a.u.';
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
// 10) UI wiring for file & show
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
  regressionResults = []; currentZoomRange = null; rawTraceIndicesBySelection.clear(); normTraceIndicesBySelection.clear(); selectionCounter = 0;
  const err = document.getElementById('mims-error-alert'); if (err) err.innerHTML = '';
});

document.getElementById('show-image-button').addEventListener('click', function (ev) {
  ev.preventDefault();
  const errDiv = document.getElementById('mims-error-alert'); if (errDiv) errDiv.innerHTML = '';
  const fileInput = document.getElementById('MIMS_file'); const file = fileInput.files[0];
  if (!file) { if (errDiv) errDiv.innerHTML = `<div class="alert alert-danger">Please select a MIMS file first.</div>`; return; }
  const selectedModel = (document.querySelector('select[name="MIMS_model"]') || {}).value || 'MS GAS (Photon System Instruments)';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isCSV = ext === 'csv'; const isASCI = ext === 'asc' || ext === 'asci';
  let valid = false;
  if (selectedModel.includes('HPR40') && isCSV) valid = true;
  if (selectedModel.includes('MS GAS') && isASCI) valid = true;
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
