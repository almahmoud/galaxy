#!/bin/sh
# Regenerate the hash-locked requirement files in requirements/.
# Run from the repository root: planet/runtime/scripts/lock.sh
set -eu

PYTHON_IMAGE="python:3.14.7-slim-trixie@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d"
UV_VERSION="0.9.8"

root=$(pwd)
[ -d "$root/packages/data" ] || { echo "run from the repository root" >&2; exit 1; }

docker run --rm \
    -v "$root/lib:/galaxy/lib:ro" \
    -v "$root/packages:/galaxy/packages:ro" \
    -v "$root/planet/runtime/requirements:/req" \
    "$PYTHON_IMAGE" sh -eu -c "
        pip install --quiet --root-user-action=ignore 'uv==$UV_VERSION'
        mkdir /tmp/galaxy && cp -a /galaxy/lib /galaxy/packages /tmp/galaxy/
        for p in /tmp/galaxy/packages/*/; do printf 'graft src\nglobal-exclude *.py[cod]\n' > \"\$p/MANIFEST.in\"; done
        sed 's#file:///galaxy/packages#file:///tmp/galaxy/packages#' /req/runtime.in > /tmp/runtime.in
        common='--universal --python-version 3.14 --generate-hashes --no-header --quiet'
        uv pip compile \$common \
            --no-emit-package galaxy-util --no-emit-package galaxy-tool-util-models \
            --no-emit-package galaxy-config --no-emit-package galaxy-schema \
            --no-emit-package galaxy-tool-util --no-emit-package galaxy-files \
            --no-emit-package galaxy-objectstore --no-emit-package galaxy-data \
            --no-emit-package galaxy-job-execution \
            /tmp/runtime.in -o /req/runtime.txt
        uv pip compile \$common /req/build.in -o /req/build.txt
        uv pip compile \$common -c /req/runtime.txt /req/test.in -o /req/test.txt
    "
