#!/usr/bin/env python3
"""
Download KEGG pathway PNG images and conf (coordinate) files for Synechocystis
sp. PCC 6803, parse conf into JSON for the interactive overlay.

Usage (from Flask_server root):
    python website/download_kegg_maps.py

Output:
    website/static/kegg_maps/<pathway_id>.png        — pathway image
    website/static/kegg_maps/<pathway_id>_conf.json  — parsed hotspot data
"""

import json
import os
import re
import time
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE_DIR, 'static', 'kegg_maps')

# Skip global overview maps (huge images, not useful as individual pathway views)
SKIP_PATHWAYS = {'syn01100', 'syn01110', 'syn01120', 'syn01200', 'syn01210',
                 'syn01212', 'syn01230', 'syn01232', 'syn01240', 'syn01250'}


def fetch_all_synechocystis_pathways():
    """Fetch the full list of Synechocystis pathways from KEGG REST API."""
    print('Fetching pathway list from KEGG...')
    url = 'https://rest.kegg.jp/list/pathway/syn'
    text = fetch_bytes(url).decode('utf-8')
    pathways = []
    for line in text.strip().splitlines():
        parts = line.split('\t')
        if len(parts) >= 2:
            pid = parts[0].replace('path:', '')
            name = parts[1].replace(' - Synechocystis sp. PCC 6803', '').strip()
            if pid not in SKIP_PATHWAYS:
                pathways.append((pid, name))
    print(f'  Found {len(pathways)} pathways (skipped {len(SKIP_PATHWAYS)} overview maps)')
    time.sleep(0.4)
    return pathways

HEADERS = {'User-Agent': 'CyanoTools/1.0'}


def fetch_bytes(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def parse_conf(text):
    """Parse KEGG conf file into structured JSON.

    Returns list of hotspot dicts:
      {type: 'circ'|'rect', coords: {...}, url: str, id: str, label: str,
       entry_type: 'compound'|'gene'|'pathway'}
    """
    hotspots = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue

        # circ (737,241) 4	/dbget-bin/www_bget?C00022	C00022 (Pyruvate)
        m = re.match(
            r'circ\s+\((\d+),(\d+)\)\s+(\d+)\s+'
            r'(/\S+)\s+'
            r'(\S+)\s*(.*)',
            line
        )
        if m:
            x, y, r = int(m.group(1)), int(m.group(2)), int(m.group(3))
            url, kid, label = m.group(4), m.group(5), m.group(6).strip()
            # Remove surrounding parentheses from label
            if label.startswith('(') and label.endswith(')'):
                label = label[1:-1]
            hotspots.append({
                'type': 'circ',
                'cx': x, 'cy': y, 'r': r,
                'url': url,
                'id': kid,
                'label': label or kid,
                'entry_type': 'compound',
            })
            continue

        # rect (444,614) (490,631)	/dbget-bin/www_bget?syn:slr1096	slr1096 (phdD)
        m = re.match(
            r'rect\s+\((\d+),(\d+)\)\s+\((\d+),(\d+)\)\s+'
            r'(/\S+)\s+'
            r'(.*)',
            line
        )
        if m:
            x1, y1 = int(m.group(1)), int(m.group(2))
            x2, y2 = int(m.group(3)), int(m.group(4))
            url = m.group(5)
            rest = m.group(6).strip()

            # Determine entry type
            if re.match(r'syn\d{5}', rest):
                entry_type = 'pathway'
                kid = rest.split(':')[0].split()[0]
                label = rest
            else:
                entry_type = 'gene'
                # Could be "slr1289 (icd)" or "sll0823 (sdhB), slr0090 (sdhA)"
                kid = rest.split()[0] if rest else ''
                label = rest

            hotspots.append({
                'type': 'rect',
                'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2,
                'url': url,
                'id': kid,
                'label': label or kid,
                'entry_type': entry_type,
            })
            continue

    return hotspots


def fetch_gene_definitions(loci):
    """Fetch gene definitions (product names) from KEGG for a list of loci.

    Uses the KEGG REST API: /get/syn:slr1289+syn:sll1023+...
    Returns {locus: definition_string}.
    """
    if not loci:
        return {}
    result = {}
    # KEGG allows up to 10 IDs per request
    batch_size = 10
    for i in range(0, len(loci), batch_size):
        batch = loci[i:i + batch_size]
        ids = '+'.join(f'syn:{loc}' for loc in batch)
        try:
            text = fetch_bytes(f'https://rest.kegg.jp/get/{ids}').decode('utf-8')
            current_locus = None
            for line in text.splitlines():
                if line.startswith('ENTRY'):
                    # ENTRY       slr1289           CDS       T00004
                    parts = line.split()
                    if len(parts) >= 2:
                        current_locus = parts[1]
                elif line.startswith('NAME') and current_locus:
                    # NAME        (GenBank) isocitrate dehydrogenase (NADP+)
                    defn = line[12:].strip()
                    # Strip "(GenBank) " prefix if present
                    defn = re.sub(r'^\(GenBank\)\s*', '', defn)
                    result[current_locus] = defn
                elif line.startswith('///'):
                    current_locus = None
            time.sleep(0.35)
        except Exception as e:
            print(f'    WARN: gene fetch failed for batch: {e}')
    return result


def annotate_gene_hotspots(hotspots):
    """Add protein_name field to gene hotspots by fetching from KEGG."""
    # Collect all unique loci from gene hotspots
    all_loci = set()
    for hs in hotspots:
        if hs['entry_type'] == 'gene':
            loci = re.findall(r'(s[lr][rl]\d+)', hs['label'])
            all_loci.update(loci)

    if not all_loci:
        return

    print(f'  Fetching {len(all_loci)} gene definitions from KEGG...')
    gene_defs = fetch_gene_definitions(sorted(all_loci))
    print(f'  Got {len(gene_defs)} definitions')

    # Annotate hotspots
    for hs in hotspots:
        if hs['entry_type'] == 'gene':
            loci = re.findall(r'(s[lr][rl]\d+)', hs['label'])
            genes = []
            for loc in loci:
                genes.append({
                    'locus': loc,
                    'product': gene_defs.get(loc, ''),
                })
            hs['genes'] = genes


def crop_border(png_path):
    """Crop 1px black border from KEGG PNG image."""
    try:
        from PIL import Image
        img = Image.open(png_path)
        w, h = img.size
        if w > 2 and h > 2:
            cropped = img.crop((1, 1, w - 1, h - 1))
            cropped.save(png_path)
    except ImportError:
        pass  # PIL not available, skip cropping


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # Fetch full pathway list from KEGG
    pathways = fetch_all_synechocystis_pathways()

    manifest = {}  # pid -> name, saved as manifest.json for the web app
    total = len(pathways)

    for idx, (pid, pname) in enumerate(pathways, 1):
        print(f'\n[{idx}/{total}] {pid}: {pname}')

        # Download PNG
        png_path = os.path.join(OUT_DIR, f'{pid}.png')
        if os.path.isfile(png_path):
            print(f'  PNG exists, skipping')
        else:
            try:
                print(f'  Fetching image...')
                data = fetch_bytes(f'https://rest.kegg.jp/get/{pid}/image')
                with open(png_path, 'wb') as f:
                    f.write(data)
                crop_border(png_path)
                print(f'  Saved {len(data)/1024:.1f} KB')
                time.sleep(0.4)
            except Exception as e:
                print(f'  ERROR fetching image: {e}')
                continue

        # Download and parse conf
        conf_path = os.path.join(OUT_DIR, f'{pid}_conf.json')
        if os.path.isfile(conf_path):
            print(f'  Conf exists, skipping')
            manifest[pid] = pname
        else:
            try:
                print(f'  Fetching conf...')
                conf_text = fetch_bytes(
                    f'https://rest.kegg.jp/get/{pid}/conf'
                ).decode('utf-8')
                hotspots = parse_conf(conf_text)
                annotate_gene_hotspots(hotspots)

                # Adjust coordinates for 1px border crop
                for hs in hotspots:
                    if hs['type'] == 'circ':
                        hs['cx'] -= 1
                        hs['cy'] -= 1
                    elif hs['type'] == 'rect':
                        hs['x1'] -= 1
                        hs['y1'] -= 1
                        hs['x2'] -= 1
                        hs['y2'] -= 1

                with open(conf_path, 'w', encoding='utf-8') as f:
                    json.dump(hotspots, f, indent=1)
                n_circ = sum(1 for h in hotspots if h['type'] == 'circ')
                n_rect = sum(1 for h in hotspots if h['type'] == 'rect')
                print(f'  {len(hotspots)} hotspots ({n_circ} compounds, {n_rect} genes/pathways)')
                manifest[pid] = pname
                time.sleep(0.4)
            except Exception as e:
                print(f'  ERROR fetching conf: {e}')

    # Save manifest for the web app
    manifest_path = os.path.join(OUT_DIR, 'manifest.json')
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
    print(f'\nManifest: {len(manifest)} pathways -> {manifest_path}')
    print(f'Done. Files in {OUT_DIR}')


if __name__ == '__main__':
    main()
