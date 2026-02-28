import hashlib
import hmac
import os
import subprocess
from flask import Blueprint, abort, current_app, request

deploy = Blueprint('deploy', __name__)

WEBHOOK_SECRET = os.environ.get('GITHUB_WEBHOOK_SECRET', '')
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root


def _verify_signature(payload: bytes, signature_header: str) -> bool:
    """Verify the GitHub X-Hub-Signature-256 header."""
    if not WEBHOOK_SECRET or not signature_header:
        return False
    expected = 'sha256=' + hmac.new(
        WEBHOOK_SECRET.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header)


@deploy.route('/webhook-deploy', methods=['POST'])
def webhook():
    payload = request.get_data()
    signature = request.headers.get('X-Hub-Signature-256', '')

    if not _verify_signature(payload, signature):
        current_app.logger.warning('Webhook: invalid signature from %s', request.remote_addr)
        abort(403)

    try:
        # 1. Fetch updates from GitHub
        subprocess.run(['git', 'fetch', 'origin', 'main'], cwd=REPO_DIR, check=True)

        # 2. Force reset to match origin/main (This fixes the 'overwritten' error)
        result = subprocess.run(
            ['git', 'reset', '--hard', 'origin/main'],
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )

        # 3. Clean untracked files (This fixes the 'untracked working tree files' error)
        subprocess.run(['git', 'clean', '-fd'], cwd=REPO_DIR, check=True)

        # 4. AUTO-RELOAD PythonAnywhere (Crucial!)
        # Replace 'yourusername' and 'yourdomain_com' with your actual details
        wsgi_file = "/var/www/yourusername_pythonanywhere_com_wsgi.py"
        if os.path.exists(wsgi_file):
            os.utime(wsgi_file, None)

        current_app.logger.info('Git Reset Success: %s', result.stdout)

    except subprocess.CalledProcessError as e:
        current_app.logger.error('Git command failed: %s', e.stderr)
        return {'status': 'error', 'detail': str(e.stderr)}, 500
    except subprocess.TimeoutExpired:
        return {'status': 'error', 'detail': 'git operation timed out'}, 500

    return {'status': 'ok', 'detail': 'Server updated and reloaded'}, 200