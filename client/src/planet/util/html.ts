const HTML_ESCAPES: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/** Escapes `&`, `<`, `>`, `"` and `'` so `value` is safe in HTML text and quoted attribute values. */
export function escapeHtml(value: unknown): string {
    return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!);
}
