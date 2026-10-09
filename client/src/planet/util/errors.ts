/** Galaxy API error codes (`lib/galaxy/exceptions/error_codes.json`) used by Planet. */
export const ErrorCodes = {
    UNKNOWN: 0,
    USER_INVALID_JSON: 400003,
    USER_OBJECT_ATTRIBUTE_INVALID: 400004,
    USER_OBJECT_ATTRIBUTE_MISSING: 400005,
    USER_REQUEST_MISSING_PARAMETER: 400007,
    USER_REQUEST_INVALID_PARAMETER: 400008,
    MALFORMED_ID: 400009,
    UNKNOWN_CONTENTS_TYPE: 400010,
    MALFORMED_CONTENTS: 400013,
    USER_TOOL_MISSING_PROBLEM: 400014,
    TOOL_INPUTS_NOT_READY: 400015,
    TOOL_INPUTS_NOT_OK: 400017,
    USER_AUTHENTICATION_FAILED: 401001,
    USER_NO_API_KEY: 403001,
    USER_CANNOT_ACCESS_ITEM: 403002,
    ITEM_IS_IMMUTABLE: 403003,
    CONFIG_DOES_NOT_ALLOW: 403004,
    INSUFFICIENT_PERMISSIONS: 403005,
    ADMIN_REQUIRED: 403006,
    USER_OBJECT_NOT_FOUND: 404001,
    CONFLICT: 409001,
    DEPRECATED_API_CALL: 410001,
    TOO_MANY_REQUESTS: 429001,
    INTERNAL_SERVER_ERROR: 500001,
    INCONSISTENT_DATABASE: 500002,
    CONFIG_ERROR: 500003,
    TOOL_EXECUTION_ERROR: 500004,
    INCONSISTENT_APPLICATION_STATE: 500007,
    NOT_IMPLEMENTED: 501001,
    SERVER_NOT_CONFIGURED_FOR_REQUEST: 501002,
    UPSTREAM_PROXY_ERROR: 502001,
    UPSTREAM_PROXY_TIMEOUT: 504001,
} as const;

/** Galaxy's error response body. */
export interface ErrorEnvelope {
    err_msg: string;
    err_code: number;
    [extra: string]: unknown;
}

const DEFAULT_CODES: Record<number, number> = {
    400: ErrorCodes.USER_REQUEST_INVALID_PARAMETER,
    401: ErrorCodes.USER_AUTHENTICATION_FAILED,
    403: ErrorCodes.USER_CANNOT_ACCESS_ITEM,
    404: ErrorCodes.USER_OBJECT_NOT_FOUND,
    409: ErrorCodes.CONFLICT,
    410: ErrorCodes.DEPRECATED_API_CALL,
    429: ErrorCodes.TOO_MANY_REQUESTS,
    500: ErrorCodes.INTERNAL_SERVER_ERROR,
    501: ErrorCodes.NOT_IMPLEMENTED,
    502: ErrorCodes.UPSTREAM_PROXY_ERROR,
    504: ErrorCodes.UPSTREAM_PROXY_TIMEOUT,
};

/** Returns the Galaxy error code Galaxy uses by default for an HTTP status (0 when there is none). */
export function defaultErrorCode(status: number): number {
    return DEFAULT_CODES[status] ?? ErrorCodes.UNKNOWN;
}

/**
 * An error that becomes a Galaxy error response (`{err_msg, err_code, ...extra}` with `status`).
 * Throw it from handlers or repository code; the router converts it.
 */
export class ApiError extends Error {
    readonly status: number;
    readonly errCode: number;
    readonly extra: Readonly<Record<string, unknown>>;

    constructor(status: number, message: string, errCode?: number, extra: Record<string, unknown> = {}) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.errCode = errCode ?? defaultErrorCode(status);
        this.extra = extra;
    }

    /** The response body. */
    toEnvelope(): ErrorEnvelope {
        return { ...this.extra, err_msg: this.message, err_code: this.errCode };
    }

    /** 400 with `USER_REQUEST_INVALID_PARAMETER` unless another code is given. */
    static badRequest(message: string, errCode: number = ErrorCodes.USER_REQUEST_INVALID_PARAMETER): ApiError {
        return new ApiError(400, message, errCode);
    }

    /** 400 `USER_REQUEST_MISSING_PARAMETER`. */
    static missingParameter(message: string): ApiError {
        return new ApiError(400, message, ErrorCodes.USER_REQUEST_MISSING_PARAMETER);
    }

    /** 403 `USER_CANNOT_ACCESS_ITEM` unless another code is given. */
    static forbidden(message: string, errCode: number = ErrorCodes.USER_CANNOT_ACCESS_ITEM): ApiError {
        return new ApiError(403, message, errCode);
    }

    /** 404 `USER_OBJECT_NOT_FOUND`. */
    static notFound(message = "No such object found."): ApiError {
        return new ApiError(404, message, ErrorCodes.USER_OBJECT_NOT_FOUND);
    }

    /** 409 `CONFLICT`. */
    static conflict(message: string): ApiError {
        return new ApiError(409, message, ErrorCodes.CONFLICT);
    }

    /** 501 `NOT_IMPLEMENTED`. */
    static notImplemented(message = "Method is not implemented."): ApiError {
        return new ApiError(501, message, ErrorCodes.NOT_IMPLEMENTED);
    }
}
