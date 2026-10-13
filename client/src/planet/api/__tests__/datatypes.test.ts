// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Router } from "@/planet/sw/router";

import { DatatypeClass, getDatatype, register } from "../datatypes";
import { fetchJson, resetPlanet, send, teardownPlanet } from "./contents.fixtures";
import { FakeBucket, stubNetwork } from "./datasets.fixtures";
import { DATATYPE_FILES, DETAILS, MAPPING } from "./datatypes.fixtures";

function makeRouter(): Router {
    const router = new Router();
    register(router);
    return router;
}

beforeEach(async () => {
    await resetPlanet();
    stubNetwork(DATATYPE_FILES, new FakeBucket());
});
afterEach(teardownPlanet);

const file = (name: string) => DATATYPE_FILES[`/static/planet/data/datatypes/${name}`];

describe("GET /api/datatypes", () => {
    it("answers each extension_only/upload_only combination like view_index", async () => {
        const router = makeRouter();
        expect(await fetchJson(router, "GET", "/api/datatypes")).toEqual(file("extensions.json"));
        expect(await fetchJson(router, "GET", "/api/datatypes?upload_only=false")).toEqual(file("extensions_all.json"));
        expect(await fetchJson(router, "GET", "/api/datatypes?extension_only=false")).toEqual(file("index.json"));
        expect(await fetchJson(router, "GET", "/api/datatypes?extension_only=False&upload_only=0")).toEqual(
            file("index_all.json"),
        );
    });

    it("falls back to derived payloads when optional variants are missing", async () => {
        const files = { ...DATATYPE_FILES };
        delete files["/static/planet/data/datatypes/extensions_all.json"];
        delete files["/static/planet/data/datatypes/index_all.json"];
        stubNetwork(files, new FakeBucket());
        const router = makeRouter();
        expect(await fetchJson(router, "GET", "/api/datatypes?upload_only=false")).toEqual(Object.keys(DETAILS));
        expect(await fetchJson(router, "GET", "/api/datatypes?extension_only=false&upload_only=false")).toEqual(
            file("index.json"),
        );
    });

    it("rejects values FastAPI cannot read as booleans", async () => {
        const error = await fetchJson(makeRouter(), "GET", "/api/datatypes?extension_only=maybe", undefined, 400);
        expect(error).toEqual({
            err_code: 400008,
            err_msg: "Input should be a valid boolean, unable to interpret input in ('query', 'extension_only')",
        });
    });

    it("combines the index and the mapping in types_and_mapping", async () => {
        const body = await fetchJson(makeRouter(), "GET", "/api/datatypes/types_and_mapping?upload_only=false");
        expect(body).toEqual({ datatypes: file("extensions_all.json"), datatypes_mapping: MAPPING });
    });

    it("serves the mapping, sniffers, converters and EDAM payloads unchanged", async () => {
        const r = makeRouter();
        expect(await fetchJson(r, "GET", "/api/datatypes/mapping")).toEqual(MAPPING);
        expect(await fetchJson(r, "GET", "/api/datatypes/sniffers")).toEqual(file("sniffers.json"));
        expect(await fetchJson(r, "GET", "/api/datatypes/converters")).toEqual(file("converters.json"));
        expect(await fetchJson(r, "GET", "/api/datatypes/edam_formats")).toEqual(file("edam_formats.json"));
        expect(await fetchJson(r, "GET", "/api/datatypes/edam_formats/detailed")).toEqual(
            file("edam_formats_detailed.json"),
        );
        expect(await fetchJson(r, "GET", "/api/datatypes/edam_data")).toEqual(file("edam_data.json"));
        expect(await fetchJson(r, "GET", "/api/datatypes/edam_data/detailed")).toEqual(file("edam_data_detailed.json"));
    });

    it("lists every visualization mapping and the mapping of one datatype", async () => {
        const r = makeRouter();
        expect(await fetchJson(r, "GET", "/api/datatypes/visualizations")).toEqual([
            { datatype: "bam", visualization: "igv" },
            { datatype: "png", visualization: "image" },
        ]);
        expect(await fetchJson(r, "GET", "/api/datatypes/bam/visualizations")).toEqual([
            { datatype: "bam", visualization: "igv" },
        ]);
        expect(await fetchJson(r, "GET", "/api/datatypes/unknown/visualizations")).toEqual([]);
    });

    it("shows one datatype and answers 404 for unknown ones", async () => {
        const r = makeRouter();
        expect(await fetchJson(r, "GET", "/api/datatypes/bam")).toEqual(DETAILS.bam);
        expect(await fetchJson(r, "GET", "/api/datatypes/constructor", undefined, 404)).toEqual({
            err_code: 404001,
            err_msg: "Datatype 'constructor' not found",
        });
    });

    it("answers a Galaxy 500 naming the file when required data is missing", async () => {
        stubNetwork({}, new FakeBucket());
        const response = await send(makeRouter(), "GET", "/api/datatypes/sniffers");
        expect(response.status).toBe(500);
        expect((await response.json()).err_code).toBe(500003);
    });
});

describe("datatype classes", () => {
    it("answers subclass questions from the mapping and treats unknown extensions as Data", async () => {
        const bed = await getDatatype("bed");
        expect(bed.isA(DatatypeClass.TABULAR_DATA)).toBe(true);
        expect(bed.isA(DatatypeClass.BINARY)).toBe(false);
        expect(bed.details?.extension).toBe("bed");
        const gz = await getDatatype("tabular.gz");
        expect(gz.isA(DatatypeClass.GZIP) && gz.isA(DatatypeClass.TABULAR_DATA)).toBe(true);
        const unknown = await getDatatype("nonsense");
        expect(unknown.className).toBe(DatatypeClass.DATA);
        expect(unknown.details).toBeUndefined();
    });
});
