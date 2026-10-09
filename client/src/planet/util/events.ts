/**
 * Change notifications shared by the Service Worker and every Planet tab over the BroadcastChannel
 * `planet`. Messages are nudges: receivers re-read IndexedDB, which stays the source of truth.
 */

/** Name of the BroadcastChannel carrying {@link PlanetEvent} messages. */
export const PLANET_CHANNEL = "planet";

/** Messages published on the `planet` channel. */
export type PlanetEvent =
    /** A history or any of its items changed (its `update_time` moved). */
    | { type: "history-changed"; historyId: string }
    /** The current history changed. */
    | { type: "current-history-changed"; historyId: string }
    /** A job was created and is waiting for dispatch. */
    | { type: "job-created"; jobId: string }
    /** A job record changed. */
    | { type: "job-changed"; jobId: string; state: string }
    /** The outbox has new or rescheduled entries. */
    | { type: "outbox-changed" }
    /** Planet settings or secrets changed. */
    | { type: "settings-changed" }
    /** An upload session changed. */
    | { type: "upload-changed"; uploadId: string }
    /** Installed tools or the tool panel changed. */
    | { type: "tools-changed" };

export type PlanetEventType = PlanetEvent["type"];

type Listener = (event: PlanetEvent) => void;

const EVENT_TYPES: ReadonlySet<string> = new Set<PlanetEventType>([
    "history-changed",
    "current-history-changed",
    "job-created",
    "job-changed",
    "outbox-changed",
    "settings-changed",
    "upload-changed",
    "tools-changed",
]);

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null | undefined;

/** Returns true when `value` is a well-formed {@link PlanetEvent}. */
export function isPlanetEvent(value: unknown): value is PlanetEvent {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const event = value as Record<string, unknown>;
    if (typeof event.type !== "string" || !EVENT_TYPES.has(event.type)) {
        return false;
    }
    switch (event.type) {
        case "history-changed":
        case "current-history-changed":
            return typeof event.historyId === "string";
        case "job-created":
            return typeof event.jobId === "string";
        case "job-changed":
            return typeof event.jobId === "string" && typeof event.state === "string";
        case "upload-changed":
            return typeof event.uploadId === "string";
        default:
            return true;
    }
}

function dispatch(event: PlanetEvent): void {
    for (const listener of [...listeners]) {
        try {
            listener(event);
        } catch (error) {
            console.error("Planet event listener failed", error);
        }
    }
}

function getChannel(): BroadcastChannel | null {
    if (channel === undefined) {
        channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(PLANET_CHANNEL) : null;
        if (channel) {
            channel.onmessage = (message: MessageEvent<unknown>) => {
                if (isPlanetEvent(message.data)) {
                    dispatch(message.data);
                }
            };
        }
    }
    return channel;
}

/**
 * Sends `event` to every other context on the channel and, asynchronously, to listeners in this
 * context. Each listener receives each event once.
 */
export function publish(event: PlanetEvent): void {
    getChannel()?.postMessage(event);
    queueMicrotask(() => dispatch(event));
}

/** Calls `listener` for every event from any context. Returns a function that unsubscribes. */
export function subscribe(listener: (event: PlanetEvent) => void): () => void {
    getChannel();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Calls `listener` for events of one type. Returns a function that unsubscribes. */
export function subscribeTo<T extends PlanetEventType>(
    type: T,
    listener: (event: Extract<PlanetEvent, { type: T }>) => void,
): () => void {
    return subscribe((event) => {
        if (event.type === type) {
            listener(event as Extract<PlanetEvent, { type: T }>);
        }
    });
}

/** Closes the channel and drops all listeners. */
export function closeEvents(): void {
    listeners.clear();
    channel?.close();
    channel = undefined;
}
