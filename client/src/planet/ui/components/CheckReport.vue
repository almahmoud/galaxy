<script setup lang="ts">
import { faCircleNotch } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { computed } from "vue";

import type { CheckItem, ComponentState } from "../lib/checks";
import { CHECK_STATUSES, firstProblem } from "../lib/display";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{
    /** Accessible name of the result region, such as "Cluster connection test". */
    label: string;
    running: boolean;
    state?: ComponentState | null;
    checks?: readonly CheckItem[];
}>();

const SUMMARIES: Record<ComponentState, string> = {
    ok: "The connection works.",
    warning: "The connection works, with warnings.",
    error: "The connection does not work yet.",
    not_configured: "Fill in the settings first.",
};

const summary = computed(() => (props.state ? SUMMARIES[props.state] : ""));
/** Announced to screen readers: the outcome and the first problem, not the whole list. */
const announcement = computed(() => {
    if (props.running) {
        return "Testing the connection.";
    }
    const problem = firstProblem(props.checks ?? []);
    return [summary.value, problem && problem.status !== "skipped" ? `${problem.title}: ${problem.message}` : ""]
        .filter(Boolean)
        .join(" ");
});
const visibleChecks = computed(() => (props.checks ?? []).filter((check) => check.status !== "skipped"));
const skipped = computed(() => (props.checks ?? []).filter((check) => check.status === "skipped").length);
</script>

<template>
    <div class="pw-report" role="region" :aria-label="label">
        <p class="sr-only" aria-live="polite">{{ announcement }}</p>
        <p v-if="running" class="pw-report__running" aria-hidden="true">
            <FontAwesomeIcon :icon="faCircleNotch" spin fixed-width aria-hidden="true" />
            Testing the connection…
        </p>
        <template v-else-if="state">
            <p class="pw-report__summary" :class="`pw-report__summary--${state}`">{{ summary }}</p>
            <ul class="pw-report__list">
                <li
                    v-for="check in visibleChecks"
                    :key="check.id"
                    class="pw-check"
                    :class="`pw-check--${CHECK_STATUSES[check.status].tone}`">
                    <FontAwesomeIcon
                        :icon="CHECK_STATUSES[check.status].icon"
                        class="pw-check__icon"
                        fixed-width
                        aria-hidden="true" />
                    <div class="pw-check__body">
                        <p class="pw-check__title">
                            {{ check.title }}
                            <span class="sr-only">: {{ CHECK_STATUSES[check.status].label }}.</span>
                        </p>
                        <p class="pw-check__message">{{ check.message }}</p>
                        <p v-if="check.fix && check.status !== 'ok'" class="pw-check__fix">
                            <strong>Fix:</strong> {{ check.fix }}
                        </p>
                    </div>
                </li>
            </ul>
            <p v-if="skipped && state !== 'not_configured'" class="pw-report__skipped">
                {{ skipped === 1 ? "1 check was" : `${skipped} checks were` }} skipped after the first failure.
            </p>
            <p v-else-if="state === 'not_configured' && checks?.[0]" class="pw-report__skipped">
                {{ checks[0].message }}
            </p>
            <slot />
        </template>
    </div>
</template>

<style scoped lang="scss">
@import "../styles/tones.scss";

.pw-report__running {
    margin: 1rem 0 0;
    color: $brand-primary;
    font-weight: 600;
}

.pw-report__summary {
    margin: 1.25rem 0 0.5rem;
    font-weight: 600;
}

.pw-report__summary--ok {
    color: map-get(map-get($pw-tones, "success"), "text");
}

.pw-report__summary--warning {
    color: map-get(map-get($pw-tones, "warning"), "text");
}

.pw-report__summary--error {
    color: map-get(map-get($pw-tones, "danger"), "text");
}

.pw-report__list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid $border-color;
    border-radius: 0.5rem;
    overflow: hidden;
}

.pw-check {
    display: flex;
    gap: 0.625rem;
    padding: 0.625rem 0.875rem;
    background: $white;

    & + & {
        border-top: 1px solid $border-color;
    }
}

@each $tone, $colors in $pw-tones {
    .pw-check--#{$tone} .pw-check__icon {
        color: map-get($colors, "text");
    }
}

.pw-check--danger {
    background: lighten(map-get(map-get($pw-tones, "danger"), "background"), 2%);
}

.pw-check--warning {
    background: lighten(map-get(map-get($pw-tones, "warning"), "background"), 2%);
}

.pw-check__icon {
    flex: none;
    margin-top: 0.2rem;
}

.pw-check__body {
    min-width: 0;
}

.pw-check__title {
    margin: 0;
    font-weight: 600;
}

.pw-check__message,
.pw-check__fix {
    margin: 0.125rem 0 0;
    overflow-wrap: anywhere;
}

.pw-check__fix {
    color: $text-color;
    font-size: 0.9375rem;
}

.pw-report__skipped {
    margin: 0.5rem 0 0;
    color: $text-light;
    font-size: 0.875rem;
}
</style>
