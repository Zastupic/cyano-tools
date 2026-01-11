from flask import Blueprint, render_template, request, flash, redirect
import os, base64, io, time
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from openpyxl.drawing.image import Image
from scipy.interpolate import UnivariateSpline, LSQUnivariateSpline
from scipy.ndimage import gaussian_filter1d     
from . import UPLOAD_FOLDER
from werkzeug.utils import secure_filename
import time

OJIP_data_analysis = Blueprint('OJIP_data_analysis', __name__)

@OJIP_data_analysis.route('/OJIP_data_analysis', methods=['GET', 'POST'])
def analyze_OJIP_curves():     
    if request.method == "POST": 
        # Define global variables
        max_number_of_files = 50
        OJIP_file_MULTI_COLOR_PAM = OJIP_file_Aquapen = Summary_file = OJIP_param_all = pd.DataFrame()
        raw_curves_reconstructed = differences_1 = differences_2 = pd.DataFrame()
        Raw_curves_reconstructed_DF = Residuals_DF = Differences_1_DF = Differences_2_DF = Inflection_times_DF = pd.DataFrame()
        Area_above_curve_temp_O_J = Area_above_curve_temp_J_I = Area_above_curve_temp_I_P = Area_above_curve_temp_O_P = pd.DataFrame()
        AREAOJ = AREAJI = AREAIP = AREAOP = FJ = FI = pd.Series()      
        FJ_TIMES_IDENTIFIED_DERIV = FI_TIMES_IDENTIFIED_DERIV = FP_TIMES_IDENTIFIED_DERIV = pd.Series()      
        FJ_TIMES_IDENTIFIED_INFLECTION = FI_TIMES_IDENTIFIED_INFLECTION = FP_TIMES_IDENTIFIED_INFLECTION = pd.Series() 
        ALLOWED_EXTENSIONS_MULTI_COLOR_PAM = set(['.csv', '.CSV'])
        ALLOWED_EXTENSIONS_AQUAPEN = ALLOWED_EXTENSIONS_FL6000 = set(['.txt']) 
        files_extensions = set()
        upload_folder = UPLOAD_FOLDER
        OJIP_plot_from_memory = OJIP_parameters_from_memory = fluorescence = ()  
        memory_for_OJIP_plot = memory_for_OJIP_parameters = idx_FJ = None
        xlsx_file_path = x_axis_time = x_axis_unit = y_axis_unit = file_name_without_extension = str('')   
        F0_index = F_50us_index = FK_300us_index = FJ_index = FI_index = knots_reduction_factor = int()
        F_50_ms_index = F_100_ms_index = F_200_ms_index = F_300_ms_index = Fm_index = int()
        FJ_found_index_low = FJ_found_index_high = FI_found_index_low = FI_found_index_high = FP_found_index_low = FP_found_index_high = FJ_found_index = FI_found_index = FP_found_index = int()
        FJ_time = FI_time = FJ_time_min = FJ_time_max = FI_time_min = FI_time_max = FP_time_min = FP_time_max = xmin_for_plot = float()
        fm_timings = {}
        # create upload directory, if there is not any
        if os.path.isdir(upload_folder) == False:
            os.mkdir(upload_folder)
        #######################
        ### Load OJIP files ###
        #######################
        # check if some file is selected
        if 'OJIP_files' in request.files:
            # get the current time
            current_time = time.time()
            # get list of files
            files = request.files.getlist("OJIP_files")
            # check if at least one file is selected
            if secure_filename(files[0].filename) == '': # type: ignore
                flash('Please select one or more files to analyze.', category='error') 
            else:
                # get info on fluorometer
                fluorometer = (request.form.get('fluorometer'))
                knots_reduction_factor = (int(str(request.form.get('knots_reduction_factor'))))
                # Check if FJ is lower than FI
                if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                    FJ_time = (float(str(request.form.get('FJ_time'))))
                    FI_time = (float(str(request.form.get('FI_time')))) 
                elif fluorometer == 'Aquapen':
                    FJ_time = (float(str(request.form.get('FJ_time')))) * 1000
                    FI_time = (float(str(request.form.get('FI_time')))) * 1000
                elif fluorometer == 'FL6000':
                    FJ_time = (float(str(request.form.get('FJ_time')))) / 1000
                    FI_time = (float(str(request.form.get('FI_time')))) / 1000             
                if FJ_time < FI_time:
                    # Define fluorometer-dependent variables
                    if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                        x_axis_time = 'time/ms'
                        x_axis_unit = "Time (ms)"
                        y_axis_unit = "Fluorescence intensity (V)"
                        FJ_time_min = 0.1  # (float(str(request.form.get('FJ_time_min')))) 
                        FJ_time_max = 10   # (float(str(request.form.get('FJ_time_max')))) 
                        FI_time_min = 10   # (float(str(request.form.get('FI_time_min')))) 
                        FI_time_max = 100  # (float(str(request.form.get('FI_time_max')))) 
                        FP_time_min = 100  # (float(str(request.form.get('FP_time_min')))) 
                        FP_time_max = 1000 # (float(str(request.form.get('FP_time_max')))) 
                        xmin_for_plot = 10**-2
                    elif fluorometer == 'Aquapen':
                        x_axis_time = 'time_us'
                        x_axis_unit = "Time (μs)"
                        y_axis_unit = "Fluorescence intensity (a.u.)"
                        FJ_time_min = 0.1 * 1000  # (float(str(request.form.get('FJ_time_min')))) 
                        FJ_time_max = 10 * 1000   # (float(str(request.form.get('FJ_time_max')))) 
                        FI_time_min = 10 * 1000   # (float(str(request.form.get('FI_time_min')))) 
                        FI_time_max = 100 * 1000  # (float(str(request.form.get('FI_time_max')))) 
                        FP_time_min = 100 * 1000  # (float(str(request.form.get('FP_time_min')))) 
                        FP_time_max = 1000 * 1000 # (float(str(request.form.get('FP_time_max')))) 
                    elif fluorometer == 'FL6000':
                        x_axis_time = 'time_s'
                        x_axis_unit = "Time (s)"
                        y_axis_unit = "Fluorescence intensity (a.u.)"
                        FJ_time_min = 0.1 / 1000  # (float(str(request.form.get('FJ_time_min')))) 
                        FJ_time_max = 10 / 1000   # (float(str(request.form.get('FJ_time_max')))) 
                        FI_time_min = 10 / 1000   # (float(str(request.form.get('FI_time_min')))) 
                        FI_time_max = 100 / 1000  # (float(str(request.form.get('FI_time_max')))) 
                        FP_time_min = 100 / 1000  # (float(str(request.form.get('FP_time_min')))) 
                        FP_time_max = 1000 / 1000 # (float(str(request.form.get('FP_time_max'))))                         
                        xmin_for_plot = 10**-5
                    # Check if number of selected files is within the set limit
                    if len(files) <= max_number_of_files:
                        file_number = 0
                        # do for each file  
                        for file in files:
                            # get image names and extension
                            file_name_without_extension = str.lower(os.path.splitext(file.filename)[0]) # type: ignore # for single image: image = (request.files['image']) 
                            file_extension = str.lower(os.path.splitext(file.filename)[1]) # type: ignore
                            file_name_full = secure_filename(file.filename) # type: ignore
                            # append all extensions to a set
                            files_extensions.add(file_extension)
                            #####################################
                            ### Process MULTI-COLOR-PAM FILES ###
                            #####################################
                            # Do for MULTI-COLOR-PAM files
                            if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                                # Check if each file is of allowed type
                                if file_extension in ALLOWED_EXTENSIONS_MULTI_COLOR_PAM:
                                    # read csv file directly, without uploading to server
                                    OJIP_file_MULTI_COLOR_PAM = pd.read_csv(files[(file_number)], sep=';', engine='python')  # type: ignore
                                    # Validate if the first column is named 'time/ms'
                                    if str(OJIP_file_MULTI_COLOR_PAM.columns[0]) != 'time/ms':
                                        flash(f"The file '{file_name_full}' does not appear to be a valid MULTI-COLOR-PAM / Dual PAM data file. "
                                              "The first column header should be 'time/ms'. Please select a correct file.", category='error')
                                        # Stop processing this file and redirect
                                        return redirect(request.url)
                                    # Merge all data in the final dataframe
                                    if file_number == 0:
                                        # initiate final dataframe
                                        Summary_file = OJIP_file_MULTI_COLOR_PAM.iloc[:,0:2]
                                        # rename column with fluorescence values as file name
                                        Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True)
                                    elif file_number > 0:
                                        # read fluorescence, as 2nd column in all other files
                                        OJIP_file_MULTI_COLOR_PAM = OJIP_file_MULTI_COLOR_PAM.iloc[:,1:2]
                                        # merge the fluorescence column with the final dataframe
                                        Summary_file = pd.concat([Summary_file, OJIP_file_MULTI_COLOR_PAM], axis = 1)
                                        # rename the newly added column
                                        Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True)
                            #############################
                            ### Process AQUAPEN FILES ###
                            #############################
                            # Do for AquaPen / FluorPen files
                            elif fluorometer == 'Aquapen':
                                # Check if each file is of allowed type
                                if file_extension in ALLOWED_EXTENSIONS_AQUAPEN:
                                    # to read .txt files, the files need to be first uploaded to server
                                    file.save(os.path.join(upload_folder, file_name_full).replace("\\","/"))
                                    # read .txt files
                                    with open(upload_folder+file_name_full, "r") as temp_variable:
                                        # read the txt file 
                                        OJIP_file_Aquapen = temp_variable.readlines() # reading without header: add [9:]
                                        OJIP_file_Aquapen = pd.DataFrame(OJIP_file_Aquapen)
                                        OJIP_file_Aquapen = OJIP_file_Aquapen[0].str.split('\t', expand=True)
                                        # Check if 'Fluorpen' is present in the first column
                                        if not OJIP_file_Aquapen[0].astype(str).str.strip().str.contains('FluorPen|AquaPen', case=False).any():
                                            flash(f"The file '{file_name_full}' does not appear to be a valid FluorPen/AquaPen data file. "
                                                  "The first column should contain 'FluorPen'. Please ensure you selected correct files and fluorometers for analysis.", category='error')
                                            return redirect(request.url)
                                        # Merge all data in the final dataframe
                                        if file_number == 0:
                                            Summary_file = OJIP_file_Aquapen[OJIP_file_Aquapen.columns[:-1]] # initiate final dataframe + drop the last column win '\n' only
                                            Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True) # rename column with fluorescence values according to file name
                                            Summary_file.rename(columns = {Summary_file.columns[0]: 'time_us'}, inplace = True) # rename first column
                                        else:
                                            # read fluorescence, as 2nd column in all other files
                                            fluorescence = OJIP_file_Aquapen.iloc[:,1:2]
                                            # merge the fluorescence column with the final dataframe
                                            Summary_file = pd.concat([Summary_file, fluorescence], axis = 1)
                                            # rename the newly added column
                                            Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True)                                          
                                    # Wait briefly before deleting (gives Windows time to release the file handle)
                                    time.sleep(0.1)
                                    # Delete the uploaded file
                                    os.remove(os.path.join(upload_folder, file_name_full).replace("\\","/"))      
                            #############################
                            ### Process FL 6000 FILES ###
                            #############################
                            # Do for AquaPen / FluorPen files
                            elif fluorometer == 'FL6000':
                                # Check if each file is of allowed type
                                if file_extension in ALLOWED_EXTENSIONS_FL6000:
                                    # to read .txt files, the files need to be first uploaded to server
                                    file.save(os.path.join(upload_folder, file_name_full).replace("\\","/"))
                                    # read .txt files
                                    with open(upload_folder+file_name_full, "r") as temp_variable:
                                        # read the txt file 
                                        OJIP_file_FL6000 = temp_variable.readlines() # reading without header: add [9:]
                                        OJIP_file_FL6000 = pd.DataFrame(OJIP_file_FL6000)
                                        OJIP_file_FL6000 = OJIP_file_FL6000[0].str.split('\t', expand=True)
                                        OJIP_file_FL6000 = OJIP_file_FL6000.iloc[:, :2] # Select only first two columns - time and fluo values
                                        # Check if 'Fluorometer' is present in the first column
                                        if not OJIP_file_FL6000[0].astype(str).str.strip().str.contains('Fluorometer', case=False).any():
                                            flash(f"The file '{file_name_full}' does not appear to be a valid FL6000 data file. "
                                                  "The first column should contain 'Fluorometer'. Please ensure you selected correct files and fluorometers for analysis.", category='error')
                                            return redirect(request.url)
                                        # Find the index where the first column equals 'Time\n' (or 'Time' after stripping)
                                        start_idx = OJIP_file_FL6000[OJIP_file_FL6000[0].str.strip() == 'Time'].index[0] + 1
                                        # Keep only rows from that index onward
                                        OJIP_file_FL6000 = OJIP_file_FL6000.iloc[start_idx:].reset_index(drop=True)
                                        # Merge all data in the final dataframe
                                        if file_number == 0:
                                            Summary_file = OJIP_file_FL6000 # initiate final dataframe + drop the last column win '\n' only
                                            Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True) # rename column with fluorescence values according to file name
                                        else:
                                            # read fluorescence, as 2nd column in all other files
                                            fluorescence = OJIP_file_FL6000.iloc[:,1:2]
                                            # merge the fluorescence column with the final dataframe
                                            Summary_file = pd.concat([Summary_file, fluorescence], axis = 1)
                                            # rename the newly added column
                                            Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True)       
                                    # Wait briefly before deleting (gives Windows time to release the file handle)
                                    time.sleep(0.1)
                                    # Delete the uploaded file
                                    os.remove(os.path.join(upload_folder, file_name_full).replace("\\","/"))
                            file_number = file_number + 1         
                        ### check if correct file types were selected ###
                        if (fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' and '.csv' in files_extensions) or (fluorometer == ('Aquapen') and '.txt' in files_extensions) or (fluorometer == ('FL6000') and '.txt' in files_extensions):
                            #############################################################################
                            ### Remove all excessive parameters and characters and keep only F values ###
                            #############################################################################
                            if fluorometer == 'Aquapen':
                                # Delete lines without numbers within the final dataframe
                                check = pd.DataFrame(Summary_file.time_us.str.isnumeric())
                                check.rename(columns={check.columns[0]: "A" }, inplace = True)
                                # Remove all rows in 'Summary_file' according to 'False' values in 'check' DF
                                Summary_file = Summary_file[check.A]
                                # Remove first row in the 'Summary_file' DF
                                Summary_file = Summary_file.iloc[1:, :]
                                # convert df to numeric
                                Summary_file = Summary_file.astype(int) # type: ignore
                            elif fluorometer == 'FL6000':
                                # Ensure the first column is named 'time_s' and is float, and all other columns are float
                                Summary_file.rename(columns={Summary_file.columns[0]: 'time_s'}, inplace=True)
                                # Only convert fluorescence columns to float (not time)
                                for col in Summary_file.columns[0:]:
                                    Summary_file[col] = pd.to_numeric(Summary_file[col], errors='coerce')
                                Summary_file = Summary_file.dropna(subset=['time_s'])
                            #################################################
                            ### Reduce file size of MULTI-COLOR PAM FILES ###
                            #################################################
                            if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                                # check if user wishes to reduce data size (if checkbox is checked)
                                if request.form.get("checkbox_reduce_file_size") == 'checked':
                                    # locate F0 
                                    F0_index = Summary_file[x_axis_time].sub(0.01).abs().idxmin() 
                                    # get rid of data before F0 + reset index + drop old index
                                    Summary_file = Summary_file.iloc[F0_index:, :]
                                    Summary_file.reset_index(inplace = True)
                                    Summary_file = Summary_file.drop('index', axis=1)
                                    # locate FI 
                                    FI_30_ms_index = Summary_file[x_axis_time].sub(30).abs().idxmin()
                                    # get data to reduce
                                    Summary_file_FI_to_FM = Summary_file.iloc[FI_30_ms_index:, :]
                                    # keep data betwen F0 and FI untouched
                                    Summary_file_F0_to_FI = Summary_file.iloc[:FI_30_ms_index, :]
                                    # calculate factor for data reduction - to keep around 1000 lines in the final df
                                    reduction_factor = int(len(Summary_file.index) / 500)
                                    # Exclude every nth row starting from 0
                                    Summary_file = Summary_file_FI_to_FM[::reduction_factor]
                                    # Merge F0-FI untouched with reduced data
                                    Summary_file = pd.concat([Summary_file_F0_to_FI, Summary_file])
                                    # Reset index and drop old index
                                    Summary_file.reset_index(inplace = True)
                                    Summary_file = Summary_file.drop('index', axis=1)                       
                            ##############################      
                            ### Normalize OJIP curves  ###
                            ##############################
                            # Find F0 and FM indexes
                            if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                                F0_index = Summary_file[x_axis_time].sub(0.01).abs().idxmin() # locate F0 for MC-PAM
                            elif fluorometer == 'Aquapen':
                                F0_index = Summary_file[x_axis_time].sub(0).abs().idxmin() # calculate F0 for Aquapen
                            elif fluorometer == 'FL6000':
                                # Always ensure the first column is named 'time' for FL6000
                                Summary_file.rename(columns={Summary_file.columns[0]: 'time_s'}, inplace=True)
                                F0_index = Summary_file[x_axis_time].sub(0).abs().idxmin() # calculate F0 for FL6000
                            # Find F0 and FM for all OJIP curves
                            F0 = (Summary_file.drop(x_axis_time, axis=1)).loc[F0_index]
                            FM = (Summary_file.drop(x_axis_time, axis=1)).max()
                            ########## Shift to F0 ######### 
                            # subtract F0 from all values in each column except of time
                            OJIP_shifted_to_zero = (Summary_file.drop(x_axis_time, axis=1)).subtract(F0, axis = 1)
                            # merge the subtracted DF with time 
                            OJIP_shifted_to_zero = pd.concat([Summary_file.iloc[:, 0], OJIP_shifted_to_zero], axis = 1)
                            ########## Shift to FM absolute ######### 
                            # Find absolute FM throughout all OJIP curves
                            FM_total = max(FM)
                            # shift all values in each column except of time to absolute FM
                            OJIP_shifted_to_max = (Summary_file.drop(x_axis_time, axis=1)).add(abs(FM.subtract(FM_total)), axis = 1)
                            # merge the subtracted DF with time 
                            OJIP_shifted_to_max = pd.concat([Summary_file.iloc[:, 0], OJIP_shifted_to_max], axis = 1)                       
                            ########## Double normalize ######### 
                            # Get FM values of OJIP curves shifted  to zero
                            FMFORNORMALIZATION = (OJIP_shifted_to_zero.drop(x_axis_time, axis=1)).max()
                            # normalize the DF to FM
                            OJIP_double_normalized = (OJIP_shifted_to_zero.drop(x_axis_time, axis=1)).div(FMFORNORMALIZATION, axis = 1)
                            # merge the normalized DF with time 
                            OJIP_double_normalized = pd.concat([Summary_file.iloc[:, 0], OJIP_double_normalized], axis = 1) 

                            #################################################    
                            ### Get derivatives, inflection points and R2 ###
                            #################################################
                            # Make x-axis logarithmic and without gaps (important for AquaPen)
                            time_axis_logarthmic = pd.DataFrame(np.geomspace(start=Summary_file.iloc[1,0], stop=Summary_file.iloc[-1,0], num=len(Summary_file))) # type: ignore
                            # Fit the OJIP curves
                            for i in range(len(OJIP_double_normalized.columns)):
                                if i > 0: # exclude time axis
                                    # Replicate + smoothen the OJIP curve
                                    knots = (UnivariateSpline(OJIP_double_normalized.iloc[1:,0], OJIP_double_normalized.iloc[1:,0], s=0)).get_knots()[::knots_reduction_factor]
                                    raw_curves_model = LSQUnivariateSpline(OJIP_double_normalized.iloc[1:,0], OJIP_double_normalized.iloc[1:,i], knots[1:-1], k=3)
                                    raw_curves_model.set_smoothing_factor(0.5)
                                    raw_curves_reconstructed = pd.DataFrame(gaussian_filter1d(raw_curves_model(time_axis_logarthmic.iloc[:, 0]), 20))
                                    # Calculate 1st drivative for each normalized OJIP curve
                                    differences_1 = pd.DataFrame(gaussian_filter1d(np.gradient(raw_curves_reconstructed.iloc[:,0]), 20))
                                    # Calculate 2nd drivative from 1st derivative
                                    differences_2 = pd.DataFrame(gaussian_filter1d(np.gradient(differences_1.iloc[:,0]), 20))
                                    # Calculate inflection points of the second derivative
                                    zero_crossings = np.where(np.diff(np.sign(differences_2.iloc[:,0])))[0]
                                    Inflection_times = pd.Series(time_axis_logarthmic.iloc[zero_crossings, 0]).reset_index(drop=True)
                                    # Append derivatives to DF
                                    Differences_1_DF = pd.concat([Differences_1_DF, differences_1], axis = 1)
                                    Differences_2_DF = pd.concat([Differences_2_DF, differences_2], axis = 1)
                                    Raw_curves_reconstructed_DF = pd.concat([Raw_curves_reconstructed_DF, raw_curves_reconstructed], axis = 1)
                                    # Append inflection points to DF
                                    if i == 1:
                                        Inflection_times_DF[file_name_without_extension] = Inflection_times
                                    else:
                                        Inflection_times_DF = pd.concat([Inflection_times_DF, Inflection_times], axis = 1)
                                # Append time
                            Differences_1_DF = pd.concat([time_axis_logarthmic.iloc[:, 0], Differences_1_DF], axis = 1)
                            Differences_2_DF = pd.concat([time_axis_logarthmic.iloc[:, 0], Differences_2_DF], axis = 1)
                            Raw_curves_reconstructed_DF = pd.concat([time_axis_logarthmic.iloc[:, 0], Raw_curves_reconstructed_DF], axis = 1)
                            # Rename columns
                            Differences_1_DF.columns = Summary_file.columns.values
                            Differences_2_DF.columns = Summary_file.columns.values
                            Raw_curves_reconstructed_DF.columns = Summary_file.columns.values 
                            Inflection_times_DF.columns = Summary_file.columns[1:].values                     
                            #####################    
                            ### Get residuals ###
                            #####################
                            Residuals_DF = pd.DataFrame() # A safety check - Residuals_DF contained some data, for some yet uknown reasons
                            for i in range(len(OJIP_double_normalized.columns)):
                                if i > 0: # exclude time axis
                                    # interpolate the reconstructed curves (log x-axis) based on measured x-axis
#                                    interpolated_values = pd.DataFrame(np.interp(OJIP_double_normalized.iloc[:,0],Raw_curves_reconstructed_DF.iloc[:,0],Raw_curves_reconstructed_DF.iloc[:,i]))
                                    interp_result = np.interp(x=np.array(OJIP_double_normalized.iloc[:, 0]),xp=np.array(Raw_curves_reconstructed_DF.iloc[:, 0]),fp=np.array(Raw_curves_reconstructed_DF.iloc[:, i]))
                                    interpolated_values = pd.DataFrame(interp_result.reshape(-1, 1))
                                    residuals = OJIP_double_normalized.iloc[:,i] - interpolated_values.iloc[:,0]
                                    # Append to DF
                                    Residuals_DF = pd.concat([Residuals_DF, residuals], axis = 1)
                            # Append time and rename columns
                            Residuals_DF = pd.concat([OJIP_double_normalized.iloc[:, 0], Residuals_DF], axis = 1)
                            Residuals_DF.columns = Summary_file.columns.values
                            ################################    
                            ### Find FJ, FI and FP times ###
                            ################################
                            # Define time ranges for FJ, FI and FP 
                            FJ_found_index_low = Differences_2_DF[x_axis_time].sub(FJ_time_min).abs().idxmin()
                            FJ_found_index_high = Differences_2_DF[x_axis_time].sub(FJ_time_max).abs().idxmin()
                            FI_found_index_low = Differences_2_DF[x_axis_time].sub(FI_time_min).abs().idxmin()
                            FI_found_index_high = Differences_2_DF[x_axis_time].sub(FI_time_max).abs().idxmin()
                            FP_found_index_low = Differences_2_DF[x_axis_time].sub(FP_time_min).abs().idxmin()
                            FP_found_index_high = Differences_2_DF[x_axis_time].sub(FP_time_max).abs().idxmin() 
                            ### Find min of 2nd deriv of fluo signal before FJ, FI, FP + append to pd.series ###
                            for i in range(len(Differences_2_DF.columns)):
                                if i > 0: # exclude time axis
                                    Min_2nd_deriv_pre_FJ = Differences_2_DF.iloc[:,i].loc[FJ_found_index_low: FJ_found_index_high].min()
                                    Index_min_2nd_deriv_pre_FJ = Differences_2_DF.iloc[:,i].sub(Min_2nd_deriv_pre_FJ).abs().idxmin()
                                    if pd.isna(Index_min_2nd_deriv_pre_FJ):
                                        flash('There seems to be a problem with the uploaded data. Please check data integrity before re-uploading the files.', category='error')
                                        return redirect(request.url) 
                                    Min_2nd_deriv_pre_FI = Differences_2_DF.iloc[:,i].loc[FI_found_index_low: FI_found_index_high].min()
                                    Index_min_2nd_deriv_pre_FI = Differences_2_DF.iloc[:,i].sub(Min_2nd_deriv_pre_FI).abs().idxmin()
                                    if pd.isna(Index_min_2nd_deriv_pre_FI):
                                        flash('There seems to be a problem with the uploaded data. Please check data integrity before re-uploading the files.', category='error')
                                        return redirect(request.url)  
                                    Min_2nd_deriv_pre_FP = Differences_2_DF.iloc[:,i].loc[FP_found_index_low: FP_found_index_high].min()
                                    Index_min_2nd_deriv_pre_FP = Differences_2_DF.iloc[:,i].sub(Min_2nd_deriv_pre_FP).abs().idxmin()
                                    if pd.isna(Index_min_2nd_deriv_pre_FP):
                                        flash('There seems to be a problem with the uploaded data. Please check data integrity before re-uploading the files.', category='error')
                                        return redirect(request.url)  
                                    # Get indexes of min of 2nd deriv of fluo signal before FJ, FI, FP
                                    FJ_found_index = int(Index_min_2nd_deriv_pre_FJ)
                                    FI_found_index = int(Index_min_2nd_deriv_pre_FI)
                                    FP_found_index = int(Index_min_2nd_deriv_pre_FP)
                                    FJ_found_time = Differences_2_DF[x_axis_time].iloc[FJ_found_index]
                                    FI_found_time = Differences_2_DF[x_axis_time].iloc[FI_found_index]
                                    FP_found_time = Differences_2_DF[x_axis_time].iloc[FP_found_index]
                                    # Append to pd.Series
                                    FJ_TIMES_IDENTIFIED_DERIV = pd.concat([FJ_TIMES_IDENTIFIED_DERIV, pd.Series(FJ_found_time)], axis=0)
                                    FI_TIMES_IDENTIFIED_DERIV = pd.concat([FI_TIMES_IDENTIFIED_DERIV, pd.Series(FI_found_time)], axis=0)
                                    FP_TIMES_IDENTIFIED_DERIV = pd.concat([FP_TIMES_IDENTIFIED_DERIV, pd.Series(FP_found_time)], axis=0)
                            # Rename
                            FJ_TIMES_IDENTIFIED_DERIV.index = F0.index
                            FI_TIMES_IDENTIFIED_DERIV.index = F0.index   
                            FP_TIMES_IDENTIFIED_DERIV.index = F0.index    
                            # Find closest higher values = FJ, FI, FP inflection points
                            Inflection_points_FJ = {
                                col: Inflection_times_DF[col][Inflection_times_DF[col] > val].min()
                                for col, val in FJ_TIMES_IDENTIFIED_DERIV.items()
                            }   
                            Inflection_points_FI = {
                                col: Inflection_times_DF[col][Inflection_times_DF[col] > val].min()
                                for col, val in FI_TIMES_IDENTIFIED_DERIV.items()
                            }    
                            Inflection_points_FP = {
                                col: Inflection_times_DF[col][Inflection_times_DF[col] > val].min()
                                for col, val in FP_TIMES_IDENTIFIED_DERIV.items()
                            }                       
                            FJ_TIMES_IDENTIFIED_INFLECTION = pd.Series(Inflection_points_FJ)
                            FI_TIMES_IDENTIFIED_INFLECTION = pd.Series(Inflection_points_FI)
                            FP_TIMES_IDENTIFIED_INFLECTION = pd.Series(Inflection_points_FP)

                            ############################
                            ### Calculate parameters ###
                            ############################
                            ### Find indexes of selected parameters
                            if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                                # find indexes of rows with closest value to individual points column
#                                F_20us_index = Summary_file[x_axis_time].sub(0.02).abs().idxmin()
                                F_50us_index = Summary_file[x_axis_time].sub(0.05).abs().idxmin()
#                                F_100us_index = Summary_file[x_axis_time].sub(0.1).abs().idxmin()
                                FK_300us_index = Summary_file[x_axis_time].sub(0.3).abs().idxmin()
                                F_50_ms_index = Summary_file[x_axis_time].sub(50).abs().idxmin()
                                F_100_ms_index = Summary_file[x_axis_time].sub(100).abs().idxmin()
                                F_200_ms_index = Summary_file[x_axis_time].sub(200).abs().idxmin()
                                F_300_ms_index = Summary_file[x_axis_time].sub(300).abs().idxmin()
                            elif fluorometer == 'Aquapen':
                                # find indexes of rows with closest value to individual points column
#                                F_20us_index = Summary_file[x_axis_time].sub(20).abs().idxmin()
                                F_50us_index = Summary_file[x_axis_time].sub(50).abs().idxmin()
#                                F_100us_index = Summary_file[x_axis_time].sub(100).abs().idxmin()
                                FK_300us_index = Summary_file[x_axis_time].sub(300).abs().idxmin()
                                F_50_ms_index = Summary_file[x_axis_time].sub(50000).abs().idxmin()
                                F_100_ms_index = Summary_file[x_axis_time].sub(100000).abs().idxmin()
                                F_200_ms_index = Summary_file[x_axis_time].sub(200000).abs().idxmin()
                                F_300_ms_index = Summary_file[x_axis_time].sub(300000).abs().idxmin()
                            elif fluorometer == 'FL6000':
                                F_50us_index = Summary_file[x_axis_time].sub(0.00005).abs().idxmin()
                                FK_300us_index = Summary_file[x_axis_time].sub(0.0003).abs().idxmin()
                                F_50_ms_index = Summary_file[x_axis_time].sub(0.05).abs().idxmin()
                                F_100_ms_index = Summary_file[x_axis_time].sub(0.1).abs().idxmin()
                                F_200_ms_index = Summary_file[x_axis_time].sub(0.2).abs().idxmin()
                                F_300_ms_index = Summary_file[x_axis_time].sub(0.3).abs().idxmin()
                            FJ_index = Summary_file[x_axis_time].sub(FJ_time).abs().idxmin()
                            FI_index = Summary_file[x_axis_time].sub(FI_time).abs().idxmin()
                            FJ = (Summary_file.drop(x_axis_time, axis=1)).loc[FJ_index]
                            FI = (Summary_file.drop(x_axis_time, axis=1)).loc[FI_index]                               
                            # get other parameters from indexes - as pd.series
                            F50 = (Summary_file.drop(x_axis_time, axis=1)).loc[F_50us_index]
                            FK = (Summary_file.drop(x_axis_time, axis=1)).loc[FK_300us_index]
                            FI = (Summary_file.drop(x_axis_time, axis=1)).loc[FI_index]
                            F50MS = (Summary_file.drop(x_axis_time, axis=1)).loc[F_50_ms_index]
                            F100MS = (Summary_file.drop(x_axis_time, axis=1)).loc[F_100_ms_index]
                            F200MS = (Summary_file.drop(x_axis_time, axis=1)).loc[F_200_ms_index]
                            F300MS = (Summary_file.drop(x_axis_time, axis=1)).loc[F_300_ms_index]
                            # calculate additional parameters
                            FV = FM - F0
                            FVFM = FV / FM
                            M0 = 4* (FK - F50) / FV # 4(F0.3ms – F0.05ms)/FV
                            VJ = (FJ - F0) / FV 
                            VI = (FI - F0) / FV
                            OJ = (FJ - F0)
                            JI = (FI - FJ)
                            IP = (FM - FI) 
                            PSIE0 = 1 - VJ # ET0/TR0 = ψE0 = 1 – VJ
                            PSIR0 = 1 - VI # RE0/TR0 = ψR0 = 1 – VI
                            DELTAR0 = PSIR0 / PSIE0 # RE0/ET0 = δR0 = ψR0/ψE0
                            PHIE0 = FVFM * PSIE0 # ET0/ABS = φE0 = φP0 × ψE0, with φP0 = FV/FM
                            PHIR0 = FVFM * PSIR0 # RE0/ABS = φR0 = φP0 × ψR0 
                            ABSRC = (M0 / VJ)/FVFM # ABS/RC = (M0/VJ)/φP0, with φP0 = FV/FM
                            TR0RC = M0 / VJ
                            ET0RC = TR0RC * PSIE0 # ET0/RC = (M0/VJ) × ψE0          
                            RE0RC = TR0RC * PSIR0 # RE0/RC = (M0/VJ) × ψR0
                            DI0RC = ABSRC - TR0RC # DI0/RC = ABS/RC – TR0/RC  
                            # calcualte area above and below curve
                            for i in range(len(Summary_file.columns)):
                                # do not plot time axis
                                if i > 0:
                                    Fm = 0 
                                    # identify time of P-peak: 
                                    if (F100MS.iloc[i-1].item()) < (F50MS.iloc[i-1].item()):
                                        Fm = (Summary_file.iloc[F_100_ms_index:, i]).max()
                                        Fm_index = Summary_file.iloc[F_100_ms_index:,i].sub(Fm).abs().idxmin()
                                        if (F200MS.iloc[i-1].item()) < (F100MS.iloc[i-1].item()):
                                            Fm = (Summary_file.iloc[F_200_ms_index:, i]).max()
                                            Fm_index = Summary_file.iloc[F_200_ms_index:,i].sub(Fm).abs().idxmin()
                                            if (F300MS.iloc[i-1].item()) < (F200MS.iloc[i-1].item()):
                                                Fm = (Summary_file.iloc[F_300_ms_index:, i]).max()
                                                Fm_index = Summary_file.iloc[F_300_ms_index:,i].sub(Fm).abs().idxmin()
                                    else:   
                                        Fm = (Summary_file.iloc[F_50_ms_index:, i]).max()
                                        Fm_index = Summary_file.iloc[F_50_ms_index:,i].sub(Fm).abs().idxmin()
                                    # find areas below curve
                                    area_below_curve_O_J = np.trapz(Summary_file.iloc[:FJ_index, i], Summary_file.iloc[:FJ_index, 0]) # (y, x)
                                    area_below_curve_J_I = np.trapz(Summary_file.iloc[FJ_index:FI_index, i], Summary_file.iloc[FJ_index:FI_index, 0]) # (y, x)                                
                                    area_below_curve_I_P = np.trapz(Summary_file.iloc[FI_index:Fm_index, i], Summary_file.iloc[FI_index:Fm_index, 0]) # (y, x) 
                                    area_below_curve_O_P = np.trapz(Summary_file.iloc[:Fm_index, i], Summary_file.iloc[:Fm_index, 0]) # (y, x)
                                    # find total areas below + above curve
                                    total_area_O_J = max(Summary_file.iloc[:FJ_index, 0]) * max(Summary_file.iloc[:Fm_index, i])
                                    total_area_J_I = (max(Summary_file.iloc[FJ_index:FI_index, 0]) - min(Summary_file.iloc[FJ_index:FI_index, 0])) * max(Summary_file.iloc[:Fm_index, i])
                                    total_area_I_P = (max(Summary_file.iloc[FI_index:Fm_index, 0]) - min(Summary_file.iloc[FI_index:Fm_index, 0])) * max(Summary_file.iloc[:Fm_index, i])
                                    total_area_O_P = max(Summary_file.iloc[:Fm_index, 0]) * max(Summary_file.iloc[:Fm_index, i])
                                    # calculate areas above curve
                                    area_above_curve_O_J = total_area_O_J - area_below_curve_O_J
                                    area_above_curve_J_I = total_area_J_I - area_below_curve_J_I
                                    area_above_curve_I_P = total_area_I_P - area_below_curve_I_P
                                    area_above_curve_O_P = total_area_O_P - area_below_curve_O_P
                                    # append area to series
                                    Area_above_curve_temp_O_J = pd.concat([Area_above_curve_temp_O_J, pd.Series(area_above_curve_O_J)], axis=0) # type: ignore
                                    Area_above_curve_temp_J_I = pd.concat([Area_above_curve_temp_J_I, pd.Series(area_above_curve_J_I)], axis=0) # type: ignore
                                    Area_above_curve_temp_I_P = pd.concat([Area_above_curve_temp_I_P, pd.Series(area_above_curve_I_P)], axis=0) # type: ignore
                                    Area_above_curve_temp_O_P = pd.concat([Area_above_curve_temp_O_P, pd.Series(area_above_curve_O_P)], axis=0) # type: ignore
                            # get colnames for reindexing 
                            file_names = list(Summary_file.iloc[:,1:].columns)
                            # get indexes for AREAS
                            Area_above_curve_temp_O_J.index = file_names # type: ignore
                            Area_above_curve_temp_J_I.index = file_names # type: ignore
                            Area_above_curve_temp_I_P.index = file_names # type: ignore
                            Area_above_curve_temp_O_P.index = file_names # type: ignore
                            AREAOJ = Area_above_curve_temp_O_J.squeeze() # type: ignore # squeeze: converts DF to SERIES
                            AREAJI = Area_above_curve_temp_J_I.squeeze() # type: ignore # squeeze: converts DF to SERIES
                            AREAIP = Area_above_curve_temp_I_P.squeeze() # type: ignore # squeeze: converts DF to SERIES
                            AREAOP = Area_above_curve_temp_O_P.squeeze() # type: ignore # squeeze: converts DF to SERIES
                            SM = AREAOP / FVFM # type: ignore
                            N = SM * M0 * (1 / VJ)
                            ######################
                            ### Find FM timing ###
                            ######################
                            for col, max_val in FM.items(): 
                                idx = Summary_file[Summary_file[col] == max_val].index[0] # Find the row index where FM occurs
                                fm_timings[col] = Summary_file.loc[idx, x_axis_time] # Get the corresponding time
                            FM_timings_series = pd.Series(fm_timings) # Convert to Series for clean display
                            # ================
                            # === PLOTTING ===
                            # =================
                            # HELPING FUNCTIONS FOR PLOTS 
                            def plot_dataframe_subplot(ax, df, colors, title, x_label, y_label, x_log=True, ylim=(None, None), vlines=None):
                                ax.set_title(title)
                                for i in range(1, df.shape[1]):
                                    ax.plot(df.iloc[:, 0], df.iloc[:, i], label=df.columns[i], color=colors[i - 1])
                                if x_log:
                                    ax.set_xscale("log")
                                ax.set_xlim(xmin=xmin_for_plot)
                                if ylim is not None:
                                    ymin, ymax = ylim
                                    ax.set_ylim(bottom=ymin, top=ymax)
                                if vlines:
                                    for x, props in vlines:
                                        ax.axvline(x=x, **props)
                                ax.grid(which='both', color='lightgray')
                                ax.set_xlabel(x_label)
                                ax.set_ylabel(y_label)

                            def plot_vertical_lines(ax, times, colors, linestyle=':', linewidth=1, label_first=None):
                                for i, t in enumerate(times):
                                    kwargs = dict(x=t, color=colors[i], ls=linestyle, lw=linewidth)
                                    if i == 0 and label_first:
                                        kwargs['label'] = label_first
                                    ax.axvline(**kwargs)
                            
                            def plot_vertical_lines_inflections(ax, times, colors, linestyle='-.', linewidth=1, label_first=None):
                                for i, t in enumerate(times):
                                    kwargs = dict(x=t, color=colors[i], ls=linestyle, lw=linewidth)
                                    if i == 0 and label_first:
                                        kwargs['label'] = label_first
                                    ax.axvline(**kwargs)

                            def plot_bar_subplot(ax, df_or_series, colors, title, ylabel=None, legend=False):
                                if isinstance(df_or_series, (float, np.floating, int, np.integer)):
                                    df_or_series = pd.Series([df_or_series])
                                df_or_series.plot.bar(ax=ax, xticks=[], color=colors)
                                ax.set_title(title)
                                if ylabel:
                                    ax.set_ylabel(ylabel)
                                if legend:
                                    ax.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02))
                                ax.set_xticks([])

                            # =========================
                            # === Plot OJIP Curves ====
                            # =========================
                            # --- Plot OJIP Curves (Subplots 1–15) ---
                            def plot_all_ojip_curves():
                                colors = plt.cm.nipy_spectral(np.linspace(0, 1, file_number + 1)) # type: ignore
                                fig = plt.figure(figsize=(17, 14))
                                fig.tight_layout()
                                fig.subplots_adjust(hspace=0.6, wspace=0.3)
                                plt.rcParams['mathtext.default'] = 'regular'
                                # Plot raw data (subplot 1)
                                plot_dataframe_subplot(fig.add_subplot(5, 4, 1), Summary_file, colors, "OJIP curves: raw data", x_axis_unit, y_axis_unit)
                                # Shifted to zero (subplot 2)
                                plot_dataframe_subplot(fig.add_subplot(5, 4, 2), OJIP_shifted_to_zero, colors, "OJIP curves: shifted to zero", x_axis_unit, y_axis_unit, ylim=(0, None))
                                # Shifted to Fm (subplot 3)
                                plot_dataframe_subplot(fig.add_subplot(5, 4, 3), OJIP_shifted_to_max, colors, "OJIP curves: shifted to Fm", x_axis_unit, y_axis_unit,
                                                       ylim=(0, None) if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' else (None, None))
                                # Double normalized (subplot 5)
                                plot_dataframe_subplot(fig.add_subplot(5, 4, 5), OJIP_double_normalized, colors, "OJIP curves: double normalized", x_axis_unit, "Fluorescence intensity (r.u.)",
                                                       ylim=(0, 1.1), vlines=[(FJ_time, {'color': '0', 'ls': '--', 'lw': 1}), (FI_time, {'color': '0', 'ls': '--', 'lw': 1})])
                                
                                # Reconstructed curves (subplot 6)
                                plot_dataframe_subplot(fig.add_subplot(5, 4, 6), Raw_curves_reconstructed_DF, colors, "Reconstructed curves (double normalized)", x_axis_unit, "Fluorescence intensity (r.u.)",
                                                       ylim=(0, 1.1), vlines=[(FJ_time, {'color': '0', 'ls': '--', 'lw': 1}), (FI_time, {'color': '0', 'ls': '--', 'lw': 1})])
                                # Residuals (subplot 7)
                                plot_dataframe_subplot(fig.add_subplot(5, 4, 7), Residuals_DF, colors, "Residuals of the reconstructed curves", f"{x_axis_unit} - lin", "Residuals (r.u.)", x_log=False)
                                # 2nd derivative + FJ (subplot 9)
                                ax = fig.add_subplot(5, 4, 9)
                                plot_dataframe_subplot(ax, Differences_2_DF, colors, "2$^{nd}$ derivative + F$_{J}$ timing", x_axis_unit, "2$^{nd}$ derivative")
                                ax.axvline(x=FJ_time, color='0', ls='--', lw=1, label='FJ time selected (used for calculations)')
                                plot_vertical_lines(ax, FJ_TIMES_IDENTIFIED_DERIV, colors)
                                plot_vertical_lines_inflections(ax, FJ_TIMES_IDENTIFIED_INFLECTION, colors)
                                # 2nd derivative + FI (subplot 10)
                                ax = fig.add_subplot(5, 4, 10)
                                plot_dataframe_subplot(ax, Differences_2_DF, colors, "2$^{nd}$ derivative + F$_{I}$ timing", x_axis_unit, "2$^{nd}$ derivative")
                                ax.axvline(x=FI_time, color='0.2', ls='--', lw=1, label='F$_{J}$/F$_{I}$ times used for calculations (selected by user)')
                                plot_vertical_lines_inflections(ax, FI_TIMES_IDENTIFIED_INFLECTION, colors, label_first=' Identified F$_{J}$/F$_{I}$/F$_{P}$ times (inflection points)')
                                plot_vertical_lines(ax, FI_TIMES_IDENTIFIED_DERIV, colors, label_first=' Min of 2nd Deriv of Fluo Signal Pre-F$_{J}$/F$_{I}$/F$_{P}$')
                                ax.legend(loc='upper left', bbox_to_anchor=(2.38, 4.28))
                                # 2nd derivative + FM (subplot 11)
                                ax = fig.add_subplot(5, 4, 11)
                                plot_dataframe_subplot(ax, Differences_2_DF, colors, "2$^{nd}$ derivative + F$_{P}$ timing", x_axis_unit, "2$^{nd}$ derivative")
                                plot_vertical_lines_inflections(ax, FP_TIMES_IDENTIFIED_INFLECTION, colors)
                                plot_vertical_lines(ax, FP_TIMES_IDENTIFIED_DERIV, colors)
                                # FJ bar plot (subplot 13)
                                plot_bar_subplot(fig.add_subplot(5, 4, 13), FJ_TIMES_IDENTIFIED_INFLECTION, colors, "F$_{J}$ times identified (only for visualization)", x_axis_unit)
                                # FI bar plot (subplot 14)
                                plot_bar_subplot(fig.add_subplot(5, 4, 14), FI_TIMES_IDENTIFIED_INFLECTION, colors, "F$_{I}$ times identified (only for visualization)")
                                # FP bar plot (subplot 15)
                                plot_bar_subplot(fig.add_subplot(5, 4, 15), FP_TIMES_IDENTIFIED_INFLECTION, colors, "F$_{P}$ times identified")
                                # FM bar plot (subplot 15)
                                plot_bar_subplot(fig.add_subplot(5, 4, 17), FM_timings_series, colors, "F$_{M}$ times identified")
                                
                                memory_for_OJIP_plot = io.BytesIO()
                                plt.savefig(memory_for_OJIP_plot, bbox_inches='tight', format='JPEG')
                                memory_for_OJIP_plot.seek(0)
                                OJIP_plot_in_memory = base64.b64encode(memory_for_OJIP_plot.getvalue())
                                OJIP_plot_from_memory = OJIP_plot_in_memory.decode('ascii')
                                plt.close()
                                return OJIP_plot_from_memory, memory_for_OJIP_plot
                            # Call the function to plot OJIP curves
                            OJIP_plot_from_memory, memory_for_OJIP_plot = plot_all_ojip_curves()
                            # ===============================
                            # === PLOT PARAMETERS - BARS ====
                            # ===============================
                            # --- Plot Parameter Bar Charts (Subplots 1–30) ---
                            def plot_all_parameter_bars():
                                colors = plt.cm.nipy_spectral(np.linspace(0, 1, file_number + 1)) # type: ignore 
                                fig = plt.figure(figsize=(26, 11))
                                fig.tight_layout()
                                plt.rcParams['mathtext.default'] = 'regular'
                                IP_list = pd.DataFrame([IP])

                                bar_data = [
                                    (1, F0, "F$_{in}$", y_axis_unit),
                                    (2, FJ, f"FJ at {(str(request.form.get('FJ_time')))} ms"),
                                    (3, FI, f"FI at {(str(request.form.get('FI_time')))} ms"),
                                    (4, FM, "F$_{max}$"),
                                    (5, OJ, "A$_{0-J}$"),
                                    (6, JI, "A$_{J-I}$"),
                                    (9, VJ, "V$_{J}$", "r.u."),
                                    (10, VI, "V$_{I}$"),
                                    (11, M0, "M$_{0}$"),
                                    (12, PSIE0, "ψE$_{0}$"),
                                    (13, PSIR0, "ψR$_{0}$"),
                                    (14, DELTAR0, "δR$_{0}$"),
                                    (15, FVFM, "φP$_{0}$ (F$_{v}$ / F$_{max}$)"),
                                    (17, PHIE0, "φE$_{0}$", "r.u."),
                                    (18, PHIR0, "φR$_{0}$"),
                                    (19, ABSRC, "ABS/RC"),
                                    (20, TR0RC, "TR0/RC"),
                                    (21, ET0RC, "ET0/RC"),
                                    (22, RE0RC, "RE0/RC"),
                                    (23, DI0RC, "DI0/RC"),
                                    (25, AREAOJ, "Area$_{0-J}$", "r.u."),
                                    (26, AREAJI, "Area$_{J-I}$"),
                                    (27, AREAIP, "Area$_{I-M}$"),
                                    (28, AREAOP, "Area$_{(0-M)}$"),
                                    (29, SM, "Normalized area S$_{m}$"),
                                    (30, N, "N (turn-over number Q$_{A}$)")
                                ]

                                for pos, data, title, *ylabel in bar_data:
                                    ax = fig.add_subplot(5, 8, pos)
                                    plot_bar_subplot(ax, data, colors, title, ylabel[0] if ylabel else None)

                                # Special bar plot for A$_{I-P}$ (subplot 7)
                                ax = fig.add_subplot(5, 8, 7)
                                for i in range(len(IP_list.columns)):
                                    ax.bar(IP_list.columns[i], IP_list.iloc[:, i], color=colors[i], width=0.5, label=IP_list.columns[i])
                                ax.set_title("A$_{I-M}$")
                                ax.margins(x=0.42 ** len(IP_list.columns))
                                ax.set_xticks([])
                                ax.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02))

                                memory_for_OJIP_parameters = io.BytesIO()
                                plt.savefig(memory_for_OJIP_parameters, bbox_inches='tight', format='JPEG')
                                memory_for_OJIP_parameters.seek(0)
                                OJIP_parameters_in_memory = base64.b64encode(memory_for_OJIP_parameters.getvalue())
                                OJIP_parameters_from_memory = OJIP_parameters_in_memory.decode('ascii')
                                plt.close()
                                return OJIP_parameters_from_memory, memory_for_OJIP_parameters
                            # Call the function to plot parameter bars
                            OJIP_parameters_from_memory, memory_for_OJIP_parameters = plot_all_parameter_bars()
                            #######################
                            ### Export to excel ###
                            #######################
                            # Optimized: Prepare DF with parameters by concatenating all at once
                            parameters_to_concat = [
                                F0, FK, FJ, FI, FM, OJ, JI, IP, VJ, VI, M0, PSIE0, PSIR0, DELTAR0, FVFM, PHIE0, PHIR0,
                                ABSRC, TR0RC, ET0RC, RE0RC, DI0RC, pd.Series(AREAOJ), pd.Series(AREAJI), pd.Series(AREAIP), pd.Series(AREAOP), # type: ignore
                                SM, N, FJ_TIMES_IDENTIFIED_INFLECTION, FI_TIMES_IDENTIFIED_INFLECTION, FP_TIMES_IDENTIFIED_INFLECTION,
                                FM_timings_series, FJ_TIMES_IDENTIFIED_DERIV, FI_TIMES_IDENTIFIED_DERIV, FP_TIMES_IDENTIFIED_DERIV]
                            OJIP_param_all = pd.concat(parameters_to_concat, axis=1)
                            # Name columns (this part is already efficient)
                            OJIP_param_all.columns = ['Fin', 'FK', 'FJ', 'FI', 'Fmax', 'Amplitude(0-J)', 'Amplitude(J-I)', 'Amplitude(I-P)', 'VJ', 'VI',
                                                      'M0', 'ψE0', 'ψR0', 'δR0', 'ψP0 (Fv/Fm)','φE0', 'φR0', 'ABS/RC', 'TR0/RC', 'ET0/RC',
                                                      'RE0/RC', 'DI0/RC', 'Complementary area O-J', 'Complementary area J-I', 'Complementary area I-P',
                                                      'Complementary area (O-P)','Normalized complementary area Sm', 'N (turn-over number QA)',
                                                      'Time FJ', 'Time FI', 'Time FP', 'Time FM', 'Time Min 2nd Deriv Pre-FJ', 
                                                      'Time Min 2nd Deriv Pre-FI', 'Time Min 2nd Deriv Pre-FP']

                            # Optimized: Write all dataframes and images in a single ExcelWriter context
                            excel_file_path = f'{upload_folder}/{file_name_without_extension}_results.xlsx'

                            # Use pd.ExcelWriter as a context manager for automatic saving and closing
                            # The 'with' statement ensures that writer.close() is called automatically, saving all changes (DataFrames and images) to the Excel file.
                            with pd.ExcelWriter(excel_file_path, engine='openpyxl') as writer:
                                # Write all dataframes to their respective sheets
                                OJIP_param_all.to_excel(writer, sheet_name = 'Parameters', index=True)
                                Summary_file.to_excel(writer, sheet_name = 'OJIP_raw', index=False)
                                OJIP_shifted_to_zero.to_excel(writer, sheet_name = 'OJIP_to_zero', index=False)
                                OJIP_shifted_to_max.to_excel(writer, sheet_name = 'OJIP_to_max', index=False)
                                OJIP_double_normalized.to_excel(writer, sheet_name = 'OJIP_norm', index=False)
                                Differences_1_DF.to_excel(writer, sheet_name = '1st_derivatives', index=False)
                                Differences_2_DF.to_excel(writer, sheet_name = '2nd_derivatives', index=False)
                                Raw_curves_reconstructed_DF.to_excel(writer, sheet_name = 'OJIP_reconstructed', index=False)
                                Residuals_DF.to_excel(writer, sheet_name = 'Residuals', index=False)
                                # Access the underlying openpyxl workbook object from the writer
                                wb = writer.book
                                # Create the 'Images' sheet and position it (e.g., as the first sheet)
                                # openpyxl's create_sheet will handle if a sheet with the same title exists by adding a number
                                # However, for consistency, we can check if it exists and create it at index 0 if not
                                if 'Images' not in wb.sheetnames:
                                    ws_images = wb.create_sheet(title='Images', index=0)
                                else:
                                    ws_images = wb['Images'] # Get the existing sheet
                                # Add images to the 'Images' sheet
                                img_curves = Image(memory_for_OJIP_plot)
                                img_parameters = Image(memory_for_OJIP_parameters)
                                img_curves.anchor = 'A1'
                                img_parameters.anchor = 'A60'
                                ws_images.add_image(img_curves)
                                ws_images.add_image(img_parameters)
                            # Save the Excel file path for rendering in the template
                            xlsx_file_path = f'uploads/{file_name_without_extension}_results.xlsx'  
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
                        else:
                            flash('Please select correct file types for analysis (.csv files for MULTI-COLOR-PAM / DUAL-PAM, .txt files for AquaPen / FluorPen / FL6000).', category='error')    
                    else:
                        flash(f'Please select up to {max_number_of_files} files.', category='error')                
                else:
                    flash(f'Please select FJ timing lower than FI timing', category='error')    
        else:
            flash('Please select .csv (MULTI-COLOR-PAM / DUAL-PAM) or .txt (AquaPen / FluorPen / FL6000) files.', category='error')
        return render_template("OJIP_analysis.html",
                        max_number_of_files = max_number_of_files,
                        OJIP_file_MULTI_COLOR_PAM = OJIP_file_MULTI_COLOR_PAM,
                        OJIP_file_Aquapen = OJIP_file_Aquapen,
                        OJIP_plot_from_memory = OJIP_plot_from_memory,
                        OJIP_parameters_from_memory = OJIP_parameters_from_memory,
                        xlsx_file_path = xlsx_file_path
                        )
    
    return render_template("OJIP_analysis.html")
