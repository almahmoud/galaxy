/**
 * Removes presigned-request credentials from text a pod produced (logs, termination messages, streams, messages)
 * before the browser stores it: the query of every URL that carries SigV4 parameters, and stray `X-Amz-*`
 * parameters or `Signature=` values outside a URL (for example a URL split across lines or percent-encoded).
 */

const REDACTED = "[redacted]";
const URL_PATTERN = /\b(https?:\/\/[^\s?#"'<>]*)\?([^\s"'<>]*)/gi;
const SIGNED_QUERY = /x-amz-|signature=|awsaccesskeyid=/i;
const AMZ_PARAMETER = /\b(x-amz-[a-z0-9-]+)(=|%3d)[^&\s"'<>]*/gi;
const SIGNATURE_VALUE = /\b(signature)(=|%3d)[0-9a-f]{16,}/gi;

/** `text` with the credentials of presigned requests replaced by `[redacted]`. */
export function redactSignedUrls(text: string): string;
export function redactSignedUrls(text: string | null): string | null;
export function redactSignedUrls(text: string | null): string | null {
    if (!text) {
        return text;
    }
    return text
        .replace(URL_PATTERN, (match, base: string, query: string) =>
            SIGNED_QUERY.test(query) ? `${base}?${REDACTED}` : match,
        )
        .replace(AMZ_PARAMETER, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`)
        .replace(SIGNATURE_VALUE, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`);
}
