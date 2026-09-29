"""
Parser for Hansatech Handy PEA .HAN binary files.

The format is binary, little-endian and undocumented.  Layout was
reverse-engineered from example files produced by Handy PEA software v1.31.

File = 26-byte file header + N × 437-byte records, back to back.

Pure Python module — no Flask dependencies.
"""

import struct

MAGIC = b"\x04PE30"          # first 5 bytes of every .HAN file
HEADER_SIZE = 26
RECORD_SIZE = 437
MAX_POINTS = 192
FILL_VALUE = 0x7FFF          # unused trace slots are filled with this

# Expected time-mark µs values (sanity check against file header indices)
_EXPECTED_MARKS_US = (50, 100, 300, 2000, 30000)


def handy_pea_timebase_us(n):
    """Reconstruct the Handy PEA time axis (µs) for *n* data points.

    The Handy PEA uses a fixed sampling scheme:
    - 30 points at 10 µs intervals: 10, 20, … 300 µs
    - Then logarithmic decades: step doubles at each factor-of-30 boundary
      (300 → 3 000 → 30 000 → 300 000 → 3 000 000 → 30 000 000 µs).

    N=118 → 1 s, N=140 → 5 s, N=192 → 300 s.
    """
    t = list(range(10, 301, 10))          # 30 points, 10 µs steps
    step, last = 100, 300
    while len(t) < n:
        last += step
        t.append(last)
        if last == 30 * step:             # decade boundary
            step *= 10
    return t[:n]


class HanParseError(Exception):
    """Raised when a .HAN file fails validation."""


def parse_han(data):
    """Parse raw bytes of a .HAN file.

    Parameters
    ----------
    data : bytes
        Complete file contents (``open(path, 'rb').read()``).

    Returns
    -------
    dict
        ``{'time_us': list[int], 'records': list[dict], 'warnings': list[str],
           'n_points': int}``

        Each record dict contains:
        ``{'pos', 'rec_no', 'n_points', 'label', 'light', 'inst_fo', 'inst_fm',
           'timestamp', 'values'}``

    Raises
    ------
    HanParseError
        On magic mismatch, incorrect file size, or per-record validation failure.
    """
    # ── magic check ─────────────────────────────────────────────────────
    if len(data) < HEADER_SIZE:
        raise HanParseError(
            f'File too small ({len(data)} bytes); expected at least {HEADER_SIZE}.')
    if data[:5] != MAGIC:
        raise HanParseError(
            'Not a Handy PEA .HAN file (magic bytes mismatch).')

    # ── file size → number of records ───────────────────────────────────
    payload = len(data) - HEADER_SIZE
    if payload % RECORD_SIZE != 0:
        raise HanParseError(
            f'Invalid .HAN file: (filesize − {HEADER_SIZE}) = {payload} '
            f'is not divisible by record size {RECORD_SIZE}.')
    n_records = payload // RECORD_SIZE
    if n_records == 0:
        raise HanParseError('File contains no records.')

    # ── file header: time-mark indices (1-based point numbers) ──────────
    mark_indices = struct.unpack_from('<5i', data, 6)

    # ── parse records ───────────────────────────────────────────────────
    records = []
    warnings = []
    seen_traces = {}          # hash → first position index (for dedup)
    common_n = None           # track whether all records share the same N

    for i in range(n_records):
        off = HEADER_SIZE + i * RECORD_SIZE

        # metadata
        _wd, day, mon, yr = struct.unpack_from('<4B', data, off)
        sec, minute, hour = struct.unpack_from('<3B', data, off + 4)
        rec_no = struct.unpack_from('<H', data, off + 19)[0]
        n_pts  = struct.unpack_from('<H', data, off + 21)[0]
        label  = data[off + 23: off + 29].decode('ascii', errors='replace').strip()
        light  = struct.unpack_from('<H', data, off + 33)[0]
        inst_fo = struct.unpack_from('<H', data, off + 35)[0]
        inst_fm = struct.unpack_from('<H', data, off + 37)[0]

        # validate N_points
        if n_pts == 0 or n_pts > MAX_POINTS:
            raise HanParseError(
                f'Record {i}: invalid N_points={n_pts} (must be 1..{MAX_POINTS}).')

        # fluorescence trace (u16 × n_pts)
        trace = struct.unpack_from(f'<{n_pts}H', data, off + 53)

        # validate: no fill values inside the valid range
        for j, v in enumerate(trace):
            if v == FILL_VALUE:
                raise HanParseError(
                    f'Record {i}: fill value 0x7FFF at point {j} '
                    f'(inside first {n_pts} values).')

        # duplicate detection (byte-identical traces) — tag, don't drop
        trace_key = trace          # tuples are hashable
        dup_of = None
        if trace_key in seen_traces:
            dup_of = seen_traces[trace_key]
            warnings.append(
                f'Duplicate trace: pos {i} is identical to pos {dup_of}')
        else:
            seen_traces[trace_key] = i

        # timestamp string
        year_full = 2000 + yr
        timestamp = f'{year_full:04d}-{mon:02d}-{day:02d} {hour:02d}:{minute:02d}:{sec:02d}'

        records.append({
            'pos':       i,
            'rec_no':    rec_no,
            'n_points':  n_pts,
            'label':     label,
            'light':     light,
            'inst_fo':   inst_fo,
            'inst_fm':   inst_fm,
            'timestamp': timestamp,
            'values':    list(trace),
            'duplicate_of': dup_of,
        })

        if common_n is None:
            common_n = n_pts
        elif n_pts != common_n:
            common_n = -1         # mixed N → flag for outer-join merge

    # ── build time axis ─────────────────────────────────────────────────
    # Use the first record's N_points (all should match for a well-behaved file)
    ref_n = records[0]['n_points']
    time_us = handy_pea_timebase_us(ref_n)

    # sanity-check time marks against the file header
    for idx_1based, expected_us in zip(mark_indices, _EXPECTED_MARKS_US):
        if 1 <= idx_1based <= len(time_us):
            actual_us = time_us[idx_1based - 1]
            if actual_us != expected_us:
                warnings.append(
                    f'Time-mark index {idx_1based} maps to {actual_us} µs, '
                    f'expected {expected_us} µs.')

    return {
        'time_us':   time_us,
        'records':   records,
        'warnings':  warnings,
        'n_points':  ref_n,
    }
