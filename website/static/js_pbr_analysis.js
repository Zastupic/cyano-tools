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
            return c['720'](od) - _stitchDelta(deviceStr, signalType);
        }
        if (signalType === '680') {
            if (od < 0.6) return od;
            const fn = OD680_CORR[deviceStr];
            if (!fn) return od;
            return fn(od) - _stitchDelta(deviceStr, signalType);
        }
        return od;
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
        if (grp === 'temperature') return true;
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
        cb.onchange = () => _onSignalChange();
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
            cb.onchange = () => _onSignalChange();
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
            cb.onchange = () => _onSignalChange();
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
        const muOv = _muGetOverlays();
        datasets.push(...muOv.datasets);
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
                            labels: { font: { size: 11 }, boxWidth: 16,
                                      filter: (item) => item.text !== '__hidden__' },
                        },
                        tooltip: {
                            callbacks: {
                                title: (items) => `t = ${items[0].parsed.x.toFixed(3)} h`,
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

        // Build corrections map from current UI
        const corrections = {};
        _state.headers.forEach(col => {
            const odType = _getODType(col);
            if (!odType) return;
            const strain = _getStrainForCol(col);
            corrections[col] = { device: strain, signal_type: `od-${odType}` };
        });

        _setLoading(true);
        fetch('/pbr_analysis/export', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ cache_key: _state.cacheKey, corrections }),
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
            a.download = `PBR_${_state.device}_data.xlsx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        })
        .catch(err => _showError('Export failed: ' + err.message));
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

    // ── Init ──────────────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', () => {
        _initUpload();
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
    // ── Growth Rate Analysis (μ) ─────────────────────────────────────────
    // ══════════════════════════════════════════════════════════════════════

    let _muClickMode = false;
    let _muFits      = [];   // Mode 1: [{id, tCenter, windowH, results:[{col,mu,lnA,r2,n,fitPts,color}]}]
    let _muNextId    = 0;
    let _muChart2    = null;
    let _muMode2Data = null; // { results, odCols }
    let _muMode3Rows = null; // rows for export
    let _muMode3Ann  = {};   // phase box annotations

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

    function _muExtractWindow(col, tMin, tMax) {
        const times = [], vals = [];
        for (const row of _state.data) {
            const t = parseFloat(row['time']);
            if (isNaN(t) || t < tMin || t > tMax) continue;
            const v = parseFloat(row[col]);
            times.push(t);
            vals.push(isNaN(v) ? null : v);
        }
        return { times, vals };
    }

    // Returns extra datasets + annotations from all μ modes (merged in updatePlot)
    function _muGetOverlays() {
        const datasets    = [];
        const annotations = Object.assign({}, _muMode3Ann);
        _muFits.forEach(fg => {
            annotations[`mu_box_${fg.id}`] = {
                type: 'box',
                xMin: fg.tCenter - fg.windowH / 2,
                xMax: fg.tCenter + fg.windowH / 2,
                backgroundColor: 'rgba(16,163,127,0.07)',
                borderColor:     'rgba(16,163,127,0.5)',
                borderWidth:     1,
            };
            fg.results.forEach((r, ri) => {
                datasets.push({
                    label:           `__mu_${fg.id}_${ri}__`,
                    data:            r.fitPts,
                    borderColor:     r.color,
                    backgroundColor: 'transparent',
                    borderWidth:     2,
                    borderDash:      [6, 3],
                    pointRadius:     0,
                    spanGaps:        true,
                    yAxisID:         'y',
                    tension:         0,
                });
            });
        });
        return { datasets, annotations };
    }

    // ── Mode 1: manual click-to-fit ───────────────────────────────────────
    function _muToggleClickMode() {
        _muClickMode = !_muClickMode;
        const btn = document.getElementById('pbr-mu-click-btn');
        if (!btn) return;
        if (_muClickMode) {
            btn.classList.replace('btn-outline-info', 'btn-info');
            btn.textContent = '⏹ Click mode ON';
        } else {
            btn.classList.replace('btn-info', 'btn-outline-info');
            btn.textContent = '▶ Enable click mode';
        }
    }

    function _muHandleClick(tClick) {
        const wEl = document.getElementById('pbr-mu-window1');
        const windowH = wEl && parseFloat(wEl.value) > 0 ? parseFloat(wEl.value) : 2;
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
                color:  _muGetSignalColor(col),
            });
        });
        if (results.length === 0) {
            alert('Not enough valid OD data in the selected window (≥ 3 points required).');
            return;
        }
        _muFits.push({ id, tCenter, windowH, results });
        _muRefreshTable1();
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
                    <td style="font-size:0.82em;">${_colLabel(r.col)}</td>
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
        const windowH = parseFloat(document.getElementById('pbr-mu-window2').value) || 2;
        const stepH   = parseFloat(document.getElementById('pbr-mu-step2').value)   || 0.5;
        const odCols  = _muGetODCols();
        if (odCols.length === 0) { alert('No OD signals selected.'); return; }
        if (_state.data.length === 0) return;
        const allTs = _state.data.map(r => parseFloat(r['time'])).filter(t => !isNaN(t));
        const tMin  = Math.min(...allTs), tMax = Math.max(...allTs);
        const centers = [];
        for (let t = tMin + windowH / 2; t <= tMax - windowH / 2 + 1e-9; t += stepH)
            centers.push(t);
        if (centers.length === 0) { alert('Time range too short for the specified window and step.'); return; }
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
        const expBtn = document.getElementById('pbr-mu-export2-btn');
        if (expBtn) expBtn.style.display = '';
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
                },
            },
        });
    }

    // ── Mode 3: turbidostat ───────────────────────────────────────────────
    function _muPopulatePumpCols() {
        const sel = document.getElementById('pbr-mu-pump-sel');
        if (!sel) return;
        sel.innerHTML = '';
        const pumpCols = (_state.headers || []).filter(h => h && /^pumps\.pump-[0-9]$/.test(h));
        const cols = pumpCols.length > 0 ? pumpCols
            : (_state.columnGroups.pumps || []).filter(h => h && h.includes('pump'));
        cols.forEach(col => {
            const opt = document.createElement('option');
            opt.value = col; opt.textContent = col;
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
                    mu: fit.mu, td: fit.mu > 0 ? Math.LN2 / fit.mu : null,
                    r2: fit.r2, n: fit.n, r2Low: fit.r2 < 0.8,
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
        _muBuildTable3(allRows, perSignalMu, odCols);
        if (_state.chart) updatePlot();
        const expBtn = document.getElementById('pbr-mu-export3-btn');
        if (expBtn) expBtn.style.display = '';
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
        [1, 2, 3].forEach(m => {
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
        const wb = XLSX.utils.book_new();
        if (mode === 1) {
            const hdr  = ['Signal','t-center (h)','Window (h)','mu (h-1)','td (h)','R2','n'];
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
            const hdr  = ['t (h)', ...odCols.map(c => `mu_${_colLabel(c)} (h-1)`),
                                    ...odCols.map(c => `R2_${_colLabel(c)}`)];
            const data = ref.map((pt, i) => [
                +pt.t.toFixed(4),
                ...odCols.map(col => { const v = results[col][i]; return v && v.mu != null ? +v.mu.toFixed(5) : null; }),
                ...odCols.map(col => { const v = results[col][i]; return v && v.r2 != null ? +v.r2.toFixed(4) : null; }),
            ]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Moving Window');
            XLSX.writeFile(wb, 'PBR_mu_moving_window.xlsx');
        } else if (mode === 3 && _muMode3Rows) {
            const hdr  = ['Phase','t start (h)','t end (h)','dt (h)','Signal','mu (h-1)','td (h)','R2','n'];
            const data = _muMode3Rows.map(r => [
                r.phase, +r.tStart.toFixed(4), +r.tEnd.toFixed(4), +r.dur.toFixed(4),
                r.col, +r.mu.toFixed(5), r.td != null ? +r.td.toFixed(3) : null,
                +r.r2.toFixed(4), r.n,
            ]);
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdr, ...data]), 'Turbidostat Phases');
            XLSX.writeFile(wb, 'PBR_mu_turbidostat.xlsx');
        }
    }

    // ── Init (called on new file load) ────────────────────────────────────
    function _muInit() {
        _muClickMode = false; _muFits = []; _muNextId = 0;
        _muMode3Ann = {}; _muMode3Rows = null; _muMode2Data = null;
        if (_muChart2) { _muChart2.destroy(); _muChart2 = null; }

        const btn = document.getElementById('pbr-mu-click-btn');
        if (btn) { btn.classList.replace('btn-info', 'btn-outline-info');
                   btn.textContent = '▶ Enable click mode'; }
        ['pbr-mu-tbody1'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = ''; });
        ['pbr-mu-table1-wrap','pbr-mu-table3-wrap','pbr-mu-chart2-wrap','pbr-mu-warn3'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });
        ['pbr-mu-export1-btn','pbr-mu-export2-btn','pbr-mu-export3-btn'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });

        const t1El = document.getElementById('pbr-mu-t1');
        if (t1El && _state.data.length > 0) {
            const tMax = Math.max(..._state.data.map(r => parseFloat(r['time'])).filter(t => !isNaN(t)));
            t1El.value = isFinite(tMax) ? tMax.toFixed(1) : '';
        }
        _muPopulatePumpCols();
        _muSetMode(1);
        const panel = document.getElementById('pbr-mu-panel');
        if (panel) panel.style.display = '';
    }

    // Public API
    return {
        updatePlot, setShowMode, exportData, toggleAllChannels,
        resetZoom, changeResolution, toggleTooltips,
        muSetMode:        _muSetMode,
        muToggleClickMode:_muToggleClickMode,
        muRunMode2:       _muRunMode2,
        muRunMode3:       _muRunMode3,
        muRemoveFitGroup: _muRemoveFitGroup,
        muClearFits:      _muClearFits,
        muExport:         _muExport,
    };

})();
