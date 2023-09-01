from flask import Blueprint, render_template, request, flash, session, redirect, url_for, json
from PIL import Image as im
import os, cv2, base64, io
from werkzeug.utils import secure_filename
from . import ALLOWED_EXTENSIONS, UPLOAD_FOLDER
from flask_login import current_user

pixel_profiles = Blueprint('pixel_profiles', __name__)
coordinate_1_1 = None

@pixel_profiles.route('/pixel_profiles', methods=['GET', 'POST'])
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
                    #user_id = current_user.get_id()
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

                    # GETTING COORDINATES FROM JS
                    coordinates_all_from_session = ''
                    if 'coordinates_all_in_session' in session:    
                        coordinates_all_from_session = session.get('coordinates_all_in_session', None)
                        flash('Cells selected successfully', category='success')
                        print('Coordinates successfully received from session: ' + str(len(coordinates_all_from_session)))

                        #convert coordinates to list
                        coordinates = list(coordinates_all_from_session)

                        for i in range(len(coordinates)):
                            coordinate = coordinates[i]
                            print('coordinate '+ str(i)+': '+str(coordinates[i]))
                            print('canvas '+ str(i)+' size_x: '+str(int(list(coordinate.values())[0])))
                            print('canvas '+ str(i)+' size_y: '+str(int(list(coordinate.values())[1])))
                            print('image '+ str(i)+' size_x: '+str(int(list(coordinate.values())[2])))
                            print('image '+ str(i)+' size_y: '+str(int(list(coordinate.values())[3])))
                            print('x '+ str(i)+': '+str(int(list(coordinate.values())[4])))
                            print('y '+ str(i)+': '+str(int(list(coordinate.values())[5])))

                            x_coordinate_canvas = int(list(coordinate.values())[0])
                            y_coordinate_canvas = int(list(coordinate.values())[1])
                            x_coordinate_selection = int(list(coordinate.values())[4])
                            y_coordiante_selection = int(list(coordinate.values())[5])

                            x_coordinate_for_original_picture = int(x_coordinate_selection / x_coordinate_canvas * x_pixels)
                            y_coordinate_for_original_picture = int(y_coordiante_selection / y_coordinate_canvas * y_pixels)

                            cv2.putText(img_orig_copy, str(i+1),(x_coordinate_for_original_picture, y_coordinate_for_original_picture), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                            cv2.circle(img_orig_copy,(x_coordinate_for_original_picture,y_coordinate_for_original_picture), int(50), (255,255,0),2)

                        # Clear session
                        session.pop('coordinates_all_in_session', default=None)
                    
                    # preapring images for showing on the webiste  
                    img_original = im.fromarray(img_orig)
                    img_for_download = im.fromarray(img_orig_copy)

                    #saving images to memory
                    memory_for_original_image = io.BytesIO()
                    memory_for_image_to_download = io.BytesIO()
                            
                    img_original.save(memory_for_original_image, "JPEG")
                    img_orig_encoded_in_memory = base64.b64encode(memory_for_original_image.getvalue())
                    img_orig_decoded_from_memory = img_orig_encoded_in_memory.decode('utf-8')

                    img_for_download.save(memory_for_image_to_download, "JPEG")
                    img_for_download_encoded_in_memory = base64.b64encode(memory_for_image_to_download.getvalue())
                    img_for_download_decoded_from_memory = img_for_download_encoded_in_memory.decode('utf-8')
                
                    # deleting original image
                    os.remove(os.path.join(upload_folder, f'original_{filename}').replace("\\","/"))

                    return render_template("pixel_profiles.html", 
                        #user_id = user_id,
                        img_orig_decoded_from_memory = img_orig_decoded_from_memory,
                        img_for_download_decoded_from_memory = img_for_download_decoded_from_memory,
                        x_pixels = x_pixels,
                        y_pixels = y_pixels,
                        coordinates_all_from_session = coordinates_all_from_session
                        )
                else:
                    flash('Please select an image file.', category='error')
        return render_template("pixel_profiles.html")
    else:
        flash('Please login', category='error')
        return redirect("/login")

# GETTING COORDINATES FROM JS
@pixel_profiles.route('/pixel_profiles/coordinates', methods=['POST'])
def coordinates_from_js():
    coordinates_from_js = request.get_json() # reading the cordinates from JS
    session['coordinates_all_in_session'] = json.loads(coordinates_from_js) #converting the json output to a python dictionary

    if 'coordinates_all_in_session' in session:
        coordinates_all_in_session = session['coordinates_all_in_session']
        #print("coordinates successfully stored in session: " + str(len(coordinates_all_in_session)))
    
    return render_template("pixel_profiles.html", 
                           coordinates_all_in_session = coordinates_all_in_session
                           ) 
    #return coordinates_all_without_sessions
    #coordinate_1 = coordinates_all_from_session[0]
    #coordinate_1_1 = int(list(coordinate_1.values())[0])