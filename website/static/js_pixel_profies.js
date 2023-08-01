
// MOUSE CLICKING //
img = document.getElementById("Identified_cells");

img.x = img.getBoundingClientRect().left;
img.y = img.getBoundingClientRect().top;

coordinates = []; // Create empty array

//img_size_y = img.height;
//img_size_x = img.width;
//
//canvas = document.getElementById("myCanvas");
//canvas.width = img_size_x;
//canvas.height = img_size_y;
//ctx = canvas.getContext("2d");
//ctx.drawImage(img, 0, 0, img_size_x, img_size_y);

function click(e) {
  img_size_y = img.height;
  img_size_x = img.width;
  x_coord = e.clientX - img.x;
  y_coord = e.clientY - img.y;
  identified_cells = coordinates.length + 1;

  document.getElementById("identified_cells").innerHTML = identified_cells;
  document.getElementById("output").innerHTML = 
    "Missed cells coordinates: X: " + x_coord + ", Y: " + y_coord + 
    " (image size: " + img_size_x + " x " + img_size_y + " px)";
  coordinates.push({x_coord, y_coord, img_size_x, img_size_y}); // Append data to array
  //console.log(coordinates)

  //canvas = document.getElementById("myCanvas");
  //canvas.width = img_size_x;
  //canvas.height = img_size_y;
  //ctx = canvas.getContext("2d");
  //ctx.drawImage(img, 0, 0, img_size_x, img_size_y);
}

img.addEventListener("click", click);

