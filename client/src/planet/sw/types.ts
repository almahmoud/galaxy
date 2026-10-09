/**
 * The parts of `ServiceWorkerGlobalScope` Planet uses. The client compiles with the DOM library, which has
 * no Service Worker types, and adding the WebWorker library would conflict with it.
 */

export interface ExtendableEventLike extends Event {
    waitUntil(promise: Promise<unknown>): void;
}

/** A Service Worker static routing rule (`InstallEvent.addRoutes`). */
export interface RouterRule {
    condition: {
        urlPattern?: unknown;
        requestMethod?: string;
        requestMode?: RequestMode;
        runningStatus?: "running" | "not-running";
    };
    source: "network" | "cache" | "fetch-event" | "race-network-and-fetch-handler" | { cacheName: string };
}

export interface InstallEventLike extends ExtendableEventLike {
    addRoutes?(rules: RouterRule | RouterRule[]): Promise<void>;
}

export interface FetchEventLike extends ExtendableEventLike {
    readonly request: Request;
    readonly clientId: string;
    readonly resultingClientId: string;
    respondWith(response: Response | Promise<Response>): void;
}

export interface ClientLike {
    readonly id: string;
    readonly url: string;
    readonly type: string;
    readonly frameType: string;
    postMessage(message: unknown, transfer?: Transferable[]): void;
}

export interface ExtendableMessageEventLike extends ExtendableEventLike {
    readonly data: unknown;
    readonly source: ClientLike | object | null;
    readonly ports: readonly MessagePort[];
}

export interface ClientsLike {
    claim(): Promise<void>;
    get(id: string): Promise<ClientLike | undefined>;
    matchAll(options?: {
        type?: "window" | "worker" | "sharedworker" | "all";
        includeUncontrolled?: boolean;
    }): Promise<readonly ClientLike[]>;
}

export interface ServiceWorkerScopeLike {
    readonly location: { readonly origin: string };
    readonly clients: ClientsLike;
    readonly caches: CacheStorage;
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    skipWaiting(): Promise<void>;
    addEventListener(type: "install", listener: (event: InstallEventLike) => void): void;
    addEventListener(type: "activate", listener: (event: ExtendableEventLike) => void): void;
    addEventListener(type: "fetch", listener: (event: FetchEventLike) => void): void;
    addEventListener(type: "message", listener: (event: ExtendableMessageEventLike) => void): void;
}
