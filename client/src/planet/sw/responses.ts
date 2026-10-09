/**
 * Response helpers for Service Worker handlers. The router adds `X-Request-ID`, `Cache-Control: no-store`
 * and `X-Content-Type-Options: nosniff` to every response, including ones built here.
 */

import { type ApiError, defaultErrorCode, type ErrorEnvelope } from "@/planet/util/errors";
import { newRequestId } from "@/planet/util/ids";

import { DOCUMENT_CSP } from "./csp";

declare const responseBody: unique symbol;

/** A Response whose JSON body has type `T`. Typed routes return these from the helpers below. */
export type TypedResponse<T> = Response & { readonly [responseBody]: T };

export interface ResponseOptions {
    status?: number;
    statusText?: string;
    headers?: HeadersInit;
}

export interface HtmlOptions extends ResponseOptions {
    /** Content-Security-Policy for the document. Defaults to {@link DOCUMENT_CSP}. */
    csp?: string;
}

function withHeaders(base: HeadersInit | undefined, defaults: Record<string, string>): Headers {
    const headers = new Headers(base);
    for (const [name, value] of Object.entries(defaults)) {
        if (!headers.has(name)) {
            headers.set(name, value);
        }
    }
    return headers;
}

/** A JSON response (200 by default). `undefined` is sent as `null`. */
export function json<T>(data: T, options: ResponseOptions = {}): TypedResponse<T> {
    const headers = withHeaders(options.headers, { "Content-Type": "application/json" });
    const body = JSON.stringify(data === undefined ? null : data);
    return new Response(body, {
        status: options.status ?? 200,
        statusText: options.statusText,
        headers,
    }) as TypedResponse<T>;
}

/**
 * A Galaxy error response: `{err_msg, err_code, ...extra}`. `errCode` defaults to Galaxy's code for the
 * status (404 → 404001, 400 → 400008, 500 → 500001).
 */
export function error(
    status: number,
    errMsg: string,
    errCode: number = defaultErrorCode(status),
    extra: Record<string, unknown> = {},
    headers?: HeadersInit,
): TypedResponse<never> {
    const envelope: ErrorEnvelope = { ...extra, err_msg: errMsg, err_code: errCode };
    return json(envelope, { status, headers }) as unknown as TypedResponse<never>;
}

/** Converts an {@link ApiError} to its response. */
export function errorFrom(apiError: ApiError): TypedResponse<never> {
    return json(apiError.toEnvelope(), { status: apiError.status }) as unknown as TypedResponse<never>;
}

/** 204 No Content. */
export function noContent(headers?: HeadersInit): TypedResponse<never> {
    return new Response(null, { status: 204, headers }) as TypedResponse<never>;
}

/** A redirect (302 by default) to `location`, which may be relative to the request. */
export function redirect(location: string, status: 301 | 302 | 303 | 307 | 308 = 302): TypedResponse<never> {
    return new Response(null, { status, headers: { Location: location } }) as TypedResponse<never>;
}

/** A text response (`text/plain; charset=utf-8` unless a Content-Type header is given). */
export function text(body: string, options: ResponseOptions = {}): TypedResponse<never> {
    const headers = withHeaders(options.headers, { "Content-Type": "text/plain; charset=utf-8" });
    return new Response(body, {
        status: options.status ?? 200,
        statusText: options.statusText,
        headers,
    }) as TypedResponse<never>;
}

/** An HTML document with its own Content-Security-Policy. */
export function html(body: string, options: HtmlOptions = {}): TypedResponse<never> {
    const headers = withHeaders(options.headers, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": options.csp ?? DOCUMENT_CSP,
    });
    return new Response(body, {
        status: options.status ?? 200,
        statusText: options.statusText,
        headers,
    }) as TypedResponse<never>;
}

/** Marks a Response built elsewhere (for example a cached or fetched one) as acceptable for any route. */
export function passthrough(response: Response): TypedResponse<never> {
    return response as TypedResponse<never>;
}

const STANDARD_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
} as const;

/**
 * Adds a fresh `X-Request-ID`, `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. Copies the
 * response when its headers are immutable (fetched or `Response.redirect` responses).
 */
export function finalize(response: Response): Response {
    const requestId = newRequestId();
    try {
        response.headers.set("X-Request-ID", requestId);
        for (const [name, value] of Object.entries(STANDARD_HEADERS)) {
            response.headers.set(name, value);
        }
        return response;
    } catch {
        const headers = new Headers(response.headers);
        headers.set("X-Request-ID", requestId);
        for (const [name, value] of Object.entries(STANDARD_HEADERS)) {
            headers.set(name, value);
        }
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }
}
