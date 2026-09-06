#!/usr/bin/env bash
# Builds whatever is checked out here, serves it the way GitHub Pages will, and runs the
# production check against it. Serve and kill in one command, so this leaves no port behind
# for the next agent's `reuseExistingServer` to attach to silently.
#
# Port 4919 rather than 4173: a dozen worktrees share this machine and 4173 is usually held
# by somebody else's build. AGENTS.md, "a port ... is anything else two of you could pick
# independently and both believe you own".
set -u
cd /Users/maui/Projects/flights || exit 2
PORT=4919
DIR=${1:-build}

echo "--- clean build (a stale .svelte-kit reproduces hydration bugs that are not real)"
rm -rf .svelte-kit build
pnpm build >/tmp/orch-local-build.log 2>&1 || { echo "BUILD FAILED, see /tmp/orch-local-build.log"; tail -20 /tmp/orch-local-build.log; exit 1; }

node tests/e2e/support/static-server.mjs "$DIR" "$PORT" >/tmp/orch-local-server.log 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT INT TERM

for i in $(seq 1 40); do
  curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://localhost:$PORT/" >/dev/null 2>&1 || { echo "SERVER NEVER CAME UP on $PORT"; cat /tmp/orch-local-server.log; exit 1; }

# localhost, not 127.0.0.1: a preview server here has bound IPv6-only before.
echo "--- verifying http://localhost:$PORT"
node tools/verify-production.mjs "http://localhost:$PORT"
rc=$?
kill $server 2>/dev/null
exit $rc
