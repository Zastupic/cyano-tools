/**
 * js_fluorescence_annotation.js
 * Fluorescence Data Annotation Tool — front-end module (M2).
 *
 * Exposed global: ANN  (IIFE)
 * Entry point   : ANN.init()  — called on DOMContentLoaded
 */
'use strict';

const ANN = (function () {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────────────
    let _schema   = {};   // { schema_version, fields: { key: FieldDef } }
    let _rows     = [];   // array of row objects from /ingest or /load_bundle
    let _bundleId = null; // bundle_id returned by /ingest (used in /export)
    let _files    = [];   // File objects from drop zone / file input
    let _showJip  = true;
    let _showTech = false;

    // ── Column definitions ────────────────────────────────────────────────────
    // group: 'core' always visible | 'tech' when _showTech | 'jip' when _showJip
    const COLS = [
        // core (always visible)
        { key: 'curve_id',            label: 'Curve ID',      group: 'core', editable: true  },
        { key: 'filename',            label: 'Filename',      group: 'core', editable: false },
        { key: 'sample_id',           label: 'Sample ID',     group: 'core', editable: true  },
        { key: 'replicate_id',        label: 'Replicate #',   group: 'core', editable: true  },
        { key: 'treatment',           label: 'Treatment',     group: 'core', editable: true  },
        { key: 'timepoint_h',         label: 'Timepoint (h)', group: 'core', editable: true  },
        { key: 'completeness_score',  label: 'Complete',      group: 'core', editable: false },
        // tech — extra per-curve fields (toggle)
        { key: 'treatment_dose',      label: 'Dose',          group: 'tech', editable: true  },
        { key: 'treatment_dose_unit', label: 'Dose unit',     group: 'tech', editable: true  },
        { key: 'OD_at_measurement',   label: 'OD',            group: 'tech', editable: true  },
        { key: 'timestamp',           label: 'Timestamp',     group: 'tech', editable: true  },
        { key: 'gain',                label: 'Gain',          group: 'tech', editable: true  },
        // jip — all JIP-test parameters (toggle)
        { key: 'jip_F0',      label: 'F0',       group: 'jip', editable: false },
        { key: 'jip_FM',      label: 'FM',       group: 'jip', editable: false },
        { key: 'jip_FK',      label: 'FK',       group: 'jip', editable: false },
        { key: 'jip_FJ',      label: 'FJ',       group: 'jip', editable: false },
        { key: 'jip_FI',      label: 'FI',       group: 'jip', editable: false },
        { key: 'jip_VJ',      label: 'VJ',       group: 'jip', editable: false },
        { key: 'jip_VI',      label: 'VI',       group: 'jip', editable: false },
        { key: 'jip_Fv_Fm',   label: 'Fv/Fm',    group: 'jip', editable: false },
        { key: 'jip_M0',      label: 'M0',       group: 'jip', editable: false },
        { key: 'jip_Sm',      label: 'Sm',       group: 'jip', editable: false },
        { key: 'jip_N',       label: 'N',        group: 'jip', editable: false },
        { key: 'jip_psiE0',   label: '\u03c8E0', group: 'jip', editable: false },
        { key: 'jip_psiR0',   label: '\u03c8R0', group: 'jip', editable: false },
        { key: 'jip_deltaR0', label: '\u03b4R0', group: 'jip', editable: false },
        { key: 'jip_phiE0',   label: '\u03c6E0', group: 'jip', editable: false },
        { key: 'jip_phiR0',   label: '\u03c6R0', group: 'jip', editable: false },
        { key: 'jip_ABS_RC',  label: 'ABS/RC',   group: 'jip', editable: false },
        { key: 'jip_TR0_RC',  label: 'TR0/RC',   group: 'jip', editable: false },
        { key: 'jip_ET0_RC',  label: 'ET0/RC',   group: 'jip', editable: false },
        { key: 'jip_RE0_RC',  label: 'RE0/RC',   group: 'jip', editable: false },
        { key: 'jip_DI0_RC',  label: 'DI0/RC',   group: 'jip', editable: false },
        { key: 'jip_Area_OJ', label: 'Area OJ',  group: 'jip', editable: false },
        { key: 'jip_Area_JI', label: 'Area JI',  group: 'jip', editable: false },
        { key: 'jip_Area_IP', label: 'Area IP',  group: 'jip', editable: false },
        { key: 'jip_Area_OP', label: 'Area OP',  group: 'jip', editable: false },
    ];

    // ── Provenance badge config ───────────────────────────────────────────────
    const PROV = {
        typed:         { cls: 'ann-prov-T', lbl: 'T', title: 'Typed by user'              },
        from_header:   { cls: 'ann-prov-H', lbl: 'H', title: 'Auto-detected from file header' },
        from_filename: { cls: 'ann-prov-F', lbl: 'F', title: 'Decoded from filename token' },
        inherited:     { cls: 'ann-prov-I', lbl: 'I', title: 'Inherited from tier form'   },
        computed:      { cls: 'ann-prov-C', lbl: 'C', title: 'Computed (JIP-test)'        },
    };

    // Per-curve fields available as filename token targets
    const TOKEN_FIELDS = [
        'sample_id', 'replicate_id', 'treatment', 'treatment_dose',
        'treatment_dose_unit', 'OD_at_measurement', 'timepoint_h', 'timestamp', 'gain',
    ];

    // ── Utilities ─────────────────────────────────────────────────────────────
    function _eid(id) { return document.getElementById(id); }

    /** Escape HTML for use in attribute values and text content. */
    function _esc(s) {
        if (s === null || s === undefined) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** Format a numeric value to 4 significant figures; pass strings through. */
    function _fmt(v) {
        if (v === null || v === undefined || v === '') return null;
        const n = parseFloat(v);
        if (!isNaN(n) && String(v).trim() !== '') {
            // trim trailing zeros after toPrecision
            return n.toPrecision(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        }
        return String(v);
    }

    function _provBadge(prov) {
        const p = PROV[prov];
        if (!p) return '';
        return `<span class="ann-prov ${p.cls}" title="${p.title}">${p.lbl}</span>`;
    }

    function _val(id) {
        const el = _eid(id);
        return el ? el.value.trim() : '';
    }

    function _visibleCols() {
        return COLS.filter(c => {
            if (c.group === 'core') return true;
            if (c.group === 'tech') return _showTech;
            if (c.group === 'jip')  return _showJip;
            return false;
        });
    }

    // ── Banner helpers ────────────────────────────────────────────────────────
    function _showError(msg) {
        const el = _eid('ann-error-banner');
        el.textContent = msg;
        el.classList.remove('d-none');
    }

    function _clearError() {
        const el = _eid('ann-error-banner');
        el.textContent = '';
        el.classList.add('d-none');
    }

    function _showWarnings(msgs) {
        if (!msgs || !msgs.length) return;
        const el = _eid('ann-warning-banner');
        el.innerHTML = '<strong>Warnings:</strong><ul class="mb-0 mt-1">' +
            msgs.map(m => `<li>${_esc(m)}</li>`).join('') + '</ul>';
        el.classList.remove('d-none');
    }

    function _clearWarnings() {
        const el = _eid('ann-warning-banner');
        el.innerHTML = '';
        el.classList.add('d-none');
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
                project_title:       _val('inv-project_title'),
                contact_name:        _val('inv-contact_name'),
                contact_email:       _val('inv-contact_email'),
                institution:         _val('inv-institution'),
                license:             _val('inv-license'),
                project_description: _val('inv-project_description'),
            },
            study: {
                organism:                        _val('study-organism'),
                taxonomic_group:                 _val('study-taxonomic_group'),
                strain:                          _val('study-strain'),
                culture_collection_id:           _val('study-culture_collection_id'),
                growth_medium:                   _val('study-growth_medium'),
                growth_conditions:               _val('study-growth_conditions'),
                dark_adaptation_min:             _val('study-dark_adaptation_min'),
                instrument:                      _val('study-instrument'),
                measuring_light_wavelength_nm:   _val('study-measuring_light_wavelength_nm'),
                measuring_light_intensity_umol:  _val('study-measuring_light_intensity_umol'),
                actinic_light_wavelength_nm:     _val('study-actinic_light_wavelength_nm'),
                actinic_light_intensity_umol:    _val('study-actinic_light_intensity_umol'),
                saturating_pulse_intensity_umol: _val('study-saturating_pulse_intensity_umol'),
                saturating_pulse_duration_ms:    _val('study-saturating_pulse_duration_ms'),
            },
            assay: {
                measurement_type:  _val('assay-measurement_type'),
                assay_description: _val('assay-assay_description'),
            },
            token_dict:  _collectTokenDict(),
            FJ_time_ms:  parseFloat(_val('ann-FJ-ms'))  || 2.0,
            FI_time_ms:  parseFloat(_val('ann-FI-ms'))  || 30.0,
        };
    }

    /** Restore tier forms from a loaded bundle's tier_defaults object. */
    function _populateTierForms(td) {
        if (!td) return;
        const inv   = td.investigation || {};
        const study = td.study         || {};
        const assay = td.assay         || {};
        const tok   = td.token_dict    || {};

        ['project_title', 'contact_name', 'contact_email',
         'institution', 'license', 'project_description'].forEach(k => {
            const el = _eid('inv-' + k);
            if (el && inv[k] !== undefined && inv[k] !== '') el.value = inv[k];
        });

        ['organism', 'taxonomic_group', 'strain', 'culture_collection_id',
         'growth_medium', 'growth_conditions', 'dark_adaptation_min',
         'instrument', 'measuring_light_wavelength_nm',
         'measuring_light_intensity_umol', 'actinic_light_wavelength_nm',
         'actinic_light_intensity_umol', 'saturating_pulse_intensity_umol',
         'saturating_pulse_duration_ms'].forEach(k => {
            const el = _eid('study-' + k);
            if (el && study[k] !== undefined && study[k] !== '') el.value = study[k];
        });

        ['measurement_type', 'assay_description'].forEach(k => {
            const el = _eid('assay-' + k);
            if (el && assay[k] !== undefined && assay[k] !== '') el.value = assay[k];
        });

        if (tok.separator) _eid('ann-token-sep').value = tok.separator;
        _eid('ann-token-body').innerHTML = '';
        if (Array.isArray(tok.tokens)) tok.tokens.forEach(_addTokenRow);
    }

    // ── Token table ───────────────────────────────────────────────────────────
    function _addTokenRow(tok) {
        tok = tok || {};
        const tbody = _eid('ann-token-body');
        const tr    = document.createElement('tr');
        const flds  = _schema.fields || {};
        const optHtml = TOKEN_FIELDS.map(f => {
            const lbl = flds[f] ? flds[f].label : f;
            return `<option value="${_esc(f)}"${tok.field === f ? ' selected' : ''}>${_esc(lbl)}</option>`;
        }).join('');
        tr.innerHTML = `
          <td>
            <input type="number" class="form-control form-control-sm"
                   style="width:60px;" min="0" step="1"
                   value="${tok.position !== undefined ? _esc(tok.position) : ''}">
          </td>
          <td><select class="form-control form-control-sm">${optHtml}</select></td>
          <td>
            <input type="text" class="form-control form-control-sm"
                   value="${_esc(tok.strip_prefix || '')}" placeholder="e.g. rep">
          </td>
          <td>
            <input type="text" class="form-control form-control-sm"
                   value="${_esc(tok.strip_suffix || '')}" placeholder="e.g. .0">
          </td>
          <td>
            <button class="btn btn-sm btn-outline-danger"
                    onclick="ANN.removeToken(this)" title="Remove token">
              <i class="fa fa-times"></i>
            </button>
          </td>`;
        tbody.appendChild(tr);
    }

    function addToken()       { _addTokenRow({}); }
    function removeToken(btn) { btn.closest('tr').remove(); }

    function _collectTokenDict() {
        const sep    = _eid('ann-token-sep').value || '_';
        const tokens = [];
        _eid('ann-token-body').querySelectorAll('tr').forEach(tr => {
            const inputs = tr.querySelectorAll('input, select');
            const pos    = parseInt(inputs[0].value, 10);
            const fld    = inputs[1].value;
            const pre    = inputs[2].value.trim();
            const suf    = inputs[3].value.trim();
            if (!isNaN(pos) && fld) {
                tokens.push({ position: pos, field: fld,
                              strip_prefix: pre, strip_suffix: suf });
            }
        });
        return { separator: sep, tokens: tokens };
    }

    // ── Drag-drop & file input ────────────────────────────────────────────────
    // Null-guarded: upload-zone elements are absent when the module is embedded
    // inside the OJIP Annotation tab (no file upload needed there).
    function _setupDragDrop() {
        const zone  = _eid('ann-drop-zone');
        const input = _eid('ann-file-input');

        if (zone && input) {
            zone.addEventListener('dragover', e => {
                e.preventDefault();
                zone.classList.add('dragover');
            });
            zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
            zone.addEventListener('drop', e => {
                e.preventDefault();
                zone.classList.remove('dragover');
                _setFiles(Array.from(e.dataTransfer.files));
            });
            input.addEventListener('change', function () {
                _setFiles(Array.from(this.files));
            });
        }

        const bundleInput = _eid('ann-bundle-input');
        if (bundleInput) {
            bundleInput.addEventListener('change', function () {
                if (this.files && this.files[0]) loadBundle(this.files[0]);
            });
        }
    }

    function _setFiles(fileArray) {
        _files = fileArray;
        const zone = _eid('ann-drop-zone');
        const list = _eid('ann-file-list');
        if (_files.length) {
            zone.classList.add('has-files');
            list.innerHTML =
                '<i class="fa fa-check text-success mr-1"></i>' +
                `${_files.length} file(s) selected: ` +
                _files.map(f => `<code>${_esc(f.name)}</code>`).join(', ');
            _eid('ann-ingest-btn').disabled = false;
        } else {
            zone.classList.remove('has-files');
            list.innerHTML = '';
            _eid('ann-ingest-btn').disabled = true;
        }
    }

    // ── Ingest ────────────────────────────────────────────────────────────────
    function ingest() {
        if (!_files.length) return;
        _clearError();
        _clearWarnings();

        const spinner = _eid('ann-spinner');
        const btn     = _eid('ann-ingest-btn');
        spinner.classList.remove('d-none');
        btn.disabled = true;

        const fd = new FormData();
        _files.forEach(f => fd.append('fluo_files', f));
        fd.append('tier_json', JSON.stringify(_collectTiers()));

        fetch('/api/fluorescence_annotation/ingest', { method: 'POST', body: fd })
            .then(r => {
                if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error'));
                return r.json();
            })
            .then(data => {
                spinner.classList.add('d-none');
                btn.disabled = false;
                if (data.status !== 'ok') {
                    _showError(data.message || 'Ingest failed.');
                    return;
                }
                _rows     = data.rows || [];
                _bundleId = data.bundle_id || null;
                if (data.warnings && data.warnings.length) _showWarnings(data.warnings);
                _renderGrid(_rows);
                _eid('ann-grid-card').classList.remove('d-none');
                _eid('ann-grid-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
            })
            .catch(err => {
                spinner.classList.add('d-none');
                btn.disabled = false;
                _showError('Request failed: ' + err);
            });
    }

    // ── Grid rendering ────────────────────────────────────────────────────────
    function _renderGrid(rows) {
        _rows = rows;
        const visCols = _visibleCols();
        _renderHead(visCols);
        _renderBody(visCols, rows);
        _updateSummary(rows);
    }

    function _renderHead(visCols) {
        let html = '<tr>';
        visCols.forEach(c => {
            let extraCls = '';
            if (c.group === 'jip')  extraCls = ' ann-jip';
            if (c.group === 'tech') extraCls = ' ann-tech';
            html += `<th class="${extraCls}" title="${_esc(c.key)}">${_esc(c.label)}</th>`;
        });
        html += '</tr>';
        _eid('ann-grid-head').innerHTML = html;
    }

    function _renderBody(visCols, rows) {
        let html = '';
        rows.forEach((row, ri) => {
            html += '<tr>';
            visCols.forEach(col => { html += _cellHtml(col, row, ri); });
            html += '</tr>';
        });
        const tbody = _eid('ann-grid-body');
        tbody.innerHTML = html;

        // Attach edit listeners to editable cells
        tbody.querySelectorAll('td.ann-cell-editable').forEach(td => {
            td.addEventListener('click', function () {
                _startEdit(this, this.dataset.key, parseInt(this.dataset.ri, 10));
            });
        });
    }

    /**
     * Build the HTML for one table cell.
     * For completeness_score: coloured progress bar + percentage.
     * For editable cells:     value + provenance badge, click-to-edit.
     * For computed/read-only: value + provenance badge, no click.
     */
    function _cellHtml(col, row, ri) {
        const cell = row[col.key];
        const val  = (cell && typeof cell === 'object') ? cell.value      : null;
        const prov = (cell && typeof cell === 'object') ? cell.provenance : null;

        // ── Completeness bar ──────────────────────────────────────────────────
        if (col.key === 'completeness_score') {
            const score  = (val !== null && val !== undefined) ? parseFloat(val) : 0;
            const barCls = score >= 75 ? '' : (score >= 40 ? ' mid' : ' low');
            return `<td style="white-space:nowrap; min-width:90px;">` +
                `<span class="ann-score-bar">` +
                `<span class="ann-score-fill${barCls}" style="width:${Math.min(score,100)}%"></span>` +
                `</span>${score.toFixed(1)}%</td>`;
        }

        const disp  = _fmt(val);
        const badge = prov ? _provBadge(prov) : '';

        if (col.editable) {
            const nullCls = (disp === null || disp === '') ? 'ann-cell-null' : '';
            const display = (disp !== null && disp !== '') ? _esc(disp) : '&mdash;';
            let extraCls = '';
            if (col.group === 'tech') extraCls = ' ann-tech';
            return `<td class="ann-cell-editable ${nullCls}${extraCls}" ` +
                `data-key="${_esc(col.key)}" data-ri="${ri}">${display}${badge}</td>`;
        }

        // read-only
        const nullCls = (disp === null || disp === '') ? 'ann-cell-null' : '';
        const display = (disp !== null && disp !== '') ? _esc(disp) : '';
        let extraCls = '';
        if (col.group === 'jip')  extraCls = ' ann-jip';
        if (col.group === 'tech') extraCls = ' ann-tech';
        return `<td class="${nullCls}${extraCls}">${display}${badge}</td>`;
    }

    // ── Inline cell editing ───────────────────────────────────────────────────
    function _startEdit(td, key, rowIdx) {
        // Guard against double-click while already editing
        if (td.querySelector('input, select')) return;

        const cell   = _rows[rowIdx][key] || {};
        const curVal = (cell.value !== undefined && cell.value !== null) ? cell.value : '';
        const fdef   = _schema.fields && _schema.fields[key];
        const vocab  = (fdef && fdef.vocab && fdef.vocab.length) ? fdef.vocab : null;

        let inputHtml;
        if (vocab) {
            const opts = [`<option value=""></option>`].concat(
                vocab.map(v =>
                    `<option value="${_esc(v)}"${String(curVal) === String(v) ? ' selected' : ''}>${_esc(v)}</option>`
                )
            ).join('');
            inputHtml = `<select class="form-control form-control-sm p-0"
                style="min-width:110px; font-size:.8rem;">${opts}</select>`;
        } else {
            inputHtml = `<input type="text" class="form-control form-control-sm p-0"
                style="min-width:80px; font-size:.8rem;" value="${_esc(curVal)}">`;
        }

        td.innerHTML = inputHtml;
        const input = td.querySelector('input, select');
        input.focus();
        if (input.select) input.select(); // highlight text in text inputs

        let _committed = false;

        function _commit() {
            if (_committed) return;
            _committed = true;
            const newVal = input.value.trim();
            if (!_rows[rowIdx][key] || typeof _rows[rowIdx][key] !== 'object') {
                _rows[rowIdx][key] = {};
            }
            _rows[rowIdx][key].value      = newVal;
            _rows[rowIdx][key].provenance = 'typed';
            // Update completeness score client-side
            const newScore = _clientScore(_rows[rowIdx]);
            if (!_rows[rowIdx].completeness_score ||
                typeof _rows[rowIdx].completeness_score !== 'object') {
                _rows[rowIdx].completeness_score = {};
            }
            _rows[rowIdx].completeness_score.value = newScore;
            _renderGrid(_rows);
        }

        input.addEventListener('blur',    _commit);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { _committed = true; _renderGrid(_rows); }
        });
    }

    /** Recompute completeness score client-side from current row values. */
    function _clientScore(row) {
        if (!_schema.fields) return 0;
        let total = 0, earned = 0;
        Object.entries(_schema.fields).forEach(([k, fd]) => {
            if (!fd.weight || fd.weight <= 0) return;
            total += fd.weight;
            const cell = row[k];
            const v    = (cell && typeof cell === 'object') ? cell.value : null;
            if (v !== null && v !== undefined && v !== '') earned += fd.weight;
        });
        return total > 0 ? parseFloat((100 * earned / total).toFixed(1)) : 0;
    }

    // ── Summary badges ────────────────────────────────────────────────────────
    function _updateSummary(rows) {
        const n = rows.length;
        let warnCount = 0;
        let scoreSum  = 0;
        rows.forEach(r => {
            warnCount += (r._warnings && Array.isArray(r._warnings)) ? r._warnings.length : 0;
            const sc = r.completeness_score;
            scoreSum += (sc && typeof sc === 'object' && sc.value !== undefined)
                ? parseFloat(sc.value) || 0 : 0;
        });
        const avgScore = n > 0 ? (scoreSum / n).toFixed(1) : 0;

        let html = `<span class="badge badge-primary">${n} file${n !== 1 ? 's' : ''}</span> `;
        html    += `<span class="badge badge-secondary ml-1">avg ${avgScore}% complete</span>`;
        if (warnCount > 0) {
            html += `<span class="badge badge-warning ml-1">`
                  + `${warnCount} warning${warnCount !== 1 ? 's' : ''}</span>`;
        }
        _eid('ann-summary-badges').innerHTML = html;
    }

    // ── Column toggles ────────────────────────────────────────────────────────
    function toggleJip(show) {
        _showJip = !!show;
        if (_rows.length) _renderGrid(_rows);
    }

    function toggleTech(show) {
        _showTech = !!show;
        if (_rows.length) _renderGrid(_rows);
    }

    // ── Bundle download ───────────────────────────────────────────────────────
    function downloadBundle() {
        if (!_rows.length) {
            _showError('No data to export. Ingest files first.');
            return;
        }
        _clearError();

        const payload = {
            bundle_id:     _bundleId,
            rows:          _rows,
            tier_defaults: _collectTiers(),
        };

        fetch('/api/fluorescence_annotation/export', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        })
            .then(r => {
                if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error'));
                return r.json();
            })
            .then(data => {
                if (data.status !== 'ok') {
                    _showError(data.message || 'Export failed.');
                    return;
                }
                // Decode base64 → Blob → download
                const bytes = atob(data.bundle_b64);
                const arr   = new Uint8Array(bytes.length);
                for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                const blob  = new Blob([arr], { type: 'application/zip' });
                const url   = URL.createObjectURL(blob);
                const a     = document.createElement('a');
                a.href      = url;
                a.download  = data.filename || 'fluorescence_bundle.zip';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            })
            .catch(err => _showError('Export failed: ' + err));
    }

    // ── Bundle load ───────────────────────────────────────────────────────────
    function loadBundle(file) {
        _clearError();
        _clearWarnings();

        const fd = new FormData();
        fd.append('bundle_file', file);

        fetch('/api/fluorescence_annotation/load_bundle', { method: 'POST', body: fd })
            .then(r => {
                if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error'));
                return r.json();
            })
            .then(data => {
                if (data.status !== 'ok') {
                    _showError(data.message || 'Failed to load bundle.');
                    return;
                }
                if (data._version_warning) _showWarnings([data._version_warning]);
                _rows     = data.rows || [];
                _bundleId = null; // transient data not restored from bundle
                _populateTierForms(data.tier_defaults);
                _renderGrid(_rows);
                _eid('ann-grid-card').classList.remove('d-none');
                _eid('ann-grid-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
            })
            .catch(err => _showError('Load failed: ' + err));
    }

    // ── Ingest from pre-computed OJIP results ─────────────────────────────────
    // Called by js_OJIP.js:populateAnnotationFromOJIP() — no file upload needed.
    // payload: { ojip_results: {...}, tier_json: {...} }
    function ingestFromOJIP(payload) {
        _clearError();
        _clearWarnings();

        const btn = _eid('ann-ojip-populate-btn');
        if (btn) {
            btn.disabled  = true;
            btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i>Processing\u2026';
        }

        fetch('/api/fluorescence_annotation/ingest_from_ojip', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
        })
            .then(r => {
                if (!r.ok) return r.json().then(d => Promise.reject(d.message || 'Server error'));
                return r.json();
            })
            .then(data => {
                if (btn) {
                    btn.disabled  = false;
                    btn.innerHTML = '<i class="fa fa-tags mr-1"></i>Populate annotation grid';
                }
                if (data.status !== 'ok') { _showError(data.message || 'Ingest failed.'); return; }
                if (data.warnings && data.warnings.length) _showWarnings(data.warnings);
                populateFromPrecomputed(data.rows, data.bundle_id);
            })
            .catch(err => {
                if (btn) {
                    btn.disabled  = false;
                    btn.innerHTML = '<i class="fa fa-tags mr-1"></i>Populate annotation grid';
                }
                _showError('Request failed: ' + err);
            });
    }

    // ── Populate grid from externally-supplied rows ───────────────────────────
    // Used by both ingestFromOJIP and loadBundle when called from the OJIP tab.
    function populateFromPrecomputed(rows, bundleId) {
        _rows     = rows || [];
        _bundleId = bundleId || null;
        _renderGrid(_rows);
        const card = _eid('ann-grid-card');
        if (card) {
            card.classList.remove('d-none');
            card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function init() {
        _fetchSchema();
        _setupDragDrop();
    }

    // ── Public API ────────────────────────────────────────────────────────────
    return {
        init,
        ingest,
        ingestFromOJIP,
        populateFromPrecomputed,
        collectTiers:  _collectTiers,   // used by js_OJIP.js
        addToken,
        removeToken,
        toggleJip,
        toggleTech,
        downloadBundle,
        loadBundle,
    };
})();

document.addEventListener('DOMContentLoaded', ANN.init);
