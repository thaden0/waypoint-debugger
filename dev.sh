#!/usr/bin/env bash
# Start the Waypoint runner + UI together.
#   ./dev.sh [PROJECT_ROOT]
# PROJECT_ROOT defaults to the bundled fixture directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${1:-$ROOT/runner/tests/fixtures}"

if [ ! -d "$ROOT/runner/vendor" ]; then
  echo "Installing runner deps..."
  (cd "$ROOT/runner" && composer install)
fi
if [ ! -d "$ROOT/runner-js/node_modules" ]; then
  echo "Installing JS adapter deps..."
  (cd "$ROOT/runner-js" && npm install)
fi
if [ ! -d "$ROOT/ui/node_modules" ]; then
  echo "Installing UI deps..."
  (cd "$ROOT/ui" && npm install)
fi

# Resident host: boots the app once, serves the control plane over WebSocket
# (ws://127.0.0.1:9778) with full run + invoke capability.
echo "Host → $PROJECT_ROOT  (ws://127.0.0.1:9778)"
PROJECT_ROOT="$PROJECT_ROOT" php "$ROOT/runner/bin/host.php" >/tmp/waypoint-host.log 2>&1 &
HOST_PID=$!

# HTTP runner: static-analysis fallback for when the host isn't running.
PROJECT_ROOT="$PROJECT_ROOT" php -S 127.0.0.1:9777 "$ROOT/runner/bin/server.php" >/tmp/waypoint-runner.log 2>&1 &
RUNNER_PID=$!

# Integrated terminal: standalone PTY WebSocket server (bash) for the code view.
echo "Terminal → ws://127.0.0.1:9790"
PROJECT_ROOT="$PROJECT_ROOT" WAYPOINT_PTY_PORT=9790 npm --prefix "$ROOT/runner-js" run terminal >/tmp/waypoint-pty.log 2>&1 &
PTY_PID=$!

trap 'kill $HOST_PID $RUNNER_PID $PTY_PID 2>/dev/null || true' EXIT

echo "UI → http://localhost:5180"
(cd "$ROOT/ui" && npm run dev)
