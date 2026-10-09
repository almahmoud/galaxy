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
planet-stager wait           # wait for the tool container and print how it ended
```

## Build

From the repository root:

```
docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
```

Multi-architecture images are built with
`docker buildx build --platform linux/amd64,linux/arm64 ...`. The image runs as uid
10001 and works with a read-only root filesystem when `/planet` is a writable
volume. Galaxy files that no package ships (`galaxy/tools/wrappers.py`,
`data_fetch.py`, `parameters/sanitize.py`, `parameters/wrapped_json.py`, the
job script templates and `datatypes_conf.xml.sample`) are copied unmodified
to `/opt/planet/galaxy/lib`.

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

The pytest suite runs inside the image. `run-tool.sh` runs the tool wrapper as
PID 1 of a busybox container next to a waiting stage-out container, covering
normal and failing exits, the walltime and a killed container.
