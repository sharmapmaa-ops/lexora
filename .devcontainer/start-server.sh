#!/usr/bin/env bash
# Starts py/server.py in the background automatically when the Codespace
# starts/resumes (or a client reconnects - see devcontainer.json's
# postAttachCommand), so nobody has to type "python3 py/server.py" by
# hand. Safe to run more than once - it first checks whether something is
# already listening on the port and skips starting a second copy.
#
# Uses setsid (not just nohup/disown) to fully detach the new process
# from this script's session - nohup alone can still get killed when the
# parent shell that launched postStartCommand itself gets torn down in
# some Codespaces execution contexts, which is what caused the server to
# need manual restarting. setsid puts it in a brand new session so it
# can't be taken down with the parent.

cd "$(dirname "$0")/.."

PORT="${PORT:-8000}"
LOG_FILE="/tmp/lexora-server.log"
PID_FILE="/tmp/lexora-server.pid"

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

setsid python3 py/server.py < /dev/null > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
disown || true

# Give it a moment, then confirm it actually came up - if not, the log
# file has the real error (missing dependency, port already in use by
# something that isn't accepting connections yet, etc).
sleep 1.5
if already_running; then
    echo "Started py/server.py in the background (pid $(cat "$PID_FILE"), logs: $LOG_FILE)."
else
    echo "WARNING: py/server.py did not come up - check $LOG_FILE for the real error:"
    tail -n 20 "$LOG_FILE" 2>/dev/null || true
fi
