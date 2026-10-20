// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWhooshQuery } from "@/components/Panels/utilities";
import { tools, writeTx } from "@/planet/db";
import { Router } from "@/planet/sw/router";

import { bundlePath, getToolBundle, parseToolQuery, register, type ToolEntry } from "../tools";
import { fetchJson, resetPlanet, send, teardownPlanet } from "./contents.fixtures";
import { FakeBucket, stubNetwork } from "./datasets.fixtures";

const COLUMN_MAKER = "toolshed.g2.bx.psu.edu/repos/iuc/column_maker/Add_a_column1/2.1.4";
const DATAMASH = "toolshed.g2.bx.psu.edu/repos/iuc/datamash/datamash_ops/1.8+galaxy0";

function entry(fields: Partial<ToolEntry> & { id: string; name: string }): ToolEntry {
    return {
        model_class: "Tool",
        version: "1.0",
        description: null,
        labels: [],
        icon: null,
        edam_operations: [],
        edam_topics: [],
        hidden: false,
        is_workflow_compatible: true,
        xrefs: [],
        hidden_versions: [],
        link: `/tool_runner?tool_id=${encodeURIComponent(fields.id)}`,
        has_parameters: true,
        panel_section_id: "textutil",
        panel_section_name: "Text Manipulation",
        form_style: "regular",
        ...fields,
        versions: fields.versions ?? [fields.version ?? "1.0"],
    };
}

const UPLOAD = entry({
    id: "upload1",
    name: "Upload File",
    version: "1.1.7",
    description: "from your computer",
    edam_operations: ["operation_0224"],
    panel_section_id: "getext",
    panel_section_name: "Get Data",
});
const COLUMN = entry({
    id: COLUMN_MAKER,
    name: "Compute",
    version: "2.1.4",
    description: "on rows",
    edam_operations: ["operation_3436"],
    tool_shed_repository: { name: "column_maker", owner: "iuc" },
});
const DATAMASH_ENTRY = entry({
    id: DATAMASH,
    name: "Datamash",
    version: "1.8+galaxy0",
    description: "(operations on tabular data)",
    panel_section_id: "datamash",
    panel_section_name: "Datamash",
    edam_topics: ["topic_2269"],
    tool_shed_repository: { name: "datamash", owner: "iuc" },
});

const SECTION = (id: string, name: string, toolIds: string[]) => ({
    model_class: "ToolSection",
    id,
    name,
    version: "",
    description: null,
    links: null,
    tools: toolIds,
});

const PANEL = {
    getext: SECTION("getext", "Get Data", ["upload1"]),
    textutil: SECTION("textutil", "Text Manipulation", [COLUMN_MAKER]),
    datamash: SECTION("datamash", "Datamash", [DATAMASH]),
};

const PANELS = {
    default_panel_view: "default",
    views: {
        default: {
            id: "default",
            model_class: "ABCMeta",
            name: "Full Tool Panel",
            description: "",
            view_type: "default",
            searchable: true,
        },
        "ontology:edam_topics": {
            id: "ontology:edam_topics",
            model_class: "EdamToolPanelView",
            name: "EDAM Topics",
            description: "",
            view_type: "ontology",
            searchable: true,
        },
    },
};

const TOPIC_PANEL = { topic_2269: SECTION("topic_2269", "Biostatistics", [DATAMASH]) };

const CITATIONS = [
    { type: "bibtex", content: "@article{datamash, title={Datamash}}" },
    { type: "doi", content: "10.1000/known" },
    { type: "doi", content: "10.1000/unknown" },
];

const TOOLBOX_FILES: Record<string, unknown> = {
    "/static/planet/data/toolbox/panels.json": PANELS,
    "/static/planet/data/toolbox/panel.json": PANEL,
    "/static/planet/data/toolbox/panel_views/default.json": PANEL,
    [`/static/planet/data/toolbox/panel_views/${encodeURIComponent("ontology:edam_topics")}.json`]: TOPIC_PANEL,
    "/static/planet/data/toolbox/tools.json": [UPLOAD, COLUMN, DATAMASH_ENTRY],
    "/static/planet/data/toolbox/tool_tags.json": { [DATAMASH]: ["Statistics"] },
    [`/static/planet/data/${bundlePath(DATAMASH, "1.8+galaxy0")}`]: {
        id: DATAMASH,
        version: "1.8+galaxy0",
        name: "Datamash",
        inputs: [],
        outputs: [],
        citations: CITATIONS,
    },
};

function doiService(url: URL): Response | undefined {
    if (url.origin !== "https://doi.org") {
        return undefined;
    }
    if (url.pathname === "/10.1000/known") {
        return new Response("@article{known, title={Known}}");
    }
    return new Response("not found", { status: 404 });
}

function makeRouter(): Router {
    const router = new Router();
    register(router);
    return router;
}

function useToolbox(files: Record<string, unknown> = TOOLBOX_FILES) {
    return stubNetwork(files, new FakeBucket(), doiService);
}

beforeEach(async () => {
    await resetPlanet();
    useToolbox();
});
afterEach(teardownPlanet);

describe("tool panels", () => {
    it("serves the panel views and a view's sections", async () => {
        const router = makeRouter();
        expect(await fetchJson(router, "GET", "/api/tool_panels")).toEqual(PANELS);
        expect(await fetchJson(router, "GET", "/api/tool_panels/default")).toEqual(PANEL);
        expect(await fetchJson(router, "GET", "/api/tool_panels/default_panel_view")).toEqual(PANEL);
        expect(await fetchJson(router, "GET", "/api/tool_panels/ontology:edam_topics")).toEqual(TOPIC_PANEL);
        const error = await fetchJson(router, "GET", "/api/tool_panels/nope", undefined, 400);
        expect(error.err_msg).toBe("No panel view nope found.");
    });

    it("offers a default panel with the upload tool when the deployment has no toolbox", async () => {
        useToolbox({});
        const router = makeRouter();
        const views = await fetchJson(router, "GET", "/api/tool_panels");
        expect(views.default_panel_view).toBe("default");
        expect(Object.keys(views.views)).toEqual(["default"]);
        const panel = await fetchJson(router, "GET", "/api/tool_panels/default");
        expect(panel.getext.tools).toEqual(["upload1"]);
        const listed = await fetchJson(router, "GET", "/api/tools?in_panel=false");
        expect(listed.map((tool: ToolEntry) => tool.id)).toEqual(["upload1"]);
        expect(listed[0]).toMatchObject({ name: "Upload File", form_style: "regular", panel_section_id: "getext" });
        expect(await fetchJson(router, "GET", "/api/tags/tool_tags")).toEqual({});
        expect(await fetchJson(router, "GET", "/api/tools?q=upload")).toEqual(["upload1"]);
    });

    it("adds the upload tool to a toolbox that lacks it", async () => {
        const files = { ...TOOLBOX_FILES };
        files["/static/planet/data/toolbox/tools.json"] = [COLUMN];
        const { getext: _getext, ...withoutGetData } = PANEL;
        files["/static/planet/data/toolbox/panel_views/default.json"] = withoutGetData;
        useToolbox(files);
        const router = makeRouter();
        const panel = await fetchJson(router, "GET", "/api/tool_panels/default");
        expect(Object.keys(panel)).toEqual(["getext", "textutil", "datamash"]);
        expect(panel.getext.tools).toEqual(["upload1"]);
        const listed = await fetchJson(router, "GET", "/api/tools?in_panel=false");
        expect(listed.map((tool: ToolEntry) => tool.id)).toEqual(["upload1", COLUMN_MAKER]);
    });

    it("lists tools inside their sections for in_panel", async () => {
        const sections = await fetchJson(makeRouter(), "GET", "/api/tools");
        expect(sections.map((section: { id: string }) => section.id)).toEqual(["getext", "textutil", "datamash"]);
        expect(sections[1].elems).toEqual([COLUMN]);
        expect(sections[1].tools).toBeUndefined();
    });

    it("includes ready, visible installed tools", async () => {
        const installed = entry({ id: "installed_tool", name: "Installed" });
        await tools.put({
            tool_id: "installed_tool",
            tool_version: "1.0",
            source: "installed",
            status: "ready",
            message: null,
            bundle: { panel_entry: installed },
            bundle_url: null,
            panel_section_id: null,
            panel_section_name: null,
            hidden: false,
        });
        const listed = await fetchJson(makeRouter(), "GET", "/api/tools?in_panel=false");
        expect(listed.map((tool: ToolEntry) => tool.id)).toContain("installed_tool");
    });

    it("shows installed tools in an Installed tools section of the default panel", async () => {
        useToolbox({ ...TOOLBOX_FILES, "/static/planet/data/toolbox/tools_in_panel.json": [{ id: "prebuilt" }] });
        const installed = entry({ id: "installed_tool", name: "Installed", panel_section_id: "planet_installed" });
        const record = {
            tool_version: "1.0",
            source: "installed" as const,
            message: null,
            bundle_url: null,
            panel_section_id: "planet_installed",
            panel_section_name: "Installed tools",
            hidden: false,
        };
        await tools.put({ ...record, tool_id: "installed_tool", status: "ready", bundle: { panel_entry: installed } });
        await tools.put({
            ...record,
            tool_id: "failed_tool",
            status: "failed",
            bundle: { panel_entry: entry({ id: "failed_tool", name: "Failed" }) },
        });
        const router = makeRouter();
        const panel = await fetchJson(router, "GET", "/api/tool_panels/default");
        expect(Object.keys(panel)).toEqual(["getext", "textutil", "datamash", "planet_installed"]);
        expect(panel.planet_installed).toMatchObject({
            model_class: "ToolSection",
            name: "Installed tools",
            tools: ["installed_tool"],
        });
        expect(await fetchJson(router, "GET", "/api/tool_panels/ontology:edam_topics")).toEqual(TOPIC_PANEL);
        const sections = await fetchJson(router, "GET", "/api/tools");
        expect(sections.at(-1)).toMatchObject({ id: "planet_installed", elems: [installed] });
    });
});

const DEMO = "github.com/repos/planet/demo/concat_demo";

/** Stores a ready installed tool version whose bundle has no parameters. */
function installVersion(id: string, version: string, fields: Partial<ToolEntry> = {}) {
    const panelEntry = entry({
        id,
        name: "Concat",
        version,
        panel_section_id: "planet_installed",
        panel_section_name: "Installed tools",
        ...fields,
    });
    return tools.put({
        tool_id: id,
        tool_version: version,
        source: "installed",
        status: "ready",
        message: null,
        bundle: {
            id,
            old_id: "concat_demo",
            version,
            name: panelEntry.name,
            profile: "23.0",
            inputs: [],
            outputs: [],
            panel_entry: panelEntry,
        },
        bundle_url: null,
        panel_section_id: "planet_installed",
        panel_section_name: "Installed tools",
        hidden: false,
    });
}

describe("tool lineages", () => {
    it("shows each lineage once with its newest version and lists every version for the form", async () => {
        await installVersion(`${DEMO}/1.10`, "1.10");
        await installVersion(`${DEMO}/1.9`, "1.9");
        const router = makeRouter();
        const panel = await fetchJson(router, "GET", "/api/tool_panels/default");
        expect(panel.planet_installed.tools).toEqual([`${DEMO}/1.10`]);
        const sections = await fetchJson(router, "GET", "/api/tools");
        expect(sections.at(-1).elems.map((tool: ToolEntry) => tool.id)).toEqual([`${DEMO}/1.10`]);
        const listed: ToolEntry[] = await fetchJson(router, "GET", "/api/tools?in_panel=false");
        expect(listed.filter((tool) => tool.id.startsWith(DEMO)).map((tool) => [tool.id, tool.versions])).toEqual([
            [`${DEMO}/1.10`, ["1.9", "1.10"]],
            [`${DEMO}/1.9`, ["1.9", "1.10"]],
        ]);
        expect(await fetchJson(router, "GET", `/api/tools?tool_id=${encodeURIComponent(`${DEMO}/1.9`)}`)).toEqual([
            "1.9",
            "1.10",
        ]);
        expect(await fetchJson(router, "GET", "/api/tools?q=concat")).toEqual([`${DEMO}/1.10`]);
        expect((await fetchJson(router, "GET", `/api/tools/${DEMO}/1.9`)).version).toBe("1.9");
        expect((await fetchJson(router, "GET", `/api/tools/${DEMO}/1.9?tool_version=1.10`)).id).toBe(`${DEMO}/1.10`);

        const form = await fetchJson(router, "GET", `/api/tools/${DEMO}/1.9/build`);
        expect(form).toMatchObject({ id: `${DEMO}/1.9`, version: "1.9", versions: ["1.9", "1.10"] });
        const switched = await fetchJson(router, "GET", `/api/tools/${DEMO}/1.9/build?tool_version=1.10`);
        expect(switched).toMatchObject({ id: `${DEMO}/1.10`, version: "1.10", versions: ["1.9", "1.10"] });
    });

    it("shows a newer installed version of a built-in tool in the built-in tool's place", async () => {
        const newer = DATAMASH.replace(/1\.8\+galaxy0$/, "1.9+galaxy0");
        await installVersion(newer, "1.9+galaxy0", { name: "Datamash" });
        const router = makeRouter();
        const panel = await fetchJson(router, "GET", "/api/tool_panels/default");
        expect(panel.datamash.tools).toEqual([newer]);
        expect(panel.planet_installed).toBeUndefined();
        const topics = await fetchJson(router, "GET", "/api/tool_panels/ontology:edam_topics");
        expect(topics.topic_2269.tools).toEqual([newer]);
        const listed: ToolEntry[] = await fetchJson(router, "GET", "/api/tools?in_panel=false");
        expect(listed.find((tool) => tool.id === newer)).toMatchObject({
            panel_section_id: "datamash",
            panel_section_name: "Datamash",
            versions: ["1.8+galaxy0", "1.9+galaxy0"],
        });
        expect(listed.find((tool) => tool.id === DATAMASH)!.versions).toEqual(["1.8+galaxy0", "1.9+galaxy0"]);
        const sections = await fetchJson(router, "GET", "/api/tools");
        const datamash = sections.find((section: { id: string }) => section.id === "datamash");
        expect(datamash.elems.map((tool: ToolEntry) => tool.id)).toEqual([newer]);
        expect((await fetchJson(router, "GET", `/api/tools/${DATAMASH}/build`)).versions).toEqual([
            "1.8+galaxy0",
            "1.9+galaxy0",
        ]);
    });

    it("falls back to another version of the lineage when a version is gone, as Galaxy's toolbox does", async () => {
        await installVersion(`${DEMO}/1.10`, "1.10");
        // Reruns and job pages ask for the job's own version.
        expect((await getToolBundle(`${DEMO}/1.9`, "1.9"))?.id).toBe(`${DEMO}/1.10`);
        expect((await getToolBundle(`${DEMO}/1.9`))?.id).toBe(`${DEMO}/1.10`);
        expect(await getToolBundle("github.com/repos/planet/other/concat_demo/1.0", "1.0")).toBeUndefined();
        expect((await getToolBundle(DATAMASH, "0.1"))?.version).toBe("1.8+galaxy0");
    });

    it("never lets a stored record replace a built-in tool", async () => {
        await installVersion(DATAMASH, "1.8+galaxy0", { name: "Impostor" });
        const router = makeRouter();
        expect((await getToolBundle(DATAMASH, "1.8+galaxy0"))?.name).toBe("Datamash");
        const listed: ToolEntry[] = await fetchJson(router, "GET", "/api/tools?in_panel=false");
        expect(listed.filter((tool) => tool.id === DATAMASH).map((tool) => tool.name)).toEqual(["Datamash"]);
        expect((await fetchJson(router, "GET", "/api/tool_panels/default")).planet_installed).toBeUndefined();
    });
});

describe("GET /api/tools/{tool_id}", () => {
    it("shows tools whose ids contain slashes, encoded or not", async () => {
        const router = makeRouter();
        expect(await fetchJson(router, "GET", `/api/tools/${COLUMN_MAKER}`)).toEqual(COLUMN);
        expect(await fetchJson(router, "GET", `/api/tools/${encodeURIComponent(COLUMN_MAKER)}`)).toEqual(COLUMN);
        expect((await fetchJson(router, "GET", "/api/tools/nope", undefined, 404)).err_msg).toBe(
            "Could not find tool with id 'nope'.",
        );
    });

    it("lists the versions of a tool id", async () => {
        const router = makeRouter();
        expect(await fetchJson(router, "GET", `/api/tools?tool_id=${encodeURIComponent(DATAMASH)}`)).toEqual([
            "1.8+galaxy0",
        ]);
        expect(await fetchJson(router, "GET", "/api/tools?tool_id=nope")).toEqual([]);
    });

    it("returns citations as BibTeX, resolving DOIs and falling back like Galaxy", async () => {
        const citations = await fetchJson(makeRouter(), "GET", `/api/tools/${DATAMASH}/citations`);
        expect(citations).toHaveLength(3);
        expect(citations[0]).toEqual({ format: "bibtex", content: "@article{datamash, title={Datamash}}" });
        expect(citations[1]).toEqual({ format: "bibtex", content: "@article{known, title={Known}}" });
        expect(citations[2].format).toBe("bibtex");
        expect(citations[2].content).toContain("DOI = {10.1000/unknown}");
        expect(citations[2].content).toContain("Failed to fetch BibTeX for DOI.");
    });

    it("reports a missing tool in the citations list", async () => {
        expect(await fetchJson(makeRouter(), "GET", "/api/tools/nope/citations")).toEqual([
            {
                format: "error",
                error: "Tool 'nope' not found. Citations for this tool may be missing.",
                tool_id: "nope",
            },
        ]);
    });

    it("answers 404 for forms and runs of tools without a bundle", async () => {
        const router = makeRouter();
        for (const [method, path, body] of [
            ["GET", `/api/tools/${COLUMN_MAKER}/build`, undefined],
            ["POST", `/api/tools/${encodeURIComponent(COLUMN_MAKER)}/build`, {}],
            ["POST", "/api/tools", { tool_id: COLUMN_MAKER, inputs: {} }],
        ] as const) {
            const response = await send(router, method, path, body);
            expect(response.status).toBe(404);
            expect((await response.json()).err_msg).toBe(`Could not find tool with id '${COLUMN_MAKER}'.`);
        }
    });

    it("leaves uploads to the uploads module", async () => {
        const response = await send(makeRouter(), "POST", "/api/tools/fetch", {});
        expect(response.status).toBe(404);
        expect((await response.json()).err_msg).toBe("No route for /api/tools/fetch");
    });

    it("serves the curated tool tags", async () => {
        expect(await fetchJson(makeRouter(), "GET", "/api/tags/tool_tags")).toEqual({ [DATAMASH]: ["Statistics"] });
    });
});

describe("tool search", () => {
    async function search(query: string): Promise<string[]> {
        return fetchJson(makeRouter(), "GET", `/api/tools?q=${encodeURIComponent(query)}`);
    }

    it("parses the queries the client builds", () => {
        expect(parseToolQuery(createWhooshQuery({ name: "compute" }))).toEqual({
            kind: "or",
            children: [
                { kind: "term", field: "name", text: "compute", phrase: false },
                { kind: "term", field: "name_exact", text: "compute", phrase: false },
                { kind: "term", field: "description", text: "compute", phrase: false },
            ],
        });
        expect(parseToolQuery("")).toBeNull();
    });

    it("finds tools by name, description, id, section, EDAM terms and tags", async () => {
        expect(await search(createWhooshQuery({ name: "datamash" }))).toEqual([DATAMASH]);
        expect(await search(createWhooshQuery({ name: "rows" }))).toEqual([COLUMN_MAKER]);
        expect(await search(createWhooshQuery({ id: "column_maker" }))).toEqual([COLUMN_MAKER]);
        expect(await search(createWhooshQuery({ name: "compute", section: "Text Manipulation" }))).toEqual([
            COLUMN_MAKER,
        ]);
        expect(await search(createWhooshQuery({ ontology: "operation_3436" }))).toEqual([COLUMN_MAKER]);
        expect(await search(createWhooshQuery({ ontology: "topic_2269" }))).toEqual([DATAMASH]);
        expect(await search(createWhooshQuery({ tag: ["statistics"] }))).toEqual([DATAMASH]);
        expect(await search("owner:(iuc)")).toEqual([COLUMN_MAKER, DATAMASH]);
        expect(await search('section:("Get Data")')).toEqual(["upload1"]);
        expect(await search("datamash AND NOT compute")).toEqual([DATAMASH]);
        expect(await search("nothing-matches-this")).toEqual([]);
    });

    it("ranks exact name matches first", async () => {
        const hits = await search(createWhooshQuery({ name: "data" }));
        expect(hits[0]).toBe(DATAMASH);
    });

    it("answers the favorites terms from the user's preferences", async () => {
        expect(await search("#favorites")).toEqual([]);
        await writeTx(["kv"], (tx) =>
            tx.store("kv").put({ favorites: JSON.stringify({ tools: [DATAMASH, "gone"] }) }, "preferences"),
        );
        expect(await search("#favs")).toEqual([DATAMASH]);
    });
});
