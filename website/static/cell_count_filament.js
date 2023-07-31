// SLIDERS //

var slider_1 = document.getElementById("chamber_depth_range");
var slider_2 = document.getElementById("minimal_diameter_range");
var slider_3 = document.getElementById("iterations_range");
var slider_4 = document.getElementById("factor_1_multiplication_range");
var slider_5 = document.getElementById("factor_2_distance_range");

var output_1 = document.getElementById("chamber_depth");
var output_2 = document.getElementById("minimal_diameter");
var output_3 = document.getElementById("number_of_iterations");
var output_4 = document.getElementById("factor_1_multiplication");
var output_5 = document.getElementById("factor_2_distance");

output_1.innerHTML = slider_1.value;
output_2.innerHTML = slider_2.value;
output_3.innerHTML = slider_3.value;
output_4.innerHTML = slider_4.value;
output_5.innerHTML = slider_5.value;

slider_1.oninput = function() {
  output_1.innerHTML = this.value;
}
slider_2.oninput = function() {
    output_2.innerHTML = this.value;
  }
slider_3.oninput = function() {
  output_3.innerHTML = this.value;
}
slider_4.oninput = function() {
  output_4.innerHTML = this.value;
}
slider_5.oninput = function() {
  output_5.innerHTML = this.value;
}