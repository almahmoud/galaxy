/**
 * Python regular expressions of tool validators and option filters (`re.match` semantics), translated to
 * JavaScript where both engines agree and checked in the Service Worker. Anything else is undecided, which callers
 * must never treat as a match:
 * - syntax JavaScript lacks or reads differently (`(?x)`, conditionals, atomic groups, backreferences, `\N{...}`, ...),
 *   patterns JavaScript cannot compile and patterns over {@link MAX_PATTERN_LENGTH} characters;
 * - inputs longer than {@link MAX_PATTERN_INPUT}, or than {@link RISKY_PATTERN_INPUT} for long patterns and patterns
 *   whose repetitions can match the same text in many ways (catastrophic backtracking blocks the worker).
 *
 * Translation keeps Python's meaning: `\w`, `\d`, `\s` and `\b` are Unicode-aware (`a` flag: ASCII), `.` excludes
 * only `\n`, `$` also matches before a final newline, `\A`/`\Z` anchor the whole string, `{,n}` is `{0,n}`.
 */

/** Longest input any pattern is run on. */
export const MAX_PATTERN_INPUT = 10_000;
/** Longest input a long or ambiguous pattern is run on: short enough that exponential backtracking stays cheap. */
export const RISKY_PATTERN_INPUT = 24;
/** Patterns longer than this count as risky. */
export const MAX_SAFE_PATTERN_LENGTH = 1000;
/** Patterns longer than this are not translated at all (undecided). */
export const MAX_PATTERN_LENGTH = 10_000;

export interface PythonPattern {
    regex: RegExp;
    /** Inputs longer than this are undecided. */
    inputLimit: number;
}

class Unsupported extends Error {}

type Node =
    | { type: "seq"; items: Node[] }
    | { type: "alt"; options: Node[] }
    | { type: "group"; body: Node; open: string }
    | { type: "look"; body: Node; open: string }
    | { type: "repeat"; node: Node; min: number; max: number; suffix: string }
    | { type: "atom"; js: string }
    | { type: "assert"; js: string };

interface Flags {
    ignoreCase: boolean;
    multiline: boolean;
    dotAll: boolean;
    ascii: boolean;
}

const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAMPLE = [
    ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)),
    "\t",
    "\n",
    "\r",
    "é",
    "ß",
    "Ω",
    "中",
    " ",
    "٣",
    "\u{1f600}",
];

function hex(text: string, length: number): boolean {
    return text.length === length && /^[0-9a-fA-F]+$/.test(text);
}

class Translator {
    private i = 0;
    private readonly names = new Set<string>();

    constructor(
        private readonly src: string,
        private readonly flags: Flags,
    ) {}

    parse(): Node {
        const node = this.alternation();
        if (this.i < this.src.length) {
            throw new Unsupported("unbalanced parenthesis");
        }
        return node;
    }

    private peek(offset = 0): string | undefined {
        return this.src[this.i + offset];
    }

    private alternation(): Node {
        const options = [this.sequence()];
        while (this.peek() === "|") {
            this.i++;
            options.push(this.sequence());
        }
        return options.length === 1 ? options[0]! : { type: "alt", options };
    }

    private sequence(): Node {
        const items: Node[] = [];
        while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
            const atom = this.atom();
            if (atom) {
                items.push(this.quantified(atom));
            }
        }
        return { type: "seq", items };
    }

    /** `{m}`, `{m,}`, `{,n}` or `{m,n}` at the current position, or null when `{` is a literal there. */
    private braces(): { min: number; max: number; length: number } | null {
        const match = /^\{(\d*)(,?)(\d*)\}/.exec(this.src.slice(this.i));
        if (!match || (!match[1] && !match[3]) || (!match[2] && !match[1])) {
            return null;
        }
        const min = match[1] ? Number(match[1]) : 0;
        const max = match[2] ? (match[3] ? Number(match[3]) : Infinity) : min;
        if (max < min) {
            throw new Unsupported("min repeat greater than max repeat");
        }
        return { min, max, length: match[0].length };
    }

    private quantifierAhead(): boolean {
        const char = this.peek();
        return char === "*" || char === "+" || char === "?" || (char === "{" && this.braces() !== null);
    }

    private quantified(node: Node): Node {
        let min: number;
        let max: number;
        const char = this.peek();
        if (char === "*" || char === "+" || char === "?") {
            this.i++;
            [min, max] = char === "*" ? [0, Infinity] : char === "+" ? [1, Infinity] : [0, 1];
        } else if (char === "{" && this.braces()) {
            const braces = this.braces()!;
            this.i += braces.length;
            ({ min, max } = braces);
        } else {
            return node;
        }
        if (node.type === "assert" || node.type === "look") {
            throw new Unsupported("nothing to repeat");
        }
        let suffix = "";
        if (this.peek() === "?") {
            this.i++;
            suffix = "?";
        } else if (this.peek() === "+") {
            throw new Unsupported("possessive quantifier");
        }
        if (this.quantifierAhead()) {
            throw new Unsupported("multiple repeat");
        }
        return { type: "repeat", node, min, max, suffix };
    }

    private atom(): Node | null {
        const char = this.src.codePointAt(this.i)!;
        const text = String.fromCodePoint(char);
        switch (text) {
            case "(":
                return this.group();
            case "[":
                return this.characterClass();
            case ".":
                this.i++;
                return { type: "atom", js: this.flags.dotAll ? "[\\s\\S]" : "[^\\n]" };
            case "^":
                this.i++;
                return { type: "assert", js: this.flags.multiline ? "(?<![^\\n])" : "^" };
            case "$":
                this.i++;
                return { type: "assert", js: this.flags.multiline ? "(?![^\\n])" : "(?=\\n?(?![\\s\\S]))" };
            case "\\":
                return this.escape();
            case "*":
            case "+":
            case "?":
                throw new Unsupported("nothing to repeat");
            case "{":
                if (this.braces()) {
                    throw new Unsupported("nothing to repeat");
                }
                break;
        }
        this.i += text.length;
        return { type: "atom", js: this.literal(text) };
    }

    private literal(text: string): string {
        return SYNTAX.has(text) ? `\\${text}` : text;
    }

    private group(): Node | null {
        this.i++;
        let open = "(";
        let look = false;
        if (this.peek() === "?") {
            const rest = this.src.slice(this.i + 1);
            if (rest.startsWith(":")) {
                open = "(?:";
            } else if (rest.startsWith("=") || rest.startsWith("!")) {
                open = `(?${rest[0]}`;
                look = true;
            } else if (rest.startsWith("<=") || rest.startsWith("<!")) {
                open = `(?${rest.slice(0, 2)}`;
                look = true;
            } else if (rest.startsWith("P<")) {
                const end = rest.indexOf(">");
                const name = end > 2 ? rest.slice(2, end) : "";
                if (!NAME.test(name) || this.names.has(name)) {
                    throw new Unsupported("bad group name");
                }
                this.names.add(name);
                // Python's `?P<name>` is one character longer than JavaScript's `?<name>`.
                this.i += 1;
                open = `(?<${name}>`;
            } else if (rest.startsWith("#")) {
                const end = this.src.indexOf(")", this.i);
                if (end < 0) {
                    throw new Unsupported("missing ), unterminated comment");
                }
                this.i = end + 1;
                return null;
            } else {
                // Backreferences, conditionals, atomic groups and inline flags.
                throw new Unsupported("unsupported group");
            }
            this.i += open.length - 1;
        }
        const body = this.alternation();
        if (this.peek() !== ")") {
            throw new Unsupported("missing )");
        }
        this.i++;
        return look ? { type: "look", body, open } : { type: "group", body, open };
    }

    /** `\w`, `\d`, `\s` (and inside a class, without brackets) in Python's meaning. */
    private classEscape(letter: string, inClass: boolean): string | null {
        const { ascii } = this.flags;
        const sets: Record<string, string> = {
            d: ascii ? "0-9" : "\\p{Nd}",
            w: ascii ? "A-Za-z0-9_" : "\\p{L}\\p{N}_",
            s: ascii ? "\\t\\n\\x0b\\x0c\\r " : PY_SPACE,
        };
        const lower = letter.toLowerCase();
        if (!Object.hasOwn(sets, lower)) {
            return null;
        }
        if (letter === lower) {
            return inClass ? sets[lower]! : `[${sets[lower]}]`;
        }
        if (inClass) {
            throw new Unsupported("negated class escape inside a set");
        }
        return `[^${sets[lower]}]`;
    }

    /** A single-character escape (`\n`, `\x41`, `\.`), as JavaScript text, or null when it is not one. */
    private charEscape(inClass: boolean): string | null {
        const letter = this.src[this.i + 1];
        if (letter === undefined) {
            throw new Unsupported("bad escape (end of pattern)");
        }
        const simple: Record<string, string> = { n: "\\n", r: "\\r", t: "\\t", f: "\\f", v: "\\v", a: "\\x07" };
        if (Object.hasOwn(simple, letter)) {
            this.i += 2;
            return simple[letter]!;
        }
        if (letter === "x" || letter === "u" || letter === "U") {
            const length = letter === "x" ? 2 : letter === "u" ? 4 : 8;
            const digits = this.src.slice(this.i + 2, this.i + 2 + length);
            if (!hex(digits, length) || Number.parseInt(digits, 16) > 0x10ffff) {
                throw new Unsupported(`bad escape \\${letter}`);
            }
            this.i += 2 + length;
            return `\\u{${Number.parseInt(digits, 16).toString(16)}}`;
        }
        if (letter === "0") {
            const digits = /^0[0-7]{0,2}/.exec(this.src.slice(this.i + 1))![0];
            this.i += 1 + digits.length;
            return `\\u{${Number.parseInt(digits, 8).toString(16)}}`;
        }
        if (/[0-9A-Za-z]/.test(letter)) {
            return null;
        }
        const text = String.fromCodePoint(this.src.codePointAt(this.i + 1)!);
        this.i += 1 + text.length;
        return inClass ? this.classLiteral(text) : this.literal(text);
    }

    private escape(): Node {
        const letter = this.src[this.i + 1] ?? "";
        const word = this.classEscape("w", true);
        const boundaries: Record<string, string> = {
            A: "(?<![\\s\\S])",
            Z: "(?![\\s\\S])",
            b: `(?:(?<=[${word}])(?![${word}])|(?<![${word}])(?=[${word}]))`,
            B: `(?:(?<=[${word}])(?=[${word}])|(?<![${word}])(?![${word}]))`,
        };
        if (Object.hasOwn(boundaries, letter)) {
            this.i += 2;
            return { type: "assert", js: boundaries[letter]! };
        }
        const set = this.classEscape(letter, false);
        if (set) {
            this.i += 2;
            return { type: "atom", js: set };
        }
        const char = this.charEscape(false);
        if (char === null) {
            // Backreferences (`\1`), `\N{...}`, `\g` and unknown escapes.
            throw new Unsupported(`unsupported escape \\${letter}`);
        }
        return { type: "atom", js: char };
    }

    private classLiteral(text: string): string {
        return "\\]-[^".includes(text) ? `\\${text}` : text;
    }

    /** One member of a set: a character (returned for ranges) or a class escape (null). */
    private classMember(): { js: string; single: boolean } {
        if (this.peek() === "\\") {
            const letter = this.src[this.i + 1] ?? "";
            if (letter === "b") {
                this.i += 2;
                return { js: "\\x08", single: true };
            }
            const set = this.classEscape(letter, true);
            if (set) {
                this.i += 2;
                return { js: set, single: false };
            }
            const char = this.charEscape(true);
            if (char === null) {
                throw new Unsupported(`unsupported escape \\${letter} in a set`);
            }
            return { js: char, single: true };
        }
        const text = String.fromCodePoint(this.src.codePointAt(this.i)!);
        this.i += text.length;
        return { js: this.classLiteral(text), single: true };
    }

    private characterClass(): Node {
        this.i++;
        let js = "[";
        if (this.peek() === "^") {
            js += "^";
            this.i++;
        }
        let first = true;
        while (this.peek() !== "]" || first) {
            if (this.peek() === undefined) {
                throw new Unsupported("unterminated character set");
            }
            if (first && this.peek() === "]") {
                this.i++;
                js += "\\]";
                first = false;
                continue;
            }
            first = false;
            const start = this.classMember();
            if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
                this.i++;
                const end = this.classMember();
                if (!start.single || !end.single) {
                    throw new Unsupported("bad character range");
                }
                js += `${start.js}-${end.js}`;
            } else {
                js += start.js;
            }
        }
        this.i++;
        return { type: "atom", js: `${js}]` };
    }
}

function emit(node: Node): string {
    switch (node.type) {
        case "seq":
            return node.items.map(emit).join("");
        case "alt":
            return node.options.map(emit).join("|");
        case "group":
        case "look":
            return `${node.open}${emit(node.body)})`;
        case "repeat": {
            const inner =
                node.node.type === "seq" || node.node.type === "alt" ? `(?:${emit(node.node)})` : emit(node.node);
            const max = node.max === Infinity ? "" : String(node.max);
            const range = node.min === node.max ? `{${node.min}}` : `{${node.min},${max}}`;
            return `${inner}${range}${node.suffix}`;
        }
        case "atom":
        case "assert":
            return node.js;
    }
}

// ---------------------------------------------------------------------------------------------------------
// Backtracking risk

/** The character a literal atom matches, or null for other nodes. */
function literalChar(node: Node): string | null {
    if (node.type !== "atom") {
        return null;
    }
    const chars = [...node.js];
    if (chars.length === 1) {
        return node.js;
    }
    return chars.length === 2 && chars[0] === "\\" && !/[0-9A-Za-z]/.test(chars[1]!) ? chars[1]! : null;
}

class Risk {
    private readonly cache = new Map<string, RegExp>();

    constructor(private readonly ignoreCase: boolean) {}

    /** Whether a node can consume the character `char` (zero-width nodes cannot). */
    canMatch(node: Node, char: string): boolean {
        switch (node.type) {
            case "atom": {
                let regex = this.cache.get(node.js);
                if (!regex) {
                    regex = new RegExp(`^(?:${node.js})$`, this.ignoreCase ? "ui" : "u");
                    this.cache.set(node.js, regex);
                }
                return regex.test(char);
            }
            case "seq":
                return node.items.some((item) => this.canMatch(item, char));
            case "alt":
                return node.options.some((option) => this.canMatch(option, char));
            case "group":
                return this.canMatch(node.body, char);
            case "repeat":
                return this.canMatch(node.node, char);
            case "look":
            case "assert":
                return false;
        }
    }

    /** True when the pattern has a repetition whose iterations can split the same text in many ways. */
    risky(node: Node): boolean {
        switch (node.type) {
            case "seq":
                return node.items.some((item) => this.risky(item));
            case "alt":
                return node.options.some((option) => this.risky(option));
            case "group":
            case "look":
                return this.risky(node.body);
            case "repeat":
                return (node.max > 1 && !this.unambiguous(node.node)) || this.risky(node.node);
            default:
                return false;
        }
    }

    private flexible(node: Node): boolean {
        switch (node.type) {
            case "repeat":
                return node.max > 1 || this.flexible(node.node);
            case "alt":
                return true;
            case "seq":
                return node.items.some((item) => this.flexible(item));
            case "group":
                return this.flexible(node.body);
            default:
                return false;
        }
    }

    /** Whether repeating `node` matches any text in at most one way, as far as cheap checks tell. */
    private unambiguous(node: Node): boolean {
        if (node.type === "group") {
            return this.unambiguous(node.body);
        }
        if (!this.flexible(node)) {
            return true;
        }
        if (node.type === "seq") {
            // A literal no other part matches delimits every iteration.
            return node.items.some((item, index) => {
                const char = literalChar(item);
                return char !== null && !node.items.some((other, j) => j !== index && this.canMatch(other, char));
            });
        }
        if (node.type === "alt") {
            const firsts = node.options.map((option) => this.first(option));
            if (firsts.some((first) => first === null)) {
                return false;
            }
            // Alternatives are told apart by their first character when no sample character starts two of them.
            const disjoint = SAMPLE.every((char) => firsts.filter((first) => this.canMatch(first!, char)).length <= 1);
            return disjoint && node.options.every((option) => !this.flexible(option) || this.unambiguous(option));
        }
        return false;
    }

    /** The node that consumes the first character of `node`, or null when that is not fixed. */
    private first(node: Node): Node | null {
        switch (node.type) {
            case "atom":
                return node;
            case "group":
                return this.first(node.body);
            case "repeat":
                return node.min > 0 ? this.first(node.node) : null;
            case "seq": {
                const item = node.items.find((each) => each.type !== "assert" && each.type !== "look");
                return item ? this.first(item) : null;
            }
            default:
                return null;
        }
    }
}

/**
 * Translates and compiles a Python pattern for `re.match` semantics (anchored at the start, sticky).
 *
 * @returns null when the pattern is undecided: Python syntax JavaScript cannot express, or not compilable
 */
export function compilePythonPattern(expression: string): PythonPattern | null {
    if (expression.length > MAX_PATTERN_LENGTH) {
        return null;
    }
    const flags: Flags = { ignoreCase: false, multiline: false, dotAll: false, ascii: false };
    let source = expression;
    for (let match = /^\(\?([aiLmsux]+)\)/.exec(source); match; match = /^\(\?([aiLmsux]+)\)/.exec(source)) {
        for (const flag of match[1]!) {
            if (flag === "L" || flag === "x") {
                return null;
            }
            flags.ignoreCase ||= flag === "i";
            flags.multiline ||= flag === "m";
            flags.dotAll ||= flag === "s";
            flags.ascii ||= flag === "a";
        }
        source = source.slice(match[0].length);
    }
    try {
        const tree = new Translator(source, flags).parse();
        const regex = new RegExp(emit(tree), flags.ignoreCase ? "uyi" : "uy");
        const risky = expression.length > MAX_SAFE_PATTERN_LENGTH || new Risk(flags.ignoreCase).risky(tree);
        return { regex, inputLimit: risky ? RISKY_PATTERN_INPUT : MAX_PATTERN_INPUT };
    } catch {
        return null;
    }
}

const compiled = new Map<string, PythonPattern | null>();
const CACHE_SIZE = 256;

/** {@link compilePythonPattern}, cached by expression. */
export function compiledPattern(expression: string): PythonPattern | null {
    let pattern = compiled.get(expression);
    if (pattern === undefined) {
        pattern = compilePythonPattern(expression);
        if (compiled.size >= CACHE_SIZE) {
            compiled.clear();
        }
        compiled.set(expression, pattern);
    }
    return pattern;
}

/**
 * `re.match(pattern, value) is not None`.
 *
 * @returns undefined when undecided (no pattern, or an input over the pattern's limit)
 */
export function pythonMatch(pattern: PythonPattern | null, value: string): boolean | undefined {
    if (!pattern || value.length > pattern.inputLimit) {
        return undefined;
    }
    pattern.regex.lastIndex = 0;
    return pattern.regex.test(value);
}
