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
from openpyxl.drawing.image import Image as XLImage
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from scipy import stats
from statsmodels.stats.multicomp import pairwise_tukeyhsd
from statsmodels.stats.multitest import multipletests
from itertools import combinations
from typing import Any

# IMPORTANT: Check your app.py. If you use url_prefix='/stats',
# your JS must call '/stats/run-statistics'
stats_bp = Blueprint('statistics', __name__)

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

@stats_bp.route('/statistics', methods=['GET'])
def statistics_page():
    return render_template("statistics.html")

@stats_bp.route('/run-tests', methods=['POST'])
def run_tests():
    try:
        request_data = request.get_json()
        df = pd.DataFrame(request_data['data'])
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

            # Sort groups to ensure plot and calculations match
            unique_groups = sorted(clean_df['Group'].unique())

            for g_name in unique_groups:
                data = clean_df[clean_df['Group'] == g_name][var].astype(float)
                if len(data) >= 3:
                    stat, p = stats.shapiro(data)
                    is_normal = bool(p > 0.05)
                    normality_status[g_name] = is_normal
                    group_data.append(data.values)
                    shapiro_results.append({
                        "group": g_name, "stat": float(stat), "p": float(p), "is_normal": is_normal
                    })
                else:
                    normality_status[g_name] = True # Default color if too few points

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

            test_results.append({
                "variable": var,
                "plot_url": plot_url,
                "shapiro": shapiro_results,
                "levene": {"stat": float(l_stat) if l_stat else None,
                           "p": float(l_p) if l_p else None,
                           "is_homogeneous": is_homo}
            })

        return jsonify({"results": _sanitize(test_results)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@stats_bp.route('/run-statistics', methods=['POST'])
def run_analysis():
    try:
        request_data = request.get_json()
        df = pd.DataFrame(request_data['data'])
        factors = request_data.get('factors', [])
        selected_vars = request_data.get('target_columns', [])

        if not selected_vars:
            return jsonify({
                "all_columns": df.columns.tolist(),
                "variables": df.columns.tolist()
            })

        results = []
        for var in selected_vars:
            temp_df = df[factors + [var]].copy()
            temp_df[var] = pd.to_numeric(temp_df[var], errors='coerce')
            clean_df = temp_df.dropna(subset=[var]).copy()

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
            g.fig.suptitle(f"Analysis of {var} by {', '.join(factors)}", fontsize=12, fontweight='bold')
            g.ax.set_xlabel(factors[0], fontsize=11, fontweight='bold')
            g.ax.set_ylabel(var, fontsize=11, fontweight='bold')

            results.append({
                "variable": var,
                "summary": summary,
                "plot_url": get_plot_base64()
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

        output = io.BytesIO()
        with pd.ExcelWriter(output, engine='openpyxl') as writer:
            for res in results:
                # Clean sheet name (max 31 chars, no special chars)
                sheet_name = "".join([c for c in str(res['variable']) if c.isalnum() or c==' '])[:31]
                df_var = pd.DataFrame(res['summary'])
                df_var.to_excel(writer, sheet_name=sheet_name, index=False)

                ws = writer.sheets[sheet_name]
                img_data = base64.b64decode(res['plot_url'])
                img = XLImage(io.BytesIO(img_data))
                ws.add_image(img, f"A{len(df_var) + 4}")

        output.seek(0)
        return send_file(output, mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                         as_attachment=True, download_name='lab_report.xlsx')
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
        df = pd.DataFrame(request_data['data'])
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
    try:
        request_data = request.get_json()
        df = pd.DataFrame(request_data['data'])
        factors = request_data.get('factors', [])
        selected_vars = request_data.get('target_columns', [])
        grouping_mode = request_data.get('grouping_mode', 'all_combined')

        all_results = []

        for var in selected_vars:
            temp_df = df.copy()
            temp_df[var] = pd.to_numeric(temp_df[var], errors='coerce')
            clean_df = temp_df.dropna(subset=[var]).copy()
            if clean_df.empty:
                continue

            for f in factors:
                clean_df[f] = clean_df[f].astype(str).replace(['nan', 'None'], "N/A")

            # Parse grouping mode to determine slices
            if grouping_mode == 'all_combined':
                # Original behavior: combine all factors into one group label
                slices = [("All", clean_df, factors)]
            elif grouping_mode.startswith('across:'):
                # e.g. "across:Strain" → compare Strain levels, pooling all others
                compare_factor = grouping_mode.split(':', 1)[1]
                slices = [("All", clean_df, [compare_factor])]
            elif grouping_mode.startswith('per:'):
                # e.g. "per:Strain|Light" or "per:Strain|Light,Phase"
                parts = grouping_mode.split(':', 1)[1]
                compare_factor, stratify_str = parts.split('|', 1)
                stratify_factors = [s.strip() for s in stratify_str.split(',')]

                clean_df['_stratify_'] = clean_df[stratify_factors].agg(' | '.join, axis=1)
                slices = []
                for strat_val in sorted(clean_df['_stratify_'].unique()):
                    subset = clean_df[clean_df['_stratify_'] == strat_val].copy()
                    label = f"{' & '.join(stratify_factors)} = {strat_val}"
                    slices.append((label, subset, [compare_factor]))
            else:
                slices = [("All", clean_df, factors)]

            # Run ANOVA/post-hoc for each slice
            for slice_label, slice_df, group_factors in slices:
                if len(group_factors) > 1:
                    slice_df = slice_df.copy()
                    slice_df['Group'] = slice_df[group_factors].agg(' | '.join, axis=1)
                else:
                    slice_df = slice_df.copy()
                    slice_df['Group'] = slice_df[group_factors[0]]

                group_counts = slice_df['Group'].value_counts()
                valid_groups = group_counts[group_counts >= 3].index.tolist()

                if len(valid_groups) < 2:
                    continue

                group_data = {g: slice_df[slice_df['Group'] == g][var].values for g in valid_groups}
                data_list = list(group_data.values())
                group_names = list(group_data.keys())

                # === Assumptions ===
                shapiro_ps = [stats.shapiro(d)[1] for d in data_list if len(d) >= 3]
                all_normal = all(p > 0.05 for p in shapiro_ps) if shapiro_ps else False
                _, levene_p = stats.levene(*data_list) if len(data_list) > 1 else (None, 1.0)
                homogeneous = levene_p > 0.05

                result = {
                    "variable": var,
                    "slice_label": slice_label,
                    "comparing": " vs ".join(group_factors),
                    "test_used": "",
                    "overall_p": None,
                    "assumptions": {
                        "all_normal": bool(all_normal),
                        "homogeneous": bool(homogeneous)
                    },
                    "posthoc": [],
                    "letter_groups": []
                }

                if all_normal and homogeneous:
                    result["test_used"] = "One-way ANOVA + Tukey's HSD"
                    f_stat, p = stats.f_oneway(*data_list)
                    result["overall_p"] = float(p)
                    if p < 0.05:
                        all_values = np.concatenate(data_list)
                        all_groups = np.concatenate([[g] * len(d) for g, d in zip(group_names, data_list)])
                        tukey = pairwise_tukeyhsd(all_values, all_groups, alpha=0.05)
                        for row in tukey.summary().data[1:]:
                            g1, g2, _, p_adj, _, _, reject = row
                            result["posthoc"].append({
                                "group1": str(g1), "group2": str(g2),
                                "p_adj": float(p_adj), "significant": bool(reject)
                            })
                elif homogeneous:
                    result["test_used"] = "Kruskal–Wallis + Mann–Whitney (BH)"
                    _, p = stats.kruskal(*data_list)
                    result["overall_p"] = float(p)
                    if p < 0.05:
                        result["posthoc"] = _pairwise_posthoc(group_names, group_data, method='mannwhitneyu')
                elif all_normal:
                    result["test_used"] = "Welch's ANOVA + t-tests (BH)"
                    _, p = stats.f_oneway(*data_list)
                    result["overall_p"] = float(p)
                    result["posthoc"] = _pairwise_posthoc(group_names, group_data, method='welch_ttest')
                else:
                    result["test_used"] = "Kruskal–Wallis + Mann–Whitney (BH)"
                    _, p = stats.kruskal(*data_list)
                    result["overall_p"] = float(p)
                    if p < 0.05:
                        result["posthoc"] = _pairwise_posthoc(group_names, group_data, method='mannwhitneyu')

                # Assign letter groups from post-hoc results
                result["letter_groups"] = _assign_letter_groups(
                    group_names, group_data, result["posthoc"], var, slice_df
                )

                all_results.append(result)

        return jsonify({"results": _make_json_safe(all_results)})

    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


# ================== HELPER FUNCTIONS ==================

def _make_json_safe(obj):
    """Convert numpy types (bool_, float64, int64, etc.) to native Python types"""
    if isinstance(obj, np.generic):
        return obj.item()
    elif isinstance(obj, dict):
        return {k: _make_json_safe(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [_make_json_safe(item) for item in obj]
    elif isinstance(obj, tuple):
        return tuple(_make_json_safe(item) for item in obj)
    return obj


def _pairwise_posthoc(group_names, group_data, method='mannwhitneyu'):

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

    reject, p_adj, _, _ = multipletests(p_values, alpha=0.05, method='fdr_bh')

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

    # Build result sorted by mean descending
    result = []
    for g in sorted_groups:
        d = group_data[g]
        result.append({
            "group": str(g),
            "mean": float(np.mean(d)),
            "std": float(np.std(d, ddof=1)) if len(d) > 1 else 0.0,
            "n": int(len(d)),
            "letter": "".join(sorted(group_letters[g]))
        })

    return result