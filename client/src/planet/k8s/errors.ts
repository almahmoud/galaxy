import type { Status, StatusDetails } from "./types";

/**
 * Error raised for failed Kubernetes API calls. `reason` is the Status reason (NotFound, AlreadyExists,
 * Expired, ...) or a Planet reason: network_blocked, invalid_config, InvalidWatchEvent, Redirect.
 * `status` is 0 when no HTTP response was readable.
 */
export class KubeError extends Error {
    readonly status: number;
    readonly reason: string;
    readonly details: StatusDetails | null;

    constructor(status: number, reason: string, message: string, details?: StatusDetails | null, cause?: unknown) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = "KubeError";
        this.status = status;
        this.reason = reason;
        this.details = details ?? null;
    }
}

export function isKubeError(error: unknown, reason?: string): error is KubeError {
    return error instanceof KubeError && (reason === undefined || error.reason === reason);
}

/** True for an expired resourceVersion (HTTP 410), which requires a fresh list before watching again. */
export function isExpired(error: unknown): error is KubeError {
    return error instanceof KubeError && error.status === 410;
}

const STATUS_REASONS: Record<number, string> = {
    400: "BadRequest",
    401: "Unauthorized",
    403: "Forbidden",
    404: "NotFound",
    405: "MethodNotAllowed",
    406: "NotAcceptable",
    409: "Conflict",
    410: "Expired",
    413: "RequestEntityTooLarge",
    415: "UnsupportedMediaType",
    422: "Invalid",
    429: "TooManyRequests",
    500: "InternalError",
    502: "BadGateway",
    503: "ServiceUnavailable",
    504: "Timeout",
};

const MAX_MESSAGE_LENGTH = 1000;

export function reasonForStatus(status: number): string {
    return STATUS_REASONS[status] ?? "Unknown";
}

export function isStatus(value: unknown): value is Status {
    return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "Status";
}

export function errorFromStatus(status: Status, httpStatus = 0): KubeError {
    const code = status.code || httpStatus;
    const reason = status.reason || reasonForStatus(code);
    const message = (status.message || `${reason} (HTTP ${code})`).slice(0, MAX_MESSAGE_LENGTH);
    return new KubeError(code, reason, message, status.details);
}

/** Builds a KubeError from a non-successful response, consuming its body. */
export async function errorFromResponse(response: Response): Promise<KubeError> {
    let text = "";
    try {
        text = await response.text();
    } catch {
        // The status alone still identifies the failure.
    }
    let body: unknown = null;
    try {
        body = JSON.parse(text);
    } catch {
        // Gateway errors (nginx) are HTML or plain text.
    }
    if (isStatus(body)) {
        return errorFromStatus(body, response.status);
    }
    const reason = reasonForStatus(response.status);
    if (response.status === 403) {
        return new KubeError(
            403,
            reason,
            "The gateway refused the request (HTTP 403): this site's origin or the request path is not allowed by it.",
        );
    }
    return new KubeError(response.status, reason, `HTTP ${response.status} from the Kubernetes gateway.`);
}

function currentOrigin(): string | null {
    const location = (globalThis as { location?: { origin?: string } }).location;
    return location?.origin && location.origin !== "null" ? location.origin : null;
}

export function networkBlockedError(gateway: URL, cause: unknown): KubeError {
    const origin = currentOrigin();
    return new KubeError(
        0,
        "network_blocked",
        `Could not reach the Kubernetes gateway at ${gateway.origin}${gateway.pathname.replace(/\/$/, "")}. Check ` +
            `that the gateway is running and that its CORS configuration allows ${origin ?? "this site"}. For a ` +
            `gateway on localhost or a private network address, allow Chrome's local network access permission ` +
            `for this site; Safari needs an https:// gateway.`,
        null,
        cause,
    );
}
