import { describe, expect, it } from "vitest";

import { evaluate, pyDict, type PyObject, type PyValue } from "../expressions";

function dataset(fields: Record<string, PyValue>): PyObject {
    return {
        kind: "object",
        typeName: "HistoryDatasetAssociation",
        attribute: (name) => (Object.hasOwn(fields, name) ? fields[name] : undefined),
    };
}

const SCOPE = new Map<string, PyValue>([
    ["flag", true],
    ["off", false],
    ["count", 3],
    ["ratio", 0.5],
    ["name", "sample"],
    ["empty", ""],
    ["nothing", null],
    ["items", ["a", "b"]],
    [
        "library",
        pyDict([
            ["type", "paired"],
            ["unaligned_file", true],
            ["nested", pyDict([["mode", "fast"]])],
        ]),
    ],
    ["queries", pyDict([["queries", []]])],
    ["input", dataset({ ext: "bam", dbkey: "hg38", name: "reads" })],
]);

function value(expression: string): PyValue {
    const result = evaluate(expression, SCOPE);
    if (result.status !== "value") {
        throw new Error(`${expression}: ${JSON.stringify(result)}`);
    }
    return result.value;
}

function status(expression: string): string {
    return evaluate(expression, SCOPE).status;
}

describe("safe expression evaluator", () => {
    it("evaluates the literals, names and operators of the subset", () => {
        expect(value("flag")).toBe(true);
        expect(value("not flag")).toBe(false);
        expect(value("count == 3")).toBe(true);
        expect(value("count != 3")).toBe(false);
        expect(value("1 < count <= 3")).toBe(true);
        expect(value("1 < count < 3")).toBe(false);
        expect(value("ratio >= 0.5 and ratio < 1e3")).toBe(true);
        expect(value("-count < 0")).toBe(true);
        expect(value("'a' in items and 'c' not in items")).toBe(true);
        expect(value('"amp" in "sample"')).toBe(true);
        expect(value("nothing is None and name is not None")).toBe(true);
        expect(value("flag is True and off is False")).toBe(true);
        expect(value("count is True")).toBe(false);
        expect(value("1 == True and 0 == False and 1 == 1.0")).toBe(true);
        expect(value("'a' 'b' == 'ab'")).toBe(true);
        expect(value("(1, 2) == [1, 2] and () == []")).toBe(true);
        expect(value("[1, [2, 3]][1][-1]")).toBe(3);
        expect(value("name[0]")).toBe("s");
    });

    it("returns operands from and/or and short-circuits like Python", () => {
        expect(value("empty or name")).toBe("sample");
        expect(value("count and name")).toBe("sample");
        expect(value("off and undefined_name")).toBe(false);
        expect(value("flag or undefined_name")).toBe(true);
        expect(value("nothing or []")).toEqual([]);
    });

    it("reads dictionaries by subscript and objects by attribute", () => {
        expect(value("library['type'] != 'single' and library['unaligned_file'] is True")).toBe(true);
        expect(value("library['nested']['mode'] == 'fast'")).toBe(true);
        expect(value("input.ext == 'bam' and input.dbkey in ['hg19', 'hg38']")).toBe(true);
        expect(value("'type' in library and 'missing' not in library")).toBe(true);
    });

    it("reports Python's exceptions as errors", () => {
        expect(status("missing_name")).toBe("error");
        expect(status("library['missing']")).toBe("error");
        expect(status("items[5]")).toBe("error");
        expect(status("count < 'a'")).toBe("error");
        expect(status("1 in name")).toBe("error");
        expect(status("count in count")).toBe("error");
        expect(status("-name")).toBe("error");
        expect(status("")).toBe("error");
        expect(status("count ==")).toBe("error");
        expect(status("(count")).toBe("error");
        expect(status("'unterminated")).toBe("error");
        expect(status("007")).toBe("error");
    });

    it("leaves everything outside the subset undecided", () => {
        for (const expression of [
            "len(queries['queries']) > 0",
            "name.strip()",
            "name.upper",
            "library.type",
            "input.unknown_attribute",
            "count + 1 > 2",
            "count * 2",
            "items[0:1]",
            "[x for x in items]",
            "lambda: 1",
            "1 if flag else 0",
            "f'{name}'",
            "b'bytes'",
            "'''triple'''",
            "'\\x41' == 'A'",
            "0x10",
            "count is 3",
            "{'a': 1}",
            "flag\nor off",
            "a := 1",
            "~count",
            "count ** 2",
            "input['ext']",
        ]) {
            expect(evaluate(expression, SCOPE).status, expression).toBe("undecided");
        }
    });

    it("never reaches JavaScript properties, prototypes or constructors", () => {
        const scope = new Map<string, PyValue>([
            ["d", pyDict([["a", 1]])],
            ["s", "text"],
            ["l", [1]],
        ]);
        for (const expression of [
            "constructor",
            "__proto__",
            "prototype",
            "toString",
            "d['constructor']",
            "d['__proto__']",
            "d['hasOwnProperty']",
            "d['toString']",
            "s['length']",
            "l['length']",
            "l['constructor']",
            "s['constructor']",
        ]) {
            const result = evaluate(expression, scope);
            expect(result.status, expression).toBe("error");
        }
        for (const expression of [
            "d.constructor",
            "s.constructor",
            "l.constructor",
            "d.__proto__",
            "s.__class__",
            "d.__class__.__bases__",
            "().__class__.__base__.__subclasses__()",
            "s.constructor.constructor('return 1')()",
            "__import__('os').system('true')",
            "eval('1')",
            "globalThis",
        ]) {
            const result = evaluate(expression, scope);
            expect(result.status, expression).not.toBe("value");
        }
    });

    it("never exposes attributes an object does not define, even inherited ones", () => {
        const object = dataset({ ext: "txt" });
        const scope = new Map<string, PyValue>([["input", object]]);
        expect(evaluate("input.attribute", scope).status).toBe("undecided");
        expect(evaluate("input.constructor", scope).status).toBe("undecided");
        expect(evaluate("input.toString", scope).status).toBe("undecided");
        expect(evaluate("input.ext == 'txt'", scope)).toEqual({ status: "value", value: true });
    });

    it("stays bounded on adversarial input", () => {
        expect(evaluate("(".repeat(5000) + "1" + ")".repeat(5000), SCOPE).status).toBe("undecided");
        expect(evaluate("not ".repeat(1000) + "flag", SCOPE).status).toBe("undecided");
        expect(evaluate("[".repeat(200) + "]".repeat(200), SCOPE).status).toBe("undecided");
        expect(evaluate("flag and ".repeat(500) + "flag", SCOPE)).toEqual({ status: "value", value: true });
        expect(evaluate("1 == ".repeat(500) + "1", SCOPE)).toEqual({ status: "value", value: true });
        expect(evaluate("a".repeat(20_000), SCOPE).status).toBe("undecided");
        expect(evaluate("'\u0000' == '\\0'", SCOPE)).toEqual({ status: "value", value: true });
        // Python reads these as octal escapes ('\\01' is chr(1)); deciding them as NUL plus digits would be wrong.
        expect(evaluate("'\\01' == 'x'", SCOPE).status).toBe("undecided");
        expect(evaluate("'a\\08'", SCOPE).status).toBe("undecided");
        expect(evaluate("'😀' > 'z'", SCOPE)).toEqual({ status: "value", value: true });
    });

    it("compares strings by code point, as Python does", () => {
        const scope = new Map<string, PyValue>([
            ["high", "￿"],
            ["astral", "😀"],
        ]);
        expect(evaluate("astral > high", scope)).toEqual({ status: "value", value: true });
    });
});
