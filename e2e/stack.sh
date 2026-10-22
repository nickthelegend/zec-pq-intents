#!/usr/bin/env bash
# Starts the Yaksok stack the way a user runs it, bound to 127.0.0.1, and records every PID in .run/pids.
#   ./stack.sh        rebuild the landing from the record, build the dashboard, then serve:
#                     landing 4183 (static), dashboard 5181 (vite preview),
#                     desk 8404 (PQI_PUBLISHED=deployments/testnet.json, the Oct 20 run),
#                     desk 8405 (PQI_PUBLISHED=deployments/testnet-pass2.json, pass 2)
#   ./stack.sh stop   kill exactly the PIDs this script started
# No chain is started and no wallet is opened: both desks serve the published records read-only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
run="$here/.run"
mkdir -p "$run"

if [ "${1:-}" = "stop" ]; then
  [ -f "$run/pids" ] || { echo "no stack running"; exit 0; }
  while read -r name pid; do
    if kill "$pid" 2>/dev/null; then echo "stopped $name ($pid)"; fi
  done < "$run/pids"
  rm -f "$run/pids"
  exit 0
fi

[ -f "$run/pids" ] && { echo "stack already running (see $run/pids); ./stack.sh stop first" >&2; exit 1; }

(cd "$root" && node packages/landing/build.mjs >"$run/landing-build.log" 2>&1) || { echo "landing build failed: $run/landing-build.log" >&2; exit 1; }
(cd "$root" && pnpm --filter @pqi/dashboard build >"$run/dashboard-build.log" 2>&1) || { echo "dashboard build failed: $run/dashboard-build.log" >&2; exit 1; }

python3 -m http.server 4183 --bind 127.0.0.1 -d "$root/packages/landing" >"$run/landing.log" 2>&1 &
echo "landing $!" >>"$run/pids"
(cd "$root/packages/dashboard" && exec ./node_modules/.bin/vite preview --host 127.0.0.1 --port 5181 --strictPort) >"$run/dashboard.log" 2>&1 &
echo "dashboard $!" >>"$run/pids"
(cd "$root/packages/node" && PQI_PUBLISHED="$root/deployments/testnet.json" PQI_PORT=8404 exec ./node_modules/.bin/tsx src/serve.ts) >"$run/desk.log" 2>&1 &
echo "desk $!" >>"$run/pids"
(cd "$root/packages/node" && PQI_PUBLISHED="$root/deployments/testnet-pass2.json" PQI_PORT=8405 exec ./node_modules/.bin/tsx src/serve.ts) >"$run/desk-pass2.log" 2>&1 &
echo "desk-pass2 $!" >>"$run/pids"

for url in http://127.0.0.1:4183/ http://127.0.0.1:5181/ http://127.0.0.1:8404/api/info http://127.0.0.1:8405/api/info; do
  for _ in $(seq 1 75); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 0.2; done
  curl -fsS -o /dev/null "$url" || { echo "not up: $url" >&2; exit 1; }
done
cat "$run/pids"
