document.addEventListener("DOMContentLoaded", function () {

  // ----------------------------- //
  // --- IMAGES ON FULL SCREEN --- //
  // ----------------------------- //
  $('img[data-enlargeable]').addClass('img-enlargeable').click(function () {
    const src = $(this).attr('src');
    const modal = $('<div>').css({
      background: `RGBA(0,0,0,.5) url(${src}) no-repeat center`,
      backgroundSize: 'contain',
      width: '100%',
      height: '100%',
      position: 'fixed',
      zIndex: '10000',
      top: '0',
      left: '0',
      cursor: 'zoom-out'
    }).click(() => modal.remove()).appendTo('body');

    $('body').on('keyup.modal-close', function (e) {
      if (e.key === 'Escape') {
        modal.remove();
        $('body').off('keyup.modal-close');
      }
    });
  });

  // -------------------------------------------- //
  // --- Fill file names to the selection box --- //
  // -------------------------------------------- //
  const fileInput = document.getElementById('image');
  if (fileInput) {
    fileInput.addEventListener('change', function () {
      const fileName = Array.from(this.files).map(file => file.name).join(', ');
      const label = this.nextElementSibling;
      if (label) {
        label.innerText = fileName || 'Select files';
      }
    });
  }

  // --------------------------------------------- //
  // --- DRAWING LINES BY MOUSE CLICK IN CANVAS--- //
  // --------------------------------------------- //
  const canvas = document.getElementById("canvas_mouse_clicking");
  const context = canvas?.getContext("2d");
  const img = document.getElementById("img_orig_decoded_from_memory");

  if (!canvas || !context || !img) {
    console.warn("Canvas, context, or image not found.");
    return;
  }

  const img_size_y = img.height;
  const img_size_x = img.width;
  let startX = 0;
  let startY = 0;
  let isDown = false;
  let storedLines = [];
  let coordinates = [];

  // --------------------- //
  // --- INITIAL SETUP --- //
  // --------------------- //
  function initializeCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  initializeCanvasSize();

  window.addEventListener("resize", () => {
    initializeCanvasSize();
    redrawStoredLines();
  });

  // ------------------------ //
  // --- MOUSE INTERACTION -- //
  // ------------------------ //
  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    startX = Math.round(e.clientX - rect.left);
    startY = Math.round(e.clientY - rect.top);
    isDown = true;
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!isDown) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = Math.round(e.clientX - rect.left);
    const mouseY = Math.round(e.clientY - rect.top);

    redrawStoredLines(); // clear and redraw previous lines

    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(mouseX, mouseY);
    context.strokeStyle = '#ff0000';
    context.lineWidth = 3;
    context.stroke();
  });

  canvas.addEventListener("mouseup", (e) => {
    if (!isDown) return;
    isDown = false;

    const rect = canvas.getBoundingClientRect();
    const mouseX = Math.round(e.clientX - rect.left);
    const mouseY = Math.round(e.clientY - rect.top);

    storedLines.push({
      x_coord_initial: startX,
      y_coord_initial: startY,
      x_coord_final: mouseX,
      y_coord_final: mouseY
    });

    coordinates.push({
      startX,
      startY,
      mouseX,
      mouseY,
      canvas_size_x: canvas.width,
      canvas_size_y: canvas.height,
      img_size_x,
      img_size_y
    });

    $.ajax({
      url: "/cell_size_filament/coordinates",
      type: "POST",
      contentType: "application/json",
      data: JSON.stringify(JSON.stringify(coordinates)), // Flask expects double-stringified JSON
      success: function () {
        console.log("Coordinates sent to server.");
      },
      error: function (xhr, status, error) {
        console.error("AJAX error:", error);
      }
    });

    redrawStoredLines();
  });

  canvas.addEventListener("mouseout", () => {
    if (!isDown) return;
    isDown = false;
  });

  // --------------------- //
  // --- CLEAR BUTTON ---- //
  // --------------------- //
  const clearButton = document.getElementById("clear_selection");
  if (clearButton) {
    clearButton.addEventListener("click", () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      storedLines = [];
      coordinates = [];
    });
  }

  // --------------------- //
  // --- DRAWING LINES --- //
  // --------------------- //
  function redrawStoredLines() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    storedLines.forEach(line => {
      context.beginPath();
      context.moveTo(line.x_coord_initial, line.y_coord_initial);
      context.lineTo(line.x_coord_final, line.y_coord_final);
      context.strokeStyle = '#ff0000';
      context.lineWidth = 3;
      context.stroke();
    });
  }

});