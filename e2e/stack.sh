#!/usr/bin/env bash
# Starts the Yaksok stack the way a user runs it, bound to 127.0.0.1, and records every PID in .run/pids.
#   ./stack.sh        rebuild the landing from the records, build the dashboard, assemble site/
#                     (the landing with the terminal at terminal/, as a static host serves it), then serve:
#                     site 4183 (static: landing at /, terminal at /terminal/), dashboard 5181 (vite preview),
#                     desk 8404 (PQI_PUBLISHED=deployments/testnet.json, the Oct 20 run),
#                     desk 8405 (PQI_PUBLISHED=deployments/testnet-pass2.json, pass 2)
#                     Ports: YAKSOK_LANDING_PORT, YAKSOK_TERMINAL_PORT, YAKSOK_DESK_PORT, YAKSOK_DESK2_PORT
#                     (the tests read the same variables). A port already in use is refused: the
#                     stack never answers health checks with another program's server.
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

LP="${YAKSOK_LANDING_PORT:-4183}"; TP="${YAKSOK_TERMINAL_PORT:-5181}"; DP="${YAKSOK_DESK_PORT:-8404}"; D2P="${YAKSOK_DESK2_PORT:-8405}"
for p in "$LP" "$TP" "$DP" "$D2P"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is already in use by another program; pick free ports with YAKSOK_LANDING_PORT / YAKSOK_TERMINAL_PORT / YAKSOK_DESK_PORT / YAKSOK_DESK2_PORT" >&2
    exit 1
  fi
done

(cd "$root" && node packages/landing/build.mjs >"$run/landing-build.log" 2>&1) || { echo "landing build failed: $run/landing-build.log" >&2; exit 1; }
(cd "$root" && pnpm --filter @pqi/dashboard build >"$run/dashboard-build.log" 2>&1) || { echo "dashboard build failed: $run/dashboard-build.log" >&2; exit 1; }
(cd "$root" && node packages/landing/site.mjs >"$run/site-build.log" 2>&1) || { echo "site build failed: $run/site-build.log" >&2; exit 1; }

python3 -m http.server "$LP" --bind 127.0.0.1 -d "$root/site" >"$run/landing.log" 2>&1 &
echo "landing $!" >>"$run/pids"
(cd "$root/packages/dashboard" && exec ./node_modules/.bin/vite preview --host 127.0.0.1 --port "$TP" --strictPort) >"$run/dashboard.log" 2>&1 &
echo "dashboard $!" >>"$run/pids"
(cd "$root/packages/node" && PQI_PUBLISHED="$root/deployments/testnet.json" PQI_PORT="$DP" exec ./node_modules/.bin/tsx src/serve.ts) >"$run/desk.log" 2>&1 &
echo "desk $!" >>"$run/pids"
(cd "$root/packages/node" && PQI_PUBLISHED="$root/deployments/testnet-pass2.json" PQI_PORT="$D2P" exec ./node_modules/.bin/tsx src/serve.ts) >"$run/desk-pass2.log" 2>&1 &
echo "desk-pass2 $!" >>"$run/pids"

for url in "http://127.0.0.1:$LP/" "http://127.0.0.1:$TP/" "http://127.0.0.1:$DP/api/info" "http://127.0.0.1:$D2P/api/info"; do
  for _ in $(seq 1 75); do curl -fsS -o /dev/null "$url" 2>/dev/null && break; sleep 0.2; done
  curl -fsS -o /dev/null "$url" || { echo "not up: $url" >&2; exit 1; }
done
cat "$run/pids"
