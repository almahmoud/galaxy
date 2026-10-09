#!/usr/bin/env bash
# Generate Planet's static Galaxy data (datatypes, genomes, toolbox) into planet/build/generated/.
#
# Usage: planet/scripts/generate-data.sh [--image IMAGE] [--skip-toolbox] [--skip-validation]
#
# The generators run in a container built from Galaxy's job-execution recipe, with this
# checkout's lib/ first on PYTHONPATH so the payloads match this commit. The toolbox step
# downloads tool sources from GitHub; downloads are cached in planet/build/cache/.
#
# Environment:
#   PLANET_GENERATE_IMAGE         image (default quay.io/galaxyproject/galaxy-job-execution:26.2.dev0)
#   PLANET_VISUALIZATION_PLUGINS  comma-separated visualization plugins the site serves
#   GITHUB_TOKEN                  optional, raises the GitHub API rate limit
set -euo pipefail

image="${PLANET_GENERATE_IMAGE:-quay.io/galaxyproject/galaxy-job-execution:26.2.dev0}"
skip_toolbox=0
skip_validation=0
while [ $# -gt 0 ]; do
    case "$1" in
        --image) image="$2"; shift 2 ;;
        --skip-toolbox) skip_toolbox=1; shift ;;
        --skip-validation) skip_validation=1; shift ;;
        -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
build_dir="$repo_root/planet/build"
mkdir -p "$build_dir/generated" "$build_dir/cache"

docker_env=(
    -e HOME=/tmp
    -e PYTHONPATH=/src/lib:/src/planet/runtime:/tmp/pydeps
    -e PYTHONDONTWRITEBYTECODE=1
    -e PYTHONHASHSEED=0
    -e SKIP_TOOLBOX="$skip_toolbox"
    -e SKIP_VALIDATION="$skip_validation"
    -e VISUALIZATION_PLUGINS="${PLANET_VISUALIZATION_PLUGINS:-}"
)
if [ -n "${GITHUB_TOKEN:-}" ]; then
    docker_env+=(-e GITHUB_TOKEN)
fi

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$repo_root":/src:ro \
    -v "$build_dir":/out \
    -w /tmp \
    "${docker_env[@]}" \
    "$image" \
    sh -eu -c '
pip_install() {
    pip install --quiet --disable-pip-version-check --no-deps --require-hashes --target /tmp/pydeps -r "$1"
}
if ! python -c "import edam_ontology" 2>/dev/null; then
    # Version pinned in lib/galaxy/dependencies/pinned-requirements.txt.
    printf "%s\n" "edam-ontology==1.25.3 --hash=sha256:cdea906b7885b5e553e924425ba4fb708826dfcb8a2cf186af57725998fcf8c5" > /tmp/edam.txt
    pip_install /tmp/edam.txt
fi
data=/out/generated/static/planet/data
python -m planet_runtime.generate.datatypes "$data/datatypes" --visualization-plugins "$VISUALIZATION_PLUGINS"
python -m planet_runtime.generate.genomes "$data/genomes.json"
if [ "$SKIP_TOOLBOX" = 0 ]; then
    python -m planet_runtime.generate.toolbox \
        --config /src/planet/toolbox/toolbox.yml --out /out/generated --cache /out/cache/github
    if [ "$SKIP_VALIDATION" = 0 ]; then
        if ! python -c "import jsonschema" 2>/dev/null; then
            pip_install /src/planet/runtime/requirements/test.txt
        fi
        python -m planet_runtime.generate.validate --schema /src/planet/toolbox/tool-bundle.schema.json \
            "$data/toolbox/bundles"
    fi
fi
'
