// ============================================================
//  CyanoTools OJIP Analyzer — frontend logic
//  Chart.js 4.x + chartjs-chart-error-bars
// ============================================================

// ── state ─────────────────────────────────────────────────────────────────
let ojipData  = null;   // full JSON from /api/ojip_process
let paramData = {};     // {filename: {FVFM, VJ, ...}} — recalculated per sample
let groups    = {};     // {filename: groupName}
let chartInst = {};     // {chartId: Chart instance}
let dirtyTabs = new Set(); // tabs whose charts need rendering on first visit

// ── parameter metadata ────────────────────────────────────────────────────
const PARAM_GROUPS = {
  yields: ['FVFM', 'VJ', 'VI', 'M0', 'PSIE0', 'PSIR0', 'DELTAR0', 'PHIE0', 'PHIR0'],
  fluxes: ['ABSRC', 'TR0RC', 'ET0RC', 'RE0RC', 'DI0RC'],
  areas:  ['Area_OJ', 'Area_JI', 'Area_IP', 'Area_OP', 'SM', 'N'],
  tech:   ['F0', 'FM', 'FK', 'FJ', 'FI', 'FV', 'OJ', 'JI', 'IP'],
};
const PARAM_LABELS = {
  FVFM:'Fv/Fm (φP₀)', VJ:'VJ', VI:'VI', M0:'M₀', PSIE0:'ψE₀', PSIR0:'ψR₀',
  DELTAR0:'δR₀', PHIE0:'φE₀', PHIR0:'φR₀',
  ABSRC:'ABS/RC', TR0RC:'TR₀/RC', ET0RC:'ET₀/RC', RE0RC:'RE₀/RC', DI0RC:'DI₀/RC',
  Area_OJ:'Area O-J', Area_JI:'Area J-I', Area_IP:'Area I-P', Area_OP:'Area O-P',
  SM:'Sm', N:'N (QA turnover)',
  F0:'F₀', FM:'FM', FK:'FK', FJ:'FJ', FI:'FI', FV:'FV', OJ:'A(O-J)', JI:'A(J-I)', IP:'A(I-P)',
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
  if (tabId === 'tab-params') {
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
  sel.addEventListener('change', () => localStorage.setItem('ojip_fluorometer', sel.value));

  // Drop-zone behaviour
  const dz   = document.getElementById('drop-zone');
  const finp = document.getElementById('ojip-files');
  dz.addEventListener('click', () => finp.click());
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.style.background = '#e8f4fd'; });
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

  // Reset FJ/FI timings (both tabs share the same handler)
  document.getElementById('reset-fj-fi-btn').addEventListener('click', resetFJFI);
  document.getElementById('reset-fj-fi-btn-curves').addEventListener('click', resetFJFI);

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

  // Polynomial FJ/FI apply buttons
  document.getElementById('use-poly-fj-btn').addEventListener('click', usePolyFJ);
  document.getElementById('use-poly-fi-btn').addEventListener('click', usePolyFI);

  // Diagnostics kr slider
  const krSlider = document.getElementById('kr-slider');
  const krDisp   = document.getElementById('kr-display');
  krSlider.addEventListener('input', () => { krDisp.textContent = krSlider.value; });
  document.getElementById('refit-btn').addEventListener('click', refitSplines);

  // Delegated listeners that must survive table rebuilds
  document.getElementById('fjtable').addEventListener('change', _onFJTableChange);
  document.getElementById('group-assign-table').addEventListener('click', _onGroupAssignClick);

  // Sync pub settings panel from saved state
  syncDomFromOjipPub();

  // On tab open: re-render if dirty (data changed while tab was hidden),
  // then resize so Chart.js picks up the now-visible canvas dimensions.
  document.getElementById('ojipTabs').addEventListener('shown.bs.tab', e => {
    if (!ojipData) return;
    const tabId = (e.target.getAttribute('href') || '').slice(1);
    renderDirtyTab(tabId); // no-op when not dirty
    if (tabId === 'tab-params') {
      chartInst['params-chart']?.resize();
    } else if (tabId === 'tab-diag') {
      ['diag-recon-chart', 'diag-resid-chart', 'diag-d2-chart', 'diag-poly-chart', 'diag-poly-fi-chart']
        .forEach(id => chartInst[id]?.resize());
    } else if (tabId === 'tab-groups') {
      ['grp-curves-raw-chart','grp-curves-f0-chart','grp-curves-fm-chart','grp-curves-dn-chart',
       'grp-params-yields-chart','grp-params-fluxes-chart','grp-params-areas-chart','grp-params-tech-chart']
        .forEach(id => chartInst[id]?.resize());
      _applyOjipPubAspectRatio();
    }
  });
});

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

  const fd = new FormData();
  for (const f of files) fd.append('OJIP_files', f);
  fd.append('fluorometer', document.getElementById('fluorometer').value);
  fd.append('FJ_time',     document.getElementById('FJ_time').value);
  fd.append('FI_time',     document.getElementById('FI_time').value);
  fd.append('knots_reduction_factor', document.getElementById('kr_input').value);
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
    recalcAllParams();
    document.getElementById('results-section').style.display = '';
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

// ── render all results ────────────────────────────────────────────────────
function renderResults() {
  const n = ojipData.files.length;
  document.getElementById('results-summary').textContent =
    `${n} file${n > 1 ? 's' : ''} processed — ${ojipData.fluorometer} — FJ ${ojipData.fj_time_ms} ms / FI ${ojipData.fi_time_ms} ms`;

  // Summary xlsx — Parameters + normalized curves + charts (compact)
  const link = document.getElementById('xlsx-download-link');
  link.href = '#';
  link.onclick = e => { e.preventDefault(); downloadXlsxWithCharts(); };
  link.style.display = '';

  // Full data xlsx — built client-side on demand via SheetJS
  const rawLink = document.getElementById('xlsx-rawdata-link');
  rawLink.href = '#';
  rawLink.onclick = e => { e.preventDefault(); downloadFullData(); };
  rawLink.style.display = '';

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
  datasets.push({
    label: 'FJ', showLine: false,
    data: files.map(fname => ({
      x: ojipData.key_values[fname].FJ_time_user_ms,
      y: interpAt(t, ojipData.curves[fname][norm], ojipData.key_values[fname].FJ_time_user_ms),
    })),
    pointRadius:          6,
    pointStyle:           'triangle',
    pointBackgroundColor: files.map((_, i) => sampleColor(i, n)),
    pointBorderColor:     files.map((_, i) => sampleColor(i, n)),
    borderColor: 'transparent', backgroundColor: 'transparent',
  });

  // FI markers (◆ diamonds) — same colours
  datasets.push({
    label: 'FI', showLine: false,
    data: files.map(fname => ({
      x: ojipData.key_values[fname].FI_time_user_ms,
      y: interpAt(t, ojipData.curves[fname][norm], ojipData.key_values[fname].FI_time_user_ms),
    })),
    pointRadius:          6,
    pointStyle:           'rectRot',
    pointBackgroundColor: files.map((_, i) => sampleColor(i, n)),
    pointBorderColor:     files.map((_, i) => sampleColor(i, n)),
    borderColor: 'transparent', backgroundColor: 'transparent',
  });

  const yLabel = norm === 'raw' ? 'Fluorescence' :
                 norm === 'double_norm' ? 'Normalised fluorescence (r.u.)' :
                 'Fluorescence (shifted)';

  const opts = logScatterOpts('Time (ms)', yLabel);
  opts.onClick = (e, elements) => {
    if (!elements.length) return;
    const dsIdx = elements[0].datasetIndex;
    if (dsIdx >= n) return;                    // FJ / FI marker row — ignore
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
      <td class="fj-auto">${fmt(kv.FJ_time_inflect_ms ?? kv.FJ_time_deriv_ms)}</td>
      <td class="fi-auto">${fmt(kv.FI_time_inflect_ms ?? kv.FI_time_deriv_ms)}</td>
      <td class="fp-auto">${fmt(kv.FP_time_inflect_ms ?? kv.FP_time_deriv_ms)}</td>
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
function renderDiagnostics() {
  renderDiagRecon(); renderDiagResid(); renderDiagD2(); renderDiagPoly(); renderDiagPolyFI();
}

function renderDiagRecon() {
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
      data: ojipData.curves[fname].double_norm.map((y, j) => ({ x: tRaw[j], y })) });
    // reconstructed curve (dashed)
    datasets.push({ label: '', showLine: true, pointRadius: 0, borderWidth: 1.2,
      borderColor: c, borderDash: [4, 3], backgroundColor: 'transparent',
      data: ojipData.curves[fname].reconstructed.map((y, j) => ({ x: tLog[j], y })) });
    // FJ (▲) and FI (◆) on the reconstructed curve
    const fjY = interpAt(tLog, ojipData.curves[fname].reconstructed, kv.FJ_time_user_ms);
    const fiY = interpAt(tLog, ojipData.curves[fname].reconstructed, kv.FI_time_user_ms);
    datasets.push({ label: '', showLine: false,
      data: [{ x: kv.FJ_time_user_ms, y: fjY }, { x: kv.FI_time_user_ms, y: fiY }],
      pointRadius: [6, 6], pointStyle: ['triangle', 'rectRot'],
      pointBackgroundColor: [c, c], pointBorderColor: [c, c],
      borderColor: 'transparent', backgroundColor: 'transparent' });
  });
  makeChart('diag-recon-chart', { type: 'scatter', data: { datasets },
    options: logScatterOpts('Time (ms)', 'Double normalised') });
}

function renderDiagResid() {
  const files = ojipData.files;
  const t     = ojipData.time_raw_ms;
  const datasets = files.map((fname, i) => ({
    label: fname, showLine: true, pointRadius: 0, borderWidth: 1.2,
    borderColor: sampleColor(i, files.length), backgroundColor: 'transparent',
    data: ojipData.curves[fname].residuals.map((y, j) => ({ x: t[j], y })),
  }));
  makeChart('diag-resid-chart', { type: 'scatter', data: { datasets },
    options: logScatterOpts('Time (ms)', 'Residuals (r.u.)') });
}

function renderDiagD2() {
  const files = ojipData.files;
  const t     = ojipData.time_log_ms;
  const n     = files.length;
  const datasets = [];
  files.forEach((fname, i) => {
    const kv = ojipData.key_values[fname];
    const c  = sampleColor(i, n);
    // d2 curve
    datasets.push({ label: fname, showLine: true, pointRadius: 0, borderWidth: 1.2,
      borderColor: c, backgroundColor: 'transparent',
      data: ojipData.curves[fname].d2.map((y, j) => ({ x: t[j], y })) });
    // FJ (▲) and FI (◆) at their positions on the d2 curve
    const fjY = interpAt(t, ojipData.curves[fname].d2, kv.FJ_time_user_ms);
    const fiY = interpAt(t, ojipData.curves[fname].d2, kv.FI_time_user_ms);
    datasets.push({ label: '', showLine: false,
      data: [{ x: kv.FJ_time_user_ms, y: fjY }, { x: kv.FI_time_user_ms, y: fiY }],
      pointRadius: [6, 6], pointStyle: ['triangle', 'rectRot'],
      pointBackgroundColor: [c, c], pointBorderColor: [c, c],
      borderColor: 'transparent', backgroundColor: 'transparent' });
  });
  makeChart('diag-d2-chart', { type: 'scatter', data: { datasets },
    options: logScatterOpts('Time (ms)', '2nd derivative') });
}

function renderDiagPoly() {
  const files = ojipData.files;
  const n     = files.length;
  const datasets = [];

  // Zero reference line spanning the full O-J window
  const firstOJTime = ojipData.curves[files[0]]?.poly_oj_time_ms;
  if (firstOJTime?.length) {
    datasets.push({
      label: '',
      showLine: true, pointRadius: 0, borderWidth: 1,
      borderColor: 'rgba(0,0,0,0.25)', borderDash: [4, 4], backgroundColor: 'transparent',
      data: [{ x: firstOJTime[0], y: 0 }, { x: firstOJTime[firstOJTime.length - 1], y: 0 }],
    });
  }

  files.forEach((fname, i) => {
    const kv      = ojipData.key_values[fname];
    const c       = sampleColor(i, n);
    const ojTime  = ojipData.curves[fname].poly_oj_time_ms;
    const ojD2    = ojipData.curves[fname].poly_oj_d2;
    if (!ojTime?.length) return;

    // 2nd derivative of 9th-degree polynomial fit (O-J window)
    datasets.push({
      label: fname,
      showLine: true, pointRadius: 0, borderWidth: 1.5,
      borderColor: c, backgroundColor: 'transparent',
      data: ojTime.map((t, j) => ({ x: t, y: ojD2[j] })),
    });

    // Inflection points (▲) at y = 0, x = inflection time
    const inflTimes = kv.poly_infl_ms || [];
    if (inflTimes.length) {
      datasets.push({
        label: '',
        showLine: false,
        data: inflTimes.map(t => ({ x: t, y: 0 })),
        pointRadius: 8,
        pointStyle: 'triangle',
        pointBackgroundColor: c,
        pointBorderColor: c,
        borderColor: 'transparent', backgroundColor: 'transparent',
      });
    }
  });

  const opts = logScatterOpts('Time (ms)', '2nd derivative of poly fit (O-J window)');
  makeChart('diag-poly-chart', { type: 'scatter', data: { datasets }, options: opts });
}

function renderDiagPolyFI() {
  const files = ojipData.files;
  const n     = files.length;
  const datasets = [];

  const firstTime = ojipData.curves[files[0]]?.poly_oi_time_ms;
  if (firstTime?.length) {
    datasets.push({
      label: '',
      showLine: true, pointRadius: 0, borderWidth: 1,
      borderColor: 'rgba(0,0,0,0.25)', borderDash: [4, 4], backgroundColor: 'transparent',
      data: [{ x: firstTime[0], y: 0 }, { x: firstTime[firstTime.length - 1], y: 0 }],
    });
  }

  files.forEach((fname, i) => {
    const kv     = ojipData.key_values[fname];
    const c      = sampleColor(i, n);
    const oiTime = ojipData.curves[fname].poly_oi_time_ms;
    const oiD2   = ojipData.curves[fname].poly_oi_d2;
    if (!oiTime?.length) return;

    datasets.push({
      label: fname,
      showLine: true, pointRadius: 0, borderWidth: 1.5,
      borderColor: c, backgroundColor: 'transparent',
      data: oiTime.map((t, j) => ({ x: t, y: oiD2[j] })),
    });

    const inflTimes = kv.poly_fi_infl_ms || [];
    if (inflTimes.length) {
      datasets.push({
        label: '',
        showLine: false,
        data: inflTimes.map(t => ({ x: t, y: 0 })),
        pointRadius: 8, pointStyle: 'triangle',
        pointBackgroundColor: c, pointBorderColor: c,
        borderColor: 'transparent', backgroundColor: 'transparent',
      });
    }
  });

  const opts = logScatterOpts('Time (ms)', '2nd derivative of poly fit (J-I window)');
  makeChart('diag-poly-fi-chart', { type: 'scatter', data: { datasets }, options: opts });
}

// ── reset FJ / FI to default timings ─────────────────────────────────────
function resetFJFI() {
  const fjMs = 2.0;
  const fiMs = 30.0;
  for (const fname of ojipData.files) {
    const newKv = recalcKeyValues(fname, fjMs, fiMs);
    ojipData.key_values[fname] = newKv;
    paramData[fname] = calcJIP(newKv);
  }
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

function usePolyFJ() {
  let applied = 0;
  for (const fname of ojipData.files) {
    const inflTimes = ojipData.key_values[fname].poly_infl_ms || [];
    if (!inflTimes.length) continue;
    const fjMs = inflTimes.reduce((a, b) => Math.abs(a - 2) < Math.abs(b - 2) ? a : b);
    const fiMs = ojipData.key_values[fname].FI_time_user_ms;
    if (fjMs < fiMs) {
      const newKv = recalcKeyValues(fname, fjMs, fiMs);
      ojipData.key_values[fname] = newKv;
      paramData[fname] = calcJIP(newKv);
      applied++;
    }
  }
  if (!applied) { alert('No polynomial FJ inflection points found.'); return; }
  _refreshAfterTimingChange();
}

function usePolyFI() {
  let applied = 0;
  for (const fname of ojipData.files) {
    const inflTimes = ojipData.key_values[fname].poly_fi_infl_ms || [];
    if (!inflTimes.length) continue;
    const fiMs = inflTimes.reduce((a, b) => Math.abs(a - 30) < Math.abs(b - 30) ? a : b);
    const fjMs = ojipData.key_values[fname].FJ_time_user_ms;
    if (fiMs > fjMs) {
      const newKv = recalcKeyValues(fname, fjMs, fiMs);
      ojipData.key_values[fname] = newKv;
      paramData[fname] = calcJIP(newKv);
      applied++;
    }
  }
  if (!applied) { alert('No polynomial FI inflection points found.'); return; }
  _refreshAfterTimingChange();
}

// ── spline refit ──────────────────────────────────────────────────────────
async function refitSplines() {
  const kr     = parseInt(document.getElementById('kr-slider').value);
  const status = document.getElementById('refit-status');
  status.textContent = 'Refitting…';
  document.getElementById('refit-btn').disabled = true;

  const double_norm = {};
  for (const fname of ojipData.files) double_norm[fname] = ojipData.curves[fname].double_norm;

  try {
    const resp = await fetch('/api/ojip_refit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fluorometer: ojipData.fluorometer,
        kr,
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
    ojipData.kr = kr;
    document.getElementById('kr_input').value = kr;
    document.getElementById('kr-display').textContent = kr;

    renderDiagnostics();
    status.textContent = `Refit done (kr = ${kr})`;
    setTimeout(() => status.textContent = '', 3000);
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
    { id: 'diag-poly-chart',    title: 'FJ Polynomial Derivatives' },
    { id: 'diag-poly-fi-chart', title: 'FI Polynomial Derivatives' },
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
    for (const [bodyId, chartId, title] of [
      ['grp-raw-body', 'grp-curves-raw-chart', 'Group Curves — Raw'],
      ['grp-f0-body',  'grp-curves-f0-chart',  'Group Curves — →F₀'],
      ['grp-fm-body',  'grp-curves-fm-chart',  'Group Curves — ←FM'],
      [null,           'grp-curves-dn-chart',  'Group Curves — Double norm'],
    ]) {
      const body = bodyId && document.getElementById(bodyId);
      const bodyWasHidden = body && getComputedStyle(body).display === 'none';
      if (bodyWasHidden) { body.style.display='block'; body.style.visibility='hidden'; void body.offsetWidth; }
      chartInst[chartId]?.resize();
      const data_url = captureCanvas(chartId);
      if (data_url) charts.push({ title, data_url });
      if (bodyWasHidden) { body.style.display=''; body.style.visibility=''; }
    }
    // Parameter bar charts
    for (const [chartId, title] of [
      ['grp-params-yields-chart', 'Group Parameters — Quantum yields'],
      ['grp-params-fluxes-chart', 'Group Parameters — Energy fluxes'],
      ['grp-params-areas-chart',  'Group Parameters — Areas & indices'],
      ['grp-params-tech-chart',   'Group Parameters — Technical'],
    ]) {
      chartInst[chartId]?.resize();
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

  // Pre-flight: check JSON payload size before sending (same issue as file upload —
  // server closes connection on oversize, browser sees NetworkError not 413).
  const payload    = JSON.stringify({ file_stem: ojipData.file_stem, charts, group_export, params_table });
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
    const xlsxResp  = await fetch('/static/' + result.xlsx_path);
    const xlsxBytes = await xlsxResp.arrayBuffer();
    const zip = new JSZip();
    zip.file((ojipData.file_stem || 'OJIP') + '_analysis.xlsx', xlsxBytes);
    zip.file('Methods_section.html', _buildMethodsHtml('OJIP Analyzer', generateOJIPMethodsText()));
    const blob = await zip.generateAsync({ type: 'blob' });
    const dlA  = document.createElement('a');
    dlA.href     = URL.createObjectURL(blob);
    dlA.download = (ojipData.file_stem || 'OJIP') + '_analysis.zip';
    dlA.click();
    setTimeout(function() { URL.revokeObjectURL(dlA.href); }, 1000);
  } catch (err) {
    console.error('[OJIP export] fetch threw:', err);
    alert('Chart export failed: ' + err.message);
  } finally {
    link.style.pointerEvents = '';
    link.innerHTML = '<i class="fa fa-download"></i> Download .zip';
  }
}

// ── download full curve data xlsx client-side via SheetJS ─────────────────
function downloadFullData() {
  const btn = document.getElementById('xlsx-rawdata-link');
  btn.style.pointerEvents = 'none';
  btn.innerHTML = '<span class="spinner-border spinner-border-sm mr-1"></span> Building…';

  // Defer to next tick so the spinner renders before the synchronous xlsx build
  setTimeout(() => {
    try {
      const wb   = XLSX.utils.book_new();
      const files = ojipData.files;
      const tRaw  = ojipData.time_raw_ms;
      const tLog  = ojipData.time_log_ms;

      // Build a sheet from a time array + one value array per file
      function makeSheet(timeArr, getVals) {
        const aoa = [['time_ms', ...files]];
        for (let r = 0; r < timeArr.length; r++) {
          const row = [timeArr[r]];
          for (const f of files) row.push(getVals(f)?.[r] ?? null);
          aoa.push(row);
        }
        return XLSX.utils.aoa_to_sheet(aoa);
      }

      XLSX.utils.book_append_sheet(wb, makeSheet(tRaw, f => ojipData.curves[f]?.raw),           'OJIP_raw');
      XLSX.utils.book_append_sheet(wb, makeSheet(tRaw, f => ojipData.curves[f]?.shifted_F0),    'OJIP_to_zero');
      XLSX.utils.book_append_sheet(wb, makeSheet(tRaw, f => ojipData.curves[f]?.shifted_FM),    'OJIP_to_max');
      XLSX.utils.book_append_sheet(wb, makeSheet(tRaw, f => ojipData.curves[f]?.double_norm),   'OJIP_norm');
      XLSX.utils.book_append_sheet(wb, makeSheet(tLog, f => ojipData.curves[f]?.reconstructed), 'OJIP_reconstructed');
      XLSX.utils.book_append_sheet(wb, makeSheet(tLog, f => ojipData.curves[f]?.d1),            '1st_derivatives');
      XLSX.utils.book_append_sheet(wb, makeSheet(tLog, f => ojipData.curves[f]?.d2),            '2nd_derivatives');
      XLSX.utils.book_append_sheet(wb, makeSheet(tRaw, f => ojipData.curves[f]?.residuals),     'Residuals');

      // Parameters sheet
      const allParamKeys = Object.values(PARAM_GROUPS).flat();
      const kvFields = ['F0', 'FM', 'FK', 'FJ', 'FI',
                        'FM_time_ms', 'FJ_time_user_ms', 'FI_time_user_ms',
                        'FJ_time_deriv_ms', 'FI_time_deriv_ms', 'FP_time_deriv_ms',
                        'Area_OJ', 'Area_JI', 'Area_IP', 'Area_OP'];
      const paramAoa = [['Sample', ...allParamKeys.map(p => PARAM_LABELS[p] || p), ...kvFields]];
      for (const fname of files) {
        const row = [fname];
        for (const p of allParamKeys) {
          const v = paramData[fname]?.[p];
          row.push(v != null && isFinite(v) ? v : null);
        }
        for (const f of kvFields) {
          const v = ojipData.key_values[fname]?.[f];
          row.push(v != null ? v : null);
        }
        paramAoa.push(row);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(paramAoa), 'Parameters');

      XLSX.writeFile(wb, `${ojipData.file_stem}_full_data.xlsx`);
    } catch (err) {
      alert('Full data export failed: ' + err.message);
    } finally {
      btn.style.pointerEvents = '';
      btn.innerHTML = '<i class="fa fa-file-excel-o"></i> Download full data .xlsx';
    }
  }, 30);
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
        '(https://tools-py.e-cyanobacterium.org/OJIP_data_analysis). ' +
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
