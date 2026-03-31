"""
MetaNetX-based KEGG reaction lookup for iRH783 heterologous pathway engineering.

Parses three MetaNetX TSV files (downloaded by download_metanetx.py) into
in-memory lookup dicts on first use.  Exposes one public function:

    lookup_kegg_reaction(kegg_rxn_id, model_bigg_bases)
        -> dict with keys: found, stoich, new_mets, unknown_mets, warnings

The files are parsed lazily (on first call) and cached for the lifetime of the
Flask process.  Parsing takes ~3-8 s on first call; subsequent calls are instant.
"""

import os
import threading

_MNX_DIR  = os.path.join(os.path.dirname(__file__), 'metanetx_data')
_REQUIRED = ['chem_xref.tsv', 'reac_xref.tsv', 'reac_prop.tsv']

# ── Module-level caches ────────────────────────────────────────────────────────
_kegg_cpd_to_bigg:   dict = {}   # 'C00026'    → 'akg'
_mnx_met_to_bigg:    dict = {}   # 'MNXM145'   → 'akg'
_mnx_to_kegg_cpd:    dict = {}   # 'MNXM740127'→ 'C06547'   (reverse of kegg→mnx, for unknowns)
_kegg_rxn_to_stoich: dict = {}   # 'R09415'    → [{'mnx_id': 'MNXM145', 'coeff': -1.0}, ...]

_loaded        = False
_files_missing = False
_load_lock     = threading.Lock()

# Download state — set by __init__.py background thread
# Values: 'idle' | 'downloading' | 'ready' | 'failed'
_download_state = 'idle'


def set_download_state(state: str):
    global _download_state
    _download_state = state


def get_download_state() -> str:
    return _download_state


# ── Loading ────────────────────────────────────────────────────────────────────

def _ensure_loaded():
    global _loaded, _files_missing
    if _loaded or _files_missing:
        return
    with _load_lock:
        if _loaded or _files_missing:
            return

        # Check files exist
        missing = [f for f in _REQUIRED
                   if not os.path.exists(os.path.join(_MNX_DIR, f))]
        if missing:
            print(f'[metanetx] Missing files: {missing}. '
                  'Run website/download_metanetx.py to download them.')
            _files_missing = True
            return

        print('[metanetx] Loading MetaNetX TSV files...', flush=True)
        _parse_chem_xref(os.path.join(_MNX_DIR, 'chem_xref.tsv'))
        _parse_reactions(os.path.join(_MNX_DIR, 'reac_xref.tsv'),
                         os.path.join(_MNX_DIR, 'reac_prop.tsv'))
        print(f'[metanetx] Loaded: {len(_kegg_cpd_to_bigg):,} KEGG compounds mapped, '
              f'{len(_kegg_rxn_to_stoich):,} KEGG reactions indexed.')
        _loaded = True


def _parse_chem_xref(path):
    """Build _kegg_cpd_to_bigg and _mnx_met_to_bigg from chem_xref.tsv."""
    kegg_to_mnx: dict = {}   # temporary: 'C00026' → 'MNXM145'

    with open(path, encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('#') or not line.strip():
                continue
            cols = line.rstrip('\n').split('\t')
            if len(cols) < 2:
                continue
            source = cols[0]
            mnx_id = cols[1]

            if source.startswith('kegg.compound:'):
                cid = source[len('kegg.compound:'):]
                if cid not in kegg_to_mnx:   # keep first mapping
                    kegg_to_mnx[cid] = mnx_id

            elif source.startswith('bigg.metabolite:'):
                bid = source[len('bigg.metabolite:'):]
                if mnx_id not in _mnx_met_to_bigg:  # keep first mapping
                    _mnx_met_to_bigg[mnx_id] = bid

    # Join: KEGG → MNX → BiGG; also build MNX → KEGG reverse for unknown-met reporting
    for cid, mnx_id in kegg_to_mnx.items():
        if mnx_id not in _mnx_to_kegg_cpd:
            _mnx_to_kegg_cpd[mnx_id] = cid
        bigg = _mnx_met_to_bigg.get(mnx_id)
        if bigg:
            _kegg_cpd_to_bigg[cid] = bigg


def _parse_stoich_string(stoich_str):
    """
    Parse a MetaNetX stoichiometry string into a list of (mnx_id, coeff) tuples.

    Format example:
        '1 MNXM1@BOUNDARY + 1 MNXM145@MNXC3 = 1 MNXM89557@MNXC3 + 3 MNXM13@MNXC3'
    Reactants get negative coefficients; products get positive.
    Metabolites at BOUNDARY are mass-balance placeholders — skip them.
    """
    result = []
    if '=' not in stoich_str:
        return result
    left, right = stoich_str.split('=', 1)

    def _parse_side(side_str, sign):
        for token in side_str.split('+'):
            token = token.strip()
            if not token:
                continue
            parts = token.split()
            if len(parts) != 2:
                continue
            try:
                coeff = float(parts[0])
            except ValueError:
                continue
            met_part = parts[1]
            if '@BOUNDARY' in met_part:
                continue
            mnx_id = met_part.split('@')[0]
            result.append({'mnx_id': mnx_id, 'coeff': sign * coeff})

    _parse_side(left,  -1.0)
    _parse_side(right, +1.0)
    return result


def _parse_reactions(xref_path, prop_path):
    """Build _kegg_rxn_to_stoich from reac_xref.tsv + reac_prop.tsv."""
    # Step 1: KEGG R-number → MNX reaction ID
    kegg_to_mnx_rxn: dict = {}
    with open(xref_path, encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('#') or not line.strip():
                continue
            cols = line.rstrip('\n').split('\t')
            if len(cols) < 2:
                continue
            source = cols[0]
            mnx_id = cols[1]
            if source.startswith('kegg.reaction:'):
                rid = source[len('kegg.reaction:'):]
                if rid not in kegg_to_mnx_rxn:
                    kegg_to_mnx_rxn[rid] = mnx_id

    # Step 2: MNX reaction ID → stoichiometry string (col index 6 in reac_prop)
    # reac_prop.tsv columns: ID | mnx_equation | reference | ... | is_balanced | ...
    # The equation column index can vary by MNXref version — find it by header.
    mnx_to_stoich: dict = {}
    eq_col = 1   # default: column 1 is the equation
    with open(prop_path, encoding='utf-8') as fh:
        for line in fh:
            if line.startswith('#'):
                # Parse header to find equation column
                if 'mnx_equation' in line or 'equation' in line.lower():
                    headers = line.lstrip('#').rstrip('\n').split('\t')
                    for i, h in enumerate(headers):
                        if 'equation' in h.lower():
                            eq_col = i
                            break
                continue
            if not line.strip():
                continue
            cols = line.rstrip('\n').split('\t')
            if len(cols) <= eq_col:
                continue
            mnx_id   = cols[0]
            equation = cols[eq_col]
            if equation and equation != 'NA':
                mnx_to_stoich[mnx_id] = equation

    # Step 3: Join KEGG → MNX → stoich list
    for rid, mnx_id in kegg_to_mnx_rxn.items():
        eq = mnx_to_stoich.get(mnx_id)
        if eq:
            parsed = _parse_stoich_string(eq)
            if parsed:
                _kegg_rxn_to_stoich[rid] = parsed


# ── Public API ─────────────────────────────────────────────────────────────────

def files_available() -> bool:
    """Return True if MetaNetX data files are present on disk."""
    return all(os.path.exists(os.path.join(_MNX_DIR, f)) for f in _REQUIRED)


def get_model_bigg_base_ids(model) -> set:
    """
    Extract the set of BiGG base IDs (without compartment suffix) from a
    COBRApy model.  iRH783 uses the convention  akg_c, akg_e  etc., so we
    split on the last underscore.
    """
    bases = set()
    for met in model.metabolites:
        parts = met.id.rsplit('_', 1)
        if len(parts) == 2:
            bases.add(parts[0])
    return bases


def lookup_kegg_reaction(kegg_rxn_id: str, model_bigg_bases: set) -> dict:
    """
    Look up a KEGG reaction ID and return stoichiometry in iRH783 BiGG format.

    Parameters
    ----------
    kegg_rxn_id     : str   — e.g. 'R09415' (already uppercased by caller)
    model_bigg_bases: set   — BiGG base IDs present in the iRH783 model

    Returns
    -------
    dict with keys:
        found        : bool
        error        : str   (only when found=False)
        stoich       : dict  met_id_with_compartment → coefficient
        new_mets     : dict  met_id_with_compartment → {'name': '', 'formula': ''}
        unknown_mets : list  KEGG/MNX IDs with no BiGG mapping
        warnings     : list  human-readable notes
    """
    _ensure_loaded()

    if _files_missing:
        return {'found': False,
                'error': 'MetaNetX data files not found on server. '
                         'Run website/download_metanetx.py to download them.'}

    raw_stoich = _kegg_rxn_to_stoich.get(kegg_rxn_id)
    if raw_stoich is None:
        return {'found': False,
                'error': f'Reaction {kegg_rxn_id} not found in MetaNetX. '
                         'Check the KEGG reaction ID or enter stoichiometry manually.'}

    stoich: dict    = {}
    new_mets: dict  = {}
    unknown: list   = []
    warnings: list  = []

    for entry in raw_stoich:
        mnx_id = entry['mnx_id']
        coeff  = entry['coeff']

        bigg_base = _mnx_met_to_bigg.get(mnx_id)
        if not bigg_base:
            unknown.append({
                'mnx_id':   mnx_id,
                'kegg_cpd': _mnx_to_kegg_cpd.get(mnx_id, ''),
                'coeff':    coeff,
            })
            continue

        # Prefer cytoplasm; fall back to extracellular if only _e exists in model
        if bigg_base in model_bigg_bases:
            met_id = bigg_base + '_c'
        elif (bigg_base + 'e') in model_bigg_bases or bigg_base + '_e' in {
                m + '_e' for m in model_bigg_bases}:
            met_id = bigg_base + '_e'
            warnings.append(f'{bigg_base} not found in cytoplasm — using {met_id}')
        else:
            # New metabolite not in model at all
            met_id = bigg_base + '_c'
            new_mets[met_id] = {'name': '', 'formula': ''}

        stoich[met_id] = coeff

    return {
        'found':        True,
        'stoich':       stoich,
        'new_mets':     new_mets,
        'unknown_mets': unknown,
        'warnings':     warnings,
    }
