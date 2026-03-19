'use strict';

// ---- State ----
var eemData = null;
var groups = {};
var chartInst = {};
var dirtyTabs = new Set();
var selectedFiles = [];
var normMode = 'peak';
var mapMetaStore = {};
var groupFileOrder = [];
var isSingleEx = false;
var focusExWl = null;
var deconvPeakMus = [689, 724];
var deconvFitParams = null;
var deconvCurrentData = null;
var analysisMode = '77K';

// ---- Color palettes ----
var spectraColorPalette = 'default';
var spectraSection = 'emission';
var refNormMode = 'fixed';
var PALETTES = {
    default: [
        '#4472C4','#ED7D31','#A9D18E','#FF0000','#7030A0',
        '#00B0F0','#FFC000','#70AD47','#FF69B4','#00B050',
        '#C00000','#002060','#833C00','#375623','#7F7F7F'
    ],
    spectral: [
        '#9e0142','#d53e4f','#f46d43','#fdae61','#fee08b',
        '#e6f598','#abdda4','#66c2a5','#3288bd','#5e4fa2',
        '#762a83','#1b7837','#2166ac','#b2abd2','#4d9221'
    ],
    warm: [
        '#a50026','#d73027','#f46d43','#fdae61','#fee090',
        '#ff7700','#ffcc00','#cc2200','#ff5500','#e06020',
        '#b03010','#ff9900','#dc143c','#c85000','#7f0000'
    ],
    cool: [
        '#313695','#4575b4','#74add1','#abd9e9','#5e4fa2',
        '#1a9641','#66c2a5','#3288bd','#00441b','#2171b5',
        '#35978f','#7b3294','#6baed6','#1f78b4','#2c7bb6'
    ],
    qualitative: [
        '#e41a1c','#377eb8','#4daf4a','#984ea3','#ff7f00',
        '#a65628','#f781bf','#1b9e77','#d95f02','#7570b3',
        '#e7298a','#66a61e','#e6ab02','#a6761d','#666666'
    ]
};
var FILE_COLORS = PALETTES.default;

// ---- Parameter config ----
var PARAM_KEYS = [
    'Chl_PSII','Chl_PSI','Chl_tot',
    'Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI',
    'PBS_free','PBS_PSII','PBS_PSI','PBS_tot',
    'PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm',
    'PBS_PSII_to_PBS_PSI','PC_to_PE'
];
var PARAM_LABELS = {
    'Chl_PSII':             'Chl-PSII (a.u.)',
    'Chl_PSI':              'Chl-PSI (a.u.)',
    'Chl_tot':              'Chl total (a.u.)',
    'Chl_PSII_norm':        'Chl-PSII / Chl-tot',
    'Chl_PSI_norm':         'Chl-PSI / Chl-tot',
    'PSII_to_PSI':          'PSII : PSI',
    'PBS_free':             'PBS-free (a.u.)',
    'PBS_PSII':             'PBS-PSII (a.u.)',
    'PBS_PSI':              'PBS-PSI (a.u.)',
    'PBS_tot':              'PBS total (a.u.)',
    'PBS_free_norm':        'PBS-free / PBS-tot',
    'PBS_PSII_norm':        'PBS-PSII / PBS-tot',
    'PBS_PSI_norm':         'PBS-PSI / PBS-tot',
    'PBS_PSII_to_PBS_PSI':  'PBS-PSII : PBS-PSI',
    'PC_to_PE':             'PC : PE'
};
var PIGM_PARAMS = {
    'checkbox_chl_only':   ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI'],
    'checkbox_chl_PC':     ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI',
                            'PBS_free','PBS_PSII','PBS_PSI','PBS_tot','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PBS_PSII_to_PBS_PSI'],
    'checkbox_chl_PE':     ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI',
                            'PBS_free','PBS_PSII','PBS_PSI','PBS_tot','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PBS_PSII_to_PBS_PSI'],
    'checkbox_chl_PC_PE':  ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI',
                            'PBS_free','PBS_PSII','PBS_PSI','PBS_tot','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PBS_PSII_to_PBS_PSI','PC_to_PE']
};
var RATIO_PARAMS = ['PSII_to_PSI','Chl_PSII_norm','Chl_PSI_norm',
                    'PBS_PSII_to_PBS_PSI','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PC_to_PE'];

// ---- RT fluorescence param config ----
var RT_PARAM_KEYS = [
    'F685', 'F695', 'F730',
    'F685_to_F730', 'F695_to_F730', 'F695_to_F685',
    'PBS_F657', 'PBS_F685', 'PBS_F705', 'PBS_F730', 'PBS_tot',
    'PBS_free_norm', 'PBS_PSII_norm', 'PBS_PSI_norm',
    'PBS_F685_to_F705', 'PBS_F685_to_F730'
];
var RT_PARAM_LABELS = {
    'F685':             'F685 – PSII core (a.u.)',
    'F695':             'F695 – CP47 (a.u.)',
    'F730':             'F730 – PSI (a.u.)',
    'F685_to_F730':     'F685 / F730  (PSII:PSI, Ex440)',
    'F695_to_F730':     'F695 / F730  (CP47:PSI, Ex440)',
    'F695_to_F685':     'F695 / F685  (CP47:PSII core)',
    'PBS_F657':         'PBS free (a.u., Ex620/Em657)',
    'PBS_F685':         'PBS→PSII (a.u., Ex620/Em685)',
    'PBS_F705':         'PBS→PSI (a.u., Ex620/Em705)',
    'PBS_F730':         'PBS→F730 (a.u., Ex620/Em730)',
    'PBS_tot':          'PBS total (a.u., Ex620)',
    'PBS_free_norm':    'PBS free / PBS total  (uncoupled fraction)',
    'PBS_PSII_norm':    'PBS-PSII / PBS total  (PSII coupling fraction)',
    'PBS_PSI_norm':     'PBS-PSI / PBS total  (PSI coupling fraction)',
    'PBS_F685_to_F705': 'PBS F685 / F705  (state transitions, Ex620)',
    'PBS_F685_to_F730': 'PBS F685 / F730  (Ex620)'
};
var RT_RATIO_PARAMS = [
    'F685_to_F730', 'F695_to_F730', 'F695_to_F685',
    'PBS_free_norm', 'PBS_PSII_norm', 'PBS_PSI_norm',
    'PBS_F685_to_F705', 'PBS_F685_to_F730'
];

// Default Ex/Em wavelengths per mode
var MODE_DEFAULTS = {
    '77K': {
        ex: [360, 440, 560, 620, '', ''],
        em: [662, 689, 724, '', '', ''],
        ex_norm: 620, em_norm: 724
    },
    'RT': {
        ex: [440, 620, '', '', '', ''],
        em: [650, 660, 685, 695, 730, ''],
        ex_norm: 440, em_norm: 685
    }
};

// ============================================================
// File handling / drop zone
// ============================================================
function handleFiles(files) {
    selectedFiles = Array.from(files).filter(function(f) {
        var n = f.name.toLowerCase();
        return n.endsWith('.csv') || n.endsWith('.spc') || n.endsWith('.txt');
    });
    var label = document.getElementById('eem-file-count-label');
    var listEl = document.getElementById('eem-file-list');
    var btn = document.getElementById('eem-analyze-btn');
    if (selectedFiles.length === 0) {
        label.textContent = 'No files selected';
        listEl.innerHTML = '';
        btn.disabled = true;
        return;
    }
    label.textContent = selectedFiles.length + ' file(s) selected';
    listEl.style.display = 'flex';
    listEl.style.flexWrap = 'wrap';
    listEl.style.gap = '2px 12px';
    listEl.innerHTML = selectedFiles.map(function(f) {
        return '<span class="text-muted" style="white-space:nowrap; font-size:0.83em;">' +
               '<i class="fa fa-file-o mr-1"></i>' + f.name + '</span>';
    }).join('');
    btn.disabled = false;
}

// ============================================================
// Spectrofluorometer hint
// ============================================================
var SPECTROFLUOROMETER_HINTS = {
    'jasco':  'Upload one .csv file per sample (full EEM exported from Jasco FP-8050/8550 EEM mode).',
    'aminco': 'Upload one .txt file per sample (native AMINCO-Bowman Series 2 EEM export — whitespace-delimited, multiple emission scans at successive excitation wavelengths).',
    'horiba': 'Upload all .spc files for each sample together (Galactic SPC K-format). Each file = one emission scan at one excitation wavelength. Files with the same name prefix (e.g. DISC_00.spc … DISC_50.spc) are automatically combined into one 2D EEM. Multiple sample sets can be uploaded at once.'
};
function updateSpectrofluorometerHint() {
    var sel = document.getElementById('eem-spectrofluorometer');
    var hint = document.getElementById('eem-spectrofluorometer-hint');
    if (!sel || !hint) return;
    hint.textContent = SPECTROFLUOROMETER_HINTS[sel.value] || '';
    var spcParams = document.getElementById('spc-ex-params');
    if (spcParams) spcParams.style.display = sel.value === 'horiba' ? 'block' : 'none';
}

// ============================================================
// Analysis mode switch (77K / RT)
// ============================================================
// ── Pigmentation helpers ──────────────────────────────────────────────────────

function getPigmentation() {
    var sel = document.getElementById('global-pigm-select');
    if (sel) return sel.value;
    var el = document.querySelector('input[name="checkbox_pigmentation"]:checked');
    return el ? el.value : 'checkbox_chl_PC';
}

function switchPigmentation(val) {
    // Sync global select
    var sel = document.getElementById('global-pigm-select');
    if (sel && sel.value !== val) sel.value = val;
    // Sync radio buttons in Derived Parameters tab
    document.querySelectorAll('input[name="checkbox_pigmentation"]').forEach(function(r) {
        r.checked = (r.value === val);
    });
    recomputeParamsFromMaps();
    // Re-annotate PARAFAC components client-side (no re-fit needed)
    if (parafacResults) _reAnnotateParafacComponents(val);
}

// Client-side fluorophore table (mirrors backend _FLUOROPHORE_TABLE)
var _JS_FLUOROPHORE_TABLE = [
    {ex: 440, em: 689, label: 'Chl-PSII',      pigm: ['checkbox_chl_only','checkbox_chl_PC','checkbox_chl_PE','checkbox_chl_PC_PE']},
    {ex: 440, em: 724, label: 'Chl-PSI',        pigm: ['checkbox_chl_only','checkbox_chl_PC','checkbox_chl_PE','checkbox_chl_PC_PE']},
    {ex: 620, em: 662, label: 'PBS-free (PC)',   pigm: ['checkbox_chl_PC','checkbox_chl_PC_PE']},
    {ex: 620, em: 689, label: 'PBS\u2192PSII',  pigm: ['checkbox_chl_PC','checkbox_chl_PC_PE']},
    {ex: 620, em: 724, label: 'PBS\u2192PSI',   pigm: ['checkbox_chl_PC','checkbox_chl_PC_PE']},
    {ex: 560, em: 580, label: 'PE direct',       pigm: ['checkbox_chl_PE','checkbox_chl_PC_PE']},
    {ex: 560, em: 662, label: 'PE\u2192PC',      pigm: ['checkbox_chl_PE','checkbox_chl_PC_PE']},
    {ex: 560, em: 689, label: 'PE\u2192PSII',   pigm: ['checkbox_chl_PE','checkbox_chl_PC_PE']},
    {ex: 560, em: 724, label: 'PE\u2192PSI',    pigm: ['checkbox_chl_PE','checkbox_chl_PC_PE']}
];

function _jsAnnotateComponent(exWl, emWl, exLoading, emLoading, pigm, tol) {
    tol = tol || 15;
    var exPeak = exWl[exLoading.indexOf(Math.max.apply(null, exLoading))];
    var emPeak = emWl[emLoading.indexOf(Math.max.apply(null, emLoading))];
    var bestLabel = null, bestD = Infinity;
    _JS_FLUOROPHORE_TABLE.forEach(function(f) {
        if (f.pigm.indexOf(pigm) === -1) return;
        var dx = Math.abs(exPeak - f.ex), de = Math.abs(emPeak - f.em);
        if (dx <= tol && de <= tol) {
            var d = Math.sqrt(dx*dx + de*de);
            if (d < bestD) { bestD = d; bestLabel = f.label; }
        }
    });
    return (bestLabel || 'Unknown') + ' (Ex' + Math.round(exPeak) + '/Em' + Math.round(emPeak) + ')';
}

function _reAnnotateParafacComponents(pigm) {
    if (!parafacResults) return;
    var data = parafacResults;
    for (var r = 0; r < data.n_components; r++) {
        var annot = _jsAnnotateComponent(data.ex_wl, data.em_wl,
                                         data.ex_loadings[r], data.em_loadings[r], pigm);
        parafacAnnotations[r] = annot;
        // Update the editable input in the component card
        var inp = document.getElementById('par-annot-' + r);
        if (inp) inp.value = annot;
    }
    // Refresh scores chart and comp map labels with new annotations
    _renderParafacScoresChart(data);
    _refreshParafacCompMapLabels(data);
}

function _refreshParafacCompMapLabels(data) {
    for (var r = 0; r < data.n_components; r++) {
        var lbl = document.querySelector('#parafac-comp-map-' + r +
                  ' .font-weight-bold.text-truncate');
        if (lbl) lbl.textContent =
            'C' + (r+1) + ': ' + (parafacAnnotations[r] || 'Component '+(r+1));
    }
}

// ─────────────────────────────────────────────────────────────────────────────

function switchAnalysisMode(mode) {
    analysisMode = mode;

    // Update segmented control appearance (all mode button groups)
    document.querySelectorAll('#eem-mode-btns .btn, #eem-mode-btns-upload .btn, #eem-mode-btns-global .btn').forEach(function(btn) {
        var isActive = btn.dataset.mode === mode;
        btn.classList.toggle('btn-primary', isActive);
        btn.classList.toggle('btn-outline-primary', !isActive);
    });

    // Update page title + hint text
    var title = document.getElementById('eem-page-title');
    var alertEl = document.getElementById('eem-page-alert');
    var hints = document.querySelectorAll('.eem-mode-hint');
    if (mode === 'RT') {
        if (title) title.innerHTML = '<i class="fa fa-th text-primary mr-2"></i>RT Fluorescence Spectra &amp; EEM Analyzer';
        if (alertEl) alertEl.innerHTML = '<strong>At a glance:</strong> Upload excitation-emission fluorescence maps measured at room temperature to assess PSII/PSI energy distribution and state transitions (F685/F730 ratio). Supports batch processing of up to 100 files with interactive charts, replicate grouping, and export to .xlsx.';
        hints.forEach(function(h) { h.textContent = 'Room-temperature fluorescence — PSII/PSI balance, state transitions (F685/F730)'; });
        // Show/hide pigmentation step — not used at RT
        var pigmGroup = document.getElementById('eem-pigm-step');
        if (pigmGroup) pigmGroup.style.display = 'none';
        var globalPigm = document.getElementById('global-pigm-group');
        if (globalPigm) globalPigm.style.display = 'none';
    } else {
        if (title) title.innerHTML = '<i class="fa fa-th text-primary mr-2"></i>77K Fluorescence Spectra &amp; EEM Analyzer';
        if (alertEl) alertEl.innerHTML = '<strong>At a glance:</strong> Upload 3D excitation-emission fluorescence maps measured at 77 K to visualize pigment-protein complex composition and calculate PSII/PSI ratios and phycobilisome coupling states. Supports batch processing of up to 100 files with interactive charts, replicate grouping, and export to .xlsx.';
        hints.forEach(function(h) { h.textContent = 'Low-temperature EEM — photosystem stoichiometry & PBS coupling'; });
        var pigmGroup = document.getElementById('eem-pigm-step');
        if (pigmGroup) pigmGroup.style.display = '';
        var globalPigm = document.getElementById('global-pigm-group');
        if (globalPigm) globalPigm.style.display = '';
    }

    // Update default Ex/Em wavelengths and norm values if inputs are untouched
    var defs = MODE_DEFAULTS[mode];
    for (var i = 1; i <= 6; i++) {
        var exEl = document.getElementById('eem-ex-' + i);
        var emEl = document.getElementById('eem-em-' + i);
        if (exEl) exEl.value = defs.ex[i-1] || '';
        if (emEl) emEl.value = defs.em[i-1] || '';
    }
    var exNorm = document.getElementById('eem-ex-norm');
    var emNorm = document.getElementById('eem-em-norm');
    if (exNorm) exNorm.value = defs.ex_norm;
    if (emNorm) emNorm.value = defs.em_norm;

    updateDerivedParamHint();

    // If data already loaded, sync and recompute derived parameters client-side
    if (eemData) {
        eemData.analysis_mode = mode;
        recomputeParamsFromMaps();
    }
}

// ============================================================
// Upload & Process
// ============================================================
function uploadAndAnalyze() {
    if (!selectedFiles.length) return;

    var fd = new FormData();
    fd.append('analysis_mode', analysisMode);
    fd.append('spectrofluorometer', document.getElementById('eem-spectrofluorometer').value);
    fd.append('checkbox_pigmentation', getPigmentation());
    for (var i = 1; i <= 6; i++) {
        fd.append('ex_' + i, (document.getElementById('eem-ex-' + i) || {}).value || '');
        fd.append('em_' + i, (document.getElementById('eem-em-' + i) || {}).value || '');
    }
    fd.append('ex_for_norm', document.getElementById('eem-ex-norm').value || '');
    fd.append('em_for_norm', document.getElementById('eem-em-norm').value || '');
    fd.append('spc_ex_start', (document.getElementById('spc-ex-start') || {}).value || '');
    fd.append('spc_ex_increment', (document.getElementById('spc-ex-increment') || {}).value || '');
    selectedFiles.forEach(function(f) { fd.append('77K_files', f); });

    var btn = document.getElementById('eem-analyze-btn');
    var spinner = document.getElementById('eem-spinner');
    btn.disabled = true;
    spinner.style.display = 'inline-block';
    document.getElementById('eem-results-section').style.display = 'none';
    document.getElementById('eem-upload-error').style.display = 'none';

    fetch('/api/eem_process', { method: 'POST', body: fd })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            spinner.style.display = 'none';
            btn.disabled = false;
            if (data.error) { showError(data.error); return; }

            eemData = data;
            groups = {};
            chartInst = {};
            dirtyTabs = new Set(['spectra', 'map', 'derived', 'groups']);
            parafacResults = null;
            parafacDiagResults = null;
            groupFileOrder = data.files.slice();
            focusExWl = null;
            deconvFitParams = null;
            deconvCurrentData = null;

            var summary = document.getElementById('eem-results-summary');
            summary.innerHTML = '<strong>' + data.files.length + ' file(s) processed:</strong> ' +
                data.files.join(', ') +
                (data.warnings && data.warnings.length ?
                    '<br><span class="text-warning"><i class="fa fa-exclamation-triangle"></i> ' +
                    data.warnings.join('; ') + '</span>' : '');

            // Reset map grid so it gets rebuilt with new files
            var grid = document.getElementById('eem-maps-grid');
            if (grid) grid.innerHTML = '';

            document.getElementById('eem-results-section').style.display = '';
            detectSingleEx();
            initDeconvUI(true);

            document.getElementById('eem-spectra-tab').click();
            renderSpectraTab();
        })
        .catch(function(e) {
            document.getElementById('eem-spinner').style.display = 'none';
            document.getElementById('eem-analyze-btn').disabled = false;
            showError('Upload failed: ' + e.message);
        });
}

function showError(msg) {
    var el = document.getElementById('eem-upload-error');
    el.textContent = msg;
    el.style.display = '';
}

// ============================================================
// Single-excitation mode
// ============================================================
function detectSingleEx() {
    if (!eemData || !eemData.files.length) return;
    isSingleEx = eemData.files.every(function(f) {
        return eemData.maps[f] && eemData.maps[f].ex_wl.length === 1;
    });

    var badge   = document.getElementById('eem-single-ex-info');
    var focusRow = document.getElementById('eem-focus-ex-row');
    var mapNote = document.getElementById('eem-map-single-ex-note');

    if (isSingleEx) {
        var exWl = eemData.maps[eemData.files[0]].ex_wl[0];
        badge.innerHTML = '<span class="badge badge-warning">' +
            '<i class="fa fa-info-circle mr-1"></i>Single excitation: Ex ' +
            Math.round(exWl) + ' nm (auto-detected)</span>';
        badge.style.display = '';
        focusRow.style.display = 'none';
        if (mapNote) mapNote.style.display = '';
    } else {
        badge.style.display = 'none';
        if (mapNote) mapNote.style.display = 'none';
        buildFocusExSelector();
    }
}

function buildFocusExSelector() {
    var sel = document.getElementById('eem-focus-ex-select');
    sel.innerHTML = '<option value="">All</option>';
    (eemData.ex_wls || []).forEach(function(ex) {
        var opt = document.createElement('option');
        opt.value = String(ex);
        opt.textContent = ex + ' nm';
        sel.appendChild(opt);
    });
    var row = document.getElementById('eem-focus-ex-row');
    row.style.display = (eemData.ex_wls.length > 1) ? '' : 'none';
}

function setFocusEx(val) {
    focusExWl = val ? parseFloat(val) : null;
    if (eemData) renderSpectraTab();
}

// ============================================================
// Chart helper
// ============================================================
function makeChartCanvas(containerId, chartKey, colClass, titleText) {
    if (chartInst[chartKey]) {
        chartInst[chartKey].destroy();
        delete chartInst[chartKey];
    }
    var div = document.createElement('div');
    div.className = colClass + ' mb-3';
    var canvas = document.createElement('canvas');
    canvas.id = 'chart-' + chartKey;
    canvas.height = 260;
    canvas.style.cursor = 'pointer';
    canvas.title = 'Click to enlarge';
    canvas.addEventListener('click', function() {
        openEnlargedChart(canvas, titleText || '');
    });
    div.appendChild(canvas);
    document.getElementById(containerId).appendChild(div);
    return canvas;
}

function openEnlargedChart(canvasEl, titleText) {
    var img = document.getElementById('eem-chart-modal-img');
    var titleEl = document.getElementById('eem-chart-modal-title');
    if (!img || !canvasEl) return;
    img.src = canvasEl.toDataURL('image/png');
    if (titleEl) titleEl.textContent = titleText || '';
    $('#eem-chart-enlarge-modal').modal('show');
}

// ============================================================
// Normalization
// ============================================================
function areaNormalize(vals) {
    var sum = vals.reduce(function(a, b) { return a + b; }, 0);
    if (sum === 0) return vals;
    return vals.map(function(v) { return v / sum; });
}

function peakNormalize(vals) {
    var mx = Math.max.apply(null, vals);
    if (mx === 0) return vals;
    return vals.map(function(v) { return v / mx; });
}

function getSpectrumData(spec, fname) {
    if (normMode === 'raw') return spec.raw[fname] || null;
    if (normMode === 'peak') {
        var raw = spec.raw[fname];
        return raw ? peakNormalize(raw) : null;
    }
    if (normMode === 'area') {
        var raw = spec.raw[fname];
        return raw ? areaNormalize(raw) : null;
    }
    if (normMode === 'ref') {
        return (spec.norm[fname] && spec.norm[fname].length) ? spec.norm[fname] : (spec.raw[fname] || null);
    }
    return spec.raw[fname] || null;
}

// ============================================================
// Spectra Tab
// ============================================================
function renderSpectraTab() {
    if (!eemData) return;
    dirtyTabs.delete('spectra');

    // Emission spectra — filter by focusExWl if set
    var emCont = document.getElementById('spectra-emission-charts');
    emCont.innerHTML = '';
    var exList = eemData.ex_wls.filter(function(ex) {
        return focusExWl === null || ex === focusExWl;
    });
    var emColClass = exList.length === 1 ? 'col-12' : exList.length === 2 ? 'col-md-6' : 'col-xl-4 col-md-6';
    exList.forEach(function(exWl) {
        var spec = eemData.emission_spectra[String(exWl)];
        if (!spec || !spec.wl.length) return;
        var canvas = makeChartCanvas('spectra-emission-charts', 'em-ex-' + exWl, emColClass, 'Emission @ Ex ' + exWl + ' nm');
        chartInst['em-ex-' + exWl] = buildSpectraChart(
            canvas, spec, 'Emission @ Ex ' + exWl + ' nm', 'Emission (nm)'
        );
    });

    // Excitation spectra — not filtered by focus Ex
    var exCont = document.getElementById('spectra-excitation-charts');
    exCont.innerHTML = '';
    var emList = eemData.em_wls;
    var exColClass = emList.length === 1 ? 'col-12' : emList.length === 2 ? 'col-md-6' : 'col-xl-4 col-md-6';
    emList.forEach(function(emWl) {
        var spec = eemData.excitation_spectra[String(emWl)];
        if (!spec || !spec.wl.length) return;
        var canvas = makeChartCanvas('spectra-excitation-charts', 'ex-em-' + emWl, exColClass, 'Excitation @ Em ' + emWl + ' nm');
        chartInst['ex-em-' + emWl] = buildSpectraChart(
            canvas, spec, 'Excitation @ Em ' + emWl + ' nm', 'Excitation (nm)'
        );
    });

    // Update toggle visibility: hide excitation button if no em_wls, hide emission if no ex_wls
    var hasEm = exList.length > 0;
    var hasEx = emList.length > 0;
    var toggle = document.getElementById('spectra-section-toggle');
    if (toggle) toggle.style.display = (hasEm && hasEx) ? '' : 'none';
    // If current section has no data, switch to the other
    if (spectraSection === 'excitation' && !hasEx && hasEm) switchSpectraSection('emission');
    else if (spectraSection === 'emission' && !hasEm && hasEx) switchSpectraSection('excitation');
    else {
        document.getElementById('spectra-emission-section').style.display = spectraSection === 'emission' ? '' : 'none';
        document.getElementById('spectra-excitation-section').style.display = spectraSection === 'excitation' ? '' : 'none';
    }
}

function buildSpectraChart(canvas, spec, title, xLabel) {
    var palette = PALETTES[spectraColorPalette] || PALETTES.default;
    var datasets = eemData.files.map(function(fname, fi) {
        var vals = getSpectrumData(spec, fname);
        if (!vals) return null;
        return {
            label: fname,
            data: spec.wl.map(function(w, i) { return {x: w, y: vals[i]}; }),
            borderColor: palette[fi % palette.length],
            backgroundColor: 'transparent',
            showLine: true, borderWidth: 1.5, pointRadius: 0, tension: 0
        };
    }).filter(Boolean);

    var yLabel = normMode === 'raw'  ? 'Fluorescence (a.u.)'
               : normMode === 'area' ? 'Rel. fluorescence (area norm.)'
               : normMode === 'ref'  ? 'Rel. fluorescence (ref. λ norm.)'
               : 'Rel. fluorescence (peak norm.)';

    return new Chart(canvas, {
        type: 'scatter',
        data: { datasets: datasets },
        options: {
            animation: false, responsive: true,
            plugins: {
                title: { display: true, text: title },
                legend: {
                    display: true,
                    labels: { boxWidth: 10, padding: 6, font: { size: 9 } }
                }
            },
            scales: {
                x: { title: { display: true, text: xLabel } },
                y: { title: { display: true, text: yLabel } }
            }
        }
    });
}

function updateDerivedParamHint() {
    var el = document.getElementById('derived-param-hint');
    if (!el) return;
    var items;
    if (analysisMode === 'RT') {
        items = [
            'Ex440/Em685 <span class="text-muted">(F685)</span>',
            'Ex440/Em695 <span class="text-muted">(F695)</span>',
            'Ex440/Em730 <span class="text-muted">(F730)</span>',
            'Ex620/Em657 <span class="text-muted">(PBS-free)</span>',
            'Ex620/Em685 <span class="text-muted">(PBS-PSII)</span>',
            'Ex620/Em705 <span class="text-muted">(PBS-PSI)</span>',
            'Ex620/Em730 <span class="text-muted">(PBS-F730)</span>'
        ];
    } else {
        var pigm = getPigmentation();
        items = [
            'Ex440/Em689 <span class="text-muted">(Chl-PSII)</span>',
            'Ex440/Em724 <span class="text-muted">(Chl-PSI)</span>'
        ];
        if (pigm === 'checkbox_chl_PC') {
            items = items.concat([
                'Ex620/Em662 <span class="text-muted">(PBS-free)</span>',
                'Ex620/Em689 <span class="text-muted">(PBS-PSII)</span>',
                'Ex620/Em724 <span class="text-muted">(PBS-PSI)</span>'
            ]);
        } else if (pigm === 'checkbox_chl_PE') {
            items = items.concat([
                'Ex560/Em580+662 <span class="text-muted">(PBS-free)</span>',
                'Ex560/Em689 <span class="text-muted">(PBS-PSII)</span>',
                'Ex560/Em724 <span class="text-muted">(PBS-PSI)</span>'
            ]);
        } else if (pigm === 'checkbox_chl_PC_PE') {
            items = items.concat([
                'Ex560/Em580+662 + Ex620/Em662 <span class="text-muted">(PBS-free)</span>',
                'Ex560+620/Em689 <span class="text-muted">(PBS-PSII)</span>',
                'Ex560+620/Em724 <span class="text-muted">(PBS-PSI)</span>'
            ]);
        }
    }
    el.innerHTML = '<i class="fa fa-info-circle text-info mr-1"></i>' +
        '<span class="text-muted">Active measurements:</span> ' + items.join(' &thinsp;·&thinsp; ');
}

function switchRefNormMode(mode) {
    refNormMode = mode;
    document.getElementById('ref-norm-fixed-inputs').style.display  = mode === 'fixed'  ? '' : 'none';
    document.getElementById('ref-norm-window-inputs').style.display = mode === 'window' ? '' : 'none';
    document.querySelectorAll('#ref-norm-mode-btns button').forEach(function(btn) {
        var active = btn.getAttribute('data-refmode') === mode;
        btn.classList.toggle('btn-primary', active);
        btn.classList.toggle('btn-outline-primary', !active);
    });
}

function switchSpectraSection(sec) {
    spectraSection = sec;
    document.getElementById('spectra-emission-section').style.display  = sec === 'emission'  ? '' : 'none';
    document.getElementById('spectra-excitation-section').style.display = sec === 'excitation' ? '' : 'none';
    // Update segmented control button states
    document.querySelectorAll('#spectra-section-btns button').forEach(function(btn) {
        var active = btn.getAttribute('data-section') === sec;
        btn.classList.toggle('btn-primary', active);
        btn.classList.toggle('btn-outline-primary', !active);
    });
}

function setSpectraPalette(val) {
    spectraColorPalette = val;
    if (eemData) renderSpectraTab();
}

// ============================================================
// 2D Map Tab
// ============================================================
var COLORMAPS = {
    rdbu: [                                         // diverging: blue→white→red
        [5,48,97],[33,102,172],[67,147,195],[146,197,222],[209,229,240],
        [247,247,247],                              // white = midpoint (zero)
        [253,219,199],[244,165,130],[214,96,77],[178,24,43],[103,0,31]
    ],
    blackjet: [
        [0,0,0],[0,0,80],[0,0,160],[0,60,210],[0,150,225],[0,215,215],
        [0,220,140],[0,205,55],[60,210,0],[155,215,0],[240,220,0],
        [255,200,0],[255,160,0],[255,100,0],[255,40,0],[240,0,0],
        [210,0,0],[180,0,0],[150,0,0],[120,0,0]
    ],
    viridis: [
        [68,1,84],[70,23,103],[71,44,122],[65,68,135],[57,86,140],
        [50,101,142],[44,113,142],[38,125,142],[33,137,141],[30,148,139],
        [30,159,136],[37,170,130],[52,181,122],[72,191,112],[97,201,99],
        [124,209,85],[157,217,59],[193,220,48],[226,228,24],[253,231,37]
    ],
    hot: [
        [0,0,0],[43,0,0],[85,0,0],[128,0,0],[170,0,0],[213,0,0],[255,0,0],
        [255,43,0],[255,85,0],[255,128,0],[255,170,0],[255,213,0],[255,255,0],
        [255,255,64],[255,255,128],[255,255,192],[255,255,255],[255,255,255],[255,255,255],[255,255,255]
    ],
    greens: [
        [0,68,27],[0,90,50],[0,109,44],[35,139,69],[65,171,93],
        [116,196,118],[161,217,155],[199,233,192],[229,245,224],[247,252,245],
        [247,252,245],[247,252,245],[247,252,245],[247,252,245],[247,252,245],
        [247,252,245],[247,252,245],[247,252,245],[247,252,245],[247,252,245]
    ]
};

function applyColormap(t, name) {
    var cmap = COLORMAPS[name] || COLORMAPS.viridis;
    t = Math.max(0, Math.min(1, t));
    var idx = t * (cmap.length - 1);
    var lo = Math.floor(idx), hi = Math.min(Math.ceil(idx), cmap.length - 1);
    var frac = idx - lo;
    if (lo === hi) return cmap[lo];
    return cmap[lo].map(function(v, i) { return Math.round(v + frac * (cmap[hi][i] - v)); });
}

function drawHeatmapDiverging(canvasId, exWl, emWl, intensity, fontScale) {
    /* Like drawHeatmap but with symmetric normalization centred at 0.
       Positive residuals → red, negative → blue, zero → white. */
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var nEx = exWl.length, nEm = emWl.length;
    if (!nEx || !nEm) return;
    var fs = fontScale || 1.0;

    var maxAbs = 0;
    for (var i = 0; i < nEm; i++)
        for (var j = 0; j < nEx; j++) {
            var v = Math.abs(intensity[i][j]);
            if (v > maxAbs) maxAbs = v;
        }
    if (maxAbs === 0) maxAbs = 1;

    var offscreen = document.createElement('canvas');
    offscreen.width = nEx; offscreen.height = nEm;
    var offCtx = offscreen.getContext('2d');
    var imageData = offCtx.createImageData(nEx, nEm);
    var px = imageData.data;
    for (var i = 0; i < nEm; i++)
        for (var j = 0; j < nEx; j++) {
            var t = (intensity[i][j] / maxAbs + 1) / 2;   // map [-maxAbs, maxAbs] → [0, 1]
            var rgb = applyColormap(t, 'rdbu');
            var idx = ((nEm - 1 - i) * nEx + j) * 4;
            px[idx] = rgb[0]; px[idx+1] = rgb[1]; px[idx+2] = rgb[2]; px[idx+3] = 255;
        }
    offCtx.putImageData(imageData, 0, 0);

    var margin = {
        top:    Math.round(22  * fs),
        right:  Math.round(100 * fs),
        bottom: Math.round(62  * fs),
        left:   Math.round(78  * fs)
    };
    var cw = canvas.width, ch = canvas.height;
    var pw = cw - margin.left - margin.right;
    var ph = ch - margin.top - margin.bottom;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(offscreen, margin.left, margin.top, pw, ph);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, pw, ph);

    var tickFontSize  = Math.round(13 * fs);
    var titleFontSize = Math.round(15 * fs);
    ctx.fillStyle = '#333'; ctx.font = tickFontSize + 'px sans-serif'; ctx.textAlign = 'center';
    var nXticks = Math.min(8, nEx);
    for (var k = 0; k <= nXticks; k++) {
        var xFrac = k / nXticks;
        var xPx = margin.left + xFrac * pw;
        ctx.fillText(Math.round(exWl[Math.round(xFrac * (nEx - 1))]), xPx, ch - margin.bottom + Math.round(17 * fs));
    }
    ctx.fillStyle = '#333'; ctx.font = 'bold ' + titleFontSize + 'px sans-serif';
    ctx.fillText('Excitation (nm)', margin.left + pw / 2, ch - Math.round(6 * fs));

    ctx.textAlign = 'right'; ctx.font = tickFontSize + 'px sans-serif';
    var nYticks = Math.min(8, nEm);
    for (var k = 0; k <= nYticks; k++) {
        var yFrac = k / nYticks;
        var yPx = margin.top + yFrac * ph;
        ctx.fillText(Math.round(emWl[Math.round((1 - yFrac) * (nEm - 1))]), margin.left - Math.round(6 * fs), yPx + 4);
    }
    ctx.save();
    ctx.translate(Math.round(15 * fs), margin.top + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.font = 'bold ' + titleFontSize + 'px sans-serif'; ctx.fillStyle = '#333';
    ctx.fillText('Emission (nm)', 0, 0);
    ctx.restore();

    // Colorbar with RdBu
    var csX = cw - margin.right + Math.round(15 * fs);
    var csW = Math.round(18 * fs);
    var cmap = COLORMAPS.rdbu;
    var csGrad = ctx.createLinearGradient(0, margin.top, 0, margin.top + ph);
    cmap.slice().reverse().forEach(function(rgb, i) {
        csGrad.addColorStop(i / (cmap.length - 1), 'rgb(' + rgb.join(',') + ')');
    });
    ctx.fillStyle = csGrad;
    ctx.fillRect(csX, margin.top, csW, ph);
    ctx.strokeStyle = '#999'; ctx.lineWidth = 0.5;
    ctx.strokeRect(csX, margin.top, csW, ph);

    // Colorbar labels: +max, 0, -max
    ctx.fillStyle = '#333'; ctx.font = (tickFontSize * 0.9) + 'px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('+' + maxAbs.toFixed(0), csX + csW + 3, margin.top + 4);
    ctx.fillText('0', csX + csW + 3, margin.top + ph / 2 + 4);
    ctx.fillText('\u2212' + maxAbs.toFixed(0), csX + csW + 3, margin.top + ph);

    // Zero line on colorbar
    ctx.strokeStyle = '#444'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(csX, margin.top + ph / 2);
    ctx.lineTo(csX + csW, margin.top + ph / 2);
    ctx.stroke();
}

function applyClientMapRange(exWl, emWl, intensity) {
    var exMin = parseFloat(document.getElementById('eem-ex-map-min').value) || null;
    var exMax = parseFloat(document.getElementById('eem-ex-map-max').value) || null;
    var emMin = parseFloat(document.getElementById('eem-em-map-min').value) || null;
    var emMax = parseFloat(document.getElementById('eem-em-map-max').value) || null;
    if (!exMin && !exMax && !emMin && !emMax) return {exWl: exWl, emWl: emWl, intensity: intensity};
    var xi = [], ei = [];
    exWl.forEach(function(v, i) { if ((!exMin || v >= exMin) && (!exMax || v <= exMax)) xi.push(i); });
    emWl.forEach(function(v, i) { if ((!emMin || v >= emMin) && (!emMax || v <= emMax)) ei.push(i); });
    if (!xi.length || !ei.length) return {exWl: exWl, emWl: emWl, intensity: intensity};
    return {
        exWl: xi.map(function(i) { return exWl[i]; }),
        emWl: ei.map(function(i) { return emWl[i]; }),
        intensity: ei.map(function(e) { return xi.map(function(x) { return intensity[e][x]; }); })
    };
}

function renderMapTab() {
    if (!eemData) return;
    dirtyTabs.delete('map');
    var colorName = document.getElementById('map-colorscale').value;
    var useLog    = document.getElementById('map-log-scale').checked;
    var grid      = document.getElementById('eem-maps-grid');
    var files     = eemData.files;
    var n         = files.length;
    var colClass  = n === 1 ? 'col-12' : (n <= 2 || n === 4 ? 'col-md-6' : 'col-md-4');

    // Rebuild grid if file count changed
    if (grid.children.length !== n) {
        grid.innerHTML = '';
        mapMetaStore = {};
        files.forEach(function(fname, idx) {
            var canvasId = 'heatmap-canvas-' + idx;
            var col = document.createElement('div');
            col.className = colClass + ' mb-4';
            col.innerHTML =
                '<div class="d-flex justify-content-between align-items-center mb-1">' +
                    '<small class="font-weight-bold text-truncate mr-1" style="max-width:calc(100% - 40px);">' +
                        fname.replace(/</g,'&lt;').replace(/>/g,'&gt;') +
                    '</small>' +
                    '<button class="btn btn-outline-secondary btn-sm py-0 px-2" style="font-size:0.75rem;" ' +
                            'onclick="downloadMapPng(\'' + canvasId + '\',\'' + fname.replace(/'/g,"\\'") + '\')">' +
                        '<i class="fa fa-download"></i>' +
                    '</button>' +
                '</div>' +
                '<div style="position:relative;">' +
                    '<canvas id="' + canvasId + '" width="600" height="400" ' +
                        'title="Click to enlarge" ' +
                        'style="border:1px solid #dee2e6; max-width:100%; display:block; cursor:pointer;"' +
                        'onclick="openEnlargedMap(\'' + fname.replace(/'/g, "\\'") + '\',' + idx + ')"></canvas>' +
                '</div>';
            grid.appendChild(col);
        });
        files.forEach(function(fname, idx) {
            attachMapTooltip('heatmap-canvas-' + idx);
        });
    }

    files.forEach(function(fname, idx) {
        var mapData = eemData.maps[fname];
        if (!mapData) return;
        var d = applyClientMapRange(mapData.ex_wl, mapData.em_wl, mapData.intensity);
        drawHeatmap('heatmap-canvas-' + idx, d.exWl, d.emWl, d.intensity, colorName, useLog);
    });
}

function attachMapTooltip(canvasId) {
    var canvas  = document.getElementById(canvasId);
    var tooltip = document.getElementById('eem-map-tooltip');
    if (!canvas || !tooltip) return;
    canvas.addEventListener('mousemove', function(e) {
        var meta = mapMetaStore[canvasId];
        if (!meta) { tooltip.style.display = 'none'; return; }
        var rect   = canvas.getBoundingClientRect();
        var scaleX = canvas.width  / rect.width;
        var scaleY = canvas.height / rect.height;
        var cx     = (e.clientX - rect.left) * scaleX;
        var cy     = (e.clientY - rect.top)  * scaleY;
        var m = meta;
        if (cx < m.margin.left || cx > m.margin.left + m.pw ||
            cy < m.margin.top  || cy > m.margin.top  + m.ph) {
            tooltip.style.display = 'none'; return;
        }
        var exIdx = Math.max(0, Math.min(Math.round((cx - m.margin.left) / m.pw * (m.exWl.length - 1)), m.exWl.length - 1));
        var emIdx = Math.max(0, Math.min(Math.round((1 - (cy - m.margin.top) / m.ph) * (m.emWl.length - 1)), m.emWl.length - 1));
        tooltip.textContent = 'Ex: ' + Math.round(m.exWl[exIdx]) + ' nm  |  Em: ' +
                              Math.round(m.emWl[emIdx]) + ' nm  |  Int: ' + m.intensity[emIdx][exIdx].toFixed(0);
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 14) + 'px';
        tooltip.style.top  = (e.clientY - 32) + 'px';
    });
    canvas.addEventListener('mouseleave', function() {
        tooltip.style.display = 'none';
    });
}

function downloadMapPng(canvasId, fname) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = fname.replace(/[^a-z0-9_\-]/gi, '_') + '_EEM.png';
    a.click();
}

function drawHeatmap(canvasId, exWl, emWl, intensity, colorName, useLog, fontScale) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var nEx = exWl.length, nEm = emWl.length;
    if (!nEx || !nEm) return;
    var fs = fontScale || 1.0;

    var maxVal = -Infinity, minVal = Infinity;
    for (var i = 0; i < nEm; i++)
        for (var j = 0; j < nEx; j++) {
            var v = intensity[i][j];
            if (v > maxVal) maxVal = v;
            if (v < minVal) minVal = v;
        }
    var logMin = minVal > 0 ? Math.log10(minVal) : 0;
    var logMax = maxVal > 0 ? Math.log10(maxVal) : 1;
    var range = maxVal - minVal || 1;
    var logRange = logMax - logMin || 1;

    var offscreen = document.createElement('canvas');
    offscreen.width = nEx; offscreen.height = nEm;
    var offCtx = offscreen.getContext('2d');
    var imageData = offCtx.createImageData(nEx, nEm);
    var px = imageData.data;
    for (var i = 0; i < nEm; i++)
        for (var j = 0; j < nEx; j++) {
            var val = intensity[i][j];
            var t = useLog ? (val > 0 ? (Math.log10(val) - logMin) / logRange : 0) : (val - minVal) / range;
            var rgb = applyColormap(t, colorName);
            var idx = ((nEm - 1 - i) * nEx + j) * 4;
            px[idx] = rgb[0]; px[idx+1] = rgb[1]; px[idx+2] = rgb[2]; px[idx+3] = 255;
        }
    offCtx.putImageData(imageData, 0, 0);

    var margin = {
        top:    Math.round(22  * fs),
        right:  Math.round(100 * fs),
        bottom: Math.round(62  * fs),
        left:   Math.round(78  * fs)
    };
    var cw = canvas.width, ch = canvas.height;
    var pw = cw - margin.left - margin.right;
    var ph = ch - margin.top - margin.bottom;

    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(offscreen, margin.left, margin.top, pw, ph);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, pw, ph);

    // X-axis ticks & labels
    var tickFontSize  = Math.round(13 * fs);
    var titleFontSize = Math.round(15 * fs);
    ctx.fillStyle = '#333'; ctx.font = tickFontSize + 'px sans-serif'; ctx.textAlign = 'center';
    var nXticks = Math.min(8, nEx);
    for (var k = 0; k <= nXticks; k++) {
        var xFrac = k / nXticks;
        var xPx = margin.left + xFrac * pw;
        ctx.fillText(Math.round(exWl[Math.round(xFrac * (nEx - 1))]), xPx, ch - margin.bottom + Math.round(17 * fs));
        ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(xPx, margin.top); ctx.lineTo(xPx, margin.top + ph); ctx.stroke();
    }
    ctx.fillStyle = '#333'; ctx.font = 'bold ' + titleFontSize + 'px sans-serif';
    ctx.fillText('Excitation (nm)', margin.left + pw / 2, ch - Math.round(6 * fs));

    // Y-axis ticks & labels
    ctx.textAlign = 'right';
    ctx.font = tickFontSize + 'px sans-serif';
    var nYticks = Math.min(8, nEm);
    for (var k = 0; k <= nYticks; k++) {
        var yFrac = k / nYticks;
        var yPx = margin.top + yFrac * ph;
        ctx.fillText(Math.round(emWl[Math.round((1 - yFrac) * (nEm - 1))]), margin.left - Math.round(6 * fs), yPx + 4);
        ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(margin.left, yPx); ctx.lineTo(margin.left + pw, yPx); ctx.stroke();
    }
    ctx.save();
    ctx.translate(Math.round(15 * fs), margin.top + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.font = 'bold ' + titleFontSize + 'px sans-serif'; ctx.fillStyle = '#333';
    ctx.fillText('Emission (nm)', 0, 0);
    ctx.restore();

    // Colorscale bar
    var csX = cw - margin.right + Math.round(15 * fs);
    var csW = Math.round(18 * fs);
    var csH = ph;
    var csGrad = ctx.createLinearGradient(0, margin.top, 0, margin.top + csH);
    var cmap = COLORMAPS[colorName] || COLORMAPS.viridis;
    cmap.slice().reverse().forEach(function(rgb, i) {
        csGrad.addColorStop(i / (cmap.length - 1), 'rgb(' + rgb.join(',') + ')');
    });
    ctx.fillStyle = csGrad; ctx.fillRect(csX, margin.top, csW, csH);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 1; ctx.strokeRect(csX, margin.top, csW, csH);
    ctx.textAlign = 'left'; ctx.font = Math.round(11 * fs) + 'px sans-serif'; ctx.fillStyle = '#333';
    ctx.fillText(useLog ? maxVal.toExponential(1) : (maxVal > 9999 ? maxVal.toExponential(1) : maxVal.toFixed(0)),
                 csX + csW + Math.round(4 * fs), margin.top + Math.round(11 * fs));
    ctx.fillText(useLog ? minVal.toExponential(1) : (minVal > 9999 ? minVal.toExponential(1) : minVal.toFixed(0)),
                 csX + csW + Math.round(4 * fs), margin.top + csH);

    mapMetaStore[canvasId] = { exWl: exWl, emWl: emWl, intensity: intensity, margin: margin, pw: pw, ph: ph };
}

function openEnlargedMap(fname, idx) {
    var mapData = eemData && eemData.maps[fname];
    if (!mapData) return;
    var colorName = document.getElementById('map-colorscale').value;
    var useLog    = document.getElementById('map-log-scale').checked;
    var d = applyClientMapRange(mapData.ex_wl, mapData.em_wl, mapData.intensity);

    var titleEl = document.getElementById('eem-map-modal-title');
    if (titleEl) titleEl.textContent = fname;

    // Size the modal canvas to fill up to 900×600, keeping 3:2 ratio
    var mc = document.getElementById('eem-map-modal-canvas');
    if (!mc) return;
    mc.width  = 900;
    mc.height = 600;
    drawHeatmap('eem-map-modal-canvas', d.exWl, d.emWl, d.intensity, colorName, useLog, 900 / 600);

    $('#eem-map-enlarge-modal').modal('show');
}


// ============================================================
// Derived Tab
// ============================================================
function renderDerivedTab() {
    if (!eemData) return;
    dirtyTabs.delete('derived');
    var rtNote = document.getElementById('eem-rt-state-note');
    if (rtNote) rtNote.style.display = (eemData.analysis_mode === 'RT') ? '' : 'none';
    var k77Note = document.getElementById('eem-77k-state-note');
    if (k77Note) k77Note.style.display = (eemData.analysis_mode === '77K') ? '' : 'none';
    renderParamsChart();
    renderParamsTable();
}

function getAvailParams() {
    var allKeys = (eemData.analysis_mode === 'RT')
        ? RT_PARAM_KEYS
        : (PIGM_PARAMS[eemData.pigmentation] || PIGM_PARAMS['checkbox_chl_only']);
    return allKeys.filter(function(p) {
        return eemData.files.some(function(f) {
            var v = (eemData.params[f] || {})[p];
            return v !== null && v !== undefined;
        });
    });
}

function getParamLabel(p) {
    return (eemData && eemData.analysis_mode === 'RT')
        ? (RT_PARAM_LABELS[p] || PARAM_LABELS[p] || p)
        : (PARAM_LABELS[p] || p);
}

function renderParamsTable() {
    var files = eemData.files, availParams = getAvailParams();
    var html = '<table class="table table-sm table-bordered table-hover" id="params-data-table" style="font-size:0.84em;">' +
        '<thead class="thead-light"><tr><th>Sample</th>';
    availParams.forEach(function(p) { html += '<th>' + getParamLabel(p) + '</th>'; });
    html += '</tr></thead><tbody>';
    files.forEach(function(fname) {
        var params = eemData.params[fname] || {};
        html += '<tr><td>' + fname + '</td>';
        availParams.forEach(function(p) {
            var v = params[p];
            html += '<td>' + (v !== null && v !== undefined ? v.toFixed(4) : '—') + '</td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('params-table-container').innerHTML = html;
}

function renderParamsChart() {
    var files = eemData.files, avail = getAvailParams();
    var ratioList = (eemData.analysis_mode === 'RT') ? RT_RATIO_PARAMS : RATIO_PARAMS;
    var paramsToPlot = ratioList.filter(function(p) { return avail.indexOf(p) !== -1; });
    var container = document.getElementById('params-charts-container');
    container.innerHTML = '';
    paramsToPlot.forEach(function(paramKey) {
        var canvas = makeChartCanvas('params-charts-container', 'param-' + paramKey, 'col-md-4', getParamLabel(paramKey));
        var values = files.map(function(f) {
            var v = (eemData.params[f] || {})[paramKey];
            return v !== null && v !== undefined ? v : 0;
        });
        chartInst['param-' + paramKey] = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: files,
                datasets: [{ data: values,
                    backgroundColor: files.map(function(_, i) { return FILE_COLORS[i % FILE_COLORS.length]; }),
                    borderWidth: 1 }]
            },
            options: {
                animation: false, responsive: true,
                plugins: {
                    title: { display: true, text: getParamLabel(paramKey) },
                    legend: { display: false }
                },
                scales: { x: { ticks: { maxRotation: 45, font: { size: 9 } } }, y: { beginAtZero: true } }
            }
        });
    });
}

function copyParamsTable(btn) {
    var table = document.getElementById('params-data-table');
    if (!table) return;
    var rows = Array.from(table.rows).map(function(row) {
        return Array.from(row.cells).map(function(c) { return c.textContent.trim(); }).join('\t');
    });
    navigator.clipboard.writeText(rows.join('\n')).then(function() {
        if (btn) {
            var orig = btn.innerHTML;
            btn.innerHTML = '<i class="fa fa-check"></i> Copied!';
            setTimeout(function() { btn.innerHTML = orig; }, 1500);
        }
    });
}

// ============================================================
// Groups Tab
// ============================================================
function renderGroupsTab() {
    if (!eemData) return;
    dirtyTabs.delete('groups');
    buildGroupAssignTable();
    updateGroupsSummary();
    tryShowGroupResults();
}

function toggleSelectAll(cb) {
    document.querySelectorAll('.eem-file-check').forEach(function(c) { c.checked = cb.checked; });
}

function buildGroupAssignTable() {
    var files = groupFileOrder.length ? groupFileOrder : (eemData ? eemData.files.slice() : []);
    var tbody = document.getElementById('eem-group-assign-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    files.forEach(function(fname) {
        var grp = groups[fname] || '';
        var safeFname = fname.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        var tr = document.createElement('tr');
        tr.innerHTML =
            '<td><input type="checkbox" class="eem-file-check" data-file="' + fname + '"></td>' +
            '<td style="vertical-align:middle">' + fname + '</td>' +
            '<td style="vertical-align:middle">' +
                (grp ? '<span class="badge badge-info">' + grp + '</span>' :
                       '<span class="text-muted" style="font-size:0.9em;">—</span>') +
            '</td>' +
            '<td style="vertical-align:middle; text-align:center;">' +
                (grp ? '<button class="btn btn-sm p-0 px-1 btn-outline-danger" style="line-height:1.2;" ' +
                        'onclick="removeFromGroup(\'' + safeFname + '\')" title="Remove from group">' +
                        '<i class="fa fa-times"></i></button>' : '') +
            '</td>';
        tbody.appendChild(tr);
    });
    var selAll = document.getElementById('eem-select-all-check');
    if (selAll) selAll.checked = false;
}

function sortGroupsAZ() {
    if (!eemData) return;
    groupFileOrder = eemData.files.slice().sort();
    buildGroupAssignTable();
}

function sortGroupsZA() {
    if (!eemData) return;
    groupFileOrder = eemData.files.slice().sort().reverse();
    buildGroupAssignTable();
}

function autoDetectGroupsFromPrefix() {
    if (!eemData) return;
    eemData.files.forEach(function(fname) {
        groups[fname] = fname.replace(/[\s_\-]?\d+$/, '').trim() || fname;
    });
    buildGroupAssignTable();
    updateGroupsSummary();
    tryShowGroupResults();
}

function clearAllGroups() {
    if (!eemData) return;
    groups = {};
    buildGroupAssignTable();
    updateGroupsSummary();
    document.getElementById('eem-group-results').style.display = 'none';
}

function assignSelectedToGroup() {
    var name = (document.getElementById('eem-group-name-input').value || '').trim();
    if (!name) { alert('Please enter a group name.'); return; }
    var checked = document.querySelectorAll('.eem-file-check:checked');
    if (!checked.length) { alert('Please select at least one sample.'); return; }
    checked.forEach(function(cb) { groups[cb.dataset.file] = name; });
    buildGroupAssignTable();
    updateGroupsSummary();
    tryShowGroupResults();
}

function removeFromGroup(fname) {
    delete groups[fname];
    buildGroupAssignTable();
    updateGroupsSummary();
    tryShowGroupResults();
}

function updateGroupsSummary() {
    var el = document.getElementById('eem-groups-summary');
    if (!el) return;
    var tally = {};
    Object.keys(groups).forEach(function(f) {
        var g = groups[f]; if (g) tally[g] = (tally[g] || 0) + 1;
    });
    var gnames = Object.keys(tally);
    if (!gnames.length) { el.innerHTML = '<small class="text-muted">No groups defined yet.</small>'; return; }
    el.innerHTML = '<strong>' + gnames.length + ' group(s):</strong> ' +
        gnames.map(function(g) {
            return '<span class="badge badge-secondary mr-1">' + g + ' (n=' + tally[g] + ')</span>';
        }).join('');
}

function tryShowGroupResults() {
    var tally = {};
    Object.keys(groups).forEach(function(f) { var g = groups[f]; if (g) tally[g] = (tally[g] || 0) + 1; });
    var gnames = Object.keys(tally);
    var el = document.getElementById('eem-group-results');
    if (gnames.length >= 2) {
        el.style.display = '';
        renderGroupStats(gnames);
    } else {
        el.style.display = 'none';
    }
}

function renderGroupStats(groupNames) {
    var avail = getAvailParams();
    var groupStats = {};
    groupNames.forEach(function(grp) {
        groupStats[grp] = {};
        var grpFiles = eemData.files.filter(function(f) { return groups[f] === grp; });
        avail.forEach(function(p) {
            var vals = grpFiles.map(function(f) {
                var v = (eemData.params[f] || {})[p];
                return (v !== null && v !== undefined) ? v : null;
            }).filter(function(v) { return v !== null; });
            if (!vals.length) { groupStats[grp][p] = {mean: null, sd: null, n: 0}; return; }
            var mean = vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
            var sd = vals.length > 1
                ? Math.sqrt(vals.map(function(v) { return Math.pow(v - mean, 2); })
                    .reduce(function(a, b) { return a + b; }, 0) / (vals.length - 1))
                : 0;
            groupStats[grp][p] = {mean: mean, sd: sd, n: vals.length};
        });
    });
    renderGroupTable(groupStats, groupNames, avail);
    renderGroupCharts(groupStats, groupNames, avail);
}

function calcGroupStats() {
    var groupNames = Object.values(groups).filter(Boolean)
        .filter(function(v, i, a) { return a.indexOf(v) === i; });
    if (groupNames.length) renderGroupStats(groupNames);
}

function renderGroupTable(groupStats, groupNames, avail) {
    var html = '<table class="table table-sm table-bordered" style="font-size:0.84em;">' +
        '<thead class="thead-light"><tr><th>Parameter</th>';
    groupNames.forEach(function(g) { html += '<th>' + g + ' mean</th><th>' + g + ' SD</th><th>n</th>'; });
    html += '</tr></thead><tbody>';
    avail.forEach(function(p) {
        html += '<tr><td>' + getParamLabel(p) + '</td>';
        groupNames.forEach(function(g) {
            var st = groupStats[g][p] || {};
            html += '<td>' + (st.mean !== null && st.mean !== undefined ? st.mean.toFixed(4) : '—') + '</td>' +
                    '<td>' + (st.sd   !== null && st.sd   !== undefined ? st.sd.toFixed(4)   : '—') + '</td>' +
                    '<td>' + (st.n || 0) + '</td>';
        });
        html += '</tr>';
    });
    html += '</tbody></table>';
    document.getElementById('group-table-container').innerHTML = html;
}

function renderGroupCharts(groupStats, groupNames, avail) {
    var ratioList = (eemData && eemData.analysis_mode === 'RT') ? RT_RATIO_PARAMS : RATIO_PARAMS;
    var paramsToPlot = ratioList.filter(function(p) { return avail.indexOf(p) !== -1; });
    var container = document.getElementById('group-charts-container');
    container.innerHTML = '';
    paramsToPlot.forEach(function(paramKey) {
        var canvas = makeChartCanvas('group-charts-container', 'grp-' + paramKey, 'col-md-4', getParamLabel(paramKey));
        var means = groupNames.map(function(g) { return (groupStats[g][paramKey] || {}).mean || 0; });
        var sds   = groupNames.map(function(g) { return (groupStats[g][paramKey] || {}).sd   || 0; });
        chartInst['grp-' + paramKey] = new Chart(canvas, {
            type: 'barWithErrorBars',
            data: {
                labels: groupNames,
                datasets: [{
                    data: groupNames.map(function(_, i) {
                        return { y: means[i], yMin: means[i] - sds[i], yMax: means[i] + sds[i] };
                    }),
                    backgroundColor: groupNames.map(function(_, i) { return FILE_COLORS[i % FILE_COLORS.length]; }),
                    borderWidth: 1,
                    errorBarColor: '#333', errorBarWhiskerColor: '#333', errorBarWhiskerSize: 10
                }]
            },
            options: {
                animation: false, responsive: true,
                plugins: {
                    title: { display: true, text: getParamLabel(paramKey) },
                    legend: { display: false }
                },
                scales: { x: { ticks: { font: { size: 10 } } }, y: { beginAtZero: false } }
            }
        });
    });
}

// ============================================================
// Export
// ============================================================
function buildWorkbook() {
    var wb = XLSX.utils.book_new();
    var files = eemData.files, avail = getAvailParams();
    var rows = [['Sample'].concat(avail.map(function(p) { return getParamLabel(p); }))];
    files.forEach(function(fname) {
        rows.push([fname].concat(avail.map(function(p) {
            var v = (eemData.params[fname] || {})[p];
            return v !== null && v !== undefined ? v : '';
        })));
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Parameters');
    eemData.ex_wls.forEach(function(exWl) {
        var spec = eemData.emission_spectra[String(exWl)];
        if (!spec || !spec.wl.length) return;
        appendSpectraSheet(wb, spec, files, 'Em (nm)', 'Em@Ex' + exWl, 'NormEm@Ex' + exWl);
    });
    eemData.em_wls.forEach(function(emWl) {
        var spec = eemData.excitation_spectra[String(emWl)];
        if (!spec || !spec.wl.length) return;
        appendSpectraSheet(wb, spec, files, 'Ex (nm)', 'Ex@Em' + emWl, 'NormEx@Em' + emWl);
    });
    return wb;
}

function _buildMethodsHtml(toolTitle, plainText) {
    var dateStr = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
    var paragraphs = plainText.split(/\n\n+/).map(function(p) {
        return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
    return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>Methods Section \u2014 ' + toolTitle + '</title>\n<style>\n  body { font-family: "Times New Roman", Times, serif; font-size: 11pt; line-height: 1.7;\n         max-width: 740px; margin: 48px auto; color: #111; }\n  h1   { font-size: 1.25rem; margin-bottom: 0.15em; }\n  p    { margin: 0.4em 0 0.9em; text-align: justify; }\n  .meta { color: #555; font-size: 0.82rem; font-family: Arial, sans-serif;\n          border-bottom: 2px solid #333; padding-bottom: 0.5em; margin-bottom: 1.4em; }\n  .note { background: #fffbe6; border-left: 4px solid #f0ad4e; padding: 7px 12px;\n          font-size: 0.82rem; font-family: Arial, sans-serif; margin-top: 2.2em; line-height: 1.5; }\n</style>\n</head>\n<body>\n<h1>' + toolTitle + ' \u2014 Methods Section</h1>\n<div class="meta">Generated by CyanoTools\u00a0\u00b7\u00a0' + dateStr + '</div>\n' + paragraphs + '\n<div class="note"><strong>Note:</strong> This section was auto-generated from the active analysis settings at the time of export. Please verify all values and adapt the wording to the conventions of your target journal.</div>\n</body>\n</html>';
}

function downloadXLSX() {
    if (!eemData) return;
    XLSX.writeFile(buildWorkbook(), 'EEM_analysis.xlsx');
}

function downloadZIP(btn) {
    if (!eemData) return;
    if (typeof JSZip === 'undefined') { alert('JSZip library not loaded.'); return; }

    var origLabel = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm mr-1" role="status"></span> Building…'; }

    // Temporarily force all tab panes and both spectra sub-sections visible so
    // Chart.js creates canvases at the correct size (responsive charts collapse to
    // 0 px inside hidden .tab-pane containers).
    var tabPanes = Array.from(document.querySelectorAll('#eemTabContent .tab-pane'));
    tabPanes.forEach(function(p) { p.style.setProperty('display', 'block', 'important'); });
    ['spectra-emission-section', 'spectra-excitation-section'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.setProperty('display', 'block', 'important');
    });

    // Render every tab so all canvases are populated
    renderSpectraTab();
    renderMapTab();
    renderDerivedTab();
    var gnames = Object.values(groups).filter(Boolean)
        .filter(function(v, i, a) { return a.indexOf(v) === i; });
    if (gnames.length >= 2) renderGroupsTab();

    // Restore visibility (canvas pixel buffers remain intact after display:none)
    tabPanes.forEach(function(p) { p.style.removeProperty('display'); });
    ['spectra-emission-section', 'spectra-excitation-section'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.removeProperty('display');
    });

    var zip = new JSZip();

    // ── XLSX ──────────────────────────────────────────────────────────────────
    zip.file('EEM_analysis.xlsx', XLSX.write(buildWorkbook(), {bookType: 'xlsx', type: 'array'}));

    // ── Settings JSON ─────────────────────────────────────────────────────────
    zip.file('settings.json', JSON.stringify({
        analysis_mode:  eemData.analysis_mode || '77K',
        pigmentation:   getPigmentation(),
        normalization:  normMode,
        ref_norm_mode:  refNormMode,
        ex_wavelengths: eemData.ex_wls,
        em_wavelengths: eemData.em_wls,
        norm_ex: parseFloat((document.getElementById('eem-ex-norm') || {}).value) || null,
        norm_em: parseFloat((document.getElementById('eem-em-norm') || {}).value) || null,
        color_palette:  spectraColorPalette,
        files:          eemData.files
    }, null, 2));

    function pngB64(canvas) { return canvas.toDataURL('image/png').split(',')[1]; }

    // ── Spectra charts ────────────────────────────────────────────────────────
    var spectraFolder = zip.folder('spectra');
    eemData.ex_wls.forEach(function(exWl) {
        var c = document.getElementById('chart-em-ex-' + exWl);
        if (c) spectraFolder.file('emission_Ex' + exWl + 'nm.png', pngB64(c), {base64: true});
    });
    eemData.em_wls.forEach(function(emWl) {
        var c = document.getElementById('chart-ex-em-' + emWl);
        if (c) spectraFolder.file('excitation_Em' + emWl + 'nm.png', pngB64(c), {base64: true});
    });

    // ── 2D EEM maps ───────────────────────────────────────────────────────────
    var mapsFolder = zip.folder('maps');
    eemData.files.forEach(function(fname, idx) {
        var c = document.getElementById('heatmap-canvas-' + idx);
        if (c) mapsFolder.file(fname.replace(/[^a-z0-9_.\-]/gi, '_') + '_EEM.png', pngB64(c), {base64: true});
    });

    // ── Derived parameter charts ──────────────────────────────────────────────
    var derivedFolder = zip.folder('parameters');
    var ratioList = (eemData.analysis_mode === 'RT') ? RT_RATIO_PARAMS : RATIO_PARAMS;
    var avail = getAvailParams();
    ratioList.filter(function(p) { return avail.indexOf(p) !== -1; }).forEach(function(p) {
        var c = document.getElementById('chart-param-' + p);
        if (c) derivedFolder.file('param_' + p + '.png', pngB64(c), {base64: true});
    });

    // ── Group charts ──────────────────────────────────────────────────────────
    if (gnames.length >= 2) {
        var groupsFolder = zip.folder('groups');
        ratioList.filter(function(p) { return avail.indexOf(p) !== -1; }).forEach(function(p) {
            var c = document.getElementById('chart-grp-' + p);
            if (c) groupsFolder.file('group_' + p + '.png', pngB64(c), {base64: true});
        });
    }

    // ── Deconvolution chart ───────────────────────────────────────────────────
    if (deconvFitParams) {
        var c = document.getElementById('deconv-chart');
        if (c) zip.file('deconvolution.png', pngB64(c), {base64: true});
    }

    // ── Methods section ───────────────────────────────────────────────────────
    zip.file('Methods_section.html', _buildMethodsHtml('EEM Analyzer', generateMethodsText()));

    zip.generateAsync({type: 'blob'}).then(function(blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'EEM_analysis.zip';
        a.click();
        setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
        if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }
    });
}

function appendSpectraSheet(wb, spec, files, wlHeader, rawName, normName) {
    var rawRows = [[wlHeader].concat(files)];
    spec.wl.forEach(function(wl, wi) {
        var row = [wl];
        files.forEach(function(f) { row.push(spec.raw[f] ? spec.raw[f][wi] : ''); });
        rawRows.push(row);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rawRows), rawName.substring(0, 31));
    if (Object.keys(spec.norm).length) {
        var normRows = [[wlHeader].concat(files)];
        spec.wl.forEach(function(wl, wi) {
            var row = [wl];
            files.forEach(function(f) { row.push(spec.norm[f] ? spec.norm[f][wi] : ''); });
            normRows.push(row);
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(normRows), normName.substring(0, 31));
    }
}

function exportToStatistics() {
    if (!eemData) return;
    var assignedFiles = eemData.files.filter(function(f) { return groups[f]; });
    if (!assignedFiles.length) { alert('Please assign groups in the Groups tab first.'); return; }
    var avail = getAvailParams();
    var header = ['Group', 'Sample'].concat(avail.map(getParamLabel)).join('\t');
    var rows = assignedFiles.map(function(fname) {
        var params = eemData.params[fname] || {};
        var vals = avail.map(function(p) {
            var v = params[p];
            return (v !== null && v !== undefined && isFinite(v)) ? v.toFixed(6) : '';
        });
        return [groups[fname], fname].concat(vals).join('\t');
    });
    sessionStorage.setItem('ojip_export', JSON.stringify({
        tsv: [header].concat(rows).join('\n'),
        source: 'EEM Analyzer'
    }));
    window.open('/statistics', '_blank');
}

// ============================================================
// Gaussian Deconvolution — LM solver
// ============================================================
function gaussianSum(params, x) {
    var y = 0, n = params.length / 3;
    for (var i = 0; i < n; i++) {
        var d = (x - params[i*3+1]) / params[i*3+2];
        y += params[i*3] * Math.exp(-0.5 * d * d);
    }
    return y;
}

function gaussianJacobian(params, x) {
    var n = params.length / 3, J = new Array(params.length).fill(0);
    for (var i = 0; i < n; i++) {
        var A = params[i*3], mu = params[i*3+1], sig = params[i*3+2];
        var d = (x - mu) / sig;
        var g = Math.exp(-0.5 * d * d);
        J[i*3]   = g;
        J[i*3+1] = A * g * d / sig;
        J[i*3+2] = A * g * d * d / sig;
    }
    return J;
}

function solveLinear(A, b, n) {
    var M = A.slice(), x = b.slice();
    for (var col = 0; col < n; col++) {
        var pivot = col;
        for (var row = col + 1; row < n; row++)
            if (Math.abs(M[row*n+col]) > Math.abs(M[pivot*n+col])) pivot = row;
        for (var k = 0; k < n; k++) {
            var t = M[col*n+k]; M[col*n+k] = M[pivot*n+k]; M[pivot*n+k] = t;
        }
        var t = x[col]; x[col] = x[pivot]; x[pivot] = t;
        if (Math.abs(M[col*n+col]) < 1e-14) continue;
        for (var row = col + 1; row < n; row++) {
            var f = M[row*n+col] / M[col*n+col];
            for (var k = col; k < n; k++) M[row*n+k] -= f * M[col*n+k];
            x[row] -= f * x[col];
        }
    }
    var result = new Array(n).fill(0);
    for (var i = n - 1; i >= 0; i--) {
        result[i] = x[i];
        for (var j = i + 1; j < n; j++) result[i] -= M[i*n+j] * result[j];
        if (Math.abs(M[i*n+i]) > 1e-14) result[i] /= M[i*n+i];
    }
    return result;
}

function fitGaussians(xArr, yArr, initParams, maxIter, bounds) {
    var params = initParams.slice(), n = params.length, m = xArr.length, lambda = 0.01;
    for (var iter = 0; iter < (maxIter || 300); iter++) {
        var JTJ = new Array(n * n).fill(0), JTr = new Array(n).fill(0), ssr = 0;
        for (var k = 0; k < m; k++) {
            var res = yArr[k] - gaussianSum(params, xArr[k]);
            ssr += res * res;
            var J = gaussianJacobian(params, xArr[k]);
            for (var i = 0; i < n; i++) {
                JTr[i] += J[i] * res;
                for (var j = 0; j < n; j++) JTJ[i*n+j] += J[i] * J[j];
            }
        }
        var dampedJTJ = JTJ.slice();
        for (var i = 0; i < n; i++) dampedJTJ[i*n+i] += lambda * (JTJ[i*n+i] || 1);
        var delta = solveLinear(dampedJTJ, JTr, n);
        var newParams = params.map(function(p, i) { return p + delta[i]; });
        if (bounds) {
            for (var i = 0; i < n; i++) {
                if (bounds.min[i] !== undefined) newParams[i] = Math.max(bounds.min[i], newParams[i]);
                if (bounds.max[i] !== undefined) newParams[i] = Math.min(bounds.max[i], newParams[i]);
            }
        }
        var newSSR = 0;
        for (var k = 0; k < m; k++) {
            var res = yArr[k] - gaussianSum(newParams, xArr[k]);
            newSSR += res * res;
        }
        if (newSSR < ssr) {
            if (Math.abs(ssr - newSSR) < 1e-10 * ssr) { params = newParams; break; }
            params = newParams; lambda /= 3;
        } else {
            lambda *= 3;
            if (lambda > 1e8) break;
        }
    }
    return params;
}

// ============================================================
// Gaussian Deconvolution — UI
// ============================================================
var DECONV_PRESETS = {
    'ex440': [680, 689, 695, 724],
    'ex620': [662, 689, 724],
    'ex560': [577, 662, 689, 724],
    'custom': [689, 724]
};

var deconvDragState   = null;
var deconvDragAttached = false;

// Chart.js per-instance plugin — draws draggable handles at each peak apex
var deconvHandlePlugin = {
    id: 'deconvHandles',
    afterDraw: function(chart) {
        if (!deconvFitParams) return;
        var xs = chart.scales && chart.scales.x;
        var ys = chart.scales && chart.scales.y;
        if (!xs || !ys) return;
        var ctx = chart.ctx;
        var nPeaks = deconvFitParams.length / 3;
        for (var i = 0; i < nPeaks; i++) {
            var A   = deconvFitParams[i * 3];
            var mu  = deconvFitParams[i * 3 + 1];
            var sig = Math.abs(deconvFitParams[i * 3 + 2]);
            var halfFwhm = sig * 1.1775;            // = FWHM/2 = σ × 2.355/2
            var color = PEAK_COLORS[i % PEAK_COLORS.length];

            var apexPx = xs.getPixelForValue(mu);
            var apexPy = ys.getPixelForValue(A);
            var halfPy = ys.getPixelForValue(A / 2);
            var leftPx = xs.getPixelForValue(mu - halfFwhm);
            var rightPx = xs.getPixelForValue(mu + halfFwhm);

            // ── FWHM span line at half-amplitude ──────────────────────────
            ctx.save();
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.2;
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            ctx.moveTo(leftPx, halfPy);
            ctx.lineTo(rightPx, halfPy);
            ctx.stroke();
            ctx.restore();

            // ── FWHM side handles (small circles, ew-resize style) ────────
            [leftPx, rightPx].forEach(function(hpx) {
                ctx.beginPath();
                ctx.arc(hpx, halfPy, 6, 0, 2 * Math.PI);
                ctx.fillStyle = color;
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                // Horizontal arrows ← → to signal horizontal-only drag
                ctx.strokeStyle = 'rgba(255,255,255,0.9)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(hpx - 3, halfPy); ctx.lineTo(hpx + 3, halfPy);
                ctx.stroke();
            });

            // ── Apex handle (filled circle + crosshair) ───────────────────
            ctx.beginPath();
            ctx.arc(apexPx, apexPy, 9, 0, 2 * Math.PI);
            ctx.fillStyle = color;
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(apexPx - 4, apexPy); ctx.lineTo(apexPx + 4, apexPy);
            ctx.moveTo(apexPx, apexPy - 4); ctx.lineTo(apexPx, apexPy + 4);
            ctx.stroke();
        }
    }
};

function initDeconvUI(autoRun) {
    if (!eemData) return;
    var sampSel = document.getElementById('deconv-sample-select');
    sampSel.innerHTML = '';
    eemData.files.forEach(function(f) {
        var opt = document.createElement('option'); opt.value = f; opt.textContent = f;
        sampSel.appendChild(opt);
    });
    var exSel = document.getElementById('deconv-ex-select');
    exSel.innerHTML = '';
    eemData.ex_wls.forEach(function(ex) {
        var opt = document.createElement('option'); opt.value = String(ex); opt.textContent = ex + ' nm';
        exSel.appendChild(opt);
    });

    if (autoRun) {
        // Pick the preset whose target excitation is closest to any available ex wavelength
        var PRESET_EX = { 'ex440': 440, 'ex560': 560, 'ex620': 620 };
        var presetSel = document.getElementById('deconv-preset-select');
        var bestPreset = 'ex440', bestDist = Infinity;
        Object.keys(PRESET_EX).forEach(function(p) {
            eemData.ex_wls.forEach(function(ex) {
                var d = Math.abs(ex - PRESET_EX[p]);
                if (d < bestDist) { bestDist = d; bestPreset = p; }
            });
        });
        presetSel.value = bestPreset;
        applyDeconvPreset();

        // Select the excitation wavelength in the dropdown that matches the preset's target
        var targetEx = PRESET_EX[bestPreset];
        var bestExIdx = 0, bestExDist = Infinity;
        eemData.ex_wls.forEach(function(ex, i) {
            var d = Math.abs(ex - targetEx);
            if (d < bestExDist) { bestExDist = d; bestExIdx = i; }
        });
        exSel.selectedIndex = bestExIdx;

        runDeconvolution(true);   // true = silent (no alert on missing data)
    } else {
        applyDeconvPreset();
    }
}

function applyDeconvPreset() {
    var preset = document.getElementById('deconv-preset-select').value;
    deconvPeakMus = (DECONV_PRESETS[preset] || [689, 724]).slice();
    rebuildPeaksEditor();
}

function rebuildPeaksEditor() {
    var container = document.getElementById('deconv-peaks-editor');
    container.innerHTML = '';
    deconvPeakMus.forEach(function(mu, idx) {
        var span = document.createElement('span');
        span.className = 'd-inline-flex align-items-center bg-white border rounded px-1';
        span.style.cssText = 'gap:2px; font-size:0.82rem;';
        span.innerHTML =
            '<input type="number" class="border-0 text-center p-0" style="width:46px; font-size:0.82rem;" ' +
            'value="' + mu + '" step="1" data-idx="' + idx + '" onchange="updateDeconvPeak(this)">' +
            '<button class="btn p-0 text-danger" style="line-height:1; font-size:0.8rem;" ' +
            'onclick="removeDeconvPeak(' + idx + ')"><i class="fa fa-times"></i></button>';
        container.appendChild(span);
    });
}

function updateDeconvPeak(input) {
    var idx = parseInt(input.dataset.idx);
    deconvPeakMus[idx] = parseFloat(input.value) || deconvPeakMus[idx];
}

function addDeconvPeak() {
    deconvPeakMus.push(700);
    rebuildPeaksEditor();
}

function removeDeconvPeak(idx) {
    deconvPeakMus.splice(idx, 1);
    rebuildPeaksEditor();
}

function runDeconvolution(silent) {
    if (!eemData || !deconvPeakMus.length) { if (!silent) alert('Please add at least one peak position.'); return; }
    var fname  = document.getElementById('deconv-sample-select').value;
    var exWlStr = document.getElementById('deconv-ex-select').value;
    var spec = eemData.emission_spectra[exWlStr];
    if (!spec || !spec.wl.length || !spec.raw[fname]) {
        if (!silent) alert('No emission spectrum available for this sample / excitation combination.');
        return;
    }
    var xArr = spec.wl, yArr = spec.raw[fname];

    // Build initial params: [A, mu, sigma] per peak
    var sig0 = 8, initParams = [], minB = [], maxB = [];
    deconvPeakMus.forEach(function(mu) {
        var bestIdx = 0, bestDist = Infinity;
        for (var i = 0; i < xArr.length; i++) {
            var d = Math.abs(xArr[i] - mu);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        initParams.push(Math.max(1, yArr[bestIdx]), mu, sig0);
        minB.push(0, mu - 30, 1);
        maxB.push(Infinity, mu + 30, 45);
    });

    var fitParams = fitGaussians(xArr, yArr, initParams, 300, {min: minB, max: maxB});
    deconvFitParams = fitParams.slice();
    deconvCurrentData = { xArr: xArr, yArr: yArr, fname: fname, exWl: parseFloat(exWlStr) };
    renderDeconvChart(xArr, yArr, fitParams, fname, parseFloat(exWlStr));
    renderDeconvResults(fitParams, xArr, yArr);
    renderDeconvSliders(fitParams, xArr, yArr);
}

var PEAK_COLORS = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c',
                   '#e67e22','#16a085','#8e44ad','#c0392b'];

function renderDeconvChart(xArr, yArr, fitParams, fname, exWl) {
    var nPeaks = fitParams.length / 3;
    var existingChart = chartInst['deconv'];

    // Update in-place when peak count unchanged — no flicker on slider input
    if (existingChart && existingChart.data.datasets.length === 2 + nPeaks) {
        var ds = existingChart.data.datasets;
        ds[0].label = fname || 'Measured';
        ds[0].data  = xArr.map(function(x, i) { return {x: x, y: yArr[i]}; });
        ds[1].data  = xArr.map(function(x) { return {x: x, y: gaussianSum(fitParams, x)}; });
        for (var i = 0; i < nPeaks; i++) {
            (function(pi) {
                var A = fitParams[pi*3], mu = fitParams[pi*3+1], sig = fitParams[pi*3+2];
                ds[2 + pi].label = 'P' + (pi+1) + ' (' + mu.toFixed(1) + ' nm)';
                ds[2 + pi].data  = xArr.map(function(x) {
                    var d = (x - mu) / sig;
                    return {x: x, y: A * Math.exp(-0.5 * d * d)};
                });
            })(i);
        }
        existingChart.options.plugins.title.text = 'Gaussian deconvolution — Em @ Ex ' + exWl + ' nm';
        existingChart.update('none');
        return;
    }

    // Full rebuild on first call or when peak count changes
    if (existingChart) { existingChart.destroy(); delete chartInst['deconv']; }
    var canvas = document.getElementById('deconv-chart');
    // Destroy any orphaned Chart.js instance not tracked in chartInst
    var orphan = Chart.getChart(canvas);
    if (orphan) orphan.destroy();

    var datasets = [
        {
            label: fname || 'Measured',
            data: xArr.map(function(x, i) { return {x: x, y: yArr[i]}; }),
            borderColor: '#444', backgroundColor: 'transparent',
            showLine: true, borderWidth: 2, pointRadius: 0, tension: 0, order: 1
        },
        {
            label: 'Fit (total)',
            data: xArr.map(function(x) { return {x: x, y: gaussianSum(fitParams, x)}; }),
            borderColor: '#cc2200', backgroundColor: 'transparent',
            showLine: true, borderWidth: 2, borderDash: [6, 3], pointRadius: 0, tension: 0, order: 2
        }
    ];
    for (var i = 0; i < nPeaks; i++) {
        (function(pi) {
            var A = fitParams[pi*3], mu = fitParams[pi*3+1], sig = fitParams[pi*3+2];
            var color = PEAK_COLORS[pi % PEAK_COLORS.length];
            datasets.push({
                label: 'P' + (pi+1) + ' (' + mu.toFixed(1) + ' nm)',
                data: xArr.map(function(x) {
                    var d = (x - mu) / sig;
                    return {x: x, y: A * Math.exp(-0.5 * d * d)};
                }),
                borderColor: color,
                backgroundColor: color.replace(')', ',0.08)').replace('rgb', 'rgba'),
                showLine: true, borderWidth: 1.5, borderDash: [4, 4], pointRadius: 0, tension: 0,
                fill: true, order: 3 + pi
            });
        })(i);
    }

    chartInst['deconv'] = new Chart(canvas, {
        type: 'scatter',
        plugins: [deconvHandlePlugin],
        data: { datasets: datasets },
        options: {
            animation: false, responsive: true, maintainAspectRatio: false,
            plugins: {
                title: { display: true, text: 'Gaussian deconvolution — Em @ Ex ' + exWl + ' nm' },
                legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } },
                tooltip: { enabled: false }
            },
            scales: {
                x: { title: { display: true, text: 'Emission (nm)' } },
                y: { title: { display: true, text: 'Fluorescence (a.u.)' }, beginAtZero: true }
            }
        }
    });
}

function deconvPeakLabel(mu) {
    if (mu < 592) return 'PE ~580';
    if (mu < 655) return 'Chl ant.';
    if (mu < 672) return 'APC ~662';
    if (mu < 682) return 'Chl ant. ~677';
    if (mu < 692) return 'F685 (CP43)';
    if (mu < 703) return 'F695 (CP47)';
    if (mu < 718) return 'F707';
    if (mu < 738) return 'F724 (PSI)';
    return 'F735 (PSI)';
}

function renderDeconvResults(fitParams, xArr, yArr) {
    var nPeaks = fitParams.length / 3;
    var yMean = yArr.reduce(function(a, b) { return a + b; }, 0) / yArr.length;
    var ssTot = yArr.reduce(function(a, v) { return a + Math.pow(v - yMean, 2); }, 0);
    var ssRes = xArr.reduce(function(s, x, i) {
        var d = yArr[i] - gaussianSum(fitParams, x); return s + d * d;
    }, 0);
    var r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    var areas = [];
    for (var i = 0; i < nPeaks; i++)
        areas.push(Math.abs(fitParams[i*3]) * Math.abs(fitParams[i*3+2]) * Math.sqrt(2 * Math.PI));
    var totalArea = areas.reduce(function(a, b) { return a + b; }, 0);

    // ── Fit results table ──────────────────────────────────────────────────
    var html = '<p class="text-muted mb-1"><small>Goodness of fit: R² = <strong>' + r2.toFixed(4) +
               '</strong></small></p>' +
        '<div style="overflow-x:auto;">' +
        '<table class="table table-sm table-bordered mb-2" style="font-size:0.84em; max-width:720px;">' +
        '<thead class="thead-light"><tr>' +
        '<th>Peak</th><th>Assignment</th><th>Position (nm)</th>' +
        '<th>FWHM (nm)</th><th>Amplitude (a.u.)</th><th>Area (a.u.)</th><th>Area (%)</th>' +
        '</tr></thead><tbody>';
    for (var i = 0; i < nPeaks; i++) {
        var A   = fitParams[i*3];
        var mu  = fitParams[i*3+1];
        var sig = Math.abs(fitParams[i*3+2]);
        var color = PEAK_COLORS[i % PEAK_COLORS.length];
        html += '<tr>' +
            '<td><span class="font-weight-bold" style="color:' + color + ';">P' + (i+1) + '</span></td>' +
            '<td class="text-muted" style="font-size:0.81em; white-space:nowrap;">' + deconvPeakLabel(mu) + '</td>' +
            '<td>' + mu.toFixed(1) + '</td>' +
            '<td>' + (2.355 * sig).toFixed(1) + '</td>' +
            '<td>' + A.toFixed(0) + '</td>' +
            '<td>' + areas[i].toFixed(0) + '</td>' +
            '<td>' + (totalArea > 0 ? (areas[i] / totalArea * 100).toFixed(1) : '—') + '%</td>' +
        '</tr>';
    }
    html += '</tbody></table></div>';

    // ── Derived biological ratios ──────────────────────────────────────────
    var psiiArea = 0, psiArea = 0, cp43Area = 0, cp47Area = 0, pbsFreeArea = 0;
    for (var i = 0; i < nPeaks; i++) {
        var mu = fitParams[i*3+1];
        if (mu >= 682 && mu < 692) { cp43Area  += areas[i]; psiiArea += areas[i]; }
        if (mu >= 692 && mu < 703) { cp47Area  += areas[i]; psiiArea += areas[i]; }
        if (mu >= 718 && mu < 800) psiArea   += areas[i];
        if (mu >= 655 && mu < 672) pbsFreeArea += areas[i];
    }
    var ratios = [];
    if (psiiArea > 0 && psiArea > 0)
        ratios.push(['PSII : PSI (area)',
                     (psiiArea / psiArea).toFixed(3),
                     'Σ F685+F695 / Σ F724 area — overlap-corrected PSII/PSI stoichiometry']);
    if (cp43Area > 0 && cp47Area > 0)
        ratios.push(['F695 / F685 (area)',
                     (cp47Area / cp43Area).toFixed(3),
                     'CP47 / CP43 — elevated ratio indicates PSII structural changes or excitation pressure']);
    var psiiPsiSum = psiiArea + psiArea;
    if (pbsFreeArea > 0 && psiiPsiSum > 0)
        ratios.push(['PBS-free / (PSII+PSI)',
                     (pbsFreeArea / psiiPsiSum).toFixed(3),
                     'APC ~662 / (F685+F695+F724) — uncoupled PBS relative to PS-coupled PBS']);
    if (psiiArea > 0 && psiiPsiSum > 0)
        ratios.push(['PSII / (PSII+PSI)',
                     (psiiArea / psiiPsiSum).toFixed(3),
                     'PSII fraction of total Chl fluorescence (overlap-corrected)']);

    if (ratios.length) {
        html += '<p class="font-weight-bold mb-1 mt-1" style="font-size:0.84em;">' +
                '<i class="fa fa-bar-chart mr-1 text-muted"></i>Derived biological parameters:</p>' +
                '<table class="table table-sm table-borderless mb-0" style="font-size:0.83em; max-width:720px;"><tbody>';
        ratios.forEach(function(r) {
            html += '<tr>' +
                '<td class="font-weight-bold py-0" style="width:190px; vertical-align:top;">' + r[0] + '</td>' +
                '<td class="py-0" style="width:70px; vertical-align:top;">' + r[1] + '</td>' +
                '<td class="text-muted py-0" style="font-size:0.95em; vertical-align:top;">' + r[2] + '</td>' +
            '</tr>';
        });
        html += '</tbody></table>';
    }

    document.getElementById('deconv-results').innerHTML = html;
}

// ============================================================
// Client-side derived parameter re-computation from map data
// ============================================================
function recomputeParamsFromMaps() {
    if (!eemData) return;

    var pigmVal = getPigmentation();
    eemData.pigmentation = pigmVal;
    updateDerivedParamHint();

    eemData.files.forEach(function(fname) {
        var mapData = eemData.maps[fname];
        if (!mapData) return;

        function getPoint(ex, em) {
            var xi = -1, ei = -1, bestDx = 0.5, bestDe = 0.5;
            mapData.ex_wl.forEach(function(v, i) { var d = Math.abs(v - ex); if (d < bestDx) { bestDx = d; xi = i; } });
            mapData.em_wl.forEach(function(v, i) { var d = Math.abs(v - em); if (d < bestDe) { bestDe = d; ei = i; } });
            return (xi === -1 || ei === -1) ? null : mapData.intensity[ei][xi];
        }

        var params;
        if (eemData.analysis_mode === 'RT') {
            var f685 = getPoint(440, 685), f695 = getPoint(440, 695), f730 = getPoint(440, 730);
            params = {F685: f685, F695: f695, F730: f730,
                      F685_to_F730: null, F695_to_F730: null, F695_to_F685: null,
                      PBS_F657: null, PBS_F685: null, PBS_F705: null, PBS_F730: null, PBS_tot: null,
                      PBS_free_norm: null, PBS_PSII_norm: null, PBS_PSI_norm: null,
                      PBS_F685_to_F705: null, PBS_F685_to_F730: null};
            if (f685 != null && f730 != null && f730 > 0) params.F685_to_F730 = f685 / f730;
            if (f695 != null && f730 != null && f730 > 0) params.F695_to_F730 = f695 / f730;
            if (f695 != null && f685 != null && f685 > 0) params.F695_to_F685 = f695 / f685;
            var pbsF657 = getPoint(620, 657), pbsF685 = getPoint(620, 685),
                pbsF705 = getPoint(620, 705), pbsF730 = getPoint(620, 730);
            params.PBS_F657 = pbsF657; params.PBS_F685 = pbsF685;
            params.PBS_F705 = pbsF705; params.PBS_F730 = pbsF730;
            if (pbsF657 != null && pbsF685 != null && pbsF705 != null) {
                var pbsTot = pbsF657 + pbsF685 + pbsF705;
                params.PBS_tot = pbsTot;
                if (pbsTot > 0) {
                    params.PBS_free_norm = pbsF657 / pbsTot;
                    params.PBS_PSII_norm = pbsF685 / pbsTot;
                    params.PBS_PSI_norm  = pbsF705 / pbsTot;
                }
            }
            if (pbsF685 != null && pbsF705 != null && pbsF705 > 0) params.PBS_F685_to_F705 = pbsF685 / pbsF705;
            if (pbsF685 != null && pbsF730 != null && pbsF730 > 0) params.PBS_F685_to_F730 = pbsF685 / pbsF730;
        } else {
            var chlPSII = getPoint(440, 689), chlPSI = getPoint(440, 724);
            params = {Chl_PSII: chlPSII, Chl_PSI: chlPSI, Chl_tot: null,
                      Chl_PSII_norm: null, Chl_PSI_norm: null, PSII_to_PSI: null,
                      PBS_free: null, PBS_PSII: null, PBS_PSI: null, PBS_tot: null,
                      PBS_free_norm: null, PBS_PSII_norm: null, PBS_PSI_norm: null,
                      PBS_PSII_to_PBS_PSI: null, PC_to_PE: null};
            if (chlPSII != null && chlPSI != null) {
                var tot = chlPSII + chlPSI;
                params.Chl_tot = tot;
                if (tot > 0) { params.Chl_PSII_norm = chlPSII / tot; params.Chl_PSI_norm = chlPSI / tot; }
                if (chlPSI > 0) params.PSII_to_PSI = chlPSII / chlPSI;
            }
            if (pigmVal !== 'checkbox_chl_only') {
                var pbsFree = null, pbsPSII = null, pbsPSI = null;
                if (pigmVal === 'checkbox_chl_PC') {
                    pbsFree = getPoint(620, 662); pbsPSII = getPoint(620, 689); pbsPSI = getPoint(620, 724);
                } else if (pigmVal === 'checkbox_chl_PE') {
                    var p562 = getPoint(560, 662), p558 = getPoint(560, 580);
                    if (p562 != null && p558 != null) pbsFree = p562 + p558;
                    pbsPSII = getPoint(560, 689); pbsPSI = getPoint(560, 724);
                } else if (pigmVal === 'checkbox_chl_PC_PE') {
                    var has560 = mapData.ex_wl.some(function(v) { return Math.abs(v - 560) < 0.5; });
                    if (has560) {
                        pbsFree  = (getPoint(620, 662) || 0) + (getPoint(560, 662) || 0) + (getPoint(560, 580) || 0);
                        pbsPSII  = (getPoint(620, 689) || 0) + (getPoint(560, 689) || 0);
                        pbsPSI   = (getPoint(620, 724) || 0) + (getPoint(560, 724) || 0);
                        var pc = getPoint(620, 662), pe662 = getPoint(560, 662), pe580 = getPoint(560, 580);
                        if (pc != null && pe662 != null && pe580 != null) {
                            var pe = pe662 + pe580;
                            params.PC_to_PE = pe > 0 ? pc / pe : null;
                        }
                    } else {
                        pbsFree = getPoint(620, 662); pbsPSII = getPoint(620, 689); pbsPSI = getPoint(620, 724);
                    }
                }
                params.PBS_free = pbsFree; params.PBS_PSII = pbsPSII; params.PBS_PSI = pbsPSI;
                if (pbsFree != null && pbsPSII != null && pbsPSI != null) {
                    var pbsTot = pbsFree + pbsPSII + pbsPSI;
                    params.PBS_tot = pbsTot;
                    if (pbsTot > 0) {
                        params.PBS_free_norm = pbsFree / pbsTot;
                        params.PBS_PSII_norm = pbsPSII / pbsTot;
                        params.PBS_PSI_norm  = pbsPSI  / pbsTot;
                    }
                    if (pbsPSI > 0) params.PBS_PSII_to_PBS_PSI = pbsPSII / pbsPSI;
                }
            }
        }
        eemData.params[fname] = params;
    });

    renderDerivedTab();
}

// ============================================================
// Client-side spectra re-extraction from map data
// ============================================================
function reExtractSpectraFromMaps() {
    if (!eemData) return;

    var exWls = [], emWls = [];
    for (var i = 1; i <= 6; i++) {
        var ev = (document.getElementById('eem-ex-' + i) || {}).value;
        var mv = (document.getElementById('eem-em-' + i) || {}).value;
        if (ev && String(ev).trim()) exWls.push(parseInt(parseFloat(ev)));
        if (mv && String(mv).trim()) emWls.push(parseInt(parseFloat(mv)));
    }
    var normEx = parseInt(parseFloat(document.getElementById('eem-ex-norm').value)) || 0;
    var normEm = parseInt(parseFloat(document.getElementById('eem-em-norm').value)) || 0;
    var normExMin = parseFloat(document.getElementById('eem-ex-norm-min').value) || 0;
    var normExMax = parseFloat(document.getElementById('eem-ex-norm-max').value) || 0;
    var normEmMin = parseFloat(document.getElementById('eem-em-norm-min').value) || 0;
    var normEmMax = parseFloat(document.getElementById('eem-em-norm-max').value) || 0;

    eemData.ex_wls  = exWls;
    eemData.em_wls  = emWls;
    eemData.norm_ex = normEx;
    eemData.norm_em = normEm;

    eemData.emission_spectra  = {};
    eemData.excitation_spectra = {};
    exWls.forEach(function(ex) { eemData.emission_spectra[String(ex)]  = {wl: [], raw: {}, norm: {}}; });
    emWls.forEach(function(em) { eemData.excitation_spectra[String(em)] = {wl: [], raw: {}, norm: {}}; });

    eemData.files.forEach(function(fname) {
        var mapData = eemData.maps[fname];
        if (!mapData) return;
        var exWlArr = mapData.ex_wl, emWlArr = mapData.em_wl, intensity = mapData.intensity;

        function nearestIdx(arr, val) {
            var best = -1, bestDist = 0.5;
            for (var k = 0; k < arr.length; k++) {
                var d = Math.abs(arr[k] - val);
                if (d < bestDist) { bestDist = d; best = k; }
            }
            return best;
        }

        // Returns index of fixed λ OR index of maximum within window, depending on refNormMode
        function refNormIdx(wlArr, vals, fixedWl, winMin, winMax) {
            if (refNormMode === 'window' && winMin && winMax) {
                var bestIdx = -1, bestVal = -Infinity;
                for (var k = 0; k < wlArr.length; k++) {
                    if (wlArr[k] >= winMin && wlArr[k] <= winMax && vals[k] > bestVal) {
                        bestVal = vals[k]; bestIdx = k;
                    }
                }
                return bestIdx;
            }
            return fixedWl ? nearestIdx(wlArr, fixedWl) : -1;
        }

        exWls.forEach(function(ex) {
            var xi = nearestIdx(exWlArr, ex);
            if (xi === -1) return;
            var es = eemData.emission_spectra[String(ex)];
            if (!es.wl.length) es.wl = emWlArr.slice();
            var vals = emWlArr.map(function(_, i) { return intensity[i][xi]; });
            es.raw[fname] = vals;
            var hasEmRef = refNormMode === 'window' ? (normEmMin && normEmMax) : normEm;
            if (hasEmRef) {
                var ni = refNormIdx(emWlArr, vals, normEm, normEmMin, normEmMax);
                if (ni !== -1 && vals[ni] !== 0)
                    es.norm[fname] = vals.map(function(v) { return v / vals[ni]; });
            }
        });

        emWls.forEach(function(em) {
            var ei = nearestIdx(emWlArr, em);
            if (ei === -1) return;
            var xs = eemData.excitation_spectra[String(em)];
            if (!xs.wl.length) xs.wl = exWlArr.slice();
            var vals = exWlArr.map(function(_, j) { return intensity[ei][j]; });
            xs.raw[fname] = vals;
            var hasExRef = refNormMode === 'window' ? (normExMin && normExMax) : normEx;
            if (hasExRef) {
                var ni = refNormIdx(exWlArr, vals, normEx, normExMin, normExMax);
                if (ni !== -1 && vals[ni] !== 0)
                    xs.norm[fname] = vals.map(function(v) { return v / vals[ni]; });
            }
        });
    });

    focusExWl = null;
    detectSingleEx();
    initDeconvUI();
    renderSpectraTab();
}

// ============================================================
// Deconvolution — interactive per-peak sliders
// ============================================================
function renderDeconvSliders(fitParams, xArr, yArr) {
    var container = document.getElementById('deconv-sliders');
    if (!container) return;
    var nPeaks = fitParams.length / 3;
    if (nPeaks === 0) { container.innerHTML = ''; return; }

    var yMax = Math.max.apply(null, yArr);
    var html = '<div class="card card-body py-2 px-3" style="font-size:0.84rem;">' +
        '<p class="mb-2 font-weight-bold text-muted" style="font-size:0.82rem;">' +
        '<i class="fa fa-sliders mr-1"></i>Interactive adjustment — drag to update chart in real time</p>';

    for (var i = 0; i < nPeaks; i++) {
        var A    = fitParams[i*3];
        var mu   = fitParams[i*3+1];
        var sig  = Math.abs(fitParams[i*3+2]);
        var fwhm = (2.355 * sig).toFixed(1);
        var color = PEAK_COLORS[i % PEAK_COLORS.length];
        var aMax  = Math.max(1, (yMax * 1.5)).toFixed(0);

        html +=
            '<div class="mb-2 pb-2" style="border-bottom:1px solid #e9ecef;">' +
            '<span class="font-weight-bold mr-3" style="color:' + color + ';">Peak ' + (i+1) + '</span>' +
            // mu slider
            '<span class="mr-3 d-inline-flex align-items-center" style="gap:4px;">' +
                '<label class="mb-0 text-muted" style="min-width:52px;">μ (nm)</label>' +
                '<input type="range" class="custom-range" style="width:130px;" ' +
                    'id="dslider-mu-' + i + '" ' +
                    'min="' + (mu - 30).toFixed(0) + '" max="' + (mu + 30).toFixed(0) + '" ' +
                    'step="0.5" value="' + mu.toFixed(1) + '" oninput="updateDeconvFromSliders()">' +
                '<span id="dslider-mu-val-' + i + '" style="min-width:44px;">' + mu.toFixed(1) + ' nm</span>' +
            '</span>' +
            // amplitude slider
            '<span class="mr-3 d-inline-flex align-items-center" style="gap:4px;">' +
                '<label class="mb-0 text-muted" style="min-width:16px;">A</label>' +
                '<input type="range" class="custom-range" style="width:130px;" ' +
                    'id="dslider-a-' + i + '" ' +
                    'min="0" max="' + aMax + '" step="1" value="' + A.toFixed(0) + '" ' +
                    'oninput="updateDeconvFromSliders()">' +
                '<span id="dslider-a-val-' + i + '" style="min-width:44px;">' + A.toFixed(0) + '</span>' +
            '</span>' +
            // FWHM slider
            '<span class="d-inline-flex align-items-center" style="gap:4px;">' +
                '<label class="mb-0 text-muted" style="min-width:48px;">FWHM</label>' +
                '<input type="range" class="custom-range" style="width:130px;" ' +
                    'id="dslider-fwhm-' + i + '" ' +
                    'min="1" max="80" step="0.5" value="' + fwhm + '" ' +
                    'oninput="updateDeconvFromSliders()">' +
                '<span id="dslider-fwhm-val-' + i + '" style="min-width:52px;">' + fwhm + ' nm</span>' +
            '</span>' +
            '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
}

function updateDeconvFromSliders() {
    if (!deconvFitParams || !deconvCurrentData) return;
    var nPeaks = deconvFitParams.length / 3;
    var newParams = deconvFitParams.slice();

    for (var i = 0; i < nPeaks; i++) {
        var muEl   = document.getElementById('dslider-mu-'   + i);
        var aEl    = document.getElementById('dslider-a-'    + i);
        var fwhmEl = document.getElementById('dslider-fwhm-' + i);
        if (!muEl || !aEl || !fwhmEl) continue;

        var mu   = parseFloat(muEl.value);
        var A    = parseFloat(aEl.value);
        var fwhm = parseFloat(fwhmEl.value);
        var sig  = fwhm / 2.355;

        newParams[i*3]   = A;
        newParams[i*3+1] = mu;
        newParams[i*3+2] = sig;

        document.getElementById('dslider-mu-val-'   + i).textContent = mu.toFixed(1)   + ' nm';
        document.getElementById('dslider-a-val-'    + i).textContent = A.toFixed(0);
        document.getElementById('dslider-fwhm-val-' + i).textContent = fwhm.toFixed(1) + ' nm';
    }

    deconvFitParams = newParams;
    var d = deconvCurrentData;
    renderDeconvChart(d.xArr, d.yArr, deconvFitParams, d.fname, d.exWl);
    renderDeconvResults(deconvFitParams, d.xArr, d.yArr);
}

// ============================================================
// Deconvolution — drag handles on chart
// ============================================================
function updateSlidersFromParams(params) {
    var nPeaks = params.length / 3;
    for (var i = 0; i < nPeaks; i++) {
        var A    = params[i * 3];
        var mu   = params[i * 3 + 1];
        var fwhm = 2.355 * Math.abs(params[i * 3 + 2]);
        var muEl    = document.getElementById('dslider-mu-'      + i);
        var aEl     = document.getElementById('dslider-a-'       + i);
        var fwhmEl  = document.getElementById('dslider-fwhm-'    + i);
        var muValEl   = document.getElementById('dslider-mu-val-'   + i);
        var aValEl    = document.getElementById('dslider-a-val-'    + i);
        var fwhmValEl = document.getElementById('dslider-fwhm-val-' + i);
        if (muEl)    { muEl.value    = mu.toFixed(1);   if (muValEl)    muValEl.textContent    = mu.toFixed(1)   + ' nm'; }
        if (aEl)     { aEl.value     = A.toFixed(0);    if (aValEl)     aValEl.textContent     = A.toFixed(0); }
        if (fwhmEl)  { fwhmEl.value  = fwhm.toFixed(1); if (fwhmValEl)  fwhmValEl.textContent  = fwhm.toFixed(1) + ' nm'; }
    }
}

function attachDeconvDrag() {
    if (deconvDragAttached) return;
    deconvDragAttached = true;
    var canvas = document.getElementById('deconv-chart');
    if (!canvas) return;

    function getLogicalPos(e) {
        var rect = canvas.getBoundingClientRect();
        var src  = e.touches ? e.touches[0] : e;
        return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    // Returns {pi, type} where type = 'apex' | 'fwhm', or null if nothing is near
    function nearestHandle(pos) {
        var chart = chartInst['deconv'];
        if (!chart || !deconvFitParams || !chart.scales || !chart.scales.x) return null;
        var xs = chart.scales.x, ys = chart.scales.y;
        var nPeaks = deconvFitParams.length / 3;
        var best = null, bestDist = Infinity;
        for (var i = 0; i < nPeaks; i++) {
            var A        = deconvFitParams[i * 3];
            var mu       = deconvFitParams[i * 3 + 1];
            var sig      = Math.abs(deconvFitParams[i * 3 + 2]);
            var halfFwhm = sig * 1.1775;
            var apexPx = xs.getPixelForValue(mu);
            var apexPy = ys.getPixelForValue(A);
            var dApex  = Math.sqrt(Math.pow(pos.x - apexPx, 2) + Math.pow(pos.y - apexPy, 2));
            if (dApex < 14 && dApex < bestDist) { bestDist = dApex; best = { pi: i, type: 'apex' }; }
            var halfPy = ys.getPixelForValue(A / 2);
            [xs.getPixelForValue(mu - halfFwhm), xs.getPixelForValue(mu + halfFwhm)].forEach(function(hpx) {
                var dH = Math.sqrt(Math.pow(pos.x - hpx, 2) + Math.pow(pos.y - halfPy, 2));
                if (dH < 10 && dH < bestDist) { bestDist = dH; best = { pi: i, type: 'fwhm' }; }
            });
        }
        return best;
    }

    canvas.addEventListener('mousedown', function(e) {
        var pos = getLogicalPos(e);
        var h   = nearestHandle(pos);
        if (!h) return;
        e.preventDefault();
        deconvDragState = { peakIdx: h.pi, type: h.type, origMu: deconvFitParams[h.pi * 3 + 1] };
        canvas.style.cursor = h.type === 'fwhm' ? 'ew-resize' : 'grabbing';
    });

    canvas.addEventListener('mousemove', function(e) {
        var pos = getLogicalPos(e);
        if (!deconvDragState) {
            var h = nearestHandle(pos);
            canvas.style.cursor = !h ? (deconvCurrentData ? 'crosshair' : 'default')
                                     : h.type === 'fwhm' ? 'ew-resize' : 'grab';
            return;
        }
        e.preventDefault();
        var chart = chartInst['deconv'];
        if (!chart || !chart.scales || !chart.scales.x || !deconvCurrentData) return;
        var pi = deconvDragState.peakIdx;
        var d  = deconvCurrentData;
        if (deconvDragState.type === 'apex') {
            var newMu = chart.scales.x.getValueForPixel(pos.x);
            var newA  = chart.scales.y.getValueForPixel(pos.y);
            newMu = Math.max(d.xArr[0], Math.min(d.xArr[d.xArr.length - 1], newMu));
            newA  = Math.max(0, newA);
            deconvFitParams[pi * 3]     = newA;
            deconvFitParams[pi * 3 + 1] = newMu;
        } else {
            var mu       = deconvFitParams[pi * 3 + 1];
            var newX     = chart.scales.x.getValueForPixel(pos.x);
            var halfFwhm = Math.abs(newX - mu);
            deconvFitParams[pi * 3 + 2] = Math.max(0.5, halfFwhm * 2 / 2.355);
        }
        renderDeconvChart(d.xArr, d.yArr, deconvFitParams, d.fname, d.exWl);
        updateSlidersFromParams(deconvFitParams);
        renderDeconvResults(deconvFitParams, d.xArr, d.yArr);
    });

    canvas.addEventListener('dblclick', function(e) {
        // Prevent dblclick from firing if a real drag just ended
        if (!deconvCurrentData) return;
        var pos   = getLogicalPos(e);
        var h     = nearestHandle(pos);
        var chart = chartInst['deconv'];
        var d     = deconvCurrentData;

        if (h && h.type === 'apex') {
            // ── Remove peak ──────────────────────────────────────────────
            deconvFitParams.splice(h.pi * 3, 3);
            deconvPeakMus.splice(h.pi, 1);
            if (deconvFitParams.length > 0) {
                renderDeconvChart(d.xArr, d.yArr, deconvFitParams, d.fname, d.exWl);
                renderDeconvResults(deconvFitParams, d.xArr, d.yArr);
                renderDeconvSliders(deconvFitParams, d.xArr, d.yArr);
            } else {
                if (chartInst['deconv']) { chartInst['deconv'].destroy(); delete chartInst['deconv']; }
                document.getElementById('deconv-sliders').innerHTML = '';
                document.getElementById('deconv-results').innerHTML = '';
            }
            rebuildPeaksEditor();

        } else if (!h) {
            // ── Add peak at click position ────────────────────────────────
            if (!chart || !chart.scales || !chart.scales.x) return;
            var mu = chart.scales.x.getValueForPixel(pos.x);
            var A  = chart.scales.y.getValueForPixel(pos.y);
            mu = Math.max(d.xArr[0], Math.min(d.xArr[d.xArr.length - 1], mu));
            A  = Math.max(0, A);
            deconvFitParams.push(A, mu, 8);          // σ₀ = 8 nm (FWHM ≈ 19 nm)
            deconvPeakMus.push(Math.round(mu));
            renderDeconvChart(d.xArr, d.yArr, deconvFitParams, d.fname, d.exWl);
            renderDeconvResults(deconvFitParams, d.xArr, d.yArr);
            renderDeconvSliders(deconvFitParams, d.xArr, d.yArr);
            rebuildPeaksEditor();
        }
        // dblclick on FWHM handle: no action
    });

    function stopDrag() {
        if (deconvDragState) { deconvDragState = null; canvas.style.cursor = 'default'; }
    }
    canvas.addEventListener('mouseup',    stopDrag);
    canvas.addEventListener('mouseleave', stopDrag);
}

// ============================================================
// Methods section text generator
// ============================================================
function showMethodsModal() {
    if (!eemData) { alert('Please analyze data first.'); return; }
    var ta = document.getElementById('eem-methods-text-area');
    if (ta) ta.value = generateMethodsText();
    $('#eem-methods-modal').modal('show');
}

function copyMethodsText() {
    var ta = document.getElementById('eem-methods-text-area');
    if (!ta) return;
    ta.select();
    var btn = document.getElementById('eem-methods-copy-btn');
    navigator.clipboard.writeText(ta.value).then(function() {
        if (!btn) return;
        var o = btn.innerHTML;
        btn.innerHTML = '<i class="fa fa-check mr-1"></i> Copied!';
        setTimeout(function() { btn.innerHTML = o; }, 1800);
    }).catch(function() { document.execCommand('copy'); });
}

function generateMethodsText() {
    var spectroSel  = document.getElementById('eem-spectrofluorometer');
    var spectroFull = spectroSel ? spectroSel.options[spectroSel.selectedIndex].text : 'spectrofluorometer';
    var spectroName = spectroFull.replace(/\s*[—\-–]+\s*\.\w+\s*$/, '').trim();

    var mode    = eemData.analysis_mode || '77K';
    var n       = eemData.files.length;
    var fList   = n <= 8 ? eemData.files.join(', ') : n + ' files';
    var pigmVal = getPigmentation();
    var exWls   = (eemData.ex_wls || []).join(', ');
    var emWls   = (eemData.em_wls || []).join(', ');

    var normLabel = {
        raw:  'no normalization (raw fluorescence intensities)',
        peak: 'peak normalization (each spectrum divided by its maximum)',
        area: 'area normalization (each spectrum divided by its total spectral area)',
        ref:  'reference-wavelength normalization'
    }[normMode] || normMode;

    var gnames = Object.values(groups).filter(Boolean)
        .filter(function(v, i, a) { return a.indexOf(v) === i; });

    var lines = [];

    if (mode === '77K') {
        lines.push(
            'Excitation-emission matrix (EEM) fluorescence spectroscopy was performed at 77\u202fK using a ' +
            spectroName + '. Raw data files were processed using the 77K EEM Analyzer module of CyanoTools ' +
            '(https://tools-py.e-cyanobacterium.org/ex_em_spectra_analysis). ' +
            'A total of ' + n + ' sample' + (n !== 1 ? 's were' : ' was') + ' analyzed (' + fList + ').'
        );

        var specLine = 'Emission spectra were extracted at excitation wavelength' +
            (eemData.ex_wls.length !== 1 ? 's ' : ' ') + exWls + '\u202fnm';
        if (eemData.em_wls.length)
            specLine += ', and excitation spectra at emission wavelength' +
                (eemData.em_wls.length !== 1 ? 's ' : ' ') + emWls + '\u202fnm';
        specLine += '. Spectral visualization applied ' + normLabel + '.';
        lines.push(specLine);

        var dp = 'Photosystem stoichiometry was determined from chlorophyll fluorescence intensities at ' +
            'Ex\u202f440/Em\u202f689\u202fnm (Chl-PSII) and Ex\u202f440/Em\u202f724\u202fnm (Chl-PSI); ' +
            'the PSII/PSI ratio was calculated as Chl-PSII\u202f/\u202fChl-PSI (Murakami, 1997).';

        if (pigmVal === 'checkbox_chl_PC' || pigmVal === 'checkbox_chl_PC_PE') {
            dp += ' Phycobilisome (PBS) coupling under PC excitation was assessed from ' +
                'Ex\u202f620/Em\u202f662\u202fnm (PBS-free; uncoupled phycobilisomes), ' +
                'Ex\u202f620/Em\u202f689\u202fnm (PBS-PSII; PBS coupled to PSII), and ' +
                'Ex\u202f620/Em\u202f724\u202fnm (PBS-PSI; PBS coupled to PSI).';
        }
        if (pigmVal === 'checkbox_chl_PE' || pigmVal === 'checkbox_chl_PC_PE') {
            dp += ' Phycoerythrin (PE) contribution was assessed from Ex\u202f560/Em\u202f580\u202fnm (PE emission), ' +
                'Ex\u202f560/Em\u202f662\u202fnm (PBS-free, PE), Ex\u202f560/Em\u202f689\u202fnm (PBS-PSII, PE), and ' +
                'Ex\u202f560/Em\u202f724\u202fnm (PBS-PSI, PE).';
        }
        if (pigmVal !== 'checkbox_chl_only') {
            dp += ' PBS coupling fractions (PBS-free\u202fnorm, PBS-PSII\u202fnorm, PBS-PSI\u202fnorm) were ' +
                'calculated by normalizing each component by the PBS total signal ' +
                '(PBS-free\u202f+\u202fPBS-PSII\u202f+\u202fPBS-PSI). ' +
                'The PBS-PSII/PBS-PSI ratio served as a state-transition indicator, with higher values ' +
                'reflecting State\u202f1 (PBS preferentially coupled to PSII) and lower values reflecting ' +
                'State\u202f2 (PBS preferentially coupled to PSI; Mullineaux\u202f&\u202fAllen, 1990).';
        }
        lines.push(dp);

    } else {
        lines.push(
            'Excitation-emission matrix (EEM) fluorescence spectroscopy was performed at room temperature ' +
            'using a ' + spectroName + '. Raw data files were processed using the RT EEM Analyzer module of ' +
            'CyanoTools (https://tools-py.e-cyanobacterium.org/ex_em_spectra_analysis). ' +
            'A total of ' + n + ' sample' + (n !== 1 ? 's were' : ' was') + ' analyzed (' + fList + ').'
        );

        var specLineRT = 'Emission spectra were extracted at excitation wavelength' +
            (eemData.ex_wls.length !== 1 ? 's ' : ' ') + exWls + '\u202fnm. ' +
            'Spectral visualization applied ' + normLabel + '.';
        lines.push(specLineRT);

        lines.push(
            'Room-temperature fluorescence parameters were derived from: Ex\u202f440/Em\u202f685\u202fnm ' +
            '(F685; PSII core, CP43/CP47), Ex\u202f440/Em\u202f695\u202fnm (F695; CP47 inner antenna), ' +
            'Ex\u202f440/Em\u202f730\u202fnm (F730; PSI red-shifted chlorophylls). The F685/F730 ratio ' +
            '(Ex\u202f440\u202fnm) was used as a relative PSII:PSI indicator. PBS coupling was assessed ' +
            'under Ex\u202f620\u202fnm excitation: Em\u202f657\u202fnm (PBS-free; uncoupled phycobilisomes), ' +
            'Em\u202f685\u202fnm (PBS-PSII; PBS coupled to PSII), Em\u202f705\u202fnm (PBS-PSI; PBS coupled to PSI), ' +
            'and Em\u202f730\u202fnm (PBS-F730). PBS coupling fractions (PBS-free\u202fnorm, PBS-PSII\u202fnorm, ' +
            'PBS-PSI\u202fnorm) were normalized by the PBS total signal (PBS-free\u202f+\u202fPBS-PSII\u202f+\u202fPBS-PSI; ' +
            'Zavřel et al., 2021). The state-transition ratio (PBS\u202fF685/F705) reflects PBS-PSII coupling ' +
            '(State\u202f1) at higher values and PBS-PSI coupling (State\u202f2) at lower values.'
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

// ============================================================
// DOMContentLoaded
// ============================================================
document.addEventListener('DOMContentLoaded', function() {

    updateDerivedParamHint();
    updateSpectrofluorometerHint();

    // Drop zone
    var dropZone = document.getElementById('eem-drop-zone');
    var fileInput = document.getElementById('eem-files');
    dropZone.addEventListener('click', function() { fileInput.click(); });
    fileInput.addEventListener('change', function() { handleFiles(this.files); });
    dropZone.addEventListener('dragover', function(e) {
        e.preventDefault(); dropZone.style.background = '#e3eaf2';
    });
    dropZone.addEventListener('dragleave', function() { dropZone.style.background = '#f8f9fa'; });
    dropZone.addEventListener('drop', function(e) {
        e.preventDefault(); dropZone.style.background = '#f8f9fa';
        handleFiles(e.dataTransfer.files);
    });

    // Segmented norm control
    document.querySelectorAll('#spectra-norm-btns .btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            normMode = this.dataset.norm;
            document.querySelectorAll('#spectra-norm-btns .btn').forEach(function(b) {
                b.classList.remove('btn-primary');
                b.classList.add('btn-outline-primary');
            });
            this.classList.remove('btn-outline-primary');
            this.classList.add('btn-primary');
            if (eemData) renderSpectraTab();
        });
    });

    // Tab shown events (jQuery required — Bootstrap 4 fires via jQuery event system)
    $('#eemTabs a[data-toggle="tab"]').on('shown.bs.tab', function(e) {
        var target = $(e.target).attr('href');
        if (target === '#eem-spectra' && dirtyTabs.has('spectra')) renderSpectraTab();
        if (target === '#eem-map'     && dirtyTabs.has('map'))     renderMapTab();
        if (target === '#eem-derived' && dirtyTabs.has('derived')) renderDerivedTab();
        if (target === '#eem-groups'  && dirtyTabs.has('groups'))  renderGroupsTab();
        if (target === '#eem-deconv'  && chartInst['deconv'])      chartInst['deconv'].resize();
        if (target === '#eem-parafac') updateParafacTabState();
    });

    // Map controls
    document.getElementById('map-colorscale').addEventListener('change', renderMapTab);
    document.getElementById('map-log-scale').addEventListener('change', renderMapTab);

    // Deconvolution drag handles (canvas is always in DOM)
    attachDeconvDrag();

    // Bootstrap tooltips (used by PARAFAC controls)
    $('[data-toggle="tooltip"]').tooltip({ trigger: 'hover', container: 'body' });

});


// ============================================================
// PARAFAC
// ============================================================
var parafacResults = null;
var parafacDiagResults = null;
var parafacAnnotations = [];   // user-editable per-component labels

// Component colours (one per component, up to 8)
var PARAFAC_COLORS = ['#4472C4','#ED7D31','#A9D18E','#FF0000',
                      '#7030A0','#00B0F0','#FFC000','#70AD47'];

function _parafacValidate() {
    if (!eemData || !eemData.files || eemData.files.length < 3)
        return 'At least 3 samples are needed for PARAFAC analysis.';
    var keys = Object.keys(eemData.maps);
    if (!keys.length) return 'No EEM maps available.';
    var ref = eemData.maps[keys[0]];
    for (var i = 1; i < keys.length; i++) {
        var m = eemData.maps[keys[i]];
        if (m.ex_wl.length !== ref.ex_wl.length || m.em_wl.length !== ref.em_wl.length)
            return 'Grid mismatch: all samples must have identical Ex/Em grids for PARAFAC. ' +
                   'Try uploading only files from one instrument type.';
    }
    return null;
}

function updateParafacTabState() {
    var err = _parafacValidate();
    var notReady = document.getElementById('parafac-not-ready');
    var controls = document.getElementById('parafac-controls');
    if (!notReady) return;
    if (err) {
        document.getElementById('parafac-not-ready-msg').textContent = err;
        notReady.style.display = '';
        controls.style.display = 'none';
    } else {
        notReady.style.display = 'none';
        controls.style.display = '';
    }
}

function updateParafacScatterUI() {
    ['r1','r2','ram'].forEach(function(id) {
        var checked = document.getElementById('par-' + id + '-check').checked;
        document.getElementById('par-' + id + '-row').style.display = checked ? '' : 'none';
    });
}

function _buildParafacPayload(extra) {
    var scatter = {
        rayleigh1_width: document.getElementById('par-r1-check').checked
            ? parseFloat(document.getElementById('par-r1-slider').value) : 0,
        rayleigh2_width: document.getElementById('par-r2-check').checked
            ? parseFloat(document.getElementById('par-r2-slider').value) : 0,
        raman_width: document.getElementById('par-ram-check').checked
            ? parseFloat(document.getElementById('par-ram-slider').value) : 0,
        interpolate: document.getElementById('par-interp-check').checked
    };
    var crop = {
        ex_min: parseFloat(document.getElementById('par-ex-min').value) || null,
        ex_max: parseFloat(document.getElementById('par-ex-max').value) || null,
        em_min: parseFloat(document.getElementById('par-em-min').value) || null,
        em_max: parseFloat(document.getElementById('par-em-max').value) || null
    };
    return Object.assign({
        maps:        eemData.maps,
        scatter:     scatter,
        crop:        crop,
        pigmentation: getPigmentation()
    }, extra || {});
}

function _parafacShowError(msg) {
    var el = document.getElementById('parafac-error');
    el.textContent = msg;
    el.style.display = '';
}
function _parafacHideError() {
    document.getElementById('parafac-error').style.display = 'none';
}

// ── Step 1: Diagnostic (CORCONDIA) ───────────────────────────────────────────
function runParafacDiagnostic() {
    var err = _parafacValidate();
    if (err) { _parafacShowError(err); return; }
    _parafacHideError();

    var spinner = document.getElementById('par-diag-spinner');
    spinner.style.display = '';

    var payload = _buildParafacPayload({
        f_max: parseInt(document.getElementById('par-fmax-slider').value)
    });

    fetch('/api/eem_parafac_diagnostic', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
        spinner.style.display = 'none';
        if (data.error) { _parafacShowError(data.error); return; }
        parafacDiagResults = data.results;
        renderParafacDiagnostic(data.results);
    })
    .catch(function(e) {
        spinner.style.display = 'none';
        _parafacShowError('Request failed: ' + e);
    });
}

function renderParafacDiagnostic(results) {
    document.getElementById('parafac-diag-section').style.display = '';

    var fs = results.map(function(r) { return r.f; });
    var ccs = results.map(function(r) { return r.corcondia; });
    var evs = results.map(function(r) { return r.explained_variance; });

    function makeChart(canvasId, label, values, color, refLine) {
        if (chartInst[canvasId]) chartInst[canvasId].destroy();
        var ctx = document.getElementById(canvasId).getContext('2d');
        var datasets = [{
            label: label,
            data: values,
            borderColor: color,
            backgroundColor: color + '33',
            fill: false,
            tension: 0.3,
            pointRadius: 5,
            pointHoverRadius: 7
        }];
        if (refLine !== undefined) {
            datasets.push({
                label: 'Threshold (80%)',
                data: fs.map(function() { return refLine; }),
                borderColor: '#dc3545',
                borderDash: [5, 4],
                borderWidth: 1.5,
                pointRadius: 0,
                fill: false
            });
        }
        chartInst[canvasId] = new Chart(ctx, {
            type: 'line',
            data: { labels: fs, datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: true, position: 'bottom',
                    labels: { boxWidth: 12, font: { size: 11 } } } },
                scales: {
                    x: { title: { display: true, text: 'Number of components (F)',
                                  font: { size: 11 } } },
                    y: { title: { display: true, text: label, font: { size: 11 } } }
                }
            }
        });
    }

    makeChart('parafac-corcondia-chart', 'CORCONDIA (%)', ccs, '#4472C4', 80);
    makeChart('parafac-expvar-chart', 'Explained variance (%)', evs, '#70AD47');
}

// ── Step 2: Full PARAFAC fit ──────────────────────────────────────────────────
function runParafac() {
    var err = _parafacValidate();
    if (err) { _parafacShowError(err); return; }
    _parafacHideError();

    var spinner = document.getElementById('par-fit-spinner');
    spinner.style.display = '';

    var rank = parseInt(document.getElementById('par-rank-slider').value);
    var payload = _buildParafacPayload({
        rank:       rank,
        n_restarts: parseInt(document.getElementById('par-restarts-slider').value),
        max_iter:   500,
        tol:        parseFloat(document.getElementById('par-tol-select').value)
    });

    fetch('/api/eem_parafac', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
        spinner.style.display = 'none';
        if (data.error) { _parafacShowError(data.error); return; }
        parafacResults = data;
        parafacAnnotations = data.annotations.slice();
        renderParafacResults(data);
    })
    .catch(function(e) {
        spinner.style.display = 'none';
        _parafacShowError('Request failed: ' + e);
    });
}

function renderParafacResults(data) {
    var section = document.getElementById('parafac-results-section');
    section.style.display = '';

    // Quality badge
    var badge = document.getElementById('parafac-quality-badge');
    var cls = data.explained_variance >= 90 ? 'badge-success' :
              data.explained_variance >= 70 ? 'badge-warning' : 'badge-danger';
    badge.className = 'badge ' + cls;
    badge.textContent = 'Explained variance: ' + data.explained_variance + '%  |  RMSE: ' + data.rmse;

    // Per-component cards
    var row = document.getElementById('parafac-components-row');
    row.innerHTML = '';
    for (var r = 0; r < data.n_components; r++) {
        row.appendChild(_buildComponentCard(r, data));
    }

    // Scores chart
    _renderParafacScoresChart(data);

    // Scores table
    _renderParafacScoresTable(data);

    // 2D maps: component fingerprints + reconstructed/residuals
    renderParafacCompMaps(data);
    _initParafacReconSelect(data);
    renderParafacReconMaps();
}

function _buildComponentCard(r, data) {
    var col = document.createElement('div');
    col.className = 'col-md-6 mb-3';
    col.id = 'parafac-comp-card-' + r;

    var color = PARAFAC_COLORS[r % PARAFAC_COLORS.length];
    var annot = parafacAnnotations[r] || ('Component ' + (r + 1));

    col.innerHTML =
        '<div class="card h-100">' +
          '<div class="card-header py-1 d-flex align-items-center" style="background:' + color + '22; border-left:4px solid ' + color + ';">' +
            '<span class="font-weight-bold mr-2" style="font-size:0.9rem;">Component ' + (r + 1) + '</span>' +
            '<input type="text" class="form-control form-control-sm" style="max-width:260px; font-size:0.82rem;" ' +
              'id="par-annot-' + r + '" value="' + annot + '" ' +
              'onchange="parafacAnnotations[' + r + ']=this.value">' +
          '</div>' +
          '<div class="card-body p-2">' +
            '<div class="row no-gutters">' +
              '<div class="col-6" style="position:relative;height:140px;">' +
                '<canvas id="par-ex-chart-' + r + '"></canvas>' +
              '</div>' +
              '<div class="col-6" style="position:relative;height:140px;">' +
                '<canvas id="par-em-chart-' + r + '"></canvas>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';

    // Draw charts after inserting into DOM
    setTimeout(function() {
        _drawLoadingChart('par-ex-chart-' + r, 'Excitation loading',
            data.ex_wl, data.ex_loadings[r], 'Excitation (nm)', color);
        _drawLoadingChart('par-em-chart-' + r, 'Emission loading',
            data.em_wl, data.em_loadings[r], 'Emission (nm)', color);
    }, 0);

    return col;
}

function _drawLoadingChart(canvasId, label, wl, values, xLabel, color) {
    if (chartInst[canvasId]) chartInst[canvasId].destroy();
    var ctx = document.getElementById(canvasId);
    if (!ctx) return;
    chartInst[canvasId] = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: {
            labels: wl,
            datasets: [{
                label: label,
                data: values,
                borderColor: color,
                backgroundColor: color + '22',
                fill: true,
                tension: 0.3,
                pointRadius: 0,
                borderWidth: 1.5
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                x: { title: { display: true, text: xLabel, font: { size: 10 } },
                     ticks: { maxTicksLimit: 5, font: { size: 9 } } },
                y: { min: 0, max: 1.05,
                     title: { display: true, text: 'Loading (norm.)', font: { size: 10 } },
                     ticks: { maxTicksLimit: 4, font: { size: 9 } } }
            }
        }
    });
}

function _renderParafacScoresChart(data) {
    if (chartInst['parafac-scores']) chartInst['parafac-scores'].destroy();
    var ctx = document.getElementById('parafac-scores-chart').getContext('2d');

    // Use group colors if assigned, else per-component grouped bar
    var datasets = [];
    for (var r = 0; r < data.n_components; r++) {
        var color = PARAFAC_COLORS[r % PARAFAC_COLORS.length];
        var label = parafacAnnotations[r] || ('Component ' + (r + 1));
        datasets.push({
            label: label,
            data: data.scores_by_component[r],
            backgroundColor: color + 'BB',
            borderColor: color,
            borderWidth: 1
        });
    }

    chartInst['parafac-scores'] = new Chart(ctx, {
        type: 'bar',
        data: { labels: data.sample_names, datasets: datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { boxWidth: 14, font: { size: 11 } } }
            },
            scales: {
                x: { ticks: { maxRotation: 45, font: { size: 10 } } },
                y: { title: { display: true, text: 'Score (a.u.)', font: { size: 11 } },
                     beginAtZero: true }
            }
        }
    });
}

function _renderParafacScoresTable(data) {
    var container = document.getElementById('parafac-scores-table-container');
    var headers = ['Sample'].concat(data.annotations.map(function(a, i) {
        return 'C' + (i + 1) + ': ' + a;
    }));

    var rows = data.sample_names.map(function(name, i) {
        return [name].concat(data.scores[i].map(function(v) {
            return v.toFixed(4);
        }));
    });

    var html = '<table class="table table-sm table-bordered" style="font-size:0.83em;"><thead class="thead-light"><tr>' +
        headers.map(function(h) { return '<th>' + h + '</th>'; }).join('') +
        '</tr></thead><tbody>' +
        rows.map(function(r) {
            return '<tr>' + r.map(function(c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
        }).join('') +
        '</tbody></table>';
    container.innerHTML = html;
}

// ── 2D component maps ─────────────────────────────────────────────────────────

function _outerProduct(emLoading, exLoading) {
    // Returns intensity[n_em][n_ex] = emLoading[i] * exLoading[j]
    return emLoading.map(function(em) {
        return exLoading.map(function(ex) { return em * ex; });
    });
}

function renderParafacCompMaps(data) {
    var row = document.getElementById('parafac-comp-maps-row');
    row.innerHTML = '';
    var colorName = document.getElementById('map-colorscale').value;
    var colClass = data.n_components <= 2 ? 'col-md-6' :
                   data.n_components <= 4 ? 'col-md-6' : 'col-md-4';

    for (var r = 0; r < data.n_components; r++) {
        var intensity = _outerProduct(data.em_loadings[r], data.ex_loadings[r]);
        var col = document.createElement('div');
        col.className = colClass + ' mb-3';
        var canvasId = 'parafac-comp-map-' + r;
        var color = PARAFAC_COLORS[r % PARAFAC_COLORS.length];
        col.innerHTML =
            '<div class="d-flex align-items-center mb-1" style="border-left:3px solid ' + color + '; padding-left:5px;">' +
              '<small class="font-weight-bold text-truncate">' +
                'C' + (r + 1) + ': ' + (parafacAnnotations[r] || 'Component ' + (r + 1)) +
              '</small>' +
            '</div>' +
            '<canvas id="' + canvasId + '" width="460" height="320" ' +
              'style="max-width:100%; border:1px solid #dee2e6; display:block;"></canvas>';
        row.appendChild(col);
        // capture r in closure
        (function(id, intens) {
            setTimeout(function() {
                drawHeatmap(id, data.ex_wl, data.em_wl, intens, colorName, false, 0.82);
            }, 0);
        })(canvasId, intensity);
    }
}

function _initParafacReconSelect(data) {
    var sel = document.getElementById('parafac-recon-sample-select');
    sel.innerHTML = '';
    data.sample_names.forEach(function(name, i) {
        var opt = document.createElement('option');
        opt.value = i; opt.textContent = name;
        sel.appendChild(opt);
    });
}

function renderParafacReconMaps() {
    if (!parafacResults) return;
    var data = parafacResults;
    var colorName = document.getElementById('map-colorscale').value;
    var sampleIdx = parseInt(document.getElementById('parafac-recon-sample-select').value) || 0;

    var nEm = data.em_wl.length, nEx = data.ex_wl.length;
    var scores_i = data.scores[sampleIdx];

    // Reconstructed = Σ_r score[r] * outer(em_loading[r], ex_loading[r])
    var recon = [];
    for (var ei = 0; ei < nEm; ei++) {
        recon.push([]);
        for (var xi = 0; xi < nEx; xi++) {
            var v = 0;
            for (var r = 0; r < data.n_components; r++)
                v += scores_i[r] * data.em_loadings[r][ei] * data.ex_loadings[r][xi];
            recon[ei].push(v);
        }
    }

    // Original map (may have different intensity grid if map_range was applied)
    var sampleName = data.sample_names[sampleIdx];
    var origMap = eemData && eemData.maps && eemData.maps[sampleName];

    // Residual: original − reconstructed (only if grids match exactly)
    var residual = null;
    if (origMap && origMap.em_wl.length === nEm && origMap.ex_wl.length === nEx) {
        residual = origMap.intensity.map(function(row, ei) {
            return row.map(function(v, xi) { return v - recon[ei][xi]; });
        });
    }

    // Per-sample explained variance
    if (origMap) {
        var ssRes = 0, ssTot = 0;
        for (var ei = 0; ei < nEm; ei++)
            for (var xi = 0; xi < nEx; xi++) {
                var diff = (origMap.intensity[ei] ? origMap.intensity[ei][xi] : 0) - recon[ei][xi];
                ssRes += diff * diff;
                var ov = origMap.intensity[ei] ? origMap.intensity[ei][xi] : 0;
                ssTot += ov * ov;
            }
        var evSample = ssTot > 0 ? (100 * (1 - ssRes / ssTot)).toFixed(1) : '—';
        document.getElementById('parafac-recon-expvar-badge').textContent =
            'Sample fit: ' + evSample + '%';
    }

    // Build / refresh map canvases
    var row = document.getElementById('parafac-recon-maps-row');
    row.innerHTML = '';

    var addMap = function(id, label, colClass) {
        var col = document.createElement('div');
        col.className = colClass + ' mb-3';
        col.innerHTML = '<small class="font-weight-bold d-block mb-1">' + label + '</small>' +
                        '<canvas id="' + id + '" width="500" height="340" ' +
                          'style="max-width:100%; border:1px solid #dee2e6; display:block;"></canvas>';
        row.appendChild(col);
    };

    var colClass = residual ? 'col-md-4' : 'col-md-6';

    if (origMap) addMap('par-orig-canvas',  'Original', colClass);
    addMap('par-recon-canvas', 'Reconstructed (PARAFAC)', colClass);
    if (residual) addMap('par-resid-canvas', 'Residuals (Original \u2212 Reconstructed)', colClass);

    setTimeout(function() {
        if (origMap)  drawHeatmap('par-orig-canvas',  data.ex_wl, data.em_wl, origMap.intensity, colorName, false, 0.85);
        drawHeatmap('par-recon-canvas', data.ex_wl, data.em_wl, recon, colorName, false, 0.85);
        if (residual) drawHeatmapDiverging('par-resid-canvas', data.ex_wl, data.em_wl, residual, 0.85);
    }, 0);
}

function copyParafacTable() {
    if (!parafacResults) return;
    var data = parafacResults;
    var headers = ['Sample'].concat(parafacAnnotations.map(function(a, i) {
        return 'Component ' + (i + 1) + ': ' + a;
    }));
    var lines = [headers.join('\t')];
    data.sample_names.forEach(function(name, i) {
        lines.push([name].concat(data.scores[i].map(function(v) { return v.toFixed(6); })).join('\t'));
    });
    navigator.clipboard.writeText(lines.join('\n')).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = lines.join('\n');
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
    });
}
