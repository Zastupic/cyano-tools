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
    'Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI','CP43_to_CP47',
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
    'CP43_to_CP47':         'CP43 / CP47  (F685/F695, Ex440)',
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
    'checkbox_chl_only':   ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI','CP43_to_CP47'],
    'checkbox_chl_PC':     ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI','CP43_to_CP47',
                            'PBS_free','PBS_PSII','PBS_PSI','PBS_tot','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PBS_PSII_to_PBS_PSI'],
    'checkbox_chl_PE':     ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI','CP43_to_CP47',
                            'PBS_free','PBS_PSII','PBS_PSI','PBS_tot','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PBS_PSII_to_PBS_PSI'],
    'checkbox_chl_PC_PE':  ['Chl_PSII','Chl_PSI','Chl_tot','Chl_PSII_norm','Chl_PSI_norm','PSII_to_PSI','CP43_to_CP47',
                            'PBS_free','PBS_PSII','PBS_PSI','PBS_tot','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PBS_PSII_to_PBS_PSI','PC_to_PE']
};
var RATIO_PARAMS = ['PSII_to_PSI','CP43_to_CP47','Chl_PSII_norm','Chl_PSI_norm',
                    'PBS_PSII_to_PBS_PSI','PBS_free_norm','PBS_PSII_norm','PBS_PSI_norm','PC_to_PE'];

// ---- Configurable wavelength settings ----
var WL_CONFIG = {
    // 77 K mode
    k77_ex_chl:      440,   // Chl Soret excitation
    k77_ex_pc:       620,   // PC / PBS excitation
    k77_ex_pe:       560,   // PE excitation
    k77_em_psii:     689,   // Chl-PSII and PBS-PSII emission
    k77_em_psi:      724,   // Chl-PSI and PBS-PSI emission
    k77_em_cp43:     685,   // CP43 emission (for CP43/CP47 ratio)
    k77_em_cp47:     695,   // CP47 emission (for CP43/CP47 ratio)
    k77_em_pbs_free: 662,   // PBS-free (APC terminal) emission
    k77_em_pe:       580,   // PE direct emission
    // RT mode
    rt_ex_chl:       440,
    rt_ex_pbs:       620,
    rt_em_f685:      685,   // PSII pool (CP43+CP47 unresolved at RT)
    rt_em_f730:      730,   // PSI
    rt_em_pbs_free:  657,   // uncoupled PBS
    rt_em_pbs_psii:  685,   // PBS→PSII
    rt_em_pbs_psi:   705,   // PBS→PSI
    rt_em_pbs_f730:  730    // direct Chl→PSI under PBS excitation
};

// ---- RT fluorescence param config ----
var RT_PARAM_KEYS = [
    'F685', 'F730',
    'F685_to_F730',
    'PBS_F657', 'PBS_F685', 'PBS_F705', 'PBS_F730', 'PBS_tot',
    'PBS_free_norm', 'PBS_PSII_norm', 'PBS_PSI_norm',
    'PBS_F685_to_F705', 'PBS_F685_to_F730'
];
var RT_PARAM_LABELS = {
    'F685':             'F685 – PSII pool, CP43+CP47 (a.u.)',
    'F730':             'F730 – PSI (a.u.)',
    'F685_to_F730':     'F685 / F730  (PSII pool : PSI, Ex440) †',
    'PBS_F657':         'PBS free (a.u., Ex620/Em657)',
    'PBS_F685':         'PBS→PSII (a.u., Ex620/Em685)',
    'PBS_F705':         'PBS→PSI (a.u., Ex620/Em705)',
    'PBS_F730':         'PBS→F730 (a.u., Ex620/Em730)',
    'PBS_tot':          'PBS total (a.u., Ex620)',
    'PBS_free_norm':    'PBS free / PBS total  (uncoupled fraction)',
    'PBS_PSII_norm':    'PBS-PSII / PBS total  (PSII coupling fraction)',
    'PBS_PSI_norm':     'PBS-PSI / PBS total  (PSI coupling fraction) †',
    'PBS_F685_to_F705': 'PBS F685 / F705  (state transitions, Ex620) †',
    'PBS_F685_to_F730': 'PBS F685 / F730  (Ex620)'
};
// RT params flagged as unreliable due to spectral overlap at RT
var RT_UNRELIABLE_PARAMS = ['F685_to_F730', 'PBS_PSI_norm', 'PBS_F685_to_F705'];
var rtShowUnreliable = true;

function setRtShowUnreliable(val) {
    rtShowUnreliable = val;
    // Sync both checkboxes
    var cb1 = document.getElementById('rt-show-unreliable');
    if (cb1) cb1.checked = val;
    var cb2 = document.getElementById('cmp-rt-show-unreliable');
    if (cb2) cb2.checked = val;
    if (eemData) {
        renderDerivedTab();
        renderComparisonTab();
    }
}

var RT_RATIO_PARAMS = [
    'F685_to_F730',
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
        em: [657, 685, 705, 730, '', ''],
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
    // Sync hidden select
    var sel = document.getElementById('global-pigm-select');
    if (sel && sel.value !== val) sel.value = val;
    // Sync navbar button group
    document.querySelectorAll('#global-pigm-btns button').forEach(function(btn) {
        var active = btn.getAttribute('data-pigm') === val;
        btn.classList.toggle('btn-primary', active);
        btn.classList.toggle('btn-outline-primary', !active);
        btn.style.setProperty('color', active ? '#004085' : 'rgba(255,255,255,0.7)', 'important');
    });
    // Sync radio buttons in Derived Parameters tab
    document.querySelectorAll('input[name="checkbox_pigmentation"]').forEach(function(r) {
        r.checked = (r.value === val);
    });
    recomputeParamsFromMaps();
    // Update deconvolution sub-tabs visibility for new pigmentation
    updateDeconvSubTabs();
    // Re-annotate PARAFAC components client-side (no re-fit needed)
    if (parafacResults) _reAnnotateParafacComponents(val);
    // Update PARAFAC rank suggestion for this pigmentation
    updateParafacRankSuggestion(val);
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

// Show "Copy scores" button when any component is rejected or reassigned from auto-suggestion
function _updateCopyScoresBtn() {
    var btn = document.getElementById('parafac-copy-scores-btn');
    if (!btn) return;
    var anyRejected = parafacRejected.some(function(r) { return r; });
    var anyReassigned = parafacPigmAssign.some(function(a, i) {
        return a !== parafacPigmAssignDefault[i];
    });
    btn.style.display = (anyRejected || anyReassigned) ? '' : 'none';
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
        var desc440 = document.getElementById('dcsub-440-desc');
        if (desc440) desc440.innerHTML = 'At RT, CP43 (~685\u202fnm) and CP47 (~695\u202fnm) are not spectrally resolved \u2014 PSII appears as a single broad ~685\u202fnm peak (PSII pool). Used for PSII pool\u202f:\u202fPSI ratio (~685/~730\u202fnm). CP43/CP47 ratio is not available at RT.';
        if (title) title.innerHTML = '<i class="fa fa-th text-primary mr-2"></i>RT Fluorescence Spectra &amp; EEM Analyzer';
        if (alertEl) alertEl.innerHTML = '<strong>At a glance:</strong> Upload excitation-emission fluorescence maps measured at room temperature to assess PSII/PSI energy distribution and PBS coupling states. Supports batch processing of up to 100 files with interactive charts, replicate grouping, and export to .xlsx.';
        hints.forEach(function(h) { h.textContent = 'Room-temperature fluorescence — PSII pool : PSI, PBS coupling states'; });
        // Show/hide pigmentation step — not used at RT
        var pigmGroup = document.getElementById('eem-pigm-step');
        if (pigmGroup) pigmGroup.style.display = 'none';
        var globalPigm = document.getElementById('global-pigm-group');
        if (globalPigm) globalPigm.style.display = 'none';
        // Wavelength settings panel: show RT, hide 77K
        var wl77 = document.getElementById('wl-77k-settings');
        var wlRT = document.getElementById('wl-rt-settings');
        if (wl77) wl77.style.display = 'none';
        if (wlRT) wlRT.style.display = '';
    } else {
        var desc440 = document.getElementById('dcsub-440-desc');
        if (desc440) desc440.innerHTML = 'Resolves PSII inner antenna: CP43 (~685\u202fnm), CP47 (~695\u202fnm), and PSI long-wavelength Chl (~724\u202fnm). Used for PSII:PSI stoichiometry and CP43/CP47 ratio.';
        if (title) title.innerHTML = '<i class="fa fa-th text-primary mr-2"></i>77K Fluorescence Spectra &amp; EEM Analyzer';
        if (alertEl) alertEl.innerHTML = '<strong>At a glance:</strong> Upload 3D excitation-emission fluorescence maps measured at 77 K to visualize pigment-protein complex composition and calculate PSII/PSI ratios and phycobilisome coupling states. Supports batch processing of up to 100 files with interactive charts, replicate grouping, and export to .xlsx.';
        hints.forEach(function(h) { h.textContent = 'Low-temperature EEM — photosystem stoichiometry & PBS coupling'; });
        var pigmGroup = document.getElementById('eem-pigm-step');
        if (pigmGroup) pigmGroup.style.display = '';
        var globalPigm = document.getElementById('global-pigm-group');
        if (globalPigm) globalPigm.style.display = '';
        // Wavelength settings panel: show 77K, hide RT
        var wl77 = document.getElementById('wl-77k-settings');
        var wlRT = document.getElementById('wl-rt-settings');
        if (wl77) wl77.style.display = '';
        if (wlRT) wlRT.style.display = 'none';
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

    // Sync RT-unreliable checkboxes and comparison toolbar visibility
    var rtCb = document.getElementById('rt-show-unreliable');
    if (rtCb) rtCb.checked = rtShowUnreliable;
    var cmpCb = document.getElementById('cmp-rt-show-unreliable');
    if (cmpCb) cmpCb.checked = rtShowUnreliable;
    var cmpWrap = document.getElementById('cmp-rt-unreliable-wrap');
    if (cmpWrap) cmpWrap.style.display = (mode === 'RT') ? '' : 'none';

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
            deconvBatchResults = { 'ex440': {}, 'ex620': {}, 'ex560': {} };

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
            recomputeParamsFromMaps();
            initDeconvUI(true);
            autoDetectAllEmEdges();
            updateParafacRankSuggestion(getPigmentation());

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
            'Ex440/Em685 <span class="text-muted">(PSII pool)</span>',
            'Ex440/Em730 <span class="text-muted">(PSI)</span>',
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

// fixedMaxAbs: optional — if supplied, uses this as the symmetric range instead of auto-scaling.
// Pass max(original) to keep residual map on the same scale as the original EEM.
function drawHeatmapDiverging(canvasId, exWl, emWl, intensity, fontScale, fixedMaxAbs) {
    /* Like drawHeatmap but with symmetric normalization centred at 0.
       Positive residuals → red, negative → blue, zero → white. */
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    var nEx = exWl.length, nEm = emWl.length;
    if (!nEx || !nEm) return;
    var fs = fontScale || 1.0;

    var maxAbs = fixedMaxAbs || 0;
    if (!fixedMaxAbs) {
        for (var i = 0; i < nEm; i++)
            for (var j = 0; j < nEx; j++) {
                var v = Math.abs(intensity[i][j]);
                if (v > maxAbs) maxAbs = v;
            }
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
    var is77K = eemData.analysis_mode === '77K';
    var rtNote = document.getElementById('eem-rt-state-note');
    if (rtNote) rtNote.style.display = is77K ? 'none' : '';
    var k77Note = document.getElementById('eem-77k-state-note');
    if (k77Note) k77Note.style.display = is77K ? '' : 'none';
    var cp43Note = document.getElementById('eem-cp43cp47-note');
    if (cp43Note) cp43Note.style.display = is77K ? '' : 'none';
    renderParamsChart();
    renderParamsTable();
}

function getAvailParams() {
    var isRT = eemData.analysis_mode === 'RT';
    var allKeys = isRT ? RT_PARAM_KEYS
                       : (PIGM_PARAMS[eemData.pigmentation] || PIGM_PARAMS['checkbox_chl_only']);
    var ratioList = isRT ? RT_RATIO_PARAMS : RATIO_PARAMS;
    return allKeys.filter(function(p) {
        // Hide unreliable RT params when checkbox is off
        if (isRT && !rtShowUnreliable && RT_UNRELIABLE_PARAMS.indexOf(p) !== -1) return false;
        // Ratio params are always shown (show 0 if not computable for this dataset)
        if (ratioList.indexOf(p) !== -1) return true;
        // Raw intensity params: only show if at least one sample has a value
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
    var isRT = eemData && eemData.analysis_mode === 'RT';
    var ratioList = isRT ? RT_RATIO_PARAMS : RATIO_PARAMS;
    var paramsToPlot = ratioList.filter(function(p) {
        if (isRT && !rtShowUnreliable && RT_UNRELIABLE_PARAMS.indexOf(p) !== -1) return false;
        return avail.indexOf(p) !== -1;
    });
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
// Parameters Comparison tab
// ============================================================

// Samples excluded from comparison (fname → true). Reset via "Restore all".
var cmpExcluded = {};

// ── Scatter point popup helpers ───────────────────────────────────────────────
function _cmpHidePopup() {
    var p = document.getElementById('cmp-pt-popup');
    if (p) p.style.display = 'none';
}

// Navigate to Deconvolution tab → appropriate sub-tab → highlight sample row
function _cmpInspect(fname, grpId) {
    _cmpHidePopup();
    var presetMap = { chl: 'ex440', pbs: 'ex620', ex560: 'ex560' };
    var subTabMap = { chl: 'dcsub-440-tab', pbs: 'dcsub-620-tab', ex560: 'dcsub-560-tab' };
    var preset    = presetMap[grpId] || 'ex440';
    var subTabId  = subTabMap[grpId] || 'dcsub-440-tab';

    // Switch to Deconvolution main tab
    var deconvTab = document.getElementById('eem-deconv-tab');
    if (deconvTab) deconvTab.click();

    setTimeout(function() {
        // Switch to correct sub-tab
        var subTab = document.getElementById(subTabId);
        if (subTab && !subTab.classList.contains('active')) subTab.click();

        setTimeout(function() {
            // Find the sample row by title attribute and flash-highlight it
            var tableDiv = document.getElementById('deconv-batch-table-' + preset);
            if (!tableDiv) return;
            var rows = tableDiv.querySelectorAll('tbody tr');
            for (var i = 0; i < rows.length; i++) {
                var td = rows[i].querySelector('td[title]');
                if (td && td.getAttribute('title') === fname) {
                    rows[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    rows[i].style.transition = 'background-color 0.3s';
                    rows[i].style.backgroundColor = '#fff3cd';
                    setTimeout(function(row) {
                        row.style.backgroundColor = '';
                    }, 2200, rows[i]);
                    break;
                }
            }
        }, 160);
    }, 120);
}

function _cmpShowPopup(fname, grpId, evt) {
    var popup = document.getElementById('cmp-pt-popup');
    if (!popup) return;

    document.getElementById('cmp-popup-name').textContent = fname;
    document.getElementById('cmp-popup-inspect').onclick = function() { _cmpInspect(fname, grpId); };
    document.getElementById('cmp-popup-remove').onclick  = function() {
        cmpExcluded[fname] = true;
        _cmpHidePopup();
        renderComparisonTab();
    };

    // Position near cursor (keep inside viewport)
    var pw = 230, ph = 80;
    var vw = window.innerWidth, vh = window.innerHeight;
    var cx = evt.clientX + 10, cy = evt.clientY - 20;
    if (cx + pw > vw) cx = evt.clientX - pw - 10;
    if (cy + ph > vh) cy = evt.clientY - ph - 10;
    popup.style.left = cx + 'px';
    popup.style.top  = cy + 'px';
    popup.style.display = '';

    // Close on next click outside
    setTimeout(function() {
        function outsideClick(e) {
            if (!popup.contains(e.target)) { _cmpHidePopup(); document.removeEventListener('click', outsideClick); }
        }
        document.addEventListener('click', outsideClick);
    }, 50);
}

// Parameter groups for the comparison tab
// fixedKey: key in eemData.params; gaussKey: key from computeGaussianParamsFromBatch()
var COMPARISON_GROUPS = [
    {
        id: 'chl',
        label: 'Chlorophyll / PSII·PSI (Ex 440 nm)',
        params: [
            { key: 'PSII_to_PSI',   label: 'PSII : PSI',          fixedKey: 'PSII_to_PSI',   gaussKey: 'PSII_to_PSI_gauss',   parafacKey: 'PSII_to_PSI_parafac' },
            { key: 'CP43_to_CP47',  label: 'CP43 / CP47',         fixedKey: 'CP43_to_CP47',  gaussKey: 'CP43_to_CP47_gauss',  parafacKey: 'CP43_to_CP47_parafac' },
            { key: 'Chl_PSII_norm', label: 'Chl-PSII / Chl-tot', fixedKey: 'Chl_PSII_norm', gaussKey: 'Chl_PSII_norm_gauss', parafacKey: 'Chl_PSII_norm_parafac' },
            { key: 'Chl_PSI_norm',  label: 'Chl-PSI / Chl-tot',  fixedKey: 'Chl_PSI_norm',  gaussKey: 'Chl_PSI_norm_gauss',  parafacKey: 'Chl_PSI_norm_parafac' }
        ]
    },
    {
        id: 'pbs',
        label: 'Phycobilisome coupling (Ex 620 nm)',
        params: [
            { key: 'PBS_PSII_to_PBS_PSI', label: 'PBS-PSII : PBS-PSI', fixedKey: 'PBS_PSII_to_PBS_PSI', gaussKey: 'PBS_PSII_to_PBS_PSI_gauss', parafacKey: 'PBS_PSII_to_PBS_PSI_parafac' },
            { key: 'PBS_free_norm',       label: 'PBS-free / PBS-tot', fixedKey: 'PBS_free_norm',       gaussKey: 'PBS_free_norm_gauss',       parafacKey: 'PBS_free_norm_parafac' },
            { key: 'PBS_PSII_norm',       label: 'PBS-PSII / PBS-tot', fixedKey: 'PBS_PSII_norm',       gaussKey: 'PBS_PSII_norm_gauss',       parafacKey: 'PBS_PSII_norm_parafac' },
            { key: 'PBS_PSI_norm',        label: 'PBS-PSI / PBS-tot',  fixedKey: 'PBS_PSI_norm',        gaussKey: 'PBS_PSI_norm_gauss',        parafacKey: 'PBS_PSI_norm_parafac' }
        ]
    }
];

// RT-specific comparison groups (fixed-WL keys differ from 77K)
var RT_COMPARISON_GROUPS = [
    {
        id: 'chl',
        label: 'PSII pool : PSI (Ex 440 nm)',
        params: [
            { key: 'F685_to_F730', label: 'PSII pool : PSI', fixedKey: 'F685_to_F730', gaussKey: 'PSII_to_PSI_gauss', parafacKey: 'PSII_to_PSI_parafac' }
        ]
    },
    {
        id: 'pbs',
        label: 'Phycobilisome coupling (Ex 620 nm)',
        params: [
            { key: 'PBS_F685_to_F705', label: 'PBS-PSII : PBS-PSI', fixedKey: 'PBS_F685_to_F705', gaussKey: 'PBS_PSII_to_PBS_PSI_gauss', parafacKey: 'PBS_PSII_to_PBS_PSI_parafac' },
            { key: 'PBS_free_norm',    label: 'PBS-free / PBS-tot', fixedKey: 'PBS_free_norm',    gaussKey: 'PBS_free_norm_gauss',          parafacKey: 'PBS_free_norm_parafac' },
            { key: 'PBS_PSII_norm',    label: 'PBS-PSII / PBS-tot', fixedKey: 'PBS_PSII_norm',    gaussKey: 'PBS_PSII_norm_gauss',          parafacKey: 'PBS_PSII_norm_parafac' },
            { key: 'PBS_PSI_norm',     label: 'PBS-PSI / PBS-tot',  fixedKey: 'PBS_PSI_norm',     gaussKey: 'PBS_PSI_norm_gauss',           parafacKey: 'PBS_PSI_norm_parafac' }
        ]
    }
];

// Compute peak area = |A| × |σ| × √(2π) for each Gaussian component
function _peakArea(fitParams, i) {
    return Math.abs(fitParams[i * 3]) * Math.abs(fitParams[i * 3 + 2]) * Math.sqrt(2 * Math.PI);
}

// Derive biological parameters from deconvBatchResults using peak areas
function computeGaussianParamsFromBatch() {
    if (!eemData) return {};
    var out = {};
    eemData.files.forEach(function(fname) {
        var p = {};

        // ── Ex 440: Chl / PSII / PSI peaks ──
        var r440 = deconvBatchResults.ex440 && deconvBatchResults.ex440[fname];
        if (r440 && r440.fitParams) {
            var fp = r440.fitParams, n = fp.length / 3;
            var aChl = 0, aCP43 = 0, aCP47 = 0, aPSI = 0;
            for (var i = 0; i < n; i++) {
                var mu = fp[i * 3 + 1], area = _peakArea(fp, i);
                if      (mu < 680)  aChl  += area;
                else if (mu < 690)  aCP43 += area;
                else if (mu < 710)  aCP47 += area;
                else                aPSI  += area;
            }
            var aPSII = aCP43 + aCP47;
            var aTot  = aChl + aPSII + aPSI;
            if (aPSII > 0 && aPSI  > 0) p.PSII_to_PSI_gauss    = aPSII / aPSI;
            if (aCP43 > 0 && aCP47 > 0) p.CP43_to_CP47_gauss    = aCP43 / aCP47;
            if (aTot  > 0 && aPSII > 0) p.Chl_PSII_norm_gauss   = aPSII / aTot;
            if (aTot  > 0 && aPSI  > 0) p.Chl_PSI_norm_gauss    = aPSI  / aTot;
        }

        // ── Ex 620: PBS-free / PBS→PSII / PBS→PSI peaks ──
        var r620 = deconvBatchResults.ex620 && deconvBatchResults.ex620[fname];
        if (r620 && r620.fitParams) {
            var fp2 = r620.fitParams, n2 = fp2.length / 3;
            var aFree = 0, aPBSpsii = 0, aPBSpsi = 0;
            for (var j = 0; j < n2; j++) {
                var mu2 = fp2[j * 3 + 1], area2 = _peakArea(fp2, j);
                if      (mu2 < 675) aFree    += area2;
                else if (mu2 < 710) aPBSpsii += area2;
                else                aPBSpsi  += area2;
            }
            var aTot2 = aFree + aPBSpsii + aPBSpsi;
            if (aTot2 > 0) {
                if (aFree    > 0) p.PBS_free_norm_gauss       = aFree    / aTot2;
                if (aPBSpsii > 0) p.PBS_PSII_norm_gauss       = aPBSpsii / aTot2;
                if (aPBSpsi  > 0) p.PBS_PSI_norm_gauss        = aPBSpsi  / aTot2;
                if (aPBSpsii > 0 && aPBSpsi > 0)
                    p.PBS_PSII_to_PBS_PSI_gauss = aPBSpsii / aPBSpsi;
            }
        }

        out[fname] = p;
    });
    return out;
}

// Enable / disable the Comparison tab based on available batch data
function updateComparisonTabState() {
    var hasData = eemData && eemData.files.length &&
        deconvBatchResults.ex440 && Object.keys(deconvBatchResults.ex440).length > 0;
    var tabLink = document.getElementById('eem-comparison-tab');
    if (!tabLink) return;
    if (hasData) {
        tabLink.classList.remove('disabled');
        tabLink.removeAttribute('title');
    } else {
        if (!tabLink.classList.contains('disabled')) tabLink.classList.add('disabled');
        tabLink.title = 'Run Gaussian batch fit (Deconvolution tab) to enable';
    }
}

// Build one comparison table (one COMPARISON_GROUPS entry)
// parafacParams: optional — pass null/undefined to hide PARAFAC column
function _buildComparisonTable(group, files, fixedParams, gaussParams, parafacParams) {
    var params = group.params;
    var hasPF = !!parafacParams;
    var nCols = hasPF ? 3 : 2;

    var TIP_FIXED  = 'Direct fluorescence intensity read at a single emission wavelength — fast but sensitive to spectral overlap between CP43 (685 nm) and CP47 (695 nm).';
    var TIP_GAUSS  = 'Peak area (|A|·|σ|·√2π) from Gaussian deconvolution — separates overlapping peaks and integrates the full photon contribution of each pigment pool.';
    var TIP_PARAFAC = 'Component score from PARAFAC tensor decomposition — pigment-pool abundance derived from the full excitation–emission map, independent of peak overlap.';

    var thead1 = '<tr><th style="min-width:140px;">Sample</th>';
    var thead2 = '<tr><th></th>';
    params.forEach(function(p) {
        thead1 += '<th colspan="' + nCols + '" class="text-center" style="border-left:2px solid #dee2e6; white-space:nowrap;">' + p.label + '</th>';
        thead2 += '<th class="text-center text-muted" style="font-size:0.78rem; border-left:2px solid #dee2e6; white-space:nowrap; cursor:help;" title="' + TIP_FIXED + '">Fixed-WL <span style="color:#6c757d;">ⓘ</span></th>' +
                  '<th class="text-center text-muted" style="font-size:0.78rem; white-space:nowrap; cursor:help;" title="' + TIP_GAUSS + '">Gaussian <span style="color:#6c757d;">ⓘ</span></th>';
        if (hasPF) thead2 += '<th class="text-center text-muted" style="font-size:0.78rem; white-space:nowrap; cursor:help;" title="' + TIP_PARAFAC + '">PARAFAC <span style="color:#6c757d;">ⓘ</span></th>';
    });
    thead1 += '</tr>'; thead2 += '</tr>';

    var tbody = '';
    files.forEach(function(fname) {
        var grpLabel = groups[fname] || '';
        var fp = fixedParams[fname] || {};
        var gp = gaussParams[fname] || {};
        var pp = hasPF ? (parafacParams[fname] || {}) : {};
        tbody += '<tr><td style="max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + fname + '">' +
            (grpLabel ? '<span class="badge badge-light mr-1">' + grpLabel + '</span>' : '') + fname + '</td>';
        params.forEach(function(p) {
            var fv = fp[p.fixedKey], gv = gp[p.gaussKey], pv = hasPF ? pp[p.parafacKey] : undefined;
            var fmt = function(v) { return (v != null && isFinite(v)) ? v.toFixed(3) : '<span class="text-muted">—</span>'; };
            // Flag >20% relative discrepancy vs fixed-WL
            var disc = function(v) {
                if (fv == null || v == null || !isFinite(fv) || !isFinite(v)) return '';
                var d = (Math.abs(fv) + Math.abs(v)) / 2;
                return d > 0 && Math.abs(fv - v) / d > 0.20 ? ' style="color:#c0392b;"' : '';
            };
            tbody += '<td class="text-center" style="border-left:2px solid #dee2e6;">' + fmt(fv) + '</td>' +
                     '<td class="text-center"' + disc(gv) + '>' + fmt(gv) + '</td>';
            if (hasPF) tbody += '<td class="text-center"' + disc(pv) + '>' + fmt(pv) + '</td>';
        });
        tbody += '</tr>';
    });

    return '<table class="table table-sm table-bordered table-hover mb-0" style="font-size:0.82em;">' +
        '<thead class="thead-light">' + thead1 + thead2 + '</thead>' +
        '<tbody>' + tbody + '</tbody></table>';
}

// Compute linear regression y = a*x + b, returns {a, b, r2}
function _linReg(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var mx = xs.reduce(function(s, v) { return s + v; }, 0) / n;
    var my = ys.reduce(function(s, v) { return s + v; }, 0) / n;
    var ssxy = 0, ssxx = 0, ssyy = 0;
    for (var i = 0; i < n; i++) {
        ssxy += (xs[i] - mx) * (ys[i] - my);
        ssxx += (xs[i] - mx) * (xs[i] - mx);
        ssyy += (ys[i] - my) * (ys[i] - my);
    }
    if (ssxx === 0) return null;
    var a = ssxy / ssxx, b = my - a * mx;
    var r2 = (ssxx > 0 && ssyy > 0) ? (ssxy * ssxy) / (ssxx * ssyy) : 0;
    return { a: a, b: b, r2: r2 };
}

// Render all method-agreement scatter plots into #comparison-scatter-grid
function _renderComparisonScatter(files, fixedParams, gaussParams, parafacParams, compGroups) {
    compGroups = compGroups || COMPARISON_GROUPS;
    var container = document.getElementById('comparison-scatter-grid');
    if (!container) return;

    // Destroy any existing charts
    Object.keys(chartInst).filter(function(k) { return k.indexOf('cmp-') === 0; }).forEach(function(k) {
        chartInst[k].destroy(); delete chartInst[k];
    });
    container.innerHTML = '';

    // Color by sample group
    var palette = ['#2980b9','#27ae60','#e74c3c','#f39c12','#8e44ad','#16a085','#d35400','#2c3e50'];
    var groupList = Object.keys(groups).map(function(f) { return groups[f]; })
        .filter(function(g, i, a) { return g && a.indexOf(g) === i; }).sort();

    // Helper: build and mount one Chart.js v4 scatter chart
    // onPointClick(fname, grpId, evt) — called when a data point is clicked
    function _makeScatter(canvasId, datasets, vMin, vMax, xTitle, yTitle, showLegend, onPointClick) {
        var canvas = document.getElementById(canvasId);
        if (!canvas) return;
        var idLine = [{ x: vMin, y: vMin }, { x: vMax, y: vMax }];
        // prepend identity line as dataset 0
        datasets.unshift({ label: 'Identity', data: idLine, type: 'line',
            borderColor: '#bbb', borderDash: [4,4], borderWidth: 1, pointRadius: 0, fill: false });

        chartInst['cmp-' + canvasId] = new Chart(canvas, {
            type: 'scatter',
            data: { datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                animation: false,
                onClick: function(evt, elements) {
                    if (!onPointClick || !elements.length) return;
                    var el = elements[0];
                    var pt = this.data.datasets[el.datasetIndex].data[el.index];
                    if (pt && pt._fname) onPointClick(pt._fname, pt._grpId || '', evt.native || evt);
                },
                scales: {
                    x: {
                        type: 'linear', min: vMin, max: vMax,
                        title: { display: true, text: xTitle, font: { size: 10 } },
                        ticks: { font: { size: 9 } }
                    },
                    y: {
                        min: vMin, max: vMax,
                        title: { display: true, text: yTitle, font: { size: 10 } },
                        ticks: { font: { size: 9 } }
                    }
                },
                plugins: {
                    legend: { display: showLegend, labels: { font: { size: 9 }, boxWidth: 10 } },
                    tooltip: { callbacks: { label: function(ctx) {
                        if (ctx.datasetIndex === 0) return null;
                        var extra = ctx.raw && ctx.raw._fname ? ('  ' + ctx.raw._fname) : '';
                        return '(' + ctx.parsed.x.toFixed(3) + ', ' + ctx.parsed.y.toFixed(3) + ')' + extra;
                    }}}
                }
            }
        });
    }

    // ── Per-excitation group summary scatter plots ──────────────────────────────
    // One plot per COMPARISON_GROUPS entry: pools all parameters (normalized to
    // their own range) so the overall fixed-WL vs Gauss agreement per excitation
    // wavelength is visible in a single view with one regression line.
    var paramColors440 = ['#2980b9','#27ae60','#e74c3c','#f39c12'];
    var paramColors620 = ['#16a085','#d35400','#8e44ad','#2c3e50'];

    compGroups.forEach(function(grp, grpIdx) {
        var paramPalette = grpIdx === 0 ? paramColors440 : paramColors620;

        // Collect (fixedNorm, gaussNorm) pairs per parameter, normalized to [0,1]
        var allXs = [], allYs = [];
        var paramDatasets = [];

        grp.params.forEach(function(p, pi) {
            var fvs = [], gvs = [], fnames = [];
            files.forEach(function(fname) {
                var fv = (fixedParams[fname] || {})[p.fixedKey];
                var gv = (gaussParams[fname] || {})[p.gaussKey];
                if (fv != null && gv != null && isFinite(fv) && isFinite(gv)) {
                    fvs.push(fv); gvs.push(gv); fnames.push(fname);
                }
            });
            if (fvs.length < 2) return;

            // Normalize to [0,1] using combined range
            var combined = fvs.concat(gvs);
            var lo = Math.min.apply(null, combined), hi = Math.max.apply(null, combined);
            var rng = hi - lo || 1;
            var xNorm = fvs.map(function(v) { return (v - lo) / rng; });
            var yNorm = gvs.map(function(v) { return (v - lo) / rng; });

            xNorm.forEach(function(x, i) { allXs.push(x); allYs.push(yNorm[i]); });

            paramDatasets.push({
                label: p.label,
                data: xNorm.map(function(x, i) { return { x: x, y: yNorm[i], _fname: fnames[i], _grpId: grp.id }; }),
                pointBackgroundColor: paramPalette[pi % paramPalette.length],
                pointRadius: 5, pointHoverRadius: 7, pointStyle: 'circle', showLine: false
            });
        });

        if (allXs.length < 2) return;

        var pad = 0.06;
        var vMin = 0 - pad, vMax = 1 + pad;

        var colDiv = document.createElement('div');
        colDiv.className = 'col-md-6 mb-2 px-1';
        colDiv.innerHTML = '<div class="card border"><div class="card-body p-2">' +
            '<div style="font-size:0.78rem; font-weight:600; text-align:center; margin-bottom:3px;">' +
            grp.label + ' — method agreement (normalised)</div>' +
            '<div style="position:relative; height:200px;"><canvas id="cmp-sum-' + grp.id + '"></canvas></div>' +
            '</div></div>';
        container.appendChild(colDiv);

        _makeScatter('cmp-sum-' + grp.id, paramDatasets, vMin, vMax,
            'Fixed-wavelength (normalised)', 'Gaussian (normalised)', true,
            _cmpShowPopup);
    });

    // Row break + spacing before detail charts
    var breakDiv = document.createElement('div');
    breakDiv.className = 'w-100 mb-2';
    container.appendChild(breakDiv);

    // ── Per-parameter detail scatter plots ──────────────────────────────────────
    compGroups.forEach(function(grp) {
        grp.params.forEach(function(p) {
            var xs = [], ys = [], xfn = [], pxs = [], pys = [], pxfn = [], colors = [];
            files.forEach(function(fname) {
                var fv = (fixedParams[fname] || {})[p.fixedKey];
                var gv = (gaussParams[fname] || {})[p.gaussKey];
                var gi = groupList.indexOf(groups[fname] || '');
                var col = palette[Math.max(gi, 0) % palette.length];
                if (fv != null && gv != null && isFinite(fv) && isFinite(gv)) {
                    xs.push(fv); ys.push(gv); xfn.push(fname); colors.push(col);
                }
                if (parafacParams && fv != null && isFinite(fv)) {
                    var pv = (parafacParams[fname] || {})[p.parafacKey];
                    if (pv != null && isFinite(pv)) { pxs.push(fv); pys.push(pv); pxfn.push(fname); }
                }
            });
            if (xs.length < 2 && pxs.length < 2) return;

            var reg  = xs.length  >= 2 ? _linReg(xs,  ys)  : null;
            var regP = pxs.length >= 2 ? _linReg(pxs, pys) : null;
            var allVals = xs.concat(ys).concat(pxs).concat(pys);
            var vMin = Math.min.apply(null, allVals), vMax = Math.max.apply(null, allVals);
            var pad  = (vMax - vMin) * 0.1 || 0.05;
            vMin -= pad; vMax += pad;

            // R² summary line
            var r2line = '';
            if (reg)  r2line += 'Gauss R²=' + reg.r2.toFixed(3) + (reg.r2  < 0.90 ? ' ⚠' : '');
            if (regP) r2line += (r2line ? '  ' : '') + 'PF R²=' + regP.r2.toFixed(3) + (regP.r2 < 0.90 ? ' ⚠' : '');

            var colDiv = document.createElement('div');
            colDiv.className = 'col-md-3 col-sm-6 mb-3 px-1';
            colDiv.innerHTML = '<div class="card border"><div class="card-body p-1">' +
                '<div style="font-size:0.75rem; font-weight:600; text-align:center; margin-bottom:2px;">' + p.label + '</div>' +
                '<div style="position:relative; height:180px;"><canvas id="cmp-scatter-' + p.key + '"></canvas></div>' +
                (r2line ? '<div style="font-size:0.70rem; text-align:center; color:#555; margin-top:2px;">' + r2line + '</div>' : '') +
                '</div></div>';
            container.appendChild(colDiv);

            var mkRegLine = function(r) { return r ? [{ x: vMin, y: r.a*vMin+r.b }, { x: vMax, y: r.a*vMax+r.b }] : []; };

            var datasets = [
                { label: 'Gaussian', data: xs.map(function(x, i) { return { x: x, y: ys[i], _fname: xfn[i], _grpId: grp.id }; }),
                  pointBackgroundColor: colors,
                  pointRadius: 5, pointHoverRadius: 7, pointStyle: 'circle', showLine: false }
            ];
            if (reg)  datasets.push({ label: 'Reg (Gauss)', data: mkRegLine(reg),  type: 'line', borderColor: '#e74c3c', borderWidth: 1.5, pointRadius: 0, fill: false });
            if (pxs.length >= 2) datasets.push(
                { label: 'PARAFAC', data: pxs.map(function(x, i) { return { x: x, y: pys[i], _fname: pxfn[i], _grpId: grp.id }; }),
                  pointBackgroundColor: '#8e44ad', pointBorderColor: '#fff', pointBorderWidth: 1,
                  pointRadius: 6, pointHoverRadius: 8, pointStyle: 'rect', showLine: false }
            );
            if (regP) datasets.push({ label: 'Reg (PF)', data: mkRegLine(regP), type: 'line', borderColor: '#8e44ad', borderWidth: 1.5, borderDash: [3,3], pointRadius: 0, fill: false });

            _makeScatter('cmp-scatter-' + p.key, datasets, vMin, vMax,
                'Fixed-wavelength', 'Gauss / PARAFAC', pxs.length >= 2,
                _cmpShowPopup);
        });
    });
}

// Main render function for the Comparison tab
function renderComparisonTab() {
    if (!eemData) return;
    var placeholder = document.getElementById('comparison-placeholder');
    var content = document.getElementById('comparison-content');
    var hasData = deconvBatchResults.ex440 && Object.keys(deconvBatchResults.ex440).length > 0;

    if (!hasData) {
        if (placeholder) placeholder.style.display = '';
        if (content) content.style.display = 'none';
        return;
    }
    if (placeholder) placeholder.style.display = 'none';
    if (content) content.style.display = '';

    // Filter out excluded samples
    var allFiles = eemData.files;
    var files = allFiles.filter(function(f) { return !cmpExcluded[f]; });
    var nExcluded = allFiles.length - files.length;
    var excludedBar = document.getElementById('cmp-excluded-bar');
    var excludedCount = document.getElementById('cmp-excluded-count');
    if (excludedBar) excludedBar.style.display = nExcluded > 0 ? '' : 'none';
    if (excludedCount) excludedCount.textContent = nExcluded;

    var fixedParams  = eemData.params;
    var gaussParams  = computeGaussianParamsFromBatch();
    var hasPF = parafacResults && parafacPigmAssign.some(function(a) { return a && a !== '' && a !== 'other'; });
    var parafacParams = hasPF ? computeParafacParams() : null;

    // Select comparison groups based on analysis mode
    var isRT = eemData.analysis_mode === 'RT';
    var compGroups = isRT ? RT_COMPARISON_GROUPS : COMPARISON_GROUPS;
    // Filter unreliable params from RT groups when checkbox is off
    if (isRT && !rtShowUnreliable) {
        compGroups = compGroups.map(function(grp) {
            return {
                id: grp.id, label: grp.label,
                params: grp.params.filter(function(p) {
                    return RT_UNRELIABLE_PARAMS.indexOf(p.key) === -1;
                })
            };
        }).filter(function(grp) { return grp.params.length > 0; });
    }
    // Show/hide comparison tab unreliable checkbox (RT mode only)
    var cmpWrap = document.getElementById('cmp-rt-unreliable-wrap');
    if (cmpWrap) cmpWrap.style.display = isRT ? '' : 'none';

    // Update section headings
    var chlHeadEl = document.getElementById('cmp-section-chl');
    var pbsHeadEl = document.getElementById('cmp-section-pbs');
    if (chlHeadEl && compGroups[0]) chlHeadEl.innerHTML = compGroups[0].label;
    if (pbsHeadEl && compGroups[1]) pbsHeadEl.innerHTML = compGroups[1].label;

    // Status line
    var has620 = deconvBatchResults.ex620 && Object.keys(deconvBatchResults.ex620).length > 0;
    var has560 = deconvBatchResults.ex560 && Object.keys(deconvBatchResults.ex560).length > 0;
    var methods = ['Fixed-wavelength', 'Gaussian (Ex 440)'];
    if (has620) methods.push('Gaussian (Ex 620)');
    if (has560) methods.push('Gaussian (Ex 560)');
    if (hasPF)  methods.push('PARAFAC');
    var statusEl = document.getElementById('comparison-status');
    if (statusEl) statusEl.textContent = files.length + ' samples' +
        (nExcluded > 0 ? ' (' + nExcluded + ' hidden)' : '') +
        ' · Methods: ' + methods.join(', ') +
        '  ·  Red values differ >20% between methods.';

    // Tables
    compGroups.forEach(function(grp) {
        var targetDiv = document.getElementById('comparison-table-' + grp.id);
        if (targetDiv) targetDiv.innerHTML = _buildComparisonTable(grp, files, fixedParams, gaussParams, parafacParams);
    });

    // Scatter plots
    _renderComparisonScatter(files, fixedParams, gaussParams, parafacParams, compGroups);
}

// Export merged Fixed-WL + Gaussian-derived parameters to Statistics page
function exportComparisonToStatistics() {
    if (!eemData) return;
    var assignedFiles = eemData.files.filter(function(f) { return groups[f]; });
    if (!assignedFiles.length) { alert('Please assign groups in the Groups tab first.'); return; }

    var gaussParams   = computeGaussianParamsFromBatch();
    var hasPF         = parafacResults && parafacPigmAssign.some(function(a) { return a && a !== '' && a !== 'other'; });
    var parafacParams = hasPF ? computeParafacParams() : null;
    var fixedAvail    = getAvailParams();

    // Label maps and active keys per method
    var gaussLabelMap = {}, pfLabelMap = {};
    var gaussKeys = [], pfKeys = [];
    COMPARISON_GROUPS.forEach(function(grp) {
        grp.params.forEach(function(p) {
            gaussLabelMap[p.gaussKey]   = p.label + ' (Gauss)';
            pfLabelMap[p.parafacKey]    = p.label + ' (PARAFAC)';
            if (gaussKeys.indexOf(p.gaussKey) === -1 &&
                assignedFiles.some(function(f) { var v=(gaussParams[f]||{})[p.gaussKey]; return v!=null&&isFinite(v); }))
                gaussKeys.push(p.gaussKey);
            if (hasPF && pfKeys.indexOf(p.parafacKey) === -1 &&
                assignedFiles.some(function(f) { var v=(parafacParams[f]||{})[p.parafacKey]; return v!=null&&isFinite(v); }))
                pfKeys.push(p.parafacKey);
        });
    });

    var header = ['Group', 'Sample']
        .concat(fixedAvail.map(function(k) { return getParamLabel(k) + ' (Fixed-WL)'; }))
        .concat(gaussKeys.map(function(k) { return gaussLabelMap[k]; }))
        .concat(pfKeys.map(function(k)    { return pfLabelMap[k]; }))
        .join('\t');

    var rows = assignedFiles.map(function(fname) {
        var fp = eemData.params[fname] || {};
        var gp = gaussParams[fname]    || {};
        var pp = parafacParams ? (parafacParams[fname] || {}) : {};
        var fVals = fixedAvail.map(function(k) { var v=fp[k]; return (v!=null&&isFinite(v))?v.toFixed(6):''; });
        var gVals = gaussKeys.map(function(k)  { var v=gp[k]; return (v!=null&&isFinite(v))?v.toFixed(6):''; });
        var pVals = pfKeys.map(function(k)     { var v=pp[k]; return (v!=null&&isFinite(v))?v.toFixed(6):''; });
        return [groups[fname], fname].concat(fVals).concat(gVals).concat(pVals).join('\t');
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
// ── Batch deconvolution state ──────────────────────────────────────────────
var deconvBatchResults = { 'ex440': {}, 'ex620': {}, 'ex560': {} };

// ── Preset configuration (uses WL_CONFIG for pigmentation-aware peaks) ─────
// getPeaks(pigm) — pigm is optional; defaults to current pigmentation setting.
// Ex 440: 3 peaks (CP43 ~685, CP47 ~695, PSI ~724) for all pigmentation types — no free Chl peak.
// Ex 620: 3 peaks — PC/APC ~662 (PBS-free), PBS→PSII ~689, PBS→PSI ~724.
// Ex 560: 4 peaks — PE ~580 (PBS-free via PE), APC via PE ~662 (PBS-free via APC), PBS→PSII ~689, PBS→PSI ~724.
var DECONV_PRESET_CONFIG = {
    'ex440': {
        targetEx: 440,
        getPeaks: function() {
            var W = WL_CONFIG;
            return [W.k77_em_cp43, W.k77_em_cp47, W.k77_em_psi];
        },
        pigmAll: true,
        emMin: 650, emMax: 750, autoDetect: false
    },
    'ex620': {
        targetEx: 620,
        getPeaks: function() {
            var W = WL_CONFIG;
            return [W.k77_em_pbs_free, W.k77_em_psii, W.k77_em_psi];
        },
        pigmFilter: ['checkbox_chl_PC', 'checkbox_chl_PC_PE'],
        emMin: 640, emMax: 750, autoDetect: true
    },
    'ex560': {
        targetEx: 560,
        getPeaks: function() {
            var W = WL_CONFIG;
            return [W.k77_em_pe, W.k77_em_pbs_free, W.k77_em_psii, W.k77_em_psi];
        },
        pigmFilter: ['checkbox_chl_PE', 'checkbox_chl_PC_PE'],
        emMin: 565, emMax: 750, autoDetect: true
    },
    'custom': {
        getPeaks: function() { return [WL_CONFIG.k77_em_psii, WL_CONFIG.k77_em_psi]; }
    }
};

// Suggested PARAFAC component counts per pigmentation type
var PIGM_SUGGESTED_RANK = {
    'checkbox_chl_only':   2,
    'checkbox_chl_PC':     5,
    'checkbox_chl_PE':     6,
    'checkbox_chl_PC_PE':  8
};

// Update PARAFAC rank slider suggestion when pigmentation changes
function updateParafacRankSuggestion(pigm) {
    var suggested = PIGM_SUGGESTED_RANK[pigm] || 3;
    var hint = document.getElementById('par-rank-pigm-hint');
    if (hint) hint.textContent = 'Suggested for this pigmentation: ' + suggested + ' component' + (suggested > 1 ? 's' : '');
    var slider = document.getElementById('par-rank-slider');
    var valDisplay = document.getElementById('par-rank-val');
    if (slider && !slider._userSet) {
        slider.value = Math.min(suggested, parseInt(slider.max));
        if (valDisplay) valDisplay.textContent = slider.value;
    }
    // Set diagnostic range to suggested + 2 so the scree plot shows the drop-off
    var fmaxSlider = document.getElementById('par-fmax-slider');
    var fmaxVal = document.getElementById('par-fmax-val');
    if (fmaxSlider && !fmaxSlider._userSet) {
        var fmax = Math.min(suggested + 2, parseInt(fmaxSlider.max));
        fmaxSlider.value = fmax;
        if (fmaxVal) fmaxVal.textContent = fmax;
    }
}

// Auto-detect spectral emission edge (longpass filter cutoff) for one preset
// Sets the Em min input based on where signal rises above 3% of max
function autoDetectEmEdge(preset) {
    var autoEl = document.getElementById('deconv-em-autodetect-' + preset);
    if (autoEl && !autoEl.checked) return;
    if (!eemData || !eemData.files.length) return;
    var cfg = DECONV_PRESET_CONFIG[preset];
    if (!cfg) return;

    var fname = eemData.files[0];
    var mapData = eemData.maps[fname];
    if (!mapData) return;

    // Find nearest excitation index to preset target
    var xi = -1, bestDx = Infinity;
    mapData.ex_wl.forEach(function(v, i) {
        var d = Math.abs(v - cfg.targetEx);
        if (d < bestDx) { bestDx = d; xi = i; }
    });
    if (xi === -1) return;

    var emWl = mapData.em_wl;
    var yArr = mapData.intensity.map(function(row) { return row[xi]; });
    var yMax = Math.max.apply(null, yArr.map(Math.abs));
    if (yMax === 0) return;

    // Find first point exceeding 3% of max
    var threshold = 0.03 * yMax;
    var edgeIdx = 0;
    for (var i = 0; i < yArr.length; i++) {
        if (Math.abs(yArr[i]) > threshold) { edgeIdx = i; break; }
    }

    // Add 5 nm buffer and round to nearest 5 nm
    var edgeWl = Math.round((emWl[edgeIdx] + 5) / 5) * 5;
    var emMinEl = document.getElementById('deconv-em-min-' + preset);
    if (emMinEl) emMinEl.value = edgeWl;
}

// Auto-detect edges for all presets that have autoDetect enabled
function autoDetectAllEmEdges() {
    ['ex620', 'ex560'].forEach(function(preset) {
        var cfg = DECONV_PRESET_CONFIG[preset];
        if (cfg && cfg.autoDetect) autoDetectEmEdge(preset);
    });
}

// Show/hide Ex 620 and Ex 560 sub-tabs based on current pigmentation
function updateDeconvSubTabs() {
    var pigm = getPigmentation();
    var mode = (eemData && eemData.analysis_mode) || analysisMode;
    var show620 = mode === '77K' && (pigm === 'checkbox_chl_PC' || pigm === 'checkbox_chl_PC_PE');
    var show560 = mode === '77K' && (pigm === 'checkbox_chl_PE' || pigm === 'checkbox_chl_PC_PE');

    var li620 = document.getElementById('dcsub-620-li');
    var li560 = document.getElementById('dcsub-560-li');
    if (li620) li620.style.display = show620 ? '' : 'none';
    if (li560) li560.style.display = show560 ? '' : 'none';

    // If the currently-active tab is now hidden, fall back to Ex 440
    ['dcsub-620-tab', 'dcsub-560-tab'].forEach(function(tabId) {
        var tab = document.getElementById(tabId);
        if (tab && tab.classList.contains('active')) {
            var li = tab.closest('li');
            if (li && li.style.display === 'none') {
                var t440 = document.getElementById('dcsub-440-tab');
                if (t440) $(t440).tab('show');
            }
        }
    });

    // Populate excitation dropdowns for all preset tabs
    if (eemData) {
        ['ex440', 'ex620', 'ex560'].forEach(updateDeconvExDropdown);
    }
}

// Populate the excitation dropdown for one preset tab with available EEM wavelengths
function updateDeconvExDropdown(preset) {
    var sel = document.getElementById('deconv-ex-' + preset);
    if (!sel || !eemData) return;
    var targetEx = DECONV_PRESET_CONFIG[preset].targetEx;

    // Collect available excitation wavelengths from first map
    var exWls = [];
    if (eemData.files.length) {
        var firstMap = eemData.maps[eemData.files[0]];
        if (firstMap) exWls = firstMap.ex_wl.slice();
    }
    if (!exWls.length) return;

    // Sort by proximity to target excitation
    exWls = exWls.slice().sort(function(a, b) {
        return Math.abs(a - targetEx) - Math.abs(b - targetEx);
    });

    var prev = sel.value;
    sel.innerHTML = '';
    exWls.slice(0, 12).forEach(function(ex, i) {
        var opt = document.createElement('option');
        opt.value = ex;
        opt.textContent = ex + ' nm' + (i === 0 ? ' (nearest)' : '');
        sel.appendChild(opt);
    });
    // Restore previous selection if still valid
    if (prev && exWls.indexOf(parseFloat(prev)) !== -1) sel.value = prev;
}

// Run batch Gaussian deconvolution for all samples in one preset tab
// onDone: optional callback invoked when all samples in this preset are fitted
function runDeconvBatch(preset, onDone) {
    if (!eemData || !eemData.files.length) { if (onDone) onDone(); return; }
    var cfg = DECONV_PRESET_CONFIG[preset];
    var exWl = parseFloat((document.getElementById('deconv-ex-' + preset) || {}).value);
    if (isNaN(exWl)) { if (onDone) onDone(); return; }

    var emMinEl = document.getElementById('deconv-em-min-' + preset);
    var emMaxEl = document.getElementById('deconv-em-max-' + preset);
    var emMin = emMinEl ? parseFloat(emMinEl.value) : cfg.emMin;
    var emMax = emMaxEl ? parseFloat(emMaxEl.value) : cfg.emMax;
    if (isNaN(emMin)) emMin = cfg.emMin;
    if (isNaN(emMax)) emMax = cfg.emMax;

    var peaks = cfg.getPeaks();
    var files = eemData.files.slice();
    var btn = document.getElementById('deconv-fitall-' + preset);
    var progress = document.getElementById('deconv-batch-progress-' + preset);

    deconvBatchResults[preset] = {};
    if (btn) btn.disabled = true;
    if (progress) progress.textContent = '';

    var idx = 0;
    function fitNext() {
        if (idx >= files.length) {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa fa-play"></i> Fit all samples';
            }
            var nFlagged = files.filter(function(f) {
                return deconvBatchResults[preset][f] && deconvBatchResults[preset][f].flagged;
            }).length;
            if (progress) progress.textContent = 'Done — ' + files.length + ' fitted' +
                (nFlagged ? ', ' + nFlagged + ' flagged' : '') + '.';
            renderDeconvBatchTable(preset, files);
            updateComparisonTabState();
            if (onDone) onDone();
            return;
        }
        var fname = files[idx];
        if (btn) btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> ' + (idx + 1) + ' / ' + files.length;
        if (progress) progress.textContent = fname;

        var result = fitSingleDeconvSample(fname, exWl, peaks, emMin, emMax);
        if (result) deconvBatchResults[preset][fname] = result;
        idx++;
        setTimeout(fitNext, 0);
    }
    fitNext();
}

// Run batch deconvolution for all visible preset tabs sequentially
function runDeconvBatchAll() {
    if (!eemData || !eemData.files.length) return;

    // Collect active presets in order (ex440 always; ex620/ex560 only if visible)
    var presets = ['ex440'];
    if (document.getElementById('dcsub-620-li') &&
        document.getElementById('dcsub-620-li').style.display !== 'none') presets.push('ex620');
    if (document.getElementById('dcsub-560-li') &&
        document.getElementById('dcsub-560-li').style.display !== 'none') presets.push('ex560');

    var btn = document.getElementById('deconv-fitall-all');
    var prog = document.getElementById('deconv-fitall-all-progress');
    if (btn) btn.disabled = true;

    var step = 0;
    function runNext() {
        if (step >= presets.length) {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa fa-play-circle mr-1"></i> Fit all excitations';
            }
            if (prog) prog.textContent = 'All done (' + presets.length + ' excitation' +
                (presets.length > 1 ? 's' : '') + ').';
            return;
        }
        var preset = presets[step];
        var labels = { ex440: 'Ex 440', ex620: 'Ex 620', ex560: 'Ex 560' };
        if (btn) btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i> ' +
            labels[preset] + ' (' + (step + 1) + '/' + presets.length + ')';
        if (prog) prog.textContent = labels[preset] + ' nm…';
        step++;
        runDeconvBatch(preset, runNext);
    }
    runNext();
}

// Fit one sample at a given excitation wavelength with given initial peak positions
function fitSingleDeconvSample(fname, exWl, peaks, emMin, emMax) {
    var mapData = eemData && eemData.maps[fname];
    if (!mapData) return null;

    // Find nearest available excitation index
    var xi = -1, bestDx = Infinity;
    mapData.ex_wl.forEach(function(v, i) {
        var d = Math.abs(v - exWl);
        if (d < bestDx) { bestDx = d; xi = i; }
    });
    if (xi === -1) return null;

    var xArr = mapData.em_wl.slice();
    var yArr = mapData.intensity.map(function(row) { return row[xi]; });

    // Apply Em range crop if specified
    if (emMin != null || emMax != null) {
        var xFilt = [], yFilt = [];
        xArr.forEach(function(em, i) {
            if ((emMin == null || em >= emMin) && (emMax == null || em <= emMax)) {
                xFilt.push(em);
                yFilt.push(yArr[i]);
            }
        });
        if (xFilt.length >= 3) { xArr = xFilt; yArr = yFilt; }
    }

    // Build LM initial params [A, mu, sigma] per peak
    var sig0 = 8, initParams = [], minB = [], maxB = [];
    peaks.forEach(function(mu) {
        var bestIdx = 0, bestDist = Infinity;
        for (var i = 0; i < xArr.length; i++) {
            var d = Math.abs(xArr[i] - mu);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        var A0 = Math.max(0, yArr[bestIdx] || 0);
        initParams.push(A0, mu, sig0);
        minB.push(0, mu - 20, 1);
        maxB.push(Infinity, mu + 30, 45);
    });

    var fitParams = fitGaussians(xArr, yArr, initParams, 300, { min: minB, max: maxB });

    // Compute R²
    var yMean = yArr.reduce(function(a, b) { return a + b; }, 0) / yArr.length;
    var ssTot = 0, ssRes = 0;
    for (var i = 0; i < xArr.length; i++) {
        ssTot += Math.pow(yArr[i] - yMean, 2);
        var yfit = 0;
        for (var p = 0; p < fitParams.length; p += 3) {
            var A = fitParams[p], mu2 = fitParams[p + 1], sig = Math.abs(fitParams[p + 2]);
            if (sig > 0) yfit += A * Math.exp(-0.5 * Math.pow((xArr[i] - mu2) / sig, 2));
        }
        ssRes += Math.pow(yArr[i] - yfit, 2);
    }
    var r2 = ssTot > 0 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;

    return {
        fitParams: fitParams,
        r2: r2,
        exWl: mapData.ex_wl[xi],
        xArr: xArr,
        yArr: yArr,
        peaks: peaks.slice(),
        flagged: r2 < 0.90
    };
}

// Render the batch results table for one preset
function renderDeconvBatchTable(preset, files) {
    var container = document.getElementById('deconv-batch-table-' + preset);
    if (!container) return;
    if (!files || !files.length) {
        container.innerHTML = '<p class="text-muted" style="font-size:0.88em;">Click <strong>Fit all samples</strong> to run batch Gaussian deconvolution.</p>';
        return;
    }

    var results = deconvBatchResults[preset];
    var nFlagged = files.filter(function(f) { return results[f] && results[f].flagged; }).length;

    var html = '';
    if (nFlagged > 0) {
        html += '<div class="alert alert-warning py-2 mb-2" style="font-size:0.85em;">' +
            '<i class="fa fa-exclamation-triangle mr-1"></i>' + nFlagged + ' sample' +
            (nFlagged > 1 ? 's' : '') + ' flagged (R² &lt; 0.90) — click <strong>Adjust</strong> to manually review.</div>';
    }

    html += '<div style="overflow-x:auto;">' +
        '<table class="table table-sm table-bordered table-hover mb-2" style="font-size:0.83em;">' +
        '<thead class="thead-light"><tr>' +
        '<th>Sample</th><th style="width:70px;">R²</th>' +
        '<th>Peak positions (nm)</th><th style="width:80px;">Status</th><th style="width:64px;"></th>' +
        '</tr></thead><tbody>';

    files.forEach(function(fname) {
        var res = results[fname];
        if (!res) {
            html += '<tr><td colspan="5" class="text-muted">' + fname + ' — not fitted</td></tr>';
            return;
        }
        var r2cls = res.r2 >= 0.95 ? 'badge-success' : res.r2 >= 0.90 ? 'badge-warning text-dark' : 'badge-danger';
        var r2badge = '<span class="badge ' + r2cls + '">' + res.r2.toFixed(3) + '</span>';
        var nPeaks = res.fitParams.length / 3;
        var peaks = [];
        for (var i = 0; i < nPeaks; i++) peaks.push(res.fitParams[i * 3 + 1].toFixed(1));
        var statusBadge = res.flagged
            ? '<span class="badge badge-warning text-dark"><i class="fa fa-exclamation-triangle"></i> Check</span>'
            : '<span class="badge badge-success"><i class="fa fa-check"></i> OK</span>';
        if (res.adjusted) statusBadge += ' <span class="badge badge-info" title="Manually adjusted">adj</span>';
        var safeName = fname.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        html += '<tr>' +
            '<td style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="' + fname + '">' + fname + '</td>' +
            '<td class="text-center">' + r2badge + '</td>' +
            '<td>' + peaks.join(' &middot; ') + '</td>' +
            '<td class="text-center">' + statusBadge + '</td>' +
            '<td><button class="btn btn-xs btn-outline-secondary py-0 px-1" style="font-size:0.78rem;"' +
            ' onclick="openCustomTabForAdjust(\'' + preset + '\',\'' + safeName + '\')">Adjust</button></td>' +
            '</tr>';
    });

    html += '</tbody></table></div>';
    container.innerHTML = html;
}

// Tracks which preset/sample opened the Custom tab via Adjust (null = opened directly)
var deconvAdjustSource = null;

// Switch to Custom tab pre-loaded with a specific sample and preset for manual adjustment
function openCustomTabForAdjust(preset, fname) {
    deconvAdjustSource = { preset: preset, fname: fname };

    // Show the navigation bar with label
    var nav = document.getElementById('deconv-custom-nav');
    if (nav) nav.style.display = 'flex';
    var presetLabels = { 'ex440': 'Ex 440 nm / Chl · PSII/PSI', 'ex620': 'Ex 620 nm / PC', 'ex560': 'Ex 560 nm / PE' };
    var lbl = document.getElementById('deconv-custom-nav-label');
    if (lbl) lbl.textContent = 'Adjusting: ' + fname + '  ·  ' + (presetLabels[preset] || preset) + ' batch';

    var customTab = document.getElementById('dcsub-custom-tab');
    if (customTab) $(customTab).tab('show');

    var sampSel = document.getElementById('deconv-sample-select');
    if (sampSel) sampSel.value = fname;

    // Set excitation closest to preset target
    var cfg = DECONV_PRESET_CONFIG[preset];
    var exSel = document.getElementById('deconv-ex-select');
    if (exSel && cfg) {
        var bestOpt = null, bestDist = Infinity;
        Array.from(exSel.options).forEach(function(opt) {
            var d = Math.abs(parseFloat(opt.value) - cfg.targetEx);
            if (d < bestDist) { bestDist = d; bestOpt = opt; }
        });
        if (bestOpt) exSel.value = bestOpt.value;
    }

    // Restore exact saved fit, or re-fit from preset defaults if no result yet
    var res = deconvBatchResults[preset] && deconvBatchResults[preset][fname];
    if (res && res.fitParams && res.xArr) {
        // Exact restoration — skip re-optimization entirely
        var nPeaks = res.fitParams.length / 3;
        deconvPeakMus = [];
        for (var i = 0; i < nPeaks; i++) deconvPeakMus.push(Math.round(res.fitParams[i * 3 + 1]));
        rebuildPeaksEditor();
        // Set ex selector to match actual fitted wavelength
        if (exSel) {
            var bestOpt2 = null, bestDist2 = Infinity;
            Array.from(exSel.options).forEach(function(opt) {
                var d = Math.abs(parseFloat(opt.value) - res.exWl);
                if (d < bestDist2) { bestDist2 = d; bestOpt2 = opt; }
            });
            if (bestOpt2) exSel.value = bestOpt2.value;
        }
        deconvFitParams = res.fitParams.slice();
        deconvCurrentData = { xArr: res.xArr, yArr: res.yArr, fname: fname, exWl: res.exWl };
        setTimeout(function() {
            renderDeconvChart(res.xArr, res.yArr, deconvFitParams, fname, res.exWl);
            renderDeconvResults(deconvFitParams, res.xArr, res.yArr);
            renderDeconvSliders(deconvFitParams, res.xArr, res.yArr);
        }, 80);
    } else {
        deconvPeakMus = cfg ? cfg.getPeaks().slice() : [689, 724];
        rebuildPeaksEditor();
        setTimeout(function() { runDeconvolution(true); }, 80);
    }
}

// Hide the nav bar and return to the originating preset sub-tab
function backToPresetTab() {
    var src = deconvAdjustSource;
    deconvAdjustSource = null;
    var nav = document.getElementById('deconv-custom-nav');
    if (nav) nav.style.display = 'none';
    if (src) {
        var tab = document.getElementById('dcsub-' + src.preset.replace('ex', '') + '-tab');
        if (tab) $(tab).tab('show');
    }
}

// Save current custom fit back into deconvBatchResults and return to the preset sub-tab
function saveAdjustedFit() {
    var src = deconvAdjustSource;
    if (!src || !deconvFitParams || !deconvCurrentData) { backToPresetTab(); return; }

    // Recompute R² from current fit
    var xArr = deconvCurrentData.xArr, yArr = deconvCurrentData.yArr;
    var yMean = yArr.reduce(function(a, b) { return a + b; }, 0) / yArr.length;
    var ssTot = yArr.reduce(function(a, v) { return a + Math.pow(v - yMean, 2); }, 0);
    var ssRes = xArr.reduce(function(s, x, i) {
        return s + Math.pow(yArr[i] - gaussianSum(deconvFitParams, x), 2);
    }, 0);
    var r2 = ssTot > 0 ? Math.max(0, Math.min(1, 1 - ssRes / ssTot)) : 0;

    // Overwrite batch result entry
    if (!deconvBatchResults[src.preset]) deconvBatchResults[src.preset] = {};
    deconvBatchResults[src.preset][src.fname] = {
        fitParams: deconvFitParams.slice(),
        r2: r2,
        exWl: deconvCurrentData.exWl,
        xArr: xArr,
        yArr: yArr,
        peaks: deconvPeakMus.slice(),
        flagged: r2 < 0.90,
        adjusted: true
    };

    // Refresh the batch table for this preset
    var files = eemData ? eemData.files : [];
    renderDeconvBatchTable(src.preset, files);

    backToPresetTab();
}

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

    // Custom tab: populate sample and excitation selectors
    var sampSel = document.getElementById('deconv-sample-select');
    if (sampSel) {
        sampSel.innerHTML = '';
        eemData.files.forEach(function(f) {
            var opt = document.createElement('option'); opt.value = f; opt.textContent = f;
            sampSel.appendChild(opt);
        });
    }
    var exSel = document.getElementById('deconv-ex-select');
    if (exSel) {
        exSel.innerHTML = '';
        eemData.ex_wls.forEach(function(ex) {
            var opt = document.createElement('option'); opt.value = String(ex); opt.textContent = ex + ' nm';
            exSel.appendChild(opt);
        });
    }

    // Batch tabs: show/hide based on pigmentation + populate excitation dropdowns
    updateDeconvSubTabs();

    if (autoRun && exSel) {
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
        if (presetSel) presetSel.value = bestPreset;
        applyDeconvPreset();

        var targetEx = PRESET_EX[bestPreset];
        var bestExIdx = 0, bestExDist = Infinity;
        eemData.ex_wls.forEach(function(ex, i) {
            var d = Math.abs(ex - targetEx);
            if (d < bestExDist) { bestExDist = d; bestExIdx = i; }
        });
        exSel.selectedIndex = bestExIdx;

        runDeconvolution(true);
    } else {
        applyDeconvPreset();
    }
}

function applyDeconvPreset() {
    var preset = document.getElementById('deconv-preset-select').value;
    var cfg = DECONV_PRESET_CONFIG[preset];
    deconvPeakMus = cfg ? cfg.getPeaks().slice() : [WL_CONFIG.k77_em_psii, WL_CONFIG.k77_em_psi];
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
            var xi = -1, ei = -1, bestDx = 6, bestDe = 6;
            mapData.ex_wl.forEach(function(v, i) { var d = Math.abs(v - ex); if (d < bestDx) { bestDx = d; xi = i; } });
            mapData.em_wl.forEach(function(v, i) { var d = Math.abs(v - em); if (d < bestDe) { bestDe = d; ei = i; } });
            return (xi === -1 || ei === -1) ? null : mapData.intensity[ei][xi];
        }

        var params;
        var W = WL_CONFIG;
        if (eemData.analysis_mode === 'RT') {
            var f685 = getPoint(W.rt_ex_chl, W.rt_em_f685),
                f730 = getPoint(W.rt_ex_chl, W.rt_em_f730);
            params = {F685: f685, F730: f730,
                      F685_to_F730: null,
                      PBS_F657: null, PBS_F685: null, PBS_F705: null, PBS_F730: null, PBS_tot: null,
                      PBS_free_norm: null, PBS_PSII_norm: null, PBS_PSI_norm: null,
                      PBS_F685_to_F705: null, PBS_F685_to_F730: null};
            if (f685 != null && f730 != null && f730 > 0) params.F685_to_F730 = f685 / f730;
            var pbsF657 = getPoint(W.rt_ex_pbs, W.rt_em_pbs_free),
                pbsF685 = getPoint(W.rt_ex_pbs, W.rt_em_pbs_psii),
                pbsF705 = getPoint(W.rt_ex_pbs, W.rt_em_pbs_psi),
                pbsF730 = getPoint(W.rt_ex_pbs, W.rt_em_pbs_f730);
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
            var chlPSII = getPoint(W.k77_ex_chl, W.k77_em_psii),
                chlPSI  = getPoint(W.k77_ex_chl, W.k77_em_psi),
                fCp43   = getPoint(W.k77_ex_chl, W.k77_em_cp43),
                fCp47   = getPoint(W.k77_ex_chl, W.k77_em_cp47);
            params = {Chl_PSII: chlPSII, Chl_PSI: chlPSI, Chl_tot: null,
                      Chl_PSII_norm: null, Chl_PSI_norm: null, PSII_to_PSI: null, CP43_to_CP47: null,
                      PBS_free: null, PBS_PSII: null, PBS_PSI: null, PBS_tot: null,
                      PBS_free_norm: null, PBS_PSII_norm: null, PBS_PSI_norm: null,
                      PBS_PSII_to_PBS_PSI: null, PC_to_PE: null};
            if (chlPSII != null && chlPSI != null) {
                var tot = chlPSII + chlPSI;
                params.Chl_tot = tot;
                if (tot > 0) { params.Chl_PSII_norm = chlPSII / tot; params.Chl_PSI_norm = chlPSI / tot; }
                if (chlPSI > 0) params.PSII_to_PSI = chlPSII / chlPSI;
            }
            if (fCp43 != null && fCp47 != null && fCp47 > 0) params.CP43_to_CP47 = fCp43 / fCp47;
            if (pigmVal !== 'checkbox_chl_only') {
                var pbsFree = null, pbsPSII = null, pbsPSI = null;
                if (pigmVal === 'checkbox_chl_PC') {
                    pbsFree = getPoint(W.k77_ex_pc, W.k77_em_pbs_free);
                    pbsPSII = getPoint(W.k77_ex_pc, W.k77_em_psii);
                    pbsPSI  = getPoint(W.k77_ex_pc, W.k77_em_psi);
                } else if (pigmVal === 'checkbox_chl_PE') {
                    var p562 = getPoint(W.k77_ex_pe, W.k77_em_pbs_free),
                        p558 = getPoint(W.k77_ex_pe, W.k77_em_pe);
                    if (p562 != null && p558 != null) pbsFree = p562 + p558;
                    pbsPSII = getPoint(W.k77_ex_pe, W.k77_em_psii);
                    pbsPSI  = getPoint(W.k77_ex_pe, W.k77_em_psi);
                } else if (pigmVal === 'checkbox_chl_PC_PE') {
                    var has560 = mapData.ex_wl.some(function(v) { return Math.abs(v - W.k77_ex_pe) < 0.5; });
                    if (has560) {
                        pbsFree = (getPoint(W.k77_ex_pc, W.k77_em_pbs_free) || 0) +
                                  (getPoint(W.k77_ex_pe, W.k77_em_pbs_free) || 0) +
                                  (getPoint(W.k77_ex_pe, W.k77_em_pe) || 0);
                        pbsPSII = (getPoint(W.k77_ex_pc, W.k77_em_psii) || 0) +
                                  (getPoint(W.k77_ex_pe, W.k77_em_psii) || 0);
                        pbsPSI  = (getPoint(W.k77_ex_pc, W.k77_em_psi) || 0) +
                                  (getPoint(W.k77_ex_pe, W.k77_em_psi) || 0);
                        var pc = getPoint(W.k77_ex_pc, W.k77_em_pbs_free),
                            pe662 = getPoint(W.k77_ex_pe, W.k77_em_pbs_free),
                            pe580 = getPoint(W.k77_ex_pe, W.k77_em_pe);
                        if (pc != null && pe662 != null && pe580 != null) {
                            var pe = pe662 + pe580;
                            params.PC_to_PE = pe > 0 ? pc / pe : null;
                        }
                    } else {
                        pbsFree = getPoint(W.k77_ex_pc, W.k77_em_pbs_free);
                        pbsPSII = getPoint(W.k77_ex_pc, W.k77_em_psii);
                        pbsPSI  = getPoint(W.k77_ex_pc, W.k77_em_psi);
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
// Wavelength settings panel — read inputs → update WL_CONFIG → recompute
// ============================================================
function updateWlConfig() {
    function v(id, fallback) {
        var el = document.getElementById(id);
        var n = el ? parseFloat(el.value) : NaN;
        return isNaN(n) ? fallback : n;
    }
    WL_CONFIG.k77_ex_chl      = v('wl-k77-ex-chl',      WL_CONFIG.k77_ex_chl);
    WL_CONFIG.k77_ex_pc       = v('wl-k77-ex-pc',       WL_CONFIG.k77_ex_pc);
    WL_CONFIG.k77_ex_pe       = v('wl-k77-ex-pe',       WL_CONFIG.k77_ex_pe);
    WL_CONFIG.k77_em_psii     = v('wl-k77-em-psii',     WL_CONFIG.k77_em_psii);
    WL_CONFIG.k77_em_psi      = v('wl-k77-em-psi',      WL_CONFIG.k77_em_psi);
    WL_CONFIG.k77_em_cp43     = v('wl-k77-em-cp43',     WL_CONFIG.k77_em_cp43);
    WL_CONFIG.k77_em_cp47     = v('wl-k77-em-cp47',     WL_CONFIG.k77_em_cp47);
    WL_CONFIG.k77_em_pbs_free = v('wl-k77-em-pbs-free', WL_CONFIG.k77_em_pbs_free);
    WL_CONFIG.k77_em_pe       = v('wl-k77-em-pe',       WL_CONFIG.k77_em_pe);
    WL_CONFIG.rt_ex_chl       = v('wl-rt-ex-chl',       WL_CONFIG.rt_ex_chl);
    WL_CONFIG.rt_ex_pbs       = v('wl-rt-ex-pbs',       WL_CONFIG.rt_ex_pbs);
    WL_CONFIG.rt_em_f685      = v('wl-rt-em-f685',      WL_CONFIG.rt_em_f685);
    WL_CONFIG.rt_em_f730      = v('wl-rt-em-f730',      WL_CONFIG.rt_em_f730);
    WL_CONFIG.rt_em_pbs_free  = v('wl-rt-em-pbs-free',  WL_CONFIG.rt_em_pbs_free);
    WL_CONFIG.rt_em_pbs_psii  = v('wl-rt-em-pbs-psii',  WL_CONFIG.rt_em_pbs_psii);
    WL_CONFIG.rt_em_pbs_psi   = v('wl-rt-em-pbs-psi',   WL_CONFIG.rt_em_pbs_psi);
    WL_CONFIG.rt_em_pbs_f730  = v('wl-rt-em-pbs-f730',  WL_CONFIG.rt_em_pbs_f730);
    recomputeParamsFromMaps();
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
            '(https://www.cyano.tools/ex_em_spectra_analysis). ' +
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
            'CyanoTools (https://www.cyano.tools/ex_em_spectra_analysis). ' +
            'A total of ' + n + ' sample' + (n !== 1 ? 's were' : ' was') + ' analyzed (' + fList + ').'
        );

        var specLineRT = 'Emission spectra were extracted at excitation wavelength' +
            (eemData.ex_wls.length !== 1 ? 's ' : ' ') + exWls + '\u202fnm. ' +
            'Spectral visualization applied ' + normLabel + '.';
        lines.push(specLineRT);

        lines.push(
            'Room-temperature fluorescence parameters were derived from: Ex\u202f440/Em\u202f685\u202fnm ' +
            '(F685; PSII pool \u2014 CP43 and CP47 are spectrally unresolved at RT), ' +
            'Ex\u202f440/Em\u202f730\u202fnm (F730; PSI red-shifted chlorophylls). The F685/F730 ratio ' +
            '(Ex\u202f440\u202fnm) was used as a relative PSII pool\u202f:\u202fPSI indicator; note that PSI ' +
            'emission tail overlap introduces uncertainty in this ratio at RT (Remelli & Santabarbara, 2018). PBS coupling was assessed ' +
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

    // Hide Custom tab nav bar when the Custom sub-tab is opened directly (not via Adjust button)
    $('#dcsub-custom-tab').on('show.bs.tab', function() {
        if (!deconvAdjustSource) {
            var nav = document.getElementById('deconv-custom-nav');
            if (nav) nav.style.display = 'none';
        }
    });

    // Tab shown events (jQuery required — Bootstrap 4 fires via jQuery event system)
    $('#eemTabs a[data-toggle="tab"]').on('shown.bs.tab', function(e) {
        var target = $(e.target).attr('href');
        if (target === '#eem-spectra' && dirtyTabs.has('spectra')) renderSpectraTab();
        if (target === '#eem-map'     && dirtyTabs.has('map'))     renderMapTab();
        if (target === '#eem-derived' && dirtyTabs.has('derived')) renderDerivedTab();
        if (target === '#eem-groups'  && dirtyTabs.has('groups'))  renderGroupsTab();
        if (target === '#eem-deconv'     && chartInst['deconv'])  chartInst['deconv'].resize();
        if (target === '#eem-parafac')    updateParafacTabState();
        if (target === '#eem-comparison') renderComparisonTab();
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
var parafacAnnotations = [];   // user-editable per-component text labels
var parafacPigmAssign = [];    // biological pigment assignment per component
var parafacRejected   = [];    // boolean: exclude component from export/comparison
var parafacPigmAssignDefault = [];  // auto-suggested assignments at run time (for change detection)

// Pigment assignment options: [value, display label]
var PIGM_ASSIGN_OPTIONS = [
    ['',         '— unassigned —'],
    ['CP43',     'CP43  (Em ~685 nm)'],
    ['CP47',     'CP47  (Em ~695 nm)'],
    ['PSI',      'PSI  (Em ~724 nm)'],
    ['PBS_free', 'PBS-free  (Em ~662 nm)'],
    ['PBS_PSII', 'PBS→PSII  (Em ~689 nm)'],
    ['PBS_PSI',  'PBS→PSI  (Em ~724 nm)'],
    ['Chl675',   'Chl a 675 nm background'],
    ['other',    'Other / unresolved']
];

// Component colours (one per component, up to 8)
var PARAFAC_COLORS = ['#4472C4','#ED7D31','#A9D18E','#FF0000',
                      '#7030A0','#00B0F0','#FFC000','#70AD47'];

function _parafacValidate() {
    if (!eemData || !eemData.files || eemData.files.length < 3)
        return 'At least 3 samples are needed for PARAFAC analysis.';
    var keys = Object.keys(eemData.maps);
    if (!keys.length) return 'No EEM maps available.';
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
    var diagChecked = document.getElementById('par-diag-mask-check').checked;
    document.getElementById('par-diag-mask-row').style.display = diagChecked ? '' : 'none';
}

function _buildParafacPayload(extra) {
    var scatter = {
        rayleigh1_width: document.getElementById('par-r1-check').checked
            ? parseFloat(document.getElementById('par-r1-slider').value) : 0,
        rayleigh2_width: document.getElementById('par-r2-check').checked
            ? parseFloat(document.getElementById('par-r2-slider').value) : 0,
        raman_width: document.getElementById('par-ram-check').checked
            ? parseFloat(document.getElementById('par-ram-slider').value) : 0,
        interpolate: document.getElementById('par-interp-check').checked,
        diag_mask_enabled: document.getElementById('par-diag-mask-check').checked,
        diag_mask_buffer: parseFloat(document.getElementById('par-diag-mask-buffer').value) || 10
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

// ── SSE fetch helper ─────────────────────────────────────────────────────────
// Streams Server-Sent Events from a POST endpoint.
// onEvent(data) — called for each non-done event
// onDone(data)  — called on {done:true} event (data may be null for diagnostic)
// onError(err)  — called on network or parse error
function _fetchSSE(url, payload, onEvent, onDone, onError, signal) {
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal
    })
    .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var reader = resp.body.getReader();
        var decoder = new TextDecoder();
        var buf = '';
        var doneCalled = false;
        function pump() {
            return reader.read().then(function(chunk) {
                if (chunk.done) { if (!doneCalled) onDone(null); return; }
                buf += decoder.decode(chunk.value, { stream: true });
                var lines = buf.split('\n');
                buf = lines.pop();
                lines.forEach(function(line) {
                    if (line.indexOf('data: ') !== 0) return;
                    try {
                        var data = JSON.parse(line.slice(6));
                        if (data.done) { doneCalled = true; onDone(data); }
                        else           { onEvent(data); }
                    } catch (e) {}
                });
                return pump();
            });
        }
        return pump();
    })
    .catch(function(e) { onError(e); });
}

// ── Elapsed-time ticker ───────────────────────────────────────────────────────
function _startElapsed(elId) {
    var el = document.getElementById(elId);
    if (!el) return null;
    var t0 = Date.now();
    el.textContent = '0s';
    var tid = setInterval(function() {
        var s = Math.round((Date.now() - t0) / 1000);
        el.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    }, 1000);
    return tid;
}
function _stopElapsed(tid) { if (tid) clearInterval(tid); }

// ── Step 1: Diagnostic (CORCONDIA) ───────────────────────────────────────────
var _parafacDiagController = null;

function stopParafacDiagnostic() {
    if (_parafacDiagController) { _parafacDiagController.abort(); _parafacDiagController = null; }
}

function runParafacDiagnostic() {
    var err = _parafacValidate();
    if (err) { _parafacShowError(err); return; }
    _parafacHideError();

    _parafacDiagController = new AbortController();
    var spinner  = document.getElementById('par-diag-spinner');
    var stopBtn  = document.getElementById('par-diag-stop');
    var runBtn   = document.getElementById('par-diag-btn');
    var progWrap = document.getElementById('par-diag-progress-wrap');
    var progBar  = document.getElementById('par-diag-progress-bar');
    var statusEl = document.getElementById('par-diag-status');

    if (spinner)  spinner.style.display = '';
    if (stopBtn)  stopBtn.style.display = '';
    if (runBtn)   runBtn.disabled = true;
    if (progWrap) progWrap.style.display = '';
    if (progBar)  progBar.style.width = '0%';
    if (statusEl) statusEl.textContent = 'Starting…';

    var elapsedTid = _startElapsed('par-diag-elapsed');
    var accumulated = [];

    function _diagReset() {
        _stopElapsed(elapsedTid);
        if (spinner)  spinner.style.display = 'none';
        if (stopBtn)  stopBtn.style.display = 'none';
        if (runBtn)   runBtn.disabled = false;
        if (progWrap) progWrap.style.display = 'none';
        _parafacDiagController = null;
    }

    var payload = _buildParafacPayload({
        f_max: parseInt(document.getElementById('par-fmax-slider').value)
    });

    _fetchSSE('/api/eem_parafac_diagnostic', payload,
        function onEvent(data) {  // one rank result arrives
            if (data.error) { _diagReset(); _parafacShowError(data.error); return; }
            accumulated.push(data);
            // Update progress bar
            var pct = data.f_total > 0 ? Math.round(data.f * 100 / data.f_total) : 0;
            if (progBar)  progBar.style.width = pct + '%';
            if (statusEl) statusEl.textContent =
                'Rank ' + data.f + ' / ' + data.f_total +
                '  ·  CORCONDIA: ' + (data.corcondia != null ? data.corcondia + '%' : '—') +
                '  ·  Var: ' + (data.explained_variance != null ? data.explained_variance + '%' : '—');
            // Re-render chart incrementally with whatever we have so far
            parafacDiagResults = accumulated.slice();
            renderParafacDiagnostic(accumulated);
        },
        function onDone() {  // {done:true} sentinel
            _diagReset();
        },
        function onError(e) {
            _diagReset();
            if (e.name !== 'AbortError') _parafacShowError('Request failed: ' + e);
        },
        _parafacDiagController.signal
    );
}

function _setParafacRank(f) {
    var slider = document.getElementById('par-rank-slider');
    var valDisplay = document.getElementById('par-rank-val');
    if (!slider) return;
    slider.value = Math.min(f, parseInt(slider.max));
    slider._userSet = true;
    if (valDisplay) valDisplay.textContent = slider.value;
    var badge = document.getElementById('par-rank-val');
    if (badge) {
        badge.classList.remove('badge-primary');
        badge.classList.add('badge-success');
        setTimeout(function() {
            badge.classList.remove('badge-success');
            badge.classList.add('badge-primary');
        }, 1200);
    }
}

function renderParafacDiagnostic(results) {
    document.getElementById('parafac-diag-section').style.display = '';

    var fs = results.map(function(r) { return r.f; });
    var ccs = results.map(function(r) { return r.corcondia; });
    var evs = results.map(function(r) { return r.explained_variance; });

    function setRankFromDiag(f) {
        _setParafacRank(f);
    }

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
            pointRadius: 6,
            pointHoverRadius: 9,
            pointHoverBackgroundColor: '#fff',
            pointHoverBorderColor: color,
            pointHoverBorderWidth: 2.5
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
                onClick: function(_event, elements) {
                    if (elements.length > 0 && elements[0].datasetIndex === 0) {
                        setRankFromDiag(fs[elements[0].index]);
                    }
                },
                onHover: function(event, elements) {
                    var hasPoint = elements.length > 0 && elements[0].datasetIndex === 0;
                    event.native.target.style.cursor = hasPoint ? 'pointer' : 'default';
                },
                plugins: {
                    legend: { display: true, position: 'bottom',
                        labels: { boxWidth: 12, font: { size: 11 } } },
                    tooltip: {
                        callbacks: {
                            afterBody: function(items) {
                                if (items[0] && items[0].datasetIndex === 0) {
                                    return ['Click to use F = ' + fs[items[0].dataIndex] + ' as rank'];
                                }
                                return [];
                            }
                        }
                    }
                },
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

    // CORCONDIA recommendation: highest F where CORCONDIA >= 80
    var ccHint = document.getElementById('par-rank-cc-hint');
    if (ccHint && results.length > 0) {
        var recommended = null;
        for (var i = 0; i < results.length; i++) {
            if (results[i].corcondia != null && results[i].corcondia >= 80) {
                recommended = results[i].f;
            }
        }
        if (recommended !== null) {
            ccHint.innerHTML =
                '<i class="fa fa-check-circle text-success mr-1"></i>' +
                'CORCONDIA suggests <strong>F&nbsp;=&nbsp;' + recommended + '</strong> ' +
                '(last rank with CORCONDIA&nbsp;&ge;&nbsp;80%)&nbsp;&nbsp;' +
                '<button class="btn btn-xs btn-outline-success py-0 px-1" ' +
                    'style="font-size:0.72rem; line-height:1.3;" ' +
                    'onclick="_setParafacRank(' + recommended + ')">Use</button>';
        } else {
            ccHint.innerHTML =
                '<i class="fa fa-exclamation-triangle text-warning mr-1"></i>' +
                '<span class="text-warning">No rank with CORCONDIA&nbsp;&ge;&nbsp;80% found. ' +
                'Try reducing scatter or increasing max components.</span>';
        }
        ccHint.style.display = '';
    }
}

// ── Step 2: Full PARAFAC fit ──────────────────────────────────────────────────
var _parafacFitController = null;

function stopParafac() {
    if (_parafacFitController) { _parafacFitController.abort(); _parafacFitController = null; }
}

function runParafac() {
    var err = _parafacValidate();
    if (err) { _parafacShowError(err); return; }
    _parafacHideError();

    _parafacFitController = new AbortController();
    var spinner  = document.getElementById('par-fit-spinner');
    var stopBtn  = document.getElementById('par-fit-stop');
    var runBtn   = document.getElementById('par-fit-btn');
    var progWrap = document.getElementById('par-fit-progress-wrap');
    var progBar  = document.getElementById('par-fit-progress-bar');
    var statusEl = document.getElementById('par-fit-status');

    if (spinner)  spinner.style.display = '';
    if (stopBtn)  stopBtn.style.display = '';
    if (runBtn)   runBtn.disabled = true;
    if (progWrap) progWrap.style.display = '';
    if (progBar)  progBar.style.width = '0%';
    if (statusEl) statusEl.textContent = 'Starting…';

    var elapsedTid = _startElapsed('par-fit-elapsed');

    function _fitReset() {
        _stopElapsed(elapsedTid);
        if (spinner)  spinner.style.display = 'none';
        if (stopBtn)  stopBtn.style.display = 'none';
        if (runBtn)   runBtn.disabled = false;
        if (progWrap) progWrap.style.display = 'none';
        _parafacFitController = null;
    }

    var rank = parseInt(document.getElementById('par-rank-slider').value);
    var payload = _buildParafacPayload({
        rank:       rank,
        n_restarts: parseInt(document.getElementById('par-restarts-slider').value),
        max_iter:   500,
        tol:        parseFloat(document.getElementById('par-tol-select').value)
    });

    _fetchSSE('/api/eem_parafac', payload,
        function onEvent(data) {  // one restart progress event
            if (data.error) { _fitReset(); _parafacShowError(data.error); return; }
            var pct = data.total > 0 ? Math.round(data.restart * 100 / data.total) : 0;
            if (progBar)  progBar.style.width = pct + '%';
            if (statusEl) statusEl.textContent =
                'Restart ' + data.restart + ' / ' + data.total +
                '  ·  this err: ' + data.err.toFixed(4) +
                '  ·  best: ' + data.best_err.toFixed(4);
        },
        function onDone(data) {  // final result with {done:true, ...}
            _fitReset();
            if (!data || data.error) {
                var msg = (data && data.error) || 'Unknown error';
                if (data && data.traceback) console.error('PARAFAC server traceback:\n' + data.traceback);
                _parafacShowError(msg);
                return;
            }
            try {
                parafacResults = data;
                parafacAnnotations = data.annotations.slice();
                parafacRejected   = data.annotations.map(function() { return false; });
                parafacPigmAssign = data.em_loadings.map(function(emLoad, r) {
                    return _suggestPigmAssign(data.ex_wl, data.em_wl, data.ex_loadings[r], emLoad);
                });
                parafacPigmAssignDefault = parafacPigmAssign.slice();
                renderParafacResults(data);
                _updateCopyScoresBtn();
                updateComparisonTabState();
                // Auto-refresh comparison tab if Gaussian data is already present
                var hasGauss = deconvBatchResults.ex440 &&
                               Object.keys(deconvBatchResults.ex440).length > 0;
                if (hasGauss) renderComparisonTab();
            } catch (e) {
                _parafacShowError('Rendering error: ' + e.message);
                console.error('PARAFAC render error:', e);
            }
        },
        function onError(e) {
            _fitReset();
            if (e.name !== 'AbortError') _parafacShowError('Request failed: ' + e);
        },
        _parafacFitController.signal
    );
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

// Auto-suggest pigment assignment from excitation + emission loading peaks
function _suggestPigmAssign(exWl, emWl, exLoading, emLoading) {
    var emPeak = emWl[emLoading.indexOf(Math.max.apply(null, emLoading))];
    var exPeak = exWl[exLoading.indexOf(Math.max.apply(null, exLoading))];
    var isPBS  = exPeak > 560 && exPeak < 660;   // Ex > 560 = PBS excitation
    if (emPeak < 670)  return isPBS ? 'PBS_free' : 'Chl675';
    if (emPeak < 680)  return isPBS ? 'PBS_free' : 'Chl675';
    if (emPeak < 692)  return isPBS ? 'PBS_PSII' : 'CP43';
    if (emPeak < 710)  return 'CP47';
    return 'PSI';
}

function _buildComponentCard(r, data) {
    var col = document.createElement('div');
    col.className = 'col-md-6 mb-3';
    col.id = 'parafac-comp-card-' + r;

    var color  = PARAFAC_COLORS[r % PARAFAC_COLORS.length];
    var annot  = parafacAnnotations[r] || ('Component ' + (r + 1));
    var assign = parafacPigmAssign[r] || '';
    var rejected = parafacRejected[r] || false;

    // Build pigment assignment <select> options
    var pigmOpts = PIGM_ASSIGN_OPTIONS.map(function(o) {
        return '<option value="' + o[0] + '"' + (o[0] === assign ? ' selected' : '') + '>' + o[1] + '</option>';
    }).join('');

    col.innerHTML =
        '<div class="card h-100" id="par-card-inner-' + r + '" style="' + (rejected ? 'opacity:0.45;' : '') + '">' +
          '<div class="card-header py-1" style="background:' + color + '22; border-left:4px solid ' + color + ';">' +
            '<div class="d-flex align-items-center" style="gap:4px;">' +
              '<span class="font-weight-bold" style="font-size:0.9rem; white-space:nowrap;">C' + (r + 1) + '</span>' +
              '<input type="text" class="form-control form-control-sm" style="min-width:0; flex:1; font-size:0.82rem;" ' +
                'id="par-annot-' + r + '" value="' + annot + '" ' +
                'onchange="parafacAnnotations[' + r + ']=this.value; _reAnnotateParafacComponents(getPigmentation());">' +
              '<select class="form-control form-control-sm" style="width:auto; font-size:0.78rem;" ' +
                'id="par-pigm-' + r + '" ' +
                'onchange="parafacPigmAssign[' + r + ']=this.value; _updateCopyScoresBtn(); updateComparisonTabState();">' +
                pigmOpts +
              '</select>' +
              '<label class="mb-0 ml-1 d-flex align-items-center" style="gap:3px; font-size:0.78rem; white-space:nowrap; cursor:pointer;" ' +
                'title="Exclude this component from export and comparison">' +
                '<input type="checkbox" id="par-reject-' + r + '"' + (rejected ? ' checked' : '') + ' ' +
                  'onchange="parafacRejected[' + r + ']=this.checked; ' +
                    'document.getElementById(\'par-card-inner-' + r + '\').style.opacity=this.checked?\'0.45\':\'\'; ' +
                    '_updateCopyScoresBtn(); updateComparisonTabState();">' +
                ' Reject' +
              '</label>' +
            '</div>' +
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
        // Find peak indices in loadings to pick the right EEM slice for raw-data overlay
        var exPeakIdx = data.ex_loadings[r].indexOf(Math.max.apply(null, data.ex_loadings[r]));
        var emPeakIdx = data.em_loadings[r].indexOf(Math.max.apply(null, data.em_loadings[r]));
        var exMeanSd = _computeLoadingMeanSd('em', exPeakIdx);  // emission slice at peak Ex
        var emMeanSd = _computeLoadingMeanSd('ex', emPeakIdx);  // excitation slice at peak Em
        _drawLoadingChart('par-ex-chart-' + r, 'Excitation loading',
            data.ex_wl, data.ex_loadings[r], 'Excitation (nm)', color, emMeanSd);
        _drawLoadingChart('par-em-chart-' + r, 'Emission loading',
            data.em_wl, data.em_loadings[r], 'Emission (nm)', color, exMeanSd);
    }, 0);

    return col;
}

// Compute mean ± SD of normalised EEM spectra sliced at a given index.
// axis='em': slice emission dimension at excitation index peakIdx (gives emission spectra)
// axis='ex': slice excitation dimension at emission index peakIdx (gives excitation spectra)
function _computeLoadingMeanSd(axis, peakIdx) {
    if (!eemData || !eemData.files.length) return null;
    var allSpectra = [];
    eemData.files.forEach(function(fname) {
        var m = eemData.maps[fname];
        if (!m) return;
        var spectrum;
        if (axis === 'em') {
            spectrum = m.intensity.map(function(row) { return row[peakIdx] || 0; });
        } else {
            var row = m.intensity[peakIdx];
            spectrum = row ? row.slice() : [];
        }
        if (!spectrum.length) return;
        var peak = Math.max.apply(null, spectrum.map(Math.abs));
        if (peak > 0) spectrum = spectrum.map(function(v) { return v / peak; });
        allSpectra.push(spectrum);
    });
    if (!allSpectra.length) return null;
    var n = allSpectra[0].length;
    var mean = [], sdPlus = [], sdMinus = [];
    for (var i = 0; i < n; i++) {
        var vals = allSpectra.map(function(s) { return s[i] || 0; });
        var mu = vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
        var sd = Math.sqrt(vals.reduce(function(a, v) { return a + (v - mu) * (v - mu); }, 0) / vals.length);
        mean.push(mu);
        sdPlus.push(mu + sd);
        sdMinus.push(mu - sd);
    }
    return { mean: mean, sdPlus: sdPlus, sdMinus: sdMinus };
}

function _drawLoadingChart(canvasId, label, wl, values, xLabel, color, meanSd) {
    if (chartInst[canvasId]) chartInst[canvasId].destroy();
    var ctx = document.getElementById(canvasId);
    if (!ctx) return;

    var datasets = [];

    // Mean ± SD band from raw EEM data (grey, shown behind the component loading)
    if (meanSd) {
        // SD+ boundary (fills down to SD-)
        datasets.push({
            label: 'Mean+SD',
            data: meanSd.sdPlus,
            borderColor: 'rgba(0,0,0,0)',
            backgroundColor: 'rgba(150,150,150,0.18)',
            fill: '+1',
            tension: 0.3, pointRadius: 0, borderWidth: 0
        });
        // SD- boundary
        datasets.push({
            label: 'Mean−SD',
            data: meanSd.sdMinus,
            borderColor: 'rgba(0,0,0,0)',
            backgroundColor: 'rgba(150,150,150,0.18)',
            fill: false,
            tension: 0.3, pointRadius: 0, borderWidth: 0
        });
        // Mean line
        datasets.push({
            label: 'Mean (raw)',
            data: meanSd.mean,
            borderColor: '#999',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.3, pointRadius: 0, borderWidth: 1,
            borderDash: [4, 3]
        });
    }

    // Component loading (colored, on top)
    datasets.push({
        label: label,
        data: values,
        borderColor: color,
        backgroundColor: color + '22',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2
    });

    chartInst[canvasId] = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: { labels: wl, datasets: datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: !!meanSd,
                    position: 'bottom',
                    labels: { boxWidth: 10, font: { size: 8 }, filter: function(item) {
                        return item.text !== 'Mean+SD' && item.text !== 'Mean−SD';
                    }}
                }
            },
            scales: {
                x: { title: { display: true, text: xLabel, font: { size: 10 } },
                     ticks: { maxTicksLimit: 5, font: { size: 9 } } },
                y: { min: 0, max: 1.05,
                     title: { display: true, text: 'Norm. intensity', font: { size: 10 } },
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

    // Compute original max for residual scale anchoring
    var origMaxVal = 0;
    if (origMap) {
        for (var ei2 = 0; ei2 < origMap.intensity.length; ei2++)
            for (var xi2 = 0; xi2 < (origMap.intensity[ei2] || []).length; xi2++) {
                var ov2 = origMap.intensity[ei2][xi2];
                if (ov2 > origMaxVal) origMaxVal = ov2;
            }
    }

    setTimeout(function() {
        if (origMap)  drawHeatmap('par-orig-canvas',  data.ex_wl, data.em_wl, origMap.intensity, colorName, false, 0.85);
        drawHeatmap('par-recon-canvas', data.ex_wl, data.em_wl, recon, colorName, false, 0.85);
        if (residual) drawHeatmapDiverging('par-resid-canvas', data.ex_wl, data.em_wl, residual, 0.85, origMaxVal || undefined);
    }, 0);
}

// Derive ratio parameters from PARAFAC scores using pigment assignments
function computeParafacParams() {
    if (!parafacResults) return {};
    var data = parafacResults;
    var out = {};
    data.sample_names.forEach(function(fname, si) {
        var scores = data.scores[si];
        var sm = {};   // pigment label → summed score
        for (var r = 0; r < data.n_components; r++) {
            if (parafacRejected[r]) continue;
            var a = parafacPigmAssign[r];
            if (a && a !== 'other' && a !== '') {
                sm[a] = (sm[a] || 0) + scores[r];
            }
        }
        var p = {};
        var sPSII = (sm['CP43'] || 0) + (sm['CP47'] || 0);
        var sPSI  = sm['PSI'] || 0;
        var sChl  = sm['Chl675'] || 0;
        var sTotChl = sPSII + sPSI + sChl;
        var sFree   = sm['PBS_free'] || 0;
        var sPBSpsii = sm['PBS_PSII'] || 0;
        var sPBSpsi  = sm['PBS_PSI'] || 0;
        var sTotPBS  = sFree + sPBSpsii + sPBSpsi;

        if (sPSII > 0 && sPSI  > 0) p.PSII_to_PSI_parafac        = sPSII / sPSI;
        if (sm['CP43'] > 0 && sm['CP47'] > 0) p.CP43_to_CP47_parafac = sm['CP43'] / sm['CP47'];
        if (sTotChl > 0 && sPSII > 0) p.Chl_PSII_norm_parafac     = sPSII / sTotChl;
        if (sTotChl > 0 && sPSI  > 0) p.Chl_PSI_norm_parafac      = sPSI  / sTotChl;
        if (sTotPBS > 0 && sFree    > 0) p.PBS_free_norm_parafac   = sFree    / sTotPBS;
        if (sTotPBS > 0 && sPBSpsii > 0) p.PBS_PSII_norm_parafac   = sPBSpsii / sTotPBS;
        if (sTotPBS > 0 && sPBSpsi  > 0) p.PBS_PSI_norm_parafac    = sPBSpsi  / sTotPBS;
        if (sPBSpsii > 0 && sPBSpsi > 0) p.PBS_PSII_to_PBS_PSI_parafac = sPBSpsii / sPBSpsi;
        out[fname] = p;
    });
    return out;
}

function copyParafacTable() {
    if (!parafacResults) return;
    var data = parafacResults;
    // Only include non-rejected components
    var activeIdx = [];
    for (var r = 0; r < data.n_components; r++) { if (!parafacRejected[r]) activeIdx.push(r); }
    var headers = ['Sample'].concat(activeIdx.map(function(r) {
        return 'Component ' + (r + 1) + ': ' + (parafacAnnotations[r] || '');
    }));
    var lines = [headers.join('\t')];
    data.sample_names.forEach(function(name, i) {
        lines.push([name].concat(activeIdx.map(function(r) { return data.scores[i][r].toFixed(6); })).join('\t'));
    });
    navigator.clipboard.writeText(lines.join('\n')).catch(function() {
        var ta = document.createElement('textarea');
        ta.value = lines.join('\n');
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
    });
}
