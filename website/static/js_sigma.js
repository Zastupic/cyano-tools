// ============================================================
//  CyanoTools Sigma(II) Analyzer — frontend logic
//  Chart.js 4.x + chartjs-chart-error-bars + SheetJS
// ============================================================

// ── state ─────────────────────────────────────────────────────────────────
let sigmaData  = null;   // full JSON from /api/sigma_process
let sigmaGroups = {};    // {sampleName: groupName}
let sigmaCharts = {};    // {chartId: Chart instance}
let xlsxUrl    = null;
const WAVELENGTHS = [440, 480, 540, 590, 625];

// ── publication style — group charts ─────────────────────────────────────
const SIGMA_PUB_DEFAULTS = {
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
  errorBarWidth:   1.5,
};
const SIGMA_PUB_PALETTES = {
  colorblind: ['#0072B2','#E69F00','#009E73','#CC79A7','#56B4E9','#D55E00','#F0E442','#000000'],
  grayscale:  ['#111111','#444444','#777777','#aaaaaa','#cccccc'],
  paired:     ['#1f77b4','#aec7e8','#ff7f0e','#ffbb78','#2ca02c','#98df8a','#d62728','#ff9896'],
};
const SIGMA_PER_CHART_DEFAULTS = {
  spectrum: { yStartZero: false, yHeadroom: 5  },
  perWl:    { yStartZero: true,  yHeadroom: 15 },
};
function _makeSigmaPub() {
  const pub = Object.assign({}, SIGMA_PUB_DEFAULTS);
  pub.perChart = {
    spectrum: Object.assign({}, SIGMA_PER_CHART_DEFAULTS.spectrum),
    perWl:    Object.assign({}, SIGMA_PER_CHART_DEFAULTS.perWl),
  };
  return pub;
}
let sigmaPub = _makeSigmaPub();

// ── parameter metadata ─────────────────────────────────────────────────────
const PARAM_LABELS = {
  sigma:    'σ(II) (nm²)',
  tau:      'Tau (ms)',
  tau_reox: '1.r.Tau (ms)',
  p:        'p',
  j:        'J',
  error:    'Error (rel.)',
};

// ── chart helpers ─────────────────────────────────────────────────────────
function destroyChart(id) {
  if (sigmaCharts[id]) { sigmaCharts[id].destroy(); delete sigmaCharts[id]; }
}
function makeChart(id, cfg) {
  destroyChart(id);
  const el = document.getElementById(id);
  if (!el) return null;
  // Destroy any orphaned Chart.js instance on this canvas
  // (can happen when a previous render threw before storing in sigmaCharts)
  const orphan = Chart.getChart(el);
  if (orphan) orphan.destroy();
  sigmaCharts[id] = new Chart(el, cfg);
  return sigmaCharts[id];
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
function hasGroups() {
  return new Set(Object.values(sigmaGroups).filter(g => g)).size >= 2;
}

// ── colour helpers ────────────────────────────────────────────────────────
function sampleColor(i, n, alpha) {
  const h = Math.round((i / Math.max(n, 1)) * 300);
  return alpha !== undefined ? `hsla(${h},70%,42%,${alpha})` : `hsl(${h},70%,42%)`;
}
function groupColor(i, n, alpha) {
  const palette = [210, 30, 120, 270, 60, 180, 330];
  const h = palette[i % palette.length];
  return alpha !== undefined ? `hsla(${h},65%,42%,${alpha})` : `hsl(${h},65%,42%)`;
}

// ── publication colour helper ─────────────────────────────────────────────
function _sigmaPubColor(gi, n, alpha) {
  const palette = SIGMA_PUB_PALETTES[sigmaPub.colorScheme];
  if (!palette) return groupColor(gi, n, alpha);
  const hex = palette[gi % palette.length];
  if (alpha === undefined) return hex;
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// White/custom background fill plugin
function _sigmaPubBgPlugin() {
  return {
    id: 'sigmaPubBg',
    beforeDraw(chart) {
      chart.ctx.save();
      chart.ctx.fillStyle = sigmaPub.bgColor || '#ffffff';
      chart.ctx.fillRect(0, 0, chart.width, chart.height);
      chart.ctx.restore();
    },
  };
}

// Border drawn around the chart area
function _sigmaPubBorderPlugin() {
  return {
    id: 'sigmaPubBorder',
    afterDraw(chart) {
      if (!sigmaPub.showBorder) return;
      const ca = chart.chartArea, ctx = chart.ctx;
      ctx.save();
      ctx.strokeStyle = sigmaPub.borderColor || '#000000';
      ctx.lineWidth   = sigmaPub.borderWidth  || 1;
      ctx.strokeRect(ca.left, ca.top, ca.right - ca.left, ca.bottom - ca.top);
      ctx.restore();
    },
  };
}

// Apply sigmaPub typography / grid / legend position to Chart.js opts.
function _sigmaPubApplyToOpts(opts) {
  const s = sigmaPub, fam = s.fontFamily;
  const sc = opts.scales || {};
  if (sc.x) {
    if (!sc.x.title) sc.x.title = { display: true };
    sc.x.title.font = { family: fam, size: s.axisTitleSize, weight: 'bold' };
    if (!sc.x.ticks) sc.x.ticks = {};
    sc.x.ticks.font = { family: fam, size: s.tickLabelSize };
    sc.x.grid = { display: s.showGridX };
  }
  if (sc.y) {
    if (!sc.y.title) sc.y.title = { display: true };
    sc.y.title.font = { family: fam, size: s.axisTitleSize, weight: 'bold' };
    if (!sc.y.ticks) sc.y.ticks = {};
    sc.y.ticks.font = { family: fam, size: s.tickLabelSize };
    sc.y.grid = { display: s.showGridY };
  }
  if (opts.plugins && opts.plugins.legend) {
    opts.plugins.legend.position = s.legendPosition;
    if (!opts.plugins.legend.labels) opts.plugins.legend.labels = {};
    opts.plugins.legend.labels.font = { family: fam, size: s.legendSize };
  }
  return opts;
}

// Resize all sigma group chart containers to reflect current pub aspect ratio.
function _sigmaPubApplyAspectRatio() {
  const ratio = sigmaPub.aspectRatio || 1.5;
  const presetWidths = { single: 85, half: 120, double: 175 };
  const widthMm = sigmaPub.sizePreset !== 'custom'
    ? (presetWidths[sigmaPub.sizePreset] || 85)
    : (sigmaPub.exportWidth || 85);
  const maxWPx = Math.round(widthMm * 96 / 25.4);
  document.querySelectorAll('.sigma-pub-ch').forEach(cont => {
    cont.style.maxWidth = maxWPx + 'px';
    const w = cont.offsetWidth;  // force reflow
    if (w > 0) cont.style.height = Math.round(w / ratio) + 'px';
    const cid = cont.dataset.cid;
    const ch = cid && sigmaCharts && sigmaCharts[cid];
    if (ch) ch.resize();
  });
}

// ── active param from a seg-ctrl ──────────────────────────────────────────
function _activeParam(ctrlId) {
  const btn = document.querySelector(`#${ctrlId} .btn-primary`);
  return btn ? btn.dataset.param : 'sigma';
}

// ── format helper ─────────────────────────────────────────────────────────
function _fmt(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return v;
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10)   return v.toFixed(2);
  if (Math.abs(v) >= 1)    return v.toFixed(3);
  return v.toFixed(4);
}

function _shortName(name) {
  return name.length > 13 ? name.slice(0, 12) + '…' : name;
}

// Build a legend config whose font size adapts to the longest label so text
// never gets clipped by the canvas boundary.  Chart.js allocates roughly
// 35 % of the chart width to a right-side legend; at each font size a
// character is ~0.6 × fontSize px wide, so the usable char budget is:
//   budget ≈ (chartWidth * 0.35 - boxWidth - padding) / (fontSize * 0.6)
// Rather than computing exact chart widths we use the label length itself
// as a proxy and pick the smallest font that keeps labels whole.
function _adaptiveLegend(labelsArr, position) {
  position = position || 'right';
  const maxLen = Math.max(...labelsArr.map(l => (l || '').length), 1);
  // font size: steps down as names get longer.
  // At 500 px chart width, the right-side legend gets ~175 px (~0.6×fontSize per char).
  const fontSize = maxLen <= 12 ? 11
                 : maxLen <= 20 ? 10
                 : maxLen <= 30 ? 9
                 : maxLen <= 42 ? 8
                 : 7;
  // only hard-truncate at 50 chars — the font scaling handles everything shorter
  const TRUNC = 50;
  function trunc(t) { return (t||'').length > TRUNC ? (t||'').slice(0, TRUNC - 1) + '…' : (t||''); }
  return {
    display: true,
    position,
    labels: {
      boxWidth: 12, font: { size: fontSize }, padding: 5,
      generateLabels: chart =>
        Chart.defaults.plugins.legend.labels.generateLabels(chart)
          .map(d => ({ ...d, text: trunc(d.text) })),
    },
  };
}

// Per-wavelength bar charts need a custom generateLabels because they use a
// single dataset with per-element colors, not one dataset per sample.
function _adaptiveLegendFromSamples(samples) {
  const labelsArr = samples.map(s => s.name);
  const cfg = _adaptiveLegend(labelsArr, 'right');
  cfg.labels.generateLabels = chart => {
    const ds = chart.data.datasets[0];
    const TRUNC = 40;
    return samples.map((s, i) => ({
      text: s.name.length > TRUNC ? s.name.slice(0, TRUNC - 1) + '…' : s.name,
      fillStyle:   ds.backgroundColor[i],
      strokeStyle: ds.borderColor[i],
      lineWidth:   ds.borderWidth,
      hidden: false, index: i,
    }));
  };
  return cfg;
}

// ══════════════════════════════════════════════════════════════════════════
//  FILE DROP ZONE
// ══════════════════════════════════════════════════════════════════════════
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('sigma-files');
const fileListEl = document.getElementById('file-list');
const fileCountLabel = document.getElementById('file-count-label');
let selectedFiles = [];

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.background = '#e8f0fb'; });
dropZone.addEventListener('dragleave', () => dropZone.style.background = '#f8f9fa');
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.style.background = '#f8f9fa';
  selectedFiles = Array.from(e.dataTransfer.files);
  renderFileList();
});
fileInput.addEventListener('change', () => {
  selectedFiles = Array.from(fileInput.files);
  fileInput.value = '';
  renderFileList();
});

function renderFileList() {
  fileListEl.innerHTML = '';
  selectedFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.style.cssText = 'display:inline-flex; align-items:center; background:#e9ecef; border-radius:4px; padding:2px 7px; white-space:nowrap;';
    chip.innerHTML = `<i class="fa fa-file-text-o mr-1 text-muted"></i>${f.name
      }<i class="fa fa-times ml-1" data-idx="${i}" title="Remove"
           style="cursor:pointer; color:#dc3545; font-size:0.75em;"></i>`;
    fileListEl.appendChild(chip);
  });
  fileListEl.querySelectorAll('[data-idx]').forEach(btn => {
    btn.addEventListener('click', () => { selectedFiles.splice(+btn.dataset.idx, 1); renderFileList(); });
  });
  const n = selectedFiles.length;
  fileCountLabel.textContent = n === 0 ? 'No files selected' : `${n} file${n > 1 ? 's' : ''} selected`;
  document.getElementById('analyze-btn').disabled = n === 0;
}

// ══════════════════════════════════════════════════════════════════════════
//  ANALYZE BUTTON
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('analyze-btn').addEventListener('click', () => {
  const fd = new FormData();
  selectedFiles.forEach(f => fd.append('files', f));

  const spinner = document.getElementById('analyze-spinner');
  const errEl   = document.getElementById('upload-error');
  spinner.style.display = 'inline-block';
  document.getElementById('analyze-btn').disabled = true;
  errEl.style.display = 'none';

  fetch('/api/sigma_process', { method: 'POST', body: fd })
    .then(r => r.json())
    .then(data => {
      spinner.style.display = 'none';
      document.getElementById('analyze-btn').disabled = false;
      if (data.error) {
        errEl.textContent = data.error; errEl.style.display = 'block'; return;
      }
      if (data.errors && data.errors.length) {
        errEl.textContent = 'Warnings: ' + data.errors.join('; ');
        errEl.style.display = 'block';
      }
      sigmaData = data;
      xlsxUrl   = data.xlsx_url;
      sigmaGroups = {};
      data.samples.forEach(s => { sigmaGroups[s.name] = ''; });
      buildResults();
      document.getElementById('results-section').style.display = 'block';
      document.getElementById('results-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
    .catch(err => {
      spinner.style.display = 'none';
      document.getElementById('analyze-btn').disabled = false;
      errEl.textContent = 'Server error: ' + err; errEl.style.display = 'block';
    });
});

// ══════════════════════════════════════════════════════════════════════════
//  BUILD ALL RESULT COMPONENTS
// ══════════════════════════════════════════════════════════════════════════
function buildResults() {
  // Destroy all existing chart instances (handles re-upload cleanly)
  Object.keys(sigmaCharts).forEach(id => destroyChart(id));
  document.getElementById('sigma-group-results').style.display = 'none';

  const n = sigmaData.samples.length;
  document.getElementById('results-summary').textContent =
    `${n} sample${n > 1 ? 's' : ''} processed successfully. `
    + `Wavelengths: ${sigmaData.wavelengths.join(', ')} nm.`;

  // show download button
  document.getElementById('sigma-xlsx-download-link').style.display = 'inline-block';

  buildSpectrumChart('sigma');
  buildPerWlCharts('sigma');
  buildGroupAssignTable();
  _updateGroupSummary();
  buildDataTable();
}

// ══════════════════════════════════════════════════════════════════════════
//  SEGMENTED CONTROLS — wire all three param selectors
// ══════════════════════════════════════════════════════════════════════════
document.querySelectorAll('.ojip-seg-ctrl').forEach(ctrl => {
  ctrl.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', () => {
      ctrl.querySelectorAll('.btn').forEach(b => {
        b.classList.remove('btn-primary'); b.classList.add('btn-outline-primary');
      });
      btn.classList.remove('btn-outline-primary'); btn.classList.add('btn-primary');
      const param = btn.dataset.param;
      if (!param || !sigmaData) return;
      if (ctrl.id === 'spectrum-param-ctrl') buildSpectrumChart(param);
      if (ctrl.id === 'perwl-param-ctrl')    buildPerWlCharts(param);
      if (ctrl.id === 'groups-param-ctrl') {
        buildGroupCharts(param);
        _sigmaPubApplyAspectRatio();
      }
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  SPECTRUM CHART
// ══════════════════════════════════════════════════════════════════════════
function buildSpectrumChart(param) {
  if (!sigmaData) return;
  const samples = sigmaData.samples;
  const n = samples.length;
  const datasets = samples.map((s, i) => ({
    label: s.name,
    data: s.wavelengths.map((wl, wi) => ({ x: wl, y: s[param][wi] })),
    borderColor: sampleColor(i, n),
    backgroundColor: sampleColor(i, n, 0.13),
    borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, tension: 0.3, fill: false,
  }));

  makeChart('chart-spectrum', {
    type: 'line',
    data: { datasets },
    options: {
      animation: false,
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: {
          type: 'linear', min: 420, max: 650,
          title: { display: true, text: 'Excitation wavelength (nm)' },
          ticks: { stepSize: 20 },
        },
        y: { title: { display: true, text: PARAM_LABELS[param] }, beginAtZero: false },
      },
      plugins: {
        legend: _adaptiveLegend(samples.map(s => s.name), 'right'),
        tooltip: {
          callbacks: {
            title: items => `λ = ${items[0].parsed.x} nm`,
            label: item => `${item.dataset.label}: ${_fmt(item.parsed.y)}`,
          },
        },
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  PER-WAVELENGTH BAR CHARTS  (one bar per sample, coloured bars, no legend)
// ══════════════════════════════════════════════════════════════════════════
function buildPerWlCharts(param) {
  if (!sigmaData) return;
  // Destroy previous per-wl chart instances before clearing DOM
  WAVELENGTHS.forEach(wl => destroyChart(`chart-perwl-${wl}`));

  const container = document.getElementById('perwl-charts');
  container.innerHTML = '';
  const samples = sigmaData.samples;
  const n = samples.length;

  WAVELENGTHS.forEach(wl => {
    const chartId = `chart-perwl-${wl}`;
    const wrap = document.createElement('div');
    wrap.className = 'p-2 border rounded bg-white';
    wrap.style.cssText = 'position:relative; height:280px;';
    const canvas = document.createElement('canvas');
    canvas.id = chartId;
    wrap.appendChild(canvas);
    container.appendChild(wrap);

    const vals = [], bgColors = [], borderColors = [], labels = [];
    samples.forEach((s, si) => {
      const idx = s.wavelengths.indexOf(wl);
      vals.push((idx !== -1) ? s[param][idx] : null);
      bgColors.push(sampleColor(si, n, 0.78));
      borderColors.push(sampleColor(si, n));
      labels.push(_shortName(s.name));
    });

    makeChart(chartId, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data: vals,
          backgroundColor: bgColors,
          borderColor: borderColors,
          borderWidth: 1.5,
          barPercentage: 0.8,
          categoryPercentage: 0.8,
        }],
      },
      options: {
        animation: false,
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: {
            ticks: { display: false },
            grid: { display: false },
          },
          y: { title: { display: true, text: PARAM_LABELS[param] }, beginAtZero: false },
        },
        plugins: {
          legend: _adaptiveLegendFromSamples(samples),
          title: { display: true, text: `λ = ${wl} nm`, font: { weight: 'bold' } },
          tooltip: {
            callbacks: {
              title: items => samples[items[0].dataIndex]?.name || '',
              label: item => `${PARAM_LABELS[param]}: ${_fmt(item.parsed.y)}`,
            },
          },
        },
      },
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  GROUP ASSIGNMENT TABLE (checkbox pattern)
// ══════════════════════════════════════════════════════════════════════════
function buildGroupAssignTable() {
  if (!sigmaData) return;
  const tbody = document.getElementById('sigma-group-assign-body');
  tbody.innerHTML = '';
  sigmaData.samples.forEach(s => {
    const tr = document.createElement('tr');
    const grp = sigmaGroups[s.name] || '';
    tr.innerHTML = `
      <td><input type="checkbox" class="sigma-row-check"></td>
      <td style="word-break:break-all; font-size:0.83rem;">${s.name}</td>
      <td>
        <span class="sigma-grp-badge">${grp ? `<span class="badge badge-info">${grp}</span>` : '<span class="text-muted">—</span>'}</span>
      </td>
      <td>
        <button class="btn btn-sm btn-outline-danger sigma-remove-grp-btn py-0" data-name="${s.name}"
                style="font-size:0.75rem;" ${!grp ? 'disabled' : ''}>
          <i class="fa fa-times"></i>
        </button>
      </td>`;
    tbody.appendChild(tr);
  });

  // Remove-from-group buttons
  tbody.querySelectorAll('.sigma-remove-grp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sigmaGroups[btn.dataset.name] = '';
      buildGroupAssignTable();
      _updateGroupSummary();
      checkGroupsReady();
    });
  });
}

// Select-all checkbox
document.getElementById('sigma-select-all-check').addEventListener('change', function () {
  document.querySelectorAll('.sigma-row-check').forEach(cb => { cb.checked = this.checked; });
});

// Sort A→Z / Z→A
document.getElementById('sigma-sort-asc-btn').addEventListener('click', () => {
  if (sigmaData) { sigmaData.samples.sort((a, b) => a.name.localeCompare(b.name)); buildGroupAssignTable(); }
});
document.getElementById('sigma-sort-desc-btn').addEventListener('click', () => {
  if (sigmaData) { sigmaData.samples.sort((a, b) => b.name.localeCompare(a.name)); buildGroupAssignTable(); }
});

// Auto-detect from prefix (split on first underscore or hyphen + digit)
document.getElementById('sigma-auto-detect-btn').addEventListener('click', () => {
  if (!sigmaData) return;
  sigmaData.samples.forEach(s => {
    const m = s.name.match(/^([A-Za-z][^_\-\d]*)/);
    sigmaGroups[s.name] = m ? m[1].replace(/[-_]+$/, '') : '';
  });
  buildGroupAssignTable();
  _updateGroupSummary();
  checkGroupsReady();
});

// Clear all groups
document.getElementById('sigma-clear-groups-btn').addEventListener('click', () => {
  if (!sigmaData) return;
  sigmaData.samples.forEach(s => { sigmaGroups[s.name] = ''; });
  buildGroupAssignTable();
  _updateGroupSummary();
  checkGroupsReady();
});

// Assign selected
document.getElementById('sigma-assign-group-btn').addEventListener('click', () => {
  const name = document.getElementById('sigma-group-name-input').value.trim();
  if (!name) return;
  const checked = document.querySelectorAll('.sigma-row-check:checked');
  if (!checked.length) return;
  if (!sigmaData) return;
  checked.forEach(cb => {
    const row = cb.closest('tr');
    const sampleName = row.querySelector('td:nth-child(2)').textContent.trim();
    sigmaGroups[sampleName] = name;
  });
  buildGroupAssignTable();
  _updateGroupSummary();
  document.getElementById('sigma-group-name-input').value = '';
  checkGroupsReady();
});

function _updateGroupSummary() {
  const counts = {};
  Object.values(sigmaGroups).forEach(g => { if (g) counts[g] = (counts[g] || 0) + 1; });
  const summaryEl = document.getElementById('sigma-groups-summary');
  const groups = Object.keys(counts);
  if (!groups.length) { summaryEl.innerHTML = ''; return; }
  summaryEl.innerHTML = '<strong class="small">Current groups:</strong> '
    + groups.map(g => `<span class="badge badge-info mr-1">${g} (n=${counts[g]})</span>`).join('');
}

// Update charts button (manual override — checkGroupsReady handles auto)
document.getElementById('sigma-apply-groups-btn').addEventListener('click', () => {
  const param = _activeParam('groups-param-ctrl');
  buildGroupCharts(param);
  _sigmaPubApplyAspectRatio();
});

// ══════════════════════════════════════════════════════════════════════════
//  CHECK GROUPS READY — auto-render group charts whenever groups change
// ══════════════════════════════════════════════════════════════════════════
function checkGroupsReady() {
  const gr = document.getElementById('sigma-group-results');
  if (hasGroups()) {
    if (gr) { gr.style.display = ''; void gr.offsetWidth; }
    const activeLink = document.querySelector('#sigmaTabs .nav-link.active');
    const activeHref = activeLink ? activeLink.getAttribute('href') : '';
    if (activeHref === '#tab-groups') {
      buildGroupCharts(_activeParam('groups-param-ctrl'));
      _sigmaPubApplyAspectRatio();
    } else {
      // Pre-render while tab pane is temporarily visible so canvases measure correctly
      _withPaneVisible('tab-groups', () => {
        const innerGr = document.getElementById('sigma-group-results');
        if (innerGr) { innerGr.style.display = ''; void innerGr.offsetWidth; }
        buildGroupCharts(_activeParam('groups-param-ctrl'));
        _sigmaPubApplyAspectRatio();
      });
    }
  } else {
    if (gr) gr.style.display = 'none';
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  GROUP CHARTS
// ══════════════════════════════════════════════════════════════════════════
function buildGroupCharts(param) {
  if (!sigmaData) return;

  const groupNames = [...new Set(Object.values(sigmaGroups).filter(g => g !== ''))];
  if (!groupNames.length) {
    document.getElementById('sigma-group-results').style.display = 'none'; return;
  }

  document.getElementById('sigma-group-results').style.display = 'block';
  const nGrp = groupNames.length;

  // ── compute mean & SD per group per wavelength ────────────────────────
  const grpStats = {};
  groupNames.forEach(g => { grpStats[g] = WAVELENGTHS.map(() => ({ vals: [] })); });
  sigmaData.samples.forEach(s => {
    const g = sigmaGroups[s.name]; if (!g) return;
    s.wavelengths.forEach((wl, wi) => {
      const wlIdx = WAVELENGTHS.indexOf(wl); if (wlIdx === -1) return;
      const v = s[param][wi];
      if (v !== null && v !== undefined) grpStats[g][wlIdx].vals.push(v);
    });
  });
  groupNames.forEach(g => {
    grpStats[g] = grpStats[g].map(cell => {
      const vals = cell.vals;
      const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      const sd   = (vals.length > 1)
        ? Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1))
        : 0;
      return { mean, sd, n: vals.length };
    });
  });

  // ── mean spectrum chart ───────────────────────────────────────────────
  const specDatasets = groupNames.map((g, gi) => ({
    label: g,
    data: WAVELENGTHS.map((wl, wi) => ({
      x: wl, y: grpStats[g][wi].mean,
      yMin: grpStats[g][wi].mean !== null ? grpStats[g][wi].mean - grpStats[g][wi].sd : null,
      yMax: grpStats[g][wi].mean !== null ? grpStats[g][wi].mean + grpStats[g][wi].sd : null,
    })),
    borderColor: _sigmaPubColor(gi, nGrp),
    backgroundColor: _sigmaPubColor(gi, nGrp, 0.13),
    errorBarColor: _sigmaPubColor(gi, nGrp),
    errorBarWhiskerColor: _sigmaPubColor(gi, nGrp),
    errorBarLineWidth: sigmaPub.errorBarWidth,
    borderWidth: sigmaPub.lineWidthMean,
    pointRadius: 5, tension: 0.3, fill: false,
  }));

  // ── compute y bounds for spectrum ─────────────────────────────────────
  const pcSpec = sigmaPub.perChart.spectrum;
  const specAllYMax = specDatasets.flatMap(ds => ds.data.map(d => d.yMax ?? d.y))
                                   .filter(v => v !== null && isFinite(v));
  const specAllYMin = specDatasets.flatMap(ds => ds.data.map(d => d.yMin ?? d.y))
                                   .filter(v => v !== null && isFinite(v));
  const specYMax = specAllYMax.length ? Math.max(...specAllYMax) : null;
  const specYMin = specAllYMin.length ? Math.min(...specAllYMin) : null;

  const specOpts = {
    animation: false,
    responsive: true, maintainAspectRatio: false,
    scales: {
      x: { type: 'linear', min: 420, max: 650,
           title: { display: true, text: 'Excitation wavelength (nm)' }, ticks: { stepSize: 20 } },
      y: {
        title: { display: true, text: PARAM_LABELS[param] }, beginAtZero: false,
        ...(pcSpec.yStartZero ? { min: 0 } : {}),
        ...(specYMax !== null ? { max: specYMax * (1 + pcSpec.yHeadroom / 100) } : {}),
      },
    },
    plugins: {
      legend: _adaptiveLegend(groupNames, sigmaPub.legendPosition),
      tooltip: {
        callbacks: {
          title: items => `λ = ${items[0].parsed.x} nm`,
          label: item => {
            const d = item.dataset.data[item.dataIndex];
            return `${item.dataset.label}: ${_fmt(d.y)} ± ${_fmt(d.yMax !== null ? d.yMax - d.y : 0)}`;
          },
        },
      },
    },
  };
  _sigmaPubApplyToOpts(specOpts);

  makeChart('chart-grp-spectrum', {
    type: 'lineWithErrorBars',
    data: { datasets: specDatasets },
    options: specOpts,
    plugins: [_sigmaPubBgPlugin(), _sigmaPubBorderPlugin()],
  });

  // ── per-wavelength bar charts (one dataset per group with error bars) ──
  // Destroy previous group per-wl charts before clearing container
  WAVELENGTHS.forEach(wl => destroyChart(`chart-grp-perwl-${wl}`));
  const container = document.getElementById('grp-perwl-charts');
  container.innerHTML = '';

  WAVELENGTHS.forEach((wl, wi) => {
    const chartId = `chart-grp-perwl-${wl}`;
    const wrap = document.createElement('div');
    wrap.className = 'p-2 border rounded bg-white sigma-pub-ch';
    wrap.dataset.cid = chartId;
    wrap.style.cssText = 'position:relative; height:280px;';
    const canvas = document.createElement('canvas');
    canvas.id = chartId; wrap.appendChild(canvas); container.appendChild(wrap);

    // One dataset per group sharing the same category label (groups appear side-by-side)
    const barDatasets = groupNames.map((g, gi) => {
      const s = grpStats[g][wi];
      const c = _sigmaPubColor(gi, nGrp);
      return {
        label: g,
        data: [{ y: s.mean !== null ? s.mean : NaN,
                 yMin: s.mean !== null ? s.mean - s.sd : NaN,
                 yMax: s.mean !== null ? s.mean + s.sd : NaN }],
        backgroundColor: _sigmaPubColor(gi, nGrp, 0.75),
        borderColor: c,
        errorBarColor: c,
        errorBarWhiskerColor: c,
        errorBarLineWidth: sigmaPub.errorBarWidth,
        errorBarWhiskerSize: 8,
        borderWidth: 1.5,
      };
    });

    // compute y bounds for this bar chart
    const pcWl = sigmaPub.perChart.perWl;
    const wlYMax = groupNames.map(g => {
      const s = grpStats[g][wi];
      return s.mean !== null ? s.mean + s.sd : null;
    }).filter(v => v !== null && isFinite(v));
    const wlYMaxVal = wlYMax.length ? Math.max(...wlYMax) : null;

    const barOpts = {
      animation: false,
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y: {
          title: { display: true, text: PARAM_LABELS[param] }, beginAtZero: false,
          ...(pcWl.yStartZero ? { min: 0 } : {}),
          ...(wlYMaxVal !== null ? { max: wlYMaxVal * (1 + pcWl.yHeadroom / 100) } : {}),
        },
      },
      plugins: {
        legend: (() => {
          const cfg = _adaptiveLegend(groupNames, sigmaPub.legendPosition);
          cfg.display = nGrp <= 6;
          return cfg;
        })(),
        title: { display: true, text: `λ = ${wl} nm`, font: { weight: 'bold' } },
        tooltip: {
          callbacks: {
            label: item => {
              const d = item.dataset.data[0];
              const g = item.dataset.label;
              const stat = grpStats[g][wi];
              return `${g}: ${_fmt(d.y)} ± ${_fmt(stat.sd)} (n=${stat.n})`;
            },
          },
        },
      },
    };
    _sigmaPubApplyToOpts(barOpts);

    makeChart(chartId, {
      type: 'barWithErrorBars',
      data: { labels: [PARAM_LABELS[param]], datasets: barDatasets },
      options: barOpts,
      plugins: [_sigmaPubBgPlugin(), _sigmaPubBorderPlugin()],
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  DATA TABLE
// ══════════════════════════════════════════════════════════════════════════
function buildDataTable() {
  if (!sigmaData) return;
  const tbody = document.getElementById('sigma-table-body');
  tbody.innerHTML = '';
  sigmaData.samples.forEach(s => {
    s.wavelengths.forEach((wl, wi) => {
      const tr = document.createElement('tr');
      tr.innerHTML = [
        s.name, wl,
        _fmt(s.sigma[wi]), _fmt(s.tau[wi]), _fmt(s.tau_reox[wi]),
        _fmt(s.p[wi]), _fmt(s.j[wi]),
        _fmt(s.fo[wi]), _fmt(s.i1[wi]),
        s.par[wi] !== null ? s.par[wi] : '—',
        _fmt(s.error[wi]),
      ].map(v => `<td>${v !== undefined && v !== null ? v : '—'}</td>`).join('');
      tbody.appendChild(tr);
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════
//  EXPORT TO STATISTICS
// ══════════════════════════════════════════════════════════════════════════
document.getElementById('sigma-export-stats-btn').addEventListener('click', () => {
  if (!sigmaData) return;
  const param = _activeParam('groups-param-ctrl');
  const header = ['Group', 'Sample', ...WAVELENGTHS.map(wl => `${wl} nm`)].join('\t');
  const rows = sigmaData.samples.map(s => {
    const cells = [sigmaGroups[s.name] || '', s.name];
    WAVELENGTHS.forEach(wl => {
      const idx = s.wavelengths.indexOf(wl);
      cells.push(idx !== -1 && s[param][idx] !== null ? s[param][idx] : '');
    });
    return cells.join('\t');
  });
  sessionStorage.setItem('ojip_export', JSON.stringify({
    tsv:    [header, ...rows].join('\n'),
    source: `CyanoTools Sigma(II) Analyzer — ${PARAM_LABELS[param]}`,
  }));
  window.open('/statistics', '_blank');
});

// ══════════════════════════════════════════════════════════════════════════
//  XLSX DOWNLOAD WITH EMBEDDED CHART IMAGES
// ══════════════════════════════════════════════════════════════════════════
const _SIGMA_MAX_CHART_PX = 1200;
function _sigmaChartToDataUrl(canvas) {
  let w = canvas.width, h = canvas.height;
  if (w > _SIGMA_MAX_CHART_PX) { h = Math.round(h * _SIGMA_MAX_CHART_PX / w); w = _SIGMA_MAX_CHART_PX; }
  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h);
  return tmp.toDataURL('image/jpeg', 0.88);
}

// Capture a canvas that is already in a visible context (no pane toggling).
// resize() is called FIRST so freshly-created canvases get laid out before
// we check their dimensions — otherwise Chart.js may not have run its initial
// ResizeObserver yet and canvas.width/height would be 0.
function _captureDirect(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  if (sigmaCharts[id]) sigmaCharts[id].resize();
  if (canvas.width === 0 || canvas.height === 0) return null;
  const du = _sigmaChartToDataUrl(canvas);
  return (du && du.includes(',') && du.split(',')[1]) ? du : null;
}

async function downloadXlsxWithCharts() {
  if (!sigmaData) return;
  const btn = document.getElementById('sigma-xlsx-download-link');
  const origHtml = btn.innerHTML;
  btn.style.pointerEvents = 'none';
  btn.innerHTML = '<span class="spinner-border spinner-border-sm mr-1"></span> Embedding charts…';

  try {
    const charts = [];
    const specParam  = _activeParam('spectrum-param-ctrl');
    const perwlParam = _activeParam('perwl-param-ctrl');
    const grpParam   = _activeParam('groups-param-ctrl');

    // Spectrum — render & capture while its pane is visible
    _withPaneVisible('tab-spectrum', () => {
      const du = _captureDirect('chart-spectrum');
      if (du) charts.push({ title: `Spectrum — ${PARAM_LABELS[specParam]}`, data_url: du });
    });

    // Per-wavelength — re-render & capture all 5 while the pane is visible
    _withPaneVisible('tab-perwl', () => {
      buildPerWlCharts(perwlParam);
      // Force a layout pass so freshly-injected canvases have measured dimensions
      // before _captureDirect calls resize().
      void document.getElementById('perwl-charts').offsetWidth;
      WAVELENGTHS.forEach(wl => {
        const du = _captureDirect(`chart-perwl-${wl}`);
        if (du) charts.push({ title: `${wl} nm — ${PARAM_LABELS[perwlParam]}`, data_url: du });
      });
    });

    // Group charts — re-render & capture while the pane is visible
    if (hasGroups()) {
      _withPaneVisible('tab-groups', () => {
        const gr = document.getElementById('sigma-group-results');
        if (gr) { gr.style.display = ''; void gr.offsetWidth; }
        buildGroupCharts(grpParam);
        void document.getElementById('grp-perwl-charts').offsetWidth;
        const du_grp = _captureDirect('chart-grp-spectrum');
        if (du_grp) charts.push({ title: `Group spectrum — ${PARAM_LABELS[grpParam]}`, data_url: du_grp });
        WAVELENGTHS.forEach(wl => {
          const du = _captureDirect(`chart-grp-perwl-${wl}`);
          if (du) charts.push({ title: `Group ${wl} nm — ${PARAM_LABELS[grpParam]}`, data_url: du });
        });
      });
    }

    const resp = await fetch('/api/sigma_export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ samples: sigmaData.samples, charts }),
    });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);
    const dlA = document.createElement('a');
    dlA.href = result.xlsx_url;
    dlA.download = 'sigma_summary.xlsx';
    dlA.click();
  } catch (err) {
    alert('Export failed: ' + err.message);
  } finally {
    btn.style.pointerEvents = '';
    btn.innerHTML = origHtml;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  PUBLICATION STYLE CARD — event wiring
// ══════════════════════════════════════════════════════════════════════════
(function _initSigmaPubCard() {
  function g(id) { return document.getElementById(id); }

  // ── restore from localStorage ──────────────────────────────────────────
  try {
    const stored = localStorage.getItem('sigma_grp_pub');
    if (stored) {
      const parsed = JSON.parse(stored);
      Object.assign(sigmaPub, parsed);
      // restore perChart sub-objects safely
      if (parsed.perChart) {
        ['spectrum', 'perWl'].forEach(ch => {
          if (parsed.perChart[ch]) Object.assign(sigmaPub.perChart[ch], parsed.perChart[ch]);
        });
      }
    }
  } catch(e) {}

  // ── read all settings from DOM into sigmaPub ───────────────────────────
  function readSettings() {
    const sizePreset = (g('sigma-pub-size-preset') || {}).value || 'single';
    const presetWidths = { single: 85, half: 120, double: 175 };
    sigmaPub.sizePreset  = sizePreset;
    sigmaPub.exportWidth = sizePreset !== 'custom'
      ? (presetWidths[sizePreset] || 85)
      : (parseFloat((g('sigma-pub-export-width') || {}).value) || 85);
    const aspectVal = (g('sigma-pub-aspect-preset') || {}).value || '1.50';
    sigmaPub.aspectRatio = aspectVal === 'custom'
      ? (parseFloat((g('sigma-pub-aspect-custom') || {}).value) || 1.5)
      : (parseFloat(aspectVal) || 1.5);
    sigmaPub.bgColor        = (g('sigma-pub-bg-color')       || {}).value || '#ffffff';
    sigmaPub.fontFamily     = (g('sigma-pub-font-family')    || {}).value || 'Arial';
    sigmaPub.axisTitleSize  = parseInt((g('sigma-pub-axis-title-size') || {}).value) || 12;
    sigmaPub.tickLabelSize  = parseInt((g('sigma-pub-tick-size')       || {}).value) || 11;
    sigmaPub.legendSize     = parseInt((g('sigma-pub-legend-size')     || {}).value) || 10;
    sigmaPub.colorScheme    = (g('sigma-pub-color-scheme')   || {}).value || 'default';
    sigmaPub.legendPosition = (g('sigma-pub-legend-pos')     || {}).value || 'right';
    sigmaPub.showGridY      = !!(g('sigma-pub-grid-y')       || {}).checked;
    sigmaPub.showGridX      = !!(g('sigma-pub-grid-x')       || {}).checked;
    sigmaPub.showBorder     = !!(g('sigma-pub-show-border')  || {}).checked;
    sigmaPub.borderColor    = (g('sigma-pub-border-color')   || {}).value || '#000000';
    sigmaPub.borderWidth    = parseFloat((g('sigma-pub-border-width') || {}).value) || 1;
    sigmaPub.lineWidthMean  = parseFloat((g('sigma-pub-line-width')   || {}).value) || 2.5;
    sigmaPub.errorBarWidth  = parseFloat((g('sigma-pub-errbar-width') || {}).value) || 1.5;
    // per-chart settings
    ['spectrum', 'perWl'].forEach(ch => {
      const pc = sigmaPub.perChart[ch];
      pc.yStartZero = !!(g(`sigma-pc-${ch}-y-start-zero`) || {}).checked;
      pc.yHeadroom  = parseInt((g(`sigma-pc-${ch}-y-headroom`) || {}).value) || 5;
    });
    try { localStorage.setItem('sigma_grp_pub', JSON.stringify(sigmaPub)); } catch(e) {}
  }

  // ── sync DOM controls from sigmaPub ───────────────────────────────────
  const RATIO_PRESETS = ['0.75', '1.00', '1.33', '1.50', '1.78'];
  function syncUI() {
    function sv(id, v) { const el = g(id); if (el) el.value = v; }
    function sc(id, v) { const el = g(id); if (el) el.checked = v; }
    sv('sigma-pub-size-preset',    sigmaPub.sizePreset);
    sv('sigma-pub-export-width',   sigmaPub.exportWidth);
    const ratioStr = sigmaPub.aspectRatio.toFixed(2);
    const isPreset = RATIO_PRESETS.indexOf(ratioStr) >= 0;
    sv('sigma-pub-aspect-preset',  isPreset ? ratioStr : 'custom');
    sv('sigma-pub-aspect-custom',  ratioStr);
    sv('sigma-pub-bg-color',       sigmaPub.bgColor);
    sv('sigma-pub-font-family',    sigmaPub.fontFamily);
    sv('sigma-pub-axis-title-size',sigmaPub.axisTitleSize);
    sv('sigma-pub-tick-size',      sigmaPub.tickLabelSize);
    sv('sigma-pub-legend-size',    sigmaPub.legendSize);
    sv('sigma-pub-color-scheme',   sigmaPub.colorScheme);
    sv('sigma-pub-legend-pos',     sigmaPub.legendPosition);
    sc('sigma-pub-grid-y',         sigmaPub.showGridY);
    sc('sigma-pub-grid-x',         sigmaPub.showGridX);
    sc('sigma-pub-show-border',    sigmaPub.showBorder);
    sv('sigma-pub-border-color',   sigmaPub.borderColor);
    sv('sigma-pub-border-width',   sigmaPub.borderWidth);
    sv('sigma-pub-line-width',     sigmaPub.lineWidthMean);
    sv('sigma-pub-errbar-width',   sigmaPub.errorBarWidth);
    const lwEl = g('sigma-pub-line-width-val');   if (lwEl) lwEl.textContent  = sigmaPub.lineWidthMean + ' px';
    const ebEl = g('sigma-pub-errbar-width-val'); if (ebEl) ebEl.textContent  = sigmaPub.errorBarWidth + ' px';
    const cw = g('sigma-pub-custom-width-wrap');
    if (cw) cw.style.display = sigmaPub.sizePreset === 'custom' ? '' : 'none';
    const cr = g('sigma-pub-custom-ratio-wrap');
    if (cr) cr.style.display = isPreset ? 'none' : '';
    const bo = g('sigma-pub-border-opts');
    if (bo) bo.style.display = sigmaPub.showBorder ? '' : 'none';
    // per-chart
    ['spectrum', 'perWl'].forEach(ch => {
      const pc = sigmaPub.perChart[ch];
      sc(`sigma-pc-${ch}-y-start-zero`, pc.yStartZero);
      sv(`sigma-pc-${ch}-y-headroom`,   pc.yHeadroom);
    });
  }
  syncUI();

  // ── "Custom" badge ─────────────────────────────────────────────────────
  function updateBadge() {
    const badge = g('sigma-grp-pub-badge');
    if (!badge) return;
    let isCustom = Object.keys(SIGMA_PUB_DEFAULTS).some(k => sigmaPub[k] !== SIGMA_PUB_DEFAULTS[k]);
    if (!isCustom) {
      isCustom = ['spectrum', 'perWl'].some(ch => {
        const pc = sigmaPub.perChart[ch], def = SIGMA_PER_CHART_DEFAULTS[ch];
        return Object.keys(def).some(k => pc[k] !== def[k]);
      });
    }
    badge.style.display = isCustom ? '' : 'none';
  }

  // ── chevron toggle (Bootstrap 4 jQuery events) ─────────────────────────
  $('#sigma-grp-pub-body').on('show.bs.collapse',  function() {
    const ch = g('sigma-grp-pub-chevron'); if (ch) ch.style.transform = 'rotate(180deg)';
  });
  $('#sigma-grp-pub-body').on('hide.bs.collapse',  function() {
    const ch = g('sigma-grp-pub-chevron'); if (ch) ch.style.transform = '';
  });

  // ── debounced re-render ────────────────────────────────────────────────
  let _reRenderTimer = null;
  function triggerReRender() {
    clearTimeout(_reRenderTimer);
    _reRenderTimer = setTimeout(() => {
      if (!sigmaData || !hasGroups()) return;
      const activeLink = document.querySelector('#sigmaTabs .nav-link.active');
      const activeHref = activeLink ? activeLink.getAttribute('href') : '';
      if (activeHref === '#tab-groups') {
        buildGroupCharts(_activeParam('groups-param-ctrl'));
        _sigmaPubApplyAspectRatio();
      } else {
        _withPaneVisible('tab-groups', () => {
          const gr = document.getElementById('sigma-group-results');
          if (gr) { gr.style.display = ''; void gr.offsetWidth; }
          buildGroupCharts(_activeParam('groups-param-ctrl'));
          _sigmaPubApplyAspectRatio();
        });
      }
    }, 80);
  }

  // ── shared control events ──────────────────────────────────────────────
  const sizePresetSel = g('sigma-pub-size-preset');
  if (sizePresetSel) sizePresetSel.addEventListener('change', function() {
    const cw = g('sigma-pub-custom-width-wrap');
    if (cw) cw.style.display = this.value === 'custom' ? '' : 'none';
    readSettings(); updateBadge(); triggerReRender();
  });
  const aspectPresetSel = g('sigma-pub-aspect-preset');
  if (aspectPresetSel) aspectPresetSel.addEventListener('change', function() {
    const cr = g('sigma-pub-custom-ratio-wrap');
    if (cr) cr.style.display = this.value === 'custom' ? '' : 'none';
    readSettings(); updateBadge(); triggerReRender();
  });
  const showBorderChk = g('sigma-pub-show-border');
  if (showBorderChk) showBorderChk.addEventListener('change', function() {
    const bo = g('sigma-pub-border-opts');
    if (bo) bo.style.display = this.checked ? '' : 'none';
    readSettings(); updateBadge(); triggerReRender();
  });

  [
    'sigma-pub-export-width', 'sigma-pub-aspect-custom', 'sigma-pub-bg-color',
    'sigma-pub-font-family', 'sigma-pub-axis-title-size', 'sigma-pub-tick-size', 'sigma-pub-legend-size',
    'sigma-pub-color-scheme', 'sigma-pub-legend-pos',
    'sigma-pub-grid-y', 'sigma-pub-grid-x',
    'sigma-pub-border-color', 'sigma-pub-border-width',
    // per-chart controls
    'sigma-pc-spectrum-y-start-zero', 'sigma-pc-spectrum-y-headroom',
    'sigma-pc-perWl-y-start-zero',    'sigma-pc-perWl-y-headroom',
  ].forEach(id => {
    const el = g(id);
    if (el) el.addEventListener('change', () => { readSettings(); updateBadge(); triggerReRender(); });
  });

  // Range sliders: live label update
  [
    { id: 'sigma-pub-line-width',   labelId: 'sigma-pub-line-width-val',   fmt: v => v + ' px' },
    { id: 'sigma-pub-errbar-width', labelId: 'sigma-pub-errbar-width-val', fmt: v => v + ' px' },
  ].forEach(cfg => {
    const el = g(cfg.id);
    if (el) el.addEventListener('input', function() {
      const lbl = g(cfg.labelId); if (lbl) lbl.textContent = cfg.fmt(parseFloat(this.value));
      readSettings(); updateBadge(); triggerReRender();
    });
  });

  // Reset defaults
  const resetBtn = g('sigma-pub-reset-btn');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    sigmaPub = _makeSigmaPub();
    syncUI(); updateBadge();
    try { localStorage.removeItem('sigma_grp_pub'); } catch(e) {}
    triggerReRender();
  });
})();

// ══════════════════════════════════════════════════════════════════════════
//  METHODS MODAL
// ══════════════════════════════════════════════════════════════════════════
function showSigmaMethodsModal() {
  const nSamples = sigmaData ? sigmaData.samples.length : 0;
  const text =
`Functional Absorption Cross-Section of PSII [σ(II)λ]

The wavelength-dependent functional absorption cross-section of photosystem II [σ(II)λ, nm²] was measured using a Multi-Color PAM fluorometer (Heinz Walz GmbH, Effeltrich, Germany) equipped with five actinic LED modules providing excitation at 440, 480, 540, 590 and 625 nm. ${nSamples > 0 ? `A total of ${nSamples} sample${nSamples > 1 ? 's' : ''} were analysed.` : ''}

For each excitation wavelength, a series of brief single-turnover flashes was applied to dark-adapted samples while the fast O–I₁ fluorescence rise kinetics were recorded. The rise kinetics were fitted by the reversible radical pair (RRP) model (Schatz et al. 1988; Lavergne & Trissl 1995) to obtain the rate constant of QA reduction k(II) = 1/τ, where τ (ms) is the time constant of the O–I₁ rise. The functional absorption cross-section was then calculated as:

    σ(II)λ = k(II) / (L × PARλ)

where L is the Avogadro constant (6.022 × 10²³ mol⁻¹) and PARλ is the actinic photon flux density at wavelength λ (µmol photons m⁻² s⁻¹), converted to photons nm⁻² s⁻¹. All calculations were performed by WinControl-3 software (Heinz Walz GmbH). The resulting σ(II)λ values (nm²) were exported as semicolon-delimited CSV files and analysed using the CyanoTools Sigma(II) Analyzer (https://tools-py.e-cyanobacterium.org/sigma_analysis).

Additional kinetic parameters extracted from the fit include the Joliot connectivity parameter p (sigmoidicity of the O–I₁ rise) and the first QA⁻ reoxidation time constant 1.r.τ (ms), reflecting the rate of electron transfer from QA⁻ to QB.

References:
- Schreiber U, Klughammer C & Kolbowski J (2012) Assessment of wavelength-dependent parameters of photosynthetic electron transport with a new type of multi-color PAM chlorophyll fluorometer. Photosynth Res 113:127–144.
- Schatz GH, Brock H & Holzwarth AR (1988) Kinetic and energetic model for the primary processes in photosystem II. Biophys J 54:397–405.
- Lavergne J & Trissl H-W (1995) Theory of fluorescence induction in photosystem II: Derivation of analytical expressions in a model including exciton-radical-pair equilibrium and restricted energy transfer between photosynthetic units. Biophys J 68:2474–2492.`;

  document.getElementById('sigma-methods-text-area').value = text;
  $('#sigmaMethodsModal').modal('show');
}

function copySigmaMethodsText() {
  const ta = document.getElementById('sigma-methods-text-area');
  ta.select();
  document.execCommand('copy');
  const btn = document.querySelector('#sigmaMethodsModal .btn-outline-primary');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fa fa-check mr-1"></i>Copied!';
  setTimeout(() => { btn.innerHTML = orig; }, 1800);
}
