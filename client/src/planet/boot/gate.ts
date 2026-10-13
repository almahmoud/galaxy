/**
 * Boot gate for index.html: Galaxy's bundles only run once the page is
 * controlled by Planet's service worker, because every API request Galaxy
 * makes is answered by that worker.
 */
import { clearStatus, type FailureReason, renderFailure, renderStatus, showUpdateBanner } from "./view";

export const SERVICE_WORKER_URL = "/sw.js";
export const RELOAD_GUARD_KEY = "planet:boot-reload";
export const APP_STYLESHEET = "/static/dist/base.css";
/**
 * Loaded without a version query: lazily loaded chunks import these entries by
 * their plain URL, and a different URL would evaluate a second module instance.
 */
export const APP_SCRIPTS = ["/static/dist/libs.bundled.js", "/static/dist/analysis.bundled.js"];
export const BUILD_ID_ENDPOINT = "/api/planet/build";

export interface BootTimeouts {
    /** Wait for clients.claim() after the worker is active. */
    control: number;
    /** Wait for a newly registered worker to install and activate. */
    activation: number;
    /** Wait for the worker to report its build id. */
    buildId: number;
    /** Wait for a waiting worker to take over after skip-waiting. */
    takeover: number;
    /** A reload guard older than this no longer suppresses the automatic reload. */
    reloadGuard: number;
    /** Minimum interval between update checks triggered by the page becoming visible. */
    updateCheck: number;
}

export const DEFAULT_TIMEOUTS: BootTimeouts = {
    control: 2000,
    activation: 60000,
    buildId: 3000,
    takeover: 5000,
    reloadGuard: 30000,
    updateCheck: 60 * 60 * 1000,
};

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface BootContext {
    buildId: string;
    document: Document;
    container: ServiceWorkerContainer | undefined;
    storage: SessionStore | undefined;
    fetch: typeof fetch;
    reload: () => void;
    now?: () => number;
    timeouts?: Partial<BootTimeouts>;
}

export type BootResult = "started" | "reloading" | FailureReason;

interface Runtime extends Omit<BootContext, "now" | "timeouts"> {
    now: () => number;
    timeouts: BootTimeouts;
}

function describeError(error: unknown): string | null {
    if (error instanceof Error) {
        return error.message || error.name;
    }
    return typeof error === "string" ? error : null;
}

/** True once per guard period: allows one automatic reload, then reports the failure instead. */
export function takeReloadGuard(storage: SessionStore | undefined, now: number, maxAge: number): boolean {
    if (!storage) {
        return false;
    }
    try {
        const previous = Number(storage.getItem(RELOAD_GUARD_KEY));
        if (previous && now - previous < maxAge) {
            return false;
        }
        storage.setItem(RELOAD_GUARD_KEY, String(now));
        return true;
    } catch {
        return false;
    }
}

function clearReloadGuard(storage: SessionStore | undefined): void {
    try {
        storage?.removeItem(RELOAD_GUARD_KEY);
    } catch {
        // Storage that cannot be written holds no guard either.
    }
}

/** Resolves true when the registration has an active worker, false if installation fails or times out. */
function waitForActiveWorker(registration: ServiceWorkerRegistration, timeoutMs: number): Promise<boolean> {
    if (registration.active) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const tracked = new Set<ServiceWorker>();
        const timer = setTimeout(() => finish(false), timeoutMs);

        function finish(result: boolean) {
            clearTimeout(timer);
            registration.removeEventListener("updatefound", track);
            for (const worker of tracked) {
                worker.removeEventListener("statechange", onStateChange);
            }
            resolve(result);
        }

        function onStateChange() {
            if (registration.active) {
                finish(true);
            } else if (!registration.installing && !registration.waiting) {
                finish(false);
            }
        }

        function track() {
            for (const worker of [registration.installing, registration.waiting]) {
                if (worker && !tracked.has(worker)) {
                    tracked.add(worker);
                    worker.addEventListener("statechange", onStateChange);
                }
            }
        }

        registration.addEventListener("updatefound", track);
        track();
        if (!tracked.size) {
            onStateChange();
        }
    });
}

/** Resolves true when the page is controlled, false after `timeoutMs` without a controllerchange. */
function waitForController(container: ServiceWorkerContainer, timeoutMs: number): Promise<boolean> {
    if (container.controller) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish(), timeoutMs);
        function finish() {
            clearTimeout(timer);
            container.removeEventListener("controllerchange", finish);
            resolve(container.controller !== null);
        }
        container.addEventListener("controllerchange", finish);
    });
}

function parseBuildId(data: unknown): string | null {
    if (data && typeof data === "object" && "build_id" in data && typeof data.build_id === "string") {
        return data.build_id;
    }
    return null;
}

/**
 * Asks a worker for its build id over a reply port. The request carries the
 * page's own build id, which the worker uses to keep that build's cache.
 */
export function requestWorkerBuildId(
    worker: ServiceWorker,
    pageBuildId: string,
    timeoutMs: number,
): Promise<string | null> {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => finish(null), timeoutMs);
        function finish(buildId: string | null) {
            clearTimeout(timer);
            channel.port1.onmessage = null;
            channel.port1.close();
            resolve(buildId);
        }
        channel.port1.onmessage = (event: MessageEvent) => finish(parseBuildId(event.data));
        try {
            worker.postMessage({ type: "planet:build-id", build_id: pageBuildId }, [channel.port2]);
        } catch {
            finish(null);
        }
    });
}

async function fetchWorkerBuildId(fetchFn: typeof fetch): Promise<string | null> {
    try {
        const response = await fetchFn(BUILD_ID_ENDPOINT, {
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        return response.ok ? parseBuildId(await response.json()) : null;
    } catch {
        return null;
    }
}

async function workerBuildId(
    runtime: Pick<Runtime, "buildId" | "container" | "fetch" | "timeouts">,
): Promise<string | null> {
    const controller = runtime.container?.controller;
    if (!controller) {
        return null;
    }
    return (
        (await requestWorkerBuildId(controller, runtime.buildId, runtime.timeouts.buildId)) ??
        (await fetchWorkerBuildId(runtime.fetch))
    );
}

/**
 * Injects Galaxy's stylesheet and module entries. Galaxy mounts from a window
 * `load` listener; when the document already finished loading before the
 * entries were inserted, `load` is dispatched again after they have run.
 */
function startApplication(runtime: Runtime): void {
    const doc = runtime.document;
    const view = doc.defaultView;
    const loadFired = doc.readyState === "complete";
    const fail = () => showFailure(runtime, "load-failed", null);

    clearStatus(doc);

    const stylesheet = doc.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = `${APP_STYLESHEET}?v=${encodeURIComponent(runtime.buildId)}`;
    stylesheet.addEventListener("error", fail);
    const jqueryUi = doc.head.querySelector('link[rel="stylesheet"][href^="/static/style/jquery-ui/"]');
    doc.head.insertBefore(stylesheet, jqueryUi);

    let last: HTMLScriptElement | null = null;
    for (const src of APP_SCRIPTS) {
        const script = doc.createElement("script");
        script.type = "module";
        script.src = src;
        // Dynamically inserted scripts are async by default; this keeps libs before analysis.
        script.async = false;
        script.addEventListener("error", fail);
        doc.body.append(script);
        last = script;
    }
    if (loadFired && view && last) {
        last.addEventListener("load", () => view.dispatchEvent(new Event("load")), { once: true });
    }
}

function showFailure(runtime: Runtime, reason: FailureReason, detail: string | null): void {
    renderFailure(runtime.document, reason, detail, () => {
        clearReloadGuard(runtime.storage);
        runtime.reload();
    });
}

function waitForInstalled(worker: ServiceWorker | null, timeoutMs: number): Promise<ServiceWorker | null> {
    if (!worker || worker.state === "installed") {
        return Promise.resolve(worker);
    }
    const installing = worker;
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish(null), timeoutMs);
        function finish(result: ServiceWorker | null) {
            clearTimeout(timer);
            installing.removeEventListener("statechange", onStateChange);
            resolve(result);
        }
        function onStateChange() {
            if (installing.state === "installed") {
                finish(installing);
            } else if (installing.state === "redundant") {
                finish(null);
            }
        }
        installing.addEventListener("statechange", onStateChange);
    });
}

/**
 * Watches for a newer service worker and for a build id mismatch, and offers
 * a reload. Activation is always user-initiated: the waiting worker is told to
 * skip waiting only from the banner's Reload button.
 */
function monitorUpdates(runtime: Runtime, registration: ServiceWorkerRegistration): void {
    const container = runtime.container;
    if (!container) {
        return;
    }
    const doc = runtime.document;
    let applying = false;
    let lastCheck = runtime.now();

    const applyUpdate = async () => {
        applying = true;
        const waiting =
            registration.waiting ?? (await waitForInstalled(registration.installing, runtime.timeouts.activation));
        if (waiting) {
            const takeover = waitForControllerChange(container, runtime.timeouts.takeover);
            waiting.postMessage({ type: "planet:skip-waiting" });
            await takeover;
        }
        runtime.reload();
    };

    const offerUpdate = () => showUpdateBanner(doc, { onReload: () => void applyUpdate() });

    const compareBuildIds = async () => {
        const buildId = await workerBuildId(runtime);
        if (buildId && buildId !== runtime.buildId) {
            offerUpdate();
        }
    };

    const watchInstalling = () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
            if (installing.state === "installed" && container.controller) {
                offerUpdate();
            }
        });
    };

    registration.addEventListener("updatefound", watchInstalling);
    watchInstalling();
    if (registration.waiting && container.controller) {
        offerUpdate();
    }
    container.addEventListener("controllerchange", () => {
        if (!applying) {
            void compareBuildIds();
        }
    });
    doc.addEventListener("visibilitychange", () => {
        const now = runtime.now();
        if (doc.visibilityState === "visible" && now - lastCheck >= runtime.timeouts.updateCheck) {
            lastCheck = now;
            registration.update().catch(() => undefined);
        }
    });
    void compareBuildIds();
}

function waitForControllerChange(container: ServiceWorkerContainer, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => finish(), timeoutMs);
        function finish() {
            clearTimeout(timer);
            container.removeEventListener("controllerchange", finish);
            resolve();
        }
        container.addEventListener("controllerchange", finish);
    });
}

async function register(container: ServiceWorkerContainer): Promise<ServiceWorkerRegistration> {
    const registration = await container.register(SERVICE_WORKER_URL, { scope: "/", updateViaCache: "none" });
    // Some browsers and automation modes that block service workers resolve without a registration.
    if (!registration) {
        throw new Error("The browser did not register the service worker.");
    }
    return registration;
}

export async function boot(context: BootContext): Promise<BootResult> {
    const runtime: Runtime = {
        ...context,
        now: context.now ?? Date.now,
        timeouts: { ...DEFAULT_TIMEOUTS, ...context.timeouts },
    };
    try {
        return await bootWith(runtime);
    } catch (error) {
        showFailure(runtime, "registration-failed", describeError(error));
        return "registration-failed";
    }
}

async function bootWith(runtime: Runtime): Promise<BootResult> {
    const { container, document: doc } = runtime;

    if (!container) {
        showFailure(runtime, "unsupported", null);
        return "unsupported";
    }

    if (container.controller) {
        clearReloadGuard(runtime.storage);
        startApplication(runtime);
        register(container).then(
            (registration) => monitorUpdates(runtime, registration),
            (error: unknown) => console.warn("Planet: service worker update check failed", error),
        );
        return "started";
    }

    renderStatus(doc, "Starting Planet…");
    let registration: ServiceWorkerRegistration;
    try {
        registration = await register(container);
    } catch (error) {
        showFailure(runtime, "registration-failed", describeError(error));
        return "registration-failed";
    }

    if (!(await waitForActiveWorker(registration, runtime.timeouts.activation))) {
        showFailure(runtime, "activation-failed", null);
        return "activation-failed";
    }

    if (!(await waitForController(container, runtime.timeouts.control))) {
        if (takeReloadGuard(runtime.storage, runtime.now(), runtime.timeouts.reloadGuard)) {
            runtime.reload();
            return "reloading";
        }
        showFailure(runtime, "not-controlled", null);
        return "not-controlled";
    }

    clearReloadGuard(runtime.storage);
    startApplication(runtime);
    monitorUpdates(runtime, registration);
    return "started";
}
