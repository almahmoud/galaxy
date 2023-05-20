<template>
    <div class="infomessagelarge">
        <p v-if="entryPoints.length == 0">Waiting for InteractiveTool result view(s) to become available.</p>
        <p v-else-if="entryPoints.length == 1">
            <span v-if="entryPoints[0].active">
                There is an InteractiveTool result view available,
                <a v-b-tooltip title="Open Interactive Tool" :href="entryPoints[0].target" target="_blank">
                    OPEN WORKSHOP
                    <font-awesome-icon icon="external-link-alt" />
                </a>
            </span>
            <span v-else>
                Your workshop is launching, please wait for it to become ready. This text will be replaced with a clickable link when your workshop becomes accessible.
            </span>
        </p>
        <div v-else>
            There are multiple InteractiveTool result views available:
            <ul>
                <li v-for="entryPoint of entryPoints" :key="entryPoint.id">
                    {{ entryPoint.name }}
                    <span v-if="entryPoint.active"> (<a :href="entryPoint.target">click here to display</a>) </span>
                    <span v-else> (waiting to become active...) </span>
                </li>
            </ul>
        </div>
        <strong>You may only have 2 workshops active at once.</strong> Further launches will result in an indefinite wait.
        <br>You may access all launched workshops and stop them from the
        <a :href="interactiveToolsLink">User menu</a>.
    </div>
</template>

<script>
import { clearPolling, pollUntilActive } from "mvc/entrypoints/poll";
import { getGalaxyInstance } from "app";
import { getAppRoot } from "onload/loadConfig";

export default {
    props: {
        jobId: {
            type: String,
            required: true,
        },
    },
    data() {
        return {
            entryPoints: [],
        };
    },
    created: function () {
        this.pollEntryPoints();
    },
    beforeDestroy: function () {
        clearPolling();
    },
    computed: {
        interactiveToolsLink: function () {
            return getAppRoot() + "interactivetool_entry_points/list";
        },
    },
    methods: {
        pollEntryPoints: function () {
            const onUpdate = (entryPoints) => {
                this.entryPoints = entryPoints;
            };
            const onError = (e) => {
                console.error(e);
            };
            pollUntilActive(onUpdate, onError, { job_id: this.jobId });
        },
    },
};
</script>
