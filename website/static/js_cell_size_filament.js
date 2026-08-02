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

  // ── Drag-and-drop upload zone ───────────────────────────────────────────────
  (function () {
    var zone = document.getElementById('upload-drop-zone');
    var inp  = document.getElementById('image');
    var fn   = document.getElementById('drop-zone-filename');
    if (!zone || !inp) return;

    zone.addEventListener('click', function () { inp.click(); });

    zone.addEventListener('dragover', function (e) {
      e.preventDefault();
      zone.style.borderColor = '#17a2b8';
      zone.style.background  = '#f0faff';
    });
    zone.addEventListener('dragleave', function () {
      zone.style.borderColor = '#adb5bd';
      zone.style.background  = '#fafbfc';
    });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.style.borderColor = '#adb5bd';
      zone.style.background  = '#fafbfc';
      if (e.dataTransfer.files.length) {
        inp.files = e.dataTransfer.files;
        showFile(e.dataTransfer.files[0]);
      }
    });
    inp.addEventListener('change', function () {
      if (this.files.length) showFile(this.files[0]);
    });

    function showFile(file) {
      if (fn) { fn.textContent = file.name; fn.style.display = 'block'; }
      zone.style.borderColor = '#28a745';
      zone.style.background  = '#f0fff4';
    }
  })();

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

    var csrfToken = (document.querySelector('input[name="csrf_token"]') || {}).value || '';
    $.ajax({
      url: "/cell_size_filament/coordinates",
      type: "POST",
      contentType: "application/json",
      headers: { 'X-CSRFToken': csrfToken },
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

// ── Try with example data ──────────────────────────────────────────────
async function loadExampleImage(btn) {
    var orig = btn.textContent;
    try {
        btn.disabled = true; btn.textContent = '\u23F3 Loading\u2026';
        var r = await fetch('/static/images/cells_filamentous_example.tif');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var blob = await r.blob();
        var file = new File([blob], 'cells_filamentous_example.tif', { type: 'image/tiff' });
        var dt = new DataTransfer();
        dt.items.add(file);
        var inp = document.getElementById('image');
        inp.files = dt.files;
        inp.closest('form').submit();
    } catch (e) {
        alert('Could not load example image: ' + e.message);
        btn.disabled = false; btn.textContent = orig;
    }
}