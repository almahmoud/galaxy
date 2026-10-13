/**
 * Planet's job orchestration, run by the leader tab (`planet/leader/main.ts`): leader election, the outbox-driven
 * job manager, Kubernetes Job specs, container resolution, failure classification and dependency gating. The job
 * protocol (manifests, results) lives in `manifest.ts` and `ingest.ts`.
 */

export { ConsoleTails } from "./console";
export {
    ContainerResolutionError,
    type ContainerResolverOptions,
    mulledV2Name,
    resolveToolContainer,
    resolveToolImage,
} from "./containers";
export { classifyFailure, failedCreate, pendingFailure } from "./failures";
export { checkInputs, DEPENDENT_PAUSE_MESSAGE, pauseDependents, pauseJob, type Readiness } from "./gating";
export {
    buildJobSpec,
    DEFAULT_RUNTIME_IMAGE,
    instanceSelector,
    jobName,
    JobSpecError,
    runtimeImage,
    slotsAndMemory,
    specHash,
} from "./k8sJob";
export { type ChannelLike, LeaderElection, type LeaderElectionOptions, type LockManagerLike } from "./leader";
export { JobManager, type JobManagerOptions, type JobProtocol } from "./manager";
export { ClusterMonitor } from "./monitor";
