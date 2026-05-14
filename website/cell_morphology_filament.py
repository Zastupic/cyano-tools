from flask import Blueprint, render_template, request, flash
import math, os, cv2, base64, io, uuid, glob, time
from typing import Any
import numpy as np
from PIL import Image as im
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import matplotlib.cm as mcm
import pandas as pd
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER

h_maxima: Any = None
skeletonize: Any = None
peak_local_max: Any = None
skimage_watershed: Any = None
sato: Any = None
meijering: Any = None

try:
    from skimage.morphology import h_maxima, skeletonize
    from skimage.feature import peak_local_max
    from skimage.segmentation import watershed as skimage_watershed
    SKIMAGE_AVAILABLE = True
except ImportError:
    SKIMAGE_AVAILABLE = False

try:
    from skimage.filters import sato, meijering
    RIDGE_AVAILABLE = True
except ImportError:
    RIDGE_AVAILABLE = False

cell_morphology_filament = Blueprint('cell_morphology_filament', __name__)

def _morph_histogram(values, xlabel, title):
    fig, ax = plt.subplots(figsize=(5, 3.5))
    if len(values) > 1:
        ax.hist(values, bins=min(15, len(values)), color='steelblue', edgecolor='white', alpha=0.85)
        m = sum(values) / len(values)
        s = (sum((v - m) ** 2 for v in values) / (len(values) - 1)) ** 0.5
        ax.axvline(m, color='red', linestyle='--', linewidth=1.5, label=f'Mean: {m:.3f}')
        ax.axvline(m - s, color='grey', linestyle='--', linewidth=1)
        ax.axvline(m + s, color='grey', linestyle='--', linewidth=1, label=f'±SD: {s:.3f}')
        ax.legend(fontsize=8)
    elif values:
        ax.hist(values, bins=1, color='steelblue')
    ax.set_title(title, fontsize=10)
    ax.set_xlabel(xlabel, fontsize=9)
    ax.set_ylabel('Count', fontsize=9)
    ax.grid(axis='y', color='#888888', linestyle='--', alpha=0.5)
    plt.tight_layout()
    buf = io.BytesIO()
    plt.savefig(buf, format='JPEG', dpi=100)
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def _mean_std(vals):
    if not vals:
        return 0.0, 0.0
    m = sum(vals) / len(vals)
    s = (sum((v - m) ** 2 for v in vals) / max(len(vals) - 1, 1)) ** 0.5
    return round(m, 3), round(s, 3)


def _encode_bgr(img_bgr):
    pil = im.fromarray(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB))
    buf = io.BytesIO()
    pil.save(buf, 'JPEG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def _encode_grey(img_grey_arr):
    pil = im.fromarray(img_grey_arr)
    buf = io.BytesIO()
    pil.save(buf, 'JPEG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')


@cell_morphology_filament.route('/cell_morphology_filament', methods=['GET', 'POST'])
def analyze_cell_morphology_filament():
    if request.method == 'POST':
        cached_image_key = request.form.get('cached_image_key', '').strip()
        cached_image_name_form = request.form.get('cached_image_name', '').strip()
        if request.form.get('pixel_size') == '':
            flash('Please enter pixel size', category='error')
        else:
            pixel_size_nm = float(str(request.form.get('pixel_size')))
            minimal_expected_size = float(request.form.get('minimal_diameter_range') or 1.0)
            minimum_area = math.pi * ((minimal_expected_size * 1000 / pixel_size_nm) / 2) ** 2
            min_diameter_px = minimal_expected_size / (pixel_size_nm / 1000)

            number_of_iterations    = int(request.form.get('iterations_range') or 4)
            factor_multiplying      = float(request.form.get('factor_1_multiplication_range') or 1.4)
            factor_distance_centers = int(request.form.get('factor_2_distance_range') or 28)
            bilateral_filter        = request.form.get('bilateral_filter', '') == '1'
            use_hmax                = request.form.get('use_hmax', '1') == '1'
            seg_method              = request.form.get('seg_method', 'peak_local_max')
            use_peak_local_max      = (seg_method == 'peak_local_max')
            use_skeleton            = (seg_method == 'skeleton')
            separate_filaments      = request.form.get('separate_filaments', '') == '1'
            max_aspect_ratio        = float(request.form.get('max_aspect_ratio') or 0)
            microscopy_mode         = request.form.get('microscopy_mode', 'fluorescence')
            ridge_sigma_um          = float(request.form.get('ridge_sigma') or 1.5)
            edge_weight             = float(request.form.get('edge_weight') or 0.5)

            roi_x_pct = float(request.form.get('roi_x_pct') or 0)
            roi_y_pct = float(request.form.get('roi_y_pct') or 0)
            roi_w_pct = float(request.form.get('roi_w_pct') or 0)
            roi_h_pct = float(request.form.get('roi_h_pct') or 0)
            use_roi   = roi_w_pct > 0 and roi_h_pct > 0

            blur_radius        = max(1, int(request.form.get('blur_radius') or 3))
            max_diam_um        = float(request.form.get('max_diam_range') or 0)
            clahe_clip         = float(request.form.get('clahe_clip') or 0)
            morph_iter         = int(request.form.get('morph_iter') or 0)
            circularity_min    = float(request.form.get('circularity_min') or 0)
            manual_thresh      = int(request.form.get('manual_thresh') or 0)
            exclude_stripes    = request.form.get('exclude_stripes') == '1'
            adaptive_block_size = int(request.form.get('adaptive_block_size') or 51)
            if adaptive_block_size < 3: adaptive_block_size = 3
            if adaptive_block_size % 2 == 0: adaptive_block_size += 1
            adaptive_c = int(request.form.get('adaptive_c') or 2)
            threshold  = request.form.get('threshold_filter', 'Binary + Otsu')

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
                        cached_image_key = 'morphfil_cache_' + uuid.uuid4().hex + image_extension
                        try:
                            for _old in glob.glob(os.path.join(UPLOAD_FOLDER, 'morphfil_cache_*')):
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
                            return render_template('cell_morphology_filament.html', image_name='')
                        nparr = np.frombuffer(open(_cache_path, 'rb').read(), np.uint8)
                        img_orig = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

                    # ── Preprocessing ──────────────────────────────────────
                    img_grey_raw = cv2.cvtColor(img_orig, cv2.COLOR_BGR2GRAY)
                    if bilateral_filter:
                        d = max(3, blur_radius * 2 + 1)
                        img_grey = cv2.bilateralFilter(img_grey_raw, d, 75, 75)
                    else:
                        img_blur = cv2.blur(img_orig, (blur_radius, blur_radius))
                        img_grey = cv2.cvtColor(img_blur, cv2.COLOR_BGR2GRAY)

                    if microscopy_mode == 'brightfield':
                        # --- BF two-stage: ridge filament map + Scharr edge septa ---
                        img_inv = cv2.bitwise_not(img_grey)
                        if RIDGE_AVAILABLE:
                            ridge_sigma_px = max(0.5, ridge_sigma_um * 1000 / pixel_size_nm)
                            sigmas = [ridge_sigma_px * f for f in (0.5, 1.0, 1.5)]
                            ridge_map = sato(img_grey.astype(np.float64) / 255.0,
                                             sigmas=sigmas, black_ridges=False)
                            ridge_map = (ridge_map / max(ridge_map.max(), 1e-6) * 255).astype(np.uint8)
                        else:
                            ridge_map = img_inv

                        # Scharr edge magnitude for septa / cell boundaries
                        sx = cv2.Scharr(img_grey, cv2.CV_64F, 1, 0)
                        sy = cv2.Scharr(img_grey, cv2.CV_64F, 0, 1)
                        edge_mag = np.sqrt(sx ** 2 + sy ** 2)
                        edge_mag = (edge_mag / max(edge_mag.max(), 1e-6) * 255).astype(np.uint8)

                        # Blend: ridge body + inverted edges (septa become dark gaps)
                        ew = max(0.0, min(1.0, edge_weight))
                        edge_inv = cv2.bitwise_not(edge_mag)
                        img_grey_th = cv2.addWeighted(ridge_map, 1.0 - ew,
                                                      edge_inv, ew, 0)
                    else:
                        img_grey_th = img_grey.copy()

                    if clahe_clip > 0:
                        clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
                        img_grey_th = clahe.apply(img_grey_th)

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

                    if morph_iter != 0:
                        kernel_morph = np.ones((3, 3), np.uint8)
                        if morph_iter > 0:
                            img_th = cv2.dilate(img_th, kernel_morph, iterations=morph_iter)
                        else:
                            img_th = cv2.erode(img_th, kernel_morph, iterations=-morph_iter)

                    if exclude_stripes:
                        h_s, w_s = img_th.shape[:2]
                        h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(20, w_s // 8), 1))
                        v_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(20, h_s // 8)))
                        h_lines  = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, h_kernel)
                        v_lines  = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, v_kernel)
                        img_th   = cv2.bitwise_and(img_th, cv2.bitwise_not(cv2.add(h_lines, v_lines)))

                    # ── Watershed segmentation ─────────────────────────────
                    kernel_ellipse   = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                    img_noise_reduced = cv2.morphologyEx(img_th, cv2.MORPH_OPEN, kernel_ellipse, iterations=3)

                    if separate_filaments:
                        sep_kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
                        img_noise_reduced = cv2.erode(img_noise_reduced, sep_kernel, iterations=1)
                    img_background = cv2.dilate(img_noise_reduced, kernel_ellipse,
                                                iterations=3 if separate_filaments else 2)

                    if microscopy_mode == 'brightfield':
                        img_for_ws = img_orig.copy()
                    else:
                        img_for_ws = cv2.threshold(img_grey, 0, 255, cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                        img_for_ws = cv2.cvtColor(img_for_ws, cv2.COLOR_GRAY2BGR)
                    img_for_ws_copy = img_for_ws.copy()

                    _, component_labels = cv2.connectedComponents(img_noise_reduced)
                    skeleton_full = skeletonize(img_noise_reduced > 0).astype(np.uint8) if SKIMAGE_AVAILABLE else None

                    if use_skeleton and SKIMAGE_AVAILABLE:
                        dist_transform = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, 5)
                        skeleton       = skeletonize(img_noise_reduced > 0).astype(np.uint8)
                        dist_on_skel   = dist_transform * skeleton
                        min_skel_dist  = max(2, int(min_diameter_px * 0.7))
                        coords = peak_local_max(dist_on_skel, min_distance=min_skel_dist,
                                                labels=skeleton.astype(bool))
                        markers = np.zeros(dist_transform.shape, dtype=np.int32)
                        for _idx, (_py, _px) in enumerate(coords, start=1):
                            markers[_py, _px] = _idx
                        markers = cv2.dilate(markers.astype(np.float32),
                                             np.ones((3, 3), np.uint8), iterations=2).astype(np.int32)
                        labels = skimage_watershed(-dist_transform, markers, mask=img_noise_reduced > 0)
                        final_contours = []
                        for label_id in range(1, int(labels.max()) + 1):
                            mask_label = (labels == label_id).astype(np.uint8) * 255
                            cnts, _ = cv2.findContours(mask_label, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                            if cnts:
                                final_contours.append(max(cnts, key=cv2.contourArea))
                        contours_watershed_temp = (final_contours, None)

                    elif use_peak_local_max and SKIMAGE_AVAILABLE:
                        dist_transform = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2, 5)
                        min_dist_px    = max(2, factor_distance_centers)
                        thresh_rel     = max(0.05, factor_multiplying * 0.3)
                        coords = peak_local_max(dist_transform, min_distance=min_dist_px,
                                                threshold_rel=thresh_rel,
                                                labels=img_noise_reduced.astype(bool))
                        markers = np.zeros(dist_transform.shape, dtype=np.int32)
                        for _idx, (_py, _px) in enumerate(coords, start=1):
                            markers[_py, _px] = _idx
                        markers = cv2.dilate(markers.astype(np.float32),
                                             np.ones((3, 3), np.uint8), iterations=2).astype(np.int32)
                        labels = skimage_watershed(-dist_transform, markers, mask=img_noise_reduced > 0)
                        final_contours = []
                        for label_id in range(1, int(labels.max()) + 1):
                            mask_label = (labels == label_id).astype(np.uint8) * 255
                            cnts, _ = cv2.findContours(mask_label, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                            if cnts:
                                final_contours.append(max(cnts, key=cv2.contourArea))
                        contours_watershed_temp = (final_contours, None)

                    else:
                        # Iterative watershed
                        scaling_factor_distance_transform = 5
                        scaling_factor_threshold          = 0.00
                        contours_watershed_temp           = list()

                        def _get_fg(dist_img, sft):
                            if use_hmax and SKIMAGE_AVAILABLE:
                                h_val     = max(0.1 * dist_img.max(), sft * dist_img.max())
                                local_max = h_maxima(dist_img, h=h_val)
                                return (local_max > 0).astype(np.uint8) * 255
                            else:
                                fg = cv2.threshold(dist_img, sft * dist_img.max(), 255, 0)[1]
                                return np.uint8(fg)

                        def _effective_radius(cnt):
                            if len(cnt) >= 5:
                                _, (MA, ma), _ = cv2.fitEllipse(cnt)
                                return ma / 2.0
                            (_, r) = cv2.minEnclosingCircle(cnt)
                            return r

                        img_dist_t = cv2.distanceTransform(img_noise_reduced, cv2.DIST_L2,
                                                           scaling_factor_distance_transform)
                        img_fg  = _get_fg(img_dist_t, scaling_factor_threshold)
                        img_sub = cv2.subtract(img_background, img_fg)
                        _, central_parts = cv2.connectedComponents(img_fg)
                        central_parts = central_parts + 1
                        central_parts[img_sub == 255] = 0
                        img_ws  = cv2.watershed(img_for_ws_copy, central_parts)
                        img_ws  = cv2.normalize(img_ws, None, alpha=0, beta=255,
                                                norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U)
                        _, thresh_ws = cv2.threshold(img_ws, 150, 255,
                                                     cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY_INV)
                        contours_watershed_th_reference = cv2.findContours(thresh_ws, cv2.RETR_LIST,
                                                                            cv2.CHAIN_APPROX_NONE)
                        contours_watershed_last = contours_watershed_th_reference

                        for _iter in range(number_of_iterations):
                            circles_all_old             = []
                            circles_all_actual          = []
                            circles_to_remain_old_temp  = []
                            circles_to_remain_actual_temp = []
                            circles_to_be_deleted_old   = []
                            circles_to_be_deleted_actual = []
                            scaling_factor_threshold    += 0.1
                            img_fg  = _get_fg(img_dist_t, scaling_factor_threshold)
                            img_sub = cv2.subtract(img_background, img_fg)
                            _, central_parts = cv2.connectedComponents(img_fg)
                            central_parts = central_parts + 1
                            central_parts[img_sub == 255] = 0
                            img_ws  = cv2.watershed(img_for_ws_copy, central_parts)
                            img_ws  = cv2.normalize(img_ws, None, alpha=0, beta=255,
                                                    norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U)
                            _, thresh_ws = cv2.threshold(img_ws, 150, 255,
                                                         cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY_INV)
                            contours_watershed_th  = cv2.findContours(thresh_ws, cv2.RETR_LIST,
                                                                       cv2.CHAIN_APPROX_NONE)
                            contours_ws_sorted     = sorted(contours_watershed_th[0], key=cv2.contourArea)[:-1]
                            cth_temp               = list(contours_watershed_th)
                            cth_temp[0]            = contours_ws_sorted
                            contours_watershed_th  = tuple(cth_temp)

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
                                        dist_c = math.sqrt((xc_act - xc_old) ** 2 + (yc_act - yc_old) ** 2)
                                        if factor_multiplying * rc_old > (dist_c + rc_act):
                                            circles_to_be_deleted_old.append(int(a))
                                            circles_to_remain_actual_temp.append(int(j))
                                        elif factor_multiplying * rc_act >= (dist_c + rc_old) and dist_c < rc_old:
                                            circles_to_be_deleted_actual.append(int(j))
                                            circles_to_remain_old_temp.append(int(a))
                                        elif dist_c < factor_distance_centers:
                                            circles_to_be_deleted_old.append(int(j))

                            circles_to_be_deleted_old    = [*set(circles_to_be_deleted_old)]
                            circles_to_be_deleted_actual = [*set(circles_to_be_deleted_actual)]
                            circles_to_remain_old_temp   = [*set(circles_to_remain_old_temp)]
                            circles_to_remain_actual_temp = [*set(circles_to_remain_actual_temp)]
                            circles_all_old              = [*set(circles_all_old)]
                            circles_all_actual           = [*set(circles_all_actual)]

                            circles_to_remain_old    = [x for x in circles_all_old
                                                        if x not in circles_to_be_deleted_old]
                            circles_to_remain_old    = list(dict.fromkeys(
                                circles_to_remain_old + circles_to_remain_old_temp))
                            circles_to_remain_actual = [x for x in circles_to_remain_actual_temp
                                                        if x not in circles_to_be_deleted_actual]

                            contours_watershed_temp    = list(contours_watershed_th)
                            contours_watershed_temp[0] = []
                            contours_watershed_temp    = tuple(contours_watershed_temp)
                            for k in circles_to_remain_old:
                                contours_watershed_temp[0].append(contours_watershed_last[0][k])
                            for k in circles_to_remain_actual:
                                contours_watershed_temp[0].append(contours_watershed_th[0][k])
                            contours_watershed_last = contours_watershed_temp

                    # ── ROI / max-diameter setup ───────────────────────────
                    h_img, w_img = img_orig.shape[:2]
                    roi_x1 = roi_y1 = roi_x2 = roi_y2 = 0
                    if use_roi:
                        roi_x1 = int(roi_x_pct * w_img)
                        roi_y1 = int(roi_y_pct * h_img)
                        roi_x2 = int((roi_x_pct + roi_w_pct) * w_img)
                        roi_y2 = int((roi_y_pct + roi_h_pct) * h_img)
                    maximum_area = (math.pi * ((max_diam_um * 1000 / pixel_size_nm) / 2) ** 2
                                    if max_diam_um > 0 else 0)

                    # ── First pass: filter + compute shape metrics ─────────
                    valid_cells = []
                    for contour in contours_watershed_temp[0]:
                        ((x, y), r) = cv2.minEnclosingCircle(contour)
                        xc = int(x)
                        yc = int(y)
                        rc = int(r)

                        if math.pi * rc ** 2 <= minimum_area:
                            continue
                        if maximum_area > 0 and math.pi * rc ** 2 > maximum_area:
                            continue

                        cnt_area  = cv2.contourArea(contour)
                        perimeter = cv2.arcLength(contour, True)
                        circularity = round(
                            min(1.0, (4 * math.pi * cnt_area) / max(perimeter ** 2, 0.01)), 3)

                        if circularity_min > 0 and circularity < circularity_min:
                            continue

                        if max_aspect_ratio > 0:
                            x_br, y_br, w_br, h_br = cv2.boundingRect(contour)
                            if max(w_br, h_br) / max(1, min(w_br, h_br)) > max_aspect_ratio:
                                continue

                        if use_roi and not (roi_x1 <= xc <= roi_x2 and roi_y1 <= yc <= roi_y2):
                            continue

                        if len(contour) >= 5:
                            try:
                                _, (MA, ma_ax), _ = cv2.fitEllipse(contour)
                                major_px     = max(MA, ma_ax)
                                minor_px     = min(MA, ma_ax)
                                major_um     = round(major_px * pixel_size_nm / 1000, 3)
                                minor_um     = round(minor_px * pixel_size_nm / 1000, 3)
                                aspect_ratio = round(major_px / max(minor_px, 0.01), 3)
                            except Exception:
                                major_px = minor_px = 2 * rc
                                major_um = minor_um = round(major_px * pixel_size_nm / 1000, 3)
                                aspect_ratio = 1.0
                        else:
                            major_px = minor_px = 2 * rc
                            major_um = minor_um = round(major_px * pixel_size_nm / 1000, 3)
                            aspect_ratio = 1.0

                        eccentricity = round(
                            math.sqrt(max(0.0, 1.0 - (minor_px / max(major_px, 0.01)) ** 2)), 3)
                        area_um2 = round(cnt_area * (pixel_size_nm / 1000) ** 2, 3)

                        _cy = min(yc, component_labels.shape[0] - 1)
                        _cx = min(xc, component_labels.shape[1] - 1)
                        filament_id = int(component_labels[_cy, _cx])

                        valid_cells.append((contour, [xc, yc, rc,
                                                       major_um, minor_um, aspect_ratio,
                                                       circularity, eccentricity, area_um2,
                                                       filament_id]))

                    # ── Second pass: draw colormap-annotated image ─────────
                    all_ar  = [c[1][5] for c in valid_cells]
                    ar_min  = min(all_ar) if all_ar else 1.0
                    ar_max  = max(all_ar) if all_ar else 1.0

                    img_annotated  = img_orig.copy()
                    morphology_data = []
                    n_cells = 0

                    for contour, cell_data in valid_cells:
                        n_cells += 1
                        xc, yc = cell_data[0], cell_data[1]
                        ar     = cell_data[5]
                        ratio  = (ar - ar_min) / max(ar_max - ar_min, 0.01)
                        r_val  = int(255 * min(1.0, 2.0 * (1.0 - ratio)))
                        g_val  = int(255 * min(1.0, 2.0 * ratio))
                        cv2.drawContours(img_annotated, [contour], -1, (0, g_val, r_val), 1)
                        cv2.putText(img_annotated, str(n_cells), (xc, yc),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
                        # Full contour points for client-side drawing (index 10)
                        contour_pts = contour.reshape(-1, 2).tolist()
                        morphology_data.append(cell_data + [contour_pts])

                    if use_roi:
                        cv2.rectangle(img_annotated, (roi_x1, roi_y1), (roi_x2, roi_y2),
                                      (0, 165, 255), 2)

                    # ── Per-filament summary ───────────────────────────────
                    filament_morph_map = {}
                    for cd in morphology_data:
                        fid = cd[9]
                        filament_morph_map.setdefault(fid, []).append(
                            (cd[5], cd[6], cd[7], cd[8]))  # ar, circ, ecc, area

                    filament_summary = []
                    for fid in sorted(filament_morph_map.keys()):
                        items   = filament_morph_map[fid]
                        n       = len(items)
                        ars     = [x[0] for x in items]
                        circs   = [x[1] for x in items]
                        eccs    = [x[2] for x in items]
                        areas   = [x[3] for x in items]
                        m_ar,   s_ar   = _mean_std(ars)
                        m_circ, s_circ = _mean_std(circs)
                        m_ecc,  s_ecc  = _mean_std(eccs)
                        m_area, _      = _mean_std(areas)
                        filament_summary.append({
                            'filament_id': fid,  'cell_count': n,
                            'mean_ar':   m_ar,   'std_ar':   s_ar,
                            'mean_circ': m_circ, 'std_circ': s_circ,
                            'mean_ecc':  m_ecc,  'std_ecc':  s_ecc,
                            'mean_area_um2': m_area,
                        })
                    n_filaments = len(filament_summary)

                    all_arv   = [cd[5] for cd in morphology_data]
                    all_circ  = [cd[6] for cd in morphology_data]
                    all_ecc   = [cd[7] for cd in morphology_data]
                    all_area  = [cd[8] for cd in morphology_data]
                    all_major = [cd[3] for cd in morphology_data]
                    all_minor = [cd[4] for cd in morphology_data]
                    mean_ar,    std_ar    = _mean_std(all_arv)
                    mean_circ,  std_circ  = _mean_std(all_circ)
                    mean_ecc,   std_ecc   = _mean_std(all_ecc)
                    mean_area,  std_area  = _mean_std(all_area)
                    mean_major, std_major = _mean_std(all_major)
                    mean_minor, std_minor = _mean_std(all_minor)

                    # ── Histograms ─────────────────────────────────────────
                    hist_ar_from_memory    = _morph_histogram(
                        all_arv,   'Aspect ratio (major/minor)', 'Aspect Ratio Distribution')
                    hist_circ_from_memory  = _morph_histogram(
                        all_circ,  'Circularity (4πA/P²)', 'Circularity Distribution')
                    hist_ecc_from_memory   = _morph_histogram(
                        all_ecc,   'Eccentricity', 'Eccentricity Distribution')
                    hist_area_from_memory  = _morph_histogram(
                        all_area,  'Area (µm²)', 'Cell Area Distribution')
                    hist_major_from_memory = _morph_histogram(
                        all_major, 'Length (µm)', 'Cell Length Distribution')
                    hist_minor_from_memory = _morph_histogram(
                        all_minor, 'Width (µm)', 'Cell Width Distribution')

                    # ── Colorbar ───────────────────────────────────────────
                    fig_cb, ax_cb = plt.subplots(figsize=(1.2, 4))
                    cmap_custom = mcolors.LinearSegmentedColormap.from_list(
                        'RdYlGn_morph', [(1, 0, 0), (1, 1, 0), (0, 1, 0)])
                    norm_cb = mcolors.Normalize(vmin=round(ar_min, 2), vmax=round(ar_max, 2))
                    sm = mcm.ScalarMappable(norm=norm_cb, cmap=cmap_custom)
                    sm.set_array([])
                    cb = fig_cb.colorbar(sm, cax=ax_cb)
                    cb.set_label('Aspect Ratio', fontsize=9)
                    ax_cb.tick_params(labelsize=8)
                    plt.tight_layout()
                    buf_cb = io.BytesIO()
                    plt.savefig(buf_cb, format='JPEG', dpi=100)
                    plt.close(fig_cb)
                    buf_cb.seek(0)
                    colorbar_from_memory = base64.b64encode(buf_cb.getvalue()).decode('utf-8')

                    # ── Encode images ──────────────────────────────────────
                    img_orig_decoded_from_memory      = _encode_bgr(img_orig)
                    img_annotated_decoded_from_memory = _encode_bgr(img_annotated)
                    img_th_decoded_from_memory        = _encode_grey(img_th)

                    # ── Excel export ───────────────────────────────────────
                    y_pixels, x_pixels = img_orig.shape[:2]
                    xlsx_full_path = os.path.join(UPLOAD_FOLDER, f'{image_name}_morphology.xlsx')
                    per_cell_df = pd.DataFrame([{
                        'cell_id':       i + 1,
                        'filament_id':   cd[9],
                        'centroid_x_px': cd[0],
                        'centroid_y_px': cd[1],
                        'major_um':      cd[3],
                        'minor_um':      cd[4],
                        'area_um2':      cd[8],
                        'aspect_ratio':  cd[5],
                        'circularity':   cd[6],
                        'eccentricity':  cd[7],
                    } for i, cd in enumerate(morphology_data)]) if morphology_data else pd.DataFrame()
                    per_fil_df = pd.DataFrame(filament_summary) if filament_summary else pd.DataFrame()

                    with pd.ExcelWriter(xlsx_full_path, engine='xlsxwriter') as writer:
                        workbook = writer.book
                        per_cell_df.to_excel(writer, sheet_name='Per Cell',     index=False)
                        per_fil_df.to_excel(writer,  sheet_name='Per Filament', index=False)
                        ws_ann   = workbook.add_worksheet('Annotated Image')  # type: ignore
                        ws_hists = workbook.add_worksheet('Histograms')  # type: ignore
                        ws_ann.insert_image('A1', 'Annotated', {
                            'image_data': io.BytesIO(base64.b64decode(img_annotated_decoded_from_memory))})
                        ws_hists.insert_image('A1', 'AR', {
                            'image_data': io.BytesIO(base64.b64decode(hist_ar_from_memory))})
                        ws_hists.insert_image('J1', 'Circularity', {
                            'image_data': io.BytesIO(base64.b64decode(hist_circ_from_memory))})
                        ws_hists.insert_image('S1', 'Eccentricity', {
                            'image_data': io.BytesIO(base64.b64decode(hist_ecc_from_memory))})
                        ws_hists.insert_image('A20', 'Area', {
                            'image_data': io.BytesIO(base64.b64decode(hist_area_from_memory))})
                        ws_hists.insert_image('J20', 'Length', {
                            'image_data': io.BytesIO(base64.b64decode(hist_major_from_memory))})
                        ws_hists.insert_image('S20', 'Width', {
                            'image_data': io.BytesIO(base64.b64decode(hist_minor_from_memory))})
                    xlsx_file_path = f'uploads/{image_name}_morphology.xlsx'

                    return render_template('cell_morphology_filament.html',
                        image_name=image_name,
                        img_orig_decoded_from_memory=img_orig_decoded_from_memory,
                        img_th_decoded_from_memory=img_th_decoded_from_memory,
                        colorbar_from_memory=colorbar_from_memory,
                        hist_ar_from_memory=hist_ar_from_memory,
                        hist_circ_from_memory=hist_circ_from_memory,
                        hist_ecc_from_memory=hist_ecc_from_memory,
                        hist_area_from_memory=hist_area_from_memory,
                        hist_major_from_memory=hist_major_from_memory,
                        hist_minor_from_memory=hist_minor_from_memory,
                        morphology_data=morphology_data,
                        filament_summary=filament_summary,
                        n_cells=n_cells,
                        n_filaments=n_filaments,
                        mean_ar=mean_ar,     std_ar=std_ar,
                        mean_circ=mean_circ, std_circ=std_circ,
                        mean_ecc=mean_ecc,   std_ecc=std_ecc,
                        mean_area=mean_area, std_area=std_area,
                        mean_major=mean_major, std_major=std_major,
                        mean_minor=mean_minor, std_minor=std_minor,
                        pixel_size_nm=pixel_size_nm,
                        x_pixels=x_pixels,
                        y_pixels=y_pixels,
                        xlsx_file_path=xlsx_file_path,
                        cached_image_key=cached_image_key,
                        cached_image_name=image_name,
                        minimal_expected_size=minimal_expected_size,
                        blur_radius=blur_radius,
                        threshold=threshold,
                        microscopy_mode=microscopy_mode,
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
                        ridge_sigma_um=ridge_sigma_um,
                        edge_weight=edge_weight,
                    )
                else:
                    flash('Please select an image file.', category='error')
        return render_template('cell_morphology_filament.html', image_name='',
                               cached_image_key=cached_image_key,
                               cached_image_name=cached_image_name_form)
    return render_template('cell_morphology_filament.html', image_name='')
