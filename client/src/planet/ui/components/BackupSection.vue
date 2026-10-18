<script setup lang="ts">
import {
    faCamera,
    faCodeBranch,
    faDownload,
    faExchangeAlt,
    faInfoCircle,
    faKey,
    faSpinner,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";

import { passphraseProblem } from "@/planet/backup/keys";

import {
    BACKUP_STATES,
    type BackupAction,
    BackupApiError,
    backupState,
    type BackupStatus,
    backupSummary,
    describeCounts,
    errorText,
    formatSize,
    formatTime,
    offersRestore,
    useBackupServices,
} from "../lib/backup";

import BackupRestore from "./BackupRestore.vue";
import FormField from "./FormField.vue";
import SetupSection from "./SetupSection.vue";

defineOptions({ compatConfig: { MODE: 3 } });

const props = withDefaults(defineProps<{ step: number; storageConfigured: boolean; id?: string }>(), {
    id: "pw-setup-backup",
});

const services = useBackupServices();

/** How often the status is read while the page is visible. */
const POLL_MS = 30_000;

const status = shallowRef<BackupStatus | null>(null);
const loadError = ref("");
const expanded = ref(false);
const busy = ref<BackupAction["action"] | "export" | null>(null);
const actionError = ref("");
const notice = ref("");
const changing = ref(false);
const confirmRemove = ref(false);
const form = reactive({ current: "", passphrase: "", confirm: "" });
const errors = reactive({ current: "", passphrase: "", confirm: "" });
const restorePanel = ref<InstanceType<typeof BackupRestore> | null>(null);

const ids = {
    current: "pw-backup-current",
    passphrase: "pw-backup-passphrase",
    confirm: "pw-backup-confirm",
};

const state = computed(() => backupState(status.value, Boolean(loadError.value)));
const pill = computed(() => BACKUP_STATES[state.value]);
const summary = computed(() => (status.value ? backupSummary(status.value) : ""));
const fresh = computed(() => offersRestore(status.value));
const conflict = computed(() => (status.value?.lease?.state === "conflict" ? status.value.lease : null));
const canSnapshot = computed(() => Boolean(status.value?.passphrase.set && status.value.storage_configured));
const showForm = computed(() => !status.value?.passphrase.set || changing.value);

/** Opens the section when something needs the user: setting it up, a conflict, a failure or a new device. */
function needsAttention(current: BackupStatus): boolean {
    return (
        !current.storage_configured ||
        !current.passphrase.set ||
        current.lease?.state === "conflict" ||
        current.last_error !== null ||
        offersRestore(current)
    );
}

let loaded = false;

async function load() {
    try {
        status.value = await services.getStatus();
        loadError.value = "";
    } catch (error) {
        loadError.value = errorText(error);
        return;
    }
    if (!loaded) {
        loaded = true;
        expanded.value = needsAttention(status.value);
    }
}

async function act(action: BackupAction, done: string): Promise<boolean> {
    busy.value = action.action;
    actionError.value = "";
    notice.value = "";
    try {
        status.value = await services.act(action);
        notice.value = done;
        return true;
    } catch (error) {
        if (error instanceof BackupApiError && error.reason === "wrong_passphrase") {
            errors.current = "This is not the current passphrase.";
        } else {
            actionError.value = errorText(error);
        }
        return false;
    } finally {
        busy.value = null;
    }
}

function validate(): boolean {
    errors.current =
        changing.value && status.value?.passphrase.set && !form.current ? "Enter the current passphrase." : "";
    errors.passphrase = passphraseProblem(form.passphrase) ?? "";
    errors.confirm = !errors.passphrase && form.confirm !== form.passphrase ? "The passphrases differ." : "";
    return !errors.current && !errors.passphrase && !errors.confirm;
}

async function savePassphrase() {
    if (!validate()) {
        return;
    }
    const replacing = Boolean(status.value?.passphrase.set);
    const saved = await act(
        {
            action: "set_passphrase",
            passphrase: form.passphrase,
            ...(replacing ? { current_passphrase: form.current } : {}),
        },
        replacing
            ? "Passphrase changed. Snapshots written before keep the old one."
            : "Passphrase saved. The first snapshot follows shortly.",
    );
    if (saved) {
        form.current = form.passphrase = form.confirm = "";
        changing.value = false;
    }
}

function cancelChange() {
    changing.value = false;
    form.current = form.passphrase = form.confirm = "";
    errors.current = errors.passphrase = errors.confirm = "";
}

async function removePassphrase() {
    if (await act({ action: "remove_passphrase" }, "Passphrase removed. This device writes no snapshots.")) {
        confirmRemove.value = false;
        changing.value = false;
    }
}

async function exportFile() {
    busy.value = "export";
    actionError.value = "";
    notice.value = "";
    try {
        const { blob, filename } = await services.exportSnapshot();
        services.save(blob, filename);
        notice.value = "Encrypted copy downloaded.";
    } catch (error) {
        actionError.value = errorText(error);
    } finally {
        busy.value = null;
    }
}

async function startRestore() {
    expanded.value = true;
    await nextTick();
    await restorePanel.value?.start();
}

function onRestored() {
    services.reload();
}

watch(
    () => props.storageConfigured,
    () => void load(),
);

let timer: ReturnType<typeof setInterval> | undefined;

function poll() {
    if (document.visibilityState === "visible" && busy.value === null) {
        void load();
    }
}

onMounted(() => {
    void load();
    timer = setInterval(poll, POLL_MS);
});

onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
    <SetupSection
        :id="id"
        :step="step"
        title="Backups"
        description="Encrypted snapshots of your histories, jobs and settings in your bucket, so Planet can be restored on any device."
        :pill="pill"
        :expanded="expanded"
        @toggle="expanded = !expanded">
        <div v-if="!status" :class="loadError ? 'alert alert-warning mb-0' : 'pw-panel__text'" role="status">
            <template v-if="loadError">
                The backup status could not be read: {{ loadError }}
                <button type="button" class="btn btn-link p-0 align-baseline" @click="load">Try again</button>
            </template>
            <template v-else>Loading…</template>
        </div>

        <template v-else>
            <div v-if="fresh" class="pw-note" role="note">
                <FontAwesomeIcon :icon="faInfoCircle" class="pw-note__icon" aria-hidden="true" />
                <span>
                    New device, or did this browser clear Planet's data? Your bucket may hold snapshots to restore.
                    <button type="button" class="btn btn-link pw-inline-link" @click="startRestore">
                        Restore from the bucket
                    </button>
                </span>
            </div>

            <div class="pw-panel">
                <h3 class="pw-panel__title">Status</h3>
                <p class="pw-panel__text" role="status">{{ summary }}</p>
                <dl class="pw-facts">
                    <template v-if="status.last_snapshot">
                        <dt>Last snapshot</dt>
                        <dd>
                            {{ formatTime(status.last_snapshot.time) }}, {{ formatSize(status.last_snapshot.size) }}:
                            {{ describeCounts(status.last_snapshot.counts) }}
                        </dd>
                    </template>
                    <dt>Instance</dt>
                    <dd>
                        <code>{{ status.instance_id }}</code>
                    </dd>
                    <dt>This device</dt>
                    <dd>
                        <code>{{ status.device_id }}</code>
                    </dd>
                    <template v-if="status.restored">
                        <dt>Restored</dt>
                        <dd>
                            {{ formatTime(status.restored.time) }} from the snapshot of
                            {{ formatTime(status.restored.created) }} of instance
                            <code>{{ status.restored.instance_id }}</code>
                            <template v-if="status.restored.forked_to"> as a new instance</template>
                        </dd>
                    </template>
                </dl>
                <p class="pw-panel__text mb-0">
                    Planet keeps the newest {{ status.keep }} snapshots. Dataset contents are in the bucket already and
                    are not part of a snapshot.
                </p>
                <div v-if="status.last_error" class="alert alert-danger mt-3 mb-0" role="alert">
                    <strong>The last snapshot failed</strong> ({{ formatTime(status.last_error.time) }}):
                    {{ status.last_error.message }}
                </div>
            </div>

            <section v-if="conflict" class="pw-panel pw-conflict" aria-labelledby="pw-backup-conflict-title">
                <h3 id="pw-backup-conflict-title" class="pw-panel__title">
                    Another device writes this instance's snapshots
                </h3>
                <p>
                    Device <code>{{ conflict.device_id }}</code> holds instance {{ status.instance_id }}'s
                    lease<template v-if="conflict.renewed">, last renewed {{ formatTime(conflict.renewed) }}</template
                    >. To keep the two devices from overwriting each other's snapshots, this device writes none.
                </p>
                <ul class="pw-conflict__choices">
                    <li>
                        <strong>Continue here</strong> if the other device is no longer used: this device's records
                        become the instance's newest snapshot and the other device stops writing.
                    </li>
                    <li>
                        <strong>New instance</strong> if both devices stay in use: this device continues as a new
                        instance with its own snapshots<template v-if="status.local.unfinished_jobs"
                            >; its {{ status.local.unfinished_jobs }} unfinished
                            {{ status.local.unfinished_jobs === 1 ? "job is" : "jobs are" }} marked failed</template
                        >.
                    </li>
                </ul>
                <div class="pw-conflict__actions">
                    <button
                        type="button"
                        class="btn btn-outline-primary"
                        :disabled="busy !== null"
                        @click="act({ action: 'take_over' }, 'This device now writes the snapshots.')">
                        <FontAwesomeIcon
                            :icon="busy === 'take_over' ? faSpinner : faExchangeAlt"
                            :spin="busy === 'take_over'"
                            fixed-width
                            aria-hidden="true" />
                        Continue here
                    </button>
                    <button
                        type="button"
                        class="btn btn-outline-primary"
                        :disabled="busy !== null"
                        @click="act({ action: 'fork' }, 'This device is now a new instance.')">
                        <FontAwesomeIcon
                            :icon="busy === 'fork' ? faSpinner : faCodeBranch"
                            :spin="busy === 'fork'"
                            fixed-width
                            aria-hidden="true" />
                        Make this a new instance
                    </button>
                </div>
            </section>

            <form class="pw-panel" novalidate aria-label="Backup passphrase" @submit.prevent="savePassphrase">
                <h3 class="pw-panel__title">Passphrase</h3>
                <template v-if="status.passphrase.set && !changing">
                    <p class="pw-panel__text">
                        Set on this device {{ status.passphrase.created ? formatTime(status.passphrase.created) : "" }}.
                        You need it to restore a snapshot.
                    </p>
                    <div class="pw-inline-actions">
                        <button type="button" class="btn btn-sm btn-outline-primary" @click="changing = true">
                            <FontAwesomeIcon :icon="faKey" fixed-width aria-hidden="true" />
                            Change passphrase
                        </button>
                        <button
                            v-if="!confirmRemove"
                            type="button"
                            class="btn btn-sm btn-outline-danger"
                            @click="confirmRemove = true">
                            Remove
                        </button>
                        <span v-else class="pw-inline-actions__confirm">
                            Snapshots stop until a passphrase is set again.
                            <button
                                type="button"
                                class="btn btn-sm btn-danger"
                                :disabled="busy !== null"
                                @click="removePassphrase">
                                Remove passphrase
                            </button>
                            <button type="button" class="btn btn-sm btn-link" @click="confirmRemove = false">
                                Cancel
                            </button>
                        </span>
                    </div>
                </template>
                <template v-if="showForm">
                    <p class="pw-panel__text">
                        Snapshots are encrypted in this browser with a key derived from this passphrase. Planet does not
                        store the passphrase and cannot recover it; without it, no snapshot can be restored. Use several
                        unrelated words and keep them in a password manager.
                    </p>
                    <div class="pw-grid">
                        <FormField
                            v-if="status.passphrase.set"
                            :id="ids.current"
                            label="Current passphrase"
                            :error="errors.current">
                            <template v-slot="{ describedBy, invalid }">
                                <input
                                    :id="ids.current"
                                    v-model="form.current"
                                    type="password"
                                    class="form-control"
                                    :class="{ 'is-invalid': invalid }"
                                    autocomplete="current-password"
                                    :aria-describedby="describedBy"
                                    :aria-invalid="invalid ? 'true' : undefined" />
                            </template>
                        </FormField>
                        <FormField
                            :id="ids.passphrase"
                            :label="status.passphrase.set ? 'New passphrase' : 'Passphrase'"
                            help="At least 12 characters."
                            :error="errors.passphrase">
                            <template v-slot="{ describedBy, invalid }">
                                <input
                                    :id="ids.passphrase"
                                    v-model="form.passphrase"
                                    type="password"
                                    class="form-control"
                                    :class="{ 'is-invalid': invalid }"
                                    autocomplete="new-password"
                                    :aria-describedby="describedBy"
                                    :aria-invalid="invalid ? 'true' : undefined" />
                            </template>
                        </FormField>
                        <FormField :id="ids.confirm" label="Repeat the passphrase" :error="errors.confirm">
                            <template v-slot="{ describedBy, invalid }">
                                <input
                                    :id="ids.confirm"
                                    v-model="form.confirm"
                                    type="password"
                                    class="form-control"
                                    :class="{ 'is-invalid': invalid }"
                                    autocomplete="new-password"
                                    :aria-describedby="describedBy"
                                    :aria-invalid="invalid ? 'true' : undefined" />
                            </template>
                        </FormField>
                    </div>
                    <details class="pw-details">
                        <summary>What the key on this device protects</summary>
                        <p>
                            So that snapshots are written without asking you, this browser keeps the derived key (not
                            the passphrase) with Planet's data. Pages of this site can use the key but cannot read it
                            out. It does not protect anything from someone who can use or copy this browser profile. The
                            passphrase protects the snapshots from anyone who can read your bucket: they are encrypted
                            with AES-256-GCM, with the key derived by PBKDF2-SHA-256 with 600,000 iterations.
                        </p>
                    </details>
                    <div class="pw-inline-actions">
                        <button type="submit" class="btn btn-primary" :disabled="busy !== null">
                            <FontAwesomeIcon
                                :icon="busy === 'set_passphrase' ? faSpinner : faKey"
                                :spin="busy === 'set_passphrase'"
                                fixed-width
                                aria-hidden="true" />
                            {{ status.passphrase.set ? "Change passphrase" : "Save passphrase" }}
                        </button>
                        <button v-if="changing" type="button" class="btn btn-link" @click="cancelChange">Cancel</button>
                    </div>
                </template>
            </form>

            <div class="pw-actions pw-backup-actions">
                <button
                    type="button"
                    class="btn btn-primary"
                    :disabled="!canSnapshot || busy !== null"
                    @click="act({ action: 'snapshot' }, 'Snapshot requested.')">
                    <FontAwesomeIcon
                        :icon="busy === 'snapshot' ? faSpinner : faCamera"
                        :spin="busy === 'snapshot'"
                        fixed-width
                        aria-hidden="true" />
                    Snapshot now
                </button>
                <button
                    type="button"
                    class="btn btn-outline-primary"
                    :disabled="!status.passphrase.set || busy !== null"
                    @click="exportFile">
                    <FontAwesomeIcon
                        :icon="busy === 'export' ? faSpinner : faDownload"
                        :spin="busy === 'export'"
                        fixed-width
                        aria-hidden="true" />
                    Download encrypted copy
                </button>
                <span class="pw-actions__status" role="status">{{ notice }}</span>
            </div>
            <div v-if="actionError" class="alert alert-danger mt-3" role="alert">{{ actionError }}</div>

            <BackupRestore ref="restorePanel" class="mt-4 mb-0" :status="status" @restored="onRestored" />
        </template>
    </SetupSection>
</template>

<style scoped lang="scss">
@import "../styles/form.scss";

.pw-facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
    margin: 0 0 0.75rem;

    dt {
        font-weight: 600;
    }

    dd {
        margin: 0;
        min-width: 0;
        overflow-wrap: anywhere;
    }
}

.pw-conflict {
    border-color: map-get(map-get($pw-tones, "warning"), "accent");
    background: map-get(map-get($pw-tones, "warning"), "background");
    color: map-get(map-get($pw-tones, "warning"), "text");
}

.pw-conflict__choices {
    padding-left: 1.25rem;
}

.pw-conflict__actions,
.pw-inline-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
}

.pw-inline-actions__confirm {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
}

.pw-inline-link {
    padding: 0;
    border: 0;
    font-size: inherit;
    font-weight: 600;
    vertical-align: baseline;
}

.pw-details {
    margin: 0 0 1rem;
    font-size: 0.9375rem;

    summary {
        color: $brand-primary;
        font-weight: 600;
        cursor: pointer;
    }

    p {
        margin: 0.5rem 0 0;
        color: $text-light;
    }
}

.pw-backup-actions {
    margin-top: 0;
    padding-top: 0;
    border-top: 0;
}

@media (max-width: 575.98px) {
    .pw-facts {
        grid-template-columns: 1fr;

        dd {
            margin-bottom: 0.375rem;
        }
    }
}
</style>
