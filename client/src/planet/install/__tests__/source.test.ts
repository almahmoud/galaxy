import { describe, expect, it } from "vitest";

import { installSlotKeys, isInstalledArchiveKey } from "../keys";
import {
    InstallSourceError,
    normalizeRepositoryPath,
    parseInstallSource,
    sourceLabel,
    sourcePageUrl,
    toolIdPrefix,
} from "../source";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("parseInstallSource", () => {
    it("normalizes Tool Shed sources", () => {
        const source = parseInstallSource({
            type: "toolshed",
            tool_shed_url: "https://toolshed.g2.bx.psu.edu/",
            owner: " iuc ",
            name: "datamash_ops",
            changeset_revision: "AAAFC0AC4DD2",
        });
        expect(source).toEqual({
            type: "toolshed",
            tool_shed_url: "https://toolshed.g2.bx.psu.edu",
            owner: "iuc",
            name: "datamash_ops",
            changeset_revision: "aaafc0ac4dd2",
        });
        expect(toolIdPrefix(source)).toBe("toolshed.g2.bx.psu.edu/repos/iuc/datamash_ops/");
        expect(sourceLabel(source)).toBe("iuc/datamash_ops");
        expect(sourcePageUrl(source)).toBe("https://toolshed.g2.bx.psu.edu/view/iuc/datamash_ops/aaafc0ac4dd2");
    });

    it("defaults to the main Tool Shed", () => {
        const source = parseInstallSource({
            type: "toolshed",
            owner: "iuc",
            name: "x",
            changeset_revision: "a".repeat(12),
        });
        expect(source).toMatchObject({ tool_shed_url: "https://toolshed.g2.bx.psu.edu" });
    });

    it("normalizes GitHub sources", () => {
        const source = parseInstallSource({
            type: "github",
            repository: "https://github.com/galaxyproject/tools-iuc.git",
            ref: SHA.toUpperCase(),
            path: "/tools//datamash/",
        });
        expect(source).toEqual({
            type: "github",
            repository: "galaxyproject/tools-iuc",
            ref: SHA,
            path: "tools/datamash",
        });
        expect(toolIdPrefix(source)).toBe("github.com/repos/galaxyproject/tools-iuc/");
        expect(sourcePageUrl(source)).toBe(`https://github.com/galaxyproject/tools-iuc/tree/${SHA}/tools/datamash`);
    });

    it.each([
        [null, /must be an object/],
        [{ type: "svn" }, /toolshed or github/],
        [
            {
                type: "toolshed",
                tool_shed_url: "https://evil.example",
                owner: "a",
                name: "b",
                changeset_revision: "a".repeat(12),
            },
            /only be installed from/,
        ],
        [
            {
                type: "toolshed",
                tool_shed_url: "http://toolshed.g2.bx.psu.edu",
                owner: "a",
                name: "b",
                changeset_revision: "a".repeat(12),
            },
            /only be installed from/,
        ],
        [{ type: "toolshed", owner: "a/b", name: "b", changeset_revision: "a".repeat(12) }, /valid owner and name/],
        [{ type: "toolshed", owner: "a", name: "b", changeset_revision: "tip" }, /12 to 40 hexadecimal/],
        [
            { type: "toolshed", owner: "a", name: "b", changeset_revision: "a".repeat(12), extra: 1 },
            /Unknown install source field "extra"/,
        ],
        [{ type: "github", repository: "galaxyproject", ref: SHA }, /owner\/name/],
        [{ type: "github", repository: "a/b/c", ref: SHA }, /owner\/name/],
        [{ type: "github", repository: "a/b", ref: "main" }, /40-character commit SHA/],
        [{ type: "github", repository: "a/b", ref: SHA, path: "tools/../.." }, /directory inside the repository/],
        [{ type: "github", repository: "a/b", ref: SHA, path: ".github" }, /directory inside the repository/],
    ])("refuses %j", (value, message) => {
        expect(() => parseInstallSource(value)).toThrow(InstallSourceError);
        expect(() => parseInstallSource(value)).toThrow(message);
    });

    it("keeps the repository root as an empty path", () => {
        expect(normalizeRepositoryPath(undefined)).toBe("");
        expect(normalizeRepositoryPath(" / ")).toBe("");
    });
});

describe("install keys", () => {
    it("name each slot under the attempt's prefix", () => {
        const keys = installSlotKeys("0123456789abcdef", 2, 5);
        expect(keys).toEqual({
            bundle: "tools/installs/0123456789abcdef-a2/5/bundle.json",
            repoTar: "tools/installs/0123456789abcdef-a2/5/repo.tar",
        });
        expect(isInstalledArchiveKey(keys.repoTar)).toBe(true);
        expect(isInstalledArchiveKey(keys.bundle)).toBe(false);
        expect(isInstalledArchiveKey("tools/toolshed.g2.bx.psu.edu/repos/iuc/x/x/1.0/1.0/repo.tar")).toBe(false);
        expect(isInstalledArchiveKey("tools/installs/0123456789abcdef-a2/../repo.tar")).toBe(false);
    });

    it("refuse slots outside the pool", () => {
        expect(() => installSlotKeys("0123456789abcdef", 1, 128)).toThrow(RangeError);
        expect(() => installSlotKeys("not-an-id", 1, 0)).toThrow(RangeError);
    });
});
