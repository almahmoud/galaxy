#!/usr/bin/env bash
# Generate Planet's static Galaxy data (datatypes, genomes, toolbox) into planet/build/generated/.
#
# Usage: planet/scripts/generate-data.sh [--image IMAGE] [--test-image IMAGE] [--skip-toolbox] [--skip-validation]
#
# The generators run in the planet-runtime image, so the data comes from the same Galaxy code
# as the job pods. Tool bundles are validated in the image's test stage, the only one with
# jsonschema. Build both from the repository root:
#   docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
#   docker build -f planet/runtime/Dockerfile --target test -t planet-runtime:test .
# The toolbox step downloads tool sources from GitHub; downloads are cached in planet/build/cache/.
#
# Environment:
#   PLANET_GENERATE_IMAGE         image running the generators (default planet-runtime:dev)
#   PLANET_TEST_IMAGE             image validating the bundles (default planet-runtime:test)
#   PLANET_VISUALIZATION_PLUGINS  comma-separated visualization plugins the site serves
#   GITHUB_TOKEN                  optional, raises the GitHub API rate limit
set -euo pipefail

image="${PLANET_GENERATE_IMAGE:-planet-runtime:dev}"
test_image="${PLANET_TEST_IMAGE:-planet-runtime:test}"
skip_toolbox=0
skip_validation=0
while [ $# -gt 0 ]; do
    case "$1" in
        --image) image="$2"; shift 2 ;;
        --test-image) test_image="$2"; shift 2 ;;
        --skip-toolbox) skip_toolbox=1; shift ;;
        --skip-validation) skip_validation=1; shift ;;
        -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_dir="$repo_root/planet/build"
toolbox_dir="$repo_root/planet/toolbox"
mkdir -p "$build_dir/generated" "$build_dir/cache"

require_image() {
    if ! docker image inspect "$1" >/dev/null 2>&1 && ! docker pull --quiet "$1" >/dev/null 2>&1; then
        echo "Image $1 is not available. Build it from the repository root with:" >&2
        echo "  $2" >&2
        exit 1
    fi
}

dockerfile="docker build -f planet/runtime/Dockerfile"
require_image "$image" "$dockerfile -t $image ."
validate=0
if [ "$skip_toolbox" = 0 ] && [ "$skip_validation" = 0 ]; then
    require_image "$test_image" "$dockerfile --target test -t $test_image .   (or pass --skip-validation)"
    validate=1
fi

docker_args=(
    --rm
    --user "$(id -u):$(id -g)"
    -v "$toolbox_dir":/toolbox:ro
    -w /tmp
    -e HOME=/tmp
    -e TMPDIR=/tmp
    -e XDG_CACHE_HOME=/tmp/cache
    -e PYTHONDONTWRITEBYTECODE=1
    -e PYTHONHASHSEED=0
)

generate_env=(
    -e SKIP_TOOLBOX="$skip_toolbox"
    -e VISUALIZATION_PLUGINS="${PLANET_VISUALIZATION_PLUGINS:-}"
)
if [ -n "${GITHUB_TOKEN:-}" ]; then
    generate_env+=(-e GITHUB_TOKEN)
fi

docker run "${docker_args[@]}" -v "$build_dir":/out "${generate_env[@]}" "$image" sh -eu -c '
data=/out/generated/static/planet/data
python -m planet_runtime.generate.datatypes "$data/datatypes" --visualization-plugins "$VISUALIZATION_PLUGINS"
python -m planet_runtime.generate.genomes "$data/genomes.json"
if [ "$SKIP_TOOLBOX" = 0 ]; then
    python -m planet_runtime.generate.toolbox --config /toolbox/toolbox.yml --out /out/generated --cache /out/cache/github
fi
'

if [ "$validate" = 1 ]; then
    docker run "${docker_args[@]}" -v "$build_dir/generated":/generated:ro "$test_image" \
        python -m planet_runtime.generate.validate --schema /toolbox/tool-bundle.schema.json \
        /generated/static/planet/data/toolbox/bundles
fi
