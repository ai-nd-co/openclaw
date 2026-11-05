#!/usr/bin/env bash
set -euo pipefail
image="${1:?Pass the newly built image}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-$$"
network="browser-relay-smoke-$suffix"
hub="browser-hub-smoke-$suffix"
relay="browser-relay-smoke-$suffix"
token="synthetic-ci-only-browser-relay-token-0001"
cleanup() {
  docker rm -f "$relay" "$hub" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT
[ "$(docker image inspect --format '{{.Config.User}}' "$image")" = node ]
docker network create --internal "$network" >/dev/null
docker create --name "$hub" --network "$network" --network-alias hub \
  -e SMOKE_RELAY_TOKEN="$token" --entrypoint node "$image" /app/smoke-hub.mjs >/dev/null
docker cp "$script_dir/smoke-hub.mjs" "$hub:/app/smoke-hub.mjs"
docker start "$hub" >/dev/null
docker run --rm -i --network "$network" -e PROBE_ORIGIN=http://hub:8081 -e PROBE_PATH=/healthz \
  --entrypoint node "$image" --input-type=module - < "$script_dir/smoke-probe.mjs"
start_relay() {
  docker run -d --name "$relay" --network "$network" --network-alias relay \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -e HUB_ORIGIN=https://hub.example -e HUB_CONNECT_ORIGIN=http://hub:8081 \
    -e HUB_RELAY_ORIGIN=https://browser.example -e HUB_RELAY_TOKEN="$token" "$image" >/dev/null
  docker run --rm -i --network "$network" -e PROBE_ORIGIN=http://relay:8080 -e PROBE_SOCKETS=1 \
    --entrypoint node "$image" --input-type=module - < "$script_dir/smoke-probe.mjs"
}
start_relay
docker stop --time 10 "$relay" >/dev/null
[ "$(docker inspect --format '{{.State.ExitCode}}' "$relay")" = 0 ]
docker rm "$relay" >/dev/null
start_relay
docker stop --time 5 "$hub" >/dev/null
[ "$(timeout 30 docker wait "$relay")" = 1 ]
printf '%s\n' 'Non-root/read-only image: readiness, bad-ticket rejection, SIGTERM and authority-loss smoke passed'
