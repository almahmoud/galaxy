<script setup lang="ts">
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed } from "vue";

import { CARD_STATES, type CardState } from "../lib/display";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{ state: CardState }>();

const info = computed(() => CARD_STATES[props.state]);
</script>

<template>
    <span class="pw-pill" :class="`pw-pill--${info.tone}`">
        <FontAwesomeIcon :icon="info.icon" :spin="state === 'checking'" fixed-width aria-hidden="true" />
        {{ info.label }}
    </span>
</template>

<style scoped lang="scss">
@import "../styles/tones.scss";

.pw-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.6rem 0.15rem 0.45rem;
    border-radius: 999px;
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.5;
    white-space: nowrap;
}

@each $tone, $colors in $pw-tones {
    .pw-pill--#{$tone} {
        color: map-get($colors, "text");
        background: map-get($colors, "background");
    }
}
</style>
