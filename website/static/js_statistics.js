const API_URL = '/run-statistics';
const EXPORT_URL = '/export-excel';
let globalData = null;
let lastResults = null;
let selectedFactors = [];
let lastAnovaResults = null;

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

function showNiceMessage(message, type) {
    const container = document.getElementById('selectionCard');
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} mt-2 py-2 small shadow-sm animate__animated animate__fadeInUp`;
    alertDiv.style.fontSize = "0.75rem";
    alertDiv.innerHTML = `<i class="bi bi-info-circle-fill"></i> ${message}`;

    container.prepend(alertDiv);

    setTimeout(() => {
        alertDiv.classList.replace('animate__fadeInUp', 'animate__fadeOutDown');
        setTimeout(() => alertDiv.remove(), 500);
    }, 3000);
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

document.getElementById('processDataBtn').addEventListener('click', function() {
    const rawData = document.getElementById('excelPasteBox').value.trim();
    if (!rawData) return alert("Please paste data from Excel.");

    const rows = rawData.split('\n');
    const headers = rows[0].split(/\t| {2,}/).map(h => h.trim()).filter(h => h !== "");

    if (headers.length === 0) return alert("Could not detect columns. Check your data format.");
    const firstColumnName = headers[0];

    globalData = rows.slice(1).map(row => {
        const values = row.split(/\t| {2,}/).map(v => v.trim());
        let obj = {};
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
    .then(res => res.json())
    .then(result => {
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
        document.getElementById('downloadExcelBtn').style.display = 'inline-flex';

        result.results.forEach(res => {
            const card = document.createElement('div');
            card.className = 'col-12 mb-4';
            let headers = result.factors.map(f => `<th>${f}</th>`).join('');
            card.innerHTML = `
                <div class="plot-card-wrapper text-dark bg-white p-3 rounded shadow-sm border">
                    <h6 class="fw-bold border-bottom pb-2">${res.variable}</h6>
                    <div class="text-center overflow-auto">
                        <img src="data:image/png;base64,${res.plot_url}" class="img-fluid rounded mb-3">
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
        });
        vizResultsHeader.style.display = 'flex';
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
// 1. Add a global variable at the top of js_statistics.js to store PCA results
let lastPCAResults = null;

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

    testResults.innerHTML = "";
    testSpinner.style.display = 'block';

    fetch('/run-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            data: globalData,
            target_columns: selectedVars,
            factors: selectedFactors
        })
    })
    .then(res => res.json())
    .then(data => {
        testSpinner.style.display = 'none';
        if (data.error) throw new Error(data.error);

        data.results.forEach(res => {
            const section = document.createElement('div');
            section.className = "mb-5 p-4 border rounded bg-white shadow-sm";

            // Check for Levene status for the summary alert
            const leveneClass = res.levene.is_homogeneous === null ? 'secondary' : (res.levene.is_homogeneous ? 'success' : 'danger');
            const leveneText = res.levene.is_homogeneous === null ? 'N/A' : (res.levene.is_homogeneous ? 'Equal' : 'Unequal');

            section.innerHTML = `
                <div class="d-flex justify-content-between align-items-center border-bottom pb-2 mb-3">
                    <h5 class="fw-bold text-primary mb-0">Variable: ${res.variable}</h5>
                    <span class="badge bg-${leveneClass}">Variance: ${leveneText}</span>
                </div>

                <div class="row">
                    <div class="col-lg-8 text-center border-end">
                        <img src="data:image/png;base64,${res.plot_url}" class="img-fluid rounded" style="max-height: 450px;">
                    </div>

                    <div class="col-lg-4">
                        <label class="small fw-bold text-uppercase text-muted mb-2">Normality (Shapiro-Wilk)</label>
                        <div class="table-responsive">
                            <table class="table table-sm extra-small">
                                <thead class="table-light">
                                    <tr><th>Group</th><th>p-val</th><th>Res.</th></tr>
                                </thead>
                                <tbody>
                                    ${res.shapiro.map(s => `
                                        <tr class="${s.is_normal ? '' : 'table-danger-light'}">
                                            <td class="text-truncate" style="max-width: 100px;">${s.group}</td>
                                            <td>${s.p.toFixed(3)}</td>
                                            <td>${s.is_normal ? '✅' : '❌'}</td>
                                        </tr>`).join('')}
                                </tbody>
                            </table>
                        </div>
                        <p class="extra-small text-muted mt-2">
                            <i class="bi bi-info-circle"></i> Green boxes in plot indicate normal distribution (p > 0.05).
                        </p>
                    </div>
                </div>
            `;
            testResults.appendChild(section);
        });

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