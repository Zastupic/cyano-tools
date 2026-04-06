// ============================================================
//  CyanoTools Slow Kinetics Analyzer — frontend logic
//  Chart.js 4.x + chartjs-chart-error-bars
// ============================================================

// ── state ─────────────────────────────────────────────────────────────────
let skData      = null;   // full JSON from /api/slow_kin_process
let groups      = {};     // {filename: groupName}
let chartInst   = {};     // {chartId: Chart instance}
let dirtyTabs   = new Set();
let stIncludeD1 = false;  // checkbox: include first dark-recovery point
let skTracesNorm      = 'raw';  // 'raw' | 'normalized'
let skTracesNormTime  = 0;      // reference time for normalization
let skTracesJitter    = 0;      // time offset between successive traces
let skGrpTracesNorm      = 'raw';
let skGrpTracesNormTime  = 0;
let skGrpTracesJitter    = 0;   // time offset between successive groups

// ── parameter metadata ────────────────────────────────────────────────────
const SK_SUMMARY_KEYS   = ['fv_fm', 'rfd', 'npq_max', 'actinic_intensity'];
const SK_SUMMARY_LABELS = {
  fv_fm:             'Fv/Fm',
  rfd:               'Rfd',
  npq_max:           'NPQ max',
  actinic_intensity: 'Actinic (µmol m⁻² s⁻¹)',
};

const SK_DERIVED_YLABELS = {
  npq:       'NPQ (Fm)',
  npq_fmmax: 'NPQ (Fm,max)',
  qn:        'qN',
  qp:        'qP',
  qy:        'Y(II)',
  etr:       'rETR',
};

// ── colour helpers ────────────────────────────────────────────────────────
function sampleColor(i, n, alpha) {
  const h = Math.round((i / Math.max(n, 1)) * 320);
  return alpha !== undefined ? `hsla(${h},70%,42%,${alpha})` : `hsl(${h},70%,42%)`;
}
function groupColor(i, n, alpha) {
  const palette = [210, 30, 120, 270, 60, 180, 330];
  const h = palette[i % palette.length];
  return alpha !== undefined ? `hsla(${h},65%,42%,${alpha})` : `hsl(${h},65%,42%)`;
}

// ── chart helpers ─────────────────────────────────────────────────────────
function destroyChart(id) {
  if (chartInst[id]) { chartInst[id].destroy(); delete chartInst[id]; }
}
function makeChart(id, cfg) {
  destroyChart(id);
  const el = document.getElementById(id);
  if (!el) return null;
  // Fallback: destroy any orphaned Chart.js instance on this canvas
  // (can happen when a previous render threw before storing in chartInst)
  const orphan = Chart.getChart(el);
  if (orphan) orphan.destroy();
  chartInst[id] = new Chart(el, cfg);
  return chartInst[id];
}

// ── canvas capture for xlsx export ────────────────────────────────────────
var _SK_MAX_CHART_PX = 1200;
function _skChartToDataUrl(canvas) {
  var w = canvas.width, h = canvas.height;
  if (w > _SK_MAX_CHART_PX) { h = Math.round(h * _SK_MAX_CHART_PX / w); w = _SK_MAX_CHART_PX; }
  var tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  var ctx = tmp.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  return tmp.toDataURL('image/jpeg', 0.88);
}
function _captureSkCanvas(id) {
  if (!chartInst[id]) return null;
  var canvas = document.getElementById(id);
  if (!canvas) return null;
  var pane = canvas.closest('.tab-pane');
  var wasHidden = pane && getComputedStyle(pane).display === 'none';
  if (wasHidden) {
    pane.style.display = 'block'; pane.style.visibility = 'hidden';
    void pane.offsetWidth; chartInst[id].resize();
  }
  var du = _skChartToDataUrl(canvas);
  if (wasHidden) { pane.style.display = ''; pane.style.visibility = ''; }
  return (du && du.includes(',') && du.split(',')[1]) ? du : null;
}

function _withPaneVisible(paneId, fn) {
  const pane = document.getElementById(paneId);
  if (!pane) { fn(); return; }
  const wasHidden = getComputedStyle(pane).display === 'none';
  if (wasHidden) {
    pane.style.display = 'block';
    pane.style.visibility = 'hidden';
    void pane.offsetWidth;
  }
  fn();
  if (wasHidden) {
    pane.style.display = '';
    pane.style.visibility = '';
  }
}

// ── segmented control helper ──────────────────────────────────────────────
function setActiveBtn(groupId, activeBtn) {
  document.querySelectorAll(`#${groupId} .btn`).forEach(b => {
    b.classList.replace('btn-primary', 'btn-outline-primary');
  });
  activeBtn.classList.replace('btn-outline-primary', 'btn-primary');
}

// ── compact legend ────────────────────────────────────────────────────────
function compactLegend(position) {
  position = position || 'right';
  return {
    display: true, position,
    labels: {
      font: { size: 10 }, padding: 4, boxWidth: 12, boxHeight: 8,
      filter: function(item) { return item.text !== ''; },
      generateLabels: function(chart) {
        const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
        return items.map(function(d) {
          return Object.assign({}, d, { text: (d.text || '').length > 24 ? d.text.slice(0, 22) + '…' : (d.text || '') });
        });
      },
    },
  };
}

// ── chart option builders ─────────────────────────────────────────────────
function linearScatterOpts(xLabel, yLabel) {
  return {
    animation: false, parsing: false, responsive: true, maintainAspectRatio: false,
    scales: {
      x: { type: 'linear', title: { display: true, text: xLabel } },
      y: { title: { display: true, text: yLabel } },
    },
    plugins: { legend: compactLegend('right'), tooltip: { mode: 'nearest', intersect: false } },
    elements: { line: { tension: 0 } },
  };
}

function barOpts(yLabel) {
  return {
    animation: false, responsive: true, maintainAspectRatio: false,
    scales: { x: { ticks: { maxRotation: 40 } }, y: { title: { display: true, text: yLabel || '' } } },
    plugins: { legend: compactLegend('top') },
  };
}

// ── format helpers ────────────────────────────────────────────────────────
function fmt(v, d) {
  d = d !== undefined ? d : 4;
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(d);
}
function esc(s) { return String(s).replace(/[^a-z0-9]/gi, '_'); }

function timeAxisLabel(timeUnit) {
  if (timeUnit === 'us') return 'Time (µs)';
  if (timeUnit === 's')  return 'Time (s)';
  return 'Time';
}

// ── normalization helper ──────────────────────────────────────────────────
// Returns a new array of values divided by the value at the time point
// nearest to refTime. Returns the original array if refVal is 0 or null.
function normalizeTraceArr(values, times, refTime) {
  var refIdx = 0, minDist = Infinity;
  for (var j = 0; j < times.length; j++) {
    var d = Math.abs(times[j] - refTime);
    if (d < minDist) { minDist = d; refIdx = j; }
  }
  var refVal = values[refIdx];
  if (!refVal || refVal === 0) return values.slice();
  return values.map(function(v) { return v != null ? v / refVal : null; });
}

// ── tab dirty tracking ────────────────────────────────────────────────────
function markTabsDirty() {
  for (var i = 0; i < arguments.length; i++) dirtyTabs.add(arguments[i]);
}

function renderDirtyTab(tabId) {
  if (!skData || !dirtyTabs.has(tabId)) return;
  dirtyTabs.delete(tabId);
  if (tabId === 'sk-tab-traces')  { renderTracesChart(); return; }
  if (tabId === 'sk-tab-ftfm')    { renderFtFmChart(); return; }
  if (tabId === 'sk-tab-derived') {
    var m = (document.querySelector('#sk-derived-btns .btn-primary') || {}).dataset;
    renderDerivedChart((m && m.derived) || 'npq'); return;
  }
  if (tabId === 'sk-tab-params')  { renderParamsChart(); renderParamsTable(); return; }
  if (tabId === 'sk-tab-st')      { renderStTab(); return; }
  if (tabId === 'sk-tab-groups')  {
    refreshGroupSummary();
    if (hasGroups()) {
      var gr = document.getElementById('sk-group-results');
      if (gr) { gr.style.display = ''; void gr.offsetWidth; }
      renderGroupTracesChart();
      if (skData.has_params) {
        var gdb = document.querySelector('#sk-group-derived-btns .btn-primary');
        renderGroupDerivedChart((gdb && gdb.dataset && gdb.dataset.gderived) || 'npq');
      }
      if (skData.has_summary) renderGroupParamsChart();
      if (skData.has_state_transitions) {
        var gsb = document.querySelector('#sk-group-st-btns .btn-primary');
        renderGroupStChart((gsb && gsb.dataset && gsb.dataset.gst) || 'delta_fm_pct');
      }
      setTimeout(function() {
        ['sk-group-traces-chart', 'sk-group-derived-chart', 'sk-group-params-chart', 'sk-group-st-chart'].forEach(function(id) {
          if (chartInst[id]) chartInst[id].resize();
        });
      }, 0);
    }
  }
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function() {

  // Fluorometer select → toggle option panels
  var flSel = document.getElementById('sk-fluorometer');
  if (flSel) {
    flSel.addEventListener('change', _toggleFluorometerOptions);
    _toggleFluorometerOptions();
  }

  // MC-PAM file type → toggle reduce option
  document.querySelectorAll('input[name="mc_pam_file_type"]').forEach(function(r) {
    r.addEventListener('change', function() {
      var isRaw = (document.querySelector('input[name="mc_pam_file_type"]:checked') || {}).value === 'raw_data';
      var reduceOpt = document.getElementById('reduce-option');
      if (reduceOpt) reduceOpt.style.display = isRaw ? '' : 'none';
    });
  });

  // Drop-zone
  var dz   = document.getElementById('sk-drop-zone');
  var finp = document.getElementById('sk-files');
  if (dz && finp) {
    dz.addEventListener('click', function() { finp.click(); });
    dz.addEventListener('dragover',  function(e) { e.preventDefault(); dz.style.background = '#e8f4fd'; });
    dz.addEventListener('dragleave', function()  { dz.style.background = '#f8f9fa'; });
    dz.addEventListener('drop', function(e) {
      e.preventDefault(); dz.style.background = '#f8f9fa';
      finp.files = e.dataTransfer.files; updateFileList();
    });
    finp.addEventListener('change', updateFileList);
  }

  // Analyze button
  var analyzeBtn = document.getElementById('sk-analyze-btn');
  if (analyzeBtn) analyzeBtn.addEventListener('click', uploadAndAnalyze);

  // Ft & Fm segmented control
  var ftfmBtns = document.getElementById('sk-ftfm-btns');
  if (ftfmBtns) {
    ftfmBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-ftfm]'); if (!btn) return;
      setActiveBtn('sk-ftfm-btns', btn);
      renderFtFmChart(btn.dataset.ftfm);
    });
  }

  // Derived segmented control
  var derivedBtns = document.getElementById('sk-derived-btns');
  if (derivedBtns) {
    derivedBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-derived]'); if (!btn) return;
      setActiveBtn('sk-derived-btns', btn);
      renderDerivedChart(btn.dataset.derived);
    });
  }

  // Group ST segmented control
  var gStBtns = document.getElementById('sk-group-st-btns');
  if (gStBtns) {
    gStBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-gst]'); if (!btn) return;
      setActiveBtn('sk-group-st-btns', btn);
      renderGroupStChart(btn.dataset.gst);
    });
  }

  // Group derived segmented control
  var gDerivedBtns = document.getElementById('sk-group-derived-btns');
  if (gDerivedBtns) {
    gDerivedBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-gderived]'); if (!btn) return;
      setActiveBtn('sk-group-derived-btns', btn);
      renderGroupDerivedChart(btn.dataset.gderived);
    });
  }

  // Copy params table
  var copyBtn = document.getElementById('sk-copy-params-btn');
  if (copyBtn) copyBtn.addEventListener('click', copyParamsTable);

  // Groups tab controls
  var selAllCheck = document.getElementById('sk-select-all-check');
  if (selAllCheck) selAllCheck.addEventListener('change', function(e) {
    document.querySelectorAll('.sk-group-check').forEach(function(cb) { cb.checked = e.target.checked; });
  });
  var sortAsc  = document.getElementById('sk-sort-asc-btn');
  var sortDesc = document.getElementById('sk-sort-desc-btn');
  var autoDetect = document.getElementById('sk-auto-detect-btn');
  var clearGrp = document.getElementById('sk-clear-groups-btn');
  var assignBtn = document.getElementById('sk-assign-group-btn');
  var assignTbl = document.getElementById('sk-group-assign-table');
  if (sortAsc)    sortAsc.addEventListener('click',  function() { sortFiles('asc'); });
  if (sortDesc)   sortDesc.addEventListener('click', function() { sortFiles('desc'); });
  if (autoDetect) autoDetect.addEventListener('click', autoDetectGroups);
  if (clearGrp)   clearGrp.addEventListener('click',  clearAllGroups);
  if (assignBtn)  assignBtn.addEventListener('click',  assignGroup);
  if (assignTbl)  assignTbl.addEventListener('click',  _onGroupAssignClick);

  // Show-individual toggle
  var showIndivCheck = document.getElementById('sk-show-individual-check');
  if (showIndivCheck) showIndivCheck.addEventListener('change', function() {
    if (hasGroups()) renderGroupTracesChart();
  });

  // Traces normalization
  var tracesNormBtns = document.getElementById('sk-traces-norm-btns');
  if (tracesNormBtns) {
    tracesNormBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-norm]'); if (!btn) return;
      setActiveBtn('sk-traces-norm-btns', btn);
      skTracesNorm = btn.dataset.norm;
      var box = document.getElementById('sk-traces-norm-time-box');
      if (box) box.style.display = skTracesNorm === 'normalized' ? '' : 'none';
      if (skData) renderTracesChart();
    });
  }
  var tracesNormTimeInp = document.getElementById('sk-traces-norm-time');
  if (tracesNormTimeInp) {
    tracesNormTimeInp.addEventListener('change', function() {
      skTracesNormTime = parseFloat(this.value) || 0;
      if (skData && skTracesNorm === 'normalized') renderTracesChart();
    });
  }

  // Group traces normalization
  var grpTracesNormBtns = document.getElementById('sk-group-traces-norm-btns');
  if (grpTracesNormBtns) {
    grpTracesNormBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-gnorm]'); if (!btn) return;
      setActiveBtn('sk-group-traces-norm-btns', btn);
      skGrpTracesNorm = btn.dataset.gnorm;
      var box = document.getElementById('sk-group-traces-norm-time-box');
      if (box) box.style.display = skGrpTracesNorm === 'normalized' ? '' : 'none';
      if (skData && hasGroups()) renderGroupTracesChart();
    });
  }
  var grpTracesNormTimeInp = document.getElementById('sk-group-traces-norm-time');
  if (grpTracesNormTimeInp) {
    grpTracesNormTimeInp.addEventListener('change', function() {
      skGrpTracesNormTime = parseFloat(this.value) || 0;
      if (skData && skGrpTracesNorm === 'normalized' && hasGroups()) renderGroupTracesChart();
    });
  }

  // Traces jitter
  var tracesJitterInp = document.getElementById('sk-traces-jitter');
  if (tracesJitterInp) {
    tracesJitterInp.addEventListener('change', function() {
      skTracesJitter = parseFloat(this.value) || 0;
      if (skData) renderTracesChart();
    });
  }

  // Group traces jitter
  var grpTracesJitterInp = document.getElementById('sk-group-traces-jitter');
  if (grpTracesJitterInp) {
    grpTracesJitterInp.addEventListener('change', function() {
      skGrpTracesJitter = parseFloat(this.value) || 0;
      if (skData && hasGroups()) renderGroupTracesChart();
    });
  }

  // Export to statistics
  var exportBtn = document.getElementById('sk-export-stats-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportToStatistics);

  // State Transitions controls
  var stD1Check = document.getElementById('sk-st-include-d1-check');
  if (stD1Check) stD1Check.addEventListener('change', function() {
    stIncludeD1 = stD1Check.checked;
    if (skData && skData.has_state_transitions) refitStateTransitions();
  });
  var stWinBtn = document.getElementById('sk-st-windows-toggle-btn');
  if (stWinBtn) stWinBtn.addEventListener('click', function() {
    var panel = document.getElementById('sk-st-windows-panel');
    if (!panel) return;
    var showing = panel.style.display !== 'none';
    panel.style.display = showing ? 'none' : '';
    if (!showing) buildStWindowsPanel();
  });
  var stRefitBtn = document.getElementById('sk-st-refit-btn');
  if (stRefitBtn) stRefitBtn.addEventListener('click', function() {
    refitStateTransitions(true);  // true = use custom windows from panel
  });

  // Export modal (event delegation, wired once)
  _initExportModalEvents();

  // Tab shown → resize and render dirty
  var tabs = document.getElementById('skTabs');
  if (tabs) {
    tabs.addEventListener('shown.bs.tab', function(e) {
      if (!skData) return;
      var tabId = (e.target.getAttribute('href') || '').slice(1);
      renderDirtyTab(tabId);
      var resizeMap = {
        'sk-tab-traces':  ['sk-traces-chart'],
        'sk-tab-ftfm':    ['sk-ftfm-chart'],
        'sk-tab-derived': ['sk-derived-chart'],
        'sk-tab-params':  ['sk-params-chart'],
        'sk-tab-groups':  ['sk-group-traces-chart', 'sk-group-derived-chart', 'sk-group-params-chart', 'sk-group-st-chart'],
        'sk-tab-st':      ['sk-st-chart'],
      };
      (resizeMap[tabId] || []).forEach(function(id) { if (chartInst[id]) chartInst[id].resize(); });
    });
  }

  // Fluorometer localStorage persistence
  var savedFl = localStorage.getItem('sk_fluorometer');
  if (savedFl && flSel) {
    flSel.value = savedFl;
    _toggleFluorometerOptions();
  }
});

// ── fluorometer option toggle ─────────────────────────────────────────────
function _toggleFluorometerOptions() {
  var val     = (document.getElementById('sk-fluorometer') || {}).value;
  var apOpts  = document.getElementById('aquapen-options');
  var mcOpts  = document.getElementById('mcpam-options');
  if (!apOpts || !mcOpts) return;
  if (val === 'AquaPen') {
    apOpts.style.display = ''; mcOpts.style.display = 'none';
  } else {
    apOpts.style.display = 'none'; mcOpts.style.display = '';
  }
}

// ── file list ─────────────────────────────────────────────────────────────
function updateFileList() {
  var files = document.getElementById('sk-files').files;
  var lbl   = document.getElementById('sk-file-count-label');
  var list  = document.getElementById('sk-file-list');
  var btn   = document.getElementById('sk-analyze-btn');
  if (!files.length) {
    if (lbl)  lbl.textContent  = 'No files selected';
    if (list) list.innerHTML   = '';
    if (btn)  btn.disabled     = true;
    return;
  }
  if (lbl)  lbl.textContent = files.length + ' file(s) selected';
  if (list) list.innerHTML  = Array.from(files).map(function(f) {
    return '<span class="badge badge-light border mr-1">' + f.name + '</span>';
  }).join('');
  if (btn)  btn.disabled = false;
}

// ── upload & analyze ──────────────────────────────────────────────────────
async function uploadAndAnalyze() {
  var files = document.getElementById('sk-files').files;
  if (!files.length) return;

  var fluorometer   = (document.getElementById('sk-fluorometer') || {}).value || 'AquaPen';
  var aquapenProto  = ((document.querySelector('input[name="aquapen_protocol"]:checked') || {}).value) || 'NPQ1';
  var mcPamFileType = ((document.querySelector('input[name="mc_pam_file_type"]:checked') || {}).value) || 'parameters';
  var reduceData    = (document.getElementById('reduce-data') || {}).checked ? 'true' : 'false';

  var fd = new FormData();
  Array.from(files).forEach(function(f) { fd.append('NPQ_files', f); });
  fd.append('fluorometer',      fluorometer);
  fd.append('aquapen_protocol', aquapenProto);
  fd.append('mc_pam_file_type', mcPamFileType);
  fd.append('reduce_data',      reduceData);

  var errDiv    = document.getElementById('sk-upload-error');
  var fileNames = Array.from(files).map(function(f) { return f.name; }).join(', ');
  if (errDiv) errDiv.style.display = 'none';
  setLoading(true);

  localStorage.setItem('sk_fluorometer', fluorometer);

  try {
    var resp    = await fetch('/api/slow_kin_process', { method: 'POST', body: fd });
    var rawText = await resp.text();

    var data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      var preview = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
      if (errDiv) {
        errDiv.innerHTML =
          '<strong>Server error</strong> (HTTP ' + resp.status + ') while processing: <em>' + fileNames + '</em><br>' +
          '<details><summary>Server response</summary>' +
          '<pre style="font-size:0.78em;white-space:pre-wrap;max-height:200px;overflow:auto">' + preview + '</pre></details>';
        errDiv.style.display = '';
      }
      return;
    }

    if (data.status === 'error') {
      if (errDiv) {
        errDiv.innerHTML = '<strong>Processing error</strong> for: <em>' + fileNames + '</em><br>' + data.message;
        errDiv.style.display = '';
      }
      return;
    }

    skData = data;
    groups = {};
    var resultsSection = document.getElementById('sk-results-section');
    if (resultsSection) {
      resultsSection.style.display = '';
      renderResults();
      resultsSection.scrollIntoView({ behavior: 'smooth' });
    }

  } catch (err) {
    if (errDiv) {
      errDiv.innerHTML = '<strong>Network error</strong> while uploading: <em>' + fileNames + '</em><br>' + err.message;
      errDiv.style.display = '';
    }
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  var btn = document.getElementById('sk-analyze-btn');
  var sp  = document.getElementById('sk-spinner');
  if (btn) btn.disabled    = on;
  if (sp)  sp.style.display = on ? '' : 'none';
}

// ── render all results ────────────────────────────────────────────────────
function renderResults() {
  var n      = skData.files.length;
  var mode   = skData.mode === 'raw_data' ? ' (raw data)' : '';
  var proto  = skData.protocol ? ' — ' + skData.protocol : '';
  var sumEl  = document.getElementById('sk-results-summary');
  if (sumEl) sumEl.textContent = n + ' file' + (n > 1 ? 's' : '') + ' processed — ' + skData.fluorometer + mode + proto;

  // Show/hide tab content based on mode
  var isRawOnly = !skData.has_params;
  ['sk-ftfm-unavail', 'sk-derived-unavail', 'sk-params-unavail'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = isRawOnly ? '' : 'none';
  });
  ['sk-ftfm-content', 'sk-derived-content', 'sk-params-content'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = isRawOnly ? 'none' : '';
  });

  var gds = document.getElementById('sk-group-derived-section');
  if (gds) gds.style.display = isRawOnly ? 'none' : '';
  var gps = document.getElementById('sk-group-params-section');
  if (gps) gps.style.display = skData.has_summary ? '' : 'none';
  var gss = document.getElementById('sk-group-st-section');
  if (gss) gss.style.display = skData.has_state_transitions ? '' : 'none';

  // Wire download buttons
  var xlsxLink    = document.getElementById('sk-xlsx-download-link');
  var xlsxFullBtn = document.getElementById('sk-xlsx-fulldata-btn');
  if (xlsxLink) {
    xlsxLink.style.display = '';
    xlsxLink.href = '#';
    xlsxLink.onclick = function(e) { e.preventDefault(); downloadXlsx(true); };
  }
  if (xlsxFullBtn) {
    xlsxFullBtn.style.display = '';
    xlsxFullBtn.onclick = function() { downloadXlsx(false); };
  }

  // Reset normalization and jitter state on new data load
  skTracesNorm = 'raw'; skTracesNormTime = 0; skTracesJitter = 0;
  skGrpTracesNorm = 'raw'; skGrpTracesNormTime = 0; skGrpTracesJitter = 0;
  var jitterInp = document.getElementById('sk-traces-jitter');
  if (jitterInp) jitterInp.value = 0;
  var grpJitterInp = document.getElementById('sk-group-traces-jitter');
  if (grpJitterInp) grpJitterInp.value = 0;
  ['sk-traces-norm-btns', 'sk-group-traces-norm-btns'].forEach(function(id) {
    var btns = document.getElementById(id);
    if (!btns) return;
    btns.querySelectorAll('.btn').forEach(function(b) {
      var isRaw = b.dataset.norm === 'raw' || b.dataset.gnorm === 'raw';
      b.classList.toggle('btn-primary', isRaw);
      b.classList.toggle('btn-outline-primary', !isRaw);
    });
  });
  var tBox = document.getElementById('sk-traces-norm-time-box');
  if (tBox) tBox.style.display = 'none';
  var gBox = document.getElementById('sk-group-traces-norm-time-box');
  if (gBox) gBox.style.display = 'none';
  // Populate time unit labels (normalization ref + jitter)
  var unit = skData.time_unit === 'us' ? 'µs' : (skData.time_unit || 's');
  ['sk-traces-norm-time-unit', 'sk-group-traces-norm-time-unit',
   'sk-traces-jitter-unit', 'sk-group-traces-jitter-unit'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.textContent = unit;
  });

  // Render visible Traces tab
  renderTracesChart();

  // Pre-render hidden tabs so Chart.js measures correctly
  if (!isRawOnly) {
    _withPaneVisible('sk-tab-ftfm',    function() { renderFtFmChart('ft'); });
    _withPaneVisible('sk-tab-derived', function() { renderDerivedChart('npq'); });
    _withPaneVisible('sk-tab-params',  function() { renderParamsChart(); renderParamsTable(); });
  }

  // Groups tab is lazy
  buildGroupAssignTable();
  markTabsDirty('sk-tab-groups');

  // State Transitions tab
  stIncludeD1 = false;
  var stCheck = document.getElementById('sk-st-include-d1-check');
  if (stCheck) stCheck.checked = false;
  var stLink = document.getElementById('sk-tab-st-link');
  if (stLink) {
    if (skData.has_state_transitions) {
      stLink.classList.remove('disabled');
      stLink.style.pointerEvents = '';
      stLink.style.color = '';
      _withPaneVisible('sk-tab-st', function() { renderStTab(); });
    } else {
      stLink.classList.add('disabled');
      stLink.style.pointerEvents = 'none';
      stLink.style.color = '#adb5bd';
    }
  }
}

// ── traces chart ──────────────────────────────────────────────────────────
function renderTracesChart() {
  if (!skData) return;
  var files    = skData.files;
  var t        = skData.raw_time;
  var n        = files.length;
  var norm     = skTracesNorm === 'normalized';
  var normTime = skTracesNormTime;
  var yLabel   = norm ? 'F / F(ref)' : 'Fluorescence (a.u.)';

  var datasets = files.map(function(fname, i) {
    var raw    = skData.raw_traces[fname] || [];
    var vals   = norm ? normalizeTraceArr(raw, t, normTime) : raw;
    var offset = i * skTracesJitter;
    return {
      label:           fname,
      data:            vals.map(function(y, j) { return { x: t[j] + offset, y: y }; }),
      borderColor:     sampleColor(i, n),
      backgroundColor: 'transparent',
      borderWidth: 1.5, pointRadius: 0, showLine: true,
    };
  });
  makeChart('sk-traces-chart', {
    type: 'scatter',
    data: { datasets: datasets },
    options: linearScatterOpts(timeAxisLabel(skData.time_unit), yLabel),
  });
}

// ── Ft & Fm chart ─────────────────────────────────────────────────────────
function renderFtFmChart(metric) {
  if (!skData || !skData.has_params) return;
  metric = metric || (function() {
    var el = document.querySelector('#sk-ftfm-btns .btn-primary');
    return (el && el.dataset && el.dataset.ftfm) || 'ft';
  })();
  var files   = skData.files;
  var t       = skData.param_time;
  var n       = files.length;
  var yLabels = { ft: 'Ft (a.u.)', fm: "Fm' (a.u.)", fv: "Fv' (a.u.)" };

  var datasets = files.map(function(fname, i) {
    return {
      label:           fname,
      data:            (skData.params[fname] && skData.params[fname][metric] || []).map(function(y, j) { return { x: t[j], y: y }; }),
      borderColor:     sampleColor(i, n),
      backgroundColor: sampleColor(i, n, 0.2),
      borderWidth: 2, pointRadius: 3, showLine: true,
    };
  });

  makeChart('sk-ftfm-chart', {
    type: 'scatter',
    data: { datasets: datasets },
    options: linearScatterOpts(timeAxisLabel(skData.time_unit), yLabels[metric] || metric),
  });
}

// ── derived timeseries chart ──────────────────────────────────────────────
function renderDerivedChart(metric) {
  if (!skData || !skData.has_params) return;
  metric = metric || 'npq';
  var npqMetrics = ['npq', 'npq_fmmax', 'qp', 'qn'];
  var t = (npqMetrics.indexOf(metric) >= 0 && skData.param_time_npq)
          ? skData.param_time_npq
          : skData.param_time;
  var files = skData.files;
  var n     = files.length;

  var datasets = files.map(function(fname, i) {
    return {
      label:           fname,
      data:            (skData.params[fname] && skData.params[fname][metric] || []).map(function(y, j) { return { x: t[j], y: y }; }),
      borderColor:     sampleColor(i, n),
      backgroundColor: sampleColor(i, n, 0.2),
      borderWidth: 2, pointRadius: 3, showLine: true,
    };
  });

  makeChart('sk-derived-chart', {
    type: 'scatter',
    data: { datasets: datasets },
    options: linearScatterOpts(timeAxisLabel(skData.time_unit), SK_DERIVED_YLABELS[metric] || metric),
  });
}

// ── parameters (summary scalars) chart ───────────────────────────────────
function renderParamsChart() {
  if (!skData || !skData.has_summary) return;
  var files  = skData.files;
  var n      = files.length;
  var keys   = SK_SUMMARY_KEYS.filter(function(k) {
    return files.some(function(f) { return skData.summary[f] && skData.summary[f][k] != null; });
  });
  var labels = keys.map(function(k) { return SK_SUMMARY_LABELS[k] || k; });

  var datasets = files.map(function(fname, i) {
    return {
      label:           fname,
      data:            keys.map(function(k) {
        var v = skData.summary[fname] && skData.summary[fname][k];
        return (v != null && isFinite(v)) ? v : null;
      }),
      backgroundColor: sampleColor(i, n, 0.7),
      borderColor:     sampleColor(i, n),
      borderWidth: 1,
    };
  });

  makeChart('sk-params-chart', { type: 'bar', data: { labels: labels, datasets: datasets }, options: barOpts() });
}

// ── parameters table ──────────────────────────────────────────────────────
function renderParamsTable() {
  if (!skData || !skData.has_summary) return;
  var files = skData.files;
  var keys  = SK_SUMMARY_KEYS.filter(function(k) {
    return files.some(function(f) { return skData.summary[f] && skData.summary[f][k] != null; });
  });

  var headRow = document.getElementById('sk-params-table-head');
  var body    = document.getElementById('sk-params-table-body');
  if (!headRow || !body) return;

  headRow.innerHTML = '<th>Sample</th>' + keys.map(function(k) { return '<th>' + (SK_SUMMARY_LABELS[k] || k) + '</th>'; }).join('');
  body.innerHTML = files.map(function(fname) {
    var s = skData.summary[fname] || {};
    return '<tr><td>' + fname + '</td>' + keys.map(function(k) { return '<td>' + fmt(s[k]) + '</td>'; }).join('') + '</tr>';
  }).join('');
}

function copyParamsTable() {
  var tbl = document.getElementById('sk-params-table');
  if (!tbl) return;
  var rows = Array.from(tbl.querySelectorAll('tr')).map(function(r) {
    return Array.from(r.querySelectorAll('th,td')).map(function(c) { return c.textContent.trim(); }).join('\t');
  });
  if (navigator.clipboard) navigator.clipboard.writeText(rows.join('\n'));
}

// ── group assignment ──────────────────────────────────────────────────────
function buildGroupAssignTable() {
  var tbody = document.getElementById('sk-group-assign-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  (skData && skData.files || []).forEach(function(fname) {
    var tr = document.createElement('tr');
    tr.dataset.fname = fname;
    tr.innerHTML =
      '<td><input type="checkbox" class="sk-group-check" value="' + fname + '"></td>' +
      '<td>' + fname + '</td>' +
      '<td><span class="group-badge" id="sk-gbadge-' + esc(fname) + '">—</span></td>' +
      '<td><button class="btn btn-sm btn-link text-danger p-0 sk-remove-group-btn" data-fname="' + fname + '">✕</button></td>';
    tbody.appendChild(tr);
  });
}

function _onGroupAssignClick(e) {
  if (!e.target.classList.contains('sk-remove-group-btn')) return;
  var fname = e.target.dataset.fname;
  delete groups[fname];
  updateGroupBadge(fname, null);
  refreshGroupSummary(); checkGroupsReady();
}

function assignGroup() {
  var inp  = document.getElementById('sk-group-name-input');
  var name = inp ? inp.value.trim() : '';
  if (!name) { alert('Please enter a group name.'); return; }
  var checked = Array.from(document.querySelectorAll('.sk-group-check:checked'));
  if (!checked.length) { alert('Please select at least one sample.'); return; }
  checked.forEach(function(cb) { groups[cb.value] = name; updateGroupBadge(cb.value, name); cb.checked = false; });
  var allCheck = document.getElementById('sk-select-all-check');
  if (allCheck) allCheck.checked = false;
  refreshGroupSummary(); checkGroupsReady();
}

function clearAllGroups() {
  groups = {};
  (skData && skData.files || []).forEach(function(f) { updateGroupBadge(f, null); });
  refreshGroupSummary();
  var gr = document.getElementById('sk-group-results');
  if (gr) gr.style.display = 'none';
}

function autoDetectGroups() {
  (skData && skData.files || []).forEach(function(fname) {
    var m   = fname.match(/^([a-z_\- ]+)/i);
    var grp = m ? m[1].replace(/[_\- ]+$/, '') : fname;
    groups[fname] = grp; updateGroupBadge(fname, grp);
  });
  refreshGroupSummary(); checkGroupsReady();
}

function sortFiles(order) {
  if (!skData) return;
  skData.files.sort(function(a, b) { return order === 'asc' ? a.localeCompare(b) : b.localeCompare(a); });
  renderTracesChart();
  buildGroupAssignTable();
  Object.keys(groups).forEach(function(f) { updateGroupBadge(f, groups[f]); });
  markTabsDirty('sk-tab-ftfm', 'sk-tab-derived', 'sk-tab-params', 'sk-tab-groups');
  refreshGroupSummary(); checkGroupsReady();
}

function updateGroupBadge(fname, grpName) {
  var el = document.getElementById('sk-gbadge-' + esc(fname));
  if (!el) return;
  if (grpName) { el.className = 'badge badge-primary'; el.textContent = grpName; }
  else         { el.className = ''; el.textContent = '—'; }
}

function refreshGroupSummary() {
  var grpMap = {};
  Object.keys(groups).forEach(function(f) {
    var g = groups[f];
    if (!grpMap[g]) grpMap[g] = [];
    grpMap[g].push(f);
  });
  var html = Object.keys(grpMap).map(function(g) {
    return '<span class="badge badge-light border mr-1"><strong>' + g + '</strong>: ' + grpMap[g].length + ' sample(s)</span>';
  }).join('');
  var el = document.getElementById('sk-groups-summary');
  if (el) el.innerHTML = html;
}

function hasGroups() {
  return new Set(Object.values(groups)).size >= 2;
}

function checkGroupsReady() {
  var gr = document.getElementById('sk-group-results');
  if (hasGroups()) {
    if (gr) { gr.style.display = ''; void gr.offsetWidth; }
    var _activeEl  = document.querySelector('#skTabs .nav-link.active');
    var activeHref = _activeEl ? _activeEl.getAttribute('href') : '';
    if (activeHref === '#sk-tab-groups') {
      renderGroupTracesChart();
      if (skData && skData.has_params) {
        var gdb = document.querySelector('#sk-group-derived-btns .btn-primary');
        renderGroupDerivedChart((gdb && gdb.dataset && gdb.dataset.gderived) || 'npq');
      }
      if (skData && skData.has_summary) renderGroupParamsChart();
      if (skData && skData.has_state_transitions) {
        var gsb2 = document.querySelector('#sk-group-st-btns .btn-primary');
        renderGroupStChart((gsb2 && gsb2.dataset && gsb2.dataset.gst) || 'delta_fm_pct');
      }
      setTimeout(function() {
        ['sk-group-traces-chart', 'sk-group-derived-chart', 'sk-group-params-chart', 'sk-group-st-chart'].forEach(function(id) {
          if (chartInst[id]) chartInst[id].resize();
        });
      }, 0);
    } else {
      // Pre-render while tab pane is temporarily visible so canvases have correct dimensions
      _withPaneVisible('sk-tab-groups', function() {
        var innerGr = document.getElementById('sk-group-results');
        if (innerGr) { innerGr.style.display = ''; void innerGr.offsetWidth; }
        renderGroupTracesChart();
        if (skData && skData.has_params) {
          var gdb2 = document.querySelector('#sk-group-derived-btns .btn-primary');
          renderGroupDerivedChart((gdb2 && gdb2.dataset && gdb2.dataset.gderived) || 'npq');
        }
        if (skData && skData.has_summary) renderGroupParamsChart();
        if (skData && skData.has_state_transitions) {
          var gsb3 = document.querySelector('#sk-group-st-btns .btn-primary');
          renderGroupStChart((gsb3 && gsb3.dataset && gsb3.dataset.gst) || 'delta_fm_pct');
        }
      });
      // sk-group-results remains visible (inline display:none was cleared inside fn above)
    }
  } else {
    if (gr) gr.style.display = 'none';
    dirtyTabs.delete('sk-tab-groups');
  }
}

// ── group statistics helpers ──────────────────────────────────────────────
function _grpFiles() {
  var m = {};
  Object.keys(groups).forEach(function(f) {
    var g = groups[f];
    if (!m[g]) m[g] = [];
    m[g].push(f);
  });
  return m;
}

function calcGroupTraceStats() {
  var grpFilesMap = _grpFiles();
  var t = skData.raw_time;
  var st = {};
  Object.keys(grpFilesMap).forEach(function(grp) {
    var files  = grpFilesMap[grp];
    var arrs   = files.map(function(f) { return skData.raw_traces[f] || []; });
    var n_pts  = t.length;
    var means  = [], sds = [];
    for (var j = 0; j < n_pts; j++) {
      var vals = arrs.map(function(a) { return a[j]; }).filter(function(v) { return v != null && isFinite(v); });
      var mu   = vals.length ? vals.reduce(function(s, v) { return s + v; }, 0) / vals.length : null;
      var sd   = mu !== null ? Math.sqrt(vals.reduce(function(s, v) { return s + (v - mu) * (v - mu); }, 0) / vals.length) : null;
      means.push(mu); sds.push(sd);
    }
    st[grp] = { files: files, means: means, sds: sds };
  });
  return st;
}

function calcGroupDerivedStats(metric) {
  var grpFilesMap = _grpFiles();
  var npqMetrics  = ['npq', 'npq_fmmax', 'qp', 'qn'];
  var t = (npqMetrics.indexOf(metric) >= 0 && skData.param_time_npq)
          ? skData.param_time_npq
          : skData.param_time;
  var st = {};
  Object.keys(grpFilesMap).forEach(function(grp) {
    var files  = grpFilesMap[grp];
    var arrs   = files.map(function(f) { return (skData.params[f] && skData.params[f][metric]) || []; });
    var n_pts  = t.length;
    var means  = [], sds = [];
    for (var j = 0; j < n_pts; j++) {
      var vals = arrs.map(function(a) { return a[j]; }).filter(function(v) { return v != null && isFinite(v); });
      var mu   = vals.length ? vals.reduce(function(s, v) { return s + v; }, 0) / vals.length : null;
      var sd   = mu !== null ? Math.sqrt(vals.reduce(function(s, v) { return s + (v - mu) * (v - mu); }, 0) / vals.length) : null;
      means.push(mu); sds.push(sd);
    }
    st[grp] = { files: files, means: means, sds: sds };
  });
  return { stats: st, t: t };
}

function calcGroupSummaryStats() {
  var grpFilesMap = _grpFiles();
  var st = {};
  Object.keys(grpFilesMap).forEach(function(grp) {
    var files = grpFilesMap[grp];
    st[grp] = { files: files, params: {} };
    SK_SUMMARY_KEYS.forEach(function(k) {
      var vals = files.map(function(f) {
        return skData.summary[f] && skData.summary[f][k];
      }).filter(function(v) { return v != null && isFinite(v); });
      if (!vals.length) return;
      var mu = vals.reduce(function(s, v) { return s + v; }, 0) / vals.length;
      var sd = Math.sqrt(vals.reduce(function(s, v) { return s + (v - mu) * (v - mu); }, 0) / vals.length);
      st[grp].params[k] = { mean: mu, sd: sd, n: vals.length };
    });
  });
  return st;
}

// ── group traces chart ────────────────────────────────────────────────────
function renderGroupTracesChart() {
  if (!skData) return;
  var t          = skData.raw_time;
  var showIndiv  = (document.getElementById('sk-show-individual-check') || {}).checked !== false;
  var norm       = skGrpTracesNorm === 'normalized';
  var normTime   = skGrpTracesNormTime;
  var yLabel     = norm ? 'F / F(ref)' : 'Fluorescence (a.u.)';
  var datasets   = [];

  // Helper: get (optionally normalized) trace for a file
  function getTrace(fname) {
    var raw = skData.raw_traces[fname] || [];
    return norm ? normalizeTraceArr(raw, t, normTime) : raw;
  }

  var grpFilesMap = _grpFiles();
  var grpNames    = Object.keys(grpFilesMap);

  grpNames.forEach(function(grp, gi) {
    var files  = grpFilesMap[grp];
    var arrs   = files.map(getTrace);
    var n_pts  = t.length;
    var means  = [], sds = [];
    for (var j = 0; j < n_pts; j++) {
      var vals = arrs.map(function(a) { return a[j]; }).filter(function(v) { return v != null && isFinite(v); });
      var mu   = vals.length ? vals.reduce(function(s, v) { return s + v; }, 0) / vals.length : null;
      var sd   = mu !== null ? Math.sqrt(vals.reduce(function(s, v) { return s + (v - mu) * (v - mu); }, 0) / vals.length) : null;
      means.push(mu); sds.push(sd);
    }

    var c      = groupColor(gi, grpNames.length);
    var ca     = groupColor(gi, grpNames.length, 0.18);
    var offset = gi * skGrpTracesJitter;

    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map(function(m, j) { return { x: t[j] + offset, y: m !== null ? m + (sds[j] || 0) : null }; }),
      fill: '+1',
    });
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map(function(m, j) { return { x: t[j] + offset, y: m !== null ? m - (sds[j] || 0) : null }; }),
      fill: false,
    });
    datasets.push({
      label: grp, showLine: true, pointRadius: 0, borderWidth: 2.5,
      borderColor: c, backgroundColor: c,
      data: means.map(function(m, j) { return { x: t[j] + offset, y: m }; }),
      fill: false,
    });
    if (showIndiv) {
      files.forEach(function(fname) {
        var vals = getTrace(fname);
        datasets.push({
          label: '', showLine: true, pointRadius: 0, borderWidth: 0.8,
          borderColor: groupColor(gi, grpNames.length, 0.4), backgroundColor: 'transparent',
          data: vals.map(function(y, j) { return { x: t[j] + offset, y: y }; }),
          fill: false,
        });
      });
    }
  });

  var opts = linearScatterOpts(timeAxisLabel(skData.time_unit), yLabel);
  opts.plugins.legend.labels.filter = function(item) { return item.text !== ''; };
  makeChart('sk-group-traces-chart', { type: 'scatter', data: { datasets: datasets }, options: opts });
}

// ── group derived chart ───────────────────────────────────────────────────
function renderGroupDerivedChart(metric) {
  if (!skData || !skData.has_params) return;
  metric = metric || 'npq';
  var result    = calcGroupDerivedStats(metric);
  var stats     = result.stats;
  var t         = result.t;
  var grpNames  = Object.keys(stats);
  var datasets  = [];

  grpNames.forEach(function(grp, gi) {
    var means = stats[grp].means;
    var sds   = stats[grp].sds;
    var c  = groupColor(gi, grpNames.length);
    var ca = groupColor(gi, grpNames.length, 0.18);

    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map(function(m, j) { return { x: t[j], y: m !== null ? m + (sds[j] || 0) : null }; }),
      fill: '+1',
    });
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map(function(m, j) { return { x: t[j], y: m !== null ? m - (sds[j] || 0) : null }; }),
      fill: false,
    });
    datasets.push({
      label: grp, showLine: true, pointRadius: 3, borderWidth: 2.5,
      borderColor: c, backgroundColor: c,
      data: means.map(function(m, j) { return { x: t[j], y: m }; }),
      fill: false,
    });
  });

  var opts = linearScatterOpts(timeAxisLabel(skData.time_unit), SK_DERIVED_YLABELS[metric] || metric);
  opts.plugins.legend.labels.filter = function(item) { return item.text !== ''; };
  makeChart('sk-group-derived-chart', { type: 'scatter', data: { datasets: datasets }, options: opts });
}

// ── group scalar params chart (error bars) ────────────────────────────────
function renderGroupParamsChart() {
  if (!skData || !skData.has_summary) return;
  var stats    = calcGroupSummaryStats();
  var grpNames = Object.keys(stats);
  var keys     = SK_SUMMARY_KEYS.filter(function(k) {
    return grpNames.some(function(g) { return stats[g].params[k]; });
  });
  var labels = keys.map(function(k) { return SK_SUMMARY_LABELS[k] || k; });

  var datasets = grpNames.map(function(grp, gi) {
    return {
      label: grp,
      data: keys.map(function(k) {
        var s = stats[grp].params[k];
        return s ? { y: s.mean, yMin: s.mean - s.sd, yMax: s.mean + s.sd } : null;
      }),
      backgroundColor: groupColor(gi, grpNames.length, 0.65),
      borderColor:     groupColor(gi, grpNames.length),
      borderWidth: 1,
      errorBarColor:        groupColor(gi, grpNames.length),
      errorBarWhiskerColor: groupColor(gi, grpNames.length),
      errorBarLineWidth: 2,
      errorBarWhiskerSize: 8,
    };
  });

  makeChart('sk-group-params-chart', {
    type: 'barWithErrorBars',
    data: { labels: labels, datasets: datasets },
    options: barOpts(),
  });
}

// ── group state-transition chart ──────────────────────────────────────────

var _ST_METRIC_LABELS = { delta_fm_pct: "\u0394Fm\u2032 (%)", tau: '\u03c4 (s)', half_time: 't\u00bd (s)' };

function calcGroupStStats(metric) {
  var grpFilesMap = _grpFiles();
  var grpNames    = Object.keys(grpFilesMap);
  var phaseLabels = [];
  grpNames.forEach(function(grp) {
    grpFilesMap[grp].forEach(function(fname) {
      var phases = skData.state_transitions && skData.state_transitions[fname] || [];
      phases.forEach(function(ph) {
        if (phaseLabels.indexOf(ph.label) < 0) phaseLabels.push(ph.label);
      });
    });
  });
  var stats = {};
  grpNames.forEach(function(grp) {
    stats[grp] = {};
    phaseLabels.forEach(function(phLabel) {
      var vals = grpFilesMap[grp].map(function(fname) {
        var phases = skData.state_transitions && skData.state_transitions[fname] || [];
        for (var i = 0; i < phases.length; i++) {
          if (phases[i].label === phLabel) {
            var v = phases[i][metric];
            return (v != null && isFinite(v) && phases[i].fit_ok) ? v : null;
          }
        }
        return null;
      }).filter(function(v) { return v != null; });
      if (!vals.length) return;
      var mu = vals.reduce(function(s, v) { return s + v; }, 0) / vals.length;
      var sd = Math.sqrt(vals.reduce(function(s, v) { return s + (v - mu) * (v - mu); }, 0) / vals.length);
      stats[grp][phLabel] = { mean: mu, sd: sd, n: vals.length };
    });
  });
  return { stats: stats, phases: phaseLabels };
}

function renderGroupStChart(metric) {
  if (!skData || !skData.has_state_transitions) return;
  metric = metric || 'delta_fm_pct';
  var result   = calcGroupStStats(metric);
  var stats    = result.stats;
  var phases   = result.phases;
  var grpNames = Object.keys(stats);

  var datasets = grpNames.map(function(grp, gi) {
    return {
      label: grp,
      data: phases.map(function(pl) {
        var s = stats[grp][pl];
        return s ? { y: s.mean, yMin: s.mean - s.sd, yMax: s.mean + s.sd }
                 : { y: NaN, yMin: NaN, yMax: NaN };
      }),
      backgroundColor:      groupColor(gi, grpNames.length, 0.65),
      borderColor:          groupColor(gi, grpNames.length),
      borderWidth:          1,
      errorBarColor:        groupColor(gi, grpNames.length),
      errorBarWhiskerColor: groupColor(gi, grpNames.length),
      errorBarLineWidth:    2,
      errorBarWhiskerSize:  8,
    };
  });

  makeChart('sk-group-st-chart', {
    type: 'barWithErrorBars',
    data: { labels: phases, datasets: datasets },
    options: barOpts(_ST_METRIC_LABELS[metric] || metric),
  });
}

// ── export to statistics page ─────────────────────────────────────────────

var _NPQ_METRICS_SET = ['npq', 'npq_fmmax', 'qp', 'qn'];

var _EXPORT_METRIC_DEFS = {
  ftfm: [
    { key: 'ft',  label: 'Ft' },
    { key: 'fm',  label: "Fm'" },
    { key: 'fv',  label: "Fv'" },
  ],
  derived: [
    { key: 'npq',       label: 'NPQ (Fm)' },
    { key: 'npq_fmmax', label: 'NPQ (Fm,max)' },
    { key: 'qn',        label: 'qN' },
    { key: 'qp',        label: 'qP' },
    { key: 'qy',        label: 'Y(II)' },
    { key: 'etr',       label: 'rETR' },
  ],
};

var _EXPORT_METRIC_NAMES = {
  ft: 'Ft', fm: "Fm'", fv: "Fv'",
  npq: 'NPQ(Fm)', npq_fmmax: 'NPQ(Fm,max)', qn: 'qN', qp: 'qP', qy: 'Y(II)', etr: 'rETR',
};

// Build per-metric rows with expandable time-point checkboxes
function _buildExportCheckGroup(containerId, items) {
  var el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = items.map(function(item) {
    var isNpq = _NPQ_METRICS_SET.indexOf(item.key) >= 0 && skData && skData.param_time_npq;
    var t = isNpq ? skData.param_time_npq : (skData && skData.param_time);
    if (!t || !t.length) return '';
    var n = t.length;
    var tpHtml = t.map(function(tv, idx) {
      var lbl = (skData.param_labels && skData.param_labels[item.key] && skData.param_labels[item.key][idx] != null)
        ? String(skData.param_labels[item.key][idx]) : String(tv);
      return '<label class="mr-2 mb-0" style="font-size:0.8em;cursor:pointer;white-space:nowrap">' +
        '<input type="checkbox" class="sk-export-tp-check" data-metric="' + item.key + '" data-idx="' + idx + '" data-steplbl="' + lbl + '" checked> ' +
        lbl + '</label>';
    }).join('');
    return '<div class="mb-2">' +
      '<div class="d-flex align-items-center">' +
        '<input type="checkbox" class="sk-export-metric-check mr-1" id="sk-expchk-' + item.key + '" data-metric="' + item.key + '" checked>' +
        '<label class="font-weight-bold mb-0 mr-2" for="sk-expchk-' + item.key + '">' + item.label + '</label>' +
        '<span class="badge badge-primary mr-2" id="sk-tp-count-' + item.key + '">' + n + '/' + n + '</span>' +
        '<a href="#" class="text-muted sk-tp-toggle" data-tptarget="' + item.key + '" style="font-size:0.8em">▴ time points</a>' +
      '</div>' +
      '<div id="sk-exptp-' + item.key + '" class="mt-1 ml-3">' + tpHtml + '</div>' +
    '</div>';
  }).join('');
}

function _buildExportSummaryCheckGroup(assignedFiles) {
  var el  = document.getElementById('sk-export-summary-checks');
  var sec = document.getElementById('sk-export-summary-section');
  if (!el || !skData || !skData.has_summary) { if (sec) sec.style.display = 'none'; return; }
  var availKeys = SK_SUMMARY_KEYS.filter(function(k) {
    return assignedFiles.some(function(f) { return skData.summary[f] && skData.summary[f][k] != null; });
  });
  if (!availKeys.length) { if (sec) sec.style.display = 'none'; return; }
  el.innerHTML = availKeys.map(function(k) {
    return '<div class="form-check form-check-inline mr-3">' +
      '<input class="form-check-input sk-export-summary-check" type="checkbox"' +
      ' id="sk-expchk-' + k + '" data-metric="' + k + '" checked>' +
      '<label class="form-check-label" for="sk-expchk-' + k + '">' + (SK_SUMMARY_LABELS[k] || k) + '</label></div>';
  }).join('');
  if (sec) sec.style.display = '';
}

function _buildExportStCheckGroup(assignedFiles) {
  var el  = document.getElementById('sk-export-st-checks');
  var sec = document.getElementById('sk-export-st-section');
  if (!el || !skData || !skData.has_state_transitions) { if (sec) sec.style.display = 'none'; return; }

  // Collect phase labels from assigned files
  var phaseLabels = [];
  assignedFiles.forEach(function(fname) {
    var phases = skData.state_transitions && skData.state_transitions[fname] || [];
    phases.forEach(function(ph) { if (phaseLabels.indexOf(ph.label) < 0) phaseLabels.push(ph.label); });
  });
  if (!phaseLabels.length) { if (sec) sec.style.display = 'none'; return; }

  var stMetrics = [
    { key: 'delta_fm_pct', label: '\u0394Fm\u2032 (%)' },
    { key: 'tau',          label: '\u03c4 (s)' },
    { key: 'half_time',    label: 't\u00bd (s)' },
  ];
  el.innerHTML = phaseLabels.map(function(phLabel) {
    return '<div class="mb-1"><strong style="font-size:0.88em">' + phLabel + ':</strong> ' +
      stMetrics.map(function(m) {
        var id = 'sk-expchk-st-' + phLabel + '-' + m.key;
        return '<span class="form-check form-check-inline mr-2">' +
          '<input class="form-check-input sk-export-st-check" type="checkbox" id="' + id + '"' +
          ' data-stlabel="' + phLabel + '" data-stmet="' + m.key + '" checked>' +
          '<label class="form-check-label" for="' + id + '">' + m.label + '</label></span>';
      }).join('') + '</div>';
  }).join('');
  if (sec) sec.style.display = '';
}

function _updateTpCountBadge(metric) {
  var tpList = document.getElementById('sk-exptp-' + metric);
  var badge  = document.getElementById('sk-tp-count-' + metric);
  if (!tpList || !badge) return;
  var total   = tpList.querySelectorAll('.sk-export-tp-check').length;
  var checked = tpList.querySelectorAll('.sk-export-tp-check:checked').length;
  badge.textContent = checked + '/' + total;
  badge.className = checked === 0   ? 'badge badge-secondary mr-2' :
                    checked < total ? 'badge badge-warning mr-2' :
                                      'badge badge-primary mr-2';
}

function _updateMetricCheckIndeterminate(metric) {
  var metricCb = document.getElementById('sk-expchk-' + metric);
  var tpList   = document.getElementById('sk-exptp-' + metric);
  if (!metricCb || !tpList) return;
  var total   = tpList.querySelectorAll('.sk-export-tp-check').length;
  var checked = tpList.querySelectorAll('.sk-export-tp-check:checked').length;
  metricCb.checked       = checked > 0;
  metricCb.indeterminate = checked > 0 && checked < total;
}

function _updateExportColCount() {
  var total = 2; // Group + Sample
  document.querySelectorAll('#sk-export-modal .sk-export-tp-check:checked').forEach(function() { total++; });
  document.querySelectorAll('#sk-export-modal .sk-export-summary-check:checked').forEach(function() { total++; });
  document.querySelectorAll('#sk-export-modal .sk-export-st-check:checked').forEach(function() { total++; });
  var over  = total > 100;
  var msgEl = document.getElementById('sk-export-col-msg');
  var btnEl = document.getElementById('sk-export-confirm-btn');
  if (msgEl) {
    msgEl.textContent = 'Total columns: ' + total + (over ? ' — exceeds 100. Please uncheck some.' : '');
    msgEl.style.color = over ? '#c0392b' : '#155724';
  }
  if (btnEl) btnEl.disabled = over || total <= 2;
}

// Wire modal events once (called from DOMContentLoaded)
function _initExportModalEvents() {
  var modal = document.getElementById('sk-export-modal');
  if (!modal) return;

  // Change delegation: metric toggles time points; time point updates badge + indeterminate; ST updates count
  modal.addEventListener('change', function(e) {
    var cb = e.target;
    if (cb.classList.contains('sk-export-st-check')) {
      _updateExportColCount(); return;
    }
    if (cb.classList.contains('sk-export-metric-check')) {
      var metric = cb.dataset.metric;
      var tpList = document.getElementById('sk-exptp-' + metric);
      if (tpList) {
        tpList.querySelectorAll('.sk-export-tp-check').forEach(function(tp) { tp.checked = cb.checked; });
        cb.indeterminate = false;
      }
      _updateTpCountBadge(metric);
    } else if (cb.classList.contains('sk-export-tp-check')) {
      _updateTpCountBadge(cb.dataset.metric);
      _updateMetricCheckIndeterminate(cb.dataset.metric);
    }
    _updateExportColCount();
  });

  // Click delegation: expand/collapse time point rows
  modal.addEventListener('click', function(e) {
    var a = e.target.closest('.sk-tp-toggle');
    if (!a) return;
    e.preventDefault();
    var tpDiv = document.getElementById('sk-exptp-' + a.dataset.tptarget);
    if (!tpDiv) return;
    var showing = tpDiv.style.display !== 'none';
    tpDiv.style.display = showing ? 'none' : '';
    a.textContent = showing ? '▾ time points' : '▴ time points';
  });

  // Select all / none
  var selAll  = document.getElementById('sk-export-sel-all');
  var selNone = document.getElementById('sk-export-sel-none');
  if (selAll) selAll.addEventListener('click', function() {
    modal.querySelectorAll('.sk-export-tp-check, .sk-export-summary-check, .sk-export-st-check').forEach(function(cb) { cb.checked = true; });
    modal.querySelectorAll('.sk-export-metric-check').forEach(function(cb) {
      cb.checked = true; cb.indeterminate = false; _updateTpCountBadge(cb.dataset.metric);
    });
    _updateExportColCount();
  });
  if (selNone) selNone.addEventListener('click', function() {
    modal.querySelectorAll('.sk-export-tp-check, .sk-export-summary-check, .sk-export-st-check').forEach(function(cb) { cb.checked = false; });
    modal.querySelectorAll('.sk-export-metric-check').forEach(function(cb) {
      cb.checked = false; cb.indeterminate = false; _updateTpCountBadge(cb.dataset.metric);
    });
    _updateExportColCount();
  });

  // Confirm button
  var confirmBtn = document.getElementById('sk-export-confirm-btn');
  if (confirmBtn) confirmBtn.addEventListener('click', _confirmExportToStatistics);
}

function exportToStatistics() {
  if (!skData) return;
  if (!skData.has_params) { alert('No parameters available for export (raw data mode).'); return; }
  var assignedFiles = skData.files.filter(function(f) { return groups[f]; });
  if (!assignedFiles.length) { alert('No files assigned to groups.'); return; }

  _buildExportCheckGroup('sk-export-ftfm-checks',    _EXPORT_METRIC_DEFS.ftfm);
  _buildExportCheckGroup('sk-export-derived-checks', _EXPORT_METRIC_DEFS.derived);
  _buildExportSummaryCheckGroup(assignedFiles);
  _buildExportStCheckGroup(assignedFiles);

  _updateExportColCount();
  $('#sk-export-modal').modal('show');
}

function _confirmExportToStatistics() {
  if (!skData) return;
  var assignedFiles = skData.files.filter(function(f) { return groups[f]; });

  function ptLabel(metric, idx) {
    if (skData.param_labels && skData.param_labels[metric] && skData.param_labels[metric][idx] != null) {
      return String(skData.param_labels[metric][idx]);
    }
    var isNpq = _NPQ_METRICS_SET.indexOf(metric) >= 0 && skData.param_time_npq;
    var t = isNpq ? skData.param_time_npq : skData.param_time;
    return t && t[idx] != null ? String(t[idx]) : String(idx);
  }

  var cols = [];

  ['ft', 'fm', 'fv', 'npq', 'npq_fmmax', 'qn', 'qp', 'qy', 'etr'].forEach(function(metric) {
    var isNpq = _NPQ_METRICS_SET.indexOf(metric) >= 0 && skData.param_time_npq;
    var t = isNpq ? skData.param_time_npq : skData.param_time;
    if (!t || !t.length) return;
    t.forEach(function(_, idx) {
      var tpCb = document.querySelector('.sk-export-tp-check[data-metric="' + metric + '"][data-idx="' + idx + '"]');
      if (!tpCb || !tpCb.checked) return;
      cols.push({
        header: (_EXPORT_METRIC_NAMES[metric] || metric) + '_' + ptLabel(metric, idx),
        get: (function(m, i) {
          return function(fname) {
            var arr = skData.params[fname] && skData.params[fname][m];
            var v   = arr && arr[i];
            return (v != null && isFinite(v)) ? Number(v).toFixed(6) : '';
          };
        }(metric, idx)),
      });
    });
  });

  if (skData.has_summary) {
    SK_SUMMARY_KEYS.forEach(function(k) {
      var cb = document.querySelector('.sk-export-summary-check[data-metric="' + k + '"]');
      if (!cb || !cb.checked) return;
      cols.push({
        header: SK_SUMMARY_LABELS[k] || k,
        get: (function(key) {
          return function(fname) {
            var v = skData.summary[fname] && skData.summary[fname][key];
            return (v != null && isFinite(v)) ? Number(v).toFixed(6) : '';
          };
        }(k)),
      });
    });
  }

  // State transition scalars (checkbox-gated)
  document.querySelectorAll('#sk-export-modal .sk-export-st-check:checked').forEach(function(cb) {
    var phLabel = cb.dataset.stlabel;
    var mKey    = cb.dataset.stmet;
    var stHdr   = { delta_fm_pct: 'dFm%', tau: 'tau_s', half_time: 'thalf_s' };
    cols.push({
      header: 'ST_' + phLabel + '_' + (stHdr[mKey] || mKey),
      get: (function(pl, mk) {
        return function(fname) {
          var phases = skData.state_transitions && skData.state_transitions[fname] || [];
          for (var i = 0; i < phases.length; i++) {
            if (phases[i].label === pl) {
              var v = phases[i][mk];
              return (v != null && isFinite(v)) ? Number(v).toFixed(4) : '';
            }
          }
          return '';
        };
      }(phLabel, mKey)),
    });
  });

  if (!cols.length) { alert('No parameters selected.'); return; }

  var header = ['Group', 'Sample'].concat(cols.map(function(c) { return c.header; })).join('\t');
  var rows   = assignedFiles.map(function(fname) {
    return [groups[fname], fname].concat(cols.map(function(c) { return c.get(fname); })).join('\t');
  });

  sessionStorage.setItem('ojip_export', JSON.stringify({
    tsv:    [header].concat(rows).join('\n'),
    source: 'Slow Kinetics',
  }));
  $('#sk-export-modal').modal('hide');
  window.open('/statistics', '_blank');
}

// ── download xlsx ─────────────────────────────────────────────────────────
async function downloadXlsx(asZip) {
  var statusEl = document.getElementById('sk-download-status');
  var xlsxLink = document.getElementById('sk-xlsx-download-link');
  if (statusEl) statusEl.textContent = 'Preparing download…';
  if (xlsxLink) xlsxLink.style.pointerEvents = 'none';

  try {
    var xlsxName = (skData.file_stem || 'slow_kin') + '_results.xlsx';

    // Pre-render hidden tabs so all charts exist before capture
    if (skData.has_params) {
      _withPaneVisible('sk-tab-ftfm',    function() { renderFtFmChart('ft'); });
      _withPaneVisible('sk-tab-derived', function() { renderDerivedChart('npq'); });
      _withPaneVisible('sk-tab-params',  function() { renderParamsChart(); });
    }
    if (skData.has_state_transitions) {
      _withPaneVisible('sk-tab-st', function() { renderStTab(); });
    }

    // Capture all chart canvases
    var skCaptures = [
      { id: 'sk-traces-chart',       title: 'Raw Fluorescence' },
      { id: 'sk-ftfm-chart',         title: 'Ft and Fm\u2032' },
      { id: 'sk-derived-chart',      title: 'Derived Parameters' },
      { id: 'sk-params-chart',       title: 'Summary Parameters' },
      { id: 'sk-group-traces-chart', title: 'Group Traces' },
      { id: 'sk-group-derived-chart', title: 'Group Derived Parameters' },
      { id: 'sk-group-params-chart', title: 'Group Summary Parameters' },
      { id: 'sk-st-chart',           title: 'State Transitions' },
      { id: 'sk-group-st-chart',     title: 'Group State Transitions' },
    ];
    var charts = [];
    skCaptures.forEach(function(c) {
      var du = _captureSkCanvas(c.id);
      if (du) charts.push({ title: c.title, data_url: du });
    });

    var resp = await fetch('/api/slow_kin_export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, skData, { charts: charts })),
    });
    if (!resp.ok) {
      var errMsg = 'Export failed';
      try { var e = await resp.json(); errMsg = e.message || errMsg; } catch (_) {}
      if (statusEl) statusEl.textContent = errMsg;
      return;
    }
    const xlsxBytes = new Uint8Array(await resp.arrayBuffer());

    var blob, dlName;
    if (asZip) {
      const zip = new JSZip();
      zip.file(xlsxName, xlsxBytes);
      zip.file('Methods_section.html', _buildMethodsHtml('Slow Kinetics Analyzer', generateSKMethodsText()));
      blob   = await zip.generateAsync({ type: 'blob' });
      dlName = (skData.file_stem || 'slow_kin') + '_analysis.zip';
    } else {
      blob   = new Blob([xlsxBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      dlName = xlsxName;
    }

    const dlA = document.createElement('a');
    dlA.href     = URL.createObjectURL(blob);
    dlA.download = dlName;
    dlA.click();
    setTimeout(function() { URL.revokeObjectURL(dlA.href); }, 1000);
    if (statusEl) statusEl.textContent = '';

  } catch (err) {
    if (statusEl) statusEl.textContent = 'Export error: ' + err.message;
  } finally {
    if (xlsxLink) xlsxLink.style.pointerEvents = '';
  }
}

// ── state transitions ─────────────────────────────────────────────────────

// Convert param_time to seconds (AquaPen times are in µs)
function _stTimeToS(t) {
  if (!skData) return t;
  return skData.time_unit === 'us' ? t / 1e6 : t;
}

function renderStTab() {
  if (!skData || !skData.has_state_transitions) return;
  buildStWindowsPanel();
  renderStChart();
  renderStTable();
}

function renderStChart() {
  if (!skData || !skData.has_state_transitions) return;
  var files = skData.files;
  var n = files.length;
  var st = skData.state_transitions || {};
  var datasets = [];

  // Full Fm' time series as scatter points
  var t_s = (skData.param_time || []).map(_stTimeToS);
  files.forEach(function(fname, i) {
    var c  = sampleColor(i, n);
    var fm = skData.params && skData.params[fname] && skData.params[fname]['fm'] || [];
    datasets.push({
      label: fname,
      data:  fm.map(function(y, j) { return { x: t_s[j], y: y }; }),
      borderColor: c, backgroundColor: c,
      borderWidth: 1.5, pointRadius: 4, showLine: false,
    });

    // Fitted curves (dashed) per phase
    var phases = st[fname] || [];
    phases.forEach(function(ph) {
      if (!ph.fit_ok || !ph.fit_t || !ph.fit_t.length) return;
      datasets.push({
        label: '',
        data: ph.fit_t.map(function(tv, j) { return { x: tv, y: ph.fit_y[j] }; }),
        borderColor: c, backgroundColor: 'transparent',
        borderWidth: 2, pointRadius: 0, showLine: true,
        borderDash: [6, 3],
      });
    });
  });

  var opts = linearScatterOpts('Time (s)', "Fm\u2032 (a.u.)");
  opts.plugins.legend.labels.filter = function(item) { return item.text !== ''; };
  makeChart('sk-st-chart', { type: 'scatter', data: { datasets: datasets }, options: opts });
}

function renderStTable() {
  if (!skData || !skData.has_state_transitions) return;
  var headRow = document.getElementById('sk-st-table-head');
  var body    = document.getElementById('sk-st-table-body');
  if (!headRow || !body) return;

  headRow.innerHTML =
    '<th>Sample</th><th>Phase</th><th>PAR</th><th>n pts</th>' +
    '<th>&#916;Fm&prime; (%)</th><th>&#964; (s)</th><th>t&#189; (s)</th><th>R&#178;</th><th></th>';

  var rows = [];
  var files = skData.files || [];
  var st    = skData.state_transitions || {};

  files.forEach(function(fname) {
    var phases = st[fname] || [];
    phases.forEach(function(ph, pi) {
      var note  = ph.insufficient_data ? '<span class="text-muted">n/a (few pts)</span>'
                : !ph.fit_ok            ? '<span class="text-warning">fit failed</span>'
                : ph.low_confidence     ? '<i class="fa fa-exclamation-triangle text-warning" title="Low confidence (< 6 pts)"></i>'
                : '';
      var parLbl = ph.par != null ? ph.par : '—';
      var r2cls  = ph.r_sq == null ? '' : ph.r_sq >= 0.9 ? 'text-success' : ph.r_sq >= 0.7 ? 'text-warning' : 'text-danger';
      rows.push(
        '<tr>' +
        '<td>' + fname + '</td>' +
        '<td><strong>' + ph.label + '</strong></td>' +
        '<td>' + parLbl + '</td>' +
        '<td>' + ph.n_points + '</td>' +
        '<td>' + fmt(ph.delta_fm_pct, 1) + '</td>' +
        '<td>' + fmt(ph.tau, 1) + '</td>' +
        '<td>' + fmt(ph.half_time, 1) + '</td>' +
        '<td class="' + r2cls + '">' + fmt(ph.r_sq, 3) + '</td>' +
        '<td>' + note + '</td>' +
        '</tr>'
      );
    });
  });
  body.innerHTML = rows.join('');
}

// ── phase window adjustment panel ─────────────────────────────────────────

function buildStWindowsPanel() {
  var el = document.getElementById('sk-st-windows-body');
  if (!el || !skData || !skData.st_phases_meta) return;
  var html = '<div class="row" style="font-size:0.85em;">';
  (skData.st_phases_meta || []).forEach(function(ph, i) {
    var badge = ph.type === 'light'
      ? '<span class="badge badge-warning mr-1">light</span>'
      : '<span class="badge badge-secondary mr-1">dark</span>';
    var parLbl = ph.par != null ? ' PAR ' + ph.par : '';
    html +=
      '<div class="col-12 col-md-6 mb-2">' +
        '<div class="d-flex align-items-center">' +
          badge +
          '<strong class="mr-2">' + ph.label + '</strong>' +
          '<small class="text-muted mr-2">' + parLbl + '</small>' +
        '</div>' +
        '<div class="input-group input-group-sm mt-1">' +
          '<div class="input-group-prepend"><span class="input-group-text">Start (s)</span></div>' +
          '<input type="number" class="form-control sk-st-win-start" data-idx="' + i + '"' +
          ' value="' + fmt(ph.t_start, 2) + '" step="0.1">' +
          '<div class="input-group-prepend"><span class="input-group-text">End (s)</span></div>' +
          '<input type="number" class="form-control sk-st-win-end" data-idx="' + i + '"' +
          ' value="' + fmt(ph.t_end, 2) + '" step="0.1">' +
        '</div>' +
      '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// ── refit ──────────────────────────────────────────────────────────────────

async function refitStateTransitions(useCustomWindows) {
  if (!skData || !skData.has_state_transitions) return;
  var spinner = document.getElementById('sk-st-refit-spinner');
  var status  = document.getElementById('sk-st-refit-status');
  if (spinner) spinner.style.display = '';
  if (status)  status.textContent = '';

  // Param time in seconds (convert if AquaPen)
  var t_s = (skData.param_time || []).map(_stTimeToS);

  // Build phases from current meta (or user-adjusted windows)
  var phaseMeta = (skData.st_phases_meta || []).map(function(ph, i) {
    var tStart = ph.t_start;
    var tEnd   = ph.t_end;
    if (useCustomWindows) {
      var startEl = document.querySelector('.sk-st-win-start[data-idx="' + i + '"]');
      var endEl   = document.querySelector('.sk-st-win-end[data-idx="' + i + '"]');
      if (startEl && endEl) {
        tStart = parseFloat(startEl.value);
        tEnd   = parseFloat(endEl.value);
      }
    }
    return { label: ph.label, type: ph.type, par: ph.par, t_start: tStart, t_end: tEnd };
  });

  // Build files_data per phase
  var files = skData.files || [];
  var phases = phaseMeta.map(function(ph) {
    var files_data = {};
    files.forEach(function(fname) {
      var fm = skData.params && skData.params[fname] && skData.params[fname]['fm'] || [];
      var t_seg = [], fm_seg = [];
      t_s.forEach(function(tv, j) {
        if (tv >= ph.t_start - 1e-9 && tv <= ph.t_end + 1e-9 && fm[j] != null) {
          t_seg.push(tv); fm_seg.push(fm[j]);
        }
      });
      files_data[fname] = { t: t_seg, fm: fm_seg };
    });
    return { label: ph.label, type: ph.type, par: ph.par, files_data: files_data };
  });

  try {
    var resp = await fetch('/api/slow_kin_st_refit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_d1: stIncludeD1, phases: phases }),
    });
    var result = await resp.json();
    if (result.status !== 'success') {
      if (status) status.textContent = 'Error: ' + result.message;
      return;
    }
    skData.state_transitions = result.state_transitions;
    skData.st_phases_meta    = result.st_phases_meta;
    skData.st_include_d1     = stIncludeD1;
    renderStChart();
    renderStTable();
    buildStWindowsPanel();
  } catch (err) {
    if (status) status.textContent = 'Network error: ' + err.message;
  } finally {
    if (spinner) spinner.style.display = 'none';
  }
}

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
function showSKMethodsModal() {
    if (!skData) { alert('Please analyze data first.'); return; }
    var ta = document.getElementById('sk-methods-text-area');
    if (ta) ta.value = generateSKMethodsText();
    $('#sk-methods-modal').modal('show');
}

function copySKMethodsText() {
    var ta = document.getElementById('sk-methods-text-area');
    if (!ta) return;
    ta.select();
    var btn = document.getElementById('sk-methods-copy-btn');
    navigator.clipboard.writeText(ta.value).then(function() {
        if (!btn) return;
        var o = btn.innerHTML;
        btn.innerHTML = '<i class="fa fa-check mr-1"></i> Copied!';
        setTimeout(function() { btn.innerHTML = o; }, 1800);
    }).catch(function() { document.execCommand('copy'); });
}

function generateSKMethodsText() {
    var fluoro = skData.fluorometer || 'PAM fluorometer';
    var proto  = skData.protocol;
    var mode   = skData.mode;

    var protoDesc = {
        NPQ1: 'NPQ\u202fprotocol\u202f1 (duration 144\u202fs: 1 initial dark pulse, 5 actinic light pulses at 12\u202fs intervals, 3 dark recovery pulses at 26\u202fs intervals)',
        NPQ2: 'NPQ\u202fprotocol\u202f2 (duration 590\u202fs: 1 initial dark pulse, 10 actinic light pulses at 20\u202fs intervals, 7 dark recovery pulses at 60\u202fs intervals)',
        NPQ3: 'NPQ\u202fprotocol\u202f3 (duration 260\u202fs: 1 initial dark pulse, 10 actinic light pulses at 21\u202fs intervals, 2 dark recovery pulses at 21\u202fs intervals)'
    };

    var files = skData.files || [];
    var n = files.length;
    var fList = n <= 8 ? files.join(', ') : n + ' files';

    var gnames = Object.values(groups).filter(Boolean)
        .filter(function(v, i, a) { return a.indexOf(v) === i; });

    var lines = [];

    var intro = 'Slow chlorophyll fluorescence kinetics were measured using a ';
    if (fluoro === 'AquaPen' && proto) {
        intro += 'AquaPen/FluorPen fluorometer (Photon Systems Instruments) following ' +
                 (protoDesc[proto] || proto) + '.';
    } else if (mode === 'raw_data') {
        intro += fluoro + ' (raw data file export).';
    } else {
        intro += fluoro + ' (parameter file export).';
    }
    intro += ' Data were analyzed using the Slow Kinetics Analyzer module of CyanoTools ' +
             '(https://tools-py.e-cyanobacterium.org/slow_kin_data_analysis). ' +
             'A total of ' + n + ' measurement' + (n !== 1 ? 's were' : ' was') + ' processed (' + fList + ').';
    lines.push(intro);

    if (skData.has_params) {
        lines.push(
            'The following parameters were derived at each time point: effective quantum yield of PSII ' +
            '(Y(II)\u202f=\u202f(Fm\u2032\u202f\u2212\u202fFt)\u202f/\u202fFm\u2032; also \u03c6PSII), ' +
            'relative electron transport rate (rETR\u202f=\u202fY(II)\u202f\u00d7\u202fPAR), non-photochemical ' +
            'quenching (NPQ\u202f=\u202f(Fm\u202f\u2212\u202fFm\u2032)\u202f/\u202fFm\u2032), and photochemical ' +
            'quenching coefficient (qP\u202f=\u202f(Fm\u2032\u202f\u2212\u202fFt)\u202f/\u202f(Fm\u2032\u202f\u2212\u202fFO\u2032); ' +
            'Baker, 2008; Ruban, 2016). Maximum quantum yield (Fv/Fm\u202f=\u202f(Fm\u202f\u2212\u202fF0)\u202f/\u202fFm) was ' +
            'determined from the initial dark-adapted state.'
        );
    } else {
        lines.push(
            'Raw fluorescence traces were visualized and the fluorescence decrease ratio ' +
            '(Rfd\u202f=\u202f(Fp\u202f\u2212\u202fFs)\u202f/\u202fFs; Lichtenthaler et al., 2005) was derived as a ' +
            'vitality index. Time-resolved fluorescence changes reflect non-photochemical quenching dynamics ' +
            'and photosynthetic induction kinetics.'
        );
    }

    if (skData.has_state_transitions) {
        lines.push(
            'State transitions were quantified by fitting a mono-exponential decay model to the Fm\u2032 ' +
            'time series during the dark recovery phase. The exponential time constant (\u03c4, s), ' +
            'half-time (t\u00bd\u202f=\u202f\u03c4\u202f\u00d7\u202fln\u202f2, s), and relative Fm\u2032 amplitude ' +
            '(\u0394Fm\u2032\u202f%) were used to characterize the kinetics of state-transition-associated ' +
            'fluorescence changes.'
        );
    }

    if (gnames.length >= 2) {
        lines.push(
            'Samples were organized into ' + gnames.length + ' experimental group' +
            (gnames.length !== 1 ? 's' : '') + ' (' + gnames.join(', ') + '). ' +
            'Group means\u202f\u00b1\u202fstandard deviations were calculated for all derived parameters.'
        );
    }

    return lines.join('\n\n');
}
