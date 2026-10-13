# syntax=docker/dockerfile:1
# planet-runtime: Galaxy's job execution libraries from this checkout plus the
# Planet stager and static data generators. Based on packages/job_execution/Dockerfile
# (RUNTIME_SOURCE=source).
# Build from the repository root:
#   docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
ARG PYTHON_IMAGE=python:3.14.7-slim-trixie@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d

FROM ${PYTHON_IMAGE} AS build-base
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 PIP_ROOT_USER_ACTION=ignore
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && python -m venv /venv
COPY planet/runtime/requirements/ /tmp/requirements/
RUN /venv/bin/pip install --require-hashes --no-deps -r /tmp/requirements/build.txt

FROM build-base AS build
RUN /venv/bin/pip install --require-hashes --no-deps --no-build-isolation -r /tmp/requirements/runtime.txt
COPY lib /galaxy/lib
COPY packages /galaxy/packages
# setuptools-scm cannot discover package data without the Git checkout.
RUN for package in util tool_util_models config schema tool_util files objectstore data job_execution; do \
        printf 'graft src\nglobal-exclude *.py[cod]\n' > /galaxy/packages/$package/MANIFEST.in; \
    done \
    && /venv/bin/pip install --no-deps --no-build-isolation \
        /galaxy/packages/util \
        /galaxy/packages/tool_util_models \
        /galaxy/packages/config \
        /galaxy/packages/schema \
        /galaxy/packages/tool_util \
        /galaxy/packages/files \
        /galaxy/packages/objectstore \
        /galaxy/packages/data \
        /galaxy/packages/job_execution
COPY tools /galaxy/tools
COPY tool-data/shared/ucsc/builds.txt.sample /galaxy/tool-data/shared/ucsc/builds.txt.sample
# Galaxy files the stager and the generators load that are not part of any Galaxy
# package, in a partial Galaxy root (GALAXY_INCLUDES_ROOT).
RUN set -eu; cd /galaxy; \
    for path in \
        lib/galaxy/tools/wrappers.py \
        lib/galaxy/tools/data_fetch.py \
        lib/galaxy/tools/parameters/wrapped_json.py \
        lib/galaxy/tools/parameters/sanitize.py \
        lib/galaxy/tools/parameters/validation.py \
        lib/galaxy/jobs/runners/util/job_script/DEFAULT_JOB_FILE_TEMPLATE.sh \
        lib/galaxy/jobs/runners/util/job_script/CLUSTER_SLOTS_STATEMENT.sh \
        lib/galaxy/jobs/runners/util/job_script/MEMORY_STATEMENT_TEMPLATE.sh \
        lib/galaxy/config/sample/datatypes_conf.xml.sample \
        lib/galaxy/managers/__init__.py \
        lib/galaxy/managers/datatypes.py \
        lib/galaxy/managers/dbkeys.py \
        tool-data/shared/ucsc/builds.txt.sample; \
    do install -D -m 0644 "$path" "/opt/planet/galaxy/$path"; done; \
    cp -R tools /opt/planet/galaxy/tools; \
    chmod -R a+rX,go-w /opt/planet/galaxy
COPY planet/runtime/pyproject.toml /src/planet-runtime/pyproject.toml
COPY planet/runtime/planet_runtime /src/planet-runtime/planet_runtime
RUN /venv/bin/pip install --no-deps --no-build-isolation /src/planet-runtime \
    && /venv/bin/pip check \
    && /venv/bin/pip uninstall -y pip wheel setuptools-scm vcs-versioning
# Bytecode that is used without checking the source: the image is immutable, its root filesystem may be
# read-only and uid 10001 cannot write __pycache__, so stale or missing bytecode would be compiled on every start.
RUN /venv/bin/python -W ignore -m compileall -q -f -j 0 --invalidation-mode unchecked-hash \
        -x '/fissix/tests/data/' /venv /opt/planet/galaxy/lib

FROM build-base AS test-deps
RUN /venv/bin/pip install --require-hashes --no-deps --target /opt/planet-test -r /tmp/requirements/test.txt

FROM ${PYTHON_IMAGE} AS runtime
ARG GIT_COMMIT=unspecified
ARG BUILD_DATE=unspecified
LABEL org.opencontainers.image.title="planet-runtime" \
      org.opencontainers.image.description="Planet job pod runtime: Galaxy job execution libraries and the Planet stager" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/almahmoud/galaxy" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PATH="/venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONNOUSERSITE=1 \
    PYTHONUNBUFFERED=1 \
    PYDANTIC_DISABLE_PLUGINS=__all__ \
    PLANET_GALAXY_LIB=/opt/planet/galaxy/lib \
    GALAXY_INCLUDES_ROOT=/opt/planet/galaxy \
    HOME=/planet-stager/home \
    TMPDIR=/planet/tmp \
    XDG_CACHE_HOME=/planet-stager/cache
# The Python image ships the standard library without bytecode.
RUN apt-get update && apt-get install -y --no-install-recommends libmagic1t64 libgomp1 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/python3.*/site-packages/pip /usr/local/lib/python3.*/site-packages/pip-* /usr/local/bin/pip* \
    && python -W ignore -m compileall -q -f -j 0 --invalidation-mode unchecked-hash \
        "$(python -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')" \
    && groupadd --gid 10001 planet \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /planet-stager/home --shell /usr/sbin/nologin planet
COPY --from=build /venv /venv
COPY --from=build /opt/planet /opt/planet
RUN HOME=/tmp TMPDIR=/tmp XDG_CACHE_HOME=/tmp/planet-build-cache python -c "\
import pysam, h5py; \
from galaxy.datatypes import sniff; sniff.guess_ext('/etc/hostname', []); \
from galaxy.metadata.set_metadata import set_metadata; \
from planet_runtime import galaxy_env; galaxy_env.install(); galaxy_env.data_fetch(); galaxy_env.registry(); \
from planet_runtime.generate import datatypes, genomes, toolbox; datatypes.load_registry()" \
    && rm -rf /tmp/planet-build-cache \
    && mkdir -p /etc/planet \
    && python -c "from importlib.metadata import distributions; print('\n'.join(sorted(d.metadata['Name'] + '==' + d.version for d in distributions())))" > /etc/planet/requirements.txt
USER 10001:10001
WORKDIR /
CMD ["planet-stager", "--help"]

FROM runtime AS test
COPY --from=test-deps /opt/planet-test /opt/planet-test
# The generator tests build bundles for Galaxy's own tools and check them against the bundle schema.
COPY test/functional/tools /opt/planet/galaxy/test/functional/tools
COPY planet/toolbox/tool-bundle.schema.json /opt/planet/galaxy/planet/toolbox/tool-bundle.schema.json
COPY planet/runtime/tests /src/planet-runtime/tests
COPY planet/runtime/schemas /src/planet-runtime/schemas
COPY planet/runtime/pyproject.toml /src/planet-runtime/pyproject.toml
ENV PYTHONPATH=/opt/planet-test PLANET_SCHEMAS=/src/planet-runtime/schemas \
    HOME=/tmp TMPDIR=/tmp XDG_CACHE_HOME=/tmp/planet-cache
WORKDIR /src/planet-runtime
CMD ["python", "-m", "pytest", "-p", "no:cacheprovider", "-q"]

FROM runtime
