// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collections, hdas } from "@/planet/db";
import { Router } from "@/planet/sw/router";

import { DEFAULT_COLLECTION_NAME, register } from "../collections";
import { addDataset, addList, currentHistoryId, fetchJson, resetPlanet, teardownPlanet } from "./contents.fixtures";
import { FakeBucket, stubNetwork } from "./datasets.fixtures";
import { DATATYPE_FILES } from "./datatypes.fixtures";

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

async function threeDatasets() {
    const historyId = await currentHistoryId();
    const created = [];
    for (const name of ["a", "b", "c"]) {
        created.push(await addDataset(historyId, { name, extension: "fasta", dbkey: "hg38" }));
    }
    return { historyId, hdas: created.map((item) => item.hda) };
}

function hdaRef(id: string, name: string, extra: Record<string, unknown> = {}) {
    return { src: "hda", id, name, ...extra };
}

describe("POST /api/dataset_collections", () => {
    it("builds a list from copies of the datasets, hidden, and returns the element view", async () => {
        const {
            historyId,
            hdas: [a, b],
        } = await threeDatasets();
        const created = await fetchJson(makeRouter(), "POST", "/api/dataset_collections", {
            history_id: historyId,
            collection_type: "list",
            name: "my list",
            element_identifiers: [hdaRef(a!.id, "first", { tags: ["group:x"] }), hdaRef(b!.id, "second")],
        });
        expect(created).toMatchObject({
            model_class: "HistoryDatasetCollectionAssociation",
            name: "my list",
            collection_type: "list",
            hid: 6,
            element_count: 2,
            populated: true,
            history_id: historyId,
        });
        expect(created.elements.map((element: { element_identifier: string }) => element.element_identifier)).toEqual([
            "first",
            "second",
        ]);
        const copies = await Promise.all(
            created.elements.map((element: { object: { id: string } }) => hdas.get(element.object.id)),
        );
        expect(copies.map((copy) => [copy!.hid, copy!.visible, copy!.copied_from?.id])).toEqual([
            [4, false, a!.id],
            [5, false, b!.id],
        ]);
        expect(copies[0]!.tags).toEqual(["group:x"]);
        expect((await hdas.get(a!.id))!.visible).toBe(true);
    });

    it("references the datasets themselves without copy_elements and hides them on request", async () => {
        const {
            historyId,
            hdas: [a, b],
        } = await threeDatasets();
        const created = await fetchJson(makeRouter(), "POST", "/api/dataset_collections", {
            history_id: historyId,
            collection_type: "list",
            copy_elements: false,
            hide_source_items: true,
            element_identifiers: [hdaRef(a!.id, "x"), hdaRef(b!.id, "y")],
        });
        expect(created.name).toBe(DEFAULT_COLLECTION_NAME);
        expect(created.hid).toBe(4);
        expect(created.elements.map((element: { object: { id: string } }) => element.object.id)).toEqual([
            a!.id,
            b!.id,
        ]);
        expect((await hdas.get(a!.id))!.visible).toBe(false);
    });

    it("orders paired elements forward then reverse and drops others", async () => {
        const {
            historyId,
            hdas: [a, b, c],
        } = await threeDatasets();
        const created = await fetchJson(makeRouter(), "POST", "/api/dataset_collections", {
            history_id: historyId,
            collection_type: "paired",
            copy_elements: false,
            element_identifiers: [hdaRef(a!.id, "reverse"), hdaRef(b!.id, "forward"), hdaRef(c!.id, "extra")],
        });
        expect(
            created.elements.map((element: { element_identifier: string; object: { id: string } }) => [
                element.element_identifier,
                element.object.id,
            ]),
        ).toEqual([
            ["forward", b!.id],
            ["reverse", a!.id],
        ]);
    });

    it("builds nested collections from new_collection and existing collections", async () => {
        const {
            historyId,
            hdas: [a, b, c],
        } = await threeDatasets();
        const existing = await addList(historyId, [c!.id]);
        const router = makeRouter();
        const nested = await fetchJson(router, "POST", "/api/dataset_collections", {
            history_id: historyId,
            collection_type: "list:paired",
            copy_elements: false,
            element_identifiers: [
                {
                    src: "new_collection",
                    name: "sample1",
                    collection_type: "paired",
                    element_identifiers: [hdaRef(a!.id, "forward"), hdaRef(b!.id, "reverse")],
                },
            ],
        });
        const sample = nested.elements[0];
        expect(sample).toMatchObject({ element_identifier: "sample1", element_type: "dataset_collection" });
        expect(sample.object).toMatchObject({ collection_type: "paired", element_count: 2 });

        const listOfLists = await fetchJson(router, "POST", "/api/dataset_collections", {
            history_id: historyId,
            collection_type: "list:list",
            element_identifiers: [{ src: "hdca", id: existing.id, name: "reused" }],
        });
        expect(listOfLists.elements[0].object.elements[0].object.id).toBe(c!.id);
    });

    it("validates the request like Galaxy", async () => {
        const {
            historyId,
            hdas: [a, b, c],
        } = await threeDatasets();
        const router = makeRouter();
        const post = (body: unknown, status: number) =>
            fetchJson(router, "POST", "/api/dataset_collections", body, status);
        expect(await post({ history_id: historyId, element_identifiers: [] }, 400)).toEqual({
            err_code: 400005,
            err_msg: "Missing required parameters ['collection_type']",
        });
        const base = { history_id: historyId, copy_elements: false };
        expect(
            (
                await post(
                    { ...base, collection_type: "list", element_identifiers: [hdaRef(a!.id, "x"), hdaRef(b!.id, "x")] },
                    400,
                )
            ).err_msg,
        ).toBe("Found duplicated element identifier name x.");
        expect(
            (
                await post(
                    { ...base, collection_type: "list", element_identifiers: [{ src: "nope", id: "1", name: "x" }] },
                    400,
                )
            ).err_msg,
        ).toBe("Unknown dataset source (src) nope.");
        expect((await post({ collection_type: "list", element_identifiers: [hdaRef(a!.id, "x")] }, 400)).err_msg).toBe(
            "Parameter history_id is required.",
        );
        expect(
            (await post({ ...base, collection_type: "list:paired", element_identifiers: [hdaRef(a!.id, "x")] }, 400))
                .err_msg,
        ).toContain("must be a sub-collection of type 'paired', got a dataset");
        expect(
            (
                await post(
                    {
                        ...base,
                        collection_type: "paired_or_unpaired",
                        element_identifiers: [hdaRef(a!.id, "x"), hdaRef(b!.id, "y"), hdaRef(c!.id, "z")],
                    },
                    400,
                )
            ).err_msg,
        ).toContain("1 or 2 datasets is required");
        expect(
            (
                await post(
                    {
                        ...base,
                        collection_type: "record",
                        fields: [{ name: "other", type: "File" }],
                        element_identifiers: [hdaRef(a!.id, "x")],
                    },
                    400,
                )
            ).err_msg,
        ).toBe("Supplied element do not match fields.");
        expect(
            (await post({ ...base, collection_type: "sample_sheet", element_identifiers: [] }, 400)).err_msg,
        ).toContain("Sample sheet");
        expect(
            (await post({ ...base, collection_type: "list", element_identifiers: [hdaRef("missing", "x")] }, 404))
                .err_code,
        ).toBe(404001);
        expect(
            (await post({ ...base, instance_type: "library", collection_type: "list", element_identifiers: [] }, 400))
                .err_msg,
        ).toContain("Library");
        expect(await hdas.listForHistory(historyId)).toMatchObject({ total: 3 });
    });

    it("builds records whose elements match the fields", async () => {
        const {
            historyId,
            hdas: [a, b],
        } = await threeDatasets();
        const created = await fetchJson(makeRouter(), "POST", "/api/dataset_collections", {
            history_id: historyId,
            collection_type: "record",
            copy_elements: false,
            fields: [
                { name: "reads", type: "File" },
                { name: "index", type: "File" },
            ],
            element_identifiers: [hdaRef(a!.id, "reads"), hdaRef(b!.id, "index")],
        });
        expect(created.elements.map((element: { element_identifier: string }) => element.element_identifier)).toEqual([
            "reads",
            "index",
        ]);
    });
});

describe("reading collections", () => {
    async function nestedCollection() {
        const { historyId, hdas: created } = await threeDatasets();
        const { hdca, collection } = await collections.createHdca({
            hdca: { history_id: historyId, name: "nested" },
            collection: {
                collection_type: "list:paired",
                elements: [
                    {
                        identifier: "s1",
                        collection: {
                            collection_type: "paired",
                            elements: [
                                { identifier: "forward", hda_id: created[0]!.id },
                                { identifier: "reverse", hda_id: created[1]!.id },
                            ],
                        },
                    },
                    {
                        identifier: "s2",
                        collection: {
                            collection_type: "paired",
                            elements: [
                                { identifier: "forward", hda_id: created[2]!.id },
                                { identifier: "reverse", hda_id: created[0]!.id },
                            ],
                        },
                    },
                ],
            },
        });
        return { historyId, hdca, collection, hdas: created };
    }

    it("shows the element view by default and the collection view on request", async () => {
        const { hdca } = await nestedCollection();
        const router = makeRouter();
        const shown = await fetchJson(router, "GET", `/api/dataset_collections/${hdca.id}`);
        expect(shown).toMatchObject({ id: hdca.id, collection_type: "list:paired", populated: true });
        expect(shown.elements).toHaveLength(2);
        const summary = await fetchJson(router, "GET", `/api/dataset_collections/${hdca.id}?view=collection`);
        expect(summary.elements).toBeUndefined();
        expect((await fetchJson(router, "GET", "/api/dataset_collections/missing", undefined, 404)).err_code).toBe(
            404001,
        );
        expect(
            (
                await fetchJson(
                    router,
                    "GET",
                    `/api/dataset_collections/${hdca.id}?instance_type=library`,
                    undefined,
                    400,
                )
            ).err_msg,
        ).toContain("instance_type");
    });

    it("lists element references with drill-down URLs and pagination", async () => {
        const { hdca, collection, hdas: created } = await nestedCollection();
        const router = makeRouter();
        const top = await fetchJson(router, "GET", `/api/dataset_collections/${hdca.id}/contents/${collection.id}`);
        expect(top).toHaveLength(2);
        const child = top[0].object;
        expect(top[0]).toMatchObject({
            model_class: "DatasetCollectionElement",
            element_identifier: "s1",
            element_index: 0,
            element_type: "dataset_collection",
            columns: null,
        });
        expect(child).toMatchObject({
            model_class: "DatasetCollection",
            collection_type: "paired",
            element_count: 2,
            populated: true,
            elements: [],
            elements_states: { ok: 2 },
            elements_datatypes: ["fasta"],
            elements_deleted: 0,
            contents_url: `/api/dataset_collections/${hdca.id}/contents/${child.id}`,
        });

        const inner = await fetchJson(router, "GET", child.contents_url);
        expect(inner.map((element: { element_identifier: string }) => element.element_identifier)).toEqual([
            "forward",
            "reverse",
        ]);
        expect(inner[0].object).toEqual({
            id: created[0]!.id,
            model_class: "HistoryDatasetAssociation",
            state: "ok",
            hda_ldda: "hda",
            purged: false,
            history_id: created[0]!.history_id,
            tags: [],
            accessible: true,
            copied_from_ldda_id: null,
        });

        const page = await fetchJson(
            router,
            "GET",
            `/api/dataset_collections/${hdca.id}/contents/${collection.id}?offset=1&limit=1`,
        );
        expect(page.map((element: { element_identifier: string }) => element.element_identifier)).toEqual(["s2"]);

        const other = await addList(hdca.history_id, [created[0]!.id]);
        const error = await fetchJson(
            router,
            "GET",
            `/api/dataset_collections/${hdca.id}/contents/${other.collection_id}`,
            undefined,
            404,
        );
        expect(error.err_msg).toBe("Requested dataset collection is not contained within indicated history content");

        const elementId = inner[0].id;
        const single = await fetchJson(router, "GET", `/api/dataset_collection_element/${elementId}`);
        expect(single).toMatchObject({ id: elementId, element_identifier: "forward" });
    });

    it("summarizes the datatypes and builds of the elements", async () => {
        const { hdca, hdas: created } = await nestedCollection();
        const router = makeRouter();
        expect(await fetchJson(router, "GET", `/api/dataset_collections/${hdca.id}/attributes`)).toEqual({
            model_class: "HistoryDatasetCollectionAssociation",
            dbkeys: null,
            extensions: null,
            tags: [],
            dbkey: "hg38",
            extension: "fasta",
        });
        await hdas.update(created[1]!.id, { extension: "txt", dbkey: "mm10" });
        expect(await fetchJson(router, "GET", `/api/dataset_collections/${hdca.id}/attributes`)).toMatchObject({
            dbkey: "?",
            extension: "auto",
        });
        expect(await fetchJson(router, "GET", `/api/dataset_collections/${hdca.id}/suitable_converters`)).toEqual([]);
    });
});
