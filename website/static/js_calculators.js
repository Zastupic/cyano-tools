//-----------------------------//
//--- IMAGES ON FULL SCREEN ---//
//-----------------------------//
$('img[data-enlargeable]').addClass('img-enlargeable').click(function() {
    var src = $(this).attr('src');
    var modal;
  
    function removeModal() {
      modal.remove();
      $('body').off('keyup.modal-close');
    }
    modal = $('<div>').css({
      background: 'RGBA(0,0,0,.5) url(' + src + ') no-repeat center',
      backgroundSize: 'contain',
      width: '100%',
      height: '100%',
      position: 'fixed',
      zIndex: '10000',
      top: '0',
      left: '0',
      cursor: 'zoom-out'
    }).click(function() {
      removeModal();
    }).appendTo('body');
    //handling ESC
    $('body').on('keyup.modal-close', function(e) {
      if (e.key === 'Escape') {
        removeModal();
      }
    });
  });
  
//--------------------------------------------------------------------//
//--- ACCEPT ONLY NUMBERS, COMMA AND DOT AS INPUT FOR FORM-CONTROL ---//
//--------------------------------------------------------------------//
function isNumberKey(evt) {
    var charCode = (evt.which) ? evt.which : evt.keyCode
    if ((charCode < 48 || charCode > 57) && charCode != 44 && charCode != 46)
      return false;
    return true;
  }
//--------------------------------------------//
//--- CO2 CONCENTRATION IN AIR+CO2 MIXTURE ---//
//--------------------------------------------//
// set default values 
document.getElementById('CO2_conc_ppm_for_span').innerHTML = "<b>...</b>";
// Calculate CO2 in air 
function calculateCO2() { 
  var flow_rate_air = parseFloat(document.getElementById("flow_rate_air").value);
  var flow_rate_CO2 = parseFloat(document.getElementById("flow_rate_CO2").value);
  var CO2_in_air_ppm = parseInt(document.getElementById("CO2_in_air_ppm_1").value);
  var CO2_conc_ppm_for_span = ((flow_rate_CO2 + (flow_rate_air * CO2_in_air_ppm / 1e6)) / (flow_rate_CO2 + flow_rate_air))*1e6
  var CO2_conc_percent = CO2_conc_ppm_for_span / 1e4
  var flow_rate_total = flow_rate_CO2 + flow_rate_air
  document.getElementById('CO2_conc_ppm_for_span').innerHTML = "<b>"+CO2_conc_ppm_for_span.toFixed(0)+"</b> ppm (<b>"+CO2_conc_percent.toFixed(2)+"</b> %); total flow rate: "+flow_rate_total+" mL min<sup>-1<sup>";
}
function calculateReverseCO2() {
    // 1. Get Inputs
    const targetPPM = parseFloat(document.getElementById("target_CO2_ppm").value);
    const totalFlow = parseFloat(document.getElementById("target_total_flow").value);
    const airPPM = parseFloat(document.getElementById("CO2_in_air_ppm_target").value);

    // 2. Logic Check: Target must be higher than background air
    if (targetPPM <= airPPM) {
        document.getElementById('req_CO2_span').innerHTML = "<b>Error</b>";
        document.getElementById('req_air_span').innerHTML = "Target must be > Air ppm";
        return;
    }

    // 3. Calculation
    // 1,000,000 represents 100% pure CO2 in ppm
    const flowCO2 = totalFlow * (targetPPM - airPPM) / (1000000 - airPPM);
    const flowAir = totalFlow - flowCO2;

    // 4. Update UI
    document.getElementById('req_CO2_span').innerHTML = "<b>" + flowCO2.toFixed(2) + "</b> mL min<sup>-1</sup>";
    document.getElementById('req_air_span').innerHTML = "<b>" + flowAir.toFixed(1) + "</b> mL min<sup>-1</sup>";
}
//----------------------//
//--- dO2 CALCULATOR ---//
//----------------------//
// set default values 
document.getElementById('dO2_for_span').innerHTML = "<b>...</b>";
// Calculate dO2 in water
function calculate_dO2() { 
  var temperature =  parseFloat(document.getElementById("temperature").value);
  var salinity =  parseFloat(document.getElementById("salinity").value);
  var O2_concentration_in_air =  parseFloat(document.getElementById("O2_concentration_in_air").value);
  var atmospheric_pressure =  parseFloat(document.getElementById("atmospheric_pressure").value);
  var A1 = -173.4292;
  var A2 = 249.6339;
  var A3 = 143.3483;
  var A4 = -21.8492;
  var B1 = -0.033096;
  var B2 = 0.014259;
  var B3 = -0.0017;
  var T = 273.15+temperature;
  var t = temperature;  // in °C
  var pw_hPa = 6.112 * Math.exp((17.67 * t) / (t + 243.5));  // Tetens/Magnus in hPa
  var pw = pw_hPa / 10;  // convert to kPa
  var p = 101.325*atmospheric_pressure;
  var dO2_for_span = ((p-pw)/p)*Math.E**(A1 + A2*100/T + A3*Math.log(T/100) + A4*T/100 + salinity*(B1 + B2*(T/100) + B3*((T/100)**2)))*O2_concentration_in_air/20.9;
  document.getElementById('dO2_for_span').innerHTML = "<b>"+dO2_for_span.toFixed(2)+"</b> mL L<sup>-1</sup> (<b>"+(1.428*dO2_for_span).toFixed(2)+"</b> mg L<sup>-1</sup>; <b>"+(1.428*dO2_for_span/32*1000).toFixed(2)+"</b> μmol L<sup>-1</sup>)";

    if (t < 0 || t > 50) {
    alert("Warning: Temperature outside 0–50°C range; water vapor pressure may be inaccurate.");
  }

}
//---------------------------------------//
//--- SPECIFIC GROWTH RATE CALCULATOR ---//
//---------------------------------------//
// set default values 
document.getElementById('growth_rate_for_span').innerHTML = "<b>...</b>";
// Calculate growth rate
function calculateGrowthRate() { 
  var Doubling_time = parseFloat(document.getElementById("Doubling_time").value);
  var per_time_unit_for_span = document.getElementById("time_unit_from_dropdown").value;
  var growth_rate_for_span = Math.LN2 / Doubling_time;
  document.getElementById('growth_rate_for_span').innerHTML = "<b>"+growth_rate_for_span.toFixed(3)+" "+per_time_unit_for_span+"<sup>-1</sup></b>";
}
//--------------------------------//
//--- DOUBLING TIME CALCULATOR ---//
//--------------------------------//
// set default values 
document.getElementById('doubling_time_for_span').innerHTML = "<b>...</b>";
// Calculate doubling time
function calculateDoublingTime() { 
  var growth_rate_from_dropdown = parseFloat(document.getElementById("growth_rate_from_dropdown").value);
  var time_unit_for_span = document.getElementById("per_time_unit_from_dropdown").value;
  var doubling_time_for_span = Math.LN2 / growth_rate_from_dropdown;
  document.getElementById('doubling_time_for_span').innerHTML = "<b>"+doubling_time_for_span.toFixed(3)+" "+time_unit_for_span;
}
//------------------------//
//--- OD720 CORRECTION ---//
//------------------------//
// set default values 
document.getElementById('corrected_OD_720_PBRFMT150_for_span').innerHTML = "<b>...</b>";
document.getElementById('corrected_OD_720_MC1000_for_span').innerHTML = "<b>...</b>";
document.getElementById('corrected_OD_720_AquaPen_for_span').innerHTML = "<b>...</b>";
// Calculate doubling time
function correct_OD_720_PBRFMT150() { 
  var OD_720_measured_PBR = parseFloat(document.getElementById("OD_720_measured_PBR").value);
  if (OD_720_measured_PBR > 0.4) {
    var corrected_OD_720_PBRFMT150_for_span = 0.23 * Math.exp(1.83 * OD_720_measured_PBR);
  } else {
    var corrected_OD_720_PBRFMT150_for_span = OD_720_measured_PBR;
  }
  document.getElementById('corrected_OD_720_PBRFMT150_for_span').innerHTML = "<b>"+corrected_OD_720_PBRFMT150_for_span.toFixed(3)+"</b>";
}
function correct_OD_720_MC1000(){
  var OD_720_measured_MC1000 = parseFloat(document.getElementById("OD_720_measured_MC1000").value);
  if (OD_720_measured_MC1000 > 0.4) {
    var corrected_OD_720_MC1000_for_span = 0.029 + 0.143 * Math.exp(2.497 * OD_720_measured_MC1000);
  } else {
    var corrected_OD_720_MC1000_for_span = OD_720_measured_MC1000;
  }
  document.getElementById('corrected_OD_720_MC1000_for_span').innerHTML = "<b>"+corrected_OD_720_MC1000_for_span.toFixed(3)+"</b>";
}
function correct_OD_720_AquaPen(){
  var OD_720_measured_AquaPen = parseFloat(document.getElementById("OD_720_measured_AquaPen").value);
  if (OD_720_measured_AquaPen > 0.4) {
    var corrected_OD_720_AquaPen_for_span = 0.247 * Math.exp(1.677 * OD_720_measured_AquaPen);
  } else {
    var corrected_OD_720_AquaPen_for_span = OD_720_measured_AquaPen;
  }
  
  document.getElementById('corrected_OD_720_AquaPen_for_span').innerHTML = "<b>"+corrected_OD_720_AquaPen_for_span.toFixed(3)+"</b>";
}
//--------------------------------------//
//--- ABSORBANCE AND OD RECALCULATOR ---//
//--------------------------------------//
// set default values 
document.getElementById('recalculated_A2_for_span').innerHTML = "<b>...</b>";
document.getElementById('recalculated_OD2_for_span').innerHTML = "<b>...</b>";
document.getElementById('warning_message_for_span').innerHTML = "";

// Calculate Absorbance 2
function calculate_A2() { 
  var A1_measured = parseFloat(document.getElementById("A1_measured").value);
  var thickness_cuvette_1 = parseFloat(document.getElementById("thickness_cuvette_1").value);
  var thickness_cuvette_2 = parseFloat(document.getElementById("thickness_cuvette_2").value);
  var recalculated_A2_for_span = A1_measured * (thickness_cuvette_2 / thickness_cuvette_1);
  document.getElementById('recalculated_A2_for_span').innerHTML = "<b>"+recalculated_A2_for_span.toFixed(2)+"</b>";
}

// Recalculate OD 
function recalculate_OD() { 
  var measuring_device_1_from_dropdown = document.getElementById("measuring_device_1_from_dropdown").value;
  var measuring_device_2_from_dropdown = document.getElementById("measuring_device_2_from_dropdown").value;
  var OD_in_device_1_mesured = parseFloat(document.getElementById("OD_in_device_1_mesured").value);
  var measuring_device_1_for_span = measuring_device_1_from_dropdown;
  var measuring_device_2_for_span = measuring_device_2_from_dropdown;
  var chl_a_recalculated_for_span = null;
  var OD_in_device_1_for_span = OD_in_device_1_mesured;
  var recalculated_OD2_for_span;
  var warning_message_for_span;

  if (measuring_device_1_from_dropdown === "UV-2600"){
    if (measuring_device_2_from_dropdown === "AquaPen"){
      recalculated_OD2_for_span = 0.1321 * OD_in_device_1_mesured - 0.0021;
    } else if (measuring_device_2_from_dropdown === "MC-1000"){
      recalculated_OD2_for_span = 0.6646 * OD_in_device_1_mesured + 0.0176;
    } else if (measuring_device_2_from_dropdown === "FMT-150"){
      recalculated_OD2_for_span = 0.66362 * OD_in_device_1_mesured + 0.0023;
    } else if (measuring_device_2_from_dropdown === "UV-2600"){
      recalculated_OD2_for_span = OD_in_device_1_mesured
    } 

    if (OD_in_device_1_mesured > 1.3){
      warning_message_for_span = "Warning: the entered OD value is higher than the experimentally measured range. Proceed carefully with results interpretation.";
      document.getElementById('chl_a_recalculated_for_span').innerHTML = "";
    } else {
      warning_message_for_span = "";
      chl_a_recalculated_for_span = 1.7572 * OD_in_device_1_mesured - 0.0001;
      document.getElementById('chl_a_recalculated_for_span').innerHTML = 
      "Approximate concentration of Chlorophyll <i>a</i> in the measured Chlorella or Synechocystis culture is "+chl_a_recalculated_for_span.toFixed(2)+" &#xb5g mL<sup>-1</sup>.";
    }
  }

  else if (measuring_device_1_from_dropdown === "AquaPen"){
    if (measuring_device_2_from_dropdown === "UV-2600"){
      recalculated_OD2_for_span = 7.4471 * OD_in_device_1_mesured + 0.0205;
    } else if (measuring_device_2_from_dropdown === "MC-1000"){
      recalculated_OD2_for_span = 4.972 * OD_in_device_1_mesured + 0.0303;
    } else if (measuring_device_2_from_dropdown === "FMT-150"){
      recalculated_OD2_for_span = 4.7628 * OD_in_device_1_mesured + 0.0144;
    } else if (measuring_device_2_from_dropdown === "AquaPen"){
      recalculated_OD2_for_span = OD_in_device_1_mesured
    }
    if (OD_in_device_1_mesured > 0.19){
      warning_message_for_span = "Warning: the entered OD value is higher than the experimentally measured range. Proceed carefully with results interpretation.";
      document.getElementById('chl_a_recalculated_for_span').innerHTML = "";
    } else {
      warning_message_for_span = "";
      chl_a_recalculated_for_span = 12.83 * OD_in_device_1_mesured + 0.0459;
      document.getElementById('chl_a_recalculated_for_span').innerHTML = 
      "Approximate concentration of Chlorophyll <i>a</i> in the measured Chlorella or Synechocystis culture is "+chl_a_recalculated_for_span.toFixed(2)+" &#xb5g mL<sup>-1</sup>.";
    }
  }

  else if (measuring_device_1_from_dropdown === "MC-1000"){
    if (measuring_device_2_from_dropdown === "UV-2600"){
      recalculated_OD2_for_span = 1.4884 * OD_in_device_1_mesured - 0.0288;
    } else if (measuring_device_2_from_dropdown === "AquaPen"){
      recalculated_OD2_for_span = 0.1975 * OD_in_device_1_mesured - 0.0053;
    } else if (measuring_device_2_from_dropdown === "FMT-150"){
      recalculated_OD2_for_span = 0.9533 * OD_in_device_1_mesured - 0.0136;
    } else if (measuring_device_2_from_dropdown === "MC-1000"){
      recalculated_OD2_for_span = OD_in_device_1_mesured
    }
    if (OD_in_device_1_mesured > 0.88){
      warning_message_for_span = "Warning: the entered OD value is higher than the experimentally measured range. Proceed carefully with results interpretation.";
      document.getElementById('chl_a_recalculated_for_span').innerHTML = "";
    } else {
      warning_message_for_span = "";
      chl_a_recalculated_for_span = 2.5981 * OD_in_device_1_mesured - 0.0362;
      document.getElementById('chl_a_recalculated_for_span').innerHTML = 
      "Approximate concentration of Chlorophyll <i>a</i> in the measured Chlorella or Synechocystis culture is "+chl_a_recalculated_for_span.toFixed(2)+" &#xb5g mL<sup>-1</sup>.";
    }
  }

  else if (measuring_device_1_from_dropdown === "FMT-150"){
    if (measuring_device_2_from_dropdown === "UV-2600"){
      recalculated_OD2_for_span = 1.5627 * OD_in_device_1_mesured - 0.0018;
    } else if (measuring_device_2_from_dropdown === "AquaPen"){
      recalculated_OD2_for_span = 0.2075 * OD_in_device_1_mesured - 0.0025;
    } else if (measuring_device_2_from_dropdown === "MC-1000"){
      recalculated_OD2_for_span = 1.0456 * OD_in_device_1_mesured + 0.015;
    } else if (measuring_device_2_from_dropdown === "FMT-150"){
      recalculated_OD2_for_span = OD_in_device_1_mesured
    }
  
    if (OD_in_device_1_mesured > 0.83){
      warning_message_for_span = "Warning: the entered OD value is higher than the experimentally measured range. Proceed carefully with results interpretation.";
      document.getElementById('chl_a_recalculated_for_span').innerHTML = "";
    } else {
      warning_message_for_span = "";
      chl_a_recalculated_for_span = 2.7332 * OD_in_device_1_mesured - 0.0007;
      document.getElementById('chl_a_recalculated_for_span').innerHTML = 
      "Approximate concentration of Chlorophyll <i>a</i> in the measured Chlorella or Synechocystis culture is "+chl_a_recalculated_for_span.toFixed(2)+" &#xb5g mL<sup>-1</sup>.";
    }
  }

    console.log(measuring_device_1_from_dropdown);
    console.log(measuring_device_2_from_dropdown);
    console.log(OD_in_device_1_mesured);
    console.log(warning_message_for_span);
    console.log(chl_a_recalculated_for_span);
  
  document.getElementById('OD_in_device_1_for_span').innerHTML = "<b>"+OD_in_device_1_for_span.toFixed(2)+"</b> in";
  document.getElementById('measuring_device_1_for_span').innerHTML = " <b>"+measuring_device_1_for_span+"</b> equals to <i>OD<sub>720</sub></i>";
  document.getElementById('recalculated_OD2_for_span').innerHTML = " <b>"+recalculated_OD2_for_span.toFixed(2)+"</b> in";
  document.getElementById('measuring_device_2_for_span').innerHTML = " <b>"+measuring_device_2_for_span+"</b>";
  document.getElementById('warning_message_for_span').innerHTML = warning_message_for_span; 
}

//------------------------------------//
//--- SUBSTANCE DILUTION CALCULATOR ---//
//------------------------------------//

// Function to add a new dynamic row for additions
function addAdditionRow() {
    const wrapper = document.getElementById('additions_wrapper');
    const rowId = 'row_' + Date.now();
    const newRow = document.createElement('div');
    newRow.className = 'row mb-2 addition-row';
    newRow.id = rowId;
    newRow.innerHTML = `
        <div class="col-md-3"><small>Time (h)</small><input type="number" class="form-control add-time" oninput="calculateDilutionPlot()"></div>
        <div class="col-md-3"><small>Vol (mL)</small><input type="number" class="form-control add-vol" oninput="calculateDilutionPlot()"></div>
        <div class="col-md-4"><small>Stock Conc (mM, or mg/L)</small><input type="number" class="form-control add-conc" oninput="calculateDilutionPlot()"></div>
        <div class="col-md-2"><small>&nbsp;</small><button class="btn btn-outline-danger btn-sm d-block" onclick="removeAdditionRow('${rowId}')">×</button></div>
    `;
    wrapper.appendChild(newRow);
}

function removeAdditionRow(id) {
    const element = document.getElementById(id);
    if (element) {
        element.remove();
        calculateDilutionPlot();
    }
}

function calculateDilutionPlot() {
    // 1. Core Inputs & Flow Rate (F = D * V)
    const V = parseFloat(document.getElementById("culture_volume").value) || 0;
    const D = parseFloat(document.getElementById("dilution_rate").value) || 0;
    const flowRate = D * V;
    document.getElementById("flow_rate_output").value = flowRate.toFixed(2);

    // 2. Initial C0 Calculation
    const initVol = parseFloat(document.getElementById("init_stock_vol").value) || 0;
    const initStock = parseFloat(document.getElementById("init_stock_conc").value) || 0;
    const C0 = V > 0 ? (initVol * initStock) / V : 0;
    document.getElementById("init_conc_display").value = C0.toFixed(3);

    const maxTime = parseFloat(document.getElementById("time_range").value) || 100;

    // 3. Collect & Sort Additions
    const additions = [];
    document.querySelectorAll('.addition-row').forEach(row => {
        const t = parseFloat(row.querySelector('.add-time').value);
        const v = parseFloat(row.querySelector('.add-vol').value);
        const c = parseFloat(row.querySelector('.add-conc').value);
        if (!isNaN(t) && !isNaN(v) && !isNaN(c)) {
            additions.push({ time: t, vol: v, conc: c });
        }
    });
    additions.sort((a, b) => a.time - b.time);

    // 4. Simulation Loop
    const timeLabels = [];
    const concentrationData = [];
    const steps = 100; // Adjusted resolution to see points clearly
    const dt = maxTime / steps;
    
    let currentC = C0;
    let addIdx = 0;

    for (let i = 0; i <= steps; i++) {
        let t = i * dt;

        // Apply any substance "pulses" that happened in this time step
        while (addIdx < additions.length && additions[addIdx].time <= t) {
            let pulse = additions[addIdx];
            currentC = (currentC * V + pulse.conc * pulse.vol) / V;
            addIdx++;
        }

        timeLabels.push(t.toFixed(0)); // Labels as whole numbers for cleaner axis
        concentrationData.push(currentC.toFixed(3));

        // Washout decay for the next interval: Ct = C * e^(-D*dt)
        currentC = currentC * Math.exp(-D * dt);
    }

    // 5. Render Chart
    const ctx = document.getElementById('dilutionChart').getContext('2d');
    if (window.dilutionChartInstance) { 
        window.dilutionChartInstance.destroy(); 
    }

    window.dilutionChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: timeLabels,
            datasets: [{
                label: 'Substance Concentration',
                data: concentrationData,
                borderColor: '#007bff',                // Blue line
                backgroundColor: 'rgba(0, 123, 255, 0.1)', // Light blue fill
                fill: true,
                pointRadius: 3,                        // Visible round points
                pointBackgroundColor: '#007bff',
                tension: 0.3                           // Smoother curve
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { title: { display: true, text: 'Time (hours)' } },
                y: { title: { display: true, text: 'Concentration' }, beginAtZero: true }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

(function () {
    // Run all calculators so results are visible immediately when a section is opened
    function runAll() {
        calculateReverseCO2();
        calculateCO2();
        calculate_dO2();
        calculateGrowthRate();
        calculateDoublingTime();
        correct_OD_720_PBRFMT150();
        correct_OD_720_MC1000();
        correct_OD_720_AquaPen();
        calculate_A2();
        recalculate_OD();
        calculateDilutionPlot();
    }

    // Auto-open accordion panel targeted by URL hash
    function openByHash(hash) {
        if (!hash) return;
        var card = document.querySelector(hash);
        if (!card) return;
        var collapseDiv = card.querySelector('.collapse');
        if (collapseDiv) { $(collapseDiv).collapse('show'); }
    }

    // OD720 non-linearity chart — data and init function
    var odChartInstance = null;
    var odNonlinearityDetails = document.getElementById('odNonlinearityDetails');

    function initOdChart() {
        if (odChartInstance) return;
            // Data: x = Chlorophyll a (µg/mL), y = OD720 measured — Synechocystis sp. PCC 6803
            var aquapenSynData = [
                {x: 62, y: 1.348833}, {x: 31, y: 0.962533}, {x: 15.5, y: 0.637767},
                {x: 7.75, y: 0.3452}, {x: 3.875, y: 0.168167}, {x: 1.9375, y: 0.074033},
                {x: 0.96875, y: 0.0219}, {x: 0.484375, y: -0.002},
                {x: 0.2421875, y: -0.003867}, {x: 0.12109375, y: -0.020567},
                {x: 0.060546875, y: -0.022467}
            ];
            var mc1000Data = [
                {x: 126.007, y: 1.54}, {x: 94.614, y: 1.44}, {x: 75.779, y: 1.35},
                {x: 63.222, y: 1.29}, {x: 47.525, y: 1.18}, {x: 42.293, y: 1.13},
                {x: 31.829, y: 1.01}, {x: 25.551, y: 0.91}, {x: 20.528, y: 0.82},
                {x: 15.891, y: 0.71}, {x: 11.011, y: 0.55}, {x: 7.363, y: 0.42},
                {x: 6.098, y: 0.34}, {x: 5.188, y: 0.29}, {x: 4.024, y: 0.23},
                {x: 3.209, y: 0.18}, {x: 2.800, y: 0.16}, {x: 2.481, y: 0.14},
                {x: 2.286, y: 0.13}, {x: 1.880, y: 0.11}, {x: 1.604, y: 0.10}
            ];
            var fmt150Data = [
                {x: 0.00, y: 0}, {x: 0.40, y: 0.082}, {x: 1.00, y: 0.194167},
                {x: 1.79, y: 0.32}, {x: 2.57, y: 0.428667}, {x: 3.36, y: 0.5195},
                {x: 3.75, y: 0.563}, {x: 4.14, y: 0.602333}, {x: 4.52, y: 0.641833},
                {x: 4.91, y: 0.677833}, {x: 5.68, y: 0.742167}, {x: 7.21, y: 0.858167},
                {x: 9.10, y: 0.979167}, {x: 12.81, y: 1.176667}, {x: 16.42, y: 1.327667},
                {x: 21.68, y: 1.510667}, {x: 26.74, y: 1.657167}
            ];
            odChartInstance = new Chart(document.getElementById('odNonlinearityChart'), {
                type: 'scatter',
                data: {
                    datasets: [
                        {
                            label: 'AquaPen',
                            data: aquapenSynData,
                            borderColor: '#ff6600', backgroundColor: 'transparent',
                            showLine: false, pointRadius: 4, borderWidth: 2
                        },
                        {
                            label: 'MC-1000',
                            data: mc1000Data,
                            borderColor: '#009933', backgroundColor: 'transparent',
                            showLine: false, pointRadius: 4, borderWidth: 2
                        },
                        {
                            label: 'FMT-150',
                            data: fmt150Data,
                            borderColor: '#9900cc', backgroundColor: 'transparent',
                            showLine: false, pointRadius: 4, borderWidth: 2
                        }
                    ]
                },
                options: {
                    responsive: true,
                    plugins: {
                        legend: { position: 'right' },
                        tooltip: {
                            callbacks: {
                                label: function(ctx) {
                                    return ctx.dataset.label + ': Chl ' + ctx.parsed.x.toFixed(3) +
                                        ' µg/mL → OD₇₂₀ ' + ctx.parsed.y.toFixed(3);
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            title: { display: true, text: 'Chlorophyll a (µg mL⁻¹)', font: {size: 12} },
                            min: 0
                        },
                        y: {
                            title: { display: true, text: 'OD₇₂₀ measured', font: {size: 12} }
                        }
                    }
                }
            });
    }

    if (odNonlinearityDetails) {
        odNonlinearityDetails.addEventListener('toggle', function () {
            if (this.open) initOdChart();
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        runAll();
        openByHash(window.location.hash);
        if (odNonlinearityDetails) {
            odNonlinearityDetails.open = true;
            initOdChart();
        }
    });

    window.addEventListener('hashchange', function () {
        openByHash(window.location.hash);
    });

    // Re-render dilution chart each time its panel is opened (canvas must be visible)
    $('#collapseDilution').on('shown.bs.collapse', function () {
        calculateDilutionPlot();
    });
}());