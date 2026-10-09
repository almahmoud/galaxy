// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Router } from "@/planet/sw/router";

import { register } from "../genomes";
import { fetchJson, GENOMES, resetPlanet, stubStaticData, teardownPlanet } from "./contents.fixtures";

function makeRouter(): Router {
    const router = new Router();
    register(router);
    return router;
}

beforeEach(resetPlanet);
afterEach(teardownPlanet);

describe("genomes", () => {
    it("lists the generated builds", async () => {
        expect(await fetchJson(makeRouter(), "GET", "/api/genomes")).toEqual(GENOMES);
    });

    it("lists no builds with chromosome lengths", async () => {
        expect(await fetchJson(makeRouter(), "GET", "/api/genomes?chrom_info=true")).toEqual([]);
    });

    it("offers the unspecified build when the deployment has no genomes file", async () => {
        stubStaticData({});
        expect(await fetchJson(makeRouter(), "GET", "/api/genomes")).toEqual([["unspecified (?)", "?"]]);
    });

    it("answers 404 with an explanation for reference data", async () => {
        const router = makeRouter();
        for (const path of ["/api/genomes/hg38", "/api/genomes/hg38/indexes", "/api/genomes/hg38/sequences"]) {
            const error = await fetchJson(router, "GET", path, undefined, 404);
            expect(error.err_code).toBe(404001);
            expect(error.err_msg).toContain("No reference data for genome build 'hg38'");
        }
    });
});
