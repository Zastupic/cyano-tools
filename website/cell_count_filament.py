from flask import Blueprint, render_template, request, flash
import math, os, cv2, base64, io, uuid, glob, time
import numpy as np
from PIL import Image as im
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER

try:
    from skimage.morphology import h_maxima, skeletonize
    from skimage.feature import peak_local_max
    from skimage.segmentation import watershed as skimage_watershed
    SKIMAGE_AVAILABLE = True
except ImportError:
    SKIMAGE_AVAILABLE = False

cell_count_filament = Blueprint('cell_count_filament', __name__)

@cell_count_filament.route('/cell_count_filament', methods=['GET', 'POST'])
def count_filament_cells():
    if request.method == "POST":
        cached_image_key      = request.form.get('cached_image_key', '').strip()
        cached_image_name_form = request.form.get('cached_image_name', '').strip()
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
            # Segmentation method: 'iterative' | 'peak_local_max' | 'skeleton'
            seg_method = request.form.get('seg_method', 'peak_local_max')
            use_peak_local_max = (seg_method == 'peak_local_max')
            use_skeleton       = (seg_method == 'skeleton')
            separate_filaments = request.form.get('separate_filaments', '') == '1'
            max_aspect_ratio   = float(request.form.get('max_aspect_ratio') or 0)

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
                        cached_image_key = 'filament_cache_' + uuid.uuid4().hex + image_extension
                        try:
                            # Clean up old cache files (older than 2 h)
                            for _old in glob.glob(os.path.join(UPLOAD_FOLDER, 'filament_cache_*')):
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
                            return render_template("cell_count_filament.html")
                        nparr = np.frombuffer(open(_cache_path, 'rb').read(), np.uint8)
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

                    # Optional: separate touching filaments with a narrow erosion before background computation
                    if separate_filaments:
                        sep_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                        img_noise_reduced = cv2.erode(img_noise_reduced, sep_kernel, iterations=1)
                    img_background = cv2.dilate(img_noise_reduced, kernel_ellipse,
                                                iterations=3 if separate_filaments else 2)

                    # Visualization base
                    if microscopy_mode == 'brightfield':
                        img_for_counted_cells = img_orig.copy()
                    else:
                        img_for_counted_cells = cv2.threshold(img_grey, 0, 255, cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                        img_for_counted_cells = cv2.cvtColor(img_for_counted_cells, cv2.COLOR_GRAY2BGR)
                    img_for_counted_cells_copy = img_for_counted_cells.copy()

                    # ── Pre-compute filament grouping maps (items 11-13) ─────────────────────
                    # Connected components of the noise-reduced binary: each component = one filament
                    _, component_labels = cv2.connectedComponents(img_noise_reduced)
                    # Skeleton for per-filament length measurement (item 12)
                    skeleton_full = skeletonize(img_noise_reduced > 0).astype(np.uint8) if SKIMAGE_AVAILABLE else None

                    if use_skeleton and SKIMAGE_AVAILABLE:
                        # ── Skeleton-guided seeding ──────────────────────────
                        # Seeds are placed along the filament medial axis at cell-length
                        # intervals, giving one seed per cell rather than per blob.
                        dist_transform = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, 5)
                        skeleton = skeletonize(img_noise_reduced > 0).astype(np.uint8)
                        # Restrict peak search to skeleton pixels (1D constraint)
                        dist_on_skel = dist_transform * skeleton
                        min_skel_dist = max(2, int(min_diameter_px * 0.7))
                        coords = peak_local_max(
                            dist_on_skel,
                            min_distance=min_skel_dist,
                            labels=skeleton.astype(bool)
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

                    elif use_peak_local_max and SKIMAGE_AVAILABLE:
                        # ── Single-pass: peak_local_max seeding ─────────────
                        dist_transform = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, 5)
                        min_dist_px = max(2, factor_distance_centers)
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
                                # Use relative floor (10% of max) so thin filaments are not missed
                                h_val = max(0.1 * dist_img.max(), sft * dist_img.max())
                                local_max = h_maxima(dist_img, h=h_val)
                                return (local_max > 0).astype(np.uint8) * 255
                            else:
                                fg = cv2.threshold(dist_img, sft * dist_img.max(), 255, 0)[1]
                                return np.uint8(fg)

                        def _effective_radius(cnt):
                            """Minor-axis half-length from fitEllipse (= cell width).
                            Falls back to minEnclosingCircle for short contours."""
                            if len(cnt) >= 5:
                                _, (MA, ma), _ = cv2.fitEllipse(cnt)
                                return ma / 2.0
                            (_, r) = cv2.minEnclosingCircle(cnt)
                            return r

                        # Compute distance transform once — inputs never change between iterations
                        img_dist_t = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, scaling_factor_distance_transform)

                        # Iteration 1: reference contours
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
                                ((x, y), _r) = cv2.minEnclosingCircle(contour)
                                rc_act = _effective_radius(contour)
                                if rc_act > min_diameter_px / 2:
                                    xc_act = int(x)
                                    yc_act = int(y)
                                    circles_all_actual.append(int(j))
                                    for a in range(len(contours_watershed_last[0])):
                                        contour_last = contours_watershed_last[0][a]
                                        ((c, d), _r2) = cv2.minEnclosingCircle(contour_last)
                                        xc_old = int(c)
                                        yc_old = int(d)
                                        rc_old = _effective_radius(contour_last)
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

                        # Aspect ratio filter
                        if max_aspect_ratio > 0:
                            x_br, y_br, w_br, h_br = cv2.boundingRect(contour)
                            ar = max(w_br, h_br) / max(1, min(w_br, h_br))
                            if ar > max_aspect_ratio:
                                continue

                        # ROI filter
                        if use_roi and not (roi_x1 <= xc <= roi_x2 and roi_y1 <= yc <= roi_y2):
                            continue

                        cell_count_num += 1
                        cv2.putText(img_for_counted_cells_copy, str(cell_count_num), (xc, yc),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, circle_color, 1)
                        cv2.circle(img_for_counted_cells_copy, (xc, yc), rc, (255, 255, 0), 1)

                        # Aspect ratio from fitEllipse (item 14)
                        if len(contour) >= 5:
                            try:
                                _, (MA, ma_ax), _ = cv2.fitEllipse(contour)
                                major_um     = round(max(MA, ma_ax) * pixel_size_nm / 1000, 2)
                                minor_um     = round(min(MA, ma_ax) * pixel_size_nm / 1000, 2)
                                aspect_ratio = round(max(MA, ma_ax) / max(min(MA, ma_ax), 0.01), 3)
                            except Exception:
                                major_um = round(2 * rc * pixel_size_nm / 1000, 2)
                                minor_um = major_um
                                aspect_ratio = 1.0
                        else:
                            major_um = round(2 * rc * pixel_size_nm / 1000, 2)
                            minor_um = major_um
                            aspect_ratio = 1.0

                        # Filament (connected component) ID at cell centre (item 11)
                        _cy = min(yc, component_labels.shape[0] - 1)
                        _cx = min(xc, component_labels.shape[1] - 1)
                        filament_id = int(component_labels[_cy, _cx])

                        contour_data.append([xc, yc, rc, major_um, minor_um, aspect_ratio, filament_id])
                        diam_um = round(2 * rc * pixel_size_nm / 1000, 2)
                        cell_diameters.append(diam_um)

                    # Draw ROI rectangle on the counted image
                    if use_roi:
                        cv2.rectangle(img_for_counted_cells_copy, (roi_x1, roi_y1), (roi_x2, roi_y2),
                                      (0, 165, 255), 2)

                    # ── Per-filament statistics (items 11-13) ────────────────────────────────
                    filament_cell_map = {}   # filament_id -> list of major_um diameters
                    for cd in contour_data:
                        fid = cd[6]
                        if fid not in filament_cell_map:
                            filament_cell_map[fid] = []
                        filament_cell_map[fid].append(cd[3])   # major_um

                    # Filament lengths: count skeleton pixels per filament component (item 12)
                    filament_lengths = {}
                    if skeleton_full is not None:
                        skel_pixels = zip(*np.where(skeleton_full > 0))
                        for sy, sx in skel_pixels:
                            fid = int(component_labels[sy, sx])
                            if fid > 0:
                                filament_lengths[fid] = filament_lengths.get(fid, 0.0) + pixel_size_nm / 1000.0

                    filament_stats = []
                    for fid in sorted(filament_cell_map.keys()):
                        diams = filament_cell_map[fid]
                        n     = len(diams)
                        avg_d = sum(diams) / n if n > 0 else 0.0
                        if n > 1:
                            variance = sum((d - avg_d) ** 2 for d in diams) / (n - 1)
                            cv_pct   = round((variance ** 0.5) / avg_d * 100, 1) if avg_d > 0 else 0.0
                        else:
                            cv_pct = 0.0
                        length_um = round(filament_lengths.get(fid, 0.0), 1)
                        filament_stats.append({
                            'filament_id':    fid,
                            'cell_count':     n,
                            'avg_major_um':   round(avg_d, 2),
                            'cv_pct':         cv_pct,
                            'total_length_um': length_um,
                        })

                    filament_count           = len(filament_stats)
                    total_filament_length_um = round(sum(s['total_length_um'] for s in filament_stats), 1)

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
                            seg_method=seg_method,
                            separate_filaments=separate_filaments,
                            max_aspect_ratio=max_aspect_ratio,
                            cached_image_key=cached_image_key,
                            cached_image_name=image_name,
                            filament_stats=filament_stats,
                            filament_count=filament_count,
                            total_filament_length_um=total_filament_length_um,
                        )
                    else:
                        flash('Pixel size is too low', category='error')
                    return render_template("cell_count_filament.html",
                                          cached_image_key=cached_image_key,
                                          cached_image_name=image_name)
                else:
                    flash('Please select an image file.', category='error')
    return render_template("cell_count_filament.html")
