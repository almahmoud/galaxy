// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { kv } from "@/planet/db";

import {
    CONTAINER_CACHE_SECONDS,
    containerRequest,
    ContainerResolutionError,
    mulledV2Name,
    resolveToolContainer,
    resolveToolImage,
} from "../containers";
import { resetDb } from "./fakes";

const DIGEST = `sha256:${"c".repeat(64)}`;

beforeEach(resetDb);
afterEach(resetDb);

function tool(requirements: [string, string | null][], containers: { identifier: string; type: string }[] = []) {
    return {
        requirements: requirements.map(([name, version]) => ({ name, type: "package", version, specs: [] })),
        containers,
    };
}

/** quay.io's tag API, which answers browsers' requests without `X-Requested-With` with HTTP 400. */
function quay(pages: Record<string, { tags: unknown[]; has_additional?: boolean }[]>) {
    return vi.fn(async (url: string, init: RequestInit) => {
        if (new Headers(init.headers).get("X-Requested-With") !== "XMLHttpRequest") {
            const error = "API calls must be invoked with an X-Requested-With header if called from a browser";
            return new Response(JSON.stringify({ error }), { status: 400 });
        }
        const parsed = new URL(url);
        const repository = parsed.pathname.split("/")[5]!;
        const page = Number(parsed.searchParams.get("page"));
        const body = pages[repository]?.[page - 1];
        if (!body) {
            return new Response(JSON.stringify({ error_type: "invalid_token" }), { status: 401 });
        }
        return new Response(JSON.stringify({ page, ...body }), { status: 200 });
    });
}

describe("mulled-v2 names", () => {
    it("hash sorted package names and versions as Galaxy does", async () => {
        // bwa_mem 0.7.19+galaxy1, checked against the image published on quay.io
        expect(
            await mulledV2Name([
                { name: "samtools", version: "1.21" },
                { name: "bwa", version: "0.7.19" },
            ]),
        ).toEqual({
            repository: "mulled-v2-fe8faa35dbf6dc65a0f7f5d4ea12e31a79f73e40",
            versionHash: "bd996097b6dd518cf788ddd6c586fb23d039cb9c",
        });
        // Doctests of galaxy.tool_util.deps.mulled.util.v2_image_name.
        expect(
            await mulledV2Name([
                { name: "samtools", version: "1.3.1" },
                { name: "bwa", version: "0.7.13" },
            ]),
        ).toEqual({
            repository: "mulled-v2-fe8faa35dbf6dc65a0f7f5d4ea12e31a79f73e40",
            versionHash: "4d0535c94ef45be8459f429561f0894c3fe0ebcf",
        });
        expect(
            (
                await mulledV2Name([
                    { name: "samtools", version: "1.3.1" },
                    { name: "bwa", version: null },
                ])
            ).versionHash,
        ).toBe("b0c847e4fb89c343b04036e33b2daa19c4152cf5");
        expect(
            await mulledV2Name([
                { name: "samtools", version: null },
                { name: "BWA", version: null },
            ]),
        ).toEqual({
            repository: "mulled-v2-fe8faa35dbf6dc65a0f7f5d4ea12e31a79f73e40",
            versionHash: null,
        });
        expect(
            await mulledV2Name([
                { name: "samtools", version: "1.3.1" },
                { name: "bedtools", version: "2.26.0" },
            ]),
        ).toEqual({
            repository: "mulled-v2-8186960447c5cb2faa697666dc1e6d919ad23f3e",
            versionHash: "a6419f25efff953fc505dbd5ee734856180bb619",
        });
    });
});

describe("container resolution", () => {
    it("resolves several packages to the newest build of their mulled-v2 image, pinned by digest", async () => {
        const fetch = quay({
            "mulled-v2-fe8faa35dbf6dc65a0f7f5d4ea12e31a79f73e40": [
                {
                    tags: [
                        { name: "bd996097b6dd518cf788ddd6c586fb23d039cb9c-0", manifest_digest: DIGEST, start_ts: 1 },
                        { name: "4d0535c94ef45be8459f429561f0894c3fe0ebcf-1", manifest_digest: DIGEST, start_ts: 2 },
                    ],
                },
            ],
        });
        const resolved = await resolveToolContainer(
            tool([
                ["bwa", "0.7.19"],
                ["samtools", "1.21"],
            ]),
            { fetch },
        );
        expect(resolved).toEqual({
            image:
                "quay.io/biocontainers/mulled-v2-fe8faa35dbf6dc65a0f7f5d4ea12e31a79f73e40:" +
                `bd996097b6dd518cf788ddd6c586fb23d039cb9c-0@${DIGEST}`,
            source: "mulled",
        });
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(
            "https://quay.io/api/v1/repository/biocontainers/mulled-v2-fe8faa35dbf6dc65a0f7f5d4ea12e31a79f73e40/tag/" +
                "?limit=100&page=1&onlyActiveTags=true&filter_tag_name=like%3Abd996097b6dd518cf788ddd6c586fb23d039cb9c",
        );
        expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    });

    it("resolves one package to its exact version with the highest build, reading every page", async () => {
        const fetch = quay({
            samtools: [
                {
                    tags: [
                        { name: "1.21--h50ea8bc_0", manifest_digest: DIGEST, start_ts: 5 },
                        { name: "1.210--h0_9", start_ts: 9 },
                        { name: "latest", start_ts: 10 },
                    ],
                    has_additional: true,
                },
                { tags: [{ name: "1.21--h96c455f_1", manifest_digest: DIGEST, start_ts: 3 }] },
            ],
        });
        const resolved = await resolveToolContainer(tool([["samtools", "1.21"]]), { fetch, cache: false });
        expect(resolved?.image).toBe(`quay.io/biocontainers/samtools:1.21--h96c455f_1@${DIGEST}`);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("lets an explicit docker container win and runs tools without packages in the runtime image", async () => {
        const fetch = vi.fn();
        const explicit = tool(
            [["samtools", "1.21"]],
            [
                { identifier: "docker.io/library/busybox:1.37", type: "singularity" },
                { identifier: "quay.io/example/tool:2.0", type: "docker" },
            ],
        );
        expect(await resolveToolContainer(explicit, { fetch })).toEqual({
            image: "quay.io/example/tool:2.0",
            source: "explicit",
        });
        expect(
            await resolveToolContainer({ requirements: [{ name: "x", type: "set_environment" }] }, { fetch }),
        ).toBeNull();
        expect(await resolveToolImage({ requirements: [] }, "ghcr.io/example/runtime:1", { fetch })).toBe(
            "ghcr.io/example/runtime:1",
        );
        expect(fetch).not.toHaveBeenCalled();
        expect(containerRequest(explicit).containers).toEqual(["quay.io/example/tool:2.0"]);
    });

    it("fails clearly when no image exists, and marks quay.io outages as transient", async () => {
        const missing = quay({});
        await expect(resolveToolContainer(tool([["nosuchtool", "1.0"]]), { fetch: missing })).rejects.toMatchObject({
            name: "ContainerResolutionError",
            transient: false,
            message: "No BioContainers image quay.io/biocontainers/nosuchtool:1.0--* exists.",
        });
        await expect(
            resolveToolContainer(
                tool([
                    ["bwa", "0.7.19"],
                    ["samtools", "9.9"],
                ]),
                { fetch: missing },
            ),
        ).rejects.toThrow(/combines the tool's requirements \(bwa 0.7.19, samtools 9.9\)/);
        await expect(resolveToolContainer(tool([["samtools", null]]), { fetch: missing })).rejects.toThrow(
            /does not give one/,
        );
        await expect(resolveToolContainer(tool([["sam tools", "1"]]), { fetch: missing })).rejects.toThrow(
            ContainerResolutionError,
        );

        const limited = vi.fn(async () => new Response("slow down", { status: 429 }));
        await expect(resolveToolContainer(tool([["samtools", "1.21"]]), { fetch: limited })).rejects.toMatchObject({
            transient: true,
        });
        const offline = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        const error = await resolveToolContainer(tool([["samtools", "1.21"]]), { fetch: offline }).catch((e) => e);
        expect(error).toBeInstanceOf(ContainerResolutionError);
        expect(error.transient).toBe(true);
        expect(error.permanent).toBe(false);
    });

    it("caches resolved images in kv for seven days", async () => {
        const fetch = quay({ samtools: [{ tags: [{ name: "1.21--h50ea8bc_0", manifest_digest: DIGEST }] }] });
        let now = 1_000_000;
        const options = { fetch, now: () => now };
        const first = await resolveToolContainer(tool([["samtools", "1.21"]]), options);
        expect(await resolveToolContainer(tool([["Samtools", "1.21"]]), options)).toEqual(first);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(await kv.get("container:samtools=1.21")).toEqual({ image: first!.image, resolved: 1_000_000 });

        now += CONTAINER_CACHE_SECONDS * 1000;
        await resolveToolContainer(tool([["samtools", "1.21"]]), options);
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});
