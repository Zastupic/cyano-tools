from flask import Blueprint, render_template, request, jsonify, send_file
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
import io
import base64
from openpyxl.drawing.image import Image as XLImage

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
            temp_df = df.copy()
            
            # FIX: Force the variable column to be numeric. 
            # 'coerce' turns text that isn't a number into NaN so it won't crash the mean/std calc.
            temp_df[var] = pd.to_numeric(temp_df[var], errors='coerce')
            
            # Drop rows where the measurement is missing or failed conversion
            clean_df = temp_df.dropna(subset=[var])
            
            if clean_df.empty:
                continue

            # Fill missing factor values with N/A to keep groups visible
            for f in factors:
                clean_df[f] = clean_df[f].fillna("N/A").astype(str)

            # 1. Calculation - This will no longer fail on 'dtype object'
            summary = clean_df.groupby(factors)[var].agg(['count', 'mean', 'std']).reset_index()
            
            # 2. Plotting (catplot creates its own figure)
            plot_params = {
                "kind": "box", "data": clean_df, "x": factors[0], "y": var,
                "showfliers": False, "palette": "viridis", "height": 5, "aspect": 1.2
            }
            if len(factors) > 1: plot_params["hue"] = factors[1]
            if len(factors) > 2: plot_params["col"] = factors[2]

            g = sns.catplot(**plot_params)
            
            # Overlay Swarm
            hue_val = factors[1] if len(factors) > 1 else None
            g.map_dataframe(sns.swarmplot, x=factors[0], y=var, hue=hue_val, 
                            dodge=True, color=".25", size=3, alpha=0.6)

            g.fig.subplots_adjust(top=0.85)
            g.fig.suptitle(f"Analysis: {var}", fontsize=14)
            
            results.append({
                "variable": var,
                "summary": summary.replace({np.nan: None}).to_dict(orient='records'),
                "plot_url": get_plot_base64()
            })
            plt.close('all')

        return jsonify({"mode": "results", "factors": factors, "results": results})
    except Exception as e:
        print(f"Backend Error: {str(e)}") 
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