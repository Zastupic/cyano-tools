import os, time, atexit, datetime
from apscheduler.schedulers.background import BackgroundScheduler
from flask import Blueprint
from website import UPLOAD_FOLDER

clear_uploads = Blueprint('clear_uploads', __name__)

def delete_images():
    current_time = time.time()
    print(str(datetime.datetime.fromtimestamp(current_time))+': clear uploads running. ')
    list_of_directories = os.listdir(UPLOAD_FOLDER)
    for i in list_of_directories:
        directory = UPLOAD_FOLDER+str(i)
        files = os.listdir(directory)
        for i in files:
            file = (os.path.join(directory, i).replace("\\","/"))
            last_modified = os.path.getctime(file)
            time_difference = (current_time - last_modified)/60/60
            if time_difference > 10: # files older than 10 min
                print('The file '+str(file)+' is '+str(int(time_difference*60))+' min old and will be deleted.')
                os.remove(file)
            else:
                print('The file '+str(file)+' is '+str(int(time_difference*60))+' min old.')

# setting the scheduler
scheduler = BackgroundScheduler()
scheduler.add_job(func=delete_images, trigger="interval", seconds=600)
scheduler.start()
atexit.register(lambda: scheduler.shutdown()) # Exit the scheduler when exiting the app
