// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { HistoryDetailed as ClientHistoryDetailed, HistoryDevDetailed } from "@/api";
import type { components } from "@/api/schema";
import { datasets, hdas, histories, jobs, settings } from "@/planet/db";

import {
    HISTORY_DETAILED_KEYS,
    HISTORY_DEV_DETAILED_KEYS,
    HISTORY_SUMMARY_KEYS,
    type HistoryDetailedView,
    type HistoryDevDetailedView,
    type HistorySummaryView,
    matchesTagTerm,
} from "../histories";
import { PLANET_USER_ID } from "../users";
import {
    addDataset,
    addJob,
    addList,
    assertAssignable,
    currentHistoryId,
    fetchJson,
    keysOf,
    makeRouter,
    resetPlanet,
    send,
    teardownPlanet,
} from "./contents.fixtures";

type HistorySummary = components["schemas"]["HistorySummary"];

// The fixed views must satisfy the API schema and the client's own types.
assertAssignable<HistorySummary>()<HistorySummaryView>();
assertAssignable<Omit<ClientHistoryDetailed, "email_hash"> & { email_hash: string | null }>()<HistoryDetailedView>();
assertAssignable<HistoryDevDetailed>()<HistoryDevDetailedView>();

beforeEach(resetPlanet);
afterEach(teardownPlanet);

async function createHistory(name: string, fields: Partial<Parameters<typeof histories.update>[1]> = {}) {
    const history = await histories.create({ name });
    return Object.keys(fields).length ? histories.update(history.id, fields) : history;
}

describe("serialization views", () => {
    it("serializes summary, detailed and dev-detailed views with Galaxy's keys", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        await addDataset(historyId, { name: "a" }, { state: "ok", file_size: 10, total_size: 10 });
        await addDataset(historyId, { name: "b", visible: false }, { state: "running", file_size: 5, total_size: 5 });
        await addDataset(historyId, { name: "c", deleted: true }, { state: "error", file_size: 7, total_size: 7 });

        const summary = await fetchJson(router, "GET", `/api/histories/${historyId}?view=summary`);
        expect(keysOf(summary)).toEqual([...HISTORY_SUMMARY_KEYS].sort());
        expect(summary).toMatchObject({
            id: historyId,
            model_class: "History",
            count: 3,
            url: `/api/histories/${historyId}`,
        });

        const detailed = await fetchJson(router, "GET", `/api/histories/${historyId}`);
        expect(keysOf(detailed)).toEqual([...HISTORY_DETAILED_KEYS].sort());
        expect(detailed).toMatchObject({
            size: 22,
            empty: false,
            hid_counter: 4,
            user_id: PLANET_USER_ID,
            username: "planet",
            state: "running",
            contents_url: `/api/histories/${historyId}/contents`,
            email_hash: null,
        });
        expect(detailed.state_details).toMatchObject({ ok: 1, running: 1, error: 0 });
        expect(Object.keys(detailed.state_ids)).toContain("discarded");
        expect(detailed.state_ids.error).toHaveLength(1);

        const dev = await fetchJson(router, "GET", `/api/histories/${historyId}?view=dev-detailed`);
        expect(keysOf(dev)).toEqual([...HISTORY_DEV_DETAILED_KEYS].sort());
        expect(dev.contents_active).toEqual({ active: 1, deleted: 1, hidden: 1 });
    });

    it("returns only the requested keys when no view is given, and adds keys to a view", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        await addDataset(historyId);
        const stats = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}?keys=size,contents_active,update_time`,
        );
        expect(keysOf(stats)).toEqual(["contents_active", "size", "update_time"]);
        const extended = await fetchJson(
            router,
            "GET",
            `/api/histories/${historyId}?view=summary&keys=size,nice_size,contents_states,bogus`,
        );
        expect(extended).toMatchObject({ size: 100, nice_size: "100 bytes", contents_states: { ok: 1 } });
        expect(extended).not.toHaveProperty("bogus");
        expect((await send(router, "GET", `/api/histories/${historyId}?view=everything`)).status).toBe(400);
    });

    it("derives the history state like Galaxy", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        expect((await fetchJson(router, "GET", `/api/histories/${historyId}`)).state).toBe("new");
        const { dataset } = await addDataset(historyId, {}, { state: "queued" });
        expect((await fetchJson(router, "GET", `/api/histories/${historyId}`)).state).toBe("queued");
        await datasets.setState(dataset.id, "ok");
        expect((await fetchJson(router, "GET", `/api/histories/${historyId}`)).state).toBe("ok");
        await addDataset(historyId, {}, { state: "error" });
        expect((await fetchJson(router, "GET", `/api/histories/${historyId}`)).state).toBe("error");
    });

    it("answers 404 for unknown histories", async () => {
        const response = await send(makeRouter(), "GET", "/api/histories/0123456789abcdef");
        expect(response.status).toBe(404);
        expect((await response.json()).err_code).toBe(404001);
    });
});

describe("GET /api/histories with q/qv", () => {
    it("lists active, non-archived histories newest first by default and paginates", async () => {
        const router = makeRouter();
        const first = await currentHistoryId();
        const second = await createHistory("second");
        const third = await createHistory("third");
        await createHistory("deleted", { deleted: true });
        await createHistory("archived", { archived: true });

        const all = await fetchJson(router, "GET", "/api/histories");
        expect(all.map((h: { id: string }) => h.id)).toEqual([third.id, second.id, first]);
        expect(keysOf(all[0])).toEqual([...HISTORY_SUMMARY_KEYS].sort());

        const page = await fetchJson(router, "GET", "/api/histories?view=summary&order=update_time&offset=1&limit=1");
        expect(page.map((h: { id: string }) => h.id)).toEqual([second.id]);
        expect(await fetchJson(router, "GET", "/api/histories/count")).toBe(3);
    });

    it("handles the deleted filter and the deleted-only flag", async () => {
        const router = makeRouter();
        await currentHistoryId();
        const gone = await createHistory("gone", { deleted: true });
        const purged = await createHistory("purged", { deleted: true, purged: true });
        const deleted = await fetchJson(router, "GET", "/api/histories?q=deleted&qv=true");
        expect(deleted.map((h: { id: string }) => h.id).sort()).toEqual([gone.id, purged.id].sort());
        const purgedOnly = await fetchJson(router, "GET", "/api/histories?q=purged&qv=True&q=deleted&qv=True");
        expect(purgedOnly.map((h: { id: string }) => h.id)).toEqual([purged.id]);
        expect(await fetchJson(router, "GET", "/api/histories?q=deleted&qv=None")).toHaveLength(3);
        expect(await fetchJson(router, "GET", "/api/histories?deleted=true")).toHaveLength(2);
        expect(await fetchJson(router, "GET", "/api/histories/deleted")).toHaveLength(2);
    });

    it("filters by name and tag and orders by name", async () => {
        const router = makeRouter();
        await currentHistoryId();
        await createHistory("Beta reads", { tags: ["name:rna"] });
        await createHistory("alpha reads", { tags: ["group:x"] });
        await createHistory("unrelated");
        const named = await fetchJson(router, "GET", "/api/histories?q=name-contains&qv=READS&order=name-asc");
        expect(named.map((h: { name: string }) => h.name)).toEqual(["alpha reads", "Beta reads"]);
        const tagged = await fetchJson(router, "GET", "/api/histories?q=tag&qv=name");
        expect(tagged.map((h: { name: string }) => h.name)).toEqual(["Beta reads"]);
        const bad = await send(router, "GET", "/api/histories?q=colour&qv=red");
        expect(bad.status).toBe(400);
        expect(await bad.json()).toMatchObject({ err_msg: "bad filter", column: "colour" });
        expect((await send(router, "GET", "/api/histories?order=colour")).status).toBe(400);
        expect((await send(router, "GET", "/api/histories?all=true")).status).toBe(403);
    });
});

describe("GET /api/histories with search", () => {
    it("matches name, tag, user and free text and sets total_matches", async () => {
        const router = makeRouter();
        await histories.update(await currentHistoryId(), { name: "first" });
        await createHistory("RNA reads", { tags: ["name:experiment1"] });
        await createHistory("Proteins", { tags: ["group:lab"] });
        await createHistory("Old", { deleted: true });

        const response = await send(
            router,
            "GET",
            "/api/histories?view=summary&keys=username&search=reads&show_published=false&limit=10&offset=0&sort_by=name&sort_desc=false",
        );
        expect(response.headers.get("total_matches")).toBe("1");
        const [found] = await response.json();
        expect(found).toMatchObject({ name: "RNA reads", username: "planet" });

        const byTag = await fetchJson(router, "GET", "/api/histories?search=tag:experiment&show_published=false");
        expect(byTag.map((h: { name: string }) => h.name)).toEqual(["RNA reads"]);
        const byQuotedName = await fetchJson(
            router,
            "GET",
            "/api/histories?search=name:'Proteins'&show_published=false",
        );
        expect(byQuotedName.map((h: { name: string }) => h.name)).toEqual(["Proteins"]);
        const byUser = await fetchJson(router, "GET", "/api/histories?search=user:plan&show_published=false");
        expect(byUser).toHaveLength(3);
        const deleted = await fetchJson(router, "GET", "/api/histories?search=is:deleted&show_published=false");
        expect(deleted.map((h: { name: string }) => h.name)).toEqual(["Old"]);
        // With published histories shown, Galaxy ignores is:deleted and lists the live histories.
        const live = await fetchJson(router, "GET", "/api/histories?search=is:deleted");
        expect(live.map((h: { name: string }) => h.name).sort()).toEqual(["Proteins", "RNA reads", "first"]);

        const sorted = await send(
            router,
            "GET",
            "/api/histories?search=&show_published=false&sort_by=name&sort_desc=true&limit=2",
        );
        expect(sorted.headers.get("total_matches")).toBe("3");
        expect((await sorted.json()).map((h: { name: string }) => h.name)).toEqual(["RNA reads", "Proteins"]);
        expect((await send(router, "GET", "/api/histories?search=is:shared_with_me&show_published=false")).status).toBe(
            400,
        );
    });

    it("matches tag terms like Galaxy's tag_filter", () => {
        expect(matchesTagTerm(["name:Experiment1"], "experiment", false)).toBe(true);
        expect(matchesTagTerm(["name:experiment1"], "name:exp", false)).toBe(true);
        expect(matchesTagTerm(["name:experiment1"], "name:exp", true)).toBe(false);
        expect(matchesTagTerm(["group:lab"], "lab", false)).toBe(false);
        expect(matchesTagTerm(["group:lab"], "gro", false)).toBe(true);
        expect(matchesTagTerm(["plain"], "plain", true)).toBe(true);
    });
});

describe("PUT /api/histories/{history_id}", () => {
    it("updates fields, normalizes tags and bumps update_time", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const before = await histories.getOrThrow(historyId);
        const updated = await fetchJson(
            router,
            "PUT",
            `/api/histories/${historyId}?view=summary&keys=size,contents_active,user_id`,
            {
                name: "Renamed",
                annotation: "  notes  ",
                tags: ["#Sample A", "group:lab", "group:lab"],
                genome_build: null,
                unknown: "ignored",
            },
        );
        expect(updated).toMatchObject({
            name: "Renamed",
            annotation: "notes",
            tags: ["name:SampleA", "group:lab"],
            size: 0,
            user_id: PLANET_USER_ID,
            contents_active: { active: 0, deleted: 0, hidden: 0 },
        });
        const stored = await histories.getOrThrow(historyId);
        expect(stored.genome_build).toBe("?");
        expect(stored.update_time > before.update_time).toBe(true);
        expect((await send(router, "PUT", `/api/histories/${historyId}`, { name: 5 })).status).toBe(400);
    });

    it("deletes and undeletes through the deleted flag", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        expect((await fetchJson(router, "PUT", `/api/histories/${historyId}`, { deleted: true })).deleted).toBe(true);
        expect((await fetchJson(router, "PUT", `/api/histories/${historyId}`, { deleted: false })).deleted).toBe(false);
    });
});

describe("DELETE /api/histories/{history_id}", () => {
    it("marks the history deleted without touching its contents", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const { hda } = await addDataset(historyId);
        const deleted = await fetchJson(router, "DELETE", `/api/histories/${historyId}`);
        expect(deleted).toMatchObject({ id: historyId, deleted: true, purged: false });
        expect((await hdas.getOrThrow(hda.id)).deleted).toBe(false);
    });

    it("purges datasets, deletes collections and stops running jobs", async () => {
        const router = makeRouter();
        const historyId = await currentHistoryId();
        const job = await addJob(historyId, { state: "running" });
        const { hda, dataset } = await addDataset(
            historyId,
            { creating_job_id: job.id },
            { state: "running", job_id: job.id },
        );
        await jobs.update(job.id, { outputs: [{ name: "out", src: "hda", id: hda.id }] });
        const shared = await addDataset(historyId, { name: "shared" });
        const other = await histories.create({ name: "other" });
        await hdas.copy(shared.hda.id, other.id);
        const hdca = await addList(historyId, [shared.hda.id]);

        const purged = await fetchJson(router, "DELETE", `/api/histories/${historyId}?purge=true`);
        expect(purged).toMatchObject({ deleted: true, purged: true });
        expect(await hdas.getOrThrow(hda.id)).toMatchObject({ deleted: true, purged: true });
        expect(await datasets.getOrThrow(dataset.id)).toMatchObject({ purged: true, state: "discarded" });
        expect((await jobs.getOrThrow(job.id)).state).toBe("deleting");
        // A dataset still used by another history is kept.
        expect((await datasets.getOrThrow(shared.dataset.id)).purged).toBe(false);
        expect(
            (await fetchJson(router, "GET", `/api/histories/${historyId}/contents/dataset_collections/${hdca.id}`))
                .deleted,
        ).toBe(true);
        expect((await send(router, "POST", `/api/histories/deleted/${historyId}/undelete`)).status).toBe(400);
    });

    it("accepts purge in the request body", async () => {
        const historyId = await currentHistoryId();
        const purged = await fetchJson(makeRouter(), "DELETE", `/api/histories/${historyId}`, { purge: true });
        expect(purged.purged).toBe(true);
    });
});

describe("POST /api/histories", () => {
    it("creates a history with the given or default name", async () => {
        const router = makeRouter();
        const named = await fetchJson(router, "POST", "/api/histories", { name: "Analysis" });
        expect(keysOf(named)).toEqual([...HISTORY_DETAILED_KEYS].sort());
        expect(named).toMatchObject({ name: "Analysis", count: 0, empty: true, hid_counter: 1 });
        const form = await router.handle(
            new Request("https://planet.test/api/histories", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: "name=From+form",
            }),
        );
        expect((await form.json()).name).toBe("From form");
        expect((await fetchJson(router, "POST", "/api/histories", {})).name).toBe("Unnamed history");
    });

    it("copies a history keeping hids, tags and annotation", async () => {
        const router = makeRouter();
        const sourceId = await currentHistoryId();
        await histories.update(sourceId, { name: "Source", tags: ["group:lab"], annotation: "about" });
        const kept = await addDataset(sourceId, { name: "kept", tags: ["name:x"] });
        await addDataset(sourceId, { name: "removed", deleted: true });
        const third = await addDataset(sourceId, { name: "third" });
        await addList(sourceId, [kept.hda.id, third.hda.id]);

        const copy = await fetchJson(router, "POST", "/api/histories?view=detailed", {
            history_id: sourceId,
            all_datasets: false,
        });
        expect(copy).toMatchObject({
            name: "Copy of 'Source'",
            tags: ["group:lab"],
            annotation: "about",
            hid_counter: 5,
        });
        const contents = await fetchJson(router, "GET", `/api/histories/${copy.id}/contents?v=dev&order=hid-asc`);
        expect(contents.map((item: { hid: number; name: string }) => [item.hid, item.name])).toEqual([
            [1, "kept"],
            [3, "third"],
            [4, "list"],
        ]);
        expect(contents[0].tags).toEqual(["name:x"]);
        const copied = await hdas.getOrThrow(contents[0].id);
        expect(copied.copied_from).toEqual({ src: "hda", id: kept.hda.id });
        expect(copied.dataset_id).toBe(kept.dataset.id);
        const collection = await fetchJson(
            router,
            "GET",
            `/api/histories/${copy.id}/contents/dataset_collections/${contents[2].id}`,
        );
        expect(collection.elements.map((element: { object: { id: string } }) => element.object.id)).toEqual([
            contents[0].id,
            contents[1].id,
        ]);

        const everything = await fetchJson(router, "POST", "/api/histories", { history_id: sourceId, name: "All" });
        expect((await fetchJson(router, "GET", `/api/histories/${everything.id}/contents?v=dev`)).length).toBe(4);
        expect(
            (await send(router, "POST", "/api/histories", { archive_source: "https://example.org/h.tgz" })).status,
        ).toBe(501);
    });
});

describe("batch delete and undelete", () => {
    it("deletes and restores several histories", async () => {
        const router = makeRouter();
        const a = await createHistory("a");
        const b = await createHistory("b");
        const deleted = await fetchJson(router, "PUT", "/api/histories/batch/delete", {
            ids: [a.id, b.id],
            purge: false,
        });
        expect(deleted.map((h: { deleted: boolean }) => h.deleted)).toEqual([true, true]);
        const restored = await fetchJson(router, "PUT", "/api/histories/batch/undelete", { ids: [a.id] });
        expect(restored).toMatchObject([{ id: a.id, deleted: false }]);
        expect(await fetchJson(router, "POST", `/api/histories/deleted/${b.id}/undelete`)).toMatchObject({
            deleted: false,
        });
        expect((await send(router, "PUT", "/api/histories/batch/delete", { ids: "nope" })).status).toBe(400);
    });
});

describe("user fields", () => {
    it("uses the username from settings", async () => {
        await settings.update({ user: { username: "someone" } });
        const historyId = await currentHistoryId();
        await histories.update(historyId, { slug: "my-history" });
        const detailed = await fetchJson(makeRouter(), "GET", `/api/histories/${historyId}`);
        expect(detailed).toMatchObject({ username: "someone", username_and_slug: "u/someone/h/my-history" });
    });
});
