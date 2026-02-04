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
let dilutionChartInstance = null;
function calculateDilutionPlot() {
    // 1. Get Inputs
    const C0 = parseFloat(document.getElementById("init_conc").value);
    const V = parseFloat(document.getElementById("culture_volume").value);
    const D = parseFloat(document.getElementById("dilution_rate").value);
    const maxTime = parseFloat(document.getElementById("time_range").value);

    // 2. Calculate Medium Addition Rate (F = D * V)
    const flowRate = D * V;
    
    // 3. Update the new field
    document.getElementById("flow_rate_output").value = flowRate.toFixed(2);

    // 4. Generate Data for Plot
    const timeLabels = [];
    const concentrationData = [];
    const step = maxTime / 50;

    for (let t = 0; t <= maxTime; t += step) {
        timeLabels.push(t.toFixed(0));
        const Ct = C0 * Math.exp(-D * t);
        concentrationData.push(Ct.toFixed(2));
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
                borderColor: '#007bff',
                backgroundColor: 'rgba(0, 123, 255, 0.1)',
                fill: true,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            scales: {
                x: { title: { display: true, text: 'Time (hours)' } },
                y: { title: { display: true, text: 'Concentration' }, beginAtZero: true }
            }
        }
    });
}

// FIX for the "Initial Load" issue:
// This ensures the plot is drawn as soon as the page finishes loading
window.onload = function() {
    if (document.getElementById("dilutionChart")) {
        calculateDilutionPlot();
    }
};