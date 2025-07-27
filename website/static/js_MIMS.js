// ========================================
// 0. Global variables to store parsed data
// ========================================
let selectedFile = null;         // User-selected file
let mimsRawData = [];            // Parsed row data
let mimsXField = "";             // X-axis field: "min", "ms", or "Time"
let mimsYFields = [];            // Y-axis signal fields
let mimsFieldColors = {};        // Store assigned colors for each field

// ======================================================
// 1. Handle file selection (triggered on file input change)
// ======================================================
document.getElementById('MIMS_file').addEventListener('change', function(event) {
    const file = event.target.files[0]; // Get the file from input
    if (!file) {
        console.warn('No file selected.');
        return;
    }
    selectedFile = file;

    // Optional: update the input label
    const label = document.querySelector('label[for="MIMS_file"]');
    if (label) label.textContent = file.name;
});

// ===============================================================
// 2. Handle button click to parse CSV + plot original data
// ===============================================================
document.getElementById('show-image-button').addEventListener('click', function(event) {
    event.preventDefault();
    if (!selectedFile) {
        alert("Please select a file first.");
        return;
    }
    handleMIMSFile(selectedFile); // Call main parsing/plotting logic
});

// ======================================================
// 3. Parse and plot the original MIMS data (Time vs Signals)
// ======================================================
function handleMIMSFile(file) {
    const reader = new FileReader();

    reader.onload = function(e) {
        const content = e.target.result;

        // --- Find where the actual CSV header starts ---
        const pattern = /"Time"\s*,\s*"ms"/gi;
        const matches = [...content.matchAll(pattern)];
        if (matches.length < 1) {
            console.error("❌ Could not find 'Time,ms' header in the file.");
            return;
        }
        const startIndex = matches[0].index;
        const usableContent = content.slice(startIndex); // Trim before CSV starts

        // --- Use PapaParse to parse the CSV ---
        Papa.parse(usableContent, {
            header: true,
            dynamicTyping: true,
            skipEmptyLines: true,

            complete: function(results) {
                const data = results.data;
                let fields = results.meta.fields;

                // Remove columns that are completely empty (null, undefined, NaN, or "")
                fields = fields.filter(field => {
                    return data.some(row => {
                        const value = row[field];
                        return value !== null && value !== undefined && value !== "" && !Number.isNaN(value);
                    });
                });

                // --- Add new column "min" = ms / 60000 ---
                data.forEach(row => {
                    if (typeof row["ms"] === "number") {
                        row["min"] = row["ms"] / 60000;
                    } else {
                        row["min"] = null;
                    }
                });

                // --- Insert "min" into column list right after "ms" ---
                const msIndex = fields.indexOf("ms");
                if (msIndex !== -1) {
                    fields = [...fields.slice(0, msIndex + 1), "min", ...fields.slice(msIndex + 1)];
                } else {
                    fields.push("min");
                }

                // --- Choose the best x-axis: min > ms > Time ---
                const xField = fields.includes("min") ? "min" :
                              fields.includes("ms") ? "ms" : "Time";

                const yFields = fields.filter(f => f !== "Time" && f !== "ms" && f !== "min");

                // --- Store for normalization later ---
                mimsRawData = data;
                mimsXField = xField;
                mimsYFields = yFields;

                // --- Plot original data + capture color after plotting ---
                const traces = yFields.map(field => ({
                    x: data.map(row => row[xField]),
                    y: data.map(row => row[field]),
                    mode: 'lines',
                    name: field,
                    line: { width: 2 }
                }));

                console.log('traces', traces);

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
                    // ✅ Store actual line colors assigned by Plotly
                    plot.data.forEach(trace => {
                        if (trace.name) {
                            mimsFieldColors[trace.name] = trace.line.color;
                        }
                    });
                
                    // ✅ Reveal and resize the plot container
                    const container = document.getElementById('raw-container');
                    container.style.display = 'block';
                    requestAnimationFrame(() => {
                        Plotly.Plots.resize('raw-plot-div');
                    });
                });

                document.getElementById('preview-label').style.display = 'block';

                // --- Populate dropdown for normalization ---
                populateNormalizationDropdown(yFields);
            },

            error: function(err) {
                console.error("❌ Parsing error:", err);
            }
        });
    };

    reader.readAsText(file);
}

// ===================================================================
// 4. Fill the normalization dropdown and enable UI for normalization
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

    // Reveal controls
    document.getElementById("normalization-controls").style.display = "block";
}

// ===================================================
// 5. Normalize and plot data when user clicks button
// ===================================================
document.getElementById("normalize-button").addEventListener("click", function() {
    plotNormalizedData();
});

// ===================================================
// 6. Generate plot of normalized signals
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

    // Normalize all yField, including the selected reference
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
                width: field === refField ? 2 : 2,
                dash: field === refField ? 'dot' : 'solid',
                color: mimsFieldColors[field] || undefined
            }
        };
    });
    
    console.log("📊 Normalized Plot Traces:", traces);
    
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
          orientation: "v",      // vertical (stacked)
          x: 1.05,               // move to the right
          xanchor: "left",       // align from left edge
          y: 1,
          yanchor: "top"
        },
        margin: {
          l: 60,  // left margin
          r: 150, // increase right margin to make space for legend
          t: 60,
          b: 50
        }
    });
    
    // ✅ Reveal the hidden plot container
    const container = document.getElementById('normalized-container');
    container.style.display = 'block';  // Show it first

    // Wait until the next frame so browser lays it out, then resize Plotly
    requestAnimationFrame(() => {
        Plotly.Plots.resize('normalized-plot-div');
    });
    
    // ✅ Show the label
    document.getElementById('normalized-preview-label').style.display = 'block';
}