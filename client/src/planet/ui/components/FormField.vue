<script setup lang="ts">
import { computed, useSlots } from "vue";

defineOptions({ compatConfig: { MODE: 3 } });

const props = defineProps<{
    id: string;
    label: string;
    help?: string;
    error?: string;
    optional?: boolean;
}>();

const helpId = computed(() => `${props.id}-help`);
const errorId = computed(() => `${props.id}-error`);
const slots = useSlots();
const hasHelp = computed(() => Boolean(props.help || slots.help));
const describedBy = computed(
    () => [hasHelp.value ? helpId.value : "", props.error ? errorId.value : ""].filter(Boolean).join(" ") || undefined,
);
</script>

<template>
    <div class="pw-field">
        <label :for="id" class="pw-field__label">
            {{ label }}
            <span v-if="optional" class="pw-field__optional">optional</span>
        </label>
        <slot :id="id" :described-by="describedBy" :invalid="Boolean(error)" />
        <p v-if="hasHelp" :id="helpId" class="pw-field__help">
            <slot name="help">{{ help }}</slot>
        </p>
        <p v-if="error" :id="errorId" class="pw-field__error">{{ error }}</p>
    </div>
</template>

<style scoped lang="scss">
@import "@/style/scss/theme/blue.scss";

.pw-field {
    margin-bottom: 1rem;
    min-width: 0;
}

.pw-field__label {
    display: block;
    margin-bottom: 0.25rem;
    font-weight: 600;
}

.pw-field__optional {
    margin-left: 0.25rem;
    font-weight: 400;
    font-size: 0.85em;
    color: $text-light;
}

.pw-field__help,
.pw-field__error {
    margin: 0.25rem 0 0;
    font-size: 0.875rem;
}

.pw-field__help {
    color: $text-light;
}

.pw-field__error {
    color: darken($brand-danger, 8%);
}
</style>
