/** Content-Security-Policy values for documents the Service Worker builds. */

export type CspDirectives = Readonly<Record<string, readonly string[]>>;

/** Planet's document policy (architecture: Hosting). */
export const DOCUMENT_CSP_DIRECTIVES: CspDirectives = {
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "connect-src": ["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"],
    "frame-src": ["'self'", "blob:"],
    "worker-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'self'"],
};

/**
 * Serializes directives, appending `extra` sources to the named directives (for example the S3 origin
 * to `img-src`). A directive with no sources is written bare (`sandbox`).
 */
export function buildCsp(directives: CspDirectives, extra: CspDirectives = {}): string {
    const merged = new Map<string, string[]>();
    for (const [name, sources] of Object.entries(directives)) {
        merged.set(name, [...sources]);
    }
    for (const [name, sources] of Object.entries(extra)) {
        const current = merged.get(name) ?? [];
        merged.set(name, [...current, ...sources.filter((source) => !current.includes(source))]);
    }
    return [...merged].map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
}

/** {@link DOCUMENT_CSP_DIRECTIVES} as a header value. */
export const DOCUMENT_CSP = buildCsp(DOCUMENT_CSP_DIRECTIVES);
