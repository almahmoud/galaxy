import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settingsFixture } from "./__tests__/fakes";
import { testServices } from "./__tests__/services";
import type { CheckReport } from "./lib/checks";
import type { SetupServices } from "./lib/services";

import App from "./App.vue";

const CONFIGURED = settingsFixture({
    cluster: { gateway_url: "http://127.0.0.1:8001", has_token: true },
    storage: {
        endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        bucket: "planet-data",
        access_key_id: "AKIDEXAMPLE",
        has_secret: true,
    },
});

const HEALTHY: CheckReport = {
    cluster: {
        state: "ok",
        checks: [{ id: "gateway", title: "Gateway", status: "ok", message: "Reached the gateway." }],
        version: "v1.33.1",
        missing_permissions: [],
    },
    storage: {
        state: "ok",
        checks: [{ id: "bucket", title: "Bucket", status: "ok", message: "Bucket planet-data answers." }],
        cors_suspected: false,
        cors: null,
        clock_offset_ms: null,
    },
};

async function mountApp(settings = settingsFixture(), overrides: Partial<SetupServices> = {}) {
    const context = testServices(settings, overrides);
    const wrapper = mount(App, { global: { provide: context.provide }, attachTo: document.body });
    await flushPromises();
    return { wrapper, ...context };
}

function cards(wrapper: Awaited<ReturnType<typeof mountApp>>["wrapper"]) {
    return wrapper.findAll(".pw-status");
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("App", () => {
    it("introduces Planet and asks to set up both components", async () => {
        const { wrapper, services } = await mountApp();
        expect(wrapper.find("h1").text()).toBe("Welcome to Planet");
        expect(wrapper.find(".pw-hero__lead").text()).toContain("Galaxy running in your browser");
        const [cluster, storage] = cards(wrapper);
        expect(cluster!.text()).toContain("Not configured");
        expect(cluster!.find("button").text()).toContain("Set up");
        expect(storage!.text()).toContain("Not configured");
        expect(services.runChecks).not.toHaveBeenCalled();
        for (const section of wrapper.findAll(".pw-section")) {
            expect(section.find(".pw-section__toggle").attributes("aria-expanded")).toBe("true");
        }
        expect(wrapper.find(".pw-ready").exists()).toBe(false);
    });

    it("checks configured components quickly and shows them connected", async () => {
        const { wrapper, services } = await mountApp(CONFIGURED, { runChecks: vi.fn(async () => HEALTHY) });
        expect(services.runChecks).toHaveBeenCalledWith({ targets: ["cluster", "storage"], mode: "quick" });
        const [cluster, storage] = cards(wrapper);
        expect(cluster!.text()).toContain("Connected");
        expect(cluster!.text()).toContain("Kubernetes v1.33.1, namespace planet through 127.0.0.1:8001.");
        expect(storage!.text()).toContain(
            "Bucket planet-data at 0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com.",
        );
        expect(wrapper.find(".pw-ready").text()).toContain("Planet is ready.");
        for (const section of wrapper.findAll(".pw-section")) {
            expect(section.find(".pw-section__toggle").attributes("aria-expanded")).toBe("false");
        }
    });

    it("offers a test from the page when the worker could not reach the gateway", async () => {
        const blocked: CheckReport = {
            cluster: {
                state: "error",
                checks: [
                    {
                        id: "gateway",
                        title: "Gateway",
                        status: "error",
                        code: "network_blocked",
                        message: "Planet's service worker could not reach the gateway at http://127.0.0.1:8001.",
                    },
                ],
                version: null,
                missing_permissions: [],
            },
        };
        const { wrapper, kube } = await mountApp(
            settingsFixture({ cluster: { gateway_url: "http://127.0.0.1:8001", has_token: true } }),
            { runChecks: vi.fn(async () => blocked) },
        );
        const [cluster] = cards(wrapper);
        expect(cluster!.text()).toContain("Needs attention");
        expect(cluster!.text()).toContain("could not reach the gateway");
        const action = cluster!.find("button");
        expect(action.text()).toContain("Test connection");
        expect(action.attributes("aria-controls")).toBe("pw-setup-cluster");
        await action.trigger("click");
        await flushPromises();
        expect(kube.configs[0]).toEqual({ gatewayUrl: "http://127.0.0.1:8001", namespace: "planet", token: "" });
        expect(wrapper.find("#pw-setup-cluster .pw-section__toggle").attributes("aria-expanded")).toBe("true");
    });

    it("refreshes the status after saving", async () => {
        const { wrapper, services } = await mountApp(settingsFixture(), { runChecks: vi.fn(async () => HEALTHY) });
        await wrapper.find("#pw-cluster-gateway").setValue("http://127.0.0.1:8001");
        await wrapper.find("#pw-cluster-token").setValue("secret-token");
        await wrapper.find("form[aria-label='Cluster settings']").trigger("submit");
        await flushPromises();
        expect(services.getStatus).toHaveBeenCalledTimes(2);
        expect(services.runChecks).toHaveBeenCalledWith({ targets: ["cluster"], mode: "quick" });
        expect(cards(wrapper)[0]!.text()).toContain("Connected");
    });

    it("explains when the settings cannot be loaded", async () => {
        const { wrapper } = await mountApp(settingsFixture(), {
            getSettings: vi.fn(async () => Promise.reject(new Error("Planet did not answer."))),
        });
        expect(wrapper.find(".alert-danger").text()).toContain("Planet's settings could not be loaded.");
        expect(wrapper.find(".pw-sections").exists()).toBe(false);
    });

    it("follows settings changed in other tabs", async () => {
        let notify: () => void = () => undefined;
        const { services } = await mountApp(settingsFixture(), {
            onSettingsChanged: vi.fn((listener: () => void) => {
                notify = listener;
                return () => undefined;
            }),
        });
        expect(services.getSettings).toHaveBeenCalledTimes(1);
        notify();
        await flushPromises();
        expect(services.getSettings).toHaveBeenCalledTimes(2);
    });
});
