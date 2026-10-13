import { describe, expect, it } from "vitest";

import {
    buildSanitizer,
    listify,
    pyFloat,
    pyFloatRepr,
    pyInt,
    pyRepr,
    pyStr,
    sanitizeParam,
    stringAsBool,
    stringAsBoolOrNone,
} from "../python";
import { renderTemplate, type TemplateValue } from "../templates";

describe("Python value semantics", () => {
    it("formats floats like Python's repr", () => {
        expect(pyFloatRepr(1)).toBe("1.0");
        expect(pyFloatRepr(0.5)).toBe("0.5");
        expect(pyFloatRepr(-2.25)).toBe("-2.25");
        expect(pyFloatRepr(0.1 + 0.2)).toBe("0.30000000000000004");
        expect(pyFloatRepr(1e-5)).toBe("1e-05");
        expect(pyFloatRepr(0.0001)).toBe("0.0001");
        expect(pyFloatRepr(1e16)).toBe("1e+16");
        expect(pyFloatRepr(123456789012345680)).toBe("1.2345678901234568e+17");
        expect(pyFloatRepr(1234567890123456)).toBe("1234567890123456.0");
        expect(pyFloatRepr(Number.NaN)).toBe("nan");
        expect(pyFloatRepr(-Infinity)).toBe("-inf");
        expect(pyFloatRepr(-0)).toBe("-0.0");
    });

    it("converts like int() and float()", () => {
        expect(pyInt(" 42 ")).toBe(42);
        expect(pyInt("-1_000")).toBe(-1000);
        expect(pyInt("4.2")).toBeUndefined();
        expect(pyInt("")).toBeUndefined();
        expect(pyInt(4.9)).toBe(4);
        expect(pyInt(true)).toBe(1);
        expect(pyInt(null)).toBeUndefined();
        expect(pyFloat("1e3")).toBe(1000);
        expect(pyFloat(" .5")).toBe(0.5);
        expect(pyFloat("5.")).toBe(5);
        expect(pyFloat("-inf")).toBe(-Infinity);
        expect(pyFloat("NaN")).toBeNaN();
        expect(pyFloat("0x10")).toBeUndefined();
        expect(pyFloat("1e")).toBeUndefined();
        expect(pyFloat("")).toBeUndefined();
    });

    it("prints values like str() and repr()", () => {
        expect(pyStr(null)).toBe("None");
        expect(pyStr(true)).toBe("True");
        expect(pyStr(3)).toBe("3");
        expect(pyStr(2.5)).toBe("2.5");
        expect(pyStr(["a", 1])).toBe("['a', 1]");
        expect(pyRepr("it's")).toBe('"it\'s"');
        expect(pyRepr("a\nb")).toBe("'a\\nb'");
    });

    it("reads booleans like Galaxy's string_as_bool helpers", () => {
        expect(stringAsBool("Yes")).toBe(true);
        expect(stringAsBool(true)).toBe(true);
        expect(stringAsBool("false")).toBe(false);
        expect(stringAsBool(null)).toBe(false);
        expect(stringAsBoolOrNone("on")).toBe(true);
        expect(stringAsBoolOrNone(null)).toBeNull();
        expect(stringAsBoolOrNone("null")).toBeNull();
        expect(stringAsBoolOrNone("no")).toBe(false);
        expect(listify("a,b")).toEqual(["a", "b"]);
        expect(listify(" a , b ", true)).toEqual(["a", "b"]);
        expect(listify(null)).toEqual([]);
        expect(listify(0)).toEqual([]);
    });

    it("sanitizes like sanitize_param and ToolParameterSanitizer", () => {
        expect(sanitizeParam("it's <b> & #1")).toBe("it__sq__s __lt__b__gt__ X __pd__1");
        expect(sanitizeParam(["a'b", "c"])).toEqual(["a__sq__b", "c"]);
        expect(sanitizeParam(5)).toBe(5);
        const custom = buildSanitizer({
            invalid_char: "",
            valid: [{ initial: "string.letters", actions: [{ action: "add", value: "'" }] }],
            mapping: [{ initial: "none", actions: [{ action: "add", source: "&", target: "__amp__" }] }],
        });
        expect(sanitizeParam("a'b&c 1", custom)).toBe("a'b__amp__c");
        expect(sanitizeParam("x", buildSanitizer({ sanitize: false }))).toBe("x");
        const removed = buildSanitizer({
            valid: [{ initial: "default", actions: [{ action: "remove", value: "-" }] }],
        });
        expect(sanitizeParam("a-b", removed)).toBe("aXb");
    });
});

describe("Cheetah placeholder templates", () => {
    const values: Record<string, string> = { name: "Tool", "a.b": "nested", on_string: "data 1" };
    const lookup = (path: readonly string[]): TemplateValue => {
        const key = path.join(".");
        if (key === "missing") {
            return { status: "missing" };
        }
        return Object.hasOwn(values, key) ? { status: "value", text: values[key]! } : { status: "undecided" };
    };

    it("fills names, dotted names and braces", () => {
        expect(renderTemplate("${name} on ${on_string}", lookup)).toEqual({ status: "value", text: "Tool on data 1" });
        expect(renderTemplate("$a.b and ${ a.b }.", lookup)).toEqual({ status: "value", text: "nested and nested." });
        expect(renderTemplate("cost \\$5 \\#1, $ 5 and #1", lookup)).toEqual({
            status: "value",
            text: "cost $5 #1, $ 5 and #1",
        });
    });

    it("reports names Cheetah would not find and leaves the rest to Cheetah", () => {
        expect(renderTemplate("$missing", lookup)).toEqual({ status: "missing", name: "missing" });
        for (const template of [
            "$unknown",
            "#if $name\nx\n#end if",
            "## comment",
            "${name.upper()}",
            "$name()",
            "$a.b[0]",
            "$(name)",
            "$!name",
            "${'x' * 2}",
        ]) {
            expect(renderTemplate(template, lookup).status, template).toBe("undecided");
        }
    });
});
