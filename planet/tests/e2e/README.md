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
