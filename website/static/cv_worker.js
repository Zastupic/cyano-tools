/* cv_worker.js — shared OpenCV.js Web Worker for CyanoTools cell-analysis pages.
   Loaded as a real static file so the browser can cache both this script and the
   compiled WASM, making subsequent page loads start in milliseconds.
   importScripts uses a relative URL so it always resolves to /static/opencv.js. */

self.Module = {
    onRuntimeInitialized: function () {
        self.postMessage({ type: 'ready' });
    }
};
try {
    importScripts('opencv.js');
} catch (e) {
    self.postMessage({ type: 'error', message: 'Failed to load OpenCV.js: ' + e.message });
}

function getThreshType(name) {
    switch (name) {
        case 'Triangle + Binary':  return cv.THRESH_TRIANGLE    | cv.THRESH_BINARY;
        case 'To zero + Triangle': return cv.THRESH_TOZERO      | cv.THRESH_TRIANGLE;
        case 'Binary + Otsu':      return cv.THRESH_BINARY      | cv.THRESH_OTSU;
        case 'Binary Inv + Otsu':  return cv.THRESH_BINARY_INV  | cv.THRESH_OTSU;
        case 'Binary':             return cv.THRESH_BINARY;
        case 'To zero':            return cv.THRESH_TOZERO;
        case 'Triangle':           return cv.THRESH_TRIANGLE;
        case 'Otsu':               return cv.THRESH_OTSU;
        default:                   return cv.THRESH_BINARY | cv.THRESH_OTSU;
    }
}

var ALL_THRESHOLDS = [
    'Triangle + Binary',
    'Binary + Otsu',
    'Binary Inv + Otsu',
    'To zero + Triangle',
    'Binary',
    'To zero',
    'Triangle',
    'Otsu',
    'Adaptive Mean',
    'Adaptive Gaussian'
];

function buildGreyTh(imgBGR, microscopyMode, blurRadius, claheClip, edgeWeight) {
    var kSize = Math.max(1, parseInt(blurRadius) || 3);
    var imgBlur   = new cv.Mat();
    var imgGrey   = new cv.Mat();
    var imgGreyTh = new cv.Mat();
    cv.blur(imgBGR, imgBlur, new cv.Size(kSize, kSize));
    cv.cvtColor(imgBlur, imgGrey, cv.COLOR_BGR2GRAY);
    imgBlur.delete();
    if (claheClip && claheClip > 0) {
        try {
            var clahe = cv.createCLAHE(claheClip, new cv.Size(8, 8));
            var imgClahe = new cv.Mat();
            clahe.apply(imgGrey, imgClahe);
            imgGrey.delete();
            imgGrey = imgClahe;
            clahe.delete();
        } catch (e) {}
    }
    if (microscopyMode === 'brightfield') {
        var ew = (edgeWeight !== undefined && edgeWeight !== null) ? edgeWeight : 0.5;
        ew = Math.max(0, Math.min(1, ew));
        var imgInv = new cv.Mat();
        cv.bitwise_not(imgGrey, imgInv);
        var sx = new cv.Mat();
        var sy = new cv.Mat();
        cv.Scharr(imgGrey, sx, cv.CV_64F, 1, 0);
        cv.Scharr(imgGrey, sy, cv.CV_64F, 0, 1);
        var sx2 = new cv.Mat(); var sy2 = new cv.Mat();
        cv.multiply(sx, sx, sx2); cv.multiply(sy, sy, sy2);
        var mag64 = new cv.Mat();
        cv.add(sx2, sy2, mag64);
        cv.sqrt(mag64, mag64);
        sx.delete(); sy.delete(); sx2.delete(); sy2.delete();
        var mag8 = new cv.Mat();
        cv.normalize(mag64, mag8, 0, 255, cv.NORM_MINMAX, cv.CV_8U);
        mag64.delete();
        var edgeInv = new cv.Mat();
        cv.bitwise_not(mag8, edgeInv);
        mag8.delete();
        cv.addWeighted(imgInv, 1.0 - ew, edgeInv, ew, 0, imgGreyTh);
        imgInv.delete(); edgeInv.delete();
        imgGrey.delete();
    } else {
        imgGreyTh = imgGrey;
    }
    return imgGreyTh;
}

function applyThreshold(imgGreyTh, threshName, manualThresh, adaptiveBlockSize, adaptiveC) {
    var imgTh = new cv.Mat();
    if (manualThresh && manualThresh > 0) {
        cv.threshold(imgGreyTh, imgTh, manualThresh, 255, cv.THRESH_BINARY);
    } else if (threshName === 'Adaptive Mean' || threshName === 'Adaptive Gaussian') {
        var block = Math.max(3, Math.round(adaptiveBlockSize || 51));
        if (block % 2 === 0) block++;
        var cVal   = (adaptiveC !== undefined && adaptiveC !== null) ? Math.round(adaptiveC) : 2;
        var method = (threshName === 'Adaptive Mean') ? cv.ADAPTIVE_THRESH_MEAN_C : cv.ADAPTIVE_THRESH_GAUSSIAN_C;
        cv.adaptiveThreshold(imgGreyTh, imgTh, 255, method, cv.THRESH_BINARY, block, cVal);
    } else {
        cv.threshold(imgGreyTh, imgTh, 0, 255, getThreshType(threshName));
    }
    return imgTh;
}

function applyMorphology(imgTh, morphIter) {
    if (!morphIter || morphIter === 0) return imgTh;
    var kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    var result = new cv.Mat();
    if (morphIter > 0) {
        cv.dilate(imgTh, result, kernel, new cv.Point(-1, -1), morphIter);
    } else {
        cv.erode(imgTh, result, kernel, new cv.Point(-1, -1), -morphIter);
    }
    kernel.delete();
    imgTh.delete();
    return result;
}

function removeGridLines(imgTh) {
    var w = imgTh.cols, h = imgTh.rows;
    var hW = Math.max(20, Math.round(w / 8));
    var vH = Math.max(20, Math.round(h / 8));
    var hK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(hW, 1));
    var hL = new cv.Mat();
    cv.morphologyEx(imgTh, hL, cv.MORPH_OPEN, hK);
    hK.delete();
    var vK = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, vH));
    var vL = new cv.Mat();
    cv.morphologyEx(imgTh, vL, cv.MORPH_OPEN, vK);
    vK.delete();
    var mask = new cv.Mat();
    cv.add(hL, vL, mask);
    hL.delete(); vL.delete();
    var notMask = new cv.Mat();
    cv.bitwise_not(mask, notMask);
    mask.delete();
    var result = new cv.Mat();
    cv.bitwise_and(imgTh, notMask, result);
    notMask.delete();
    imgTh.delete();
    return result;
}

function buildVizBase(imgBGR, imgGrey, microscopyMode) {
    var imgViz = new cv.Mat();
    if (microscopyMode === 'brightfield') {
        imgBGR.copyTo(imgViz);
    } else {
        var imgTOZTRI = new cv.Mat();
        cv.threshold(imgGrey, imgTOZTRI, 0, 255, cv.THRESH_TOZERO | cv.THRESH_TRIANGLE);
        cv.cvtColor(imgTOZTRI, imgViz, cv.COLOR_GRAY2BGR);
        imgTOZTRI.delete();
    }
    return imgViz;
}

function matToRGBA(mat) {
    var rgba = new cv.Mat();
    if (mat.channels() === 1) {
        cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);
    } else if (mat.channels() === 3) {
        cv.cvtColor(mat, rgba, cv.COLOR_BGR2RGBA);
    } else {
        mat.copyTo(rgba);
    }
    var arr = new Uint8ClampedArray(rgba.data);
    rgba.delete();
    return arr;
}

function countCells(imageData, params) {
    var pixelSizeNm    = params.pixelSizeNm;
    var minDiamUm      = params.minDiamUm;
    var maxDiamUm      = params.maxDiamUm || 0;
    var threshName     = params.thresholdName;
    var microscopyMode = params.microscopyMode || 'fluorescence';
    var roi            = params.roi || null;
    var claheClip         = params.claheClip || 0;
    var morphIter         = params.morphIter || 0;
    var circularityMin    = params.circularityMin || 0;
    var manualThresh      = params.manualThresh || 0;
    var excludeStripes    = params.excludeStripes || false;
    var adaptiveBlockSize = params.adaptiveBlockSize || 51;
    var adaptiveC         = (params.adaptiveC !== undefined) ? params.adaptiveC : 2;
    var src    = cv.matFromImageData(imageData);
    var imgBGR = new cv.Mat();
    cv.cvtColor(src, imgBGR, cv.COLOR_RGBA2BGR);
    src.delete();
    var imgGreyTh = buildGreyTh(imgBGR, microscopyMode, params.blurRadius, claheClip, params.edgeWeight);
    var imgGrey = new cv.Mat();
    cv.blur(imgBGR, imgGrey, new cv.Size(3, 3));
    var imgGreyForViz = new cv.Mat();
    cv.cvtColor(imgGrey, imgGreyForViz, cv.COLOR_BGR2GRAY);
    imgGrey.delete();
    var imgTh = applyThreshold(imgGreyTh, threshName, manualThresh, adaptiveBlockSize, adaptiveC);
    imgGreyTh.delete();
    imgTh = applyMorphology(imgTh, morphIter);
    if (excludeStripes) {
        imgTh = removeGridLines(imgTh);
    }
    var imgViz = buildVizBase(imgBGR, imgGreyForViz, microscopyMode);
    imgGreyForViz.delete();
    var h = imgTh.rows, w = imgTh.cols;
    var useRoi = roi && roi.w > 0 && roi.h > 0;
    var roiX1 = 0, roiY1 = 0, roiX2 = w, roiY2 = h;
    if (useRoi) {
        roiX1 = Math.round(roi.x * w);
        roiY1 = Math.round(roi.y * h);
        roiX2 = Math.round((roi.x + roi.w) * w);
        roiY2 = Math.round((roi.y + roi.h) * h);
    }
    var minDiamPx = minDiamUm * 1000 / pixelSizeNm;
    var minArea   = Math.PI * Math.pow(minDiamPx / 2, 2);
    var maxArea   = 0;
    if (maxDiamUm > 0) {
        var maxDiamPx = maxDiamUm * 1000 / pixelSizeNm;
        maxArea = Math.PI * Math.pow(maxDiamPx / 2, 2);
    }
    var circleColor = (microscopyMode === 'brightfield')
        ? new cv.Scalar(0, 0, 0, 255)
        : new cv.Scalar(0, 255, 0, 255);
    var contours  = new cv.MatVector();
    var hierarchy = new cv.Mat();
    cv.findContours(imgTh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    hierarchy.delete();
    var cellCountNum = 0;
    var contourData  = [];
    for (var i = 0; i < contours.size(); i++) {
        var cnt  = contours.get(i);
        var area = cv.contourArea(cnt);
        if (area <= minArea) { cnt.delete(); continue; }
        if (maxArea > 0 && area > maxArea) { cnt.delete(); continue; }
        if (circularityMin > 0) {
            var perim = cv.arcLength(cnt, true);
            var circ  = perim > 0 ? (4 * Math.PI * area) / (perim * perim) : 0;
            if (circ < circularityMin) { cnt.delete(); continue; }
        }
        if (params.maxAspectRatio > 0) {
            var brect = cv.boundingRect(cnt);
            var ar = Math.max(brect.width, brect.height) / Math.max(1, Math.min(brect.width, brect.height));
            if (ar > params.maxAspectRatio) { cnt.delete(); continue; }
        }
        var rect   = cv.boundingRect(cnt);
        var xCoord = Math.round(rect.x + rect.width  / 2);
        var yCoord = Math.round(rect.y + rect.height / 2);
        var radius = Math.max(1, Math.round(rect.width / 2));
        if (useRoi && !(xCoord >= roiX1 && xCoord <= roiX2 && yCoord >= roiY1 && yCoord <= roiY2)) {
            cnt.delete();
            continue;
        }
        cellCountNum++;
        var cntVec = new cv.MatVector();
        cntVec.push_back(cnt);
        cv.drawContours(imgViz, cntVec, 0, circleColor, 1);
        cntVec.delete();
        contourData.push([xCoord, yCoord, radius]);
        cnt.delete();
    }
    contours.delete();
    if (useRoi) {
        cv.rectangle(imgViz,
            new cv.Point(roiX1, roiY1),
            new cv.Point(roiX2, roiY2),
            new cv.Scalar(255, 165, 0, 255), 2);
    }
    var countedData = matToRGBA(imgViz);
    var threshData  = matToRGBA(imgTh);
    imgViz.delete();
    imgTh.delete();
    imgBGR.delete();
    return {
        countedData: countedData,
        threshData:  threshData,
        width:  w,
        height: h,
        count:  cellCountNum,
        contourData: contourData,
    };
}

function previewThreshold(imageData, params) {
    var claheClip         = params.claheClip || 0;
    var morphIter         = params.morphIter || 0;
    var manualThresh      = params.manualThresh || 0;
    var excludeStripes    = params.excludeStripes || false;
    var adaptiveBlockSize = params.adaptiveBlockSize || 51;
    var adaptiveC         = (params.adaptiveC !== undefined) ? params.adaptiveC : 2;
    var src    = cv.matFromImageData(imageData);
    var imgBGR = new cv.Mat();
    cv.cvtColor(src, imgBGR, cv.COLOR_RGBA2BGR);
    src.delete();
    var imgGreyTh = buildGreyTh(imgBGR, params.microscopyMode || 'fluorescence', params.blurRadius, claheClip, params.edgeWeight);
    imgBGR.delete();
    var imgTh = applyThreshold(imgGreyTh, params.thresholdName, manualThresh, adaptiveBlockSize, adaptiveC);
    imgGreyTh.delete();
    imgTh = applyMorphology(imgTh, morphIter);
    if (excludeStripes) {
        imgTh = removeGridLines(imgTh);
    }
    var threshData = matToRGBA(imgTh);
    var w = imgTh.cols, h = imgTh.rows;
    imgTh.delete();
    return { threshData: threshData, width: w, height: h };
}

function multiThreshold(imageData, params) {
    var claheClip         = params.claheClip || 0;
    var adaptiveBlockSize = params.adaptiveBlockSize || 51;
    var adaptiveC         = (params.adaptiveC !== undefined) ? params.adaptiveC : 2;
    var src    = cv.matFromImageData(imageData);
    var imgBGR = new cv.Mat();
    cv.cvtColor(src, imgBGR, cv.COLOR_RGBA2BGR);
    src.delete();
    var imgGreyTh = buildGreyTh(imgBGR, params.microscopyMode || 'fluorescence', params.blurRadius, claheClip, params.edgeWeight);
    imgBGR.delete();
    var results = [];
    for (var i = 0; i < ALL_THRESHOLDS.length; i++) {
        var name  = ALL_THRESHOLDS[i];
        var imgTh = applyThreshold(imgGreyTh, name, 0, adaptiveBlockSize, adaptiveC);
        results.push({
            name:       name,
            threshData: matToRGBA(imgTh),
            width:  imgTh.cols,
            height: imgTh.rows
        });
        imgTh.delete();
    }
    imgGreyTh.delete();
    return results;
}

self.onmessage = function (e) {
    var msg = e.data;
    try {
        if (msg.type === 'count') {
            var r = countCells(msg.data.imageData, msg.data.params);
            self.postMessage({ type: 'result', result: r },
                [r.countedData.buffer, r.threshData.buffer]);
        } else if (msg.type === 'preview') {
            var p = previewThreshold(msg.data.imageData, msg.data.params);
            self.postMessage({ type: 'preview', threshData: p.threshData, width: p.width, height: p.height },
                [p.threshData.buffer]);
        } else if (msg.type === 'multi') {
            var results = multiThreshold(msg.data.imageData, msg.data.params);
            var transfers = results.map(function (r) { return r.threshData.buffer; });
            self.postMessage({ type: 'multi', results: results }, transfers);
        }
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message || String(err) });
    }
};
