from flask import Blueprint, render_template, request, flash, redirect
import os, base64, io, time, csv
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from openpyxl.drawing.image import Image
from scipy.interpolate import UnivariateSpline, LSQUnivariateSpline
from scipy.ndimage import gaussian_filter1d     
from . import UPLOAD_FOLDER
from werkzeug.utils import secure_filename
import time

MIMS_data_analysis = Blueprint('MIMS_data_analysis', __name__)

@MIMS_data_analysis.route('/MIMS_data_analysis', methods=['GET', 'POST'])
def analyze_MIMS_data():
    if request.method == "POST": 
        # Define global variables
        MIMS_file = pd.DataFrame()
        upload_folder = UPLOAD_FOLDER
        file_name_without_extension = file_extension = file_name_full = str('')
        ALLOWED_EXTENSIONS_MIMS = set(['.csv', '.CSV'])
        # create upload directory, if there is not any
        if os.path.isdir(upload_folder) == False:
            os.mkdir(upload_folder)
        #######################
        ### Load MIMS files ###
        #######################
        # check if some file is selected
        if 'MIMS_file' in request.files:
            # get the current time
            current_time = time.time()
            # get file from the field
            file = (request.files['MIMS_file'])
            # check if at least one file is selected
            if secure_filename(file.filename) == '': # type: ignore
                flash('Please select a file to analyze.', category='error') 
                return redirect(request.url) 
            else:
                # get image names and extension
                file_name_without_extension = str.lower(os.path.splitext(file.filename)[0]) # type: ignore # for single image: image = (request.files['image']) 
                file_extension = str.lower(os.path.splitext(file.filename)[1]) # type: ignore
                file_name_full = secure_filename(file.filename) # type: ignore
                # Check if each file is of allowed type
                if file_extension in ALLOWED_EXTENSIONS_MIMS:
                    ############################
                    ### Ignoring file header ###
                    ############################
                    # Read file content into lines
                    file_content = file.stream.read().decode('utf-8').splitlines()
                    file.stream.seek(0)
                    # Find the line where header starts — look for the row where first two columns are "Time" and "ms"
                    header_row_index = None
                    for i, line in enumerate(file_content):
                        columns = [col.strip('" ').lower() for col in line.split(',')]
                        if len(columns) >= 2 and columns[0] == 'time' and columns[1] == 'ms':
                            header_row_index = i
                            break
                    if header_row_index is None:
                        flash('Could not find a valid data header starting with "Time, ms". Please check integrity of your data file.', category='error')
                        return redirect(request.url)
                    # Read the CSV using the correct header line
                    file.stream.seek(0)
                    MIMS_file = pd.read_csv(file, header=header_row_index, engine='python')  # type: ignore 
                    # Get rid of the last column with NaN
                    MIMS_file.dropna(axis=1, how='all', inplace=True)
                    # jsonify
                    MIMS_file_json = MIMS_file.to_json(orient='records')

# graph TD
# A[User uploads CSV (in browser)] --> B[Parse with JavaScript (FileReader or PapaParse)]
# B --> C[Preview data + choose normalization column]
# C --> D[Send parsed data + selected options to Flask]
# D --> E[Flask runs analysis, returns results]
# E --> F[Plot with Plotly.js or display tables]             

                    print(MIMS_file_json)

                    ######################################
                    ### Delete files older than 20 min ###
                    ######################################
                    # List all files
                    list_of_files_in_upload_folder = os.listdir(upload_folder)
                    # get number of seconds to reset
                    seconds = 1200
                    # scan for old files
                    for i in list_of_files_in_upload_folder:
                        # get the location of each file
                        file_location = os.path.join(upload_folder, str(i)).replace("\\","/")
                        # get time when the file was modified
                        file_time = os.stat(file_location).st_mtime
                        # if a file is modified before 20 min then delete it
                        if(file_time < current_time - seconds):
                            os.remove(os.path.join(upload_folder, str(i)).replace("\\","/")) 


    return render_template("MIMS_data_analysis.html")
