/**
 * A side-effect-free evaluator for the subset of Python that output filters use: literals (numbers, strings, `None`,
 * `True`, `False`, lists and tuples), names, attribute access and subscripts into the values given, comparisons
 * (chained like Python's), `in`, `not in`, `is`, `is not`, `not`, `and`, `or` and unary minus.
 *
 * The evaluator never calls anything and reaches values only through the {@link PyValue} structures it is given:
 * names and dictionary keys are looked up in `Map`s and object attributes through their own `attribute` function, so
 * no expression can reach JavaScript properties, prototypes or constructors. Anything outside the subset (calls,
 * arithmetic, comprehensions, lambdas, slices, f-strings, ...) makes the result `undecided`; the job's stage-in
 * container evaluates the original expression with Python and its decision is authoritative.
 */

/** An object exposing attributes, such as a dataset. Attributes it does not know are undecided. */
export interface PyObject {
    readonly kind: "object";
    /** Python `type(x).__name__`, for messages. */
    readonly typeName: string;
    attribute(name: string): PyValue | undefined;
}

/** Values expressions operate on: Python's `None`, `bool`, `int`/`float`, `str`, `list`/`tuple`, `dict` and objects. */
export type PyValue = null | boolean | number | string | readonly PyValue[] | ReadonlyMap<string, PyValue> | PyObject;

/** The outcome of an evaluation: a value, a Python exception, or a result only Python can decide. */
export type EvalResult =
    | { status: "value"; value: PyValue }
    | { status: "error"; error: string }
    | { status: "undecided"; reason: string };

/** Expressions longer than this are not evaluated. */
const MAX_LENGTH = 10_000;
/** Deepest nesting of brackets and operators the parser follows. */
const MAX_DEPTH = 64;

class Undecided extends Error {}

class PyException extends Error {}

function undecided(reason: string): never {
    throw new Undecided(reason);
}

function raise(type: string, message: string): never {
    throw new PyException(`${type}: ${message}`);
}

// ---------------------------------------------------------------------------------------------------------
// Tokenizer

type Token =
    | { type: "name"; value: string }
    | { type: "number"; value: number }
    | { type: "string"; value: string }
    | { type: "op"; value: string }
    | { type: "end" };

const KEYWORDS = new Set(["and", "or", "not", "in", "is", "None", "True", "False"]);
const RESERVED = new Set([
    "if",
    "else",
    "elif",
    "lambda",
    "for",
    "while",
    "def",
    "class",
    "return",
    "yield",
    "await",
    "async",
    "import",
    "from",
    "as",
    "with",
    "try",
    "except",
    "finally",
    "raise",
    "del",
    "global",
    "nonlocal",
    "pass",
    "break",
    "continue",
    "assert",
]);
const OPERATORS = ["==", "!=", "<=", ">=", "<", ">", "(", ")", "[", "]", ",", ".", "-", "+"];
const NUMBER = /^(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+(?:_\d+)*)?/;
const SIMPLE_ESCAPES: Record<string, string> = {
    "\\": "\\",
    "'": "'",
    '"': '"',
    n: "\n",
    t: "\t",
    r: "\r",
    "0": "\0",
};

function readString(text: string, start: number): { value: string; end: number } {
    const quote = text[start]!;
    if (text.startsWith(quote.repeat(3), start)) {
        undecided("triple-quoted strings are not supported");
    }
    let value = "";
    let i = start + 1;
    while (i < text.length) {
        const char = text[i]!;
        if (char === quote) {
            return { value, end: i + 1 };
        }
        if (char === "\n") {
            raise("SyntaxError", "unterminated string literal");
        }
        if (char === "\\") {
            const next = text[i + 1];
            if (next === undefined || !Object.hasOwn(SIMPLE_ESCAPES, next)) {
                undecided("unsupported string escape");
            }
            // Python reads `\0` followed by digits as an octal escape (`'\01'` is chr(1)).
            if (next === "0" && /[0-9]/.test(text[i + 2] ?? "")) {
                undecided("octal string escape");
            }
            value += SIMPLE_ESCAPES[next];
            i += 2;
            continue;
        }
        value += char;
        i++;
    }
    raise("SyntaxError", "unterminated string literal");
}

function tokenize(text: string): Token[] {
    const tokens: Token[] = [];
    let depth = 0;
    let i = 0;
    while (i < text.length) {
        const char = text[i]!;
        if (char === " " || char === "\t" || char === "\f") {
            i++;
            continue;
        }
        if (char === "\n" || char === "\r") {
            if (depth === 0) {
                undecided("statements spanning lines are not supported");
            }
            i++;
            continue;
        }
        if (char === "'" || char === '"') {
            const { value, end } = readString(text, i);
            tokens.push({ type: "string", value });
            i = end;
            continue;
        }
        if (/[A-Za-z_]/.test(char)) {
            let j = i + 1;
            while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) {
                j++;
            }
            const word = text.slice(i, j);
            if (text[j] === "'" || text[j] === '"') {
                undecided("string prefixes are not supported");
            }
            if (RESERVED.has(word)) {
                undecided(`'${word}' is not supported`);
            }
            tokens.push({ type: "name", value: word });
            i = j;
            continue;
        }
        if (/[0-9]/.test(char) || (char === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
            const match = NUMBER.exec(text.slice(i))![0];
            if (/[A-Za-z_.]/.test(text[i + match.length] ?? "")) {
                undecided("unsupported number literal");
            }
            if (/^0+[1-9]/.test(match) && /^[\d_]+$/.test(match)) {
                raise("SyntaxError", "leading zeros in decimal integer literals are not permitted");
            }
            const value = Number(match.replace(/_/g, ""));
            if (!Number.isFinite(value)) {
                undecided("unsupported number literal");
            }
            tokens.push({ type: "number", value });
            i += match.length;
            continue;
        }
        const operator = OPERATORS.find((op) => text.startsWith(op, i));
        if (!operator) {
            undecided(`unsupported character ${JSON.stringify(char)}`);
        }
        if (operator === "(" || operator === "[") {
            depth++;
        } else if (operator === ")" || operator === "]") {
            depth--;
        }
        tokens.push({ type: "op", value: operator });
        i += operator.length;
    }
    tokens.push({ type: "end" });
    return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// Parser

type Node =
    | { kind: "literal"; value: PyValue }
    | { kind: "name"; name: string }
    | { kind: "attribute"; target: Node; name: string }
    | { kind: "subscript"; target: Node; index: Node }
    | { kind: "list"; items: Node[] }
    | { kind: "not"; operand: Node }
    | { kind: "negate"; operand: Node; sign: "-" | "+" }
    | { kind: "boolean"; op: "and" | "or"; operands: Node[] }
    | { kind: "compare"; first: Node; ops: string[]; rest: Node[] };

class Parser {
    private position = 0;
    private depth = 0;

    constructor(private readonly tokens: Token[]) {}

    parse(): Node {
        const node = this.expression();
        if (this.peek().type !== "end") {
            this.unexpected();
        }
        return node;
    }

    private peek(): Token {
        return this.tokens[this.position]!;
    }

    private next(): Token {
        return this.tokens[this.position++]!;
    }

    private isOp(value: string): boolean {
        const token = this.peek();
        return token.type === "op" && token.value === value;
    }

    private isName(value: string): boolean {
        const token = this.peek();
        return token.type === "name" && token.value === value;
    }

    private expect(value: string): void {
        if (!this.isOp(value)) {
            this.unexpected();
        }
        this.position++;
    }

    private unexpected(): never {
        const token = this.peek();
        if (token.type === "op" && ["(", "+", "-"].includes(token.value)) {
            undecided("calls and arithmetic are not supported");
        }
        raise("SyntaxError", "invalid syntax");
    }

    private nested<T>(fn: () => T): T {
        if (++this.depth > MAX_DEPTH) {
            undecided("expression nesting is too deep");
        }
        try {
            return fn();
        } finally {
            this.depth--;
        }
    }

    private expression(): Node {
        return this.nested(() => this.orTest());
    }

    private orTest(): Node {
        const operands = [this.andTest()];
        while (this.isName("or")) {
            this.position++;
            operands.push(this.andTest());
        }
        return operands.length === 1 ? operands[0]! : { kind: "boolean", op: "or", operands };
    }

    private andTest(): Node {
        const operands = [this.notTest()];
        while (this.isName("and")) {
            this.position++;
            operands.push(this.notTest());
        }
        return operands.length === 1 ? operands[0]! : { kind: "boolean", op: "and", operands };
    }

    private notTest(): Node {
        if (this.isName("not")) {
            this.position++;
            return this.nested(() => ({ kind: "not", operand: this.notTest() }));
        }
        return this.comparison();
    }

    private comparisonOperator(): string | null {
        const token = this.peek();
        if (token.type === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(token.value)) {
            this.position++;
            return token.value;
        }
        if (this.isName("in")) {
            this.position++;
            return "in";
        }
        if (this.isName("not")) {
            const following = this.tokens[this.position + 1];
            if (following?.type === "name" && following.value === "in") {
                this.position += 2;
                return "not in";
            }
            return null;
        }
        if (this.isName("is")) {
            this.position++;
            if (this.isName("not")) {
                this.position++;
                return "is not";
            }
            return "is";
        }
        return null;
    }

    private comparison(): Node {
        const first = this.factor();
        const ops: string[] = [];
        const rest: Node[] = [];
        for (let op = this.comparisonOperator(); op !== null; op = this.comparisonOperator()) {
            ops.push(op);
            rest.push(this.factor());
        }
        return ops.length ? { kind: "compare", first, ops, rest } : first;
    }

    private factor(): Node {
        if (this.isOp("-") || this.isOp("+")) {
            const sign = (this.next() as { value: "-" | "+" }).value;
            return this.nested(() => ({ kind: "negate", operand: this.factor(), sign }));
        }
        return this.primary();
    }

    private primary(): Node {
        let node = this.atom();
        for (;;) {
            if (this.isOp(".")) {
                this.position++;
                const name = this.next();
                if (name.type !== "name" || KEYWORDS.has(name.value)) {
                    raise("SyntaxError", "invalid syntax");
                }
                node = { kind: "attribute", target: node, name: name.value };
            } else if (this.isOp("[")) {
                this.position++;
                const index = this.expression();
                if (!this.isOp("]")) {
                    this.unexpected();
                }
                this.position++;
                node = { kind: "subscript", target: node, index };
            } else if (this.isOp("(")) {
                undecided("calls are not supported");
            } else {
                return node;
            }
        }
    }

    /** `(expr)` is the expression itself; `()`, `(a,)` and `(a, b)` are tuples. */
    private parenthesized(): Node {
        if (this.isOp(")")) {
            this.position++;
            return { kind: "list", items: [] };
        }
        const first = this.expression();
        if (this.isOp(")")) {
            this.position++;
            return first;
        }
        const items = [first];
        while (this.isOp(",")) {
            this.position++;
            if (this.isOp(")")) {
                break;
            }
            items.push(this.expression());
        }
        this.expect(")");
        return { kind: "list", items };
    }

    private sequence(close: string): Node[] {
        const items: Node[] = [];
        while (!this.isOp(close)) {
            items.push(this.expression());
            if (!this.isOp(",")) {
                break;
            }
            this.position++;
        }
        this.expect(close);
        return items;
    }

    private atom(): Node {
        const token = this.next();
        switch (token.type) {
            case "number":
                return { kind: "literal", value: token.value };
            case "string": {
                let value = token.value;
                while (this.peek().type === "string") {
                    value += (this.next() as { value: string }).value;
                }
                return { kind: "literal", value };
            }
            case "name":
                if (token.value === "None") {
                    return { kind: "literal", value: null };
                }
                if (token.value === "True" || token.value === "False") {
                    return { kind: "literal", value: token.value === "True" };
                }
                if (KEYWORDS.has(token.value)) {
                    raise("SyntaxError", "invalid syntax");
                }
                return { kind: "name", name: token.value };
            case "op":
                if (token.value === "(") {
                    return this.nested(() => this.parenthesized());
                }
                if (token.value === "[") {
                    return this.nested(() => ({ kind: "list", items: this.sequence("]") }));
                }
                this.position--;
                return this.unexpected();
            case "end":
                raise("SyntaxError", "unexpected end of expression");
        }
    }
}

// ---------------------------------------------------------------------------------------------------------
// Semantics

function isObject(value: PyValue): value is PyObject {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Map);
}

function isDict(value: PyValue): value is ReadonlyMap<string, PyValue> {
    return value instanceof Map;
}

function isList(value: PyValue): value is readonly PyValue[] {
    return Array.isArray(value);
}

function isNumeric(value: PyValue): value is number | boolean {
    return typeof value === "number" || typeof value === "boolean";
}

function typeName(value: PyValue): string {
    if (value === null) {
        return "NoneType";
    }
    if (typeof value === "boolean") {
        return "bool";
    }
    if (typeof value === "number") {
        return Number.isInteger(value) ? "int" : "float";
    }
    if (typeof value === "string") {
        return "str";
    }
    if (isList(value)) {
        return "list";
    }
    if (isDict(value)) {
        return "dict";
    }
    return value.typeName;
}

/** Python truthiness. */
export function truthy(value: PyValue): boolean {
    if (value === null || value === false || value === 0 || value === "") {
        return false;
    }
    if (isList(value)) {
        return value.length > 0;
    }
    if (isDict(value)) {
        return value.size > 0;
    }
    return true;
}

/** Python `==`. */
export function pyEquals(a: PyValue, b: PyValue): boolean {
    if (isNumeric(a) && isNumeric(b)) {
        return Number(a) === Number(b);
    }
    if (a === null || b === null || typeof a === "string" || typeof b === "string") {
        return a === b;
    }
    if (isList(a) && isList(b)) {
        return a.length === b.length && a.every((item, index) => pyEquals(item, b[index]!));
    }
    if (isDict(a) && isDict(b)) {
        if (a.size !== b.size) {
            return false;
        }
        for (const [key, value] of a) {
            if (!b.has(key) || !pyEquals(value, b.get(key)!)) {
                return false;
            }
        }
        return true;
    }
    return a === b;
}

function compareCodePoints(a: string, b: string): number {
    const left = Array.from(a);
    const right = Array.from(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
        const difference = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
        if (difference !== 0) {
            return difference;
        }
    }
    return left.length - right.length;
}

/** Python ordering (`<`): negative, zero or positive; raises `TypeError` for unorderable values. */
function pyOrder(a: PyValue, b: PyValue, op: string): number {
    if (isNumeric(a) && isNumeric(b)) {
        const left = Number(a);
        const right = Number(b);
        return Number.isNaN(left) || Number.isNaN(right) ? Number.NaN : left - right;
    }
    if (typeof a === "string" && typeof b === "string") {
        return compareCodePoints(a, b);
    }
    if (isList(a) && isList(b)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            if (!pyEquals(a[i]!, b[i]!)) {
                return pyOrder(a[i]!, b[i]!, op);
            }
        }
        return a.length - b.length;
    }
    if (isObject(a) || isObject(b)) {
        undecided("ordering of objects is not supported");
    }
    raise("TypeError", `'${op}' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`);
}

function contains(container: PyValue, item: PyValue): boolean {
    if (typeof container === "string") {
        if (typeof item !== "string") {
            raise("TypeError", `'in <string>' requires string as left operand, not ${typeName(item)}`);
        }
        return container.includes(item);
    }
    if (isList(container)) {
        return container.some((element) => pyEquals(element, item));
    }
    if (isDict(container)) {
        if (isList(item) || isDict(item)) {
            raise("TypeError", `unhashable type: '${typeName(item)}'`);
        }
        return typeof item === "string" && container.has(item);
    }
    if (isObject(container)) {
        undecided("membership in objects is not supported");
    }
    raise("TypeError", `argument of type '${typeName(container)}' is not iterable`);
}

function identical(a: PyValue, b: PyValue): boolean {
    if (a === null || b === null || typeof a === "boolean" || typeof b === "boolean") {
        return a === b;
    }
    if (typeof a === "object" && typeof b === "object" && a === b) {
        return true;
    }
    return undecided("identity of values other than None, True and False is not supported");
}

function compare(op: string, a: PyValue, b: PyValue): boolean {
    switch (op) {
        case "==":
            return pyEquals(a, b);
        case "!=":
            return !pyEquals(a, b);
        case "<":
            return pyOrder(a, b, op) < 0;
        case "<=":
            return pyOrder(a, b, op) <= 0;
        case ">":
            return pyOrder(a, b, op) > 0;
        case ">=":
            return pyOrder(a, b, op) >= 0;
        case "in":
            return contains(b, a);
        case "not in":
            return !contains(b, a);
        case "is":
            return identical(a, b);
        case "is not":
            return !identical(a, b);
        default:
            return undecided(`unsupported operator ${op}`);
    }
}

function subscript(target: PyValue, index: PyValue): PyValue {
    if (isDict(target)) {
        if (typeof index !== "string") {
            if (isList(index) || isDict(index)) {
                raise("TypeError", `unhashable type: '${typeName(index)}'`);
            }
            raise("KeyError", String(index));
        }
        const value = target.get(index);
        if (value === undefined) {
            raise("KeyError", JSON.stringify(index));
        }
        return value;
    }
    if (isList(target) || typeof target === "string") {
        if (!isNumeric(index) || !Number.isInteger(Number(index))) {
            raise("TypeError", `indices must be integers, not ${typeName(index)}`);
        }
        const items = typeof target === "string" ? Array.from(target) : target;
        const position = Number(index) < 0 ? items.length + Number(index) : Number(index);
        if (position < 0 || position >= items.length) {
            raise("IndexError", "index out of range");
        }
        return items[position]!;
    }
    if (isObject(target)) {
        undecided("subscripting objects is not supported");
    }
    raise("TypeError", `'${typeName(target)}' object is not subscriptable`);
}

function attribute(target: PyValue, name: string): PyValue {
    if (isObject(target)) {
        const value = target.attribute(name);
        if (value === undefined) {
            undecided(`attribute '${name}' of ${target.typeName} is not known`);
        }
        return value;
    }
    // Strings, lists and dicts expose methods only; calling them is never supported.
    return undecided(`attribute '${name}' of ${typeName(target)} is not supported`);
}

function evaluateNode(node: Node, scope: ReadonlyMap<string, PyValue>): PyValue {
    switch (node.kind) {
        case "literal":
            return node.value;
        case "name": {
            const value = scope.get(node.name);
            if (value === undefined) {
                raise("NameError", `name '${node.name}' is not defined`);
            }
            return value;
        }
        case "attribute":
            return attribute(evaluateNode(node.target, scope), node.name);
        case "subscript":
            return subscript(evaluateNode(node.target, scope), evaluateNode(node.index, scope));
        case "list":
            return node.items.map((item) => evaluateNode(item, scope));
        case "not":
            return !truthy(evaluateNode(node.operand, scope));
        case "negate": {
            const value = evaluateNode(node.operand, scope);
            if (!isNumeric(value)) {
                raise("TypeError", `bad operand type for unary ${node.sign}: '${typeName(value)}'`);
            }
            return node.sign === "-" ? -Number(value) : Number(value);
        }
        case "boolean": {
            let value: PyValue = null;
            for (const operand of node.operands) {
                value = evaluateNode(operand, scope);
                if (node.op === "and" ? !truthy(value) : truthy(value)) {
                    return value;
                }
            }
            return value;
        }
        case "compare": {
            let left = evaluateNode(node.first, scope);
            for (let i = 0; i < node.ops.length; i++) {
                const right = evaluateNode(node.rest[i]!, scope);
                if (!compare(node.ops[i]!, left, right)) {
                    return false;
                }
                left = right;
            }
            return true;
        }
    }
}

/**
 * Evaluates a Python expression over `scope` (names to values). Never throws: syntax and runtime errors Python would
 * raise come back as `error`, and anything outside the supported subset as `undecided`.
 */
export function evaluate(expression: string, scope: ReadonlyMap<string, PyValue>): EvalResult {
    try {
        const text = expression.trim();
        if (text.length > MAX_LENGTH) {
            undecided("expression is too long");
        }
        if (!text) {
            raise("SyntaxError", "empty expression");
        }
        const node = new Parser(tokenize(text)).parse();
        return { status: "value", value: evaluateNode(node, scope) };
    } catch (error) {
        if (error instanceof Undecided) {
            return { status: "undecided", reason: error.message };
        }
        if (error instanceof PyException) {
            return { status: "error", error: error.message };
        }
        if (error instanceof RangeError) {
            return { status: "undecided", reason: "expression is too complex" };
        }
        throw error;
    }
}

/** A dictionary value from plain entries. */
export function pyDict(entries: Iterable<readonly [string, PyValue]>): ReadonlyMap<string, PyValue> {
    return new Map(entries);
}
