import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    APP_SCRIPTS,
    boot,
    type BootContext,
    BUILD_ID_ENDPOINT,
    RELOAD_GUARD_KEY,
    requestWorkerBuildId,
    takeReloadGuard,
} from "./gate";

const BUILD_ID = "abc1234-0123456789";
const FAST = { control: 20, activation: 50, buildId: 20, takeover: 50, reloadGuard: 30000, updateCheck: 0 };

class FakeWorker extends EventTarget {
    state: ServiceWorkerState;
    messages: unknown[] = [];
    replyBuildId: string | null;

    constructor(state: ServiceWorkerState, replyBuildId: string | null = BUILD_ID) {
        super();
        this.state = state;
        this.replyBuildId = replyBuildId;
    }

    postMessage(message: { type: string }, transfer?: MessagePort[]) {
        this.messages.push(message);
        const port = transfer?.[0];
        if (port && message.type === "planet:build-id" && this.replyBuildId !== null) {
            port.postMessage({ build_id: this.replyBuildId });
            port.close();
        }
    }

    setState(state: ServiceWorkerState) {
        this.state = state;
        this.dispatchEvent(new Event("statechange"));
    }
}

class FakeRegistration extends EventTarget {
    installing: FakeWorker | null = null;
    waiting: FakeWorker | null = null;
    active: FakeWorker | null = null;
    update = vi.fn(async () => undefined);
}

class FakeContainer extends EventTarget {
    controller: FakeWorker | null = null;
    registration = new FakeRegistration();
    register = vi.fn(async (_url: string, _options?: RegistrationOptions) => this.registration);

    claim(worker: FakeWorker) {
        this.controller = worker;
        this.dispatchEvent(new Event("controllerchange"));
    }
}

class MemoryStorage {
    values = new Map<string, string>();
    getItem(key: string) {
        return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string) {
        this.values.set(key, value);
    }
    removeItem(key: string) {
        this.values.delete(key);
    }
}

const windows: Window[] = [];

function createDocument(readyState: DocumentReadyState = "loading"): Document {
    const window = new Window({
        url: "https://planet.test/",
        settings: {
            disableJavaScriptFileLoading: true,
            disableCSSFileLoading: true,
            handleDisabledFileLoadingAsSuccess: true,
        },
    });
    windows.push(window);
    const doc = window.document as unknown as Document;
    doc.head.innerHTML =
        '<link rel="stylesheet" href="/static/planet/boot.css">' +
        '<link rel="stylesheet" href="/static/style/jquery-ui/smoothness/jquery-ui.css">';
    doc.body.innerHTML = '<main><div id="app"></div></main>';
    Object.defineProperty(doc, "readyState", { configurable: true, get: () => readyState });
    return doc;
}

function createContext(overrides: Partial<Omit<BootContext, "container">> & { container?: FakeContainer } = {}) {
    const { container, ...rest } = overrides;
    const reload = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ build_id: BUILD_ID }), { status: 200 }));
    const context = {
        buildId: BUILD_ID,
        document: createDocument(),
        container: (container ?? undefined) as unknown as ServiceWorkerContainer | undefined,
        storage: new MemoryStorage(),
        fetch: fetchMock as unknown as typeof fetch,
        reload,
        timeouts: FAST,
        ...rest,
    } satisfies BootContext;
    return { context, reload, fetchMock };
}

function injectedScripts(doc: Document): HTMLScriptElement[] {
    return Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"]'));
}

function failureReason(doc: Document): string | undefined {
    return doc.querySelector<HTMLElement>(".planet-boot-message")?.dataset.reason;
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
    for (const window of windows.splice(0)) {
        await window.happyDOM.close();
    }
});

describe("boot gate", () => {
    it("explains that service workers are required when the browser has none", async () => {
        const { context } = createContext({ container: undefined });

        await expect(boot(context)).resolves.toBe("unsupported");

        const message = context.document.querySelector(".planet-boot-message");
        expect(message?.getAttribute("role")).toBe("alert");
        expect(message?.querySelector("h1")?.textContent).toBe("Service workers are required");
        expect(message?.querySelector("button")).toBeNull();
        expect(injectedScripts(context.document)).toHaveLength(0);
    });

    it("starts Galaxy immediately when the page is already controlled", async () => {
        const container = new FakeContainer();
        container.controller = new FakeWorker("activated");
        container.registration.active = container.controller;
        const storage = new MemoryStorage();
        storage.setItem(RELOAD_GUARD_KEY, "1");
        const { context } = createContext({ container, storage });

        await expect(boot(context)).resolves.toBe("started");

        const doc = context.document;
        const styles = Array.from(doc.head.querySelectorAll('link[rel="stylesheet"]')).map((link) =>
            link.getAttribute("href"),
        );
        expect(styles).toEqual([
            "/static/planet/boot.css",
            `/static/dist/base.css?v=${BUILD_ID}`,
            "/static/style/jquery-ui/smoothness/jquery-ui.css",
        ]);
        const scripts = injectedScripts(doc);
        expect(scripts.map((script) => script.getAttribute("src"))).toEqual(APP_SCRIPTS);
        expect(scripts.every((script) => script.async === false)).toBe(true);
        expect(container.register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
        expect(storage.getItem(RELOAD_GUARD_KEY)).toBeNull();
    });

    it("waits for a first install and claim before starting Galaxy", async () => {
        const container = new FakeContainer();
        const worker = new FakeWorker("installing");
        container.registration.installing = worker;
        const { context } = createContext({ container, timeouts: { ...FAST, control: 200 } });

        const result = boot(context);
        await settle();
        expect(context.document.querySelector(".planet-boot-status")?.textContent).toBe("Starting Planet…");
        expect(injectedScripts(context.document)).toHaveLength(0);

        container.registration.installing = null;
        container.registration.active = worker;
        worker.setState("activating");
        container.claim(worker);

        await expect(result).resolves.toBe("started");
        expect(context.document.querySelector(".planet-boot-status")).toBeNull();
        expect(injectedScripts(context.document)).toHaveLength(2);
    });

    it("reloads once after a forced reload, then reports the page as uncontrolled", async () => {
        const container = new FakeContainer();
        container.registration.active = new FakeWorker("activated");
        const storage = new MemoryStorage();

        const first = createContext({ container, storage });
        await expect(boot(first.context)).resolves.toBe("reloading");
        expect(first.reload).toHaveBeenCalledOnce();
        expect(storage.getItem(RELOAD_GUARD_KEY)).not.toBeNull();

        const second = createContext({ container, storage });
        await expect(boot(second.context)).resolves.toBe("not-controlled");
        expect(second.reload).not.toHaveBeenCalled();
        expect(failureReason(second.context.document)).toBe("not-controlled");

        second.context.document.querySelector<HTMLButtonElement>(".planet-boot-button")?.click();
        expect(second.reload).toHaveBeenCalledOnce();
        expect(storage.getItem(RELOAD_GUARD_KEY)).toBeNull();
    });

    it("does not reload automatically when session storage is unavailable", async () => {
        const container = new FakeContainer();
        container.registration.active = new FakeWorker("activated");
        const { context, reload } = createContext({ container, storage: undefined });

        await expect(boot(context)).resolves.toBe("not-controlled");
        expect(reload).not.toHaveBeenCalled();
    });

    it("reports a failed registration with the browser's error", async () => {
        const container = new FakeContainer();
        container.register.mockRejectedValueOnce(new TypeError("Failed to register a ServiceWorker"));
        const { context } = createContext({ container });

        await expect(boot(context)).resolves.toBe("registration-failed");
        expect(context.document.querySelector(".planet-boot-detail")?.textContent).toBe(
            "Failed to register a ServiceWorker",
        );
    });

    it("reports a worker that fails to install", async () => {
        const container = new FakeContainer();
        const worker = new FakeWorker("installing");
        container.registration.installing = worker;
        const { context } = createContext({ container });

        const result = boot(context);
        await settle();
        container.registration.installing = null;
        worker.setState("redundant");

        await expect(result).resolves.toBe("activation-failed");
        expect(failureReason(context.document)).toBe("activation-failed");
    });

    it("replays the window load event when Galaxy is injected after the document loaded", async () => {
        const container = new FakeContainer();
        container.registration.active = new FakeWorker("activated");
        const { context } = createContext({ container, timeouts: { ...FAST, control: 200 } });
        Object.defineProperty(context.document, "readyState", { configurable: true, get: () => "complete" });
        const onLoad = vi.fn();
        context.document.defaultView?.addEventListener("load", onLoad);

        const result = boot(context);
        await settle();
        container.claim(container.registration.active);
        await expect(result).resolves.toBe("started");

        const scripts = injectedScripts(context.document);
        scripts.at(-1)?.dispatchEvent(new Event("load"));
        await settle();
        expect(onLoad).toHaveBeenCalled();
    });

    it("does not replay the load event while the document is still loading", async () => {
        const container = new FakeContainer();
        container.controller = new FakeWorker("activated");
        const { context } = createContext({ container });
        const onLoad = vi.fn();
        context.document.defaultView?.addEventListener("load", onLoad);

        await boot(context);
        injectedScripts(context.document).at(-1)?.dispatchEvent(new Event("load"));

        expect(onLoad).not.toHaveBeenCalled();
    });

    it("shows a failure page when an application script fails to load", async () => {
        const container = new FakeContainer();
        container.controller = new FakeWorker("activated");
        const { context } = createContext({ container });

        await boot(context);
        injectedScripts(context.document)[0]?.dispatchEvent(new Event("error"));

        expect(failureReason(context.document)).toBe("load-failed");
    });
});

describe("updates", () => {
    async function startControlled(workerBuildId: string | null, waiting: FakeWorker | null = null) {
        const container = new FakeContainer();
        container.controller = new FakeWorker("activated", workerBuildId);
        container.registration.active = container.controller;
        container.registration.waiting = waiting;
        const setup = createContext({ container });
        await boot(setup.context);
        await settle(30);
        return { container, ...setup };
    }

    function banner(doc: Document) {
        return doc.getElementById("planet-update-banner");
    }

    it("stays quiet when the worker runs the same build", async () => {
        const { context } = await startControlled(BUILD_ID);
        expect(banner(context.document)).toBeNull();
    });

    it("offers a reload when the worker runs another build", async () => {
        const { context } = await startControlled("old-build");
        const element = banner(context.document);
        expect(element?.getAttribute("role")).toBe("status");
        expect(element?.textContent).toContain("A new version of Planet is available.");
    });

    it("activates the waiting worker only when the user asks", async () => {
        const waiting = new FakeWorker("installed", BUILD_ID);
        const { container, context, reload } = await startControlled(BUILD_ID, waiting);
        expect(waiting.messages).toEqual([]);

        banner(context.document)?.querySelector<HTMLButtonElement>(".planet-boot-button")?.click();
        await settle();
        expect(waiting.messages).toEqual([{ type: "planet:skip-waiting" }]);
        expect(reload).not.toHaveBeenCalled();

        container.claim(waiting);
        await settle();
        expect(reload).toHaveBeenCalledOnce();
    });

    it("offers a reload when a new worker finishes installing", async () => {
        const { container, context } = await startControlled(BUILD_ID);
        expect(banner(context.document)).toBeNull();

        const installing = new FakeWorker("installing");
        container.registration.installing = installing;
        container.registration.dispatchEvent(new Event("updatefound"));
        installing.setState("installed");

        expect(banner(context.document)).not.toBeNull();
    });

    it("can be dismissed", async () => {
        const { context } = await startControlled("old-build");
        banner(context.document)?.querySelector<HTMLButtonElement>(".planet-update-banner__dismiss")?.click();
        expect(banner(context.document)).toBeNull();
    });

    it("falls back to the build endpoint when the worker does not answer", async () => {
        const { fetchMock } = await startControlled(null);
        await settle(30);
        expect(fetchMock).toHaveBeenCalledWith(BUILD_ID_ENDPOINT, expect.objectContaining({ cache: "no-store" }));
    });
});

describe("helpers", () => {
    it("reads the build id over a message channel and reports the page's build", async () => {
        const worker = new FakeWorker("activated", "build-7");
        await expect(requestWorkerBuildId(worker as unknown as ServiceWorker, BUILD_ID, 100)).resolves.toBe("build-7");
        expect(worker.messages).toEqual([{ type: "planet:build-id", build_id: BUILD_ID }]);
    });

    it("allows another automatic reload once the guard is stale", () => {
        const storage = new MemoryStorage();
        expect(takeReloadGuard(storage, 1000, 500)).toBe(true);
        expect(takeReloadGuard(storage, 1200, 500)).toBe(false);
        expect(takeReloadGuard(storage, 1600, 500)).toBe(true);
    });
});
