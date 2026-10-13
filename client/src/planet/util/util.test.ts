// @vitest-environment node
import { describe, expect, it } from "vitest";

import { ApiError, defaultErrorCode } from "./errors";
import { escapeHtml } from "./html";
import { isId, newId, newInstanceId, newRequestId, newUuid } from "./ids";
import { queryBool, queryInt, stringAsBool } from "./query";
import { niceSize } from "./sizes";
import { formatGalaxyTime, galaxyNow, nextMicros, parseGalaxyTime } from "./time";

describe("ids", () => {
    it("produces Galaxy-shaped ids", () => {
        const ids = new Set(Array.from({ length: 1000 }, newId));
        expect(ids.size).toBe(1000);
        for (const id of ids) {
            expect(isId(id)).toBe(true);
        }
        expect(isId("ABCDEF0123456789")).toBe(false);
        expect(isId(42)).toBe(false);
    });

    it("produces v4 UUIDs, instance ids and request ids", () => {
        expect(newUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(newInstanceId()).toMatch(/^[0-9a-f]{8}$/);
        expect(newRequestId()).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe("time", () => {
    it("formats naive UTC with six fractional digits", () => {
        expect(formatGalaxyTime(Date.UTC(2026, 9, 9, 12, 34, 56, 789) * 1000)).toBe("2026-10-09T12:34:56.789000");
        expect(formatGalaxyTime(Date.UTC(2026, 0, 1) * 1000 + 7)).toBe("2026-01-01T00:00:00.000007");
    });

    it("never returns the same timestamp twice and keeps string order", () => {
        const stamps = Array.from({ length: 5000 }, galaxyNow);
        expect(new Set(stamps).size).toBe(stamps.length);
        expect([...stamps].sort()).toEqual(stamps);
    });

    it("stays above a floor from another context", () => {
        const future = (Date.now() + 60_000) * 1000;
        expect(nextMicros(future)).toBe(future + 1);
        expect(nextMicros()).toBe(future + 2);
    });

    it("parses the formats Galaxy's filter parser accepts", () => {
        const base = Date.UTC(2026, 9, 9, 12, 34, 56) * 1000;
        expect(parseGalaxyTime("2026-10-09T12:34:56")).toBe(base);
        expect(parseGalaxyTime("2026-10-09 12:34:56.5")).toBe(base + 500_000);
        expect(parseGalaxyTime("2026-10-09T12:34:56.789Z")).toBe(base + 789_000);
        expect(parseGalaxyTime("2026-10-09T12:34:56.000001")).toBe(base + 1);
        expect(parseGalaxyTime("2026-10-09")).toBe(Date.UTC(2026, 9, 9) * 1000);
        expect(parseGalaxyTime("1700000000.25")).toBe(1_700_000_000_250_000);
        expect(parseGalaxyTime(formatGalaxyTime(base + 42))).toBe(base + 42);
    });

    it("rejects other formats", () => {
        for (const value of ["", "yesterday", "2026-10-09T12:34:56+02:00", "2026-13-01", "2026-02-30T00:00:00"]) {
            expect(() => parseGalaxyTime(value)).toThrow(RangeError);
        }
    });
});

describe("query parameters", () => {
    it("parses booleans and integers with FastAPI's rules", () => {
        const query = new URLSearchParams("a=YES&b=off&c=12&d=-1&e=x&f=t&g=&h=maybe");
        expect(queryBool(query, "a", false)).toBe(true);
        expect(queryBool(query, "b", true)).toBe(false);
        expect(queryBool(query, "f", false)).toBe(true);
        expect(queryBool(query, "missing", null)).toBeNull();
        expect(queryBool(query, "g", true)).toBe(true);
        expect(() => queryBool(query, "h", false)).toThrow("Input should be a valid boolean");
        expect(queryInt(query, "c", 0)).toBe(12);
        expect(queryInt(query, "g", null)).toBeNull();
        expect(() => queryInt(query, "d", 0, 0)).toThrow("greater than or equal to 0");
        expect(() => queryInt(query, "e", 0)).toThrow("valid integer");
    });

    it("reads legacy controller flags like Galaxy's string_as_bool", () => {
        expect(["True", "yes", "ON", "1"].map(stringAsBool)).toEqual([true, true, true, true]);
        expect(["t", "0", "", null, undefined].map(stringAsBool)).toEqual([false, false, false, false, false]);
    });
});

describe("niceSize", () => {
    it("matches galaxy.util.nice_size", () => {
        expect(niceSize(100)).toBe("100 bytes");
        expect(niceSize(10000)).toBe("10.0 KB");
        expect(niceSize(1000000)).toBe("1.0 MB");
        expect(niceSize(100000000)).toBe("100.0 MB");
        expect(niceSize(1024, true)).toBe("1.0 KiB");
        expect(niceSize(1048576, true)).toBe("1.0 MiB");
        expect(niceSize(999)).toBe("999 bytes");
        expect(niceSize("2048")).toBe("2.0 KB");
        expect(niceSize("abc")).toBe("??? bytes");
        expect(niceSize(null)).toBe("??? bytes");
    });

    it("rounds exact ties to even like Python", () => {
        expect(niceSize(1250)).toBe("1.2 KB");
        expect(niceSize(1750)).toBe("1.8 KB");
        expect(niceSize(2250)).toBe("2.2 KB");
        expect(niceSize(1260)).toBe("1.3 KB");
    });
});

describe("escapeHtml", () => {
    it("escapes markup characters", () => {
        expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
            "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
        );
        expect(escapeHtml(null)).toBe("");
    });
});

describe("ApiError", () => {
    it("builds Galaxy envelopes", () => {
        expect(ApiError.notFound().toEnvelope()).toEqual({ err_msg: "No such object found.", err_code: 404001 });
        expect(new ApiError(400, "bad", undefined, { column: "x" }).toEnvelope()).toEqual({
            column: "x",
            err_msg: "bad",
            err_code: 400008,
        });
        expect(defaultErrorCode(418)).toBe(0);
    });
});
