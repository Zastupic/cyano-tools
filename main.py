from website import create_app

app = create_app()

# this means that the only way how to run the server is to run the file directly
# importing the file will not run the server. 
# without this line, importing the "main.py" file from another file would run the server
if __name__ == '__main__':
    # app.run: this command runs the serer
    # debug=true: every change we make will re-run the server - good for development, not good for production
    app.run(debug=True)