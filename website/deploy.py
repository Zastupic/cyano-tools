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
        result = subprocess.run(
            ['git', 'pull'],
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
        current_app.logger.info('git pull stdout: %s', result.stdout)
        if result.returncode != 0:
            current_app.logger.error('git pull stderr: %s', result.stderr)
            return {'status': 'error', 'detail': result.stderr}, 500
    except subprocess.TimeoutExpired:
        return {'status': 'error', 'detail': 'git pull timed out'}, 500

    return {'status': 'ok', 'detail': result.stdout}, 200
