// ============================================================
//  CyanoTools OJIP Analyzer — frontend logic
//  Chart.js 4.x + chartjs-chart-error-bars
// ============================================================

// ── state ─────────────────────────────────────────────────────────────────
var ojipData  = null;   // full JSON from /api/ojip_process (var so window.ojipData is accessible from other scripts)
var paramData = {};     // {filename: {FVFM, VJ, ...}} — recalculated per sample (var so window.paramData is accessible)
let groups    = {};     // {filename: groupName}
let chartInst = {};     // {chartId: Chart instance}
let dirtyTabs = new Set(); // tabs whose charts need rendering on first visit
let fjfiMode  = 'default'; // 'default' (2/30 ms) or 'auto' (derivative-detected)

// ── multi-curve state (M2-M6) ───────────────────────────────────────────
var mcDataset      = null;   // parsed multi-curve file (see MC.parse)
var paramMatrix    = null;   // [{slot,name,...params}, ...] from batch pass
var mcTimeMs       = null;   // shared time axis in ms (from mcDataset)
var mcDetailCache  = {};     // LRU: {name: {curves, time_raw_ms, time_log_ms, ...}}
const MC_DETAIL_MAX = 10;    // max cached detail curves
var mcAbort        = null;   // AbortController for cancel
var mcIsActive     = false;  // true when a multi-curve dataset is loaded
var _lastSelected  = [];     // curve indices from last mcStartAnalysis (for batch refit)
var _lastJipOpts   = {};     // jipOpts from last mcStartAnalysis (for batch refit)
var _currentDetailSlot = null; // paramMatrix slot shown in Diagnostics (for param writeback)

// White background plugin for Chart.js (avoids transparent canvas)
const _ojipWhiteBgPlugin = {
  id: 'whiteBg',
  beforeDraw(chart) {
    const ctx = chart.ctx;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, chart.width, chart.height);
    ctx.restore();
  },
};

// ═══════════════════════════════════════════════════════════════════════
//  MULTI-CURVE MODULE  (M2 parser, M3 orchestrator, M4 time-series,
//                       M5 detail-on-demand, M6 visualization)
// ═══════════════════════════════════════════════════════════════════════
const MC = (() => {
  'use strict';

  // ── M2: Client-side multi-curve file parser ──────────────────────────
  function parse(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(_parseText(reader.result, file.name)); }
        catch(e) { reject(e); }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  function _parseText(text, filename) {
    const lines = text.split(/\r?\n/);
    if (lines.length < 10)
      throw new Error('File too short to be a multi-curve FluorPen file');

    // Find the "index" row — usually line index 5 but scan first 10 lines
    let indexLineIdx = -1;
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i].startsWith('index\t')) { indexLineIdx = i; break; }
    }
    if (indexLineIdx < 0) return null; // not a multi-curve file

    // Strip trailing empty columns (single-curve files often have trailing tabs)
    const indexParts = lines[indexLineIdx].split('\t');
    while (indexParts.length > 1 && indexParts[indexParts.length - 1].trim() === '') indexParts.pop();
    const curveCount = indexParts.length - 1;
    if (curveCount < 2) return null; // only 1 column → single-curve

    // Parse timestamps (row after index)
    const timeParts = lines[indexLineIdx + 1].split('\t');
    const timestamps = timeParts.slice(1);

    // Parse protocol IDs (row after time)
    const idParts = lines[indexLineIdx + 2].split('\t');
    const protocols = idParts.slice(1);

    // Parse data rows (numeric first column)
    const timeUs = [];
    const dataMatrix = []; // dataMatrix[row][col]
    const dataStart = indexLineIdx + 3;

    // Known footer labels — stop parsing data when we hit one
    const FOOTER_LABELS = new Set([
      'Bckg','Fo','Fj','Fi','Fm','Fv','Vj','Vi','Fm/Fo','Fv/Fo','Fv/Fm',
      'Mo','Area','Fix Area','HACH Area','Sm','Ss','N',
      'Phi_Po','Psi_o','Phi_Eo','Phi_Do','Phi_Pav','Pi_Abs',
      'ABS/RC','TRo/RC','ETo/RC','DIo/RC',
      'FLASH-Wavelength [nm]','FLASH-Percent [%]','FLASH-Intensity [uE]',
      'SUPER-Wavelength [nm]','SUPER-Percent [%]','SUPER-Intensity [uE]',
      'ACTINIC-Wavelength [nm]','ACTINIC-Percent [%]','ACTINIC-Intensity [uE]',
      'description',
    ]);

    const footerData = {};
    let inData = true;

    for (let i = dataStart; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const parts = line.split('\t');
      const label = parts[0].trim();

      if (inData && /^\d+$/.test(label)) {
        timeUs.push(parseInt(label, 10));
        const row = new Float64Array(curveCount);
        for (let c = 0; c < curveCount; c++) {
          row[c] = parseFloat(parts[c + 1]) || 0;
        }
        dataMatrix.push(row);
      } else {
        inData = false;
        if (FOOTER_LABELS.has(label)) {
          footerData[label] = parts.slice(1);
        }
      }
    }

    // Extract instrument metadata from footer
    const _fval = (key, idx) => {
      const arr = footerData[key];
      if (!arr || !arr[idx]) return null;
      const v = parseFloat(arr[idx]);
      return (isNaN(v) || !isFinite(v)) ? null : v;
    };
    const instrumentMeta = {
      flash_wavelength_nm:   _fval('FLASH-Wavelength [nm]', 0),
      flash_percent:         _fval('FLASH-Percent [%]', 0),
      flash_intensity_uE:    _fval('FLASH-Intensity [uE]', 0),
      super_wavelength_nm:   _fval('SUPER-Wavelength [nm]', 0),
      super_percent:         _fval('SUPER-Percent [%]', 0),
      super_intensity_uE:    _fval('SUPER-Intensity [uE]', 0),
      actinic_wavelength_nm: _fval('ACTINIC-Wavelength [nm]', 0),
      actinic_percent:       _fval('ACTINIC-Percent [%]', 0),
      actinic_intensity_uE:  _fval('ACTINIC-Intensity [uE]', 0),
    };

    // Per-curve instrument background (Bckg) and Fo from the footer, aligned to
    // the data columns. Used to correct the ~11 µs background point server-side.
    const _bckgArr = footerData['Bckg'] || null;
    const _foArr   = footerData['Fo']   || null;
    const _footVal = (arr, i) => {
      if (!arr || arr[i] === undefined) return null;
      const v = parseFloat(arr[i]);
      return (isNaN(v) || !isFinite(v)) ? null : v;
    };

    const stem = filename.replace(/\.[^.]+$/, '');

    // Parse FluorPen timestamp "H:MM:SS  D.M.YYYY" → epoch ms
    function _parseTS(ts) {
      if (!ts) return NaN;
      const m = ts.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})\s+(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (!m) return NaN;
      return new Date(+m[6], +m[5] - 1, +m[4], +m[1], +m[2], +m[3]).getTime();
    }

    // Build curves array
    const curves = [];
    for (let c = 0; c < curveCount; c++) {
      if (protocols[c] && protocols[c].trim().toUpperCase() !== 'OJIP') continue;
      const values = new Float64Array(timeUs.length);
      for (let r = 0; r < timeUs.length; r++) values[r] = dataMatrix[r][c];
      curves.push({
        index: c,
        colIndex: c + 1,
        timestamp: (timestamps[c] || '').trim(),
        epochMs: _parseTS((timestamps[c] || '').trim()),
        protocol: (protocols[c] || '').trim(),
        values: values,
        bckg: _footVal(_bckgArr, c),
        foFooter: _footVal(_foArr, c),
      });
    }

    return {
      fluorometer: 'Aquapen',
      filename: filename,
      stem: stem,
      timeUs: new Float64Array(timeUs),
      curves: curves,
      totalColumns: curveCount,
      instrumentMeta: instrumentMeta,
    };
  }

  // ── M2: Detection — called when files are selected ───────────────────
  function isMultiCurve(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const lines = reader.result.split(/\r?\n/);
        for (let i = 0; i < Math.min(10, lines.length); i++) {
          if (lines[i].startsWith('index\t')) {
            // Filter out empty trailing columns (single-curve files have trailing tabs)
            const cols = lines[i].split('\t').filter(s => s.trim() !== '');
            // Need at least 3 non-empty columns: "index" + 2+ curve indices
            if (cols.length > 2) { resolve(true); return; }
          }
        }
        resolve(false);
      };
      reader.onerror = () => resolve(false);
      reader.readAsText(file.slice(0, 8192)); // only read first 8KB for detection
    });
  }

  // ── M2: Selection modal logic ────────────────────────────────────────
  function showSelectionModal(dataset) {
    const modal   = document.getElementById('mc-selection-modal');
    const tbody   = document.getElementById('mc-curve-tbody');
    const countEl = document.getElementById('mc-curve-count');
    const selEl   = document.getElementById('mc-selected-count');
    const dateEl  = document.getElementById('mc-date-range');
    const fileEl  = document.getElementById('mc-filename');
    const headerEl = document.getElementById('mc-table-header');
    const filtersEl = document.getElementById('mc-excel-filters');
    const namingRow = document.getElementById('mc-naming')?.closest('.form-group');

    fileEl.textContent = dataset.filename;
    countEl.textContent = dataset.curves.length;

    // Reset to FluorPen layout (undo any Excel-specific changes)
    if (filtersEl) filtersEl.style.display = 'none';
    if (namingRow) namingRow.style.display = '';
    const exOpts = document.getElementById('excel-options');
    if (exOpts) exOpts.style.display = 'none';
    if (headerEl) {
      headerEl.innerHTML =
        `<th style="width:30px;"><input type="checkbox" checked onchange="this.checked ? MC.selectAll() : MC.deselectAll()"></th>` +
        `<th style="width:50px;">#</th>` +
        `<th>Timestamp</th>` +
        `<th>Protocol</th>`;
    }

    // Date range
    const ts = dataset.curves.map(c => c.timestamp).filter(Boolean);
    dateEl.textContent = ts.length >= 2
      ? `${ts[0]}  —  ${ts[ts.length - 1]}`
      : (ts[0] || 'N/A');

    // Build table rows
    tbody.innerHTML = '';
    for (const c of dataset.curves) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><input type="checkbox" class="mc-curve-cb" data-idx="${c.index}" checked></td>` +
        `<td>${c.index + 1}</td>` +
        `<td class="small">${c.timestamp}</td>` +
        `<td>${c.protocol}</td>`;
      tbody.appendChild(tr);
    }
    _updateSelCount();

    // Show modal
    $(modal).modal('show');
  }

  function _updateSelCount() {
    const cbs = document.querySelectorAll('.mc-curve-cb');
    const checked = document.querySelectorAll('.mc-curve-cb:checked');
    const selEl = document.getElementById('mc-selected-count');
    const warnEl = document.getElementById('mc-limit-warn');
    selEl.textContent = `${checked.length} of ${cbs.length}`;
    if (warnEl) warnEl.style.display = checked.length > 2000 ? '' : 'none';
  }

  function selectAll()   { document.querySelectorAll('.mc-curve-cb').forEach(cb => cb.checked = true);  _updateSelCount(); }
  function deselectAll() { document.querySelectorAll('.mc-curve-cb').forEach(cb => cb.checked = false); _updateSelCount(); }

  function selectRange() {
    const from = parseInt(document.getElementById('mc-range-from').value, 10) || 1;
    const to   = parseInt(document.getElementById('mc-range-to').value, 10) || 0;
    document.querySelectorAll('.mc-curve-cb').forEach(cb => {
      const idx = parseInt(cb.dataset.idx, 10) + 1; // 1-based for user
      cb.checked = idx >= from && idx <= to;
    });
    _updateSelCount();
  }

  function getSelectedIndices() {
    return [...document.querySelectorAll('.mc-curve-cb:checked')].map(cb => parseInt(cb.dataset.idx, 10));
  }

  function getNamingScheme() {
    return document.getElementById('mc-naming')?.value || 'timestamp';
  }

  function getCurveName(curve, dataset, scheme) {
    // Excel datasets use pre-built curve names from the parseExcel step
    if (dataset.fluorometer === 'OJIPImaging' && curve.curveName) return curve.curveName;
    if (scheme === 'timestamp')      return curve.timestamp || `${curve.index + 1}`;
    if (scheme === 'filename_index') return `${dataset.stem}_${String(curve.index + 1).padStart(3, '0')}`;
    return `${curve.index + 1}`; // 'index'
  }

  // Cache of selected indices so _slotToIndex works after modal is closed
  let _selIndicesCache = [];

  // ── M3: Batch orchestrator ───────────────────────────────────────────
  async function runParamsPass(dataset, selectedIndices, jipOpts) {
    _selIndicesCache = selectedIndices.slice(); // cache for later use
    const BATCH  = 30;
    const CONC   = 3;
    const scheme = getNamingScheme();

    // Build curve entries with named slots
    const allCurves = selectedIndices.map((idx, slot) => {
      const c = dataset.curves.find(x => x.index === idx);
      return {
        slot: slot,
        name: getCurveName(c, dataset, scheme),
        values: Array.from(c.values),
        bckg: (c.bckg != null ? c.bckg : null),
        fo_footer: (c.foFooter != null ? c.foFooter : null),
      };
    });

    const batches = [];
    for (let i = 0; i < allCurves.length; i += BATCH) {
      batches.push(allCurves.slice(i, i + BATCH));
    }

    paramMatrix = new Array(allCurves.length);
    mcAbort = new AbortController();
    let done = 0;

    _showProgress(0, allCurves.length);

    let cursor = 0;
    async function worker() {
      while (cursor < batches.length) {
        if (mcAbort.signal.aborted) return;
        const batchIdx = cursor++;
        const batch = batches[batchIdx];
        const body = {
          fluorometer: dataset.fluorometer,
          time_native: Array.from(dataset.timeUs),
          curves: batch,
          FJ_time: jipOpts.FJ_time,
          FI_time: jipOpts.FI_time,
          knots_reduction_factor: jipOpts.kr,
          fit_method: jipOpts.fitMethod || 'logspline',
          trim_first: jipOpts.trimFirst || 0,
          trim_last:  jipOpts.trimLast  || 0,
          background_mode: jipOpts.bgMode || 'auto',
          background_n:    jipOpts.bgN || 1,
          f0_source:       jipOpts.f0Source || 'instrument',
          knot_placement:  jipOpts.knotPlacement || 'hybrid',
          oj_densify:      jipOpts.ojDensify || false,
          oj_tau_ms:       jipOpts.ojTauMs || null,
          f0_time_ms:      jipOpts.f0TimMs || null,
          include_curves: false,
        };

        let res;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const resp = await fetch('/api/ojip_process_batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
              signal: mcAbort.signal,
            });
            res = await resp.json();
            break;
          } catch(e) {
            if (mcAbort.signal.aborted) return;
            if (attempt === 1) {
              // Mark entire batch as errored
              for (const c of batch) {
                paramMatrix[c.slot] = { slot: c.slot, name: c.name, error: e.message };
              }
              done += batch.length;
              _showProgress(done, allCurves.length);
              return;
            }
            await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000));
          }
        }

        if (res && res.results) {
          for (const r of res.results) paramMatrix[r.slot] = r;
        }
        done += batch.length;
        _showProgress(done, allCurves.length);
        _appendTimeSeriesPoints(res?.results || []);
      }
    }

    await Promise.all(Array.from({ length: CONC }, () => worker()));

    if (mcAbort.signal.aborted) return null;
    _hideProgress();
    return paramMatrix;
  }

  function cancelBatch() {
    if (mcAbort) mcAbort.abort();
    _hideProgress();
  }

  // ── M3: Progress bar ────────────────────────────────────────────────
  function _showProgress(done, total) {
    const wrap = document.getElementById('mc-progress-wrap');
    const bar  = document.getElementById('mc-progress-bar');
    const lbl  = document.getElementById('mc-progress-label');
    if (!wrap) return;
    wrap.style.display = '';
    const pct = Math.round((done / total) * 100);
    bar.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', pct);
    lbl.textContent = `Analyzing ${done} / ${total} curves`;
  }

  function _hideProgress() {
    const wrap = document.getElementById('mc-progress-wrap');
    if (wrap) wrap.style.display = 'none';
  }

  // ── M4: Time-series overview ─────────────────────────────────────────
  function renderTimeSeries() {
    if (!paramMatrix) return;

    const container = document.getElementById('tab-timeseries');
    if (!container) return;

    // Build the parameter-vs-time chart
    _renderParamTimeChart();
    // Build the virtualized parameter table
    _renderParamTable();
    // Refresh summary table if visible
    const summaryWrap = document.getElementById('mc-summary-table-wrap');
    if (summaryWrap && summaryWrap.style.display !== 'none') {
      _renderSummaryTable();
    }
  }

  function _appendTimeSeriesPoints(results) {
    // Incremental draw during batch pass — update the param-time chart live
    const chart = chartInst['mc-param-time-chart'];
    if (!chart || !results.length) return;

    const paramKey = document.getElementById('mc-param-picker')?.value || 'FVFM';
    const useTimestamps = document.getElementById('mc-time-axis-ts')?.checked;
    for (const r of results) {
      if (r.error) continue;
      const val = r[paramKey];
      if (val == null) continue;
      const xVal = useTimestamps ? _slotEpochMs(r.slot) : r.slot;
      if (useTimestamps && isNaN(xVal)) continue;
      chart.data.datasets[0].data.push({ x: xVal, y: val });
    }
    chart.update('none'); // no animation for live update
  }

  // Build a slot→epochMs lookup from the parsed dataset
  function _slotEpochMs(slot) {
    if (!mcDataset) return NaN;
    const idx = _slotToIndex(slot);
    const c = mcDataset.curves.find(x => x.index === idx);
    return c ? c.epochMs : NaN;
  }

  // Metadata lookup: get Excel metadata for a given slot
  function _slotMeta(slot) {
    if (!mcDataset) return null;
    const idx = _slotToIndex(slot);
    return mcDataset.curves.find(x => x.index === idx) || null;
  }

  // Convert metadata field value to a numeric x-axis value
  function _metaToX(meta, field) {
    if (!meta) return NaN;
    const v = meta[field];
    if (field === 'hours' && typeof v === 'string') {
      // "HH:MM" → minutes since midnight
      const parts = v.split(':');
      return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
    }
    if (field === 'day' && typeof v === 'string') {
      // "D1" → 1, "D2" → 2, etc.
      const m = v.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : NaN;
    }
    return NaN;
  }

  // X-axis label for metadata field
  function _metaXLabel(field) {
    if (field === 'hours') return 'Hour of day';
    if (field === 'day')   return 'Day (replicate)';
    return 'Curve index';
  }

  // X-axis tick formatter for metadata fields
  function _metaXTickCallback(field) {
    if (field === 'hours') {
      return function(val) {
        const h = Math.floor(val / 60);
        const m = val % 60;
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
      };
    }
    if (field === 'day') {
      return function(val) { return 'D' + val; };
    }
    return undefined;
  }

  // ── Low-quality curve flagging ───────────────────────────────────────
  // Two INDEPENDENT quality axes (see .claude/docs/ojip.md): fit quality (R²)
  // and timing confidence (min of the FJ/FI/FP *_conf fields). Both flags are
  // computed HERE, in the frontend, straight from the raw per-curve diagnostics
  // (fit_r2, *_conf) so the user can tune the two cutoffs live and watch the
  // flags update — the scientist looking at the curves is the best judge of
  // where "actually bad" begins. They are tracked & badged separately: a poor
  // spline fit does not mean the J/I/P timings are wrong, and vice-versa.
  const R2_THRESH_DEFAULT   = 0.90;
  const CONF_THRESH_DEFAULT = 0.15;

  // "Show only flagged" filter state for the parameter table (persists
  // across re-renders since _renderParamTable rebuilds its own innerHTML).
  let _showOnlyFlagged = false;

  // User-tunable cutoffs (read from the Time-series controls, with defaults).
  function _r2Thresh() {
    const v = parseFloat(document.getElementById('mc-fit-r2-thresh')?.value);
    return isNaN(v) ? R2_THRESH_DEFAULT : v;
  }
  function _confThresh() {
    const v = parseFloat(document.getElementById('mc-conf-thresh')?.value);
    return isNaN(v) ? CONF_THRESH_DEFAULT : v;
  }

  // Lowest of the three per-phase timing confidences (null-safe → 0).
  function _confMin(r) {
    return Math.min(r.FJ_conf ?? 0, r.FI_conf ?? 0, r.FP_conf ?? 0);
  }
  // Fit flag: R² below the cutoff (falls back to the backend fit_flag for PCHIP,
  // which reports roughness instead of R² so fit_r2 is null).
  function _fitPoor(r) {
    if (!r || r.error) return false;
    return r.fit_r2 != null ? r.fit_r2 < _r2Thresh() : r.fit_flag === 'poor';
  }
  function _confPoor(r) { return !!r && !r.error && _confMin(r) < _confThresh(); }
  // Flagged on either axis — used by the table row filter / count.
  function _isPoorCurve(r) { return _fitPoor(r) || _confPoor(r); }

  // Distinct plot/badge styles for the two flag axes — both are ALWAYS drawn in
  // the time-series plot (no mode selector) so a curve flagged on either axis
  // stands out, and the two are visually separable: amber circle = low timing
  // confidence, red triangle = poor fit. A curve flagged on both gets both marks.
  // Muted colours (match the flag-panel markers) so flags read as gentle review
  // hints, not alarms — conf ● amber-tan, fit ▲ soft brick.
  const FLAG_STYLES = {
    conf: { color: '#b8923f', pointStyle: 'circle',   label: '● low confidence', test: _confPoor },
    fit:  { color: '#b06a62', pointStyle: 'triangle', label: '▲ poor fit',       test: _fitPoor  },
  };

  // Whether a flag overlay is shown in the plot (per-axis checkbox; on by default).
  function _showFlag(key) {
    const el = document.getElementById(key === 'fit' ? 'mc-show-flag-fit' : 'mc-show-flag-conf');
    return el ? el.checked : true;
  }

  // Re-render everything that depends on the flag cutoffs. Debounced because a
  // full re-render (Chart.js rebuild + up to ~2000-row table) is heavy and the
  // inputs fire on every keystroke / spinner click — without this, rapid changes
  // queue up and the UI feels frozen. Runs ~180 ms after the last change.
  let _flagThreshTimer = null;
  function _onFlagThresholdChange() {
    if (_flagThreshTimer) clearTimeout(_flagThreshTimer);
    _flagThreshTimer = setTimeout(() => {
      _flagThreshTimer = null;
      renderTimeSeries();
      if (paramMatrix && typeof _updateBatchQualityAlerts === 'function') {
        _updateBatchQualityAlerts(paramMatrix);
      }
    }, 180);
  }

  function _renderParamTimeChart() {
    const paramKey = document.getElementById('mc-param-picker')?.value || 'FVFM';
    const useTimestamps = document.getElementById('mc-time-axis-ts')?.checked;
    const colorBy = document.getElementById('mc-color-by')?.value || '';
    const xAxisField = document.getElementById('mc-x-axis')?.value || 'index';
    const isExcel = mcDataset?.fluorometer === 'OJIPImaging';
    const isGrouped = isExcel && colorBy;

    destroyChart('mc-param-time-chart');
    const canvas = document.getElementById('mc-param-time-chart');
    if (!canvas) return;

    const label = PARAM_LABELS[paramKey] || paramKey;

    if (isGrouped) {
      // ── Grouped mode: one dataset per unique value of colorBy field ──
      const groupMap = new Map(); // groupValue → [{x, y, _slot}, ...]

      for (const r of paramMatrix) {
        if (!r || r.error) continue;
        const val = r[paramKey];
        if (val == null) continue;
        const meta = _slotMeta(r.slot);
        if (!meta) continue;

        const groupVal = meta[colorBy] || 'unknown';
        const xVal = xAxisField === 'index' ? r.slot : _metaToX(meta, xAxisField);
        if (isNaN(xVal)) continue;

        if (!groupMap.has(groupVal)) groupMap.set(groupVal, []);
        groupMap.get(groupVal).push({ x: xVal, y: val, _slot: r.slot });
      }

      // Sort groups for consistent ordering
      const sortedGroups = [...groupMap.keys()].sort();
      const n = sortedGroups.length;

      // ── Jitter ──
      const jitterPct = parseInt(document.getElementById('mc-jitter')?.value || '0', 10);
      let jitterWidth = 0;
      if (jitterPct > 0) {
        const allXvals = new Set();
        for (const pts of groupMap.values()) pts.forEach(p => allXvals.add(p.x));
        const sortedX = [...allXvals].sort((a, b) => a - b);
        let minGap = Infinity;
        for (let i = 1; i < sortedX.length; i++) {
          const gap = sortedX[i] - sortedX[i - 1];
          if (gap > 0) minGap = Math.min(minGap, gap);
        }
        if (!isFinite(minGap)) minGap = 1;
        jitterWidth = (minGap * 0.8) * (jitterPct / 100);
      }
      // Deterministic seeded PRNG (mulberry32) — prevents "dancing" on re-render
      function _jitterRng(seed) {
        let t = (seed + 0x6D2B79F5) | 0;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      }

      // ── Read mean ± SD options ──
      const showMeanSD = document.getElementById('mc-show-mean-sd')?.checked;
      const fadeRaw = document.getElementById('mc-fade-raw')?.checked;

      // ── Build scatter datasets ──
      const datasets = sortedGroups.map((gv, gi) => {
        const points = groupMap.get(gv);
        points.sort((a, b) => a.x - b.x);
        const isFaded = showMeanSD && fadeRaw;
        const color = isFaded ? sampleColor(gi, n, 0.2) : sampleColor(gi, n);
        const colorA = isFaded ? sampleColor(gi, n, 0.15) : sampleColor(gi, n, 0.65);
        return {
          label: gv,
          data: points.map(p => ({
            x: p.x + (jitterWidth > 0 ? (_jitterRng(p._slot * 7 + gi) - 0.5) * jitterWidth : 0),
            y: p.y,
          })),
          _slots: points.map(p => p._slot),
          pointRadius: isFaded ? 2 : 3,
          pointHoverRadius: 6,
          borderColor: color,
          backgroundColor: colorA,
          _fullColor: sampleColor(gi, n),
          _fullColorBg: sampleColor(gi, n, 0.65),
          showLine: false,
          borderWidth: 1,
          order: 10, // raw points behind overlays
        };
      });

      // ── Mean ± SD overlay ──
      if (showMeanSD) {
        sortedGroups.forEach((gv, gi) => {
          const points = groupMap.get(gv);
          // Group by original (non-jittered) x value
          const byX = new Map();
          for (const p of points) {
            if (!byX.has(p.x)) byX.set(p.x, []);
            byX.get(p.x).push(p.y);
          }
          const sortedXKeys = [...byX.keys()].sort((a, b) => a - b);
          const color = sampleColor(gi, n);

          const meanLineData = [];
          const errorBarData = [];

          for (const xVal of sortedXKeys) {
            const vals = byX.get(xVal);
            const count = vals.length;
            const mean = vals.reduce((s, v) => s + v, 0) / count;
            // Sample SD (n-1 denominator) for biological replicates
            const sd = count > 1
              ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (count - 1))
              : 0;
            meanLineData.push({ x: xVal, y: mean });
            errorBarData.push({ x: xVal, y: mean, yMin: mean - sd, yMax: mean + sd, _n: count, _sd: sd });
          }

          // Connected mean line
          datasets.push({
            label: '',
            data: meanLineData,
            showLine: true,
            pointRadius: 0,
            borderColor: color,
            backgroundColor: 'transparent',
            borderWidth: 2.5,
            order: -2,
            _isMeanOverlay: true,
            _groupLabel: gv,
          });

          // Error bar points (scatterWithErrorBars)
          datasets.push({
            type: 'scatterWithErrorBars',
            label: '',
            data: errorBarData,
            pointRadius: 5,
            pointStyle: 'circle',
            borderColor: color,
            backgroundColor: sampleColor(gi, n, 0.8),
            borderWidth: 1.5,
            showLine: false,
            errorBarColor: color,
            errorBarWhiskerColor: color,
            errorBarLineWidth: 1.5,
            errorBarWhiskerSize: 6,
            order: -1,
            _isMeanOverlay: true,
            _groupLabel: gv,
          });
        });
      }

      // ── Flag overlays: one per axis, always both, distinct hollow marks ──
      // Mark each flagged point at its actual (jittered) position so flagged
      // curves stand out in context. conf = amber circle, fit = red triangle;
      // a curve flagged on both gets both marks.
      for (const key of ['conf', 'fit']) {
        if (!_showFlag(key)) continue;
        const style = FLAG_STYLES[key];
        const fData = [];
        const fSlots = [];
        sortedGroups.forEach((gv, gi) => {
          for (const p of groupMap.get(gv)) {
            if (!style.test(paramMatrix[p._slot])) continue;
            const jx = p.x + (jitterWidth > 0 ? (_jitterRng(p._slot * 7 + gi) - 0.5) * jitterWidth : 0);
            fData.push({ x: jx, y: p.y });
            fSlots.push(p._slot);
          }
        });
        if (!fData.length) continue;
        datasets.push({
          label: style.label,
          data: fData,
          _slots: fSlots,
          _isFlagOverlay: true,
          pointStyle: style.pointStyle,
          pointRadius: key === 'fit' ? 4.5 : 3.5,
          pointHoverRadius: 7,
          borderColor: style.color,
          borderWidth: 1.2,
          backgroundColor: 'transparent',
          showLine: false,
          order: -3, // on top of raw points and mean/SD overlays
        });
      }

      // X-axis config
      const xScale = {
        type: 'linear',
        title: { display: true, text: _metaXLabel(xAxisField), font: { size: 12 } },
        ticks: {
          maxTicksLimit: 20,
          callback: _metaXTickCallback(xAxisField),
        },
      };

      chartInst['mc-param-time-chart'] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          scales: { x: xScale, y: { title: { display: true, text: label, font: { size: 12 } } } },
          plugins: {
            legend: {
              display: n <= 25,
              position: 'right',
              onClick: (e, legendItem, legend) => {
                const chart = legend.chart;
                const idx = legendItem.datasetIndex;
                const ds = chart.data.datasets[idx];
                const nowVisible = !chart.isDatasetVisible(idx);
                chart.setDatasetVisibility(idx, nowVisible);
                // Also toggle associated mean±SD overlays
                const grp = ds.label;
                chart.data.datasets.forEach((d, i) => {
                  if (d._isMeanOverlay && d._groupLabel === grp)
                    chart.setDatasetVisibility(i, nowVisible);
                });
                chart.update();
              },
              labels: {
                usePointStyle: true, pointStyle: 'circle', boxWidth: 8, font: { size: 11 },
                generateLabels: (chart) => {
                  const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
                  return items.filter(l => l.text !== '').map(l => {
                    const ds = chart.data.datasets[l.datasetIndex];
                    if (ds._fullColor) {
                      l.strokeStyle = ds._fullColor;
                      l.fillStyle = ds._fullColorBg;
                    }
                    return l;
                  });
                },
              },
            },
            tooltip: {
              callbacks: {
                title: (items) => {
                  if (!items.length) return '';
                  const ds = datasets[items[0].datasetIndex];
                  if (ds._isMeanOverlay) {
                    const pt = ds.data[items[0].dataIndex];
                    const tickCb = _metaXTickCallback(xAxisField);
                    const xLabel = tickCb ? tickCb(pt.x) : pt.x;
                    return `${ds._groupLabel} @ ${xLabel}`;
                  }
                  const di = items[0].dataIndex;
                  const slot = ds._slots?.[di];
                  return slot != null && paramMatrix[slot] ? paramMatrix[slot].name : ds.label;
                },
                label: (item) => {
                  const ds = datasets[item.datasetIndex];
                  if (ds._isMeanOverlay && item.raw.yMin != null) {
                    const mean = item.raw.y;
                    const sd = item.raw._sd != null ? item.raw._sd : (item.raw.yMax - item.raw.y);
                    const nn = item.raw._n || '';
                    return `Mean: ${mean.toPrecision(4)} \u00b1 ${sd.toPrecision(3)} (n=${nn})`;
                  }
                  return `${ds.label}: ${item.parsed.y.toPrecision(5)}`;
                },
              },
            },
          },
          onClick: (evt, elems) => {
            if (elems.length) {
              const ds = datasets[elems[0].datasetIndex];
              if (ds._isMeanOverlay) return; // don't navigate for mean/SD points
              const di = elems[0].index;
              const slot = ds._slots?.[di];
              if (slot != null) fetchAndShowDetail(slot);
            }
          },
        },
        plugins: [_ojipWhiteBgPlugin],
      });

    } else {
      // ── Ungrouped mode: single series + one overlay per flag axis ──
      const data = [];
      const slotLookup = [];
      const flag = { conf: { data: [], slots: [] }, fit: { data: [], slots: [] } };
      for (const r of paramMatrix) {
        if (!r || r.error) continue;
        const val = r[paramKey];
        if (val == null) continue;
        const xVal = useTimestamps ? _slotEpochMs(r.slot) : r.slot;
        if (useTimestamps && isNaN(xVal)) continue;
        data.push({ x: xVal, y: val });
        slotLookup.push(r.slot);
        for (const key of ['conf', 'fit']) {
          if (FLAG_STYLES[key].test(r)) { flag[key].data.push({ x: xVal, y: val }); flag[key].slots.push(r.slot); }
        }
      }

      const xScale = useTimestamps
        ? {
            type: 'linear',
            title: { display: true, text: 'Measurement time', font: { size: 12 } },
            ticks: {
              maxTicksLimit: 12,
              callback: function(val) {
                const d = new Date(val);
                return d.getDate() + '.' + (d.getMonth() + 1) + '. ' +
                       String(d.getHours()).padStart(2, '0') + ':' +
                       String(d.getMinutes()).padStart(2, '0');
              },
            },
          }
        : {
            type: 'linear',
            title: { display: true, text: 'Curve index', font: { size: 12 } },
            ticks: { maxTicksLimit: 20 },
          };

      const ungroupedDatasets = [{
        label: label,
        data: data,
        _slots: slotLookup,
        pointRadius: 2.5,
        pointHoverRadius: 5,
        borderColor: 'hsl(210,70%,42%)',
        backgroundColor: 'hsla(210,70%,42%,0.6)',
        showLine: true,
        borderWidth: 1.2,
        tension: 0,
      }];
      // Flag overlays — one per axis, distinct hollow marks, on top.
      let anyFlag = false;
      for (const key of ['conf', 'fit']) {
        if (!_showFlag(key) || !flag[key].data.length) continue;
        anyFlag = true;
        const style = FLAG_STYLES[key];
        ungroupedDatasets.push({
          label: style.label,
          data: flag[key].data,
          _slots: flag[key].slots,
          _isFlagOverlay: true,
          pointStyle: style.pointStyle,
          pointRadius: key === 'fit' ? 4 : 3,
          pointHoverRadius: 6,
          borderColor: style.color,
          backgroundColor: 'transparent',
          borderWidth: 1.2,
          showLine: false,
          order: -1,
        });
      }

      chartInst['mc-param-time-chart'] = new Chart(canvas, {
        type: 'scatter',
        data: { datasets: ungroupedDatasets },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          parsing: false,
          scales: { x: xScale, y: { title: { display: true, text: label, font: { size: 12 } } } },
          plugins: {
            // Small legend only to explain the two flag-marker styles.
            legend: {
              display: anyFlag,
              position: 'top',
              labels: {
                usePointStyle: true, boxWidth: 8, font: { size: 11 },
                filter: (item) => item.text === FLAG_STYLES.conf.label || item.text === FLAG_STYLES.fit.label,
              },
            },
            tooltip: {
              callbacks: {
                title: (items) => {
                  if (!items.length) return '';
                  const ds = ungroupedDatasets[items[0].datasetIndex];
                  const slot = ds?._slots?.[items[0].dataIndex];
                  return slot != null && paramMatrix[slot] ? paramMatrix[slot].name : '';
                },
              },
            },
            decimation: { enabled: true, algorithm: 'lttb', samples: 800 },
          },
          onClick: (evt, elems) => {
            if (elems.length) {
              const ds = ungroupedDatasets[elems[0].datasetIndex];
              const slot = ds?._slots?.[elems[0].index];
              if (slot != null) fetchAndShowDetail(slot);
            }
          },
        },
        plugins: [_ojipWhiteBgPlugin],
      });
    }

    // ── Right-click to remove a curve from analysis ──
    const chartCanvas = document.getElementById('mc-param-time-chart');
    if (chartCanvas) {
      chartCanvas.oncontextmenu = (e) => {
        e.preventDefault();
        const chart = chartInst['mc-param-time-chart'];
        if (!chart) return;
        const elems = chart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
        if (!elems.length) return;
        const dsIdx = elems[0].datasetIndex;
        const ptIdx = elems[0].index;
        const ds = chart.data.datasets[dsIdx];
        if (ds._isMeanOverlay) return; // don't remove from mean/SD overlay
        const slot = ds._slots?.[ptIdx];
        if (slot == null) return;
        const name = paramMatrix[slot]?.name || `#${slot + 1}`;
        if (!confirm(`Remove "${name}" from analysis?`)) return;
        _removeBatchSlot(slot);
      };
    }
  }

  /** Remove a single curve slot from the batch analysis. */
  function _removeBatchSlot(slot) {
    if (!paramMatrix || slot == null) return;
    paramMatrix[slot] = null;
    // Also remove from mcDataset curves array if present
    if (mcDataset && mcDataset.curves) {
      const idx = mcDataset.curves.findIndex(c => c.index === slot);
      if (idx !== -1) mcDataset.curves.splice(idx, 1);
    }
    // Re-render the time series tab
    renderTimeSeries();
    // Re-render grouped panels and comparison if visible
    if (mcDataset?.fluorometer === 'OJIPImaging') {
      renderGroupedPanels();
    }
  }

  // ── M4: Virtualized parameter table ──────────────────────────────────
  function _renderParamTable() {
    const container = document.getElementById('mc-param-table-wrap');
    if (!container) return;

    const isExcel = mcDataset && mcDataset.fluorometer === 'OJIPImaging';
    const metaCols = isExcel ? ['Line', 'Day', 'Hour'] : [];
    // Fit-quality diagnostic columns. The poor-fit flag is now driven by R²
    // (nRMSE/misfit× kept in payload as secondary diagnostics only).
    const fitCols = ['min conf', 'R²', 'nRMSE %'];
    const paramKeys = Object.keys(PARAM_GROUPS).flatMap(g => PARAM_GROUPS[g]);
    const headerRow = ['#', 'Name', ...metaCols, ...fitCols, ...paramKeys.map(k => PARAM_LABELS[k] || k)];

    const confCount = paramMatrix.filter(_confPoor).length;
    const fitCount  = paramMatrix.filter(_fitPoor).length;
    const flaggedTotal = paramMatrix.filter(_isPoorCurve).length;

    // "Show only flagged" filter toggle + per-axis flagged counts (muted markers
    // matching the plot: ● conf amber-tan, ▲ fit soft brick — review hints, not errors).
    let html = '<div class="d-flex flex-wrap align-items-center mb-2" style="gap:10px; font-size:0.82em;">' +
      `<label class="mb-0" style="cursor:pointer;${flaggedTotal ? '' : ' opacity:0.5;'}">` +
      `<input type="checkbox" ${_showOnlyFlagged ? 'checked' : ''} ${flaggedTotal ? '' : 'disabled'} ` +
      `onchange="MC.setFlaggedFilter(this.checked)"> Show only flagged</label>` +
      `<span class="text-muted"><span style="color:#b8923f;">&#9679;&nbsp;conf</span> ` +
      `${confCount} lower timing confidence (&lt; ${_confThresh()})</span>` +
      `<span class="text-muted"><span style="color:#b06a62;">&#9650;&nbsp;fit</span> ` +
      `${fitCount} lower-quality fit (R² &lt; ${_r2Thresh()})</span></div>`;

    html += '<div class="table-responsive" style="max-height:450px; overflow-y:auto;">' +
      '<table class="table table-sm table-bordered table-hover" style="font-size:0.78em;">' +
      '<thead class="thead-light"><tr>' +
      headerRow.map(h => `<th class="text-nowrap">${h}</th>`).join('') +
      '</tr></thead><tbody>';

    for (const r of paramMatrix) {
      if (!r) continue;
      const confPoor = _confPoor(r);
      const fitPoor  = _fitPoor(r);
      if (_showOnlyFlagged && !(confPoor || fitPoor)) continue;
      // Only genuine errors colour the whole row; flags are subtle inline marks.
      const cls = r.error ? 'table-danger' : '';
      html += `<tr class="${cls}" style="cursor:pointer" onclick="MC.fetchAndShowDetail(${r.slot})">`;
      html += `<td>${r.slot + 1}</td>`;
      let badge = '';
      if (fitPoor)  badge += `<span class="mr-1" title="lower-quality fit (R² ${r.fit_r2 != null ? r.fit_r2.toFixed(3) : 'n/a'})" style="color:#b06a62;">&#9650;</span>`;
      if (confPoor) badge += `<span class="mr-1" title="lower timing confidence (min ${_confMin(r).toFixed(2)})" style="color:#b8923f;">&#9679;</span>`;
      html += `<td class="text-nowrap">${badge}${r.name}</td>`;
      if (isExcel) {
        const meta = _slotMeta(r.slot);
        html += `<td class="text-nowrap">${meta ? meta.line : ''}</td>`;
        html += `<td>${meta ? meta.day : ''}</td>`;
        html += `<td>${meta ? meta.hours : ''}</td>`;
      }
      if (r.error) {
        html += `<td colspan="${fitCols.length + paramKeys.length}" class="text-danger">${r.error}</td>`;
      } else {
        // Fit diagnostics (R² null for PCHIP, which uses roughness instead).
        const r2 = r.fit_r2, nr = r.fit_nrmse;
        html += `<td class="${confPoor ? 'text-warning font-weight-bold' : 'text-muted'}">${_confMin(r).toFixed(2)}</td>`;
        html += `<td class="${fitPoor ? 'text-danger font-weight-bold' : 'text-muted'}">${r2 != null ? r2.toFixed(4) : '—'}</td>`;
        html += `<td class="text-muted">${nr != null ? (nr * 100).toFixed(2) : '—'}</td>`;
        for (const k of paramKeys) {
          const v = r[k];
          html += `<td>${v != null ? (typeof v === 'number' ? v.toPrecision(5) : v) : ''}</td>`;
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    // Copy button
    html += '<button class="btn btn-sm btn-outline-secondary mt-2" onclick="MC.copyParamTable()">' +
            '<i class="fa fa-clipboard mr-1"></i>Copy to clipboard</button>';

    container.innerHTML = html;
  }

  // Toggle the "show only flagged" filter and re-render the parameter table.
  function _setFlaggedFilter(checked) {
    _showOnlyFlagged = !!checked;
    _renderParamTable();
  }

  function copyParamTable() {
    if (!paramMatrix) return;
    const isExcel = mcDataset && mcDataset.fluorometer === 'OJIPImaging';
    const metaCols = isExcel ? ['Line', 'Day', 'Hour'] : [];
    const fitCols = ['min conf', 'R²', 'nRMSE %'];
    const paramKeys = Object.keys(PARAM_GROUPS).flatMap(g => PARAM_GROUPS[g]);
    const header = ['#', 'Name', ...metaCols, ...fitCols, ...paramKeys.map(k => PARAM_LABELS[k] || k)].join('\t');
    const rows = paramMatrix.filter(Boolean).map(r => {
      const metaVals = [];
      if (isExcel) {
        const meta = _slotMeta(r.slot);
        metaVals.push(meta ? meta.line : '', meta ? meta.day : '', meta ? meta.hours : '');
      }
      if (r.error) return [r.slot + 1, r.name, ...metaVals, `ERROR: ${r.error}`].join('\t');
      const fitVals = [
        _confMin(r).toFixed(3),
        r.fit_r2 != null ? r.fit_r2 : '',
        r.fit_nrmse != null ? (r.fit_nrmse * 100).toFixed(3) : '',
      ];
      return [r.slot + 1, r.name, ...metaVals, ...fitVals, ...paramKeys.map(k => r[k] ?? '')].join('\t');
    });
    navigator.clipboard.writeText(header + '\n' + rows.join('\n'));
  }

  // ── M5: Detail on demand ─────────────────────────────────────────────
  async function fetchAndShowDetail(slot) {
    const r = paramMatrix[slot];
    if (!r || r.error) return;

    // Check LRU cache (keyed by both slot and name for different consumers)
    if (mcDetailCache[slot]) {
      _showDetailInTabs(r.name, mcDetailCache[slot], slot);
      return;
    }

    // Fetch full curves for this one curve
    const _dc = mcDataset.curves.find(c => c.index === _slotToIndex(slot));
    const body = {
      fluorometer: mcDataset.fluorometer,
      time_native: Array.from(mcDataset.timeUs),
      curves: [{
        slot: slot,
        name: r.name,
        values: Array.from(_dc.values),
        bckg: (_dc.bckg != null ? _dc.bckg : null),
        fo_footer: (_dc.foFooter != null ? _dc.foFooter : null),
      }],
      FJ_time: parseFloat(document.getElementById('FJ_time').value) || 2.0,
      FI_time: parseFloat(document.getElementById('FI_time').value) || 30.0,
      knots_reduction_factor: parseInt(document.getElementById('kr_input').value) || 10,
      fit_method: (document.getElementById('fit-method-sel')?.value || 'logspline'),
      trim_first: parseInt(document.getElementById('trim-first-input')?.value) || 0,
      trim_last:  parseInt(document.getElementById('trim-last-input')?.value)  || 0,
      background_mode: document.getElementById('bg-mode-sel')?.value || 'auto',
      background_n:    parseInt(document.getElementById('bg-n-input')?.value) || 1,
      f0_source:       document.getElementById('f0-source-sel')?.value || 'instrument',
      knot_placement:  document.getElementById('knot-placement-sel')?.value || 'hybrid',
      oj_densify:      document.getElementById('oj-densify-chk')?.checked || false,
      oj_tau_ms:       (() => { const v = parseFloat(document.getElementById('oj-tau-input')?.value); return (v > 0) ? v : null; })(),
      f0_time_ms:      (() => { const v = parseFloat(document.getElementById('f0-time-input')?.value); return (v > 0) ? v : null; })(),
      include_curves: true,
    };

    try {
      const resp = await fetch('/api/ojip_process_batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.status !== 'success' || !data.results?.length) return;

      const detail = data.results[0];
      if (detail.error) return;

      // Cache with LRU eviction (keyed by slot for ZIP export compatibility)
      const keys = Object.keys(mcDetailCache);
      if (keys.length >= MC_DETAIL_MAX) delete mcDetailCache[keys[0]];
      mcDetailCache[slot] = detail;

      // Update densify status if info returned
      const densifySt = document.getElementById('oj-densify-status');
      if (densifySt && detail.densify_info) {
        const first = Object.values(detail.densify_info)[0];
        if (first) {
          densifySt.textContent = `\u03c4 = ${first.tau_ms} ms, A = ${first.A}`;
          const tauIn = document.getElementById('oj-tau-input');
          if (tauIn && !tauIn.value) tauIn.value = first.tau_ms;
        }
      }

      _showDetailInTabs(r.name, detail, slot);
    } catch(e) {
      console.error('Detail fetch failed:', e);
    }
  }

  function _slotToIndex(slot) {
    // Map slot back to the original curve index (using cached indices)
    return _selIndicesCache[slot] ?? slot;
  }

  function _showDetailInTabs(name, detail, slot) {
    _currentDetailSlot = slot;  // remember for param writeback in refitSplines()
    // Build a synthetic ojipData-like object for the existing rendering functions
    // This lets the existing Curves/Params/Diagnostics tabs work unchanged
    const singleData = {
      status: 'success',
      fluorometer: mcDataset.fluorometer,
      kr: parseInt(document.getElementById('kr_input').value) || 10,
      fj_time_ms: detail.FJ_time_user_ms,
      fi_time_ms: detail.FI_time_user_ms,
      files: [name],
      file_stem: mcDataset.stem,
      time_raw_ms: detail.time_raw_ms,
      time_log_ms: detail.time_log_ms,
      curves: { [name]: detail.curves },
      key_values: { [name]: {
        F0: detail.F0, FM: detail.FM, FK: detail.FK, F50: detail.F50,
        FJ: detail.FJ, FI: detail.FI,
        FJ_time_user_ms: detail.FJ_time_user_ms,
        FI_time_user_ms: detail.FI_time_user_ms,
        FJ_time_deriv_ms: detail.FJ_time_deriv_ms,
        FI_time_deriv_ms: detail.FI_time_deriv_ms,
        FP_time_deriv_ms: detail.FP_time_deriv_ms,
        FJ_time_inflect_ms: detail.FJ_time_inflect_ms,
        FI_time_inflect_ms: detail.FI_time_inflect_ms,
        FP_time_inflect_ms: detail.FP_time_inflect_ms,
        FM_time_ms: detail.FM_time_ms,
        Area_OJ: detail.Area_OJ, Area_JI: detail.Area_JI,
        Area_IP: detail.Area_IP, Area_OP: detail.Area_OP,
        poly_infl_ms: detail.poly_infl_ms,
        poly_fi_infl_ms: detail.poly_fi_infl_ms,
        fit_nrmse:     detail.fit_nrmse,
        fit_r2:        detail.fit_r2,
        fit_roughness: detail.fit_roughness,
        fit_flag:      detail.fit_flag,
        fit_method:    detail.fit_method,
      }},
    };

    // Temporarily set ojipData to this single-curve view
    ojipData = singleData;
    groups = {};
    recalcAllParams();

    // Hide placeholders so real tab content is visible
    mcShowPlaceholders(false);
    renderResults();

    // Show detail info bar
    const infoBar = document.getElementById('mc-detail-info');
    if (infoBar) {
      infoBar.innerHTML = `<i class="fa fa-info-circle mr-1"></i>Viewing curve <strong>${name}</strong> (${slot + 1} of ${paramMatrix.length})` +
        ` <button class="btn btn-sm btn-outline-secondary ml-2" onclick="MC.backToOverview()"><i class="fa fa-arrow-left mr-1"></i>Back to overview</button>`;
      infoBar.style.display = '';
    }

    // Switch to Diagnostics tab
    $('[href="#tab-diag"]').tab('show');
  }

  function backToOverview() {
    // Hide detail info bar
    const infoBar = document.getElementById('mc-detail-info');
    if (infoBar) infoBar.style.display = 'none';

    // Restore placeholders in detail tabs
    mcShowPlaceholders(true);

    // Switch to time-series tab
    $('[href="#tab-timeseries"]').tab('show');
  }

  // ── M6: Range-based multi-curve overlay viewer ───────────────────────
  let _curvesValidSlots = []; // cached valid slot list
  let _panelChartIds = [];    // canvas IDs of grouped-panel charts
  let _compareSelected       = new Set(); // selected primary panel values for comparison
  let _compareSubSelected    = new Set(); // selected sub-group values for comparison
  let _comparePrimaryField   = null;      // field _compareSelected was last initialized for
  let _compareSubField       = null;      // field _compareSubSelected was last initialized for

  // Read the user-editable from/to range (1-based, clamped)
  function _getCurveRange() {
    const total = _curvesValidSlots.length;
    const fromEl = document.getElementById('mc-cv-from');
    const toEl   = document.getElementById('mc-cv-to');
    let from = parseInt(fromEl?.value, 10) || 1;
    let to   = parseInt(toEl?.value, 10)   || Math.min(50, total);
    from = Math.max(1, Math.min(from, total));
    to   = Math.max(from, Math.min(to, total));
    return { from, to, total };
  }

  // Sync the From/To inputs and total label to current state
  function _syncRangeUI(from, to, total) {
    const fromEl  = document.getElementById('mc-cv-from');
    const toEl    = document.getElementById('mc-cv-to');
    const totalEl = document.getElementById('mc-cv-total');
    if (fromEl) { fromEl.value = from; fromEl.max = total; }
    if (toEl)   { toEl.value   = to;   toEl.max = total; }
    if (totalEl) totalEl.textContent = `/ ${total}`;
    const prevBtn = document.getElementById('mc-page-prev');
    const nextBtn = document.getElementById('mc-page-next');
    if (prevBtn) prevBtn.disabled = from <= 1;
    if (nextBtn) nextBtn.disabled = to >= total;
  }

  function renderAggregateCurves() {
    if (!mcDataset || !paramMatrix) return;

    const canvas = document.getElementById('mc-aggregate-chart');
    if (!canvas) return;

    // Collect valid curve slots
    _curvesValidSlots = paramMatrix.filter(r => r && !r.error).map(r => r.slot);
    const totalCurves = _curvesValidSlots.length;
    if (totalCurves === 0) return;

    // Initial default: set To to min(50, total) on first render
    const toEl = document.getElementById('mc-cv-to');
    if (toEl && (toEl.value === '' || parseInt(toEl.value, 10) === 0))
      toEl.value = Math.min(50, totalCurves);

    const range = _getCurveRange();
    _syncRangeUI(range.from, range.to, range.total);

    // Slice for the requested range (from/to are 1-based)
    const pageSlots = _curvesValidSlots.slice(range.from - 1, range.to);
    const nVisible  = pageSlots.length;

    // Time axis in ms (log scale)
    const timeMs = Array.from(mcDataset.timeUs).map(t => t * 0.001);

    // Decimate for performance: keep ~120 points per curve
    const fullLen = timeMs.length;
    const TARGET = 120;
    let step = 1;
    if (fullLen > TARGET) step = Math.max(1, Math.floor(fullLen / TARGET));
    const idxKeep = [];
    for (let i = 0; i < fullLen; i += step) idxKeep.push(i);
    if (idxKeep[idxKeep.length - 1] !== fullLen - 1) idxKeep.push(fullLen - 1);
    const decTimeMs = idxKeep.map(i => timeMs[i]);

    // Build datasets: one per curve in the range
    const datasets = [];
    for (let pi = 0; pi < nVisible; pi++) {
      const slot = pageSlots[pi];
      const curveIdx = _slotToIndex(slot);
      const curveObj = mcDataset.curves.find(c => c.index === curveIdx);
      if (!curveObj) continue;

      // Color spread across the visible range so every page uses the full palette
      const hue = Math.round((pi / Math.max(nVisible - 1, 1)) * 240);
      const color = `hsla(${240 - hue}, 70%, 48%, 0.45)`;
      const name = paramMatrix[slot]?.name || `#${slot + 1}`;

      const data = idxKeep.map((i, di) => ({ x: decTimeMs[di], y: curveObj.values[i] }));

      datasets.push({
        label: name,
        data: data,
        showLine: true,
        borderColor: color,
        borderWidth: 1.2,
        pointRadius: 0,
        pointHitRadius: 6,
        fill: false,
        tension: 0,
        _mcSlot: slot,
      });
    }

    // Optionally add median line (computed over ALL curves, not just visible)
    const showMedian = document.getElementById('mc-show-median')?.checked;
    if (showMedian && totalCurves > 1) {
      const medianData = idxKeep.map(ti => {
        const vals = [];
        for (const s of _curvesValidSlots) {
          const ci = _slotToIndex(s);
          const co = mcDataset.curves.find(c => c.index === ci);
          if (co) vals.push(co.values[ti]);
        }
        vals.sort((a, b) => a - b);
        return { x: timeMs[ti], y: vals[Math.floor(vals.length / 2)] };
      });
      datasets.push({
        label: 'Median (all curves)',
        data: medianData,
        showLine: true,
        borderColor: '#000',
        borderWidth: 2.5,
        borderDash: [6, 3],
        pointRadius: 0,
        fill: false,
      });
    }

    destroyChart('mc-aggregate-chart');
    chartInst['mc-aggregate-chart'] = new Chart(canvas, {
      type: 'scatter',
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        scales: {
          x: {
            type: 'logarithmic',
            title: { display: true, text: 'Time (ms)', font: { size: 12 } },
          },
          y: {
            title: { display: true, text: 'Fluorescence (a.u.)', font: { size: 12 } },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => item.datasetIndex < nVisible,
            callbacks: {
              title: (items) => items.length ? items[0].dataset.label || '' : '',
              label: (item) => `t = ${item.parsed.x.toFixed(3)} ms, F = ${item.parsed.y.toFixed(0)}`,
            },
          },
        },
        onClick: (evt, elems) => {
          if (!elems.length) return;
          const ds = chartInst['mc-aggregate-chart']?.data.datasets[elems[0].datasetIndex];
          if (ds && ds._mcSlot != null) fetchAndShowDetail(ds._mcSlot);
        },
      },
      plugins: [_ojipWhiteBgPlugin],
    });
  }

  function curvesPagePrev() {
    const range = _getCurveRange();
    const span = range.to - range.from + 1;
    const newFrom = Math.max(1, range.from - span);
    const newTo   = newFrom + span - 1;
    document.getElementById('mc-cv-from').value = newFrom;
    document.getElementById('mc-cv-to').value   = newTo;
    renderAggregateCurves();
  }

  function curvesPageNext() {
    const range = _getCurveRange();
    const span = range.to - range.from + 1;
    const newFrom = Math.min(range.total, range.from + span);
    const newTo   = Math.min(range.total, newFrom + span - 1);
    document.getElementById('mc-cv-from').value = newFrom;
    document.getElementById('mc-cv-to').value   = newTo;
    renderAggregateCurves();
  }

  // ── M8: Export helpers ───────────────────────────────────────────────
  function downloadParamsCSV() {
    if (!paramMatrix) return;
    const paramKeys = Object.keys(PARAM_GROUPS).flatMap(g => PARAM_GROUPS[g]);
    const header = ['index', 'name', 'timestamp', ...paramKeys.map(k => PARAM_LABELS[k] || k)];
    const rows = [header.join(',')];
    for (const r of paramMatrix) {
      if (!r) continue;
      if (r.error) {
        rows.push(`${r.slot + 1},"${r.name}","","ERROR: ${r.error}"`);
        continue;
      }
      const ts = mcDataset?.curves.find(c => c.index === _slotToIndex(r.slot))?.timestamp || '';
      const vals = paramKeys.map(k => r[k] ?? '');
      rows.push([r.slot + 1, `"${r.name}"`, `"${ts}"`, ...vals].join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${mcDataset?.stem || 'ojip'}_params.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── M8: XLSX export (client-side via SheetJS) ───────────────────────
  function downloadParamsXLSX() {
    if (!paramMatrix || typeof XLSX === 'undefined') return;
    const paramKeys = Object.keys(PARAM_GROUPS).flatMap(g => PARAM_GROUPS[g]);
    const header = ['Index', 'Name', 'Timestamp', ...paramKeys.map(k => PARAM_LABELS[k] || k)];
    const rows = [header];
    for (const r of paramMatrix) {
      if (!r) continue;
      const ts = mcDataset?.curves.find(c => c.index === _slotToIndex(r.slot))?.timestamp || '';
      if (r.error) {
        rows.push([r.slot + 1, r.name, ts, 'ERROR: ' + r.error]);
      } else {
        rows.push([r.slot + 1, r.name, ts, ...paramKeys.map(k => r[k] ?? '')]);
      }
    }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, 'JIP Parameters');

    // Add instrument metadata sheet if available
    if (mcDataset?.instrumentMeta) {
      const meta = mcDataset.instrumentMeta;
      const metaRows = [['Property', 'Value']];
      for (const [k, v] of Object.entries(meta)) {
        if (v != null) metaRows.push([k, v]);
      }
      metaRows.push(['Filename', mcDataset.filename]);
      metaRows.push(['Curves analyzed', paramMatrix.filter(r => r && !r.error).length]);
      metaRows.push(['Total curves', mcDataset.curves.length]);
      const ms = XLSX.utils.aoa_to_sheet(metaRows);
      XLSX.utils.book_append_sheet(wb, ms, 'Metadata');
    }

    XLSX.writeFile(wb, `${mcDataset?.stem || 'ojip'}_params.xlsx`);
  }

  // ── M2-Excel: Client-side OJIP Imaging Excel parser ─────────────────
  function parseExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(_parseExcelData(reader.result, file.name)); }
        catch(e) { reject(e); }
      };
      reader.onerror = () => reject(new Error('Failed to read Excel file'));
      reader.readAsArrayBuffer(file);
    });
  }

  // Metadata (non-signal) columns present in either OJIP-Imaging Excel layout.
  // Everything else in the header is treated as a candidate signal / normalization
  // column, so both "custom format 1" (Fo/Foi/Foj/Fop) and the newer "Long"
  // layout (Raw/Bg/F0/F0j_manual/…) are handled without a hard-coded column list.
  const EXCEL_META_COLS = new Set([
    'Tray ID', 'Tray Info', 'Plant ID', 'Position', 'Day', 'Hours', 'Lines',
    'ZT', 'ZT Corrected', 'TimePoint', 'LogTimePoint',
  ]);

  // Human-readable labels for the normalization-column dropdown.
  const EXCEL_NORM_LABELS = {
    Raw: 'Raw fluorescence',
    Bg: 'Bg (baseline-subtracted)',
    F0: 'F0 (O-normalized, 10–12 µs)',
    F0j_manual: 'F0j (norm. O & J, 2 ms)',
    F0i_manual: 'F0i (norm. O & I, 36 ms)',
    F0p_manual: 'F0p (norm. O & P, 280 ms)',
    Fo: 'Fo (normalized to O)',
    Foi: 'Foi (normalized to O and I)',
    Foj: 'Foj (normalized to O and J)',
    Fop: 'Fop (normalized to O and P)',
  };

  // Normalizations the tool can COMPUTE from a Raw column, per Sylvain's spec:
  //   Bg  = Raw − mean(Raw, 1–3 µs)
  //   F0  = Bg  / mean(Bg, 10–12 µs)
  //   F0j = F0  / F0(TimePoint = 2000 µs)
  //   F0i = F0  / F0(TimePoint = 36000 µs)
  //   F0p = F0  / F0(TimePoint = 280000 µs)
  // These require µs-scale TimePoints (the "Long" layout). Bg/F0/F0j/F0i/F0p are
  // pure per-curve SCALAR multiples of each other (dark baseline already at 0), so
  // they yield IDENTICAL JIP parameters — the choice only changes the transient
  // shown/exported. Raw is deliberately NOT offered: it retains the additive dark
  // offset (~hundreds of counts), which does NOT cancel in ratios like
  // Fv/Fm=(FM−F0)/FM and biases every F-ratio param — Raw is the source, not a
  // valid analysis target (_excelComputeNorm still handles it for internal use).
  const EXCEL_COMPUTABLE = ['Bg', 'F0', 'F0j_manual', 'F0i_manual', 'F0p_manual'];
  const EXCEL_JIP_REF_US = { F0j_manual: 2000, F0i_manual: 36000, F0p_manual: 280000 };

  function _excelInRange(t, lo, hi) { return t >= lo && t <= hi; }
  function _excelMean(arr) {
    let s = 0, n = 0;
    for (const v of arr) if (Number.isFinite(v)) { s += v; n++; }
    return n ? s / n : NaN;
  }

  /** Compute a normalization series from Raw for one curve (µs TimePoints). */
  function _excelComputeNorm(tpUs, raw, which) {
    if (which === 'Raw') return raw.slice();
    const base = _excelMean(raw.filter((_, i) => _excelInRange(tpUs[i], 1, 3)));
    const bg = raw.map(r => r - (Number.isFinite(base) ? base : 0));
    if (which === 'Bg') return bg;
    const oref = _excelMean(bg.filter((_, i) => _excelInRange(tpUs[i], 10, 12)));
    const denom0 = Number.isFinite(oref) && oref !== 0 ? oref : 1;
    const f0 = bg.map(b => b / denom0);
    if (which === 'F0') return f0;
    const refT = EXCEL_JIP_REF_US[which];
    let bi = 0, bd = Infinity;
    for (let i = 0; i < tpUs.length; i++) {
      const d = Math.abs(tpUs[i] - refT);
      if (d < bd) { bd = d; bi = i; }
    }
    const denom = Number.isFinite(f0[bi]) && f0[bi] !== 0 ? f0[bi] : 1;
    return f0.map(v => v / denom);
  }

  /** Median of a numeric array (ignoring non-finite), NaN if empty. */
  function _excelMedian(arr) {
    const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  // Parse the workbook into a raw, choice-independent payload. The actual
  // normalization column, background mode and curve naming are chosen in the
  // selection modal AFTER upload, so this step retains every candidate column
  // per timepoint; `resolveExcelDataset` then turns those choices into the
  // curve values / time axis / names consumed by the pipeline.
  function _parseExcelData(buffer, filename) {
    const wb = XLSX.read(buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    if (!rows.length) throw new Error('Excel file is empty');

    // Validate expected columns
    const requiredCols = ['Day', 'Hours', 'Lines', 'TimePoint'];
    const headers = Object.keys(rows[0]);
    for (const col of requiredCols) {
      if (!headers.includes(col))
        throw new Error(`Missing required column: "${col}". Expected columns: ${requiredCols.join(', ')}`);
    }

    // Candidate signal columns = everything that is not metadata.
    const dataCols = headers.filter(h => !EXCEL_META_COLS.has(h));
    const hasRaw = headers.includes('Raw');

    // ── time-unit detection ────────────────────────────────────────────────
    // "Custom format 1" stores TimePoint in ms (0.1 … ~2900); the "Long" layout
    // stores it in µs (1 … ~2.5e6). Detect µs from the presence of a Raw column
    // or from a max TimePoint well beyond any plausible ms value, then convert to
    // ms so the rest of the pipeline (which assumes ms for OJIPImaging) is
    // untouched.
    let tpMax = 0;
    for (const row of rows) {
      const t = parseFloat(row['TimePoint']);
      if (Number.isFinite(t) && t > tpMax) tpMax = t;
    }
    const isMicro = hasRaw || tpMax > 10000;
    const tScale = isMicro ? 0.001 : 1.0;          // native TimePoint → ms

    // ── available normalization columns ─────────────────────────────────────
    // With a Raw column the tool computes the full Bg/F0/F0j/F0i/F0p family
    // itself (owning the definition, so a Raw-only file also works); otherwise
    // it offers whatever signal columns the file already carries.
    const availableNormCols = hasRaw ? EXCEL_COMPUTABLE.slice() : dataCols.slice();
    if (!availableNormCols.length)
      throw new Error('No fluorescence/normalization columns found in the Excel file.');

    // Group rows by (Plant ID, Day, Hours) to reconstruct curves. Store all
    // candidate columns per timepoint so any normalization can be resolved.
    const hasPlantId = headers.includes('Plant ID');
    const curveMap = new Map();

    for (const row of rows) {
      const plantId = hasPlantId ? row['Plant ID'] : `${row['Lines']}_${row['Position'] || ''}`;
      const key = `${plantId}||${row['Day']}||${row['Hours']}`;

      if (!curveMap.has(key)) {
        curveMap.set(key, {
          plantId: plantId,
          line: row['Lines'] || '',
          day: row['Day'] || '',
          hours: row['Hours'] || '',
          position: row['Position'] || '',
          trayId: row['Tray ID'] || '',
          points: [],
        });
      }
      const rec = { t: parseFloat(row['TimePoint']) };
      for (const c of dataCols) rec[c] = parseFloat(row[c]);
      curveMap.get(key).points.push(rec);
    }

    let sharedTpNative = null;
    const rawCurves = [];
    const uniqueLines = new Set(), uniqueDays = new Set(), uniqueHours = new Set();
    let idx = 0;

    for (const [, meta] of curveMap) {
      meta.points.sort((a, b) => a.t - b.t);
      const tpNative = meta.points.map(p => p.t);
      if (!sharedTpNative) sharedTpNative = tpNative;
      rawCurves.push({ meta, tpNative, index: idx });
      uniqueLines.add(meta.line);
      uniqueDays.add(meta.day);
      uniqueHours.add(meta.hours);
      idx++;
    }

    if (!sharedTpNative || !rawCurves.length)
      throw new Error('No valid OJIP curves found in the Excel file.');

    const dataset = {
      fluorometer: 'OJIPImaging',
      filename: filename,
      stem: filename.replace(/\.[^.]+$/, ''),
      instrumentMeta: {
        flash_wavelength_nm: null, flash_percent: null, flash_intensity_uE: null,
        super_wavelength_nm: null, super_percent: null, super_intensity_uE: null,
        actinic_wavelength_nm: null, actinic_percent: null, actinic_intensity_uE: null,
      },
      // Raw payload retained so the modal's normalization / background / naming
      // choices can be (re)applied without re-reading the workbook.
      _excel: {
        rawCurves, sharedTpNative, dataCols, hasRaw, isMicro, tScale,
        availableNormCols,
        uniqueLines: [...uniqueLines].sort(),
        uniqueDays: [...uniqueDays].sort(),
        uniqueHours: [...uniqueHours].sort(),
      },
    };

    // Resolve once with defaults so the modal can list curves immediately.
    return resolveExcelDataset(dataset, null, null);
  }

  /**
   * (Re)build curve values / time axis / names for an OJIP-Imaging dataset from
   * the chosen normalization column and background mode. Mutates and returns the
   * dataset. Called first with defaults at parse time, then again from the
   * selection modal (via mcStartAnalysis) once the user has picked options.
   */
  function resolveExcelDataset(dataset, normCol, bgMode) {
    const x = dataset && dataset._excel;
    if (!x) return dataset;

    // Resolve the normalization column against what this file offers.
    if (!x.availableNormCols.includes(normCol))
      normCol = ['F0', 'Fo'].find(c => x.availableNormCols.includes(c)) || x.availableNormCols[0];
    bgMode = (bgMode === 'strip' || bgMode === 'keep') ? bgMode : 'strip';

    // Per-curve normalization series (still on the full native axis) + name.
    const curveSeries = x.rawCurves.map(rc => {
      const m = rc.meta;
      const series = x.hasRaw
        ? _excelComputeNorm(rc.tpNative, m.points.map(p => p.Raw), normCol)
        : m.points.map(p => p[normCol]);
      const name = ExcelNaming.buildName({
        line: m.line, day: m.day, hours: m.hours,
        plantId: m.plantId, position: m.position, trayId: m.trayId, index: rc.index });
      return { series, name };
    });

    // ── background / F0 handling (applied globally — shared time axis) ──────
    const nT = x.sharedTpNative.length;
    let sharedTimeMs, resolvedValues;

    if (bgMode !== 'keep' && x.isMicro) {
      // "Long" µs layout — the first six timepoints are synthetic (TOMI-3
      // pump-and-probe):
      //   1, 2, 3 µs   = background (dark) readings     → drop entirely
      //   10, 11, 12 µs = F0 (O-step, 3 noisy samples)  → average into one
      //                     point placed at 100 µs (0.1 ms)
      // Everything from 500 µs onward is real OJIP kinetics, kept as-is.
      // Placing averaged F0 at 100 µs (= 0.1 ms) matches the historical
      // summary-file format and fills the visual gap on a log-time plot.
      const f0Idx = [], restIdx = [];
      for (let i = 0; i < nT; i++) {
        const tp = x.sharedTpNative[i];
        if (tp >= 10 && tp <= 12)  f0Idx.push(i);
        else if (tp > 12)          restIdx.push(i);
        // tp < 10 (1–3 µs background) → dropped
      }
      const F0_PLACED_US = 100;                  // 0.1 ms on the log axis
      const hasF0pts = f0Idx.length > 0;
      const timeParts = hasF0pts
        ? [F0_PLACED_US, ...restIdx.map(i => x.sharedTpNative[i])]
        : restIdx.map(i => x.sharedTpNative[i]);
      sharedTimeMs = new Float64Array(timeParts.map(t => t * x.tScale));

      resolvedValues = curveSeries.map(cs => {
        let vals;
        if (hasF0pts) {
          const f0Vals = f0Idx.map(i => cs.series[i]).filter(Number.isFinite);
          const f0Avg = f0Vals.length
            ? f0Vals.reduce((a, b) => a + b, 0) / f0Vals.length : NaN;
          vals = [f0Avg, ...restIdx.map(i => cs.series[i])];
        } else {
          vals = restIdx.map(i => cs.series[i]);
        }
        return new Float64Array(vals);
      });
    } else if (bgMode !== 'keep') {
      // ms layout ("custom format 1"): drop leading dark/background points
      // that jump ≥3× up to the next point (median across curves).
      let firstKeep = 0;
      const medAt = i => _excelMedian(curveSeries.map(c => c.series[i]));
      while (firstKeep < nT - 1) {
        const a = medAt(firstKeep), b = medAt(firstKeep + 1);
        if (Number.isFinite(a) && Number.isFinite(b) && a > 0 && b / a >= 3) firstKeep++;
        else break;
      }
      if (firstKeep >= nT) firstKeep = 0;
      sharedTimeMs = new Float64Array(
        x.sharedTpNative.slice(firstKeep).map(t => t * x.tScale));
      resolvedValues = curveSeries.map(cs =>
        new Float64Array(cs.series.slice(firstKeep)));
    } else {
      // 'keep' mode — no dropping, no collapsing
      sharedTimeMs = new Float64Array(
        x.sharedTpNative.map(t => t * x.tScale));
      resolvedValues = curveSeries.map(cs => new Float64Array(cs.series));
    }

    dataset.curves = x.rawCurves.map((rc, i) => {
      const m = rc.meta;
      return {
        index: rc.index,
        colIndex: rc.index + 1,
        timestamp: `${m.day} ${m.hours}`,
        epochMs: NaN,
        protocol: 'OJIP',
        values: resolvedValues[i],
        line: m.line, day: m.day, hours: m.hours,
        plantId: m.plantId, position: m.position, trayId: m.trayId,
        curveName: curveSeries[i].name,
      };
    });
    dataset.timeUs = sharedTimeMs;   // actually ms; field name kept for pipeline compat
    dataset.totalColumns = dataset.curves.length;
    dataset.excelMeta = {
      normColumn: normCol,
      availableNormCols: x.availableNormCols,
      timeUnit: x.isMicro ? 'µs' : 'ms',
      bgMode: bgMode,
      droppedBg: nT - sharedTimeMs.length,
      uniqueLines: x.uniqueLines,
      uniqueDays: x.uniqueDays,
      uniqueHours: x.uniqueHours,
    };
    return dataset;
  }

  /** Repopulate the normalization-column dropdown to match the parsed file. */
  function _repopulateNormColSelect(availableNormCols, selected) {
    const sel = document.getElementById('excel-norm-col');
    if (!sel || !availableNormCols) return;
    sel.innerHTML = availableNormCols.map(c =>
      `<option value="${c}"${c === selected ? ' selected' : ''}>${EXCEL_NORM_LABELS[c] || c}</option>`
    ).join('');
  }

  // ── M2-Excel: Selection modal adaptations ──────────────────────────
  function showExcelSelectionModal(dataset) {
    const modal   = document.getElementById('mc-selection-modal');
    const tbody   = document.getElementById('mc-curve-tbody');
    const countEl = document.getElementById('mc-curve-count');
    const selEl   = document.getElementById('mc-selected-count');
    const dateEl  = document.getElementById('mc-date-range');
    const fileEl  = document.getElementById('mc-filename');
    const headerEl = document.getElementById('mc-table-header');
    const filtersEl = document.getElementById('mc-excel-filters');
    const namingRow = document.getElementById('mc-naming')?.closest('.form-group');

    fileEl.textContent = dataset.filename;
    countEl.textContent = dataset.curves.length;
    const em = dataset.excelMeta;
    const bgTxt = em.bgMode === 'keep'
      ? 'background kept'
      : (em.droppedBg ? `bg 1\u20133 \u00b5s dropped, F0 10\u201312 \u00b5s averaged \u2192 0.1 ms` : 'no bg change');
    dateEl.textContent = `${em.uniqueLines.length} lines, ${em.uniqueDays.length} days, ` +
                         `norm: ${em.normColumn}, TimePoint in ${em.timeUnit}, ${bgTxt}`;

    // Reflect the columns actually present in this file in the dropdown, so the
    // normalization choice matches the file.
    _repopulateNormColSelect(em.availableNormCols, em.normColumn);
    const bgSel = document.getElementById('excel-bg-mode');
    if (bgSel) bgSel.value = em.bgMode || 'strip';

    // Show the Excel import options (normalization / background / naming), which
    // now live inside this modal, and hide the FluorPen naming dropdown.
    const exOpts = document.getElementById('excel-options');
    if (exOpts) exOpts.style.display = '';
    if (namingRow) namingRow.style.display = 'none';

    // Show Excel filters
    if (filtersEl) {
      filtersEl.style.display = '';
      _populateFilterSelect('mc-filter-line', dataset.excelMeta.uniqueLines, 'All lines');
      _populateFilterSelect('mc-filter-day',  dataset.excelMeta.uniqueDays,  'All days');
      _populateFilterSelect('mc-filter-hour', dataset.excelMeta.uniqueHours, 'All hours');
    }

    // Update table header for Excel data
    if (headerEl) {
      headerEl.innerHTML =
        `<th style="width:30px;"><input type="checkbox" checked onchange="this.checked ? MC.selectAll() : MC.deselectAll()"></th>` +
        `<th style="width:40px;">#</th>` +
        `<th>Line</th>` +
        `<th>Day</th>` +
        `<th>Hour</th>` +
        `<th>Plant ID</th>`;
    }

    // Build table rows
    tbody.innerHTML = '';
    for (const c of dataset.curves) {
      const tr = document.createElement('tr');
      tr.dataset.line  = c.line;
      tr.dataset.day   = c.day;
      tr.dataset.hours = c.hours;
      tr.innerHTML =
        `<td><input type="checkbox" class="mc-curve-cb" data-idx="${c.index}" checked></td>` +
        `<td>${c.index + 1}</td>` +
        `<td>${c.line}</td>` +
        `<td>${c.day}</td>` +
        `<td>${c.hours}</td>` +
        `<td class="small">${c.plantId}</td>`;
      tbody.appendChild(tr);
    }
    _updateSelCount();

    $(modal).modal('show');
  }

  function _populateFilterSelect(selectId, values, placeholder) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = `<option value="" selected>${placeholder}</option>` +
      values.map(v => `<option value="${v}">${v}</option>`).join('');
  }

  function applyExcelFilters() {
    const lineVal = _getMultiSelectValues('mc-filter-line');
    const dayVal  = _getMultiSelectValues('mc-filter-day');
    const hourVal = _getMultiSelectValues('mc-filter-hour');

    const rows = document.querySelectorAll('#mc-curve-tbody tr');
    for (const tr of rows) {
      const cb = tr.querySelector('.mc-curve-cb');
      const matchLine = !lineVal.length || lineVal.includes(tr.dataset.line);
      const matchDay  = !dayVal.length  || dayVal.includes(tr.dataset.day);
      const matchHour = !hourVal.length || hourVal.includes(tr.dataset.hours);
      const match = matchLine && matchDay && matchHour;
      if (cb) cb.checked = match;
      tr.style.display = ''; // always show row, just toggle checkbox
    }
    _updateSelCount();
  }

  function clearExcelFilters() {
    ['mc-filter-line', 'mc-filter-day', 'mc-filter-hour'].forEach(id => {
      const sel = document.getElementById(id);
      if (sel) sel.selectedIndex = 0;
    });
    document.querySelectorAll('.mc-curve-cb').forEach(cb => cb.checked = true);
    _updateSelCount();
  }

  function _getMultiSelectValues(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return [];
    return [...sel.selectedOptions].map(o => o.value).filter(v => v !== '');
  }

  // Override getCurveName for Excel datasets
  function getExcelCurveName(curve) {
    return curve.curveName || `${curve.line}_${curve.day}_${curve.hours}`;
  }

  // ── Grouped OJIP Curve Panels ────────────────────────────────────────

  function _destroyAllPanelCharts() {
    for (const id of _panelChartIds) destroyChart(id);
    _panelChartIds = [];
  }

  // ── Compare mode helpers ────────────────────────────────────────────

  /**
   * Render a clickable badge row for a metadata field.
   * Generic — used for both primary and sub-group badge rows.
   *
   * @param {HTMLElement} container   Element to render into
   * @param {string}      field       Metadata field name (e.g. 'line', 'hours')
   * @param {string[]}    validSlots  Slot list to collect unique values from
   * @param {Set}         selectedSet Set to read/write selection state into
   * @param {Function}    onChangeFn  Called when selection changes
   * @param {string}      [labelPrefix] Optional prefix (e.g. "Lines:")
   * @param {boolean}     [forceReinit] Force re-select all (e.g. when field changed)
   * @returns {string[]}  Sorted unique values
   */
  function _renderBadgeRow(container, field, validSlots, selectedSet,
                            onChangeFn, labelPrefix, forceReinit) {
    if (!container) return [];

    // Collect unique values
    const valueSet = new Set();
    for (const slot of validSlots) {
      const meta = _slotMeta(slot);
      if (meta) valueSet.add(String(meta[field] ?? 'unknown'));
    }

    // Numeric-aware sort
    const sorted = [...valueSet].sort((a, b) => {
      const na = parseFloat(a.replace(/[^\d.]/g, ''));
      const nb = parseFloat(b.replace(/[^\d.]/g, ''));
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });

    // Auto-select all when forced (field changed) or when set is completely stale
    // (has values but none match current data). Empty set = user chose "None", respect it.
    const hasAnyValid = selectedSet.size > 0 &&
                        [...selectedSet].some(v => valueSet.has(v));
    if (forceReinit || (!hasAnyValid && selectedSet.size > 0)) {
      selectedSet.clear();
      sorted.forEach(v => selectedSet.add(v));
    }

    container.innerHTML = '';

    // Optional prefix label
    if (labelPrefix) {
      const lbl = document.createElement('span');
      lbl.style.cssText = 'font-size:0.78em; font-weight:600; margin-right:4px; color:#495057;';
      lbl.textContent = labelPrefix;
      container.appendChild(lbl);
    }

    // Select all / Deselect all links
    const links = document.createElement('span');
    links.style.cssText = 'font-size:0.78em; margin-right:6px;';
    const selAll = document.createElement('a');
    selAll.href = '#'; selAll.textContent = 'All';
    selAll.style.cssText = 'margin-right:4px; text-decoration:underline; cursor:pointer;';
    selAll.onclick = (e) => {
      e.preventDefault();
      sorted.forEach(v => selectedSet.add(v));
      onChangeFn();
    };
    const deselAll = document.createElement('a');
    deselAll.href = '#'; deselAll.textContent = 'None';
    deselAll.style.cssText = 'text-decoration:underline; cursor:pointer;';
    deselAll.onclick = (e) => {
      e.preventDefault();
      selectedSet.clear();
      onChangeFn();
    };
    links.appendChild(selAll);
    links.appendChild(document.createTextNode(' / '));
    links.appendChild(deselAll);
    container.appendChild(links);

    // One badge per value
    for (const val of sorted) {
      const badge = document.createElement('span');
      const active = selectedSet.has(val);
      badge.className = 'badge ' + (active ? 'badge-primary' : 'badge-secondary');
      badge.style.cssText = 'cursor:pointer; margin:2px; padding:4px 8px; font-size:0.82em;' +
                            (active ? '' : ' opacity:0.4;');
      badge.textContent = val;
      badge.onclick = () => {
        if (selectedSet.has(val)) selectedSet.delete(val);
        else selectedSet.add(val);
        onChangeFn();
      };
      container.appendChild(badge);
    }

    return sorted;
  }

  /**
   * Compute per-timepoint mean and sample SD for each color group
   * within a subset of curve slots.
   */
  function _calcPanelGroupStats(slots, colorField, timeMs) {
    const groups = new Map(); // groupVal → [slot, ...]
    for (const slot of slots) {
      const meta = _slotMeta(slot);
      if (!meta) continue;
      const gv = colorField ? (meta[colorField] || 'unknown') : 'all';
      if (!groups.has(gv)) groups.set(gv, []);
      groups.get(gv).push(slot);
    }

    const nTime = timeMs.length;
    const result = new Map();

    for (const [gv, gSlots] of groups) {
      const mean = new Float64Array(nTime);
      const sd   = new Float64Array(nTime);

      for (let t = 0; t < nTime; t++) {
        let sum = 0, sum2 = 0, count = 0;
        for (const s of gSlots) {
          const idx = _slotToIndex(s);
          const curveObj = mcDataset.curves.find(c => c.index === idx);
          if (!curveObj) continue;
          const v = curveObj.values[t];
          if (v == null || !isFinite(v)) continue;
          sum += v; sum2 += v * v; count++;
        }
        if (count > 0) {
          mean[t] = sum / count;
          sd[t] = count > 1
            ? Math.sqrt((sum2 - sum * sum / count) / (count - 1))
            : 0;
        }
      }
      result.set(gv, { mean, sd, slots: gSlots, n: gSlots.length });
    }
    return result;
  }

  /**
   * Build Chart.js datasets for one panel.
   */
  function _buildPanelDatasets(panelSlots, colorField, displayMode, timeMs) {
    const stats = _calcPanelGroupStats(panelSlots, colorField, timeMs);
    const sortedGroups = [...stats.keys()].sort();
    const nGroups = sortedGroups.length;
    const datasets = [];

    sortedGroups.forEach((gv, gi) => {
      const { mean, sd, slots: gSlots } = stats.get(gv);
      const color   = sampleColor(gi, nGroups);
      const sdColor = sampleColor(gi, nGroups, 0.15);

      if (displayMode === 'meansd' || displayMode === 'both') {
        // Upper SD band (fill to next dataset)
        datasets.push({
          label: '', showLine: true, pointRadius: 0,
          borderWidth: 0, borderColor: 'transparent', backgroundColor: sdColor,
          data: timeMs.map((t, j) => ({ x: t, y: mean[j] + sd[j] })),
          fill: '+1',
        });
        // Lower SD band
        datasets.push({
          label: '', showLine: true, pointRadius: 0,
          borderWidth: 0, borderColor: 'transparent', backgroundColor: sdColor,
          data: timeMs.map((t, j) => ({ x: t, y: mean[j] - sd[j] })),
          fill: false,
        });
        // Mean line
        datasets.push({
          label: gv, showLine: true, pointRadius: 0,
          borderWidth: 2, borderColor: color, backgroundColor: 'transparent',
          data: timeMs.map((t, j) => ({ x: t, y: mean[j] })),
          fill: false,
        });
      }

      if (displayMode === 'individual' || displayMode === 'both') {
        const indivAlpha = displayMode === 'both' ? 0.2 : 0.5;
        const indivWidth = displayMode === 'both' ? 0.7 : 1.0;
        const indivColor = sampleColor(gi, nGroups, indivAlpha);

        for (let si = 0; si < gSlots.length; si++) {
          const slot = gSlots[si];
          const idx = _slotToIndex(slot);
          const curveObj = mcDataset.curves.find(c => c.index === idx);
          if (!curveObj) continue;
          datasets.push({
            label: (displayMode === 'individual' && si === 0) ? gv : '',
            showLine: true, pointRadius: 0,
            borderWidth: indivWidth, borderColor: indivColor,
            backgroundColor: 'transparent',
            data: timeMs.map((t, j) => ({ x: t, y: curveObj.values[j] })),
            fill: false, _mcSlot: slot,
          });
        }
      }
    });
    return datasets;
  }

  /**
   * Create one grid cell: heading + canvas + chart instance.
   */
  function _createPanelChart(grid, panelValue, title, slots,
                             colorField, displayMode, timeMs, yRange) {
    const cell = document.createElement('div');
    cell.style.cssText = 'border:1px solid #dee2e6; border-radius:4px; padding:6px;';

    const heading = document.createElement('div');
    heading.style.cssText = 'font-size:0.82em; font-weight:600; margin-bottom:4px; ' +
                            'text-align:center; color:#495057;';
    heading.textContent = title;
    cell.appendChild(heading);

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:relative; height:220px;';
    const canvas = document.createElement('canvas');
    const canvasId = 'mc-panel-' + String(panelValue).replace(/[^a-zA-Z0-9]/g, '_');
    canvas.id = canvasId;
    wrapper.appendChild(canvas);
    cell.appendChild(wrapper);

    const info = document.createElement('small');
    info.className = 'text-muted';
    info.style.fontSize = '0.75em';
    info.textContent = `n = ${slots.length} curves`;
    cell.appendChild(info);

    grid.appendChild(cell);

    const datasets = _buildPanelDatasets(slots, colorField, displayMode, timeMs);

    chartInst[canvasId] = new Chart(canvas, {
      type: 'scatter',
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        scales: {
          x: {
            type: 'logarithmic',
            title: { display: true, text: 'Time (ms)', font: { size: 10 } },
            ticks: { font: { size: 9 } },
            grid: { display: false },
          },
          y: Object.assign(
            {
              title: { display: true, text: 'Fluorescence', font: { size: 10 } },
              ticks: { font: { size: 9 } },
              grid: { display: false },
            },
            yRange ? { min: yRange.min, max: yRange.max } : {}
          ),
        },
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: {
              font: { size: 9 }, padding: 4,
              boxWidth: 10, boxHeight: 6,
              filter: item => item.text !== '',
            },
          },
          tooltip: {
            enabled: true, mode: 'nearest', intersect: false,
            callbacks: {
              title: items => items.length ? items[0].dataset.label || '' : '',
              label: item =>
                `t = ${item.parsed.x.toFixed(2)} ms, F = ${item.parsed.y.toFixed(1)}`,
            },
          },
        },
        onClick: (evt, elems) => {
          if (!elems.length) return;
          const ds = chartInst[canvasId]?.data.datasets[elems[0].datasetIndex];
          if (ds && ds._mcSlot != null) fetchAndShowDetail(ds._mcSlot);
        },
      },
      plugins: [_ojipWhiteBgPlugin, { id: 'panelBorder', afterDraw(ch) {
        const a = ch.chartArea, c = ch.ctx; c.save();
        c.strokeStyle = '#000'; c.lineWidth = 1;
        c.strokeRect(a.left, a.top, a.right - a.left, a.bottom - a.top);
        c.restore();
      }}],
    });
    _panelChartIds.push(canvasId);
  }

  /**
   * Push Chart.js datasets for one comparison group (mean±SD + individuals).
   * Mutates the `datasets` array in place.
   */
  function _pushComparisonDatasets(datasets, label, gSlots, color, sdColor,
                                    displayMode, timeMs) {
    const nTime = timeMs.length;
    const mean = new Float64Array(nTime);
    const sd   = new Float64Array(nTime);
    for (let t = 0; t < nTime; t++) {
      let sum = 0, sum2 = 0, count = 0;
      for (const s of gSlots) {
        const idx = _slotToIndex(s);
        const curveObj = mcDataset.curves.find(c => c.index === idx);
        if (!curveObj) continue;
        const v = curveObj.values[t];
        if (v == null || !isFinite(v)) continue;
        sum += v; sum2 += v * v; count++;
      }
      if (count > 0) {
        mean[t] = sum / count;
        sd[t] = count > 1
          ? Math.sqrt((sum2 - sum * sum / count) / (count - 1)) : 0;
      }
    }

    if (displayMode === 'meansd' || displayMode === 'both') {
      datasets.push({
        label: '', showLine: true, pointRadius: 0,
        borderWidth: 0, borderColor: 'transparent', backgroundColor: sdColor,
        data: timeMs.map((t, j) => ({ x: t, y: mean[j] + sd[j] })),
        fill: '+1',
      });
      datasets.push({
        label: '', showLine: true, pointRadius: 0,
        borderWidth: 0, borderColor: 'transparent', backgroundColor: sdColor,
        data: timeMs.map((t, j) => ({ x: t, y: mean[j] - sd[j] })),
        fill: false,
      });
      datasets.push({
        label: `${label} (n=${gSlots.length})`, showLine: true, pointRadius: 0,
        borderWidth: 2, borderColor: color, backgroundColor: 'transparent',
        data: timeMs.map((t, j) => ({ x: t, y: mean[j] })),
        fill: false,
      });
    }

    if (displayMode === 'individual' || displayMode === 'both') {
      const indivAlpha = displayMode === 'both' ? 0.2 : 0.5;
      const indivWidth = displayMode === 'both' ? 0.7 : 1.0;
      // Derive individual color with alpha from the base HSL color
      const indivColor = color.replace(')', `,${indivAlpha})`).replace('hsl(', 'hsla(');

      for (let si = 0; si < gSlots.length; si++) {
        const slot = gSlots[si];
        const idx = _slotToIndex(slot);
        const curveObj = mcDataset.curves.find(c => c.index === idx);
        if (!curveObj) continue;
        datasets.push({
          label: (displayMode === 'individual' && si === 0) ? label : '',
          showLine: true, pointRadius: 0,
          borderWidth: indivWidth, borderColor: indivColor,
          backgroundColor: 'transparent',
          data: timeMs.map((t, j) => ({ x: t, y: curveObj.values[j] })),
          fill: false, _mcSlot: slot,
        });
      }
    }

    // ── FJ / FI / FP timing markers on the mean curve ──────────────────
    const showTiming = document.getElementById('mc-compare-show-timing')?.checked ?? true;
    if (showTiming && paramMatrix) {
      // Compute group-mean timings from paramMatrix
      const timingKeys = [
        { key: 'FJ_time_deriv_ms', style: 'triangle', tip: 'FJ' },
        { key: 'FI_time_deriv_ms', style: 'rectRot',  tip: 'FI' },
        { key: 'FP_time_deriv_ms', style: 'rect',     tip: 'FP' },
      ];
      const markerPts = [], markerR = [], markerSt = [], markerBg = [], markerBd = [];
      for (const { key, style, tip } of timingKeys) {
        let tSum = 0, tCount = 0;
        for (const s of gSlots) {
          const r = paramMatrix[s];
          if (!r || r.error || r[key] == null) continue;
          tSum += r[key]; tCount++;
        }
        if (tCount === 0) continue;
        const meanT = tSum / tCount;
        // Interpolate fluorescence on the mean curve at meanT
        let yVal = null;
        for (let j = 1; j < nTime; j++) {
          if (timeMs[j] >= meanT) {
            const frac = (meanT - timeMs[j - 1]) / (timeMs[j] - timeMs[j - 1]);
            yVal = mean[j - 1] + frac * (mean[j] - mean[j - 1]);
            break;
          }
        }
        if (yVal == null) continue;
        markerPts.push({ x: meanT, y: yVal, _tip: `${tip} = ${meanT.toFixed(2)} ms` });
        markerR.push(7); markerSt.push(style); markerBg.push(color); markerBd.push(color);
      }
      if (markerPts.length > 0) {
        datasets.push({
          label: '', showLine: false,
          data: markerPts,
          pointRadius: markerR, pointStyle: markerSt,
          pointBackgroundColor: markerBg, pointBorderColor: markerBd,
          borderColor: 'transparent', backgroundColor: 'transparent',
        });
      }
    }
  }

  /**
   * Build datasets and render the comparison chart on the fixed #mc-compare-chart canvas.
   * Supports optional sub-grouping (e.g. Line × Hour).
   */
  function _createComparisonChart(validSlots, panelField, selectedPrimary,
                                   subField, selectedSub, displayMode, timeMs) {
    // Step 1: Partition slots → Map<primaryVal, Map<subVal, slot[]>>
    const primaryMap = new Map();
    for (const slot of validSlots) {
      const meta = _slotMeta(slot);
      if (!meta) continue;
      const pv = String(meta[panelField] ?? 'unknown');
      if (!selectedPrimary.has(pv)) continue;
      const sv = subField ? String(meta[subField] ?? 'unknown') : '__none__';
      if (selectedSub && subField && !selectedSub.has(sv)) continue;
      if (!primaryMap.has(pv)) primaryMap.set(pv, new Map());
      const subMap = primaryMap.get(pv);
      if (!subMap.has(sv)) subMap.set(sv, []);
      subMap.get(sv).push(slot);
    }

    // Step 2: Sort primary values
    const sortedPrimary = [...primaryMap.keys()].sort((a, b) => {
      const na = parseFloat(a.replace(/[^\d.]/g, ''));
      const nb = parseFloat(b.replace(/[^\d.]/g, ''));
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
    const nPrimary = sortedPrimary.length;
    if (nPrimary === 0) return;

    // Step 3: Collect all sub-values for consistent ordering
    const allSubVals = new Set();
    for (const subMap of primaryMap.values())
      for (const sv of subMap.keys()) allSubVals.add(sv);
    const sortedSubVals = [...allSubVals].sort((a, b) => {
      const na = parseFloat(a.replace(/[^\d.]/g, ''));
      const nb = parseFloat(b.replace(/[^\d.]/g, ''));
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
    const nSubs = subField ? sortedSubVals.length : 1;

    // Step 4: Build datasets
    const datasets = [];
    let totalCurves = 0;
    let nDataGroups = 0;

    sortedPrimary.forEach((pv, pi) => {
      const primaryHue = Math.round((pi / Math.max(nPrimary, 1)) * 320);
      const subMap = primaryMap.get(pv);

      if (!subField) {
        // No sub-grouping: one color per primary value
        const gSlots = subMap.get('__none__') || [];
        if (gSlots.length === 0) return;
        totalCurves += gSlots.length;
        nDataGroups++;
        const color   = `hsl(${primaryHue},70%,42%)`;
        const sdColor = `hsla(${primaryHue},70%,42%,0.15)`;
        _pushComparisonDatasets(datasets, pv, gSlots, color, sdColor,
                                 displayMode, timeMs);
      } else {
        // Sub-grouped: color families per primary, shades per sub-group
        sortedSubVals.forEach((sv, si) => {
          const gSlots = subMap.get(sv);
          if (!gSlots || gSlots.length === 0) return;
          totalCurves += gSlots.length;
          nDataGroups++;
          const color   = subGroupColor(primaryHue, si, nSubs);
          const sdColor = subGroupColor(primaryHue, si, nSubs, 0.15);
          const label   = `${pv} / ${sv}`;
          _pushComparisonDatasets(datasets, label, gSlots, color, sdColor,
                                   displayMode, timeMs);
        });
      }
    });

    // Step 5: Render on fixed canvas
    const canvasId = 'mc-compare-chart';
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    // ── Compare Y-axis controls ──
    const compareSharedY = document.getElementById('mc-compare-shared-y')?.checked;
    const compareYMin = parseFloat(document.getElementById('mc-compare-y-min')?.value);
    const compareYMax = parseFloat(document.getElementById('mc-compare-y-max')?.value);
    const compareYScale = {
      title: { display: true, text: 'Fluorescence', font: { size: 11 } },
      ticks: { font: { size: 10 } },
      grid: { display: false },
    };
    if (compareSharedY || !isNaN(compareYMin) || !isNaN(compareYMax)) {
      if (!isNaN(compareYMin)) compareYScale.min = compareYMin;
      if (!isNaN(compareYMax)) compareYScale.max = compareYMax;
    }

    chartInst[canvasId] = new Chart(canvas, {
      type: 'scatter',
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        scales: {
          x: {
            type: 'logarithmic',
            title: { display: true, text: 'Time (ms)', font: { size: 11 } },
            ticks: { font: { size: 10 } },
            grid: { display: false },
          },
          y: compareYScale,
        },
        plugins: {
          legend: {
            display: true,
            position: 'right',
            labels: {
              font: { size: 10 }, padding: 5,
              boxWidth: 12, boxHeight: 8,
              filter: item => item.text !== '',
            },
          },
          tooltip: {
            enabled: true, mode: 'nearest', intersect: false,
            callbacks: {
              title: items => items.length ? items[0].dataset.label || '' : '',
              label: item => {
                const raw = item.raw;
                if (raw && raw._tip) return raw._tip;
                return `t = ${item.parsed.x.toFixed(2)} ms, F = ${item.parsed.y.toFixed(1)}`;
              },
            },
          },
        },
        onClick: (evt, elems) => {
          if (!elems.length) return;
          const ds = chartInst[canvasId]?.data.datasets[elems[0].datasetIndex];
          if (ds && ds._mcSlot != null) fetchAndShowDetail(ds._mcSlot);
        },
      },
      plugins: [_ojipWhiteBgPlugin, { id: 'panelBorder', afterDraw(ch) {
        const a = ch.chartArea, c = ch.ctx; c.save();
        c.strokeStyle = '#000'; c.lineWidth = 1;
        c.strokeRect(a.left, a.top, a.right - a.left, a.bottom - a.top);
        c.restore();
      }}],
    });

    // Update info text
    const infoEl = document.getElementById('mc-compare-info');
    if (infoEl) {
      infoEl.textContent = `${nDataGroups} group${nDataGroups !== 1 ? 's' : ''}, ` +
                           `${totalCurves} curves total. Sample SD (n\u22121).`;
    }
  }

  /**
   * Main entry: render the grouped OJIP curve panel grid.
   */
  function renderGroupedPanels() {
    const card = document.getElementById('mc-grouped-panels-card');
    if (!card) return;

    const isExcel = mcDataset?.fluorometer === 'OJIPImaging';
    if (!isExcel || !paramMatrix) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';

    const panelBy     = document.getElementById('mc-panel-by')?.value || '';
    const colorBy     = document.getElementById('mc-panel-color-by')?.value || '';
    const displayMode = document.getElementById('mc-panel-display')?.value || 'meansd';

    // ── Shared Y-axis controls ──
    const sharedY = document.getElementById('mc-panel-shared-y')?.checked;
    const yMinInput = parseFloat(document.getElementById('mc-panel-y-min')?.value);
    const yMaxInput = parseFloat(document.getElementById('mc-panel-y-max')?.value);

    _destroyAllPanelCharts();
    const grid = document.getElementById('mc-panel-grid');
    if (!grid) return;
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';

    const timeMs = Array.from(mcDataset.timeUs);

    const validSlots = (paramMatrix || [])
      .filter(r => r && !r.error)
      .map(r => r.slot);
    if (validSlots.length === 0) return;

    // Compute global Y range if shared Y is on and no manual values set
    let yRange = null;
    if (sharedY) {
      let gMin = Infinity, gMax = -Infinity;
      if (!isNaN(yMinInput)) gMin = yMinInput;
      if (!isNaN(yMaxInput)) gMax = yMaxInput;
      if (isNaN(yMinInput) || isNaN(yMaxInput)) {
        for (const slot of validSlots) {
          const idx = _slotToIndex(slot);
          const curveObj = mcDataset.curves.find(c => c.index === idx);
          if (!curveObj) continue;
          for (const v of curveObj.values) {
            if (v != null && isFinite(v)) {
              if (isNaN(yMinInput) && v < gMin) gMin = v;
              if (isNaN(yMaxInput) && v > gMax) gMax = v;
            }
          }
        }
      }
      if (isFinite(gMin) && isFinite(gMax)) {
        yRange = { min: gMin, max: gMax };
      }
    }

    if (!panelBy) {
      _createPanelChart(grid, 'all', 'All Curves', validSlots,
                        colorBy, displayMode, timeMs, yRange);
    } else {
      const panelMap = new Map();
      for (const slot of validSlots) {
        const meta = _slotMeta(slot);
        if (!meta) continue;
        const pv = meta[panelBy] || 'unknown';
        if (!panelMap.has(pv)) panelMap.set(pv, []);
        panelMap.get(pv).push(slot);
      }

      const sortedPanels = [...panelMap.keys()].sort((a, b) => {
        const na = parseFloat(String(a).replace(/[^\d.]/g, ''));
        const nb = parseFloat(String(b).replace(/[^\d.]/g, ''));
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return String(a).localeCompare(String(b));
      });

      for (const pv of sortedPanels) {
        _createPanelChart(grid, pv, String(pv), panelMap.get(pv),
                          colorBy, displayMode, timeMs, yRange);
      }
    }

    // Also refresh the comparison card
    renderComparison();
  }

  /**
   * Render the standalone comparison card.
   * Called by: renderGroupedPanels (tail call), badge clicks,
   *           sub-group/display dropdown onchange.
   */
  function renderComparison() {
    const compareCard = document.getElementById('mc-compare-card');
    if (!compareCard) return;

    const isExcel = mcDataset?.fluorometer === 'OJIPImaging';
    if (!isExcel || !paramMatrix) {
      compareCard.style.display = 'none';
      return;
    }
    compareCard.style.display = '';

    const groupBy     = document.getElementById('mc-compare-group-by')?.value || 'line';
    const subGroupBy  = document.getElementById('mc-compare-subgroup-by')?.value || '';
    const displayMode = document.getElementById('mc-compare-display')?.value || 'meansd';

    // Sync sub-group dropdown: hide option matching current groupBy
    const subGroupSel = document.getElementById('mc-compare-subgroup-by');
    if (subGroupSel) {
      for (const opt of subGroupSel.options) {
        opt.hidden = (opt.value !== '' && opt.value === groupBy);
      }
      if (subGroupBy && subGroupBy === groupBy) {
        subGroupSel.value = '';
      }
    }
    const effectiveSubGroupBy = subGroupSel?.value || '';

    // Detect field changes → force reinit of badge selections
    const primaryFieldChanged = (_comparePrimaryField !== groupBy);
    if (primaryFieldChanged) _comparePrimaryField = groupBy;

    const subFieldChanged = (_compareSubField !== effectiveSubGroupBy);
    if (subFieldChanged) _compareSubField = effectiveSubGroupBy;

    const timeMs = Array.from(mcDataset.timeUs);
    const validSlots = (paramMatrix || [])
      .filter(r => r && !r.error)
      .map(r => r.slot);
    if (validSlots.length === 0) return;

    // Render primary badges
    const primaryContainer = document.getElementById('mc-compare-primary-badges');
    if (primaryContainer) {
      _renderBadgeRow(primaryContainer, groupBy, validSlots,
                       _compareSelected, renderComparison, 'Primary:',
                       primaryFieldChanged);
    }

    // Show/hide and render sub-group badges
    const subContainer = document.getElementById('mc-compare-sub-badges');
    if (effectiveSubGroupBy && subContainer) {
      subContainer.style.display = '';
      _renderBadgeRow(subContainer, effectiveSubGroupBy, validSlots,
                       _compareSubSelected, renderComparison, 'Sub-group:',
                       subFieldChanged);
    } else if (subContainer) {
      subContainer.style.display = 'none';
    }

    // Destroy previous comparison chart and rebuild
    destroyChart('mc-compare-chart');

    if (_compareSelected.size > 0) {
      _createComparisonChart(
        validSlots, groupBy, _compareSelected,
        effectiveSubGroupBy,
        effectiveSubGroupBy ? _compareSubSelected : null,
        displayMode, timeMs
      );
    }
  }

  // ── Summary statistics table ─────────────────────────────────────────
  function _buildGroupStats() {
    // Returns { groupMap, sortedGroups, sortedX, xLabels, paramKey, colorBy, xAxisField }
    const paramKey = document.getElementById('mc-param-picker')?.value || 'FVFM';
    const colorBy = document.getElementById('mc-color-by')?.value || '';
    const xAxisField = document.getElementById('mc-x-axis')?.value || 'index';

    if (!colorBy || !paramMatrix) return null;

    const groupMap = new Map();
    for (const r of paramMatrix) {
      if (!r || r.error) continue;
      const val = r[paramKey];
      if (val == null) continue;
      const meta = _slotMeta(r.slot);
      if (!meta) continue;
      const groupVal = meta[colorBy] || 'unknown';
      const xVal = xAxisField === 'index' ? r.slot : _metaToX(meta, xAxisField);
      if (isNaN(xVal)) continue;
      if (!groupMap.has(groupVal)) groupMap.set(groupVal, []);
      groupMap.get(groupVal).push({ x: xVal, y: val });
    }

    const sortedGroups = [...groupMap.keys()].sort();
    const allX = new Set();
    for (const pts of groupMap.values()) pts.forEach(p => allX.add(p.x));
    const sortedX = [...allX].sort((a, b) => a - b);
    const tickCb = _metaXTickCallback(xAxisField);
    const xLabels = sortedX.map(x => tickCb ? tickCb(x) : x);

    return { groupMap, sortedGroups, sortedX, xLabels, paramKey, colorBy, xAxisField };
  }

  function _renderSummaryTable() {
    const wrap = document.getElementById('mc-summary-table-body');
    if (!wrap) return;

    const stats = _buildGroupStats();
    if (!stats) {
      wrap.innerHTML = '<p class="text-muted mb-0">Select a "Color by" grouping to see summary statistics.</p>';
      return;
    }
    if (stats.xAxisField === 'index') {
      wrap.innerHTML = '<p class="text-muted mb-0">Summary table is not available when X-axis is "Curve index". Select Hour or Day as X-axis.</p>';
      return;
    }

    const { groupMap, sortedGroups, sortedX, xLabels, paramKey } = stats;
    const label = PARAM_LABELS[paramKey] || paramKey;

    let html = '<div class="table-responsive" style="max-height:400px; overflow:auto;">';
    html += '<table class="table table-sm table-bordered" style="font-size:0.78em;">';
    html += `<thead class="thead-light"><tr><th class="text-nowrap">${label}</th>`;
    xLabels.forEach(xl => { html += `<th class="text-center text-nowrap">${xl}</th>`; });
    html += '</tr></thead><tbody>';

    for (const gv of sortedGroups) {
      html += `<tr><td class="font-weight-bold text-nowrap">${gv}</td>`;
      const pts = groupMap.get(gv);

      for (const xVal of sortedX) {
        const vals = pts.filter(p => p.x === xVal).map(p => p.y);
        if (!vals.length) { html += '<td class="text-center text-muted">-</td>'; continue; }
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const sd = vals.length > 1
          ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1))
          : 0;
        html += `<td class="text-center text-nowrap">${mean.toPrecision(4)} &pm; ${sd.toPrecision(3)}`;
        html += `<br><span class="text-muted" style="font-size:0.85em;">n=${vals.length}</span></td>`;
      }
      html += '</tr>';
    }

    html += '</tbody></table></div>';
    wrap.innerHTML = html;
  }

  function toggleSummaryTable() {
    const wrap = document.getElementById('mc-summary-table-wrap');
    if (!wrap) return;
    const visible = wrap.style.display !== 'none';
    wrap.style.display = visible ? 'none' : '';
    if (!visible) _renderSummaryTable();
  }

  function copySummaryTable() {
    const stats = _buildGroupStats();
    if (!stats || stats.xAxisField === 'index') return;

    const { groupMap, sortedGroups, sortedX, xLabels } = stats;
    const header = ['Group', ...xLabels].join('\t');
    const rows = sortedGroups.map(gv => {
      const pts = groupMap.get(gv);
      const cells = sortedX.map(xVal => {
        const vals = pts.filter(p => p.x === xVal).map(p => p.y);
        if (!vals.length) return '-';
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const sd = vals.length > 1
          ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1))
          : 0;
        return `${mean.toPrecision(4)} \u00b1 ${sd.toPrecision(3)} (n=${vals.length})`;
      });
      return [gv, ...cells].join('\t');
    });
    navigator.clipboard.writeText(header + '\n' + rows.join('\n'));
  }

  // ── Capture all summary charts for ZIP export ─────────────────────────
  // Cycles through every parameter in the picker, captures each scatter
  // plot, then captures grouped panels, compare chart, and aggregate chart.
  function captureAllSummaryCharts() {
    const result = {};
    if (!paramMatrix) return result;

    const picker = document.getElementById('mc-param-picker');
    if (picker) {
      const origValue = picker.value;
      for (const opt of picker.options) {
        picker.value = opt.value;
        _renderParamTimeChart();
        const canvas = document.getElementById('mc-param-time-chart');
        if (canvas && chartInst['mc-param-time-chart']) {
          result['param-' + opt.value] = canvas.toDataURL('image/png');
        }
      }
      // Restore original selection
      picker.value = origValue;
      _renderParamTimeChart();
    }

    // Capture grouped-panel charts (one per group value, e.g. mc-panel-WT)
    for (const cid of _panelChartIds) {
      const canvas = document.getElementById(cid);
      if (canvas && chartInst[cid]) {
        result[cid] = canvas.toDataURL('image/png');
      }
    }

    // Capture compare chart
    const cmpCanvas = document.getElementById('mc-compare-chart');
    if (cmpCanvas && chartInst['mc-compare-chart']) {
      result['mc-compare-chart'] = cmpCanvas.toDataURL('image/png');
    }

    // Capture aggregate curves chart
    const aggCanvas = document.getElementById('mc-aggregate-chart');
    if (aggCanvas && chartInst['mc-aggregate-chart']) {
      result['mc-aggregate-chart'] = aggCanvas.toDataURL('image/png');
    }

    return result;
  }

  // ── Public API ───────────────────────────────────────────────────────
  return {
    parse, isMultiCurve, showSelectionModal,
    parseExcel, showExcelSelectionModal, resolveExcelDataset,
    applyExcelFilters, clearExcelFilters,
    selectAll, deselectAll, selectRange,
    getSelectedIndices, getNamingScheme,
    runParamsPass, cancelBatch,
    renderTimeSeries, renderAggregateCurves, renderGroupedPanels, renderComparison,
    curvesPagePrev, curvesPageNext,
    fetchAndShowDetail, backToOverview,
    copyParamTable, downloadParamsCSV, downloadParamsXLSX,
    toggleSummaryTable, copySummaryTable, setFlaggedFilter: _setFlaggedFilter,
    onFlagThresholdChange: _onFlagThresholdChange,
    _updateSelCount, slotToIndex: _slotToIndex, slotMeta: _slotMeta,
    captureAllSummaryCharts,
  };
})();

// ── parameter metadata ────────────────────────────────────────────────────
const PARAM_GROUPS = {
  yields: ['FVFM', 'VJ', 'VI', 'M0', 'PSIE0', 'PSIR0', 'DELTAR0', 'PHIE0', 'PHIR0'],
  fluxes: ['ABSRC', 'TR0RC', 'ET0RC', 'RE0RC', 'DI0RC'],
  areas:  ['Area_OJ', 'Area_JI', 'Area_IP', 'Area_OP', 'SM', 'N'],
  tech:   ['F0', 'FM', 'FK', 'FJ', 'FI', 'FV', 'OJ', 'JI', 'IP'],
  timing: ['FJ_time_deriv_ms', 'FI_time_deriv_ms', 'FP_time_deriv_ms', 'FM_time_ms'],
  slopes: ['slope_OJ', 'slope_JI', 'slope_IP'],
  dip:    ['dip_IP_amplitude', 'dip_IP_time_ms', 'dip_IP_d1_min'],
};
const PARAM_LABELS = {
  FVFM:'Fv/Fm (φP₀)', VJ:'VJ', VI:'VI', M0:'M₀', PSIE0:'ψE₀', PSIR0:'ψR₀',
  DELTAR0:'δR₀', PHIE0:'φE₀', PHIR0:'φR₀',
  ABSRC:'ABS/RC', TR0RC:'TR₀/RC', ET0RC:'ET₀/RC', RE0RC:'RE₀/RC', DI0RC:'DI₀/RC',
  Area_OJ:'Area O-J', Area_JI:'Area J-I', Area_IP:'Area I-P', Area_OP:'Area O-P',
  SM:'Sm', N:'N (QA turnover)',
  F0:'F₀', FM:'FM', FK:'FK', FJ:'FJ', FI:'FI', FV:'FV', OJ:'A(O-J)', JI:'A(J-I)', IP:'A(I-P)',
  FJ_time_deriv_ms:'t(FJ) ms', FI_time_deriv_ms:'t(FI) ms', FP_time_deriv_ms:'t(FP) ms', FM_time_ms:'t(FM) ms',
  slope_OJ:'Slope O-J', slope_JI:'Slope J-I', slope_IP:'Slope I-P',
  dip_IP_amplitude:'Dip I-P amplitude', dip_IP_time_ms:'Dip I-P time (ms)', dip_IP_d1_min:'Dip I-P D1 min',
};

// ── colour palette ─────────────────────────────────────────────────────────
function sampleColor(i, n, alpha) {
  const h = Math.round((i / Math.max(n, 1)) * 320); // 0–320 hue
  return alpha !== undefined
    ? `hsla(${h},70%,42%,${alpha})`
    : `hsl(${h},70%,42%)`;
}
function groupColor(i, n, alpha) {
  const palette = [210, 30, 120, 270, 60, 180, 330];
  const h = palette[i % palette.length];
  return alpha !== undefined ? `hsla(${h},65%,42%,${alpha})` : `hsl(${h},65%,42%)`;
}
/** Color within a "family": same hue, varying lightness 28–60%. */
function subGroupColor(primaryHue, subIndex, nSubs, alpha) {
  const L = nSubs < 2 ? 44 : Math.round(28 + (subIndex / (nSubs - 1)) * 32);
  return alpha !== undefined
    ? `hsla(${primaryHue},65%,${L}%,${alpha})`
    : `hsl(${primaryHue},65%,${L}%)`;
}

// ── OJIP publication figure style ─────────────────────────────────────────
const OJIP_PUB_DEFAULTS = {
  sizePreset: 'single', exportWidth: 85, aspectRatio: 1.5, exportDPI: 300,
  fontFamily: 'Arial', axisTitleSize: 12, tickLabelSize: 11, legendSize: 10,
  colorScheme: 'default', legendPosition: 'right',
  showGridY: true, showGridX: false,
  bgColor: '#ffffff', showBorder: false, borderColor: '#000000', borderWidth: 1,
  lineWidthMean: 2.5, lineWidthIndiv: 0.8, sdBandOpacity: 18,
};
const OJIP_PER_CHART_DEFAULTS = {
  raw:           { yStartZero: false, yHeadroom: 5,  xTitle: '', yTitle: '' },
  shifted_F0:    { yStartZero: false, yHeadroom: 5,  xTitle: '', yTitle: '' },
  shifted_FM:    { yStartZero: false, yHeadroom: 5,  xTitle: '', yTitle: '' },
  double_norm:   { yStartZero: false, yHeadroom: 5,  xTitle: '', yTitle: '' },
  params_yields: { yStartZero: true,  yHeadroom: 15 },
  params_fluxes: { yStartZero: true,  yHeadroom: 15 },
  params_areas:  { yStartZero: true,  yHeadroom: 15 },
  params_tech:   { yStartZero: true,  yHeadroom: 15 },
};
const OJIP_PUB_PALETTES = {
  colorblind: ['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000'],
  grayscale:  ['#111111','#444444','#777777','#aaaaaa','#cccccc'],
  paired:     ['#1f77b4','#aec7e8','#ff7f0e','#ffbb78','#2ca02c','#98df8a','#d62728','#ff9896'],
};
function _makeOjipPub() {
  const pub = Object.assign({}, OJIP_PUB_DEFAULTS);
  pub.perChart = {};
  for (const [k, v] of Object.entries(OJIP_PER_CHART_DEFAULTS)) pub.perChart[k] = Object.assign({}, v);
  try {
    const saved = JSON.parse(localStorage.getItem('ojip_grp_pub') || 'null');
    if (saved) {
      Object.keys(OJIP_PUB_DEFAULTS).forEach(k => { if (k in saved) pub[k] = saved[k]; });
      if (saved.perChart) {
        for (const k of Object.keys(OJIP_PER_CHART_DEFAULTS)) {
          if (saved.perChart[k]) Object.assign(pub.perChart[k], saved.perChart[k]);
        }
      }
    }
  } catch(e) {}
  return pub;
}
let ojipPub = _makeOjipPub();

function _ojipPubColor(gi, n, alpha) {
  const pal = OJIP_PUB_PALETTES[ojipPub.colorScheme];
  if (!pal) return groupColor(gi, n, alpha);
  const hex = pal[gi % pal.length];
  if (alpha === undefined) return hex;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function _ojipPubBgPlugin() {
  return { id:'ojipPubBg', beforeDraw(ch) {
    const c=ch.ctx; c.save(); c.fillStyle=ojipPub.bgColor||'#fff';
    c.fillRect(0,0,ch.width,ch.height); c.restore();
  }};
}
function _ojipPubBorderPlugin() {
  return { id:'ojipPubBorder', afterDraw(ch) {
    if (!ojipPub.showBorder) return;
    const a=ch.chartArea, c=ch.ctx; c.save();
    c.strokeStyle=ojipPub.borderColor||'#000'; c.lineWidth=ojipPub.borderWidth||1;
    c.strokeRect(a.left,a.top,a.right-a.left,a.bottom-a.top); c.restore();
  }};
}
function _applyOjipPubToOpts(opts, isBar, pc) {
  const s=ojipPub, fam=s.fontFamily, sc=opts.scales||{};
  if (sc.x) {
    if (!sc.x.title) sc.x.title={display:true};
    sc.x.title.font={family:fam,size:s.axisTitleSize,weight:'bold'};
    if (!sc.x.ticks) sc.x.ticks={};
    sc.x.ticks.font={family:fam,size:s.tickLabelSize};
    if (!isBar) sc.x.grid={display:s.showGridX};
    if (pc?.xTitle) sc.x.title.text=pc.xTitle;
  }
  if (sc.y) {
    if (!sc.y.title) sc.y.title={display:true};
    sc.y.title.font={family:fam,size:s.axisTitleSize,weight:'bold'};
    if (!sc.y.ticks) sc.y.ticks={};
    sc.y.ticks.font={family:fam,size:s.tickLabelSize};
    if (!isBar) sc.y.grid={display:s.showGridY};
    if (pc?.yTitle) sc.y.title.text=pc.yTitle;
    if (pc?.yStartZero) sc.y.min=0;
  }
  if (opts.plugins?.legend) {
    opts.plugins.legend.position=s.legendPosition;
    if (!opts.plugins.legend.labels) opts.plugins.legend.labels={};
    opts.plugins.legend.labels.font={family:fam,size:s.legendSize};
  }
  return opts;
}
function _applyOjipPubAspectRatio() {
  const ratio=ojipPub.aspectRatio||1.5;
  const pw={single:85,half:120,double:175};
  const wMm=ojipPub.sizePreset!=='custom'?(pw[ojipPub.sizePreset]||85):(ojipPub.exportWidth||85);
  const maxW=Math.round(wMm*96/25.4);
  document.querySelectorAll('.ojip-pub-ch').forEach(cont=>{
    cont.style.maxWidth=maxW+'px';
    const w=cont.offsetWidth;
    if(w>0) cont.style.height=Math.round(w/ratio)+'px';
    const cid=cont.dataset.cid;
    if(cid&&chartInst[cid]) chartInst[cid].resize();
  });
}
function readOjipPubSettings() {
  const g=id=>document.getElementById(id);
  const sp=(g('ojip-pub-size-preset')||{}).value||'single';
  ojipPub.sizePreset=sp;
  ojipPub.exportWidth=sp!=='custom'?({single:85,half:120,double:175}[sp]||85):(parseFloat((g('ojip-pub-export-width')||{}).value)||85);
  const av=(g('ojip-pub-aspect-preset')||{}).value||'1.50';
  ojipPub.aspectRatio=av==='custom'?(parseFloat((g('ojip-pub-aspect-custom')||{}).value)||1.5):(parseFloat(av)||1.5);
  ojipPub.exportDPI=parseInt((g('ojip-pub-dpi')||{}).value)||300;
  ojipPub.bgColor=(g('ojip-pub-bg-color')||{}).value||'#ffffff';
  ojipPub.fontFamily=(g('ojip-pub-font-family')||{}).value||'Arial';
  ojipPub.axisTitleSize=parseInt((g('ojip-pub-axis-title-size')||{}).value)||12;
  ojipPub.tickLabelSize=parseInt((g('ojip-pub-tick-size')||{}).value)||11;
  ojipPub.legendSize=parseInt((g('ojip-pub-legend-size')||{}).value)||10;
  ojipPub.colorScheme=(g('ojip-pub-color-scheme')||{}).value||'default';
  ojipPub.legendPosition=(g('ojip-pub-legend-pos')||{}).value||'right';
  ojipPub.showGridY=!!(g('ojip-pub-grid-y')||{}).checked;
  ojipPub.showGridX=!!(g('ojip-pub-grid-x')||{}).checked;
  ojipPub.showBorder=!!(g('ojip-pub-show-border')||{}).checked;
  ojipPub.borderColor=(g('ojip-pub-border-color')||{}).value||'#000000';
  ojipPub.borderWidth=parseFloat((g('ojip-pub-border-width')||{}).value)||1;
  ojipPub.lineWidthMean=parseFloat((g('ojip-pub-line-width-mean')||{}).value)||2.5;
  ojipPub.lineWidthIndiv=parseFloat((g('ojip-pub-line-width-indiv')||{}).value)||0.8;
  ojipPub.sdBandOpacity=parseInt((g('ojip-pub-sd-opacity')||{}).value)||18;
  for (const [nm,key] of [['raw','raw'],['f0','shifted_F0'],['fm','shifted_FM'],['dn','double_norm']]) {
    const pc=ojipPub.perChart[key];
    pc.yStartZero=!!(g(`ojip-pc-${nm}-y-start-zero`)||{}).checked;
    pc.yHeadroom=parseFloat((g(`ojip-pc-${nm}-y-headroom`)||{}).value)||5;
    pc.xTitle=(g(`ojip-pc-${nm}-x-title`)||{}).value||'';
    pc.yTitle=(g(`ojip-pc-${nm}-y-title`)||{}).value||'';
  }
  for (const [nm,key] of [['yields','params_yields'],['fluxes','params_fluxes'],['areas','params_areas'],['tech','params_tech']]) {
    const pc=ojipPub.perChart[key];
    pc.yStartZero=!!(g(`ojip-pc-${nm}-y-start-zero`)||{}).checked;
    pc.yHeadroom=parseFloat((g(`ojip-pc-${nm}-y-headroom`)||{}).value)||15;
  }
  try{localStorage.setItem('ojip_grp_pub',JSON.stringify(ojipPub));}catch(e){}
}
function syncDomFromOjipPub() {
  const g=id=>document.getElementById(id);
  const sv=(id,v)=>{const el=g(id);if(el)el.value=v;};
  const sc=(id,v)=>{const el=g(id);if(el)el.checked=v;};
  sv('ojip-pub-size-preset',ojipPub.sizePreset);
  sv('ojip-pub-export-width',ojipPub.exportWidth);
  const rs=ojipPub.aspectRatio.toFixed(2);
  const kr=['1.78','1.50','1.33','1.00','0.75'];
  sv('ojip-pub-aspect-preset',kr.includes(rs)?rs:'custom');
  sv('ojip-pub-aspect-custom',rs);
  const cw=g('ojip-pub-custom-width-wrap'); if(cw)cw.style.display=ojipPub.sizePreset==='custom'?'':'none';
  const cr=g('ojip-pub-custom-ratio-wrap'); if(cr)cr.style.display=kr.includes(rs)?'none':'';
  sv('ojip-pub-dpi',ojipPub.exportDPI);
  sv('ojip-pub-bg-color',ojipPub.bgColor);
  sv('ojip-pub-font-family',ojipPub.fontFamily);
  sv('ojip-pub-axis-title-size',ojipPub.axisTitleSize);
  sv('ojip-pub-tick-size',ojipPub.tickLabelSize);
  sv('ojip-pub-legend-size',ojipPub.legendSize);
  sv('ojip-pub-color-scheme',ojipPub.colorScheme);
  sv('ojip-pub-legend-pos',ojipPub.legendPosition);
  sc('ojip-pub-grid-y',ojipPub.showGridY);
  sc('ojip-pub-grid-x',ojipPub.showGridX);
  sc('ojip-pub-show-border',ojipPub.showBorder);
  sv('ojip-pub-border-color',ojipPub.borderColor);
  sv('ojip-pub-border-width',ojipPub.borderWidth);
  const bo=g('ojip-pub-border-opts'); if(bo)bo.style.display=ojipPub.showBorder?'':'none';
  sv('ojip-pub-line-width-mean',ojipPub.lineWidthMean);
  sv('ojip-pub-line-width-indiv',ojipPub.lineWidthIndiv);
  sv('ojip-pub-sd-opacity',ojipPub.sdBandOpacity);
  const mv=g('ojip-pub-line-width-mean-val');  if(mv)mv.textContent=ojipPub.lineWidthMean+' px';
  const iv=g('ojip-pub-line-width-indiv-val'); if(iv)iv.textContent=ojipPub.lineWidthIndiv+' px';
  const sv2=g('ojip-pub-sd-opacity-val');      if(sv2)sv2.textContent=ojipPub.sdBandOpacity+'%';
  for(const[nm,key]of[['raw','raw'],['f0','shifted_F0'],['fm','shifted_FM'],['dn','double_norm']]){
    const pc=ojipPub.perChart[key];
    sc(`ojip-pc-${nm}-y-start-zero`,pc.yStartZero);
    sv(`ojip-pc-${nm}-y-headroom`,pc.yHeadroom);
    sv(`ojip-pc-${nm}-x-title`,pc.xTitle||'');
    sv(`ojip-pc-${nm}-y-title`,pc.yTitle||'');
  }
  for(const[nm,key]of[['yields','params_yields'],['fluxes','params_fluxes'],['areas','params_areas'],['tech','params_tech']]){
    const pc=ojipPub.perChart[key];
    sc(`ojip-pc-${nm}-y-start-zero`,pc.yStartZero);
    sv(`ojip-pc-${nm}-y-headroom`,pc.yHeadroom);
  }
  const badge=g('ojip-pub-badge');
  if(badge){
    const copy=Object.assign({},ojipPub); delete copy.perChart;
    badge.style.display=JSON.stringify(copy)===JSON.stringify(OJIP_PUB_DEFAULTS)?'none':'';
  }
}

// ── chart helpers ─────────────────────────────────────────────────────────
function destroyChart(id) {
  if (chartInst[id]) { chartInst[id].destroy(); delete chartInst[id]; }
}
function makeChart(id, cfg) {
  destroyChart(id);
  cfg.plugins = (cfg.plugins || []).concat(_ojipWhiteBgPlugin);
  chartInst[id] = new Chart(document.getElementById(id), cfg);
  return chartInst[id];
}

// Run fn() with pane temporarily forced to display:block so that
// Chart.js can read correct layout dimensions even while the pane is hidden.
// visibility:hidden keeps it invisible to the user during this window.
function _withPaneVisible(paneId, fn) {
  const pane = document.getElementById(paneId);
  const wasHidden = getComputedStyle(pane).display === 'none';
  if (wasHidden) {
    pane.style.display = 'block';
    pane.style.visibility = 'hidden';
    void pane.offsetWidth; // force synchronous layout
  }
  fn();
  if (wasHidden) {
    pane.style.display = '';
    pane.style.visibility = '';
  }
}

// ── tab rendering helpers ─────────────────────────────────────────────────
function activeTabId() {
  return (document.querySelector('#ojipTabs .nav-link.active')?.getAttribute('href') || '#tab-curves').slice(1);
}
function markTabsDirty(...ids) { ids.forEach(id => dirtyTabs.add(id)); }
// renderDirtyTab is called when the tab becomes visible AFTER the user has
// changed data (remove file, FJ/FI edit, etc.).  params/diag are also
// pre-rendered in renderResults, so this only runs when they are re-dirty.
function renderDirtyTab(tabId) {
  if (!ojipData || !dirtyTabs.has(tabId)) return;
  dirtyTabs.delete(tabId);
  if (tabId === 'tab-curves') {
    const activeNorm = document.querySelector('#norm-btns .btn-primary')?.dataset?.norm || 'double_norm';
    renderCurvesChart(activeNorm);
    buildFJTable();
  } else if (tabId === 'tab-params') {
    const pgroup = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'yields';
    renderParamsChart(pgroup);
    renderParamsTable(pgroup);
  } else if (tabId === 'tab-groups') {
    refreshGroupSummary();
    if (hasGroups()) {
      document.getElementById('group-results').style.display = '';
      _renderAllOjipGroupCharts();
    }
  } else if (tabId === 'tab-diag') {
    renderDiagnostics();
  }
}

// Compact legend — small font, tight spacing, labels truncated at 24 chars
function compactLegend(position = 'right') {
  return {
    display: true,
    position,
    labels: {
      font:      { size: 10 },
      padding:   4,
      boxWidth:  12,
      boxHeight: 8,
      filter:    item => item.text !== '',
      generateLabels(chart) {
        const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
        return items.map(d => ({
          ...d,
          text: d.text?.length > 24 ? d.text.slice(0, 22) + '…' : (d.text ?? ''),
        }));
      },
    },
  };
}

// Common scatter (log x-axis) options
function logScatterOpts(xLabel, yLabel) {
  return {
    animation: false,
    parsing: false,          // data already in {x,y} format — skip parse step
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { type: 'logarithmic',
           title: { display: true, text: xLabel },
           ticks: { callback: v => v >= 1 ? v : (v >= 0.01 ? +v.toFixed(2) : +v.toExponential(1)) }},
      y: { title: { display: true, text: yLabel } },
    },
    plugins: {
      legend:  compactLegend('right'),
      tooltip: { mode: 'nearest', intersect: false },
    },
    elements: { line: { tension: 0 } },
  };
}
// Common bar options
function barOpts(yLabel) {
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    scales: { x: { ticks: { maxRotation: 40 } }, y: { title: { display: true, text: yLabel || '' } } },
    plugins: { legend: compactLegend('top') },
  };
}

// ── JIP parameter calculation ──────────────────────────────────────────────
function calcJIP(kv) {
  const F0 = kv.F0, FM = kv.FM, FK = kv.FK, F50 = kv.F50, FJ = kv.FJ, FI = kv.FI;
  const FV      = FM - F0;
  const FVFM    = FV / FM;
  const M0      = 4 * (FK - F50) / FV;
  const VJ      = (FJ - F0) / FV;
  const VI      = (FI - F0) / FV;
  const PSIE0   = 1 - VJ;
  const PSIR0   = 1 - VI;
  const DELTAR0 = PSIR0 / PSIE0;
  const PHIE0   = FVFM * PSIE0;
  const PHIR0   = FVFM * PSIR0;
  const TR0RC   = M0 / VJ;
  const ABSRC   = TR0RC / FVFM;
  const ET0RC   = TR0RC * PSIE0;
  const RE0RC   = TR0RC * PSIR0;
  const DI0RC   = ABSRC - TR0RC;
  const SM      = kv.Area_OP / FV;
  const N       = SM * M0 / VJ;
  return {
    F0, FM, FK, FJ, FI, FV,
    OJ: FJ - F0, JI: FI - FJ, IP: FM - FI,
    FVFM, M0, VJ, VI, PSIE0, PSIR0, DELTAR0, PHIE0, PHIR0,
    ABSRC, TR0RC, ET0RC, RE0RC, DI0RC,
    Area_OJ: kv.Area_OJ, Area_JI: kv.Area_JI, Area_IP: kv.Area_IP, Area_OP: kv.Area_OP,
    SM, N,
    FJ_time_deriv_ms: kv.FJ_time_deriv_ms, FI_time_deriv_ms: kv.FI_time_deriv_ms,
    FP_time_deriv_ms: kv.FP_time_deriv_ms, FM_time_ms: kv.FM_time_ms,
  };
}

// Interpolate fluorescence value at time t_ms from a sorted arrays
function interpAt(timeArr, valArr, t_ms) {
  if (t_ms <= timeArr[0]) return valArr[0];
  if (t_ms >= timeArr[timeArr.length - 1]) return valArr[valArr.length - 1];
  let lo = 0, hi = timeArr.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (timeArr[mid] <= t_ms) lo = mid; else hi = mid; }
  const frac = (t_ms - timeArr[lo]) / (timeArr[hi] - timeArr[lo]);
  return valArr[lo] + frac * (valArr[hi] - valArr[lo]);
}

// Trapezoidal integration over indices [a, b)
function trapz(x, y, a, b) {
  let s = 0;
  for (let i = a + 1; i < b; i++) s += (x[i] - x[i - 1]) * (y[i] + y[i - 1]) / 2;
  return s;
}

// Re-calculate key_values for a sample when FJ/FI times change (browser-side)
function recalcKeyValues(fname, fjMs, fiMs) {
  const kv0 = ojipData.key_values[fname];
  const t   = ojipData.time_raw_ms;
  const raw = ojipData.curves[fname].raw;

  const FJ_new = interpAt(t, raw, fjMs);
  const FI_new = interpAt(t, raw, fiMs);

  // Find index closest to FJ, FI, FM times
  const idxOf = (tMs) => { let bi = 0, bd = Infinity; for (let i = 0; i < t.length; i++) { const d = Math.abs(t[i] - tMs); if (d < bd) { bd = d; bi = i; } } return bi; };
  const fjIdx = idxOf(fjMs);
  const fiIdx = idxOf(fiMs);
  const fmIdx = idxOf(kv0.FM_time_ms ?? t[t.length - 1]);
  const fmRaw = raw[fmIdx] ?? kv0.FM;

  const areaBelow = (a, b) => trapz(t, raw, a, b);
  const areaAbove = (a, b) => (t[b - 1] - t[a]) * fmRaw - areaBelow(a, b);

  return {
    ...kv0,
    FJ: FJ_new, FI: FI_new,
    FJ_time_user_ms: fjMs, FI_time_user_ms: fiMs,
    Area_OJ: areaAbove(0, fjIdx),
    Area_JI: areaAbove(fjIdx, fiIdx),
    Area_IP: areaAbove(fiIdx, fmIdx),
    Area_OP: areaAbove(0, fmIdx),
  };
}

function recalcAllParams() {
  paramData = {};
  for (const fname of ojipData.files) {
    paramData[fname] = calcJIP(ojipData.key_values[fname]);
  }
}

// ── init ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Restore saved fluorometer
  const sel = document.getElementById('fluorometer');
  const saved = localStorage.getItem('ojip_fluorometer');
  if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
  sel.addEventListener('change', () => {
    localStorage.setItem('ojip_fluorometer', sel.value);
  });
  // Excel import options (normalization / background / naming) now live inside
  // the post-upload selection modal, not the upload panel — so there is nothing
  // to show/hide here on fluorometer change.
  ExcelNaming.init();

  // Prevent browser from opening dropped files anywhere on the page
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop',    e => e.preventDefault());

  // Drop-zone behaviour
  const dz   = document.getElementById('drop-zone');
  const finp = document.getElementById('ojip-files');
  dz.addEventListener('click', e => { if (e.target.tagName !== 'LABEL' && e.target !== finp) finp.click(); });
  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.style.background = '#e8f4fd'; });
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.style.background = '#e8f4fd'; });
  dz.addEventListener('dragleave', () => { dz.style.background = '#f8f9fa'; });
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.style.background = '#f8f9fa';
    finp.files = e.dataTransfer.files; updateFileList();
  });
  finp.addEventListener('change', updateFileList);

  // Analyze button
  document.getElementById('analyze-btn').addEventListener('click', uploadAndAnalyze);

  // Norm buttons (curves tab)
  document.getElementById('norm-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-norm]'); if (!btn) return;
    setActiveBtn('norm-btns', btn);
    renderCurvesChart(btn.dataset.norm);
  });

  // Param group buttons
  document.getElementById('param-group-btns').addEventListener('click', e => {
    const btn = e.target.closest('[data-pgroup]'); if (!btn) return;
    setActiveBtn('param-group-btns', btn);
    renderParamsChart(btn.dataset.pgroup);
    renderParamsTable(btn.dataset.pgroup);
  });

  // Copy params table
  document.getElementById('copy-params-btn').addEventListener('click', copyParamsTable);

  // Toggle FJ/FI between default (2/30 ms) and auto-detected timings
  document.getElementById('reset-fj-fi-btn').addEventListener('click', toggleFJFI);
  document.getElementById('reset-fj-fi-btn-curves').addEventListener('click', toggleFJFI);

  // Groups tab
  document.getElementById('select-all-check').addEventListener('change', e => {
    document.querySelectorAll('.group-check').forEach(cb => cb.checked = e.target.checked);
  });
  document.getElementById('sort-asc-btn').addEventListener('click',  () => sortFiles('asc'));
  document.getElementById('sort-desc-btn').addEventListener('click', () => sortFiles('desc'));
  document.getElementById('auto-detect-btn').addEventListener('click', autoDetectGroups);
  document.getElementById('clear-groups-btn').addEventListener('click', clearAllGroups);
  document.getElementById('assign-group-btn').addEventListener('click', assignGroup);

  // Pub settings card — any input re-renders all group charts
  const ojipPubBody = document.getElementById('ojip-pub-body');
  if (ojipPubBody) {
    const _onPubChange = () => { readOjipPubSettings(); syncDomFromOjipPub(); if (hasGroups()) _renderAllOjipGroupCharts(); };
    ojipPubBody.addEventListener('input',  _onPubChange);
    ojipPubBody.addEventListener('change', _onPubChange);
  }
  document.getElementById('ojip-pub-reset-btn')?.addEventListener('click', () => {
    ojipPub = Object.assign({}, OJIP_PUB_DEFAULTS);
    ojipPub.perChart = {};
    for (const [k, v] of Object.entries(OJIP_PER_CHART_DEFAULTS)) ojipPub.perChart[k] = Object.assign({}, v);
    try { localStorage.removeItem('ojip_grp_pub'); } catch(e) {}
    syncDomFromOjipPub();
    if (hasGroups()) _renderAllOjipGroupCharts();
  });
  // Per-chart settings — curve charts (re-render only that chart)
  for (const [nm, renderFn, bodyId] of [
    ['raw', renderGrpCurvesRaw, 'grp-raw-body'],
    ['f0',  renderGrpCurvesF0,  'grp-f0-body'],
    ['fm',  renderGrpCurvesFM,  'grp-fm-body'],
    ['dn',  renderGrpCurvesDN,  null],
  ]) {
    const panel = document.getElementById(`ojip-pc-${nm}-panel`);
    if (panel) {
      const _onPc = () => { readOjipPubSettings(); if (hasGroups()) { _withVisible(bodyId ? document.getElementById(bodyId) : null, renderFn); _applyOjipPubAspectRatio(); } };
      panel.addEventListener('input',  _onPc);
      panel.addEventListener('change', _onPc);
    }
  }
  // Per-chart settings — param bar charts
  for (const [nm, renderFn] of [
    ['yields', renderGrpParamsYields], ['fluxes', renderGrpParamsFluxes],
    ['areas',  renderGrpParamsAreas],  ['tech',   renderGrpParamsTech],
  ]) {
    const panel = document.getElementById(`ojip-pc-${nm}-panel`);
    if (panel) {
      const _onPc = () => { readOjipPubSettings(); if (hasGroups()) renderFn(); };
      panel.addEventListener('input',  _onPc);
      panel.addEventListener('change', _onPc);
    }
  }
  // Individual trace toggles
  document.getElementById('show-indiv-raw-check')?.addEventListener('change', () => { if (hasGroups()) _withVisible(document.getElementById('grp-raw-body'), renderGrpCurvesRaw); });
  document.getElementById('show-indiv-f0-check') ?.addEventListener('change', () => { if (hasGroups()) _withVisible(document.getElementById('grp-f0-body'),  renderGrpCurvesF0); });
  document.getElementById('show-indiv-fm-check') ?.addEventListener('change', () => { if (hasGroups()) _withVisible(document.getElementById('grp-fm-body'),  renderGrpCurvesFM); });
  document.getElementById('show-indiv-dn-check') ?.addEventListener('change', () => { if (hasGroups()) renderGrpCurvesDN(); });
  // Resize charts when their collapsed section is expanded
  for (const [bodyId, chartId] of [
    ['grp-raw-body','grp-curves-raw-chart'],
    ['grp-f0-body', 'grp-curves-f0-chart'],
    ['grp-fm-body', 'grp-curves-fm-chart'],
  ]) {
    document.getElementById(bodyId)?.addEventListener('shown.bs.collapse', () => {
      chartInst[chartId]?.resize();
      _applyOjipPubAspectRatio();
    });
  }

  // Export to statistics
  document.getElementById('export-stats-btn').addEventListener('click', exportToStatistics);

  // Diagnostics kr slider
  const krSlider = document.getElementById('kr-slider');
  const krDisp   = document.getElementById('kr-display');
  krSlider.addEventListener('input', () => { krDisp.textContent = krSlider.value; });
  document.getElementById('refit-btn').addEventListener('click', refitSplines);

  // O-J densify checkbox → enable/disable τ input
  const ojDensifyChk = document.getElementById('oj-densify-chk');
  const ojTauInput   = document.getElementById('oj-tau-input');
  if (ojDensifyChk && ojTauInput) {
    ojDensifyChk.addEventListener('change', () => {
      ojTauInput.disabled = !ojDensifyChk.checked;
      if (!ojDensifyChk.checked) {
        document.getElementById('oj-densify-status').textContent = '';
      }
    });
  }

  // Delegated listeners that must survive table rebuilds
  document.getElementById('fjtable').addEventListener('change', _onFJTableChange);
  document.getElementById('group-assign-table').addEventListener('click', _onGroupAssignClick);

  // Sync pub settings panel from saved state
  syncDomFromOjipPub();

  // On tab open: re-render if dirty (data changed while tab was hidden),
  // then resize so Chart.js picks up the now-visible canvas dimensions.
  document.getElementById('ojipTabs').addEventListener('shown.bs.tab', e => {
    const tabId = (e.target.getAttribute('href') || '').slice(1);

    // Multi-curve time-series tab: resize charts on show
    if (tabId === 'tab-timeseries') {
      chartInst['mc-param-time-chart']?.resize();
      chartInst['mc-aggregate-chart']?.resize();
      return;
    }

    if (!ojipData) return;
    renderDirtyTab(tabId); // no-op when not dirty
    if (tabId === 'tab-curves') {
      chartInst['curves-chart']?.resize();
    } else if (tabId === 'tab-params') {
      chartInst['params-chart']?.resize();
    } else if (tabId === 'tab-diag') {
      ['diag-recon-chart', 'diag-resid-chart', 'diag-d2-chart', 'diag-d3-chart']
        .forEach(id => chartInst[id]?.resize());
    } else if (tabId === 'tab-groups') {
      ['grp-curves-raw-chart','grp-curves-f0-chart','grp-curves-fm-chart','grp-curves-dn-chart',
       'grp-params-yields-chart','grp-params-fluxes-chart','grp-params-areas-chart','grp-params-tech-chart']
        .forEach(id => chartInst[id]?.resize());
      _applyOjipPubAspectRatio();
    }
  });
});

// ── Excel naming builder ──────────────────────────────────────────────────
const ExcelNaming = (() => {
  const FIELDS = [
    { key: 'line',     label: 'Line',    example: 'Col-0' },
    { key: 'day',      label: 'Day',     example: 'D1' },
    { key: 'hours',    label: 'Hour',    example: '11:00' },
    { key: 'plantId',  label: 'PlantID', example: '24_STQR_At_199' },
    { key: 'position', label: 'Position',example: 'D4' },
    { key: 'trayId',   label: 'TrayID',  example: '24_STQR_At_Tray010' },
  ];

  // Default: Line, Day, Hour active
  let activeKeys = ['line', 'day', 'hours'];

  function _isActive(key) { return activeKeys.includes(key); }

  function _getSep() {
    return (document.getElementById('excel-naming-sep') || {}).value || '_';
  }

  function _updatePreview() {
    const sep = _getSep();
    const preview = activeKeys
      .map(k => FIELDS.find(f => f.key === k)?.example || k)
      .join(sep);
    const el = document.getElementById('excel-naming-preview');
    if (el) el.textContent = preview || '(no fields selected)';
  }

  function _syncBadges() {
    const container = document.getElementById('excel-naming-blocks');
    if (!container) return;
    const badges = container.querySelectorAll('.excel-name-block');
    // Reorder badges to match activeKeys order, then append inactive ones
    const ordered = [];
    for (const key of activeKeys) {
      for (const b of badges) { if (b.dataset.field === key) { ordered.push(b); break; } }
    }
    for (const b of badges) {
      if (!activeKeys.includes(b.dataset.field)) ordered.push(b);
    }
    for (const b of ordered) {
      b.className = _isActive(b.dataset.field)
        ? 'badge badge-primary excel-name-block'
        : 'badge badge-secondary excel-name-block';
      b.style.opacity = _isActive(b.dataset.field) ? '1' : '0.5';
      container.appendChild(b);
    }
    _updatePreview();
  }

  function init() {
    const container = document.getElementById('excel-naming-blocks');
    if (!container) return;

    // Click to toggle
    container.addEventListener('click', e => {
      const badge = e.target.closest('.excel-name-block');
      if (!badge) return;
      const key = badge.dataset.field;
      if (_isActive(key)) {
        activeKeys = activeKeys.filter(k => k !== key);
      } else {
        activeKeys.push(key);
      }
      _syncBadges();
    });

    // Drag-and-drop reorder
    let dragEl = null;
    container.addEventListener('dragstart', e => {
      dragEl = e.target.closest('.excel-name-block');
      if (dragEl) e.dataTransfer.effectAllowed = 'move';
    });
    container.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    container.addEventListener('drop', e => {
      e.preventDefault();
      const target = e.target.closest('.excel-name-block');
      if (!dragEl || !target || dragEl === target) return;
      const dKey = dragEl.dataset.field;
      const tKey = target.dataset.field;
      // Move dKey to position of tKey in activeKeys
      if (_isActive(dKey)) {
        activeKeys = activeKeys.filter(k => k !== dKey);
        const tIdx = activeKeys.indexOf(tKey);
        if (tIdx >= 0) activeKeys.splice(tIdx, 0, dKey);
        else activeKeys.push(dKey);
      }
      _syncBadges();
    });

    // Separator change
    const sepInput = document.getElementById('excel-naming-sep');
    if (sepInput) sepInput.addEventListener('input', _updatePreview);

    _syncBadges();
  }

  function buildName(curve) {
    const sep = _getSep();
    if (!activeKeys.length) return `${curve.index + 1}`;
    return activeKeys.map(k => curve[k] || '').join(sep);
  }

  function getActiveKeys() { return activeKeys.slice(); }

  return { init, buildName, getActiveKeys, FIELDS };
})();

// ── file list helper ──────────────────────────────────────────────────────
function updateFileList() {
  const files = document.getElementById('ojip-files').files;
  const lbl   = document.getElementById('file-count-label');
  const list  = document.getElementById('file-list');
  if (!files.length) { lbl.textContent = 'No files selected'; list.innerHTML = ''; document.getElementById('analyze-btn').disabled = true; return; }
  lbl.textContent = `${files.length} file(s) selected`;
  list.innerHTML = [...files].map(f => `<span class="badge badge-light border mr-1">${f.name}</span>`).join('');
  document.getElementById('analyze-btn').disabled = false;
}

// ── upload & analyze ──────────────────────────────────────────────────────
async function uploadAndAnalyze() {
  const files = document.getElementById('ojip-files').files;
  if (!files.length) return;

  const fluorometer = document.getElementById('fluorometer').value;

  // ── OJIP Imaging Excel file detection ──
  if (fluorometer === 'OJIPImaging') {
    const xlsxFile = [...files].find(f => f.name.toLowerCase().endsWith('.xlsx'));
    if (!xlsxFile) {
      const errDiv = document.getElementById('upload-error');
      errDiv.innerHTML = '<strong>No .xlsx file found.</strong> Please select an Excel file for OJIP Imaging.';
      errDiv.style.display = '';
      return;
    }
    setLoading(true);
    try {
      const dataset = await MC.parseExcel(xlsxFile);
      setLoading(false);
      if (dataset && dataset.curves.length > 0) {
        mcDataset = dataset;
        mcIsActive = true;
        MC.showExcelSelectionModal(dataset);
        return; // selection modal takes over the flow
      }
    } catch(e) {
      setLoading(false);
      const errDiv = document.getElementById('upload-error');
      errDiv.innerHTML = `<strong>Excel parsing error:</strong> ${e.message}`;
      errDiv.style.display = '';
      return;
    }
  }

  // ── Multi-curve detection: check .txt files for FluorPen multi-curve format ──
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.txt')) {
      try {
        const isMC = await MC.isMultiCurve(f);
        if (isMC) {
          // Parse the full file client-side
          setLoading(true);
          const dataset = await MC.parse(f);
          setLoading(false);
          if (dataset && dataset.curves.length > 1) {
            mcDataset = dataset;
            mcIsActive = true;
            MC.showSelectionModal(dataset);
            return; // selection modal takes over the flow
          }
        }
      } catch(e) {
        console.warn('Multi-curve detection failed for', f.name, e);
      }
    }
  }

  const fd = new FormData();
  for (const f of files) fd.append('OJIP_files', f);
  fd.append('fluorometer', document.getElementById('fluorometer').value);
  fd.append('FJ_time',     document.getElementById('FJ_time').value);
  fd.append('FI_time',     document.getElementById('FI_time').value);
  fd.append('knots_reduction_factor', document.getElementById('kr_input').value);
  fd.append('fit_method', (document.getElementById('fit-method-sel')?.value || 'logspline'));
  fd.append('trim_first', document.getElementById('trim-first-input')?.value || '0');
  fd.append('trim_last',  document.getElementById('trim-last-input')?.value  || '0');
  fd.append('background_mode', document.getElementById('bg-mode-sel')?.value || 'auto');
  fd.append('background_n',    document.getElementById('bg-n-input')?.value || '1');
  fd.append('f0_source',       document.getElementById('f0-source-sel')?.value || 'instrument');
  fd.append('knot_placement',  document.getElementById('knot-placement-sel')?.value || 'hybrid');
  if (document.getElementById('reduce_size').checked) fd.append('checkbox_reduce_file_size', 'checked');

  // Pre-flight size check — avoid a silent connection-reset from the server
  // when MAX_CONTENT_LENGTH is exceeded (browser sees NetworkError, not 413).
  const MAX_UPLOAD_BYTES = 90 * 1024 * 1024; // 90 MB safety margin under server's 100 MB limit
  const totalBytes = [...files].reduce((s, f) => s + f.size, 0);

  const errDiv = document.getElementById('upload-error');
  errDiv.style.display = 'none';

  if (totalBytes > MAX_UPLOAD_BYTES) {
    const totalMB = (totalBytes / 1024 / 1024).toFixed(1);
    errDiv.innerHTML =
      `<strong>Upload too large (${totalMB} MB total)</strong> — the server limit is ~90 MB per batch.<br>` +
      `Please split the ${files.length} files into smaller batches and upload them separately.`;
    errDiv.style.display = '';
    return;
  }

  setLoading(true);

  const fileNames = [...files].map(f => f.name).join(', ');

  try {
    const resp = await fetch('/api/ojip_process', { method: 'POST', body: fd });

    if (resp.status === 413) {
      errDiv.innerHTML =
        `<strong>Upload too large (HTTP 413)</strong> — the server rejected the request because the total file size is too large.<br>` +
        `Try uploading fewer files at once, or ask your server administrator to increase the upload size limit.`;
      errDiv.style.display = '';
      return;
    }

    const rawText = await resp.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      // Server returned non-JSON — show first 600 chars of the response for debugging
      const preview = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
      errDiv.innerHTML =
        `<strong>Server error</strong> (HTTP ${resp.status}) while processing:<br>` +
        `<em>${fileNames}</em><br><br>` +
        `<details><summary>Server response (click to expand)</summary>` +
        `<pre style="font-size:0.78em;white-space:pre-wrap;max-height:200px;overflow:auto">${preview}</pre></details>`;
      errDiv.style.display = '';
      return;
    }

    if (data.status === 'error') {
      errDiv.innerHTML =
        `<strong>Processing error</strong> for files: <em>${fileNames}</em><br>${data.message}`;
      errDiv.style.display = '';
      return;
    }

    ojipData = data;
    groups   = {};
    // Sync annotation instrument select with the OJIP fluorometer selection so
    // the field is pre-filled when the user switches to the Annotation tab.
    if (data.fluorometer) {
      const annSel = document.getElementById('fluor-instrument');
      if (annSel) {
        annSel.value = data.fluorometer;
        if (typeof ANN !== 'undefined') ANN.onInstrumentChange(data.fluorometer);
      }
    }
    recalcAllParams();
    document.getElementById('results-section').style.display = '';
    // The batch flag panel (fit/conf banners + cutoffs) is multi-curve only.
    const flagPanel = document.getElementById('mc-flag-panel');
    if (flagPanel) flagPanel.style.display = 'none';
    renderResults();
    document.getElementById('results-section').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);
    const sizeHint = totalBytes > 50 * 1024 * 1024
      ? `<br><small>Total upload size was ${sizeMB} MB — if this is close to the server limit, try splitting into smaller batches.</small>`
      : '';
    errDiv.innerHTML =
      `<strong>Network error</strong> while uploading: <em>${fileNames}</em><br>${err.message}${sizeHint}`;
    errDiv.style.display = '';
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  const btn = document.getElementById('analyze-btn');
  const sp  = document.getElementById('analyze-spinner');
  btn.disabled = on;
  sp.style.display = on ? '' : 'none';
}

// ── multi-curve: show/hide placeholders in detail tabs ────────────────────
function mcShowPlaceholders(show) {
  document.querySelectorAll('.mc-tab-placeholder').forEach(el => {
    el.style.display = show ? '' : 'none';
    // Hide or show the real tab content (all siblings after the placeholder)
    let sib = el.nextElementSibling;
    while (sib) {
      sib.style.display = show ? 'none' : '';
      sib = sib.nextElementSibling;
    }
  });
}

// ── multi-curve: start batch analysis from selection modal ────────────────
async function mcStartAnalysis() {
  const selected = MC.getSelectedIndices();
  if (!selected.length) return;

  // Apply the Excel import options chosen in the modal (normalization column,
  // background/F0 mode, and curve naming) before building the batch. Curve
  // indices are preserved, so the current selection stays valid.
  if (mcDataset && mcDataset.fluorometer === 'OJIPImaging' && mcDataset._excel) {
    MC.resolveExcelDataset(
      mcDataset,
      document.getElementById('excel-norm-col')?.value,
      document.getElementById('excel-bg-mode')?.value);
  }

  // Close the selection modal
  $('#mc-selection-modal').modal('hide');

  // Show results section and configure for multi-curve mode
  document.getElementById('results-section').style.display = '';

  // Show placeholders in detail tabs (Curves, Params, Diag, etc.)
  mcShowPlaceholders(true);

  // Update summary bar
  document.getElementById('results-summary').textContent =
    `Multi-curve analysis — ${selected.length} curves selected from ${mcDataset.filename}`;

  // Show time-series tab, switch to it
  const tsLi = document.getElementById('tab-timeseries-li');
  if (tsLi) tsLi.style.display = '';
  $('[href="#tab-timeseries"]').tab('show');

  // Hide single-file download bar (not applicable for multi-curve)
  const xlsxLink = document.getElementById('xlsx-download-link');
  if (xlsxLink) xlsxLink.style.display = 'none';

  // Show multi-curve export buttons (CSV, XLSX, ZIP) in the bottom download bar
  for (const id of ['mc-csv-btn', 'mc-xlsx-btn', 'mc-batch-export-btn']) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  }

  // Reset caches
  mcDetailCache = {};
  paramMatrix = null;

  // JIP options from the form
  const jipOpts = {
    FJ_time:   parseFloat(document.getElementById('FJ_time').value) || 2.0,
    FI_time:   parseFloat(document.getElementById('FI_time').value) || 30.0,
    kr:        parseInt(document.getElementById('kr_input').value) || 10,
    fitMethod:  (document.getElementById('fit-method-sel')?.value || 'logspline'),
    trimFirst:  parseInt(document.getElementById('trim-first-input')?.value) || 0,
    trimLast:   parseInt(document.getElementById('trim-last-input')?.value)  || 0,
    bgMode:     document.getElementById('bg-mode-sel')?.value || 'auto',
    bgN:        parseInt(document.getElementById('bg-n-input')?.value) || 1,
    f0Source:   document.getElementById('f0-source-sel')?.value || 'instrument',
    knotPlacement: document.getElementById('knot-placement-sel')?.value || 'hybrid',
    ojDensify: false,
    ojTauMs:   null,
    f0TimMs:   null,
  };
  _lastSelected = selected.slice();
  _lastJipOpts  = Object.assign({}, jipOpts);

  // Scroll to results
  document.getElementById('results-section').scrollIntoView({ behavior: 'smooth' });

  // Run the batch params pass
  const result = await MC.runParamsPass(mcDataset, selected, jipOpts);

  if (result) {
    // Show/hide grouping controls and chart options for Excel OJIPImaging data
    const isOJIPImg = mcDataset.fluorometer === 'OJIPImaging';
    const groupCtrl = document.getElementById('mc-group-controls');
    if (groupCtrl) groupCtrl.style.display = isOJIPImg ? '' : 'none';
    const chartOpts = document.getElementById('mc-chart-opts');
    if (chartOpts) chartOpts.style.display = isOJIPImg ? '' : 'none';
    // Hide timestamp checkbox for OJIPImaging (X-axis is controlled by dropdown instead)
    const tsCheckWrap = document.getElementById('mc-ts-checkbox-wrap');
    if (tsCheckWrap) tsCheckWrap.style.display = isOJIPImg ? 'none' : '';
    // Hide summary table on new analysis
    const summaryWrap = document.getElementById('mc-summary-table-wrap');
    if (summaryWrap) summaryWrap.style.display = 'none';
    // Show/hide grouped panels card and compare card
    const panelsCard  = document.getElementById('mc-grouped-panels-card');
    const compareCard = document.getElementById('mc-compare-card');
    if (panelsCard)  panelsCard.style.display  = isOJIPImg ? '' : 'none';
    if (compareCard) compareCard.style.display = isOJIPImg ? '' : 'none';

    // Render time-series overview
    MC.renderTimeSeries();
    MC.renderAggregateCurves();
    // renderGroupedPanels also calls renderComparison at its tail
    if (isOJIPImg) MC.renderGroupedPanels();

    // Update summary with completion info
    const errors = result.filter(r => r && r.error).length;
    const ok = result.filter(r => r && !r.error).length;
    document.getElementById('results-summary').textContent =
      `Multi-curve analysis complete — ${ok} curves analyzed` +
      (errors ? `, ${errors} errors` : '') +
      ` — ${mcDataset.filename}`;

    // Batch quality banners (fit + timing confidence)
    _updateBatchQualityAlerts(result);
  }
}

// ── render all results ────────────────────────────────────────────────────
function renderResults() {
  const n = ojipData.files.length;
  document.getElementById('results-summary').textContent =
    `${n} file${n > 1 ? 's' : ''} processed — ${ojipData.fluorometer} — FJ ${ojipData.fj_time_ms} ms / FI ${ojipData.fi_time_ms} ms`;

  // Single xlsx — all data, charts, and methods
  const link = document.getElementById('xlsx-download-link');
  link.href = '#';
  link.onclick = e => { e.preventDefault(); downloadXlsxWithCharts(); };
  link.style.display = '';

  // Reset FJ/FI toggle to default state for fresh data
  fjfiMode = 'default';
  _updateFJFIBtnLabels();

  renderCurvesChart('raw');
  buildFJTable();
  buildGroupAssignTable();

  // Sync kr slider to current kr
  document.getElementById('kr-slider').value = ojipData.kr;
  document.getElementById('kr-display').textContent = ojipData.kr;
  document.getElementById('kr_input').value = ojipData.kr;

  // Pre-render params and diag charts right now, while temporarily forcing
  // their hidden panes to display:block so Chart.js measures real dimensions.
  _withPaneVisible('tab-params', () => {
    renderParamsChart('yields');
    renderParamsTable('yields');
  });
  _withPaneVisible('tab-diag', () => {
    renderDiagnostics();
  });

  // Groups tab is still lazy — its content depends on user group assignments.
  markTabsDirty('tab-groups');
}

// ── helper: set active button in a group ─────────────────────────────────
function setActiveBtn(groupId, activeBtn) {
  document.querySelectorAll(`#${groupId} .btn`).forEach(b => {
    b.classList.replace('btn-primary', 'btn-outline-primary');
  });
  activeBtn.classList.replace('btn-outline-primary', 'btn-primary');
}

// ── curves chart ──────────────────────────────────────────────────────────
function renderCurvesChart(norm) {
  const files = ojipData.files;
  const t     = ojipData.time_raw_ms;
  const n     = files.length;

  const datasets = files.map((fname, i) => ({
    label: fname,
    data:  ojipData.curves[fname][norm].map((y, j) => ({ x: t[j], y })),
    borderColor: sampleColor(i, n),
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    pointRadius: 0,
    showLine: true,
  }));

  // FJ markers (▲ triangles) — one point per file, colour-matched to its curve
  // Use the user/editable timing (FJ_time_user_ms) so that manual edits and
  // the "Reset FJ/FI" button are immediately reflected on the chart.
  const fjData = [], fjBg = [], fjBd = [];
  files.forEach((fname, i) => {
    const kv  = ojipData.key_values[fname];
    const fjT = kv.FJ_time_user_ms;
    if (fjT != null) {
      fjData.push({ x: fjT, y: interpAt(t, ojipData.curves[fname][norm], fjT) });
      fjBg.push(sampleColor(i, n)); fjBd.push(sampleColor(i, n));
    }
  });
  if (fjData.length) {
    datasets.push({
      label: 'FJ', showLine: false, data: fjData,
      pointRadius: 6, pointStyle: 'triangle',
      pointBackgroundColor: fjBg, pointBorderColor: fjBd,
      borderColor: 'transparent', backgroundColor: 'transparent',
    });
  }

  // FI markers (◆ diamonds) — same logic
  const fiData = [], fiBg = [], fiBd = [];
  files.forEach((fname, i) => {
    const kv  = ojipData.key_values[fname];
    const fiT = kv.FI_time_user_ms;
    if (fiT != null) {
      fiData.push({ x: fiT, y: interpAt(t, ojipData.curves[fname][norm], fiT) });
      fiBg.push(sampleColor(i, n)); fiBd.push(sampleColor(i, n));
    }
  });
  if (fiData.length) {
    datasets.push({
      label: 'FI', showLine: false, data: fiData,
      pointRadius: 6, pointStyle: 'rectRot',
      pointBackgroundColor: fiBg, pointBorderColor: fiBd,
      borderColor: 'transparent', backgroundColor: 'transparent',
    });
  }

  // FP markers (■ squares) — only for files where FP timing is available
  const fpData = [], fpBg = [], fpBd = [];
  files.forEach((fname, i) => {
    const fpT = ojipData.key_values[fname].FP_time_deriv_ms;
    if (fpT != null) {
      fpData.push({ x: fpT, y: interpAt(t, ojipData.curves[fname][norm], fpT) });
      fpBg.push(sampleColor(i, n)); fpBd.push(sampleColor(i, n));
    }
  });
  if (fpData.length) {
    datasets.push({
      label: 'FP', showLine: false, data: fpData,
      pointRadius: 6, pointStyle: 'rect',
      pointBackgroundColor: fpBg, pointBorderColor: fpBd,
      borderColor: 'transparent', backgroundColor: 'transparent',
    });
  }

  const yLabel = norm === 'raw' ? 'Fluorescence' :
                 norm === 'double_norm' ? 'Normalised fluorescence (r.u.)' :
                 'Fluorescence (shifted)';

  const opts = logScatterOpts('Time (ms)', yLabel);
  opts.onClick = (e, elements) => {
    if (!elements.length) return;
    const dsIdx = elements[0].datasetIndex;
    if (dsIdx >= n) return;                    // FJ / FI / FP marker row — ignore
    const fname = ojipData.files[dsIdx];
    if (fname && confirm(`Remove "${fname}" from analysis?`)) removeFile(fname);
  };
  opts.onHover = (e, elements) => {
    const hit = elements.length > 0 && elements[0].datasetIndex < n;
    e.native.target.style.cursor = hit ? 'pointer' : 'default';
  };

  makeChart('curves-chart', { type: 'scatter', data: { datasets }, options: opts });
}

// ── remove one file from all analysis data ────────────────────────────────
function removeFile(fname) {
  const idx = ojipData.files.indexOf(fname);
  if (idx === -1) return;
  ojipData.files.splice(idx, 1);
  delete ojipData.curves[fname];
  delete ojipData.key_values[fname];
  delete paramData[fname];
  delete groups[fname];

  const n = ojipData.files.length;
  document.getElementById('results-summary').textContent =
    `${n} file${n !== 1 ? 's' : ''} processed — ${ojipData.fluorometer} — FJ ${ojipData.fj_time_ms} ms / FI ${ojipData.fi_time_ms} ms`;

  if (!n) { document.getElementById('results-section').style.display = 'none'; return; }

  const norm   = document.querySelector('#norm-btns .btn-primary')?.dataset?.norm   || 'raw';
  const pgroup = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'yields';
  const tab    = activeTabId();
  renderCurvesChart(norm);
  buildFJTable();
  buildGroupAssignTable();
  for (const [f, g] of Object.entries(groups)) updateGroupBadge(f, g);
  refreshGroupSummary();
  if (tab === 'tab-params') { renderParamsChart(pgroup); renderParamsTable(pgroup); }
  else markTabsDirty('tab-params');
  checkGroupsReady();
  if (tab === 'tab-diag') renderDiagnostics();
  else markTabsDirty('tab-diag');
}

// ── FJ/FI editable table ──────────────────────────────────────────────────
function buildFJTable() {
  const tbody = document.getElementById('fjtable-body');
  tbody.innerHTML = '';
  ojipData.files.forEach(fname => {
    const kv = ojipData.key_values[fname];
    const p  = paramData[fname];
    const tr = document.createElement('tr');
    tr.dataset.fname = fname;
    tr.innerHTML = `
      <td>${fname}</td>
      <td><input type="number" class="form-control form-control-sm fj-edit" data-fname="${fname}"
           value="${kv.FJ_time_user_ms.toFixed(2)}" step="0.1" min="0.01" max="50"
           style="width:80px"></td>
      <td><input type="number" class="form-control form-control-sm fi-edit" data-fname="${fname}"
           value="${kv.FI_time_user_ms.toFixed(2)}" step="0.1" min="1" max="500"
           style="width:80px"></td>
      <td class="fj-auto">${fmt(kv.FJ_time_deriv_ms)}</td>
      <td class="fi-auto">${fmt(kv.FI_time_deriv_ms)}</td>
      <td class="fp-auto">${fmt(kv.FP_time_deriv_ms)}</td>
      <td>${fmt(kv.F0)}</td>
      <td>${fmt(kv.FM)}</td>
      <td>${fmt(kv.FK)}</td>
      <td class="fvfm-cell">${fmt(p.FVFM)}</td>`;
    tbody.appendChild(tr);
  });

}

// FJ/FI live-update — delegated on the persistent #fjtable element (set up once in DOMContentLoaded)
function _onFJTableChange(e) {
  const inp = e.target;
  if (!inp.matches('.fj-edit, .fi-edit')) return;
  const fname = inp.dataset.fname;
  const tr    = inp.closest('tr');
  const fjMs  = parseFloat(tr.querySelector('.fj-edit').value);
  const fiMs  = parseFloat(tr.querySelector('.fi-edit').value);
  if (isNaN(fjMs) || isNaN(fiMs) || fjMs >= fiMs) return;
  const newKv = recalcKeyValues(fname, fjMs, fiMs);
  ojipData.key_values[fname] = newKv;
  paramData[fname] = calcJIP(newKv);
  tr.querySelector('.fvfm-cell').textContent = fmt(paramData[fname].FVFM);
  // Always update curves (FJ/FI marker positions changed)
  const norm = document.querySelector('#norm-btns .btn-primary')?.dataset?.norm || 'raw';
  renderCurvesChart(norm);
  // Update params only if that tab is currently visible
  const activeGroup = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'yields';
  if (activeTabId() === 'tab-params') { renderParamsChart(activeGroup); renderParamsTable(activeGroup); }
  else markTabsDirty('tab-params');
  if (hasGroups()) {
    if (activeTabId() === 'tab-groups') _renderAllOjipGroupCharts();
    else markTabsDirty('tab-groups');
  }
}

function fmt(v, d = 4) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(d);
}

// ── parameters chart ──────────────────────────────────────────────────────
function renderParamsChart(group) {
  const params  = PARAM_GROUPS[group];
  const files   = ojipData.files;
  const labels  = params.map(p => PARAM_LABELS[p] || p);
  const datasets = files.map((fname, i) => ({
    label: fname,
    data:  params.map(p => { const v = paramData[fname][p]; return isFinite(v) ? v : null; }),
    backgroundColor: sampleColor(i, files.length, 0.7),
    borderColor:     sampleColor(i, files.length),
    borderWidth: 1,
  }));
  makeChart('params-chart', { type: 'bar', data: { labels, datasets }, options: barOpts() });
}

// ── parameters table ──────────────────────────────────────────────────────
function renderParamsTable(group) {
  const params  = PARAM_GROUPS[group];
  const files   = ojipData.files;
  const head    = document.getElementById('params-table-head');
  const body    = document.getElementById('params-table-body');
  head.innerHTML = `<th>Sample</th>` + params.map(p => `<th>${PARAM_LABELS[p] || p}</th>`).join('');
  body.innerHTML = files.map(fname => {
    const row = params.map(p => `<td>${fmt(paramData[fname][p])}</td>`).join('');
    return `<tr><td>${fname}</td>${row}</tr>`;
  }).join('');
}

function copyParamsTable() {
  const rows = [...document.querySelectorAll('#params-table tr')];
  const text = rows.map(r => [...r.querySelectorAll('th,td')].map(c => c.textContent.trim()).join('\t')).join('\n');
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-params-btn');
    btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy table', 1500);
  });
}

// ── group assignment ──────────────────────────────────────────────────────
function buildGroupAssignTable() {
  const tbody = document.getElementById('group-assign-body');
  tbody.innerHTML = '';
  ojipData.files.forEach(fname => {
    const tr = document.createElement('tr');
    tr.dataset.fname = fname;
    tr.innerHTML = `
      <td><input type="checkbox" class="group-check" value="${fname}"></td>
      <td>${fname}</td>
      <td><span class="group-badge" id="gbadge-${esc(fname)}">—</span></td>
      <td><button class="btn btn-sm btn-link text-danger p-0 remove-group-btn" data-fname="${fname}">✕</button></td>`;
    tbody.appendChild(tr);
  });
}

// Group-assignment remove — delegated on persistent #group-assign-table (set up once in DOMContentLoaded)
function _onGroupAssignClick(e) {
  if (!e.target.classList.contains('remove-group-btn')) return;
  const fname = e.target.dataset.fname;
  delete groups[fname];
  updateGroupBadge(fname, null);
  refreshGroupSummary(); checkGroupsReady();
}

function esc(s) { return s.replace(/[^a-z0-9]/gi, '_'); }

function assignGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) { alert('Please enter a group name.'); return; }
  const checked = [...document.querySelectorAll('.group-check:checked')];
  if (!checked.length) { alert('Please select at least one sample.'); return; }
  checked.forEach(cb => { groups[cb.value] = name; updateGroupBadge(cb.value, name); cb.checked = false; });
  document.getElementById('select-all-check').checked = false;
  refreshGroupSummary(); checkGroupsReady();
}

function sortFiles(order) {
  ojipData.files.sort((a, b) => order === 'asc' ? a.localeCompare(b) : b.localeCompare(a));
  const norm   = document.querySelector('#norm-btns .btn-primary')?.dataset?.norm   || 'raw';
  const pgroup = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'yields';
  const tab    = activeTabId();
  renderCurvesChart(norm);
  buildFJTable();
  buildGroupAssignTable();
  for (const [f, g] of Object.entries(groups)) updateGroupBadge(f, g);
  refreshGroupSummary();
  if (tab === 'tab-params') { renderParamsChart(pgroup); renderParamsTable(pgroup); }
  else markTabsDirty('tab-params');
  checkGroupsReady();
  if (tab === 'tab-diag') renderDiagnostics();
  else markTabsDirty('tab-diag');
}

function autoDetectGroups() {
  // Group by longest common prefix (up to first digit or underscore pattern)
  ojipData.files.forEach(fname => {
    const m = fname.match(/^([a-z_\- ]+)/i);
    const grp = m ? m[1].replace(/[_\- ]+$/, '') : fname;
    groups[fname] = grp; updateGroupBadge(fname, grp);
  });
  refreshGroupSummary(); checkGroupsReady();
}

function clearAllGroups() { groups = {}; ojipData.files.forEach(f => updateGroupBadge(f, null)); refreshGroupSummary(); document.getElementById('group-results').style.display = 'none'; }

function updateGroupBadge(fname, grpName) {
  const el = document.getElementById(`gbadge-${esc(fname)}`);
  if (!el) return;
  if (grpName) { el.className = 'badge badge-primary'; el.textContent = grpName; }
  else         { el.className = ''; el.textContent = '—'; }
}

function refreshGroupSummary() {
  const grpMap = {};
  for (const [f, g] of Object.entries(groups)) { (grpMap[g] = grpMap[g] || []).push(f); }
  const html = Object.entries(grpMap).map(([g, files]) =>
    `<span class="badge badge-light border mr-1"><strong>${g}</strong>: ${files.length} sample(s)</span>`
  ).join('');
  document.getElementById('groups-summary').innerHTML = html;
}

function hasGroups() { return new Set(Object.values(groups)).size >= 2; }

function checkGroupsReady() {
  if (hasGroups()) {
    document.getElementById('group-results').style.display = '';
    if (activeTabId() === 'tab-groups') _renderAllOjipGroupCharts();
    else markTabsDirty('tab-groups');
  } else {
    document.getElementById('group-results').style.display = 'none';
    dirtyTabs.delete('tab-groups');
  }
}

// ── group statistics ──────────────────────────────────────────────────────
function calcGroupStats() {
  const grpFiles = {};
  for (const [f, g] of Object.entries(groups)) (grpFiles[g] = grpFiles[g] || []).push(f);

  const stats = {};
  for (const [grp, files] of Object.entries(grpFiles)) {
    stats[grp] = { files, curves: {}, params: {} };

    // Mean + SD per normMode (raw time axis)
    for (const nm of ['raw', 'shifted_F0', 'shifted_FM', 'double_norm']) {
      const arrs = files.map(f => ojipData.curves[f][nm]);
      const len  = arrs[0].length;
      const means = [], sds = [];
      for (let j = 0; j < len; j++) {
        const vals = arrs.map(a => a[j]).filter(v => v != null && isFinite(v));
        const mu   = vals.reduce((s, v) => s + v, 0) / vals.length;
        const sd   = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / vals.length);
        means.push(mu); sds.push(sd);
      }
      stats[grp].curves[nm] = { means, sds };
    }

    // Mean + SD per parameter
    const allP = Object.keys(PARAM_GROUPS).flatMap(g => PARAM_GROUPS[g]);
    for (const p of allP) {
      const vals = files.map(f => paramData[f]?.[p]).filter(v => v != null && isFinite(v));
      if (!vals.length) continue;
      const mu = vals.reduce((s, v) => s + v, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / vals.length);
      stats[grp].params[p] = { mean: mu, sd, n: vals.length };
    }
  }
  return stats;
}

// ── helper: force a collapsed element visible so Chart.js can measure it ──
function _withVisible(el, fn) {
  if (!el) { fn(); return; }
  const hidden = getComputedStyle(el).display === 'none';
  if (hidden) { el.style.display='block'; el.style.visibility='hidden'; void el.offsetWidth; }
  fn();
  if (hidden) { el.style.display=''; el.style.visibility=''; }
}

// ── group curve dataset builder ───────────────────────────────────────────
function _buildGrpCurveDatasets(norm, showIndiv) {
  const stats=calcGroupStats(), grps=Object.keys(stats), t=ojipData.time_raw_ms;
  const s=ojipPub, sdOp=(s.sdBandOpacity||18)/100;
  const ds=[];
  grps.forEach((grp,gi)=>{
    const {means,sds}=stats[grp].curves[norm];
    const c=_ojipPubColor(gi,grps.length), ca=_ojipPubColor(gi,grps.length,sdOp);
    ds.push({label:'',showLine:true,pointRadius:0,borderWidth:0,borderColor:'transparent',backgroundColor:ca,
             data:means.map((m,j)=>({x:t[j],y:m+sds[j]})),fill:'+1'});
    ds.push({label:'',showLine:true,pointRadius:0,borderWidth:0,borderColor:'transparent',backgroundColor:ca,
             data:means.map((m,j)=>({x:t[j],y:m-sds[j]})),fill:false});
    ds.push({label:grp,showLine:true,pointRadius:0,borderWidth:s.lineWidthMean||2.5,
             borderColor:c,backgroundColor:'transparent',data:means.map((m,j)=>({x:t[j],y:m})),fill:false});
    if (showIndiv) {
      const ci=_ojipPubColor(gi,grps.length,0.35);
      stats[grp].files.forEach(fname=>{
        ds.push({label:'',showLine:true,pointRadius:0,borderWidth:s.lineWidthIndiv||0.8,
                 borderColor:ci,backgroundColor:'transparent',
                 data:ojipData.curves[fname][norm].map((y,j)=>({x:t[j],y})),fill:false});
      });
    }
  });
  return ds;
}

function _makeGrpCurveChart(chartId, norm, showIndiv, pc) {
  const yLabel = pc?.yTitle || (norm==='double_norm' ? 'Normalised fluorescence (r.u.)' : 'Fluorescence');
  const opts   = logScatterOpts('Time (ms)', yLabel);
  _applyOjipPubToOpts(opts, false, pc);
  makeChart(chartId, { type:'scatter', data:{datasets:_buildGrpCurveDatasets(norm,showIndiv)},
    options:opts, plugins:[_ojipPubBgPlugin(),_ojipPubBorderPlugin()] });
}

function _makeGrpParamChart(chartId, pgroup, pc) {
  const stats=calcGroupStats(), grps=Object.keys(stats);
  const params=PARAM_GROUPS[pgroup], labels=params.map(p=>PARAM_LABELS[p]||p);
  const ds=grps.map((grp,gi)=>({
    label:grp,
    data:params.map(p=>{const st=stats[grp].params[p]; return st?{y:st.mean,yMin:st.mean-st.sd,yMax:st.mean+st.sd}:null;}),
    backgroundColor:_ojipPubColor(gi,grps.length,0.65), borderColor:_ojipPubColor(gi,grps.length), borderWidth:1,
    errorBarColor:_ojipPubColor(gi,grps.length), errorBarWhiskerColor:_ojipPubColor(gi,grps.length),
    errorBarLineWidth:2, errorBarWhiskerSize:8,
  }));
  const opts=barOpts();
  _applyOjipPubToOpts(opts, true, pc);
  makeChart(chartId, { type:'barWithErrorBars', data:{labels,datasets:ds},
    options:opts, plugins:[_ojipPubBgPlugin(),_ojipPubBorderPlugin()] });
}

function _checkIndiv(id) { return document.getElementById(id)?.checked !== false; }

function renderGrpCurvesRaw()    { _makeGrpCurveChart('grp-curves-raw-chart','raw',        _checkIndiv('show-indiv-raw-check'), ojipPub.perChart.raw); }
function renderGrpCurvesF0()     { _makeGrpCurveChart('grp-curves-f0-chart', 'shifted_F0', _checkIndiv('show-indiv-f0-check'),  ojipPub.perChart.shifted_F0); }
function renderGrpCurvesFM()     { _makeGrpCurveChart('grp-curves-fm-chart', 'shifted_FM', _checkIndiv('show-indiv-fm-check'),  ojipPub.perChart.shifted_FM); }
function renderGrpCurvesDN()     { _makeGrpCurveChart('grp-curves-dn-chart', 'double_norm',_checkIndiv('show-indiv-dn-check'),  ojipPub.perChart.double_norm); }
function renderGrpParamsYields() { _makeGrpParamChart('grp-params-yields-chart','yields',ojipPub.perChart.params_yields); }
function renderGrpParamsFluxes() { _makeGrpParamChart('grp-params-fluxes-chart','fluxes',ojipPub.perChart.params_fluxes); }
function renderGrpParamsAreas()  { _makeGrpParamChart('grp-params-areas-chart', 'areas', ojipPub.perChart.params_areas); }
function renderGrpParamsTech()   { _makeGrpParamChart('grp-params-tech-chart',  'tech',  ojipPub.perChart.params_tech); }

function _renderAllOjipGroupCharts() {
  _withVisible(document.getElementById('grp-raw-body'), renderGrpCurvesRaw);
  _withVisible(document.getElementById('grp-f0-body'),  renderGrpCurvesF0);
  _withVisible(document.getElementById('grp-fm-body'),  renderGrpCurvesFM);
  renderGrpCurvesDN();
  renderGrpParamsYields();
  renderGrpParamsFluxes();
  renderGrpParamsAreas();
  renderGrpParamsTech();
  _applyOjipPubAspectRatio();
}

// ── diagnostics ───────────────────────────────────────────────────────────

/**
 * Return { tMin, tMax } time range (ms) for diagnostic plot display,
 * derived from the plot-trim-first/last inputs applied to the raw time axis.
 */
function _diagPlotTrimRange() {
  const first = Math.max(0, parseInt(document.getElementById('plot-trim-first-input')?.value) || 0);
  const last  = Math.max(0, parseInt(document.getElementById('plot-trim-last-input')?.value)  || 0);
  if (!ojipData || !ojipData.time_raw_ms || ojipData.time_raw_ms.length === 0)
    return { tMin: -Infinity, tMax: Infinity };
  const tRaw = ojipData.time_raw_ms;
  const n = tRaw.length;
  const startIdx = Math.min(first, n - 1);
  const endIdx   = Math.max(startIdx, n - 1 - last);
  return { tMin: tRaw[startIdx] ?? -Infinity, tMax: tRaw[endIdx] ?? Infinity };
}

// Mirror the upload-panel Background/F0 controls into the results toolbar and
// keep the two copies in lock-step, so every reader that reads the upload-panel
// IDs still sees the current value regardless of which copy the user edited.
function _syncBgF0Controls() {
  const pairs = [['bg-mode-sel', 'mc-bg-mode-sel'],
                 ['bg-n-input', 'mc-bg-n-input'],
                 ['f0-source-sel', 'mc-f0-source-sel']];
  for (const [a, b] of pairs) {
    const ea = document.getElementById(a), eb = document.getElementById(b);
    if (!ea || !eb) continue;
    eb.value = ea.value;                       // toolbar reflects the panel
    if (!ea._bgSynced) { ea.addEventListener('change', () => { eb.value = ea.value; }); ea._bgSynced = true; }
    if (!eb._bgSynced) { eb.addEventListener('change', () => { ea.value = eb.value; }); eb._bgSynced = true; }
  }
}

function renderDiagnostics() {
  renderDiagRecon(); renderDiagResid(); renderDiagD2(); renderDiagD3();
  _updateFitQualityBadge();
  // Show 'Refit all curves' button only in multi-curve mode
  const refitAllWrap = document.getElementById('refit-all-wrap');
  if (refitAllWrap) refitAllWrap.style.display = (mcDataset && mcIsActive) ? '' : 'none';
  // Mirror the Background/F0 control next to it — AquaPen/FluorPen batches only
  const bgF0Wrap = document.getElementById('mc-bg-f0-wrap');
  if (bgF0Wrap) {
    const showBg = mcDataset && mcIsActive && mcDataset.fluorometer === 'Aquapen';
    bgF0Wrap.style.display = showBg ? '' : 'none';
    if (showBg) _syncBgF0Controls();
  }
  // OJIP-Imaging Excel background/F0 mirror — reflect the currently-applied mode;
  // changing it + Refit all curves re-resolves the batch (see mcRefitBatch).
  const exBgWrap = document.getElementById('mc-excel-bg-f0-wrap');
  if (exBgWrap) {
    const showEx = mcDataset && mcIsActive
      && mcDataset.fluorometer === 'OJIPImaging' && mcDataset._excel;
    exBgWrap.style.display = showEx ? '' : 'none';
    const exSel = document.getElementById('mc-excel-bg-mode');
    if (showEx && exSel) exSel.value = mcDataset.excelMeta?.bgMode || 'strip';
  }
}

function renderDiagRecon() {
  const { tMin, tMax } = _diagPlotTrimRange();
  const files = ojipData.files;
  const tRaw  = ojipData.time_raw_ms;
  const tLog  = ojipData.time_log_ms;
  const n     = files.length;
  const datasets = [];
  files.forEach((fname, i) => {
    const c  = sampleColor(i, n);
    const kv = ojipData.key_values[fname];
    // raw double_norm curve
    datasets.push({ label: fname, showLine: true, pointRadius: 0, borderWidth: 1.2,
      borderColor: c, backgroundColor: 'transparent',
      data: ojipData.curves[fname].double_norm
        .map((y, j) => ({ x: tRaw[j], y }))
        .filter(pt => pt.x >= tMin && pt.x <= tMax) });
    // reconstructed curve (dashed)
    datasets.push({ label: '', showLine: true, pointRadius: 0, borderWidth: 1.2,
      borderColor: c, borderDash: [4, 3], backgroundColor: 'transparent',
      data: ojipData.curves[fname].reconstructed
        .map((y, j) => ({ x: tLog[j], y }))
        .filter(pt => pt.x >= tMin && pt.x <= tMax) });
    // FJ (▲), FI (◆) and FP (■) on the reconstructed curve — only if within visible range
    const pts = [], radii = [], styles = [], bg = [], bd = [];
    const addMk = (t, arr, style) => {
      if (t == null || t < tMin || t > tMax) return;
      pts.push({ x: t, y: interpAt(tLog, arr, t) });
      radii.push(6); styles.push(style); bg.push(c); bd.push(c);
    };
    addMk(kv.FJ_time_deriv_ms, ojipData.curves[fname].reconstructed, 'triangle');
    addMk(kv.FI_time_deriv_ms, ojipData.curves[fname].reconstructed, 'rectRot');
    if (kv.FP_time_deriv_ms != null)
      addMk(kv.FP_time_deriv_ms, ojipData.curves[fname].reconstructed, 'rect');
    if (pts.length > 0) {
      datasets.push({ label: '', showLine: false, data: pts,
        pointRadius: radii, pointStyle: styles,
        pointBackgroundColor: bg, pointBorderColor: bd,
        borderColor: 'transparent', backgroundColor: 'transparent' });
    }
  });
  makeChart('diag-recon-chart', { type: 'scatter', data: { datasets },
    options: logScatterOpts('Time (ms)', 'Double normalised') });
}

function renderDiagResid() {
  const { tMin, tMax } = _diagPlotTrimRange();
  const files = ojipData.files;
  const t     = ojipData.time_raw_ms;
  const datasets = files.map((fname, i) => ({
    label: fname, showLine: true, pointRadius: 0, borderWidth: 1.2,
    borderColor: sampleColor(i, files.length), backgroundColor: 'transparent',
    data: ojipData.curves[fname].residuals
      .map((y, j) => ({ x: t[j], y }))
      .filter(pt => pt.x >= tMin && pt.x <= tMax),
  }));
  makeChart('diag-resid-chart', { type: 'scatter', data: { datasets },
    options: logScatterOpts('Time (ms)', 'Residuals (r.u.)') });
}

function renderDiagD2() {
  const { tMin, tMax } = _diagPlotTrimRange();
  const files = ojipData.files;
  const t     = ojipData.time_log_ms;
  const n     = files.length;
  const datasets = [];
  files.forEach((fname, i) => {
    const kv = ojipData.key_values[fname];
    const c  = sampleColor(i, n);
    const d2raw = ojipData.curves[fname].d2;
    const d2arr = ojipData.curves[fname].d2_smooth || d2raw;
    datasets.push({ label: fname, showLine: true, pointRadius: 0, borderWidth: 1.2,
      borderColor: c, backgroundColor: 'transparent',
      data: d2arr.map((y, j) => ({ x: t[j], y }))
        .filter(pt => pt.x >= tMin && pt.x <= tMax) });
    const pts2 = [], r2 = [], st2 = [], bg2 = [], bd2 = [];
    const addMk2 = (tv, style) => {
      if (tv == null || tv < tMin || tv > tMax) return;
      pts2.push({ x: tv, y: interpAt(t, d2arr, tv) });
      r2.push(6); st2.push(style); bg2.push(c); bd2.push(c);
    };
    addMk2(kv.FJ_time_deriv_ms, 'triangle');
    addMk2(kv.FI_time_deriv_ms, 'rectRot');
    if (kv.FP_time_deriv_ms != null) addMk2(kv.FP_time_deriv_ms, 'rect');
    if (pts2.length > 0) {
      datasets.push({ label: '', showLine: false, data: pts2,
        pointRadius: r2, pointStyle: st2,
        pointBackgroundColor: bg2, pointBorderColor: bd2,
        borderColor: 'transparent', backgroundColor: 'transparent' });
    }
  });
  makeChart('diag-d2-chart', { type: 'scatter', data: { datasets },
    options: logScatterOpts('Time (ms)', '2nd derivative') });
}

function renderDiagD3() {
  const { tMin, tMax } = _diagPlotTrimRange();
  const files = ojipData.files;
  const t     = ojipData.time_log_ms;
  const n     = files.length;
  const datasets = [];
  files.forEach((fname, i) => {
    const kv = ojipData.key_values[fname];
    const c  = sampleColor(i, n);
    const d3raw = ojipData.curves[fname].d3;
    if (!d3raw) return;
    const d3arr = ojipData.curves[fname].d3_smooth || d3raw;
    datasets.push({ label: fname, showLine: true, pointRadius: 0, borderWidth: 1.2,
      borderColor: c, backgroundColor: 'transparent',
      data: d3arr.map((y, j) => ({ x: t[j], y }))
        .filter(pt => pt.x >= tMin && pt.x <= tMax) });
    const pts3 = [], r3 = [], st3 = [], bg3 = [], bd3 = [];
    const addMk3 = (tv, style) => {
      if (tv == null || tv < tMin || tv > tMax) return;
      pts3.push({ x: tv, y: interpAt(t, d3arr, tv) });
      r3.push(6); st3.push(style); bg3.push(c); bd3.push(c);
    };
    addMk3(kv.FJ_time_deriv_ms, 'triangle');
    addMk3(kv.FI_time_deriv_ms, 'rectRot');
    if (kv.FP_time_deriv_ms != null) addMk3(kv.FP_time_deriv_ms, 'rect');
    if (pts3.length > 0) {
      datasets.push({ label: '', showLine: false, data: pts3,
        pointRadius: r3, pointStyle: st3,
        pointBackgroundColor: bg3, pointBorderColor: bd3,
        borderColor: 'transparent', backgroundColor: 'transparent' });
    }
  });
  makeChart('diag-d3-chart', { type: 'scatter', data: { datasets },
    options: logScatterOpts('Time (ms)', '3rd derivative') });
}

// ── toggle FJ / FI between default (2/30 ms) and auto-detected ───────────
function toggleFJFI() {
  if (fjfiMode === 'default') {
    // Apply auto-detected derivative timings
    let applied = 0;
    for (const fname of ojipData.files) {
      const kv   = ojipData.key_values[fname];
      const fjMs = kv.FJ_time_deriv_ms;
      const fiMs = kv.FI_time_deriv_ms;
      if (fjMs != null && fiMs != null && fjMs < fiMs) {
        const newKv = recalcKeyValues(fname, fjMs, fiMs);
        ojipData.key_values[fname] = newKv;
        paramData[fname] = calcJIP(newKv);
        applied++;
      }
    }
    if (!applied) return;
    fjfiMode = 'auto';
  } else {
    // Reset to 2/30 ms defaults
    for (const fname of ojipData.files) {
      const newKv = recalcKeyValues(fname, 2.0, 30.0);
      ojipData.key_values[fname] = newKv;
      paramData[fname] = calcJIP(newKv);
    }
    fjfiMode = 'default';
  }
  _updateFJFIBtnLabels();
  buildFJTable();
  const norm   = document.querySelector('#norm-btns .btn-primary')?.dataset?.norm   || 'raw';
  const pgroup = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'yields';
  renderCurvesChart(norm);
  const tab = activeTabId();
  if (tab === 'tab-params') { renderParamsChart(pgroup); renderParamsTable(pgroup); }
  else markTabsDirty('tab-params');
  if (hasGroups()) {
    if (tab === 'tab-groups') _renderAllOjipGroupCharts();
    else markTabsDirty('tab-groups');
  }
}

function _updateFJFIBtnLabels() {
  const html = fjfiMode === 'default'
    ? 'Use auto-detected F<sub>J</sub>/F<sub>I</sub>'
    : 'Reset F<sub>J</sub>/F<sub>I</sub> to 2/30 ms';
  const btn1 = document.getElementById('reset-fj-fi-btn');
  const btn2 = document.getElementById('reset-fj-fi-btn-curves');
  if (btn1) btn1.innerHTML = html;
  if (btn2) btn2.innerHTML = html;
}

// ── apply polynomial-identified FJ / FI ───────────────────────────────────
function _refreshAfterTimingChange() {
  buildFJTable();
  const norm   = document.querySelector('#norm-btns .btn-primary')?.dataset?.norm   || 'raw';
  const pgroup = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'yields';
  renderCurvesChart(norm);
  const tab = activeTabId();
  if (tab === 'tab-params') { renderParamsChart(pgroup); renderParamsTable(pgroup); }
  else markTabsDirty('tab-params');
  if (hasGroups()) {
    if (tab === 'tab-groups') _renderAllOjipGroupCharts();
    else markTabsDirty('tab-groups');
  }
}

// ── fit quality badge (Diagnostics tab) ──────────────────────────────────
function _updateFitQualityBadge() {
  const badge = document.getElementById('fit-quality-badge');
  if (!badge || !ojipData || !ojipData.files?.length) return;
  const fname = ojipData.files[0];
  const kv = ojipData.key_values?.[fname];
  if (!kv) { badge.style.display = 'none'; return; }

  badge.style.display = '';
  badge.className = 'badge';

  if (kv.fit_method === 'pchip') {
    const r = kv.fit_roughness;
    if (r == null) { badge.style.display = 'none'; return; }
    const pct = (r * 100).toFixed(1);
    badge.classList.add(kv.fit_flag === 'poor' ? 'badge-danger' : 'badge-success');
    badge.textContent = `PCHIP — d2 roughness ${pct}%` + (kv.fit_flag === 'poor' ? ' ⚠' : ' ✓');
  } else {
    const n = kv.fit_nrmse;
    if (n == null) { badge.style.display = 'none'; return; }
    const pct = (n * 100).toFixed(2);
    badge.classList.add(kv.fit_flag === 'poor' ? 'badge-danger' : 'badge-success');
    badge.textContent = `nRMSE ${pct}%` + (kv.fit_flag === 'poor' ? ' ⚠' : ' ✓');
  }
}

// Percentile of a numeric array (nearest-rank).
function _pctl(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

// ── batch quality banners (OJIPImaging overview) ──────────────────────────
// One responsive banner per flag axis. Both read the same tunable cutoffs the
// Time-series table/plot use, so the three surfaces always agree.
function _updateBatchQualityAlerts(result) {
  const panel = document.getElementById('mc-flag-panel');
  const valid = (result || []).filter(r => r && !r.error);
  // The panel (cutoff inputs) stays visible whenever there are batch results,
  // even at zero flags, so the user can always adjust the thresholds.
  if (panel) panel.style.display = valid.length ? '' : 'none';

  _updateFitBanner(valid);
  _updateConfBanner(valid);
}

function _updateFitBanner(valid) {
  const alert = document.getElementById('mc-fit-quality-alert');
  const text  = document.getElementById('mc-fit-quality-text');
  if (!alert || !text) return;

  // Count against the user-tunable R² cutoff (falls back to backend fit_flag for
  // PCHIP, whose fit_r2 is null), so this stays consistent with the table/plot.
  const r2t = parseFloat(document.getElementById('mc-fit-r2-thresh')?.value);
  const r2Thresh = isNaN(r2t) ? 0.90 : r2t;
  const isPoorFit = (r) => r.fit_r2 != null ? r.fit_r2 < r2Thresh : r.fit_flag === 'poor';
  const poor = valid.filter(isPoorFit).length;

  if (poor === 0) { alert.style.display = 'none'; return; }

  const method = _lastJipOpts.fitMethod || 'logspline';
  const methodLabel = method === 'logspline' ? 'Log-time spline'
                    : method === 'pchip'     ? 'PCHIP'
                    : 'Standard spline';
  const suggParts = [];
  if (method === 'spline') { suggParts.push('Log-time spline'); suggParts.push('PCHIP'); }
  else if (method === 'logspline') { suggParts.push('PCHIP'); }
  const sugg = suggParts.length ? ` Consider trying ${suggParts.join(' or ')}.` : '';

  const r2s    = valid.map(r => r.fit_r2).filter(v => v != null);
  const nrmses = valid.map(r => r.fit_nrmse).filter(v => v != null);
  const parts = [];
  if (r2s.length)    parts.push(`R² median ${_pctl(r2s, 0.5).toFixed(4)}, p10 ${_pctl(r2s, 0.1).toFixed(4)} (poor &lt; ${r2Thresh})`);
  if (nrmses.length) parts.push(`nRMSE median ${(_pctl(nrmses, 0.5) * 100).toFixed(2)}%, p90 ${(_pctl(nrmses, 0.9) * 100).toFixed(2)}%`);
  const distLine = parts.length
    ? `<br><span style="font-size:0.85em; opacity:0.85;">Batch distribution: ${parts.join('; ')}. Per-curve values are in the Time-series table.</span>`
    : '';

  text.innerHTML = `<span style="color:#b06a62;">&#9650;&nbsp;fit</span> — ${poor} / ${valid.length} curves have lower-quality ${methodLabel} fit.${sugg}${distLine}`;
  alert.style.display = '';
  const st = document.getElementById('mc-refit-batch-status');
  if (st) st.textContent = '';
}

function _updateConfBanner(valid) {
  const alert = document.getElementById('mc-conf-quality-alert');
  const text  = document.getElementById('mc-conf-quality-text');
  if (!alert || !text) return;

  const ct = parseFloat(document.getElementById('mc-conf-thresh')?.value);
  const confThresh = isNaN(ct) ? 0.15 : ct;
  const confMin = (r) => Math.min(r.FJ_conf ?? 0, r.FI_conf ?? 0, r.FP_conf ?? 0);
  const mins = valid.map(confMin);
  const low  = mins.filter(v => v < confThresh).length;

  if (low === 0) { alert.style.display = 'none'; return; }

  const distLine = mins.length
    ? `<br><span style="font-size:0.85em; opacity:0.85;">Batch distribution: min FJ/FI/FP confidence median ${_pctl(mins, 0.5).toFixed(3)}, p10 ${_pctl(mins, 0.1).toFixed(3)} (low &lt; ${confThresh}). Low confidence flags an ambiguous J/I/P pick to review — not necessarily a wrong one. Per-curve values are in the Time-series table.</span>`
    : '';

  text.innerHTML = `<span style="color:#b8923f;">&#9679;&nbsp;conf</span> — ${low} / ${valid.length} curves have lower timing confidence.${distLine}`;
  alert.style.display = '';
}

// ── batch refit for OJIPImaging (full re-analysis with new fit method) ────
async function mcRefitBatch() {
  const btn    = document.getElementById('mc-refit-batch-btn');
  const status = document.getElementById('mc-refit-batch-status');
  if (!mcDataset || !_lastSelected.length) return;

  // A refit changes the fit / background inputs, so any cached per-curve detail
  // is now stale — drop it so the Diagnostics detail re-fetches on next click.
  mcDetailCache = {};

  const fitMethod = document.getElementById('fit-method-sel')?.value || 'logspline';
  const jipOpts = {
    FJ_time:   parseFloat(document.getElementById('FJ_time').value) || 2.0,
    FI_time:   parseFloat(document.getElementById('FI_time').value) || 30.0,
    kr:        parseInt(document.getElementById('kr_input').value) || 10,
    fitMethod,
    trimFirst: parseInt(document.getElementById('trim-first-input')?.value) || 0,
    trimLast:  parseInt(document.getElementById('trim-last-input')?.value)  || 0,
    bgMode:    document.getElementById('bg-mode-sel')?.value || 'auto',
    bgN:       parseInt(document.getElementById('bg-n-input')?.value) || 1,
    f0Source:  document.getElementById('f0-source-sel')?.value || 'instrument',
    knotPlacement: document.getElementById('knot-placement-diag')?.value || 'hybrid',
    ojDensify: document.getElementById('oj-densify-chk')?.checked || false,
    ojTauMs: (() => { const v = parseFloat(document.getElementById('oj-tau-input')?.value); return (v > 0) ? v : null; })(),
    f0TimMs: (() => { const v = parseFloat(document.getElementById('f0-time-input')?.value); return (v > 0) ? v : null; })(),
  };

  // OJIP-Imaging Excel: re-apply the background/F0 mode chosen in the Diagnostics
  // mirror by rebuilding the curve values/time axis before the pass (curve
  // indices are preserved, so _lastSelected stays valid).
  if (mcDataset.fluorometer === 'OJIPImaging' && mcDataset._excel) {
    MC.resolveExcelDataset(
      mcDataset,
      mcDataset.excelMeta?.normColumn,
      document.getElementById('mc-excel-bg-mode')?.value);
  }

  btn.disabled = true;
  status.textContent = `Refitting ${_lastSelected.length} curves with ${fitMethod}…`;

  const result = await MC.runParamsPass(mcDataset, _lastSelected, jipOpts);
  if (!result) {
    status.textContent = 'Refit cancelled.';
    btn.disabled = false;
    return;
  }

  _lastJipOpts = Object.assign({}, jipOpts);
  _updateBatchQualityAlerts(result);

  // Refresh overview charts
  MC.renderTimeSeries();
  MC.renderAggregateCurves();
  if (mcDataset.fluorometer === 'OJIPImaging') MC.renderGroupedPanels();

  const methodLabel = fitMethod === 'polynomial' ? 'Polynomial (Akinyemi)'
                    : fitMethod === 'logspline'  ? 'Log-time spline'
                    : fitMethod === 'pchip'      ? 'PCHIP'
                    : 'Standard spline';
  status.textContent = `Refit done (${methodLabel}).`;
  btn.disabled = false;
}

// ── spline refit ──────────────────────────────────────────────────────────
async function refitSplines() {
  const kr     = parseInt(document.getElementById('kr-slider').value);
  const status = document.getElementById('refit-status');
  status.textContent = 'Refitting…';
  document.getElementById('refit-btn').disabled = true;

  try {
    // F0 timing override: re-normalise from raw data if the user supplied a value
    const f0TimeMs  = parseFloat(document.getElementById('f0-time-input')?.value);
    const f0Override = (f0TimeMs > 0) ? f0TimeMs : null;

    const double_norm = {};
    for (const fname of ojipData.files) {
      if (f0Override && ojipData.curves[fname].raw) {
        const raw   = ojipData.curves[fname].raw;
        const times = ojipData.time_raw_ms;
        // Nearest index to requested F0 time
        let nearIdx = 0, minD = Math.abs(times[0] - f0Override);
        for (let i = 1; i < times.length; i++) {
          const d = Math.abs(times[i] - f0Override);
          if (d < minD) { minD = d; nearIdx = i; }
        }
        const newF0 = raw[nearIdx];
        // Safe loop-based max (Math.max(...raw) can stack-overflow for large arrays)
        let newFM = -Infinity;
        for (let i = 0; i < raw.length; i++) { if (raw[i] > newFM) newFM = raw[i]; }
        const span  = newFM - newF0;
        if (span <= 0) {
          console.warn('F0 override: span ≤ 0 — falling back to original', fname);
          double_norm[fname] = ojipData.curves[fname].double_norm;
          continue;
        }
        double_norm[fname] = raw.map(v => (v - newF0) / span);
        // Store overridden F0/FM so calcJIP uses them
        ojipData.key_values[fname].F0 = newF0;
        ojipData.key_values[fname].FM = newFM;
        ojipData.curves[fname].double_norm = double_norm[fname];
        console.log(`F0 override: ${fname} → F0=${newF0.toFixed(1)} at ${times[nearIdx].toFixed(3)} ms, FM=${newFM.toFixed(1)}`);
      } else {
        double_norm[fname] = ojipData.curves[fname].double_norm;
      }
    }
    const resp = await fetch('/api/ojip_refit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fluorometer: ojipData.fluorometer,
        kr,
        fit_method: (document.getElementById('fit-method-sel')?.value || 'logspline'),
        knot_placement: document.getElementById('knot-placement-diag')?.value || 'hybrid',
        oj_densify: document.getElementById('oj-densify-chk')?.checked || false,
        oj_tau_ms: (() => { const v = parseFloat(document.getElementById('oj-tau-input')?.value); return (v > 0) ? v : null; })(),
        trim_first: parseInt(document.getElementById('trim-first-input')?.value) || 0,
        trim_last:  parseInt(document.getElementById('trim-last-input')?.value)  || 0,
        fj_time_ms: ojipData.fj_time_ms,
        fi_time_ms: ojipData.fi_time_ms,
        time_raw_ms: ojipData.time_raw_ms,
        double_norm,
      }),
    });
    const data = await resp.json();
    if (data.status === 'error') { status.textContent = data.message; return; }

    // Update stored curves + time_log
    ojipData.time_log_ms = data.time_log_ms;
    for (const fname of ojipData.files) {
      Object.assign(ojipData.curves[fname], data.curves[fname]);
      if (data.key_timings?.[fname]) Object.assign(ojipData.key_values[fname], data.key_timings[fname]);
    }

    // Sync user-editable FJ/FI timing from the new auto-detected values
    // so that markers on the Curves chart and the FJ/FI table inputs update
    for (const fname of ojipData.files) {
      const kv = ojipData.key_values[fname];
      if (kv.FJ_time_deriv_ms != null && kv.FI_time_deriv_ms != null) {
        const updated = recalcKeyValues(fname, kv.FJ_time_deriv_ms, kv.FI_time_deriv_ms);
        ojipData.key_values[fname] = updated;
      }
    }
    fjfiMode = 'auto';
    _updateFJFIBtnLabels();

    // After key_timings applied: if F0 was overridden, re-read FJ/FI/FK/F50 from raw data
    if (f0Override) {
      for (const fname of ojipData.files) {
        if (!ojipData.curves[fname].raw) continue;
        const raw  = ojipData.curves[fname].raw;
        const times = ojipData.time_raw_ms;
        const kv   = ojipData.key_values[fname];
        if (kv.FJ_time_deriv_ms != null) kv.FJ = interpAt(times, raw, kv.FJ_time_deriv_ms);
        if (kv.FI_time_deriv_ms != null) kv.FI = interpAt(times, raw, kv.FI_time_deriv_ms);
        // FK (~0.3 ms) and F50 (~0.05 ms) needed for M0 = 4*(FK-F50)/FV
        kv.FK  = interpAt(times, raw, 0.3);
        kv.F50 = interpAt(times, raw, 0.05);
      }
    }

    ojipData.kr = kr;
    document.getElementById('kr_input').value = kr;
    document.getElementById('kr-display').textContent = kr;
    // Sync knot placement between diagnostics and section 2
    const kpVal = document.getElementById('knot-placement-diag')?.value || 'hybrid';
    const kpSel = document.getElementById('knot-placement-sel');
    if (kpSel) kpSel.value = kpVal;

    // Display densify info if available
    const densifySt = document.getElementById('oj-densify-status');
    if (densifySt) {
      if (data.densify_info && Object.keys(data.densify_info).length) {
        const first = Object.values(data.densify_info)[0];
        densifySt.textContent = `\u03c4 = ${first.tau_ms} ms, A = ${first.A}`;
        // Populate τ input with auto-fitted value (only if user didn't set one)
        const tauIn = document.getElementById('oj-tau-input');
        if (tauIn && !tauIn.value) tauIn.value = first.tau_ms;
      } else {
        densifySt.textContent = '';
      }
    }

    // ── Propagate updated params to summary views ──
    recalcAllParams();

    if (mcIsActive && paramMatrix && _currentDetailSlot != null) {
      // Batch mode: write back to paramMatrix for Time Series
      const fname = ojipData.files[0];
      const kv  = ojipData.key_values[fname];
      const jip = paramData[fname];
      Object.assign(paramMatrix[_currentDetailSlot], kv, jip);
      delete mcDetailCache[_currentDetailSlot];   // stale after refit
      MC.renderTimeSeries();
    }

    // Re-render everything directly (tables update even when hidden;
    // _withPaneVisible ensures Chart.js can measure hidden canvases)
    const pgroup = document.querySelector('#param-group-btns .btn-primary')
                     ?.dataset?.pgroup || 'yields';
    _withPaneVisible('tab-params', () => renderParamsChart(pgroup));
    renderParamsTable(pgroup);
    renderDiagnostics();
    const activeNorm = document.querySelector('#norm-btns .btn-primary')?.dataset?.norm || 'double_norm';
    _withPaneVisible('tab-curves', () => renderCurvesChart(activeNorm));
    buildFJTable();
    markTabsDirty('tab-curves', 'tab-params', 'tab-diag');
    if (hasGroups()) markTabsDirty('tab-groups');

    const f0Note = f0Override ? `, F0 @ ${f0Override} ms` : '';
    status.textContent = `Refit done (kr = ${kr}${f0Note})`;
    setTimeout(() => status.textContent = '', 4000);
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  } finally {
    document.getElementById('refit-btn').disabled = false;
  }
}

// Capture a canvas as JPEG with a solid white background (Chart.js canvases are transparent).
// Caps output at MAX_CHART_PX wide to bound payload size regardless of devicePixelRatio.
const MAX_CHART_PX = 1200;
function _chartToDataUrl(canvas) {
  let w = canvas.width;
  let h = canvas.height;
  if (w > MAX_CHART_PX) { h = Math.round(h * MAX_CHART_PX / w); w = MAX_CHART_PX; }
  const tmp = document.createElement('canvas');
  tmp.width  = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  return tmp.toDataURL('image/jpeg', 0.88);
}

// ── download xlsx with embedded JS chart images ───────────────────────────
async function downloadXlsxWithCharts() {
  const link = document.getElementById('xlsx-download-link');
  link.style.pointerEvents = 'none';
  link.innerHTML = '<span class="spinner-border spinner-border-sm mr-1"></span> Embedding charts…';

  const charts = [];

  // Helper: capture one canvas, temporarily forcing its tab-pane visible.
  // Returns data_url string or null.
  function captureCanvas(id) {
    if (!chartInst[id]) return null;
    const canvas = document.getElementById(id);
    if (!canvas) return null;
    const pane = canvas.closest('.tab-pane');
    const wasHidden = pane && getComputedStyle(pane).display === 'none';
    if (wasHidden) {
      pane.style.display = 'block';
      pane.style.visibility = 'hidden';
      void pane.offsetWidth;
      chartInst[id].resize();
    }
    const data_url = _chartToDataUrl(canvas);
    if (wasHidden) {
      pane.style.display = '';
      pane.style.visibility = '';
    }
    if (data_url && data_url.includes(',') && data_url.split(',')[1]) return data_url;
    return null;
  }

  // Single-canvas captures
  const simpleCaps = [
    { id: 'curves-chart',       title: 'OJIP Curves' },
    { id: 'diag-recon-chart',   title: 'Reconstructed vs Raw' },
    { id: 'diag-resid-chart',   title: 'Residuals' },
    { id: 'diag-d2-chart',      title: '2nd Derivative' },
    { id: 'diag-d3-chart',      title: '3rd Derivative' },
  ];
  for (const { id, title } of simpleCaps) {
    const data_url = captureCanvas(id);
    if (data_url) charts.push({ title, data_url });
  }

  // Multi-group param captures: render every sub-tab and capture each.
  const pGroupKeys   = ['yields', 'fluxes', 'areas', 'tech'];
  const pGroupTitles = { yields: 'Quantum yields', fluxes: 'Energy fluxes', areas: 'Areas & indices', tech: 'Technical' };
  const savedPgroup  = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'yields';

  // Force params pane visible for the whole batch so resize works correctly.
  const paramPane = document.getElementById('tab-params');
  const paramWasHidden = getComputedStyle(paramPane).display === 'none';
  if (paramWasHidden) {
    paramPane.style.display = 'block';
    paramPane.style.visibility = 'hidden';
    void paramPane.offsetWidth;
  }
  for (const grp of pGroupKeys) {
    renderParamsChart(grp);
    chartInst['params-chart']?.resize();
    const data_url = captureCanvas('params-chart');
    if (data_url) charts.push({ title: `JIP Parameters — ${pGroupTitles[grp]}`, data_url });
  }
  if (paramWasHidden) {
    paramPane.style.display = '';
    paramPane.style.visibility = '';
  }
  renderParamsChart(savedPgroup); // restore

  // Group charts — capture directly from their permanent chart instances.
  if (hasGroups()) {
    const groupPane = document.getElementById('tab-groups');
    const groupWasHidden = getComputedStyle(groupPane).display === 'none';
    if (groupWasHidden) {
      groupPane.style.display = 'block';
      groupPane.style.visibility = 'hidden';
      void groupPane.offsetWidth;
    }
    // Curve charts — force their collapse sections visible for capture
    for (const [bodyId, chartId, title, renderFn] of [
      ['grp-raw-body', 'grp-curves-raw-chart', 'Group Curves — Raw',         renderGrpCurvesRaw],
      ['grp-f0-body',  'grp-curves-f0-chart',  'Group Curves — →F₀',         renderGrpCurvesF0],
      ['grp-fm-body',  'grp-curves-fm-chart',  'Group Curves — ←FM',         renderGrpCurvesFM],
      [null,           'grp-curves-dn-chart',  'Group Curves — Double norm', renderGrpCurvesDN],
    ]) {
      const body = bodyId && document.getElementById(bodyId);
      const bodyWasHidden = body && getComputedStyle(body).display === 'none';
      if (bodyWasHidden) { body.style.display='block'; body.style.visibility='hidden'; void body.offsetWidth; }
      renderFn(); // re-render from current UI state (reads checkboxes/settings at export time)
      const data_url = captureCanvas(chartId);
      if (data_url) charts.push({ title, data_url });
      if (bodyWasHidden) { body.style.display=''; body.style.visibility=''; }
    }
    // Parameter bar charts
    for (const [chartId, title, renderFn] of [
      ['grp-params-yields-chart', 'Group Parameters — Quantum yields', renderGrpParamsYields],
      ['grp-params-fluxes-chart', 'Group Parameters — Energy fluxes',  renderGrpParamsFluxes],
      ['grp-params-areas-chart',  'Group Parameters — Areas & indices', renderGrpParamsAreas],
      ['grp-params-tech-chart',   'Group Parameters — Technical',       renderGrpParamsTech],
    ]) {
      renderFn(); // re-render from current UI state
      const data_url = captureCanvas(chartId);
      if (data_url) charts.push({ title, data_url });
    }
    if (groupWasHidden) {
      groupPane.style.display = '';
      groupPane.style.visibility = '';
    }
  }

  // Collect group statistics + individual sample data when groups are defined
  let group_export = null;
  if (hasGroups()) {
    const stats     = calcGroupStats();
    const allParams = Object.values(PARAM_GROUPS).flat();

    const grp_stats = {};
    for (const [grp, s] of Object.entries(stats)) {
      grp_stats[grp] = {
        files:  s.files,
        params: Object.fromEntries(
          Object.entries(s.params).map(([p, v]) => [p, { mean: v.mean, sd: v.sd, n: v.n }])
        ),
      };
    }

    const samples = ojipData.files
      .filter(f => groups[f])
      .map(fname => {
        const row = { sample: fname, group: groups[fname] };
        for (const p of allParams) {
          const v = paramData[fname]?.[p];
          row[p] = (v != null && isFinite(v)) ? v : null;
        }
        return row;
      });

    group_export = {
      stats:        grp_stats,
      samples,
      param_order:  allParams,
      param_labels: PARAM_LABELS,
    };
  }

  // Build params_table for the Parameters sheet in the summary xlsx
  const allParamKeys = Object.values(PARAM_GROUPS).flat();
  const kvFields = ['F0', 'FM', 'FK', 'FJ', 'FI',
                    'FM_time_ms', 'FJ_time_user_ms', 'FI_time_user_ms',
                    'FJ_time_deriv_ms', 'FI_time_deriv_ms', 'FP_time_deriv_ms',
                    'Area_OJ', 'Area_JI', 'Area_IP', 'Area_OP'];
  const params_table = {
    header: ['Sample', ...allParamKeys.map(p => PARAM_LABELS[p] || p), ...kvFields],
    rows: ojipData.files.map(fname => {
      const row = [fname];
      for (const p of allParamKeys) {
        const v = paramData[fname]?.[p];
        row.push(v != null && isFinite(v) ? v : null);
      }
      for (const f of kvFields) {
        const v = ojipData.key_values[fname]?.[f];
        row.push(v != null ? v : null);
      }
      return row;
    }),
  };

  // Append full curve data so the server can write all raw data sheets.
  const curve_data = {
    time_raw_ms: ojipData.time_raw_ms,
    time_log_ms: ojipData.time_log_ms,
    files:       ojipData.files,
    curves:      ojipData.curves,
  };

  // Methods text — embedded as a sheet instead of a separate HTML file.
  const methods_text = generateOJIPMethodsText();

  // Pre-flight: check JSON payload size before sending (same issue as file upload —
  // server closes connection on oversize, browser sees NetworkError not 413).
  const payload    = JSON.stringify({ file_stem: ojipData.file_stem, charts, group_export, params_table, curve_data, methods_text });
  const payloadBytes = new Blob([payload]).size;
  const payloadMB    = (payloadBytes / 1024 / 1024).toFixed(2);
  console.log(`[OJIP export] charts: ${charts.length}, payload: ${payloadMB} MB`,
              charts.map(c => ({ title: c.title, kb: ((c.data_url||'').length * 0.75 / 1024).toFixed(0) + ' KB' })));
  if (payloadBytes > 80 * 1024 * 1024) {
    alert(`Chart export failed: chart image data is ${payloadMB} MB, which exceeds the server limit.\n` +
          `Try reducing the browser zoom level and re-exporting.`);
    return;
  }

  try {
    console.log(`[OJIP export] sending ${payloadMB} MB to /api/ojip_add_charts …`);
    const resp = await fetch('/api/ojip_add_charts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    payload,
    });
    console.log(`[OJIP export] response status: ${resp.status}`);
    if (resp.status === 413) {
      alert('Chart export failed: the chart image data is too large for the server.\nTry uploading fewer files at once or contact your administrator.');
      return;
    }
    const rawText = await resp.text();
    let result;
    try { result = JSON.parse(rawText); }
    catch (_) {
      alert(`Chart export failed (HTTP ${resp.status}): server returned an unexpected response.\n\n` + rawText.slice(0, 300));
      return;
    }
    if (result.status === 'error') throw new Error(result.message);
    const dlA  = document.createElement('a');
    dlA.href     = '/static/' + result.xlsx_path;
    dlA.download = (ojipData.file_stem || 'OJIP') + '_analysis.xlsx';
    dlA.click();
  } catch (err) {
    console.error('[OJIP export] fetch threw:', err);
    alert('Chart export failed: ' + err.message);
  } finally {
    link.style.pointerEvents = '';
    link.innerHTML = '<i class="fa fa-download"></i> Download .xlsx';
  }
}

// ── export to statistics page ─────────────────────────────────────────────
function exportToStatistics() {
  const assignedFiles = ojipData.files.filter(f => groups[f]);
  if (!assignedFiles.length) { alert('No files assigned to groups.'); return; }

  const allParams = Object.values(PARAM_GROUPS).flat();
  const header    = ['Group', 'Sample', ...allParams.map(p => PARAM_LABELS[p] || p)].join('\t');
  const rows      = assignedFiles.map(fname => {
    const vals = allParams.map(p => {
      const v = paramData[fname]?.[p];
      return v != null && isFinite(v) ? v.toFixed(6) : '';
    });
    return [groups[fname], fname, ...vals].join('\t');
  });

  sessionStorage.setItem('ojip_export', JSON.stringify({
    tsv:    [header, ...rows].join('\n'),
    source: 'OJIP Analyzer',
  }));
  window.open('/statistics', '_blank');
}

// ── remember fluorometer selection across sessions (localStorage) ─────────
document.addEventListener('DOMContentLoaded', () => {
  // File input label sync is already handled via updateFileList()
});

function _buildMethodsHtml(toolTitle, plainText) {
    var dateStr = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
    var paragraphs = plainText.split(/\n\n+/).map(function(p) {
        return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>Methods Section \u2014 ' + toolTitle + '</title>\n<style>\n  body { font-family: "Times New Roman", Times, serif; font-size: 11pt; line-height: 1.7;\n         max-width: 740px; margin: 48px auto; color: #111; }\n  h1   { font-size: 1.25rem; margin-bottom: 0.15em; }\n  p    { margin: 0.4em 0 0.9em; text-align: justify; }\n  .meta { color: #555; font-size: 0.82rem; font-family: Arial, sans-serif;\n          border-bottom: 2px solid #333; padding-bottom: 0.5em; margin-bottom: 1.4em; }\n  .note { background: #fffbe6; border-left: 4px solid #f0ad4e; padding: 7px 12px;\n          font-size: 0.82rem; font-family: Arial, sans-serif; margin-top: 2.2em; line-height: 1.5; }\n</style>\n</head>\n<body>\n<h1>' + toolTitle + ' \u2014 Methods Section</h1>\n<div class="meta">Generated by CyanoTools\u00a0\u00b7\u00a0' + dateStr + '</div>\n' + paragraphs + '\n<div class="note"><strong>Note:</strong> This section was auto-generated from the active analysis settings at the time of export. Please verify all values and adapt the wording to the conventions of your target journal.</div>\n</body>\n</html>';
}

// ============================================================
// Methods section text generator
// ============================================================
function showOJIPMethodsModal() {
    if (!ojipData) { alert('Please analyze data first.'); return; }
    var ta = document.getElementById('ojip-methods-text-area');
    if (ta) ta.value = generateOJIPMethodsText();
    $('#ojip-methods-modal').modal('show');
}

function copyOJIPMethodsText() {
    var ta = document.getElementById('ojip-methods-text-area');
    if (!ta) return;
    ta.select();
    var btn = document.getElementById('ojip-methods-copy-btn');
    navigator.clipboard.writeText(ta.value).then(function() {
        if (!btn) return;
        var o = btn.innerHTML;
        btn.innerHTML = '<i class="fa fa-check mr-1"></i> Copied!';
        setTimeout(function() { btn.innerHTML = o; }, 1800);
    }).catch(function() { document.execCommand('copy'); });
}

function generateOJIPMethodsText() {
    var fluoroSel = document.getElementById('fluorometer');
    var fluoro = fluoroSel ? fluoroSel.options[fluoroSel.selectedIndex].text : 'fluorometer';

    var kr = ojipData.kr != null ? ojipData.kr :
             (document.getElementById('kr-display') ? document.getElementById('kr-display').textContent : '10');
    var fjTime = ojipData.fj_time_ms != null ? ojipData.fj_time_ms :
                 ((document.getElementById('FJ_time') || {}).value || '2.0');
    var fiTime = ojipData.fi_time_ms != null ? ojipData.fi_time_ms :
                 ((document.getElementById('FI_time') || {}).value || '30.0');

    var files = ojipData.files || [];
    var n = files.length;
    var fList = n <= 8 ? files.join(', ') : n + ' files';

    var gnames = Object.values(groups).filter(Boolean)
        .filter(function(v, i, a) { return a.indexOf(v) === i; });

    var lines = [];

    lines.push(
        'Fast chlorophyll fluorescence induction kinetics (OJIP transients) were measured using a ' + fluoro + '. ' +
        'Raw data files were analyzed using the OJIP Analyzer module of CyanoTools ' +
        '(https://www.cyano.tools/OJIP). ' +
        'A total of ' + n + ' transient' + (n !== 1 ? 's were' : ' was') + ' processed (' + fList + ').'
    );

    lines.push(
        'Fluorescence curves were reconstructed using cubic spline interpolation with a knot reduction ' +
        'factor kr\u202f=\u202f' + kr + '. The J and I phase timings were set at ' + fjTime + '\u202fms and ' +
        fiTime + '\u202fms, respectively.'
    );

    lines.push(
        'JIP-test parameters were calculated according to the methodology of Strasser et al. (2000) and ' +
        'Tsimilli-Michael (2020): maximum quantum yield of PSII photochemistry ' +
        '(\u03c6P0\u202f=\u202fFv/Fm\u202f=\u202f(FM\u202f\u2212\u202fFO)/FM), efficiency of QA\u207b\u202f\u2192\u202fPQ ' +
        'electron transfer (\u03c8E0\u202f=\u202f1\u202f\u2212\u202fVJ), quantum yield of electron transport ' +
        '(\u03c6E0\u202f=\u202f\u03c6P0\u202f\u00d7\u202f\u03c8E0), absorbed energy flux per active reaction ' +
        'centre (ABS/RC), trapped energy flux (TR0/RC), electron transport flux (ET0/RC), dissipated energy flux ' +
        '(DI0/RC), and the performance index on absorption basis (PI_abs).'
    );

    if (gnames.length >= 2) {
        lines.push(
            'Samples were organized into ' + gnames.length + ' experimental group' +
            (gnames.length !== 1 ? 's' : '') + ' (' + gnames.join(', ') + '). ' +
            'Group means\u202f\u00b1\u202fstandard deviations were calculated for all JIP-test parameters.'
        );
    }

    return lines.join('\n\n');
}

// ── Annotation tab integration ────────────────────────────────────────────────
// Called by the "Populate annotation grid" button in the Annotation tab.
// Collects already-computed OJIP results from memory and POSTs them to
// /api/fluorescence_annotation/ingest_from_ojip (no file re-upload needed).
function populateAnnotationFromOJIP() {
    if (typeof ANN === 'undefined') return;

    // ── Multi-curve mode: build payload from paramMatrix ──
    if (mcIsActive && paramMatrix) {
        var mcFiles = [];
        var mcKeyValues = {};
        var mcParamData = {};
        for (var i = 0; i < paramMatrix.length; i++) {
            var r = paramMatrix[i];
            if (!r || r.error) continue;
            mcFiles.push(r.name);
            mcKeyValues[r.name] = {
                F0: r.F0, FM: r.FM, FK: r.FK, F50: r.F50,
                FJ: r.FJ, FI: r.FI,
                FJ_time_user_ms: r.FJ_time_user_ms,
                FI_time_user_ms: r.FI_time_user_ms,
            };
            mcParamData[r.name] = {};
            var pKeys = Object.keys(PARAM_GROUPS).flatMap(function(g) { return PARAM_GROUPS[g]; });
            for (var k = 0; k < pKeys.length; k++) {
                if (r[pKeys[k]] != null) mcParamData[r.name][pKeys[k]] = r[pKeys[k]];
            }
        }
        var mcPayload = {
            ojip_results: {
                files:       mcFiles,
                fluorometer: mcDataset.fluorometer || null,
                fj_time_ms:  parseFloat(document.getElementById('FJ_time').value) || 2.0,
                fi_time_ms:  parseFloat(document.getElementById('FI_time').value) || 30.0,
                key_values:  mcKeyValues,
                param_data:  mcParamData,
                time_raw_ms: [],
                curves:      {},
                multi_curve_source: mcDataset.filename,
                instrument_meta: mcDataset.instrumentMeta || {},
            },
            tier_json: ANN.collectTiers(),
        };
        // Cache raw curve data now (while mcDataset is available) for bundle download later.
        // This avoids fragile lookups at download time.
        var cachedCurves = {};
        for (var ci = 0; ci < paramMatrix.length; ci++) {
            var cr = paramMatrix[ci];
            if (!cr || cr.error) continue;
            var origIdx = typeof MC.slotToIndex === 'function' ? MC.slotToIndex(ci) : ci;
            var cObj = mcDataset.curves.find(function(x) { return x.index === origIdx; });
            if (cObj) cachedCurves[cr.name] = Array.from(cObj.values);
        }
        window._mcCurvesForBundle = {
            files: mcFiles.slice(),
            time_raw_ms: Array.from(mcDataset.timeUs).map(function(t) { return t * 0.001; }),
            curves_raw: cachedCurves,
        };

        ANN.ingestFromOJIP(mcPayload);
        return;
    }

    // ── Single-file mode (original path) ──
    if (!ojipData || !ojipData.files || !ojipData.files.length) {
        var eb = document.getElementById('ann-error-banner');
        if (eb) { eb.textContent = 'Run OJIP analysis first, then come back here.'; eb.classList.remove('d-none'); }
        return;
    }

    var payload = {
        ojip_results: {
            files:       ojipData.files,
            fluorometer: ojipData.fluorometer || null,
            fj_time_ms:  ojipData.fj_time_ms  || 2.0,
            fi_time_ms:  ojipData.fi_time_ms  || 30.0,
            key_values:  ojipData.key_values  || {},
            param_data:  window.paramData     || {},
            time_raw_ms: ojipData.time_raw_ms || [],
            curves:      ojipData.curves      || {},
        },
        tier_json: ANN.collectTiers(),
    };

    ANN.ingestFromOJIP(payload);
}

// ── Batch export as ZIP ───────────────────────────────────────────────────

const _BE_INDIV_LIMIT = 100; // disable individual curve/diag export above this count

function showBatchExportModal() {
  // Disable individual curve/diag checkboxes for large batches
  const validCount = paramMatrix ? paramMatrix.filter(r => r && !r.error).length : 0;
  const tooMany = validCount > _BE_INDIV_LIMIT;
  for (const id of ['be-indiv-curves', 'be-indiv-diag']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.disabled = tooMany;
    if (tooMany) el.checked = false;
  }
  _updateBatchExportEstimate();
  // Attach onchange listeners for estimate updates
  ['be-indiv-curves', 'be-indiv-diag'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.onchange = _updateBatchExportEstimate;
  });
  $('#batchExportModal').modal('show');
}

function _updateBatchExportEstimate() {
  const el = document.getElementById('be-file-estimate');
  if (!el || !paramMatrix) return;
  const valid = paramMatrix.filter(r => r && !r.error);
  const nCurves = valid.length;
  // Count always-included charts: params xlsx + all param scatter plots + compare + aggregate + panels
  const nParamOpts = document.getElementById('mc-param-picker')?.options.length || 0;
  let nPanels = 0;
  document.querySelectorAll('canvas[id^="mc-panel-"]').forEach(() => nPanels++);
  const nCompare = document.getElementById('mc-compare-chart') ? 1 : 0;
  const nAggregate = document.getElementById('mc-aggregate-chart') ? 1 : 0;
  let count = 1 + nParamOpts + nPanels + nCompare + nAggregate; // xlsx + charts
  if (nCurves > _BE_INDIV_LIMIT) {
    el.textContent = `Estimated: ~${count} files for ${nCurves} curves ` +
      `(${nParamOpts} parameter plots, ${nPanels} group panels, compare, aggregate). ` +
      `Individual curve/diagnostic plots disabled for batches over ${_BE_INDIV_LIMIT} curves.`;
    return;
  }
  const nCached = valid.filter(r => mcDetailCache[r.slot]?.curves).length;
  const wantIndiv = document.getElementById('be-indiv-curves')?.checked ||
                    document.getElementById('be-indiv-diag')?.checked;
  if (document.getElementById('be-indiv-curves')?.checked) count += nCached * 4;
  if (document.getElementById('be-indiv-diag')?.checked) count += nCached * 4;
  let txt = `Estimated: ~${count} files for ${nCurves} curves.`;
  if (wantIndiv && nCached < nCurves) {
    txt += ` (${nCached}/${nCurves} curves inspected — click curves in the Time Series plot to cache them before export)`;
  }
  el.textContent = txt;
}

async function startBatchExport() {
  const btn = document.getElementById('be-start-btn');
  const progress = document.getElementById('be-progress');
  const bar = document.getElementById('be-progress-bar');
  const text = document.getElementById('be-progress-text');

  if (!paramMatrix) return;
  btn.disabled = true;
  progress.style.display = '';

  const inclCurves  = document.getElementById('be-indiv-curves')?.checked;
  const inclDiag    = document.getElementById('be-indiv-diag')?.checked;

  const validRows = paramMatrix.filter(r => r && !r.error);

  // Step 1: Build params table data
  const paramKeys = Object.keys(PARAM_GROUPS).flatMap(g => PARAM_GROUPS[g]);
  const header = ['#', 'Name', ...paramKeys.map(k => PARAM_LABELS[k] || k)];
  const rows = validRows.map(r => [
    r.slot + 1, r.name || `#${r.slot + 1}`,
    ...paramKeys.map(k => r[k] != null ? r[k] : '')
  ]);

  // Step 2: Capture all summary charts (always included)
  const _setProgress = (pct, msg) => {
    bar.style.width = pct + '%';
    bar.textContent = pct + '%';
    if (text) text.textContent = msg;
  };
  _setProgress(5, 'Preparing parameter table...');
  _setProgress(10, 'Capturing all parameter & summary plots...');
  const charts = MC.captureAllSummaryCharts();

  _setProgress(20, 'Sending data to server...');

  try {
    const payload = {
      params_header: header,
      params_rows: rows,
      charts: charts,
      stem: mcDataset?.filename || 'ojip_batch',
      include_curves: inclCurves,
      include_diag: inclDiag,
    };

    // If individual curves/diag are requested, include the curve data
    // so the server can generate matplotlib plots
    if (inclCurves || inclDiag) {
      const curveData = {};
      for (const r of validRows) {
        // Fetch detail for each curve if not cached
        const slot = r.slot;
        const detail = mcDetailCache[slot];
        if (detail && detail.curves) {
          curveData[r.name || `#${slot + 1}`] = {
            time_raw_ms: detail.time_raw_ms,
            time_log_ms: detail.time_log_ms,
            curves: detail.curves,
            key_values: detail,
          };
        }
      }
      payload.curve_data = curveData;
      _setProgress(30, `Sending ${Object.keys(curveData).length} curve datasets...`);
    }

    const resp = await fetch('/api/ojip_export_batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Server error (${resp.status}): ${errText.slice(0, 200)}`);
    }

    _setProgress(90, 'Downloading ZIP...');

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (mcDataset?.filename || 'ojip_batch').replace(/\.[^.]+$/, '') + '_export.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    _setProgress(100, 'Done!');
    setTimeout(() => {
      progress.style.display = 'none';
      btn.disabled = false;
      $('#batchExportModal').modal('hide');
    }, 1000);

  } catch (err) {
    _setProgress(0, '');
    progress.style.display = 'none';
    btn.disabled = false;
    alert('Batch export failed: ' + err.message);
  }
}
