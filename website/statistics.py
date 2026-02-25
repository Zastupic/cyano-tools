from flask import Blueprint, render_template, request, jsonify, send_file
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as patches # Required for Ellipse
import matplotlib.transforms as transforms # Required for Ellipse rotation
import seaborn as sns
import io
import base64
import traceback
import math
import itertools
from collections import defaultdict
from openpyxl import Workbook
from openpyxl.drawing.image import Image as XLImage
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from scipy import stats
from scipy.stats import norm as norm_dist
from statsmodels.formula.api import ols
import statsmodels.api as sm
from statsmodels.stats.multicomp import pairwise_tukeyhsd, MultiComparison
from statsmodels.stats.multitest import multipletests
from itertools import combinations
from typing import Any

stats_bp = Blueprint('statistics', __name__)

MAX_DATA_ROWS = 100
MAX_DATA_COLUMNS = 50

def _validate_data_limits(data):
    """Validate data does not exceed row/column limits. Returns (True, None) or (False, error_message)."""
    if not data:
        return True, None
    rows = len(data)
    first = data[0]
    cols = len(first) if isinstance(first, (dict, list, tuple)) else 0
    if rows > MAX_DATA_ROWS:
        return False, f"Data exceeds maximum allowed rows ({MAX_DATA_ROWS}). Your data has {rows} rows. Please reduce the dataset."
    if cols > MAX_DATA_COLUMNS:
        return False, f"Data exceeds maximum allowed columns ({MAX_DATA_COLUMNS}). Your data has {cols} columns. Please reduce the dataset."
    return True, None

def _outlier_mask_15iqr(series):
    """Return a boolean array: True where value is outside 1.5×IQR from the box (standard boxplot rule)."""
    q1, q3 = np.quantile(series.dropna(), np.array([0.25, 0.75]))
    iqr = q3 - q1
    if iqr <= 0:
        return pd.Series(False, index=series.index)
    lower = q1 - 1.5 * iqr
    upper = q3 + 1.5 * iqr
    return (series < lower) | (series > upper)


def _box_stats_per_group(clean_df, group_col, value_col):
    """Return list of {group, q1, q3, median, lowerfence, upperfence} using 1.5×IQR rule (same as _outlier_mask_15iqr).
    Fences are exactly Q1 - 1.5*IQR and Q3 + 1.5*IQR so Plotly whiskers match backend outlier logic."""
    out = []
    for grp, sub in clean_df.groupby(group_col, sort=False):
        vals = sub[value_col].dropna()
        if len(vals) == 0:
            continue
        q1, median, q3 = np.quantile(vals, np.array([0.25, 0.5, 0.75]))
        q1, median, q3 = float(q1), float(median), float(q3)
        iqr = q3 - q1
        if iqr <= 0:
            lowerfence = upperfence = median
        else:
            lowerfence = q1 - 1.5 * iqr
            upperfence = q3 + 1.5 * iqr
        out.append({
            "group": str(grp),
            "q1": q1,
            "q3": q3,
            "median": median,
            "lowerfence": lowerfence,
            "upperfence": upperfence,
        })
    return out

def _build_plot_data(clean_df, group_col, value_col, row_id_col="row_id"):
    """Build list of {group, value, row_id, factor_label, is_outlier} for frontend hover. Outliers = outside 1.5×IQR per group."""
    if row_id_col not in clean_df.columns:
        clean_df = clean_df.copy()
        clean_df[row_id_col] = np.arange(1, len(clean_df) + 1)
    plot_data = []
    for grp, sub in clean_df.groupby(group_col, sort=False):
        vals = sub[value_col]
        outlier = _outlier_mask_15iqr(vals)
        factor_label = str(grp)
        for idx in sub.index:
            row = sub.loc[idx]
            rid = row[row_id_col] if row_id_col in row.index else idx
            if pd.isna(rid):
                rid = int(idx) if isinstance(idx, (int, np.integer)) else idx
            plot_data.append({
                "group": str(grp),
                "value": float(row[value_col]),
                "row_id": int(rid),
                "factor_label": factor_label,
                "is_outlier": bool(outlier.iloc[sub.index.get_loc(idx)]) if idx in sub.index else False,
            })
    return plot_data

def _sanitize(obj):
    """Replace NaN/Inf with None so JSON serialization succeeds."""
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize(v) for v in obj]
    if isinstance(obj, float):
        if obj != obj or obj == float('inf') or obj == float('-inf'):
            return None
        return obj
    if isinstance(obj, (np.floating, np.integer)):
        v = float(obj)
        if v != v or v == float('inf') or v == float('-inf'):
            return None
        return v
    return obj

def get_plot_base64():
    img = io.BytesIO()
    plt.savefig(img, format='png', bbox_inches='tight', dpi=150)
    img.seek(0)
    plt.close()
    return base64.b64encode(img.getvalue()).decode('utf-8')


# ── Shared openpyxl helpers ───────────────────────────────────────────────────
_XL_HDR_FONT   = Font(bold=True, color='FFFFFF', size=10)
_XL_THIN_BORDER = Border(
    left=Side(style='thin'), right=Side(style='thin'),
    top=Side(style='thin'),  bottom=Side(style='thin'),
)
_XL_CENTER_AL = Alignment(horizontal='center', vertical='center', wrap_text=True)
_XL_FILLS = {
    'blue':   PatternFill('solid', fgColor='2563EB'),
    'green':  PatternFill('solid', fgColor='16A34A'),
    'orange': PatternFill('solid', fgColor='D97706'),
    'purple': PatternFill('solid', fgColor='7C3AED'),
    'teal':   PatternFill('solid', fgColor='0F766E'),
    'grey':   PatternFill('solid', fgColor='374151'),
    'note':   PatternFill('solid', fgColor='FEF9C3'),
    'pass':   PatternFill('solid', fgColor='DCFCE7'),
    'fail':   PatternFill('solid', fgColor='FEE2E2'),
    'light':  PatternFill('solid', fgColor='F3F4F6'),
}

def _xl_auto_width(ws, max_w=45):
    """Auto-fit column widths (openpyxl worksheet)."""
    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = max((len(str(c.value or '')) for c in col), default=0)
        ws.column_dimensions[col_letter].width = min(max_len + 4, max_w)

def _xl_style_header(ws, row_num, fill):
    """Apply bold white header style to a row."""
    for cell in ws[row_num]:
        cell.font  = _XL_HDR_FONT
        cell.fill  = fill
        cell.alignment = _XL_CENTER_AL
        cell.border = _XL_THIN_BORDER

def _xl_border_row(ws, row_num, n_cols):
    """Apply thin border to n_cols cells in a row."""
    for c in range(1, n_cols + 1):
        ws.cell(row_num, c).border = _XL_THIN_BORDER

def _xl_add_image(ws, img_b64, cell_addr):
    """Decode base64 PNG and add to worksheet at cell_addr. Returns True on success."""
    try:
        img_bytes = base64.b64decode(img_b64)
        xl_img = XLImage(io.BytesIO(img_bytes))
        ws.add_image(xl_img, cell_addr)
        return True
    except Exception:
        return False
# ─────────────────────────────────────────────────────────────────────────────

@stats_bp.route('/statistics', methods=['GET'])
def statistics_page():
    return render_template("statistics.html") # type: ignore

@stats_bp.route('/run-tests', methods=['POST'])
def run_tests():
    try:
        request_data = request.get_json()
        data = request_data.get('data', [])
        ok, err = _validate_data_limits(data)
        if not ok:
            return jsonify({"error": err}), 400
        df = pd.DataFrame(data)
        factors = request_data.get('factors', [])
        selected_vars = request_data.get('target_columns', [])

        test_results = []

        for var in selected_vars:
            temp_df = df.copy()
            temp_df[var] = pd.to_numeric(temp_df[var], errors='coerce')
            clean_df = temp_df.dropna(subset=[var]).copy()

            if clean_df.empty: continue

            # 1. Prepare Group Labels
            if factors:
                for f in factors:
                    clean_df[f] = clean_df[f].astype(str).replace(['nan', 'None'], "N/A")
                clean_df['Group'] = clean_df[factors].agg(' | '.join, axis=1)
            else:
                clean_df['Group'] = 'All Data'

            # 2. Pre-calculate Normality for Plot Coloring
            normality_status = {}
            group_data = []
            shapiro_results = []

            # Use the order of appearance from the original data
            unique_groups = clean_df['Group'].unique().tolist()

            for g_name in unique_groups:
                # Change 'data' to 'group_vals'
                group_vals = clean_df[clean_df['Group'] == g_name][var].astype(float)
                if len(group_vals) >= 3:
                    stat, p = stats.shapiro(group_vals)
                    is_normal = bool(p > 0.05)
                    normality_status[g_name] = is_normal
                    group_data.append(group_vals.values) # Use group_vals
                    shapiro_results.append({
                        "group": g_name, "stat": float(stat), "p": float(p), "is_normal": is_normal
                    })
                else:
                    normality_status[g_name] = True

            # 3. Calculate Levene's Test
            l_stat, l_p, is_homo = None, None, None
            if len(group_data) > 1:
                l_stat, l_p = stats.levene(*group_data)
                is_homo = bool(l_p > 0.05)

            # 4. Generate Enhanced Plot
            plt.figure(figsize=(10, 6))
            sns.set_style("whitegrid")

            # Color palette: Green if Normal, Red/Salmon if Non-Normal
            palette = {grp: ("#A1D99B" if normality_status.get(grp, True) else "#F7969E")
                       for grp in unique_groups}

            ax = sns.boxplot(data=clean_df, x='Group', y=var, order=unique_groups,
                             palette=palette, showfliers=False, linewidth=1.5)
            sns.stripplot(data=clean_df, x='Group', y=var, order=unique_groups,
                          color=".25", size=4, alpha=0.5)

            # Add Assumption Text Box inside the plot
            info_text = f"ASSUMPTIONS CHECK:\n"
            if l_p is not None:
                info_text += f"Var. Homogeneity (Levene) p: {l_p:.4f} ({'PASS' if is_homo else 'FAIL'})\n"
            info_text += "Colors: Green = Normal | Red = Non-Normal"

            # Place text box in the upper left/right
            plt.text(0.02, 0.95, info_text, transform=ax.transAxes, fontsize=9,
                     verticalalignment='top', bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))

            plt.title(f"Assumptions Analysis: {var}", fontsize=14, fontweight='bold', pad=20)
            plt.xticks(rotation=30, ha='right')
            plt.tight_layout()

            plot_url = get_plot_base64()
            plot_data = _build_plot_data(clean_df, "Group", var)

            # 5. One-way ANOVA residuals for diagnostic plots (data only, no images)
            residuals_data = []
            if 'row_id' not in clean_df.columns:
                clean_df = clean_df.copy()
                clean_df['row_id'] = np.arange(1, len(clean_df) + 1)
            n_vals = len(clean_df)
            if n_vals >= 2 and len(unique_groups) >= 1:
                try:
                    model = ols(f"Q('{var}') ~ C(Group)", data=clean_df).fit()
                    fitted = model.fittedvalues
                    resid = model.resid
                    res_std = float(np.std(resid, ddof=1))
                    if res_std <= 0:
                        res_std = 1.0
                    std_residual = resid / res_std
                    # Ranks for theoretical quantiles (rank 1..n by sorted std_residual)
                    order = np.argsort(std_residual.values)
                    rank_of_index = np.empty(len(order), dtype=float)
                    rank_of_index[order] = np.arange(1, len(order) + 1)
                    for i in range(len(clean_df)):
                        row = clean_df.iloc[i]
                        rid = row['row_id'] if 'row_id' in row.index else i + 1
                        if pd.isna(rid):
                            rid = int(i + 1)
                        r_rank = rank_of_index[i]
                        theoretical_quantile = float(norm_dist.ppf((r_rank - 0.5) / n_vals))
                        residuals_data.append({
                            "row_id": int(rid),
                            "fitted": float(fitted.iloc[i]),
                            "residual": float(resid.iloc[i]),
                            "std_residual": float(std_residual.iloc[i]),
                            "theoretical_quantile": theoretical_quantile,
                            "group": str(row['Group']),
                        })
                except Exception:
                    pass

            box_stats = _box_stats_per_group(clean_df, "Group", var)
            result_entry = {
                "variable": var,
                "plot_url": plot_url,
                "plot_data": plot_data,
                "box_stats": box_stats,
                "shapiro": shapiro_results,
                "levene": {"stat": float(l_stat) if l_stat else None,
                           "p": float(l_p) if l_p else None,
                           "is_homogeneous": is_homo}
            }
            if residuals_data:
                result_entry["residuals_data"] = residuals_data
            test_results.append(result_entry)

        return jsonify({"results": _sanitize(test_results)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@stats_bp.route('/run-statistics', methods=['POST'])
def run_analysis():
    try:
        request_data = request.get_json()
        data = request_data.get('data', [])
        ok, err = _validate_data_limits(data)
        if not ok:
            return jsonify({"error": err}), 400
        df = pd.DataFrame(data)
        factors = request_data.get('factors', [])
        selected_vars = request_data.get('target_columns', [])

        if not selected_vars:
            cols = [c for c in df.columns.tolist() if c != "row_id"]
            return jsonify({
                "all_columns": cols,
                "variables": cols
            })

        results = []
        for var in selected_vars:
            keep_cols = [c for c in factors + [var] if c in df.columns]
            if "row_id" in df.columns:
                keep_cols = ["row_id"] + [c for c in keep_cols if c != "row_id"]
            temp_df = df[keep_cols].copy()
            temp_df[var] = pd.to_numeric(temp_df[var], errors='coerce')
            clean_df = temp_df.dropna(subset=[var]).copy()

            # Also drop rows where any factor is empty/NaN
            if factors:
                clean_df = clean_df.dropna(subset=factors).copy()
                clean_df = clean_df[~clean_df[factors].isin(['', 'nan', 'None', 'NaN']).any(axis=1)].copy()

            if clean_df.empty:
                continue

            # 1. Numeric Sorting for all factors
            if factors:
                sort_cols = []
                for f in factors:
                    # Create temporary numeric columns for logical sorting
                    clean_df[f + '_sort'] = pd.to_numeric(clean_df[f], errors='coerce')
                    sort_cols.append(f + '_sort')

                clean_df = clean_df.sort_values(by=sort_cols)

                # Convert original factors to string for display
                for f in factors:
                    clean_df[f] = clean_df[f].astype(str).replace(['nan', 'None'], "N/A")

            # 2. CREATE COMBINED FACTOR FOR HUE (LEGEND)
            # If 3+ factors, combine all except the first one for the legend
            if len(factors) > 1:
                hue_col = " & ".join(factors[1:])
                clean_df[hue_col] = clean_df[factors[1:]].agg(' | '.join, axis=1)
            else:
                hue_col = factors[0] if factors else None

            # Calculate counts per group
            counts = clean_df.groupby(factors)[var].transform('count')
            box_df = clean_df[counts >= 3]

            # Summary Stats (grouped by original factors)
            summary_df = clean_df.groupby(factors)[var].agg(['count', 'mean', 'std']).reset_index()
            summary = summary_df.replace({np.nan: None}).to_dict(orient='records')

            # --- PLOTTING ---
            hue_order = clean_df[hue_col].unique() if hue_col else None

            # 1. Swarm Plot
            g = sns.catplot(
                kind="swarm",
                data=clean_df,
                x=factors[0],
                y=var,
                hue=hue_col,
                hue_order=hue_order,
                dodge=True,
                palette=['#444444'],
                size=5,
                alpha=0.6,
                height=5,
                aspect=1.5,
                legend=False
            )

            # 2. Box Plot Overlay with nipy_spectral
            if not box_df.empty:
                sns.boxplot(
                    data=box_df,
                    x=factors[0],
                    y=var,
                    hue=hue_col,
                    hue_order=hue_order,
                    ax=g.ax,
                    showfliers=False,
                    palette="nipy_spectral",
                    boxprops={'alpha': 0.4},
                    whiskerprops={'alpha': 0.5}
                )

                if hue_col:
                    g.ax.legend(title=hue_col, bbox_to_anchor=(1.05, 1), loc='upper left', frameon=False)

            g.fig.subplots_adjust(top=0.85)
            g.fig.suptitle(f"Visualization of {var} by {', '.join(factors)}", fontsize=12, fontweight='bold')
            g.ax.set_xlabel(factors[0], fontsize=11, fontweight='bold')
            g.ax.set_ylabel(var, fontsize=11, fontweight='bold')

            # Build plot_data by combined group (all factors) so frontend splits by both factors
            if factors:
                clean_df = clean_df.copy()
                clean_df['Group'] = clean_df[factors].agg(' | '.join, axis=1)
                group_col = 'Group'
            else:
                group_col = None
            if group_col:
                plot_data = _build_plot_data(clean_df, group_col, var)
                box_stats = _box_stats_per_group(clean_df, group_col, var)
            else:
                plot_data = []
                box_stats = []
            results.append({
                "variable": var,
                "summary": summary,
                "plot_url": get_plot_base64(),
                "plot_data": plot_data,
                "box_stats": box_stats,
            })
            plt.close('all')

        return jsonify({"mode": "results", "factors": factors, "results": _sanitize(results)})
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@stats_bp.route('/export-excel', methods=['POST'])
def export_excel():
    try:
        request_data = request.get_json()
        results = request_data.get('results', [])
        factors = request_data.get('factors', [])
        # Accept plotly_captures from JS: [{ id: 'plot-viz-0-VarName', image: '<base64>' }]
        plotly_captures = request_data.get('plotly_captures', [])
        # Build a map from plot div id → base64 image for quick lookup
        plotly_map = {pc['id']: pc['image'] for pc in plotly_captures if pc.get('id') and pc.get('image')}

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            for res in results:
                sheet_name = "".join([c for c in str(res['variable']) if c.isalnum() or c==' '])[:31]
                df_var = pd.DataFrame(res['summary'])
                df_var.to_excel(writer, sheet_name=sheet_name, index=False)

                ws = writer.sheets[sheet_name]

                # Prefer the Plotly-captured image; fall back to matplotlib backend plot_url
                img_b64 = None
                if plotly_map:
                    # Match by variable name in the plot div id (e.g. 'plot-viz-0-VarName')
                    safe_var = str(res['variable']).replace(r'\W', '_')
                    for k, v in plotly_map.items():
                        if res['variable'].replace(' ', '_') in k or res['variable'] in k:
                            img_b64 = v
                            break
                if img_b64 is None:
                    img_b64 = res.get('plot_url')

                if img_b64:
                    try:
                        img_data = base64.b64decode(img_b64)
                        img = XLImage(io.BytesIO(img_data))
                        ws.add_image(img, f"A{len(df_var) + 4}")
                    except Exception:
                        pass

            for sheetname in writer.sheets:
                _xl_auto_width(writer.sheets[sheetname])

        output.seek(0)
        return send_file(output, mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                         as_attachment=True, download_name='Box_plots.xlsx')
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def confidence_ellipse(x, y, ax, n_std=2.0, facecolor: Any = 'none', **kwargs):
    """
    Utility to create a covariance confidence ellipse.
    """
    if x.size != y.size:
        raise ValueError("x and y must be the same size")

    cov = np.cov(x, y)
    pearson = cov[0, 1] / np.sqrt(cov[0, 0] * cov[1, 1])

    # Using a special case to obtain the eigenvalues of this two-dimensional dataset.
    ell_radius_x = np.sqrt(1 + pearson)
    ell_radius_y = np.sqrt(1 - pearson)

    ellipse = patches.Ellipse((0, 0), width=ell_radius_x * 2, height=ell_radius_y * 2,
                              facecolor=facecolor, **kwargs)

    # Calculating the standard deviation of x from the squareroot of the variance
    scale_x = np.sqrt(cov[0, 0]) * n_std
    mean_x = np.mean(x)

    # calculating the standard deviation of y ...
    scale_y = np.sqrt(cov[1, 1]) * n_std
    mean_y = np.mean(y)

    transf = transforms.Affine2D().rotate_deg(45).scale(scale_x, scale_y).translate(mean_x, mean_y)
    ellipse.set_transform(transf + ax.transData)
    return ax.add_patch(ellipse)

@stats_bp.route('/run-pca', methods=['POST'])
def run_pca():
    try:
        request_data = request.get_json()
        data = request_data.get('data', [])
        ok, err = _validate_data_limits(data)
        if not ok:
            return jsonify({"error": err}), 400
        df = pd.DataFrame(data)
        factors = request_data.get('factors', [])
        selected_vars = request_data.get('variables', [])

        # Capture preferences
        remove_missing = request_data.get('remove_missing', True)
        average_by_factors = request_data.get('average_by_factors', False)
        plot_loadings = request_data.get('plot_loadings', True)

        # 1. Robust Numeric Cleaning
        clean_df = df.copy()
        for var in selected_vars:
            clean_df[var] = pd.to_numeric(clean_df[var], errors='coerce')

        # Option: Remove Missing Data
        if remove_missing:
            clean_df = clean_df.dropna(subset=selected_vars).copy()

        # Option: Average replicates by factor values
        if average_by_factors and factors:
            # Group by all factors and compute mean of selected variables
            clean_df = clean_df.groupby(factors)[selected_vars].mean().reset_index()

        # Critical Check: Validate dataframe after preparation
        if len(clean_df) < len(selected_vars):
            return jsonify({"error": "Insufficient data points after filtering/averaging."}), 400

        # Drop rows with missing values in the variables being analyzed
        clean_df = clean_df.dropna(subset=selected_vars).copy()

        # Critical Check: Need more samples than variables for stable PCA
        if len(clean_df) < len(selected_vars):
            return jsonify({"error": f"Insufficient data: You need at least {len(selected_vars)} valid rows for this analysis."}), 400

        # 2. Factor Handling
        if factors:
            for f in factors:
                clean_df[f] = clean_df[f].astype(str).replace(['nan', 'None'], "N/A")
            hue_col = " & ".join(factors)
            clean_df[hue_col] = clean_df[factors].agg(' | '.join, axis=1)
        else:
            hue_col = None

        # 3. PCA Calculation
        scaler = StandardScaler()
        scaled_data = scaler.fit_transform(clean_df[selected_vars])
        pca = PCA(n_components=2)
        pca_features = pca.fit_transform(scaled_data)

        clean_df['PC1'] = pca_features[:, 0]
        clean_df['PC2'] = pca_features[:, 1]

        # 4. Visualization
        fig, ax = plt.subplots(figsize=(10, 7))

        if hue_col:
            unique_groups = sorted(clean_df[hue_col].unique())
            palette_colors = sns.color_palette("nipy_spectral", len(unique_groups))
            color_map = dict(zip(unique_groups, palette_colors))

            sns.scatterplot(data=clean_df, x='PC1', y='PC2', hue=hue_col,
                            palette=color_map, s=100, alpha=0.9, ax=ax, zorder=3, edgecolor='white')

            for group in unique_groups:
                group_data = clean_df[clean_df[hue_col] == group]
                # Ensure we have enough points AND variance to draw an ellipse
                if len(group_data) >= 3:
                    try:
                        # Check if points are not all in the exact same spot (zero variance)
                        if group_data['PC1'].std() > 1e-6 and group_data['PC2'].std() > 1e-6:
                            color = color_map[group]
                            confidence_ellipse(
                                group_data['PC1'], group_data['PC2'], ax,
                                n_std=2.0, edgecolor=color, facecolor=color,
                                alpha=0.12, linewidth=1.5, zorder=2
                            )
                    except Exception as ellipse_err:
                        print(f"Skipping ellipse for {group}: {ellipse_err}")
                        continue

            ax.legend(title=hue_col, bbox_to_anchor=(1.05, 1), loc='upper left', frameon=False)
        else:
            sns.scatterplot(data=clean_df, x='PC1', y='PC2', s=100, ax=ax, color='#0984e3')

        # 5. Variable Loadings (Arrows)
        loadings = pca.components_.T * np.sqrt(pca.explained_variance_)

        # Wrap the arrow-drawing logic in an IF statement
        if plot_loadings:
            for i, var in enumerate(selected_vars):
                ax.arrow(0, 0, loadings[i, 0], loadings[i, 1],
                         color='#2d3436', alpha=0.7, head_width=0.08, zorder=4)
                ax.text(loadings[i, 0]*1.15, loadings[i, 1]*1.15, var,
                        color='#d63031', weight='bold', fontsize=10,
                        ha='center', va='center', zorder=5,
                        bbox=dict(facecolor='white', alpha=0.8, edgecolor='none', pad=1))

        # Aesthetics
        ax.set_xlabel(f'PC1 ({pca.explained_variance_ratio_[0]:.1%})', fontsize=11, fontweight='bold')
        ax.set_ylabel(f'PC2 ({pca.explained_variance_ratio_[1]:.1%})', fontsize=11, fontweight='bold')
        ax.set_title('PCA Biplot: Multivariate Score Distribution', fontsize=14, pad=20)
        ax.grid(True, linestyle='--', alpha=0.3)
        ax.axhline(0, color='black', lw=1, alpha=0.2)
        ax.axvline(0, color='black', lw=1, alpha=0.2)

        loadings_list = [{"Variable": var, "PC1_Loading": float(loadings[i, 0]), "PC2_Loading": float(loadings[i, 1])}
                         for i, var in enumerate(selected_vars)]

        return jsonify({
            "plot_url": get_plot_base64(),
            "n_samples": len(clean_df),
            "explained_variance": pca.explained_variance_ratio_.tolist(),
            "loadings": loadings_list,
            "pca_table": clean_df.to_dict(orient='records')
        })
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@stats_bp.route('/export-pca-excel', methods=['POST'])
def export_pca_excel():
    try:
        request_data = request.get_json()
        pca_details = request_data.get('pca_details', {})

        # 1. Create the Main Data Sheet (Original Data + PCA Scores)
        # Coordinates usually contains original data + PC1 + PC2
        df_main = pd.DataFrame(pca_details['coordinates'])

        # 2. Create the Loadings Sheet (The "Arrows" data)
        # We expect the frontend to send 'loadings' which is a list of {var: name, pc1: val, pc2: val}
        loadings_data = pca_details.get('loadings', [])
        df_loadings = pd.DataFrame(loadings_data)

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            # Sheet 1: Results and Plot
            df_main.to_excel(writer, sheet_name='PCA Scores', index=False, startrow=5)
            ws1 = writer.sheets['PCA Scores']
            ws1['A1'] = "PCA Analysis Report"
            ws1['A2'] = f"Number of Samples: {pca_details['n_samples']}"
            ws1['A3'] = f"Explained Variance: PC1 ({pca_details['variance'][0]:.1%}), PC2 ({pca_details['variance'][1]:.1%})"

            # Embed Plot Image
            img_data = base64.b64decode(pca_details['plot_url'])
            img = XLImage(io.BytesIO(img_data))
            ws1.add_image(img, "M1")

            # Sheet 2: Variable Loadings (Arrow Coordinates)
            if not df_loadings.empty:
                df_loadings.to_excel(writer, sheet_name='Variable Loadings', index=False)
                ws2 = writer.sheets['Variable Loadings']
                # Add a note explaining what this is
                ws2.append([])
                ws2.append(["Note: These values represent the 'Arrows' on the Biplot."])
                ws2.append(["They show the correlation of each variable with the Principal Components."])

        output.seek(0)
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name='PCA_Full_Analysis.xlsx'
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@stats_bp.route('/run-anova', methods=['POST'])
def run_anova():
    """
    Main ANOVA handler (v2).
    Supports: One-way ANOVA, Welch's ANOVA, Kruskal-Wallis,
              Two-way ANOVA, Scheirer-Ray-Hare, MANOVA (Pillai's Trace), ART ANOVA.
    Auto-selects test based on factor count + assumption results, with manual override.
    """
    try:
        request_data = request.get_json()
        data = request_data.get('data', [])
        ok, err = _validate_data_limits(data)
        if not ok:
            return jsonify({"error": err}), 400
        df = pd.DataFrame(data)
        factors = request_data.get('factors', [])
        selected_vars = request_data.get('target_columns', [])
        grouping_mode = request_data.get('grouping_mode', 'all_combined')
        manual_override = request_data.get('manual_override', 'auto')

        if not selected_vars or not factors:
            return jsonify({"error": "Missing target_columns or factors"}), 400

        # ── Quick assumption check to drive auto-selection ────────────────────
        all_normal_list = []
        homogeneous_list = []
        for var in selected_vars:
            if var not in df.columns:
                continue
            tmp = df.copy()
            tmp[var] = pd.to_numeric(tmp[var], errors='coerce')
            tmp = tmp.dropna(subset=[var])
            for f in factors:
                tmp[f] = tmp[f].astype(str).replace(['nan', 'None'], 'N/A')
            tmp['_group'] = tmp[factors[0]]
            group_vals = {g: grp[var].astype(float).values
                          for g, grp in tmp.groupby('_group')
                          if len(grp) >= 3}
            if len(group_vals) < 2:
                continue
            norms = [bool(stats.shapiro(v)[1] > 0.05) for v in group_vals.values()]
            all_normal_list.append(all(norms))
            _, lp = stats.levene(*group_vals.values())
            homogeneous_list.append(bool(lp > 0.05))

        all_normal = all(all_normal_list) if all_normal_list else False
        homogeneous = all(homogeneous_list) if homogeneous_list else False
        n_factors = len(factors)

        # ── Grouping-mode override ────────────────────────────────────────────
        # When the user chose 'across:F' or 'per:F|G', the intent is to run
        # a single-factor comparison per slice, regardless of how many factors
        # were selected in the panel.  Force 1-factor test selection so that
        # _run_one_factor_tests (and _anova_build_slices) is used.
        uses_slicing = (n_factors > 1 and
                        (grouping_mode.startswith('across:') or
                         grouping_mode.startswith('per:')))

        # ── Select test ───────────────────────────────────────────────────────
        if manual_override and manual_override != 'auto':
            test_key = manual_override
            test_rationale = f"Manual override: {test_key.replace('_', ' ').title()} selected by user"
            # If the override is a multi-factor test but slicing was requested,
            # fall back to auto 1-factor selection instead.
            if uses_slicing and test_key not in ('one_way_anova', 'welch_anova', 'kruskal_wallis'):
                test_key, test_rationale = _select_test_auto(1, all_normal, homogeneous)
                test_rationale += f' (sliced by grouping mode: {grouping_mode})'
        else:
            eff_n = 1 if uses_slicing else n_factors
            test_key, test_rationale = _select_test_auto(eff_n, all_normal, homogeneous)
            if uses_slicing:
                test_rationale += f' (sliced by grouping mode: {grouping_mode})'

        # ── Dispatch ──────────────────────────────────────────────────────────
        if test_key in ('one_way_anova', 'welch_anova', 'kruskal_wallis'):
            all_results = _run_one_factor_tests(
                df, selected_vars, factors, grouping_mode,
                test_key, all_normal, homogeneous
            )
        elif test_key == 'two_way_anova':
            all_results = _run_two_way_anova(df, selected_vars, factors, all_normal, homogeneous)
        elif test_key == 'scheirer_ray_hare':
            all_results = _run_scheirer_ray_hare(df, selected_vars, factors, all_normal, homogeneous)
        elif test_key == 'manova':
            all_results = _run_manova(df, selected_vars, factors, all_normal, homogeneous)
        elif test_key == 'art_anova':
            all_results = _run_art_anova(df, selected_vars, factors, all_normal, homogeneous)
        else:
            return jsonify({"error": f"Unknown test key: {test_key}"}), 400

        return jsonify(_make_json_safe({
            "results": all_results,
            "test_key": test_key,
            "test_rationale": test_rationale
        }))

    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


# ════════════════════════════════════════════════════════════════════════════════
# ANOVA v2 — HELPER FUNCTIONS
# ════════════════════════════════════════════════════════════════════════════════

def _select_test_auto(n_factors, all_normal, homogeneous):
    """Return (test_key, rationale_str) based on factor count and assumption results."""
    if n_factors == 1:
        if all_normal and homogeneous:
            return 'one_way_anova', 'One-way ANOVA: normality ✓ and homogeneity ✓ both passed'
        elif all_normal and not homogeneous:
            return 'welch_anova', "Welch's ANOVA: normality ✓ passed but homogeneity ✗ failed (heteroscedastic data)"
        else:
            return 'kruskal_wallis', 'Kruskal–Wallis: normality ✗ failed — non-parametric test selected'
    elif n_factors == 2:
        if all_normal and homogeneous:
            return 'two_way_anova', 'Two-way ANOVA: normality ✓ and homogeneity ✓ both passed'
        else:
            return 'scheirer_ray_hare', 'Scheirer–Ray–Hare: assumptions not fully met — non-parametric two-factor test selected'
    else:  # 3+
        if all_normal and homogeneous:
            return 'manova', "MANOVA (Pillai's Trace): normality ✓ and homogeneity ✓ — multivariate test selected"
        else:
            return 'art_anova', 'ART ANOVA (Aligned Rank Transform): assumptions not met — non-parametric multi-factor test selected'


def _bh_correction(p_values):
    """Benjamini-Hochberg FDR correction. Returns adjusted p-values list."""
    n = len(p_values)
    if n == 0:
        return []
    indexed = sorted(enumerate(p_values), key=lambda x: x[1])
    adjusted = [1.0] * n
    prev = 1.0
    for rank, (orig_idx, p) in enumerate(reversed(indexed), 1):
        adj = p * n / (n - rank + 1)
        adj = min(adj, prev)
        prev = adj
        adjusted[orig_idx] = min(adj, 1.0)
    return adjusted


def _dunns_test_bh(groups_dict):
    """
    Dunn (1964) pairwise post-hoc for Kruskal-Wallis, with Benjamini-Hochberg correction.
    groups_dict: { group_name: array_of_values }
    Returns list of { group1, group2, p_raw, p_adj, significant }.
    """
    group_names = list(groups_dict.keys())
    all_values, group_labels = [], []
    for gname in group_names:
        for v in groups_dict[gname]:
            all_values.append(v)
            group_labels.append(gname)

    n_total = len(all_values)
    ranks = stats.rankdata(all_values)

    mean_ranks, group_sizes = {}, {}
    for gname in group_names:
        idxs = [i for i, g in enumerate(group_labels) if g == gname]
        group_ranks = [ranks[i] for i in idxs]
        mean_ranks[gname] = np.mean(group_ranks)
        group_sizes[gname] = len(idxs)

    unique_vals, tie_counts = np.unique(all_values, return_counts=True)
    tie_factor = sum(t**3 - t for t in tie_counts if t > 1)
    tie_correction = 1 - tie_factor / (n_total**3 - n_total) if n_total > 1 else 1.0

    pairs = list(itertools.combinations(group_names, 2))
    z_stats, p_raws = [], []
    for g1, g2 in pairs:
        n1, n2 = group_sizes[g1], group_sizes[g2]
        mr1, mr2 = mean_ranks[g1], mean_ranks[g2]
        se = math.sqrt(tie_correction * n_total * (n_total + 1) / 12.0 * (1.0 / n1 + 1.0 / n2))
        z = abs(mr1 - mr2) / se if se > 0 else 0.0
        z_stats.append(z)
        p_raws.append(float(2 * (1 - stats.norm.cdf(z))))

    p_adjs = _bh_correction(p_raws)
    return [
        {'group1': g1, 'group2': g2,
         'p_adj': float(p_adjs[i]), 'significant': p_adjs[i] < 0.05}
        for i, (g1, g2) in enumerate(pairs)
    ]


def _games_howell(groups_dict):
    """
    Games-Howell pairwise post-hoc for Welch's ANOVA (unequal variances).
    Uses Welch t-statistics with BH correction.
    groups_dict: { group_name: array_of_values }
    Returns list of { group1, group2, p_adj, significant }.
    """
    group_names = list(groups_dict.keys())
    pairs = list(itertools.combinations(group_names, 2))
    results = []
    for g1, g2 in pairs:
        v1 = np.array(groups_dict[g1], dtype=float)
        v2 = np.array(groups_dict[g2], dtype=float)
        n1, n2 = len(v1), len(v2)
        if n1 < 2 or n2 < 2:
            results.append({'group1': g1, 'group2': g2, 'p_raw': 1.0})
            continue
        m1, m2 = float(np.mean(v1)), float(np.mean(v2))
        s1, s2 = float(np.var(v1, ddof=1)), float(np.var(v2, ddof=1))
        se = math.sqrt(s1 / float(n1) + s2 / float(n2))
        if se == 0:
            results.append({'group1': g1, 'group2': g2, 'p_raw': 1.0})
            continue
        t = abs(m1 - m2) / se
        num = (s1 / n1 + s2 / n2) ** 2
        den = (s1 / n1) ** 2 / (n1 - 1) + (s2 / n2) ** 2 / (n2 - 1)
        df = num / den if den > 0 else min(n1, n2) - 1
        results.append({'group1': g1, 'group2': g2, 'p_raw': float(2 * stats.t.sf(t, df))})

    p_adjs = _bh_correction([r['p_raw'] for r in results])
    for i, r in enumerate(results):
        r['p_adj'] = float(p_adjs[i])
        r['significant'] = p_adjs[i] < 0.05
        del r['p_raw']
    return results


def _group_stats(groups_dict):
    """Return list of { group, mean, std, n } preserving key order."""
    return [
        {'group': g,
         'mean': float(np.mean(v)),
         'std': float(np.std(v, ddof=1)) if len(v) > 1 else 0.0,
         'n': int(len(v))}
        for g, v in groups_dict.items()
    ]


def _letter_groups_from_posthoc(groups_dict, posthoc):
    """Assign CLD letters from post-hoc pairs and return enriched stats list."""
    group_names = list(groups_dict.keys())
    stats_list = _group_stats(groups_dict)

    sig_pairs = set()
    for ph in posthoc:
        if ph.get('significant'):
            sig_pairs.add((ph['group1'], ph['group2']))
            sig_pairs.add((ph['group2'], ph['group1']))

    if not sig_pairs:
        for s in stats_list:
            s['letter'] = 'a'
        return stats_list

    # Adjacency of "not significantly different" pairs
    not_sig_adj = {g: set() for g in group_names}
    for i in range(len(group_names)):
        for j in range(i + 1, len(group_names)):
            g1, g2 = group_names[i], group_names[j]
            if (g1, g2) not in sig_pairs:
                not_sig_adj[g1].add(g2)
                not_sig_adj[g2].add(g1)

    import string
    letter_pool = list(string.ascii_lowercase)
    group_letters = {g: set() for g in group_names}
    letter_idx = 0
    sorted_groups = sorted(group_names, key=lambda g: -np.mean(groups_dict[g]))
    assigned = set()

    for g in sorted_groups:
        if g in assigned and group_letters[g]:
            continue
        clique = {g}
        for candidate in sorted_groups:
            if candidate in clique:
                continue
            if all(candidate in not_sig_adj[m] for m in clique):
                clique.add(candidate)
        letter = letter_pool[letter_idx % len(letter_pool)]
        letter_idx += 1
        for member in clique:
            group_letters[member].add(letter)
            assigned.add(member)

    for g in group_names:
        if not group_letters[g]:
            group_letters[g].add(letter_pool[letter_idx % len(letter_pool)])
            letter_idx += 1

    letter_map = {g: ''.join(sorted(group_letters[g])) for g in group_names}
    for s in stats_list:
        s['letter'] = letter_map.get(s['group'], 'a')
    return stats_list


def _make_anova_plot(slice_df, var, slice_label, result):
    """Generate the box+swarm+letters plot used in all ANOVA tests. Returns base64 PNG or None."""
    try:
        letter_groups = result.get('letter_groups', [])
        if not letter_groups:
            return None
        unique_groups = slice_df['Group'].unique().tolist()
        letter_map = {lg['group']: lg['letter'] for lg in letter_groups}
        plt.figure(figsize=(10, 6))
        sns.set_style("whitegrid")
        palette = sns.color_palette("nipy_spectral", len(unique_groups))
        ax = sns.boxplot(data=slice_df, x='Group', y=var, order=unique_groups,
                         palette=palette, showfliers=False, linewidth=1.5)
        sns.stripplot(data=slice_df, x='Group', y=var, order=unique_groups,
                      color=".25", size=4, alpha=0.5)
        for i, group in enumerate(unique_groups):
            letter = letter_map.get(group, '')
            if letter:
                group_vals = slice_df[slice_df['Group'] == group][var]
                max_val = group_vals.max()
                # Position letter just above the top whisker (Q3 + 1.5*IQR or data max)
                y_range = slice_df[var].max() - slice_df[var].min()
                offset = y_range * 0.03 if y_range > 0 else abs(max_val) * 0.03 if max_val != 0 else 0.05
                ax.text(i, max_val + offset, letter, ha='center', va='bottom',
                        fontsize=12, fontweight='bold', color='black',
                        bbox=dict(facecolor='white', alpha=0.7, edgecolor='none'))
        info_text = (f"{result['test_used']}\nOverall p: {result['overall_p']:.4f}"
                     f"\nNorm: {'✓' if result['assumptions']['all_normal'] else '✗'}"
                     f"  Homo: {'✓' if result['assumptions']['homogeneous'] else '✗'}")
        plt.text(0.02, 0.95, info_text, transform=ax.transAxes, fontsize=9,
                 verticalalignment='top', bbox=dict(boxstyle='round', facecolor='white', alpha=0.8))
        plt.title(f"{var} ({slice_label})", fontsize=14, fontweight='bold')
        plt.xticks(rotation=30, ha='right')
        plt.tight_layout()
        plot_url = get_plot_base64()
        plt.close()
        return plot_url
    except Exception:
        plt.close('all')
        return None


def _anova_build_slices(df, factors, grouping_mode):
    """Parse grouping_mode and return list of (label, slice_df, [factor(s)])."""
    if grouping_mode == 'all_combined' or len(factors) == 1:
        return [('All', df, factors)]
    if grouping_mode.startswith('across:'):
        compare_factor = grouping_mode.split(':', 1)[1]
        return [('All', df, [compare_factor])]
    if grouping_mode.startswith('per:'):
        parts = grouping_mode.split(':', 1)[1]
        compare_factor, stratify_str = parts.split('|', 1)
        stratify_factors = [s.strip() for s in stratify_str.split(',')]
        df2 = df.copy()
        df2['_stratify_'] = df2[stratify_factors].agg(' | '.join, axis=1)
        slices = []
        for strat_val in sorted(df2['_stratify_'].unique()):
            subset = df2[df2['_stratify_'] == strat_val].copy()
            label = f"{' & '.join(stratify_factors)} = {strat_val}"
            slices.append((label, subset, [compare_factor]))
        return slices
    return [('All', df, factors)]


# ── One-factor tests ──────────────────────────────────────────────────────────

def _run_one_factor_tests(df, selected_vars, factors, grouping_mode,
                          test_key, all_normal, homogeneous):
    """Handles one_way_anova / welch_anova / kruskal_wallis with grouping_mode slices."""
    test_labels = {
        'one_way_anova': ("One-way ANOVA + Tukey HSD", "Tukey HSD"),
        'welch_anova':   ("Welch's ANOVA + Games-Howell", "Games-Howell"),
        'kruskal_wallis':("Kruskal–Wallis + Dunn's (BH)", "Dunn's test (BH)"),
    }
    all_results = []

    for var in selected_vars:
        tmp = df.copy()
        tmp[var] = pd.to_numeric(tmp[var], errors='coerce')
        tmp = tmp.dropna(subset=[var]).copy()
        if tmp.empty:
            continue
        for f in factors:
            tmp[f] = tmp[f].astype(str).replace(['nan', 'None'], 'N/A')

        slices = _anova_build_slices(tmp, factors, grouping_mode)

        for slice_label, slice_df, group_factors in slices:
            # Build Group column
            if len(group_factors) > 1:
                slice_df = slice_df.copy()
                slice_df['Group'] = slice_df[group_factors].agg(' | '.join, axis=1)
            else:
                slice_df = slice_df.copy()
                slice_df['Group'] = slice_df[group_factors[0]].astype(str)

            all_ordered = slice_df['Group'].unique().tolist()
            valid_groups = [g for g in all_ordered
                            if len(slice_df[slice_df['Group'] == g]) >= 3]
            if len(valid_groups) < 2:
                continue

            groups_dict = {g: slice_df[slice_df['Group'] == g][var].astype(float).values.tolist()
                           for g in valid_groups}

            # Per-slice assumption re-check (for accuracy)
            sp = [bool(stats.shapiro(v)[1] > 0.05) for v in groups_dict.values() if len(v) >= 3]
            slice_normal = all(sp) if sp else False
            _, lp = stats.levene(*[np.array(v) for v in groups_dict.values()])
            slice_homo = bool(lp > 0.05)

            test_name, posthoc_method = test_labels[test_key]

            if test_key == 'one_way_anova':
                f_stat, overall_p = stats.f_oneway(*[np.array(v) for v in groups_dict.values()])
                overall_p = float(overall_p)
                posthoc = []
                if overall_p < 0.05:
                    all_vals = np.concatenate([np.array(v) for v in groups_dict.values()])
                    all_lbls = np.concatenate([[g]*len(groups_dict[g]) for g in valid_groups])
                    try:
                        mc = MultiComparison(all_vals, all_lbls)
                        tukey = mc.tukeyhsd()
                        for row in tukey.summary().data[1:]:
                            g1, g2, _, p_adj, _, _, reject = row
                            posthoc.append({'group1': str(g1), 'group2': str(g2),
                                            'p_adj': float(p_adj), 'significant': bool(reject)})
                    except Exception:
                        pass
                # Effect size η²
                grand_mean = np.concatenate([np.array(v) for v in groups_dict.values()]).mean()
                ss_b = sum(len(v)*(np.mean(v)-grand_mean)**2 for v in groups_dict.values())
                ss_t = sum(((np.array(v)-grand_mean)**2).sum() for v in groups_dict.values())
                effect_size = float(ss_b/ss_t) if ss_t > 0 else 0.0

            elif test_key == 'welch_anova':
                _, overall_p = _welch_anova([np.array(v) for v in groups_dict.values()])
                overall_p = float(overall_p) if overall_p is not None else 1.0
                posthoc = _games_howell(groups_dict) if overall_p < 0.05 else []
                effect_size = None

            else:  # kruskal_wallis
                _, overall_p = stats.kruskal(*[np.array(v) for v in groups_dict.values()])
                overall_p = float(overall_p)
                posthoc = _dunns_test_bh(groups_dict) if overall_p < 0.05 else []
                n_total = sum(len(v) for v in groups_dict.values())
                k = len(groups_dict)
                kw_stat, _ = stats.kruskal(*[np.array(v) for v in groups_dict.values()])
                eta2_kw = max(0.0, float((kw_stat - k + 1) / (n_total - k))) if n_total > k else 0.0
                effect_size = eta2_kw

            letter_groups = _letter_groups_from_posthoc(groups_dict, posthoc)

            result = {
                "variable": var,
                "slice_label": slice_label,
                "test_used": test_name,
                "posthoc_method": posthoc_method,
                "overall_p": overall_p,
                "effect_size": effect_size,
                "effect_size_label": "η²",
                "assumptions": {"all_normal": slice_normal, "homogeneous": slice_homo},
                "letter_groups": letter_groups,
                "posthoc": posthoc,
            }
            result["plot_url"] = _make_anova_plot(slice_df, var, slice_label, result)
            all_results.append(result)

    return all_results


# ── Two-way ANOVA ─────────────────────────────────────────────────────────────

def _run_two_way_anova(df, selected_vars, factors, all_normal, homogeneous):
    f1, f2 = factors[0], factors[1]
    all_results = []

    for var in selected_vars:
        if var not in df.columns:
            continue
        sub = df[[var, f1, f2]].copy()
        sub[var] = pd.to_numeric(sub[var], errors='coerce')
        for f in [f1, f2]:
            sub[f] = sub[f].astype(str).replace(['nan', 'None'], 'N/A')
        sub = sub.dropna()
        if len(sub) < 6:
            continue

        try:
            formula = f'Q("{var}") ~ C(Q("{f1}")) + C(Q("{f2}")) + C(Q("{f1}")):C(Q("{f2}"))'
            model = ols(formula, data=sub).fit()
            anova_table = sm.stats.anova_lm(model, typ=2)

            def get_p(keyword, exclude=None):
                keys = [k for k in anova_table.index
                        if keyword in str(k) and (exclude is None or exclude not in str(k))]
                return float(anova_table.loc[keys[0], 'PR(>F)']) if keys else 1.0 # type: ignore

            p_f1 = get_p(f1, ':')
            p_f2 = get_p(f2, ':')
            p_int_keys = [k for k in anova_table.index if ':' in str(k)]
            p_int = float(anova_table.loc[p_int_keys[0], 'PR(>F)']) if p_int_keys else None # type: ignore

            ss_res = anova_table.loc['Residual', 'sum_sq']
            ss_others = sum(anova_table.loc[k, 'sum_sq'] # type: ignore
                            for k in anova_table.index if 'Residual' not in str(k)) # type: ignore
            ss_total = ss_res + ss_others
            eta2_f1 = get_p(f1, ':')  # placeholder, compute below
            eta2_f1_keys = [k for k in anova_table.index if f1 in str(k) and ':' not in str(k)]
            eta2_f1 = float(anova_table.loc[eta2_f1_keys[0], 'sum_sq'] / ss_total) if eta2_f1_keys and ss_total > 0 else 0.0

            overall_p = min(p_f1, p_f2)

            # Post-hoc: Tukey on combined group labels
            sub['Group'] = sub[f1].astype(str) + ' / ' + sub[f2].astype(str)
            groups_dict = {g: grp[var].astype(float).values.tolist()
                           for g, grp in sub.groupby('Group') if len(grp) >= 1}
            posthoc = []
            if overall_p < 0.05 and len(groups_dict) >= 2:
                all_vals = np.concatenate([np.array(v) for v in groups_dict.values()])
                all_lbls = np.concatenate([[g]*len(groups_dict[g]) for g in groups_dict])
                try:
                    mc = MultiComparison(all_vals, all_lbls)
                    tukey = mc.tukeyhsd()
                    for row in tukey.summary().data[1:]:
                        g1, g2, _, p_adj, _, _, reject = row
                        posthoc.append({'group1': str(g1), 'group2': str(g2),
                                        'p_adj': float(p_adj), 'significant': bool(reject)})
                except Exception:
                    pass

            letter_groups = _letter_groups_from_posthoc(groups_dict, posthoc)
            result = {
                "variable": var, "slice_label": "All",
                "test_used": "Two-way ANOVA",
                "posthoc_method": "Tukey HSD (combined groups)",
                "overall_p": overall_p,
                "p_factor1": float(p_f1), "p_factor2": float(p_f2),
                "p_interaction": float(p_int) if p_int is not None else None,
                "effect_size": eta2_f1, "effect_size_label": f"η² ({f1})",
                "assumptions": {"all_normal": all_normal, "homogeneous": homogeneous},
                "letter_groups": letter_groups, "posthoc": posthoc,
            }
            result["plot_url"] = _make_anova_plot(sub, var, "All", result)
            all_results.append(result)
        except Exception as e:
            all_results.append({"variable": var, "slice_label": "All", "error": str(e)})

    return all_results


# ── Scheirer-Ray-Hare ─────────────────────────────────────────────────────────

def _scheirer_ray_hare(df, value_col, f1, f2):
    """Returns {f1: {H, df, p}, f2: {…}, 'interaction': {…}} or None."""
    df = df[[value_col, f1, f2]].dropna().copy()
    n = len(df)
    if n < 4:
        return None
    df['_rank'] = stats.rankdata(df[value_col])
    ss_total = np.sum((df['_rank'] - df['_rank'].mean()) ** 2)

    def ss_effect(col):
        gm = df.groupby(col)['_rank'].mean()
        gn = df.groupby(col)['_rank'].count()
        return sum(gn[g] * (gm[g] - df['_rank'].mean()) ** 2 for g in gm.index)

    ss1 = ss_effect(f1)
    ss2 = ss_effect(f2)
    df['_cell'] = df[f1].astype(str) + '|||' + df[f2].astype(str)
    ss_cells = ss_effect('_cell')
    ss_int = ss_cells - ss1 - ss2
    df1 = df[f1].nunique() - 1
    df2 = df[f2].nunique() - 1
    df_int = df1 * df2
    ms_err = ss_total / (n - 1) if n > 1 else 1.0

    def h_p(ss, dfe):
        h = (ss / ms_err) if ms_err > 0 else 0.0
        p = float(stats.chi2.sf(h, dfe)) if dfe > 0 else 1.0
        return float(h), p

    h1, p1 = h_p(ss1, df1)
    h2, p2 = h_p(ss2, df2)
    hi, pi = h_p(ss_int, df_int)
    return {
        f1: {'H': h1, 'df': int(df1), 'p': p1},
        f2: {'H': h2, 'df': int(df2), 'p': p2},
        'interaction': {'H': hi, 'df': int(df_int), 'p': pi}
    }


def _run_scheirer_ray_hare(df, selected_vars, factors, all_normal, homogeneous):
    f1, f2 = factors[0], factors[1]
    all_results = []

    for var in selected_vars:
        if var not in df.columns:
            continue
        sub = df[[var, f1, f2]].copy()
        sub[var] = pd.to_numeric(sub[var], errors='coerce')
        for f in [f1, f2]:
            sub[f] = sub[f].astype(str).replace(['nan', 'None'], 'N/A')
        sub = sub.dropna()
        if len(sub) < 6:
            continue

        srh = _scheirer_ray_hare(sub, var, f1, f2)
        if srh is None:
            continue

        overall_p = min(srh[f1]['p'], srh[f2]['p'])
        sub['Group'] = sub[f1].astype(str) + ' / ' + sub[f2].astype(str)
        groups_dict = {g: grp[var].astype(float).values.tolist()
                       for g, grp in sub.groupby('Group') if len(grp) >= 2}
        posthoc = _dunns_test_bh(groups_dict) if overall_p < 0.05 and len(groups_dict) >= 2 else []

        letter_groups = _letter_groups_from_posthoc(groups_dict, posthoc)
        result = {
            "variable": var, "slice_label": "All",
            "test_used": "Scheirer–Ray–Hare",
            "posthoc_method": "Dunn's test (BH)",
            "overall_p": overall_p,
            "p_factor1": srh[f1]['p'], "p_factor2": srh[f2]['p'],
            "p_interaction": srh['interaction']['p'],
            "effect_size": None,
            "assumptions": {"all_normal": all_normal, "homogeneous": homogeneous},
            "letter_groups": letter_groups, "posthoc": posthoc,
            "srh_table": {f1: srh[f1], f2: srh[f2], 'interaction': srh['interaction']}
        }
        result["plot_url"] = _make_anova_plot(sub, var, "All", result)
        all_results.append(result)

    return all_results


# ── MANOVA (Pillai's Trace) ───────────────────────────────────────────────────

def _manova_pillai(df, variable_cols, group_col):
    """Compute Pillai's Trace MANOVA. Returns dict with pillais_trace, F, p, or None."""
    df_clean = df[[group_col] + variable_cols].dropna()
    if len(df_clean) < len(variable_cols) + 2:
        return None
    groups = df_clean[group_col].unique()
    k, p, n = len(groups), len(variable_cols), len(df_clean)
    grand_mean = df_clean[variable_cols].mean().values

    H = np.zeros((p, p))
    for g in groups:
        g_data = df_clean[df_clean[group_col] == g][variable_cols].values
        g_mean = g_data.mean(axis=0)
        diff = (g_mean - grand_mean).reshape(-1, 1)
        H += len(g_data) * (diff @ diff.T)

    E = np.zeros((p, p))
    for g in groups:
        g_data = df_clean[df_clean[group_col] == g][variable_cols].values
        diffs = g_data - g_data.mean(axis=0)
        E += diffs.T @ diffs

    try:
        eigvals = np.linalg.eigvals(np.linalg.pinv(E) @ H).real
        eigvals = eigvals[eigvals > 0]
    except np.linalg.LinAlgError:
        return None

    pillai = float(sum(l / (1 + l) for l in eigvals))
    s = min(k - 1, p)
    m = (abs(k - 1 - p) - 1) / 2
    nn = (n - k - p - 1) / 2
    if s == 0 or nn <= 0:
        return {'pillais_trace': pillai, 'F': None, 'p': None}

    df_num = s * (2 * m + s + 1)
    df_den = s * (2 * nn + s + 1)
    F_stat = (pillai / s) * df_den / ((1 - pillai / s) * df_num) if pillai < s else None
    p_val = float(stats.f.sf(F_stat, df_num, df_den)) if F_stat and F_stat > 0 else None

    return {'pillais_trace': pillai, 'F': F_stat, 'p': p_val}


def _run_manova(df, selected_vars, factors, all_normal, homogeneous):
    """MANOVA (Pillai's Trace) + per-variable ANOVA follow-ups with Bonferroni."""
    df = df.copy()
    df['_group'] = df[factors[0]].astype(str)
    for f in factors[1:]:
        df['_group'] += ' / ' + df[f].astype(str)

    clean = df[['_group'] + selected_vars].copy()
    for v in selected_vars:
        clean[v] = pd.to_numeric(clean[v], errors='coerce')
    clean = clean.dropna()

    manova_res = _manova_pillai(clean, selected_vars, '_group')
    manova_p = manova_res['p'] if manova_res else None
    pillai = manova_res['pillais_trace'] if manova_res else None

    bonferroni_alpha = 0.05 / len(selected_vars) if selected_vars else 0.05
    all_results = []

    for var in selected_vars:
        if var not in df.columns:
            continue
        groups_dict = {g: grp[var].dropna().astype(float).values.tolist()
                       for g, grp in clean.groupby('_group') if len(grp) >= 3}
        if len(groups_dict) < 2:
            continue

        f_stat, overall_p = stats.f_oneway(*[np.array(v) for v in groups_dict.values()])
        overall_p = float(overall_p)
        posthoc = []
        if overall_p < 0.05:
            all_vals = np.concatenate([np.array(v) for v in groups_dict.values()])
            all_lbls = np.concatenate([[g]*len(groups_dict[g]) for g in groups_dict])
            try:
                mc = MultiComparison(all_vals, all_lbls)
                tukey = mc.tukeyhsd()
                for row in tukey.summary().data[1:]:
                    g1, g2, _, p_adj, _, _, reject = row
                    posthoc.append({'group1': str(g1), 'group2': str(g2),
                                    'p_adj': float(p_adj),
                                    'significant': float(p_adj) < bonferroni_alpha})
            except Exception:
                pass

        slice_df = clean[['_group', var]].copy()
        slice_df.columns = ['Group', var]
        letter_groups = _letter_groups_from_posthoc(groups_dict, posthoc)
        result = {
            "variable": var, "slice_label": "All",
            "test_used": "MANOVA → per-variable ANOVA",
            "posthoc_method": f"Tukey HSD (Bonferroni α={bonferroni_alpha:.4f})",
            "overall_p": overall_p,
            "effect_size": None,
            "assumptions": {"all_normal": all_normal, "homogeneous": homogeneous},
            "letter_groups": letter_groups, "posthoc": posthoc,
            "manova_pillais_trace": float(pillai) if pillai is not None else None,
            "manova_p": float(manova_p) if manova_p is not None else None,
        }
        result["plot_url"] = _make_anova_plot(slice_df, var, "All", result)
        all_results.append(result)

    return all_results


# ── ART ANOVA (Aligned Rank Transform) ───────────────────────────────────────

def _art_anova_per_factor(df, value_col, factors):
    """
    ART ANOVA: for each factor, align values by removing all other effects,
    rank the aligned values, then run one-way ANOVA on them.
    Returns {factor: {F, p}}.
    """
    df = df[factors + [value_col]].dropna().copy()
    if len(df) < len(factors) * 3:
        return None
    results = {}
    for target in factors:
        others = [f for f in factors if f != target]
        if others:
            df['_art_mean'] = df.groupby(others)[value_col].transform('mean')
        else:
            df['_art_mean'] = df[value_col].mean()
        df['_aligned'] = df[value_col] - df['_art_mean']
        df['_ranked'] = stats.rankdata(df['_aligned'])
        group_arrs = [grp['_ranked'].values for _, grp in df.groupby(target)]
        if len(group_arrs) < 2:
            continue
        f_stat, p_val = stats.f_oneway(*group_arrs)
        results[target] = {'F': float(f_stat), 'p': float(p_val)}
    return results


def _run_art_anova(df, selected_vars, factors, all_normal, homogeneous):
    """ART ANOVA + Dunn's post-hoc with Bonferroni correction across variables."""
    df = df.copy()
    df['_group'] = df[factors[0]].astype(str)
    for f in factors[1:]:
        df['_group'] += ' / ' + df[f].astype(str)

    bonferroni_alpha = 0.05 / len(selected_vars) if selected_vars else 0.05
    all_results = []

    for var in selected_vars:
        if var not in df.columns:
            continue
        sub = df[[var] + factors + ['_group']].copy()
        sub[var] = pd.to_numeric(sub[var], errors='coerce')
        for f in factors:
            sub[f] = sub[f].astype(str).replace(['nan', 'None'], 'N/A')
        sub = sub.dropna(subset=[var])
        if len(sub) < 6:
            continue

        art_res = _art_anova_per_factor(sub, var, factors)
        if not art_res:
            continue
        overall_p = min(r['p'] for r in art_res.values())

        groups_dict = {g: grp[var].astype(float).values.tolist()
                       for g, grp in sub.groupby('_group') if len(grp) >= 2}
        posthoc = []
        if overall_p < 0.05 and len(groups_dict) >= 2:
            posthoc = _dunns_test_bh(groups_dict)
            for ph in posthoc:
                ph['significant'] = ph['p_adj'] < bonferroni_alpha

        slice_df = sub[['_group', var]].copy()
        slice_df.columns = ['Group', var]
        letter_groups = _letter_groups_from_posthoc(groups_dict, posthoc)
        result = {
            "variable": var, "slice_label": "All",
            "test_used": "ART ANOVA",
            "posthoc_method": f"Dunn's test (Bonferroni α={bonferroni_alpha:.4f})",
            "overall_p": overall_p,
            "effect_size": None,
            "assumptions": {"all_normal": all_normal, "homogeneous": homogeneous},
            "letter_groups": letter_groups, "posthoc": posthoc,
            "art_factor_table": art_res,
        }
        result["plot_url"] = _make_anova_plot(slice_df, var, "All", result)
        all_results.append(result)

    return all_results


# ════════════════════════════════════════════════════════════════════════════════
# FULL REPORT EXCEL EXPORT  (/export-full-report)
# ════════════════════════════════════════════════════════════════════════════════

@stats_bp.route('/export-full-report', methods=['POST'])
def export_full_report():
    """
    Generates a 6-sheet .xlsx Full Statistical Report.

    Expected JSON payload:
    {
        original_data: [...],          # raw rows before any processing
        analysed_data: [...],          # rows used for ANOVA (after transforms/exclusions)
        transform_notes: "...",        # human-readable transform summary
        anova_results: { results: [...], test_rationale: "..." },
        assumption_results: [...],     # from /run-tests
        original_assumption_results: [],
        plot_captures: [{ label, type: 'box'|'residuals'|'qq', image: '<base64 png>' }],
        factors: ['F1', 'F2'],
        target_columns: ['var1', 'var2']
    }
    """
    try:
        payload = request.get_json(force=True)
        original_data = payload.get('original_data', [])
        analysed_data = payload.get('analysed_data', [])
        transform_notes = payload.get('transform_notes', 'None')
        anova_results = payload.get('anova_results', {})
        assumption_results_raw = payload.get('assumption_results') or {}
        orig_assumption_results_raw = payload.get('original_assumption_results') or {}
        # lastTestResults in JS has shape { results: [...] }
        assumption_results = assumption_results_raw.get('results', []) if isinstance(assumption_results_raw, dict) else (assumption_results_raw or [])
        orig_assumption_results = orig_assumption_results_raw.get('results', []) if isinstance(orig_assumption_results_raw, dict) else (orig_assumption_results_raw or [])
        plot_captures = payload.get('plot_captures', [])
        factors = payload.get('factors', [])
        target_cols = payload.get('target_columns', [])

        wb = Workbook()

        # Use module-level style helpers and fill palette
        fills      = _XL_FILLS
        hdr_font   = _XL_HDR_FONT
        thin_border = _XL_THIN_BORDER
        center_al  = _XL_CENTER_AL
        left_al    = Alignment(horizontal='left', vertical='center', wrap_text=True)
        style_header_row = _xl_style_header
        auto_width       = _xl_auto_width
        border_row       = _xl_border_row

        # ══ Sheet 1: Original Data ════════════════════════════════════════════
        ws1 = wb.create_sheet('1 - Original Data', 0)
        if original_data:
            orig_df = pd.DataFrame(original_data).drop(columns=['row_id'], errors='ignore')
            headers = list(orig_df.columns)
            ws1.append(headers)
            style_header_row(ws1, 1, fills['blue'])
            for _, row in orig_df.iterrows():
                ws1.append([row.get(h, '') for h in headers])
            auto_width(ws1)

        # ══ Sheet 2: Analysed Data ════════════════════════════════════════════
        ws2 = wb.create_sheet('2 - Analysed Data')
        ws2.cell(1, 1, 'Data used for ANOVA analysis').font = Font(bold=True, size=12)
        ws2.cell(2, 1, f'Transformations applied: {transform_notes}').fill = fills['note']

        orig_ids = {r.get('row_id') for r in original_data}
        anal_ids = {r.get('row_id') for r in analysed_data}
        excluded = orig_ids - anal_ids
        if excluded:
            ws2.cell(3, 1, 'Excluded row IDs: ' + ', '.join(str(e) for e in sorted(excluded))).fill = fills['fail']

        ws2.append([])
        if analysed_data:
            an_df = pd.DataFrame(analysed_data).drop(columns=['row_id'], errors='ignore')
            headers = list(an_df.columns)
            ws2.append(headers)
            style_header_row(ws2, ws2.max_row, fills['green'])
            for _, row in an_df.iterrows():
                ws2.append([row.get(h, '') for h in headers])
            auto_width(ws2)

        # ══ Sheet 3: Assumption Tests ══════════════════════════════════════════
        ws3 = wb.create_sheet('3 - Assumption Tests')
        has_transforms = bool(transform_notes and transform_notes.strip() not in ('', 'None'))

        if has_transforms:
            hdrs3 = ['Variable', 'Group',
                     'SW p (original)', 'Normal? (original)',
                     'SW p (transformed)', 'Normal? (transformed)',
                     'Levene p (original)', 'Homo? (original)',
                     'Levene p (transformed)', 'Homo? (transformed)']
        else:
            hdrs3 = ['Variable', 'Group', 'Shapiro-Wilk p', 'Normal?',
                     'Levene p', 'Homogeneous?']

        ws3.append(hdrs3)
        style_header_row(ws3, 1, fills['orange'])

        def find_var_result(result_list, var_name):
            for r in (result_list or []):
                if r.get('variable') == var_name:
                    return r
            return None

        for var in target_cols:
            res_t = find_var_result(assumption_results, var)
            res_o = find_var_result(orig_assumption_results, var) if orig_assumption_results else None
            if res_t is None:
                continue
            lev_t = res_t.get('levene', {})
            lp_t = lev_t.get('p')
            lh_t = lev_t.get('is_homogeneous')
            lev_o = res_o.get('levene', {}) if res_o else {}
            lp_o = lev_o.get('p') if lev_o else None
            lh_o = lev_o.get('is_homogeneous') if lev_o else None

            for sg in res_t.get('shapiro', []):
                grp = sg.get('group', '')
                sw_p_t = sg.get('p')
                is_n_t = sg.get('is_normal')
                sw_p_o, is_n_o = None, None
                if res_o:
                    for osg in res_o.get('shapiro', []):
                        if osg.get('group') == grp:
                            sw_p_o, is_n_o = osg.get('p'), osg.get('is_normal')
                            break

                if has_transforms:
                    row_data = [
                        var, grp,
                        round(sw_p_o, 4) if sw_p_o is not None else '',
                        'Pass' if is_n_o else 'Fail',
                        round(sw_p_t, 4) if sw_p_t is not None else '',
                        'Pass' if is_n_t else 'Fail',
                        round(lp_o, 4) if lp_o is not None else '',
                        'Pass' if lh_o else 'Fail',
                        round(lp_t, 4) if lp_t is not None else '',
                        'Pass' if lh_t else 'Fail',
                    ]
                else:
                    row_data = [
                        var, grp,
                        round(sw_p_t, 4) if sw_p_t is not None else '',
                        'Pass' if is_n_t else 'Fail',
                        round(lp_t, 4) if lp_t is not None else '',
                        'Pass' if lh_t else 'Fail',
                    ]
                ws3.append(row_data)
                r_idx = ws3.max_row
                for c_idx, val in enumerate(row_data, 1):
                    cell = ws3.cell(r_idx, c_idx)
                    cell.border = thin_border
                    if val == 'Pass':
                        cell.fill = fills['pass']
                    elif val == 'Fail':
                        cell.fill = fills['fail']
        auto_width(ws3)

        # ══ Sheet 4: ANOVA Results ═════════════════════════════════════════════
        ws4 = wb.create_sheet('4 - ANOVA Results')
        anova_r = anova_results.get('results', [])
        rationale = anova_results.get('test_rationale', '')
        if rationale:
            ws4.cell(1, 1, 'Test selection:').font = Font(bold=True)
            ws4.cell(1, 2, rationale).fill = fills['note']
            ws4.append([])

        by_var = defaultdict(list)
        for r in anova_r:
            by_var[r.get('variable', 'Unknown')].append(r)

        cur_row = ws4.max_row + 1
        for var in target_cols:
            if var not in by_var:
                continue
            # Variable heading
            ws4.cell(cur_row, 1, var)
            ws4.cell(cur_row, 1).font = hdr_font
            ws4.cell(cur_row, 1).fill = fills['purple']
            cur_row += 1

            for res in by_var[var]:
                ws4.cell(cur_row, 1, f"Grouping: {res.get('slice_label', 'All')}")
                ws4.cell(cur_row, 1).font = Font(bold=True, italic=True, size=10)
                cur_row += 1

                for lbl, key in [
                    ('Test used', 'test_used'),
                    ('Post-hoc method', 'posthoc_method'),
                    ('Overall p-value', 'overall_p'),
                    ('Effect size', 'effect_size'),
                    (f'p ({factors[0] if factors else "Factor1"})', 'p_factor1'),
                    (f'p ({factors[1] if len(factors) > 1 else "Factor2"})', 'p_factor2'),
                    ('p (Interaction)', 'p_interaction'),
                    ("MANOVA Pillai's Trace", 'manova_pillais_trace'),
                    ('MANOVA overall p', 'manova_p'),
                ]:
                    val = res.get(key)
                    if val is not None:
                        ws4.cell(cur_row, 1, lbl + ':')
                        ws4.cell(cur_row, 2, round(val, 6) if isinstance(val, float) else val)
                        cur_row += 1

                # Letter-group table
                letter_groups = res.get('letter_groups', [])
                if letter_groups:
                    cur_row += 1
                    for c_idx, h in enumerate(['Group', 'N', 'Mean', 'SD', 'Letter Group'], 1):
                        cell = ws4.cell(cur_row, c_idx, h)
                        cell.font = hdr_font
                        cell.fill = fills['teal']
                        cell.alignment = center_al
                        cell.border = thin_border
                    cur_row += 1
                    for lg in letter_groups:
                        row_vals = [lg.get('group', ''), lg.get('n', 0),
                                    round(lg.get('mean', 0), 4), round(lg.get('std', 0), 4),
                                    lg.get('letter', '')]
                        for c_idx, v in enumerate(row_vals, 1):
                            cell = ws4.cell(cur_row, c_idx, v)
                            cell.alignment = center_al
                            cell.border = thin_border
                        cur_row += 1
                cur_row += 1
            cur_row += 1
        auto_width(ws4)

        # ══ Sheet 5: Pairwise Comparisons ═════════════════════════════════════
        ws5 = wb.create_sheet('5 - Pairwise Comparisons')
        hdrs5 = ['Variable', 'Grouping', 'Group 1', 'Group 2', 'p (adjusted)', 'Significant?']
        ws5.append(hdrs5)
        style_header_row(ws5, 1, fills['grey'])

        for var in target_cols:
            for res in by_var.get(var, []):
                for ph in res.get('posthoc', []):
                    ws5.append([
                        var, res.get('slice_label', 'All'),
                        ph.get('group1', ''), ph.get('group2', ''),
                        round(ph.get('p_adj', 1.0), 6),
                        'Yes' if ph.get('significant') else 'No'
                    ])
                    r = ws5.max_row
                    ws5.cell(r, 6).fill = fills['pass'] if ph.get('significant') else fills['light']
                    border_row(ws5, r, 6)
        auto_width(ws5)

        # ══ Sheet 6: Plots ═════════════════════════════════════════════════════
        ws6 = wb.create_sheet('6 - Plots')
        ws6.cell(1, 1, 'Statistical Diagnostic Plots').font = Font(bold=True, size=14)
        ws6.append([])

        type_labels = {'box': 'Box Plot', 'residuals': 'Residuals vs Fitted', 'qq': 'Normal Q-Q'}
        col_positions = [1, 12]   # Two plots per row (columns A and L)
        cur_plot_row = 3
        cur_col_idx = 0

        if not plot_captures:
            ws6.cell(3, 1, 'No plots captured. Run assumption tests before exporting.').fill = fills['note']
        else:
            for pc in plot_captures:
                img_b64 = pc.get('image', '')
                label = pc.get('label', '')
                ptype = pc.get('type', '')
                type_label = type_labels.get(ptype, ptype)

                label_cell = ws6.cell(cur_plot_row, col_positions[cur_col_idx],
                                       f'{type_label}: {label}')
                label_cell.font = Font(bold=True, size=9)
                label_cell.fill = fills['note']

                if img_b64:
                    try:
                        img_bytes = base64.b64decode(img_b64)
                        xl_img = XLImage(io.BytesIO(img_bytes))
                        xl_img.width = 500 # type: ignore
                        xl_img.height = 300 # type: ignore
                        cell_addr = f'{get_column_letter(col_positions[cur_col_idx])}{cur_plot_row + 1}'
                        ws6.add_image(xl_img, cell_addr)
                    except Exception as img_err:
                        ws6.cell(cur_plot_row + 1, col_positions[cur_col_idx],
                                  f'[Image error: {img_err}]')

                cur_col_idx += 1
                if cur_col_idx >= len(col_positions):
                    cur_col_idx = 0
                    cur_plot_row += 22   # rows per image block

        # ── Serialise ─────────────────────────────────────────────────────────
        output = io.BytesIO()
        wb.save(output)
        output.seek(0)
        return send_file(
            output,
            download_name='Statistical_Analysis_Full_Report.xlsx',
            as_attachment=True,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )

    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


# ================== HELPER FUNCTIONS ==================

def _make_json_safe(obj):
    """Convert numpy types (bool_, float64, int64, etc.) to native Python types and sanitize NaN/Inf"""
    if isinstance(obj, np.generic):
        val = obj.item()
        if isinstance(val, float) and (val != val or val == float('inf') or val == float('-inf')):
            return None
        return val
    elif isinstance(obj, float):
        if obj != obj or obj == float('inf') or obj == float('-inf'):
            return None
        return obj
    elif isinstance(obj, dict):
        return {k: _make_json_safe(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_make_json_safe(item) for item in obj]
    elif isinstance(obj, tuple):
        return tuple(_make_json_safe(item) for item in obj)
    return obj


def _welch_anova(data_list):
    """
    Welch's one-way ANOVA (Welch 1951) — handles unequal variances.
    Returns (F, p). Use instead of stats.f_oneway when homogeneity fails but normality holds.
    Formula: F_W = num / denom, with adjusted df2 = (k²-1) / (3·λ)
      where λ = Σ ((1 - wi/W)² / (ni-1))  and  wi = ni/si²
    """
    from scipy.stats import f as f_dist
    k = len(data_list)
    if k < 2:
        return None, None
    n  = np.array([len(d)             for d in data_list], dtype=float)
    m  = np.array([np.mean(d)         for d in data_list])
    v  = np.array([np.var(d, ddof=1)  for d in data_list])
    if np.any(v <= 0):
        return None, None
    w  = n / v
    W  = w.sum()
    grand_mean = (w * m).sum() / W
    lambda_    = ((1 - w / W) ** 2 / (n - 1)).sum()
    num   = (w * (m - grand_mean) ** 2).sum() / (k - 1)
    denom = 1 + (2 * (k - 2) / (k ** 2 - 1)) * lambda_
    F     = num / denom
    df1   = float(k - 1)
    df2   = (k ** 2 - 1) / (3 * lambda_) if lambda_ > 0 else 1e6
    p     = float(1 - f_dist.cdf(F, df1, df2))
    return float(F), p


def _pairwise_posthoc(group_names, group_data, method='mannwhitneyu', correction='fdr_bh'):

    pairs = list(combinations(range(len(group_names)), 2))
    p_values = []
    comparisons = []

    for i, j in pairs:
        g1, g2 = group_names[i], group_names[j]
        d1, d2 = group_data[g1], group_data[g2]

        if method == 'mannwhitneyu':
            _, p = stats.mannwhitneyu(d1, d2, alternative='two-sided')
        else:  # welch
            _, p = stats.ttest_ind(d1, d2, equal_var=False, alternative='two-sided')

        p_values.append(p)
        comparisons.append((g1, g2))

    reject, p_adj, _, _ = multipletests(p_values, alpha=0.05, method=correction)

    return [
        {
            "group1": str(g1),
            "group2": str(g2),
            "p_adj": float(p),
            "significant": bool(r)
        }
        for (g1, g2), p, r in zip(comparisons, p_adj, reject)
    ]


def _assign_letter_groups(group_names, group_data, posthoc_results, var, slice_df):
    """
    Assign compact letter display (CLD) from post-hoc pairwise results.
    Groups that are NOT significantly different share the same letter.
    """
    import string

    n = len(group_names)
    if n == 0:
        return []

    # Build a set of pairs that ARE significantly different
    sig_pairs = set()
    if posthoc_results:
        for ph in posthoc_results:
            if ph["significant"]:
                sig_pairs.add((ph["group1"], ph["group2"]))
                sig_pairs.add((ph["group2"], ph["group1"]))

    # If no posthoc or no significant differences, all get 'a'
    if not sig_pairs:
        result = []
        for g in group_names:
            d = group_data[g]
            result.append({
                "group": str(g),
                "mean": float(np.mean(d)),
                "std": float(np.std(d, ddof=1)) if len(d) > 1 else 0.0,
                "n": int(len(d)),
                "letter": "a"
            })
        return result

    # Greedy CLD algorithm:
    # Start by assigning letter 'a' to all groups.
    # For each pair that is significantly different, ensure they don't share ALL letters.
    # If they do, add a new letter to one of them.

    # Simple approach: absorption algorithm
    # 1. Create initial grouping: each group starts with its own potential set
    # 2. Merge groups that are NOT significantly different

    # Use Union-Find like approach but for CLD
    # Alternative: connected-components of "not-significantly-different" groups
    # Groups in the same connected component share a letter

    # Build adjacency for NOT significant (i.e., similar groups)
    not_sig_adj = {g: set() for g in group_names}
    for i in range(n):
        for j in range(i + 1, n):
            g1, g2 = group_names[i], group_names[j]
            if (g1, g2) not in sig_pairs:
                not_sig_adj[g1].add(g2)
                not_sig_adj[g2].add(g1)

    # Find all maximal cliques of "not significantly different" groups
    # Each clique gets one letter
    letters = list(string.ascii_lowercase)
    group_letters = {g: set() for g in group_names}
    letter_idx = 0

    # Sort groups by mean (descending) for consistent letter assignment
    sorted_groups = sorted(group_names, key=lambda g: -np.mean(group_data[g]))

    assigned = set()
    for g in sorted_groups:
        if g in assigned and group_letters[g]:
            continue
        # Find all groups connected to g (not sig different) that can form a clique
        clique = {g}
        for candidate in sorted_groups:
            if candidate in clique:
                continue
            # candidate must be not-sig-different from ALL current clique members
            if all(candidate in not_sig_adj[member] for member in clique):
                clique.add(candidate)

        # Assign letter to this clique
        if letter_idx < len(letters):
            letter = letters[letter_idx]
        else:
            letter = letters[letter_idx % 26] + str(letter_idx // 26)
        letter_idx += 1

        for member in clique:
            group_letters[member].add(letter)
            assigned.add(member)

    # Check: any group with no letter gets the next available
    for g in group_names:
        if not group_letters[g]:
            if letter_idx < len(letters):
                group_letters[g].add(letters[letter_idx])
            letter_idx += 1

    # Build a lookup dictionary for the calculated statistics
    stats_map = {}
    for g in sorted_groups:
        d = group_data[g]
        stats_map[g] = {
            "group": str(g),
            "mean": float(np.mean(d)),
            "std": float(np.std(d, ddof=1)) if len(d) > 1 else 0.0,
            "n": int(len(d)),
            "letter": "".join(sorted(group_letters[g]))
        }

    # Return the results in the original order provided in group_names
    return [stats_map[g] for g in group_names]

@stats_bp.route('/export-anova-excel', methods=['POST'])
def export_anova_excel():
    try:
        data = request.get_json()
        if not data or 'results' not in data:
            return jsonify({"error": "No data provided"}), 400

        summary_rows = []
        pairwise_rows = []

        for res in data['results']:
            var_name = res.get('variable', 'N/A')
            slice_info = res.get('slice_label', 'All Data')
            test_type = res.get('test_used', 'N/A')
            overall_p = res.get('overall_p', 'N/A')
            
            # --- NEW: Extract Assumption Results ---
            assumptions = res.get('assumptions', {})
            all_normal = "Yes" if assumptions.get('all_normal') else "No"
            homogeneous = "Yes" if assumptions.get('homogeneous') else "No"

            # 1. Process Summary (Adding Assumption Columns)
            if 'letter_groups' in res:
                for lg in res['letter_groups']:
                    summary_rows.append({
                        "Variable": var_name,
                        "Group": lg.get('group'),
                        "Slice/Subset": slice_info,
                        "Significance Letter": lg.get('letter'),
                        "Test Selection": test_type,
                        "Normality (All Groups)": all_normal,
                        "Homogeneity (Levene)": homogeneous,
                        "Overall p-value": overall_p,
                        "Mean": lg.get('mean'),
                        "Std Dev": lg.get('std'),
                        "N": lg.get('n')
                    })

            # 2. Process Detailed Pairwise
            if 'posthoc' in res:
                for ph in res['posthoc']:
                    pairwise_rows.append({
                        "Variable": var_name,
                        "Slice/Subset": slice_info,
                        "Comparison": f"{ph.get('group1')} vs {ph.get('group2')}",
                        "p-adj": ph.get('p_adj'),
                        "Significant": "Yes" if ph.get('significant') else "No"
                    })

        # Create DataFrames
        df_summary = pd.DataFrame(summary_rows)
        df_pairwise = pd.DataFrame(pairwise_rows)

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            if not df_summary.empty:
                df_summary.to_excel(writer, index=False, sheet_name='Summary Letters')
            if not df_pairwise.empty:
                df_pairwise.to_excel(writer, index=False, sheet_name='Detailed Pairwise')
            
            for sheetname in writer.sheets:
                _xl_auto_width(writer.sheets[sheetname])

        output.seek(0)
        return send_file(
            output,
            mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            as_attachment=True,
            download_name="Significance_Report_With_Assumptions.xlsx"
        )

    except Exception as e:
        print(f"Excel Export Error: {str(e)}")
        return jsonify({"error": str(e)}), 500