<script setup lang="ts">
import { faExternalLinkAlt, faTrashAlt } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { nextTick, ref } from "vue";

import type { InstalledToolView } from "@/planet/install/views";

import { formatInstallTime, installedKey as key, shortRevision } from "../lib/tools";

defineOptions({ compatConfig: { MODE: 3 } });

/** Installed tool versions; `busy` and `errors` are keyed by `installedKey`. */
defineProps<{ tools: InstalledToolView[]; busy: Record<string, boolean>; errors: Record<string, string> }>();
const emit = defineEmits<{ uninstall: [tool: InstalledToolView] }>();

const confirming = ref<string | null>(null);

async function ask(tool: InstalledToolView, index: number) {
    confirming.value = key(tool);
    await nextTick();
    document.getElementById(`pw-uninstall-${index}`)?.focus();
}

function confirm(tool: InstalledToolView) {
    confirming.value = null;
    emit("uninstall", tool);
}
</script>

<template>
    <div class="pw-installed">
        <h3 class="pw-tools-heading">
            Installed tools <span v-if="tools.length" class="pw-installed__count">({{ tools.length }})</span>
        </h3>
        <p v-if="!tools.length" class="pw-installed__empty">
            No tools installed yet. Installed tools appear in the tool panel under “Installed tools”.
        </p>
        <ul v-else class="pw-installed__list">
            <li v-for="(tool, index) in tools" :key="key(tool)" class="pw-installed__item">
                <div class="pw-installed__main">
                    <h4 class="pw-installed__name">
                        {{ tool.name }} <span class="pw-installed__version">{{ tool.version }}</span>
                    </h4>
                    <p v-if="tool.description" class="pw-installed__description">{{ tool.description }}</p>
                    <p class="pw-installed__meta">
                        <span v-if="tool.repository"
                            >From {{ tool.repository
                            }}<template v-if="tool.revision">
                                at
                                <span class="pw-installed__revision">{{ shortRevision(tool.revision) }}</span></template
                            ></span
                        >
                        <span>Installed {{ formatInstallTime(tool.install_time) }}</span>
                        <a
                            v-if="tool.page_url"
                            :href="tool.page_url"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="pw-installed__link"
                            >Source <FontAwesomeIcon :icon="faExternalLinkAlt" aria-hidden="true" /><span
                                class="sr-only">
                                (opens in a new tab)</span
                            ></a
                        >
                    </p>
                    <p class="pw-installed__id">{{ tool.id }}</p>
                </div>
                <div class="pw-installed__actions">
                    <template v-if="confirming === key(tool)">
                        <span :id="`pw-uninstall-label-${index}`" class="pw-installed__question"
                            >Uninstall this version?</span
                        >
                        <button
                            :id="`pw-uninstall-${index}`"
                            type="button"
                            class="btn btn-sm btn-danger"
                            :aria-describedby="`pw-uninstall-label-${index}`"
                            @click="confirm(tool)">
                            Uninstall
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-primary" @click="confirming = null">
                            Keep
                        </button>
                    </template>
                    <button
                        v-else
                        type="button"
                        class="btn btn-sm btn-outline-danger"
                        :disabled="busy[key(tool)]"
                        :aria-label="`Uninstall ${tool.name} ${tool.version}`"
                        @click="ask(tool, index)">
                        <FontAwesomeIcon :icon="faTrashAlt" aria-hidden="true" />
                        {{ busy[key(tool)] ? "Uninstalling…" : "Uninstall" }}
                    </button>
                </div>
                <p v-if="errors[key(tool)]" class="pw-installed__error" role="alert">{{ errors[key(tool)] }}</p>
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

.pw-installed__count {
    color: $text-light;
    font-weight: 400;
}

.pw-installed__empty {
    margin: 0;
    color: $text-light;
}

.pw-installed__list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid $border-color;
    border-radius: 0.5rem;
}

.pw-installed__item {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.5rem 1rem;
    padding: 0.875rem 1rem;

    & + & {
        border-top: 1px solid $border-color;
    }
}

.pw-installed__main {
    flex: 1 1 18rem;
    min-width: 0;
}

.pw-installed__name {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    overflow-wrap: anywhere;
}

.pw-installed__version {
    color: $text-light;
    font-weight: 400;
}

.pw-installed__description {
    margin: 0.125rem 0 0;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
}

.pw-installed__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.125rem 1rem;
    margin: 0.375rem 0 0;
    color: $text-light;
    font-size: 0.8125rem;
}

.pw-installed__revision,
.pw-installed__id {
    font-family: $font-family-monospace;
}

.pw-installed__id {
    margin: 0.25rem 0 0;
    color: $text-light;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
}

.pw-installed__link {
    font-weight: 600;
    white-space: nowrap;
}

.pw-installed__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;

    .btn {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
    }
}

.pw-installed__question {
    font-size: 0.875rem;
    font-weight: 600;
}

.pw-installed__error {
    flex: 1 1 100%;
    margin: 0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: map-get(map-get($pw-tones, "danger"), "background");
    color: map-get(map-get($pw-tones, "danger"), "text");
    font-size: 0.875rem;
    overflow-wrap: anywhere;
}
</style>
