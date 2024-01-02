from flask import Blueprint, render_template, request, flash, redirect
import os, base64, io, time
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from . import UPLOAD_FOLDER
from werkzeug.utils import secure_filename
from flask_login import current_user

OJIP_data_analysis = Blueprint('OJIP_data_analysis', __name__)

@OJIP_data_analysis.route('/OJIP_data_analysis', methods=['GET', 'POST'])
def analyze_OJIP_curves():
    if current_user.is_authenticated:
        if request.method == "POST": 

            # Define global variables
            max_number_of_files = 50
            OJIP_file_MULTI_COLOR_PAM = OJIP_file_Aquapen = Summary_file = OJIP_param_all = pd.DataFrame()      
            ALLOWED_EXTENSIONS_MULTI_COLOR_PAM = set(['.csv', '.CSV'])
            ALLOWED_EXTENSIONS_AQUAPEN = set(['.txt']) 
            files_extensions = set()
            upload_folder = UPLOAD_FOLDER
            OJIP_plot_from_memory = OJIP_parameters_from_memory = ()   
            xlsx_file_path = str('')   

            # create upload directory, if there is not any
            if os.path.isdir(upload_folder) == False:
                os.mkdir(upload_folder)

            #######################
            ### Load OJIP files ###
            #######################
            # check if some file is selected
            if 'OJIP_files' in request.files:
                # get list of files
                files = request.files.getlist("OJIP_files")
                # check if at least one file is selected
                if secure_filename(files[0].filename) == '':
                    flash('Please select one or more files to analyze.', category='error') 
                else:
                    # get info on fluorometer
                    fluorometer = (request.form.get('fluorometer'))
                    # Define fluorometer-dependent variables
                    if fluorometer == 'MULTI-COLOR-PAM (Heinz Walz GmbH)':
                        x_axis_time = 'time/ms'
                        x_axis_unit = "Time (μs)"
                        y_axis_unit = "Fluorescence intensity (V)"
                    elif fluorometer == 'Aquapen':
                        x_axis_time = 'time_us'
                        x_axis_unit = "Time (μs)"
                        y_axis_unit = "Fluorescence intensity (a.u.)"

                    # limit number of uploaded files
                    if len(files) <= max_number_of_files:
                        file_number = 0
                        # do for each file
                        for file in files:
                            # get image names and extension
                            file_name_without_extension = str.lower(os.path.splitext(file.filename)[0]) # for single image: image = (request.files['image']) 
                            file_extension = str.lower(os.path.splitext(file.filename)[1])
                            file_name_full = secure_filename(file.filename)
                            # append all extensions to a set
                            files_extensions.add(file_extension)

                            #############################
                            ### MULTI-COLOR-PAM FILES ###
                            #############################
                            # Do for MULTI-COLOR-PAM files
                            if fluorometer == 'MULTI-COLOR-PAM (Heinz Walz GmbH)':
                                # Check if each file is of allowed type
                                if file_extension in ALLOWED_EXTENSIONS_MULTI_COLOR_PAM:
                                    # read csv file directly, without uploading to server
                                    OJIP_file_MULTI_COLOR_PAM = pd.read_csv(files[(file_number)], sep=';')
                                    # Merge all data in the final dataframe
                                    if file_number == 0:
                                        # initiate final dataframe
                                        Summary_file = OJIP_file_MULTI_COLOR_PAM
                                        # rename column with fluorescence values as file name
                                        Summary_file.rename(columns = {Summary_file.columns[1]: file_name_without_extension}, inplace = True)
                                    else:
                                        # read fluorescence, as 2nd column in all other files
                                        fluorescence = OJIP_file_MULTI_COLOR_PAM.iloc[:,1:2]
                                        # merge the fluorescence column with the final dataframe
                                        Summary_file = pd.concat([Summary_file, fluorescence], axis = 1)
                                        # rename the newly added column
                                        Summary_file.rename(columns = {Summary_file.columns[file_number+1]: file_name_without_extension}, inplace = True)

                            #####################
                            ### AQUAPEN FILES ###
                            ##################### 
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
                        if (fluorometer == 'MULTI-COLOR-PAM (Heinz Walz GmbH)' and '.csv' in files_extensions) or (fluorometer == 'Aquapen' and '.txt' in files_extensions):

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
                                Summary_file = Summary_file.astype(int)

                            #################################################
                            ### Reduce file size of MULTI-COLOR PAM FILES ###
                            #################################################
                            if fluorometer == 'MULTI-COLOR-PAM (Heinz Walz GmbH)':
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

                            ############################
                            ### Calculate parameters ###
                            ############################
                            ### Find indexes of parameters for MULTI-COLOR-PAM
                            if fluorometer == 'MULTI-COLOR-PAM (Heinz Walz GmbH)':
                                # locate F0 for MC-PAM
                                F0_index = Summary_file[x_axis_time].sub(0.01).abs().idxmin()
                                # find indexes of rows with closest value to individual points column
                                F_20us_index = Summary_file[x_axis_time].sub(0.02).abs().idxmin()
                                F_50us_index = Summary_file[x_axis_time].sub(0.05).abs().idxmin()
                                F_100us_index = Summary_file[x_axis_time].sub(0.1).abs().idxmin()
                                FK_300us_index = Summary_file[x_axis_time].sub(0.3).abs().idxmin()
                                FJ_2ms_index = Summary_file[x_axis_time].sub(2).abs().idxmin()
                                FI_30_ms_index = Summary_file[x_axis_time].sub(30).abs().idxmin()

                            ### Find indexes of parameters for AQUAPEN 
                            elif fluorometer == 'Aquapen':
                                # calculate F0 for Aquapen
                                F0_index = Summary_file[x_axis_time].sub(0).abs().idxmin()
                                # find indexes of rows with closest value to individual points column
                                F_20us_index = Summary_file[x_axis_time].sub(20).abs().idxmin()
                                F_50us_index = Summary_file[x_axis_time].sub(50).abs().idxmin()
                                F_100us_index = Summary_file[x_axis_time].sub(100).abs().idxmin()
                                FK_300us_index = Summary_file[x_axis_time].sub(300).abs().idxmin()
                                FJ_2ms_index = Summary_file[x_axis_time].sub(2000).abs().idxmin()
                                FI_30_ms_index = Summary_file[x_axis_time].sub(30000).abs().idxmin()

                            # get the parameters from indexes - as pd.series
                            F0 = (Summary_file.drop(x_axis_time, axis=1)).loc[F0_index]
                            F20 = (Summary_file.drop(x_axis_time, axis=1)).loc[F_20us_index]
                            F50 = (Summary_file.drop(x_axis_time, axis=1)).loc[F_50us_index]
                            F100 = (Summary_file.drop(x_axis_time, axis=1)).loc[F_100us_index]
                            FK = (Summary_file.drop(x_axis_time, axis=1)).loc[FK_300us_index]
                            FJ = (Summary_file.drop(x_axis_time, axis=1)).loc[FJ_2ms_index]
                            FI = (Summary_file.drop(x_axis_time, axis=1)).loc[FI_30_ms_index]
                            FM = (Summary_file.drop(x_axis_time, axis=1)).max()

                            # calculate additional parameters
                            FV = FM - F0
                            FVFM = FV / FM
                            M0 = 4* (FK - F50) / FV # 4(F0.3ms – F0.05ms)/FV
                            VJ = (FJ - F0) / FV 
                            VI = (FI - F0) / FV
                            JI = (FI - FJ) / 28
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

                            ##############################
                            ### Normalize OJIP curves  ###
                            ##############################
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

                            ########################
                            ### Plot OJIP curves ###
                            ########################                            
                            # Select color map, according to number of lines (files)
                            colors = plt.cm.nipy_spectral(np.linspace(0, 1, max_number_of_files+1))

                            # Initialise the subplot function using number of rows and columns 
                            fig = plt.figure(figsize=(19,11))
                            fig.tight_layout() # Shrink to fit the canvas together with legend     

                            ########## Sub-plot OJIP curves - raw data ##########
                            fig_1 = fig.add_subplot(231) # for numbering, see https://stackoverflow.com/questions/3584805/what-does-the-argument-mean-in-fig-add-subplot111
                            # Read OJIP curves throughout the datafrmae for the plot
                            for i in range(len(Summary_file.columns)):
                                # do not plo time axis
                                if i > 0:                                
                                    fig_1.plot(
                                        Summary_file.iloc[:, 0], # x-axis data: 1st column
                                        Summary_file.iloc[:, i], # y-axis data
                                        label = Summary_file.columns[i], # Column names for legend
                                        color=colors[i]
                                        ) 
                            # Decorate fig 1
                            fig_1.set_title("OJIP curves: raw data") 
                            fig_1.set_xscale("log") # decorate scatter plot
                            fig_1.grid() # use: which='both' for minor grid
                            fig_1.set_xlabel(x_axis_unit) 
                            fig_1.set_ylabel(y_axis_unit) 

                            ########## Sub-plot OJIP curves - shifted to zero ##########
                            fig_2 = fig.add_subplot(232) 
                            # Prepare the plot
                            for i in range(len(OJIP_shifted_to_zero.columns)):
                                # do not plo time axis
                                if i > 0:
                                    plt.plot(
                                        OJIP_shifted_to_zero.iloc[:, 0], # x-axis data: 1st column
                                        OJIP_shifted_to_zero.iloc[:, i], # y-axis data
                                        label = OJIP_shifted_to_zero.columns[i], # Column names for legend
                                        color=colors[i]
                                        )
                            # Decorate fig 2
                            fig_2.set_title("OJIP curves: shifted to zero") 
                            fig_2.set_xscale("log")
                            fig_2.grid() # use: which='both' for minor grid
                            fig_2.set_xlabel(x_axis_unit) 
                            fig_2.set_ylabel(y_axis_unit) 
                            fig_2.set_ylim(0,)
                            fig_2.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02))

                            ########## Sub-plot OJIP curves - shifted to FM ##########
                            fig_3 = fig.add_subplot(234) 
                            # Prepare the plot
                            for i in range(len(OJIP_shifted_to_max.columns)):
                                # do not plo time axis
                                if i > 0:
                                    plt.plot(
                                        OJIP_shifted_to_max.iloc[:, 0], # x-axis data: 1st column
                                        OJIP_shifted_to_max.iloc[:, i], # y-axis data
                                        label = OJIP_shifted_to_max.columns[i], # Column names for legend
                                        color=colors[i]
                                        )
                            # decorate scatter plot
                            fig_3.set_title("OJIP curves: shifted to Fm") 
                            fig_3.set_xscale("log")
                            fig_3.grid() # use: which='both' for minor grid
                            fig_3.set_xlabel(x_axis_unit) 
                            fig_3.set_ylabel(y_axis_unit)
                            if fluorometer == 'MULTI-COLOR-PAM (Heinz Walz GmbH)':
                                fig_3.set_ylim(0,)

                            ########## Sub-plot OJIP curves - double normalized ##########
                            fig_4 = fig.add_subplot(235)
                            # Prepare the plot
                            for i in range(len(OJIP_double_normalized.columns)):
                                # do not plo time axis
                                if i > 0:
                                    plt.plot(
                                        OJIP_double_normalized.iloc[:, 0], # x-axis data: 1st column
                                        OJIP_double_normalized.iloc[:, i], # y-axis data
                                        label = OJIP_double_normalized.columns[i], # Column names for legend
                                        color=colors[i]
                                        )
                            # decorate scatter plot
                            fig_4.set_title("OJIP curves: double normalized") 
                            fig_4.set_xscale("log")
                            fig_4.grid() # use: which='both' for minor grid
                            fig_4.set_xlabel(x_axis_unit) 
                            fig_4.set_ylabel(" Fluorescence intensity (r.u.)")
                            fig_4.set_ylim(0,1)
                            
                            # saving scatter plot to memory
                            memory_for_OJIP_plot = io.BytesIO()
                            plt.savefig(memory_for_OJIP_plot, bbox_inches='tight', format='JPEG')
                            OJIP_plot_in_memory = base64.b64encode(memory_for_OJIP_plot.getvalue())
                            OJIP_plot_from_memory = OJIP_plot_in_memory.decode('ascii')

                            # Clearing the plot
                            plt.clf()
                            plt.cla()
                            plt.close()

                            #######################
                            ### Plot parameters ###
                            #######################
                            # Initialise the subplot function using number of rows and columns 
                            fig = plt.figure(figsize=(20,20)) 
                            fig.tight_layout() # Shrink to fit the canvas together with legend   
                            FI_list = pd.DataFrame([FI]) # FI to df, needed for legend

                            # Sub-plot F0 
                            fig_1 = fig.add_subplot(6, 4, 1)                  
                            F0.plot.bar(xticks=[], color=colors)
                            fig_1.set_title("F0")
                            fig_1.set_ylabel(y_axis_unit)
                            # Sub-plot FJ 
                            fig_2 = fig.add_subplot(6, 4, 2)                  
                            FJ.plot.bar(xticks=[], color=colors)
                            fig_2.set_title("FJ (2 ms)")
                            # Sub-plot FI 
                            fig_3 = fig.add_subplot(6, 4, 3) 
                            # Prepare the plot
                            for i in range(len(FI_list.columns)):
                                # do not plo time axis
                                plt.bar(
                                    FI_list.columns[i], # x-axis data
                                    FI_list.iloc[:, i], # y-axis data
                                    label = FI_list.columns[i], # Column names for legend
                                    color=colors[i],
                                    width = 0.5 # width of the columns
                                    )
                            fig_3.set_title("FI (30 ms)")
                            fig_3.margins(x=0.42**len(FI_list.columns)) # space between the axes and the first and last bar
                            fig_3.set_xticks([])
                            fig_3.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02)) # 
                            # Sub-plot FM 
                            fig_4 = fig.add_subplot(6, 4, 5)     
                            FM.plot.bar(xticks=[],color=colors)
                            fig_4.set_title("FP")
                            fig_4.set_ylabel(y_axis_unit)
                            # Sub-plot VJ 
                            fig_6 = fig.add_subplot(6, 4, 6)                  
                            VJ.plot.bar(xticks=[], color=colors)
                            fig_6.set_title("VJ")
                            fig_6.set_ylabel("r.u.")
                            # Sub-plot VI 
                            fig_7 = fig.add_subplot(6, 4, 7)                  
                            VI.plot.bar(xticks=[], color=colors)
                            fig_7.set_title("VI")
                            # Sub-plot M0 
                            fig_8 = fig.add_subplot(6, 4, 9)                  
                            M0.plot.bar(xticks=[], color=colors)
                            fig_8.set_title("M0")
                            fig_8.set_ylabel("r.u.")
                            # Sub-plot PSIE0 
                            fig_9 = fig.add_subplot(6, 4, 10)                  
                            PSIE0.plot.bar(xticks=[], color=colors)
                            fig_9.set_title("ψE0")
                            # Sub-plot PSIR0 
                            fig_10 = fig.add_subplot(6, 4, 11)                  
                            PSIR0.plot.bar(xticks=[], color=colors)
                            fig_10.set_title("ψR0")
                            # Sub-plot DELTAR0 
                            fig_11 = fig.add_subplot(6, 4, 13)                  
                            DELTAR0.plot.bar(xticks=[], color=colors)
                            fig_11.set_title("δR0")
                            fig_11.set_ylabel("r.u.")
                            # Sub-plot PHIE0 
                            fig_12 = fig.add_subplot(6, 4, 14)                  
                            PHIE0.plot.bar(xticks=[], color=colors)
                            fig_12.set_title("φE0")
                            # Sub-plot PHIR0 
                            fig_13 = fig.add_subplot(6, 4, 15)                  
                            PHIR0.plot.bar(xticks=[], color=colors)
                            fig_13.set_title("φR0")
                            # Sub-plot ABSRC 
                            fig_14 = fig.add_subplot(6, 4, 17)                  
                            ABSRC.plot.bar(xticks=[], color=colors)
                            fig_14.set_title("ABS/RC")
                            fig_14.set_ylabel("r.u.")
                            # Sub-plot TR0RC 
                            fig_15 = fig.add_subplot(6, 4, 18)                  
                            TR0RC.plot.bar(xticks=[], color=colors)
                            fig_15.set_title("TR0/RC")
                            # Sub-plot ET0RC 
                            fig_16 = fig.add_subplot(6, 4, 19)                  
                            ET0RC.plot.bar(xticks=[], color=colors)
                            fig_16.set_title("ET0/RC")
                            # Sub-plot RE0RC 
                            fig_17 = fig.add_subplot(6, 4, 21)                  
                            RE0RC.plot.bar(xticks=[], color=colors)
                            fig_17.set_title("RE0/RC")
                            fig_17.set_ylabel("r.u.")
                            # Sub-plot DI0RC 
                            fig_18 = fig.add_subplot(6, 4, 22)                  
                            DI0RC.plot.bar(xticks=[], color=colors)
                            fig_18.set_title("DI0/RC")
                            # Sub-plot JI 
                            fig_19 = fig.add_subplot(6, 4, 23)                  
                            JI.plot.bar(xticks=[], color=colors)
                            fig_19.set_title("J-I slope")
                            fig_19.set_ylabel("1/time")
                                                  
                            # saving scatter plot to memory
                            memory_for_OJIP_parameters = io.BytesIO()
                            plt.savefig(memory_for_OJIP_parameters, bbox_inches='tight', format='JPEG')
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
                            OJIP_param_all = pd.concat([OJIP_param_all, VJ], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, VI], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, M0], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, PSIE0], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, PSIR0], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, DELTAR0], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, PHIE0], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, PHIR0], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, ABSRC], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, TR0RC], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, ET0RC], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, RE0RC], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, DI0RC], axis = 1)
                            OJIP_param_all = pd.concat([OJIP_param_all, JI], axis = 1)
                            # name columns
                            OJIP_param_all.columns = ['F0','FK','FJ','FI','FP','VJ','VI','M0','ψE0','ψR0',
                                                      'δR0', 'φE0', 'φR0', 'ABS/RC', 'TR0/RC', 'ET0/RC', 
                                                      'RE0/RC', 'DI0/RC', 'J-I slope'] 

                            # write all parameters to excel
                            writer = pd.ExcelWriter(f'{upload_folder}/{file_name_without_extension}_results.xlsx', engine='openpyxl')
                            Summary_file.to_excel(writer, sheet_name = 'OJIP_raw', index=False)
                            OJIP_shifted_to_zero.to_excel(writer, sheet_name = 'OJIP_to_zero', index=False)
                            OJIP_shifted_to_max.to_excel(writer, sheet_name = 'OJIP_to_max', index=False)
                            OJIP_double_normalized.to_excel(writer, sheet_name = 'OJIP_norm', index=False)
                            OJIP_param_all.to_excel(writer, sheet_name = 'Parameters', index=True)
                            writer.close()

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
                            flash('Please select correct file types for analysis (.csv files for MULTI-COLOR PAM, .txt files for AquaPen).', category='error')    
                    else:
                        flash(f'Please select up to {max_number_of_files} files.', category='error')                
            
            else:
                flash('Please select .csv (MULTI-COLOR PAM) or .txt (AquaPen) files.', category='error')
            
            return render_template("OJIP_analysis.html",
                            max_number_of_files = max_number_of_files,
                            OJIP_file_MULTI_COLOR_PAM = OJIP_file_MULTI_COLOR_PAM,
                            OJIP_file_Aquapen = OJIP_file_Aquapen,
                            OJIP_plot_from_memory = OJIP_plot_from_memory,
                            OJIP_parameters_from_memory = OJIP_parameters_from_memory,
                            xlsx_file_path = xlsx_file_path
                            )
        
        return render_template("OJIP_analysis.html")
    else:
        flash('Please login', category='error')
        return redirect("/login")