/**
 * Galaxy components use `href="javascript:void(0)"` on clickable anchors. Under the site's
 * `script-src 'self'` policy following such a link is a CSP violation, so the default action is
 * cancelled before it happens; the components' own click handlers still run.
 */
export function suppressJavascriptLinks(target: Document): void {
    target.addEventListener(
        "click",
        (event) => {
            const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
            const href = anchor?.getAttribute("href")?.trim().toLowerCase();
            if (href?.startsWith("javascript:")) {
                event.preventDefault();
            }
        },
        true,
    );
}
