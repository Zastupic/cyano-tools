from flask import Blueprint, render_template, request, flash
import math, os, cv2, base64, io, uuid, glob, time
import numpy as np
from PIL import Image as im
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER

cell_count = Blueprint('cell_count', __name__)

@cell_count.route('/cell_count', methods=['GET', 'POST'])
def count_cells():
    if request.method == "POST":
        cached_image_key       = request.form.get('cached_image_key', '').strip()
        cached_image_name_form = request.form.get('cached_image_name', '').strip()
        if request.form.get('pixel_size') == '':
            flash('Please enter pixel size', category='error')
        elif not (request.form.get('chamber_depth_range') or '').strip():
            flash('Please enter chamber depth', category='error')
        else:
            pixel_size_nm = float(str(request.form.get('pixel_size')))
            depth_um = int(float((request.form.get('chamber_depth_range') or '').strip() or 120))
            minimal_expected_size = float(request.form["minimal_diameter_range"])
            minimum_area = math.pi * ((minimal_expected_size * 1000 / pixel_size_nm) / 2) ** 2
            # Fluorescence: cells bright on dark background (standard thresholding)
            # Brightfield:  cells dark on light background (grayscale inverted before thresholding)
            microscopy_mode = request.form.get('microscopy_mode', 'fluorescence')

            # Optional ROI (0–1 fractions of image width/height, sent by the live-preview ROI tool)
            roi_x_pct = float(request.form.get('roi_x_pct') or 0)
            roi_y_pct = float(request.form.get('roi_y_pct') or 0)
            roi_w_pct = float(request.form.get('roi_w_pct') or 0)
            roi_h_pct = float(request.form.get('roi_h_pct') or 0)
            use_roi = roi_w_pct > 0 and roi_h_pct > 0

            # Pre-blur radius (cv2.blur is a box filter — any positive integer is valid)
            blur_radius = max(1, int(request.form.get('blur_radius') or 3))

            # New analysis parameters
            max_diam_um     = float(request.form.get('max_diam_range') or 0)
            clahe_clip      = float(request.form.get('clahe_clip') or 0)
            morph_iter      = int(request.form.get('morph_iter') or 0)
            circularity_min = float(request.form.get('circularity_min') or 0)
            manual_thresh   = int(request.form.get('manual_thresh') or 0)
            exclude_stripes = request.form.get('exclude_stripes') == '1'
            noise_removal   = request.form.get('noise_removal') == '1'
            adaptive_block_size = int(request.form.get('adaptive_block_size') or 51)
            if adaptive_block_size < 3: adaptive_block_size = 3
            if adaptive_block_size % 2 == 0: adaptive_block_size += 1
            adaptive_c      = int(request.form.get('adaptive_c') or 2)

            # Determine image source: new upload or server-side cache
            _new_image = request.files.get('selected_images')
            _new_image = _new_image if (_new_image and _new_image.filename) else None
            if _new_image is not None:
                image_name      = str.lower(os.path.splitext(str(_new_image.filename))[0])
                image_extension = str.lower(os.path.splitext(str(_new_image.filename))[1])
            elif cached_image_key:
                image_name      = cached_image_name_form or 'image'
                image_extension = os.path.splitext(cached_image_key)[1]
            else:
                image_name = image_extension = ''

            if _new_image is not None or cached_image_key:
                if image_extension in ALLOWED_EXTENSIONS:
                    if _new_image is not None:
                        img_bytes = _new_image.read()
                        nparr = np.frombuffer(img_bytes, np.uint8)
                        img_orig = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                        # Cache to disk so the user can re-run without re-uploading
                        cached_image_key = 'round_cache_' + uuid.uuid4().hex + image_extension
                        try:
                            for _old in glob.glob(os.path.join(UPLOAD_FOLDER, 'round_cache_*')):
                                if time.time() - os.path.getmtime(_old) > 7200:
                                    os.remove(_old)
                            with open(os.path.join(UPLOAD_FOLDER, cached_image_key), 'wb') as _cf:
                                _cf.write(img_bytes)
                        except Exception:
                            cached_image_key = ''
                    else:
                        _cache_path = os.path.join(UPLOAD_FOLDER, cached_image_key)
                        if not os.path.exists(_cache_path):
                            flash('Cached image not found. Please upload again.', category='error')
                            return render_template("cell_count.html")
                        nparr = np.frombuffer(open(_cache_path, 'rb').read(), np.uint8)
                        img_orig = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                    img_blur = cv2.blur(img_orig, (blur_radius, blur_radius))
                    img_grey = cv2.cvtColor(img_blur, cv2.COLOR_BGR2GRAY)

                    # Brightfield inversion: makes dark cells become bright so the same
                    # thresholding logic (keep bright = keep cells) works for both modes
                    if microscopy_mode == 'brightfield':
                        img_grey_th = cv2.bitwise_not(img_grey)
                    else:
                        img_grey_th = img_grey.copy()

                    # CLAHE contrast enhancement (applied before thresholding)
                    if clahe_clip > 0:
                        clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
                        img_grey_th = clahe.apply(img_grey_th)

                    # Apply threshold
                    threshold = request.form.get('threshold_filter', 'Triangle + Binary')
                    if manual_thresh > 0:
                        img_th = cv2.threshold(img_grey_th, manual_thresh, 255, cv2.THRESH_BINARY)[1]
                    elif threshold == 'Triangle + Binary':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY)[1]
                    elif threshold == 'To zero + Triangle':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                    elif threshold == 'Binary + Otsu':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
                    elif threshold == 'Binary':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_BINARY)[1]
                    elif threshold == 'To zero':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_TOZERO)[1]
                    elif threshold == 'Triangle':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_TRIANGLE)[1]
                    elif threshold == 'Otsu':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_OTSU)[1]
                    elif threshold == 'Binary Inv + Otsu':
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]
                    elif threshold == 'Adaptive Mean':
                        img_th = cv2.adaptiveThreshold(img_grey_th, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                                       cv2.THRESH_BINARY, adaptive_block_size, adaptive_c)
                    elif threshold == 'Adaptive Gaussian':
                        img_th = cv2.adaptiveThreshold(img_grey_th, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                                       cv2.THRESH_BINARY, adaptive_block_size, adaptive_c)
                    else:
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY)[1]

                    # Post-threshold morphology (erosion or dilation)
                    if morph_iter != 0:
                        kernel = np.ones((3, 3), np.uint8)
                        if morph_iter > 0:
                            img_th = cv2.dilate(img_th, kernel, iterations=morph_iter)
                        else:
                            img_th = cv2.erode(img_th, kernel, iterations=-morph_iter)

                    # Counting chamber grid-line exclusion
                    if exclude_stripes:
                        h_s, w_s = img_th.shape[:2]
                        h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w_s // 8), 1))
                        v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h_s // 8)))
                        h_lines = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, h_kernel)
                        v_lines = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, v_kernel)
                        lines_mask = cv2.add(h_lines, v_lines)
                        img_th = cv2.bitwise_and(img_th, cv2.bitwise_not(lines_mask))

                    # Visualization base:
                    #   Fluorescence — threshold-enhanced grey (cells bright, background black)
                    #   Brightfield  — original color image (natural appearance, overlaid markers visible)
                    if microscopy_mode == 'brightfield':
                        img_for_counted_cells = img_orig.copy()
                    else:
                        img_for_counted_cells = cv2.threshold(img_grey, 0, 255, cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                        img_for_counted_cells = cv2.cvtColor(img_for_counted_cells, cv2.COLOR_GRAY2BGR)

                    ############################
                    ### Mark counted objects ###
                    ############################
                    h_img, w_img = img_th.shape[:2]
                    # Convert ROI percentages → pixel bounds
                    if use_roi:
                        roi_x1 = int(roi_x_pct * w_img)
                        roi_y1 = int(roi_y_pct * h_img)
                        roi_x2 = int((roi_x_pct + roi_w_pct) * w_img)
                        roi_y2 = int((roi_y_pct + roi_h_pct) * h_img)

                    # Precompute max area filter
                    if max_diam_um > 0:
                        maximum_area = math.pi * ((max_diam_um * 1000 / pixel_size_nm) / 2) ** 2
                    else:
                        maximum_area = 0

                    # Fluorescence: green circles on dark bg; Brightfield: black circles on light bg
                    circle_color = (0, 255, 0) if microscopy_mode != 'brightfield' else (0, 0, 0)

                    # ── Contour detection (with optional watershed for touching-cell separation) ─
                    if noise_removal:
                        kernel_nr = np.ones((3, 3), np.uint8)
                        opening   = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, kernel_nr, iterations=2)
                        sure_bg   = cv2.dilate(opening, kernel_nr, iterations=3)
                        dist_t    = cv2.distanceTransform(opening, cv2.DIST_L2, 5)
                        dist_max  = float(dist_t.max())
                        if dist_max > 0:
                            _, sure_fg = cv2.threshold(dist_t, 0.5 * dist_max, 255, 0)
                            sure_fg    = np.uint8(sure_fg)
                            unknown    = cv2.subtract(sure_bg, sure_fg)
                            _, markers = cv2.connectedComponents(sure_fg)
                            markers    = markers + 1
                            markers[unknown == 255] = 0
                            ws_src     = img_for_counted_cells.copy()
                            cv2.watershed(ws_src, markers)
                            final_contours = []
                            for lbl in range(2, int(markers.max()) + 1):
                                mask = np.uint8(markers == lbl) * 255
                                cnts = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
                                if cnts:
                                    final_contours.append(max(cnts, key=cv2.contourArea))
                        else:
                            final_contours = list(cv2.findContours(opening, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0] or [])
                    else:
                        final_contours = list(cv2.findContours(img_th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0] or [])

                    # ── Two-pass clump detection ─────────────────────────────────────────────
                    # First pass: collect all contours passing min-size, circularity, ROI filters
                    _accepted = []
                    for cnt in final_contours:
                        area = cv2.contourArea(cnt)
                        if area <= minimum_area:
                            continue
                        if circularity_min > 0:
                            perimeter = cv2.arcLength(cnt, True)
                            circ = (4 * math.pi * area / perimeter ** 2) if perimeter > 0 else 0
                            if circ < circularity_min:
                                continue
                        x, y, w, h = cv2.boundingRect(cnt)
                        xc = int(x + w / 2)
                        yc = int(y + h / 2)
                        if use_roi and not (roi_x1 <= xc <= roi_x2 and roi_y1 <= yc <= roi_y2):
                            continue
                        _accepted.append((cnt, area, xc, yc, max(1, int(w / 2))))

                    # Compute clump threshold: 4× median area of accepted objects
                    clump_count          = 0
                    clump_total_area_um2 = 0.0
                    if _accepted:
                        sorted_areas = sorted(a for _, a, *_ in _accepted)
                        median_area  = sorted_areas[len(sorted_areas) // 2]
                        clump_thresh = 4.0 * median_area
                    else:
                        clump_thresh = 0.0

                    # Second pass: draw circles; flag clumps in orange
                    cell_count_num = 0
                    contour_data   = []
                    cell_diameters = []
                    for cnt, area, xc, yc, radius in _accepted:
                        is_clump = (clump_thresh > 0 and area > clump_thresh) or \
                                   (maximum_area > 0 and area > maximum_area)
                        if is_clump:
                            clump_count          += 1
                            clump_total_area_um2 += area * (pixel_size_nm / 1000) ** 2
                            cv2.circle(img_for_counted_cells, (xc, yc), radius, (0, 165, 255), 1)
                            continue
                        cell_count_num += 1
                        cv2.circle(img_for_counted_cells, (xc, yc), radius, circle_color, 1)
                        contour_data.append([xc, yc, radius])
                        diam_um = round(2 * (area / math.pi) ** 0.5 * pixel_size_nm / 1000, 2)
                        cell_diameters.append(diam_um)
                    clump_total_area_um2 = round(clump_total_area_um2, 1)

                    # Draw ROI rectangle on the counted image
                    if use_roi:
                        roi_color = (0, 165, 255)  # orange in BGR
                        cv2.rectangle(img_for_counted_cells, (roi_x1, roi_y1), (roi_x2, roi_y2), roi_color, 2)

                    # cv2 returns BGR; PIL fromarray expects RGB — convert before encoding
                    img_original_pil = im.fromarray(cv2.cvtColor(img_orig, cv2.COLOR_BGR2RGB))
                    img_th_pil = im.fromarray(img_th)  # grayscale, no conversion needed
                    img_counted_pil = im.fromarray(cv2.cvtColor(img_for_counted_cells, cv2.COLOR_BGR2RGB))

                    ##############################################
                    ### Calculate cell number per ml sample   ###
                    ##############################################
                    y_pixels, x_pixels, _ = img_for_counted_cells.shape
                    x_nm = x_pixels * pixel_size_nm
                    y_nm = y_pixels * pixel_size_nm
                    img_area_mm2 = round((x_nm / 1e6) * (y_nm / 1e6), 3)
                    img_volume_nl = round(x_nm * y_nm * (depth_um * 1000) / 1e15, 3)
                    img_volume_ml = img_volume_nl / 1e6

                    if img_volume_nl > 1:
                        cells_per_ml = cell_count_num / img_volume_ml
                        million_cells_per_mL = round(cells_per_ml / 1e6, 3)

                        # Encode images to base64 — all processing stays in memory
                        mem_orig = io.BytesIO()
                        mem_th = io.BytesIO()
                        mem_counted = io.BytesIO()
                        img_original_pil.save(mem_orig, "JPEG")
                        img_th_pil.save(mem_th, "JPEG")
                        img_counted_pil.save(mem_counted, "JPEG")
                        img_orig_decoded_from_memory = base64.b64encode(mem_orig.getvalue()).decode('utf-8')
                        img_th_decoded_from_memory = base64.b64encode(mem_th.getvalue()).decode('utf-8')
                        img_counted_decoded_from_memory = base64.b64encode(mem_counted.getvalue()).decode('utf-8')

                        return render_template("cell_count.html",
                            image_name=image_name,
                            img_orig_decoded_from_memory=img_orig_decoded_from_memory,
                            img_th_decoded_from_memory=img_th_decoded_from_memory,
                            img_counted_decoded_from_memory=img_counted_decoded_from_memory,
                            img_for_download=f'{image_name}_counted{image_extension}',
                            cell_count=cell_count_num,
                            cells_per_ml=cells_per_ml,
                            million_cells_per_mL=million_cells_per_mL,
                            x_pixels=x_pixels,
                            y_pixels=y_pixels,
                            img_area_mm2=img_area_mm2,
                            img_volume_nl=img_volume_nl,
                            img_volume_ml=img_volume_ml,
                            x_um=int(x_nm / 1000),
                            y_um=int(y_nm / 1000),
                            pixel_size_nm=pixel_size_nm,
                            depth_um=depth_um,
                            minimal_expected_size=minimal_expected_size,
                            blur_radius=blur_radius,
                            threshold=threshold,
                            microscopy_mode=microscopy_mode,
                            contour_data=contour_data,
                            cell_diameters=cell_diameters,
                            max_diam_um=max_diam_um,
                            clahe_clip=clahe_clip,
                            morph_iter=morph_iter,
                            circularity_min=circularity_min,
                            manual_thresh=manual_thresh,
                            exclude_stripes=exclude_stripes,
                            noise_removal=noise_removal,
                            adaptive_block_size=adaptive_block_size,
                            adaptive_c=adaptive_c,
                            cached_image_key=cached_image_key,
                            cached_image_name=image_name,
                            clump_count=clump_count,
                            clump_total_area_um2=clump_total_area_um2,
                        )
                    else:
                        flash('Pixel size is too low', category='error')
                    return render_template("cell_count.html",
                                          cached_image_key=cached_image_key,
                                          cached_image_name=image_name)
                else:
                    flash('Please select an image file.', category='error')
    return render_template("cell_count.html")
