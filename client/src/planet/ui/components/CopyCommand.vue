<script setup lang="ts">
import { faCheck, faCopy } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { onBeforeUnmount, ref } from "vue";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{
    text: string;
    /** Names the text for the copy button, as in "Copy {label}". */
    label: string;
    multiline?: boolean;
}>();

const code = ref<HTMLElement | null>(null);
const state = ref<"idle" | "copied" | "selected">("idle");
let timer: ReturnType<typeof setTimeout> | undefined;

function settle(next: "copied" | "selected") {
    state.value = next;
    clearTimeout(timer);
    timer = setTimeout(() => (state.value = "idle"), 4000);
}

async function copy() {
    try {
        await navigator.clipboard.writeText(props.text);
        settle("copied");
    } catch {
        const selection = window.getSelection();
        if (code.value && selection) {
            selection.selectAllChildren(code.value);
        }
        settle("selected");
    }
}

onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
    <div class="pw-copy" :class="{ 'pw-copy--multiline': multiline }">
        <pre v-if="multiline" class="pw-copy__text"><code ref="code">{{ text }}</code></pre>
        <code v-else ref="code" class="pw-copy__text">{{ text }}</code>
        <button type="button" class="btn btn-sm btn-outline-primary pw-copy__button" @click="copy">
            <FontAwesomeIcon :icon="state === 'copied' ? faCheck : faCopy" fixed-width aria-hidden="true" />
            <span class="sr-only">Copy {{ label }}</span>
        </button>
        <span class="pw-copy__feedback" role="status">
            <template v-if="state === 'copied'">Copied</template>
            <template v-else-if="state === 'selected'">Selected: press Ctrl+C or ⌘C to copy</template>
        </span>
    </div>
</template>

<style scoped lang="scss">
@import "@/style/scss/theme/blue.scss";

.pw-copy {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem 0.5rem 0.5rem 0.75rem;
    border: 1px solid $border-color;
    border-radius: 0.375rem;
    background: $gray-100;
}

.pw-copy__text {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0.25rem 0;
    font-size: 0.8125rem;
    color: $text-color;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

.pw-copy--multiline .pw-copy__text {
    max-height: 18rem;
    overflow: auto;
    white-space: pre;
    overflow-wrap: normal;
}

.pw-copy__button {
    flex: none;
    background: $white;
}

.pw-copy__feedback {
    position: absolute;
    right: 0.5rem;
    bottom: calc(100% + 0.25rem);
    font-size: 0.75rem;
    color: $text-light;
    white-space: nowrap;
}
</style>
