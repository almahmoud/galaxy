import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolShedError } from "@/planet/install/toolshed";

import { DATAMASH_TOOL, fakeToolServices } from "../__tests__/tools";
import { TOOL_SERVICES, type ToolServices } from "../lib/tools";

import ToolsSection from "./ToolsSection.vue";

async function mountSection(
    canInstall = true,
    overrides: Partial<ToolServices> = {},
    setup: (tools: ReturnType<typeof fakeToolServices>) => void = () => undefined,
) {
    const tools = fakeToolServices(overrides);
    setup(tools);
    const wrapper = mount(ToolsSection, {
        props: { id: "pw-tools", canInstall },
        global: { provide: { [TOOL_SERVICES as symbol]: tools.services } },
        attachTo: document.body,
    });
    await flushPromises();
    return { wrapper, ...tools };
}

async function searchFor(wrapper: Awaited<ReturnType<typeof mountSection>>["wrapper"], text: string) {
    await wrapper.find("#pw-tools-query").setValue(text);
    await wrapper.find("form[role=search]").trigger("submit");
    await flushPromises();
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
});

describe("ToolsSection", () => {
    it("searches repositories and installs a chosen revision", async () => {
        const { wrapper, services } = await mountSection();
        await searchFor(wrapper, "datamash");
        expect(services.searchRepositories).toHaveBeenCalledWith("datamash", 1, expect.any(AbortSignal));
        expect(wrapper.find(".pw-result__title").text()).toBe("iuc / datamash_ops");
        expect(wrapper.find("[role=status]").text()).toContain("Showing 1 of 1 repositories");

        await wrapper.find(".pw-result button").trigger("click");
        await flushPromises();
        const select = wrapper.find<HTMLSelectElement>(".pw-result select");
        expect(select.findAll("option").map((option) => option.text())).toEqual([
            "aaafc0ac4dd2 (latest)",
            "2f3c6f2dcf39",
        ]);
        await select.setValue("2f3c6f2dcf39");
        await wrapper
            .findAll(".pw-result button")
            .find((button) => button.text() === "Install")!
            .trigger("click");
        await flushPromises();

        expect(services.install).toHaveBeenCalledWith({
            type: "toolshed",
            tool_shed_url: "https://toolshed.g2.bx.psu.edu",
            owner: "iuc",
            name: "datamash_ops",
            changeset_revision: "2f3c6f2dcf39",
        });
        expect(wrapper.text()).toContain("Installing revision 2f3c6f2dcf39");
        const install = wrapper.find(".pw-installs__item");
        expect(install.text()).toContain("iuc/datamash_ops");
        expect(install.text()).toContain("Waiting");
    });

    it("searches tools", async () => {
        const { wrapper, services } = await mountSection();
        await wrapper.findAll(".pw-segmented button")[1]!.trigger("click");
        await searchFor(wrapper, "datamash");
        expect(services.searchTools).toHaveBeenCalledWith("datamash", 1, expect.any(AbortSignal));
        expect(wrapper.find(".pw-result__meta").text()).toContain("Tool datamash_ops in iuc/datamash_ops");
        expect(wrapper.find(".pw-result button").text()).toBe("Choose a version");
    });

    it("explains a Tool Shed that cannot be searched", async () => {
        const { wrapper } = await mountSection(true, {
            searchRepositories: vi.fn(async () => {
                throw new ToolShedError("The Tool Shed could not be reached. Check your connection and try again.");
            }),
        });
        await searchFor(wrapper, "datamash");
        expect(wrapper.find("[role=alert]").text()).toContain("The Tool Shed could not be reached");
        expect(wrapper.find("[role=alert] button").text()).toBe("Try again");
    });

    it("does not install before the cluster and bucket are set up", async () => {
        const { wrapper } = await mountSection(false);
        expect(wrapper.find(".pw-note").text()).toContain("Connect the Kubernetes cluster and the storage bucket");
        await searchFor(wrapper, "datamash");
        expect(wrapper.find(".pw-result button").attributes("disabled")).toBeDefined();
    });

    it("checks GitHub sources before installing", async () => {
        const { wrapper, services } = await mountSection();
        await wrapper.find(".pw-disclosure").trigger("click");
        await wrapper.find("#pw-github-repository").setValue("galaxyproject/tools-iuc");
        await wrapper.find("#pw-github-ref").setValue("main");
        await wrapper.find("#pw-tools-github").trigger("submit");
        await flushPromises();
        expect(wrapper.find("#pw-tools-github [role=alert]").text()).toContain("full 40-character commit SHA");
        expect(services.install).not.toHaveBeenCalled();

        await wrapper.find("#pw-github-ref").setValue("a".repeat(40));
        await wrapper.find("#pw-github-path").setValue("tools/datamash");
        await wrapper.find("#pw-tools-github").trigger("submit");
        await flushPromises();
        expect(services.install).toHaveBeenCalledWith({
            type: "github",
            repository: "galaxyproject/tools-iuc",
            ref: "a".repeat(40),
            path: "tools/datamash",
        });
    });

    it("shows what each tool of a finished installation became and dismisses it", async () => {
        const { wrapper, state, services, notify } = await mountSection();
        const source = {
            type: "toolshed",
            tool_shed_url: "https://toolshed.g2.bx.psu.edu",
            owner: "iuc",
            name: "demo",
            changeset_revision: "aaafc0ac4dd2",
        } as const;
        await services.install(source);
        notify();
        await flushPromises();
        expect(wrapper.find(".pw-installs__item button").text()).toBe("Cancel");

        state.installs = state.installs.map((view) => ({
            ...view,
            state: "ok",
            phase: "partial",
            tools: [
                {
                    path: "concat.xml",
                    id: "x/concat/1.0",
                    version: "1.0",
                    name: "Concatenate",
                    state: "installed",
                    errors: [],
                    warnings: [],
                },
                {
                    path: "data_manager/fetch.xml",
                    id: null,
                    version: "1.0",
                    name: "Fetch genomes",
                    state: "rejected",
                    errors: ["Data managers are not supported: they write Galaxy's reference data tables."],
                    warnings: [],
                },
            ],
        }));
        notify();
        await flushPromises();
        const item = wrapper.find(".pw-installs__item");
        expect(item.text()).toContain("Partly installed");
        expect(item.text()).toContain("1 of 2 tools installed.");
        expect(item.text()).toContain("Data managers are not supported");
        expect(wrapper.find("p[role=status].sr-only").text()).toBe("iuc/demo: Partly installed.");

        await item.find("button").trigger("click");
        await flushPromises();
        expect(services.dismissInstall).toHaveBeenCalled();
        expect(wrapper.find(".pw-installs__item").exists()).toBe(false);
    });

    it("uninstalls a tool after confirmation and shows refusals", async () => {
        const uninstall = vi
            .fn<ToolServices["uninstall"]>()
            .mockRejectedValueOnce(new Error("A job of this tool has not finished."));
        const { wrapper, state } = await mountSection(true, { uninstall }, (tools) => {
            tools.state.installed = [DATAMASH_TOOL];
        });
        uninstall.mockImplementation(async () => {
            state.installed = [];
        });

        const item = () => wrapper.find(".pw-installed__item");
        expect(item().text()).toContain("Datamash 1.9+galaxy0");
        expect(item().text()).toContain("From iuc/datamash_ops at aaafc0ac4dd2");
        await item().find("button").trigger("click");
        await flushPromises();
        expect(document.activeElement?.textContent?.trim()).toBe("Uninstall");
        await item()
            .findAll("button")
            .find((button) => button.text() === "Uninstall")!
            .trigger("click");
        await flushPromises();
        expect(item().find("[role=alert]").text()).toBe("A job of this tool has not finished.");

        await item().find("button").trigger("click");
        await flushPromises();
        await item()
            .findAll("button")
            .find((button) => button.text() === "Uninstall")!
            .trigger("click");
        await flushPromises();
        expect(uninstall).toHaveBeenLastCalledWith(DATAMASH_TOOL.id, DATAMASH_TOOL.version);
        expect(wrapper.find(".pw-installed__item").exists()).toBe(false);
        expect(wrapper.find(".pw-installed__empty").exists()).toBe(true);
        expect(wrapper.find("p[role=status].sr-only").text()).toBe("Datamash 1.9+galaxy0 was uninstalled.");
    });

    it("polls only while an installation is unfinished", async () => {
        vi.useFakeTimers();
        const source = { type: "github", repository: "a/b", ref: "a".repeat(40), path: "" } as const;
        const { services, state } = await mountSection(true, {}, (tools) => {
            void tools.services.install(source);
        });
        vi.mocked(services.listInstalls).mockClear();
        await vi.advanceTimersByTimeAsync(3100);
        expect(services.listInstalls).toHaveBeenCalledTimes(1);

        state.installs = state.installs.map((view) => ({ ...view, state: "error", phase: "failed" }));
        await vi.advanceTimersByTimeAsync(3100);
        vi.mocked(services.listInstalls).mockClear();
        await vi.advanceTimersByTimeAsync(9000);
        expect(services.listInstalls).not.toHaveBeenCalled();
    });
});
