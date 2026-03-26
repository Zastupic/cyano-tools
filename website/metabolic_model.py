import os
import json
import threading
import urllib.request
import urllib.parse
from flask import Blueprint, render_template, jsonify, request

# ── External gene annotation cache ───────────────────────────────────────────
# Populated in a background thread on first /api/metabolic/genes request.
# Structure: { locus_tag: { 'product': str, 'gene_name': str,
#                            'uniprot_id': str, 'function': str,
#                            'go_terms': [str], 'ec': str } }
_EXT_ANNOTATIONS: dict = {}
_EXT_ANN_LOCK    = threading.Lock()
_EXT_ANN_LOADED  = False
_EXT_ANN_THREAD  = None   # background loader thread


def _start_annotation_loading(locus_uniprot_map):
    """Start background thread to fetch annotations (no-op if already running/done)."""
    global _EXT_ANN_THREAD
    with _EXT_ANN_LOCK:
        if _EXT_ANN_LOADED:
            return
        if _EXT_ANN_THREAD and _EXT_ANN_THREAD.is_alive():
            return
        t = threading.Thread(
            target=_run_annotation_loader,
            args=(locus_uniprot_map,),
            daemon=True,
        )
        _EXT_ANN_THREAD = t
        t.start()


def _run_annotation_loader(locus_uniprot_map):
    """Background thread: fetch KEGG gene names then UniProt protein data."""
    global _EXT_ANN_LOADED
    print('[metabolic] Annotation loading started (background)')
    _fetch_kegg_gene_list()
    _fetch_uniprot_by_accessions(locus_uniprot_map)
    _EXT_ANN_LOADED = True
    print(f'[metabolic] Annotation loading done — {len(_EXT_ANNOTATIONS)} entries')


def _fetch_kegg_gene_list():
    """Single request to KEGG REST: GET /list/syn  →  all Synechocystis gene names.
    Actual format (4 tab-separated columns):
        syn:sll1212\tCDS\tcomplement(5534..6622)\trfbD; GDP-D-mannose dehydratase
        syn:slr0612\tCDS\t937..1494\thypothetical protein
    Description is in parts[3]; gene symbol (if any) precedes ';'.
    """
    try:
        url = 'https://rest.kegg.jp/list/syn'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=20) as resp:
            text = resp.read().decode('utf-8')
        for line in text.splitlines():
            parts = line.strip().split('\t')
            if len(parts) < 4:
                continue
            locus = parts[0].replace('syn:', '').strip()
            desc  = parts[3].strip()   # gene_symbol; product  OR just product
            if ';' in desc:
                gene_sym, product = desc.split(';', 1)
                gene_sym = gene_sym.split(',')[0].strip()
                product  = product.strip()
            else:
                gene_sym = ''
                product  = desc
            # Skip generic descriptions
            if product.lower() in ('hypothetical protein', 'unknown protein', 'cds', ''):
                product = ''
            entry = _EXT_ANNOTATIONS.setdefault(locus, {})
            if not entry.get('gene_name') and gene_sym:
                entry['gene_name'] = gene_sym
            if not entry.get('product') and product:
                entry['product']   = product
    except Exception as exc:
        print(f'[metabolic] KEGG gene list fetch failed: {exc}')


def _fetch_uniprot_by_accessions(locus_uniprot_map):
    """Fetch UniProt entries by exact accession IDs from the model.
    locus_uniprot_map: {locus_tag: uniprot_accession}
    Queries in chunks of 100 to avoid URL length limits.
    """
    uniprot_to_locus = {v: k for k, v in locus_uniprot_map.items() if v}
    accessions = list(uniprot_to_locus.keys())
    if not accessions:
        return
    fields = 'gene_names,protein_name,cc_function,go_id,ec'
    CHUNK  = 100
    for i in range(0, len(accessions), CHUNK):
        chunk = accessions[i:i + CHUNK]
        query = ' OR '.join(f'accession:{a}' for a in chunk)
        url   = (f'https://rest.uniprot.org/uniprotkb/search'
                 f'?query={urllib.parse.quote(query)}&format=json'
                 f'&fields={fields}&size={CHUNK}')
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'Mozilla/5.0',
                'Accept':     'application/json',
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
        except Exception as exc:
            print(f'[metabolic] UniProt batch fetch failed (chunk {i}): {exc}')
            continue

        for entry in data.get('results', []):
            uid   = entry.get('primaryAccession', '')
            locus = uniprot_to_locus.get(uid, '')
            if not locus:
                continue

            prot_obj  = entry.get('proteinDescription', {})
            rec_name  = prot_obj.get('recommendedName', {})
            full_name = (rec_name.get('fullName', {}).get('value', '')
                         or next((s.get('fullName', {}).get('value', '')
                                  for s in prot_obj.get('submittedNames', [])), ''))

            func_text = ''
            for cmnt in entry.get('comments', []):
                if cmnt.get('commentType') == 'FUNCTION':
                    for txt in cmnt.get('texts', []):
                        func_text = txt.get('value', '')[:300]
                        break
                if func_text:
                    break

            go_terms = [x['id'] for x in entry.get('uniProtKBCrossReferences', [])
                        if x.get('database') == 'GO']
            ec = rec_name.get('ecNumbers', [{}])[0].get('value', '') if rec_name else ''

            entry_data = _EXT_ANNOTATIONS.setdefault(locus, {})
            entry_data.update({
                'uniprot_id':   uid,
                'protein_name': full_name,
                'function':     func_text,
                'go_terms':     go_terms[:10],
                'ec':           ec,
            })

# ── Curated KEGG pathway list for Synechocystis PCC 6803 ─────────────────────
KEGG_PATHWAYS = [
    ('syn01100', 'Global Metabolic Map'),
    ('syn00710', 'Carbon Fixation — Calvin Cycle'),
    ('syn00195', 'Photosynthesis'),
    ('syn00010', 'Glycolysis / Gluconeogenesis'),
    ('syn00020', 'TCA Cycle'),
    ('syn00030', 'Pentose Phosphate Pathway'),
    ('syn00630', 'Glyoxylate and Dicarboxylate Metabolism'),
    ('syn00190', 'Oxidative Phosphorylation'),
    ('syn00061', 'Fatty Acid Biosynthesis'),
    ('syn00230', 'Purine Metabolism'),
    ('syn00240', 'Pyrimidine Metabolism'),
    ('syn00400', 'Phe / Tyr / Trp Biosynthesis'),
    ('syn00860', 'Porphyrin and Chlorophyll Metabolism'),
    ('syn00900', 'Terpenoid Backbone Biosynthesis'),
    ('syn00460', 'Cyanoamino Acid Metabolism'),
    ('syn00750', 'Vitamin B6 Metabolism'),
]

metabolic_bp = Blueprint('metabolic_bp', __name__)

_MODEL_DIR = os.path.join(os.path.dirname(__file__), 'metabolic_models')
_MODEL_PATHS = {
    'base':        os.path.join(_MODEL_DIR, 'Synechocystis_6803.xml'),
    'constrained': os.path.join(_MODEL_DIR, 'Synechocystis_6803_constrained.xml'),
}
_cache      = {}
_cache_lock = threading.Lock()

# ── Subsystem mapping ─────────────────────────────────────────────────────────
# The iRH783 model has no subsystem annotations. Pathways are encoded in the
# 'old_id' notes field as a two-letter prefix (e.g. "AA0001" → amino acid).
_OLD_ID_PREFIX_MAP = {
    'AA': 'Aromatic amino acid biosynthesis',
    'AG': 'Amino acid biosynthesis (Arg/Glu/Gln)',
    'AL': 'Amino acid biosynthesis (Ala/Leu/Val)',
    'BM': 'Biomass and maintenance',
    'BT': 'Cofactor and biotransformation',
    'CA': 'Calvin cycle / Carbon fixation',
    'CP': 'Chlorophyll and porphyrin biosynthesis',
    'FO': 'Folate / One-carbon metabolism',
    'GE': 'General / Energy maintenance',
    'GL': 'Glycolipid biosynthesis',
    'GM': 'Cysteine / Methionine / Sulfur metabolism',
    'GS': 'Glycolysis / Gluconeogenesis / Sugar metabolism',
    'HE': 'Heme biosynthesis',
    'HI': 'Histidine biosynthesis',
    'IL': 'Fatty acid biosynthesis',
    'IN': 'Inositol metabolism',
    'LA': 'Leu/Ala metabolism',
    'LI': 'Lipid biosynthesis',
    'ME': 'Inorganic carbon / CO₂ transport',
    'NI': 'Nitrogen metabolism',
    'PC': 'Pantothenate / CoA biosynthesis',
    'PG': 'Peptidoglycan / Cell wall biosynthesis',
    'PP': 'Pentose phosphate pathway',
    'PR': 'Transport and exchange (primary)',
    'PT': 'Pyruvate metabolism / TCA cycle',
    'PU': 'Purine biosynthesis',
    'PY': 'Pyrimidine biosynthesis',
    'QT': 'Queuosine / Modified nucleotides',
    'RI': 'Riboflavin / Vitamin B2 biosynthesis',
    'SS': 'Isoprenoid / Carotenoid biosynthesis',
    'ST': 'Starch / Glycogen metabolism',
    'TE': 'Terpenoid / MEP/DXP pathway',
    'TP': 'Signal transduction',
    'TR': 'Transport reactions',
    'VS': 'Vitamin / Special metabolism',
    'VT': 'Cobalamin / Vitamin B12 biosynthesis',
}

def _get_subsystem(reaction):
    """Infer subsystem from old_id note prefix, then from reaction ID patterns."""
    old_id = (reaction.notes or {}).get('old_id', '')
    if old_id:
        prefix = ''.join(c for c in old_id if c.isalpha())
        return _OLD_ID_PREFIX_MAP.get(prefix, f'Other ({prefix})')

    rid = reaction.id
    # Exchange / boundary reactions
    if rid.startswith('EX_'):
        return 'Exchange reactions'
    # Biomass reactions without old_id
    if rid.startswith('BM'):
        return 'Biomass and maintenance'
    # RuBisCO
    if rid in ('RBPC', 'RBCh'):
        return 'Calvin cycle / Carbon fixation'
    # Fatty acid chain-length variants: 3OAS*, 3OAR*, 3HAD*, EAR*, T2DEC*
    if rid[:4] in ('3OAS', '3OAR', '3HAD', 'EAR1') or rid.startswith('T2DEC'):
        return 'Fatty acid biosynthesis'
    # Membrane glycerolipid chain variants: G3PAT*, AGPAT*, PAPA*, DAGK*, MGDG*,
    # MGT*, MGDGE*, SQD2*, DASYN*, PGSA*, PGPP*, GGGT*, SK_*
    _GLPD_PREFIXES = ('G3PAT', 'AGPAT', 'PAPA1', 'PAPA_', 'DAGK', 'MGDG',
                      'MGT1', 'MGT_', 'MGDGE', 'SQD2', 'DASYN', 'PGSA',
                      'PGPP', 'GGGT', 'SK_')
    if any(rid.startswith(p) for p in _GLPD_PREFIXES):
        return 'Membrane lipid biosynthesis'
    # Glycogen sink
    if rid.startswith('SK_'):
        return 'Starch / Glycogen metabolism'
    return 'Unclassified'


# ── Model helpers ─────────────────────────────────────────────────────────────

def _find_rxn(m, candidates):
    """Return the first reaction ID from candidates that exists in m, else None."""
    for rid in candidates:
        try:
            m.reactions.get_by_id(rid)
            return rid
        except KeyError:
            pass
    return None


def _objective_rxn_id(m):
    """Return the ID of the reaction currently set as the model objective."""
    for r in m.reactions:
        if r.objective_coefficient != 0:
            return r.id
    return None


def _apply_knockouts(m, gene_ids):
    """Knock out genes (GPR-aware) in a model copy. Silently skips unknown genes."""
    for gid in (gene_ids or []):
        try:
            m.genes.get_by_id(gid).knock_out()
        except KeyError:
            pass


def _apply_custom_reactions(m, custom_list):
    """Add heterologous reactions (and any missing metabolites) to a model copy.

    Each item in custom_list is a dict:
      { id, name, lb, ub, stoich: {met_id: coeff}, new_mets: {met_id: {name,formula,compartment}} }
    Reactions already present in the model are silently skipped (no duplicate).
    """
    import cobra
    if not custom_list:
        return
    to_add = []
    for rd in custom_list:
        rxn_id = rd.get('id', '').strip()
        if not rxn_id:
            continue
        try:
            m.reactions.get_by_id(rxn_id)
            continue  # already present — skip
        except KeyError:
            pass
        rxn = cobra.Reaction(rxn_id)
        rxn.name        = rd.get('name', rxn_id)
        rxn.lower_bound = float(rd.get('lb', 0))
        rxn.upper_bound = float(rd.get('ub', 1000))
        new_mets = rd.get('new_mets', {}) if isinstance(rd.get('new_mets'), dict) else {}
        stoich = {}
        for met_id, coeff in rd.get('stoich', {}).items():
            try:
                met = m.metabolites.get_by_id(met_id)
            except KeyError:
                nm  = new_mets.get(met_id, {})
                met = cobra.Metabolite(
                    met_id,
                    name        = nm.get('name',        met_id),
                    formula     = nm.get('formula',     ''),
                    compartment = nm.get('compartment', 'c'),
                )
            stoich[met] = float(coeff)
        rxn.add_metabolites(stoich)
        to_add.append(rxn)
    if to_add:
        m.add_reactions(to_add)


# ── Model loading ─────────────────────────────────────────────────────────────

def _get_model(constrained=False):
    """Load and cache the COBRApy model (lazy, thread-safe, loaded once per key)."""
    key = 'constrained' if constrained else 'base'
    if key in _cache:          # fast path — no lock needed once cached
        return _cache[key]
    with _cache_lock:
        if key not in _cache:  # second check inside lock (double-checked locking)
            import cobra
            _cache[key] = cobra.io.read_sbml_model(_MODEL_PATHS[key])
    return _cache[key]


# ── Page ──────────────────────────────────────────────────────────────────────

@metabolic_bp.route('/metabolic_model')
def metabolic_model_page():
    return render_template('metabolic_model.html')


# ── Info / lists ──────────────────────────────────────────────────────────────

@metabolic_bp.route('/api/metabolic/info')
def model_info():
    m = _get_model()
    subsystems = sorted({_get_subsystem(r) for r in m.reactions})
    return jsonify({
        'reactions':    len(m.reactions),
        'metabolites':  len(m.metabolites),
        'genes':        len(m.genes),
        'compartments': list(m.compartments.keys()),
        'subsystems':   subsystems,
    })


@metabolic_bp.route('/api/metabolic/reactions')
def reactions():
    m = _get_model()
    return jsonify([{
        'id':        r.id,
        'name':      r.name,
        'equation':  r.build_reaction_string(use_metabolite_names=True),
        'subsystem': _get_subsystem(r),
        'lb':        r.lower_bound,
        'ub':        r.upper_bound,
        'genes':     [g.id for g in r.genes],
    } for r in m.reactions])


@metabolic_bp.route('/api/metabolic/metabolites')
def metabolites():
    m = _get_model()
    return jsonify([{
        'id':          met.id,
        'name':        met.name,
        'formula':     met.formula,
        'compartment': met.compartment,
        'charge':      met.charge,
    } for met in m.metabolites])


@metabolic_bp.route('/api/metabolic/gene_annotations_status')
def gene_annotations_status():
    loading = bool(_EXT_ANN_THREAD and _EXT_ANN_THREAD.is_alive())
    return jsonify({'loaded': _EXT_ANN_LOADED, 'loading': loading,
                    'count': len(_EXT_ANNOTATIONS)})


@metabolic_bp.route('/api/metabolic/genes')
def genes():
    m = _get_model()
    # Build {locus: uniprot_id} map from model and start background annotation loader
    locus_uniprot = {g.id: g.annotation.get('uniprot', '')
                     for g in m.genes if g.annotation.get('uniprot')}
    _start_annotation_loading(locus_uniprot)  # non-blocking; no-op if already running
    result = []
    for g in m.genes:
        subsystems = sorted({_get_subsystem(r) for r in g.reactions})
        ann     = dict(g.annotation)
        kegg_id = ann.get('kegg.genes', '')
        if kegg_id.startswith('syn:'):
            kegg_id = kegg_id[4:]
        rxn_names = sorted({r.name for r in g.reactions if r.name and r.name != r.id})
        ext       = _EXT_ANNOTATIONS.get(g.id, {})

        # Best protein name: UniProt protein_name > KEGG product > model name
        protein_name = (ext.get('protein_name') or ext.get('product')
                        or (g.name if g.name and not g.name.startswith('G_') else '')
                        or '')

        result.append({
            'id':           g.id,
            'name':         protein_name,
            'gene_name':    ext.get('gene_name', ''),   # e.g. "psbA"
            'reactions':    [r.id for r in g.reactions],
            'rxn_names':    rxn_names,
            'subsystems':   subsystems,
            'kegg_id':      kegg_id,
            'uniprot_id':   ext.get('uniprot_id', ''),
            'function':     ext.get('function', ''),
            'go_terms':     ext.get('go_terms', []),
            'ec':           ext.get('ec', ''),
            'annotation':   ann,
        })
    return jsonify(result)


# ── Subsystem graph (bipartite: metabolites ↔ reactions) ─────────────────────

@metabolic_bp.route('/api/metabolic/subsystem/<path:name>/graph')
def subsystem_graph(name):
    m = _get_model()
    nodes, edges = [], []
    met_seen, rxn_seen = set(), set()

    for r in m.reactions:
        if _get_subsystem(r) != name:
            continue
        if r.id not in rxn_seen:
            nodes.append({'data': {'id': r.id, 'label': r.name or r.id, 'type': 'rxn'}})
            rxn_seen.add(r.id)
        for met, coeff in r.metabolites.items():
            if met.id not in met_seen:
                nodes.append({'data': {'id': met.id, 'label': met.name or met.id,
                                       'type': 'met', 'compartment': met.compartment or ''}})
                met_seen.add(met.id)
            if coeff < 0:
                edges.append({'data': {'source': met.id, 'target': r.id}})
            else:
                edges.append({'data': {'source': r.id, 'target': met.id}})

    return jsonify({'nodes': nodes, 'edges': edges})


# ── FBA ───────────────────────────────────────────────────────────────────────

@metabolic_bp.route('/api/metabolic/fba', methods=['POST'])
def run_fba():
    data = request.json or {}
    constrained = bool(data.get('constrained', False))
    m = _get_model(constrained).copy()

    for rxn_id, bounds in data.get('constraints', {}).items():
        try:
            r = m.reactions.get_by_id(rxn_id)
            if 'lb' in bounds:
                r.lower_bound = float(bounds['lb'])
            if 'ub' in bounds:
                r.upper_bound = float(bounds['ub'])
        except KeyError:
            pass

    _apply_custom_reactions(m, data.get('custom_reactions', []))
    _apply_knockouts(m, data.get('knockout_genes', []))

    use_pfba = bool(data.get('pfba', False))
    if use_pfba:
        from cobra.flux_analysis import pfba as cobra_pfba
        try:
            sol = cobra_pfba(m)
        except Exception:
            sol = m.optimize()
    else:
        sol = m.optimize()

    if sol.status == 'optimal':
        fluxes = {rid: round(v, 6)
                  for rid, v in sol.fluxes.items() if abs(v) > 1e-9}
        return jsonify({
            'status':    'optimal',
            'objective': round(sol.objective_value, 6),
            'fluxes':    fluxes,
            'pfba':      use_pfba,
        })
    return jsonify({'status': sol.status, 'objective': None, 'fluxes': {}})


# ── Gene knockout ─────────────────────────────────────────────────────────────

@metabolic_bp.route('/api/metabolic/knockout/<gene_id>', methods=['POST'])
def gene_knockout(gene_id):
    data = request.json or {}
    constrained = bool(data.get('constrained', False))

    # WT reference (same constraints, no KO)
    m_wt = _get_model(constrained).copy()
    sol_wt = m_wt.optimize()
    wt_rate = round(sol_wt.objective_value, 6) if sol_wt.status == 'optimal' else 0.0

    m = _get_model(constrained).copy()
    try:
        m.genes.get_by_id(gene_id).knock_out()
    except KeyError:
        return jsonify({'error': f'Gene {gene_id} not found'}), 404

    sol = m.optimize()
    return jsonify({
        'status':       sol.status,
        'objective':    round(sol.objective_value, 6) if sol.status == 'optimal' else None,
        'wt_objective': wt_rate,
    })


# ── KEGG pathway list ─────────────────────────────────────────────────────────

@metabolic_bp.route('/api/metabolic/kegg_pathways')
def kegg_pathways():
    return jsonify([{'id': pid, 'name': name} for pid, name in KEGG_PATHWAYS])


# ── KEGG redirect URL builder ─────────────────────────────────────────────────

@metabolic_bp.route('/api/metabolic/kegg_url', methods=['POST'])
def kegg_url():
    data       = request.json or {}
    fluxes     = data.get('fluxes', {})     # {rxnId: flux}
    pathway_id = data.get('pathway', 'syn01100')
    m          = _get_model()

    # Compute per-gene flux as max |flux| of its reactions
    gene_flux = {}
    for rxn_id, flux in fluxes.items():
        if abs(flux) < 1e-9:
            continue
        try:
            r = m.reactions.get_by_id(rxn_id)
        except KeyError:
            continue
        for gene in r.genes:
            kg = gene.annotation.get('kegg.genes', '')
            if kg.startswith('syn:'):
                gid = kg[4:]   # strip 'syn:'
                if abs(flux) > abs(gene_flux.get(gid, 0)):
                    gene_flux[gid] = flux

    if not gene_flux:
        return jsonify({'url': f'https://www.genome.jp/pathway/{pathway_id}', 'colored': 0})

    # Determine flux scale for gradient
    max_abs = max(abs(v) for v in gene_flux.values()) or 1.0

    def flux_to_hex(flux):
        intensity = min(abs(flux) / max_abs, 1.0)
        if flux > 0:
            # blue gradient: light #aec6f0 → dark #1a3fa0
            r_ = int(174 - intensity * (174 - 26))
            g_ = int(198 - intensity * (198 - 63))
            b_ = int(240 - intensity * (240 - 160))
        else:
            # red gradient: light #f0aeae → dark #a01a1a
            r_ = int(240 - intensity * (240 - 160))
            g_ = int(174 - intensity * (174 - 26))
            b_ = int(174 - intensity * (174 - 26))
        return f'%23{r_:02X}{g_:02X}{b_:02X}'   # URL-encoded #RRGGBB

    parts = [f'{gid}%09{flux_to_hex(v)}' for gid, v in list(gene_flux.items())[:300]]
    url = f'https://www.genome.jp/kegg-bin/show_pathway?{pathway_id}+' + '+'.join(parts)
    return jsonify({'url': url, 'colored': len(parts)})


# ── iPath3 global overview ────────────────────────────────────────────────────

@metabolic_bp.route('/api/metabolic/ipath3', methods=['POST'])
def ipath3():
    data   = request.json or {}
    fluxes = data.get('fluxes', {})
    m      = _get_model()

    if not fluxes:
        return jsonify({'error': 'No flux data — run FBA first'}), 400

    max_abs = max((abs(v) for v in fluxes.values()), default=1.0)

    lines = []
    for rxn_id, flux in fluxes.items():
        if abs(flux) < 1e-9:
            continue
        try:
            r = m.reactions.get_by_id(rxn_id)
        except KeyError:
            continue
        kegg_rxn = r.annotation.get('kegg.reaction', '')
        if not kegg_rxn:
            continue
        width   = max(1, min(10, int(abs(flux) / max_abs * 9) + 1))
        color   = '#1a64c8' if flux > 0 else '#c81a1a'
        lines.append(f'{kegg_rxn}\t{width}\t{color}')

    if not lines:
        return jsonify({'error': 'No KEGG-annotated reactions with flux found'}), 400

    selection = '\n'.join(lines)
    post_data = urllib.parse.urlencode({
        'selection':       selection,
        'default_opacity': '0.15',
        'default_width':   '2',
        'default_radius':  '7',
        'query_reactions': '1',
        'export_type':     'svg',
        'tax_filter':      '',
    }).encode('utf-8')

    try:
        req = urllib.request.Request(
            'https://pathways.embl.de/mapping.cgi',
            data=post_data,
            headers={'Content-Type': 'application/x-www-form-urlencoded',
                     'User-Agent': 'CyanoTools/1.0'},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            svg = resp.read().decode('utf-8')
        return jsonify({'svg': svg, 'reactions_colored': len(lines)})
    except Exception as e:
        return jsonify({'error': f'iPath3 request failed: {e}'}), 502


# ── Light sweep ────────────────────────────────────────────────────────────────
# Sweeps photon uptake from i_min to i_max and records growth rate, O₂ flux,
# and biomass yield per photon at each point.

@metabolic_bp.route('/api/metabolic/light_sweep', methods=['POST'])
def light_sweep():
    data        = request.json or {}
    constrained = bool(data.get('constrained', False))
    i_min       = float(data.get('i_min', 10))
    i_max       = float(data.get('i_max', 1200))
    steps       = min(int(data.get('steps', 40)), 80)

    # Höper 2024 photodamage: optional ATP drain proportional to photon flux.
    # fba_kd (mmol ATP / mmol photon): sets ATPM lower bound to fba_kd * J_I at each step.
    # alpha (m²/gCDW) and KL (mmol/gCDW/h): kinetic parameters for quantum yield correction.
    # When alpha and KL are provided, the photon exchange reaction is bounded by J*_I
    # = KL * J_I / (KL + J_I) (Höper 2024 Eq. 5), while photodamage still uses raw J_I.
    fba_kd_raw = data.get('fba_kd')
    fba_kd: float = float(fba_kd_raw) if fba_kd_raw is not None else 0.0
    alpha_raw = data.get('alpha')
    KL_raw    = data.get('KL')
    fba_alpha: float = float(alpha_raw) if alpha_raw is not None else 0.0
    fba_KL:    float = float(KL_raw)    if KL_raw    is not None else 0.0

    m = _get_model(constrained).copy()
    _apply_custom_reactions(m, data.get('custom_reactions', []))
    _apply_knockouts(m, data.get('knockout_genes', []))

    photon_id = data.get('photon_rxn') or _find_rxn(
        m, ('EX_photon_e1_e', 'EX_photon_e', 'R_EX_photon_e'))
    if not photon_id:
        cands = [r.id for r in m.reactions if 'photon' in r.id.lower()]
        photon_id = cands[0] if cands else None
    if not photon_id:
        return jsonify({'error': 'Cannot find photon exchange reaction'}), 400

    o2_id  = _find_rxn(m, ('EX_o2_e',  'EX_O2_e',  'R_EX_o2_e'))
    co2_id = _find_rxn(m, ('EX_co2_e', 'EX_CO2_e', 'R_EX_co2_e'))

    # Find ATPM reaction for photodamage drain
    atpm_id   = _find_rxn(m, ('ATPM', 'atpm', 'R_ATPM')) if fba_kd > 0.0 else None
    atpm_rxn  = m.reactions.get_by_id(atpm_id) if atpm_id else None
    atpm_base: float = float(atpm_rxn.lower_bound) if atpm_rxn else 0.0

    ph_rxn = m.reactions.get_by_id(photon_id)
    results = []
    step_size = (i_max - i_min) / max(steps - 1, 1)

    for i in range(steps):
        photon_val = i_min + i * step_size   # J_I (mmol photons/gDW/h)

        # Apply quantum yield correction (Höper 2024 Eq. 5): J*_I = KL * J_I / (KL + J_I)
        # The photon exchange reaction is bounded by J*_I when KL is provided.
        if fba_alpha > 0 and fba_KL > 0:
            j_star = fba_KL * photon_val / (fba_KL + photon_val)
        else:
            j_star = photon_val

        ph_rxn.lower_bound = -abs(j_star)
        ph_rxn.upper_bound = 0

        if atpm_rxn is not None:
            # Photodamage ATP drain uses raw J_I (not J*_I), matching Höper 2024 GitHub code.
            new_lb = atpm_base + fba_kd * photon_val
            # Guard: lower_bound must not exceed upper_bound
            atpm_rxn.lower_bound = min(new_lb, atpm_rxn.upper_bound)

        sol = m.optimize()
        if sol.status == 'optimal':
            growth   = sol.objective_value
            o2_flux  = sol.fluxes.get(o2_id,  0) if o2_id  else None
            co2_flux = sol.fluxes.get(co2_id, 0) if co2_id else None
            yield_v  = growth / photon_val if photon_val > 0 else 0
        else:
            growth = yield_v = 0
            o2_flux  = 0 if o2_id  else None
            co2_flux = 0 if co2_id else None
        results.append({
            'photon': round(photon_val, 2),
            'growth': round(growth,   6),
            'o2':     round(o2_flux,  6) if o2_flux  is not None else None,
            'co2':    round(co2_flux, 6) if co2_flux is not None else None,
            'yield':  round(yield_v,  8),
        })

    return jsonify({'points': results, 'photon_rxn': photon_id, 'o2_rxn': o2_id,
                    'fba_kd': fba_kd, 'atpm_rxn': atpm_id})


# ── Production envelope ────────────────────────────────────────────────────────
# At each growth rate from 0 → max, finds max and min product flux.
# This traces the phenotypic phase plane / Pareto frontier.

@metabolic_bp.route('/api/metabolic/production_envelope', methods=['POST'])
def production_envelope_api():
    data        = request.json or {}
    constrained = bool(data.get('constrained', False))
    product_rxn = data.get('product_rxn', '').strip()
    n_points    = min(int(data.get('points', 20)), 50)

    if not product_rxn:
        return jsonify({'error': 'product_rxn is required'}), 400

    m = _get_model(constrained).copy()
    _apply_custom_reactions(m, data.get('custom_reactions', []))
    try:
        m.reactions.get_by_id(product_rxn)
    except KeyError:
        return jsonify({'error': f'Reaction {product_rxn!r} not found'}), 404

    biomass_id = _objective_rxn_id(m)
    if not biomass_id:
        return jsonify({'error': 'Cannot determine objective reaction'}), 400

    # Maximum growth rate (unconstrained product)
    sol_wt = m.optimize()
    if sol_wt.status != 'optimal':
        return jsonify({'error': 'Model infeasible at baseline'}), 400
    max_growth = sol_wt.objective_value

    bm_rxn = m.reactions.get_by_id(biomass_id)
    results = []

    for i in range(n_points + 1):
        growth_val = max_growth * i / n_points
        max_prod = min_prod = 0

        with m:
            bm_rxn.lower_bound = growth_val
            bm_rxn.upper_bound = growth_val
            m.objective = product_rxn

            m.objective_direction = 'max'
            s = m.optimize()
            if s.status == 'optimal':
                max_prod = s.objective_value

            m.objective_direction = 'min'
            s = m.optimize()
            if s.status == 'optimal':
                min_prod = s.objective_value

        results.append({
            'growth':    round(growth_val, 6),
            'flux_max':  round(max(max_prod, 0), 6),
            'flux_min':  round(min_prod, 6),
        })

    return jsonify({
        'points':      results,
        'product_rxn': product_rxn,
        'max_growth':  round(max_growth, 6),
    })


# ── Energetics ────────────────────────────────────────────────────────────────
# Given a target reaction, reports the stoichiometric cost in photons, CO₂,
# O₂, ATP, and NADPH per unit of product flux (growth blocked).

@metabolic_bp.route('/api/metabolic/energetics', methods=['POST'])
def energetics():
    data        = request.json or {}
    constrained = bool(data.get('constrained', False))
    target_rxn  = data.get('target_rxn', '').strip()

    if not target_rxn:
        return jsonify({'error': 'target_rxn is required'}), 400

    m = _get_model(constrained).copy()
    _apply_custom_reactions(m, data.get('custom_reactions', []))
    try:
        m.reactions.get_by_id(target_rxn)
    except KeyError:
        return jsonify({'error': f'Reaction {target_rxn!r} not found'}), 404

    photon_id  = _find_rxn(m, ('EX_photon_e1_e', 'EX_photon_e'))
    o2_id      = _find_rxn(m, ('EX_o2_e', 'EX_O2_e'))
    co2_id     = _find_rxn(m, ('EX_co2_e', 'EX_CO2_e'))
    no3_id     = _find_rxn(m, ('EX_no3_e', 'EX_NO3_e'))
    biomass_id = _objective_rxn_id(m)

    with m:
        # Block growth; maximize target product
        if biomass_id:
            bm = m.reactions.get_by_id(biomass_id)
            bm.lower_bound = 0
            bm.upper_bound = 0
        m.objective = target_rxn
        m.objective_direction = 'max'
        sol = m.optimize()

        if sol.status != 'optimal':
            return jsonify({'error': f'Infeasible under growth-blocked conditions: {sol.status}'}), 400

        target_flux = sol.fluxes.get(target_rxn, 0)
        if abs(target_flux) < 1e-9:
            return jsonify({'error': 'Target reaction carries zero flux'}), 400

        def ex_cost(rxn_id):
            if not rxn_id:
                return None
            v = sol.fluxes.get(rxn_id, 0)
            return round(abs(v) / abs(target_flux), 4)

        # ATP cost: net consumption from mass balance on atp_c
        atp_cost = nadph_cost = None
        for met_id, key in (('atp_c', 'atp'), ('nadph_c', 'nadph')):
            try:
                met = m.metabolites.get_by_id(met_id)
                # In steady-state FBA, net = 0. Here we measure gross consumption
                # as the sum of |stoich * flux| for reactions where stoich*flux < 0
                gross_consumed = sum(
                    abs(coeff * sol.fluxes.get(rxn.id, 0))
                    for rxn, coeff in met.reactions.items()
                    if coeff * sol.fluxes.get(rxn.id, 0) < 0
                )
                cost = round(gross_consumed / abs(target_flux), 4)
                if key == 'atp':
                    atp_cost = cost
                else:
                    nadph_cost = cost
            except KeyError:
                pass

    return jsonify({
        'target_rxn':        target_rxn,
        'target_flux':       round(target_flux, 4),
        'photons_per_unit':  ex_cost(photon_id),
        'o2_per_unit':       ex_cost(o2_id),
        'co2_per_unit':      ex_cost(co2_id),
        'no3_per_unit':      ex_cost(no3_id),
        'atp_per_unit':      atp_cost,
        'nadph_per_unit':    nadph_cost,
        'photon_rxn':        photon_id,
    })
