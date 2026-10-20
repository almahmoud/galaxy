import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    backupStatus,
    bucketInstance,
    DEVICE,
    fakeBackupServices,
    freshStatus,
    INSTANCE,
    OTHER_DEVICE,
} from "../__tests__/backup";
import { BACKUP_SERVICES, BackupApiError, type BackupStatus } from "../lib/backup";

import BackupSection from "./BackupSection.vue";

async function mountSection(
    status: BackupStatus = backupStatus(),
    extra: Partial<ReturnType<typeof fakeBackupServices>["services"]> = {},
) {
    const fake = fakeBackupServices({ status });
    Object.assign(fake.services, extra);
    const wrapper = mount(BackupSection, {
        props: { step: 3, storageConfigured: status.storage_configured },
        global: { provide: { [BACKUP_SERVICES as symbol]: fake.services } },
        attachTo: document.body,
    });
    await flushPromises();
    return { wrapper, ...fake };
}

function toggle(wrapper: Awaited<ReturnType<typeof mountSection>>["wrapper"]) {
    return wrapper.find(".pw-section__toggle");
}

afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

describe("BackupSection", () => {
    it("summarizes a backed-up device and stays collapsed", async () => {
        const { wrapper } = await mountSection();
        expect(wrapper.find(".pw-pill").text()).toBe("Backed up");
        expect(toggle(wrapper).attributes("aria-expanded")).toBe("false");
        expect(wrapper.text()).toContain("48.2 kB");
        expect(wrapper.text()).toContain("3 histories, 12 datasets, 1 collection, 4 jobs");
        expect(wrapper.text()).toContain(INSTANCE);
        expect(wrapper.text()).toContain(DEVICE);
        expect(wrapper.text()).toContain("Checked for changes every 15 minutes.");
    });

    it("opens on a new device and offers to restore from the bucket", async () => {
        const { wrapper, services } = await mountSection(freshStatus());
        expect(wrapper.find(".pw-pill").text()).toBe("Not set up");
        expect(toggle(wrapper).attributes("aria-expanded")).toBe("true");
        const prompt = wrapper.find(".pw-note");
        expect(prompt.text()).toContain("New device");
        await prompt.find("button").trigger("click");
        await flushPromises();
        expect(services.listSnapshots).toHaveBeenCalledTimes(1);
        expect(wrapper.find("input[type='radio'][value='a1b2c3d4']").element).toHaveProperty("checked", true);
    });

    it("checks the new passphrase before saving it", async () => {
        const { wrapper, services } = await mountSection(freshStatus());
        await wrapper.find("#pw-backup-passphrase").setValue("too short");
        await wrapper.find("form[aria-label='Backup passphrase']").trigger("submit");
        expect(wrapper.find("#pw-backup-passphrase-error").text()).toMatch(/at least 12/);
        await wrapper.find("#pw-backup-passphrase").setValue("correct horse battery staple");
        await wrapper.find("#pw-backup-confirm").setValue("correct horse battery stapler");
        await wrapper.find("form[aria-label='Backup passphrase']").trigger("submit");
        expect(wrapper.find("#pw-backup-confirm-error").text()).toBe("The passphrases differ.");
        expect(services.act).not.toHaveBeenCalled();

        await wrapper.find("#pw-backup-confirm").setValue("correct horse battery staple");
        await wrapper.find("form[aria-label='Backup passphrase']").trigger("submit");
        await flushPromises();
        expect(services.act).toHaveBeenCalledWith({
            action: "set_passphrase",
            passphrase: "correct horse battery staple",
        });
        expect(wrapper.find("#pw-backup-passphrase").exists()).toBe(true);
        expect((wrapper.find("#pw-backup-passphrase").element as HTMLInputElement).value).toBe("");
    });

    it("asks for the current passphrase to change it", async () => {
        const wrong = new BackupApiError(403, "The current passphrase is wrong.", "wrong_passphrase");
        const { wrapper, services } = await mountSection(backupStatus(), {
            act: vi.fn().mockRejectedValueOnce(wrong).mockResolvedValue(backupStatus()),
        });
        expect(wrapper.find("#pw-backup-current").exists()).toBe(false);
        await wrapper
            .findAll("button")
            .find((button) => button.text() === "Change passphrase")!
            .trigger("click");
        await wrapper.find("#pw-backup-passphrase").setValue("a brand new long passphrase");
        await wrapper.find("#pw-backup-confirm").setValue("a brand new long passphrase");
        await wrapper.find("form[aria-label='Backup passphrase']").trigger("submit");
        expect(wrapper.find("#pw-backup-current-error").text()).toBe("Enter the current passphrase.");
        await wrapper.find("#pw-backup-current").setValue("not the old one at all");
        await wrapper.find("form[aria-label='Backup passphrase']").trigger("submit");
        await flushPromises();
        expect(services.act).toHaveBeenCalledWith({
            action: "set_passphrase",
            passphrase: "a brand new long passphrase",
            current_passphrase: "not the old one at all",
            older_snapshots: "reencrypt",
        });
        expect(wrapper.find("#pw-backup-current-error").text()).toBe("This is not the current passphrase.");

        await wrapper.find("input[type='radio'][value='delete']").setValue(true);
        await wrapper.find("#pw-backup-current").setValue("the old passphrase it is");
        await wrapper.find("form[aria-label='Backup passphrase']").trigger("submit");
        await flushPromises();
        expect(services.act).toHaveBeenLastCalledWith(expect.objectContaining({ older_snapshots: "delete" }));
        expect(wrapper.find(".pw-backup-actions [role='status']").text()).toMatch(/deleted after the next snapshot/);
    });

    it("shows how hard the new passphrase is to guess", async () => {
        const { wrapper } = await mountSection(freshStatus());
        await wrapper.find("#pw-backup-passphrase").setValue("aaaaaaaaaaaa");
        expect(wrapper.find("#pw-backup-strength").text()).toBe("Strength: Easy to guess");
        await wrapper.find("form[aria-label='Backup passphrase']").trigger("submit");
        expect(wrapper.find("#pw-backup-passphrase-error").text()).toMatch(/easy to guess/);
        await wrapper.find("#pw-backup-passphrase").setValue("correct horse battery staple");
        expect(wrapper.find("#pw-backup-strength").text()).toBe("Strength: Strong");
    });

    it("removes the passphrase only with the current one", async () => {
        const wrong = new BackupApiError(403, "The current passphrase is wrong.", "wrong_passphrase");
        const { wrapper, services } = await mountSection(backupStatus(), { act: vi.fn().mockRejectedValueOnce(wrong) });
        await wrapper
            .findAll("button")
            .find((button) => button.text() === "Remove")!
            .trigger("click");
        const remove = () =>
            wrapper
                .findAll("button")
                .find((button) => button.text() === "Remove passphrase")!
                .trigger("click");
        await remove();
        expect(wrapper.find("#pw-backup-remove-current-error").text()).toBe("Enter the current passphrase.");
        expect(services.act).not.toHaveBeenCalled();
        await wrapper.find("#pw-backup-remove-current").setValue("a guess at the passphrase");
        await remove();
        await flushPromises();
        expect(services.act).toHaveBeenCalledWith({
            action: "remove_passphrase",
            current_passphrase: "a guess at the passphrase",
        });
        expect(wrapper.find("#pw-backup-remove-current-error").text()).toBe("This is not the current passphrase.");
    });

    it("resumes the jobs a restore paused", async () => {
        const { wrapper, services } = await mountSection(backupStatus({ parked_jobs: 2 }));
        const panel = wrapper.find("[aria-labelledby='pw-backup-parked-title']");
        expect(panel.text()).toContain("2 jobs from the snapshot had not reached the cluster and are paused");
        await panel.find("button").trigger("click");
        await flushPromises();
        expect(services.act).toHaveBeenCalledWith({ action: "resume_restored_jobs" });
    });

    it("requests a snapshot and downloads an encrypted copy", async () => {
        const { wrapper, services } = await mountSection();
        const buttons = wrapper.findAll(".pw-backup-actions button");
        await buttons[0]!.trigger("click");
        await flushPromises();
        expect(services.act).toHaveBeenCalledWith({ action: "snapshot" });
        expect(wrapper.find(".pw-backup-actions [role='status']").text()).toBe("Snapshot requested.");
        await buttons[1]!.trigger("click");
        await flushPromises();
        expect(services.save).toHaveBeenCalledWith(
            expect.any(Blob),
            `planet-${INSTANCE}-20261013T120000000Z.json.gz.enc`,
        );
    });

    it("cannot snapshot or export without a passphrase", async () => {
        const { wrapper } = await mountSection(freshStatus({ local: { has_content: true, unfinished_jobs: 0 } }));
        for (const button of wrapper.findAll(".pw-backup-actions button")) {
            expect(button.attributes("disabled")).toBeDefined();
        }
    });

    it("explains a lease conflict and offers to take over or fork", async () => {
        const conflict = backupStatus({
            lease: {
                state: "conflict",
                device_id: OTHER_DEVICE,
                renewed: "2026-10-13T11:00:00.000Z",
                checked: "x",
                jobs_start: null,
            },
            local: { has_content: true, unfinished_jobs: 2 },
        });
        const { wrapper, services } = await mountSection(conflict);
        expect(wrapper.find(".pw-pill").text()).toBe("Another device");
        expect(toggle(wrapper).attributes("aria-expanded")).toBe("true");
        const panel = wrapper.find(".pw-conflict");
        expect(panel.text()).toContain(OTHER_DEVICE);
        expect(panel.text()).toContain("2 unfinished jobs are marked failed");
        const [takeOver, fork] = panel.findAll("button");
        await takeOver!.trigger("click");
        await flushPromises();
        expect(services.act).toHaveBeenLastCalledWith({ action: "take_over" });
        await fork!.trigger("click");
        await flushPromises();
        expect(services.act).toHaveBeenLastCalledWith({ action: "fork" });
    });

    it("offers to take over when another device runs the instance, also without a passphrase", async () => {
        const conflict = freshStatus({
            lease: { state: "conflict", device_id: OTHER_DEVICE, renewed: null, checked: "x", jobs_start: null },
            local: { has_content: true, unfinished_jobs: 0 },
        });
        const { wrapper, services } = await mountSection(conflict);
        expect(wrapper.find(".pw-pill").text()).toBe("Another device");
        const panel = wrapper.find(".pw-conflict");
        expect(panel.text()).toContain("Another device runs jobs for this instance");
        expect(panel.text()).toContain("purging them in either instance keeps their data in the bucket");
        await panel.findAll("button")[0]!.trigger("click");
        await flushPromises();
        expect(services.act).toHaveBeenLastCalledWith({ action: "take_over" });
    });

    it("says when jobs start after a take-over", async () => {
        const { wrapper } = await mountSection(
            backupStatus({
                lease: {
                    state: "held",
                    device_id: DEVICE,
                    renewed: "2026-10-13T12:00:00.000Z",
                    checked: "2026-10-13T12:00:00.000Z",
                    jobs_start: "2026-10-13T12:03:30.000Z",
                },
            }),
        );
        expect(wrapper.text()).toContain("This device took the instance over. Its jobs start here at");
    });

    it("shows the last failure", async () => {
        const { wrapper } = await mountSection(
            backupStatus({ last_error: { message: "The bucket answered 403.", time: "2026-10-13T12:05:00.000Z" } }),
        );
        expect(wrapper.find(".pw-pill").text()).toBe("Failing");
        expect(wrapper.find(".alert-danger").text()).toContain("The bucket answered 403.");
    });

    it("explains when the status cannot be read", async () => {
        const { wrapper, services } = await mountSection(backupStatus(), {
            getStatus: vi
                .fn()
                .mockRejectedValueOnce(new Error("Planet did not answer."))
                .mockResolvedValue(backupStatus()),
        });
        expect(wrapper.text()).toContain("The backup status could not be read: Planet did not answer.");
        await wrapper.find(".alert-warning button").trigger("click");
        await flushPromises();
        expect(services.getStatus).toHaveBeenCalledTimes(2);
        expect(wrapper.find(".pw-pill").text()).toBe("Backed up");
    });
});

describe("BackupRestore", () => {
    async function openRestore(status = freshStatus(), extra = {}) {
        const mounted = await mountSection(status, extra);
        await mounted.wrapper.find(".pw-note button").trigger("click");
        await flushPromises();
        return mounted;
    }

    function restoreForm(wrapper: Awaited<ReturnType<typeof mountSection>>["wrapper"]) {
        return wrapper.find("form[aria-label='Restore a snapshot']");
    }

    it("restores the chosen bucket snapshot after the other device's lease is confirmed", async () => {
        const { wrapper, services } = await openRestore();
        expect(wrapper.find("#pw-restore-snapshot").findAll("option")).toHaveLength(2);
        await wrapper.find("#pw-restore-snapshot").setValue("20261012T080000000Z.json.gz.enc");
        await wrapper.find("#pw-restore-passphrase").setValue("correct horse battery staple");
        const submit = restoreForm(wrapper).find("button[type='submit']");
        expect(submit.attributes("disabled")).toBeDefined();
        expect(restoreForm(wrapper).text()).toContain(`Device ${OTHER_DEVICE} writes this instance's snapshots`);
        await wrapper.find("#pw-restore-take-over").setValue(true);
        expect(submit.attributes("disabled")).toBeUndefined();
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(services.restore).toHaveBeenCalledWith(
            { bucket: { instance_id: INSTANCE, name: "20261012T080000000Z.json.gz.enc" } },
            { passphrase: "correct horse battery staple", fork: false, replace_unsaved: false, take_over: true },
        );
        expect(wrapper.find(".alert-success").text()).toContain("Restored instance a1b2c3d4");
        expect(services.reload).toHaveBeenCalledTimes(1);
    });

    it("restores as a new instance without taking the lease", async () => {
        const { wrapper, services } = await openRestore();
        await wrapper.find("#pw-restore-passphrase").setValue("correct horse battery staple");
        await wrapper.find("input[type='radio'][value='fork']").setValue(true);
        expect(wrapper.find("#pw-restore-take-over").exists()).toBe(false);
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(services.restore).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ fork: true, take_over: false }),
        );
    });

    it("marks a wrong passphrase on the field", async () => {
        const wrong = new BackupApiError(
            403,
            "The passphrase is not the one this snapshot was written with.",
            "wrong_passphrase",
        );
        const { wrapper, services } = await openRestore(freshStatus(), {
            restore: vi.fn().mockRejectedValueOnce(wrong),
        });
        await wrapper.find("input[type='radio'][value='fork']").setValue(true);
        await wrapper.find("#pw-restore-passphrase").setValue("not it at all, sorry");
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(wrapper.find("#pw-restore-passphrase-error").text()).toBe(
            "This passphrase does not decrypt the snapshot.",
        );
        expect(services.reload).not.toHaveBeenCalled();
    });

    it("asks before replacing records that are in no snapshot", async () => {
        const unsaved = new BackupApiError(409, "This device has records that are in no snapshot.", "unsaved_changes");
        const { wrapper, services } = await openRestore(freshStatus(), {
            restore: vi.fn().mockRejectedValueOnce(unsaved),
        });
        await wrapper.find("input[type='radio'][value='fork']").setValue(true);
        await wrapper.find("#pw-restore-passphrase").setValue("correct horse battery staple");
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        const submit = restoreForm(wrapper).find("button[type='submit']");
        expect(submit.attributes("disabled")).toBeDefined();
        await wrapper.find("#pw-restore-replace").setValue(true);
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(services.restore).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ replace_unsaved: true }),
        );
        expect(services.reload).toHaveBeenCalled();
    });

    it("restores a file and asks about a lease the Service Worker found", async () => {
        const conflict = new BackupApiError(409, "Another device writes the snapshots.", "lease_conflict", {
            device_id: OTHER_DEVICE,
            renewed: "2026-10-13T11:00:00.000Z",
        });
        const { wrapper, services } = await mountSection(backupStatus(), {
            restore: vi.fn().mockRejectedValueOnce(conflict),
        });
        await toggle(wrapper).trigger("click");
        await wrapper
            .findAll("button")
            .find((button) => button.text().includes("From a file"))!
            .trigger("click");
        const input = wrapper.find("#pw-restore-file");
        const file = new File([new Uint8Array([9, 8, 7])], "planet.json.gz.enc");
        Object.defineProperty(input.element, "files", { value: [file] });
        await input.trigger("change");
        await wrapper.find("#pw-restore-passphrase").setValue("correct horse battery staple");
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(services.restore).toHaveBeenCalledWith(
            { file: new Uint8Array([9, 8, 7]) },
            expect.objectContaining({ take_over: false }),
        );
        expect(restoreForm(wrapper).text()).toContain(OTHER_DEVICE);
        await wrapper.find("#pw-restore-take-over").setValue(true);
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(services.restore).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ take_over: true }),
        );
    });

    it("shows the snapshot's cluster gateway and runtime image and keeps this device's unless chosen", async () => {
        const cluster = { gateway_url: "https://k8s.example.org", runtime_image: "ghcr.io/example/runtime:1" };
        const ask = new BackupApiError(409, "Confirm them.", "cluster_settings", null, cluster);
        const { wrapper, services } = await openRestore(freshStatus(), {
            restore: vi.fn().mockRejectedValueOnce(ask).mockRejectedValueOnce(ask).mockResolvedValue({
                instance_id: INSTANCE,
                source_instance_id: INSTANCE,
                created: "2026-10-13T12:00:00.000Z",
                forked: false,
                failed_jobs: 0,
                parked_jobs: 1,
                counts: {},
            }),
        });
        await wrapper.find("input[type='radio'][value='fork']").setValue(true);
        await wrapper.find("#pw-restore-passphrase").setValue("correct horse battery staple");
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        const fieldset = wrapper.find(".pw-cluster");
        expect(fieldset.text()).toContain("https://k8s.example.org");
        expect(fieldset.text()).toContain("ghcr.io/example/runtime:1");
        expect(fieldset.find("input[value='device']").element).toHaveProperty("checked", true);
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(services.restore).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ cluster_settings: "device" }),
        );
        await wrapper.find(".pw-cluster input[value='snapshot']").setValue(true);
        await restoreForm(wrapper).trigger("submit");
        await flushPromises();
        expect(services.restore).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ cluster_settings: cluster }),
        );
        expect(wrapper.find(".alert-success").text()).toContain("1 job waits until you resume restored jobs.");
    });

    it("offers snapshots of older schema versions", async () => {
        const { wrapper, listing } = await mountSection(freshStatus());
        listing.instances.splice(
            0,
            1,
            bucketInstance({
                latest: { snapshot: "x", time: "2026-10-13T12:00:00.000Z", size: 1, schema_version: 1, counts: {} },
            }),
        );
        await wrapper.find(".pw-note button").trigger("click");
        await flushPromises();
        expect(wrapper.find("input[type='radio'][value='a1b2c3d4']").attributes("disabled")).toBeUndefined();
    });

    it("does not offer snapshots of another schema version", async () => {
        const { wrapper, listing } = await mountSection(freshStatus());
        listing.instances.splice(
            0,
            1,
            bucketInstance({
                latest: { snapshot: "x", time: "2026-10-13T12:00:00.000Z", size: 1, schema_version: 9, counts: {} },
            }),
        );
        await wrapper.find(".pw-note button").trigger("click");
        await flushPromises();
        const radio = wrapper.find("input[type='radio'][value='a1b2c3d4']");
        expect(radio.attributes("disabled")).toBeDefined();
        expect(wrapper.text()).toContain("database schema 9");
    });
});
