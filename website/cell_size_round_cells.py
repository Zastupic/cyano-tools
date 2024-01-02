from flask import Blueprint, render_template, request, flash, redirect, session, json
from PIL import Image as im
import os, cv2, base64, io, time
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

cell_size_round_cells = Blueprint('cell_size_round_cells', __name__)

@cell_size_round_cells.route('/cell_size_round_cells', methods=['GET', 'POST'])
def analyze_cell_size():
    if current_user.is_authenticated:
        if request.method == "POST":               
            if request.form.get('pixel_size') == '':
                flash('Please enter pixel size', category='error')
            else:
                pixel_size_nm = float(request.form.get('pixel_size'))

                ##################
                ### Load image ###
                ##################
                if 'image' in request.files:
                    image = (request.files['image'])
                    image_name = str.lower(os.path.splitext(image.filename)[0])
                    image_extension = str.lower(os.path.splitext(image.filename)[1])

                    if image_extension in ALLOWED_EXTENSIONS:
                        upload_folder = UPLOAD_FOLDER

                        if os.path.isdir(upload_folder) == False:
                            os.mkdir(upload_folder)

                        filename = secure_filename(image.filename)
                        filename2 = f'original_{filename}'

                        # saving original image
                        image.save(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))
                        img_orig = cv2.imread(f'{upload_folder}/{filename2}')
                        img_orig_copy = img_orig.copy()

                        # resolution of original image (in pixels)
                        y_pixels, x_pixels, channels = img_orig.shape

                        #create empty variables
                        cell_sizes_final = () 
                        xlsx_file_path = str('')
                        coordinates_all_from_session = ''
                        counts = [1]
                        bin_edges = [0]
                        plt.scatter([], [])
                        plt.savefig(f'{upload_folder}/{image_name}_plot.jpeg')

                        #####################################################
                        ### GETTING COORDINATES FROM JS (through session) ###
                        #####################################################                 
                        if 'coordinates_all_in_session' in session:    
                            coordinates_all_from_session = session.get('coordinates_all_in_session', None)          

                            #convert coordinates to list
                            coordinates = list(coordinates_all_from_session)

                            #define empty tuple for storing rough coordinates
                            rough_coordinates = []

                            for i in range(len(coordinates)):
                                coordinate = coordinates[i]

                                # coordinates of image from website - can change when window size changes
                                x_coordinate_img = int(list(coordinate.values())[2])
                                y_coordinate_img = int(list(coordinate.values())[3])

                                # coordinates of selection within image
                                x_coordinate_selection = int(list(coordinate.values())[5])
                                y_coordiante_selection = int(list(coordinate.values())[6])

                                # recalculating coordinates for original image
                                x_coordinate_for_original_picture = int(x_coordinate_selection / x_coordinate_img * x_pixels)
                                y_coordinate_for_original_picture = int(y_coordiante_selection / y_coordinate_img * y_pixels)

                                coords = tuple([(i+1),x_coordinate_for_original_picture,y_coordinate_for_original_picture])
                                rough_coordinates.append(coords)
                            
                            #############################################################
                            ### Creating mask(s) on an image based on cells selection ###
                            #############################################################
                            # radius
                            radius = int(list(coordinate.values())[4])                      

                            # Define empty list to store the results for all cells together
                            cell_sizes_final = []

                            for i in range(len(rough_coordinates)):
                                # Define empty list to store the result for each single cell
                                cell_sizes = []
                                # Extract number of cell from tuple for first element
                                cell_number = rough_coordinates[i][0]
                                # Extract x-coordinate from tuple for first element
                                x_rough = rough_coordinates[i][1]
                                # Extract y-coordinate from tuple for first element
                                y_rough = rough_coordinates[i][2]

                                # Create mask
                                mask = np.zeros(img_orig_copy.shape[:2], dtype="uint8")
                                cv2.circle(mask, (x_rough, y_rough), radius, 255, -1)

                                # Fill mask
                                masked = cv2.bitwise_and(img_orig_copy, img_orig_copy, mask=mask)

                                # Convert image to grayscale - neccessary to detect circles
                                masked_grayscale = cv2.cvtColor(masked, cv2.COLOR_BGR2GRAY)

                                #########################################################################
                                ### Detect cell(s) on mask(s) and find coordinates of exact center(s) ###
                                #########################################################################
                                # Blur the cell using 3 * 3 kernel.
                                img_blured = cv2.medianBlur(masked_grayscale, 5)

                                # Detect circles in the image. Parameters obtained: a: x coordintate of the circle center, b: y coordinate of the circle center, r: radius
                                circle = cv2.HoughCircles(img_blured,cv2.HOUGH_GRADIENT,1,20,param1=50,param2=30,minRadius=30,maxRadius=250)

                                # Draw circles that are detected
                                if circle is not None:
                                    # Convert the circle parameters a, b and r to integers.
                                    circle = np.uint16(np.around(circle))
                                    for pt in circle[0, :]:
                                        a, b, r = pt[0], pt[1], pt[2]

                                    ######################################
                                    ### 5. Detect cell size and radius ###
                                    ######################################
                                    # Extract parameters of detected cell(s) + define coordinates for line
                                    detected_cell_radius = circle[0][0][2] 

                                    # Define incremnt above the cell edge for pixel profle analysis (% of the detected radius)
                                    cell_radius_incremented = int(detected_cell_radius * 1.1)

                                    # calculate cell diameter and other parameters in um
                                    cell_diameter_um = float(cell_radius_incremented*2*pixel_size_nm / 1000)

                                    # Draw cell number 
                                    cv2.putText(img_orig_copy, str(cell_number), (a, b), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (245, 235, 15), 2)
                                    # Draw circle
                                    cv2.circle(img_orig_copy, (a, b), cell_radius_incremented, (0, 255, 0), 2)
                                    # Draw line
                                    cv2.line(img_orig_copy, ((a-cell_radius_incremented), b), ((a+cell_radius_incremented), b), (255, 0, 0), 2)

                                    # Store the results for all cells
                                    cell_sizes_final.append((i, cell_diameter_um)) 

                            ####################################
                            ### Save pixel profiles to excel ###
                            ####################################

                            # Making a dataframe with all results from all cells, as a tranformation of the original list
                            cell_sizes_final_df = pd.DataFrame(cell_sizes_final)

                            # calculating histogram to get the y-axis range
                            counts, bin_edges = np.histogram(cell_sizes_final_df[cell_sizes_final_df.columns[-1]])

                            cell_sizes_final_df.rename(columns = {list(cell_sizes_final_df)[0]:'Cell number'}, inplace=True)
                            cell_sizes_final_df.rename(columns = {list(cell_sizes_final_df)[1]:'Cell diameter (μm)'}, inplace=True)
                            # plotting histogram
                            plt.hist(
                                cell_sizes_final_df[cell_sizes_final_df.columns[-1]]
                                )
                            
                            # Saving the result into excel
                            cell_sizes_final_df = pd.DataFrame(cell_sizes_final_df)
                            cell_sizes_final_df.to_excel(f'{upload_folder}/{image_name}_cell_sizes.xlsx')
                            xlsx_file_path = f'uploads/{image_name}_cell_sizes.xlsx'

                        ###################################################
                        ### Preparing images for showing on the webiste ###
                        ###################################################
                        
                        plt.grid(axis='x', which='both', color='#888888', linestyle='--')
                        plt.title("Cell size distribution") 
                        plt.xlabel("Cell diameter (μm)")
                        plt.ylabel("Count")
                        plt.yticks(np.arange(0,(max(counts)+1),1))

                        # preapring images  
                        img_original = im.fromarray(img_orig)
                        img_for_download = im.fromarray(img_orig_copy)

                        #preparing memory
                        memory_for_original_image = io.BytesIO()
                        memory_for_image_to_download = io.BytesIO()
                        memory_for_final_plot = io.BytesIO()

                        #saving images to memory
                        img_original.save(memory_for_original_image, "JPEG")
                        img_orig_encoded_in_memory = base64.b64encode(memory_for_original_image.getvalue())
                        img_orig_decoded_from_memory = img_orig_encoded_in_memory.decode('utf-8')

                        img_for_download.save(memory_for_image_to_download, "JPEG")
                        img_for_download_encoded_in_memory = base64.b64encode(memory_for_image_to_download.getvalue())
                        img_for_download_decoded_from_memory = img_for_download_encoded_in_memory.decode('utf-8')

                        plt.savefig(memory_for_final_plot, format='JPEG')
                        fina_plot_encoded_in_memory = base64.b64encode(memory_for_final_plot.getvalue())
                        final_plot_decoded_from_memory = fina_plot_encoded_in_memory.decode('ascii')

                        ################################################
                        # Deleting files + temporary files from server #
                        ################################################
                        # Clear session
                        session.pop('coordinates_all_in_session', None)

                        # deleting uploaded images
                        os.remove(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))
                        os.remove(os.path.join(f'{upload_folder}/{image_name}_plot.jpeg').replace("\\","/"))

                        # Clearing the plot
                        plt.clf()
                        plt.cla()
                        plt.close()

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

                        ######################
                        # Returning template #
                        ######################

                        return render_template("cell_size_round_cells.html", 
                            image_name = image_name,
                            xlsx_file_path = xlsx_file_path,
                            img_orig_decoded_from_memory = img_orig_decoded_from_memory,
                            img_for_download_decoded_from_memory = img_for_download_decoded_from_memory,
                            x_pixels = x_pixels,
                            y_pixels = y_pixels,
                            pixel_size_nm = pixel_size_nm,
                            coordinates_all_from_session = coordinates_all_from_session, 
                            final_plot_decoded_from_memory = final_plot_decoded_from_memory,
                            )
                    else:
                        flash('Please select an image file.', category='error')
        return render_template("cell_size_round_cells.html")
    else:
        flash('Please login', category='error')
        return redirect("/login")

# GETTING COORDINATES FROM JS
@cell_size_round_cells.route('/cell_size/coordinates', methods=['POST'])
def coordinates_from_js():
    coordinates_from_js = request.get_json() # reading the cordinates from JS
    session['coordinates_all_in_session'] = json.loads(coordinates_from_js) #converting the json output to a python dictionary

    if 'coordinates_all_in_session' in session:
        coordinates_all_in_session = session['coordinates_all_in_session']
        
    return render_template("cell_size_round_cells.html", 
                           coordinates_all_in_session = coordinates_all_in_session
                           ) 