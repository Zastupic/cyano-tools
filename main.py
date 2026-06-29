try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv not installed — rely on environment variables being set externally

from website import create_app

app = create_app()

# this means that the only way how to run the server is to run the file directly
# importing the file will not run the server. 
# without this line, importing the "main.py" file from another file would run the server
if __name__ == '__main__':
    # app.run: this command runs the server
    # debug=False in production; set FLASK_DEBUG=1 env var for local development only
    app.run(debug=False)