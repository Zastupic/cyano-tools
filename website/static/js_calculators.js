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
    var pw = 2.338;
    var T = 273.15+temperature;
    var p = 101.32*atmospheric_pressure;

    var dO2_for_span = ((p-pw)/p)*Math.E**(A1 + A2*100/T + A3*Math.log(T/100) + A4*T/100 + salinity*(B1 + B2*(T/100) + B3*((T/100)**2)))*O2_concentration_in_air/20.9;

    document.getElementById('dO2_for_span').innerHTML = "<b>"+dO2_for_span.toFixed(2)+"</b> mL L<sup>-1</sup> (<b>"+(1.428*dO2_for_span).toFixed(2)+"</b> mg L<sup>-1</sup>; <b>"+(1.428*dO2_for_span/32*1000).toFixed(2)+"</b> μmol L<sup>-1</sup>)";
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