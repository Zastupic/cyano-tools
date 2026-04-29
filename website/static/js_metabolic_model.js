'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let allReactions   = [];
let allMetabolites = [];
let allGenes       = [];
let lastFluxes     = {};      // rxnId → flux value from most recent FBA
let rxnNameMap     = {};      // rxnId → display name
let modelSubsystemChart = null;  // Chart.js instance (model subsystems)
let scenarioDiffChart = null;      // Chart.js instance (scenario differential)
let scenarioPathwayChart = null;   // Chart.js instance (scenario pathway grouped bar)
let biomassRxnId   = '';      // objective/biomass reaction ID from model info

// ── Escher static map files ───────────────────────────────────────────────────
// ── Custom reactions state ────────────────────────────────────────────────────
let customReactions = [];   // [{id, name, lb, ub, stoich, new_mets}] — sent with every API call

// (hmFbaMarker / hmFbaSweepData migrated to simFbaMarker / simFbaPoints)

// ── Condition presets ─────────────────────────────────────────────────────────
// Bounds based on iRH783 constrained model exchange IDs.
// All presets start from the constrained (photoautotrophic) base model.
const PRESETS = {
    photoautotrophic: {
        label: 'Photoautotrophic',
        constrained: true,
        constraints: {},
        description: 'Standard photoautotrophic growth. CO₂ + NO₃⁻ + photons (553 µmol·m⁻²·s⁻¹). Expected growth ≈ 1.0 h⁻¹.',
    },
    low_light: {
        label: 'Low light (50%)',
        constrained: true,
        constraints: { EX_photon_e1_e: { lb: -276.84 } },
        description: 'Photon flux reduced to 50%. Expected growth ≈ 0.5 h⁻¹.',
    },
    high_light: {
        label: 'High light (2×)',
        constrained: true,
        constraints: { EX_photon_e1_e: { lb: -1107.36 } },
        description: 'Photon flux doubled (2×). Excess light may not increase growth proportionally.',
    },
    mixotrophic: {
        label: 'Mixotrophic (+glucose)',
        constrained: true,
        constraints: { EX_glc__D_e: { lb: -5 } },
        description: 'Glucose supplied at 5 mmol·gDW⁻¹·h⁻¹ in addition to light + CO₂. Expected growth ≈ 1.4 h⁻¹.',
    },
    nh4_nitrogen: {
        label: 'NH₄⁺ as N-source',
        constrained: true,
        constraints: { EX_no3_e: { lb: 0 }, EX_nh4_e: { lb: -10 } },
        description: 'Nitrate removed; ammonium supplied instead. Expected growth ≈ 1.1 h⁻¹.',
    },
    n_starvation: {
        label: 'N-starvation',
        constrained: true,
        constraints: { EX_no3_e: { lb: 0 }, EX_nh4_e: { lb: 0 } },
        description: 'All nitrogen sources blocked. Growth should drop to ~0.',
    },
};

// ── Heterologous pathway templates ───────────────────────────────────────────
// Each template defines one or more reactions to add to the model.
// stoich keys: BiGG metabolite IDs. new_mets: {met_id: {name, formula, compartment}}
// for metabolites not present in iRH783. Verify IDs in the Metabolites tab.
const REACTION_TEMPLATES = {
    ethylene_efe: {
        label: 'Ethylene via Efe (P. syringae)',
        description: 'Ethylene-forming enzyme: α-KG + O₂ → ethylene + 3CO₂ + succinate. Product exchange: EX_ethy_e',
        reactions: [
            {
                id: 'EFE', name: 'Ethylene-forming enzyme (Efe, Pseudomonas syringae pv. phaseolicola)',
                lb: 0, ub: 1000,
                stoich: { akg_c: -1, o2_c: -1, succ_c: 1, co2_c: 3, ethy_c: 1 },
                new_mets: { ethy_c: { name: 'Ethylene (ethene)', formula: 'C2H4', compartment: 'c' } },
            },
            {
                id: 'EX_ethy_e', name: 'Ethylene exchange (secretion to gas phase)',
                lb: 0, ub: 1000,
                stoich: { ethy_c: -1 },
                new_mets: {},
            },
        ],
    },
    isoprene_isps: {
        label: 'Isoprene via IspS (poplar)',
        description: 'Isoprene synthase: DMAPP → isoprene + PPi (exploits native MEP/DXP terpenoid pathway). Product exchange: EX_isop_e',
        reactions: [
            {
                id: 'ISPS', name: 'Isoprene synthase (IspS, Populus alba)',
                lb: 0, ub: 1000,
                stoich: { dmapp_c: -1, isop_c: 1, ppi_c: 1 },
                new_mets: { isop_c: { name: 'Isoprene (2-methylbuta-1,3-diene)', formula: 'C5H8', compartment: 'c' } },
            },
            {
                id: 'EX_isop_e', name: 'Isoprene exchange (secretion to gas phase)',
                lb: 0, ub: 1000,
                stoich: { isop_c: -1 },
                new_mets: {},
            },
        ],
    },
    sucrose_export: {
        label: 'Sucrose export sink',
        description: 'Demand sink for sucrose (sucr_c). Synechocystis synthesises sucrose natively via SPS/SPP. Product: DM_sucr_c',
        reactions: [
            {
                id: 'DM_sucr_c', name: 'Sucrose demand / export sink',
                lb: 0, ub: 1000,
                stoich: { sucr_c: -1 },
                new_mets: {},
            },
        ],
    },
    phb_pha: {
        label: 'PHB (PhaABC pathway)',
        description: '3× acetyl-CoA + 2× NADPH → PHB monomer (PhaA β-ketothiolase, PhaB reductase, PhaC synthase). Product: DM_phb_c',
        reactions: [
            {
                id: 'PHAA', name: 'β-ketothiolase (PhaA): 2 acetyl-CoA → acetoacetyl-CoA + CoA',
                lb: 0, ub: 1000,
                stoich: { accoa_c: -2, aacoa_c: 1, coa_c: 1 },
                new_mets: {},
            },
            {
                id: 'PHAB', name: 'Acetoacetyl-CoA reductase (PhaB): acetoacetyl-CoA + NADPH + H → 3HB-CoA + NADP',
                lb: 0, ub: 1000,
                stoich: { aacoa_c: -1, nadph_c: -1, h_c: -1, bhbcoa_c: 1, nadp_c: 1 },
                new_mets: { bhbcoa_c: { name: '(R)-3-Hydroxybutyryl-CoA', formula: 'C25H40N7O18P3S', compartment: 'c' } },
            },
            {
                id: 'PHAC', name: 'PHB synthase (PhaC): 3HB-CoA → PHB unit + CoA',
                lb: 0, ub: 1000,
                stoich: { bhbcoa_c: -1, phb_c: 1, coa_c: 1 },
                new_mets: { phb_c: { name: 'PHB monomer (3-hydroxybutyrate)', formula: 'C4H6O2', compartment: 'c' } },
            },
            {
                id: 'DM_phb_c', name: 'PHB demand (polymer accumulation sink)',
                lb: 0, ub: 1000,
                stoich: { phb_c: -1 },
                new_mets: {},
            },
        ],
    },
};

// ── EFE protein synthesis constants ──────────────────────────────────────────
// UniProt P32021 — EFE from Pseudomonas savastanoi pv. phaseolicola, 350 aa
const EFE_SEQUENCE = 'MTNLQTFELPTEVTGCAADISLGRALIQAWQKDGIFQIKTDSEQDRKTQEAMAASKQFCKEPLTFKSSCVSDLTYSGYVASGEEVTAGKPDFPEIFTVCKDLSVGDQRVKAGWPCHGPVPWPNNTYQKSMKTFMEELGLAGERLLKLTALGFELPINTFTDLTRDGWHHMRVLRFPPQTSTLSRGIGAHTDYGLLVIAAQDDVGGLYIRPPVEGEKRNRNWLPGESSAGMFEHDEPWTFVTPTPGVWTVFPGDILQFMTGGQLLSTPHKVKLNTRERFACAYFHEPNFEASAYPLFEPSANERIHYGEHFTNMFMRCYPDRITTQRINKENRLAHLEDLKKYSDTRATGS';

// One-letter code → cytoplasmic BiGG metabolite ID (iRH783)
const AA_BIGG = {
    A: 'ala__L_c', R: 'arg__L_c', N: 'asn__L_c', D: 'asp__L_c', C: 'cys__L_c',
    E: 'glu__L_c', Q: 'gln__L_c', G: 'gly_c',    H: 'his__L_c', I: 'ile__L_c',
    L: 'leu__L_c', K: 'lys__L_c', M: 'met__L_c', F: 'phe__L_c', P: 'pro__L_c',
    S: 'ser__L_c', T: 'thr__L_c', W: 'trp__L_c', Y: 'tyr__L_c', V: 'val__L_c',
};

// ── Biosynthetic Cost — recombinant product lookup ────────────────────────────
const BC_RECOMB_PRODUCTS = {
    ethylene_efe:   { met: 'ethy_c', name: 'Ethylene', target_rxn: 'EX_ethy_e'  },
    isoprene_isps:  { met: 'isop_c', name: 'Isoprene', target_rxn: 'EX_isop_e'  },
    sucrose_export: { met: 'sucr_c', name: 'Sucrose',  target_rxn: 'DM_sucr_c'  },
    phb_pha:        { met: 'phb_c',  name: 'PHB',      target_rxn: 'DM_phb_c'   },
};

// Currency / cofactor metabolite IDs excluded from auto-detection of product
const BC_CURRENCY_METS = new Set([
    'atp_c','adp_c','amp_c','nadph_c','nadp_c','nadh_c','nad_c',
    'h_c','h2o_c','pi_c','ppi_c','co2_c','o2_c','hco3_c',
    'h_e','h2o_e','co2_e','o2_e','pi_e',
]);

// ── Experimental reference data ───────────────────────────────────────────────
// Zavřel et al. 2019 (eLife 42508) — Synechocystis PCC 6803 turbidostat
// Light intensity (µmol·m⁻²·s⁻¹) vs specific growth rate (h⁻¹) ± SD
// Source: https://github.com/krotlkpt/syn-growth-fit/blob/main/data/zavrel_data.csv
const ZAVREL_2019_DATA = [
    { I:   27.5, mu: 0.025401, muErr: 0.001780 },
    { I:   55.0, mu: 0.038817, muErr: 0.006375 },
    { I:  110.0, mu: 0.058689, muErr: 0.009331 },
    { I:  220.0, mu: 0.081121, muErr: 0.009607 },
    { I:  440.0, mu: 0.104364, muErr: 0.008618 },
    { I:  660.0, mu: 0.103798, muErr: 0.010185 },
    { I:  880.0, mu: 0.099283, muErr: 0.012520 },
    { I: 1100.0, mu: 0.093270, muErr: 0.010918 },
];

// ── Medium composition sliders ────────────────────────────────────────────────
const MEDIUM_SLIDERS = [
    { id: 'med-co2',    rxn: 'EX_co2_e' },
    { id: 'med-no3',    rxn: 'EX_no3_e' },
    { id: 'med-nh4',    rxn: 'EX_nh4_e' },
    { id: 'med-glc',    rxn: 'EX_glc__D_e' },
    { id: 'med-pi',     rxn: 'EX_pi_e' },
    { id: 'med-so4',    rxn: 'EX_so4_e' },
    { id: 'med-fe2',    rxn: 'EX_fe2_e' },
    { id: 'med-mn2',    rxn: 'EX_mn2_e' },
    { id: 'med-zn2',    rxn: 'EX_zn2_e' },
    { id: 'med-cu2',    rxn: 'EX_cu2_e' },
];

// ── Molecular weights for concentration → uptake rate conversion ──────────────
const MED_MW = {
    'med-co2':  44.01,   // CO₂
    'med-no3':  62.00,   // NO₃⁻
    'med-nh4':  18.04,   // NH₄⁺
    'med-glc': 180.16,   // Glucose
    'med-pi':   94.97,   // PO₄³⁻ (phosphate)
    'med-so4':  96.06,   // SO₄²⁻
    'med-fe2':  55.85,   // Fe²⁺
    'med-mn2':  54.94,   // Mn²⁺
    'med-zn2':  65.38,   // Zn²⁺
    'med-cu2':  63.55,   // Cu²⁺
};

// ── Gene knockout dropdown helpers ────────────────────────────────────────────
function simKoGetGenes() {
    const sel = document.getElementById('sim-ko-select');
    if (!sel) return [];
    return Array.from(sel.selectedOptions).map(o => o.value);
}

function simKoClear() {
    const sel = document.getElementById('sim-ko-select');
    if (sel) Array.from(sel.options).forEach(o => o.selected = false);
    simKoUpdateDisplay();
}

function simKoSetGenes(geneList) {
    const sel = document.getElementById('sim-ko-select');
    if (!sel) return;
    Array.from(sel.options).forEach(o => { o.selected = geneList.includes(o.value); });
    simKoUpdateDisplay();
}

function simKoUpdateDisplay() {
    const genes   = simKoGetGenes();
    const hasKO   = genes.length > 0;
    const list    = document.getElementById('sim-ko-selected-list');
    const wrap    = document.getElementById('sim-ko-selected-wrap');
    const actions = document.getElementById('sim-ko-actions');
    const note    = document.getElementById('sim-ko-applied-note');
    if (list)    { list.textContent = genes.join(', '); list.style.display = hasKO ? '' : 'none'; }
    if (wrap)    wrap.style.display    = hasKO ? '' : 'none';
    if (actions) actions.style.display = hasKO ? 'flex' : 'none';
    if (note)    note.style.display    = hasKO ? '' : 'none';
}

function simKoFilter() {
    const q   = (document.getElementById('sim-ko-search')?.value || '').trim().toLowerCase();
    const sel = document.getElementById('sim-ko-select');
    if (!sel) return;
    Array.from(sel.options).forEach(o => {
        o.style.display = (!q || o.text.toLowerCase().includes(q) || o.title.toLowerCase().includes(q)) ? '' : 'none';
    });
}

function simKoOpenKEGG() {
    const sel = document.getElementById('sim-ko-select');
    if (!sel) return;
    const first = Array.from(sel.selectedOptions)[0];
    if (!first) { alert('Select a gene first.'); return; }
    const gene   = allGenes.find(g => g.id === first.value);
    const keggId = gene?.kegg_id || first.value;
    window.open(`https://www.genome.jp/entry/syn:${encodeURIComponent(keggId)}`, '_blank');
}

// ── Gene KO sidebar autocomplete ─────────────────────────────────────────────
let _koAcHighlight = -1;  // currently highlighted row index

function simKoDirectFilter(q) {
    const box = document.getElementById('sim-ko-autocomplete');
    if (!box) return;
    q = q.trim().toLowerCase();
    if (!q || !allGenes.length) { box.style.display = 'none'; return; }

    const matches = allGenes.filter(g =>
        g.id.toLowerCase().includes(q) ||
        (g.name && g.name.toLowerCase().includes(q))
    ).slice(0, 20);

    if (!matches.length) { box.style.display = 'none'; return; }

    box.innerHTML = matches.map((g, i) => {
        const alreadyKO = simKoGetGenes().includes(g.id);
        return `<div class="sim-ko-ac-row px-2 py-1" data-gene="${g.id}"
                     style="cursor:pointer;${alreadyKO ? 'color:#aaa;' : ''}"
                     onmousedown="simKoDirectSelect('${g.id}')">
            <strong>${g.id}</strong>
            ${g.name ? `<span class="text-muted ml-1">${g.name}</span>` : ''}
            ${alreadyKO ? '<span class="badge badge-secondary ml-1">KO</span>' : ''}
        </div>`;
    }).join('');
    _koAcHighlight = -1;
    box.style.display = 'block';
}

function simKoDirectKeydown(e) {
    const box = document.getElementById('sim-ko-autocomplete');
    const rows = box ? box.querySelectorAll('.sim-ko-ac-row') : [];
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        _koAcHighlight = Math.min(_koAcHighlight + 1, rows.length - 1);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _koAcHighlight = Math.max(_koAcHighlight - 1, 0);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (_koAcHighlight >= 0 && rows[_koAcHighlight]) {
            simKoDirectSelect(rows[_koAcHighlight].dataset.gene);
        } else {
            simKoDirectAdd();
        }
        return;
    } else if (e.key === 'Escape') {
        if (box) box.style.display = 'none';
        return;
    } else { return; }
    rows.forEach((r, i) => r.style.background = i === _koAcHighlight ? '#e8f0fe' : '');
}

function simKoDirectSelect(geneId) {
    const inp = document.getElementById('sim-ko-direct-input');
    if (inp) inp.value = geneId;
    const box = document.getElementById('sim-ko-autocomplete');
    if (box) box.style.display = 'none';
    addGeneToFBAKO(geneId, null);
    if (inp) { inp.value = ''; inp.focus(); }
}

function simKoDirectAdd() {
    const inp = document.getElementById('sim-ko-direct-input');
    if (!inp) return;
    const q = inp.value.trim();
    if (!q) return;
    // exact match first (case-insensitive on id or name)
    const gene = allGenes.find(g =>
        g.id.toLowerCase() === q.toLowerCase() ||
        (g.name && g.name.toLowerCase() === q.toLowerCase())
    );
    if (gene) {
        simKoDirectSelect(gene.id);
    } else {
        // flash red to signal not found
        inp.classList.add('is-invalid');
        setTimeout(() => inp.classList.remove('is-invalid'), 1200);
    }
}

// Close autocomplete when clicking outside
document.addEventListener('click', e => {
    if (!e.target.closest('#sim-pg-fba-ko')) {
        const box = document.getElementById('sim-ko-autocomplete');
        if (box) box.style.display = 'none';
    }
});

// ── Concentration → uptake rate converter ─────────────────────────────────────
// Henry's constant for CO₂ dissolution at 25°C: 34 mmol/(L·atm)
// NOTE: Henry's law dissolution is NOT used for sparged-CO₂ photobioreactors —
// see CO₂ handling in medApplyConcentrations / medPrefillConcentrations.
const KH_CO2 = 34;
// Photosynthetic CO₂ model for sparged PBRs:
//   q_CO2 [mmol/gDW/h] = (ppm / (ppm + Ks)) × µ × C_content
//   Ks,CO2 ≈ 150 ppm  (half-saturation for Synechocystis PCC 6803)
//   C_content ≈ 42 mmol C/gDW  (50% carbon by weight, MW_C = 12 g/mol)
//   At 5000 ppm, µ=0.06 h⁻¹: q ≈ 2.4 mmol/gDW/h  (Zavřel 2019: 0.78–4.01)
const KS_CO2_PPM    = 150;   // half-saturation constant [ppm]
const CO2_C_CONTENT = 42;    // mmol C per gDW biomass (Synechocystis)

/** Calculate XA from reactor geometry: XA [g/m²] = ρ [g/L] × V [L] / A [m²] */
function medCalcXA() {
    const A   = parseFloat(document.getElementById('med-reactor-area')?.value);
    const V   = parseFloat(document.getElementById('med-reactor-vol')?.value);
    const rho = parseFloat(document.getElementById('med-reactor-rho')?.value);
    const res = document.getElementById('med-xa-calc-result');
    if (!A || !V || A <= 0) { if (res) res.textContent = 'Enter A and V'; return; }
    const z  = V / (A * 1000);
    const XA = rho > 0 ? (rho * V) / A : null;

    // Push z to its slider
    const zSlider = document.getElementById('sim-reactor-depth');
    const zVal    = document.getElementById('sim-reactor-depth-val');
    if (zSlider) zSlider.value = Math.min(Math.max(z, parseFloat(zSlider.min)), parseFloat(zSlider.max));
    if (zVal)    zVal.textContent = z.toFixed(3);

    // Push XA to its slider (only when ρ is filled in)
    if (XA !== null) {
        const xaSlider = document.getElementById('sim-XA');
        const xaVal    = document.getElementById('sim-XA-val');
        if (xaSlider) xaSlider.value = Math.min(XA, parseFloat(xaSlider.max || 200));
        if (xaVal)    xaVal.textContent = XA.toFixed(1);
        const xaConvInput = document.getElementById('med-conv-xa');
        if (xaConvInput) xaConvInput.value = XA.toFixed(1);
        medUpdateX();
    }

    if (res) res.textContent = XA !== null
        ? `X\u2090 = ${XA.toFixed(1)} gCDM·m⁻²  ·  z = ${z.toFixed(3)} m`
        : `z = ${z.toFixed(3)} m`;

    simRecompute();
    if (simMode === 'turb') simRenderTurbCharts();
}

/** Re-compute and display X whenever XA or d changes. */
const _UNIT_LABELS = { ppm_co2: 'ppm', mmol_L: 'mM', mg_L: 'mg/L' };

function medUnitCycle(btn) {
    const opts = btn.dataset.opts.split(',');
    const inp  = document.getElementById(btn.dataset.input);
    const next = (opts.indexOf(inp.value) + 1) % opts.length;
    inp.value    = opts[next];
    btn.textContent = _UNIT_LABELS[opts[next]] || opts[next];
}

function medSyncUnitButtons() {
    document.querySelectorAll('.med-unit-btn').forEach(btn => {
        const inp = document.getElementById(btn.dataset.input);
        if (inp) btn.textContent = _UNIT_LABELS[inp.value] || inp.value;
    });
}

function medUpdateX() {
    const XA = parseFloat(document.getElementById('med-conv-xa')?.value)    || 30;
    const d  = parseFloat(document.getElementById('med-conv-depth')?.value) || 0.05;
    const X  = XA / (d * 1000);
    const el = document.getElementById('med-conv-x-display');
    if (el) el.textContent = `= ${X.toFixed(3)} gDW/L`;
}

function medCopyFBAmu() {
    const box = document.getElementById('fba-result-box');
    if (!box) return;
    const match = box.textContent.match(/Growth rate:\s*([\d.]+)/);
    if (match) {
        const el = document.getElementById('med-conv-mu');
        if (el) el.value = parseFloat(match[1]).toFixed(4);
    }
}

// Per-nutrient unit select IDs (suffix maps to nutrient slider id suffix)
const MED_UNIT_IDS = {
    'med-co2': 'med-unit-co2',
    'med-no3': 'med-unit-no3',
    'med-nh4': 'med-unit-nh4',
    'med-glc': 'med-unit-glc',
    'med-pi':  'med-unit-pi',
    'med-so4': 'med-unit-so4',
    'med-fe2': 'med-unit-fe2',
    'med-mn2': 'med-unit-mn2',
    'med-zn2': 'med-unit-zn2',
    'med-cu2': 'med-unit-cu2',
};

function _medGetUnit(id) {
    return document.getElementById(MED_UNIT_IDS[id])?.value || 'mmol_L';
}

function _medXFromInputs() {
    const XA = parseFloat(document.getElementById('med-conv-xa')?.value)    || 30;
    const d  = parseFloat(document.getElementById('med-conv-depth')?.value) || 0.05;
    return XA / (d * 1000);
}

/** Back-calculate concentrations from current slider values and fill the table. */
function medPrefillConcentrations() {
    const mu = parseFloat(document.getElementById('med-conv-mu')?.value) || 0.06;
    const X  = _medXFromInputs();

    const xDisp = document.getElementById('med-conv-x-display');
    if (xDisp) xDisp.textContent = `= ${X.toFixed(3)} gDW/L`;

    // maxConc: if back-calculated concentration exceeds this (mmol/L), the slider is at an
    // "unconstrained" level — show blank rather than an unrealistically large number.
    const nutrients = [
        { id: 'med-co2', maxConc: null  },  // CO2 handled via ppm branch (fSat check)
        { id: 'med-no3', maxConc:  200  },  // > 200 mM NO3 is unrealistic in any medium
        { id: 'med-nh4', maxConc:   50  },
        { id: 'med-glc', maxConc:   20  },
        { id: 'med-pi',  maxConc:   10  },
        { id: 'med-so4', maxConc:   10  },
        { id: 'med-fe2', maxConc:    1  },
        { id: 'med-mn2', maxConc:    1  },
        { id: 'med-zn2', maxConc:    1  },
        { id: 'med-cu2', maxConc:  0.1  },
    ];
    nutrients.forEach(({ id, maxConc }) => {
        const sliderEl = document.getElementById(id);
        const ccEl     = document.getElementById('med-cc-' + id.replace('med-',''));
        if (!sliderEl || !ccEl) return;
        const q    = parseFloat(sliderEl.value) || 0;
        const unit = _medGetUnit(id);
        let c;
        if (unit === 'ppm_co2') {
            // Invert photosynthetic stoichiometry model:
            //   q = fSat × µ × C_content  →  fSat = q / (µ × C_content)
            //   ppm = fSat × Ks / (1 - fSat)
            // If fSat ≥ 1 the exchange bound exceeds what any finite ppm can drive
            // (CO2 non-limiting) — leave the field blank rather than showing 99999.
            const fSat = q / (mu * CO2_C_CONTENT);
            c = (fSat >= 1) ? NaN : (fSat * KS_CO2_PPM) / (1 - fSat);
        } else {
            // c [mmol/L] = q × X / µ
            c = (q * X) / mu;
            if (unit === 'mg_L') {
                const mw = MED_MW[id];
                if (mw) c = c * mw;
            }
        }
        const valid = c > 0 && isFinite(c) && (maxConc === null || c <= maxConc);
        ccEl.value = valid ? +c.toFixed(4) : '';
    });
}

function medApplyConcentrations() {
    const mu = parseFloat(document.getElementById('med-conv-mu')?.value) || 0.06;
    const X  = _medXFromInputs();  // gDW/L

    const xDisp = document.getElementById('med-conv-x-display');
    if (xDisp) xDisp.textContent = `= ${X.toFixed(3)} gDW/L`;

    // Trace metals (Fe, Mn, Zn, Cu) are intentionally excluded from the dissolved-pool
    // converter.  The formula q = µ·c/X is valid for macronutrients consumed in bulk,
    // but not for trace metals: cells use high-affinity transporters that absorb metals
    // far below dissolved-pool expectations, and FBA stoichiometric coefficients reflect
    // cellular quotas, not kinetic uptake from the medium.  Limiting trace metal sliders
    // to BG-11 dissolved concentrations would set them orders of magnitude too low and
    // block growth.  Their sliders stay at the Höper unconstrained defaults (max slider).
    const nutrients = [
        { id: 'med-co2', maxVal: 1000, step:  0.1   },
        { id: 'med-no3', maxVal: 1000, step:  0.1   },
        { id: 'med-nh4', maxVal:   50, step:  0.1   },
        { id: 'med-glc', maxVal:   20, step:  0.1   },
        { id: 'med-pi',  maxVal:    1, step:  0.001 },
        { id: 'med-so4', maxVal:    1, step:  0.001 },
    ];

    nutrients.forEach(({ id, maxVal, step }) => {
        const suffix   = id.replace('med-', '');
        const ccEl     = document.getElementById('med-cc-' + suffix);
        const sliderEl = document.getElementById(id);
        const valEl    = document.getElementById(id + '-val');
        if (!ccEl || !sliderEl || ccEl.value === '') return;

        let cMmolL = parseFloat(ccEl.value);
        if (isNaN(cMmolL)) return;

        const unit = _medGetUnit(id);
        let q;
        if (unit === 'ppm_co2') {
            // Sparged CO₂ in a photobioreactor: CO₂ is continuously supplied from
            // the gas phase — Henry's law dissolved concentration severely underestimates
            // photosynthetic fixation (~100×).  Use stoichiometric model instead:
            //   q = satFactor × µ × C_content
            // where satFactor = Michaelis-Menten saturation at given ppm.
            const ppm = cMmolL;  // raw input is still in ppm here
            const satFactor = ppm / (ppm + KS_CO2_PPM);
            q = satFactor * mu * CO2_C_CONTENT;
        } else {
            if (unit === 'mg_L') {
                const mw = MED_MW[id];
                if (mw) cMmolL = cMmolL / mw;
            }
            q = (mu * cMmolL) / X;
        }
        q = Math.min(maxVal, Math.max(0, q));
        q = Math.round(q / step) * step;

        // Guard: never set a slider to 0 from a positive raw value — that would
        // completely block a nutrient that is actually present in the medium.
        // If rounding collapses a small-but-positive q to 0, use the minimum step.
        if (q === 0 && cMmolL > 0) q = step;

        sliderEl.value = q;
        if (valEl) valEl.textContent = (q % 1 === 0) ? q : +q.toFixed(4);
    });
}

/** Build constraints dict from medium sliders. Value shown = uptake magnitude; lb = negative. */
function getMediumConstraints() {
    const constraints = {};
    // Photon constraint: J*_I = KL * JI / (KL + JI) — quantum-yield correction (Höper 2024 Eq. 5)
    const alpha = parseFloat(document.getElementById('sim-alpha')?.value) || 0.13;
    const I0    = parseFloat(document.getElementById('sim-I0')?.value)    || 660;
    const KL    = parseFloat(document.getElementById('sim-KL')?.value)    || 119;
    const JI    = alpha * I0 * 3.6;
    const jstar = KL * JI / (KL + JI);
    constraints['EX_photon_e1_e'] = { lb: -jstar };
    MEDIUM_SLIDERS.forEach(({ id, rxn }) => {
        const el = document.getElementById(id);
        if (el) constraints[rxn] = { lb: -parseFloat(el.value) };
    });
    return constraints;
}

/** Update the read-only photon display in Medium composition to show J*_I (quantum-yield corrected) */
function syncMedPhoton() {
    const alpha = parseFloat(document.getElementById('sim-alpha')?.value) || 0.13;
    const I0    = parseFloat(document.getElementById('sim-I0')?.value)    || 660;
    const KL    = parseFloat(document.getElementById('sim-KL')?.value)    || 119;
    const JI    = alpha * I0 * 3.6;
    const jstar = KL * JI / (KL + JI);
    const lbl   = document.getElementById('med-photon-val');
    if (lbl) lbl.textContent = jstar.toFixed(1);
}

// IDs of medium sliders where the maximum value means "unconstrained" (no upper bound in model)
const MED_UNCONSTRAINED_IDS = new Set(['med-co2', 'med-no3', 'med-nh4', 'med-glc']);

function medSlider(input, valId) {
    const atMax = MED_UNCONSTRAINED_IDS.has(input.id) &&
                  parseFloat(input.value) >= parseFloat(input.max);
    document.getElementById(valId).textContent = atMax ? '∞' : input.value;
}

function medNudge(id, valId, dir) {
    const el = document.getElementById(id);
    if (!el) return;
    const step = parseFloat(el.step) || 1;
    el.value = Math.max(parseFloat(el.min), Math.min(parseFloat(el.max), parseFloat(el.value) + dir * step));
    medSlider(el, valId);
}

// ── Compartment colours ───────────────────────────────────────────────────────
// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // All calls fire in parallel; backend lock ensures the SBML is only parsed once
    loadStats();
    loadReactions();
    loadMetabolites();
    loadGenes();
    loadKeggPathways();

    // Buttons
    document.getElementById('load-kegg-map-btn').addEventListener('click', loadKeggMap);
    document.getElementById('kegg-flux-btn').addEventListener('click', () => applyKeggFlux(lastFluxes));
    document.getElementById('kegg-reset-flux-btn').addEventListener('click', resetKeggFlux);
    document.getElementById('run-fba-btn').addEventListener('click', runFBAwithPFBA);
    document.getElementById('export-fba-btn').addEventListener('click', exportFBA);
    document.getElementById('open-kegg-btn').addEventListener('click', openKegg);

    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
    });

    // Table search
    document.getElementById('rxn-search').addEventListener('input',  () => filterTable('rxn-table',  'rxn-search',  'rxn-count-label'));
    document.getElementById('met-search').addEventListener('input',  () => filterTable('met-table',  'met-search',  'met-count-label'));
    document.getElementById('gene-search').addEventListener('input', () => filterTable('gene-table', 'gene-search', 'gene-count-label'));

    // Auto-prefill concentration table when the panel is opened; show X on load
    document.getElementById('med-conc-panel')?.addEventListener('show.bs.collapse', medPrefillConcentrations);
    medUpdateX();

    // Make all slider value labels click-to-edit
    initSliderValueLabels();
});

// ── Loading overlay ───────────────────────────────────────────────────────────
function showLoading(msg) {
    document.getElementById('loading-msg').textContent = msg || 'Loading…';
    document.getElementById('loading-overlay').classList.add('active');
}
function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('active');
}

// ── Stats + subsystem list ────────────────────────────────────────────────────
async function loadStats() {
    showLoading('Loading model… (first visit may take up to 30 s while the SBML file is parsed)');
    try {
        const r = await fetch('/api/metabolic/info');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();

        hideLoading();
        document.getElementById('n-rxn').textContent  = d.reactions;
        document.getElementById('n-met').textContent  = d.metabolites;
        document.getElementById('n-gen').textContent  = d.genes;
        document.getElementById('n-comp').textContent = d.compartments.length;
        biomassRxnId = d.biomass_rxn || '';

        // Subsystems available for other features (gene table, etc.)
    } catch (err) {
        hideLoading();
        showError('Failed to load model: ' + err.message + '. Check the server console.');
        console.error('Stats error:', err);
        throw err;
    }
}

function showError(msg) {
    const div = document.createElement('div');
    div.className = 'alert alert-danger alert-dismissible fade show mx-3 mt-2';
    div.innerHTML = `<strong>Error:</strong> ${esc(msg)}
        <button type="button" class="close" data-dismiss="alert"><span>&times;</span></button>`;
    document.querySelector('.container-fluid').prepend(div);
}

// ── Reactions table ───────────────────────────────────────────────────────────
let reactionPathwayIndex = {};  // rxn_id → [{pathway_id, pathway_name}]

function loadReactions() {
    Promise.all([
        fetch('/api/metabolic/reactions').then(r => r.json()),
        fetch('/api/metabolic/reaction_pathways').then(r => r.json()),
    ]).then(([data, rxnIndex]) => {
        allReactions = data;
        reactionPathwayIndex = rxnIndex;
        data.forEach(r => { rxnNameMap[r.id] = r.name || r.id; });
        initAllRxnDropdowns();

        const tbody = document.querySelector('#rxn-table tbody');
        tbody.innerHTML = data.map(r => {
            const pathways = rxnIndex[r.id] || [];
            let pathwayBtns = '';
            if (pathways.length > 0) {
                pathwayBtns = pathways.map(p =>
                    `<button class="btn btn-outline-info btn-sm py-0 px-1 mr-1 mb-1 rxn-show-pathway"
                             data-pathway="${p.pathway_id}" data-rxn="${esc(r.id)}"
                             style="font-size:0.72em; line-height:1.3;"
                             title="Show in ${esc(p.pathway_name)}">${esc(p.pathway_name)}</button>`
                ).join('');
            }
            return `<tr>
                <td><code>${esc(r.id)}</code></td>
                <td>${esc(r.name || '—')}</td>
                <td style="font-size:0.78em;">${esc(r.equation)}</td>
                <td>${esc(r.subsystem || '—')}</td>
                <td style="font-size:0.78em;">${esc(r.genes.join(', ') || '—')}</td>
                <td>${pathwayBtns || '<span class="text-muted">—</span>'}</td>
            </tr>`;
        }).join('');

        // Attach click handlers for pathway buttons
        tbody.querySelectorAll('.rxn-show-pathway').forEach(btn => {
            btn.addEventListener('click', () => {
                showReactionInPathway(btn.dataset.pathway, btn.dataset.rxn);
            });
        });

        document.getElementById('rxn-count-label').textContent = `${data.length} reactions`;
    });
}

function showReactionInPathway(pathwayId, rxnId) {
    // Switch to Pathways sub-tab
    const pathTab = document.querySelector('#network-sub-tabs a[href="#sub-pathways"]');
    if (pathTab) pathTab.click();

    const sel = document.getElementById('kegg-map-select');
    sel.value = pathwayId;

    // Store highlight target so renderKeggMap can flash it after load
    window._highlightKeggRxn = rxnId;
    loadKeggMap();
}

// ── Metabolites table ─────────────────────────────────────────────────────────
let compoundPathwayIndex = {};  // kegg_cpd_id → [{pathway_id, pathway_name}]

function loadMetabolites() {
    // Load compound→pathway index in parallel with metabolites
    Promise.all([
        fetch('/api/metabolic/metabolites').then(r => r.json()),
        fetch('/api/metabolic/compound_pathways').then(r => r.json()),
    ]).then(([data, cpIndex]) => {
        allMetabolites = data;
        compoundPathwayIndex = cpIndex;
        const tbody = document.querySelector('#met-table tbody');
        tbody.innerHTML = data.map(m => {
            const kegg = m.kegg || '';
            const pathways = kegg ? (cpIndex[kegg] || []) : [];
            let pathwayBtns = '';
            if (pathways.length > 0) {
                pathwayBtns = pathways.map(p =>
                    `<button class="btn btn-outline-info btn-sm py-0 px-1 mr-1 mb-1 met-show-pathway"
                             data-pathway="${p.pathway_id}" data-kegg="${kegg}"
                             style="font-size:0.72em; line-height:1.3;"
                             title="Show in ${esc(p.pathway_name)}">${esc(p.pathway_name)}</button>`
                ).join('');
            }
            return `<tr>
                <td><code>${esc(m.id)}</code></td>
                <td>${esc(m.name || '—')}</td>
                <td><code>${esc(m.formula || '—')}</code></td>
                <td>${esc(m.compartment)}</td>
                <td>${m.charge != null ? m.charge : '—'}</td>
                <td>${pathwayBtns || '<span class="text-muted">—</span>'}</td>
            </tr>`;
        }).join('');

        // Attach click handlers for pathway buttons
        tbody.querySelectorAll('.met-show-pathway').forEach(btn => {
            btn.addEventListener('click', () => {
                showMetaboliteInPathway(btn.dataset.pathway, btn.dataset.kegg);
            });
        });

        document.getElementById('met-count-label').textContent = `${data.length} metabolites`;
    });
}

function showMetaboliteInPathway(pathwayId, keggCpdId) {
    // Switch to Pathways sub-tab
    const pathTab = document.querySelector('#network-sub-tabs a[href="#sub-pathways"]');
    if (pathTab) pathTab.click();

    // Set pathway dropdown and load map
    const sel = document.getElementById('kegg-map-select');
    sel.value = pathwayId;

    // Store highlight target so renderKeggMap can flash it after load
    window._highlightKeggCpd = keggCpdId;
    loadKeggMap();
}

// ── Genes table ───────────────────────────────────────────────────────────────
function _setAnnLoadingUI(loading) {
    const loadEl = document.getElementById('ann-loading-msg');
    const doneEl = document.getElementById('ann-done-msg');
    if (loadEl) loadEl.style.display = loading ? '' : 'none';
    if (doneEl) doneEl.style.display = (!loading) ? '' : 'none';
}

function loadGenes(opts) {
    const skipStatus = opts?.skipStatus;
    if (!skipStatus) {
        // Check if annotations are still loading; show indicator and reload when done
        fetch('/api/metabolic/gene_annotations_status')
            .then(r => r.json())
            .then(st => {
                if (!st.loaded) {
                    _setAnnLoadingUI(true);
                    // Poll until loaded, then reload gene table with enriched names
                    const poll = setInterval(() => {
                        fetch('/api/metabolic/gene_annotations_status')
                            .then(r => r.json())
                            .then(st2 => {
                                if (st2.loaded) {
                                    clearInterval(poll);
                                    loadGenes({ skipStatus: true });
                                }
                            }).catch(() => clearInterval(poll));
                    }, 3000);
                } else {
                    // Annotations already done — hide both indicators
                    const loadEl = document.getElementById('ann-loading-msg');
                    const doneEl = document.getElementById('ann-done-msg');
                    if (loadEl) loadEl.style.display = 'none';
                    if (doneEl) doneEl.style.display = 'none';
                }
            }).catch(() => {});
    }

    fetch('/api/metabolic/genes')
        .then(r => r.json())
        .then(data => {
            allGenes = data;
            // Reveal table, hide initial spinner
            const loadingEl = document.getElementById('gene-table-loading');
            const wrapEl    = document.getElementById('gene-table-wrap');
            if (loadingEl) loadingEl.style.display = 'none';
            if (wrapEl)    wrapEl.style.display = '';

            const tbody = document.querySelector('#gene-table tbody');
            tbody.innerHTML = data.map(g => {
                const rxnPreview = g.reactions.slice(0, 4).join(', ') +
                    (g.reactions.length > 4 ? ` +${g.reactions.length - 4}` : '');
                const subPreview = (g.subsystems || []).slice(0, 2).join(', ') +
                    (g.subsystems?.length > 2 ? ` +${g.subsystems.length - 2}` : '');

                // Backend resolves protein name: UniProt > KEGG product > rxn_names[0] > model name
                const proteinName = g.name || '—';

                // Build protein cell: name + optional gene_name sub-label + EC badge
                const geneNameTag = g.gene_name ? `<br><small class="text-muted" style="font-size:0.78em;">${esc(g.gene_name)}</small>` : '';
                const ecTag = g.ec ? `<span class="badge badge-light border ml-1" style="font-size:0.7em;" title="EC number">${esc(g.ec)}</span>` : '';

                // Tooltip: function text, GO terms, reaction names
                const tooltipParts = [];
                if (g.function) tooltipParts.push(g.function);
                if (g.go_terms?.length) tooltipParts.push(`GO: ${g.go_terms.slice(0, 5).join(', ')}`);
                if (g.rxn_names?.length) tooltipParts.push(`Reactions: ${g.rxn_names.join('; ')}`);
                const tooltip = tooltipParts.join('\n');

                // External links: KEGG + UniProt
                const keggLink = g.kegg_id
                    ? ` <a href="https://www.genome.jp/entry/syn:${esc(g.kegg_id)}" target="_blank" class="text-muted" style="font-size:0.8em;" title="KEGG"><i class="fa fa-external-link"></i></a>`
                    : '';
                const uniprotLink = g.uniprot_id
                    ? ` <a href="https://www.uniprot.org/uniprot/${esc(g.uniprot_id)}" target="_blank" class="text-info" style="font-size:0.8em;" title="UniProt ${esc(g.uniprot_id)}"><i class="fa fa-external-link"></i></a>`
                    : '';

                return `<tr data-gene="${esc(g.id)}">
                    <td style="white-space:nowrap;"><code>${esc(g.id)}</code>${keggLink}${uniprotLink}</td>
                    <td title="${esc(tooltip)}">${esc(proteinName)}${ecTag}${geneNameTag}</td>
                    <td style="font-size:0.78em;" class="text-muted">${esc(subPreview || '—')}</td>
                    <td style="font-size:0.78em;">${esc(rxnPreview)}</td>
                    <td style="white-space:nowrap;">
                        <button class="btn btn-xs btn-outline-secondary ko-btn py-0 px-1"
                                data-gene="${esc(g.id)}">Test KO</button>
                        <button class="btn btn-xs btn-outline-primary add-ko-btn py-0 px-1 ml-1"
                                data-gene="${esc(g.id)}" title="Add to FBA KO set (sidebar)">+FBA KO</button>
                        <span class="ko-result ml-1 small" id="ko-${esc(g.id)}"></span>
                    </td>
                </tr>`;
            }).join('');

            document.getElementById('gene-count-label').textContent = `${data.length} genes`;

            // After annotation reload: hide spinner, show brief "done" message
            if (skipStatus) {
                _setAnnLoadingUI(false);
                // Flash a transient "Protein names updated" toast
                const doneEl = document.getElementById('ann-done-msg');
                if (doneEl) {
                    doneEl.style.display = '';
                    setTimeout(() => { doneEl.style.display = 'none'; }, 4000);
                }
            }

            // Also populate the KO dropdown select with rich option labels + hover tooltips
            const koSel = document.getElementById('sim-ko-select');
            if (koSel) {
                koSel.innerHTML = data.map(g => {
                    // g.name is now resolved by backend: UniProt > KEGG > rxn_names[0]
                    const proteinLabel = g.name || '';
                    const subsStr    = g.subsystems?.join('; ') || '';
                    const rxnShort   = (g.reactions || []).slice(0, 6).join(', ') +
                                       (g.reactions?.length > 6 ? ` +${g.reactions.length - 6}` : '');
                    const titleParts  = [];
                    if (proteinLabel) titleParts.push(`Protein: ${proteinLabel}`);
                    if (g.gene_name)  titleParts.push(`Gene: ${g.gene_name}`);
                    if (g.ec)         titleParts.push(`EC: ${g.ec}`);
                    if (g.function)   titleParts.push(g.function.slice(0, 200));
                    if (g.kegg_id)    titleParts.push(`KEGG: syn:${g.kegg_id}`);
                    if (g.uniprot_id) titleParts.push(`UniProt: ${g.uniprot_id}`);
                    if (subsStr)      titleParts.push(`Subsystem(s): ${subsStr}`);
                    titleParts.push(`Reaction IDs (${g.reactions?.length || 0}): ${rxnShort}`);
                    const subsTag = g.subsystems?.length
                        ? ` [${g.subsystems[0]}${g.subsystems.length > 1 ? ' +' + (g.subsystems.length - 1) : ''}]`
                        : '';
                    const label = g.id + (proteinLabel ? `  ${proteinLabel}` : '') + subsTag;
                    return `<option value="${esc(g.id)}" title="${esc(titleParts.join('\n'))}">${esc(label)}</option>`;
                }).join('');
            }

            document.querySelector('#gene-table tbody').addEventListener('click', e => {
                const koBtn  = e.target.closest('.ko-btn');
                const addBtn = e.target.closest('.add-ko-btn');
                if (koBtn)  runKnockout(koBtn.dataset.gene, koBtn);
                if (addBtn) addGeneToFBAKO(addBtn.dataset.gene, addBtn);
            });

            // Chevron toggle for gene browser card
            document.getElementById('gene-browser-body')?.addEventListener('show.bs.collapse',  () => {
                const ch = document.getElementById('gene-browser-chevron');
                if (ch) ch.className = 'fa fa-chevron-up ml-auto';
            });
            document.getElementById('gene-browser-body')?.addEventListener('hide.bs.collapse', () => {
                const ch = document.getElementById('gene-browser-chevron');
                if (ch) ch.className = 'fa fa-chevron-down ml-auto';
            });
        });
}

function addGeneToFBAKO(geneId, btn) {
    const sel = document.getElementById('sim-ko-select');
    if (!sel) return;
    const opt = Array.from(sel.options).find(o => o.value === geneId);
    if (opt) {
        opt.selected = true;
        simKoUpdateDisplay();
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = '✓ added';
            btn.classList.add('btn-primary');
            btn.classList.remove('btn-outline-primary');
            setTimeout(() => { btn.textContent = orig; btn.classList.remove('btn-primary'); btn.classList.add('btn-outline-primary'); }, 1500);
        }
    }
}

function runKnockout(geneId, btn) {
    const constrained = document.getElementById('ko-constrained-chk').checked;
    btn.disabled = true;
    btn.textContent = '…';
    const span = document.getElementById(`ko-${geneId}`);
    span.textContent = '';

    fetch(`/api/metabolic/knockout/${encodeURIComponent(geneId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ constrained }),
    })
    .then(r => r.json())
    .then(d => {
        if (d.status === 'optimal') {
            const wt  = d.wt_objective || 0;
            const pct = wt > 0 ? (d.objective / wt * 100) : 0;
            const cls = pct < 1  ? 'text-danger font-weight-bold'   // Essential: growth = 0
                      : pct < 50 ? 'text-warning font-weight-bold'  // Impaired:  < 50% WT
                      : 'text-success';                              // Non-essential: ≥ 50% WT
            span.className = `ko-result ml-1 small ${cls}`;
            span.textContent = `Growth rate: ${pct.toFixed(1)}% WT`;
            // Store for sort
            const row = btn.closest('tr');
            if (row) row.dataset.koPct = pct.toFixed(4);
        } else {
            span.className = 'ko-result ml-1 small text-danger font-weight-bold';
            span.textContent = 'Growth rate: 0% WT';
            const row = btn.closest('tr');
            if (row) row.dataset.koPct = '0';
        }
        btn.disabled = false;
        btn.textContent = 'Test KO';
    })
    .catch(() => { btn.disabled = false; btn.textContent = 'Test KO'; });
}

// ── Gene KO table sort ────────────────────────────────────────────────────────
let _koSortAsc = true;

function sortGeneTableByKO() {
    const tbody = document.querySelector('#gene-table tbody');
    if (!tbody) return;
    const rows = Array.from(tbody.querySelectorAll('tr'));

    // Partition: rows with a result vs rows without
    const withResult = rows.filter(r => r.dataset.koPct !== undefined);
    const withoutResult = rows.filter(r => r.dataset.koPct === undefined);

    withResult.sort((a, b) => {
        const va = parseFloat(a.dataset.koPct);
        const vb = parseFloat(b.dataset.koPct);
        return _koSortAsc ? va - vb : vb - va;
    });

    // Rows without results stay at the bottom
    [...withResult, ...withoutResult].forEach(r => tbody.appendChild(r));

    const icon = document.getElementById('ko-sort-icon');
    if (icon) icon.className = _koSortAsc ? 'fa fa-sort-asc' : 'fa fa-sort-desc';
    _koSortAsc = !_koSortAsc;
}

// ── KEGG Pathway Map (PNG + interactive overlay) ─────────────────────────────

// ── KEGG Pathway Map (PNG + interactive overlay) ─────────────────────────────

let keggHotspots = [];   // current hotspot data from conf

function loadKeggMap() {
    const pid = document.getElementById('kegg-map-select').value;
    if (!pid) { alert('Please select a KEGG pathway.'); return; }

    showLoading('Loading KEGG pathway map...');

    fetch(`/api/metabolic/kegg_map/${pid}`)
        .then(r => r.json())
        .then(data => {
            hideLoading();
            if (data.error) { alert(data.error); return; }
            keggHotspots = data.hotspots;
            renderKeggMap(data.image_url, data.hotspots);
        })
        .catch(err => { hideLoading(); console.error('KEGG map error:', err); });
}

function renderKeggMap(imageUrl, hotspots) {
    const panel = document.getElementById('kegg-map-panel');
    const container = document.getElementById('kegg-map-container');
    const img = document.getElementById('kegg-map-img');
    const svg = document.getElementById('kegg-map-svg');
    const actions = document.getElementById('kegg-map-actions');

    panel.style.display = 'block';
    actions.style.display = Object.keys(lastFluxes).length > 0 ? '' : 'none';

    img.onload = function() {
        const w = img.naturalWidth;
        const h = img.naturalHeight;

        // Scale image to fit container but never exceed native size
        img.style.maxWidth = '100%';
        img.style.width = w + 'px';
        img.style.height = 'auto';

        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.pointerEvents = 'all';
        svg.innerHTML = '';

        // Draw interactive hotspots
        hotspots.forEach(hs => {
            let el;
            if (hs.type === 'circ') {
                el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                el.setAttribute('cx', hs.cx);
                el.setAttribute('cy', hs.cy);
                el.setAttribute('r', Math.max(hs.r, 6));  // min radius for clickability
                el.setAttribute('fill', 'transparent');
                el.setAttribute('stroke', 'transparent');
                el.setAttribute('stroke-width', '2');
            } else {
                el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                el.setAttribute('x', hs.x1);
                el.setAttribute('y', hs.y1);
                el.setAttribute('width', hs.x2 - hs.x1);
                el.setAttribute('height', hs.y2 - hs.y1);
                el.setAttribute('fill', 'transparent');
                el.setAttribute('stroke', 'transparent');
                el.setAttribute('stroke-width', '1');
            }

            el.style.cursor = 'pointer';
            el.dataset.hsId = hs.id;
            el.dataset.hsType = hs.entry_type;
            el.dataset.hsLabel = hs.label;
            if (hs.rxn_ids) el.dataset.rxnIds = hs.rxn_ids.join(',');

            // Build tooltip text
            let tipText = '';
            if (hs.entry_type === 'gene' && hs.genes && hs.genes.length > 0) {
                hs.genes.forEach(g => {
                    tipText += `<strong>${g.locus}</strong>`;
                    if (g.product) tipText += `<br><small>${g.product}</small>`;
                    tipText += '<br>';
                });
                if (hs.rxn_ids && hs.rxn_ids.length > 0) {
                    tipText += `<small class="text-muted">iRH783: ${hs.rxn_ids.join(', ')}</small><br>`;
                    hs.rxn_ids.forEach(rid => {
                        const flux = lastFluxes[rid];
                        if (flux != null) tipText += `<small>${rid}: <strong>${flux.toFixed(4)}</strong> mmol/gDW/h</small><br>`;
                    });
                }
            } else if (hs.entry_type === 'compound') {
                tipText = `<strong>${hs.label}</strong><br><small class="text-muted">${hs.id}</small>`;
            } else {
                tipText = `<strong>${hs.label}</strong>`;
            }
            if (hs.entry_type === 'pathway') {
                tipText += '<br><small class="text-info">Click to open pathway</small>';
            } else if (hs.url) {
                tipText += '<small class="text-muted" style="opacity:0.7;">Click to open in KEGG</small>';
            }

            // Hover highlight + tooltip
            const hoverColor = hs.entry_type === 'pathway' ? '#3498db' : '#e67e22';
            const hoverFill = hs.entry_type === 'pathway'
                ? 'rgba(52,152,219,0.2)' : 'rgba(230,126,34,0.15)';
            el.addEventListener('mouseenter', (evt) => {
                if (hs.type === 'circ') {
                    el.setAttribute('stroke', hoverColor);
                    el.setAttribute('fill', 'rgba(230,126,34,0.2)');
                    el.setAttribute('r', Math.max(hs.r, 6) + 3);
                } else {
                    el.setAttribute('stroke', hoverColor);
                    el.setAttribute('fill', hoverFill);
                    el.setAttribute('stroke-width', '2');
                }
                showKeggTooltip(tipText, evt);
            });
            el.addEventListener('mousemove', (evt) => moveKeggTooltip(evt));
            el.addEventListener('mouseleave', () => {
                if (hs.type === 'circ') {
                    el.setAttribute('stroke', el._fluxStroke || 'transparent');
                    el.setAttribute('fill', el._fluxFill || 'transparent');
                    el.setAttribute('r', Math.max(hs.r, 6));
                } else {
                    el.setAttribute('stroke', el._fluxStroke || 'transparent');
                    el.setAttribute('fill', el._fluxFill || 'transparent');
                    el.setAttribute('stroke-width', el._fluxStrokeW || '1');
                }
                hideKeggTooltip();
            });

            // Click → pathway: load map; gene/compound: open KEGG page
            el.addEventListener('click', () => {
                if (hs.entry_type === 'pathway') {
                    const m = hs.id.match(/^(syn\d{5})$/);
                    if (m) {
                        const sel = document.getElementById('kegg-map-select');
                        const opt = sel.querySelector(`option[value="${m[1]}"]`);
                        if (opt) {
                            sel.value = m[1];
                            loadKeggMap();
                            return;
                        }
                    }
                }
                if (hs.url) {
                    window.open('https://www.kegg.jp' + hs.url, '_blank');
                }
            });

            svg.appendChild(el);
        });

        // Auto-apply flux if available
        if (Object.keys(lastFluxes).length > 0) {
            applyKeggFlux(lastFluxes);
        }

        // Highlight a specific compound if requested (from metabolites table)
        if (window._highlightKeggCpd) {
            highlightKeggCompound(window._highlightKeggCpd, svg);
            window._highlightKeggCpd = null;
        }
        // Highlight gene boxes for a specific reaction (from reactions table)
        if (window._highlightKeggRxn) {
            highlightKeggReaction(window._highlightKeggRxn, svg);
            window._highlightKeggRxn = null;
        }
    };
    img.src = imageUrl;
}

function highlightKeggCompound(keggCpdId, svg) {
    const el = svg.querySelector(`[data-hs-id="${keggCpdId}"][data-hs-type="compound"]`);
    if (!el) return;

    // Scroll the compound into view
    const container = document.getElementById('kegg-map-panel');
    if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // Pulsing highlight animation
    el.setAttribute('fill', 'rgba(255, 0, 0, 0.45)');
    el.setAttribute('stroke', '#e00');
    el.setAttribute('stroke-width', '3');
    if (el.tagName === 'circle') {
        el.setAttribute('r', 12);
    }

    let flashes = 0;
    const interval = setInterval(() => {
        flashes++;
        if (flashes % 2 === 0) {
            el.setAttribute('fill', 'rgba(255, 0, 0, 0.45)');
            el.setAttribute('stroke', '#e00');
        } else {
            el.setAttribute('fill', 'rgba(255, 200, 0, 0.5)');
            el.setAttribute('stroke', '#f90');
        }
        if (flashes >= 8) {
            clearInterval(interval);
            // Leave a visible ring so user can find it
            el.setAttribute('fill', 'rgba(255, 0, 0, 0.25)');
            el.setAttribute('stroke', '#e00');
            el.setAttribute('stroke-width', '2');
            if (el.tagName === 'circle') el.setAttribute('r', 10);
        }
    }, 350);
}

function highlightKeggReaction(rxnId, svg) {
    // Find all gene hotspots whose rxn_ids contain this reaction
    const els = svg.querySelectorAll('[data-hs-type="gene"]');
    const matches = [];
    els.forEach(el => {
        const rxnIds = (el.dataset.rxnIds || '').split(',');
        if (rxnIds.includes(rxnId)) matches.push(el);
    });
    if (matches.length === 0) return;

    const container = document.getElementById('kegg-map-panel');
    if (container) container.scrollIntoView({ behavior: 'smooth', block: 'start' });

    matches.forEach(el => {
        el.setAttribute('fill', 'rgba(255, 0, 0, 0.45)');
        el.setAttribute('stroke', '#e00');
        el.setAttribute('stroke-width', '3');
    });

    let flashes = 0;
    const interval = setInterval(() => {
        flashes++;
        matches.forEach(el => {
            if (flashes % 2 === 0) {
                el.setAttribute('fill', 'rgba(255, 0, 0, 0.45)');
                el.setAttribute('stroke', '#e00');
            } else {
                el.setAttribute('fill', 'rgba(255, 200, 0, 0.5)');
                el.setAttribute('stroke', '#f90');
            }
        });
        if (flashes >= 8) {
            clearInterval(interval);
            matches.forEach(el => {
                el.setAttribute('fill', 'rgba(255, 0, 0, 0.25)');
                el.setAttribute('stroke', '#e00');
                el.setAttribute('stroke-width', '2');
            });
        }
    }, 350);
}

// ── KEGG map tooltip ─────────────────────────────────────────────────────────
let _keggTip = null;
function _getKeggTip() {
    if (!_keggTip) {
        _keggTip = document.createElement('div');
        _keggTip.id = 'kegg-tooltip';
        _keggTip.style.cssText = 'position:fixed;z-index:9999;background:#fff;color:#333;border:1px solid #ccc;'
            + 'border-radius:4px;padding:6px 10px;font-size:0.82em;line-height:1.4;'
            + 'pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,0.15);max-width:320px;display:none;';
        document.body.appendChild(_keggTip);
    }
    return _keggTip;
}
function showKeggTooltip(html, evt) {
    const tip = _getKeggTip();
    tip.innerHTML = html;
    tip.style.display = 'block';
    moveKeggTooltip(evt);
}
function moveKeggTooltip(evt) {
    const tip = _getKeggTip();
    if (tip.style.display === 'none') return;
    const x = evt.clientX + 14;
    const y = evt.clientY + 14;
    // Keep tooltip on screen
    const maxX = window.innerWidth - tip.offsetWidth - 8;
    const maxY = window.innerHeight - tip.offsetHeight - 8;
    tip.style.left = Math.min(x, maxX) + 'px';
    tip.style.top = Math.min(y, maxY) + 'px';
}
function hideKeggTooltip() {
    const tip = _getKeggTip();
    tip.style.display = 'none';
}

function applyKeggFlux(fluxes) {
    const svg = document.getElementById('kegg-map-svg');
    if (!svg) return;
    const maxFlux = Math.max(...Object.values(fluxes).map(Math.abs), 1);

    svg.querySelectorAll('[data-hs-type="gene"]').forEach(el => {
        const rxnIds = (el.dataset.rxnIds || '').split(',').filter(Boolean);
        if (rxnIds.length === 0) return;

        // Use max absolute flux among mapped reactions
        let maxVal = 0;
        let direction = 0;
        rxnIds.forEach(rid => {
            const f = fluxes[rid] || 0;
            if (Math.abs(f) > Math.abs(maxVal)) {
                maxVal = f;
                direction = f > 0 ? 1 : f < 0 ? -1 : 0;
            }
        });

        const absFlux = Math.abs(maxVal);
        const intensity = Math.min(absFlux / maxFlux, 1);

        if (absFlux < 1e-9) {
            el._fluxFill = 'rgba(200,200,200,0.5)';
            el._fluxStroke = '#ccc';
            el._fluxStrokeW = '1';
        } else {
            const alpha = 0.3 + intensity * 0.5;
            el._fluxFill = direction > 0
                ? `rgba(30,100,200,${alpha})`    // forward: blue
                : `rgba(192,57,43,${alpha})`;     // reverse: red
            el._fluxStroke = direction > 0 ? '#1565C0' : '#c0392b';
            el._fluxStrokeW = String(1 + intensity * 2);
        }

        el.setAttribute('fill', el._fluxFill);
        el.setAttribute('stroke', el._fluxStroke);
        el.setAttribute('stroke-width', el._fluxStrokeW);
    });

    document.getElementById('kegg-map-actions').style.display = '';
    document.getElementById('kegg-flux-legend').style.display = '';
}

function resetKeggFlux() {
    const svg = document.getElementById('kegg-map-svg');
    if (!svg) return;
    svg.querySelectorAll('[data-hs-type="gene"]').forEach(el => {
        el._fluxFill = 'transparent';
        el._fluxStroke = 'transparent';
        el._fluxStrokeW = '1';
        el.setAttribute('fill', 'transparent');
        el.setAttribute('stroke', 'transparent');
        el.setAttribute('stroke-width', '1');
    });
    document.getElementById('kegg-flux-legend').style.display = 'none';
}

// ── FBA ───────────────────────────────────────────────────────────────────────
function runFBA() {
    const btn = document.getElementById('run-fba-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Running…';

    const constrained = document.getElementById('fba-constrained-chk').checked;
    const constraints = {};

    document.querySelectorAll('.constraint-row').forEach(row => {
        const id = row.querySelector('.c-rxn-id').value.trim();
        const lb = row.querySelector('.c-lb').value;
        const ub = row.querySelector('.c-ub').value;
        if (id) {
            constraints[id] = {};
            if (lb !== '') constraints[id].lb = parseFloat(lb);
            if (ub !== '') constraints[id].ub = parseFloat(ub);
        }
    });

    fetch('/api/metabolic/fba', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ constrained, constraints }),
    })
    .then(r => r.json())
    .then(d => {
        const box = document.getElementById('fba-result-box');
        if (d.status === 'optimal') {
            box.innerHTML = `<div class="alert alert-success mb-1">
                <strong>Growth rate: ${d.objective} h⁻¹</strong>
                <span class="float-right text-muted small">${Object.keys(d.fluxes).length} active reactions</span>
            </div>`;
            lastFluxes = d.fluxes;
            populateFBATable(d.fluxes);
            renderModelSubsystemChart(d.fluxes);
            document.getElementById('fba-flux-wrap').style.display = '';

            // Auto-apply flux to KEGG map if open
            if (keggHotspots.length > 0) applyKeggFlux(d.fluxes);
        } else {
            box.innerHTML = `<div class="alert alert-warning mb-1">
                Optimisation status: <strong>${d.status}</strong>
                <span class="d-block small text-muted mt-1">This usually means the model is infeasible under the given constraints. Check your bounds.</span>
            </div>`;
            document.getElementById('fba-flux-wrap').style.display = 'none';
        }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run static FBA';
    })
    .catch(err => {
        console.error('FBA error:', err);
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run static FBA';
    });
}

// ── "What's limiting?" — active exchange constraint diagnosis ──────────────────
// Friendly display names for common exchange reaction IDs
const _EXCHANGE_LABELS = {
    'EX_photon_e1_e': 'Photons (J*ᵢ)',
    'EX_co2_e':       'CO₂',
    'EX_no3_e':       'Nitrate (NO₃⁻)',
    'EX_nh4_e':       'Ammonium (NH₄⁺)',
    'EX_glc__D_e':    'Glucose',
    'EX_pi_e':        'Phosphate (Pᵢ)',
    'EX_so4_e':       'Sulfate (SO₄²⁻)',
    'EX_fe2_e':       'Iron (Fe²⁺)',
    'EX_mn2_e':       'Manganese (Mn²⁺)',
    'EX_zn2_e':       'Zinc (Zn²⁺)',
    'EX_cu2_e':       'Copper (Cu²⁺)',
    'EX_o2_e':        'O₂ (secretion)',
};

// What each limiting constraint means and how to relieve it
const _CONSTRAINT_INTERP = {
    'EX_photon_e1_e': { noun: 'light',       advice: 'increase I₀ or reduce areal biomass density (X_A)' },
    'EX_co2_e':       { noun: 'CO₂ / carbon', advice: 'increase CO₂ supply or HCO₃⁻ exchange bound' },
    'EX_no3_e':       { noun: 'nitrate',      advice: 'increase NO₃⁻ supply or allow NH₄⁺ uptake' },
    'EX_nh4_e':       { noun: 'ammonium',     advice: 'increase NH₄⁺ supply' },
    'EX_glc__D_e':    { noun: 'glucose',      advice: 'increase glucose supply bound' },
    'EX_pi_e':        { noun: 'phosphate',    advice: 'increase phosphate supply bound' },
    'EX_so4_e':       { noun: 'sulfate',      advice: 'increase sulfate supply bound' },
    'EX_fe2_e':       { noun: 'iron',         advice: 'increase Fe²⁺ supply bound' },
};

function renderLimitingConstraints(fluxes, constraints) {
    const box = document.getElementById('fba-result-box');
    if (!box) return;

    // Compute utilisation for every constrained uptake bound
    const items = [];
    Object.entries(constraints).forEach(([rxnId, bounds]) => {
        const flux = fluxes[rxnId];
        if (flux == null) return;
        if (bounds.lb != null) {
            const lb       = parseFloat(bounds.lb);
            if (lb >= 0) return;                           // ignore non-uptake bounds
            const capacity = Math.abs(lb);
            const used     = Math.min(capacity, Math.abs(flux));
            const ratio    = capacity > 0 ? used / capacity : 0;
            const isActive = Math.abs(flux - lb) < Math.abs(lb) * 0.001 + 1e-6;
            items.push({
                rxnId, flux, lb, capacity, used, ratio, isActive,
                label:  _EXCHANGE_LABELS[rxnId] || rxnId,
                interp: _CONSTRAINT_INTERP[rxnId] || null,
            });
        }
    });

    if (items.length === 0) return;

    const active  = items.filter(i => i.isActive);
    const nouns   = active.map(a => `<strong>${esc(a.interp ? a.interp.noun : a.label)}</strong>`);
    const advices = [...new Set(active.filter(a => a.interp).map(a => a.interp.advice))];

    let sentence;
    if (active.length === 1) {
        const a = active[0];
        sentence = `Growth is <strong>${a.interp ? esc(a.interp.noun) + '-limited' : 'constrained by ' + esc(a.label)}</strong>
            — the model is using 100% of available ${a.interp ? esc(a.interp.noun) : esc(a.label)}.
            To allow higher growth: ${advices[0] ? esc(advices[0]) : 'relax this bound'}.`;
    } else if (active.length > 1) {
        sentence = `Growth is co-limited by ${nouns.join(' and ')}
            — all these bounds are fully consumed simultaneously.
            ${advices.length ? 'To relieve: ' + advices.map(esc).join('; ') + '.' : ''}`;
    } else {
        sentence = 'All resources have spare capacity — growth is constrained by internal stoichiometry.';
    }

    // Bar chart: sorted by utilisation descending
    const uid      = 'lim-bars-' + Math.random().toString(36).slice(2, 7);
    const barsHtml = items
        .sort((a, b) => b.ratio - a.ratio)
        .map(item => {
            const pct   = (item.ratio * 100).toFixed(1);
            const fill  = item.ratio >= 0.999 ? '#c0392b'
                        : item.ratio >= 0.75  ? '#e67e22'
                        : '#2980b9';
            return `<div class="mb-2">
                <div class="d-flex justify-content-between mb-0" style="font-size:0.85em;">
                    <span>${esc(item.label)}</span>
                    <span class="text-muted">${item.used.toFixed(1)} / ${item.capacity.toFixed(1)} mmol·gDW⁻¹·h⁻¹
                        &nbsp;<strong style="color:${fill};">${pct}%</strong></span>
                </div>
                <div style="background:#dce3ea;border-radius:4px;height:10px;overflow:hidden;">
                    <div style="width:${pct}%;background:${fill};height:10px;border-radius:4px;transition:width .3s;"></div>
                </div>
            </div>`;
        }).join('');

    const div = document.createElement('div');
    div.className = 'alert alert-info py-2 px-3 mb-1';
    div.style.fontSize = '0.82em';
    div.innerHTML = `
        <div style="cursor:pointer;" data-toggle="collapse" data-target="#${uid}">
            <i class="fa fa-info-circle"></i> <strong>What is limiting growth?</strong>
            <i class="fa fa-chevron-down float-right mt-1" style="font-size:0.85em;"></i>
        </div>
        <div class="mt-1">${sentence}</div>
        <div class="collapse mt-2" id="${uid}">
            <hr class="my-1">
            <div class="mb-2" style="font-size:0.85em;font-weight:600;">Resource utilisation (% of set bound)</div>
            ${barsHtml}
            <div class="text-muted mt-1" style="font-size:0.78em;">
                <span style="display:inline-block;width:10px;height:10px;background:#c0392b;border-radius:2px;"></span> 100% — limiting &nbsp;
                <span style="display:inline-block;width:10px;height:10px;background:#e67e22;border-radius:2px;"></span> 75–99% — near-limiting &nbsp;
                <span style="display:inline-block;width:10px;height:10px;background:#2980b9;border-radius:2px;"></span> &lt;75% — not limiting
            </div>
        </div>`;
    box.appendChild(div);
}

// ── FBA flux table with sparklines ────────────────────────────────────────────
function populateFBATable(fluxes) {
    const sorted  = Object.entries(fluxes).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const maxAbs  = Math.abs(sorted[0]?.[1] || 1);
    const tbody   = document.querySelector('#fba-flux-table tbody');
    const subsystemLookup = {};
    allReactions.forEach(r => { subsystemLookup[r.id] = r.subsystem || ''; });

    tbody.innerHTML = sorted.map(([id, v]) => {
        const pct      = Math.min(Math.abs(v) / maxAbs * 100, 100).toFixed(1);
        const barColor = v >= 0 ? '#4e8dc7' : '#c0392b';
        const valClass = v >= 0 ? 'text-primary' : 'text-danger';
        const sub      = subsystemLookup[id] || '';

        return `<tr data-subsystem="${esc(sub)}">
            <td><code>${esc(id)}</code></td>
            <td style="font-size:0.82em;">${esc(rxnNameMap[id] || '—')}</td>
            <td class="${valClass}" style="white-space:nowrap;">${v.toFixed(4)}</td>
            <td>
                <div class="sparkbar-wrap">
                    <div class="sparkbar-fill" style="width:${pct}%;background:${barColor};"></div>
                </div>
            </td>
        </tr>`;
    }).join('');

    // Reset search filter and count label
    const searchEl = document.getElementById('fba-flux-search');
    if (searchEl) searchEl.value = '';
    const countEl = document.getElementById('fba-flux-count');
    if (countEl) countEl.textContent = `${sorted.length} reactions`;
}

// ── Model subsystem activity bar chart ────────────────────────────────────────
function renderModelSubsystemChart(fluxes) {
    const totals = {};
    allReactions.forEach(r => {
        if (!r.subsystem) return;
        const f = Math.abs(fluxes[r.id] || 0);
        if (f < 1e-9) return;
        totals[r.subsystem] = (totals[r.subsystem] || 0) + f;
    });

    const sorted = Object.entries(totals)
        .sort((a, b) => b[1] - a[1]);

    const labels = sorted.map(([k]) => k);
    const values = sorted.map(([, v]) => parseFloat(v.toFixed(3)));

    const colors = values.map((_, i) =>
        i < 5 ? 'rgba(153, 102, 51, 0.8)' : 'rgba(130, 130, 180, 0.6)'
    );

    const innerEl = document.getElementById('model-subsystem-chart-inner');
    innerEl.style.height = Math.max(300, labels.length * 22 + 60) + 'px';

    const ctx = document.getElementById('model-subsystem-chart').getContext('2d');
    if (modelSubsystemChart) modelSubsystemChart.destroy();

    modelSubsystemChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: values,
                backgroundColor: colors,
                borderColor: colors.map(c => c.replace('0.8', '1').replace('0.6', '1')),
                borderWidth: 1,
            }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => ` ${ctx.raw} mmol·gDW⁻¹·h⁻¹ (Σ|flux|)`,
                    }
                }
            },
            scales: {
                x: {
                    type: 'logarithmic',
                    title: { display: true, text: 'Total absolute flux (mmol·gDW⁻¹·h⁻¹) — log scale' },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                },
                y: {
                    ticks: { font: { size: 11 } }
                }
            }
        }
    });

    document.getElementById('model-subsystem-chart-wrap').style.display = '';
}

function toggleChartScale() {
    const chart = modelSubsystemChart;
    if (!chart) return;
    const isLog = document.getElementById('subsystem-chart-log').checked;
    const newType = isLog ? 'logarithmic' : 'linear';
    const label = 'Total absolute flux (mmol·gDW⁻¹·h⁻¹)' + (isLog ? ' — log scale' : '');
    chart.options.scales.x.type = newType;
    chart.options.scales.x.title.text = label;
    chart.update();
}

// ── Condition presets ─────────────────────────────────────────────────────────
function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;

    // Set constrained checkbox
    document.getElementById('fba-constrained-chk').checked = p.constrained;

    // Clear existing constraint rows
    document.getElementById('constraint-rows').innerHTML = '';

    // Add a row for each preset constraint
    Object.entries(p.constraints).forEach(([rxnId, bounds]) => {
        addConstraintRow();
        const rows = document.querySelectorAll('.constraint-row');
        const row  = rows[rows.length - 1];
        row.querySelector('.c-rxn-id').value = rxnId;
        if (bounds.lb != null) row.querySelector('.c-lb').value = bounds.lb;
        if (bounds.ub != null) row.querySelector('.c-ub').value = bounds.ub;
    });

    // Show description as a small info box
    const box = document.getElementById('fba-result-box');
    box.innerHTML = `<div class="alert alert-info alert-sm py-1 mb-1">
        <strong>${esc(p.label)}:</strong> ${esc(p.description)}
    </div>`;

    // Highlight active preset button
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.toggle('btn-primary', btn.dataset.preset === name);
        btn.classList.toggle('btn-outline-primary', btn.dataset.preset !== name);
    });
}

// ── Lazy-load SheetJS on first export use ─────────────────────────────────────
let _xlsxLoaded = false;
function _ensureXLSX(cb) {
    if (_xlsxLoaded || typeof XLSX !== 'undefined') { _xlsxLoaded = true; cb(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js';
    s.onload = () => { _xlsxLoaded = true; cb(); };
    document.head.appendChild(s);
}

// ── Export FBA (unified: current run + saved scenarios) ───────────────────────
function exportFBA() {
    _ensureXLSX(_doExportFBA);
}
function _doExportFBA() {
    const hasCurrentFBA = Object.keys(lastFluxes).length > 0;
    const scenarios     = _scenarioLoad();
    if (!hasCurrentFBA && !scenarios.length) {
        alert('Run FBA first to generate flux data for export.');
        return;
    }

    const SLIDER_LABELS = {
        'sim-I0':            'I₀ — incident irradiance (µmol·m⁻²·s⁻¹)',
        'sim-XA':            'X_A — areal biomass (g·m⁻²)',
        'sim-alpha':         'α — photon absorption',
        'sim-KL':            'K_L — half-sat. irradiance (µmol·m⁻²·s⁻¹)',
        'sim-YBM':           'Y_BM — biomass yield (g·mol⁻¹)',
        'sim-kd':            'k_d — decay rate (h⁻¹)',
        'sim-ngam-photon':   'NGAM (photon µmol·gDW⁻¹·h⁻¹)',
        'sim-rho0':          'ρ₀ — initial biomass (g·L⁻¹)',
        'sim-tend':          't_end — simulation end (h)',
        'sim-yx':            'Y_X — product yield (mmol·gDW⁻¹)',
        'med-co2':           'CO₂ (mmol·gDW⁻¹·h⁻¹)',
        'med-no3':           'NO₃⁻ (mmol·gDW⁻¹·h⁻¹)',
        'med-nh4':           'NH₄⁺ (mmol·gDW⁻¹·h⁻¹)',
        'med-glc':           'Glucose (mmol·gDW⁻¹·h⁻¹)',
        'med-pi':            'Phosphate (mmol·gDW⁻¹·h⁻¹)',
        'med-so4':           'Sulfate (mmol·gDW⁻¹·h⁻¹)',
        'med-fe2':           'Iron (mmol·gDW⁻¹·h⁻¹)',
        'med-mn2':           'Manganese (mmol·gDW⁻¹·h⁻¹)',
        'med-zn2':           'Zinc (mmol·gDW⁻¹·h⁻¹)',
        'med-cu2':           'Copper (mmol·gDW⁻¹·h⁻¹)',
    };

    const subsystemLookup = {};
    allReactions.forEach(r => { subsystemLookup[r.id] = r.subsystem || ''; });

    // Build the list of columns: current run first, then saved scenarios
    const currentLabel = 'Current run';
    const cols = [];   // [{ label, fluxes }]
    if (hasCurrentFBA) cols.push({ label: currentLabel, fluxes: lastFluxes });
    scenarios.forEach(sc => cols.push({ label: sc.name, fluxes: sc.fba_result?.fluxes || {} }));
    const colLabels = cols.map(c => c.label);


    // ── Sheet 1: Parameters ───────────────────────────────────────────────────
    // Only meaningful if there are saved scenarios (current run has no saved sliders)
    const wb = XLSX.utils.book_new();

    if (scenarios.length > 0) {
        const scCols = scenarios.map(sc => sc.name);
        const rows1 = [['Parameter', ...scCols]];
        Object.keys(SLIDER_LABELS).forEach(id => {
            rows1.push([SLIDER_LABELS[id], ...scenarios.map(sc => sc.sliders?.[id] ?? '')]);
        });
        rows1.push(['Gene knockouts (FBA)', ...scenarios.map(sc => (sc.ko_genes || []).join(', ') || 'none')]);
        rows1.push(['Custom reactions',     ...scenarios.map(sc => (sc.custom_reactions || []).map(r => r.id).join(', ') || 'none')]);
        rows1.push(['FBA growth rate µ (h⁻¹)', ...scenarios.map(sc => sc.mu_fba ?? '')]);
        rows1.push(['Saved at',             ...scenarios.map(sc => sc.timestamp ? new Date(sc.timestamp).toLocaleString() : '')]);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows1), 'Parameters');
    }

    // ── Sheet 2: Reaction fluxes ──────────────────────────────────────────────
    const rxnIds = new Set();
    cols.forEach(c => Object.entries(c.fluxes).forEach(([id, v]) => { if (Math.abs(v) > 1e-9) rxnIds.add(id); }));

    const rows2 = [['Reaction ID', 'Reaction name', 'Model subsystem', 'KEGG pathway(s)', 'KEGG pathway ID(s)', ...colLabels]];
    [...rxnIds]
        .sort((a, b) => {
            const maxA = Math.max(...cols.map(c => Math.abs(c.fluxes[a] || 0)));
            const maxB = Math.max(...cols.map(c => Math.abs(c.fluxes[b] || 0)));
            return maxB - maxA;
        })
        .forEach(id => {
            const pathways = reactionPathwayIndex[id] || [];
            rows2.push([
                id, rxnNameMap[id] || '', subsystemLookup[id] || '',
                pathways.map(p => p.pathway_name).join('; '),
                pathways.map(p => p.pathway_id).join('; '),
                ...cols.map(c => c.fluxes[id] ?? ''),
            ]);
        });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows2), 'Reaction fluxes');

    // ── Sheet 3: Metabolic module summary ─────────────────────────────────────
    const subsysLookup = {};
    allReactions.forEach(r => { subsysLookup[r.id] = r.subsystem || ''; });

    function calcSubsystemTotals(fluxes) {
        const t = {};
        Object.entries(fluxes).forEach(([id, v]) => {
            if (Math.abs(v) < 1e-9) return;
            const s = subsysLookup[id];
            if (!s) return;
            t[s] = (t[s] || 0) + Math.abs(v);
        });
        return t;
    }

    const colSubTotals = cols.map(c => calcSubsystemTotals(c.fluxes));
    const subsystemNames = new Set();
    colSubTotals.forEach(t => Object.keys(t).forEach(k => subsystemNames.add(k)));
    const sortedSubsystems = [...subsystemNames].sort((a, b) =>
        Math.max(...colSubTotals.map(t => t[b] || 0)) - Math.max(...colSubTotals.map(t => t[a] || 0))
    );

    const rows3 = [['Metabolic module', ...colLabels]];
    sortedSubsystems.forEach(name => {
        rows3.push([name, ...colSubTotals.map(t => t[name] != null ? parseFloat(t[name].toFixed(4)) : '')]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows3), 'Metabolic module summary');

    const filename = scenarios.length > 0 ? 'fba_scenarios_iRH783.xlsx' : 'fba_fluxes_iRH783.xlsx';
    XLSX.writeFile(wb, filename);
}

// ── KEGG Mapper ───────────────────────────────────────────────────────────────
function loadKeggPathways() {
    fetch('/api/metabolic/kegg_pathways')
        .then(r => r.json())
        .then(pathways => {
            // Populate FBA tab KEGG dropdown
            const sel = document.getElementById('kegg-pathway-select');
            if (sel) {
                pathways.forEach(p => {
                    const o = document.createElement('option');
                    o.value = p.id;
                    o.textContent = p.name;
                    sel.appendChild(o);
                });
            }
            // Populate Network tab pathway map dropdown
            const mapSel = document.getElementById('kegg-map-select');
            if (mapSel) {
                mapSel.innerHTML = '<option value="">— select a KEGG pathway —</option>';
                pathways.forEach(p => {
                    const o = document.createElement('option');
                    o.value = p.id;
                    o.textContent = `${p.name} (${p.id})`;
                    mapSel.appendChild(o);
                });
            }
        })
        .catch(() => {});   // non-fatal
}

function openKegg() {
    if (!Object.keys(lastFluxes).length) {
        alert('Run FBA first to generate flux data for pathway colouring.');
        return;
    }
    const pathway = document.getElementById('kegg-pathway-select').value;

    // Navigate to Network tab → Pathways sub-tab
    const networkTab = document.querySelector('[href="#tab-network"]');
    if (networkTab) networkTab.click();
    const pathTab = document.querySelector('#network-sub-tabs a[href="#sub-pathways"]');
    if (pathTab) pathTab.click();

    // Set the pathway dropdown in the Network tab if one was selected
    if (pathway) {
        const mapSel = document.getElementById('kegg-map-select');
        if (mapSel) {
            mapSel.value = pathway;
            loadKeggMap();
        }
    }
}

// ── iPath3 global overview ────────────────────────────────────────────────────
function loadIpath3() {
    if (!Object.keys(lastFluxes).length) {
        alert('Run FBA first to generate flux data for the global map.');
        return;
    }
    const btn = document.getElementById('ipath3-btn');
    const panel = document.getElementById('ipath3-panel');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Loading iPath3…';
    panel.style.display = 'none';
    panel.innerHTML = '';

    fetch('/api/metabolic/ipath3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fluxes: lastFluxes }),
    })
    .then(r => r.json())
    .then(d => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-globe"></i> Global map (iPath3)';
        if (d.svg) {
            panel.innerHTML = d.svg +
                `<p class="text-muted small mt-1 mb-0">${d.reactions_colored} KEGG reactions coloured by flux</p>`;
            panel.style.display = 'block';
        } else {
            alert('iPath3 error: ' + (d.error || 'unknown'));
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-globe"></i> Global map (iPath3)';
        console.error('iPath3 error:', err);
    });
}

// ── Constraint rows ───────────────────────────────────────────────────────────
function addConstraintRow() {
    const div = document.createElement('div');
    div.className = 'form-row mb-1 align-items-center constraint-row';
    div.innerHTML = `
        <div class="col-5">
            <input class="form-control form-control-sm c-rxn-id" placeholder="e.g. EX_co2_e">
        </div>
        <div class="col-3">
            <input class="form-control form-control-sm c-lb" placeholder="lb" type="number" step="any">
        </div>
        <div class="col-3">
            <input class="form-control form-control-sm c-ub" placeholder="ub" type="number" step="any">
        </div>
        <div class="col-1">
            <button class="btn btn-sm btn-outline-danger py-0 px-1"
                    onclick="this.closest('.constraint-row').remove()">×</button>
        </div>`;
    document.getElementById('constraint-rows').appendChild(div);
}

// ── Table filtering ───────────────────────────────────────────────────────────
function filterTable(tableId, inputId, countLabelId) {
    const q    = document.getElementById(inputId).value.toLowerCase();
    const rows = document.querySelectorAll(`#${tableId} tbody tr`);
    let shown  = 0;
    rows.forEach(row => {
        // Also search data-subsystem attribute when present (FBA flux table)
        const haystack = row.textContent.toLowerCase() +
            (row.dataset.subsystem ? ' ' + row.dataset.subsystem.toLowerCase() : '');
        const visible = haystack.includes(q);
        row.style.display = visible ? '' : 'none';
        if (visible) shown++;
    });
    const label = document.getElementById(countLabelId);
    if (label) label.textContent = q ? `${shown} / ${rows.length} shown` : `${rows.length} reactions`;
}

// ── Analysis tab wiring ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('run-en-btn').addEventListener('click', runEnergetics);
    document.getElementById('run-en-btn-met')?.addEventListener('click', runEnergeticsFromMet);
    document.getElementById('run-en-recomb-btn')?.addEventListener('click', runEnergeticsRecomb);
    document.getElementById('bc-recomb-template')?.addEventListener('change', bcRecombOnTemplateChange);
    document.getElementById('bc-recomb-apply-btn')?.addEventListener('click', bcRecombApplyCustom);
    document.getElementById('run-efe-protein-btn')?.addEventListener('click', runEfeProteinCost);

    // Reference lock / clear buttons
    document.getElementById('en-lock-btn').addEventListener('click',  () => lockRef('en'));
    document.getElementById('en-clear-btn').addEventListener('click', () => clearRef('en'));

    // Target-type toggle (reaction vs metabolite)
    document.querySelectorAll('input[name="bc-target-type"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const byMet = radio.value === 'metabolite';
            document.getElementById('bc-rxn-section').style.display = byMet ? 'none' : '';
            document.getElementById('bc-met-section').style.display = byMet ? ''     : 'none';
        });
    });

    // Init metabolite browser (needs allMetabolites to be loaded first — called again after load)
    bcInitMetBrowser();

    // Biosynthetic Cost mode toggle — update description text
    document.querySelectorAll('input[name="bc-mode"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const dep  = radio.value === 'dependent';
            const desc = document.getElementById('bc-mode-desc-text');
            if (!desc) return;
            if (dep) {
                if (bcSimState) {
                    desc.innerHTML = `<i class="fa fa-link"></i> Using simulation state: D<sub>opt</sub> = ${bcSimState.D_opt.toFixed(4)} h⁻¹, I₀ = ${bcSimState.I0} µmol·m⁻²·s⁻¹. Growth fixed; cost per mmol of target reaction flux.`;
                } else {
                    desc.innerHTML = `<i class="fa fa-exclamation-triangle text-warning"></i> No simulation run yet — run a chemostat simulation first, then switch to this mode.`;
                }
            } else {
                desc.innerHTML = `<i class="fa fa-info-circle"></i> Growth unconstrained — pFBA naturally minimises it to ~0 when maximising product. Cost normalised per mmol of target reaction flux.`;
            }
        });
    });

    // Custom reactions
    document.getElementById('cr-add-template-btn').addEventListener('click', crAddTemplate);
    document.getElementById('cr-add-manual-btn').addEventListener('click', () => {
        document.getElementById('cr-manual-form').style.display = '';
    });
    document.getElementById('cr-kegg-lookup-btn').addEventListener('click', crLookupKegg);
    document.getElementById('cr-man-cancel-btn').addEventListener('click', () => {
        document.getElementById('cr-manual-form').style.display = 'none';
    });
    document.getElementById('cr-man-add-btn').addEventListener('click', crAddManual);
    document.getElementById('cr-clear-all-btn').addEventListener('click', crClearAll);

    // Sim card actions
    document.getElementById('sim-fit-btn')?.addEventListener('click', simFitToFBA);
    document.getElementById('sim-run-ls-btn')?.addEventListener('click', runLightSweep);
    document.getElementById('sim-saveref-btn')?.addEventListener('click', simSaveRef);
    document.getElementById('sim-clearref-btn')?.addEventListener('click', simClearRef);
    document.getElementById('sim-loadhoper-btn')?.addEventListener('click', simLoadHoper);
    document.getElementById('sim-clear-fba-marker-btn')?.addEventListener('click', simClearFbaMarker);
});

// run-fba-btn wired in the main DOMContentLoaded block below

function runFBAwithPFBA() {
    const btn = document.getElementById('run-fba-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Running…';

    const usePfba     = document.getElementById('pfba-chk').checked;
    const constraints = getMediumConstraints();

    fetch('/api/metabolic/fba', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ constrained: true, constraints, pfba: usePfba, custom_reactions: customReactions, knockout_genes: simKoGetGenes() }),
    })
    .then(r => r.json())
    .then(d => {
        const box = document.getElementById('fba-result-box');
        if (d.status === 'optimal') {
            const pfbaNote = d.pfba ? ' <span class="badge badge-info">pFBA</span>' : '';
            box.innerHTML = `<div class="alert alert-success mb-1">
                <strong>Growth rate: ${d.objective} h⁻¹</strong>${pfbaNote}
                <span class="float-right text-muted small">${Object.keys(d.fluxes).length} active reactions</span>
            </div>`;
            lastFluxes = d.fluxes;
            _lastFbaResultForSummary = {
                growth_rate:      parseFloat(d.objective),
                sliders:          Object.fromEntries(
                    ['sim-I0','sim-XA','sim-alpha','sim-KL','sim-YBM','sim-kd','sim-ngam-photon',
                     'med-co2','med-no3','med-nh4','med-glc','med-pi','med-so4','med-fe2','med-mn2','med-zn2','med-cu2']
                    .map(id => {
                        const el = document.getElementById(id);
                        return [id, el ? parseFloat(el.value) : null];
                    })
                ),
                ko_genes:         simKoGetGenes(),
                custom_reactions: JSON.parse(JSON.stringify(customReactions)),
            };
            _staticFbaHasRun = true;
            updateTabGates();
            renderLimitingConstraints(d.fluxes, constraints);
            populateFBATable(d.fluxes);
            renderModelSubsystemChart(d.fluxes);
            simMarkFBAPoint(d.objective, d.fluxes);
            document.getElementById('fba-flux-wrap').style.display = '';
            if (keggHotspots.length > 0) applyKeggFlux(d.fluxes);
        } else {
            box.innerHTML = `<div class="alert alert-warning mb-1">
                Optimisation status: <strong>${d.status}</strong>
                <span class="d-block small text-muted mt-1">Check your bounds.</span>
            </div>`;
            document.getElementById('fba-flux-wrap').style.display = 'none';
        }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run static FBA';
    })
    .catch(err => {
        console.error('FBA error:', err);
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run static FBA';
    });
}

// ── Analysis: reference state (energetics only) ───────────────────────────────
let enLastData = null, enRefData = null, enRefLabel = '';

function lockRef(pfx) {
    if (pfx !== 'en') return;
    if (!enLastData) return;
    const label = captureRefLabel('en');
    enRefData = enLastData; enRefLabel = label; renderEnergetics(enLastData);
    document.getElementById('en-ref-badge-text').textContent = label;
    document.getElementById('en-ref-badge').style.display = '';
    document.getElementById('en-clear-btn').style.display = '';
}

function clearRef(pfx) {
    if (pfx !== 'en') return;
    enRefData = null; enRefLabel = '';
    if (enLastData) renderEnergetics(enLastData);
    document.getElementById('en-ref-badge').style.display = 'none';
    document.getElementById('en-clear-btn').style.display = 'none';
}

function captureRefLabel(pfx) {
    const constrained = document.getElementById(`${pfx}-constrained`)?.checked;
    const base = constrained ? 'autotrophic' : 'unconstrained';
    if (pfx === 'en') return `${document.getElementById('en-rxn').value.trim()}, ${base}`;
    return base;
}

function showRefBar(pfx) {
    document.getElementById(`${pfx}-ref-bar`).style.display = 'flex';
}

// ── Chart instances ───────────────────────────────────────────────────────────
let enChart = null;

// ── FBA light sweep ───────────────────────────────────────────────────────────
let _expData       = null;   // [{I0, mu, mu_err, X_A}] parsed experimental points, or null
let _expDataXA     = 0;      // mean X_A from exp data (0 if not provided — dilute assumption)
let simFbaData     = null;   // last FBA sweep result {points}
let _sweepLocked   = false;  // when true, Run button is disabled to preserve current sweep
let simFbaPoints   = null;   // [{I, mu}] converted with current α for growth curve overlay
let simFbaGrowthChart = null, simFbaYieldChart = null, simFbaO2Chart = null;
let simHoperYieldChart = null, simHoperO2Chart = null;
let _sweepAugPts   = null;   // FBA sweep points augmented with I0 + hoperMu
let _fbaYieldXMode   = 'photon';   // 'photon' | 'mu'  — left yield/O2 charts
let _hoperYieldXMode = 'photon';   // 'photon' | 'mu'  — right yield/O2 charts

// ── Product tracking globals ───────────────────────────────────────────────────
let _trackedProductReaction = null;    // reaction ID selected for product tracking
let _sweepProductFlux       = null;    // [{I0, v}] I0 µmol·m⁻²·s⁻¹, v mmol·gDW⁻¹·h⁻¹
let _expProductData         = null;    // [{I0, q_product}] from experimental upload
let _empiricalProductFit    = null;    // {q_max, K_prod} Monod fit params
let _productFluxSource      = 'manual';// 'manual' | 'fba_sweep' | 'empirical'
let simFbaProductChart      = null;

// Plugin: pin chartArea.top so the plot area height is identical regardless of legend size
const fixedPlotTopPlugin = {
    id: 'fixedPlotTop',
    beforeDraw(chart) {
        const reserved = chart.options.plugins?.fixedPlotTop?.reservedTop;
        if (reserved !== undefined) chart.chartArea.top = reserved;
    },
};

function toggleSweepLock() {
    _sweepLocked = !_sweepLocked;
    const lockBtn = document.getElementById('sim-sweep-lock-btn');
    const runBtn  = document.getElementById('sim-run-ls-btn');
    if (lockBtn) {
        lockBtn.innerHTML = _sweepLocked
            ? '<i class="fa fa-lock"></i> Locked'
            : '<i class="fa fa-unlock"></i> Lock';
        lockBtn.classList.toggle('btn-warning',  _sweepLocked);
        lockBtn.classList.toggle('btn-outline-secondary', !_sweepLocked);
    }
    if (runBtn) runBtn.disabled = _sweepLocked;
}

// ── Product tracking functions ─────────────────────────────────────────────────

function setTrackedProductReaction(rxnId) {
    _trackedProductReaction = rxnId || null;
    _sweepProductFlux = null;   // old sweep data no longer valid for new tracked rxn
    updateProductSourceUI();
    simRecompute();
}

function setProductSource(src) {
    _productFluxSource = src;
    updateProductSourceUI();
    simRecompute();
}

function updateProductSourceUI() {
    // Populate tracking dropdown from current custom reactions
    const trackSelect = document.getElementById('sweep-track-rxn-select');
    const trackWrap   = document.getElementById('sim-pg-track-product');
    if (trackSelect && trackWrap) {
        trackWrap.style.display = customReactions.length > 0 ? '' : 'none';
        const prevVal = _trackedProductReaction;
        trackSelect.innerHTML = '<option value="">— none —</option>' +
            customReactions.map(r =>
                `<option value="${esc(r.id)}"${r.id === prevVal ? ' selected' : ''}>${esc(r.id)}${r.name ? ' \u2014 ' + esc(r.name) : ''}</option>`
            ).join('');
    }

    // Enable/disable source buttons
    const fbaSrcBtn = document.getElementById('prod-src-fba-btn');
    const empSrcBtn = document.getElementById('prod-src-empirical-btn');
    if (fbaSrcBtn) fbaSrcBtn.disabled = !(_sweepProductFlux && _sweepProductFlux.length >= 2);
    if (empSrcBtn) empSrcBtn.disabled = !_empiricalProductFit;

    // If currently selected source became unavailable, revert to manual
    if (_productFluxSource === 'fba_sweep' && !(fbaSrcBtn && !fbaSrcBtn.disabled)) _productFluxSource = 'manual';
    if (_productFluxSource === 'empirical' && !(empSrcBtn && !empSrcBtn.disabled)) _productFluxSource = 'manual';

    // Active state on buttons
    ['manual', 'fba_sweep', 'empirical'].forEach(s => {
        const key = s === 'fba_sweep' ? 'fba' : s;
        const btn = document.getElementById(`prod-src-${key}-btn`);
        if (btn) btn.classList.toggle('active', _productFluxSource === s);
    });

    // Show/hide sections
    const show = id => { const el = document.getElementById(id); if (el) el.style.display = ''; };
    const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
    if (_productFluxSource === 'manual')     { show('prod-manual-section'); hide('prod-fba-section'); hide('prod-empirical-section'); }
    else if (_productFluxSource === 'fba_sweep') { hide('prod-manual-section'); show('prod-fba-section'); hide('prod-empirical-section'); }
    else                                     { hide('prod-manual-section'); hide('prod-fba-section'); show('prod-empirical-section'); }

    // Update FBA section reaction name badge
    const rxnNameEl = document.getElementById('prod-fba-rxn-name');
    if (rxnNameEl) rxnNameEl.textContent = _trackedProductReaction || '—';
}

// Returns specific product flux (mmol·gDW⁻¹·h⁻¹) at local irradiance I0_local (µmol·m⁻²·s⁻¹).
// Returns null when source is 'manual' (caller falls back to Y_X).
function getProductFluxAtI0(I0_local) {
    if (_productFluxSource === 'empirical' && _empiricalProductFit) {
        const { q_max, K_prod } = _empiricalProductFit;
        return Math.max(0, q_max * I0_local / (K_prod + I0_local));
    }
    if (_productFluxSource === 'fba_sweep' && _sweepProductFlux && _sweepProductFlux.length >= 2) {
        const pts = _sweepProductFlux;
        if (I0_local <= pts[0].I0)                return Math.max(0, pts[0].v);
        if (I0_local >= pts[pts.length - 1].I0)   return Math.max(0, pts[pts.length - 1].v);
        for (let i = 1; i < pts.length; i++) {
            if (I0_local <= pts[i].I0) {
                const t = (I0_local - pts[i-1].I0) / (pts[i].I0 - pts[i-1].I0);
                return Math.max(0, pts[i-1].v + t * (pts[i].v - pts[i-1].v));
            }
        }
    }
    return null;
}

function fitEmpiricalProductModel() {
    if (!_expProductData || _expProductData.length < 2) return;
    const pts = _expProductData.filter(p => p.q_product > 0 && p.I0 > 0);
    if (pts.length < 2) return;

    // Grid search for Monod fit: q_max * I0 / (K_prod + I0)
    let bestCost = Infinity, bestQ = 0.1, bestK = 100;
    for (let qi = 0; qi < 30; qi++) {
        const q = 0.0001 * Math.pow(100000, qi / 29);
        for (let ki = 0; ki < 30; ki++) {
            const k = 0.5 * Math.pow(4000, ki / 29);
            const cost = pts.reduce((s, p) => { const pred = q * p.I0 / (k + p.I0); return s + (pred - p.q_product) ** 2; }, 0);
            if (cost < bestCost) { bestCost = cost; bestQ = q; bestK = k; }
        }
    }
    // Nelder-Mead refinement in log space
    const logCost = ([lq, lk]) => {
        const q = Math.exp(lq), k = Math.exp(lk);
        return pts.reduce((s, p) => { const pred = q * p.I0 / (k + p.I0); return s + (pred - p.q_product) ** 2; }, 0);
    };
    const nm = nelderMead2D(logCost, [Math.log(bestQ), Math.log(bestK)]);
    bestQ = Math.exp(nm[0]);
    bestK = Math.exp(nm[1]);

    _empiricalProductFit = { q_max: bestQ, K_prod: bestK };

    // Compute R² for display
    const muMean = pts.reduce((s, p) => s + p.q_product, 0) / pts.length;
    const ssTot  = pts.reduce((s, p) => s + (p.q_product - muMean) ** 2, 0);
    const ssRes  = pts.reduce((s, p) => { const pred = bestQ * p.I0 / (bestK + p.I0); return s + (pred - p.q_product) ** 2; }, 0);
    const r2     = ssTot > 0 ? 1 - ssRes / ssTot : 0;

    const qualEl = document.getElementById('prod-empirical-quality');
    if (qualEl) qualEl.textContent = `q_max = ${bestQ.toFixed(4)} mmol·gDW⁻¹·h⁻¹,  K = ${bestK.toFixed(0)} µmol·m⁻²·s⁻¹,  R² = ${r2.toFixed(3)}`;

    updateProductSourceUI();
}

// Simple 2-parameter Nelder-Mead for the empirical fit
function nelderMead2D(f, x0, maxIter = 400) {
    const α = 1, γ = 2, ρ = 0.5, σ = 0.5;
    let s = [x0, [x0[0] + 0.3, x0[1]], [x0[0], x0[1] + 0.3]];
    for (let iter = 0; iter < maxIter; iter++) {
        s.sort((a, b) => f(a) - f(b));
        const c = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2];
        const xr = [c[0] + α * (c[0] - s[2][0]), c[1] + α * (c[1] - s[2][1])];
        if (f(xr) < f(s[0])) {
            const xe = [c[0] + γ * (xr[0] - c[0]), c[1] + γ * (xr[1] - c[1])];
            s[2] = f(xe) < f(xr) ? xe : xr;
        } else if (f(xr) < f(s[1])) {
            s[2] = xr;
        } else {
            const xc = [c[0] + ρ * (s[2][0] - c[0]), c[1] + ρ * (s[2][1] - c[1])];
            if (f(xc) < f(s[2])) { s[2] = xc; }
            else { s = [s[0], [s[0][0] + σ*(s[1][0]-s[0][0]), s[0][1] + σ*(s[1][1]-s[0][1])], [s[0][0] + σ*(s[2][0]-s[0][0]), s[0][1] + σ*(s[2][1]-s[0][1])]]; }
        }
    }
    return s[0];
}

function runLightSweep() {
    if (_sweepLocked) return Promise.resolve(simFbaData);
    const btn = document.getElementById('sim-run-ls-btn');
    if (!btn) return Promise.reject(new Error('sim-run-ls-btn not found'));
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Running…';
    const errEl = document.getElementById('sim-fba-error');
    if (errEl) errEl.style.display = 'none';

    const knockout_genes = simKoGetGenes();

    const alpha   = parseFloat(document.getElementById('sim-alpha')?.value) || 0.13;
    const KL      = parseFloat(document.getElementById('sim-KL')?.value)    || 119;
    const iMinUm  = parseFloat(document.getElementById('sim-ls-imin')?.value)  || 10;
    const iMaxUm  = parseFloat(document.getElementById('sim-ls-imax')?.value)  || 1200;
    return fetch('/api/metabolic/light_sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            i_min:            iMinUm * alpha * 3.6,   // convert µmol·m⁻²·s⁻¹ → mmol·gDW⁻¹·h⁻¹
            i_max:            iMaxUm * alpha * 3.6,
            steps:            parseInt(document.getElementById('sim-ls-steps')?.value)   || 40,
            constrained:      document.getElementById('sim-ls-constrained')?.checked ?? true,
            custom_reactions: customReactions,
            knockout_genes,
            alpha,
            KL,
            tracked_reaction: _trackedProductReaction || null,
        }),
    })
    .then(r => r.json())
    .then(d => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run';
        if (d.error) {
            if (errEl) { errEl.style.display = ''; errEl.textContent = d.error; }
            return d;
        }
        simFbaData = d;
        // Convert to I/mu pairs using current α for growth curve overlay
        const alpha = +document.getElementById('sim-alpha').value || 0.13;
        simFbaPoints = d.points
            .filter(p => p.growth > 1e-4)
            .map(p => ({ I: p.photon / (alpha * 3.6), mu: p.growth }));
        // Extract product flux table when a reaction was tracked
        if (_trackedProductReaction && d.points.some(p => p.product_flux != null)) {
            _sweepProductFlux = d.points
                .filter(p => p.growth > 1e-4 && p.product_flux != null)
                .map(p => ({ I0: p.photon / (alpha * 3.6), v: Math.max(0, p.product_flux) }));
            if (_sweepProductFlux.length < 2) _sweepProductFlux = null;
            if (_sweepProductFlux && _productFluxSource === 'manual') _productFluxSource = 'fba_sweep';
        } else {
            _sweepProductFlux = null;
        }
        renderSimFbaSweep(d);
        updateProductSourceUI();
        simRecompute();   // redraw growth curve with FBA overlay
        _lightSweepHasRun = true;
        updateTabGates();
        return d;
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run';
        if (errEl) { errEl.style.display = ''; errEl.textContent = err.message; }
        throw err;
    });
}

/** Generate Höper 2024 analytical growth curve points over [0, Imax] in I₀ space. */
function simHoepCurve(Imax) {
    const p = simGetParams();
    const N = 250;
    const pts = [];
    for (let i = 0; i <= N; i++) {
        const I = (i / N) * Imax;
        pts.push({ x: I, y: Math.max(0, simHoperMu(I, 0, p.alpha, p.KL, p.YBM, p.kd, p.ngam_photon, 0)) });
    }
    return pts;
}

/** Refresh the unconstrained linear line on the FBA sweep chart when Y_BM or α change. */
function updateFbaGrowthOverlay() {
    if (_sweepLocked) return;
    if (!simFbaGrowthChart) return;
    const ds3 = simFbaGrowthChart.data.datasets[2];
    if (!ds3) return;
    const p    = simGetParams();
    const xMax = Math.max(...simFbaGrowthChart.data.datasets[0].data.map(pt => pt.x), 200) * 1.05;
    ds3.data = [{ x: 0, y: 0 }, { x: xMax, y: p.YBM * 1e-3 * p.alpha * xMax * 3.6 }];
    const fbaYMax = Math.max(...simFbaGrowthChart.data.datasets[0].data.map(pt => pt.y),
                              ...ZAVREL_2019_DATA.map(d => d.mu)) * 1.2;
    simFbaGrowthChart.options.scales.y.max = fbaYMax;
    simFbaGrowthChart.update('none');

    // Refresh Höper µ on augmented sweep points and rebuild Höper yield/O₂ charts
    if (_sweepAugPts) {
        _sweepAugPts = _sweepAugPts.map(pt => ({
            ...pt,
            hoperMu: Math.max(0, simHoperMu(pt.I0, 0, p.alpha, p.KL, p.YBM, p.kd, p.ngam_photon, 0)),
        }));
        _buildHoperYieldCharts();
    }
}

function renderSimFbaSweep(d) {
    const pts    = d.points;
    const alpha  = parseFloat(document.getElementById('sim-alpha')?.value) || 0.13;
    const hasO2  = pts.some(p => p.o2 !== null && p.o2 !== 0);

    // Show charts, hide placeholder
    document.getElementById('sim-fba-placeholder').style.display  = 'none';
    document.getElementById('sim-fba-charts-wrap').style.display  = '';

    document.getElementById('sim-fba-o2-wrap').style.display = hasO2 ? '' : 'none';

    // Helper for yield / O₂ charts (x = photon flux, mmol·gDW⁻¹·h⁻¹)
    function ds(label, points, yKey, color, fillColor, isRef) {
        return {
            label,
            data: points.map(p => ({ x: p.photon, y: p[yKey] })),
            borderColor: isRef ? '#aaa' : color,
            backgroundColor: isRef ? 'rgba(0,0,0,0)' : fillColor,
            borderWidth: isRef ? 1.5 : 2,
            borderDash: isRef ? [5, 3] : [],
            pointRadius: isRef ? 0 : 2,
            fill: isRef ? false : false,
            tension: 0.3,
        };
    }

    // ── Growth rate chart — x-axis = I₀ (µmol·m⁻²·s⁻¹) ─────────────────────
    // FBA points converted from J_I back to I₀; Höper curve and exp. data in native I₀ units.
    const fbaPtsI0 = pts.filter(p => p.growth > 1e-4)
        .map(p => ({ x: p.photon / (alpha * 3.6), y: p.growth }));
    const I0_op   = parseFloat(document.getElementById('sim-I0')?.value) || 660;
    const xMax    = Math.max(...fbaPtsI0.map(p => p.x).concat(
        ZAVREL_2019_DATA.map(d => d.I)).concat([I0_op])
    ) * 1.05;
    const fbaYMax = Math.max(...fbaPtsI0.map(p => p.y),
                              ...ZAVREL_2019_DATA.map(d => d.mu)) * 1.2;
    const p_now = simGetParams();
    const muOp  = simHoperMu(I0_op, 0, p_now.alpha, p_now.KL, p_now.YBM, p_now.kd, p_now.ngam_photon, 0);

    const gDs = [
        {   // 0 — FBA sweep line
            label: 'Light sweep — FBA with QY correction (last run)',
            data: fbaPtsI0,
            borderColor: '#c0392b', backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 2, borderDash: [6, 3],
            pointRadius: 0, fill: false, tension: 0,
        },
        {   // 1 — Static FBA result marker (updated when static FBA runs)
            label: 'Static FBA (last run)',
            data: simFbaMarker ? [{ x: simFbaMarker.I0, y: simFbaMarker.growth }] : [],
            type: 'scatter',
            borderColor: '#e67e22', backgroundColor: '#e67e22',
            pointRadius: 7, pointStyle: 'triangle',
            hidden: !simFbaMarker,
        },
        {   // 2 — Unconstrained linear (no quantum yield, no damage): μ = Y_BM·α·I₀·3.6·10⁻³
            label: 'Light sweep — FBA unconstrained (last run)',
            data: [{ x: 0, y: 0 }, { x: xMax, y: p_now.YBM * 1e-3 * p_now.alpha * xMax * 3.6 }],
            borderColor: 'rgba(155,89,182,0.55)', backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 1.5, borderDash: [4, 4],
            pointRadius: 0, fill: false, tension: 0,
        },
        {   // 3 — Experimental data Zavřel 2019
            label: 'Reference data (Zavřel 2019)',
            data: ZAVREL_2019_DATA.map(d => ({ x: d.I, y: d.mu })),
            type: 'scatter',
            borderColor: '#1a64c8', backgroundColor: 'rgba(26,100,200,0.75)',
            pointRadius: 5, pointHoverRadius: 7, pointStyle: 'circle', showLine: false,
        },
    ];


    if (simFbaGrowthChart) { simFbaGrowthChart.destroy(); simFbaGrowthChart = null; }
    simFbaGrowthChart = new Chart(
        document.getElementById('sim-fba-growth-chart').getContext('2d'),
        {
            type: 'line',
            data: { datasets: gDs },
            plugins: [fixedPlotTopPlugin],
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    fixedPlotTop: { reservedTop: 75 },
                    legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 16 } },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                if (ctx.dataset.label?.startsWith('Reference data')) {
                                    const d = ZAVREL_2019_DATA[ctx.dataIndex];
                                    return `Zavřel 2019: μ = ${d.mu.toFixed(4)} ± ${d.muErr.toFixed(4)} h⁻¹`;
                                }
                                if (ctx.dataset.label?.startsWith('I₀')) return null;
                                return `${ctx.dataset.label}: μ = ${ctx.parsed.y.toFixed(4)} h⁻¹`;
                            },
                        },
                    },
                    zoom: {
                        zoom: { drag: { enabled: true }, mode: 'xy' },
                        pan:  { enabled: false },
                        limits: { x: { min: 0 }, y: { min: 0 } },
                    },
                },
                scales: {
                    x: { type: 'linear', title: { display: true, text: 'I₀ — incident irradiance (µmol·m⁻²·s⁻¹)', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
                    y: { min: 0, max: fbaYMax, title: { display: true, text: 'Growth rate µ (h⁻¹)', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
                },
            },
        }
    );

    // Augment sweep points with I₀ and Höper µ for reuse by yield/O₂ charts
    const p_aug = simGetParams();
    _sweepAugPts = pts.map(pt => ({
        ...pt,
        I0:      pt.photon / (alpha * 3.6),
        hoperMu: Math.max(0, simHoperMu(pt.photon / (alpha * 3.6), 0,
                    p_aug.alpha, p_aug.KL, p_aug.YBM, p_aug.kd, p_aug.ngam_photon, 0)),
    }));

    _fbaYieldXMode   = 'photon';
    _hoperYieldXMode = 'photon';
    _buildFbaYieldCharts();
    _buildHoperYieldCharts();
    expDataUpdateCharts();
    renderSweepProductChart(d, alpha);
}

function renderSweepProductChart(d, alpha) {
    const wrap    = document.getElementById('sim-fba-product-wrap');
    const ctx     = document.getElementById('sim-fba-product-chart')?.getContext('2d');
    const labelEl = document.getElementById('sim-fba-product-rxn-label');
    if (!wrap || !ctx) return;

    const hasProd = _trackedProductReaction && d.points.some(p => p.product_flux != null);
    wrap.style.display = hasProd ? '' : 'none';
    if (!hasProd) { if (simFbaProductChart) { simFbaProductChart.destroy(); simFbaProductChart = null; } return; }

    if (labelEl) labelEl.textContent = _trackedProductReaction;
    if (simFbaProductChart) { simFbaProductChart.destroy(); simFbaProductChart = null; }

    const fbaFluxPts = d.points
        .filter(p => p.growth > 1e-4 && p.product_flux != null)
        .map(p => ({ x: p.photon / (alpha * 3.6), y: Math.max(0, p.product_flux) }));

    const datasets = [{
        label: `FBA — v(${_trackedProductReaction}) (mmol·gDW⁻¹·h⁻¹)`,
        data: fbaFluxPts,
        borderColor: 'rgba(111,66,193,0.9)',
        backgroundColor: 'rgba(111,66,193,0.08)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
    }];

    // Overlay empirical fit if available
    if (_empiricalProductFit) {
        const { q_max, K_prod } = _empiricalProductFit;
        const fitX = fbaFluxPts.map(p => p.x);
        datasets.push({
            label: `Empirical fit — Monod (mmol·gDW⁻¹·h⁻¹)`,
            data: fitX.map(x => ({ x, y: q_max * x / (K_prod + x) })),
            borderColor: 'rgba(230,126,34,0.85)',
            borderDash: [5, 3],
            fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
        });
    }

    // Overlay experimental data if available
    if (_expProductData) {
        datasets.push({
            label: `Experimental q_product`,
            data: _expProductData.map(p => ({ x: p.I0, y: p.q_product })),
            type: 'scatter',
            borderColor: 'rgba(230,126,34,0.9)',
            backgroundColor: 'rgba(230,126,34,0.8)',
            pointRadius: 5, pointStyle: 'circle', showLine: false,
        });
    }

    simFbaProductChart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 14 } },
                title: { display: true, text: `Product flux: ${_trackedProductReaction}`, font: { size: 11 } },
            },
            scales: {
                x: { type: 'linear', title: { display: true, text: 'I₀ (µmol·m⁻²·s⁻¹)', font: { size: 11 } } },
                y: { min: 0, title: { display: true, text: 'v_product (mmol·gDW⁻¹·h⁻¹)', font: { size: 11 } } },
            },
        },
    });
}

function _buildFbaYieldCharts() {
    if (_sweepLocked) return;
    if (!_sweepAugPts) return;
    const xFn    = _fbaYieldXMode === 'mu'
        ? pt => pt.growth
        : pt => pt.photon;
    const xLabel = _fbaYieldXMode === 'mu'
        ? 'FBA ceiling µ (h⁻¹)'
        : 'Photon uptake J_I (mmol·gDW⁻¹·h⁻¹)';
    const hasO2  = _sweepAugPts.some(p => p.o2 !== null && p.o2 !== 0);

    if (simFbaYieldChart) { simFbaYieldChart.destroy(); simFbaYieldChart = null; }
    simFbaYieldChart = new Chart(
        document.getElementById('sim-fba-yield-chart').getContext('2d'),
        { type: 'line',
          data: { datasets: [{ label: 'Yield — last run',
              data: _sweepAugPts.map(pt => ({ x: xFn(pt), y: pt.yield })),
              borderColor: '#e67e22', backgroundColor: 'rgba(230,126,34,0.08)',
              borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 }] },
          options: xyLineOpts(xLabel, 'Yield (gDW·mmol⁻¹)', true) });

    document.getElementById('sim-fba-o2-wrap').style.display = hasO2 ? '' : 'none';
    if (hasO2) {
        if (simFbaO2Chart) { simFbaO2Chart.destroy(); simFbaO2Chart = null; }
        simFbaO2Chart = new Chart(
            document.getElementById('sim-fba-o2-chart').getContext('2d'),
            { type: 'line',
              data: { datasets: [{ label: 'O₂ evolution — last run',
                  data: _sweepAugPts.map(pt => ({ x: xFn(pt), y: pt.o2 })),
                  borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.08)',
                  borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 }] },
              options: xyLineOpts(xLabel, 'O₂ evolution (mmol·gDW⁻¹·h⁻¹)', true) });
    }
}

function _buildHoperYieldCharts() {
    if (_sweepLocked) return;
    if (!_sweepAugPts) return;
    const xFn    = _hoperYieldXMode === 'mu'
        ? pt => pt.hoperMu
        : pt => pt.photon;
    const xLabel = _hoperYieldXMode === 'mu'
        ? 'Höper µ (h⁻¹)'
        : 'Photon uptake J_I (mmol·gDW⁻¹·h⁻¹)';
    const hasO2  = _sweepAugPts.some(p => p.o2 !== null && p.o2 !== 0);

    if (simHoperYieldChart) { simHoperYieldChart.destroy(); simHoperYieldChart = null; }
    const yieldEl = document.getElementById('sim-hoper-yield-chart');
    if (yieldEl) {
        simHoperYieldChart = new Chart(yieldEl.getContext('2d'),
            { type: 'line',
              data: { datasets: [{ label: 'Yield — last run',
                  data: _sweepAugPts.map(pt => ({ x: xFn(pt), y: pt.yield })),
                  borderColor: '#e67e22', backgroundColor: 'rgba(230,126,34,0.08)',
                  borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 }] },
              options: xyLineOpts(xLabel, 'Yield (gDW·mmol⁻¹)', true) });
    }

    document.getElementById('sim-hoper-o2-wrap').style.display = hasO2 ? '' : 'none';
    if (hasO2) {
        if (simHoperO2Chart) { simHoperO2Chart.destroy(); simHoperO2Chart = null; }
        const o2El = document.getElementById('sim-hoper-o2-chart');
        if (o2El) {
            simHoperO2Chart = new Chart(o2El.getContext('2d'),
                { type: 'line',
                  data: { datasets: [{ label: 'O₂ evolution — last run',
                      data: _sweepAugPts.map(pt => ({ x: xFn(pt), y: pt.o2 })),
                      borderColor: '#3498db', backgroundColor: 'rgba(52,152,219,0.08)',
                      borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 }] },
                  options: xyLineOpts(xLabel, 'O₂ evolution (mmol·gDW⁻¹·h⁻¹)', true) });
        }
    }
}

function xyLineOpts(xLabel, yLabel, showLegend) {
    return {
        responsive: true,
        plugins: {
            legend: { display: !!showLegend, position: 'top', labels: { font: { size: 10 }, boxWidth: 20 } },
        },
        scales: {
            x: { type: 'linear', title: { display: true, text: xLabel, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
            y: { title: { display: true, text: yLabel, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
        },
    };
}

// ── Energetics ────────────────────────────────────────────────────────────────
// Fixed resource set used as common y-axis for grouped comparison
const EN_RESOURCES = [
    { key: 'photons_per_unit', label: 'Photons',  unit: 'µmol/mmol', color: '#e67e22' },
    { key: 'co2_per_unit',     label: 'CO₂',      unit: 'mmol/mmol', color: '#27ae60' },
    { key: 'o2_per_unit',      label: 'O₂',       unit: 'mmol/mmol', color: '#3498db' },
    { key: 'no3_per_unit',     label: 'NO₃⁻',     unit: 'mmol/mmol', color: '#9b59b6' },
    { key: 'atp_per_unit',     label: 'ATP',       unit: 'mmol/mmol', color: '#e74c3c' },
    { key: 'nadph_per_unit',   label: 'NADPH',     unit: 'mmol/mmol', color: '#f39c12' },
];

let bcSimState    = null;   // {D_opt, I0} — stored when a chemostat sim is rendered
let bcMetSelRxn   = null;   // reaction ID selected via metabolite browser
let bcMetSelMetId = null;   // metabolite ID currently browsed

// Recombinant product state — scoped to BC calculation only
let bcRecombReactions   = [];
let bcRecombProductMet  = null;
let bcRecombTargetRxn   = null;
let bcRecombProductName = '';

function _bcCommonBody() {
    const mode = document.querySelector('input[name="bc-mode"]:checked')?.value || 'independent';
    return {
        mode,
        constrained:      document.getElementById('en-constrained').checked,
        custom_reactions: customReactions.concat(bcRecombReactions),
        growth_rate:      (mode === 'dependent' && bcSimState) ? bcSimState.D_opt : 0,
    };
}

function _bcRunWithBody(body, btn) {
    const mode = body.mode;
    if (mode === 'dependent' && !bcSimState) {
        showAnalysisError('en-error', 'Run a chemostat simulation first to use "Based on simulation" mode.');
        return;
    }
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Calculating…';
    document.getElementById('en-error').style.display   = 'none';
    document.getElementById('en-results').style.display = 'none';

    fetch('/api/metabolic/energetics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    .then(r => r.json())
    .then(d => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Calculate';
        if (d.error) { showAnalysisError('en-error', d.error); return; }
        enLastData = d;
        showRefBar('en');
        renderEnergetics(d);
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Calculate';
        showAnalysisError('en-error', err.message);
    });
}

function runEnergetics() {
    const rxn = document.getElementById('en-rxn').value.trim();
    if (!rxn) { showAnalysisError('en-error', 'Select a target reaction.'); return; }
    _bcRunWithBody({ ...(_bcCommonBody()), target_rxn: rxn },
                   document.getElementById('run-en-btn'));
}

function runEnergeticsFromMet() {
    if (!bcMetSelRxn) { showAnalysisError('en-error', 'Select a reaction from the metabolite table.'); return; }
    _bcRunWithBody({ ...(_bcCommonBody()), target_rxn: bcMetSelRxn, target_met: bcMetSelMetId },
                   document.getElementById('run-en-btn-met'));
}

// ── Biosynthetic Cost — recombinant product helpers ───────────────────────────

function bcRecombOnTemplateChange() {
    const val = document.getElementById('bc-recomb-template').value;
    document.getElementById('bc-recomb-custom').style.display = val === 'custom' ? '' : 'none';
    if (val && val !== 'custom') {
        bcRecombApplyTemplate(val);
    } else if (!val) {
        bcRecombClear();
    }
    // 'custom' waits for Apply button
}

function bcRecombApplyTemplate(key) {
    const tpl  = REACTION_TEMPLATES[key];
    const prod = BC_RECOMB_PRODUCTS[key];
    if (!tpl || !prod) return;
    bcRecombReactions   = tpl.reactions.map(r => ({ ...r, stoich: { ...r.stoich }, new_mets: { ...r.new_mets } }));
    bcRecombProductMet  = prod.met;
    bcRecombTargetRxn   = prod.target_rxn;
    bcRecombProductName = prod.name;
    bcRecombUpdateUI();
}

function bcRecombApplyCustom() {
    const rxnId     = (document.getElementById('bc-recomb-rxn-id')?.value    || '').trim();
    const stoichRaw = (document.getElementById('bc-recomb-stoich')?.value     || '').trim();
    const newName   = (document.getElementById('bc-recomb-new-met-name')?.value || '').trim();
    const errEl     = document.getElementById('bc-recomb-custom-error');
    const errWrap   = document.getElementById('bc-recomb-custom-error-wrap');

    function showErr(msg) { errEl.textContent = msg; errWrap.style.display = ''; }
    errWrap.style.display = 'none';

    if (!rxnId)     { showErr('Reaction ID is required.');    return; }
    if (!stoichRaw) { showErr('Stoichiometry is required.'); return; }

    const stoich = {};
    try {
        for (const part of stoichRaw.split(',')) {
            const idx = part.indexOf(':');
            if (idx < 0) throw new Error();
            const metId = part.slice(0, idx).trim();
            const v     = parseFloat(part.slice(idx + 1).trim());
            if (!metId || isNaN(v)) throw new Error();
            stoich[metId] = v;
        }
    } catch {
        showErr('Cannot parse stoichiometry. Use format: met_id: coeff, met_id: coeff'); return;
    }

    const candidates = Object.entries(stoich)
        .filter(([id, v]) => v > 0 && !BC_CURRENCY_METS.has(id))
        .map(([id]) => id);

    if (candidates.length === 0) {
        showErr('No product detected. Provide a non-currency metabolite with a positive coefficient.'); return;
    }
    const productMet = candidates[0];

    const new_mets = {};
    if (newName) {
        new_mets[productMet] = { name: newName, formula: '', compartment: productMet.slice(-1) };
    }

    bcRecombReactions   = [{ id: rxnId, name: rxnId, lb: 0, ub: 1000, stoich, new_mets }];
    bcRecombProductMet  = productMet;
    bcRecombTargetRxn   = rxnId;
    bcRecombProductName = newName || productMet;
    bcRecombUpdateUI();
}

function bcRecombClear() {
    bcRecombReactions   = [];
    bcRecombProductMet  = null;
    bcRecombTargetRxn   = null;
    bcRecombProductName = '';
    bcRecombUpdateUI();
}

function bcRecombUpdateUI() {
    const active   = bcRecombReactions.length > 0 && !!bcRecombProductMet;
    const badges   = document.getElementById('bc-recomb-badges');
    const calcWrap = document.getElementById('bc-recomb-calc-wrap');
    const ttRow    = document.getElementById('bc-target-type-row');
    const rxnSec   = document.getElementById('bc-rxn-section');
    const metSec   = document.getElementById('bc-met-section');
    const descWrap = document.getElementById('bc-recomb-desc-wrap');
    const descEl   = document.getElementById('bc-recomb-desc');

    const efePanel = document.getElementById('bc-efe-protein-panel');
    const key      = document.getElementById('bc-recomb-template')?.value;

    if (active) {
        document.getElementById('bc-recomb-rxn-badge').textContent     = bcRecombTargetRxn;
        document.getElementById('bc-recomb-product-badge').textContent = bcRecombProductName;
        badges.style.display    = '';
        calcWrap.style.display  = '';
        const tpl = (key && key !== 'custom') ? REACTION_TEMPLATES[key] : null;
        if (tpl?.description) {
            descEl.textContent     = tpl.description;
            descWrap.style.display = '';
        } else {
            descWrap.style.display = 'none';
        }
        if (efePanel) efePanel.style.display = key === 'ethylene_efe' ? '' : 'none';
        if (ttRow)  ttRow.style.display  = 'none';
        if (rxnSec) rxnSec.style.display = 'none';
        if (metSec) metSec.style.display = 'none';
    } else {
        badges.style.display   = 'none';
        calcWrap.style.display = 'none';
        descWrap.style.display = 'none';
        if (efePanel) efePanel.style.display = 'none';
        if (ttRow) ttRow.style.display = '';
        const targetType = document.querySelector('input[name="bc-target-type"]:checked')?.value || 'reaction';
        if (rxnSec) rxnSec.style.display = targetType === 'reaction'   ? '' : 'none';
        if (metSec) metSec.style.display = targetType === 'metabolite' ? '' : 'none';
    }
}

function runEnergeticsRecomb() {
    if (!bcRecombTargetRxn) return;
    _bcRunWithBody({ ...(_bcCommonBody()), target_rxn: bcRecombTargetRxn, target_met: bcRecombProductMet },
                   document.getElementById('run-en-recomb-btn'));
}

function buildEfeProteinStoich() {
    const inclAa      = document.getElementById('bc-efe-aa')?.checked     ?? true;
    const inclTransl  = document.getElementById('bc-efe-transl')?.checked  ?? true;
    const inclTranscr = document.getElementById('bc-efe-transcr')?.checked ?? true;

    const n      = EFE_SEQUENCE.length;  // 350
    const stoich = {};
    function add(met, delta) { stoich[met] = (stoich[met] || 0) + delta; }

    // Amino acid procurement: model traces back biosynthesis cost from central metabolites
    if (inclAa) {
        const counts = {};
        for (const aa of EFE_SEQUENCE) counts[aa] = (counts[aa] || 0) + 1;
        for (const [aa, cnt] of Object.entries(counts)) {
            const bigg = AA_BIGG[aa];
            if (bigg) add(bigg, -cnt);
        }
    }

    // Translation: 2 ATP for aminoacyl-tRNA charging + 2 GTP for elongation ≈ 4 ATP-eq per aa
    if (inclTransl) {
        add('atp_c', -4 * n);
        add('adp_c', +4 * n);
        add('pi_c',  +4 * n);
    }

    // Transcription: ~2 ATP-eq per nucleotide × 3 nt per codon (NTPs proxied as ATP)
    if (inclTranscr) {
        add('atp_c', -6 * n);
        add('adp_c', +6 * n);
        add('pi_c',  +6 * n);
    }

    stoich['efe_protein_c'] = 1;
    const new_mets = {
        efe_protein_c: { name: 'EFE protein (P32021, 350 aa)', formula: '', compartment: 'c' },
    };
    return { id: 'EFE_PROTEIN_SYNTH', name: 'EFE protein synthesis', lb: 0, ub: 1000, stoich, new_mets };
}

function runEfeProteinCost() {
    const rxn  = buildEfeProteinStoich();
    const drain = {
        id: 'DM_efe_protein_c', name: 'EFE protein demand sink',
        lb: 0, ub: 1000,
        stoich:   { efe_protein_c: -1 },
        new_mets: {},
    };
    const mode = document.querySelector('input[name="bc-mode"]:checked')?.value || 'independent';
    const body = {
        mode,
        constrained:      document.getElementById('en-constrained').checked,
        // Only base custom reactions — protein synthesis is independent of the EFE enzymatic reaction
        custom_reactions: customReactions.concat([rxn, drain]),
        growth_rate:      (mode === 'dependent' && bcSimState) ? bcSimState.D_opt : 0,
        target_rxn:       'DM_efe_protein_c',
        target_met:       'efe_protein_c',
    };
    _bcRunWithBody(body, document.getElementById('run-efe-protein-btn'));
}

// ── Metabolite browser ────────────────────────────────────────────────────────

function bcInitMetBrowser() {
    const searchEl  = document.getElementById('bc-met-search');
    const dropEl    = document.getElementById('bc-met-dropdown');
    const listEl    = document.getElementById('bc-met-list');
    const hiddenEl  = document.getElementById('bc-met-id');
    const subFilter = document.getElementById('bc-met-sub-filter');
    if (!searchEl) return;

    let debounce = null;

    function renderMetList(q) {
        const query = (q || '').trim().toLowerCase();
        const hits = query
            ? allMetabolites.filter(m =>
                m.id.toLowerCase().includes(query) || (m.name || '').toLowerCase().includes(query)
              ).slice(0, 120)
            : allMetabolites.slice(0, 120);

        if (!hits.length) { listEl.innerHTML = '<div class="p-2 text-muted small">No matches</div>'; return; }
        listEl.innerHTML = hits.map(m => {
            const comp = m.compartment ? `<span class="badge badge-light border ml-1" style="font-size:0.7em;">${esc(m.compartment)}</span>` : '';
            return `<div class="rxn-sel-item" data-id="${esc(m.id)}" style="padding:4px 8px;">` +
                `<code style="font-size:0.85em;">${esc(m.id)}</code> ` +
                `<span style="font-size:0.84em;">${esc(m.name || '')}</span>${comp}</div>`;
        }).join('');
        listEl.querySelectorAll('.rxn-sel-item').forEach(item => {
            item.addEventListener('mousedown', e => { e.preventDefault(); pickMet(item.dataset.id); });
        });
    }

    function pickMet(metId) {
        const met = allMetabolites.find(m => m.id === metId);
        hiddenEl.value = metId;
        bcMetSelMetId  = metId;
        searchEl.value = met ? `${met.id} — ${met.name || ''}` : metId;
        dropEl.style.display = 'none';
        document.getElementById('bc-met-name-label').textContent = met ? (met.name || metId) : metId;
        loadMetReactions(metId);
    }

    searchEl.addEventListener('focus', () => {
        renderMetList(searchEl.value);
        dropEl.style.display = '';
    });
    searchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { renderMetList(searchEl.value); dropEl.style.display = ''; }, 150);
    });
    document.addEventListener('mousedown', e => {
        if (!searchEl.contains(e.target) && !dropEl.contains(e.target)) dropEl.style.display = 'none';
    });

    subFilter.addEventListener('change', () => {
        if (bcMetSelMetId) filterMetRxnTable(subFilter.value);
    });
}

let _metRxnCache = [];   // full list for current metabolite

function loadMetReactions(metId) {
    const wrap  = document.getElementById('bc-met-rxn-wrap');
    const table = document.getElementById('bc-met-rxn-table');
    const sub   = document.getElementById('bc-met-sub-filter');
    bcMetSelRxn = null;
    document.getElementById('run-en-btn-met').disabled = true;
    document.getElementById('bc-met-selected-rxn-label').textContent = '';
    wrap.style.display = 'none';
    table.innerHTML = '<div class="p-2 text-muted small"><i class="fa fa-spinner fa-spin"></i> Loading…</div>';

    fetch(`/api/metabolic/met_reactions/${encodeURIComponent(metId)}`)
    .then(r => r.json())
    .then(rxns => {
        if (rxns.error) { table.innerHTML = `<div class="p-2 text-danger small">${esc(rxns.error)}</div>`; return; }
        _metRxnCache = rxns;
        // Populate subsystem filter
        const subs = [...new Set(rxns.map(r => r.subsystem).filter(Boolean))].sort();
        sub.innerHTML = '<option value="">All subsystems</option>' +
            subs.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
        filterMetRxnTable('');
        wrap.style.display = '';
    })
    .catch(err => { table.innerHTML = `<div class="p-2 text-danger small">${esc(err.message)}</div>`; });
}

function filterMetRxnTable(subFilter) {
    const table = document.getElementById('bc-met-rxn-table');
    const rows  = subFilter
        ? _metRxnCache.filter(r => r.subsystem === subFilter)
        : _metRxnCache;

    if (!rows.length) { table.innerHTML = '<div class="p-2 text-muted small">No reactions in this subsystem.</div>'; return; }

    table.innerHTML = `<table class="table table-sm table-bordered mb-0" style="font-size:0.82em;">
        <thead class="thead-light sticky-top">
            <tr><th>ID</th><th>Name</th><th>Subsystem</th><th>Role</th><th>Bounds</th><th>Equation</th></tr>
        </thead>
        <tbody>${rows.map(r => {
            const role = r.stoich > 0
                ? '<span class="text-success font-weight-bold">produces</span>'
                : '<span class="text-danger font-weight-bold">consumes</span>';
            const bounds = `[${r.lb}, ${r.ub}]`;
            return `<tr data-rxn-id="${esc(r.id)}">
                <td><code>${esc(r.id)}</code></td>
                <td>${esc(r.name || '')}</td>
                <td><span class="badge badge-light border" style="font-size:0.75em;">${esc(r.subsystem || '')}</span></td>
                <td>${role} (${r.stoich > 0 ? '+' : ''}${r.stoich})</td>
                <td class="text-muted">${bounds}</td>
                <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.equation)}">${esc(r.equation)}</td>
            </tr>`;
        }).join('')}</tbody>
    </table>`;

    table.querySelectorAll('tbody tr').forEach(tr => {
        tr.addEventListener('click', () => {
            table.querySelectorAll('tr').forEach(r => r.classList.remove('bc-rxn-selected'));
            tr.classList.add('bc-rxn-selected');
            bcMetSelRxn = tr.dataset.rxnId;
            const rxn = _metRxnCache.find(r => r.id === bcMetSelRxn);
            document.getElementById('run-en-btn-met').disabled = false;
            document.getElementById('bc-met-selected-rxn-label').textContent =
                rxn ? `${rxn.id} — ${rxn.name || ''}` : bcMetSelRxn;
        });
    });
}

function renderEnergetics(d) {
    document.getElementById('en-results').style.display = '';

    const fba  = d.fba  || {};
    const pfba = d.pfba || {};
    const modeLabel = d.mode === 'dependent'
        ? `dependent on simulation (D = ${(d.growth_rate || 0).toFixed(4)} h⁻¹)`
        : 'independent';
    document.getElementById('en-note').textContent =
        `${d.target_rxn}${d.demand_added ? ' (demand reaction added)' : ''} — ${modeLabel}`;

    // Resource table: FBA vs pFBA columns
    const thead = document.querySelector('#en-table thead tr');
    const tbody = document.querySelector('#en-table tbody');
    thead.innerHTML = '<th>Resource</th><th>FBA</th><th>pFBA</th>';
    tbody.innerHTML = EN_RESOURCES.map(r => {
        const vf = fba[r.key],  vp = pfba[r.key];
        if ((vf == null || vf === 0) && (vp == null || vp === 0)) return '';
        const fmtF = vf != null && vf > 0 ? `<strong>${vf}</strong>` : '<span class="text-muted">—</span>';
        const fmtP = vp != null && vp > 0 ? `<strong>${vp}</strong>` : '<span class="text-muted">—</span>';
        // highlight if pFBA < FBA (futile cycles reduced)
        const cls = (vf && vp && vp < vf) ? 'text-success' : '';
        return `<tr>
            <td>${r.label} <small class="text-muted">(${r.unit})</small></td>
            <td>${fmtF}</td>
            <td class="${cls}">${fmtP}</td>
        </tr>`;
    }).join('');

    // Bar chart: grouped FBA (light) vs pFBA (solid)
    const visRows = EN_RESOURCES.filter(r =>
        (fba[r.key] != null && fba[r.key] > 0) || (pfba[r.key] != null && pfba[r.key] > 0));
    const labels = visRows.map(r => r.label);
    if (enChart) enChart.destroy();
    enChart = new Chart(document.getElementById('en-chart').getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { label: 'FBA',  data: visRows.map(r => fba[r.key]  ?? 0),
                  backgroundColor: visRows.map(r => r.color + '55'), borderColor: visRows.map(r => r.color), borderWidth: 1 },
                { label: 'pFBA', data: visRows.map(r => pfba[r.key] ?? 0),
                  backgroundColor: visRows.map(r => r.color + 'cc'), borderColor: visRows.map(r => r.color), borderWidth: 1 },
            ],
        },
        options: {
            indexAxis: 'y', responsive: true,
            plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 14 } } },
            scales: {
                x: { title: { display: true, text: 'mmol per mmol product', font: { size: 10 } } },
                y: { ticks: { font: { size: 10 } } },
            },
        },
    });

    // Wire view toggle then render subsystem table
    const viewRadios = document.querySelectorAll('input[name="bc-view"]');
    viewRadios.forEach(r => {
        r.onchange = () => renderSubsystemTable(fba.subsystems || [], pfba.subsystems || [],
                                                document.querySelector('input[name="bc-view"]:checked')?.value || 'pfba');
    });
    renderSubsystemTable(fba.subsystems || [], pfba.subsystems || [],
                         document.querySelector('input[name="bc-view"]:checked')?.value || 'pfba');

    // Flow narrative — always uses pFBA (more parsimonious)
    renderSubsystemFlow(pfba.subsystems || []);
}

function renderSubsystemTable(fbaSubs, pfbaSubs, view) {
    const wrap = document.getElementById('en-subsystem-table');
    if (!wrap) return;
    view = view || 'pfba';

    // Collect all subsystem names (union)
    const allNames = [...new Set([
        ...(fbaSubs  || []).map(s => s.name),
        ...(pfbaSubs || []).map(s => s.name),
    ])];
    if (allNames.length === 0) { wrap.innerHTML = ''; return; }

    // Build lookup maps
    const fbaMap  = {};  (fbaSubs  || []).forEach(s => { fbaMap[s.name]  = s; });
    const pfbaMap = {};  (pfbaSubs || []).forEach(s => { pfbaMap[s.name] = s; });

    // Choose which set(s) to show
    const showFBA  = view === 'fba'  || view === 'both';
    const showPFBA = view === 'pfba' || view === 'both';

    // Scale bars across all visible values
    const allVals = allNames.flatMap(n => {
        const arr = [];
        if (showFBA  && fbaMap[n])  arr.push(Math.abs(fbaMap[n].atp_net),  Math.abs(fbaMap[n].nadph_net));
        if (showPFBA && pfbaMap[n]) arr.push(Math.abs(pfbaMap[n].atp_net), Math.abs(pfbaMap[n].nadph_net));
        return arr;
    });
    const maxVal = Math.max(1e-9, ...allVals);

    const bar = (val, max) => {
        if (val == null || Math.abs(val) < 1e-6) return '<span class="text-muted small">0</span>';
        const pct   = Math.min(100, Math.abs(val) / max * 100).toFixed(1);
        const color = val > 0 ? '#27ae60' : '#e74c3c';
        const sign  = val > 0 ? '+' : '';
        return `<span style="color:${color}; font-weight:600;">${sign}${val.toFixed(3)}</span>` +
               `<div style="display:inline-block; width:${pct}%; max-width:80px; height:7px;` +
               ` background:${color}; opacity:0.55; border-radius:2px;` +
               ` vertical-align:middle; margin-left:4px;"></div>`;
    };

    const dash = '<span class="text-muted">—</span>';

    // Header columns
    let headerCols = '<th style="min-width:140px;">Pathway / subsystem</th>';
    if (showFBA && showPFBA) {
        headerCols += '<th>FBA ATP</th><th>FBA NADPH</th><th>pFBA ATP</th><th>pFBA NADPH</th>';
    } else if (showFBA) {
        headerCols += '<th>ATP net</th><th>NADPH net</th>';
    } else {
        headerCols += '<th>ATP net</th><th>NADPH net</th>';
    }
    headerCols += '<th class="text-right">Active rxns</th>';

    // Footer net sums
    let netFbaATP = 0, netFbaNADPH = 0, netPfbaATP = 0, netPfbaNADPH = 0;
    allNames.forEach(n => {
        if (fbaMap[n])  { netFbaATP  += fbaMap[n].atp_net;   netFbaNADPH  += fbaMap[n].nadph_net; }
        if (pfbaMap[n]) { netPfbaATP += pfbaMap[n].atp_net;  netPfbaNADPH += pfbaMap[n].nadph_net; }
    });
    const netColor = v => Math.abs(v) < 0.01 ? 'text-success' : 'text-warning';
    const netSign  = v => (v > 0 ? '+' : '') + v.toFixed(3);

    let footCells = '';
    if (showFBA && showPFBA) {
        footCells = `<td class="${netColor(netFbaATP)} font-weight-bold">${netSign(netFbaATP)}</td>` +
                    `<td class="${netColor(netFbaNADPH)} font-weight-bold">${netSign(netFbaNADPH)}</td>` +
                    `<td class="${netColor(netPfbaATP)} font-weight-bold">${netSign(netPfbaATP)}</td>` +
                    `<td class="${netColor(netPfbaNADPH)} font-weight-bold">${netSign(netPfbaNADPH)}</td>`;
    } else if (showFBA) {
        footCells = `<td class="${netColor(netFbaATP)} font-weight-bold">${netSign(netFbaATP)}</td>` +
                    `<td class="${netColor(netFbaNADPH)} font-weight-bold">${netSign(netFbaNADPH)}</td>`;
    } else {
        footCells = `<td class="${netColor(netPfbaATP)} font-weight-bold">${netSign(netPfbaATP)}</td>` +
                    `<td class="${netColor(netPfbaNADPH)} font-weight-bold">${netSign(netPfbaNADPH)}</td>`;
    }

    const rows = allNames.map(n => {
        const f = fbaMap[n], p = pfbaMap[n];
        const rxnCount = (p || f)?.rxn_count ?? 0;
        let dataCells = '';
        if (showFBA && showPFBA) {
            dataCells = `<td>${f ? bar(f.atp_net,   maxVal) : dash}</td>` +
                        `<td>${f ? bar(f.nadph_net, maxVal) : dash}</td>` +
                        `<td>${p ? bar(p.atp_net,   maxVal) : dash}</td>` +
                        `<td>${p ? bar(p.nadph_net, maxVal) : dash}</td>`;
        } else if (showFBA) {
            dataCells = `<td>${f ? bar(f.atp_net,   maxVal) : dash}</td>` +
                        `<td>${f ? bar(f.nadph_net, maxVal) : dash}</td>`;
        } else {
            dataCells = `<td>${p ? bar(p.atp_net,   maxVal) : dash}</td>` +
                        `<td>${p ? bar(p.nadph_net, maxVal) : dash}</td>`;
        }
        return `<tr>
            <td style="max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
                title="${esc(n)}">${esc(n)}</td>
            ${dataCells}
            <td class="text-muted text-right">${rxnCount}</td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
        <div class="table-responsive">
        <table class="table table-sm table-bordered table-hover" style="font-size:0.82em;">
            <thead class="thead-light"><tr>${headerCols}</tr></thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr class="table-secondary" style="font-size:0.9em;">
                    <td><strong>Net Σ</strong> <small class="text-muted">(≈ 0)</small></td>
                    ${footCells}
                    <td></td>
                </tr>
            </tfoot>
        </table>
        </div>`;
}

function renderSubsystemFlow(subsystems) {
    const wrap = document.getElementById('en-flow-table');
    if (!wrap) return;
if (!subsystems || subsystems.length === 0) { wrap.innerHTML = ''; return; }

    // Filter to subsystems that have boundary metabolites (inputs or outputs)
    const active = subsystems.filter(s =>
        (s.inputs  && s.inputs.length  > 0) ||
        (s.outputs && s.outputs.length > 0));

    if (active.length === 0) {
        wrap.innerHTML = '<p class="text-muted small">No boundary metabolite flow data available.</p>';
        return;
    }

    const fmtAmt = v => {
        if (v == null) return '';
        const a = Math.abs(v);
        const s = a >= 10 ? a.toFixed(2) : a >= 1 ? a.toFixed(3) : a.toFixed(4);
        return s;
    };

    const pillIn  = (name, amt) =>
        `<span class="badge badge-pill" style="background:#d4edda; color:#155724; border:1px solid #c3e6cb;
               font-size:0.78em; font-weight:500; margin:2px 3px 2px 0;">` +
        `↓ ${esc(name)}${amt ? ' ' + fmtAmt(amt) : ''}</span>`;

    const pillOut = (name, amt) =>
        `<span class="badge badge-pill" style="background:#fff3cd; color:#856404; border:1px solid #ffeeba;
               font-size:0.78em; font-weight:500; margin:2px 3px 2px 0;">` +
        `↑ ${esc(name)}${amt ? ' ' + fmtAmt(amt) : ''}</span>`;

    // Colour the card's left border based on an ordered palette
    const BORDER_COLORS = [
        '#e67e22','#27ae60','#2980b9','#8e44ad','#c0392b',
        '#16a085','#f39c12','#2c3e50','#1abc9c','#d35400'];

    const cards = active.map((s, i) => {
        const color  = BORDER_COLORS[i % BORDER_COLORS.length];
        const inputs  = (s.inputs  || []).map(m => pillIn(m.met_name  || m.met_id,  m.amount)).join('');
        const outputs = (s.outputs || []).map(m => pillOut(m.met_name || m.met_id, m.amount)).join('');

        const atpLabel = s.atp_net > 0
            ? `<span class="text-success font-weight-bold">+${s.atp_net.toFixed(3)}</span>`
            : s.atp_net < 0
                ? `<span class="text-danger font-weight-bold">${s.atp_net.toFixed(3)}</span>`
                : '';
        const nadphLabel = s.nadph_net > 0
            ? `<span class="text-success font-weight-bold">+${s.nadph_net.toFixed(3)}</span>`
            : s.nadph_net < 0
                ? `<span class="text-danger font-weight-bold">${s.nadph_net.toFixed(3)}</span>`
                : '';
        const energyStr = [
            atpLabel  ? `ATP ${atpLabel}`   : null,
            nadphLabel ? `NADPH ${nadphLabel}` : null,
        ].filter(Boolean).join('&ensp;');

        return `<div class="bc-flow-card mb-2" style="border-left:3px solid ${color}; padding:6px 10px;
                    background:#fafafa; border-radius:3px;">
            <div class="d-flex align-items-baseline justify-content-between flex-wrap">
                <strong style="font-size:0.88em; color:${color};">${esc(s.name)}</strong>
                ${energyStr ? `<small class="text-muted ml-2" style="font-size:0.78em;">${energyStr}</small>` : ''}
            </div>
            ${inputs  ? `<div class="mt-1"><span class="text-muted small" style="width:50px; display:inline-block;">Takes in:</span>${inputs}</div>`  : ''}
            ${outputs ? `<div class="mt-1"><span class="text-muted small" style="width:50px; display:inline-block;">Passes on:</span>${outputs}</div>` : ''}
        </div>`;
    });

    // Interleave with arrows between cards
    const arrow = '<div class="text-center text-muted" style="font-size:1.1em; line-height:1.2; margin:0 0 4px;">↓</div>';
    wrap.innerHTML = cards.join(arrow);
}

function showAnalysisError(elId, msg) {
    const el = document.getElementById(elId);
    el.textContent = msg;
    el.style.display = '';
}

// ── Unified Simulation & Analysis ─────────────────────────────────────────────
let simMode             = 'chemo';
let simGrowthChart      = null;
let simChemoChart       = null;
let simBatchDensityChart = null;
let simBatchProdChart   = null;
let simChemoI0Chart     = null;   // design: light-response operational envelope
let simChemoPvChart     = null;   // design: volumetric productivity P_V vs reactor depth z
let simChemoRobustChart = null;   // design: normalised operating window / robustness
let simChemoRhoChart    = null;   // productivity vs culture density (chemostat, parametric in D)
let simTurbRhoChart     = null;   // productivity vs culture density (turbidostat, areal)
let simTurbVolChart     = null;   // volumetric productivity vs volumetric density (turbidostat)
let simTurbI0Chart      = null;   // volumetric productivity vs I₀ at fixed ρ_A (turbidostat)
let simBatchRhoChart    = null;   // productivity vs culture density (batch)

// FBA single-point marker (from FBA tab single-run)
let simFbaMarker = null;   // { I0, mu }

// Reference overlay (growth curve + productivity)
let simRefData  = null;    // { mode, gcPts, prodData, label }

document.addEventListener('DOMContentLoaded', () => {
    const analysisTabLink = document.querySelector('[href="#tab-simulations"]');
    if (analysisTabLink) {
        // Render (or re-render) every time the Simulations tab becomes visible.
        // requestAnimationFrame defers one paint cycle so layout is settled.
        analysisTabLink.addEventListener('shown.bs.tab', () => requestAnimationFrame(simRecompute));
        // Sub-tab shown: re-render productivity charts when switching to that sub-tab
        const prodTabLink = document.querySelector('[href="#sim-sub-productivity"]');
        if (prodTabLink) prodTabLink.addEventListener('shown.bs.tab', () => requestAnimationFrame(simRecompute));
        // If the simulations tab is already the active tab on page load, render now.
        const pane = document.getElementById('tab-simulations');
        if (pane && pane.classList.contains('active')) requestAnimationFrame(simRecompute);
    } else {
        // No tab structure — render immediately.
        simRecompute();
    }

    // Sub-tab change: update parameter panel visibility (jQuery event — Bootstrap 4 canonical)
    $('#sim-sub-tabs').on('shown.bs.tab', '[data-toggle="tab"]', function(e) {
        const tabId = ($(e.target).attr('href') || '').replace('#sim-sub-', '');
        simUpdateParamVisibility(tabId);
        if (tabId === 'light') requestAnimationFrame(simRecompute);
        if (tabId === 'sweep') requestAnimationFrame(updateFbaGrowthOverlay);
    });
    // Set initial visibility (first tab = static = Static FBA)
    simUpdateParamVisibility('static');
});

/** Read all shared simulation parameters */
function simGetParams() {
    return {
        alpha:       +document.getElementById('sim-alpha').value,
        KL:          +document.getElementById('sim-KL').value,
        YBM:         +document.getElementById('sim-YBM').value,
        kd:          +document.getElementById('sim-kd').value,
        ngam_photon: +(document.getElementById('sim-ngam-photon')?.value ?? 0),
        I0:          +document.getElementById('sim-I0').value,
        XA:          +document.getElementById('sim-XA').value,
        rho0:        +document.getElementById('sim-rho0').value,
        t_end:       +document.getElementById('sim-tend').value,
        Y_X:         +document.getElementById('sim-yx').value,
        productName: document.getElementById('sim-product-name')?.value?.trim() || 'Product',
        z_reactor:   +(document.getElementById('sim-reactor-depth')?.value ?? 0.10),
    };
}

function simSlider(input, valId) {
    document.getElementById(valId).textContent = input.value;
    simRecompute();
    if (simMode === 'turb') simRenderTurbCharts();
}

function simNudge(id, valId, dir) {
    const el = document.getElementById(id);
    if (!el) return;
    const step = parseFloat(el.step) || 1;
    const min  = parseFloat(el.min);
    const max  = parseFloat(el.max);
    el.value   = Math.max(min, Math.min(max, parseFloat(el.value) + dir * step));
    simSlider(el, valId);
}


function simSetMode(mode) {
    simMode = mode;
    // Keep legacy btn-group elements in sync if present
    document.getElementById('sim-btn-chemo')?.classList.toggle('active', mode === 'chemo');
    document.getElementById('sim-btn-batch')?.classList.toggle('active',  mode === 'batch');
    // Nav-tab active state
    document.getElementById('sim-tab-chemo')?.classList.toggle('active', mode === 'chemo');
    document.getElementById('sim-tab-turb')?.classList.toggle('active',  mode === 'turb');
    document.getElementById('sim-tab-batch')?.classList.toggle('active',  mode === 'batch');
    document.getElementById('sim-chemo-charts').style.display      = mode === 'chemo' ? '' : 'none';
    document.getElementById('sim-turb-charts').style.display       = mode === 'turb'  ? '' : 'none';
    document.getElementById('sim-batch-charts').style.display      = mode === 'batch' ? '' : 'none';
    document.getElementById('prod-insight-chemo').style.display    = mode === 'chemo' ? '' : 'none';
    document.getElementById('prod-insight-batch').style.display    = mode === 'batch' ? '' : 'none';
    // Batch initial conditions only visible in productivity tab AND batch mode
    const activeTabHref = document.querySelector('#sim-sub-tabs .nav-link.active')?.getAttribute('href') || '';
    const inProductivity = activeTabHref === '#sim-sub-productivity';
    const batchParams = document.getElementById('sim-batch-params');
    if (batchParams) batchParams.style.display = (mode === 'batch' && inProductivity) ? '' : 'none';
    // When switching to turbidostat tab, render charts if a simulation has been run
    if (mode === 'turb') simRenderTurbCharts();
    else simRecompute();
}

/** Show/hide left-panel parameter groups based on the active sub-tab. */
function simUpdateParamVisibility(tabId) {
    document.querySelectorAll('.sim-pg[data-tabs]').forEach(el => {
        if (el.id === 'sim-batch-params') return; // handled by simSetMode
        const tabs = el.dataset.tabs.split(',');
        el.style.display = tabs.includes(tabId) ? '' : 'none';
    });
    // Batch params only visible in productivity tab AND batch mode
    const bp = document.getElementById('sim-batch-params');
    if (bp) bp.style.display = (tabId === 'productivity' && simMode === 'batch') ? '' : 'none';

    // Highlight active step in workflow diagram
    ['static', 'sweep', 'light', 'productivity'].forEach(id => {
        const card  = document.getElementById('sim-step-' + id);
        const badge = document.getElementById('sim-step-badge-' + id);
        if (!card) return;
        const active = id === tabId;
        card.classList.toggle('border-primary', active);
        card.classList.toggle('border', !active);
        if (badge) {
            badge.classList.toggle('badge-primary', active);
            badge.classList.toggle('badge-secondary', !active);
        }
    });
}

/** Compute + render both growth curve and productivity */
function simRecompute() {

    const p = simGetParams();
    syncMedPhoton();
    simUpdateDerived(p);
    simRenderGrowthCurve(p);
    updateFbaGrowthOverlay();   // refresh Höper curve + I₀ marker on FBA sweep chart
    if (simMode === 'chemo') simRenderChemostat(simComputeChemostat(p));
    else                     simRenderBatch(simComputeBatch(p));
    updateProdParamCard(p);
    // Live R²/RMSE update whenever result panel is visible
    const fitOut = document.getElementById('sim-fit-result');
    if (fitOut && fitOut.style.display !== 'none') computeFitQuality();
}

function updateProdParamCard(p) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; };

    set('pp-alpha', p.alpha.toFixed(4));
    set('pp-KL',    p.KL.toFixed(1));
    set('pp-YBM',   p.YBM.toFixed(3));
    set('pp-kd',    p.kd.toFixed(4));
    set('pp-ngam',  p.ngam_photon.toFixed(2));

    // YBM badge: compare to FBA ceiling 1.84
    const ybmBadge = document.getElementById('pp-YBM-badge');
    if (ybmBadge) {
        const fba_ceil = 1.84;
        const pct = Math.min(100, (p.YBM / fba_ceil * 100)).toFixed(0);
        const cls = pct >= 85 ? 'badge-success' : pct >= 60 ? 'badge-warning' : 'badge-danger';
        ybmBadge.innerHTML = `<span class="badge ${cls}">${pct}% of FBA ceiling (${fba_ceil} gCDW·mmol⁻¹)</span>`;
    }

    // Show/hide purple product legend row
    show('pp-product-legend-row', _productFluxSource !== 'manual' || p.Y_X > 0);
}

function simUpdateDerived(p) {
    const muMax = simHoperMu(p.I0, 0, p.alpha, p.KL, p.YBM, p.kd, p.ngam_photon, 0);
    const tau   = p.alpha * p.XA;
    const mEl = document.getElementById('sim-mumax-val');
    const tEl = document.getElementById('sim-tau-val');
    if (mEl) mEl.textContent = muMax.toFixed(3);
    if (tEl) tEl.textContent = tau.toFixed(2);
}

/**
 * Höper 2024 net growth rate with Beer-Lambert depth integration.
 *
 *   J_I,0 = α · I₀ · 3.6          (photon absorption rate at surface, mmol·gCDW⁻¹·h⁻¹)
 *   τ     = α · X_A                (optical thickness, dimensionless)
 *
 *   Dilute (τ→0):
 *     J*_I        = K_L · J_I / (K_L + J_I)    [quantum efficiency, Höper 2024 Eq. 5]
 *     J_net       = J*_I − k_d · J_I − ngam_p  [Eq. 6 + NGAM maintenance]
 *     μ           = Y_BM · 10⁻³ · max(0, J_net)
 *
 *   Depth-integrated (τ > 0):
 *     J*_avg      = (K_L/τ) · ln((K_L + J_I,0) / (K_L + J_I,1))
 *     J_dmg_avg   = J_I,0 · (1 − e^−τ) / τ   [mean raw flux, for damage term]
 *     μ           = Y_BM · 10⁻³ · max(0, J*_avg − k_d · J_dmg_avg − ngam_p)
 *
 *   k_d = 0.07 (dimensionless, ATP/photon, Höper 2024 Table 1).
 *   Photodamage uses raw J_I (not J*_I), matching the GitHub FBA implementation.
 *   ngam_photon (mmol·gCDW⁻¹·h⁻¹): photon-equivalent NGAM maintenance cost.
 *   Optional Haldane photoinhibition (KI > 0) is not part of Höper 2024.
 */
function simHoperMu(I0, XA, alpha, KL, YBM_m, kd, ngam_photon, KI) {
    if (I0 <= 0) return 0;
    const JI0 = alpha * I0 * 3.6;
    const tau  = alpha * XA;
    let mu;
    if (tau < 1e-6) {
        const jstar = KL * JI0 / (KL + JI0);
        const jnet  = jstar - kd * JI0 - ngam_photon;
        mu = (YBM_m * 1e-3) * Math.max(0, jnet);
    } else {
        const JI1        = JI0 * Math.exp(-tau);
        const jstar_avg  = (KL / tau) * Math.log((KL + JI0) / (KL + JI1));
        const jdmg_avg   = JI0 * (1 - Math.exp(-tau)) / tau;
        const jnet       = jstar_avg - kd * jdmg_avg - ngam_photon;
        mu = (YBM_m * 1e-3) * Math.max(0, jnet);
    }
    if (KI > 0) mu *= 1 / (1 + I0 / KI);
    return mu;
}

// ── Growth curve render ───────────────────────────────────────────────────────
function simRenderGrowthCurve(p) {
    const { alpha, KL, YBM, kd, ngam_photon, I0, XA } = p;
    const N    = 300;
    // When experimental data is loaded, cap the curve to the data range so the
    // visual fit matches R² (which is only computed at the data points).
    const hasExp = _expData && _expData.length > 0;
    const Imax = hasExp
        ? Math.max(..._expData.map(r => r.I0)) * 1.1
        : Math.max(...ZAVREL_2019_DATA.map(d => d.I)) * 1.1;
    // Always use _expDataXA (0 by default, mean from uploaded data if provided).
    // The XA slider is for the bioreactor productivity model, not the growth curve.
    // This ensures the drawn curve matches what R² is computed against.
    const curveXA = _expDataXA;
    const pts  = [];
    for (let i = 0; i <= N; i++) {
        const I  = (i / N) * Imax;
        const mu = simHoperMu(I, curveXA, alpha, KL, YBM, kd, ngam_photon, 0);
        pts.push({ x: I, y: mu });
    }

    const datasets = [{
        label: 'Simulation for static FBA (last run)',
        data: pts.map(p => ({ x: p.x, y: p.y })),
        borderColor: '#2e7a42', backgroundColor: 'rgba(46,122,66,0.06)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
    }];


    // FBA sweep overlay
    if (simFbaPoints?.length) {
        datasets.push({
            label: 'FBA with QY Correction',
            data: simFbaPoints.map(p => ({ x: p.I, y: p.mu })),
            borderColor: '#c0392b', backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 2, borderDash: [6, 3],
            pointRadius: 0, fill: false, tension: 0,
        });
    }

    // Single FBA run marker
    if (simFbaMarker) {
        datasets.push({
            label: `FBA: I₀≈${simFbaMarker.I0.toFixed(0)}, μ=${simFbaMarker.growth.toFixed(4)}`,
            data: [{ x: simFbaMarker.I0, y: simFbaMarker.mu }],
            type: 'scatter',
            borderColor: '#e74c3c', backgroundColor: '#e74c3c',
            pointRadius: 7, pointStyle: 'triangle',
        });
    }

    // Reference overlay
    if (simRefData?.gcPts?.length) {
        datasets.push({
            label: simRefData.label,
            data: simRefData.gcPts.map(p => ({ x: p.x, y: p.y })),
            borderColor: 'rgba(120,120,120,0.7)', backgroundColor: 'rgba(0,0,0,0)',
            fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
            borderDash: [6, 4],
        });
    }


    // Experimental data Zavřel 2019
    datasets.push({
        label: 'Zavřel 2019 (exp.)',
        data: ZAVREL_2019_DATA.map(d => ({ x: d.I, y: d.mu })),
        type: 'scatter',
        borderColor: '#1a64c8', backgroundColor: 'rgba(26,100,200,0.75)',
        pointRadius: 5, pointHoverRadius: 7, showLine: false,
    });

    if (simGrowthChart) { simGrowthChart.destroy(); simGrowthChart = null; }
    simGrowthChart = new Chart(
        document.getElementById('sim-growth-chart').getContext('2d'), {
        type: 'line',
        data: { datasets },
        plugins: [fixedPlotTopPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                fixedPlotTop: { reservedTop: 75 },
                legend: { display: true, position: 'top',
                          labels: { font: { size: 10 }, boxWidth: 16 } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            if (ctx.dataset.label?.startsWith('Zavřel')) {
                                const d = ZAVREL_2019_DATA[ctx.dataIndex];
                                return `Zavřel 2019: μ = ${d.mu.toFixed(4)} ± ${d.muErr.toFixed(4)} h⁻¹`;
                            }
                            return `${ctx.dataset.label}: μ = ${ctx.parsed.y.toFixed(4)} h⁻¹`;
                        },
                    },
                },
                zoom: {
                    zoom: { drag: { enabled: true }, mode: 'xy' },
                    pan:  { enabled: false },
                    limits: { x: { min: 0 }, y: { min: 0 } },
                },
            },
            scales: {
                x: { type: 'linear', title: { display: true, text: 'I₀ (µmol·m⁻²·s⁻¹)', font: { size: 10 } },
                     ticks: { font: { size: 10 }, maxTicksLimit: 7 } },
                y: { title: { display: true, text: 'μ (h⁻¹)', font: { size: 10 } },
                     ticks: { font: { size: 10 } } },
            },
        },
    });
    expDataUpdateCharts();
}


// ── Custom reactions management ───────────────────────────────────────────────

let _crNoteTimer = null;
function crFlashNote(html) {
    const el = document.getElementById('cr-note');
    if (!el) return;
    el.innerHTML = html;
    el.style.opacity = '1';
    clearTimeout(_crNoteTimer);
    _crNoteTimer = setTimeout(() => {
        el.style.transition = 'opacity 1s';
        el.style.opacity = '0';
        setTimeout(() => { el.innerHTML = ''; el.style.opacity = '1'; el.style.transition = ''; }, 1000);
    }, 4000);
}

// Common BiGG base ID → human-readable name (fallback for crReconstructEq)
const BIGG_NAMES = {
    akg:'2-Oxoglutarate', o2:'O₂', co2:'CO₂', h2o:'H₂O', h:'H⁺',
    nad:'NAD⁺', nadh:'NADH', nadp:'NADP⁺', nadph:'NADPH',
    atp:'ATP', adp:'ADP', amp:'AMP', pi:'Pᵢ', ppi:'PPᵢ',
    coa:'CoA', accoa:'Acetyl-CoA', succoa:'Succinyl-CoA',
    succ:'Succinate', fum:'Fumarate', mal:'Malate', oaa:'Oxaloacetate',
    cit:'Citrate', icit:'Isocitrate', pyr:'Pyruvate', pep:'PEP',
    g6p:'Glucose-6P', f6p:'Fructose-6P', g3p:'G3P', dhap:'DHAP',
    glu:'Glutamate', gln:'Glutamine', asp:'Aspartate', asn:'Asparagine',
    nh4:'NH₄⁺', no3:'NO₃⁻', so4:'SO₄²⁻', hco3:'HCO₃⁻',
    ac:'Acetate', acald:'Acetaldehyde', etoh:'Ethanol', for:'Formate',
    lac:'Lactate', fe2:'Fe²⁺', fe3:'Fe³⁺', photon:'Photon',
    o2s:'O₂ (periplasm)', glc:'Glucose', fru:'Fructose',
};

function crReconstructEq(stoich, new_mets) {
    function metName(id) {
        // 1. user-supplied new_mets name
        if (new_mets && new_mets[id] && new_mets[id].name) return new_mets[id].name;
        // 2. curated BiGG lookup (strip compartment suffix)
        const base = id.replace(/_[a-z]$/, '');
        if (BIGG_NAMES[base]) return BIGG_NAMES[base];
        // 3. fallback: capitalised base ID
        return base.charAt(0).toUpperCase() + base.slice(1);
    }
    function side(entries) {
        return entries.map(([id, c]) => {
            const abs = Math.abs(c);
            return (abs === 1 ? '' : abs + ' ') + metName(id);
        }).join(' + ');
    }
    const entries = Object.entries(stoich);
    const lhs = side(entries.filter(([,c]) => c < 0));
    const rhs = side(entries.filter(([,c]) => c > 0));
    return lhs && rhs ? `${lhs} ⇌ ${rhs}` : '';
}

function crRender() {
    const wrap = document.getElementById('cr-list-wrap');
    const list = document.getElementById('cr-list');
    if (customReactions.length === 0) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';
    list.innerHTML = customReactions.map((rd, i) => {
        const stoichStr = Object.entries(rd.stoich)
            .map(([k, v]) => `${k}:${v > 0 ? '+' : ''}${v}`)
            .join(', ');
        const eq = crReconstructEq(rd.stoich, rd.new_mets);
        return `<div class="mb-2">
            <div class="d-flex align-items-baseline">
                <code class="mr-2 text-primary font-weight-bold">${esc(rd.id)}</code>
                <span class="text-muted mr-2" style="font-size:0.82em;">${esc(rd.name || '')}</span>
                <button class="btn btn-link text-danger py-0 ml-auto" style="font-size:0.8em;"
                        onclick="crRemove(${i})"><i class="fa fa-times"></i></button>
            </div>
            ${eq ? `<div style="font-size:0.85em;margin-bottom:2px;">${esc(eq)}</div>` : ''}
            <div style="font-size:0.78em;font-family:monospace;color:#555;">${esc(stoichStr)}</div>
        </div>`;
    }).join('');
}

function crRemove(i) {
    if (customReactions[i]?.id === _trackedProductReaction) {
        _trackedProductReaction = null;
        _sweepProductFlux = null;
    }
    customReactions.splice(i, 1);
    crRender();
    updateProductSourceUI();
}

function crClearAll() {
    _trackedProductReaction = null;
    _sweepProductFlux = null;
    customReactions = [];
    crRender();
    updateProductSourceUI();
}

function crAddTemplate() {
    const key = document.getElementById('cr-template-select').value;
    if (!key || !REACTION_TEMPLATES[key]) {
        alert('Select a template first.');
        return;
    }
    const tmpl = REACTION_TEMPLATES[key];
    let added = 0;
    tmpl.reactions.forEach(rd => {
        if (!customReactions.find(r => r.id === rd.id)) {
            customReactions.push(rd);
            added++;
        }
    });
    crRender();
    updateProductSourceUI();
    crFlashNote(`<i class="fa fa-check-circle text-success"></i> <strong>${esc(tmpl.label)}</strong> added — will be included in the next FBA run.`);
}

function crAddManual() {
    const id     = document.getElementById('cr-man-id').value.trim();
    const name   = document.getElementById('cr-man-name').value.trim();
    const lb     = parseFloat(document.getElementById('cr-man-lb').value) || 0;
    const ub     = parseFloat(document.getElementById('cr-man-ub').value) || 1000;
    const stoichRaw  = document.getElementById('cr-man-stoich').value.trim();
    const newMetRaw  = document.getElementById('cr-man-newmets').value.trim();

    if (!id) { alert('Reaction ID is required.'); return; }

    // Parse stoichiometry: "akg_c:-1, o2_c:-1, succ_c:1"
    const stoich = {};
    stoichRaw.split(',').forEach(part => {
        const [k, v] = part.trim().split(':');
        if (k && v !== undefined) stoich[k.trim()] = parseFloat(v);
    });
    if (Object.keys(stoich).length === 0) { alert('Enter at least one stoichiometry entry.'); return; }

    // Parse new metabolites: "ethy_c:Ethylene:C2H4"
    const new_mets = {};
    if (newMetRaw) {
        newMetRaw.split(',').forEach(part => {
            const bits = part.trim().split(':');
            if (bits.length >= 1) {
                new_mets[bits[0].trim()] = {
                    name:        bits[1]?.trim() || bits[0].trim(),
                    formula:     bits[2]?.trim() || '',
                    compartment: bits[0].trim().slice(-1) || 'c',
                };
            }
        });
    }

    if (customReactions.find(r => r.id === id)) {
        alert(`Reaction ${id} already added.`);
        return;
    }
    customReactions.push({ id, name, lb, ub, stoich, new_mets });
    crRender();
    updateProductSourceUI();
    // Clear fields and hide form
    ['cr-man-id', 'cr-man-name', 'cr-man-stoich', 'cr-man-newmets'].forEach(elId =>
        document.getElementById(elId).value = '');
    document.getElementById('cr-man-stoich-preview').style.display = 'none';
    document.getElementById('cr-man-unknown-panel').style.display  = 'none';
    document.getElementById('cr-manual-form').style.display = 'none';
    crFlashNote(`<i class="fa fa-check-circle text-success"></i> Reaction <strong>${esc(id)}</strong> added — will be included in the next FBA run.`);
}

// ── KEGG reaction lookup ──────────────────────────────────────────────────────
function crLookupKegg() {
    const input  = document.getElementById('cr-kegg-input');
    const status = document.getElementById('cr-kegg-status');
    const id     = input.value.trim().toUpperCase();

    if (!/^R\d{5}$/.test(id)) {
        status.innerHTML = '<span class="text-danger"><i class="fa fa-times"></i> Use format R##### (e.g. R09415)</span>';
        return;
    }

    status.innerHTML = '<span class="text-muted"><i class="fa fa-spinner fa-spin"></i> Looking up…</span>';

    fetch('/api/metabolic/kegg_reaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kegg_id: id }),
    })
    .then(r => r.json().then(d => ({ ok: r.ok, data: d })))
    .then(({ ok, data }) => {
        if (!ok) {
            status.innerHTML = `<span class="text-danger"><i class="fa fa-times"></i> ${esc(data.error || 'Not found')}</span>`;
            return;
        }

        // Populate the manual reaction form
        const form = document.getElementById('cr-manual-form');
        form.style.display = '';
        document.getElementById('cr-man-id').value   = id;
        document.getElementById('cr-man-name').value = data.kegg_name || '';

        // Build stoich string: "akg_c:-1, o2_c:-1, succ_c:1"
        const stoichEntries = Object.entries(data.stoich || {});
        const stoichStr = stoichEntries
            .map(([met, coeff]) => `${met}:${Number.isInteger(coeff) || coeff % 1 === 0 ? Math.round(coeff) : coeff}`)
            .join(', ');
        document.getElementById('cr-man-stoich').value = stoichStr;

        // Build new_mets string: "ethy_c:Ethylene:C2H4"
        const newMetsStr = Object.entries(data.new_mets || {})
            .map(([met]) => `${met}::`)
            .join(', ');
        document.getElementById('cr-man-newmets').value = newMetsStr;

        // Human-readable reaction equation preview
        const preview = document.getElementById('cr-man-stoich-preview');
        if (stoichEntries.length) {
            const subs = stoichEntries.filter(([,c]) => c < 0)
                .map(([m, c]) => `${Math.abs(c) === 1 ? '' : Math.abs(c) + ' '}${m}`).join(' + ');
            const prods = stoichEntries.filter(([,c]) => c > 0)
                .map(([m, c]) => `${c === 1 ? '' : c + ' '}${m}`).join(' + ');
            preview.innerHTML = `<span class="text-secondary"><i class="fa fa-arrow-right"></i> Mapped reaction: <strong>${esc(subs || '?')} → ${esc(prods || '?')}</strong></span>`;
            preview.style.display = '';
        } else {
            preview.style.display = 'none';
        }

        // Handle unmapped metabolites — populate the action panel
        const unknowns  = data.unknown_mets || [];
        const unknPanel = document.getElementById('cr-man-unknown-panel');
        const unknList  = document.getElementById('cr-man-unknown-list');
        if (unknowns.length && unknList) {
            unknList.innerHTML = unknowns.map(u => {
                const mnx      = esc(u.mnx_id || '');
                const cpd      = u.kegg_cpd  || '';
                const name     = u.name      || '';
                const coeff    = u.coeff     != null ? u.coeff : '?';
                const coeffFmt = (typeof coeff === 'number' && coeff % 1 === 0)
                                 ? Math.round(coeff) : coeff;
                const keggHref = cpd
                    ? `<a href="https://www.genome.jp/entry/${esc(cpd)}" target="_blank">
                         ${esc(cpd)}${name ? ' — ' + esc(name) : ''} <i class="fa fa-external-link"></i></a>`
                    : mnx;
                const role     = coeff < 0 ? 'substrate (consumed)' : 'product (produced)';
                const suggestId= name
                    ? name.split(';')[0].trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').slice(0,12) + '_c'
                    : (cpd ? cpd.toLowerCase() + '_c' : mnx + '_c');
                return `<div class="border rounded px-2 py-1 mb-1 bg-white">
                    <strong>${keggHref}</strong>
                    — coefficient <strong>${coeffFmt}</strong> (${role})<br>
                    <span class="text-muted">Suggested ID: <code>${esc(suggestId)}</code>
                    &nbsp;→ add <code>${esc(suggestId)}:${coeffFmt}</code> to Stoichiometry
                    and <code>${esc(suggestId)}:${esc(name || '')}:${name ? '' : '??'}</code> to New metabolites</span>
                </div>`;
            }).join('');
            unknPanel.style.display = '';
        } else if (unknPanel) {
            unknPanel.style.display = 'none';
        }

        // Status summary
        const nNew      = Object.keys(data.new_mets || {}).length;
        const warns     = data.warnings || [];
        const keggLink  = `<a href="https://www.genome.jp/entry/${esc(id)}" target="_blank" class="ml-2 small"><i class="fa fa-external-link"></i> KEGG entry</a>`;
        let msg = `<span class="text-success"><i class="fa fa-check"></i> Stoichiometry loaded${keggLink}`;
        if (nNew)           msg += ` — <strong>${nNew} new metabolite(s)</strong> not yet in model: fill name &amp; formula below`;
        if (unknowns.length)msg += ` — <span class="text-warning"><i class="fa fa-exclamation-triangle"></i> ${unknowns.length} metabolite(s) need manual entry (see panel below)</span>`;
        if (warns.length)   msg += ` — <span class="text-warning">${warns.map(esc).join('; ')}</span>`;
        msg += '</span>';
        status.innerHTML = msg;

        // Scroll form into view so user sees the populated fields
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    })
    .catch(err => {
        status.innerHTML = `<span class="text-danger"><i class="fa fa-times"></i> Request failed: ${esc(String(err))}</span>`;
    });
}

// ── KEGG reaction typeahead ────────────────────────────────────────────────────
(function () {
    let _searchTimer = null;
    let _activeIdx   = -1;
    let _results     = [];

    function getInput()    { return document.getElementById('cr-kegg-input'); }
    function getDropdown() { return document.getElementById('cr-kegg-dropdown'); }

    function closeDropdown() {
        const dd = getDropdown();
        if (dd) { dd.style.display = 'none'; dd.innerHTML = ''; }
        _activeIdx = -1;
        _results   = [];
    }

    function renderDropdown(items) {
        const dd = getDropdown();
        if (!dd) return;
        if (!items.length) { closeDropdown(); return; }
        _results = items;
        dd.innerHTML = items.map((item, i) =>
            `<div class="kegg-dd-item" data-idx="${i}"
                  style="padding:5px 10px;cursor:pointer;border-bottom:1px solid #f0f0f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                <strong>${esc(item.id)}</strong>&nbsp;<span class="text-muted">${esc(item.name)}</span>
             </div>`
        ).join('');
        dd.style.display = '';

        dd.querySelectorAll('.kegg-dd-item').forEach(el => {
            el.addEventListener('mousedown', e => {
                e.preventDefault();   // keep focus on input
                const idx = parseInt(el.dataset.idx, 10);
                selectItem(idx);
            });
            el.addEventListener('mouseover', () => {
                setActive(parseInt(el.dataset.idx, 10));
            });
        });
    }

    function setActive(idx) {
        const dd = getDropdown();
        if (!dd) return;
        const items = dd.querySelectorAll('.kegg-dd-item');
        items.forEach((el, i) => {
            el.style.background = i === idx ? '#e8f4fd' : '';
        });
        _activeIdx = idx;
    }

    function selectItem(idx) {
        const item = _results[idx];
        if (!item) return;
        const inp = getInput();
        inp.value = item.id;
        closeDropdown();
        crLookupKegg();
    }

    function doSearch(query) {
        if (query.length < 2) { closeDropdown(); return; }
        fetch('/api/metabolic/kegg_search?q=' + encodeURIComponent(query))
            .then(r => r.ok ? r.json() : [])
            .then(items => renderDropdown(items))
            .catch(() => closeDropdown());
    }

    // Initialise once DOM is ready
    function initTypeahead() {
        const inp = getInput();
        if (!inp) return;

        inp.addEventListener('input', () => {
            clearTimeout(_searchTimer);
            const val = inp.value.trim();
            // If it already looks like a bare R-number, skip search
            if (/^R\d{5}$/.test(val.toUpperCase())) { closeDropdown(); return; }
            _searchTimer = setTimeout(() => doSearch(val), 300);
        });

        inp.addEventListener('keydown', e => {
            const dd = getDropdown();
            if (dd && dd.style.display !== 'none') {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive(Math.min(_activeIdx + 1, _results.length - 1));
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive(Math.max(_activeIdx - 1, 0));
                    return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (_activeIdx >= 0) { selectItem(_activeIdx); return; }
                    closeDropdown();
                    crLookupKegg();
                    return;
                }
                if (e.key === 'Escape') { closeDropdown(); return; }
            }
            if (e.key === 'Enter') { e.preventDefault(); crLookupKegg(); }
        });

        document.addEventListener('click', e => {
            if (!inp.contains(e.target) && !getDropdown().contains(e.target)) {
                closeDropdown();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initTypeahead);
    } else {
        initTypeahead();
    }
})();

// ── Haldane FBA integration ───────────────────────────────────────────────────

/** Called after every successful FBA run. Marks the result point on the Haldane chart. */
// ── FBA result → sim marker ───────────────────────────────────────────────────
function simMarkFBAPoint(growth, fluxes) {
    const photonKeys = ['EX_photon_e1_e', 'EX_photon_e', 'R_EX_photon_e'];
    let photon = 0;
    for (const k of photonKeys) {
        if (fluxes[k] !== undefined) { photon = Math.abs(fluxes[k]); break; }
    }
    if (photon === 0) return;
    // I₀ is read directly from the slider — the FBA bound was set to J*_I (quantum-corrected),
    // so back-calculating from photon flux would give the wrong (lower) I₀.
    const I0 = parseFloat(document.getElementById('sim-I0')?.value) || 660;
    simFbaMarker = { growth, I0, photon };
    // Live-update the static FBA marker on the sweep chart if already rendered
    if (simFbaGrowthChart) {
        const ds1 = simFbaGrowthChart.data.datasets[1];
        if (ds1) {
            ds1.label  = 'Static FBA (last run)';
            ds1.data   = [{ x: I0, y: growth }];
            ds1.hidden = false;
            simFbaGrowthChart.update();
        }
    }
    simRecompute();
}

function simClearFbaMarker() {
    simFbaMarker = null;
    simRecompute();
}

// ── Nelder-Mead minimiser (unconstrained, for ≤6 parameters) ─────────────────
/**
 * Differential Evolution (DE/rand/1/bin) global optimizer.
 * All parameters in log-transformed space; bounds respected via clamping.
 * Followed by Nelder-Mead local refinement from the best solution found.
 */
function differentialEvolution(f, bounds, { F = 0.8, CR = 0.9, maxGen = 400 } = {}) {
    const n  = bounds.length;
    const NP = Math.max(15, 10 * n);

    // Initialize population uniformly within bounds
    let pop   = Array.from({ length: NP }, () =>
        bounds.map(b => b.lo + Math.random() * (b.hi - b.lo)));
    let costs = pop.map(f);

    for (let gen = 0; gen < maxGen; gen++) {
        for (let i = 0; i < NP; i++) {
            // Pick 3 distinct indices ≠ i
            let a, b, c;
            do { a = Math.floor(Math.random() * NP); } while (a === i);
            do { b = Math.floor(Math.random() * NP); } while (b === i || b === a);
            do { c = Math.floor(Math.random() * NP); } while (c === i || c === a || c === b);

            const jrand = Math.floor(Math.random() * n);
            const trial = pop[i].map((xi, j) => {
                if (j === jrand || Math.random() < CR) {
                    const v = pop[a][j] + F * (pop[b][j] - pop[c][j]);
                    return Math.max(bounds[j].lo, Math.min(bounds[j].hi, v));
                }
                return xi;
            });

            const tc = f(trial);
            if (tc <= costs[i]) { pop[i] = trial; costs[i] = tc; }
        }
    }

    const best = costs.indexOf(Math.min(...costs));
    // Refine with Nelder-Mead from the DE best
    return nelderMead(f, pop[best]);
}

function nelderMead(f, x0, maxIter = 6000, tol = 1e-10) {
    const n = x0.length;
    // Initial simplex: x0 + perturbed copies (50% perturbation for better exploration)
    let S = [x0.slice()];
    for (let i = 0; i < n; i++) {
        const v = x0.slice();
        v[i] = v[i] !== 0 ? v[i] * 1.5 : 0.5;
        S.push(v);
    }
    let vals = S.map(f);

    for (let iter = 0; iter < maxIter; iter++) {
        // Sort
        const ord = Array.from({ length: n + 1 }, (_, i) => i).sort((a, b) => vals[a] - vals[b]);
        S    = ord.map(i => S[i]);
        vals = ord.map(i => vals[i]);
        if (vals[n] - vals[0] < tol) break;

        // Centroid of best n
        const xo = Array(n).fill(0);
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) xo[j] += S[i][j] / n;

        // Reflect
        const xr = xo.map((v, j) => 2 * v - S[n][j]);
        const fr = f(xr);

        if (fr < vals[0]) {
            const xe = xo.map((v, j) => 3 * v - 2 * S[n][j]);
            const fe = f(xe);
            S[n] = fe < fr ? xe : xr;
            vals[n] = Math.min(fe, fr);
        } else if (fr < vals[n - 1]) {
            S[n] = xr; vals[n] = fr;
        } else {
            const xc = xo.map((v, j) => 0.5 * (v + S[n][j]));
            const fc = f(xc);
            if (fc < vals[n]) {
                S[n] = xc; vals[n] = fc;
            } else {
                for (let i = 1; i <= n; i++) {
                    S[i] = S[i].map((v, j) => 0.5 * (v + S[0][j]));
                    vals[i] = f(S[i]);
                }
            }
        }
    }
    return { x: S[0], val: vals[0] };
}

// ── Experimental data helpers & Höper model fitting ──────────────────────────

function expDataLoad() {
    const raw = document.getElementById('exp-data-paste')?.value?.trim();
    const statusEl = document.getElementById('exp-data-status');
    const previewEl = document.getElementById('exp-data-preview');
    const fitOpts = document.getElementById('fit-params-options');
    if (!raw) { _expData = null; expDataUpdateCharts(); _updateFitBtn(); if(statusEl) statusEl.textContent=''; if(previewEl) previewEl.style.display='none'; return; }

    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 1) { if(statusEl) { statusEl.textContent = 'No data found.'; statusEl.className = 'small text-danger'; } return; }

    // Detect whether first row is a header or numeric data
    const firstCells = lines[0].split('\t');
    const firstIsNumeric = firstCells.every(c => !isNaN(parseFloat(c.trim())) && c.trim() !== '');

    let iI0, iMu, iErr, iXA, iRho, iV, iA, iQprod, dataStart;
    if (firstIsNumeric) {
        // No header row — assign columns positionally: I0, mu, [mu_err], [X_A]
        iI0 = 0; iMu = 1; iErr = firstCells.length >= 3 ? 2 : -1;
        iXA = firstCells.length >= 4 ? 3 : -1;
        iRho = -1; iV = -1; iA = -1; iQprod = -1;
        dataStart = 0;
    } else {
        const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
        const col = h => headers.indexOf(h);
        iI0 = col('i0'); iMu = col('mu');
        if (iI0 < 0 || iMu < 0) { if(statusEl) { statusEl.textContent = 'Missing required columns: I0, mu'; statusEl.className = 'small text-danger'; } return; }
        iErr = col('mu_err'); iXA = col('x_a'); iRho = col('rho'); iV = col('v'); iA = col('a');
        iQprod = col('q_product');
        dataStart = 1;
    }

    const rows = [];
    for (let i = dataStart; i < lines.length; i++) {
        const cells = lines[i].split('\t');
        const I0  = parseFloat(cells[iI0]);
        const mu  = parseFloat(cells[iMu]);
        if (isNaN(I0) || isNaN(mu)) continue;
        const mu_err   = iErr   >= 0 ? parseFloat(cells[iErr])   || null : null;
        const q_product = iQprod >= 0 ? parseFloat(cells[iQprod]) || null : null;
        let X_A = iXA >= 0 ? parseFloat(cells[iXA]) || null : null;
        // compute X_A from rho, V, A if not provided directly
        if (X_A == null && iRho >= 0 && iV >= 0 && iA >= 0) {
            const rho = parseFloat(cells[iRho]), V = parseFloat(cells[iV]), A = parseFloat(cells[iA]);
            if (!isNaN(rho) && !isNaN(V) && !isNaN(A) && A > 0) X_A = rho * V / A;
        }
        rows.push({ I0, mu, mu_err, X_A, q_product });
    }

    if (rows.length === 0) { if(statusEl) { statusEl.textContent = 'No valid rows parsed.'; statusEl.className = 'small text-danger'; } return; }

    _expData = rows;
    // Mean X_A across rows that have it; 0 otherwise (dilute/uniform-light assumption)
    const xaRows = rows.filter(r => r.X_A != null && !isNaN(r.X_A));
    _expDataXA = xaRows.length > 0 ? xaRows.reduce((s, r) => s + r.X_A, 0) / xaRows.length : 0;
    if(statusEl) { statusEl.textContent = `${rows.length} rows loaded.`; statusEl.className = 'small text-success'; }
    // Preview table
    if (previewEl) {
        const cols = [
            { key: 'I0',     head: 'I₀',            fmt: v => v },
            { key: 'mu',     head: 'μ (h⁻¹)',        fmt: v => v.toFixed(4) },
            { key: 'mu_err',   head: '± μ',                      fmt: v => v != null ? v.toFixed(4) : '—' },
            { key: 'X_A',      head: 'X_A (g·m⁻²)',             fmt: v => v != null ? v.toFixed(2)  : '—' },
            { key: 'q_product', head: 'q_product (mmol·gDW⁻¹·h⁻¹)', fmt: v => v != null ? v.toFixed(5) : '—' },
            { key: 'rho',      head: 'ρ (g·L⁻¹)',               fmt: v => v != null ? v.toFixed(3)  : '—' },
            { key: 'V',        head: 'V (L)',                    fmt: v => v != null ? v.toFixed(3)  : '—' },
            { key: 'A',        head: 'A (m²)',                   fmt: v => v != null ? v.toFixed(4)  : '—' },
        ];
        const th    = cols.map(c => `<th>${c.head}</th>`).join('');
        const tbody = rows.map(r => `<tr>${cols.map(c => `<td>${c.fmt(r[c.key])}</td>`).join('')}</tr>`).join('');
        previewEl.innerHTML = `<table class="table table-sm table-borderless mb-0"><thead><tr>${th}</tr></thead><tbody>${tbody}</tbody></table>`;
        previewEl.style.display = '';
    }

    // Extract q_product data and fit empirical model if column present
    const qRows = rows.filter(r => r.q_product != null && r.q_product > 0 && r.I0 > 0);
    if (qRows.length >= 2) {
        _expProductData = qRows.map(r => ({ I0: r.I0, q_product: r.q_product }));
        fitEmpiricalProductModel();
    } else {
        _expProductData = null;
        _empiricalProductFit = null;
    }

    expDataUpdateCharts();
    updateProductSourceUI();
    // Refresh product chart overlay if sweep has already run
    if (simFbaData) renderSweepProductChart(simFbaData, +document.getElementById('sim-alpha')?.value || 0.13);
    _updateFitBtn();
}

function expDataClear() {
    _expData = null;
    _expDataXA = 0;
    _expProductData   = null;
    _empiricalProductFit = null;
    const paste = document.getElementById('exp-data-paste');
    if (paste) paste.value = '';
    const statusEl = document.getElementById('exp-data-status');
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'small text-muted'; }
    const previewEl = document.getElementById('exp-data-preview');
    if (previewEl) { previewEl.style.display = 'none'; previewEl.innerHTML = ''; }
    expDataUpdateCharts();
    updateProductSourceUI();
    _updateFitBtn();
}

function expDataUpdateCharts() {
    [simFbaGrowthChart, simGrowthChart].forEach(chart => {
        if (!chart) return;
        const idx = chart.data.datasets.findIndex(ds => ds.label === 'Experimental data');
        if (!_expData) {
            if (idx >= 0) { chart.data.datasets.splice(idx, 1); chart.update(); }
            return;
        }
        const ds = {
            label: 'Experimental data',
            data: _expData.map(r => ({ x: r.I0, y: r.mu })),
            type: 'scatter',
            borderColor: '#8e44ad', backgroundColor: 'rgba(142,68,173,0.7)',
            pointRadius: 5, pointHoverRadius: 7, pointStyle: 'rectRot',
        };
        if (idx >= 0) { chart.data.datasets[idx] = ds; } else { chart.data.datasets.push(ds); }
        chart.update();
    });
}

function _updateFitBtn() {
    const btn = document.getElementById('sim-fit-btn');
    if (!btn) return;
    if (_expData && _expData.length >= 3) {
        btn.innerHTML = '<i class="fa fa-magic"></i> Fit to uploaded data';
    } else {
        btn.innerHTML = '<i class="fa fa-magic"></i> Fit to Zavřel 2019';
    }
}

/**
 * Compute R², RMSE, and compensation point using current slider values.
 * If _expData is loaded, computes against experimental data.
 * Updates #sim-fit-result display.  Returns { r2, rmse, iComp } or null.
 */
function computeFitQuality() {
    // Always compare against experimental data: uploaded or Zavřel 2019 default.
    const hasUploadedData = _expData && _expData.length >= 3;

    const KL_draw   = parseFloat(document.getElementById('sim-KL')?.value)          || 119;
    const YBM_draw  = parseFloat(document.getElementById('sim-YBM')?.value)          || 1.84;
    const kd_draw   = parseFloat(document.getElementById('sim-kd')?.value)           || 0.07;
    const ngam_draw = parseFloat(document.getElementById('sim-ngam-photon')?.value)  || 1;
    const al_draw   = parseFloat(document.getElementById('sim-alpha')?.value)        || 0.13;

    let pts;
    if (hasUploadedData) {
        pts = _expData.map(r => ({ I: r.I0, mu: r.mu, X_A: r.X_A ?? _expDataXA }));
    } else {
        pts = ZAVREL_2019_DATA.map(d => ({ I: d.I, mu: d.mu, X_A: 0 }));
    }

    const obs_mean = pts.reduce((s, p) => s + p.mu, 0) / pts.length;
    let ss_res = 0, ss_tot = 0;
    const debugRows = [];
    pts.forEach(({ I, mu: obs, X_A }) => {
        const pred = simHoperMu(I, X_A, al_draw, KL_draw, YBM_draw, kd_draw, ngam_draw, 0);
        ss_res += (pred - obs) ** 2;
        ss_tot += (obs - obs_mean) ** 2;
        debugRows.push({ I0: +I.toFixed(2), obs: +obs.toFixed(5), pred: +pred.toFixed(5), residual: +(pred-obs).toFixed(5) });
    });
    const r2   = ss_tot > 0 ? (1 - ss_res / ss_tot) : 0;  // allow negative: bad fit < 0 < good fit ≤ 1
    const rmse = Math.sqrt(ss_res / pts.length);

    // Compensation point
    let iComp = null;
    const muAt0    = simHoperMu(1e-3, 0, al_draw, KL_draw, YBM_draw, kd_draw, ngam_draw, 0);
    const muAt2000 = simHoperMu(2000, 0, al_draw, KL_draw, YBM_draw, kd_draw, ngam_draw, 0);
    if (muAt0 <= 0 && muAt2000 > 0) {
        let lo = 0, hi = 500;
        for (let k = 0; k < 40; k++) {
            const mid = (lo + hi) / 2;
            simHoperMu(mid, 0, al_draw, KL_draw, YBM_draw, kd_draw, ngam_draw, 0) > 0 ? hi = mid : lo = mid;
        }
        iComp = (lo + hi) / 2;
    }

    const out = document.getElementById('sim-fit-result');
    if (out && out.style.display !== 'none') {
        const r2Color = r2 >= 0.98 ? 'text-success' : r2 >= 0.90 ? 'text-warning' : 'text-danger';
        const r2Str   = r2 < 0 ? r2.toFixed(2) : r2.toFixed(4);  // negative: fewer decimals needed
        const src = hasUploadedData ? 'uploaded data' : 'Zavřel 2019';
        const r2Tip = 'R² = 1 − SS_res/SS_tot. '
            + 'SS_res = Σ(obs−pred)², SS_tot = Σ(obs−mean)². '
            + 'R²=1: perfect fit. R²=0: no better than the mean. R²<0: worse than the mean (model shape is wrong).';
        out.innerHTML = `<i class="fa fa-check-circle text-success"></i> Fitted to ${src} &nbsp;`
            + `<span class="${r2Color}"><strong>R² = ${r2Str}</strong></span>`
            + ` <i class="fa fa-info-circle text-muted" title="${r2Tip}" style="cursor:help;"></i>`
            + (iComp != null ? ` &nbsp;·&nbsp; I₀<sub>comp</sub> = ${iComp.toFixed(0)} µmol·m⁻²·s⁻¹` : '')
            + ` &nbsp;·&nbsp; X<sub>A</sub> = ${_expDataXA.toFixed(1)} g·m⁻²`;
    }

    return { r2, rmse, iComp };
}

function simFitToFBA() {
    // Always fit to experimental data: uploaded data if available, else Zavřel 2019 default.
    const hasUploadedData = _expData && _expData.length >= 3;
    const XA_fallback = _expDataXA;

    let pts;
    if (hasUploadedData) {
        pts = _expData.map(r => ({ I: r.I0, mu: r.mu, X_A: r.X_A ?? XA_fallback, w: r.mu_err ? 1 / (r.mu_err * r.mu_err) : 1 }));
    } else {
        // Fall back to built-in Zavřel 2019 reference data
        pts = ZAVREL_2019_DATA.map(d => ({ I: d.I, mu: d.mu, X_A: 0, w: d.muErr ? 1 / (d.muErr * d.muErr) : 1 }));
    }
    // Relative residual scale: median µ — prevents high-µ points dominating
    const muMedian = pts.map(p => p.mu).sort((a,b)=>a-b)[Math.floor(pts.length/2)] || 1e-3;

    const btn = document.getElementById('sim-fit-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Fitting…';

    setTimeout(() => {
        try {
            // Free parameters controlled by checkboxes (always fitting to exp data)
            const freeKL    = document.getElementById('fit-free-KL')?.checked;
            const freeYBM   = document.getElementById('fit-free-YBM')?.checked;
            const freekd    = document.getElementById('fit-free-kd')?.checked;
            const freeNgam  = document.getElementById('fit-free-ngam')?.checked;
            const freeAlpha = document.getElementById('fit-free-alpha')?.checked;

            const KL0    = parseFloat(document.getElementById('sim-KL')?.value)          || 119;
            const YBM0   = parseFloat(document.getElementById('sim-YBM')?.value)          || 1.84;
            const alpha0 = Math.max(0.01,  parseFloat(document.getElementById('sim-alpha')?.value)       || 0.13);
            const kd0    = Math.max(0.001, parseFloat(document.getElementById('sim-kd')?.value)          || 0.07);
            const ngam0  = Math.max(0.01,  parseFloat(document.getElementById('sim-ngam-photon')?.value) || 1);

            // FBA stoichiometric ceiling for YBM: computed from last static FBA run.
            // No fitted YBM can exceed this — the metabolic network sets the hard limit.
            let YBM_fba_ceil = 1.84; // FBA stoichiometric ceiling (iRH783 default)
            if (_lastFbaResultForSummary?.growth_rate > 0) {
                const lf     = _lastFbaResultForSummary;
                const I0_lf  = lf.sliders?.['sim-I0'];
                if (I0_lf) {
                    const JI_lf   = alpha0 * I0_lf * 3.6;
                    const jstar_lf = KL0 * JI_lf / (KL0 + JI_lf);
                    const jnet_lf  = jstar_lf - kd0 * JI_lf - ngam0;
                    if (jnet_lf > 0)
                        YBM_fba_ceil = lf.growth_rate * 1000 / jnet_lf;
                }
            }
            YBM_fba_ceil = Math.min(1.84, Math.max(0.5, YBM_fba_ceil));

            // All params in log space — 5 dimensions: [lnKL, lnYBM, lnKd, lnNgam, lnAlpha]
            // YBM upper bound: slider max (5.0) for exp-data fitting — the FBA ceiling is shown
            // as a reference in the result, but NOT enforced as a fitting constraint here.
            // The FBA ceiling is a model-specific value; real cells may differ.
            const BOUNDS = [
                { lo: Math.log(10),    hi: Math.log(500)  },  // KL    slider [10,500]
                { lo: Math.log(0.5),   hi: Math.log(5.0)  },  // YBM   slider [0.5,5]
                { lo: Math.log(0.001), hi: Math.log(0.5)  },  // kd    slider [0,0.5]
                { lo: Math.log(0.01),  hi: Math.log(50)   },  // ngam  slider [0,50]
                { lo: Math.log(0.03),  hi: Math.log(0.40) },  // alpha slider [0.01,0.50]
            ];
            const x0_full = [Math.log(KL0), Math.log(YBM0), Math.log(kd0), Math.log(ngam0), Math.log(alpha0)];
            const free    = [freeKL, freeYBM, freekd, freeNgam, freeAlpha];
            const fixed   = x0_full.slice();

            const freeIdx = free.map((f, i) => f ? i : -1).filter(i => i >= 0);
            if (freeIdx.length === 0) { alert('Select at least one free parameter.'); btn.disabled=false; _updateFitBtn(); return; }

            const freeBounds = freeIdx.map(i => BOUNDS[i]);

            // Relative residuals: normalise by (obs + muMedian/2) so low-µ points
            // are not swamped by high-µ ones, but near-zero observations don't blow up
            const cost = (x_red) => {
                const x = fixed.slice();
                freeIdx.forEach((dim, j) => { x[dim] = x_red[j]; });
                const [KL, Y, kd, ngam, al] = x.map(Math.exp);
                return pts.reduce((s, { I, mu: obs, X_A, w }) => {
                    const pred = simHoperMu(I, X_A, al, KL, Y, kd, ngam, 0);
                    const scale = obs + muMedian * 0.5;
                    return s + w * ((pred - obs) / scale) ** 2;
                }, 0);
            };

            // Global search with Differential Evolution, then NM refinement
            const best = differentialEvolution(cost, freeBounds);

            const x_opt = fixed.slice();
            freeIdx.forEach((dim, j) => { x_opt[dim] = best.x[j]; });

            const [KL_fit, YBM_fit, kd_fit, ngam_fit, alpha_fit] = x_opt.map(Math.exp);

            if (freeKL)    simSetSlider('sim-KL',  KL_fit,  10,  500, 0);
            if (freeYBM)   simSetSlider('sim-YBM', YBM_fit, 0.5, 5.0, 2);
            if (freekd)    simSetSlider('sim-kd',          kd_fit,                          0,    0.5,          3);
            if (freeNgam)  simSetSlider('sim-ngam-photon', ngam_fit,                        0,   50,            2);
            if (freeAlpha) simSetSlider('sim-alpha',       alpha_fit,                       0.01, 0.50,         2);

            // Show the result panel before simRecompute so computeFitQuality finds it visible
            const out = document.getElementById('sim-fit-result');
            if (out) out.style.display = '';

            simRecompute();   // redraws the curve; computeFitQuality() called inside
            computeFitQuality(); // explicit call in case visibility guard blocked it
            _growthCurveFitted = true;
            updateTabGates();
        } finally {
            btn.disabled = false;
            _updateFitBtn();
        }
    }, 20);
}

/** Set a range slider value (clamped) and update its display label. */
function simSetSlider(id, value, min, max, decimals) {
    const clamped = Math.max(min, Math.min(max, value));
    const el = document.getElementById(id);
    if (el) {
        el.value = clamped;
        const lbl = document.getElementById(id + '-val');
        if (lbl) lbl.textContent = clamped.toFixed(decimals);
    }
}

// ── Culture Productivity Simulator (Höper 2024) ───────────────────────────────

/**
 * Chemostat steady-state: for each D, bisect ρ_A such that simHoperMu(I₀,ρ_A,…)=D.
 * μ is monotone decreasing in ρ_A (self-shading), so bisection is valid.
 */
function simComputeChemostat(p) {
    const { I0, alpha, KL, YBM, kd, ngam_photon, Y_X } = p;
    const steps  = 300;
    const mu_max = simHoperMu(I0, 0, alpha, KL, YBM, kd, ngam_photon, 0);
    const D_max  = Math.max(0, mu_max - 1e-4);
    if (D_max <= 0) return { points: [], D_opt: 0, P_max: 0, D_max: 0 };

    const points = [];
    let D_opt = 0, P_max = 0, rho_A_opt = 0;

    for (let i = 1; i <= steps; i++) {
        const D = (i / steps) * D_max;
        // Bisect ρ_A: simHoperMu is monotone decreasing in ρ_A
        let lo = 0, hi = 5000;
        for (let k = 0; k < 80; k++) {
            const mid = (lo + hi) / 2;
            if (simHoperMu(I0, mid, alpha, KL, YBM, kd, ngam_photon, 0) > D) lo = mid; else hi = mid;
        }
        const rho_A = (lo + hi) / 2;
        const P_A   = rho_A * D * 24;

        // Product flux: FBA/empirical (decoupled) or manual Y_X (growth-coupled)
        let P_prod = null;
        const v_prod = getProductFluxAtI0(_beerlambertMeanI(I0, alpha, rho_A));
        if (v_prod != null) {
            P_prod = v_prod * rho_A * 24;   // mmol·m⁻²·d⁻¹
        } else if (Y_X > 0) {
            P_prod = Y_X * rho_A * D * 24;  // mmol·m⁻²·d⁻¹ (growth-coupled approx)
        }

        points.push({ D, rho_A, P_A, P_prod });
        if (P_A > P_max) { P_max = P_A; D_opt = D; rho_A_opt = rho_A; }
    }

    return { points, D_opt, P_max, D_max, rho_A_opt };
}

/** Batch culture ODE: dρ_A/dt = simHoperMu(I₀, ρ, …) · ρ — integrated via RK4. */
// Beer-Lambert depth-averaged irradiance: mean light seen by all cells at density rho_A
function _beerlambertMeanI(I0, alpha, rho_A) {
    const tau = alpha * rho_A;
    return tau > 1e-4 ? I0 * (1 - Math.exp(-tau)) / tau : I0;
}

function simComputeBatch(p) {
    const { I0, alpha, KL, YBM, kd, ngam_photon, rho0, t_end, Y_X } = p;
    const steps = 600;
    const dt    = t_end / steps;
    let rho     = rho0;
    let P_max = 0, t_Pmax = 0;
    const points = [];

    const f = r => simHoperMu(I0, Math.max(0, r), alpha, KL, YBM, kd, ngam_photon, 0) * Math.max(0, r);

    for (let i = 0; i <= steps; i++) {
        const t      = i * dt;
        const mu     = simHoperMu(I0, rho, alpha, KL, YBM, kd, ngam_photon, 0);
        const P_inst = Math.max(0, mu * rho);
        const I_bot  = I0 * Math.exp(-alpha * rho);

        // Product flux: FBA/empirical (decoupled) or manual Y_X (growth-coupled)
        let P_prod = null;
        const v_prod = getProductFluxAtI0(_beerlambertMeanI(I0, alpha, rho));
        if (v_prod != null) {
            P_prod = v_prod * rho;   // mmol·m⁻²·h⁻¹
        } else if (Y_X > 0) {
            P_prod = Y_X * P_inst;   // mmol·m⁻²·h⁻¹ (growth-coupled approx)
        }

        if (P_inst > P_max) { P_max = P_inst; t_Pmax = t; }
        points.push({ t, rho, mu, P_inst, I_bot, P_prod });

        if (i < steps) {
            const k1 = f(rho);
            const k2 = f(rho + 0.5 * dt * k1);
            const k3 = f(rho + 0.5 * dt * k2);
            const k4 = f(rho + dt * k3);
            rho = Math.max(0, rho + (dt / 6) * (k1 + 2*k2 + 2*k3 + k4));
        }
    }

    return { points, P_max, t_Pmax };
}

function simRenderChemostat(d) {
    const ctx = document.getElementById('sim-chemo-chart')?.getContext('2d');
    if (!ctx) return;
    if (simChemoChart) { simChemoChart.destroy(); simChemoChart = null; }
    const placeholder = document.getElementById('sim-prod-placeholder');
    const chartWrap   = document.getElementById('sim-chemo-charts');
    if (!d.points.length) {
        if (placeholder) placeholder.style.display = '';
        if (chartWrap)   chartWrap.style.display   = 'none';
        return;
    }
    if (placeholder) placeholder.style.display = 'none';

    // Store operating point for Biosynthetic Cost dependent mode
    bcSimState = { D_opt: d.D_opt, I0: simGetParams().I0 };
    // If dependent mode is currently selected, refresh the description label
    if (document.getElementById('bc-mode-dep')?.checked) {
        const desc = document.getElementById('bc-mode-desc-text');
        if (desc) desc.innerHTML = `<i class="fa fa-link"></i> Using simulation state: D<sub>opt</sub> = ${bcSimState.D_opt.toFixed(4)} h⁻¹, I₀ = ${bcSimState.I0} µmol·m⁻²·s⁻¹. Growth fixed; cost per mmol of target reaction flux.`;
    }
    if (chartWrap)   chartWrap.style.display   = '';

    const p      = simGetParams();
    const labels = d.points.map(pt => pt.D.toFixed(4));

    // Populate chemostat insight panel with live computed values
    const fmtResult = (html) => `<span class="badge badge-primary" style="font-size:0.9em;">${html}</span>`;
    const setIns = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    const fba_ceil = 1.84;
    const p_ins = simGetParams();
    const pct = Math.min(100, (p_ins.YBM / fba_ceil * 100)).toFixed(0);
    setIns('prod-insight-dopt',    `Identified D<sub>opt</sub> = ${fmtResult(d.D_opt.toFixed(4) + ' h⁻¹')}`);
    setIns('prod-insight-rhoopt',  `Identified ρ<sub>A,opt</sub> = ${fmtResult(d.rho_A_opt.toFixed(1) + ' g CDM·m⁻²')}`);
    setIns('prod-insight-pamax-chemo', `Identified P<sub>A,max</sub> = ${fmtResult(d.P_max.toFixed(1) + ' g CDM·m⁻²·d⁻¹')}`);
    setIns('prod-insight-ybm',     `Current Y<sub>BM</sub> = ${p_ins.YBM.toFixed(3)} gCDW·mmol⁻¹ — ${fmtResult(pct + '% of FBA ceiling')}. Raising Y<sub>BM</sub> to 1.84 would give P<sub>A,max</sub> ≈ ${fmtResult((d.P_max * fba_ceil / Math.max(p_ins.YBM, 0.01)).toFixed(1) + ' g CDM·m⁻²·d⁻¹')}.`);

    const datasets = [
        {
            label: 'P_A — Areal productivity (g CDM·m⁻²·d⁻¹)',
            data: d.points.map(pt => pt.P_A),
            borderColor: 'rgba(40,167,69,0.9)',
            backgroundColor: 'rgba(40,167,69,0.08)',
            fill: true, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        },
        {
            label: 'ρ_A — Biomass density (g CDM·m⁻²)',
            data: d.points.map(pt => pt.rho_A),
            borderColor: 'rgba(255,140,0,0.9)',
            borderDash: [5, 3],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y2',
        },
    ];

    if (simRefData?.mode === 'chemo' && simRefData.prodData?.points?.length) {
        datasets.push({
            label: `P_A — ${simRefData.label}`,
            data: simRefData.prodData.points.map(pt => pt.P_A),
            borderColor: 'rgba(120,120,120,0.7)',
            borderDash: [6, 4],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        });
    }

    const hasDecoupledProduct = d.points[0]?.P_prod != null && _productFluxSource !== 'manual';
    const hasCoupledProduct   = d.points[0]?.P_prod != null && _productFluxSource === 'manual' && p.Y_X > 0;

    if (hasDecoupledProduct || hasCoupledProduct) {
        datasets.push({
            label: `${p.productName || 'Product'} (mmol·m⁻²·d⁻¹)`,
            data: d.points.map(pt => pt.P_prod),
            borderColor: 'rgba(111,66,193,0.85)',
            borderDash: hasDecoupledProduct ? [] : [3, 3],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y3',
        });
    }

    const scales = {
        x:  { title: { display: true, text: 'Dilution rate D (h⁻¹)', font: { size: 11 } }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y:  { title: { display: true, text: ['P_A — Areal productivity', '(g CDM·m⁻²·d⁻¹)'], font: { size: 11 } }, position: 'left',  ticks: { font: { size: 10 } } },
        y2: { title: { display: true, text: ['ρ_A — Biomass density', '(g CDM·m⁻²)'],        font: { size: 11 } }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
    };
    if (hasDecoupledProduct || hasCoupledProduct) {
        scales.y3 = { title: { display: true, text: `${p.productName || 'Product'} (mmol·m⁻²·d⁻¹)`, font: { size: 11 }, color: 'rgba(111,66,193,0.9)' }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, color: 'rgba(111,66,193,0.9)' } };
    }

    simChemoChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Chemostat: Productivity & Biomass vs Dilution Rate', font: { size: 12 } },
            },
            scales,
        }
    });

    simRenderChemostatNew(d, p);
    simRenderChemoRhoChart(d);
}

/**
 * Render 3 design/operating charts below the main chemostat plot:
 *   A. Light-response operational envelope — P_A,max + D_opt + ρ_A,opt vs I₀
 *   B. Volumetric productivity P_V vs reactor depth z (family of I₀ curves)
 *   C. Normalised operating window — P_A/P_A,max vs D (robustness)
 */
function simRenderChemostatNew(d, p) {
    if (!d.points.length) return;

    // ── Chart A: Light-response operational envelope ──────────────────────────
    // Sweep I₀ 50→2000 µmol·m⁻²·s⁻¹; for each: record P_A,max, D_opt, ρ_A,opt
    if (simChemoI0Chart) { simChemoI0Chart.destroy(); simChemoI0Chart = null; }
    {
        const I0_steps = 40;
        const i0_labels = [], pa_max = [], d_opt_vals = [], rho_opt_vals = [];
        for (let i = 1; i <= I0_steps; i++) {
            const I0_val = i * (2000 / I0_steps);   // 50, 100, …, 2000
            const res = simComputeChemostat({ ...p, I0: I0_val });
            if (!res.points.length) continue;
            i0_labels.push(I0_val.toFixed(0));
            pa_max.push(res.P_max.toFixed(2));
            d_opt_vals.push(res.D_opt.toFixed(4));
            rho_opt_vals.push(res.rho_A_opt.toFixed(1));
        }
        // Mark current I₀ with a vertical plugin
        const curI0 = p.I0;
        const annotI0 = {
            id: 'curI0line',
            afterDraw(chart) {
                const ds = chart.getDatasetMeta(0);
                if (!ds.data.length) return;
                let idx = 0, minD = Infinity;
                i0_labels.forEach((v, i) => { const diff = Math.abs(+v - curI0); if (diff < minD) { minD = diff; idx = i; } });
                const x = ds.data[idx]?.x;
                if (x == null) return;
                const { ctx: c, chartArea: { top, bottom } } = chart;
                c.save();
                c.setLineDash([4, 3]);
                c.strokeStyle = 'rgba(220,53,69,0.6)';
                c.lineWidth = 1.5;
                c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
                c.setLineDash([]);
                c.fillStyle = 'rgba(220,53,69,0.75)';
                c.font = '9px sans-serif';
                c.fillText('current I₀', x + 3, top + 10);
                c.restore();
            }
        };
        simChemoI0Chart = new Chart(document.getElementById('sim-chemo-i0-chart').getContext('2d'), {
            type: 'line',
            data: {
                labels: i0_labels,
                datasets: [
                    {
                        label: 'P_A,max — Max areal productivity (g CDM·m⁻²·d⁻¹)',
                        data: pa_max,
                        borderColor: 'rgba(40,167,69,0.9)', backgroundColor: 'rgba(40,167,69,0.07)',
                        fill: true, tension: 0.3, pointRadius: 0, yAxisID: 'y',
                    },
                    {
                        label: 'D_opt — Optimal dilution rate (h⁻¹)',
                        data: d_opt_vals,
                        borderColor: 'rgba(0,123,255,0.85)', borderDash: [5, 3],
                        fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'y2',
                    },
                    {
                        label: 'ρ_A,opt — Optimal biomass density (g CDM·m⁻²)',
                        data: rho_opt_vals,
                        borderColor: 'rgba(255,140,0,0.85)', borderDash: [3, 3],
                        fill: false, tension: 0.3, pointRadius: 0, yAxisID: 'y3',
                    },
                ],
            },
            plugins: [annotI0],
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'top', labels: { font: { size: 10 } } },
                    title:  { display: true, text: 'Light-response envelope: optimal operating point vs incident irradiance I₀', font: { size: 12 } },
                },
                scales: {
                    x:  { title: { display: true, text: 'I₀ — Incident irradiance (µmol·m⁻²·s⁻¹)', font: { size: 11 } }, ticks: { font: { size: 10 } } },
                    y:  { title: { display: true, text: ['P_A,max', '(g CDM·m⁻²·d⁻¹)'], font: { size: 11 }, color: 'rgba(40,167,69,0.9)' }, position: 'left',  ticks: { font: { size: 10 }, color: 'rgba(40,167,69,0.9)' }, min: 0 },
                    y2: { title: { display: true, text: ['D_opt', '(h⁻¹)'], font: { size: 11 }, color: 'rgba(0,123,255,0.9)' }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, color: 'rgba(0,123,255,0.9)' }, min: 0 },
                    y3: { title: { display: true, text: ['ρ_A,opt', '(g CDM·m⁻²)'], font: { size: 11 }, color: 'rgba(255,140,0,0.9)' }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, color: 'rgba(255,140,0,0.9)' }, min: 0 },
                },
            }
        });
    }

    // ── Chart B: Volumetric productivity P_V vs reactor depth z ──────────────
    // P_A,max is independent of z; P_V = P_A,max / z (hyperbola).
    // Show curves for I₀/2, current I₀, and I₀×2 to combine depth + light info.
    if (simChemoPvChart) { simChemoPvChart.destroy(); simChemoPvChart = null; }
    {
        const z_steps = 50;
        const z_labels = [];
        for (let i = 1; i <= z_steps; i++) z_labels.push((i * 0.01).toFixed(2));  // 0.01…0.50

        const pvCurve = (I0_val) => {
            const res = simComputeChemostat({ ...p, I0: I0_val });
            const pa  = res.P_max;
            return z_labels.map(z => pa > 0 ? (pa / +z).toFixed(1) : null);
        };

        const I0_cur  = p.I0;
        const I0_low  = Math.max(50, I0_cur * 0.5);
        const I0_high = Math.min(2000, I0_cur * 2);
        const curZ    = Math.max(0.01, Math.min(0.50, p.z_reactor || 0.10));

        // Annotation: vertical line at current z
        const annotZ = {
            id: 'curZline',
            afterDraw(chart) {
                const ds = chart.getDatasetMeta(0);
                if (!ds.data.length) return;
                let idx = 0, minD = Infinity;
                z_labels.forEach((v, i) => { const diff = Math.abs(+v - curZ); if (diff < minD) { minD = diff; idx = i; } });
                const x = ds.data[idx]?.x;
                if (x == null) return;
                const { ctx: c, chartArea: { top, bottom } } = chart;
                c.save();
                c.setLineDash([4, 3]);
                c.strokeStyle = 'rgba(220,53,69,0.6)';
                c.lineWidth = 1.5;
                c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
                c.setLineDash([]);
                c.fillStyle = 'rgba(220,53,69,0.75)';
                c.font = '9px sans-serif';
                c.fillText('current z', x + 3, top + 10);
                c.restore();
            }
        };

        simChemoPvChart = new Chart(document.getElementById('sim-chemo-pv-chart').getContext('2d'), {
            type: 'line',
            data: {
                labels: z_labels,
                datasets: [
                    {
                        label: `I₀ = ${I0_low.toFixed(0)} µmol·m⁻²·s⁻¹`,
                        data: pvCurve(I0_low),
                        borderColor: 'rgba(0,123,255,0.6)', borderDash: [4, 3],
                        fill: false, tension: 0.2, pointRadius: 0,
                    },
                    {
                        label: `I₀ = ${I0_cur.toFixed(0)} µmol·m⁻²·s⁻¹ (current)`,
                        data: pvCurve(I0_cur),
                        borderColor: 'rgba(40,167,69,0.9)', backgroundColor: 'rgba(40,167,69,0.07)',
                        fill: true, tension: 0.2, pointRadius: 0,
                    },
                    {
                        label: `I₀ = ${I0_high.toFixed(0)} µmol·m⁻²·s⁻¹`,
                        data: pvCurve(I0_high),
                        borderColor: 'rgba(255,140,0,0.75)', borderDash: [2, 2],
                        fill: false, tension: 0.2, pointRadius: 0,
                    },
                ],
            },
            plugins: [annotZ],
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'top', labels: { font: { size: 10 } } },
                    title:  { display: true, text: 'Volumetric productivity P_V vs reactor depth z (at D_opt per I₀)', font: { size: 12 } },
                },
                scales: {
                    x: { title: { display: true, text: 'Reactor depth z (m)', font: { size: 11 } }, ticks: { font: { size: 10 } } },
                    y: { title: { display: true, text: ['P_V — Volumetric productivity', '(g CDM·m⁻³·d⁻¹)'], font: { size: 11 } }, position: 'left', ticks: { font: { size: 10 } }, min: 0 },
                },
            }
        });
    }

    // ── Chart C: Normalised operating window / robustness ─────────────────────
    // Shows P_A(D) / P_A,max. The width of the region above 0.9 quantifies
    // how tolerant the culture is to dilution rate variation.
    if (simChemoRobustChart) { simChemoRobustChart.destroy(); simChemoRobustChart = null; }
    {
        const norm_labels = d.points.map(pt => pt.D.toFixed(4));
        const norm_pa     = d.points.map(pt => (pt.P_A / d.P_max).toFixed(4));

        // Find D window where P_A > 90 % of P_A,max
        const lo90 = d.points.find(pt => pt.P_A / d.P_max >= 0.9);
        const hi90 = [...d.points].reverse().find(pt => pt.P_A / d.P_max >= 0.9);
        const windowStr = (lo90 && hi90)
            ? `90 % window: D = ${lo90.D.toFixed(4)} – ${hi90.D.toFixed(4)} h⁻¹ (Δ = ${(hi90.D - lo90.D).toFixed(4)} h⁻¹)`
            : '';

        // Annotation: D_opt vertical + 0.9 horizontal
        const annotRobust = {
            id: 'robustAnnot',
            afterDraw(chart) {
                const ds = chart.getDatasetMeta(0);
                if (!ds.data.length) return;
                const { ctx: c, chartArea: { left, right, top, bottom }, scales } = chart;
                // vertical at D_opt
                let idx = 0, minDiff = Infinity;
                d.points.forEach((pt, i) => { const diff = Math.abs(pt.D - d.D_opt); if (diff < minDiff) { minDiff = diff; idx = i; } });
                const xOpt = ds.data[idx]?.x;
                if (xOpt != null) {
                    c.save();
                    c.setLineDash([4, 3]);
                    c.strokeStyle = 'rgba(40,167,69,0.55)';
                    c.lineWidth = 1.5;
                    c.beginPath(); c.moveTo(xOpt, top); c.lineTo(xOpt, bottom); c.stroke();
                    c.setLineDash([]);
                    c.fillStyle = 'rgba(40,167,69,0.75)';
                    c.font = '9px sans-serif';
                    c.fillText('D_opt', xOpt + 3, top + 10);
                    c.restore();
                }
                // horizontal 90 % threshold
                const y90 = scales.y?.getPixelForValue(0.9);
                if (y90 != null) {
                    c.save();
                    c.setLineDash([3, 4]);
                    c.strokeStyle = 'rgba(220,53,69,0.5)';
                    c.lineWidth = 1;
                    c.beginPath(); c.moveTo(left, y90); c.lineTo(right, y90); c.stroke();
                    c.setLineDash([]);
                    c.fillStyle = 'rgba(220,53,69,0.65)';
                    c.font = '9px sans-serif';
                    c.fillText('90 %', right - 28, y90 - 3);
                    c.restore();
                }
            }
        };

        simChemoRobustChart = new Chart(document.getElementById('sim-chemo-robust-chart').getContext('2d'), {
            type: 'line',
            data: {
                labels: norm_labels,
                datasets: [{
                    label: 'P_A / P_A,max — Normalised areal productivity',
                    data: norm_pa,
                    borderColor: 'rgba(40,167,69,0.9)', backgroundColor: 'rgba(40,167,69,0.1)',
                    fill: true, tension: 0.3, pointRadius: 0,
                }],
            },
            plugins: [annotRobust],
            options: {
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: true, position: 'top', labels: { font: { size: 10 } } },
                    title:  { display: true, text: windowStr
                        ? `Operating window robustness — ${windowStr}`
                        : 'Operating window robustness: P_A / P_A,max vs D', font: { size: 11 } },
                },
                scales: {
                    x: { title: { display: true, text: 'Dilution rate D (h⁻¹)', font: { size: 11 } }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
                    y: { title: { display: true, text: 'P_A / P_A,max', font: { size: 11 } }, min: 0, max: 1, ticks: { font: { size: 10 } } },
                },
            }
        });
    }
}

function simRenderBatch(d) {
    const placeholder = document.getElementById('sim-prod-placeholder');
    const batchWrap   = document.getElementById('sim-batch-charts');
    if (!d.points.length) {
        if (placeholder) placeholder.style.display = '';
        if (batchWrap)   batchWrap.style.display   = 'none';
        return;
    }
    if (placeholder) placeholder.style.display = 'none';
    if (batchWrap)   batchWrap.style.display   = simMode === 'batch' ? '' : 'none';

    const pts    = d.points;
    const p      = simGetParams();
    const labels = pts.map(pt => pt.t.toFixed(1));

    // Populate batch insight panel with live computed values
    const fmtB = (html) => `<span class="badge badge-primary" style="font-size:0.9em;">${html}</span>`;
    const setInsB = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
    setInsB('prod-insight-pamax-batch', `Identified P<sub>A,max</sub> = ${fmtB(d.P_max.toFixed(3) + ' g CDM·m⁻²·h⁻¹')} at t = ${fmtB(d.t_Pmax.toFixed(1) + ' h')}`);

    // Chart 1: biomass density + bottom light
    if (simBatchDensityChart) { simBatchDensityChart.destroy(); simBatchDensityChart = null; }
    const densDatasets = [
        {
            label: 'ρ_A — Areal biomass density (g CDM·m⁻²)',
            data: pts.map(pt => pt.rho),
            borderColor: 'rgba(255,140,0,0.9)',
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        },
        {
            label: 'I_bottom — Back-face irradiance (µmol·m⁻²·s⁻¹)',
            data: pts.map(pt => pt.I_bot),
            borderColor: 'rgba(255,193,7,0.85)',
            borderDash: [4, 3],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y2',
        },
    ];
    if (simRefData?.mode === 'batch' && simRefData.prodData?.points?.length) {
        densDatasets.push({
            label: `ρ_A — ${simRefData.label}`,
            data: simRefData.prodData.points.map(pt => pt.rho),
            borderColor: 'rgba(120,120,120,0.65)',
            borderDash: [6, 4],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        });
    }
    simBatchDensityChart = new Chart(
        document.getElementById('sim-batch-density-chart').getContext('2d'), {
        type: 'line',
        data: { labels, datasets: densDatasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Batch: Biomass density & Bottom light', font: { size: 12 } },
            },
            scales: {
                x:  { title: { display: true, text: 'Time (h)', font: { size: 11 } }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
                y:  { title: { display: true, text: ['ρ_A — Biomass density', '(g CDM·m⁻²)'],             font: { size: 11 } }, position: 'left',  ticks: { font: { size: 10 } } },
                y2: { title: { display: true, text: ['I_bottom — Back-face irradiance', '(µmol·m⁻²·s⁻¹)'], font: { size: 11 } }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
            },
        },
    });

    // Chart 2: productivity + growth rate
    if (simBatchProdChart) { simBatchProdChart.destroy(); simBatchProdChart = null; }
    const prodDatasets = [
        {
            label: 'P_A — Areal productivity (g CDM·m⁻²·h⁻¹)',
            data: pts.map(pt => pt.P_inst),
            borderColor: 'rgba(40,167,69,0.9)',
            backgroundColor: 'rgba(40,167,69,0.08)',
            fill: true, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        },
        {
            label: 'μ — Specific growth rate (h⁻¹)',
            data: pts.map(pt => pt.mu),
            borderColor: 'rgba(0,123,255,0.8)',
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y2',
        },
    ];
    if (simRefData?.mode === 'batch' && simRefData.prodData?.points?.length) {
        prodDatasets.push({
            label: `P_A — ${simRefData.label}`,
            data: simRefData.prodData.points.map(pt => pt.P_inst),
            borderColor: 'rgba(120,120,120,0.65)',
            borderDash: [6, 4],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        });
    }
    const batchHasDecoupledProduct = pts[0]?.P_prod != null && _productFluxSource !== 'manual';
    const batchHasCoupledProduct   = pts[0]?.P_prod != null && _productFluxSource === 'manual' && p.Y_X > 0;

    if (batchHasDecoupledProduct || batchHasCoupledProduct) {
        prodDatasets.push({
            label: `${p.productName || 'Product'} (mmol·m⁻²·h⁻¹)`,
            data: pts.map(pt => pt.P_prod),
            borderColor: 'rgba(111,66,193,0.85)',
            borderDash: batchHasDecoupledProduct ? [] : [3, 3],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y3',
        });
    }
    const batchProdScales = {
        x:  { title: { display: true, text: 'Time (h)', font: { size: 11 } }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y:  { title: { display: true, text: ['P_A — Areal productivity', '(g CDM·m⁻²·h⁻¹)'], font: { size: 11 } }, position: 'left',  ticks: { font: { size: 10 } } },
        y2: { title: { display: true, text: 'μ — Specific growth rate (h⁻¹)',               font: { size: 11 } }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
    };
    if (batchHasDecoupledProduct || batchHasCoupledProduct) {
        batchProdScales.y3 = { title: { display: true, text: `${p.productName || 'Product'} (mmol·m⁻²·h⁻¹)`, font: { size: 11 }, color: 'rgba(111,66,193,0.9)' }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 }, color: 'rgba(111,66,193,0.9)' } };
    }
    simBatchProdChart = new Chart(
        document.getElementById('sim-batch-prod-chart').getContext('2d'), {
        type: 'line',
        data: { labels, datasets: prodDatasets },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Batch: Productivity & Growth rate', font: { size: 12 } },
            },
            scales: batchProdScales,
        },
    });

    simRenderBatchRhoChart(d);
}

/**
 * Chemostat: P_A vs ρ_A — productivity envelope.
 * x = steady-state areal biomass density, y = areal productivity.
 * As D sweeps 0→D_max, ρ_A sweeps from high→0, tracing a dome.
 * The peak (orange triangle) marks the optimal operating point.
 */
function simRenderChemoRhoChart(d) {
    const ctx = document.getElementById('sim-chemo-rho-chart')?.getContext('2d');
    if (!ctx || !d.points.length) return;
    if (simChemoRhoChart) { simChemoRhoChart.destroy(); simChemoRhoChart = null; }

    // Sort ascending by ρ_A so the line traces left→right
    const sorted = [...d.points].sort((a, b) => a.rho_A - b.rho_A);

    simChemoRhoChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'P_A — Areal productivity (g CDM·m⁻²·d⁻¹)',
                    data: sorted.map(pt => ({ x: pt.rho_A, y: pt.P_A })),
                    borderColor: 'rgba(40,167,69,0.9)',
                    backgroundColor: 'rgba(40,167,69,0.08)',
                    fill: true, tension: 0.3, pointRadius: 0,
                    yAxisID: 'y',
                },
                {
                    // Optimal operating point marker
                    label: `Peak P_A = ${d.P_max.toFixed(1)} g·m⁻²·d⁻¹ at ρ_A = ${d.rho_A_opt.toFixed(1)} g·m⁻²`,
                    data: [{ x: d.rho_A_opt, y: d.P_max }],
                    type: 'scatter',
                    borderColor: 'rgba(255,140,0,1)',
                    backgroundColor: 'rgba(255,140,0,1)',
                    pointRadius: 8, pointHoverRadius: 10,
                    pointStyle: 'triangle',
                    yAxisID: 'y',
                },
            ],
        },
        options: {
            responsive: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Chemostat: Productivity vs Culture Density', font: { size: 12 } },
            },
            scales: {
                x:  { type: 'linear', title: { display: true, text: 'ρ_A — Areal biomass density (g CDM·m⁻²)', font: { size: 11 } }, min: 0, ticks: { font: { size: 10 } } },
                y:  { title: { display: true, text: ['P_A — Areal productivity', '(g CDM·m⁻²·d⁻¹)'], font: { size: 11 } }, position: 'left', min: 0, ticks: { font: { size: 10 } } },
            },
        },
    });
}

/**
 * Turbidostat: P_A vs ρ_A — family of curves for reference I₀ values + current I₀ highlighted.
 * x = ρ_A setpoint (what the turbidostat controller holds fixed),
 * y = P_A = μ(I₀, ρ_A) · ρ_A · 24  (g CDM·m⁻²·d⁻¹).
 * Each curve is computed directly — no bisection, no ODE.
 * The dome peak of each curve marks the optimal density for that irradiance.
 */
/**
 * Depth-averaged specific product flux for turbidostat parametric sweep.
 * Returns mmol·gDW⁻¹·h⁻¹ (areal product flux per unit biomass), or null if
 * no product source is active.
 *   - manual Y_X > 0 (growth-coupled): returns Y_X · μ  (not a depth average — exact)
 *   - fba_sweep / empirical (decoupled): integrates v_prod(I_local) over depth via N samples
 */
function turbProductFluxPerGDW(I0_val, rho, alpha, mu, Y_X) {
    if (_productFluxSource === 'manual') {
        return Y_X > 0 ? Y_X * mu : null;   // mmol·gDW⁻¹·h⁻¹, growth-coupled
    }
    // Decoupled: depth-average the irradiance-dependent flux through the culture
    const tau = alpha * rho;
    const N   = 24;
    let sum = 0;
    for (let k = 0; k < N; k++) {
        const I_local = I0_val * Math.exp(-(k + 0.5) / N * (tau < 1e-6 ? 0 : tau));
        const v = getProductFluxAtI0(I_local);
        if (v === null) return null;
        sum += v;
    }
    return sum / N;
}

function simRenderTurbRhoChart(p) {
    const ctx = document.getElementById('sim-turb-rho-chart')?.getContext('2d');
    if (!ctx) return;
    if (simTurbRhoChart) { simTurbRhoChart.destroy(); simTurbRhoChart = null; }

    const { alpha, KL, YBM, kd, ngam_photon, I0: curI0, Y_X } = p;
    const RHO_STEPS = 250;
    const RHO_MIN   = 0.05;   // g CDM·m⁻²

    // Dynamic scan limit: find highest ρ_A where P_A > 1% of peak, add 5% headroom
    let xMax = 0;
    const scanData = [];
    for (let j = 0; j <= RHO_STEPS; j++) {
        const rho  = RHO_MIN + (j / RHO_STEPS) * (400 - RHO_MIN);
        const mu   = simHoperMu(curI0, rho, alpha, KL, YBM, kd, ngam_photon, 0);
        const P_A  = Math.max(0, mu * rho * 24);
        const vp   = turbProductFluxPerGDW(curI0, rho, alpha, mu, Y_X);
        scanData.push({ x: rho, P_A, P_prod: vp !== null ? Math.max(0, vp * rho * 24) : null });
    }
    const peakPA = Math.max(...scanData.map(pt => pt.P_A));
    const thresh = peakPA * 0.01;
    const last   = [...scanData].reverse().find(pt => pt.P_A > thresh);
    if (last) xMax = Math.ceil(last.x * 1.05);
    if (xMax < 1) xMax = 10;

    const trimmed = scanData.filter(pt => pt.x <= xMax);
    const curPeak = trimmed.reduce((best, pt) => pt.P_A > best.P_A ? pt : best, trimmed[0]);

    // Build datasets
    const datasets = [
        {
            label: `P_A — Areal productivity (g CDM·m⁻²·d⁻¹)  |  I₀ = ${curI0} µmol·m⁻²·s⁻¹`,
            data: trimmed.map(pt => ({ x: pt.x, y: pt.P_A })),
            borderColor: 'rgba(40,167,69,0.9)',
            backgroundColor: 'rgba(40,167,69,0.07)',
            fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
            yAxisID: 'y',
        },
        {
            label: `Peak P_A = ${curPeak.P_A.toFixed(1)} g·m⁻²·d⁻¹ at ρ_A = ${curPeak.x.toFixed(1)} g·m⁻²`,
            data: [{ x: curPeak.x, y: curPeak.P_A }],
            type: 'scatter', yAxisID: 'y',
            borderColor: 'rgba(40,167,69,1)', backgroundColor: 'rgba(40,167,69,1)',
            pointRadius: 8, pointHoverRadius: 10, pointStyle: 'triangle',
        },
    ];

    const scales = {
        x: { type: 'linear', min: 0, max: xMax,
             title: { display: true, text: 'ρ_A — Areal biomass density / turbidostat setpoint (g CDM·m⁻²)', font: { size: 11 } },
             ticks: { font: { size: 10 } } },
        y: { min: 0, position: 'left',
             title: { display: true, text: ['P_A — Areal productivity', '(g CDM·m⁻²·d⁻¹)'], font: { size: 11 } },
             ticks: { font: { size: 10 } } },
    };

    // Product curve — only when a product source is configured
    const hasProd = trimmed[0]?.P_prod !== null;
    if (hasProd) {
        const prodPeak = trimmed.reduce((best, pt) => (pt.P_prod ?? 0) > (best.P_prod ?? 0) ? pt : best, trimmed[0]);
        const prodLabel = _productFluxSource === 'manual'
            ? `${p.productName || 'Product'} (Y_X=${Y_X} mmol·gCDM⁻¹, growth-coupled)`
            : `${p.productName || 'Product'} (decoupled, mmol·m⁻²·d⁻¹)`;
        datasets.push({
            label: prodLabel,
            data: trimmed.map(pt => ({ x: pt.x, y: pt.P_prod ?? 0 })),
            borderColor: 'rgba(111,66,193,0.85)', borderDash: _productFluxSource === 'manual' ? [3,3] : [],
            fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
            yAxisID: 'y2',
        });
        datasets.push({
            label: `Peak = ${(prodPeak.P_prod ?? 0).toFixed(1)} mmol·m⁻²·d⁻¹ at ρ_A = ${prodPeak.x.toFixed(1)} g·m⁻²`,
            data: [{ x: prodPeak.x, y: prodPeak.P_prod ?? 0 }],
            type: 'scatter', yAxisID: 'y2',
            borderColor: 'rgba(111,66,193,1)', backgroundColor: 'rgba(111,66,193,1)',
            pointRadius: 7, pointHoverRadius: 9, pointStyle: 'triangle',
        });
        scales.y2 = {
            min: 0, position: 'right', grid: { drawOnChartArea: false },
            title: { display: true, text: [`${p.productName || 'Product'} productivity`, '(mmol·m⁻²·d⁻¹)'], font: { size: 11 }, color: 'rgba(111,66,193,0.9)' },
            ticks: { font: { size: 10 }, color: 'rgba(111,66,193,0.9)' },
        };
    }

    simTurbRhoChart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 20 } },
                title: {
                    display: true,
                    text: `Turbidostat: Areal Productivity vs Culture Density  (I₀ = ${curI0} µmol·m⁻²·s⁻¹)`,
                    font: { size: 12 },
                },
            },
            scales,
        },
    });
}

/**
 * Turbidostat: P_V vs X — volumetric productivity vs volumetric density.
 * Uses current I₀ only. Product productivity added on y2 when Y_X > 0 or decoupled source active.
 *   X [g·L⁻¹]        = ρ_A [g·m⁻²] / (z [m] × 1000)
 *   P_V [g·L⁻¹·d⁻¹] = μ × X × 24
 */
function simRenderTurbVolChart(p) {
    const ctx = document.getElementById('sim-turb-vol-chart')?.getContext('2d');
    if (!ctx) return;
    if (simTurbVolChart) { simTurbVolChart.destroy(); simTurbVolChart = null; }

    const { alpha, KL, YBM, kd, ngam_photon, I0: curI0, Y_X } = p;
    const z    = Math.max(0.01, p.z_reactor || 0.10);
    const toX  = (rho) => rho / (z * 1000);   // g·m⁻² → g·L⁻¹

    const X_MAX     = 20;
    const RHO_STEPS = 300;
    const RHO_MAX   = X_MAX * z * 1000;
    const RHO_MIN   = 0.05;

    const scanData = [];
    for (let j = 0; j <= RHO_STEPS; j++) {
        const rho  = RHO_MIN + (j / RHO_STEPS) * (RHO_MAX - RHO_MIN);
        const mu   = simHoperMu(curI0, rho, alpha, KL, YBM, kd, ngam_photon, 0);
        const X    = toX(rho);
        const P_V  = Math.max(0, mu * X * 24);
        const vp   = turbProductFluxPerGDW(curI0, rho, alpha, mu, Y_X);
        // Volumetric product: mmol·gDW⁻¹·h⁻¹ × gDW·L⁻¹ × 24 h/d = mmol·L⁻¹·d⁻¹
        const P_prodV = vp !== null ? Math.max(0, vp * X * 24) : null;
        scanData.push({ x: X, P_V, P_prod: P_prodV });
    }

    const curPeak = scanData.reduce((best, pt) => pt.P_V > best.P_V ? pt : best, scanData[0]);

    const datasets = [
        {
            label: `P_V — Volumetric productivity (g CDM·L⁻¹·d⁻¹)  |  I₀ = ${curI0} µmol·m⁻²·s⁻¹`,
            data: scanData.map(pt => ({ x: pt.x, y: pt.P_V })),
            borderColor: 'rgba(40,167,69,0.9)',
            backgroundColor: 'rgba(40,167,69,0.07)',
            fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
            yAxisID: 'y',
        },
        {
            label: `Peak P_V = ${curPeak.P_V.toFixed(3)} g·L⁻¹·d⁻¹ at X = ${curPeak.x.toFixed(3)} g·L⁻¹`,
            data: [{ x: curPeak.x, y: curPeak.P_V }],
            type: 'scatter', yAxisID: 'y',
            borderColor: 'rgba(40,167,69,1)', backgroundColor: 'rgba(40,167,69,1)',
            pointRadius: 8, pointHoverRadius: 10, pointStyle: 'triangle',
        },
    ];

    const scales = {
        x: { type: 'linear', min: 0, max: X_MAX,
             title: { display: true, text: 'X — Biomass concentration / turbidostat setpoint (g CDM·L⁻¹)', font: { size: 11 } },
             ticks: { font: { size: 10 } } },
        y: { min: 0, position: 'left',
             title: { display: true, text: ['P_V — Volumetric productivity', '(g CDM·L⁻¹·d⁻¹)'], font: { size: 11 } },
             ticks: { font: { size: 10 } } },
    };

    const hasProd = scanData[0]?.P_prod !== null;
    if (hasProd) {
        const prodPeak = scanData.reduce((best, pt) => (pt.P_prod ?? 0) > (best.P_prod ?? 0) ? pt : best, scanData[0]);
        const prodLabel = _productFluxSource === 'manual'
            ? `${p.productName || 'Product'} (Y_X=${Y_X} mmol·gCDM⁻¹, growth-coupled)`
            : `${p.productName || 'Product'} (decoupled, mmol·L⁻¹·d⁻¹)`;
        datasets.push({
            label: prodLabel,
            data: scanData.map(pt => ({ x: pt.x, y: pt.P_prod ?? 0 })),
            borderColor: 'rgba(111,66,193,0.85)', borderDash: _productFluxSource === 'manual' ? [3,3] : [],
            fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
            yAxisID: 'y2',
        });
        datasets.push({
            label: `Peak = ${(prodPeak.P_prod ?? 0).toFixed(2)} mmol·L⁻¹·d⁻¹ at X = ${prodPeak.x.toFixed(3)} g·L⁻¹`,
            data: [{ x: prodPeak.x, y: prodPeak.P_prod ?? 0 }],
            type: 'scatter', yAxisID: 'y2',
            borderColor: 'rgba(111,66,193,1)', backgroundColor: 'rgba(111,66,193,1)',
            pointRadius: 7, pointHoverRadius: 9, pointStyle: 'triangle',
        });
        scales.y2 = {
            min: 0, position: 'right', grid: { drawOnChartArea: false },
            title: { display: true, text: [`${p.productName || 'Product'} productivity`, '(mmol·L⁻¹·d⁻¹)'], font: { size: 11 }, color: 'rgba(111,66,193,0.9)' },
            ticks: { font: { size: 10 }, color: 'rgba(111,66,193,0.9)' },
        };
    }

    simTurbVolChart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 20 } },
                title: {
                    display: true,
                    text: [
                        `Turbidostat: Volumetric Productivity vs Biomass Concentration  (I₀ = ${curI0} µmol·m⁻²·s⁻¹)`,
                        `z = ${(z * 100).toFixed(0)} cm`,
                    ],
                    font: { size: 12 },
                },
            },
            scales,
        },
    });
}

/**
 * Turbidostat: P_V vs I₀ at fixed ρ_A (XA slider setpoint).
 * x = incident irradiance I₀ (µmol·m⁻²·s⁻¹), swept 0 → I0_MAX
 * y (left)  = P_V volumetric biomass productivity (g CDM·L⁻¹·d⁻¹)
 * y (right) = product productivity (mmol·L⁻¹·d⁻¹) if configured
 * Vertical dashed line marks the current I₀ slider value.
 * Culture density setpoint ρ_A comes from the XA (areal biomass) slider.
 */
function simRenderTurbI0Chart(p) {
    const ctx = document.getElementById('sim-turb-i0-chart')?.getContext('2d');
    if (!ctx) return;
    if (simTurbI0Chart) { simTurbI0Chart.destroy(); simTurbI0Chart = null; }

    const { alpha, KL, YBM, kd, ngam_photon, I0: curI0, XA: rho, Y_X } = p;
    const z    = Math.max(0.01, p.z_reactor || 0.10);
    const X    = rho / (z * 1000);   // g·m⁻² → g·L⁻¹

    const I0_STEPS = 300;
    const I0_MAX   = 2000;   // µmol·m⁻²·s⁻¹

    const scanData = [];
    for (let j = 0; j <= I0_STEPS; j++) {
        const I0_val = (j / I0_STEPS) * I0_MAX;
        const mu     = simHoperMu(I0_val, rho, alpha, KL, YBM, kd, ngam_photon, 0);
        const P_V    = Math.max(0, mu * X * 24);
        const vp     = turbProductFluxPerGDW(I0_val, rho, alpha, mu, Y_X);
        const P_prodV = vp !== null ? Math.max(0, vp * X * 24) : null;
        scanData.push({ x: I0_val, P_V, P_prod: P_prodV });
    }

    const curPt  = scanData.reduce((best, pt) => Math.abs(pt.x - curI0) < Math.abs(best.x - curI0) ? pt : best, scanData[0]);
    const peakPt = scanData.reduce((best, pt) => pt.P_V > best.P_V ? pt : best, scanData[0]);

    // Inline plugin: vertical dashed line at current I₀
    const curI0Line = {
        id: 'curI0line',
        afterDraw(chart) {
            const ds = chart.getDatasetMeta(0);
            if (!ds.data.length) return;
            let idx = 0, minD = Infinity;
            scanData.forEach((pt, i) => { const d = Math.abs(pt.x - curI0); if (d < minD) { minD = d; idx = i; } });
            const x = ds.data[idx]?.x;
            if (x == null) return;
            const { ctx: c, chartArea: { top, bottom } } = chart;
            c.save();
            c.setLineDash([4, 3]);
            c.strokeStyle = 'rgba(255,140,0,0.8)';
            c.lineWidth = 1.5;
            c.beginPath(); c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
            c.setLineDash([]);
            c.fillStyle = 'rgba(255,140,0,0.9)';
            c.font = '9px sans-serif';
            c.fillText(`I₀ = ${curI0}`, x + 3, top + 10);
            c.restore();
        },
    };

    const datasets = [
        {
            label: `P_V — Volumetric productivity (g CDM·L⁻¹·d⁻¹)  |  ρ_A = ${rho.toFixed(1)} g·m⁻², X = ${X.toFixed(3)} g·L⁻¹`,
            data: scanData.map(pt => ({ x: pt.x, y: pt.P_V })),
            borderColor: 'rgba(40,167,69,0.9)',
            backgroundColor: 'rgba(40,167,69,0.07)',
            fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
            yAxisID: 'y',
        },
        {
            label: `Peak P_V = ${peakPt.P_V.toFixed(3)} g·L⁻¹·d⁻¹ at I₀ = ${peakPt.x.toFixed(0)} µmol·m⁻²·s⁻¹`,
            data: [{ x: peakPt.x, y: peakPt.P_V }],
            type: 'scatter', yAxisID: 'y',
            borderColor: 'rgba(40,167,69,1)', backgroundColor: 'rgba(40,167,69,1)',
            pointRadius: 8, pointHoverRadius: 10, pointStyle: 'triangle',
        },
    ];

    const scales = {
        x: { type: 'linear', min: 0, max: I0_MAX,
             title: { display: true, text: 'I₀ — Incident irradiance (µmol·m⁻²·s⁻¹)', font: { size: 11 } },
             ticks: { font: { size: 10 } } },
        y: { min: 0, position: 'left',
             title: { display: true, text: ['P_V — Volumetric productivity', '(g CDM·L⁻¹·d⁻¹)'], font: { size: 11 } },
             ticks: { font: { size: 10 } } },
    };

    const hasProd = scanData[0]?.P_prod !== null;
    if (hasProd) {
        const prodPeak = scanData.reduce((best, pt) => (pt.P_prod ?? 0) > (best.P_prod ?? 0) ? pt : best, scanData[0]);
        datasets.push({
            label: _productFluxSource === 'manual'
                ? `${p.productName || 'Product'} (Y_X=${Y_X} mmol·gCDM⁻¹, growth-coupled)`
                : `${p.productName || 'Product'} (decoupled, mmol·L⁻¹·d⁻¹)`,
            data: scanData.map(pt => ({ x: pt.x, y: pt.P_prod ?? 0 })),
            borderColor: 'rgba(111,66,193,0.85)',
            borderDash: _productFluxSource === 'manual' ? [3,3] : [],
            fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
            yAxisID: 'y2',
        });
        datasets.push({
            label: `Peak = ${(prodPeak.P_prod ?? 0).toFixed(2)} mmol·L⁻¹·d⁻¹ at I₀ = ${prodPeak.x.toFixed(0)} µmol·m⁻²·s⁻¹`,
            data: [{ x: prodPeak.x, y: prodPeak.P_prod ?? 0 }],
            type: 'scatter', yAxisID: 'y2',
            borderColor: 'rgba(111,66,193,1)', backgroundColor: 'rgba(111,66,193,1)',
            pointRadius: 7, pointHoverRadius: 9, pointStyle: 'triangle',
        });
        scales.y2 = {
            min: 0, position: 'right', grid: { drawOnChartArea: false },
            title: { display: true, text: [`${p.productName || 'Product'} productivity`, '(mmol·L⁻¹·d⁻¹)'], font: { size: 11 }, color: 'rgba(111,66,193,0.9)' },
            ticks: { font: { size: 10 }, color: 'rgba(111,66,193,0.9)' },
        };
    }

    simTurbI0Chart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        plugins: [curI0Line],
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 20 } },
                title: {
                    display: true,
                    text: [
                        `Turbidostat: Volumetric Productivity vs Irradiance`,
                        `ρ_A = ${rho.toFixed(1)} g CDM·m⁻²  |  X = ${X.toFixed(3)} g CDM·L⁻¹  |  z = ${(z*100).toFixed(0)} cm`,
                    ],
                    font: { size: 12 },
                },
            },
            scales,
        },
    });
}

/**
 * Batch: P_A vs ρ_A — productivity trajectory through time.
 * x = areal biomass density (grows monotonically left→right),
 * y = instantaneous productivity P_inst = μ·ρ_A (dome shape).
 * Second axis: μ (h⁻¹) showing how growth rate declines as density builds.
 * Peak P_A marked with an orange triangle.
 */
function simRenderBatchRhoChart(d) {
    const ctx = document.getElementById('sim-batch-rho-chart')?.getContext('2d');
    if (!ctx || !d.points.length) return;
    if (simBatchRhoChart) { simBatchRhoChart.destroy(); simBatchRhoChart = null; }

    const pts   = d.points;
    // Find point of maximum P_inst for the marker
    const maxPt = pts.reduce((best, pt) => pt.P_inst > best.P_inst ? pt : best, pts[0]);

    simBatchRhoChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [
                {
                    label: 'P_A — Areal productivity (g CDM·m⁻²·h⁻¹)',
                    data: pts.map(pt => ({ x: pt.rho, y: pt.P_inst })),
                    borderColor: 'rgba(40,167,69,0.9)',
                    backgroundColor: 'rgba(40,167,69,0.08)',
                    fill: true, tension: 0.3, pointRadius: 0,
                    yAxisID: 'y',
                },
                {
                    label: 'μ — Specific growth rate (h⁻¹)',
                    data: pts.map(pt => ({ x: pt.rho, y: pt.mu })),
                    borderColor: 'rgba(0,123,255,0.8)',
                    fill: false, tension: 0.3, pointRadius: 0,
                    yAxisID: 'y2',
                },
                {
                    // Peak productivity marker
                    label: `Peak P_A = ${d.P_max.toFixed(3)} g·m⁻²·h⁻¹ at ρ_A = ${maxPt.rho.toFixed(1)} g·m⁻²`,
                    data: [{ x: maxPt.rho, y: maxPt.P_inst }],
                    type: 'scatter',
                    borderColor: 'rgba(255,140,0,1)',
                    backgroundColor: 'rgba(255,140,0,1)',
                    pointRadius: 8, pointHoverRadius: 10,
                    pointStyle: 'triangle',
                    yAxisID: 'y',
                },
            ],
        },
        options: {
            responsive: true,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 11 } } },
                title: { display: true, text: 'Batch: Productivity vs Culture Density', font: { size: 12 } },
            },
            scales: {
                x:  { type: 'linear', title: { display: true, text: 'ρ_A — Areal biomass density (g CDM·m⁻²)', font: { size: 11 } }, min: 0, ticks: { font: { size: 10 } } },
                y:  { title: { display: true, text: ['P_A — Areal productivity', '(g CDM·m⁻²·h⁻¹)'], font: { size: 11 } }, position: 'left',  min: 0, ticks: { font: { size: 10 } } },
                y2: { title: { display: true, text: 'μ — Specific growth rate (h⁻¹)', font: { size: 11 } }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
            },
        },
    });
}

/** Load Höper 2024 / iRH783 defaults into sim-* sliders */
function simLoadHoper() {
    const defaults = [
        ['sim-alpha',       'sim-alpha-val',       0.13],
        ['sim-KL',          'sim-KL-val',           119],
        ['sim-YBM',         'sim-YBM-val',          1.84],
        ['sim-kd',          'sim-kd-val',           0.07],
        ['sim-ngam-photon', 'sim-ngam-photon-val',  14.4],
        ['sim-I0',          'sim-I0-val',            660],
        ['sim-XA',          'sim-XA-val',             30],
        ['sim-rho0',        'sim-rho0-val',           1.0],
        ['sim-tend',        'sim-tend-val',           120],
    ];
    for (const [id, lblId, val] of defaults) {
        const el = document.getElementById(id);
        if (el) {
            el.value = Math.max(+(el.min || -Infinity), Math.min(+(el.max || Infinity), val));
            const lbl = document.getElementById(lblId);
            if (lbl) lbl.textContent = el.value;
        }
    }
    simRecompute();
}

/** Reset medium composition sliders to Höper 2024 / BG-11 photoautotrophic defaults */
function simLoadHoperMedium() {
    // FBA exchange bounds (mmol·gDW⁻¹·h⁻¹): unconstrained for all nutrients except
    // glucose and ammonium (0 = not supplied in standard BG-11 photoautotrophic conditions)
    const medDefaults = [
        ['med-co2',  'med-co2-val',  1000],   // CO₂ — unconstrained (Höper 2024 default)
        ['med-no3',  'med-no3-val',  1000],   // NO₃⁻ — BG-11 is nitrogen-replete
        ['med-nh4',  'med-nh4-val',     0],   // NH₄⁺ — not in standard BG-11
        ['med-glc',  'med-glc-val',     0],   // Glucose — photoautotrophic
        ['med-pi',   'med-pi-val',      1],   // Pi   — max slider; model needs ~0.11 at µ=0.155
        ['med-so4',  'med-so4-val',     1],   // SO₄  — max slider; model needs ~0.029
        ['med-fe2',  'med-fe2-val',   0.1],   // Fe   — max slider; model needs ~0.0012
        ['med-mn2',  'med-mn2-val',   0.1],   // Mn   — max slider; model needs ~0.0005
        ['med-zn2',  'med-zn2-val',   0.1],   // Zn   — max slider; model needs ~0.0005
        ['med-cu2',  'med-cu2-val',   0.1],   // Cu   — max slider; model needs ~0.0005
    ];
    for (const [id, lblId, val] of medDefaults) {
        const el = document.getElementById(id);
        if (el) {
            el.value = Math.max(+(el.min || 0), Math.min(+(el.max || 1000), val));
            const lbl = document.getElementById(lblId);
            if (lbl) lbl.textContent = el.value;
        }
    }
    // Also reset concentration panel BG-11 defaults and unit selectors
    const concDefaults = {
        'med-cc-co2': 5000,  'med-unit-co2': 'ppm_co2',   // 5000 ppm CO₂ (Höper 2024 / Zavřel 2019 sparging gas)
        'med-cc-no3': 17.6,  'med-unit-no3': 'mmol_L',    // BG-11: 1.5 g/L NaNO₃
        'med-cc-nh4': 0,     'med-unit-nh4': 'mmol_L',
        'med-cc-glc': 0,     'med-unit-glc': 'mmol_L',
        'med-cc-pi':  0.18,  'med-unit-pi':  'mmol_L',    // BG-11: 0.04 g/L K₂HPO₄
        'med-cc-so4': 0.30,  'med-unit-so4': 'mmol_L',    // BG-11: MgSO₄·7H₂O
        'med-cc-fe2': 0.020, 'med-unit-fe2': 'mmol_L',    // BG-11: ferric ammonium citrate
        'med-cc-mn2': 0.009, 'med-unit-mn2': 'mmol_L',
        'med-cc-zn2': 0.001, 'med-unit-zn2': 'mmol_L',
        'med-cc-cu2': 3e-4,  'med-unit-cu2': 'mmol_L',
    };
    for (const [id, val] of Object.entries(concDefaults)) {
        const el = document.getElementById(id);
        if (el) el.value = val;
    }
    medUpdateX();
    medSyncUnitButtons();
}


function simAutoLabel() {
    const genes = simKoGetGenes();
    if (!genes.length) return 'WT';
    return 'Δ' + genes.slice(0, 3).join(' Δ') + (genes.length > 3 ? '…' : '');
}

/** Return growth-curve points [{x:I, y:μ}] for current params */
function simGrowthCurvePoints(p) {
    const N = 200, Imax = Math.max(p.I0 * 2.2, 200);
    const pts = [];
    for (let i = 0; i <= N; i++) {
        const I = (i / N) * Imax;
        pts.push({ x: I, y: simHoperMu(I, p.XA, p.alpha, p.KL, p.YBM, p.kd, p.ngam_photon, 0) });
    }
    return pts;
}

function simSaveRef() {
    const p       = simGetParams();
    const prodData = simMode === 'chemo' ? simComputeChemostat(p) : simComputeBatch(p);
    const gcPts   = simGrowthCurvePoints(p);
    const label   = simAutoLabel();
    simRefData = { mode: simMode, gcPts, prodData, label };

    const lbl = document.getElementById('sim-ref-label');
    if (lbl) lbl.textContent = label;
    const badge = document.getElementById('sim-ref-badge');
    if (badge) badge.style.display = '';
    const clrBtn = document.getElementById('sim-clearref-btn');
    if (clrBtn) clrBtn.style.display = '';
    simRecompute();
}

function simClearRef() {
    simRefData = null;
    const badge = document.getElementById('sim-ref-badge');
    if (badge) badge.style.display = 'none';
    const clrBtn = document.getElementById('sim-clearref-btn');
    if (clrBtn) clrBtn.style.display = 'none';
    simRecompute();
}


// ── Scenario palette ─────────────────────────────────────────────────────────
const SCENARIO_STORAGE_KEY = 'metabolic_scenarios_v1';
const SCENARIO_MAX = 5;
const SCENARIO_COLORS = ['#1a64c8','#27ae60','#e74c3c','#9b59b6','#e67e22'];

function _scenarioLoad() {
    try { return JSON.parse(localStorage.getItem(SCENARIO_STORAGE_KEY) || '[]'); } catch { return []; }
}
function _scenarioSave(list) {
    localStorage.setItem(SCENARIO_STORAGE_KEY, JSON.stringify(list));
}

/** Capture all current simulation state into a scenario object. */
function scenarioCaptureState(name) {
    const p = simGetParams();
    const sliderIds = [
        'sim-I0','sim-XA','sim-alpha','sim-KL','sim-YBM','sim-kd','sim-ngam-photon',
        'sim-rho0','sim-tend','sim-yx',
        'med-co2','med-no3','med-nh4','med-glc','med-pi','med-so4','med-fe2','med-mn2','med-zn2','med-cu2',
    ];
    const sliders = {};
    sliderIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) sliders[id] = parseFloat(el.value);
    });
    return {
        name,
        timestamp: Date.now(),
        sliders,
        ko_genes:        simKoGetGenes(),
        custom_reactions: JSON.parse(JSON.stringify(customReactions)),
        fba_result:       Object.keys(lastFluxes).length > 0 ? { fluxes: lastFluxes } : null,
        mu_fba:           document.querySelector('#fba-result-box .alert-success strong')?.textContent?.match(/[\d.]+/)?.[0] || null,
    };
}

/** Restore a scenario's sliders + KO genes + custom reactions. */
function scenarioRestore(sc) {
    // Restore sliders
    Object.entries(sc.sliders || {}).forEach(([id, val]) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Restore KO genes
    simKoSetGenes(sc.ko_genes || []);
    // Restore custom reactions
    customReactions = JSON.parse(JSON.stringify(sc.custom_reactions || []));
    _crRefreshList();
    scenarioRenderList();
}

function scenarioSave() {
    const nameInput = document.getElementById('scenario-name-input');
    const name = (nameInput?.value || '').trim() || `Scenario ${new Date().toLocaleTimeString()}`;
    const list = _scenarioLoad();
    if (list.length >= SCENARIO_MAX) list.shift();   // drop oldest when full
    list.push(scenarioCaptureState(name));
    _scenarioSave(list);
    if (nameInput) nameInput.value = '';
    scenarioRenderList();
    updateLightSweepSummary();
}

function scenarioDelete(idx) {
    const list = _scenarioLoad();
    list.splice(idx, 1);
    _scenarioSave(list);
    scenarioRenderList();
    simRecompute();   // redraw growth curve without deleted scenario
    updateLightSweepSummary();
}

function scenarioClearAll() {
    _scenarioSave([]);
    scenarioRenderList();
    simRecompute();
    updateLightSweepSummary();
}

// ── Scenario comparison charts ────────────────────────────────────────────────
function renderScenarioCharts() {
    const scenarios = _scenarioLoad().filter(sc => sc.fba_result?.fluxes);
    const wrap = document.getElementById('scenario-charts-wrap');
    if (!wrap) return;

    if (scenarios.length < 2) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    // Populate reference selector
    const refSel = document.getElementById('scenario-ref-select');
    const prevRef = refSel.value;
    refSel.innerHTML = scenarios.map(sc => `<option value="${esc(sc.name)}">${esc(sc.name)}</option>`).join('');
    if (prevRef && scenarios.find(sc => sc.name === prevRef)) refSel.value = prevRef;

    const refName  = refSel.value;
    const refSc    = scenarios.find(sc => sc.name === refName) || scenarios[0];
    const others   = scenarios.filter(sc => sc.name !== refSc.name);
    const colors   = SCENARIO_COLORS;

    // ── Shared helper: Σ|flux| per KEGG pathway for a flux map ──────────────
    // Use model subsystems (non-overlapping) for flux accounting
    function scSubsystemTotals(sc) {
        const t = {};
        Object.entries(sc.fba_result.fluxes).forEach(([id, v]) => {
            if (Math.abs(v) < 1e-9) return;
            const subsys = subsystemLookup[id];
            if (!subsys) return;
            t[subsys] = (t[subsys] || 0) + Math.abs(v);
        });
        return t;
    }

    const subsystemLookup = {};
    allReactions.forEach(r => { subsystemLookup[r.id] = r.subsystem || ''; });

    const scTotals = scenarios.map(scSubsystemTotals);
    const refTotals = scSubsystemTotals(refSc);

    // All subsystems active in any scenario, sorted by max Σ|flux|
    const allPathwayNames = new Set(scTotals.flatMap(t => Object.keys(t)));
    const sortedPathways = [...allPathwayNames].sort((a, b) =>
        Math.max(...scTotals.map(t => t[b] || 0)) - Math.max(...scTotals.map(t => t[a] || 0))
    );

    // ── Grouped bar chart: absolute Σ|flux| per pathway per scenario ─────────
    const isLog = document.getElementById('scenario-pathway-log')?.checked;
    const pathwayDatasets = scenarios.map((sc, i) => ({
        label: sc.name,
        data:  sortedPathways.map(name => parseFloat((scTotals[i][name] || 0).toFixed(3))),
        backgroundColor: colors[i % colors.length] + 'cc',
        borderColor:     colors[i % colors.length],
        borderWidth: 1,
    }));

    const pathwayInner = document.getElementById('scenario-pathway-inner');
    pathwayInner.style.height = Math.max(300, sortedPathways.length * (scenarios.length * 14 + 6) + 60) + 'px';

    if (scenarioPathwayChart) scenarioPathwayChart.destroy();
    scenarioPathwayChart = new Chart(
        document.getElementById('scenario-pathway-chart').getContext('2d'), {
        type: 'bar',
        data: { labels: sortedPathways, datasets: pathwayDatasets },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', labels: { font: { size: 10 } } },
                tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.raw} mmol·gDW⁻¹·h⁻¹ (Σ|flux|)` } },
            },
            scales: {
                x: {
                    type: isLog ? 'logarithmic' : 'linear',
                    title: { display: true, text: 'Σ|flux| (mmol·gDW⁻¹·h⁻¹)' + (isLog ? ' — log scale' : '') },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                },
                y: { ticks: { font: { size: 10 } } },
            },
        },
    });

    // ── Differential chart: Δ Σ|flux| per KEGG pathway vs. reference ─────────
    const diffPathways = sortedPathways.filter(name => {
        const maxDelta = Math.max(...others.map(sc => {
            const t = scTotals[scenarios.indexOf(sc)];
            return Math.abs((t[name] || 0) - (refTotals[name] || 0));
        }));
        return maxDelta > 1e-9;
    });

    const diffDatasets = others.map((sc, i) => {
        const t = scTotals[scenarios.indexOf(sc)];
        return {
            label: `Δ(${sc.name} − ${refSc.name})`,
            data:  diffPathways.map(name => parseFloat(((t[name] || 0) - (refTotals[name] || 0)).toFixed(3))),
            backgroundColor: colors[(i + 1) % colors.length] + 'cc',
            borderColor:     colors[(i + 1) % colors.length],
            borderWidth: 1,
        };
    });

    const diffInner = document.getElementById('scenario-diff-inner');
    diffInner.style.height = Math.max(200, diffPathways.length * (others.length * 14 + 6) + 60) + 'px';

    if (scenarioDiffChart) scenarioDiffChart.destroy();
    scenarioDiffChart = new Chart(
        document.getElementById('scenario-diff-chart').getContext('2d'), {
        type: 'bar',
        data: { labels: diffPathways, datasets: diffDatasets },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'top', labels: { font: { size: 10 } } },
                tooltip: { callbacks: { label: c => ` ${c.dataset.label}: Δ${c.raw} mmol·gDW⁻¹·h⁻¹` } },
            },
            scales: {
                x: {
                    title: { display: true, text: 'Δ Σ|flux| vs. reference (mmol·gDW⁻¹·h⁻¹)' },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                },
                y: { ticks: { font: { size: 10 } } },
            },
        },
    });
}

function scenarioRenderList() {
    const list = _scenarioLoad();
    const container = document.getElementById('scenario-list');
    if (!container) return;

    const hint = document.getElementById('scenario-hint');
    if (hint) hint.style.display = list.length ? 'none' : '';

    if (list.length === 0) { container.innerHTML = ''; return; }

    container.innerHTML = list.map((sc, i) => {
        const color = SCENARIO_COLORS[i % SCENARIO_COLORS.length];
        const muStr = sc.mu_fba ? ` — μ = ${sc.mu_fba} h⁻¹` : '';
        const koStr = sc.ko_genes?.length ? ` · KO: ${sc.ko_genes.slice(0,3).join(', ')}${sc.ko_genes.length > 3 ? ' …' : ''}` : '';
        const crStr = sc.custom_reactions?.length ? ` · +${sc.custom_reactions.length} rxn(s)` : '';
        return `<div class="d-flex align-items-center mb-1 py-1 px-2 border rounded" style="background:#fafafa;">
            <span class="mr-2" style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${color};flex-shrink:0;"></span>
            <span class="flex-fill text-truncate" title="${esc(sc.name)}${muStr}${koStr}${crStr}">
                <strong>${esc(sc.name)}</strong>
                <span class="text-muted" style="font-size:0.78em;">${muStr}${koStr}${crStr}</span>
            </span>
            <button class="btn btn-xs btn-outline-secondary py-0 px-1 ml-1" style="font-size:0.72em;" onclick="scenarioRestore((_scenarioLoad())[${i}])" title="Restore parameters">
                <i class="fa fa-undo"></i>
            </button>
            <button class="btn btn-xs btn-link text-danger py-0 px-1 ml-1" style="font-size:0.8em;" onclick="scenarioDelete(${i})" title="Delete">
                <i class="fa fa-times"></i>
            </button>
        </div>`;
    }).join('');

    renderScenarioCharts();
}

/** Return saved scenario curves for overlay on the growth chart.
 *  Each element: { label, color, pts: [{x, y}] } using current biophysical params. */
function scenarioGetOverlayCurves() {
    const list = _scenarioLoad();
    if (list.length === 0) return [];
    return list.map((sc, i) => {
        const p = sc.sliders || {};
        const alpha       = p['sim-alpha']       || 0.13;
        const KL          = p['sim-KL']          || 119;
        const YBM         = p['sim-YBM']         || 1.84;
        const kd          = p['sim-kd']          || 0.07;
        const ngam_photon = p['sim-ngam-photon'] || 14.4;
        const XA          = p['sim-XA']          || 30;
        const Imax        = Math.max((p['sim-I0'] || 660) * 2.2, 600);
        const N = 200;
        const pts = [];
        for (let j = 0; j <= N; j++) {
            const I = (j / N) * Imax;
            pts.push({ x: I, y: Math.max(0, simHoperMu(I, XA, alpha, KL, YBM, kd, ngam_photon, 0)) });
        }
        return { label: sc.name, color: SCENARIO_COLORS[i % SCENARIO_COLORS.length], pts };
    });
}

// Wire chevron toggle + URL state restore
document.addEventListener('DOMContentLoaded', () => {
    scenarioRenderList();
    urlStateInit();   // restore from #state= fragment if present
    document.getElementById('scenario-body')?.addEventListener('show.bs.collapse', () => {
        const ch = document.getElementById('scenario-chevron');
        if (ch) ch.className = 'fa fa-chevron-up ml-auto';
    });
    document.getElementById('scenario-body')?.addEventListener('hide.bs.collapse', () => {
        const ch = document.getElementById('scenario-chevron');
        if (ch) ch.className = 'fa fa-chevron-down ml-auto';
    });
});

// ── URL state sharing ─────────────────────────────────────────────────────────
/** Collect current simulator state into a plain object for serialisation. */
function urlStateCaptureState() {
    const sliders = {};
    document.querySelectorAll('input[type=range][id^="sim-"]').forEach(el => {
        sliders[el.id] = parseFloat(el.value);
    });
    // Medium slider values
    document.querySelectorAll('.med-slider').forEach(el => {
        sliders[el.id] = parseFloat(el.value);
    });
    const koGenes   = simKoGetGenes();
    const simModeEl = document.querySelector('input[name="sim-mode"]:checked');
    return {
        sliders,
        ko_genes:   koGenes,
        sim_mode:   simModeEl ? simModeEl.value : null,
    };
}

/** Encode state → base64url, write to location.hash, copy URL to clipboard. */
function urlStateCopy() {
    try {
        const state   = urlStateCaptureState();
        const json    = JSON.stringify(state);
        const b64     = btoa(unescape(encodeURIComponent(json)));
        const url     = location.origin + location.pathname + '#state=' + b64;
        navigator.clipboard.writeText(url).then(() => {
            const toast = document.getElementById('url-copy-toast');
            if (toast) {
                toast.style.display = '';
                setTimeout(() => { toast.style.display = 'none'; }, 2500);
            }
        }).catch(() => {
            // Fallback: prompt
            prompt('Copy this URL:', url);
        });
    } catch (e) {
        console.warn('urlStateCopy error', e);
    }
}

/** Restore simulator state from a plain object (produced by urlStateCaptureState). */
function urlStateRestore(state) {
    if (!state) return;
    // Sliders
    if (state.sliders) {
        for (const [id, val] of Object.entries(state.sliders)) {
            const el = document.getElementById(id);
            if (el && el.type === 'range') {
                el.value = val;
                el.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }
    }
    // KO genes — wait until gene list is loaded
    if (state.ko_genes?.length) {
        const trySet = (attempts) => {
            const sel = document.getElementById('sim-ko-select');
            if (sel && sel.options.length > 0) {
                simKoSetGenes(state.ko_genes);
            } else if (attempts > 0) {
                setTimeout(() => trySet(attempts - 1), 300);
            }
        };
        trySet(20);
    }
    // Sim mode
    if (state.sim_mode) {
        const radio = document.querySelector(`input[name="sim-mode"][value="${CSS.escape(state.sim_mode)}"]`);
        if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change', { bubbles: true })); }
    }
}

/** On page load: check #state= fragment and restore. */
function urlStateInit() {
    const hash = location.hash;
    const m    = hash.match(/[#&]state=([A-Za-z0-9+/=_-]+)/);
    if (!m) return;
    try {
        const json  = decodeURIComponent(escape(atob(m[1])));
        const state = JSON.parse(json);
        urlStateRestore(state);
        // Replace hash so refreshing doesn't re-apply
        history.replaceState(null, '', location.pathname + location.search);
    } catch (e) {
        console.warn('urlStateInit: could not parse state fragment', e);
    }
}

// ── 1-D Parameter Sensitivity Sweep ──────────────────────────────────────────

// Metadata for each sweepable parameter: [min, max, unit, description]
const SENS_PARAM_META = {
    'sim-I0':          [50,    1200,  'µmol·m⁻²·s⁻¹', 'Incident photon flux density at the culture surface. Sweep this to see how growth responds to light availability — the primary driver in photoautotrophic cultures.'],
    'sim-XA':          [0,     120,   'g·m⁻²',         'Areal biomass density (dry weight per illuminated area). Higher X_A increases self-shading, reducing the average light dose per cell.'],
    'sim-D':           [0.001, 0.15,  'h⁻¹',           'Chemostat dilution rate. At steady state D = µ; exceeding µ_max causes washout. Sweep to find the optimal operating point.'],
    'sim-YBM':         [0.5,   4.0,   'g·mol⁻¹ photon','Biomass yield per absorbed photon — the key link between FBA stoichiometry and the growth curve. Run FBA first; this value is set by the FBA result. Sweep to assess how sensitive growth is to stoichiometric efficiency.'],
    'sim-alpha':       [0.01,  0.40,  'm²·gDW⁻¹',      'Specific photon absorption coefficient of the biomass. Determines how efficiently the culture captures light. Typically fitted from experimental attenuation data.'],
    'sim-KL':          [20,    400,   'µmol·m⁻²·s⁻¹',  'Half-saturation irradiance: the light level at which the absorbed photon rate is half its maximum. Low K_L = highly light-efficient cells (e.g. shade-adapted); high K_L = light-saturation only at high intensities.'],
    'sim-kd':          [0.001, 0.25,  'h⁻¹',           'Specific decay/maintenance rate — the minimum growth rate needed to offset biomass losses. Includes endogenous respiration, photooxidative damage, and cell death.'],
    'sim-ngam-photon': [1,     40,    'µmol·gDW⁻¹·h⁻¹','Non-growth-associated photon maintenance demand: photons consumed for processes unrelated to biomass synthesis (e.g. cyclic electron flow, thermal dissipation). Higher NGAM reduces effective growth yield.'],
};

let sensChart = null;

function sensParamChanged() {
    const pid  = document.getElementById('sens-param')?.value;
    const meta = SENS_PARAM_META[pid];
    const range = meta ? [meta[0], meta[1]] : [0, 1];
    const unit  = meta ? meta[2] : '';
    const desc  = meta ? meta[3] : '';

    const fromEl = document.getElementById('sens-from');
    const toEl   = document.getElementById('sens-to');
    if (fromEl) fromEl.value = range[0];
    if (toEl)   toEl.value   = range[1];

    // Update unit labels next to From / To
    ['sens-unit-label', 'sens-unit-label-to'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = unit ? `(${unit})` : '';
    });

    // Update description line
    const descEl = document.getElementById('sens-param-desc');
    if (descEl) descEl.textContent = desc;
}

function runSensitivitySweep() {
    const pid    = document.getElementById('sens-param')?.value;
    const from   = parseFloat(document.getElementById('sens-from')?.value);
    const to     = parseFloat(document.getElementById('sens-to')?.value);
    const nPts   = Math.max(5, Math.min(200, parseInt(document.getElementById('sens-n')?.value) || 60));
    if (!pid || isNaN(from) || isNaN(to) || from >= to) return;

    // Collect current params (to keep all other params at their current slider values)
    const p = simGetParams();

    const xs = [];
    const ys = [];

    for (let i = 0; i < nPts; i++) {
        const val = from + (i / (nPts - 1)) * (to - from);
        xs.push(val);

        const pp = Object.assign({}, p);
        switch (pid) {
            case 'sim-alpha':       pp.alpha       = val; break;
            case 'sim-KL':         pp.KL          = val; break;
            case 'sim-YBM':        pp.YBM         = val; break;
            case 'sim-kd':         pp.kd          = val; break;
            case 'sim-ngam-photon':pp.ngam_photon = val; break;
            case 'sim-I0':         pp.I0          = val; break;
            case 'sim-XA':         pp.XA          = val; break;
            case 'sim-D':          pp.D           = val; break;
        }

        const { alpha, KL, YBM, kd, ngam_photon, I0, XA } = pp;
        const y = simHoperMu(I0, XA, alpha, KL, YBM, kd, ngam_photon, 0);
        ys.push(isFinite(y) ? y : NaN);
    }

    const yLabel = 'µ (h⁻¹)';
    const meta       = SENS_PARAM_META[pid];
    const paramUnit  = meta ? meta[2] : '';
    const paramLabel = (document.getElementById('sens-param')?.selectedOptions[0]?.text || pid)
                       + (paramUnit ? `  (${paramUnit})` : '');

    // Find optimum
    let maxY = -Infinity, maxX = NaN;
    ys.forEach((y, i) => { if (isFinite(y) && y > maxY) { maxY = y; maxX = xs[i]; } });

    // Render
    document.getElementById('sens-result').style.display = '';
    if (sensChart) { sensChart.destroy(); sensChart = null; }
    sensChart = new Chart(document.getElementById('sens-chart').getContext('2d'), {
        type: 'line',
        data: {
            datasets: [{
                label: yLabel,
                data: xs.map((x, i) => ({ x, y: ys[i] })),
                borderColor: '#1a6abf', backgroundColor: 'rgba(26,106,191,0.08)',
                fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
            }]
        },
        options: {
            animation: false,
            parsing: false,
            scales: {
                x: { type: 'linear', title: { display: true, text: paramLabel } },
                y: { title: { display: true, text: yLabel }, beginAtZero: false }
            },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => `${yLabel}: ${ctx.parsed.y?.toFixed(5)}` } }
            }
        }
    });

    const summaryEl = document.getElementById('sens-summary');
    if (summaryEl && isFinite(maxY)) {
        summaryEl.textContent = `Optimum: ${yLabel} = ${maxY.toFixed(5)} at ${paramLabel.split('—')[0].trim()} = ${maxX.toFixed(4)}`;
    }
}

// ── Bottom-card visibility & FBA summary on sub-tab switch ───────────────────

let _lastFbaResultForSummary = null;   // stored when Static FBA completes
let _staticFbaHasRun    = false;
let _lightSweepHasRun   = false;
let _growthCurveFitted  = false;

function _setGate(id, visible) {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
}

function updateTabGates() {
    // ① Static FBA → unlocks Sweep tab content
    _setGate('sweep-prereq-gate',   !_staticFbaHasRun);
    _setGate('sweep-gated-content',  _staticFbaHasRun);

    // ② Light Sweep → unlocks Growth Curve right column
    _setGate('growth-curve-prereq-gate',   !_lightSweepHasRun);
    _setGate('growth-curve-gated-content',  _lightSweepHasRun);
    _setGate('sim-card',                    _lightSweepHasRun);

    // ③ Growth curve fitted → unlocks Culture Productivity
    _setGate('productivity-prereq-gate',   !_growthCurveFitted);
    _setGate('productivity-gated-content',  _growthCurveFitted);

}

function setFbaYieldXMode(mode)   { _fbaYieldXMode   = mode; _buildFbaYieldCharts(); }
function setHoperYieldXMode(mode) { _hoperYieldXMode = mode; _buildHoperYieldCharts(); }

function setChartZoomMode(chart, mode) {
    if (!chart) return;
    chart.options.plugins.zoom.zoom.mode = mode;
    chart.update('none');
}

function updateLightSweepSummary() {
    const card    = document.getElementById('fba-sweep-summary-card');
    const content = document.getElementById('fba-sweep-summary-content');
    if (!card || !content) return;

    const d = _lastFbaResultForSummary;
    if (!d) { card.style.display = 'none'; return; }

    const s   = d.sliders || {};
    const fmt = (id, digits) => {
        const v = s[id];
        return (v == null) ? '<span class="text-muted">—</span>' : Number(v).toFixed(digits ?? 2);
    };
    const fmtMed = (id, maxUnconstrained, digits) => {
        const v = s[id];
        if (v == null) return '<span class="text-muted">—</span>';
        return (v >= maxUnconstrained) ? '∞' : Number(v).toFixed(digits ?? 2);
    };

    const mu  = Number(d.growth_rate).toFixed(5);
    const kos = d.ko_genes?.length ? d.ko_genes.map(esc).join(', ') : '<span class="text-muted">none</span>';
    const crs = d.custom_reactions?.length
        ? d.custom_reactions.map(r => esc(r.id)).join(', ')
        : '<span class="text-muted">none</span>';

    const row = (label, val) =>
        `<tr><td class="py-0 pr-3 text-muted" style="white-space:nowrap;">${label}</td><td class="py-0">${val}</td></tr>`;

    content.innerHTML = `
        <div style="overflow-x:auto;">
        <table class="table table-sm table-borderless mb-0" style="font-size:0.82em;">
        <tbody>
            <tr><td colspan="2" class="py-0 pb-1"><span class="text-uppercase text-muted" style="font-size:0.78em;letter-spacing:.05em;">Result</span></td></tr>
            ${row('μ (h⁻¹)', `<strong>${mu}</strong>`)}
            <tr><td colspan="2" class="py-0 pt-2 pb-1"><span class="text-uppercase text-muted" style="font-size:0.78em;letter-spacing:.05em;">Culture conditions</span></td></tr>
            ${row('I₀ (µmol·m⁻²·s⁻¹)', fmt('sim-I0', 0))}
            ${row('X<sub>A</sub> (g·m⁻²)', fmt('sim-XA', 0))}
            <tr><td colspan="2" class="py-0 pt-2 pb-1"><span class="text-uppercase text-muted" style="font-size:0.78em;letter-spacing:.05em;">Biophysical parameters</span></td></tr>
            ${row('α — photon absorption', fmt('sim-alpha', 2))}
            ${row('K<sub>L</sub> (µmol·m⁻²·s⁻¹)', fmt('sim-KL', 0))}
            ${row('Y<sub>BM</sub> (g·mol⁻¹)', fmt('sim-YBM', 2))}
            ${row('k<sub>d</sub>', fmt('sim-kd', 3))}
            ${row('NGAM<sub>photon</sub> (µmol·gDW⁻¹·h⁻¹)', fmt('sim-ngam-photon', 1))}
            <tr><td colspan="2" class="py-0 pt-2 pb-1"><span class="text-uppercase text-muted" style="font-size:0.78em;letter-spacing:.05em;">Medium (mmol·gDW⁻¹·h⁻¹)</span></td></tr>
            ${row('CO₂', fmtMed('med-co2', 1000, 1))}
            ${row('NO₃⁻', fmtMed('med-no3', 1000, 1))}
            ${row('NH₄⁺', fmtMed('med-nh4', 50, 1))}
            ${row('Glucose', fmtMed('med-glc', 20, 1))}
            ${row('Pi', fmtMed('med-pi', 1, 3))}
            ${row('SO₄²⁻', fmtMed('med-so4', 1, 3))}
            ${row('Fe²⁺', fmtMed('med-fe2', 0.1, 4))}
            ${row('Mn²⁺', fmtMed('med-mn2', 0.1, 4))}
            ${row('Zn²⁺', fmtMed('med-zn2', 0.1, 4))}
            ${row('Cu²⁺', fmtMed('med-cu2', 0.1, 4))}
            <tr><td colspan="2" class="py-0 pt-2 pb-1"><span class="text-uppercase text-muted" style="font-size:0.78em;letter-spacing:.05em;">Genetic modifications</span></td></tr>
            ${row('Knockouts', kos)}
            ${row('Custom reactions', crs)}
        </tbody>
        </table>
        </div>`;
    card.style.display = '';
}

function simSubTabChanged(href) {
    const isStatic = (href === '#sim-sub-static');
    // scenario-card is still full-width below tabs; show only on Static FBA
    ['scenario-card'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isStatic ? '' : 'none';
    });
    // Sensitivity Analysis shown on all other tabs
    const sensCard = document.getElementById('sensitivity-card');
    if (sensCard) sensCard.style.display = isStatic ? 'none' : '';

    // Update Light Sweep FBA summary when switching to that tab
    if (href === '#sim-sub-sweep') updateLightSweepSummary();
}

/** Re-render both turbidostat charts from current params.
 *  Called on tab switch, or when I₀ / z sliders change.
 *  Guards against running before the kinetic model has been fitted (gated content hidden). */
function simRenderTurbCharts() {
    const gate = document.getElementById('productivity-gated-content');
    if (!gate || gate.style.display === 'none') return;
    const p = simGetParams();
    simRenderTurbRhoChart(p);
    simRenderTurbVolChart(p);
    simRenderTurbI0Chart(p);
}

document.addEventListener('DOMContentLoaded', () => {
    sensParamChanged();

    // Initialise card visibility (Static FBA is active by default)
    simSubTabChanged('#sim-sub-static');
    updateTabGates();

    // Auto-refresh turbidostat charts when any biophysical or culture parameter changes
    ['sim-I0','sim-XA','sim-reactor-depth','sim-alpha','sim-KL','sim-YBM','sim-kd','sim-ngam-photon','sim-yx']
        .forEach(id => document.getElementById(id)?.addEventListener('input', simRenderTurbCharts));

    // Listen to sub-tab switches (use jQuery — Bootstrap 4 fires shown.bs.tab via jQuery)
    $('#sim-sub-tabs a[data-toggle="tab"]').on('shown.bs.tab', function(e) {
        simSubTabChanged($(e.target).attr('href'));
    });

    // Experimental data card
    document.getElementById('exp-data-load-btn')?.addEventListener('click', expDataLoad);
    document.getElementById('exp-data-clear-btn')?.addEventListener('click', expDataClear);
    const expPaste = document.getElementById('exp-data-paste');
    if (expPaste) {
        expPaste.value = 'I0\tmu\tmu_err\tX_A\trho\tV\tA\n';
        expPaste.focus();
        expPaste.setSelectionRange(expPaste.value.length, expPaste.value.length);
        expPaste.blur();
    }
});

// ── Searchable reaction dropdown ──────────────────────────────────────────────
/** Searchable combobox: wrapperId is the .rxn-sel div containing all sub-elements. */
function initRxnSelect(wrapperId) {
    const wrap   = document.getElementById(wrapperId);
    if (!wrap) return;
    const btn    = wrap.querySelector('.rxn-sel-btn');
    const panel  = wrap.querySelector('.rxn-sel-panel');
    const search = wrap.querySelector('.rxn-sel-search');
    const list   = wrap.querySelector('.rxn-sel-list');
    const hidden = wrap.querySelector('input[type="hidden"]');
    const label  = wrap.querySelector('.rxn-sel-label');
    if (!btn || !panel || !search || !list || !hidden || !label) return;

    let kbIdx = -1;   // keyboard-navigation index

    function renderList(q) {
        const query   = (q || '').trim().toLowerCase();
        const matches = query
            ? allReactions.filter(r =>
                r.id.toLowerCase().includes(query) ||
                (r.name      || '').toLowerCase().includes(query) ||
                (r.subsystem || '').toLowerCase().includes(query) ||
                (r.equation  || '').toLowerCase().includes(query)
              ).slice(0, 120)
            : allReactions.slice(0, 120);
        kbIdx = -1;
        if (!matches.length) {
            list.innerHTML = '<div class="p-2 text-muted small">No matches</div>';
            return;
        }
        list.innerHTML = matches.map(r => {
            const sub = r.subsystem
                ? `<span class="badge badge-light border ml-1" style="font-size:0.72em;font-weight:500;">${esc(r.subsystem)}</span>`
                : '';
            const eq = r.equation
                ? `<div class="text-muted" style="font-size:0.78em;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.equation)}</div>`
                : '';
            return `<div class="rxn-sel-item" data-id="${esc(r.id)}" style="padding:5px 8px;">` +
                `<div style="display:flex;align-items:baseline;gap:4px;">` +
                `<code style="font-size:0.85em;flex-shrink:0;">${esc(r.id)}</code>` +
                `<span style="font-size:0.84em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.name || '')}</span>` +
                sub +
                `</div>` +
                eq +
                `</div>`;
        }).join('');
        list.querySelectorAll('.rxn-sel-item').forEach(item => {
            item.addEventListener('mousedown', e => { e.preventDefault(); pick(item.dataset.id); });
        });
    }

    function pick(id) {
        hidden.value = id;
        const rxn = allReactions.find(r => r.id === id);
        label.textContent = rxn && rxn.name ? `${id} — ${rxn.name}` : id;
        label.classList.remove('text-muted', 'font-italic');
        close();
    }

    function open() {
        renderList('');
        search.value = '';
        panel.style.display = '';
        btn.classList.add('active');
        // scroll current selection into view
        if (hidden.value) {
            setTimeout(() => {
                const cur = list.querySelector(`[data-id="${CSS.escape(hidden.value)}"]`);
                if (cur) { cur.classList.add('kb-active'); cur.scrollIntoView({ block: 'nearest' }); }
            }, 0);
        }
        search.focus();
    }

    function close() {
        panel.style.display = 'none';
        btn.classList.remove('active');
        kbIdx = -1;
    }

    btn.addEventListener('click', () => panel.style.display === 'none' ? open() : close());

    search.addEventListener('input', () => renderList(search.value));

    search.addEventListener('keydown', e => {
        const items = [...list.querySelectorAll('.rxn-sel-item')];
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            kbIdx = Math.min(kbIdx + 1, items.length - 1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            kbIdx = Math.max(kbIdx - 1, 0);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (kbIdx >= 0 && items[kbIdx]) pick(items[kbIdx].dataset.id);
            else if (items.length === 1) pick(items[0].dataset.id);
            return;
        } else if (e.key === 'Escape') {
            close(); btn.focus(); return;
        } else { return; }
        items.forEach((it, i) => it.classList.toggle('kb-active', i === kbIdx));
        items[kbIdx]?.scrollIntoView({ block: 'nearest' });
    });

    // Close on outside click
    document.addEventListener('mousedown', e => { if (!wrap.contains(e.target)) close(); });
}

function initAllRxnDropdowns() {
    initRxnSelect('en-rxn-wrap');
}

// ── Utility ───────────────────────────────────────────────────────────────────
function esc(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Slider value labels — click to edit inline ────────────────────────────────
// Finds every span whose id ends in '-val' and has a corresponding range input
// (id = spanId without '-val'), then makes it click-to-edit.
function initSliderValueLabels() {
    document.querySelectorAll('span[id$="-val"]').forEach(span => {
        const sliderId = span.id.slice(0, -4);   // strip '-val'
        const slider   = document.getElementById(sliderId);
        if (!slider || slider.type !== 'range') return;

        span.classList.add('slider-val-lbl');
        span.title = 'Click to enter exact value';

        span.addEventListener('click', () => {
            // Don't open if already in edit mode
            if (span.querySelector('.slider-val-input')) return;

            const currentVal = parseFloat(slider.value);
            const input = document.createElement('input');
            input.type  = 'number';
            input.className = 'slider-val-input';
            input.value = currentVal;
            input.min   = slider.min;
            input.max   = slider.max;
            input.step  = slider.step;

            span.textContent = '';
            span.appendChild(input);
            input.focus();
            input.select();

            function commit() {
                let v = parseFloat(input.value);
                if (isNaN(v)) v = currentVal;
                v = Math.max(parseFloat(slider.min), Math.min(parseFloat(slider.max), v));
                slider.value = v;
                // Trigger the appropriate slider update function
                slider.dispatchEvent(new Event('input', { bubbles: true }));
                // Restore label (the oninput handler will set the text)
                // But if the oninput doesn't update this span, set it now as fallback
                if (!span.textContent || span.querySelector('.slider-val-input')) {
                    span.textContent = v;
                }
            }

            input.addEventListener('keydown', e => {
                if (e.key === 'Enter')  { commit(); e.preventDefault(); }
                if (e.key === 'Escape') { span.textContent = slider.value; }
            });
            input.addEventListener('blur', commit);
        });
    });
}

// ── Chart PNG export ──────────────────────────────────────────────────────────
function exportChart(canvasId, filename) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = (filename || canvasId) + '.png';
    a.click();
}
