from flask import Blueprint, render_template, request, jsonify, redirect, url_for
import os
import re
import struct
import pandas as pd
import numpy as np
from werkzeug.utils import secure_filename

ex_em_spectra_analysis = Blueprint('ex_em_spectra_analysis', __name__)


def apply_2d_map_range(ex_wl, em_wl, intensity, map_range):
    """Crop or zero-pad 2D intensity matrix to user-specified Ex/Em range."""
    ex_step = ex_wl[1] - ex_wl[0] if len(ex_wl) > 1 else 1
    em_step = em_wl[1] - em_wl[0] if len(em_wl) > 1 else 1
    ex_min = map_range['ex_min'] if map_range['ex_min'] else ex_wl.min()
    ex_max = map_range['ex_max'] if map_range['ex_max'] else ex_wl.max()
    em_min = map_range['em_min'] if map_range['em_min'] else em_wl.min()
    em_max = map_range['em_max'] if map_range['em_max'] else em_wl.max()
    new_ex_wl = np.arange(ex_min, ex_max + ex_step, ex_step)
    new_em_wl = np.arange(em_min, em_max + em_step, em_step)
    new_intensity = np.zeros((len(new_em_wl), len(new_ex_wl)))
    for i, ex in enumerate(ex_wl):
        if ex_min <= ex <= ex_max:
            new_ex_idx = np.argmin(np.abs(new_ex_wl - ex))
            for j, em in enumerate(em_wl):
                if em_min <= em <= em_max:
                    new_em_idx = np.argmin(np.abs(new_em_wl - em))
                    new_intensity[new_em_idx, new_ex_idx] = intensity[j, i]
    return new_ex_wl, new_em_wl, new_intensity


def parse_jasco_csv(file_obj):
    """
    Parse Jasco FP-8050/8550 CSV EEM file (comma or semicolon delimited).
    Also handles AMINCO-Bowman Series 2 Jasco-compatible exports.
    Returns (ex_wl_arr, em_wl_arr, intensity) as float numpy arrays.
    intensity shape: [n_em x n_ex]
    """
    raw = file_obj.read()
    content = raw.decode('utf-8', errors='replace') if isinstance(raw, bytes) else raw
    lines = [l for l in content.splitlines() if l.strip()]

    # Auto-detect delimiter (semicolon vs comma)
    probe = '\n'.join(lines[:10])
    sep = ';' if probe.count(';') > probe.count(',') else ','

    # Find XYDATA marker
    xydata_idx = None
    for i, line in enumerate(lines):
        if line.split(sep)[0].strip().upper().startswith('XYDATA'):
            xydata_idx = i
            break
    if xydata_idx is None:
        raise ValueError("XYDATA marker not found")

    rows = []
    for line in lines[xydata_idx + 1:]:
        parts = line.split(sep)
        vals = []
        for p in parts:
            p = p.strip()
            try:
                vals.append(float(p) if p else 0.0)
            except ValueError:
                vals.append(0.0)
        rows.append(vals)

    if len(rows) < 2:
        raise ValueError("Not enough data rows after XYDATA")

    # Row 0: [empty/0, ex1, ex2, ...]  Rows 1+: [em, int1, int2, ...]
    ex_wl_arr = np.array([v for v in rows[0][1:] if v > 0], dtype=float)
    em_wl_arr = np.array([row[0] for row in rows[1:] if row[0] > 0], dtype=float)
    n_ex, n_em = len(ex_wl_arr), len(em_wl_arr)
    intensity = np.zeros((n_em, n_ex))
    for i, row in enumerate(rows[1:]):
        if i >= n_em:
            break
        for j in range(n_ex):
            if j + 1 < len(row):
                intensity[i, j] = row[j + 1]
    return ex_wl_arr, em_wl_arr, intensity


def parse_horiba_spc(file_obj, filename='', ex_start_override=None, ex_inc_override=None):
    """
    Parse Horiba FluoroMax-P Galactic SPC binary file (K-format, fversn=75).
    Each file = one emission scan. The excitation wavelength is derived from
    the sequential file index embedded in the filename (e.g. DISC_15 → index 15)
    combined with the scan Start and Increment.

    ex_start_override / ex_inc_override: user-supplied values that take precedence
    over anything found in the log block (needed because FluoroMax stores Scout
    Program parameters — not the actual EEM scan params — in the [Scan Param] block).
    Returns dict with keys: em_wl_arr, y_arr, ex_wl, file_index, scan_start, scan_increment
    """
    data = file_obj.read()
    if len(data) < 544:
        raise ValueError("File too small to be a valid SPC file")

    fversn = data[1]
    if fversn != 75:  # 0x4B = 'K' — new Galactic format
        raise ValueError(f"Unsupported SPC version byte: {fversn}")

    fexp   = data[3]
    fnpts  = struct.unpack_from('<i', data, 4)[0]
    ffirst = struct.unpack_from('<d', data, 8)[0]
    flast  = struct.unpack_from('<d', data, 16)[0]

    if fnpts <= 0:
        raise ValueError("SPC file reports 0 data points")

    # Emission wavelengths (normalised to ascending order)
    em_wl_arr = np.linspace(min(ffirst, flast), max(ffirst, flast), fnpts)

    DATA_OFFSET = 544  # 512-byte main header + 32-byte subfile header
    if len(data) < DATA_OFFSET + fnpts * 4:
        raise ValueError("SPC file truncated — not enough Y data bytes")

    if fexp == 0x80:
        y_raw = np.frombuffer(data, dtype='<f4', count=fnpts, offset=DATA_OFFSET).copy().astype(float)
    else:
        y_raw = np.frombuffer(data, dtype='<i4', count=fnpts, offset=DATA_OFFSET).copy().astype(float)
        y_raw *= 2.0 ** (int(fexp) - 32)

    if ffirst > flast:   # bidirectional: odd files scan high→low
        y_raw = y_raw[::-1]

    # Parse log block for scan parameters
    log_text = data[DATA_OFFSET + fnpts * 4:].decode('ascii', errors='replace')
    # Detect Scout Program metadata — its Start/Increment describe a wide survey scan
    # (290–850 nm), not the actual EEM acquisition, so they must be ignored.
    _is_scout = bool(re.search(r'Comment\s*=\s*Scout Program', log_text, re.IGNORECASE))
    if ex_start_override is not None:
        scan_start = ex_start_override
    elif _is_scout:
        scan_start = None
    else:
        _m = re.search(r'Start=([0-9]+\.?[0-9]*)', log_text)
        scan_start = float(_m.group(1)) if _m else None
    if ex_inc_override is not None:
        scan_increment = ex_inc_override
    elif _is_scout:
        scan_increment = None
    else:
        _m = re.search(r'Increment=([0-9]+\.?[0-9]*)', log_text)
        scan_increment = float(_m.group(1)) if _m else None

    # File index from filename (e.g. "DISC_15" → 15, "sample_007" → 7)
    m_idx = re.search(r'[_\-](\d+)$', os.path.splitext(filename)[0])
    file_index = int(m_idx.group(1)) if m_idx else None

    # Compute excitation wavelength: Start + index * Increment
    ex_wl = None
    if file_index is not None and scan_start is not None and scan_increment is not None:
        ex_wl = scan_start + file_index * scan_increment
    # Fallback: MONO1 WLD1 (static last-known position — only useful if all at same excitation)
    if ex_wl is None:
        m = re.search(r'\[MONO1\][^\[]*?WLD1=([0-9]+\.?[0-9]*)', log_text, re.DOTALL)
        ex_wl = float(m.group(1)) if m else 0.0

    return {
        'em_wl_arr':      em_wl_arr,
        'y_arr':          y_raw,
        'ex_wl':          ex_wl,
        'file_index':     file_index,
        'scan_start':     scan_start,
        'scan_increment': scan_increment,
    }


@ex_em_spectra_analysis.route('/fluorescence_spectra', methods=['GET'])
def analyze_ex_em_spectra():
    return render_template('ex_em_spectra_analysis.html')

@ex_em_spectra_analysis.route('/ex_em_spectra_analysis', methods=['GET'])
def ex_em_redirect():
    return redirect(url_for('ex_em_spectra_analysis.analyze_ex_em_spectra'), 301)


@ex_em_spectra_analysis.route('/api/eem_process', methods=['POST'])
def eem_process():
    max_files = 100

    # Collect excitation and emission wavelengths from form
    ex_wls_requested = []
    em_wls_requested = []
    for i in range(1, 7):
        v = request.form.get(f'ex_{i}', '').strip()
        if v:
            try:
                ex_wls_requested.append(int(float(v)))
            except ValueError:
                pass
        v = request.form.get(f'em_{i}', '').strip()
        if v:
            try:
                em_wls_requested.append(int(float(v)))
            except ValueError:
                pass

    try:
        norm_ex = int(float(request.form.get('ex_for_norm', 0) or 0))
        norm_em = int(float(request.form.get('em_for_norm', 0) or 0))
    except (TypeError, ValueError):
        norm_ex = norm_em = 0

    pigmentation = request.form.get('checkbox_pigmentation', 'checkbox_chl_only')
    analysis_mode = request.form.get('analysis_mode', '77K')  # '77K' or 'RT'

    # Map display range (optional)
    map_range: dict[str, int | None] = {'ex_min': None, 'ex_max': None, 'em_min': None, 'em_max': None}
    for form_key, range_key in [
        ('ex_map_min', 'ex_min'), ('ex_map_max', 'ex_max'),
        ('em_map_min', 'em_min'), ('em_map_max', 'em_max')
    ]:
        v = request.form.get(form_key, '').strip()
        if v:
            try:
                map_range[range_key] = int(float(v))
            except ValueError:
                pass

    # SPC EX scan overrides (FluoroMax EEM disc files)
    try:
        v = request.form.get('spc_ex_start', '').strip()
        spc_ex_start = float(v) if v else None
    except ValueError:
        spc_ex_start = None
    try:
        v = request.form.get('spc_ex_increment', '').strip()
        spc_ex_increment = float(v) if v else None
    except ValueError:
        spc_ex_increment = None

    if '77K_files' not in request.files:
        return jsonify({'error': 'No files uploaded'}), 400

    files = request.files.getlist('77K_files')
    if not files or secure_filename(files[0].filename or '') == '':
        return jsonify({'error': 'No files selected'}), 400

    if len(files) > max_files:
        return jsonify({'error': f'Maximum {max_files} files allowed'}), 400

    result = {
        'files': [],
        'ex_wls': ex_wls_requested,
        'em_wls': em_wls_requested,
        'norm_ex': norm_ex,
        'norm_em': norm_em,
        'pigmentation': pigmentation,
        'analysis_mode': analysis_mode,
        'maps': {},
        'emission_spectra': {str(ex): {'wl': [], 'raw': {}, 'norm': {}} for ex in ex_wls_requested},
        'excitation_spectra': {str(em): {'wl': [], 'raw': {}, 'norm': {}} for em in em_wls_requested},
        'params': {},
        'warnings': []
    }

    # ── helper: add one parsed EEM to result ─────────────────────────────────
    def process_eem(fname, ex_wl_arr, em_wl_arr, intensity):
        result['files'].append(fname)

        # 2D map
        map_ex, map_em, map_int = ex_wl_arr, em_wl_arr, intensity
        if any(v is not None for v in map_range.values()):
            map_ex, map_em, map_int = apply_2d_map_range(ex_wl_arr, em_wl_arr, intensity, map_range)
        result['maps'][fname] = {
            'ex_wl': map_ex.tolist(),
            'em_wl': map_em.tolist(),
            'intensity': map_int.tolist()
        }

        # Nearest-neighbour lookup — uses argmin so it works for any step size
        def get_point(ex, em, tol=2.0):
            ex_idx = int(np.argmin(np.abs(ex_wl_arr - ex)))
            em_idx = int(np.argmin(np.abs(em_wl_arr - em)))
            if np.abs(ex_wl_arr[ex_idx] - ex) > tol:
                return None
            if np.abs(em_wl_arr[em_idx] - em) > tol:
                return None
            return float(intensity[em_idx, ex_idx])

        # Emission spectra
        for ex_wl in ex_wls_requested:
            ex_idx = int(np.argmin(np.abs(ex_wl_arr - ex_wl)))
            if np.abs(ex_wl_arr[ex_idx] - ex_wl) > 2.0:
                continue
            em_data = intensity[:, ex_idx].astype(float)
            es = result['emission_spectra'][str(ex_wl)]
            if not es['wl']:
                es['wl'] = em_wl_arr.tolist()
            es['raw'][fname] = em_data.tolist()
            if norm_em:
                em_idx2 = int(np.argmin(np.abs(em_wl_arr - norm_em)))
                if np.abs(em_wl_arr[em_idx2] - norm_em) <= 2.0:
                    nv = em_data[em_idx2]
                    if nv != 0:
                        es['norm'][fname] = (em_data / nv).tolist()

        # Excitation spectra
        for em_wl in em_wls_requested:
            em_idx = int(np.argmin(np.abs(em_wl_arr - em_wl)))
            if np.abs(em_wl_arr[em_idx] - em_wl) > 2.0:
                continue
            ex_data = intensity[em_idx, :].astype(float)
            xs = result['excitation_spectra'][str(em_wl)]
            if not xs['wl']:
                xs['wl'] = ex_wl_arr.tolist()
            xs['raw'][fname] = ex_data.tolist()
            if norm_ex:
                ex_idx2 = int(np.argmin(np.abs(ex_wl_arr - norm_ex)))
                if np.abs(ex_wl_arr[ex_idx2] - norm_ex) <= 2.0:
                    nv = ex_data[ex_idx2]
                    if nv != 0:
                        xs['norm'][fname] = (ex_data / nv).tolist()

        # Derived photosystem parameters
        if analysis_mode == 'RT':
            params: dict[str, float | None] = {k: None for k in [
                'F685', 'F695', 'F730',
                'F685_to_F730', 'F695_to_F730', 'F695_to_F685',
                'PBS_F657', 'PBS_F685', 'PBS_F705', 'PBS_F730', 'PBS_tot',
                'PBS_free_norm', 'PBS_PSII_norm', 'PBS_PSI_norm',
                'PBS_F685_to_F705', 'PBS_F685_to_F730'
            ]}
            f685 = get_point(440, 685)
            f695 = get_point(440, 695)
            f730 = get_point(440, 730)
            params['F685'] = f685
            params['F695'] = f695
            params['F730'] = f730
            if f685 is not None and f730 is not None and f730 > 0:
                params['F685_to_F730'] = f685 / f730
            if f695 is not None and f730 is not None and f730 > 0:
                params['F695_to_F730'] = f695 / f730
            if f695 is not None and f685 is not None and f685 > 0:
                params['F695_to_F685'] = f695 / f685
            pbs_f657 = get_point(620, 657)
            pbs_f685 = get_point(620, 685)
            pbs_f705 = get_point(620, 705)
            pbs_f730 = get_point(620, 730)
            params['PBS_F657'] = pbs_f657
            params['PBS_F685'] = pbs_f685
            params['PBS_F705'] = pbs_f705
            params['PBS_F730'] = pbs_f730
            if pbs_f657 is not None and pbs_f685 is not None and pbs_f705 is not None:
                pbs_tot = pbs_f657 + pbs_f685 + pbs_f705
                params['PBS_tot'] = pbs_tot
                if pbs_tot > 0:
                    params['PBS_free_norm'] = pbs_f657 / pbs_tot
                    params['PBS_PSII_norm'] = pbs_f685 / pbs_tot
                    params['PBS_PSI_norm']  = pbs_f705 / pbs_tot
            if pbs_f685 is not None and pbs_f705 is not None and pbs_f705 > 0:
                params['PBS_F685_to_F705'] = pbs_f685 / pbs_f705
            if pbs_f685 is not None and pbs_f730 is not None and pbs_f730 > 0:
                params['PBS_F685_to_F730'] = pbs_f685 / pbs_f730
        else:
            chl_psii = get_point(440, 689)
            chl_psi  = get_point(440, 724)
            params: dict[str, float | None] = {k: None for k in [
                'Chl_PSII', 'Chl_PSI', 'Chl_tot',
                'Chl_PSII_norm', 'Chl_PSI_norm', 'PSII_to_PSI',
                'PBS_free', 'PBS_PSII', 'PBS_PSI', 'PBS_tot',
                'PBS_free_norm', 'PBS_PSII_norm', 'PBS_PSI_norm',
                'PBS_PSII_to_PBS_PSI', 'PC_to_PE'
            ]}
            params['Chl_PSII'] = chl_psii
            params['Chl_PSI']  = chl_psi
            if chl_psii is not None and chl_psi is not None:
                chl_tot = chl_psii + chl_psi
                params['Chl_tot'] = chl_tot
                if chl_tot > 0:
                    params['Chl_PSII_norm'] = chl_psii / chl_tot
                    params['Chl_PSI_norm']  = chl_psi  / chl_tot
                if chl_psi and chl_psi > 0:
                    params['PSII_to_PSI'] = chl_psii / chl_psi
            if pigmentation != 'checkbox_chl_only':
                pbs_free = pbs_psii = pbs_psi = None
                if pigmentation == 'checkbox_chl_PC':
                    pbs_free  = get_point(620, 662)
                    pbs_psii  = get_point(620, 689)
                    pbs_psi   = get_point(620, 724)
                elif pigmentation == 'checkbox_chl_PE':
                    p562 = get_point(560, 662)
                    p558 = get_point(560, 580)
                    if p562 is not None and p558 is not None:
                        pbs_free = p562 + p558
                    pbs_psii = get_point(560, 689)
                    pbs_psi  = get_point(560, 724)
                elif pigmentation == 'checkbox_chl_PC_PE':
                    if 560 in ex_wls_requested:
                        pbs_free = (get_point(620, 662) or 0) + (get_point(560, 662) or 0) + (get_point(560, 580) or 0)
                        pbs_psii = (get_point(620, 689) or 0) + (get_point(560, 689) or 0)
                        pbs_psi  = (get_point(620, 724) or 0) + (get_point(560, 724) or 0)
                        pc     = get_point(620, 662)
                        pe_662 = get_point(560, 662)
                        pe_580 = get_point(560, 580)
                        if pc is not None and pe_662 is not None and pe_580 is not None:
                            pe = pe_662 + pe_580
                            params['PC_to_PE'] = pc / pe if pe > 0 else None
                    else:
                        pbs_free = get_point(620, 662)
                        pbs_psii = get_point(620, 689)
                        pbs_psi  = get_point(620, 724)
                params['PBS_free'] = pbs_free
                params['PBS_PSII'] = pbs_psii
                params['PBS_PSI']  = pbs_psi
                if pbs_free is not None and pbs_psii is not None and pbs_psi is not None:
                    pbs_tot = pbs_free + pbs_psii + pbs_psi
                    params['PBS_tot'] = pbs_tot
                    if pbs_tot > 0:
                        params['PBS_free_norm']  = pbs_free  / pbs_tot
                        params['PBS_PSII_norm']  = pbs_psii  / pbs_tot
                        params['PBS_PSI_norm']   = pbs_psi   / pbs_tot
                    if pbs_psi > 0:
                        params['PBS_PSII_to_PBS_PSI'] = pbs_psii / pbs_psi

        result['params'][fname] = params
    # ── end helper ────────────────────────────────────────────────────────────

    # ── First pass: separate CSV and SPC files ────────────────────────────────
    spc_slices = {}   # {fname_lower: {'ex_wl': float, 'em_wl_arr': arr, 'y_arr': arr}}

    for file in files:
        fname_raw = file.filename or ''
        fname     = str.lower(os.path.splitext(fname_raw)[0])
        fext      = str.lower(os.path.splitext(fname_raw)[1])

        if fext not in ('.csv', '.spc'):
            result['warnings'].append(f'{fname_raw}: unsupported extension (expected .csv or .spc), skipped')
            continue

        if fext == '.csv':
            try:
                ex_wl_arr, em_wl_arr, intensity = parse_jasco_csv(file)
                ex_wl_arr = np.asarray(ex_wl_arr, dtype=np.float64)
                em_wl_arr = np.asarray(em_wl_arr, dtype=np.float64)
                intensity = np.asarray(intensity,  dtype=np.float64)
            except Exception as e:
                result['warnings'].append(f'{fname_raw}: parse error – {e}')
                continue
            process_eem(fname, ex_wl_arr, em_wl_arr, intensity)

        else:  # .spc
            try:
                spc = parse_horiba_spc(file, fname_raw,
                                       ex_start_override=spc_ex_start,
                                       ex_inc_override=spc_ex_increment)
            except Exception as e:
                result['warnings'].append(f'{fname_raw}: parse error – {e}')
                continue
            spc_slices[fname] = spc

    # ── Second pass: group SPC slices by filename prefix → one EEM per group ─
    # Prefix = filename with trailing _digits stripped (e.g. "disc_15" → "disc")
    if spc_slices:
        groups: dict[str, list] = {}
        for fname, spc in spc_slices.items():
            prefix = re.sub(r'[_\-]\d+$', '', fname) or fname
            groups.setdefault(prefix, []).append((fname, spc))

        for group_name, members in groups.items():
            # Sort by excitation wavelength
            members.sort(key=lambda x: x[1]['ex_wl'])

            # Use emission grid from first member (all should be identical)
            em_wl_ref = members[0][1]['em_wl_arr']
            n_em = len(em_wl_ref)

            ex_wl_arr = np.array([m[1]['ex_wl']   for m in members], dtype=np.float64)
            intensity = np.zeros((n_em, len(members)), dtype=np.float64)
            for j, (_, spc) in enumerate(members):
                y = spc['y_arr']
                n = min(len(y), n_em)
                intensity[:n, j] = y[:n]

            process_eem(group_name, ex_wl_arr, em_wl_ref, intensity)

    if not result['files']:
        msg = 'No files were successfully processed.'
        if result['warnings']:
            msg += ' ' + '; '.join(result['warnings'])
        return jsonify({'error': msg}), 400

    return jsonify(result)
