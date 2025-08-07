from flask import Blueprint, render_template, request, flash, redirect, session, json
from PIL import Image as im
import os, cv2, base64, io, time, math, openpyxl
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from skimage.measure import profile_line 
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
#from flask_login import current_user

cell_size_filament = Blueprint('cell_size_filament', __name__)

@cell_size_filament.route('/cell_size_filament', methods=['GET', 'POST'])
def analyze_cell_size_filament():
#    if current_user.is_authenticated:
    if request.method == "POST":               
        if request.form.get('pixel_size') == '':
            flash('Please enter pixel size', category='error')
        else:
            pixel_size_nm = float(str(request.form.get('pixel_size')))
            ##################
            ### Load image ###
            ##################
            if 'image' in request.files:
                image = (request.files['image'])
                image_name = str.lower(os.path.splitext(image.filename)[0]) # type: ignore
                image_extension = str.lower(os.path.splitext(image.filename)[1]) # type: ignore
                if image_extension in ALLOWED_EXTENSIONS:
                    upload_folder = UPLOAD_FOLDER
                    if os.path.isdir(upload_folder) == False:
                        os.mkdir(upload_folder)
                    filename = secure_filename(image.filename) # type: ignore
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
                    cell_sizes_final_df = pd.DataFrame([(0,0)])
                    counts = [1]
                    bin_edges = [0]
                    plt.scatter([], [])
                    plt.savefig(f'{upload_folder}/{image_name}_plot.jpeg')
                    #################################################
                    ### GET COORDINATES FROM JS (through session) ###
                    #################################################                 
                    if 'coordinates_all_in_session' in session:    
                        coordinates_all_from_session = session.get('coordinates_all_in_session', None)          
                        #convert coordinates to list
                        coordinates = list(coordinates_all_from_session) # type: ignore
                        #define empty tuple for storing coordinates of the cells
                        selection_coordinates = []
                        # convert coordinates to tuple with robust error checking
                        for i in range(len(coordinates)):
                            coordinate = coordinates[i]
                            values = list(coordinate.values())
                            if len(values) < 8:
                                flash(f'Coordinate data for cell {i+1} is incomplete or corrupted. Skipping this cell.', category='error')
                                continue
                            # coordinates of image from website - can change when window size changes
                            x_coordinate_img = int(values[2])
                            y_coordinate_img = int(values[3])
                            # coordinates of selection within image
                            x_coordinate_selection_start = int(values[6])
                            y_coordiante_selection_start = int(values[7])
                            x_coordinate_selection_end = int(values[4])
                            y_coordiante_selection_end = int(values[5])
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
                        # Define empty list to store the results for all cells together
                        cell_sizes_final = []
                        # Start analysis of individual cells
                        for i in range(len(selection_coordinates)):
                            # Define empty lists to store the result for each single cell
                            cell_sizes = []
                            # Extract number of cell from tuple for first element
                            cell_number = selection_coordinates[i][0]+1
                            # Extract coordinates from tuple for elements
                            x_rough_start = selection_coordinates[i][1]
                            y_rough_start = selection_coordinates[i][2]
                            x_rough_end = selection_coordinates[i][3]
                            y_rough_end = selection_coordinates[i][4]
                            # radius
                            radius = int(math.sqrt(pow((x_rough_end-x_rough_start),2)+pow((y_rough_end-y_rough_start),2))/2)
                            center_coordinate_x = int(x_rough_start+x_rough_end)/2
                            center_coordinate_y = int(y_rough_start+y_rough_end)/2
                            # Define increment above the cell edge for pixel profle analysis (% of the detected radius)
                            cell_radius_incremented = int(radius * 1.1)
                            ##################################
                            ### Get and save cell diameter ###
                            ##################################
                            # calculate cell diameter and other parameters in um
                            cell_diameter_um = float(radius*2*pixel_size_nm / 1000)
                            # Store the results for all cells
                            cell_sizes_final.append((i+1, cell_diameter_um)) 
                            ##############################
                            ### Draw lines and circles ###
                            ##############################
                            # Draw cell number 
                            cv2.putText(img_orig_copy, str(cell_number), (int(center_coordinate_x), int(center_coordinate_y)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 235, 15), 1)
                            # Draw circle
                            cv2.circle(img_orig_copy, (int(center_coordinate_x), int(center_coordinate_y)), int(cell_radius_incremented), (0, 255, 0), 1)
                            # Draw line
                            cv2.line(img_orig_copy, (x_rough_start, y_rough_start), (x_rough_end, y_rough_end), (255, 0, 0), 1)  
                        ##########################
                        ### Preparing final DF ###
                        ##########################
                        # Preparing dataframe with cell sizes
                        cell_sizes_final_df = pd.DataFrame(cell_sizes_final)
                        cell_sizes_final_df.rename(columns = {list(cell_sizes_final_df)[0]:'Cell number'}, inplace=True)
                        cell_sizes_final_df.rename(columns = {list(cell_sizes_final_df)[1]:'Cell diameter (μm)'}, inplace=True)
                        # plotting histogram
                        plt.hist(
                            cell_sizes_final_df[cell_sizes_final_df.columns[-1]]
                            )
                    ##################################
                    ### Preparing and saving plots ###
                    ##################################
                    # decorate histogram
                    plt.grid(axis='x', which='both', color='#888888', linestyle='--')
                    plt.title("Cell size distribution") 
                    plt.xlabel("Cell diameter (μm)")
                    plt.ylabel("Count")
                    # calculating histogram to get the y-axis range
                    counts, bin_edges = np.histogram(cell_sizes_final_df[cell_sizes_final_df.columns])
                    plt.yticks(np.arange(0,(max(counts)+1),1))
                    # saving histogram to memory
                    memory_for_histogram = io.BytesIO()
                    plt.savefig(memory_for_histogram, format='JPEG')
                    histogram_in_memory = base64.b64encode(memory_for_histogram.getvalue())
                    histogram_from_memory = histogram_in_memory.decode('ascii')
                    ###################################
                    ### Preparing and saving images ###
                    ###################################
                    # preparing images  
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
                    final_plot_encoded_in_memory = base64.b64encode(memory_for_final_plot.getvalue())
                    final_plot_decoded_from_memory = final_plot_encoded_in_memory.decode('ascii')
                    # Clearing the plot
                    plt.clf()
                    plt.cla()
                    plt.close()
                    ##########################################
                    ### Saving results and images to excel ###
                    ##########################################
                    # Save dataframe and images in Excel using xlsxwriter
                    xlsx_full_path = os.path.join(upload_folder, f"{image_name}_cell_sizes.xlsx")
                    with pd.ExcelWriter(xlsx_full_path, engine='xlsxwriter') as writer:
                        # Create new sheet for images
                        workbook = writer.book
                        worksheet_Results = workbook.add_worksheet('Results') # type: ignore
                        worksheet_processed_image = workbook.add_worksheet('Processed Image') # type: ignore
                        worksheet_original_image = workbook.add_worksheet('Original Image') # type: ignore
                        
                        # Write cell size results
                        cell_sizes_final_df.to_excel(writer, sheet_name='Results', index=False)
                        # Decode base64 images to BytesIO
                        orig_img_bytes = io.BytesIO(base64.b64decode(img_orig_decoded_from_memory))
                        download_img_bytes = io.BytesIO(base64.b64decode(img_for_download_decoded_from_memory))
                        plot_img_bytes = io.BytesIO(base64.b64decode(final_plot_decoded_from_memory))

                        # Insert images into 'Images' worksheet
                        worksheet_original_image.insert_image('A1', 'Original Image', {'image_data': orig_img_bytes})
                        worksheet_processed_image.insert_image('A1', 'Annotated Image', {'image_data': download_img_bytes})
                        worksheet_Results.insert_image('E1', 'Histogram Plot', {'image_data': plot_img_bytes})
                    
                    xlsx_file_path = f'uploads/{image_name}_cell_sizes.xlsx'

                
                else:
                    flash('Please select an image file.', category='error')  
                ################################################
                # Deleting files + temporary files from server #
                ################################################
                # Clear session
                session.pop('coordinates_all_in_session', None)
                # deleting uploaded images
                os.remove(os.path.join(upload_folder, f'original_{filename}').replace("\\","/")) # type: ignore
                os.remove(os.path.join(f'{upload_folder}/{image_name}_plot.jpeg').replace("\\","/")) # type: ignore
                # Deleting files older than 20 min
                # list all files
                list_of_files_in_upload_folder = os.listdir(upload_folder) # type: ignore
                # get current time
                current_time = time.time()
                # get number of seconds to reset
                seconds = 1200
                # scan for old files
                for i in list_of_files_in_upload_folder:
                    # get the location of each file
                    file_location = os.path.join(upload_folder, str(i)).replace("\\","/") # type: ignore
                    # get time when the file was modified 
                    file_time = os.stat(file_location).st_mtime
                    # if a file is modified before 20 min then delete it
                    if(file_time < current_time - seconds):
                        os.remove(os.path.join(upload_folder, str(i)).replace("\\","/")) # type: ignore
                # clear session
                session.pop('coordinates_all_in_session', None)
                ######################
                # Returning template #
                ######################
                return render_template("cell_size_filament.html", 
                    xlsx_file_path = xlsx_file_path, # type: ignore
                    x_pixels = x_pixels, # type: ignore
                    y_pixels = y_pixels, # type: ignore
                    img_for_download_decoded_from_memory = img_for_download_decoded_from_memory, # type: ignore
                    final_plot_decoded_from_memory = final_plot_decoded_from_memory, # type: ignore
                    pixel_size_nm = pixel_size_nm,
                    coordinates_all_from_session = coordinates_all_from_session, # type: ignore
                    histogram_from_memory = histogram_from_memory, # type: ignore
                    img_orig_decoded_from_memory = img_orig_decoded_from_memory,  # type: ignore
                    )
            else:
                flash('Please select up to 4 files.', category='error')
    return render_template("cell_size_filament.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")
#

# GETTING COORDINATES FROM JS
@cell_size_filament.route('/cell_size_filament/coordinates', methods=['POST'])
def coordinates_from_js():
    coordinates_from_js = request.get_json() # reading the cordinates from JS
    session['coordinates_all_in_session'] = json.loads(coordinates_from_js) #converting the json output to a python dictionary

    if 'coordinates_all_in_session' in session:
        coordinates_all_in_session = session['coordinates_all_in_session']
        
    return render_template("cell_size_filament.html", 
                           coordinates_all_in_session = coordinates_all_in_session # type: ignore
                           ) 