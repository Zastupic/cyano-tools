const API_URL = '/run-statistics';
const EXPORT_URL = '/export-excel';
const MAX_DATA_ROWS = 100;
const MAX_DATA_COLUMNS = 50;
let globalData = null;
let lastResults = null;
let selectedFactors = [];
let lastAnovaResults = null;
let lastPCAResults = null;

// ── Transformation state ──────────────────────────────────────────────────────
let appliedTransformations = {};  // { varName: { type: 'ln1p'|'sqrt'|'power'|'reciprocal'|'arcsin', power: Number } }
let lastTestResults = null;       // Cached after each run-tests call
let lastOriginalTestResults = null;  // When transforms active: results on original data
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
        return;
    }

    if (selectedFactors.length === 1) {
        container.style.display = 'block';
        select.innerHTML = '<option value="all_combined">' + selectedFactors[0] + ' (all levels)</option>';
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
}

window.removeFactor = function(factorName) {
    selectedFactors = selectedFactors.filter(f => f !== factorName);
    renderFactorTags();
};

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

        candidatesDiv.innerHTML = `
            <div class="alert alert-warning py-2 px-3 mb-0" style="font-size:0.78rem;">
                <div class="fw-bold mb-2">
                    <i class="bi bi-exclamation-triangle-fill me-1"></i>
                    Transformation Candidates (${candidates.length} variable${candidates.length > 1 ? 's' : ''})
                </div>
                ${rows}
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
            <div class="col-3 d-flex align-items-center gap-1">
                <select class="form-select form-select-sm transform-type-select"
                        data-var="${varName}"
                        style="font-size:0.76rem; min-width:0;"
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
                       value="${currentTf.power || 2}"
                       min="0.1" max="10" step="0.5"
                       title="Exponent (n) for power transform"
                       style="width:38px; font-size:0.76rem; padding:2px 4px; flex-shrink:0;
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
        document.getElementById('placeholderText').style.display = 'none';
        document.getElementById('downloadExcelBtn').style.display = 'none';
        hideDataLimitError();
    })
    .catch(err => alert("Loading Error: " + err.message));
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

    // Clear and show loading
    loadingSpinner.style.display = 'flex';
    statsContent.innerHTML = "";

    fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: globalData,
            target_columns: selectedVars,
            factors: selectedFactors
        })
    })
    .then(res => res.json())
    .then(result => {
        loadingSpinner.style.display = 'none';
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
            alert("Visualization Error: " + err.message);
        });
});

document.getElementById('downloadExcelBtn').addEventListener('click', function() {
    if (!lastResults) return;
    fetch(EXPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastResults)
    })
    .then(res => res.blob())
    .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "lab_report.xlsx";
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
    });
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

    testResults.innerHTML = "";
    testSpinner.style.display = 'block';

    // Hide the transformation panel while calculations run (spinner visible)
    const transformPanel = document.getElementById('transformationPanel');
    if (transformPanel && transformPanel.style.display !== 'none') transformPanel.setAttribute('data-was-visible', '1');
    if (transformPanel) transformPanel.style.display = 'none';

    // Hide the results area while loading 
    if (resultsArea) resultsArea.style.display = 'none';

    // Apply any active transformations before sending to backend
    const dataToSend = buildTransformedData(globalData, appliedTransformations);

    // Show a banner in results area if transforms are active
    const hasTransforms = Object.values(appliedTransformations).some(t => t && t.type && t.type !== 'none');

    function runTestsPayload(data) {
        return {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: data,
                target_columns: selectedVars,
                factors: selectedFactors
            })
        };
    }

    function renderOneAssumptionBlock(res, blockLabel) {
        const leveneClass = res.levene.is_homogeneous === null ? 'secondary' : (res.levene.is_homogeneous ? 'success' : 'danger');
        const leveneText = res.levene.is_homogeneous === null ? 'N/A' : (res.levene.is_homogeneous ? 'equal' : 'unequal');
        const leveneDetail = res.levene.p != null ? `Levene p = ${res.levene.p.toFixed(4)}` : 'Levene: N/A (single group)';

        // Compute normality summary (all-groups pass/fail)
        const allNormal = res.shapiro && res.shapiro.length > 0 && res.shapiro.every(s => s.is_normal);
        const normCount = res.shapiro ? res.shapiro.filter(s => s.is_normal).length : 0;
        const normTotal = res.shapiro ? res.shapiro.length : 0;
        const normalityBadgeClass = allNormal ? 'success' : (normCount > 0 ? 'warning' : 'danger');
        const normalityText = allNormal
            ? `Normal distribution in all groups (${normCount}/${normTotal} groups, p > 0.05)`
            : normCount > 0
                ? `Normality met in ${normCount}/${normTotal} groups`
                : `Normality not met in any group`;

        return `
            <div class="mb-3 ${blockLabel ? 'ps-2 border-start border-3 border-primary' : ''}">
                ${blockLabel ? `<div class="fw-bold text-primary mb-2 small">${blockLabel}</div>` : ''}
                Homogeneity of variance (Levene's test):<br>
                <span class="badge bg-${leveneClass}">Variance is ${leveneText} (${leveneDetail})</span>
                <br><br>
                Data normality (Shapiro-Wilk test):<br>
                <span class="badge bg-${normalityBadgeClass} mb-2">${normalityText}</span>
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

    /**
     * Render side-by-side original+transformed assumption results into a single block.
     * origRes = original test result, transRes = transformed test result.
     */
    function renderSideBySideAssumptionBlock(origRes, transRes) {
        function leveneInfo(res) {
            const cls = res.levene.is_homogeneous === null ? 'secondary' : (res.levene.is_homogeneous ? 'success' : 'danger');
            const txt = res.levene.is_homogeneous === null ? 'N/A' : (res.levene.is_homogeneous ? 'equal' : 'unequal');
            const p = res.levene.p != null ? `p = ${res.levene.p.toFixed(4)}` : 'N/A';
            return { cls, txt, p };
        }
        const o = leveneInfo(origRes);
        const t = leveneInfo(transRes);

        const oAllNormal = origRes.shapiro && origRes.shapiro.every(s => s.is_normal);
        const tAllNormal = transRes.shapiro && transRes.shapiro.every(s => s.is_normal);
        const oNormCount = origRes.shapiro ? origRes.shapiro.filter(s => s.is_normal).length : 0;
        const tNormCount = transRes.shapiro ? transRes.shapiro.filter(s => s.is_normal).length : 0;
        const normTotal = origRes.shapiro ? origRes.shapiro.length : 0;

        function normBadge(count, total, allNorm) {
            const cls = allNorm ? 'success' : (count > 0 ? 'warning' : 'danger');
            const txt = allNorm ? `All groups normal (${count}/${total})` : count > 0 ? `${count}/${total} groups normal` : `Not met (0/${total})`;
            return `<span class="badge bg-${cls}">${txt}</span>`;
        }

        // Build unified Shapiro table with both columns
        const groups = origRes.shapiro.map(s => s.group);
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
                    <div><small class="text-muted">Original:</small><br>
                        <span class="badge bg-${o.cls}">Variance ${o.txt} (${o.p})</span></div>
                    <div><small class="text-muted">Transformed:</small><br>
                        <span class="badge bg-${t.cls}">Variance ${t.txt} (${t.p})</span></div>
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

    const fetchTransformed = fetch('/run-tests', runTestsPayload(dataToSend)).then(r => r.json());
    const fetchOriginal = hasTransforms
        ? fetch('/run-tests', runTestsPayload(globalData)).then(r => r.json())
        : Promise.resolve(null);

    Promise.all([fetchTransformed, fetchOriginal])
    .then(([data, originalData]) => {
        testSpinner.style.display = 'none';
        const resultsArea = document.getElementById('assumptionsResultsArea');
        if (resultsArea) resultsArea.style.display = 'block';

        // Restore the transformation panel now that calculations are done
        const transformPanel = document.getElementById('transformationPanel');
        if (transformPanel) transformPanel.style.display = 'block';

        if (data.error) throw new Error(data.error);
        if (originalData && originalData.error) throw new Error(originalData.error);

        lastTestResults = data;
        lastOriginalTestResults = originalData || null;

        populateTransformationPanel(data.results, selectedVars);

        const factorsLabel = selectedFactors.join(', ');
        const originalByVar = (lastOriginalTestResults && lastOriginalTestResults.results)
            ? lastOriginalTestResults.results.reduce((acc, r) => { acc[r.variable] = r; return acc; }, {})
            : {};

        if (hasTransforms) {
            const activeList = Object.entries(appliedTransformations)
                .filter(([, cfg]) => cfg && cfg.type && cfg.type !== 'none')
                .map(([v, cfg]) => `<strong>${v}</strong>: ${getTransformLabel(cfg.type, cfg.power)}`)
                .join(' &nbsp;|&nbsp; ');
            const banner = document.createElement('div');
            banner.className = 'alert alert-info py-2 px-3 mb-3 small';
            banner.style.fontSize = '0.78rem';
            banner.innerHTML = `<i class="bi bi-arrow-left-right me-1 text-warning"></i>
                <strong>Tests run on transformed data.</strong> Active transformations: ${activeList}.
                Use <em>Reset to Original Data</em> in the panel above to revert.`;
            testResults.appendChild(banner);
        }

        // Normality sub-tab: summary per variable; for transformed vars show side-by-side columns
        data.results.forEach(res => {
            const section = document.createElement('div');
            section.className = "mb-4 p-4 border rounded bg-white shadow-sm";
            const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
            const origRes = hasTransformForVar ? originalByVar[res.variable] : null;

            let bodyHtml = '';
            if (origRes) {
                bodyHtml += renderSideBySideAssumptionBlock(origRes, res);
            } else {
                bodyHtml += renderOneAssumptionBlock(res, null);
            }
            section.innerHTML = `
                <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
                    <h5 class="fw-bold text-primary mb-0">Variable: ${res.variable}</h5>
                    ${hasTransformForVar ? `<span class="badge bg-warning text-dark" style="font-size:0.72rem;"><i class="bi bi-arrow-left-right me-1"></i>Transformation method used: ${getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power)}</span>` : ''}
                </div>
                ${bodyHtml}
            `;
            testResults.appendChild(section);
        });

        // Box Plots sub-tab: interactive Plotly with green/red by normality, click-to-remove outliers
        const assumptionsBoxPlots = document.getElementById('assumptionsBoxPlots');
        if (assumptionsBoxPlots) {
            assumptionsBoxPlots.innerHTML = '';
            data.results.forEach((res, resIdx) => {
                const normalityByGroup = {};
                if (res.shapiro) res.shapiro.forEach(s => { normalityByGroup[s.group] = !!s.is_normal; });

                const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
                const origRes = hasTransformForVar ? originalByVar[res.variable] : null;

                const card = document.createElement('div');
                card.className = 'plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border mb-4';
                const plotDivId = 'assumptions-plot-' + resIdx + '-' + (res.variable || '').replace(/\W/g, '_');
                const plotDivIdOrig = plotDivId + '-orig';
                const transformLabel = hasTransformForVar ? getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power) : '';

                const toggleBtnHtml = hasTransformForVar && origRes ? `
                    <div class="d-flex align-items-center gap-3 mb-2 flex-wrap">
                        <span class="badge bg-warning text-dark" style="font-size:0.70rem;"><i class="bi bi-arrow-left-right me-1"></i>Transformation method used: ${transformLabel}</span>
                        <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                style="font-size:0.70rem; padding:2px 8px;"
                                data-transformed="${plotDivId}" data-original="${plotDivIdOrig}"
                                data-showing="transformed">
                            <i class="bi bi-eye me-1"></i> Show Original
                        </button>
                    </div>` : '';

                card.innerHTML = `
                    <h6 class="fw-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                    ${toggleBtnHtml}
                    <div id="${plotDivId}" class="assumptions-plot-container"></div>
                    ${hasTransformForVar && origRes ? `<div id="${plotDivIdOrig}" class="assumptions-plot-container" style="display:none;"></div>` : ''}`;
                assumptionsBoxPlots.appendChild(card);

                if (res.plot_data && res.plot_data.length) {
                    renderPlotlyBoxSwarmAssumptions(plotDivId, res.plot_data, hasTransformForVar ? res.variable + ' (transformed)' : res.variable, factorsLabel, normalityByGroup, 'runTestsBtn', res.box_stats);
                }
                if (hasTransformForVar && origRes && origRes.plot_data && origRes.plot_data.length) {
                    const origNormalityByGroup = {};
                    if (origRes.shapiro) origRes.shapiro.forEach(s => { origNormalityByGroup[s.group] = !!s.is_normal; });
                    renderPlotlyBoxSwarmAssumptions(plotDivIdOrig, origRes.plot_data, res.variable + ' (original)', factorsLabel, origNormalityByGroup, 'runTestsBtn', origRes.box_stats);
                }
            });
        }

        // Residuals vs Fitted and Normal Q-Q: one plot per variable when residuals_data is present
        const residualsContent = document.getElementById('assumptionsResidualsContent');
        const qqContent = document.getElementById('assumptionsQQContent');
        if (residualsContent) {
            residualsContent.innerHTML = '';
            if (!data.results.some(r => r.residuals_data && r.residuals_data.length)) {
                residualsContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
            } else {
                data.results.forEach((res, resIdx) => {
                    if (!res.residuals_data || !res.residuals_data.length) return;

                    const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
                    const origRes = hasTransformForVar ? originalByVar[res.variable] : null;
                    const transformLabel = hasTransformForVar ? getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power) : '';

                    const card = document.createElement('div');
                    card.className = 'plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border mb-4';
                    const divId = 'diag-res-' + resIdx + '-' + (res.variable || '').replace(/\W/g, '_');
                    const divIdOrig = divId + '-orig';

                    const toggleBtnHtml = hasTransformForVar && origRes && origRes.residuals_data && origRes.residuals_data.length ? `
                        <div class="d-flex align-items-center gap-3 mb-2 flex-wrap">
                            <span class="badge bg-warning text-dark" style="font-size:0.70rem;"><i class="bi bi-arrow-left-right me-1"></i>Transformation method used: ${transformLabel}</span>
                            <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                    style="font-size:0.70rem; padding:2px 8px;"
                                    data-transformed="${divId}" data-original="${divIdOrig}"
                                    data-showing="transformed">
                                <i class="bi bi-eye me-1"></i> Show Original
                            </button>
                        </div>` : '';

                    card.innerHTML = `
                        <h6 class="fw-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                        ${toggleBtnHtml}
                        <div id="${divId}" class="assumptions-plot-container" style="min-height: 400px; width: 100%;"></div>
                        ${hasTransformForVar && origRes && origRes.residuals_data && origRes.residuals_data.length ? `<div id="${divIdOrig}" class="assumptions-plot-container" style="min-height: 400px; width: 100%; display:none;"></div>` : ''}`;
                    residualsContent.appendChild(card);
                    renderResidualsVsFitted(divId, res.residuals_data, hasTransformForVar ? res.variable + ' (transformed)' : res.variable, resIdx);
                    if (hasTransformForVar && origRes && origRes.residuals_data && origRes.residuals_data.length) {
                        renderResidualsVsFitted(divIdOrig, origRes.residuals_data, res.variable + ' (original)', resIdx);
                    }
                });
            }
        }
        if (qqContent) {
            qqContent.innerHTML = '';
            if (!data.results.some(r => r.residuals_data && r.residuals_data.length)) {
                qqContent.innerHTML = '<p class="text-muted small">Run Normality &amp; Variance Tests to generate plots.</p>';
            } else {
                data.results.forEach((res, resIdx) => {
                    if (!res.residuals_data || !res.residuals_data.length) return;

                    const hasTransformForVar = hasTransforms && appliedTransformations[res.variable] && appliedTransformations[res.variable].type !== 'none';
                    const origRes = hasTransformForVar ? originalByVar[res.variable] : null;
                    const transformLabel = hasTransformForVar ? getTransformLabel(appliedTransformations[res.variable].type, appliedTransformations[res.variable].power) : '';

                    const card = document.createElement('div');
                    card.className = 'plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border mb-4';
                    const divId = 'diag-qq-' + resIdx + '-' + (res.variable || '').replace(/\W/g, '_');
                    const divIdOrig = divId + '-orig';

                    const toggleBtnHtml = hasTransformForVar && origRes && origRes.residuals_data && origRes.residuals_data.length ? `
                        <div class="d-flex align-items-center gap-3 mb-2 flex-wrap">
                            <span class="badge bg-warning text-dark" style="font-size:0.70rem;"><i class="bi bi-arrow-left-right me-1"></i>Transformation method used: ${transformLabel}</span>
                            <button type="button" class="btn btn-xs btn-outline-secondary btn-toggle-plot"
                                    style="font-size:0.70rem; padding:2px 8px;"
                                    data-transformed="${divId}" data-original="${divIdOrig}"
                                    data-showing="transformed">
                                <i class="bi bi-eye me-1"></i> Show Original
                            </button>
                        </div>` : '';

                    card.innerHTML = `
                        <h6 class="fw-bold border-bottom pb-2 mb-3">${res.variable}</h6>
                        ${toggleBtnHtml}
                        <div id="${divId}" class="assumptions-plot-container" style="min-height: 400px; width: 100%;"></div>
                        ${hasTransformForVar && origRes && origRes.residuals_data && origRes.residuals_data.length ? `<div id="${divIdOrig}" class="assumptions-plot-container" style="min-height: 400px; width: 100%; display:none;"></div>` : ''}`;
                    qqContent.appendChild(card);
                    renderNormalQQ(divId, res.residuals_data, hasTransformForVar ? res.variable + ' (transformed)' : res.variable, resIdx);
                    if (hasTransformForVar && origRes && origRes.residuals_data && origRes.residuals_data.length) {
                        renderNormalQQ(divIdOrig, origRes.residuals_data, res.variable + ' (original)', resIdx);
                    }
                });
            }
        }

        // Unhide the ANOVA tab
        const anovaTab = document.getElementById('anova-tab');
        anovaTab.style.display = 'block';
        anovaTab.classList.add('animate__animated', 'animate__fadeIn');
    })
    .catch(err => {
        testSpinner.style.display = 'none';
        alert("Testing Error: " + err.message);
    });
});

// 2. ADD NEW LISTENER for 'runAnovaBtn'
document.getElementById('runAnovaBtn').addEventListener('click', function() {
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked'))
        .filter(cb => !cb.disabled)
        .map(cb => cb.value);
    const anovaSpinner = document.getElementById('anovaSpinner');
    const anovaResults = document.getElementById('anovaResults');

    anovaResults.innerHTML = "";
    anovaSpinner.style.display = 'block';

    fetch('/run-anova', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: globalData,
            target_columns: selectedVars,
            factors: selectedFactors,
            grouping_mode: document.getElementById('groupingMode').value || 'all_combined'
        })
    })
    .then(res => res.json())
    .then(data => {
        anovaSpinner.style.display = 'none';

        if (data.error) {
            console.error("Backend ANOVA error:", data.error);
            anovaResults.innerHTML = `
                <div class="alert alert-danger p-3">
                    <strong>Server Error:</strong><br>
                    ${data.error}<br><br>
                    <small>Tip: Check that you added the statsmodels imports in statistics.py</small>
                </div>`;
            return;
        }

        // Save the results for exporting
        lastAnovaResults = data; 
        // Show the download button
        document.getElementById('downloadAnovaExcelBtn').style.display = 'inline-flex';

        if (!data.results || data.results.length === 0) {
            anovaResults.innerHTML = `
                <div class="alert alert-warning">
                    No valid groups with ≥3 replicates for statistical testing.
                </div>`;
            return;
        }

        // Group results by variable
        const byVariable = {};
        data.results.forEach(res => {
            if (!byVariable[res.variable]) byVariable[res.variable] = [];
            byVariable[res.variable].push(res);
        });

        let varIdx = 0;
        Object.keys(byVariable).forEach(varName => {
            const varResults = byVariable[varName];
            const varId = 'anova_var_' + varIdx++;
            const section = document.createElement('div');
            section.className = "mb-5 p-4 border rounded bg-white shadow-sm";

            // Build summary letter table HTML
            let summaryHTML = '';
            varResults.forEach(res => {
                const sliceInfo = res.slice_label && res.slice_label !== 'All'
                    ? ' <small class="text-muted fw-normal">(' + res.slice_label + ')</small>'
                    : '';

                if (res.letter_groups && res.letter_groups.length > 0) {
                    const sliceInfo = res.slice_label && res.slice_label !== 'All' 
                        ? `<span class="text-muted">${res.slice_label}</span>` 
                        : 'All groups';
                    
                    summaryHTML += `
                        <div class="border rounded p-3 mb-4 bg-white shadow-sm">
                            <div class="d-flex justify-content-between align-items-center mb-3">
                                <h6 class="mb-0 fw-bold">${sliceInfo}</h6>
                                <span class="badge bg-primary">${res.test_used}</span>
                            </div>
                            
                            <!-- NEW: Significance Plot (most important part) -->
                            ${res.plot_url ? `
                            <div class="text-center mb-4">
                                <img src="data:image/png;base64,${res.plot_url}" 
                                     class="img-fluid rounded shadow-sm" 
                                     style="max-height: 420px; border: 1px solid #e9ecef;">
                            </div>` : ''}
                            
                            <!-- Info banner -->
                            <div class="alert alert-info py-2 small mb-3">
                                <strong>Overall p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}</strong> | 
                                Normality: ${res.assumptions.all_normal ? '✓' : '✗'} | 
                                Homogeneity: ${res.assumptions.homogeneous ? '✓' : '✗'}
                            </div>
                            
                            <!-- Existing summary table -->
                            <table class="table table-sm table-bordered text-center">
                                <thead class="table-light">
                                    <tr><th class="text-left">Group</th><th>Mean</th><th>SD</th><th>N</th><th>Letter</th></tr>
                                </thead>
                                <tbody>
                                    ${res.letter_groups.map(lg => `
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
                    summaryHTML += `
                        <div class="mb-3">
                            <div class="alert alert-secondary py-2 small">
                                ${sliceInfo || 'All groups'}: No significant differences found (p = ${res.overall_p !== null ? res.overall_p.toFixed(4) : '—'}).
                                All groups share the same letter 
                                <span class="badge fs-6" style="padding: 5px 12px; border-radius: 12px; ${getLetterGroupStyle('a')}">a</span>.
                            </div>
                        </div>`;
                }
            });

            // Build detailed pairwise table HTML
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
                        ${summaryHTML}
                    </div>
                    <div class="tab-pane fade" id="${varId}_detail" role="tabpanel">
                        ${detailedHTML}
                    </div>
                </div>
            `;
            anovaResults.appendChild(section);
        });
    })
    .catch(err => {
        anovaSpinner.style.display = 'none';
        console.error(err);
        anovaResults.innerHTML = `<div class="alert alert-danger">Request failed: ${err.message}</div>`;
    });
});

// Download excel with ANOVA results
document.getElementById('downloadAnovaExcelBtn').addEventListener('click', function() {
    if (!lastAnovaResults) return;

    fetch('/export-anova-excel', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastAnovaResults)
    })
    .then(res => {
        if (!res.ok) throw new Error("Export failed");
        return res.blob();
    })
    .then(blob => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = "Significance_Test_Report.xlsx";
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    })
    .catch(err => alert("Export Error: " + err.message));
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