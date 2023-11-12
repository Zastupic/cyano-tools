//---------------------------------------------//
//--- DRAWING LINES BY MOUSE CLICK IN CANVAS---//
//---------------------------------------------//
//-------------------------//
//--- DEFINING VARIABLES---//
//-------------------------//
const canvas = document.getElementById("canvas_mouse_clicking");
var context = canvas.getContext("2d");
const img = document.getElementById("img_orig_decoded_from_memory");
let img_size_y = img.height;
let img_size_x = img.width;
var storedLines = [];
var isDown;

coordinates = [];

$("#canvas_mouse_clicking").mousedown(function (e) {handleMouseDown(e);});
$("#canvas_mouse_clicking").mousemove(function (e) {handleMouseMove(e);});
$("#canvas_mouse_clicking").mouseup(function (e) {handleMouseUp(e);});
$("#canvas_mouse_clicking").mouseout(function (e) {handleMouseOut(e);});
$("#clear_selection").click(function () {
    context.clearRect(0, 0, canvas.width, canvas.height);
    storedLines = [];
    coordinates = [];
    redrawStoredLines();
});

//-------------------//
//--- MOUSE CLICK ---//
//-------------------//
function handleMouseDown(e) {
    // let the browser know we will handle this event
    e.preventDefault();   
    e.stopPropagation();

    // get the mouse position
    let rect = canvas.getBoundingClientRect();
    canvas.height = rect.height;
    canvas.width = rect.width;

    let mouseX = (e.clientX - rect.left).toFixed(0); //.toFixed(0) = zero digits
    let mouseY = (e.clientY - rect.top).toFixed(0);
    
    // set an isDown flag to indicate dragging has started
    isDown = true;

    // save the starting mouse position (it will be the beginning point of the line)
    startX = mouseX;
    startY = mouseY;
     
    redrawStoredLines();
}

//------------------//
//--- MOUSE MOVe ---//
//------------------//
function handleMouseMove(e){
    // let the browser know we will handle this event
    e.preventDefault();     

    // if we're not dragging, ignore this mousemove
    if(!isDown){ 
      return; }

    // get the mouse position
    let rect = canvas.getBoundingClientRect();
    canvas.height = rect.height;
    canvas.width = rect.width;

    let mouseX = (e.clientX - rect.left).toFixed(0); //.toFixed(0) = zero digits
    let mouseY = (e.clientY - rect.top).toFixed(0);

    // draw the current line
    context.beginPath();
    context.moveTo(startX,startY);
    context.lineTo(mouseX,mouseY);
    context.strokeStyle = '#ff0000';
    context.lineWidth = 3;
    context.stroke()

    redrawStoredLines();
}   

//----------------//
//--- MOUSE UP ---//
//----------------//
function handleMouseUp(e){
    // let the browser know we will handle this event
    e.preventDefault();   

    // clear the dragging flag since the drag is donw
    isDown=false;

    // get the mouse position
    let rect = canvas.getBoundingClientRect();
    canvas.height = rect.height;
    canvas.width = rect.width;

    let canvas_size_y = canvas.height;
    let canvas_size_x = canvas.width;

    let mouseX = (e.clientX - rect.left).toFixed(0); //.toFixed(0) = zero digits
    let mouseY = (e.clientY - rect.top).toFixed(0);

    //console.log(startX,startY, mouseX, mouseY, canvas_size_x, canvas_size_y, img_size_x, img_size_y);
    coordinates.push({startX, startY, mouseX, mouseY, canvas_size_x, canvas_size_y, img_size_x, img_size_y});

    storedLines.push({
     x_coord_initial: startX,
     y_coord_initial: startY,
     x_coord_final: mouseX,
     y_coord_final: mouseY
    });

    // Jsonify data to send it to server as ajax 
    const coordinates_for_flask = JSON.stringify(coordinates); // Stringify converts a JavaScript object or value to a JSON string
    $.ajax({
      url:"/cell_size_filament/coordinates",
      type:"POST",
      contentType: "application/json",
      data: JSON.stringify(coordinates_for_flask)});

    redrawStoredLines();
}

//-----------------//
//--- MOUSE OUT ---//
//-----------------//
function handleMouseOut(e) {
    e.preventDefault();   

    if(!isDown){return;}
    // clear the dragging flag since the drag is donw
    isDown = false;

    storedLines.push({
      x_coord_initial: startX,
      y_coord_initial: startY,
      x_coord_final: mouseX,
      y_coord_final: mouseY
    });
      
    redrawStoredLines();
}

//---------------------//
//--- DRAWING LINES ---//
//---------------------//
function redrawStoredLines() { 
  // needed to clear canvas by button
  //context.clearRect(0, 0, canvas.width, canvas.height);
  
  // define initial state
  if (storedLines.length == 0) {
      return;
  }
  
  // redraw all stored lines
  for (var i = 0; i < storedLines.length; i++) {
    context.beginPath();
    context.moveTo(storedLines[i].x_coord_initial, storedLines[i].y_coord_initial);
    context.lineTo(storedLines[i].x_coord_final, storedLines[i].y_coord_final);
    context.strokeStyle = '#ff0000';
    context.lineWidth = 3;
    context.stroke();
  }
}  

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