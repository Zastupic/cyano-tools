// ── Two-level tab navigation ──────────────────────────────────────────────────
// Category buttons (Visualise / Compare / Multivariate) switch
// which group of sub-tabs is visible in #statsSubTabRow.
// Sub-tabs with data-mv-subtab also activate the corresponding inner pane.

function _switchCategory(cat) {
    // Update category button states
    document.querySelectorAll('.stats-cat-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.cat === cat);
    });
    // Show only the matching sub-tab group
    ['visualise', 'compare', 'multivariate'].forEach(c => {
        document.querySelectorAll('.stats-subtab-' + c).forEach(li => {
            li.style.display = c === cat ? '' : 'none';
        });
    });
    // Activate first non-disabled sub-tab in the new category
    const firstLink = document.querySelector('.stats-subtab-' + cat + ' .nav-link:not([disabled])');
    if (firstLink && !firstLink.classList.contains('active')) firstLink.click();
}

/** Enable a locked sub-tab in #statsSubTabRow by id and restore its icon. */
function _unlockSubTab(tabId, newTitle) {
    const btn = document.getElementById(tabId);
    if (!btn) return;
    btn.disabled = false;
    btn.title = newTitle || '';
    btn.classList.remove('subtab-locked');
    // Replace the lock icon with the original icon
    const lockIcon = btn.querySelector('.fa-lock');
    if (lockIcon) {
        const iconMap = {
            'anova-tab':   'fa-check-square-o',
            'pca-tab':     'fa-dot-circle-o',
            'pls-subtab':  'fa-sitemap',
            'opls-subtab': 'fa-arrows-h',
        };
        lockIcon.classList.remove('fa-lock');
        lockIcon.classList.add(iconMap[tabId] || 'fa-unlock');
    }
}

document.querySelectorAll('.stats-cat-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchCategory(btn.dataset.cat));
});

// Sub-tabs targeting #pca-content also activate the correct inner pane
$(document).on('shown.bs.tab', '#statsSubTabRow [data-mv-subtab]', function() {
    const innerTabId = this.dataset.mvSubtab;
    const innerTab = document.getElementById(innerTabId);
    if (innerTab) $(innerTab).tab('show');
});

// Bootstrap 4: clear active from all sub-tabs when a new one activates
$(document).on('show.bs.tab', '#statsSubTabRow .nav-link', function() {
    $('#statsSubTabRow .nav-link').removeClass('active');
});
// ─────────────────────────────────────────────────────────────────────────────

const API_URL = '/run-statistics';
const EXPORT_URL = '/export-excel';
const MAX_DATA_ROWS = 100;
const MAX_DATA_COLUMNS = 100;
let globalData = null;
let lastResults = null;
let selectedFactors = [];
let lastAnovaResults = null;
let lastPCAResults = null;

// ── Abort controllers for cancellable operations ──────────────────────────────
let vizAbortController = null;
let testsAbortController = null;
let anovaAbortController = null;
// ─────────────────────────────────────────────────────────────────────────────

// ── Pipeline state (Correlation → PCA pipeline) ───────────────────────────────
let currentNormTransform = 'none';
let corrThreshold = 0.80;
let excludedVarsFromCorr = new Set();
let pcaVarsFromCorr = new Set();  // vars that arrived via "Send to PCA"
let lastCorrResults = null;
let pipelineStep = 1; // 1-5
let nzvThreshold = 0; // CV% threshold for near-zero variance filter
let pcaPreviewZoom = 1.0;

// Per-variable transform state
let perVarTransforms = {};   // { varName: 'none'|'log10'|'ln'|'sqrt'|'zscore'|'minmax' }
let usePerVarMode = false;   // false = single global transform; true = per-variable
// ─────────────────────────────────────────────────────────────────────────────

// ── Transformation state ──────────────────────────────────────────────────────
let appliedTransformations = {};  // { varName: { type: 'ln1p'|'sqrt'|'power'|'reciprocal'|'arcsin', power: Number } }
let lastTestResults = null;       // Cached after each run-tests call
let lastOriginalTestResults = null;  // When transforms active: results on original data
// ─────────────────────────────────────────────────────────────────────────────

// ── Data Preprocessing: Coverage / Missing-data Diagnostic ───────────────────
const _missingTableZoom = { cov: 1.0, pls: 1.0, opls: 1.0 };

function _applyMissingTableZoom(uid) {
    const tbl = document.querySelector(`#${uid}TableWrap table`);
    if (tbl) tbl.style.zoom = _missingTableZoom[uid];
}

function _getMinRowCoverage() {
    const el = document.getElementById('minRowCoverage');
    return el ? parseInt(el.value, 10) : 20;
}

// Generic Excel-like missing-data table.
// containerId  — id of the <div> to populate
// selectedVarNames — X variable columns
// yColName     — optional Y column (null for PCA/Correlation)
// uid          — short key for unique element IDs ('cov', 'pls', 'opls')
function _renderMissingDataTable(containerId, selectedVarNames, yColName, uid) {
    const container = document.getElementById(containerId);
    if (!container || !globalData || selectedVarNames.length === 0) {
        if (container) container.style.display = 'none';
        return;
    }
    const threshold = _getMinRowCoverage() / 100;
    const n = globalData.length;
    const nVars = selectedVarNames.length;
    const isMissing = v => v === undefined || v === null || v === 'N/A' || v === '';

    const rowsWithCov = globalData.map((row, idx) => {
        const observed = selectedVarNames.filter(v => !isMissing(row[v])).length;
        const cov      = observed / nVars;
        const excCov   = cov < threshold;
        const missingY = yColName ? isMissing(row[yColName]) : false;
        return { row, idx, cov, excCov, missingY, excluded: excCov || missingY };
    });

    const nExcCov   = rowsWithCov.filter(r => r.excCov).length;
    const nExcY     = rowsWithCov.filter(r => !r.excCov && r.missingY).length;
    const nExcluded = rowsWithCov.filter(r => r.excluded).length;
    const complete  = rowsWithCov.filter(r => !r.excluded && r.cov >= 1.0).length;
    const partial   = n - complete - nExcluded;

    const warnHtml = nExcluded > 0 && (nExcluded / n) > 0.3
        ? `<div class="alert alert-warning py-1 px-2 mb-2 small">
               <i class="fa fa-exclamation-triangle mr-1"></i>
               <strong>${Math.round(nExcluded / n * 100)}% of samples would be excluded.</strong>
               To retain more samples, lower the row coverage threshold.
           </div>`
        : '';

    const summaryHtml = `
        <div class="d-flex flex-wrap small text-muted mb-2" style="gap:6px 14px;">
            <span><span class="badge text-white" style="background:#343a40;">${n}</span> total</span>
            <span><span class="badge" style="background:#28a745;color:#fff;">${complete}</span> complete</span>
            <span><span class="badge" style="background:#17a2b8;color:#fff;">${partial}</span> partial</span>
            ${nExcCov > 0 ? `<span><span class="badge" style="background:#dc3545;color:#fff;">${nExcCov}</span> excluded (&lt;${_getMinRowCoverage()}%)</span>` : ''}
            ${nExcY   > 0 ? `<span><span class="badge" style="background:#fd7e14;color:#fff;">${nExcY}</span> excluded (missing Y)</span>` : ''}
        </div>${warnHtml}`;

    const factorCols = selectedFactors.length ? selectedFactors : [];
    const allCols    = [...new Set([...factorCols, ...selectedVarNames, ...(yColName ? [yColName] : [])])];

    const FS       = '0.62rem';
    const thStyle  = `font-size:${FS}; white-space:nowrap; padding:1px 4px; background:#f0f4ff; border:1px solid #c8d0e0; position:sticky; top:0; z-index:1; font-weight:600;`;
    const thYStyle = `font-size:${FS}; white-space:nowrap; padding:1px 4px; background:#dbeeff; border:1px solid #7ab8f5; position:sticky; top:0; z-index:1; font-weight:600; color:#0056b3;`;
    const tdBase   = `font-size:${FS}; padding:1px 4px; border:1px solid #dee2e6; white-space:nowrap; max-width:80px; overflow:hidden; text-overflow:ellipsis;`;

    const headerCells = ['#', ...allCols].map(c => {
        const isY  = c === yColName;
        const lbl  = c.length > 11 ? c.slice(0, 10) + '…' : c;
        return `<th style="${isY ? thYStyle : thStyle}" title="${isY ? c + ' (Y — response)' : c}">${lbl}${isY ? ' <span style="color:#0056b3;font-size:0.55rem;">▲Y</span>' : ''}</th>`;
    }).join('');

    const bodyRows = rowsWithCov.map(({ row, idx, cov, excCov, missingY, excluded: isExcluded }) => {
        const rowBg    = isExcluded ? 'background:#fff0f0;' : (cov < 1.0 ? 'background:#fffbf0;' : 'background:#fff;');
        const rowTitle = excCov    ? `Excluded — only ${Math.round(cov * 100)}% coverage (threshold: ${_getMinRowCoverage()}%)`
                       : missingY  ? `Excluded — Y variable (${yColName}) is missing`
                       : `${Math.round(cov * 100)}% coverage`;

        const cells = allCols.map(col => {
            const val      = row[col];
            const isEmpty  = isMissing(val);
            const isVarCol = selectedVarNames.includes(col);
            const isYCol   = col === yColName;
            const cellBg   = isEmpty && isYCol   ? 'background:#ffe0b2;'
                           : isEmpty && isVarCol ? 'background:#ffd4d4;' : '';
            const display  = isEmpty ? '' : String(val);
            return `<td style="${tdBase}${cellBg}" title="${display}">${display}</td>`;
        }).join('');

        const excStyle = excCov   ? 'font-weight:700; color:#c00; background:#ffcccc;'
                       : missingY ? 'font-weight:700; color:#a04000; background:#ffe5cc;' : '';
        const icon     = excCov   ? '<i class="fa fa-times-circle" style="margin-right:2px;"></i>'
                       : missingY ? '<i class="fa fa-minus-circle" style="margin-right:2px;color:#fd7e14;"></i>' : '';
        const rowNumStyle = `font-size:${FS}; padding:1px 4px; border:1px solid #dee2e6; text-align:right; color:#aaa; ${rowBg} ${excStyle}`;
        const rowNum  = `<td style="${rowNumStyle}" title="${rowTitle}">${icon}${idx + 2}</td>`;

        return `<tr style="${rowBg}" title="${rowTitle}">${rowNum}${cells}</tr>`;
    }).join('');

    const existingWrap = document.getElementById(`${uid}TableWrap`);
    const savedHeight  = existingWrap ? existingWrap.style.height : null;
    const COLLAPSED_H  = '140px';

    const legendY = yColName
        ? `<span style="display:inline-block;width:9px;height:9px;background:#ffe0b2;border:1px solid #fb8c00;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>missing Y &nbsp;`
        : '';

    const tableHtml = `
        <div id="${uid}TableWrap" style="height:${COLLAPSED_H}; overflow:auto; resize:vertical; border:1px solid #c8d0e0; border-radius:4px; margin-top:4px;">
            <table style="border-collapse:collapse; width:max-content; min-width:100%;">
                <thead><tr>${headerCells}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
        <div class="d-flex align-items-center justify-content-between mt-1">
            <div class="text-muted" style="font-size:0.6rem;">
                <span style="display:inline-block;width:9px;height:9px;background:#ffcccc;border:1px solid #c00;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>excluded &nbsp;
                <span style="display:inline-block;width:9px;height:9px;background:#ffd4d4;border:1px solid #ffaaaa;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>missing X &nbsp;
                ${legendY}<span style="display:inline-block;width:9px;height:9px;background:#fffbf0;border:1px solid #ffe082;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>partial (kept)
            </div>
            <div class="d-flex align-items-center" style="gap:3px;">
                <span class="text-muted" style="font-size:0.6rem;">zoom</span>
                <button id="${uid}ZoomOut" class="btn btn-outline-secondary" style="padding:0 5px; font-size:0.65rem; line-height:1.4; border-radius:3px;">−</button>
                <button id="${uid}ZoomIn"  class="btn btn-outline-secondary" style="padding:0 5px; font-size:0.65rem; line-height:1.4; border-radius:3px;">+</button>
            </div>
        </div>`;

    container.style.display = 'block';
    container.innerHTML = summaryHtml + tableHtml;

    if (savedHeight) document.getElementById(`${uid}TableWrap`).style.height = savedHeight;
    _applyMissingTableZoom(uid);

    document.getElementById(`${uid}ZoomOut`).addEventListener('click', () => {
        _missingTableZoom[uid] = Math.max(0.5, parseFloat((_missingTableZoom[uid] - 0.1).toFixed(2)));
        _applyMissingTableZoom(uid);
    });
    document.getElementById(`${uid}ZoomIn`).addEventListener('click', () => {
        _missingTableZoom[uid] = Math.min(2.0, parseFloat((_missingTableZoom[uid] + 0.1).toFixed(2)));
        _applyMissingTableZoom(uid);
    });
}

function _renderCoverageDiagnostic(selectedVarNames) {
    _renderMissingDataTable('coverageDiagnostic', selectedVarNames, null, 'cov');
}

function _renderPlsMissingData() {
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    const yCol = document.getElementById('plsYCol')?.value || null;
    _renderMissingDataTable('plsCoverageDiagnostic', vars, yCol || null, 'pls');
}

function _renderOplsMissingData() {
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    const yCol = document.getElementById('oplsYCol')?.value || null;
    _renderMissingDataTable('oplsCoverageDiagnostic', vars, yCol || null, 'opls');
}

function _renderCorrMissingData() {
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    _renderMissingDataTable('corrCoverageDiagnostic', vars, null, 'corr');
}

document.getElementById('minRowCoverage').addEventListener('input', function () {
    document.getElementById('minRowCoverageVal').textContent = this.value + '%';
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    _renderCoverageDiagnostic(vars);
    _renderPCADataPreview();
    _renderPlsMissingData();
    _renderOplsMissingData();
    _renderCorrMissingData();
    _updatePipelineStepper();
    _updateCorrStepper();
});
// ─────────────────────────────────────────────────────────────────────────────

// ── PCA Data Preview ──────────────────────────────────────────────────────────
function _applyZoomToPcaPreview() {
    const tbl = document.querySelector('#pcaPreviewWrap table');
    if (tbl) tbl.style.zoom = pcaPreviewZoom;
}

function _renderPCADataPreview() {
    const container = document.getElementById('pcaDataPreview');
    if (!container || !globalData || globalData.length === 0) {
        if (container) container.style.display = 'none';
        return;
    }
    const vars = _currentSelectedVars();
    if (vars.length === 0) { container.style.display = 'none'; return; }

    const methodEl   = document.getElementById('pcaMethod');
    const stratEl    = document.getElementById('pcaMissingStrategy');
    const threshEl   = document.getElementById('pcaMissingThreshold');
    const avgEl      = document.getElementById('pcaAverageByFactor');
    if (!methodEl || !stratEl) { container.style.display = 'none'; return; }

    const method         = methodEl.value;
    const nativeMethod   = method === 'nipals' || method === 'em_pca';
    const strategy       = stratEl.value;
    const missingThresh  = parseFloat(threshEl ? threshEl.value : 30) || 30;
    const coverageThresh = _getMinRowCoverage() / 100;
    const avgByFactor    = avgEl ? avgEl.checked : false;
    const factorCols     = selectedFactors.length ? selectedFactors : [];
    const n              = globalData.length;
    const nVars          = vars.length;

    // ── Per-row coverage ─────────────────────────────────────────────────────
    const rowCoverage = globalData.map(row => {
        const obs = vars.filter(v => { const val = row[v]; return val !== undefined && val !== null && val !== 'N/A' && val !== ''; }).length;
        return obs / nVars;
    });

    // ── Per-variable missing % ───────────────────────────────────────────────
    const varMissingPct = {};
    vars.forEach(v => {
        const missing = globalData.filter(row => { const val = row[v]; return val === undefined || val === null || val === 'N/A' || val === ''; }).length;
        varMissingPct[v] = (missing / n) * 100;
    });

    // ── Excluded variables ───────────────────────────────────────────────────
    const excludedVars = new Set();
    if (['hybrid', 'exclude_vars'].includes(strategy)) {
        vars.forEach(v => { if (varMissingPct[v] > missingThresh) excludedVars.add(v); });
    }

    // ── Row status ───────────────────────────────────────────────────────────
    const rowStatus = globalData.map((row, i) => {
        if (rowCoverage[i] < coverageThresh) return 'excluded_coverage';
        if (strategy === 'drop_rows' && !nativeMethod) {
            const activeVars = vars.filter(v => !excludedVars.has(v));
            const hasMissing = activeVars.some(v => { const val = row[v]; return val === undefined || val === null || val === 'N/A' || val === ''; });
            if (hasMissing) return 'excluded_drop';
        }
        return 'ok';
    });

    // ── Average-replicates grouping ──────────────────────────────────────────
    let avgGroupMap = null;
    if (avgByFactor && factorCols.length > 0) {
        avgGroupMap = {};
        const groupRows = {};
        globalData.forEach((row, i) => {
            if (rowStatus[i] !== 'ok') return;
            const key = factorCols.map(f => row[f] ?? '').join('|');
            if (!groupRows[key]) groupRows[key] = [];
            groupRows[key].push(i);
        });
        Object.entries(groupRows).forEach(([key, indices]) => {
            if (indices.length > 1) indices.forEach(i => { avgGroupMap[i] = key; });
        });
    }

    // ── Table styles ─────────────────────────────────────────────────────────
    const FS      = '0.62rem';
    const thBase  = `font-size:${FS}; white-space:nowrap; padding:1px 4px; position:sticky; top:0; z-index:1; font-weight:600; border:1px solid #c8d0e0;`;
    const tdBase  = `font-size:${FS}; padding:1px 4px; border:1px solid #dee2e6; white-space:nowrap; max-width:80px; overflow:hidden; text-overflow:ellipsis;`;

    // ── Header ───────────────────────────────────────────────────────────────
    const headerCells = [
        `<th style="${thBase} background:#f8f9fa; color:#aaa; text-align:right;">#</th>`,
        ...factorCols.map(f => `<th style="${thBase} background:#e8f0fe;" title="${f}">${f.length > 11 ? f.slice(0,10)+'…' : f}</th>`),
        ...vars.map(v => {
            const excl     = excludedVars.has(v);
            const fromCorr = pcaVarsFromCorr.has(v);
            const pct      = varMissingPct[v].toFixed(0);
            const label    = (v.length > 10 ? v.slice(0,9)+'…' : v) + (excl ? ' ✕' : fromCorr ? ' ◆' : '');
            const title    = v + (excl ? ` — excluded (${pct}% missing > ${missingThresh}% threshold)` : ` — ${pct}% missing` + (fromCorr ? ' [from Correlation tab]' : ''));
            const bg       = excl ? 'background:#f0f0f0; color:#999; text-decoration:line-through;' : 'background:#f0f4ff;';
            return `<th style="${thBase} ${bg}" title="${title}">${label}</th>`;
        })
    ].join('');

    // ── Body rows ────────────────────────────────────────────────────────────
    const seenGroups = new Set();
    const bodyRows = globalData.map((row, i) => {
        const status     = rowStatus[i];
        const isExcCov   = status === 'excluded_coverage';
        const isExcDrop  = status === 'excluded_drop';
        const isExcluded = isExcCov || isExcDrop;

        const rowBg = isExcCov ? 'background:#fff0f0;' : isExcDrop ? 'background:#fff5e6;' : 'background:#fff;';

        // Average-replicate marker
        let avgBadge = '';
        const isAveraged = avgGroupMap && avgGroupMap[i] !== undefined;
        if (isAveraged) {
            if (!seenGroups.has(avgGroupMap[i])) {
                seenGroups.add(avgGroupMap[i]);
                avgBadge = '<span style="font-size:0.55rem;background:#28a745;color:#fff;border-radius:2px;padding:0 2px;margin-left:2px;">avg</span>';
            } else {
                avgBadge = '<span style="font-size:0.55rem;background:#adb5bd;color:#fff;border-radius:2px;padding:0 2px;margin-left:2px;">↑</span>';
            }
        }

        // Row number cell
        let numStyle = `${tdBase} text-align:right; `;
        let numIcon  = '';
        if      (isExcCov)  { numStyle += 'background:#ffcccc; font-weight:700; color:#c00;'; numIcon = '<i class="fa fa-times-circle" style="margin-right:2px;color:#dc3545;"></i>'; }
        else if (isExcDrop) { numStyle += 'background:#ffe5cc; font-weight:700; color:#a04000;'; numIcon = '<i class="fa fa-minus-circle" style="margin-right:2px;color:#fd7e14;"></i>'; }
        else                { numStyle += 'background:#f8f9fa; color:#aaa;'; }

        const rowTitle = isExcCov
            ? `Excluded: ${Math.round(rowCoverage[i]*100)}% coverage < ${_getMinRowCoverage()}% threshold`
            : isExcDrop ? 'Excluded: missing value(s) in active variables (drop rows strategy)'
            : `${Math.round(rowCoverage[i]*100)}% coverage`;

        const numTd = `<td style="${numStyle}" title="${rowTitle}">${numIcon}${i+2}${avgBadge}</td>`;

        // Factor cells
        const factorTds = factorCols.map(f => {
            const val = String(row[f] ?? '');
            return `<td style="${tdBase} background:#eef3fc;" title="${val}">${val.length>12?val.slice(0,11)+'…':val}</td>`;
        }).join('');

        // Variable cells
        const varTds = vars.map(v => {
            const val     = row[v];
            const isEmpty = val === undefined || val === null || val === 'N/A' || val === '';
            const isExclV = excludedVars.has(v);
            let cellBg;
            if (isExclV)                        cellBg = 'background:#f0f0f0;';
            else if (isExcluded)                cellBg = rowBg;
            else if (isEmpty && nativeMethod)   cellBg = 'background:#e8f5e9;';
            else if (isEmpty)                   cellBg = 'background:#fffde7;';
            else                                cellBg = rowBg;
            const display  = isEmpty ? '' : String(val);
            const cellTitle = isExclV ? `${v} — variable excluded`
                : isEmpty ? (nativeMethod ? `${v} — missing (handled natively by ${method})` : `${v} — missing (will be imputed)`)
                : `${v}: ${display}`;
            return `<td style="${tdBase} ${cellBg}" title="${cellTitle}">${display}</td>`;
        }).join('');

        return `<tr title="${rowTitle}">${numTd}${factorTds}${varTds}</tr>`;
    }).join('');

    // ── Summary badges ───────────────────────────────────────────────────────
    const nExcCov   = rowStatus.filter(s => s === 'excluded_coverage').length;
    const nExcDrop  = rowStatus.filter(s => s === 'excluded_drop').length;
    const nKept     = n - nExcCov - nExcDrop;
    const nExclVars = excludedVars.size;
    const nUsedVars = vars.length - nExclVars;

    const strategyLabel = nativeMethod
        ? `missing handled natively by ${method.toUpperCase()}`
        : { hybrid: 'hybrid imputation', drop_rows: 'drop rows', impute_group_mean: 'group mean imputation', exclude_vars: 'exclude variables', knn: 'KNN imputation' }[strategy] || strategy;

    const summaryHtml = `
        <div class="d-flex flex-wrap small text-muted mb-2" style="gap:6px 14px; font-size:0.72rem;">
            <span><span class="badge text-white" style="background:#343a40;">${n}</span> samples total</span>
            <span><span class="badge text-white" style="background:#28a745;">${nKept}</span> used in PCA</span>
            ${nExcCov  > 0 ? `<span><span class="badge text-white" style="background:#dc3545;">${nExcCov}</span> excluded (coverage &lt;${_getMinRowCoverage()}%)</span>` : ''}
            ${nExcDrop > 0 ? `<span><span class="badge text-white" style="background:#fd7e14;">${nExcDrop}</span> excluded (missing, drop strategy)</span>` : ''}
            ${nExclVars > 0 ? `<span><span class="badge text-white" style="background:#6c757d;">${nExclVars}</span> var${nExclVars>1?'s':''} excluded</span>` : ''}
            <span><span class="badge text-white" style="background:#17a2b8;">${nUsedVars}</span> var${nUsedVars!==1?'s':''} used</span>
            <span class="text-muted" style="font-style:italic;">${strategyLabel}</span>
        </div>
        <p class="text-muted mb-1" style="font-size:0.67rem;"><i class="fa fa-info-circle mr-1"></i>Preview only — imputed cell values are computed server-side. ◆ = sent from Correlation tab.</p>`;

    // ── Table wrapper ────────────────────────────────────────────────────────
    const existingWrap = document.getElementById('pcaPreviewWrap');
    const savedH       = existingWrap ? existingWrap.style.height : null;
    const COLLAPSED_H  = '160px';

    const avgLegend = avgByFactor
        ? `<span style="display:inline-block;background:#28a745;color:#fff;border-radius:2px;padding:0 3px;font-size:0.58rem;vertical-align:middle;margin-right:2px;">avg</span>group first row &nbsp;
           <span style="display:inline-block;background:#adb5bd;color:#fff;border-radius:2px;padding:0 3px;font-size:0.58rem;vertical-align:middle;margin-right:2px;">↑</span>merged into group &nbsp;`
        : '';

    const tableHtml = `
        <div id="pcaPreviewWrap" style="height:${COLLAPSED_H}; overflow:auto; resize:vertical; border:1px solid #c8d0e0; border-radius:4px; margin-top:4px;">
            <table style="border-collapse:collapse; width:max-content; min-width:100%;">
                <thead><tr>${headerCells}</tr></thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
        <div class="d-flex align-items-center justify-content-between mt-1">
            <div class="text-muted" style="font-size:0.6rem; line-height:1.8;">
                <span style="display:inline-block;width:9px;height:9px;background:#ffcccc;border:1px solid #c00;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>excluded (coverage) &nbsp;
                <span style="display:inline-block;width:9px;height:9px;background:#ffe5cc;border:1px solid #fd7e14;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>excluded (drop rows) &nbsp;
                <span style="display:inline-block;width:9px;height:9px;background:#fffde7;border:1px solid #ffe082;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>will be imputed &nbsp;
                <span style="display:inline-block;width:9px;height:9px;background:#e8f5e9;border:1px solid #a5d6a7;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>handled natively &nbsp;
                <span style="display:inline-block;width:9px;height:9px;background:#f0f0f0;border:1px solid #ccc;border-radius:2px;vertical-align:middle;margin-right:2px;"></span>var excluded &nbsp;
                ${avgLegend}
            </div>
            <div class="d-flex align-items-center" style="gap:3px;">
                <span class="text-muted" style="font-size:0.6rem;">zoom</span>
                <button id="pcaPreviewZoomOut" class="btn btn-outline-secondary" style="padding:0 5px; font-size:0.65rem; line-height:1.4; border-radius:3px;">−</button>
                <button id="pcaPreviewZoomIn"  class="btn btn-outline-secondary" style="padding:0 5px; font-size:0.65rem; line-height:1.4; border-radius:3px;">+</button>
            </div>
        </div>`;

    container.style.display = 'block';
    container.innerHTML = summaryHtml + tableHtml;

    if (savedH) document.getElementById('pcaPreviewWrap').style.height = savedH;
    _applyZoomToPcaPreview();

    document.getElementById('pcaPreviewZoomOut').addEventListener('click', () => {
        pcaPreviewZoom = Math.max(0.5, parseFloat((pcaPreviewZoom - 0.1).toFixed(2)));
        _applyZoomToPcaPreview();
    });
    document.getElementById('pcaPreviewZoomIn').addEventListener('click', () => {
        pcaPreviewZoom = Math.min(2.0, parseFloat((pcaPreviewZoom + 0.1).toFixed(2)));
        _applyZoomToPcaPreview();
    });
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Distribution Preview ──────────────────────────────────────────────────────
function _applyTransform(values, method) {
    // Returns transformed array; NaN/null inputs stay null.
    return values.map(v => {
        if (v === null || v === undefined || v === '' || v === 'N/A') return null;
        const x = parseFloat(v);
        if (isNaN(x)) return null;
        if (method === 'log10') return x > 0 ? Math.log10(x) : null;
        if (method === 'ln')    return x > 0 ? Math.log(x)    : null;
        if (method === 'sqrt')  return x >= 0 ? Math.sqrt(x)  : null;
        return x; // none / zscore / minmax: raw for histogram, z/mm applied below
    });
}

function _zscoreArr(arr) {
    const valid = arr.filter(v => v !== null);
    if (!valid.length) return arr;
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    const sd   = Math.sqrt(valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length);
    return sd === 0 ? arr.map(v => v === null ? null : 0)
                    : arr.map(v => v === null ? null : (v - mean) / sd);
}

function _minmaxArr(arr) {
    const valid = arr.filter(v => v !== null);
    if (!valid.length) return arr;
    const mn = Math.min(...valid), mx = Math.max(...valid);
    return mx === mn ? arr.map(v => v === null ? null : 0)
                     : arr.map(v => v === null ? null : (v - mn) / (mx - mn));
}

function _skewness(vals) {
    // Returns Fisher's moment coefficient of skewness (g1).
    const n = vals.length;
    if (n < 3) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const sd   = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    if (sd === 0) return 0;
    const g1 = vals.reduce((a, b) => a + ((b - mean) / sd) ** 3, 0) / n;
    return g1;
}

function _skewColor(g1) {
    if (g1 === null) return '#aaa';
    const abs = Math.abs(g1);
    if (abs < 0.5)  return '#28a745'; // near-normal
    if (abs < 1.0)  return '#fd7e14'; // moderate
    return '#dc3545';                 // strong
}

function _drawDistCanvas(canvas, rawValues, transformedValues, varName, transform) {
    const W = canvas.width, H = canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Layout: top label row | histogram | x-axis ticks | skewness row
    const PAD = { t: 18, b: 38, l: 28, r: 8 };
    const cW = W - PAD.l - PAD.r, cH = H - PAD.t - PAD.b;

    // Draw both panels: left = raw, right = transformed (only if transform != none)
    const panels = transform === 'none'
        ? [{ vals: rawValues, label: 'Raw', x0: PAD.l, w: cW, col: '#4e9af1' }]
        : [
            { vals: rawValues,         label: 'Raw',                  x0: PAD.l,                        w: Math.floor(cW * 0.48), col: '#888' },
            { vals: transformedValues, label: transform.toUpperCase(), x0: PAD.l + Math.floor(cW * 0.52), w: Math.floor(cW * 0.48), col: '#4e9af1' },
          ];

    panels.forEach(panel => {
        const vals = panel.vals.filter(v => v !== null && isFinite(v));
        if (!vals.length) {
            ctx.fillStyle = '#aaa'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('no data', panel.x0 + panel.w / 2, PAD.t + cH / 2);
            return;
        }
        const mn = Math.min(...vals), mx = Math.max(...vals);
        const BINS = Math.min(20, Math.max(5, Math.ceil(vals.length / 3)));
        const step = (mx - mn) / BINS || 1;
        const bins = Array(BINS).fill(0);
        vals.forEach(v => {
            const bi = Math.min(BINS - 1, Math.floor((v - mn) / step));
            bins[bi]++;
        });
        const maxBin = Math.max(...bins);

        // Bars
        const barW = panel.w / BINS;
        bins.forEach((cnt, i) => {
            const bh = cnt / maxBin * cH;
            ctx.fillStyle = panel.col + 'cc';
            ctx.fillRect(panel.x0 + i * barW, PAD.t + cH - bh, barW - 1, bh);
        });

        // Normal curve overlay (both panels)
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sd   = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
        if (sd > 0) {
            const norm = x => Math.exp(-0.5 * ((x - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));
            ctx.beginPath();
            ctx.strokeStyle = '#d9534f';
            ctx.lineWidth = 1.5;
            for (let px = 0; px <= panel.w; px++) {
                const x = mn + (px / panel.w) * (mx - mn);
                const y = PAD.t + cH - norm(x) * vals.length * step * cH / maxBin;
                px === 0 ? ctx.moveTo(panel.x0 + px, y) : ctx.lineTo(panel.x0 + px, y);
            }
            ctx.stroke();
        }

        // Panel label (top centre)
        ctx.fillStyle = '#555'; ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(panel.label, panel.x0 + panel.w / 2, PAD.t - 6);

        // x-axis ticks (min / max)
        ctx.fillStyle = '#999'; ctx.font = '7px sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(mn.toPrecision(3), panel.x0, PAD.t + cH + 9);
        ctx.textAlign = 'right';
        ctx.fillText(mx.toPrecision(3), panel.x0 + panel.w, PAD.t + cH + 9);

        // Skewness badge (bottom centre)
        const g1 = _skewness(vals);
        const skewLabel = g1 === null ? 'n/a' : (g1 >= 0 ? '+' : '') + g1.toFixed(2);
        const skewColor = _skewColor(g1);
        const bx = panel.x0 + panel.w / 2;
        const by = PAD.t + cH + 22;
        // pill background
        const tw = ctx.measureText('skew ' + skewLabel).width + 6;
        ctx.fillStyle = skewColor + '22';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(bx - tw / 2, by - 9, tw, 11, 3)
                      : ctx.rect(bx - tw / 2, by - 9, tw, 11);
        ctx.fill();
        // text
        ctx.fillStyle = '#666'; ctx.font = '7px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('skew ', bx - ctx.measureText(skewLabel).width / 2 - 1, by);
        ctx.fillStyle = skewColor; ctx.font = 'bold 7px sans-serif';
        ctx.fillText(skewLabel, bx + ctx.measureText('skew ').width / 2, by);
    });

    // Variable name top-left
    ctx.fillStyle = '#333'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(varName.length > 18 ? varName.slice(0, 17) + '…' : varName, 2, 11);
}

// Returns the effective transform for a variable (per-var override or global fallback).
function _getVarTransform(varName) {
    if (usePerVarMode && perVarTransforms[varName] !== undefined) return perVarTransforms[varName];
    return currentNormTransform || 'none';
}

// Suggests the best shape-correcting transform for an array of numeric values.
// Tests none / log10 / ln / sqrt and picks the one minimising |skewness|,
// penalising transforms that produce many nulls (invalid domain).
function _suggestTransform(vals) {
    const rawValid = vals.filter(v => v !== null && isFinite(v));
    if (rawValid.length < 3) return 'none';

    const candidates = ['none', 'log10', 'ln', 'sqrt'];
    let best = 'none', bestScore = Infinity;

    candidates.forEach(t => {
        const transformed = _applyTransform(rawValid.map(v => v), t);
        const valid = transformed.filter(v => v !== null && isFinite(v));
        if (valid.length < 3) return;
        const lossFraction = (rawValid.length - valid.length) / rawValid.length;
        const absSkew = Math.abs(_skewness(valid) ?? 0);
        // Penalise data loss heavily (each lost point is worth 2 skewness units)
        const score = absSkew + lossFraction * 2;
        if (score < bestScore - 0.05) { bestScore = score; best = t; } // 0.05 hysteresis → prefer simpler
    });
    return best;
}

// Like applyColumnNorm but reads from perVarTransforms (falls back to globalMethod).
function applyPerVarNorm(data, varNames, pvTransforms, globalMethod) {
    const colStats = {};
    varNames.forEach(v => {
        const method = pvTransforms[v] ?? globalMethod;
        if (method !== 'zscore' && method !== 'minmax') return;
        const vals = data.map(r => parseFloat(r[v])).filter(x => !isNaN(x));
        if (!vals.length) { colStats[v] = { mean: 0, std: 1, min: 0, max: 1 }; return; }
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const std  = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
        colStats[v] = { mean, std, min: Math.min(...vals), max: Math.max(...vals) };
    });
    return data.map(row => {
        const newRow = Object.assign({}, row);
        varNames.forEach(v => {
            const method = pvTransforms[v] ?? globalMethod;
            if (!method || method === 'none') return;
            const val = parseFloat(row[v]);
            if (isNaN(val)) { newRow[v] = null; return; }
            const s = colStats[v] || {};
            if      (method === 'zscore')  newRow[v] = s.std > 0 ? (val - s.mean) / s.std : 0;
            else if (method === 'minmax')  newRow[v] = (s.max - s.min) > 0 ? (val - s.min) / (s.max - s.min) : 0;
            else if (method === 'log10')   newRow[v] = val > 0  ? Math.log10(val) : null;
            else if (method === 'ln')      newRow[v] = val > 0  ? Math.log(val)   : null;
            else if (method === 'sqrt')    newRow[v] = val >= 0 ? Math.sqrt(val)  : null;
        });
        return newRow;
    });
}

function _renderDistributions() {
    const container = document.getElementById('distChartsContainer');
    const statusMsg = document.getElementById('distStatusMsg');
    if (!container) return;
    if (!globalData || !globalData.length) {
        container.innerHTML = '<span class="text-muted small">Upload data first.</span>';
        return;
    }
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    if (!vars.length) {
        container.innerHTML = '<span class="text-muted small">Select at least one variable.</span>';
        return;
    }

    container.innerHTML = '';
    let skippedCount = 0;
    const TRANSFORM_OPTS = [
        { v: 'none',   label: 'None' },
        { v: 'log10',  label: 'Log₁₀' },
        { v: 'ln',     label: 'Ln' },
        { v: 'sqrt',   label: '√' },
        { v: 'zscore', label: 'Z' },
    ];

    vars.forEach(varName => {
        const rawVals = _applyTransform(globalData.map(r => r[varName]), 'none');
        const validRaw = rawVals.filter(v => v !== null && isFinite(v));
        if (!validRaw.length) { skippedCount++; return; }

        const varTransform = _getVarTransform(varName);
        let transVals = _applyTransform(globalData.map(r => r[varName]), varTransform);
        if (varTransform === 'zscore')  transVals = _zscoreArr(transVals);
        if (varTransform === 'minmax')  transVals = _minmaxArr(transVals);

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex; flex-direction:column; align-items:center; margin-bottom:2px;';

        const cvs = document.createElement('canvas');
        cvs.width  = varTransform === 'none' ? 140 : 240;
        cvs.height = 102;
        cvs.style.cssText = 'border:1px solid #dee2e6; border-radius:4px 4px 0 0; background:#fff;';
        cvs.title = varName;
        wrapper.appendChild(cvs);
        _drawDistCanvas(cvs, rawVals, transVals, varName, varTransform);

        // Per-variable selector strip (always shown; active button highlighted)
        if (usePerVarMode) {
            const strip = document.createElement('div');
            strip.style.cssText = 'display:flex; gap:1px; width:100%; border:1px solid #dee2e6; border-top:none; border-radius:0 0 4px 4px; overflow:hidden;';
            TRANSFORM_OPTS.forEach(opt => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = opt.label;
                const isActive = varTransform === opt.v;
                btn.style.cssText = `flex:1; font-size:9px; padding:2px 0; border:none; cursor:pointer; background:${isActive ? '#0d6efd' : '#f8f9fa'}; color:${isActive ? '#fff' : '#555'}; font-weight:${isActive ? '700' : '400'};`;
                btn.title = opt.v;
                btn.addEventListener('click', () => {
                    perVarTransforms[varName] = opt.v;
                    _renderDistributions();
                });
                strip.appendChild(btn);
            });
            // ⚡ Auto button
            const autoBtn = document.createElement('button');
            autoBtn.type = 'button';
            autoBtn.textContent = '⚡';
            autoBtn.title = 'Auto-suggest best transform for this variable';
            autoBtn.style.cssText = 'flex:1; font-size:9px; padding:2px 0; border:none; cursor:pointer; background:#fff3cd; color:#856404;';
            autoBtn.addEventListener('click', () => {
                perVarTransforms[varName] = _suggestTransform(rawVals);
                _renderDistributions();
            });
            strip.appendChild(autoBtn);
            wrapper.appendChild(strip);
        }

        container.appendChild(wrapper);
    });

    if (statusMsg) {
        const nShown = vars.length - skippedCount;
        if (usePerVarMode) {
            const transformCounts = {};
            vars.filter(v => globalData.some(r => r[v] !== null && r[v] !== '')).forEach(v => {
                const t = _getVarTransform(v);
                transformCounts[t] = (transformCounts[t] || 0) + 1;
            });
            const summary = Object.entries(transformCounts)
                .map(([t, n]) => `${t === 'none' ? 'None' : t.toUpperCase()}×${n}`)
                .join(', ');
            statusMsg.textContent = `${nShown} variables · per-variable mode · ${summary}${skippedCount ? ` · ${skippedCount} skipped` : ''}`;
        } else {
            const label = currentNormTransform === 'none' ? 'No transformation' : currentNormTransform.toUpperCase();
            statusMsg.textContent = `${nShown} variable${nShown !== 1 ? 's' : ''} · ${label}${skippedCount ? ` · ${skippedCount} skipped (non-numeric)` : ''}`;
        }
    }
}

// Preview / Hide toggle button
document.getElementById('refreshDistBtn').addEventListener('click', function () {
    const charts = document.getElementById('distChartsContainer');
    const icon   = this.querySelector('i');
    if (charts.style.display === 'none') {
        charts.style.display = 'flex';
        this.innerHTML = '<i class="fa fa-eye-slash mr-1"></i>Hide distributions';
        _renderDistributions();
    } else if (charts.children.length === 0) {
        // Visible but empty — render for the first time
        this.innerHTML = '<i class="fa fa-eye-slash mr-1"></i>Hide distributions';
        _renderDistributions();
    } else {
        charts.style.display = 'none';
        this.innerHTML = '<i class="fa fa-bar-chart mr-1"></i>Preview distributions';
    }
});

// Auto-refresh when panel is opened — only if histograms are already visible
function _refreshDistIfVisible() {
    const charts = document.getElementById('distChartsContainer');
    if (charts && charts.style.display !== 'none' && charts.children.length > 0) {
        _renderDistributions();
    }
}
document.getElementById('distBody').addEventListener('show.bs.collapse', _refreshDistIfVisible);
document.getElementById('distBody').addEventListener('show', _refreshDistIfVisible); // Bootstrap 4

// ── Per-variable mode toggle ──────────────────────────────────────────────────
document.getElementById('perVarModeBtn').addEventListener('click', function () {
    usePerVarMode = !usePerVarMode;
    this.classList.toggle('active', usePerVarMode);
    this.classList.toggle('btn-outline-secondary', !usePerVarMode);
    this.classList.toggle('btn-primary', usePerVarMode);
    document.getElementById('resetPerVarBtn').style.display = usePerVarMode ? '' : 'none';
    _renderDistributions();
});

// ── Auto-suggest all ──────────────────────────────────────────────────────────
document.getElementById('autoSuggestAllBtn').addEventListener('click', function () {
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    if (!globalData || !vars.length) return;
    vars.forEach(varName => {
        const rawVals = _applyTransform(globalData.map(r => r[varName]), 'none');
        perVarTransforms[varName] = _suggestTransform(rawVals);
    });
    // Switch to per-var mode automatically so the user sees the per-var selectors
    if (!usePerVarMode) {
        usePerVarMode = true;
        const btn = document.getElementById('perVarModeBtn');
        btn.classList.add('active', 'btn-primary'); btn.classList.remove('btn-outline-secondary');
        document.getElementById('resetPerVarBtn').style.display = '';
    }
    _renderDistributions();
});

// ── Reset per-variable transforms ────────────────────────────────────────────
document.getElementById('resetPerVarBtn').addEventListener('click', function () {
    perVarTransforms = {};
    usePerVarMode = false;
    const perBtn = document.getElementById('perVarModeBtn');
    perBtn.classList.remove('active', 'btn-primary'); perBtn.classList.add('btn-outline-secondary');
    this.style.display = 'none';
    _renderDistributions();
});

// ── Apply global transform to all variables ───────────────────────────────────
// Copies currentNormTransform into perVarTransforms for every selected variable,
// then switches to per-variable mode so each can be adjusted individually.
document.getElementById('applyGlobalToAllBtn').addEventListener('click', function () {
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    if (!vars.length) return;
    vars.forEach(v => { perVarTransforms[v] = currentNormTransform || 'none'; });
    if (!usePerVarMode) {
        usePerVarMode = true;
        const perBtn = document.getElementById('perVarModeBtn');
        perBtn.classList.add('active', 'btn-primary'); perBtn.classList.remove('btn-outline-secondary');
        document.getElementById('resetPerVarBtn').style.display = '';
    }
    _renderDistributions();
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Publication plot settings ─────────────────────────────────────────────────
const PUB_PALETTES = {
    okabe:  ['#E69F00','#56B4E9','#009E73','#F0E442','#0072B2','#D55E00','#CC79A7','#999999'],
    nature: ['#4DBBD5','#E64B35','#00A087','#3C5488','#F39B7F','#8491B4','#91D1C2','#DC0000'],
    cell:   ['#0099B4','#925E9F','#DA3978','#42B540','#FD9F2C','#AD002A','#00B4EE','#5A5A5A'],
    gray:   ['#222222','#555555','#888888','#aaaaaa','#444444','#777777','#999999','#333333'],
    blue:   ['#084594','#2171b5','#4292c6','#6baed6','#9ecae1','#3182bd','#c6dbef','#1261a0'],
    pastel: ['#FFB347','#87CEEB','#98FB98','#FFB6C1','#DDA0DD','#F0E68C','#B0E0E6','#FFDAB9'],
};
const PUB_PLOT_DEFAULTS = {
    plotType: 'bar_dot', sizePreset: 'single',
    exportWidth: 85, aspectRatio: 1.5, exportDPI: 300, exportFormat: 'png',
    fontFamily: 'Arial', axisTitleSize: 12, tickLabelSize: 12, annotationSize: 12, legendSize: 11,
    showGridY: false, showGridX: false, gridStyle: 'solid', gridColor: '#e0e0e0',
    tickPosition: 'outside', tickLen: 5, showAxisLine: true,
    showPlotFrame: true, showPaperBorder: false,
    yStartZero: true, yHeadroom: 15,
    colorScheme: 'okabe', fillOpacity: 85, unifyColor: true, unifyFillColor: '#d3d3d3',
    barBorderColor: '#000000', barBorderWidth: 1,
    errBarColor: '#000000', errBarThickness: 1.5, errBarCap: 5,
    pointSymbol: 'circle', pointSize: 7, pointColor: '#000000', pointOpacity: 70, jitter: 20,
    showLegend: false, legendPosition: 'top-right', legendOrientation: 'v',
    showLetters: true, letterBold: true, letterOffset: 7, letterPerBar: true, showTestInfo: true, bgColor: '#ffffff',
};
let pubPlotSettings = Object.assign({}, PUB_PLOT_DEFAULTS);
// ─────────────────────────────────────────────────────────────────────────────

// ── Assumption Scope State ────────────────────────────────────────────────────
let allScopeResults    = {};   // { scopeKey: { data, originalData } }
let lastAssumptionScopes = []; // [{ key, label, n, rawData }]
let activeScopeKey     = 'all';
// ─────────────────────────────────────────────────────────────────────────────

// ── Assumption Scope Helpers ──────────────────────────────────────────────────

/** Build the list of scopes from globalData + selectedFactors.
 *  Returns: [{ key, label, n, rawData }]
 *  Scope "all" covers the full dataset.
 *  Each factor level yields an additional scope.
 */
function buildAssumptionScopes() {
    if (!globalData) return [];
    const scopes = [{ key: 'all', label: 'All data', n: globalData.length, rawData: globalData, type: 'all' }];
    if (!selectedFactors.length) return scopes;

    // ── Factor-level subsets (filter rows) ───────────────────────────────────
    selectedFactors.forEach(factor => {
        const seen   = new Set();
        const levels = [];
        globalData.forEach(row => {
            const v = String(row[factor] ?? '');
            if (!seen.has(v)) { seen.add(v); levels.push(v); }
        });
        if (levels.length < 2) return; // single-level factor — no useful subset

        levels.forEach(level => {
            const filtered = globalData.filter(r => String(r[factor] ?? '') === level);
            scopes.push({ key: `${factor}|||${level}`, label: `${factor} = ${level}`, n: filtered.length, rawData: filtered, type: 'factor-level' });
        });
    });

    // ── Variable-level subsets (same rows, single variable shown) ────────────
    const selectedVarNames = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    if (selectedVarNames.length > 1) {
        selectedVarNames.forEach(varName => {
            scopes.push({
                key:     `var|||${varName}`,
                label:   varName,
                n:       globalData.length,
                rawData: globalData,
                type:    'variable',
                vars:    [varName]
            });
        });
    }

    return scopes;
}

/** Render the two-row scope-switcher above the sub-tabs.
 *  Row 1 — "Data scope":    All data + factor-level row-filters (grouped by factor).
 *  Row 2 — "Variable focus": per-variable column-filters (only when >1 variable).
 *  The two rows are visually distinct so users immediately grasp the two dimensions.
 */
function renderAssumptionScopeTabs(scopes, activeKey) {
    const container = document.getElementById('assumptionsScopeTabs');
    if (!container) return;

    const scopeScopes = scopes.filter(s => s.type !== 'variable');
    const varScopes   = scopes.filter(s => s.type === 'variable');

    // ── Row 1: Data scope (All data + factor-level subsets) ──────────────────
    let row1 = `
        <div class="scope-row" id="scopeRowData">
            <span class="scope-row-label">
                <i class="fa fa-filter mr-1"></i>Data scope
                <span class="scope-row-hint"
                      title="Filter which rows are included in the analysis below">
                    <i class="fa fa-question-circle"></i>
                </span>
            </span>
            <div class="scope-row-pills">`;

    let currentFactor = null;

    scopeScopes.forEach(scope => {
        const isActive = scope.key === activeKey;
        const isCached = !!allScopeResults[scope.key];

        // Open a factor-group bubble when we enter a new factor
        if (scope.type === 'factor-level') {
            const factor = scope.key.split('|||')[0];
            if (factor !== currentFactor) {
                if (currentFactor !== null) row1 += `</div>`; // close prev group
                row1 += `<div class="scope-factor-group">
                              <span class="scope-factor-label">${factor}:</span>`;
                currentFactor = factor;
            }
        } else if (scope.type === 'all' && currentFactor !== null) {
            row1 += `</div>`;
            currentFactor = null;
        }

        const btnCls  = isActive ? 'btn-primary' : 'btn-outline-secondary';
        const badgeCls = isActive ? 'badge-light text-primary' : 'badge-secondary';
        const badge   = `<span class="badge ml-1 ${badgeCls}" style="font-size:0.60rem;">${scope.n}</span>`;
        const lazy    = (!isCached && !isActive)
            ? ` <i class="fa fa-cloud-download" style="font-size:0.60rem;opacity:0.6;"></i>`
            : '';

        row1 += `<button type="button"
                    class="btn btn-sm scope-tab-btn ${btnCls}"
                    style="font-size:0.73rem; padding:2px 10px; white-space:nowrap;"
                    data-scope-key="${scope.key}">
                    ${scope.label}${lazy}${badge}
                 </button>`;
    });

    if (currentFactor !== null) row1 += `</div>`; // close last factor group
    row1 += `</div></div>`; // close .scope-row-pills + .scope-row

    // ── Row 2: Variable focus (only rendered when more than one variable) ─────
    let row2 = '';
    if (varScopes.length) {
        row2 = `
        <div class="scope-row scope-row-vars" id="scopeRowVars">
            <span class="scope-row-label">
                <i class="fa fa-bar-chart mr-1"></i>Variable focus
                <span class="scope-row-hint"
                      title="Keep all rows but show only one variable at a time">
                    <i class="fa fa-question-circle"></i>
                </span>
            </span>
            <div class="scope-row-pills">`;

        varScopes.forEach(scope => {
            const isActive = scope.key === activeKey;
            const btnCls   = isActive ? 'btn-success' : 'btn-outline-success';
            row2 += `<button type="button"
                        class="btn btn-sm scope-tab-btn ${btnCls}"
                        style="font-size:0.73rem; padding:2px 10px; white-space:nowrap;"
                        data-scope-key="${scope.key}">
                        ${scope.label}
                     </button>`;
        });

        row2 += `</div></div>`;
    }

    container.innerHTML = row1 + row2;
}

// ── Client-side residuals computation (replaces server-side OLS) ─────────────

/**
 * Rational approximation of the standard normal inverse CDF (probit).
 * Peter Acklam algorithm — accurate to ~1e-9.
 */
function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01,  2.209460984245205e+02,
               -2.759285104469687e+02,  1.383577518672690e+02,
               -3.066479806614716e+01,  2.506628277459239e+00];
    const b = [-5.447609879822406e+01,  1.615858368580409e+02,
               -1.556989798598866e+02,  6.680131188771972e+01,
               -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01,
               -2.400758277161838e+00, -2.549732539343734e+00,
                4.374664141464968e+00,  2.938163982698783e+00];
    const d = [ 7.784695709041462e-03,  3.224671290700398e-01,
                2.445134137142996e+00,  3.754408661907416e+00];
    const pLow = 0.02425, pHigh = 1 - pLow;
    if (p < pLow) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
               ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    } else if (p <= pHigh) {
        const q = p - 0.5, r = q * q;
        return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q /
               (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
    } else {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) /
                ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
    }
}

/**
 * Compute residuals data from plot_data (same format the server used to return).
 * Fitted = per-group mean; residuals standardized with ddof=1; theoretical
 * quantiles via Blom's formula (rank-0.5)/n.
 */
function computeResidualsFromPlotData(plotData) {
    if (!plotData || plotData.length === 0) return [];

    // Group means (= fitted values)
    const sums = {}, counts = {};
    plotData.forEach(d => {
        if (!sums[d.group]) { sums[d.group] = 0; counts[d.group] = 0; }
        sums[d.group] += d.value;
        counts[d.group]++;
    });
    const means = {};
    Object.keys(sums).forEach(g => { means[g] = sums[g] / counts[g]; });

    // Raw residuals
    const withRes = plotData.map(d => ({
        row_id: d.row_id,
        group:  d.group,
        fitted: means[d.group],
        residual: d.value - means[d.group],
    }));

    // Standardize (ddof=1)
    const n = withRes.length;
    const resMean = withRes.reduce((s, d) => s + d.residual, 0) / n;
    const resVar  = withRes.reduce((s, d) => s + (d.residual - resMean) ** 2, 0) / Math.max(n - 1, 1);
    const resStd  = Math.sqrt(resVar) || 1;
    const withStd = withRes.map(d => ({ ...d, std_residual: d.residual / resStd }));

    // Ranks → theoretical quantiles (Blom)
    const idxBySorted = withStd.map((_, i) => i)
        .sort((i, j) => withStd[i].std_residual - withStd[j].std_residual);
    const ranks = new Array(n);
    idxBySorted.forEach((origIdx, rank) => { ranks[origIdx] = rank + 1; });

    return withStd.map((d, i) => ({
        ...d,
        theoretical_quantile: normInv((ranks[i] - 0.5) / n),
    }));
}
// ─────────────────────────────────────────────────────────────────────────────

/** Render all 4 assumption sub-tabs for a given scope key using cached results. */
function renderAssumptionScopeContent(scopeKey) {
    const scopeResult = allScopeResults[scopeKey];
    if (!scopeResult) return;
    const { data, originalData } = scopeResult;
    const scope = lastAssumptionScopes.find(s => s.key === scopeKey) || { label: 'All data', n: '?' };

    const hasTransforms  = Object.values(appliedTransformations).some(t => t && t.type && t.type !== 'none');
    const factorsLabel   = selectedFactors.join(', ');
    const originalByVar  = (originalData && originalData.results)
        ? originalData.results.reduce((acc, r) => { acc[r.variable] = r; return acc; }, {})
        : {};

    // ── Scope context banner ──────────────────────────────────────────────────
    const scopeInfo = document.getElementById('assumptionsScopeInfo');
    if (scopeInfo) {
        if (scopeKey === 'all') {
            scopeInfo.style.display = 'none';
        } else if (scope.type === 'variable') {
            scopeInfo.style.display = 'block';
            scopeInfo.innerHTML = `
                <div style="height: 0.5em;"></div>
                <div class="alert alert-success border-0 py-2 px-3 mb-2"
                     style="border-left:4px solid #198754 !important; font-size:0.78rem;">
                    <i class="fa fa-bar-chart mr-1"></i>
                    <strong>Variable focus:</strong> ${scope.label}
                    <span class="text-muted ml-2" style="font-size:0.72rem;">
                        All ${scope.n} rows included — only this variable shown across all groups.
                    </span>
                </div>`;
        } else {
            scopeInfo.style.display = 'block';
            scopeInfo.innerHTML = `
                <div style="height: 0.5em;"></div>
                <div class="alert alert-primary border-0 py-2 px-3 mb-2"
                     style="border-left:4px solid #0d6efd !important; font-size:0.78rem;">
                    <i class="fa fa-filter mr-1"></i>
                    <strong>Subset:</strong> ${scope.label}
                    <span class="badge badge-primary ml-1" style="font-size:0.65rem;">${scope.n} rows</span>
                    <span class="text-muted ml-2" style="font-size:0.72rem;">
                        Groups below are the remaining factor combinations within this subset.
                    </span>
                </div>`;
        }
    }

    // ── Assumptions Summary sub-tab ───────────────────────────────────────────
    const testResults = document.getElementById('testResults');
    testResults.innerHTML = '';

    if (hasTransforms) {
        const activeList = Object.entries(appliedTransformations)
            .filter(([, cfg]) => cfg && cfg.type && cfg.type !== 'none')
            .map(([v, cfg]) => `<strong>${v}</strong>: ${getTransformLabel(cfg.type, cfg.power)}`)
            .join(' &nbsp;|&nbsp; ');
        const banner = document.createElement('div');
        banner.className = 'alert alert-info py-2 px-3 mb-3 small';
        banner.style.fontSize = '0.78rem';
        banner.innerHTML = `<i class="fa fa-arrows-h mr-1 text-warning"></i>
            <strong>Tests run on transformed data.</strong> Active: ${activeList}.
            Use <em>Reset to Original Data</em> above to revert.`;
        testResults.appendChild(banner);
    }

    data.results.forEach(res => {
        const section = document.createElement('div');
        section.className = 'mb-4 p-4 border rounded bg-white shadow-sm assumptions-var-card';
        section.dataset.var = res.variable;
        const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
        const origRes = hasTransformForVar ? originalByVar[res.variable] : null;
        const bodyHtml = origRes ? renderSideBySideAssumptionBlock(origRes, res) : renderOneAssumptionBlock(res, null);
        section.innerHTML = `
            <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
                <h5 class="font-weight-bold text-primary mb-0">Variable: ${res.variable}</h5>
                ${hasTransformForVar ? `<span class="badge badge-warning" style="font-size:0.72rem;"><i class="fa fa-arrows-h mr-1"></i>${getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power)}</span>` : ''}
            </div>
            ${bodyHtml}`;
        testResults.appendChild(section);
    });

    // ── Box Plots sub-tab ─────────────────────────────────────────────────────
    const assumptionsBoxPlots = document.getElementById('assumptionsBoxPlots');
    if (assumptionsBoxPlots) {
        assumptionsBoxPlots.innerHTML = '';
        const safeScope = scopeKey.replace(/\W/g, '_');

        data.results.forEach((res, resIdx) => {
            const normalityByGroup = {};
            if (res.shapiro) res.shapiro.forEach(s => { normalityByGroup[s.group] = !!s.is_normal; });
            const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
            const origRes       = hasTransformForVar ? originalByVar[res.variable] : null;
            const transformLabel = hasTransformForVar ? getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power) : '';

            const card = document.createElement('div');
            card.className = 'plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border mb-4';
            card.dataset.var = res.variable;
            const plotId     = `bp-${safeScope}-${resIdx}-${(res.variable || '').replace(/\W/g, '_')}`;
            const plotIdOrig = plotId + '-orig';

            card.innerHTML = `
                <h6 class="font-weight-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                ${hasTransformForVar && origRes ? `
                    <div class="d-flex align-items-center mb-2 flex-wrap" style="gap:0.75rem;">
                        <span class="badge badge-warning" style="font-size:0.70rem;"><i class="fa fa-arrows-h mr-1"></i>${transformLabel}</span>
                        <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                style="font-size:0.70rem; padding:2px 8px;"
                                data-transformed="${plotId}" data-original="${plotIdOrig}" data-showing="transformed">
                            <i class="fa fa-eye mr-1"></i> Show Original
                        </button>
                    </div>` : ''}
                <div id="${plotId}" class="assumptions-plot-container"></div>
                ${hasTransformForVar && origRes ? `<div id="${plotIdOrig}" class="assumptions-plot-container" style="display:none;"></div>` : ''}`;
            assumptionsBoxPlots.appendChild(card);

            if (res.plot_data && res.plot_data.length) {
                renderPlotlyBoxSwarmAssumptions(plotId, res.plot_data, hasTransformForVar ? res.variable + ' (transformed)' : res.variable, factorsLabel, normalityByGroup, 'runTestsBtn', res.box_stats);
            }
            if (hasTransformForVar && origRes && origRes.plot_data && origRes.plot_data.length) {
                const origNorm = {};
                if (origRes.shapiro) origRes.shapiro.forEach(s => { origNorm[s.group] = !!s.is_normal; });
                renderPlotlyBoxSwarmAssumptions(plotIdOrig, origRes.plot_data, res.variable + ' (original)', factorsLabel, origNorm, 'runTestsBtn', origRes.box_stats);
            }
        });
    }

    // ── Residuals vs Fitted sub-tab ───────────────────────────────────────────
    const residualsContent = document.getElementById('assumptionsResidualsContent');
    if (residualsContent) {
        residualsContent.innerHTML = '';
        const hasPlotData = data.results.some(r => r.plot_data && r.plot_data.length);
        if (!hasPlotData) {
            residualsContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
        } else {
            const safeScope = scopeKey.replace(/\W/g, '_');
            data.results.forEach((res, resIdx) => {
                if (!res.plot_data || !res.plot_data.length) return;
                const residualsData  = computeResidualsFromPlotData(res.plot_data);
                const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
                const origRes        = hasTransformForVar ? originalByVar[res.variable] : null;
                const transformLabel = hasTransformForVar ? getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power) : '';

                const card = document.createElement('div');
                card.className = 'plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border mb-4';
                card.dataset.var = res.variable;
                const divId      = `res-${safeScope}-${resIdx}-${(res.variable || '').replace(/\W/g, '_')}`;
                const divIdOrig  = divId + '-orig';
                const hasOrigPlotData = hasTransformForVar && origRes && origRes.plot_data && origRes.plot_data.length;

                card.innerHTML = `
                    <h6 class="font-weight-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                    ${hasOrigPlotData ? `
                        <div class="d-flex align-items-center mb-2 flex-wrap" style="gap:0.75rem;">
                            <span class="badge badge-warning" style="font-size:0.70rem;"><i class="fa fa-arrows-h mr-1"></i>${transformLabel}</span>
                            <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                    style="font-size:0.70rem; padding:2px 8px;"
                                    data-transformed="${divId}" data-original="${divIdOrig}" data-showing="transformed">
                                <i class="fa fa-eye mr-1"></i> Show Original
                            </button>
                        </div>` : ''}
                    <div id="${divId}" class="assumptions-plot-container" style="min-height:400px; width:100%;"></div>
                    ${hasOrigPlotData ? `<div id="${divIdOrig}" class="assumptions-plot-container" style="min-height:400px; width:100%; display:none;"></div>` : ''}`;
                residualsContent.appendChild(card);
                renderResidualsVsFitted(divId, residualsData, hasTransformForVar ? res.variable + ' (transformed)' : res.variable, resIdx);
                if (hasOrigPlotData) {
                    const origResiduals = computeResidualsFromPlotData(origRes.plot_data);
                    renderResidualsVsFitted(divIdOrig, origResiduals, res.variable + ' (original)', resIdx);
                }
            });
        }
    }

    // ── Normal Q-Q sub-tab ────────────────────────────────────────────────────
    const qqContent = document.getElementById('assumptionsQQContent');
    if (qqContent) {
        qqContent.innerHTML = '';
        const hasPlotData = data.results.some(r => r.plot_data && r.plot_data.length);
        if (!hasPlotData) {
            qqContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
        } else {
            const safeScope = scopeKey.replace(/\W/g, '_');
            data.results.forEach((res, resIdx) => {
                if (!res.plot_data || !res.plot_data.length) return;
                const residualsData  = computeResidualsFromPlotData(res.plot_data);
                const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
                const origRes        = hasTransformForVar ? originalByVar[res.variable] : null;
                const transformLabel = hasTransformForVar ? getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power) : '';

                const card = document.createElement('div');
                card.className = 'plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border mb-4';
                card.dataset.var = res.variable;
                const divId      = `qq-${safeScope}-${resIdx}-${(res.variable || '').replace(/\W/g, '_')}`;
                const divIdOrig  = divId + '-orig';
                const hasOrigPlotData = hasTransformForVar && origRes && origRes.plot_data && origRes.plot_data.length;

                card.innerHTML = `
                    <h6 class="font-weight-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                    ${hasOrigPlotData ? `
                        <div class="d-flex align-items-center mb-2 flex-wrap" style="gap:0.75rem;">
                            <span class="badge badge-warning" style="font-size:0.70rem;"><i class="fa fa-arrows-h mr-1"></i>${transformLabel}</span>
                            <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                    style="font-size:0.70rem; padding:2px 8px;"
                                    data-transformed="${divId}" data-original="${divIdOrig}" data-showing="transformed">
                                <i class="fa fa-eye mr-1"></i> Show Original
                            </button>
                        </div>` : ''}
                    <div id="${divId}" class="assumptions-plot-container" style="min-height:400px; width:100%;"></div>
                    ${hasOrigPlotData ? `<div id="${divIdOrig}" class="assumptions-plot-container" style="min-height:400px; width:100%; display:none;"></div>` : ''}`;
                qqContent.appendChild(card);
                renderNormalQQ(divId, residualsData, hasTransformForVar ? res.variable + ' (transformed)' : res.variable, resIdx);
                if (hasOrigPlotData) {
                    const origResiduals = computeResidualsFromPlotData(origRes.plot_data);
                    renderNormalQQ(divIdOrig, origResiduals, res.variable + ' (original)', resIdx);
                }
            });
        }
    }
}

// ── Scope tab click delegation ────────────────────────────────────────────────
let scopeFetchController = null; // abort any in-progress on-demand scope fetch

document.addEventListener('click', function(e) {
    const btn = e.target && e.target.closest && e.target.closest('.scope-tab-btn');
    if (!btn) return;
    const scopeKey = btn.dataset.scopeKey;
    if (!scopeKey) return;

    activeScopeKey = scopeKey;
    renderAssumptionScopeTabs(lastAssumptionScopes, scopeKey);

    // Already cached → render immediately
    if (allScopeResults[scopeKey]) {
        renderAssumptionScopeContent(scopeKey);
        setTimeout(() => {
            const activePane = document.querySelector('#assumptionsSubTabContent .tab-pane.active.show');
            if (activePane) activePane.querySelectorAll('.js-plotly-plot').forEach(p => Plotly.Plots.resize(p));
        }, 80);
        return;
    }

    // Not yet cached → fetch on demand
    const scope = lastAssumptionScopes.find(s => s.key === scopeKey);
    if (!scope) return;

    // Cancel any previous on-demand fetch
    if (scopeFetchController) scopeFetchController.abort();
    scopeFetchController = new AbortController();
    const signal = scopeFetchController.signal;

    // Show loading state in the results area
    const resultsArea = document.getElementById('assumptionsResultsArea');
    const testResults = document.getElementById('testResults');
    const assumptionsBoxPlots = document.getElementById('assumptionsBoxPlots');
    const assumptionsResidualsContent = document.getElementById('assumptionsResidualsContent');
    const assumptionsQQContent = document.getElementById('assumptionsQQContent');
    const loadingHtml = `<div class="text-center py-4">
        <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
        <p class="mt-2 text-muted small">Loading subset: ${scope.label}…</p></div>`;
    if (testResults) testResults.innerHTML = loadingHtml;
    if (assumptionsBoxPlots) assumptionsBoxPlots.innerHTML = loadingHtml;
    if (assumptionsResidualsContent) assumptionsResidualsContent.innerHTML = '';
    if (assumptionsQQContent) assumptionsQQContent.innerHTML = '';

    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    const hasTransforms = Object.values(appliedTransformations).some(t => t && t.type && t.type !== 'none');

    // Variable-type scopes restrict target_columns to a single variable
    const targetCols = scope.vars || selectedVars;

    const makePayload = (rawData) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: buildTransformedData(rawData, appliedTransformations), target_columns: targetCols, factors: selectedFactors }),
        signal
    });
    const makeOrigPayload = (rawData) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: rawData, target_columns: targetCols, factors: selectedFactors }),
        signal
    });

    const fetchT = fetch('/run-tests', makePayload(scope.rawData)).then(r => r.json());
    const fetchO = hasTransforms
        ? fetch('/run-tests', makeOrigPayload(scope.rawData)).then(r => r.json())
        : Promise.resolve(null);

    Promise.all([fetchT, fetchO]).then(([scopeData, origData]) => {
        if (scopeData.error) throw new Error(scopeData.error);
        allScopeResults[scopeKey] = { data: scopeData, originalData: origData };
        // Only render if the user is still on this scope tab
        if (activeScopeKey === scopeKey) {
            renderAssumptionScopeContent(scopeKey);
            setTimeout(() => {
                const activePane = document.querySelector('#assumptionsSubTabContent .tab-pane.active.show');
                if (activePane) activePane.querySelectorAll('.js-plotly-plot').forEach(p => Plotly.Plots.resize(p));
            }, 80);
        }
    }).catch(err => {
        if (err.name === 'AbortError') return;
        if (testResults) testResults.innerHTML = `<div class="alert alert-danger small">Error loading subset: ${err.message}</div>`;
    });
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Standalone assumption block renderers (used by renderAssumptionScopeContent) ──

function renderOneAssumptionBlock(res, blockLabel) {
    const leveneClass  = res.levene.is_homogeneous === null ? 'secondary' : (res.levene.is_homogeneous ? 'success' : 'danger');
    const leveneText   = res.levene.is_homogeneous === null ? 'N/A' : (res.levene.is_homogeneous ? 'equal' : 'unequal');
    const leveneDetail = res.levene.p != null ? `Levene p = ${res.levene.p.toFixed(4)}` : 'Levene: N/A (single group)';
    const allNormal    = res.shapiro && res.shapiro.length > 0 && res.shapiro.every(s => s.is_normal);
    const normCount    = res.shapiro ? res.shapiro.filter(s => s.is_normal).length : 0;
    const normTotal    = res.shapiro ? res.shapiro.length : 0;
    const normBadgeCls = allNormal ? 'success' : (normCount > 0 ? 'warning' : 'danger');
    const normText     = allNormal
        ? `Normal distribution in all groups (${normCount}/${normTotal} groups, p > 0.05)`
        : normCount > 0 ? `Normality met in ${normCount}/${normTotal} groups` : 'Normality not met in any group';

    return `
        <div class="mb-3 ${blockLabel ? 'ps-2 border-start border-3 border-primary' : ''}">
            ${blockLabel ? `<div class="font-weight-bold text-primary mb-2 small">${blockLabel}</div>` : ''}
            Homogeneity of variance (Levene's test):<br>
            <span class="badge badge-${leveneClass}">Variance is ${leveneText} (${leveneDetail})</span><br><br>
            Data normality (Shapiro-Wilk test):<br>
            <span class="badge badge-${normBadgeCls} mb-2">${normText}</span>
            <div class="table-responsive">
                <table class="table table-sm extra-small">
                    <thead class="table-light"><tr><th>Group</th><th>p-val</th><th>Res.</th></tr></thead>
                    <tbody>
                        ${res.shapiro.map(s => `<tr class="${s.is_normal ? '' : 'table-danger-light'}"><td class="text-truncate" style="max-width:100px;">${s.group}</td><td>${s.p.toFixed(3)}</td><td>${s.is_normal ? '✅' : '❌'}</td></tr>`).join('')}
                    </tbody>
                </table>
            </div>
        </div>`;
}

function renderSideBySideAssumptionBlock(origRes, transRes) {
    function leveneInfo(res) {
        const cls = res.levene.is_homogeneous === null ? 'secondary' : (res.levene.is_homogeneous ? 'success' : 'danger');
        const txt = res.levene.is_homogeneous === null ? 'N/A' : (res.levene.is_homogeneous ? 'equal' : 'unequal');
        const p   = res.levene.p != null ? `p = ${res.levene.p.toFixed(4)}` : 'N/A';
        return { cls, txt, p };
    }
    const o = leveneInfo(origRes);
    const t = leveneInfo(transRes);

    const oAllNormal  = origRes.shapiro && origRes.shapiro.every(s => s.is_normal);
    const tAllNormal  = transRes.shapiro && transRes.shapiro.every(s => s.is_normal);
    const oNormCount  = origRes.shapiro ? origRes.shapiro.filter(s => s.is_normal).length : 0;
    const tNormCount  = transRes.shapiro ? transRes.shapiro.filter(s => s.is_normal).length : 0;
    const normTotal   = origRes.shapiro ? origRes.shapiro.length : 0;

    function normBadge(count, total, allNorm) {
        const cls = allNorm ? 'success' : (count > 0 ? 'warning' : 'danger');
        const txt = allNorm ? `All groups normal (${count}/${total})` : count > 0 ? `${count}/${total} groups normal` : `Not met (0/${total})`;
        return `<span class="badge badge-${cls}">${txt}</span>`;
    }

    const groups      = origRes.shapiro.map(s => s.group);
    const origByGroup = {};
    origRes.shapiro.forEach(s => { origByGroup[s.group] = s; });
    const transByGroup = {};
    transRes.shapiro.forEach(s => { transByGroup[s.group] = s; });

    const shapiroRows = groups.map(g => {
        const os = origByGroup[g] || {};
        const ts = transByGroup[g] || {};
        return `<tr>
            <td class="text-truncate" style="max-width:80px;">${g}</td>
            <td>${os.p != null ? os.p.toFixed(3) : '—'}</td>
            <td>${os.is_normal != null ? (os.is_normal ? '✅' : '❌') : '—'}</td>
            <td>${ts.p != null ? ts.p.toFixed(3) : '—'}</td>
            <td>${ts.is_normal != null ? (ts.is_normal ? '✅' : '❌') : '—'}</td>
        </tr>`;
    }).join('');

    return `
        <div class="mb-3">
            Homogeneity of variance (Levene's test):<br>
            <div class="d-flex gap-2 flex-wrap mt-1 mb-2">
                <div><small class="text-muted">Original:</small><br><span class="badge badge-${o.cls}">Variance ${o.txt} (${o.p})</span></div>
                <div><small class="text-muted">Transformed:</small><br><span class="badge badge-${t.cls}">Variance ${t.txt} (${t.p})</span></div>
            </div>
            Data normality (Shapiro-Wilk test):<br>
            <div class="d-flex gap-2 flex-wrap mt-1 mb-2">
                <div><small class="text-muted">Original:</small><br>${normBadge(oNormCount, normTotal, oAllNormal)}</div>
                <div><small class="text-muted">Transformed:</small><br>${normBadge(tNormCount, normTotal, tAllNormal)}</div>
            </div>
            <div class="table-responsive">
                <table class="table table-sm extra-small">
                    <thead class="table-light">
                        <tr>
                            <th>Group</th>
                            <th colspan="2" class="text-center border-start" style="background:#e8f4f8;">Original</th>
                            <th colspan="2" class="text-center border-start" style="background:#fff8e1;">Transformed</th>
                        </tr>
                        <tr style="font-size:0.70rem;">
                            <th></th>
                            <th class="border-start" style="background:#e8f4f8;">p-val</th><th style="background:#e8f4f8;">Res.</th>
                            <th class="border-start" style="background:#fff8e1;">p-val</th><th style="background:#fff8e1;">Res.</th>
                        </tr>
                    </thead>
                    <tbody>${shapiroRows}</tbody>
                </table>
            </div>
        </div>`;
}
// ─────────────────────────────────────────────────────────────────────────────

// --- 1. Factor Management (Auto-selection Logic) ---

// Listen for selection changes directly on the dropdown
document.getElementById('factorSelector').addEventListener('change', function() {
    const val = this.value;

    if (!val) return; // Ignore empty selection

    // Check if already added
    if (selectedFactors.includes(val)) {
        showNiceMessage(`"${val}" is already selected.`, "warning");
        this.value = "";
        return;
    }

    // Enforce 3-factor limit
    if (selectedFactors.length >= 3) {
        showNiceMessage("Maximum of 3 factors reached for this analysis.", "info");
        this.value = "";
        return;
    }

    selectedFactors.push(val);
    renderFactorTags();
    this.value = ""; // Reset dropdown for next selection
});

// --- 1. Factor Management (Updated for Responsiveness) ---

function renderFactorTags() {
    const container = document.getElementById('activeFactorsContainer');
    const selector = document.getElementById('factorSelector');
    container.innerHTML = "";

    selectedFactors.forEach((factor, index) => {
        const tag = document.createElement('span');
        tag.className = "badge badge-primary d-flex align-items-center gap-2 p-2 mb-1 cursor-pointer animate__animated animate__fadeIn";
        tag.style.fontSize = "0.85rem";
        tag.style.borderRadius = "8px";

        tag.innerHTML = `
            <span>${index + 1}. ${factor}</span>
            <i class="fa fa-times-circle text-white-50 hover-white"></i>
        `;

        tag.onclick = function() { removeFactor(factor); };
        container.appendChild(tag);
    });

    selector.disabled = (selectedFactors.length >= 3);

    // Update UI dependencies
    populateGroupingMode();
    updateVariableCheckboxes();

    // NEW: Sync the "Select All" checkbox state whenever factors change
    updateSelectAllState();
}

function updateVariableCheckboxes() {
    const checkboxes = document.querySelectorAll('.var-check');
    checkboxes.forEach(cb => {
        const wrapper = cb.closest('.form-check');
        // If the variable is currently a selected factor, disable and uncheck it
        if (selectedFactors.includes(cb.value)) {
            cb.checked = false;
            cb.disabled = true;
            if (wrapper) {
                wrapper.style.opacity = '0.4';
                wrapper.style.pointerEvents = 'none'; // Make it truly "unresponsive"
            }
        } else {
            cb.disabled = false;
            if (wrapper) {
                wrapper.style.opacity = '1';
                wrapper.style.pointerEvents = 'auto';
            }
        }
    });
}

function populateGroupingMode() {
    const container = document.getElementById('groupingModeContainer');
    const select = document.getElementById('groupingMode');
    select.innerHTML = '';

    if (selectedFactors.length === 0) {
        container.style.display = 'none';
        syncOverrideSelect();
        return;
    }

    if (selectedFactors.length === 1) {
        container.style.display = 'block';
        select.innerHTML = '<option value="all_combined">' + selectedFactors[0] + ' (all levels)</option>';
        syncOverrideSelect();
        return;
    }

    container.style.display = 'block';
    const factors = selectedFactors;

    // 1. Each factor pooled across all others
    factors.forEach(f => {
        const others = factors.filter(x => x !== f);
        select.innerHTML += '<option value="across:' + f + '">' + f + ' throughout all ' + others.join(' & ') + '</option>';
    });

    // 2. Each factor stratified by each single other factor
    factors.forEach(f => {
        const others = factors.filter(x => x !== f);
        others.forEach(stratifyBy => {
            select.innerHTML += '<option value="per:' + f + '|' + stratifyBy + '">' + f + ' for each ' + stratifyBy + ' individually</option>';
        });
    });

    // 3. For 3+ factors: each factor stratified by combination of all others
    if (factors.length >= 3) {
        factors.forEach(f => {
            const others = factors.filter(x => x !== f);
            select.innerHTML += '<option value="per:' + f + '|' + others.join(',') + '">' + f + ' for each ' + others.join(' × ') + ' combination</option>';
        });
    }

    // 4. Full combination of all factors
    select.innerHTML += '<option value="all_combined">Combination of all: ' + factors.join(' × ') + '</option>';

    syncOverrideSelect();
}

window.removeFactor = function(factorName) {
    selectedFactors = selectedFactors.filter(f => f !== factorName);
    renderFactorTags();
};

// ── Override select: sync options based on factor count AND grouping mode ──────
function syncOverrideSelect() {
    const sel = document.getElementById('anovaOverrideSelect');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="auto">🤖 Automatic (recommended)</option>';
    const n = selectedFactors.length;

    // Determine whether the selected grouping mode implies slicing (one-factor analysis)
    // vs. a true multi-factor joint analysis (all_combined).
    const groupingModeEl = document.getElementById('groupingMode');
    const gMode = groupingModeEl ? groupingModeEl.value : 'all_combined';
    const isSlicedMode = gMode && (gMode.startsWith('per:') || gMode.startsWith('across:'));

    if (n === 1) {
        // Single factor: always one-way family
        sel.innerHTML += '<option value="one_way_anova">One-way ANOVA + Tukey HSD</option>';
        sel.innerHTML += '<option value="welch_anova">Welch\'s ANOVA + Games-Howell</option>';
        sel.innerHTML += '<option value="kruskal_wallis">Kruskal–Wallis + Dunn\'s (BH)</option>';
    } else if (n === 2) {
        if (isSlicedMode) {
            // "F1 for each F2 individually" or "F1 throughout all F2":
            // the data is sliced and each slice gets a one-way comparison → one-way family only.
            sel.innerHTML += '<option value="one_way_anova">One-way ANOVA + Tukey HSD</option>';
            sel.innerHTML += '<option value="welch_anova">Welch\'s ANOVA + Games-Howell</option>';
            sel.innerHTML += '<option value="kruskal_wallis">Kruskal–Wallis + Dunn\'s (BH)</option>';
        } else {
            // "Combination of all: F1 × F2": joint two-factor model appropriate.
            sel.innerHTML += '<option value="two_way_anova">Two-way ANOVA + Tukey HSD</option>';
            sel.innerHTML += '<option value="scheirer_ray_hare">Scheirer–Ray–Hare + Dunn\'s (BH)</option>';
        }
    } else if (n >= 3) {
        if (isSlicedMode) {
            // Sliced modes with 3 factors also reduce to one-way comparisons per slice.
            sel.innerHTML += '<option value="one_way_anova">One-way ANOVA + Tukey HSD</option>';
            sel.innerHTML += '<option value="welch_anova">Welch\'s ANOVA + Games-Howell</option>';
            sel.innerHTML += '<option value="kruskal_wallis">Kruskal–Wallis + Dunn\'s (BH)</option>';
        } else {
            sel.innerHTML += '<option value="manova">MANOVA (Pillai\'s Trace) + per-variable ANOVA (Bonferroni)</option>';
            sel.innerHTML += '<option value="art_anova">ART ANOVA + per-variable follow-up (Bonferroni)</option>';
        }
    }

    // Restore previous selection if still valid
    if (Array.from(sel.options).some(o => o.value === current)) {
        sel.value = current;
    } else {
        sel.value = 'auto';
    }
    updateOverrideBadge();
}

function updateOverrideBadge() {
    const sel = document.getElementById('anovaOverrideSelect');
    const badge = document.getElementById('overrideActiveBadge');
    if (!sel || !badge) return;
    badge.style.display = (sel.value !== 'auto') ? 'block' : 'none';
}

// Listen for override changes
(function() {
    const el = document.getElementById('anovaOverrideSelect');
    if (el) el.addEventListener('change', updateOverrideBadge);
})();

// Re-sync the override dropdown whenever the grouping mode changes,
// because switching between "per:" / "across:" (sliced → one-way family)
// and "all_combined" (joint model → two-way family) changes which tests are valid.
(function() {
    const el = document.getElementById('groupingMode');
    if (el) el.addEventListener('change', syncOverrideSelect);
})();

// ── Per-variable sort modes for ANOVA letter group tables ────────────────────
let anovaVarSortModes = {};  // { varName: 'data_order'|'letter'|'mean_asc'|'mean_desc' }
let lastAnovaRawData = null; // stores full ANOVA response for re-sorting

// Event delegation for per-variable sort buttons (rendered dynamically)
document.addEventListener('click', function(e) {
    const btn = e.target && e.target.closest && e.target.closest('.var-sort-btn');
    if (!btn) return;
    const varName = btn.dataset.var;
    const mode = btn.dataset.sort;
    if (!varName || !mode) return;

    // Update button visual state within this variable's section
    const section = btn.closest('.anova-var-section');
    if (section) {
        section.querySelectorAll('.var-sort-btn').forEach(b => {
            b.classList.remove('active', 'btn-secondary');
            b.classList.add('btn-outline-secondary');
        });
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('active', 'btn-secondary');
    }

    // Re-render tables for this variable only
    anovaVarSortModes[varName] = mode;
    if (lastAnovaRawData && section) {
        const varResults = lastAnovaRawData.results.filter(r => r.variable === varName);
        const groupsContainer = section.querySelector('.var-groups-content');
        if (groupsContainer) {
            groupsContainer.innerHTML = buildVariableGroupsHTML(varResults, mode, varName);
        }
    }
});

function sortLetterGroups(letterGroups, mode) {
    if (!letterGroups || !letterGroups.length) return letterGroups;
    const arr = [...letterGroups];
    switch (mode) {
        case 'letter':
            return arr.sort((a, b) => (a.letter || '').localeCompare(b.letter || ''));
        case 'mean_asc':
            return arr.sort((a, b) => a.mean - b.mean);
        case 'mean_desc':
            return arr.sort((a, b) => b.mean - a.mean);
        default:
            return arr; // data_order: original from backend
    }
}
// ─────────────────────────────────────────────────────────────────────────────

function showNiceMessage(message, type, containerId = 'selectionCard') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const alertDiv = document.createElement('div');
    // Using Bootstrap 4 classes: alert-dismissible and the close button span
    alertDiv.className = `alert alert-${type} alert-dismissible fade show mt-2 py-2 small shadow-sm mx-auto`;
    alertDiv.style.fontSize = "0.8rem";
    alertDiv.style.maxWidth = "400px";
    alertDiv.role = "alert";

    alertDiv.innerHTML = `
        <i class="fa fa-info-circle mr-2"></i> ${message}
        <button type="button" class="close" data-dismiss="alert" aria-label="Close" style="padding: 0.5rem 0.5rem;">
            <span aria-hidden="true">&times;</span>
        </button>
    `;

    container.prepend(alertDiv);

    // Auto-remove logic
    setTimeout(() => {
        if (alertDiv && alertDiv.parentNode) {
            $(alertDiv).alert('close'); // Standard jQuery call for Bootstrap 4
        }
    }, 4000);
}

/// --- 2. Variable Selection Logic (Updated Select All) ---

document.getElementById('selectAllVars').addEventListener('change', function() {
    // Select ONLY checkboxes that are not disabled (not factors)
    const availableCheckboxes = document.querySelectorAll('.var-check:not(:disabled)');
    const disabledCheckboxes = document.querySelectorAll('.var-check:disabled');

    availableCheckboxes.forEach(cb => {
        cb.checked = this.checked;
    });

    // Ensure disabled factors ALWAYS remain unchecked
    disabledCheckboxes.forEach(cb => {
        cb.checked = false;
    });
});

// Helper to keep "Select All" state in sync with manual clicks
function updateSelectAllState() {
    const enabledCheckboxes = document.querySelectorAll('.var-check:not(:disabled)');
    const selectAllBox = document.getElementById('selectAllVars');

    if (enabledCheckboxes.length === 0) {
        selectAllBox.checked = false;
        return;
    }

    const allChecked = Array.from(enabledCheckboxes).every(cb => cb.checked);
    selectAllBox.checked = allChecked;
}

function renderPlotlyBoxSwarm(containerId, plotData, variableName, factorsLabel, boxStats) {
    if (!window.Plotly || !plotData || !plotData.length) return;

    const groupOrder = [];
    const seen = new Set();
    plotData.forEach(p => {
        if (!seen.has(p.group)) { seen.add(p.group); groupOrder.push(p.group); }
    });
    const groupIndex = {};
    groupOrder.forEach((g, i) => { groupIndex[g] = i; });

    const xBox = plotData.map(p => groupIndex[p.group]);
    const yBox = plotData.map(p => p.value);
    const jitterWidth = 0.15;
    const xScatter = plotData.map((p, i) => {
        const base = groupIndex[p.group];
        const jitter = ((i % 7) / 7 - 0.5) * 2 * jitterWidth;
        return base + jitter;
    });
    const yScatter = plotData.map(p => p.value);
    const hoverText = plotData.map(p => {
        const label = `#${p.row_id} — ${p.factor_label}`;
        return p.is_outlier ? label + ' (outlier - Click to remove)' : label;
    });

    const statsByGroup = {};
    if (boxStats && boxStats.length) boxStats.forEach(s => { statsByGroup[s.group] = s; });

    // Count per group — groups with n<3 get points only (no box)
    const countByGroup = {};
    groupOrder.forEach(g => { countByGroup[g] = plotData.filter(p => p.group === g).length; });
    const boxGroups = groupOrder.filter(g => countByGroup[g] >= 3);

    let boxTraces;
    if (boxGroups.length && boxGroups.every(g => statsByGroup[g])) {
        boxTraces = [{
            x: boxGroups.map(g => groupIndex[g]),
            q1: boxGroups.map(g => statsByGroup[g].q1),
            median: boxGroups.map(g => statsByGroup[g].median),
            q3: boxGroups.map(g => statsByGroup[g].q3),
            lowerfence: boxGroups.map(g => statsByGroup[g].lowerfence),
            upperfence: boxGroups.map(g => statsByGroup[g].upperfence),
            type: 'box',
            boxpoints: false,
            showlegend: false,
            line: { width: 1.5 },
            fillcolor: 'rgba(128,128,128,0.2)',
        }];
    } else if (boxGroups.length) {
        const bpts = plotData.filter(p => boxGroups.includes(p.group));
        boxTraces = [{
            x: bpts.map(p => groupIndex[p.group]),
            y: bpts.map(p => p.value),
            type: 'box',
            boxpoints: 'outliers',
            marker: { opacity: 0 },
            quartilemethod: 'linear',
            showlegend: false,
            line: { width: 1.5 },
            fillcolor: 'rgba(128,128,128,0.2)',
        }];
    } else {
        boxTraces = [];
    }

    const scatterTrace = {
        x: xScatter,
        y: yScatter,
        type: 'scatter',
        mode: 'markers',
        // CRITICAL FIX: Add customdata so the click event can access row metadata
        customdata: plotData,
        marker: {
            size: 7,
            color: plotData.map(p => p.is_outlier ? 'red' : 'rgba(0,0,0,0.6)'),
            line: { width: 1, color: 'white' }
        },
        text: hoverText,
        hoverinfo: 'text',
        showlegend: false,
    };

    const annotations = groupOrder.map(g => {
        const vals = plotData.filter(p => p.group === g).map(p => p.value);
        const maxY = statsByGroup[g] ? Math.max(statsByGroup[g].upperfence, ...vals) : Math.max(...vals);
        return { x: groupIndex[g], y: maxY, text: `n=${countByGroup[g]}`,
            showarrow: false, yanchor: 'bottom', font: { size: 10, color: '#555' }, xref: 'x', yref: 'y' };
    });

    const layout = {
        title: { text: `Box Plots of ${variableName}`, font: { size: 13, color: '#333' } },
        xaxis: {
            tickvals: groupOrder.map((_, i) => i),
            ticktext: groupOrder,
            tickangle: -30,
        },
        yaxis: { title: variableName, zeroline: false },
        margin: { t: 40, b: 80, l: 50, r: 20 },
        hovermode: 'closest',
        height: 350,
        autosize: true,
        annotations,
    };

    const plotDiv = document.getElementById(containerId);
    if (!plotDiv) return;
    Plotly.newPlot(containerId, [...boxTraces, scatterTrace], layout, { responsive: true });

    // Handle Outlier Removal on Click
    plotDiv.on('plotly_click', function(data) {
        const point = data.points[0];
        const meta = point.customdata;

        if (meta && meta.is_outlier) {
            const modalEl = $('#confirmExclusionModal'); // Use jQuery for BS4 modal handling
            const msgEl = document.getElementById('modalMessage');
            const confirmBtn = document.getElementById('confirmDeleteBtn');

            msgEl.innerHTML = `Exclude <strong>Row #${meta.row_id}</strong> (${variableName}: ${meta.value})?`;

            // Show modal using Bootstrap 4 jQuery syntax
            modalEl.modal('show');

            // Ensure button only has ONE listener by overwriting .onclick
            confirmBtn.onclick = function() {
                globalData = globalData.filter(row => row.row_id !== meta.row_id);

                modalEl.modal('hide');

                showNiceMessage(`Point #${meta.row_id} removed.`, "success", "loadingSpinner");
                document.getElementById('runVizBtn').click();
            };
        }
    });
}

/**
 * Assumptions → Box Plots: Plotly box + swarm with green/red by normality (per group).
 * normalityByGroup: { "Group A": true, "Group B": false } → green #A1D99B / red #F7969E.
 * Outliers clickable → #confirmExclusionModal → on confirm remove row and trigger afterExcludeButtonId (e.g. runTestsBtn).
 * Responsive: fills container width, no fixed pixel width.
 */
function renderPlotlyBoxSwarmAssumptions(containerId, plotData, variableName, factorsLabel, normalityByGroup, afterExcludeButtonId, boxStats) {
    if (!window.Plotly || !plotData || !plotData.length) return;
    afterExcludeButtonId = afterExcludeButtonId || 'runTestsBtn';

    const groupOrder = [];
    const seen = new Set();
    plotData.forEach(p => {
        if (!seen.has(p.group)) { seen.add(p.group); groupOrder.push(p.group); }
    });
    const groupIndex = {};
    groupOrder.forEach((g, i) => { groupIndex[g] = i; });

    const jitterWidth = 0.15;
    const xScatter = plotData.map((p, i) => {
        const base = groupIndex[p.group];
        const jitter = ((i % 7) / 7 - 0.5) * 2 * jitterWidth;
        return base + jitter;
    });
    const yScatter = plotData.map(p => p.value);
    const hoverText = plotData.map(p => {
        const label = `#${p.row_id} — ${p.factor_label}`;
        return p.is_outlier ? label + ' (outlier - Click to remove)' : label;
    });

    const boxLineColor = '#adb5bd';
    const statsByGroup = {};
    if (boxStats && boxStats.length) boxStats.forEach(s => { statsByGroup[s.group] = s; });

    // Count per group — groups with n<3 get points only (no box)
    const countByGroup = {};
    groupOrder.forEach(g => { countByGroup[g] = plotData.filter(p => p.group === g).length; });

    let boxTraces;
    if (groupOrder.length && groupOrder.every(g => statsByGroup[g])) {
        boxTraces = groupOrder
            .filter(grp => countByGroup[grp] >= 3)
            .map(grp => {
                const s = statsByGroup[grp];
                const isNormal = normalityByGroup && normalityByGroup[grp];
                const fillColor = isNormal ? 'rgba(161,217,155,0.6)' : 'rgba(247,150,158,0.6)';
                return {
                    x: [groupIndex[grp]],
                    q1: [s.q1],
                    median: [s.median],
                    q3: [s.q3],
                    lowerfence: [s.lowerfence],
                    upperfence: [s.upperfence],
                    type: 'box',
                    boxpoints: false,
                    showlegend: false,
                    line: { width: 1.5, color: boxLineColor },
                    fillcolor: fillColor,
                };
            });
    } else {
        boxTraces = groupOrder
            .filter(grp => countByGroup[grp] >= 3)
            .map(grp => {
                const pts = plotData.filter(p => p.group === grp);
                const isNormal = normalityByGroup && normalityByGroup[grp] === true;
                const fillColor = isNormal ? 'rgba(161,217,155,0.6)' : 'rgba(247,150,158,0.6)';
                return {
                    x: pts.map(() => groupIndex[grp]),
                    y: pts.map(p => p.value),
                    type: 'box',
                    boxpoints: 'outliers',
                    quartilemethod: 'linear',
                    showlegend: false,
                    line: { width: 1.5, color: boxLineColor },
                    fillcolor: fillColor,
                };
            });
    }

    const annotations = groupOrder.map(g => {
        const vals = plotData.filter(p => p.group === g).map(p => p.value);
        const maxY = statsByGroup[g] ? Math.max(statsByGroup[g].upperfence, ...vals) : Math.max(...vals);
        return { x: groupIndex[g], y: maxY, text: `n=${countByGroup[g]}`,
            showarrow: false, yanchor: 'bottom', font: { size: 10, color: '#555' }, xref: 'x', yref: 'y' };
    });

    const scatterTrace = {
        x: xScatter,
        y: yScatter,
        type: 'scatter',
        mode: 'markers',
        customdata: plotData,
        marker: { size: 7, color: plotData.map(p => p.is_outlier ? 'red' : 'rgba(0,0,0,0.6)'), line: { width: 1, color: 'white' } },
        text: hoverText,
        hoverinfo: 'text',
        showlegend: false,
    };

    const layout = {
        title: { text: variableName, font: { size: 13, color: '#333' } },
        xaxis: { tickvals: groupOrder.map((_, i) => i), ticktext: groupOrder, tickangle: -30 },
        yaxis: { title: variableName, zeroline: false },
        margin: { t: 36, b: 70, l: 48, r: 16 },
        hovermode: 'closest',
        autosize: true,
        height: 320,
        annotations,
    };

    const plotDiv = document.getElementById(containerId);
    if (!plotDiv) return;
    Plotly.newPlot(containerId, [...boxTraces, scatterTrace], layout, { responsive: true });

    plotDiv.on('plotly_click', function(data) {
        const point = data.points[0];
        const meta = point.customdata;
        if (!meta || !meta.is_outlier) return;
        openExclusionModal(meta, variableName, 'value', meta.value, afterExcludeButtonId);
    });
}

/** Residuals vs Fitted diagnostic plot (Assumptions). Click point → modal → remove row, re-run tests.
 *  Points with |standardized residual| > 2 are flagged red (potential outliers). Only flagged points are clickable.
 */
function renderResidualsVsFitted(containerId, residualsData, variableName, resIdx) {
    if (!window.Plotly || !residualsData || !residualsData.length) return;
    const fittedX = residualsData.map(d => d.fitted);
    const residualY = residualsData.map(d => d.residual);
    const minFitted = Math.min(...fittedX);
    const maxFitted = Math.max(...fittedX);

    // Compute standardized residuals on the fly to flag outliers (|z| > 2)
    const mean = residualY.reduce((s, v) => s + v, 0) / residualY.length;
    const std = Math.sqrt(residualY.reduce((s, v) => s + (v - mean) ** 2, 0) / residualY.length) || 1;
    const isOutlier = residualY.map(r => Math.abs((r - mean) / std) > 2);

    // Annotate each data point with its outlier flag for click handling
    const annotatedData = residualsData.map((d, i) => ({ ...d, is_residual_outlier: isOutlier[i] }));

    const pointColors = isOutlier.map(o => o ? 'rgba(220,53,69,0.85)' : 'rgba(50,100,200,0.7)');
    const pointSizes  = isOutlier.map(o => o ? 10 : 8);

    const trace = {
        x: fittedX,
        y: residualY,
        type: 'scatter',
        mode: 'markers',
        customdata: annotatedData,
        marker: { size: pointSizes, color: pointColors, line: { width: 1, color: 'white' } },
        text: annotatedData.map(d => `Row #${d.row_id} · Fitted: ${d.fitted.toFixed(3)} · Residual: ${d.residual.toFixed(3)}` +
              (d.is_residual_outlier ? ' ⚠ potential outlier — click to remove' : '')),
        hoverinfo: 'text',
        showlegend: false,
    };
    const layout = {
        title: { text: `Residuals vs. Fitted — ${variableName}`, font: { size: 12 } },
        xaxis: { title: 'Fitted Values' },
        yaxis: { title: 'Residuals' },
        shapes: [{ type: 'line', x0: minFitted, x1: maxFitted, y0: 0, y1: 0, line: { dash: 'dash', color: 'gray' } }],
        margin: { t: 36, b: 48, l: 52, r: 16 },
        hovermode: 'closest',
        height: 320,
        autosize: true,
    };
    const el = document.getElementById(containerId);
    if (!el) return;
    Plotly.newPlot(containerId, [trace], layout, { responsive: true });
    el.on('plotly_click', function(ev) {
        const point = ev.points[0];
        const meta = point.customdata;
        if (!meta || !meta.is_residual_outlier) return;  // only flagged points are clickable
        openExclusionModal(meta, variableName, 'residual', meta.residual, 'runTestsBtn');
    });
}

/** Normal Q-Q diagnostic plot (Assumptions). Click point → modal → remove row, re-run tests.
 *  Points with |std_residual| > 2 are flagged red (potential outliers). Only flagged points are clickable.
 */
function renderNormalQQ(containerId, residualsData, variableName, resIdx) {
    if (!window.Plotly || !residualsData || !residualsData.length) return;
    const tqX = residualsData.map(d => d.theoretical_quantile);
    const stdY = residualsData.map(d => d.std_residual);
    const minTq = Math.min(...tqX);
    const maxTq = Math.max(...tqX);

    // Flag points where |standardized residual| > 2 as potential outliers
    const isOutlier = stdY.map(v => Math.abs(v) > 2);
    const annotatedData = residualsData.map((d, i) => ({ ...d, is_qq_outlier: isOutlier[i] }));

    const pointColors = isOutlier.map(o => o ? 'rgba(220,53,69,0.85)' : 'rgba(50,100,200,0.7)');
    const pointSizes  = isOutlier.map(o => o ? 10 : 8);

    const trace = {
        x: tqX,
        y: stdY,
        type: 'scatter',
        mode: 'markers',
        customdata: annotatedData,
        marker: { size: pointSizes, color: pointColors, line: { width: 1, color: 'white' } },
        text: annotatedData.map(d => `Row #${d.row_id} · Theoretical: ${d.theoretical_quantile.toFixed(3)} · Std residual: ${d.std_residual.toFixed(3)}` +
              (d.is_qq_outlier ? ' ⚠ potential outlier — click to remove' : '')),
        hoverinfo: 'text',
        showlegend: false,
    };
    const layout = {
        title: { text: `Normal Q-Q — ${variableName}`, font: { size: 12 } },
        xaxis: { title: 'Theoretical Quantiles' },
        yaxis: { title: 'Standardized Residuals' },
        shapes: [{ type: 'line', x0: minTq, x1: maxTq, y0: minTq, y1: maxTq, line: { dash: 'dash', color: 'gray' } }],
        margin: { t: 36, b: 48, l: 52, r: 16 },
        hovermode: 'closest',
        height: 320,
        autosize: true,
    };
    const el = document.getElementById(containerId);
    if (!el) return;
    Plotly.newPlot(containerId, [trace], layout, { responsive: true });
    el.on('plotly_click', function(ev) {
        const point = ev.points[0];
        const meta = point.customdata;
        if (!meta || !meta.is_qq_outlier) return;  // only flagged points are clickable
        openExclusionModal(meta, variableName, 'residual', meta.residual, 'runTestsBtn');
    });
}

function openExclusionModal(meta, variableName, valueLabel, value, triggerButtonId) {
    const msgEl = document.getElementById('modalMessage');
    const confirmBtn = document.getElementById('confirmDeleteBtn');
    if (msgEl) msgEl.innerHTML = `Remove Row #<strong>${meta.row_id}</strong> (${variableName}: ${valueLabel} ${Number(value).toFixed(3)}) from the dataset?`;
    const modalEl = typeof $ !== 'undefined' && $('#confirmExclusionModal').length ? $('#confirmExclusionModal') : null;

    // Show the success message above the spinner of whichever tab triggered the removal
    const messageContainerId = triggerButtonId === 'runTestsBtn' ? 'testSpinner' : 'loadingSpinner';

    if (modalEl && modalEl.length) {
        modalEl.modal('show');
        confirmBtn.onclick = function() {
            globalData = globalData.filter(row => row.row_id !== meta.row_id);
            modalEl.modal('hide');
            showNiceMessage('Point #' + meta.row_id + ' removed. Refreshing...', 'success', messageContainerId);
            if (triggerButtonId === 'runTestsBtn') {
                var testSpinner = document.getElementById('testSpinner');
                if (testSpinner) testSpinner.style.display = 'block';
                var normalityTab = document.querySelector('#assumptions-normality-tab');
                if (normalityTab) normalityTab.click();
            }
            document.getElementById(triggerButtonId || 'runTestsBtn').click();
        };
    } else {
        if (confirm('Remove Row #' + meta.row_id + ' from the dataset?')) {
            globalData = globalData.filter(row => row.row_id !== meta.row_id);
            showNiceMessage('Point #' + meta.row_id + ' removed. Refreshing...', 'success', messageContainerId);
            if (triggerButtonId === 'runTestsBtn') {
                var testSpinner = document.getElementById('testSpinner');
                if (testSpinner) testSpinner.style.display = 'block';
                var normalityTab = document.querySelector('#assumptions-normality-tab');
                if (normalityTab) normalityTab.click();
            }
            document.getElementById(triggerButtonId || 'runTestsBtn').click();
        }
    }
}

function getLetterGroupStyle(letters) {
    if (!letters) return 'background-color: #6c757d; color: white;';

    // 1. Better Hash (djb2) to ensure 'a', 'b', and 'c' produce different numbers
    let hash = 5381;
    for (let i = 0; i < letters.length; i++) {
        hash = ((hash << 5) + hash) + letters.charCodeAt(i);
    }

    // 2. Use Golden Ratio to spread hues (approx 0.618033)
    // This prevents similar characters from getting colors that are too close
    const goldenRatioConjugate = 0.618033988749895;
    let hue = (Math.abs(hash) * goldenRatioConjugate) % 1;
    hue = Math.floor(hue * 360); // Convert to 0-360 degrees

    // 3. Return HSL Color
    // Saturation 75%, Lightness 40% for better contrast with white text
    return `background-color: hsl(${hue}, 75%, 40%); color: white; border: 1px solid rgba(0,0,0,0.1);`;
}

// --- 3. Data Loading ---

function showDataLimitError(message) {
    const el = document.getElementById('dataLimitError');
    el.textContent = message;
    el.style.display = 'block';
}

function hideDataLimitError() {
    const el = document.getElementById('dataLimitError');
    el.textContent = '';
    el.style.display = 'none';
}

// ════════════════════════════════════════════════════════════════════════════
// TRANSFORMATION UTILITIES
// ════════════════════════════════════════════════════════════════════════════

/** Apply one transformation to a single numeric value. Returns null on domain error. */
function applyTransformValue(val, type, power) {
    const v = parseFloat(val);
    if (isNaN(v)) return null;
    switch (type) {
        case 'ln1p':       return Math.log(v + 1);
        case 'sqrt':       return v >= 0 ? Math.sqrt(v) : null;
        case 'power':      return Math.pow(v, parseFloat(power) || 2);
        case 'reciprocal': return v !== 0 ? 1 / v : null;
        case 'arcsin':     return (v >= 0 && v <= 1) ? Math.asin(Math.sqrt(v)) : null;
        default:           return v;
    }
}

/** Human-readable label for a transform type. */
/** Escape string for safe use in HTML attributes (e.g. data-var) so onclick/attributes don't break. */
function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getTransformLabel(type, power) {
    switch (type) {
        case 'ln1p':       return 'ln(x+1)';
        case 'sqrt':       return '√x';
        case 'power':      return `x^${parseFloat(power) || 2}`;
        case 'reciprocal': return '1/x';
        case 'arcsin':     return 'arcsin(√x)';
        default:           return 'None';
    }
}

/**
 * Build a transformed copy of baseData.
 * transforms: { varName: { type, power } }  — only vars with type !== 'none' are mutated.
 */
function buildTransformedData(baseData, transforms) {
    if (!transforms || Object.keys(transforms).length === 0) return baseData;
    return baseData.map(row => {
        const newRow = { ...row };
        Object.entries(transforms).forEach(([varName, cfg]) => {
            if (!cfg || !cfg.type || cfg.type === 'none') return;
            const orig = row[varName];
            if (orig === 'N/A' || orig === null || orig === undefined) return;
            const result = applyTransformValue(orig, cfg.type, cfg.power);
            if (result !== null) newRow[varName] = result;
        });
        return newRow;
    });
}

/** Show/hide the "Active" badge on the panel header. */
function updateTransformBadge() {
    const badge = document.getElementById('transformActiveBadge');
    if (!badge) return;
    const hasActive = Object.values(appliedTransformations).some(t => t && t.type && t.type !== 'none');
    badge.style.display = hasActive ? 'inline-block' : 'none';
}

/**
 * Populate the Transformation Panel after tests have run.
 * @param {Array} testResults - Results array from /run-tests response
 * @param {Array} selectedVars - Variable names currently selected
 */
function populateTransformationPanel(testResults, selectedVars) {
    const panel = document.getElementById('transformationPanel');
    const candidatesDiv = document.getElementById('transformCandidates');
    const controlsDiv = document.getElementById('transformControls');
    if (!panel || !candidatesDiv || !controlsDiv) return;

    // ── Identify candidates and auto-suggestions ─────────────────────────────
    const resultsByVar = {};
    testResults.forEach(r => { resultsByVar[r.variable] = r; });

    const candidates = [];
    const suggestions = {};

    selectedVars.forEach(varName => {
        const res = resultsByVar[varName];
        if (!res) return;
        const failedNorm = res.shapiro && res.shapiro.some(s => !s.is_normal);
        const failedHomo = res.levene && res.levene.is_homogeneous === false;
        if (!failedNorm && !failedHomo) return;

        // Choose suggestion based on failure pattern + data range
        const vals = (globalData || [])
            .map(r => parseFloat(r[varName]))
            .filter(v => !isNaN(v) && isFinite(v));
        const allProportions = vals.length > 0 && vals.every(v => v >= 0 && v <= 1);

        let suggestion;
        if (allProportions) {
            suggestion = 'arcsin';
        } else if (failedNorm && failedHomo) {
            suggestion = 'ln1p';
        } else if (failedNorm) {
            suggestion = 'sqrt';
        } else {
            suggestion = 'sqrt';  // only homogeneity failed
        }
        suggestions[varName] = suggestion;

        const issues = [];
        if (failedNorm) {
            const failCount = res.shapiro.filter(s => !s.is_normal).length;
            issues.push(`normality failed in ${failCount}/${res.shapiro.length} group${failCount > 1 ? 's' : ''}`);
        }
        if (failedHomo) issues.push(`variance unequal (Levene p = ${res.levene.p ? res.levene.p.toFixed(3) : '?'})`);
        candidates.push({ varName, issues, suggestion });
    });

    // ── Render candidates summary ────────────────────────────────────────────
    if (candidates.length === 0) {
        candidatesDiv.innerHTML = `
            <div class="alert alert-success py-2 px-3 mb-0 small">
                <i class="fa fa-check-circle mr-2"></i>
                <strong>All variables passed</strong> normality and homogeneity tests.
                Transformations are optional and may not improve results.
            </div>`;
    } else {
        const rows = candidates.map(c => `
            <div class="d-flex align-items-center flex-wrap gap-1 mb-1" style="font-size:0.78rem;">
                <span class="font-weight-bold" style="min-width:90px; flex-shrink:0;">${c.varName}</span>
                ${c.issues.map(issue => `
                    <span class="badge" style="background:${issue.includes('normality') ? '#dc3545' : '#fd7e14'}; font-size:0.63rem;">
                        ${issue}
                    </span>`).join('')}
                <span class="text-muted ml-1">→ suggested:
                    <strong>${getTransformLabel(c.suggestion)}</strong>
                </span>
            </div>`).join('');

        const whenToUseGuide = `
            <details class="mt-2 mb-0">
                <summary style="font-size:0.70rem; cursor:pointer; color:#856404; font-weight:600;">
                    <i class="fa fa-info-circle mr-1"></i> When to use which transformation
                </summary>
                <div class="mt-2 p-2 rounded" style="background:#fffbf0; border:1px solid #ffe082; font-size:0.68rem; line-height:1.5;">
                    <div class="mb-1"><strong>ln(x+1)</strong> — Best for right-skewed, count-like data with zeros. Compresses large values and handles zero safely. Use when both normality and homogeneity fail.</div>
                    <div class="mb-1"><strong>√x (Square root)</strong> — Milder than log; suitable for moderately right-skewed data or count data without zeros. Use when only normality fails.</div>
                    <div class="mb-1"><strong>xⁿ (Power)</strong> — Flexible: exponent &lt;1 compresses large values (like sqrt/log); exponent &gt;1 stretches them. Use when other transforms overshoot.</div>
                    <div class="mb-1"><strong>1/x (Reciprocal)</strong> — Strong compression for heavily right-skewed data; reverses order of values. Use cautiously; avoid when data contains zeros.</div>
                    <div class="mb-0"><strong>arcsin(√x)</strong> — Designed for proportions/percentages (data between 0 and 1). Stabilises variance in proportion data (e.g. survival rates, relative abundances).</div>
                </div>
            </details>`;

        candidatesDiv.innerHTML = `
            <div class="alert alert-warning py-2 px-3 mb-0" style="font-size:0.78rem;">
                <div class="font-weight-bold mb-2">
                    <i class="fa fa-exclamation-triangle mr-1"></i>
                    Transformation Candidates (${candidates.length} variable${candidates.length > 1 ? 's' : ''})
                </div>
                ${rows}
                ${whenToUseGuide}
            </div>`;
    }

    // ── Render per-variable controls ─────────────────────────────────────────
    controlsDiv.innerHTML = selectedVars.map((varName, idx) => {
        const res = resultsByVar[varName];
        const failedNorm = res && res.shapiro && res.shapiro.some(s => !s.is_normal);
        const failedHomo = res && res.levene && res.levene.is_homogeneous === false;
        const suggestion = suggestions[varName];
        const currentTf = appliedTransformations[varName] || { type: 'none' };
        const isActive = currentTf.type && currentTf.type !== 'none';
        const safeId = varName.replace(/\W/g, '_');
        const rowBg = idx % 2 === 0 ? '' : 'background:#fafafa;';

        // Status icon
        let statusIcon;
        if (!res) {
            statusIcon = `<span class="text-muted" title="No data"><i class="fa fa-minus-circle"></i> No data</span>`;
        } else if (!failedNorm && !failedHomo) {
            statusIcon = `<span class="text-success" title="All tests passed"><i class="fa fa-check-circle"></i> Both passed</span>`;
        } else {
            const parts = [];
            if (failedNorm) parts.push('Normality not met');
            if (failedHomo) parts.push('Homogeneity not met');
            statusIcon = `<span class="text-danger" title="Failed: ${parts.join(', ')}">
                            <i class="fa fa-times-circle"></i> ${parts.join('<br>')}</span>`;
        }

        // Suggested action column — static text only, no click
        let suggestCell;
        if (isActive) {
            suggestCell = `<span class="text-success extra-small font-weight-bold">
                            <i class="fa fa-check-circle mr-1"></i>${getTransformLabel(currentTf.type, currentTf.power)}
                           </span>`;
        } else if (suggestion) {
            suggestCell = `<span class="extra-small text-warning font-weight-bold">${getTransformLabel(suggestion)}</span>`;
        } else {
            suggestCell = `<span class="extra-small text-muted">—</span>`;
        }

        // "Used" column — shows the last applied transformation (from appliedTransformations state)
        const usedTf = appliedTransformations[varName];
        const usedActive = usedTf && usedTf.type && usedTf.type !== 'none';
        let usedCell;
        if (usedActive) {
            usedCell = `<span class="extra-small font-weight-bold" style="color:#0a6640;">
                            <i class="fa fa-check-circle mr-1"></i>${getTransformLabel(usedTf.type, usedTf.power)}
                        </span>`;
        } else {
            usedCell = `<span class="extra-small text-muted">—</span>`;
        }

        return `
        <div class="row g-0 align-items-center py-2 px-2 border-bottom"
             style="font-size:0.8rem; ${rowBg}">
            <div class="col-3 font-weight-bold text-truncate pr-2" title="${varName}">${varName}</div>
            <div class="col-3 d-flex align-items-center gap-1" style="min-width:0; overflow:hidden;">
                <select class="form-select form-select-sm transform-type-select"
                        data-var="${varName}"
                        style="font-size:0.76rem; min-width:0; flex:1 1 0;"
                        onchange="onTransformTypeChange('${varName}', this.value)">
                    <option value="none"      ${currentTf.type === 'none'      ? 'selected' : ''}>— None —</option>
                    <option value="ln1p"      ${currentTf.type === 'ln1p'      ? 'selected' : ''}>ln(x+1)</option>
                    <option value="sqrt"      ${currentTf.type === 'sqrt'      ? 'selected' : ''}>√x</option>
                    <option value="power"     ${currentTf.type === 'power'     ? 'selected' : ''}>xⁿ</option>
                    <option value="reciprocal"${currentTf.type === 'reciprocal'? 'selected' : ''}>1/x</option>
                    <option value="arcsin"    ${currentTf.type === 'arcsin'    ? 'selected' : ''}>arcsin(√x)</option>
                </select>
                <input type="number"
                       id="power_${safeId}"
                       class="form-control form-control-sm"
                       value="${Math.round(currentTf.power) || 2}"
                       min="1" max="10" step="1"
                       title="Exponent (n)"
                       style="width:42px; min-width:42px; max-width:42px; font-size:0.72rem; padding:2px 3px; flex-shrink:0;
                              display:${currentTf.type === 'power' ? 'block' : 'none'};">
            </div>
            <div class="col-2 text-center" style="font-size:0.73rem;">${statusIcon}</div>
            <div class="col-2" style="font-size:0.73rem;">${suggestCell}</div>
            <div class="col-2" style="font-size:0.73rem;">${usedCell}</div>
        </div>`;
    }).join('');

    panel.style.display = 'block';
    updateTransformBadge();
}

/** Called from inline onchange on each row's <select>. */
window.onTransformTypeChange = function(varName, type) {
    if (!appliedTransformations[varName]) appliedTransformations[varName] = { type: 'none', power: 2 };
    appliedTransformations[varName].type = type;
    const safeId = varName.replace(/\W/g, '_');
    const powerEl = document.getElementById('power_' + safeId);
    if (powerEl) powerEl.style.display = type === 'power' ? 'block' : 'none';
    updateTransformBadge();
    // Update the "Suggested" cell for this row to show "Applied" state
    if (lastTestResults) populateTransformationPanel(lastTestResults, _currentSelectedVars());
};

/** Pre-select a suggested transformation (inline click). */
window.quickApplySuggestion = function(varName, type) {
    appliedTransformations[varName] = { type, power: 2 };
    if (lastTestResults) populateTransformationPanel(lastTestResults, _currentSelectedVars());
};

// Delegated click for Apply buttons (avoids broken onclick when varName/suggestion contain quotes)
document.addEventListener('click', function(e) {
    const btn = e.target && e.target.closest && e.target.closest('.quick-apply-btn');
    if (!btn) return;
    const varName = btn.getAttribute('data-var');
    const suggestion = btn.getAttribute('data-suggestion');
    if (varName != null && suggestion != null) quickApplySuggestion(varName, suggestion);
});

/** Helper to get currently checked variable names. */
function _currentSelectedVars() {
    return Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);
}

// ── Apply & Reset button handlers ─────────────────────────────────────────────
document.getElementById('applyTransformBtn').addEventListener('click', function() {
    // Collect current UI selections into appliedTransformations
    const newTransforms = {};
    document.querySelectorAll('.transform-type-select').forEach(select => {
        const varName = select.dataset.var;
        const type = select.value;
        if (type === 'none') return;
        const safeId = varName.replace(/\W/g, '_');
        const powerEl = document.getElementById('power_' + safeId);
        const power = powerEl ? parseFloat(powerEl.value) || 2 : 2;
        newTransforms[varName] = { type, power };
    });
    appliedTransformations = newTransforms;
    updateTransformBadge();
    // Re-run tests with transformed data (panel will be hidden during spinner, restored after)
    document.getElementById('runTestsBtn').click();
});

document.getElementById('resetTransformBtn').addEventListener('click', function() {
    appliedTransformations = {};
    updateTransformBadge();
    document.getElementById('runTestsBtn').click();
});

// ════════════════════════════════════════════════════════════════════════════

document.getElementById('processDataBtn').addEventListener('click', function() {
    hideDataLimitError();
    const rawData = document.getElementById('excelPasteBox').value.trim();
    if (!rawData) return alert("Please paste data from Excel.");

    const rows = rawData.split('\n');
    // Use tab as separator if present (Excel paste), otherwise fall back to 2+ spaces.
    // This prevents column names containing double spaces from being incorrectly split.
    const sep = rows[0].includes('\t') ? /\t/ : / {2,}/;
    const headers = rows[0].split(sep).map(h => h.trim()).filter(h => h !== "");

    if (headers.length === 0) return alert("Could not detect columns. Check your data format.");

    const dataRows = rows.length - 1;
    const colCount = headers.length;
    if (dataRows > MAX_DATA_ROWS) {
        showDataLimitError(`Data exceeds maximum allowed rows (${MAX_DATA_ROWS}). Your data has ${dataRows} rows. Please reduce the dataset.`);
        return;
    }
    if (colCount > MAX_DATA_COLUMNS) {
        showDataLimitError(`Data exceeds maximum allowed columns (${MAX_DATA_COLUMNS}). Your data has ${colCount} columns. Please reduce the dataset.`);
        return;
    }

    const firstColumnName = headers[0];

    globalData = rows.slice(1).map((row, index) => {
        const values = row.split(sep).map(v => v.trim());
        let obj = { row_id: index + 1 }; // 1-based persistent row index
        headers.forEach((h, i) => {
            let val = (values[i] || "").replace(',', '.'); // Normalize decimal

            if (val === "") {
                obj[h] = "N/A";
            } else {
                // Try plain numeric first
                const asNum = parseFloat(val);
                if (!isNaN(asNum) && String(val).trim() !== '') {
                    // Plain number (possibly with trailing whitespace)
                    obj[h] = asNum;
                } else {
                    // Strip trailing unit suffixes only when the value STARTS with a digit
                    // (e.g. "0.04 h⁻¹" → 0.04), but NOT for strings like "AT_High_CO2"
                    const numMatch = val.match(/^([+-]?\d[\d.]*(?:[eE][+-]?\d+)?)/);
                    if (numMatch && !isNaN(parseFloat(numMatch[1]))) {
                        obj[h] = parseFloat(numMatch[1]);
                    } else {
                        obj[h] = val; // Keep as string for Factors
                    }
                }
            }
        });
        return obj;
    });

    fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: globalData })
    })
    .then(res => res.json().then(result => ({ status: res.status, result })))
    .then(({ status, result }) => {
        if (status === 400 && result.error) {
            showDataLimitError(result.error);
            return;
        }
        if (result.error) throw new Error(result.error);

        const factorSel = document.getElementById('factorSelector');
        factorSel.innerHTML = '<option value="">-- Choose Factor --</option>';
        result.all_columns.forEach(c => factorSel.innerHTML += `<option value="${c}">${c}</option>`);

        const labelSel = document.getElementById('pcaLabelCol');
        labelSel.innerHTML = '<option value="">(None — use row index)</option>';
        result.all_columns.forEach(c => labelSel.innerHTML += `<option value="${c}">${c}</option>`);

        const oplsYSel = document.getElementById('oplsYCol');
        oplsYSel.innerHTML = '<option value="">— Select column —</option>';
        result.all_columns.forEach(c => oplsYSel.innerHTML += `<option value="${c}">${c}</option>`);

        const plsYSel = document.getElementById('plsYCol');
        plsYSel.innerHTML = '<option value="">— Select column —</option>';
        result.all_columns.forEach(c => plsYSel.innerHTML += `<option value="${c}">${c}</option>`);


        const container = document.getElementById('checkboxContainer');
        container.innerHTML = "";
        result.variables.forEach(v => {
            container.innerHTML += `
                <div class="form-check mb-1">
                    <input class="form-check-input var-check" type="checkbox" value="${v}" id="v_${v}">
                    <label class="form-check-label small" for="v_${v}">${v}</label>
                </div>`;
        });

        // Add change listeners to variable checkboxes for responsive "Select All" + coverage diagnostic + distribution preview
        document.querySelectorAll('.var-check').forEach(cb => {
            cb.addEventListener('change', function () {
                updateSelectAllState();
                const vars = Array.from(document.querySelectorAll('.var-check:checked'))
                    .filter(c => !c.disabled).map(c => c.value);
                _renderCoverageDiagnostic(vars);
                _renderPlsMissingData();
                _renderOplsMissingData();
                _renderCorrMissingData();
                _updatePipelineStepper();
                _updateCorrStepper();
                _updatePlsStepper();
                _updateOplsStepper();
                const distBody = document.getElementById('distBody');
                if (distBody && distBody.classList.contains('show')) _refreshDistIfVisible();
            });
        });

        // AUTO-SELECT FIRST COLUMN
        selectedFactors = [firstColumnName];
        renderFactorTags();

        document.getElementById('selectAllVars').checked = false;
        document.getElementById('selectionCard').style.display = 'block';
        document.getElementById('clearDataBtn').style.display = 'block';
        document.getElementById('placeholderText').style.display = 'none';
        document.getElementById('downloadExcelBtn').style.display = 'none';
        hideDataLimitError();
        _renderPlsMissingData();
        _renderOplsMissingData();
        _renderCorrMissingData();
        _updatePipelineStepper();
        _updateCorrStepper();
        _updatePlsStepper();
        _updateOplsStepper();
    })
    .catch(err => alert("Loading Error: " + err.message));
});

// ── Clear Loaded Data button ──────────────────────────────────────────────────
document.getElementById('clearDataBtn').addEventListener('click', function() {
    // Reset all state
    globalData = null;
    lastResults = null;
    lastAnovaResults = null;
    lastAnovaRawData = null;
    lastPCAResults = null;
    lastTestResults = null;
    lastOriginalTestResults = null;
    selectedFactors = [];
    appliedTransformations = {};
    anovaVarSortModes = {};

    // Reset left panel
    document.getElementById('excelPasteBox').value = '';
    document.getElementById('selectionCard').style.display = 'none';
    document.getElementById('clearDataBtn').style.display = 'none';
    hideDataLimitError();

    // Reset right panel
    document.getElementById('resultsArea').style.display = 'none';
    document.getElementById('placeholderText').style.display = 'block';

    // Clear all results content
    const statsContent = document.getElementById('statsContent');
    if (statsContent) statsContent.innerHTML = '';
    const testResults = document.getElementById('testResults');
    if (testResults) testResults.innerHTML = '';
    const anovaResults = document.getElementById('anovaResults');
    if (anovaResults) anovaResults.innerHTML = '';
    const pcaResults = document.getElementById('pcaResults');
    if (pcaResults) pcaResults.innerHTML = '';
    const pcaPlotClear = document.getElementById('pcaPlot');
    if (pcaPlotClear) { Plotly.purge(pcaPlotClear); pcaPlotClear.style.display = 'none'; }
    const pcaStyleClear = document.getElementById('pcaStyleCard');
    if (pcaStyleClear) pcaStyleClear.style.display = 'none';
    const pcaCompRowClear = document.getElementById('pcaCompRow');
    if (pcaCompRowClear) pcaCompRowClear.style.display = 'none';
    document.getElementById('pcaLabelCol').innerHTML = '<option value="">(None — use row index)</option>';
    document.getElementById('oplsYCol').innerHTML = '<option value="">— Select column —</option>';
    lastOplsResult = null;
    ['oplsStatusMsg','oplsMetrics','oplsStyleCard','oplsDownloadRow','downloadOplsBtn'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.style.display='none';
    });
    ['oplsScorePlot','oplsSplot','oplsVipPlot'].forEach(id=>{
        const el=document.getElementById(id); if(el){Plotly.purge(el);el.style.display='none';}
    });
    lastPlsResult = null;
    ['plsStatusMsg','plsMetrics','plsStyleCard','plsDownloadRow','downloadPlsBtn'].forEach(id=>{
        const el=document.getElementById(id); if(el) el.style.display='none';
    });
    ['plsScorePlot','plsWeightsPlot','plsVipPlot'].forEach(id=>{
        const el=document.getElementById(id); if(el){Plotly.purge(el);el.style.display='none';}
    });
    document.getElementById('plsYCol').innerHTML = '<option value="">— Select column —</option>';
    const assumptionsBoxPlots = document.getElementById('assumptionsBoxPlots');
    if (assumptionsBoxPlots) assumptionsBoxPlots.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
    const assumptionsResidualsContent = document.getElementById('assumptionsResidualsContent');
    if (assumptionsResidualsContent) assumptionsResidualsContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
    const assumptionsQQContent = document.getElementById('assumptionsQQContent');
    if (assumptionsQQContent) assumptionsQQContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';

    // Hide optional UI elements
    const vizResultsHeader = document.getElementById('vizResultsHeader');
    if (vizResultsHeader) vizResultsHeader.style.display = 'none';
    const assumptionsResultsArea = document.getElementById('assumptionsResultsArea');
    if (assumptionsResultsArea) assumptionsResultsArea.style.display = 'none';
    // anova-tab is always visible in the Compare group — no need to hide
    const exportFullReportBtn = document.getElementById('exportFullReportBtn');
    if (exportFullReportBtn) exportFullReportBtn.style.display = 'none';
    const exportPubPlotsBtn = document.getElementById('exportPubPlotsBtn');
    if (exportPubPlotsBtn) exportPubPlotsBtn.style.display = 'none';
    const pubPlotStyleCard = document.getElementById('pubPlotStyleCard');
    if (pubPlotStyleCard) pubPlotStyleCard.style.display = 'none';
    const pcaResultsHeader = document.getElementById('pcaResultsHeader');
    if (pcaResultsHeader) pcaResultsHeader.style.display = 'none';
    const transformationPanel = document.getElementById('transformationPanel');
    if (transformationPanel) transformationPanel.style.display = 'none';

    // Reset variable filter
    const varFilter = document.getElementById('assumptionsVarFilter');
    if (varFilter) varFilter.innerHTML = '<option value="all">— All variables —</option>';

    // Reset scope state
    allScopeResults = {};
    lastAssumptionScopes = [];
    activeScopeKey = 'all';
    const scopeTabsEl = document.getElementById('assumptionsScopeTabs');
    if (scopeTabsEl) scopeTabsEl.innerHTML = '';
    const scopeInfoEl = document.getElementById('assumptionsScopeInfo');
    if (scopeInfoEl) { scopeInfoEl.style.display = 'none'; scopeInfoEl.innerHTML = ''; }
});

// --- 4. Analysis & Export ---
document.getElementById('updateAnalysisBtn').addEventListener('click', function() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);
    if (selectedFactors.length === 0) return alert("Select at least one factor.");
    if (selectedVars.length === 0) return alert("Select at least one variable.");

    // ── Hide correlation analysis results (stale after variable set changes) ──
    document.getElementById('corrSubTabs').style.display       = 'none';
    document.getElementById('corrSubTabContent').style.display = 'none';
    const _corrHeatStyle = document.getElementById('corrHeatmapStyleCard');
    if (_corrHeatStyle) _corrHeatStyle.style.display = 'none';
    const _corrDlHeat = document.getElementById('corrDownloadHeatmapBtn');
    if (_corrDlHeat) _corrDlHeat.style.display = 'none';
    const _corrHeader = document.getElementById('corrResultsHeader');
    if (_corrHeader) _corrHeader.style.display = 'none';
    const _corrStatus = document.getElementById('corrStatusMsg');
    if (_corrStatus) _corrStatus.innerHTML = '';
    const _corrStep4 = document.getElementById('pipelineStep4');
    if (_corrStep4) { _corrStep4.style.display = 'none'; _corrStep4.classList.add('pipeline-locked'); }
    const _corrStep4Bar = document.getElementById('step4ActionBar');
    if (_corrStep4Bar) _corrStep4Bar.style.cssText = 'display:none!important;';
    const _corrToStep4 = document.getElementById('toStep4Btn');
    if (_corrToStep4) _corrToStep4.classList.add('d-none');
    lastCorrResults = null;
    excludedVarsFromCorr.clear();

    // ── Clear all previously computed results ────────────────────────────────
    // Visualizations
    const statsContent = document.getElementById('statsContent');
    if (statsContent) statsContent.innerHTML = '';
    const vizResultsHeader = document.getElementById('vizResultsHeader');
    if (vizResultsHeader) vizResultsHeader.style.display = 'none';
    const downloadExcelBtn = document.getElementById('downloadExcelBtn');
    if (downloadExcelBtn) downloadExcelBtn.style.display = 'none';
    lastResults = null;

    // Assumptions
    const testResults = document.getElementById('testResults');
    if (testResults) testResults.innerHTML = '';
    const assumptionsResultsArea = document.getElementById('assumptionsResultsArea');
    if (assumptionsResultsArea) assumptionsResultsArea.style.display = 'none';
    const assumptionsBoxPlots = document.getElementById('assumptionsBoxPlots');
    if (assumptionsBoxPlots) assumptionsBoxPlots.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
    const assumptionsResidualsContent = document.getElementById('assumptionsResidualsContent');
    if (assumptionsResidualsContent) assumptionsResidualsContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
    const assumptionsQQContent = document.getElementById('assumptionsQQContent');
    if (assumptionsQQContent) assumptionsQQContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
    const transformationPanel = document.getElementById('transformationPanel');
    if (transformationPanel) transformationPanel.style.display = 'none';
    appliedTransformations = {};
    lastTestResults = null;
    lastOriginalTestResults = null;

    // ANOVA / Significance Tests
    const anovaResults = document.getElementById('anovaResults');
    if (anovaResults) anovaResults.innerHTML = '';
    // anova-tab is always visible in the Compare group — no need to hide
    const downloadAnovaExcelBtn = document.getElementById('downloadAnovaExcelBtn');
    if (downloadAnovaExcelBtn) downloadAnovaExcelBtn.style.display = 'none';
    lastAnovaResults = null;

    // PCA
    const pcaResults = document.getElementById('pcaResults');
    if (pcaResults) pcaResults.innerHTML = '';
    const pcaResultsHeader = document.getElementById('pcaResultsHeader');
    if (pcaResultsHeader) pcaResultsHeader.style.display = 'none';
    const pcaPlotDiv = document.getElementById('pcaPlot');
    if (pcaPlotDiv) { Plotly.purge(pcaPlotDiv); pcaPlotDiv.style.display = 'none'; }
    const pcaStyleCard = document.getElementById('pcaStyleCard');
    if (pcaStyleCard) pcaStyleCard.style.display = 'none';
    const pcaCompRow = document.getElementById('pcaCompRow');
    if (pcaCompRow) pcaCompRow.style.display = 'none';
    lastPCAResults = null;
    // ────────────────────────────────────────────────────────────────────────

    document.getElementById('resultsArea').style.display = 'block';
    document.getElementById('placeholderText').style.display = 'none';

    // Initial coverage diagnostic once data is loaded
    const initialVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    _renderCoverageDiagnostic(initialVars);
    _renderPlsMissingData();
    _renderOplsMissingData();
    _renderCorrMissingData();
});

document.getElementById('runVizBtn').addEventListener('click', function() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);
    if (selectedFactors.length === 0) return alert("Select at least one factor.");
    if (selectedVars.length === 0) return alert("Select at least one variable.");

    const statsContent = document.getElementById('statsContent');
    const loadingSpinner = document.getElementById('loadingSpinner');
    const vizResultsHeader = document.getElementById('vizResultsHeader');
    const stopBtn = document.getElementById('stopVizBtn');

    // Cancel any in-progress request
    if (vizAbortController) vizAbortController.abort();
    vizAbortController = new AbortController();

    // Clear and show loading
    loadingSpinner.style.display = 'flex';
    statsContent.innerHTML = "";
    if (stopBtn) stopBtn.style.display = 'inline-block';

    fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: globalData,
            target_columns: selectedVars,
            factors: selectedFactors
        }),
        signal: vizAbortController.signal
    })
    .then(res => res.json())
    .then(result => {
        loadingSpinner.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'none';
        if (result.error) throw new Error(result.error);
        lastResults = result;

        // Restrict regression Y + X dropdowns to the user-selected variables
        // Show header with download button
        const dlBtn = document.getElementById('downloadExcelBtn');
        const vizHeader = document.getElementById('vizResultsHeader');
        if (dlBtn) dlBtn.style.display = 'inline-block';
        if (vizHeader) vizHeader.style.display = 'block';

        result.results.forEach((res, idx) => {
            const card = document.createElement('div');
            card.className = 'col-12 mb-4';
            let headers = result.factors.map(f => `<th>${f}</th>`).join('');
            const plotDivId = `plot-viz-${idx}-${res.variable.replace(/\W/g, '_')}`;
            const plotBlock = res.plot_data && res.plot_data.length
                ? `<div id="${plotDivId}" class="mb-3"></div>`
                : `<div class="text-center overflow-auto"><img src="data:image/png;base64,${res.plot_url}" class="img-fluid rounded mb-3"></div>`;
            card.innerHTML = `
                <div class="plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border">
                    <h6 class="font-weight-bold border-bottom pb-2">${res.variable}</h6>
                    <div class="text-center overflow-auto">
                        ${plotBlock}
                    </div>
                    <details>
                        <summary class="small text-primary cursor-pointer font-weight-bold">View Data Table</summary>
                        <table class="table table-sm extra-small mt-2">
                            <thead><tr>${headers}<th>N</th><th>Mean</th><th>SD</th></tr></thead>
                            <tbody>
                                ${res.summary.map(s => `
                                    <tr>
                                        ${result.factors.map(f => `<td>${s[f]}</td>`).join('')}
                                        <td>${s.count}</td>
                                        <td>${s.mean ? s.mean.toFixed(4) : '0'}</td>
                                        <td>${s.std ? s.std.toFixed(4) : '0'}</td>
                                    </tr>`).join('')}
                                </tbody>
                            </table>
                        </details>
                    </div>
                `;
            statsContent.appendChild(card);
            if (res.plot_data && res.plot_data.length) {
                renderPlotlyBoxSwarm(plotDivId, res.plot_data, res.variable, result.factors.join(', '), res.box_stats);
            }
        });
        })
        .catch(err => {
            loadingSpinner.style.display = 'none';
            if (document.getElementById('stopVizBtn')) document.getElementById('stopVizBtn').style.display = 'none';
            if (err.name === 'AbortError') return; // user cancelled
            alert("Visualization Error: " + err.message);
        });
});

// ── Stop button handlers ──────────────────────────────────────────────────────
document.getElementById('stopVizBtn').addEventListener('click', function() {
    if (vizAbortController) { vizAbortController.abort(); vizAbortController = null; }
    document.getElementById('loadingSpinner').style.display = 'none';
    this.style.display = 'none';
});

document.getElementById('stopTestsBtn').addEventListener('click', function() {
    if (testsAbortController) { testsAbortController.abort(); testsAbortController = null; }
    document.getElementById('testSpinner').style.display = 'none';
    const transformPanel = document.getElementById('transformationPanel');
    if (transformPanel && transformPanel.getAttribute('data-was-visible') === '1') {
        transformPanel.style.display = 'block';
        transformPanel.removeAttribute('data-was-visible');
    }
    this.style.display = 'none';
});

document.getElementById('stopAnovaBtn').addEventListener('click', function() {
    if (anovaAbortController) { anovaAbortController.abort(); anovaAbortController = null; }
    document.getElementById('anovaSpinner').style.display = 'none';
    this.style.display = 'none';
});
// ─────────────────────────────────────────────────────────────────────────────

// Download Results (Visualizations tab)
// Excel is built server-side (Python/openpyxl) — better for multi-sheet styling.
// Plotly plots exist only in the browser, so we capture them here and send as base64 PNGs.
document.getElementById('downloadExcelBtn').addEventListener('click', async function() {
    if (!lastResults) return;

    const btn = this;
    const spinner = document.getElementById('vizExportSpinner');
    btn.disabled = true;
    if (spinner) spinner.style.display = 'inline-flex';

    try {
        // Capture current Plotly plots from the Visualizations tab
        const plotCaptures = [];
        const plotDivs = document.querySelectorAll('#statsContent .js-plotly-plot');
        for (const div of plotDivs) {
            try {
                const img = await Plotly.toImage(div, { format: 'png', width: 700, height: 380 });
                const varLabel = div.id || '';
                plotCaptures.push({ id: varLabel, image: img.split(',')[1] });
            } catch(e) { /* skip if not a Plotly plot */ }
        }

        const payload = { ...lastResults, plotly_captures: plotCaptures };

        const res = await fetch(EXPORT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Box_plots.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch(err) {
        alert('Export Error: ' + err.message);
    } finally {
        btn.disabled = false;
        if (spinner) spinner.style.display = 'none';
    }
});

// --- 5. PCA Analysis Logic ---

// ── Color palettes (matching matplotlib/seaborn names) ───────────────────────
const PCA_PALETTES = {
    nipy_spectral: ['#4B0082','#0000FF','#008CFF','#00BFFF','#00FF80','#80FF00',
                    '#FFFF00','#FFA500','#FF4500','#FF0000','#8B0000','#FF69B4'],
    Set1:    ['#E41A1C','#377EB8','#4DAF4A','#984EA3','#FF7F00','#A65628','#F781BF','#999999'],
    tab10:   ['#1F77B4','#FF7F0E','#2CA02C','#D62728','#9467BD','#8C564B','#E377C2','#7F7F7F','#BCBD22','#17BECF'],
    Paired:  ['#A6CEE3','#1F78B4','#B2DF8A','#33A02C','#FB9A99','#E31A1C','#FDBF6F','#FF7F00','#CAB2D6','#6A3D9A'],
    Dark2:   ['#1B9E77','#D95F02','#7570B3','#E7298A','#66A61E','#E6AB02','#A6761D','#666666'],
};

const PCA_SYMBOLS = ['circle','square','diamond','triangle-up','triangle-down',
                     'star','cross','x','pentagon','hexagram'];

// ── Confidence ellipse — exact port of matplotlib's confidence_ellipse recipe ─
// Uses Pearson correlation + 45° rotation + marginal std scaling, identical to
// the Python backend that was previously used.
function pcaComputeEllipse(x, y, nStd) {
    const n = x.length;
    if (n < 3) return null;
    const mx  = x.reduce((a, b) => a + b, 0) / n;
    const my  = y.reduce((a, b) => a + b, 0) / n;
    const cxx = x.reduce((a, xi)     => a + (xi - mx) ** 2,          0) / (n - 1);
    const cyy = y.reduce((a, yi)     => a + (yi - my) ** 2,          0) / (n - 1);
    const cxy = x.reduce((a, xi, i)  => a + (xi - mx) * (y[i] - my), 0) / (n - 1);
    if (cxx < 1e-12 || cyy < 1e-12) return null;
    const pearson = cxy / Math.sqrt(cxx * cyy);
    const rx = Math.sqrt(1 + pearson);                    // ellipse radius along 45° axis
    const ry = Math.sqrt(Math.max(0, 1 - pearson));       // ellipse radius along 135° axis
    const sx = Math.sqrt(cxx) * nStd;                     // x marginal scale
    const sy = Math.sqrt(cyy) * nStd;                     // y marginal scale
    const pts = 120;
    const ex = [], ey = [];
    for (let k = 0; k <= pts; k++) {
        const t = 2 * Math.PI * k / pts;
        // Rotate 45° then scale by marginal std devs (mirrors matplotlib Affine2D transform)
        const xr = (rx * Math.cos(t) - ry * Math.sin(t)) / Math.SQRT2;
        const yr = (rx * Math.cos(t) + ry * Math.sin(t)) / Math.SQRT2;
        ex.push(mx + sx * xr);
        ey.push(my + sy * yr);
    }
    return { x: ex, y: ey };
}

// ── Read current style controls ──────────────────────────────────────────────
function pcaReadOptions() {
    return {
        symbol:         document.getElementById('pcaSymbol').value,
        varySymbol:     document.getElementById('pcaVarySymbol').checked,
        pointSize:      parseInt(document.getElementById('pcaPointSize').value),
        opacity:        parseInt(document.getElementById('pcaOpacity').value) / 100,
        showEllipse:    document.getElementById('pcaShowEllipse').checked,
        ellipseOpacity: parseInt(document.getElementById('pcaEllipseOpacity').value) / 100,
        nStd:           parseFloat(document.querySelector('.pca-std-btn.active')?.dataset.val || '2'),
        showLoadings:   document.getElementById('pcaShowLoadings').checked,
        loadingsScale:  parseFloat(document.getElementById('pcaLoadingsScale').value),
        loadingsThresh: parseFloat(document.getElementById('pcaLoadingsThresh').value),
        loadingsTopN:   parseInt(document.getElementById('pcaLoadingsTopN').value) || 0,
        palette:        document.querySelector('.pca-palette-btn.active')?.dataset.palette || 'nipy_spectral',
        showLabels:     document.getElementById('pcaShowLabels').checked,
        showGrid:       document.getElementById('pcaShowGrid').checked,
        showBorder:     document.getElementById('pcaShowBorder').checked,
        centerAxes:     document.getElementById('pcaCenterAxes').checked,
        fontFamily:     document.getElementById('pcaFontFamily').value,
        titleFontSize:  parseInt(document.getElementById('pcaTitleFontSize').value),
        tickFontSize:   parseInt(document.getElementById('pcaTickFontSize').value),
        legendFontSize: parseInt(document.getElementById('pcaLegendFontSize').value),
        xComp:          parseInt(document.getElementById('pcaXComp')?.value || '1'),
        yComp:          parseInt(document.getElementById('pcaYComp')?.value || '2'),
    };
}

// ── Main Plotly rendering function ───────────────────────────────────────────
function renderPCAPlot(result, opts) {
    const plotDiv = document.getElementById('pcaPlot');
    plotDiv.style.display = 'block';

    const xC = opts.xComp || 1;   // 1-based PC index for X axis
    const yC = opts.yComp || 2;   // 1-based PC index for Y axis
    const xKey = `PC${xC}`;
    const yKey = `PC${yC}`;
    const xLoadKey = `PC${xC}_Loading`;
    const yLoadKey = `PC${yC}_Loading`;

    const scores  = result.scores || [];
    // Preserve order of first appearance in data (= original row order from Excel)
    const _seenG = new Set();
    const groups = scores.reduce((acc, r) => {
        if (!_seenG.has(r.group)) { _seenG.add(r.group); acc.push(r.group); }
        return acc;
    }, []);
    const colors  = PCA_PALETTES[opts.palette] || PCA_PALETTES.nipy_spectral;
    const ev      = result.explained_variance || [];
    const traces  = [];

    groups.forEach((grp, gi) => {
        const pts   = scores.filter(r => r.group === grp);
        const xs    = pts.map(r => r[xKey]);
        const ys    = pts.map(r => r[yKey]);
        const color = colors[gi % colors.length];
        const sym   = opts.varySymbol ? PCA_SYMBOLS[gi % PCA_SYMBOLS.length] : opts.symbol;

        // Confidence ellipse trace (drawn first so it sits behind points)
        if (opts.showEllipse) {
            const ell = pcaComputeEllipse(xs, ys, opts.nStd);
            if (ell) {
                traces.push({
                    x: ell.x, y: ell.y,
                    mode: 'lines',
                    fill: 'toself',
                    fillcolor: color,
                    opacity: opts.ellipseOpacity,
                    line: { color, width: 1.5 },
                    hoverinfo: 'skip',
                    showlegend: false,
                    name: grp + ' ellipse',
                });
            }
        }

        // Scatter trace
        const labels = pts.map(r => r.label || '');
        traces.push({
            x: xs, y: ys,
            mode: opts.showLabels ? 'markers+text' : 'markers',
            name: grp,
            marker: { symbol: sym, size: opts.pointSize, color, opacity: opts.opacity,
                      line: { color: 'white', width: 1 } },
            text: labels,
            textposition: 'top center',
            textfont: { family: opts.fontFamily, size: opts.tickFontSize - 1, color: '#333' },
            customdata: pts.map((_, i) => `${grp}<br>${labels[i]}<br>${xKey}: ${(xs[i]||0).toFixed(3)}<br>${yKey}: ${(ys[i]||0).toFixed(3)}`),
            hovertemplate: '%{customdata}<extra></extra>',
        });
    });

    // Loading arrows as annotations + invisible scatter for hover
    const annotations = [];
    const arrowX = [], arrowY = [], arrowText = [];
    let visibleLoadings = [];
    if (opts.showLoadings && result.loadings) {
        // Compute 2D Euclidean magnitude on the visible axes (= arrow length on plot)
        let filtered = result.loadings
            .filter(l => l[xLoadKey] != null && l[yLoadKey] != null)
            .map(l => ({ ...l, _mag: Math.sqrt(l[xLoadKey] ** 2 + l[yLoadKey] ** 2) }));

        // Apply magnitude threshold
        if (opts.loadingsThresh > 0) {
            filtered = filtered.filter(l => l._mag >= opts.loadingsThresh);
        }

        // Apply Top-N (sort by magnitude desc, keep top N)
        filtered.sort((a, b) => b._mag - a._mag);
        if (opts.loadingsTopN > 0) {
            filtered = filtered.slice(0, opts.loadingsTopN);
        }

        visibleLoadings = filtered;

        const sc = opts.loadingsScale;
        filtered.forEach(l => {
            const lx = l[xLoadKey] * sc, ly = l[yLoadKey] * sc;
            const rawLx = l[xLoadKey], rawLy = l[yLoadKey];
            annotations.push({
                x: lx, y: ly,
                ax: 0, ay: 0, xref: 'x', yref: 'y', axref: 'x', ayref: 'y',
                showarrow: true, arrowhead: 3, arrowsize: 1.2,
                arrowwidth: 1.8, arrowcolor: '#2d3436',
            });
            annotations.push({
                x: lx * 1.18, y: ly * 1.18,
                text: `<b>${l.Variable}</b>`,
                showarrow: false, xref: 'x', yref: 'y',
                font: { color: '#d63031', size: 11 },
                bgcolor: 'rgba(255,255,255,0.75)', borderpad: 2,
            });
            arrowX.push(lx);
            arrowY.push(ly);
            arrowText.push(`${l.Variable}<br>(${xKey}: ${rawLx.toFixed(3)}, ${yKey}: ${rawLy.toFixed(3)})`);
        });
        if (arrowX.length) {
            traces.push({
                x: arrowX, y: arrowY, text: arrowText,
                mode: 'markers', marker: { opacity: 0, size: 8 },
                hovertemplate: `<b>%{text}</b><extra></extra>`,
                showlegend: false, name: 'Loadings',
            });
        }
    }

    // Compute axis ranges from all trace data (scatter + ellipses + loadings)
    // with 12% padding so ellipses and arrow labels are never clipped.
    const allX = [], allY = [];
    traces.forEach(tr => { allX.push(...(tr.x || [])); allY.push(...(tr.y || [])); });
    if (opts.showLoadings && visibleLoadings.length) {
        const sc = opts.loadingsScale;
        visibleLoadings.forEach(l => {
            allX.push(l[xLoadKey] * sc * 1.25); allY.push(l[yLoadKey] * sc * 1.25);
        });
    }
    const pad = (arr, frac = 0.12) => {
        const mn = Math.min(...arr), mx = Math.max(...arr);
        const span = mx - mn || 1;
        return [mn - span * frac, mx + span * frac];
    };
    const xRange = allX.length ? pad(allX) : [-1, 1];
    const yRange = allY.length ? pad(allY) : [-1, 1];

    // Center axes: expand each range symmetrically around zero
    let xRangeFinal = xRange, yRangeFinal = yRange;
    if (opts.centerAxes) {
        const xMax = Math.max(Math.abs(xRange[0]), Math.abs(xRange[1]));
        const yMax = Math.max(Math.abs(yRange[0]), Math.abs(yRange[1]));
        xRangeFinal = [-xMax, xMax];
        yRangeFinal = [-yMax, yMax];
    }

    const axisFont   = { family: opts.fontFamily, size: opts.tickFontSize };
    const titleFont  = { family: opts.fontFamily, size: opts.titleFontSize };
    const borderLine = opts.showBorder ? { showline: true, mirror: true, linecolor: '#888', linewidth: 1 } : { showline: false, mirror: false };
    const evX = ev[xC - 1] != null ? ` (${(ev[xC - 1] * 100).toFixed(1)}%)` : '';
    const evY = ev[yC - 1] != null ? ` (${(ev[yC - 1] * 100).toFixed(1)}%)` : '';

    const layout = {
        xaxis: {
            title: { text: `${xKey}${evX}`, font: titleFont },
            tickfont: axisFont,
            range: xRangeFinal,
            zeroline: true, zerolinewidth: 1, zerolinecolor: '#aaa',
            showgrid: opts.showGrid, gridcolor: '#eee',
            ...borderLine,
        },
        yaxis: {
            title: { text: `${yKey}${evY}`, font: titleFont },
            tickfont: axisFont,
            range: yRangeFinal,
            zeroline: true, zerolinewidth: 1, zerolinecolor: '#aaa',
            showgrid: opts.showGrid, gridcolor: '#eee',
            ...borderLine,
        },
        annotations,
        legend: {
            bgcolor: 'rgba(255,255,255,0.8)', bordercolor: '#ddd', borderwidth: 1,
            font: { family: opts.fontFamily, size: opts.legendFontSize },
        },
        margin: { l: 60, r: 30, t: 40, b: 60 },
        plot_bgcolor: '#fff',
        paper_bgcolor: '#fff',
        autosize: true,
    };

    Plotly.react(plotDiv, traces, layout, { responsive: true, displayModeBar: true,
        modeBarButtonsToRemove: ['select2d','lasso2d'], displaylogo: false });

    renderLoadingsTable(result, opts, visibleLoadings, xLoadKey, yLoadKey);
}

// ── PCA Loadings Table ────────────────────────────────────────────────────────
let _loadingsSortCol = '_mag';
let _loadingsSortAsc = false;

function renderLoadingsTable(result, opts, visibleLoadings, xLoadKey, yLoadKey) {
    const container = document.getElementById('pcaLoadingsTable');
    if (!opts.showLoadings || !result.loadings || result.loadings.length === 0) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }

    const visibleVars = new Set(visibleLoadings.map(l => l.Variable));
    const xKey = xLoadKey.replace('_Loading', '');
    const yKey = yLoadKey.replace('_Loading', '');

    // Build full list with magnitudes for table (all variables, not just visible)
    const rows = result.loadings
        .filter(l => l[xLoadKey] != null && l[yLoadKey] != null)
        .map(l => ({ ...l, _mag: Math.sqrt(l[xLoadKey] ** 2 + l[yLoadKey] ** 2) }));

    // Sort
    rows.sort((a, b) => {
        const va = a[_loadingsSortCol] ?? 0, vb = b[_loadingsSortCol] ?? 0;
        return _loadingsSortAsc ? va - vb : vb - va;
    });

    const arrow = col => col === _loadingsSortCol ? (_loadingsSortAsc ? ' ▲' : ' ▼') : '';
    const cols = [
        { key: 'Variable', label: 'Variable',        numeric: false },
        { key: xLoadKey,   label: `${xKey} loading`, numeric: true  },
        { key: yLoadKey,   label: `${yKey} loading`, numeric: true  },
        { key: '_mag',     label: 'Magnitude (2D)',   numeric: true  },
    ];

    const headerCells = cols.map(c =>
        `<th scope="col" data-col="${c.key}" style="cursor:pointer;white-space:nowrap;">${c.label}${arrow(c.key)}</th>`
    ).join('');

    const bodyRows = rows.map(r => {
        const highlighted = visibleVars.has(r.Variable);
        const rowClass = highlighted ? 'table-primary font-weight-bold' : 'text-muted';
        const cells = cols.map(c => {
            const val = r[c.key];
            if (!c.numeric) return `<td>${val}</td>`;
            const formatted = typeof val === 'number' ? val.toFixed(3) : val;
            const color = c.key !== '_mag' && typeof val === 'number'
                ? (val > 0 ? 'style="color:#0984e3;"' : 'style="color:#d63031;"') : '';
            return `<td ${color}>${formatted}</td>`;
        }).join('');
        return `<tr class="${rowClass}">${cells}</tr>`;
    }).join('');

    const nVisible = visibleVars.size;
    const nTotal = rows.length;
    const subtitle = nVisible < nTotal
        ? `<span class="text-primary font-weight-bold">${nVisible} shown</span> / ${nTotal} total`
        : `${nTotal} variables`;

    container.style.display = 'block';
    container.innerHTML = `
        <div class="card">
            <div class="card-header py-2 px-3 d-flex justify-content-between align-items-center">
                <span class="small font-weight-semibold">Variable Loadings — ${subtitle}</span>
                <span class="small text-muted">Highlighted rows = visible arrows &nbsp;|&nbsp; Click column header to sort</span>
            </div>
            <div style="max-height:280px; overflow-y:auto;">
                <table class="table table-sm table-bordered table-hover mb-0 small" id="pcaLoadingsTbl">
                    <thead class="thead-light" style="position:sticky;top:0;">
                        <tr>${headerCells}</tr>
                    </thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
        </div>`;

    // Sort on header click
    container.querySelectorAll('th[data-col]').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (_loadingsSortCol === col) {
                _loadingsSortAsc = !_loadingsSortAsc;
            } else {
                _loadingsSortCol = col;
                _loadingsSortAsc = col === 'Variable';
            }
            if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
        });
    });
}

// ── Style control event listeners (re-render on any change) ──────────────────
['pcaSymbol','pcaVarySymbol','pcaPointSize','pcaOpacity','pcaShowEllipse','pcaShowLoadings']
    .forEach(id => document.getElementById(id).addEventListener('input', () => {
        if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
    }));
['pcaSymbol','pcaVarySymbol','pcaShowEllipse','pcaShowLoadings']
    .forEach(id => document.getElementById(id).addEventListener('change', () => {
        if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
    }));

// Show/hide loadings filter options panel
document.getElementById('pcaShowLoadings').addEventListener('change', function() {
    document.getElementById('pcaLoadingsOptions').style.display = this.checked ? 'block' : 'none';
});

// Loadings scale slider — update label + re-render
document.getElementById('pcaLoadingsScale').addEventListener('input', function() {
    document.getElementById('pcaLoadingsScaleVal').textContent = parseFloat(this.value).toFixed(1) + '×';
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});

// Loadings threshold slider — update label + re-render
document.getElementById('pcaLoadingsThresh').addEventListener('input', function() {
    document.getElementById('pcaLoadingsThreshVal').textContent = parseFloat(this.value).toFixed(2);
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});

// Top-N input — re-render
document.getElementById('pcaLoadingsTopN').addEventListener('input', () => {
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});

['pcaXComp', 'pcaYComp'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
        _updatePipelineStepper();
        if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
    });
});

document.getElementById('pcaPointSize').addEventListener('input', function() {
    document.getElementById('pcaPointSizeVal').textContent = this.value;
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});
document.getElementById('pcaOpacity').addEventListener('input', function() {
    document.getElementById('pcaOpacityVal').textContent = this.value;
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});
document.getElementById('pcaEllipseOpacity').addEventListener('input', function() {
    document.getElementById('pcaEllipseOpacityVal').textContent = this.value;
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});

// Sample label toggle (re-render only, no new fetch needed)
document.getElementById('pcaShowLabels').addEventListener('change', () => {
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});

// Layout & typography controls
['pcaShowGrid','pcaShowBorder','pcaCenterAxes'].forEach(id => {
    document.getElementById(id).addEventListener('change', () => {
        if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
    });
});
document.getElementById('pcaFontFamily').addEventListener('change', () => {
    if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
});
[['pcaTitleFontSize','pcaTitleFontSizeVal'],
 ['pcaTickFontSize', 'pcaTickFontSizeVal'],
 ['pcaLegendFontSize','pcaLegendFontSizeVal']].forEach(([sliderId, valId]) => {
    document.getElementById(sliderId).addEventListener('input', function() {
        document.getElementById(valId).textContent = this.value;
        if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
    });
});

document.querySelectorAll('.pca-std-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.pca-std-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
    });
});

document.querySelectorAll('.pca-palette-btn').forEach(btn => {
    btn.addEventListener('click', function() {
        document.querySelectorAll('.pca-palette-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        if (lastPCAResults) renderPCAPlot(lastPCAResults, pcaReadOptions());
    });
});

// ── Correlation pipeline stepper — live values ───────────────────────────────
function _updateCorrStepper() {
    const checkedVars = Array.from(document.querySelectorAll('.var-check:checked')).filter(cb => !cb.disabled);
    const nVars = checkedVars.length;
    const p1 = document.getElementById('corrPipe1Val');
    if (p1) p1.textContent = nVars === 0 ? 'None selected' : `${nVars} var${nVars !== 1 ? 's' : ''} selected`;

    const minCov = parseInt(document.getElementById('minRowCoverage')?.value || 0);
    const p2 = document.getElementById('corrPipe2Val');
    if (p2) p2.textContent = minCov > 0 ? `Coverage ≥ ${minCov}%` : 'No row filter';

    const method = document.querySelector('.corr-method-btn.active')?.dataset.method || 'pearson';
    const methodLabels = { pearson: 'Pearson', spearman: 'Spearman', kendall: 'Kendall' };
    const p3 = document.getElementById('corrPipe3Val');
    if (p3) p3.textContent = methodLabels[method] || method;

    const pThresh = document.getElementById('corrPThresh')?.value || '0.05';
    const p4 = document.getElementById('corrPipe4Val');
    if (p4) p4.textContent = `|r| ≥ ${corrThreshold.toFixed(2)} · p ≤ ${pThresh}`;

    const p5 = document.getElementById('corrPipe5Val');
    if (p5) p5.textContent = pcaVarsFromCorr.size > 0
        ? `${pcaVarsFromCorr.size} var${pcaVarsFromCorr.size !== 1 ? 's' : ''} sent`
        : 'Not sent yet';
}

// ── PLS pipeline stepper — live values ───────────────────────────────────────
function _updatePlsStepper() {
    const checkedVars = Array.from(document.querySelectorAll('.var-check:checked')).filter(cb => !cb.disabled);
    const nVars = checkedVars.length;
    const p1 = document.getElementById('plsPipe1Val');
    if (p1) p1.textContent = nVars === 0 ? 'None selected' : `${nVars} var${nVars !== 1 ? 's' : ''} selected`;

    const yCol = document.getElementById('plsYCol')?.value || '';
    const p2 = document.getElementById('plsPipe2Val');
    if (p2) p2.textContent = yCol || 'Not set';

    const method = document.querySelector('.pls-method-btn.active')?.dataset.method || 'pls-da';
    const p3 = document.getElementById('plsPipe3Val');
    if (p3) p3.textContent = method === 'pls-da' ? 'PLS-DA' : 'PLS';

    const nComp = document.getElementById('plsNComponents')?.value || '2';
    const p4 = document.getElementById('plsPipe4Val');
    if (p4) p4.textContent = `${nComp} LV${parseInt(nComp) !== 1 ? 's' : ''}`;

    const p5 = document.getElementById('plsPipe5Val');
    if (p5) {
        if (lastPlsResult) {
            const r2y = `R²Y = ${(lastPlsResult.r2y * 100).toFixed(1)}%`;
            const q2  = lastPlsResult.q2 != null ? ` · Q² = ${(lastPlsResult.q2 * 100).toFixed(1)}%` : '';
            p5.textContent = r2y + q2;
        } else { p5.textContent = 'Awaiting run'; }
    }
}

// ── OPLS pipeline stepper — live values ──────────────────────────────────────
function _updateOplsStepper() {
    const checkedVars = Array.from(document.querySelectorAll('.var-check:checked')).filter(cb => !cb.disabled);
    const nVars = checkedVars.length;
    const p1 = document.getElementById('oplsPipe1Val');
    if (p1) p1.textContent = nVars === 0 ? 'None selected' : `${nVars} var${nVars !== 1 ? 's' : ''} selected`;

    const yCol = document.getElementById('oplsYCol')?.value || '';
    const p2 = document.getElementById('oplsPipe2Val');
    if (p2) p2.textContent = yCol || 'Not set';

    const method = document.querySelector('.opls-method-btn.active')?.dataset.method || 'opls-da';
    const p3 = document.getElementById('oplsPipe3Val');
    if (p3) p3.textContent = method === 'opls-da' ? 'OPLS-DA' : 'OPLS';

    const nOrtho = document.getElementById('oplsNOrtho')?.value || '1';
    const p4 = document.getElementById('oplsPipe4Val');
    if (p4) p4.textContent = `${nOrtho} ortho. comp.`;

    const p5 = document.getElementById('oplsPipe5Val');
    if (p5) {
        if (lastOplsResult) {
            const r2y = `R²Y = ${(lastOplsResult.r2y * 100).toFixed(1)}%`;
            const q2  = lastOplsResult.q2 != null ? ` · Q² = ${(lastOplsResult.q2 * 100).toFixed(1)}%` : '';
            p5.textContent = r2y + q2;
        } else { p5.textContent = 'Awaiting run'; }
    }
}

// ── PCA pipeline stepper — live values ───────────────────────────────────────
function _updatePipelineStepper() {
    // Step 1: Variables
    const checkedVars = Array.from(document.querySelectorAll('.var-check:checked')).filter(cb => !cb.disabled);
    const nVars = checkedVars.length;
    const nFromCorr = checkedVars.filter(cb => pcaVarsFromCorr.has(cb.value)).length;
    const pipe1 = document.getElementById('pipe1Val');
    if (pipe1) {
        if      (nVars === 0)            pipe1.textContent = 'None selected';
        else if (nFromCorr === nVars)    pipe1.textContent = `${nVars} var${nVars !== 1 ? 's' : ''} from Corr.`;
        else if (nFromCorr > 0)          pipe1.textContent = `${nVars} vars (${nFromCorr} from Corr.)`;
        else                             pipe1.textContent = `${nVars} var${nVars !== 1 ? 's' : ''} selected`;
    }

    // Step 2: Preprocessing
    const minCov = parseInt(document.getElementById('minRowCoverage')?.value || 0);
    const pipe2  = document.getElementById('pipe2Val');
    if (pipe2) pipe2.textContent = minCov > 0 ? `Coverage ≥ ${minCov}%` : 'No row filter';

    // Step 3: Missing data
    const method   = document.getElementById('pcaMethod')?.value || 'svd';
    const strategy = document.getElementById('pcaMissingStrategy')?.value || 'hybrid';
    const thresh   = document.getElementById('pcaMissingThreshold')?.value || '30';
    const pipe3    = document.getElementById('pipe3Val');
    if (pipe3) {
        if (method === 'nipals' || method === 'em_pca') {
            pipe3.textContent = 'Handled natively';
        } else {
            const labels = { hybrid: 'Hybrid', drop_rows: 'Drop rows', impute_group_mean: 'Group mean', knn: 'KNN', exclude_vars: 'Excl. vars' };
            const label  = labels[strategy] || strategy;
            pipe3.textContent = ['hybrid', 'exclude_vars'].includes(strategy) ? `${label} · ≤${thresh}%` : label;
        }
    }

    // Step 4: Algorithm
    const algLabels = { svd: 'SVD', nipals: 'NIPALS', em_pca: 'EM-PCA' };
    const pipe4 = document.getElementById('pipe4Val');
    if (pipe4) pipe4.textContent = algLabels[method] || method;

    // Step 5: Biplot
    const pipe5 = document.getElementById('pipe5Val');
    if (pipe5) {
        if (lastPCAResults) {
            const x = document.getElementById('pcaXComp')?.value || '1';
            const y = document.getElementById('pcaYComp')?.value || '2';
            pipe5.textContent = `PC${x} vs PC${y} · ${lastPCAResults.n_samples} samples`;
        } else {
            pipe5.textContent = 'Awaiting run';
        }
    }
}

// Update labels / notes when the PCA algorithm changes
function _pcaMethodChanged() {
    const method = document.getElementById('pcaMethod').value;
    const native = method === 'nipals' || method === 'em_pca';
    document.getElementById('pcaNativeNote').style.display = native ? 'block' : 'none';
    document.getElementById('pcaMissingAccordionLabel').textContent =
        native ? 'Algorithm & Variable Exclusion' : 'Algorithm & Missing Data Strategy';
    // Disable (but keep visible) the imputation strategy for native-missing methods
    const stratSel = document.getElementById('pcaMissingStrategy');
    stratSel.disabled = native;
    stratSel.style.opacity = native ? '0.45' : '1';
    stratSel.style.pointerEvents = native ? 'none' : '';
    _renderPCADataPreview();
    _updatePipelineStepper();
}
document.getElementById('pcaMethod').addEventListener('change', _pcaMethodChanged);

// Show/hide the threshold input depending on the selected imputation strategy
document.getElementById('pcaMissingStrategy').addEventListener('change', function() {
    const needsThreshold = ['hybrid', 'exclude_vars'].includes(this.value);
    document.getElementById('pcaThresholdRow').style.display = needsThreshold ? 'flex' : 'none';
    _renderPCADataPreview();
    _updatePipelineStepper();
});
document.getElementById('pcaMissingThreshold').addEventListener('input', () => { _renderPCADataPreview(); _updatePipelineStepper(); });
document.getElementById('pcaAverageByFactor').addEventListener('change', _renderPCADataPreview);

document.getElementById('runPCABtn').addEventListener('click', function() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);
    const pcaMethod        = document.getElementById('pcaMethod').value;
    const missingStrategy  = document.getElementById('pcaMissingStrategy').value;
    const missingThreshold = parseFloat(document.getElementById('pcaMissingThreshold').value) || 30;
    const averageByFactor  = document.getElementById('pcaAverageByFactor').checked;
    const labelCol         = document.getElementById('pcaLabelCol').value || null;

    if (selectedVars.length < 2) {
        return alert("PCA requires at least 2 variables to compare.");
    }

    const pcaResults = document.getElementById('pcaResults');
    const pcaSpinner = document.getElementById('pcaSpinner');
    const pcaHeader  = document.getElementById('pcaResultsHeader');
    const pcaPlot    = document.getElementById('pcaPlot');

    pcaResults.innerHTML = "";
    pcaPlot.style.display = 'none';
    pcaHeader.style.display = 'none';
    pcaSpinner.style.display = 'block';

    fetch('/run-pca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: globalData,
            variables: selectedVars,
            factors: selectedFactors,
            pca_method: pcaMethod,
            missing_strategy: missingStrategy,
            missing_threshold: missingThreshold,
            min_row_coverage: _getMinRowCoverage(),
            average_by_factors: averageByFactor,
            label_col: labelCol,
            per_var_transforms: usePerVarMode
                ? Object.fromEntries(selectedVars.map(v => [v, _getVarTransform(v)]))
                : (currentNormTransform !== 'none'
                    ? Object.fromEntries(selectedVars.map(v => [v, currentNormTransform]))
                    : {}),
        })
    })
    .then(res => res.text().then(text => {
        try { return JSON.parse(text); }
        catch(e) {
            console.error("PCA: server returned non-JSON response (first 2000 chars):", text.substring(0, 2000));
            // Locate bare NaN tokens; distinguish NaN in loadings (real failure)
            // from NaN in pca_table (serialisation issue — original missing values).
            const nanInLoadings = [];
            const nanInTable    = [];
            const nanRe = /\bNaN\b/g;
            let nm;
            while ((nm = nanRe.exec(text)) !== null) {
                const before   = text.substring(Math.max(0, nm.index - 600), nm.index);
                const inLoad   = /\b(loadings|explained_variance|scores)\b/.test(before.substring(before.length - 200));
                const varM     = before.match(/[\s\S]*"Variable"\s*:\s*"([^"]+)"/);
                const fieldM   = before.match(/[\s\S]*"([^"]+)"\s*:\s*$/);
                const label    = varM ? varM[1] : (fieldM ? fieldM[1] : null);
                if (inLoad) { if (label && !nanInLoadings.includes(label)) nanInLoadings.push(label); }
                else        { if (label && !nanInTable.includes(label))    nanInTable.push(label); }
            }
            throw Object.assign(new Error('nan_in_response'), { nanInLoadings, nanInTable });
        }
    }))
    .then(result => {
        pcaSpinner.style.display = 'none';
        if (result.error) throw Object.assign(new Error(result.error), { isServerError: true });

        lastPCAResults = result;
        _updatePipelineStepper();
        pcaHeader.style.display = 'flex';

        // Move Plot Style card just before #pcaPlot (once, if not already there)
        const _styleCard = document.getElementById('pcaStyleCard');
        const _pcaPlot   = document.getElementById('pcaPlot');
        if (_styleCard && _pcaPlot && _pcaPlot.previousElementSibling !== _styleCard) {
            _pcaPlot.parentNode.insertBefore(_styleCard, _pcaPlot);
        }
        _styleCard.style.display = 'block';

        // Populate and show axis selectors
        const nComp = result.n_components || result.explained_variance.length;
        const xSel = document.getElementById('pcaXComp');
        const ySel = document.getElementById('pcaYComp');
        [xSel, ySel].forEach(sel => {
            sel.innerHTML = '';
            for (let k = 1; k <= nComp; k++) {
                const o = document.createElement('option');
                o.value = k; o.textContent = `PC${k}`;
                sel.appendChild(o);
            }
        });
        xSel.value = '1';
        ySel.value = nComp >= 2 ? '2' : '1';
        document.getElementById('pcaCompRow').style.display = nComp >= 2 ? 'flex' : 'none';

        const totalRows = result.n_input_rows || (globalData || []).length;
        const nVarsUsed = (result.vars_used   || selectedVars).length;
        const nVarsExcl = (result.vars_excluded || []).length;
        const nImputed      = result.n_imputed_cells    || 0;
        const nDropped      = result.rows_dropped       || 0;
        const nSparseDropped = result.rows_sparse_dropped || 0;

        const strategyNotes = [];
        if (nVarsExcl     > 0) strategyNotes.push(`${nVarsExcl} variable${nVarsExcl > 1 ? 's' : ''} excluded (too many missing values)`);
        if (nImputed      > 0) strategyNotes.push(`${nImputed} missing cell${nImputed > 1 ? 's' : ''} imputed`);
        if (nDropped      > 0) strategyNotes.push(`${nDropped} row${nDropped > 1 ? 's' : ''} dropped (missing values)`);
        if (nSparseDropped > 0) strategyNotes.push(`${nSparseDropped} sample${nSparseDropped > 1 ? 's' : ''} excluded (coverage &lt; ${_getMinRowCoverage()}%)`);
        const missingNote = strategyNotes.length > 0
            ? `<br><span style="color:#155724; font-weight:600;">${strategyNotes.join('; ')}</span>` : '';

        const evLines = result.explained_variance.map((v, i) =>
            `<br>PC${i + 1} explains ${(v * 100).toFixed(1)}% of variance.`).join('');
        const methodLabels = { svd: 'SVD', nipals: 'NIPALS', em_pca: 'EM-PCA' };
        const methodTag = methodLabels[result.pca_method || 'svd'] || result.pca_method;
        pcaResults.innerHTML = `
            <div class="alert alert-success py-2 small shadow-sm text-left mb-2">
                <strong>PCA Success</strong> <span class="badge badge-secondary ml-1">${methodTag}</span>
                — ${result.n_samples} of ${totalRows} samples analyzed
                (${nVarsUsed} variables, ${selectedFactors.length} factors).${missingNote}
                ${evLines}
            </div>`;

        renderPCAPlot(result, pcaReadOptions());
    })
    .catch(err => {
        pcaSpinner.style.display = 'none';
        pcaHeader.style.display = 'none';

        const strategyTips = `
            <div class="mt-2">
                <strong>Suggestions — try a different <em>Missing data strategy</em>:</strong>
                <ul class="mb-1 mt-1 pl-3">
                    <li><strong>Impute group / column mean</strong> — fills each missing cell with the
                        mean of its factor group (or the column mean as fallback).
                        Best when only a few values are missing within a group.</li>
                    <li><strong>Hybrid (recommended)</strong> — excludes variables that are mostly
                        missing, then imputes the remaining sparse gaps.</li>
                    <li><strong>KNN imputation</strong> — estimates missing values from the
                        k nearest neighbours; works well when missingness is scattered.</li>
                    <li><strong>Exclude variables &gt; threshold</strong> — raise the threshold
                        so the offending variable is automatically dropped.</li>
                    <li><strong>Drop rows</strong> — removes any row that has a missing value
                        in a selected variable; keeps only fully-observed samples.</li>
                </ul>
                You can also <strong>deselect the problematic variable(s)</strong> in the
                variable list above.
            </div>`;

        let body;
        if (err.message === 'nan_in_response') {
            if (err.nanInLoadings && err.nanInLoadings.length) {
                // NaN in scores/loadings — genuine computation failure
                const varList = `<br><strong>Affected variable(s):</strong> ${err.nanInLoadings.map(v => `<code>${v}</code>`).join(', ')}`;
                body = `<strong>PCA Error — NaN in computed result.</strong>
                    One or more variables could not be decomposed, likely because all values
                    within a factor group are missing or the variable has near-zero variance.${varList}
                    ${strategyTips}`;
            } else {
                // NaN only in raw data table — serialisation issue (should be fixed, but report if it recurs)
                body = `<strong>PCA Error — NaN serialisation issue.</strong>
                    The server response contained unserialised NaN values in the raw data table.
                    This is a known serialisation bug — please report it. As a workaround, try
                    <strong>Standard SVD</strong> with an imputation strategy.`;
            }
        } else if (err.isServerError) {
            body = `<strong>PCA Error:</strong> ${err.message}${strategyTips}`;
        } else {
            body = `<strong>PCA Error:</strong> ${err.message}`;
        }

        pcaResults.innerHTML = `
            <div class="alert alert-danger py-2 px-3 small shadow-sm text-left mb-2">
                ${body}
            </div>`;
    });
});

// --- 6. PCA Export & UI Logic ---

// ── Methods-section HTML generator ────────────────────────────────────────────
function _buildMethodsHTML() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    const nVars    = selectedVars.length;
    const nSamples = globalData ? globalData.length : '?';
    const factors  = selectedFactors || [];
    const minCov   = _getMinRowCoverage();
    const nzvThr   = nzvThreshold || 0;
    const pct      = v => (v * 100).toFixed(1);

    const _transformLabel = t => ({
        log10: 'log₁₀(<em>x</em>)',
        ln:    'ln(<em>x</em>)',
        sqrt:  '√<em>x</em>',
        zscore: 'Z-score standardisation (zero mean, unit variance)',
        minmax: 'min–max normalisation to [0, 1]'
    }[t] || t);

    const _missingText = (strategy, threshold) => ({
        hybrid:            `Variables with &gt;${threshold}% missing values were excluded; remaining gaps were filled by group mean (or column mean when group information was unavailable).`,
        drop_rows:         `Samples containing any missing value across the selected variables were excluded prior to analysis.`,
        impute_group_mean: `All missing values were replaced by the group mean (or column mean when no group assignment was available).`,
        exclude_vars:      `Variables with &gt;${threshold}% missing values were excluded; rows with any remaining missing values were then dropped.`,
        knn:               `Missing values were estimated by <em>k</em>-nearest-neighbour (KNN) imputation (<em>k</em>&nbsp;=&nbsp;5), using Euclidean distance in the variable space.`
    }[strategy] || `Missing values were handled using the "${strategy}" strategy.`);

    const _pcaAlgoName  = m => ({ svd: 'singular value decomposition (SVD)', nipals: 'NIPALS (Nonlinear Iterative Partial Least Squares)', em_pca: 'Expectation–Maximisation PCA (EM-PCA)' }[m] || m);
    const _corrName     = m => ({ pearson: 'Pearson', spearman: 'Spearman rank', kendall: 'Kendall rank' }[m] || m);
    const _plsName      = m => ({ 'pls-da': 'PLS-DA (Partial Least Squares Discriminant Analysis)', 'pls': 'PLS (Partial Least Squares regression)' }[m] || m);
    const _oplsName     = m => ({ 'opls-da': 'OPLS-DA (Orthogonal Projections to Latent Structures Discriminant Analysis)', 'opls': 'OPLS (Orthogonal Projections to Latent Structures)' }[m] || m);

    const sections = [];

    // ── 1. Data and variable selection ────────────────────────────────────────
    let s1 = `<p>The dataset comprised <strong>${nSamples}</strong> samples and <strong>${nVars}</strong> numeric variable${nVars !== 1 ? 's' : ''} selected for multivariate analysis`;
    if (factors.length) s1 += `, with <strong>${factors.join(', ')}</strong> used as grouping factor${factors.length > 1 ? 's' : ''}`;
    s1 += '.';
    if (minCov > 0) s1 += ` Samples with fewer than <strong>${minCov}%</strong> observed values across the selected variables were excluded prior to analysis.`;
    if (nzvThr > 0) s1 += ` Variables with a coefficient of variation (CV) below <strong>${nzvThr}%</strong> were removed by a near-zero variance filter.`;
    s1 += '</p>';
    sections.push({ heading: 'Data and variable selection', body: s1 });

    // ── 2. Transformation ─────────────────────────────────────────────────────
    if (usePerVarMode && perVarTransforms && Object.keys(perVarTransforms).length) {
        const groups = {};
        Object.entries(perVarTransforms).forEach(([v, t]) => {
            if (t && t !== 'none') { if (!groups[t]) groups[t] = []; groups[t].push(v); }
        });
        const lines = Object.entries(groups).map(([t, vars]) =>
            `${_transformLabel(t)} was applied to: <em>${vars.join(', ')}</em>.`);
        if (lines.length) sections.push({ heading: 'Data transformation', body: `<p>Variables were transformed individually prior to analysis. ${lines.join(' ')}</p>` });
    } else if (currentNormTransform && currentNormTransform !== 'none') {
        sections.push({ heading: 'Data transformation', body: `<p>All selected variables were subjected to ${_transformLabel(currentNormTransform)} transformation prior to analysis to reduce skewness and stabilise variance.</p>` });
    }

    // ── 3. Correlation analysis ───────────────────────────────────────────────
    if (lastCorrResults) {
        const corrMethod = _corrName(lastCorrResults.method || 'pearson');
        const nCorrVars  = lastCorrResults.variables ? lastCorrResults.variables.length : nVars;
        const nExcl      = excludedVarsFromCorr ? excludedVarsFromCorr.size : 0;
        const nRetained  = nCorrVars - nExcl;
        const cThr       = (corrThreshold || 0.80).toFixed(2);
        const pThr       = document.getElementById('corrPThresh')?.value || '0.05';

        let s3 = `<p>Pairwise ${corrMethod} correlations were computed among the <strong>${nCorrVars}</strong> selected variables`;
        if (lastCorrResults.n_samples) s3 += ` using <strong>${lastCorrResults.n_samples}</strong> sample${lastCorrResults.n_samples !== 1 ? 's' : ''}`;
        s3 += `. Variable pairs with |<em>r</em>|&nbsp;≥&nbsp;<strong>${cThr}</strong> and <em>p</em>&nbsp;≤&nbsp;<strong>${pThr}</strong> were considered redundant.`;
        if (nExcl > 0) {
            s3 += ` A total of <strong>${nExcl}</strong> variable${nExcl !== 1 ? 's were' : ' was'} excluded to reduce collinearity, retaining <strong>${nRetained}</strong> variable${nRetained !== 1 ? 's' : ''} for subsequent analysis.`;
        } else {
            s3 += ` No variables were excluded on the basis of collinearity.`;
        }
        s3 += '</p>';
        sections.push({ heading: 'Correlation analysis', body: s3 });
    }

    // ── 4. PCA ────────────────────────────────────────────────────────────────
    if (lastPCAResults) {
        const r          = lastPCAResults;
        const method     = r.method || document.getElementById('pcaMethod')?.value || 'svd';
        const strategy   = r.missing_strategy || document.getElementById('pcaMissingStrategy')?.value || 'hybrid';
        const missThr    = r.missing_threshold ?? parseFloat(document.getElementById('pcaMissingThreshold')?.value ?? 30);
        const nativeAlgo = method === 'nipals' || method === 'em_pca';
        const evr        = r.explained_variance_ratio || [];
        const nComp      = evr.length;
        const cumVar     = evr.reduce((a, b) => a + b, 0);
        const nPCAvars   = r.vars_used ? r.vars_used.length : nVars;
        const nPCAsamp   = r.n_samples || '?';
        const avgByFac   = document.getElementById('pcaAverageByFactor')?.checked;

        let s4 = `<p>Principal component analysis (PCA) was performed on <strong>${nPCAvars}</strong> variable${nPCAvars !== 1 ? 's' : ''} across <strong>${nPCAsamp}</strong> sample${nPCAsamp !== 1 ? 's' : ''} using the <strong>${_pcaAlgoName(method)}</strong> algorithm. `;
        if (nativeAlgo) {
            s4 += `The ${method === 'nipals' ? 'NIPALS' : 'EM-PCA'} algorithm handles missing values natively without prior imputation, making it suitable for datasets with structured or extensive missingness. `;
        } else {
            s4 += `Prior to PCA, missing values were addressed as follows: ${_missingText(strategy, missThr)} `;
        }
        if (avgByFac && factors.length) s4 += `Replicate samples sharing the same <em>${factors.join('/')}</em> group were averaged prior to PCA. `;
        if (nComp >= 1) {
            const varParts = evr.slice(0, 3).map((v, i) => `PC${i + 1}: <strong>${pct(v)}%</strong>`).join(', ');
            s4 += `The first <strong>${nComp}</strong> principal component${nComp !== 1 ? 's were' : ' was'} retained, collectively accounting for <strong>${pct(cumVar)}%</strong> of total variance (${varParts}).`;
        }
        s4 += '</p>';
        sections.push({ heading: 'Principal component analysis (PCA)', body: s4 });
    }

    // ── 5. PLS ────────────────────────────────────────────────────────────────
    if (lastPlsResult) {
        const r      = lastPlsResult;
        const method = _plsName(r.method || 'pls-da');
        const yCol   = r.y_col || '?';
        const nLV    = r.n_components || '?';
        const r2y    = r.r2y != null ? `<strong>${pct(r.r2y)}%</strong>` : '—';
        const q2     = r.q2  != null ? `<strong>${pct(r.q2)}%</strong>`  : '—';
        const r2x    = r.r2x != null ? `<strong>${pct(r.r2x)}%</strong>` : '—';
        sections.push({ heading: r.method === 'pls' ? 'Partial Least Squares (PLS)' : 'PLS Discriminant Analysis (PLS-DA)',
            body: `<p>${method} was applied with <strong>${yCol}</strong> as the response variable (Y) and <strong>${r.vars_used ? r.vars_used.length : nVars}</strong> predictor variable${nVars !== 1 ? 's' : ''} (X), using <strong>${nLV}</strong> latent variable${nLV !== 1 ? 's' : ''}. The model explained ${r2x} of X variance (R²X) and ${r2y} of Y variance (R²Y); cross-validated predictive ability was Q²&nbsp;=&nbsp;${q2}. Variable importance in projection (VIP) scores were computed to rank predictor variables by their contribution to the model.</p>` });
    }

    // ── 6. OPLS ───────────────────────────────────────────────────────────────
    if (lastOplsResult) {
        const r      = lastOplsResult;
        const method = _oplsName(r.method || 'opls-da');
        const yCol   = r.y_col || '?';
        const nOrtho = r.n_ortho || '?';
        const r2y    = r.r2y != null ? `<strong>${pct(r.r2y)}%</strong>` : '—';
        const q2     = r.q2  != null ? `<strong>${pct(r.q2)}%</strong>`  : '—';
        const r2x    = r.r2x != null ? `<strong>${pct(r.r2x)}%</strong>` : '—';
        sections.push({ heading: r.method === 'opls' ? 'Orthogonal PLS (OPLS)' : 'Orthogonal PLS-DA (OPLS-DA)',
            body: `<p>${method} was applied with <strong>${yCol}</strong> as the response variable (Y), using <strong>${r.vars_used ? r.vars_used.length : nVars}</strong> predictor variable${nVars !== 1 ? 's' : ''} and <strong>${nOrtho}</strong> orthogonal component${nOrtho !== 1 ? 's' : ''}. Orthogonal variation — systematic X variance unrelated to Y — was separated from the predictive component to improve model interpretability. The model explained ${r2x} of X variance (R²X) and ${r2y} of Y variance (R²Y); cross-validated Q²&nbsp;=&nbsp;${q2}. S-plot and VIP analyses were used to identify variables driving the separation.</p>` });
    }

    // ── 7. Software ───────────────────────────────────────────────────────────
    sections.push({ heading: 'Software', body: `<p>All statistical analyses were performed using CyanoTools, a web application for analysis of cyanobacterial and algal data (Python/Flask back-end, JavaScript front-end). Multivariate analyses (PCA, PLS, OPLS) were implemented using scikit-learn (Pedregosa <em>et al.</em>, 2011, <em>Journal of Machine Learning Research</em>, 12, 2825–2830). Visualisations were generated using Plotly.js. This methods section was auto-generated from the analysis settings active at the time of export and should be reviewed and adapted before submission.</p>` });

    // ── Render ────────────────────────────────────────────────────────────────
    const sectionHtml = sections.map(({ heading, body }) =>
        `<h2>${heading}</h2>${body}`).join('\n');

    const dateStr = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Methods Section — CyanoTools</title>
<style>
  body { font-family: "Times New Roman", Times, serif; font-size: 11pt; line-height: 1.7;
         max-width: 740px; margin: 48px auto; color: #111; }
  h1   { font-size: 1.25rem; margin-bottom: 0.15em; }
  h2   { font-size: 1.0rem; margin-top: 1.6em; margin-bottom: 0.3em;
         border-bottom: 1px solid #bbb; padding-bottom: 2px; }
  p    { margin: 0.4em 0 0.9em; text-align: justify; }
  .meta { color: #555; font-size: 0.82rem; font-family: Arial, sans-serif;
          border-bottom: 2px solid #333; padding-bottom: 0.5em; margin-bottom: 1.4em; }
  .note { background: #fffbe6; border-left: 4px solid #f0ad4e; padding: 7px 12px;
          font-size: 0.82rem; font-family: Arial, sans-serif; margin-top: 2.2em; line-height: 1.5; }
</style>
</head>
<body>
<h1>Statistical Methods</h1>
<div class="meta">Generated by CyanoTools &nbsp;·&nbsp; ${dateStr}</div>
${sectionHtml}
<div class="note"><strong>Note:</strong> This section was auto-generated from the active analysis settings at the time of export. Please verify all numerical values and method descriptions before submission, and adapt the wording to the conventions of your target journal.</div>
</body>
</html>`;
}

async function _exportPCAReport() {
    if (!lastPCAResults) return alert('Run PCA first before exporting.');

    const btn = document.getElementById('downloadPCAExcelBtn');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i> Building report…';

    try {
        const wb = XLSX.utils.book_new();
        const addSheet = (name, rows) => {
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
        };

        const varsUsed     = lastPCAResults.vars_used     || [];
        const varsExcluded = lastPCAResults.vars_excluded  || [];
        const allPcaVars   = [...varsUsed, ...varsExcluded];
        const factors      = selectedFactors || [];
        const nComp        = lastPCAResults.n_components || (lastPCAResults.explained_variance || []).length;
        const evArr        = lastPCAResults.explained_variance || [];
        const missingStrat = document.getElementById('pcaMissingStrategy').value;
        const missingThresh = document.getElementById('pcaMissingThreshold').value;
        const minRowCov    = document.getElementById('minRowCoverage')?.value || '0';
        const avgByFactor  = document.getElementById('pcaAverageByFactor').checked;

        // ── Helpers ───────────────────────────────────────────────────────────
        const _v = id => { const el = document.getElementById(id); return el ? el.value : ''; };
        const _c = id => { const el = document.getElementById(id); return el ? (el.checked ? 'Yes' : 'No') : ''; };

        // ── Sheet 1: Parameters ───────────────────────────────────────────────
        const params = [
            ['Section', 'Parameter', 'Value'],
            ['Data Input', 'Total rows in dataset', (globalData || []).length],
            ['Data Input', 'Factor columns', factors.join(', ') || '(none)'],
            ['Data Input', 'Label column', _v('pcaLabelCol') || '(none)'],
            ['Data Input', 'Variables sent to PCA', allPcaVars.length],
            ['', '', ''],
            ['Transformation', 'Normalization method', currentNormTransform === 'none' ? 'None' : currentNormTransform.toUpperCase()],
        ];
        const activeTransforms = Object.entries(appliedTransformations || {})
            .filter(([, cfg]) => cfg && cfg.type && cfg.type !== 'none')
            .map(([v, cfg]) => `${v}: ${cfg.type}`);
        params.push(['Transformation', 'Per-variable transforms', activeTransforms.length ? activeTransforms.join('; ') : '(none)']);
        params.push(['', '', '']);
        params.push(['Variable Selection', 'NZV threshold (CV%)', nzvThreshold || 0]);
        params.push(['Variable Selection', 'Variables selected', allPcaVars.join(', ')]);
        params.push(['', '', '']);
        params.push(['Correlation', 'Analysis run', lastCorrResults ? 'Yes' : 'No']);
        if (lastCorrResults) {
            params.push(['Correlation', 'Method', lastCorrResults.method || '']);
            params.push(['Correlation', 'r threshold', corrThreshold]);
            params.push(['Correlation', 'p threshold', _v('corrPThresh') || '0.05']);
            params.push(['Correlation', 'Variables excluded', excludedVarsFromCorr.size ? [...excludedVarsFromCorr].join(', ') : '(none)']);
            params.push(['Correlation', 'Variables sent to PCA', pcaVarsFromCorr.size ? [...pcaVarsFromCorr].join(', ') : '(none)']);
        }
        params.push(['', '', '']);
        params.push(['PCA Algorithm', 'Method', lastPCAResults.pca_method || _v('pcaMethod')]);
        params.push(['PCA Algorithm', 'Missing data strategy', missingStrat]);
        params.push(['PCA Algorithm', 'Variable exclusion threshold (%)', missingThresh]);
        params.push(['PCA Algorithm', 'Min. row coverage (%)', minRowCov]);
        params.push(['PCA Algorithm', 'Average replicates by factors', avgByFactor ? 'Yes' : 'No']);
        params.push(['PCA Algorithm', 'Components computed', nComp]);
        params.push(['PCA Algorithm', 'Samples analyzed', lastPCAResults.n_samples]);
        params.push(['PCA Algorithm', 'Total input rows', lastPCAResults.n_input_rows || (globalData || []).length]);
        params.push(['PCA Algorithm', 'Variables used', varsUsed.join(', ')]);
        params.push(['PCA Algorithm', 'Variables excluded', varsExcluded.length ? varsExcluded.join(', ') : '(none)']);
        params.push(['PCA Algorithm', 'Imputed cells', lastPCAResults.n_imputed_cells || 0]);
        params.push(['PCA Algorithm', 'Rows dropped (missing)', lastPCAResults.rows_dropped || 0]);
        params.push(['PCA Algorithm', 'Rows excluded (coverage)', lastPCAResults.rows_sparse_dropped || 0]);
        params.push(['', '', '']);
        params.push(['Plot Style', 'X axis', 'PC' + _v('pcaXComp')]);
        params.push(['Plot Style', 'Y axis', 'PC' + _v('pcaYComp')]);
        params.push(['Plot Style', 'Marker symbol', _v('pcaSymbol')]);
        params.push(['Plot Style', 'Vary symbol by group', _c('pcaVarySymbol')]);
        params.push(['Plot Style', 'Point size', _v('pcaPointSize')]);
        params.push(['Plot Style', 'Opacity (%)', _v('pcaOpacity')]);
        params.push(['Plot Style', 'Color palette', document.querySelector('.pca-palette-btn.active')?.dataset.palette || '']);
        params.push(['Plot Style', 'Confidence ellipses', _c('pcaShowEllipse')]);
        params.push(['Plot Style', 'Ellipse std multiplier', document.querySelector('.pca-std-btn.active')?.dataset.val || '']);
        params.push(['Plot Style', 'Ellipse fill opacity (%)', _v('pcaEllipseOpacity')]);
        params.push(['Plot Style', 'Show sample labels', _c('pcaShowLabels')]);
        params.push(['Plot Style', 'Show loadings', _c('pcaShowLoadings')]);
        params.push(['Plot Style', 'Grid lines', _c('pcaShowGrid')]);
        params.push(['Plot Style', 'Plot border', _c('pcaShowBorder')]);
        params.push(['Plot Style', 'Center axes at zero', _c('pcaCenterAxes')]);
        params.push(['Plot Style', 'Font family', _v('pcaFontFamily')]);
        addSheet('Parameters', params);

        // ── Sheet 2: Input Data ───────────────────────────────────────────────
        if (globalData && globalData.length > 0) {
            const inputCols = [...factors, ...allPcaVars];
            addSheet('Input Data', [inputCols, ...globalData.map(row => inputCols.map(c => row[c] ?? ''))]);
        }

        // ── Sheet 3: Sample Summary ───────────────────────────────────────────
        if (globalData && globalData.length > 0) {
            const coverageThresh = parseFloat(minRowCov) / 100;
            const sRows = [['Row', ...factors, 'Missing count', 'Missing %', 'Coverage %', 'PCA Status']];
            globalData.forEach((row, i) => {
                const tot = allPcaVars.length;
                const miss = allPcaVars.filter(v => { const val = row[v]; return val === undefined || val === null || val === '' || val === 'N/A'; }).length;
                const missPct  = tot > 0 ? parseFloat(((miss / tot) * 100).toFixed(1)) : 0;
                const covPct   = tot > 0 ? parseFloat((((tot - miss) / tot) * 100).toFixed(1)) : 0;
                let status = 'Used in PCA';
                if (coverageThresh > 0 && covPct / 100 < coverageThresh) status = 'Excluded (coverage)';
                else if (missingStrat === 'drop_rows' && miss > 0)        status = 'Excluded (missing values)';
                sRows.push([i + 1, ...factors.map(f => row[f] ?? ''), miss, missPct, covPct, status]);
            });
            addSheet('Sample Summary', sRows);
        }

        // ── Sheet 4: Variable Summary ─────────────────────────────────────────
        if (globalData && globalData.length > 0) {
            const vRows = [['Variable', 'Used in PCA', 'Exclusion Reason', 'Missing count', 'Missing %', 'Mean', 'SD', 'Transform', 'From Correlation tab', 'Excluded by Correlation']];
            allPcaVars.forEach(v => {
                const vals = globalData
                    .map(row => { const val = row[v]; return (val !== undefined && val !== null && val !== '' && val !== 'N/A') ? parseFloat(val) : NaN; })
                    .filter(x => !isNaN(x));
                const totalN   = globalData.length;
                const missN    = totalN - vals.length;
                const missPct  = parseFloat(((missN / totalN) * 100).toFixed(1));
                const mean     = vals.length > 0 ? parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4)) : '';
                const sd       = vals.length > 1 ? parseFloat(Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / (vals.length - 1)).toFixed(4)) : '';
                const isExcl   = varsExcluded.includes(v);
                const transform = (appliedTransformations?.[v]?.type && appliedTransformations[v].type !== 'none')
                    ? appliedTransformations[v].type
                    : (currentNormTransform !== 'none' ? currentNormTransform : 'None');
                vRows.push([
                    v,
                    isExcl ? 'No' : 'Yes',
                    isExcl ? `Too many missing values (>${missingThresh}%)` : '',
                    missN, missPct, mean, sd,
                    transform,
                    pcaVarsFromCorr.has(v)      ? 'Yes' : 'No',
                    excludedVarsFromCorr.has(v) ? 'Yes' : 'No',
                ]);
            });
            addSheet('Variable Summary', vRows);
        }

        // ── Sheet 5: Correlation Matrix (lower triangle) ──────────────────────
        if (lastCorrResults?.corr_matrix && lastCorrResults.variables) {
            const cvars = lastCorrResults.variables;
            const n = cvars.length;
            const cRows = [['', ...cvars]];
            for (let i = 0; i < n; i++) {
                const row = [cvars[i]];
                for (let j = 0; j < n; j++) {
                    if (j < i)      row.push(parseFloat(lastCorrResults.corr_matrix[i][j].toFixed(4)));
                    else if (j === i) row.push(1);
                    else              row.push('');
                }
                cRows.push(row);
            }
            addSheet('Correlation Matrix', cRows);

            // ── Sheet 6: Correlated Pairs ─────────────────────────────────────
            const pThresh = parseFloat(_v('corrPThresh') || '0.05');
            const pairRows = [['Variable A', 'Variable B', 'r', 'p-value', 'Significant', 'Action']];
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < i; j++) {
                    const r   = lastCorrResults.corr_matrix[i][j];
                    const p   = lastCorrResults.pval_matrix?.[i]?.[j];
                    const sig = Math.abs(r) >= corrThreshold && (p === undefined || p <= pThresh);
                    if (sig) {
                        const vA = cvars[i], vB = cvars[j];
                        let action = 'Kept both';
                        if (excludedVarsFromCorr.has(vA))      action = `${vA} excluded`;
                        else if (excludedVarsFromCorr.has(vB)) action = `${vB} excluded`;
                        pairRows.push([vA, vB,
                            parseFloat(r.toFixed(4)),
                            p !== undefined ? parseFloat(p.toFixed(4)) : '',
                            'Yes', action]);
                    }
                }
            }
            if (pairRows.length > 1) addSheet('Correlated Pairs', pairRows);
        }

        // ── Sheet 7: Final PCA Matrix (post-imputation) ───────────────────────
        if (lastPCAResults.pca_table?.length > 0) {
            const finalCols = [...factors, ...varsUsed];
            addSheet('Final PCA Matrix', [
                finalCols,
                ...lastPCAResults.pca_table.map(row => finalCols.map(c => row[c] ?? ''))
            ]);
        }

        // ── Sheet 8: PCA Variance Explained ───────────────────────────────────
        const nVarsForEig = varsUsed.length;
        const vExpRows = [['PC', 'Eigenvalue (approx.)', '% Variance', 'Cumulative %', 'Kaiser criterion (>1)']];
        let cumPct = 0;
        evArr.forEach((ev, i) => {
            const pct   = parseFloat((ev * 100).toFixed(2));
            cumPct += pct;
            const eig   = parseFloat((ev * nVarsForEig).toFixed(4));
            vExpRows.push([`PC${i + 1}`, eig, pct, parseFloat(cumPct.toFixed(2)), eig >= 1 ? 'Yes' : 'No']);
        });
        addSheet('PCA Variance', vExpRows);

        // ── Sheet 9: PCA Scores ───────────────────────────────────────────────
        if (lastPCAResults.scores?.length > 0) {
            const pcCols = evArr.map((_, i) => `PC${i + 1}`);
            addSheet('PCA Scores', [
                ['Sample', 'Group', ...pcCols],
                ...lastPCAResults.scores.map((s, i) => [
                    s.label || (i + 1),
                    s.group || 'All samples',
                    ...pcCols.map(pc => s[pc] !== undefined ? parseFloat((+s[pc]).toFixed(6)) : '')
                ])
            ]);
        }

        // ── Sheet 10: PCA Loadings ────────────────────────────────────────────
        if (lastPCAResults.loadings?.length > 0) {
            const pcLoadCols = evArr.map((_, i) => `PC${i + 1}`);
            addSheet('PCA Loadings', [
                ['Variable', ...pcLoadCols, 'Magnitude'],
                ...lastPCAResults.loadings.map(l => {
                    const vals = pcLoadCols.map(pc => l[`${pc}_Loading`] !== undefined ? parseFloat((+l[`${pc}_Loading`]).toFixed(6)) : 0);
                    const mag  = parseFloat(Math.sqrt(vals.reduce((s, v) => s + v * v, 0)).toFixed(6));
                    return [l.Variable, ...vals, mag];
                })
            ]);
        }

        // ── Capture PCA plot as PNG ───────────────────────────────────────────
        let plotPngBase64 = null;
        try {
            const dataUrl = await Plotly.toImage(document.getElementById('pcaPlot'),
                { format: 'png', width: 1200, height: 900, scale: 2 });
            plotPngBase64 = dataUrl.replace('data:image/png;base64,', '');
        } catch(e) { console.warn('Could not capture PCA plot:', e); }

        // ── Build ZIP ─────────────────────────────────────────────────────────
        const zip = new JSZip();
        zip.file('PCA_Full_Report.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
        if (plotPngBase64) zip.file('PCA_plot.png', plotPngBase64, { base64: true });
        zip.file('Methods_section.html', _buildMethodsHTML());

        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url; a.download = 'PCA_Full_Report.zip';
        document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); document.body.removeChild(a);

    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
    }
}

document.getElementById('downloadPCAExcelBtn').addEventListener('click', function() {
    _exportPCAReport().catch(err => alert('Export error: ' + err.message));
});

// Download PCA plot for publication (PNG with DPI metadata, or SVG)
document.getElementById('downloadPCAPlotBtn').addEventListener('click', async function() {
    if (!lastPCAResults) return;
    const plotDiv = document.getElementById('pcaPlot');
    const fmt     = document.getElementById('pcaExportFormat').value;
    const dpi     = parseInt(document.getElementById('pcaExportDPI').value) || 300;
    const w       = plotDiv.clientWidth  || 800;
    const h       = plotDiv.clientHeight || 600;
    const scale   = Math.max(dpi / 96, 1);

    const baseName = (document.getElementById('pcaPlotFilename').value.trim() || 'PCA_plot')
        .replace(/\.[^.]+$/, '');   // strip any extension the user may have typed

    try {
        const dataUrl = await Plotly.toImage(plotDiv, { format: fmt, width: w, height: h, scale });
        const a = document.createElement('a');
        if (fmt === 'svg') {
            let svgText;
            if (dataUrl.startsWith('data:image/svg+xml;base64,')) {
                svgText = atob(dataUrl.replace('data:image/svg+xml;base64,', ''));
            } else {
                svgText = decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml,/, ''));
            }
            a.href = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
            a.download = baseName + '.svg';
        } else {
            let b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            b64 = injectPngDpi(b64, dpi);
            a.href = 'data:image/png;base64,' + b64;
            a.download = baseName + '.png';
        }
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
    } catch(e) { alert('Export error: ' + e.message); }
});

// Test assumptions
document.getElementById('runTestsBtn').addEventListener('click', function() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);

    if (selectedVars.length === 0) {
        return alert("Please select at least one variable in the 'Data Input' panel.");
    }

    const testResults = document.getElementById('testResults');
    const testSpinner = document.getElementById('testSpinner');
    const resultsArea = document.getElementById('assumptionsResultsArea');
    const stopBtn = document.getElementById('stopTestsBtn');

    testResults.innerHTML = "";
    testSpinner.style.display = 'block';
    if (stopBtn) stopBtn.style.display = 'inline-block';

    // Cancel any in-progress request
    if (testsAbortController) testsAbortController.abort();
    testsAbortController = new AbortController();

    // ── Also clear ANOVA results (assumptions changed → old ANOVA is stale) ──
    const anovaResults = document.getElementById('anovaResults');
    if (anovaResults) anovaResults.innerHTML = '';
    const exportBtn = document.getElementById('exportFullReportBtn');
    if (exportBtn) exportBtn.style.display = 'none';
    const pubPlotsBtn2 = document.getElementById('exportPubPlotsBtn');
    if (pubPlotsBtn2) pubPlotsBtn2.style.display = 'none';
    const pubCard2 = document.getElementById('pubPlotStyleCard');
    if (pubCard2) pubCard2.style.display = 'none';
    lastAnovaResults = null;
    lastAnovaRawData = null;
    anovaVarSortModes = {};
    // ─────────────────────────────────────────────────────────────────────────

    // Hide the transformation panel while calculations run
    const transformPanel = document.getElementById('transformationPanel');
    if (transformPanel && transformPanel.style.display !== 'none') transformPanel.setAttribute('data-was-visible', '1');
    if (transformPanel) transformPanel.style.display = 'none';
    if (resultsArea) resultsArea.style.display = 'none';

    const hasTransforms = Object.values(appliedTransformations).some(t => t && t.type && t.type !== 'none');

    // Build all scope definitions (all data + each factor level) but only FETCH "all" now;
    // individual factor-level scopes are fetched on demand when the user clicks their tab.
    const scopes = buildAssumptionScopes();
    lastAssumptionScopes = scopes;
    allScopeResults = {}; // clear any stale cached scope results

    const signal = testsAbortController ? testsAbortController.signal : undefined;
    const allScope = scopes.find(s => s.key === 'all') || scopes[0];

    const fetchT = fetch('/run-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: buildTransformedData(allScope.rawData, appliedTransformations), target_columns: selectedVars, factors: selectedFactors }),
        signal
    }).then(r => r.json());

    const fetchO = hasTransforms
        ? fetch('/run-tests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: allScope.rawData, target_columns: selectedVars, factors: selectedFactors }),
            signal
          }).then(r => r.json())
        : Promise.resolve(null);

    Promise.all([fetchT, fetchO]).then(([transformedResult, originalResult]) => {
        testSpinner.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'none';
        if (resultsArea) resultsArea.style.display = 'block';
        if (transformPanel) transformPanel.style.display = 'block';

        if (transformedResult.error) throw new Error(transformedResult.error);
        if (originalResult && originalResult.error) throw new Error(originalResult.error);

        // Cache only the "all" scope; others will be fetched on demand
        allScopeResults['all'] = { data: transformedResult, originalData: originalResult || null };

        // Primary results → feed transformation panel
        lastTestResults         = allScopeResults['all'].data;
        lastOriginalTestResults = allScopeResults['all'].originalData || null;
        populateTransformationPanel(lastTestResults.results, selectedVars);

        // Render scope tabs + initial content (always start on "All data")
        activeScopeKey = 'all';
        renderAssumptionScopeTabs(scopes, 'all');
        renderAssumptionScopeContent('all');

        // Unlock the ANOVA Tests tab now that normality results are available
        _unlockSubTab('anova-tab');

        // Switch to Compare category and activate ANOVA Tests tab
        _switchCategory('compare');
        setTimeout(() => {
            const anovaTab = document.getElementById('anova-tab');
            if (anovaTab) anovaTab.click();
        }, 50);
    })
    .catch(err => {
        testSpinner.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'none';
        if (err.name === 'AbortError') return;
        alert("Testing Error: " + err.message);
    });
});


// ══════════════════════════════════════════════════════════════════════════════
// ANOVA RUN HANDLER
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('runAnovaBtn').addEventListener('click', function() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);
    const anovaSpinner = document.getElementById('anovaSpinner');
    const anovaResults = document.getElementById('anovaResults');
    const exportBtn = document.getElementById('exportFullReportBtn');
    const stopBtn = document.getElementById('stopAnovaBtn');

    // Ensure override dropdown is in sync with current factor count
    syncOverrideSelect();

    anovaResults.innerHTML = "";
    anovaSpinner.style.display = 'block';
    if (stopBtn) stopBtn.style.display = 'inline-block';
    if (exportBtn) exportBtn.style.display = 'none';
    const pubPlotsBtn3 = document.getElementById('exportPubPlotsBtn');
    if (pubPlotsBtn3) pubPlotsBtn3.style.display = 'none';
    const pubCard3 = document.getElementById('pubPlotStyleCard');
    if (pubCard3) pubCard3.style.display = 'none';
    lastAnovaRawData = null;
    anovaVarSortModes = {};

    // Cancel any in-progress request
    if (anovaAbortController) anovaAbortController.abort();
    anovaAbortController = new AbortController();

    // Use transformed data if transformations are active
    const dataToSend = buildTransformedData(globalData, appliedTransformations);

    const overrideVal = (document.getElementById('anovaOverrideSelect') || {}).value || 'auto';

    fetch('/run-anova', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: dataToSend,
            target_columns: selectedVars,
            factors: selectedFactors,
            grouping_mode: (document.getElementById('groupingMode') || {}).value || 'all_combined',
            manual_override: overrideVal
        }),
        signal: anovaAbortController ? anovaAbortController.signal : undefined
    })
    .then(res => res.json())
    .then(data => {
        anovaSpinner.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'none';

        if (data.error) {
            console.error("Backend ANOVA error:", data.error);
            anovaResults.innerHTML = `
                <div class="alert alert-danger p-3">
                    <strong>Server Error:</strong><br>
                    ${data.error}<br><br>
                    <small>Tip: Check that statsmodels, scipy, and openpyxl are installed</small>
                </div>`;
            return;
        }

        // Save results
        lastAnovaResults = data;
        lastAnovaRawData = data;

        // Show export buttons and pub plot style card
        if (exportBtn) exportBtn.style.display = 'inline-flex';
        const pubPlotsBtn4 = document.getElementById('exportPubPlotsBtn');
        if (pubPlotsBtn4) pubPlotsBtn4.style.display = 'inline-flex';
        const pubCard4 = document.getElementById('pubPlotStyleCard');
        if (pubCard4) pubCard4.style.display = '';

        if (!data.results || data.results.length === 0) {
            anovaResults.innerHTML = `
                <div class="alert alert-warning">
                    No valid groups with ≥3 replicates for statistical testing.
                </div>`;
            return;
        }

        renderAnovaResults(data);
    })
    .catch(err => {
        anovaSpinner.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'none';
        if (err.name === 'AbortError') return; // user cancelled
        console.error(err);
        document.getElementById('anovaResults').innerHTML = `<div class="alert alert-danger">Request failed: ${err.message}</div>`;
    });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLICATION PLOT HELPERS
// ══════════════════════════════════════════════════════════════════════════════

// ── PNG DPI injection helpers ─────────────────────────────────────────────────
const _CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
    }
    return t;
})();
function _crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = _CRC32_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
/**
 * Inject a pHYs chunk into a base64-encoded PNG so that image viewers
 * interpret the correct DPI (pixels per inch) instead of defaulting to 96.
 */
function injectPngDpi(b64, dpi) {
    const raw = atob(b64);
    const src = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) src[i] = raw.charCodeAt(i);

    const ppm = Math.round(dpi / 0.0254); // convert DPI → pixels per metre
    const typeBytes = new Uint8Array([112, 72, 89, 115]); // 'pHYs'
    const pdata = new Uint8Array(9);
    const dv = new DataView(pdata.buffer);
    dv.setUint32(0, ppm, false); // X density
    dv.setUint32(4, ppm, false); // Y density
    pdata[8] = 1;                // unit = metre

    const crcBuf = new Uint8Array(13);
    crcBuf.set(typeBytes, 0); crcBuf.set(pdata, 4);
    const crc = _crc32(crcBuf);

    // Assemble 21-byte chunk: 4 len + 4 type + 9 data + 4 CRC
    const chunk = new Uint8Array(21);
    chunk[3] = 9; // length field (big-endian; top 3 bytes are 0)
    chunk.set(typeBytes, 4);
    chunk.set(pdata, 8);
    chunk[17] = (crc >>> 24) & 0xFF; chunk[18] = (crc >>> 16) & 0xFF;
    chunk[19] = (crc >>>  8) & 0xFF; chunk[20] =  crc         & 0xFF;

    // Insert after IHDR chunk (always at byte offset 33 in a valid PNG)
    const out = new Uint8Array(src.length + 21);
    out.set(src.slice(0, 33));
    out.set(chunk, 33);
    out.set(src.slice(33), 54);

    let s = '';
    for (let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
    return btoa(s);
}
// ─────────────────────────────────────────────────────────────────────────────

/** Convert #rrggbb hex colour + 0-1 alpha → rgba() string */
function hexToRgba(hex, alpha) {
    const h = hex.replace('#','');
    const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
    return `rgba(${r},${g},${b},${alpha.toFixed(2)})`;
}

/** Return N fill colours from the current palette */
function getPubColors(n, scheme, opacityPct) {
    const pal = PUB_PALETTES[scheme] || PUB_PALETTES.okabe;
    const a = (opacityPct ?? 85) / 100;
    return Array.from({length: n}, (_, i) => hexToRgba(pal[i % pal.length], a));
}
/** Return N solid (opaque) colours from the current palette */
function getPubSolidColors(n, scheme) {
    const pal = PUB_PALETTES[scheme] || PUB_PALETTES.okabe;
    return Array.from({length: n}, (_, i) => pal[i % pal.length]);
}

/**
 * Try to match each letter_group.group name to rows in globalData and return
 * { groupName: [values...] } or null if matching fails.
 */
function extractRawGroupValues(variable, letterGroups) {
    if (!globalData || !globalData.length || !selectedFactors || !selectedFactors.length) return null;
    const groupNames = new Set(letterGroups.map(g => g.group));
    const result = {};
    letterGroups.forEach(g => { result[g.group] = []; });

    // Single factor: use factor value directly (no join needed)
    if (selectedFactors.length === 1) {
        globalData.forEach(row => {
            const key = String(row[selectedFactors[0]] ?? '');
            if (Object.prototype.hasOwnProperty.call(result, key)) {
                const v = parseFloat(row[variable]);
                if (!isNaN(v)) result[key].push(v);
            }
        });
        // Always return result (even if empty); callers use || [mean] as fallback
        return result;
    }

    // Multiple factors: scan all data rows to find which separator the backend used
    // (two-way/MANOVA/ART/SRH use ' / '; one-factor sliced use ' | '; try all)
    // First row may not belong to any ANOVA group (excluded for insufficient replicates),
    // so we must try all rows before giving up.
    const separators = [' / ', ' | ', ' - ', ' _ ', '_', '|', '-'];
    let sep = null;
    outer: for (const s of separators) {
        for (const row of globalData) {
            const computed = selectedFactors.map(f => String(row[f] ?? '')).join(s);
            if (groupNames.has(computed)) { sep = s; break outer; }
        }
    }
    // If separator not found, return empty-arrays object; callers use || [mean] as fallback
    if (sep === null) return result;

    globalData.forEach(row => {
        const key = selectedFactors.map(f => String(row[f] ?? '')).join(sep);
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            const v = parseFloat(row[variable]);
            if (!isNaN(v)) result[key].push(v);
        }
    });
    return result;
}

/** Y ceiling for letter placement — max of (raw values ∪ mean+SD) */
function calcYCeiling(letterGroups, rawGroups) {
    let top = -Infinity;
    letterGroups.forEach(g => {
        const bar = g.mean + (g.std || 0);
        if (bar > top) top = bar;
        if (rawGroups) {
            (rawGroups[g.group] || []).forEach(v => { if (v > top) top = v; });
        }
    });
    return isFinite(top) ? top : 0;
}

/** Compute data min (for Y range and letter offset base) */
function calcYFloor(letterGroups, rawGroups, yStartZero) {
    if (yStartZero) return 0;
    let floor = Infinity;
    letterGroups.forEach(g => {
        const v = g.mean - (g.std || 0);
        if (v < floor) floor = v;
        if (rawGroups) (rawGroups[g.group] || []).forEach(x => { if (x < floor) floor = x; });
    });
    return isFinite(floor) ? floor : 0;
}

/** Return the top Y value for one group (top of error bar, or max raw value) */
function groupTopY(g, rawGroups) {
    let top = g.mean + (g.std || 0);
    if (rawGroups && rawGroups[g.group] && rawGroups[g.group].length) {
        top = Math.max(top, Math.max(...rawGroups[g.group]));
    }
    return top;
}

/** Return the bottom Y value for one group (bottom of error bar, or min raw value) */
function groupBottomY(g, rawGroups) {
    let bot = g.mean - (g.std || 0);
    if (rawGroups && rawGroups[g.group] && rawGroups[g.group].length) {
        bot = Math.min(bot, Math.min(...rawGroups[g.group]));
    }
    return bot;
}

/** Compute explicit Y axis range respecting yStartZero + yHeadroom + letter space */
function computeYRange(letterGroups, rawGroups, s) {
    const ceil  = calcYCeiling(letterGroups, rawGroups);
    // Never force yStartZero when any mean is negative — doing so sets floor=0,
    // making hasNegative=false and minVal=0, which clips negative bars at y=0 and
    // shows only the positive part of their error bars (appearing as positive values).
    const anyNegMean = letterGroups.some(g => g.mean < 0);
    const floor = calcYFloor(letterGroups, rawGroups, s.yStartZero && !anyNegMean);
    const span  = Math.abs(ceil - floor) || Math.abs(ceil) || 1;

    // allNeg: all bar tops (incl. error bars) are at/below zero.
    // When true, the user-controlled headroom applies BELOW the minimum instead of above the maximum.
    const allNeg = ceil <= 0;
    let topFrac = allNeg ? 0.05 : Math.max(s.yHeadroom / 100, 0.02);
    let botFrac = allNeg ? Math.max(s.yHeadroom / 100, 0.02) : 0.05;

    if (s.showLetters) {
        if (allNeg) {
            // Letters placed below bars; compute required space below floor.
            if (!s.letterPerBar) {
                // Per-bar: letters sit within the fixed headroom — no axis expansion needed.
                // Non-per-bar: all letters at the same depth, may need to push the floor down.
                const letterFrac = (s.letterOffset / 100) * 1.4;
                if (letterFrac > botFrac) botFrac = letterFrac;
            }
        } else {
            // Letters placed above bars; compute required space above ceil.
            if (!s.letterPerBar) {
                // Per-bar: letters sit within the fixed headroom — no axis expansion needed.
                // Non-per-bar: all letters at the same height, may need to push the ceiling up.
                const letterFrac = (s.letterOffset / 100) * 1.4;
                if (letterFrac > topFrac) topFrac = letterFrac;
            }
        }
    }

    const hasNegative = floor < 0;

    // Floor: always explicit when data has negative values (null is treated as 0 by Plotly)
    let minVal;
    if (s.yStartZero && !anyNegMean) {
        minVal = 0;
    } else if (hasNegative) {
        minVal = floor - span * botFrac;
    } else {
        minVal = null;                  // positive-only: let Plotly autorange the bottom
    }

    // Ceiling: when data has negative values the zero baseline must stay in view —
    // bars in Plotly start at base=0, so if 0 is above the chart range the bars
    // appear clipped to the top edge.  Guarantee at least 10 % of span above zero.
    const rawMax = ceil + span * topFrac;
    const maxVal = hasNegative ? Math.max(rawMax, span * 0.1) : rawMax;

    return { min: minVal, max: maxVal };
}

/** Build Plotly letter annotations positioned above bars/points (or below for all-negative data) */
function buildPubLetterAnnotations(letterGroups, rawGroups, s) {
    if (!s.showLetters) return [];
    const ceil  = calcYCeiling(letterGroups, rawGroups);
    const anyNegMean = letterGroups.some(g => g.mean < 0);
    const floor = calcYFloor(letterGroups, rawGroups, s.yStartZero && !anyNegMean);
    const span  = Math.abs(ceil - floor) || Math.abs(ceil) || 1;

    // When all bar tops are at/below zero, place letters below the bars instead of above.
    const allNeg = ceil <= 0;

    const makeAnnotation = (group, y, letter, anchor) => ({
        x: group, y,
        text: s.letterBold ? `<b>${letter}</b>` : letter,
        showarrow: false,
        font: { size: s.annotationSize, color: '#111', family: s.fontFamily },
        yanchor: anchor,
    });

    if (s.letterPerBar) {
        if (allNeg) {
            // Each letter below its own bar/whisker/point cloud.
            // Offset is a fraction of the available headroom below the shortest bar.
            const globalBottom = Math.min(...letterGroups.map(g => groupBottomY(g, rawGroups)));
            const yMin = floor - span * Math.max(s.yHeadroom / 100, 0.05);
            const headroom = Math.max(globalBottom - yMin, span * 0.001);
            const offset = headroom * (s.letterOffset / 100) + 0.001;
            return letterGroups.map(g =>
                makeAnnotation(g.group, groupBottomY(g, rawGroups) - offset, g.letter, 'top')
            );
        } else {
            // Each letter above its own bar/whisker/point cloud.
            // Offset is a fraction of the available headroom above the tallest bar.
            const globalTop = Math.max(...letterGroups.map(g => groupTopY(g, rawGroups)));
            const yMax = ceil + span * Math.max(s.yHeadroom / 100, 0.05);
            const headroom = Math.max(yMax - globalTop, span * 0.001);
            const offset = headroom * (s.letterOffset / 100) + 0.001;
            return letterGroups.map(g =>
                makeAnnotation(g.group, groupTopY(g, rawGroups) + offset, g.letter, 'bottom')
            );
        }
    } else {
        if (allNeg) {
            // All letters at the same depth (below the lowest bar).
            const offset = span * (s.letterOffset / 100) + 0.001;
            return letterGroups.map(g =>
                makeAnnotation(g.group, floor - offset, g.letter, 'top')
            );
        } else {
            // All letters at the same height (above the tallest bar).
            const offset = span * (s.letterOffset / 100) + 0.001;
            return letterGroups.map(g =>
                makeAnnotation(g.group, ceil + offset, g.letter, 'bottom')
            );
        }
    }
}

/** Build the common Plotly layout object from pubPlotSettings.
 *  yRange: { min: number|null, max: number|null } — pass result of computeYRange() */
function buildPubLayout(res, groups, extraAnnotations, s, yRange) {
    const gridDash = s.gridStyle === 'dash' ? 'dash' : s.gridStyle === 'dot' ? 'dot' : 'solid';
    const showTick = (s.tickPosition !== '' && s.tickPosition != null);
    const tickDir  = showTick ? (s.tickPosition === 'both' ? 'outside' : s.tickPosition) : '';
    const mirror   = s.showPlotFrame ? true : false;  // 'true' = line only, no mirrored ticks

    const legendCfg = s.showLegend ? {
        font: { size: s.legendSize, family: s.fontFamily },
        orientation: s.legendOrientation,
        x: s.legendPosition === 'top-left' ? 0.01 : s.legendPosition === 'bottom' ? 0.5 : 0.99,
        y: s.legendPosition === 'bottom' ? -0.18 : 0.99,
        xanchor: s.legendPosition === 'top-left' ? 'left' : s.legendPosition === 'bottom' ? 'center' : 'right',
        yanchor: s.legendPosition === 'bottom' ? 'top' : 'top',
        bgcolor: 'rgba(255,255,255,0.88)', bordercolor: '#ccc', borderwidth: 1,
    } : {};

    const overallP = res.overall_p !== null ? res.overall_p.toFixed(4) : '—';
    const testInfo = `${res.test_used || ''} | p = ${overallP}` +
        (res.effect_size != null ? ` | ${res.effect_size_label || 'η²'} = ${res.effect_size.toFixed(3)}` : '');
    const infoAnnotation = s.showTestInfo ? [{
        x: 0, y: 1.04, xref: 'paper', yref: 'paper', text: testInfo,
        showarrow: false, font: { size: 9, color: '#555', family: s.fontFamily }, xanchor: 'left',
    }] : [];

    const axisBase = {
        tickfont: { size: s.tickLabelSize, family: s.fontFamily },
        showgrid: false,
        ticks: showTick ? tickDir : '',
        ticklen: s.tickLen,
        showline: s.showAxisLine || s.showPlotFrame,
        linecolor: '#333', linewidth: 1, mirror,
        gridcolor: s.gridColor, griddash: gridDash,
    };

    // Y range: explicit when yStartZero or yHeadroom specified
    const yAxisRange = (yRange && yRange.max != null)
        ? [yRange.min ?? null, yRange.max]
        : undefined;

    // Paper border: thin rect shape drawn around the full figure area
    const paperBorderShapes = s.showPaperBorder ? [{
        type: 'rect', xref: 'paper', yref: 'paper',
        x0: 0, y0: 0, x1: 1, y1: 1,
        line: { color: '#333333', width: 1.5 }, fillcolor: 'rgba(0,0,0,0)', layer: 'above',
    }] : [];

    return {
        font: { family: s.fontFamily },
        xaxis: {
            ...axisBase,
            tickangle: groups.length > 6 ? -35 : 0,
            automargin: true,
            showgrid: s.showGridX,
        },
        yaxis: {
            ...axisBase,
            title: { text: res.variable || '', font: { size: s.axisTitleSize, family: s.fontFamily } },
            zeroline: true, zerolinewidth: 1, zerolinecolor: '#aaa',
            showgrid: s.showGridY,
            ...(yAxisRange ? { range: yAxisRange } : {}),
        },
        shapes: paperBorderShapes,
        margin: { t: 34, b: 80, l: 65, r: 20 },
        bargap: 0.3,
        showlegend: s.showLegend,
        legend: legendCfg,
        annotations: [...(extraAnnotations || []), ...infoAnnotation],
        autosize: true,
        plot_bgcolor: s.bgColor,
        paper_bgcolor: s.bgColor,
    };
}

/** Apply the current aspectRatio and sizePreset to all ANOVA chart container dimensions. */
function applyAspectRatioToCharts() {
    const ratio = pubPlotSettings.aspectRatio || 1.5;
    // On-screen: always use full container width so charts don't shrink when export
    // size preset changes. The preset only affects the exported image dimensions.
    const wrapper = document.querySelector('#anovaResults .anova-results-wrapper');
    const refW = wrapper ? wrapper.clientWidth : (document.getElementById('anovaResults') || {clientWidth: 700}).clientWidth;
    const chartW = Math.max(refW || 600, 200);
    const newH = Math.max(Math.round(chartW / ratio), 120);
    document.querySelectorAll('#anovaResults .anova-bar-chart-placeholder').forEach(div => {
        div.style.width = '100%';
        div.style.height = newH + 'px';
    });
}

/** Re-render EVERY ANOVA chart across ALL variable tabs with current pubPlotSettings.
 *  Uses the same temp-show trick as the export handler to handle hidden panes. */
function reRenderAllAnovaCharts() {
    // Apply aspect ratio to chart containers first (before Plotly measures them)
    applyAspectRatioToCharts();

    // Clear rendered markers and purge all Plotly instances
    document.querySelectorAll('#anovaResults .anova-bar-chart-placeholder').forEach(div => {
        div.classList.remove('anova-chart-rendered');
        if (window.Plotly) { try { Plotly.purge(div); } catch(e) {} }
    });

    // Re-render ALL variable panes — not just the visible one.
    // Temp-show each outer pane and inner chart sub-tab so Plotly gets a real width.
    document.querySelectorAll('#anovaResults .anova-var-section').forEach(pane => {
        const paneHidden = window.getComputedStyle(pane).display === 'none';
        if (paneHidden) { pane.style.display = 'block'; pane.style.visibility = 'hidden'; }

        const innerChart = pane.querySelector('.tab-pane[id$="_chart"]');
        let innerHidden = false;
        if (innerChart) {
            innerHidden = window.getComputedStyle(innerChart).display === 'none';
            if (innerHidden) { innerChart.style.display = 'block'; innerChart.style.visibility = 'hidden'; }
        }

        try { renderPendingAnovaCharts(pane); } catch(e) { console.error('reRender error', e); }

        if (innerChart && innerHidden) { innerChart.style.display = ''; innerChart.style.visibility = ''; }
        if (paneHidden) { pane.style.display = ''; pane.style.visibility = ''; }
    });

    // Resize any charts that are now visible so they fill their container correctly
    document.querySelectorAll('#anovaResults .anova-bar-chart-placeholder.js-plotly-plot').forEach(div => {
        if (window.Plotly) { try { Plotly.Plots.resize(div); } catch(e) {} }
    });
}

// ── ANOVA Plotly chart — publication-quality, multi-type ─────────────────────
/**
 * Render an ANOVA chart using pubPlotSettings (bar / dot / box / violin / bar_dot).
 * containerId: id of the target div; letterGroups: [{group,mean,std,n,letter}];
 * res: the full ANOVA result object (for p, test name, variable name).
 */
function renderAnovaBarChart(containerId, letterGroups, res) {
    if (!window.Plotly || !letterGroups || !letterGroups.length) return;
    const el = document.getElementById(containerId);
    if (!el) return;

    const s = pubPlotSettings;
    const groups  = letterGroups.map(g => g.group);
    const means   = letterGroups.map(g => g.mean);
    const stds    = letterGroups.map(g => g.std);
    const ns      = letterGroups.map(g => g.n);
    const n       = groups.length;

    // Unified color: use unifyFillColor picker if set, else first palette color
    const baseColors     = getPubColors(n, s.colorScheme, s.fillOpacity);
    const baseSolids     = getPubSolidColors(n, s.colorScheme);
    const singleFill     = s.unifyColor && s.unifyFillColor
        ? hexToRgba(s.unifyFillColor, s.fillOpacity / 100)
        : getPubColors(1, s.colorScheme, s.fillOpacity)[0];
    const singleSolid    = s.unifyColor && s.unifyFillColor
        ? s.unifyFillColor
        : getPubSolidColors(1, s.colorScheme)[0];
    const colors         = s.unifyColor ? Array(n).fill(singleFill)  : baseColors;
    const solidColors    = s.unifyColor ? Array(n).fill(singleSolid) : baseSolids;

    const plotType = s.plotType;
    // Build rawGroups from embedded values (added by backend to each letter_group entry).
    // Fall back to extractRawGroupValues for older cached results that lack the values field.
    let rawGroups = null;
    if (['box','violin','dot','bar_dot'].includes(plotType)) {
        const hasEmbedded = letterGroups.every(g => Array.isArray(g.values));
        if (hasEmbedded) {
            rawGroups = Object.fromEntries(letterGroups.map(g => [g.group, g.values]));
        } else {
            rawGroups = extractRawGroupValues(res.variable, letterGroups) || {};
        }
    }

    const yRange           = computeYRange(letterGroups, rawGroups, s);
    const letterAnnotations = buildPubLetterAnnotations(letterGroups, rawGroups, s);
    const layout = buildPubLayout(res, groups, letterAnnotations, s, yRange);
    // Restore custom y-axis title if the user previously edited it for this chart
    if (el.dataset.customYTitle) layout.yaxis.title.text = el.dataset.customYTitle;
    let traces = [];

    if (plotType === 'bar') {
        if (s.showLegend) {
            // Per-group traces so each group gets a named legend entry
            groups.forEach((group, i) => {
                traces.push({
                    x: [group], y: [means[i]],
                    error_y: { type: 'data', array: [stds[i]], visible: true,
                        color: s.errBarColor, thickness: s.errBarThickness, width: s.errBarCap },
                    type: 'bar',
                    name: group,
                    marker: { color: colors[i], line: { color: s.barBorderColor, width: s.barBorderWidth } },
                    showlegend: true,
                    hovertemplate: `<b>${group}</b><br>Mean: ${means[i].toFixed(4)}<br>SD: ${stds[i].toFixed(4)}<br>N: ${ns[i]}<extra></extra>`,
                });
            });
        } else {
            traces = [{
                x: groups, y: means,
                error_y: { type: 'data', array: stds, visible: true,
                    color: s.errBarColor, thickness: s.errBarThickness, width: s.errBarCap },
                type: 'bar',
                marker: { color: colors, line: { color: s.barBorderColor, width: s.barBorderWidth } },
                hovertemplate: groups.map((g, i) =>
                    `<b>${g}</b><br>Mean: ${means[i].toFixed(4)}<br>SD: ${stds[i].toFixed(4)}<br>N: ${ns[i]}<extra></extra>`
                ),
                showlegend: false,
            }];
        }

    } else if (plotType === 'dot') {
        // Strip chart: use hidden Plotly box to get built-in jitter, overlay mean±SD marker
        const jitterW = s.jitter / 100;
        groups.forEach((group, i) => {
            const raw = rawGroups && rawGroups[group];
            const vals = (raw && raw.length) ? raw : [];
            if (vals.length > 0) {
                // Jittered dots via Plotly box with invisible box
                traces.push({
                    type: 'box', name: group,
                    y: vals,
                    boxpoints: 'all', jitter: jitterW, pointpos: 0,
                    fillcolor: 'rgba(0,0,0,0)',
                    line: { color: 'rgba(0,0,0,0)', width: 0 },
                    whiskerwidth: 0,
                    marker: { color: solidColors[i], size: s.pointSize, symbol: s.pointSymbol,
                              opacity: s.pointOpacity / 100, line: { color: solidColors[i], width: 0.5 } },
                    showlegend: s.showLegend,
                    hovertemplate: `<b>${group}</b><br>%{y:.4f}<extra></extra>`,
                });
            }
            // Mean ± SD crossbar always shown (shows in legend only if no raw dots available)
            traces.push({
                type: 'scatter', mode: 'markers',
                name: group,
                x: [group], y: [means[i]],
                error_y: { type: 'data', array: [stds[i]], visible: true,
                    color: s.errBarColor, thickness: s.errBarThickness, width: s.errBarCap },
                marker: { symbol: 'line-ew', size: 22, color: solidColors[i],
                          line: { color: solidColors[i], width: 2.5 } },
                showlegend: s.showLegend && vals.length === 0,
                hovertemplate: `<b>${group}</b><br>Mean: ${means[i].toFixed(4)}<br>SD: ${stds[i].toFixed(4)}<br>N: ${ns[i]}<extra></extra>`,
            });
        });

    } else if (plotType === 'box') {
        groups.forEach((group, i) => {
            const raw = rawGroups && rawGroups[group];
            const vals = (raw && raw.length) ? raw : [means[i]];
            traces.push({
                type: 'box', name: group,
                y: vals,
                boxpoints: 'all', jitter: s.jitter / 100, pointpos: 0,
                marker: { color: solidColors[i], size: s.pointSize, symbol: s.pointSymbol,
                          opacity: s.pointOpacity / 100 },
                line: { color: solidColors[i] },
                fillcolor: colors[i],
                showlegend: s.showLegend,
                hovertemplate: `<b>${group}</b><br>%{y:.4f}<extra></extra>`,
            });
        });

    } else if (plotType === 'violin') {
        groups.forEach((group, i) => {
            const raw = rawGroups && rawGroups[group];
            const vals = (raw && raw.length) ? raw : [means[i]];
            traces.push({
                type: 'violin', name: group,
                y: vals,
                box: { visible: true },
                meanline: { visible: true },
                points: 'all', jitter: s.jitter / 100, pointpos: 0,
                marker: { color: solidColors[i], size: s.pointSize, symbol: s.pointSymbol,
                          opacity: s.pointOpacity / 100 },
                line: { color: solidColors[i] },
                fillcolor: colors[i],
                opacity: s.fillOpacity / 100,
                showlegend: s.showLegend,
                hovertemplate: `<b>${group}</b><br>%{y:.4f}<extra></extra>`,
            });
        });

    } else if (plotType === 'bar_dot') {
        // Bars behind — per-group traces when legend needed, single trace otherwise
        if (s.showLegend) {
            groups.forEach((group, i) => {
                traces.push({
                    x: [group], y: [means[i]],
                    error_y: { type: 'data', array: [stds[i]], visible: true,
                        color: s.errBarColor, thickness: s.errBarThickness, width: s.errBarCap },
                    type: 'bar', name: group,
                    marker: { color: colors[i], line: { color: s.barBorderColor, width: s.barBorderWidth } },
                    showlegend: true,
                    hoverinfo: 'skip',
                });
            });
        } else {
            traces.push({
                x: groups, y: means,
                error_y: { type: 'data', array: stds, visible: true,
                    color: s.errBarColor, thickness: s.errBarThickness, width: s.errBarCap },
                type: 'bar',
                marker: { color: colors, line: { color: s.barBorderColor, width: s.barBorderWidth } },
                showlegend: false,
                hoverinfo: 'skip',
            });
        }
        // Individual dots overlaid
        groups.forEach((group) => {
            const rawDot = rawGroups && rawGroups[group];
            const vals = (rawDot && rawDot.length) ? rawDot : [];
            if (!vals.length) return;
            traces.push({
                type: 'box', name: group,
                y: vals,
                boxpoints: 'all', jitter: s.jitter / 100, pointpos: 0,
                fillcolor: 'rgba(0,0,0,0)',
                line: { color: 'rgba(0,0,0,0)', width: 0 },
                whiskerwidth: 0,
                marker: { color: s.pointColor, size: s.pointSize, symbol: s.pointSymbol,
                          opacity: s.pointOpacity / 100,
                          line: { color: 'rgba(0,0,0,0.3)', width: 0.5 } },
                showlegend: false,
                hovertemplate: `<b>${group}</b><br>%{y:.4f}<extra></extra>`,
            });
        });
    }

    Plotly.newPlot(containerId, traces, layout, {
        responsive: true,
        displayModeBar: false,
        edits: { axisTitleText: true },
    });
    // Persist custom y-axis title: when the user edits it inline, save to the element so
    // re-renders (e.g. changing plot style) restore the edited title instead of the variable name.
    el.on('plotly_relayout', data => {
        if (data['yaxis.title.text'] !== undefined) {
            const newTitle = data['yaxis.title.text'];
            // Clear saved title when the user restores the variable name (or empties it)
            if (!newTitle || newTitle === (res.variable || '')) {
                delete el.dataset.customYTitle;
            } else {
                el.dataset.customYTitle = newTitle;
            }
        }
    });
}

// ── Render all pending ANOVA bar charts inside a given pane element ───────────
// Charts are marked with .anova-chart-rendered once drawn to avoid double-rendering.
function renderPendingAnovaCharts(pane) {
    if (!pane) return;
    pane.querySelectorAll('.anova-bar-chart-placeholder:not(.anova-chart-rendered)').forEach(div => {
        try {
            const letterGroups = JSON.parse(decodeURIComponent(div.dataset.letterGroups || '[]'));
            const fakeRes = {
                variable:          decodeURIComponent(div.dataset.resVariable || ''),
                test_used:         decodeURIComponent(div.dataset.resTest || ''),
                overall_p:         div.dataset.resP !== '' ? parseFloat(div.dataset.resP) : null,
                effect_size:       div.dataset.resEffect !== '' ? parseFloat(div.dataset.resEffect) : null,
                effect_size_label: decodeURIComponent(div.dataset.resEffectLabel || 'η²'),
            };
            renderAnovaBarChart(div.id, letterGroups, fakeRes);
            div.classList.add('anova-chart-rendered');
        } catch (e) { /* skip malformed data */ }
    });
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Helper: build chart-only HTML for one variable (one tab) ─────────────────
function buildVariableChartHTML(varResults, varName, varIdx) {
    let html = '';
    let sliceIdx = 0;
    varResults.forEach(res => {
        const sliceInfo = res.slice_label && res.slice_label !== 'All'
            ? `<span class="badge badge-light border mr-2">${res.slice_label}</span>` : '';
        const sortedGroups = sortLetterGroups(res.letter_groups, 'data_order');
        // Use the numeric varIdx (not the variable name) to avoid ID collisions
        // when different variable names map to the same sanitised string (e.g. φE₀ vs ψE₀)
        const chartId = `anova-bar-v${varIdx ?? 0}-chart-${sliceIdx++}`;
        if (sortedGroups && sortedGroups.length > 0) {
            const pVal = res.overall_p !== null ? res.overall_p.toFixed(4) : '—';
            const isSig = res.overall_p !== null && res.overall_p < 0.05;
            html += `
                <div class="mb-4">
                    ${sliceInfo ? `<div class="mb-2">${sliceInfo}</div>` : ''}
                    <div id="${chartId}" class="anova-bar-chart-placeholder"
                         data-letter-groups="${encodeURIComponent(JSON.stringify(sortedGroups))}"
                         data-res-variable="${encodeURIComponent(res.variable || '')}"
                         data-res-test="${encodeURIComponent(res.test_used || '')}"
                         data-res-p="${res.overall_p !== null ? res.overall_p : ''}"
                         data-res-effect="${res.effect_size !== null && res.effect_size !== undefined ? res.effect_size : ''}"
                         data-res-effect-label="${encodeURIComponent(res.effect_size_label || 'η²')}"
                         style="width:100%; height:380px;">
                    </div>
                    <div class="d-flex flex-wrap align-items-center gap-2 mt-2" style="font-size:0.78rem;">
                        <span class="badge ${isSig ? 'bg-success' : 'bg-secondary'}">
                            p = ${pVal}${isSig ? ' ✓ Significant' : ' n.s.'}
                        </span>
                        <span class="badge badge-primary">${res.test_used || ''}</span>
                        ${res.effect_size != null
                            ? `<span class="badge badge-light border">${res.effect_size_label || 'η²'} = ${res.effect_size.toFixed(3)}</span>`
                            : ''}
                        <span class="text-muted" style="font-size:0.72rem;">
                            Normality: ${res.assumptions && res.assumptions.all_normal ? '<span class="text-success">✓</span>' : '<span class="text-danger">✗</span>'}
                            &nbsp;Homogeneity: ${res.assumptions && res.assumptions.homogeneous ? '<span class="text-success">✓</span>' : '<span class="text-danger">✗</span>'}
                        </span>
                    </div>
                </div>`;
        } else {
            html += `
                <div class="alert alert-secondary py-2 small">
                    ${sliceInfo || 'All groups'}: No significant differences (p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}).
                    All groups share letter <span class="badge" style="padding:4px 10px; border-radius:10px; ${getLetterGroupStyle('a')}">a</span>.
                </div>`;
        }
    });
    return html;
}

// ── Helper: build groups table HTML for one variable (one tab) ────────────────
function buildVariableGroupsHTML(varResults, sortMode, varName) {
    let html = '';

    // Sort controls row
    const sortBtns = ['data_order', 'letter', 'mean_asc', 'mean_desc'];
    const sortLabels = { data_order: 'Data Order', letter: 'Letter Group', mean_asc: 'Mean ↑', mean_desc: 'Mean ↓' };
    const btns = sortBtns.map(s => `
        <button type="button"
                class="btn btn-sm var-sort-btn ${s === (sortMode || 'data_order') ? 'btn-secondary active' : 'btn-outline-secondary'}"
                data-var="${varName}" data-sort="${s}"
                style="font-size:0.72rem; padding:2px 8px;">
            ${sortLabels[s]}
        </button>`).join('');
    html += `
        <div class="d-flex align-items-center gap-2 flex-wrap mb-3">
            <span class="small font-weight-bold text-muted"><i class="fa fa-sort-amount-desc mr-1"></i>Sort groups by:</span>
            <div class="btn-group btn-group-sm" role="group">${btns}</div>
        </div>`;

    varResults.forEach(res => {
        const sliceInfo = res.slice_label && res.slice_label !== 'All'
            ? `<span class="badge badge-light border mr-2">${res.slice_label}</span>` : '';
        const sortedGroups = sortLetterGroups(res.letter_groups, sortMode || 'data_order');
        if (sortedGroups && sortedGroups.length > 0) {
            const pVal = res.overall_p !== null ? res.overall_p.toFixed(4) : '—';
            const isSig = res.overall_p !== null && res.overall_p < 0.05;
            html += `
                <div class="mb-4">
                    ${sliceInfo ? `<div class="mb-2">${sliceInfo}</div>` : ''}
                    <div class="d-flex align-items-center gap-2 mb-2" style="font-size:0.78rem;">
                        <span class="badge ${isSig ? 'bg-success' : 'bg-secondary'}">p = ${pVal}${isSig ? ' ✓' : ' n.s.'}</span>
                        <span class="badge badge-primary">${res.test_used || ''}</span>
                        ${res.posthoc_method ? `<span class="text-muted">Post-hoc: ${res.posthoc_method}</span>` : ''}
                    </div>
                    <table class="table table-sm table-bordered text-center">
                        <thead class="table-light">
                            <tr><th class="text-left">Group</th><th>Mean</th><th>SD</th><th>N</th><th>Letter</th></tr>
                        </thead>
                        <tbody>
                            ${sortedGroups.map(lg => `
                                <tr>
                                    <td class="text-left font-weight-bold">${lg.group}</td>
                                    <td>${lg.mean.toFixed(4)}</td>
                                    <td>${lg.std.toFixed(4)}</td>
                                    <td>${lg.n}</td>
                                    <td>
                                        <span class="badge fs-6" style="padding:6px 14px; border-radius:50px; ${getLetterGroupStyle(lg.letter)}">
                                            ${lg.letter}
                                        </span>
                                    </td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        } else {
            html += `
                <div class="alert alert-secondary py-2 small">
                    ${sliceInfo || 'All groups'}: No significant differences (p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}).
                </div>`;
        }
    });
    return html;
}

// ── Helper: build pairwise detail HTML for one variable (one tab) ─────────────
function buildVariablePairwiseHTML(varResults) {
    let html = '';
    let hasAny = false;
    varResults.forEach(res => {
        const sliceInfo = res.slice_label && res.slice_label !== 'All'
            ? `<div class="mb-1"><span class="badge badge-light border">${res.slice_label}</span></div>` : '';
        if (res.posthoc && res.posthoc.length > 0) {
            hasAny = true;
            html += `
                <div class="mb-4">
                    ${sliceInfo}
                    <div class="d-flex gap-2 align-items-center mb-2" style="font-size:0.78rem;">
                        <span class="badge badge-primary">${res.test_used}</span>
                        ${res.posthoc_method ? `<span class="text-muted">Post-hoc: ${res.posthoc_method}</span>` : ''}
                        <strong>p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}</strong>
                    </div>
                    <table class="table table-sm table-bordered">
                        <thead class="table-light">
                            <tr><th>Comparison</th><th>p (adj.)</th><th>Result</th></tr>
                        </thead>
                        <tbody>
                            ${res.posthoc.map(ph => `
                                <tr>
                                    <td><strong>${ph.group1}</strong> vs <strong>${ph.group2}</strong></td>
                                    <td>${ph.p_adj.toFixed(4)}</td>
                                    <td>${ph.significant
                                        ? '<span class="badge badge-success">Significant</span>'
                                        : '<span class="badge badge-secondary">n.s.</span>'}</td>
                                </tr>`).join('')}
                        </tbody>
                    </table>
                </div>`;
        } else {
            html += `
                <div class="mb-3">
                    ${sliceInfo}
                    <div class="alert alert-secondary py-2 small">
                        No pairwise comparisons (overall p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}).
                    </div>
                </div>`;
        }
    });
    if (!hasAny && !html.includes('alert')) {
        html = `<div class="alert alert-secondary small">No post-hoc comparisons available for this variable.</div>`;
    }
    return html;
}

// ── Helper: build Overview tab (cross-variable summary table) ─────────────────
function buildAnovaOverviewHTML(byVariable, varOrder) {
    let rows = '';
    varOrder.forEach(varName => {
        const res = byVariable[varName][0]; // use first slice for overview
        const isSig = res.overall_p !== null && res.overall_p < 0.05;
        const pFormatted = res.overall_p !== null ? res.overall_p.toFixed(4) : '—';
        const normOk  = res.assumptions && res.assumptions.all_normal;
        const homogOk = res.assumptions && res.assumptions.homogeneous;

        // Compact letter groups preview
        const letters = res.letter_groups && res.letter_groups.length
            ? [...new Set(res.letter_groups.map(g => g.letter))].join(', ')
            : '—';

        rows += `
            <tr>
                <td class="font-weight-bold">${varName}</td>
                <td><span class="badge badge-primary" style="font-size:0.68rem;">${res.test_used || '—'}</span></td>
                <td>
                    <span class="font-weight-bold ${isSig ? 'text-success' : 'text-secondary'}">${pFormatted}</span>
                </td>
                <td>${res.effect_size != null
                    ? `<span style="font-size:0.80rem;">${res.effect_size_label || 'η²'} = ${res.effect_size.toFixed(3)}</span>`
                    : '<span class="text-muted">—</span>'}</td>
                <td class="text-center">
                    <span title="Normality">${normOk ? '✅' : '❌'}</span>
                    <span title="Homogeneity" class="ms-1">${homogOk ? '✅' : '❌'}</span>
                </td>
                <td>
                    <span class="badge ${isSig ? 'bg-success' : 'bg-secondary'}" style="font-size:0.70rem;">
                        ${isSig ? '✓ Significant' : 'n.s.'}
                    </span>
                </td>
                <td style="font-size:0.78rem; font-family:monospace; letter-spacing:0.05em;">${letters}</td>
            </tr>`;
    });

    return `
        <div class="mb-2 pb-1 d-flex align-items-center gap-2">
            <i class="fa fa-th text-success"></i>
            <span class="font-weight-bold" style="font-size:0.9rem;">All Variables at a Glance</span>
            <span class="text-muted small">— click a variable tab above to explore its chart and groups</span>
        </div>
        <div class="table-responsive">
            <table class="table table-sm table-bordered table-hover" style="font-size:0.82rem;">
                <thead class="table-light">
                    <tr>
                        <th>Variable</th>
                        <th>Test</th>
                        <th>Overall p</th>
                        <th>Effect size</th>
                        <th class="text-center" title="Normality / Homogeneity">Assumptions</th>
                        <th>Result</th>
                        <th>Letter groups</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p class="extra-small text-muted mt-1 mb-0">
            <i class="fa fa-info-circle mr-1"></i>
            Assumptions column: left = Normality (Shapiro-Wilk), right = Homogeneity (Levene's). ✅ = passed (p &gt; 0.05).
        </p>`;
}

// ── Helper: kept for backward-compat (export code calls this) ────────────────
function buildVariableSummaryHTML(varResults, sortMode, varName) {
    return buildVariableGroupsHTML(varResults, sortMode, varName);
}

// ── Render ANOVA results (called on first run and on re-sort) ─────────────────
function renderAnovaResults(data) {
    const anovaResults = document.getElementById('anovaResults');
    anovaResults.innerHTML = '';

    // Test selection rationale banner (from backend)
    if (data.test_rationale) {
        const rationale = document.createElement('div');
        rationale.className = 'alert alert-info border-0 shadow-sm mb-3 py-2 px-3 small';
        rationale.innerHTML = `<i class="fa fa-cog mr-2"></i><strong>Test Selected:</strong> ${data.test_rationale}`;
        anovaResults.appendChild(rationale);
    }

    // Group results by variable (preserve order)
    const byVariable = {};
    const varOrder = [];
    data.results.forEach(res => {
        if (!byVariable[res.variable]) {
            byVariable[res.variable] = [];
            varOrder.push(res.variable);
        }
        byVariable[res.variable].push(res);
    });

    // ── Outer wrapper ─────────────────────────────────────────────────────────
    const wrapper = document.createElement('div');
    wrapper.className = 'anova-results-wrapper';

    // ── Outer tab nav: Overview + one tab per variable ────────────────────────
    const navId = 'anovaOuterNav';
    let navHTML = `<ul class="nav custom-anova-tabs mb-0" id="${navId}" role="tablist">
        <li class="nav-item">
            <button class="nav-link active small font-weight-bold" data-toggle="tab" data-target="#anova_overview">
                <i class="fa fa-th mr-1"></i>Overview
            </button>
        </li>`;

    varOrder.forEach((varName, idx) => {
        const varId = 'anova_var_' + idx;
        const firstRes = byVariable[varName][0];
        const isSig = firstRes.overall_p !== null && firstRes.overall_p < 0.05;
        navHTML += `
        <li class="nav-item">
            <button class="nav-link small font-weight-bold" data-toggle="tab" data-target="#${varId}"
                    style="position:relative;">
                ${varName}
                <span class="anova-var-sig-dot ${isSig ? 'sig' : 'ns'}" title="${isSig ? 'Significant' : 'Not significant'}"></span>
            </button>
        </li>`;
    });
    navHTML += `</ul>`;

    // ── Outer tab content ─────────────────────────────────────────────────────
    let contentHTML = `<div class="tab-content border border-top-0 rounded-bottom bg-white p-3 shadow-sm" id="${navId}Content">
        <!-- Overview tab -->
        <div class="tab-pane fade show active" id="anova_overview" role="tabpanel">
            ${buildAnovaOverviewHTML(byVariable, varOrder)}
        </div>`;

    varOrder.forEach((varName, idx) => {
        const varResults = byVariable[varName];
        const varId = 'anova_var_' + idx;
        const currentSortMode = anovaVarSortModes[varName] || 'data_order';

        const subNavId = `${varId}_subnav`;

        contentHTML += `
        <!-- Variable tab: ${varName} -->
        <div class="tab-pane fade anova-var-section" id="${varId}" role="tabpanel" data-var-name="${varName}">
            <div class="d-flex align-items-center justify-content-between mb-2">
                <h6 class="font-weight-bold text-success mb-0">${varName}</h6>
            </div>

            <!-- Inner pill sub-tabs: Chart | Groups | Pairwise -->
            <ul class="nav anova-var-subtabs mb-3" id="${subNavId}" role="tablist">
                <li class="nav-item">
                    <button class="nav-link active" data-toggle="tab" data-target="#${varId}_chart">
                        <i class="fa fa-bar-chart mr-1"></i>Chart
                    </button>
                </li>
                <li class="nav-item">
                    <button class="nav-link" data-toggle="tab" data-target="#${varId}_groups">
                        <i class="fa fa-table mr-1"></i>Groups
                    </button>
                </li>
                <li class="nav-item">
                    <button class="nav-link" data-toggle="tab" data-target="#${varId}_pairwise">
                        <i class="fa fa-list-ul mr-1"></i>Pairwise
                    </button>
                </li>
            </ul>

            <div class="tab-content">
                <div class="tab-pane fade show active" id="${varId}_chart" role="tabpanel">
                    <div class="var-chart-content">
                        ${buildVariableChartHTML(varResults, varName, idx)}
                    </div>
                </div>
                <div class="tab-pane fade" id="${varId}_groups" role="tabpanel">
                    <div class="var-groups-content" data-var-name="${varName}">
                        ${buildVariableGroupsHTML(varResults, currentSortMode, varName)}
                    </div>
                </div>
                <div class="tab-pane fade" id="${varId}_pairwise" role="tabpanel">
                    ${buildVariablePairwiseHTML(varResults)}
                </div>
            </div>
        </div>`;
    });

    contentHTML += `</div>`; // close tab-content

    wrapper.innerHTML = navHTML + contentHTML;
    anovaResults.appendChild(wrapper);

    // Lazy-render ANOVA charts: render only when a variable tab is first shown.
    // Rendering into hidden tab panes (display:none) gives Plotly a width of 0,
    // causing charts to overflow/shrink. Deferring to shown.bs.tab fixes this.
    $(wrapper).on('shown.bs.tab', 'button[data-toggle="tab"]', function () {
        const targetId = $(this).data('target');
        if (!targetId || targetId === '#anova_overview') return;
        const pane = wrapper.querySelector(targetId);
        renderPendingAnovaCharts(pane);
        // Resize already-rendered charts in case the container changed size
        if (window.Plotly && pane) {
            pane.querySelectorAll('.anova-chart-rendered.js-plotly-plot').forEach(div => {
                Plotly.Plots.resize(div);
            });
        }
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL REPORT EXPORT
// ══════════════════════════════════════════════════════════════════════════════
document.getElementById('exportFullReportBtn').addEventListener('click', async function() {
    if (!lastAnovaResults) return;

    const exportSpinner = document.getElementById('exportSpinner');
    const btn = this;
    btn.disabled = true;
    if (exportSpinner) exportSpinner.style.display = 'inline-flex';

    try {
        // Pre-render any ANOVA variable charts the user never opened (hidden tab panes).
        // Temporarily display each pane so Plotly can measure the container width.
        document.querySelectorAll('#anovaResults .anova-var-section').forEach(pane => {
            const wasHidden = window.getComputedStyle(pane).display === 'none';
            if (wasHidden) { pane.style.display = 'block'; pane.style.visibility = 'hidden'; }
            renderPendingAnovaCharts(pane);
            if (wasHidden) { pane.style.display = ''; pane.style.visibility = ''; }
        });

        // Capture Plotly plots as base64 PNG
        const plotCaptures = [];
        const plotSelectors = [
            { selector: '#assumptionsBoxPlots .js-plotly-plot', type: 'box' },
            { selector: '#assumptionsResidualsContent .js-plotly-plot', type: 'residuals' },
            { selector: '#assumptionsQQContent .js-plotly-plot', type: 'qq' },
            { selector: '#anovaResults .anova-bar-chart-placeholder.js-plotly-plot', type: 'anova' }
        ];

        for (const { selector, type } of plotSelectors) {
            const divs = document.querySelectorAll(selector);
            for (const div of divs) {
                try {
                    const img = await Plotly.toImage(div, { format: 'png', width: 700, height: 380 });
                    plotCaptures.push({
                        label: div.id || div.getAttribute('data-var') || type,
                        type,
                        image: img.split(',')[1]
                    });
                } catch(e) { /* skip non-Plotly divs */ }
            }
        }

        const originalData = globalData;
        const analysedData = buildTransformedData(globalData, appliedTransformations);
        const transformNotes = Object.entries(appliedTransformations)
            .filter(([, t]) => t && t.type && t.type !== 'none')
            .map(([v, t]) => v + ': ' + getTransformLabel(t.type, t.power))
            .join(', ') || 'None';

        const payload = {
            original_data: originalData,
            analysed_data: analysedData,
            transform_notes: transformNotes,
            anova_results: lastAnovaResults,
            assumption_results: lastTestResults,
            original_assumption_results: lastOriginalTestResults,
            plot_captures: plotCaptures,
            factors: selectedFactors,
            target_columns: Array.from(document.querySelectorAll('.var-check:checked'))
                .filter(cb => !cb.disabled).map(cb => cb.value)
        };

        const res = await fetch('/export-full-report', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(errData.error || 'Export failed');
        }

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'Statistical_Analysis_Full_Report.xlsx';
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

    } catch(err) {
        alert('Export Error: ' + err.message);
    } finally {
        btn.disabled = false;
        if (exportSpinner) exportSpinner.style.display = 'none';
    }
});


// Fix for missing plots in hidden sub-tabs
$(document).on('shown.bs.tab', 'a[data-toggle="tab"]', function (e) {
    const targetId = $(e.target).attr('href'); // e.g., "#viz-content", "#assumptions-residuals"

    // Visualizations tab: resize all Plotly plots inside #statsContent
    if (targetId === "#viz-content") {
        document.querySelectorAll('#statsContent .js-plotly-plot').forEach(container => {
            Plotly.Plots.resize(container);
        });
        return;
    }

    // Assumptions sub-tabs: resize their plots
    if (targetId === "#assumptions-residuals" || targetId === "#assumptions-qq" || targetId === "#assumptions-boxplots") {
        // Find all Plotly plots inside the newly visible tab
        const containers = document.querySelectorAll(targetId + ' .assumptions-plot-container, ' + targetId + ' [id^="plot-box-swarm-"]');

        containers.forEach(container => {
            // Only resize if Plotly has already been initialized on this div
            if (container.classList.contains('js-plotly-plot')) {
                Plotly.Plots.resize(container);
            }
        });
    }
});

// Toggle between transformed and original plots
document.addEventListener('click', function(e) {
    const btn = e.target && e.target.closest && e.target.closest('.btn-toggle-plot');
    if (!btn) return;
    const transformedId = btn.getAttribute('data-transformed');
    const originalId = btn.getAttribute('data-original');
    const showing = btn.getAttribute('data-showing');

    const transformedEl = document.getElementById(transformedId);
    const originalEl = document.getElementById(originalId);
    if (!transformedEl || !originalEl) return;

    if (showing === 'transformed') {
        // Switch to original
        transformedEl.style.display = 'none';
        originalEl.style.display = 'block';
        // Resize Plotly if needed
        if (originalEl.classList.contains('js-plotly-plot')) Plotly.Plots.resize(originalEl);
        btn.setAttribute('data-showing', 'original');
        btn.innerHTML = '<i class="fa fa-eye-slash mr-1"></i> Show Transformed';
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-outline-warning');
    } else {
        // Switch back to transformed
        transformedEl.style.display = 'block';
        originalEl.style.display = 'none';
        if (transformedEl.classList.contains('js-plotly-plot')) Plotly.Plots.resize(transformedEl);
        btn.setAttribute('data-showing', 'transformed');
        btn.innerHTML = '<i class="fa fa-eye mr-1"></i> Show Original';
        btn.classList.remove('btn-outline-warning');
        btn.classList.add('btn-outline-secondary');
    }
});


// ══════════════════════════════════════════════════════════════════════════════
// PUBLICATION PLOT SETTINGS UI + ZIP EXPORT
// ══════════════════════════════════════════════════════════════════════════════

function initPubPlotSettingsUI() {
    // ── Load saved settings from localStorage ─────────────────────────────────
    try {
        const saved = localStorage.getItem('pubPlotSettings');
        if (saved) pubPlotSettings = Object.assign({}, PUB_PLOT_DEFAULTS, JSON.parse(saved));
    } catch(e) {}

    // ── Helper: read all UI controls → pubPlotSettings ───────────────────────
    function readSettings() {
        const s = pubPlotSettings;
        const g  = id => document.getElementById(id);
        const val = id => { const el = g(id); return el ? el.value : null; };
        const num = id => { const el = g(id); return el ? parseFloat(el.value) : null; };
        const nt  = id => { const el = g(id); return el ? parseInt(el.value, 10) : null; };
        const chk = id => { const el = g(id); return el ? el.checked : false; };
        const radio = name => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? el.value : null; };

        s.plotType      = radio('pubPlotType') || 'bar';
        s.sizePreset    = val('pubSizePreset') || 'single';
        // Width from preset or custom input
        const presetWidths = { single: 85, half: 120, double: 175 };
        s.exportWidth   = presetWidths[s.sizePreset] ?? (num('pubExportWidth') || 85);
        // Aspect ratio: from preset or custom number input
        const ratioPresets = { '16:9': 16/9, '3:2': 1.5, '4:3': 4/3, '1:1': 1, '3:4': 0.75, '2:3': 2/3 };
        const ratioSel = val('pubAspectRatioPreset') || '3:2';
        s.aspectRatio   = ratioSel === 'custom'
            ? (num('pubAspectRatioCustom') || 1.5)
            : (ratioPresets[ratioSel] ?? 1.5);
        s.exportDPI     = nt('pubExportDPI') || 300;
        s.exportFormat  = val('pubExportFormat') || 'png';

        s.fontFamily     = val('pubFontFamily') || 'Arial';
        s.axisTitleSize  = nt('pubAxisTitleSize') || 12;
        s.tickLabelSize  = nt('pubTickLabelSize') || 10;
        s.annotationSize = nt('pubAnnotationSize') || 11;
        s.legendSize     = nt('pubLegendSize') || 10;

        s.showGridY     = chk('pubGridY');
        s.showGridX     = chk('pubGridX');
        s.gridStyle     = val('pubGridStyle') || 'solid';
        s.gridColor     = val('pubGridColor') || '#e0e0e0';
        s.tickPosition  = val('pubTickPosition') ?? 'outside';
        s.tickLen       = nt('pubTickLen') || 5;
        s.showAxisLine  = chk('pubShowAxisLine');
        s.showPlotFrame = chk('pubShowPlotFrame');
        s.showPaperBorder = chk('pubShowPaperBorder');

        s.yStartZero    = chk('pubYStartZero');
        s.yHeadroom     = nt('pubYHeadroom') ?? 15;

        s.colorScheme    = val('pubColorScheme') || 'okabe';
        s.fillOpacity    = nt('pubFillOpacity') || 85;
        s.unifyColor     = chk('pubUnifyColor');
        s.unifyFillColor = val('pubUnifyFillColor') || '#4DBBD5';
        s.barBorderColor = val('pubBarBorderColor') || '#333333';
        s.barBorderWidth = parseFloat(val('pubBarBorderWidth') || '1');
        s.errBarColor    = val('pubErrBarColor') || '#333333';
        s.errBarThickness = parseFloat(val('pubErrBarThickness') || '1.5');
        s.errBarCap      = nt('pubErrBarCap') || 5;
        s.pointSymbol    = val('pubPointSymbol') || 'circle';
        s.pointSize      = nt('pubPointSize') || 7;
        s.pointColor     = val('pubPointColor') || '#333333';
        s.pointOpacity   = nt('pubPointOpacity') || 70;
        s.jitter         = nt('pubJitter') || 20;

        s.showLegend        = chk('pubShowLegend');
        s.legendPosition    = val('pubLegendPosition') || 'top-right';
        s.legendOrientation = val('pubLegendOrientation') || 'v';
        s.showLetters       = chk('pubShowLetters');
        s.letterBold        = chk('pubLetterBold');
        s.letterOffset      = nt('pubLetterOffset') ?? 7;
        s.letterPerBar      = chk('pubLetterPerBar');
        s.showTestInfo      = chk('pubShowTestInfo');
        s.bgColor           = val('pubBgColor') || '#ffffff';
    }

    // ── Helper: sync UI controls ← pubPlotSettings ───────────────────────────
    function syncUI() {
        const s = pubPlotSettings;
        const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
        const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
        const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

        const typeEl = document.querySelector(`input[name="pubPlotType"][value="${s.plotType}"]`);
        if (typeEl) {
            typeEl.checked = true;
            document.querySelectorAll('#pubPlotTypeGroup label').forEach(l => l.classList.remove('active'));
            if (typeEl.parentElement && typeEl.parentElement.tagName === 'LABEL') {
                typeEl.parentElement.classList.add('active');
            }
        }

        setVal('pubSizePreset', s.sizePreset);
        setVal('pubExportWidth', s.exportWidth);
        setVal('pubExportDPI', s.exportDPI);
        setVal('pubExportFormat', s.exportFormat);
        // Show/hide custom width field
        const cw = document.getElementById('pubCustomWidthWrap');
        if (cw) cw.style.display = (s.sizePreset === 'custom') ? '' : 'none';
        // Aspect ratio: find matching preset or fall back to custom
        const ratioPresets = { '16:9': 16/9, '3:2': 1.5, '4:3': 4/3, '1:1': 1, '3:4': 0.75, '2:3': 2/3 };
        const matchedKey = Object.keys(ratioPresets).find(k => Math.abs(ratioPresets[k] - s.aspectRatio) < 0.01);
        setVal('pubAspectRatioPreset', matchedKey || 'custom');
        const crw = document.getElementById('pubCustomRatioWrap');
        if (crw) crw.style.display = matchedKey ? 'none' : '';
        setVal('pubAspectRatioCustom', s.aspectRatio.toFixed(3));

        setVal('pubFontFamily', s.fontFamily);
        setVal('pubAxisTitleSize', s.axisTitleSize);
        setVal('pubTickLabelSize', s.tickLabelSize);
        setVal('pubAnnotationSize', s.annotationSize);
        setVal('pubLegendSize', s.legendSize);

        setChk('pubGridY', s.showGridY);
        setChk('pubGridX', s.showGridX);
        setVal('pubGridStyle', s.gridStyle);
        setVal('pubGridColor', s.gridColor);
        setVal('pubTickPosition', s.tickPosition);
        setVal('pubTickLen', s.tickLen);
        setChk('pubShowAxisLine', s.showAxisLine);
        setChk('pubShowPlotFrame', s.showPlotFrame);
        setChk('pubShowPaperBorder', s.showPaperBorder);

        setChk('pubYStartZero', s.yStartZero);
        setVal('pubYHeadroom', s.yHeadroom);

        setVal('pubColorScheme', s.colorScheme);
        setVal('pubFillOpacity', s.fillOpacity);
        setTxt('pubFillOpacityVal', s.fillOpacity + '%');
        setChk('pubUnifyColor', s.unifyColor);
        setVal('pubUnifyFillColor', s.unifyFillColor || '#4DBBD5');
        const ufcWrap = document.getElementById('pubUnifyFillColorWrap');
        if (ufcWrap) ufcWrap.style.display = s.unifyColor ? '' : 'none';
        setVal('pubBarBorderColor', s.barBorderColor);
        setVal('pubBarBorderWidth', s.barBorderWidth);
        setTxt('pubBarBorderWidthVal', s.barBorderWidth + 'px');
        setVal('pubErrBarColor', s.errBarColor);
        setVal('pubErrBarThickness', s.errBarThickness);
        setVal('pubErrBarCap', s.errBarCap);
        setVal('pubPointSymbol', s.pointSymbol);
        setVal('pubPointSize', s.pointSize);
        setVal('pubPointColor', s.pointColor);
        setVal('pubPointOpacity', s.pointOpacity);
        setTxt('pubPointOpacityVal', s.pointOpacity + '%');
        setVal('pubJitter', s.jitter);
        setTxt('pubJitterVal', (s.jitter / 100).toFixed(2));

        setChk('pubShowLegend', s.showLegend);
        setVal('pubLegendPosition', s.legendPosition);
        setVal('pubLegendOrientation', s.legendOrientation);
        setChk('pubShowLetters', s.showLetters);
        setChk('pubLetterBold', s.letterBold);
        setChk('pubLetterPerBar', s.letterPerBar);
        setVal('pubLetterOffset', s.letterOffset);
        setTxt('pubLetterOffsetVal', s.letterOffset + '%');
        setChk('pubShowTestInfo', s.showTestInfo);
        setVal('pubBgColor', s.bgColor);
    }

    // ── Helper: update live labels for range sliders ──────────────────────────
    function updateRangeLabels() {
        const fo = document.getElementById('pubFillOpacity');
        const fv = document.getElementById('pubFillOpacityVal');
        if (fo && fv) fv.textContent = fo.value + '%';

        const bw = document.getElementById('pubBarBorderWidth');
        const bwv = document.getElementById('pubBarBorderWidthVal');
        if (bw && bwv) bwv.textContent = bw.value + 'px';

        const po = document.getElementById('pubPointOpacity');
        const pov = document.getElementById('pubPointOpacityVal');
        if (po && pov) pov.textContent = po.value + '%';

        const jt = document.getElementById('pubJitter');
        const jtv = document.getElementById('pubJitterVal');
        if (jt && jtv) jtv.textContent = (parseInt(jt.value, 10) / 100).toFixed(2);

        const lo = document.getElementById('pubLetterOffset');
        const lov = document.getElementById('pubLetterOffsetVal');
        if (lo && lov) lov.textContent = lo.value + '%';
    }

    // ── Helper: update custom-badge visibility ────────────────────────────────
    function updateBadge() {
        const badge = document.getElementById('pubPlotActiveBadge');
        if (!badge) return;
        const isCustom = Object.keys(PUB_PLOT_DEFAULTS).some(k => pubPlotSettings[k] !== PUB_PLOT_DEFAULTS[k]);
        badge.style.display = isCustom ? 'inline-block' : 'none';
    }

    // ── Persist & badge on any change ────────────────────────────────────────
    let _reRenderDebounceTimer = null;
    const _pubSpinner = document.getElementById('pubPlotApplySpinner');
    function _showPubSpinner() { if (_pubSpinner) _pubSpinner.style.display = 'inline-flex'; }
    function _hidePubSpinner() { if (_pubSpinner) _pubSpinner.style.display = 'none'; }

    function onAnyChange() {
        updateRangeLabels();
        // Show/hide custom-width input based on size preset
        const preset = document.getElementById('pubSizePreset');
        const cw = document.getElementById('pubCustomWidthWrap');
        if (preset && cw) cw.style.display = (preset.value === 'custom') ? '' : 'none';
        // Show/hide custom ratio input based on aspect ratio preset
        const ratioSel = document.getElementById('pubAspectRatioPreset');
        const crw = document.getElementById('pubCustomRatioWrap');
        if (ratioSel && crw) crw.style.display = (ratioSel.value === 'custom') ? '' : 'none';
        // Show/hide unified fill color picker
        const ucChk = document.getElementById('pubUnifyColor');
        const ufcWrapOac = document.getElementById('pubUnifyFillColorWrap');
        if (ucChk && ufcWrapOac) ufcWrapOac.style.display = ucChk.checked ? '' : 'none';
        // Read & save
        readSettings();
        try { localStorage.setItem('pubPlotSettings', JSON.stringify(pubPlotSettings)); } catch(e) {}
        updateBadge();
        // Apply aspect ratio immediately to on-screen chart heights
        applyAspectRatioToCharts();
        // Show spinner and debounce re-render
        _showPubSpinner();
        clearTimeout(_reRenderDebounceTimer);
        _reRenderDebounceTimer = setTimeout(() => {
            // Two rAF so browser paints the spinner before the synchronous render blocks
            requestAnimationFrame(() => requestAnimationFrame(() => {
                reRenderAllAnovaCharts();
                _hidePubSpinner();
            }));
        }, 500);
    }

    // Sync chevron rotation for the pub plot card collapse
    const pubBody = document.getElementById('pubPlotStyleBody');
    const pubChevron = document.getElementById('pubPlotChevron');
    if (pubBody && pubChevron) {
        $(pubBody).on('show.bs.collapse', () => { pubChevron.style.transform = 'rotate(180deg)'; });
        $(pubBody).on('hide.bs.collapse', () => { pubChevron.style.transform = 'rotate(0deg)'; });
    }

    // Register listeners on all form controls inside the card
    const card = document.getElementById('pubPlotStyleCard');
    if (card) {
        card.querySelectorAll('input, select').forEach(el => {
            el.addEventListener('change', onAnyChange);
            if (el.type === 'range') el.addEventListener('input', onAnyChange);
        });
        // Bootstrap 4 btn-group-toggle intercepts clicks on labels and may not fire
        // a 'change' event on the underlying radio input — listen to label clicks too.
        card.querySelectorAll('.btn-group-toggle label').forEach(label => {
            label.addEventListener('click', () => setTimeout(onAnyChange, 0));
        });
    }

    // Reset button → restore defaults
    const resetBtn = document.getElementById('resetPubStyleBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            clearTimeout(_reRenderDebounceTimer);
            pubPlotSettings = Object.assign({}, PUB_PLOT_DEFAULTS);
            syncUI();
            updateRangeLabels();
            updateBadge();
            try { localStorage.removeItem('pubPlotSettings'); } catch(e) {}
            _showPubSpinner();
            requestAnimationFrame(() => requestAnimationFrame(() => {
                reRenderAllAnovaCharts();
                _hidePubSpinner();
            }));
        });
    }

    // Apply saved settings to UI on load
    syncUI();
    updateRangeLabels();
    updateBadge();
}

// ── Publication plots ZIP export ──────────────────────────────────────────────
document.getElementById('exportPubPlotsBtn').addEventListener('click', async function () {
    if (!lastAnovaResults) return;
    if (typeof JSZip === 'undefined') { alert('JSZip not loaded — please refresh the page.'); return; }

    const spinner = document.getElementById('pubExportSpinner');
    const btn = this;
    btn.disabled = true;
    if (spinner) spinner.style.display = 'inline-flex';

    try {
        const s = pubPlotSettings;
        const presetWidths = { single: 85, half: 120, double: 175 };
        const widthMm  = presetWidths[s.sizePreset] ?? s.exportWidth;
        const targetWidthPx = Math.round((widthMm / 25.4) * s.exportDPI);
        const fmt      = s.exportFormat; // 'png' or 'svg'

        const zip    = new JSZip();
        const folder = zip.folder('publication_plots');

        // Apply aspect ratio to chart heights first, then force re-render all panes.
        // Record each chart's on-screen dimensions to preserve ratio + font scale in export.
        applyAspectRatioToCharts();
        document.querySelectorAll('#anovaResults .anova-bar-chart-placeholder').forEach(div => {
            div.classList.remove('anova-chart-rendered');
            if (window.Plotly) { try { Plotly.purge(div); } catch(e) {} }
        });
        const screenDims = new Map(); // div → { w, h }
        document.querySelectorAll('#anovaResults .anova-var-section').forEach(pane => {
            const hidden = window.getComputedStyle(pane).display === 'none';
            if (hidden) { pane.style.display = 'block'; pane.style.visibility = 'hidden'; }
            const innerChart = pane.querySelector('.tab-pane[id$="_chart"]');
            let innerHidden = false;
            if (innerChart) {
                innerHidden = window.getComputedStyle(innerChart).display === 'none';
                if (innerHidden) { innerChart.style.display = 'block'; innerChart.style.visibility = 'hidden'; }
            }
            renderPendingAnovaCharts(pane);
            // Capture screen dimensions while pane is visible
            pane.querySelectorAll('.anova-bar-chart-placeholder.js-plotly-plot').forEach(div => {
                screenDims.set(div, { w: div.clientWidth || 600, h: div.clientHeight || 380 });
            });
            if (innerChart && innerHidden) { innerChart.style.display = ''; innerChart.style.visibility = ''; }
            if (hidden) { pane.style.display = ''; pane.style.visibility = ''; }
        });

        const chartDivs = document.querySelectorAll(
            '#anovaResults .anova-bar-chart-placeholder.js-plotly-plot'
        );

        let exported = 0;
        for (const div of chartDivs) {
            const rawVar = div.getAttribute('data-res-variable') || `plot_${exported}`;
            let decoded = rawVar;
            try { decoded = decodeURIComponent(rawVar); } catch(e) {}
            const safeName = decoded.replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_');
            const fname = `${String(exported + 1).padStart(2, '0')}_${safeName}.${fmt}`;

            try {
                // Scale from on-screen size → target print size, preserving all proportions
                // (aspect ratio, font sizes, margins — everything looks identical to screen, at high-res)
                const dims  = screenDims.get(div) || { w: 600, h: 380 };
                const scale = Math.max(targetWidthPx / dims.w, 1);
                const dataUrl = await Plotly.toImage(div, { format: fmt, width: dims.w, height: dims.h, scale });

                if (fmt === 'svg') {
                    // Plotly returns SVG as a URL-encoded data URL (not base64)
                    let svgText;
                    if (dataUrl.startsWith('data:image/svg+xml;base64,')) {
                        svgText = atob(dataUrl.replace('data:image/svg+xml;base64,', ''));
                    } else {
                        svgText = decodeURIComponent(dataUrl.replace(/^data:image\/svg\+xml,/, ''));
                    }
                    folder.file(fname, svgText); // store as plain text (UTF-8)
                } else {
                    // PNG: strip prefix, inject pHYs DPI metadata, store as binary
                    let b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
                    b64 = injectPngDpi(b64, s.exportDPI);
                    folder.file(fname, b64, { base64: true });
                }
                exported++;
            } catch(e) { console.warn('Could not export', fname, e); }
        }

        if (exported === 0) {
            alert('No charts found to export. Run ANOVA Tests first.');
            return;
        }

        // README
        const readme = [
            'Publication Plots Export',
            '========================',
            `Plot type     : ${s.plotType}`,
            `Color scheme  : ${s.colorScheme}${s.unifyColor ? ' (unified single color)' : ''}`,
            `Target width  : ${widthMm} mm  (${targetWidthPx} px at ${s.exportDPI} dpi)`,
            `Aspect ratio  : ${s.aspectRatio.toFixed(3)} (w/h) — applied to on-screen size before capture`,
            `Format        : ${fmt.toUpperCase()}`,
            `Font          : ${s.fontFamily}, axis title ${s.axisTitleSize} pt`,
            `Y-axis        : ${s.yStartZero ? 'start at 0' : 'auto min'}, ${s.yHeadroom}% headroom`,
            `Gridlines     : Y=${s.showGridY ? 'on' : 'off'}  X=${s.showGridX ? 'on' : 'off'}  style=${s.gridStyle}`,
            `Tick marks    : ${s.tickPosition || 'none'}`,
            `Plot frame    : ${s.showPlotFrame ? 'yes' : 'no'}`,
            `Letters shown : ${s.showLetters}${s.showLetters ? `, offset ${s.letterOffset}%` : ''}`,
            '',
            `Total plots   : ${exported}`,
            `Exported      : ${new Date().toLocaleString()}`,
        ].join('\n');
        zip.file('README.txt', readme);

        const blob = await zip.generateAsync({ type: 'blob' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = 'Publication_Plots.zip';
        document.body.appendChild(a);
        a.click();
        URL.revokeObjectURL(url);
        document.body.removeChild(a);

    } catch(err) {
        alert('Export error: ' + err.message);
    } finally {
        btn.disabled = false;
        if (spinner) spinner.style.display = 'none';
    }
});

// Initialise publication plot settings UI on page load
initPubPlotSettingsUI();

// ═══════════════════════════════════════════════════════════════════════════
// CORRELATION ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

let corrAbortController = null;

// ── Plotly colorscale map ─────────────────────────────────────────────────
const CORR_COLORSCALES = {
    RdBu:    [[0,'#2166ac'],[0.25,'#92c5de'],[0.5,'#f7f7f7'],[0.75,'#f4a582'],[1,'#b2182b']],
    RdYlBu:  [[0,'#313695'],[0.25,'#74add1'],[0.5,'#ffffbf'],[0.75,'#f46d43'],[1,'#a50026']],
    coolwarm:[[0,'#3b4cc0'],[0.5,'#dddddd'],[1,'#b40426']],
    viridis: 'Viridis',
    plasma:  'Plasma',
    Greens:  'Greens',
};

// ── Read heatmap style options ────────────────────────────────────────────
function corrHeatmapReadOptions() {
    return {
        colorScheme:    document.getElementById('corrColorScheme').value,
        triangle:       document.getElementById('corrTriangle').value,
        cluster:        document.getElementById('corrCluster').checked,
        showDendrogram: document.getElementById('corrShowDendrogram').checked,
        cellSize:       parseInt(document.getElementById('corrCellSize').value) || 40,
        showValues:     document.getElementById('corrShowValues').checked,
        showStars:      document.getElementById('corrShowStars').checked,
        heatGridLines:  document.getElementById('corrHeatGridLines').checked,
        dendGridLines:  document.getElementById('corrDendGridLines').checked,
        maskInsig:      document.getElementById('corrMaskInsig').checked,
        pThresh:        parseFloat(document.getElementById('corrPThresh').value),
        maskStyle:      document.getElementById('corrMaskStyle').value,
        fontFamily:     document.getElementById('corrFontFamily').value,
        axisFontSize:   parseInt(document.getElementById('corrAxisFontSize').value),
        cellFontSize:   parseInt(document.getElementById('corrCellFontSize').value),
    };
}

function buildDendrogramTraces(icoord, dcoord, colorList, orientation) {
    const groups = {};
    icoord.forEach((ix, k) => {
        const col = colorList[k] || 'black';
        if (!groups[col]) groups[col] = { x: [], y: [] };
        for (let p = 0; p < 4; p++) {
            if (orientation === 'top') {
                groups[col].x.push(ix[p]); groups[col].y.push(dcoord[k][p]);
            } else {
                groups[col].x.push(dcoord[k][p]); groups[col].y.push(ix[p]);
            }
        }
        groups[col].x.push(null); groups[col].y.push(null);
    });
    return Object.entries(groups).map(([col, pts]) => ({
        type: 'scatter', mode: 'lines',
        x: pts.x, y: pts.y,
        line: { color: col, width: 1.5 },
        showlegend: false, hoverinfo: 'skip',
    }));
}

// ── Render heatmap ────────────────────────────────────────────────────────
function renderCorrHeatmap(result, opts) {
    const plotDiv = document.getElementById('corrHeatmapPlot');
    const dendDiv = document.getElementById('corrDendrogramPlot');
    const vars    = result.variables;
    const n       = vars.length;

    // Always hide the separate dendrogram div (combined into one figure now)
    if (dendDiv._fullLayout) Plotly.purge(dendDiv);
    dendDiv.style.display = 'none';

    // Determine display order
    const order = (opts.cluster && result.hclust_order && result.hclust_order.length === n)
        ? result.hclust_order
        : vars.map((_, i) => i);

    const orderedVars = order.map(i => vars[i]);

    // Build z and text grids in ordered space
    const z        = [];
    const textGrid = [];

    for (let ri = 0; ri < n; ri++) {
        const rowIdx = order[ri];
        const zRow   = [];
        const tRow   = [];
        for (let ci = 0; ci < n; ci++) {
            const colIdx = order[ci];
            const rVal = result.corr_matrix[rowIdx][colIdx];
            const pVal = result.pval_matrix[rowIdx][colIdx];

            if (opts.triangle === 'upper' && ri > ci) { zRow.push(null); tRow.push(''); continue; }
            if (opts.triangle === 'lower' && ri < ci) { zRow.push(null); tRow.push(''); continue; }

            if (opts.maskInsig && pVal !== null && pVal >= opts.pThresh && ri !== ci) {
                if (opts.maskStyle === 'blank') { zRow.push(null); tRow.push(''); continue; }
            }

            zRow.push(rVal !== null ? rVal : null);

            if (ri === ci) {
                tRow.push('');
            } else if (rVal === null || (!opts.showValues && !opts.showStars)) {
                tRow.push('');
            } else {
                let txt = opts.showValues ? rVal.toFixed(2) : '';
                if (opts.showStars && pVal !== null) {
                    const stars = pVal < 0.001 ? '***' : pVal < 0.01 ? '**' : pVal < 0.05 ? '*' : '';
                    if (stars) txt = txt ? txt + '<br>' + stars : stars;
                }
                if (opts.maskInsig && pVal !== null && pVal >= opts.pThresh && opts.maskStyle === 'cross') {
                    txt = '✕';
                }
                tRow.push(txt);
            }
        }
        z.push(zRow);
        textGrid.push(tRow);
    }

    const colorscale = CORR_COLORSCALES[opts.colorScheme] || CORR_COLORSCALES.RdBu;
    const titleText  = `${result.method.charAt(0).toUpperCase() + result.method.slice(1)} Correlation Matrix`;
    const useCombined = opts.showDendrogram && opts.cluster && result.hclust_dendrogram;

    // Show/clear clustering warning
    let clusterWarnEl = document.getElementById('corrClusterWarn');
    if (opts.showDendrogram && !result.hclust_dendrogram && result.hclust_error) {
        if (!clusterWarnEl) {
            clusterWarnEl = document.createElement('div');
            clusterWarnEl.id = 'corrClusterWarn';
            clusterWarnEl.className = 'alert alert-warning py-2 small mt-2';
            plotDiv.parentNode.insertBefore(clusterWarnEl, plotDiv);
        }
        clusterWarnEl.innerHTML =
            '<strong>Dendrogram could not be computed.</strong> ' +
            result.hclust_error +
            ' Please check that all selected variables are numeric and not constant.';
        clusterWarnEl.style.display = '';
    } else if (clusterWarnEl) {
        clusterWarnEl.style.display = 'none';
    }

    const margin      = { l: 120, r: 60, t: 40, b: 120 };
    const COLORBAR_PX = 80; // colorbar + gap

    // Use the user-specified cell size directly.
    // Both width and height are set from it so cells are exactly square.
    // The div's own width/height are also set so the background matches.
    const cellSizePx = opts.cellSize;
    const heatPx     = n * cellSizePx;
    const figW       = margin.l + heatPx + margin.r + COLORBAR_PX;

    plotDiv.style.display = 'block';
    plotDiv.style.width   = figW + 'px';
    document.getElementById('corrHeatmapPlaceholder').style.display = 'none';

    if (useCombined) {
        // ── Combined dendrogram + heatmap in one Plotly figure ────────────────
        const dend = result.hclust_dendrogram;

        const normIcoord = dend.icoord.map(arr => arr.map(v => v / 10 - 0.5));
        const dendTraces = buildDendrogramTraces(normIcoord, dend.dcoord, dend.color_list, 'top');
        // Dendrogram on yaxis2 (top); heatmap on yaxis (bottom). No gap — they share the boundary.
        // Dendrogram leaves (distance=0) sit at the bottom of yaxis2, touching the heatmap top edge.
        dendTraces.forEach(t => { t.xaxis = 'x'; t.yaxis = 'y2'; });

        const heatX      = orderedVars.map((_, i) => i);
        const customdata = z.map((row) => row.map((_, ci) => orderedVars[ci]));
        const heatFrac = 0.76;
        const dendFrac = 1.0 - heatFrac;   // 0.24 — no gap
        const heatTrace  = {
            type: 'heatmap',
            z, x: heatX, y: orderedVars, customdata,
            zmin: -1, zmax: 1, colorscale,
            text: textGrid, texttemplate: '%{text}',
            textfont: { family: opts.fontFamily, size: opts.cellFontSize, color: '#111' },
            hovertemplate: 'r = %{z:.3f}<extra>%{y} vs %{customdata}</extra>',
            showscale: true,
            colorbar: {
                title: { text: 'r', font: { family: opts.fontFamily, size: opts.axisFontSize } },
                tickfont: { family: opts.fontFamily, size: opts.axisFontSize - 1 },
                thickness: 14,
                len: heatFrac * 0.9,
                y: heatFrac / 2,      // middle of heatmap in paper coords
                yanchor: 'middle',
            },
            xaxis: 'x', yaxis: 'y',
        };

        const dendPx      = Math.round(heatPx * dendFrac / heatFrac);
        const totalHeight = heatPx + dendPx + margin.t + margin.b;
        plotDiv.style.height = totalHeight + 'px';

        const layout = {
            width: figW, height: totalHeight,
            xaxis: {
                range: [-0.5, n - 0.5],
                tickvals: heatX, ticktext: orderedVars,
                tickfont: { family: opts.fontFamily, size: opts.axisFontSize },
                tickangle: -45,
                showgrid: opts.heatGridLines, gridcolor: '#ccc', zeroline: false,
                // Anchors to yaxis (heatmap) by default → tick labels at bottom
            },
            yaxis: {
                domain: [0, heatFrac],     // heatmap: bottom portion
                tickfont: { family: opts.fontFamily, size: opts.axisFontSize },
                autorange: 'reversed',
                showgrid: opts.heatGridLines, gridcolor: '#ccc',
            },
            yaxis2: {
                domain: [heatFrac, 1.0],   // dendrogram: top portion, no gap
                tickfont: { family: opts.fontFamily, size: opts.axisFontSize - 2 },
                showgrid: opts.dendGridLines, gridcolor: '#eee', zeroline: false,
                title: { text: 'Distance', font: { family: opts.fontFamily, size: opts.axisFontSize - 1 } },
            },
            margin,
            plot_bgcolor: '#fff', paper_bgcolor: '#fff', showlegend: false,
            title: { text: titleText, font: { family: opts.fontFamily, size: opts.axisFontSize + 2 } },
        };

        Plotly.react(plotDiv, [...dendTraces, heatTrace], layout, {
            responsive: false, displayModeBar: true,
            modeBarButtonsToRemove: ['select2d', 'lasso2d'], displaylogo: false,
        });
    } else {
        // ── Standalone heatmap ────────────────────────────────────────────────
        const totalHeight = margin.t + heatPx + margin.b;
        plotDiv.style.height = totalHeight + 'px';

        const trace = {
            type: 'heatmap',
            z, x: orderedVars, y: orderedVars,
            zmin: -1, zmax: 1, colorscale,
            text: textGrid, texttemplate: '%{text}',
            textfont: { family: opts.fontFamily, size: opts.cellFontSize, color: '#111' },
            hovertemplate: 'r = %{z:.3f}<extra>%{y} vs %{x}</extra>',
            showscale: true,
            colorbar: {
                title: { text: 'r', font: { family: opts.fontFamily, size: opts.axisFontSize } },
                tickfont: { family: opts.fontFamily, size: opts.axisFontSize - 1 },
                thickness: 14, len: 0.8,
            },
        };

        const layout = {
            width: figW, height: totalHeight,
            xaxis: {
                tickfont: { family: opts.fontFamily, size: opts.axisFontSize },
                tickangle: -45, side: 'bottom',
                showgrid: opts.heatGridLines, gridcolor: '#ccc',
            },
            yaxis: {
                tickfont: { family: opts.fontFamily, size: opts.axisFontSize },
                autorange: 'reversed',
                showgrid: opts.heatGridLines, gridcolor: '#ccc',
            },
            margin,
            plot_bgcolor: '#fff', paper_bgcolor: '#fff',
            title: { text: titleText, font: { family: opts.fontFamily, size: opts.axisFontSize + 2 } },
        };

        Plotly.react(plotDiv, [trace], layout, {
            responsive: false, displayModeBar: true,
            modeBarButtonsToRemove: ['select2d', 'lasso2d'], displaylogo: false,
        });
    }
}


// ── Run Correlation button ────────────────────────────────────────────────
document.getElementById('runCorrBtn').addEventListener('click', function () {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);

    if (selectedVars.length < 2) {
        return alert('Correlation requires at least 2 variables. Please select variables in the Data Input panel.');
    }

    const method = document.querySelector('.corr-method-btn.active')?.dataset.method || 'pearson';

    const spinner    = document.getElementById('corrSpinner');
    const statusMsg  = document.getElementById('corrStatusMsg');
    const heatStyle  = document.getElementById('corrHeatmapStyleCard');
    const dlHeat     = document.getElementById('corrDownloadHeatmapBtn');
    const header     = document.getElementById('corrResultsHeader');

    statusMsg.innerHTML = '';
    spinner.style.display = 'block';
    document.getElementById('stopCorrBtn').style.display = 'inline-block';
    header.style.display = 'none';

    // Hide previous results so stale content is not shown during a new run
    document.getElementById('corrSubTabs').style.display         = 'none';
    document.getElementById('corrSubTabContent').style.display   = 'none';
    heatStyle.style.display = 'none';
    dlHeat.style.display    = 'none';
    const _step4Panel = document.getElementById('pipelineStep4');
    if (_step4Panel) { _step4Panel.style.display = 'none'; _step4Panel.classList.add('pipeline-locked'); }
    const _step4Bar = document.getElementById('step4ActionBar');
    if (_step4Bar) _step4Bar.style.cssText = 'display:none!important;';
    const _toStep4 = document.getElementById('toStep4Btn');
    if (_toStep4) _toStep4.classList.add('d-none');
    lastCorrResults = null;
    excludedVarsFromCorr.clear();

    if (corrAbortController) corrAbortController.abort();
    corrAbortController = new AbortController();

    // Apply NZV filter and normalization transform before sending
    const filteredVars = filterNearZeroVariance(selectedVars, globalData, nzvThreshold);
    const transformedData = usePerVarMode
        ? applyPerVarNorm(globalData, filteredVars, perVarTransforms, currentNormTransform)
        : applyColumnNorm(globalData, filteredVars, currentNormTransform);

    if (filteredVars.length < 2) {
        spinner.style.display = 'none';
        document.getElementById('stopCorrBtn').style.display = 'none';
        statusMsg.innerHTML = '<div class="alert alert-warning">Near-zero variance filter removed too many variables — fewer than 2 remain. Lower the CV threshold.</div>';
        return;
    }

    fetch('/run-correlation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: transformedData,
            variables: filteredVars,
            method,
            min_row_coverage: _getMinRowCoverage(),
        }),
        signal: corrAbortController.signal,
    })
    .then(res => res.json())
    .then(result => {
        spinner.style.display = 'none';
        document.getElementById('stopCorrBtn').style.display = 'none';
        if (result.error) throw new Error(result.error);

        lastCorrResults = result;
        header.style.display = 'flex';

        // Show success message
        const corrSparseNote = (result.rows_sparse_dropped || 0) > 0
            ? ` <span style="color:#1a5c1a; font-weight:600;">${result.rows_sparse_dropped} sample${result.rows_sparse_dropped > 1 ? 's' : ''} excluded (coverage &lt; ${_getMinRowCoverage()}%).</span>` : '';
        statusMsg.innerHTML = `
            <div class="alert alert-success py-2 small shadow-sm mb-3">
                <strong>Correlation complete:</strong>
                ${result.variables.length} variables &times; ${result.variables.length} —
                method: <strong>${result.method.charAt(0).toUpperCase() + result.method.slice(1)}</strong>.${corrSparseNote}
            </div>`;

        // Show sub-tabs and content panel
        document.getElementById('corrSubTabs').style.display = '';
        document.getElementById('corrSubTabContent').style.display = '';

        // Show heatmap style card and download button
        heatStyle.style.display = 'block';
        dlHeat.style.display    = 'inline-block';

        // Auto-size cell size, axis labels, and cell text based on container width and n
        const _heatDiv  = document.getElementById('corrHeatmapPlot');
        const _n        = result.variables.length;
        // Use parent container width — the plot div may already be shrunken from a prior render
        const _contW    = (_heatDiv.parentElement || _heatDiv).offsetWidth || 700;
        const _avail    = Math.max(_n, _contW - 120 - 60 - 80);
        const _cellSize = Math.max(1, Math.floor(_avail / _n));
        document.getElementById('corrCellSize').value     = _cellSize;
        document.getElementById('corrAxisFontSize').value = Math.max(6, Math.min(14, Math.floor(_cellSize * 0.6)));
        document.getElementById('corrCellFontSize').value = Math.max(5, Math.min(12, Math.floor(_cellSize * 0.45)));

        renderCorrHeatmap(result, corrHeatmapReadOptions());
    })
    .catch(err => {
        if (err.name === 'AbortError') return;
        spinner.style.display = 'none';
        document.getElementById('stopCorrBtn').style.display = 'none';
        statusMsg.innerHTML = `<div class="alert alert-danger py-2 small">${err.message}</div>`;
    });
});


// ── Stop button ───────────────────────────────────────────────────────────
document.getElementById('stopCorrBtn').addEventListener('click', function () {
    if (corrAbortController) { corrAbortController.abort(); corrAbortController = null; }
    document.getElementById('corrSpinner').style.display = 'none';
    this.style.display = 'none';
});

// ── Method toggle ─────────────────────────────────────────────────────────
document.querySelectorAll('.corr-method-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.corr-method-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        _updateCorrStepper();
    });
});
document.getElementById('corrPThresh')?.addEventListener('change', _updateCorrStepper);

// ── Reset heatmap style to defaults ──────────────────────────────────────
document.getElementById('corrResetStyleBtn').addEventListener('click', function () {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const chk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };

    set('corrColorScheme',  'RdBu');
    set('corrTriangle',     'full');
    chk('corrCluster',      true);
    chk('corrShowDendrogram', false);
    chk('corrShowValues',   false);
    chk('corrShowStars',    true);
    chk('corrHeatGridLines', false);
    chk('corrDendGridLines', true);
    chk('corrMaskInsig',    false);
    set('corrPThresh',      '0.05');
    set('corrMaskStyle',    'blank');
    set('corrFontFamily',   'Arial');

    // Re-derive cell/font sizes from data if available, otherwise use static defaults
    if (lastCorrResults) {
        const _n       = lastCorrResults.variables.length;
        const _heatDiv = document.getElementById('corrHeatmapPlot');
        // Use the parent container width — the plot div itself may already be shrunken
        const _contW   = (_heatDiv.parentElement || _heatDiv).offsetWidth || 700;
        const _avail   = Math.max(_n, _contW - 120 - 60 - 80);
        const _cell    = Math.max(1, Math.floor(_avail / _n * 0.75));
        set('corrCellSize',     _cell);
        set('corrAxisFontSize', Math.max(6, Math.min(14, Math.floor(_cell * 0.6))));
        set('corrCellFontSize', Math.max(5, Math.min(12, Math.floor(_cell * 0.45))));
        renderCorrHeatmap(lastCorrResults, corrHeatmapReadOptions());
    } else {
        set('corrCellSize',     '40');
        set('corrAxisFontSize', '12');
        set('corrCellFontSize', '10');
    }

    // Re-enable dendrogram toggle in case it was disabled
    const dendEl = document.getElementById('corrShowDendrogram');
    if (dendEl) dendEl.disabled = false;
});

// ── Live re-render on heatmap style changes ───────────────────────────────
['corrColorScheme','corrTriangle','corrCluster','corrShowDendrogram','corrCellSize',
 'corrShowValues','corrShowStars','corrHeatGridLines','corrDendGridLines',
 'corrMaskInsig','corrPThresh','corrMaskStyle',
 'corrFontFamily','corrAxisFontSize','corrCellFontSize'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const handler = () => {
        if (lastCorrResults) renderCorrHeatmap(lastCorrResults, corrHeatmapReadOptions());
        // Keep overlay and cluster sub-heatmaps in sync with color scheme
        if (id === 'corrColorScheme') {
            _renderCorrelationOverlay(_currentOverlayMode);
            _clusterData.forEach((comp, ci) => {
                const div = document.getElementById(`clusterHeatmap_${ci}`);
                if (div && div.offsetWidth > 0 && lastCorrResults) {
                    _renderClusterSubHeatmap(`clusterHeatmap_${ci}`, comp,
                        lastCorrResults.corr_matrix, lastCorrResults.variables);
                }
            });
        }
    };
    el.addEventListener('change', handler);
    el.addEventListener('input',  handler);
});
// Disable dendrogram toggle when clustering is off
document.getElementById('corrCluster').addEventListener('change', function () {
    const dendEl = document.getElementById('corrShowDendrogram');
    if (!this.checked) { dendEl.checked = false; dendEl.disabled = true; }
    else { dendEl.disabled = false; }
});


// ── Download individual plots ─────────────────────────────────────────────
document.getElementById('corrDownloadHeatmapBtn').addEventListener('click', function () {
    const plotDiv = document.getElementById('corrHeatmapPlot');
    const fmt   = document.getElementById('corrExportFormat').value;
    const scale = parseInt(document.getElementById('corrExportScale').value);
    Plotly.downloadImage(plotDiv, {
        format: fmt, filename: 'Correlation_Heatmap', scale,
        width: plotDiv.offsetWidth || 800, height: plotDiv.offsetHeight || 700,
    });
});

// ── Export Excel ──────────────────────────────────────────────────────────
document.getElementById('downloadCorrExcelBtn').addEventListener('click', async function () {
    if (!lastCorrResults) return;

    const btn     = this;
    const spinner = document.getElementById('corrExportSpinner');
    btn.disabled  = true;
    if (spinner) spinner.style.display = 'inline-flex';

    try {
        const heatDiv   = document.getElementById('corrHeatmapPlot');
        const scale     = parseInt(document.getElementById('corrExportScale').value);

        let heatmapImg = null;
        try {
            const url = await Plotly.toImage(heatDiv,
                { format: 'png', scale, width: heatDiv.offsetWidth || 800, height: heatDiv.offsetHeight || 700 });
            heatmapImg = url.split(',')[1];
        } catch(e) { /* heatmap not rendered */ }

        const res = await fetch('/export-correlation-excel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                variables:   lastCorrResults.variables,
                method:      lastCorrResults.method,
                corr_matrix: lastCorrResults.corr_matrix,
                pval_matrix: lastCorrResults.pval_matrix,
                n_pairs:     lastCorrResults.n_pairs,
                heatmap_img: heatmapImg,
            }),
        });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url  = window.URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = 'Correlation_Analysis.xlsx';
        document.body.appendChild(a); a.click();
        window.URL.revokeObjectURL(url); document.body.removeChild(a);
    } catch(err) {
        alert('Export Error: ' + err.message);
    } finally {
        btn.disabled = false;
        if (spinner) spinner.style.display = 'none';
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. OPLS / OPLS-DA Analysis
// ═══════════════════════════════════════════════════════════════════════════════

let lastOplsResult = null;
let oplsAbortController = null;
let lastPlsResult = null;
let plsAbortController = null;

function oplsReadOpts() {
    return {
        palette:    document.querySelector('.opls-palette-btn.active')?.dataset.palette || 'tab10',
        pointSize:  parseInt(document.getElementById('oplsPointSize').value) || 10,
        opacity:    parseInt(document.getElementById('oplsOpacity').value) / 100,
        fontFamily: document.getElementById('oplsFontFamily').value,
        fontSize:   parseInt(document.getElementById('oplsFontSize').value) || 13,
    };
}

function oplsGetMethod() {
    return document.querySelector('.opls-method-btn.active')?.dataset.method || 'opls-da';
}

// ── Score plot: T (predictive) vs T_ortho (orthogonal) ───────────────────────
function renderOplsScores(result, opts) {
    const div = document.getElementById('oplsScorePlot');
    div.style.display = 'block';
    const colors = PCA_PALETTES[opts.palette] || PCA_PALETTES.tab10;
    const groups = [...new Set(result.scores.map(s => s.group))];
    const traces = groups.map((g, gi) => {
        const pts = result.scores.filter(s => s.group === g);
        return {
            type: 'scatter', mode: 'markers+text',
            name: g,
            x: pts.map(p => p.T), y: pts.map(p => p.T_ortho),
            text: pts.map(p => p.label), textposition: 'top center',
            textfont: { size: opts.fontSize * 0.72, family: opts.fontFamily },
            marker: {
                color: colors[gi % colors.length], size: opts.pointSize,
                opacity: opts.opacity, line: { width: 0.5, color: 'white' }
            },
            hovertemplate: '<b>%{text}</b><br>T: %{x:.3f}<br>T_orth: %{y:.3f}<extra>' + g + '</extra>',
        };
    });
    // Zero lines
    traces.push({type:'scatter',mode:'lines',x:[null],y:[null],showlegend:false,hoverinfo:'skip'});
    const method = result.method === 'opls-da' ? 'OPLS-DA' : 'OPLS';
    const layout = {
        title: { text: `${method} Score Plot — Y: ${result.y_col}`, font: { family: opts.fontFamily, size: opts.fontSize + 2 } },
        xaxis: { title: { text: 'T (predictive)', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#aaa', zerolinewidth: 1 },
        yaxis: { title: { text: 'T_orth (orthogonal)', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#aaa', zerolinewidth: 1 },
        legend: { font: { family: opts.fontFamily, size: opts.fontSize - 1 } },
        plot_bgcolor: '#fafafa', paper_bgcolor: 'white',
        margin: { l: 60, r: 30, t: 60, b: 60 },
    };
    Plotly.react(div, traces, layout, { responsive: true });
}

// ── S-plot: covariance vs correlation with T_pred ────────────────────────────
function renderOplsSplot(result, opts) {
    const div = document.getElementById('oplsSplot');
    div.style.display = 'block';
    const pts = result.splot;
    const vipVals = pts.map(p => p.vip);
    const maxVip = Math.max(...vipVals, 1);
    // Color by VIP: high VIP → dark blue/red, low → grey
    const markerColors = pts.map(p => {
        const v = p.vip || 0;
        if (v >= 1.5) return '#c0392b';
        if (v >= 1.0) return '#e67e22';
        return '#95a5a6';
    });
    const trace = {
        type: 'scatter', mode: 'markers+text',
        x: pts.map(p => p.cov), y: pts.map(p => p.corr),
        text: pts.map(p => p.var),
        textposition: pts.map((p, i) => p.corr >= 0 ? 'top center' : 'bottom center'),
        textfont: { size: opts.fontSize * 0.72, family: opts.fontFamily, color: '#333' },
        marker: { color: markerColors, size: opts.pointSize, opacity: opts.opacity,
                  line: { width: 0.5, color: 'white' } },
        customdata: pts.map(p => p.vip),
        hovertemplate: '<b>%{text}</b><br>p (cov): %{x:.4f}<br>p_corr: %{y:.4f}<br>VIP: %{customdata:.3f}<extra></extra>',
        showlegend: false,
    };
    // VIP=1 reference ellipse hint via annotation is complex; add a legend proxy trace
    const legendTraces = [
        { type: 'scatter', mode: 'markers', name: 'VIP ≥ 1.5',
          x: [null], y: [null], marker: { color: '#c0392b', size: 10 }, showlegend: true },
        { type: 'scatter', mode: 'markers', name: '1.0 ≤ VIP < 1.5',
          x: [null], y: [null], marker: { color: '#e67e22', size: 10 }, showlegend: true },
        { type: 'scatter', mode: 'markers', name: 'VIP < 1.0',
          x: [null], y: [null], marker: { color: '#95a5a6', size: 10 }, showlegend: true },
    ];
    const method = result.method === 'opls-da' ? 'OPLS-DA' : 'OPLS';
    const layout = {
        title: { text: `${method} S-plot`, font: { family: opts.fontFamily, size: opts.fontSize + 2 } },
        xaxis: { title: { text: 'p (covariance with T)', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#ccc', zerolinewidth: 1 },
        yaxis: { title: { text: 'p* (correlation with T)', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#ccc', zerolinewidth: 1, range: [-1.1, 1.1] },
        legend: { font: { family: opts.fontFamily, size: opts.fontSize - 1 } },
        plot_bgcolor: '#fafafa', paper_bgcolor: 'white',
        margin: { l: 60, r: 30, t: 60, b: 60 },
    };
    Plotly.react(div, [trace, ...legendTraces], layout, { responsive: true });
}

// ── VIP bar chart ─────────────────────────────────────────────────────────────
function renderOplsVip(result, opts) {
    const div = document.getElementById('oplsVipPlot');
    div.style.display = 'block';
    const vip = result.vip;  // already sorted descending
    const barColors = vip.map(v => v.vip >= 1.0 ? '#2980b9' : '#bdc3c7');
    const trace = {
        type: 'bar', orientation: 'h',
        x: vip.map(v => v.vip), y: vip.map(v => v.var),
        marker: { color: barColors },
        hovertemplate: '<b>%{y}</b><br>VIP: %{x:.3f}<extra></extra>',
        showlegend: false,
    };
    const method = result.method === 'opls-da' ? 'OPLS-DA' : 'OPLS';
    const layout = {
        title: { text: `${method} VIP Scores`, font: { family: opts.fontFamily, size: opts.fontSize + 2 } },
        xaxis: { title: { text: 'VIP Score', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 } },
        yaxis: { tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 }, autorange: 'reversed' },
        shapes: [{ type: 'line', x0: 1, x1: 1, y0: -0.5, y1: vip.length - 0.5,
                   line: { color: '#e74c3c', width: 1.5, dash: 'dash' } }],
        annotations: [{ x: 1.02, y: 0, xanchor: 'left', yanchor: 'top', xref: 'x', yref: 'paper',
                        text: 'VIP=1', font: { color: '#e74c3c', size: opts.fontSize - 1 }, showarrow: false }],
        plot_bgcolor: '#fafafa', paper_bgcolor: 'white',
        margin: { l: Math.max(80, Math.max(...vip.map(v => v.var.length)) * 6), r: 30, t: 60, b: 50 },
        height: Math.max(300, vip.length * 26 + 80),
    };
    Plotly.react(div, [trace], layout, { responsive: true });
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.querySelectorAll('.opls-method-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.opls-method-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        _updateOplsStepper();
    });
});
document.getElementById('oplsYCol')?.addEventListener('change', () => { _updateOplsStepper(); _renderOplsMissingData(); });
document.getElementById('oplsNOrtho')?.addEventListener('input', _updateOplsStepper);

document.getElementById('runOplsBtn').addEventListener('click', function () {
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    if (vars.length < 2) return alert('Select at least 2 variables in the Data Input panel.');
    const yCol = document.getElementById('oplsYCol').value;
    if (!yCol) return alert('Please select a response variable (Y).');

    const method = oplsGetMethod();
    const nOrtho = parseInt(document.getElementById('oplsNOrtho').value) || 1;
    const computeCV = document.getElementById('oplsComputeCV').checked;

    document.getElementById('oplsStatusMsg').innerHTML = '';
    document.getElementById('oplsSpinner').style.display = 'block';
    document.getElementById('stopOplsBtn').style.display = 'inline-block';
    document.getElementById('runOplsBtn').disabled = true;

    oplsAbortController = new AbortController();
    fetch('/run-opls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: oplsAbortController.signal,
        body: JSON.stringify({
            data: globalData, variables: vars, factors: selectedFactors,
            method, y_col: yCol, n_ortho: nOrtho, compute_cv: computeCV,
        })
    })
    .then(r => r.json())
    .then(result => {
        document.getElementById('oplsSpinner').style.display = 'none';
        document.getElementById('stopOplsBtn').style.display = 'none';
        document.getElementById('runOplsBtn').disabled = false;
        if (result.error) {
            document.getElementById('oplsStatusMsg').innerHTML =
                `<div class="alert alert-danger py-2 small shadow-sm mb-2">${result.error}</div>`;
            return;
        }
        lastOplsResult = result;
        _updateOplsStepper();
        const opts = oplsReadOpts();
        const methodStr = result.method === 'opls-da' ? 'OPLS-DA' : 'OPLS';

        // Show metrics
        document.getElementById('oplsMetrics').style.display = 'block';
        document.getElementById('oplsR2X').textContent = (result.r2x * 100).toFixed(1) + '%';
        document.getElementById('oplsR2Y').textContent = (result.r2y * 100).toFixed(1) + '%';
        document.getElementById('oplsQ2').textContent  = result.q2 !== null ? (result.q2 * 100).toFixed(1) + '%' : 'N/A';
        document.getElementById('oplsNSamplesMsg').textContent = `n=${result.n_samples}, ${result.n_ortho} orthogonal component(s)`;

        document.getElementById('oplsStatusMsg').innerHTML =
            `<div class="alert alert-success py-2 small shadow-sm mb-2">
                <strong>${methodStr} complete:</strong> ${result.n_samples} samples, ${vars.length} variables.
                R²X=${(result.r2x*100).toFixed(1)}%, R²Y=${(result.r2y*100).toFixed(1)}%${result.q2!==null?`, Q²=${(result.q2*100).toFixed(1)}%`:''}.</div>`;

        document.getElementById('oplsStyleCard').style.display = 'block';
        document.getElementById('oplsDownloadRow').style.display = 'block';
        document.getElementById('downloadOplsBtn').style.display = 'inline-block';

        renderOplsScores(result, opts);
        renderOplsSplot(result, opts);
        renderOplsVip(result, opts);
    })
    .catch(err => {
        if (err.name === 'AbortError') return;
        document.getElementById('oplsSpinner').style.display = 'none';
        document.getElementById('stopOplsBtn').style.display = 'none';
        document.getElementById('runOplsBtn').disabled = false;
        document.getElementById('oplsStatusMsg').innerHTML =
            `<div class="alert alert-danger py-2 small shadow-sm mb-2">OPLS Error: ${err.message}</div>`;
    });
});

document.getElementById('stopOplsBtn').addEventListener('click', function () {
    if (oplsAbortController) oplsAbortController.abort();
    document.getElementById('oplsSpinner').style.display = 'none';
    document.getElementById('runOplsBtn').disabled = false;
    this.style.display = 'none';
});

// ── Style live re-renders ─────────────────────────────────────────────────────
document.querySelectorAll('.opls-palette-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.opls-palette-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        if (lastOplsResult) { const o=oplsReadOpts(); renderOplsScores(lastOplsResult,o); renderOplsSplot(lastOplsResult,o); }
    });
});
['oplsPointSize','oplsOpacity'].forEach(id => {
    const el = document.getElementById(id);
    ['change','input'].forEach(ev => el.addEventListener(ev, function () {
        if (id==='oplsOpacity') document.getElementById('oplsOpacityVal').textContent = this.value + '%';
        if (id==='oplsPointSize') document.getElementById('oplsPointSizeVal').textContent = this.value;
        if (lastOplsResult) { const o=oplsReadOpts(); renderOplsScores(lastOplsResult,o); renderOplsSplot(lastOplsResult,o); }
    }));
});
['oplsFontFamily','oplsFontSize'].forEach(id => {
    const el = document.getElementById(id);
    ['change','input'].forEach(ev => el.addEventListener(ev, function () {
        if (id==='oplsFontSize') document.getElementById('oplsFontSizeVal').textContent = this.value;
        if (lastOplsResult) { const o=oplsReadOpts(); renderOplsScores(lastOplsResult,o); renderOplsSplot(lastOplsResult,o); renderOplsVip(lastOplsResult,o); }
    }));
});

// ── PNG download buttons ──────────────────────────────────────────────────────
document.getElementById('oplsDownloadScoreBtn').addEventListener('click', () => {
    const div = document.getElementById('oplsScorePlot'); const sc=parseInt(document.getElementById('oplsExportScale').value);
    Plotly.downloadImage(div,{format:'png',filename:'OPLS_Score_Plot',scale:sc,width:div.offsetWidth||700,height:div.offsetHeight||500});
});
document.getElementById('oplsDownloadSplotBtn').addEventListener('click', () => {
    const div = document.getElementById('oplsSplot'); const sc=parseInt(document.getElementById('oplsExportScale').value);
    Plotly.downloadImage(div,{format:'png',filename:'OPLS_S_Plot',scale:sc,width:div.offsetWidth||700,height:div.offsetHeight||500});
});
document.getElementById('oplsDownloadVipBtn').addEventListener('click', () => {
    const div = document.getElementById('oplsVipPlot'); const sc=parseInt(document.getElementById('oplsExportScale').value);
    Plotly.downloadImage(div,{format:'png',filename:'OPLS_VIP_Plot',scale:sc,width:div.offsetWidth||700,height:div.offsetHeight||400});
});

// ── ZIP export (client-side) ──────────────────────────────────────────────────
async function _exportOplsReport() {
    if (!lastOplsResult) return alert('Run OPLS first before exporting.');
    const r = lastOplsResult;
    const btn = document.getElementById('downloadOplsBtn');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i> Building…';
    const spinner = document.getElementById('oplsExportSpinner');
    if (spinner) spinner.style.display = 'inline-block';
    try {
        const wb = XLSX.utils.book_new();
        const addSheet = (name, rows) =>
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
        const pct = v => v != null ? parseFloat((v * 100).toFixed(4)) : null;
        const methodStr = r.method === 'opls-da' ? 'OPLS-DA' : 'OPLS';

        // Sheet 1: Parameters
        addSheet('Parameters', [
            ['Parameter', 'Value'],
            ['Method', methodStr],
            ['Response variable (Y)', r.y_col || ''],
            ['Orthogonal components', r.n_ortho || ''],
            ['Samples', r.n_samples || ''],
            ['Variables used', r.vars_used ? r.vars_used.length : ''],
            ['Variable list', r.vars_used ? r.vars_used.join(', ') : ''],
            ['R²X (%)', pct(r.r2x)],
            ['R²Y (%)', pct(r.r2y)],
            ['Q² (%)', pct(r.q2)],
            ['Export date', new Date().toLocaleDateString('en-GB')],
        ]);

        // Sheet 2: Scores
        const scoreRows = [['Sample', 'Group', 'T (predictive)', 'T_orth (orthogonal)']];
        (r.scores || []).forEach(s => scoreRows.push([s.label, s.group, s.T, s.T_ortho]));
        addSheet('OPLS Scores', scoreRows);

        // Sheet 3: S-plot data
        const splotRows = [['Variable', 'Covariance (p)', 'Correlation (p_corr)', 'VIP']];
        (r.splot || []).forEach(s => splotRows.push([s.var, s.cov, s.corr, s.vip]));
        addSheet('S-plot Data', splotRows);

        // Sheet 4: VIP scores
        const vipRows = [['Variable', 'VIP Score', 'VIP \u2265 1.0']];
        (r.vip || []).forEach(v => vipRows.push([v.var, v.vip, v.vip >= 1.0 ? 'Yes' : 'No']));
        addSheet('VIP Scores', vipRows);

        // Capture plots
        const sc = parseInt(document.getElementById('oplsExportScale')?.value) || 2;
        const toImg = async (id, w, h) => {
            const d = document.getElementById(id);
            if (!d || d.style.display === 'none') return null;
            const b64 = await Plotly.toImage(d, { format: 'png', scale: sc, width: w || d.offsetWidth || 700, height: h || d.offsetHeight || 500 });
            return b64.split(',')[1];
        };
        const [scoreImg, splotImg, vipImg] = await Promise.all([
            toImg('oplsScorePlot', 700, 500),
            toImg('oplsSplot', 700, 500),
            toImg('oplsVipPlot', 700, Math.max(350, (r.vip || []).length * 26 + 80)),
        ]);

        // Bundle ZIP
        const zip = new JSZip();
        zip.file('OPLS_Analysis.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
        if (scoreImg) zip.file('OPLS_Score_Plot.png', scoreImg, { base64: true });
        if (splotImg) zip.file('OPLS_S-plot.png',    splotImg, { base64: true });
        if (vipImg)   zip.file('OPLS_VIP_Plot.png',  vipImg,   { base64: true });
        zip.file('Methods_section.html', _buildMethodsHTML());

        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url; a.download = 'OPLS_Report.zip';
        document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); document.body.removeChild(a);
    } catch (err) {
        alert('Export error: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        if (spinner) spinner.style.display = 'none';
    }
}
document.getElementById('downloadOplsBtn').addEventListener('click', () =>
    _exportOplsReport().catch(err => alert('Export error: ' + err.message)));
// ═══════════════════════════════════════════════════════════════════════════════
// 9. PLS / PLS-DA Analysis
// ═══════════════════════════════════════════════════════════════════════════════

function plsReadOpts() {
    return {
        palette:    document.querySelector('.pls-palette-btn.active')?.dataset.palette || 'tab10',
        pointSize:  parseInt(document.getElementById('plsPointSize').value) || 10,
        opacity:    parseInt(document.getElementById('plsOpacity').value) / 100,
        fontFamily: document.getElementById('plsFontFamily').value,
        fontSize:   parseInt(document.getElementById('plsFontSize').value) || 13,
    };
}

function plsGetMethod() {
    return document.querySelector('.pls-method-btn.active')?.dataset.method || 'pls-da';
}

// ── Score plot: T1 (LV1) vs T2 (LV2) ────────────────────────────────────────
function renderPlsScores(result, opts) {
    const div = document.getElementById('plsScorePlot');
    div.style.display = 'block';
    const colors = PCA_PALETTES[opts.palette] || PCA_PALETTES.tab10;
    const groups = [...new Set(result.scores.map(s => s.group))];
    const r2xC = result.r2x_per_comp || [];
    const lv1Label = r2xC[0] != null ? `LV1 (R²X: ${(r2xC[0]*100).toFixed(1)}%)` : 'LV1';
    const lv2Label = r2xC[1] != null ? `LV2 (R²X: ${((r2xC[1]-(r2xC[0]||0))*100).toFixed(1)}%)` : 'LV2';
    const traces = groups.map((g, gi) => {
        const pts = result.scores.filter(s => s.group === g);
        return {
            type: 'scatter', mode: 'markers+text',
            name: g,
            x: pts.map(p => p.T1), y: pts.map(p => p.T2),
            text: pts.map(p => p.label), textposition: 'top center',
            textfont: { size: opts.fontSize * 0.72, family: opts.fontFamily },
            marker: { color: colors[gi % colors.length], size: opts.pointSize,
                      opacity: opts.opacity, line: { width: 0.5, color: 'white' } },
            hovertemplate: '<b>%{text}</b><br>LV1: %{x:.3f}<br>LV2: %{y:.3f}<extra>' + g + '</extra>',
        };
    });
    const methodStr = result.method === 'pls-da' ? 'PLS-DA' : 'PLS';
    const layout = {
        title: { text: `${methodStr} Score Plot — Y: ${result.y_col}`, font: { family: opts.fontFamily, size: opts.fontSize + 2 } },
        xaxis: { title: { text: lv1Label, font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#aaa', zerolinewidth: 1 },
        yaxis: { title: { text: lv2Label, font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#aaa', zerolinewidth: 1 },
        legend: { font: { family: opts.fontFamily, size: opts.fontSize - 1 } },
        plot_bgcolor: '#fafafa', paper_bgcolor: 'white',
        margin: { l: 60, r: 30, t: 60, b: 60 },
    };
    Plotly.react(div, traces, layout, { responsive: true });
}

// ── Weights biplot: variable arrows in W1/W2 space ───────────────────────────
function renderPlsWeights(result, opts) {
    const div = document.getElementById('plsWeightsPlot');
    div.style.display = 'block';
    const pts = result.weights;
    const annotations = [];
    const arrowX = [], arrowY = [], arrowText = [], arrowVip = [];
    pts.forEach(w => {
        const wx = w.W1 ?? 0, wy = w.W2 ?? 0;
        if (wx === 0 && wy === 0) return;
        const vip = w.vip || 0;
        const arrowColor = vip >= 1.5 ? '#c0392b' : vip >= 1.0 ? '#e67e22' : '#7f8c8d';
        annotations.push({
            x: wx, y: wy, ax: 0, ay: 0,
            xref: 'x', yref: 'y', axref: 'x', ayref: 'y',
            showarrow: true, arrowhead: 3, arrowsize: 1.2,
            arrowwidth: 1.8, arrowcolor: arrowColor,
        });
        annotations.push({
            x: wx * 1.18, y: wy * 1.18,
            text: `<b>${w.var}</b>`,
            showarrow: false, xref: 'x', yref: 'y',
            font: { color: arrowColor, size: opts.fontSize * 0.85 },
            bgcolor: 'rgba(255,255,255,0.75)', borderpad: 2,
        });
        arrowX.push(wx); arrowY.push(wy);
        arrowText.push(w.var); arrowVip.push(vip);
    });
    // Invisible scatter for hover
    const hoverTrace = {
        x: arrowX, y: arrowY, text: arrowText, customdata: arrowVip,
        mode: 'markers', marker: { opacity: 0, size: 10 },
        hovertemplate: '<b>%{text}</b><br>W1: %{x:.4f}<br>W2: %{y:.4f}<br>VIP: %{customdata:.3f}<extra></extra>',
        showlegend: false,
    };
    // Legend proxies for VIP colour scale
    const legendTraces = [
        { type:'scatter', mode:'markers', name:'VIP ≥ 1.5', x:[null], y:[null], marker:{color:'#c0392b',size:10}, showlegend:true },
        { type:'scatter', mode:'markers', name:'1.0 ≤ VIP < 1.5', x:[null], y:[null], marker:{color:'#e67e22',size:10}, showlegend:true },
        { type:'scatter', mode:'markers', name:'VIP < 1.0', x:[null], y:[null], marker:{color:'#7f8c8d',size:10}, showlegend:true },
    ];
    const axMax = Math.max(...arrowX.map(Math.abs), ...arrowY.map(Math.abs), 0.01) * 1.4;
    const methodStr = result.method === 'pls-da' ? 'PLS-DA' : 'PLS';
    const layout = {
        title: { text: `${methodStr} Weights Plot (W1 vs W2)`, font: { family: opts.fontFamily, size: opts.fontSize + 2 } },
        xaxis: { title: { text: 'W1 (LV1 weight)', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#ccc', zerolinewidth: 1, range: [-axMax, axMax] },
        yaxis: { title: { text: 'W2 (LV2 weight)', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 },
                 zeroline: true, zerolinecolor: '#ccc', zerolinewidth: 1, range: [-axMax, axMax] },
        annotations,
        legend: { font: { family: opts.fontFamily, size: opts.fontSize - 1 } },
        plot_bgcolor: '#fafafa', paper_bgcolor: 'white',
        margin: { l: 60, r: 30, t: 60, b: 60 },
    };
    Plotly.react(div, [hoverTrace, ...legendTraces], layout, { responsive: true });
}

// ── VIP bar chart ─────────────────────────────────────────────────────────────
function renderPlsVip(result, opts) {
    const div = document.getElementById('plsVipPlot');
    div.style.display = 'block';
    const vip = result.vip;
    const barColors = vip.map(v => v.vip >= 1.0 ? '#2980b9' : '#bdc3c7');
    const trace = {
        type: 'bar', orientation: 'h',
        x: vip.map(v => v.vip), y: vip.map(v => v.var),
        marker: { color: barColors },
        hovertemplate: '<b>%{y}</b><br>VIP: %{x:.3f}<extra></extra>',
        showlegend: false,
    };
    const methodStr = result.method === 'pls-da' ? 'PLS-DA' : 'PLS';
    const layout = {
        title: { text: `${methodStr} VIP Scores`, font: { family: opts.fontFamily, size: opts.fontSize + 2 } },
        xaxis: { title: { text: 'VIP Score', font: { family: opts.fontFamily, size: opts.fontSize } },
                 tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 } },
        yaxis: { tickfont: { family: opts.fontFamily, size: opts.fontSize - 1 }, autorange: 'reversed' },
        shapes: [{ type: 'line', x0: 1, x1: 1, y0: -0.5, y1: vip.length - 0.5,
                   line: { color: '#e74c3c', width: 1.5, dash: 'dash' } }],
        annotations: [{ x: 1.02, y: 0, xanchor: 'left', yanchor: 'top', xref: 'x', yref: 'paper',
                        text: 'VIP=1', font: { color: '#e74c3c', size: opts.fontSize - 1 }, showarrow: false }],
        plot_bgcolor: '#fafafa', paper_bgcolor: 'white',
        margin: { l: Math.max(80, Math.max(...vip.map(v => v.var.length)) * 6), r: 30, t: 60, b: 50 },
        height: Math.max(300, vip.length * 26 + 80),
    };
    Plotly.react(div, [trace], layout, { responsive: true });
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.querySelectorAll('.pls-method-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.pls-method-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        _updatePlsStepper();
    });
});
document.getElementById('plsYCol')?.addEventListener('change', () => { _updatePlsStepper(); _renderPlsMissingData(); });
document.getElementById('plsNComponents')?.addEventListener('input', _updatePlsStepper);

document.getElementById('runPlsBtn').addEventListener('click', function () {
    const vars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
    if (vars.length < 2) return alert('Select at least 2 variables in the Data Input panel.');
    const yCol = document.getElementById('plsYCol').value;
    if (!yCol) return alert('Please select a response variable (Y).');

    const method = plsGetMethod();
    const nComponents = parseInt(document.getElementById('plsNComponents').value) || 2;
    const computeCV = document.getElementById('plsComputeCV').checked;

    document.getElementById('plsStatusMsg').innerHTML = '';
    document.getElementById('plsSpinner').style.display = 'block';
    document.getElementById('stopPlsBtn').style.display = 'inline-block';
    document.getElementById('runPlsBtn').disabled = true;

    plsAbortController = new AbortController();
    fetch('/run-pls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: plsAbortController.signal,
        body: JSON.stringify({
            data: globalData, variables: vars, factors: selectedFactors,
            method, y_col: yCol, n_components: nComponents, compute_cv: computeCV,
        })
    })
    .then(r => r.json())
    .then(result => {
        document.getElementById('plsSpinner').style.display = 'none';
        document.getElementById('stopPlsBtn').style.display = 'none';
        document.getElementById('runPlsBtn').disabled = false;
        if (result.error) {
            document.getElementById('plsStatusMsg').innerHTML =
                `<div class="alert alert-danger py-2 small shadow-sm mb-2">${result.error}</div>`;
            return;
        }
        lastPlsResult = result;
        _updatePlsStepper();
        const opts = plsReadOpts();
        const methodStr = result.method === 'pls-da' ? 'PLS-DA' : 'PLS';

        document.getElementById('plsMetrics').style.display = 'block';
        document.getElementById('plsR2X').textContent = (result.r2x * 100).toFixed(1) + '%';
        document.getElementById('plsR2Y').textContent = (result.r2y * 100).toFixed(1) + '%';
        document.getElementById('plsQ2').textContent  = result.q2 !== null ? (result.q2 * 100).toFixed(1) + '%' : 'N/A';
        document.getElementById('plsNSamplesMsg').textContent = `n=${result.n_samples}, ${result.n_components} component(s)`;

        document.getElementById('plsStatusMsg').innerHTML =
            `<div class="alert alert-success py-2 small shadow-sm mb-2">
                <strong>${methodStr} complete:</strong> ${result.n_samples} samples, ${vars.length} variables, ${result.n_components} component(s).
                R²X=${(result.r2x*100).toFixed(1)}%, R²Y=${(result.r2y*100).toFixed(1)}%${result.q2!==null?`, Q²=${(result.q2*100).toFixed(1)}%`:''}.</div>`;

        document.getElementById('plsStyleCard').style.display = 'block';
        document.getElementById('plsDownloadRow').style.display = 'block';
        document.getElementById('downloadPlsBtn').style.display = 'inline-block';

        renderPlsScores(result, opts);
        renderPlsWeights(result, opts);
        renderPlsVip(result, opts);
    })
    .catch(err => {
        if (err.name === 'AbortError') return;
        document.getElementById('plsSpinner').style.display = 'none';
        document.getElementById('stopPlsBtn').style.display = 'none';
        document.getElementById('runPlsBtn').disabled = false;
        document.getElementById('plsStatusMsg').innerHTML =
            `<div class="alert alert-danger py-2 small shadow-sm mb-2">PLS Error: ${err.message}</div>`;
    });
});

document.getElementById('stopPlsBtn').addEventListener('click', function () {
    if (plsAbortController) plsAbortController.abort();
    document.getElementById('plsSpinner').style.display = 'none';
    document.getElementById('runPlsBtn').disabled = false;
    this.style.display = 'none';
});

// ── Style live re-renders ─────────────────────────────────────────────────────
document.querySelectorAll('.pls-palette-btn').forEach(btn => {
    btn.addEventListener('click', function () {
        document.querySelectorAll('.pls-palette-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
        if (lastPlsResult) { const o=plsReadOpts(); renderPlsScores(lastPlsResult,o); }
    });
});
['plsPointSize','plsOpacity'].forEach(id => {
    const el = document.getElementById(id);
    ['change','input'].forEach(ev => el.addEventListener(ev, function () {
        if (id==='plsOpacity') document.getElementById('plsOpacityVal').textContent = this.value + '%';
        if (id==='plsPointSize') document.getElementById('plsPointSizeVal').textContent = this.value;
        if (lastPlsResult) { const o=plsReadOpts(); renderPlsScores(lastPlsResult,o); }
    }));
});
['plsFontFamily','plsFontSize'].forEach(id => {
    const el = document.getElementById(id);
    ['change','input'].forEach(ev => el.addEventListener(ev, function () {
        if (id==='plsFontSize') document.getElementById('plsFontSizeVal').textContent = this.value;
        if (lastPlsResult) { const o=plsReadOpts(); renderPlsScores(lastPlsResult,o); renderPlsWeights(lastPlsResult,o); renderPlsVip(lastPlsResult,o); }
    }));
});

// ── PNG download buttons ──────────────────────────────────────────────────────
document.getElementById('plsDownloadScoreBtn').addEventListener('click', () => {
    const div = document.getElementById('plsScorePlot'); const sc=parseInt(document.getElementById('plsExportScale').value);
    Plotly.downloadImage(div,{format:'png',filename:'PLS_Score_Plot',scale:sc,width:div.offsetWidth||700,height:div.offsetHeight||500});
});
document.getElementById('plsDownloadWeightsBtn').addEventListener('click', () => {
    const div = document.getElementById('plsWeightsPlot'); const sc=parseInt(document.getElementById('plsExportScale').value);
    Plotly.downloadImage(div,{format:'png',filename:'PLS_Weights_Plot',scale:sc,width:div.offsetWidth||700,height:div.offsetHeight||500});
});
document.getElementById('plsDownloadVipBtn').addEventListener('click', () => {
    const div = document.getElementById('plsVipPlot'); const sc=parseInt(document.getElementById('plsExportScale').value);
    Plotly.downloadImage(div,{format:'png',filename:'PLS_VIP_Plot',scale:sc,width:div.offsetWidth||700,height:div.offsetHeight||400});
});

// ── ZIP export (client-side) ──────────────────────────────────────────────────
async function _exportPlsReport() {
    if (!lastPlsResult) return alert('Run PLS first before exporting.');
    const r = lastPlsResult;
    const btn = document.getElementById('downloadPlsBtn');
    const origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin mr-1"></i> Building…';
    const spinner = document.getElementById('plsExportSpinner');
    if (spinner) spinner.style.display = 'inline-block';
    try {
        const wb = XLSX.utils.book_new();
        const addSheet = (name, rows) =>
            XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
        const pct = v => v != null ? parseFloat((v * 100).toFixed(4)) : null;
        const methodStr = r.method === 'pls-da' ? 'PLS-DA' : 'PLS';
        const nComp = r.n_components || 2;

        // Sheet 1: Parameters
        addSheet('Parameters', [
            ['Parameter', 'Value'],
            ['Method', methodStr],
            ['Response variable (Y)', r.y_col || ''],
            ['LV components', nComp],
            ['Samples', r.n_samples || ''],
            ['Variables used', r.vars_used ? r.vars_used.length : ''],
            ['Variable list', r.vars_used ? r.vars_used.join(', ') : ''],
            ['R²X (%)', pct(r.r2x)],
            ['R²Y (%)', pct(r.r2y)],
            ['Q² (%)', pct(r.q2)],
            ['Export date', new Date().toLocaleDateString('en-GB')],
        ]);

        // Sheet 2: Scores
        const scoreRows = [['Sample', 'Group', 'T1 (LV1 score)', 'T2 (LV2 score)']];
        (r.scores || []).forEach(s => scoreRows.push([s.label, s.group, s.T1, s.T2]));
        addSheet('PLS Scores', scoreRows);

        // Sheet 3: Weights
        const wHeaders = ['Variable', ...Array.from({ length: nComp }, (_, i) => `W${i + 1}`), 'VIP'];
        const weightRows = [wHeaders];
        (r.weights || []).forEach(w => weightRows.push(
            [w.var, ...Array.from({ length: nComp }, (_, i) => w[`W${i + 1}`]), w.vip]
        ));
        addSheet('Weights', weightRows);

        // Sheet 4: VIP scores
        const vipRows = [['Variable', 'VIP Score', 'VIP \u2265 1.0']];
        (r.vip || []).forEach(v => vipRows.push([v.var, v.vip, v.vip >= 1.0 ? 'Yes' : 'No']));
        addSheet('VIP Scores', vipRows);

        // Capture plots
        const sc = parseInt(document.getElementById('plsExportScale')?.value) || 2;
        const toImg = async (id, w, h) => {
            const d = document.getElementById(id);
            if (!d || d.style.display === 'none') return null;
            const b64 = await Plotly.toImage(d, { format: 'png', scale: sc, width: w || d.offsetWidth || 700, height: h || d.offsetHeight || 500 });
            return b64.split(',')[1];
        };
        const [scoreImg, weightsImg, vipImg] = await Promise.all([
            toImg('plsScorePlot',   700, 500),
            toImg('plsWeightsPlot', 700, 500),
            toImg('plsVipPlot',     700, Math.max(350, (r.vip || []).length * 26 + 80)),
        ]);

        // Bundle ZIP
        const zip = new JSZip();
        zip.file('PLS_Analysis.xlsx', XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
        if (scoreImg)   zip.file('PLS_Score_Plot.png',   scoreImg,   { base64: true });
        if (weightsImg) zip.file('PLS_Weights_Plot.png', weightsImg, { base64: true });
        if (vipImg)     zip.file('PLS_VIP_Plot.png',     vipImg,     { base64: true });
        zip.file('Methods_section.html', _buildMethodsHTML());

        const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url; a.download = 'PLS_Report.zip';
        document.body.appendChild(a); a.click();
        URL.revokeObjectURL(url); document.body.removeChild(a);
    } catch (err) {
        alert('Export error: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        if (spinner) spinner.style.display = 'none';
    }
}
document.getElementById('downloadPlsBtn').addEventListener('click', () =>
    _exportPlsReport().catch(err => alert('Export error: ' + err.message)));


// ═══════════════════════════════════════════════════════════════════════════════
// 9. CORRELATION → PCA PIPELINE  (Steps 2-5)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helper: get currently-selected variable names ─────────────────────────────
function _currentSelectedVars() {
    return Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled).map(cb => cb.value);
}

// ── Normalization transform (column-wise, client-side) ────────────────────────
function applyColumnNorm(data, varNames, method) {
    if (!method || method === 'none') return data;
    const colStats = {};
    varNames.forEach(v => {
        const vals = data.map(r => parseFloat(r[v])).filter(x => !isNaN(x));
        if (!vals.length) { colStats[v] = { mean: 0, std: 1, min: 0, max: 1 }; return; }
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1;
        const min = Math.min(...vals), max = Math.max(...vals);
        colStats[v] = { mean, std, min, max };
    });
    return data.map(row => {
        const newRow = Object.assign({}, row);
        varNames.forEach(v => {
            const val = parseFloat(row[v]);
            if (isNaN(val)) { newRow[v] = null; return; }
            const s = colStats[v];
            if (method === 'zscore') newRow[v] = s.std > 0 ? (val - s.mean) / s.std : 0;
            else if (method === 'minmax') newRow[v] = (s.max - s.min) > 0 ? (val - s.min) / (s.max - s.min) : 0;
            else if (method === 'log10') newRow[v] = val > 0 ? Math.log10(val) : null;
            else if (method === 'ln') newRow[v] = val > 0 ? Math.log(val) : null;
            else if (method === 'sqrt') newRow[v] = val >= 0 ? Math.sqrt(val) : null;
        });
        return newRow;
    });
}

// ── Near-zero variance filter ─────────────────────────────────────────────────
function filterNearZeroVariance(varNames, data, cvThreshold) {
    if (!cvThreshold || cvThreshold <= 0) return varNames;
    return varNames.filter(v => {
        const vals = data.map(r => parseFloat(r[v])).filter(x => !isNaN(x));
        if (vals.length < 2) return false;
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
        const cv = mean !== 0 ? (std / Math.abs(mean)) * 100 : 0;
        return cv > cvThreshold;
    });
}

// ── NZV diagnostic renderer ───────────────────────────────────────────────────
function renderNzvDiagnostic(varNames, data, cvThreshold) {
    const container = document.getElementById('nzvDiagnostic');
    if (!container) return;
    if (!cvThreshold || cvThreshold <= 0 || !varNames.length || !data) {
        container.innerHTML = '';
        return;
    }
    const passing = filterNearZeroVariance(varNames, data, cvThreshold);
    const removed = varNames.filter(v => !passing.includes(v));
    if (!removed.length) {
        container.innerHTML = `<small class="text-success">All ${varNames.length} variables pass (CV &gt; ${cvThreshold}%).</small>`;
    } else {
        const chips = removed.map(v => `<span class="badge badge-warning text-dark mr-1">${v}</span>`).join('');
        container.innerHTML = `<small class="text-muted">${removed.length} variable${removed.length > 1 ? 's' : ''} would be removed (CV &le; ${cvThreshold}%): ${chips}</small>`;
    }
}

// ── NZV slider event ──────────────────────────────────────────────────────────
(function () {
    const slider = document.getElementById('nzvThreshold');
    const label = document.getElementById('nzvThresholdVal');
    if (!slider || !label) return;
    slider.addEventListener('input', function () {
        nzvThreshold = parseInt(this.value, 10);
        label.textContent = nzvThreshold > 0 ? nzvThreshold + '%' : 'Off';
        label.className = 'badge ' + (nzvThreshold > 0 ? 'badge-info' : 'badge-secondary');
        if (globalData) {
            const vars = _currentSelectedVars();
            renderNzvDiagnostic(vars, globalData, nzvThreshold);
        }
    });
})();

// ── Normalization transform button group ──────────────────────────────────────
(function () {
    const group = document.getElementById('normTransformGroup');
    if (!group) return;
    group.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-norm]');
        if (!btn) return;
        group.querySelectorAll('[data-norm]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentNormTransform = btn.dataset.norm;
        const note = document.getElementById('normTransformNote');
        if (note) note.classList.toggle('d-none', currentNormTransform === 'none');
        // Refresh distribution preview if panel is open
        const distBody = document.getElementById('distBody');
        if (distBody && distBody.classList.contains('show')) _refreshDistIfVisible();
    });
})();

// ── "Run Correlation Analysis" button in preprocessing panel ──────────────────
(function () {
    const btn = document.getElementById('runCorrelationBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
        const runBtn = document.getElementById('runCorrBtn');
        if (runBtn) runBtn.click();
    });
})();

// ── Connected components for redundancy clustering ────────────────────────────
function connectedComponents(corrMatrix, varNames, threshold) {
    const adj = {};
    varNames.forEach(v => { adj[v] = new Set(); });
    for (let i = 0; i < varNames.length; i++) {
        for (let j = i + 1; j < varNames.length; j++) {
            const r = corrMatrix[i] && corrMatrix[i][j] !== undefined ? corrMatrix[i][j] : null;
            if (r !== null && r !== undefined && Math.abs(r) >= threshold) {
                adj[varNames[i]].add(varNames[j]);
                adj[varNames[j]].add(varNames[i]);
            }
        }
    }
    const visited = new Set();
    const components = [];
    varNames.forEach(v => {
        if (visited.has(v) || adj[v].size === 0) return;
        const comp = [];
        const queue = [v];
        while (queue.length) {
            const node = queue.shift();
            if (visited.has(node)) continue;
            visited.add(node);
            comp.push(node);
            adj[node].forEach(n => { if (!visited.has(n)) queue.push(n); });
        }
        if (comp.length > 1) components.push(comp);
    });
    return components;
}

// ── Hub scores ────────────────────────────────────────────────────────────────
function computeHubScores(corrMatrix, varNames, threshold) {
    const scores = {};
    varNames.forEach((v, i) => {
        scores[v] = 0;
        varNames.forEach((u, j) => {
            if (u === v) return;
            const r = Array.isArray(corrMatrix[i]) ? corrMatrix[i][j] : 0;
            if (r !== null && r !== undefined && Math.abs(r) >= threshold) {
                scores[v] += Math.abs(r);
            }
        });
    });
    return scores;
}

// ── Initialize excluded set — checkboxes default all to kept ──────────────────
function initExcludedFromClusters() {
    excludedVarsFromCorr.clear();
    // All variables start as kept; user unchecks to exclude
}

// ── Update Step 4 keep-count badge ───────────────────────────────────────────
function updateStep4KeepCount() {
    const badge = document.getElementById('step4KeepCount');
    if (!badge || !lastCorrResults) return;
    const allVars = lastCorrResults.variables || [];
    const kept = allVars.filter(v => !excludedVarsFromCorr.has(v));
    badge.textContent = `${kept.length} variable${kept.length !== 1 ? 's' : ''} will be sent to PCA`;
}


let _currentOverlayMode = 'all';
// Stores cluster variable arrays indexed by cluster index — avoids inline JSON escaping
let _clusterData = [];

// ── Render a mini sub-heatmap for a cluster ───────────────────────────────────
function _renderClusterSubHeatmap(divId, clusterVars, corrMatrix, allVars) {
    const div = document.getElementById(divId);
    if (!div) return;
    const n = clusterVars.length;
    if (n < 2) { div.style.display = 'none'; return; }

    const indices = clusterVars.map(v => allVars.indexOf(v));
    const z = clusterVars.map((_, ri) =>
        clusterVars.map((_, ci) => {
            const r = corrMatrix[indices[ri]]?.[indices[ci]];
            return (r !== null && r !== undefined) ? r : null;
        })
    );
    const text = z.map(row => row.map(v => v !== null ? v.toFixed(2) : ''));

    const maxLen = clusterVars.reduce((m, v) => Math.max(m, v.length), 0);
    const ml = Math.min(140, Math.max(50, maxLen * 6));
    const mb = Math.min(140, Math.max(50, maxLen * 6));
    const mt = 8; const mr = 20; const CB = 65;
    const contW  = div.offsetWidth || div.parentElement?.offsetWidth || 400;
    const cellPx = Math.max(1, Math.floor((contW - ml - mr - CB) / n));
    const figW   = ml + n * cellPx + mr + CB;
    const figH   = mt + n * cellPx + mb;
    const axFont  = Math.max(7, Math.min(12, Math.floor(cellPx * 0.55)));
    const celFont = Math.max(6, Math.min(11, Math.floor(cellPx * 0.38)));

    div.style.width  = figW + 'px';
    div.style.height = figH + 'px';

    const trace = {
        type: 'heatmap',
        z, x: clusterVars, y: clusterVars,
        colorscale: CORR_COLORSCALES[document.getElementById('corrColorScheme')?.value] || CORR_COLORSCALES.RdBu,
        reversescale: true,
        zmin: -1, zmax: 1,
        showscale: true,
        text, texttemplate: '%{text}',
        textfont: { size: celFont },
        hovertemplate: '%{y} × %{x}: %{z:.3f}<extra></extra>'
    };
    const layout = {
        width: figW, height: figH,
        margin: { t: mt, b: mb, l: ml, r: mr + CB },
        xaxis: { tickangle: -45, tickfont: { size: axFont }, automargin: true },
        yaxis: { autorange: 'reversed', tickfont: { size: axFont }, automargin: true },
        paper_bgcolor: 'transparent', plot_bgcolor: 'transparent'
    };
    Plotly.newPlot(div, [trace], layout, { responsive: false, displayModeBar: false });
}

// ── Reset a cluster — re-check all variables (keep all) ──────────────────────
function _resetClusterSelection(ci) {
    const clusterVars = _clusterData[ci] || [];
    clusterVars.forEach(v => {
        excludedVarsFromCorr.delete(v);
        const cb = document.querySelector(
            `input.cluster-var-cb[data-cluster-idx="${ci}"][value="${CSS.escape(v)}"]`);
        if (cb) {
            cb.checked = true;
            const badge = cb.closest('tr')?.querySelector('.cb-badge');
            if (badge) { badge.textContent = 'Keep'; badge.className = 'badge badge-success cb-badge'; }
        }
    });
    const label = document.getElementById(`clusterKeepLabel_${ci}`);
    if (label) { label.textContent = 'all kept'; label.className = 'text-success font-weight-bold small'; }
    updateStep4KeepCount();
    _renderCorrelationOverlay(_currentOverlayMode);
}

// ── Auto-select a single variable per cluster (lowest hub score = least redundant) ──
function _applyClusterAutoSelect(ci) {
    const clusterVars = _clusterData[ci] || [];
    if (!clusterVars.length || !lastCorrResults) return;
    const threshold = parseFloat(document.getElementById('step4Threshold')?.value) || 0.80;
    const hubScores = computeHubScores(lastCorrResults.corr_matrix, lastCorrResults.variables, threshold);

    // Keep the variable with the LOWEST hub score (least redundant — standard approach)
    const toKeep = clusterVars.reduce((best, v) =>
        (hubScores[v] || 0) < (hubScores[best] || 0) ? v : best, clusterVars[0]);

    clusterVars.forEach(v => {
        const keep = v === toKeep;
        const cb = document.querySelector(
            `input.cluster-var-cb[data-cluster-idx="${ci}"][value="${CSS.escape(v)}"]`);
        if (cb) {
            cb.checked = keep;
            const badge = cb.closest('tr')?.querySelector('.cb-badge');
            if (badge) {
                badge.textContent = keep ? 'Keep' : 'Exclude';
                badge.className   = keep ? 'badge badge-success cb-badge' : 'badge badge-secondary cb-badge';
            }
        }
        if (keep) excludedVarsFromCorr.delete(v);
        else      excludedVarsFromCorr.add(v);
    });

    const excluded = clusterVars.filter(v => excludedVarsFromCorr.has(v));
    const label = document.getElementById(`clusterKeepLabel_${ci}`);
    if (label) {
        label.textContent = excluded.length > 0 ? `${excluded.length} excluded` : 'all kept';
        label.className   = excluded.length > 0
            ? 'text-warning font-weight-bold small'
            : 'text-success font-weight-bold small';
    }

    updateStep4KeepCount();
    _renderCorrelationOverlay(_currentOverlayMode);
}

// ── Render redundancy cluster cards ──────────────────────────────────────────
function renderRedundancyClusters(clusters, hubScores, corrMatrix, varNames) {
    const container = document.getElementById('redundancyClusters');
    if (!container) return;

    _clusterData = clusters;

    if (!clusters.length) {
        container.innerHTML = '<div class="alert alert-success py-2 small">No redundant variable pairs found at the current threshold. All variables are suitable for PCA.</div>';
        updateStep4KeepCount();
        return;
    }

    // Global auto-select + reset buttons
    const globalBtn = `<div class="d-flex justify-content-end mb-2" style="gap:0.4rem;">
        <button id="autoSelectAllBtn" class="btn btn-sm btn-outline-primary">
            <i class="fa fa-magic mr-1"></i>Keep least redundant in all clusters
        </button>
        <button id="resetAllClustersBtn" class="btn btn-sm btn-outline-secondary">
            <i class="fa fa-undo mr-1"></i>Reset all
        </button>
    </div>`;

    // Sort variables within each cluster by hub score descending (most redundant first)
    const clusterCards = clusters.map((comp, ci) => {
        const sorted = [...comp].sort((a, b) => (hubScores[b] || 0) - (hubScores[a] || 0));
        const rows = sorted.map(v => {
            const vEsc  = v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
            const vAttr = v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return `<tr>
                <td class="py-1 px-2 small">
                    <label class="mb-0 d-flex align-items-center" style="gap:0.35rem;">
                        <input type="checkbox" class="cluster-var-cb" value="${vAttr}"
                            data-cluster-idx="${ci}" checked>
                        ${vEsc}
                    </label>
                </td>
                <td class="py-1 px-2 small text-center text-muted">${(hubScores[v] || 0).toFixed(2)}</td>
                <td class="py-1 px-2 small text-center">
                    <span class="badge badge-success cb-badge">Keep</span>
                </td>
            </tr>`;
        }).join('');

        // Short variable list preview shown in collapsed header
        const preview = sorted.map(v => v.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join(' · ');

        return `<div class="card mb-2 border-warning">
            <div class="card-header py-1 px-2 d-flex justify-content-between align-items-center"
                 style="background:#fff8e1;">
                <span class="d-flex align-items-center flex-grow-1 mr-2"
                      style="cursor:pointer; min-width:0;"
                      data-toggle="collapse" data-target="#clusterBody_${ci}" aria-expanded="false">
                    <i class="fa fa-chevron-right mr-1 small cluster-chevron" style="transition:transform 0.2s; flex-shrink:0;"></i>
                    <span class="font-weight-bold small mr-1">Cluster ${ci + 1}</span>
                    <small class="text-muted mr-2">(${comp.length} variables)</small>
                    <small class="text-muted text-truncate" style="font-size:0.75em;">${preview}</small>
                </span>
                <div class="d-flex align-items-center flex-shrink-0" style="gap:0.3rem;">
                    <small id="clusterKeepLabel_${ci}" class="text-success font-weight-bold mr-1">all kept</small>
                    <button class="btn btn-sm btn-outline-primary cluster-auto-btn py-0 px-1"
                            data-cluster-idx="${ci}" style="font-size:0.72rem;">
                        <i class="fa fa-magic mr-1"></i>Keep least redundant
                    </button>
                    <button class="btn btn-sm btn-outline-secondary cluster-reset-btn py-0 px-1"
                            data-cluster-idx="${ci}" style="font-size:0.72rem;">
                        <i class="fa fa-undo mr-1"></i>Reset
                    </button>
                </div>
            </div>
            <div id="clusterBody_${ci}" class="collapse">
                <div class="card-body p-2">
                    <table class="table table-sm mb-2" style="font-size:0.82rem;">
                        <thead class="thead-light">
                            <tr>
                                <th class="py-1">Variable</th>
                                <th class="py-1 text-center"
                                    title="Sum of |r| with all other cluster members — higher = more redundant, consider removing">
                                    Hub Score <i class="fa fa-info-circle text-muted" style="font-size:0.8em;"></i>
                                </th>
                                <th class="py-1 text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody>${rows}</tbody>
                    </table>
                    <div id="clusterHeatmap_${ci}" style="width:100%; overflow:hidden;"></div>
                </div>
            </div>
        </div>`;
    });

    container.innerHTML = globalBtn + clusterCards.join('');

    // Render mini sub-heatmaps for each cluster (deferred so collapse div exists in DOM)
    clusters.forEach((comp, ci) => {
        // Wait for Bootstrap collapse to attach, then render on first open
        const collapseEl = document.getElementById(`clusterBody_${ci}`);
        if (collapseEl) {
            let rendered = false;
            $(collapseEl)
            .on('show.bs.collapse', function () {
                const chevron = collapseEl.closest('.card')?.querySelector('.cluster-chevron');
                if (chevron) chevron.style.transform = 'rotate(90deg)';
            })
            .on('shown.bs.collapse', function () {
                if (!rendered) {
                    rendered = true;
                    _renderClusterSubHeatmap(`clusterHeatmap_${ci}`, comp, corrMatrix, varNames);
                }
            })
            .on('hide.bs.collapse', function () {
                const chevron = collapseEl.closest('.card')?.querySelector('.cluster-chevron');
                if (chevron) chevron.style.transform = '';
            });
        }
    });

    // Event delegation — set up only once
    if (!container._clusterListenerAttached) {
        container._clusterListenerAttached = true;

        container.addEventListener('click', function(e) {
            // Per-cluster "Keep least redundant" button
            const perAutoBtn = e.target.closest('button.cluster-auto-btn');
            if (perAutoBtn) {
                _applyClusterAutoSelect(parseInt(perAutoBtn.dataset.clusterIdx, 10));
                return;
            }
            // Per-cluster "Reset" button
            const perResetBtn = e.target.closest('button.cluster-reset-btn');
            if (perResetBtn) {
                _resetClusterSelection(parseInt(perResetBtn.dataset.clusterIdx, 10));
                return;
            }
            // Global "Keep least redundant in all clusters"
            if (e.target.closest('#autoSelectAllBtn')) {
                _clusterData.forEach((_, ci) => _applyClusterAutoSelect(ci));
                return;
            }
            // Global "Reset all clusters"
            if (e.target.closest('#resetAllClustersBtn')) {
                _clusterData.forEach((_, ci) => _resetClusterSelection(ci));
            }
        });

        container.addEventListener('change', function(e) {
            const cb = e.target.closest('input.cluster-var-cb');
            if (!cb) return;
            const ci = parseInt(cb.dataset.clusterIdx, 10);
            const v  = cb.value;
            if (cb.checked) excludedVarsFromCorr.delete(v);
            else            excludedVarsFromCorr.add(v);
            // Update badge in same row
            const badge = cb.closest('tr')?.querySelector('.cb-badge');
            if (badge) {
                badge.textContent = cb.checked ? 'Keep' : 'Exclude';
                badge.className   = cb.checked ? 'badge badge-success cb-badge' : 'badge badge-secondary cb-badge';
            }
            // Update cluster header label
            const clusterVars = _clusterData[ci] || [];
            const excluded = clusterVars.filter(v2 => excludedVarsFromCorr.has(v2));
            const label = document.getElementById(`clusterKeepLabel_${ci}`);
            if (label) {
                if (excluded.length === 0) {
                    label.textContent = 'all kept';
                    label.className = 'text-success font-weight-bold small';
                } else {
                    label.textContent = `${excluded.length} excluded`;
                    label.className = 'text-warning font-weight-bold small';
                }
            }
            updateStep4KeepCount();
            _renderCorrelationOverlay(_currentOverlayMode);
        });
    }

    initExcludedFromClusters();
    updateStep4KeepCount();
}

// ── Correlation overlay heatmap ───────────────────────────────────────────────
function _renderCorrelationOverlay(mode) {
    mode = mode || 'all';
    _currentOverlayMode = mode;

    const overlayDiv = document.getElementById('corrHeatmapOverlay');
    if (!overlayDiv || !lastCorrResults) return;

    const { variables, corr_matrix } = lastCorrResults;
    if (!variables || !corr_matrix) return;

    const excluded = [...excludedVarsFromCorr];
    const displayVars = mode === 'hide'
        ? variables.filter(v => !excludedVarsFromCorr.has(v))
        : variables;

    const displayMatrix = displayVars.map(rv => {
        const ri = variables.indexOf(rv);
        return displayVars.map(cv => {
            const ci = variables.indexOf(cv);
            return corr_matrix[ri] !== undefined ? (corr_matrix[ri][ci] !== undefined ? corr_matrix[ri][ci] : null) : null;
        });
    });

    const colorSchemeEl = document.getElementById('corrColorScheme');
    const colorscale = CORR_COLORSCALES[colorSchemeEl?.value] || CORR_COLORSCALES.RdBu;

    const trace = {
        type: 'heatmap',
        z: displayMatrix,
        x: displayVars,
        y: displayVars,
        colorscale,
        zmin: -1, zmax: 1,
        showscale: true,
        hovertemplate: '<b>%{y}</b> vs <b>%{x}</b>: %{z:.3f}<extra></extra>',
    };

    const shapes = [];
    if (mode === 'all') {
        excluded.forEach(ev => {
            const idx = displayVars.indexOf(ev);
            if (idx < 0) return;
            shapes.push({ type: 'rect', xref: 'x', yref: 'y',
                x0: idx - 0.5, x1: idx + 0.5,
                y0: -0.5, y1: displayVars.length - 0.5,
                fillcolor: 'rgba(80,80,80,0.55)', line: { width: 0 } });
            shapes.push({ type: 'rect', xref: 'x', yref: 'y',
                x0: -0.5, x1: displayVars.length - 0.5,
                y0: idx - 0.5, y1: idx + 0.5,
                fillcolor: 'rgba(80,80,80,0.55)', line: { width: 0 } });
        });
    }

    const n = displayVars.length;
    const contW  = (overlayDiv.parentElement || overlayDiv).offsetWidth || 600;
    const maxLen = displayVars.reduce((m, v) => Math.max(m, v.length), 0);
    const ml = Math.min(140, Math.max(50, maxLen * 6));
    const mb = Math.min(140, Math.max(50, maxLen * 6));
    const mt = 20; const mr = 20; const CB = 65; // colorbar space
    const cellPx  = Math.max(1, Math.floor((contW - ml - mr - CB) / n));
    const figW    = ml + n * cellPx + mr + CB;
    const figH    = mt + n * cellPx + mb;
    const axFont = Math.max(7, Math.min(12, Math.floor(cellPx * 0.55)));
    overlayDiv.style.width = figW + 'px';

    Plotly.react(overlayDiv, [trace], {
        width: figW, height: figH,
        margin: { l: ml, r: mr + CB, t: mt, b: mb },
        shapes,
        xaxis: { tickangle: -45, tickfont: { size: axFont }, automargin: true },
        yaxis: { autorange: 'reversed', tickfont: { size: axFont }, automargin: true },
    }, { responsive: false });
}

// ── Overlay toggle buttons ────────────────────────────────────────────────────
(function () {
    ['overlayShowAll', 'overlayHideExcluded'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', function () {
            ['overlayShowAll', 'overlayHideExcluded'].forEach(b => {
                const el = document.getElementById(b);
                if (el) el.classList.remove('active');
            });
            this.classList.add('active');
            const modeMap = { overlayShowAll: 'all', overlayHideExcluded: 'hide' };
            _renderCorrelationOverlay(modeMap[id]);
        });
    });
})();

// ── Reset reduction selections ────────────────────────────────────────────────
(function () {
    const btn = document.getElementById('resetReductionBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
        if (!lastCorrResults) return;
        const { variables, corr_matrix } = lastCorrResults;
        const threshold = parseFloat(document.getElementById('step4Threshold').value) || 0.80;
        const clusters = connectedComponents(corr_matrix, variables, threshold);
        const hubScores = computeHubScores(corr_matrix, variables, threshold);
        renderRedundancyClusters(clusters, hubScores, corr_matrix, variables);
        _renderCorrelationOverlay(_currentOverlayMode);
    });
})();

// ── Send to PCA button (Step 4 → Step 5) ─────────────────────────────────────
(function () {
    const btn = document.getElementById('sendToPcaBtn');
    if (!btn) return;
    btn.addEventListener('click', function () {
        const selectedVars = _currentSelectedVars();
        const toSend = selectedVars.filter(v => !excludedVarsFromCorr.has(v));

        // Uncheck excluded vars in sidebar
        document.querySelectorAll('.var-check').forEach(cb => {
            if (excludedVarsFromCorr.has(cb.value)) cb.checked = false;
        });

        // Unlock PCA / PLS / OPLS sub-tabs now that variables are confirmed
        _unlockSubTab('pca-tab');
        _unlockSubTab('pls-subtab');
        _unlockSubTab('opls-subtab');

        // Switch to Multivariate category then activate PCA sub-tab
        _switchCategory('multivariate');
        const pcaTab = document.getElementById('pca-tab');
        if (pcaTab) pcaTab.click();

        // Show notification in PCA panel
        const pcaResults = document.getElementById('pcaResults');
        if (pcaResults) {
            pcaResults.innerHTML = `
                <div class="alert alert-success fade show py-2 small mb-2" role="alert">
                    <i class="fa fa-check-circle mr-1"></i>
                    <strong>${toSend.length} variable${toSend.length !== 1 ? 's' : ''} received from Correlation analysis</strong>
                    (${excludedVarsFromCorr.size} excluded as redundant from Step 4).
                    Review the variable list above — you can re-check any variable.
                    <a href="#" class="ml-2 small" id="backToVarReductionLink">
                        <i class="fa fa-arrow-left mr-1"></i>Back to variable selection
                    </a>
                </div>`;
            // Wire up back-link: switch to Correlation tab and scroll to Step 4
            const backLink = document.getElementById('backToVarReductionLink');
            if (backLink) {
                backLink.addEventListener('click', function (e) {
                    e.preventDefault();
                    _switchCategory('multivariate');
                    const corrTab = document.getElementById('corr-tab');
                    if (corrTab) corrTab.click();
                    setTimeout(() => {
                        const step4 = document.getElementById('pipelineStep4');
                        if (step4 && step4.style.display !== 'none') {
                            step4.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    }, 150);
                });
            }
        }

        // Track which vars came from correlation
        pcaVarsFromCorr = new Set(toSend);
        _updateCorrStepper();

        // Update coverage diagnostic and PCA preview
        const vars = Array.from(document.querySelectorAll('.var-check:checked'))
            .filter(cb => !cb.disabled).map(cb => cb.value);
        _renderCoverageDiagnostic(vars);
        _renderPCADataPreview();
    });
})();

// ── "Proceed to Variable Reduction" button (Step 3 → Step 4) ─────────────────
(function () {
    const btn = document.getElementById('toStep4Btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
        if (!lastCorrResults) return;
        const { variables, corr_matrix } = lastCorrResults;
        const threshold = parseFloat(document.getElementById('step4Threshold').value) || 0.80;

        const clusters = connectedComponents(corr_matrix, variables, threshold);
        const hubScores = computeHubScores(corr_matrix, variables, threshold);

        const step4Panel = document.getElementById('pipelineStep4');
        if (step4Panel) {
            step4Panel.style.display = 'block';
            step4Panel.classList.remove('pipeline-locked');
            const summary = document.getElementById('step4Summary');
            if (summary) {
                summary.textContent = clusters.length > 0
                    ? `${clusters.length} redundancy cluster${clusters.length !== 1 ? 's' : ''} found`
                    : 'No redundant clusters at this threshold';
            }
        }

        // Show action bar below accordion; hide this button
        const actionBar = document.getElementById('step4ActionBar');
        if (actionBar) actionBar.style.cssText = 'display:flex!important; gap:0.5rem; flex-wrap:wrap; margin-top:0.5rem;';
        btn.classList.add('d-none');

        renderRedundancyClusters(clusters, hubScores, corr_matrix, variables);
        _renderCorrelationOverlay('all');

        if (step4Panel) step4Panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
})();

// ── Re-render Step 4 when threshold input changes ─────────────────────────────
(function () {
    const input = document.getElementById('step4Threshold');
    if (!input) return;
    function _recomputeStep4() {
        if (!lastCorrResults) return;
        const { variables, corr_matrix } = lastCorrResults;
        const threshold = parseFloat(input.value) || 0.80;
        const clusters  = connectedComponents(corr_matrix, variables, threshold);
        const hubScores = computeHubScores(corr_matrix, variables, threshold);
        const summary   = document.getElementById('step4Summary');
        if (summary) {
            summary.textContent = clusters.length > 0
                ? `${clusters.length} redundancy cluster${clusters.length !== 1 ? 's' : ''} found`
                : 'No redundant clusters at this threshold';
        }
        renderRedundancyClusters(clusters, hubScores, corr_matrix, variables);
        _renderCorrelationOverlay(_currentOverlayMode);
    }
    input.addEventListener('change', _recomputeStep4);
    input.addEventListener('input',  _recomputeStep4);
})();

// ── Extend runCorrBtn to also reveal toStep4Btn after results arrive ──────────
(function () {
    const statusMsg = document.getElementById('corrStatusMsg');
    if (!statusMsg) return;
    const observer = new MutationObserver(() => {
        if (lastCorrResults && lastCorrResults.variables && lastCorrResults.variables.length >= 2) {
            const btn = document.getElementById('toStep4Btn');
            if (btn) btn.classList.remove('d-none');
        }
    });
    observer.observe(statusMsg, { childList: true, subtree: true });
})();

// ── Kaiser criterion renderer ─────────────────────────────────────────────────
function renderKaiserCriterion(explainedVariance) {
    const kaiserEl = document.getElementById('kaiserCriterion');
    const kaiserText = document.getElementById('kaiserText');
    if (!kaiserEl || !kaiserText) return;
    if (!explainedVariance || !explainedVariance.length) { kaiserEl.classList.add('d-none'); return; }
    const nVars = explainedVariance.length;
    const threshold = 1 / nVars;
    const retained = explainedVariance.filter(ev => ev !== null && ev > threshold).length;
    kaiserEl.classList.remove('d-none');
    kaiserText.textContent = `Retain ${retained} component${retained !== 1 ? 's' : ''} `
        + `(eigenvalue > 1 rule: components explaining > ${(threshold * 100).toFixed(1)}% variance each)`;
}

// ── Confidence ellipses ───────────────────────────────────────────────────────
function computeEllipse(xs, ys, nStd) {
    nStd = nStd || 2;
    if (xs.length < 3) return null;
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    const covXX = xs.reduce((a, x) => a + (x - mx) ** 2, 0) / n;
    const covYY = ys.reduce((a, y) => a + (y - my) ** 2, 0) / n;
    const covXY = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / n;
    const tr = covXX + covYY;
    const det = covXX * covYY - covXY * covXY;
    const disc = Math.max(0, tr ** 2 / 4 - det);
    const l1 = tr / 2 + Math.sqrt(disc);
    const l2 = tr / 2 - Math.sqrt(disc);
    const angle = Math.atan2(l1 - covXX, covXY);
    const t = Array.from({ length: 100 }, (_, i) => (i / 99) * 2 * Math.PI);
    const ellX = t.map(a =>
        mx + nStd * Math.sqrt(Math.max(0, l1)) * Math.cos(a) * Math.cos(angle)
           - nStd * Math.sqrt(Math.max(0, l2)) * Math.sin(a) * Math.sin(angle));
    const ellY = t.map(a =>
        my + nStd * Math.sqrt(Math.max(0, l1)) * Math.cos(a) * Math.sin(angle)
           + nStd * Math.sqrt(Math.max(0, l2)) * Math.sin(a) * Math.cos(angle));
    return { x: ellX, y: ellY };
}


function _renderPcaEllipsesToggle(pcaResults, showEllipses) {
    const plotDiv = document.getElementById('pcaPlot');
    if (!plotDiv || !pcaResults || !pcaResults.scores) return;

    const scores = pcaResults.scores;
    const groups = [...new Set(scores.map(s => s.group))];
    const gd = plotDiv;
    if (!gd.data) return;

    const existingTraces = gd.data.filter(t => !t._isEllipse);

    if (!showEllipses) {
        Plotly.react(plotDiv, existingTraces, gd.layout, { responsive: true });
        return;
    }

    const ellipseTraces = [];
    groups.forEach(grp => {
        const pts = scores.filter(s => s.group === grp);
        const xs = pts.map(p => p.PC1).filter(v => v !== null && v !== undefined);
        const ys = pts.map(p => p.PC2).filter(v => v !== null && v !== undefined);
        const ell = computeEllipse(xs, ys, 2);
        if (!ell) return;
        const baseTrace = existingTraces.find(t => t.name === grp);
        const color = baseTrace && baseTrace.marker ? baseTrace.marker.color : '#aaaaaa';
        ellipseTraces.push({
            type: 'scatter', mode: 'lines',
            x: [...ell.x, ell.x[0]], y: [...ell.y, ell.y[0]],
            name: grp + ' (95% CI)',
            showlegend: false,
            _isEllipse: true,
            line: { color, width: 1.5, dash: 'dash' },
            hoverinfo: 'skip',
        });
    });

    Plotly.react(plotDiv, [...existingTraces, ...ellipseTraces], gd.layout, { responsive: true });
}

// ── Hook Kaiser criterion display into PCA results rendering ──────────────────
(function () {
    const pcaResultsEl = document.getElementById('pcaResults');
    if (!pcaResultsEl) return;
    const observer = new MutationObserver(() => {
        if (lastPCAResults && lastPCAResults.explained_variance) {
            renderKaiserCriterion(lastPCAResults.explained_variance);
        }
    });
    observer.observe(pcaResultsEl, { childList: true, subtree: true });
})();

// ─────────────────────────────────────────────────────────────────────────────
