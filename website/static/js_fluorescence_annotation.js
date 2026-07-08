/**
 * js_fluorescence_annotation.js
 * Fluorescence Data Annotation Tool — front-end module.
 *
 * Exposed global: ANN  (IIFE)
 * Entry point   : ANN.init()  — called on DOMContentLoaded
 *
 * Design: Investigation → Study → Treatment templates → Fluorometer → per-curve grid.
 * Grid has column groups (Identity / Biological / Treatment / Conditions /
 * Replicate+QC / Acquisition), sample_type-driven conditional columns,
 * fill-down (⤓), inline edit with keyboard nav (Enter/Tab/Esc), treatment
 * template assignment, NCBI organism typeahead, and XLSX import/export.
 * Provenance shown as a left-border stripe + corner glyph.
 */
'use strict';

const ANN = (function () {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────────────
    let _schema     = {};   // { schema_version, fields: { key: FieldDef } }
    let _rows       = [];   // array of row objects from /ingest or /load_bundle
    let _bundleId   = null;
    let _files      = [];   // File objects from drop zone / file input
    let _sampleType = '';   // current sample_type (from study form or row data)
    let _filterText = '';   // toolbar search string
    let _filterIncomplete = false;
    let _filterProv = '';   // provenance filter
    let _sortKey    = '';   // sort field key
    let _treatmentTemplates = []; // [{treatment_label, chem_treatment, ...}, ...]
    let _ncbiTimer  = null; // debounce timer for NCBI search

    // Group toggles: true = visible
    let _groupVis   = { conditions: true, replicate_qc: true };

    // ── Column group definitions ──────────────────────────────────────────────
    const COL_GROUPS = {
        identity:     { label: 'Identity',       color: '#15455c' },
        biological:   { label: 'Biological',     color: '#0f9b8e' },
        treatment:    { label: 'Treatment',      color: '#7d5fe6' },
        conditions:   { label: 'Conditions',     color: '#12a3b4' },
        replicate_qc: { label: 'Replicate / QC', color: '#c98a2e' },
        acquisition:  { label: 'Acquisition',    color: '#0984e3' },
    };

    // ── Column definitions ────────────────────────────────────────────────────
    // sample_cond: '' = all | 'liquid_culture' | 'plant' | 'plant_or_leaf'
    const COLS = [
        // Sticky / always-visible
        { key: '_complete', label: 'Complete',      group: '',            editable: false, sticky: true },
        { key: 'filename',  label: 'Raw file',      group: 'identity',   editable: false, sticky: true },
        // Identity
        { key: 'curve_id',  label: 'Curve ID',      group: 'identity',   editable: false },
        { key: 'sample_id', label: 'Sample ID',     group: 'identity',   editable: true  },
        { key: 'sample_type', label: 'Sample type', group: 'identity',   editable: true  },
        // Biological (inherited from Study)
        { key: 'organism',  label: 'Organism',      group: 'biological', editable: true  },
        { key: 'genotype',  label: 'Genotype',      group: 'biological', editable: true  },
        { key: 'sub_strain_cultivar', label: 'Sub-strain / Cultivar', group: 'biological', editable: true },
        // Treatment (template-assigned)
        { key: 'treatment_label',   label: 'Treatment group',  group: 'treatment', editable: true },
        { key: 'chem_treatment',    label: 'Chemical',         group: 'treatment', editable: true },
        { key: 'chem_dose',         label: 'Chem. dose',       group: 'treatment', editable: true },
        { key: 'chem_unit',         label: 'Chem. unit',       group: 'treatment', editable: true },
        { key: 'chem_duration',     label: 'Chem. duration',   group: 'treatment', editable: true },
        { key: 'chem_detail',       label: 'Chem. detail',     group: 'treatment', editable: true },
        { key: 'stress_treatment',  label: 'Stress',           group: 'treatment', editable: true },
        { key: 'stress_dose',       label: 'Stress dose',      group: 'treatment', editable: true },
        { key: 'stress_unit',       label: 'Stress unit',      group: 'treatment', editable: true },
        { key: 'stress_duration',   label: 'Stress dur.',      group: 'treatment', editable: true },
        { key: 'stress_detail',     label: 'Stress detail',    group: 'treatment', editable: true },
        { key: 'other_treatment',   label: 'Other treatment',  group: 'treatment', editable: true },
        { key: 'other_dose',        label: 'Other dose',       group: 'treatment', editable: true },
        { key: 'other_unit',        label: 'Other unit',       group: 'treatment', editable: true },
        { key: 'other_duration',    label: 'Other dur.',       group: 'treatment', editable: true },
        { key: 'other_detail',      label: 'Other detail',     group: 'treatment', editable: true },
        { key: 'timepoint',         label: 'Time (h)',         group: 'treatment', editable: true },
        // Conditions — shared (growth light quality, applies to all sample types)
        { key: 'growth_light_type',       label: 'Light type',     group: 'conditions', editable: true },
        { key: 'growth_light_peak_wl',    label: 'Light peak λ (nm)', group: 'conditions', editable: true },
        { key: 'growth_light_peak_width', label: 'Light FWHM (nm)', group: 'conditions', editable: true },
        { key: 'growth_light_color_cat',  label: 'Light category', group: 'conditions', editable: true },
        { key: 'growth_light_note',       label: 'Light note',           group: 'conditions', editable: true },
        { key: 'growth_light_intensity',  label: 'Growth light (µmol)',  group: 'conditions', editable: true },
        { key: 'growth_temperature',      label: 'Growth temp (°C)',     group: 'conditions', editable: true },
        { key: 'growth_co2',              label: 'Growth CO₂ (%)',       group: 'conditions', editable: true },
        { key: 'temperature',             label: 'Meas. temp (°C)',      group: 'conditions', editable: true },
        // Conditions — liquid culture
        { key: 'medium',    label: 'Medium',        group: 'conditions', editable: true,  sample_cond: 'liquid_culture' },
        { key: 'medium_modification', label: 'Med. mod.', group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'trophic_mode',    label: 'Trophic mode',    group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'cultivator_type', label: 'Cultivator type', group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'cultivation_mode', label: 'Cultivation mode', group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_density_chla',  label: 'Culture Chl a µg/mL',  group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_density_cdw',   label: 'Culture CDW g/L',       group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_density_od',         label: 'Culture OD (1 cm)', group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_density_od_wl',      label: 'Culture OD λ (nm)', group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_density_other',      label: 'Culture other density',     group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_density_other_unit', label: 'Culture other density unit',group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'sample_density_chla',   label: 'Sample Chl a µg/mL',   group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'sample_density_cdw',    label: 'Sample CDW g/L',        group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'sample_density_od',     label: 'Sample OD (1 cm)',       group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'sample_density_od_wl',  label: 'Sample OD λ (nm)',       group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'sample_dilution_factor',label: 'Dilution factor',        group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'co2',       label: 'Measurement CO₂ %', group: 'conditions', editable: true,  sample_cond: 'liquid_culture' },
        { key: 'vessel',    label: 'Vessel',         group: 'conditions', editable: true,  sample_cond: 'liquid_culture' },
        { key: 'agitation', label: 'Agitation',      group: 'conditions', editable: true,  sample_cond: 'liquid_culture' },
        { key: 'growth_phase', label: 'Growth phase', group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_age',      label: 'Culture age',  group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        { key: 'culture_age_unit', label: 'Age unit',     group: 'conditions', editable: true, sample_cond: 'liquid_culture' },
        // Conditions — shared (all sample types)
        { key: 'photoperiod',     label: 'Photoperiod',group: 'conditions', editable: true, sample_cond: '' },
        // Conditions — vascular plant
        { key: 'growth_facility', label: 'Facility',   group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'growth_facility_detail', label: 'Facility detail', group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'substrate',       label: 'Substrate',  group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'pot_size',        label: 'Pot / container', group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'humidity',        label: 'Humidity %', group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'plant_age',       label: 'Plant age',  group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'plant_age_unit',  label: 'Age unit',   group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'watering_regime', label: 'Watering',   group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'fertilization',   label: 'Fertilization', group: 'conditions', editable: true, sample_cond: 'plant' },
        { key: 'dev_stage',       label: 'Dev. stage', group: 'conditions', editable: true, sample_cond: 'plant_or_leaf' },
        { key: 'plant_organ',     label: 'Organ',      group: 'conditions', editable: true, sample_cond: 'plant_or_leaf' },
        { key: 'leaf_position',   label: 'Leaf pos.',  group: 'conditions', editable: true, sample_cond: 'plant_or_leaf' },
        { key: 'leaf_surface',    label: 'Leaf surf.', group: 'conditions', editable: true, sample_cond: 'plant_or_leaf', vocab: ['adaxial','abaxial'] },
        { key: 'leaf_age',        label: 'Leaf age',   group: 'conditions', editable: true, sample_cond: 'plant_or_leaf', vocab: ['young (expanding)','mature (fully expanded)','senescent','cotyledon'] },
        { key: 'meas_position',   label: 'Meas. pos.', group: 'conditions', editable: true, sample_cond: 'plant_or_leaf', vocab: ['tip','middle','base','margin','midrib'] },
        { key: 'plant_individual_id', label: 'Plant ID', group: 'conditions', editable: true, sample_cond: 'plant_or_leaf' },
        // Replicate / QC
        { key: 'bio_rep',   label: 'Bio. rep.',     group: 'replicate_qc', editable: true  },
        { key: 'tech_rep',  label: 'Tech. rep.',    group: 'replicate_qc', editable: true  },
        { key: 'batch_id',  label: 'Batch ID',      group: 'replicate_qc', editable: true  },
        { key: 'quality',   label: 'Quality',       group: 'replicate_qc', editable: true  },
        { key: 'curve_note', label: 'Note',         group: 'replicate_qc', editable: true  },
        // Acquisition
        { key: 'instrument', label: 'Instrument',   group: 'acquisition',  editable: false },
        { key: 'fo_timing',               label: 'F0 timing',          group: 'acquisition', editable: true },
        { key: 'sat_pulse_intensity',     label: 'Sat. pulse (µmol)',  group: 'acquisition', editable: true },
        { key: 'sat_pulse_wavelength_nm', label: 'Sat. pulse λ (nm)', group: 'acquisition', editable: true },
        { key: 'sat_pulse_duration_s',    label: 'Sat. dur. (s)',      group: 'acquisition', editable: true },
        { key: 'meas_light_intensity',    label: 'Meas. light (µmol)',  group: 'acquisition', editable: true },
        { key: 'meas_light_wavelength_nm',label: 'Meas. light λ (nm)', group: 'acquisition', editable: true },
        { key: 'detector_gain',           label: 'Detector gain',      group: 'acquisition', editable: true },
        { key: 'damping',                 label: 'Damping',            group: 'acquisition', editable: true },
        { key: 'detector_bandpass_filter',label: 'Det. filter',        group: 'acquisition', editable: true },
        { key: 'sample_holder_type',      label: 'Sample holder',      group: 'acquisition', editable: true },
        { key: 'stirring',                label: 'Stirring',           group: 'acquisition', editable: true },
        { key: 'gain',                    label: 'Gain',               group: 'acquisition', editable: true },
        { key: 'timestamp',  label: 'Timestamp',    group: 'acquisition',  editable: true  },
        { key: 'acclimation_min',             label: 'Dark pre-accl. (min)',     group: 'acquisition', editable: true },
        { key: 'actinic_preaccl_intensity',   label: 'Actinic pre-OJIP (µmol)', group: 'acquisition', editable: true },
        { key: 'actinic_preaccl_wavelength_nm', label: 'Actinic pre-OJIP λ (nm)', group: 'acquisition', editable: true },
        { key: 'preaccl_temperature',         label: 'Pre-accl. temp (°C)',      group: 'acquisition', editable: true },
        { key: 'preaccl_co2',                 label: 'Pre-accl. CO₂ (%)',        group: 'acquisition', editable: true },
    ];

    // Per-curve fields available as filename-token targets
    const TOKEN_FIELDS = [
        'sample_id', 'bio_rep', 'tech_rep', 'treatment_label',
        'timepoint', 'batch_id', 'temperature', 'timestamp', 'gain',
    ];

    // ── Provenance config (left-border stripe + corner glyph) ─────────────────
    const PROV = {
        typed:         { color: '#00a884', glyph: '✎', title: 'Typed by user'               },
        from_header:   { color: '#0984e3', glyph: '≡', title: 'From file header'             },
        from_filename: { color: '#7d5fe6', glyph: '⌗', title: 'From filename token'          },
        inherited:     { color: '#0f9b8e', glyph: '↧', title: 'Inherited from tier form'     },
        computed:      { color: '#e07a4e', glyph: '#', title: 'Auto-computed'                },
        missing:       { color: '#e0564a', glyph: '+', title: 'Required — value missing'     },
    };

    // ── Empty-field highlight (injected once) ──────────────────────────────────
    (function _injectEmptyFieldStyle() {
        const s = document.createElement('style');
        s.textContent = '.ann-field-empty { background-color: #fff0f0 !important; }';
        document.head.appendChild(s);
    })();

    // ── Utilities ─────────────────────────────────────────────────────────────
    function _eid(id) { return document.getElementById(id); }

    function _esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function _fmt(v) {
        if (v === null || v === undefined || v === '') return null;
        // Use Number() (strict) not parseFloat() (lenient). parseFloat('3f9e28c') = 3,
        // which would silently truncate hex curve_ids that start with decimal digits.
        // Number('3f9e28c') = NaN, so the full string is returned unchanged.
        const n = Number(v);
        if (!isNaN(n) && String(v).trim() !== '')
            return n.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        return String(v);
    }

    function _val(id) {
        const el = _eid(id);
        return el ? el.value.trim() : '';
    }

    // ── Empty-field highlighting ────────────────────────────────────────────────
    /** The tab pane IDs that contain annotation form fields. */
    const _TIER_PANE_IDS = ['tab-inv', 'tab-study', 'tab-treat', 'tab-fluor'];

    /** Toggle .ann-field-empty on a single control. */
    function _markField(el) {
        if (!el || el.type === 'hidden') return;
        // Skip fields inside the token table (dynamic, not annotation metadata)
        if (el.closest('#ann-token-table')) return;
        const empty = (el.value || '').trim() === '';
        el.classList.toggle('ann-field-empty', empty);
    }

    /** Scan all form controls in the tier panes and toggle highlight. */
    function _highlightEmptyFields() {
        _TIER_PANE_IDS.forEach(pid => {
            const pane = _eid(pid);
            if (!pane) return;
            pane.querySelectorAll('input, select, textarea').forEach(_markField);
        });
        _updatePrefilledBtn();
    }

    /** Enable/disable the pre-filled XLSX download button based on whether
     *  any tier field contains user-entered data. */
    function _updatePrefilledBtn() {
        const btn = _eid('ann-download-prefilled-btn');
        if (!btn) return;
        let hasData = false;
        for (const pid of _TIER_PANE_IDS) {
            const pane = _eid(pid);
            if (!pane) continue;
            for (const el of pane.querySelectorAll('input, select, textarea')) {
                if (el.type === 'hidden') continue;
                if (el.closest('#ann-token-table')) continue;
                if ((el.value || '').trim() !== '') { hasData = true; break; }
            }
            if (hasData) break;
        }
        btn.disabled = !hasData;
        btn.title = hasData ? 'Download XLSX template pre-filled with current metadata'
                            : 'Fill in metadata fields first';
    }

    /** Attach delegated input/change listeners for real-time updates. */
    function _setupEmptyFieldListeners() {
        const _onFieldChange = e => {
            if (e.target.matches('input, select, textarea')) {
                _markField(e.target);
                _updatePrefilledBtn();
            }
        };
        _TIER_PANE_IDS.forEach(pid => {
            const pane = _eid(pid);
            if (!pane) return;
            pane.addEventListener('input',  _onFieldChange);
            pane.addEventListener('change', _onFieldChange);
        });
    }

    // ── Sample-type helpers ───────────────────────────────────────────────────
    function _isLiquid(st) { return (st || '').includes('liquid'); }
    function _isPlant(st)  { return (st || '').includes('plant'); }
    function _isLeaf(st)   { return (st || '').includes('leaf') || (st || '').includes('disc'); }

    function _colVisible(col) {
        if (col.sticky) return true;
        const g  = col.group;
        const sc = col.sample_cond || '';
        // Group toggle
        if (g && _groupVis[g] === false) return false;
        // Sample-type conditional
        if (sc === 'liquid_culture' && !_isLiquid(_sampleType)) return false;
        if (sc === 'plant'          && !_isPlant(_sampleType))  return false;
        if (sc === 'plant_or_leaf'  && !(_isPlant(_sampleType) || _isLeaf(_sampleType))) return false;
        return true;
    }

    function _visibleCols() { return COLS.filter(_colVisible); }

    // ── Banner helpers ────────────────────────────────────────────────────────
    function _showError(msg) {
        const el = _eid('ann-error-banner');
        if (!el) return;
        el.textContent = msg;
        el.classList.remove('d-none');
    }

    function _clearError() {
        const el = _eid('ann-error-banner');
        if (!el) return;
        el.textContent = '';
        el.classList.add('d-none');
    }

    function _showWarnings(msgs) {
        if (!msgs || !msgs.length) return;
        const el = _eid('ann-warning-banner');
        if (!el) return;
        el.innerHTML = '<strong>Warnings:</strong><ul class="mb-0 mt-1">' +
            msgs.map(m => `<li>${_esc(m)}</li>`).join('') + '</ul>';
        el.classList.remove('d-none');
    }

    function _clearWarnings() {
        const el = _eid('ann-warning-banner');
        if (!el) return;
        el.innerHTML = '';
        el.classList.add('d-none');
    }

    // ── Toast ─────────────────────────────────────────────────────────────────
    let _toastTimer = null;

    function _toast(msg) {
        let el = _eid('ann-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ann-toast';
            el.style.cssText = [
                'position:fixed', 'bottom:24px', 'left:50%',
                'transform:translateX(-50%)',
                'background:#1a2c35', 'color:#fff',
                'padding:8px 20px', 'border-radius:20px',
                'font-size:.85rem', 'z-index:9999',
                'pointer-events:none', 'opacity:0',
                'transition:opacity .2s',
            ].join(';');
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        if (_toastTimer) clearTimeout(_toastTimer);
        _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2800);
    }

    // ── Fluorometer field count chip ──────────────────────────────────────────
    function updateFluorCount() {
        const chip = _eid('fluor-fields-count');
        if (!chip) return;
        const total = document.querySelectorAll('.ann-fluor-field').length;
        const filled = Array.from(document.querySelectorAll('.ann-fluor-field'))
            .filter(el => el.value.trim() !== '').length;
        chip.textContent = `${filled} / ${total} fields set`;
        chip.className = filled === total ? 'badge badge-success' :
                         filled > 0      ? 'badge badge-info' :
                                           'badge badge-secondary';
    }

    // ── Sample-type propagation ───────────────────────────────────────────────
    function onSampleTypeChange(val) {
        _sampleType = val || '';
        _updateStudyFieldVisibility();
        if (_rows.length) _renderGrid();
    }

    /** Auto-calculate sample density from culture density ÷ dilution factor. */
    function recalcSampleDensity() {
        const factor = parseFloat(document.getElementById('study-sample_dilution_factor').value);
        if (!factor || factor <= 0) return;
        const pairs = [
            ['study-culture_density_chla', 'study-sample_density_chla'],
            ['study-culture_density_cdw',  'study-sample_density_cdw'],
            ['study-culture_density_od',   'study-sample_density_od'],
        ];
        pairs.forEach(([cId, sId]) => {
            const cv = parseFloat(document.getElementById(cId).value);
            if (!isNaN(cv) && cv >= 0) {
                const result = cv / factor;
                // Show up to 4 significant figures, strip trailing zeros
                document.getElementById(sId).value =
                    parseFloat(result.toPrecision(4));
            }
        });
        // Mirror OD wavelength (same measurement, just different sample)
        const wl = document.getElementById('study-culture_density_od_wl').value;
        if (wl) document.getElementById('study-sample_density_od_wl').value = wl;
    }

    /** Show/hide study-tier form fields based on sample_type. */
    function _updateStudyFieldVisibility() {
        const hasType = !!_sampleType;
        const isLiq   = _isLiquid(_sampleType);
        const isPlant = _isPlant(_sampleType) || _isLeaf(_sampleType);

        // Show/hide the entire study fields block
        document.querySelectorAll('.ann-study-fields').forEach(el => {
            el.style.display = hasType ? '' : 'none';
        });
        // Hide the hint once a type is selected
        document.querySelectorAll('.ann-study-hint').forEach(el => {
            el.style.display = hasType ? 'none' : '';
        });
        // Liquid culture section
        document.querySelectorAll('.ann-study-liquid').forEach(el => {
            el.style.display = isLiq ? '' : 'none';
        });
        // Plant section
        document.querySelectorAll('.ann-study-plant').forEach(el => {
            el.style.display = isPlant ? '' : 'none';
        });
        // Contextual placeholder for sub-strain / cultivar
        const subInput = _eid('study-sub_strain_cultivar');
        if (subInput) {
            if (isLiq)        subInput.placeholder = 'e.g. glucose tolerant (GT), motile';
            else if (isPlant) subInput.placeholder = 'e.g. Col-0, Landsberg erecta';
            else              subInput.placeholder = 'Sub-strain or cultivar name';
        }
    }

    // ── Instrument change ─────────────────────────────────────────────────────
    const _DETECTOR_FILTER_DEFAULTS = {
        'aquapen':       '667–750 nm bandpass',
        'fluorpen':      '667–750 nm bandpass',
        'fl6000':        'RG695 (690–730 nm)',
        'handy pea':     'RG9 (>700 nm)',
        'pocket pea':    'RG9 (>700 nm)',
        'multi-color-pam': 'RG665 (>665 nm) + SP710 (<710 nm)',
        'dual pam':      'RG665 (>665 nm) + SP710 (<710 nm)',
        'junior-pam':    'RG665 (>665 nm)',
    };
    function onInstrumentChange(val) {
        // Auto-fill detector bandpass filter from instrument defaults
        const filterEl = _eid('fluor-detector_bandpass_filter');
        if (filterEl) {
            const v = (val || '').toLowerCase();
            for (const [key, dflt] of Object.entries(_DETECTOR_FILTER_DEFAULTS)) {
                if (v.includes(key)) { filterEl.value = dflt; break; }
            }
        }
        updateFluorCount();
    }

    // ── Growth light type — show/hide mono vs white sub-fields ───────────────
    function onGrowthLightTypeChange(val) {
        const isMono  = val === 'monochromatic LED';
        const isWhite = val === 'white LED' || val === 'fluorescent lamp' || val === 'metal halide';
        const isNote  = val === 'multi-color / broadband LED' || val === 'other';
        document.querySelectorAll('.ann-light-mono').forEach(el => {
            if (isMono) el.classList.remove('d-none'); else el.classList.add('d-none');
        });
        document.querySelectorAll('.ann-light-white').forEach(el => {
            if (isWhite) el.classList.remove('d-none'); else el.classList.add('d-none');
        });
        document.querySelectorAll('.ann-light-note').forEach(el => {
            if (isNote) el.classList.remove('d-none'); else el.classList.add('d-none');
        });
    }

    // ── Instrument auto-detect display ─────────────────────────────────────
    /** Set the instrument select and trigger measuring-light visibility. */
    function _updateInstrumentDisplay(instrumentName) {
        const sel = _eid('fluor-instrument');
        if (sel) sel.value = instrumentName || '';
        onInstrumentChange(instrumentName || '');
    }

    /** Detect instrument from grid rows and set the select.
     *  AquaPen and FluorPen share the same file format, so they are treated
     *  as compatible: if the user has already chosen one, the other won't
     *  override it on subsequent uploads. */
    function _detectInstrumentFromRows() {
        if (!_rows.length) return;
        const instruments = new Set(
            _rows.map(r => (r.instrument || {}).value).filter(Boolean)
        );
        if (instruments.size === 1) {
            const detected = [...instruments][0];
            const sel      = _eid('fluor-instrument');
            const current  = sel ? sel.value : '';
            // "Aquapen" and "FluorPen" share one file format — don't override
            // a user's FluorPen choice when AquaPen format is detected.
            const aqFpFamily  = /aquapen|fluorpen/i;
            const compatible  = aqFpFamily.test(detected) && aqFpFamily.test(current);
            if (!current || !compatible) {
                _updateInstrumentDisplay(detected);
            }
        } else if (instruments.size > 1) {
            _updateInstrumentDisplay('');
            _showWarnings(['Multiple instruments detected across files: ' +
                [...instruments].join(', ') + '. Please verify the Fluorometer setting.']);
        }
    }

    // ── NCBI Taxonomy typeahead ──────────────────────────────────────────────
    // Predefined organisms (fallback when NCBI is unreachable)
    const _PRESET_ORGANISMS = [
        { taxid: 1148, name: 'Synechocystis sp. PCC 6803', rank: 'strain', division: 'cyanobacteria' },
        { taxid: 1140, name: 'Synechococcus sp. PCC 7942', rank: 'strain', division: 'cyanobacteria' },
        { taxid: 1163, name: 'Anabaena sp. PCC 7120',      rank: 'strain', division: 'cyanobacteria' },
        { taxid: 197221, name: 'Thermosynechococcus elongatus BP-1', rank: 'strain', division: 'cyanobacteria' },
        { taxid: 3055, name: 'Chlamydomonas reinhardtii',  rank: 'species', division: 'green algae' },
        { taxid: 3077, name: 'Chlorella vulgaris',          rank: 'species', division: 'green algae' },
        { taxid: 3702, name: 'Arabidopsis thaliana',        rank: 'species', division: 'eudicots' },
        { taxid: 3562, name: 'Spinacia oleracea',           rank: 'species', division: 'eudicots' },
    ];

    function _showDropdown(dropdown) { dropdown.style.display = 'block'; }
    function _hideDropdown(dropdown) { dropdown.style.display = 'none';  }

    function _renderOrganismResults(results, dropdown) {
        dropdown.innerHTML = results.map(r =>
            `<a href="#" data-taxid="${r.taxid}" data-name="${_esc(r.name)}"
                style="display:block;padding:5px 12px;font-size:.85rem;color:#212529;
                       text-decoration:none;cursor:pointer;border-bottom:1px solid #f0f0f0;"
                onmouseover="this.style.background='#e8f0fe'"
                onmouseout="this.style.background='#fff'">
                <strong>${_esc(r.name)}</strong>
                <small style="color:#6c757d;margin-left:6px;">[${_esc(r.rank)}] taxID:${r.taxid}</small>
            </a>`
        ).join('');
        _showDropdown(dropdown);
        // Click handlers
        dropdown.querySelectorAll('a').forEach(a => {
            a.addEventListener('click', e => {
                e.preventDefault();
                const inp = _eid('study-organism');
                const hid = _eid('study-organism-taxid');
                if (inp) inp.value = a.dataset.name;
                if (hid) hid.value = a.dataset.taxid;
                _hideDropdown(dropdown);
            });
        });
    }

    function searchOrganism(query) {
        if (_ncbiTimer) clearTimeout(_ncbiTimer);
        _hideOrganismBadge();
        const dropdown = _eid('study-organism-dropdown');
        if (!dropdown) return;

        if (query.length < 2) { _hideDropdown(dropdown); return; }

        // Immediate: filter preset list
        const q = query.toLowerCase();
        const presetMatches = _PRESET_ORGANISMS.filter(o =>
            o.name.toLowerCase().includes(q)
        );
        if (presetMatches.length) {
            _renderOrganismResults(presetMatches, dropdown);
        }

        // Debounced: NCBI API search (needs 3+ chars)
        if (query.length < 3) return;
        _ncbiTimer = setTimeout(() => {
            fetch('/api/fluorescence_annotation/ncbi_taxon?q=' + encodeURIComponent(query))
                .then(r => {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(results => {
                    if (!Array.isArray(results) || !results.length) {
                        // Keep preset results if NCBI returned nothing
                        if (!presetMatches.length) _hideDropdown(dropdown);
                        return;
                    }
                    // Merge: NCBI results first, then presets not already in NCBI results
                    const ncbiIds = new Set(results.map(r => r.taxid));
                    const merged = [
                        ...results,
                        ...presetMatches.filter(p => !ncbiIds.has(p.taxid)),
                    ];
                    _renderOrganismResults(merged, dropdown);
                })
                .catch(err => {
                    console.warn('[ANN] NCBI search failed:', err);
                    // Preset results remain visible as fallback
                });
        }, 350);
    }

    /** Show / hide the organism match badge after auto-resolve. */
    function _showOrganismBadge(best, raw) {
        const badge = _eid('study-organism-match-badge');
        if (!badge) return;

        if (!best) {
            // No match at all
            badge.style.display = 'block';
            badge.innerHTML =
                `<span class="badge badge-danger" style="font-size:.82rem;font-weight:500;">` +
                `<i class="fa fa-exclamation-triangle mr-1"></i>No match found for "${_esc(raw)}" &mdash; ` +
                `please use the NCBI search above or enter the full scientific name</span>`;
            return;
        }

        const pct = Math.round(best.score * 100);
        badge.style.display = 'block';

        if (pct >= 80) {
            badge.innerHTML =
                `<span class="badge badge-success" style="font-size:.82rem;font-weight:500;">` +
                `<i class="fa fa-check mr-1"></i>Matched: ${_esc(best.name)} ` +
                `(taxID ${best.taxid}) &mdash; score ${pct}%</span>`;
        } else if (pct >= 50) {
            badge.innerHTML =
                `<span class="badge badge-warning" style="font-size:.82rem;font-weight:500;">` +
                `<i class="fa fa-exclamation-circle mr-1"></i>Partial match: ${_esc(best.name)} ` +
                `(taxID ${best.taxid}) &mdash; score ${pct}% &mdash; please verify</span>`;
        } else {
            badge.innerHTML =
                `<span class="badge badge-danger" style="font-size:.82rem;font-weight:500;">` +
                `<i class="fa fa-exclamation-triangle mr-1"></i>Low match: ${_esc(best.name)} ` +
                `(taxID ${best.taxid}) &mdash; score ${pct}% &mdash; please verify or search NCBI</span>`;
        }
    }

    /** Hide the organism badge (e.g. when the user edits the field manually). */
    function _hideOrganismBadge() {
        const badge = _eid('study-organism-match-badge');
        if (badge) { badge.style.display = 'none'; badge.innerHTML = ''; }
    }

    /**
     * After XLSX upload populates the organism text field, try to resolve it
     * to a canonical name + taxID.  Auto-selects if there is a single
     * high-confidence match; otherwise shows the dropdown for the user.
     * Shows a colour-coded badge with the match quality.
     */
    function _resolveOrganismAfterUpload() {
        const inp = _eid('study-organism');
        const hid = _eid('study-organism-taxid');
        const dropdown = _eid('study-organism-dropdown');
        if (!inp || !dropdown) return;

        _hideOrganismBadge();
        // Clear stale taxID so every upload gets a fresh resolve
        if (hid) hid.value = '';

        const raw = (inp.value || '').trim();
        if (!raw || raw.length < 2) return;

        const q = raw.toLowerCase();
        const tokens = q.split(/[\s.]+/).filter(t => t.length > 1);

        // Score a candidate: fraction of query tokens found in the name
        const _score = (name) => {
            const nl = name.toLowerCase();
            const hits = tokens.filter(t => nl.includes(t));
            return tokens.length ? hits.length / tokens.length : 0;
        };

        // 1. Check presets first
        const scored = _PRESET_ORGANISMS
            .map(o => ({ ...o, score: _score(o.name) }))
            .filter(o => o.score > 0)
            .sort((a, b) => b.score - a.score);

        if (scored.length && scored[0].score >= 0.8 &&
            (scored.length === 1 || scored[0].score > scored[1].score)) {
            inp.value = scored[0].name;
            if (hid) hid.value = scored[0].taxid;
            _showOrganismBadge(scored[0], raw);
            return;
        }

        // 2. Fall back to NCBI API
        if (raw.length < 3) {
            if (scored.length) {
                _renderOrganismResults(scored, dropdown);
                _showOrganismBadge(scored[0], raw);
            } else {
                _showOrganismBadge(null, raw);
            }
            return;
        }

        fetch('/api/fluorescence_annotation/ncbi_taxon?q=' + encodeURIComponent(raw))
            .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(results => {
                if (!Array.isArray(results)) results = [];

                const ncbiScored = results
                    .map(r => ({ ...r, score: _score(r.name) }))
                    .sort((a, b) => b.score - a.score);

                const ncbiIds = new Set(ncbiScored.map(r => r.taxid));
                const merged = [
                    ...ncbiScored,
                    ...scored.filter(p => !ncbiIds.has(p.taxid)),
                ];

                if (!merged.length) {
                    _showOrganismBadge(null, raw);
                    return;
                }

                if (merged[0].score >= 0.8 &&
                    (merged.length === 1 || merged[0].score > merged[1].score)) {
                    inp.value = merged[0].name;
                    if (hid) hid.value = merged[0].taxid;
                    _showOrganismBadge(merged[0], raw);
                    return;
                }

                // Ambiguous — show dropdown + badge for the best candidate
                _renderOrganismResults(merged, dropdown);
                _showOrganismBadge(merged[0], raw);
                inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
            })
            .catch(err => {
                console.warn('[ANN] Organism auto-resolve failed:', err);
                if (scored.length) {
                    _renderOrganismResults(scored, dropdown);
                    _showOrganismBadge(scored[0], raw);
                } else {
                    _showOrganismBadge(null, raw);
                }
            });
    }

    // Close organism dropdown on outside click
    function _setupOrganismDropdown() {
        document.addEventListener('click', e => {
            const dropdown = _eid('study-organism-dropdown');
            const inp = _eid('study-organism');
            if (dropdown && !dropdown.contains(e.target) && e.target !== inp) {
                _hideDropdown(dropdown);
            }
        });
    }

    // ── Schema fetch ──────────────────────────────────────────────────────────
    function _fetchSchema() {
        fetch('/api/fluorescence_annotation/schema')
            .then(r => r.json())
            .then(data => { _schema = data; })
            .catch(e => console.warn('[ANN] Schema fetch failed:', e));
    }

    // ── Tier form collection ──────────────────────────────────────────────────
    function _collectTiers() {
        return {
            investigation: {
                project_title:        _val('inv-project_title'),
                contact_name:         _val('inv-contact_name'),
                contact_email:        _val('inv-contact_email'),
                institution:          _val('inv-institution'),
                contributor_namespace: _val('inv-contributor_namespace'),
                license:              _val('inv-license'),
                project_description:  _val('inv-project_description'),
            },
            study: {
                organism:              _val('study-organism'),
                organism_taxid:        _val('study-organism-taxid'),
                genotype:              _val('study-genotype'),
                sub_strain_cultivar:   _val('study-sub_strain_cultivar'),
                medium:                _val('study-medium'),
                medium_modification:   _val('study-medium_modification'),
                medium_ph:             _val('study-medium_ph'),
                medium_buffer_type:    _val('study-medium_buffer_type'),
                medium_buffer_concentration: _val('study-medium_buffer_concentration'),
                trophic_mode:          _val('study-trophic_mode'),
                cultivator_type:       _val('study-cultivator_type'),
                cultivation_mode:      _val('study-cultivation_mode'),
                culture_density_chla:  _val('study-culture_density_chla'),
                culture_density_cdw:   _val('study-culture_density_cdw'),
                culture_density_od:    _val('study-culture_density_od'),
                culture_density_od_wl: _val('study-culture_density_od_wl'),
                culture_density_other:      _val('study-culture_density_other'),
                culture_density_other_unit: _val('study-culture_density_other_unit'),
                sample_density_chla:   _val('study-sample_density_chla'),
                sample_density_cdw:    _val('study-sample_density_cdw'),
                sample_density_od:     _val('study-sample_density_od'),
                sample_density_od_wl:  _val('study-sample_density_od_wl'),
                sample_dilution_factor:_val('study-sample_dilution_factor'),
                culture_age:               _val('study-culture_age'),
                culture_age_unit:          _val('study-culture_age_unit'),
                photoperiod:               _val('study-photoperiod'),
                growth_facility:           _val('study-growth_facility'),
                growth_facility_detail:    _val('study-growth_facility_detail'),
                substrate:                 _val('study-substrate'),
                pot_size:                  _val('study-pot_size'),
                humidity:                  _val('study-humidity'),
                plant_age:                 _val('study-plant_age'),
                plant_age_unit:            _val('study-plant_age_unit'),
                watering_regime:           _val('study-watering_regime'),
                fertilization:             _val('study-fertilization'),
                dev_stage:                 _val('study-dev_stage'),
                plant_organ:               _val('study-plant_organ'),
                leaf_position:             _val('study-leaf_position'),
                leaf_surface:              _val('study-leaf_surface'),
                leaf_age:                  _val('study-leaf_age'),
                meas_position:             _val('study-meas_position'),
                growth_light_intensity:    _val('study-growth_light_intensity'),
                growth_light_type:         _val('study-growth_light_type'),
                growth_light_peak_wl:      _val('study-growth_light_peak_wl'),
                growth_light_peak_width:   _val('study-growth_light_peak_width'),
                growth_light_color_cat:    _val('study-growth_light_color_cat'),
                growth_light_note:         _val('study-growth_light_note'),
                growth_temperature:        _val('study-growth_temperature'),
                growth_co2:                _val('study-growth_co2'),
                sample_type:               _val('study-sample_type'),
            },
            fluor: {
                instrument:              _val('fluor-instrument'),
                fo_timing:               _val('fluor-fo_timing'),
                acclimation_min:         _val('fluor-acclimation_min'),
                sat_pulse_intensity:     _val('fluor-sat_pulse_intensity'),
                sat_pulse_wavelength_nm: _val('fluor-sat_pulse_wavelength_nm'),
                sat_pulse_duration_s:    _val('fluor-sat_pulse_duration_s'),
                meas_light_intensity:         _val('fluor-meas_light_intensity'),
                meas_light_wavelength_nm:     _val('fluor-meas_light_wavelength_nm'),
                detector_gain:               _val('fluor-detector_gain'),
                damping:                     _val('fluor-damping'),
                detector_bandpass_filter:     _val('fluor-detector_bandpass_filter'),
                sample_holder_type:          _val('fluor-sample_holder_type'),
                stirring:                    _val('fluor-stirring'),
                actinic_preaccl_intensity:    _val('fluor-actinic_preaccl_intensity'),
                actinic_preaccl_wavelength_nm: _val('fluor-actinic_preaccl_wavelength_nm'),
                preaccl_temperature:          _val('fluor-preaccl_temperature'),
                preaccl_co2:                  _val('fluor-preaccl_co2'),
            },
            token_dict: _collectTokenDict(),
            treatment_templates: _collectTreatmentTemplates(),
        };
    }

    /** Restore tier forms from a loaded bundle's tier_defaults object. */
    function _populateTierForms(td) {
        if (!td) return;
        const inv   = td.investigation || {};
        const study = td.study         || {};
        const fluor = td.fluor || td.assay || {}; // back-compat
        const tok   = td.token_dict    || {};

        const _set = (id, val) => {
            const el = _eid(id);
            if (el && val !== undefined && val !== '') el.value = val;
        };

        ['project_title','contact_name','contact_email','institution',
         'contributor_namespace','license','project_description'].forEach(k => _set('inv-'+k, inv[k]));

        ['organism','genotype','sub_strain_cultivar','medium','medium_modification',
         'medium_ph','medium_buffer_type','medium_buffer_concentration',
         'trophic_mode','cultivator_type','cultivation_mode',
         'culture_density_chla','culture_density_cdw','culture_density_od',
         'culture_density_od_wl','culture_density_other','culture_density_other_unit',
         'sample_density_chla','sample_density_cdw','sample_density_od',
         'sample_density_od_wl','sample_dilution_factor',
         'culture_age','culture_age_unit',
         'photoperiod',
         'growth_facility','growth_facility_detail','substrate','pot_size','humidity',
         'plant_age','plant_age_unit','watering_regime','fertilization',
         'dev_stage','plant_organ','leaf_position','leaf_surface','leaf_age','meas_position',
         'growth_light_intensity','growth_light_type',
         'growth_light_peak_wl','growth_light_peak_width',
         'growth_light_color_cat','growth_light_note',
         'growth_temperature','growth_co2',
         'sample_type'].forEach(k => _set('study-'+k, study[k]));
        onGrowthLightTypeChange(study.growth_light_type || '');
        if (study.organism_taxid) _set('study-organism-taxid', study.organism_taxid);

        ['fo_timing','acclimation_min','sat_pulse_intensity','sat_pulse_wavelength_nm',
         'sat_pulse_duration_s','meas_light_intensity','meas_light_wavelength_nm',
         'detector_gain','damping','detector_bandpass_filter',
         'sample_holder_type','stirring',
         'actinic_preaccl_intensity','actinic_preaccl_wavelength_nm',
         'preaccl_temperature','preaccl_co2'].forEach(k => _set('fluor-'+k, fluor[k]));

        if (study.sample_type) {
            _sampleType = study.sample_type;
            const stEl = _eid('study-sample_type');
            if (stEl) stEl.value = study.sample_type;
        }
        _updateStudyFieldVisibility();

        // Instrument: set hidden input + display (read-only, auto-detected)
        _updateInstrumentDisplay(fluor.instrument || '');

        if (tok.separator) { const el = _eid('ann-token-sep'); if (el) el.value = tok.separator; }
        const tbody = _eid('ann-token-body');
        if (tbody) {
            tbody.innerHTML = '';
            if (Array.isArray(tok.tokens)) tok.tokens.forEach(_addTokenRow);
        }

        // Treatment templates
        _treatmentTemplates = td.treatment_templates || [];
        _renderTreatmentTable();

        updateFluorCount();
        _highlightEmptyFields();
    }

    // ── Treatment templates ─────────────────────────────────────────────────

    // Stress type → default unit
    const _STRESS_UNITS = {
        'high light':            '\u00b5mol photons m\u207b\u00b2 s\u207b\u00b9',
        'low light':             '\u00b5mol photons m\u207b\u00b2 s\u207b\u00b9',
        'heat':                  '\u00b0C',
        'cold':                  '\u00b0C',
        'UV-B':                  '\u00b5W cm\u207b\u00b2',
        'salt stress':           'mM NaCl',
        'drought':               '% field capacity',
        'nitrogen starvation':   '',
        'phosphorus starvation': '',
        'sulfur starvation':     '',
        'iron starvation':       '',
        'other':                 '',
    };

    function _onStressTypeChange(sel) {
        const tr = sel.closest('tr');
        const unitSel = tr.querySelectorAll('select')[1]; // 2nd select in row = unit
        const unit = _STRESS_UNITS[sel.value] || '';
        if (unit && unitSel) unitSel.value = unit;
    }

    function _delBtn() {
        return `<td><button class="btn btn-sm btn-outline-danger"
                    onclick="ANN.removeTreatmentRow(this)" title="Remove">
              <i class="fa fa-times"></i></button></td>`;
    }

    function addChemTreatmentRow(tmpl) {
        tmpl = tmpl || {};
        const tbody = _eid('ann-chem-treatment-body');
        if (!tbody) return;
        const chemOpts = ['','control','DCMU','methyl viologen','KCN',
            'glycolaldehyde','DBMIB','hydroxylamine','lincomycin',
            'atrazine','bentazon','paraquat','diuron','other']
            .map(v => `<option value="${_esc(v)}"${tmpl.chem_treatment===v?' selected':''}>${_esc(v||'— select —')}</option>`)
            .join('');
        const unitOpts = ['','\u00b5M','mM','M','mg L\u207b\u00b9',
            '\u00b5g L\u207b\u00b9','ng L\u207b\u00b9','%','other']
            .map(v => `<option value="${_esc(v)}"${tmpl.chem_unit===v?' selected':''}>${v||'— select —'}</option>`)
            .join('');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.treatment_label||'')}" placeholder="e.g. DCMU 10 µM 2h"></td>
          <td><select class="form-control form-control-sm">${chemOpts}</select></td>
          <td><input type="number" class="form-control form-control-sm"
               value="${_esc(tmpl.chem_dose||'')}" placeholder="10" step="any" min="0"></td>
          <td><select class="form-control form-control-sm">${unitOpts}</select></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.chem_duration||'')}" placeholder="e.g. 2 h"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.chem_detail||'')}" placeholder="additional detail"></td>
          ${_delBtn()}`;
        tbody.appendChild(tr);
        _highlightEmptyFields();
    }

    function addStressTreatmentRow(tmpl) {
        tmpl = tmpl || {};
        const tbody = _eid('ann-stress-treatment-body');
        if (!tbody) return;
        const stressOpts = ['','high light','low light','heat','cold','UV-B',
            'nitrogen starvation','phosphorus starvation','sulfur starvation',
            'iron starvation','salt stress','drought','other']
            .map(v => `<option value="${_esc(v)}"${tmpl.stress_treatment===v?' selected':''}>${_esc(v||'— select —')}</option>`)
            .join('');
        const stressUnitVals = ['\u00b5mol photons m\u207b\u00b2 s\u207b\u00b9',
            '\u00b0C','mM NaCl','\u00b5W cm\u207b\u00b2',
            '% field capacity','% RH','other',''];
        const unitOpts = stressUnitVals
            .map(v => `<option value="${_esc(v)}"${tmpl.stress_unit===v?' selected':''}>${v||'— select —'}</option>`)
            .join('');
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.treatment_label||'')}" placeholder="e.g. High light 1 h"></td>
          <td><select class="form-control form-control-sm"
                      onchange="ANN._onStressTypeChange(this)">${stressOpts}</select></td>
          <td><input type="number" class="form-control form-control-sm"
               value="${_esc(tmpl.stress_dose||'')}" placeholder="1000" step="any" min="0"></td>
          <td><select class="form-control form-control-sm">${unitOpts}</select></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.stress_duration||'')}" placeholder="e.g. 30 min"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.stress_detail||'')}" placeholder="additional detail"></td>
          ${_delBtn()}`;
        tbody.appendChild(tr);
        _highlightEmptyFields();
    }

    function addOtherTreatmentRow(tmpl) {
        tmpl = tmpl || {};
        const tbody = _eid('ann-other-treatment-body');
        if (!tbody) return;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.treatment_label||'')}" placeholder="e.g. Control"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.other_treatment||'')}" placeholder="treatment name"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.other_dose||'')}" placeholder="dose / value"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.other_unit||'')}" placeholder="unit"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.other_duration||'')}" placeholder="e.g. 1 h"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tmpl.other_detail||'')}" placeholder="additional detail"></td>
          ${_delBtn()}`;
        tbody.appendChild(tr);
        _highlightEmptyFields();
    }

    // Keep alias for any old callers
    function addTreatmentTemplate(tmpl) { addChemTreatmentRow(tmpl); }

    function removeTreatmentRow(btn) { btn.closest('tr').remove(); }
    function removeTreatmentTemplate(btn) { removeTreatmentRow(btn); } // back-compat

    function _collectTreatmentTemplates() {
        const templates = [];

        // Chemical
        const chemBody = _eid('ann-chem-treatment-body');
        if (chemBody) {
            chemBody.querySelectorAll('tr').forEach(tr => {
                const inp = tr.querySelectorAll('input');
                const sel = tr.querySelectorAll('select');
                const t = {
                    treatment_type:  'chemical',
                    treatment_label: inp[0].value.trim(),
                    chem_treatment:  sel[0] ? sel[0].value : '',
                    chem_dose:       inp[1] ? inp[1].value.trim() : '',
                    chem_unit:       sel[1] ? sel[1].value : '',
                    chem_duration:   inp[2] ? inp[2].value.trim() : '',
                    chem_detail:     inp[3] ? inp[3].value.trim() : '',
                };
                if (t.treatment_label) templates.push(t);
            });
        }

        // Stress
        const stressBody = _eid('ann-stress-treatment-body');
        if (stressBody) {
            stressBody.querySelectorAll('tr').forEach(tr => {
                const inp = tr.querySelectorAll('input');
                const sel = tr.querySelectorAll('select');
                const t = {
                    treatment_type:   'stress',
                    treatment_label:  inp[0].value.trim(),
                    stress_treatment: sel[0] ? sel[0].value : '',
                    stress_dose:      inp[1] ? inp[1].value.trim() : '',
                    stress_unit:      sel[1] ? sel[1].value : '',
                    stress_duration:  inp[2] ? inp[2].value.trim() : '',
                    stress_detail:    inp[3] ? inp[3].value.trim() : '',
                };
                if (t.treatment_label) templates.push(t);
            });
        }

        // Other
        const otherBody = _eid('ann-other-treatment-body');
        if (otherBody) {
            otherBody.querySelectorAll('tr').forEach(tr => {
                const inp = tr.querySelectorAll('input');
                const t = {
                    treatment_type:  'other',
                    treatment_label: inp[0] ? inp[0].value.trim() : '',
                    other_treatment: inp[1] ? inp[1].value.trim() : '',
                    other_dose:      inp[2] ? inp[2].value.trim() : '',
                    other_unit:      inp[3] ? inp[3].value.trim() : '',
                    other_duration:  inp[4] ? inp[4].value.trim() : '',
                    other_detail:    inp[5] ? inp[5].value.trim() : '',
                };
                if (t.treatment_label) templates.push(t);
            });
        }

        _treatmentTemplates = templates;
        return templates;
    }

    function _renderTreatmentTable() {
        const chemBody   = _eid('ann-chem-treatment-body');
        const stressBody = _eid('ann-stress-treatment-body');
        const otherBody  = _eid('ann-other-treatment-body');
        if (chemBody)   chemBody.innerHTML   = '';
        if (stressBody) stressBody.innerHTML = '';
        if (otherBody)  otherBody.innerHTML  = '';

        _treatmentTemplates.forEach(t => {
            const type = t.treatment_type || 'chemical'; // back-compat with old bundles
            if (type === 'stress')       addStressTreatmentRow(t);
            else if (type === 'other')   addOtherTreatmentRow(t);
            else                         addChemTreatmentRow(t);
        });

        // Ensure at least one empty row per section on first render
        if (chemBody   && !chemBody.querySelector('tr'))   addChemTreatmentRow();
        if (stressBody && !stressBody.querySelector('tr')) addStressTreatmentRow();
        if (otherBody  && !otherBody.querySelector('tr'))  addOtherTreatmentRow();
    }

    /** Get treatment template labels for grid dropdown. */
    function _getTreatmentLabels() {
        _collectTreatmentTemplates();
        return _treatmentTemplates
            .map(t => t.treatment_label)
            .filter(l => l);
    }

    /** Apply a treatment template to a row (fills sub-fields). */
    function _applyTreatmentTemplate(row, label) {
        _collectTreatmentTemplates();
        const tmpl = _treatmentTemplates.find(t => t.treatment_label === label);
        if (!tmpl) return;
        const keys = ['chem_treatment','chem_dose','chem_duration',
                      'stress_treatment','stress_dose','stress_duration'];
        keys.forEach(k => {
            if (tmpl[k]) {
                row[k] = { value: tmpl[k], provenance: 'typed' };
            }
        });
    }

    // ── Token table ───────────────────────────────────────────────────────────
    function _addTokenRow(tok) {
        tok = tok || {};
        const tbody = _eid('ann-token-body');
        if (!tbody) return;
        const tr    = document.createElement('tr');
        const flds  = _schema.fields || {};
        const optHtml = TOKEN_FIELDS.map(f => {
            const lbl = flds[f] ? flds[f].label : f;
            return `<option value="${_esc(f)}"${tok.field === f ? ' selected' : ''}>${_esc(lbl)}</option>`;
        }).join('');
        tr.innerHTML = `
          <td><input type="number" class="form-control form-control-sm"
               style="width:60px;" min="0" step="1"
               value="${tok.position !== undefined ? _esc(tok.position) : ''}"></td>
          <td><select class="form-control form-control-sm">${optHtml}</select></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tok.strip_prefix || '')}" placeholder="e.g. rep"></td>
          <td><input type="text" class="form-control form-control-sm"
               value="${_esc(tok.strip_suffix || '')}" placeholder="e.g. h"></td>
          <td><button class="btn btn-sm btn-outline-danger"
                      onclick="ANN.removeToken(this)" title="Remove">
                <i class="fa fa-times"></i></button></td>`;
        tbody.appendChild(tr);
    }

    function addToken()       { _addTokenRow({}); }
    function removeToken(btn) { btn.closest('tr').remove(); }

    function _collectTokenDict() {
        const sepEl = _eid('ann-token-sep');
        const sep   = sepEl ? sepEl.value || '_' : '_';
        const tokens = [];
        const tbody  = _eid('ann-token-body');
        if (!tbody) return { separator: sep, tokens: [] };
        tbody.querySelectorAll('tr').forEach(tr => {
            const inputs = tr.querySelectorAll('input, select');
            const pos    = parseInt(inputs[0].value, 10);
            const fld    = inputs[1].value;
            const pre    = inputs[2].value.trim();
            const suf    = inputs[3].value.trim();
            if (!isNaN(pos) && fld)
                tokens.push({ position: pos, field: fld, strip_prefix: pre, strip_suffix: suf });
        });
        return { separator: sep, tokens };
    }

    // ── Drag-drop & file input ────────────────────────────────────────────────
    function _setupDragDrop() {
        const zone  = _eid('ann-drop-zone');
        const input = _eid('ann-file-input');
        if (zone && input) {
            zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('dragover'); });
            zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
            zone.addEventListener('drop', e => {
                e.preventDefault();
                zone.classList.remove('dragover');
                _setFiles(Array.from(e.dataTransfer.files));
            });
            input.addEventListener('change', function () { _setFiles(Array.from(this.files)); });
        }
        const bundleInput = _eid('ann-bundle-input');
        if (bundleInput) {
            bundleInput.addEventListener('change', function () {
                if (this.files && this.files[0]) loadBundle(this.files[0]);
            });
        }
        // XLSX upload input
        const xlsxInput = _eid('ann-xlsx-input');
        if (xlsxInput) {
            xlsxInput.addEventListener('change', function () {
                if (this.files && this.files[0]) uploadXlsx(this.files[0]);
            });
        }
    }

    function _setFiles(fileArray) {
        _files = fileArray;
        const zone = _eid('ann-drop-zone');
        const list = _eid('ann-file-list');
        const btn  = _eid('ann-ingest-btn');
        if (!zone) return;
        if (_files.length) {
            zone.classList.add('has-files');
            if (list) list.innerHTML =
                `<i class="fa fa-check text-success mr-1"></i>${_files.length} file(s) selected: ` +
                _files.map(f => `<code>${_esc(f.name)}</code>`).join(', ');
            if (btn) btn.disabled = false;
        } else {
            zone.classList.remove('has-files');
            if (list) list.innerHTML = '';
            if (btn) btn.disabled = true;
        }
    }

    // ── Project title validation ──────────────────────────────────────────────
    function _validateProjectTitle() {
        const inp  = _eid('inv-project_title');
        const help = _eid('inv-project_title-help');
        if (!inp) return true;
        const valid = inp.value.trim().length > 0;
        if (help) {
            help.classList.toggle('d-none', valid);
        }
        inp.classList.toggle('is-invalid', !valid);
        return valid;
    }

    // ── Ingest ────────────────────────────────────────────────────────────────
    function ingest() {
        if (!_files.length) return;
        _clearError(); _clearWarnings();
        const spinner = _eid('ann-spinner');
        const btn     = _eid('ann-ingest-btn');
        if (spinner) spinner.classList.remove('d-none');
        if (btn)     btn.disabled = true;

        const fd = new FormData();
        _files.forEach(f => fd.append('fluo_files', f));
        fd.append('tier_json', JSON.stringify(_collectTiers()));

        fetch('/api/fluorescence_annotation/ingest', { method: 'POST', body: fd })
            .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error')); return r.json(); })
            .then(data => {
                if (spinner) spinner.classList.add('d-none');
                if (btn)     btn.disabled = false;
                if (data.status !== 'success' && data.status !== 'ok') {
                    _showError(data.message || 'Ingest failed.'); return;
                }
                _rows     = data.rows || [];
                _bundleId = data.bundle_id || null;
                if (data.warnings && data.warnings.length) _showWarnings(data.warnings);
                // Detect sample_type from first row if not set in form
                if (!_sampleType && _rows.length) {
                    const st = (_rows[0].sample_type || {}).value || '';
                    if (st) _sampleType = st;
                }
                // Auto-detect instrument from ingested files
                _detectInstrumentFromRows();
                _renderGrid();
                const card = _eid('ann-grid-card');
                if (card) { card.classList.remove('d-none'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
            })
            .catch(err => {
                if (spinner) spinner.classList.add('d-none');
                if (btn)     btn.disabled = false;
                _showError('Request failed: ' + err);
            });
    }

    // ── Filtering / sorting helpers ───────────────────────────────────────────
    function _applyFilters(rows) {
        let out = rows;
        if (_filterText) {
            const q = _filterText.toLowerCase();
            out = out.filter(r => {
                return ['filename','sample_id','treatment_label','organism','genotype'].some(k => {
                    const v = ((r[k] || {}).value || '');
                    return String(v).toLowerCase().includes(q);
                });
            });
        }
        if (_filterIncomplete) {
            out = out.filter(r => {
                const sc = ((r.completeness_score || {}).value || 0);
                return parseFloat(sc) < 80;
            });
        }
        if (_filterProv) {
            out = out.filter(r =>
                Object.values(r).some(cell =>
                    typeof cell === 'object' && cell && cell.provenance === _filterProv
                )
            );
        }
        if (_sortKey === 'filename') {
            out = [...out].sort((a, b) => String((a.filename||{}).value||'').localeCompare(String((b.filename||{}).value||'')));
        } else if (_sortKey === 'least_complete') {
            out = [...out].sort((a, b) => parseFloat(((a.completeness_score||{}).value||0)) - parseFloat(((b.completeness_score||{}).value||0)));
        }
        return out;
    }

    // ── Sticky column offset fix ──────────────────────────────────────────────
    // Both _complete (pos 0) and filename (pos 1) are sticky at left:0.
    // After rendering we measure the first column's actual width and shift the
    // second sticky column so they don't overlap on horizontal scroll.
    function _fixStickyOffsets() {
        const thead = _eid('ann-grid-head');
        const tbody = _eid('ann-grid-body');
        if (!thead || !tbody) return;
        const headerTrs = thead.querySelectorAll('tr');
        if (!headerTrs.length) return;
        const colRow = headerTrs[headerTrs.length - 1]; // last tr = column labels
        const allThs = colRow.querySelectorAll('th');
        if (allThs.length < 2) return;

        const col0w = allThs[0].getBoundingClientRect().width;

        // Shift second column header
        allThs[1].style.left = col0w + 'px';
        // Shift second column in group header rows too
        for (let i = 0; i < headerTrs.length - 1; i++) {
            const gths = headerTrs[i].querySelectorAll('th');
            if (gths[0]) { gths[0].style.cssText += 'position:sticky;left:0;z-index:3;'; }
            if (gths[1]) { gths[1].style.cssText += `position:sticky;left:${col0w}px;z-index:3;`; }
        }
        // Shift second column body cells
        tbody.querySelectorAll('tr').forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds[1]) tds[1].style.left = col0w + 'px';
        });
    }

    // ── Grid rendering ────────────────────────────────────────────────────────
    function _renderGrid() {
        const visCols    = _visibleCols();
        const visibleRows = _applyFilters(_rows);
        _renderToolbar();
        _renderHead(visCols);
        _renderBody(visCols, visibleRows);
        requestAnimationFrame(_fixStickyOffsets);
        _updateSummary(_rows);
    }

    // ── Toolbar rendering ─────────────────────────────────────────────────────
    function _renderToolbar() {
        const tb = _eid('ann-toolbar');
        if (!tb) return;
        tb.innerHTML = `
          <div class="d-flex flex-wrap align-items-center" style="gap:8px;">
            <input type="text" class="form-control form-control-sm" id="ann-search"
                   placeholder="Search filename / sample / treatment…"
                   style="max-width:230px;" value="${_esc(_filterText)}">
            <div class="custom-control custom-switch">
              <input type="checkbox" class="custom-control-input" id="ann-incomplete-only"
                     ${_filterIncomplete ? 'checked' : ''}>
              <label class="custom-control-label" for="ann-incomplete-only"
                     style="font-size:.82rem;">Incomplete only</label>
            </div>
            <select class="form-control form-control-sm" id="ann-prov-filter" style="max-width:170px;">
              <option value="">All provenances</option>
              <option value="missing"       ${_filterProv==='missing'       ?'selected':''}>Has missing</option>
              <option value="from_header"   ${_filterProv==='from_header'   ?'selected':''}>Has from-header</option>
              <option value="from_filename" ${_filterProv==='from_filename' ?'selected':''}>Has from-filename</option>
              <option value="typed"         ${_filterProv==='typed'         ?'selected':''}>Has typed</option>
            </select>
            <select class="form-control form-control-sm" id="ann-sort" style="max-width:160px;">
              <option value=""              ${_sortKey===''             ?'selected':''}>Sort: default</option>
              <option value="filename"      ${_sortKey==='filename'     ?'selected':''}>Sort: filename</option>
              <option value="least_complete"${_sortKey==='least_complete'?'selected':''}>Sort: least complete first</option>
            </select>
            <div class="ml-auto d-flex" style="gap:6px;">
              <button class="btn btn-sm ${_groupVis.conditions!==false?'btn-outline-info':'btn-info'}"
                      onclick="ANN.toggleGroup('conditions')"
                      title="Show/hide Conditions columns">Conditions</button>
              <button class="btn btn-sm ${_groupVis.replicate_qc!==false?'btn-outline-warning':'btn-warning'}"
                      onclick="ANN.toggleGroup('replicate_qc')"
                      title="Show/hide Replicate & QC columns">Rep. / QC</button>
            </div>
          </div>`;

        _eid('ann-search').addEventListener('input', e => {
            _filterText = e.target.value.trim();
            _renderGrid();
        });
        _eid('ann-incomplete-only').addEventListener('change', e => {
            _filterIncomplete = e.target.checked;
            _renderGrid();
        });
        _eid('ann-prov-filter').addEventListener('change', e => {
            _filterProv = e.target.value;
            _renderGrid();
        });
        _eid('ann-sort').addEventListener('change', e => {
            _sortKey = e.target.value;
            _renderGrid();
        });
    }

    function toggleGroup(name) {
        _groupVis[name] = (_groupVis[name] === false) ? true : false;
        if (_rows.length) _renderGrid();
    }

    // ── Grid head ─────────────────────────────────────────────────────────────
    function _renderHead(visCols) {
        const thead = _eid('ann-grid-head');
        if (!thead) return;

        // Group header row
        let grpHtml = '';
        let i = 0;
        while (i < visCols.length) {
            const g = visCols[i].group || '';
            let span = 1;
            while (i + span < visCols.length && (visCols[i + span].group || '') === g) span++;
            if (g && COL_GROUPS[g]) {
                const gc = COL_GROUPS[g];
                grpHtml += `<th colspan="${span}" style="background:${gc.color};color:#fff;font-size:.75rem;text-align:center;padding:2px 4px;">${_esc(gc.label)}</th>`;
            } else {
                grpHtml += `<th colspan="${span}" style="background:#f8f9fa;"></th>`;
            }
            i += span;
        }

        // Column header row with fill-down ⤓ button
        let colHtml = '';
        visCols.forEach(c => {
            let fillDown = '';
            if (c.editable && c.key !== '_complete') {
                fillDown = ` <button class="ann-fill-down btn btn-link p-0 ml-1" style="font-size:.75rem;line-height:1;vertical-align:middle;color:#888;" title="Fill down (copy first visible row value to all)" data-key="${_esc(c.key)}" onclick="ANN.fillDown('${_esc(c.key)}')">&#x2913;</button>`;
            }
            let style = 'white-space:nowrap;';
            if (c.sticky) style += 'position:sticky;left:0;background:#fff;z-index:3;';
            colHtml += `<th style="${style}" title="${_esc(c.key)}">${_esc(c.label)}${fillDown}</th>`;
        });

        thead.innerHTML = `<tr>${grpHtml}</tr><tr>${colHtml}</tr>`;
    }

    // ── Grid body ─────────────────────────────────────────────────────────────
    function _renderBody(visCols, visibleRows) {
        const tbody = _eid('ann-grid-body');
        if (!tbody) return;
        let html = '';
        visibleRows.forEach((row, ri) => {
            // Find original index in _rows for editing
            const origIdx = _rows.indexOf(row);
            html += '<tr>';
            visCols.forEach(col => { html += _cellHtml(col, row, origIdx); });
            html += '</tr>';
        });
        tbody.innerHTML = html;

        // Attach edit listeners
        tbody.querySelectorAll('td.ann-cell-editable').forEach(td => {
            td.addEventListener('click', function () {
                _startEdit(this, this.dataset.key, parseInt(this.dataset.ri, 10));
            });
        });
    }

    // ── Cell rendering ────────────────────────────────────────────────────────
    function _cellHtml(col, row, ri) {
        // ── Completeness mini-bar ─────────────────────────────────────────────
        if (col.key === '_complete') {
            const cell  = row.completeness_score;
            const score = (cell && typeof cell === 'object') ? (parseFloat(cell.value) || 0) : 0;
            const color = score >= 80 ? '#00a884' : score >= 50 ? '#e0a12a' : '#e0564a';
            return `<td style="white-space:nowrap;min-width:80px;position:sticky;left:0;background:#fff;z-index:2;">` +
                `<div style="display:inline-block;width:42px;height:6px;background:#dee2e6;border-radius:3px;vertical-align:middle;margin-right:4px;">` +
                `<div style="width:${Math.min(score,100)}%;height:100%;border-radius:3px;background:${color};"></div></div>` +
                `<span style="font-size:.75rem;">${score.toFixed(0)}%</span></td>`;
        }

        const cell = row[col.key];
        const val  = (cell && typeof cell === 'object') ? cell.value      : null;
        const prov = (cell && typeof cell === 'object') ? cell.provenance : null;

        // Detect missing: weighted field with no value
        const fdef    = _schema.fields && _schema.fields[col.key];
        const isMissing = (val === null || val === undefined || val === '') &&
                          fdef && fdef.weight > 0 &&
                          col.key !== '_complete' && col.key !== 'filename';

        const effectiveProv = isMissing ? 'missing' : (prov || null);
        const pc = effectiveProv ? PROV[effectiveProv] : null;

        const borderStyle = pc ? `border-left:3px solid ${pc.color};` : 'border-left:3px solid transparent;';
        const bgStyle     = isMissing ? 'background:#fff5f4;' : '';
        const stickyStyle = col.sticky ? 'position:sticky;left:0;z-index:2;' : '';

        const disp  = _fmt(val);
        // Suppress the 'typed' (✎) glyph on read-only cells — it would imply editability.
        const showGlyph = pc && (col.editable || prov !== 'typed');
        const glyph = showGlyph ? `<span style="float:right;font-size:8px;opacity:.65;user-select:none;" title="${pc.title}">${pc.glyph}</span>` : '';

        if (col.editable) {
            const nullCls = (disp === null || disp === '') ? ' ann-cell-null' : '';
            const display = (disp !== null && disp !== '') ? _esc(disp) : '<span style="color:#e0564a">\u2014</span>';
            return `<td class="ann-cell-editable${nullCls}" style="${borderStyle}${bgStyle}${stickyStyle}" data-key="${_esc(col.key)}" data-ri="${ri}">${glyph}${display}</td>`;
        }

        // Read-only
        const nullCls = (disp === null || disp === '') ? ' ann-cell-null' : '';
        const display = (disp !== null && disp !== '') ? _esc(disp) : '';
        return `<td class="${nullCls}" style="${borderStyle}${bgStyle}${stickyStyle}">${glyph}${display}</td>`;
    }

    // ── Fill-down ⤓ ───────────────────────────────────────────────────────────
    function fillDown(key) {
        const visibleRows = _applyFilters(_rows);
        if (!visibleRows.length) return;
        const srcCell = visibleRows[0][key];
        if (!srcCell || srcCell.value === null || srcCell.value === '') {
            _toast('First row has no value to fill down.');
            return;
        }
        let count = 0;
        visibleRows.forEach(row => {
            row[key] = { value: srcCell.value, provenance: 'typed' };
            // If filling treatment_label, auto-apply template sub-fields
            if (key === 'treatment_label') {
                _applyTreatmentTemplate(row, srcCell.value);
            }
            row.completeness_score = { value: _clientScore(row), provenance: 'computed' };
            count++;
        });
        _renderGrid();
        _toast(`Filled ${count} cells in "${key}" with "${srcCell.value}".`);
    }

    // ── Inline cell editing ───────────────────────────────────────────────────
    function _startEdit(td, key, rowIdx) {
        if (td.querySelector('input, select')) return;

        const cell   = _rows[rowIdx] && _rows[rowIdx][key] || {};
        const curVal = (cell.value !== undefined && cell.value !== null) ? cell.value : '';
        const fdef   = _schema.fields && _schema.fields[key];
        let vocab  = (fdef && fdef.vocab && fdef.vocab.length) ? fdef.vocab : null;
        // Fallback: check column-level vocab (e.g. leaf_surface, leaf_age, meas_position)
        if (!vocab) {
            const colDef = COLS.find(c => c.key === key);
            if (colDef && colDef.vocab && colDef.vocab.length) vocab = colDef.vocab;
        }

        // Special: treatment_label gets its vocab from defined templates
        if (key === 'treatment_label') {
            const labels = _getTreatmentLabels();
            if (labels.length) vocab = labels;
        }

        let inputHtml;
        if (vocab) {
            const opts = [`<option value=""></option>`].concat(
                vocab.map(v => `<option value="${_esc(v)}"${String(curVal) === String(v) ? ' selected' : ''}>${_esc(v)}</option>`)
            ).join('');
            inputHtml = `<select class="form-control form-control-sm p-0" style="min-width:110px;font-size:.8rem;">${opts}</select>`;
        } else {
            inputHtml = `<input type="text" class="form-control form-control-sm p-0" style="min-width:80px;font-size:.8rem;" value="${_esc(curVal)}">`;
        }

        td.innerHTML = inputHtml;
        const input = td.querySelector('input, select');
        input.focus();
        if (input.select) input.select();

        let _committed = false;

        function _commit() {
            if (_committed) return;
            _committed = true;
            const newVal = input.value.trim();
            if (!_rows[rowIdx][key] || typeof _rows[rowIdx][key] !== 'object')
                _rows[rowIdx][key] = {};
            _rows[rowIdx][key].value      = newVal;
            _rows[rowIdx][key].provenance = 'typed';
            // Auto-apply treatment template when treatment_label changes
            if (key === 'treatment_label' && newVal) {
                _applyTreatmentTemplate(_rows[rowIdx], newVal);
            }
            _rows[rowIdx].completeness_score = { value: _clientScore(_rows[rowIdx]), provenance: 'computed' };
            // Propagate sample_type change to column visibility
            if (key === 'sample_type') _sampleType = newVal;
            _renderGrid();
        }

        function _cancelEdit() {
            _committed = true;
            _renderGrid();
        }

        // Find visual position of this cell for keyboard navigation
        const visCols     = _visibleCols();
        const visibleRows = _applyFilters(_rows);
        const colIdx = visCols.findIndex(c => c.key === key);
        const rowPos = visibleRows.findIndex(r => r === _rows[rowIdx]);

        input.addEventListener('blur', _commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                _committed = true;
                const newVal = input.value.trim();
                if (!_rows[rowIdx][key]) _rows[rowIdx][key] = {};
                _rows[rowIdx][key].value      = newVal;
                _rows[rowIdx][key].provenance = 'typed';
                if (key === 'treatment_label' && newVal) _applyTreatmentTemplate(_rows[rowIdx], newVal);
                _rows[rowIdx].completeness_score = { value: _clientScore(_rows[rowIdx]), provenance: 'computed' };
                if (key === 'sample_type') _sampleType = newVal;
                _renderGrid();
                // Move to next row, same column
                setTimeout(() => _activateCellAt(colIdx, rowPos + 1), 0);
            } else if (e.key === 'Tab') {
                e.preventDefault();
                _committed = true;
                const newVal = input.value.trim();
                if (!_rows[rowIdx][key]) _rows[rowIdx][key] = {};
                _rows[rowIdx][key].value      = newVal;
                _rows[rowIdx][key].provenance = 'typed';
                if (key === 'treatment_label' && newVal) _applyTreatmentTemplate(_rows[rowIdx], newVal);
                _rows[rowIdx].completeness_score = { value: _clientScore(_rows[rowIdx]), provenance: 'computed' };
                if (key === 'sample_type') _sampleType = newVal;
                _renderGrid();
                // Move to next column, same row
                setTimeout(() => _activateCellAt(colIdx + 1, rowPos), 0);
            } else if (e.key === 'Escape') {
                _cancelEdit();
            }
        });
    }

    /** Click the cell at (colIdx, rowIdx) in the rendered grid. */
    function _activateCellAt(colIdx, rowIdx) {
        const tbody = _eid('ann-grid-body');
        if (!tbody) return;
        const trs = tbody.querySelectorAll('tr');
        if (rowIdx < 0 || rowIdx >= trs.length) return;
        const editableCols = _visibleCols().filter(c => c.editable);
        if (colIdx < 0 || colIdx >= editableCols.length) return;
        const key = editableCols[colIdx].key;
        const td = trs[rowIdx].querySelector(`td[data-key="${CSS.escape(key)}"]`);
        if (td) td.click();
    }

    /** Recompute completeness score client-side (respects sample_type).
     *  Simple field count: each field = 1, no weights.  Investigation-tier
     *  fields are excluded (not in the per-curve grid). */
    function _clientScore(row) {
        if (!_schema.fields) return 0;
        const st    = ((row.sample_type || {}).value || '') || _sampleType;
        const isLiq = _isLiquid(st);
        const isPlnt= _isPlant(st);
        const isLf  = _isLeaf(st);
        let total = 0, earned = 0;
        Object.entries(_schema.fields).forEach(([k, fd]) => {
            if (fd.tier === 'investigation') return;  // not in per-curve grid
            if (k === 'completeness_score')  return;
            const sc = fd.sample_cond || '';
            if (sc === 'liquid_culture'  && !isLiq)              return;
            if (sc === 'plant'           && !isPlnt)             return;
            if (sc === 'plant_or_leaf'   && !(isPlnt || isLf))   return;
            total += 1;                               // simple count — no weights
            const cell = row[k];
            const v    = (cell && typeof cell === 'object') ? cell.value : null;
            if (v !== null && v !== undefined && v !== '') earned += 1;
        });
        return total > 0 ? parseFloat((100 * earned / total).toFixed(1)) : 0;
    }

    // ── Summary badges ────────────────────────────────────────────────────────
    function _updateSummary(rows) {
        const el = _eid('ann-summary-badges');
        if (!el) return;
        const n = rows.length;
        let scoreSum = 0;
        rows.forEach(r => {
            const sc = r.completeness_score;
            scoreSum += (sc && typeof sc === 'object' && sc.value !== undefined)
                ? parseFloat(sc.value) || 0 : 0;
        });
        const avgScore = n > 0 ? Math.round(scoreSum / n) : 0;
        const color    = avgScore >= 80 ? '#00a884' : avgScore >= 50 ? '#e0a12a' : '#e0564a';
        el.innerHTML =
            `<span class="badge badge-primary">${n} curve${n !== 1 ? 's' : ''}</span> ` +
            `<span class="badge ml-1" style="background:${color};color:#fff;">${avgScore}% avg complete</span>`;
    }

    // ── Bundle download ───────────────────────────────────────────────────────
    function downloadBundle() {
        if (!_rows.length) { _showError('No data to export. Ingest files first.'); return; }
        if (!_validateProjectTitle()) {
            _showError('Project title is required before export.');
            // Switch to Investigation tab
            const tabLink = _eid('tab-inv-lnk');
            if (tabLink) tabLink.click();
            return;
        }
        _clearError();
        const payload = { bundle_id: _bundleId, rows: _rows, tier_defaults: _collectTiers() };
        if (typeof window._getOJIPCurvesForBundle === 'function') {
            const ojipCurves = window._getOJIPCurvesForBundle();
            if (ojipCurves) {
                // Build stem → {curve_id, filename} map from annotation rows.
                // Use original stem as-is; the backend normalises both sides when matching.
                const stemToMeta = {};
                for (const row of _rows) {
                    const fname = (row.filename || {}).value || '';
                    const cid   = (row.curve_id  || {}).value || '';
                    // Only strip extension if suffix is purely alphabetic (1-4 chars).
                    // Prevents "2.5mL" → "2" when there is no real extension.
                    const extM  = fname.match(/\.([a-zA-Z]{1,4})$/);
                    const stem  = extM ? fname.slice(0, -extM[0].length) : fname;
                    if (stem) stemToMeta[stem] = { curve_id: cid, filename: fname };
                }
                ojipCurves.curve_meta = stemToMeta;
                payload.ojip_curves = ojipCurves;
            }
        }

        fetch('/api/fluorescence_annotation/export', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error')); return r.json(); })
            .then(data => {
                if (data.status !== 'ok' && data.status !== 'success') { _showError(data.message || 'Export failed.'); return; }
                const bytes = atob(data.bundle_b64);
                const arr   = new Uint8Array(bytes.length);
                for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                const blob = new Blob([arr], { type: 'application/zip' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url; a.download = data.filename || 'fluorescence_bundle.zip';
                document.body.appendChild(a); a.click();
                document.body.removeChild(a); URL.revokeObjectURL(url);
                _toast('Bundle downloaded — includes per-curve JSON sidecars + summary.parquet.');
            })
            .catch(err => _showError('Export failed: ' + err));
    }

    // ── Bundle load ───────────────────────────────────────────────────────────
    function loadBundle(file) {
        _clearError(); _clearWarnings();
        const fd = new FormData();
        fd.append('bundle_file', file);

        fetch('/api/fluorescence_annotation/load_bundle', { method: 'POST', body: fd })
            .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error')); return r.json(); })
            .then(data => {
                if (data.status !== 'ok' && data.status !== 'success') { _showError(data.message || 'Failed to load bundle.'); return; }
                if (data._version_warning) _showWarnings([data._version_warning]);
                _rows     = data.rows || [];
                _bundleId = null;
                _populateTierForms(data.tier_defaults);
                _sampleType = _val('study-sample_type');
                _detectInstrumentFromRows();
                _renderGrid();
                const card = _eid('ann-grid-card');
                if (card) { card.classList.remove('d-none'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
                _toast('Bundle loaded — ' + _rows.length + ' curve(s).');
            })
            .catch(err => _showError('Load failed: ' + err));
    }

    // ── XLSX template download ──────────────────────────────────────────────
    function downloadXlsxTemplate(blank) {
        _clearError();
        const payload = blank ? {} : { tier_defaults: _collectTiers() };

        fetch('/api/fluorescence_annotation/xlsx_template', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error')); return r.json(); })
            .then(data => {
                if (data.status !== 'ok') { _showError(data.message || 'Template generation failed.'); return; }
                const bytes = atob(data.xlsx_b64);
                const arr   = new Uint8Array(bytes.length);
                for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                a.href = url; a.download = data.filename || 'annotation_template.xlsx';
                document.body.appendChild(a); a.click();
                document.body.removeChild(a); URL.revokeObjectURL(url);
                _toast('XLSX template downloaded — fill in and upload back.');
            })
            .catch(err => _showError('Template download failed: ' + err));
    }

    // ── XLSX upload ──────────────────────────────────────────────────────────
    function uploadXlsx(file) {
        _clearError(); _clearWarnings();
        const fd = new FormData();
        fd.append('xlsx_file', file);

        fetch('/api/fluorescence_annotation/xlsx_upload', { method: 'POST', body: fd })
            .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error')); return r.json(); })
            .then(data => {
                if (data.status !== 'ok') { _showError(data.message || 'XLSX parse failed.'); return; }
                // Merge parsed data into tier forms
                const td = {
                    investigation: data.investigation || {},
                    study: data.study || {},
                    fluor: data.fluor || {},
                    treatment_templates: data.treatment_templates || [],
                };
                _populateTierForms(td);
                _resolveOrganismAfterUpload();

                // Apply per-curve overrides if grid has rows
                const overrides = data.per_curve_overrides || [];
                if (overrides.length && _rows.length) {
                    overrides.forEach((ovr, i) => {
                        if (i < _rows.length) {
                            Object.entries(ovr).forEach(([k, v]) => {
                                _rows[i][k] = { value: v, provenance: 'typed' };
                            });
                            _rows[i].completeness_score = { value: _clientScore(_rows[i]), provenance: 'computed' };
                        }
                    });
                    _renderGrid();
                }

                _toast(`XLSX imported: ${Object.keys(data.investigation||{}).length + Object.keys(data.study||{}).length + Object.keys(data.fluor||{}).length} tier fields, ${overrides.length} per-curve rows, ${(data.treatment_templates||[]).length} treatment templates.`);
            })
            .catch(err => _showError('XLSX upload failed: ' + err));
    }

    // ── Ingest from pre-computed OJIP results ─────────────────────────────────
    function ingestFromOJIP(payload) {
        _clearError(); _clearWarnings();
        const btn = _eid('ann-ojip-populate-btn');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i>Processing\u2026'; }

        fetch('/api/fluorescence_annotation/ingest_from_ojip', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
            .then(r => { if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error')); return r.json(); })
            .then(data => {
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-tags mr-1"></i>Populate annotation grid'; }
                if (data.status !== 'ok' && data.status !== 'success') { _showError(data.message || 'Ingest failed.'); return; }
                if (data.warnings && data.warnings.length) _showWarnings(data.warnings);
                populateFromPrecomputed(data.rows, data.bundle_id);
            })
            .catch(err => {
                if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa fa-tags mr-1"></i>Populate annotation grid'; }
                _showError('Request failed: ' + err);
            });
    }

    function populateFromPrecomputed(rows, bundleId) {
        _rows     = rows || [];
        _bundleId = bundleId || null;
        if (!_sampleType && _rows.length) {
            _sampleType = ((_rows[0].sample_type || {}).value || '') || _val('study-sample_type');
        }
        _detectInstrumentFromRows();
        _renderGrid();
        const card = _eid('ann-grid-card');
        if (card) { card.classList.remove('d-none'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }

    // ── Pre-acclimation helpers ────────────────────────────────────────────────
    /** Copy growth temperature and CO₂ from the Study tab into the
     *  pre-acclimation fields on the Fluorometer tab. */
    function copyPreacclFromStudy() {
        const temp = _val('study-growth_temperature');
        const co2  = _val('study-growth_co2');
        if (temp !== '') { const el = _eid('fluor-preaccl_temperature'); if (el) el.value = temp; }
        if (co2  !== '') { const el = _eid('fluor-preaccl_co2');         if (el) el.value = co2;  }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {
        _fetchSchema();
        _setupDragDrop();
        _setupOrganismDropdown();
        updateFluorCount();
        _updateStudyFieldVisibility();
        // Pick up sample_type if already set in form on page load
        const stEl = _eid('study-sample_type');
        if (stEl && stEl.value) {
            _sampleType = stEl.value;
            _updateStudyFieldVisibility();
        }
        // Instrument display is read-only; will be set after file upload
        // (no need to check on init — auto-detected from files)
        _renderTreatmentTable(); // show first empty row in each section
        _highlightEmptyFields();
        _setupEmptyFieldListeners();
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        init,
        ingest,
        ingestFromOJIP,
        populateFromPrecomputed,
        collectTiers:      _collectTiers,   // used by js_OJIP.js
        addToken,
        removeToken,
        fillDown,
        toggleGroup,
        updateFluorCount,
        onSampleTypeChange,
        recalcSampleDensity,
        onInstrumentChange,
        onGrowthLightTypeChange,
        copyPreacclFromStudy,
        searchOrganism,
        addTreatmentTemplate,
        addChemTreatmentRow,
        addStressTreatmentRow,
        addOtherTreatmentRow,
        removeTreatmentRow,
        removeTreatmentTemplate,
        _onStressTypeChange,
        downloadBundle,
        loadBundle,
        downloadXlsxTemplate,
        uploadXlsx,
    };
})();

document.addEventListener('DOMContentLoaded', ANN.init);
