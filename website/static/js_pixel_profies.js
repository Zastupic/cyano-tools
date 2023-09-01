// SLIDERS //
if (document.getElementById("expected_cell_size_range") != null){

  var slider_1 = document.getElementById("expected_cell_size_range");
  var output_1 = document.getElementById("expected_cell_size");

  output_1.innerHTML = slider_1.value;
  slider_1.oninput = function() {
    output_1.innerHTML = this.value;
  }
}

// MOUSE CLICKING - COORDINATES//
const canvas = document.getElementById("canvas_mouse_clicking");
const img = document.getElementById("img_orig_decoded_from_memory");

let img_size_y = img.height;
let img_size_x = img.width;

coordinates = [];

function getMousePosition(canvas, event) {
  let rect = canvas.getBoundingClientRect();

  canvas.height = rect.height;
  canvas.width = rect.width;

  let canvas_size_y = canvas.height;
  let canvas_size_x = canvas.width;

  const context = canvas.getContext("2d");

  let x = (event.clientX - rect.left).toFixed(0); //.toFixed(0) = zero digits
  let y = (event.clientY - rect.top).toFixed(0);

  console.log(x, y, canvas_size_x, canvas_size_y, img_size_x, img_size_y);
  coordinates.push({x, y, canvas_size_x, canvas_size_y, img_size_x, img_size_y});
 
  // DRAWING A CIRCLE//
  var circle_size = slider_1.value;

  context.beginPath();
  context.arc(x, y, circle_size, 0, 2*Math.PI, false);  
  context.lineWidth = 1;
  context.strokeStyle = '#FF0000';
  context.stroke();

  // DRAWING ALL CIRCLES//
  for (let i = 0; i < coordinates.length; i++){ 
    context.beginPath();
    context.arc(coordinates[i].x, coordinates[i].y, circle_size, 0, 2*Math.PI, false);  
    context.lineWidth = 1;
    context.strokeStyle = '#FF0000';
    context.stroke();
  }

  //document.getElementById("box_width").innerHTML = ("Resolution of displayed image is " + canvas_size_x + " x " + canvas_size_y + " pixels.");

  // SENDING COORDINATES TO FLASK
  const coordinates_for_flask = JSON.stringify(coordinates); // Stringify converts a JavaScript object or value to a JSON string
  $.ajax({
      url:"/pixel_profiles/coordinates",
      type:"POST",
      contentType: "application/json",
      data: JSON.stringify(coordinates_for_flask)});
}

// defince mouse click event
canvas.addEventListener("mousedown", function(e){
  getMousePosition(canvas, e);
  });




