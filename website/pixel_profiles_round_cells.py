from flask import Blueprint, render_template, request, flash, session, redirect, json
from PIL import Image as im
import os, cv2, base64, io, math, time, openpyxl    
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from skimage.measure import profile_line 
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

pixel_profiles_round_cells = Blueprint('pixel_profiles_round_cells', __name__)

@pixel_profiles_round_cells.route('/pixel_profiles_round_cells', methods=['GET', 'POST'])
def get_pixel_profiles():
    if current_user.is_authenticated:
        if request.method == "POST":               
            
            ####################################
            ### Load image for cell counting ###
            ####################################
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

                    #pixels
                    y_pixels, x_pixels, channels = img_orig.shape

                    #create empty variables
                    Pixel_profiles = []
                    Pixel_profiles_df = []
                    Final_profiles = []
                    Pixel_profiles_df3 = pd.DataFrame()
                    xlsx_file_path = str('')
                    coordinates_all_from_session = ''
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

                            #cv2.putText(img_orig_copy, str(i+1),(x_coordinate_for_original_picture, y_coordinate_for_original_picture), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                            #cv2.circle(img_orig_copy,(x_coordinate_for_original_picture,y_coordinate_for_original_picture), int(50), (255,255,0),2)
                        
                        #############################################################
                        ### Creating mask(s) on an image based on cells selection ###
                        #############################################################
                         
                        #radius
                        radius = int(list(coordinate.values())[4])                      

                        # Define empty list to store the pixel intensity results for all cells together
                        Final_profiles = []
                        
                        for i in range(len(rough_coordinates)):
                            # Define empty list to store the pixel intensity results for each single cell
                            Pixel_profiles = []
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

                                #########################################################################################################
                                ### 5. Read the intensity of pixels from cell center to edge throughout 360°, with defined angle step ###
                                #########################################################################################################
                                # Extract parameters of detected cell(s) + define coordinates for line
                                detected_cell_radius = circle[0][0][2] 

                                # Define incremnt above the cell edge for pixel profle analysis (% of the detected radius)
                                cell_radius_incremented = detected_cell_radius * 1.3

                                # Get cell coordinates
                                detected_cell_center = (circle[0][0][0],circle[0][0][1])
                                detected_cell_edge = (circle[0][0][0],(circle[0][0][1]+detected_cell_radius)) 
                                incremented_cell_edge_Y_coord = np.clip(detected_cell_edge[1].astype(np.uint32)+cell_radius_incremented, 0, 65535).astype(np.uint16)

                                # Rotate line across the cell
                                # Define angle step
                                defined_angle_step = 15
                                angle = 0

                                # Calculate number of steps
                                angles_count = int(360/defined_angle_step)

                                # Define empty vector for storing coordinates of the circle
                                incremented_cell_edge_shifted_by_angle = []

                                # Loop for finding cell profiles across the circle
                                for i in range(angles_count):
                                    # x-coordinates of the circle point, in RADIANS
                                    incremented_cell_edge_shifted_by_angle_X_coord = (detected_cell_center[0] + cell_radius_incremented * math.cos(angle*3.14/180)).astype(np.uint16)
                                    # Y-coordinates of the circle point, in RADIANS
                                    incremented_cell_edge_shifted_by_angle_Y_coord = (detected_cell_center[1] + cell_radius_incremented * math.sin(angle*3.14/180)).astype(np.uint16)
                                    # X and Y coordinates of the circle point
                                    incremented_cell_edge_shifted_by_angle = (incremented_cell_edge_shifted_by_angle_X_coord, incremented_cell_edge_shifted_by_angle_Y_coord)
                                    # Coordinates for pixel profile
                                    start = (detected_cell_center[1], detected_cell_center[0])
                                    end = (incremented_cell_edge_shifted_by_angle[1], incremented_cell_edge_shifted_by_angle[0])
                                    profile = profile_line(img_orig, start, end, linewidth=1, order=1)
                                    # Draw a line to mark where the pixel intensity was measured
                                    cv2.line(img_orig_copy, detected_cell_center, incremented_cell_edge_shifted_by_angle, (255, 0, 0), 1)
                                    # Mark the angle
                                    cv2.putText(img_orig_copy, str(angle), (incremented_cell_edge_shifted_by_angle[0], incremented_cell_edge_shifted_by_angle[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.3, (245, 235, 15), 1)

                                    # Store the pixel intensity results for a single cell to a list
                                    for i in range(profile.shape[0]):
                                        intensities = tuple([cell_number,angle,i+1,profile[i][0]]) 
                                        Pixel_profiles.append(intensities)
                                    # increase angle by defined step
                                    angle = angle+defined_angle_step

                                # Draw number of the analyzed cell  
                                cv2.putText(img_orig_copy, str(cell_number), (a, b), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (245, 235, 15), 2)
                                # Draw the circumference of the circle.
                                cv2.circle(img_orig_copy, (a, b), detected_cell_radius, (0, 255, 0), 1)

                                # Store the pixel intensitiy results for all cells  
                                Final_profiles.append(Pixel_profiles)
                        
                        ####################################
                        ### Save pixel profiles to excel ###
                        ####################################
                        
                        # Making a dataframe with all pixel intensities from all cells, as a tranformation of the original list
                        Pixel_profiles_df = pd.DataFrame(Final_profiles)
                        Pixel_profiles_df = Pixel_profiles_df.T
                        column_index = 0

                        # Spliting the dataframe to individual columns
                        for i in range(len(Pixel_profiles_df.columns)):
                            # Define temporary data frame and fill it with data for i-th cell
                            Pixel_profiles_df2 = pd.DataFrame(Pixel_profiles_df[i].to_list())
                            # Append to the final data frame for the i-th cell
                            Pixel_profiles_df3[(column_index)] = Pixel_profiles_df2[0]
                            # Rename column 1 for i-th cell in final data frame
                            Pixel_profiles_df3.rename(columns = {list(Pixel_profiles_df3)[column_index]:'Cell number'}, inplace=True)
                            # Append to the final data frame for the i-th cell
                            Pixel_profiles_df3[(column_index+1)] = Pixel_profiles_df2[1]
                            # Rename column 2 for i-th cell in final data frame
                            Pixel_profiles_df3.rename(columns = {list(Pixel_profiles_df3)[column_index+1]:'Angle'}, inplace=True)
                            # Append to the final data frame for the i-th cell
                            Pixel_profiles_df3[(column_index+2)] = Pixel_profiles_df2[2]
                            # Rename column 3 for i-th cell in final data frame
                            Pixel_profiles_df3.rename(columns = {list(Pixel_profiles_df3)[column_index+2]:'Pixel number cell '+str(i+1)}, inplace=True)
                            # Append to the final data frame for the i-th cell
                            Pixel_profiles_df3[(column_index+3)] = Pixel_profiles_df2[3]
                            # Rename column 4 for i-th cell in final data frame
                            Pixel_profiles_df3.rename(columns = {list(Pixel_profiles_df3)[column_index+3]:'Pixel intensity cell '+str(i+1)}, inplace=True)
                            # Skip already used columns
                            column_index = column_index+4
                            
                            plt.scatter(
                                Pixel_profiles_df3.iloc[:, ((i+1)*4-2)], # x-axis data
                                Pixel_profiles_df3.iloc[:, ((i+1)*4-1)], # y-axis data
                                s=20,
                                facecolors='none',
                                edgecolors = (round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2),round(np.random.uniform(0,1),2))
                                )
                        
                        # Saving the result into excel
                        Pixel_profiles_df3.to_excel(f'{upload_folder}/{image_name}_pixel_profiles.xlsx')
                        xlsx_file_path = f'uploads/{image_name}_pixel_profiles.xlsx'
                        print("xlsx_file_path: "+ str(xlsx_file_path))

                    ###################################################
                    ### Preparing images for showing on the webiste ###
                    ###################################################
                    plt.title("Pixel profiles (each color represents individual cell)") 
                    plt.xlabel("Distance from cell center (px)")
                    plt.ylabel("Pixel intensity (r.u.)")   
                    #plt.savefig(f'{upload_folder}/{image_name}_plot.jpeg') 
                    
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
                    final_plot_encoded_in_memory = base64.b64encode(memory_for_final_plot.getvalue())
                    final_plot_decoded_from_memory = final_plot_encoded_in_memory.decode('ascii')

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

                    return render_template("pixel_profiles_round_cells.html", 
                        image_name = image_name,
                        xlsx_file_path = xlsx_file_path,
                        img_orig_decoded_from_memory = img_orig_decoded_from_memory,
                        img_for_download_decoded_from_memory = img_for_download_decoded_from_memory,
                        x_pixels = x_pixels,
                        y_pixels = y_pixels,
                        coordinates_all_from_session = coordinates_all_from_session, 
                        final_plot_decoded_from_memory = final_plot_decoded_from_memory,
                        )
                else:
                    flash('Please select an image file.', category='error')
        return render_template("pixel_profiles_round_cells.html")
    else:
        flash('Please login', category='error')
        return redirect("/login")

# GETTING COORDINATES FROM JS
@pixel_profiles_round_cells.route('/pixel_profiles/coordinates', methods=['POST'])
def coordinates_from_js():
    coordinates_from_js = request.get_json() # reading the cordinates from JS
    session['coordinates_all_in_session'] = json.loads(coordinates_from_js) #converting the json output to a python dictionary

    if 'coordinates_all_in_session' in session:
        coordinates_all_in_session = session['coordinates_all_in_session']
        
    return render_template("pixel_profiles_round_cells.html", 
                           coordinates_all_in_session = coordinates_all_in_session
                           ) 
