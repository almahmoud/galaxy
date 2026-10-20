import { describe, expect, it } from "vitest";

import { compareToolVersions } from "../version";

// `sorted(versions, key=galaxy.tool_util.version.parse_version)` in planet-runtime, equal versions grouped.
const GALAXY_ORDER = [
    ["abc-1"],
    ["bogus"],
    ["latest"],
    ["1.0.x"],
    ["0.0", "0"],
    ["0.9"],
    ["0.74+galaxy1"],
    ["1.0.dev3"],
    ["1.0-alpha"],
    ["1.0a1.dev1"],
    ["1.0a1"],
    ["1.0.0-beta", "1.0_beta"],
    ["1.0b2"],
    ["1.0pre"],
    ["1.0rc1", "1.0-rc.1"],
    ["1.0", "1.0.0", "1"],
    ["1.0+abc"],
    ["1.0+abc.5"],
    ["1.0+5"],
    ["1.0+5.abc"],
    ["1.0.post1", "1.0-1"],
    ["1.0.0.0.1"],
    ["1.9"],
    ["1.9+galaxy.1"],
    ["1.9+galaxy0"],
    ["1.9+galaxy1"],
    ["1.9+galaxy10"],
    ["1.9+galaxy9"],
    ["1.9+1"],
    ["1.22+galaxy2"],
    ["v2.0"],
    ["2.1+galaxy0"],
    ["2.31+galaxy1"],
    ["2013.10.1"],
    ["1!0.1"],
];

describe("compareToolVersions", () => {
    it("orders versions as Galaxy's parse_version does", () => {
        const ranked = GALAXY_ORDER.flatMap((group, rank) => group.map((version) => ({ version, rank })));
        for (const a of ranked) {
            for (const b of ranked) {
                expect(Math.sign(compareToolVersions(a.version, b.version)), `${a.version} vs ${b.version}`).toBe(
                    Math.sign(a.rank - b.rank),
                );
            }
        }
    });

    it("treats strings that are Object properties as plain legacy versions", () => {
        expect(compareToolVersions("constructor", "toString")).toBeLessThan(0);
        expect(compareToolVersions("constructor", "0.1")).toBeLessThan(0);
    });
});
