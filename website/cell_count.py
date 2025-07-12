from flask import Blueprint, render_template, request, flash, redirect
import os, cv2, base64, io
import pandas as pd
import time
from PIL import Image as im
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
#from flask_login import current_user

cell_count = Blueprint('cell_count', __name__)

@cell_count.route('/cell_count', methods=['GET', 'POST'])
def count_cells():
#    if current_user.is_authenticated:
    if request.method == "POST":               
        if request.form.get('pixel_size') == '':
            flash('Please enter pixel size', category='error')
        else:
            pixel_size_nm = float(str(request.form.get('pixel_size')))
            depth_um = (int(request.form["chamber_depth_range"]))
            minimal_expected_size = float(request.form["minimal_diameter_range"]) # Get smallest cell size (in um)
            minimum_area = 3.141592653*((minimal_expected_size * 1000 / pixel_size_nm)/2)**2 # Defines area of the smallest cell (in pixels)
            # get the current time
            current_time = time.time()
            ####################################
            ### Load image for cell counting ###
            ####################################
            if 'selected_images' in request.files:
                image = (request.files['selected_images'])
                image_name = str.lower(os.path.splitext(str(image.filename))[0])
                image_extension = str.lower(os.path.splitext(str(image.filename))[1])
                if image_extension in ALLOWED_EXTENSIONS:
                    upload_folder = UPLOAD_FOLDER
                    if os.path.isdir(upload_folder) == False:
                        os.mkdir(upload_folder)
                    filename = secure_filename(str(image.filename))
                    # saving original image
                    image.save(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))
                    # Noise reduction before application of threshold 
                    filename2 = f'original_{filename}'
                    img_orig = cv2.imread(f'{upload_folder}/{filename2}')
                    img_blur = cv2.blur(img_orig, (3,3))
                    img_grey = cv2.cvtColor(img_blur, cv2.COLOR_BGR2GRAY) # Converting image to gray 
                    # Get threshold selection from select box on webpage
                    threshold = (request.form.get('threshold_filter'))
                    img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY)
                    if threshold == 'Triangle + Binary':
                        img_th = img_th
                    elif threshold == 'To zero + Triangle':
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)
                    elif threshold == 'Binary + Otsu':
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_BINARY + cv2.THRESH_OTSU)
                    elif threshold == 'Binary':
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_BINARY)
                    elif threshold == 'To zero':
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO)
                    elif threshold == 'Triangle':
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TRIANGLE)
                    elif threshold == 'Otsu':
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_OTSU)
                    # Apply another threshold for showing the counted cells on saved image
                    img_for_counted_cells = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                    img_for_counted_cells = cv2.cvtColor(img_for_counted_cells, cv2.COLOR_GRAY2BGR)
                    # Select ararys from the applied threshold fof further processing 
                    img_th = img_th[1]
                    ############################
                    ### Mark counted objects ###
                    ############################
                    contours_th = cv2.findContours(img_th, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)[0] 
                    cell_count = 0
                    rough_coordinates_autmated_counting = []
                    # Count mark and number the contours found (= cells bigger then defined "minimum_area")
                    if contours_th is not None: 
                        for i in range(len(contours_th)):
                            area = cv2.contourArea(contours_th[i])
                            if area > minimum_area:
                                x,y,w,h = cv2.boundingRect(contours_th[i])
                                x_coord = int(x+w/2)
                                y_coord = int(y+h/2)
                                width = int(w/2)
                                cell_count = cell_count + 1
                                cv2.circle(img_for_counted_cells,(x_coord, y_coord), width,(0,255,0), 1)
                                cv2.putText(img_for_counted_cells, str(cell_count), (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                                coords = tuple([cell_count,x_coord,y_coord])
                                rough_coordinates_autmated_counting.append(coords)          
                    # preapring images for showing on the webiste  
                    img_original = im.fromarray(img_orig)
                    img_th_to_show = im.fromarray(img_th)
                    img_counted = im.fromarray(img_for_counted_cells)
                    ##############################################
                    ### 4. Calculate cell number per ml sample ###
                    ##############################################
                    y_pixels, x_pixels, channels = img_for_counted_cells.shape
                    # Calculate image area
                    x_nm = x_pixels * pixel_size_nm
                    y_nm = y_pixels * pixel_size_nm
                    img_area_mm2 = round(((x_nm / 1e6) * (y_nm / 1e6)), 3)
                    # Calculate volume of sample
                    img_volume_nl = round((x_nm * y_nm * (depth_um * 1000) / 1e15), 3) # 1 nanoliter = 1 × 10^15 cubic nanometer
                    img_volume_ml = img_volume_nl / 1e6
                    if img_volume_nl > 1:
                        # Calculate number of cells per ml
                        cells_per_ml = cell_count / img_volume_ml
                        million_cells_per_mL = round(cells_per_ml / 1e6, 3)
                        # Mark the cell concentration to the image
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Cell count: '+str(cells_per_ml)+'x10^6 cells/mL', (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Identified cells: '+str(cell_count), (10, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Additionally identified cells (manual correction): '+str(manually_identified_cells), (10, 150), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Image resolution: '+str(x_pixels)+' x '+str(y_pixels), (10, 200), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Image area: '+str(img_area_mm2)+' mm^2', (10, 250), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Volume of the imaged area: '+str(img_volume_nl)+' nL', (10, 300), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Pixel size: '+str(pixel_size_nm)+' nm', (10, 350), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Depth of the chamber: '+str(depth_nm)+' nm', (10, 400), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = cv2.putText(img_for_counted_cells, 'Threshold used: '+str(threshold), (10, 450), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
#                              img_for_download = im.fromarray(img_for_download)
#                              img_for_download.save(os.path.join(upload_folder, f'counted_cells_{filename}'))
                        #saving images to memory
                        memory_for_original_image = io.BytesIO()
                        memory_for_threshold_image = io.BytesIO()
                        memory_for_counted_image = io.BytesIO()
#                              memory_for_image_to_download = io.BytesIO()
                        img_original.save(memory_for_original_image, "JPEG")
                        img_orig_encoded_in_memory = base64.b64encode(memory_for_original_image.getvalue())
                        img_orig_decoded_from_memory = img_orig_encoded_in_memory.decode('utf-8')
                        img_counted.save(memory_for_counted_image, "JPEG")
                        img_counted_encoded_in_memory = base64.b64encode(memory_for_counted_image.getvalue())
                        img_counted_decoded_from_memory = img_counted_encoded_in_memory.decode('utf-8')
                        img_th_to_show.save(memory_for_threshold_image, "JPEG")
                        img_th_encoded_in_memory = base64.b64encode(memory_for_threshold_image.getvalue())
                        img_th_decoded_from_memory = img_th_encoded_in_memory.decode('utf-8')
                        ##############################
                        ### Saving images to excel ###
                        ##############################
                        # Save results and images in Excel using xlsxwriter
                        xlsx_full_path = os.path.join(f'{upload_folder}/{filename2}_counted_cells.xlsx')
                        # Write summary text data to worksheet
                        summary_lines = [
                            f"Cell count without manual correction: {million_cells_per_mL} x 10^6 cells mL^-1",
                            f"Identified cells: {cell_count}",
                            f"Image resolution: {x_pixels} x {y_pixels} pixels",
                            f"Image area: {img_area_mm2} mm² ({int(x_nm / 1000)} x {int(y_nm / 1000)} µm)",
                            f"Volume of the imaged area: {img_volume_nl} nL",
                            f"Pixel size: {pixel_size_nm} nm",
                            f"Depth of the chamber: {depth_um} µm",
                            f"Threshold cell size: {minimal_expected_size} µm"]
                        with pd.ExcelWriter(xlsx_full_path, engine='xlsxwriter') as writer:
                            # Create new sheet for images
                            workbook = writer.book
                            worksheet_Results = workbook.add_worksheet('Results') # type: ignore
                            worksheet_final_plot = workbook.add_worksheet('Intensities plot') # type: ignore
                            worksheet_Selected_cells = workbook.add_worksheet('Selected cells') # type: ignore
                            worksheet_original_image = workbook.add_worksheet('Original Image') # type: ignore
                            # Write results
                            for row_num, line in enumerate(summary_lines):
                                worksheet_Results.write(row_num, 0, line)
                            # Decode base64 images to BytesIO
                            orig_img_bytes = io.BytesIO(base64.b64decode(img_orig_decoded_from_memory))
                            counted_img_bytes = io.BytesIO(base64.b64decode(img_counted_decoded_from_memory))
                            thresholded_img_bytes = io.BytesIO(base64.b64decode(img_th_decoded_from_memory))
                            # Insert images into 'Images' worksheet
                            worksheet_final_plot.insert_image('A1', 'Results, counted cells', {'image_data': counted_img_bytes})
                            worksheet_Selected_cells.insert_image('A1', 'Thresholded image', {'image_data': thresholded_img_bytes})
                            worksheet_original_image.insert_image('A1', 'Original Image', {'image_data': orig_img_bytes})
                        xlsx_file_path = f'uploads/{filename2}_counted_cells.xlsx'
                        ######################################
                        ### Delete files older than 20 min ###
                        ######################################
                        # deleting original image - instantly
                        os.remove(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))
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
                        # render template
                        return render_template("cell_count.html", 
                            #user_id = user_id,
                            img_orig_decoded_from_memory = img_orig_decoded_from_memory, 
                            img_th_decoded_from_memory = img_th_decoded_from_memory,
                            img_counted_decoded_from_memory = img_counted_decoded_from_memory,
                            img_for_download = f'{image_name}_counted{image_extension}',
                            cell_count = cell_count,
                            cells_per_ml = cells_per_ml,
                            million_cells_per_mL = million_cells_per_mL,
                            x_pixels = x_pixels,
                            y_pixels = y_pixels,
                            img_area_mm2 = img_area_mm2,
                            img_volume_nl = img_volume_nl,
                            img_volume_ml = img_volume_ml,
                            x_um = int(x_nm / 1000),
                            y_um = int(y_nm / 1000),
                            pixel_size_nm = pixel_size_nm,
                            depth_um = depth_um,
                            minimal_expected_size = minimal_expected_size,
                            threshold = threshold,
                            xlsx_file_path = xlsx_file_path
                            )
                    else:
                        cells_per_ml = '0.00'
                        flash('Pixel size is too low', category='error')
                    return render_template("cell_count.html")
                else:
                    flash('Please select an image file.', category='error')
    return render_template("cell_count.html")
#    else:
#        flash('Please login', category='error')
#        return redirect("/login")

def additional_cells_marking():
    return render_template("cell_count.html")
        

    





