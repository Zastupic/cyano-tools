from flask import Blueprint, request, jsonify, current_app
import io, os
from . import safe_cache_key

pixel_size_api = Blueprint('pixel_size_api', __name__)


def _rational_to_float(val) -> float | None:
    """Convert an IFDRational, (num, denom) tuple, or plain number to float."""
    if val is None:
        return None
    if hasattr(val, 'numerator') and hasattr(val, 'denominator'):
        denom = val.denominator
        return float(val.numerator) / float(denom) if denom else None
    if isinstance(val, tuple) and len(val) == 2:
        num, denom = val
        return float(num) / float(denom) if denom else None
    try:
        return float(val)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _nm_per_pixel(res_val, res_unit: int) -> float | None:
    """Convert resolution (pixels/unit) to nm/pixel. res_unit: 2=inch, 3=cm."""
    if res_val is None or res_val <= 0:
        return None
    if res_unit == 3:
        return 1e7 / res_val   # px/cm → nm/px
    return 25.4e6 / res_val    # px/inch → nm/px (default)


@pixel_size_api.route('/api/pixel_size', methods=['POST'])
def detect_pixel_size():
    """
    Try to extract pixel size from TIFF resolution tags or JPEG EXIF data.
    Accepts: multipart/form-data with 'image' file field.
    Returns: JSON {'pixel_size_nm': float, 'source': str} or {'error': str}
    """
    f = request.files.get('image')
    _raw_key   = request.form.get('cached_image_key', '').strip()
    cached_key: str = (safe_cache_key(_raw_key) or '') if _raw_key else ''

    if f is None and not cached_key:
        if _raw_key and not cached_key:
            return jsonify({'error': 'Invalid image reference. Upload the image again.'}), 400
        return jsonify({'error': 'No image provided'}), 400

    try:
        from PIL import Image
        from . import UPLOAD_FOLDER

        if f is not None:
            img_bytes = f.read()
        else:
            cache_path = os.path.join(UPLOAD_FOLDER, cached_key)
            if not os.path.exists(cache_path):
                return jsonify({'error': 'Cached image not found. Upload the image again.'}), 200
            with open(cache_path, 'rb') as _cf:
                img_bytes = _cf.read()

        img = Image.open(io.BytesIO(img_bytes))
        pixel_size_nm: float | None = None
        source: str | None = None

        # ── TIFF resolution tags (most reliable for scientific microscopy) ────
        tag_v2 = getattr(img, 'tag_v2', None)
        if tag_v2 is not None:
            try:
                x_res    = tag_v2.get(282)           # XResolution
                res_unit = int(tag_v2.get(296, 2))   # ResolutionUnit
                px = _nm_per_pixel(_rational_to_float(x_res), res_unit)
                if px is not None:
                    pixel_size_nm = px
                    source = 'TIFF resolution tags'
            except Exception:
                pass

        # ── JPEG / other EXIF tags ────────────────────────────────────────────
        if pixel_size_nm is None:
            try:
                _getexif = getattr(img, '_getexif', None)
                exif = _getexif() if callable(_getexif) else None
                if isinstance(exif, dict):
                    x_res_raw = exif.get(282)
                    res_unit  = int(exif.get(296, 2))
                    px = _nm_per_pixel(_rational_to_float(x_res_raw), res_unit)
                    if px is not None:
                        pixel_size_nm = px
                        source = 'EXIF resolution tags'
            except Exception:
                pass

        if pixel_size_nm is None:
            return jsonify({'error': 'No resolution metadata found in image. Enter pixel size manually.'}), 200

        # Sanity check: 1 nm to 50 µm per pixel
        if not (1 <= pixel_size_nm <= 50000):
            return jsonify({
                'error': f'Detected pixel size ({pixel_size_nm:.1f} nm) is outside expected range (1–50 000 nm). Enter manually.'
            }), 200

        return jsonify({'pixel_size_nm': round(pixel_size_nm, 2), 'source': source})

    except Exception:
        current_app.logger.exception('pixel_size detection failed')
        return jsonify({'error': 'An internal error occurred. Please try again.'}), 500
