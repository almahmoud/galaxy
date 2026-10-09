import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { PASSING_SETUP, R2_ACCOUNT, settingsFixture, setupCheck, setupReport } from "../__tests__/fakes";
import { testServices } from "../__tests__/services";
import { GARAGE } from "../lib/presets";

import StorageSetup from "./StorageSetup.vue";

function mountSetup(settings = settingsFixture()) {
    const context = testServices(settings);
    const wrapper = mount(StorageSetup, {
        props: { settings },
        global: { provide: context.provide },
        attachTo: document.body,
    });
    return { wrapper, ...context };
}

function radio(wrapper: ReturnType<typeof mountSetup>["wrapper"], provider: string) {
    return wrapper.find(`input[type='radio'][value='${provider}']`);
}

afterEach(() => {
    document.body.innerHTML = "";
});

describe("StorageSetup", () => {
    it("offers the providers as a labelled radio group, R2 first", () => {
        const { wrapper } = mountSetup();
        expect(wrapper.find("fieldset legend").text()).toBe("Provider");
        const labels = wrapper.findAll(".pw-provider__label").map((label) => label.text());
        expect(labels).toEqual(["Cloudflare R2", "Amazon S3", "Local Garage", "Other"]);
        expect((radio(wrapper, "r2").element as HTMLInputElement).checked).toBe(true);
        expect(wrapper.find("#pw-storage-account").exists()).toBe(true);
    });

    it("derives the R2 endpoint from the account ID and saves it", async () => {
        const { wrapper, services } = mountSetup();
        await wrapper.find("#pw-storage-account").setValue(R2_ACCOUNT);
        expect(wrapper.find("#pw-storage-account-help").text()).toBe(
            `Endpoint: https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
        );
        await wrapper.find("#pw-storage-bucket").setValue("planet-data");
        await wrapper.find("#pw-storage-access-key").setValue("AKIDEXAMPLE");
        await wrapper.find("#pw-storage-secret").setValue("secret-key");
        await wrapper.find("form").trigger("submit");
        await flushPromises();
        expect(services.saveSettings).toHaveBeenCalledWith({
            storage: {
                endpoint: `https://${R2_ACCOUNT}.r2.cloudflarestorage.com`,
                cluster_endpoint: "",
                region: "auto",
                path_style: true,
                bucket: "planet-data",
                prefix: "planet",
                access_key_id: "AKIDEXAMPLE",
                secret_access_key: "secret-key",
            },
        });
        expect(wrapper.text()).toContain("Saved.");
    });

    it("fills in the Garage settings", async () => {
        const { wrapper } = mountSetup();
        await radio(wrapper, "garage").setValue(true);
        expect((wrapper.find("#pw-storage-endpoint").element as HTMLInputElement).value).toBe(GARAGE.endpoint);
        expect((wrapper.find("#pw-storage-bucket").element as HTMLInputElement).value).toBe("planet");
        expect((wrapper.find("#pw-storage-cluster-endpoint").element as HTMLInputElement).value).toBe(
            GARAGE.clusterEndpoint,
        );
        expect(wrapper.find("#pw-storage-cors").text()).toContain('"https://planet.example.org" 1;');
    });

    it("validates before testing", async () => {
        const { wrapper, s3 } = mountSetup();
        await wrapper.find("#pw-storage-account").setValue("not-an-account");
        await wrapper
            .findAll("button")
            .find((button) => button.text().includes("Test connection"))!
            .trigger("click");
        await flushPromises();
        expect(wrapper.find("#pw-storage-account-error").text()).toMatch(/32 characters/);
        expect(s3.factory).not.toHaveBeenCalled();
    });

    it("shows the CORS policy to apply when the test points at CORS", async () => {
        const { wrapper, s3 } = mountSetup();
        s3.checkSetup.mockResolvedValueOnce(
            setupReport([setupCheck("config"), setupCheck("write"), setupCheck("etag", "error", "cors_expose_etag")]),
        );
        await wrapper.find("#pw-storage-account").setValue(R2_ACCOUNT);
        await wrapper.find("#pw-storage-bucket").setValue("planet-data");
        await wrapper.find("#pw-storage-access-key").setValue("AKIDEXAMPLE");
        await wrapper.find("#pw-storage-secret").setValue("secret-key");
        const panel = wrapper.find("#pw-storage-cors");
        expect((panel.element as HTMLElement).style.display).toBe("none");
        await wrapper
            .findAll("button")
            .find((button) => button.text().includes("Test connection"))!
            .trigger("click");
        await flushPromises();
        expect(wrapper.find(".pw-report__summary").text()).toBe("The connection does not work yet.");
        expect((panel.element as HTMLElement).style.display).toBe("");
        const policy = JSON.parse(panel.find("pre").text());
        expect(policy.rules[0].allowed.origins).toEqual(["https://planet.example.org"]);
        expect(policy.rules[0].exposeHeaders).toContain("ETag");
        expect(panel.text()).toContain("npx wrangler r2 bucket cors set planet-data --file cors.json");
    });

    it("tests with the typed secret and reports success", async () => {
        const { wrapper, s3, services } = mountSetup();
        s3.checkSetup.mockResolvedValueOnce(PASSING_SETUP);
        await wrapper.find("#pw-storage-account").setValue(R2_ACCOUNT);
        await wrapper.find("#pw-storage-bucket").setValue("planet-data");
        await wrapper.find("#pw-storage-access-key").setValue("AKIDEXAMPLE");
        await wrapper.find("#pw-storage-secret").setValue("secret-key");
        await wrapper
            .findAll("button")
            .find((button) => button.text().includes("Test connection"))!
            .trigger("click");
        await flushPromises();
        expect(s3.configs[0]).toMatchObject({ secretAccessKey: "secret-key", bucket: "planet-data" });
        expect(services.runChecks).not.toHaveBeenCalled();
        expect(wrapper.find(".pw-report__summary").text()).toBe("The connection works.");
        expect(wrapper.emitted("tested")).toBeUndefined();
    });
});
