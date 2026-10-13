<script setup lang="ts">
import {
    faChevronRight,
    faExclamationTriangle,
    faExternalLinkAlt,
    faInfoCircle,
    faPlug,
    faSave,
    faSpinner,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, nextTick, ref, shallowRef, watch } from "vue";

import type { PlanetSettings } from "@/planet/db/types";

import { PlanetApiError, type RuntimeStatus } from "../lib/api";
import type { ClusterReport } from "../lib/checks";
import { CLUSTER_GUIDE_URL, clusterCommands, DEFAULT_GATEWAY_URL, localClusterCommands } from "../lib/commands";
import { testCluster } from "../lib/connection";
import {
    clusterChange,
    clusterDirty,
    type ClusterForm,
    clusterForm,
    clusterTokenRebound,
    validateClusterForm,
} from "../lib/forms";
import { addressSpace } from "../lib/network";
import { type FieldErrors, imageError, MAX_WALLTIME_SECONDS } from "../lib/rules";
import { runtimeImageWarning } from "../lib/runtime";
import { useServices } from "../lib/services";

import CheckReport from "./CheckReport.vue";
import CommandSteps from "./CommandSteps.vue";
import FormField from "./FormField.vue";
import SecretField from "./SecretField.vue";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{
    settings: PlanetSettings;
    /** The runtime image jobs use, from the status; null until it is known. */
    runtime?: RuntimeStatus | null;
}>();

const emit = defineEmits<{
    saved: [settings: PlanetSettings];
    /** A test of the saved settings finished. */
    tested: [report: ClusterReport];
}>();

const services = useServices();

const form = ref<ClusterForm>(clusterForm(props.settings.cluster));
const errors = ref<FieldErrors>({});
const report = shallowRef<ClusterReport | null>(null);
const testing = ref(false);
const saving = ref(false);
const saveError = ref("");
const savedNotice = ref(false);
const showGuide = ref(!props.settings.cluster.gateway_url);
const guide = ref<"existing" | "kind">("existing");
const showAdvanced = ref(false);
const root = ref<HTMLElement | null>(null);

/** The settings the form was last loaded from or saved to. */
const baseline = shallowRef(props.settings);
const saved = computed(() => baseline.value.cluster);
const dirty = computed(() => clusterDirty(form.value, saved.value));
const tokenRebound = computed(() => clusterTokenRebound(form.value, saved.value));
const commands = computed(() =>
    guide.value === "kind"
        ? localClusterCommands()
        : clusterCommands({ namespace: form.value.namespace.trim(), origin: services.origin }),
);
const localGateway = computed(() => {
    const url = form.value.gateway_url.trim();
    return url !== "" && addressSpace(url) !== "public";
});
/** Warns while the runtime image in the form, or the default one when it is empty, names no digest. */
const runtimeWarning = computed(() => {
    const value = form.value.runtime_image.trim();
    if (value) {
        return imageError(value) ? null : runtimeImageWarning(value, "settings");
    }
    const runtime = props.runtime;
    return runtime ? runtimeImageWarning(runtime.default_image, runtime.build_image ? "build" : "fallback") : null;
});
const walltimeHours = computed(() => {
    const seconds = Number(form.value.default_walltime_seconds);
    if (!Number.isInteger(seconds) || seconds <= 0) {
        return "";
    }
    const hours = +(seconds / 3600).toFixed(2);
    return hours === 1 ? "1 hour" : `${hours} hours`;
});

watch(
    () => props.settings,
    (next) => {
        if (!dirty.value) {
            form.value = clusterForm(next.cluster);
        }
        baseline.value = next;
    },
);

const ids = {
    gateway: "pw-cluster-gateway",
    namespace: "pw-cluster-namespace",
    token: "pw-cluster-token",
    image: "pw-cluster-image",
    account: "pw-cluster-service-account",
    cpu: "pw-cluster-cpu",
    memory: "pw-cluster-memory",
    walltime: "pw-cluster-walltime",
    scratch: "pw-cluster-scratch",
    arch: "pw-cluster-arch",
    userns: "pw-cluster-userns",
};

const FIELD_IDS: Record<string, string> = {
    "cluster.gateway_url": ids.gateway,
    "cluster.namespace": ids.namespace,
    "cluster.token": ids.token,
    "cluster.runtime_image": ids.image,
    "cluster.job_service_account": ids.account,
    "cluster.default_cpu": ids.cpu,
    "cluster.default_memory": ids.memory,
    "cluster.default_walltime_seconds": ids.walltime,
    "cluster.scratch_default": ids.scratch,
};

const ADVANCED_FIELDS = new Set([
    "cluster.runtime_image",
    "cluster.job_service_account",
    "cluster.default_cpu",
    "cluster.default_memory",
    "cluster.default_walltime_seconds",
    "cluster.scratch_default",
]);

async function focusFirstError() {
    const first = Object.keys(errors.value)[0];
    if (!first) {
        return;
    }
    if (ADVANCED_FIELDS.has(first)) {
        showAdvanced.value = true;
    }
    await nextTick();
    const id = FIELD_IDS[first];
    if (id) {
        root.value?.querySelector<HTMLElement>(`#${id}`)?.focus();
    }
}

function validate(): boolean {
    errors.value = validateClusterForm(form.value);
    if (Object.keys(errors.value).length) {
        void focusFirstError();
        return false;
    }
    return true;
}

async function test() {
    if (testing.value || !validate()) {
        return;
    }
    testing.value = true;
    report.value = null;
    const ofSaved = !dirty.value;
    try {
        report.value = await testCluster(form.value, saved.value, services);
        if (ofSaved) {
            emit("tested", report.value);
        }
    } catch (error) {
        const failure = {
            id: "test",
            title: "Test",
            status: "error" as const,
            message: error instanceof Error ? error.message : String(error),
        };
        report.value = { state: "error", checks: [failure], version: null, missing_permissions: [] };
    } finally {
        testing.value = false;
    }
}

async function save() {
    if (saving.value || !validate()) {
        return;
    }
    saving.value = true;
    saveError.value = "";
    try {
        const next = await services.saveSettings({ cluster: clusterChange(form.value) });
        baseline.value = next;
        form.value = clusterForm(next.cluster);
        savedNotice.value = true;
        emit("saved", next);
    } catch (error) {
        if (error instanceof PlanetApiError && Object.keys(error.fieldErrors).length) {
            errors.value = error.fieldErrors;
            void focusFirstError();
        } else {
            saveError.value = error instanceof Error ? error.message : String(error);
        }
    } finally {
        saving.value = false;
    }
}

function focus() {
    root.value?.querySelector<HTMLElement>(`#${ids.gateway}`)?.focus();
}

defineExpose({ test, focus });
</script>

<template>
    <div ref="root">
        <button
            type="button"
            class="pw-disclosure"
            :aria-expanded="showGuide ? 'true' : 'false'"
            aria-controls="pw-cluster-guide"
            @click="showGuide = !showGuide">
            <FontAwesomeIcon :icon="faChevronRight" class="pw-disclosure__chevron" fixed-width aria-hidden="true" />
            Prepare the cluster
        </button>
        <div v-show="showGuide" id="pw-cluster-guide" class="pw-panel">
            <p class="pw-panel__text">
                Planet needs its manifests in the cluster: a namespace for jobs, a gateway that lets this page call the
                Kubernetes API, and a token limited to running jobs.
            </p>
            <div class="btn-group btn-group-sm pw-segmented" role="group" aria-label="Kind of cluster">
                <button
                    type="button"
                    class="btn"
                    :class="guide === 'existing' ? 'btn-primary' : 'btn-outline-primary'"
                    :aria-pressed="guide === 'existing' ? 'true' : 'false'"
                    @click="guide = 'existing'">
                    Existing cluster
                </button>
                <button
                    type="button"
                    class="btn"
                    :class="guide === 'kind' ? 'btn-primary' : 'btn-outline-primary'"
                    :aria-pressed="guide === 'kind' ? 'true' : 'false'"
                    @click="guide = 'kind'">
                    Local kind cluster
                </button>
            </div>
            <CommandSteps :commands="commands" />
            <p class="pw-panel__text mt-3 mb-0">
                <a :href="CLUSTER_GUIDE_URL" target="_blank" rel="noopener noreferrer" class="pw-link">
                    Cluster setup guide
                    <FontAwesomeIcon :icon="faExternalLinkAlt" aria-hidden="true" />
                    <span class="sr-only">(opens in a new tab)</span>
                </a>
                covers HTTPS gateways for Safari and remote access.
            </p>
        </div>

        <form novalidate aria-label="Cluster settings" @submit.prevent="save">
            <div class="pw-grid">
                <FormField
                    :id="ids.gateway"
                    label="Gateway URL"
                    help="The Planet gateway: http://127.0.0.1:8001 with port-forward, or its https:// address."
                    :error="errors['cluster.gateway_url']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.gateway"
                            v-model="form.gateway_url"
                            type="url"
                            inputmode="url"
                            class="form-control"
                            :class="{ 'is-invalid': invalid }"
                            :placeholder="DEFAULT_GATEWAY_URL"
                            autocomplete="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
                <FormField
                    :id="ids.namespace"
                    label="Namespace"
                    help="Where Planet's manifests are applied, planet by default."
                    :error="errors['cluster.namespace']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.namespace"
                            v-model="form.namespace"
                            type="text"
                            class="form-control"
                            :class="{ 'is-invalid': invalid }"
                            placeholder="planet"
                            autocomplete="off"
                            autocapitalize="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
            </div>

            <SecretField
                :id="ids.token"
                v-model="form.token"
                v-model:clear="form.clear_token"
                label="Token"
                noun="token"
                help="The planet-client token. Planet keeps it in this browser and sends it only to the gateway."
                placeholder="Paste the planet-client token"
                :saved="saved.has_token"
                :rebound="tokenRebound ? 'the gateway URL changed' : ''"
                :error="errors['cluster.token']" />

            <button
                type="button"
                class="pw-disclosure"
                :aria-expanded="showAdvanced ? 'true' : 'false'"
                aria-controls="pw-cluster-advanced"
                @click="showAdvanced = !showAdvanced">
                <FontAwesomeIcon :icon="faChevronRight" class="pw-disclosure__chevron" fixed-width aria-hidden="true" />
                Job defaults and runtime
                <span v-if="runtimeWarning && !showAdvanced" class="pw-disclosure__note">
                    <FontAwesomeIcon :icon="faExclamationTriangle" fixed-width aria-hidden="true" />
                    runtime image not pinned
                </span>
            </button>
            <div v-show="showAdvanced" id="pw-cluster-advanced" class="pw-panel">
                <p class="pw-panel__text">Tools that declare their own resources use those instead.</p>
                <div class="pw-grid">
                    <FormField
                        :id="ids.cpu"
                        label="CPU"
                        help="Cores, such as 1 or 500m."
                        :error="errors['cluster.default_cpu']">
                        <template v-slot="{ describedBy, invalid }">
                            <input
                                :id="ids.cpu"
                                v-model="form.default_cpu"
                                type="text"
                                class="form-control"
                                :class="{ 'is-invalid': invalid }"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-describedby="describedBy"
                                :aria-invalid="invalid ? 'true' : undefined" />
                        </template>
                    </FormField>
                    <FormField
                        :id="ids.memory"
                        label="Memory"
                        help="Such as 4Gi or 512Mi."
                        :error="errors['cluster.default_memory']">
                        <template v-slot="{ describedBy, invalid }">
                            <input
                                :id="ids.memory"
                                v-model="form.default_memory"
                                type="text"
                                class="form-control"
                                :class="{ 'is-invalid': invalid }"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-describedby="describedBy"
                                :aria-invalid="invalid ? 'true' : undefined" />
                        </template>
                    </FormField>
                    <FormField
                        :id="ids.scratch"
                        label="Scratch space"
                        help="Working directory size, such as 20Gi."
                        :error="errors['cluster.scratch_default']">
                        <template v-slot="{ describedBy, invalid }">
                            <input
                                :id="ids.scratch"
                                v-model="form.scratch_default"
                                type="text"
                                class="form-control"
                                :class="{ 'is-invalid': invalid }"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-describedby="describedBy"
                                :aria-invalid="invalid ? 'true' : undefined" />
                        </template>
                    </FormField>
                    <FormField
                        :id="ids.walltime"
                        label="Walltime (seconds)"
                        :help="`Longest run of a job${walltimeHours ? `: ${walltimeHours}` : ''}. At most ${MAX_WALLTIME_SECONDS}.`"
                        :error="errors['cluster.default_walltime_seconds']">
                        <template v-slot="{ describedBy, invalid }">
                            <input
                                :id="ids.walltime"
                                v-model="form.default_walltime_seconds"
                                type="text"
                                inputmode="numeric"
                                class="form-control"
                                :class="{ 'is-invalid': invalid }"
                                autocomplete="off"
                                :aria-describedby="describedBy"
                                :aria-invalid="invalid ? 'true' : undefined" />
                        </template>
                    </FormField>
                </div>
                <div class="pw-grid">
                    <FormField
                        :id="ids.image"
                        label="Runtime image"
                        help="Runs Galaxy's job preparation and collection steps. Leave empty for the image this Planet build was tested with."
                        optional
                        :error="errors['cluster.runtime_image']"
                        :warning="runtimeWarning">
                        <template v-slot="{ describedBy, invalid }">
                            <input
                                :id="ids.image"
                                v-model="form.runtime_image"
                                type="text"
                                class="form-control"
                                :class="{ 'is-invalid': invalid }"
                                :placeholder="runtime?.default_image"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-describedby="describedBy"
                                :aria-invalid="invalid ? 'true' : undefined" />
                        </template>
                    </FormField>
                    <FormField
                        :id="ids.account"
                        label="Job service account"
                        help="Job pods run as this account, planet-job by default."
                        :error="errors['cluster.job_service_account']">
                        <template v-slot="{ describedBy, invalid }">
                            <input
                                :id="ids.account"
                                v-model="form.job_service_account"
                                type="text"
                                class="form-control"
                                :class="{ 'is-invalid': invalid }"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-describedby="describedBy"
                                :aria-invalid="invalid ? 'true' : undefined" />
                        </template>
                    </FormField>
                </div>
                <div class="pw-grid">
                    <FormField
                        :id="ids.arch"
                        label="Node architecture"
                        help="Most BioContainers images exist for amd64 only.">
                        <template v-slot="{ describedBy }">
                            <select
                                :id="ids.arch"
                                v-model="form.arch_policy"
                                class="custom-select"
                                :aria-describedby="describedBy">
                                <option value="amd64-only">amd64 nodes only</option>
                                <option value="any">Any architecture</option>
                            </select>
                        </template>
                    </FormField>
                    <div class="pw-check-field">
                        <div class="custom-control custom-checkbox">
                            <input
                                :id="ids.userns"
                                v-model="form.user_namespaces"
                                type="checkbox"
                                class="custom-control-input"
                                :aria-describedby="`${ids.userns}-help`" />
                            <label class="custom-control-label" :for="ids.userns">Run jobs in user namespaces</label>
                        </div>
                        <p :id="`${ids.userns}-help`" class="pw-check-field__help">
                            Sets hostUsers: false on job pods. The nodes must support user namespaces.
                        </p>
                    </div>
                </div>
            </div>

            <p v-if="localGateway" class="pw-note">
                <FontAwesomeIcon :icon="faInfoCircle" class="pw-note__icon" aria-hidden="true" />
                <span>
                    The gateway is on this computer. When you test the connection, the browser may ask to let this site
                    access devices on your local network: allow it, or Planet cannot reach the gateway.
                </span>
            </p>

            <div class="pw-actions">
                <button type="button" class="btn btn-outline-primary" :disabled="testing" @click="test">
                    <FontAwesomeIcon
                        :icon="testing ? faSpinner : faPlug"
                        :spin="testing"
                        fixed-width
                        aria-hidden="true" />
                    Test connection
                </button>
                <button type="submit" class="btn btn-primary" :disabled="saving || !dirty">
                    <FontAwesomeIcon
                        :icon="saving ? faSpinner : faSave"
                        :spin="saving"
                        fixed-width
                        aria-hidden="true" />
                    Save
                </button>
                <span class="pw-actions__status" role="status">
                    <template v-if="dirty">Unsaved changes</template>
                    <template v-else-if="savedNotice">Saved.</template>
                </span>
            </div>
            <div v-if="saveError" class="alert alert-danger mt-3 mb-0" role="alert">{{ saveError }}</div>
        </form>

        <CheckReport
            label="Cluster connection test"
            :running="testing"
            :state="report?.state ?? null"
            :checks="report?.checks ?? []" />
    </div>
</template>

<style scoped lang="scss">
@import "../styles/form.scss";

.pw-disclosure__note {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-left: 0.25rem;
    padding: 0 0.5rem;
    border-radius: 999px;
    background: map-get(map-get($pw-tones, "warning"), "background");
    color: map-get(map-get($pw-tones, "warning"), "text");
    font-size: 0.8125rem;
}

.pw-check-field {
    align-self: center;
    margin-bottom: 1rem;
}

.pw-check-field__help {
    margin: 0.25rem 0 0 1.5rem;
    color: $text-light;
    font-size: 0.875rem;
}
</style>
