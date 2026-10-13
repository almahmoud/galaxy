/**
 * GET /api/genomes from the build's `genomes.json` (`[name, dbkey]` pairs, Galaxy's builds list). Planet has no
 * chromosome length files or reference sequences yet, so `chrom_info=true` lists nothing and the per-genome
 * routes answer 404.
 */

import type { Router } from "@/planet/sw/router";
import { ApiError } from "@/planet/util/errors";
import { queryBool } from "@/planet/util/query";
import { loadOptionalStaticData } from "@/planet/util/staticData";

/** The `[name, dbkey]` pairs of `GET /api/genomes`; the first is Galaxy's "unspecified (?)". */
export async function genomeBuilds(): Promise<string[][]> {
    return (await loadOptionalStaticData<string[][]>("genomes.json")) ?? [["unspecified (?)", "?"]];
}

function noReferenceData(id: string): ApiError {
    return ApiError.notFound(
        `No reference data for genome build '${id}': Planet does not provide chromosome lengths, sequences or indexes yet.`,
    );
}

export function register(router: Router): void {
    router.route("/api/genomes", "get", async ({ query }) => {
        if (queryBool(query, "chrom_info", false)) {
            return [];
        }
        return genomeBuilds();
    });

    router.route("/api/genomes/{id}", "get", ({ params }) => {
        throw noReferenceData(params.id);
    });

    router.route("/api/genomes/{id}/indexes", "get", ({ params }) => {
        throw noReferenceData(params.id);
    });

    router.route("/api/genomes/{id}/sequences", "get", ({ params }) => {
        throw noReferenceData(params.id);
    });
}
