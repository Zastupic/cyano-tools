from flask import Blueprint, render_template, request, jsonify
from flask_login import login_required, current_user
from .github_updates import get_updated_tools, get_new_tools
import subprocess
import os

views = Blueprint('views', __name__)

@views.route('/')
#@login_required
def home():
    updated_tools = get_updated_tools()
    new_tools     = get_new_tools()
    return render_template("home.html", user=current_user, updated_tools=updated_tools, new_tools=new_tools)

@views.route('/deploy', methods=['POST'])
def deploy():
    token = request.headers.get('X-Deploy-Token', '')
    expected = os.environ.get('DEPLOY_TOKEN', '')
    if not expected or token != expected:
        return jsonify({'error': 'Unauthorized'}), 403
    try:
        result = subprocess.run(
            ['git', 'pull', 'origin', 'main'],
            cwd='/home/Zastupic/mysite',
            capture_output=True, text=True, timeout=60
        )
        subprocess.run(['touch', '/var/www/tools-py_e-cyanobacterium_org_wsgi.py'])
        return jsonify({'status': 'ok', 'output': result.stdout}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500
