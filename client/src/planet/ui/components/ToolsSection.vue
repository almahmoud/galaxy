<script setup lang="ts">
import { faInfoCircle, faToolbox } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";

import type { InstalledToolView, InstallView } from "@/planet/install/views";

import { INSTALL_PHASES, installedKey, useToolServices } from "../lib/tools";

import InstalledTools from "./InstalledTools.vue";
import ToolInstalls from "./ToolInstalls.vue";
import ToolSearch from "./ToolSearch.vue";

defineOptions({ compatConfig: { MODE: 3 } });

/** `canInstall`: the cluster and the bucket are configured, so installations can run. */
const props = defineProps<{ id: string; canInstall: boolean }>();

const services = useToolServices();

/** How often installations are read while one is unfinished and the page is visible. */
const POLL_MS = 3000;

const installs = shallowRef<InstallView[]>([]);
const installed = shallowRef<InstalledToolView[]>([]);
const loadError = ref("");
const announcement = ref("");
const installBusy = reactive<Record<string, boolean>>({});
const installErrors = reactive<Record<string, string>>({});
const toolBusy = reactive<Record<string, boolean>>({});
const toolErrors = reactive<Record<string, string>>({});

const unfinished = computed(() => installs.value.some((view) => view.phase === "queued" || view.phase === "running"));

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Announces installations that finished since the last read. */
function announce(previous: InstallView[], next: InstallView[]) {
    const before = new Map(previous.map((view) => [view.id, view.phase]));
    const done = next.filter((view) => {
        const phase = before.get(view.id);
        return (phase === "queued" || phase === "running") && phase !== view.phase;
    });
    if (done.length) {
        announcement.value = done.map((view) => `${view.label}: ${INSTALL_PHASES[view.phase].label}.`).join(" ");
    }
}

let loading: Promise<void> | null = null;

async function load() {
    loading ??= (async () => {
        try {
            const [nextInstalls, nextInstalled] = await Promise.all([
                services.listInstalls(),
                services.listInstalled(),
            ]);
            announce(installs.value, nextInstalls);
            installs.value = nextInstalls;
            installed.value = nextInstalled;
            loadError.value = "";
        } catch (error) {
            loadError.value = `Installed tools could not be read: ${message(error)}`;
        } finally {
            loading = null;
        }
    })();
    return loading;
}

function onInstalled(view: InstallView) {
    if (!installs.value.some((item) => item.id === view.id)) {
        installs.value = [view, ...installs.value];
    }
    void load();
}

async function act(id: string, action: (id: string) => Promise<void>) {
    installBusy[id] = true;
    delete installErrors[id];
    try {
        await action(id);
        await load();
    } catch (error) {
        installErrors[id] = message(error);
    } finally {
        delete installBusy[id];
    }
}

async function uninstall(tool: InstalledToolView) {
    const key = installedKey(tool);
    toolBusy[key] = true;
    delete toolErrors[key];
    try {
        await services.uninstall(tool.id, tool.version);
        announcement.value = `${tool.name} ${tool.version} was uninstalled.`;
        await load();
    } catch (error) {
        toolErrors[key] = message(error);
    } finally {
        delete toolBusy[key];
    }
}

let timer: ReturnType<typeof setInterval> | undefined;
let unsubscribe: (() => void) | undefined;

function poll() {
    if (unfinished.value && document.visibilityState === "visible") {
        void load();
    }
}

function onVisibilityChange() {
    if (document.visibilityState === "visible") {
        void load();
    }
}

onMounted(() => {
    unsubscribe = services.onChange(() => void load());
    timer = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void load();
});

onBeforeUnmount(() => {
    unsubscribe?.();
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
    <section :id="props.id" class="pw-tools" :aria-labelledby="`${props.id}-title`">
        <div class="pw-tools__head">
            <span class="pw-tools__icon" aria-hidden="true">
                <FontAwesomeIcon :icon="faToolbox" fixed-width />
            </span>
            <div class="pw-tools__heading">
                <h2 :id="`${props.id}-title`" class="pw-tools__title">Tools</h2>
                <p class="pw-tools__description">
                    Add tools from the Galaxy Tool Shed. Each installation runs as a job on your cluster, which reads
                    the repository and checks every tool; installed tools appear in the tool panel.
                </p>
            </div>
        </div>
        <div class="pw-tools__body">
            <p v-if="!props.canInstall" class="pw-note">
                <FontAwesomeIcon :icon="faInfoCircle" class="pw-note__icon" aria-hidden="true" />
                <span>Connect the Kubernetes cluster and the storage bucket above to install tools.</span>
            </p>
            <div v-if="loadError" class="pw-tools__error" role="alert">
                {{ loadError }}
                <button type="button" class="btn btn-link btn-sm p-0 pw-tools__retry" @click="load">Try again</button>
            </div>
            <ToolSearch :can-install="props.canInstall" @installed="onInstalled" />
            <ToolInstalls
                v-if="installs.length"
                class="pw-tools__part"
                :installs="installs"
                :busy="installBusy"
                :errors="installErrors"
                @cancel="act($event, services.cancelInstall)"
                @dismiss="act($event, services.dismissInstall)" />
            <InstalledTools
                class="pw-tools__part"
                :tools="installed"
                :busy="toolBusy"
                :errors="toolErrors"
                @uninstall="uninstall" />
            <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>
        </div>
    </section>
</template>

<style scoped lang="scss">
@import "../styles/form.scss";

.pw-tools {
    border: 1px solid $border-color;
    border-radius: 0.625rem;
    background: $white;
    scroll-margin-top: 1rem;
}

.pw-tools__head {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem 1rem;
    padding: 1.125rem 1.25rem;
    border-bottom: 1px solid $border-color;
}

.pw-tools__icon {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: map-get(map-get($pw-tones, "info"), "background");
    color: $brand-primary;
}

.pw-tools__heading {
    flex: 1 1 14rem;
    min-width: 0;
}

.pw-tools__title {
    margin: 0.2rem 0 0;
    font-size: 1.25rem;
    font-weight: 600;
}

.pw-tools__description {
    max-width: 44rem;
    margin: 0.25rem 0 0;
    color: $text-light;
}

.pw-tools__body {
    padding: 1.25rem;
}

.pw-tools__part {
    margin-top: 1.5rem;
    padding-top: 1.25rem;
    border-top: 1px solid $border-color;
}

.pw-tools__error {
    margin: 0 0 1rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: map-get(map-get($pw-tones, "danger"), "background");
    color: map-get(map-get($pw-tones, "danger"), "text");
    font-size: 0.875rem;
}

.pw-tools__retry {
    margin-left: 0.5rem;
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    vertical-align: baseline;
}

@media (max-width: 575.98px) {
    .pw-tools__head,
    .pw-tools__body {
        padding: 1rem;
    }
}
</style>
