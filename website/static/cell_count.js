// SLIDERS //

var slider_1 = document.getElementById("chamber_depth_range");
var slider_2 = document.getElementById("minimal_diameter_range");

var output_1 = document.getElementById("chamber_depth");
var output_2 = document.getElementById("minimal_diameter");

output_1.innerHTML = slider_1.value;
output_2.innerHTML = slider_2.value;

slider_1.oninput = function() {
  output_1.innerHTML = this.value;
}
slider_2.oninput = function() {
    output_2.innerHTML = this.value;
  }


