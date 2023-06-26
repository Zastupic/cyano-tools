from flask import Blueprint, render_template, request, flash, redirect
from PIL import Image as im
import os, cv2
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

cell_counting = Blueprint('cell_counting', __name__)

@cell_counting.route('/cell_count', methods=['GET', 'POST'])
def count_cells():
    if current_user.is_authenticated:
        if request.method == "POST":               
            if request.form.get('pixel_size') == '':
                flash('Please enter pixel size', category='error')
            elif request.form.get('chamber_depth') == '':
                flash('Please enter depth of the counting chamber', category='error')
            elif request.form.get('minimal_size') == '':
                flash('Please enter minimal cell size', category='error')
            else:
                pixel_size_nm = int(request.form.get('pixel_size'))
                depth_nm = int(request.form.get('chamber_depth'))
                minimal_expected_size = int(request.form.get('minimal_size')) # Get smallest cell size (in um)
                manually_identified_cells = int(request.form.get('manually_identified_cells'))
                minimum_area = 3.141592653*((minimal_expected_size * 1000 / pixel_size_nm)/2)**2 # Defines area of the smallest cell (in pixels)

                ### Load image for cell counting ###
                if 'image' in request.files:
                    image = (request.files['image'])
                    image_extension = str.lower(os.path.splitext(image.filename)[1])

                    if image_extension in ALLOWED_EXTENSIONS:
                        user_id = current_user.get_id()
                        upload_folder = os.path.join(UPLOAD_FOLDER, user_id)

                        if os.path.isdir(upload_folder) == False:
                            os.mkdir(upload_folder)

                        filename = secure_filename(image.filename)
                        # saving original image
                        image.save(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))
                        
                        # Noise reduction before application of threshold 
                        filename2 = f'original_{filename}'
                        img = cv2.imread(f'{upload_folder}/{filename2}')
                        img = cv2.blur(img, (3,3))

                        img_grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) # Converting image to gray 

                        ### Apply threshold for cells identification ###
                        img_th = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TRIANGLE + cv2.THRESH_BINARY)
                        img_for_counted_cells = cv2.threshold(img_grey, 0, 255,cv2.THRESH_TOZERO + cv2.THRESH_TRIANGLE)[1]
                        img_for_counted_cells = cv2.cvtColor(img_for_counted_cells, cv2.COLOR_GRAY2BGR)

                        # Select ararys from the applied threshold fof further processing 
                        img_th = img_th[1]

                        ### Mark counted objects ###
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
                                    cv2.circle(img_for_counted_cells,(x_coord, y_coord), width,(0,255,0),2)
                                    cv2.putText(img_for_counted_cells, str(cell_count), (x, y), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                                    coords = tuple([cell_count,x_coord,y_coord])
                                    rough_coordinates_autmated_counting.append(coords)          
                        
                        cell_count = cell_count + manually_identified_cells 

                        ### 4. Calculate cell number per ml sample ###
                        y_pixels, x_pixels, channels = img_for_counted_cells.shape

                        # Calculate image area
                        x_nm = x_pixels * pixel_size_nm
                        x_um = int(x_nm / 1e3)
                        y_nm = y_pixels * pixel_size_nm
                        y_um = int(y_nm / 1e3)
                        img_area_mm2 = round((x_um * y_um) / 1e6, 2)

                        # Calculate volume of sample
                        img_volume_ul = img_area_mm2 * (depth_nm / 1e6)
                        img_volume_nl = round(img_volume_ul * 1e3, 2)

                        if img_volume_ul > 1e-6:
                            # Calculate number of cells per ml
                            cells_per_ml = round((cell_count)*(1/img_volume_ul)/1e6, 3)

                            # saving grayscale image  
                            img_grey_to_show = im.fromarray(img_grey)
                            img_grey_to_show.save(os.path.join(upload_folder, f'grey_{filename}'))

                            # saving thresholded image  
                            img_th_to_show = im.fromarray(img_th)
                            img_th_to_show.save(os.path.join(upload_folder, f'thresholded_{filename}'))

                            # saving counted image  
                            img_counted = im.fromarray(img_for_counted_cells)
                            img_counted.save(os.path.join(upload_folder, f'counted_{filename}'))

                            testing_function()

                            # Mark the cell concentration to the image
                            img_for_download = cv2.putText(img_for_counted_cells, 'Cell count: '+str(cells_per_ml)+'x10^6 cells/mL', (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = cv2.putText(img_for_counted_cells, 'Identified cells: '+str(cell_count), (10, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = cv2.putText(img_for_counted_cells, 'Additionally identified cells (manual correction): '+str(manually_identified_cells), (10, 150), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = cv2.putText(img_for_counted_cells, 'Image resolution: '+str(x_pixels)+' x '+str(y_pixels), (10, 200), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = cv2.putText(img_for_counted_cells, 'Image area: '+str(img_area_mm2)+' mm^2', (10, 250), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = cv2.putText(img_for_counted_cells, 'Volume of the imaged area: '+str(img_volume_nl)+' nL', (10, 300), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = cv2.putText(img_for_counted_cells, 'Pixel size: '+str(pixel_size_nm)+' nm', (10, 350), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = cv2.putText(img_for_counted_cells, 'Depth of the chamber: '+str(depth_nm)+' nm', (10, 400), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 162, 0), 4)
                            img_for_download = im.fromarray(img_for_download)
                            img_for_download.save(os.path.join(upload_folder, f'counted_cells_{filename}'))

                            return render_template("cell_count.html", 
                                               user_id = user_id,
                                               image_for_cell_counting = f'original_{filename}', 
                                               img_grey_to_show = f'grey_{filename}',
                                               img_th_to_show = f'thresholded_{filename}',
                                               img_counted = f'counted_{filename}',
                                               img_for_download = f'counted_cells_{filename}',
                                               cell_count = cell_count,
                                               cells_per_ml = cells_per_ml,
                                               x_pixels = x_pixels,
                                               y_pixels = y_pixels,
                                               img_area_mm2 = img_area_mm2,
                                               img_volume_nl = img_volume_nl,
                                               x_um = x_um,
                                               y_um = y_um,
                                               pixel_size_nm = pixel_size_nm,
                                               depth_nm = depth_nm,
                                               minimal_expected_size = minimal_expected_size,
                                               manually_identified_cells = manually_identified_cells
                                               )
                        else:
                            cells_per_ml = '0.00'
                            flash('Pixel size is too low', category='error')
                        return render_template("cell_count.html")
                    else:
                        flash('Please select an image file.', category='error')
        return render_template("cell_count.html")
    else:
        flash('Please login', category='error')
        return redirect("/login")
    

def testing_function(): 
    print('download image function is running!')     

    





