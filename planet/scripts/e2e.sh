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
#   PLANET_E2E_TRACE    Playwright trace mode (default retain-on-failure)
#   PLANET_E2E_WORKERS  parallel workers (default 2)
set -euo pipefail

# Keep the tag and @playwright/test in planet/tests/e2e/package.json on the same version.
default_image="mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"
image="${PLANET_E2E_IMAGE:-$default_image}"

build=0
if [ "${1:-}" = "--build" ]; then
    build=1
    shift
elif [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
planet_dir="$repo_root/planet"
out_dir="$planet_dir/build/e2e"

if [ "$build" = 1 ] || [ ! -f "$planet_dir/dist/index.html" ]; then
    node "$planet_dir/scripts/build-site.mjs"
fi

mkdir -p "$out_dir"
find "$out_dir" -mindepth 1 -delete

container="planet-e2e-$$"
cleanup() {
    docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# npm and the browsers need a writable HOME; node_modules lives in the container only.
container_script='
set -eu
mkdir -p /tmp/home /tmp/e2e
tar -C /src/e2e --exclude=./node_modules -cf - . | tar -C /tmp/e2e -xf -
cd /tmp/e2e
npm ci --no-audit --no-fund --loglevel=error
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
    -e PLANET_E2E_TRACE="${PLANET_E2E_TRACE:-retain-on-failure}" \
    -e PLANET_E2E_WORKERS="${PLANET_E2E_WORKERS:-2}" \
    -v "$planet_dir/dist:/repo/planet/dist:ro" \
    -v "$planet_dir/site:/repo/planet/site:ro" \
    -v "$planet_dir/scripts:/repo/planet/scripts:ro" \
    -v "$planet_dir/tests/e2e:/src/e2e:ro" \
    -v "$out_dir:/out" \
    "$image" \
    sh -c "$container_script" planet-e2e "$@" || status=$?

echo "Report: $out_dir/report/index.html"
exit "$status"
