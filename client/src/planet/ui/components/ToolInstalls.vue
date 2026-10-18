<script setup lang="ts">
import { faCheckCircle, faExternalLinkAlt, faMinusCircle, faTimesCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

import type { InstallToolOutcome, InstallView } from "@/planet/install/views";

import { formatInstallTime, INSTALL_PHASES, shortRevision } from "../lib/tools";

import StatusPill from "./StatusPill.vue";

defineOptions({ compatConfig: { MODE: 3 } });

/** Tool installations and what became of each tool file; `busy` holds the ids of installations being changed. */
defineProps<{ installs: InstallView[]; busy: Record<string, boolean>; errors: Record<string, string> }>();
const emit = defineEmits<{ cancel: [id: string]; dismiss: [id: string] }>();

const OUTCOMES = {
    installed: { icon: faCheckCircle, label: "Installed", tone: "success" },
    rejected: { icon: faMinusCircle, label: "Not supported", tone: "neutral" },
    failed: { icon: faTimesCircle, label: "Failed", tone: "danger" },
} as const;

function finished(view: InstallView): boolean {
    return view.phase !== "queued" && view.phase !== "running";
}

function toolLabel(tool: InstallToolOutcome): string {
    const name = tool.name ?? tool.path;
    return tool.version ? `${name} ${tool.version}` : name;
}

function summary(view: InstallView): string {
    switch (view.phase) {
        case "queued":
            return "Waiting for the job runner to start the installation on your cluster.";
        case "running":
            return "Reading the repository and its tools on your cluster.";
        case "cancelled":
            return "The installation was cancelled.";
        default: {
            const installed = view.tools.filter((tool) => tool.state === "installed").length;
            if (!view.tools.length) {
                return "No tool was installed.";
            }
            return `${installed} of ${view.tools.length} ${view.tools.length === 1 ? "tool" : "tools"} installed.`;
        }
    }
}
</script>

<template>
    <div class="pw-installs">
        <h3 class="pw-tools-heading">Installations</h3>
        <ul class="pw-installs__list">
            <li v-for="view in installs" :key="view.id" class="pw-installs__item">
                <div class="pw-installs__head">
                    <div class="pw-installs__title">
                        <h4 class="pw-installs__name">{{ view.label }}</h4>
                        <span class="pw-installs__meta">
                            <span v-if="view.revision || view.requested_revision" class="pw-installs__revision">{{
                                shortRevision(view.revision ?? view.requested_revision)
                            }}</span>
                            <span>{{ formatInstallTime(view.create_time) }}</span>
                            <a
                                v-if="view.page_url"
                                :href="view.page_url"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="pw-installs__link"
                                >Source <FontAwesomeIcon :icon="faExternalLinkAlt" aria-hidden="true" /><span
                                    class="sr-only">
                                    (opens in a new tab)</span
                                ></a
                            >
                        </span>
                    </div>
                    <StatusPill :pill="INSTALL_PHASES[view.phase]" />
                    <button
                        v-if="!finished(view)"
                        type="button"
                        class="btn btn-sm btn-outline-primary"
                        :disabled="busy[view.id]"
                        :aria-label="`Cancel the installation of ${view.label}`"
                        @click="emit('cancel', view.id)">
                        Cancel
                    </button>
                    <button
                        v-else
                        type="button"
                        class="btn btn-sm btn-outline-primary"
                        :disabled="busy[view.id]"
                        :aria-label="`Dismiss the installation of ${view.label}`"
                        @click="emit('dismiss', view.id)">
                        Dismiss
                    </button>
                </div>
                <p class="pw-installs__summary">{{ summary(view) }}</p>
                <p v-if="view.message && view.phase === 'failed'" class="pw-installs__error">{{ view.message }}</p>
                <p v-if="errors[view.id]" class="pw-installs__error" role="alert">{{ errors[view.id] }}</p>
                <ul v-if="view.tools.length" class="pw-outcomes">
                    <li v-for="tool in view.tools" :key="tool.path" class="pw-outcome">
                        <span class="pw-outcome__state" :class="`pw-outcome__state--${OUTCOMES[tool.state].tone}`">
                            <FontAwesomeIcon :icon="OUTCOMES[tool.state].icon" fixed-width aria-hidden="true" />
                            <span class="sr-only">{{ OUTCOMES[tool.state].label }}:</span>
                        </span>
                        <div class="pw-outcome__body">
                            <span class="pw-outcome__name">{{ toolLabel(tool) }}</span>
                            <span class="pw-outcome__path">{{ tool.path }}</span>
                            <ul v-if="tool.state !== 'installed' && tool.errors.length" class="pw-outcome__reasons">
                                <li v-for="(reason, index) in tool.errors" :key="index">{{ reason }}</li>
                            </ul>
                            <ul v-if="tool.warnings.length" class="pw-outcome__warnings">
                                <li v-for="(warning, index) in tool.warnings" :key="index">{{ warning }}</li>
                            </ul>
                        </div>
                    </li>
                </ul>
            </li>
        </ul>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/tones.scss";

.pw-tools-heading {
    margin: 0 0 0.75rem;
    font-size: 1.0625rem;
    font-weight: 600;
}

.pw-installs__list {
    margin: 0;
    padding: 0;
    list-style: none;
}

.pw-installs__item {
    padding: 0.875rem 1rem;
    border: 1px solid $border-color;
    border-radius: 0.5rem;

    & + & {
        margin-top: 0.75rem;
    }
}

.pw-installs__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;
}

.pw-installs__title {
    flex: 1 1 14rem;
    min-width: 0;
}

.pw-installs__name {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    overflow-wrap: anywhere;
}

.pw-installs__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.125rem 0.75rem;
    color: $text-light;
    font-size: 0.8125rem;
}

.pw-installs__revision {
    font-family: $font-family-monospace;
}

.pw-installs__link {
    font-weight: 600;
    white-space: nowrap;
}

.pw-installs__summary {
    margin: 0.5rem 0 0;
    font-size: 0.9375rem;
}

.pw-installs__error {
    margin: 0.5rem 0 0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: map-get(map-get($pw-tones, "danger"), "background");
    color: map-get(map-get($pw-tones, "danger"), "text");
    font-size: 0.875rem;
    overflow-wrap: anywhere;
    white-space: pre-line;
}

.pw-outcomes {
    margin: 0.625rem 0 0;
    padding: 0;
    list-style: none;
    border-top: 1px solid $border-color;
}

.pw-outcome {
    display: flex;
    gap: 0.5rem;
    padding: 0.5rem 0 0;
}

.pw-outcome__state {
    flex: none;
    margin-top: 0.125rem;

    @each $tone in ("success", "neutral", "danger") {
        &--#{$tone} {
            color: map-get(map-get($pw-tones, $tone), "accent");
        }
    }
}

.pw-outcome__body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
}

.pw-outcome__name {
    font-weight: 600;
    overflow-wrap: anywhere;
}

.pw-outcome__path {
    color: $text-light;
    font-family: $font-family-monospace;
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
}

.pw-outcome__reasons,
.pw-outcome__warnings {
    margin: 0.25rem 0 0;
    padding-left: 1.125rem;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
}

.pw-outcome__reasons {
    color: map-get(map-get($pw-tones, "danger"), "text");
}

.pw-outcome__warnings {
    color: map-get(map-get($pw-tones, "warning"), "text");
}
</style>
