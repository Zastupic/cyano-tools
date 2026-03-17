// ============================================================
//  CyanoTools Light Curves Analyzer — frontend logic
//  Chart.js 4.x + chartjs-chart-error-bars
// ============================================================

// ── state ─────────────────────────────────────────────────────────────────
let lcData    = null;    // full JSON from /api/lc_process
let groups    = {};      // {filename: groupName}
let chartInst = {};      // {chartId: Chart instance}
let dirtyTabs = new Set();

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
  chartInst[id] = new Chart(document.getElementById(id), cfg);
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
      document.getElementById('group-results').style.display = '';
      renderGroupEtrChart();
      const gpg = document.querySelector('#group-param-btns .btn-primary')?.dataset?.gpgroup || 'efficiencies';
      renderGroupParamsChart(gpg);
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
  document.getElementById('group-param-btns')?.addEventListener('click', e => {
    const btn = e.target.closest('[data-gpgroup]'); if (!btn) return;
    setActiveBtn('group-param-btns', btn);
    renderGroupParamsChart(btn.dataset.gpgroup);
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

  // Tab shown → resize charts & render dirty
  document.getElementById('lcTabs')?.addEventListener('shown.bs.tab', e => {
    if (!lcData) return;
    const tabId = (e.target.getAttribute('href') || '').slice(1);
    renderDirtyTab(tabId);
    const resizeIds = {
      'tab-raw':     ['raw-chart'],
      'tab-ftfm':    ['ftfm-chart'],
      'tab-etr':     ['etr-chart'],
      'tab-derived': ['derived-chart'],
      'tab-params':  ['params-chart'],
      'tab-groups':  ['group-etr-chart', 'group-params-chart'],
    };
    (resizeIds[tabId] || []).forEach(id => chartInst[id]?.resize());
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

  // Wire download buttons
  const xlsxSummaryLink = document.getElementById('xlsx-summary-link');
  xlsxSummaryLink.href    = '#';
  xlsxSummaryLink.onclick = e => { e.preventDefault(); downloadXlsxWithCharts(); };
  xlsxSummaryLink.style.display = '';

  const xlsxFullLink    = document.getElementById('xlsx-full-link');
  xlsxFullLink.href     = '#';
  xlsxFullLink.onclick  = e => { e.preventDefault(); downloadFullData(); };
  xlsxFullLink.style.display = '';

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
  const files = lcData.files;
  const t     = lcData.raw_time_us;
  const n     = files.length;

  const datasets = files.map((fname, i) => ({
    label:           fname,
    data:            lcData.raw_curves[fname].map((y, j) => ({ x: t[j], y })),
    borderColor:     sampleColor(i, n),
    backgroundColor: 'transparent',
    borderWidth: 1.5, pointRadius: 0, showLine: true,
  }));

  makeChart('raw-chart', {
    type: 'scatter',
    data: { datasets },
    options: linearScatterOpts('Time (μs)', 'Fluorescence intensity (a.u.)'),
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
  if (hasGroups()) {
    document.getElementById('group-results').style.display = '';
    if (activeTabId() === 'tab-groups') {
      renderGroupEtrChart();
      const gpg = document.querySelector('#group-param-btns .btn-primary')?.dataset?.gpgroup || 'efficiencies';
      renderGroupParamsChart(gpg);
    } else {
      markTabsDirty('tab-groups');
    }
  } else {
    document.getElementById('group-results').style.display = 'none';
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

// ── group ETR chart ───────────────────────────────────────────────────────
function renderGroupEtrChart() {
  const stats    = calcGroupStats();
  const grpNames = Object.keys(stats);
  const par      = lcData.light_intensities;
  const datasets = [];

  grpNames.forEach((grp, gi) => {
    const { means, sds } = stats[grp].etr;
    const c  = groupColor(gi, grpNames.length);
    const ca = groupColor(gi, grpNames.length, 0.18);

    // Upper SD band
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map((m, j) => ({ x: par[j], y: m + sds[j] })),
      fill: '+1',
    });
    // Lower SD band
    datasets.push({
      label: '', showLine: true, pointRadius: 0, borderWidth: 0,
      borderColor: 'transparent', backgroundColor: ca,
      data: means.map((m, j) => ({ x: par[j], y: m - sds[j] })),
      fill: false,
    });
    // Mean line
    datasets.push({
      label: grp, showLine: true, pointRadius: 4, borderWidth: 2.5,
      borderColor: c, backgroundColor: c,
      data: means.map((m, j) => ({ x: par[j], y: m })),
      fill: false,
    });
    // Individual fitted curves (thin, semi-transparent)
    stats[grp].files.forEach(fname => {
      datasets.push({
        label: '', showLine: true, pointRadius: 0, borderWidth: 0.8,
        borderColor: groupColor(gi, grpNames.length, 0.4), backgroundColor: 'transparent',
        data: lcData.step_data[fname].etr_fitted.map((y, j) => ({ x: par[j], y })),
        fill: false,
      });
    });
  });

  const opts = linearScatterOpts('PAR (µmol photons m⁻² s⁻¹)', 'rETR (µmol e⁻ m⁻² s⁻¹)');
  opts.plugins.legend.labels.filter = item => item.text !== '';
  makeChart('group-etr-chart', { type: 'scatter', data: { datasets }, options: opts });
}

// ── group params chart (error bars) ──────────────────────────────────────
function renderGroupParamsChart(pgroup) {
  const keys     = LC_PARAM_GROUPS[pgroup] || PARAM_KEYS;
  const stats    = calcGroupStats();
  const grpNames = Object.keys(stats);
  const labels   = keys.map(k => PARAM_LABELS[k] || k);

  const datasets = grpNames.map((grp, gi) => ({
    label: grp,
    data: keys.map(k => {
      const s = stats[grp].params[k];
      return s ? { y: s.mean, yMin: s.mean - s.sd, yMax: s.mean + s.sd } : null;
    }),
    backgroundColor: groupColor(gi, grpNames.length, 0.65),
    borderColor:     groupColor(gi, grpNames.length),
    borderWidth: 1,
    errorBarColor:        groupColor(gi, grpNames.length),
    errorBarWhiskerColor: groupColor(gi, grpNames.length),
    errorBarLineWidth: 2,
    errorBarWhiskerSize: 8,
  }));

  makeChart('group-params-chart', {
    type: 'barWithErrorBars',
    data: { labels, datasets },
    options: barOpts(),
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

  const charts = [];
  const caps = [
    { id: 'raw-chart',          title: 'Raw Fluorescence' },
    { id: 'ftfm-chart',         title: 'Ft and Fm' },
    { id: 'etr-chart',          title: 'ETR Curves' },
    { id: 'derived-chart',      title: 'Derived Parameters' },
    { id: 'params-chart',       title: 'Parameters' },
    { id: 'group-etr-chart',    title: 'Group ETR Curves' },
    { id: 'group-params-chart', title: 'Group Parameters' },
  ];
  for (const { id, title } of caps) {
    const du = captureCanvas(id);
    if (du) charts.push({ title, data_url: du });
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
    const xlsxResp  = await fetch('/static/' + result.xlsx_path);
    const xlsxBytes = await xlsxResp.arrayBuffer();
    const zip = new JSZip();
    zip.file((lcData.file_stem || 'LC') + '_analysis.xlsx', xlsxBytes);
    zip.file('Methods_section.html', _buildMethodsHtml('Rapid Light Curve Analyzer', generateLCMethodsText()));
    const blob = await zip.generateAsync({ type: 'blob' });
    const dlA  = document.createElement('a');
    dlA.href     = URL.createObjectURL(blob);
    dlA.download = (lcData.file_stem || 'LC') + '_analysis.zip';
    dlA.click();
    setTimeout(function() { URL.revokeObjectURL(dlA.href); }, 1000);
  } catch (err) {
    alert('Export failed: ' + err.message);
  } finally {
    link.style.pointerEvents = '';
    link.innerHTML = '<i class="fa fa-download"></i> Download .zip';
  }
}

// ── download full data xlsx (client-side, SheetJS) ────────────────────────
function downloadFullData() {
  const btn = document.getElementById('xlsx-full-link');
  btn.style.pointerEvents = 'none';
  btn.innerHTML = '<span class="spinner-border spinner-border-sm mr-1"></span> Building…';

  setTimeout(() => {
    try {
      const wb     = XLSX.utils.book_new();
      const files  = lcData.files;
      const par    = lcData.light_intensities;

      function makeStepSheet(key) {
        const aoa = [['PAR', ...files]];
        par.forEach((p, i) => {
          const row = [p];
          for (const f of files) {
            const vals = lcData.step_data[f]?.[key] || [];
            row.push(vals[i] ?? null);
          }
          aoa.push(row);
        });
        return XLSX.utils.aoa_to_sheet(aoa);
      }

      XLSX.utils.book_append_sheet(wb, makeStepSheet('etr_measured'), 'ETR_measured');
      XLSX.utils.book_append_sheet(wb, makeStepSheet('etr_fitted'),   'ETR_fitted');
      XLSX.utils.book_append_sheet(wb, makeStepSheet('ft'),           'Ft');
      XLSX.utils.book_append_sheet(wb, makeStepSheet('fm'),           'Fm');
      XLSX.utils.book_append_sheet(wb, makeStepSheet('qy'),           'QY');
      XLSX.utils.book_append_sheet(wb, makeStepSheet('npq'),          'NPQ');
      XLSX.utils.book_append_sheet(wb, makeStepSheet('qp'),           'qP');
      XLSX.utils.book_append_sheet(wb, makeStepSheet('qn'),           'qN');

      // Raw fluorescence
      const t = lcData.raw_time_us;
      const rawAoa = [['time_us', ...files]];
      t.forEach((tv, i) => {
        const row = [tv];
        for (const f of files) row.push(lcData.raw_curves[f]?.[i] ?? null);
        rawAoa.push(row);
      });
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rawAoa), 'Raw_fluorescence');

      // Parameters
      const paramAoa = [['Sample', ...PARAM_KEYS.map(k => PARAM_LABELS[k] || k)]];
      for (const fname of files) {
        const p   = lcData.params[fname] || {};
        const row = [fname, ...PARAM_KEYS.map(k => p[k] ?? null)];
        paramAoa.push(row);
      }
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(paramAoa), 'Parameters');

      XLSX.writeFile(wb, `${lcData.file_stem}_lc_full_data.xlsx`);
    } catch (err) {
      alert('Full data export failed: ' + err.message);
    } finally {
      btn.style.pointerEvents = '';
      btn.innerHTML = '<i class="fa fa-file-excel-o"></i> Download full data .xlsx';
    }
  }, 30);
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
