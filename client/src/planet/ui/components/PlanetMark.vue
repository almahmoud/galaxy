<script setup lang="ts">
defineOptions({ compatConfig: { MODE: 3 } });
</script>

<template>
    <svg class="pw-mark" viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
        <g fill="none" stroke="#fe7f02" stroke-width="2.5" stroke-linecap="round" transform="rotate(-18 24 24)">
            <ellipse cx="24" cy="24" rx="21" ry="6.5" />
        </g>
        <circle cx="24" cy="24" r="13" fill="#25537b" />
        <path
            d="M14.5 19.5c4.5 1 9.5 1 14.5-.5M12.5 28c5 1.4 12.5 1.4 21-.8"
            fill="none"
            stroke="#48a1dd"
            stroke-width="2"
            stroke-linecap="round" />
        <g fill="none" stroke="#fe7f02" stroke-width="2.5" stroke-linecap="round" transform="rotate(-18 24 24)">
            <path d="M3 24a21 6.5 0 0 0 42 0" />
        </g>
    </svg>
</template>

<style scoped>
.pw-mark {
    flex: none;
}
</style>
