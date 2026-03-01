from flask import Blueprint, render_template, request, flash
import math, os, cv2, base64, io
import numpy as np
from PIL import Image as im
from . import ALLOWED_EXTENSIONS

try:
    from skimage.morphology import h_maxima
    from skimage.feature import peak_local_max
    from skimage.segmentation import watershed as skimage_watershed
    SKIMAGE_AVAILABLE = True
except ImportError:
    SKIMAGE_AVAILABLE = False

cell_count_filament = Blueprint('cell_count_filament', __name__)

@cell_count_filament.route('/cell_count_filament', methods=['GET', 'POST'])
def count_filament_cells():
    if request.method == "POST":
        if request.form.get('pixel_size') == '':
            flash('Please enter pixel size', category='error')
        else:
            pixel_size_nm = float(str(request.form.get('pixel_size')))
            depth_um = int(request.form["chamber_depth_range"])
            minimal_expected_size = float(request.form["minimal_diameter_range"])
            minimum_area = math.pi * ((minimal_expected_size * 1000 / pixel_size_nm) / 2) ** 2
            min_diameter_px = minimal_expected_size / (pixel_size_nm / 1000)

            # Filament-specific segmentation parameters
            number_of_iterations = int(request.form.get("iterations_range") or 4)
            factor_multiplying = float(request.form.get("factor_1_multiplication_range") or 1.4)
            factor_distance_centers = int(request.form.get("factor_2_distance_range") or 28)
            bilateral_filter = request.form.get('bilateral_filter', '') == '1'
            use_hmax = request.form.get('use_hmax', '1') == '1'
            use_peak_local_max = request.form.get('use_peak_local_max', '') == '1'

            # Microscopy mode
            microscopy_mode = request.form.get('microscopy_mode', 'fluorescence')

            # Optional ROI
            roi_x_pct = float(request.form.get('roi_x_pct') or 0)
            roi_y_pct = float(request.form.get('roi_y_pct') or 0)
            roi_w_pct = float(request.form.get('roi_w_pct') or 0)
            roi_h_pct = float(request.form.get('roi_h_pct') or 0)
            use_roi = roi_w_pct > 0 and roi_h_pct > 0

            # Preprocessing parameters
            blur_radius = max(1, int(request.form.get('blur_radius') or 3))
            max_diam_um = float(request.form.get('max_diam_range') or 0)
            clahe_clip = float(request.form.get('clahe_clip') or 0)
            morph_iter = int(request.form.get('morph_iter') or 0)
            circularity_min = float(request.form.get('circularity_min') or 0)
            manual_thresh = int(request.form.get('manual_thresh') or 0)
            exclude_stripes = request.form.get('exclude_stripes') == '1'
            adaptive_block_size = int(request.form.get('adaptive_block_size') or 51)
            if adaptive_block_size < 3: adaptive_block_size = 3
            if adaptive_block_size % 2 == 0: adaptive_block_size += 1
            adaptive_c = int(request.form.get('adaptive_c') or 2)
            threshold = request.form.get('threshold_filter', 'Binary + Otsu')

            if 'selected_images' in request.files:
                image = request.files['selected_images']
                image_name = str.lower(os.path.splitext(str(image.filename))[0])
                image_extension = str.lower(os.path.splitext(str(image.filename))[1])
                if image_extension in ALLOWED_EXTENSIONS:
                    # Decode image directly from memory — no disk I/O
                    nparr = np.frombuffer(image.read(), np.uint8)
                    img_orig = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                    img_grey_raw = cv2.cvtColor(img_orig, cv2.COLOR_BGR2GRAY)
                    if bilateral_filter:
                        d = max(3, blur_radius * 2 + 1)
                        img_grey = cv2.bilateralFilter(img_grey_raw, d, 75, 75)
                    else:
                        img_blur = cv2.blur(img_orig, (blur_radius, blur_radius))
                        img_grey = cv2.cvtColor(img_blur, cv2.COLOR_BGR2GRAY)

                    # Brightfield inversion: dark cells → bright so thresholding logic is uniform
                    if microscopy_mode == 'brightfield':
                        img_grey_th = cv2.bitwise_not(img_grey)
                    else:
                        img_grey_th = img_grey.copy()

                    # CLAHE contrast enhancement (applied before thresholding)
                    if clahe_clip > 0:
                        clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
                        img_grey_th = clahe.apply(img_grey_th)

                    # Apply threshold
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
                        img_th = cv2.threshold(img_grey_th, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

                    # Post-threshold morphology
                    if morph_iter != 0:
                        kernel_morph = np.ones((3, 3), np.uint8)
                        if morph_iter > 0:
                            img_th = cv2.dilate(img_th, kernel_morph, iterations=morph_iter)
                        else:
                            img_th = cv2.erode(img_th, kernel_morph, iterations=-morph_iter)

                    # Counting chamber grid-line exclusion
                    if exclude_stripes:
                        h_s, w_s = img_th.shape[:2]
                        h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w_s // 8), 1))
                        v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h_s // 8)))
                        h_lines = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, h_kernel)
                        v_lines = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, v_kernel)
                        lines_mask = cv2.add(h_lines, v_lines)
                        img_th = cv2.bitwise_and(img_th, cv2.bitwise_not(lines_mask))

                    # ─────────────────────────────────────────────────────────
                    # Watershed segmentation (filament-specific algorithm)
                    # ─────────────────────────────────────────────────────────
                    kernel_ellipse = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                    img_noise_reduced = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, kernel_ellipse, iterations=3)
                    img_background = cv2.dilate(img_noise_reduced, kernel_ellipse, iterations=2)

                    # Visualization base
                    if microscopy_mode == 'brightfield':
                        img_for_counted_cells = img_orig.copy()
                    else:
                        img_for_counted_cells = cv2.threshold(img_grey, 0, 255, cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                        img_for_counted_cells = cv2.cvtColor(img_for_counted_cells, cv2.COLOR_GRAY2BGR)
                    img_for_counted_cells_copy = img_for_counted_cells.copy()

                    if use_peak_local_max and SKIMAGE_AVAILABLE:
                        # ── Single-pass: peak_local_max seeding ─────────────
                        dist_transform = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, 5)
                        min_dist_px = max(2, int(factor_distance_centers / max(0.001, pixel_size_nm / 1000)))
                        thresh_rel  = max(0.05, factor_multiplying * 0.3)
                        coords = peak_local_max(
                            dist_transform,
                            min_distance=min_dist_px,
                            threshold_rel=thresh_rel,
                            labels=img_noise_reduced.astype(bool)
                        )
                        markers = np.zeros(dist_transform.shape, dtype=np.int32)
                        for _idx, (_py, _px) in enumerate(coords, start=1):
                            markers[_py, _px] = _idx
                        markers = cv2.dilate(
                            markers.astype(np.float32), np.ones((3, 3), np.uint8), iterations=2
                        ).astype(np.int32)
                        labels = skimage_watershed(-dist_transform, markers, mask=img_noise_reduced > 0)
                        final_contours = []
                        for label_id in range(1, int(labels.max()) + 1):
                            mask_label = (labels == label_id).astype(np.uint8) * 255
                            cnts, _ = cv2.findContours(mask_label, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                            if cnts:
                                final_contours.append(max(cnts, key=cv2.contourArea))
                        contours_watershed_temp = (final_contours, None)

                    else:
                        # ── Iterative watershed (original algorithm) ─────────
                        scaling_factor_distance_transform = 5
                        scaling_factor_threshold = 0.00
                        contours_watershed_temp = list()

                        def _get_fg(dist_img, sft):
                            """Return uint8 foreground mask via h-maxima or simple threshold."""
                            if use_hmax and SKIMAGE_AVAILABLE:
                                h_val = max(0.5, sft * dist_img.max())
                                local_max = h_maxima(dist_img, h=h_val)
                                return (local_max > 0).astype(np.uint8) * 255
                            else:
                                fg = cv2.threshold(dist_img, sft * dist_img.max(), 255, 0)[1]
                                return np.uint8(fg)

                        # Iteration 1: reference contours
                        img_dist_t = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, scaling_factor_distance_transform)
                        img_fg = _get_fg(img_dist_t, scaling_factor_threshold)
                        img_sub = cv2.subtract(img_background, img_fg)
                        _, central_parts = cv2.connectedComponents(img_fg)
                        central_parts = central_parts + 1
                        central_parts[img_sub == 255] = 0
                        img_ws = cv2.watershed(img_for_counted_cells_copy, central_parts)
                        img_ws = cv2.normalize(img_ws, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U)
                        _, thresh_ws = cv2.threshold(img_ws, 150, 255, cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY_INV)
                        contours_watershed_th_reference = cv2.findContours(thresh_ws, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
                        contours_watershed_last = contours_watershed_th_reference

                        # Iterations 2–n: step-wise tightening of foreground threshold
                        for _iter in range(number_of_iterations):
                            circles_all_old = []
                            circles_all_actual = []
                            circles_to_remain_old_temp = []
                            circles_to_remain_actual_temp = []
                            circles_to_be_deleted_old = []
                            circles_to_be_deleted_actual = []
                            scaling_factor_threshold = scaling_factor_threshold + 0.1
                            img_dist_t = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, scaling_factor_distance_transform)
                            img_fg = _get_fg(img_dist_t, scaling_factor_threshold)
                            img_sub = cv2.subtract(img_background, img_fg)
                            _, central_parts = cv2.connectedComponents(img_fg)
                            central_parts = central_parts + 1
                            central_parts[img_sub == 255] = 0
                            img_ws = cv2.watershed(img_for_counted_cells_copy, central_parts)
                            img_ws = cv2.normalize(img_ws, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U)
                            _, thresh_ws = cv2.threshold(img_ws, 150, 255, cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY_INV)
                            contours_watershed_th = cv2.findContours(thresh_ws, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE)
                            contours_ws_sorted = sorted(contours_watershed_th[0], key=cv2.contourArea)
                            contours_ws_sorted = contours_ws_sorted[:-1]
                            cth_temp = list(contours_watershed_th)
                            cth_temp[0] = contours_ws_sorted
                            contours_watershed_th = tuple(cth_temp)

                            for j in range(len(contours_watershed_th[0])):
                                contour = contours_watershed_th[0][j]
                                ((x, y), r) = cv2.minEnclosingCircle(contour)
                                if r > min_diameter_px:
                                    xc_act = int(x)
                                    yc_act = int(y)
                                    rc_act = int(r)
                                    circles_all_actual.append(int(j))
                                    for a in range(len(contours_watershed_last[0])):
                                        contour_last = contours_watershed_last[0][a]
                                        ((c, d), e) = cv2.minEnclosingCircle(contour_last)
                                        xc_old = int(c)
                                        yc_old = int(d)
                                        rc_old = int(e)
                                        circles_all_old.append(int(a))
                                        dist_centers = math.sqrt((xc_act - xc_old) ** 2 + (yc_act - yc_old) ** 2)
                                        if factor_multiplying * rc_old > (dist_centers + rc_act):
                                            circles_to_be_deleted_old.append(int(a))
                                            circles_to_remain_actual_temp.append(int(j))
                                        elif factor_multiplying * rc_act >= (dist_centers + rc_old) and dist_centers < rc_old:
                                            circles_to_be_deleted_actual.append(int(j))
                                            circles_to_remain_old_temp.append(int(a))
                                        elif dist_centers < factor_distance_centers:
                                            circles_to_be_deleted_old.append(int(j))

                            circles_to_be_deleted_old = [*set(circles_to_be_deleted_old)]
                            circles_to_be_deleted_actual = [*set(circles_to_be_deleted_actual)]
                            circles_to_remain_old_temp = [*set(circles_to_remain_old_temp)]
                            circles_to_remain_actual_temp = [*set(circles_to_remain_actual_temp)]
                            circles_all_old = [*set(circles_all_old)]
                            circles_all_actual = [*set(circles_all_actual)]

                            circles_to_remain_old = [x for x in circles_all_old if x not in circles_to_be_deleted_old]
                            circles_to_remain_old = list(dict.fromkeys(circles_to_remain_old + circles_to_remain_old_temp))
                            circles_to_remain_actual = [x for x in circles_to_remain_actual_temp if x not in circles_to_be_deleted_actual]

                            contours_watershed_temp = list(contours_watershed_th)
                            contours_watershed_temp[0] = []
                            contours_watershed_temp = tuple(contours_watershed_temp)
                            for k in range(len(circles_to_remain_old)):
                                contours_watershed_temp[0].append(contours_watershed_last[0][circles_to_remain_old[k]])
                            for k in range(len(circles_to_remain_actual)):
                                contours_watershed_temp[0].append(contours_watershed_th[0][circles_to_remain_actual[k]])
                            contours_watershed_last = contours_watershed_temp

                    # ─────────────────────────────────────────────────────────
                    # ROI and filter setup
                    # ─────────────────────────────────────────────────────────
                    h_img, w_img = img_for_counted_cells_copy.shape[:2]
                    if use_roi:
                        roi_x1 = int(roi_x_pct * w_img)
                        roi_y1 = int(roi_y_pct * h_img)
                        roi_x2 = int((roi_x_pct + roi_w_pct) * w_img)
                        roi_y2 = int((roi_y_pct + roi_h_pct) * h_img)

                    if max_diam_um > 0:
                        maximum_area = math.pi * ((max_diam_um * 1000 / pixel_size_nm) / 2) ** 2
                    else:
                        maximum_area = 0

                    circle_color = (0, 255, 0) if microscopy_mode != 'brightfield' else (0, 0, 0)

                    # ─────────────────────────────────────────────────────────
                    # Draw circles and collect contour data
                    # ─────────────────────────────────────────────────────────
                    cell_count_num = 0
                    contour_data = []
                    cell_diameters = []

                    for idx in range(len(contours_watershed_temp[0])):
                        contour = contours_watershed_temp[0][idx]
                        ((x, y), r) = cv2.minEnclosingCircle(contour)
                        xc = int(x)
                        yc = int(y)
                        rc = int(r)

                        # Min diameter / area filter
                        area = math.pi * rc ** 2
                        if area <= minimum_area:
                            continue

                        # Max diameter filter
                        if maximum_area > 0 and area > maximum_area:
                            continue

                        # Circularity filter
                        if circularity_min > 0:
                            cnt_area = cv2.contourArea(contour)
                            perimeter = cv2.arcLength(contour, True)
                            circularity = (4 * math.pi * cnt_area / perimeter ** 2) if perimeter > 0 else 0
                            if circularity < circularity_min:
                                continue

                        # ROI filter
                        if use_roi and not (roi_x1 <= xc <= roi_x2 and roi_y1 <= yc <= roi_y2):
                            continue

                        cell_count_num += 1
                        cv2.putText(img_for_counted_cells_copy, str(cell_count_num), (xc, yc),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, circle_color, 1)
                        cv2.circle(img_for_counted_cells_copy, (xc, yc), rc, (255, 255, 0), 1)
                        contour_data.append([xc, yc, rc])
                        diam_um = round(2 * rc * pixel_size_nm / 1000, 2)
                        cell_diameters.append(diam_um)

                    # Draw ROI rectangle on the counted image
                    if use_roi:
                        cv2.rectangle(img_for_counted_cells_copy, (roi_x1, roi_y1), (roi_x2, roi_y2),
                                      (0, 165, 255), 2)

                    # ─────────────────────────────────────────────────────────
                    # Calculate cell concentration
                    # ─────────────────────────────────────────────────────────
                    y_pixels, x_pixels = img_for_counted_cells_copy.shape[:2]
                    x_nm = x_pixels * pixel_size_nm
                    y_nm = y_pixels * pixel_size_nm
                    img_area_mm2 = round((x_nm / 1e6) * (y_nm / 1e6), 3)
                    img_volume_nl = round(x_nm * y_nm * (depth_um * 1000) / 1e15, 3)
                    img_volume_ml = img_volume_nl / 1e6

                    if img_volume_nl > 1:
                        cells_per_ml = cell_count_num / img_volume_ml
                        million_cells_per_mL = round(cells_per_ml / 1e6, 3)

                        # Encode images as base64 — all in memory
                        img_orig_pil = im.fromarray(cv2.cvtColor(img_orig, cv2.COLOR_BGR2RGB))
                        img_th_pil = im.fromarray(img_th)
                        img_counted_pil = im.fromarray(cv2.cvtColor(img_for_counted_cells_copy, cv2.COLOR_BGR2RGB))

                        mem_orig = io.BytesIO()
                        mem_th = io.BytesIO()
                        mem_counted = io.BytesIO()
                        img_orig_pil.save(mem_orig, "JPEG")
                        img_th_pil.save(mem_th, "JPEG")
                        img_counted_pil.save(mem_counted, "JPEG")
                        img_orig_decoded_from_memory = base64.b64encode(mem_orig.getvalue()).decode('utf-8')
                        img_th_decoded_from_memory = base64.b64encode(mem_th.getvalue()).decode('utf-8')
                        img_counted_decoded_from_memory = base64.b64encode(mem_counted.getvalue()).decode('utf-8')

                        return render_template("cell_count_filament.html",
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
                            adaptive_block_size=adaptive_block_size,
                            adaptive_c=adaptive_c,
                            number_of_iterations=number_of_iterations,
                            factor_multiplying=factor_multiplying,
                            factor_distance_centers=factor_distance_centers,
                            bilateral_filter=bilateral_filter,
                            use_hmax=use_hmax,
                            use_peak_local_max=use_peak_local_max,
                        )
                    else:
                        flash('Pixel size is too low', category='error')
                    return render_template("cell_count_filament.html")
                else:
                    flash('Please select an image file.', category='error')
    return render_template("cell_count_filament.html")
