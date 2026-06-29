/* ============================================================
   js_pbr_analysis.js  –  PBR Data Analysis (FMT-150 / MC-1000)
   ============================================================ */

'use strict';

const PBR = (() => {

    // ── State ─────────────────────────────────────────────────────────────
    let _state = {
        cacheKey:    null,
        device:      null,
        data:        [],       // downsampled rows (array of objects)
        headers:     [],
        columnGroups:{},
        events:      [],
        info:        {},
        totalRows:   0,
        displayRows: 0,
        stride:      1,
        showMode:    'raw',     // 'raw' | 'corrected' | 'both'
        activeChannels: new Set(),  // MC-1000: {1,2,...,8}
        chart:       null,
    };

    // ── Color palette per channel (MC-1000) ───────────────────────────────
    const CH_COLORS = [
        '#2563eb','#7c3aed','#db2777','#059669',
        '#d97706','#dc2626','#0891b2','#65a30d',
    ];
    // OD720 = solid, OD680 = lighter shade of same colour
    const CH_COLORS_LIGHT = [
        '#93c5fd','#c4b5fd','#f9a8d4','#6ee7b7',
        '#fcd34d','#fca5a5','#67e8f9','#bef264',
    ];

    // Fit overlay colours – contrasting to CH_COLORS so fits are visually distinct
    const FIT_COLORS = [
        '#f97316','#22c55e','#14b8a6','#ef4444',
        '#6366f1','#06b6d4','#f59e0b','#a855f7',
    ];
    const FIT_COLORS_LIGHT = [
        '#fdba74','#86efac','#5eead4','#fca5a5',
        '#a5b4fc','#67e8f9','#fde68a','#e9d5ff',
    ];

    // Colours for non-OD groups (FMT-150 & MC-1000 shared signals)
    const GROUP_COLORS = {
        temperature: '#f97316',
        probes:      '#8b5cf6',
        fluorescence:'#16a34a',
        pumps:       '#9ca3af',
        turbidostat: '#14b8a6',
        light:       '#eab308',
        other:       '#6b7280',
    };

    // ── Growth curve model colours, dash patterns, display labels ─────────
    const MODEL_COLORS = {
        logistic: '#f97316',
        gompertz: '#22c55e',
        baranyi:  '#8b5cf6',
        richards: '#ef4444',
    };
    const MODEL_DASH = {
        logistic: [],
        gompertz: [6, 3],
        baranyi:  [3, 3],
        richards: [8, 3],
    };
    const MODEL_LABELS = {
        logistic: 'Logistic',
        gompertz: 'Gompertz',
        baranyi:  'Baranyi',
        richards: 'Richards',
    };

    // Whether to apply the stitching offset so corrected OD joins raw at threshold.
    // Default true = smooth display; XLSX export always uses the unshifted formula regardless.
    let _applyODStitchOffset = true;

    // ── OD correction coefficients ────────────────────────────────────────
    const OD_CORR = {
        'FMT-150 WT':  { '720': (od) => 0.23   * Math.exp(1.83   * od) },
        'FMT-150 EFE': { '720': (od) => 0.3201 * Math.exp(1.6376 * od) },
        'MC-1000':     { '720': (od) => 0.029  + 0.143 * Math.exp(2.497 * od) },
    };
    const OD680_CORR = {
        'FMT-150 WT':  (od) => 0.4228 * Math.exp(0.9296 * od),
        'FMT-150 EFE': (od) => 0.7622 * Math.exp(0.6223 * od),
    };

    // Compute stitching offset δ = formula(threshold) − threshold, so the
    // corrected curve joins the raw curve seamlessly at the threshold.
    // (Display only — XLSX export always uses the original unshifted formula.)
    function _stitchDelta(deviceStr, signalType) {
        const t = signalType === '720' ? 0.4 : 0.6;
        if (signalType === '720') {
            const c = OD_CORR[deviceStr];
            return c ? c['720'](t) - t : 0;
        }
        if (signalType === '680') {
            const fn = OD680_CORR[deviceStr];
            return fn ? fn(t) - t : 0;
        }
        return 0;
    }

    function applyODCorrection(od, deviceStr, signalType) {
        if (od === null || od === undefined || isNaN(od)) return od;
        od = parseFloat(od);
        if (signalType === '720') {
            if (od <= 0.4) return od;
            const c = OD_CORR[deviceStr];
            if (!c) return od;
            const corrected = c['720'](od);
            return _applyODStitchOffset ? corrected - _stitchDelta(deviceStr, signalType) : corrected;
        }
        if (signalType === '680') {
            if (od < 0.6) return od;
            const fn = OD680_CORR[deviceStr];
            if (!fn) return od;
            const corrected = fn(od);
            return _applyODStitchOffset ? corrected - _stitchDelta(deviceStr, signalType) : corrected;
        }
        return od;
    }

    function setODStitchOffset(on) {
        _applyODStitchOffset = on;
        updatePlot();
        // Rebuild mode 4 scatter when offset changes (no re-fit needed — δ is constant)
        if (_muMode4Data) {
            const { fits, odCols, tMin, tMax } = _muMode4Data;
            _muBuildChart4(fits, odCols, tMin, tMax);
        }
    }

    // ── Upload & drag-drop wiring ─────────────────────────────────────────
    function _initUpload() {
        const zone  = document.getElementById('pbr-upload-zone');
        const input = document.getElementById('pbr-file-input');
        if (!zone || !input) return;

        input.addEventListener('change', (e) => {
            if (e.target.files[0]) _handleFile(e.target.files[0]);
        });
        zone.addEventListener('dragover', (e) => {
            e.preventDefault();
            zone.classList.add('dragover');
        });
        zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
        zone.addEventListener('drop', (e) => {
            e.preventDefault();
            zone.classList.remove('dragover');
            if (e.dataTransfer.files[0]) _handleFile(e.dataTransfer.files[0]);
        });
    }

    function _handleFile(file) {
        if (!file.name.toLowerCase().endsWith('.ods')) {
            _showError('Only .ods files are supported.');
            return;
        }
        _showError(null);
        document.getElementById('pbr-upload-filename').textContent = file.name;
        document.getElementById('pbr-upload-icon').textContent = '⏳';
        _setLoading(true);

        const fd = new FormData();
        fd.append('file', file);

        fetch('/pbr_analysis/parse', { method: 'POST', body: fd })
            .then(r => r.json())
            .then(resp => {
                _setLoading(false);
                document.getElementById('pbr-upload-icon').textContent = '📂';
                if (resp.error) { _showError(resp.error); return; }
                _applyParseResponse(resp);
            })
            .catch(err => {
                _setLoading(false);
                _showError('Network error: ' + err.message);
            });
    }

    // ── Apply server response ─────────────────────────────────────────────
    function _applyParseResponse(resp) {
        // Destroy existing chart so zoom/axes reset cleanly on new file
        if (_state.chart) { _state.chart.destroy(); _state.chart = null; }

        _state.cacheKey    = resp.cache_key;
        _state.device      = resp.device;
        _state.data        = resp.data || [];
        _state.headers     = resp.headers || [];
        _state.columnGroups= resp.column_groups || {};
        _state.events      = resp.events || [];
        _state.info        = resp.info || {};
        _state.totalRows   = resp.total_rows;
        _state.displayRows = resp.display_rows;
        _state.stride      = resp.stride;
        _state.showMode    = 'raw';
        _state.activeChannels = new Set();

        // Detect channels for MC-1000
        const odCols = (_state.columnGroups.od || []);
        const mcChannels = _extractChannelNumbers(odCols);
        mcChannels.forEach(n => _state.activeChannels.add(n));

        _buildInfoBar(resp);
        _buildInfoPanel(_state.info);
        _buildSignalSelector(mcChannels);
        _buildCorrectionPanel(mcChannels);
        _buildEventsTable();

        // Show events overlay toggle if we have events
        const evToggle = document.getElementById('pbr-events-toggle-wrap');
        if (evToggle) evToggle.style.display = _state.events.length > 0 ? '' : 'none';

        // Show reset-zoom button; reset resolution selector
        const rzBtn = document.getElementById('pbr-reset-zoom');
        if (rzBtn) rzBtn.style.display = '';
        const resSel = document.getElementById('pbr-resolution');
        if (resSel) resSel.value = '0';
        const resNote = document.getElementById('pbr-resolution-note');
        if (resNote) resNote.textContent = '';

        document.getElementById('pbr-results-panel').style.display = '';
        _muInit();
        updatePlot();
    }

    function _extractChannelNumbers(odCols) {
        const nums = new Set();
        odCols.forEach(col => {
            // e.g. "od-sensors-3.od-720"
            const m = col.match(/od-sensors-(\d+)\./);
            if (m) nums.add(parseInt(m[1]));
        });
        return [...nums].sort((a, b) => a - b);
    }

    // ── Info bar ──────────────────────────────────────────────────────────
    function _buildInfoBar(resp) {
        const info = resp.info || {};
        document.getElementById('pbr-info-device').textContent = resp.device;
        document.getElementById('pbr-info-name').textContent   = info.name || '';
        document.getElementById('pbr-info-start').textContent  = info.start || '—';

        const rowNote = resp.stride > 1
            ? `${resp.display_rows.toLocaleString()} of ${resp.total_rows.toLocaleString()} rows shown (downsampled ×${resp.stride})`
            : `${resp.total_rows.toLocaleString()} rows`;
        document.getElementById('pbr-info-rows').textContent = rowNote;
    }

    // ── Signal selector ───────────────────────────────────────────────────
    function _buildSignalSelector(mcChannels) {
        const isMC = mcChannels.length > 0;

        // Channel checkboxes (MC-1000 only)
        const chSel = document.getElementById('pbr-channel-selector');
        const chBox = document.getElementById('pbr-channel-checkboxes');
        if (chSel && chBox) {
            chBox.innerHTML = '';
            if (isMC) {
                mcChannels.forEach(n => {
                    const badge = document.createElement('div');
                    badge.className = 'pbr-channel-badge active';
                    badge.dataset.ch = n;
                    badge.title = `Channel ${n}`;
                    badge.style.background = CH_COLORS[n - 1] || '#17a2b8';
                    badge.style.borderColor = CH_COLORS[n - 1] || '#17a2b8';
                    badge.style.color = '#fff';
                    badge.textContent = n;
                    badge.onclick = () => _toggleChannel(n, badge);
                    chBox.appendChild(badge);
                });
                chSel.style.display = '';
            } else {
                chSel.style.display = 'none';
            }
        }

        // Build grouped signal checkboxes
        const container = document.getElementById('pbr-signal-groups');
        if (!container) return;
        container.innerHTML = '';

        const groups = _state.columnGroups;
        const groupOrder = ['od','light','temperature','probes','fluorescence','pumps','turbidostat','other'];

        groupOrder.forEach(grp => {
            if (!groups[grp] || groups[grp].length === 0) return;
            const cols = groups[grp];

            const headerDiv = document.createElement('div');
            headerDiv.className = 'pbr-group-header';
            headerDiv.textContent = _groupLabel(grp);
            // Toggle collapse
            headerDiv.onclick = () => {
                const body = document.getElementById(`pbr-grp-${grp}`);
                if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
            };
            container.appendChild(headerDiv);

            const bodyDiv = document.createElement('div');
            bodyDiv.id = `pbr-grp-${grp}`;
            bodyDiv.className = 'pbr-group-cols';

            if (grp === 'od' && isMC) {
                // For MC-1000 OD: show signal-type checkboxes only (channels controlled separately)
                _appendODTypeCheckboxes(bodyDiv, cols);
            } else if (grp === 'light' && isMC && cols.length > 8) {
                // Compact wavelength selector for MC-1000 light
                _appendLightCompact(bodyDiv, cols);
            } else {
                // Plain checkboxes for all columns
                cols.forEach(col => {
                    _appendCheckbox(bodyDiv, col, grp, _defaultChecked(col, grp));
                });
            }
            container.appendChild(bodyDiv);
        });
    }

    function _groupLabel(grp) {
        const labels = {
            od: 'OD Signals', light: 'Actinic Light', temperature: 'Temperature',
            probes: 'Probes (O₂ / CO₂ / pH)', fluorescence: 'Fluorescence (FLM)',
            pumps: 'Pumps & Flow', turbidostat: 'Turbidostat', other: 'Other',
        };
        return labels[grp] || grp;
    }

    function _defaultChecked(col, grp) {
        const cl = col.toLowerCase();
        if (grp === 'od') return cl.includes('od-720') || cl.includes('od-680');
        if (grp === 'temperature') return false;
        return false;
    }

    function _appendCheckbox(parent, col, grp, checked) {
        const wrap = document.createElement('label');
        wrap.className = 'pbr-signal-cb';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = col;
        cb.dataset.group = grp;
        cb.className = 'pbr-sig-cb mr-1';
        cb.checked = checked;
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(_shortLabel(col)));
        parent.appendChild(wrap);
    }

    function _appendODTypeCheckboxes(parent, cols) {
        // Extract unique signal type suffixes: od-720, od-680, od-delta, od-division
        const types = ['od-720', 'od-680', 'od-delta', 'od-division'];
        types.forEach(t => {
            if (!cols.some(c => c.toLowerCase().includes(t))) return;
            const wrap = document.createElement('label');
            wrap.className = 'pbr-signal-cb';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = `__type__${t}`;
            cb.dataset.group = 'od';
            cb.dataset.odtype = t;
            cb.className = 'pbr-sig-cb mr-1';
            cb.checked = (t === 'od-720' || t === 'od-680');
            wrap.appendChild(cb);
            wrap.appendChild(document.createTextNode(t.replace('od-', 'OD').replace('-', '\u2009')));
            parent.appendChild(wrap);
        });
    }

    function _appendLightCompact(parent, cols) {
        // Extract unique wavelength labels
        const wavelengths = new Set();
        cols.forEach(c => {
            const m = c.match(/light-\d+-(.+)$/);
            if (m) wavelengths.add(m[1]);
        });
        const note = document.createElement('span');
        note.style.fontSize = '0.83em';
        note.style.color = '#555';
        note.textContent = `${cols.length} channels. Select wavelengths: `;
        parent.appendChild(note);
        [...wavelengths].sort().forEach(wl => {
            const wrap = document.createElement('label');
            wrap.className = 'pbr-signal-cb';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.value = `__wl__${wl}`;
            cb.dataset.group = 'light';
            cb.dataset.wl = wl;
            cb.className = 'pbr-sig-cb mr-1';
            cb.checked = false;
            wrap.appendChild(cb);
            wrap.appendChild(document.createTextNode(wl));
            parent.appendChild(wrap);
        });
        // Also add light-all if present
        if (cols.some(c => c === 'actinic-lights.light-all')) {
            _appendCheckbox(parent, 'actinic-lights.light-all', 'light', false);
        }
    }

    function _shortLabel(col) {
        // Clean up column name for display
        return col
            .replace('od-sensors.', '')
            .replace(/od-sensors-\d+\./, 'ch? · ')
            .replace(/actinic-lights\.light-/, 'light-')
            .replace('thermo.', '')
            .replace('probes.', '')
            .replace('flm.', '')
            .replace('pumps.', '')
            .replace('chemostat.', '')
            .replace('mc-airpump.', '')
            .replace('turbidostat.', '')
            .replace(/od-sensors-(\d+)\./g, (_, n) => `ch${n} · `);
    }

    function _onSignalChange() {
        _updateCorrectionPanelVisibility();
        updatePlot();
    }

    // ── OD Correction panel ────────────────────────────────────────────────
    function _buildCorrectionPanel(mcChannels) {
        const isMC = mcChannels.length > 0;
        const fmt  = document.getElementById('pbr-corr-fmt150');
        const mc   = document.getElementById('pbr-corr-mc1000');
        if (!fmt || !mc) return;

        if (isMC) {
            fmt.style.display = 'none';
            mc.style.display  = '';
            const strainWrap = document.getElementById('pbr-channel-strains');
            strainWrap.innerHTML = '';
            mcChannels.forEach(n => {
                const div = document.createElement('div');
                div.style.display = 'flex';
                div.style.alignItems = 'center';
                div.style.gap = '4px';
                const lbl = document.createElement('span');
                lbl.style.fontSize = '0.85em';
                lbl.style.whiteSpace = 'nowrap';
                // Coloured channel badge
                lbl.innerHTML = `<span style="display:inline-block;width:16px;height:16px;
                    border-radius:3px;background:${CH_COLORS[n-1]||'#17a2b8'};
                    vertical-align:middle;margin-right:3px;"></span>Ch${n}:`;
                const sel = document.createElement('select');
                sel.id = `pbr-strain-ch${n}`;
                sel.className = 'form-control form-control-sm';
                sel.style.width = '120px';
                sel.innerHTML = `<option value="FMT-150 WT">WT</option>
                                 <option value="FMT-150 EFE">EFE</option>`;
                sel.onchange = () => updatePlot();
                div.appendChild(lbl);
                div.appendChild(sel);
                strainWrap.appendChild(div);
            });
        } else {
            fmt.style.display = '';
            mc.style.display  = 'none';
        }
        _updateCorrectionPanelVisibility();
    }

    // Fixed ordered fields always shown in Experiment details panel
    const _INFO_FIELDS = [
        'name', 'start',
        'plannedDuration', 'plannedDurationSec',
        'duration', 'durationSec',
        'startedBy', 'stoppedBy',
        'inoculum', 'medium', 'organism', 'gassing',
        'notes', 'termination',
        'export time format', 'export time from', 'export time to',
    ];

    // ── Info panel ────────────────────────────────────────────────────────
    function _buildInfoPanel(info) {
        const detail = document.getElementById('pbr-info-details');
        const wrap   = document.getElementById('pbr-info-table-wrap');
        if (!detail || !wrap) return;
        detail.style.display = '';

        // Fixed fields first, then any extra keys from the file not in the list
        const shown  = new Set(_INFO_FIELDS);
        const extras = Object.keys(info || {}).filter(k => !shown.has(k));
        const allFields = [..._INFO_FIELDS, ...extras];

        const rows = allFields.map(k =>
            `<tr>` +
            `<td style="width:38%;color:#5a7a8a;font-weight:600;` +
            `padding:2px 10px 2px 0;white-space:nowrap;">${_esc(k)}</td>` +
            `<td style="padding:2px 0;">${_esc(String((info || {})[k] ?? ''))}</td></tr>`
        ).join('');
        wrap.innerHTML =
            `<table class="table table-sm table-borderless mb-0">` +
            `<tbody>${rows}</tbody></table>`;
    }

    // ── Events table ──────────────────────────────────────────────────────
    function _buildEventsTable() {
        const detail  = document.getElementById('pbr-events-details');
        const tbody   = document.getElementById('pbr-events-tbody');
        const countEl = document.getElementById('pbr-events-count');
        if (!detail || !tbody) return;
        const events = _state.events;
        if (!events || events.length === 0) { detail.style.display = 'none'; return; }
        detail.style.display = '';
        if (countEl) countEl.textContent = events.length;
        tbody.innerHTML = events.map(ev =>
            `<tr><td>${typeof ev.t === 'number' ? ev.t.toFixed(3) : ev.t}</td>` +
            `<td>${_esc(ev.user || '')}</td>` +
            `<td>${_esc(ev.msg  || '')}</td></tr>`
        ).join('');
    }

    function _esc(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ── Reset zoom ────────────────────────────────────────────────────────
    function resetZoom() {
        if (_state.chart) _state.chart.resetZoom();
    }

    function _updateCorrectionPanelVisibility() {
        const selected = _getSelectedColumns();
        const hasOD = selected.some(col => {
            const cl = col.toLowerCase();
            return cl.includes('od-720') || cl.includes('od-680');
        });
        const panel = document.getElementById('pbr-od-correction-panel');
        if (panel) panel.style.display = hasOD ? '' : 'none';
    }

    // ── Channel toggle ────────────────────────────────────────────────────
    function _toggleChannel(n, badge) {
        if (_state.activeChannels.has(n)) {
            _state.activeChannels.delete(n);
            badge.style.background  = '#fff';
            badge.style.borderColor = '#adb5bd';
            badge.style.color       = '#333';
        } else {
            _state.activeChannels.add(n);
            badge.style.background  = CH_COLORS[n - 1] || '#17a2b8';
            badge.style.borderColor = CH_COLORS[n - 1] || '#17a2b8';
            badge.style.color       = '#fff';
        }
        updatePlot();
    }

    function toggleAllChannels(on) {
        document.querySelectorAll('.pbr-channel-badge').forEach(badge => {
            const n = parseInt(badge.dataset.ch);
            if (on) {
                _state.activeChannels.add(n);
                badge.style.background  = CH_COLORS[n - 1] || '#17a2b8';
                badge.style.borderColor = CH_COLORS[n - 1] || '#17a2b8';
                badge.style.color       = '#fff';
            } else {
                _state.activeChannels.delete(n);
                badge.style.background  = '#fff';
                badge.style.borderColor = '#adb5bd';
                badge.style.color       = '#333';
            }
        });
        updatePlot();
    }

    // ── Resolve selected columns ──────────────────────────────────────────
    function _getSelectedColumns() {
        const isMC = _state.activeChannels.size > 0 &&
                     (_state.columnGroups.od || []).some(c => /od-sensors-\d+/.test(c));
        const result = [];

        document.querySelectorAll('.pbr-sig-cb:checked').forEach(cb => {
            const val  = cb.value;
            const grp  = cb.dataset.group;

            if (val.startsWith('__type__')) {
                // MC-1000 OD: expand to channel columns
                const sigType = val.replace('__type__', '');
                _state.activeChannels.forEach(n => {
                    const col = `od-sensors-${n}.${sigType}`;
                    if (_state.headers.includes(col)) result.push(col);
                });
            } else if (val.startsWith('__wl__')) {
                // MC-1000 light: expand to channel columns
                const wl = val.replace('__wl__', '');
                _state.activeChannels.forEach(n => {
                    const col = `actinic-lights.light-${n}-${wl}`;
                    if (_state.headers.includes(col)) result.push(col);
                });
            } else {
                result.push(val);
            }
        });
        return result;
    }

    // ── Strain for a column ───────────────────────────────────────────────
    function _getStrainForCol(col) {
        const isMC = (_state.columnGroups.od || []).some(c => /od-sensors-\d+/.test(c));
        if (isMC) {
            const m = col.match(/od-sensors-(\d+)\./);
            if (m) {
                const sel = document.getElementById(`pbr-strain-ch${m[1]}`);
                return sel ? sel.value : 'FMT-150 WT';
            }
            return 'MC-1000';
        }
        const sel = document.getElementById('pbr-strain-fmt150');
        return sel ? sel.value : 'FMT-150 WT';
    }

    function _getODType(col) {
        if (col.includes('od-720')) return '720';
        if (col.includes('od-680')) return '680';
        return null;
    }

    // ── Chart building ────────────────────────────────────────────────────
    function updatePlot() {
        const selectedCols = _getSelectedColumns();
        const timeVals     = _state.data.map(r => {
            const t = r['time'];
            return (typeof t === 'number') ? t : parseFloat(t) || 0;
        });

        const datasets = [];
        let dsIdx = 0;

        selectedCols.forEach(col => {
            const odType = _getODType(col);
            const isOD   = odType !== null;
            const chMatch = col.match(/od-sensors-(\d+)\./);
            const chIdx   = chMatch ? parseInt(chMatch[1]) - 1 : -1;
            const group   = _getGroupForCol(col);

            let baseColor;
            if (isOD && chIdx >= 0) {
                baseColor = odType === '720' ? CH_COLORS[chIdx] : CH_COLORS_LIGHT[chIdx];
            } else if (isOD) {
                // FMT-150 single OD
                baseColor = odType === '720' ? '#2563eb' : '#93c5fd';
            } else {
                baseColor = GROUP_COLORS[group] || '#6b7280';
            }

            const rawVals = _state.data.map(r => {
                const v = r[col];
                return (v !== null && v !== undefined && !isNaN(parseFloat(v)))
                    ? parseFloat(v) : null;
            });

            const strain    = isOD ? _getStrainForCol(col) : null;
            const corrVals  = isOD ? rawVals.map(v => applyODCorrection(v, strain, odType)) : null;
            const label     = _colLabel(col);
            const yAxis     = isOD ? 'y' : 'y1';
            const mode      = _state.showMode;

            if (isOD) {
                if (mode === 'raw' || mode === 'both') {
                    datasets.push({
                        label:           label + (mode === 'both' ? ' (raw)' : ''),
                        data:            timeVals.map((t, i) => ({ x: t, y: rawVals[i] })),
                        borderColor:     baseColor,
                        backgroundColor: 'transparent',
                        borderWidth:     1.5,
                        borderDash:      mode === 'both' ? [4, 3] : [],
                        pointRadius:     0,
                        spanGaps:        true,
                        yAxisID:         yAxis,
                        tension:         0,
                    });
                }
                if (mode === 'corrected' || mode === 'both') {
                    datasets.push({
                        label:           label + (mode === 'both' ? ' (corr.)' : ''),
                        data:            timeVals.map((t, i) => ({ x: t, y: corrVals[i] })),
                        borderColor:     baseColor,
                        backgroundColor: 'transparent',
                        borderWidth:     2,
                        borderDash:      [],
                        pointRadius:     0,
                        spanGaps:        true,
                        yAxisID:         yAxis,
                        tension:         0,
                    });
                }
            } else {
                // Non-OD signal
                const isLight = group === 'light';
                datasets.push({
                    label:           label,
                    data:            timeVals.map((t, i) => ({ x: t, y: rawVals[i] })),
                    borderColor:     baseColor,
                    backgroundColor: 'transparent',
                    borderWidth:     1.5,
                    pointRadius:     0,
                    spanGaps:        true,
                    yAxisID:         yAxis,
                    tension:         0,
                    // Light intensity changes are step functions, not ramps
                    stepped:         isLight ? 'before' : false,
                });
            }
            dsIdx++;
        });

        // ── Annotations ───────────────────────────────────────────────────
        const annotations = {};
        const hasOD720 = selectedCols.some(c => c.includes('od-720') && (_state.showMode !== 'corrected'));
        const hasOD680 = selectedCols.some(c => c.includes('od-680') && (_state.showMode !== 'corrected'));
        if (hasOD720) {
            annotations['thr720'] = {
                type: 'line', yScaleID: 'y',
                yMin: 0.4, yMax: 0.4,
                borderColor: 'rgba(245,158,11,0.6)',
                borderWidth: 1, borderDash: [6, 4],
                label: { content: 'OD₇₂₀ threshold (0.4)', display: true,
                         position: 'start', font: { size: 10 },
                         color: 'rgba(180,110,0,0.8)', backgroundColor: 'transparent' },
            };
        }
        if (hasOD680) {
            annotations['thr680'] = {
                type: 'line', yScaleID: 'y',
                yMin: 0.6, yMax: 0.6,
                borderColor: 'rgba(220,38,38,0.5)',
                borderWidth: 1, borderDash: [6, 4],
                label: { content: 'OD₆₈₀ threshold (0.6)', display: true,
                         position: 'start', font: { size: 10 },
                         color: 'rgba(160,0,0,0.8)', backgroundColor: 'transparent' },
            };
        }

        // Event vertical lines
        const showEvents = document.getElementById('pbr-show-events');
        if (showEvents && showEvents.checked && _state.events.length > 0) {
            _state.events.forEach((ev, i) => {
                annotations[`ev${i}`] = {
                    type:        'line',
                    xScaleID:    'x',
                    xMin:        ev.t,
                    xMax:        ev.t,
                    borderColor: 'rgba(100,100,100,0.35)',
                    borderWidth: 1,
                    borderDash:  [3, 3],
                    label: {
                        content:         ev.msg.substring(0, 60) || `Event ${i+1}`,
                        display:         false,   // shown on hover via tooltip instead
                        position:        'start',
                        font:            { size: 9 },
                        color:           '#444',
                        backgroundColor: 'rgba(255,255,255,0.85)',
                    },
                };
            });
        }

        // ── Merge μ-analysis overlays ─────────────────────────────────────
        // Merge µ-analysis annotations (mode-1 window boxes, event lines) into
        // the main chart, but do NOT add fit-line datasets — fits are shown only
        // in the dedicated µ analysis sub-charts (mode 2/3/4).
        const muOv = _muGetOverlays();
        Object.assign(annotations, muOv.annotations);

        // ── Build / update chart ──────────────────────────────────────────
        const ctx = document.getElementById('pbr-chart');
        if (!ctx) return;

        if (_state.chart) {
            _state.chart.data.datasets = datasets;
            _state.chart.options.plugins.annotation.annotations = annotations;
            _state.chart.update('none');
        } else {
            _state.chart = new Chart(ctx, {
                type: 'line',
                data: { datasets },
                options: {
                    animation:  false,
                    responsive: true,
                    interaction: { mode: 'index', intersect: false },
                    scales: {
                        x: {
                            type:  'linear',
                            title: { display: true, text: 'Time (h)', font: { size: 12 } },
                            ticks: { font: { size: 11 } },
                        },
                        y: {
                            type:     'linear',
                            position: 'left',
                            title:    { display: true, text: 'OD', font: { size: 12 } },
                            ticks:    { font: { size: 11 } },
                        },
                        y1: {
                            type:     'linear',
                            position: 'right',
                            title:    { display: true, text: 'Signal', font: { size: 12 } },
                            ticks:    { font: { size: 11 } },
                            grid:     { drawOnChartArea: false },
                        },
                    },
                    plugins: {
                        annotation: { annotations },
                        legend: {
                            labels: {
                                font: { size: 11 }, boxWidth: 16,
                                // hide internal sentinel labels; 'Growth rate fits' passes through
                                filter: (item) => !item.text.startsWith('__'),
                            },
                            onClick: (e, legendItem, legend) => {
                                const chart = legend.chart;
                                const ds    = chart.data.datasets[legendItem.datasetIndex];
                                const meta  = chart.getDatasetMeta(legendItem.datasetIndex);
                                if (ds._fitSentinel) {
                                    // toggle sentinel AND all hidden fit overlay datasets together
                                    const nowHidden = !meta.hidden;
                                    meta.hidden = nowHidden;
                                    chart.data.datasets.forEach((d, i) => {
                                        if (d.label === '__fit__')
                                            chart.getDatasetMeta(i).hidden = nowHidden;
                                    });
                                } else {
                                    meta.hidden = !meta.hidden;
                                }
                                chart.update('none');
                            },
                        },
                        tooltip: {
                            callbacks: {
                                title: (items) => `t = ${items[0].parsed.x.toFixed(3)} h`,
                                footer: (items) => {
                                    if (!_state.events || !_state.events.length) return [];
                                    const t = items[0].parsed.x;
                                    const near = _state.events.filter(ev =>
                                        Math.abs(ev.t - t) <= 0.15);
                                    return near.length
                                        ? near.map(ev => `📌 ${ev.msg || 'Event'}`)
                                        : [];
                                },
                            },
                        },
                        zoom: {
                            zoom: {
                                drag: {
                                    enabled:         true,
                                    backgroundColor: 'rgba(23,162,184,0.08)',
                                    borderColor:     'rgba(23,162,184,0.6)',
                                    borderWidth:     1,
                                },
                                wheel: {
                                    enabled: true,
                                    speed:   0.1,
                                },
                                pinch:     { enabled: true },
                                mode:      'xy',
                                scaleMode: 'xy',  // drag over an axis zooms that axis only
                            },

                        },
                    },
                },
            });
        }

        // Chart note
        const note = document.getElementById('pbr-chart-note');
        if (note) {
            note.textContent = _state.stride > 1
                ? `Chart shows every ${_state.stride}th row for performance. Export contains full data.`
                : '';
        }
    }

    function _getGroupForCol(col) {
        for (const [grp, cols] of Object.entries(_state.columnGroups)) {
            if (cols.includes(col)) return grp;
        }
        return 'other';
    }

    function _colLabel(col) {
        return col
            .replace('od-sensors.', '')
            .replace(/od-sensors-(\d+)\./, 'Ch$1 ')
            .replace('actinic-lights.', '')
            .replace('thermo.', '')
            .replace('probes.', '')
            .replace('flm.', '')
            .replace('pumps.', '')
            .replace('chemostat.', '')
            .replace('mc-airpump.', '')
            .replace('turbidostat.', '');
    }

    // ── Resolution (display row count) ───────────────────────────────────
    function changeResolution(maxRows) {
        if (!_state.cacheKey) return;
        if (maxRows === 0 && _state.totalRows > 50000) {
            if (!confirm(
                `Loading all ${_state.totalRows.toLocaleString()} rows may be slow. Continue?`
            )) {
                // Revert selector
                const sel = document.getElementById('pbr-resolution');
                if (sel) sel.value = String(_state.stride > 1 ? 3000 : 0);
                return;
            }
        }
        _setLoading(true);
        fetch('/pbr_analysis/data', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ cache_key: _state.cacheKey, max_rows: maxRows }),
        })
        .then(r => r.json())
        .then(resp => {
            _setLoading(false);
            if (resp.error) { _showError(resp.error); return; }
            _state.data        = resp.data || [];
            _state.displayRows = resp.display_rows;
            _state.stride      = resp.stride;
            _state.totalRows   = resp.total_rows;
            // Update info-bar row count
            const rowEl = document.getElementById('pbr-info-rows');
            if (rowEl) rowEl.textContent = resp.stride > 1
                ? `${resp.display_rows.toLocaleString()} of ${resp.total_rows.toLocaleString()} rows (stride ×${resp.stride})`
                : `${resp.total_rows.toLocaleString()} rows (full resolution)`;
            // Update chart note
            const note = document.getElementById('pbr-chart-note');
            if (note) note.textContent = resp.stride > 1
                ? `Chart shows every ${resp.stride}th row. Export always contains full data.`
                : '';
            // Update resolution note
            const resNote = document.getElementById('pbr-resolution-note');
            if (resNote) resNote.textContent = resp.stride > 1
                ? `(${resp.display_rows.toLocaleString()} pts shown)`
                : `(${resp.total_rows.toLocaleString()} pts shown)`;
            updatePlot();
        })
        .catch(err => {
            _setLoading(false);
            _showError('Failed to load data: ' + err.message);
        });
    }

    // ── Show mode ─────────────────────────────────────────────────────────
    function setShowMode(mode) {
        _state.showMode = mode;
        ['raw','corrected','both'].forEach(m => {
            const btn = document.getElementById(`pbr-show-${m}`);
            if (btn) btn.classList.toggle('active', m === mode);
        });
        updatePlot();
    }

    // ── Export ────────────────────────────────────────────────────────────
    function exportData() {
        if (!_state.cacheKey) { alert('No data loaded.'); return; }
        _showError(null);  // clear any stale error from a previous attempt

        // Build corrections map from current UI  { col: { device, type } }
        const corrections = {};
        _state.headers.forEach(col => {
            const odType = _getODType(col);
            if (!odType) return;
            corrections[col] = { device: _getStrainForCol(col), type: odType };
        });

        // ── Client-side XLSX path (all rows already in memory) ──────────────
        // Used whenever _state.data is the full dataset (default resolution).
        // Avoids a slow server round-trip + openpyxl write.
        if (typeof XLSX !== 'undefined' && _state.data.length >= _state.totalRows) {
            _setLoading(true);
            // Defer heavy work by one tick so the overlay renders first
            setTimeout(() => {
                try {
                    // ── Sheet 1 "Data": all raw columns, no corrected ──────────
                    const rawAoa = [_state.headers];
                    for (const row of _state.data) {
                        rawAoa.push(_state.headers.map(h => row[h] ?? null));
                    }

                    // ── Sheet 2 "OD data": time + raw OD + corrected OD ────────
                    // Corrected column sits immediately after each raw OD column.
                    const odHdrs = ['time'];
                    for (const h of _state.headers) {
                        if (corrections[h]) {
                            odHdrs.push(h);
                            odHdrs.push(h + '_corrected [' + corrections[h].device + ']');
                        }
                    }

                    const odAoa = [odHdrs];
                    for (const row of _state.data) {
                        const vals = [row['time'] ?? null];
                        for (const h of _state.headers) {
                            if (!corrections[h]) continue;
                            vals.push(row[h] ?? null);
                            const od = parseFloat(row[h]);
                            let corr = null;
                            if (!isNaN(od)) {
                                const { device, type } = corrections[h];
                                if (type === '720') {
                                    if (od <= 0.4) { corr = od; }
                                    else { const c = OD_CORR[device]; corr = c ? c['720'](od) : od; }
                                } else {
                                    if (od < 0.6) { corr = od; }
                                    else { const fn = OD680_CORR[device]; corr = fn ? fn(od) : od; }
                                }
                            }
                            vals.push(corr);
                        }
                        odAoa.push(vals);
                    }

                    const wb = XLSX.utils.book_new();
                    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rawAoa), 'Data');
                    if (odHdrs.length > 1) {  // only add OD sheet if file has OD columns
                        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(odAoa), 'OD data');
                    }

                    if (_state.events && _state.events.length > 0) {
                        const evKeys = Object.keys(_state.events[0]);
                        const evAoa  = [
                            evKeys,
                            ..._state.events.map(e => evKeys.map(k => e[k] ?? null)),
                        ];
                        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(evAoa), 'Events');
                    }

                    XLSX.writeFile(wb, `PBR_${_state.device || 'analysis'}_data.xlsx`);
                    _showExportSuccess('XLSX saved — check your Downloads folder.');
                } catch (e) {
                    _showError('Export failed: ' + e.message);
                } finally {
                    _setLoading(false);
                }
            }, 50);
            return;
        }

        // ── Server-side fallback (display is downsampled; need full data) ───
        const serverCorr = {};
        Object.entries(corrections).forEach(([col, info]) => {
            serverCorr[col] = { device: info.device, signal_type: `od-${info.type}` };
        });

        _setLoading(true);
        fetch('/pbr_analysis/export', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ cache_key: _state.cacheKey, corrections: serverCorr }),
        })
        .then(r => {
            _setLoading(false);
            if (!r.ok) return r.json().then(e => { throw new Error(e.error || r.statusText); });
            return r.blob();
        })
        .then(blob => {
            const url = URL.createObjectURL(blob);
            const a   = document.createElement('a');
            a.href    = url;
            a.download = `PBR_${_state.device || 'analysis'}_data.xlsx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        })
        .catch(err => { _setLoading(false); _showError('Export failed: ' + err.message); });
    }

    // ── Combined export (raw data + corrected OD + growth analysis) ──────
    async function exportAll() {
        if (!_state.cacheKey) { alert('No data loaded.'); return; }
        if (typeof XLSX === 'undefined') { alert('XLSX library not loaded.'); return; }

        const progWrap = document.getElementById('pbr-export-progress');
        const progBar  = document.getElementById('pbr-export-bar');
        const progMsg  = document.getElementById('pbr-export-msg');

        function setProgress(pct, msg) {
            if (progBar) progBar.style.width = pct + '%';
            if (progMsg) progMsg.textContent = msg;
        }

        if (progWrap) progWrap.style.display = '';
        setProgress(5, 'Fetching full dataset…');

        try {
            // Build corrections map (same as exportData)
            const corrections = {};
            _state.headers.forEach(col => {
                const odType = _getODType(col);
                if (!odType) return;
                const strain = _getStrainForCol(col);
                corrections[col] = { device: strain, signal_type: `od-${odType}` };
            });

            const resp = await fetch('/pbr_analysis/export', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ cache_key: _state.cacheKey, corrections }),
            });
            if (!resp.ok) {
                const e = await resp.json().catch(() => ({}));
                throw new Error(e.error || resp.statusText);
            }

            setProgress(40, 'Parsing data…');
            const blob = await resp.blob();
            const ab   = await blob.arrayBuffer();
            const wb   = XLSX.read(new Uint8Array(ab), { type: 'array' });

            setProgress(65, 'Adding growth analysis…');
            const basis = _muFitBasis === 'raw' ? 'raw' : 'corr';

            if (_muActiveMode === 1 && _muFits.length > 0) {
                const hdr  = ['Signal', 't-center (h)', 'Window (h)',
                              `mu (h-1) [${basis}]`, `td (h) [${basis}]`, 'R2', 'n'];
                const data = _muFits.flatMap(fg => fg.results.map(r => [
                    r.col, +fg.tCenter.toFixed(4), +fg.windowH.toFixed(4),
                    +r.mu.toFixed(5), r.mu > 0 ? +(Math.LN2 / r.mu).toFixed(3) : null,
                    +r.r2.toFixed(4), r.n,
                ]));
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Manual Fits µ');
            } else if (_muActiveMode === 2 && _muMode2Data) {
                const { results, odCols } = _muMode2Data;
                const ref  = results[odCols[0]] || [];
                const hdr  = ['t (h)',
                              ...odCols.map(c => `mu_${_colLabel(c)} (h-1) [${basis}]`),
                              ...odCols.map(c => `R2_${_colLabel(c)} [${basis}]`)];
                const data = ref.map((pt, i) => [
                    +pt.t.toFixed(4),
                    ...odCols.map(col => { const v = results[col][i]; return v && v.mu != null ? +v.mu.toFixed(5) : null; }),
                    ...odCols.map(col => { const v = results[col][i]; return v && v.r2 != null ? +v.r2.toFixed(4) : null; }),
                ]);
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Moving Window µ');
            } else if (_muActiveMode === 3 && _muMode3Rows) {
                const hdr  = ['Phase', 't start (h)', 't end (h)', 'dt (h)', 'Signal',
                              `mu (h-1) [${basis}]`, `td (h) [${basis}]`, 'R2', 'n'];
                const data = _muMode3Rows.map(r => [
                    r.phase, +r.tStart.toFixed(4), +r.tEnd.toFixed(4), +r.dur.toFixed(4),
                    r.col, +r.mu.toFixed(5), r.td != null ? +r.td.toFixed(3) : null,
                    +r.r2.toFixed(4), r.n,
                ]);
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Turbidostat µ');
            } else if (_muActiveMode === 4 && _muMode4Data) {
                const hdr  = ['Signal', 'Model', 'A (max OD)',
                              `µmax (h-1) [${basis}]`, `td (h) [${basis}]`,
                              `Lambda (h) [${basis}]`, 'R2', 'RMSE', 'n', 'Extra param'];
                const data = _muMode4Data.fits.map(f => {
                    const [A, mu, lam, p4] = f.params;
                    const xtra = f.model === 'baranyi'  ? `y0=${(p4 || 0).toFixed(4)}`
                               : f.model === 'richards' ? `nu=${(p4 || 0).toFixed(3)}` : '';
                    return [f.col, MODEL_LABELS[f.model] || f.model,
                            +A.toFixed(4), +mu.toFixed(5),
                            mu > 0 ? +(Math.LN2 / mu).toFixed(3) : null,
                            +lam.toFixed(4), +f.r2.toFixed(4), +f.rmse.toFixed(4), f.n, xtra];
                });
                XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Growth Curves');
            }

            setProgress(90, 'Writing file…');
            XLSX.writeFile(wb, `PBR_${_state.device || 'analysis'}_full.xlsx`);

            setProgress(100, 'Done!');
            setTimeout(() => { if (progWrap) progWrap.style.display = 'none'; }, 1200);

        } catch (err) {
            if (progWrap) progWrap.style.display = 'none';
            _showError('Combined export failed: ' + err.message);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    function _setLoading(on) {
        const ov = document.getElementById('pbr-loading-overlay');
        if (ov) ov.style.display = on ? 'flex' : 'none';
    }

    function _showError(msg) {
        const el = document.getElementById('pbr-error-banner');
        if (!el) return;
        if (msg) { el.textContent = msg; el.style.display = ''; }
        else        { el.style.display = 'none'; }
    }

    let _successTimer = null;
    function _showExportSuccess(msg) {
        const el = document.getElementById('pbr-error-banner');
        if (!el) return;
        el.className = 'alert alert-success';
        el.textContent = msg;
        el.style.display = '';
        clearTimeout(_successTimer);
        _successTimer = setTimeout(() => {
            el.style.display = 'none';
            el.className = 'alert alert-danger';
        }, 4000);
    }

    // ── Init ──────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        _initUpload();

        // Delegated change listener for all signal-selector checkboxes.
        // More reliable than per-element onchange because it survives DOM rebuilds
        // and catches events that bubble up from dynamically created inputs.
        const sigContainer = document.getElementById('pbr-signal-groups');
        if (sigContainer) {
            sigContainer.addEventListener('change', (e) => {
                if (e.target.classList.contains('pbr-sig-cb')) _onSignalChange();
            });
        }
        // Ensure loading overlay hidden on load
        const ov = document.getElementById('pbr-loading-overlay');
        if (ov) ov.style.display = 'none';
        // Click / double-click handling via pointerdown+pointerup so we can
        // measure drag distance and bypass the zoom plugin's event consumption.
        //   single click (no drag) → toggle nearest dataset
        //   double-click           → reset zoom
        const canvas = document.getElementById('pbr-chart');
        if (canvas) {
            let _ptDown  = null;
            let _lastUp  = 0;
            canvas.addEventListener('pointerdown', e => {
                _ptDown = { x: e.clientX, y: e.clientY };
            });
            canvas.addEventListener('pointerup', e => {
                if (!_ptDown) return;
                const dist = Math.hypot(e.clientX - _ptDown.x, e.clientY - _ptDown.y);
                _ptDown = null;
                if (dist > 5) return;          // genuine drag → let zoom handle it

                const now = Date.now();
                const dbl = now - _lastUp < 350;
                _lastUp = dbl ? 0 : now;

                if (dbl) {
                    if (_state.chart) _state.chart.resetZoom();
                    return;
                }

                // μ click mode: fit exponential centred at click position
                if (_muClickMode) {
                    const chart = _state.chart;
                    if (!chart) return;
                    const rect   = canvas.getBoundingClientRect();
                    const tClick = chart.scales.x.getValueForPixel(e.clientX - rect.left);
                    if (!isNaN(tClick)) _muHandleClick(tClick);
                    return;
                }

                // single click → toggle nearest visible dataset
                const chart = _state.chart;
                if (!chart) return;
                const found = chart.getElementsAtEventForMode(
                    e, 'nearest', { intersect: false }, false
                );
                if (!found.length) return;
                const idx = found[0].datasetIndex;
                if (chart.data.datasets[idx].label === '__hidden__') return;
                const meta = chart.getDatasetMeta(idx);
                meta.hidden = !meta.hidden;
                chart.update('none');
            });
        }
    });

    // ── Tooltip toggle ────────────────────────────────────────────────────
    function toggleTooltips(on) {
        if (!_state.chart) return;
        _state.chart.options.plugins.tooltip.enabled = on;
        _state.chart.update('none');
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── Nelder-Mead simplex optimizer (derivative-free) ───────────────────
    // ══════════════════════════════════════════════════════════════════════
    function _nmOptimize(fn, x0, opts) {
        opts    = opts || {};
        const n       = x0.length;
        const maxIter = opts.maxIter || 2000;
        const tol     = opts.tol    || 1e-9;
        const step    = opts.step   || x0.map(v => Math.abs(v) * 0.15 + 0.05);

        let sim = [x0.slice()];
        for (let i = 0; i < n; i++) {
            const v = x0.slice(); v[i] += step[i]; sim.push(v);
        }
        let fv = sim.map(v => fn(v));

        for (let iter = 0; iter < maxIter; iter++) {
            // Sort ascending by function value
            const ord = fv.map((f, i) => [f, i]).sort((a, b) => a[0] - b[0]);
            sim = ord.map(([, i]) => sim[i]);
            fv  = ord.map(([f]) => f);
            if (fv[n] - fv[0] < tol) break;

            // Centroid of all but worst vertex
            const xc = Array(n).fill(0);
            for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) xc[j] += sim[i][j] / n;

            // Reflect
            const xr = xc.map((c, j) => c + (c - sim[n][j]));
            const fr = fn(xr);
            if (fr < fv[0]) {
                // Expand
                const xe = xc.map((c, j) => c + 2 * (xr[j] - c));
                const fe = fn(xe);
                sim[n] = fe < fr ? xe : xr;
                fv[n]  = Math.min(fe, fr);
            } else if (fr < fv[n - 1]) {
                sim[n] = xr; fv[n] = fr;
            } else {
                // Contract
                const xk = xc.map((c, j) => c + 0.5 * (sim[n][j] - c));
                const fk = fn(xk);
                if (fk < fv[n]) { sim[n] = xk; fv[n] = fk; }
                else {
                    // Shrink
                    for (let i = 1; i <= n; i++) {
                        sim[i] = sim[0].map((v, j) => v + 0.5 * (sim[i][j] - v));
                        fv[i]  = fn(sim[i]);
                    }
                }
            }
        }
        return { params: sim[0], sse: fv[0] };
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── Growth curve model equations (Zwietering 1990 parameterisation) ──
    // ══════════════════════════════════════════════════════════════════════
    // All return predicted OD at time t.  p = [A, µmax, λ]  (+extra for 4-param)

    function _growthLogistic(t, p) {
        const [A, mu, lam] = p;
        if (A <= 0 || mu <= 0) return 1e9;
        return A / (1 + Math.exp((4 * mu / A) * (lam - t) + 2));
    }

    function _growthGompertz(t, p) {
        const [A, mu, lam] = p;
        if (A <= 0 || mu <= 0) return 1e9;
        return A * Math.exp(-Math.exp((mu * Math.E / A) * (lam - t) + 1));
    }

    // Baranyi-Roberts; p[3] = y0 (initial OD in range)
    function _growthBaranyi(t, p) {
        const [A, mu, lam, y0] = p;
        if (A <= 0 || mu <= 0 || y0 <= 0 || y0 >= A) return 1e9;
        const h0    = mu * lam;
        const inner = Math.exp(-mu * t) + Math.exp(-h0) - Math.exp(-mu * t - h0);
        if (inner <= 0) return 1e9;
        const At  = t + Math.log(inner) / mu;
        const lnN = Math.log(y0) + mu * At
                  - Math.log(1 + (Math.exp(mu * At) - 1) / Math.exp(Math.log(A) - Math.log(y0)));
        return isFinite(lnN) ? Math.exp(lnN) : 1e9;
    }

    // Richards (generalised logistic); p[3] = ν shape parameter (> 0)
    function _growthRichards(t, p) {
        const [A, mu, lam, nu] = p;
        if (A <= 0 || mu <= 0 || nu <= 0) return 1e9;
        const inner = 1 + nu * Math.exp(1 + nu) *
                      Math.exp(mu * (1 + nu) * (1 + 1 / nu) / A * (lam - t));
        if (!isFinite(inner) || inner <= 0) return 1e9;
        return A * Math.pow(inner, -1 / nu);
    }

    // ══════════════════════════════════════════════════════════════════════
    // ── Growth Rate Analysis (μ) ─────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════

    let _muClickMode = false;
    let _muFitBasis  = 'corrected'; // 'raw' | 'corrected' – which OD values are used for fitting
    let _muFits      = [];   // Mode 1: [{id, tCenter, windowH, results:[{col,mu,lnA,r2,n,fitPts,color}]}]
    let _muNextId    = 0;
    let _muChart2     = null;
    let _muChart3     = null;
    let _muMode2Data  = null; // { results, odCols }
    let _muMode3Rows  = null; // rows for export
    let _muMode3Ann   = {};   // phase box annotations
    let _muMode4Data  = null; // { fits:[{model,col,params,r2,rmse,n,fitPts}], odCols }
    let _muChart4     = null;
    let _muActiveMode = 1;    // currently visible tab (1–4)

    // ── Exponential fit (log-linear regression) ───────────────────────────
    function _expFit(times, values) {
        const pts = [];
        for (let i = 0; i < times.length; i++) {
            const t = times[i], v = values[i];
            if (t != null && !isNaN(+t) && v != null && !isNaN(+v) && +v > 0)
                pts.push([+t, +v]);
        }
        if (pts.length < 3) return null;
        const n = pts.length;
        const ts   = pts.map(p => p[0]);
        const lnVs = pts.map(p => Math.log(p[1]));
        const tMean  = ts.reduce((a, b) => a + b, 0) / n;
        const lnMean = lnVs.reduce((a, b) => a + b, 0) / n;
        let ssxy = 0, ssxx = 0;
        for (let i = 0; i < n; i++) {
            const dt = ts[i] - tMean;
            ssxy += dt * (lnVs[i] - lnMean);
            ssxx += dt * dt;
        }
        if (ssxx === 0) return null;
        const mu  = ssxy / ssxx;
        const lnA = lnMean - mu * tMean;
        let ssRes = 0, ssTot = 0;
        for (let i = 0; i < n; i++) {
            ssRes += (lnVs[i] - mu * ts[i] - lnA) ** 2;
            ssTot += (lnVs[i] - lnMean) ** 2;
        }
        return { mu, lnA, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1, n };
    }

    function _muFitCurvePoints(tMin, tMax, mu, lnA, nPts) {
        nPts = nPts || 60;
        const pts = [], step = (tMax - tMin) / (nPts - 1);
        for (let i = 0; i < nPts; i++) {
            const t = tMin + i * step;
            pts.push({ x: t, y: Math.exp(lnA + mu * t) });
        }
        return pts;
    }

    // ── Helpers ───────────────────────────────────────────────────────────
    function _muGetODCols() {
        return _getSelectedColumns().filter(col => _getODType(col) !== null);
    }

    function _muGetSignalColor(col) {
        const odType  = _getODType(col);
        const chMatch = col.match(/od-sensors-(\d+)\./);
        const chIdx   = chMatch ? parseInt(chMatch[1]) - 1 : -1;
        if (odType && chIdx >= 0)
            return odType === '720' ? CH_COLORS[chIdx] : CH_COLORS_LIGHT[chIdx];
        if (odType)
            return odType === '720' ? '#2563eb' : '#93c5fd';
        return GROUP_COLORS[_getGroupForCol(col)] || '#6b7280';
    }

    function _muGetFitColor(col) {
        const odType  = _getODType(col);
        const chMatch = col.match(/od-sensors-(\d+)\./);
        const chIdx   = chMatch ? parseInt(chMatch[1]) - 1 : -1;
        if (odType && chIdx >= 0)
            return odType === '720'
                ? FIT_COLORS[chIdx % FIT_COLORS.length]
                : FIT_COLORS_LIGHT[chIdx % FIT_COLORS_LIGHT.length];
        return odType === '720' ? '#f97316' : '#fdba74';
    }

    function _muExtractWindow(col, tMin, tMax) {
        const times = [], vals = [];
        const odType  = _getODType(col);
        // Use corrected values according to the dedicated fit-basis selector
        const useCorr = odType && _muFitBasis !== 'raw';
        const strain  = useCorr ? _getStrainForCol(col) : null;
        for (const row of _state.data) {
            const t = parseFloat(row['time']);
            if (isNaN(t) || t < tMin || t > tMax) continue;
            let v = parseFloat(row[col]);
            if (useCorr && !isNaN(v)) v = applyODCorrection(v, strain, odType);
            times.push(t);
            vals.push(isNaN(v) ? null : v);
        }
        return { times, vals };
    }

    // Returns extra datasets + annotations from all μ modes (merged in updatePlot)
    function _muGetOverlays() {
        const datasets    = [];
        const annotations = Object.assign({}, _muMode3Ann);

        // Common dataset properties for every fit overlay line
        const _fitDs = (data, color) => ({
            label:           '__fit__',   // hidden from legend; group-toggled via sentinel
            data,
            borderColor:     color,
            backgroundColor: 'transparent',
            borderWidth:     2.5,
            borderDash:      [4, 2],      // short cycle (6 px) visible at any zoom level
            pointRadius:     0,
            spanGaps:        true,
            yAxisID:         'y',
            tension:         0,
        });

        // Mode 1: box annotation + dashed fit line per fit group (shown on main chart
        // since mode 1 has no sub-chart of its own)
        _muFits.forEach(fg => {
            annotations[`mu_box_${fg.id}`] = {
                type: 'box',
                xMin: fg.tCenter - fg.windowH / 2,
                xMax: fg.tCenter + fg.windowH / 2,
                backgroundColor: 'rgba(16,163,127,0.07)',
                borderColor:     'rgba(16,163,127,0.5)',
                borderWidth:     1,
            };
            fg.results.forEach(r => datasets.push(_fitDs(r.fitPts, r.color)));
        });

        // Modes 2, 3, 4 have their own sub-charts — no overlays on the main chart.
        // Mode 3 phase boxes are still shown as annotations for spatial context.

        // ONE sentinel legend entry to group-toggle mode-1 fit lines
        if (_muFits.length > 0) {
            datasets.push({
                label:           'µ fits',
                data:            [],
                borderColor:     '#6b7280',
                backgroundColor: 'transparent',
                borderWidth:     2,
                borderDash:      [4, 2],
                pointRadius:     0,
                _fitSentinel:    true,
            });
        }

        return { datasets, annotations };
    }

    // Recalculate all active μ analyses when show-mode changes (raw ↔ corrected)
    function _muRefreshAll() {
        // Mode 1 – recalculate every stored manual fit group
        if (_muFits.length > 0) {
            _muFits = _muFits.map(fg => {
                const tMin = fg.tCenter - fg.windowH / 2;
                const tMax = fg.tCenter + fg.windowH / 2;
                const results = fg.results.reduce((acc, r) => {
                    const { times, vals } = _muExtractWindow(r.col, tMin, tMax);
                    const fit = _expFit(times, vals);
                    if (fit) acc.push({
                        ...r,
                        mu: fit.mu, lnA: fit.lnA, r2: fit.r2, n: fit.n,
                        fitPts: _muFitCurvePoints(tMin, tMax, fit.mu, fit.lnA),
                    });
                    return acc;
                }, []);
                return { ...fg, results };
            });
            _muRefreshTable1();
        }
        // Mode 2 – re-run with the same window/step (reads current UI inputs)
        if (_muMode2Data) _muRunMode2();
        // Mode 3 – re-run if there are existing results and OD cols are still selected
        if (_muMode3Rows && _muGetODCols().length > 0) _muRunMode3();
        // Mode 4 – re-run with same range / model selections
        if (_muMode4Data && _muGetODCols().length > 0) _muRunMode4();
        // Update basis badge (mode 2/3/4 calls above already call _muUpdateBasisNote,
        // but do it here too for the mode-1-only case)
        _muUpdateBasisNote();
    }

    // ── Mode 1: manual click-to-fit ───────────────────────────────────────
    function _muToggleClickMode() {
        _muClickMode = !_muClickMode;
        // Disable zoom drag while in click mode so clicks register cleanly
        if (_state.chart) {
            _state.chart.options.plugins.zoom.zoom.drag.enabled = !_muClickMode;
            _state.chart.update('none');
        }
        const btn = document.getElementById('pbr-mu-click-btn');
        if (!btn) return;
        if (_muClickMode) {
            btn.classList.remove('btn-outline-secondary');
            btn.classList.add('btn-info');
            btn.textContent = '⏹ Click mode ON – click chart to fit';
        } else {
            btn.classList.remove('btn-info');
            btn.classList.add('btn-outline-secondary');
            btn.textContent = '✏ Enable click mode';
        }
    }

    function _muHandleClick(tClick) {
        const wEl = document.getElementById('pbr-mu-window1');
        // Input is in minutes; convert to hours for internal calculations
        const windowH = wEl && parseFloat(wEl.value) > 0 ? parseFloat(wEl.value) / 60 : 2;
        _muAddFitGroup(tClick, windowH);
    }

    function _muAddFitGroup(tCenter, windowH) {
        const odCols = _muGetODCols();
        if (odCols.length === 0) {
            alert('No OD signals selected. Please select OD720 or OD680 signals first.');
            return;
        }
        const tMin = tCenter - windowH / 2;
        const tMax = tCenter + windowH / 2;
        const id   = _muNextId++;
        const results = [];
        odCols.forEach(col => {
            const { times, vals } = _muExtractWindow(col, tMin, tMax);
            const fit = _expFit(times, vals);
            if (!fit) return;
            results.push({
                col, mu: fit.mu, lnA: fit.lnA, r2: fit.r2, n: fit.n,
                fitPts: _muFitCurvePoints(tMin, tMax, fit.mu, fit.lnA),
                color:  _muGetFitColor(col),
            });
        });
        if (results.length === 0) {
            alert('Not enough valid OD data in the selected window (≥ 3 points required).');
            return;
        }
        _muFits.push({ id, tCenter, windowH, results });
        _muRefreshTable1();
        _muUpdateBasisNote();
        updatePlot();
    }

    function _muRemoveFitGroup(id) {
        _muFits = _muFits.filter(fg => fg.id !== id);
        _muRefreshTable1();
        updatePlot();
    }

    function _muClearFits() {
        _muFits = [];
        _muRefreshTable1();
        updatePlot();
    }

    function _muRefreshTable1() {
        const tbody  = document.getElementById('pbr-mu-tbody1');
        const wrap   = document.getElementById('pbr-mu-table1-wrap');
        const expBtn = document.getElementById('pbr-mu-export1-btn');
        if (!tbody || !wrap) return;
        if (_muFits.length === 0) {
            wrap.style.display = 'none';
            if (expBtn) expBtn.style.display = 'none';
            tbody.innerHTML = '';
            return;
        }
        wrap.style.display = '';
        if (expBtn) expBtn.style.display = '';
        tbody.innerHTML = _muFits.flatMap(fg =>
            fg.results.map((r, ri) => {
                const td_h  = r.mu > 0 ? (Math.LN2 / r.mu).toFixed(2) : '—';
                const warnCls = r.r2 < 0.8 ? ' class="table-warning"' : '';
                const delBtn  = ri === 0
                    ? `<button class="btn btn-xs btn-outline-danger"
                               style="font-size:0.75em;padding:1px 5px;"
                               onclick="PBR.muRemoveFitGroup(${fg.id})">✕</button>`
                    : '';
                return `<tr${warnCls}>
                    <td style="font-size:0.82em;">
                        <span style="display:inline-block;width:12px;height:12px;border-radius:2px;
                              background:${r.color};vertical-align:middle;margin-right:4px;"></span>
                        ${_colLabel(r.col)}</td>
                    <td>${fg.tCenter.toFixed(3)}</td>
                    <td>${fg.windowH.toFixed(2)}</td>
                    <td><strong>${r.mu.toFixed(4)}</strong></td>
                    <td>${td_h}</td>
                    <td style="color:${r.r2 < 0.8 ? '#c0392b' : 'inherit'}">${r.r2.toFixed(3)}</td>
                    <td>${r.n}</td>
                    <td>${delBtn}</td>
                </tr>`;
            })
        ).join('');
    }

    // ── Mode 2: moving window ─────────────────────────────────────────────
    function _muRunMode2() {
        // Inputs are in minutes; convert to hours for internal calculations
        const windowH = (parseFloat(document.getElementById('pbr-mu-window2').value) || 120) / 60;
        const stepH   = (parseFloat(document.getElementById('pbr-mu-step2').value)   || 30)  / 60;
        const odCols  = _muGetODCols();
        if (odCols.length === 0) { alert('No OD signals selected.'); return; }
        if (_state.data.length === 0) return;
        const allTs = _state.data.map(r => parseFloat(r['time'])).filter(t => !isNaN(t));
        const tMin  = Math.min(...allTs), tMax = Math.max(...allTs);
        const centers = [];
        for (let t = tMin + windowH / 2; t <= tMax - windowH / 2 + 1e-9; t += stepH)
            centers.push(t);
        if (centers.length === 0) { alert('Time range too short for the specified window and step.'); return; }

        const spinner = document.getElementById('pbr-mu2-spinner');
        const runBtn  = document.querySelector('#pbr-mu-mode2 button.btn-primary');
        if (spinner) spinner.style.display = 'flex';
        if (runBtn)  { runBtn.disabled = true; runBtn.textContent = '⏳ Calculating…'; }

        setTimeout(() => {
            try {
                const results = {};
                odCols.forEach(col => {
                    results[col] = centers.map(tc => {
                        const { times, vals } = _muExtractWindow(col, tc - windowH / 2, tc + windowH / 2);
                        const fit = _expFit(times, vals);
                        return { t: tc, mu: fit ? fit.mu : null, r2: fit ? fit.r2 : null };
                    });
                });
                _muMode2Data = { results, odCols, windowH, stepH };
                _muBuildChart2(results, odCols);
                _muUpdateBasisNote();
                const expBtn = document.getElementById('pbr-mu-export2-btn');
                if (expBtn) expBtn.style.display = '';
            } finally {
                if (spinner) spinner.style.display = 'none';
                if (runBtn)  { runBtn.disabled = false; runBtn.textContent = '▶ Calculate'; }
            }
        }, 20);
    }

    function _muBuildChart2(results, odCols) {
        const wrap = document.getElementById('pbr-mu-chart2-wrap');
        if (!wrap) return;
        wrap.style.display = '';
        if (_muChart2) { _muChart2.destroy(); _muChart2 = null; }
        const datasets = odCols.map(col => ({
            label:           _colLabel(col),
            data:            (results[col] || []).map(r => ({ x: r.t, y: r.mu })),
            borderColor:     _muGetSignalColor(col),
            backgroundColor: 'transparent',
            borderWidth:     1.5,
            pointRadius:     2,
            pointHoverRadius:4,
            spanGaps:        false,
            tension:         0.2,
        }));
        _muChart2 = new Chart(document.getElementById('pbr-mu-chart2'), {
            type: 'line',
            data: { datasets },
            options: {
                animation:   false,
                responsive:  true,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { type: 'linear',
                         title: { display: true, text: 'Time (h)', font: { size: 11 } },
                         ticks: { font: { size: 10 } } },
                    y: { type: 'linear',
                         title: { display: true, text: 'μ (h⁻¹)', font: { size: 11 } },
                         ticks: { font: { size: 10 } } },
                },
                plugins: {
                    legend: { labels: { font: { size: 11 }, boxWidth: 14 } },
                    tooltip: {
                        callbacks: {
                            title: items => `t = ${items[0].parsed.x.toFixed(3)} h`,
                            label: item  => `${item.dataset.label}: μ = ${
                                item.parsed.y != null ? item.parsed.y.toFixed(4) : 'N/A'} h⁻¹`,
                        },
                    },
                    zoom: {
                        zoom: {
                            drag: {
                                enabled:         true,
                                backgroundColor: 'rgba(23,162,184,0.08)',
                                borderColor:     'rgba(23,162,184,0.6)',
                                borderWidth:     1,
                            },
                            wheel: { enabled: true, speed: 0.1 },
                            pinch: { enabled: true },
                            mode: 'xy',
                        },
                    },
                },
            },
        });
    }

    function _muResetZoom2() { if (_muChart2) _muChart2.resetZoom(); }

    // Toggle visibility of all datasets in the moving-window µ chart
    function _muToggleAllLines2() {
        const chart = _muChart2;
        if (!chart) return;
        const anyVisible = chart.data.datasets.some(ds => !ds.hidden);
        chart.data.datasets.forEach(ds => { ds.hidden = anyVisible; });
        chart.update();
    }

    // ── Mode 3: turbidostat ───────────────────────────────────────────────
    function _muBuildChart3(rows, odCols) {
        const wrap = document.getElementById('pbr-mu-chart3-wrap');
        if (!wrap) return;
        if (rows.length === 0) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        if (_muChart3) { _muChart3.destroy(); _muChart3 = null; }

        const datasets = odCols.map(col => {
            const colRows = rows.filter(r => r.col === col);
            const color   = _muGetSignalColor(col);
            return {
                label:           _colLabel(col),
                data:            colRows.map(r => ({ x: (r.tStart + r.tEnd) / 2, y: r.mu })),
                borderColor:     color,
                backgroundColor: color,
                borderWidth:     1.5,
                pointRadius:     5,
                pointHoverRadius:7,
                spanGaps:        false,
                showLine:        true,
                tension:         0,
            };
        });

        _muChart3 = new Chart(document.getElementById('pbr-mu-chart3'), {
            type: 'scatter',
            data: { datasets },
            options: {
                animation:   false,
                responsive:  true,
                interaction: { mode: 'nearest', intersect: false },
                scales: {
                    x: { type: 'linear',
                         title: { display: true, text: 'Time (h)', font: { size: 11 } },
                         ticks: { font: { size: 10 } } },
                    y: { type: 'linear',
                         title: { display: true, text: 'μ (h⁻¹)', font: { size: 11 } },
                         ticks: { font: { size: 10 } } },
                },
                plugins: {
                    legend: { labels: { font: { size: 11 }, boxWidth: 14 } },
                    tooltip: {
                        callbacks: {
                            title: items => `t = ${items[0].parsed.x.toFixed(3)} h`,
                            label: item  => `${item.dataset.label}: μ = ${
                                item.parsed.y != null ? item.parsed.y.toFixed(4) : 'N/A'} h⁻¹`,
                        },
                    },
                    zoom: {
                        zoom: {
                            drag: {
                                enabled:         true,
                                backgroundColor: 'rgba(23,162,184,0.08)',
                                borderColor:     'rgba(23,162,184,0.6)',
                                borderWidth:     1,
                            },
                            wheel: { enabled: true, speed: 0.1 },
                            pinch: { enabled: true },
                            mode: 'xy',
                        },
                    },
                },
            },
        });
    }

    function _muResetZoom3() { if (_muChart3) _muChart3.resetZoom(); }

    // ── Mode 4: Growth curve model fitting ────────────────────────────────

    // Auto-estimate initial parameters from the data window
    function _muAutoGuess4(col, tMin, tMax) {
        const pts = [];
        const odType  = _getODType(col);
        const useCorr = odType && _muFitBasis !== 'raw';
        const strain  = useCorr ? _getStrainForCol(col) : null;
        for (const row of _state.data) {
            const t = parseFloat(row['time']);
            if (isNaN(t) || t < tMin || t > tMax) continue;
            let v = parseFloat(row[col]);
            if (useCorr && !isNaN(v)) v = applyODCorrection(v, strain, odType);
            if (!isNaN(v) && v > 0) pts.push({ t, v });
        }
        if (pts.length < 4) return null;

        const A  = Math.max(...pts.map(p => p.v)) * 1.05;
        const n0 = Math.max(1, Math.floor(pts.length * 0.05));
        const y0 = pts.slice(0, n0).reduce((s, p) => s + p.v, 0) / n0;

        // Locate inflection (max finite-difference)
        let maxDiff = -Infinity, inflT = pts[Math.floor(pts.length / 2)].t;
        for (let i = 1; i < pts.length; i++) {
            const dt = pts[i].t - pts[i - 1].t;
            const d  = dt > 0 ? (pts[i].v - pts[i - 1].v) / dt : 0;
            if (d > maxDiff) { maxDiff = d; inflT = (pts[i].t + pts[i - 1].t) / 2; }
        }

        // µmax from log-linear fit near inflection
        const iw  = Math.max(2, Math.floor(pts.length * 0.10));
        const ifl = pts.findIndex(p => p.t >= inflT);
        const win = pts.slice(Math.max(0, ifl - iw), Math.min(pts.length, ifl + iw));
        let mu = 0.5;
        if (win.length >= 3) {
            const ef = _expFit(win.map(p => p.t), win.map(p => p.v));
            if (ef && ef.mu > 0) mu = ef.mu;
        }
        const lam = Math.max(tMin, inflT - A / (4 * mu));
        return { A: Math.max(A, 0.01), mu: Math.max(mu, 0.01), lam, y0: Math.max(y0, 0.001) };
    }

    // Fit a single model to one column; returns fit object or null
    function _muFitModel(col, tMin, tMax, modelKey) {
        let pts = [];
        const odType  = _getODType(col);
        const useCorr = odType && _muFitBasis !== 'raw';
        const strain  = useCorr ? _getStrainForCol(col) : null;
        for (const row of _state.data) {
            const t = parseFloat(row['time']);
            if (isNaN(t) || t < tMin || t > tMax) continue;
            let v = parseFloat(row[col]);
            if (useCorr && !isNaN(v)) v = applyODCorrection(v, strain, odType);
            if (!isNaN(v)) pts.push([t, v]);
        }
        if (pts.length < 5) return null;

        // Subsample for optimizer efficiency: max 400 pts, evenly spaced
        if (pts.length > 400) {
            const stride = Math.ceil(pts.length / 400);
            pts = pts.filter((_, i) => i % stride === 0);
        }

        const g = _muAutoGuess4(col, tMin, tMax);
        if (!g) return null;

        const modelFns = { logistic: _growthLogistic, gompertz: _growthGompertz,
                           baranyi: _growthBaranyi,   richards: _growthRichards };
        const mfn = modelFns[modelKey];
        if (!mfn) return null;

        const is4 = modelKey === 'baranyi' || modelKey === 'richards';
        const x0  = is4 ? [g.A, g.mu, g.lam, modelKey === 'baranyi' ? g.y0 : 1.0]
                        : [g.A, g.mu, g.lam];

        const objFn = (p) => {
            if (p[0] <= 0 || p[1] <= 0) return 1e12;
            if (is4 && (modelKey === 'baranyi' ? (p[3] <= 0 || p[3] >= p[0]) : p[3] <= 0)) return 1e12;
            let sse = 0;
            for (const [t, v] of pts) {
                const pred = mfn(t, p);
                if (!isFinite(pred)) return 1e12;
                sse += (pred - v) ** 2;
            }
            return sse;
        };

        const step = is4
            ? [g.A * 0.15, g.mu * 0.15, Math.max(0.1, Math.abs(g.lam) * 0.15),
               modelKey === 'baranyi' ? g.y0 * 0.2 : 0.3]
            : [g.A * 0.15, g.mu * 0.15, Math.max(0.1, Math.abs(g.lam) * 0.15)];

        const result = _nmOptimize(objFn, x0, { step, maxIter: 3000 });
        const params = result.params;
        if (params[0] <= 0 || params[1] <= 0) return null;

        const vMean = pts.reduce((s, [, v]) => s + v, 0) / pts.length;
        let ssTot = 0;
        pts.forEach(([, v]) => { ssTot += (v - vMean) ** 2; });
        const r2   = ssTot > 0 ? Math.max(0, 1 - result.sse / ssTot) : 1;
        const rmse = Math.sqrt(result.sse / pts.length);

        // Clip fit curve to start from the minimum observed OD (prevents
        // the model from showing OD ≈ 0 where data starts at a higher value)
        const yObs = pts.map(([, v]) => v).filter(v => v > 0);
        const yMin = yObs.length ? Math.min(...yObs) * 0.95 : 0;

        const fitPts = [];
        for (let i = 0; i < 120; i++) {
            const t = tMin + i * (tMax - tMin) / 119;
            const y = mfn(t, params);
            if (isFinite(y) && y >= yMin && y < 1e8) fitPts.push({ x: t, y });
        }
        return { model: modelKey, col, params, sse: result.sse, r2, rmse, n: pts.length, fitPts };
    }

    function _muRunMode4() {
        // ── Validation (fast – before showing spinner) ─────────────────────
        const allTs = _state.data.map(r => parseFloat(r['time'])).filter(t => !isNaN(t));
        if (!allTs.length) return;
        const t0El  = document.getElementById('pbr-mu4-t0');
        const t1El  = document.getElementById('pbr-mu4-t1');
        const tMin  = t0El && t0El.value !== '' ? parseFloat(t0El.value) : Math.min(...allTs);
        const tMax  = t1El && t1El.value !== '' ? parseFloat(t1El.value) : Math.max(...allTs);
        if (isNaN(tMin) || isNaN(tMax) || tMax <= tMin) { alert('Invalid time range.'); return; }

        const odCols = _muGetODColsMode4();
        if (odCols.length === 0) {
            alert('No OD signals selected. Choose an OD type or enable at least one channel above.'); return;
        }

        const modelEl  = document.querySelector('input[name="pbr-mu4-model"]:checked');
        const modelKey = modelEl ? modelEl.value : 'logistic';

        // ── Show spinner, defer heavy computation so browser can render ─────
        const spinner = document.getElementById('pbr-mu4-spinner');
        const fitBtn  = document.getElementById('pbr-mu4-fit-btn');
        if (spinner) spinner.style.display = 'flex';
        if (fitBtn)  { fitBtn.disabled = true; fitBtn.textContent = '\u23F3 Fitting\u2026'; }

        setTimeout(() => {
            try {
                const fits = [];
                odCols.forEach(col => {
                    const fit = _muFitModel(col, tMin, tMax, modelKey);
                    if (fit) fits.push(fit);
                });
                _muMode4Data = { fits, odCols, tMin, tMax };
                _muBuildChart4(fits, odCols, tMin, tMax);
                _muBuildTable4(fits);
                _muUpdateBasisNote();
                updatePlot();
                const expBtn = document.getElementById('pbr-mu-export4-btn');
                if (expBtn) expBtn.style.display = fits.length > 0 ? '' : 'none';
            } finally {
                if (spinner) spinner.style.display = 'none';
                if (fitBtn)  { fitBtn.disabled = false; fitBtn.textContent = '\u25B6 Fit model'; }
            }
        }, 20);
    }

    function _muBuildChart4(fits, odCols, tMin, tMax) {
        const wrap = document.getElementById('pbr-mu-chart4-wrap');
        if (!wrap) return;
        if (!fits.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        if (_muChart4) { _muChart4.destroy(); _muChart4 = null; }

        const datasets = [];
        // Observed data points (scatter)
        odCols.forEach(col => {
            const odType  = _getODType(col);
            const useCorr = odType && _muFitBasis !== 'raw';
            const strain  = useCorr ? _getStrainForCol(col) : null;
            const obs = [];
            for (const row of _state.data) {
                const t = parseFloat(row['time']);
                if (isNaN(t) || t < tMin || t > tMax) continue;
                let v = parseFloat(row[col]);
                if (useCorr && !isNaN(v)) v = applyODCorrection(v, strain, odType);
                if (!isNaN(v)) obs.push({ x: t, y: v });
            }
            datasets.push({
                label:           _colLabel(col) + ' (obs.)',
                data:            obs,
                borderColor:     _muGetSignalColor(col),
                backgroundColor: _muGetSignalColor(col),
                borderWidth:     0,
                pointRadius:     2,
                pointHoverRadius:4,
                showLine:        false,
            });
        });
        // Fitted curves — color matches the signal, dash pattern identifies the model
        fits.forEach(f => {
            datasets.push({
                label:           `${_colLabel(f.col)} – ${MODEL_LABELS[f.model]} fit`,
                data:            f.fitPts,
                borderColor:     _muGetSignalColor(f.col),
                backgroundColor: 'transparent',
                borderWidth:     2.5,
                borderDash:      [6, 3],
                pointRadius:     0,
                spanGaps:        true,
                showLine:        true,
                tension:         0,
            });
        });

        _muChart4 = new Chart(document.getElementById('pbr-mu-chart4'), {
            type: 'line',
            data: { datasets },
            options: {
                animation:   false,
                responsive:  true,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { type: 'linear',
                         title: { display: true, text: 'Time (h)', font: { size: 11 } },
                         ticks: { font: { size: 10 } } },
                    y: { type: 'linear',
                         title: { display: true, text: 'OD', font: { size: 11 } },
                         ticks: { font: { size: 10 } } },
                },
                plugins: {
                    legend: { labels: { font: { size: 10 }, boxWidth: 14 } },
                    tooltip: { callbacks: { title: items => `t = ${items[0].parsed.x.toFixed(3)} h` } },
                    zoom: {
                        zoom: {
                            drag: { enabled: true, backgroundColor: 'rgba(23,162,184,0.08)',
                                    borderColor: 'rgba(23,162,184,0.6)', borderWidth: 1 },
                            wheel: { enabled: true, speed: 0.1 },
                            pinch: { enabled: true },
                            mode: 'xy',
                        },
                    },
                },
            },
        });
    }

    function _muBuildTable4(fits) {
        const wrap  = document.getElementById('pbr-mu4-table-wrap');
        const tbody = document.getElementById('pbr-mu4-tbody');
        if (!wrap || !tbody) return;
        if (!fits.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        tbody.innerHTML = fits.map(f => {
            const [A, mu, lam, p4] = f.params;
            const td   = mu > 0 ? (Math.LN2 / mu).toFixed(2) : '—';
            const cls  = f.r2 < 0.9 ? ' class="table-warning"' : '';
            const xtra = f.model === 'baranyi'  ? `y₀ = ${(p4 || 0).toFixed(4)}`
                       : f.model === 'richards' ? `ν = ${(p4 || 0).toFixed(3)}` : '';
            return `<tr${cls}>
                <td style="font-size:0.82em;">${_colLabel(f.col)}</td>
                <td><span style="display:inline-block;width:10px;height:2px;border-radius:1px;
                    background:${_muGetSignalColor(f.col)};border-bottom:2px dashed ${_muGetSignalColor(f.col)};
                    vertical-align:middle;margin-right:3px;"></span>
                    ${MODEL_LABELS[f.model]}</td>
                <td>${A.toFixed(3)}</td>
                <td><strong>${mu.toFixed(4)}</strong></td>
                <td>${td}</td>
                <td>${lam.toFixed(3)}</td>
                <td style="color:${f.r2 < 0.9 ? '#c0392b' : 'inherit'}">${f.r2.toFixed(4)}</td>
                <td>${f.rmse.toFixed(4)}</td>
                <td>${f.n}</td>
                <td style="font-size:0.8em;color:#888;">${xtra}</td>
            </tr>`;
        }).join('');
    }

    function _muResetZoom4() { if (_muChart4) _muChart4.resetZoom(); }

    // Build the OD-type radio + channel badge selector inside the mode4 pane
    function _muBuildMode4Selector() {
        const wrap = document.getElementById('pbr-mu4-signal-sel');
        if (!wrap) return;
        wrap.innerHTML = '';
        const odCols = (_state.columnGroups.od || []);
        if (!odCols.length) return;

        const isMC   = odCols.some(c => /od-sensors-\d+/.test(c));
        const has720 = odCols.some(c => c.includes('od-720'));
        const has680 = odCols.some(c => c.includes('od-680'));

        // ── OD type radio ──────────────────────────────────────────────────
        const typeRow = document.createElement('div');
        typeRow.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:0.35em;';
        const typeLabel = document.createElement('span');
        typeLabel.textContent = 'Fit signal:';
        typeLabel.style.cssText = 'font-size:0.82em;color:#555;white-space:nowrap;';
        typeRow.appendChild(typeLabel);

        const types = [];
        if (has720) types.push({ value: '720', text: 'OD\u2087\u2082\u2080' });
        if (has680) types.push({ value: '680', text: 'OD\u2086\u2088\u2080' });
        if (has720 && has680) types.push({ value: 'both', text: 'Both' });
        types.forEach((t, i) => {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'font-size:0.82em;margin:0;display:flex;align-items:center;gap:3px;cursor:pointer;';
            const rb = document.createElement('input');
            rb.type = 'radio'; rb.name = 'pbr-mu4-odtype'; rb.value = t.value;
            if (i === 0) rb.checked = true;
            lbl.appendChild(rb);
            lbl.appendChild(document.createTextNode(t.text));
            typeRow.appendChild(lbl);
        });
        wrap.appendChild(typeRow);

        // ── Channel badges (MC-1000 only) ──────────────────────────────────
        if (isMC) {
            const channels = _extractChannelNumbers(odCols);
            const chRow = document.createElement('div');
            chRow.style.cssText = 'display:flex;align-items:center;gap:5px;flex-wrap:wrap;';
            const chLabel = document.createElement('span');
            chLabel.textContent = 'Channels:';
            chLabel.style.cssText = 'font-size:0.82em;color:#555;white-space:nowrap;';
            chRow.appendChild(chLabel);

            channels.forEach(n => {
                const badge = document.createElement('div');
                badge.className = 'pbr-channel-badge active pbr-mu4-ch-badge';
                badge.dataset.ch = n;
                badge.title = `Channel ${n}`;
                badge.style.background  = CH_COLORS[n - 1] || '#17a2b8';
                badge.style.borderColor = CH_COLORS[n - 1] || '#17a2b8';
                badge.style.color = '#fff';
                badge.textContent = n;
                badge.onclick = () => {
                    const on = !badge.classList.contains('active');
                    badge.classList.toggle('active', on);
                    badge.style.background  = on ? (CH_COLORS[n-1]||'#17a2b8') : '#fff';
                    badge.style.borderColor = on ? (CH_COLORS[n-1]||'#17a2b8') : '#adb5bd';
                    badge.style.color       = on ? '#fff' : '#333';
                };
                chRow.appendChild(badge);
            });

            const mkChBtn = (txt, active) => {
                const b = document.createElement('button');
                b.className = 'btn btn-xs btn-outline-secondary';
                b.style.cssText = 'font-size:0.78em;padding:1px 6px;';
                b.textContent = txt;
                b.onclick = () => chRow.querySelectorAll('.pbr-mu4-ch-badge').forEach(badge => {
                    const n = parseInt(badge.dataset.ch);
                    badge.classList.toggle('active', active);
                    badge.style.background  = active ? (CH_COLORS[n-1]||'#17a2b8') : '#fff';
                    badge.style.borderColor = active ? (CH_COLORS[n-1]||'#17a2b8') : '#adb5bd';
                    badge.style.color       = active ? '#fff' : '#333';
                });
                return b;
            };
            chRow.appendChild(mkChBtn('All', true));
            chRow.appendChild(mkChBtn('None', false));
            wrap.appendChild(chRow);
        }
    }

    // Returns OD columns to fit, respecting the mode4 type-radio + channel badges
    function _muGetODColsMode4() {
        const odCols = (_state.columnGroups.od || []);
        const isMC   = odCols.some(c => /od-sensors-\d+/.test(c));
        const typeEl = document.querySelector('input[name="pbr-mu4-odtype"]:checked');
        const type   = typeEl ? typeEl.value : 'both';

        return odCols.filter(col => {
            const odType = _getODType(col);
            if (!odType) return false;
            if (type !== 'both' && odType !== type) return false;
            if (isMC) {
                const m = col.match(/od-sensors-(\d+)\./);
                if (m) {
                    const badge = document.querySelector(`.pbr-mu4-ch-badge[data-ch="${m[1]}"]`);
                    return badge && badge.classList.contains('active');
                }
            }
            return true;
        });
    }

    function _muPopulatePumpCols() {
        const sel = document.getElementById('pbr-mu-pump-sel');
        if (!sel) return;
        sel.innerHTML = '';
        // Use all columns in the pumps group; fall back to any header containing 'pump'
        const cols = (_state.columnGroups.pumps || []).length > 0
            ? (_state.columnGroups.pumps || [])
            : (_state.headers || []).filter(h => h && h.toLowerCase().includes('pump'));
        if (cols.length === 0) {
            const opt = document.createElement('option');
            opt.value = ''; opt.textContent = '(no pump columns found)';
            sel.appendChild(opt);
            return;
        }
        cols.forEach(col => {
            const opt = document.createElement('option');
            opt.value = col; opt.textContent = _colLabel(col);
            sel.appendChild(opt);
        });
    }

    function _muRunMode3() {
        const pumpCol = document.getElementById('pbr-mu-pump-sel').value;
        const t0      = parseFloat(document.getElementById('pbr-mu-t0').value) || 0;
        const t1El    = document.getElementById('pbr-mu-t1');
        const t1      = t1El && t1El.value !== '' ? parseFloat(t1El.value) : Infinity;
        const minGap  = parseFloat(document.getElementById('pbr-mu-mingap').value) || 0.05;
        const warnEl  = document.getElementById('pbr-mu-warn3');
        warnEl.style.display = 'none';
        if (!pumpCol) {
            warnEl.textContent = 'Please select a pump column.';
            warnEl.style.display = ''; return;
        }
        const odCols = _muGetODCols();
        if (odCols.length === 0) {
            warnEl.textContent = 'No OD signals selected. Please select OD720 or OD680 first.';
            warnEl.style.display = ''; return;
        }
        // Quick check: does the pump column have any non-zero values in range?
        const pumpVals = _state.data
            .map(r => { const t = parseFloat(r['time']); return (isNaN(t)||t<t0||t>t1) ? NaN : parseFloat(r[pumpCol]); })
            .filter(v => !isNaN(v));
        const hasActivity = pumpVals.some(v => v > 0);
        if (!hasActivity) {
            warnEl.textContent = `Pump column "${_colLabel(pumpCol)}" has no non-zero values in the selected range. ` +
                'This may not be a turbidostat dataset, or the pump was not active during this period.';
            warnEl.style.display = '';
            // Continue anyway in case data is present but formatted differently
        }

        const spinner = document.getElementById('pbr-mu3-spinner');
        const runBtn  = document.querySelector('#pbr-mu-mode3 button.btn-primary');
        if (spinner) spinner.style.display = 'flex';
        if (runBtn)  { runBtn.disabled = true; runBtn.textContent = '⏳ Detecting…'; }

        setTimeout(() => {
            try {
                // Detect pump-OFF segments (value = 0 or null)
                const segments = [];
                let segStart = null, segEnd = null;
                for (const row of _state.data) {
                    const t    = parseFloat(row['time']);
                    if (isNaN(t) || t < t0 || t > t1) continue;
                    const pump = parseFloat(row[pumpCol]);
                    const off  = isNaN(pump) || pump === 0;
                    if (off) {
                        if (segStart === null) segStart = t;
                        segEnd = t;
                    } else {
                        if (segStart !== null && segEnd !== null && segEnd - segStart >= minGap)
                            segments.push({ tStart: segStart, tEnd: segEnd });
                        segStart = null; segEnd = null;
                    }
                }
                if (segStart !== null && segEnd !== null && segEnd - segStart >= minGap)
                    segments.push({ tStart: segStart, tEnd: segEnd });

                if (segments.length === 0) {
                    warnEl.textContent = 'No pump-OFF periods (≥ ' + minGap.toFixed(2) +
                        ' h) found. The pump may be active throughout — try Mode 2 (moving window) instead.';
                    warnEl.style.display = '';
                    document.getElementById('pbr-mu-table3-wrap').style.display = 'none';
                    _muMode3Ann = {};
                    if (_state.chart) updatePlot();
                    return;
                }

                const allRows = [], perSignalMu = {}, newAnn = {};
                odCols.forEach(col => { perSignalMu[col] = []; });

                segments.forEach((seg, si) => {
                    let anyFit = false;
                    odCols.forEach(col => {
                        const { times, vals } = _muExtractWindow(col, seg.tStart, seg.tEnd);
                        const fit = _expFit(times, vals);
                        if (!fit) return;
                        anyFit = true;
                        if (fit.mu > 0) perSignalMu[col].push(fit.mu);
                        allRows.push({
                            phase: si + 1, tStart: seg.tStart, tEnd: seg.tEnd,
                            dur: seg.tEnd - seg.tStart, col,
                            mu: fit.mu, lnA: fit.lnA,
                            td: fit.mu > 0 ? Math.LN2 / fit.mu : null,
                            r2: fit.r2, n: fit.n, r2Low: fit.r2 < 0.8,
                            fitPts: _muFitCurvePoints(seg.tStart, seg.tEnd, fit.mu, fit.lnA),
                            fitColor: _muGetFitColor(col),
                        });
                    });
                    if (anyFit) {
                        newAnn[`mu_phase_${si}`] = {
                            type: 'box', xMin: seg.tStart, xMax: seg.tEnd,
                            backgroundColor: 'rgba(16,163,127,0.06)',
                            borderColor: 'rgba(16,163,127,0.3)', borderWidth: 1,
                        };
                    }
                });

                _muMode3Ann  = newAnn;
                _muMode3Rows = allRows;
                _muBuildChart3(allRows, odCols);
                _muBuildTable3(allRows, perSignalMu, odCols);
                _muUpdateBasisNote();
                if (_state.chart) updatePlot();
                const expBtn = document.getElementById('pbr-mu-export3-btn');
                if (expBtn) expBtn.style.display = '';
            } finally {
                if (spinner) spinner.style.display = 'none';
                if (runBtn)  { runBtn.disabled = false; runBtn.textContent = '▶ Detect & fit'; }
            }
        }, 20);
    }

    function _muBuildTable3(rows, perSignalMu, odCols) {
        const wrap   = document.getElementById('pbr-mu-table3-wrap');
        const tbody  = document.getElementById('pbr-mu-tbody3');
        const sumDiv = document.getElementById('pbr-mu-summary3');
        if (!wrap || !tbody) return;
        if (rows.length === 0) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        tbody.innerHTML = rows.map(r => {
            const cls = r.r2Low ? ' class="table-warning"' : '';
            return `<tr${cls}>
                <td>${r.phase}</td>
                <td>${r.tStart.toFixed(3)}</td><td>${r.tEnd.toFixed(3)}</td>
                <td>${r.dur.toFixed(3)}</td>
                <td style="font-size:0.82em;">${_colLabel(r.col)}</td>
                <td><strong>${r.mu.toFixed(4)}</strong></td>
                <td>${r.td != null ? r.td.toFixed(2) : '—'}</td>
                <td style="color:${r.r2Low ? '#c0392b' : 'inherit'}">${r.r2.toFixed(3)}</td>
                <td>${r.n}</td>
            </tr>`;
        }).join('');
        sumDiv.innerHTML = odCols.map(col => {
            const mus = perSignalMu[col] || [];
            if (!mus.length) return null;
            const mean = mus.reduce((a, b) => a + b, 0) / mus.length;
            const sd   = mus.length > 1
                ? Math.sqrt(mus.reduce((s, v) => s + (v - mean) ** 2, 0) / (mus.length - 1)) : 0;
            const td   = mean > 0 ? Math.LN2 / mean : null;
            return `<strong>${_colLabel(col)}:</strong> μ̅ = ${mean.toFixed(4)} ± ${sd.toFixed(4)} h⁻¹` +
                   (td ? ` &nbsp;| t<sub>d</sub> = ${td.toFixed(2)} h` : '') +
                   ` &nbsp;(n = ${mus.length})`;
        }).filter(Boolean).join(' &nbsp;&nbsp;&nbsp; ');
    }

    // ── UI ────────────────────────────────────────────────────────────────
    function _muSetMode(mode) {
        _muActiveMode = mode;
        // Disable click mode whenever leaving mode 1
        if (mode !== 1 && _muClickMode) _muToggleClickMode();
        [1, 2, 3, 4].forEach(m => {
            const tab  = document.getElementById(`pbr-mu-tab-${m}`);
            const pane = document.getElementById(`pbr-mu-mode${m}`);
            const on   = m === mode;
            if (tab) {
                tab.classList.toggle('active', on);
                tab.classList.toggle('btn-primary', on);
                tab.classList.toggle('btn-outline-primary', !on);
            }
            if (pane) pane.style.display = on ? '' : 'none';
        });
    }

    // ── XLSX export ───────────────────────────────────────────────────────
    function _muExport(mode) {
        if (typeof XLSX === 'undefined') { alert('XLSX library not loaded.'); return; }
        const wb    = XLSX.utils.book_new();
        const basis = _muFitBasis === 'raw' ? 'raw' : 'corr';   // stamped into headers
        if (mode === 1) {
            const hdr  = ['Signal','t-center (h)','Window (h)',
                          `mu (h-1) [${basis}]`,`td (h) [${basis}]`,'R2','n'];
            const data = _muFits.flatMap(fg => fg.results.map(r => [
                r.col, +fg.tCenter.toFixed(4), +fg.windowH.toFixed(4),
                +r.mu.toFixed(5), r.mu > 0 ? +(Math.LN2 / r.mu).toFixed(3) : null,
                +r.r2.toFixed(4), r.n,
            ]));
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Manual Fits');
            XLSX.writeFile(wb, 'PBR_mu_manual.xlsx');
        } else if (mode === 2 && _muMode2Data) {
            const { results, odCols } = _muMode2Data;
            const ref  = results[odCols[0]] || [];
            const hdr  = ['t (h)',
                          ...odCols.map(c => `mu_${_colLabel(c)} (h-1) [${basis}]`),
                          ...odCols.map(c => `R2_${_colLabel(c)} [${basis}]`)];
            const data = ref.map((pt, i) => [
                +pt.t.toFixed(4),
                ...odCols.map(col => { const v = results[col][i]; return v && v.mu != null ? +v.mu.toFixed(5) : null; }),
                ...odCols.map(col => { const v = results[col][i]; return v && v.r2 != null ? +v.r2.toFixed(4) : null; }),
            ]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Moving Window');
            XLSX.writeFile(wb, 'PBR_mu_moving_window.xlsx');
        } else if (mode === 3 && _muMode3Rows) {
            const hdr  = ['Phase','t start (h)','t end (h)','dt (h)','Signal',
                          `mu (h-1) [${basis}]`,`td (h) [${basis}]`,'R2','n'];
            const data = _muMode3Rows.map(r => [
                r.phase, +r.tStart.toFixed(4), +r.tEnd.toFixed(4), +r.dur.toFixed(4),
                r.col, +r.mu.toFixed(5), r.td != null ? +r.td.toFixed(3) : null,
                +r.r2.toFixed(4), r.n,
            ]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Turbidostat Phases');
            XLSX.writeFile(wb, 'PBR_mu_turbidostat.xlsx');
        } else if (mode === 4 && _muMode4Data) {
            const hdr  = ['Signal', 'Model', 'A (max OD)',
                          `µmax (h-1) [${basis}]`, `td (h) [${basis}]`,
                          `Lambda (h) [${basis}]`, 'R2', 'RMSE', 'n', 'Extra param'];
            const data = _muMode4Data.fits.map(f => {
                const [A, mu, lam, p4] = f.params;
                const xtra = f.model === 'baranyi'  ? `y0=${(p4 || 0).toFixed(4)}`
                           : f.model === 'richards' ? `nu=${(p4 || 0).toFixed(3)}` : '';
                return [f.col, MODEL_LABELS[f.model] || f.model,
                        +A.toFixed(4), +mu.toFixed(5),
                        mu > 0 ? +(Math.LN2 / mu).toFixed(3) : null,
                        +lam.toFixed(4), +f.r2.toFixed(4), +f.rmse.toFixed(4), f.n, xtra];
            });
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Growth Curves');
            XLSX.writeFile(wb, 'PBR_growth_curves.xlsx');
        }
    }

    // ── Fit-basis selector ────────────────────────────────────────────────
    function _muSetFitBasis(basis) {
        _muFitBasis = basis;
        ['raw', 'corrected'].forEach(b => {
            const btn = document.getElementById(`pbr-mu-fitbasis-${b}`);
            if (btn) btn.classList.toggle('active', b === basis);
        });
        _muRefreshAll();
    }

    // ── Basis indicator ───────────────────────────────────────────────────
    function _muUpdateBasisNote() {
        const note  = document.getElementById('pbr-mu-basis-note');
        const badge = document.getElementById('pbr-mu-basis-badge');
        if (!note || !badge) return;
        const hasResults = _muFits.length > 0 || _muMode2Data !== null
                        || _muMode3Rows !== null || _muMode4Data !== null;
        if (!hasResults) { note.style.display = 'none'; return; }
        note.style.display = '';
        if (_muFitBasis === 'raw') {
            badge.textContent = 'Raw OD';
            badge.className   = 'badge badge-secondary';
        } else {
            badge.textContent = 'Corrected OD';
            badge.className   = 'badge badge-success';
        }
    }

    // ── Init (called on new file load) ────────────────────────────────────
    function _muInit() {
        _muClickMode = false; _muFitBasis = 'corrected'; _muFits = []; _muNextId = 0;
        _muMode3Ann = {}; _muMode3Rows = null; _muMode2Data = null; _muMode4Data = null;
        // Sync fit-basis buttons to default state
        ['raw', 'corrected'].forEach(b => {
            const btn = document.getElementById(`pbr-mu-fitbasis-${b}`);
            if (btn) btn.classList.toggle('active', b === 'corrected');
        });
        if (_muChart2) { _muChart2.destroy(); _muChart2 = null; }
        if (_muChart3) { _muChart3.destroy(); _muChart3 = null; }
        if (_muChart4) { _muChart4.destroy(); _muChart4 = null; }

        const btn = document.getElementById('pbr-mu-click-btn');
        if (btn) {
            btn.classList.remove('btn-info');
            btn.classList.add('btn-outline-secondary');
            btn.textContent = '✏ Enable click mode';
        }
        ['pbr-mu-tbody1'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
        ['pbr-mu-table1-wrap','pbr-mu-table3-wrap','pbr-mu-chart2-wrap','pbr-mu-chart3-wrap','pbr-mu-warn3',
         'pbr-mu-chart4-wrap','pbr-mu4-table-wrap','pbr-mu-basis-note'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        ['pbr-mu-export1-btn','pbr-mu-export2-btn','pbr-mu-export3-btn','pbr-mu-export4-btn'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });

        const t1El = document.getElementById('pbr-mu-t1');
        if (t1El && _state.data.length > 0) {
            const tMax = Math.max(..._state.data.map(r => parseFloat(r['time'])).filter(t => !isNaN(t)));
            t1El.value = isFinite(tMax) ? tMax.toFixed(1) : '';
        }
        // Always reset mode-3 time/gap inputs to avoid stale or autofilled values
        const t0Mode3 = document.getElementById('pbr-mu-t0');
        if (t0Mode3) t0Mode3.value = '0';
        const mingapEl = document.getElementById('pbr-mu-mingap');
        if (mingapEl) mingapEl.value = '0.05';
        const t1El4 = document.getElementById('pbr-mu4-t1');
        if (t1El4 && _state.data.length > 0) {
            const tMax = Math.max(..._state.data.map(r => parseFloat(r['time'])).filter(t => !isNaN(t)));
            t1El4.value = isFinite(tMax) ? tMax.toFixed(1) : '';
        }
        const t0El4 = document.getElementById('pbr-mu4-t0');
        if (t0El4) t0El4.value = '0';
        _muPopulatePumpCols();
        _muBuildMode4Selector();
        _muSetMode(1);
        const panel = document.getElementById('pbr-mu-panel');
        if (panel) panel.style.display = '';
    }

    // ── Dismiss "What's New" banner ────────────────────────────────────────
    function dismissNews() {
        localStorage.setItem('pbr_news_v2', '1');
        const el = document.getElementById('pbr-whats-new');
        if (el) el.style.display = 'none';
    }

    // ── Load example ODS file from server and feed into _handleFile ───────
    async function loadExampleData(url, label) {
        const btn = document.querySelector(`[data-example="${label}"]`);
        const orig = btn ? btn.textContent : '';
        try {
            if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const file = new File([blob], label + '.ods',
                                  { type: 'application/vnd.oasis.opendocument.spreadsheet' });
            _handleFile(file);
        } catch (e) {
            _showError('Could not load example file: ' + e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = orig; }
        }
    }

    // ── Export active chart as PNG ─────────────────────────────────────────
    function exportChartPNG() {
        const chart = _state.chart;
        if (!chart) return;
        // Draw onto an off-screen canvas with white background
        const src = chart.canvas;
        const off = document.createElement('canvas');
        off.width  = src.width;
        off.height = src.height;
        const ctx = off.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, off.width, off.height);
        ctx.drawImage(src, 0, 0);
        // Trigger download
        const a = document.createElement('a');
        a.href     = off.toDataURL('image/png');
        a.download = 'pbr_chart.png';
        a.click();
    }

    // ── Set all MC-1000 channel strains at once ───────────────────────────
    function setAllStrains(val) {
        document.querySelectorAll('[id^="pbr-strain-ch"]').forEach(sel => { sel.value = val; });
        updatePlot();
    }

    // Public API
    return {
        updatePlot, setShowMode, exportData, exportAll, exportChartPNG,
        loadExampleData, dismissNews, setODStitchOffset, toggleAllChannels,
        resetZoom, changeResolution, toggleTooltips, setAllStrains,
        muSetMode:          _muSetMode,
        muToggleClickMode:  _muToggleClickMode,
        muToggleAllLines2:  _muToggleAllLines2,
        muRunMode2:         _muRunMode2,
        muRunMode3:         _muRunMode3,
        muRemoveFitGroup:   _muRemoveFitGroup,
        muClearFits:        _muClearFits,
        muExport:           _muExport,
        muResetZoom2:       _muResetZoom2,
        muResetZoom3:       _muResetZoom3,
        muSetFitBasis:      _muSetFitBasis,
        muRunMode4:         _muRunMode4,
        muResetZoom4:       _muResetZoom4,
    };

})();
