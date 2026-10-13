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
- `screenshots/`: named full-page screenshots (Galaxy home, welcome page at 1440x900 and 390x844, histories list, tool panel).
- `results/`: per-test artifacts; `results.json`: machine-readable results; `server.log`: requests the site server answered.

The `health` fixture watches each test's page and fails the test on uncaught page errors, console errors, Galaxy error toasts, and `/api` or `/context` responses that lack `X-Request-ID`, are HTML, or do not come from the Service Worker. Expected console errors are listed with their reason in `BENIGN_CONSOLE_ERRORS` in `tests/fixtures.ts`, or allowed in the test that causes them.

The image tag in `planet/scripts/e2e.sh` and `@playwright/test` in `package.json` carry the same version. After changing `package.json`, regenerate `package-lock.json` in the image:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/planet/tests/e2e:/e2e" -w /e2e <image> \
    npm install --package-lock-only --ignore-scripts
```

## Cluster test

`tests/cluster.spec.ts` uses Planet as a user would against the local kind cluster: it saves the cluster and Local Garage settings on the welcome page, runs both connection tests, uploads a tabular and a FASTA file, runs Datamash, opens the output and its job information, runs Datamash with a field the input lacks and checks the error, and checks that the Kubernetes Jobs and pods are gone. It is skipped unless `PLANET_E2E_CLUSTER=1`:

```sh
planet/scripts/dev-cluster.sh up
docker build -f planet/runtime/Dockerfile -t planet-runtime:dev .
kind load docker-image planet-runtime:dev --name planet
planet/scripts/dev-cluster.sh port-forward &
PLANET_E2E_CLUSTER=1 planet/scripts/e2e.sh
```

`e2e.sh` reads the planet-client token and the Garage keys with `dev-cluster.sh`, passes them to the container as read-only files and deletes them afterwards. Inside the container, `cluster-relay.mjs` listens on 127.0.0.1:8001 and 127.0.0.1:8002, the addresses the page uses, and forwards to the port-forward on the Docker host through `host.docker.internal` (Docker Desktop). The test also writes `cluster-console-*.log` (the page's console) and the upload and job timings to `planet/build/e2e/`. Traces of this test record the token and keys it types; they stay in `planet/build/e2e/`, and the keys belong to the disposable kind cluster.
