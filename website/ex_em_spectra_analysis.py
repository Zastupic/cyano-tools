from pickle import TRUE
from unicodedata import numeric
from flask import Blueprint, render_template, request, flash, redirect
import os, base64, io, time
from matplotlib import axis
import pandas as pd
import numpy as np
from . import UPLOAD_FOLDER
# from flask_login import current_user
from werkzeug.utils import secure_filename

ex_em_spectra_analysis = Blueprint('ex_em_spectra_analysis', __name__)

@ex_em_spectra_analysis.route('/ex_em_spectra_analysis', methods=['GET', 'POST'])
def analyze_ex_em_spectra():
#    if current_user.is_authenticated:
    if request.method == "POST": 
        # Define global variables
        max_number_of_files = 50
        upload_folder = UPLOAD_FOLDER
        files_extensions = set()
        excitation_wavelengths = []
        emission_wavelengths = []
        excitation_1 = excitation_2 = excitation_3 = excitation_4 = emission_1 = emission_2 = emission_3 = emission_4 = int()
        Index_Ex_1 = Index_Ex_2 = Index_Ex_3 = Index_Ex_4 = Index_Em_1 = Index_Em_2 = Index_Em_3 = Index_Em_4 = int()
        PBS_free_fluo = PBS_PSII_fluo = PBS_PSI_fluo = float()
        ALLOWED_EXTENSIONS = set(['.csv, .CSV, .xlsx, .XLSX'])
        xlsx_file_path = x_axis_unit = y_axis_unit = file_name_without_extension = file_name_full = str('')  
        # create upload directory, if there is not any
        if os.path.isdir(upload_folder) == False:
            os.mkdir(upload_folder)
        ################################################
        ### Read Excitations and Emissions from HTML ###
        ################################################
        # Collect selected EXCITATIONS: if the field is not empty 
        if str(request.form.get('ex_1')) != "": # request.form.get("checkbox_ex_1") == "checked" and (
            excitation_wavelengths.append(int(str(request.form.get('ex_1'))))
        if str(request.form.get('ex_2')) != "":
            excitation_wavelengths.append(int(str(request.form.get('ex_2'))))
        if str(request.form.get('ex_3')) != "":
            excitation_wavelengths.append(int(str(request.form.get('ex_3'))))
        if str(request.form.get('ex_4')) != "":
            excitation_wavelengths.append(int(str(request.form.get('ex_4'))))
        if str(request.form.get('ex_5')) != "":
            excitation_wavelengths.append(int(str(request.form.get('ex_5'))))
        if str(request.form.get('ex_6')) != "":
            excitation_wavelengths.append(int(str(request.form.get('ex_6'))))
        # Collect selected EMISSIONS: if the field is not empty  
        if str(request.form.get('em_1')) != "":
            emission_wavelengths.append(int(str(request.form.get('em_1'))))
        if str(request.form.get('em_2')) != "": 
            emission_wavelengths.append(int(str(request.form.get('em_2'))))
        if str(request.form.get('em_3')) != "":
            emission_wavelengths.append(int(str(request.form.get('em_3'))))
        if str(request.form.get('em_4')) != "":
            emission_wavelengths.append(int(str(request.form.get('em_4'))))
        if str(request.form.get('em_5')) != "":
            emission_wavelengths.append(int(str(request.form.get('em_5'))))
        if str(request.form.get('em_6')) != "":
            emission_wavelengths.append(int(str(request.form.get('em_6'))))            
        ##################
        ### Load files ###
        ##################
        # check if some file is selected
        if '77K_files' in request.files:
            # get list of files
            files = request.files.getlist("77K_files")
            spectrofluorometer = (request.form.get('spectrofluorometer'))
            # check if at least one file is selected
            if secure_filename(files[0].filename) == '': # type: ignore
                flash('Please select one or more files to analyze.', category='error')  
            else:
                # limit number of uploaded files
                if len(files) <= max_number_of_files:
                    file_number = 0
                    # do for each file
                    for file in files:
                        # get image names and extension
                        file_name_without_extension = str.lower(os.path.splitext(file.filename)[0]) # type: ignore 
                        file_extension = str.lower(os.path.splitext(file.filename)[1]) # type: ignore
                        file_name_full = secure_filename(file.filename) # type: ignore                  
                        # append all extensions to a set
                        files_extensions.add(file_extension)
                        if spectrofluorometer == 'FP-8050 Series Spectrofluorometers (Jasco Inc.)' and '.csv' in files_extensions:
                            ######################################
                            ### Read Excitations and Emissions ###
                            ######################################
                            # read csv file directly, without uploading to server: read only rows = results in full number of rows with a single column with values for all columns
                            Ex_Em_spectra_file = pd.read_csv(files[(file_number)], sep="\0", skip_blank_lines=True, header=None) # type: ignore                                     
                            # split the single column into multiple columns, according to the length of the file
                            Ex_Em_spectra_file = pd.DataFrame(np.concatenate([Ex_Em_spectra_file[col].str.split(pat=',', expand=True).add_prefix(col) for col in Ex_Em_spectra_file.columns]))
                            # get index of a row that contains 'XYDATA'
                            spectra_start_index = Ex_Em_spectra_file[Ex_Em_spectra_file[0].str.contains('XYDATA')].index.values.astype(int)[0]
                            # drop header and keep only the fluorescence values
                            Ex_Em_spectra_file =Ex_Em_spectra_file.iloc[(spectra_start_index+1):,:]
                            # Convert dataframe strings to numeric
                            Ex_Em_spectra_file = Ex_Em_spectra_file.apply(pd.to_numeric)
                            # Replace NA
                            Ex_Em_spectra_file = Ex_Em_spectra_file.fillna(0)
                            # reset index and drop first column 
                            Ex_Em_spectra_file.reset_index(inplace = True)
                            Ex_Em_spectra_file = Ex_Em_spectra_file.drop(Ex_Em_spectra_file.columns[0], axis=1) # drop('index', axis=1)

                            #######################################################
                            ### Validate selection of Excitations and Emissions ###
                            #######################################################   
                            # Check if the selected wavelength exist within the measured range
                            if (Ex_Em_spectra_file.iloc[0] == excitation_wavelengths[0]).any():
                                Index_Ex_1 = np.where(Ex_Em_spectra_file.iloc[0] == excitation_wavelengths[0])[0][0]
                            else:
                                flash('Please select wavelengths within the measured range.', category='error')
                                


#                            if request.form.get("checkbox_ex_440") == "checked":
#                                excitation_wavelengths.append(excitation_wavelengths_template[1])
#                                Index_Ex_440 = np.where(Ex_Em_spectra_file.iloc[0] == excitation_wavelengths_template[1])[0][0]
#                            if request.form.get("checkbox_ex_570") == "checked":
#                                excitation_wavelengths.append(excitation_wavelengths_template[2])
#                                Index_Ex_570 = np.where(Ex_Em_spectra_file.iloc[0] == excitation_wavelengths_template[2])[0][0]
#                            if request.form.get("checkbox_ex_620") == "checked":
#                                excitation_wavelengths.append(excitation_wavelengths_template[3])
#                                Index_Ex_620 = np.where(Ex_Em_spectra_file.iloc[0] == excitation_wavelengths_template[3])[0][0]
#                            # Check selected EMISSIONS
#                            if request.form.get("checkbox_em_662") == "checked":
#                                emission_wavelengths.append(emission_wavelengths_template[0])
#                                Index_Em_662 = int(np.where(Ex_Em_spectra_file[0] == emission_wavelengths_template[0])[0][0])
#                            if request.form.get("checkbox_em_689") == "checked":
#                                emission_wavelengths.append(emission_wavelengths_template[1])
#                                Index_Em_689 = np.where(Ex_Em_spectra_file[0] == emission_wavelengths_template[1])[0][0]
#                            if request.form.get("checkbox_em_724") == "checked":
#                                emission_wavelengths.append(emission_wavelengths_template[2])
#                                Index_Em_724 = np.where(Ex_Em_spectra_file[0] == emission_wavelengths_template[2])[0][0]
#                            # Get values of both EXCITATION + EMISSION fluorescence 
#                            if excitation_wavelengths_template[0] in excitation_wavelengths and emission_wavelengths_template[0] in emission_wavelengths:
#                                PBS_free_fluo = Ex_Em_spectra_file.iat[Index_Em_662, Index_Ex_370]
#                            if excitation_wavelengths_template[0] in excitation_wavelengths and emission_wavelengths_template[1] in emission_wavelengths:
#                                PBS_PSII_fluo = Ex_Em_spectra_file.iat[Index_Em_689, Index_Ex_370]
#                            if excitation_wavelengths_template[0] in excitation_wavelengths and emission_wavelengths_template[2] in emission_wavelengths:
#                                PBS_PSI_fluo = Ex_Em_spectra_file.iat[Index_Em_724, Index_Ex_370]
#
#                            else:
#                                flash('Please select correct wavelengths for analysis.', category='error')

                            print("Ex_Em_spectra_file "+str(type(Ex_Em_spectra_file))+" "+str(np.shape(Ex_Em_spectra_file))+": \n"+str(Ex_Em_spectra_file))  # type: ignore
                        
                            file_number = file_number + 1

                        else:
                            flash('Please select correct file types for analysis (.csv files for Jasco FP-8050 Series Spectrofluorometers).', category='error')                               
                else:
                    flash(f'Please select up to {max_number_of_files} files.', category='error')                
        else:
            flash('Please select .csv files for analysis.', category='error')
    return render_template("ex_em_spectra_analysis.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")