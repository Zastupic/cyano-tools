from flask import Blueprint, render_template, request, flash
import os, base64, io, time, openpyxl
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from scipy.interpolate import UnivariateSpline, LSQUnivariateSpline
from scipy.ndimage import gaussian_filter1d         
from openpyxl.drawing.image import Image
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
        Raw_curves_reconstructed_DF = Residuals_DF = Differences_1_DF = Differences_2_DF = pd.DataFrame()
        Area_above_curve_temp_O_J = Area_above_curve_temp_J_I = Area_above_curve_temp_I_P = Area_above_curve_temp_O_P = pd.DataFrame()
        AREAOJ = AREAJI = AREAIP = AREAOP = FJ_TIMES_IDENTIFIED = FI_TIMES_IDENTIFIED = FP_TIMES_IDENTIFIED = FJ = FI = pd.Series()      
        ALLOWED_EXTENSIONS_MULTI_COLOR_PAM = set(['.csv', '.CSV'])
        ALLOWED_EXTENSIONS_AQUAPEN = set(['.txt']) 
        files_extensions = set()
        upload_folder = UPLOAD_FOLDER
        OJIP_plot_from_memory = OJIP_parameters_from_memory = fluorescence = ()   
        xlsx_file_path = x_axis_time = x_axis_unit = y_axis_unit = file_name_without_extension = str('')   
        F0_index = F_50us_index = FK_300us_index = FJ_index = FI_index = knots_reduction_factor = int()
        F_50_ms_index = F_100_ms_index = F_200_ms_index = F_300_ms_index = Fm_index = int()
        FJ_found_index_low = FJ_found_index_high = FI_found_index_low = FI_found_index_high = FP_found_index_low = FP_found_index_high = FJ_found_index = FI_found_index = FP_found_index = int()
        FJ_time = FI_time = FJ_time_min = FJ_time_max = FI_time_min = FI_time_max = FP_time_min = FP_time_max = xmin_for_plot = float()
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
                # Define fluorometer-dependent variables
                if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                    x_axis_time = 'time/ms'
                    x_axis_unit = "Time (ms)"
                    y_axis_unit = "Fluorescence intensity (V)"
                    FJ_time = (float(str(request.form.get('FJ_time'))))
                    FI_time = (float(str(request.form.get('FI_time')))) 
                    FJ_time_min = 0.1  # (float(str(request.form.get('FJ_time_min')))) 
                    FJ_time_max = 10   # (float(str(request.form.get('FJ_time_max')))) 
                    FI_time_min = 10   # (float(str(request.form.get('FI_time_min')))) 
                    FI_time_max = 100  # (float(str(request.form.get('FI_time_max')))) 
                    FP_time_min = 100  # (float(str(request.form.get('FP_time_min')))) 
                    FP_time_max = 1000 # (float(str(request.form.get('FP_time_max')))) 
#                    knots_reduction_factor = 10
                    xmin_for_plot = 10**-2
                elif fluorometer == 'Aquapen':
                    x_axis_time = 'time_us'
                    x_axis_unit = "Time (μs)"
                    y_axis_unit = "Fluorescence intensity (a.u.)"
                    FJ_time = (float(str(request.form.get('FJ_time')))) * 1000
                    FI_time = (float(str(request.form.get('FI_time')))) * 1000
                    FJ_time_min = 0.1 * 1000  # (float(str(request.form.get('FJ_time_min')))) 
                    FJ_time_max = 10 * 1000   # (float(str(request.form.get('FJ_time_max')))) 
                    FI_time_min = 10 * 1000   # (float(str(request.form.get('FI_time_min')))) 
                    FI_time_max = 100 * 1000  # (float(str(request.form.get('FI_time_max')))) 
                    FP_time_min = 100 * 1000  # (float(str(request.form.get('FP_time_min')))) 
                    FP_time_max = 1000 * 1000 # (float(str(request.form.get('FP_time_max')))) 
#                    knots_reduction_factor = 10
                    xmin_for_plot = 10**1
                # limit number of uploaded files
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
                                OJIP_file_MULTI_COLOR_PAM = pd.read_csv(files[(file_number)], sep=';', engine='python') # type: ignore
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
                                    OJIP_file_Aquapen =  pd.DataFrame(OJIP_file_Aquapen)
                                    OJIP_file_Aquapen = OJIP_file_Aquapen[0].str.split('\t', expand=True)
                                    # Merge all data in the final dataframe
                                    if file_number == 0:
                                        # initiate final dataframe + drop the last column win '\n' only
                                        Summary_file = OJIP_file_Aquapen[OJIP_file_Aquapen.columns[:-1]]
                                        # rename column with fluorescence values according to file name
                                        Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True)
                                        # rename first column
                                        Summary_file.rename(columns = {Summary_file.columns[0]: 'time_us'}, inplace = True)
                                    else:
                                        # read fluorescence, as 2nd column in all other files
                                        fluorescence = OJIP_file_Aquapen.iloc[:,1:2]
                                        # merge the fluorescence column with the final dataframe
                                        Summary_file = pd.concat([Summary_file, fluorescence], axis = 1)
                                        # rename the newly added column
                                        Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True)                                          
                                # Delete the uploaded file
                                os.remove(os.path.join(upload_folder, file_name_full).replace("\\","/"))
                        file_number = file_number + 1               
                    ### check if correct file types were selected ###
                    if (fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' and '.csv' in files_extensions) or (fluorometer == 'Aquapen' and '.txt' in files_extensions):
                        ######################################################################
                        ### Remove parameters calculated by Aquapen and keep only F values ###
                        ######################################################################
                        if fluorometer == 'Aquapen':
                            # Delete lines without numbers within the final dataframe
                            check = pd.DataFrame(Summary_file.time_us.str.isnumeric())
                            check.rename(columns={ check.columns[0]: "A" }, inplace = True)
                            # Remove all rows in 'Summary_file' according to 'False' values in 'check' DF
                            Summary_file = Summary_file[check.A]
                            # Remove first row in the 'Summary_file' DF
                            Summary_file = Summary_file.iloc[1:, :]
                            # convert df to numeric
                            Summary_file = Summary_file.astype(int) # type: ignore
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
                        ##############################    
                        ### Get derivatives and R2 ###
                        ##############################
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
                                # Append derivatives to DF
                                Differences_1_DF = pd.concat([Differences_1_DF, differences_1], axis = 1)
                                Differences_2_DF = pd.concat([Differences_2_DF, differences_2], axis = 1)
                                Raw_curves_reconstructed_DF = pd.concat([Raw_curves_reconstructed_DF, raw_curves_reconstructed], axis = 1)
                        # Append time
                        Differences_1_DF = pd.concat([time_axis_logarthmic.iloc[:, 0], Differences_1_DF], axis = 1)
                        Differences_2_DF = pd.concat([time_axis_logarthmic.iloc[:, 0], Differences_2_DF], axis = 1)
                        Raw_curves_reconstructed_DF = pd.concat([time_axis_logarthmic.iloc[:, 0], Raw_curves_reconstructed_DF], axis = 1)
                        # Rename columns
                        Differences_1_DF.columns = Summary_file.columns.values
                        Differences_2_DF.columns = Summary_file.columns.values
                        Raw_curves_reconstructed_DF.columns = Summary_file.columns.values
                        #####################    
                        ### Get residuals ###
                        #####################
                        for i in range(len(OJIP_double_normalized.columns)):
                            if i > 0: # exclude time axis
                                # interpolate the reconstructed curves (log x-axis) based on measured x-axis
                                interpolated_values = pd.DataFrame(np.interp(OJIP_double_normalized.iloc[:,0],Raw_curves_reconstructed_DF.iloc[:,0],Raw_curves_reconstructed_DF.iloc[:,i])) 
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
                        # Find FJ, FI, FP + append to pd.series
                        for i in range(len(Differences_2_DF.columns)):
                            if i > 0: # exclude time axis
                                FJ_found = Differences_2_DF.iloc[:,i].loc[FJ_found_index_low: FJ_found_index_high].min()
                                FI_found = Differences_2_DF.iloc[:,i].loc[FI_found_index_low: FI_found_index_high].min()
                                FP_found = Differences_2_DF.iloc[:,i].loc[FP_found_index_low: FP_found_index_high].min()
                                FJ_found_index = int(Differences_2_DF.iloc[:,i].sub(FJ_found).abs().idxmin())
                                FI_found_index = int(Differences_2_DF.iloc[:,i].sub(FI_found).abs().idxmin())
                                FP_found_index = int(Differences_2_DF.iloc[:,i].sub(FP_found).abs().idxmin())
                                FJ_found_time = Differences_2_DF[x_axis_time].iloc[FJ_found_index]
                                FI_found_time = Differences_2_DF[x_axis_time].iloc[FI_found_index]
                                FP_found_time = Differences_2_DF[x_axis_time].iloc[FP_found_index]
                                # Append to pd.Series
                                FJ_TIMES_IDENTIFIED = pd.concat([FJ_TIMES_IDENTIFIED, pd.Series(FJ_found_time)], axis=0)
                                FI_TIMES_IDENTIFIED = pd.concat([FI_TIMES_IDENTIFIED, pd.Series(FI_found_time)], axis=0)
                                FP_TIMES_IDENTIFIED = pd.concat([FP_TIMES_IDENTIFIED, pd.Series(FP_found_time)], axis=0)
                        # Rename
                        FJ_TIMES_IDENTIFIED.index = F0.index
                        FI_TIMES_IDENTIFIED.index = F0.index   
                        FP_TIMES_IDENTIFIED.index = F0.index          
                        ############################
                        ### Calculate parameters ###
                        ############################
                        ### Find indexes of parameters for MULTI-COLOR-PAM
                        if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                            # find indexes of rows with closest value to individual points column
#                            F_20us_index = Summary_file[x_axis_time].sub(0.02).abs().idxmin()
                            F_50us_index = Summary_file[x_axis_time].sub(0.05).abs().idxmin()
#                            F_100us_index = Summary_file[x_axis_time].sub(0.1).abs().idxmin()
                            FK_300us_index = Summary_file[x_axis_time].sub(0.3).abs().idxmin()
                            F_50_ms_index = Summary_file[x_axis_time].sub(50).abs().idxmin()
                            F_100_ms_index = Summary_file[x_axis_time].sub(100).abs().idxmin()
                            F_200_ms_index = Summary_file[x_axis_time].sub(200).abs().idxmin()
                            F_300_ms_index = Summary_file[x_axis_time].sub(300).abs().idxmin()
                        ### Find indexes of parameters for AQUAPEN 
                        elif fluorometer == 'Aquapen':
                            # find indexes of rows with closest value to individual points column
#                            F_20us_index = Summary_file[x_axis_time].sub(20).abs().idxmin()
                            F_50us_index = Summary_file[x_axis_time].sub(50).abs().idxmin()
#                            F_100us_index = Summary_file[x_axis_time].sub(100).abs().idxmin()
                            FK_300us_index = Summary_file[x_axis_time].sub(300).abs().idxmin()
                            F_50_ms_index = Summary_file[x_axis_time].sub(50000).abs().idxmin()
                            F_100_ms_index = Summary_file[x_axis_time].sub(100000).abs().idxmin()
                            F_200_ms_index = Summary_file[x_axis_time].sub(200000).abs().idxmin()
                            F_300_ms_index = Summary_file[x_axis_time].sub(300000).abs().idxmin()
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

###########  Why Fm = 0  ??????
###########         print(str(Summary_file.iloc[:,0]))
###########         print(str(Summary_file.iloc[:,1]))
                                
                                Fm = 0 
                                # identify time of P-peak: 
                                if (F100MS[i-1]) < (F50MS[i-1]):
                                    Fm = (Summary_file.iloc[F_100_ms_index:, i]).max()
                                    Fm_index = Summary_file.iloc[F_100_ms_index:,i].sub(Fm).abs().idxmin()
                                    if (F200MS[i-1]) < (F100MS[i-1]):
                                        Fm = (Summary_file.iloc[F_200_ms_index:, i]).max()
                                        Fm_index = Summary_file.iloc[F_200_ms_index:,i].sub(Fm).abs().idxmin()
                                        if (F300MS[i-1]) < (F200MS[i-1]):
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
                        AREAOJ = pd.Series(Area_above_curve_temp_O_J.squeeze()) # squeeze: converts DF to SERIES
                        AREAJI = pd.Series(Area_above_curve_temp_J_I.squeeze()) # squeeze: converts DF to SERIES
                        AREAIP = pd.Series(Area_above_curve_temp_I_P.squeeze()) # squeeze: converts DF to SERIES
                        AREAOP = pd.Series(Area_above_curve_temp_O_P.squeeze()) # squeeze: converts DF to SERIES
                        SM = AREAOP / FVFM
                        N = SM * M0 * (1 / VJ)
                        ########################
                        ### Plot OJIP curves ###
                        ########################                            
                        # Select color map, according to number of lines (files)
                        colors = plt.cm.nipy_spectral(np.linspace(0, 1, file_number+1)) # type: ignore
                        # Initialise the subplot function using number of rows and columns 
                        fig = plt.figure(figsize=(22,15))
                        fig.tight_layout() # Shrink to fit the canvas together with legend    
                        fig.subplots_adjust(hspace=0.35, wspace=0.35) 
                        plt.rcParams['mathtext.default'] = 'regular' # Prevent subscripts in axes titles in italics  
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,1) 
                        subplot.set_title("OJIP curves: raw data")
                        for i in range(len(Summary_file.columns)):
                                if i > 0: # do not plot time axis
                                    subplot.plot(
                                        Summary_file.iloc[:, 0], # x-axis data
                                        Summary_file.iloc[:, i], # y-axis data
                                        label = Summary_file.columns[i],
                                        color=colors[i-1]
                                        ) 
                        subplot.set_xscale("log") 
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray') 
                        subplot.set_xlabel(x_axis_unit) 
                        subplot.set_ylabel(y_axis_unit) 
                        
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,2)
                        subplot.set_title("OJIP curves: shifted to zero") 
                        for i in range(len(OJIP_shifted_to_zero.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    OJIP_shifted_to_zero.iloc[:, 0], # x-axis data
                                    OJIP_shifted_to_zero.iloc[:, i], # y-axis data
                                    label = OJIP_shifted_to_zero.columns[i], 
                                    color=colors[i-1]
                                    )
                        subplot.set_xscale("log")
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray') 
                        subplot.set_xlabel(x_axis_unit) 
                        subplot.set_ylabel(y_axis_unit) 
                        subplot.set_ylim(0,)
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,3) 
                        subplot.set_title("OJIP curves: shifted to Fm")
                        for i in range(len(OJIP_shifted_to_max.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    OJIP_shifted_to_max.iloc[:, 0], # x-axis data
                                    OJIP_shifted_to_max.iloc[:, i], # y-axis data
                                    label = OJIP_shifted_to_max.columns[i], 
                                    color=colors[i-1]
                                    ) 
                        subplot.set_xscale("log")
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray') 
                        subplot.set_xlabel(x_axis_unit)     
                        subplot.set_ylabel(y_axis_unit)
                        if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                            subplot.set_ylim(0,)
                        ########## Sub-plot OJIP ##########
                        subplot = fig.add_subplot(4,4,5)
                        subplot.set_title("OJIP curves: double normalized")
                        for i in range(len(OJIP_double_normalized.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    OJIP_double_normalized.iloc[:, 0], # x-axis data
                                    OJIP_double_normalized.iloc[:, i], # y-axis data
                                    label = OJIP_double_normalized.columns[i], 
                                    color=colors[i-1]
                                    )
                        subplot.set_xscale("log")
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray') 
                        subplot.set_xlabel(x_axis_unit) 
                        subplot.set_ylabel("Fluorescence intensity (r.u.)")
                        subplot.set_ylim(0,1.1)
                        subplot.axvline(x = FJ_time, color = '0', ls='-.', lw=1) 
                        subplot.axvline(x = FI_time, color = '0', ls='-.', lw=1) 
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,6)
                        subplot.set_title("Reconstructed curves (double normalized)")
                        for i in range(len(Raw_curves_reconstructed_DF.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    Raw_curves_reconstructed_DF.iloc[:, 0], # x-axis data: 1st column
                                    Raw_curves_reconstructed_DF.iloc[:, i], # y-axis data
                                    label = Raw_curves_reconstructed_DF.columns[i], # Column names for legend
                                    color=colors[i-1],# linestyle='dashed', # alpha=0.5,  # linewidth=0.7 
                                    ) 
                        subplot.set_xscale("log")
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray')
                        subplot.set_xlabel(x_axis_unit) 
                        subplot.set_ylabel("Fluorescence intensity (r.u.)")
                        subplot.set_ylim(0,1.1)
                        subplot.axvline(x = FJ_time, color = '0', ls='-.', lw=1) 
                        subplot.axvline(x = FI_time, color = '0', ls='-.', lw=1)  
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,7)
                        subplot.set_title("Residuals of the reconstructed curves")
                        for i in range(len(Residuals_DF.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    Residuals_DF.iloc[:, 0], # x-axis data: 1st column
                                    Residuals_DF.iloc[:, i], # y-axis data
                                    label = Residuals_DF.columns[i], # Column names for legend
                                    color=colors[i-1],# linestyle='dashed', # alpha=0.5,  # linewidth=0.7 
                                    ) 
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray')
                        subplot.set_xlabel(f"{x_axis_unit} - lin") 
                        subplot.set_ylabel("Residuals (r.u.)")
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,9)
                        subplot.set_title("2$^{nd}$ derivative + F$_{J}$ timing")
                        for i in range(len(Differences_2_DF.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    Differences_2_DF.iloc[:, 0], # x-axis data: 1st column
                                    Differences_2_DF.iloc[:, i], # y-axis data
                                    label = Differences_2_DF.columns[i],
                                    color=colors[i-1] # linestyle='dashed', # alpha=0.5,  # linewidth=0.7 
                                    )
                        subplot.set_xscale("log")
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray') 
                        subplot.set_xlabel(x_axis_unit) 
                        subplot.set_ylabel(" 2$^{nd}$ order difference")
                        subplot.axvline(x = FJ_time, color = '0', ls='-.', lw=2, label = 'FJ time selected (used for calculations)') 
                        for i in range(len(FJ_TIMES_IDENTIFIED)):
                            if i == 0:
                                subplot.axvline(x = FJ_TIMES_IDENTIFIED[i], color = colors[i], ls=':', lw=1.5)
                            else:
                                subplot.axvline(x = FJ_TIMES_IDENTIFIED[i], color = colors[i], ls=':', lw=1.5)    
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,10)
                        for i in range(len(Differences_2_DF.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    Differences_2_DF.iloc[:, 0], # x-axis data: 1st column
                                    Differences_2_DF.iloc[:, i], # y-axis data
                                    label = Differences_2_DF.columns[i],
                                    color=colors[i-1] # linestyle='dashed', # alpha=0.5,  # linewidth=0.7 
                                    )
                        subplot_second_derivative = subplot
                        subplot.set_title("2$^{nd}$ derivative + F$_{I}$ timing")
                        subplot.set_xscale("log")
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray') 
                        subplot.set_xlabel(x_axis_unit) 
                        subplot.set_ylabel(" 2$^{nd}$ order difference")
                        subplot.axvline(x = FI_time, color = '0.2', ls='-.', lw=2, label = 'F$_{J}$ / F$_{I}$ times used for calculations (selected by user)')
                        for i in range(len(FJ_TIMES_IDENTIFIED)):
                            if i == 0:
                                subplot.axvline(x = FI_TIMES_IDENTIFIED[i], color = colors[i], ls=':', lw=1.5, label='F$_{J}$ / F$_{I}$ / F$_{P}$ times identified (used only for visualization)')
                            else:
                                subplot.axvline(x = FI_TIMES_IDENTIFIED[i], color = colors[i], ls=':', lw=1.5)
                        subplot.legend(loc='upper left', bbox_to_anchor=(2.38, 3.73))
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,11)
                        for i in range(len(Differences_2_DF.columns)):
                            if i > 0: # do not plot time axis
                                plt.plot(
                                    Differences_2_DF.iloc[:, 0], # x-axis data: 1st column
                                    Differences_2_DF.iloc[:, i], # y-axis data
                                    label = Differences_2_DF.columns[i],
                                    color=colors[i-1] # linestyle='dashed', # alpha=0.5,  # linewidth=0.7 
                                    )
                        subplot.set_title("2$^{nd}$ derivative + F$_{P}$ timing")
                        subplot.set_xscale("log")
                        subplot.set_xlim(xmin=xmin_for_plot)
                        subplot.grid(which='both', color='lightgray') 
                        subplot.set_xlabel(x_axis_unit) 
                        subplot.set_ylabel(" 2$^{nd}$ order difference")
                        for i in range(len(FP_TIMES_IDENTIFIED)):
                            if i == 0:
                                subplot.axvline(x = FP_TIMES_IDENTIFIED[i], color = colors[i], ls=':', lw=1.5)
                            else:
                                subplot.axvline(x = FP_TIMES_IDENTIFIED[i], color = colors[i], ls=':', lw=1.5)
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,13)        
                        FJ_TIMES_IDENTIFIED.plot.bar(xticks=[], color=colors)
                        subplot.set_title("F$_{J}$ times identified (only for visualization)")
                        subplot.set_ylabel(x_axis_unit)
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,14)                  
                        FI_TIMES_IDENTIFIED.plot.bar(xticks=[], color=colors)
                        subplot.set_title("F$_{I}$ times identified (only for visualization)")   
                        ########## Sub-plot ##########
                        subplot = fig.add_subplot(4,4,15)     
                        FP_TIMES_IDENTIFIED.plot.bar(xticks=[], color=colors)
                        subplot.set_title("F$_{P}$ times identified (only for visualization)")  
                        ########## saving scatter plot to memory ##########
                        memory_for_OJIP_plot = io.BytesIO()
                        plt.savefig(memory_for_OJIP_plot, bbox_inches='tight', format='JPEG')
                        memory_for_OJIP_plot.seek(0)
                        OJIP_plot_in_memory = base64.b64encode(memory_for_OJIP_plot.getvalue())
                        OJIP_plot_from_memory = OJIP_plot_in_memory.decode('ascii')
                        # Clearing the plot
                        plt.clf()
                        plt.cla()
                        plt.close()
                        ##################################
                        ### Plot calculated parameters ###
                        ##################################
                        # Initialise the subplot function using number of rows and columns 
                        fig = plt.figure(figsize=(34,16)) 
                        fig.tight_layout() # Shrink to fit the canvas together with legend 
                        plt.rcParams['mathtext.default'] = 'regular' # Prevent subscripts in axes titles in italics  
                        IP_list = pd.DataFrame([IP])# FM to df, needed for legend
                        # Sub-plot F0 
                        subplot = fig.add_subplot(5, 8, 1)                  
                        F0.plot.bar(xticks=[], color=colors)
                        subplot.set_title("F$_{in}$")
                        subplot.set_ylabel(y_axis_unit)
                        # Sub-plot FJ 
                        subplot = fig.add_subplot(5, 8, 2)                  
                        FJ.plot.bar(xticks=[], color=colors)
                        if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                            subplot.set_title(f'FJ at {FJ_time} ms (used for calculations)')
                        elif fluorometer == 'Aquapen':
                            subplot.set_title(f'FJ at {FJ_time/1000} ms (used for calculations)')
                        # Sub-plot FI 
                        subplot = fig.add_subplot(5, 8, 3) 
                        FI.plot.bar(xticks=[],color=colors)
                        if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                            subplot.set_title(f'FI at {FI_time} ms (used for calculations)')
                        elif fluorometer == 'Aquapen':
                            subplot.set_title(f'FI at {FI_time/1000} ms (used for calculations)')
                        # Sub-plot FM 
                        subplot = fig.add_subplot(5, 8, 4)   
                        # Prepare the plot
                        FM.plot.bar(xticks=[], color=colors)
                        subplot.set_title("F$_{max}$")
                        # Sub-plot  
                        subplot = fig.add_subplot(5, 8, 5)                  
                        OJ.plot.bar(xticks=[], color=colors)
                        subplot.set_title("A$_{0-J}$")
                        # Sub-plot  
                        subplot = fig.add_subplot(5, 8, 6)                  
                        JI.plot.bar(xticks=[], color=colors)
                        subplot.set_title("A$_{J-I}$")
                        # Sub-plot  
                        subplot = fig.add_subplot(5, 8, 7)  
                        # Prepare the plot
                        for i in range(len(IP_list.columns)):
                            # do not plot time axis
                            plt.bar(
                                IP_list.columns[i], # x-axis data
                                IP_list.iloc[:, i], # y-axis data
                                label = IP_list.columns[i], # Column names for legend
                                color=colors[i],
                                width = 0.5 # width of the columns
                                )                  
                        subplot.set_title("A$_{I-P}$")
                        subplot.margins(x=0.42**len(IP_list.columns)) # space between the axes and the first and last bar
                        subplot.set_xticks([]) # no X-axis values
                        subplot.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02)) # legend
                        # Sub-plot 
                        subplot = fig.add_subplot(5, 8, 9)                  
                        VJ.plot.bar(xticks=[], color=colors)
                        subplot.set_title("V$_{J}$")
                        subplot.set_ylabel("r.u.")
                        # Sub-plot VI 
                        subplot = fig.add_subplot(5, 8, 10)                  
                        VI.plot.bar(xticks=[], color=colors)
                        subplot.set_title("V$_{I}$")
                        # Sub-plot M0 
                        subplot = fig.add_subplot(5, 8, 11)                  
                        M0.plot.bar(xticks=[], color=colors)
                        subplot.set_title("M$_{0}$")
                        # Sub-plot PSIE0 
                        subplot = fig.add_subplot(5, 8, 12)                  
                        PSIE0.plot.bar(xticks=[], color=colors)
                        subplot.set_title("ψE$_{0}$")
                        # Sub-plot PSIR0 
                        subplot = fig.add_subplot(5, 8, 13)                  
                        PSIR0.plot.bar(xticks=[], color=colors)
                        subplot.set_title("ψR$_{0}$")
                        # Sub-plot DELTAR0 
                        subplot = fig.add_subplot(5, 8, 14)                  
                        DELTAR0.plot.bar(xticks=[], color=colors)
                        subplot.set_title("δR$_{0}$")
                        # Sub-plot PHIP0 
                        subplot = fig.add_subplot(5, 8, 15)                  
                        FVFM.plot.bar(xticks=[], color=colors)
                        subplot.set_title("φP$_{0}$ (F$_{v}$ / F$_{max}$)")
                        # Sub-plot PHIE0 
                        subplot = fig.add_subplot(5, 8, 17)                  
                        PHIE0.plot.bar(xticks=[], color=colors)
                        subplot.set_title("φE$_{0}$")
                        subplot.set_ylabel("r.u.")
                        # Sub-plot PHIR0 
                        subplot = fig.add_subplot(5, 8, 18)                  
                        PHIR0.plot.bar(xticks=[], color=colors)
                        subplot.set_title("φR$_{0}$")
                        # Sub-plot ABSRC 
                        subplot = fig.add_subplot(5, 8, 19)                  
                        ABSRC.plot.bar(xticks=[], color=colors)
                        subplot.set_title("ABS/RC")
                        # Sub-plot TR0RC 
                        subplot = fig.add_subplot(5, 8, 20)                  
                        TR0RC.plot.bar(xticks=[], color=colors)
                        subplot.set_title("TR0/RC")
                        # Sub-plot ET0RC 
                        subplot = fig.add_subplot(5, 8, 21)                  
                        ET0RC.plot.bar(xticks=[], color=colors)
                        subplot.set_title("ET0/RC")
                        # Sub-plot RE0RC 
                        subplot = fig.add_subplot(5, 8, 22)                  
                        RE0RC.plot.bar(xticks=[], color=colors)
                        subplot.set_title("RE0/RC")
                        # Sub-plot DI0RC 
                        subplot = fig.add_subplot(5, 8, 23)                  
                        DI0RC.plot.bar(xticks=[], color=colors)
                        subplot.set_title("DI0/RC")
                        # Sub-plot area above curve O-J 
                        subplot = fig.add_subplot(5, 8, 25)                  
                        AREAOJ.plot.bar(xticks=[], color=colors)
                        subplot.set_title("Area$_{0-J}$")
                        subplot.set_ylabel("r.u.")
                        # Sub-plot 
                        subplot = fig.add_subplot(5, 8, 26)                  
                        AREAJI.plot.bar(xticks=[], color=colors)
                        subplot.set_title("Area$_{J-I}$")
                        # Sub-plot 
                        subplot = fig.add_subplot(5, 8, 27)                  
                        AREAIP.plot.bar(xticks=[], color=colors)
                        subplot.set_title("Area$_{I-P}$")
                        # Sub-plot 
                        subplot = fig.add_subplot(5, 8, 28)                  
                        AREAOP.plot.bar(xticks=[], color=colors)
                        subplot.set_title("Area$_{(0-P)}$")
                        # Sub-plot 
                        subplot = fig.add_subplot(5, 8, 29)                  
                        SM.plot.bar(xticks=[], color=colors)
                        subplot.set_title("Normalized area S$_{m}$")
                        # Sub-plot 
                        subplot = fig.add_subplot(5, 8, 30)                  
                        N.plot.bar(xticks=[], color=colors)
                        subplot.set_title("N (turn-over number Q$_{A}$)") 
                        # saving scatter plot to memory
                        memory_for_OJIP_parameters = io.BytesIO()
                        plt.savefig(memory_for_OJIP_parameters, bbox_inches='tight', format='JPEG')
                        memory_for_OJIP_parameters.seek(0)
                        OJIP_parameters_in_memory = base64.b64encode(memory_for_OJIP_parameters.getvalue())
                        OJIP_parameters_from_memory = OJIP_parameters_in_memory.decode('ascii')
                        # Clearing the plot
                        plt.clf()
                        plt.cla()
                        plt.close()             
                        #######################
                        ### Export to excel ###
                        #######################
                        # prepare DF with parameters
                        OJIP_param_all = pd.concat([OJIP_param_all, F0], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, FK], axis = 1)       
                        OJIP_param_all = pd.concat([OJIP_param_all, FJ], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, FI], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, FM], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, OJ], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, JI], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, IP], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, VJ], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, VI], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, M0], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, PSIE0], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, PSIR0], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, DELTAR0], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, FVFM], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, PHIE0], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, PHIR0], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, ABSRC], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, TR0RC], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, ET0RC], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, RE0RC], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, DI0RC], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, AREAOJ], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, AREAJI], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, AREAIP], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, AREAOP], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, SM], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, N], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, FJ_TIMES_IDENTIFIED], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, FI_TIMES_IDENTIFIED], axis = 1)
                        OJIP_param_all = pd.concat([OJIP_param_all, FP_TIMES_IDENTIFIED], axis = 1)
                        # name columns
                        OJIP_param_all.columns = ['Fin', 'FK', 'FJ', 'FI', 'Fmax', 'Amplitude(0-J)', 'Amplitude(J-I)', 'Amplitude(I-P)', 'VJ', 'VI', 
                                                 'M0', 'ψE0', 'ψR0', 'δR0', 'ψP0 (Fv/Fm)','φE0', 'φR0', 'ABS/RC', 'TR0/RC', 'ET0/RC', 
                                                 'RE0/RC', 'DI0/RC', 'Complementary area O-J', 'Complementary area J-I', 'Complementary area I-P', 
                                                 'Complementary area (O-P)','Normalized complementary area Sm', 'N (turn-over number QA)', 
                                                 'FJ time identified', 'FI time identified', 'FP time identified'] 
                        # write all parameters to excel
                        writer = pd.ExcelWriter(f'{upload_folder}/{file_name_without_extension}_results.xlsx', engine='openpyxl')
                        OJIP_param_all.to_excel(writer, sheet_name = 'Parameters', index=True)
                        Summary_file.to_excel(writer, sheet_name = 'OJIP_raw', index=False)
                        OJIP_shifted_to_zero.to_excel(writer, sheet_name = 'OJIP_to_zero', index=False)
                        OJIP_shifted_to_max.to_excel(writer, sheet_name = 'OJIP_to_max', index=False)
                        OJIP_double_normalized.to_excel(writer, sheet_name = 'OJIP_norm', index=False)
                        Differences_1_DF.to_excel(writer, sheet_name = '1st_derivatives', index=False)
                        Differences_2_DF.to_excel(writer, sheet_name = '2nd_derivatives', index=False)
                        Raw_curves_reconstructed_DF.to_excel(writer, sheet_name = 'OJIP_reconstructed', index=False)
                        Residuals_DF.to_excel(writer, sheet_name = 'Residuals', index=False)
                        writer.close()
                        # Save images
                        wb = openpyxl.load_workbook(f'{upload_folder}/{file_name_without_extension}_results.xlsx')
                        wb.create_sheet(title='Images')
                        wb.move_sheet('Images', -(len(wb.sheetnames)-1))
                        ws = wb['Images']
                        img_curves = Image(memory_for_OJIP_plot)
                        img_parameters = Image(memory_for_OJIP_parameters)
                        img_curves.anchor = 'A1'
                        img_parameters.anchor = 'A66'
                        ws.add_image(img_curves)
                        ws.add_image(img_parameters)
                        wb.save(f'{upload_folder}/{file_name_without_extension}_results.xlsx')
                                       
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
                        flash('Please select correct file types for analysis (.csv files for MULTI-COLOR-PAM / DUAL-PAM, .txt files for AquaPen / FluorPen).', category='error')    
                else:
                    flash(f'Please select up to {max_number_of_files} files.', category='error')                
        else:
            flash('Please select .csv (MULTI-COLOR-PAM / DUAL-PAM) or .txt (AquaPen / FluorPen) files.', category='error')
        return render_template("OJIP_analysis.html",
                        max_number_of_files = max_number_of_files,
                        OJIP_file_MULTI_COLOR_PAM = OJIP_file_MULTI_COLOR_PAM,
                        OJIP_file_Aquapen = OJIP_file_Aquapen,
                        OJIP_plot_from_memory = OJIP_plot_from_memory,
                        OJIP_parameters_from_memory = OJIP_parameters_from_memory,
                        xlsx_file_path = xlsx_file_path
                        )
    
    return render_template("OJIP_analysis.html")
