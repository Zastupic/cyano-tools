#!/usr/bin/env python3
"""
Download MetaNetX cross-reference TSV files required for KEGG reaction lookup.

Usage (from Flask_server root):
    python website/download_metanetx.py

Output:
    website/metanetx_data/chem_xref.tsv   (~35 MB) — metabolite cross-refs
    website/metanetx_data/reac_xref.tsv   (~3  MB) — reaction cross-refs
    website/metanetx_data/reac_prop.tsv   (~15 MB) — reaction stoichiometry
"""

import os
import sys
import urllib.request

# Try primary URL first, fall back to secondary if unreachable
BASE_URLS = [
    'https://www.metanetx.org/cgi-bin/mnxget/mnxref/',
    'https://ftp.vital-it.ch/databases/metanetx/MNXref/latest/',
]
FILES   = ['chem_xref.tsv', 'reac_xref.tsv', 'reac_prop.tsv']
HEADERS = {'User-Agent': 'CyanoTools/1.0'}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR  = os.path.join(BASE_DIR, 'metanetx_data')


def download_file(filename):
    outpath = os.path.join(OUT_DIR, filename)

    if os.path.exists(outpath):
        size_mb = os.path.getsize(outpath) / 1_048_576
        print(f'  {filename} already exists ({size_mb:.1f} MB) — skipping.')
        return

    last_exc = None
    for base_url in BASE_URLS:
        url = base_url + filename
        print(f'  Downloading {filename} from {base_url} ...', end='', flush=True)
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read()
            with open(outpath, 'wb') as f:
                f.write(data)
            size_mb = len(data) / 1_048_576
            lines   = data.count(b'\n')
            print(f' done ({size_mb:.1f} MB, {lines:,} lines)')
            return   # success
        except Exception as exc:
            print(f' FAILED ({exc})')
            last_exc = exc

    raise RuntimeError(f'All download sources failed for {filename}: {last_exc}')


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f'[metanetx] Checking MetaNetX reference files in: {OUT_DIR}')
    errors = []
    for fn in FILES:
        try:
            download_file(fn)
        except Exception as exc:
            print(f'  ERROR: {exc}')
            errors.append(fn)

    if errors:
        print(f'[metanetx] Download failed for: {errors}')
        print('[metanetx] KEGG reaction lookup will be unavailable until files are present.')
        if __name__ == '__main__':
            sys.exit(1)   # only exit when run directly, not when called from background thread
    else:
        print('[metanetx] All MetaNetX files are present.')


if __name__ == '__main__':
    main()
