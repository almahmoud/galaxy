/**
 * Runs only for requests that match no static asset and are not navigations
 * (navigations get index.html without invoking this script). Galaxy's API is
 * served by Planet's service worker; a request reaching this script means the
 * page is not controlled by it, so it gets a Galaxy-style JSON error, never
 * index.html.
 */

const BACKEND_PREFIXES = ["/api/", "/history/", "/dataset/", "/datasets/"];
const BACKEND_PATHS = new Set(["/context", "/api", "/history", "/dataset", "/datasets"]);

export const NOT_ACTIVE = {
    status: 503,
    err_msg: "Planet's service worker is not active; reload the page",
    err_code: 503001,
};

export const NOT_FOUND = {
    status: 404,
    err_msg: "No such file",
    err_code: 404001,
};

export function isBackendPath(pathname) {
    return BACKEND_PATHS.has(pathname) || BACKEND_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function requestId() {
    return crypto.randomUUID().replaceAll("-", "");
}

export function errorResponse(request, { status, err_msg, err_code }) {
    const body = request.method === "HEAD" ? null : JSON.stringify({ err_msg, err_code });
    return new Response(body, {
        status,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-Request-ID": requestId(),
        },
    });
}

export default {
    async fetch(request, env) {
        const { pathname } = new URL(request.url);
        // html_handling "none" does not map "/" to index.html; navigations to "/" never reach this script.
        if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
            return env.ASSETS.fetch(new Request(new URL("/index.html", request.url), request));
        }
        return errorResponse(request, isBackendPath(pathname) ? NOT_ACTIVE : NOT_FOUND);
    },
};
