# planet-runtime

Image for the containers of Planet job pods. It holds Galaxy's job execution
libraries, installed from this checkout so pods run the same Galaxy code the
Planet client was built from, and `planet-stager`, which implements the
[job protocol](../docs/job-protocol.md).

```
planet-stager in             # stage-in init container of a tool job
planet-stager out            # stage-out container of a tool job
planet-stager upload         # Galaxy data fetch and finishing of uploads
planet-stager set-metadata   # Galaxy __SET_METADATA__ jobs
planet-stager install        # install the tools of a Tool Shed or GitHub repository
planet-stager wait           # wait for the tool container and print how it ended
```

## Build

From the repository root:

```
docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
```

Multi-architecture images are built with
`docker buildx build --platform linux/amd64,linux/arm64 ...`. The image runs as uid
10001 and works with a read-only root filesystem when `/planet` and
`/planet-stager` are writable volumes. Galaxy files that no package ships are copied unmodified to
`/opt/planet/galaxy`, a partial Galaxy root (`GALAXY_INCLUDES_ROOT`):
`galaxy/tools/wrappers.py`, `data_fetch.py`, `parameters/sanitize.py`,
`parameters/validation.py`, `parameters/wrapped_json.py`, the job script templates,
`datatypes_conf.xml.sample`, `galaxy/managers/datatypes.py` and `dbkeys.py`
and the collection operation tools the Service Worker carries out (`galaxy/tools/*_collection*.xml`)
under `lib/`, Galaxy's `tools/` and `tool-data/shared/ucsc/builds.txt.sample`.

Every module the stagers import, the standard library included, is compiled at
build time with `--invalidation-mode unchecked-hash`: the image is never
modified, so Python uses the bytecode without checking the sources, and a
read-only root filesystem or uid 10001 never leads to compiling on each start.
Mounting an edited source file over one in the image therefore has no effect;
mount whole package directories or rebuild. Importing Galaxy's model still takes a few seconds per process, so stage-in
starts its template process before the downloads and the stagers exit without
the interpreter's teardown.

## Static data generators

`planet_runtime.generate` produces the datatype, genome and toolbox files the
site serves; `planet/scripts/generate-data.sh` runs it in this image, so the data
and the job pods come from the same Galaxy code. Tool bundles are validated
against `planet/toolbox/tool-bundle.schema.json` in the test stage, the only
stage with `jsonschema`.

## Dependencies

Third-party dependencies are installed with `pip --require-hashes` from
`requirements/*.txt`, which are generated from the Galaxy packages'
`pyproject.toml` files and `requirements/*.in` for every platform:

```
planet/runtime/scripts/lock.sh
```

Run it from the repository root after changing Galaxy package dependencies.

## Tests

```
docker build -f planet/runtime/Dockerfile --target test -t planet-runtime:test .
docker run --rm planet-runtime:test
planet/runtime/tests/integration/run-tool.sh planet-runtime:dev
```

The pytest suite runs inside the image and covers the stager (`tests/`) and the
generators (`tests/generate/`), without network access; `docker run --rm -e
PLANET_NETWORK_TESTS=1 planet-runtime:test` adds a tool installation from the main
Tool Shed; the test stage adds Galaxy's
`test/functional/tools` and the bundle schema to the Galaxy root. `run-tool.sh`
runs the tool wrapper as PID 1 of a busybox container next to a waiting
stage-out container, covering normal and failing exits, the walltime and a
killed container.
