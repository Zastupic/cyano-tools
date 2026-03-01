/* ============================================================
   js_cell_count_round_cells.js
   Cell Counter UX — all client-side logic.
   Depends on: jQuery (global $), SheetJS (global XLSX), JSZip (global JSZip).
   Web Worker (OpenCV.js cell-counter) is inlined below as a Blob URL.
   ============================================================ */

// ── Inline Web Worker (OpenCV.js cell-counter) ────────────────────────────────
var WORKER_URL = (function () {
    var src = 'self.Module = {\n' +
'    onRuntimeInitialized: function () {\n' +
'        self.postMessage({ type: \'ready\' });\n' +
'    }\n' +
'};\n' +
'try {\n' +
'    importScripts(\'https://docs.opencv.org/4.8.0/opencv.js\');\n' +
'} catch (e) {\n' +
'    self.postMessage({ type: \'error\', message: \'Failed to load OpenCV.js: \' + e.message });\n' +
'}\n' +
'function getThreshType(name) {\n' +
'    switch (name) {\n' +
'        case \'Triangle + Binary\':  return cv.THRESH_TRIANGLE    | cv.THRESH_BINARY;\n' +
'        case \'To zero + Triangle\': return cv.THRESH_TOZERO      | cv.THRESH_TRIANGLE;\n' +
'        case \'Binary + Otsu\':      return cv.THRESH_BINARY      | cv.THRESH_OTSU;\n' +
'        case \'Binary Inv + Otsu\':  return cv.THRESH_BINARY_INV  | cv.THRESH_OTSU;\n' +
'        case \'Binary\':             return cv.THRESH_BINARY;\n' +
'        case \'To zero\':            return cv.THRESH_TOZERO;\n' +
'        case \'Triangle\':           return cv.THRESH_TRIANGLE;\n' +
'        case \'Otsu\':               return cv.THRESH_OTSU;\n' +
'        default:                   return cv.THRESH_TRIANGLE | cv.THRESH_BINARY;\n' +
'    }\n' +
'}\n' +
'var ALL_THRESHOLDS = [\n' +
'    \'Triangle + Binary\',\n' +
'    \'Binary + Otsu\',\n' +
'    \'Binary Inv + Otsu\',\n' +
'    \'To zero + Triangle\',\n' +
'    \'Binary\',\n' +
'    \'To zero\',\n' +
'    \'Triangle\',\n' +
'    \'Otsu\',\n' +
'    \'Adaptive Mean\',\n' +
'    \'Adaptive Gaussian\'\n' +
'];\n' +
'function buildGreyTh(imgBGR, microscopyMode, blurRadius, claheClip) {\n' +
'    var kSize = Math.max(1, parseInt(blurRadius) || 3);\n' +
'    var imgBlur  = new cv.Mat();\n' +
'    var imgGrey  = new cv.Mat();\n' +
'    var imgGreyTh = new cv.Mat();\n' +
'    cv.blur(imgBGR, imgBlur, new cv.Size(kSize, kSize));\n' +
'    cv.cvtColor(imgBlur, imgGrey, cv.COLOR_BGR2GRAY);\n' +
'    imgBlur.delete();\n' +
'    if (claheClip && claheClip > 0) {\n' +
'        try {\n' +
'            var clahe = cv.createCLAHE(claheClip, new cv.Size(8, 8));\n' +
'            var imgClahe = new cv.Mat();\n' +
'            clahe.apply(imgGrey, imgClahe);\n' +
'            imgGrey.delete();\n' +
'            imgGrey = imgClahe;\n' +
'            clahe.delete();\n' +
'        } catch (e) {}\n' +
'    }\n' +
'    if (microscopyMode === \'brightfield\') {\n' +
'        cv.bitwise_not(imgGrey, imgGreyTh);\n' +
'        imgGrey.delete();\n' +
'    } else {\n' +
'        imgGreyTh = imgGrey;\n' +
'    }\n' +
'    return imgGreyTh;\n' +
'}\n' +
'function applyThreshold(imgGreyTh, threshName, manualThresh, adaptiveBlockSize, adaptiveC) {\n' +
'    var imgTh = new cv.Mat();\n' +
'    if (manualThresh && manualThresh > 0) {\n' +
'        cv.threshold(imgGreyTh, imgTh, manualThresh, 255, cv.THRESH_BINARY);\n' +
'    } else if (threshName === \'Adaptive Mean\' || threshName === \'Adaptive Gaussian\') {\n' +
'        var block = Math.max(3, Math.round(adaptiveBlockSize || 51));\n' +
'        if (block % 2 === 0) block++;\n' +
'        var cVal  = (adaptiveC !== undefined && adaptiveC !== null) ? Math.round(adaptiveC) : 2;\n' +
'        var method = (threshName === \'Adaptive Mean\') ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;\n' +
'        cv.adaptiveThreshold(imgGreyTh, imgTh, 255, method, cv.THRESH_BINARY, block, cVal);\n' +
'    } else {\n' +
'        cv.threshold(imgGreyTh, imgTh, 0, 255, getThreshType(threshName));\n' +
'    }\n' +
'    return imgTh;\n' +
'}\n' +
'function applyMorphology(imgTh, morphIter) {\n' +
'    if (!morphIter || morphIter === 0) return imgTh;\n' +
'    var kernel = cv.Mat.ones(3, 3, cv.CV_8U);\n' +
'    var result = new cv.Mat();\n' +
'    if (morphIter > 0) {\n' +
'        cv.dilate(imgTh, result, kernel, new cv.Point(-1, -1), morphIter);\n' +
'    } else {\n' +
'        cv.erode(imgTh, result, kernel, new cv.Point(-1, -1), -morphIter);\n' +
'    }\n' +
'    kernel.delete();\n' +
'    imgTh.delete();\n' +
'    return result;\n' +
'}\n' +
'function removeGridLines(imgTh) {\n' +
'    var w = imgTh.cols, h = imgTh.rows;\n' +
'    var hW = Math.max(20, Math.round(w / 8));\n' +
'    var vH = Math.max(20, Math.round(h / 8));\n' +
'    var hK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(hW, 1));\n' +
'    var hL = new cv.Mat();\n' +
'    cv.morphologyEx(imgTh, hL, cv.MORPH_OPEN, hK);\n' +
'    hK.delete();\n' +
'    var vK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, vH));\n' +
'    var vL = new cv.Mat();\n' +
'    cv.morphologyEx(imgTh, vL, cv.MORPH_OPEN, vK);\n' +
'    vK.delete();\n' +
'    var mask = new cv.Mat();\n' +
'    cv.add(hL, vL, mask);\n' +
'    hL.delete(); vL.delete();\n' +
'    var notMask = new cv.Mat();\n' +
'    cv.bitwise_not(mask, notMask);\n' +
'    mask.delete();\n' +
'    var result = new cv.Mat();\n' +
'    cv.bitwise_and(imgTh, notMask, result);\n' +
'    notMask.delete();\n' +
'    imgTh.delete();\n' +
'    return result;\n' +
'}\n' +
'function buildVizBase(imgBGR, imgGrey, microscopyMode) {\n' +
'    var imgViz = new cv.Mat();\n' +
'    if (microscopyMode === \'brightfield\') {\n' +
'        imgBGR.copyTo(imgViz);\n' +
'    } else {\n' +
'        var imgTOZTRI = new cv.Mat();\n' +
'        cv.threshold(imgGrey, imgTOZTRI, 0, 255, cv.THRESH_TOZERO | cv.THRESH_TRIANGLE);\n' +
'        cv.cvtColor(imgTOZTRI, imgViz, cv.COLOR_GRAY2BGR);\n' +
'        imgTOZTRI.delete();\n' +
'    }\n' +
'    return imgViz;\n' +
'}\n' +
'function matToRGBA(mat) {\n' +
'    var rgba = new cv.Mat();\n' +
'    if (mat.channels() === 1) {\n' +
'        cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);\n' +
'    } else if (mat.channels() === 3) {\n' +
'        cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);\n' +
'    } else {\n' +
'        mat.copyTo(rgba);\n' +
'    }\n' +
'    var arr = new Uint8ClampedArray(rgba.data);\n' +
'    rgba.delete();\n' +
'    return arr;\n' +
'}\n' +
'function countCells(imageData, params) {\n' +
'    var pixelSizeNm    = params.pixelSizeNm;\n' +
'    var depthUm        = params.depthUm;\n' +
'    var minDiamUm      = params.minDiamUm;\n' +
'    var maxDiamUm      = params.maxDiamUm || 0;\n' +
'    var threshName     = params.thresholdName;\n' +
'    var microscopyMode = params.microscopyMode || \'fluorescence\';\n' +
'    var roi            = params.roi || null;\n' +
'    var claheClip         = params.claheClip || 0;\n' +
'    var morphIter         = params.morphIter || 0;\n' +
'    var circularityMin    = params.circularityMin || 0;\n' +
'    var manualThresh      = params.manualThresh || 0;\n' +
'    var excludeStripes    = params.excludeStripes || false;\n' +
'    var adaptiveBlockSize = params.adaptiveBlockSize || 51;\n' +
'    var adaptiveC         = (params.adaptiveC !== undefined) ? params.adaptiveC : 2;\n' +
'    var src     = cv.matFromImageData(imageData);\n' +
'    var imgBGR  = new cv.Mat();\n' +
'    cv.cvtColor(src, imgBGR, cv.COLOR_RGBA2BGR);\n' +
'    src.delete();\n' +
'    var imgGreyTh = buildGreyTh(imgBGR, microscopyMode, params.blurRadius, claheClip);\n' +
'    var imgGrey = new cv.Mat();\n' +
'    cv.blur(imgBGR, imgGrey, new cv.Size(3, 3));\n' +
'    var imgGreyForViz = new cv.Mat();\n' +
'    cv.cvtColor(imgGrey, imgGreyForViz, cv.COLOR_BGR2GRAY);\n' +
'    imgGrey.delete();\n' +
'    var imgTh = applyThreshold(imgGreyTh, threshName, manualThresh, adaptiveBlockSize, adaptiveC);\n' +
'    imgGreyTh.delete();\n' +
'    imgTh = applyMorphology(imgTh, morphIter);\n' +
'    if (excludeStripes) {\n' +
'        imgTh = removeGridLines(imgTh);\n' +
'    }\n' +
'    var imgViz  = buildVizBase(imgBGR, imgGreyForViz, microscopyMode);\n' +
'    imgGreyForViz.delete();\n' +
'    var h = imgTh.rows, w = imgTh.cols;\n' +
'    var useRoi = roi && roi.w > 0 && roi.h > 0;\n' +
'    var roiX1 = 0, roiY1 = 0, roiX2 = w, roiY2 = h;\n' +
'    if (useRoi) {\n' +
'        roiX1 = Math.round(roi.x * w);\n' +
'        roiY1 = Math.round(roi.y * h);\n' +
'        roiX2 = Math.round((roi.x + roi.w) * w);\n' +
'        roiY2 = Math.round((roi.y + roi.h) * h);\n' +
'    }\n' +
'    var minDiamPx = minDiamUm * 1000 / pixelSizeNm;\n' +
'    var minArea   = Math.PI * Math.pow(minDiamPx / 2, 2);\n' +
'    var maxArea   = 0;\n' +
'    if (maxDiamUm > 0) {\n' +
'        var maxDiamPx = maxDiamUm * 1000 / pixelSizeNm;\n' +
'        maxArea = Math.PI * Math.pow(maxDiamPx / 2, 2);\n' +
'    }\n' +
'    var circleColor = (microscopyMode === \'brightfield\')\n' +
'        ? new cv.Scalar(0, 0, 0, 255)\n' +
'        : new cv.Scalar(0, 255, 0, 255);\n' +
'    var contours  = new cv.MatVector();\n' +
'    var hierarchy = new cv.Mat();\n' +
'    cv.findContours(imgTh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);\n' +
'    hierarchy.delete();\n' +
'    var cellCountNum  = 0;\n' +
'    var contourData   = [];\n' +
'    var cellDiameters = [];\n' +
'    for (var i = 0; i < contours.size(); i++) {\n' +
'        var cnt  = contours.get(i);\n' +
'        var area = cv.contourArea(cnt);\n' +
'        if (area <= minArea) { cnt.delete(); continue; }\n' +
'        if (maxArea > 0 && area > maxArea) { cnt.delete(); continue; }\n' +
'        if (circularityMin > 0) {\n' +
'            var perim = cv.arcLength(cnt, true);\n' +
'            var circ  = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;\n' +
'            if (circ < circularityMin) { cnt.delete(); continue; }\n' +
'        }\n' +
'        var rect   = cv.boundingRect(cnt);\n' +
'        var xCoord = Math.round(rect.x + rect.width  / 2);\n' +
'        var yCoord = Math.round(rect.y + rect.height / 2);\n' +
'        var radius = Math.max(1, Math.round(rect.width / 2));\n' +
'        if (useRoi && !(xCoord >= roiX1 && xCoord <= roiX2 && yCoord >= roiY1 && yCoord <= roiY2)) {\n' +
'            cnt.delete();\n' +
'            continue;\n' +
'        }\n' +
'        cellCountNum++;\n' +
'        cv.circle(imgViz, new cv.Point(xCoord, yCoord), radius, circleColor, 1);\n' +
'        contourData.push([xCoord, yCoord, radius]);\n' +
'        var diamUm = Math.round(2 * Math.sqrt(area / Math.PI) * pixelSizeNm / 1000 * 100) / 100;\n' +
'        cellDiameters.push(diamUm);\n' +
'        cnt.delete();\n' +
'    }\n' +
'    contours.delete();\n' +
'    if (useRoi) {\n' +
'        cv.rectangle(imgViz,\n' +
'            new cv.Point(roiX1, roiY1),\n' +
'            new cv.Point(roiX2, roiY2),\n' +
'            new cv.Scalar(255, 165, 0, 255), 2);\n' +
'    }\n' +
'    var xNm        = w * pixelSizeNm;\n' +
'    var yNm        = h * pixelSizeNm;\n' +
'    var volMl      = (xNm * yNm * (depthUm * 1000)) / 1e15 / 1e6;\n' +
'    var millionCellsMl = (volMl > 0) ? (cellCountNum / volMl / 1e6) : 0;\n' +
'    var imgAreaMm2 = Math.round((xNm / 1e6) * (yNm / 1e6) * 1000) / 1000;\n' +
'    var imgVolNl   = Math.round((xNm * yNm * (depthUm * 1000)) / 1e15 * 1000) / 1000;\n' +
'    var countedData = matToRGBA(imgViz);\n' +
'    var threshData  = matToRGBA(imgTh);\n' +
'    imgViz.delete();\n' +
'    imgTh.delete();\n' +
'    imgBGR.delete();\n' +
'    return {\n' +
'        countedData: countedData,\n' +
'        threshData: threshData,\n' +
'        width:  w,\n' +
'        height: h,\n' +
'        count:  cellCountNum,\n' +
'        contourData: contourData,\n' +
'        cellDiameters: cellDiameters,\n' +
'        millionCellsMl: isFinite(millionCellsMl) ? millionCellsMl : 0,\n' +
'        imgAreaMm2: imgAreaMm2,\n' +
'        imgVolNl: imgVolNl,\n' +
'        imgVolMl: Math.round(volMl * 1e9) / 1e9,\n' +
'        xUm: Math.round(xNm / 1000),\n' +
'        yUm: Math.round(yNm / 1000),\n' +
'    };\n' +
'}\n' +
'function previewThreshold(imageData, params) {\n' +
'    var claheClip         = params.claheClip || 0;\n' +
'    var morphIter         = params.morphIter || 0;\n' +
'    var manualThresh      = params.manualThresh || 0;\n' +
'    var excludeStripes    = params.excludeStripes || false;\n' +
'    var adaptiveBlockSize = params.adaptiveBlockSize || 51;\n' +
'    var adaptiveC         = (params.adaptiveC !== undefined) ? params.adaptiveC : 2;\n' +
'    var src      = cv.matFromImageData(imageData);\n' +
'    var imgBGR   = new cv.Mat();\n' +
'    cv.cvtColor(src, imgBGR, cv.COLOR_RGBA2BGR);\n' +
'    src.delete();\n' +
'    var imgGreyTh = buildGreyTh(imgBGR, params.microscopyMode || \'fluorescence\', params.blurRadius, claheClip);\n' +
'    imgBGR.delete();\n' +
'    var imgTh = applyThreshold(imgGreyTh, params.thresholdName, manualThresh, adaptiveBlockSize, adaptiveC);\n' +
'    imgGreyTh.delete();\n' +
'    imgTh = applyMorphology(imgTh, morphIter);\n' +
'    if (excludeStripes) {\n' +
'        imgTh = removeGridLines(imgTh);\n' +
'    }\n' +
'    var threshData = matToRGBA(imgTh);\n' +
'    var w = imgTh.cols, h = imgTh.rows;\n' +
'    imgTh.delete();\n' +
'    return { threshData: threshData, width: w, height: h };\n' +
'}\n' +
'function multiThreshold(imageData, params) {\n' +
'    var claheClip         = params.claheClip || 0;\n' +
'    var adaptiveBlockSize = params.adaptiveBlockSize || 51;\n' +
'    var adaptiveC         = (params.adaptiveC !== undefined) ? params.adaptiveC : 2;\n' +
'    var src      = cv.matFromImageData(imageData);\n' +
'    var imgBGR   = new cv.Mat();\n' +
'    cv.cvtColor(src, imgBGR, cv.COLOR_RGBA2BGR);\n' +
'    src.delete();\n' +
'    var imgGreyTh = buildGreyTh(imgBGR, params.microscopyMode || \'fluorescence\', params.blurRadius, claheClip);\n' +
'    imgBGR.delete();\n' +
'    var results = [];\n' +
'    for (var i = 0; i < ALL_THRESHOLDS.length; i++) {\n' +
'        var name  = ALL_THRESHOLDS[i];\n' +
'        var imgTh = applyThreshold(imgGreyTh, name, 0, adaptiveBlockSize, adaptiveC);\n' +
'        results.push({\n' +
'            name:       name,\n' +
'            threshData: matToRGBA(imgTh),\n' +
'            width:  imgTh.cols,\n' +
'            height: imgTh.rows\n' +
'        });\n' +
'        imgTh.delete();\n' +
'    }\n' +
'    imgGreyTh.delete();\n' +
'    return results;\n' +
'}\n' +
'self.onmessage = function (e) {\n' +
'    var msg = e.data;\n' +
'    try {\n' +
'        if (msg.type === \'count\') {\n' +
'            var r = countCells(msg.data.imageData, msg.data.params);\n' +
'            self.postMessage({ type: \'result\', result: r },\n' +
'                [r.countedData.buffer, r.threshData.buffer]);\n' +
'        } else if (msg.type === \'preview\') {\n' +
'            var p = previewThreshold(msg.data.imageData, msg.data.params);\n' +
'            self.postMessage({ type: \'preview\', threshData: p.threshData, width: p.width, height: p.height },\n' +
'                [p.threshData.buffer]);\n' +
'        } else if (msg.type === \'multi\') {\n' +
'            var results = multiThreshold(msg.data.imageData, msg.data.params);\n' +
'            var transfers = results.map(function (r) { return r.threshData.buffer; });\n' +
'            self.postMessage({ type: \'multi\', results: results }, transfers);\n' +
'        }\n' +
'    } catch (err) {\n' +
'        self.postMessage({ type: \'error\', message: err.message || String(err) });\n' +
'    }\n' +
'};\n';
    try {
        return URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    } catch (e) {
        console.warn('Could not create inline worker Blob:', e);
        return null;
    }
})();

// ── Enlargeable images (modal) ────────────────────────────────────────────────
$('img[data-enlargeable]').addClass('img-enlargeable').on('click', function () {
    var src = $(this).attr('src');
    var modal;
    function removeModal() { modal.remove(); $('body').off('keyup.modal-close'); }
    modal = $('<div>').css({
        background: 'RGBA(0,0,0,.5) url(' + src + ') no-repeat center',
        backgroundSize: 'contain', width: '100%', height: '100%',
        position: 'fixed', zIndex: '10000', top: '0', left: '0', cursor: 'zoom-out'
    }).on('click', removeModal).appendTo('body');
    $('body').on('keyup.modal-close', function (e) { if (e.key === 'Escape') removeModal(); });
});

// ── File input: show filename ─────────────────────────────────────────────────
(function () {
    var inp = document.getElementById('selected_image');
    if (!inp) return;
    inp.addEventListener('change', function () {
        var label = this.nextElementSibling;
        if (label) label.innerText = Array.from(this.files).map(function (f) { return f.name; }).join(', ') || 'Select files';
    });
})();

// ── Sliders ────────────────────────────────────────────────────────────────────
(function () {
    function bindSlider(sliderId, outputId) {
        var s = document.getElementById(sliderId);
        var o = document.getElementById(outputId);
        if (!s || !o) return;
        o.innerHTML = s.value;
        s.addEventListener('input', function () { o.innerHTML = this.value; });
    }
    bindSlider('minimal_diameter_range', 'minimal_diameter');
    bindSlider('blur_radius_range',      'blur_radius_val');
    bindSlider('expected_cell_size_px_range', 'expected_cell_size_px');
    bindSlider('max_diam_range',    'max_diameter_val');
    bindSlider('clahe_clip',        'clahe_clip_val');
    bindSlider('morph_iter',        'morph_iter_val');
    bindSlider('circularity_min',   'circularity_val');
    bindSlider('manual_thresh',     'manual_thresh_val');
    bindSlider('adaptive_block_size', 'adaptive_block_val');
    bindSlider('adaptive_c',          'adaptive_c_val');
})();

// ── Reset analysis parameters to defaults ─────────────────────────────────────
var PARAM_DEFAULTS = {
    minimal_diameter_range: 1.0,
    max_diam_range:         0,
    blur_radius_range:      3,
    clahe_clip:             0,
    morph_iter:             0,
    circularity_min:        0,
    manual_thresh:          0,
    adaptive_block_size:    51,
    adaptive_c:             2,
};
var PARAM_OUTPUTS = {
    minimal_diameter_range: 'minimal_diameter',
    max_diam_range:         'max_diameter_val',
    blur_radius_range:      'blur_radius_val',
    clahe_clip:             'clahe_clip_val',
    morph_iter:             'morph_iter_val',
    circularity_min:        'circularity_val',
    manual_thresh:          'manual_thresh_val',
    adaptive_block_size:    'adaptive_block_val',
    adaptive_c:             'adaptive_c_val',
};
(function () {
    var btn = document.getElementById('params-reset-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
        Object.keys(PARAM_DEFAULTS).forEach(function (id) {
            var el = document.getElementById(id);
            var outId = PARAM_OUTPUTS[id];
            if (el) {
                el.value = PARAM_DEFAULTS[id];
                el.dispatchEvent(new Event('input'));
            }
            var out = outId ? document.getElementById(outId) : null;
            if (out) out.innerHTML = PARAM_DEFAULTS[id];
        });
        var chk = document.getElementById('exclude_stripes_check');
        if (chk) { chk.checked = false; chk.dispatchEvent(new Event('change')); }
        triggerAutoCount();
        triggerMultiIfVisible();
    });
})();

// ── Circle line width slider ───────────────────────────────────────────────────
var circleLineWidth = 1;
(function () {
    var sl  = document.getElementById('circle_line_width_range');
    var out = document.getElementById('circle_line_width_val');
    if (!sl) return;
    if (out) out.textContent = sl.value;
    sl.addEventListener('input', function () {
        circleLineWidth = parseInt(this.value) || 1;
        if (out) out.textContent = this.value;
        redrawAllCircles();
    });
})();

// ── localStorage persistence for form fields ──────────────────────────────────
var LS_KEYS = {
    pixel_size:        'cc_pixel_size',
    chamber_depth:     'cc_chamber_depth',
    minimal_diameter:  'cc_minimal_diameter',
    threshold_filter:  'cc_threshold_filter',
};

(function () {
    var pixelInput = document.getElementById('pixel_size');
    if (pixelInput) {
        var saved = localStorage.getItem(LS_KEYS.pixel_size);
        if (saved && pixelInput.value === '') pixelInput.value = saved;
        pixelInput.addEventListener('input', function () {
            localStorage.setItem(LS_KEYS.pixel_size, this.value);
        });
    }

    var depthSlider = document.getElementById('chamber_depth_range');
    if (depthSlider) {
        var savedDepth = localStorage.getItem(LS_KEYS.chamber_depth);
        if (savedDepth && depthSlider.dataset.serverValue === undefined) {
            depthSlider.value = savedDepth;
            var depthOut = document.getElementById('chamber_depth');
            if (depthOut) depthOut.innerHTML = savedDepth;
        }
        depthSlider.addEventListener('change', function () {
            localStorage.setItem(LS_KEYS.chamber_depth, this.value);
        });
    }

    var diamSlider = document.getElementById('minimal_diameter_range');
    if (diamSlider) {
        var savedDiam = localStorage.getItem(LS_KEYS.minimal_diameter);
        if (savedDiam && diamSlider.dataset.serverValue === undefined) {
            diamSlider.value = savedDiam;
            var diamOut = document.getElementById('minimal_diameter');
            if (diamOut) diamOut.innerHTML = savedDiam;
        }
        diamSlider.addEventListener('change', function () {
            localStorage.setItem(LS_KEYS.minimal_diameter, this.value);
        });
    }

    var threshHidden = document.getElementById('threshold_filter');
    if (threshHidden) {
        var savedThresh = localStorage.getItem(LS_KEYS.threshold_filter);
        if (savedThresh && threshHidden.dataset.serverValue === undefined) {
            threshHidden.value = savedThresh;
            var lbl = document.getElementById('selected-thresh-label');
            if (lbl) lbl.textContent = savedThresh;
        }
        threshHidden.addEventListener('change', function () {
            localStorage.setItem(LS_KEYS.threshold_filter, this.value);
        });
    }
})();

// ── Loading overlay + submit button state on form submit ──────────────────────
(function () {
    var form = document.getElementById('cell-count-form');
    if (!form) return;
    form.addEventListener('submit', function (e) {
        var errEl  = document.getElementById('px-volume-error');
        var ps     = parseFloat((document.getElementById('pixel_size') || {}).value);
        // Validate pixel size
        if (!isFinite(ps) || ps <= 0) {
            e.preventDefault();
            if (errEl) { errEl.textContent = '⚠ Please enter a valid pixel size (nm) before running the analysis.'; errEl.style.display = 'block'; }
            var pxEl = document.getElementById('pixel_size'); if (pxEl) pxEl.focus();
            return;
        }
        // Validate imaged volume (mirrors the server check: img_volume_nl > 1)
        var previewImg = document.getElementById('img-upload-preview');
        var depth = parseFloat((document.getElementById('chamber_depth_range') || {}).value) || 120;
        if (previewImg && previewImg.naturalWidth > 0) {
            var xNm   = previewImg.naturalWidth  * ps;
            var yNm   = previewImg.naturalHeight * ps;
            var volNl = xNm * yNm * (depth * 1000) / 1e15;
            if (volNl <= 1) {
                e.preventDefault();
                if (errEl) { errEl.textContent = '⚠ Pixel size is too low — the imaged volume would be ≤ 1 nL. Please increase the pixel size or chamber depth.'; errEl.style.display = 'block'; }
                var pxEl = document.getElementById('pixel_size'); if (pxEl) pxEl.focus();
                return;
            }
        }
        if (errEl) errEl.style.display = 'none';
        var overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'block';
        // Disable submit button and show spinner inside it
        var btn = form.querySelector('button[type="submit"]');
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="custom-spinner-sm" style="border-top-color:#fff;"></span> Analysing…';
        }
    });
    window.addEventListener('pageshow', function () {
        var overlay = document.getElementById('loading-overlay');
        if (overlay) overlay.style.display = 'none';
        // Re-enable submit button only on back-navigation (file input retains file from cache)
        var form2 = document.getElementById('cell-count-form');
        if (form2) {
            var btn = form2.querySelector('button[type="submit"]');
            var inp = document.getElementById('selected_image');
            var hasFile = inp && inp.files && inp.files.length > 0;
            if (btn && hasFile) {
                btn.disabled = false;
                btn.innerHTML = '&#128202; Run complete cell count analysis';
            }
        }
    });
})();

// ── Drag-and-drop upload zone ─────────────────────────────────────────────────
(function () {
    var zone = document.getElementById('upload-drop-zone');
    var inp  = document.getElementById('selected_image');
    if (!zone || !inp) return;

    zone.addEventListener('click', function () { inp.click(); });

    ['dragenter', 'dragover'].forEach(function (evt) {
        zone.addEventListener(evt, function (e) {
            e.preventDefault(); e.stopPropagation();
            zone.style.borderColor = '#17a2b8';
            zone.style.background  = '#e8f7fa';
        });
    });
    ['dragleave', 'dragend'].forEach(function (evt) {
        zone.addEventListener(evt, function () {
            zone.style.borderColor = '#adb5bd';
            zone.style.background  = '#fafbfc';
        });
    });

    zone.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation();
        zone.style.borderColor = '#adb5bd';
        zone.style.background  = '#fafbfc';
        var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!file) return;
        try { var dt = new DataTransfer(); dt.items.add(file); inp.files = dt.files; } catch (_) {}
        inp.dispatchEvent(new Event('change'));
    });
})();

// ── Image preview before submission ──────────────────────────────────────────
(function () {
    var inp       = document.getElementById('selected_image');
    var preview   = document.getElementById('img-upload-preview');
    var box       = document.getElementById('img-upload-preview-box');
    var submitBox = document.getElementById('submit-box');
    var fnLabel   = document.getElementById('drop-zone-filename');
    var zone      = document.getElementById('upload-drop-zone');
    if (!inp || !preview || !box) return;

    inp.addEventListener('change', function () {
        var file = this.files[0];
        if (!file) { box.style.display = 'none'; if (submitBox) submitBox.style.display = 'none'; return; }
        // Show filename in drop zone
        if (fnLabel) { fnLabel.textContent = '✓ ' + file.name; fnLabel.style.display = 'block'; }
        if (zone) { zone.style.borderColor = '#17a2b8'; zone.style.borderStyle = 'solid'; }
        var reader = new FileReader();
        reader.onload = function (e) {
            preview.src = e.target.result;
            box.style.display = 'block';
            if (submitBox) {
                submitBox.style.display = 'block';
                var btn = document.getElementById('run-analysis-btn');
                if (btn) { btn.disabled = false; btn.title = ''; }
            }
            var mb = document.getElementById('multi-thresh-box');
            if (mb) mb.style.display = 'none';
            triggerLivePreview();
            autoRunCount();
            // Show hint after layout settles if pixel size is not yet entered
            setTimeout(function () {
                var ps = parseFloat((document.getElementById('pixel_size') || {}).value);
                if (!isFinite(ps) || ps <= 0) showNoPixelSizeHint();
            }, 200);
        };
        reader.readAsDataURL(file);
    });
})();

// ── Enlarge live preview images / canvases on click ──────────────────────────
(function () {
    function showEnlarged(src) {
        var modal;
        function removeModal() { modal.remove(); $(document).off('keyup.modal-close-preview'); }
        modal = $('<div>').css({
            background: 'RGBA(0,0,0,.85) url(' + src + ') no-repeat center',
            backgroundSize: 'contain', width: '100%', height: '100%',
            position: 'fixed', zIndex: '10000', top: '0', left: '0', cursor: 'zoom-out'
        }).on('click', removeModal).appendTo('body');
        $(document).on('keyup.modal-close-preview', function (e) { if (e.key === 'Escape') removeModal(); });
    }

    var previewImg = document.getElementById('img-upload-preview');
    if (previewImg) {
        previewImg.addEventListener('click', function () {
            if (this.src && this.src !== window.location.href && this.naturalWidth > 0) showEnlarged(this.src);
        });
    }

    ['live-preview-canvas', 'live-counted-canvas'].forEach(function (id) {
        var cv = document.getElementById(id);
        if (!cv) return;
        cv.addEventListener('click', function () {
            if (this.width > 0 && this.height > 0) showEnlarged(this.toDataURL());
        });
    });
})();

// ── Pixel-size calculator ─────────────────────────────────────────────────────
(function () {
    var calcBtn  = document.getElementById('px-calc-toggle');
    var calcBox  = document.getElementById('px-calc-box');
    var applyBtn = document.getElementById('px-calc-apply');
    if (!calcBtn || !calcBox) return;

    calcBtn.addEventListener('click', function () {
        calcBox.style.display = calcBox.style.display === 'none' ? 'block' : 'none';
    });

    function recalc() {
        var objMag   = parseFloat((document.getElementById('px-obj-mag')   || {}).value);
        var camPitch = parseFloat((document.getElementById('px-cam-pitch') || {}).value);
        var crop     = parseFloat((document.getElementById('px-crop-factor') || {}).value) || 1;
        var result   = document.getElementById('px-calc-result');
        if (!isFinite(objMag) || objMag <= 0 || !isFinite(camPitch) || camPitch <= 0) {
            if (result) result.textContent = '—';
            return;
        }
        var pxNm = (camPitch * 1000) / (objMag * crop);
        if (result) result.textContent = pxNm.toFixed(2) + ' nm';
        if (applyBtn) applyBtn.dataset.value = pxNm.toFixed(2);
    }

    ['px-obj-mag', 'px-cam-pitch', 'px-crop-factor'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', recalc);
    });

    if (applyBtn) {
        applyBtn.addEventListener('click', function () {
            var v = this.dataset.value;
            if (!v) return;
            var inp = document.getElementById('pixel_size');
            if (inp) {
                inp.value = v;
                localStorage.setItem(LS_KEYS.pixel_size, v);
                inp.dispatchEvent(new Event('input'));
            }
        });
    }
})();

// ── Copy concentration to clipboard ──────────────────────────────────────────
function copyConcentration() {
    var el = document.getElementById('cell_conc_corrected');
    if (!el) return;
    var text = el.textContent + ' × 10⁶ cells mL⁻¹';
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function () {
            showToast('Copied to clipboard');
        }).catch(function () { fallbackCopy(text); });
    } else {
        fallbackCopy(text);
    }
}

function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Copied to clipboard');
}

function showToast(msg) {
    var t = document.getElementById('cc-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._tid);
    t._tid = setTimeout(function () { t.style.opacity = '0'; }, 2000);
}

// ── Build corrected-canvas helper (shared by exportWithOverlay + downloadAll) ─
function buildCorrectedCanvas() {
    var img    = document.getElementById('Identified_cells');
    var canvas = document.getElementById('canvas_mouse_clicking');
    if (!img) return null;

    var offscreen = document.createElement('canvas');
    offscreen.width  = img.naturalWidth  || img.width;
    offscreen.height = img.naturalHeight || img.height;
    var ctx = offscreen.getContext('2d');

    ctx.drawImage(img, 0, 0, offscreen.width, offscreen.height);

    var serverColor = (typeof microscopy_mode_val !== 'undefined' && microscopy_mode_val === 'brightfield')
        ? '#000000' : '#00cc00';
    ctx.lineWidth   = circleLineWidth || 1;
    ctx.strokeStyle = serverColor;
    for (var i = 0; i < serverCells.length; i++) {
        var c = serverCells[i];
        ctx.beginPath();
        ctx.arc(c.x, c.y, Math.max(1, c.r), 0, 2 * Math.PI);
        ctx.stroke();
    }

    if (canvas) {
        var scaleX = offscreen.width  / (canvas.width  || 1);
        var scaleY = offscreen.height / (canvas.height || 1);
        var sl = document.getElementById('expected_cell_size_px_range');
        var r  = sl ? parseInt(sl.value) : 10;
        ctx.strokeStyle = '#FF9900';
        ctx.lineWidth   = Math.max(1, scaleX);
        for (var j = 0; j < coordinates.length; j++) {
            ctx.beginPath();
            ctx.arc(coordinates[j].x * scaleX, coordinates[j].y * scaleY,
                    r * scaleX, 0, 2 * Math.PI);
            ctx.stroke();
        }
    }
    return offscreen;
}

// ── Export counted image with canvas overlay ──────────────────────────────────
function exportWithOverlay() {
    var offscreen = buildCorrectedCanvas();
    if (!offscreen) return;
    offscreen.toBlob(function (blob) {
        var url = URL.createObjectURL(blob);
        var a   = document.createElement('a');
        a.href     = url;
        a.download = 'cell_count_with_corrections.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }, 'image/png');
}

// ── Cell size histogram ───────────────────────────────────────────────────────
var lastHistDiameters = null;

function drawHistogram(diameters, canvasId) {
    var canvas = document.getElementById(canvasId || 'histogram-canvas');
    if (!canvas || !diameters || diameters.length === 0) return;
    if (!canvasId) lastHistDiameters = diameters;

    var ctx  = canvas.getContext('2d');
    var rect = canvas.getBoundingClientRect();
    var W    = canvas.width  = Math.round(rect.width)  || 300;
    var H    = canvas.height = Math.round(rect.height) || 260;

    // White background
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);

    var min  = Math.min.apply(null, diameters);
    var max  = Math.max.apply(null, diameters);
    if (min === max) { min = Math.max(0, min - 1); max = max + 1; }

    var bins   = Math.max(5, Math.min(30, Math.round(diameters.length / 3)));
    var step   = (max - min) / bins;
    var counts = new Array(bins).fill(0);
    for (var i = 0; i < diameters.length; i++) {
        var b = Math.min(bins - 1, Math.floor((diameters[i] - min) / step));
        counts[b]++;
    }
    var maxCount = Math.max.apply(null, counts);

    var PAD = { left: 36, right: 8, top: 14, bottom: 32 };
    var iW  = W - PAD.left - PAD.right;
    var iH  = H - PAD.top  - PAD.bottom;
    var bW  = iW / bins;

    // Bars
    ctx.fillStyle = '#17a2b8';
    for (var j = 0; j < bins; j++) {
        var bH = maxCount > 0 ? (counts[j] / maxCount) * iH : 0;
        ctx.fillRect(PAD.left + j * bW + 1, PAD.top + iH - bH, bW - 2, bH);
    }

    // Axes
    ctx.strokeStyle = '#888'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, PAD.top);
    ctx.lineTo(PAD.left, PAD.top + iH);
    ctx.lineTo(PAD.left + iW, PAD.top + iH);
    ctx.stroke();

    ctx.fillStyle = '#444'; ctx.font = '10px sans-serif';

    // X axis labels: min, mid, max
    ctx.textAlign = 'center';
    ctx.fillText(min.toFixed(1), PAD.left, H - 16);
    ctx.fillText(((min + max) / 2).toFixed(1), PAD.left + iW / 2, H - 16);
    ctx.fillText(max.toFixed(1), PAD.left + iW, H - 16);

    // X axis title
    ctx.fillText('Diameter (µm)', PAD.left + iW / 2, H - 3);

    // Y axis: 0 at bottom, maxCount at top
    ctx.textAlign = 'right';
    ctx.fillText('0', PAD.left - 3, PAD.top + iH + 1);
    ctx.fillText(String(maxCount), PAD.left - 3, PAD.top + 9);

    // Y axis title (rotated)
    ctx.save();
    ctx.translate(9, PAD.top + iH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('n', 0, 0);
    ctx.restore();
}

// ── Live preview via Web Worker ───────────────────────────────────────────────
var worker        = null;
var workerReady   = false;
var previewPending = false;
var liveEnabled   = true;

(function () {
    if (!WORKER_URL) return;
    try {
        worker = new Worker(WORKER_URL);
    } catch (e) { return; }

    worker.onmessage = function (e) {
        var msg = e.data;
        if (msg.type === 'ready') {
            workerReady = true;
            var btn = document.getElementById('live-preview-btn');
            if (btn) { btn.disabled = false; }
            if (previewPending) { previewPending = false; triggerLivePreview(); }
            autoRunCount();

        } else if (msg.type === 'result') {
            workerBusy = false;
            applyWorkerResult(msg.result);
            if (pendingCountRequest) { pendingCountRequest = false; dispatchCount(); }
            else if (pendingMultiRequest) { pendingMultiRequest = false; triggerMultiIfVisible(); }

        } else if (msg.type === 'preview') {
            var cvEl = document.getElementById('live-preview-canvas');
            var img  = document.getElementById('img-upload-preview');
            if (!cvEl || !img) return;
            cvEl.width = msg.width; cvEl.height = msg.height;
            cvEl.getContext('2d').putImageData(new ImageData(msg.threshData, msg.width, msg.height), 0, 0);

        } else if (msg.type === 'multi') {
            workerBusy = false;
            applyMultiResult(msg.results);
            if (pendingCountRequest) { pendingCountRequest = false; dispatchCount(); }

        } else if (msg.type === 'error') {
            workerBusy = false;
            console.warn('Worker error:', msg.message);
            setSpinner(false);
        }
    };

    worker.onerror = function (e) {
        workerBusy = false;
        console.warn('Worker load error:', e);
        setSpinner(false);
    };
})();

function setSpinner(on) {
    var sp = document.getElementById('live-count-spinner');
    if (sp) sp.style.display = on ? 'inline-flex' : 'none';
}

function showNoPixelSizeHint() {
    var cv = document.getElementById('live-counted-canvas');
    if (!cv) return;
    var rect = cv.getBoundingClientRect();
    var w = Math.max(Math.round(rect.width), 100);
    var h = Math.max(Math.round(rect.height), 60);
    cv.width = w;
    cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#868e96';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('Enter pixel size (nm)', w / 2, h / 2 - 9);
    ctx.font = '12px sans-serif';
    ctx.fillText('to see live cell count', w / 2, h / 2 + 9);
    var hint = document.getElementById('live-pixel-size-hint');
    if (hint) hint.style.display = 'inline';
}

/** Auto-run the live count if worker is ready, pixel size is set, and image is loaded. */
function autoRunCount() {
    if (!worker || !workerReady) return;
    var ps = parseFloat((document.getElementById('pixel_size') || {}).value);
    var previewImg = document.getElementById('img-upload-preview');
    if (!isFinite(ps) || ps <= 0) {
        if (previewImg && previewImg.naturalWidth > 0) showNoPixelSizeHint();
        return;
    }
    if (!previewImg || !previewImg.src || previewImg.src === window.location.href) return;
    setTimeout(dispatchCount, 350);
}

/** Internal: send a count message to the worker (silent — no alerts). */
function dispatchCount() {
    if (!worker || !workerReady) return;
    if (workerBusy) { pendingCountRequest = true; return; }
    var imgData = getImageDataFromPreview();
    if (!imgData) return;
    var params  = getFormParams();
    if (!isFinite(params.pixelSizeNm) || params.pixelSizeNm <= 0) { showNoPixelSizeHint(); return; }
    params.pixelSizeNm = params.pixelSizeNm * (imgData._pixelScale || 1);
    workerBusy = true;
    setSpinner(true);
    worker.postMessage({ type: 'count', data: { imageData: imgData, params: params } },
        [imgData.data.buffer]);
}

function getFormParams() {
    function fv(id) { var el = document.getElementById(id); return el ? parseFloat(el.value) : 0; }
    function sv(id) { var el = document.getElementById(id); return el ? el.value : ''; }
    function bv(id) { var el = document.getElementById(id); return el ? el.checked : false; }

    var microscopyMode = (document.querySelector('input[name="microscopy_mode"]:checked') || {}).value || 'fluorescence';
    var blurRadius = Math.max(1, Math.round(fv('blur_radius_range')));
    return {
        pixelSizeNm:    fv('pixel_size'),
        depthUm:        fv('chamber_depth_range'),
        minDiamUm:      fv('minimal_diameter_range'),
        maxDiamUm:      fv('max_diam_range'),
        thresholdName:  sv('threshold_filter'),
        microscopyMode: microscopyMode,
        blurRadius:     blurRadius || 3,
        claheClip:      fv('clahe_clip'),
        morphIter:      Math.round(fv('morph_iter')),
        circularityMin: fv('circularity_min'),
        manualThresh:   Math.round(fv('manual_thresh')),
        excludeStripes:    bv('exclude_stripes_check'),
        adaptiveBlockSize: fv('adaptive_block_size') || 51,
        adaptiveC:         fv('adaptive_c'),
        roi: currentROI,
    };
}

// Max long-edge pixels sent to the worker for live preview.
// Smaller = faster processing; cell count accuracy is preserved because
// pixelSizeNm is scaled up proportionally so the concentration is identical.
var LIVE_MAX_DIM = 1024;

function getImageDataFromPreview(maxDim) {
    var previewImg = document.getElementById('img-upload-preview');
    if (!previewImg || !previewImg.src || previewImg.src === window.location.href) return null;
    var nw = previewImg.naturalWidth;
    var nh = previewImg.naturalHeight;
    if (nw === 0) return null;
    var limit = maxDim || LIVE_MAX_DIM;
    var scale = (Math.max(nw, nh) > limit) ? limit / Math.max(nw, nh) : 1;
    var w = Math.round(nw * scale);
    var h = Math.round(nh * scale);
    var offscreen = document.createElement('canvas');
    offscreen.width  = w;
    offscreen.height = h;
    var ctx = offscreen.getContext('2d');
    ctx.drawImage(previewImg, 0, 0, w, h);
    var imgData = ctx.getImageData(0, 0, w, h);
    imgData._pixelScale = 1 / scale; // multiply pixelSizeNm by this before sending to worker
    return imgData;
}

// ── Worker busy flag — prevents queuing stale requests ────────────────────────
var workerBusy         = false;
var pendingCountRequest = false;
var pendingMultiRequest = false;

// ── Fast threshold-only preview (for initial image load) ─────────────────────
var previewDebounce = null;
function triggerLivePreview() {
    if (!liveEnabled || !worker || !workerReady) {
        if (!workerReady && worker) previewPending = true;
        return;
    }
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(function () {
        if (workerBusy) return; // skip preview if count is in progress
        var imgData = getImageDataFromPreview();
        if (!imgData) return;
        var params  = getFormParams();
        params.pixelSizeNm = params.pixelSizeNm * (imgData._pixelScale || 1);
        worker.postMessage({ type: 'preview', data: { imageData: imgData, params: params } },
            [imgData.data.buffer]);
    }, 250);
}

// ── Auto-count triggered by param changes (debounced) ────────────────────────
var countDebounce = null;
function triggerAutoCount() {
    clearTimeout(countDebounce);
    countDebounce = setTimeout(function () {
        if (!worker || !workerReady) return;
        dispatchCount();
    }, 600);
}

// ── Re-run threshold comparison thumbnails if they are currently visible ──────
var multiDebounce = null;
function triggerMultiIfVisible() {
    var mb = document.getElementById('multi-thresh-box');
    if (!mb || mb.style.display === 'none') return;
    setMultiSpinner(true);
    clearTimeout(multiDebounce);
    multiDebounce = setTimeout(function () {
        if (!worker || !workerReady) return;
        if (workerBusy) { pendingMultiRequest = true; return; }
        var imgData = getImageDataFromPreview();
        if (!imgData) return;
        var params = getFormParams();
        params.pixelSizeNm = params.pixelSizeNm * (imgData._pixelScale || 1);
        workerBusy = true;
        worker.postMessage({ type: 'multi', data: { imageData: imgData, params: params } },
            [imgData.data.buffer]);
    }, 800);
}

/** Public API kept for backward compat and button click */
function runWorkerCount() {
    if (!worker || !workerReady) return;
    var imgData = getImageDataFromPreview();
    if (!imgData) { alert('Please select an image first.'); return; }
    var params  = getFormParams();
    if (!isFinite(params.pixelSizeNm) || params.pixelSizeNm <= 0) { alert('Please enter a valid pixel size.'); return; }
    params.pixelSizeNm = params.pixelSizeNm * (imgData._pixelScale || 1);
    workerBusy = true;
    setSpinner(true);
    worker.postMessage({ type: 'count', data: { imageData: imgData, params: params } },
        [imgData.data.buffer]);
}

function applyWorkerResult(r) {
    setSpinner(false);

    var threshEl = document.getElementById('live-preview-canvas');
    if (threshEl) {
        threshEl.width = r.width; threshEl.height = r.height;
        threshEl.getContext('2d').putImageData(new ImageData(r.threshData, r.width, r.height), 0, 0);
    }
    var countedEl = document.getElementById('live-counted-canvas');
    if (countedEl) {
        countedEl.width = r.width; countedEl.height = r.height;
        countedEl.getContext('2d').putImageData(new ImageData(r.countedData, r.width, r.height), 0, 0);
    }

    // Update Identified Cells counter and hide the pixel-size hint
    setText('live-cell-count', r.count);
    var hint = document.getElementById('live-pixel-size-hint');
    if (hint) hint.style.display = 'none';
}

function setMultiSpinner(on) {
    var sp = document.getElementById('multi-thresh-spinner');
    var ct = document.getElementById('multi-thresh-container');
    if (sp) sp.style.display = on ? 'inline' : 'none';
    if (ct) ct.style.opacity = on ? '0.45' : '1';
}

function applyMultiResult(results) {
    var container = document.getElementById('multi-thresh-container');
    if (!container) return;
    setMultiSpinner(false);
    container.innerHTML = '';
    for (var i = 0; i < results.length; i++) {
        var r  = results[i];
        var cv = document.createElement('canvas');
        cv.width  = Math.min(r.width,  200);
        cv.height = Math.min(r.height, Math.round(r.height * 200 / r.width));
        cv.title  = r.name;
        cv.style.cursor = 'pointer';
        cv.style.border = '1px solid #ccc';
        cv.style.marginRight = '6px';
        cv.style.marginBottom = '6px';
        var ctx  = cv.getContext('2d');
        var full = document.createElement('canvas');
        full.width = r.width; full.height = r.height;
        full.getContext('2d').putImageData(new ImageData(r.threshData, r.width, r.height), 0, 0);
        ctx.drawImage(full, 0, 0, cv.width, cv.height);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, cv.width, 16);
        ctx.fillStyle = '#fff'; ctx.font = '10px sans-serif';
        ctx.fillText(r.name, 3, 12);

        (function (name) {
            cv.addEventListener('click', function () {
                var hidden = document.getElementById('threshold_filter');
                if (hidden) {
                    hidden.value = name;
                    hidden.dispatchEvent(new Event('change'));
                }
                var lbl = document.getElementById('selected-thresh-label');
                if (lbl) lbl.textContent = name;
                highlightMultiSelected(name);
                triggerAutoCount();
            });
        })(r.name);
        container.appendChild(cv);
    }
    var curThresh = (document.getElementById('threshold_filter') || {}).value || '';
    if (curThresh) highlightMultiSelected(curThresh);
}

function highlightMultiSelected(name) {
    var container = document.getElementById('multi-thresh-container');
    if (!container) return;
    Array.from(container.children).forEach(function (cv) {
        cv.style.borderColor = (cv.title === name) ? '#007bff' : '#ccc';
        cv.style.borderWidth = (cv.title === name) ? '2px' : '1px';
    });
}

// ── Live preview toggle + param-change listeners ──────────────────────────────
(function () {
    var btn = document.getElementById('live-preview-btn');
    if (btn) {
        btn.addEventListener('click', function () {
            liveEnabled = !liveEnabled;
            this.classList.toggle('active', liveEnabled);
            this.classList.toggle('btn-info', liveEnabled);
            this.classList.toggle('btn-outline-info', !liveEnabled);
            this.innerHTML = liveEnabled ? '&#128065; Live preview: ON' : '&#128065; Live preview: OFF';
            if (liveEnabled) triggerAutoCount();
        });
    }

    // All parameter changes → debounced auto-count
    // threshold_filter excluded from multi-refresh: clicking a thumbnail just selects
    // which method to use; no need to regenerate all comparison thumbnails.
    var paramIds = [
        'threshold_filter',
        'chamber_depth_range', 'minimal_diameter_range', 'blur_radius_range',
        'max_diam_range', 'clahe_clip', 'morph_iter', 'circularity_min', 'manual_thresh',
        'adaptive_block_size', 'adaptive_c'
    ];
    paramIds.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        ['input', 'change'].forEach(function (evt) {
            el.addEventListener(evt, triggerAutoCount);
        });
    });

    // Threshold comparison only refreshes on slider release ('change'), not during drag.
    // threshold_filter excluded — selecting a thumbnail doesn't change image preprocessing.
    var multiParamIds = [
        'chamber_depth_range', 'minimal_diameter_range', 'blur_radius_range',
        'max_diam_range', 'clahe_clip', 'morph_iter', 'circularity_min', 'manual_thresh',
        'adaptive_block_size', 'adaptive_c'
    ];
    multiParamIds.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', triggerMultiIfVisible);
    });

    var stripesChk = document.getElementById('exclude_stripes_check');
    if (stripesChk) {
        stripesChk.addEventListener('change', triggerAutoCount);
        stripesChk.addEventListener('change', triggerMultiIfVisible);
    }

    // Microscopy mode toggle (controls row) → trigger recount + refresh comparison thumbnails
    document.querySelectorAll('#microscopy-mode-group label').forEach(function (label) {
        label.addEventListener('click', function () {
            setTimeout(triggerAutoCount, 50);
            setTimeout(triggerMultiIfVisible, 50);
        });
    });

    var px = document.getElementById('pixel_size');
    if (px) px.addEventListener('input', triggerAutoCount);

    // Multi-threshold comparison button — toggles: hides if visible, runs+shows if hidden
    var multiBtn = document.getElementById('multi-thresh-btn');
    if (multiBtn) {
        multiBtn.addEventListener('click', function () {
            var mb = document.getElementById('multi-thresh-box');
            if (mb && mb.style.display !== 'none') {
                mb.style.display = 'none';
                return;
            }
            if (!worker || !workerReady) return;
            var imgData = getImageDataFromPreview();
            if (!imgData) { alert('Please select an image first.'); return; }
            var params = getFormParams();
            params.pixelSizeNm = params.pixelSizeNm * (imgData._pixelScale || 1);
            workerBusy = true;
            worker.postMessage({ type: 'multi', data: { imageData: imgData, params: params } },
                [imgData.data.buffer]);
            if (mb) { mb.style.display = 'block'; setTimeout(function () { mb.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 50); }
            setMultiSpinner(true);
        });
    }
})();

function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
}

// ── ROI drawing tool ──────────────────────────────────────────────────────────
var currentROI    = null;
var roiDrawing    = false;
var roiStart      = null;
var roiToolActive = false;

(function () {
    var toggleBtn  = document.getElementById('roi-toggle-btn');
    var clearBtn   = document.getElementById('roi-clear-btn');
    var roiCanvas  = document.getElementById('roi-canvas');
    var previewImg = document.getElementById('img-upload-preview');

    if (!toggleBtn || !roiCanvas) return;

    toggleBtn.addEventListener('click', function () {
        roiToolActive = !roiToolActive;
        this.classList.toggle('active', roiToolActive);
        roiCanvas.style.cursor       = roiToolActive ? 'crosshair' : 'default';
        roiCanvas.style.pointerEvents = roiToolActive ? 'auto' : 'none';
    });

    if (clearBtn) {
        clearBtn.addEventListener('click', function () {
            currentROI = null;
            setROIHiddenInputs(0, 0, 0, 0);
            var ctx = roiCanvas.getContext('2d');
            ctx.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
        });
    }

    function syncCanvasSize() {
        if (!previewImg) return;
        roiCanvas.width  = previewImg.offsetWidth;
        roiCanvas.height = previewImg.offsetHeight;
    }

    function getPos(e) {
        var rect    = roiCanvas.getBoundingClientRect();
        var clientX = e.touches ? e.touches[0].clientX : e.clientX;
        var clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function drawROIRect(x1, y1, x2, y2) {
        syncCanvasSize();
        var ctx = roiCanvas.getContext('2d');
        ctx.clearRect(0, 0, roiCanvas.width, roiCanvas.height);
        ctx.strokeStyle = 'rgba(255,165,0,0.9)';
        ctx.lineWidth   = 2;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        ctx.setLineDash([]);
    }

    roiCanvas.addEventListener('mousedown', function (e) {
        if (!roiToolActive) return;
        syncCanvasSize(); roiDrawing = true; roiStart = getPos(e);
    });
    roiCanvas.addEventListener('mousemove', function (e) {
        if (!roiDrawing) return;
        drawROIRect(roiStart.x, roiStart.y, getPos(e).x, getPos(e).y);
    });
    roiCanvas.addEventListener('mouseup', function (e) {
        if (!roiDrawing) return;
        roiDrawing = false;
        var p  = getPos(e);
        var cW = roiCanvas.width, cH = roiCanvas.height;
        var x1 = Math.min(roiStart.x, p.x), y1 = Math.min(roiStart.y, p.y);
        var x2 = Math.max(roiStart.x, p.x), y2 = Math.max(roiStart.y, p.y);
        if (Math.abs(x2 - x1) < 5 || Math.abs(y2 - y1) < 5) return;
        currentROI = { x: x1 / cW, y: y1 / cH, w: (x2 - x1) / cW, h: (y2 - y1) / cH };
        setROIHiddenInputs(currentROI.x, currentROI.y, currentROI.w, currentROI.h);
        drawROIRect(x1, y1, x2, y2);
        triggerAutoCount();
    });
})();

function setROIHiddenInputs(x, y, w, h) {
    ['roi_x_pct', 'roi_y_pct', 'roi_w_pct', 'roi_h_pct'].forEach(function (id, idx) {
        var el = document.getElementById(id);
        if (el) el.value = [x, y, w, h][idx];
    });
}

// ================================================================
//  RESULTS SECTION
// ================================================================

var coordinates = [];
var serverCells = [];
var undoStack   = [];

// ── Hover tooltip ─────────────────────────────────────────────────────────────
(function () {
    var cvs     = document.getElementById('canvas_mouse_clicking');
    var tooltip = document.getElementById('cc-tooltip');
    if (!cvs || !tooltip) return;

    cvs.addEventListener('mousemove', function (e) {
        if (!serverCells || serverCells.length === 0) return;
        var rect   = cvs.getBoundingClientRect();
        var scaleX = (typeof pixels_x !== 'undefined' ? pixels_x : 1) / (rect.width  || 1);
        var scaleY = (typeof pixels_y !== 'undefined' ? pixels_y : 1) / (rect.height || 1);
        var mx = (e.clientX - rect.left) * scaleX;
        var my = (e.clientY - rect.top)  * scaleY;
        var found = null, minDist = Infinity;
        for (var i = 0; i < serverCells.length; i++) {
            var c    = serverCells[i];
            var dist = Math.sqrt((mx - c.x) * (mx - c.x) + (my - c.y) * (my - c.y));
            if (dist < c.r + 5 && dist < minDist) { minDist = dist; found = i; }
        }
        if (found !== null) {
            tooltip.style.display = 'block';
            tooltip.style.left    = (e.clientX + 12) + 'px';
            tooltip.style.top     = (e.clientY - 28) + 'px';
            tooltip.textContent   = 'Cell #' + (found + 1);
        } else {
            tooltip.style.display = 'none';
        }
    });
    cvs.addEventListener('mouseleave', function () {
        if (tooltip) tooltip.style.display = 'none';
    });
})();

// ── Zoom / pan ────────────────────────────────────────────────────────────────
(function () {
    var wrapper = document.getElementById('imgbox');
    if (!wrapper) return;
    var scale = 1, panX = 0, panY = 0, panning = false, lastPt = null;

    wrapper.addEventListener('wheel', function (e) {
        e.preventDefault();
        scale = Math.max(1, Math.min(8, scale * (e.deltaY < 0 ? 1.15 : 0.87)));
        applyTransform();
    }, { passive: false });

    wrapper.addEventListener('mousedown', function (e) {
        if (scale <= 1) return;
        panning = true; lastPt = { x: e.clientX, y: e.clientY };
        wrapper.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
        if (!panning) return;
        panX += e.clientX - lastPt.x; panY += e.clientY - lastPt.y;
        lastPt = { x: e.clientX, y: e.clientY }; applyTransform();
    });
    window.addEventListener('mouseup', function () { panning = false; wrapper.style.cursor = ''; });
    wrapper.addEventListener('dblclick', function () { scale = 1; panX = 0; panY = 0; applyTransform(); });

    function applyTransform() {
        var inner = wrapper.querySelector('.insideWrapper');
        if (inner) inner.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
        wrapper.style.cursor = (scale > 1 && !panning) ? 'grab' : '';
    }
})();

// ── Manual-circle-size slider ─────────────────────────────────────────────────
(function () {
    var sl = document.getElementById('expected_cell_size_px_range');
    if (sl) sl.addEventListener('input', function () { redrawAllCircles(); });
})();

// ── Keyboard nudge ────────────────────────────────────────────────────────────
(function () {
    var canvas = document.getElementById('canvas_mouse_clicking');
    if (!canvas) return;
    canvas.setAttribute('tabindex', '0');
    canvas.addEventListener('keydown', function (e) {
        var moved = false, last = coordinates[coordinates.length - 1];
        if (!last) return;
        if (e.key === 'ArrowLeft')  { last.x -= 5; moved = true; }
        if (e.key === 'ArrowRight') { last.x += 5; moved = true; }
        if (e.key === 'ArrowUp')    { last.y -= 5; moved = true; }
        if (e.key === 'ArrowDown')  { last.y += 5; moved = true; }
        if (moved) { e.preventDefault(); redrawAllCircles(); updateStats(); }
    });
})();

// ── Global functions ──────────────────────────────────────────────────────────

function redrawAllCircles() {
    var canvas = document.getElementById('canvas_mouse_clicking');
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    canvas.height = rect.height; canvas.width = rect.width;
    var ctx  = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var imgW = (typeof pixels_x !== 'undefined') ? pixels_x : canvas.width;
    var imgH = (typeof pixels_y !== 'undefined') ? pixels_y : canvas.height;
    var sx   = canvas.width  / imgW;
    var sy   = canvas.height / imgH;

    var serverColor = (typeof microscopy_mode_val !== 'undefined' && microscopy_mode_val === 'brightfield')
        ? '#000000' : '#00cc00';
    ctx.lineWidth = circleLineWidth || 1; ctx.strokeStyle = serverColor;
    for (var i = 0; i < serverCells.length; i++) {
        var c = serverCells[i];
        ctx.beginPath(); ctx.arc(c.x * sx, c.y * sy, Math.max(1, c.r * sx), 0, 2 * Math.PI); ctx.stroke();
    }

    var sl = document.getElementById('expected_cell_size_px_range');
    var r  = sl ? parseInt(sl.value) : 10;
    ctx.strokeStyle = '#FF9900'; ctx.lineWidth = circleLineWidth || 1;
    for (var j = 0; j < coordinates.length; j++) {
        ctx.beginPath(); ctx.arc(coordinates[j].x, coordinates[j].y, r, 0, 2 * Math.PI); ctx.stroke();
    }
}

function updateStats() {
    var elConc = document.getElementById('cell_conc_corrected');
    if (!elConc) return;
    if (typeof volume_imaged_area === 'undefined') return;
    var total = serverCells.length + coordinates.length;
    setText('identified_cells', coordinates.length);
    setText('server_cells_count', serverCells.length);
    setText('total_cells_count', total);
    elConc.innerHTML = (total / volume_imaged_area / 1e6).toFixed(3);
}

function undoLastCell() {
    if (undoStack.length === 0) return;
    var action = undoStack.pop();
    if (action.type === 'add_manual')     coordinates.splice(coordinates.length - 1, 1);
    else if (action.type === 'delete_server') serverCells.splice(action.index, 0, action.cell);
    else if (action.type === 'delete_manual') coordinates.splice(action.index, 0, action.cell);
    redrawAllCircles(); updateStats();
}

// ── Download: ZIP with XLSX + images ─────────────────────────────────────────
function downloadXLSX() { downloadAll(); } // alias kept for backward compat

function downloadAll() {
    if (typeof XLSX === 'undefined') { alert('Spreadsheet library not loaded. Please reload and try again.'); return; }
    if (typeof cells_counted_autom === 'undefined') { alert('No results to export — please run the analysis first.'); return; }

    var totalCells   = serverCells.length + coordinates.length;
    var removedCells = cells_counted_autom - serverCells.length;
    var corrConc     = (totalCells / volume_imaged_area / 1e6).toFixed(3);
    var wb           = XLSX.utils.book_new();

    var summaryData = [
        ['CyanoTools — Cell Counter Results'],
        [],
        ['Parameter', 'Value', 'Unit'],
        ['Microscopy mode',  (typeof microscopy_mode_val  !== 'undefined') ? microscopy_mode_val  : '—', ''],
        ['Threshold filter', (typeof threshold_name_val   !== 'undefined') ? threshold_name_val   : '—', ''],
        [],
        ['Cells identified (automated)',              cells_counted_autom,    ''],
        ['Cells removed (manual correction)',         removedCells,           ''],
        ['Auto-detected cells remaining',             serverCells.length,     ''],
        ['Cells added (manual correction)',           coordinates.length,     ''],
        ['Total cells',                               totalCells,             ''],
        [],
        ['Cell concentration (automated)',            parseFloat(cell_conc_autom_million_cells_per_ml.toFixed(3)), '× 10⁶ cells mL⁻¹'],
        ['Cell concentration (with manual correction)', parseFloat(corrConc),                                      '× 10⁶ cells mL⁻¹'],
        [],
        ['Image parameters'],
        ['Image resolution',        pixels_x + ' × ' + pixels_y,  'pixels'],
        ['Image area',              image_area,                    'mm²'],
        ['Image dimensions',        ((typeof x_um_val !== 'undefined') ? x_um_val : '?') + ' × ' + ((typeof y_um_val !== 'undefined') ? y_um_val : '?'), 'µm'],
        ['Volume of imaged area',   (typeof img_volume_nl_val !== 'undefined') ? img_volume_nl_val : '?', 'nL'],
        ['Pixel size',              size_of_pixel,  'nm'],
        ['Chamber depth',           chamber_depth_um, 'µm'],
        ['Threshold cell diameter', (typeof minimal_size_um_val !== 'undefined') ? minimal_size_um_val : '?', 'µm'],
    ];
    var ws1 = XLSX.utils.aoa_to_sheet(summaryData);
    ws1['!cols'] = [{wch: 44}, {wch: 28}, {wch: 20}];
    XLSX.utils.book_append_sheet(wb, ws1, 'Results');

    if (typeof cell_diameters_val !== 'undefined' && cell_diameters_val.length > 0) {
        var diamData = [['Cell #', 'Diameter (µm)']];
        for (var k = 0; k < cell_diameters_val.length; k++) {
            diamData.push([k + 1, cell_diameters_val[k]]);
        }
        var ws3 = XLSX.utils.aoa_to_sheet(diamData);
        ws3['!cols'] = [{wch: 10}, {wch: 18}];
        XLSX.utils.book_append_sheet(wb, ws3, 'Cell Diameters');
    }

    if (coordinates.length > 0) {
        var coordData = [['Cell #', 'X position (px)', 'Y position (px)']];
        coordinates.forEach(function (c, i) { coordData.push([i + 1, parseInt(c.x), parseInt(c.y)]); });
        var ws2 = XLSX.utils.aoa_to_sheet(coordData);
        ws2['!cols'] = [{wch: 10}, {wch: 20}, {wch: 20}];
        XLSX.utils.book_append_sheet(wb, ws2, 'Manual Corrections');
    }

    // Generate XLSX as array buffer
    var xlsxBuf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

    // Bundle into ZIP with images
    if (typeof JSZip !== 'undefined') {
        var zip = new JSZip();
        zip.file('cell_count_results.xlsx', xlsxBuf);

        // Original image (server result base64 JPEG)
        var bgImg = document.getElementById('Identified_cells');
        if (bgImg && bgImg.src && bgImg.src.indexOf('data:image') === 0) {
            var origB64 = bgImg.src.split(',')[1];
            if (origB64) zip.file('original_image.jpg', origB64, { base64: true });
        }

        // Counted image with manual corrections (rendered from canvas)
        var corrCanvas = buildCorrectedCanvas();
        if (corrCanvas) {
            var corrB64 = corrCanvas.toDataURL('image/png').split(',')[1];
            if (corrB64) zip.file('counted_image_with_corrections.png', corrB64, { base64: true });
        }

        // Cell size histogram (only if it was drawn)
        var histBox = document.getElementById('histogram-box');
        if (histBox && histBox.style.display !== 'none') {
            var histCv = document.getElementById('histogram-canvas');
            if (histCv) {
                var histB64 = histCv.toDataURL('image/png').split(',')[1];
                if (histB64) zip.file('cell_size_histogram.png', histB64, { base64: true });
            }
        }

        var zipBaseName = (typeof upload_image_name !== 'undefined' && upload_image_name)
            ? upload_image_name + '_cell_count' : 'cell_count_results';
        zip.generateAsync({ type: 'blob' }).then(function (content) {
            var url = URL.createObjectURL(content);
            var a   = document.createElement('a');
            a.href  = url; a.download = zipBaseName + '.zip';
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        });

    } else {
        // JSZip not loaded — fallback to plain XLSX download
        var xlsxBaseName = (typeof upload_image_name !== 'undefined' && upload_image_name)
            ? upload_image_name + '_cell_count' : 'cell_count_results';
        var blob = new Blob([xlsxBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href   = url; a.download = xlsxBaseName + '.xlsx';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }
}

// ── Results canvas: manual click to add/remove cells ─────────────────────────
(function () {
    var canvas = document.getElementById('canvas_mouse_clicking');
    if (!canvas) return;

    if (typeof contour_data_val !== 'undefined') {
        serverCells = contour_data_val.map(function (c) { return { x: c[0], y: c[1], r: c[2] }; });
    }

    updateStats();
    var bgImg = document.getElementById('Identified_cells');
    function drawWhenReady() { requestAnimationFrame(function () { redrawAllCircles(); }); }
    if (bgImg && !bgImg.complete) bgImg.addEventListener('load', drawWhenReady);
    else drawWhenReady();

    if (typeof cell_diameters_val !== 'undefined' && cell_diameters_val.length > 0) {
        var histBox = document.getElementById('histogram-box');
        if (histBox) histBox.style.display = 'block';
        drawHistogram(cell_diameters_val);
        // Histogram click → enlarge modal
        var histCanvas = document.getElementById('histogram-canvas');
        if (histCanvas) {
            histCanvas.addEventListener('click', function () {
                $('#histogram-modal').modal('show');
            });
        }
        $('#histogram-modal').on('shown.bs.modal', function () {
            drawHistogram(lastHistDiameters, 'histogram-canvas-large');
            // Click on the large canvas (or modal body) to close
            var largeCv = document.getElementById('histogram-canvas-large');
            if (largeCv) {
                largeCv.style.cursor = 'zoom-out';
                largeCv.onclick = function () { $('#histogram-modal').modal('hide'); };
            }
        });
    }

    function addCellAtPosition(clientX, clientY) {
        var rect = canvas.getBoundingClientRect();
        canvas.height = rect.height; canvas.width = rect.width;
        var cell = {
            x: parseFloat((clientX - rect.left).toFixed(0)),
            y: parseFloat((clientY - rect.top).toFixed(0))
        };
        coordinates.push(cell);
        undoStack.push({ type: 'add_manual', cell: cell });
        redrawAllCircles(); updateStats();
    }

    canvas.addEventListener('mousedown', function (e) {
        if (e.button === 2) return;
        addCellAtPosition(e.clientX, e.clientY);
    });

    canvas.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var rect = canvas.getBoundingClientRect();
        var mx = e.clientX - rect.left, my = e.clientY - rect.top;
        var imgW = (typeof pixels_x !== 'undefined') ? pixels_x : canvas.width;
        var imgH = (typeof pixels_y !== 'undefined') ? pixels_y : canvas.height;
        var sx = canvas.width / imgW, sy = canvas.height / imgH;
        var best = { dist: Infinity, type: null, index: -1 };

        for (var i = 0; i < serverCells.length; i++) {
            var c  = serverCells[i];
            var cx = c.x * sx, cy = c.y * sy, cr = Math.max(1, c.r * sx);
            var d  = Math.sqrt((mx - cx) * (mx - cx) + (my - cy) * (my - cy));
            if (d < cr + 8 && d < best.dist) best = { dist: d, type: 'server', index: i };
        }
        var sl = document.getElementById('expected_cell_size_px_range');
        var r  = sl ? parseInt(sl.value) : 10;
        for (var j = 0; j < coordinates.length; j++) {
            var d = Math.sqrt((mx - coordinates[j].x) * (mx - coordinates[j].x) + (my - coordinates[j].y) * (my - coordinates[j].y));
            if (d < r + 8 && d < best.dist) best = { dist: d, type: 'manual', index: j };
        }

        if (best.type === 'server') {
            var removed = serverCells.splice(best.index, 1)[0];
            undoStack.push({ type: 'delete_server', index: best.index, cell: removed });
            redrawAllCircles(); updateStats();
        } else if (best.type === 'manual') {
            var removed = coordinates.splice(best.index, 1)[0];
            undoStack.push({ type: 'delete_manual', index: best.index, cell: removed });
            redrawAllCircles(); updateStats();
        }
    });

    canvas.addEventListener('touchstart', function (e) {
        e.preventDefault();
        addCellAtPosition(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
})();

// ── Global Ctrl+Z ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault(); undoLastCell();
    }
});
