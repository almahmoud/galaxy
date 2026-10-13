import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const repoRoot = process.env.PLANET_REPO_ROOT ?? resolve(__dirname, "../../..");
const outDir = process.env.PLANET_E2E_OUT ?? resolve(repoRoot, "planet/build/e2e");
const port = 8787;

type TraceMode = "on" | "off" | "retain-on-failure" | "on-first-retry";
const trace = (process.env.PLANET_E2E_TRACE ?? "retain-on-failure") as TraceMode;

export default defineConfig({
    testDir: "./tests",
    outputDir: resolve(outDir, "results"),
    timeout: 90_000,
    expect: { timeout: 20_000 },
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    retries: 0,
    workers: Number(process.env.PLANET_E2E_WORKERS ?? 2),
    reporter: [
        ["list"],
        ["html", { outputFolder: resolve(outDir, "report"), open: "never" }],
        ["json", { outputFile: resolve(outDir, "results.json") }],
    ],
    use: {
        // Service Workers need a secure context; http://127.0.0.1 is one.
        baseURL: `http://127.0.0.1:${port}`,
        trace,
        screenshot: "only-on-failure",
        viewport: { width: 1440, height: 900 },
    },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
    webServer: {
        command: `mkdir -p "${outDir}" && node "${resolve(repoRoot, "planet/scripts/serve-dist.mjs")}" ${port} --dir "${resolve(repoRoot, "planet/dist")}" > "${resolve(outDir, "server.log")}" 2>&1`,
        url: `http://127.0.0.1:${port}/static/planet/build.json`,
        reuseExistingServer: false,
        timeout: 30_000,
    },
});
