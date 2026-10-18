/**
 * Python regular expressions of tool validators and option filters (`re.match` semantics), translated to
 * JavaScript where both engines agree and run in the Service Worker only when they provably match in linear time.
 * Anything else is undecided, which callers must never treat as a match:
 * - syntax JavaScript lacks or reads differently (`(?x)`, conditionals, atomic groups, backreferences, `\N{...}`, ...),
 *   patterns JavaScript cannot compile and patterns over {@link MAX_PATTERN_LENGTH} characters;
 * - patterns a backtracking engine may take more than linear time on (see {@link isLinear}), however short the input;
 * - inputs longer than {@link MAX_PATTERN_INPUT}.
 *
 * Translation keeps Python's meaning: `\w`, `\d`, `\s` and `\b` are Unicode-aware (`a` flag: ASCII), `.` excludes
 * only `\n`, `$` also matches before a final newline, `\A`/`\Z` anchor the whole string, `{,n}` is `{0,n}`.
 */

/** Longest input a pattern is run on. */
export const MAX_PATTERN_INPUT = 10_000;
/** Patterns longer than this are not translated at all (undecided). */
export const MAX_PATTERN_LENGTH = 1000;

export interface PythonPattern {
    regex: RegExp;
    /** Inputs longer than this are undecided. */
    inputLimit: number;
}

class Unsupported extends Error {}

// ---------------------------------------------------------------------------------------------------------
// Character sets

/** Code point ranges, sorted, disjoint and inclusive. */
type CharSet = readonly (readonly [number, number])[];

const MAX_CODE_POINT = 0x10ffff;
const ALL: CharSet = [[0, MAX_CODE_POINT]];
const NON_ASCII: CharSet = [[0x80, MAX_CODE_POINT]];
const ASCII_LETTERS: CharSet = [
    [0x41, 0x5a],
    [0x61, 0x7a],
];
const ASCII_DIGITS: CharSet = [[0x30, 0x39]];
/** The two non-ASCII characters case folding relates to ASCII letters: `ſ` (`s`) and the Kelvin sign (`k`). */
const LONG_S = 0x17f;
const KELVIN = 0x212a;
/** Non-ASCII characters other than {@link LONG_S} and {@link KELVIN}: their case variants are of the same kind. */
const OTHER_NON_ASCII: CharSet = [
    [0x80, LONG_S - 1],
    [LONG_S + 1, KELVIN - 1],
    [KELVIN + 1, MAX_CODE_POINT],
];
/** A superset of Unicode digits (`\p{Nd}`): no digit is a letter. */
const UNICODE_DIGITS: CharSet = [[0x30, 0x39], ...OTHER_NON_ASCII];
const ASCII_WORD: CharSet = [[0x30, 0x39], ...ASCII_LETTERS, [0x5f, 0x5f]];
const ASCII_SPACE: CharSet = [
    [0x09, 0x0d],
    [0x20, 0x20],
];
/** Python's Unicode `\s` (`str.isspace`), as {@link PY_SPACE} spells it. */
const UNICODE_SPACE: CharSet = [
    [0x09, 0x0d],
    [0x1c, 0x20],
    [0x85, 0x85],
    [0xa0, 0xa0],
    [0x1680, 0x1680],
    [0x2000, 0x200a],
    [0x2028, 0x2029],
    [0x202f, 0x202f],
    [0x205f, 0x205f],
    [0x3000, 0x3000],
];

function charSet(...sets: CharSet[]): CharSet {
    const sorted = sets
        .flat()
        .filter(([low, high]) => low <= high)
        .sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const [low, high] of sorted) {
        const last = out[out.length - 1];
        if (last && low <= last[1] + 1) {
            last[1] = Math.max(last[1], high);
        } else {
            out.push([low, high]);
        }
    }
    return out;
}

function complement(set: CharSet): CharSet {
    const out: [number, number][] = [];
    let next = 0;
    for (const [low, high] of set) {
        if (low > next) {
            out.push([next, low - 1]);
        }
        next = high + 1;
    }
    if (next <= MAX_CODE_POINT) {
        out.push([next, MAX_CODE_POINT]);
    }
    return out;
}

function intersects(a: CharSet, b: CharSet): boolean {
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        const [aLow, aHigh] = a[i]!;
        const [bLow, bHigh] = b[j]!;
        if (aLow <= bHigh && bLow <= aHigh) {
            return true;
        }
        if (aHigh < bHigh) {
            i++;
        } else {
            j++;
        }
    }
    return false;
}

/**
 * A superset of what `set` matches case-insensitively (simple case folding): ASCII letters in both cases, `s` and `k`
 * with their non-ASCII variants, and any non-ASCII character once the set holds one.
 */
function caseClosure(set: CharSet): CharSet {
    const swapped: [number, number][] = [];
    for (const [low, high] of set) {
        for (const [start, end, offset] of [
            [0x41, 0x5a, 0x20],
            [0x61, 0x7a, -0x20],
        ] as const) {
            swapped.push([Math.max(low, start) + offset, Math.min(high, end) + offset]);
        }
    }
    const letters = charSet(set, swapped);
    const variants = (ascii: number, other: number): CharSet =>
        intersects(letters, single(ascii)) || intersects(set, single(other))
            ? charSet(single(ascii), single(ascii - 0x20), single(other))
            : [];
    return charSet(
        letters,
        variants(0x73, LONG_S),
        variants(0x6b, KELVIN),
        intersects(set, OTHER_NON_ASCII) ? OTHER_NON_ASCII : [],
    );
}

/** What a class member matches: a superset (`over`) and a subset (`under`), equal when exactly known. */
interface Members {
    over: CharSet;
    under: CharSet;
}

function exactly(set: CharSet): Members {
    return { over: set, under: set };
}

// ---------------------------------------------------------------------------------------------------------
// Translation

type Node =
    | { type: "seq"; items: Node[] }
    | { type: "alt"; options: Node[] }
    | { type: "group"; body: Node; open: string }
    | { type: "look"; body: Node; open: string }
    | { type: "repeat"; node: Node; min: number; max: number; suffix: string }
    /** One character; `set` is a superset of the characters it matches. */
    | { type: "atom"; js: string; set: CharSet }
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

function hex(text: string, length: number): boolean {
    return text.length === length && /^[0-9a-fA-F]+$/.test(text);
}

function single(codePoint: number): CharSet {
    return [[codePoint, codePoint]];
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

    /** An atom matching one character of `members`, which is negated for `[^...]`. */
    private charAtom(js: string, members: Members, negated = false): Node {
        const set = negated
            ? complement(members.under)
            : this.flags.ignoreCase
              ? caseClosure(members.over)
              : members.over;
        return { type: "atom", js, set };
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
                return this.flags.dotAll
                    ? this.charAtom("[\\s\\S]", exactly(ALL))
                    : this.charAtom("[^\\n]", exactly(single(0x0a)), true);
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
        return this.charAtom(this.literal(text), exactly(single(char)));
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
    private classEscape(letter: string, inClass: boolean): { js: string; members: Members; negated: boolean } | null {
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
        // Unicode digits and word characters are known exactly in ASCII only.
        const members: Record<string, Members> = {
            d: ascii ? exactly(ASCII_DIGITS) : { over: UNICODE_DIGITS, under: ASCII_DIGITS },
            w: ascii ? exactly(ASCII_WORD) : { over: charSet(ASCII_WORD, NON_ASCII), under: ASCII_WORD },
            s: exactly(ascii ? ASCII_SPACE : UNICODE_SPACE),
        };
        if (letter === lower) {
            return { js: inClass ? sets[lower]! : `[${sets[lower]}]`, members: members[lower]!, negated: false };
        }
        if (inClass) {
            throw new Unsupported("negated class escape inside a set");
        }
        return { js: `[^${sets[lower]}]`, members: members[lower]!, negated: true };
    }

    /** A single-character escape (`\n`, `\x41`, `\.`), as JavaScript text and code point, or null when it is not one. */
    private charEscape(inClass: boolean): { js: string; codePoint: number } | null {
        const letter = this.src[this.i + 1];
        if (letter === undefined) {
            throw new Unsupported("bad escape (end of pattern)");
        }
        const simple: Record<string, [string, number]> = {
            n: ["\\n", 0x0a],
            r: ["\\r", 0x0d],
            t: ["\\t", 0x09],
            f: ["\\f", 0x0c],
            v: ["\\v", 0x0b],
            a: ["\\x07", 0x07],
        };
        if (Object.hasOwn(simple, letter)) {
            this.i += 2;
            const [js, codePoint] = simple[letter]!;
            return { js, codePoint };
        }
        if (letter === "x" || letter === "u" || letter === "U") {
            const length = letter === "x" ? 2 : letter === "u" ? 4 : 8;
            const digits = this.src.slice(this.i + 2, this.i + 2 + length);
            const codePoint = Number.parseInt(digits, 16);
            if (!hex(digits, length) || codePoint > MAX_CODE_POINT) {
                throw new Unsupported(`bad escape \\${letter}`);
            }
            this.i += 2 + length;
            return { js: `\\u{${codePoint.toString(16)}}`, codePoint };
        }
        if (letter === "0") {
            const digits = /^0[0-7]{0,2}/.exec(this.src.slice(this.i + 1))![0];
            const codePoint = Number.parseInt(digits, 8);
            this.i += 1 + digits.length;
            return { js: `\\u{${codePoint.toString(16)}}`, codePoint };
        }
        if (/[0-9A-Za-z]/.test(letter)) {
            return null;
        }
        const codePoint = this.src.codePointAt(this.i + 1)!;
        const text = String.fromCodePoint(codePoint);
        this.i += 1 + text.length;
        return { js: inClass ? this.classLiteral(text) : this.literal(text), codePoint };
    }

    private escape(): Node {
        const letter = this.src[this.i + 1] ?? "";
        const word = this.classEscape("w", true)!.js;
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
            return this.charAtom(set.js, set.members, set.negated);
        }
        const char = this.charEscape(false);
        if (char === null) {
            // Backreferences (`\1`), `\N{...}`, `\g` and unknown escapes.
            throw new Unsupported(`unsupported escape \\${letter}`);
        }
        return this.charAtom(char.js, exactly(single(char.codePoint)));
    }

    private classLiteral(text: string): string {
        return "\\]-[^".includes(text) ? `\\${text}` : text;
    }

    /** One member of a set: a character (`codePoint`, usable in ranges) or a class escape. */
    private classMember(): { js: string; members: Members; codePoint: number | null } {
        if (this.peek() === "\\") {
            const letter = this.src[this.i + 1] ?? "";
            if (letter === "b") {
                this.i += 2;
                return { js: "\\x08", members: exactly(single(0x08)), codePoint: 0x08 };
            }
            const set = this.classEscape(letter, true);
            if (set) {
                this.i += 2;
                return { js: set.js, members: set.members, codePoint: null };
            }
            const char = this.charEscape(true);
            if (char === null) {
                throw new Unsupported(`unsupported escape \\${letter} in a set`);
            }
            return { js: char.js, members: exactly(single(char.codePoint)), codePoint: char.codePoint };
        }
        const codePoint = this.src.codePointAt(this.i)!;
        const text = String.fromCodePoint(codePoint);
        this.i += text.length;
        return { js: this.classLiteral(text), members: exactly(single(codePoint)), codePoint };
    }

    private characterClass(): Node {
        this.i++;
        let js = "[";
        let negated = false;
        if (this.peek() === "^") {
            js += "^";
            negated = true;
            this.i++;
        }
        const over: CharSet[] = [];
        const under: CharSet[] = [];
        let first = true;
        while (this.peek() !== "]" || first) {
            if (this.peek() === undefined) {
                throw new Unsupported("unterminated character set");
            }
            if (first && this.peek() === "]") {
                this.i++;
                js += "\\]";
                over.push(single(0x5d));
                under.push(single(0x5d));
                first = false;
                continue;
            }
            first = false;
            const start = this.classMember();
            if (this.peek() === "-" && this.peek(1) !== "]" && this.peek(1) !== undefined) {
                this.i++;
                const end = this.classMember();
                if (start.codePoint === null || end.codePoint === null) {
                    throw new Unsupported("bad character range");
                }
                js += `${start.js}-${end.js}`;
                over.push([[start.codePoint, end.codePoint]]);
                under.push([[start.codePoint, end.codePoint]]);
            } else {
                js += start.js;
                over.push(start.members.over);
                under.push(start.members.under);
            }
        }
        this.i++;
        return this.charAtom(`${js}]`, { over: charSet(...over), under: charSet(...under) }, negated);
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
// Linear-time patterns

/** A step of a pattern without alternatives: a zero-width assertion, or one character matched `min` to `max` times. */
type Step = { type: "assert" } | { type: "chars"; set: CharSet; min: number; max: number };

/** Combinations of alternatives analysed at most. */
const MAX_BRANCHES = 256;

/** The characters the first step of `steps` must match, or null when it may match nothing. */
function firstChars(steps: readonly Step[]): CharSet | null {
    const first = steps.find((step) => step.type === "chars");
    return first?.type === "chars" && first.min >= 1 ? first.set : null;
}

/**
 * The step sequences of `node`, one per combination of alternatives, or null when the node has a construct the
 * analysis does not cover: lookarounds, repeated groups other than single characters, and alternatives that may
 * match nothing or start with the same character (only one alternative may get past its first character).
 */
function branches(node: Node): Step[][] | null {
    switch (node.type) {
        case "atom":
            return [[{ type: "chars", set: node.set, min: 1, max: 1 }]];
        case "assert":
            return [[{ type: "assert" }]];
        case "look":
            return null;
        case "group":
            return branches(node.body);
        case "seq": {
            let out: Step[][] = [[]];
            for (const item of node.items) {
                const parts = branches(item);
                if (!parts || out.length * parts.length > MAX_BRANCHES) {
                    return null;
                }
                out = out.flatMap((prefix) => parts.map((part) => [...prefix, ...part]));
            }
            return out;
        }
        case "alt": {
            const out: Step[][] = [];
            const starts: CharSet[] = [];
            for (const option of node.options) {
                const parts = branches(option);
                const firsts = parts?.map(firstChars);
                if (!parts || !firsts || firsts.some((set) => set === null)) {
                    return null;
                }
                const start = charSet(...(firsts as CharSet[]));
                if (starts.some((other) => intersects(other, start)) || out.length + parts.length > MAX_BRANCHES) {
                    return null;
                }
                starts.push(start);
                out.push(...parts);
            }
            return out;
        }
        case "repeat": {
            // A repeated character, class or alternation of characters is one step.
            const parts = branches(node.node);
            const sets: CharSet[] = [];
            for (const part of parts ?? [null]) {
                const step = part?.length === 1 ? part[0]! : null;
                if (step?.type !== "chars" || step.min !== 1 || step.max !== 1) {
                    return null;
                }
                sets.push(step.set);
            }
            return [[{ type: "chars", set: charSet(...sets), min: node.min, max: node.max }]];
        }
    }
}

/**
 * Whether a backtracking engine matches `steps` from a fixed start in time linear in the input: every step that can
 * end in several places is followed by a step that must match a character it cannot match, so only one of its ends
 * leads further, or is followed only by fixed-length steps (each of its ends is then checked in constant time).
 */
function linearSteps(steps: readonly Step[]): boolean {
    const chars = steps.filter((step): step is Extract<Step, { type: "chars" }> => step.type === "chars");
    const variable = (step: (typeof chars)[number]) => step.max > step.min;
    let lastVariable = -1;
    chars.forEach((step, index) => {
        if (variable(step)) {
            lastVariable = index;
        }
    });
    return chars.every((step, index) => {
        if (!variable(step) || index === lastVariable) {
            return true;
        }
        const next = chars[index + 1]!;
        return next.min >= 1 && !intersects(step.set, next.set);
    });
}

/** True when the pattern is a sequence of characters and classes whose matching provably takes linear time. */
function isLinear(tree: Node): boolean {
    const steps = branches(tree);
    return steps !== null && steps.every(linearSteps);
}

// ---------------------------------------------------------------------------------------------------------
// Matching

/**
 * Translates and compiles a Python pattern for `re.match` semantics (anchored at the start, sticky).
 *
 * @returns null when the pattern is undecided: Python syntax JavaScript cannot express, not compilable, too long,
 *   or not provably linear
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
        if (!isLinear(tree)) {
            return null;
        }
        return { regex: new RegExp(emit(tree), flags.ignoreCase ? "uyi" : "uy"), inputLimit: MAX_PATTERN_INPUT };
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
