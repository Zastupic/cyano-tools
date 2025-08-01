// ========================================
// 0. Global variables to store parsed data
// ========================================
let selectedFile = null;         // User-selected file
let mimsRawData = [];            // Parsed row data
let mimsXField = "";             // X-axis field: "min", "ms", or "Time"
let mimsYFields = [];            // Y-axis signal fields
let mimsFieldColors = {};        // Store assigned colors for each field

// =================
// 1. File selection
// =================
function getSelectedMIMSModel() {
    const select = document.querySelector('select[name="MIMS_model"]');
    return select ? select.value : "HPR40";  // default fallback
}

document.getElementById('MIMS_file').addEventListener('change', function (event) {
    selectedFile = event.target.files[0];
    if (!selectedFile) return;

    // Show selected file name in label
    const label = document.querySelector('label[for="MIMS_file"]');
    if (label) label.textContent = selectedFile.name;

    // Reset plots and UI on new file selection
    resetUI();
});

// Reset UI function to hide plots and controls when new file is selected
function resetUI() {
    document.getElementById('raw-container').style.display = 'none';
    document.getElementById('normalized-container').style.display = 'none';
    document.getElementById('preview-label').style.display = 'none';
    document.getElementById('normalized-preview-label').style.display = 'none';
    document.getElementById('normalization-controls').style.display = 'none';
    document.getElementById('calibration-section').style.display = 'none';

    // Clear any error messages
    const errorDiv = document.getElementById("mims-error-alert");
    if (errorDiv) errorDiv.innerHTML = "";
}

// ===============================================================
// 2. Handle button click to parse CSV/ASC + plot original data
// ===============================================================
document.getElementById('show-image-button').addEventListener('click', function (event) {
    event.preventDefault();

    const mimsErrorAlert = document.getElementById('mims-error-alert');
    mimsErrorAlert.innerHTML = '';

    const fileInput = document.getElementById('MIMS_file');
    const file = fileInput.files[0];

    if (!file) {
        mimsErrorAlert.innerHTML = `
            <div class="alert alert-danger">Please select a MIMS file first.</div>
        `;
        return;
    }

    const selectedModel = getSelectedMIMSModel();
    const fileName = file.name;
    const fileExt = fileName.split('.').pop().toLowerCase();

    const isCSV = fileExt === 'csv';
    const isASCI = fileExt === 'asc' || fileExt === 'asci';

        let validType = false;
        if (selectedModel === 'HPR40 (Hiden analytical)' && isCSV) validType = true;
        if (selectedModel === 'MS GAS (Photon System Instruments)' && isASCI) validType = true;

    if (!validType) {
        // 🚫 File type is invalid
        mimsErrorAlert.innerHTML = `
            <div class="alert alert-danger alert-dismissible fade show" role="alert">
                <strong>Invalid MIMS fiels selected:</strong><br>
                For MIMS type <strong>HPR40 (Hiden analytical)</strong>, only <code>.csv</code> files are accepted.<br>
                For MIMS type <strong>MS GAS (Photon System Instruments)</strong>, only <code>.asc</code> or <code>.asci</code> files are accepted.<br>
                <strong>You selected <code>.${fileExt}</code> file for ${selectedModel} </strong>MIMS.
                <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                    <span aria-hidden="true">&times;</span>
                </button>   
            </div>
        `;
        return;
    }

    // ✅ Proceed to parse
    selectedFile = file;
    parseMIMSFile(file, function (result) {
        plotMIMSData(result);
    });
});

// ==========================================================
// 3. Parse and plot the original MIMS data (Time vs Signals)
// ==========================================================
function parseMIMSFile(file, callback) {
    const reader = new FileReader();

    reader.onload = function(e) {
        const content = e.target.result;
        const fileName = file.name.toLowerCase();

        // ========== For .asc or .asci files ==========
        if (fileName.endsWith(".asc") || fileName.endsWith(".asci")) {
            const lines = content.split(/\r?\n/);
            let found = false;
            
            // Check if "Ion Current [A]" is present anywhere in the file
            if (!content.includes("Ion Current [A]")) {
                // Show error message
                const errorDiv = document.getElementById("mims-error-alert");
                if (errorDiv) {
                    errorDiv.innerHTML = `
                        <div class="alert alert-danger alert-dismissible fade show" role="alert">
                            <strong>Error:</strong> This .asc/.asci file does not contain the required <code>"Ion Current [A]"</code> field.<br>
                            Please upload a correctly formatted ASC/ASCI file.
                            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                              <span aria-hidden="true">&times;</span>
                            </button>
                        </div>
                    `;
                }
                return; // Stop parsing since file is invalid
            }

            console.log("✅ 'Ion Current [A]' field found, proceed with parsing ASC/ASCI file.");


            // Define parsing function
            function parseASCIFile(fileContent) {
                const lines = fileContent.split(/\r?\n/);
                
                const headerIndex = lines.findIndex(line => line.includes("Ion Current [A]"));
                if (headerIndex === -1) {
                    throw new Error(`Ion Current [A] not found in file.`);
                }
            
                const channelLine = lines[headerIndex - 1] || "";
                const headerLine = lines[headerIndex];
                const dataLines = lines.slice(headerIndex + 1);
            
                const columns = headerLine.trim().split("\t");
                const timeIndex = columns.findIndex(col => col.includes("Time Relative [s]"));
            
                if (timeIndex === -1) {
                    throw new Error(`No "Time Relative [s]" column found in file.`);
                }
            
                // Get indices of Ion Current columns
                const signalIndices = columns
                    .map((col, i) => (col.includes("Ion Current") ? i : -1))
                    .filter(i => i !== -1);
            
                // 🔢 Extract channel numbers from the channelLine
                const channelNumbers = channelLine.trim().split(/\s+/).filter(Boolean);
            
                if (channelNumbers.length !== signalIndices.length) {
                    console.warn("Mismatch between number of channels and Ion Current columns");
                }
            
                const parsedData = [];
            
                for (const line of dataLines) {
                    const parts = line.trim().split("\t");
                    if (parts.length <= Math.max(timeIndex, ...signalIndices)) continue;
                
                    const row = {
                        "Time": parseFloat(parts[timeIndex].replace(",", ".")),
                    };
                
                    signalIndices.forEach((idx, i) => {
                        const channel = channelNumbers[i] || `Signal${i + 1}`;
                        row[channel] = parseFloat(parts[idx].replace(",", "."));
                    });
                
                    parsedData.push(row);
                }
            
                const fields = ["Time", ...channelNumbers];
                const xField = "Time";
                const yFields = channelNumbers;

                console.log("🔍 fields:\n", fields);
                console.log("🔍 xField:\n", xField);
                console.log("🔍 yFields:\n", yFields);
            
                return { data: parsedData, fields, xField, yFields };
            }

            // Call parsing function and continue
            try {
                const result = parseASCIFile(content);
                callback(result);  // 👈 send parsed data to plotting function

            } catch (err) {
                console.error(err);
                const errorDiv = document.getElementById("mims-error-alert");
                if (errorDiv) {
                    errorDiv.innerHTML = `
                        <div class="alert alert-danger alert-dismissible fade show" role="alert">
                            <strong>Parsing Error:</strong> ${err.message || err}
                            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                            <span aria-hidden="true">&times;</span>
                            </button>   
                        </div>
                    `;
                }
            }
            return;

        }

        // ========== For .csv files ==========
        const pattern = /"Time"\s*,\s*"ms"/gi;
        const matches = [...content.matchAll(pattern)];
        if (matches.length < 1) {
            console.error("❌ Could not find 'Time,ms' header in the file.");
            const errorDiv = document.getElementById("mims-error-alert");
            if (errorDiv) {
                errorDiv.innerHTML = `
                    <div class="alert alert-danger alert-dismissible fade show" role="alert">
                        <strong>Error:</strong> This file does not contain the required <code>"Time"</code> and <code>"ms"</code> columns.
                        Please upload a correctly formatted CSV file.
                        <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                          <span aria-hidden="true">&times;</span>
                        </button>   
                    </div>
                `;
            }
            return;
        }

        const startIndex = matches[0].index;
        const usableContent = content.slice(startIndex);

        Papa.parse(usableContent, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,
            complete: function(results) {
                let data = results.data;
                let fields = results.meta.fields;

                // Clean up fields
                fields = fields.filter(field => {
                    return data.some(row => {
                        const value = row[field];
                        return value !== null && value !== undefined && value !== "" && !Number.isNaN(value);
                    });
                });

                // Add "min" column
                data.forEach(row => {
                    if (typeof row["ms"] === "number") {
                        row["min"] = row["ms"] / 60000;
                    } else {
                        row["min"] = null;
                    }
                });

                const msIndex = fields.indexOf("ms");
                if (msIndex !== -1) {
                    fields = [...fields.slice(0, msIndex + 1), "min", ...fields.slice(msIndex + 1)];
                } else {
                    fields.push("min");
                }

                const xField = fields.includes("min") ? "min" :
                              fields.includes("ms") ? "ms" : "Time";
                const yFields = fields.filter(f => f !== "Time" && f !== "ms" && f !== "min");

                callback({ data, fields, xField, yFields });

                console.log("🔍 data:\n", data);
                console.log("🔍 fields:\n", fields);
                console.log("🔍 xField:\n", xField);
                console.log("🔍 yFields:\n", yFields);
                
            },
            error: function(err) {
                console.error("❌ Parsing error:", err);
                const errorDiv = document.getElementById("mims-error-alert");
                if (errorDiv) {
                    errorDiv.innerHTML = `
                        <div class="alert alert-danger alert-dismissible fade show" role="alert">
                            <strong>Parsing Error:</strong> ${err.message || err}
                            <button type="button" class="close" data-dismiss="alert" aria-label="Close">
                              <span aria-hidden="true">&times;</span>
                            </button>   
                        </div>
                    `;
                }
            }
        });
    };
    reader.readAsText(file);
}

// =========================================================
// 4. Plot MIMS data
// =========================================================
function plotMIMSData({ data, xField, yFields }) {
    // Store globally for normalization and calibration
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
        xaxis: {
            title: xField === "min" ? "Time (min)" :
                   xField === "ms" ? "Time (ms)" : "Time",
            automargin: true
        },
        yaxis: {
            title: 'Signal intensity (Torr)',
            automargin: true,
            type: 'linear',
            tickformat: '.1e'
        },
        legend: {
            orientation: "v",
            x: 1.05,
            xanchor: "left",
            y: 1,
            yanchor: "top"
        },
        margin: {
            l: 60,
            r: 150,
            t: 60,
            b: 50
        }
    }).then(plot => {
        plot.data.forEach(trace => {
            if (trace.name) {
                mimsFieldColors[trace.name] = trace.line.color;
            }
        });

        // Show raw plot container and label
        document.getElementById('raw-container').style.display = 'block';
        document.getElementById('preview-label').style.display = 'block';

        requestAnimationFrame(() => {
            Plotly.Plots.resize('raw-plot-div');
        });
    });

    populateNormalizationDropdown(yFields);

    // Hide normalized plot and calibration until user proceeds
    document.getElementById('normalized-container').style.display = 'none';
    document.getElementById('normalized-preview-label').style.display = 'none';
    document.getElementById('normalization-controls').style.display = 'block';
    document.getElementById('calibration-section').style.display = 'none';
}

// ===================================================================
// 5. Fill the normalization dropdown and enable UI for normalization
// ===================================================================
function populateNormalizationDropdown(yFields) {
    const normalizeSelect = document.getElementById("normalize-by-select");
    normalizeSelect.innerHTML = ""; // Clear old entries

    yFields.forEach(field => {
        const option = document.createElement("option");
        option.value = field;
        option.textContent = field;
        normalizeSelect.appendChild(option);
    });

    // Show normalization controls
    document.getElementById("normalization-controls").style.display = "block";
}

// ===================================================
// 6. Normalize and plot data when user clicks button
// ===================================================
document.getElementById("normalize-button").addEventListener("click", function() {
    plotNormalizedData(); // plot normalized signals


//=============================================     
//====== !!!!! UNCOMMENT THIS PART !!!!!! ===== 
//=============================================   

//    document.getElementById("calibration-section").style.display = "block"; // show calibration UI

//=============================================     
//====== !!!!! UNCOMMENT THIS PART !!!!!! ===== 
//=============================================   

});

// ===================================================
// 7. Generate plot of normalized signals
// ===================================================
function plotNormalizedData() {
    const refField = document.getElementById("normalize-by-select").value;
    const data = mimsRawData;
    const xField = mimsXField;
    const yFields = mimsYFields;

    if (!refField || !data || !yFields) {
        console.error("Missing reference or data");
        return;
    }

    // Normalize all yFields by the selected reference
    const traces = yFields.map(field => {
        const yValues = data.map(row => {
            const refVal = row[refField];
            const val = row[field];
            return (typeof val === "number" && typeof refVal === "number" && refVal !== 0)
                ? val / refVal
                : null;
        });

        return {
            x: data.map(row => row[xField]),
            y: yValues,
            mode: 'lines',
            name: `${field} / ${refField}`,
            line: {
                width: 2,
                dash: field === refField ? 'dot' : 'solid',
                color: mimsFieldColors[field] || undefined
            }
        };
    });

    Plotly.newPlot('normalized-plot-div', traces, {
        title: `Normalized Signals (divided by ${refField})`,
        xaxis: {
            title: xField === "min" ? "Time (min)" :
                   xField === "ms" ? "Time (ms)" : "Time",
            automargin: true
        },
        yaxis: {
            title: `Signal / ${refField} (r.u.)`,
            automargin: true
        },
        legend: {
          orientation: "v",
          x: 1.05,
          xanchor: "left",
          y: 1,
          yanchor: "top"
        },
        margin: {
          l: 60,
          r: 150,
          t: 60,
          b: 50
        }
    });

    // Show normalized plot container and label
    const container = document.getElementById('normalized-container');
    container.style.display = 'block';
    document.getElementById('normalized-preview-label').style.display = 'block';

    requestAnimationFrame(() => {
        Plotly.Plots.resize('normalized-plot-div');
    });
}

// ==============================
// 8. Calibration Input Handling
// ==============================

document.addEventListener("DOMContentLoaded", () => {
  const calibrationContainer = document.getElementById("calibration-inputs-container");
  const addCalButton = document.getElementById("add-calibration-button");
  const calibrationModeSelect = document.getElementById("calibration-mode");

  let calibrationGasCounter = 0;

  addCalButton.addEventListener("click", () => {
      const mode = calibrationModeSelect.value;
      const refField = document.getElementById("normalize-by-select").value || "";
      // Choose appropriate data fields based on calibration mode
      const dataFields = (mode === 'raw') ? mimsYFields : mimsYFields.map(f => `${f} / ${refField}`);

      const gasId = `gas-${calibrationGasCounter++}`;

      const wrapper = document.createElement("div");
      wrapper.className = "calibration-block mb-4 p-3 border rounded";
      wrapper.dataset.gasId = gasId;

      const fieldOptions = dataFields.map(field => `<option value="${field}">${field}</option>`).join("");

      wrapper.innerHTML = `
          <div class="form-row align-items-center mb-2">
              <div class="col-auto">
                  <label for="${gasId}-field">Gas:</label>
                  <select id="${gasId}-field" class="form-control form-control-sm">${fieldOptions}</select>
              </div>
              <div class="col-auto">
                  <button type="button" class="btn btn-danger btn-sm remove-gas-button mt-4">Remove</button>
              </div>
          </div>
          <table class="table table-sm table-bordered calibration-table mb-2">
              <thead>
                  <tr>
                      <th>Signal value (${mode})</th>
                      <th class="calibration-unit-header">Known concentration (please select units)</th>
                      <th></th>
                  </tr>
              </thead>
              <tbody>
                  <tr>
                      <td><input type="number" class="form-control form-control-sm signal-input"></td>
                      <td><input type="number" class="form-control form-control-sm concentration-input"></td>
                      <td><button type="button" class="btn btn-outline-secondary btn-sm add-row-button">+</button></td>
                  </tr>
              </tbody>
          </table>
      `;

      calibrationContainer.appendChild(wrapper);
      document.getElementById("calibration-section").style.display = "block";
  });

  // Delegate remove block / add row actions
  calibrationContainer.addEventListener("click", (e) => {
      if (e.target.classList.contains("remove-gas-button")) {
          e.target.closest(".calibration-block").remove();
      }

      if (e.target.classList.contains("add-row-button")) {
          const row = e.target.closest("tr");
          const tableBody = row.closest("tbody");

          const newRow = document.createElement("tr");
          newRow.innerHTML = `
              <td><input type="number" class="form-control form-control-sm signal-input"></td>
              <td><input type="number" class="form-control form-control-sm concentration-input"></td>
              <td><button type="button" class="btn btn-outline-danger btn-sm remove-row-button">−</button></td>
          `;

          tableBody.appendChild(newRow);
      }

      if (e.target.classList.contains("remove-row-button")) {
          e.target.closest("tr").remove();
      }
  });

  // Update calibration unit header on unit change
  document.getElementById("calibration-units").addEventListener("change", () => {
    const unit = document.getElementById("calibration-units").value;
    document.querySelectorAll(".calibration-unit-header").forEach(header => {
      header.textContent = `Known concentration (${unit})`;
    });
  });
});