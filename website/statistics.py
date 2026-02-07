from flask import Blueprint, render_template, request, jsonify, send_file
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as patches # Required for Ellipse
import matplotlib.transforms as transforms # Required for Ellipse rotation
import seaborn as sns
import io
import base64
from openpyxl.drawing.image import Image as XLImage
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from scipy import stats

# IMPORTANT: Check your app.py. If you use url_prefix='/stats',
# your JS must call '/stats/run-statistics'
stats_bp = Blueprint('statistics', __name__)

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
                data = clean_df[clean_df['Group'] == g_name][var]
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

        return jsonify({"results": test_results})
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

        return jsonify({"mode": "results", "factors": factors, "results": results})
    except Exception as e:
        import traceback
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

from typing import Any 
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
        import traceback
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

        results = []

        for var in selected_vars:
            # 1. Clean Data
            temp_df = df.copy()
            temp_df[var] = pd.to_numeric(temp_df[var], errors='coerce')
            clean_df = temp_df.dropna(subset=[var]).copy()

            if clean_df.empty: continue

            # 2. Prepare Groups (Same logic as other endpoints)
            if factors:
                for f in factors:
                    clean_df[f] = clean_df[f].astype(str).replace(['nan', 'None'], "N/A")
                clean_df['Group'] = clean_df[factors].agg(' | '.join, axis=1)
            else:
                clean_df['Group'] = 'All Data'

            # 3. Extract Arrays for Scipy (Only n >= 3)
            grouped_data = []
            valid_groups = clean_df['Group'].value_counts()
            valid_groups = valid_groups[valid_groups >= 3].index.tolist()

            for g in valid_groups:
                vals = clean_df[clean_df['Group'] == g][var].values
                grouped_data.append(vals)

            # 4. Run Tests
            anova_res = {"stat": None, "p": None}
            kruskal_res = {"stat": None, "p": None}

            if len(grouped_data) >= 2:
                # Parametric: One-Way ANOVA
                try:
                    f_stat, f_p = stats.f_oneway(*grouped_data)
                    anova_res = {"stat": float(f_stat), "p": float(f_p)}
                except: pass

                # Non-Parametric: Kruskal-Wallis
                try:
                    k_stat, k_p = stats.kruskal(*grouped_data)
                    kruskal_res = {"stat": float(k_stat), "p": float(k_p)}
                except: pass

            results.append({
                "variable": var,
                "anova": anova_res,
                "kruskal": kruskal_res
            })

        return jsonify({"results": results})
    except Exception as e:
        return jsonify({"error": str(e)}), 500