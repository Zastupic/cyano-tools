from flask import Blueprint, render_template, request, flash
import os, base64, io, time, openpyxl
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt  
from openpyxl.drawing.image import Image
from . import UPLOAD_FOLDER
from werkzeug.utils import secure_filename

slow_kin_data_analysis = Blueprint('slow_kin_data_analysis', __name__)

@slow_kin_data_analysis.route('/slow_kin_data_analysis', methods=['GET', 'POST'])
def analyze_slow_kin_data():
    # Define variables 
    plot_from_memory = fluorescence = fig = PAR_ALL = plots_MC_PAM_raw_data = plots_MC_PAM_parameters = plots_AquaPen = ()
    xlsx_file_path = str('')
    if request.method == "POST": 
        # Define variables
#        Initial_time_points = []
#        End_time_points = []
        max_number_of_files = 50
        upload_folder = UPLOAD_FOLDER
        file_Aquapen = Summary_file = Summary_file_incl_str = check = File_MULTI_COLOR_PAM = pd.DataFrame()
        ALLOWED_EXTENSIONS_MULTI_COLOR_PAM = set(['.csv', '.CSV'])
        ALLOWED_EXTENSIONS_AQUAPEN = set(['.txt']) 
        F0 = FM = QY_MAX = ACTINIC_INTENSITY = FP = FS = RFD = pd.DataFrame()
#        Time_init_1 = Time_init_2 = Time_init_3 = Time_init_4 = Time_init_5 = Time_init_6 = Time_end_1 = Time_end_2 = Time_end_3 = Time_end_4 = Time_end_5 = Time_end_6 = int
#        Index_Fp_low = Index_Fp_high = Index_Fs_low = Index_Fs_high = int
        Timing_Fm = Timing_Ft = FM_points = Ft_points = Fv_points = Timing_NPQ = NPQ_points = QP_points = QY_points = ETR_points = pd.DataFrame() 
        FM_PRIME_LIGHT_ALL = FM_PRIME_DARK_ALL = FM_PRIME_ALL = FM_MAX = FT_ALL = FV_ALL = PAR_ALL = pd.DataFrame() 
        FP_ALL = FS_ALL = FD_ALL = FM_PRIME_D1_ALL = FM_PRIME_D5_ALL = FM_PRIME_D20_ALL = RFD_ALL = pd.DataFrame() 
        NPQ_LIGHT_ALL = NPQ_DARK_ALL = NPQ_ALL_FM = NPQ_ALL_FM_MAX = QN_ALL_FM = QN_ALL_FM_MAX = QE_ALL = QT_ALL = QI_ALL = pd.DataFrame()
        QP_LIGHT_ALL = QP_DARK_ALL = QP_ALL = pd.DataFrame()
        QY_LIGHT_ALL = QY_DARK_ALL = QY_ALL = pd.DataFrame()
        ETR_LIGHT_ALL = ETR_DARK_ALL = ETR_ALL = ETR_FM = pd.DataFrame()
        files_extensions = set()
        file_extension = x_axis_unit = y_axis_unit = file_name_without_extension = str('') 
#        dictionary_Initial_and_end_time_points = {
#            'Time_init_1': Time_init_1,
#            'Time_init_2': Time_init_2,
#            'Time_init_3': Time_init_3,
#            'Time_init_4': Time_init_4,
#            'Time_init_5': Time_init_5,
#            'Time_init_6': Time_init_6,
#            'Time_end_1': Time_end_1,
#            'Time_end_2': Time_end_2,
#            'Time_end_3': Time_end_3,
#            'Time_end_4': Time_end_4,
#            'Time_end_5': Time_end_5,
#            'Time_end_6': Time_end_6}  
        # create upload directory, if there is not any
        if os.path.isdir(upload_folder) == False:
            os.mkdir(upload_folder)
#        ################################################
#        ### Read Excitations and Emissions from HTML ###
#        ################################################
#        # Collect initial and end times
#        if str(request.form.get('time_init_1')) != "":
#            Initial_time_points.append(int(str(request.form.get('time_init_1'))))
#        if str(request.form.get('time_init_2')) != "":
#            Initial_time_points.append(int(str(request.form.get('time_init_2'))))
#        if str(request.form.get('time_init_3')) != "":
#            Initial_time_points.append(int(str(request.form.get('time_init_3'))))
#        if str(request.form.get('time_init_4')) != "":
#            Initial_time_points.append(int(str(request.form.get('time_init_4'))))
#        if str(request.form.get('time_init_5')) != "":
#            Initial_time_points.append(int(str(request.form.get('time_init_5'))))
#        if str(request.form.get('time_init_6')) != "":
#            Initial_time_points.append(int(str(request.form.get('time_init_6'))))
#        if str(request.form.get('time_end_1')) != "":
#            End_time_points.append(int(str(request.form.get('time_end_1'))))
#        if str(request.form.get('time_end_2')) != "":
#            End_time_points.append(int(str(request.form.get('time_end_2'))))
#        if str(request.form.get('time_end_3')) != "":
#            End_time_points.append(int(str(request.form.get('time_end_3'))))
#        if str(request.form.get('time_end_4')) != "":
#            End_time_points.append(int(str(request.form.get('time_end_4'))))
#        if str(request.form.get('time_end_5')) != "":
#            End_time_points.append(int(str(request.form.get('time_end_5'))))
#        if str(request.form.get('time_end_6')) != "":
#            End_time_points.append(int(str(request.form.get('time_end_6'))))
        ##################
        ### Load files ###
        ##################
        if 'NPQ_files' in request.files: # check if some file is selected
            current_time = time.time() # get the current time
            files = request.files.getlist("NPQ_files") # get list of files
            if secure_filename(files[0].filename) == '': # type: ignore # check if at least one file is selected
                flash('Please select one or more files to analyze.', category='error') 
            else:
                fluorometer = (request.form.get('fluorometer')) # get info on fluorometer
                # Define fluorometer-dependent variables
                if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                    x_axis_unit = "Time (s)"
                    y_axis_unit = "Fluorescence intensity (V)"
                elif fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                    x_axis_unit = "Time (ms)"
                    y_axis_unit = "Fluorescence intensity (a.u.)"
                if len(files) <= max_number_of_files: # Check if number of selected files is within the set limit
                    file_number = 0
                    for file in files: # do for each file 
                        # get image names and extension
                        file_name_without_extension = str.lower(os.path.splitext(file.filename)[0]) # type: ignore # for single image: image = (request.files['image']) 
                        file_extension = str.lower(os.path.splitext(file.filename)[1]) # type: ignore
                        file_name_full = secure_filename(file.filename) # type: ignore
                        files_extensions.add(file_extension) # append all extensions to a set
                        ##################################
                        ### READ MULTI-COLOR PAM FILES ###
                        ##################################
                        if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' and file_extension in ALLOWED_EXTENSIONS_MULTI_COLOR_PAM:     
                            File_MULTI_COLOR_PAM = pd.read_csv(files[(file_number)], sep=';', engine='python')  # type: ignore # read csv file directly, without uploading to server                    
                            #### Read RAW DATA FILES + process into a single dataframe #####
                            if request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_raw_data': 
                                if len(File_MULTI_COLOR_PAM.columns) < 4 and 'ETR' not in File_MULTI_COLOR_PAM: # Check if RAW DATA files was selected
                                    if file_number == 0: # Merge all data in the final dataframe
                                        Summary_file = File_MULTI_COLOR_PAM.iloc[:,0:2] # initiate final dataframe
                                        Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True) # rename column with fluorescence values as file name
                                    elif file_number > 0:
                                        File_MULTI_COLOR_PAM = File_MULTI_COLOR_PAM.iloc[:,1:2] # read fluorescence, as 2nd column in all other files
                                        Summary_file = pd.concat([Summary_file, File_MULTI_COLOR_PAM], axis = 1) # merge the fluorescence column with the final dataframe
                                        Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True) # rename the newly added column
                            ##### Read PARAMETER FILES + process into a single dataframe #####
                            elif request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_parameters': 
                                if len(File_MULTI_COLOR_PAM.columns) > 3 and 'ETR' in File_MULTI_COLOR_PAM: # Check if PARAMETER data files was selected
                                    if file_number == 0: 
                                        # Initiate dataframes with parameters
                                        PAR_ALL = File_MULTI_COLOR_PAM.iloc[:,0]
                                        FT_ALL = File_MULTI_COLOR_PAM.iloc[:,0]
                                        FM_PRIME_ALL = File_MULTI_COLOR_PAM.iloc[:,0]
                                        QY_ALL = File_MULTI_COLOR_PAM.iloc[:,0]
                                        ETR_ALL = File_MULTI_COLOR_PAM.iloc[:,0]
                                                                                # merge columns of particular names with the final dataframe
                                        PAR_ALL = pd.concat([PAR_ALL,File_MULTI_COLOR_PAM['PAR']], axis = 1)
                                        FT_ALL = pd.concat([FT_ALL,File_MULTI_COLOR_PAM['F']], axis = 1) 
                                        FM_PRIME_ALL = pd.concat([FM_PRIME_ALL,File_MULTI_COLOR_PAM['Fm\'']], axis = 1)  
                                        QY_ALL = pd.concat([QY_ALL,File_MULTI_COLOR_PAM['Y(II)']], axis = 1)
                                        ETR_ALL = pd.concat([ETR_ALL,File_MULTI_COLOR_PAM['ETR']], axis = 1)
                                        # rename column with fluorescence values as file name
                                        PAR_ALL.rename(columns = {PAR_ALL.columns[1]: file_name_without_extension}, inplace = True)
                                        FT_ALL.rename(columns = {FT_ALL.columns[1]: file_name_without_extension}, inplace = True) 
                                        FM_PRIME_ALL.rename(columns = {FM_PRIME_ALL.columns[1]: file_name_without_extension}, inplace = True)
                                        QY_ALL.rename(columns = {QY_ALL.columns[1]: file_name_without_extension}, inplace = True)
                                        ETR_ALL.rename(columns = {ETR_ALL.columns[1]: file_name_without_extension}, inplace = True)
                                    elif file_number > 0:
                                        # merge the fluorescence column with the final dataframe
                                        PAR_ALL = pd.concat([PAR_ALL,File_MULTI_COLOR_PAM['PAR']], axis = 1)
                                        FT_ALL = pd.concat([FT_ALL,File_MULTI_COLOR_PAM['F']], axis = 1)
                                        FM_PRIME_ALL = pd.concat([FM_PRIME_ALL,File_MULTI_COLOR_PAM['Fm\'']], axis = 1)
                                        QY_ALL = pd.concat([QY_ALL,File_MULTI_COLOR_PAM['Y(II)']], axis = 1)
                                        ETR_ALL = pd.concat([ETR_ALL,File_MULTI_COLOR_PAM['ETR']], axis = 1)
                                        # rename the newly added column
                                        PAR_ALL.rename(columns = {PAR_ALL.columns[file_number+1]: file_name_without_extension}, inplace = True)
                                        FT_ALL.rename(columns = {FT_ALL.columns[file_number+1]: file_name_without_extension}, inplace = True) 
                                        FM_PRIME_ALL.rename(columns = {FM_PRIME_ALL.columns[file_number+1]: file_name_without_extension}, inplace = True) 
                                        QY_ALL.rename(columns = {QY_ALL.columns[file_number+1]: file_name_without_extension}, inplace = True)  
                                        ETR_ALL.rename(columns = {ETR_ALL.columns[file_number+1]: file_name_without_extension}, inplace = True)                                  
                        ##########################
                        ### READ AQUAPEN FILES ###
                        ##########################
                        if fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)' and file_extension in ALLOWED_EXTENSIONS_AQUAPEN:
                            file.save(os.path.join(upload_folder, file_name_full).replace("\\","/")) # to read .txt files, the files need to be first uploaded to server
                            with open(upload_folder+file_name_full, "r") as temp_variable: # read .txt files
                                # read the txt file     
                                file_Aquapen = temp_variable.readlines() # reading without header
                                file_Aquapen = pd.DataFrame(file_Aquapen)
                                file_Aquapen = file_Aquapen[0].str.split('\t', expand=True)
                                # Merge all data in the final dataframe
                                if file_number == 0:
                                    Summary_file = file_Aquapen[file_Aquapen.columns[:-1]] # initiate final dataframe + drop the last column win '\n' only
                                    Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True) # rename column with fluorescence values according to file name
                                    Summary_file.rename(columns = {Summary_file.columns[0]: 'time_us'}, inplace = True) # rename first column
                                else:
                                    fluorescence = file_Aquapen.iloc[:,1:2] # read fluorescence, as 2nd column in all other files
                                    Summary_file = pd.concat([Summary_file, fluorescence], axis = 1) # merge the fluorescence column with the final dataframe
                                    Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True) # rename the newly added column                                  
                            os.remove(os.path.join(upload_folder, file_name_full).replace("\\","/")) # Delete the uploaded file
                        file_number = file_number + 1               
                    #####################################
                    ### PROCESS MULTI-COLOR PAM FILES ###
                    #####################################
                    if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' and file_extension in ALLOWED_EXTENSIONS_MULTI_COLOR_PAM:
                        ### reduce size of RAW MULTI-COLOR PAM FILES ####
                        if request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_raw_data' and request.form.get("checkbox_reduce_file_size") == 'checked': 
                            if not Summary_file.empty: 
                                if len(Summary_file.index) > 10000:
                                    reduction_factor = int(len(Summary_file.index) / 10000) # calculate factor for data reduction - to keep around 10000 lines in the final df
                                    Summary_file = Summary_file[::reduction_factor] # Exclude every nth row starting from 0
                                    Summary_file.reset_index(inplace = True) # Reset index
                                    Summary_file = Summary_file.drop('index', axis=1)  # Drop old index
                            else:
                                flash(f'There seems to be a problem with selected type of analysis (MULTI-COLOR-PAM / Dual PAM, raw data), or with the uploaded files. Please revise the uploaded files and analysis type.', category='error')
                        ### CALCULATE ADDITIONAL PARAMETERS ####
                        if request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_parameters':
                            if not PAR_ALL.empty: 
                                # rename first column as "Time (s)"
                                PAR_ALL = PAR_ALL.rename(columns={PAR_ALL.columns[0]: "Time (s)" })
                                FT_ALL = FT_ALL.rename(columns={FT_ALL.columns[0]: "Time (s)" })
                                FM_PRIME_ALL = FM_PRIME_ALL.rename(columns={FM_PRIME_ALL.columns[0]: "Time (s)" })
                                QY_ALL = QY_ALL.rename(columns={QY_ALL.columns[0]: "Time (s)" })
                                ETR_ALL = ETR_ALL.rename(columns={ETR_ALL.columns[0]: "Time (s)" })
                                # Delete rows with NaN 
                                PAR_ALL = PAR_ALL.iloc[pd.notna(PAR_ALL.iloc[:, 0]).to_numpy()] # delete first rows with NaN also in the first column ('t')
                                PAR_ALL = PAR_ALL[PAR_ALL.iloc[:, 1:].notna().any(axis=1)] # delete rows with NaN in all other columns that 't'
                                FT_ALL = FT_ALL.iloc[pd.notna(FT_ALL.iloc[:, 0]).to_numpy()] # delete first rows with NaN also in the first column ('t')
                                FT_ALL = FT_ALL[FT_ALL.iloc[:, 1:].notna().any(axis=1)] # delete rows with NaN in all other columns that 't'
                                FM_PRIME_ALL = FM_PRIME_ALL.iloc[pd.notna(FM_PRIME_ALL.iloc[:, 0]).to_numpy()] # delete first rows with NaN also in the first column ('t')
                                FM_PRIME_ALL = FM_PRIME_ALL[FM_PRIME_ALL.iloc[:, 1:].notna().any(axis=1)] # delete rows with NaN in all other columns that 't'
                                QY_ALL = QY_ALL.iloc[pd.notna(QY_ALL.iloc[:, 0]).to_numpy()] # delete first rows with NaN also in the first column ('t')
                                QY_ALL = QY_ALL[QY_ALL.iloc[:, 1:].notna().any(axis=1)] # delete rows with NaN in all other columns that 't'
                                ETR_ALL = ETR_ALL.iloc[pd.notna(ETR_ALL.iloc[:, 0]).to_numpy()] # delete first rows with NaN also in the first column ('t')
                                ETR_ALL = ETR_ALL[ETR_ALL.iloc[:, 1:].notna().any(axis=1)] # delete rows with NaN in all other columns that 't'
                                # Get F0, Fm, Fm'(max)
                                FM_MAX = FM_PRIME_ALL.max()
                                F0 = FT_ALL.iloc[0]
                                FM = FM_PRIME_ALL.iloc[0]
                                # Calculate Fv
                                FV_ALL = (FM_PRIME_ALL.iloc[:, 1:] - FT_ALL.iloc[:, 1:])
                                FV_ALL = pd.concat([FM_PRIME_ALL.iloc[:, 0], FV_ALL], axis = 1) # Add the time column
                                # Calculate QP
                                QP_ALL = (FM_PRIME_ALL.iloc[:, 1:]  - FT_ALL.iloc[:, 1:]) / (FM_PRIME_ALL.iloc[:, 1:] - F0.iloc[1:])
                                QP_ALL = pd.concat([FM_PRIME_ALL.iloc[:, 0], QP_ALL], axis = 1) # Add the time column
                                # calculate QN
                                QN_ALL_FM = (FM.iloc[1:] - FM_PRIME_ALL.iloc[:, 1:]) / FM.iloc[1:]
                                QN_ALL_FM_MAX = (FM_MAX.iloc[1:] - FM_PRIME_ALL.iloc[:, 1:]) / FM.iloc[1:]
                                QN_ALL_FM = pd.concat([FM_PRIME_ALL.iloc[:, 0], QN_ALL_FM], axis = 1) # Add the time column
                                QN_ALL_FM_MAX = pd.concat([FM_PRIME_ALL.iloc[:, 0], QN_ALL_FM_MAX], axis = 1) # Add the time column
                                # calculate NPQ
                                NPQ_ALL_FM = (FM.iloc[1:] - FM_PRIME_ALL.iloc[:, 1:]) / FM.iloc[1:]
                                NPQ_ALL_FM_MAX = (FM_MAX.iloc[1:] - FM_PRIME_ALL.iloc[:, 1:]) / FM_MAX.iloc[1:]
                                NPQ_ALL_FM = pd.concat([FM_PRIME_ALL.iloc[:, 0], NPQ_ALL_FM], axis = 1) # Add the time column
                                NPQ_ALL_FM_MAX = pd.concat([FM_PRIME_ALL.iloc[:, 0], NPQ_ALL_FM_MAX], axis = 1) # Add the time column
#                                #################################################
#                                ### PROCESS TIME POINTS FOR STATE TRANSITIONS ###
#                                #################################################
#                                if len(Initial_time_points) > 0 and len(End_time_points) > 0: # check if the lists are not empty
#                                    # Sort both lists
#                                    Initial_time_points.sort()
#                                    End_time_points.sort()
#                                    # Check if each value in End_time_points is higher than in Initial_time_points
#                                    end_points_higher_than_initial_points = all(e > i for i, e in zip(Initial_time_points, End_time_points))
#                                    if end_points_higher_than_initial_points:
#                                        print('Initial_time_points: ' + str(Initial_time_points))
#                                        print('End_time_points: ' + str(End_time_points))
#                                    else:
#                                        flash('Please select correctly the initial and end points for the state transition calculation: the end values need to be higher than the initial values.', category='error')
#                            else:
#                                flash(f'There seems to be a problem with selected type of analysis (MULTI-COLOR-PAM / Dual PAM, files with calculated parameters), or with the uploaded files. Please revise the uploaded files and analysis type.', category='error')
                    #############################
                    ### PROCESS AQUAPEN FILES ###
                    #############################
                    elif fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)' and file_extension in ALLOWED_EXTENSIONS_AQUAPEN:
                        if Summary_file['time_us'].str.contains('NPQ').any(): # Check if parameters were exported
                            ###################################################
                            ### Put all values as exported by AquaPen to DF ###
                            ###################################################
                            # values measured for all settings
                            if not Summary_file["time_us"].isnull().any():
                                F0 = ((Summary_file[Summary_file["time_us"].str.contains("Fo")]).iloc[: , 1:]) # find F0
                                FP = ((Summary_file[Summary_file["time_us"].str.contains("Fp")]).iloc[: , 1:]) # find Fp
                                RFD = ((Summary_file[Summary_file["time_us"].str.contains("Rfd")]).iloc[: , 1:]) # find Rfd
                                FM = ((Summary_file[Summary_file["time_us"].str.contains("Fm")]).iloc[: , 1:]) # select all values, including Fm_L1-L4/Fm_L1-L9
                                FM = pd.DataFrame(FM.iloc[0,:]).T # select only Fm
                                QY_MAX = ((Summary_file[Summary_file["time_us"].str.contains("QY_max")]).iloc[: , 1:]) # find QY_max

                                ACTINIC_INTENSITY = ((Summary_file[Summary_file["time_us"].str.contains("ACTINIC-Intensity")]).iloc[: , 1:]).reset_index(drop=True) # find intensity of actinic light
                                # get indexes common for all NPQ files
                                index_Fm_L1 = Summary_file.index[Summary_file['time_us'] == 'Fm_L1'].tolist()
                                index_Fm_Lss = Summary_file.index[Summary_file['time_us'] == 'Fm_Lss'].tolist()
                                index_Fm_D1 = Summary_file.index[Summary_file['time_us'] == 'Fm_D1'].tolist()
                                index_NPQ_L1 = Summary_file.index[Summary_file['time_us'] == 'NPQ_L1'].tolist()
                                index_NPQ_Lss = Summary_file.index[Summary_file['time_us'] == 'NPQ_Lss'].tolist()
                                index_NPQ_D1 = Summary_file.index[Summary_file['time_us'] == 'NPQ_D1'].tolist()  
                                index_Qp_L1 = Summary_file.index[Summary_file['time_us'] == 'Qp_L1'].tolist()
                                index_Qp_Lss = Summary_file.index[Summary_file['time_us'] == 'Qp_Lss'].tolist()  
                                index_Qp_D1 = Summary_file.index[Summary_file['time_us'] == 'Qp_D1'].tolist()
                                index_QY_L1 = Summary_file.index[Summary_file['time_us'] == 'QY_L1'].tolist()
                                index_QY_Lss = Summary_file.index[Summary_file['time_us'] == 'QY_Lss'].tolist()  
                                index_QY_D1 = Summary_file.index[Summary_file['time_us'] == 'QY_D1'].tolist()
                                ####### NPQ 1 settings #######
                                if fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)' and request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ1':
                                    if (Summary_file['time_us'].str.contains('NPQ_L4').any()) and not (Summary_file['time_us'].str.contains('NPQ_L9').any()):
                                        Timing_Fm = pd.DataFrame({'time_us':[1422801,19364701,31261001,43157301,55053601,66949901,83876601,109879301,135882001]}).astype(int)
                                        Timing_Ft = pd.DataFrame({'time_us':[207601,18564701,30461001,42357301,54253601,66149901,83076601,109079301,135082001]}).astype(int)
                                        Timing_NPQ = pd.DataFrame({'time_us':[19364701,31261001,43157301,55053601,66949901,83876601,109879301,135882001]}).astype(int)
                                        FM_points = pd.DataFrame({'FM points':['Fm','Fm_L1','Fm_L2','Fm_L3','Fm_L4','Fm_Lss','Fm_D1','Fm_D2','Fm_D3']})
                                        Ft_points = pd.DataFrame({'Ft points':['F0','Ft_L1','Ft_L2','Ft_L3','Ft_L4','Ft_Lss','Ft_D1','Ft_D2','Ft_D3']})
                                        Fv_points = pd.DataFrame({'Fv points':['Fv','Fv_L1','Fv_L2','Fv_L3','Fv_L4','Fv_Lss','Fv_D1','Fv_D2','Fv_D3']})
                                        NPQ_points = pd.DataFrame({'NPQ points':['NPQ_L1','NPQ_L2','NPQ_L3','NPQ_L4','NPQ_Lss','NPQ_D1','NPQ_D2','NPQ_D3']})
                                        QP_points = pd.DataFrame({'QP points':['QP_L1','QP_L2','QP_L3','QP_L4','QP_Lss','QP_D1','QP_D2','QP_D3']})
                                        QY_points = pd.DataFrame({'QY points':['QY_max (Fv/Fm)','QY_L1','QY_L2','QY_L3','QY_L4','QY_Lss','QY_D1','QY_D2','QY_D3']})
                                        ETR_points = pd.DataFrame({'ETR points':['ETR_Fv/Fm','ETR_L1','ETR_L2','ETR_L3','ETR_L4','ETR_Lss','ETR_D1','ETR_D2','ETR_D3']})
                                        # get indexes specific for NPQ1 files
                                        index_Fm_D3 = Summary_file.index[Summary_file['time_us'] == 'Fm_D3'].tolist()
                                        index_NPQ_D3 = Summary_file.index[Summary_file['time_us'] == 'NPQ_D3'].tolist()
                                        index_Qp_D3 = Summary_file.index[Summary_file['time_us'] == 'Qp_D3'].tolist()
                                        index_QY_D3 = Summary_file.index[Summary_file['time_us'] == 'QY_D3'].tolist()
#                                        Index_Fp_low = 7E6
#                                        Index_Fp_high = 17E6
#                                        Index_Fs_low = 57E6
#                                        Index_Fs_high = 66E6
                                        # get the whole series
                                        FM_PRIME_LIGHT_ALL = Summary_file.iloc[index_Fm_L1[0]:(index_Fm_Lss[0]+1)]
                                        FM_PRIME_DARK_ALL = Summary_file.iloc[index_Fm_D1[0]:(index_Fm_D3[0]+1)]
                                        NPQ_LIGHT_ALL = Summary_file.iloc[index_NPQ_L1[0]:(index_NPQ_Lss[0]+1)]
                                        NPQ_DARK_ALL = Summary_file.iloc[index_NPQ_D1[0]:(index_NPQ_D3[0]+1)]
                                        QP_LIGHT_ALL = Summary_file.iloc[index_Qp_L1[0]:(index_Qp_Lss[0]+1)]
                                        QP_DARK_ALL = Summary_file.iloc[index_Qp_D1[0]:(index_Qp_D3[0]+1)]
                                        QY_LIGHT_ALL = Summary_file.iloc[index_QY_L1[0]:(index_QY_Lss[0]+1)]
                                        QY_DARK_ALL = Summary_file.iloc[index_QY_D1[0]:(index_QY_D3[0]+1)]
                                    else:
                                        flash('Please select correct type of the NPQ protocol and/or files to analyze (currently, NPQ1 protocol was seltected, but other file type seems to be uploaded).', category='error')
                                ####### NPQ 2 settings #######
                                elif fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)' and request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ2':
                                    if (Summary_file['time_us'].str.contains('NPQ_L9').any()) and (Summary_file['time_us'].str.contains('NPQ_D7').any()):
                                        # get series info specific for NPQ2 files
                                        Timing_Fm = pd.DataFrame({'time (us)':[1422801,32425501,53314201,74202901,95091601,115980301,136869001,157757701,178646401,199535101,220423801,243327701,304174001,365020301,425866601,486712901,547559201,608405501]}).astype(int)
                                        Timing_Ft = pd.DataFrame({'time_us':[207601,31625501,52514201,73402901,94291601,115180301,136069001,156957701,177846401,198735101,219623801,242527701,303374001,364220301,425066601,485912901,546759201,607605501]}).astype(int)
                                        Timing_NPQ = pd.DataFrame({'time_us':[32425501,53314201,74202901,95091601,115980301,136869001,157757701,178646401,199535101,220423801,243327701,304174001,365020301,425866601,486712901,547559201,608405501]})
                                        FM_points = pd.DataFrame({'FM points':['Fm','Fm_L1','Fm_L2','Fm_L3','Fm_L4','Fm_L5','Fm_L6','Fm_L7','Fm_L8','Fm_L9','Fm_Lss','Fm_D1','Fm_D2','Fm_D3','Fm_D4','Fm_D5','Fm_D6','Fm_D7']})
                                        Ft_points = pd.DataFrame({'Ft points':['Ft','Ft_L1','Ft_L2','Ft_L3','Ft_L4','Ft_L5','Ft_L6','Ft_L7','Ft_L8','Ft_L9','Ft_Lss','Ft_D1','Ft_D2','Ft_D3','Ft_D4','Ft_D5','Ft_D6','Ft_D7']})
                                        Fv_points = pd.DataFrame({'Fv points':['Fv','Fv_L1','Fv_L2','Fv_L3','Fv_L4','Fv_L5','Fv_L6','Fv_L7','Fv_L8','Fv_L9','Fv_Lss','Fv_D1','Fv_D2','Fv_D3','Fv_D4','Fv_D5','Fv_D6','Fv_D7']})
                                        NPQ_points = pd.DataFrame({'NPQ points':['NPQ_L1','NPQ_L2','NPQ_L3','NPQ_L4','NPQ_L5','NPQ_L6','NPQ_L7','NPQ_L8','NPQ_L9','NPQ_Lss','NPQ_D1','NPQ_D2','NPQ_D3','NPQ_D4','NPQ_D5','NPQ_D6','NPQ_D7']})
                                        QP_points = pd.DataFrame({'QP points':['QP_L1','QP_L2','QP_L3','QP_L4','QP_L5','QP_L6','QP_L7','QP_L8','QP_L9','QP_Lss','QP_D1','QP_D2','QP_D3','QP_D4','QP_D5','QP_D6','QP_D7']})
                                        QY_points = pd.DataFrame({'QY points':['QY_max (Fv/Fm)','QY_L1','QY_L2','QY_L3','QY_L4','QY_L5','QY_L6','QY_L7','QY_L8','QY_L9','QY_Lss','QY_D1','QY_D2','QY_D3','QY_D4','QY_D5','QY_D6','QY_D7']})
                                        ETR_points = pd.DataFrame({'ETR points':['ETR_Fv/Fm','ETR_L1','ETR_L2','ETR_L3','ETR_L4','ETR_L5','ETR_L6','ETR_L7','ETR_L8','ETR_L9','ETR_Lss','ETR_D1','ETR_D2','ETR_D3','ETR_D4','ETR_D5','ETR_D6','ETR_D7']})
                                        # get indexes specific for NPQ2 files
                                        index_Fm_D7 = Summary_file.index[Summary_file['time_us'] == 'Fm_D7'].tolist()
                                        index_NPQ_D7 = Summary_file.index[Summary_file['time_us'] == 'NPQ_D7'].tolist()
                                        index_Qp_D7 = Summary_file.index[Summary_file['time_us'] == 'Qp_D7'].tolist()
                                        index_QY_D7 = Summary_file.index[Summary_file['time_us'] == 'QY_D7'].tolist()
#                                        Index_Fp_low = 17E6
#                                        Index_Fp_high = 30E6
#                                        Index_Fs_low =202E6
#                                        Index_Fs_high = 219E6
                                        # get the whole series
                                        FM_PRIME_LIGHT_ALL = Summary_file.iloc[index_Fm_L1[0]:(index_Fm_Lss[0]+1)]
                                        FM_PRIME_DARK_ALL = Summary_file.iloc[index_Fm_D1[0]:(index_Fm_D7[0]+1)]
                                        NPQ_LIGHT_ALL = Summary_file.iloc[index_NPQ_L1[0]:(index_NPQ_Lss[0]+1)]
                                        NPQ_DARK_ALL = Summary_file.iloc[index_NPQ_D1[0]:(index_NPQ_D7[0]+1)]
                                        QP_LIGHT_ALL = Summary_file.iloc[index_Qp_L1[0]:(index_Qp_Lss[0]+1)]
                                        QP_DARK_ALL = Summary_file.iloc[index_Qp_D1[0]:(index_Qp_D7[0]+1)]
                                        QY_LIGHT_ALL = Summary_file.iloc[index_QY_L1[0]:(index_QY_Lss[0]+1)]
                                        QY_DARK_ALL = Summary_file.iloc[index_QY_D1[0]:(index_QY_D7[0]+1)]
                                    else:
                                        flash('Please select correct type of the NPQ protocol and/or files to analyze (currently, NPQ2 protocol was seltected, but other file type seems to be uploaded).', category='error')
                                ####### NPQ 3 settings #######
                                elif fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)' and request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ3':
                                    if (Summary_file['time_us'].str.contains('NPQ_L9').any()) and not (Summary_file['time_us'].str.contains('NPQ_D7').any()):
                                        Timing_Fm = pd.DataFrame({'time_us':[1422801,32425501,53314201,74202901,95091601,115980301,136869001,157757701,178646401,199535101,220423801,243327701,264224001]}).astype(int)
                                        Timing_Ft = pd.DataFrame({'time_us':[207601,31625501,52514201,73402901,94291601,115180301,136069001,156957701,177846401,198735101,219623801,242527701,263424001]}).astype(int)
                                        Timing_NPQ = pd.DataFrame({'time_us':[32425501,53314201,74202901,95091601,115980301,136869001,157757701,178646401,199535101,220423801,243327701,264224001]}).astype(int)
                                        FM_points = pd.DataFrame({'FM points':['Fm','Fm_L1','Fm_L2','Fm_L3','Fm_L4','Fm_L5','Fm_L6','Fm_L7','Fm_L8','Fm_L9','Fm_Lss','Fm_D1','Fm_D2']})
                                        Ft_points = pd.DataFrame({'Ft points':['Ft','Ft_L1','Ft_L2','Ft_L3','Ft_L4','Ft_L5','Ft_L6','Ft_L7','Ft_L8','Ft_L9','Ft_Lss','Ft_D1','Ft_D2']})
                                        Fv_points = pd.DataFrame({'Fv points':['Fv','Fv_L1','Fv_L2','Fv_L3','Fv_L4','Fv_L5','Fv_L6','Fv_L7','Fv_L8','Fv_L9','Fv_Lss','Fv_D1','Fv_D2']})
                                        NPQ_points = pd.DataFrame({'NPQ points':['NPQ_L1','NPQ_L2','NPQ_L3','NPQ_L4','NPQ_L5','NPQ_L6','NPQ_L7','NPQ_L8','NPQ_L9','NPQ_Lss','NPQ_D1','NPQ_D2']})
                                        QP_points = pd.DataFrame({'QP points':['QP_L1','QP_L2','QP_L3','QP_L4','QP_L5','QP_L6','QP_L7','QP_L8','QP_L9','QP_Lss','QP_D1','QP_D2']})
                                        QY_points = pd.DataFrame({'QY points':['QY_max (Fv/Fm)','QY_L1','QY_L2','QY_L3','QY_L4','QY_L5','QY_L6','QY_L7','QY_L8','QY_L9','QY_Lss','QY_D1','QY_D2']})
                                        ETR_points = pd.DataFrame({'ETR points':['ETR_Fv/Fm','ETR_L1','ETR_L2','ETR_L3','ETR_L4','ETR_L5','ETR_L6','ETR_L7','ETR_L8','ETR_L9','ETR_Lss','ETR_D1','ETR_D2']})
                                        # get indexes specific for NPQ3 files
                                        index_Fm_D2 = Summary_file.index[Summary_file['time_us'] == 'Fm_D2'].tolist()
                                        index_NPQ_D2 = Summary_file.index[Summary_file['time_us'] == 'NPQ_D2'].tolist()
                                        index_Qp_D2 = Summary_file.index[Summary_file['time_us'] == 'Qp_D2'].tolist()
                                        index_QY_D2 = Summary_file.index[Summary_file['time_us'] == 'QY_D2'].tolist()
#                                        Index_Fp_low = 17E6
#                                        Index_Fp_high = 30E6
#                                        Index_Fs_low =226E6
#                                        Index_Fs_high = 240E6
                                        # get the whole series
                                        FM_PRIME_LIGHT_ALL = Summary_file.iloc[index_Fm_L1[0]:(index_Fm_Lss[0]+1)]
                                        FM_PRIME_DARK_ALL = Summary_file.iloc[index_Fm_D1[0]:(index_Fm_D2[0]+1)]
                                        NPQ_LIGHT_ALL = Summary_file.iloc[index_NPQ_L1[0]:(index_NPQ_Lss[0]+1)]
                                        NPQ_DARK_ALL = Summary_file.iloc[index_NPQ_D1[0]:(index_NPQ_D2[0]+1)]
                                        QP_LIGHT_ALL = Summary_file.iloc[index_Qp_L1[0]:(index_Qp_Lss[0]+1)]
                                        QP_DARK_ALL = Summary_file.iloc[index_Qp_D1[0]:(index_Qp_D2[0]+1)]
                                        QY_LIGHT_ALL = Summary_file.iloc[index_QY_L1[0]:(index_QY_Lss[0]+1)]
                                        QY_DARK_ALL = Summary_file.iloc[index_QY_D1[0]:(index_QY_D2[0]+1)]
                                    else:
                                        flash('Please select correct type of the NPQ protocol and/or files to analyze (currently, NPQ3 protocol was seltected, but other file type seems to be uploaded).', category='error')                          
                            else:
                                    flash('Please select correct type of the NPQ protocol and/or files to analyze.', category='error')                          
                        else:
                            flash(f'There seems to be a problem with the uploaded data. Please revise the uploaded files.', category='error')
                    else:
                        flash(f'There seems to be a problem with the uploaded data (for Aquapen/PlantPen, only .txt files are required, MULTI-COLOR-PAM/Dual PAM require .csv files). Please revise the uploaded files.', category='error')
                    #############################################################
                    ### PROCESS THE IDENTIFIED VALUES FROM AQUAPEN / PLANTPEN ###
                    #############################################################
                    if not QY_LIGHT_ALL.empty: # check if DF has some values AND if the values are not NaN
                        if fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                            ##################################################
                            ### KEEP ONLY NUMERICAL VALUES IN SUMMARY FILE ###
                            ##################################################
                            # Identify lines without numerical values in the final dataframe
                            check = pd.DataFrame(Summary_file.time_us.str.isnumeric())
                            check.rename(columns={check.columns[0]: "A"}, inplace = True)  
                            Summary_file_incl_str = Summary_file # make copy of summary file, for the conditions
                            Summary_file = Summary_file[check.A] # Delete lines without numerical values in the final dataframe, according to 'False' values in 'check' DF
                            Summary_file = Summary_file.astype(int) # type: ignore # convert df to numeric
                            ##############################
                            ### CALCUALTE ETR, qN, RFD ###
                            ##############################
                            ETR_FM = QY_MAX.iloc[: , 0:].astype(float) * 0
                            ETR_LIGHT_ALL = QY_LIGHT_ALL.iloc[: , 1:].astype(float) * ACTINIC_INTENSITY.values.astype(float)
                            ETR_DARK_ALL = QY_DARK_ALL.iloc[: , 1:].astype(float) * 0
                            ##################################################
                            ### MERGE THE MEASURED DATA TO FINAL DATAFRAME ###
                            ##################################################
                            # Merge FM data 
                            FM_PRIME_ALL = pd.concat([FM_PRIME_LIGHT_ALL, FM_PRIME_DARK_ALL]).iloc[: , 1:]
                            FM_PRIME_ALL = pd.concat([FM, FM_PRIME_ALL]).reset_index(drop=True) # type: ignore
                            FM_PRIME_ALL = pd.concat([Timing_Fm, FM_PRIME_ALL], axis=1).astype(int)
                            FM_PRIME_ALL = pd.concat([FM_points, FM_PRIME_ALL], axis=1)
                            # Get Fm(max)
                            FM_MAX = FM_PRIME_ALL.max()
                            # Merge NPQ data 
                            NPQ_ALL_FM = pd.concat([NPQ_LIGHT_ALL, NPQ_DARK_ALL]).iloc[: , 1:].reset_index(drop=True)
                            NPQ_ALL_FM = pd.concat([Timing_NPQ, NPQ_ALL_FM], axis=1).astype(float)
                            NPQ_ALL_FM = pd.concat([NPQ_points, NPQ_ALL_FM], axis=1)
                            # Merge QP data
                            QP_ALL = pd.concat([QP_LIGHT_ALL, QP_DARK_ALL]).iloc[: , 1:].reset_index(drop=True)
                            QP_ALL = pd.concat([Timing_NPQ, QP_ALL], axis=1).astype(float)
                            QP_ALL = pd.concat([QP_points, QP_ALL], axis=1)
                            # Merge QY data
                            QY_ALL = pd.concat([QY_LIGHT_ALL, QY_DARK_ALL]).iloc[: , 1:]
                            QY_ALL = pd.concat([QY_MAX, QY_ALL]).reset_index(drop=True)
                            QY_ALL = pd.concat([Timing_Fm, QY_ALL], axis=1).astype(float)
                            QY_ALL = pd.concat([QY_points, QY_ALL], axis=1)
                            # Merge ETR data
                            ETR_ALL = pd.concat([ETR_LIGHT_ALL, ETR_DARK_ALL]) 
                            ETR_ALL = pd.concat([ETR_FM, ETR_ALL]).reset_index(drop=True)
                            ETR_ALL = pd.concat([Timing_Fm, ETR_ALL], axis=1).astype(float)
                            ETR_ALL = pd.concat([ETR_points, ETR_ALL], axis=1)
                            # Merge Rfd data
                            RFD_ALL =  RFD.T # transpose
                            RFD_ALL.rename(columns={RFD_ALL.columns[0]: "Rfd"}, inplace = True) # rename the column with values
                            # Get Ft
                            FT_ALL = pd.merge_asof(Timing_Ft, Summary_file, left_on='time_us', right_on='time_us', direction='nearest')
                            FT_ALL = pd.concat([Ft_points, FT_ALL], axis=1)
                            # Calculate Fv
                            FV_ALL = FM_PRIME_ALL.iloc[:, 2:] - FT_ALL.iloc[:, 2:]
                            FV_ALL = pd.concat([Timing_Fm, FV_ALL], axis=1).astype(int)
                            FV_ALL = pd.concat([Fv_points, FV_ALL], axis=1)
                            # Calculate qN
                            QN_ALL_FM = (FM_PRIME_ALL.iloc[0, 2:] - FM_PRIME_ALL.iloc[:, 2:]) / FM_PRIME_ALL.iloc[0, 2:]
                            QN_ALL_FM = pd.concat([Timing_Fm, QN_ALL_FM], axis=1).astype(float)
                            QN_ALL_FM = pd.concat([FM_points, QN_ALL_FM], axis=1)
                            # Calculate NPQ using Fm(max)
                            NPQ_ALL_FM_MAX = (FM_MAX.iloc[2:] - FM_PRIME_ALL.iloc[:, 2:]) / FM_PRIME_ALL.iloc[:, 2:]
                            NPQ_ALL_FM_MAX = pd.concat([Timing_Fm.astype(int), NPQ_ALL_FM_MAX], axis=1)
                            NPQ_ALL_FM_MAX = pd.concat([NPQ_points, NPQ_ALL_FM_MAX], axis=1)

#######################
#### --- TO DO --- ####
#######################

#### CALCULATE ADDITIONAL PARAMETERS (http://dx.doi.org/10.14715/cmb/2019.65.2.7):
# NPQ-Fm(max)
# qCN
# Rfd
# qE (Zavrel 2021)
# qL
# φNO
# φP
# φPt
# φP0
# PQ                         


                    #####################################
                    ### PLOT MC-PAM FILES - RAW DATA  ###
                    #####################################
                    # Check if correct file type was selected
                    if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' and \
                        ((request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_raw_data' and (len(File_MULTI_COLOR_PAM.columns) < 4 and 'ETR' not in File_MULTI_COLOR_PAM) or \
                        (request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_parameters' and not PAR_ALL.empty))) or \
                        'time_us' in Summary_file.columns and (fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)' and \
                        ((request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ1' and Summary_file_incl_str['time_us'].astype(str).str.contains('NPQ_L4').any() and not Summary_file_incl_str['time_us'].astype(str).str.contains('NPQ_L9').any()) or \
                        (request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ2' and Summary_file_incl_str['time_us'].astype(str).str.contains('NPQ_L9').any() and Summary_file_incl_str['time_us'].astype(str).str.contains('NPQ_D7').any()) or \
                        (request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ3' and Summary_file_incl_str['time_us'].astype(str).str.contains('NPQ_L9').any() and not Summary_file_incl_str['time_us'].astype(str).str.contains('NPQ_D7').any()))):
                        # Initialise the subplot function using number of rows and columns 
                        fig = plt.figure(figsize=(17,11))
                        fig.tight_layout() # Shrink to fit the canvas together with legend  
                        fig.subplots_adjust(hspace=0.4, wspace=0.3) # add horizontal space to read the x-axis and titles well
                        plt.rcParams['mathtext.default'] = 'regular' # Prevent subscripts in axes titles in italics
                        if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                            if request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_raw_data':
                                # Select color map, according to number of lines (files)
                                colors = plt.cm.nipy_spectral(np.linspace(0, 1, file_number+1)) # type: ignore                           
                                gs = fig.add_gridspec(nrows=3, ncols=5) # https://how2matplotlib.com/gridspec_kw.html
                                ########## Sub-plot ##########
                                subplot = fig.add_subplot(gs[:2, :4])
                                for i in range(len(Summary_file.columns)): # Read dataframe for the plot
                                    if i > 0: # do not plot time axis
                                        subplot.plot(
                                            Summary_file.iloc[:, 0], # x-axis data: 1st column
                                            Summary_file.iloc[:, i], # y-axis data
                                            linewidth=2,
                                            label = Summary_file.columns[i], #legend
                                            color=colors[i-1]
                                            )
                                subplot.set_title("Raw fluorescence signal") 
                                subplot.grid() # use: which='both' for minor grid
                                subplot.set_xlabel(x_axis_unit) 
                                subplot.set_ylabel(y_axis_unit)
                                subplot.legend(loc='upper left', bbox_to_anchor=(1.02, 1.02))
                                plots_MC_PAM_raw_data = subplot # only to check if plotting has been performed
                            #######################################
                            ### PLOT MC-PAM FILES - PARAMETERS  ###
                            #######################################
                            elif request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_parameters':
                                # Initialise the subplot function using number of rows and columns 
                                fig = plt.figure(figsize=(17,11))
                                fig.tight_layout() # Shrink to fit the canvas together with legend  
                                fig.subplots_adjust(hspace=0.4, wspace=0.3) # add horizontal space to read the x-axis and titles well
                                plt.rcParams['mathtext.default'] = 'regular' # Prevent subscripts in axes titles in italics
                                # Select color map, according to number of lines (files)
                                colors = plt.cm.nipy_spectral(np.linspace(0, 1, file_number+1)) # type: ignore     
                                if not PAR_ALL.empty: 
                                    gs = fig.add_gridspec(nrows=3, ncols=5) # https://how2matplotlib.com/gridspec_kw.html
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[1, 0]) 
                                    for i in range(len(FT_ALL.columns)): # Read dataframe for the plot
                                        if i > 0: # do not plot time axis
                                            subplot.scatter(
                                                FT_ALL.iloc[:, 0], # x-axis data: 1st column
                                                FT_ALL.iloc[:, i], # y-axis data
                                                color=colors[i-1]
                                                )
                                    subplot.set_title("Steady-state flurescence") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('Ft (V)')
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[1, 1])
                                    for i in range(len(FM_PRIME_ALL.columns)): # Read dataframe for the plot
                                        if i > 0: # do not plot time axis
                                            subplot.scatter(
                                                FM_PRIME_ALL.iloc[:, 0], # x-axis data: 1st column
                                                FM_PRIME_ALL.iloc[:, i], # y-axis data
                                                color=colors[i-1]
                                                )
                                    subplot.set_title("Maximum fluorescence") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('Fm (V)')
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[1, 2]) 
                                    for i in range(len(FV_ALL.columns)): # Read dataframe for the plot
                                        if i > 0: # do not plot time axis
                                            subplot.scatter(
                                                FV_ALL.iloc[:, 0], # x-axis data: 1st column
                                                FV_ALL.iloc[:, i], # y-axis data
                                                color=colors[i-1]
                                                )
                                    subplot.set_title("Variable fluorescence") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('Fv (V)')
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[1, 3]) 
                                    for i in range(len(NPQ_ALL_FM.columns)): # Read dataframe for the plot
                                        if i > 0: # do not plot time axis
                                            subplot.scatter(
                                                NPQ_ALL_FM.iloc[:, 0], # x-axis data: 1st column
                                                NPQ_ALL_FM.iloc[:, i], # y-axis data
                                                label = NPQ_ALL_FM.columns[i], #legend
                                                color=colors[i-1]
                                                )
                                    subplot.set_title("Non-photochemical quenching") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('NPQ') 
                                    subplot.legend(loc='upper left', bbox_to_anchor=(1.02, 1.02))
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[2, 0])
                                    for i in range(len(QN_ALL_FM.columns)): # Read dataframe for the plot
                                        if i > 0:# do not plot time axis
                                            subplot.scatter(
                                                QN_ALL_FM.iloc[:, 0], # x-axis data: 1st column
                                                QN_ALL_FM.iloc[:, i], # y-axis data
                                                color=colors[i-1]
                                                )
                                    subplot.set_title("Coefficient of NPQ") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('qN') 
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[2, 1])
                                    for i in range(len(QP_ALL.columns)): # Read dataframe for the plot
                                        if i > 0:# do not plot time axis
                                            subplot.scatter(
                                                QP_ALL.iloc[:, 0], # x-axis data: 1st column
                                                QP_ALL.iloc[:, i], # y-axis data
                                                color=colors[i-1]
                                                )
                                    subplot.set_title("Photochemical quenching") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('qP') 
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[2, 2])
                                    for i in range(len(QY_ALL.columns)): # Read dataframe for the plot
                                            if i > 0: # do not plot time axis
                                                subplot.scatter(
                                                    QY_ALL.iloc[:, 0], # x-axis data: 1st column
                                                    QY_ALL.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    subplot.set_title("Quantum yield") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('Qy') 
                                    ########## Sub-plot ##########
                                    subplot = fig.add_subplot(gs[2, 3])
                                    for i in range(len(ETR_ALL.columns)): # Read dataframe for the plot
                                            if i > 0: # do not plot time axis
                                                subplot.scatter(
                                                    ETR_ALL.iloc[:, 0], # x-axis data: 1st column
                                                    ETR_ALL.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    subplot.set_title("Electron transport rate") 
                                    subplot.grid() # use: which='both' for minor grid
                                    subplot.set_xlabel(x_axis_unit) 
                                    subplot.set_ylabel('ETR (µmol e$^{-}$ m$^{-2}$ s$^{-1}$)') 
                                    plots_MC_PAM_parameters = subplot # only to check if plotting has been performed
                        ######################################
                        ### PLOT AQUAPEN / PLANTPEN FILES  ###
                        ######################################
                        elif fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                            # Initialise the subplot function using number of rows and columns 
                            fig = plt.figure(figsize=(20,11))
                            fig.tight_layout() # Shrink to fit the canvas together with legend  
                            fig.subplots_adjust(hspace=0.4, wspace=0.3) # add horizontal space to read the x-axis and titles well
                            plt.rcParams['mathtext.default'] = 'regular' # Prevent subscripts in axes titles in italics
                            # Select color map, according to number of lines (files)
                            colors = plt.cm.nipy_spectral(np.linspace(0, 1, file_number+1)) # type: ignore  
                            ########## Sub-plot ##########
                            gs = fig.add_gridspec(nrows=3, ncols=5) # https://how2matplotlib.com/gridspec_kw.html
                            subplot = fig.add_subplot(gs[0, :5])
                            for i in range(len(Summary_file.columns)): # Read dataframe for the plot
                                if i > 0: # do not plot time axis
                                    subplot.plot(
                                        Summary_file.iloc[:, 0], # x-axis data: 1st column
                                        Summary_file.iloc[:, i], # y-axis data
                                        linewidth=2,
                                        label = Summary_file.columns[i], #legend
                                        color=colors[i-1]
                                        )
                            subplot.set_title("Raw fluorescence signal") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel(y_axis_unit)
                            subplot.legend(loc='upper left', bbox_to_anchor=(1.02, 1.02))  
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[1, 0]) 
                            for i in range(len(FT_ALL.columns)): # Read dataframe for the plot
                                if i > 1: # do not plot time axis
                                    subplot.scatter(
                                        FT_ALL.iloc[:, 1], # x-axis data: 1st column
                                        FT_ALL.iloc[:, i], # y-axis data
                                        color=colors[i-2]
                                        )
                            subplot.set_title("Steady-state flurescence") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit)
                            subplot.set_ylabel('Ft (a.u.)')
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[1, 1])
                            for i in range(len(FM_PRIME_ALL.columns)): # Read dataframe for the plot
                                if i > 1: # do not plot time point names and time axis 
                                    subplot.scatter(
                                        FM_PRIME_ALL.iloc[:, 1], # x-axis data: 1st column
                                        FM_PRIME_ALL.iloc[:, i], # y-axis data
                                        color=colors[i-2]
                                        )
                            subplot.set_title("Maximum fluorescence") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('Fm (a.u.)')
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[1, 2]) 
                            for i in range(len(FV_ALL.columns)): # Read dataframe for the plot
                                if i > 1: # do not plot time point names and time axis 
                                    subplot.scatter(
                                        FV_ALL.iloc[:, 1], # x-axis data: 1st column
                                        FV_ALL.iloc[:, i], # y-axis data
                                        color=colors[i-2]
                                        )
                            subplot.set_title("Variable fluorescence") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('Fv (a.u.)')
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[1, 3]) 
                            for i in range(len(NPQ_ALL_FM.columns)): # Read dataframe for the plot
                                if i > 1: # do not plot time point names and time axis 
                                    subplot.scatter(
                                        NPQ_ALL_FM.iloc[:, 1], # x-axis data: 1st column
                                        NPQ_ALL_FM.iloc[:, i], # y-axis data
                                        color=colors[i-2]
                                        )
                            subplot.set_title("NPQ, using F$_{m}$ value") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('NPQ (using F$_{m}$)') 
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[1, 4]) 
                            for i in range(len(NPQ_ALL_FM_MAX.columns)): # Read dataframe for the plot
                                if i > 1: # do not plot time point names and time axis 
                                    subplot.scatter(
                                        NPQ_ALL_FM_MAX.iloc[:, 1], # x-axis data: 1st column
                                        NPQ_ALL_FM_MAX.iloc[:, i], # y-axis data
                                        color=colors[i-2]
                                        )
                            subplot.set_title("NPQ, using F$_{m(max)}$ value") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('NPQ (using F$_{m(max)}$)') 
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[2, 0])
                            for i in range(len(QN_ALL_FM.columns)): # Read dataframe for the plot
                                if i > 1: # do not plot time point names and time axis 
                                    subplot.scatter(
                                        QN_ALL_FM.iloc[:, 1], # x-axis data: 1st column
                                        QN_ALL_FM.iloc[:, i], # y-axis data
                                        color=colors[i-2]
                                        )
                            subplot.set_title("Coefficient of NPQ") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('qN') 
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[2, 1])
                            for i in range(len(QP_ALL.columns)): # Read dataframe for the plot
                                if i > 1: # do not plot time point names and time axis 
                                    subplot.scatter(
                                        QP_ALL.iloc[:, 1], # x-axis data: 1st column
                                        QP_ALL.iloc[:, i], # y-axis data
                                        color=colors[i-2]
                                        )
                            subplot.set_title("Photochemical quenching") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('qP') 
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[2, 2])
                            for i in range(len(QY_ALL.columns)): # Read dataframe for the plot
                                    if i > 1: # do not plot time point names and time axis 
                                        subplot.scatter(
                                            QY_ALL.iloc[:, 1], # x-axis data: 1st column
                                            QY_ALL.iloc[:, i], # y-axis data
                                            color=colors[i-2]
                                            )
                            subplot.set_title("Quantum yield") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('Qy') 
                            ########## Sub-plot ##########
                            subplot = fig.add_subplot(gs[2, 3])
                            for i in range(len(ETR_ALL.columns)): # Read dataframe for the plot
                                    if i > 1: # do not plot time point names and time axis 
                                        subplot.scatter(
                                            ETR_ALL.iloc[:, 1], # x-axis data: 1st column
                                            ETR_ALL.iloc[:, i], # y-axis data
                                            color=colors[i-2]
                                            )
                            subplot.set_title("Electron transport rate") 
                            subplot.grid() # use: which='both' for minor grid
                            subplot.set_xlabel(x_axis_unit) 
                            subplot.set_ylabel('ETR (µmol e$^{-}$ m$^{-2}$ s$^{-1}$)') 
                            plots_AquaPen = subplot # only to check if plotting has been performed
                        # saving scatter plot to memory
                        memory_for_plot = io.BytesIO()
                        plt.savefig(memory_for_plot, bbox_inches='tight', format='JPEG')
                        plot_in_memory = base64.b64encode(memory_for_plot.getvalue())
                        plot_from_memory = plot_in_memory.decode('ascii')
                        # Clearing the plot
                        plt.clf()
                        plt.cla()
                        plt.close() 
                        ######################
                        ## Export to excel ###
                        ###################### 
                        # write all parameters to excel
                        writer = pd.ExcelWriter(f'{upload_folder}/{file_name_without_extension}_results.xlsx', engine='openpyxl')
                        if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' and request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_raw_data':
                            Summary_file.to_excel(writer, sheet_name = 'Raw fluorescence data', index=False)
                        elif fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)' and request.form["checkbox_NPQ_MC_PAM"] == 'checkbox_file_parameters':
                            FM_PRIME_ALL.to_excel(writer, sheet_name = 'Fm', index=False)
                            FT_ALL.to_excel(writer, sheet_name = 'Ft', index=False)
                            FV_ALL.to_excel(writer, sheet_name = 'Fv', index=False)
                            NPQ_ALL_FM.to_excel(writer, sheet_name = 'NPQ', index=False)
                            QN_ALL_FM.to_excel(writer, sheet_name = 'qN', index=False)
                            QP_ALL.to_excel(writer, sheet_name = 'qP', index=False)
                            QY_ALL.to_excel(writer, sheet_name = 'Qy', index=False)
                            ETR_ALL.to_excel(writer, sheet_name = 'ETR', index=False)
                        elif fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                            FM_PRIME_ALL.to_excel(writer, sheet_name = 'Fm', index=False)
                            FT_ALL.to_excel(writer, sheet_name = 'Ft', index=False)
                            FV_ALL.to_excel(writer, sheet_name = 'Fv', index=False)
                            NPQ_ALL_FM.to_excel(writer, sheet_name = 'NPQ', index=False)
                            QN_ALL_FM.to_excel(writer, sheet_name = 'qN', index=False)
                            QP_ALL.to_excel(writer, sheet_name = 'qP', index=False)
                            QY_ALL.to_excel(writer, sheet_name = 'Qy', index=False)
                            ETR_ALL.to_excel(writer, sheet_name = 'ETR', index=False)
                            Summary_file.to_excel(writer, sheet_name = 'Raw fluorescence data', index=False)
                        writer.close()
                        # Save images
                        wb = openpyxl.load_workbook(f'{upload_folder}/{file_name_without_extension}_results.xlsx')
                        wb.create_sheet(title='Images')
                        wb.move_sheet('Images', -(len(wb.sheetnames)-1))
                        ws = wb['Images']
                        img_data_raw = Image(memory_for_plot)
                        img_data_raw.anchor = 'A1'
                        ws.add_image(img_data_raw)
                        wb.save(f'{upload_folder}/{file_name_without_extension}_results.xlsx')  
                        xlsx_file_path = f'uploads/{file_name_without_extension}_results.xlsx'
                    ######################################
                    ### Delete files older than 20 min ###
                    ######################################
                    # List all files
                    list_of_files_in_upload_folder = os.listdir(upload_folder)
                    # get the current time
                    current_time = time.time()
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
                    flash(f'Please select up to {max_number_of_files} files.', category='error')   
    return render_template("slow_kin_data_analysis.html",
                        plot_from_memory = plot_from_memory,
                        xlsx_file_path = xlsx_file_path, 
                        PAR_ALL = PAR_ALL,
                        plots_MC_PAM_raw_data = plots_MC_PAM_raw_data,
                        plots_MC_PAM_parameters = plots_MC_PAM_parameters,
                        plots_AquaPen = plots_AquaPen)