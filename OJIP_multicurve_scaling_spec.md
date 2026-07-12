# OJIP Multi-Curve **Scaling** Implementation Spec

**Date:** 2026-07-12
**Author:** Design/architecture pass for cyano.tools OJIP tool
**Companion to:** `OJIP_multicurve_implementation_plan.md` (parsing + selection UI)
**Goal:** Analyze, visualize, annotate and export **all** OJIP curves in a large multi-curve FluorPen file (700+, tested with `1580.txt` = 756 curves) — removing the current 100-curve cap while keeping the full feature set responsive, with **real progress and no global spinner blocking the UI**.

**Confirmed constraints (from planning session):**

- Host: **Flask on PythonAnywhere, Hacker/paid tier** (multiple web workers, more CPU-seconds, more RAM). Hard per-request timeout still applies (~300 s) — do **not** rely on a single long request.
- **Stateless & privacy-preserving**: data processed in-session, never stored server-side. No Celery/Redis/DB, no WebSockets, no long-lived SSE (all unreliable/unavailable on PythonAnywhere).
- **All compute stays server-side** (no client WASM rewrite). Scipy pipeline is reused unchanged per curve.
- **Primary use of big files:** (1) time-series of JIP parameters across the run, (2) export everything for downstream ML. Per-curve deep-dive is on-demand; multi-curve overlay is secondary.

---

## 0. Design principles

1. **No operation ever touches all N curves synchronously.** Everything heavy is chunked into small stateless requests orchestrated by the browser.
2. **Params are cheap and primary; transient/derivative arrays are heavy and lazy.** Batch requests return JIP parameters only. Full transients are fetched one curve at a time, on demand.
3. **Parallelism comes from the browser fanning batches across PythonAnywhere's multiple web workers** — not from server-side process pools (which are fragile on PythonAnywhere). An optional in-request `ProcessPoolExecutor` is a later tuning knob, not a dependency.
4. **Progress is measured, not faked.** The bar advances on real batch completions ("N / total curves"). Panels fill incrementally; each panel owns its own light loading state.
5. **Reuse the existing single-curve pipeline verbatim** for the per-curve math. New code is orchestration, batching, virtualization, and annotation-scale — not new science.

---

## 0b. Relationship to the multi-curve **parsing** plan — what this supersedes

This spec does **not** stand alone and does **not** fully replace `OJIP_multicurve_implementation_plan.md`. The two are complementary: the parsing plan defines *how curves are extracted*; this spec defines *how the tool scales to all of them*. Read them together, with the overrides below taking precedence where they conflict.

**Still valid and required from the parsing plan (unchanged):**
- §2 Multi-curve file-format analysis (header/data/footer layout).
- §3.1 client-side detection (line-6 `index\t` sniff) and the **selection modal**.
- §3.2 the footer/metadata parse and §3.3 instrument-metadata auto-population.
- §3.5 edge cases (non-OJIP filtering, `-NAN`→null, `Bckg` handling, single-curve fallback, block multi+single mixing).
- §6 Questions for Alexey, §7 email context.

**Superseded by this spec (this wins):**

| Topic | Parsing plan said | This spec says |
|-------|-------------------|----------------|
| Curve cap | Hard **100** limit (modal warning, edge case, decision log) | Analyze **all**; hard cap **2000**, soft warning >1000 (§8) |
| Request model | One monolithic `/api/ojip_process` call, "feed pipeline unchanged" | **Chunked** `/api/ojip_process_batch`, params-first, lazy transients (§2–§5) |
| Where the data matrix is parsed | **Server** (`_parse_multicurve_aquapen`, upload file + indices) | **Client** parses the full 549×N matrix into per-curve arrays; batches send raw values. `_parse_multicurve_aquapen` becomes optional (server receives arrays, stays stateless) |
| Default view | Existing overlay/tabs | **Time-series/aggregate** view above ~50 curves (§4) |
| "No changes to `fluorescence_annotation.py` / export" (§3.4) | Claimed none needed | **Substantial** annotation-at-scale (§6) and export-at-scale (§7) changes required |

**Action:** either merge both into one master document, or add a one-line "Superseded by `OJIP_multicurve_scaling_spec.md` §0b" note atop the parsing plan's Decision Log and §3.5 100-curve rows. One concrete new dependency: the client-side parser (parsing plan §3.1) must be **extended from metadata-only to full data-matrix extraction** so batches can send raw curve arrays.

---

## 1. End-to-end data flow

```
① Select file → client-side parse (already spec'd in companion plan)
   → in-memory: timeUs[549], curves[{index,name,timestamp,values[549]}], instrumentMeta
        │
② PARAMS PASS  (fast, all curves)
   client batches curves (~30/batch, ~3 concurrent)
        → POST /api/ojip_process_batch   (params only)
        → accumulate paramMatrix[N][~40]
        → progress bar advances per batch; time-series overview draws live
        │
③ OVERVIEW (default view for big files)
   parameter-vs-time charts + virtualized parameter table (all N rows)
        │
④ DETAIL ON DEMAND  (one curve at a time)
   click point/row → POST /api/ojip_process (single, include curves+derivatives)
        → Curves tab renders full transient, editable FJ/FI, refit, diagnostics
        │
⑤ ANNOTATION at scale  (inheritance + bulk + CSV import)
        │
⑥ EXPORT  (params time-series CSV/Parquet + existing XLSX/ZIP bundle), batched
```

Everything in ②, ④, ⑥ is chunked; nothing holds all N heavy arrays at once.

---

## 1b. Integration model — same tool, auto-detected, view forks on curve count

**Not a new analysis type.** Multi-curve support lives inside the existing AquaPen/FluorPen (OJIP) flow. The science is identical whether curves arrive as N separate files or one multi-curve file; a separate tool would duplicate ~90% of parsing/interpretation/annotation/export for no benefit. (Multi-Color PAM / Dual-PAM use a different format and are out of scope for multi-curve.)

**Detection = automatic from file content, but always an explicit, overridable confirmation — never a silent mode switch.**

- Client scans the file on selection; multi-curve iff line index 5 starts with `index\t` **and** has > 2 tab-separated fields (per companion plan §3.1).
- On detection, show a confirmation + the selection modal: *"Multi-curve file detected: 756 OJIP curves"* → user proceeds or cancels. Fluorometer stays **AquaPen**; there is no new dropdown option.
- Keep the companion-plan rule: **block mixing** a multi-curve file with separate single-curve files in one upload.

**The real fork is curve count, not file origin.** Whichever way curves arrived, once `N` is known the UI picks a default view:

| Curve count | Default view | Overlay allowed? |
|-------------|--------------|------------------|
| ≤ ~50 | Classic overlay (Curves tab) | Yes, all |
| > ~50 | Time-series / aggregate (new tab) | Yes, capped + drill-down |

The user can **toggle** between views regardless — a 30-curve multi-curve file may use the aggregate view; 300 single files may use it too. So no code path is gated on "did this come from a multi-curve file"; it's gated on count.

---

## 2. Stage 1 — Client orchestrator (batched params pass)

**File:** `website/static/js_OJIP.js` (new module section, ~250 lines)

### 2.1 In-memory model after parse

```js
// Produced by the client-side multi-curve parser (companion plan §3.1)
const dataset = {
  fluorometer: 'Aquapen',
  timeUs: Float64Array,          // 549 pts — shared by ALL curves, sent once per batch
  curves: [                      // one entry per SELECTED curve
    { index: 1, name: '19:44:19 30.4.2026', timestamp: '...', values: Float64Array }
  ],
  instrumentMeta: { flash_wavelength_nm: 455, ... }
};
```

`values` are the raw fluorescence column for that curve. Keeping them as `Float64Array` keeps ~756×549 floats ≈ 3.3 MB in memory — trivial.

### 2.2 Orchestrator

```js
async function runParamsPass(dataset, jipOpts, ui) {
  const BATCH = jipOpts.batchSize ?? 30;      // curves per request
  const CONC  = jipOpts.concurrency ?? 3;     // in-flight requests (≤ web-worker count)
  const batches = chunkArray(dataset.curves, BATCH);

  const paramMatrix = new Array(dataset.curves.length);
  let done = 0;
  const controller = new AbortController();   // for Cancel button
  ui.onCancel(() => controller.abort());

  // Simple concurrency pool
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const b = batches[cursor++];
      const res = await postBatch(b, dataset, jipOpts, controller.signal);
      for (const r of res.results) paramMatrix[r.slot] = r;   // slot = global index
      done += b.length;
      ui.setProgress(done, dataset.curves.length);            // REAL progress
      ui.appendOverviewPoints(res.results);                   // draw incrementally
    }
  }
  await Promise.all(Array.from({length: CONC}, worker));      // fan out
  return paramMatrix;
}
```

Key points:
- **Ordered slots**: each curve carries a global `slot` index so out-of-order batch completions reassemble correctly.
- **Cancellation**: a single `AbortController` aborts all in-flight requests; the Cancel button is always live (no frozen UI).
- **Retry**: wrap `postBatch` in a bounded retry (2 attempts, exponential backoff) for transient PythonAnywhere hiccups; on final failure mark those curves as "errored" (see §7) and keep going — one bad batch must not sink the run.
- **Backpressure**: `CONC` capped at 3 so we never oversubscribe the worker pool or CPU.

### 2.3 Batch request payload

```js
function postBatch(curves, dataset, jipOpts, signal) {
  const body = {
    fluorometer: dataset.fluorometer,
    time_us: Array.from(dataset.timeUs),          // ~549 nums, ~5KB — cheap, keeps server stateless
    curves: curves.map(c => ({ slot: c.slot, name: c.name, values: Array.from(c.values) })),
    FJ_time: jipOpts.FJ_time, FI_time: jipOpts.FI_time,
    knots_reduction_factor: jipOpts.knots,
    include_curves: false                          // PARAMS ONLY on the big pass
  };
  return fetch('/api/ojip_process_batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  }).then(r => r.json());
}
```

> **Tuning:** `BATCH=30`, `CONC=3` is the starting point. On Hacker tier, 756 curves in params-only mode → 26 batches → well under a minute wall-clock. Expose both as constants; tune against real timings (§9).

---

## 3. Stage 2 — Server batch endpoint

**File:** `website/OJIP_data_analysis.py` (new route + refactor, ~120 lines)

### 3.1 Refactor: extract the single-curve core

Pull the existing per-curve math out of `ojip_process` into a pure function so it can be called from both the single and batch routes with **no behavioral change**:

```python
def analyze_one_curve(time_us, values, fj_time, fi_time, knots_reduction_factor,
                      include_curves=False):
    """Existing pipeline for ONE curve. Returns a dict.
    - Always: JIP params (F0, FM, FJ, FI, FV, VJ, VI, M0, Phi_Po, Psi_o, Phi_Eo,
      Phi_Do, PI_abs, ABS/RC, TRo/RC, ETo/RC, DIo/RC, Sm, Ss, N, areas O-J/J-I/I-P/O-P, ...).
    - If include_curves: also normalized transients (4 modes), 1st/2nd derivatives,
      FJ/FI detection arrays, polynomial fits — the heavy payload.
    """
    # ... verbatim spline fit / derivatives / area / JIP logic currently in ojip_process ...
    return result
```

`ojip_process` (single/legacy path) becomes a thin wrapper calling `analyze_one_curve(..., include_curves=True)`.

### 3.2 New route

```python
@app.route('/api/ojip_process_batch', methods=['POST'])
def ojip_process_batch():
    payload = request.get_json(force=True)
    time_us   = np.asarray(payload['time_us'], dtype=float)
    fj, fi    = payload.get('FJ_time'), payload.get('FI_time')
    krf       = payload.get('knots_reduction_factor')
    include   = bool(payload.get('include_curves', False))
    curves    = payload['curves']            # [{slot, name, values}]

    results = []
    for c in curves:
        try:
            r = analyze_one_curve(time_us, np.asarray(c['values'], float),
                                  fj, fi, krf, include_curves=include)
            r['slot'], r['name'] = c['slot'], c['name']
            results.append(r)
        except Exception as e:                # one bad curve must not fail the batch
            results.append({'slot': c['slot'], 'name': c['name'],
                            'error': str(e)})

    resp = jsonify({'status': 'success', 'results': results})
    return resp                              # see §3.4 for gzip
```

### 3.3 Optional in-request parallelism (later tuning knob)

If wall-clock needs improvement beyond browser fan-out, parallelize *within* a batch. **Prefer** browser concurrency first (§2.2) because it uses PythonAnywhere's real worker pool and avoids fork pitfalls. If you add server-side parallelism, use a module-level pool guarded for PythonAnywhere:

```python
from concurrent.futures import ProcessPoolExecutor
import os
_POOL = None
def _pool():
    global _POOL
    if _POOL is None:
        _POOL = ProcessPoolExecutor(max_workers=min(4, os.cpu_count() or 2))
    return _POOL
# Fallback to serial if the platform refuses to spawn processes.
```

> ⚠️ Validate `ProcessPoolExecutor` actually works inside a PythonAnywhere web worker before depending on it — process spawning is sometimes restricted. Chunking + browser concurrency already solves the timeout problem without it.

### 3.4 Transfer efficiency

- **Enable gzip** on batch responses (Flask-Compress, or PythonAnywhere/static compression). Params JSON compresses ~5–8×.
- **Time axis sent once per batch, never per curve** in the response (it's identical and client already has it).
- **Params-only responses are small**: ~40 floats × 30 curves ≈ a few KB/batch. This is why the big pass is fast.
- Heavy transient/derivative arrays travel **only** in `include_curves=true` single-curve fetches (Stage 4).

---

## 4. Stage 3 — Frontend reframe: time-series overview

**Files:** `website/templates/OJIP_analysis.html` (new tab), `website/static/js_OJIP.js` (charts + virtual table)

For a 700-curve run, the default landing view is **not** the overlaid Curves tab. Add a **"Time-series" tab** (becomes the default when a multi-curve dataset with > ~50 curves is loaded).

### 4.1 Parameter-over-time chart

- X = timestamp (from file row 7) or measurement index; Y = a selected JIP parameter.
- One line, all N points — fast because it's a single series, not N transients.
- Parameter picker (multi-select) to overlay a few normalized parameters (Fv/Fm, PI_abs, VJ, VI, ABS/RC…). Dual Y-axis or per-parameter small-multiples.
- Draws **incrementally** as batches complete (`ui.appendOverviewPoints`).
- Apply **Chart.js decimation plugin** (`lttb`) when N is large so the canvas stays smooth.
- Click a point → opens that curve in the Curves tab (Stage 4 detail fetch).

### 4.2 Virtualized parameter table

- All N rows × ~40 params, but **only visible rows are in the DOM** (windowing: render ~40 rows + spacer padding; recycle on scroll). A tiny custom virtual scroller or a light lib — no framework needed.
- Sortable by any parameter, filterable by group/time-window, row-click → detail.
- CSV/clipboard copy of the full (non-virtualized) matrix for quick export.

### 4.3 Existing tabs, adapted

- **Curves tab** → shows **one** curve at a time (from detail fetch) with the full editable FJ/FI workflow, refit, 4 normalization modes. Multi-overlay allowed but capped (e.g. ≤ 20 user-picked curves) with decimation.
- **Parameters / Diagnostics / Interpretation** → operate on the current curve or the current group; unchanged logic.
- **Groups & Averages** → gains time-window / time-of-day / prefix grouping (see §5.2); mean±SD computed client-side from the param matrix, or via a small batched averaging call for transients.

### 4.4 Plotting raw curves at scale — aggregate, don't overlay

Overlaying up to 2000 curves × 549 pts × 4 normalization modes is both expensive **and** visually useless (spaghetti). The fix is to stop equating "plot the curves" with "draw N lines." **Overlay becomes the exception; aggregate representations are the default.** All modes derive from the raw values already in browser memory (~3 MB for 756) plus F0/FM from the params pass — so **no server round-trip and no storing 4 normalization copies × N curves.**

The Curves tab (and any transient view) gets a **render-mode switch**:

**(a) Median + percentile band — default.** All curves share the *exact same 549-point time grid*, so per-time-point percentiles are trivial and fast. Draw median line + shaded 25–75% and 10–90% bands, per normalization mode, optionally split/colored by group. One filled area + one line → renders instantly at any N, publication-friendly. This replaces "overlay everything" as the thing you see first.

**(b) Curve-density heatmap.** Bin the (log-time × fluorescence) plane; color = number of curves through each cell. Draw directly to `<canvas>` via `ImageData` → **fixed cost regardless of N** (2000 curves as cheap as 50). Reveals the envelope + where the bulk of curves lie, which spaghetti hides.

**(c) Evolution raster — the monitoring view (best for the "trend over days" goal).** X = time *within* the transient (log), Y = measurement time (the N measurements), color = normalized fluorescence. The whole dataset becomes one image; the drift of transient shape over the 11-day run is directly visible. Cheap canvas raster.

Then two "inspect individuals" modes:

**(d) Overlay (capped + paged).** ≤ ~50 traces at once (user-selected or subsampled), Chart.js **LTTB decimation** on points, pageable: *"showing 50 of 756 → next 50."* This is the familiar overlay, made safe.

**(e) Small multiples.** Faceted by **group / day / treatment** (not arbitrary chunks), ~25 curves per mini-plot. Meaningful panels beat 40 arbitrary ones. This is the "split into ~50-curve plots" idea, made useful by grouping.

Drill-down from any mode: click → single-curve full detail (§5).

**Rendering tech:** bands = one filled area + one line (SVG/canvas, trivial). Heatmap/raster = direct `<canvas>` `ImageData` (fixed cost, no per-point objects). Reserve Chart.js line rendering for the ≤50-curve overlay/small-multiple cases only — it degrades past a few thousand points.

**Memory:** never materialize 4 normalization modes × derivatives × N. Bands/heatmaps are computed on demand from raw values + params; derivatives are fetched lazily only for the drilled-in curve.

### 4.5 Diagnostics at scale — reduce to scalar-per-curve, then trend it

Diagnostics (O-J region, J-I region, K-step presence) are per-curve *scalar features*, not curves. At scale, **don't draw N diagnostic plots** — reduce each to a number/flag per curve and show its **distribution or time-series**:

- **K-step** → amplitude/boolean per curve → time-series across the run + summary badge ("K-step detected in 34 / 756") + flag column in the virtualized table.
- **O-J / J-I region metrics** → scalar per curve → histogram + time-series; outliers are clickable → drill to that curve's classic diagnostic.
- **Difference kinetics (WOJ, WOK, ΔV)** that diagnostics build on → shown as **median±band or density heatmap** across all curves (per §4.4), with the classic per-curve diagnostic on drill-down.

Unifying rule for any "many curves" panel: **(1) aggregate view (band / heatmap / raster) to see all at once → (2) scalar-per-curve reduction plotted as time-series/histogram to spot outliers over time → (3) click to drill into an individual curve.** Splitting into ~50-curve plots is offered (§4.4e) but as a secondary grouped mode, not the primary answer.

---

## 5. Stage 4 — Detail on demand + refit

- Clicking a point/row calls the **existing** `/api/ojip_process` (or `/api/ojip_process_batch` with `include_curves:true` and a single curve) to get the heavy arrays for just that curve.
- Cache the last ~10 fetched detailed curves in a client LRU so revisiting is instant; never hold all N heavy arrays.
- `/api/ojip_refit` is unchanged — it already operates per-curve on demand.
- Editable FJ/FI live recalculation stays exactly as today, scoped to the open curve.

---

## 6. Stage 5 — Annotation at scale

**Files:** `website/fluorescence_annotation.py`, `website/static/js_fluorescence_annotation.js`, annotation tab in `OJIP_analysis.html`

Hand-annotating 700 curves is the real UX cliff. Model = **inheritance + bulk + import**, with per-curve override always possible.

### 6.1 Inheritance (fill once, applies to all)

- **Investigation / Study / Fluorometer** tiers entered once → inherited by every curve. No change to the MIAPPE schema; just don't require per-curve entry of tier-level fields.
- **Per-curve tier auto-populated at ingest** from the file: `timestamp` (row 7), `protocol id` (row 8), FLASH/SUPER/ACTINIC settings (footer), background `Bckg`. Zero typing for these on all N curves.

### 6.2 Bulk assignment

- **By range**: "curves 1–96 → treatment=control". 
- **By time-window**: "everything before 2026-05-05 08:00 → phase=pre". Uses the parsed timestamps.
- **By selection**: multi-select rows in the virtualized table, set a field, apply to selection.
- Implemented as a client-side "assignment rules" list applied over the per-curve annotation objects; server just stores the resolved values in the bundle.

### 6.3 CSV / treatment-log import (most realistic for monitoring runs)

- User uploads a CSV keyed by **index** or **timestamp**; columns map to annotation fields (treatment, replicate, leaf age, watering status, …).
- Client joins CSV rows onto curves (fuzzy timestamp match within tolerance, or exact index), previews the mapping, then applies. This is how a real 11-day experiment log gets attached without manual entry.

### 6.4 Bulk grid editor

- The virtualized parameter table gains editable annotation columns with **fill-down** and **paste-from-Excel** (paste a column block → fills the selected rows). Complements CSV import for quick manual edits.

### 6.5 Bundle export

- `/api/fluorescence_annotation/export` gains **batching**: assemble the Parquet/JSON bundle in chunks (stream rows into the Parquet writer) so a 700-row bundle never materializes fully in RAM at once. Manifest + provenance unchanged.

---

## 7. Stage 6 — Results export at scale

### 7.1 Why the current XLSX doesn't scale

Inspecting `ojip_02-050-08_summary.xlsx` (8 curves) shows the layout and exactly where it breaks:

| Sheet(s) | Layout | Scales to 2000? |
|----------|--------|-----------------|
| **Parameters** | 1 row per curve × ~45 param cols (`A1:AS{n+1}`) | ✅ Yes — 2000 rows × 45 cols is trivial |
| **OJIP_raw, _to_zero, _to_max, _norm, _reconstructed, 1st/2nd_derivatives, Residuals** (8 sheets) | 549 time-rows × **N curve-columns** | ❌ No — 549 × 2001 × 8 sheets ≈ **8.8M cells**; ~50–150 MB file, slow/failed openpyxl build (RAM), slow to open |
| **Charts** | **one embedded JPEG per curve** (+ a few summaries) | ❌ No — 2000 images = hundreds of MB / GB; catastrophic |
| **Methods** | static text | ✅ Yes |

Two hard blockers: **wide per-curve transient sheets** and **per-curve chart images**. Also Excel's ceilings (16,384 cols / 1,048,576 rows) make a *long*-format transient dump (549×2000 = 1.1M rows) overflow a single sheet, while the *wide* format is technically legal but Excel-hostile. And building any of it all-in-memory on PythonAnywhere will OOM.

### 7.2 Principle: tiered, opt-in export — Excel for summaries, Parquet/CSV for bulk

Don't force a full transient dump. Offer **export profiles**, defaulting to the small one for big datasets:

| Profile | Contents | Format | Default for |
|---------|----------|--------|-------------|
| **Summary** | Parameters (all curves) + **parameter-vs-time** sheet + a few **aggregate figures** (band / evolution raster / param-trend) + Methods | single **XLSX** | N > ~50 |
| **Summary + aggregate curves** | above + per-group median/percentile band curves (a handful of columns, not per-curve) | XLSX | opt-in |
| **Full / ML** | Parameters + **all transients & derivatives** (raw, 3 norms, reconstructed, 1st/2nd deriv, residuals) + resolved annotations | **ZIP of Parquet (or CSV) parts** + `summary.xlsx` + `manifest.json` | opt-in |

Key moves that make this scale:

1. **Parameters stay in XLSX** — the row-per-curve layout already scales to 2000; keep it, add `timestamp` + instrument-setting + resolved-annotation columns.
2. **Bulk transients leave Excel.** For large N, per-matrix **Parquet** (columnar, compact, ML-native) or CSV inside a ZIP — *not* embedded sheets. One file per matrix (`raw.parquet`, `norm.parquet`, `deriv1.parquet`, …), tidy long form `(curve_id, time_us, value)` or wide `(time_us, curve_1…curve_N)` per the ML consumer's preference (§7.4).
3. **No per-curve chart images.** Replace 2000 images with a **fixed set of aggregate figures** (band plot, evolution raster, param-vs-time) rendered once regardless of N; optionally embed per-curve charts only for a user-selected subset (≤ ~20).
4. **Never build the whole thing in RAM.** See §7.3.

### 7.3 Generation strategy — chunked / streamed, prefer client-side

- **Summary profile → build client-side.** The browser already holds the param matrix and (for the Summary profile) needs no transients. Generate the Parameters + param-vs-time as CSV in-browser instantly, or a small XLSX via a JS writer — **zero server RAM, zero upload, works even under the IT upload-blocking constraint.** Aggregate figures are the same canvas renders from §4.4 exported as PNG.
- **Full/ML profile → streamed server ZIP.** Transients for all curves aren't held client-side, so run the batched `include_curves` pass (§2/§5) and **stream each batch's rows straight into the Parquet/CSV writer and into the ZIP**, flushing per batch. Peak RAM stays at one batch, never the whole matrix. Progress uses the same real-progress bar (§8).
- **If staying in XLSX for mid-size N**, use **`xlsxwriter` in `constant_memory=True`** mode (writes row-by-row, releasing each row) instead of openpyxl's in-memory model — the difference between finishing and OOM on PythonAnywhere.
- **`/api/ojip_add_charts`** (current XLSX builder) becomes profile-aware: it serves the Summary XLSX and delegates bulk transients to the streamed ZIP path; it must **not** attempt the wide 8-sheet dump above the cap.

### 7.4 ML export specifics (primary goal #2)

- **Tidy Parquet** is the target: one row per curve, columns = all JIP params + `timestamp` + instrument settings + resolved annotations; plus optional companion transient files. Deterministic column order + `manifest.json` (schema, units, provenance, tool version) so the ML side can rely on it.
- Reuses the annotation resolution from §6 so treatment/replicate/etc. travel with every row.
- This subsumes and unifies with the annotation **bundle export** (§6.5) — same streamed-Parquet machinery, one code path.

### 7.5 Export decision summary

> **Excel is for the parameter summary + a few aggregate figures. Bulk per-curve transients go to Parquet/CSV in a ZIP, generated by streaming one batch at a time. The Summary profile is built entirely in the browser. Nothing ever materializes 2000 curves' worth of cells or images in one place.**

---

## 8. Cross-cutting: progress, errors, memory, cap

- **Progress UX**: single top-level determinate bar ("Analyzing 480 / 756 curves"), plus per-panel skeleton/placeholder states. **No modal spinner that blocks interaction.** Overview chart + table fill live. Cancel button always responsive.
- **Error isolation**: per-curve `try/except` on the server; per-batch retry on the client. Errored curves are flagged in the table (badge + reason) and excluded from averages/export, run continues.
- **Memory**: client holds param matrix (tiny) + raw values (~3 MB) + LRU of ≤10 detailed curves. Server holds only the current batch. Nothing scales to "all heavy arrays at once."
- **Cap decision (you asked me to decide):** **compute JIP parameters for ALL curves** (cheap, batched — 756 is trivial). Raise the hard cap to **2000** with a soft warning above ~1000. For any *overlaid transient plot*, cap simultaneous traces (~20) and decimate. So: full analysis of everything, smart limits only on simultaneous heavy visualization.

---

## 9. Milestones (ship order)

1. **M1 — Batch backend**: extract `analyze_one_curve`, add `/api/ojip_process_batch` (params-only), gzip. Unit-test parity vs. single path on 5 curves from `1580.txt`.
2. **M2 — Client orchestrator**: batching + concurrency + real progress + cancel + retry. Wire to the existing selection modal; remove the 100 cap → 2000.
3. **M3 — Time-series tab**: param-vs-time chart (incremental) + virtualized table + click-to-detail. Make it the default for large datasets.
4. **M4 — Detail-on-demand**: single-curve `include_curves` fetch + LRU; Curves/Parameters/Diagnostics/Interpretation scoped to current curve.
5. **M5 — Annotation at scale**: inheritance + auto-fill + range/time-window/selection bulk + CSV import + fill-down grid; batched bundle export.
6. **M6 — Export at scale**: profile-aware export — Summary XLSX built client-side; Full/ML profile streamed as Parquet/CSV ZIP one batch at a time; `xlsxwriter constant_memory`; aggregate figures instead of per-curve images; `manifest.json`. Make `/api/ojip_add_charts` profile-aware and cap-safe.

M1–M3 deliver the headline win (all 700 analyzed, live time-series, nothing frozen) and are demo-ready first.

---

## 10. File-by-file change list

| File | Change | Est. |
|------|--------|------|
| `website/OJIP_data_analysis.py` | Extract `analyze_one_curve()`; add `/api/ojip_process_batch`; params-only vs `include_curves`; gzip; optional pool (guarded); **profile-aware + streamed export, `xlsxwriter constant_memory`, cap-safe `ojip_add_charts`** | ~180 lines |
| `website/static/js_OJIP.js` | Client-side **full-matrix** parse→memory model; orchestrator (batch/concurrency/progress/cancel/retry); time-series chart (incremental + decimation); band/heatmap/raster canvas renders; virtualized table; detail LRU; **client-side Summary export (CSV/XLSX/figures)** | ~550 lines |
| `website/templates/OJIP_analysis.html` | New **Time-series** tab; selection modal cap 100→2000; annotation bulk/CSV UI; progress bar + cancel | ~150 lines |
| `website/fluorescence_annotation.py` | Inheritance resolution; bulk-rule application; CSV-log join; chunked/streamed bundle writer | ~120 lines |
| `website/static/js_fluorescence_annotation.js` | Bulk assignment UI, CSV import + preview, fill-down/paste grid | ~180 lines |

**Unchanged science:** spline fitting, derivatives, polynomial inflection, FJ/FI detection, all JIP params, areas, interpretation engine, refit, XLSX export — reused verbatim through `analyze_one_curve`.

---

## 11. Test plan (using `1580.txt`)

1. **Parity**: params from batch path == single path for 10 sampled curves (tolerance 1e-9).
2. **Load**: full 756-curve params pass — assert < 60 s wall-clock on Hacker tier, UI interactive throughout, progress monotonic, cancel works mid-run.
3. **Timeout safety**: confirm no single request exceeds ~10 s (batch of 30 params-only).
4. **Memory**: peak client heap < ~50 MB; server RSS stable across batches.
5. **Error isolation**: inject a NaN-filled curve → flagged, run completes.
6. **Detail**: click 20 random points → each loads full transient < 2 s, LRU caps at 10.
7. **Export — Summary**: 756-curve Summary XLSX/CSV built **client-side** in < 3 s, no server call; opens in Excel; params match the table.
8. **Export — Full/ML**: 756-curve Parquet ZIP streamed with stable server RSS; row count = curves × timepoints; opens in pandas; `manifest.json` schema valid.
9. **Export — cap safety**: attempting the legacy wide 8-sheet transient dump above the cap is refused with a clear message pointing to the ZIP profile.
7. **Annotation**: inherit study tier + CSV-join a 756-row log by timestamp → all curves annotated, spot-check 5.
8. **Export**: tidy Parquet has 756 rows, correct schema, opens in pandas.
