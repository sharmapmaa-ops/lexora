#!/usr/bin/env bash
# Starts py/server.py in the background automatically when the Codespace
# starts/resumes, so nobody has to type "python3 py/server.py" by hand.
# Safe to run more than once - it first checks whether something is
# already listening on the port and skips starting a second copy.

set -e
cd "$(dirname "$0")/.."

# Load OPENAI_API_KEY / OPENROUTER_API_KEY (and anything else) from a
# git-ignored .env file if one exists, so real keys never have to live in
# json/llm-config.json. Format: one KEY=value per line.
if [ -f ".env" ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

PORT="${PORT:-8000}"
LOG_FILE="/tmp/lexora-server.log"

already_running() {
    python3 - "$PORT" << 'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.settimeout(0.5)
result = s.connect_ex(("127.0.0.1", port))
s.close()
sys.exit(0 if result == 0 else 1)
PY
}

if already_running; then
    echo "Server already running on port $PORT - not starting another copy."
    exit 0
fi

nohup python3 py/server.py > "$LOG_FILE" 2>&1 &
disown || true
echo "Started py/server.py in the background (logs: $LOG_FILE)."
