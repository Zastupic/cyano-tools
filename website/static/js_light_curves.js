// ============================================================
//  CyanoTools Light Curves Analyzer — frontend logic
//  Chart.js 4.x + chartjs-chart-error-bars
// ============================================================

// ── state ─────────────────────────────────────────────────────────────────
let lcData         = null;    // full JSON from /api/lc_process
let groups         = {};      // {filename: groupName}
let chartInst      = {};      // {chartId: Chart instance}
let dirtyTabs      = new Set();
let showIndivTraces = true;   // individual ETR traces visibility in Groups & Averages
let showIndivRaw    = true;   // individual raw fluorescence traces visibility
let lcEtrJitter     = 0;      // PAR jitter between groups in ETR chart
let lcRawGrpJitter  = 0;      // time jitter between groups in raw fluorescence chart
let lcRawGrpNorm     = 'raw'; // 'raw' | 'normalized'
let lcRawGrpNormTime = 1;     // reference time (s) for group raw normalization

// ── parameter metadata ────────────────────────────────────────────────────
const PARAM_KEYS = ['alpha', 'beta', 'etr_max_measured', 'etr_max_from_ab', 'etr_mpot', 'ik', 'ib'];
const PARAM_LABELS = {
  alpha:             'α',
  beta:              'β',
  etr_max_measured:  'ETRmax (measured)',
  etr_max_from_ab:   'ETRmax (α/β)',
  etr_mpot:          'ETRmPot',
  ik:                'Ik',
  ib:                'Ib',
};
// Split into groups to avoid scale mismatch on bar charts:
// alpha/beta are dimensionless (~0–1); rates/irradiances are µmol m⁻² s⁻¹ (~10–2000).
const LC_PARAM_GROUPS = {
  efficiencies: ['alpha', 'beta'],
  rates:        ['etr_max_measured', 'etr_max_from_ab', 'etr_mpot', 'ik', 'ib'],
};

function _lcKeyToId(key) { return key.replace(/_/g, '-'); }

// ── raw chart normalisation / jitter state ────────────────────────────────
let lcRawNorm     = 'raw';  // 'raw' | 'normalized'
let lcRawNormTime = 1;      // reference time (µs) for normalization
let lcRawJitter   = 0;      // x-offset per successive trace (µs)

function normalizeTraceArr(values, times, refTime) {
  let refIdx = 0, minDist = Infinity;
  for (let j = 0; j < times.length; j++) {
    const d = Math.abs(times[j] - refTime);
    if (d < minDist) { minDist = d; refIdx = j; }
  }
  const refVal = values[refIdx];
  if (!refVal) return values;
  return values.map(v => v / refVal);
}

// ── per-chart settings (group ETR only) ───────────────────────────────────
const LC_PC_DEFAULTS = {
  groupEtr: { yStartZero: false, yHeadroom: 5, xTitle: '', yTitle: '' },
};
let lcPc = JSON.parse(JSON.stringify(LC_PC_DEFAULTS));

function readLcPcSettings() {
  function readPc(chartKey) {
    const pre = 'lc-pc-' + chartKey + '-';
    const yz = document.getElementById(pre + 'y-start-zero');
    const yh = document.getElementById(pre + 'y-headroom');
    const xt = document.getElementById(pre + 'x-title');
    const yt = document.getElementById(pre + 'y-title');
    return {
      yStartZero: yz ? yz.checked : false,
      yHeadroom:  yh ? (parseFloat(yh.value) || 5) : 5,
      xTitle:     xt ? xt.value.trim() : '',
      yTitle:     yt ? yt.value.trim() : '',
    };
  }
  lcPc.groupEtr = readPc('group-etr');
}

// ── publication / figure style settings ──────────────────────────────────
const LC_PUB_DEFAULTS = {
  sizePreset:     'single',
  exportWidth:    85,
  aspectRatio:    1.5,
  exportDPI:      300,
  fontFamily:     'Arial',
  axisTitleSize:  12,
  tickLabelSize:  11,
  legendSize:     10,
  colorScheme:    'default',
  legendPosition: 'right',
  showGridY:      true,
  showGridX:      false,
  bgColor:        '#ffffff',
  showBorder:     false,
  borderColor:    '#000000',
  borderWidth:    1,
  lineWidthMean:  2.5,
  lineWidthIndiv: 0.8,
  sdBandOpacity:  18,
};

const LC_PUB_PALETTES = {
  colorblind: ['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000'],
  grayscale:  ['#111111','#444444','#777777','#aaaaaa','#cccccc'],
  paired:     ['#1f77b4','#aec7e8','#ff7f0e','#ffbb78','#2ca02c','#98df8a','#d62728','#ff9896'],
};

function _makeLcPub() {
  let pub = Object.assign({}, LC_PUB_DEFAULTS);
  try {
    const saved = JSON.parse(localStorage.getItem('lc_grp_pub') || 'null');
    if (saved) Object.keys(LC_PUB_DEFAULTS).forEach(k => { if (k in saved) pub[k] = saved[k]; });
  } catch(e) {}
  return pub;
}
let lcPub = _makeLcPub();

function _lcPubColor(gi, n, alpha) {
  const palette = LC_PUB_PALETTES[lcPub.colorScheme];
  if (!palette) return groupColor(gi, n, alpha);
  const hex = palette[gi % palette.length];
  if (alpha === undefined) return hex;
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function _lcPubBgPlugin() {
  return {
    id: 'lcPubBg',
    beforeDraw(chart) {
      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = lcPub.bgColor || '#ffffff';
      ctx.fillRect(0, 0, chart.width, chart.height);
      ctx.restore();
    },
  };
}

function _lcPubBorderPlugin() {
  return {
    id: 'lcPubBorder',
    afterDraw(chart) {
      if (!lcPub.showBorder) return;
      const ca = chart.chartArea, ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = lcPub.borderColor || '#000000';
      ctx.lineWidth   = lcPub.borderWidth  || 1;
      ctx.strokeRect(ca.left, ca.top, ca.right - ca.left, ca.bottom - ca.top);
      ctx.restore();
    },
  };
}

function _applyLcPubToOpts(opts, isBar, pc) {
  const s = lcPub, fam = s.fontFamily;
  const sc = opts.scales || {};
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

function _applyLcPubAspectRatio() {
  const ratio = lcPub.aspectRatio || 1.5;
  const presetWidths = { single: 85, half: 120, double: 175 };
  const widthMm = lcPub.sizePreset !== 'custom'
    ? (presetWidths[lcPub.sizePreset] || 85)
    : (lcPub.exportWidth || 85);
  const maxWPx = Math.round(widthMm * 96 / 25.4);
  document.querySelectorAll('.lc-pub-ch').forEach(cont => {
    cont.style.maxWidth = maxWPx + 'px';
    const w = cont.offsetWidth;
    if (w > 0) cont.style.height = Math.round(w / ratio) + 'px';
    const cid = cont.dataset.cid;
    const ch  = cid && chartInst && chartInst[cid];
    if (ch) ch.resize();
  });
}

function readLcPubSettings() {
  const g = id => document.getElementById(id);
  const sizePreset = (g('lc-pub-size-preset') || {}).value || 'single';
  lcPub.sizePreset   = sizePreset;
  lcPub.exportWidth  = sizePreset !== 'custom'
    ? ({ single: 85, half: 120, double: 175 }[sizePreset] || 85)
    : (parseFloat((g('lc-pub-export-width') || {}).value) || 85);
  const aspectVal = (g('lc-pub-aspect-preset') || {}).value || '1.50';
  lcPub.aspectRatio  = aspectVal === 'custom'
    ? (parseFloat((g('lc-pub-aspect-custom') || {}).value) || 1.5)
    : (parseFloat(aspectVal) || 1.5);
  lcPub.exportDPI      = parseInt((g('lc-pub-dpi') || {}).value)              || 300;
  lcPub.bgColor        = (g('lc-pub-bg-color') || {}).value                   || '#ffffff';
  lcPub.fontFamily     = (g('lc-pub-font-family') || {}).value                || 'Arial';
  lcPub.axisTitleSize  = parseInt((g('lc-pub-axis-title-size') || {}).value)  || 12;
  lcPub.tickLabelSize  = parseInt((g('lc-pub-tick-size') || {}).value)        || 11;
  lcPub.legendSize     = parseInt((g('lc-pub-legend-size') || {}).value)      || 10;
  lcPub.colorScheme    = (g('lc-pub-color-scheme') || {}).value               || 'default';
  lcPub.legendPosition = (g('lc-pub-legend-pos') || {}).value                 || 'right';
  lcPub.showGridY      = !!(g('lc-pub-grid-y') || {}).checked;
  lcPub.showGridX      = !!(g('lc-pub-grid-x') || {}).checked;
  lcPub.showBorder     = !!(g('lc-pub-show-border') || {}).checked;
  lcPub.borderColor    = (g('lc-pub-border-color') || {}).value               || '#000000';
  lcPub.borderWidth    = parseFloat((g('lc-pub-border-width') || {}).value)   || 1;
  lcPub.lineWidthMean  = parseFloat((g('lc-pub-line-width-mean')  || {}).value) || 2.5;
  lcPub.lineWidthIndiv = parseFloat((g('lc-pub-line-width-indiv') || {}).value) || 0.8;
  lcPub.sdBandOpacity  = parseInt((g('lc-pub-sd-opacity')          || {}).value) || 18;
  try { localStorage.setItem('lc_grp_pub', JSON.stringify(lcPub)); } catch(e) {}
}

function syncDomFromLcPub() {
  const g  = id => document.getElementById(id);
  const sv = (id, v) => { const el = g(id); if (el) el.value = v; };
  const sc = (id, v) => { const el = g(id); if (el) el.checked = v; };
  sv('lc-pub-size-preset',    lcPub.sizePreset);
  sv('lc-pub-export-width',   lcPub.exportWidth);
  const ratioStr = lcPub.aspectRatio.toFixed(2);
  const knownRatios = ['1.78','1.50','1.33','1.00','0.75'];
  sv('lc-pub-aspect-preset', knownRatios.includes(ratioStr) ? ratioStr : 'custom');
  sv('lc-pub-aspect-custom',  ratioStr);
  const cwWrap = g('lc-pub-custom-width-wrap');
  if (cwWrap) cwWrap.style.display = lcPub.sizePreset === 'custom' ? '' : 'none';
  const crWrap = g('lc-pub-custom-ratio-wrap');
  if (crWrap) crWrap.style.display = knownRatios.includes(ratioStr) ? 'none' : '';
  sv('lc-pub-dpi',            lcPub.exportDPI);
  sv('lc-pub-bg-color',       lcPub.bgColor);
  sv('lc-pub-font-family',    lcPub.fontFamily);
  sv('lc-pub-axis-title-size', lcPub.axisTitleSize);
  sv('lc-pub-tick-size',      lcPub.tickLabelSize);
  sv('lc-pub-legend-size',    lcPub.legendSize);
  sv('lc-pub-color-scheme',   lcPub.colorScheme);
  sv('lc-pub-legend-pos',     lcPub.legendPosition);
  sc('lc-pub-grid-y',         lcPub.showGridY);
  sc('lc-pub-grid-x',         lcPub.showGridX);
  sc('lc-pub-show-border',    lcPub.showBorder);
  sv('lc-pub-border-color',   lcPub.borderColor);
  sv('lc-pub-border-width',   lcPub.borderWidth);
  const bOpts = g('lc-pub-border-opts');
  if (bOpts) bOpts.style.display = lcPub.showBorder ? '' : 'none';
  sv('lc-pub-line-width-mean',  lcPub.lineWidthMean);
  sv('lc-pub-line-width-indiv', lcPub.lineWidthIndiv);
  sv('lc-pub-sd-opacity',       lcPub.sdBandOpacity);
  const mVal = g('lc-pub-line-width-mean-val');  if (mVal) mVal.textContent = lcPub.lineWidthMean + ' px';
  const iVal = g('lc-pub-line-width-indiv-val'); if (iVal) iVal.textContent = lcPub.lineWidthIndiv + ' px';
  const sVal = g('lc-pub-sd-opacity-val');       if (sVal) sVal.textContent = lcPub.sdBandOpacity + '%';
  const badge = g('lc-pub-badge');
  if (badge) {
    const isDefault = JSON.stringify(lcPub) === JSON.stringify(LC_PUB_DEFAULTS);
    badge.style.display = isDefault ? 'none' : '';
  }
}

function _renderAllGroupCharts() {
  renderGroupRawChart();
  renderGroupEtrChart();
  renderGroupParamsCharts();
}

function _reRenderGroupCharts() {
  if (!lcData || !hasGroups()) return;
  if (activeTabId() === 'tab-groups') {
    _applyLcPubAspectRatio();
    _renderAllGroupCharts();
  } else {
    _withPaneVisible('tab-groups', () => {
      const gr = document.getElementById('group-results');
      if (gr) { gr.style.display = ''; void gr.offsetWidth; }
      _applyLcPubAspectRatio();
      _renderAllGroupCharts();
    });
  }
}

function _lcPubExportPng() {
  const canvas = document.getElementById('group-etr-chart');
  if (!canvas || !chartInst['group-etr-chart']) return;
  const s = lcPub;
  const mmToPx = dpi => mm => Math.round(mm * dpi / 25.4);
  const toP = mmToPx(s.exportDPI);
  const widthMm  = s.sizePreset !== 'custom' ? ({ single: 85, half: 120, double: 175 }[s.sizePreset] || 85) : (s.exportWidth || 85);
  const w = toP(widthMm);
  const h = Math.round(w / (s.aspectRatio || 1.5));
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = s.bgColor || '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  const a = document.createElement('a');
  a.href = tmp.toDataURL('image/png');
  a.download = 'lc_group_etr.png';
  a.click();
}

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
  // Destroy any orphaned Chart.js instance left on this canvas element
  const orphan = Chart.getChart(el);
  if (orphan) orphan.destroy();
  chartInst[id] = new Chart(el, cfg);
  return chartInst[id];
}

// Force a pane visible temporarily so Chart.js measures layout correctly
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

// ── tab rendering helpers ─────────────────────────────────────────────────
function activeTabId() {
  return (document.querySelector('#lcTabs .nav-link.active')?.getAttribute('href') || '#tab-raw').slice(1);
}
function markTabsDirty(...ids) { ids.forEach(id => dirtyTabs.add(id)); }

function renderDirtyTab(tabId) {
  if (!lcData || !dirtyTabs.has(tabId)) return;
  dirtyTabs.delete(tabId);
  if (tabId === 'tab-ftfm') {
    renderFtFmChart();
  } else if (tabId === 'tab-etr') {
    renderEtrChart();
  } else if (tabId === 'tab-derived') {
    const metric = document.querySelector('#derived-btns .btn-primary')?.dataset?.metric || 'qy';
    renderDerivedChart(metric);
  } else if (tabId === 'tab-params') {
    const pg = document.querySelector('#param-group-btns .btn-primary')?.dataset?.pgroup || 'efficiencies';
    renderParamsChart(pg);
    renderParamsTable();
  } else if (tabId === 'tab-groups') {
    refreshGroupSummary();
    if (hasGroups()) {
      const gr = document.getElementById('group-results');
      if (gr) { gr.style.display = ''; void gr.offsetWidth; }
      _applyLcPubAspectRatio();   // tab is now active so offsetWidth is real
      _renderAllGroupCharts();
    }
  }
}

// ── compact legend ────────────────────────────────────────────────────────
function compactLegend(position = 'right') {
  return {
    display: true, position,
    labels: {
      font: { size: 10 }, padding: 4, boxWidth: 12, boxHeight: 8,
      filter: item => item.text !== '',
      generateLabels(chart) {
        const items = Chart.defaults.plugins.legend.labels.generateLabels(chart);
        return items.map(d => ({ ...d, text: d.text?.length > 24 ? d.text.slice(0, 22) + '…' : (d.text ?? '') }));
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

// ── format helper ─────────────────────────────────────────────────────────
function fmt(v, d = 4) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(d);
}

function esc(s) { return s.replace(/[^a-z0-9]/gi, '_'); }

// ── active button helper ──────────────────────────────────────────────────
function setActiveBtn(groupId, activeBtn) {
  document.querySelectorAll(`#${groupId} .btn`).forEach(b => {
    b.classList.replace('btn-primary', 'btn-outline-primary');
  });
  activeBtn.classList.replace('btn-outline-primary', 'btn-primary');
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Drop-zone
  const dz   = document.getElementById('drop-zone');
  const finp = document.getElementById('lc-files');
  if (dz && finp) {
    dz.addEventListener('click', () => finp.click());
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.style.background = '#e8f4fd'; });
    dz.addEventListener('dragleave', ()  => { dz.style.background = '#f8f9fa'; });
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.style.background = '#f8f9fa';
      finp.files = e.dataTransfer.files; updateFileList();
    });
    finp.addEventListener('change', updateFileList);
  }

  // Analyze button
  document.getElementById('analyze-btn')?.addEventListener('click', uploadAndAnalyze);

  // Param group segmented controls (tab-params + tab-groups)
  document.getElementById('param-group-btns')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-pgroup]'); if (!btn) return;
    setActiveBtn('param-group-btns', btn);
    renderParamsChart(btn.dataset.pgroup);
    renderParamsTable();
  });
  // Raw chart — normalisation toggle
  document.getElementById('lc-raw-norm-btns')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-norm]'); if (!btn) return;
    setActiveBtn('lc-raw-norm-btns', btn);
    lcRawNorm = btn.dataset.norm;
    const box = document.getElementById('lc-raw-norm-time-box');
    if (box) box.style.display = lcRawNorm === 'normalized' ? '' : 'none';
    if (lcData) renderRawChart();
  });
  document.getElementById('lc-raw-norm-time')?.addEventListener('change', () => {
    lcRawNormTime = parseFloat(document.getElementById('lc-raw-norm-time').value) || 1;
    if (lcData && lcRawNorm === 'normalized') renderRawChart();
  });
  document.getElementById('lc-raw-jitter')?.addEventListener('change', () => {
    lcRawJitter = parseFloat(document.getElementById('lc-raw-jitter').value) || 0;
    if (lcData) renderRawChart();
  });
  // Per-chart settings — group ETR chart
  ['lc-pc-group-etr-y-start-zero','lc-pc-group-etr-y-headroom','lc-pc-group-etr-x-title','lc-pc-group-etr-y-title'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => { readLcPcSettings(); if (lcData && hasGroups()) renderGroupEtrChart(); });
  });

  // Figure Style pub card — any change re-reads, re-renders, re-saves
  const _pubInputIds = [
    'lc-pub-size-preset','lc-pub-export-width','lc-pub-aspect-preset','lc-pub-aspect-custom',
    'lc-pub-dpi','lc-pub-bg-color','lc-pub-font-family','lc-pub-axis-title-size',
    'lc-pub-tick-size','lc-pub-legend-size','lc-pub-color-scheme','lc-pub-legend-pos',
    'lc-pub-grid-y','lc-pub-grid-x','lc-pub-show-border','lc-pub-border-color','lc-pub-border-width',
    'lc-pub-line-width-mean','lc-pub-line-width-indiv','lc-pub-sd-opacity',
  ];
  _pubInputIds.forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => { readLcPubSettings(); syncDomFromLcPub(); _reRenderGroupCharts(); });
    document.getElementById(id)?.addEventListener('change', () => { readLcPubSettings(); syncDomFromLcPub(); _reRenderGroupCharts(); });
  });
  document.getElementById('lc-pub-export-btn')?.addEventListener('click', _lcPubExportPng);
  document.getElementById('lc-pub-reset-btn')?.addEventListener('click', () => {
    lcPub = Object.assign({}, LC_PUB_DEFAULTS);
    try { localStorage.removeItem('lc_grp_pub'); } catch(e) {}
    syncDomFromLcPub(); _reRenderGroupCharts();
  });
  document.getElementById('lc-pub-show-border')?.addEventListener('change', e => {
    const bOpts = document.getElementById('lc-pub-border-opts');
    if (bOpts) bOpts.style.display = e.target.checked ? '' : 'none';
  });
  // Show/hide custom width/ratio fields
  document.getElementById('lc-pub-size-preset')?.addEventListener('change', e => {
    const w = document.getElementById('lc-pub-custom-width-wrap');
    if (w) w.style.display = e.target.value === 'custom' ? '' : 'none';
  });
  document.getElementById('lc-pub-aspect-preset')?.addEventListener('change', e => {
    const w = document.getElementById('lc-pub-custom-ratio-wrap');
    if (w) w.style.display = e.target.value === 'custom' ? '' : 'none';
  });
  // Slider live value labels
  document.getElementById('lc-pub-line-width-mean')?.addEventListener('input', e => {
    const el = document.getElementById('lc-pub-line-width-mean-val');
    if (el) el.textContent = e.target.value + ' px';
  });
  document.getElementById('lc-pub-line-width-indiv')?.addEventListener('input', e => {
    const el = document.getElementById('lc-pub-line-width-indiv-val');
    if (el) el.textContent = e.target.value + ' px';
  });
  document.getElementById('lc-pub-sd-opacity')?.addEventListener('input', e => {
    const el = document.getElementById('lc-pub-sd-opacity-val');
    if (el) el.textContent = e.target.value + '%';
  });
  // Pub card collapse chevron
  document.getElementById('lc-pub-body')?.addEventListener('show.bs.collapse', () => {
    const ch = document.getElementById('lc-pub-chevron');
    if (ch) ch.style.transform = 'rotate(180deg)';
  });
  document.getElementById('lc-pub-body')?.addEventListener('hide.bs.collapse', () => {
    const ch = document.getElementById('lc-pub-chevron');
    if (ch) ch.style.transform = 'rotate(0deg)';
  });

  // Derived metric segmented control
  document.getElementById('derived-btns')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-metric]'); if (!btn) return;
    setActiveBtn('derived-btns', btn);
    renderDerivedChart(btn.dataset.metric);
  });

  // Groups tab
  document.getElementById('select-all-check')?.addEventListener('change', e => {
    document.querySelectorAll('.group-check').forEach(cb => cb.checked = e.target.checked);
  });
  document.getElementById('sort-asc-btn')?.addEventListener('click',  () => sortFiles('asc'));
  document.getElementById('sort-desc-btn')?.addEventListener('click', () => sortFiles('desc'));
  document.getElementById('auto-detect-btn')?.addEventListener('click', autoDetectGroups);
  document.getElementById('clear-groups-btn')?.addEventListener('click', clearAllGroups);
  document.getElementById('assign-group-btn')?.addEventListener('click', assignGroup);
  document.getElementById('group-assign-table')?.addEventListener('click', _onGroupAssignClick);

  // Export to statistics
  document.getElementById('export-stats-btn')?.addEventListener('click', exportToStatistics);

  // Toggle individual traces — ETR chart (checkbox)
  document.getElementById('toggle-indiv-etr-btn')?.addEventListener('change', e => {
    showIndivTraces = e.target.checked;
    const chart = chartInst['group-etr-chart'];
    if (chart) {
      chart.data.datasets.forEach(ds => { if (ds._isIndividual) ds.hidden = !showIndivTraces; });
      chart.update('none');
    }
  });
  // Toggle individual traces — raw fluorescence chart (checkbox)
  document.getElementById('toggle-indiv-raw-btn')?.addEventListener('change', e => {
    showIndivRaw = e.target.checked;
    const chart = chartInst['group-raw-chart'];
    if (chart) {
      chart.data.datasets.forEach(ds => { if (ds._isIndividual) ds.hidden = !showIndivRaw; });
      chart.update('none');
    }
  });
  // Jitter — ETR chart
  document.getElementById('lc-etr-jitter')?.addEventListener('change', () => {
    lcEtrJitter = parseFloat(document.getElementById('lc-etr-jitter').value) || 0;
    if (lcData && hasGroups()) renderGroupEtrChart();
  });
  // Jitter — raw fluorescence group chart
  document.getElementById('lc-raw-grp-jitter')?.addEventListener('change', () => {
    lcRawGrpJitter = parseFloat(document.getElementById('lc-raw-grp-jitter').value) || 0;
    if (lcData && hasGroups()) renderGroupRawChart();
  });
  // Normalisation toggle — group raw chart
  document.getElementById('lc-raw-grp-norm-btns')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-gnorm]'); if (!btn) return;
    setActiveBtn('lc-raw-grp-norm-btns', btn);
    lcRawGrpNorm = btn.dataset.gnorm;
    const box = document.getElementById('lc-raw-grp-norm-time-box');
    if (box) box.style.display = lcRawGrpNorm === 'normalized' ? '' : 'none';
    if (lcData && hasGroups()) renderGroupRawChart();
  });
  document.getElementById('lc-raw-grp-norm-time')?.addEventListener('change', () => {
    lcRawGrpNormTime = parseFloat(document.getElementById('lc-raw-grp-norm-time').value) || 1;
    if (lcData && hasGroups() && lcRawGrpNorm === 'normalized') renderGroupRawChart();
  });

  // Tab shown → resize charts & render dirty
  document.getElementById('lcTabs')?.addEventListener('shown.bs.tab', e => {
    if (!lcData) return;
    const tabId = (e.target.getAttribute('href') || '').slice(1);
    renderDirtyTab(tabId);
    if (tabId === 'tab-groups') {
      if (hasGroups()) {
        const gr = document.getElementById('group-results');
        if (gr) { gr.style.display = ''; void gr.offsetWidth; }
        _applyLcPubAspectRatio();
        _renderAllGroupCharts();
      }
    } else {
      const resizeIds = {
        'tab-raw':     ['raw-chart'],
        'tab-ftfm':    ['ftfm-chart'],
        'tab-etr':     ['etr-chart'],
        'tab-derived': ['derived-chart'],
        'tab-params':  ['params-chart'],
      };
      (resizeIds[tabId] || []).forEach(id => chartInst[id]?.resize());
    }
  });

  // Advanced params chevron
  const chevron = document.getElementById('advancedParamsChevron');
  if (chevron) {
    document.getElementById('advancedParams')
      ?.addEventListener('show.bs.collapse', () => { chevron.style.transform = 'rotate(180deg)'; });
    document.getElementById('advancedParams')
      ?.addEventListener('hide.bs.collapse', () => { chevron.style.transform = 'rotate(0deg)'; });
  }
});

// ── file list ─────────────────────────────────────────────────────────────
function updateFileList() {
  const files = document.getElementById('lc-files').files;
  const lbl   = document.getElementById('file-count-label');
  const list  = document.getElementById('file-list');
  const btn   = document.getElementById('analyze-btn');
  if (!files.length) {
    lbl.textContent = 'No files selected'; list.innerHTML = '';
    btn.disabled = true; return;
  }
  lbl.textContent = `${files.length} file(s) selected`;
  list.innerHTML  = [...files].map(f => `<span class="badge badge-light border mr-1">${f.name}</span>`).join('');
  btn.disabled    = false;
}

// ── upload & analyze ──────────────────────────────────────────────────────
async function uploadAndAnalyze() {
  const files = document.getElementById('lc-files').files;
  if (!files.length) return;

  const protocol  = document.querySelector('input[name="lc_protocol"]:checked')?.value || 'LC3';
  const etrFactor = document.getElementById('etr_max_factor')?.value || '10';

  const fd = new FormData();
  for (const f of files) fd.append('light_curve_files', f);
  fd.append('fluorometer',    'AquaPen');
  fd.append('protocol',       protocol);
  fd.append('etr_max_factor', etrFactor);

  const errDiv = document.getElementById('upload-error');
  errDiv.style.display = 'none';
  setLoading(true);

  const fileNames = [...files].map(f => f.name).join(', ');

  try {
    const resp    = await fetch('/api/lc_process', { method: 'POST', body: fd });
    const rawText = await resp.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      const preview = rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
      errDiv.innerHTML =
        `<strong>Server error</strong> (HTTP ${resp.status}) while processing: <em>${fileNames}</em><br>` +
        `<details><summary>Server response</summary>` +
        `<pre style="font-size:0.78em;white-space:pre-wrap;max-height:200px;overflow:auto">${preview}</pre></details>`;
      errDiv.style.display = '';
      return;
    }

    if (data.status === 'error') {
      errDiv.innerHTML = `<strong>Processing error</strong> for: <em>${fileNames}</em><br>${data.message}`;
      errDiv.style.display = '';
      return;
    }

    lcData = data;
    groups = {};
    document.getElementById('results-section').style.display = '';
    renderResults();
    document.getElementById('results-section').scrollIntoView({ behavior: 'smooth' });

  } catch (err) {
    errDiv.innerHTML = `<strong>Network error</strong> while uploading: <em>${fileNames}</em><br>${err.message}`;
    errDiv.style.display = '';
  } finally {
    setLoading(false);
  }
}

function setLoading(on) {
  const btn = document.getElementById('analyze-btn');
  const sp  = document.getElementById('analyze-spinner');
  btn.disabled    = on;
  sp.style.display = on ? '' : 'none';
}

// ── render all results ────────────────────────────────────────────────────
function renderResults() {
  const n = lcData.files.length;
  document.getElementById('results-summary').textContent =
    `${n} file${n > 1 ? 's' : ''} processed — ${lcData.fluorometer} — Protocol ${lcData.protocol}` +
    ` — PAR: ${lcData.light_intensities.join(', ')} µmol photons m⁻² s⁻¹`;

  // Wire download button
  const xlsxSummaryLink = document.getElementById('xlsx-summary-link');
  xlsxSummaryLink.href    = '#';
  xlsxSummaryLink.onclick = e => { e.preventDefault(); downloadXlsxWithCharts(); };
  xlsxSummaryLink.style.display = '';

  // Sync Figure Style card from saved/default settings
  lcPub = _makeLcPub();
  syncDomFromLcPub();

  // Reset group chart state
  showIndivTraces = true; showIndivRaw = true;
  lcEtrJitter = 0; lcRawGrpJitter = 0;
  lcRawGrpNorm = 'raw'; lcRawGrpNormTime = 1;
  const _grpNormBtn = document.querySelector('#lc-raw-grp-norm-btns [data-gnorm="raw"]');
  if (_grpNormBtn) setActiveBtn('lc-raw-grp-norm-btns', _grpNormBtn);
  const _grpNormBox = document.getElementById('lc-raw-grp-norm-time-box');
  if (_grpNormBox) _grpNormBox.style.display = 'none';
  const _grpNormInp = document.getElementById('lc-raw-grp-norm-time');
  if (_grpNormInp) _grpNormInp.value = '1';
  const _etrCb = document.getElementById('toggle-indiv-etr-btn');
  if (_etrCb) _etrCb.checked = true;
  const _rawCb = document.getElementById('toggle-indiv-raw-btn');
  if (_rawCb) _rawCb.checked = true;
  const _etrJitterInp = document.getElementById('lc-etr-jitter');
  if (_etrJitterInp) _etrJitterInp.value = '0';
  const _rawGrpJitterInp = document.getElementById('lc-raw-grp-jitter');
  if (_rawGrpJitterInp) _rawGrpJitterInp.value = '0';

  // Reset raw trace controls to defaults
  lcRawNorm = 'raw'; lcRawNormTime = 1; lcRawJitter = 0;
  const _rawNormBtn = document.querySelector('#lc-raw-norm-btns [data-norm="raw"]');
  if (_rawNormBtn) setActiveBtn('lc-raw-norm-btns', _rawNormBtn);
  const _rawNormBox = document.getElementById('lc-raw-norm-time-box');
  if (_rawNormBox) _rawNormBox.style.display = 'none';
  const _rawNormInp = document.getElementById('lc-raw-norm-time');
  if (_rawNormInp) _rawNormInp.value = '1';
  const _rawJitterInp = document.getElementById('lc-raw-jitter');
  if (_rawJitterInp) _rawJitterInp.value = '0';

  // Render visible tab immediately
  renderRawChart();

  // Pre-render hidden tabs with forced visibility so Chart.js measures real dimensions
  _withPaneVisible('tab-ftfm',    renderFtFmChart);
  _withPaneVisible('tab-etr',     renderEtrChart);
  _withPaneVisible('tab-derived', () => renderDerivedChart('qy'));
  _withPaneVisible('tab-params',  () => { renderParamsChart('efficiencies'); renderParamsTable(); });

  // Groups tab: lazy — depends on user group assignments
  buildGroupAssignTable();
  markTabsDirty('tab-groups');
}

// ── raw fluorescence chart ────────────────────────────────────────────────
function renderRawChart() {
  const files  = lcData.files;
  const t_s    = lcData.raw_time_us.map(v => v / 1e6);   // µs → seconds
  const n      = files.length;
  const norm   = lcRawNorm === 'normalized';
  const yLabel = norm ? 'F / F(ref)' : 'Fluorescence intensity (a.u.)';

  const datasets = files.map((fname, i) => {
    const raw    = lcData.raw_curves[fname] || [];
    const vals   = norm ? normalizeTraceArr(raw, t_s, lcRawNormTime) : raw;
    const offset = i * lcRawJitter;
    return {
      label:           fname,
      data:            vals.map((y, j) => ({ x: t_s[j] + offset, y })),
      borderColor:     sampleColor(i, n),
      backgroundColor: 'transparent',
      borderWidth: 1.5, pointRadius: 0, showLine: true,
    };
  });

  makeChart('raw-chart', {
    type: 'scatter',
    data: { datasets },
    options: linearScatterOpts('Time (s)', yLabel),
  });
}

// ── Ft & Fm chart ─────────────────────────────────────────────────────────
function renderFtFmChart() {
  const files = lcData.files;
  const par   = lcData.light_intensities;
  const n     = files.length;
  const datasets = [];

  files.forEach((fname, i) => {
    const c  = sampleColor(i, n);
    const sd = lcData.step_data[fname];
    // Ft — solid line + points
    datasets.push({
      label:           fname,
      data:            sd.ft.map((y, j) => ({ x: par[j], y })),
      borderColor:     c, backgroundColor: c,
      borderWidth: 2, pointRadius: 4, showLine: true,
    });
    // Fm — dashed line + rect points, no legend entry
    datasets.push({
      label:           '',
      data:            sd.fm.map((y, j) => ({ x: par[j], y })),
      borderColor:     c, backgroundColor: 'transparent',
      borderWidth: 2, borderDash: [6, 3], pointRadius: 4, pointStyle: 'rect',
      showLine: true,
    });
  });

  const opts = linearScatterOpts('PAR (µmol photons m⁻² s⁻¹)', 'Fluorescence (a.u.)');
  opts.plugins.legend.labels.filter = item => item.text !== '';
  makeChart('ftfm-chart', { type: 'scatter', data: { datasets }, options: opts });
}

// ── ETR chart ─────────────────────────────────────────────────────────────
function renderEtrChart() {
  const files = lcData.files;
  const par   = lcData.light_intensities;
  const n     = files.length;
  const datasets = [];

  files.forEach((fname, i) => {
    const c  = sampleColor(i, n);
    const sd = lcData.step_data[fname];
    // Measured — scatter points only
    datasets.push({
      label:           fname,
      data:            sd.etr_measured.map((y, j) => ({ x: par[j], y })),
      borderColor:     c, backgroundColor: c,
      borderWidth: 0, pointRadius: 5, showLine: false,
    });
    // Fitted — line only, no legend entry
    datasets.push({
      label:           '',
      data:            sd.etr_fitted.map((y, j) => ({ x: par[j], y })),
      borderColor:     c, backgroundColor: 'transparent',
      borderWidth: 2, pointRadius: 0, showLine: true,
    });
  });

  const opts = linearScatterOpts('PAR (µmol photons m⁻² s⁻¹)', 'rETR (µmol e⁻ m⁻² s⁻¹)');
  opts.plugins.legend.labels.filter = item => item.text !== '';
  makeChart('etr-chart', { type: 'scatter', data: { datasets }, options: opts });
}

// ── derived parameter chart ────────────────────────────────────────────────
function renderDerivedChart(metric) {
  const files   = lcData.files;
  const par     = lcData.light_intensities;
  const n       = files.length;
  const yLabels = { qy: 'QY (r.u.)', npq: 'NPQ', qp: 'qP (r.u.)', qn: 'qN (r.u.)' };

  const datasets = files.map((fname, i) => ({
    label:           fname,
    data:            lcData.step_data[fname][metric].map((y, j) => ({ x: par[j], y })),
    borderColor:     sampleColor(i, n),
    backgroundColor: sampleColor(i, n, 0.2),
    borderWidth: 2, pointRadius: 4, showLine: true,
  }));

  makeChart('derived-chart', {
    type: 'scatter',
    data: { datasets },
    options: linearScatterOpts('PAR (µmol photons m⁻² s⁻¹)', yLabels[metric] || metric),
  });
}

// ── parameters bar chart ──────────────────────────────────────────────────
function renderParamsChart(pgroup) {
  const keys   = LC_PARAM_GROUPS[pgroup] || PARAM_KEYS;
  const files  = lcData.files;
  const labels = keys.map(k => PARAM_LABELS[k] || k);
  const n      = files.length;

  const datasets = files.map((fname, i) => ({
    label:           fname,
    data:            keys.map(k => {
      const v = lcData.params[fname]?.[k];
      return (v != null && isFinite(v)) ? v : null;
    }),
    backgroundColor: sampleColor(i, n, 0.7),
    borderColor:     sampleColor(i, n),
    borderWidth: 1,
  }));

  makeChart('params-chart', { type: 'bar', data: { labels, datasets }, options: barOpts() });
}

// ── parameters table ──────────────────────────────────────────────────────
function renderParamsTable() {
  const files = lcData.files;
  const tbl   = document.getElementById('params-table');
  if (!tbl) return;

  let html = `<thead class="thead-light"><tr><th>Sample</th>${PARAM_KEYS.map(k => `<th>${PARAM_LABELS[k] || k}</th>`).join('')}</tr></thead>`;
  html += '<tbody>';
  for (const fname of files) {
    const p = lcData.params[fname] || {};
    html += `<tr><td>${fname}</td>${PARAM_KEYS.map(k => `<td>${fmt(p[k])}</td>`).join('')}</tr>`;
  }
  html += '</tbody>';
  tbl.innerHTML = html;
}

// ── group assignment ──────────────────────────────────────────────────────
function buildGroupAssignTable() {
  const tbody = document.getElementById('group-assign-body');
  if (!tbody) return;
  tbody.innerHTML = '';
  lcData.files.forEach(fname => {
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

function _onGroupAssignClick(e) {
  if (!e.target.classList.contains('remove-group-btn')) return;
  const fname = e.target.dataset.fname;
  delete groups[fname];
  updateGroupBadge(fname, null);
  refreshGroupSummary(); checkGroupsReady();
}

function assignGroup() {
  const name = document.getElementById('group-name-input').value.trim();
  if (!name) { alert('Please enter a group name.'); return; }
  const checked = [...document.querySelectorAll('.group-check:checked')];
  if (!checked.length) { alert('Please select at least one sample.'); return; }
  checked.forEach(cb => { groups[cb.value] = name; updateGroupBadge(cb.value, name); cb.checked = false; });
  document.getElementById('select-all-check').checked = false;
  refreshGroupSummary(); checkGroupsReady();
}

function clearAllGroups() {
  groups = {};
  lcData.files.forEach(f => updateGroupBadge(f, null));
  refreshGroupSummary();
  document.getElementById('group-results').style.display = 'none';
}

function autoDetectGroups() {
  lcData.files.forEach(fname => {
    const m   = fname.match(/^([a-z_\- ]+)/i);
    const grp = m ? m[1].replace(/[_\- ]+$/, '') : fname;
    groups[fname] = grp; updateGroupBadge(fname, grp);
  });
  refreshGroupSummary(); checkGroupsReady();
}

function sortFiles(order) {
  lcData.files.sort((a, b) => order === 'asc' ? a.localeCompare(b) : b.localeCompare(a));
  const tab = activeTabId();
  renderRawChart();
  if (tab === 'tab-ftfm')    renderFtFmChart();   else markTabsDirty('tab-ftfm');
  if (tab === 'tab-etr')     renderEtrChart();    else markTabsDirty('tab-etr');
  if (tab === 'tab-derived') {
    const m = document.querySelector('#derived-btns .btn-primary')?.dataset?.metric || 'qy';
    renderDerivedChart(m);
  } else markTabsDirty('tab-derived');
  if (tab === 'tab-params') { renderParamsChart('efficiencies'); renderParamsTable(); } else markTabsDirty('tab-params');
  buildGroupAssignTable();
  for (const [f, g] of Object.entries(groups)) updateGroupBadge(f, g);
  refreshGroupSummary(); checkGroupsReady();
}

function updateGroupBadge(fname, grpName) {
  const el = document.getElementById(`gbadge-${esc(fname)}`);
  if (!el) return;
  if (grpName) { el.className = 'badge badge-primary'; el.textContent = grpName; }
  else         { el.className = ''; el.textContent = '—'; }
}

function refreshGroupSummary() {
  const grpMap = {};
  for (const [f, g] of Object.entries(groups)) (grpMap[g] = grpMap[g] || []).push(f);
  const html = Object.entries(grpMap).map(([g, files]) =>
    `<span class="badge badge-light border mr-1"><strong>${g}</strong>: ${files.length} sample(s)</span>`
  ).join('');
  const el = document.getElementById('groups-summary');
  if (el) el.innerHTML = html;
}

function hasGroups() { return new Set(Object.values(groups)).size >= 2; }

function checkGroupsReady() {
  const gr = document.getElementById('group-results');
  if (hasGroups()) {
    if (gr) { gr.style.display = ''; void gr.offsetWidth; }
    if (activeTabId() === 'tab-groups') {
      _applyLcPubAspectRatio();
      _renderAllGroupCharts();
    } else {
      // Make tab pane AND group-results visible before measuring/rendering
      _withPaneVisible('tab-groups', () => {
        const innerGr = document.getElementById('group-results');
        if (innerGr) { innerGr.style.display = ''; void innerGr.offsetWidth; }
        _applyLcPubAspectRatio();   // must run AFTER pane is visible so offsetWidth is real
        _renderAllGroupCharts();
      });
    }
  } else {
    if (gr) gr.style.display = 'none';
    dirtyTabs.delete('tab-groups');
  }
}

// ── group statistics ──────────────────────────────────────────────────────
function calcGroupStats() {
  const grpFiles = {};
  for (const [f, g] of Object.entries(groups)) (grpFiles[g] = grpFiles[g] || []).push(f);

  const st = {};
  for (const [grp, files] of Object.entries(grpFiles)) {
    st[grp] = { files, etr: {}, params: {} };

    // Mean + SD per ETR step (measured)
    const n_steps = lcData.light_intensities.length;
    const etrArrs = files.map(f => lcData.step_data[f].etr_measured);
    const means = [], sds = [];
    for (let j = 0; j < n_steps; j++) {
      const vals = etrArrs.map(a => a[j]).filter(v => v != null && isFinite(v));
      const mu   = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
      const sd   = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / (vals.length || 1));
      means.push(mu); sds.push(sd);
    }
    st[grp].etr = { means, sds };

    // Mean + SD per parameter
    for (const k of PARAM_KEYS) {
      const vals = files.map(f => lcData.params[f]?.[k]).filter(v => v != null && isFinite(v));
      if (!vals.length) continue;
      const mu = vals.reduce((s, v) => s + v, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / vals.length);
      st[grp].params[k] = { mean: mu, sd, n: vals.length };
    }
  }
  return st;
}

// ── group raw fluorescence stats ──────────────────────────────────────────
function calcGroupRawStats() {
  const grpFiles = {};
  for (const [f, g] of Object.entries(groups)) (grpFiles[g] = grpFiles[g] || []).push(f);
  const t_s  = lcData.raw_time_us.map(v => v / 1e6);
  const n_t  = t_s.length;
  const st   = {};
  for (const [grp, files] of Object.entries(grpFiles)) {
    const arrs  = files.map(f => lcData.raw_curves[f] || []);
    const means = [], sds = [];
    for (let j = 0; j < n_t; j++) {
      const vals = arrs.map(a => a[j]).filter(v => v != null && isFinite(v));
      const mu   = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
      const sd   = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / (vals.length || 1));
      means.push(mu); sds.push(sd);
    }
    st[grp] = { files, means, sds };
  }
  return { stats: st, t_s };
}

// ── group raw fluorescence chart ──────────────────────────────────────────
function renderGroupRawChart() {
  const { stats: st, t_s } = calcGroupRawStats();
  const grpNames = Object.keys(st);
  const sdAlpha  = lcPub.sdBandOpacity / 100;
  const norm     = lcRawGrpNorm === 'normalized';
  const yLabel   = norm ? 'F / F(ref)' : 'Fluorescence intensity (a.u.)';
  const datasets = [];

  grpNames.forEach((grp, gi) => {
    const { means, sds, files } = st[grp];
    const c   = _lcPubColor(gi, grpNames.length);
    const ca  = _lcPubColor(gi, grpNames.length, sdAlpha);
    const off = gi * lcRawGrpJitter;

    const normMeans = norm ? normalizeTraceArr(means, t_s, lcRawGrpNormTime) : means;
    const normSds   = norm
      ? (function() {
          const refIdx = t_s.reduce((best, t, j) =>
            Math.abs(t - lcRawGrpNormTime) < Math.abs(t_s[best] - lcRawGrpNormTime) ? j : best, 0);
          const refVal = means[refIdx] || 1;
          return sds.map(s => s / refVal);
        })()
      : sds;

    // Upper SD band
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: normMeans.map((m, j) => ({ x: t_s[j] + off, y: m + normSds[j] })),
      fill: '+1',
    });
    // Lower SD band
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: normMeans.map((m, j) => ({ x: t_s[j] + off, y: m - normSds[j] })),
      fill: false,
    });
    // Mean line
    datasets.push({
      label: grp, showLine: true, pointRadius: 0, borderWidth: lcPub.lineWidthMean,
      borderColor: c, backgroundColor: c,
      data: normMeans.map((m, j) => ({ x: t_s[j] + off, y: m })),
      fill: false,
    });
    // Individual raw traces
    files.forEach(fname => {
      const raw  = lcData.raw_curves[fname] || [];
      const vals = norm ? normalizeTraceArr(raw, t_s, lcRawGrpNormTime) : raw;
      datasets.push({
        label: fname.replace(/\.[^.]+$/, ''), showLine: true, pointRadius: 0, borderWidth: lcPub.lineWidthIndiv,
        borderColor: _lcPubColor(gi, grpNames.length, 0.4), backgroundColor: 'transparent',
        data: vals.map((y, j) => ({ x: t_s[j] + off, y })),
        fill: false,
        hidden: !showIndivRaw,
        _isIndividual: true,
      });
    });
  });

  const opts = linearScatterOpts('Time (s)', yLabel);
  opts.plugins.legend.labels.filter = (item, data) =>
    item.text !== '' && !data.datasets[item.datasetIndex]?._isIndividual;
  _applyLcPubToOpts(opts, false, null);
  makeChart('group-raw-chart', { type: 'scatter', data: { datasets }, options: opts, plugins: [_lcPubBgPlugin(), _lcPubBorderPlugin()] });
}

// ── group ETR chart ───────────────────────────────────────────────────────
function renderGroupEtrChart() {
  const stats    = calcGroupStats();
  const grpNames = Object.keys(stats);
  const par      = lcData.light_intensities;
  const sdAlpha  = lcPub.sdBandOpacity / 100;
  const datasets = [];

  grpNames.forEach((grp, gi) => {
    const { means, sds } = stats[grp].etr;
    const c   = _lcPubColor(gi, grpNames.length);
    const ca  = _lcPubColor(gi, grpNames.length, sdAlpha);
    const off = gi * lcEtrJitter;

    // Upper SD band
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map((m, j) => ({ x: par[j] + off, y: m + sds[j] })),
      fill: '+1',
    });
    // Lower SD band
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map((m, j) => ({ x: par[j] + off, y: m - sds[j] })),
      fill: false,
    });
    // Mean line
    datasets.push({
      label: grp, showLine: true, pointRadius: 4, borderWidth: lcPub.lineWidthMean,
      borderColor: c, backgroundColor: c,
      data: means.map((m, j) => ({ x: par[j] + off, y: m })),
      fill: false,
    });
    // Individual fitted curves (thin, semi-transparent)
    stats[grp].files.forEach(fname => {
      datasets.push({
        label: fname.replace(/\.[^.]+$/, ''), showLine: true, pointRadius: 0, borderWidth: lcPub.lineWidthIndiv,
        borderColor: _lcPubColor(gi, grpNames.length, 0.4), backgroundColor: 'transparent',
        data: lcData.step_data[fname].etr_fitted.map((y, j) => ({ x: par[j] + off, y })),
        fill: false,
        hidden: !showIndivTraces,
        _isIndividual: true,
      });
    });
  });

  const pc   = lcPc.groupEtr;
  const opts = linearScatterOpts(
    pc.xTitle || 'PAR (µmol photons m⁻² s⁻¹)',
    pc.yTitle || 'rETR (µmol e⁻ m⁻² s⁻¹)'
  );
  if (pc.yStartZero) opts.scales.y.min = 0;
  opts.plugins.legend.labels.filter = (item, data) =>
    item.text !== '' && !data.datasets[item.datasetIndex]?._isIndividual;
  _applyLcPubToOpts(opts, false, null);
  makeChart('group-etr-chart', { type: 'scatter', data: { datasets }, options: opts, plugins: [_lcPubBgPlugin(), _lcPubBorderPlugin()] });
}

// ── group params charts (error bars, one canvas per parameter) ───────────
function renderGroupParamsCharts() {
  PARAM_KEYS.forEach(k => renderGroupParamChart(k));
}

function renderGroupParamChart(key) {
  const canvasId = 'group-params-' + _lcKeyToId(key) + '-chart';
  if (!document.getElementById(canvasId)) return;

  const stats    = calcGroupStats();
  const grpNames = Object.keys(stats);
  const label    = PARAM_LABELS[key] || key;

  const datasets = grpNames.map((grp, gi) => {
    const s = stats[grp].params[key];
    const c = _lcPubColor(gi, grpNames.length);
    return {
      label: grp,
      data: [s ? { y: s.mean, yMin: s.mean - s.sd, yMax: s.mean + s.sd } : { y: NaN, yMin: NaN, yMax: NaN }],
      backgroundColor: _lcPubColor(gi, grpNames.length, 0.65),
      borderColor:     c,
      borderWidth: 1,
      errorBarColor:        c,
      errorBarWhiskerColor: c,
      errorBarLineWidth: 2,
      errorBarWhiskerSize: 8,
    };
  });

  const opts = barOpts(label);
  _applyLcPubToOpts(opts, true, null);
  makeChart(canvasId, {
    type: 'barWithErrorBars',
    data: { labels: [label], datasets },
    options: opts,
    plugins: [_lcPubBgPlugin(), _lcPubBorderPlugin()],
  });
}

// ── export to statistics page ─────────────────────────────────────────────
// Uses sessionStorage key 'ojip_export' to match the existing statistics page reader.
// source field is set to 'Light Curves' so the statistics page can display the origin.
function exportToStatistics() {
  const assignedFiles = lcData.files.filter(f => groups[f]);
  if (!assignedFiles.length) { alert('No files assigned to groups.'); return; }

  const header = ['Group', 'Sample', ...PARAM_KEYS.map(k => PARAM_LABELS[k] || k)].join('\t');
  const rows   = assignedFiles.map(fname => {
    const vals = PARAM_KEYS.map(k => {
      const v = lcData.params[fname]?.[k];
      return (v != null && isFinite(v)) ? v.toFixed(6) : '';
    });
    return [groups[fname], fname, ...vals].join('\t');
  });

  sessionStorage.setItem('ojip_export', JSON.stringify({
    tsv:    [header, ...rows].join('\n'),
    source: 'Light Curves',
  }));
  window.open('/statistics', '_blank');
}

// ── canvas capture ────────────────────────────────────────────────────────
const MAX_CHART_PX = 1200;
function _chartToDataUrl(canvas) {
  let w = canvas.width, h = canvas.height;
  if (w > MAX_CHART_PX) { h = Math.round(h * MAX_CHART_PX / w); w = MAX_CHART_PX; }
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  return tmp.toDataURL('image/jpeg', 0.88);
}

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
  return (data_url && data_url.includes(',') && data_url.split(',')[1]) ? data_url : null;
}

// ── download summary xlsx (server-side, with chart images) ────────────────
async function downloadXlsxWithCharts() {
  const link = document.getElementById('xlsx-summary-link');
  link.style.pointerEvents = 'none';
  link.innerHTML = '<span class="spinner-border spinner-border-sm mr-1"></span> Embedding charts…';

  // Ensure all hidden charts are rendered before capture
  _withPaneVisible('tab-ftfm',    renderFtFmChart);
  _withPaneVisible('tab-etr',     renderEtrChart);
  _withPaneVisible('tab-derived', () => {
    const m = document.querySelector('#derived-btns .btn-primary')?.dataset?.metric || 'qy';
    renderDerivedChart(m);
  });
  _withPaneVisible('tab-params',  () => { renderParamsChart('efficiencies'); renderParamsTable(); });
  if (hasGroups()) {
    _withPaneVisible('tab-groups', () => {
      const gr = document.getElementById('group-results');
      if (gr) { gr.style.display = ''; void gr.offsetWidth; }
      _renderAllGroupCharts();
    });
  }

  const charts = [];
  const caps = [
    { id: 'raw-chart',       title: 'Raw Fluorescence' },
    { id: 'ftfm-chart',      title: 'Ft and Fm' },
    { id: 'etr-chart',       title: 'ETR Curves' },
    { id: 'derived-chart',   title: 'Derived Parameters' },
    { id: 'params-chart',    title: 'Parameters' },
    { id: 'group-raw-chart', title: 'Group Fluorescence' },
    { id: 'group-etr-chart', title: 'Group ETR Curves' },
  ];
  for (const { id, title } of caps) {
    const du = captureCanvas(id);
    if (du) charts.push({ title, data_url: du });
  }
  // Per-key group param charts
  if (hasGroups()) {
    PARAM_KEYS.forEach(k => {
      const du = captureCanvas('group-params-' + _lcKeyToId(k) + '-chart');
      if (du) charts.push({ title: 'Group ' + (PARAM_LABELS[k] || k), data_url: du });
    });
  }
  // Group export data
  let group_export = null;
  if (hasGroups()) {
    const stats = calcGroupStats();
    const grp_stats = {};
    for (const [grp, s] of Object.entries(stats)) {
      grp_stats[grp] = {
        files: s.files,
        params: Object.fromEntries(
          Object.entries(s.params).map(([k, v]) => [k, { mean: v.mean, sd: v.sd, n: v.n }])
        ),
      };
    }
    const samples = lcData.files
      .filter(f => groups[f])
      .map(fname => {
        const row = { sample: fname, group: groups[fname] };
        for (const k of PARAM_KEYS) {
          const v = lcData.params[fname]?.[k];
          row[k] = (v != null && isFinite(v)) ? v : null;
        }
        return row;
      });
    group_export = {
      stats:        grp_stats,
      samples,
      param_order:  PARAM_KEYS,
      param_labels: PARAM_LABELS,
    };
  }

  const payload = JSON.stringify({
    file_stem:          lcData.file_stem,
    files:              lcData.files,
    step_data:          lcData.step_data,
    params:             lcData.params,
    raw_curves:         lcData.raw_curves,
    light_intensities:  lcData.light_intensities,
    raw_time_us:        lcData.raw_time_us,
    charts,
    group_export,
    methods_text:       generateLCMethodsText(),
  });

  const payloadSize = new Blob([payload]).size;
  const payloadMB   = (payloadSize / 1024 / 1024).toFixed(2);
  if (payloadSize > 80 * 1024 * 1024) {
    alert(`Export failed: chart image data is ${payloadMB} MB, which exceeds the server limit.\nTry reducing browser zoom level and re-exporting.`);
    link.style.pointerEvents = '';
    link.innerHTML = '<i class="fa fa-file-excel-o"></i> Download summary .xlsx';
    return;
  }

  try {
    const resp = await fetch('/api/lc_export', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    payload,
    });
    if (resp.status === 413) {
      alert('Export failed: chart image data is too large for the server.');
      return;
    }
    const rawText = await resp.text();
    let result;
    try { result = JSON.parse(rawText); }
    catch (_) {
      alert(`Export failed (HTTP ${resp.status}): unexpected server response.\n\n` + rawText.slice(0, 300));
      return;
    }
    if (result.status === 'error') throw new Error(result.message);
    const dlA  = document.createElement('a');
    dlA.href     = '/static/' + result.xlsx_path;
    dlA.download = (lcData.file_stem || 'LC') + '_analysis.xlsx';
    dlA.click();
  } catch (err) {
    alert('Export failed: ' + err.message);
  } finally {
    link.style.pointerEvents = '';
    link.innerHTML = '<i class="fa fa-download"></i> Download .xlsx';
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
function showLCMethodsModal() {
    if (!lcData) { alert('Please analyze data first.'); return; }
    var ta = document.getElementById('lc-methods-text-area');
    if (ta) ta.value = generateLCMethodsText();
    $('#lc-methods-modal').modal('show');
}

function copyLCMethodsText() {
    var ta = document.getElementById('lc-methods-text-area');
    if (!ta) return;
    ta.select();
    var btn = document.getElementById('lc-methods-copy-btn');
    navigator.clipboard.writeText(ta.value).then(function() {
        if (!btn) return;
        var o = btn.innerHTML;
        btn.innerHTML = '<i class="fa fa-check mr-1"></i> Copied!';
        setTimeout(function() { btn.innerHTML = o; }, 1800);
    }).catch(function() { document.execCommand('copy'); });
}

function generateLCMethodsText() {
    var protoEl = document.querySelector('input[name="lc_protocol"]:checked');
    var proto = protoEl ? protoEl.value : 'LC3';

    var protoDesc = {
        LC1: 'LC\u202fprotocol\u202f1 (6 PAR steps: 10, 20, 50, 100, 300, 500\u202f\u00b5mol\u202fphotons\u202fm\u207b\u00b2\u202fs\u207b\u00b9)',
        LC2: 'LC\u202fprotocol\u202f2 (5 PAR steps: 100, 200, 300, 500, 1000\u202f\u00b5mol\u202fphotons\u202fm\u207b\u00b2\u202fs\u207b\u00b9)',
        LC3: 'LC\u202fprotocol\u202f3 (7 PAR steps: 10, 20, 50, 100, 300, 500, 1000\u202f\u00b5mol\u202fphotons\u202fm\u207b\u00b2\u202fs\u207b\u00b9)'
    }[proto] || proto;

    var etrFactor = (document.getElementById('etr_max_factor') || {}).value || '10';

    var files = lcData.files || [];
    var n = files.length;
    var fList = n <= 8 ? files.join(', ') : n + ' files';

    var pars = lcData.light_intensities || [];
    var parStr = pars.length
        ? pars.join(', ') + '\u202f\u00b5mol\u202fphotons\u202fm\u207b\u00b2\u202fs\u207b\u00b9'
        : 'multiple PAR steps';

    var gnames = Object.values(groups).filter(Boolean)
        .filter(function(v, i, a) { return a.indexOf(v) === i; });

    var lines = [];

    lines.push(
        'Rapid light curves (photosynthesis-irradiance curves) were measured using an AquaPen/FluorPen ' +
        'fluorometer (Photon Systems Instruments) following ' + protoDesc + '. ' +
        'Data were analyzed using the Rapid Light Curve Analyzer module of CyanoTools ' +
        '(https://tools-py.e-cyanobacterium.org/light_curves_analysis). ' +
        'A total of ' + n + ' light curve' + (n !== 1 ? 's were' : ' was') + ' processed (' + fList + ').'
    );

    lines.push(
        'At each irradiance step (' + parStr + '), the effective quantum yield of PSII ' +
        '(Qy\u202f=\u202f(Fm\u2032\u202f\u2212\u202fFt)\u202f/\u202fFm\u2032) and the relative electron transport rate ' +
        '(rETR\u202f=\u202fQy\u202f\u00d7\u202fPAR) were calculated. Non-photochemical quenching ' +
        '(NPQ\u202f=\u202f(Fm\u2032max\u202f\u2212\u202fFm\u2032)\u202f/\u202fFm\u2032) and the photochemical quenching ' +
        'coefficient (qP\u202f=\u202f(Fm\u2032\u202f\u2212\u202fFt)\u202f/\u202f(Fm\u2032\u202f\u2212\u202fFO\u2032)) ' +
        'were also derived at each step.'
    );

    lines.push(
        'The rETR\u202fvs.\u202fPAR relationship was fitted to the Platt et al. (1980) model: ' +
        'rETR\u202f=\u202frETRmPot\u202f\u00d7\u202f(1\u202f\u2212\u202fexp(\u2212\u03b1\u202f\u00d7\u202fPAR\u202f' +
        '/\u202frETRmPot))\u202f\u00d7\u202fexp(\u2212\u03b2\u202f\u00d7\u202fPAR\u202f/\u202frETRmPot), ' +
        'with the upper ETRmPot boundary set to ETRmax,measured\u202f\u00d7\u202f' + etrFactor + '. ' +
        'Fitted parameters: initial slope \u03b1 (photosynthetic efficiency under limiting light), ' +
        'photoinhibition coefficient \u03b2, maximum potential rate ETRmPot, maximum rate ' +
        'ETRmax\u202f=\u202fETRmPot\u202f\u00d7\u202f(\u03b1\u202f/\u202f(\u03b1\u202f+\u202f\u03b2))\u202f\u00d7\u202f' +
        '(\u03b2\u202f/\u202f(\u03b1\u202f+\u202f\u03b2))^(\u03b2/\u03b1), saturation irradiance ' +
        'Ik\u202f=\u202fETRmax\u202f/\u202f\u03b1, and photoinhibition irradiance Ib\u202f=\u202fETRmax\u202f/\u202f\u03b2 ' +
        '(Ralph\u202f&\u202fGademann, 2005).'
    );

    if (gnames.length >= 2) {
        lines.push(
            'Samples were organized into ' + gnames.length + ' experimental group' +
            (gnames.length !== 1 ? 's' : '') + ' (' + gnames.join(', ') + '). ' +
            'Group means\u202f\u00b1\u202fstandard deviations were calculated for all derived parameters.'
        );
    }

    return lines.join('\n\n');
}
