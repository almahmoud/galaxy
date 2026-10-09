<script setup lang="ts">
import { faChevronRight, faExternalLinkAlt, faPlug, faSave, faSpinner } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, nextTick, ref, shallowRef, watch } from "vue";

import type { PlanetSettings } from "@/planet/db/types";
import { buildCorsPolicy } from "@/planet/s3";

import { PlanetApiError } from "../lib/api";
import type { StorageReport } from "../lib/checks";
import { STORAGE_GUIDE_URL } from "../lib/commands";
import { testStorage } from "../lib/connection";
import { needsCorsPolicy } from "../lib/display";
import {
    applyProvider,
    storageChange,
    storageDirty,
    type StorageForm,
    storageForm,
    storageValues,
    validateStorageForm,
} from "../lib/forms";
import { DEFAULT_PREFIX, GARAGE, PROVIDERS, R2_JURISDICTIONS, type StorageProvider } from "../lib/presets";
import type { FieldErrors } from "../lib/rules";
import { useServices } from "../lib/services";

import CheckReport from "./CheckReport.vue";
import CopyCommand from "./CopyCommand.vue";
import FormField from "./FormField.vue";
import SecretField from "./SecretField.vue";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{ settings: PlanetSettings }>();

const emit = defineEmits<{
    saved: [settings: PlanetSettings];
    /** A test of the saved settings finished. */
    tested: [report: StorageReport];
}>();

const services = useServices();

const form = ref<StorageForm>(storageForm(props.settings.storage));
const errors = ref<FieldErrors>({});
const report = shallowRef<StorageReport | null>(null);
const testing = ref(false);
const saving = ref(false);
const saveError = ref("");
const savedNotice = ref(false);
const showAdvanced = ref(false);
const showCors = ref(false);
const root = ref<HTMLElement | null>(null);

/** The settings the form was last loaded from or saved to. */
const baseline = shallowRef(props.settings);
const saved = computed(() => baseline.value.storage);
const dirty = computed(() => storageDirty(form.value, saved.value));
const values = computed(() => storageValues(form.value));
const origin = computed(() => services.origin ?? window.location.origin);
const cors = computed(() => {
    let endpoint: URL | undefined;
    try {
        endpoint = values.value.endpoint ? new URL(values.value.endpoint) : undefined;
    } catch {
        endpoint = undefined;
    }
    return buildCorsPolicy(origin.value, values.value.bucket || "<bucket>", endpoint);
});
const corsJson = computed(() =>
    JSON.stringify(form.value.provider === "r2" ? cors.value.r2Wrangler : cors.value.awsPutBucketCors, null, 2),
);
const corsCommand = computed(() =>
    form.value.provider === "r2" ? cors.value.r2WranglerCommand : cors.value.awsCommand,
);
const originLine = computed(() => `"${origin.value}" 1;`);

const accountHelp = computed(() =>
    values.value.endpoint
        ? `Endpoint: ${values.value.endpoint}`
        : "Shown on the R2 overview page of the Cloudflare dashboard.",
);
const awsRegionHelp = computed(() =>
    values.value.endpoint ? `Endpoint: ${values.value.endpoint}` : "The AWS region the bucket is in.",
);
const endpointHelp = computed(() =>
    form.value.provider === "garage"
        ? "The gateway's S3 port, opened by dev-cluster.sh port-forward."
        : "https://, or http:// on this computer.",
);
const regionHelp = computed(() =>
    form.value.provider === "garage"
        ? "garage, unless the server is configured otherwise."
        : "The signing region; empty means us-east-1.",
);

watch(
    () => props.settings,
    (next) => {
        if (!dirty.value) {
            form.value = storageForm(next.storage);
        }
        baseline.value = next;
    },
);

watch(report, (next) => {
    if (needsCorsPolicy(next)) {
        showCors.value = true;
    }
});

const ids = {
    provider: "pw-storage-provider",
    account: "pw-storage-account",
    jurisdiction: "pw-storage-jurisdiction",
    endpoint: "pw-storage-endpoint",
    region: "pw-storage-region",
    pathStyle: "pw-storage-path-style",
    bucket: "pw-storage-bucket",
    prefix: "pw-storage-prefix",
    accessKey: "pw-storage-access-key",
    secret: "pw-storage-secret",
    clusterEndpoint: "pw-storage-cluster-endpoint",
};

const FIELD_IDS: Record<string, string> = {
    "storage.account_id": ids.account,
    "storage.endpoint": ids.endpoint,
    "storage.region": ids.region,
    "storage.bucket": ids.bucket,
    "storage.prefix": ids.prefix,
    "storage.access_key_id": ids.accessKey,
    "storage.secret_access_key": ids.secret,
    "storage.cluster_endpoint": ids.clusterEndpoint,
};

function chooseProvider(provider: StorageProvider) {
    form.value = applyProvider(form.value, provider);
    errors.value = {};
}

async function focusFirstError() {
    const first = Object.keys(errors.value)[0];
    if (!first) {
        return;
    }
    if (first === "storage.cluster_endpoint") {
        showAdvanced.value = true;
    }
    await nextTick();
    const id = FIELD_IDS[first];
    if (id) {
        root.value?.querySelector<HTMLElement>(`#${id}`)?.focus();
    }
}

function validate(): boolean {
    errors.value = validateStorageForm(form.value);
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
        report.value = await testStorage(form.value, saved.value, services);
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
        report.value = { state: "error", checks: [failure], cors_suspected: false, cors: null, clock_offset_ms: null };
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
        const next = await services.saveSettings({ storage: storageChange(form.value) });
        baseline.value = next;
        form.value = storageForm(next.storage);
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
    root.value?.querySelector<HTMLInputElement>(`input[name="${ids.provider}"]:checked`)?.focus();
}

defineExpose({ test, focus });
</script>

<template>
    <div ref="root">
        <form novalidate aria-label="Storage settings" @submit.prevent="save">
            <fieldset class="pw-providers">
                <legend class="pw-providers__legend">Provider</legend>
                <div class="pw-providers__grid">
                    <label
                        v-for="provider in PROVIDERS"
                        :key="provider.id"
                        class="pw-provider"
                        :class="{ 'pw-provider--active': form.provider === provider.id }">
                        <input
                            type="radio"
                            class="pw-provider__input"
                            :name="ids.provider"
                            :value="provider.id"
                            :checked="form.provider === provider.id"
                            @change="chooseProvider(provider.id)" />
                        <span class="pw-provider__label">{{ provider.label }}</span>
                        <span class="pw-provider__description">{{ provider.description }}</span>
                    </label>
                </div>
            </fieldset>

            <div v-if="form.provider === 'r2'" class="pw-grid">
                <FormField
                    :id="ids.account"
                    label="Account ID"
                    :help="accountHelp"
                    :error="errors['storage.account_id']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.account"
                            v-model="form.account_id"
                            type="text"
                            class="form-control text-monospace"
                            :class="{ 'is-invalid': invalid }"
                            autocomplete="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
                <FormField :id="ids.jurisdiction" label="Jurisdiction" help="Where the bucket was created.">
                    <template v-slot="{ describedBy }">
                        <select
                            :id="ids.jurisdiction"
                            v-model="form.jurisdiction"
                            class="custom-select"
                            :aria-describedby="describedBy">
                            <option v-for="option in R2_JURISDICTIONS" :key="option.id" :value="option.id">
                                {{ option.label }}
                            </option>
                        </select>
                    </template>
                </FormField>
            </div>

            <div v-else-if="form.provider === 'aws'" class="pw-grid">
                <FormField :id="ids.region" label="Region" :help="awsRegionHelp" :error="errors['storage.region']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.region"
                            v-model="form.region"
                            type="text"
                            class="form-control"
                            :class="{ 'is-invalid': invalid }"
                            placeholder="us-east-1"
                            autocomplete="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
            </div>

            <div v-else class="pw-grid">
                <FormField :id="ids.endpoint" label="Endpoint" :help="endpointHelp" :error="errors['storage.endpoint']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.endpoint"
                            v-model="form.endpoint"
                            type="url"
                            inputmode="url"
                            class="form-control"
                            :class="{ 'is-invalid': invalid }"
                            :placeholder="form.provider === 'garage' ? GARAGE.endpoint : 'https://s3.example.org'"
                            autocomplete="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
                <FormField
                    :id="ids.region"
                    label="Region"
                    :help="regionHelp"
                    :optional="form.provider === 'custom'"
                    :error="errors['storage.region']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.region"
                            v-model="form.region"
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
                <FormField :id="ids.bucket" label="Bucket" :error="errors['storage.bucket']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.bucket"
                            v-model="form.bucket"
                            type="text"
                            class="form-control"
                            :class="{ 'is-invalid': invalid }"
                            autocomplete="off"
                            autocapitalize="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
                <FormField
                    :id="ids.prefix"
                    label="Key prefix"
                    help="Planet stores everything under this prefix."
                    :error="errors['storage.prefix']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.prefix"
                            v-model="form.prefix"
                            type="text"
                            class="form-control"
                            :class="{ 'is-invalid': invalid }"
                            :placeholder="DEFAULT_PREFIX"
                            autocomplete="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
            </div>

            <div class="pw-grid">
                <FormField :id="ids.accessKey" label="Access key ID" :error="errors['storage.access_key_id']">
                    <template v-slot="{ describedBy, invalid }">
                        <input
                            :id="ids.accessKey"
                            v-model="form.access_key_id"
                            type="text"
                            class="form-control text-monospace"
                            :class="{ 'is-invalid': invalid }"
                            autocomplete="off"
                            autocapitalize="off"
                            spellcheck="false"
                            :aria-describedby="describedBy"
                            :aria-invalid="invalid ? 'true' : undefined" />
                    </template>
                </FormField>
                <SecretField
                    :id="ids.secret"
                    v-model="form.secret_access_key"
                    v-model:clear="form.clear_secret"
                    label="Secret access key"
                    noun="secret access key"
                    help="Planet keeps it in this browser and gives job pods only links to single objects."
                    placeholder="Paste the secret access key"
                    :saved="saved.has_secret"
                    :error="errors['storage.secret_access_key']" />
            </div>

            <button
                type="button"
                class="pw-disclosure"
                :aria-expanded="showAdvanced ? 'true' : 'false'"
                aria-controls="pw-storage-advanced"
                @click="showAdvanced = !showAdvanced">
                <FontAwesomeIcon :icon="faChevronRight" class="pw-disclosure__chevron" fixed-width aria-hidden="true" />
                Advanced
            </button>
            <div v-show="showAdvanced" id="pw-storage-advanced" class="pw-panel">
                <div class="pw-grid">
                    <FormField
                        :id="ids.clusterEndpoint"
                        label="Cluster endpoint"
                        help="The address job pods use. Leave empty when they reach the endpoint above."
                        optional
                        :error="errors['storage.cluster_endpoint']">
                        <template v-slot="{ describedBy, invalid }">
                            <input
                                :id="ids.clusterEndpoint"
                                v-model="form.cluster_endpoint"
                                type="url"
                                inputmode="url"
                                class="form-control"
                                :class="{ 'is-invalid': invalid }"
                                :placeholder="values.endpoint || 'Same as the endpoint'"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-describedby="describedBy"
                                :aria-invalid="invalid ? 'true' : undefined" />
                        </template>
                    </FormField>
                    <div v-if="form.provider === 'custom'" class="pw-check-field">
                        <div class="custom-control custom-checkbox">
                            <input
                                :id="ids.pathStyle"
                                v-model="form.path_style"
                                type="checkbox"
                                class="custom-control-input"
                                :aria-describedby="`${ids.pathStyle}-help`" />
                            <label class="custom-control-label" :for="ids.pathStyle">Path-style requests</label>
                        </div>
                        <p :id="`${ids.pathStyle}-help`" class="pw-check-field__help">
                            Puts the bucket in the path (endpoint/bucket/key). Most self-hosted services need it.
                        </p>
                    </div>
                </div>
            </div>

            <button
                type="button"
                class="pw-disclosure"
                :aria-expanded="showCors ? 'true' : 'false'"
                aria-controls="pw-storage-cors"
                @click="showCors = !showCors">
                <FontAwesomeIcon :icon="faChevronRight" class="pw-disclosure__chevron" fixed-width aria-hidden="true" />
                Allow this site to use the bucket
            </button>
            <div v-show="showCors" id="pw-storage-cors" class="pw-panel">
                <template v-if="form.provider === 'garage'">
                    <p class="pw-panel__text">
                        The Planet gateway answers CORS requests for Garage. Add this line to allowed-origins.map in
                        your overlay and apply it again; the local overlay already allows http://localhost:8787 and
                        http://127.0.0.1:8787.
                    </p>
                    <CopyCommand :text="originLine" label="allowed origin line" />
                </template>
                <template v-else>
                    <p class="pw-panel__text">
                        The bucket's CORS policy must allow {{ origin }}. Save this as cors.json:
                    </p>
                    <CopyCommand :text="corsJson" label="CORS policy" multiline />
                    <p class="pw-panel__text mt-3">Then apply it:</p>
                    <CopyCommand :text="corsCommand" label="command to apply the CORS policy" />
                </template>
                <p class="pw-panel__text mt-3 mb-0">
                    <a :href="STORAGE_GUIDE_URL" target="_blank" rel="noopener noreferrer" class="pw-link">
                        Storage setup guide
                        <FontAwesomeIcon :icon="faExternalLinkAlt" aria-hidden="true" />
                        <span class="sr-only">(opens in a new tab)</span>
                    </a>
                    also sets lifecycle rules that remove old uploads and job files.
                </p>
            </div>

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
            label="Storage connection test"
            :running="testing"
            :state="report?.state ?? null"
            :checks="report?.checks ?? []" />
    </div>
</template>

<style scoped lang="scss">
@import "../styles/form.scss";

.pw-providers {
    margin: 0 0 1.25rem;
    padding: 0;
    border: 0;
}

.pw-providers__legend {
    margin-bottom: 0.5rem;
    font-size: 1rem;
    font-weight: 600;
}

.pw-providers__grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: 0.625rem;
}

.pw-provider {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin: 0;
    padding: 0.75rem 0.875rem;
    border: 1px solid $border-color;
    border-radius: 0.5rem;
    background: $white;
    cursor: pointer;

    &:hover {
        border-color: $brand-info;
    }

    &:focus-within {
        outline: 2px solid $brand-info;
        outline-offset: 2px;
    }
}

.pw-provider--active {
    border-color: $brand-primary;
    background: map-get(map-get($pw-tones, "info"), "background");
    box-shadow: inset 0 0 0 1px $brand-primary;
}

.pw-provider__input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    opacity: 0;
    pointer-events: none;
}

.pw-provider__label {
    font-weight: 600;
}

.pw-provider__description {
    color: $text-light;
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
