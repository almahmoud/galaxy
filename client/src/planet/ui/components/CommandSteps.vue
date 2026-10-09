<script setup lang="ts">
import type { SetupCommand } from "../lib/commands";

import CopyCommand from "./CopyCommand.vue";

defineOptions({ compatConfig: { MODE: 3 } });

defineProps<{ commands: readonly SetupCommand[] }>();
</script>

<template>
    <ol class="pw-steps">
        <li v-for="command in commands" :key="command.id" class="pw-steps__item">
            <p class="pw-steps__title">{{ command.title }}</p>
            <p class="pw-steps__description">{{ command.description }}</p>
            <CopyCommand :text="command.command" :label="`command: ${command.title}`" />
        </li>
    </ol>
</template>

<style scoped lang="scss">
@import "@/style/scss/theme/blue.scss";

.pw-steps {
    margin: 0;
    padding: 0;
    list-style: none;
    counter-reset: pw-step;
}

.pw-steps__item {
    position: relative;
    padding-left: 2rem;
    counter-increment: pw-step;

    & + & {
        margin-top: 1rem;
    }

    &::before {
        content: counter(pw-step);
        position: absolute;
        top: 0.05rem;
        left: 0;
        width: 1.375rem;
        height: 1.375rem;
        border: 1px solid $border-color;
        border-radius: 50%;
        color: $text-light;
        font-size: 0.75rem;
        font-weight: 700;
        line-height: 1.25rem;
        text-align: center;
    }
}

.pw-steps__title {
    margin: 0;
    font-weight: 600;
}

.pw-steps__description {
    margin: 0.125rem 0 0.5rem;
    color: $text-light;
    font-size: 0.9375rem;
}
</style>
