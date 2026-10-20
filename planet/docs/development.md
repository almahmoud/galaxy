# Development

## Repository layout

Planet's code is under `client/src/planet/` and `planet/`, with two Vite configurations next to
Galaxy's in `client/`. Read [architecture.md](architecture.md) before changing it.

| Path | Contents |
| --- | --- |
| `client/src/planet/api` | Service Worker handlers for Galaxy's API routes |
| `client/src/planet/backup` | Encrypted snapshots and restore |
| `client/src/planet/boot` | Boot gate of `index.html` |
| `client/src/planet/db` | IndexedDB schema, migrations, repositories, leader fence |
| `client/src/planet/install` | Tool Shed and GitHub tool installation |
| `client/src/planet/jobs` | Job manager: manifests, Kubernetes Job specs, monitoring, ingest, container resolution |
| `client/src/planet/k8s`, `s3` | Gateway client; SigV4 S3 client and bucket setup check |
| `client/src/planet/leader` | Entry of the leader tab |
| `client/src/planet/sw` | Service Worker lifecycle, router, responses, CSP |
| `client/src/planet/tools` | Tool forms, parameters, submission, batch and map-over, collection operations |
| `client/src/planet/ui` | Welcome and setup page (Vue) |
| `client/src/planet/upload` | Page-side uploads to the bucket, replacing Galaxy's tus module |
| `client/src/planet/util` | Shared helpers |
| `client/vite.config.planet.mjs`, `client/vite.config.planet-sw.mjs` | Builds of the client, and of the Service Worker and boot script |
| `planet/deploy` | Kustomize manifests, kind configuration, gateway and network policy tests |
| `planet/docs` | Documentation |
| `planet/runtime` | `planet-runtime` image: Dockerfile, `planet_runtime` package, locked requirements, JSON Schemas, tests |
| `planet/scripts` | Site build, local server, configuration and data generators, kind cluster, browser tests |
| `planet/site` | `index.html`, `welcome.html`, `_headers`, `worker.js`, `wrangler.jsonc` |
| `planet/tests/e2e` | Playwright tests |
| `planet/toolbox` | Built-in toolbox (`toolbox.yml`) and the tool bundle schema |
| `planet/build`, `planet/dist` | Generated files and the built site (not tracked) |

## Requirements

- Node.js 22 (`client/.node_version`) and pnpm 10.26.1 (`packageManager` in `client/package.json`).
- Docker, for the runtime image, the data generators and the browser tests.
- kubectl 1.30 or later and kind 0.33.0 for a local cluster; python3 3.10 or later for the network
  policy test; curl 7.75 or later for the gateway test.

## Building

Run these from the repository root.

```sh
(cd client && pnpm install --frozen-lockfile)

# Runtime image and its test stage
docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
docker build -f planet/runtime/Dockerfile --target test -t planet-runtime:test .

# Datatypes, genomes and the built-in toolbox into planet/build/generated
planet/scripts/generate-data.sh                  # --skip-toolbox: datatypes and genomes only, no network

# The site into planet/dist
PLANET_ALLOW_UNPINNED_RUNTIME=1 PLANET_RUNTIME_IMAGE=planet-runtime:dev node planet/scripts/build-site.mjs

# Serve planet/dist on http://127.0.0.1:8787 as Workers Static Assets serves it
node planet/scripts/serve-dist.mjs
```

`generate-data.sh` runs the generators in `planet-runtime:dev` and validates the tool bundles in
`planet-runtime:test` (`--image` and `--test-image` choose others). Toolbox downloads are cached in
`planet/build/cache/`; `GITHUB_TOKEN` raises the GitHub API rate limit.

`build-site.mjs` needs `PLANET_RUNTIME_IMAGE` with a digest, as `image@sha256:<digest>`, unless
`PLANET_ALLOW_UNPINNED_RUNTIME=1`; images without a digest are then pulled `IfNotPresent`. With
`--verbose` it prints the output of each step; otherwise the logs are in `planet/build/logs/`.

After changing Galaxy package dependencies, regenerate the runtime image's hash-locked requirements
with `planet/runtime/scripts/lock.sh`. [planet-runtime](../runtime/README.md) describes
multi-architecture builds and the image layout.

## Tests

| Suite | Command | Needs |
| --- | --- | --- |
| Client unit tests | `cd client && ./node_modules/.bin/vitest run src/planet` | |
| Type check | `cd client && ./node_modules/.bin/vue-tsc --noEmit -p tsconfig.json` | |
| Lint and format | `cd client && ./node_modules/.bin/eslint -c .eslintrc.js <files>` and `./node_modules/.bin/prettier --check <files>` | |
| Static host script | `node --test planet/site/worker.test.mjs` | |
| Runtime | `docker run --rm planet-runtime:test` | Docker |
| Runtime with the Tool Shed | `docker run --rm -e PLANET_NETWORK_TESTS=1 planet-runtime:test` | Docker, internet |
| Tool wrapper | `planet/runtime/tests/integration/run-tool.sh planet-runtime:dev` | Docker |
| Gateway | `planet/deploy/tests/gateway-test.sh` | Docker, openssl, python3, curl |
| Network policies | `python3 planet/deploy/tests/network-policy-test.py` | kubectl, no cluster |
| Browser | `planet/scripts/e2e.sh` | Docker |
| Browser with a cluster | `PLANET_E2E_CLUSTER=1 planet/scripts/e2e.sh` | Docker Desktop, kind cluster, port-forward |

The runtime suite runs pytest inside the image without network access and covers the stagers and the
generators. The gateway test runs the gateway's nginx configuration against a stub API server and a
Garage container. The network policy test renders the overlays and checks which connections their
policies admit.

`e2e.sh` builds `planet/dist` when it is missing (`--build` always rebuilds), runs Playwright in a
pinned container with the site served on `127.0.0.1:8787`, and writes the report, screenshots and
server log to `planet/build/e2e/`. Without `PLANET_E2E_CLUSTER=1` the cluster tests are skipped. For
the cluster tests, start the cluster, load the runtime image and keep the port-forward running:

```sh
planet/scripts/dev-cluster.sh up
kind load docker-image planet-runtime:dev --name planet
planet/scripts/dev-cluster.sh port-forward &
PLANET_E2E_CLUSTER=1 planet/scripts/e2e.sh
```

[`planet/tests/e2e/README.md`](../tests/e2e/README.md) describes each scenario and how the tests keep
the cluster credentials out of their output.

## Conventions

- Keep the [invariants](architecture.md#invariants). New code goes in `client/src/planet/` or
  `planet/`; change Galaxy's own files only where no Vite seam works
  ([upstream mergeability](architecture.md#upstream-mergeability)).
- Port Galaxy's behaviour from its source: name the Galaxy function in a comment, and return
  Galaxy's error messages and codes (`client/src/planet/util/errors.ts`).
- Galaxy's Python runs only in the `planet-runtime` image: the stagers, the data generators and the
  runtime tests.
- A change to the job protocol updates the schemas in `planet/runtime/schemas/`,
  [job-protocol.md](job-protocol.md) and both sides. Bump `LEADER_PROTOCOL` in
  `client/src/planet/jobs/leader.ts` when a leader of an older build would misread the new jobs.
- A change to IndexedDB stores or indexes goes in `client/src/planet/db/migrations.ts` with a new
  `DB_VERSION`, and in `PAYLOAD_MIGRATIONS` in `client/src/planet/backup/payload.ts`, which rewrites
  snapshots of the previous version.
- Tests sit next to the code, in `*.test.ts` files or `__tests__/` directories. Every fix comes with a
  test that fails without it.
- TypeScript, Vue and JavaScript follow the client's ESLint and Prettier configuration; Python follows
  the repository's Black and Ruff configuration (`pyproject.toml`, line length 120).
- Pin Planet's dependencies to exact versions: npm packages in `client/package.json` with its
  lockfile, Python packages through `lock.sh`, container images by digest.
