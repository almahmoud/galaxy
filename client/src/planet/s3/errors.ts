import { parseXml, xmlChildText } from "./xml";

/** Error raised for failed S3 requests. `status` is 0 when no HTTP response was readable. */
export class S3Error extends Error {
    readonly status: number;
    readonly code: string;
    readonly requestId: string | null;
    /** Server time reported by RequestTimeTooSkewed errors, in epoch milliseconds. */
    readonly serverTime: number | null;

    constructor(
        status: number,
        code: string,
        message: string,
        extra: { requestId?: string | null; serverTime?: number | null; cause?: unknown } = {},
    ) {
        super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
        this.name = "S3Error";
        this.status = status;
        this.code = code;
        this.requestId = extra.requestId ?? null;
        this.serverTime = extra.serverTime ?? null;
    }
}

export function isS3Error(error: unknown, code?: string): error is S3Error {
    return error instanceof S3Error && (code === undefined || error.code === code);
}

export function isNotFound(error: unknown): error is S3Error {
    return error instanceof S3Error && error.status === 404;
}

const STATUS_CODES: Record<number, string> = {
    301: "PermanentRedirect",
    307: "TemporaryRedirect",
    400: "BadRequest",
    401: "Unauthorized",
    403: "AccessDenied",
    404: "NotFound",
    405: "MethodNotAllowed",
    409: "Conflict",
    411: "MissingContentLength",
    412: "PreconditionFailed",
    416: "InvalidRange",
    429: "SlowDown",
    500: "InternalError",
    501: "NotImplemented",
    503: "ServiceUnavailable",
};

const MAX_MESSAGE_LENGTH = 500;

/** Parses an S3 `<Error>` document. Returns null when the text is not one. */
export function parseErrorXml(
    text: string,
): { code: string; message: string; requestId: string | null; serverTime: number | null } | null {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("<")) {
        return null;
    }
    try {
        const root = parseXml(trimmed);
        if (root.name !== "Error") {
            return null;
        }
        const code = xmlChildText(root, "Code")?.trim();
        if (!code) {
            return null;
        }
        const serverTimeText = xmlChildText(root, "ServerTime");
        const serverTime = serverTimeText ? Date.parse(serverTimeText) : NaN;
        return {
            code,
            message: (xmlChildText(root, "Message") ?? "").trim().slice(0, MAX_MESSAGE_LENGTH),
            requestId: xmlChildText(root, "RequestId")?.trim() || null,
            serverTime: Number.isFinite(serverTime) ? serverTime : null,
        };
    } catch {
        return null;
    }
}

/** Builds an S3Error from a non-successful response, consuming its body. */
export async function errorFromResponse(response: Response, notFoundCode = "NotFound"): Promise<S3Error> {
    let text = "";
    try {
        text = await response.text();
    } catch {
        // A body that cannot be read leaves the status as the only information.
    }
    const headerRequestId = response.headers.get("x-amz-request-id");
    const parsed = parseErrorXml(text);
    if (parsed) {
        return new S3Error(response.status, parsed.code, parsed.message || `${parsed.code} (HTTP ${response.status})`, {
            requestId: parsed.requestId ?? headerRequestId,
            serverTime: parsed.serverTime,
        });
    }
    const code = response.status === 404 ? notFoundCode : (STATUS_CODES[response.status] ?? `HTTP${response.status}`);
    const statusText = response.statusText ? ` ${response.statusText}` : "";
    return new S3Error(response.status, code, `HTTP ${response.status}${statusText}`, { requestId: headerRequestId });
}

function currentOrigin(): string | null {
    const location = (globalThis as { location?: { origin?: string } }).location;
    return location?.origin && location.origin !== "null" ? location.origin : null;
}

export function networkBlockedError(endpoint: URL, cause: unknown): S3Error {
    const origin = currentOrigin();
    const allowed = origin ? `allows ${origin}` : "allows this site";
    return new S3Error(
        0,
        "network_blocked",
        `Could not reach the storage endpoint ${endpoint.origin}. Check that the endpoint is reachable, that the ` +
            `bucket CORS policy ${allowed} with the required methods and headers, and, for an endpoint on ` +
            `localhost or a private network address, that Chrome's local network access permission is granted ` +
            `for this site.`,
        { cause },
    );
}
