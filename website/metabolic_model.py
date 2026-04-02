import os
import json
import math
import re
import threading
import urllib.request
import urllib.parse
from flask import Blueprint, render_template, jsonify, request
from . import metanetx_lookup

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
    """Load and cache the COBRApy model (lazy, thread-safe, loaded once per key).
    On first load, parses SBML and saves a JSON cache for faster subsequent starts.
    """
    key = 'constrained' if constrained else 'base'
    if key in _cache:          # fast path — no lock needed once cached
        return _cache[key]
    with _cache_lock:
        if key not in _cache:  # second check inside lock (double-checked locking)
            import cobra
            sbml_path = _MODEL_PATHS[key]
            json_path = sbml_path.rsplit('.', 1)[0] + '_cache.json'
            if os.path.exists(json_path) and os.path.getmtime(json_path) >= os.path.getmtime(sbml_path):
                _cache[key] = cobra.io.load_json_model(json_path)
            else:
                _cache[key] = cobra.io.read_sbml_model(sbml_path)
                try:
                    cobra.io.save_json_model(_cache[key], json_path)
                except Exception as e:
                    print(f'[metabolic] JSON cache save failed: {e}')
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
        'biomass_rxn':  _objective_rxn_id(m) or '',
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
        'kegg':        met.annotation.get('kegg.compound', ''),
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


# ── KEGG pathway manifest ─────────────────────────────────────────────────────

_kegg_manifest = None  # {pathway_id: pathway_name}


def _load_kegg_manifest():
    """Load the KEGG pathway manifest (pid → name) from manifest.json."""
    global _kegg_manifest
    if _kegg_manifest is not None:
        return _kegg_manifest
    manifest_path = os.path.join(os.path.dirname(__file__), 'static', 'kegg_maps',
                                 'manifest.json')
    try:
        with open(manifest_path) as f:
            _kegg_manifest = json.load(f)
    except Exception:
        _kegg_manifest = {}
    return _kegg_manifest


@metabolic_bp.route('/api/metabolic/kegg_pathways')
def kegg_pathway_list():
    """Return sorted list of available KEGG pathway maps [{id, name}]."""
    manifest = _load_kegg_manifest()
    return jsonify(sorted(
        [{'id': pid, 'name': name} for pid, name in manifest.items()],
        key=lambda x: x['name']
    ))


# ── KEGG compound → pathway index ─────────────────────────────────────────────

_compound_pathway_index = None  # {kegg_cpd_id: [{pathway_id, pathway_name}]}


def _build_compound_index():
    global _compound_pathway_index
    if _compound_pathway_index is not None:
        return _compound_pathway_index

    kegg_dir = os.path.join(os.path.dirname(__file__), 'static', 'kegg_maps')
    pathway_names = _load_kegg_manifest()

    index = {}
    for pid, pname in pathway_names.items():
        conf_path = os.path.join(kegg_dir, f'{pid}_conf.json')
        if not os.path.isfile(conf_path):
            continue
        try:
            with open(conf_path) as f:
                hotspots = json.load(f)
            seen_cpds = set()
            for hs in hotspots:
                if hs.get('entry_type') == 'compound':
                    cpd_id = hs['id']
                    if (cpd_id, pid) not in seen_cpds:
                        seen_cpds.add((cpd_id, pid))
                        index.setdefault(cpd_id, []).append({
                            'pathway_id': pid, 'pathway_name': pname})
        except Exception:
            pass

    _compound_pathway_index = index
    return index


@metabolic_bp.route('/api/metabolic/compound_pathways')
def compound_pathways():
    """Return {kegg_cpd_id: [{pathway_id, pathway_name}]} for all compounds
    that appear in downloaded KEGG maps."""
    return jsonify(_build_compound_index())


_reaction_pathway_index = None  # {rxn_id: [{pathway_id, pathway_name}]}


def _build_reaction_index():
    global _reaction_pathway_index
    if _reaction_pathway_index is not None:
        return _reaction_pathway_index

    kegg_dir = os.path.join(os.path.dirname(__file__), 'static', 'kegg_maps')
    names = _load_kegg_manifest()

    # We need rxn_ids from gene hotspots — load conf files and run the
    # same locus→reaction mapping as kegg_map_conf does
    m = _get_model()
    locus_to_rxns = {}
    for r in m.reactions:
        for g in r.genes:
            locus_to_rxns.setdefault(g.id, []).append(r.id)

    index = {}
    for pid, pname in names.items():
        conf_path = os.path.join(kegg_dir, f'{pid}_conf.json')
        if not os.path.isfile(conf_path):
            continue
        try:
            with open(conf_path) as f:
                hotspots = json.load(f)
            for hs in hotspots:
                if hs.get('entry_type') == 'gene':
                    loci = re.findall(r'(s[lr][rl]\d+)', hs.get('label', ''))
                    rxn_ids = set()
                    for locus in loci:
                        rxn_ids.update(locus_to_rxns.get(locus, []))
                    for rid in rxn_ids:
                        entry = {'pathway_id': pid, 'pathway_name': pname}
                        existing = index.setdefault(rid, [])
                        if not any(e['pathway_id'] == pid for e in existing):
                            existing.append(entry)
        except Exception:
            pass

    _reaction_pathway_index = index
    return index


@metabolic_bp.route('/api/metabolic/reaction_pathways')
def reaction_pathways():
    """Return {rxn_id: [{pathway_id, pathway_name}]} for all iRH783 reactions
    that map to genes in downloaded KEGG maps."""
    return jsonify(_build_reaction_index())


# ── KEGG pathway map conf data ───────────────────────────────────────────────

@metabolic_bp.route('/api/metabolic/kegg_map/<pathway_id>')
def kegg_map_conf(pathway_id):
    """Return parsed KEGG conf hotspot data + image URL for a pathway.

    Also maps KEGG gene IDs to iRH783 reaction IDs so flux data can be
    overlaid on the correct gene boxes.
    """
    # Validate pathway_id format
    if not re.match(r'^syn\d{5}$', pathway_id):
        return jsonify({'error': 'Invalid pathway ID'}), 400

    conf_path = os.path.join(os.path.dirname(__file__), 'static', 'kegg_maps',
                             f'{pathway_id}_conf.json')
    img_url = f'/static/kegg_maps/{pathway_id}.png'

    if not os.path.isfile(conf_path):
        return jsonify({'error': f'No conf data for {pathway_id}'}), 404

    with open(conf_path) as f:
        hotspots = json.load(f)

    # Build gene locus → iRH783 reaction ID mapping and name lookup
    m = _get_model()
    locus_to_rxns = {}  # e.g. 'slr1289' → ['ICDHyr']
    locus_to_rxn_names = {}  # e.g. 'slr1289' → ['Isocitrate dehydrogenase']
    for r in m.reactions:
        for g in r.genes:
            locus_to_rxns.setdefault(g.id, []).append(r.id)
            if r.name and r.name != r.id:
                locus_to_rxn_names.setdefault(g.id, set()).add(r.name)

    # Build locus → protein name from external annotations + model
    locus_to_protein = {}
    for g in m.genes:
        ext = _EXT_ANNOTATIONS.get(g.id, {})
        protein_name = (ext.get('protein_name') or ext.get('product')
                        or (g.name if g.name and not g.name.startswith('G_') else '')
                        or '')
        gene_name = ext.get('gene_name', '')
        if protein_name or gene_name:
            locus_to_protein[g.id] = {
                'protein': protein_name,
                'gene_name': gene_name,
            }

    # Annotate gene hotspots with iRH783 reaction IDs and protein names
    for hs in hotspots:
        if hs['entry_type'] == 'gene':
            # label may be "slr1289 (icd)" or "sll0823 (sdhB), slr0090 (sdhA)"
            loci = re.findall(r'(s[lr][rl]\d+)', hs['label'])
            rxn_ids = set()
            gene_details = []
            for locus in loci:
                rxn_ids.update(locus_to_rxns.get(locus, []))
                info = locus_to_protein.get(locus, {})
                protein = info.get('protein', '')
                gname = info.get('gene_name', '')
                rxn_names = sorted(locus_to_rxn_names.get(locus, set()))
                gene_details.append({
                    'locus': locus,
                    'gene_name': gname,
                    'protein': protein,
                    'rxn_names': rxn_names,
                })
            hs['rxn_ids'] = list(rxn_ids)
            hs['gene_details'] = gene_details

    return jsonify({'hotspots': hotspots, 'image_url': img_url,
                    'pathway_id': pathway_id})



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
    tracked_rxn = data.get('tracked_reaction') or None

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
            growth        = sol.objective_value
            o2_flux       = sol.fluxes.get(o2_id,  0) if o2_id  else None
            co2_flux      = sol.fluxes.get(co2_id, 0) if co2_id else None
            yield_v       = growth / photon_val if photon_val > 0 else 0
            product_flux  = round(float(sol.fluxes.get(tracked_rxn, 0)), 6) if tracked_rxn else None
        else:
            growth = yield_v = 0
            o2_flux       = 0 if o2_id  else None
            co2_flux      = 0 if co2_id else None
            product_flux  = 0.0 if tracked_rxn else None
        results.append({
            'photon':       round(photon_val, 2),
            'growth':       round(growth,     6),
            'o2':           round(o2_flux,    6) if o2_flux  is not None else None,
            'co2':          round(co2_flux,   6) if co2_flux is not None else None,
            'yield':        round(yield_v,    8),
            'product_flux': product_flux,
        })

    return jsonify({'points': results, 'photon_rxn': photon_id, 'o2_rxn': o2_id,
                    'fba_kd': fba_kd, 'atpm_rxn': atpm_id})


# ── Biosynthetic Cost ─────────────────────────────────────────────────────────
# Maximises the target reaction flux, then normalises all costs per unit flux.
# Supports both a direct reaction target and a metabolite target (via exchange
# or a transient demand reaction).

@metabolic_bp.route('/api/metabolic/energetics', methods=['POST'])
def energetics():
    import traceback
    from collections import defaultdict
    data        = request.json or {}
    constrained = bool(data.get('constrained', False))
    target_rxn  = data.get('target_rxn', '').strip()
    target_met  = data.get('target_met', '').strip()   # metabolite ID alternative
    mode        = data.get('mode', 'independent')       # 'independent' | 'dependent'
    use_pfba    = bool(data.get('use_pfba', True))
    growth_rate = float(data.get('growth_rate', 0.0))

    if not target_rxn and not target_met:
        return jsonify({'error': 'target_rxn or target_met is required'}), 400

    try:
        return _energetics_inner(data, constrained, target_rxn, target_met,
                                 mode, use_pfba, growth_rate)
    except Exception:
        tb = traceback.format_exc()
        print(f'[energetics] unhandled exception:\n{tb}')
        return jsonify({'error': f'Server error: {tb.splitlines()[-1]}'}), 500


# Fallback subsystem names derived from the model's internal old_id prefix
# (used when rxn.subsystem is empty, as in the Synechocystis 6803 model).
_OLD_ID_PREFIX_SUBSYSTEM = {
    'TR': 'Transport',
    'GS': 'Glycolysis / Gluconeogenesis',
    'PP': 'Pentose Phosphate / Calvin Cycle',
    'PT': 'Pyruvate / TCA',
    'AG': 'N-Assimilation (Glu/Gln)',
    'LI': 'Fatty Acid Synthesis',
    'PU': 'Purine Metabolism',
    'PY': 'Pyrimidine Metabolism',
    'IL': 'Branched-Chain Amino Acids',
    'QT': 'Quinone / Tocopherol',
    'CP': 'Chlorophyll / Porphyrin',
    'CA': 'Carotenoid Biosynthesis',
    'TE': 'Terpenoid / MEP Pathway',
    'ST': 'Starch Metabolism',
    'HE': 'Heme Biosynthesis',
    'BM': 'Biomass',
    'ME': 'CO2 / Exchange Reactions',
    'GE': 'General Energy',
    'BT': 'Fatty Acid Elongation',
    'PG': 'Cell Wall / Peptidoglycan',
    'AA': 'Aromatic Amino Acids',
    'AL': 'Thr / Ser / Met Biosynthesis',
    'HI': 'Histidine Biosynthesis',
    'NI': 'NAD / Nicotinate',
    'PC': 'Pantothenate / CoA',
    'FO': 'Folate Metabolism',
    'VS': 'Vitamin B6',
    'RI': 'Riboflavin',
    'TP': 'Thiamine Biosynthesis',
    'SS': 'Secondary Metabolites',
    'VT': 'Vitamin Biosynthesis',
    'PR': 'Photosynthetic Reactions',
    'GM': 'Sulfur / Cysteine Metabolism',
    'IN': 'Inositol Metabolism',
    'LA': 'Lactate Metabolism',
    'GL': 'Glutathione Metabolism',
}


def _rxn_subsystem(rxn):
    """Return a human-readable subsystem for a reaction.
    Falls back to old_id-prefix mapping when rxn.subsystem is blank."""
    sub = (rxn.subsystem or '').strip()
    if sub:
        return sub
    old_id = (rxn.notes or {}).get('old_id', '') if hasattr(rxn, 'notes') else ''
    if old_id:
        m = re.match(r'^([A-Z]+)', old_id)
        if m:
            return _OLD_ID_PREFIX_SUBSYSTEM.get(m.group(1), 'Other')
    return 'Other'


# Metabolite IDs excluded from the boundary-metabolite flow narrative.
# These are energy/redox carriers and currency metabolites; they are already
# accounted for in the ATP/NADPH totals and would clutter the pathway story.
_FLOW_EXCLUDE = frozenset({
    'atp_c','adp_c','amp_c','atp_e','adp_e',
    'nadph_c','nadp_c','nadh_c','nad_c',
    'fadh2_c','fad_c',
    'h2o_c','h2o_e','h_c','h_e','h_p',
    'pi_c','pi_e','ppi_c',
})


def _compute_sol_metrics(m, sol, tf, photon_id, o2_id, co2_id, no3_id,
                         atp_met, nadph_met, met_names):
    """Given a solved model and normalisation factor tf, compute all cost metrics."""
    from collections import defaultdict

    def _ec(rid):
        return round(abs(sol.fluxes.get(rid, 0)) / tf, 4) if rid else None

    atp_consumed = nadph_consumed = 0.0
    if atp_met:
        atp_consumed = round(sum(
            abs(rxn.metabolites[atp_met] * sol.fluxes.get(rxn.id, 0))
            for rxn in atp_met.reactions
            if rxn.metabolites[atp_met] * sol.fluxes.get(rxn.id, 0) < 0
        ) / tf, 4)
    if nadph_met:
        nadph_consumed = round(sum(
            abs(rxn.metabolites[nadph_met] * sol.fluxes.get(rxn.id, 0))
            for rxn in nadph_met.reactions
            if rxn.metabolites[nadph_met] * sol.fluxes.get(rxn.id, 0) < 0
        ) / tf, 4)

    # Per-subsystem ATP/NADPH balance and boundary metabolite flow
    sub_atp      = defaultdict(float)
    sub_nadph    = defaultdict(float)
    sub_rxns     = defaultdict(int)
    sub_met_bal  = defaultdict(lambda: defaultdict(float))  # sub → met_id → net

    for rxn in m.reactions:
        flux = sol.fluxes.get(rxn.id, 0)
        if abs(flux) < 1e-9:
            continue
        sub = _rxn_subsystem(rxn)
        sub_rxns[sub] += 1
        if atp_met and atp_met in rxn.metabolites:
            sub_atp[sub]  += rxn.metabolites[atp_met]  * flux
        if nadph_met and nadph_met in rxn.metabolites:
            sub_nadph[sub] += rxn.metabolites[nadph_met] * flux
        for met, coeff in rxn.metabolites.items():
            if met.id not in _FLOW_EXCLUDE:
                sub_met_bal[sub][met.id] += coeff * flux

    all_subs = set(sub_atp) | set(sub_nadph)
    subsystems = []
    for s in all_subs:
        inputs, outputs = [], []
        for mid, net in sub_met_bal[s].items():
            if abs(net) < 1e-6:
                continue
            entry = {'met_id': mid,
                     'met_name': met_names.get(mid, mid),
                     'amount': round(abs(net) / tf, 4)}
            (inputs if net < 0 else outputs).append(entry)
        inputs.sort( key=lambda x: x['amount'], reverse=True)
        outputs.sort(key=lambda x: x['amount'], reverse=True)
        subsystems.append({
            'name':      s,
            'atp_net':   round(sub_atp.get(s,   0) / tf, 4),
            'nadph_net': round(sub_nadph.get(s, 0) / tf, 4),
            'rxn_count': sub_rxns.get(s, 0),
            'inputs':    inputs[:6],
            'outputs':   outputs[:6],
        })

    subsystems.sort(key=lambda x: abs(x['atp_net']) + abs(x['nadph_net']), reverse=True)

    return {
        'photons_per_unit': _ec(photon_id),
        'o2_per_unit':      _ec(o2_id),
        'co2_per_unit':     _ec(co2_id),
        'no3_per_unit':     _ec(no3_id),
        'atp_per_unit':     atp_consumed,
        'nadph_per_unit':   nadph_consumed,
        'subsystems':       subsystems,
    }


def _energetics_inner(data, constrained, target_rxn, target_met,
                      mode, use_pfba, growth_rate):
    from cobra.flux_analysis import pfba as cobra_pfba

    # Independent mode: use the photoautotrophic (constrained) model so that
    # glucose and other organic carbon sources are closed, but un-force the
    # photon lower bound so pFBA can minimise photon uptake to exactly what
    # the target synthesis needs.  The constrained model otherwise fixes
    # photon flux at ~554 µmol/gDW/h, which forces growth as a mandatory
    # ATP/NADPH sink and inflates all per-molecule costs.
    # Dependent mode follows the simulation conditions (constrained or not).
    effective_constrained = constrained if mode == 'dependent' else True
    m = _get_model(effective_constrained).copy()
    _apply_custom_reactions(m, data.get('custom_reactions', []))

    demand_added = False

    if target_met and not target_rxn:
        try:
            met = m.metabolites.get_by_id(target_met)
        except KeyError:
            return jsonify({'error': f'Metabolite {target_met!r} not found'}), 404
        ex_rxn = None
        for rxn in met.reactions:
            if len(rxn.metabolites) == 1 and (rxn.metabolites[met] < 0 or rxn.upper_bound > 0):
                ex_rxn = rxn
                break
        if ex_rxn:
            target_rxn = ex_rxn.id
        else:
            import cobra as _cobra
            drain = _cobra.Reaction(f'_DEMAND_{met.id}')
            drain.name = f'Demand for {met.name}'
            drain.lower_bound = 0
            drain.upper_bound = 1000
            drain.add_metabolites({met: -1})
            m.add_reactions([drain])
            target_rxn = drain.id
            demand_added = True

    try:
        target = m.reactions.get_by_id(target_rxn)
    except KeyError:
        return jsonify({'error': f'Reaction {target_rxn!r} not found'}), 404

    # If the target is an internal (non-exchange) reaction, maximising it
    # directly lets growth absorb the product.  Instead, add a drain for the
    # biosynthetic product and maximise that, so all synthesised product is
    # exported and growth is not coupled to the cost calculation.
    # Exclude common waste metabolites (CO2, HCO3) in addition to _FLOW_EXCLUDE.
    _INTERNAL_EXCLUDE = _FLOW_EXCLUDE | {'co2_c', 'hco3_c', 'co2_e'}
    if not target_rxn.startswith('EX_') and not demand_added:
        # Prefer the user-specified metabolite if it is produced by this reaction
        prod_met = None
        if target_met:
            try:
                _tm = m.metabolites.get_by_id(target_met)
                if target.metabolites.get(_tm, 0) > 0:
                    prod_met = _tm
            except KeyError:
                pass
        if prod_met is None:
            # Fall back: pick the produced metabolite with fewest reactions
            # (most pathway-specific), excluding currency/waste metabolites
            candidates = [
                met for met, coeff in target.metabolites.items()
                if coeff > 0 and met.id not in _INTERNAL_EXCLUDE
            ]
            if candidates:
                prod_met = min(candidates, key=lambda met: len(met.reactions))
        if prod_met is not None:
            # Reuse existing single-metabolite exchange/drain if available
            ex_rxn = next(
                (r for r in prod_met.reactions if len(r.metabolites) == 1),
                None
            )
            if ex_rxn:
                target_rxn = ex_rxn.id
            else:
                import cobra as _cobra
                drain = _cobra.Reaction(f'_DEMAND_{prod_met.id}')
                drain.name = f'Demand for {prod_met.name}'
                drain.lower_bound = 0
                drain.upper_bound = 1000
                drain.add_metabolites({prod_met: -1})
                m.add_reactions([drain])
                target_rxn = drain.id
                demand_added = True

    photon_id  = _find_rxn(m, ('EX_photon_e1_e', 'EX_photon_e'))
    o2_id      = _find_rxn(m, ('EX_o2_e', 'EX_O2_e'))
    co2_id     = _find_rxn(m, ('EX_co2_e', 'EX_CO2_e'))
    no3_id     = _find_rxn(m, ('EX_no3_e', 'EX_NO3_e'))
    biomass_id = _objective_rxn_id(m)

    # In independent mode we use the constrained (photoautotrophic) model to
    # block organic carbon, but the forced photon lower bound must be removed so
    # pFBA can set photon uptake to exactly what the target synthesis needs.
    if mode == 'independent' and photon_id:
        m.reactions.get_by_id(photon_id).lower_bound = -1000

    # Build metabolite name lookup once (outside with-block for both solvers)
    met_names = {met.id: met.name for met in m.metabolites}

    atp_met = nadph_met = None
    try: atp_met  = m.metabolites.get_by_id('atp_c')
    except KeyError: pass
    try: nadph_met = m.metabolites.get_by_id('nadph_c')
    except KeyError: pass

    results = {}
    zero_flux_error = None

    for label, do_pfba in [('fba', False), ('pfba', True)]:
        with m:
            biomass_rxn = m.reactions.get_by_id(biomass_id) if biomass_id else None
            if mode == 'dependent' and biomass_rxn and growth_rate > 0:
                biomass_rxn.lower_bound = growth_rate
                biomass_rxn.upper_bound = growth_rate
            # Independent mode: leave biomass free (lb=0 in base model).
            # pFBA minimises growth to ~0 naturally since photon flux is not
            # forced in the base model — blocking it causes cascade infeasibility.

            m.objective = target_rxn
            m.objective_direction = 'max'

            if do_pfba:
                try:
                    sol = cobra_pfba(m)
                except Exception as exc:
                    results[label] = {'error': f'pFBA failed: {exc}'}
                    continue
            else:
                sol = m.optimize()

            if sol.status != 'optimal':
                results[label] = {'error': f'Infeasible ({label.upper()}): {sol.status}'}
                continue

            tf = abs(sol.fluxes.get(target_rxn, 0))
            if tf < 1e-9:
                dir_hint = (' Check that the selected reaction PRODUCES the target'
                            ' (positive stoichiometry / forward direction), not consumes it.'
                            if not (target.lower_bound >= 0 and target.upper_bound > 0) else '')
                zero_flux_error = ('Target carries zero flux under these conditions.' + dir_hint +
                                   ' Try unchecking Photoautotrophic constraints or'
                                   ' selecting a different reaction.')
                results[label] = {'error': zero_flux_error}
                continue

            results[label] = _compute_sol_metrics(
                m, sol, tf, photon_id, o2_id, co2_id, no3_id,
                atp_met, nadph_met, met_names)

    # If both failed with the same zero-flux message, surface it directly
    if all('error' in v for v in results.values()):
        return jsonify({'error': zero_flux_error or results['fba'].get('error', 'Unknown error')}), 400

    return jsonify({
        'target_rxn':  target_rxn,
        'target_met':  target_met,
        'demand_added': demand_added,
        'mode':        mode,
        'growth_rate': growth_rate,
        'photon_rxn':  photon_id,
        'fba':         results.get('fba'),
        'pfba':        results.get('pfba'),
    })


@metabolic_bp.route('/api/metabolic/met_reactions/<met_id>')
def met_reactions(met_id):
    """Return all reactions involving a metabolite, with stoichiometry and subsystem."""
    m = _get_model()
    try:
        met = m.metabolites.get_by_id(met_id)
    except KeyError:
        return jsonify({'error': f'Metabolite {met_id!r} not found'}), 404

    result = []
    for rxn in met.reactions:
        coeff = rxn.metabolites[met]
        result.append({
            'id':        rxn.id,
            'name':      rxn.name,
            'subsystem': _get_subsystem(rxn),
            'stoich':    coeff,          # >0 = metabolite produced, <0 = consumed
            'equation':  rxn.build_reaction_string(use_metabolite_names=True),
            'lb':        rxn.lower_bound,
            'ub':        rxn.upper_bound,
            'is_exchange': len(rxn.metabolites) == 1,
        })

    # Sort: exchange/demand first, then by subsystem name
    result.sort(key=lambda r: (0 if r['is_exchange'] else 1, r['subsystem'] or '', r['id']))
    return jsonify(result)


@metabolic_bp.route('/api/metabolic/kegg_search')
def kegg_reaction_search():
    """Proxy KEGG reaction full-text search to avoid browser CORS restrictions."""
    query = request.args.get('q', '').strip()
    if len(query) < 2:
        return jsonify([])
    try:
        url = 'https://rest.kegg.jp/find/reaction/' + urllib.parse.quote(query)
        req = urllib.request.Request(url, headers={'User-Agent': 'CyanoTools/1.0'})
        with urllib.request.urlopen(req, timeout=8) as resp:
            text = resp.read().decode('utf-8')
        results = []
        for line in text.strip().splitlines():
            parts = line.split('\t', 1)
            if len(parts) == 2:
                rid  = parts[0].replace('rn:', '')
                name = parts[1]
                results.append({'id': rid, 'name': name})
        return jsonify(results[:20])
    except Exception as exc:
        return jsonify({'error': str(exc)}), 503


@metabolic_bp.route('/api/metabolic/kegg_reaction', methods=['POST'])
def kegg_reaction_lookup():
    """Translate a KEGG reaction ID into BiGG stoichiometry compatible with iRH783."""
    data   = request.json or {}
    raw_id = data.get('kegg_id', '').strip().upper()

    if not re.match(r'^R\d{5}$', raw_id):
        return jsonify({'error': 'Invalid KEGG reaction ID — expected format R#####'}), 400

    if not metanetx_lookup.files_available():
        state = metanetx_lookup.get_download_state()
        if state == 'downloading':
            return jsonify({'error': 'MetaNetX reference files are still downloading — '
                                     'this happens once on first startup (~1–2 min). Please try again shortly.'}), 503
        elif state == 'failed':
            return jsonify({'error': 'MetaNetX download failed (check server logs). '
                                     'Run website/download_metanetx.py manually to retry.'}), 503
        else:
            return jsonify({'error': 'MetaNetX data files not found. '
                                     'Run website/download_metanetx.py to download them.'}), 503

    m           = _get_model()
    bigg_bases  = metanetx_lookup.get_model_bigg_base_ids(m)
    result      = metanetx_lookup.lookup_kegg_reaction(raw_id, bigg_bases)

    if not result.get('found'):
        return jsonify({'error': result.get('error', 'Reaction not found')}), 404

    result['kegg_id'] = raw_id

    # Fetch reaction name + compound names for unmapped metabolites (best-effort, non-fatal)
    import urllib.request as _ur

    try:
        _url = 'https://rest.kegg.jp/find/reaction/' + raw_id
        with _ur.urlopen(_ur.Request(_url, headers={'User-Agent': 'CyanoTools/1.0'}), timeout=5) as _r:
            _line = _r.read().decode('utf-8').strip().splitlines()[0]
        result['kegg_name'] = _line.split('\t', 1)[1] if '\t' in _line else ''
    except Exception:
        result['kegg_name'] = ''

    # Annotate unknown_mets with human-readable compound name from KEGG
    unknowns = result.get('unknown_mets', [])
    kegg_cpds = [u['kegg_cpd'] for u in unknowns if u.get('kegg_cpd')]
    if kegg_cpds:
        try:
            _url2 = 'https://rest.kegg.jp/list/' + '+'.join(f'cpd:{c}' for c in kegg_cpds)
            with _ur.urlopen(_ur.Request(_url2, headers={'User-Agent': 'CyanoTools/1.0'}), timeout=5) as _r2:
                _cpd_text = _r2.read().decode('utf-8')
            _cpd_names = {}
            for _ln in _cpd_text.strip().splitlines():
                _parts = _ln.split('\t', 1)
                if len(_parts) == 2:
                    _cid = _parts[0].replace('cpd:', '')
                    _cpd_names[_cid] = _parts[1].split(';')[0].strip()
            for u in unknowns:
                u['name'] = _cpd_names.get(u.get('kegg_cpd', ''), '')
        except Exception:
            for u in unknowns:
                u.setdefault('name', '')

    return jsonify(result)
