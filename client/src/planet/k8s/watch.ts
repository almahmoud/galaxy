import { KubeError } from "./errors";
import type { WatchEvent, WatchEventType } from "./types";

const DEFAULT_MAX_LINE_LENGTH = 4 * 1024 * 1024;
const EVENT_TYPES = new Set<WatchEventType>(["ADDED", "MODIFIED", "DELETED", "BOOKMARK", "ERROR"]);

/** Splits a UTF-8 byte stream into lines, keeping partial lines and characters across chunks. */
export class LineDecoder {
    private readonly decoder = new TextDecoder();
    private buffer = "";

    /** `maxLineLength` bounds an unterminated line, in UTF-16 code units. */
    constructor(private readonly maxLineLength = DEFAULT_MAX_LINE_LENGTH) {}

    push(chunk: Uint8Array): string[] {
        this.buffer += this.decoder.decode(chunk, { stream: true });
        return this.takeLines();
    }

    /** Ends the stream and returns any final unterminated line. */
    flush(): string[] {
        this.buffer += this.decoder.decode();
        const lines = this.takeLines();
        const rest = this.buffer;
        this.buffer = "";
        return rest.trim() ? [...lines, rest] : lines;
    }

    private takeLines(): string[] {
        const lines: string[] = [];
        let start = 0;
        let newline = this.buffer.indexOf("\n");
        while (newline !== -1) {
            const line = this.buffer.slice(start, newline);
            if (line.trim()) {
                lines.push(line);
            }
            start = newline + 1;
            newline = this.buffer.indexOf("\n", start);
        }
        this.buffer = this.buffer.slice(start);
        if (this.buffer.length > this.maxLineLength) {
            throw new KubeError(0, "InvalidWatchEvent", "A watch event exceeded the maximum size.");
        }
        return lines;
    }
}

export function parseWatchEvent<T>(line: string): WatchEvent<T> {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch (error) {
        throw new KubeError(0, "InvalidWatchEvent", "The watch stream contained invalid JSON.", null, error);
    }
    const event = value as { type?: unknown; object?: unknown };
    if (
        typeof event !== "object" ||
        event === null ||
        !EVENT_TYPES.has(event.type as WatchEventType) ||
        typeof event.object !== "object" ||
        event.object === null
    ) {
        throw new KubeError(0, "InvalidWatchEvent", "The watch stream contained an event without a type or object.");
    }
    return event as WatchEvent<T>;
}
