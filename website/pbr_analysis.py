from flask import Blueprint, render_template, request, jsonify, send_file, current_app
import os, uuid, zipfile, math, io

try:
    from lxml import etree as ET  # type: ignore[import-untyped]
except ImportError:
    import xml.etree.ElementTree as ET

pbr_analysis_bp = Blueprint('pbr_analysis', __name__)

# Session cache: { key: {filepath, device, info, headers, events, all_data, anchors} }
_pbr_cache: dict = {}

# ODF XML namespaces
_NS_TABLE  = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0'
_NS_OFFICE = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0'
_NS_TEXT   = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0'

# Pre-built tag/attribute strings (avoids repeated f-string work per cell)
_TAG_CELL    = f'{{{_NS_TABLE}}}table-cell'
_TAG_COVERED = f'{{{_NS_TABLE}}}covered-table-cell'
_TAG_ROW     = f'{{{_NS_TABLE}}}table-row'
_TAG_TABLE   = f'{{{_NS_TABLE}}}table'
_ATTR_REPEAT = f'{{{_NS_TABLE}}}number-columns-repeated'
_ATTR_TNAME  = f'{{{_NS_TABLE}}}name'
_ATTR_VTYPE  = f'{{{_NS_OFFICE}}}value-type'
_ATTR_FLOAT  = f'{{{_NS_OFFICE}}}value'
_ATTR_DATE   = f'{{{_NS_OFFICE}}}date-value'
_TAG_P       = f'{{{_NS_TEXT}}}p'


# ── ODS parsing ──────────────────────────────────────────────────────────────

def _cell_value(cell):
    """Extract a Python value from an ODF table-cell element."""
    val_type = cell.get(_ATTR_VTYPE)
    if val_type == 'float':
        try:
            return float(cell.get(_ATTR_FLOAT))
        except (TypeError, ValueError):
            return None
    if val_type == 'date':
        return cell.get(_ATTR_DATE)
    # String / untyped: collect text from direct text:p children
    parts = [''.join(p.itertext()) for p in cell.findall(_TAG_P)]
    text = ' '.join(parts).strip()
    return text if text else None


def _parse_row_element(row_el):
    """Parse a single table-row element into a list of values."""
    row = []
    for cell in row_el:
        if cell.tag not in (_TAG_CELL, _TAG_COVERED):
            continue
        repeat = int(cell.get(_ATTR_REPEAT, 1))
        val    = _cell_value(cell)
        if val is None and repeat > 200:
            repeat = 1
        row.extend([val] * repeat)
    while row and row[-1] is None:
        row.pop()
    return row


def parse_ods(filepath):
    """
    Parse an ODS file using streaming iterparse — never loads the full XML DOM.
    Returns {sheet_name: [[cell, ...], ...]}.
    """
    sheets       = {}
    current_name = None
    current_rows = None

    with zipfile.ZipFile(filepath, 'r') as z, z.open('content.xml') as f:
        for event, elem in ET.iterparse(f, events=('start', 'end')):
            if event == 'start':
                if elem.tag == _TAG_TABLE:
                    current_name = elem.get(_ATTR_TNAME, '')
                    current_rows = []
            else:  # 'end'
                if elem.tag == _TAG_ROW and current_rows is not None:
                    current_rows.append(_parse_row_element(elem))
                    elem.clear()
                elif elem.tag == _TAG_TABLE:
                    if current_name is not None:
                        sheets[current_name] = current_rows
                    current_name = None
                    current_rows = None
                    elem.clear()

    return sheets


# ── Metadata helpers ─────────────────────────────────────────────────────────

def detect_device(sheets):
    for sheet_name in ('Devices', 'Info', 'Accessories'):
        for row in sheets.get(sheet_name, []):
            for cell in (row or []):
                if not isinstance(cell, str):
                    continue
                c = cell.upper()
                if 'FMT-150' in c or 'PHOTOBIOREACTOR' in c:
                    return 'FMT-150'
                if 'MC-1000' in c or 'MULTI-CULTIVATOR' in c or 'MULTICULTIVATOR' in c:
                    return 'MC-1000'
    return 'Unknown'


def parse_info(sheets):
    info = {}
    for row in sheets.get('Info', []):
        if row and len(row) >= 2 and row[0] is not None and row[1] is not None:
            info[str(row[0])] = str(row[1])
    return info


def parse_events(sheets):
    rows = sheets.get('Events', [])
    if not rows:
        return []
    events = []
    for row in rows[1:]:  # skip header (id, time, user, message)
        if not row or len(row) < 2:
            continue
        try:
            t = float(row[1]) if row[1] is not None else None
        except (TypeError, ValueError):
            continue
        if t is None:
            continue
        user = str(row[2])[:100] if len(row) > 2 and row[2] else ''
        msg  = str(row[3])[:300] if len(row) > 3 and row[3] else ''
        events.append({'t': round(t, 4), 'user': user, 'msg': msg or user})
    return events


def group_columns(headers):
    """Return {group_name: [col, ...]} for signal-selector UI."""
    groups: dict = {
        'od': [], 'light': [], 'temperature': [],
        'probes': [], 'fluorescence': [], 'pumps': [],
        'turbidostat': [],
    }
    for h in headers:
        if not isinstance(h, str) or h == 'time':
            continue
        hl = h.lower()
        if any(x in hl for x in ('od-720', 'od-680', 'od-delta', 'od-division')):
            groups['od'].append(h)
        elif any(x in hl for x in ('actinic', '.light-')):
            groups['light'].append(h)
        elif 'thermo' in hl:
            groups['temperature'].append(h)
        elif any(x in hl for x in ('probe', '.ph', '.o2', 'co2')):
            groups['probes'].append(h)
        elif 'flm.' in hl:
            groups['fluorescence'].append(h)
        elif any(x in hl for x in ('pump', 'chemostat', 'airpump', 'stirrer', '.valve')):
            groups['pumps'].append(h)
        elif 'turbidostat' in hl:
            groups['turbidostat'].append(h)
        else:
            groups.setdefault('other', []).append(h)
    return {k: v for k, v in groups.items() if v}


# ── Light column helpers ──────────────────────────────────────────────────────

def _build_and_prepare(data_rows, data_start, headers):
    """
    Single pass over raw sheet rows:
      - pads each row to header length
      - forward-fills actinic-light columns
      - records anchor indices (row before + row of each light change)
    Returns (all_data, anchors_set).
    """
    light_idx = [i for i, h in enumerate(headers)
                 if isinstance(h, str) and ('actinic' in h.lower() or '.light-' in h.lower())]
    n_hdr      = len(headers)
    all_data   = []
    light_last = [None] * len(light_idx)
    anchors    = set()

    for raw_row in data_rows[data_start:]:
        if not raw_row or len(raw_row) < 2 or raw_row[0] is None:
            continue
        rlen = len(raw_row)
        row  = list(raw_row[:n_hdr]) if rlen >= n_hdr \
               else list(raw_row) + [None] * (n_hdr - rlen)

        i = len(all_data)
        for k, ci in enumerate(light_idx):
            v = row[ci]
            if v is not None:
                if light_last[k] is not None and v != light_last[k]:
                    if i > 0:
                        anchors.add(i - 1)
                    anchors.add(i)
                light_last[k] = v
            elif light_last[k] is not None:
                row[ci] = light_last[k]

        all_data.append(row)

    return all_data, anchors


def _apply_downsample(all_data, anchors, max_pts):
    """Stride-downsample, always keeping anchor rows. Returns (display_data, stride)."""
    total = len(all_data)
    if max_pts <= 0 or total <= max_pts:
        return all_data, 1
    stride  = max(1, math.ceil(total / max_pts))
    include = set(range(0, total, stride)) | anchors
    return [all_data[i] for i in sorted(include)], stride


# ── OD correction ────────────────────────────────────────────────────────────

def _apply_od_correction(od, device_str, signal_type):
    """Return corrected OD value; same formulas as js_calculators.js."""
    if od is None:
        return None
    try:
        od = float(od)
    except (TypeError, ValueError):
        return None
    if signal_type == 'od-720':
        if od <= 0.4:
            return od
        if device_str == 'FMT-150 WT':
            return 0.23 * math.exp(1.83 * od)
        if device_str == 'FMT-150 EFE':
            return 0.3201 * math.exp(1.6376 * od)
        if device_str == 'MC-1000':
            return 0.029 + 0.143 * math.exp(2.497 * od)
    elif signal_type == 'od-680':
        if od < 0.6:
            return od
        if device_str == 'FMT-150 WT':
            return 0.4228 * math.exp(0.9296 * od)
        if device_str == 'FMT-150 EFE':
            return 0.7622 * math.exp(0.6223 * od)
    return od


# ── Routes ───────────────────────────────────────────────────────────────────

@pbr_analysis_bp.route('/pbr_analysis', methods=['GET'])
def pbr_page():
    return render_template('pbr_analysis.html')


@pbr_analysis_bp.route('/pbr_analysis/parse', methods=['POST'])
def parse_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    f = request.files['file']
    if not f.filename or not f.filename.lower().endswith('.ods'):
        return jsonify({'error': 'Only .ods files are supported'}), 400

    upload_dir = os.path.join(current_app.root_path, 'static', 'uploads')
    os.makedirs(upload_dir, exist_ok=True)
    key = uuid.uuid4().hex[:12]
    filepath = os.path.join(upload_dir, f'pbr_{key}.ods')
    f.save(filepath)

    try:
        sheets = parse_ods(filepath)
    except Exception as e:
        _safe_remove(filepath)
        return jsonify({'error': f'Failed to parse file: {str(e)}'}), 400

    device  = detect_device(sheets)
    info    = parse_info(sheets)
    events  = parse_events(sheets)

    data_rows  = sheets.get('Data', [])
    headers    = None
    data_start = 0
    for i, row in enumerate(data_rows):
        if row and row[0] == 'time':
            headers    = list(row)
            data_start = i + 1
            break

    if not headers:
        _safe_remove(filepath)
        return jsonify({'error': 'Could not find "time" column header in Data sheet'}), 400

    all_data, anchors = _build_and_prepare(data_rows, data_start, headers)

    total_rows = len(all_data)
    if total_rows == 0:
        _safe_remove(filepath)
        return jsonify({'error': 'No data rows found in Data sheet'}), 400

    MAX_DISPLAY          = 0   # 0 = full dataset by default
    display_data, stride = _apply_downsample(all_data, anchors, MAX_DISPLAY)

    display_dicts = [
        {headers[j]: row[j] for j in range(len(headers)) if headers[j]}
        for row in display_data
    ]

    _pbr_cache[key] = {
        'filepath': filepath,
        'device':   device,
        'info':     info,
        'headers':  headers,
        'events':   events,
        'all_data': all_data,
        'anchors':  anchors,
    }

    return jsonify({
        'cache_key':     key,
        'device':        device,
        'info':          info,
        'headers':       [h for h in headers if h],
        'column_groups': group_columns(headers),
        'data':          display_dicts,
        'total_rows':    total_rows,
        'display_rows':  len(display_dicts),
        'stride':        stride,
        'events':        events,
    })


@pbr_analysis_bp.route('/pbr_analysis/data', methods=['POST'])
def get_data():
    """Return display data for a cached file with configurable max rows (0 = all)."""
    body    = request.get_json(force=True)
    key     = body.get('cache_key', '')
    max_pts = int(body.get('max_rows', 3000))

    cached = _pbr_cache.get(key)
    if not cached:
        return jsonify({'error': 'Session expired — please re-upload your file.'}), 404

    all_data = cached.get('all_data')
    anchors  = cached.get('anchors', set())
    headers  = cached['headers']

    if all_data is None:
        return jsonify({'error': 'Session data missing — please re-upload your file.'}), 404

    total_rows           = len(all_data)
    display_data, stride = _apply_downsample(all_data, anchors, max_pts)

    display_dicts = [
        {headers[j]: row[j] for j in range(len(headers)) if headers[j]}
        for row in display_data
    ]
    return jsonify({
        'data':         display_dicts,
        'total_rows':   total_rows,
        'display_rows': len(display_dicts),
        'stride':       stride,
    })


@pbr_analysis_bp.route('/pbr_analysis/export', methods=['POST'])
def export_file():
    body        = request.get_json(force=True)
    key         = body.get('cache_key', '')
    corrections = body.get('corrections', {})

    cached = _pbr_cache.get(key)
    if not cached:
        return jsonify({'error': 'Session expired — please re-upload your file.'}), 404

    headers  = cached['headers']
    all_data = cached.get('all_data')

    if all_data is None:
        return jsonify({'error': 'Session data missing — please re-upload your file.'}), 404

    try:
        import pandas as pd

        valid_cols = [(j, h) for j, h in enumerate(headers) if h]
        col_names  = [h for _, h in valid_cols]
        df = pd.DataFrame(
            [[row[j] for j, _ in valid_cols] for row in all_data],
            columns=col_names,
        )

        for col, corr_info in corrections.items():
            if col not in df.columns:
                continue
            dev = corr_info.get('device', 'FMT-150 WT')
            sig = corr_info.get('signal_type', 'od-720')
            df[col + '_corrected'] = df[col].apply(
                lambda v, d=dev, s=sig: _apply_od_correction(v, d, s)
            )

        out = io.BytesIO()
        with pd.ExcelWriter(out, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name='Data', index=False)
            events = cached.get('events', [])
            if events:
                pd.DataFrame(events).to_excel(writer, sheet_name='Events', index=False)
        out.seek(0)
    except Exception as e:
        return jsonify({'error': f'Export failed: {str(e)}'}), 500

    from datetime import datetime
    fname = f'PBR_{cached["device"]}_{datetime.now().strftime("%Y%m%d_%H%M%S")}.xlsx'
    return send_file(
        out,
        as_attachment=True,
        download_name=fname,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )


def _safe_remove(path):
    try:
        os.remove(path)
    except OSError:
        pass
