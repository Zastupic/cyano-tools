from flask import Blueprint, render_template, request, flash, redirect, session, json
from PIL import Image as im
import os, cv2, base64, io, time
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from skimage.measure import profile_line 
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
#from flask_login import current_user

pixel_profiles_filament = Blueprint('pixel_profiles_filament', __name__)

@pixel_profiles_filament.route('/pixel_profiles_filament', methods=['GET', 'POST'])
def get_pixel_profiles():
#    if current_user.is_authenticated:
    if request.method == "POST":
        line_width = int(str(request.form.get('line_width')))               
        ##################
        ### Load image ###
        ##################
        # check if image is an image
        if "image" in request.files:
            # get list of files
            files = request.files.getlist("image")
            # check if at least one image was uploaded
            if secure_filename(str(files[0].filename)) == '':
                flash('Please select 1-4 image files.', category='error') 
            else:
                # define golbal variables
                image_name_1 = image_name_2 = image_name_3 = image_name_4 = ''
                pixel_profiles_1 = pixel_profiles_2 = pixel_profiles_3 = pixel_profiles_4 = pd.DataFrame()
                pixel_profiles_1_temp = pixel_profiles_2_temp = pixel_profiles_3_temp = pixel_profiles_4_temp = pd.DataFrame()
                pixel_profiles_dif_1_2_temp = pixel_profiles_dif_1_3_temp = pixel_profiles_dif_1_4_temp = pixel_profiles_dif_2_3_temp = pixel_profiles_dif_2_4_temp = pixel_profiles_dif_3_4_temp = pd.DataFrame()
                pixel_profiles_dif_1_2 = pixel_profiles_dif_1_3 = pixel_profiles_dif_1_4 = pixel_profiles_dif_2_3 = pixel_profiles_dif_2_4 = pixel_profiles_dif_3_4 = pd.DataFrame()
                img_final_1 = img_final_2 = img_final_3 = img_final_4 = img_orig_1 = ()
                scatter_plot_1 = scatter_plot_2 = scatter_plot_3 = scatter_plot_4 = ()
                diff_plot_1_2 = diff_plot_1_3 = diff_plot_2_3 = diff_plot_1_4 = diff_plot_2_4 = diff_plot_3_4 = ()
                Final_profiles = []
                image_name_without_extension = image_name_full = coordinates_all_from_session = xlsx_file_path = str('')
                y_pixels = x_pixels = int()
                upload_folder = UPLOAD_FOLDER
                dictionary_arrays_all_results = {
                    'image_name_1': image_name_1,
                    'image_name_2': image_name_2,
                    'image_name_3': image_name_3,
                    'image_name_4': image_name_4,
                    'pixel_profiles_1': pixel_profiles_1,
                    'pixel_profiles_2': pixel_profiles_2,
                    'pixel_profiles_3': pixel_profiles_3,
                    'pixel_profiles_4': pixel_profiles_4,
                    'img_orig_1': img_orig_1,
                    'img_final_1': img_final_1,
                    'img_final_2': img_final_2,
                    'img_final_3': img_final_3,
                    'img_final_4': img_final_4,
                    'scatter_plot_1': scatter_plot_1,
                    'scatter_plot_2': scatter_plot_2,
                    'scatter_plot_3': scatter_plot_3,
                    'scatter_plot_4': scatter_plot_4,
                    'diff_plot_1_2': diff_plot_1_2,
                    'diff_plot_1_3': diff_plot_1_3,
                    'diff_plot_2_3': diff_plot_2_3,
                    'diff_plot_1_4': diff_plot_1_4,
                    'diff_plot_2_4': diff_plot_2_4,
                    'diff_plot_3_4': diff_plot_3_4}
                # check if max 4 images are selected
                if len(files) <= 4:
                    image_number = 0
                    # do for each image
                    for image in files:
                        # Start from number one instead of zero
                        image_number = image_number + 1
                        # empty final profiles
                        Final_profiles = []
                        # get image names
                        image_name_without_extension = str.lower(os.path.splitext(str(image.filename))[0]) # for single image: image = (request.files['image']) 
                        image_extension = str.lower(os.path.splitext(str(image.filename))[1])
                        image_name_full = secure_filename(str(image.filename))
                        image_name_full_copy = f'original_{image_name_full}'
                        # save image name to variable for HTML
                        dictionary_arrays_all_results['image_name_{0}'.format(image_number)] = image_name_full
                        # check if only an image was selected
                        if image_extension in ALLOWED_EXTENSIONS:
                            # create upload directory, if there is not any
                            if os.path.isdir(upload_folder) == False:
                                os.mkdir(upload_folder)
                            # saving original image
                            image.save(os.path.join(upload_folder, image_name_full_copy).replace("\\","/"))
                            img_orig = cv2.imread(f'{upload_folder}/{image_name_full_copy}')
                            img_orig_copy = img_orig.copy()
                            # resolution of original image (in pixels)
                            y_pixels, x_pixels, channels = img_orig.shape
                            #create empty variables
                            Pixel_profiles_df_final = Pixel_profiles_df = Pixel_profiles = pd.DataFrame()
                            plt.scatter([], [])
                            plt.savefig(f'{upload_folder}/{image_name_without_extension}_plot.jpeg')
                            #################################################
                            ### GET COORDINATES FROM JS (through session) ###
                            #################################################                 
                            if 'coordinates_all_in_session' in session:    
                                coordinates_all_from_session = session.get('coordinates_all_in_session', None)          
                                #convert coordinates to list
                                coordinates = list(coordinates_all_from_session) # type: ignore
                                #define empty tuple for storing coordinates of the cells
                                selection_coordinates = []
                                # convert coordiates to tuple
                                for i in range(len(coordinates)):
                                    coordinate = coordinates[i]
                                    # coordinates of image from website - can change when window size changes
                                    x_coordinate_img = int(list(coordinate.values())[2])
                                    y_coordinate_img = int(list(coordinate.values())[3])
                                    # coordinates of selection within image
                                    x_coordinate_selection_start = int(list(coordinate.values())[6])
                                    y_coordiante_selection_start = int(list(coordinate.values())[7])
                                    x_coordinate_selection_end = int(list(coordinate.values())[4])
                                    y_coordiante_selection_end = int(list(coordinate.values())[5])
                                    # recalculating coordinates for original image
                                    x_coordinate_for_original_picture_start = int(x_coordinate_selection_start / x_coordinate_img * x_pixels)
                                    y_coordinate_for_original_picture_start = int(y_coordiante_selection_start / y_coordinate_img * y_pixels)
                                    x_coordinate_for_original_picture_end = int(x_coordinate_selection_end / x_coordinate_img * x_pixels)
                                    y_coordinate_for_original_picture_end = int(y_coordiante_selection_end / y_coordinate_img * y_pixels)
                                    coords = tuple([(i),x_coordinate_for_original_picture_start,
                                                    y_coordinate_for_original_picture_start, 
                                                    x_coordinate_for_original_picture_end, 
                                                    y_coordinate_for_original_picture_end
                                                    ])
                                    selection_coordinates.append(coords)
                                ############################################
                                ### Prepare analysis of individual cells ###
                                ############################################
                                # Start analysis of individual cells
                                for i in range(len(selection_coordinates)):
                                    # Define empty lists to store the result for each single cell
                                    Pixel_profiles = []
                                    # Extract number of cell from tuple for first element
                                    cell_number = selection_coordinates[i][0]+1
                                    # Extract coordinates from tuple for elements
                                    x_rough_start = selection_coordinates[i][1]
                                    y_rough_start = selection_coordinates[i][2]
                                    x_rough_end = selection_coordinates[i][3]
                                    y_rough_end = selection_coordinates[i][4]
                                    # define coordinates of profile line
                                    start = (y_rough_start, x_rough_start)
                                    end = (y_rough_end, x_rough_end)
                                    profile = profile_line(img_orig, start, end, linewidth=line_width, order=1) # type: ignore
                                    for i in range(profile.shape[0]): # type: ignore
                                        pixel_number = i+1
                                        intensities = list((int(cell_number),int(pixel_number),profile[i][0]))  # type: ignore
                                        Pixel_profiles.append(intensities)
                                    Final_profiles.append(Pixel_profiles)
                                    ##############################
                                    ### Draw lines and circles ###
                                    ##############################
                                    # Draw line 1
                                    cv2.line(img_orig_copy, (x_rough_start, y_rough_start), (x_rough_end, y_rough_end), (255, 0, 0), line_width) 
                                    # Draw cell number 
                                    cv2.putText(img_orig_copy, str(cell_number), (int(x_rough_start), int(y_rough_start)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255,255,0), 1)
                                ###########################################################################################
                                ### Saving profile lines to dataframe - for plots, excel and calculation of differences ###
                                ###########################################################################################
                                # Preparing dataframe with pixel profiles                            
                                for i in range(len(Final_profiles)):
                                    # read profile of each cell 
                                    Pixel_profiles_df = pd.DataFrame(Final_profiles[i], columns = [str(str(image_name_without_extension)+': cell no.'),'Pixel number','Intensity_profile_{0}'.format(i+1)])
                                    # read profiles for plot
                                    plt.scatter(
                                        Pixel_profiles_df.iloc[:, 1], # x-axis data: 1st column
                                        Pixel_profiles_df.iloc[:, 2], # y-axis data
                                        s=20, 
                                        facecolors='none',
                                        edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                        )
                                    # remove first column - pixel number
                                    Pixel_profiles_df = Pixel_profiles_df.drop(Pixel_profiles_df.columns[[0, 1]], axis=1)
                                    # append each profile to final data frame
                                    Pixel_profiles_df_final = pd.concat([Pixel_profiles_df_final, Pixel_profiles_df], axis=1)
                                # delete NaN in final dataframe
                                Pixel_profiles_df_final = Pixel_profiles_df_final.replace([np.nan], "")
                                # Preparing df for saving to excel later
                                dictionary_arrays_all_results['pixel_profiles_{0}'.format(image_number)] = Pixel_profiles_df_final
                            #################################
                            ### Preparing and saving plot ###
                            #################################
                            # decorate scatter plot
                            plt.title("Pixel profiles image "+str(image_number)+" (each color represents individual cell)")
                            plt.xlabel("Pixels")
                            plt.ylabel("Pixel intensity (r.u.)")
                            # saving scatter plot to memory
                            memory_for_pixel_profiles_plot = io.BytesIO()
                            plt.savefig(memory_for_pixel_profiles_plot, format='JPEG')
                            pixel_profiles_plot_in_memory = base64.b64encode(memory_for_pixel_profiles_plot.getvalue())
                            pixel_profiles_plot_from_memory = pixel_profiles_plot_in_memory.decode('ascii')
                            # save scatter plot to variable for HTML
                            dictionary_arrays_all_results['scatter_plot_{0}'.format(image_number)] = pixel_profiles_plot_from_memory
                            # Clearing the plot
                            plt.clf()
                            plt.cla()
                            plt.close()
                            ###################################
                            ### Preparing and saving images ###
                            ###################################
                            # preparing images  
                            img_original = im.fromarray(img_orig)
                            img_final = im.fromarray(img_orig_copy)
                            #preparing memory
                            memory_for_original_image = io.BytesIO()
                            memory_for_image_to_download = io.BytesIO()   
                            #saving images to memory
                            img_original.save(memory_for_original_image, "JPEG")
                            img_orig_encoded_in_memory = base64.b64encode(memory_for_original_image.getvalue())
                            img_orig_decoded_from_memory = img_orig_encoded_in_memory.decode('utf-8')
                            # save original image for HTML
                            if image_number == 1:
                                dictionary_arrays_all_results['img_orig_1'] = img_orig_decoded_from_memory
                            img_final.save(memory_for_image_to_download, "JPEG")
                            img_final_encoded_in_memory = base64.b64encode(memory_for_image_to_download.getvalue())
                            img_final_decoded_from_memory = img_final_encoded_in_memory.decode('utf-8')
                            # save image to send to HTML
                            dictionary_arrays_all_results['img_final_{0}'.format(image_number)] = img_final_decoded_from_memory
                            # Clearing the plot
                            plt.clf()
                            plt.cla()
                            plt.close()
                        else:
                            flash('Please select an image file.', category='error'  )  
                    ###############################################################################
                    ### Calculating differences between pigment profiles in individual channels ###
                    ###############################################################################
                    # asssign pixel profiles from individual channels to data frames
                    pixel_profiles_1 = pd.DataFrame.from_dict(dictionary_arrays_all_results['pixel_profiles_1'])
                    pixel_profiles_2 = pd.DataFrame.from_dict(dictionary_arrays_all_results['pixel_profiles_2'])
                    pixel_profiles_3 = pd.DataFrame.from_dict(dictionary_arrays_all_results['pixel_profiles_3'])
                    pixel_profiles_4 = pd.DataFrame.from_dict(dictionary_arrays_all_results['pixel_profiles_4'])
                    # check if some cells were selected
                    if not pixel_profiles_1.empty:
                        # calculate differences
                        for i in range(len(Final_profiles)): 
                            # get intensity n-th cell
                            pixel_profiles_1_temp = pd.to_numeric(pixel_profiles_1.iloc[:, i], errors='coerce')
                            if not pixel_profiles_2.empty:
                                pixel_profiles_2_temp = pd.to_numeric(pixel_profiles_2.iloc[:, i], errors='coerce')
                                if not pixel_profiles_3.empty:
                                    pixel_profiles_3_temp = pd.to_numeric(pixel_profiles_3.iloc[:, i], errors='coerce')
                                    if not pixel_profiles_4.empty:
                                         pixel_profiles_4_temp = pd.to_numeric(pixel_profiles_4.iloc[:, i], errors='coerce')
                            # calculate differences between profiles
                            if not pixel_profiles_2.empty:
                                pixel_profiles_dif_1_2_temp = pixel_profiles_1_temp.sub(pixel_profiles_2_temp) # type: ignore
                                if not pixel_profiles_3.empty:
                                    pixel_profiles_dif_1_3_temp = pixel_profiles_1_temp.sub(pixel_profiles_3_temp) # type: ignore
                                    pixel_profiles_dif_2_3_temp = pixel_profiles_2_temp.sub(pixel_profiles_3_temp) # type: ignore
                                    if not pixel_profiles_4.empty:
                                        pixel_profiles_dif_1_4_temp = pixel_profiles_1_temp.sub(pixel_profiles_4_temp) # type: ignore
                                        pixel_profiles_dif_2_4_temp = pixel_profiles_2_temp.sub(pixel_profiles_4_temp) # type: ignore
                                        pixel_profiles_dif_3_4_temp = pixel_profiles_3_temp.sub(pixel_profiles_4_temp) # type: ignore
                            # save differences to data frames
                            if not pixel_profiles_2.empty:
                                pixel_profiles_dif_1_2 = pd.concat([pixel_profiles_dif_1_2, pixel_profiles_dif_1_2_temp], axis=1) # type: ignore
                                pixel_profiles_dif_1_2 = (pixel_profiles_dif_1_2.replace([np.nan], "0")).astype(int) # delete NaN in final dataframe
                                if not pixel_profiles_3.empty:
                                    pixel_profiles_dif_1_3 = pd.concat([pixel_profiles_dif_1_3, pixel_profiles_dif_1_3_temp], axis=1) # type: ignore
                                    pixel_profiles_dif_2_3 = pd.concat([pixel_profiles_dif_2_3, pixel_profiles_dif_2_3_temp], axis=1) # type: ignore
                                    pixel_profiles_dif_1_3 = (pixel_profiles_dif_1_3.replace([np.nan], "0")).astype(int) # delete NaN in final dataframe
                                    pixel_profiles_dif_2_3 = (pixel_profiles_dif_2_3.replace([np.nan], "0")).astype(int) # delete NaN in final dataframe
                                    if not pixel_profiles_4.empty:
                                        pixel_profiles_dif_1_4 = pd.concat([pixel_profiles_dif_1_4, pixel_profiles_dif_1_4_temp], axis=1) # type: ignore
                                        pixel_profiles_dif_2_4 = pd.concat([pixel_profiles_dif_2_4, pixel_profiles_dif_2_4_temp], axis=1) # type: ignore
                                        pixel_profiles_dif_3_4 = pd.concat([pixel_profiles_dif_3_4, pixel_profiles_dif_3_4_temp], axis=1) # type: ignore
                                        pixel_profiles_dif_1_4 = (pixel_profiles_dif_1_4.replace([np.nan], "0")).astype(int) # delete NaN in final dataframe
                                        pixel_profiles_dif_2_4 = (pixel_profiles_dif_2_4.replace([np.nan], "0")).astype(int) # delete NaN in final dataframe
                                        pixel_profiles_dif_3_4 = (pixel_profiles_dif_3_4.replace([np.nan], "0")).astype(int) # delete NaN in final dataframe
                    #######################################################
                    ### Saving the result into specific sheets in excel ###
                    #######################################################
                    writer = pd.ExcelWriter(f'{upload_folder}/{image_name_without_extension}_results.xlsx', engine='openpyxl')
                    dictionary_arrays_all_results['pixel_profiles_1'].to_excel(writer, sheet_name = 'Pixel_profiles_1')
                    dictionary_arrays_all_results['pixel_profiles_2'].to_excel(writer, sheet_name = 'Pixel_profiles_2')
                    dictionary_arrays_all_results['pixel_profiles_3'].to_excel(writer, sheet_name = 'Pixel_profiles_3')
                    dictionary_arrays_all_results['pixel_profiles_4'].to_excel(writer, sheet_name = 'Pixel_profiles_4')
                    pixel_profiles_dif_1_2.to_excel(writer, sheet_name = 'Delta_profiles_1-2')
                    pixel_profiles_dif_1_3.to_excel(writer, sheet_name = 'Delta_profiles_1-3')
                    pixel_profiles_dif_1_4.to_excel(writer, sheet_name = 'Delta_profiles_1-4')
                    pixel_profiles_dif_2_3.to_excel(writer, sheet_name = 'Delta_profiles_2-3')
                    pixel_profiles_dif_2_4.to_excel(writer, sheet_name = 'Delta_profiles_2-4')
                    pixel_profiles_dif_3_4.to_excel(writer, sheet_name = 'Delta_profiles_3-4')
                    writer.close()
                    xlsx_file_path = f'uploads/{image_name_without_extension}_results.xlsx'
                    #####################################
                    ### Plotting profiles differences ###
                    #####################################
                    ##### Ploting pixel_profiles_dif_1_2 #####
                    if not pixel_profiles_2.empty:
                        pixel_profiles_dif_1_2 = pixel_profiles_dif_1_2.reset_index(drop=False)
                        # Read OJIP curves throughout the datafrmae for the plot
                        for i in range(len(pixel_profiles_dif_1_2.columns)):
                            # do not plot time axis
                                if i > 0:
                                    plt.scatter(
                                        pixel_profiles_dif_1_2.iloc[:, 0], # x-axis data: 1st column
                                        pixel_profiles_dif_1_2.iloc[:, i], # y-axis data
                                        s=20, 
                                        facecolors='none',
                                        edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                        )
                        # decorate scatter plot
                        plt.title("Pixel profiles difference: profile 1 - profile 2") 
                        plt.xlabel("Pixels")
                        plt.ylabel("Pixel intensity (r.u.)")
                        # saving scatter plot to memory
                        memory_for_pixel_profiles_plot = io.BytesIO()
                        plt.savefig(memory_for_pixel_profiles_plot, format='JPEG')
                        pixel_profiles_plot_in_memory = base64.b64encode(memory_for_pixel_profiles_plot.getvalue())
                        pixel_profiles_plot_from_memory = pixel_profiles_plot_in_memory.decode('ascii')
                        # save scatter plot to variable for HTML
                        dictionary_arrays_all_results['diff_plot_1_2'] = pixel_profiles_plot_from_memory
                        # Clearing the plot
                        plt.clf()
                        plt.cla()
                        plt.close()
                        ##### Ploting pixel_profiles_dif_1_3 #####
                        if not pixel_profiles_3.empty:
                            pixel_profiles_dif_1_3 = pixel_profiles_dif_1_3.reset_index(drop=False)
                            # Read OJIP curves throughout the datafrmae for the plot
                            for i in range(len(pixel_profiles_dif_1_3.columns)):
                                # do not plot time axis
                                    if i > 0:
                                        plt.scatter(
                                            pixel_profiles_dif_1_3.iloc[:, 0], # x-axis data: 1st column
                                            pixel_profiles_dif_1_3.iloc[:, i], # y-axis data
                                            s=20, 
                                            facecolors='none',
                                            edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                            )
                            # decorate scatter plot
                            plt.title("Pixel profiles difference: profile 1 - profile 3") 
                            plt.xlabel("Pixels")
                            plt.ylabel("Pixel intensity (r.u.)")
                            # saving scatter plot to memory
                            memory_for_pixel_profiles_plot = io.BytesIO()
                            plt.savefig(memory_for_pixel_profiles_plot, format='JPEG')
                            pixel_profiles_plot_in_memory = base64.b64encode(memory_for_pixel_profiles_plot.getvalue())
                            pixel_profiles_plot_from_memory = pixel_profiles_plot_in_memory.decode('ascii')
                            # save scatter plot to variable for HTML
                            dictionary_arrays_all_results['diff_plot_1_3'] = pixel_profiles_plot_from_memory
                            # Clearing the plot
                            plt.clf()
                            plt.cla()
                            plt.close()
                            ##### Ploting pixel_profiles_dif_2_3 #####
                            pixel_profiles_dif_2_3 = pixel_profiles_dif_2_3.reset_index(drop=False)
                            # Read OJIP curves throughout the datafrmae for the plot
                            for i in range(len(pixel_profiles_dif_2_3.columns)):
                                # do not plot time axis
                                    if i > 0:
                                        plt.scatter(
                                            pixel_profiles_dif_2_3.iloc[:, 0], # x-axis data: 1st column
                                            pixel_profiles_dif_2_3.iloc[:, i], # y-axis data
                                            s=20, 
                                            facecolors='none',
                                            edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                            )
                            # decorate scatter plot
                            plt.title("Pixel profiles difference: profile 2 - profile 3") 
                            plt.xlabel("Pixels")
                            plt.ylabel("Pixel intensity (r.u.)")
                            # saving scatter plot to memory
                            memory_for_pixel_profiles_plot = io.BytesIO()
                            plt.savefig(memory_for_pixel_profiles_plot, format='JPEG')
                            pixel_profiles_plot_in_memory = base64.b64encode(memory_for_pixel_profiles_plot.getvalue())
                            pixel_profiles_plot_from_memory = pixel_profiles_plot_in_memory.decode('ascii')
                            # save scatter plot to variable for HTML
                            dictionary_arrays_all_results['diff_plot_2_3'] = pixel_profiles_plot_from_memory
                            # Clearing the plot
                            plt.clf()
                            plt.cla()
                            plt.close()
                            ##### Ploting pixel_profiles_dif_1_4 #####
                            if not pixel_profiles_4.empty:
                                pixel_profiles_dif_1_4 = pixel_profiles_dif_1_4.reset_index(drop=False)
                                # Read OJIP curves throughout the datafrmae for the plot
                                for i in range(len(pixel_profiles_dif_1_4.columns)):
                                    # do not plot time axis
                                        if i > 0:
                                            plt.scatter(
                                                pixel_profiles_dif_1_4.iloc[:, 0], # x-axis data: 1st column
                                                pixel_profiles_dif_1_4.iloc[:, i], # y-axis data
                                                s=20, 
                                                facecolors='none',
                                                edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                                )
                                # decorate scatter plot
                                plt.title("Pixel profiles difference: profile 1 - profile 4") 
                                plt.xlabel("Pixels")
                                plt.ylabel("Pixel intensity (r.u.)")
                                # saving scatter plot to memory
                                memory_for_pixel_profiles_plot = io.BytesIO()
                                plt.savefig(memory_for_pixel_profiles_plot, format='JPEG')
                                pixel_profiles_plot_in_memory = base64.b64encode(memory_for_pixel_profiles_plot.getvalue())
                                pixel_profiles_plot_from_memory = pixel_profiles_plot_in_memory.decode('ascii')
                                # save scatter plot to variable for HTML
                                dictionary_arrays_all_results['diff_plot_1_4'] = pixel_profiles_plot_from_memory
                                # Clearing the plot
                                plt.clf()
                                plt.cla()
                                plt.close()
                                ##### Ploting pixel_profiles_dif_2_4 #####
                                pixel_profiles_dif_2_4 = pixel_profiles_dif_2_4.reset_index(drop=False)
                                # Read OJIP curves throughout the datafrmae for the plot
                                for i in range(len(pixel_profiles_dif_2_4.columns)):
                                    # do not plot time axis
                                        if i > 0:
                                            plt.scatter(
                                                pixel_profiles_dif_2_4.iloc[:, 0], # x-axis data: 1st column
                                                pixel_profiles_dif_2_4.iloc[:, i], # y-axis data
                                                s=20, 
                                                facecolors='none',
                                                edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                                )
                                # decorate scatter plot
                                plt.title("Pixel profiles difference: profile 2 - profile 4") 
                                plt.xlabel("Pixels")
                                plt.ylabel("Pixel intensity (r.u.)")
                                # saving scatter plot to memory
                                memory_for_pixel_profiles_plot = io.BytesIO()
                                plt.savefig(memory_for_pixel_profiles_plot, format='JPEG')
                                pixel_profiles_plot_in_memory = base64.b64encode(memory_for_pixel_profiles_plot.getvalue())
                                pixel_profiles_plot_from_memory = pixel_profiles_plot_in_memory.decode('ascii')
                                # save scatter plot to variable for HTML
                                dictionary_arrays_all_results['diff_plot_2_4'] = pixel_profiles_plot_from_memory
                                # Clearing the plot
                                plt.clf()
                                plt.cla()
                                plt.close()
                                ##### Ploting pixel_profiles_dif_2_4 #####
                                pixel_profiles_dif_3_4 = pixel_profiles_dif_3_4.reset_index(drop=False)
                                # Read OJIP curves throughout the datafrmae for the plot
                                for i in range(len(pixel_profiles_dif_3_4.columns)):
                                    # do not plot time axis
                                        if i > 0:
                                            plt.scatter(
                                                pixel_profiles_dif_3_4.iloc[:, 0], # x-axis data: 1st column
                                                pixel_profiles_dif_3_4.iloc[:, i], # y-axis data
                                                s=20, 
                                                facecolors='none',
                                                edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                                )
                                # decorate scatter plot
                                plt.title("Pixel profiles difference: profile 3 - profile 4") 
                                plt.xlabel("Pixels")
                                plt.ylabel("Pixel intensity (r.u.)")
                                # saving scatter plot to memory
                                memory_for_pixel_profiles_plot = io.BytesIO()
                                plt.savefig(memory_for_pixel_profiles_plot, format='JPEG')
                                pixel_profiles_plot_in_memory = base64.b64encode(memory_for_pixel_profiles_plot.getvalue())
                                pixel_profiles_plot_from_memory = pixel_profiles_plot_in_memory.decode('ascii')
                                # save scatter plot to variable for HTML
                                dictionary_arrays_all_results['diff_plot_3_4'] = pixel_profiles_plot_from_memory
                                # Clearing the plot
                                plt.clf()
                                plt.cla()
                                plt.close()
                    ################################################
                    # Deleting files + temporary files from server #
                    ################################################
                    # Clear session
                    session.pop('coordinates_all_in_session', None)
                    # deleting uploaded images
                    os.remove(os.path.join(upload_folder, f'original_{image_name_full}').replace("\\","/"))
                    os.remove(os.path.join(f'{upload_folder}/{image_name_without_extension}_plot.jpeg').replace("\\","/"))
                    # Deleting files older than 20 min
                    # List all files
                    list_of_files_in_upload_folder = os.listdir(upload_folder)
                    # get current time
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
                    # clear session
                    session.pop('coordinates_all_in_session', None)
                    ######################
                    # Returning template #
                    ######################
                    return render_template("pixel_profiles_filament.html", 
                        xlsx_file_path = xlsx_file_path,
                        line_width = line_width,
                        img_orig_decoded_from_memory = dictionary_arrays_all_results['img_orig_1'],
                        image_name_1 = dictionary_arrays_all_results['image_name_1'],
                        image_name_2 = dictionary_arrays_all_results['image_name_2'],
                        image_name_3 = dictionary_arrays_all_results['image_name_3'],
                        image_name_4 = dictionary_arrays_all_results['image_name_4'],
                        img_final_1 = dictionary_arrays_all_results['img_final_1'],
                        img_final_2 = dictionary_arrays_all_results['img_final_2'],
                        img_final_3 = dictionary_arrays_all_results['img_final_3'],
                        img_final_4 = dictionary_arrays_all_results['img_final_4'],
                        scatter_plot_1 = dictionary_arrays_all_results['scatter_plot_1'],
                        scatter_plot_2 = dictionary_arrays_all_results['scatter_plot_2'],
                        scatter_plot_3 = dictionary_arrays_all_results['scatter_plot_3'],
                        scatter_plot_4 = dictionary_arrays_all_results['scatter_plot_4'],
                        diff_plot_1_2 = dictionary_arrays_all_results['diff_plot_1_2'],
                        diff_plot_1_3 = dictionary_arrays_all_results['diff_plot_1_3'],
                        diff_plot_2_3 = dictionary_arrays_all_results['diff_plot_2_3'],
                        diff_plot_1_4 = dictionary_arrays_all_results['diff_plot_1_4'],
                        diff_plot_2_4 = dictionary_arrays_all_results['diff_plot_2_4'],
                        diff_plot_3_4 = dictionary_arrays_all_results['diff_plot_3_4'],
                        x_pixels = x_pixels,
                        y_pixels = y_pixels,
                        coordinates_all_from_session = coordinates_all_from_session
                        )
                else:
                    flash('Please select up to 4 files.', category='error')
        else:
            flash('Please select image files (.png, .jpg, .jpeg, .tif, .tiff, .bmp, .gif).', category='error')        
    return render_template("pixel_profiles_filament.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")

# GETTING COORDINATES FROM JS
@pixel_profiles_filament.route('/pixel_profiles/coordinates', methods=['POST'])
def coordinates_from_js():
    coordinates_all_in_session = ''
    coordinates_from_js = request.get_json() # reading the cordinates from JS
    session['coordinates_all_in_session'] = json.loads(coordinates_from_js) #converting the json output to a python dictionary

    if 'coordinates_all_in_session' in session:
        coordinates_all_in_session = session['coordinates_all_in_session']
        
    return render_template("pixel_profiles_filament.html", 
                           coordinates_all_in_session = coordinates_all_in_session
                           )                     