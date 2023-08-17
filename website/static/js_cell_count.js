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


// MOUSE CLICKING //
img = document.getElementById("Identified_cells");

img.x = img.getBoundingClientRect().left;
img.y = img.getBoundingClientRect().top;

coordinates = []; // Create empty array

function click(e) {
  img_size_y = img.height;
  img_size_x = img.width;
  x_coord = e.clientX - img.x;
  y_coord = e.clientY - img.y;
  identified_cells = coordinates.length + 1;

  document.getElementById("identified_cells").innerHTML = identified_cells;
  coordinates.push({x_coord, y_coord, img_size_x, img_size_y}); // Append data to array
}

img.addEventListener("click", click);

