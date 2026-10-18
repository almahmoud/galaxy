<script setup lang="ts">
import { reactive, useId } from "vue";

import { MAIN_TOOL_SHED } from "@/planet/install/source";
import type { InstallView } from "@/planet/install/views";

import { shortRevision, useToolServices } from "../lib/tools";

defineOptions({ compatConfig: { MODE: 3 } });

/** Chooses a revision of a Tool Shed repository and installs it. */
const props = defineProps<{ owner: string; name: string; canInstall: boolean; installLabel?: string }>();
const emit = defineEmits<{ installed: [view: InstallView] }>();

const services = useToolServices();

const state = reactive({
    revisions: null as string[] | null,
    revision: "",
    loading: false,
    installing: false,
    error: "",
    started: "",
});

const selectId = `pw-revision-${useId()}`;

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function chooseVersion() {
    state.loading = true;
    state.error = "";
    try {
        state.revisions = await services.revisions(props.owner, props.name);
        state.revision = state.revisions[0] ?? "";
    } catch (error) {
        state.error = message(error);
    } finally {
        state.loading = false;
    }
}

async function install() {
    if (!state.revision) {
        return;
    }
    state.installing = true;
    state.error = "";
    state.started = "";
    try {
        const view = await services.install({
            type: "toolshed",
            tool_shed_url: MAIN_TOOL_SHED,
            owner: props.owner,
            name: props.name,
            changeset_revision: state.revision,
        });
        state.started = `Installing revision ${shortRevision(view.requested_revision)}. Follow it under Installations.`;
        emit("installed", view);
    } catch (error) {
        state.error = message(error);
    } finally {
        state.installing = false;
    }
}
</script>

<template>
    <div class="pw-install">
        <button
            v-if="!state.revisions"
            type="button"
            class="btn btn-sm btn-outline-primary"
            :disabled="state.loading || !canInstall"
            @click="chooseVersion">
            {{ state.loading ? "Loading versions…" : "Choose a version" }}
        </button>
        <template v-else-if="state.revisions.length">
            <label :for="selectId" class="sr-only">Revision of {{ owner }}/{{ name }}</label>
            <select :id="selectId" v-model="state.revision" class="custom-select custom-select-sm pw-install__revision">
                <option v-for="(revision, index) in state.revisions" :key="revision" :value="revision">
                    {{ revision }}{{ index === 0 ? " (latest)" : "" }}
                </option>
            </select>
            <button
                type="button"
                class="btn btn-sm btn-primary"
                :disabled="state.installing || !canInstall || !state.revision"
                @click="install">
                {{ state.installing ? "Starting…" : (installLabel ?? "Install") }}
            </button>
        </template>
        <p v-else class="pw-install__note">This repository has no installable revision.</p>
        <p v-if="state.started" class="pw-install__started" role="status">{{ state.started }}</p>
        <p v-if="state.error" class="pw-install__error" role="alert">{{ state.error }}</p>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/tones.scss";

.pw-install {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    align-content: flex-start;
    gap: 0.5rem;

    p {
        flex: 1 1 100%;
        margin: 0;
        font-size: 0.875rem;
    }
}

.pw-install__revision {
    width: auto;
    max-width: 14rem;
    font-family: $font-family-monospace;
}

.pw-install__note {
    color: $text-light;
}

.pw-install__started {
    color: map-get(map-get($pw-tones, "success"), "text");
    font-weight: 600;
}

.pw-install__error {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: map-get(map-get($pw-tones, "danger"), "background");
    color: map-get(map-get($pw-tones, "danger"), "text");
    overflow-wrap: anywhere;
}
</style>
