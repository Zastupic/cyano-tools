from flask import Blueprint, render_template, request, jsonify, redirect, url_for, Response, stream_with_context
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


def parse_aminco_txt(file_obj):
    """
    Parse AMINCO-Bowman Series 2 EEM export (.txt).
    Format: one file contains multiple emission scans (e.g. 620-800 nm @ 1 nm step)
    at successive excitation wavelengths.  Each scan block is introduced by a
    sub-header that contains a line of the form  'Z-axis:  <float>'  giving the
    excitation wavelength.  Data lines are two whitespace-separated values:
        <emission_nm>  <intensity>
    Blank lines and all other header/annotation lines are skipped.
    Returns (ex_wl_arr, em_wl_arr, intensity) as float numpy arrays.
    intensity shape: [n_em x n_ex]
    """
    raw = file_obj.read()
    content = raw.decode('utf-8', errors='replace') if isinstance(raw, bytes) else raw
    lines = content.splitlines()

    scans = []          # list of (ex_wl, dict{em_wl: intensity})
    current_ex = None
    current_data = {}

    for line in lines:
        stripped = line.strip()

        # Detect excitation wavelength marker: 'Z-axis:  <number>'
        if re.match(r'Z-axis\s*:', stripped, re.IGNORECASE):
            val_str = re.split(r':', stripped, maxsplit=1)[1].strip()
            try:
                ex_wl = float(val_str)
                # Save previous scan if any
                if current_ex is not None and current_data:
                    scans.append((current_ex, current_data))
                current_ex = ex_wl
                current_data = {}
            except ValueError:
                pass  # e.g. 'Z-Axis: Excitation (nm)' global header line
            continue

        # Data lines: exactly two numeric tokens
        if stripped == '' or current_ex is None:
            continue
        parts = stripped.split()
        if len(parts) == 2:
            try:
                em_wl = float(parts[0])
                intensity_val = float(parts[1])
                current_data[em_wl] = intensity_val
            except ValueError:
                pass  # header / annotation line

    # Flush last scan
    if current_ex is not None and current_data:
        scans.append((current_ex, current_data))

    if not scans:
        raise ValueError("No excitation/emission data blocks found in AMINCO file")

    # Build arrays — use emission grid from first scan (all should match)
    ex_wl_arr = np.array([s[0] for s in scans], dtype=float)
    em_wls_sorted = sorted(scans[0][1].keys())
    em_wl_arr = np.array(em_wls_sorted, dtype=float)
    n_ex = len(ex_wl_arr)
    n_em = len(em_wl_arr)
    intensity = np.zeros((n_em, n_ex), dtype=float)
    for j, (_, data) in enumerate(scans):
        for i, em in enumerate(em_wl_arr):
            intensity[i, j] = data.get(em, 0.0)

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


# ─── PARAFAC helpers ──────────────────────────────────────────────────────────

_FLUOROPHORE_TABLE = [
    {'ex': 440, 'em': 689, 'label': 'Chl-PSII'},
    {'ex': 440, 'em': 724, 'label': 'Chl-PSI'},
    {'ex': 620, 'em': 662, 'label': 'PBS-free (PC)'},
    {'ex': 620, 'em': 689, 'label': 'PBS→PSII'},
    {'ex': 620, 'em': 724, 'label': 'PBS→PSI'},
    {'ex': 560, 'em': 580, 'label': 'PE direct'},
    {'ex': 560, 'em': 662, 'label': 'PE→PC'},
    {'ex': 560, 'em': 689, 'label': 'PE→PSII'},
    {'ex': 560, 'em': 724, 'label': 'PE→PSI'},
]


def _remove_scatter(em_wl, ex_wl, intensity,
                    rayleigh1_width=0.0, rayleigh2_width=0.0, raman_width=0.0,
                    interpolate=True):
    """
    Remove Rayleigh/Raman scatter bands from a 2D EEM.
    intensity: shape (n_em, n_ex) — modified copy is returned.
    Bands are zeroed then optionally filled by linear interpolation along emission axis.
    """
    result = intensity.copy().astype(float)
    n_em = len(em_wl)
    for j, ex in enumerate(ex_wl):
        mask = np.zeros(n_em, dtype=bool)
        if rayleigh1_width > 0:
            mask |= np.abs(em_wl - ex) <= rayleigh1_width
        if rayleigh2_width > 0:
            mask |= np.abs(em_wl - 2.0 * ex) <= rayleigh2_width
        if raman_width > 0 and ex > 0:
            inv_raman = 1.0 / ex - 3400.0 / 1e7
            if inv_raman > 0:
                raman_em = 1.0 / inv_raman
                mask |= np.abs(em_wl - raman_em) <= raman_width
        if not np.any(mask):
            continue
        result[mask, j] = 0.0
        if interpolate:
            valid = ~mask
            if int(np.sum(valid)) >= 4:
                try:
                    result[mask, j] = np.maximum(
                        np.interp(em_wl[mask], em_wl[valid], result[valid, j]), 0.0)
                except Exception:
                    pass
    return result


def _khatri_rao(A, B):
    """Khatri-Rao product: A(m,r), B(n,r) → (m*n, r) where row i*n+j = A[i,r]*B[j,r]."""
    r = A.shape[1]
    return (A[:, np.newaxis, :] * B[np.newaxis, :, :]).reshape(-1, r)


def _parafac_als_one_restart(X, rank, rng, max_iter, tol, X1, X2, X3, X_norm):
    """Run one ALS restart from a random initialisation. Returns (A, B, C, err)."""
    I, J, K = X.shape
    A = rng.random((I, rank)) + 0.1
    B = rng.random((J, rank)) + 0.1
    C = rng.random((K, rank)) + 0.1
    prev_err = np.inf
    err = np.inf
    for __ in range(max_iter):
        kr = _khatri_rao(B, C)
        gram = (B.T @ B) * (C.T @ C) + 1e-10 * np.eye(rank)
        A = np.linalg.solve(gram, (X1 @ kr).T).T
        A = np.maximum(A, 1e-10)

        kr = _khatri_rao(A, C)
        gram = (A.T @ A) * (C.T @ C) + 1e-10 * np.eye(rank)
        B = np.linalg.solve(gram, (X2 @ kr).T).T
        B = np.maximum(B, 1e-10)

        kr = _khatri_rao(A, B)
        gram = (A.T @ A) * (B.T @ B) + 1e-10 * np.eye(rank)
        C = np.linalg.solve(gram, (X3 @ kr).T).T
        C = np.maximum(C, 1e-10)

        X_rec = np.einsum('ir,jr,kr->ijk', A, B, C)
        err = float(np.linalg.norm(X - X_rec)) / float(X_norm)
        if abs(prev_err - err) < tol:
            break
        prev_err = err
    return A, B, C, err


def _parafac_als(X, rank, n_restarts=10, max_iter=500, tol=1e-6):
    """
    Non-negative PARAFAC via Alternating Least Squares.
    X: (n_samples, n_ex, n_em)
    Returns (A, B, C, rel_error):
        A (n_samples, rank) — sample scores
        B (n_ex, rank)      — excitation loadings
        C (n_em, rank)      — emission loadings
    """
    I, J, K = X.shape
    X1 = X.reshape(I, J * K)
    X2 = X.transpose(1, 0, 2).reshape(J, I * K)
    X3 = X.transpose(2, 0, 1).reshape(K, I * J)
    X_norm = np.linalg.norm(X)
    if X_norm == 0:
        raise ValueError('Tensor is all-zero')

    rng = np.random.default_rng(42)
    best_err = np.inf
    best_factors = None

    for _ in range(n_restarts):
        A, B, C, err = _parafac_als_one_restart(X, rank, rng, max_iter, tol, X1, X2, X3, X_norm)
        if err < best_err:
            best_err = err
            best_factors = (A.copy(), B.copy(), C.copy())

    if best_factors is None:
        raise ValueError('PARAFAC failed to converge in any restart.')
    A_out, B_out, C_out = best_factors
    return A_out, B_out, C_out, float(best_err)


def _corcondia(X, A, B, C):
    """
    Core Consistency Diagnostic (Bro & Kiers 2003).
    Uses the pseudoinverse Tucker core: for a perfect trilinear model this equals
    the superidentity tensor, so CC = 100.  Returns value in (-inf, 100].
    """
    rank = A.shape[1]
    Ap = np.linalg.pinv(A)   # (rank, I)
    Bp = np.linalg.pinv(B)   # (rank, J)
    Cp = np.linalg.pinv(C)   # (rank, K)

    # Tucker core G[f,g,h] via pseudoinverse contraction along each mode
    Y     = np.tensordot(X,  Cp.T, axes=([2], [0]))   # (I, J, rank)
    Z     = np.tensordot(Y,  Bp.T, axes=([1], [0]))   # (I, rank_C, rank_B)
    G_raw = np.tensordot(Z,  Ap.T, axes=([0], [0]))   # (rank_C, rank_B, rank_A)
    G     = G_raw.transpose(2, 1, 0)                  # (rank_A, rank_B, rank_C)

    # Superidentity tensor: 1 on super-diagonal, 0 elsewhere
    T = np.zeros_like(G)
    for r in range(rank):
        T[r, r, r] = 1.0

    cc = 100.0 * (1.0 - np.sum((G - T) ** 2) / rank)
    return float(cc)


_PIGM_ALLOWED = {
    'checkbox_chl_only':  {'Chl-PSII', 'Chl-PSI'},
    'checkbox_chl_PC':    {'Chl-PSII', 'Chl-PSI', 'PBS-free (PC)', 'PBS→PSII', 'PBS→PSI'},
    'checkbox_chl_PE':    {'Chl-PSII', 'Chl-PSI', 'PE direct', 'PE→PC', 'PE→PSII', 'PE→PSI'},
    'checkbox_chl_PC_PE': None,   # None = all allowed
}


def _annotate_component(ex_wl, em_wl, ex_loading, em_loading, pigmentation='checkbox_chl_PC_PE', tol=15):
    """Auto-annotate a PARAFAC component based on peak positions and allowed pigmentation."""
    ex_peak = float(ex_wl[np.argmax(ex_loading)])
    em_peak = float(em_wl[np.argmax(em_loading)])
    allowed = _PIGM_ALLOWED.get(pigmentation, None)   # None = all
    best_label, best_d = None, np.inf
    for f in _FLUOROPHORE_TABLE:
        if allowed is not None and f['label'] not in allowed:
            continue
        if abs(ex_peak - f['ex']) <= tol and abs(em_peak - f['em']) <= tol:
            d = np.hypot(ex_peak - f['ex'], em_peak - f['em'])
            if d < best_d:
                best_d, best_label = d, f['label']
    label = best_label or 'Unknown'
    return f'{label} (Ex{ex_peak:.0f}/Em{em_peak:.0f})'


def _build_tensor(maps_dict, crop=None):
    """
    Build 3D numpy tensor from maps dict {fname: {ex_wl, em_wl, intensity}}.
    crop: optional dict {ex_min, ex_max, em_min, em_max} (any value may be None).
    Returns (X, ex_wl, em_wl, sample_names).
    X shape: (n_samples, n_ex, n_em).

    Files with different scan ranges are handled by finding the common
    wavelength intersection and resampling onto the reference (first file) grid.
    """
    names = list(maps_dict.keys())
    if not names:
        raise ValueError('No maps provided')

    # Find the common Ex/Em range across all files (intersection)
    com_ex_min = max(min(maps_dict[n]['ex_wl']) for n in names)
    com_ex_max = min(max(maps_dict[n]['ex_wl']) for n in names)
    com_em_min = max(min(maps_dict[n]['em_wl']) for n in names)
    com_em_max = min(max(maps_dict[n]['em_wl']) for n in names)

    if com_ex_min >= com_ex_max or com_em_min >= com_em_max:
        raise ValueError(
            'The uploaded files have no overlapping Ex/Em wavelength range. '
            'Check that all files cover a common spectral window.')

    # Use first file as the reference grid, clipped to common range
    ref = maps_dict[names[0]]
    ex_wl_ref = np.array(ref['ex_wl'], dtype=float)
    em_wl_ref = np.array(ref['em_wl'], dtype=float)
    ex_wl = ex_wl_ref[(ex_wl_ref >= com_ex_min - 1e-4) & (ex_wl_ref <= com_ex_max + 1e-4)]
    em_wl = em_wl_ref[(em_wl_ref >= com_em_min - 1e-4) & (em_wl_ref <= com_em_max + 1e-4)]

    if len(ex_wl) == 0 or len(em_wl) == 0:
        raise ValueError('No common Ex/Em wavelengths found across all samples.')

    n_s, n_ex, n_em = len(names), len(ex_wl), len(em_wl)
    X = np.zeros((n_s, n_ex, n_em), dtype=float)

    for i, n in enumerate(names):
        m = maps_dict[n]
        ex_s = np.array(m['ex_wl'], dtype=float)
        em_s = np.array(m['em_wl'], dtype=float)
        arr  = np.array(m['intensity'], dtype=float)  # (n_em_s, n_ex_s)

        # Fast path: grid already matches
        if (len(ex_s) == n_ex and len(em_s) == n_em and
                np.allclose(ex_s, ex_wl, atol=0.01) and
                np.allclose(em_s, em_wl, atol=0.01)):
            X[i] = arr.T
        else:
            # Separable bilinear resampling onto common grid:
            # 1) interpolate along Ex axis for every Em row
            tmp = np.zeros((len(em_s), n_ex), dtype=float)
            for j in range(len(em_s)):
                tmp[j] = np.interp(ex_wl, ex_s, arr[j])
            # 2) interpolate along Em axis for every Ex column
            out = np.zeros((n_em, n_ex), dtype=float)
            for j in range(n_ex):
                out[:, j] = np.interp(em_wl, em_s, tmp[:, j])
            X[i] = out.T  # → (n_ex, n_em)

    # Apply Ex/Em crop
    if crop:
        ex_mask = np.ones(n_ex, dtype=bool)
        em_mask = np.ones(n_em, dtype=bool)
        if crop.get('ex_min') is not None:
            ex_mask &= ex_wl >= crop['ex_min']
        if crop.get('ex_max') is not None:
            ex_mask &= ex_wl <= crop['ex_max']
        if crop.get('em_min') is not None:
            em_mask &= em_wl >= crop['em_min']
        if crop.get('em_max') is not None:
            em_mask &= em_wl <= crop['em_max']
        if not np.any(ex_mask) or not np.any(em_mask):
            raise ValueError('Crop range excludes all Ex or Em wavelengths.')
        X     = X[:, ex_mask, :][:, :, em_mask]
        ex_wl = ex_wl[ex_mask]
        em_wl = em_wl[em_mask]

    return X, ex_wl, em_wl, names


# ─── end PARAFAC helpers ───────────────────────────────────────────────────────


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

        if fext not in ('.csv', '.spc', '.txt'):
            result['warnings'].append(f'{fname_raw}: unsupported extension (expected .csv, .txt or .spc), skipped')
            continue

        if fext in ('.csv', '.txt'):
            try:
                if fext == '.txt':
                    ex_wl_arr, em_wl_arr, intensity = parse_aminco_txt(file)
                else:
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


# ─── PARAFAC endpoints ────────────────────────────────────────────────────────

def _scatter_params_from_payload(scatter):
    return (
        float(scatter.get('rayleigh1_width', 0) or 0),
        float(scatter.get('rayleigh2_width', 0) or 0),
        float(scatter.get('raman_width',     0) or 0),
        bool(scatter.get('interpolate', True)),
        bool(scatter.get('diag_mask_enabled', False)),
        float(scatter.get('diag_mask_buffer', 10) or 0),
    )


def _apply_scatter_to_tensor(X, em_wl, ex_wl, r1_w, r2_w, ram_w, do_interp,
                              diag_mask=False, diag_buffer=10.0):
    X_clean = X.copy()
    if r1_w > 0 or r2_w > 0 or ram_w > 0:
        for i in range(X_clean.shape[0]):
            X_clean[i] = _remove_scatter(
                em_wl, ex_wl, X_clean[i].T, r1_w, r2_w, ram_w, do_interp).T
    if diag_mask:
        # Zero all (ex, em) pairs where em <= ex + buffer
        for j, ex in enumerate(ex_wl):
            threshold = ex + diag_buffer
            mask_em = em_wl <= threshold
            X_clean[:, j, mask_em] = 0.0
        if do_interp:
            # Linear interpolation over zeroed diagonal region along emission axis
            for i in range(X_clean.shape[0]):
                for j in range(X_clean.shape[1]):
                    col = X_clean[i, j, :]
                    zeros = col == 0.0
                    if not np.any(zeros) or np.all(zeros):
                        continue
                    valid_idx = np.where(~zeros)[0]
                    zero_idx  = np.where(zeros)[0]
                    col[zero_idx] = np.interp(zero_idx, valid_idx, col[valid_idx])
                    X_clean[i, j, :] = col
    return X_clean


@ex_em_spectra_analysis.route('/api/eem_parafac_diagnostic', methods=['POST'])
def eem_parafac_diagnostic():
    import json as _json
    payload = request.get_json(silent=True) or {}
    maps_dict = payload.get('maps', {})
    f_max = max(2, min(int(payload.get('f_max', 6) or 6), 8))
    r1_w, r2_w, ram_w, do_interp, diag_mask, diag_buf = _scatter_params_from_payload(payload.get('scatter', {}))
    crop = payload.get('crop') or {}

    try:
        X, ex_wl, em_wl, names = _build_tensor(maps_dict, crop or None)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    if len(names) < 3:
        return jsonify({'error': 'At least 3 samples are required for PARAFAC.'}), 400

    X = _apply_scatter_to_tensor(X, em_wl, ex_wl, r1_w, r2_w, ram_w, do_interp, diag_mask, diag_buf)
    f_total = min(f_max, len(names) - 1)

    def generate():
        for f in range(1, f_total + 1):
            try:
                A, B, C, rel_err = _parafac_als(X, f, n_restarts=5, max_iter=300, tol=1e-5)
                X_rec = np.einsum('ir,jr,kr->ijk', A, B, C)
                ss_res = float(np.sum((X - X_rec) ** 2))
                ss_tot = float(np.sum(X ** 2))
                exp_var = round(100.0 * (1.0 - ss_res / (ss_tot + 1e-12)), 1)
                cc = round(_corcondia(X, A, B, C), 1)
                result = {'f': f, 'f_total': f_total,
                          'corcondia': cc, 'explained_variance': exp_var}
            except Exception as e:
                result = {'f': f, 'f_total': f_total,
                          'corcondia': None, 'explained_variance': None, 'error': str(e)}
            yield f"data: {_json.dumps(result)}\n\n"
        yield 'data: {"done": true}\n\n'

    return Response(stream_with_context(generate()), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})


@ex_em_spectra_analysis.route('/api/eem_parafac', methods=['POST'])
def eem_parafac():
    import json as _json
    payload = request.get_json(silent=True) or {}
    maps_dict = payload.get('maps', {})
    rank = max(1, min(int(payload.get('rank', 2) or 2), 8))
    n_restarts = max(1, min(int(payload.get('n_restarts', 10) or 10), 50))
    max_iter = max(100, min(int(payload.get('max_iter', 500) or 500), 2000))
    tol = float(payload.get('tol', 1e-6) or 1e-6)
    pigmentation = payload.get('pigmentation', 'checkbox_chl_PC_PE')
    r1_w, r2_w, ram_w, do_interp, diag_mask, diag_buf = _scatter_params_from_payload(payload.get('scatter', {}))
    crop = payload.get('crop') or {}

    try:
        X, ex_wl, em_wl, names = _build_tensor(maps_dict, crop or None)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400

    if len(names) < rank + 1:
        return jsonify({'error':
            f'Need at least {rank + 1} samples for {rank} components '
            f'(currently {len(names)}).'}), 400

    X_clean = _apply_scatter_to_tensor(X, em_wl, ex_wl, r1_w, r2_w, ram_w, do_interp, diag_mask, diag_buf)

    def generate():
        try:
            I, J, K = X_clean.shape
            X1 = X_clean.reshape(I, J * K)
            X2 = X_clean.transpose(1, 0, 2).reshape(J, I * K)
            X3 = X_clean.transpose(2, 0, 1).reshape(K, I * J)
            X_norm = np.linalg.norm(X_clean)
            if X_norm == 0:
                yield f"data: {_json.dumps({'error': 'Tensor is all-zero after scatter removal. Check scatter settings.'})}\n\n"
                return

            rng = np.random.default_rng(42)
            best_err = np.inf
            best_factors = None

            for restart_i in range(n_restarts):
                try:
                    A, B, C, err = _parafac_als_one_restart(
                        X_clean, rank, rng, max_iter, tol, X1, X2, X3, X_norm)
                except Exception as e:
                    yield f"data: {_json.dumps({'error': 'ALS error: ' + str(e)})}\n\n"
                    return
                if err < best_err:
                    best_err = err
                    best_factors = (A.copy(), B.copy(), C.copy())
                yield f"data: {_json.dumps({'restart': restart_i + 1, 'total': n_restarts, 'err': round(err, 6), 'best_err': round(best_err, 6)})}\n\n"

            if best_factors is None:
                yield f"data: {_json.dumps({'error': 'PARAFAC failed to converge.'})}\n\n"
                return

            A_out, B_out, C_out = best_factors
            X_rec = np.einsum('ir,jr,kr->ijk', A_out, B_out, C_out)
            ss_res = float(np.sum((X_clean - X_rec) ** 2))
            ss_tot = float(np.sum(X_clean ** 2))
            exp_var = round(100.0 * (1.0 - ss_res / (ss_tot + 1e-12)), 1)
            rmse = round(float(np.sqrt(np.mean((X_clean - X_rec) ** 2))), 6)

            ex_loadings, em_loadings, scores, annotations = [], [], [], []
            for r in range(rank):
                b_scale = max(float(np.max(B_out[:, r])), 1e-12)
                c_scale = max(float(np.max(C_out[:, r])), 1e-12)
                ex_loadings.append((B_out[:, r] / b_scale).tolist())
                em_loadings.append((C_out[:, r] / c_scale).tolist())
                scores.append((A_out[:, r] * b_scale * c_scale).tolist())
                annotations.append(_annotate_component(ex_wl, em_wl, B_out[:, r], C_out[:, r], pigmentation))

            scores_by_sample = [[scores[r][i] for r in range(rank)] for i in range(len(names))]

            yield f"data: {_json.dumps({'done': True, 'ex_wl': ex_wl.tolist(), 'em_wl': em_wl.tolist(), 'sample_names': names, 'ex_loadings': ex_loadings, 'em_loadings': em_loadings, 'scores': scores_by_sample, 'scores_by_component': scores, 'explained_variance': exp_var, 'rmse': rmse, 'annotations': annotations, 'n_components': rank})}\n\n"
        except Exception as e:
            import traceback
            yield f"data: {_json.dumps({'error': 'Server error: ' + str(e), 'traceback': traceback.format_exc()})}\n\n"

    return Response(stream_with_context(generate()), mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})
