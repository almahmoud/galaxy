/**
 * Python value semantics the tool layer reproduces: `str()` of numbers, `int()` and `float()` parsing, Galaxy's
 * `string_as_bool` helpers and parameter sanitization (`galaxy.util.sanitize_param`, `ToolParameterSanitizer`).
 */

/** `repr(x)` (and `str(x)`) of a Python float. */
export function pyFloatRepr(value: number): string {
    if (Number.isNaN(value)) {
        return "nan";
    }
    if (!Number.isFinite(value)) {
        return value > 0 ? "inf" : "-inf";
    }
    if (value === 0) {
        return Object.is(value, -0) ? "-0.0" : "0.0";
    }
    // `toExponential()` without digits gives the shortest round-trip significand, as Python's repr does.
    const [mantissa = "", exponentText = "0"] = value.toExponential().split("e");
    const exponent = Number(exponentText);
    const sign = mantissa.startsWith("-") ? "-" : "";
    const digits = mantissa.replace("-", "").replace(".", "");
    if (exponent >= -4 && exponent < 16) {
        if (exponent >= 0) {
            const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
            const fraction = digits.slice(exponent + 1);
            return `${sign}${whole}.${fraction || "0"}`;
        }
        return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
    }
    const significand = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const exponentSign = exponent < 0 ? "-" : "+";
    return `${sign}${significand}e${exponentSign}${String(Math.abs(exponent)).padStart(2, "0")}`;
}

/** `str(x)` of a JSON-like value; numbers are formatted as Python ints when integral. */
export function pyStr(value: unknown): string {
    if (value === null || value === undefined) {
        return "None";
    }
    if (typeof value === "boolean") {
        return value ? "True" : "False";
    }
    if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
    }
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        return `[${value.map(pyRepr).join(", ")}]`;
    }
    return String(value);
}

/** `repr(x)` of a JSON-like value. */
export function pyRepr(value: unknown): string {
    if (typeof value === "string") {
        const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
        const escaped = value
            .replace(/\\/g, "\\\\")
            .replace(/\n/g, "\\n")
            .replace(/\r/g, "\\r")
            .replace(/\t/g, "\\t")
            .replace(new RegExp(quote, "g"), `\\${quote}`);
        return `${quote}${escaped}${quote}`;
    }
    return pyStr(value);
}

const INT_PATTERN = /^[+-]?\d+(?:_\d+)*$/;
const FLOAT_PATTERN = /^[+-]?(?:(?:\d+(?:_\d+)*)?\.\d+(?:_\d+)*|\d+(?:_\d+)*\.?)(?:[eE][+-]?\d+(?:_\d+)*)?$/;
const SPECIAL_FLOAT_PATTERN = /^([+-]?)(inf|infinity|nan)$/i;

/** `int(x)`, or undefined where Python raises `TypeError` or `ValueError`. */
export function pyInt(value: unknown): number | undefined {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (typeof value === "number") {
        return Number.isFinite(value) ? Math.trunc(value) : undefined;
    }
    if (typeof value === "string") {
        const text = value.trim();
        if (!INT_PATTERN.test(text)) {
            return undefined;
        }
        const parsed = Number(text.replace(/_/g, ""));
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    }
    return undefined;
}

/** `float(x)`, or undefined where Python raises `TypeError` or `ValueError`. */
export function pyFloat(value: unknown): number | undefined {
    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        const text = value.trim();
        const special = SPECIAL_FLOAT_PATTERN.exec(text);
        if (special) {
            if (special[2]!.toLowerCase() === "nan") {
                return Number.NaN;
            }
            return special[1] === "-" ? -Infinity : Infinity;
        }
        return FLOAT_PATTERN.test(text) ? Number(text.replace(/_/g, "")) : undefined;
    }
    return undefined;
}

/** Python truthiness of a JSON-like value. */
export function pyTruthy(value: unknown): boolean {
    if (value === null || value === undefined || value === false || value === 0 || value === "") {
        return false;
    }
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    if (value instanceof Map) {
        return value.size > 0;
    }
    return true;
}

/** Galaxy's `util.string_as_bool`. */
export function stringAsBool(value: unknown): boolean {
    return ["true", "yes", "on", "1"].includes(pyStr(value).toLowerCase());
}

/** Galaxy's `util.string_as_bool_or_none`. */
export function stringAsBoolOrNone(value: unknown): boolean | null {
    const text = pyStr(value).toLowerCase();
    if (["true", "yes", "on"].includes(text)) {
        return true;
    }
    return ["none", "null"].includes(text) ? null : false;
}

/** Galaxy's `util.listify`: falsy values give `[]`, strings are split on commas. */
export function listify(value: unknown, strip = false): unknown[] {
    if (!pyTruthy(value)) {
        return [];
    }
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parts = value.split(",");
        return strip ? parts.map((part) => part.trim()) : parts;
    }
    return [value];
}

// ---------------------------------------------------------------------------------------------------------
// Sanitization

const ASCII_LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
const ASCII_UPPERCASE = ASCII_LOWERCASE.toUpperCase();
const DIGITS = "0123456789";
const PUNCTUATION = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const WHITESPACE = " \t\n\r\x0b\x0c";

/** Python's `string` module constants usable as sanitizer presets. */
const STRING_CONSTANTS: Record<string, string> = {
    ascii_letters: ASCII_LOWERCASE + ASCII_UPPERCASE,
    ascii_lowercase: ASCII_LOWERCASE,
    ascii_uppercase: ASCII_UPPERCASE,
    digits: DIGITS,
    hexdigits: `${DIGITS}abcdefABCDEF`,
    octdigits: "01234567",
    punctuation: PUNCTUATION,
    printable: DIGITS + ASCII_LOWERCASE + ASCII_UPPERCASE + PUNCTUATION + WHITESPACE,
    whitespace: WHITESPACE,
};

const DEFAULT_VALID = `${ASCII_LOWERCASE}${ASCII_UPPERCASE}${DIGITS} -=_.()/+*^,:?!`;

/** `galaxy.util.mapped_chars`. */
const DEFAULT_MAPPING: Readonly<Record<string, string>> = {
    ">": "__gt__",
    "<": "__lt__",
    "'": "__sq__",
    '"': "__dq__",
    "[": "__ob__",
    "]": "__cb__",
    "{": "__oc__",
    "}": "__cc__",
    "@": "__at__",
    "\n": "__cn__",
    "\r": "__cr__",
    "\t": "__tc__",
    "#": "__pd__",
};

/** A tool parameter's `<sanitizer>` as the bundle describes it. */
export interface SanitizerDefinition {
    invalid_char?: string;
    sanitize?: boolean;
    valid?: { initial?: string; actions?: Record<string, string>[] }[];
    mapping?: { initial?: string; actions?: Record<string, string>[] }[];
}

/** Characters kept, characters replaced, and the replacement for everything else. */
export interface Sanitizer {
    readonly enabled: boolean;
    readonly valid: ReadonlySet<string>;
    readonly mapping: ReadonlyMap<string, string>;
    readonly invalid: string;
}

/** Galaxy's default sanitization (`galaxy.util.sanitize_param`). */
export const DEFAULT_SANITIZER: Sanitizer = {
    enabled: true,
    valid: new Set(DEFAULT_VALID),
    mapping: new Map(Object.entries(DEFAULT_MAPPING)),
    invalid: "X",
};

/** `ToolParameterSanitizer.get_valid_by_name`. */
function validPreset(name: string): string[] {
    const out: string[] = [];
    for (const part of name.split(",")) {
        const key = part.split(";", 1)[0]!.trim();
        let chars = "";
        if (key.startsWith("string.")) {
            let constant = key.slice("string.".length);
            if (["letters", "lowercase", "uppercase"].includes(constant)) {
                constant = `ascii_${constant}`;
            }
            chars = Object.hasOwn(STRING_CONSTANTS, constant) ? STRING_CONSTANTS[constant]! : "";
        } else if (key === "default") {
            chars = DEFAULT_VALID;
        }
        for (const char of chars) {
            if (!out.includes(char)) {
                out.push(char);
            }
        }
    }
    return out;
}

/** `ToolParameterSanitizer.get_mapping_by_name`. */
function mappingPreset(name: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of name.split(",")) {
        if (part.trim() === "default") {
            for (const [key, value] of Object.entries(DEFAULT_MAPPING)) {
                out.set(key, value);
            }
        }
    }
    return out;
}

/** Builds a sanitizer like `ToolParameterSanitizer.from_element`. */
export function buildSanitizer(definition: SanitizerDefinition): Sanitizer {
    let valid: string[] = [];
    let mapping = new Map<string, string>();
    for (const rule of definition.valid ?? []) {
        valid = validPreset(rule.initial ?? "default");
        for (const action of rule.actions ?? []) {
            const chars = [...validPreset(action.preset ?? "none"), ...(action.value ?? "")];
            if (action.action === "add") {
                for (const char of chars) {
                    if (!valid.includes(char)) {
                        valid.push(char);
                    }
                }
            } else if (action.action === "remove") {
                valid = valid.filter((char) => !chars.includes(char));
            }
        }
    }
    for (const rule of definition.mapping ?? []) {
        mapping = mappingPreset(rule.initial ?? "default");
        for (const action of rule.actions ?? []) {
            const preset = mappingPreset(action.preset ?? "none");
            if (action.action === "add") {
                for (const [key, value] of preset) {
                    mapping.set(key, value);
                }
                if (action.source !== undefined && action.target !== undefined) {
                    mapping.set(action.source, action.target);
                }
            } else if (action.action === "remove") {
                for (const key of preset.keys()) {
                    mapping.delete(key);
                }
            }
        }
    }
    return {
        enabled: definition.sanitize !== false,
        valid: new Set(valid),
        mapping,
        invalid: definition.invalid_char ?? "X",
    };
}

function sanitizeText(text: string, sanitizer: Sanitizer): string {
    let out = "";
    for (const char of text) {
        if (sanitizer.valid.has(char)) {
            out += char;
        } else {
            out += sanitizer.mapping.get(char) ?? sanitizer.invalid;
        }
    }
    return out;
}

/** `sanitize_param` with `sanitizer`: strings and lists of strings are cleaned, other values pass. */
export function sanitizeParam<T>(value: T, sanitizer: Sanitizer = DEFAULT_SANITIZER): T {
    if (!sanitizer.enabled) {
        return value;
    }
    if (typeof value === "string") {
        return sanitizeText(value, sanitizer) as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => (typeof item === "string" ? sanitizeText(item, sanitizer) : item)) as T;
    }
    return value;
}
