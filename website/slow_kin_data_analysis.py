from flask import Blueprint, render_template, request, flash
import os, base64, io, time, openpyxl
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from scipy.ndimage import gaussian_filter1d         
from openpyxl.drawing.image import Image
from . import UPLOAD_FOLDER
from werkzeug.utils import secure_filename
import time

slow_kin_data_analysis = Blueprint('slow_kin_data_analysis', __name__)

@slow_kin_data_analysis.route('/slow_kin_data_analysis', methods=['GET', 'POST'])
def analyze_slow_kin_data():
    if request.method == "POST": 
        # Define global variables
        max_number_of_files = 50
        upload_folder = UPLOAD_FOLDER
        file_Aquapen = Summary_file = param_all = pd.DataFrame()
        ALLOWED_EXTENSIONS_MULTI_COLOR_PAM = set(['.csv', '.CSV'])
        ALLOWED_EXTENSIONS_AQUAPEN = set(['.txt']) 
        F0 = FM = FP = FM_LSS = NPQ_LSS = PQ_LSS = RFD = QY_MAX = QY_LSS = ACTINIC_WAVELENGTH = ACTINIC_INTENSITY = pd.DataFrame()
        Timing_Fm = FM_points = FM_PRIME_LIGHT_ALL = FM_PRIME_DARK_ALL = FM_PRIME_ALL = pd.DataFrame() 
        Timing_NPQ = NPQ_points = NPQ_LIGHT_ALL = NPQ_DARK_ALL = NPQ_ALL = pd.DataFrame()
        QP_points = QP_LIGHT_ALL = QP_DARK_ALL = QP_ALL = pd.DataFrame()
        QY_points = QY_LIGHT_ALL = QY_DARK_ALL = QY_ALL = pd.DataFrame()
        ETR_points = ETR_LIGHT_ALL = ETR_DARK_ALL = ETR_ALL = ETR_FM = pd.DataFrame()
        files_extensions = set()
        xlsx_file_path = x_axis_time = x_axis_unit = y_axis_unit = file_name_without_extension = str('') 
        

        # create upload directory, if there is not any
        if os.path.isdir(upload_folder) == False:
            os.mkdir(upload_folder)
        #######################
        ### Load OJIP files ###
        #######################
        # check if some file is selected
        if 'NPQ_files' in request.files:
            # get the current time
            current_time = time.time()
            # get list of files
            files = request.files.getlist("NPQ_files")
            # check if at least one file is selected
            if secure_filename(files[0].filename) == '': # type: ignore
                flash('Please select one or more files to analyze.', category='error') 
            else:
                # get info on fluorometer
                fluorometer = (request.form.get('fluorometer'))
                # Define fluorometer-dependent variables
                if fluorometer == 'MULTI-COLOR-PAM / Dual PAM (Heinz Walz GmbH)':
                    x_axis_time = 'time/ms'
                    x_axis_unit = "Time (ms)"
                    y_axis_unit = "Fluorescence intensity (V)"
                elif fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                    x_axis_time = 'time_us'
                    x_axis_unit = "Time (μs)"
                    y_axis_unit = "Fluorescence intensity (a.u.)"
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
                        #####################
                        ### AQUAPEN FILES ###
                        ##################### 
                        # Do for AquaPen / FluorPen files
                        if fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                            # Check if each file is of allowed type
                            if file_extension in ALLOWED_EXTENSIONS_AQUAPEN:
                                # to read .txt files, the files need to be first uploaded to server
                                file.save(os.path.join(upload_folder, file_name_full).replace("\\","/"))
                                # read .txt files
                                with open(upload_folder+file_name_full, "r") as temp_variable:
                                    # read the txt file 
                                    file_Aquapen = temp_variable.readlines() # reading without header: add [9:]
                                    file_Aquapen = pd.DataFrame(file_Aquapen)
                                    file_Aquapen = file_Aquapen[0].str.split('\t', expand=True)
                                    # Merge all data in the final dataframe
                                    if file_number == 0:
                                        # initiate final dataframe + drop the last column win '\n' only
                                        Summary_file = file_Aquapen[file_Aquapen.columns[:-1]]
                                        # rename column with fluorescence values according to file name
                                        Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True)
                                        # rename first column
                                        Summary_file.rename(columns = {Summary_file.columns[0]: 'time_us'}, inplace = True)
                                    else:
                                        # read fluorescence, as 2nd column in all other files
                                        fluorescence = file_Aquapen.iloc[:,1:2]
                                        # merge the fluorescence column with the final dataframe
                                        Summary_file = pd.concat([Summary_file, fluorescence], axis = 1)
                                        # rename the newly added column
                                        Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True)                                          
                                # Delete the uploaded file
                                os.remove(os.path.join(upload_folder, file_name_full).replace("\\","/"))
                        file_number = file_number + 1
                    ### check if correct file types were selected ###
                    if fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)' and '.txt' in files_extensions:
                        ######################################################################
                        ### Remove parameters calculated by Aquapen and keep only F values ###
                        ######################################################################
                        # Delete lines without numbers within the final dataframe
                        check = pd.DataFrame(Summary_file.time_us.str.isnumeric())
                        check.rename(columns={check.columns[0]: "A"}, inplace = True)                
                        # Check if parameters were exported
                        if Summary_file['time_us'].str.contains('Fo').any():
                            ###################################################
                            ### Put all values as exported by AquaPen to DF ###
                            ###################################################
                            # values measured for all settings
                            F0 = ((Summary_file[Summary_file["time_us"].str.contains("Fo")]).iloc[: , 1:]) # find F0
                            FP = ((Summary_file[Summary_file["time_us"].str.contains("Fp")]).iloc[: , 1:]) # find Fp
                            FM = ((Summary_file[Summary_file["time_us"].str.contains("Fm")]).iloc[: , 1:]) # select all values, including Fm_L1-L4/Fm_L1-L9
                            FM = pd.DataFrame(FM.iloc[0,:]).T # select only Fm
                            RFD = ((Summary_file[Summary_file["time_us"].str.contains("Rfd")]).iloc[: , 1:]) # find Rfd
                            QY_MAX = ((Summary_file[Summary_file["time_us"].str.contains("QY_max")]).iloc[: , 1:]) # find QY_max
                            ACTINIC_WAVELENGTH = ((Summary_file[Summary_file["time_us"].str.contains("ACTINIC-Wavelength")]).iloc[: , 1:]) # find wavelength of actinic light
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
                            # Settings for === NPQ2 ===
                            if request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ2':
                                if (Summary_file['time_us'].str.contains('Fm_L9').any()) and (Summary_file['time_us'].str.contains('Fm_D7').any()):
                                    # get series info specific for NPQ2 files
                                    Timing_Fm = pd.DataFrame({'time (sec)':[1.4, 32, 53, 74, 95, 116, 137, 158, 179, 200, 220, 243, 304, 365, 426, 487, 548, 609]})
                                    Timing_NPQ = pd.DataFrame({'time (sec)':[32, 53, 74, 95, 116, 137, 158, 179, 200, 220, 243, 304, 365, 426, 487, 548, 609]})
                                    FM_points = pd.DataFrame({'FM values':['Fm','Fm_L1','Fm_L2','Fm_L3','Fm_L4','Fm_L5','Fm_L6','Fm_L7','Fm_L8','Fm_L9','Fm_Lss','Fm_D1','Fm_D2','Fm_D3','Fm_D4','Fm_D5','Fm_D6','Fm_D7']})
                                    NPQ_points = pd.DataFrame({'NPQ values':['NPQ_L1','NPQ_L2','NPQ_L3','NPQ_L4','NPQ_L5','NPQ_L6','NPQ_L7','NPQ_L8','NPQ_L9','NPQ_Lss','NPQ_D1','NPQ_D2','NPQ_D3','NPQ_D4','NPQ_D5','NPQ_D6','NPQ_D7']})
                                    QP_points = pd.DataFrame({'QP values':['QP_L1','QP_L2','QP_L3','QP_L4','QP_L5','QP_L6','QP_L7','QP_L8','QP_L9','QP_Lss','QP_D1','QP_D2','QP_D3','QP_D4','QP_D5','QP_D6','QP_D7']})
                                    QY_points = pd.DataFrame({'QY values':['QY_max (Fv/Fm)','QY_L1','QY_L2','QY_L3','QY_L4','QY_L5','QY_L6','QY_L7','QY_L8','QY_L9','QY_Lss','QY_D1','QY_D2','QY_D3','QY_D4','QY_D5','QY_D6','QY_D7']})
                                    ETR_points = pd.DataFrame({'QY values':['ETR_QY_max','ETR_L1','ETR_L2','ETR_L3','ETR_L4','ETR_L5','ETR_L6','ETR_L7','ETR_L8','ETR_L9','ETR_Lss','ETR_D1','ETR_D2','ETR_D3','ETR_D4','ETR_D5','ETR_D6','ETR_D7']})
                                    # get indexes specific for NPQ2 files
                                    index_Fm_D7 = Summary_file.index[Summary_file['time_us'] == 'Fm_D7'].tolist()
                                    index_NPQ_D7 = Summary_file.index[Summary_file['time_us'] == 'NPQ_D7'].tolist()
                                    index_Qp_D7 = Summary_file.index[Summary_file['time_us'] == 'Qp_D7'].tolist()
                                    index_QY_D7 = Summary_file.index[Summary_file['time_us'] == 'QY_D7'].tolist()
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
                                    flash('Please select correct type of the NPQ protocol and/or files to analyze.', category='error')
                            # Settings for === NPQ3 ===
                            elif request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ3':
                                if (Summary_file['time_us'].str.contains('Fm_L9').any()) and not (Summary_file['time_us'].str.contains('Fm_D7').any()):
                                    Timing_Fm = pd.DataFrame({'time (sec)':[1.4, 19, 31, 43, 55, 67, 83, 109, 135]})
                                    FM_points = pd.DataFrame({'FM values':['Fm','Fm_L1','Fm_L2','Fm_L3','Fm_L4','Fm_L5','Fm_L6','Fm_L7','Fm_L8','Fm_L9','Fm_Lss','Fm_D1','Fm_D2']})
                                    # get indexes specific for NPQ3 files
                                    index_Fm_D2 = Summary_file.index[Summary_file['time_us'] == 'Fm_D2'].tolist()
                                    index_NPQ_D2 = Summary_file.index[Summary_file['time_us'] == 'NPQ_D2'].tolist()
                                    index_Qp_D2 = Summary_file.index[Summary_file['time_us'] == 'Qp_D2'].tolist()
                                    index_QY_D2 = Summary_file.index[Summary_file['time_us'] == 'QY_D2'].tolist()
                                    
                                    flash('Selected checkbox_NPQ_3', category='success') 

                                else:
                                    flash('Please select correct type of the NPQ protocol and/or files to analyze. Currently, NPQ3 AquaPen/FluorPen protocol has been selected for analysis.', category='error')
                            # Settings for === NPQ1 ===
                            elif request.form["checkbox_NPQ_Aquapen"] == 'checkbox_NPQ1':
                                Timing_Fm = pd.DataFrame({'time (sec)':[1.4, 32, 53, 74, 95, 116, 137, 158, 179, 200, 220, 243, 264]})
                                FM_points = pd.DataFrame({'FM values':['Fm','Fm_L1','Fm_L2','Fm_L3','Fm_L4','Fm_Lss','Fm_D1','Fm_D2','Fm_D3']})
                                # get indexes specific for NPQ1 files
                                index_Fm_D3 = Summary_file.index[Summary_file['time_us'] == 'Fm_D3'].tolist()
                                index_NPQ_D3 = Summary_file.index[Summary_file['time_us'] == 'NPQ_D3'].tolist()
                                index_Qp_D3 = Summary_file.index[Summary_file['time_us'] == 'Qp_D3'].tolist()
                                index_QY_D3 = Summary_file.index[Summary_file['time_us'] == 'QY_D3'].tolist()

                                
                                if not (Summary_file['time_us'].str.contains('Fm_L9').any()):
                                    
                                    flash('Selected checkbox_NPQ_1', category='success') 

                                else:
                                    flash('Please select correct type of the NPQ protocol and/or files to analyze. Currently, NPQ1 AquaPen/FluorPen protocol has been selected for analysis.', category='error')                          
                    else:
                        flash(f'There seems to be a problem with the uploaded data. Please revise the uploaded files.', category='error')
                    

                    #####################
                    ### CALCUALTE ETR ###
                    #####################
                    ETR_FM = QY_MAX.iloc[: , 0:].astype(float) * 0
                    ETR_LIGHT_ALL = QY_LIGHT_ALL.iloc[: , 1:].astype(float) * ACTINIC_INTENSITY.values.astype(float)
                    ETR_DARK_ALL = QY_DARK_ALL.iloc[: , 1:].astype(float) * 0
                    ###############################
                    ### MERGE THE MEASURED DATA ###
                    ###############################   
                    # Merge FM data 
                    FM_PRIME_ALL = pd.concat([FM_PRIME_LIGHT_ALL, FM_PRIME_DARK_ALL]).iloc[: , 1:]
                    FM_PRIME_ALL = pd.concat([FM, FM_PRIME_ALL]).reset_index(drop=True)
                    FM_PRIME_ALL = pd.concat([Timing_Fm, FM_PRIME_ALL], axis=1)
                    FM_PRIME_ALL = pd.concat([FM_points, FM_PRIME_ALL], axis=1)
                    # Merge NPQ data 
                    NPQ_ALL = pd.concat([NPQ_LIGHT_ALL, NPQ_DARK_ALL]).iloc[: , 1:].reset_index(drop=True)
                    NPQ_ALL = pd.concat([Timing_NPQ, NPQ_ALL], axis=1)
                    NPQ_ALL = pd.concat([NPQ_points, NPQ_ALL], axis=1)
                    # Merge QP data
                    QP_ALL = pd.concat([QP_LIGHT_ALL, QP_DARK_ALL]).iloc[: , 1:].reset_index(drop=True)
                    QP_ALL = pd.concat([Timing_NPQ, QP_ALL], axis=1)
                    QP_ALL = pd.concat([QP_points, QP_ALL], axis=1)
                    # Merge QY data
                    QY_ALL = pd.concat([QY_LIGHT_ALL, QY_DARK_ALL]).iloc[: , 1:]
                    QY_ALL = pd.concat([QY_MAX, QY_ALL]).reset_index(drop=True)
                    QY_ALL = pd.concat([Timing_Fm, QY_ALL], axis=1)
                    QY_ALL = pd.concat([QY_points, QY_ALL], axis=1)
                    # Merge ETR data
                    ETR_ALL = pd.concat([ETR_LIGHT_ALL, ETR_DARK_ALL]) 
                    ETR_ALL = pd.concat([ETR_FM, ETR_ALL]).reset_index(drop=True)
                    ETR_ALL = pd.concat([Timing_Fm, ETR_ALL], axis=1)
                    ETR_ALL = pd.concat([ETR_points, ETR_ALL], axis=1)

                    print("Summary_file: \n"+str(Summary_file))
                    print(ETR_ALL)

                
                else:
                    flash(f'Please select up to {max_number_of_files} files.', category='error')   
    return render_template("slow_kin_data_analysis.html")