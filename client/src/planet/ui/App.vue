<script setup lang="ts">
import { faCogs, faDatabase, faExternalLinkAlt, faServer } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";

import type { PlanetSettings } from "@/planet/db/types";

import type { CheckTarget, PlanetStatus } from "./lib/api";
import type { ClusterReport, StorageReport } from "./lib/checks";
import { CLUSTER_GUIDE_URL, REPOSITORY_URL, STORAGE_GUIDE_URL } from "./lib/commands";
import { type CardState, firstProblem } from "./lib/display";
import { RUNNER_STATES, runnerView } from "./lib/runner";
import { useServices } from "./lib/services";

import BackupSection from "./components/BackupSection.vue";
import ClusterSetup from "./components/ClusterSetup.vue";
import PlanetMark from "./components/PlanetMark.vue";
import SetupSection from "./components/SetupSection.vue";
import StatusCard from "./components/StatusCard.vue";
import StorageSetup from "./components/StorageSetup.vue";
import ToolsSection from "./components/ToolsSection.vue";

defineOptions({ compatConfig: { MODE: 3 } });

const services = useServices();

const settings = shallowRef<PlanetSettings | null>(null);
const status = shallowRef<PlanetStatus | null>(null);
const loadError = ref("");
const reports = reactive<{ cluster: ClusterReport | null; storage: StorageReport | null }>({
    cluster: null,
    storage: null,
});
const checking = reactive({ cluster: false, storage: false });
const expanded = reactive({ cluster: false, storage: false });
const clusterSetup = ref<InstanceType<typeof ClusterSetup> | null>(null);
const storageSetup = ref<InstanceType<typeof StorageSetup> | null>(null);

const framed = (() => {
    try {
        return window.self !== window.top;
    } catch {
        return true;
    }
})();

const SECTION_IDS: Record<CheckTarget, string> = { cluster: "pw-setup-cluster", storage: "pw-setup-storage" };
/** How often the status is read while the page is visible. */
const STATUS_POLL_MS = 10_000;

function cardState(target: CheckTarget): CardState {
    if (!status.value) {
        return "checking";
    }
    if (!status.value.configured[target]) {
        return "not_configured";
    }
    if (checking[target]) {
        return "checking";
    }
    return reports[target]?.state ?? "unknown";
}

const clusterState = computed(() => cardState("cluster"));
const storageState = computed(() => cardState("storage"));
const ready = computed(
    () => ["ok", "warning"].includes(clusterState.value) && ["ok", "warning"].includes(storageState.value),
);

function hostOf(url: string | undefined): string {
    try {
        return url ? new URL(url).host : "";
    } catch {
        return url ?? "";
    }
}

const clusterDetail = computed(() => {
    const cluster = settings.value?.cluster;
    const report = reports.cluster;
    switch (clusterState.value) {
        case "not_configured":
            return "Connect the Kubernetes cluster that runs your tools.";
        case "checking":
            return cluster?.gateway_url ? `Contacting ${hostOf(cluster.gateway_url)}…` : "Loading…";
        case "error":
            return firstProblem(report?.checks ?? [])?.message ?? "The last check failed.";
        case "unknown":
            return `Gateway ${hostOf(cluster?.gateway_url)}, namespace ${cluster?.namespace}.`;
        default: {
            const where = `namespace ${cluster?.namespace} through ${hostOf(cluster?.gateway_url)}`;
            return report?.version ? `Kubernetes ${report.version}, ${where}.` : `Connected to ${where}.`;
        }
    }
});

const storageDetail = computed(() => {
    const storage = settings.value?.storage;
    const where = `Bucket ${storage?.bucket} at ${hostOf(storage?.endpoint)}`;
    switch (storageState.value) {
        case "not_configured":
            return "Connect the S3-compatible bucket that holds your data.";
        case "checking":
            return storage?.endpoint ? `Contacting ${hostOf(storage.endpoint)}…` : "Loading…";
        case "error":
            return firstProblem(reports.storage?.checks ?? [])?.message ?? "The last check failed.";
        default:
            return `${where}.`;
    }
});

const runner = computed(() => runnerView(status.value, { framed, now: Date.now() }));
const runnerAction = computed(() => runner.value.action);

function onRunnerAction() {
    const action = runnerAction.value;
    if (action?.kind === "setup") {
        void open(action.target);
    }
}

function needsPageTest(target: CheckTarget): boolean {
    const problem = firstProblem(reports[target]?.checks ?? []);
    return problem?.code === "network_blocked";
}

function actionLabel(target: CheckTarget, state: CardState): string {
    if (state === "not_configured") {
        return "Set up";
    }
    if (state === "error" && needsPageTest(target)) {
        return "Test connection";
    }
    return state === "error" || state === "warning" ? "Review" : "Edit settings";
}

async function runQuickChecks(targets: CheckTarget[]) {
    const configured = targets.filter((target) => status.value?.configured[target]);
    if (!configured.length) {
        return;
    }
    configured.forEach((target) => (checking[target] = true));
    try {
        const report = await services.runChecks({ targets: configured, mode: "quick" });
        if (report.cluster) {
            reports.cluster = report.cluster;
        }
        if (report.storage) {
            reports.storage = report.storage;
        }
    } catch {
        configured.forEach((target) => (reports[target] = null));
    } finally {
        configured.forEach((target) => (checking[target] = false));
    }
}

async function load() {
    try {
        const [nextSettings, nextStatus] = await Promise.all([services.getSettings(), services.getStatus()]);
        settings.value = nextSettings;
        status.value = nextStatus;
    } catch (error) {
        loadError.value = error instanceof Error ? error.message : String(error);
        return;
    }
    expanded.cluster = !status.value.configured.cluster;
    expanded.storage = !status.value.configured.storage;
    await runQuickChecks(["cluster", "storage"]);
}

async function refresh() {
    try {
        const [nextSettings, nextStatus] = await Promise.all([services.getSettings(), services.getStatus()]);
        settings.value = nextSettings;
        status.value = nextStatus;
    } catch {
        // The settings on screen stay valid until the next change.
    }
}

async function open(target: CheckTarget) {
    expanded[target] = true;
    await nextTick();
    document.getElementById(SECTION_IDS[target])?.scrollIntoView({ block: "start" });
    const setup = target === "cluster" ? clusterSetup.value : storageSetup.value;
    if (cardState(target) === "error" && needsPageTest(target)) {
        await setup?.test();
    } else {
        setup?.focus();
    }
}

async function onSaved(target: CheckTarget, next: PlanetSettings) {
    settings.value = next;
    reports[target] = null;
    await refresh();
    await runQuickChecks([target]);
}

function onTested(target: CheckTarget, report: ClusterReport | StorageReport) {
    if (target === "cluster") {
        reports.cluster = report as ClusterReport;
    } else {
        reports.storage = report as StorageReport;
    }
}

let polling = false;

/** Reads the status again; the job runner card has no other source of updates. */
async function pollStatus() {
    if (polling || !status.value || document.visibilityState !== "visible") {
        return;
    }
    polling = true;
    try {
        status.value = await services.getStatus();
    } catch {
        // The last status stays on screen until the next poll.
    } finally {
        polling = false;
    }
}

function onVisibilityChange() {
    if (document.visibilityState === "visible") {
        void pollStatus();
    }
}

let unsubscribe: (() => void) | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
    unsubscribe = services.onSettingsChanged(() => void refresh());
    pollTimer = setInterval(() => void pollStatus(), STATUS_POLL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void load();
});

onBeforeUnmount(() => {
    unsubscribe?.();
    clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
    <div class="planet-welcome">
        <header class="pw-hero">
            <PlanetMark />
            <div class="pw-hero__text">
                <h1 class="pw-hero__title">Welcome to Planet</h1>
                <p class="pw-hero__lead">
                    Planet is Galaxy running in your browser. Your data stays in your own storage bucket, and tools run
                    as jobs on your own Kubernetes cluster. Connect both below to start an analysis.
                </p>
            </div>
            <a
                v-if="framed"
                class="btn btn-sm btn-outline-primary pw-hero__link"
                href="/static/welcome.html"
                target="_blank"
                rel="noopener">
                Open in a new tab
                <FontAwesomeIcon :icon="faExternalLinkAlt" aria-hidden="true" />
            </a>
            <a v-else class="btn btn-sm btn-primary pw-hero__link" href="/">Open Planet</a>
        </header>

        <div v-if="loadError" class="alert alert-danger" role="alert">
            <p class="mb-1"><strong>Planet's settings could not be loaded.</strong> {{ loadError }}</p>
            <p class="mb-0">
                Planet answers from a service worker that starts with the application.
                <a href="/">Open Planet</a>, then return to this page.
            </p>
        </div>

        <section class="pw-overview" aria-labelledby="pw-overview-title">
            <h2 id="pw-overview-title" class="sr-only">Connection status</h2>
            <div class="pw-cards">
                <StatusCard
                    title="Kubernetes cluster"
                    :icon="faServer"
                    :state="clusterState"
                    :detail="clusterDetail"
                    :action-label="actionLabel('cluster', clusterState)"
                    :controls="SECTION_IDS.cluster"
                    @action="open('cluster')" />
                <StatusCard
                    title="Storage bucket"
                    :icon="faDatabase"
                    :state="storageState"
                    :detail="storageDetail"
                    :action-label="actionLabel('storage', storageState)"
                    :controls="SECTION_IDS.storage"
                    @action="open('storage')" />
                <StatusCard
                    title="Job runner"
                    :icon="faCogs"
                    :pill="RUNNER_STATES[runner.state]"
                    :detail="runner.detail"
                    :action-label="runnerAction?.label"
                    :action-href="runnerAction?.kind === 'link' ? runnerAction.href : undefined"
                    :action-style="runner.state === 'failing' || runner.state === 'active' ? 'secondary' : 'primary'"
                    :controls="runnerAction?.kind === 'setup' ? SECTION_IDS[runnerAction.target] : undefined"
                    @action="onRunnerAction">
                    <p v-if="runner.error" class="pw-runner-error">
                        <span class="pw-runner-error__label"
                            >Last error<template v-if="runner.error.when"> ({{ runner.error.when }})</template>:</span
                        >
                        {{ runner.error.message }}
                        <a
                            v-if="runner.error.jobHref"
                            :href="runner.error.jobHref"
                            :target="framed ? '_top' : undefined"
                            class="pw-runner-error__link"
                            >View job</a
                        >
                    </p>
                </StatusCard>
            </div>
            <p v-if="ready" class="pw-ready" role="status">
                <template v-if="framed"
                    >Planet is ready. Choose a tool in the tool panel or upload data to begin.</template
                >
                <template v-else
                    >Planet is ready. <a href="/">Open Planet</a> to choose a tool or upload data.</template
                >
            </p>
        </section>

        <div v-if="settings" class="pw-sections">
            <SetupSection
                :id="SECTION_IDS.cluster"
                :step="1"
                title="Kubernetes cluster"
                description="Planet runs each tool as a Kubernetes Job, through a gateway in your cluster."
                :state="clusterState"
                :expanded="expanded.cluster"
                @toggle="expanded.cluster = !expanded.cluster">
                <ClusterSetup
                    ref="clusterSetup"
                    :settings="settings"
                    :runtime="status?.runtime ?? null"
                    @saved="onSaved('cluster', $event)"
                    @tested="onTested('cluster', $event)" />
            </SetupSection>
            <SetupSection
                :id="SECTION_IDS.storage"
                :step="2"
                title="Storage bucket"
                description="Datasets, job files and uploads live in an S3-compatible bucket you own."
                :state="storageState"
                :expanded="expanded.storage"
                @toggle="expanded.storage = !expanded.storage">
                <StorageSetup
                    ref="storageSetup"
                    :settings="settings"
                    @saved="onSaved('storage', $event)"
                    @tested="onTested('storage', $event)" />
            </SetupSection>
            <BackupSection :step="3" :storage-configured="status?.configured.storage ?? false" />
            <ToolsSection
                id="pw-tools"
                :can-install="Boolean(status?.configured.cluster && status?.configured.storage)" />
        </div>

        <footer class="pw-footer">
            <span v-if="status">Build {{ status.build_id }} · Instance {{ status.instance_id }}</span>
            <span class="pw-footer__links">
                <a :href="CLUSTER_GUIDE_URL" target="_blank" rel="noopener noreferrer">Cluster guide</a>
                <a :href="STORAGE_GUIDE_URL" target="_blank" rel="noopener noreferrer">Storage guide</a>
                <a :href="REPOSITORY_URL" target="_blank" rel="noopener noreferrer">Source</a>
            </span>
        </footer>
    </div>
</template>

<style scoped lang="scss">
@import "./styles/tones.scss";

.planet-welcome {
    max-width: 62rem;
    margin: 0 auto;
    padding: 1.5rem 1.5rem 2rem;
    color: $text-color;
}

.pw-hero {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 1rem 1.25rem;
    margin-bottom: 1.5rem;
}

.pw-hero__text {
    flex: 1 1 20rem;
    min-width: 0;
}

.pw-hero__title {
    margin: 0.125rem 0 0.375rem;
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.01em;
}

.pw-hero__lead {
    max-width: 44rem;
    margin: 0;
    color: $text-light;
    font-size: 1.0625rem;
    line-height: 1.55;
}

.pw-hero__link {
    flex: none;
    margin-left: auto;
}

.pw-overview {
    margin-bottom: 1.75rem;
}

.pw-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 1rem;
}

.pw-runner-error {
    width: 100%;
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: map-get(map-get($pw-tones, "danger"), "background");
    color: map-get(map-get($pw-tones, "danger"), "text");
    font-size: 0.875rem;
    overflow-wrap: anywhere;
}

.pw-runner-error__label {
    font-weight: 600;
}

.pw-runner-error__link {
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    white-space: nowrap;
}

.pw-ready {
    margin: 1rem 0 0;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    background: map-get(map-get($pw-tones, "success"), "background");
    color: map-get(map-get($pw-tones, "success"), "text");
    font-weight: 600;
}

.pw-sections {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
}

.pw-footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.5rem 1.5rem;
    margin-top: 2rem;
    padding-top: 1rem;
    border-top: 1px solid $border-color;
    color: $text-light;
    font-size: 0.8125rem;
}

.pw-footer__links {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
}

@media (max-width: 575.98px) {
    .planet-welcome {
        padding: 1rem 0.5rem 1.5rem;
    }

    .pw-hero__title {
        font-size: 1.5rem;
    }

    .pw-hero__link {
        margin-left: 0;
    }
}
</style>
