<script setup lang="ts">
import {
    faCamera,
    faCodeBranch,
    faDownload,
    faExchangeAlt,
    faInfoCircle,
    faKey,
    faPlay,
    faSpinner,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";

import { passphraseProblem, passphraseStrength } from "@/planet/backup/keys";

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
    type OlderSnapshots,
    rekeySummary,
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
const removeCurrent = ref("");
const removeError = ref("");
const older = ref<OlderSnapshots>("reencrypt");
const form = reactive({ current: "", passphrase: "", confirm: "" });
const errors = reactive({ current: "", passphrase: "", confirm: "" });
const restorePanel = ref<InstanceType<typeof BackupRestore> | null>(null);

const ids = {
    current: "pw-backup-current",
    passphrase: "pw-backup-passphrase",
    confirm: "pw-backup-confirm",
    strength: "pw-backup-strength",
    older: "pw-backup-older",
    removeCurrent: "pw-backup-remove-current",
};

const STRENGTH_LABELS = { weak: "Easy to guess", fair: "Fair", strong: "Strong" } as const;

const state = computed(() => backupState(status.value, Boolean(loadError.value)));
const pill = computed(() => BACKUP_STATES[state.value]);
const summary = computed(() => (status.value ? backupSummary(status.value) : ""));
const fresh = computed(() => offersRestore(status.value));
const conflict = computed(() => (status.value?.lease?.state === "conflict" ? status.value.lease : null));
const canSnapshot = computed(() => Boolean(status.value?.passphrase.set && status.value.storage_configured));
const showForm = computed(() => !status.value?.passphrase.set || changing.value);
const strength = computed(() => (form.passphrase ? passphraseStrength(form.passphrase) : null));
const rekey = computed(() => rekeySummary(status.value?.rekey ?? null));

/** Opens the section when something needs the user: setting it up, a conflict, a failure, paused jobs or a new device. */
function needsAttention(current: BackupStatus): boolean {
    return (
        !current.storage_configured ||
        !current.passphrase.set ||
        current.lease?.state === "conflict" ||
        current.last_error !== null ||
        current.parked_jobs > 0 ||
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
            if (action.action === "remove_passphrase") {
                removeError.value = "This is not the current passphrase.";
            } else {
                errors.current = "This is not the current passphrase.";
            }
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
    const changed = {
        reencrypt: "Passphrase changed. Older snapshots are re-encrypted with it after the next snapshot.",
        delete: "Passphrase changed. Older snapshots are deleted after the next snapshot.",
        keep: "Passphrase changed. Snapshots written before keep the old one.",
    };
    const saved = await act(
        {
            action: "set_passphrase",
            passphrase: form.passphrase,
            ...(replacing ? { current_passphrase: form.current, older_snapshots: older.value } : {}),
        },
        replacing ? changed[older.value] : "Passphrase saved. The first snapshot follows shortly.",
    );
    if (saved) {
        form.current = form.passphrase = form.confirm = "";
        changing.value = false;
    }
}

function cancelChange() {
    changing.value = false;
    older.value = "reencrypt";
    form.current = form.passphrase = form.confirm = "";
    errors.current = errors.passphrase = errors.confirm = "";
}

function cancelRemove() {
    confirmRemove.value = false;
    removeCurrent.value = removeError.value = "";
}

async function removePassphrase() {
    removeError.value = removeCurrent.value ? "" : "Enter the current passphrase.";
    if (removeError.value) {
        return;
    }
    const removed = await act(
        { action: "remove_passphrase", current_passphrase: removeCurrent.value },
        "Passphrase removed. This device writes no snapshots.",
    );
    if (removed) {
        cancelRemove();
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
                <p v-if="rekey" class="pw-panel__text mt-2 mb-0">{{ rekey }}</p>
                <div v-if="status.last_error" class="alert alert-danger mt-3 mb-0" role="alert">
                    <strong>The last snapshot failed</strong> ({{ formatTime(status.last_error.time) }}):
                    {{ status.last_error.message }}
                </div>
            </div>

            <section v-if="status.parked_jobs" class="pw-panel pw-conflict" aria-labelledby="pw-backup-parked-title">
                <h3 id="pw-backup-parked-title" class="pw-panel__title">Restored jobs are paused</h3>
                <p>
                    {{ status.parked_jobs }} {{ status.parked_jobs === 1 ? "job" : "jobs" }} from the snapshot had not
                    reached the cluster and {{ status.parked_jobs === 1 ? "is" : "are" }} paused. Resume them if you
                    made this snapshot yourself; they then run tools on your cluster with your data.
                </p>
                <button
                    type="button"
                    class="btn btn-outline-primary"
                    :disabled="busy !== null"
                    @click="act({ action: 'resume_restored_jobs' }, 'Restored jobs resumed.')">
                    <FontAwesomeIcon
                        :icon="busy === 'resume_restored_jobs' ? faSpinner : faPlay"
                        :spin="busy === 'resume_restored_jobs'"
                        fixed-width
                        aria-hidden="true" />
                    Resume restored jobs
                </button>
            </section>

            <p v-if="status.lease?.jobs_start" class="pw-note" role="status">
                <FontAwesomeIcon :icon="faInfoCircle" class="pw-note__icon" aria-hidden="true" />
                <span>
                    This device took the instance over. Its jobs start here at
                    {{ formatTime(status.lease.jobs_start) }}, once the other device has stopped running them.
                </span>
            </p>

            <section v-if="conflict" class="pw-panel pw-conflict" aria-labelledby="pw-backup-conflict-title">
                <h3 id="pw-backup-conflict-title" class="pw-panel__title">
                    Another device runs jobs for this instance
                </h3>
                <p>
                    Device <code>{{ conflict.device_id }}</code> holds instance {{ status.instance_id }}'s
                    lease<template v-if="conflict.renewed">, last renewed {{ formatTime(conflict.renewed) }}</template
                    >. So that the two devices do not run the same jobs or overwrite each other's snapshots, this device
                    runs no jobs and writes no snapshots.
                </p>
                <ul class="pw-conflict__choices">
                    <li>
                        <strong>Continue here</strong> if the other device is no longer used: this device runs the
                        instance's jobs and writes its snapshots; the other device stops within a few minutes, and jobs
                        start here once it has.
                    </li>
                    <li>
                        <strong>New instance</strong> if both devices stay in use: this device continues as a new
                        instance with its own jobs and snapshots<template v-if="status.local.unfinished_jobs"
                            >; its {{ status.local.unfinished_jobs }} unfinished
                            {{ status.local.unfinished_jobs === 1 ? "job is" : "jobs are" }} marked failed</template
                        >. Datasets made before stay shared with the other instance: purging them in either instance
                        keeps their data in the bucket.
                    </li>
                </ul>
                <div class="pw-conflict__actions">
                    <button
                        type="button"
                        class="btn btn-outline-primary"
                        :disabled="busy !== null"
                        @click="
                            act(
                                { action: 'take_over' },
                                'This device now runs the instance; its jobs start here in a few minutes.',
                            )
                        ">
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
                            <label :for="ids.removeCurrent" class="sr-only">Current passphrase</label>
                            <input
                                :id="ids.removeCurrent"
                                v-model="removeCurrent"
                                type="password"
                                class="form-control form-control-sm pw-inline-actions__input"
                                :class="{ 'is-invalid': removeError }"
                                placeholder="Current passphrase"
                                autocomplete="current-password"
                                :aria-invalid="removeError ? 'true' : undefined"
                                :aria-describedby="removeError ? `${ids.removeCurrent}-error` : undefined"
                                @keydown.enter.prevent="removePassphrase" />
                            <button
                                type="button"
                                class="btn btn-sm btn-danger"
                                :disabled="busy !== null"
                                @click="removePassphrase">
                                Remove passphrase
                            </button>
                            <button type="button" class="btn btn-sm btn-link" @click="cancelRemove">Cancel</button>
                            <span
                                v-if="removeError"
                                :id="`${ids.removeCurrent}-error`"
                                class="pw-inline-actions__error"
                                role="alert"
                                >{{ removeError }}</span
                            >
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
                            help="At least 12 characters that are hard to guess."
                            :error="errors.passphrase">
                            <template v-slot="{ describedBy, invalid }">
                                <input
                                    :id="ids.passphrase"
                                    v-model="form.passphrase"
                                    type="password"
                                    class="form-control"
                                    :class="{ 'is-invalid': invalid }"
                                    autocomplete="new-password"
                                    :aria-describedby="[describedBy, ids.strength].filter(Boolean).join(' ')"
                                    :aria-invalid="invalid ? 'true' : undefined" />
                                <div :id="ids.strength" class="pw-strength" aria-live="polite">
                                    <template v-if="strength">
                                        <span
                                            class="pw-strength__bar"
                                            :class="`pw-strength__bar--${strength.level}`"
                                            aria-hidden="true" />
                                        Strength: {{ STRENGTH_LABELS[strength.level] }}
                                    </template>
                                </div>
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
                    <fieldset v-if="status.passphrase.set" class="pw-older">
                        <legend class="pw-older__legend">Snapshots written with the current passphrase</legend>
                        <label class="pw-older__choice">
                            <input v-model="older" type="radio" :name="ids.older" value="reencrypt" />
                            Re-encrypt them with the new passphrase
                        </label>
                        <label class="pw-older__choice">
                            <input v-model="older" type="radio" :name="ids.older" value="delete" />
                            Delete them once a snapshot with the new passphrase is written
                        </label>
                        <label class="pw-older__choice">
                            <input v-model="older" type="radio" :name="ids.older" value="keep" />
                            Keep them; they still open with the current passphrase
                        </label>
                        <p class="pw-older__help">Downloaded copies keep the passphrase they were made with.</p>
                    </fieldset>
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

.pw-inline-actions__input {
    width: 14rem;
    max-width: 100%;
}

.pw-inline-actions__error {
    flex-basis: 100%;
    color: darken($brand-danger, 8%);
}

.pw-strength {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 1.5rem;
    margin-top: 0.375rem;
    color: $text-light;
    font-size: 0.875rem;
}

.pw-strength__bar {
    width: 4.5rem;
    height: 0.375rem;
    border-radius: 999px;
    background: $border-color;
}

.pw-strength__bar--weak {
    background: linear-gradient(90deg, map-get(map-get($pw-tones, "danger"), "accent") 33%, $border-color 33%);
}

.pw-strength__bar--fair {
    background: linear-gradient(90deg, map-get(map-get($pw-tones, "warning"), "accent") 66%, $border-color 66%);
}

.pw-strength__bar--strong {
    background: map-get(map-get($pw-tones, "success"), "accent");
}

.pw-older {
    margin: 0 0 1rem;
    padding: 0;
    border: 0;
}

.pw-older__legend {
    margin-bottom: 0.375rem;
    font-size: 1rem;
    font-weight: 600;
}

.pw-older__choice {
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
    margin: 0 0 0.25rem;
    cursor: pointer;
}

.pw-older__help {
    margin: 0.25rem 0 0;
    color: $text-light;
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
