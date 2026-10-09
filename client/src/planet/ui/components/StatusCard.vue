<script setup lang="ts">
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed } from "vue";

import { CARD_STATES, type CardState } from "../lib/display";

import StatusPill from "./StatusPill.vue";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{
    title: string;
    icon: IconDefinition;
    state: CardState;
    detail: string;
    actionLabel: string;
    /** Id of the setup section the action opens. */
    controls: string;
}>();

const emit = defineEmits<{ action: [] }>();

const tone = computed(() => CARD_STATES[props.state].tone);
const primary = computed(() => props.state === "not_configured" || props.state === "error");
</script>

<template>
    <article class="pw-status" :class="`pw-status--${tone}`">
        <div class="pw-status__head">
            <span class="pw-status__icon" aria-hidden="true">
                <FontAwesomeIcon :icon="icon" fixed-width />
            </span>
            <h3 class="pw-status__title">{{ title }}</h3>
        </div>
        <StatusPill :state="state" />
        <p class="pw-status__detail">{{ detail }}</p>
        <button
            type="button"
            class="btn btn-sm pw-status__action"
            :class="primary ? 'btn-primary' : 'btn-outline-primary'"
            :aria-controls="controls"
            @click="emit('action')">
            {{ actionLabel }}
            <span class="sr-only">: {{ title }}</span>
        </button>
    </article>
</template>

<style scoped lang="scss">
@import "../styles/tones.scss";

.pw-status {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 1.125rem 1.25rem 1.25rem;
    border: 1px solid $border-color;
    border-radius: 0.625rem;
    background: $white;
    overflow: hidden;

    &::before {
        content: "";
        position: absolute;
        inset: 0 auto 0 0;
        width: 4px;
    }
}

@each $tone, $colors in $pw-tones {
    .pw-status--#{$tone}::before {
        background: map-get($colors, "accent");
    }
}

.pw-status__head {
    display: flex;
    align-items: center;
    gap: 0.625rem;
}

.pw-status__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: 0.5rem;
    background: map-get(map-get($pw-tones, "info"), "background");
    color: $brand-primary;
    font-size: 1.05rem;
}

.pw-status__title {
    margin: 0;
    font-size: 1.0625rem;
    font-weight: 600;
}

.pw-status__detail {
    flex: 1;
    margin: 0;
    color: $text-light;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
}

.pw-status__action {
    margin-top: 0.25rem;
}
</style>
