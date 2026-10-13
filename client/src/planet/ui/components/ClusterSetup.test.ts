import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settingsFixture } from "../__tests__/fakes";
import { PINNED_RUNTIME, statusFor, testServices } from "../__tests__/services";
import { PlanetApiError, type RuntimeStatus } from "../lib/api";

import ClusterSetup from "./ClusterSetup.vue";

const SAVED = settingsFixture({ cluster: { gateway_url: "http://127.0.0.1:8001", has_token: true } });

function mountSetup(settings = settingsFixture(), overrides = {}, runtime: RuntimeStatus | null = null) {
    const context = testServices(settings, overrides);
    const wrapper = mount(ClusterSetup, {
        props: { settings, runtime },
        global: { provide: context.provide },
        attachTo: document.body,
    });
    return { wrapper, ...context };
}

function submitButton(wrapper: ReturnType<typeof mountSetup>["wrapper"]) {
    return wrapper.find("button[type='submit']");
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("ClusterSetup", () => {
    it("labels every field and links its help text", () => {
        const { wrapper } = mountSetup();
        for (const [id, label] of [
            ["pw-cluster-gateway", "Gateway URL"],
            ["pw-cluster-namespace", "Namespace"],
            ["pw-cluster-token", "Token"],
        ]) {
            expect(wrapper.find(`label[for='${id}']`).text()).toContain(label);
            const described = wrapper.find(`#${id}`).attributes("aria-describedby");
            expect(described).toBe(`${id}-help`);
            expect(wrapper.find(`#${id}-help`).exists()).toBe(true);
        }
    });

    it("shows the setup commands for this site", () => {
        const { wrapper } = mountSetup();
        expect(wrapper.text()).toContain('"https://planet.example.org" 1;');
        expect(wrapper.text()).toContain("kubectl apply -k planet/deploy/overlays/mylab");
    });

    it("enables Save only after a change", async () => {
        const { wrapper } = mountSetup(SAVED);
        expect(submitButton(wrapper).attributes("disabled")).toBeDefined();
        await wrapper.find("#pw-cluster-namespace").setValue("jobs");
        expect(submitButton(wrapper).attributes("disabled")).toBeUndefined();
        expect(wrapper.text()).toContain("Unsaved changes");
    });

    it("shows field errors and focuses the first invalid field", async () => {
        const { wrapper, services } = mountSetup();
        await wrapper.find("#pw-cluster-gateway").setValue("http://k8s.example.org");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        const input = wrapper.find("#pw-cluster-gateway");
        expect(input.attributes("aria-invalid")).toBe("true");
        expect(input.attributes("aria-describedby")).toContain("pw-cluster-gateway-error");
        expect(wrapper.find("#pw-cluster-gateway-error").text()).toMatch(/https:\/\//);
        expect(document.activeElement).toBe(input.element);
        expect(services.saveSettings).not.toHaveBeenCalled();
    });

    it("saves the settings with a typed token", async () => {
        const { wrapper, services } = mountSetup();
        await wrapper.find("#pw-cluster-gateway").setValue("http://127.0.0.1:8001");
        await wrapper.find("#pw-cluster-token").setValue("secret-token");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(services.saveSettings).toHaveBeenCalledWith({
            cluster: expect.objectContaining({
                gateway_url: "http://127.0.0.1:8001",
                namespace: "planet",
                token: "secret-token",
            }),
        });
        expect(wrapper.emitted("saved")).toHaveLength(1);
        expect((wrapper.find("#pw-cluster-token").element as HTMLInputElement).value).toBe("");
        expect(wrapper.text()).toContain("Saved.");
    });

    it("removes a saved token on request", async () => {
        const { wrapper, services } = mountSetup(SAVED);
        expect(wrapper.find("#pw-cluster-token-help").text()).toContain("A token is saved");
        const remove = wrapper.findAll("button").find((button) => button.text() === "Remove it");
        await remove!.trigger("click");
        expect(wrapper.find("#pw-cluster-token-help").text()).toContain("will be removed");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(vi.mocked(services.saveSettings).mock.calls[0]![0].cluster?.token).toBeNull();
    });

    it("shows errors the API reports for fields", async () => {
        const { wrapper } = mountSetup(settingsFixture(), {
            saveSettings: vi.fn(async () =>
                Promise.reject(
                    new PlanetApiError(400, "Bad namespace", 400004, { "cluster.namespace": "Namespace taken." }),
                ),
            ),
        });
        await wrapper.find("#pw-cluster-namespace").setValue("jobs");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(wrapper.find("#pw-cluster-namespace-error").text()).toBe("Namespace taken.");
    });

    it("tests a typed token from the page without reporting it as the saved state", async () => {
        const { wrapper, services, kube } = mountSetup();
        await wrapper.find("#pw-cluster-gateway").setValue("http://127.0.0.1:8001");
        await wrapper.find("#pw-cluster-token").setValue("secret-token");
        const test = wrapper.findAll("button").find((button) => button.text().includes("Test connection"));
        await test!.trigger("click");
        await flushPromises();
        expect(kube.configs.map((config) => config.token)).toEqual(["", "secret-token"]);
        expect(services.runChecks).not.toHaveBeenCalled();
        expect(wrapper.find(".pw-report__summary").text()).toBe("The connection works.");
        expect(wrapper.find("[aria-live='polite']").text()).toContain("The connection works.");
        expect(wrapper.emitted("tested")).toBeUndefined();
    });

    it("tests a saved token through the service worker", async () => {
        const { wrapper, services } = mountSetup(SAVED, {
            runChecks: vi.fn(async () => ({
                cluster: {
                    state: "error" as const,
                    checks: [
                        { id: "gateway", title: "Gateway", status: "ok" as const, message: "Reached the gateway." },
                        {
                            id: "token",
                            title: "Token",
                            status: "error" as const,
                            message: "The cluster rejected the token.",
                            fix: "Copy the planet-client token again.",
                        },
                    ],
                    version: null,
                    missing_permissions: [],
                },
            })),
        });
        await wrapper
            .findAll("button")
            .find((button) => button.text().includes("Test connection"))!
            .trigger("click");
        await flushPromises();
        expect(services.runChecks).toHaveBeenCalledTimes(1);
        expect(wrapper.find(".pw-report__summary").text()).toBe("The connection does not work yet.");
        expect(wrapper.text()).toContain("Fix: Copy the planet-client token again.");
        expect(wrapper.find("[aria-live='polite']").text()).toContain("Token: The cluster rejected the token.");
        expect(wrapper.emitted("tested")?.[0]?.[0]).toMatchObject({ state: "error" });
    });

    it("explains that a new gateway URL removes the saved token", async () => {
        const { wrapper, services } = mountSetup(SAVED);
        const help = () => wrapper.find("#pw-cluster-token-help").text();
        expect(help()).toContain("A token is saved");
        expect(wrapper.find("#pw-cluster-token").attributes("placeholder")).toBe("Saved token");
        await wrapper.find("#pw-cluster-gateway").setValue("https://gateway.example.org");
        expect(help()).toContain("The saved token will be removed when you save, because the gateway URL changed.");
        expect(wrapper.find("#pw-cluster-token").attributes("placeholder")).toBe("Paste the planet-client token");
        await wrapper
            .findAll("button")
            .find((button) => button.text().includes("Test connection"))!
            .trigger("click");
        await flushPromises();
        expect(services.runChecks).not.toHaveBeenCalled();
        await wrapper.find("#pw-cluster-token").setValue("new-token");
        expect(help()).toContain("Saving replaces the saved token.");
    });

    it("warns about the local network prompt for a gateway on this computer", async () => {
        const { wrapper } = mountSetup();
        expect(wrapper.find(".pw-note").exists()).toBe(false);
        await wrapper.find("#pw-cluster-gateway").setValue("http://127.0.0.1:8001");
        expect(wrapper.find(".pw-note").text()).toContain("local network");
    });

    it("opens the advanced settings for an invalid default", async () => {
        const { wrapper } = mountSetup(SAVED);
        const toggle = wrapper.find("button[aria-controls='pw-cluster-advanced']");
        expect(toggle.attributes("aria-expanded")).toBe("false");
        await toggle.trigger("click");
        await wrapper.find("#pw-cluster-memory").setValue("lots");
        await toggle.trigger("click");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(toggle.attributes("aria-expanded")).toBe("true");
        expect(document.activeElement).toBe(wrapper.find("#pw-cluster-memory").element);
    });

    describe("runtime image", () => {
        const TAG = "ghcr.io/almahmoud/planet-runtime:latest";
        const UNPINNED_BUILD: RuntimeStatus = {
            image: TAG,
            source: "fallback",
            default_image: TAG,
            build_image: null,
            pinned: false,
        };

        function warning(wrapper: ReturnType<typeof mountSetup>["wrapper"]) {
            return wrapper.find("#pw-cluster-image-warning");
        }

        it("is quiet when the build pins its image", () => {
            const { wrapper } = mountSetup(settingsFixture(), {}, statusFor(settingsFixture()).runtime);
            expect(warning(wrapper).exists()).toBe(false);
            expect(wrapper.find(".pw-disclosure__note").exists()).toBe(false);
            expect(wrapper.find("#pw-cluster-image").attributes("placeholder")).toBe(PINNED_RUNTIME);
        });

        it("warns about a tag entered in the field until it is pinned", async () => {
            const { wrapper } = mountSetup(settingsFixture(), {}, statusFor(settingsFixture()).runtime);
            const input = wrapper.find("#pw-cluster-image");
            await input.setValue("ghcr.io/example/planet-runtime:main");
            expect(warning(wrapper).text()).toContain("tag without a digest");
            expect(input.attributes("aria-describedby")).toContain("pw-cluster-image-warning");
            await input.setValue(`ghcr.io/example/planet-runtime@sha256:${"cd".repeat(32)}`);
            expect(warning(wrapper).exists()).toBe(false);
            await input.setValue("Not An Image");
            expect(warning(wrapper).exists()).toBe(false);
        });

        it("warns when the build's default image is a tag, also while the section is closed", async () => {
            const { wrapper } = mountSetup(settingsFixture(), {}, UNPINNED_BUILD);
            const toggle = wrapper.find("button[aria-controls='pw-cluster-advanced']");
            expect(toggle.attributes("aria-expanded")).toBe("false");
            expect(toggle.find(".pw-disclosure__note").text()).toBe("runtime image not pinned");
            expect(warning(wrapper).text()).toContain(`so jobs use the tag ${TAG}`);
            await toggle.trigger("click");
            expect(toggle.find(".pw-disclosure__note").exists()).toBe(false);
        });
    });
});
