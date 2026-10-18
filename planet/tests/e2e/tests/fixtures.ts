import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import {
    type ConsoleMessage,
    expect,
    type Locator,
    type Page,
    type Response,
    test as base,
    type TestInfo,
} from "@playwright/test";

export { expect };

export const ORIGIN = "http://127.0.0.1:8787";

const outDir = process.env.PLANET_E2E_OUT ?? resolve(__dirname, "../../../build/e2e");

export interface ConsoleAllowance {
    /** Matched against the message text. */
    text: RegExp;
    /** Matched against the URL the message refers to, when given. */
    url?: RegExp;
    /** Why the message is expected; shown in the report. */
    reason: string;
}

/** Console errors a healthy Planet start-up produces. */
export const BENIGN_CONSOLE_ERRORS: ConsoleAllowance[] = [
    {
        text: /^Failed to load resource: the server responded with a status of 403/,
        url: /\/api\/unprivileged_tools(\?|$)/,
        reason:
            "Galaxy answers 403 to users without the custom tools role and the client's unprivileged tool store " +
            "treats it as 'not allowed'; Chrome logs every 4xx resource load.",
    },
];

const TOAST_BINDING = "__planetE2eToast";

/** Reports every Galaxy toast added to the document, including ones that disappear before a check. */
const TOAST_OBSERVER = `(() => {
    const seen = new WeakSet();
    const report = (node) => {
        if (!(node instanceof Element)) return;
        const toasts = node.matches(".g-toast") ? [node] : node.querySelectorAll(".g-toast");
        for (const toast of toasts) {
            if (seen.has(toast)) continue;
            seen.add(toast);
            const variant = [...toast.classList].find((name) => /^g-toast-(success|info|warning|danger)$/.test(name));
            window.${TOAST_BINDING}?.(variant ? variant.slice(8) : "unknown", (toast.textContent || "").trim());
        }
    };
    new MutationObserver((records) => {
        for (const record of records) record.addedNodes.forEach(report);
    }).observe(document, { childList: true, subtree: true });
})();`;

function isBackendPath(pathname: string): boolean {
    return pathname === "/context" || pathname === "/api" || pathname.startsWith("/api/");
}

/** Collects console errors, error toasts and malformed API responses of the pages it watches. */
export class Health {
    readonly consoleErrors: string[] = [];
    readonly pageErrors: string[] = [];
    readonly errorToasts: string[] = [];
    readonly apiProblems: string[] = [];
    readonly allowed: ConsoleAllowance[] = [...BENIGN_CONSOLE_ERRORS];
    readonly apiResponses: { method: string; path: string; status: number }[] = [];
    private readonly tolerated = new Map<string, number>();

    /** Accepts console errors matching `allowance` for the rest of the test. */
    allow(allowance: ConsoleAllowance): void {
        this.allowed.push(allowance);
    }

    async watch(page: Page): Promise<void> {
        await page.exposeBinding(TOAST_BINDING, (_source, variant: string, text: string) => {
            if (variant === "danger") {
                this.errorToasts.push(text);
            }
        });
        await page.addInitScript(TOAST_OBSERVER);
        page.on("console", (message) => this.onConsole(message));
        page.on("pageerror", (error) => this.pageErrors.push(`${error.name}: ${error.message}`));
        page.on("response", (response) => this.onResponse(response));
    }

    private onConsole(message: ConsoleMessage): void {
        if (message.type() !== "error") {
            return;
        }
        const text = message.text();
        const url = message.location().url;
        const allowance = this.allowed.find((entry) => entry.text.test(text) && (!entry.url || entry.url.test(url)));
        if (allowance) {
            this.tolerated.set(allowance.reason, (this.tolerated.get(allowance.reason) ?? 0) + 1);
            return;
        }
        this.consoleErrors.push(url ? `${text} (${url})` : text);
    }

    private onResponse(response: Response): void {
        const url = new URL(response.url());
        if (url.origin !== ORIGIN || !isBackendPath(url.pathname)) {
            return;
        }
        const method = response.request().method();
        const status = response.status();
        const label = `${method} ${url.pathname} -> ${status}`;
        this.apiResponses.push({ method, path: url.pathname, status });
        const headers = response.headers();
        if (!headers["x-request-id"]) {
            this.apiProblems.push(`${label}: no X-Request-ID`);
        }
        if ((headers["content-type"] ?? "").startsWith("text/html")) {
            this.apiProblems.push(`${label}: answered with HTML`);
        }
        if (!response.fromServiceWorker()) {
            this.apiProblems.push(`${label}: not answered by the Service Worker`);
        }
    }

    async attachSummary(testInfo: TestInfo): Promise<void> {
        const tolerated = [...this.tolerated].map(([reason, count]) => `${count}x ${reason}`);
        if (tolerated.length) {
            await testInfo.attach("tolerated console errors", {
                body: tolerated.join("\n"),
                contentType: "text/plain",
            });
        }
    }

    expectHealthy(): void {
        expect.soft(this.pageErrors, "uncaught page errors").toEqual([]);
        expect.soft(this.consoleErrors, "console errors").toEqual([]);
        expect.soft(this.errorToasts, "error toasts").toEqual([]);
        expect.soft(this.apiProblems, "API responses").toEqual([]);
    }
}

export const test = base.extend<{ health: Health }>({
    health: [
        async ({ page }, use, testInfo) => {
            const health = new Health();
            await health.watch(page);
            await use(health);
            await health.attachSummary(testInfo);
            health.expectHealthy();
        },
        { auto: true },
    ],
});

/**
 * Loads Galaxy and waits until the page is Service Worker controlled and the masthead shows the Planet brand.
 * `timeout` overrides the expect timeout for each check, for loads that install the Service Worker on a busy machine.
 */
export async function openGalaxy(page: Page, path = "/", timeout?: number): Promise<void> {
    await page.goto(path);
    await expectGalaxy(page, timeout);
}

export async function expectGalaxy(page: Page, timeout?: number): Promise<void> {
    await expect(page.locator("#masthead .navbar-text", { hasText: /^\s*Planet\s*$/ })).toBeVisible({ timeout });
    expect(await isControlled(page)).toBe(true);
    await expect(page.locator("#current-history-panel")).toBeVisible({ timeout });
}

export function isControlled(page: Page): Promise<boolean> {
    return page.evaluate(() => navigator.serviceWorker?.controller != null);
}

/** Calls the emulated Galaxy API from the page, so the request goes through the Service Worker. */
export async function api<T = unknown>(
    page: Page,
    path: string,
    init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; headers: Record<string, string>; body: T }> {
    return page.evaluate(
        async ({ path, method, body }) => {
            const response = await fetch(path, {
                method: method ?? "GET",
                headers: body === undefined ? {} : { "Content-Type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            const text = await response.text();
            let parsed: unknown = text;
            try {
                parsed = JSON.parse(text);
            } catch {
                // Not JSON; the raw text is returned.
            }
            return { status: response.status, headers: Object.fromEntries(response.headers), body: parsed as T };
        },
        { path, method: init.method, body: init.body },
    );
}

export interface HistorySummary {
    id: string;
    name: string;
    count: number;
}

export async function currentHistoryId(page: Page): Promise<string> {
    const { body } = await api<{ id: string }>(page, "/history/current_history_json");
    return body.id;
}

export async function listHistories(page: Page): Promise<HistorySummary[]> {
    const { body } = await api<HistorySummary[]>(page, "/api/histories?keys=id,name,count");
    return body;
}

/** Saves a named screenshot under build/e2e/screenshots and attaches it to the report. */
export async function saveScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
    const directory = resolve(outDir, "screenshots");
    mkdirSync(directory, { recursive: true });
    const path = resolve(directory, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await testInfo.attach(name, { path, contentType: "image/png" });
}

/**
 * Types a credential into a field without Playwright recording it: `fill()` puts the value into the step titles of
 * the HTML report. Traces record it either way; planet/scripts/e2e.sh turns them off in cluster mode.
 */
export async function fillSecret(field: Locator, value: string): Promise<void> {
    await field.evaluate((element, text) => {
        const input = element as HTMLInputElement;
        input.value = text;
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
}
