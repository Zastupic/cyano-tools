'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let allReactions   = [];
let allMetabolites = [];
let allGenes       = [];
let lastFluxes     = {};      // rxnId → flux value from most recent FBA
let rxnNameMap     = {};      // rxnId → display name
let cy             = null;    // Cytoscape instance
let subsystemChart = null;    // Chart.js instance

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
    const genes    = simKoGetGenes();
    const list     = document.getElementById('sim-ko-selected-list');
    const noneMsg  = document.getElementById('sim-ko-none-msg');
    if (list) {
        list.textContent = genes.join(', ');
        list.style.display = genes.length ? '' : 'none';
    }
    if (noneMsg) noneMsg.style.display = genes.length ? 'none' : '';
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
    if (!A || !V || !rho || A <= 0) {
        if (res) res.textContent = 'Enter A, V and ρ';
        return;
    }
    const XA = (rho * V) / A;
    // Set both the main XA slider and the conversion panel input
    const slider = document.getElementById('sim-XA');
    const sliderVal = document.getElementById('sim-XA-val');
    if (slider) { slider.value = Math.min(XA, parseFloat(slider.max || 200)).toFixed(1); }
    if (sliderVal) sliderVal.textContent = XA.toFixed(1);
    const xaConvInput = document.getElementById('med-conv-xa');
    if (xaConvInput) xaConvInput.value = XA.toFixed(1);
    medUpdateX();   // refresh X [g/L] display
    if (res) res.textContent = `= ${XA.toFixed(1)} gCDM·m⁻²`;
}

/** Re-compute and display X whenever XA or d changes. */
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

function medSlider(input, valId) {
    document.getElementById(valId).textContent = input.value;
}

function medNudge(id, valId, dir) {
    const el = document.getElementById(id);
    if (!el) return;
    const step = parseFloat(el.step) || 1;
    el.value = Math.max(parseFloat(el.min), Math.min(parseFloat(el.max), parseFloat(el.value) + dir * step));
    document.getElementById(valId).textContent = el.value;
}

// ── Compartment colours ───────────────────────────────────────────────────────
const COMP_COLORS = {
    c:  '#5cb85c',   // cytosol — green
    e:  '#e67e22',   // extracellular — orange
    p:  '#9b59b6',   // periplasm — purple
    cx: '#e74c3c',   // carboxysome — red
    cm: '#3498db',   // cytoplasmic membrane — blue
    um: '#1abc9c',   // thylakoid membrane — teal
};

// ── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // All calls fire in parallel; backend lock ensures the SBML is only parsed once
    loadStats();
    loadReactions();
    loadMetabolites();
    loadGenes();
    loadKeggPathways();

    // Buttons
    document.getElementById('load-network-btn').addEventListener('click', loadNetwork);
    document.getElementById('fit-network-btn').addEventListener('click', () => cy && cy.fit());
    document.getElementById('apply-flux-btn').addEventListener('click', () => applyFluxOverlay(lastFluxes));
    document.getElementById('reset-flux-btn').addEventListener('click', resetFluxOverlay);
    document.getElementById('run-fba-btn').addEventListener('click', runFBAwithPFBA);
    document.getElementById('export-fba-btn').addEventListener('click', exportFBA);
    document.getElementById('view-network-btn').addEventListener('click', () => {
        document.querySelector('[href="#tab-network"]').click();
        if (cy) applyFluxOverlay(lastFluxes);
    });
    document.getElementById('open-kegg-btn').addEventListener('click', openKegg);
    document.getElementById('ipath3-btn').addEventListener('click', loadIpath3);

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
        document.getElementById('n-comp').textContent = d.compartments.join(', ');

        const sel = document.getElementById('subsystem-select');
        d.subsystems.forEach(s => {
            const o = document.createElement('option');
            o.value = o.textContent = s;
            sel.appendChild(o);
        });
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
function loadReactions() {
    fetch('/api/metabolic/reactions')
        .then(r => r.json())
        .then(data => {
            allReactions = data;
            data.forEach(r => { rxnNameMap[r.id] = r.name || r.id; });
            initAllRxnDropdowns();

            const tbody = document.querySelector('#rxn-table tbody');
            tbody.innerHTML = data.map(r => `<tr>
                <td><code>${esc(r.id)}</code></td>
                <td>${esc(r.name || '—')}</td>
                <td style="font-size:0.78em;">${esc(r.equation)}</td>
                <td>${esc(r.subsystem || '—')}</td>
                <td style="font-size:0.78em;">${esc(r.genes.join(', ') || '—')}</td>
            </tr>`).join('');

            document.getElementById('rxn-count-label').textContent = `${data.length} reactions`;
        });
}

// ── Metabolites table ─────────────────────────────────────────────────────────
function loadMetabolites() {
    fetch('/api/metabolic/metabolites')
        .then(r => r.json())
        .then(data => {
            allMetabolites = data;
            const tbody = document.querySelector('#met-table tbody');
            tbody.innerHTML = data.map(m => `<tr>
                <td><code>${esc(m.id)}</code></td>
                <td>${esc(m.name || '—')}</td>
                <td><code>${esc(m.formula || '—')}</code></td>
                <td>${esc(m.compartment)}</td>
                <td>${m.charge != null ? m.charge : '—'}</td>
            </tr>`).join('');

            document.getElementById('met-count-label').textContent = `${data.length} metabolites`;
        });
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
            span.textContent = `${pct.toFixed(1)}% WT`;
        } else {
            span.className = 'ko-result ml-1 small text-danger font-weight-bold';
            span.textContent = '0% WT';
        }
        btn.disabled = false;
        btn.textContent = 'Test KO';
    })
    .catch(() => { btn.disabled = false; btn.textContent = 'Test KO'; });
}

// ── Network (Cytoscape.js) ────────────────────────────────────────────────────
function loadNetwork() {
    const subsystem = document.getElementById('subsystem-select').value;
    if (!subsystem) { alert('Please select a subsystem first.'); return; }

    showLoading(`Building "${subsystem}" network…`);

    fetch(`/api/metabolic/subsystem/${encodeURIComponent(subsystem)}/graph`)
        .then(r => r.json())
        .then(data => {
            hideLoading();
            buildCytoscape(data.nodes, data.edges);
        })
        .catch(err => { hideLoading(); console.error('Network error:', err); });
}

function buildCytoscape(nodes, edges) {
    document.getElementById('cy-placeholder').style.display = 'none';
    const cyEl = document.getElementById('cy');
    cyEl.style.display = 'block';
    document.getElementById('fit-network-btn').style.display = '';
    document.getElementById('cy-legend').style.display = '';
    document.getElementById('cy-node-info').style.display = 'none';
    document.getElementById('flux-overlay-badge').style.display = 'none';

    // Show overlay buttons only when flux data is available
    const hasFlux = Object.keys(lastFluxes).length > 0;
    document.getElementById('apply-flux-btn').style.display = hasFlux ? '' : 'none';
    document.getElementById('reset-flux-btn').style.display = 'none';

    if (cy) cy.destroy();

    const layoutName = document.getElementById('layout-select').value || 'dagre';

    const layoutOptions = {
        dagre: {
            name: 'dagre',
            rankDir: 'LR',
            nodeSep: 40,
            rankSep: 80,
            animate: false,
            nodeDimensionsIncludeLabels: true,
        },
        cose: {
            name: 'cose',
            animate: false,
            nodeRepulsion: 6000,
            idealEdgeLength: 80,
            nodeDimensionsIncludeLabels: true,
        },
        breadthfirst: {
            name: 'breadthfirst',
            directed: true,
            spacingFactor: 1.4,
            animate: false,
            nodeDimensionsIncludeLabels: true,
        },
        concentric: {
            name: 'concentric',
            animate: false,
            spacingFactor: 1.6,
            concentric: n => n.data('type') === 'rxn' ? 2 : 1,
            levelWidth: () => 1,
            nodeDimensionsIncludeLabels: true,
        },
    };

    cy = cytoscape({
        container: cyEl,
        elements: { nodes, edges },
        style: [
            {
                selector: 'node[type="rxn"]',
                style: {
                    'background-color': '#4e8dc7',
                    'label': 'data(label)',
                    'color': '#fff',
                    'font-size': 9,
                    'text-halign': 'center',
                    'text-valign': 'center',
                    'shape': 'rectangle',
                    'width': 'label',
                    'height': 18,
                    'padding': '4px',
                    'text-wrap': 'wrap',
                    'text-max-width': 110,
                }
            },
            {
                selector: 'node[type="met"]',
                style: {
                    'background-color': '#5cb85c',
                    'label': 'data(label)',
                    'color': '#fff',
                    'font-size': 8,
                    'text-halign': 'center',
                    'text-valign': 'center',
                    'shape': 'ellipse',
                    'width': 'label',
                    'height': 18,
                    'padding': '3px',
                    'text-wrap': 'wrap',
                    'text-max-width': 80,
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 1.5,
                    'line-color': '#aaa',
                    'target-arrow-color': '#888',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'arrow-scale': 0.7,
                }
            },
            {
                selector: ':selected',
                style: { 'border-width': 3, 'border-color': '#e67e22' }
            }
        ],
        layout: layoutOptions[layoutName] || layoutOptions.dagre,
    });

    // Apply compartment colours to metabolite nodes
    cy.nodes('[type="met"]').forEach(node => {
        const comp = node.data('compartment') || node.id().split('_').pop();
        const col  = COMP_COLORS[comp] || '#5cb85c';
        node.style('background-color', col);
    });

    // Auto-apply flux overlay if FBA has been run
    if (hasFlux) applyFluxOverlay(lastFluxes);

    // Node tap → info panel
    cy.on('tap', 'node', evt => {
        const n = evt.target;
        const flux = lastFluxes[n.id()];
        const comp = n.data('compartment') || '';
        const compStr = comp ? ` · compartment: ${comp}` : '';
        const fluxStr = flux != null ? ` · flux: ${flux.toFixed(4)} mmol·gDW⁻¹·h⁻¹` : '';
        document.getElementById('cy-node-title').textContent = n.data('label');
        document.getElementById('cy-node-detail').textContent =
            (n.data('type') === 'rxn' ? `Reaction: ${n.id()}` : `Metabolite: ${n.id()}${compStr}`) + fluxStr;
        document.getElementById('cy-node-info').style.display = 'block';
    });
    cy.on('tap', evt => {
        if (evt.target === cy) document.getElementById('cy-node-info').style.display = 'none';
    });
}

// ── Flux overlay on Cytoscape ─────────────────────────────────────────────────
function applyFluxOverlay(fluxes) {
    if (!cy || Object.keys(fluxes).length === 0) return;

    const maxFlux = Math.max(...Object.values(fluxes).map(Math.abs), 1);

    // Colour edges by the flux of their reaction node
    cy.edges().forEach(edge => {
        const srcType = edge.source().data('type');
        const rxnNode = srcType === 'rxn' ? edge.source() : edge.target();
        const flux    = fluxes[rxnNode.id()] || 0;
        const absFlux = Math.abs(flux);

        if (absFlux < 1e-9) {
            edge.style({ 'line-color': '#e0e0e0', 'target-arrow-color': '#e0e0e0', 'width': 0.8, 'opacity': 0.5 });
        } else {
            const intensity = Math.min(absFlux / maxFlux, 1);
            const width = 1 + intensity * 7;
            const alpha = 0.35 + intensity * 0.65;
            const color = flux > 0
                ? `rgba(30, 100, 200, ${alpha})`
                : `rgba(192, 57, 43, ${alpha})`;
            edge.style({ 'line-color': color, 'target-arrow-color': color, 'width': width, 'opacity': 1 });
        }
    });

    // Dim inactive reaction nodes, brighten active ones
    cy.nodes('[type="rxn"]').forEach(node => {
        const flux = fluxes[node.id()] || 0;
        if (Math.abs(flux) < 1e-9) {
            node.style({ 'background-color': '#bdc3c7', 'opacity': 0.55 });
        } else {
            node.style({ 'background-color': '#4e8dc7', 'opacity': 1 });
        }
    });

    document.getElementById('flux-overlay-badge').style.display = '';
    document.getElementById('apply-flux-btn').style.display = 'none';
    document.getElementById('reset-flux-btn').style.display = '';
}

function resetFluxOverlay() {
    if (!cy) return;
    cy.edges().style({ 'line-color': '#aaa', 'target-arrow-color': '#888', 'width': 1.5, 'opacity': 1 });
    cy.nodes('[type="rxn"]').style({ 'background-color': '#4e8dc7', 'opacity': 1 });
    document.getElementById('flux-overlay-badge').style.display = 'none';
    document.getElementById('apply-flux-btn').style.display = '';
    document.getElementById('reset-flux-btn').style.display = 'none';
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
            renderSubsystemChart(d.fluxes);
            document.getElementById('fba-flux-wrap').style.display = '';
            document.getElementById('pathway-vis-wrap').style.display = '';

            // Show "View on network" button; update overlay button state if network is open
            if (cy) {
                document.getElementById('apply-flux-btn').style.display = '';
                applyFluxOverlay(d.fluxes);
            }
        } else {
            box.innerHTML = `<div class="alert alert-warning mb-1">
                Optimisation status: <strong>${d.status}</strong>
                <span class="d-block small text-muted mt-1">This usually means the model is infeasible under the given constraints. Check your bounds.</span>
            </div>`;
            document.getElementById('fba-flux-wrap').style.display = 'none';
        }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run FBA';
    })
    .catch(err => {
        console.error('FBA error:', err);
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run FBA';
    });
}

// ── FBA flux table with sparklines ────────────────────────────────────────────
function populateFBATable(fluxes) {
    const sorted  = Object.entries(fluxes).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const maxAbs  = Math.abs(sorted[0]?.[1] || 1);
    const tbody   = document.querySelector('#fba-flux-table tbody');

    tbody.innerHTML = sorted.map(([id, v]) => {
        const pct      = Math.min(Math.abs(v) / maxAbs * 100, 100).toFixed(1);
        const barColor = v >= 0 ? '#4e8dc7' : '#c0392b';
        const valClass = v >= 0 ? 'text-primary' : 'text-danger';

        return `<tr>
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
}

// ── Subsystem activity bar chart ──────────────────────────────────────────────
function renderSubsystemChart(fluxes) {
    // Aggregate absolute flux per subsystem
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

    // Colour bars: top-5 darker, rest lighter
    const colors = values.map((_, i) =>
        i < 5 ? 'rgba(46, 122, 66, 0.8)' : 'rgba(78, 141, 199, 0.6)'
    );

    const ctx = document.getElementById('subsystem-chart').getContext('2d');
    if (subsystemChart) subsystemChart.destroy();

    subsystemChart = new Chart(ctx, {
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
                    title: { display: true, text: 'Total absolute flux (mmol·gDW⁻¹·h⁻¹)' },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                },
                y: {
                    ticks: { font: { size: 11 } }
                }
            }
        }
    });

    document.getElementById('subsystem-chart-wrap').style.display = '';
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

// ── Export FBA ────────────────────────────────────────────────────────────────
function exportFBA() {
    const rows = [['Reaction ID', 'Reaction name', 'Subsystem', 'Flux (mmol/gDW/h)']];
    const subsystemLookup = {};
    allReactions.forEach(r => { subsystemLookup[r.id] = r.subsystem || ''; });

    Object.entries(lastFluxes)
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
        .forEach(([id, v]) => rows.push([id, rxnNameMap[id] || '', subsystemLookup[id] || '', v]));

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'FBA fluxes');
    XLSX.writeFile(wb, 'fba_fluxes_iRH783.xlsx');
}

// ── KEGG Mapper ───────────────────────────────────────────────────────────────
function loadKeggPathways() {
    fetch('/api/metabolic/kegg_pathways')
        .then(r => r.json())
        .then(pathways => {
            const sel = document.getElementById('kegg-pathway-select');
            pathways.forEach(p => {
                const o = document.createElement('option');
                o.value = p.id;
                o.textContent = p.name;
                sel.appendChild(o);
            });
        })
        .catch(() => {});   // non-fatal
}

function openKegg() {
    if (!Object.keys(lastFluxes).length) {
        alert('Run FBA first to generate flux data for pathway colouring.');
        return;
    }
    const pathway = document.getElementById('kegg-pathway-select').value || 'syn01100';
    const btn = document.getElementById('open-kegg-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Building…';

    fetch('/api/metabolic/kegg_url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fluxes: lastFluxes, pathway }),
    })
    .then(r => r.json())
    .then(d => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-external-link"></i> Open in KEGG Mapper';
        if (d.url) {
            window.open(d.url, '_blank');
            if (d.colored === 0) {
                alert('No KEGG-annotated genes found for this flux solution. The pathway map will open without colouring.');
            }
        } else {
            alert('Failed to build KEGG URL.');
        }
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-external-link"></i> Open in KEGG Mapper';
        console.error('KEGG URL error:', err);
    });
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
        const visible = row.textContent.toLowerCase().includes(q);
        row.style.display = visible ? '' : 'none';
        if (visible) shown++;
    });
    const label = document.getElementById(countLabelId);
    if (label) label.textContent = q ? `${shown} / ${rows.length} shown` : `${rows.length} total`;
}

// ── Analysis tab wiring ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('run-pe-btn').addEventListener('click', runProductionEnvelope);
    document.getElementById('run-en-btn').addEventListener('click', runEnergetics);

    // Reference lock / clear buttons (ls- prefix no longer has dedicated lock/clear btn in new layout)
    ['pe', 'en'].forEach(pfx => {
        document.getElementById(`${pfx}-lock-btn`).addEventListener('click', () => lockRef(pfx));
        document.getElementById(`${pfx}-clear-btn`).addEventListener('click', () => clearRef(pfx));
    });

    // Custom reactions
    document.getElementById('cr-add-template-btn').addEventListener('click', crAddTemplate);
    document.getElementById('cr-add-manual-btn').addEventListener('click', () => {
        document.getElementById('cr-manual-form').style.display = '';
    });
    document.getElementById('cr-man-cancel-btn').addEventListener('click', () => {
        document.getElementById('cr-manual-form').style.display = 'none';
    });
    document.getElementById('cr-man-add-btn').addEventListener('click', crAddManual);
    document.getElementById('cr-clear-all-btn').addEventListener('click', crClearAll);

    // Sim card actions
    document.getElementById('sim-fit-btn')?.addEventListener('click', simFitToFBA);
    document.getElementById('sim-run-ls-btn')?.addEventListener('click', runLightSweep);
    document.getElementById('sim-pipeline-btn')?.addEventListener('click', simRunPipeline);
    document.getElementById('sim-compare-btn')?.addEventListener('click', simCompareWTvsKO);
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
            populateFBATable(d.fluxes);
            renderSubsystemChart(d.fluxes);
            simMarkFBAPoint(d.objective, d.fluxes);
            document.getElementById('fba-flux-wrap').style.display = '';
            document.getElementById('pathway-vis-wrap').style.display = '';
            if (cy) { document.getElementById('apply-flux-btn').style.display = ''; applyFluxOverlay(d.fluxes); }
        } else {
            box.innerHTML = `<div class="alert alert-warning mb-1">
                Optimisation status: <strong>${d.status}</strong>
                <span class="d-block small text-muted mt-1">Check your bounds.</span>
            </div>`;
            document.getElementById('fba-flux-wrap').style.display = 'none';
        }
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run FBA';
    })
    .catch(err => {
        console.error('FBA error:', err);
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run FBA';
    });
}

// ── Analysis: reference state ─────────────────────────────────────────────────
let peLastData = null, peRefData = null, peRefLabel = '';
let enLastData = null, enRefData = null, enRefLabel = '';

function lockRef(pfx) {
    const data = pfx === 'pe' ? peLastData : enLastData;
    if (!data) return;
    const label = captureRefLabel(pfx);
    if (pfx === 'pe') { peRefData = data; peRefLabel = label; renderProductionEnvelope(peLastData); }
    if (pfx === 'en') { enRefData = data; enRefLabel = label; renderEnergetics(enLastData); }
    document.getElementById(`${pfx}-ref-badge-text`).textContent = label;
    document.getElementById(`${pfx}-ref-badge`).style.display = '';
    document.getElementById(`${pfx}-clear-btn`).style.display = '';
}

function clearRef(pfx) {
    if (pfx === 'pe') { peRefData = null; peRefLabel = ''; if (peLastData) renderProductionEnvelope(peLastData); }
    if (pfx === 'en') { enRefData = null; enRefLabel = ''; if (enLastData) renderEnergetics(enLastData); }
    document.getElementById(`${pfx}-ref-badge`).style.display = 'none';
    document.getElementById(`${pfx}-clear-btn`).style.display = 'none';
}

function captureRefLabel(pfx) {
    const constrained = document.getElementById(`${pfx}-constrained`)?.checked;
    const base = constrained ? 'autotrophic' : 'unconstrained';
    if (pfx === 'pe') return `${document.getElementById('pe-rxn').value.trim()}, ${base}`;
    if (pfx === 'en') return `${document.getElementById('en-rxn').value.trim()}, ${base}`;
    return base;
}

function showRefBar(pfx) {
    document.getElementById(`${pfx}-ref-bar`).style.display = 'flex';
}

// ── Chart instances ───────────────────────────────────────────────────────────
let peChart = null;
let enChart = null;

// ── FBA light sweep ───────────────────────────────────────────────────────────
let simFbaData     = null;   // last FBA sweep result {points}
let simFbaPoints   = null;   // [{I, mu}] converted with current α for growth curve overlay
let simFbaRefData  = null;   // saved FBA reference
let simFbaRefLabel = '';
let simFbaGrowthChart = null, simFbaYieldChart = null, simFbaO2Chart = null;

function runLightSweep() {
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
        }),
    })
    .then(r => r.json())
    .then(d => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-sun-o"></i> Run FBA light sweep';
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
        renderSimFbaSweep(d);
        simRecompute();   // redraw growth curve with FBA overlay
        return d;
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-sun-o"></i> Run FBA light sweep';
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

/** Update only the analytical overlay and I₀ marker on the FBA growth chart (no FBA re-run). */
function updateFbaGrowthOverlay() {
    if (!simFbaGrowthChart) return;
    const p     = simGetParams();
    const I0_op = p.I0;
    // Höper curve is always dataset index 2; I₀ marker is index 3
    const ds2 = simFbaGrowthChart.data.datasets[2];
    const ds3 = simFbaGrowthChart.data.datasets[3];
    if (!ds2 || !ds3) return;
    const xMax = Math.max(
        ...simFbaGrowthChart.data.datasets[0].data.map(pt => pt.x),
        I0_op * 1.05, 200
    );
    ds2.data = simHoepCurve(xMax);
    const muOp = simHoperMu(I0_op, 0, p.alpha, p.KL, p.YBM, p.kd, p.ngam_photon, 0);
    ds3.data  = [{ x: I0_op, y: 0 }, { x: I0_op, y: Math.max(0.02, muOp + 0.02) }];
    ds3.label = `I₀ = ${I0_op} µmol·m⁻²·s⁻¹`;
    simFbaGrowthChart.update('none');
}

function renderSimFbaSweep(d) {
    const pts    = d.points;
    const alpha  = parseFloat(document.getElementById('sim-alpha')?.value) || 0.13;
    const hasO2  = pts.some(p => p.o2 !== null && p.o2 !== 0);
    const hasRef = !!simFbaRefData;
    const refPts = simFbaRefData?.points || [];

    // Show charts, hide placeholder, reveal action buttons
    document.getElementById('sim-fba-placeholder').style.display  = 'none';
    document.getElementById('sim-fba-charts-wrap').style.display  = '';
    document.getElementById('sim-fba-lock-btn').style.display     = '';

    document.getElementById('sim-fba-o2-wrap').style.display =
        (hasO2 || (hasRef && refPts.some(p => p.o2))) ? '' : 'none';

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
    const refPtsI0 = refPts.filter(p => p.growth > 1e-4)
        .map(p => ({ x: p.photon / (alpha * 3.6), y: p.growth }));
    const xMax = Math.max(...fbaPtsI0.map(p => p.x).concat(
        ZAVREL_2019_DATA.map(d => d.I)).concat([parseFloat(document.getElementById('sim-I0')?.value) || 660])
    ) * 1.05;
    const I0_op = parseFloat(document.getElementById('sim-I0')?.value) || 660;
    const p_now = simGetParams();
    const muOp  = simHoperMu(I0_op, 0, p_now.alpha, p_now.KL, p_now.YBM, p_now.kd, p_now.ngam_photon, 0);

    const gDs = [
        {   // 0 — FBA sweep points
            label: hasRef ? 'FBA (current)' : 'FBA sweep',
            data: fbaPtsI0,
            type: 'scatter',
            borderColor: '#c0392b', backgroundColor: 'rgba(192,57,43,0.65)',
            pointRadius: 4, pointHoverRadius: 6, showLine: false,
        },
        {   // 1 — FBA reference (empty if none)
            label: simFbaRefLabel || 'FBA reference',
            data: refPtsI0,
            type: 'scatter',
            borderColor: '#aaa', backgroundColor: 'rgba(150,150,150,0.5)',
            pointRadius: 3, showLine: false,
            hidden: !hasRef,
        },
        {   // 2 — Höper 2024 analytical curve (updated live by updateFbaGrowthOverlay)
            label: 'Höper 2024 model',
            data: simHoepCurve(xMax),
            borderColor: '#2e7a42', backgroundColor: 'rgba(46,122,66,0.07)',
            borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3,
        },
        {   // 3 — I₀ operating point marker (updated live)
            label: `I₀ = ${I0_op} µmol·m⁻²·s⁻¹`,
            data: [{ x: I0_op, y: 0 }, { x: I0_op, y: Math.max(0.02, muOp + 0.02) }],
            borderColor: 'rgba(230,126,34,0.75)', backgroundColor: 'rgba(0,0,0,0)',
            borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, fill: false,
            showLine: true, tension: 0,
        },
        {   // 4 — Experimental data Zavřel 2019
            label: 'Zavřel 2019 (exp.)',
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
            options: {
                responsive: true,
                plugins: {
                    legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 16 } },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                if (ctx.dataset.label?.startsWith('Zavřel')) {
                                    const d = ZAVREL_2019_DATA[ctx.dataIndex];
                                    return `Zavřel 2019: μ = ${d.mu.toFixed(4)} ± ${d.muErr.toFixed(4)} h⁻¹`;
                                }
                                if (ctx.dataset.label?.startsWith('I₀')) return null;
                                return `${ctx.dataset.label}: μ = ${ctx.parsed.y.toFixed(4)} h⁻¹`;
                            },
                        },
                    },
                },
                scales: {
                    x: { type: 'linear', title: { display: true, text: 'I₀ — incident irradiance (µmol·m⁻²·s⁻¹)', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
                    y: { title: { display: true, text: 'Growth rate µ (h⁻¹)', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
                },
            },
        }
    );

    // ── Yield chart — x = photon flux J_I (mmol·gDW⁻¹·h⁻¹) ──────────────────
    const yLabel = hasRef ? 'Current' : 'Yield (gDW·mmol⁻¹)';
    if (simFbaYieldChart) { simFbaYieldChart.destroy(); simFbaYieldChart = null; }
    const yDs = [ds(yLabel, pts, 'yield', '#e67e22', 'rgba(230,126,34,0.08)', false)];
    if (hasRef) yDs.push(ds(simFbaRefLabel || 'Reference', refPts, 'yield', '#aaa', null, true));
    simFbaYieldChart = new Chart(
        document.getElementById('sim-fba-yield-chart').getContext('2d'),
        { type: 'line', data: { datasets: yDs },
          options: xyLineOpts('Photon uptake J_I (mmol·gDW⁻¹·h⁻¹)', 'Yield (gDW·mmol⁻¹)', hasRef) });

    // ── O₂ chart ──────────────────────────────────────────────────────────────
    if (hasO2 || (hasRef && refPts.some(p => p.o2))) {
        if (simFbaO2Chart) { simFbaO2Chart.destroy(); simFbaO2Chart = null; }
        const oLabel = hasRef ? 'Current' : 'O₂ evolution';
        const oDs = [ds(oLabel, pts, 'o2', '#3498db', 'rgba(52,152,219,0.08)', false)];
        if (hasRef) oDs.push(ds(simFbaRefLabel || 'Reference', refPts, 'o2', '#aaa', null, true));
        simFbaO2Chart = new Chart(
            document.getElementById('sim-fba-o2-chart').getContext('2d'),
            { type: 'line', data: { datasets: oDs },
              options: xyLineOpts('Photon uptake J_I (mmol·gDW⁻¹·h⁻¹)', 'O₂ evolution (mmol·gDW⁻¹·h⁻¹)', hasRef) });
    }
}

function simLockFbaRef() {
    if (!simFbaData) return;
    const constrained = document.getElementById('sim-ls-constrained')?.checked;
    simFbaRefLabel = `I=${document.getElementById('sim-ls-imin')?.value}–${document.getElementById('sim-ls-imax')?.value}, ${constrained ? 'autotrophic' : 'unconstrained'}`;
    simFbaRefData  = simFbaData;
    renderSimFbaSweep(simFbaData);
    document.getElementById('sim-fba-ref-text').textContent  = simFbaRefLabel;
    document.getElementById('sim-fba-ref-badge').style.display = '';
    document.getElementById('sim-fba-clear-btn').style.display = '';
}

function simClearFbaRef() {
    simFbaRefData  = null;
    simFbaRefLabel = '';
    document.getElementById('sim-fba-ref-badge').style.display = 'none';
    document.getElementById('sim-fba-clear-btn').style.display = 'none';
    if (simFbaData) renderSimFbaSweep(simFbaData);
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

// ── Production envelope ───────────────────────────────────────────────────────
function runProductionEnvelope() {
    const rxn = document.getElementById('pe-rxn').value.trim();
    if (!rxn) { showAnalysisError('pe-error', 'Enter a product reaction ID.'); return; }

    const btn = document.getElementById('run-pe-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Computing…';
    document.getElementById('pe-error').style.display      = 'none';
    document.getElementById('pe-chart-wrap').style.display = 'none';

    fetch('/api/metabolic/production_envelope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            product_rxn:      rxn,
            points:           parseInt(document.getElementById('pe-points').value) || 20,
            constrained:      document.getElementById('pe-constrained').checked,
            custom_reactions: customReactions,
        }),
    })
    .then(r => r.json())
    .then(d => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Compute envelope';
        if (d.error) { showAnalysisError('pe-error', d.error); return; }
        peLastData = d;
        showRefBar('pe');
        renderProductionEnvelope(d);
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Compute envelope';
        showAnalysisError('pe-error', err.message);
    });
}

function renderProductionEnvelope(d) {
    const pts    = d.points;
    const hasRef = !!peRefData;
    const refPts = peRefData?.points || [];

    document.getElementById('pe-chart-wrap').style.display = '';

    // Use {x,y} data so current and reference can have different max_growth
    const curMax = pts.map(p => ({ x: p.growth, y: p.flux_max }));
    const curMin = pts.map(p => ({ x: p.growth, y: p.flux_min }));

    const datasets = [
        {
            label: hasRef ? 'Current (max)' : 'Max product flux',
            data: curMax,
            borderColor: '#1a64c8',
            backgroundColor: 'rgba(26,100,200,0.12)',
            borderWidth: 2, pointRadius: 2, fill: '+1', tension: 0.2,
        },
        {
            label: hasRef ? 'Current (min)' : 'Min product flux',
            data: curMin,
            borderColor: 'rgba(26,100,200,0.35)',
            backgroundColor: 'rgba(26,100,200,0.04)',
            borderWidth: 1, pointRadius: 0, fill: false, tension: 0.2,
        },
    ];

    if (hasRef) {
        datasets.push(
            {
                label: `${peRefLabel || 'Reference'} (max)`,
                data: refPts.map(p => ({ x: p.growth, y: p.flux_max })),
                borderColor: '#999',
                backgroundColor: 'rgba(150,150,150,0.10)',
                borderWidth: 1.5, pointRadius: 0, borderDash: [5, 3],
                fill: '+1', tension: 0.2,
            },
            {
                label: `${peRefLabel || 'Reference'} (min)`,
                data: refPts.map(p => ({ x: p.growth, y: p.flux_min })),
                borderColor: 'rgba(150,150,150,0.4)',
                backgroundColor: 'rgba(0,0,0,0)',
                borderWidth: 1, pointRadius: 0, borderDash: [5, 3],
                fill: false, tension: 0.2,
            }
        );
    }

    if (peChart) peChart.destroy();
    peChart = new Chart(document.getElementById('pe-chart').getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            plugins: {
                legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 20 } },
                tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(4)} mmol·gDW⁻¹·h⁻¹` } },
            },
            scales: {
                x: { type: 'linear', title: { display: true, text: 'Growth rate (h⁻¹)', font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
                y: { title: { display: true, text: `${esc(d.product_rxn)} flux (mmol·gDW⁻¹·h⁻¹)`, font: { size: 11 } }, grid: { color: 'rgba(0,0,0,0.05)' } },
            },
        },
    });
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

function runEnergetics() {
    const rxn = document.getElementById('en-rxn').value.trim();
    if (!rxn) { showAnalysisError('en-error', 'Enter a target reaction ID.'); return; }

    const btn = document.getElementById('run-en-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Calculating…';
    document.getElementById('en-error').style.display   = 'none';
    document.getElementById('en-results').style.display = 'none';

    fetch('/api/metabolic/energetics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            target_rxn:       rxn,
            constrained:      document.getElementById('en-constrained').checked,
            custom_reactions: customReactions,
        }),
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

function renderEnergetics(d) {
    const hasRef = !!enRefData;

    // Only show resources that have a value in at least one of the two datasets
    const visibleRows = EN_RESOURCES.filter(r =>
        (d[r.key] != null && d[r.key] > 0) ||
        (hasRef && enRefData[r.key] != null && enRefData[r.key] > 0)
    );

    document.getElementById('en-results').style.display = '';
    document.getElementById('en-note').textContent =
        `${d.target_rxn} · max flux = ${d.target_flux} mmol·gDW⁻¹·h⁻¹ (growth blocked)` +
        (hasRef ? ` vs reference: ${enRefData.target_rxn}` : '');

    // Table
    const tbody = document.querySelector('#en-table tbody');
    if (hasRef) {
        document.querySelector('#en-table thead tr').innerHTML =
            `<th>Resource</th><th>Current</th><th>${esc(enRefLabel || 'Reference')}</th><th>Δ</th>`;
        tbody.innerHTML = visibleRows.map(r => {
            const cur = d[r.key] ?? null;
            const ref = enRefData[r.key] ?? null;
            const delta = (cur !== null && ref !== null)
                ? (cur - ref).toFixed(3)
                : '—';
            const deltaClass = parseFloat(delta) > 0 ? 'text-danger' : parseFloat(delta) < 0 ? 'text-success' : '';
            return `<tr>
                <td>${r.label} <small class="text-muted">(${r.unit})</small></td>
                <td><strong>${cur !== null ? cur : '—'}</strong></td>
                <td class="text-muted">${ref !== null ? ref : '—'}</td>
                <td class="${deltaClass}">${delta !== '—' ? (parseFloat(delta) > 0 ? '+' : '') + delta : '—'}</td>
            </tr>`;
        }).join('');
    } else {
        document.querySelector('#en-table thead tr').innerHTML =
            '<th>Resource</th><th>Cost (per mmol product)</th>';
        tbody.innerHTML = visibleRows.map(r => {
            const v = d[r.key];
            return v != null && v > 0
                ? `<tr><td>${r.label} <small class="text-muted">(${r.unit})</small></td><td><strong>${v}</strong></td></tr>`
                : '';
        }).join('');
    }

    // Bar chart — grouped when reference exists
    const labels = visibleRows.map(r => r.label);
    const datasets = [{
        label: hasRef ? 'Current' : '',
        data: visibleRows.map(r => d[r.key] ?? 0),
        backgroundColor: visibleRows.map(r => r.color + 'cc'),
        borderColor:     visibleRows.map(r => r.color),
        borderWidth: 1,
    }];
    if (hasRef) {
        datasets.push({
            label: enRefLabel || 'Reference',
            data: visibleRows.map(r => enRefData[r.key] ?? 0),
            backgroundColor: visibleRows.map(() => 'rgba(150,150,150,0.4)'),
            borderColor:     visibleRows.map(() => '#999'),
            borderWidth: 1,
        });
    }

    if (enChart) enChart.destroy();
    enChart = new Chart(document.getElementById('en-chart').getContext('2d'), {
        type: 'bar',
        data: { labels, datasets },
        options: {
            indexAxis: 'y',
            responsive: true,
            plugins: {
                legend: { display: hasRef, position: 'top', labels: { font: { size: 10 }, boxWidth: 16 } },
            },
            scales: {
                x: { title: { display: true, text: 'Cost per mmol product', font: { size: 10 } } },
                y: { ticks: { font: { size: 10 } } },
            },
        },
    });
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
    };
}

function simSlider(input, valId) {
    document.getElementById(valId).textContent = input.value;
    simRecompute();
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
    document.getElementById('sim-btn-chemo').classList.toggle('active', mode === 'chemo');
    document.getElementById('sim-btn-batch').classList.toggle('active',  mode === 'batch');
    document.getElementById('sim-chemo-charts').style.display  = mode === 'chemo' ? '' : 'none';
    document.getElementById('sim-batch-charts').style.display  = mode === 'batch' ? '' : 'none';
    const ins = document.getElementById('sim-insight-text');
    if (ins) ins.innerHTML = mode === 'chemo'
        ? 'For light-limited chemostat cultures, productivity peaks at <em>low</em> dilution rates — unlike heterotrophic cultures. Increasing α raises self-shading; reducing k<sub>d</sub> shifts D<sub>opt</sub> lower.'
        : 'In batch culture, growth rate decreases as biomass accumulates and self-shading increases. Higher α or X<sub>A,0</sub> accelerates entry into the light-limited phase.';
    // Batch initial conditions only visible in productivity tab AND batch mode
    const activeTabHref = document.querySelector('#sim-sub-tabs .nav-link.active')?.getAttribute('href') || '';
    const inProductivity = activeTabHref === '#sim-sub-productivity';
    const batchParams = document.getElementById('sim-batch-params');
    if (batchParams) batchParams.style.display = (mode === 'batch' && inProductivity) ? '' : 'none';
    simRecompute();
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
    const Imax = Math.max(I0 * 2.2, 200);
    const pts  = [];
    for (let i = 0; i <= N; i++) {
        const I  = (i / N) * Imax;
        const mu = simHoperMu(I, XA, alpha, KL, YBM, kd, ngam_photon, 0);
        pts.push({ x: I, y: mu });
    }

    const datasets = [{
        label: XA > 0 ? `μ — X_A=${XA} g·m⁻²` : 'μ(I₀)',
        data: pts.map(p => ({ x: p.x, y: p.y })),
        borderColor: '#2e7a42', backgroundColor: 'rgba(46,122,66,0.06)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
    }];

    // Show dilute-limit curve when XA > 0 (dashed)
    if (XA > 0) {
        const pts0 = [];
        for (let i = 0; i <= N; i++) {
            const I = (i / N) * Imax;
            pts0.push({ x: I, y: simHoperMu(I, 0, alpha, KL, YBM, kd, ngam_photon, 0) });
        }
        datasets.push({
            label: 'μ — dilute (X_A→0)',
            data: pts0.map(p => ({ x: p.x, y: p.y })),
            borderColor: 'rgba(46,122,66,0.35)', backgroundColor: 'rgba(0,0,0,0)',
            fill: false, tension: 0.3, pointRadius: 0, borderWidth: 1.5,
            borderDash: [4, 3],
        });
    }

    // FBA sweep overlay
    if (simFbaPoints?.length) {
        datasets.push({
            label: 'FBA sweep',
            data: simFbaPoints.map(p => ({ x: p.I, y: p.mu })),
            type: 'scatter',
            borderColor: '#c0392b', backgroundColor: 'rgba(192,57,43,0.7)',
            pointRadius: 4, pointHoverRadius: 6,
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
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            plugins: {
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
            },
            scales: {
                x: { type: 'linear', title: { display: true, text: 'I₀ (µmol·m⁻²·s⁻¹)', font: { size: 10 } },
                     ticks: { font: { size: 10 }, maxTicksLimit: 7 } },
                y: { title: { display: true, text: 'μ (h⁻¹)', font: { size: 10 } },
                     ticks: { font: { size: 10 } } },
            },
        },
    });
}


// ── Custom reactions management ───────────────────────────────────────────────

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
        return `<div class="d-flex align-items-start mb-1">
            <code class="mr-2 text-primary" style="min-width:120px;">${esc(rd.id)}</code>
            <span class="text-muted mr-2" style="font-size:0.82em;">${esc(rd.name || '')}</span>
            <span style="font-size:0.78em;font-family:monospace;">${esc(stoichStr)}</span>
            <button class="btn btn-link text-danger py-0 ml-auto" style="font-size:0.8em;"
                    onclick="crRemove(${i})"><i class="fa fa-times"></i></button>
        </div>`;
    }).join('');
}

function crRemove(i) {
    customReactions.splice(i, 1);
    crRender();
}

function crClearAll() {
    customReactions = [];
    crRender();
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
    // Show description
    const note = document.getElementById('cr-note');
    note.innerHTML = `<i class="fa fa-check-circle text-success"></i> <strong>${esc(tmpl.label)}</strong>: ${esc(tmpl.description)}`;
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
    // Clear fields
    ['cr-man-id', 'cr-man-name', 'cr-man-stoich', 'cr-man-newmets'].forEach(elId =>
        document.getElementById(elId).value = '');
    document.getElementById('cr-manual-form').style.display = 'none';
}

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
    const alpha = parseFloat(document.getElementById('sim-alpha')?.value) || 0.13;
    const I0    = photon / (alpha * 3.6);
    simFbaMarker = { growth, I0, photon };
    simRecompute();
}

function simClearFbaMarker() {
    simFbaMarker = null;
    simRecompute();
}

// ── Nelder-Mead minimiser (unconstrained, for ≤6 parameters) ─────────────────
function nelderMead(f, x0, maxIter = 2000, tol = 1e-9) {
    const n = x0.length;
    // Initial simplex: x0 + perturbed copies
    let S = [x0.slice()];
    for (let i = 0; i < n; i++) {
        const v = x0.slice();
        v[i] = v[i] !== 0 ? v[i] * 1.1 : 0.1;
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

// ── Fit Höper parameters to FBA sweep ────────────────────────────────────────
function simFitToFBA() {
    if (!simFbaData || !simFbaData.points) {
        alert('Run a light sweep first — calibration fits the Höper model to FBA predictions.');
        return;
    }
    const alpha  = parseFloat(document.getElementById('sim-alpha')?.value) || 0.13;
    const rawPts = simFbaData.points.filter(p => p.growth > 1e-4);
    if (rawPts.length < 4) {
        alert('Need at least 4 positive-growth sweep points for fitting.');
        return;
    }
    const pts = rawPts.map(p => ({ I: p.photon / (alpha * 3.6), mu: p.growth }));

    const btn = document.getElementById('sim-fit-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Fitting…';

    setTimeout(() => {
        try {
            // Log-space Nelder-Mead for KL, Y_BM; linear kd (α held fixed from slider)
            // ngam_photon=0: NGAM is already baked into FBA results via ATPM constraint
            const res = nelderMead(([lKL, lY, kd]) => {
                const [KL, Y] = [Math.exp(lKL), Math.exp(lY)];
                return pts.reduce((s, { I, mu: obs }) =>
                    s + (simHoperMu(I, 0, alpha, KL, Y, Math.max(0, kd), 0, 0) - obs) ** 2, 0);
            }, [Math.log(119), Math.log(1.84), 0.07]);

            const [lKL, lY, kd] = res.x;
            simSetSlider('sim-KL',  Math.exp(lKL),    10,    500,  0);
            simSetSlider('sim-YBM', Math.exp(lY),      0.5,   5.0, 2);
            simSetSlider('sim-kd',  Math.max(0, kd),   0,     0.5, 3);
            simRecompute();
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa fa-magic"></i> Fit Y_BM only';
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
    let D_opt = 0, P_max = 0;

    for (let i = 1; i <= steps; i++) {
        const D = (i / steps) * D_max;
        // Bisect ρ_A: simHoperMu is monotone decreasing in ρ_A
        let lo = 0, hi = 5000;
        for (let k = 0; k < 80; k++) {
            const mid = (lo + hi) / 2;
            if (simHoperMu(I0, mid, alpha, KL, YBM, kd, ngam_photon, 0) > D) lo = mid; else hi = mid;
        }
        const rho_A  = (lo + hi) / 2;
        const P_A    = rho_A * D * 24;
        const P_prod = Y_X > 0 ? Y_X * rho_A * D * 24 : null;
        points.push({ D, rho_A, P_A, P_prod });
        if (P_A > P_max) { P_max = P_A; D_opt = D; }
    }

    return { points, D_opt, P_max, D_max };
}

/** Batch culture ODE: dρ_A/dt = simHoperMu(I₀, ρ, …) · ρ — integrated via RK4. */
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
        const P_prod = Y_X > 0 ? Y_X * P_inst : null;

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
    if (chartWrap)   chartWrap.style.display   = '';

    const p      = simGetParams();
    const labels = d.points.map(pt => pt.D.toFixed(4));

    let summaryHTML = `D<sub>opt</sub> ≈ <strong>${d.D_opt.toFixed(4)} h⁻¹</strong> &nbsp;|&nbsp; P<sub>A,max</sub> ≈ <strong>${d.P_max.toFixed(1)} gCDM·m⁻²·d⁻¹</strong>`;
    if (simRefData?.mode === 'chemo' && simRefData.prodData?.points?.length) {
        summaryHTML += ` &nbsp;|&nbsp; <span class="text-secondary">${simRefData.label}: ${simRefData.prodData.P_max.toFixed(1)} gCDM·m⁻²·d⁻¹</span>`;
    }
    const summary = document.getElementById('sim-chemo-summary');
    if (summary) { summary.style.display = ''; summary.innerHTML = summaryHTML; }

    const datasets = [
        {
            label: 'P_A (gCDM·m⁻²·d⁻¹)',
            data: d.points.map(pt => pt.P_A),
            borderColor: 'rgba(40,167,69,0.9)',
            backgroundColor: 'rgba(40,167,69,0.08)',
            fill: true, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        },
        {
            label: 'ρ_A (gCDM·m⁻²)',
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

    if (p.Y_X > 0 && d.points[0]?.P_prod != null) {
        datasets.push({
            label: `${p.productName || 'Product'} (mmol·m⁻²·d⁻¹)`,
            data: d.points.map(pt => pt.P_prod),
            borderColor: 'rgba(111,66,193,0.85)',
            borderDash: [3, 3],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        });
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
            scales: {
                x:  { title: { display: true, text: 'Dilution rate D (h⁻¹)', font: { size: 11 } }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
                y:  { title: { display: true, text: 'P_A (gCDM·m⁻²·d⁻¹)',   font: { size: 11 } }, position: 'left',  ticks: { font: { size: 10 } } },
                y2: { title: { display: true, text: 'ρ_A (gCDM·m⁻²)',        font: { size: 11 } }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
            }
        }
    });
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
    if (batchWrap)   batchWrap.style.display   = '';

    const pts    = d.points;
    const p      = simGetParams();
    const labels = pts.map(pt => pt.t.toFixed(1));

    const summary = document.getElementById('sim-batch-summary');
    if (summary) {
        summary.style.display = '';
        summary.innerHTML = `P<sub>A,max</sub> ≈ <strong>${d.P_max.toFixed(2)} gCDM·m⁻²·h⁻¹</strong> at t ≈ <strong>${d.t_Pmax.toFixed(1)} h</strong>`;
    }

    // Chart 1: biomass density + bottom light
    if (simBatchDensityChart) { simBatchDensityChart.destroy(); simBatchDensityChart = null; }
    const densDatasets = [
        {
            label: 'ρ_A (gCDM·m⁻²)',
            data: pts.map(pt => pt.rho),
            borderColor: 'rgba(255,140,0,0.9)',
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        },
        {
            label: 'I_bottom (µmol·m⁻²·s⁻¹)',
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
                y:  { title: { display: true, text: 'ρ_A (gCDM·m⁻²)',           font: { size: 11 } }, position: 'left',  ticks: { font: { size: 10 } } },
                y2: { title: { display: true, text: 'I_bottom (µmol·m⁻²·s⁻¹)', font: { size: 11 } }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
            },
        },
    });

    // Chart 2: productivity + growth rate
    if (simBatchProdChart) { simBatchProdChart.destroy(); simBatchProdChart = null; }
    const prodDatasets = [
        {
            label: 'P_A (gCDM·m⁻²·h⁻¹)',
            data: pts.map(pt => pt.P_inst),
            borderColor: 'rgba(40,167,69,0.9)',
            backgroundColor: 'rgba(40,167,69,0.08)',
            fill: true, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        },
        {
            label: 'μ (h⁻¹)',
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
    if (p.Y_X > 0 && pts[0]?.P_prod != null) {
        prodDatasets.push({
            label: `${p.productName || 'Product'} (mmol·m⁻²·h⁻¹)`,
            data: pts.map(pt => pt.P_prod),
            borderColor: 'rgba(111,66,193,0.85)',
            borderDash: [3, 3],
            fill: false, tension: 0.3, pointRadius: 0,
            yAxisID: 'y',
        });
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
            scales: {
                x:  { title: { display: true, text: 'Time (h)', font: { size: 11 } }, ticks: { maxTicksLimit: 8, font: { size: 10 } } },
                y:  { title: { display: true, text: 'P_A (gCDM·m⁻²·h⁻¹)', font: { size: 11 } }, position: 'left',  ticks: { font: { size: 10 } } },
                y2: { title: { display: true, text: 'μ (h⁻¹)',              font: { size: 11 } }, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 10 } } },
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
}

function simPipelineStatus(msg) {
    const el = document.getElementById('sim-pipeline-status');
    if (!el) return;
    el.style.display = msg ? '' : 'none';
    el.innerHTML = msg ? '<i class="fa fa-spinner fa-spin"></i> ' + msg : '';
}

async function simRunPipeline() {
    const btn = document.getElementById('sim-pipeline-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Running…';
    simPipelineStatus('Step 1/2: FBA light sweep…');
    try {
        const d = await runLightSweep();
        if (!d || d.error) throw new Error(d?.error || 'Light sweep failed');
        simPipelineStatus('Step 2/2: Fitting Höper parameters…');
        simFitToFBA();
        await new Promise(r => setTimeout(r, 300));
        simPipelineStatus('');
        // Switch to Growth Curve tab to show the result
        const growthTabLink = document.querySelector('[href="#sim-sub-light"]');
        if (growthTabLink) $(growthTabLink).tab('show');
        document.getElementById('sim-card')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        simPipelineStatus('');
        alert('Pipeline error: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-code-fork"></i> FBA sweep \u2192 Fit Y_BM \u2192 Update model';
    }
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

/** Run FBA twice (WT then KO) and compare productivity */
async function simCompareWTvsKO() {
    const btn = document.getElementById('sim-compare-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Comparing…';
    simPipelineStatus('WT sweep (1/4)…');

    const savedKO = simKoGetGenes();
    simKoClear();

    try {
        // ── WT run ──
        const dWT = await runLightSweep();
        if (!dWT || dWT.error) throw new Error(dWT?.error || 'WT sweep failed');
        simPipelineStatus('Fitting WT kinetics (2/4)…');
        simFitToFBA();
        await new Promise(r => setTimeout(r, 300));
        const pWT    = simGetParams();
        const wtProd = simMode === 'chemo' ? simComputeChemostat(pWT) : simComputeBatch(pWT);
        const wtGC   = simGrowthCurvePoints(pWT);
        simRefData   = { mode: simMode, gcPts: wtGC, prodData: wtProd, label: 'WT' };
        const lbl    = document.getElementById('sim-ref-label');
        if (lbl) lbl.textContent = 'WT';
        const badge  = document.getElementById('sim-ref-badge');
        if (badge) badge.style.display = '';
        const clrBtn = document.getElementById('sim-clearref-btn');
        if (clrBtn) clrBtn.style.display = '';

        // ── KO run ──
        simKoSetGenes(savedKO);
        simPipelineStatus('KO sweep (3/4)…');
        const dKO = await runLightSweep();
        if (!dKO || dKO.error) throw new Error(dKO?.error || 'KO sweep failed');
        simPipelineStatus('Fitting KO kinetics & productivity (4/4)…');
        simFitToFBA();
        await new Promise(r => setTimeout(r, 300));

        simPipelineStatus('');
        simRecompute();
        // Switch to Growth Curve tab to show the comparison
        const growthTabLink2 = document.querySelector('[href="#sim-sub-light"]');
        if (growthTabLink2) $(growthTabLink2).tab('show');
        document.getElementById('sim-card')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
        simKoSetGenes(savedKO);
        simPipelineStatus('');
        alert('Comparison error: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-exchange"></i> Compare WT vs current KO set';
    }
}

// ── Searchable reaction dropdown ──────────────────────────────────────────────
function initRxnDropdown(searchId, dropdownId, hiddenId) {
    const input    = document.getElementById(searchId);
    const dropdown = document.getElementById(dropdownId);
    const hidden   = document.getElementById(hiddenId);
    if (!input || !dropdown || !hidden) return;

    function refresh() {
        const q = input.value.trim().toLowerCase();
        if (!q) { dropdown.style.display = 'none'; return; }
        const matches = allReactions.filter(r =>
            r.id.toLowerCase().includes(q) || (r.name || '').toLowerCase().includes(q)
        ).slice(0, 60);
        if (!matches.length) { dropdown.style.display = 'none'; return; }
        dropdown.innerHTML = matches.map(r =>
            `<div class="rxn-item" data-id="${esc(r.id)}">` +
            `<code>${esc(r.id)}</code> <span class="text-muted" style="font-size:0.9em;">${esc(r.name || '')}</span></div>`
        ).join('');
        dropdown.style.display = '';
        dropdown.querySelectorAll('.rxn-item').forEach(item => {
            item.addEventListener('mousedown', e => {
                e.preventDefault();
                hidden.value   = item.dataset.id;
                input.value    = item.dataset.id;
                dropdown.style.display = 'none';
            });
        });
    }

    input.addEventListener('input', refresh);
    input.addEventListener('focus', refresh);
    input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 180));
}

function initAllRxnDropdowns() {
    initRxnDropdown('pe-rxn-search', 'pe-rxn-dropdown', 'pe-rxn');
    initRxnDropdown('en-rxn-search', 'en-rxn-dropdown', 'en-rxn');
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
