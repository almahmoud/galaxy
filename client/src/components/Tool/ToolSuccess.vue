<template>
    <div class="donemessagelarge">
        <p>
            Successfully queued <b>{{ toolName }}</b>. The status will be updated in the text box above.
        </p>
    </div>
</template>

<script>
export default {
    props: {
        jobDef: {
            type: Object,
            required: true,
        },
        jobResponse: {
            type: Object,
            required: true,
        },
        toolName: {
            type: String,
            required: true,
        },
    },
    computed: {
        inputs() {
            const inputs = [];
            const index = {};
            for (const i in this.jobDef.inputs) {
                const input = this.jobDef.inputs[i];
                if (input && Array.isArray(input.values)) {
                    for (const j of input.values) {
                        if (j.src && !index[j.id]) {
                            inputs.push(j);
                            index[j.id] = true;
                        }
                    }
                }
            }
            return inputs;
        },
        nInputs() {
            return this.inputs.length;
        },
        nOutputs() {
            return this.jobResponse && this.jobResponse.outputs ? this.jobResponse.outputs.length : 0;
        },
        nJobs() {
            return this.jobResponse && this.jobResponse.jobs ? this.jobResponse.jobs.length : 0;
        },
        nJobsText() {
            return this.nJobs > 1 ? `${this.njobs} jobs` : `1 job`;
        },
        nInputsText() {
            return this.nInputs > 1 ? `${this.nInputs} inputs` : `this input`;
        },
        nOutputsText() {
            return this.nOutputs > 1 ? `${this.nOutputs} outputs` : `this output`;
        },
    },
};
</script>
