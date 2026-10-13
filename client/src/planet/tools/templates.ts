/**
 * Renders the Cheetah templates of output labels and `change_format` checks when they only interpolate names:
 * `$name`, `${name}`, `$a.b.c` and `${a.b}`, with `\$` and `\#` escapes. Directives, comments, calls, subscripts and
 * expressions in `${...}` are left to the job's stage-in container, which renders the template with Cheetah; the
 * renderer then reports `undecided`.
 */

/** What a name lookup found: the text Cheetah would print, a name Cheetah would not find, or an unknown value. */
export type TemplateValue = { status: "value"; text: string } | { status: "missing" } | { status: "undecided" };

/** Resolves a dotted placeholder (`$a.b` gives `["a", "b"]`). */
export type TemplateLookup = (path: readonly string[]) => TemplateValue;

export type RenderResult =
    | { status: "value"; text: string }
    | { status: "missing"; name: string }
    | { status: "undecided"; reason: string };

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;
const DOTTED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Fills `template` like Cheetah's `fill_template` for the placeholder-only subset. */
export function renderTemplate(template: string, lookup: TemplateLookup): RenderResult {
    let out = "";
    let i = 0;
    while (i < template.length) {
        const char = template[i]!;
        const next = template[i + 1] ?? "";
        if (char === "\\" && (next === "$" || next === "#")) {
            out += next;
            i += 2;
            continue;
        }
        if (char === "#" && /[A-Za-z@{*#]/.test(next)) {
            return { status: "undecided", reason: "Cheetah directives and comments are not supported" };
        }
        if (char !== "$") {
            out += char;
            i++;
            continue;
        }
        let path: string[];
        if (next === "{") {
            const end = template.indexOf("}", i + 2);
            const inner = end === -1 ? "" : template.slice(i + 2, end).trim();
            if (!DOTTED_NAME.test(inner)) {
                return { status: "undecided", reason: "only names are supported inside ${...}" };
            }
            path = inner.split(".");
            i = end + 1;
        } else if (IDENTIFIER_START.test(next)) {
            let j = i + 1;
            path = [];
            for (;;) {
                let k = j;
                while (k < template.length && IDENTIFIER_PART.test(template[k]!)) {
                    k++;
                }
                path.push(template.slice(j, k));
                j = k;
                if (template[j] === "." && IDENTIFIER_START.test(template[j + 1] ?? "")) {
                    j++;
                    continue;
                }
                break;
            }
            if (template[j] === "(" || template[j] === "[") {
                return { status: "undecided", reason: "calls and subscripts are not supported" };
            }
            i = j;
        } else if (/[([!*]/.test(next)) {
            return { status: "undecided", reason: "Cheetah expressions are not supported" };
        } else {
            out += char;
            i++;
            continue;
        }
        const value = lookup(path);
        if (value.status === "missing") {
            return { status: "missing", name: path.join(".") };
        }
        if (value.status === "undecided") {
            return { status: "undecided", reason: `cannot render $${path.join(".")}` };
        }
        out += value.text;
    }
    return { status: "value", text: out };
}
