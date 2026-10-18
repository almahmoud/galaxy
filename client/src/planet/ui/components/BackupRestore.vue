<script setup lang="ts">
import { faCloudDownloadAlt, faFileImport, faSearch, faSpinner, faUndo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, nextTick, ref, shallowRef, watch } from "vue";

import {
    BackupApiError,
    type BackupStatus,
    type BucketInstance,
    describeCounts,
    errorText,
    formatSize,
    formatTime,
    type RestoreResponse,
    type RestoreSource,
    type SnapshotListing,
    useBackupServices,
} from "../lib/backup";

import FormField from "./FormField.vue";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{ status: BackupStatus }>();
const emit = defineEmits<{ restored: [result: RestoreResponse] }>();

const services = useBackupServices();

const ids = {
    title: "pw-restore-title",
    instances: "pw-restore-instances",
    snapshot: "pw-restore-snapshot",
    file: "pw-restore-file",
    passphrase: "pw-restore-passphrase",
    mode: "pw-restore-mode",
};

const root = ref<HTMLElement | null>(null);
const source = ref<"bucket" | "file">("bucket");
const listing = shallowRef<SnapshotListing | null>(null);
const listingError = ref("");
const listingBusy = ref(false);
const instanceId = ref("");
const snapshotName = ref("");
const file = shallowRef<File | null>(null);
const passphrase = ref("");
const mode = ref<"continue" | "fork">("continue");
const confirmReplace = ref(false);
const confirmTakeOver = ref(false);
/** Set when the Service Worker refused because of unsaved records or another device's lease. */
const askReplace = ref(false);
const askTakeOver = ref<{ device_id: string; renewed: string } | null>(null);
const restoring = ref(false);
const error = ref("");
const passphraseError = ref("");
const result = shallowRef<RestoreResponse | null>(null);

const instance = computed<BucketInstance | null>(
    () => listing.value?.instances.find((each) => each.instance_id === instanceId.value) ?? null,
);

function compatible(each: BucketInstance): boolean {
    return each.latest === null || each.latest.schema_version === props.status.schema_version;
}

/** The lease holder of the chosen bucket instance when it is another device. */
const otherHolder = computed(() => {
    const lease = instance.value?.lease;
    if (lease && !lease.this_device) {
        return { device_id: lease.device_id, renewed: lease.renewed };
    }
    return askTakeOver.value;
});

const needsTakeOver = computed(() => mode.value === "continue" && otherHolder.value !== null);

const ready = computed(() => {
    if (!passphrase.value || restoring.value) {
        return false;
    }
    if (needsTakeOver.value && !confirmTakeOver.value) {
        return false;
    }
    if (askReplace.value && !confirmReplace.value) {
        return false;
    }
    return source.value === "bucket" ? Boolean(instance.value && snapshotName.value) : file.value !== null;
});

const continueLabel = computed(() => {
    const id = source.value === "bucket" ? instanceId.value : "";
    return id ? `Continue instance ${id} on this device` : "Continue the snapshot's instance on this device";
});

watch([source, instanceId, snapshotName, file, mode], () => {
    error.value = "";
    askTakeOver.value = null;
    confirmTakeOver.value = false;
});

watch(instanceId, () => {
    snapshotName.value = instance.value?.snapshots[0]?.name ?? "";
});

watch(passphrase, () => {
    passphraseError.value = "";
});

async function findSnapshots() {
    listingBusy.value = true;
    listingError.value = "";
    try {
        listing.value = await services.listSnapshots();
        const usable = listing.value.instances.filter((each) => compatible(each) && each.snapshots.length > 0);
        const preferred = usable.find((each) => each.current) ?? usable[0];
        instanceId.value = preferred?.instance_id ?? "";
        snapshotName.value = preferred?.snapshots[0]?.name ?? "";
    } catch (caught) {
        listingError.value = errorText(caught);
    } finally {
        listingBusy.value = false;
    }
}

function onFile(event: Event) {
    file.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

async function restore() {
    if (!ready.value) {
        return;
    }
    restoring.value = true;
    error.value = "";
    try {
        let from: RestoreSource;
        if (source.value === "bucket") {
            from = { bucket: { instance_id: instanceId.value, name: snapshotName.value } };
        } else {
            from = { file: await services.readFile(file.value!) };
        }
        const restored = await services.restore(from, {
            passphrase: passphrase.value,
            fork: mode.value === "fork",
            replace_unsaved: askReplace.value && confirmReplace.value,
            take_over: needsTakeOver.value && confirmTakeOver.value,
        });
        result.value = restored;
        passphrase.value = "";
        emit("restored", restored);
    } catch (caught) {
        const reason = caught instanceof BackupApiError ? caught.reason : null;
        if (reason === "wrong_passphrase") {
            passphraseError.value = "This passphrase does not decrypt the snapshot.";
        } else if (reason === "unsaved_changes") {
            askReplace.value = true;
            error.value = caught instanceof Error ? caught.message : "";
        } else if (reason === "lease_conflict" && caught instanceof BackupApiError && caught.lease) {
            askTakeOver.value = caught.lease;
            confirmTakeOver.value = false;
        } else {
            error.value = errorText(caught);
        }
    } finally {
        restoring.value = false;
    }
}

/** Shows the bucket's snapshots and moves focus to them; used by the new-device prompt. */
async function start() {
    source.value = "bucket";
    root.value?.scrollIntoView({ block: "start" });
    if (!listing.value) {
        await findSnapshots();
    }
    await nextTick();
    root.value?.querySelector<HTMLElement>("input, select, button")?.focus();
}

defineExpose({ start });
</script>

<template>
    <section ref="root" class="pw-panel pw-restore" :aria-labelledby="ids.title">
        <h3 :id="ids.title" class="pw-panel__title">Restore</h3>
        <p class="pw-panel__text">
            Replace this device's histories, datasets, jobs and settings with a snapshot. The bucket and cluster
            credentials entered on this device stay as they are. Planet reloads afterwards.
        </p>

        <div v-if="result" class="alert alert-success mb-0" role="status">
            Restored instance {{ result.instance_id }} from the snapshot of {{ formatTime(result.created) }}:
            {{ describeCounts(result.counts) }}.
            <template v-if="result.failed_jobs">
                {{ result.failed_jobs }} unfinished {{ result.failed_jobs === 1 ? "job was" : "jobs were" }} marked
                failed; they continue with instance {{ result.source_instance_id }}.
            </template>
            Reloading Planet…
        </div>

        <form v-else novalidate aria-label="Restore a snapshot" @submit.prevent="restore">
            <div class="btn-group btn-group-sm pw-segmented" role="group" aria-label="Snapshot source">
                <button
                    type="button"
                    class="btn"
                    :class="source === 'bucket' ? 'btn-primary' : 'btn-outline-primary'"
                    :aria-pressed="source === 'bucket' ? 'true' : 'false'"
                    @click="source = 'bucket'">
                    <FontAwesomeIcon :icon="faCloudDownloadAlt" fixed-width aria-hidden="true" />
                    From the bucket
                </button>
                <button
                    type="button"
                    class="btn"
                    :class="source === 'file' ? 'btn-primary' : 'btn-outline-primary'"
                    :aria-pressed="source === 'file' ? 'true' : 'false'"
                    @click="source = 'file'">
                    <FontAwesomeIcon :icon="faFileImport" fixed-width aria-hidden="true" />
                    From a file
                </button>
            </div>

            <template v-if="source === 'bucket'">
                <p v-if="!status.storage_configured" class="pw-panel__text">
                    Set up the storage bucket above to find its snapshots.
                </p>
                <div v-else-if="!listing" class="mb-3">
                    <button
                        type="button"
                        class="btn btn-outline-primary"
                        :disabled="listingBusy"
                        @click="findSnapshots">
                        <FontAwesomeIcon
                            :icon="listingBusy ? faSpinner : faSearch"
                            :spin="listingBusy"
                            fixed-width
                            aria-hidden="true" />
                        Find snapshots in the bucket
                    </button>
                    <p v-if="listingError" class="pw-restore__error mt-2 mb-0" role="alert">{{ listingError }}</p>
                </div>
                <template v-else>
                    <p v-if="!listing.instances.length" class="pw-panel__text" role="status">
                        The bucket holds no snapshots yet.
                    </p>
                    <fieldset v-else class="pw-instances">
                        <legend class="pw-instances__legend">Instance</legend>
                        <label
                            v-for="each in listing.instances"
                            :key="each.instance_id"
                            class="pw-instance"
                            :class="{
                                'pw-instance--active': instanceId === each.instance_id,
                                'pw-instance--disabled': !compatible(each) || !each.snapshots.length,
                            }">
                            <input
                                v-model="instanceId"
                                type="radio"
                                class="pw-instance__input"
                                :name="ids.instances"
                                :value="each.instance_id"
                                :disabled="!compatible(each) || !each.snapshots.length" />
                            <span class="pw-instance__title">
                                Instance <code>{{ each.instance_id }}</code>
                                <span v-if="each.current" class="pw-instance__tag">This device's instance</span>
                            </span>
                            <span v-if="each.latest" class="pw-instance__meta">
                                Newest snapshot {{ formatTime(each.latest.time) }}, {{ formatSize(each.latest.size) }}:
                                {{ describeCounts(each.latest.counts) }}.
                            </span>
                            <span v-else-if="each.snapshots.length" class="pw-instance__meta">
                                Newest snapshot {{ formatTime(each.snapshots[0]?.time ?? "") }}.
                            </span>
                            <span v-else class="pw-instance__meta">No snapshots.</span>
                            <span v-if="!compatible(each)" class="pw-instance__meta">
                                Written by a Planet version with database schema {{ each.latest?.schema_version }}; this
                                Planet restores schema {{ status.schema_version }}.
                            </span>
                            <span v-else-if="each.lease && !each.lease.this_device" class="pw-instance__meta">
                                Written by another device, last on {{ formatTime(each.lease.renewed) }}.
                            </span>
                        </label>
                    </fieldset>
                    <p v-if="listing.truncated" class="pw-panel__text">Only the first 50 instances are listed.</p>
                    <FormField v-if="instance" :id="ids.snapshot" label="Snapshot">
                        <template v-slot="{ describedBy }">
                            <select
                                :id="ids.snapshot"
                                v-model="snapshotName"
                                class="custom-select"
                                :aria-describedby="describedBy">
                                <option v-for="each in instance.snapshots" :key="each.name" :value="each.name">
                                    {{ formatTime(each.time) }} ({{ formatSize(each.size) }})
                                </option>
                            </select>
                        </template>
                    </FormField>
                </template>
            </template>

            <FormField
                v-else
                :id="ids.file"
                label="Snapshot file"
                help="A .json.gz.enc file downloaded from Planet. Restore only files you made yourself.">
                <template v-slot="{ describedBy }">
                    <input
                        :id="ids.file"
                        type="file"
                        class="form-control-file"
                        accept=".enc,application/octet-stream"
                        :aria-describedby="describedBy"
                        @change="onFile" />
                </template>
            </FormField>

            <FormField
                :id="ids.passphrase"
                label="Passphrase"
                help="The backup passphrase the snapshot was written with."
                :error="passphraseError">
                <template v-slot="{ describedBy, invalid }">
                    <input
                        :id="ids.passphrase"
                        v-model="passphrase"
                        type="password"
                        class="form-control pw-restore__passphrase"
                        :class="{ 'is-invalid': invalid }"
                        autocomplete="off"
                        spellcheck="false"
                        :aria-describedby="describedBy"
                        :aria-invalid="invalid ? 'true' : undefined" />
                </template>
            </FormField>

            <fieldset class="pw-modes">
                <legend class="pw-instances__legend">After restoring</legend>
                <label class="pw-mode">
                    <input v-model="mode" type="radio" :name="ids.mode" value="continue" />
                    <span>
                        <span class="pw-mode__title">{{ continueLabel }}</span>
                        <span class="pw-mode__help">
                            For a new device or a browser that lost Planet's data. Jobs that were running continue, and
                            this device writes the instance's snapshots from now on.
                        </span>
                    </span>
                </label>
                <label class="pw-mode">
                    <input v-model="mode" type="radio" :name="ids.mode" value="fork" />
                    <span>
                        <span class="pw-mode__title">Restore as a new instance</span>
                        <span class="pw-mode__help">
                            For a copy next to a device that keeps using the original instance. Jobs that had not
                            finished stay with the original and are marked failed here.
                        </span>
                    </span>
                </label>
            </fieldset>

            <div v-if="needsTakeOver && otherHolder" class="pw-confirm" role="group" aria-label="Lease">
                <p class="mb-2">
                    Device <code>{{ otherHolder.device_id }}</code> writes this instance's snapshots (last on
                    {{ formatTime(otherHolder.renewed) }}). If it is still in use, restore as a new instance instead.
                </p>
                <div class="custom-control custom-checkbox">
                    <input
                        id="pw-restore-take-over"
                        v-model="confirmTakeOver"
                        type="checkbox"
                        class="custom-control-input" />
                    <label for="pw-restore-take-over" class="custom-control-label">
                        Continue here; that device stops writing this instance's snapshots
                    </label>
                </div>
            </div>

            <div v-if="askReplace" class="pw-confirm" role="group" aria-label="Unsaved records">
                <p class="mb-2">This device has records that are in no snapshot; restoring removes them.</p>
                <div class="custom-control custom-checkbox">
                    <input
                        id="pw-restore-replace"
                        v-model="confirmReplace"
                        type="checkbox"
                        class="custom-control-input" />
                    <label for="pw-restore-replace" class="custom-control-label">Replace this device's records</label>
                </div>
            </div>

            <div class="pw-actions">
                <button type="submit" class="btn btn-primary" :disabled="!ready">
                    <FontAwesomeIcon
                        :icon="restoring ? faSpinner : faUndo"
                        :spin="restoring"
                        fixed-width
                        aria-hidden="true" />
                    Restore
                </button>
                <span class="pw-actions__status" role="status">
                    <template v-if="restoring">Decrypting and restoring…</template>
                </span>
            </div>
            <div v-if="error && !askReplace" class="alert alert-danger mt-3 mb-0" role="alert">{{ error }}</div>
        </form>
    </section>
</template>

<style scoped lang="scss">
@import "../styles/form.scss";

.pw-instances,
.pw-modes {
    margin: 0 0 1rem;
    padding: 0;
    border: 0;
}

.pw-instances__legend {
    margin-bottom: 0.5rem;
    font-size: 1rem;
    font-weight: 600;
}

.pw-instance {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.125rem 0.625rem;
    margin: 0 0 0.5rem;
    padding: 0.625rem 0.875rem;
    border: 1px solid $border-color;
    border-radius: 0.5rem;
    background: $white;
    cursor: pointer;

    &:focus-within {
        outline: 2px solid $brand-info;
        outline-offset: 2px;
    }
}

.pw-instance--active {
    border-color: $brand-primary;
    box-shadow: inset 0 0 0 1px $brand-primary;
}

.pw-instance--disabled {
    cursor: not-allowed;
    opacity: 0.7;
}

.pw-instance__input {
    grid-row: span 3;
    margin-top: 0.3rem;
}

.pw-instance__title {
    font-weight: 600;
}

.pw-instance__tag {
    margin-left: 0.375rem;
    padding: 0 0.4rem;
    border-radius: 999px;
    background: map-get(map-get($pw-tones, "info"), "background");
    color: map-get(map-get($pw-tones, "info"), "text");
    font-size: 0.75rem;
    font-weight: 600;
}

.pw-instance__meta {
    grid-column: 2;
    color: $text-light;
    font-size: 0.875rem;
}

.pw-mode {
    display: flex;
    gap: 0.625rem;
    margin: 0 0 0.5rem;
    cursor: pointer;

    input {
        flex: none;
        margin-top: 0.3rem;
    }
}

.pw-mode__title {
    display: block;
    font-weight: 600;
}

.pw-mode__help {
    display: block;
    color: $text-light;
    font-size: 0.875rem;
}

.pw-confirm {
    margin: 0 0 1rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background: map-get(map-get($pw-tones, "warning"), "background");
    color: map-get(map-get($pw-tones, "warning"), "text");
}

.pw-restore__error {
    color: darken($brand-danger, 8%);
    font-size: 0.875rem;
}

.pw-restore__passphrase {
    max-width: 28rem;
}
</style>
