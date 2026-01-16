/**
 * js_statistics.js - Final Multivariate Edition
 * Changes: Auto-selection on dropdown change, 3-factor limit, nice alerts.
 */

const API_URL = '/run-statistics'; 
const EXPORT_URL = '/export-excel'; 
let globalData = null;
let lastResults = null;
let selectedFactors = []; 

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
        
        // Remove factor on click
        tag.onclick = function() { removeFactor(factor); };
        container.appendChild(tag);
    });

    // Disable selector if limit reached
    selector.disabled = (selectedFactors.length >= 3);
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

// --- 2. Variable Selection Logic ---

document.getElementById('selectAllVars').addEventListener('change', function() {
    const checkboxes = document.querySelectorAll('.var-check');
    checkboxes.forEach(cb => { cb.checked = this.checked; });
});

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
    const selectedVars = Array.from(document.querySelectorAll('.var-check:checked')).map(cb => cb.value);
    if (selectedFactors.length === 0) return alert("Select at least one factor.");
    if (selectedVars.length === 0) return alert("Select at least one variable.");

    const statsContent = document.getElementById('statsContent');
    const loadingSpinner = document.getElementById('loadingSpinner');
    
    document.getElementById('resultsArea').style.display = 'block';
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
        document.getElementById('downloadExcelBtn').style.display = 'block';

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
                                        <td>${s.std ? s.std.toFixed(4) : 'N/A'}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </details>
                </div>`;
            statsContent.appendChild(card);
        });
    })
    .catch(err => {
        loadingSpinner.style.display = 'none';
        alert("Analysis Error: " + err.message);
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