const API_URL = '/run-statistics';
const EXPORT_URL = '/export-excel';
const MAX_DATA_ROWS = 100;
const MAX_DATA_COLUMNS = 50;
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

// ── Transformation state ──────────────────────────────────────────────────────
let appliedTransformations = {};  // { varName: { type: 'ln1p'|'sqrt'|'power'|'reciprocal'|'arcsin', power: Number } }
let lastTestResults = null;       // Cached after each run-tests call
let lastOriginalTestResults = null;  // When transforms active: results on original data
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
    const scopes = [{ key: 'all', label: 'All data', n: globalData.length, rawData: globalData }];
    if (!selectedFactors.length) return scopes;

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
            scopes.push({ key: `${factor}|||${level}`, label: `${factor} = ${level}`, n: filtered.length, rawData: filtered });
        });
    });
    return scopes;
}

/** Render the pill-style scope-switcher row above the sub-tabs. */
function renderAssumptionScopeTabs(scopes, activeKey) {
    const container = document.getElementById('assumptionsScopeTabs');
    if (!container) return;

    let html = '';
    let currentFactor = null;
    scopes.forEach(scope => {
        const isActive = scope.key === activeKey;
        const factor   = scope.key.includes('|||') ? scope.key.split('|||')[0] : null;

        if (factor && factor !== currentFactor) {
            currentFactor = factor;
            html += `<span class="scope-group-label flex-shrink-0">
                         <i class="bi bi-chevron-right" style="font-size:0.55rem;"></i> ${factor}:
                     </span>`;
        }

        const isCached = !!allScopeResults[scope.key];
        const btnCls   = isActive ? 'btn-primary'  : 'btn-outline-secondary';
        const badgeCls = isActive ? 'bg-white text-primary' : 'bg-secondary text-white';
        // Show a small cloud-download icon on tabs not yet fetched (except the active one)
        const lazyIcon = (!isCached && !isActive) ? ' <i class="bi bi-cloud-download" style="font-size:0.60rem; opacity:0.6;"></i>' : '';
        html += `<button type="button"
                    class="btn btn-sm scope-tab-btn flex-shrink-0 ${btnCls}"
                    style="font-size:0.73rem; padding:2px 10px; white-space:nowrap;"
                    data-scope-key="${scope.key}">
                    ${scope.label}${lazyIcon}
                    <span class="badge ms-1 ${badgeCls}" style="font-size:0.60rem;">${scope.n}</span>
                 </button>`;
    });
    container.innerHTML = html;
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
        } else {
            scopeInfo.style.display = 'block';
            scopeInfo.innerHTML = `
                <div class="alert alert-primary border-0 py-2 px-3 mb-2"
                     style="border-left:4px solid #0d6efd !important; font-size:0.78rem;">
                    <i class="bi bi-funnel-fill me-1"></i>
                    <strong>Subset:</strong> ${scope.label}
                    <span class="badge bg-primary ms-1" style="font-size:0.65rem;">${scope.n} rows</span>
                    <span class="text-muted ms-2" style="font-size:0.72rem;">
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
        banner.innerHTML = `<i class="bi bi-arrow-left-right me-1 text-warning"></i>
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
                <h5 class="fw-bold text-primary mb-0">Variable: ${res.variable}</h5>
                ${hasTransformForVar ? `<span class="badge bg-warning text-dark" style="font-size:0.72rem;"><i class="bi bi-arrow-left-right me-1"></i>${getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power)}</span>` : ''}
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
                <h6 class="fw-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                ${hasTransformForVar && origRes ? `
                    <div class="d-flex align-items-center mb-2 flex-wrap" style="gap:0.75rem;">
                        <span class="badge bg-warning text-dark" style="font-size:0.70rem;"><i class="bi bi-arrow-left-right me-1"></i>${transformLabel}</span>
                        <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                style="font-size:0.70rem; padding:2px 8px;"
                                data-transformed="${plotId}" data-original="${plotIdOrig}" data-showing="transformed">
                            <i class="bi bi-eye me-1"></i> Show Original
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
                    <h6 class="fw-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                    ${hasOrigPlotData ? `
                        <div class="d-flex align-items-center mb-2 flex-wrap" style="gap:0.75rem;">
                            <span class="badge bg-warning text-dark" style="font-size:0.70rem;"><i class="bi bi-arrow-left-right me-1"></i>${transformLabel}</span>
                            <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                    style="font-size:0.70rem; padding:2px 8px;"
                                    data-transformed="${divId}" data-original="${divIdOrig}" data-showing="transformed">
                                <i class="bi bi-eye me-1"></i> Show Original
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
                    <h6 class="fw-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                    ${hasOrigPlotData ? `
                        <div class="d-flex align-items-center mb-2 flex-wrap" style="gap:0.75rem;">
                            <span class="badge bg-warning text-dark" style="font-size:0.70rem;"><i class="bi bi-arrow-left-right me-1"></i>${transformLabel}</span>
                            <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                    style="font-size:0.70rem; padding:2px 8px;"
                                    data-transformed="${divId}" data-original="${divIdOrig}" data-showing="transformed">
                                <i class="bi bi-eye me-1"></i> Show Original
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

    const makePayload = (rawData) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: buildTransformedData(rawData, appliedTransformations), target_columns: selectedVars, factors: selectedFactors }),
        signal
    });
    const makeOrigPayload = (rawData) => ({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: rawData, target_columns: selectedVars, factors: selectedFactors }),
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
            ${blockLabel ? `<div class="fw-bold text-primary mb-2 small">${blockLabel}</div>` : ''}
            Homogeneity of variance (Levene's test):<br>
            <span class="badge bg-${leveneClass}">Variance is ${leveneText} (${leveneDetail})</span><br><br>
            Data normality (Shapiro-Wilk test):<br>
            <span class="badge bg-${normBadgeCls} mb-2">${normText}</span>
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
        return `<span class="badge bg-${cls}">${txt}</span>`;
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
                <div><small class="text-muted">Original:</small><br><span class="badge bg-${o.cls}">Variance ${o.txt} (${o.p})</span></div>
                <div><small class="text-muted">Transformed:</small><br><span class="badge bg-${t.cls}">Variance ${t.txt} (${t.p})</span></div>
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
        tag.className = "badge bg-primary d-flex align-items-center gap-2 p-2 mb-1 cursor-pointer animate__animated animate__fadeIn";
        tag.style.fontSize = "0.85rem";
        tag.style.borderRadius = "8px";

        tag.innerHTML = `
            <span>${index + 1}. ${factor}</span>
            <i class="bi bi-x-circle-fill text-white-50 hover-white"></i>
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
        const summaryContainer = section.querySelector('.var-summary-content');
        if (summaryContainer) {
            summaryContainer.innerHTML = buildVariableSummaryHTML(varResults, mode, varName);
            // Re-render Plotly bar charts into newly inserted placeholder divs
            summaryContainer.querySelectorAll('.anova-bar-chart-placeholder').forEach(div => {
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
                } catch (e) { /* skip */ }
            });
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
        <i class="bi bi-info-circle-fill me-2"></i> ${message}
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

    let boxTrace;
    if (groupOrder.length && groupOrder.every(g => statsByGroup[g])) {
        boxTrace = {
            x: groupOrder.map((_, i) => i),
            q1: groupOrder.map(g => statsByGroup[g].q1),
            median: groupOrder.map(g => statsByGroup[g].median),
            q3: groupOrder.map(g => statsByGroup[g].q3),
            lowerfence: groupOrder.map(g => statsByGroup[g].lowerfence),
            upperfence: groupOrder.map(g => statsByGroup[g].upperfence),
            type: 'box',
            boxpoints: false,
            showlegend: false,
            line: { width: 1.5 },
            fillcolor: 'rgba(128,128,128,0.2)',
        };
    } else {
        boxTrace = {
            x: xBox,
            y: yBox,
            type: 'box',
            boxpoints: 'outliers',
            marker: { opacity: 0 },
            quartilemethod: 'linear',
            showlegend: false,
            line: { width: 1.5 },
            fillcolor: 'rgba(128,128,128,0.2)',
        };
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
    };

    const plotDiv = document.getElementById(containerId);
    if (!plotDiv) return;
    Plotly.newPlot(containerId, [boxTrace, scatterTrace], layout, { responsive: true });

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

    let boxTraces;
    if (groupOrder.length && groupOrder.every(g => statsByGroup[g])) {
        boxTraces = groupOrder.map((grp, gi) => {
            const s = statsByGroup[grp];
            const isNormal = normalityByGroup && normalityByGroup[grp];
            const fillColor = isNormal ? 'rgba(161,217,155,0.6)' : 'rgba(247,150,158,0.6)';
            return {
                x: [gi],
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
        boxTraces = groupOrder.map((grp, gi) => {
            const pts = plotData.filter(p => p.group === grp);
            const isNormal = normalityByGroup && normalityByGroup[grp] === true;
            const fillColor = isNormal ? 'rgba(161,217,155,0.6)' : 'rgba(247,150,158,0.6)';
            return {
                x: pts.map(() => gi),
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
                <i class="bi bi-check-circle-fill me-2"></i>
                <strong>All variables passed</strong> normality and homogeneity tests.
                Transformations are optional and may not improve results.
            </div>`;
    } else {
        const rows = candidates.map(c => `
            <div class="d-flex align-items-center flex-wrap gap-1 mb-1" style="font-size:0.78rem;">
                <span class="fw-semibold" style="min-width:90px; flex-shrink:0;">${c.varName}</span>
                ${c.issues.map(issue => `
                    <span class="badge" style="background:${issue.includes('normality') ? '#dc3545' : '#fd7e14'}; font-size:0.63rem;">
                        ${issue}
                    </span>`).join('')}
                <span class="text-muted ms-1">→ suggested:
                    <strong>${getTransformLabel(c.suggestion)}</strong>
                </span>
            </div>`).join('');

        const whenToUseGuide = `
            <details class="mt-2 mb-0">
                <summary style="font-size:0.70rem; cursor:pointer; color:#856404; font-weight:600;">
                    <i class="bi bi-info-circle me-1"></i> When to use which transformation
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
                <div class="fw-bold mb-2">
                    <i class="bi bi-exclamation-triangle-fill me-1"></i>
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
            statusIcon = `<span class="text-muted" title="No data"><i class="bi bi-dash-circle"></i> No data</span>`;
        } else if (!failedNorm && !failedHomo) {
            statusIcon = `<span class="text-success" title="All tests passed"><i class="bi bi-check-circle-fill"></i> Both passed</span>`;
        } else {
            const parts = [];
            if (failedNorm) parts.push('Normality not met');
            if (failedHomo) parts.push('Homogeneity not met');
            statusIcon = `<span class="text-danger" title="Failed: ${parts.join(', ')}">
                            <i class="bi bi-x-circle-fill"></i> ${parts.join('<br>')}</span>`;
        }

        // Suggested action column — static text only, no click
        let suggestCell;
        if (isActive) {
            suggestCell = `<span class="text-success extra-small fw-semibold">
                            <i class="bi bi-check-circle-fill me-1"></i>${getTransformLabel(currentTf.type, currentTf.power)}
                           </span>`;
        } else if (suggestion) {
            suggestCell = `<span class="extra-small text-warning fw-semibold">${getTransformLabel(suggestion)}</span>`;
        } else {
            suggestCell = `<span class="extra-small text-muted">—</span>`;
        }

        // "Used" column — shows the last applied transformation (from appliedTransformations state)
        const usedTf = appliedTransformations[varName];
        const usedActive = usedTf && usedTf.type && usedTf.type !== 'none';
        let usedCell;
        if (usedActive) {
            usedCell = `<span class="extra-small fw-semibold" style="color:#0a6640;">
                            <i class="bi bi-check-circle-fill me-1"></i>${getTransformLabel(usedTf.type, usedTf.power)}
                        </span>`;
        } else {
            usedCell = `<span class="extra-small text-muted">—</span>`;
        }

        return `
        <div class="row g-0 align-items-center py-2 px-2 border-bottom"
             style="font-size:0.8rem; ${rowBg}">
            <div class="col-3 fw-semibold text-truncate pe-2" title="${varName}">${varName}</div>
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
    const headers = rows[0].split(/\t| {2,}/).map(h => h.trim()).filter(h => h !== "");

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
        const values = row.split(/\t| {2,}/).map(v => v.trim());
        let obj = { row_id: index + 1 }; // 1-based persistent row index
        headers.forEach((h, i) => {
            let val = (values[i] || "").replace(',', '.'); // Normalize decimal

            if (val === "") {
                obj[h] = "N/A";
            } else {
                // Remove text from values intended to be numeric (e.g. "0.04 h-1" -> "0.04")
                let cleanVal = val.replace(/[^-0-9.]/g, '');
                if (cleanVal !== "" && !isNaN(cleanVal)) {
                    obj[h] = parseFloat(cleanVal);
                } else {
                    obj[h] = val; // Keep as string for Factors
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

        const container = document.getElementById('checkboxContainer');
        container.innerHTML = "";
        result.variables.forEach(v => {
            container.innerHTML += `
                <div class="form-check mb-1">
                    <input class="form-check-input var-check" type="checkbox" value="${v}" id="v_${v}">
                    <label class="form-check-label small" for="v_${v}">${v}</label>
                </div>`;
        });

        // Add change listeners to variable checkboxes for responsive "Select All"
        document.querySelectorAll('.var-check').forEach(cb => {
            cb.addEventListener('change', updateSelectAllState);
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
    const anovaTab = document.getElementById('anova-tab');
    if (anovaTab) anovaTab.style.display = 'none';
    const exportFullReportBtn = document.getElementById('exportFullReportBtn');
    if (exportFullReportBtn) exportFullReportBtn.style.display = 'none';
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
    const anovaTab = document.getElementById('anova-tab');
    if (anovaTab) anovaTab.style.display = 'none';
    const downloadAnovaExcelBtn = document.getElementById('downloadAnovaExcelBtn');
    if (downloadAnovaExcelBtn) downloadAnovaExcelBtn.style.display = 'none';
    lastAnovaResults = null;

    // PCA
    const pcaResults = document.getElementById('pcaResults');
    if (pcaResults) pcaResults.innerHTML = '';
    const pcaResultsHeader = document.getElementById('pcaResultsHeader');
    if (pcaResultsHeader) pcaResultsHeader.style.display = 'none';
    lastPCAResults = null;
    // ────────────────────────────────────────────────────────────────────────

    document.getElementById('resultsArea').style.display = 'block';
    document.getElementById('placeholderText').style.display = 'none';
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
                    <h6 class="fw-bold border-bottom pb-2">${res.variable}</h6>
                    <div class="text-center overflow-auto">
                        ${plotBlock}
                    </div>
                    <details>
                        <summary class="small text-primary cursor-pointer fw-bold">View Data Table</summary>
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

// 2. Updated runPCABtn Event Listener
document.getElementById('runPCABtn').addEventListener('click', function() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);
    const removeMissing = document.getElementById('pcaRemoveMissing').checked;
    const averageByFactor = document.getElementById('pcaAverageByFactor').checked;
    const showLoadings = document.getElementById('pcaShowLoadings').checked;

    if (selectedVars.length < 2) {
        return alert("PCA requires at least 2 variables to compare.");
    }

    const pcaResults = document.getElementById('pcaResults');
    const pcaSpinner = document.getElementById('pcaSpinner');
    const pcaHeader = document.getElementById('pcaResultsHeader');

    // 1. CLEAR AND HIDE EVERYTHING AT START
    pcaResults.innerHTML = "";
    pcaHeader.style.display = 'none';
    pcaSpinner.style.display = 'block';

    fetch('/run-pca', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: globalData,
            variables: selectedVars,
            factors: selectedFactors,
            remove_missing: removeMissing,
            average_by_factors: averageByFactor,
            plot_loadings: showLoadings
        })
    })
    .then(res => res.json())
    .then(result => {
        pcaSpinner.style.display = 'none';
        if (result.error) throw new Error(result.error);

        lastPCAResults = result;

        // 2. SHOW THE HEADER ONLY NOW
        pcaHeader.style.display = 'flex';

        pcaResults.innerHTML = `
            <div class="plot-card-wrapper bg-white p-3 rounded shadow-sm border mb-3 text-center">
                <img src="data:image/png;base64,${result.plot_url}" class="img-fluid rounded shadow-sm">
            </div>
            <div class="alert alert-success py-2 small shadow-sm text-left">
                <strong>PCA Success:</strong> ${result.n_samples} samples analyzed
                    (${selectedVars.length} variables, ${selectedFactors.length} factors).
                <br>PC1 explains ${(result.explained_variance[0] * 100).toFixed(1)}% of variance.
                <br>PC2 explains ${(result.explained_variance[1] * 100).toFixed(1)}% of variance.
            </div>
        `;
    })
    .catch(err => {
        pcaSpinner.style.display = 'none';
        pcaHeader.style.display = 'none'; // Keep hidden on error
        alert("PCA Error: " + err.message);
    });
});

// --- 6. PCA Export & UI Logic ---

// This listener handles the actual Excel download for PCA
document.getElementById('downloadPCAExcelBtn').addEventListener('click', function() {
    // Keep this as a safety "guard clause," but the alert is unnecessary
    // because the button is hidden until results are ready.
    if (!lastPCAResults) return;

    // Use the coordinates/table already processed and returned by the server
    // this includes the PC1 and PC2 scores we want in the Excel file.
    fetch('/export-pca-excel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pca_details: {
                n_samples: lastPCAResults.n_samples,
                variance: lastPCAResults.explained_variance,
                plot_url: lastPCAResults.plot_url,
                coordinates: lastPCAResults.pca_table, // This contains original data + scores
                loadings: lastPCAResults.loadings      // This contains the arrow data
            }
        })
    })
    .then(res => {
        if (!res.ok) throw new Error("Export failed");
        return res.blob();
    })
    .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "PCA_Full_Analysis_Report.xlsx";
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    })
    .catch(err => alert("Export Error: " + err.message));
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

        // Unhide the ANOVA tab
        const anovaTab = document.getElementById('anova-tab');
        anovaTab.style.display = 'block';
        anovaTab.classList.add('animate__animated', 'animate__fadeIn');
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

        // Show export button
        if (exportBtn) exportBtn.style.display = 'inline-flex';

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

// ── ANOVA Plotly bar chart (mean ± SD with letter annotations) ────────────────
/**
 * Render a mean ± SD bar chart with compact letter display (CLD) above bars.
 * containerId: id of the target div; letterGroups: [{group,mean,std,n,letter}];
 * res: the full ANOVA result object (for p, test name, variable name).
 */
function renderAnovaBarChart(containerId, letterGroups, res) {
    if (!window.Plotly || !letterGroups || !letterGroups.length) return;
    const el = document.getElementById(containerId);
    if (!el) return;

    const groups = letterGroups.map(g => g.group);
    const means  = letterGroups.map(g => g.mean);
    const stds   = letterGroups.map(g => g.std);
    const ns     = letterGroups.map(g => g.n);
    const letters = letterGroups.map(g => g.letter);
    const n = groups.length;

    // Color bars with a spectral-like hue spread
    const colors = groups.map((_, i) => `hsl(${Math.round(i / Math.max(n - 1, 1) * 260 + 20)}, 65%, 55%)`);

    const trace = {
        x: groups,
        y: means,
        error_y: { type: 'data', array: stds, visible: true, color: '#555', thickness: 1.5, width: 5 },
        type: 'bar',
        marker: { color: colors, line: { color: '#333', width: 0.5 } },
        hovertemplate: groups.map((g, i) =>
            `<b>${g}</b><br>Mean: ${means[i].toFixed(4)}<br>SD: ${stds[i].toFixed(4)}<br>N: ${ns[i]}<br>Letter: <b>${letters[i]}</b><extra></extra>`
        ),
    };

    // Letter annotations positioned just above the top of the error bar
    const yMax = Math.max(...means.map((m, i) => m + (stds[i] || 0)));
    const yRange = yMax - Math.min(...means);
    const offset = (yRange > 0 ? yRange : Math.abs(yMax)) * 0.04 + 0.001;
    const annotations = letterGroups.map((g, i) => ({
        x: g.group,
        y: g.mean + (g.std || 0) + offset,
        text: `<b>${g.letter}</b>`,
        showarrow: false,
        font: { size: 13, color: '#111' },
        yanchor: 'bottom',
    }));

    const overallP = res.overall_p !== null ? res.overall_p.toFixed(4) : '—';
    const testInfo = `${res.test_used || ''} | p = ${overallP}` +
        (res.effect_size != null ? ` | ${res.effect_size_label || 'η²'} = ${res.effect_size.toFixed(3)}` : '');

    const layout = {
        xaxis: { tickangle: groups.length > 6 ? -35 : 0, automargin: true },
        yaxis: { title: res.variable || '', zeroline: true, zerolinewidth: 1, zerolinecolor: '#ccc' },
        margin: { t: 28, b: 80, l: 60, r: 16 },
        bargap: 0.3,
        annotations: [
            ...annotations,
            { x: 0, y: 1.04, xref: 'paper', yref: 'paper', text: testInfo,
              showarrow: false, font: { size: 9, color: '#555' }, xanchor: 'left' }
        ],
        autosize: true,
        height: 340,
        plot_bgcolor: 'white',
        paper_bgcolor: 'white',
    };

    Plotly.newPlot(containerId, [trace], layout, { responsive: true, displayModeBar: false });
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Helper: build the summary table HTML for one variable's results ───────────
function buildVariableSummaryHTML(varResults, sortMode, varName) {
    let html = '';

    const sortBtnsInline = varName ? (() => {
        const sortBtns = ['data_order', 'letter', 'mean_asc', 'mean_desc'];
        const sortLabels = { data_order: 'Data Order', letter: 'Letter Group', mean_asc: 'Mean ↑', mean_desc: 'Mean ↓' };
        const btns = sortBtns.map(s => `
            <button type="button"
                    class="btn btn-sm var-sort-btn ${s === (sortMode || 'data_order') ? 'btn-secondary active' : 'btn-outline-secondary'}"
                    data-var="${varName}" data-sort="${s}"
                    style="font-size:0.72rem; padding:2px 8px;">
                ${sortLabels[s]}
            </button>`).join('');
        return `
            <div class="d-flex align-items-center gap-2 flex-wrap mb-2 mt-1">
                <span class="small fw-bold text-muted" style="font-size:0.78rem;">
                    <i class="bi bi-sort-down me-1"></i>Sort groups by:
                </span>
                <span style="display:inline-block; width:0.5rem;"></span>
                <div class="btn-group btn-group-sm" role="group">${btns}</div>
            </div>`;
    })() : '';

    let sliceIdx = 0;
    varResults.forEach(res => {
        const sliceInfo = res.slice_label && res.slice_label !== 'All'
            ? `<span class="text-muted">${res.slice_label}</span>`
            : 'All groups';

        const sortedGroups = sortLetterGroups(res.letter_groups, sortMode || 'data_order');
        const chartId = `anova-bar-${(varName || 'v').replace(/\W/g, '_')}-${sliceIdx++}`;

        if (sortedGroups && sortedGroups.length > 0) {
            html += `
                <div class="border rounded p-3 mb-4 bg-white shadow-sm">
                    <div class="d-flex justify-content-between align-items-center mb-2">
                        <h6 class="mb-0 fw-bold">${sliceInfo}</h6>
                        <span class="badge bg-primary">${res.test_used}</span>
                    </div>
                    <div id="${chartId}" class="anova-bar-chart-placeholder mb-3"
                         data-letter-groups="${encodeURIComponent(JSON.stringify(sortedGroups))}"
                         data-res-variable="${encodeURIComponent(res.variable || '')}"
                         data-res-test="${encodeURIComponent(res.test_used || '')}"
                         data-res-p="${res.overall_p !== null ? res.overall_p : ''}"
                         data-res-effect="${res.effect_size !== null && res.effect_size !== undefined ? res.effect_size : ''}"
                         data-res-effect-label="${encodeURIComponent(res.effect_size_label || 'η²')}"
                         style="height:340px;">
                    </div>
                    <div class="alert alert-info py-2 small mb-2">
                        <strong>Overall p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}</strong> |
                        Normality: ${res.assumptions && res.assumptions.all_normal ? '✓' : '✗'} |
                        Homogeneity: ${res.assumptions && res.assumptions.homogeneous ? '✓' : '✗'}
                        ${res.effect_size != null ? ` | Effect size: ${res.effect_size_label || 'η²'} = ${res.effect_size.toFixed(3)}` : ''}
                    </div>
                    ${sortBtnsInline}
                    <table class="table table-sm table-bordered text-center">
                        <thead class="table-light">
                            <tr><th class="text-left">Group</th><th>Mean</th><th>SD</th><th>N</th><th>Letter</th></tr>
                        </thead>
                        <tbody>
                            ${sortedGroups.map(lg => `
                                <tr>
                                    <td class="text-left fw-bold">${lg.group}</td>
                                    <td>${lg.mean.toFixed(4)}</td>
                                    <td>${lg.std.toFixed(4)}</td>
                                    <td>${lg.n}</td>
                                    <td>
                                        <span class="badge fs-6" style="padding: 6px 14px; border-radius: 50px; ${getLetterGroupStyle(lg.letter)}">
                                            ${lg.letter}
                                        </span>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>`;
        } else {
            html += `
                <div class="mb-3">
                    <div class="alert alert-secondary py-2 small">
                        ${sliceInfo}: No significant differences found (p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}).
                        All groups share the same letter
                        <span class="badge fs-6" style="padding: 5px 12px; border-radius: 12px; ${getLetterGroupStyle('a')}">a</span>.
                    </div>
                </div>`;
        }
    });
    return html;
}

// ── Render ANOVA results (called on first run and on re-sort) ─────────────────
function renderAnovaResults(data) {
    const anovaResults = document.getElementById('anovaResults');
    anovaResults.innerHTML = '';

    // Test selection rationale banner (from backend)
    if (data.test_rationale) {
        const rationale = document.createElement('div');
        rationale.className = 'alert alert-info border-0 shadow-sm mb-4 py-2 px-3 small';
        rationale.innerHTML = `<i class="bi bi-cpu-fill me-2"></i><strong>Test Selected:</strong> ${data.test_rationale}`;
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

    let varIdx = 0;
    varOrder.forEach(varName => {
        const varResults = byVariable[varName];
        const varId = 'anova_var_' + varIdx++;
        const currentSortMode = anovaVarSortModes[varName] || 'data_order';

        const section = document.createElement('div');
        section.className = "mb-5 p-4 border rounded bg-white shadow-sm anova-var-section";
        section.dataset.varName = varName;

        // Build detailed pairwise HTML
        let detailedHTML = '';
        varResults.forEach(res => {
            const sliceInfo = res.slice_label && res.slice_label !== 'All'
                ? ' <small class="text-muted fw-normal">(' + res.slice_label + ')</small>'
                : '';
            if (res.posthoc && res.posthoc.length > 0) {
                detailedHTML += `
                    <div class="mb-3">
                        <div class="d-flex justify-content-between align-items-center mb-2">
                            <span class="fw-bold small">${sliceInfo || 'All groups'}</span>
                            <span class="badge bg-primary">${res.test_used}</span>
                        </div>
                        <div class="alert alert-info py-1 small mb-2">
                            <strong>Overall p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}</strong>
                            ${res.posthoc_method ? ` | Post-hoc: ${res.posthoc_method}` : ''}
                        </div>
                        <table class="table table-sm table-bordered">
                            <thead class="table-light">
                                <tr><th>Comparison</th><th>p (adj.)</th><th></th></tr>
                            </thead>
                            <tbody>
                                ${res.posthoc.map(ph => `
                                    <tr>
                                        <td><strong>${ph.group1}</strong> vs <strong>${ph.group2}</strong></td>
                                        <td>${ph.p_adj.toFixed(4)}</td>
                                        <td>${ph.significant ?
                                            '<span class="badge bg-success">Significant</span>' :
                                            '<span class="badge bg-secondary">n.s.</span>'}
                                        </td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>`;
            } else {
                detailedHTML += `
                    <div class="mb-3">
                        <div class="alert alert-secondary py-2 small">
                            ${sliceInfo || 'All groups'}: No pairwise comparisons (overall p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}).
                        </div>
                    </div>`;
            }
        });

        section.innerHTML = `
            <h5 class="fw-bold text-success mb-3">${varName}</h5>
            <ul class="nav nav-tabs custom-anova-tabs mb-3" role="tablist">
                <li class="nav-item">
                    <button class="nav-link active small fw-bold" data-toggle="tab" data-target="#${varId}_summary">
                        <i class="bi bi-bar-chart-line me-2"></i> Summary with Plots
                    </button>
                </li>
                <li class="nav-item">
                    <button class="nav-link small fw-bold" data-toggle="tab" data-target="#${varId}_detail">
                        <i class="bi bi-list-check me-2"></i> Detailed Pairwise
                    </button>
                </li>
            </ul>
            <div class="tab-content">
                <div class="tab-pane fade show active" id="${varId}_summary" role="tabpanel">
                    <div class="var-summary-content">
                        ${buildVariableSummaryHTML(varResults, currentSortMode, varName)}
                    </div>
                </div>
                <div class="tab-pane fade" id="${varId}_detail" role="tabpanel">
                    ${detailedHTML}
                </div>
            </div>
        `;
        anovaResults.appendChild(section);

        // Render Plotly bar charts into the placeholder divs just added to the DOM
        section.querySelectorAll('.anova-bar-chart-placeholder').forEach(div => {
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
            } catch (e) { /* skip if data is malformed */ }
        });
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
        btn.innerHTML = '<i class="bi bi-eye-slash me-1"></i> Show Transformed';
        btn.classList.remove('btn-outline-secondary');
        btn.classList.add('btn-outline-warning');
    } else {
        // Switch back to transformed
        transformedEl.style.display = 'block';
        originalEl.style.display = 'none';
        if (transformedEl.classList.contains('js-plotly-plot')) Plotly.Plots.resize(transformedEl);
        btn.setAttribute('data-showing', 'transformed');
        btn.innerHTML = '<i class="bi bi-eye me-1"></i> Show Original';
        btn.classList.remove('btn-outline-warning');
        btn.classList.add('btn-outline-secondary');
    }
});