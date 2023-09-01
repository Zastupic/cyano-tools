// SLIDERS //

var slider_1 = document.getElementById("chamber_depth_range");
var slider_2 = document.getElementById("minimal_diameter_range");
var slider_3 = document.getElementById("expected_cell_size_px_range");

var output_1 = document.getElementById("chamber_depth");
var output_2 = document.getElementById("minimal_diameter");
var output_3 = document.getElementById("expected_cell_size_px");

output_1.innerHTML = slider_1.value;
output_2.innerHTML = slider_2.value;
output_3.innerHTML = slider_3.value;

slider_1.oninput = function() {
  output_1.innerHTML = this.value;
}
slider_2.oninput = function() {
    output_2.innerHTML = this.value;
  }
  slider_3.oninput = function() {
    output_3.innerHTML = this.value;
  }

// MOUSE CLICKING - COORDINATES//
const canvas = document.getElementById("canvas_mouse_clicking");
const img = document.getElementById("Identified_cells");

let img_size_y = img.height;
let img_size_x = img.width;

coordinates = [];

function getMousePosition(canvas, event) {
  let rect = canvas.getBoundingClientRect();

  canvas.height = rect.height;
  canvas.width = rect.width;

  const context = canvas.getContext("2d");

  let x = (event.clientX - rect.left).toFixed(0); //.toFixed(0) = zero digits
  let y = (event.clientY - rect.top).toFixed(0);

  coordinates.push({x, y});

  identified_cells = coordinates.length;
//
 
  // DRAWING A CIRCLE//
  var circle_size = slider_3.value;

  context.beginPath();
  context.arc(x, y, circle_size, 0, 2*Math.PI, false);  
  context.lineWidth = 1;
  context.strokeStyle = '#FF9900';
  context.stroke();

  // DRAWING ALL CIRCLES//
  for (let i = 0; i < coordinates.length; i++){ 
    context.beginPath();
    context.arc(coordinates[i].x, coordinates[i].y, circle_size, 0, 2*Math.PI, false);  
    context.lineWidth = 1;
    context.strokeStyle = '#FF9900';
    context.stroke();
  }

  document.getElementById("identified_cells").innerHTML = identified_cells;

}

// defince mouse click event
canvas.addEventListener("mousedown", function(e){
  getMousePosition(canvas, e);
  });

// MOUSE CLICKING //
//img = document.getElementById("Identified_cells");
//
//img.x = img.getBoundingClientRect().left;
//img.y = img.getBoundingClientRect().top;
//
//coordinates = []; // Create empty array
//
//function click(e) {
//  img_size_y = img.height;
//  img_size_x = img.width;
//  x_coord = e.clientX - img.x;
//  y_coord = e.clientY - img.y;
//  identified_cells = coordinates.length + 1;
//
//  document.getElementById("identified_cells").innerHTML = identified_cells;
//  coordinates.push({x_coord, y_coord, img_size_x, img_size_y}); // Append data to array
//}
//
//img.addEventListener("click", click);



