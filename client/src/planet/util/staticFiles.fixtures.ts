/**
 * Looks a request path up in a test's static files as a static file server does: by the decoded path, so a file
 * listed as `1.9%2Bgalaxy0.json` is served for `1.9+galaxy0.json` and the other way round. Returns undefined when
 * no file matches.
 */
export function findStaticFile(files: Record<string, unknown>, pathname: string): unknown {
    const wanted = decodeURIComponent(pathname);
    for (const [path, body] of Object.entries(files)) {
        if (decodeURIComponent(path) === wanted) {
            return body;
        }
    }
    return undefined;
}
