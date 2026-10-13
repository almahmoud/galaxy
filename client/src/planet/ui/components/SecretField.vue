<script setup lang="ts">
import { faEye, faEyeSlash } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { ref } from "vue";

import FormField from "./FormField.vue";

defineOptions({ compatConfig: { MODE: 3 } });

/** A write-only secret: the saved value is never shown, only whether one exists. */
const props = defineProps<{
    id: string;
    label: string;
    /** The secret in lower case for sentences, such as "token". */
    noun: string;
    help: string;
    placeholder: string;
    /** True when a secret is saved. */
    saved: boolean;
    error?: string;
}>();

const value = defineModel<string>({ required: true });
const clear = defineModel<boolean>("clear", { required: true });

const visible = ref(false);

function onInput(event: Event) {
    value.value = (event.target as HTMLInputElement).value;
    if (value.value) {
        clear.value = false;
    }
}
</script>

<template>
    <FormField :id="id" :label="label" :error="error">
        <template v-slot="{ describedBy, invalid }">
            <div class="input-group">
                <input
                    :id="id"
                    :type="visible ? 'text' : 'password'"
                    class="form-control text-monospace pw-secret__input"
                    :class="{ 'is-invalid': invalid }"
                    :value="value"
                    :placeholder="saved && !clear ? `Saved ${props.noun}` : placeholder"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    :aria-describedby="describedBy"
                    :aria-invalid="invalid ? 'true' : undefined"
                    @input="onInput" />
                <div class="input-group-append">
                    <button
                        type="button"
                        class="btn btn-outline-primary"
                        :aria-pressed="visible ? 'true' : 'false'"
                        @click="visible = !visible">
                        <FontAwesomeIcon :icon="visible ? faEyeSlash : faEye" fixed-width aria-hidden="true" />
                        <span class="sr-only">Show {{ noun }}</span>
                    </button>
                </div>
            </div>
        </template>
        <template v-slot:help>
            <template v-if="saved && clear">
                The saved {{ noun }} will be removed when you save.
                <button type="button" class="btn btn-link pw-secret__link" @click="clear = false">Keep it</button>
            </template>
            <template v-else-if="saved && !value">
                A {{ noun }} is saved; leave this empty to keep it.
                <button type="button" class="btn btn-link pw-secret__link" @click="clear = true">Remove it</button>
            </template>
            <template v-else-if="saved">Saving replaces the saved {{ noun }}.</template>
            <template v-else>{{ help }}</template>
        </template>
    </FormField>
</template>

<style scoped lang="scss">
.pw-secret__input {
    font-size: 0.875rem;
}

.pw-secret__link {
    padding: 0;
    border: 0;
    font-size: inherit;
    vertical-align: baseline;
}
</style>
