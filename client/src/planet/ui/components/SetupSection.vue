<script setup lang="ts">
import { faChevronDown } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";

import type { CardState, PillInfo } from "../lib/display";

import StatusPill from "./StatusPill.vue";

defineOptions({ compatConfig: { MODE: 3 } });

defineProps<{
    id: string;
    step: number;
    title: string;
    description: string;
    /** A connection state, or `pill` for other kinds of status. */
    state?: CardState;
    pill?: PillInfo;
    expanded: boolean;
}>();

const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
    <section :id="id" class="pw-section" :aria-labelledby="`${id}-title`">
        <div class="pw-section__head">
            <span class="pw-section__step" aria-hidden="true">{{ step }}</span>
            <div class="pw-section__heading">
                <h2 :id="`${id}-title`" class="pw-section__title">{{ title }}</h2>
                <p class="pw-section__description">{{ description }}</p>
            </div>
            <div class="pw-section__aside">
                <StatusPill :state="state" :pill="pill" />
                <button
                    type="button"
                    class="btn btn-sm btn-outline-primary pw-section__toggle"
                    :aria-expanded="expanded ? 'true' : 'false'"
                    :aria-controls="`${id}-body`"
                    @click="emit('toggle')">
                    {{ expanded ? "Hide settings" : "Show settings" }}
                    <FontAwesomeIcon
                        :icon="faChevronDown"
                        class="pw-section__chevron"
                        :class="{ 'pw-section__chevron--open': expanded }"
                        aria-hidden="true" />
                </button>
            </div>
        </div>
        <div v-show="expanded" :id="`${id}-body`" class="pw-section__body">
            <slot />
        </div>
    </section>
</template>

<style scoped lang="scss">
@import "@/style/scss/theme/blue.scss";

.pw-section {
    border: 1px solid $border-color;
    border-radius: 0.625rem;
    background: $white;
    scroll-margin-top: 1rem;
}

.pw-section__head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 0.75rem 1rem;
    padding: 1.125rem 1.25rem;
}

.pw-section__step {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    background: $brand-primary;
    color: $white;
    font-weight: 700;
}

.pw-section__heading {
    flex: 1 1 14rem;
    min-width: 0;
}

.pw-section__title {
    margin: 0.2rem 0 0;
    font-size: 1.25rem;
    font-weight: 600;
}

.pw-section__description {
    margin: 0.25rem 0 0;
    color: $text-light;
}

.pw-section__aside {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
}

.pw-section__chevron {
    margin-left: 0.25rem;
    transition: transform 0.15s ease;
}

.pw-section__chevron--open {
    transform: rotate(180deg);
}

.pw-section__body {
    padding: 1.25rem;
    border-top: 1px solid $border-color;
}

@media (prefers-reduced-motion: reduce) {
    .pw-section__chevron {
        transition: none;
    }
}

@media (max-width: 575.98px) {
    .pw-section__head,
    .pw-section__body {
        padding: 1rem;
    }

    .pw-section__aside {
        margin-left: 2.75rem;
    }
}
</style>
