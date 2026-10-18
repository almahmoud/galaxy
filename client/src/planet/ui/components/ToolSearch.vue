<script setup lang="ts">
import { faChevronRight, faCodeBranch, faExternalLinkAlt, faSearch } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed, onBeforeUnmount, reactive, ref } from "vue";

import { type InstallSource, InstallSourceError, MAIN_TOOL_SHED, parseInstallSource } from "@/planet/install/source";
import { type RepositoryHit, repositoryPageUrl, type ToolHit } from "@/planet/install/toolshed";
import type { InstallView } from "@/planet/install/views";

import { useToolServices } from "../lib/tools";

import FormField from "./FormField.vue";
import RepositoryInstall from "./RepositoryInstall.vue";

defineOptions({ compatConfig: { MODE: 3 } });

defineProps<{ canInstall: boolean }>();
const emit = defineEmits<{ installed: [view: InstallView] }>();

const services = useToolServices();

type Mode = "repositories" | "tools";

const TOOL_SHED_HOST = new URL(MAIN_TOOL_SHED).host;

const query = ref("");
const mode = ref<Mode>("repositories");
const searched = ref<{ query: string; mode: Mode } | null>(null);
const repositories = ref<RepositoryHit[]>([]);
const toolHits = ref<ToolHit[]>([]);
const total = ref(0);
const page = ref(1);
const searching = ref(false);
const searchError = ref("");
let controller: AbortController | null = null;

const shown = computed(() => (searched.value?.mode === "tools" ? toolHits.value.length : repositories.value.length));
const more = computed(() => searched.value !== null && shown.value < total.value);
const status = computed(() => {
    if (searching.value) {
        return "Searching the Tool Shed…";
    }
    if (!searched.value || searchError.value) {
        return "";
    }
    const { query: text, mode: kind } = searched.value;
    return total.value
        ? `Showing ${shown.value} of ${total.value} ${kind} for “${text}”.`
        : `No ${kind} match “${text}”.`;
});

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function search(next = false) {
    const text = next && searched.value ? searched.value.query : query.value.trim();
    const kind = next && searched.value ? searched.value.mode : mode.value;
    if (!text) {
        searchError.value = "Enter a repository name, a tool name or a topic to search for.";
        return;
    }
    controller?.abort();
    const current = new AbortController();
    controller = current;
    searching.value = true;
    searchError.value = "";
    const pageNumber = next ? page.value + 1 : 1;
    try {
        if (kind === "tools") {
            const result = await services.searchTools(text, pageNumber, current.signal);
            toolHits.value = next ? [...toolHits.value, ...result.hits] : result.hits;
            total.value = result.total;
        } else {
            const result = await services.searchRepositories(text, pageNumber, current.signal);
            repositories.value = next ? [...repositories.value, ...result.hits] : result.hits;
            total.value = result.total;
        }
        page.value = pageNumber;
        searched.value = { query: text, mode: kind };
    } catch (error) {
        if (!current.signal.aborted) {
            searchError.value = message(error);
        }
    } finally {
        if (controller === current) {
            searching.value = false;
        }
    }
}

function setMode(next: Mode) {
    if (mode.value === next) {
        return;
    }
    mode.value = next;
    if (searched.value && query.value.trim()) {
        void search();
    }
}

const github = reactive({ open: false, repository: "", ref: "", path: "", error: "", installing: false, started: "" });

async function installGitHub() {
    github.error = "";
    github.started = "";
    let source: InstallSource;
    try {
        source = parseInstallSource({
            type: "github",
            repository: github.repository,
            ref: github.ref,
            path: github.path,
        });
    } catch (error) {
        github.error = error instanceof InstallSourceError ? error.message : message(error);
        return;
    }
    github.installing = true;
    try {
        const view = await services.install(source);
        github.started = `Installing ${view.label}. Follow it under Installations.`;
        emit("installed", view);
    } catch (error) {
        github.error = message(error);
    } finally {
        github.installing = false;
    }
}

onBeforeUnmount(() => controller?.abort());
</script>

<template>
    <div class="pw-search">
        <form class="pw-search__form" role="search" aria-label="Tool Shed" @submit.prevent="search()">
            <label for="pw-tools-query" class="pw-search__label">Search the Galaxy Tool Shed</label>
            <div class="pw-search__row">
                <input
                    id="pw-tools-query"
                    v-model="query"
                    class="form-control"
                    type="search"
                    maxlength="200"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="For example: datamash, bowtie2, fastqc"
                    aria-describedby="pw-tools-query-help" />
                <button type="submit" class="btn btn-primary" :disabled="searching">
                    <FontAwesomeIcon :icon="faSearch" aria-hidden="true" />
                    Search
                </button>
            </div>
            <p id="pw-tools-query-help" class="pw-search__help">
                This page asks {{ TOOL_SHED_HOST }} directly; nothing about your data is sent.
            </p>
            <div class="btn-group btn-group-sm pw-segmented" role="group" aria-label="Search for">
                <button
                    type="button"
                    class="btn"
                    :class="mode === 'repositories' ? 'btn-primary' : 'btn-outline-primary'"
                    :aria-pressed="mode === 'repositories' ? 'true' : 'false'"
                    @click="setMode('repositories')">
                    Repositories
                </button>
                <button
                    type="button"
                    class="btn"
                    :class="mode === 'tools' ? 'btn-primary' : 'btn-outline-primary'"
                    :aria-pressed="mode === 'tools' ? 'true' : 'false'"
                    @click="setMode('tools')">
                    Tools
                </button>
            </div>
        </form>

        <div v-if="searchError" class="pw-search__error" role="alert">
            {{ searchError }}
            <button
                v-if="query.trim()"
                type="button"
                class="btn btn-link btn-sm p-0 pw-search__retry"
                @click="search()">
                Try again
            </button>
        </div>
        <p class="pw-search__status" role="status">{{ status }}</p>

        <ul v-if="searched?.mode === 'repositories' && repositories.length" class="pw-results">
            <li v-for="hit in repositories" :key="`${hit.owner}/${hit.name}`" class="pw-result">
                <div class="pw-result__main">
                    <h4 class="pw-result__title">
                        <span class="pw-result__owner">{{ hit.owner }} /</span> {{ hit.name }}
                    </h4>
                    <p v-if="hit.description" class="pw-result__description">{{ hit.description }}</p>
                    <p class="pw-result__meta">
                        <span v-if="hit.categories">{{ hit.categories }}</span>
                        <span v-if="hit.times_downloaded !== null"
                            >Installed {{ hit.times_downloaded.toLocaleString() }} times</span
                        >
                        <a
                            :href="repositoryPageUrl(hit.owner, hit.name)"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="pw-result__link"
                            >Tool Shed page <FontAwesomeIcon :icon="faExternalLinkAlt" aria-hidden="true" /><span
                                class="sr-only">
                                (opens in a new tab)</span
                            ></a
                        >
                    </p>
                </div>
                <RepositoryInstall
                    class="pw-result__install"
                    :owner="hit.owner"
                    :name="hit.name"
                    :can-install="canInstall"
                    @installed="emit('installed', $event)" />
            </li>
        </ul>
        <ul v-else-if="searched?.mode === 'tools' && toolHits.length" class="pw-results">
            <li v-for="hit in toolHits" :key="`${hit.owner}/${hit.repository}/${hit.id}`" class="pw-result">
                <div class="pw-result__main">
                    <h4 class="pw-result__title">{{ hit.name }}</h4>
                    <p v-if="hit.description" class="pw-result__description">{{ hit.description }}</p>
                    <p class="pw-result__meta">
                        <span
                            >Tool <code>{{ hit.id }}</code> in {{ hit.owner }}/{{ hit.repository }}</span
                        >
                        <a
                            :href="repositoryPageUrl(hit.owner, hit.repository)"
                            target="_blank"
                            rel="noopener noreferrer"
                            class="pw-result__link"
                            >Tool Shed page <FontAwesomeIcon :icon="faExternalLinkAlt" aria-hidden="true" /><span
                                class="sr-only">
                                (opens in a new tab)</span
                            ></a
                        >
                    </p>
                </div>
                <RepositoryInstall
                    class="pw-result__install"
                    :owner="hit.owner"
                    :name="hit.repository"
                    :can-install="canInstall"
                    install-label="Install repository"
                    @installed="emit('installed', $event)" />
            </li>
        </ul>
        <button
            v-if="more"
            type="button"
            class="btn btn-sm btn-outline-primary pw-search__more"
            :disabled="searching"
            @click="search(true)">
            Show more results
        </button>

        <div class="pw-github">
            <button
                type="button"
                class="pw-disclosure"
                :aria-expanded="github.open ? 'true' : 'false'"
                aria-controls="pw-tools-github"
                @click="github.open = !github.open">
                <FontAwesomeIcon :icon="faChevronRight" class="pw-disclosure__chevron" aria-hidden="true" />
                <FontAwesomeIcon :icon="faCodeBranch" aria-hidden="true" />
                Install from a GitHub commit
            </button>
            <form v-show="github.open" id="pw-tools-github" class="pw-panel" @submit.prevent="installGitHub">
                <p class="pw-panel__text">
                    Installs the tools of a directory of a public GitHub repository at one commit, for example a tool
                    directory of galaxyproject/tools-iuc.
                </p>
                <div class="pw-grid">
                    <FormField id="pw-github-repository" label="Repository" help="owner/name">
                        <template v-slot="{ id, describedBy }">
                            <input
                                :id="id"
                                v-model="github.repository"
                                class="form-control"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="galaxyproject/tools-iuc"
                                :aria-describedby="describedBy" />
                        </template>
                    </FormField>
                    <FormField id="pw-github-ref" label="Commit" help="The full 40-character commit SHA.">
                        <template v-slot="{ id, describedBy }">
                            <input
                                :id="id"
                                v-model="github.ref"
                                class="form-control pw-mono"
                                autocomplete="off"
                                spellcheck="false"
                                maxlength="40"
                                :aria-describedby="describedBy" />
                        </template>
                    </FormField>
                    <FormField
                        id="pw-github-path"
                        label="Directory"
                        optional
                        help="Where the tools are, such as tools/datamash.">
                        <template v-slot="{ id, describedBy }">
                            <input
                                :id="id"
                                v-model="github.path"
                                class="form-control"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-describedby="describedBy" />
                        </template>
                    </FormField>
                </div>
                <div class="pw-github__actions">
                    <button type="submit" class="btn btn-sm btn-primary" :disabled="github.installing || !canInstall">
                        {{ github.installing ? "Starting…" : "Install" }}
                    </button>
                    <p v-if="github.started" class="pw-github__started" role="status">{{ github.started }}</p>
                    <p v-if="github.error" class="pw-github__error" role="alert">{{ github.error }}</p>
                </div>
            </form>
        </div>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/form.scss";

.pw-search__label {
    display: block;
    margin-bottom: 0.375rem;
    font-weight: 600;
}

.pw-search__row {
    display: flex;
    gap: 0.5rem;

    .form-control {
        flex: 1 1 auto;
        min-width: 0;
    }

    .btn {
        display: inline-flex;
        flex: none;
        align-items: center;
        gap: 0.375rem;
    }
}

.pw-search__help {
    margin: 0.375rem 0 0.75rem;
    color: $text-light;
    font-size: 0.875rem;
}

.pw-search__status {
    margin: 0 0 0.75rem;
    color: $text-light;
    font-size: 0.875rem;

    &:empty {
        display: none;
    }
}

.pw-search__error,
.pw-github__error {
    margin: 0 0 0.75rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: map-get(map-get($pw-tones, "danger"), "background");
    color: map-get(map-get($pw-tones, "danger"), "text");
    font-size: 0.875rem;
    overflow-wrap: anywhere;
}

.pw-search__retry {
    margin-left: 0.5rem;
    color: inherit;
    font-weight: 600;
    text-decoration: underline;
    vertical-align: baseline;
}

.pw-search__more {
    margin-bottom: 0.5rem;
}

.pw-results {
    margin: 0 0 1rem;
    padding: 0;
    list-style: none;
    border: 1px solid $border-color;
    border-radius: 0.5rem;
}

.pw-result {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1.25rem;
    padding: 0.875rem 1rem;

    & + & {
        border-top: 1px solid $border-color;
    }
}

.pw-result__main {
    flex: 1 1 20rem;
    min-width: 0;
}

.pw-result__title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    overflow-wrap: anywhere;
}

.pw-result__owner {
    color: $text-light;
    font-weight: 400;
}

.pw-result__description {
    margin: 0.25rem 0 0;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
}

.pw-result__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    margin: 0.375rem 0 0;
    color: $text-light;
    font-size: 0.8125rem;

    code {
        color: inherit;
        overflow-wrap: anywhere;
    }
}

.pw-result__link {
    font-weight: 600;
    white-space: nowrap;
}

.pw-result__install {
    flex: 0 1 18rem;
}

.pw-github {
    margin-top: 1.25rem;
}

.pw-github__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 0.75rem;

    p {
        margin: 0;
    }
}

.pw-github__started {
    color: map-get(map-get($pw-tones, "success"), "text");
    font-size: 0.875rem;
    font-weight: 600;
}

.pw-mono {
    font-family: $font-family-monospace;
}

@media (max-width: 575.98px) {
    .pw-result__install {
        flex-basis: 100%;
    }
}
</style>
