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

// ── Haldane FBA integration state ────────────────────────────────────────────
let hmFbaMarker    = null;  // {growth, I0} — single FBA result point on growth curve
let hmFbaSweepData = null;  // [{I, mu}]   — FBA sweep overlay on growth curve

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
    document.getElementById('run-fba-btn').addEventListener('click', runFBA);
    document.getElementById('export-fba-btn').addEventListener('click', exportFBA);
    document.getElementById('add-constraint-btn').addEventListener('click', addConstraintRow);
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
function loadGenes() {
    fetch('/api/metabolic/genes')
        .then(r => r.json())
        .then(data => {
            allGenes = data;
            const tbody = document.querySelector('#gene-table tbody');
            tbody.innerHTML = data.map(g => {
                const rxnPreview = g.reactions.slice(0, 4).join(', ') +
                    (g.reactions.length > 4 ? ` +${g.reactions.length - 4}` : '');
                return `<tr data-gene="${esc(g.id)}">
                    <td><code>${esc(g.id)}</code></td>
                    <td>${esc(g.name || '—')}</td>
                    <td style="font-size:0.78em;">${esc(rxnPreview)}</td>
                    <td>
                        <button class="btn btn-xs btn-outline-secondary ko-btn py-0 px-1"
                                data-gene="${esc(g.id)}">KO</button>
                        <span class="ko-result ml-1 small" id="ko-${esc(g.id)}"></span>
                    </td>
                </tr>`;
            }).join('');

            document.getElementById('gene-count-label').textContent = `${data.length} genes`;

            document.querySelector('#gene-table tbody').addEventListener('click', e => {
                const btn = e.target.closest('.ko-btn');
                if (btn) runKnockout(btn.dataset.gene, btn);
            });
        });
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
            const rate = d.objective.toFixed(4);
            const cls = d.objective < 0.01 ? 'text-danger font-weight-bold'
                      : d.objective < 0.5  ? 'text-warning font-weight-bold'
                      : 'text-success';
            span.className = `ko-result ml-1 small ${cls}`;
            span.textContent = `${rate} h⁻¹`;
        } else {
            span.className = 'ko-result ml-1 small text-danger';
            span.textContent = d.status;
        }
        btn.disabled = false;
        btn.textContent = 'KO';
    })
    .catch(() => { btn.disabled = false; btn.textContent = 'KO'; });
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
    document.getElementById('run-ls-btn').addEventListener('click', runLightSweep);
    document.getElementById('run-pe-btn').addEventListener('click', runProductionEnvelope);
    document.getElementById('run-en-btn').addEventListener('click', runEnergetics);

    // Reference lock / clear buttons
    ['ls', 'pe', 'en'].forEach(pfx => {
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

    // FBA ↔ Haldane integration
    document.getElementById('ls-overlay-haldane-btn').addEventListener('click', hmOverlayFBASweep);
    document.getElementById('ls-overlay-clear-btn').addEventListener('click', hmClearFbaSweep);
    document.getElementById('hm-clear-fba-sweep-btn').addEventListener('click', hmClearFbaSweep);
    document.getElementById('hm-calibrate-btn').addEventListener('click', hmCalibrateFromFBA);
    document.getElementById('hm-clear-fba-marker-btn').addEventListener('click', () => {
        hmFbaMarker = null;
        document.getElementById('hm-fba-marker-badge').style.display = 'none';
        if (hmLastData) renderHaldaneCurve(hmLastData);
    });
});

// ── pFBA checkbox in FBA tab ──────────────────────────────────────────────────
// Override the original listener so the pfba flag is included in the fetch body
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('run-fba-btn').removeEventListener('click', runFBA);
    document.getElementById('run-fba-btn').addEventListener('click', runFBAwithPFBA);
});

function runFBAwithPFBA() {
    const btn = document.getElementById('run-fba-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Running…';

    const constrained = document.getElementById('fba-constrained-chk').checked;
    const usePfba     = document.getElementById('pfba-chk').checked;
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
        body: JSON.stringify({ constrained, constraints, pfba: usePfba, custom_reactions: customReactions }),
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
            hmMarkFBAPoint(d.objective, d.fluxes);
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
let lsLastData = null, lsRefData = null, lsRefLabel = '';
let peLastData = null, peRefData = null, peRefLabel = '';
let enLastData = null, enRefData = null, enRefLabel = '';

function lockRef(pfx) {
    const data = pfx === 'ls' ? lsLastData : pfx === 'pe' ? peLastData : enLastData;
    if (!data) return;
    const label = captureRefLabel(pfx);
    if (pfx === 'ls') { lsRefData = data; lsRefLabel = label; renderLightSweep(lsLastData); }
    if (pfx === 'pe') { peRefData = data; peRefLabel = label; renderProductionEnvelope(peLastData); }
    if (pfx === 'en') { enRefData = data; enRefLabel = label; renderEnergetics(enLastData); }
    document.getElementById(`${pfx}-ref-badge-text`).textContent = label;
    document.getElementById(`${pfx}-ref-badge`).style.display = '';
    document.getElementById(`${pfx}-clear-btn`).style.display = '';
}

function clearRef(pfx) {
    if (pfx === 'ls') { lsRefData = null; lsRefLabel = ''; if (lsLastData) renderLightSweep(lsLastData); }
    if (pfx === 'pe') { peRefData = null; peRefLabel = ''; if (peLastData) renderProductionEnvelope(peLastData); }
    if (pfx === 'en') { enRefData = null; enRefLabel = ''; if (enLastData) renderEnergetics(enLastData); }
    document.getElementById(`${pfx}-ref-badge`).style.display = 'none';
    document.getElementById(`${pfx}-clear-btn`).style.display = 'none';
}

function captureRefLabel(pfx) {
    const constrained = document.getElementById(`${pfx}-constrained`)?.checked;
    const base = constrained ? 'autotrophic' : 'unconstrained';
    if (pfx === 'ls') {
        const imin = document.getElementById('ls-imin').value;
        const imax = document.getElementById('ls-imax').value;
        return `I=${imin}–${imax}, ${base}`;
    }
    if (pfx === 'pe') return `${document.getElementById('pe-rxn').value.trim()}, ${base}`;
    if (pfx === 'en') return `${document.getElementById('en-rxn').value.trim()}, ${base}`;
    return base;
}

function showRefBar(pfx) {
    document.getElementById(`${pfx}-ref-bar`).style.display = 'flex';
}

// ── Chart instances ───────────────────────────────────────────────────────────
let lsGrowthChart = null, lsYieldChart = null, lsO2Chart = null;
let peChart       = null;
let enChart       = null;

// ── Light sweep ───────────────────────────────────────────────────────────────
function runLightSweep() {
    const btn = document.getElementById('run-ls-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Running…';
    document.getElementById('ls-error').style.display  = 'none';
    document.getElementById('ls-charts').style.display = 'none';

    fetch('/api/metabolic/light_sweep', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            i_min:            parseFloat(document.getElementById('ls-imin').value)  || 10,
            i_max:            parseFloat(document.getElementById('ls-imax').value)  || 1200,
            steps:            parseInt(document.getElementById('ls-steps').value)   || 40,
            constrained:      document.getElementById('ls-constrained').checked,
            custom_reactions: customReactions,
        }),
    })
    .then(r => r.json())
    .then(d => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run sweep';
        if (d.error) { showAnalysisError('ls-error', d.error); return; }
        lsLastData = d;
        showRefBar('ls');
        renderLightSweep(d);
    })
    .catch(err => {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa fa-play"></i> Run sweep';
        showAnalysisError('ls-error', err.message);
    });
}

function renderLightSweep(d) {
    const pts    = d.points;
    const hasO2  = pts.some(p => p.o2 !== null && p.o2 !== 0);
    const hasRef = !!lsRefData;
    const refPts = lsRefData?.points || [];

    document.getElementById('ls-charts').style.display = '';
    document.getElementById('ls-o2-wrap').style.display = (hasO2 || (hasRef && refPts.some(p => p.o2))) ? '' : 'none';

    function lsDataset(label, pts, yKey, color, fillColor, isRef) {
        return {
            label,
            data: pts.map(p => ({ x: p.photon, y: p[yKey] })),
            borderColor: isRef ? '#aaa' : color,
            backgroundColor: isRef ? 'rgba(0,0,0,0)' : fillColor,
            borderWidth: isRef ? 1.5 : 2,
            borderDash: isRef ? [5, 3] : [],
            pointRadius: isRef ? 0 : 2,
            fill: isRef ? false : (!hasRef),
            tension: 0.3,
        };
    }

    const growthLabel = hasRef ? 'Current' : 'Growth rate (h⁻¹)';
    const yieldLabel  = hasRef ? 'Current' : 'Yield (gDW·µmol⁻¹)';
    const o2Label     = hasRef ? 'Current' : 'O₂ evolution';

    // Growth chart
    if (lsGrowthChart) lsGrowthChart.destroy();
    const growthDs = [lsDataset(growthLabel, pts, 'growth', '#2e7a42', 'rgba(46,122,66,0.08)', false)];
    if (hasRef) growthDs.push(lsDataset(lsRefLabel || 'Reference', refPts, 'growth', '#aaa', null, true));
    lsGrowthChart = new Chart(document.getElementById('ls-growth-chart').getContext('2d'), {
        type: 'line',
        data: { datasets: growthDs },
        options: xyLineOpts('Photon uptake (µmol·gDW⁻¹·h⁻¹)', 'Growth rate (h⁻¹)', hasRef),
    });

    // Yield per photon chart
    if (lsYieldChart) lsYieldChart.destroy();
    const yieldDs = [lsDataset(yieldLabel, pts, 'yield', '#e67e22', 'rgba(230,126,34,0.08)', false)];
    if (hasRef) yieldDs.push(lsDataset(lsRefLabel || 'Reference', refPts, 'yield', '#aaa', null, true));
    lsYieldChart = new Chart(document.getElementById('ls-yield-chart').getContext('2d'), {
        type: 'line',
        data: { datasets: yieldDs },
        options: xyLineOpts('Photon uptake (µmol·gDW⁻¹·h⁻¹)', 'Yield (gDW·µmol⁻¹)', hasRef),
    });

    // O2 evolution chart
    if (hasO2 || (hasRef && refPts.some(p => p.o2))) {
        if (lsO2Chart) lsO2Chart.destroy();
        const o2Ds = [lsDataset(o2Label, pts, 'o2', '#3498db', 'rgba(52,152,219,0.08)', false)];
        if (hasRef) o2Ds.push(lsDataset(lsRefLabel || 'Reference', refPts, 'o2', '#aaa', null, true));
        lsO2Chart = new Chart(document.getElementById('ls-o2-chart').getContext('2d'), {
            type: 'line',
            data: { datasets: o2Ds },
            options: xyLineOpts('Photon uptake (µmol·gDW⁻¹·h⁻¹)', 'O₂ evolution (mmol·gDW⁻¹·h⁻¹)', hasRef),
        });
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

// ── Haldane / Höper growth curve simulator ────────────────────────────────────
let hmCurrentModel  = 'haldane';
let hmLastData      = null;
let hmRefData       = null;
let hmRefLabel      = '';
let hmGrowthChart   = null;
let hmYieldChart    = null;

// Wire up controls once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('hm-lock-btn').addEventListener('click', hmLockRef);
    document.getElementById('hm-clear-btn').addEventListener('click', hmClearRef);
    // Initial render
    recomputeHaldane();
});

function hmSlider(input, valId) {
    document.getElementById(valId).textContent = input.value;
    recomputeHaldane();
}

function hmToggleDensity() {
    const on = document.getElementById('hm-density-check').checked;
    document.getElementById('hm-density-controls').style.display = on ? '' : 'none';
    recomputeHaldane();
}

function setHaldaneModel(model) {
    hmCurrentModel = model;
    document.getElementById('hm-params-haldane').style.display = model === 'haldane' ? '' : 'none';
    document.getElementById('hm-params-hoper').style.display   = model === 'hoper'   ? '' : 'none';
    document.getElementById('hm-btn-haldane').classList.toggle('active', model === 'haldane');
    document.getElementById('hm-btn-hoper').classList.toggle('active', model === 'hoper');
    // k_ext row: only relevant for Haldane (Höper uses α for extinction)
    document.getElementById('hm-kext-row').style.display = model === 'haldane' ? '' : 'none';
    // Update equation display
    if (model === 'haldane') {
        document.getElementById('hm-equation').innerHTML =
            'μ(I) = μ* · I / (K_A + I + I²/K_I)<br>' +
            '<span class="text-info" id="hm-iopt-line">I_opt = <span id="hm-iopt">—</span> µmol·m⁻²·s⁻¹</span>';
    } else {
        document.getElementById('hm-equation').innerHTML =
            'J_I = α · I · 3.6 (mmol·gCDW⁻¹·h⁻¹)<br>' +
            'J*_I = K_L · J_I / (K_L + J_I)<br>' +
            'μ = Y_BM × 10⁻³ · J*_I − k_d';
    }
    recomputeHaldane();
}

/** Lambert-Beer average light over an optically thick culture layer */
function hmLambertBeer(I0, k, XA) {
    if (XA <= 0 || k <= 0) return I0;
    const tau = k * XA;
    return I0 * (1 - Math.exp(-tau)) / tau;
}

/** Haldane/Aiba growth rate */
function hmHaldaneGrowth(I, muStar, KA, KI) {
    if (I <= 0) return 0;
    return muStar * I / (KA + I + (I * I) / KI);
}

/** Höper 2024 growth rate. Y_BM in gCDW/mmol (pass as ×10⁻³) */
function hmHoperGrowth(I, alpha, KL, Y_BM_milli, kd) {
    if (I <= 0) return Math.max(0, -kd);
    const JI    = alpha * I * 3.6;              // mmol photons / gCDW / h
    const JStar = KL * JI / (KL + JI);          // saturation of photosynthetic capacity
    return (Y_BM_milli * 1e-3) * JStar - kd;    // h⁻¹  (Y_BM slider is in ×10⁻³ units)
}

function recomputeHaldane() {
    const Imax     = parseFloat(document.getElementById('hm-imax').value) || 1500;
    const useDens  = document.getElementById('hm-density-check').checked;
    const XA       = useDens ? (parseFloat(document.getElementById('hm-xa').value) || 30) : 0;
    const N        = 300;
    const pts      = [];

    // Read model-specific params
    let muStar, KA, KI, alpha, KL, Y_BM_milli, kd, k_ext;
    if (hmCurrentModel === 'haldane') {
        muStar = parseFloat(document.getElementById('hm-mu-star').value);
        KA     = parseFloat(document.getElementById('hm-KA').value);
        KI     = parseFloat(document.getElementById('hm-KI').value);
        k_ext  = useDens ? (parseFloat(document.getElementById('hm-kext').value) || 0.15) : 0;
        // Update I_opt display
        const iopt = Math.sqrt(KA * KI);
        const iel = document.getElementById('hm-iopt');
        if (iel) iel.textContent = iopt.toFixed(0);
    } else {
        alpha       = parseFloat(document.getElementById('hm-alpha').value);
        KL          = parseFloat(document.getElementById('hm-KL').value);
        Y_BM_milli  = parseFloat(document.getElementById('hm-ybm').value);
        kd          = parseFloat(document.getElementById('hm-kd').value);
        k_ext       = alpha; // Höper: same coefficient for absorption and extinction
    }

    for (let i = 0; i <= N; i++) {
        const I0   = (i / N) * Imax;
        const Ieff = useDens ? hmLambertBeer(I0, k_ext, XA) : I0;
        let mu, yield_val;

        if (hmCurrentModel === 'haldane') {
            mu = hmHaldaneGrowth(Ieff, muStar, KA, KI);
            // Light use efficiency: μ / I (relative; set to 0 at I=0)
            yield_val = I0 > 0 ? mu / I0 : 0;
        } else {
            mu = hmHoperGrowth(Ieff, alpha, KL, Y_BM_milli, kd);
            // Biomass yield per photon absorbed: μ / J*I (gCDW / mmol photons)
            const JI = alpha * Ieff * 3.6;
            yield_val = JI > 0 ? mu / JI : 0;
        }

        pts.push({ I: I0, Ieff, mu: Math.max(mu, 0), yield: Math.max(yield_val, 0) });
    }

    // Update density note
    if (useDens && XA > 0) {
        const Iavg_mid = hmLambertBeer(Imax / 2, k_ext, XA);
        const note = document.getElementById('hm-density-note');
        if (note) note.textContent =
            `At I₀ = ${(Imax/2).toFixed(0)} µmol·m⁻²·s⁻¹: I_avg ≈ ${Iavg_mid.toFixed(0)} µmol·m⁻²·s⁻¹ (${(100*Iavg_mid/(Imax/2)).toFixed(0)}% of surface)`;
    }

    hmLastData = { pts, Imax, model: hmCurrentModel };
    // Show ref-bar after first compute
    document.getElementById('hm-ref-bar').style.display = 'flex';
    renderHaldaneCurve(hmLastData);
}

function renderHaldaneCurve(d) {
    const pts    = d.pts;
    const hasRef = !!hmRefData;
    const refPts = hmRefData ? hmRefData.pts : [];

    const isHoper = (d.model === 'hoper');
    const yieldLabel = isHoper ? 'Biomass yield (gCDW·mmol⁻¹)' : 'Light use efficiency (μ/I, rel.)';

    function hmDs(label, points, yKey, color, isRef) {
        return {
            label,
            data: points.map(p => ({ x: p.I, y: p[yKey] })),
            borderColor: isRef ? '#aaa' : color,
            backgroundColor: isRef ? 'rgba(0,0,0,0)' : color + '14',
            borderWidth: isRef ? 1.5 : 2,
            borderDash: isRef ? [5, 3] : [],
            pointRadius: 0,
            fill: isRef ? false : !hasRef,
            tension: 0.3,
        };
    }

    // Growth rate chart — includes optional FBA marker and FBA sweep overlay
    if (hmGrowthChart) hmGrowthChart.destroy();
    const hasFbaSweep  = !!hmFbaSweepData && hmFbaSweepData.length > 0;
    const hasFbaMarker = !!hmFbaMarker;
    const showLegend   = hasRef || hasFbaSweep || hasFbaMarker;
    const growthDs = [hmDs(showLegend ? 'Kinetic model' : 'Growth rate (h⁻¹)', pts, 'mu', '#2e7a42', false)];
    if (hasRef)      growthDs.push(hmDs(hmRefLabel || 'Reference', refPts, 'mu', '#aaa', true));
    if (hasFbaSweep) growthDs.push({
        label: 'FBA sweep',
        data: hmFbaSweepData.map(p => ({ x: p.I, y: p.mu })),
        borderColor: '#e67e22', backgroundColor: '#e67e22',
        pointStyle: 'circle', pointRadius: 4, pointHoverRadius: 6,
        showLine: false, type: 'scatter',
    });
    if (hasFbaMarker) growthDs.push({
        label: `FBA (μ=${hmFbaMarker.growth.toFixed(3)} h⁻¹)`,
        data: [{ x: hmFbaMarker.I0, y: hmFbaMarker.growth }],
        borderColor: '#e74c3c', backgroundColor: '#e74c3c',
        pointStyle: 'triangle', pointRadius: 9, pointHoverRadius: 11,
        showLine: false, type: 'scatter',
    });
    hmGrowthChart = new Chart(document.getElementById('hm-growth-chart').getContext('2d'), {
        type: 'line',
        data: { datasets: growthDs },
        options: xyLineOpts('Incident light I₀ (µmol·m⁻²·s⁻¹)', 'Growth rate (h⁻¹)', showLegend),
    });

    // Yield/efficiency chart
    if (hmYieldChart) hmYieldChart.destroy();
    const yieldDs = [hmDs(hasRef ? 'Current' : yieldLabel, pts, 'yield', '#e67e22', false)];
    if (hasRef) yieldDs.push(hmDs(hmRefLabel || 'Reference', refPts, 'yield', '#aaa', true));
    hmYieldChart = new Chart(document.getElementById('hm-yield-chart').getContext('2d'), {
        type: 'line',
        data: { datasets: yieldDs },
        options: xyLineOpts('Incident light I₀ (µmol·m⁻²·s⁻¹)', yieldLabel, hasRef),
    });
}

function hmLockRef() {
    if (!hmLastData) return;
    // Build a label from current params
    let label;
    if (hmCurrentModel === 'haldane') {
        const mu = document.getElementById('hm-mu-star').value;
        const KA = document.getElementById('hm-KA').value;
        const KI = document.getElementById('hm-KI').value;
        label = `Haldane μ*=${mu}, KA=${KA}, KI=${KI}`;
    } else {
        const al = document.getElementById('hm-alpha').value;
        const KL = document.getElementById('hm-KL').value;
        const kd = document.getElementById('hm-kd').value;
        label = `Höper α=${al}, KL=${KL}, kd=${kd}`;
    }
    hmRefData  = hmLastData;
    hmRefLabel = label;
    renderHaldaneCurve(hmLastData);
    document.getElementById('hm-ref-badge-text').textContent = label;
    document.getElementById('hm-ref-badge').style.display = '';
    document.getElementById('hm-clear-btn').style.display = '';
}

function hmClearRef() {
    hmRefData  = null;
    hmRefLabel = '';
    if (hmLastData) renderHaldaneCurve(hmLastData);
    document.getElementById('hm-ref-badge').style.display = 'none';
    document.getElementById('hm-clear-btn').style.display = 'none';
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
function hmMarkFBAPoint(growth, fluxes) {
    // Find photon exchange flux (absolute value = uptake)
    const photonKeys = ['EX_photon_e1_e', 'EX_photon_e', 'R_EX_photon_e'];
    let photon = 0;
    for (const k of photonKeys) {
        if (fluxes[k] !== undefined) { photon = Math.abs(fluxes[k]); break; }
    }
    if (photon === 0) return;   // no photon flux found — not a phototrophic run

    const alpha = parseFloat(document.getElementById('hm-calib-alpha')?.value) || 0.13;
    const I0    = photon / (alpha * 3.6);   // mmol/gDW/h → µmol/m²/s
    hmFbaMarker = { growth, I0, photon };

    const badge = document.getElementById('hm-fba-marker-badge');
    if (badge) {
        document.getElementById('hm-fba-marker-text').textContent =
            `FBA: I₀ ≈ ${I0.toFixed(0)} µmol·m⁻²·s⁻¹, μ = ${growth.toFixed(4)} h⁻¹`;
        badge.style.display = '';
    }
    if (hmLastData) renderHaldaneCurve(hmLastData);
}

/** Overlay last FBA light sweep data onto the Haldane growth chart. */
function hmOverlayFBASweep() {
    if (!lsLastData || !lsLastData.points) {
        alert('Run a light sweep first.');
        return;
    }
    const alpha = parseFloat(document.getElementById('ls-alpha-conv')?.value) || 0.13;
    hmFbaSweepData = lsLastData.points
        .filter(p => p.growth > 0)
        .map(p => ({ I: p.photon / (alpha * 3.6), mu: p.growth }));

    // Sync alpha to Haldane card input if present
    const hc = document.getElementById('hm-calib-alpha');
    if (hc) hc.value = alpha;

    document.getElementById('ls-overlay-badge').style.display = '';
    document.getElementById('ls-overlay-clear-btn').style.display = '';
    document.getElementById('hm-fba-sweep-badge').style.display = '';

    if (hmLastData) renderHaldaneCurve(hmLastData);
    // Switch to Analysis tab so user can see the result
    document.querySelector('[href="#tab-analysis"]')?.click();
    // Scroll to Haldane card (smooth)
    document.getElementById('hm-growth-chart')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hmClearFbaSweep() {
    hmFbaSweepData = null;
    document.getElementById('ls-overlay-badge').style.display = 'none';
    document.getElementById('ls-overlay-clear-btn').style.display = 'none';
    document.getElementById('hm-fba-sweep-badge').style.display = 'none';
    if (hmLastData) renderHaldaneCurve(hmLastData);
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

// ── Calibrate Haldane/Höper parameters from FBA sweep ────────────────────────
function hmCalibrateFromFBA() {
    if (!lsLastData || !lsLastData.points) {
        alert('Run a light sweep first — calibration fits the selected kinetic model to FBA predictions.');
        return;
    }
    const alpha = parseFloat(document.getElementById('hm-calib-alpha')?.value) || 0.13;
    const rawPts = lsLastData.points.filter(p => p.growth > 1e-4);
    if (rawPts.length < 4) {
        alert('Need at least 4 positive-growth sweep points for fitting.');
        return;
    }
    // Convert photon flux (mmol·gDW⁻¹·h⁻¹) → incident light I₀ (µmol·m⁻²·s⁻¹)
    const pts = rawPts.map(p => ({ I: p.photon / (alpha * 3.6), mu: p.growth }));

    const btn = document.getElementById('hm-calibrate-btn');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa fa-spinner fa-spin"></i> Fitting…';

    // Use setTimeout to allow browser to repaint the spinner before heavy JS
    setTimeout(() => {
        try {
            if (hmCurrentModel === 'haldane') {
                // Log-space NM: [log(μ*), log(KA), log(KI)]
                const res = nelderMead(([lmu, lKA, lKI]) => {
                    const [mu, KA, KI] = [Math.exp(lmu), Math.exp(lKA), Math.exp(lKI)];
                    return pts.reduce((s, { I, mu: obs }) =>
                        s + (hmHaldaneGrowth(I, mu, KA, KI) - obs) ** 2, 0);
                }, [Math.log(0.18), Math.log(100), Math.log(1500)]);

                const [mu, KA, KI] = res.x.map(Math.exp);
                hmSetSlider('hm-mu-star', mu, 0.01, 0.50, 3);
                hmSetSlider('hm-KA',      KA, 5,    500,  0);
                hmSetSlider('hm-KI',      KI, 50,   5000, 0);
            } else {
                // Log-space NM for α, KL, Y_BM; linear kd
                const res = nelderMead(([la, lKL, lY, kd]) => {
                    const [a, KL, Y] = [Math.exp(la), Math.exp(lKL), Math.exp(lY)];
                    return pts.reduce((s, { I, mu: obs }) =>
                        s + (hmHoperGrowth(I, a, KL, Y, kd) - obs) ** 2, 0);
                }, [Math.log(0.13), Math.log(119), Math.log(1.84), 0.07]);

                const [la, lKL, lY, kd] = res.x;
                hmSetSlider('hm-alpha', Math.exp(la),  0.01, 0.50, 2);
                hmSetSlider('hm-KL',   Math.exp(lKL),  10,   500,  0);
                hmSetSlider('hm-ybm',  Math.exp(lY),   0.5,  5.0,  2);
                hmSetSlider('hm-kd',   Math.max(0, kd),0,    0.30, 3);
            }
            recomputeHaldane();
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa fa-magic"></i> Calibrate parameters from FBA sweep';
        }
    }, 20);
}

/** Set a range slider value (clamped) and update its display label. */
function hmSetSlider(id, value, min, max, decimals) {
    const clamped = Math.max(min, Math.min(max, value));
    const el = document.getElementById(id);
    if (el) {
        el.value = clamped;
        const lbl = document.getElementById(id + '-val');
        if (lbl) lbl.textContent = clamped.toFixed(decimals);
    }
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
