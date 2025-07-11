from flask import Blueprint, render_template, request, flash
import os, base64, io, time, openpyxl
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from openpyxl.drawing.image import Image
from scipy.optimize import curve_fit
from scipy import stats
from . import UPLOAD_FOLDER
from werkzeug.utils import secure_filename
#from flask_login import current_user

light_curves_analysis = Blueprint('light_curves_analysis', __name__)

@light_curves_analysis.route('/light_curves_analysis', methods=['GET', 'POST'])
def analyze_light_curves():
#    if current_user.is_authenticated:
    if request.method == "POST": 
        # Define global variables
        max_number_of_files = 50
        file_Aquapen = Summary_file = param_all = QYALL = ETRALL = FTALL = FMALL = FITALL = QP = QN = pd.DataFrame()   
        F0 = FM = ETRMPOT = ALPHA = BETA = ETRMAX = IK = IB = ETRMAX_FROM_ALPHA_BETA = pd.Series()
        ALLOWED_EXTENSIONS_AQUAPEN = set(['.txt']) 
        files_extensions = set()
        upload_folder = UPLOAD_FOLDER
        raw_data_from_memory = plot_from_memory = parameters_from_memory = fluorescence = ()   
        light_intensities = []
        xlsx_file_path = x_axis_unit = y_axis_unit = file_name_without_extension = str('')  
        # create upload directory, if there is not any
        if os.path.isdir(upload_folder) == False: 
            os.mkdir(upload_folder) 
        ##################
        ### Load files ###
        ##################
        # check if some file is selected
        if 'light_curve_files' in request.files:
            # get list of files
            files = request.files.getlist("light_curve_files")
            # check if at least one file is selected
            if secure_filename(files[0].filename) == '': # type: ignore
                flash('Please select one or more files to analyze.', category='error') 
            else:
                # get info on fluorometer
                fluorometer = (request.form.get('fluorometer'))
                ETR_max_factor = int(request.form["ETR_max_multiplication_factor_range"])
                # Define fluorometer-dependent variables
                if fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                    x_axis_unit = "Time (μs)"
                    y_axis_unit = "Fluorescence intensity (a.u.)"
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
                                    file_Aquapen =  pd.DataFrame(file_Aquapen)
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
                        if fluorometer == 'AquaPen / FluorPen (Photon Systems Instruments spol. s r.o.)':
                            # Delete lines without numbers within the final dataframe
                            check = pd.DataFrame(Summary_file.time_us.str.isnumeric())
                            check.rename(columns={check.columns[0]: "A"}, inplace = True)
                            # Check if parameters were exported
                            if Summary_file['time_us'].str.contains('Fo').any():
                                ###################################################
                                ### Put all values as exported by AquaPen to DF ###
                                ###################################################
                                # values applied for all settings
                                F0 = ((Summary_file[Summary_file["time_us"].str.contains("Fo")]).iloc[: , 1:]) # find F0
                                FM = ((Summary_file[Summary_file["time_us"].str.contains("Fm")]).iloc[: , 1:]) # selet all values, including Fm_L1-L7
                                FM = pd.DataFrame(FM.iloc[0,:]).T # select only Fm
                                # get indexes
                                index_FtL1 = Summary_file.index[Summary_file['time_us'] == 'Ft_L1'].tolist()
                                index_FtL5 = Summary_file.index[Summary_file['time_us'] == 'Ft_L5'].tolist()
                                index_FML1 = Summary_file.index[Summary_file['time_us'] == 'Fm_L1'].tolist()
                                index_FML5 = Summary_file.index[Summary_file['time_us'] == 'Fm_L5'].tolist()
                                # Settings for LC2
                                if request.form["checkbox_LC"] == 'checkbox_LC2':
                                    if not (Summary_file['time_us'].str.contains('Fm_L6').any()):
                                        light_intensities = [100, 200, 300, 500, 1000] 
                                        # get DF with all values
                                        FTALL = Summary_file.iloc[index_FtL1[0]:(index_FtL5[0]+1)]
                                        FMALL = Summary_file.iloc[index_FML1[0]:(index_FML5[0]+1)]
                                    else:
                                        flash('Please select correct type of light curves (LC1 / LC2 / LC3).', category='error')
                                # Settings for LC1
                                elif request.form["checkbox_LC"] == 'checkbox_LC1':
                                    if (Summary_file['time_us'].str.contains('Fm_L6').any()) and not (Summary_file['time_us'].str.contains('Fm_L7').any()):
                                        light_intensities = [10, 20, 50, 100, 300, 500]
                                        index_FtL6 = Summary_file.index[Summary_file['time_us'] == 'Ft_L6'].tolist()
                                        index_FML6 = Summary_file.index[Summary_file['time_us'] == 'Fm_L6'].tolist()
                                        FTALL = Summary_file.iloc[index_FtL1[0]:(index_FtL6[0]+1)]
                                        FMALL = Summary_file.iloc[index_FML1[0]:(index_FML6[0]+1)]
                                    else:
                                        flash('Please select correct type of light curves (LC1 / LC2 / LC3).', category='error')
                                # Settings for LC3
                                elif request.form["checkbox_LC"] == 'checkbox_LC3':
                                    if Summary_file['time_us'].str.contains('Fm_L7').any():
                                        light_intensities = [10, 20, 50, 100, 300, 500, 1000]
                                        index_FtL7 = Summary_file.index[Summary_file['time_us'] == 'Ft_L7'].tolist()
                                        index_FML7 = Summary_file.index[Summary_file['time_us'] == 'Fm_L7'].tolist()
                                        FTALL = Summary_file.iloc[index_FtL1[0]:(index_FtL7[0]+1)]
                                        FMALL = Summary_file.iloc[index_FML1[0]:(index_FML7[0]+1)]
                                    else:
                                        flash('Please select correct type of light curves (LC1 / LC2 / LC3).', category='error')
                                # Remove all rows in 'Summary_file' according to 'False' values in 'check' DF
                                Summary_file = Summary_file[check.A]
                                # convert df to numeric
                                Summary_file = Summary_file.astype(int) # type: ignore
                                #####################
                                ### PLOT RAW DATA ###
                                #####################  
                                # Select color map, according to number of lines (files)
                                colors = plt.cm.nipy_spectral(np.linspace(0, 1, file_number+1)) # type: ignore
                                # Initialise the subplot function using number of rows and columns 
                                fig = plt.figure(figsize=(20,12))
                                fig.tight_layout() # Shrink to fit the canvas together with legend  
                                fig.subplots_adjust(hspace=0.3) # add horizontal space to read the x-axis and titles well
                                plt.rcParams['mathtext.default'] = 'regular' # Prevent subscripts in axes titles in italics
                                # plot raw data
                                fig_0 = fig.add_subplot(2, 3, 1)
                                for i in range(len(Summary_file.columns)):
                                    # do not plot time axis
                                        if i > 0:
                                            fig_0.plot(
                                                Summary_file.iloc[:, 0], # x-axis data: 1st column
                                                Summary_file.iloc[:, i], # y-axis data
                                                linewidth=2,
                                                label = Summary_file.columns[i], #legend
                                                color=colors[i-1]
                                                )
                                # Decorate plot
                                fig_0.set_title("Raw fluorescence signal") 
                                fig_0.grid() # use: which='both' for minor grid
                                fig_0.set_xlabel(x_axis_unit) 
                                fig_0.set_ylabel(y_axis_unit)   
                                fig_0.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02)) 
                                # saving scatter plot to memory
                                memory_for_raw_data = io.BytesIO()
                                plt.savefig(memory_for_raw_data, bbox_inches='tight', format='JPEG')
                                raw_data_in_memory = base64.b64encode(memory_for_raw_data.getvalue())
                                raw_data_from_memory = raw_data_in_memory.decode('ascii')
                                # Clearing the plot
                                plt.clf()
                                plt.cla()
                                plt.close()                                   
                                ###################################
                                ### GET FM, FT, QY, ETR and NPQ ###
                                ###################################
                                # reset indexes in DFs
                                FTALL = (FTALL.reset_index(drop=True))
                                FMALL = (FMALL.reset_index(drop=True))
                                F0 = (F0.reset_index(drop=True))
                                FM = (FM.reset_index(drop=True))
                                # convert the DF values to numeric
                                FTALL = FTALL.iloc[:, 1:].apply(pd.to_numeric)
                                FMALL = FMALL.iloc[:, 1:].apply(pd.to_numeric)
                                F0 = F0.iloc[0:,].apply(pd.to_numeric)
                                FM = FM.iloc[0:,].apply(pd.to_numeric)
                                # Calculate parameters
                                FMMAX = pd.DataFrame(FMALL.max()).T # Get maximal Fm 
                                FMMAX2 = pd.DataFrame(np.repeat(FMMAX.values, len(light_intensities), axis=0), columns=FMMAX.columns) # Replicate FMM to all columns according to length of the final DF
                                F02 = pd.DataFrame(np.repeat(F0.values, len(light_intensities), axis=0), columns=F0.columns) # Replicate F0 to all columns according to length of the final DF
                                FM2 = pd.DataFrame(np.repeat(FM.values, len(light_intensities), axis=0), columns=FM.columns) # Replicate FMM to all columns according to length of the final DF
                                QYALL = (FMALL - FTALL) / FMALL # calculate QY = (FM - FT) / FM
                                NPQALLFMM = (FMMAX2 - FMALL) / FMALL # Calculate NPQ = (FMmax - FM')/FM'
                                NPQALLFM = (FM2 - FMALL) / FMALL # Calculate NPQ = (FM - FM')/FM'
                                QP = (FMALL - FTALL) / (FMALL - F02) # calculate qP = (FM' - FT) / (FM' - F0)
                                QN = (FMMAX2 - FMALL) / (FMMAX2 - F02) # calculate qN = (Fmax - Fm') / (Fmax - F0)
                                # append light intensities
                                FTALL.insert(loc=0, column='Light intensity', value=light_intensities)
                                FMALL.insert(loc=0, column='Light intensity', value=light_intensities)
                                QYALL.insert(loc=0, column='Light intensity', value=light_intensities)
                                NPQALLFMM.insert(loc=0, column='Light intensity', value=light_intensities)
                                NPQALLFM.insert(loc=0, column='Light intensity', value=light_intensities)
                                QP.insert(loc=0, column='Light intensity', value=light_intensities)
                                QN.insert(loc=0, column='Light intensity', value=light_intensities)
                                # Calculate ETR
                                ETRALL = QYALL.iloc[:, 1:].mul(pd.Series(light_intensities), axis = 0) # calculate 𝑟𝐸𝑇𝑅 = 𝛟𝑷𝑺𝑰𝑰 x PAR
                                ETRALL.insert(loc=0, column='Light intensity', value=light_intensities)
                                ########################
                                #### Fit ETR curves ####
                                ######################## 
                                # define the model of Platt function
                                def model_platt(x, ETRmPot, alpha, beta):
                                    return ETRmPot * (1-np.exp(-(alpha*x/ETRmPot))) * np.exp(-(beta*x/ETRmPot))                     
                                # Find ETR max for each file
                                ETRMAX = pd.Series(ETRALL.max()).iloc[1:]
                                # check if the light curve is not out of fitting 
                                if (min(ETRMAX) == 0) or (min(ETRMAX) < 0):
                                    return render_template("light_curves_analysis.html",
                                        raw_data_from_memory = raw_data_from_memory,
                                        )
                                else:    
                                    # Find parameters for ETR curve fit for all light curves
                                    for i in range(len(ETRALL.columns)):
                                        if i > 0:
                                            # Set boundaries
                                            ETRmax_boundary = ETR_max_factor * ETRMAX.iloc[i-1] # set ETR_max to initial condidions AND boundaries 
                                            # Find the parameters
                                            parameters, covariance = curve_fit(model_platt, ETRALL.iloc[:,0], ETRALL.iloc[:,i], p0=np.asarray([ETRmax_boundary,0.05,0.05]), bounds=((0, 0, 0), (ETRmax_boundary, 25, 25)), maxfev=2000) # p0: initial conditions / bounds: boundaries min, max / maxfev: number of iterations
                                            ETRmPot = parameters[0]
                                            alpha = parameters[1]
                                            beta = parameters[2]
                                            fit_ETR = pd.DataFrame(model_platt(ETRALL.iloc[:,0], ETRmPot, alpha, beta))
                                            ETR_max_from_alpha_beta = ETRmPot * (alpha / (alpha + beta)) * (beta / (alpha + beta)) ** (beta / alpha) # 𝐸𝑇𝑅𝑚𝑎𝑥 = 𝐸𝑇𝑅𝑠 [ 𝛼 / (𝛼+𝛽)] * [ 𝛽 / (𝛼+𝛽) ]^(𝛽/𝛼)
                                            ETRMAX_FROM_ALPHA_BETA = pd.concat([ETRMAX_FROM_ALPHA_BETA,pd.Series(ETR_max_from_alpha_beta)])
                                            #### calculate alpha and beta from the ETR slope of first and last points of the fitted curve 
                                            slope1, intercept1, r1, p1, se1 = stats.linregress(ETRALL.iloc[0:3,0], fit_ETR.iloc[0:3,0]) # linregress(x, y)
                                            slope2, intercept2, r2, p2, se2 = stats.linregress(ETRALL.iloc[-2:,0], fit_ETR.iloc[-2:,0]) # linregress(x, y)
                                            alpha = slope1
                                            beta = slope2
                                            beta_abs = abs(slope2) # type: ignore
                                            # Calculate the additional parameters
                                            Ik = ETRMAX.iloc[i-1] / alpha # Ik = ETRmax/alpha
                                            Ib = ETRMAX.iloc[i-1] / beta_abs # Calculate Ib = ETRmax/beta

                                            ETRMPOT = pd.concat([ETRMPOT,pd.Series(ETRmPot)])
                                            ALPHA = pd.concat([ALPHA,pd.Series(alpha)])
                                            BETA = pd.concat([BETA,pd.Series(beta)])
                                            IK = pd.concat([IK,pd.Series(Ik)])
                                            IB = pd.concat([IB,pd.Series(Ib)])
                                            FITALL = pd.concat([FITALL,fit_ETR], axis=1)
                                    # rename column names according to file names in FITALL df        
                                    FITALL.columns = list(ETRALL.columns[1:len(ETRALL.columns)])
                                    # append light intensity to FITALL df 
                                    FITALL.insert(loc=0, column='Light intensity', value=light_intensities)
                                    ###################
                                    ### Plot curves ###
                                    ###################                          
                                    # Initialise the subplot function using number of rows and columns 
                                    fig = plt.figure(figsize=(19,12))
                                    fig.tight_layout() # Shrink to fit the canvas together with legend  
                                    fig.subplots_adjust(hspace=0.4) # add horizontal space to read the x-axis and titles well
                                    plt.rcParams['mathtext.default'] = 'regular' # Prevent subscripts in axes titles in italics
                                    ########## Sub-plot light curves - raw data ##########
                                    fig_1 = fig.add_subplot(3, 4, 1) # https://stackoverflow.com/questions/3584805/what-does-the-argument-mean-in-fig-add-subplot111
                                    # Read OJIP curves throughout the datafrmae for the plot
                                    for i in range(len(Summary_file.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_1.plot(
                                                    Summary_file.iloc[:, 0], # x-axis data: 1st column
                                                    Summary_file.iloc[:, i], # y-axis data
                                                    linewidth=2,
                                                    color=colors[i-1]
                                                    )
                                    # Decorate fig 1
                                    fig_1.set_title("Raw fluorescence signal") 
                                    fig_1.grid() # use: which='both' for minor grid
                                    fig_1.set_xlabel(x_axis_unit) 
                                    fig_1.set_ylabel(y_axis_unit) 
                                    ########## Sub-plot Ft ##########
                                    fig_2 = fig.add_subplot(3, 4, 2) 
                                    # Read NPQ throughout the datafrmae for the plot
                                    for i in range(len(FTALL.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_2.plot(
                                                    FTALL.iloc[:, 0], # x-axis data: 1st column
                                                    FTALL.iloc[:, i], # y-axis data
                                                    linewidth=1,
                                                    color=colors[i]
                                                    )
                                                fig_2.scatter(
                                                    FTALL.iloc[:, 0], # x-axis data: 1st column
                                                    FTALL.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    # Decorate fig
                                    fig_2.set_title("Steady-state fluorescence, F$_{t}$") 
                                    fig_2.grid() # use: which='both' for minor grid
                                    fig_2.set_xlabel('Light intensity (µmol photons m$^{-2}$ s$^{-1}$)') 
                                    ########## Sub-plot FM ##########
                                    fig_3 = fig.add_subplot(3, 4, 3) # https://stackoverflow.com/questions/3584805/what-does-the-argument-mean-in-fig-add-subplot111
                                    # Read OJIP curves throughout the datafrmae for the plot
                                    for i in range(len(FMALL.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_3.plot(
                                                    FMALL.iloc[:, 0], # x-axis data: 1st column
                                                    FMALL.iloc[:, i], # y-axis data
                                                    label = FMALL.columns[i], # Column names for legend
                                                    linewidth=1,
                                                    color=colors[i-1]
                                                    )
                                    # Decorate fig 1
                                    fig_3.set_title("Maximum fluorescence, F$_{m}$'") 
                                    fig_3.grid() # use: which='both' for minor grid
                                    fig_3.set_xlabel('Light intensity (µmol photons m$^{-2}$ s$^{-1}$)')
                                    fig_3.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02)) 
                                    for i in range(len(FMALL.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_3.scatter(
                                                    FMALL.iloc[:, 0], # x-axis data: 1st column
                                                    FMALL.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    ########## Sub-plot QY ##########
                                    fig_4 = fig.add_subplot(3, 4, 9) 
                                    # Read QY throughout the datafrmae for the plot
                                    for i in range(len(QYALL.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_4.plot(
                                                    QYALL.iloc[:, 0], # x-axis data: 1st column
                                                    QYALL.iloc[:, i], # y-axis data
                                                    linewidth=1,
                                                    color=colors[i-1]
                                                    )
                                                fig_4.scatter(
                                                    QYALL.iloc[:, 0], # x-axis data: 1st column
                                                    QYALL.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    # Decorate fig
                                    fig_4.set_title("Quantum Yield, Qy") 
                                    fig_4.grid() # use: which='both' for minor grid
                                    fig_4.set_xlabel('Light intensity (µmol photons m$^{-2}$ s$^{-1}$)') 
                                    fig_4.set_ylabel('r.u.') 
                                    ########## Sub-plot ETR ##########
                                    fig_5 = fig.add_subplot(3, 4, 10) 
                                    # Read ETR throughout the datafrmae for the plot
                                    for i in range(len(ETRALL.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_5.scatter(
                                                    ETRALL.iloc[:, 0], # x-axis data: 1st column
                                                    ETRALL.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                                fig_5.plot(
                                                    FITALL.iloc[:,0], # x-axis data
                                                    FITALL.iloc[:,i], # y-axis data
                                                    linestyle='dashdot',
                                                    linewidth=2,
                                                    color=colors[i-1]
                                                    ) 
                                    # Decorate fig  
                                    fig_5.set_title("Electron Transport Rate, rETR \n + Curve fit for parameters calculation") 
                                    fig_5.grid() # use: which='both' for minor grid
                                    fig_5.set_xlabel('Light intensity (µmol photons m$^{-2}$ s$^{-1}$)') 
                                    fig_5.set_ylabel('µmol e$^{-}$ m$^{-2}$ s$^{-1}$') 
                                    ########## Sub-plot qP ##########
                                    fig_7 = fig.add_subplot(3, 4, 5) 
                                    # Read NPQ throughout the datafrmae for the plot
                                    for i in range(len(QP.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_7.scatter(
                                                    QP.iloc[:, 0], # x-axis data: 1st column
                                                    QP.iloc[:, i], # y-axis data
                                                    linewidth=1,
                                                    color=colors[i-1]
                                                    )
                                                fig_7.plot(
                                                    QP.iloc[:, 0], # x-axis data: 1st column
                                                    QP.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    # Decorate fig
                                    fig_7.set_title("qP") 
                                    fig_7.grid() # use: which='both' for minor grid
                                    fig_7.set_xlabel('Light intensity (µmol photons m$^{-2}$ s$^{-1}$)') 
                                    fig_7.set_ylabel('r.u.') 
                                    ########## Sub-plot NPQ 2 ##########
                                    fig_6 = fig.add_subplot(3, 4, 6) 
                                    # Read NPQ throughout the datafrmae for the plot
                                    for i in range(len(NPQALLFMM.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_6.scatter(
                                                    NPQALLFMM.iloc[:, 0], # x-axis data: 1st column
                                                    NPQALLFMM.iloc[:, i], # y-axis data
                                                    linewidth=1,
                                                    color=colors[i-1]
                                                    )
                                                fig_6.plot(
                                                    NPQALLFMM.iloc[:, 0], # x-axis data: 1st column
                                                    NPQALLFMM.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    # Decorate fig
                                    fig_6.set_title("Non-photochemical quneching, NPQ ") 
                                    fig_6.grid() # use: which='both' for minor grid
                                    fig_6.set_xlabel('Light intensity (µmol photons m$^{-2}$ s$^{-1}$)') 
                                    ########## Sub-plot qN ##########
                                    fig_8 = fig.add_subplot(3, 4, 7) 
                                    # Read NPQ throughout the datafrmae for the plot
                                    for i in range(len(QN.columns)):
                                        # do not plot time axis
                                            if i > 0:
                                                fig_8.scatter(
                                                    QN.iloc[:, 0], # x-axis data: 1st column
                                                    QN.iloc[:, i], # y-axis data
                                                    linewidth=1,
                                                    color=colors[i-1]
                                                    )
                                                fig_8.plot(
                                                    QN.iloc[:, 0], # x-axis data: 1st column
                                                    QN.iloc[:, i], # y-axis data
                                                    color=colors[i-1]
                                                    )
                                    # Decorate fig
                                    fig_8.set_title("Non-photochemical quneching, qN ") 
                                    fig_8.grid() # use: which='both' for minor grid
                                    fig_8.set_xlabel('Light intensity (µmol photons m$^{-2}$ s$^{-1}$)') 
                                    # saving scatter plot to memory
                                    memory_for_plot = io.BytesIO()
                                    plt.savefig(memory_for_plot, bbox_inches='tight', format='JPEG')
                                    plot_in_memory = base64.b64encode(memory_for_plot.getvalue())
                                    plot_from_memory = plot_in_memory.decode('ascii')
                                    # Clearing the plot
                                    plt.clf()
                                    plt.cla()
                                    plt.close()
                                    #######################
                                    ### Plot parameters ###
                                    #######################
                                    # Initialise the subplot function using number of rows and columns 
                                    fig = plt.figure(figsize=(20,12)) 
                                    fig.tight_layout() # Shrink to fit the canvas together with legend   
                                    # Sub-plot ALPHA 
                                    fig_1 = fig.add_subplot(3, 4, 1)                  
                                    ALPHA.plot.bar(xticks=[], color=colors)
                                    fig_1.set_title("α")
                                    fig_1.set_ylabel('e$^{-}$ photons$^{-1}$') 
                                    # Sub-plot BETA 
                                    fig_2 = fig.add_subplot(3, 4, 2)                  
                                    BETA.plot.bar(xticks=[], color=colors)
                                    fig_2.set_title("β")
                                    # Sub-plot ETRm MAX
                                    fig_3 = fig.add_subplot(3, 4, 3)    
                                    ETRmax_list = pd.DataFrame([ETRMAX])# FM to df, needed for legend
                                    for i in range(len(ETRmax_list.columns)):
                                        # do not plot time axis
                                        plt.bar(
                                            ETRmax_list.columns[i], # x-axis data
                                            ETRmax_list.iloc[:, i], # y-axis data
                                            label = ETRmax_list.columns[i], # Column names for legend
                                            color=colors[i],
                                            width = 0.5 # width of the columns
                                            )     
                                    fig_3.margins(x=0.5**len(ETRmax_list.columns)) # space between the axes and the first and last bar
                                    fig_3.set_xticks([]) # no X-axis values
                                    fig_3.legend(loc='upper left', bbox_to_anchor=(1.1, 1.02)) # legend    
                                    fig_3.set_title("ETR$_{max}$")
                                    fig_3.set_ylabel('µmol e$^{-}$ m$^{-2}$ s$^{-1}$')  
                                    # Sub-plot 
                                    fig_4 = fig.add_subplot(3, 4, 5)                  
                                    IK.plot.bar(xticks=[], color=colors)
                                    fig_4.set_title("I$_{k}$")
                                    fig_4.set_ylabel('µmol photons m$^{-2}$ s$^{-1}$') 
                                    # Sub-plot 
                                    fig_5 = fig.add_subplot(3, 4, 6)                  
                                    IB.plot.bar(xticks=[], color=colors)
                                    fig_5.set_title("I$_{b}$")
                                    # Sub-plot 
                                    fig_6 = fig.add_subplot(3, 4, 7)                  
                                    ETRMPOT.plot.bar(xticks=[], color=colors)
                                    fig_6.set_title("ETR$_{mPot}$")
                                    fig_6.set_ylabel('µmol e$^{-}$ m$^{-2}$ s$^{-1}$') 
                                    # saving scatter plot to memory
                                    memory_for_parameters = io.BytesIO()
                                    plt.savefig(memory_for_parameters, bbox_inches='tight', format='JPEG')
                                    parameters_in_memory = base64.b64encode(memory_for_parameters.getvalue())
                                    parameters_from_memory = parameters_in_memory.decode('ascii')
                                    # Clearing the plot
                                    plt.clf()
                                    plt.cla()
                                    plt.close()            
                                    ######################
                                    ## Export to excel ###
                                    ###################### 
                                    # prepare DF with parameters F02
                                    param_all = pd.concat([param_all, ALPHA], axis = 1)
                                    param_all = pd.concat([param_all, BETA], axis = 1)
                                    param_all = pd.concat([param_all, IK], axis = 1)
                                    param_all = pd.concat([param_all, IB], axis = 1)
                                    param_all = pd.concat([param_all, ETRMAX_FROM_ALPHA_BETA], axis = 1)
                                    param_all = pd.concat([param_all, ETRMPOT], axis = 1)
                                    # Set file names as index
                                    file_names_list = pd.Series(ETRMAX.index.values) #get file names
                                    param_all.set_index(file_names_list, inplace=True)
                                    # name columns
                                    param_all.columns = ['Aplha', 'Beta', 'Ik', 'Ib', 'ETR max', 'ETRmPot'] 
                                    # write all parameters to excel
                                    writer = pd.ExcelWriter(f'{upload_folder}/{file_name_without_extension}_results.xlsx', engine='openpyxl')
                                    param_all.to_excel(writer, sheet_name = 'Parameters', index=True)
                                    ETRALL.to_excel(writer, sheet_name = 'ETR', index=False)
                                    FITALL.to_excel(writer, sheet_name = 'ETR_fit', index=False)
                                    FTALL.to_excel(writer, sheet_name = 'Ft', index=False)
                                    FMALL.to_excel(writer, sheet_name = 'Fm', index=False)
                                    QP.to_excel(writer, sheet_name = 'qP', index=False)
                                    QN.to_excel(writer, sheet_name = 'qN', index=False)
                                    NPQALLFMM.to_excel(writer, sheet_name = 'NPQ', index=False)
                                    QYALL.to_excel(writer, sheet_name = 'Qy', index=False)
                                    Summary_file.to_excel(writer, sheet_name = 'Raw fluorescence data', index=False)
                                    writer.close()
                                    # Save images
                                    wb = openpyxl.load_workbook(f'{upload_folder}/{file_name_without_extension}_results.xlsx')
                                    wb.create_sheet(title='Images')
                                    wb.move_sheet('Images', -(len(wb.sheetnames)-1))
                                    ws = wb['Images']
                                    img_data_raw = Image(memory_for_plot)
                                    img_parameters = Image(memory_for_parameters)
                                    img_data_raw.anchor = 'A1'
                                    img_parameters.anchor = 'A54'
                                    ws.add_image(img_parameters)
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
                                flash('There seems to be a problem with the uploaded data. Please revise the uploaded files.', category='error')  
                    else:
                        flash('Please select correct file types for analysis (.txt files for AquaPen / FluorPen).', category='error')    
                else:
                    flash(f'Please select up to {max_number_of_files} files.', category='error')                
        else:
            flash('Please select .txt (AquaPen / FluorPen) files.', category='error')
        return render_template("light_curves_analysis.html",
                        raw_data_from_memory = raw_data_from_memory,
                        plot_from_memory = plot_from_memory,
                        parameters_from_memory = parameters_from_memory,
                        xlsx_file_path = xlsx_file_path
                            )
    
    return render_template("light_curves_analysis.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")
    