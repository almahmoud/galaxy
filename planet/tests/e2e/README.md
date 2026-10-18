# Planet browser tests

Playwright tests that load the built site (`planet/dist`) in Chromium with its Service Worker, as a user's browser does.

```sh
planet/scripts/e2e.sh                       # all tests; builds planet/dist first if it is missing
planet/scripts/e2e.sh --build               # rebuild planet/dist, then test
planet/scripts/e2e.sh histories -g rename   # further arguments go to playwright test
```

The script runs the pinned Playwright image with the checkout mounted read-only and serves the site with `planet/scripts/serve-dist.mjs` on `http://127.0.0.1:8787` inside the container, a secure context for Service Workers. It exits non-zero when a test fails and removes its container.

Output in `planet/build/e2e/`:

- `report/index.html`: HTML report with screenshots and, for failed tests, traces (`PLANET_E2E_TRACE=on` keeps traces of every test).
- `screenshots/`: named full-page screenshots (Galaxy home, welcome page at 1440x900 and 390x844, job runner states, histories list, tool panel).
- `results/`: per-test artifacts; `results.json`: machine-readable results; `server.log`: requests the site server answered.

The `health` fixture watches each test's page and fails the test on uncaught page errors, console errors, Galaxy error toasts, and `/api` or `/context` responses that lack `X-Request-ID`, are HTML, or do not come from the Service Worker. Expected console errors are listed with their reason in `BENIGN_CONSOLE_ERRORS` in `tests/fixtures.ts`, or allowed in the test that causes them.

The image tag in `planet/scripts/e2e.sh` and `@playwright/test` in `package.json` carry the same version. After changing `package.json`, regenerate `package-lock.json` in the image:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/planet/tests/e2e:/e2e" -w /e2e <image> \
    npm install --package-lock-only --ignore-scripts
```

## Cluster test

`tests/cluster.spec.ts` uses Planet as a user would against the local kind cluster. The first test saves the cluster and Local Garage settings on the welcome page (with 2Gi memory and 8Gi scratch space per job, so that two tool pods fit into the local quota), runs both connection tests, checks that the Job runner card shows the Galaxy tab as active, uploads a tabular and a FASTA file, runs Datamash and checks its output and job information, runs Datamash with a field the input lacks and checks the error, runs Reverse in batch mode over two datasets (two jobs), maps the FASTA file with minimap2 and checks the BAM metadata and index, and purges a dataset and checks that its bucket objects are deleted. The second test stops a running Query Tabular job by deleting its output and checks that the job ends `deleted`, the dataset `discarded` and the Kubernetes Job and pod are gone, then reloads the page while another job runs and checks that the reloaded tab leads again and finishes it. The third test builds a list from two uploads with Galaxy's list builder, maps Reverse over it and checks the implicit list: one job per element, running at the same time, the elements' identifiers and order, and their contents. The fourth searches the main Tool Shed from the overview in Galaxy's center panel, installs `iuc/seqkit_stats`, finds the tool in the panel's Installed tools section, runs it on a FASTA upload and uninstalls it; it needs internet access from the Playwright container and from the cluster. The fifth sets a backup passphrase, writes a snapshot to the bucket, restores it into a new browser context (an empty IndexedDB, as on a new device, taking over the first browser's lease) and checks that the history, its datasets and a dataset's display are back, then runs Datamash on a restored dataset there. The tests check that no Planet Jobs or pods are left. They are skipped unless `PLANET_E2E_CLUSTER=1`:

```sh
planet/scripts/dev-cluster.sh up
docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
kind load docker-image planet-runtime:dev --name planet
planet/scripts/dev-cluster.sh port-forward &
PLANET_E2E_CLUSTER=1 planet/scripts/e2e.sh
```

`e2e.sh` reads the planet-client token and the Garage keys with `dev-cluster.sh`, passes them to the container as read-only files and deletes them afterwards. Inside the container, `cluster-relay.mjs` listens on 127.0.0.1:8001 and 127.0.0.1:8002, the addresses the page uses, and forwards to the port-forward on the Docker host through `host.docker.internal` (Docker Desktop). The tests also write `cluster-console-*.log` (the page's console) and `cluster-timings.json` to `planet/build/e2e/`: the duration of each step and, from a watch on the pods, each pod's stage-in, tool image pull, tool, stage-out and total times. The runtime image setting is left empty when the site was built with `PLANET_RUNTIME_IMAGE=planet-runtime:dev`, so the build's image is used; otherwise the test enters `planet-runtime:dev`.

The credentials are kept out of `planet/build/e2e/`:

- Tracing is off in cluster mode, because traces record typed values, request bodies and headers. `PLANET_E2E_TRACE=retain-on-failure` turns it back on for debugging; those traces contain the token and keys.
- The tests enter the token and the secret key with `fillSecret()`, since `fill()` puts the value into the report's step titles.
- After the run, `e2e.sh` deletes the page snapshots of failed tests (`error-context.md`, which shows password field values) and every other output file that contains the token or the secret key.
