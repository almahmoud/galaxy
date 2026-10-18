#!/usr/bin/env bash
# Run the browser tests in planet/tests/e2e against planet/dist.
#
# Usage: planet/scripts/e2e.sh [--build] [playwright test arguments...]
#
# The tests run in the Playwright container image with the site served by
# planet/scripts/serve-dist.mjs on http://127.0.0.1:8787 inside the container.
# planet/dist, planet/site, planet/scripts and planet/tests/e2e are mounted
# read-only; the HTML report, traces, screenshots and the server log are written
# to planet/build/e2e/. planet/dist is built first when it is missing, or always
# with --build.
#
# Environment:
#   PLANET_E2E_IMAGE    image (default: the pinned mcr.microsoft.com/playwright image)
#   PLANET_E2E_TRACE    Playwright trace mode (default retain-on-failure; off with
#                       PLANET_E2E_CLUSTER=1, because traces record the credentials)
#   PLANET_E2E_WORKERS  parallel workers (default 2)
#   PLANET_E2E_CLUSTER  1 runs tests/cluster.spec.ts (unless tests are named) against the
#                       kind cluster of planet/scripts/dev-cluster.sh, whose port-forward must
#                       be running; the token and Garage keys are passed in a file under
#                       planet/build that is removed afterwards, and output files that
#                       contain them are deleted
set -euo pipefail

# Keep the tag and @playwright/test in planet/tests/e2e/package.json on the same version.
default_image="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"
image="${PLANET_E2E_IMAGE:-$default_image}"

build=0
if [ "${1:-}" = "--build" ]; then
    build=1
    shift
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
planet_dir="$repo_root/planet"
out_dir="$planet_dir/build/e2e"

if [ "$build" = 1 ] || [ ! -f "$planet_dir/dist/index.html" ]; then
    # The kind cluster runs the node-local planet-runtime:dev, which has no digest.
    PLANET_ALLOW_UNPINNED_RUNTIME="${PLANET_ALLOW_UNPINNED_RUNTIME:-1}" node "$planet_dir/scripts/build-site.mjs"
fi

mkdir -p "$out_dir"
find "$out_dir" -mindepth 1 -delete

container="planet-e2e-$$"
secrets_dir="$planet_dir/build/e2e-secrets-$$"

# Deletes output files that may hold the cluster token or the Garage secret key:
# page snapshots of failed tests (they include password field values) and any
# file that contains either value. Compressed traces are kept only when
# PLANET_E2E_TRACE asked for them.
scrub_secrets() {
    [ -s "$secrets_dir/token" ] && [ -s "$secrets_dir/secret-access-key" ] || return 0
    local removed
    removed="$(
        {
            find "$out_dir" -type f -name 'error-context.md' -print
            grep -rlF -f "$secrets_dir/token" -f "$secrets_dir/secret-access-key" "$out_dir" 2>/dev/null || true
        } | sort -u
    )"
    if [ -n "$removed" ]; then
        printf '%s\n' "$removed" | while IFS= read -r file; do rm -f "$file"; done
        echo "Removed $(printf '%s\n' "$removed" | wc -l | tr -d ' ') output file(s) that may contain the cluster credentials." >&2
    fi
}

cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
    scrub_secrets
    rm -rf "$secrets_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

trace="${PLANET_E2E_TRACE:-retain-on-failure}"
cluster_args=()
if [ "${PLANET_E2E_CLUSTER:-0}" = 1 ]; then
    trace="${PLANET_E2E_TRACE:-off}"
    if [ "$trace" != off ]; then
        echo "warning: PLANET_E2E_TRACE=$trace records the cluster token and Garage keys in traces under $out_dir" >&2
    fi
    for port in 8001 8002; do
        if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
            echo "error: nothing listens on 127.0.0.1:$port; run planet/scripts/dev-cluster.sh port-forward" >&2
            exit 1
        fi
    done
    (
        umask 077
        mkdir -p "$secrets_dir"
        "$planet_dir/scripts/dev-cluster.sh" token >"$secrets_dir/token" 2>/dev/null
        storage="$("$planet_dir/scripts/dev-cluster.sh" storage 2>/dev/null)"
        sed -n 's/^access key ID: *//p' <<<"$storage" | tr -d '\n' >"$secrets_dir/access-key-id"
        sed -n 's/^secret access key: *//p' <<<"$storage" | tr -d '\n' >"$secrets_dir/secret-access-key"
    ) || {
        echo "error: cannot read the cluster token and Garage keys with planet/scripts/dev-cluster.sh" >&2
        exit 1
    }
    for name in token access-key-id secret-access-key; do
        [ -s "$secrets_dir/$name" ] || {
            echo "error: planet/scripts/dev-cluster.sh returned no $name" >&2
            exit 1
        }
    done
    cluster_args=(-e PLANET_E2E_CLUSTER=1 -e PLANET_E2E_SECRETS=/secrets -v "$secrets_dir:/secrets:ro")
    if [ $# -eq 0 ]; then
        set -- cluster.spec.ts
    fi
fi

# npm and the browsers need a writable HOME; node_modules lives in the container only.
container_script='
set -eu
mkdir -p /tmp/home /tmp/e2e
tar -C /src/e2e --exclude=./node_modules -cf - . | tar -C /tmp/e2e -xf -
cd /tmp/e2e
npm ci --no-audit --no-fund --loglevel=error
if [ "${PLANET_E2E_CLUSTER:-0}" = 1 ]; then
    node cluster-relay.mjs 8001 8002 >/out/relay.log 2>&1 &
    for _ in $(seq 50); do
        [ "$(grep -c "^relay: 127" /out/relay.log)" = 2 ] && break
        sleep 0.1
    done
fi
exec npx --no-install playwright test "$@"
'

status=0
docker run --rm --init --name "$container" \
    --ipc=host \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp/home \
    -e npm_config_cache=/tmp/npm-cache \
    -e npm_config_update_notifier=false \
    -e CI=1 \
    -e PLANET_REPO_ROOT=/repo \
    -e PLANET_E2E_OUT=/out \
    -e PLANET_E2E_TRACE="$trace" \
    -e PLANET_E2E_WORKERS="${PLANET_E2E_WORKERS:-2}" \
    ${cluster_args[@]+"${cluster_args[@]}"} \
    -v "$planet_dir/dist:/repo/planet/dist:ro" \
    -v "$planet_dir/site:/repo/planet/site:ro" \
    -v "$planet_dir/scripts:/repo/planet/scripts:ro" \
    -v "$planet_dir/tests/e2e:/src/e2e:ro" \
    -v "$out_dir:/out" \
    "$image" \
    sh -c "$container_script" planet-e2e "$@" || status=$?

echo "Report: $out_dir/report/index.html"
exit "$status"
