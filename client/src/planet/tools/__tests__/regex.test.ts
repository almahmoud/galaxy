import { describe, expect, it } from "vitest";

import type { BundleDynamicOptions, BundleParameter } from "../bundle";
import type { RequestContext, StateContext } from "../context";
import { dynamicOptions } from "../options";
import { validateValue } from "../parameters";
import { compilePythonPattern, MAX_PATTERN_INPUT, pythonMatch, RISKY_PATTERN_INPUT } from "../regex";

function match(expression: string, value: string): boolean | undefined {
    return pythonMatch(compilePythonPattern(expression), value);
}

describe("Python patterns", () => {
    it("match at the start like re.match", () => {
        expect(match("[a-z]", "run")).toBe(true);
        expect(match("[a-z]", "1run")).toBe(false);
        expect(match("^(c?[1-9]\\d*)(,c?[1-9]\\d*)*$", "c1,2,c13")).toBe(true);
        expect(match("^(c?[1-9]\\d*)(,c?[1-9]\\d*)*$", "c1,,2")).toBe(false);
        expect(match("\\*|[ACMGRSVTWYHKDBN]+$", "ACGT")).toBe(true);
    });

    it("keep Python's meaning where JavaScript differs", () => {
        // `$` also matches before a final newline; `\Z` only at the end.
        expect(match("^\\d+$", "12\n")).toBe(true);
        expect(match("^\\d+\\Z", "12\n")).toBe(false);
        // `.` excludes only `\n`.
        expect(match("^a.b$", "a\rb")).toBe(true);
        expect(match("^a.b$", "a\nb")).toBe(false);
        expect(match("(?s)^a.b$", "a\nb")).toBe(true);
        // Unicode word characters, digits and boundaries; ASCII with the `a` flag.
        expect(match("^\\w+$", "Müller_3")).toBe(true);
        expect(match("(?a)^\\w+$", "Müller")).toBe(false);
        expect(match("^\\d+$", "١٢")).toBe(true);
        expect(match("^\\s$", " ")).toBe(true);
        expect(match("^\\s$", "﻿")).toBe(false);
        expect(match("^é\\b", "éa")).toBe(false);
        expect(match("^.$", "\u{1f600}")).toBe(true);
        // Named groups, `{,n}`, comments, inline flags and escapes of any punctuation.
        expect(match("^(?P<chrom>chr\\w+):(?P<start>\\d+)$", "chr1:100")).toBe(true);
        expect(match("^a{,2}$", "aa")).toBe(true);
        expect(match("^a{,2}$", "aaa")).toBe(false);
        expect(match("^x(?#comment)y$", "xy")).toBe(true);
        expect(match("(?i)^acgt$", "ACGT")).toBe(true);
        expect(match("^\\:\\-[\\]-]+$", ":-]-")).toBe(true);
        expect(match("^[]a]+$", "]a")).toBe(true);
        expect(match("^\\x41\\u0042\\0$", "AB\0")).toBe(true);
        expect(match("^{}$", "{}")).toBe(true);
    });

    it("leave syntax JavaScript cannot express undecided", () => {
        for (const expression of [
            "(?x) a b",
            "(?P=name)",
            "(a)\\1",
            "(?(1)a|b)",
            "(?>a+)",
            "a*+",
            "(?i:a)",
            "a(?i)b",
            "\\N{DIGIT ONE}",
            "\\p{L}",
            "\\q",
            "[\\W]",
            "(unclosed",
            "a**",
            "*a",
            "a".repeat(10_001),
        ]) {
            expect(compilePythonPattern(expression), expression).toBeNull();
            expect(match(expression, "a"), expression).toBeUndefined();
        }
    });

    it("cap inputs, more tightly for patterns that can backtrack catastrophically", () => {
        const safe = compilePythonPattern("^[ACGT]+$")!;
        expect(safe.inputLimit).toBe(MAX_PATTERN_INPUT);
        expect(pythonMatch(safe, "A".repeat(MAX_PATTERN_INPUT))).toBe(true);
        expect(pythonMatch(safe, "A".repeat(MAX_PATTERN_INPUT + 1))).toBeUndefined();

        for (const expression of ["^(a+)+$", "^(\\w+\\s?)*$", "^(a|aa)+$", "^(.*,)*x$", "x".repeat(1001)]) {
            expect(compilePythonPattern(expression)?.inputLimit, expression).toBe(RISKY_PATTERN_INPUT);
        }
        expect(match("^(a+)+$", `${"a".repeat(40)}b`)).toBeUndefined();
        expect(match("^(a+)+$", `${"a".repeat(RISKY_PATTERN_INPUT - 1)}b`)).toBe(false);

        // Repetitions delimited by a literal, or of alternatives that start differently, are not ambiguous.
        for (const expression of [
            "^(c?[1-9]\\d*)(,c?[1-9]\\d*)*$",
            "^(\\d+,)*\\d+$",
            "^([ACGT]|N)+$",
            "^(-?[1-9]\\d*|((-?\\d+)?:(-?\\d*(:-?\\d*)?)))(,(-?[1-9]\\d*|((-?\\d+)?:(-?\\d*(:-?\\d*)?))))*$",
        ]) {
            expect(compilePythonPattern(expression)?.inputLimit, expression).toBe(MAX_PATTERN_INPUT);
        }
    });
});

describe("regex validators", () => {
    const text = (expression: string, negate = false): BundleParameter =>
        ({
            type: "text",
            name: "title",
            optional: false,
            validators: [{ type: "regex", expression, message: "Must start with a letter", negate, implicit: false }],
        }) as BundleParameter;

    it("pass and fail as Galaxy decides", () => {
        expect(() => validateValue(text("[a-z]"), "run")).not.toThrow();
        expect(() => validateValue(text("[a-z]"), "1run")).toThrow("Must start with a letter");
        expect(() => validateValue(text("[a-z]", true), "1run")).not.toThrow();
    });

    it("never pass a value they cannot decide", () => {
        expect(() => validateValue(text("(?P<x>a)(?P=x)"), "aa")).toThrow("uses syntax it does not support");
        expect(() => validateValue(text("(?P<x>a)(?P=x)", true), "b")).toThrow("uses syntax it does not support");
        expect(() => validateValue(text("^(a+)+$"), "a".repeat(100))).toThrow(
            `only up to ${RISKY_PATTERN_INPUT} characters`,
        );
    });
});

describe("regexp option filters", () => {
    const options = (value: string, keep = "True"): BundleDynamicOptions =>
        ({
            from_dataset: null,
            from_file: null,
            from_data_table: null,
            from_parameter: "tool.app.datatypes_registry.upload_file_formats",
            from_url: null,
            transform_lines: null,
            meta_file_key: null,
            options_filter_attribute: null,
            separator: "\t",
            startswith: null,
            columns: { value: 0, name: 0 },
            filters: [{ type: "regexp", column: "0", value, keep }],
            validators: [],
        }) as BundleDynamicOptions;
    const rc = { tool: { data_tables: [] }, uploadFormats: ["bam", "bed", "fasta"] } as unknown as RequestContext;
    const context = new Map() as unknown as StateContext;

    it("keep or drop the rows the pattern matches", () => {
        expect(dynamicOptions(options("b"), rc, context).map((option) => option.value)).toEqual(["bam", "bed"]);
        expect(dynamicOptions(options("b", "False"), rc, context).map((option) => option.value)).toEqual(["fasta"]);
    });

    it("offer no row the pattern cannot decide", () => {
        expect(dynamicOptions(options("(?>b)"), rc, context)).toEqual([]);
        expect(dynamicOptions(options("(?>b)", "False"), rc, context)).toEqual([]);
    });
});
