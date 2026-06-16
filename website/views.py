from flask import Blueprint, render_template, request, jsonify, Response, current_app
from flask_login import login_required, current_user
from .github_updates import get_updated_tools, get_new_tools
import subprocess
import os
import hmac

views = Blueprint('views', __name__)

@views.route('/robots.txt')
def robots():
    content = (
        "User-agent: *\n"
        "Disallow: /api/\n"
        "Disallow: /static/files/\n"
        "Disallow: /cdn-cgi/\n"
        "\n"
        "Sitemap: https://www.cyano.tools/sitemap.xml\n"
    )
    return Response(content, mimetype='text/plain')


@views.route('/')
#@login_required
def home():
    updated_tools = get_updated_tools()
    new_tools     = get_new_tools()
    return render_template("home.html", user=current_user, updated_tools=updated_tools, new_tools=new_tools)

@views.route('/deploy', methods=['POST'])
def deploy():
    token    = request.headers.get('X-Deploy-Token', '')
    expected = os.environ.get('DEPLOY_TOKEN', '')
    # Constant-time comparison prevents timing-based token enumeration
    if not expected or not hmac.compare_digest(token, expected):
        return jsonify({'error': 'Unauthorized'}), 403
    try:
        result = subprocess.run(
            ['git', 'pull', 'origin', 'main'],
            cwd='/home/Zastupic/mysite',
            capture_output=True, text=True, timeout=60
        )
        # Touch the WSGI file to trigger a PythonAnywhere reload.
        # Set WSGI_FILE_PATH env var to the correct path for your web app.
        wsgi_path = os.environ.get(
            'WSGI_FILE_PATH',
            '/var/www/www_cyano_tools_wsgi.py',
        )
        if os.path.exists(wsgi_path):
            os.utime(wsgi_path, None)
        return jsonify({'status': 'ok'}), 200
    except Exception:
        current_app.logger.exception('Deploy via /deploy failed')
        return jsonify({'error': 'Deployment failed'}), 500
