// ============================================================
//  CyanoTools Slow Kinetics Analyzer — frontend logic
//  Chart.js 4.x + chartjs-chart-error-bars
// ============================================================

// ── state ─────────────────────────────────────────────────────────────────
let skData    = null;   // full JSON from /api/slow_kin_process
let groups    = {};     // {filename: groupName}
let chartInst = {};     // {chartId: Chart instance}
let dirtyTabs = new Set();

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
  chartInst[id] = new Chart(el, cfg);
  return chartInst[id];
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
      setTimeout(function() {
        ['sk-group-traces-chart', 'sk-group-derived-chart', 'sk-group-params-chart'].forEach(function(id) {
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

  // Export to statistics
  var exportBtn = document.getElementById('sk-export-stats-btn');
  if (exportBtn) exportBtn.addEventListener('click', exportToStatistics);

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
        'sk-tab-groups':  ['sk-group-traces-chart', 'sk-group-derived-chart', 'sk-group-params-chart'],
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

  // Wire download buttons
  var xlsxLink    = document.getElementById('sk-xlsx-download-link');
  var xlsxFullBtn = document.getElementById('sk-xlsx-fulldata-btn');
  if (xlsxLink) {
    xlsxLink.style.display = '';
    xlsxLink.href = '#';
    xlsxLink.onclick = function(e) { e.preventDefault(); downloadXlsx(); };
  }
  if (xlsxFullBtn) {
    xlsxFullBtn.style.display = '';
    xlsxFullBtn.onclick = downloadXlsx;
  }

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
}

// ── traces chart ──────────────────────────────────────────────────────────
function renderTracesChart() {
  if (!skData) return;
  var files = skData.files;
  var t     = skData.raw_time;
  var n     = files.length;
  var datasets = files.map(function(fname, i) {
    return {
      label:           fname,
      data:            (skData.raw_traces[fname] || []).map(function(y, j) { return { x: t[j], y: y }; }),
      borderColor:     sampleColor(i, n),
      backgroundColor: 'transparent',
      borderWidth: 1.5, pointRadius: 0, showLine: true,
    };
  });
  makeChart('sk-traces-chart', {
    type: 'scatter',
    data: { datasets: datasets },
    options: linearScatterOpts(timeAxisLabel(skData.time_unit), 'Fluorescence (a.u.)'),
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
      setTimeout(function() {
        ['sk-group-traces-chart', 'sk-group-derived-chart', 'sk-group-params-chart'].forEach(function(id) {
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
  var traceStats  = calcGroupTraceStats();
  var grpNames    = Object.keys(traceStats);
  var t           = skData.raw_time;
  var showIndiv   = (document.getElementById('sk-show-individual-check') || {}).checked !== false;
  var datasets    = [];

  grpNames.forEach(function(grp, gi) {
    var means = traceStats[grp].means;
    var sds   = traceStats[grp].sds;
    var files = traceStats[grp].files;
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
      label: grp, showLine: true, pointRadius: 0, borderWidth: 2.5,
      borderColor: c, backgroundColor: c,
      data: means.map(function(m, j) { return { x: t[j], y: m }; }),
      fill: false,
    });
    if (showIndiv) {
      files.forEach(function(fname) {
        datasets.push({
          label: '', showLine: true, pointRadius: 0, borderWidth: 0.8,
          borderColor: groupColor(gi, grpNames.length, 0.4), backgroundColor: 'transparent',
          data: (skData.raw_traces[fname] || []).map(function(y, j) { return { x: t[j], y: y }; }),
          fill: false,
        });
      });
    }
  });

  var opts = linearScatterOpts(timeAxisLabel(skData.time_unit), 'Fluorescence (a.u.)');
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
        '<input type="checkbox" class="sk-export-tp-check" data-metric="' + item.key + '" data-idx="' + idx + '" checked> ' +
        lbl + '</label>';
    }).join('');
    return '<div class="mb-2">' +
      '<div class="d-flex align-items-center">' +
        '<input type="checkbox" class="sk-export-metric-check mr-1" id="sk-expchk-' + item.key + '" data-metric="' + item.key + '" checked>' +
        '<label class="font-weight-bold mb-0 mr-2" for="sk-expchk-' + item.key + '">' + item.label + '</label>' +
        '<span class="badge badge-primary mr-2" id="sk-tp-count-' + item.key + '">' + n + '/' + n + '</span>' +
        '<a href="#" class="text-muted sk-tp-toggle" data-tptarget="' + item.key + '" style="font-size:0.8em">▾ time points</a>' +
      '</div>' +
      '<div id="sk-exptp-' + item.key + '" class="mt-1 ml-3" style="display:none">' + tpHtml + '</div>' +
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

  // Change delegation: metric toggles time points; time point updates badge + indeterminate
  modal.addEventListener('change', function(e) {
    var cb = e.target;
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
    modal.querySelectorAll('.sk-export-tp-check, .sk-export-summary-check').forEach(function(cb) { cb.checked = true; });
    modal.querySelectorAll('.sk-export-metric-check').forEach(function(cb) {
      cb.checked = true; cb.indeterminate = false; _updateTpCountBadge(cb.dataset.metric);
    });
    _updateExportColCount();
  });
  if (selNone) selNone.addEventListener('click', function() {
    modal.querySelectorAll('.sk-export-tp-check, .sk-export-summary-check').forEach(function(cb) { cb.checked = false; });
    modal.querySelectorAll('.sk-export-metric-check').forEach(function(cb) {
      cb.checked = false; cb.indeterminate = false; _updateTpCountBadge(cb.dataset.metric);
    });
    _updateExportColCount();
  });

  // Apply single step to all metrics
  var tpApplyBtn = document.getElementById('sk-export-tp-apply');
  if (tpApplyBtn) tpApplyBtn.addEventListener('click', function() {
    var tpSel = document.getElementById('sk-export-tp-select');
    if (!tpSel || !skData) return;
    var selectedLbl = (tpSel.options[tpSel.selectedIndex] || {}).dataset && tpSel.options[tpSel.selectedIndex].dataset.lbl;
    if (selectedLbl == null) return;

    modal.querySelectorAll('.sk-export-metric-check').forEach(function(metricCb) {
      var metric = metricCb.dataset.metric;
      var tpList = document.getElementById('sk-exptp-' + metric);
      if (!tpList) return;
      var matched = false;
      tpList.querySelectorAll('.sk-export-tp-check').forEach(function(tpCb) {
        var idx = parseInt(tpCb.dataset.idx, 10);
        var isNpq = _NPQ_METRICS_SET.indexOf(metric) >= 0 && skData.param_time_npq;
        var t = isNpq ? skData.param_time_npq : skData.param_time;
        var lbl = (skData.param_labels && skData.param_labels[metric] && skData.param_labels[metric][idx] != null)
          ? String(skData.param_labels[metric][idx])
          : (t && t[idx] != null ? String(t[idx]) : String(idx));
        var match = (lbl === selectedLbl);
        tpCb.checked = match;
        if (match) matched = true;
      });
      metricCb.checked = matched;
      metricCb.indeterminate = false;
      _updateTpCountBadge(metric);
      // Expand the time point list so user can see the selection
      var tpDiv = document.getElementById('sk-exptp-' + metric);
      var toggleA = modal.querySelector('.sk-tp-toggle[data-tptarget="' + metric + '"]');
      if (tpDiv && tpDiv.style.display === 'none') {
        tpDiv.style.display = '';
        if (toggleA) toggleA.textContent = '▴ time points';
      }
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

  // Populate step dropdown from param_time labels (ft labels cover all steps incl. Dark)
  var tpSel = document.getElementById('sk-export-tp-select');
  if (tpSel && skData.param_time) {
    var opts = skData.param_time.map(function(tv, idx) {
      var lbl = (skData.param_labels && skData.param_labels.ft && skData.param_labels.ft[idx] != null)
        ? String(skData.param_labels.ft[idx]) : String(tv);
      return '<option value="' + idx + '" data-lbl="' + lbl + '">' + lbl + '</option>';
    });
    tpSel.innerHTML = opts.join('');
  }

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
    var payload = JSON.stringify(skData);
    var resp    = await fetch('/api/slow_kin_export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    var data = await resp.json();

    if (data.status !== 'success') {
      if (statusEl) statusEl.textContent = 'Export failed: ' + data.message;
      return;
    }

    var a = document.createElement('a');
    a.href     = '/static/' + data.xlsx_path;
    a.download = data.xlsx_path.split('/').pop();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (statusEl) statusEl.textContent = '';

  } catch (err) {
    if (statusEl) statusEl.textContent = 'Export error: ' + err.message;
  } finally {
    if (xlsxLink) xlsxLink.style.pointerEvents = '';
  }
}
