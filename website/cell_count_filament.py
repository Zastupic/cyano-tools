from flask import Blueprint, render_template, request, flash, redirect
from PIL import Image as im
import os, cv2, base64, io
import numpy as np
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
#from flask_login import current_user

cell_count_filament = Blueprint('cell_count_filament', __name__)

@cell_count_filament.route('/cell_count_filament', methods=['GET', 'POST'])
def count_filament_cells():
#    if current_user.is_authenticated:
    if request.method == "POST":               
        if request.form.get('pixel_size') == '':
            flash('Please enter pixel size', category='error')
        else:
            pixel_size_nm = float(str(request.form.get('pixel_size')))
            depth_um = int(str(request.form.get("chamber_depth_range")))
            minimal_expected_size = float(request.form["minimal_diameter_range"]) # Get smallest cell size (in um)
#                  manually_identified_cells = int(request.form.get('manually_identified_cells'))
            minimum_area = 3.141592653*((minimal_expected_size * 1000 / pixel_size_nm)/2)**2 # Defines area of the smallest cell (in pixels)
            min_diameter_px = minimal_expected_size / (pixel_size_nm/1000)
            scaling_factor_distance_transform = 5
            scaling_factor_threshold = 0.00
            factor_multiplying = float(request.form["factor_1_multiplication_range"]) 
            factor_distance_centers = int(request.form["factor_2_distance_range"]) 
            number_of_iterations = int(request.form["iterations_range"])
            contours_watershed_temp = list()
            ####################################
            ### Load image for cell counting ###
            ####################################
            if 'image' in request.files:
                image = (request.files['image'])
                image_name = str.lower(os.path.splitext(str(image.filename))[0])
                image_extension = str.lower(os.path.splitext(str(image.filename))[1])
                if image_extension in ALLOWED_EXTENSIONS:
                    #user_id = current_user.get_id()
                    upload_folder = UPLOAD_FOLDER
                    if os.path.isdir(upload_folder) == False:
                        os.mkdir(upload_folder)
                    filename = secure_filename(str(image.filename))
                    # saving original image
                    image.save(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))
                    filename2 = f'original_{filename}'
                    img_orig = cv2.imread(f'{upload_folder}/{filename2}')
                    y_pixels_img_orig, x_pixels_img_orig, channels = img_orig.shape
                    if y_pixels_img_orig*x_pixels_img_orig < 15e6:  
                        img_blur = cv2.blur(img_orig, (3,3)) # Noise reduction before application of threshold 
                        img_grey = cv2.cvtColor(img_blur, cv2.COLOR_BGR2GRAY) # Converting image to gray 
                        # Get threshold selection from select box on webpage
                        threshold = (request.form.get('threshold_filter'))
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
                        if threshold == 'Binary + Otsu':
                            img_th = img_th
                        elif threshold == 'To zero + Triangle':
                            img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                        elif threshold == 'Triangle + Binary':
                            img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY)[1]
                        elif threshold == 'Binary':
                            img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_BINARY)[1]
                        elif threshold == 'To zero':
                            img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO)[1]
                        elif threshold == 'Triangle':
                            img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TRIANGLE)[1]
                        elif threshold == 'Otsu':
                            img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_OTSU)[1]
                        # Preparing images for further processing
                        img_for_counted_cells = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                        img_for_counted_cells = cv2.cvtColor(img_for_counted_cells, cv2.COLOR_GRAY2BGR)
                        img_for_counted_cells_copy = img_for_counted_cells.copy()
                        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3,3)) # Define kernel for contour finding
                        img_noise_reduced = cv2.morphologyEx(img_th,cv2.MORPH_OPEN,kernel, iterations = 3) # noise removal (erosion followed by dilation)
                        img_background = cv2.dilate(img_noise_reduced,kernel,iterations=2) # Finding background area: dilate = make cell areas thicker (opposite of erosion)
                        #########################################################################################################
                        # iteration 1: reference contours (basic, most objects identified but individual cells not separated well)
                        #########################################################################################################
                        # Finding foreground area
                        img_distance_transformed = cv2.distanceTransform(img_noise_reduced,cv2.DIST_L2,scaling_factor_distance_transform) # Distance_transform: = the more pixels in continuous area, the higher value, cv2.DIST_L2: simple euclidean distnce
                        img_foreground = cv2.threshold(img_distance_transformed,scaling_factor_threshold*img_distance_transformed.max(),255,0)[1] # thresholdling necessary to identify foreground based on scaling factor (user-defined)
                        img_foreground = np.uint8(img_foreground) # finding neither background nor foreground. np.uint8: necessary for subtracting 
                        img_subtracted_fg_from_bg = cv2.subtract(img_background, img_foreground)
                        _, central_parts_of_cells = cv2.connectedComponents(img_foreground) # connectedComponents: connects all identified foreground components into a overall array
                        central_parts_of_cells = central_parts_of_cells + 1 # Add one to all labels so that background is not 0, but 1
                        central_parts_of_cells[img_subtracted_fg_from_bg==255] = 0  # Mark the region of neither background nor foreground with zero
                        img_watershed = cv2.watershed(img_for_counted_cells_copy, central_parts_of_cells) # apply watershed: separate the connected areas
                        img_watershed = cv2.normalize(img_watershed, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U) # noramalize watershed    
                        _, thresh = cv2.threshold(img_watershed, 150, 255, cv2.THRESH_TRIANGLE+cv2.THRESH_BINARY_INV) # threshold watershed    
                        contours_watershed_th_reference = cv2.findContours(thresh, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE) # find contours of watershed
                        contours_watershed_last = contours_watershed_th_reference # asigning value to temporal parameter
                        ###############################################################################################################################################################
                        # iterations 2-n: identification of individual cells in filaments (step-wise increase of scaling_factor_threshold) - all enclosing circles on top of each other
                        ###############################################################################################################################################################
                        for i in range (number_of_iterations):
                            circles_all_old = []
                            circles_all_actual = []
                            circles_to_remain_old = []
                            circles_to_remain_old_temp = []
                            circles_to_remain_actual = []
                            circles_to_remain_actual_temp = []
                            circles_to_be_deleted_old = []
                            circles_to_be_deleted_actual = []
                            circles_to_be_deleted_actual_temp = []
                            # defining step for the iterations
                            scaling_factor_threshold = scaling_factor_threshold+0.1
                            img_distance_transformed = cv2.distanceTransform(img_noise_reduced,cv2.DIST_L2,scaling_factor_distance_transform) # Finding foreground area
                            img_foreground = cv2.threshold(img_distance_transformed,scaling_factor_threshold*img_distance_transformed.max(),255,0)[1]
                            img_foreground = np.uint8(img_foreground) # finding neither background nor foreground. np.uint8: necessary for subtracting
                            img_subtracted_fg_from_bg = cv2.subtract(img_background, img_foreground)
                            _, central_parts_of_cells = cv2.connectedComponents(img_foreground) # connectedComponents: connects all identified foreground components into a overall array
                            central_parts_of_cells = central_parts_of_cells + 1 # Add one to all labels so that background is not 0, but 1
                            central_parts_of_cells[img_subtracted_fg_from_bg==255] = 0 # Mark the region of neither background nor foreground with zero
                            img_watershed = cv2.watershed(img_for_counted_cells_copy, central_parts_of_cells) # apply watershed: separate the connected areas
                            img_watershed = cv2.normalize(img_watershed, None, alpha=0, beta=255, norm_type=cv2.NORM_MINMAX, dtype=cv2.CV_8U) # noramalize watershed    
                            _, thresh = cv2.threshold(img_watershed, 150, 255, cv2.THRESH_TRIANGLE+cv2.THRESH_BINARY_INV) # threshold watershed 
                            contours_watershed_th = cv2.findContours(thresh, cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE) # find contours of watershed
                            contours_watershed_th_sorted = sorted(contours_watershed_th[0], key=cv2.contourArea) # sort contours 
                            contours_watershed_th_sorted = contours_watershed_th_sorted[:-1] # remove last contour that takes the whole image as a contour
                            # extact list of contours from contours tuple 
                            contours_watershed_th_temp = list(contours_watershed_th)
                            contours_watershed_th_temp[0] = contours_watershed_th_sorted
                            contours_watershed_th = tuple(contours_watershed_th_temp)
                            img_for_counted_cells = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                            img_for_counted_cells = cv2.cvtColor(img_for_counted_cells, cv2.COLOR_GRAY2BGR)
                            for i in range(len(contours_watershed_th[0])):
                                contour = contours_watershed_th[0][i]
                                ((x, y), r) = cv2.minEnclosingCircle(contour)
                                if r > min_diameter_px:
                                    x_coord_actual_circle = int(x)
                                    y_coord_actual_circle = int(y)
                                    radius_actual_circle = int(r)
                                    circles_all_actual.append(int(i))
                                    for a in range(len(contours_watershed_last[0])):
                                        contour = contours_watershed_last[0][a]
                                        ((c, d), e) = cv2.minEnclosingCircle(contour)
                                        x_coord_circle_last = int(c)
                                        y_coord_circle_last = int(d)
                                        radius_circle_last = int(e)
                                        circles_all_old.append(int(a))
                                        distance_centers = np.sqrt((x_coord_actual_circle - x_coord_circle_last)**2 + (y_coord_actual_circle - y_coord_circle_last)**2)
                                        # if the new circle lies within the old circle (slightly increased) 
                                        if factor_multiplying * radius_circle_last > (distance_centers + radius_actual_circle):
                                            circles_to_be_deleted_old.append(int(a))
                                            circles_to_remain_actual_temp.append(int(i))
                                        elif factor_multiplying * radius_actual_circle >= (distance_centers + radius_circle_last) and distance_centers < radius_circle_last:
                                            circles_to_be_deleted_actual.append(int(i))
                                            circles_to_remain_old_temp.append(int(a))
                                        elif distance_centers < factor_distance_centers:
                                            circles_to_be_deleted_old.append(int(i))
                            # keep only a single copy of each value
                            circles_to_be_deleted_old = [*set(circles_to_be_deleted_old)]
                            circles_to_be_deleted_actual = [*set(circles_to_be_deleted_actual)]
                            circles_to_remain_old = [*set(circles_to_remain_old)]
                            circles_to_remain_old_temp =  [*set(circles_to_remain_old_temp)]
                            circles_to_remain_actual = [*set(circles_to_remain_actual)]
                            circles_to_remain_actual_temp = [*set(circles_to_remain_actual_temp)]
                            circles_all_old = [*set(circles_all_old)]
                            circles_all_actual = [*set(circles_all_actual)]
                            # subtract circles to be deleted
                            circles_to_remain_old = [x for x in circles_all_old if x not in circles_to_be_deleted_old]
                            circles_to_remain_old = circles_to_remain_old + circles_to_remain_old_temp
                            circles_to_remain_actual = [x for x in circles_to_remain_actual if x not in circles_to_be_deleted_actual]
                            circles_to_remain_actual = circles_to_remain_actual_temp + circles_to_remain_actual
                            contours_watershed_temp = list(contours_watershed_th)
                            contours_watershed_temp[0] = []
                            contours_watershed_temp = tuple(contours_watershed_temp)
                            for i in range(len(circles_to_remain_old)):
                                contours_watershed_temp[0].append(contours_watershed_last[0][circles_to_remain_old[i]]) 
                            for i in range(len(circles_to_remain_actual)):
                                contours_watershed_temp[0].append(contours_watershed_th[0][i]) 
                            contours_watershed_last = contours_watershed_temp
                        #############################################
                        # drawing and marking of all identified cells
                        #############################################         
                        # draw circles to the final image based on the final circles tuple
                        for i in range(len(contours_watershed_temp[0])):
                            contour = contours_watershed_temp[0][i]
                            ((x, y), r) = cv2.minEnclosingCircle(contour)
                            x_coord_actual_circle = int(x)
                            y_coord_actual_circle = int(y)
                            radius_actual_circle = int(r)    
                            cv2.putText(img_for_counted_cells_copy, str(i+1),(int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0),  1)
                            cv2.circle(img_for_counted_cells_copy,(int(x),int(y)), int(r), (255,255,0),1)
                        # preapring images for showing on the webiste  
                        img_original = im.fromarray(img_orig)
                        img_th_to_show = im.fromarray(img_th)
                        img_counted = im.fromarray(img_for_counted_cells_copy)
                        ##############################################
                        ### 4. Calculate cell number per ml sample ###
                        ##############################################
                        y_pixels, x_pixels, channels = img_for_counted_cells_copy.shape
                        # Calculate image area
                        x_nm = x_pixels * pixel_size_nm
                        y_nm = y_pixels * pixel_size_nm
                        img_area_mm2 = round(((x_nm / 1e6) * (y_nm / 1e6)), 3)
                        # Calculate volume of sample
                        img_volume_nl = round((x_nm * y_nm * (depth_um * 1000) / 1e15), 3) # 1 nanoliter = 1 × 10^15 cubic nanometer 
                        img_volume_ml = img_volume_nl / 1e6 
                        cell_count = len(contours_watershed_last[0]) 
                        if img_volume_nl > 1:
                            # Calculate number of cells per ml
                            cells_per_ml = cell_count / img_volume_ml
                            million_cells_per_mL = round(cells_per_ml / 1e6, 3)
                            # Mark the cell concentration to the image
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Cell count: '+str(cells_per_ml)+'x10^6 cells/mL', (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Identified cells: '+str(cell_count), (10, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Additionally identified cells (manual correction): '+str(manually_identified_cells), (10, 150), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Image resolution: '+str(x_pixels)+' x '+str(y_pixels), (10, 200), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Image area: '+str(img_area_mm2)+' mm^2', (10, 250), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Volume of the imaged area: '+str(img_volume_nl)+' nL', (10, 300), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Pixel size: '+str(pixel_size_nm)+' nm', (10, 350), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Depth of the chamber: '+str(depth_nm)+' nm', (10, 400), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = cv2.putText(img_for_counted_cells_copy, 'Threshold used: '+str(threshold), (10, 450), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 2)
#                                  img_for_download = im.fromarray(img_for_download)
                            #saving images to memory
                            memory_for_original_image = io.BytesIO()
                            memory_for_threshold_image = io.BytesIO()
                            memory_for_counted_image = io.BytesIO()
                            memory_for_image_to_download = io.BytesIO()
                            img_original.save(memory_for_original_image, "JPEG")
                            img_orig_encoded_in_memory = base64.b64encode(memory_for_original_image.getvalue())
                            img_orig_decoded_from_memory = img_orig_encoded_in_memory.decode('utf-8')
                            img_counted.save(memory_for_counted_image, "JPEG")
                            img_counted_encoded_in_memory = base64.b64encode(memory_for_counted_image.getvalue())
                            img_counted_decoded_from_memory = img_counted_encoded_in_memory.decode('utf-8')
                            img_th_to_show.save(memory_for_threshold_image, "JPEG")
                            img_th_encoded_in_memory = base64.b64encode(memory_for_threshold_image.getvalue())
                            img_th_decoded_from_memory = img_th_encoded_in_memory.decode('utf-8')
#                                  img_for_download.save(memory_for_image_to_download, "JPEG")
                            img_for_download_encoded_in_memory = base64.b64encode(memory_for_image_to_download.getvalue())
                            img_for_download_decoded_from_memory = img_for_download_encoded_in_memory.decode('utf-8')
                            # deleting original image
                            os.remove(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))
                            return render_template("cell_count_filament.html", 
                                #user_id = user_id,
                                img_orig_decoded_from_memory = img_orig_decoded_from_memory, 
                                img_th_decoded_from_memory = img_th_decoded_from_memory,
                                img_counted_decoded_from_memory = img_counted_decoded_from_memory,
                                img_for_download_decoded_from_memory = img_for_download_decoded_from_memory,
                                img_for_download = f'{image_name}_counted{image_extension}',
                                cell_count = cell_count,
                                cells_per_ml = cells_per_ml,
                                million_cells_per_mL = million_cells_per_mL,
                                x_pixels = x_pixels,
                                y_pixels = y_pixels,
                                img_area_mm2 = img_area_mm2,
                                img_volume_nl = img_volume_nl,
                                img_volume_ml = img_volume_ml,
                                x_um = int(x_nm / 1e3),
                                y_um = int(y_nm / 1e3),
                                pixel_size_nm = pixel_size_nm,
                                depth_um = depth_um,
                                minimal_expected_size = minimal_expected_size,
#                                                 manually_identified_cells = manually_identified_cells,
                                threshold = threshold,
                                )
                        else:
                            million_cells_per_ml = '0.00'
                            flash('Pixel size is too low', category='error')
                    else:
                        flash(f"Please upload image of smaller resolution. Your image resolution is {y_pixels_img_orig} x {x_pixels_img_orig} px", category='error')        
                    return render_template("cell_count_filament.html")
                else:
                    flash('Please select an image file.', category='error')
    return render_template("cell_count_filament.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")









