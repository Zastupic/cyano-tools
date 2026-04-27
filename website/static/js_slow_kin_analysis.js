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

// ── publication export — group fluorescence traces ─────────────────────────
const SK_PUB_DEFAULTS = {
  // shared across all group charts
  sizePreset:      'single',
  exportWidth:     85,
  aspectRatio:     1.5,
  exportDPI:       300,
  fontFamily:      'Arial',
  axisTitleSize:   12,
  tickLabelSize:   11,
  legendSize:      10,
  colorScheme:     'default',
  legendPosition:  'right',
  showGridY:       true,
  showGridX:       false,
  bgColor:         '#ffffff',
  showBorder:      false,
  borderColor:     '#000000',
  borderWidth:     1,
  lineWidthMean:   2.5,
  lineWidthIndiv:  0.8,
  sdBandOpacity:   18,
};

// Per-chart individual defaults (line charts: traces + derived; bar charts: params + st)
const SK_PER_CHART_DEFAULTS = {
  traces:  { yStartZero: false, yHeadroom: 5,  xTitle: '', yTitle: '' },
  derived: { yStartZero: false, yHeadroom: 5  },
  params:  { yStartZero: true,  yHeadroom: 15 },
  st:      { yStartZero: false, yHeadroom: 15 },
};

function _makeSkPub() {
  var pub = Object.assign({}, SK_PUB_DEFAULTS);
  pub.perChart = {
    traces:  Object.assign({}, SK_PER_CHART_DEFAULTS.traces),
    derived: Object.assign({}, SK_PER_CHART_DEFAULTS.derived),
    params:  Object.assign({}, SK_PER_CHART_DEFAULTS.params),
    st:      Object.assign({}, SK_PER_CHART_DEFAULTS.st),
  };
  return pub;
}
var skPub = _makeSkPub();

const SK_PUB_PALETTES = {
  colorblind: ['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000'],
  grayscale:  ['#111111','#444444','#777777','#aaaaaa','#cccccc'],
  paired:     ['#1f77b4','#aec7e8','#ff7f0e','#ffbb78','#2ca02c','#98df8a','#d62728','#ff9896'],
};

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

// Keys shown as individual split charts in the Groups tab
const SK_DERIVED_GROUP_KEYS = ['npq', 'qy', 'qp', 'etr'];
const SK_ST_GROUP_KEYS      = ['delta_abs', 'delta_pct', 'tau', 'half_time'];

function _skKeyToId(key) { return key.replace(/_/g, '-'); }

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
function _skPubColor(gi, n, alpha) {
  var palette = SK_PUB_PALETTES[skPub.colorScheme];
  if (!palette) return groupColor(gi, n, alpha);
  var hex = palette[gi % palette.length];
  if (alpha === undefined) return hex;
  var r = parseInt(hex.slice(1,3), 16);
  var g = parseInt(hex.slice(3,5), 16);
  var b = parseInt(hex.slice(5,7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
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

// Render each variant of a segmented chart in sequence and capture all.
// variants: [{key, title, renderFn}]  renderFn(key) draws onto canvasId.
function _captureVariants(paneId, canvasId, variants) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return [];
  var pane = canvas.closest('.tab-pane') || document.getElementById(paneId);
  var wasHidden = pane && getComputedStyle(pane).display === 'none';
  if (wasHidden) { pane.style.display = 'block'; pane.style.visibility = 'hidden'; void pane.offsetWidth; }
  var results = [];
  variants.forEach(function(v) {
    v.renderFn(v.key);
    if (chartInst[canvasId]) chartInst[canvasId].resize();
    var du = _skChartToDataUrl(canvas);
    if (du && du.includes(',') && du.split(',')[1]) {
      results.push({ title: v.title, data_url: du });
    }
  });
  if (wasHidden) { pane.style.display = ''; pane.style.visibility = ''; }
  return results;
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

// ── publication style helpers ─────────────────────────────────────────────
// White/custom background fill plugin
function _skPubBgPlugin() {
  return {
    id: 'skPubBg',
    beforeDraw: function(chart) {
      var ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = skPub.bgColor || '#ffffff';
      ctx.fillRect(0, 0, chart.width, chart.height);
      ctx.restore();
    },
  };
}

// Border drawn around the chart area (inside axes)
function _skPubBorderPlugin() {
  return {
    id: 'skPubBorder',
    afterDraw: function(chart) {
      if (!skPub.showBorder) return;
      var ca = chart.chartArea;
      var ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = skPub.borderColor || '#000000';
      ctx.lineWidth   = skPub.borderWidth  || 1;
      ctx.strokeRect(ca.left, ca.top, ca.right - ca.left, ca.bottom - ca.top);
      ctx.restore();
    },
  };
}

// Apply skPub typography, grid, legend to any Chart.js opts.
// isBar=true: skip per-axis grid toggles.
// pc: per-chart opts (yStartZero, yHeadroom, xTitle, yTitle) — optional, applied when provided.
function _applyPubToOpts(opts, isBar, pc) {
  var s = skPub, fam = s.fontFamily;
  var sc = opts.scales || {};
  if (sc.x) {
    if (!sc.x.title) sc.x.title = { display: true };
    sc.x.title.font = { family: fam, size: s.axisTitleSize, weight: 'bold' };
    if (!sc.x.ticks) sc.x.ticks = {};
    sc.x.ticks.font = { family: fam, size: s.tickLabelSize };
    if (!isBar) sc.x.grid = { display: s.showGridX };
    if (pc && pc.xTitle) sc.x.title.text = pc.xTitle;
  }
  if (sc.y) {
    if (!sc.y.title) sc.y.title = { display: true };
    sc.y.title.font = { family: fam, size: s.axisTitleSize, weight: 'bold' };
    if (!sc.y.ticks) sc.y.ticks = {};
    sc.y.ticks.font = { family: fam, size: s.tickLabelSize };
    if (!isBar) sc.y.grid = { display: s.showGridY };
    if (pc && pc.yTitle) sc.y.title.text = pc.yTitle;
    if (pc && pc.yStartZero) sc.y.min = 0;
  }
  if (opts.plugins && opts.plugins.legend) {
    opts.plugins.legend.position = s.legendPosition;
    if (!opts.plugins.legend.labels) opts.plugins.legend.labels = {};
    opts.plugins.legend.labels.font = { family: fam, size: s.legendSize };
  }
  return opts;
}

// Resize all 4 group chart containers to match skPub.aspectRatio and width preset.
// Uses mm → screen px (96 dpi) for max-width; reading offsetWidth after setting
// max-width forces a synchronous reflow so height is computed from actual display width.
function _applyPubAspectRatio() {
  var ratio = skPub.aspectRatio || 1.5;
  var presetWidths = { single: 85, half: 120, double: 175 };
  var widthMm = skPub.sizePreset !== 'custom'
    ? (presetWidths[skPub.sizePreset] || 85)
    : (skPub.exportWidth || 85);
  var maxWPx = Math.round(widthMm * 96 / 25.4);  // 96 dpi screen
  document.querySelectorAll('.sk-pub-ch').forEach(function(cont) {
    cont.style.maxWidth = maxWPx + 'px';
    var w = cont.offsetWidth;  // force reflow → returns actual constrained width
    if (w > 0) cont.style.height = Math.round(w / ratio) + 'px';
    var cid = cont.dataset.cid;
    var ch = cid && chartInst && chartInst[cid];
    if (ch) ch.resize();
  });
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
  if (tabId === 'sk-tab-params')  { renderParamsCharts(); renderParamsTable(); return; }
  if (tabId === 'sk-tab-st')      { renderStTab(); return; }
  if (tabId === 'sk-tab-groups')  {
    refreshGroupSummary();
    if (hasGroups()) {
      var gr = document.getElementById('sk-group-results');
      if (gr) { gr.style.display = ''; void gr.offsetWidth; }
      renderGroupTracesChart();
      if (skData.has_params) renderGroupDerivedCharts();
      if (skData.has_summary) renderGroupParamsCharts();
      if (skData.has_state_transitions) renderGroupStCharts();
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

  // Scalar params segmented control
  var paramsBtns = document.getElementById('sk-params-btns');
  if (paramsBtns) {
    paramsBtns.addEventListener('click', function(e) {
      var btn = e.target.closest('[data-params]'); if (!btn) return;
      setActiveBtn('sk-params-btns', btn);
      renderParamChart(btn.dataset.params);
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

  // Publication figure settings UI
  initSkPubSettingsUI();

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
        'sk-tab-groups':  ['sk-group-traces-chart'].concat(
          SK_DERIVED_GROUP_KEYS.map(function(m){ return 'sk-group-derived-'+_skKeyToId(m)+'-chart'; }),
          SK_SUMMARY_KEYS.map(function(k){ return 'sk-group-params-'+_skKeyToId(k)+'-chart'; }),
          SK_ST_GROUP_KEYS.map(function(m){ return 'sk-group-st-'+_skKeyToId(m)+'-chart'; })
        ),
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

  // Wire download button
  var xlsxLink = document.getElementById('sk-xlsx-download-link');
  if (xlsxLink) {
    xlsxLink.style.display = '';
    xlsxLink.href = '#';
    xlsxLink.onclick = function(e) { e.preventDefault(); downloadXlsx(); };
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
    _withPaneVisible('sk-tab-params',  function() { renderParamsCharts(); renderParamsTable(); });
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

// ── parameters (summary scalars) chart — single canvas, switched by seg-ctrl
function renderParamsCharts() {
  // Render whichever key is currently active in the segmented control
  var btn = document.querySelector('#sk-params-btns .btn-primary');
  var key = (btn && btn.dataset && btn.dataset.params) || SK_SUMMARY_KEYS[0];
  renderParamChart(key);
}

function renderParamChart(key) {
  if (!skData || !skData.has_summary) return;
  key = key || SK_SUMMARY_KEYS[0];
  var files = skData.files;
  var n     = files.length;
  var label = SK_SUMMARY_LABELS[key] || key;

  var datasets = files.map(function(fname, i) {
    var v = skData.summary[fname] && skData.summary[fname][key];
    return {
      label:           fname,
      data:            [(v != null && isFinite(v)) ? v : null],
      backgroundColor: sampleColor(i, n, 0.7),
      borderColor:     sampleColor(i, n),
      borderWidth:     1,
    };
  });

  makeChart('sk-params-chart', { type: 'bar', data: { labels: [label], datasets: datasets }, options: barOpts(label) });
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
    _applyPubAspectRatio();
    var _activeEl  = document.querySelector('#skTabs .nav-link.active');
    var activeHref = _activeEl ? _activeEl.getAttribute('href') : '';
    if (activeHref === '#sk-tab-groups') {
      renderGroupTracesChart();
      if (skData && skData.has_params) renderGroupDerivedCharts();
      if (skData && skData.has_summary) renderGroupParamsCharts();
      if (skData && skData.has_state_transitions) renderGroupStCharts();
    } else {
      // Pre-render while tab pane is temporarily visible so canvases have correct dimensions
      _withPaneVisible('sk-tab-groups', function() {
        var innerGr = document.getElementById('sk-group-results');
        if (innerGr) { innerGr.style.display = ''; void innerGr.offsetWidth; }
        renderGroupTracesChart();
        if (skData && skData.has_params) renderGroupDerivedCharts();
        if (skData && skData.has_summary) renderGroupParamsCharts();
        if (skData && skData.has_state_transitions) renderGroupStCharts();
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
  var cfg = _buildGrpTracesChartConfig();
  if (cfg) makeChart('sk-group-traces-chart', cfg);
}

// Shared config builder — used by screen render (no args) and export (ptToPx = DPI/72)
function _buildGrpTracesChartConfig(exportPtToPx) {
  if (!skData) return null;
  var s        = skPub;
  var pc       = s.perChart.traces;
  var forExport = exportPtToPx !== undefined;
  var t        = skData.raw_time;
  var norm     = skGrpTracesNorm === 'normalized';
  var normTime = skGrpTracesNormTime;
  var showIndiv = (document.getElementById('sk-show-individual-check') || {}).checked !== false;
  var yLabel   = (pc.yTitle || (norm ? 'F / F(ref)' : 'Fluorescence (a.u.)'));
  var xLabel   = (pc.xTitle || timeAxisLabel(skData.time_unit));
  var sdAlpha  = skPub.sdBandOpacity / 100;
  var datasets = [];

  function getTrace(fname) {
    var raw = skData.raw_traces[fname] || [];
    return norm ? normalizeTraceArr(raw, t, normTime) : raw;
  }

  var grpFilesMap = _grpFiles();
  var grpNames    = Object.keys(grpFilesMap);

  grpNames.forEach(function(grp, gi) {
    var files = grpFilesMap[grp];
    var arrs  = files.map(getTrace);
    var n_pts = t.length;
    var means = [], sds = [];
    for (var j = 0; j < n_pts; j++) {
      var vals = arrs.map(function(a) { return a[j]; }).filter(function(v) { return v != null && isFinite(v); });
      var mu   = vals.length ? vals.reduce(function(sum, v) { return sum + v; }, 0) / vals.length : null;
      var sd   = mu !== null ? Math.sqrt(vals.reduce(function(sum, v) { return sum + (v - mu) * (v - mu); }, 0) / vals.length) : null;
      means.push(mu); sds.push(sd);
    }
    var c      = _skPubColor(gi, grpNames.length);
    var ca     = _skPubColor(gi, grpNames.length, sdAlpha);
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
      label: grp, showLine: true, pointRadius: 0, borderWidth: skPub.lineWidthMean,
      borderColor: c, backgroundColor: c,
      data: means.map(function(m, j) { return { x: t[j] + offset, y: m }; }),
      fill: false,
    });
    if (showIndiv) {
      files.forEach(function(fname) {
        var vals = getTrace(fname);
        datasets.push({
          label: '', showLine: true, pointRadius: 0, borderWidth: skPub.lineWidthIndiv,
          borderColor: _skPubColor(gi, grpNames.length, 0.4), backgroundColor: 'transparent',
          data: vals.map(function(y, j) { return { x: t[j] + offset, y: y }; }),
          fill: false,
        });
      });
    }
  });

  // Compute Y max across all datasets for headroom
  var allY = [];
  datasets.forEach(function(ds) {
    ds.data.forEach(function(pt) {
      if (pt && pt.y != null && isFinite(pt.y)) allY.push(pt.y);
    });
  });
  var dataYMax = allY.length ? Math.max.apply(null, allY) : null;

  // Font size helper: returns scaled px for export, pt value for screen preview
  function fs(pt) { return forExport ? Math.round(pt * exportPtToPx) : pt; }
  var fam = s.fontFamily;
  var legendPos = s.legendPosition;

  var opts = {
    animation: false, parsing: false,
    responsive: !forExport, maintainAspectRatio: false,
    scales: {
      x: {
        type: 'linear',
        title: {
          display: true, text: xLabel,
          font: { family: fam, size: fs(s.axisTitleSize), weight: 'bold' },
        },
        ticks: { font: { family: fam, size: fs(s.tickLabelSize) } },
        grid: { display: s.showGridX },
      },
      y: {
        title: {
          display: true, text: yLabel,
          font: { family: fam, size: fs(s.axisTitleSize), weight: 'bold' },
        },
        ticks: { font: { family: fam, size: fs(s.tickLabelSize) } },
        grid: { display: s.showGridY },
        min: pc.yStartZero ? 0 : undefined,
        max: dataYMax !== null ? dataYMax * (1 + pc.yHeadroom / 100) : undefined,
      },
    },
    plugins: {
      legend: {
        display: legendPos !== 'hidden',
        position: legendPos !== 'hidden' ? legendPos : 'right',
        labels: {
          font: { family: fam, size: fs(s.legendSize) },
          filter: function(item) { return item.text !== ''; },
          boxWidth: 20, boxHeight: 4, padding: 6,
        },
      },
      tooltip: { mode: 'nearest', intersect: false },
    },
    elements: { line: { tension: 0 } },
  };

  return { type: 'scatter', data: { datasets: datasets }, options: opts, plugins: [_skPubBgPlugin(), _skPubBorderPlugin()] };
}

// ── PNG DPI metadata injection ────────────────────────────────────────────
var _skCrc32TableCache = null;
function _skCrc32Table() {
  if (_skCrc32TableCache) return _skCrc32TableCache;
  var t = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var c = i;
    for (var j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return (_skCrc32TableCache = t);
}
function _skCrc32(data) {
  var tbl = _skCrc32Table(), crc = 0xFFFFFFFF;
  for (var i = 0; i < data.length; i++) crc = (crc >>> 8) ^ tbl[(crc ^ data[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function _injectSkPngDpi(b64, dpi) {
  try {
    var raw = atob(b64), src = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) src[i] = raw.charCodeAt(i);
    var ppm = Math.round(dpi / 0.0254);
    // Build pHYs chunk: 4-byte length + 4-byte type + 9-byte data + 4-byte CRC
    var phys = new Uint8Array(21);
    phys[0]=0; phys[1]=0; phys[2]=0; phys[3]=9;                           // length = 9
    phys[4]=112; phys[5]=72; phys[6]=89; phys[7]=115;                     // 'pHYs'
    phys[8]=(ppm>>24)&0xff; phys[9]=(ppm>>16)&0xff;                       // X ppm
    phys[10]=(ppm>>8)&0xff; phys[11]=ppm&0xff;
    phys[12]=(ppm>>24)&0xff; phys[13]=(ppm>>16)&0xff;                     // Y ppm
    phys[14]=(ppm>>8)&0xff; phys[15]=ppm&0xff;
    phys[16]=1;                                                             // unit: meter
    var crcBuf = new Uint8Array(13);
    for (var k = 0; k < 13; k++) crcBuf[k] = phys[4 + k];
    var crc = _skCrc32(crcBuf);
    phys[17]=(crc>>24)&0xff; phys[18]=(crc>>16)&0xff;
    phys[19]=(crc>>8)&0xff;  phys[20]=crc&0xff;
    // Insert after IHDR (offset 33 = 8-byte sig + 4+4+13+4 IHDR chunk)
    var out = new Uint8Array(src.length + 21);
    out.set(src.slice(0, 33)); out.set(phys, 33); out.set(src.slice(33), 54);
    var bin = '';
    for (var m = 0; m < out.length; m++) bin += String.fromCharCode(out[m]);
    return btoa(bin);
  } catch(e) { return b64; }
}

// ── publication PNG export ─────────────────────────────────────────────────
async function exportGroupTracesPubPng() {
  if (!skData || !hasGroups()) { alert('Assign files to at least 2 groups first.'); return; }
  var btn     = document.getElementById('sk-pub-export-btn');
  var spinner = document.getElementById('sk-pub-export-spinner');
  var status  = document.getElementById('sk-pub-export-status');
  if (btn) btn.disabled = true;
  if (spinner) spinner.style.display = '';
  if (status) status.textContent = 'Rendering…';
  try {
    var s = skPub;
    var presetWidths = { single: 85, half: 120, double: 175 };
    var widthMm  = s.sizePreset !== 'custom' ? (presetWidths[s.sizePreset] || 85) : (s.exportWidth || 85);
    var widthPx  = Math.round((widthMm / 25.4) * s.exportDPI);
    var heightPx = Math.round(widthPx / Math.max(s.aspectRatio, 0.2));
    var ptToPx   = s.exportDPI / 72;

    var canvas = document.createElement('canvas');
    canvas.width = widthPx; canvas.height = heightPx;
    canvas.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;';
    document.body.appendChild(canvas);

    var cfg = _buildGrpTracesChartConfig(ptToPx);
    var tmpChart = new Chart(canvas, cfg);

    // Two rAF cycles so the canvas is composited before capture
    await new Promise(function(res) { requestAnimationFrame(function() { requestAnimationFrame(res); }); });

    var dataUrl = canvas.toDataURL('image/png');
    tmpChart.destroy();
    document.body.removeChild(canvas);

    var b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    b64 = _injectSkPngDpi(b64, s.exportDPI);

    var a = document.createElement('a');
    a.href = 'data:image/png;base64,' + b64;
    a.download = 'group_fluorescence_traces.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);

    var heightMm = Math.round(widthMm / s.aspectRatio);
    if (status) status.textContent = widthMm + '\u202f\u00d7\u202f' + heightMm + '\u202fmm \u2022 ' + s.exportDPI + '\u202fdpi';
  } catch(err) {
    alert('Export error: ' + err.message);
    if (status) status.textContent = '';
  } finally {
    if (btn) btn.disabled = false;
    if (spinner) spinner.style.display = 'none';
  }
}

// ── group derived charts (one per metric) ────────────────────────────────
function renderGroupDerivedCharts() {
  SK_DERIVED_GROUP_KEYS.forEach(function(m) { renderGroupDerivedChart(m); });
}

function renderGroupDerivedChart(metric) {
  if (!skData || !skData.has_params) return;
  metric = metric || 'npq';
  var canvasId = 'sk-group-derived-' + _skKeyToId(metric) + '-chart';
  var result    = calcGroupDerivedStats(metric);
  var stats     = result.stats;
  var t         = result.t;
  var grpNames  = Object.keys(stats);
  var datasets  = [];

  var pc      = skPub.perChart.derived;
  var sdAlpha = skPub.sdBandOpacity / 100;
  grpNames.forEach(function(grp, gi) {
    var means = stats[grp].means;
    var sds   = stats[grp].sds;
    var c  = _skPubColor(gi, grpNames.length);
    var ca = _skPubColor(gi, grpNames.length, sdAlpha);

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
      label: grp, showLine: true, pointRadius: 3, borderWidth: skPub.lineWidthMean,
      borderColor: c, backgroundColor: c,
      data: means.map(function(m, j) { return { x: t[j], y: m }; }),
      fill: false,
    });
  });

  // Y headroom
  var allY2 = []; datasets.forEach(function(ds) { ds.data.forEach(function(pt) { if (pt && pt.y != null && isFinite(pt.y)) allY2.push(pt.y); }); });
  var dYMax2 = allY2.length ? Math.max.apply(null, allY2) : null;

  var opts = linearScatterOpts(pc.xTitle || timeAxisLabel(skData.time_unit), pc.yTitle || SK_DERIVED_YLABELS[metric] || metric);
  opts.plugins.legend.labels.filter = function(item) { return item.text !== ''; };
  if (pc.yStartZero) opts.scales.y.min = 0;
  if (dYMax2 !== null) opts.scales.y.max = dYMax2 * (1 + pc.yHeadroom / 100);
  _applyPubToOpts(opts, false, pc);
  makeChart(canvasId, { type: 'scatter', data: { datasets: datasets }, options: opts, plugins: [_skPubBgPlugin(), _skPubBorderPlugin()] });
}

// ── group scalar params charts (one per parameter) ────────────────────────
function renderGroupParamsCharts() {
  if (!skData || !skData.has_summary) return;
  var stats    = calcGroupSummaryStats();
  var grpNames = Object.keys(stats);
  SK_SUMMARY_KEYS.forEach(function(k) {
    if (grpNames.some(function(g) { return stats[g].params[k]; })) {
      renderGroupParamChart(k, stats, grpNames);
    }
  });
}

function renderGroupParamChart(key, stats, grpNames) {
  if (!skData || !skData.has_summary) return;
  if (!stats)    { stats    = calcGroupSummaryStats(); }
  if (!grpNames) { grpNames = Object.keys(stats); }
  var canvasId = 'sk-group-params-' + _skKeyToId(key) + '-chart';
  var label    = SK_SUMMARY_LABELS[key] || key;

  var datasets = grpNames.map(function(grp, gi) {
    var c  = _skPubColor(gi, grpNames.length);
    var ca = _skPubColor(gi, grpNames.length, 0.65);
    var s  = stats[grp].params[key];
    return {
      label: grp,
      data: [s ? { y: s.mean, yMin: s.mean - s.sd, yMax: s.mean + s.sd } : null],
      backgroundColor: ca,
      borderColor:     c,
      borderWidth: 1,
      errorBarColor:        c,
      errorBarWhiskerColor: c,
      errorBarLineWidth: 2,
      errorBarWhiskerSize: 8,
    };
  });

  var pc   = skPub.perChart.params;
  var opts = barOpts(pc.yTitle || label);
  if (pc.yStartZero) { if (!opts.scales.y) opts.scales.y = {}; opts.scales.y.min = 0; }
  _applyPubToOpts(opts, true, pc);
  makeChart(canvasId, {
    type: 'barWithErrorBars',
    data: { labels: [label], datasets: datasets },
    options: opts,
    plugins: [_skPubBgPlugin(), _skPubBorderPlugin()],
  });
}

// ── group state-transition chart ──────────────────────────────────────────

var _ST_METRIC_LABELS = { delta_abs: "\u0394Fm\u2032 (a.u.)", delta_pct: "\u0394Fm\u2032 (%)", tau: '\u03c4 (s)', half_time: 't\u00bd (s)' };

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

function renderGroupStCharts() {
  SK_ST_GROUP_KEYS.forEach(function(m) { renderGroupStChart(m); });
}

function renderGroupStChart(metric) {
  if (!skData || !skData.has_state_transitions) return;
  metric = metric || 'delta_abs';
  var canvasId = 'sk-group-st-' + _skKeyToId(metric) + '-chart';
  var result   = calcGroupStStats(metric);
  var stats    = result.stats;
  var phases   = result.phases;
  var grpNames = Object.keys(stats);

  var datasets = grpNames.map(function(grp, gi) {
    var c = _skPubColor(gi, grpNames.length);
    var ca = _skPubColor(gi, grpNames.length, 0.65);
    return {
      label: grp,
      data: phases.map(function(pl) {
        var s = stats[grp][pl];
        return s ? { y: s.mean, yMin: s.mean - s.sd, yMax: s.mean + s.sd }
                 : { y: NaN, yMin: NaN, yMax: NaN };
      }),
      backgroundColor:      ca,
      borderColor:          c,
      borderWidth:          1,
      errorBarColor:        c,
      errorBarWhiskerColor: c,
      errorBarLineWidth:    2,
      errorBarWhiskerSize:  8,
    };
  });

  var pc = skPub.perChart.st;
  var opts = barOpts(pc.yTitle || _ST_METRIC_LABELS[metric] || metric);
  if (pc.yStartZero) { if (!opts.scales.y) opts.scales.y = {}; opts.scales.y.min = 0; }
  _applyPubToOpts(opts, true, pc);
  makeChart(canvasId, {
    type: 'barWithErrorBars',
    data: { labels: phases, datasets: datasets },
    options: opts,
    plugins: [_skPubBgPlugin(), _skPubBorderPlugin()],
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
    { key: 'delta_abs', label: '\u0394Fm\u2032 (a.u.)' },
    { key: 'delta_pct', label: '\u0394Fm\u2032 (%)' },
    { key: 'tau',       label: '\u03c4 (s)' },
    { key: 'half_time', label: 't\u00bd (s)' },
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
    var stHdr   = { delta_abs: 'dFm_au', delta_pct: 'dFm_pct', tau: 'tau_s', half_time: 'thalf_s' };
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
async function downloadXlsx() {
  var statusEl = document.getElementById('sk-download-status');
  var xlsxLink = document.getElementById('sk-xlsx-download-link');
  if (statusEl) statusEl.textContent = 'Preparing download…';
  if (xlsxLink) xlsxLink.style.pointerEvents = 'none';

  try {
    var xlsxName = (skData.file_stem || 'slow_kin') + '_results.xlsx';

    // Read which variant is currently active on each segmented chart
    var _activeFtfm    = (document.querySelector('#sk-ftfm-btns .btn-primary')    || {}).dataset;
    var _activeDerived = (document.querySelector('#sk-derived-btns .btn-primary') || {}).dataset;

    // Pre-render single-canvas charts that may be on hidden tabs
    _withPaneVisible('sk-tab-params', function() { if (skData.has_params) renderParamsCharts(); });
    _withPaneVisible('sk-tab-st',     function() { if (skData.has_state_transitions) renderStTab(); });

    var charts = [];

    // Single-canvas charts (no variants)
    var _singleCaptures = [
      { id: 'sk-traces-chart',       title: 'Raw Fluorescence' },
      { id: 'sk-group-traces-chart', title: 'Group Traces' },
      { id: 'sk-st-chart',           title: 'State Transitions' },
    ];
    _singleCaptures.forEach(function(c) {
      var du = _captureSkCanvas(c.id);
      if (du) charts.push({ title: c.title, data_url: du });
    });

    // Ft & Fm — all three variants
    if (skData.has_params) {
      var _ftfmVariants = [
        { key: 'ft',  title: 'Ft',    renderFn: renderFtFmChart },
        { key: 'fm',  title: "Fm\u2032", renderFn: renderFtFmChart },
        { key: 'fv',  title: "Fv\u2032", renderFn: renderFtFmChart },
      ];
      charts = charts.concat(_captureVariants('sk-tab-ftfm', 'sk-ftfm-chart', _ftfmVariants));
      // Restore active variant
      _withPaneVisible('sk-tab-ftfm', function() { renderFtFmChart((_activeFtfm && _activeFtfm.ftfm) || 'ft'); });
    }

    // Derived time series — all six variants
    if (skData.has_params) {
      var _derivedVariants = [
        { key: 'npq',       title: 'NPQ (Fm)',     renderFn: renderDerivedChart },
        { key: 'npq_fmmax', title: 'NPQ (Fm,max)', renderFn: renderDerivedChart },
        { key: 'qn',        title: 'qN',           renderFn: renderDerivedChart },
        { key: 'qp',        title: 'qP',           renderFn: renderDerivedChart },
        { key: 'qy',        title: 'Y(II)',         renderFn: renderDerivedChart },
        { key: 'etr',       title: 'rETR',          renderFn: renderDerivedChart },
      ];
      charts = charts.concat(_captureVariants('sk-tab-derived', 'sk-derived-chart', _derivedVariants));
      _withPaneVisible('sk-tab-derived', function() { renderDerivedChart((_activeDerived && _activeDerived.derived) || 'npq'); });
    }

    // Group derived — one canvas per metric (always rendered)
    if (hasGroups() && skData.has_params) {
      SK_DERIVED_GROUP_KEYS.forEach(function(m) {
        var cid = 'sk-group-derived-' + _skKeyToId(m) + '-chart';
        var du  = _captureSkCanvas(cid);
        if (du) charts.push({ title: 'Group ' + (SK_DERIVED_YLABELS[m] || m), data_url: du });
      });
    }

    // Group params — one canvas per parameter (always rendered)
    if (hasGroups() && skData.has_summary) {
      SK_SUMMARY_KEYS.forEach(function(k) {
        var cid = 'sk-group-params-' + _skKeyToId(k) + '-chart';
        var du  = _captureSkCanvas(cid);
        if (du) charts.push({ title: 'Group ' + (SK_SUMMARY_LABELS[k] || k), data_url: du });
      });
    }

    // Group state transitions — one canvas per metric (always rendered)
    if (hasGroups() && skData.has_state_transitions) {
      SK_ST_GROUP_KEYS.forEach(function(m) {
        var cid = 'sk-group-st-' + _skKeyToId(m) + '-chart';
        var du  = _captureSkCanvas(cid);
        if (du) charts.push({ title: 'Group ' + (_ST_METRIC_LABELS[m] || m), data_url: du });
      });
    }

    // Individual-sample scalar params — render each key to single canvas
    if (skData.has_summary) {
      var _activeParams = (document.querySelector('#sk-params-btns .btn-primary') || {}).dataset;
      var _paramsVariants = SK_SUMMARY_KEYS.map(function(k) {
        return { key: k, title: SK_SUMMARY_LABELS[k] || k, renderFn: renderParamChart };
      });
      charts = charts.concat(_captureVariants('sk-tab-params', 'sk-params-chart', _paramsVariants));
      _withPaneVisible('sk-tab-params', function() { renderParamChart((_activeParams && _activeParams.params) || SK_SUMMARY_KEYS[0]); });
    }

    var resp = await fetch('/api/slow_kin_export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, skData, { charts: charts, methods_text: generateSKMethodsText() })),
    });
    if (!resp.ok) {
      var errMsg = 'Export failed';
      try { var e = await resp.json(); errMsg = e.message || errMsg; } catch (_) {}
      if (statusEl) statusEl.textContent = errMsg;
      return;
    }
    const xlsxBytes = new Uint8Array(await resp.arrayBuffer());
    const blob = new Blob([xlsxBytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const dlA  = document.createElement('a');
    dlA.href     = URL.createObjectURL(blob);
    dlA.download = xlsxName;
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
    '<th>&#916;Fm&prime; (a.u.)</th><th>&#916;Fm&prime; (%)</th><th>&#964; (s)</th><th>t&#189; (s)</th><th>R&#178;</th><th></th>';

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
        '<td>' + fmt(ph.delta_abs, 2) + '</td>' +
        '<td>' + fmt(ph.delta_pct, 1) + '</td>' +
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

// ══════════════════════════════════════════════════════════════════════════
// PUBLICATION FIGURE SETTINGS UI
// ══════════════════════════════════════════════════════════════════════════
function initSkPubSettingsUI() {
  try {
    var saved = localStorage.getItem('sk_grp_traces_pub');
    if (saved) {
      var parsed = JSON.parse(saved);
      skPub = _makeSkPub();
      // restore shared keys
      Object.keys(SK_PUB_DEFAULTS).forEach(function(k) { if (k in parsed) skPub[k] = parsed[k]; });
      // restore per-chart keys
      if (parsed.perChart) {
        ['traces','derived','params','st'].forEach(function(ch) {
          if (parsed.perChart[ch]) Object.assign(skPub.perChart[ch], parsed.perChart[ch]);
        });
      }
    }
  } catch(e) {}

  function g(id) { return document.getElementById(id); }

  // ── read shared settings from DOM ────────────────────────────────────────
  function readSettings() {
    var sizePreset = (g('sk-pub-size-preset') || {}).value || 'single';
    var presetWidths = { single: 85, half: 120, double: 175 };
    skPub.sizePreset   = sizePreset;
    skPub.exportWidth  = sizePreset !== 'custom'
      ? (presetWidths[sizePreset] || 85)
      : (parseFloat((g('sk-pub-export-width') || {}).value) || 85);
    var aspectVal = (g('sk-pub-aspect-preset') || {}).value || '1.50';
    skPub.aspectRatio  = aspectVal === 'custom'
      ? (parseFloat((g('sk-pub-aspect-custom') || {}).value) || 1.5)
      : (parseFloat(aspectVal) || 1.5);
    skPub.exportDPI     = parseInt((g('sk-pub-dpi') || {}).value)             || 300;
    skPub.bgColor       = (g('sk-pub-bg-color') || {}).value                  || '#ffffff';
    skPub.fontFamily    = (g('sk-pub-font-family') || {}).value               || 'Arial';
    skPub.axisTitleSize = parseInt((g('sk-pub-axis-title-size') || {}).value)  || 12;
    skPub.tickLabelSize = parseInt((g('sk-pub-tick-size') || {}).value)        || 11;
    skPub.legendSize    = parseInt((g('sk-pub-legend-size') || {}).value)      || 10;
    skPub.colorScheme   = (g('sk-pub-color-scheme') || {}).value               || 'default';
    skPub.legendPosition= (g('sk-pub-legend-pos') || {}).value                || 'right';
    skPub.showGridY     = !!(g('sk-pub-grid-y') || {}).checked;
    skPub.showGridX     = !!(g('sk-pub-grid-x') || {}).checked;
    skPub.showBorder    = !!(g('sk-pub-show-border') || {}).checked;
    skPub.borderColor   = (g('sk-pub-border-color') || {}).value               || '#000000';
    skPub.borderWidth   = parseFloat((g('sk-pub-border-width') || {}).value)   || 1;
    skPub.lineWidthMean  = parseFloat((g('sk-pub-line-width-mean')  || {}).value) || 2.5;
    skPub.lineWidthIndiv = parseFloat((g('sk-pub-line-width-indiv') || {}).value) || 0.8;
    skPub.sdBandOpacity  = parseInt((g('sk-pub-sd-opacity')         || {}).value) || 18;

    // per-chart settings
    var pcDefs = {
      traces:  ['yStartZero','yHeadroom','xTitle','yTitle'],
      derived: ['yStartZero','yHeadroom'],
      params:  ['yStartZero','yHeadroom'],
      st:      ['yStartZero','yHeadroom'],
    };
    Object.keys(pcDefs).forEach(function(ch) {
      var pc = skPub.perChart[ch];
      var pi = function(id) { return parseInt((g('sk-pc-'+ch+'-'+id) || {}).value); };
      var ps = function(id) { return ((g('sk-pc-'+ch+'-'+id) || {}).value || '').trim(); };
      var pb = function(id) { return !!(g('sk-pc-'+ch+'-'+id) || {}).checked; };
      pc.yStartZero = pb('y-start-zero');
      pc.yHeadroom  = pi('y-headroom') || 5;
      if (pcDefs[ch].indexOf('yTitle') >= 0) pc.yTitle = ps('y-title');
      if (pcDefs[ch].indexOf('xTitle') >= 0) pc.xTitle = ps('x-title');
    });

    try { localStorage.setItem('sk_grp_traces_pub', JSON.stringify(skPub)); } catch(e) {}
  }

  // ── sync DOM from skPub ───────────────────────────────────────────────────
  var RATIO_PRESETS = ['0.75', '1.00', '1.33', '1.50', '1.78'];
  function syncUI() {
    function setVal(id, v) { var el = g(id); if (el) el.value = v; }
    function setChk(id, v) { var el = g(id); if (el) el.checked = v; }
    setVal('sk-pub-size-preset',    skPub.sizePreset);
    setVal('sk-pub-export-width',   skPub.exportWidth);
    var ratioStr = skPub.aspectRatio.toFixed(2);
    var isPreset = RATIO_PRESETS.indexOf(ratioStr) >= 0;
    setVal('sk-pub-aspect-preset',  isPreset ? ratioStr : 'custom');
    setVal('sk-pub-aspect-custom',  ratioStr);
    setVal('sk-pub-dpi',            skPub.exportDPI);
    setVal('sk-pub-bg-color',       skPub.bgColor);
    setVal('sk-pub-font-family',    skPub.fontFamily);
    setVal('sk-pub-axis-title-size',skPub.axisTitleSize);
    setVal('sk-pub-tick-size',      skPub.tickLabelSize);
    setVal('sk-pub-legend-size',    skPub.legendSize);
    setVal('sk-pub-color-scheme',   skPub.colorScheme);
    setVal('sk-pub-legend-pos',     skPub.legendPosition);
    setChk('sk-pub-grid-y',         skPub.showGridY);
    setChk('sk-pub-grid-x',         skPub.showGridX);
    setChk('sk-pub-show-border',    skPub.showBorder);
    setVal('sk-pub-border-color',   skPub.borderColor);
    setVal('sk-pub-border-width',   skPub.borderWidth);
    setVal('sk-pub-line-width-mean',  skPub.lineWidthMean);
    setVal('sk-pub-line-width-indiv', skPub.lineWidthIndiv);
    setVal('sk-pub-sd-opacity',       skPub.sdBandOpacity);
    var lwmEl = g('sk-pub-line-width-mean-val');  if (lwmEl) lwmEl.textContent = skPub.lineWidthMean + ' px';
    var lwiEl = g('sk-pub-line-width-indiv-val'); if (lwiEl) lwiEl.textContent = skPub.lineWidthIndiv + ' px';
    var sdoEl = g('sk-pub-sd-opacity-val');       if (sdoEl) sdoEl.textContent = skPub.sdBandOpacity + '%';
    var cw = g('sk-pub-custom-width-wrap');
    if (cw) cw.style.display = skPub.sizePreset === 'custom' ? '' : 'none';
    var cr = g('sk-pub-custom-ratio-wrap');
    if (cr) cr.style.display = isPreset ? 'none' : '';
    var bo = g('sk-pub-border-opts');
    if (bo) bo.style.display = skPub.showBorder ? '' : 'none';

    // per-chart sync
    ['traces','derived','params','st'].forEach(function(ch) {
      var pc = skPub.perChart[ch];
      function sv(id, v) { setVal('sk-pc-'+ch+'-'+id, v); }
      function sc(id, v) { setChk('sk-pc-'+ch+'-'+id, v); }
      sc('y-start-zero', pc.yStartZero);
      sv('y-headroom',   pc.yHeadroom);
      sv('y-title',      pc.yTitle);
      if (pc.xTitle !== undefined) sv('x-title', pc.xTitle);
    });
  }

  function updatePcRangeLabel(ch, field, text) {
    var el = g('sk-pc-'+ch+'-'+field+'-val');
    if (el) el.textContent = text;
  }

  function updateBadge() {
    var badge = g('sk-grp-pub-badge');
    if (!badge) return;
    var isCustom = Object.keys(SK_PUB_DEFAULTS).some(function(k) { return skPub[k] !== SK_PUB_DEFAULTS[k]; });
    if (!isCustom) {
      isCustom = ['traces','derived','params','st'].some(function(ch) {
        var pc = skPub.perChart[ch], def = SK_PER_CHART_DEFAULTS[ch];
        return Object.keys(def).some(function(k) { return pc[k] !== def[k]; });
      });
    }
    badge.style.display = isCustom ? '' : 'none';
  }

  var _reRenderTimer = null;
  function triggerReRender(chartKey) {
    clearTimeout(_reRenderTimer);
    _reRenderTimer = setTimeout(function() {
      if (!skData || !hasGroups()) return;
      _applyPubAspectRatio();
      if (!chartKey || chartKey === 'traces')  renderGroupTracesChart();
      if (!chartKey || chartKey === 'derived') { if (skData.has_params) renderGroupDerivedCharts(); }
      if (!chartKey || chartKey === 'params')  { if (skData.has_summary) renderGroupParamsCharts(); }
      if (!chartKey || chartKey === 'st')      { if (skData.has_state_transitions) renderGroupStCharts(); }
    }, 80);
  }

  // ── shared control events ─────────────────────────────────────────────────
  var sizePresetSel = g('sk-pub-size-preset');
  if (sizePresetSel) sizePresetSel.addEventListener('change', function() {
    var cw = g('sk-pub-custom-width-wrap');
    if (cw) cw.style.display = this.value === 'custom' ? '' : 'none';
    readSettings(); updateBadge(); triggerReRender();
  });
  var aspectPresetSel = g('sk-pub-aspect-preset');
  if (aspectPresetSel) aspectPresetSel.addEventListener('change', function() {
    var cr = g('sk-pub-custom-ratio-wrap');
    if (cr) cr.style.display = this.value === 'custom' ? '' : 'none';
    readSettings(); updateBadge(); triggerReRender();
  });
  var showBorderChk = g('sk-pub-show-border');
  if (showBorderChk) showBorderChk.addEventListener('change', function() {
    var bo = g('sk-pub-border-opts');
    if (bo) bo.style.display = this.checked ? '' : 'none';
    readSettings(); updateBadge(); triggerReRender();
  });
  ['sk-pub-export-width','sk-pub-aspect-custom','sk-pub-dpi','sk-pub-bg-color',
   'sk-pub-font-family','sk-pub-axis-title-size','sk-pub-tick-size','sk-pub-legend-size',
   'sk-pub-color-scheme','sk-pub-legend-pos',
   'sk-pub-grid-y','sk-pub-grid-x',
   'sk-pub-border-color','sk-pub-border-width',
  ].forEach(function(id) {
    var el = g(id);
    if (el) el.addEventListener('change', function() { readSettings(); updateBadge(); triggerReRender(); });
  });
  // shared range sliders (line weights / SD opacity)
  [
    { id: 'sk-pub-line-width-mean',  labelId: 'sk-pub-line-width-mean-val',  fmt: function(v){ return v + ' px'; } },
    { id: 'sk-pub-line-width-indiv', labelId: 'sk-pub-line-width-indiv-val', fmt: function(v){ return v + ' px'; } },
    { id: 'sk-pub-sd-opacity',       labelId: 'sk-pub-sd-opacity-val',       fmt: function(v){ return v + '%'; } },
  ].forEach(function(cfg) {
    var el = g(cfg.id);
    if (el) el.addEventListener('input', function() {
      var lbl = g(cfg.labelId); if (lbl) lbl.textContent = cfg.fmt(parseFloat(this.value));
      readSettings(); updateBadge(); triggerReRender();
    });
  });

  // ── per-chart control events ──────────────────────────────────────────────
  var _pcFields = {
    traces:  ['y-start-zero','y-headroom','x-title','y-title'],
    derived: ['y-start-zero','y-headroom'],
    params:  ['y-start-zero','y-headroom'],
    st:      ['y-start-zero','y-headroom'],
  };
  Object.keys(_pcFields).forEach(function(ch) {
    _pcFields[ch].forEach(function(field) {
      var el = g('sk-pc-'+ch+'-'+field);
      if (el) el.addEventListener('change', function() { readSettings(); updateBadge(); triggerReRender(ch); });
    });
  });

  // Export button
  var exportBtn = g('sk-pub-export-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportGroupTracesPubPng);

  // Reset button
  var resetBtn = g('sk-pub-reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', function() {
    skPub = _makeSkPub();
    syncUI(); updateBadge();
    try { localStorage.removeItem('sk_grp_traces_pub'); } catch(e) {}
    triggerReRender();
  });

  // Chevron
  var pubBody = g('sk-grp-pub-body');
  if (pubBody) {
    $(pubBody).on('show.bs.collapse', function() {
      var chev = g('sk-grp-pub-chevron'); if (chev) chev.style.transform = 'rotate(180deg)';
    }).on('hide.bs.collapse', function() {
      var chev = g('sk-grp-pub-chevron'); if (chev) chev.style.transform = '';
    });
  }

  syncUI(); updateBadge();
}
