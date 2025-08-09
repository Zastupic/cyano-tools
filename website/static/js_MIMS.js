// ========================================
// 0. Global variables
// ========================================
let selectedFile = null;
let mimsRawData = [];
let mimsXField = "";
let mimsYFields = [];
let mimsFieldColors = {};
let currentZoomRange = null;
let regressionResults = []; // store all regression results here
let rawTraceIndicesBySelection = new Map();
let normTraceIndicesBySelection = new Map();
let lastAddedStartTime = null;
let selectionCounter = 0;

// =================
// 1. File selection
// =================
function getSelectedMIMSModel() {
    const select = document.querySelector('select[name="MIMS_model"]');
    return select ? select.value : "HPR40 (Hiden Analytical)";
}

document.getElementById('MIMS_file').addEventListener('change', function (event) {
    selectedFile = event.target.files[0];
    if (!selectedFile) return;

    const label = document.querySelector('label[for="MIMS_file"]');
    if (label) label.textContent = selectedFile.name;

    resetUI();
});

function resetUI() {
    document.getElementById('raw-container').style.display = 'none';
    document.getElementById('normalized-container').style.display = 'none';
    document.getElementById('preview-label').style.display = 'none';
    document.getElementById('normalized-preview-label').style.display = 'none';
    document.getElementById('normalization-controls').style.display = 'none';
    document.getElementById('calibration-section').style.display = 'none';
    document.getElementById('regression-results-table').innerHTML = "";
    regressionResults = [];
    currentZoomRange = null;
    rawTraceIndicesBySelection.clear();
    normTraceIndicesBySelection.clear();
    selectionCounter = 0;

    const errorDiv = document.getElementById("mims-error-alert");
    if (errorDiv) errorDiv.innerHTML = "";
}

// =============================================
// 2. Handle file and trigger parsing/plotting
// =============================================
document.getElementById('show-image-button').addEventListener('click', function (event) {
    event.preventDefault();
    const mimsErrorAlert = document.getElementById('mims-error-alert');
    mimsErrorAlert.innerHTML = '';

    const fileInput = document.getElementById('MIMS_file');
    const file = fileInput.files[0];

    if (!file) {
        mimsErrorAlert.innerHTML = `<div class="alert alert-danger">Please select a MIMS file first.</div>`;
        return;
    }

    const selectedModel = getSelectedMIMSModel();
    const fileName = file.name;
    const fileExt = fileName.split('.').pop().toLowerCase();

    const isCSV = fileExt === 'csv';
    const isASCI = fileExt === 'asc' || fileExt === 'asci';

    let validType = false;
    if (selectedModel === 'HPR40 (Hiden Analytical)' && isCSV) validType = true;
    if (selectedModel === 'MS GAS (Photon System Instruments)' && isASCI) validType = true;

    if (!validType) {
        mimsErrorAlert.innerHTML = `
          <div class="alert alert-danger alert-dismissible fade show" role="alert">
            <strong>Invalid MIMS file selected:</strong>
            <button type="button" class="close" data-dismiss="alert"><span>&times;</span></button>
          </div>`;
        return;
    }

    selectedFile = file;
    parseMIMSFile(file, function (result) {
        plotMIMSData(result);
    });
});

// =============================================
// 3. Parse MIMS File (CSV or ASC/ASCI formats)
// =============================================
function parseMIMSFile(file, callback) {
  const reader = new FileReader();

  reader.onload = function (e) {
    const content = e.target.result;
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith(".asc") || fileName.endsWith(".asci")) {
      if (!content.includes("Ion Current [A]")) {
        document.getElementById("mims-error-alert").innerHTML = `
          <div class="alert alert-danger alert-dismissible fade show" role="alert">
            <strong>Error:</strong> Missing <code>"Ion Current [A]"</code> in file.
            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
              <span aria-hidden="true">&times;</span>
            </button>
          </div>`;
        return;
      }

      try {
        const lines = content.split(/\r?\n/);
        const headerIndex = lines.findIndex(line => line.includes("Ion Current [A]"));
        const channelLine = lines[headerIndex - 1] || "";
        const headerLine = lines[headerIndex];
        const dataLines = lines.slice(headerIndex + 1);

        const columns = headerLine.trim().split("\t");
        const timeIndex = columns.findIndex(col => col.includes("Time Relative [s]"));
        const signalIndices = columns.map((col, i) => col.includes("Ion Current") ? i : -1).filter(i => i !== -1);
        const channelNumbers = channelLine.trim().split(/\s+/).filter(Boolean);

        const parsedData = dataLines.map(line => {
          const parts = line.trim().split("\t");
          if (parts.length <= Math.max(timeIndex, ...signalIndices)) return null;

          const row = {
            "Time": parseFloat(parts[timeIndex].replace(",", ".")),
          };
          signalIndices.forEach((idx, i) => {
            const channel = channelNumbers[i] || `Signal${i + 1}`;
            row[channel] = parseFloat(parts[idx].replace(",", "."));
          });
          row["min"] = row["Time"] / 60;
          return row;
        }).filter(Boolean);

        const fields = ["min", ...channelNumbers];
        callback({ data: parsedData, fields, xField: "min", yFields: channelNumbers });
      } catch (err) {
        document.getElementById("mims-error-alert").innerHTML = `
          <div class="alert alert-danger alert-dismissible fade show" role="alert">
            <strong>Parsing Error:</strong> ${err.message}
            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
              <span aria-hidden="true">&times;</span>
            </button>
          </div>`;
      }
      return;
    }

    // CSV
    const pattern = /"Time"\s*,\s*"ms"/gi;
    const matches = [...content.matchAll(pattern)];
    if (matches.length < 1) {
      document.getElementById("mims-error-alert").innerHTML = `
        <div class="alert alert-danger alert-dismissible fade show" role="alert">
          <strong>Error:</strong> Missing <code>"Time"</code> and <code>"ms"</code> columns in CSV.
          <button type="button" class="close" data-dismiss="alert" aria-label="Close">
            <span aria-hidden="true">&times;</span>
          </button>
        </div>`;
      return;
    }

    const startIndex = matches[0].index;
    const usableContent = content.slice(startIndex);

    Papa.parse(usableContent, {
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: function (results) {
        let data = results.data;
        let fields = results.meta.fields;

        fields = fields.filter(field =>
          data.some(row => {
            const value = row[field];
            return value !== null && value !== undefined && value !== "" && !Number.isNaN(value);
          })
        );

        data.forEach(row => {
          row["min"] = typeof row["ms"] === "number" ? row["ms"] / 60000 : null;
        });

        const msIndex = fields.indexOf("ms");
        if (msIndex !== -1) {
          fields = [...fields.slice(0, msIndex + 1), "min", ...fields.slice(msIndex + 1)];
        } else {
          fields.push("min");
        }

        const xField = fields.includes("min") ? "min" : fields.includes("ms") ? "ms" : "Time";
        const yFields = fields.filter(f => !["Time", "ms", "min"].includes(f));

        callback({ data, fields, xField, yFields });
      },
      error: function (err) {
        document.getElementById("mims-error-alert").innerHTML = `
          <div class="alert alert-danger alert-dismissible fade show" role="alert">
            <strong>Parsing Error:</strong> ${err.message}
            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
              <span aria-hidden="true">&times;</span>
            </button>
          </div>`;
      }
    });
  };

  reader.readAsText(file);
}

// ================================
// 4. Plot raw MIMS data with Plotly
// ================================
function plotMIMSData({ data, xField, yFields }) {
    mimsRawData = data;
    mimsXField = xField;
    mimsYFields = yFields;

    const traces = yFields.map(field => ({
        x: data.map(row => row[xField]),
        y: data.map(row => row[field]),
        mode: 'lines',
        name: field,
        line: { width: 2 }
    }));

    Plotly.newPlot('raw-plot-div', traces, {
        title: 'Raw MIMS data: Signals vs Time',
        xaxis: { title: xField === "min" ? "Time (min)" : xField },
        yaxis: { title: 'Signal intensity (Torr)', tickformat: '.1e' }
    }).then(plot => {
        plot.data.forEach(trace => {
            if (trace.name) mimsFieldColors[trace.name] = trace.line.color;
        });
        document.getElementById('raw-container').style.display = 'block';
        document.getElementById('preview-label').style.display = 'block';
    });

    populateNormalizationDropdown(yFields);
    document.getElementById('normalization-controls').style.display = 'block';

    requestAnimationFrame(() => {
      Plotly.Plots.resize('raw-plot-div');
  });
}

// ===================================================
// 5. Normalization
// ===================================================
function populateNormalizationDropdown(yFields) {
    const normalizeSelect = document.getElementById("normalize-by-select");
    normalizeSelect.innerHTML = "";
    yFields.forEach(field => {
        const option = document.createElement("option");
        option.value = field;
        option.textContent = field;
        normalizeSelect.appendChild(option);
    });
}

document.getElementById("normalize-button").addEventListener("click", plotNormalizedData);

function plotNormalizedData() {
    const refField = document.getElementById("normalize-by-select").value;
    const data = mimsRawData;
    const xField = mimsXField;
    const yFields = mimsYFields;
    const traces = yFields.map(field => {
        const yValues = data.map(row => {
            const refVal = row[refField];
            const val = row[field];
            return (typeof val === "number" && typeof refVal === "number" && refVal !== 0)
                ? val / refVal : null;
        });
        return {
            x: data.map(row => row[xField]),
            y: yValues,
            mode: 'lines',
            name: `${field} / ${refField}`, // Fixed template literal
            line: {
                width: 2,
                dash: field === refField ? 'dot' : 'solid',
                color: mimsFieldColors[field] || undefined
            }
        };
    });

    Plotly.newPlot('normalized-plot-div', traces, {
        title: `Normalized Signals (divided by ${refField})`, // Fixed template literal
        xaxis: { title: xField === "min" ? "Time (min)" : xField },
        yaxis: { title: `Signal / ${refField} (r.u.)` } // Fixed template literal
    }).then(() => {
        // capture zoom range from normalized plot
        document.getElementById('normalized-plot-div').on('plotly_relayout', function (eventData) {
            if (eventData['xaxis.range[0]'] && eventData['xaxis.range[1]']) {
                currentZoomRange = {
                    x0: parseFloat(eventData['xaxis.range[0]']),
                    x1: parseFloat(eventData['xaxis.range[1]'])
                };
                console.log("Zoom range updated:", currentZoomRange);
            }
        });
    });

    document.getElementById('normalized-container').style.display = 'block';
    document.getElementById('normalized-preview-label').style.display = 'block';

    requestAnimationFrame(() => {
        // Show buttons now
        document.getElementById('confirm-selection-button').style.display = 'inline-block';
        document.getElementById('clear-regressions-in-table-button').style.display = 'inline-block';

        Plotly.Plots.resize('normalized-plot-div');
    });
}

// ===================================================
// 6. Regression fitting
// ===================================================
document.getElementById('confirm-selection-button').addEventListener('click', function () {
    if (!currentZoomRange) {
        alert("Please zoom in on the normalized plot to select a range first.");
        return;
    }
    applyLinearRegression(currentZoomRange.x0, currentZoomRange.x1);
});

// Clear last selection from table and plots
document.getElementById('clear-regressions-in-table-button').addEventListener('click', function () {
    if (regressionResults.length === 0) {
        alert("No selections to clear.");
        return;
    }

    // Find the highest selectionId in regressionResults (the latest selection)
    const selectionIds = regressionResults.map(r => r.selectionId);
    const maxSelectionId = Math.max(...selectionIds);

    // Get trace indices for the latest selection
    const rawIndicesToRemove = rawTraceIndicesBySelection.get(maxSelectionId) || [];
    const normIndicesToRemove = normTraceIndicesBySelection.get(maxSelectionId) || [];

    console.log(`Removing raw indices for selection ${maxSelectionId}:`, rawIndicesToRemove);
    console.log(`Removing norm indices for selection ${maxSelectionId}:`, normIndicesToRemove);

    // Remove traces from raw plot
    if (rawIndicesToRemove.length > 0) {
        try {
            Plotly.deleteTraces('raw-plot-div', rawIndicesToRemove);
            console.log("Successfully removed raw traces:", rawIndicesToRemove);
        } catch (error) {
            console.error("Error removing raw traces:", error);
        }
    } else {
        console.log("No raw indices to remove for selection:", maxSelectionId);
    }

    // Remove traces from normalized plot
    if (normIndicesToRemove.length > 0) {
        try {
            Plotly.deleteTraces('normalized-plot-div', normIndicesToRemove);
            console.log("Successfully removed norm traces:", normIndicesToRemove);
        } catch (error) {
            console.error("Error removing norm traces:", error);
        }
    } else {
        console.log("No norm indices to remove for selection:", maxSelectionId);
    }

    // Remove regression results for the latest selection
    regressionResults = regressionResults.filter(r => r.selectionId !== maxSelectionId);

    // Remove trace indices from Maps
    rawTraceIndicesBySelection.delete(maxSelectionId);
    normTraceIndicesBySelection.delete(maxSelectionId);

    // Refresh the regression results table
    refreshRegressionTable();
});

// Confirm selection - apply linear regression to current zoom range
function applyLinearRegression(x0, x1) {
    selectionCounter++; // new selection number

    const data = mimsRawData;
    const xField = mimsXField;
    const yFields = mimsYFields;
    const refField = document.getElementById("normalize-by-select").value;

    const filtered = data.filter(row => row[xField] >= x0 && row[xField] <= x1);

    if (filtered.length < 2) {
        alert("Not enough data points in selected range.");
        selectionCounter--;
        return;
    }

    const rawRegressionTraces = [];
    const normRegressionTraces = [];

    yFields.forEach(field => {
        const x = filtered.map(row => row[xField]);
        const yRaw = filtered.map(row => row[field]);
        const n = x.length;

        // Linear regression for raw data
        const sumX = x.reduce((a, b) => a + b, 0);
        const sumY = yRaw.reduce((a, b) => a + b, 0);
        const sumXY = x.reduce((sum, xi, i) => sum + xi * yRaw[i], 0);
        const sumXX = x.reduce((sum, xi) => sum + xi * xi, 0);
        const slopeRaw = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
        const interceptRaw = (sumY - slopeRaw * sumX) / n;
        const yPredRaw = x.map(xi => slopeRaw * xi + interceptRaw);
        const ssTotRaw = yRaw.reduce((sum, yi) => sum + Math.pow(yi - (sumY / n), 2), 0);
        const ssResRaw = yRaw.reduce((sum, yi, i) => sum + Math.pow(yi - yPredRaw[i], 2), 0);
        const r2Raw = 1 - (ssResRaw / ssTotRaw);

        // Add raw regression trace with selection prefix in legend
        rawRegressionTraces.push({
            x: [x0, x1],
            y: [slopeRaw * x0 + interceptRaw, slopeRaw * x1 + interceptRaw],
            mode: 'lines',
            name: `Selection ${selectionCounter} Fit: ${field}`,
            line: { dash: 'dot', width: 2, color: mimsFieldColors[field] || 'gray' }
        });

        // Linear regression for normalized data (if applicable)
        let slopeNorm = null;
        let r2Norm = null;
        if (field !== refField) {
            const normField = filtered.map(row => row[field] / row[refField]);
            const sumYnorm = normField.reduce((a, b) => a + b, 0);
            const sumXYnorm = x.reduce((sum, xi, i) => sum + xi * normField[i], 0);
            slopeNorm = (n * sumXYnorm - sumX * sumYnorm) / (n * sumXX - sumX * sumX);
            const interceptNorm = (sumYnorm - slopeNorm * sumX) / n;
            const yPredNorm = x.map(xi => slopeNorm * xi + interceptNorm);
            const ssTotNorm = normField.reduce((sum, yi) => sum + Math.pow(yi - (sumYnorm / n), 2), 0);
            const ssResNorm = normField.reduce((sum, yi, i) => sum + Math.pow(yi - yPredNorm[i], 2), 0);
            r2Norm = 1 - (ssResNorm / ssTotNorm);

            normRegressionTraces.push({
                x: [x0, x1],
                y: [slopeNorm * x0 + interceptNorm, slopeNorm * x1 + interceptNorm],
                mode: 'lines',
                name: `Selection ${selectionCounter} Fit: ${field}/${refField}`,
                line: { dash: 'dot', width: 2, color: mimsFieldColors[field] || 'gray' }
            });
        }

        // Save regression results with selectionId
        regressionResults.push({
            selectionId: selectionCounter,
            signal: field === refField ? field : `${field}/${refField}`,
            start_time: x0,
            slopeRaw: slopeRaw,
            r2Raw: r2Raw,
            slopeNorm: slopeNorm,
            r2Norm: r2Norm
        });
    });

    // Get current number of traces to calculate indices
    const rawPlot = document.getElementById('raw-plot-div');
    const normPlot = document.getElementById('normalized-plot-div');
    const rawCurrentTraceCount = rawPlot.data ? rawPlot.data.length : 0;
    const normCurrentTraceCount = normPlot.data ? normPlot.data.length : 0;

    // Add traces to plots and calculate indices
    Plotly.addTraces('raw-plot-div', rawRegressionTraces).then(() => {
        // Calculate indices based on the number of traces before adding
        const newRawIndices = Array.from(
            { length: rawRegressionTraces.length },
            (_, i) => rawCurrentTraceCount + i
        );
        console.log("Calculated raw indices:", newRawIndices);
        rawTraceIndicesBySelection.set(selectionCounter, newRawIndices);
    });

    Plotly.addTraces('normalized-plot-div', normRegressionTraces).then(() => {
        // Calculate indices based on the number of traces before adding
        const newNormIndices = Array.from(
            { length: normRegressionTraces.length },
            (_, i) => normCurrentTraceCount + i
        );
        console.log("Calculated norm indices:", newNormIndices);
        normTraceIndicesBySelection.set(selectionCounter, newNormIndices);
    });

    // Sort regressionResults by start_time (optional)
    regressionResults.sort((a, b) => a.start_time - b.start_time);
    refreshRegressionTable();
}

// Refresh regression results table with new layout and selection # column
function refreshRegressionTable() {
    const tableDiv = document.getElementById('regression-results-table');

    if (regressionResults.length === 0) {
        tableDiv.innerHTML = "";
        return;
    }

    // Group results by selectionId to keep selection # ordering
    const grouped = {};
    regressionResults.forEach(r => {
        if (!grouped[r.selectionId]) grouped[r.selectionId] = [];
        grouped[r.selectionId].push(r);
    });

    // Sort selectionIds ascending
    const sortedSelectionIds = Object.keys(grouped).map(Number).sort((a,b) => a-b);

    let html = `
        <table class="table table-striped">
            <thead>
                <tr>
                    <th>Selection #</th>
                    <th>Start Time</th>
                    <th>Signal</th>
                    <th>Slope Raw Data</th>
                    <th>R² Raw Data</th>
                    <th>Slope Normalized Data</th>
                    <th>R² Normalized Data</th>
                </tr>
            </thead>
            <tbody>
    `;

    sortedSelectionIds.forEach(selectionId => {
        grouped[selectionId].forEach(({ signal, start_time, slopeRaw, r2Raw, slopeNorm, r2Norm }) => {
            html += `
                <tr>
                    <td>${selectionId}</td>    
                    <td>${start_time.toFixed(2)}</td>
                    <td>${signal}</td>
                    <td>${slopeRaw.toExponential(3)}</td>
                    <td>${r2Raw.toFixed(4)}</td>
                    <td>${slopeNorm !== null ? slopeNorm.toExponential(3) : '-'}</td>
                    <td>${r2Norm !== null ? r2Norm.toFixed(4) : '-'}</td>
                    
                </tr>
            `;
        });
    });

    html += `</tbody></table>`;
    tableDiv.innerHTML = html;

}

//Refresh plots
function clearRegressionTracesFromPlots() {
    const rawIndicesToRemove = [];
    const normIndicesToRemove = [];

    for (const [selectionId, indices] of rawTraceIndicesBySelection) {
        console.log(`Raw indices for selection ${selectionId}:`, indices);
        rawIndicesToRemove.push(...indices);
    }
    for (const [selectionId, indices] of normTraceIndicesBySelection) {
        console.log(`Norm indices for selection ${selectionId}:`, indices);
        normIndicesToRemove.push(...indices);
    }

    // Verify all are integers
    console.log("All raw indices to remove:", rawIndicesToRemove);
    console.log("All norm indices to remove:", normIndicesToRemove);

    // Filter out any invalid indices (just in case)
    const validRawIndices = rawIndicesToRemove.filter(i => Number.isInteger(i) && i >= 0);
    const validNormIndices = normIndicesToRemove.filter(i => Number.isInteger(i) && i >= 0);

    console.log("Valid raw indices:", validRawIndices);
    console.log("Valid norm indices:", validNormIndices);

    if (validRawIndices.length > 0) {
        try {
            Plotly.deleteTraces('raw-plot-div', validRawIndices);
            console.log("Successfully removed raw traces:", validRawIndices);
        } catch (error) {
            console.error("Error removing raw traces:", error);
        }
    } else {
        console.log("No valid raw indices to remove.");
    }

    if (validNormIndices.length > 0) {
        try {
            Plotly.deleteTraces('normalized-plot-div', validNormIndices);
            console.log("Successfully removed norm traces:", validNormIndices);
        } catch (error) {
            console.error("Error removing norm traces:", error);
        }
    } else {
        console.log("No valid norm indices to remove.");
    }

    rawTraceIndicesBySelection.clear();
    normTraceIndicesBySelection.clear();
}