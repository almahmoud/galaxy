/** Kubernetes API types, limited to the fields Planet reads or writes. */

export interface ObjectMeta {
    name?: string;
    generateName?: string;
    namespace?: string;
    uid?: string;
    resourceVersion?: string;
    generation?: number;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: OwnerReference[];
    finalizers?: string[];
}

export interface OwnerReference {
    apiVersion: string;
    kind: string;
    name: string;
    uid: string;
    controller?: boolean;
}

export interface ListMeta {
    resourceVersion?: string;
    continue?: string;
    remainingItemCount?: number;
}

export interface ObjectReference {
    apiVersion?: string;
    kind?: string;
    name?: string;
    namespace?: string;
    uid?: string;
    fieldPath?: string;
}

export interface ResourceRequirements {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
}

export interface EnvVar {
    name: string;
    value?: string;
    valueFrom?: { fieldRef?: { fieldPath: string; apiVersion?: string } };
}

export interface VolumeMount {
    name: string;
    mountPath: string;
    subPath?: string;
    readOnly?: boolean;
}

export interface SecurityContext {
    runAsUser?: number;
    runAsGroup?: number;
    runAsNonRoot?: boolean;
    allowPrivilegeEscalation?: boolean;
    readOnlyRootFilesystem?: boolean;
    privileged?: boolean;
    capabilities?: { add?: string[]; drop?: string[] };
    seccompProfile?: { type: "RuntimeDefault" | "Localhost" | "Unconfined"; localhostProfile?: string };
}

export interface PodSecurityContext {
    runAsUser?: number;
    runAsGroup?: number;
    runAsNonRoot?: boolean;
    fsGroup?: number;
    fsGroupChangePolicy?: "OnRootMismatch" | "Always";
    supplementalGroups?: number[];
    seccompProfile?: { type: "RuntimeDefault" | "Localhost" | "Unconfined"; localhostProfile?: string };
}

export interface Container {
    name: string;
    image: string;
    imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
    command?: string[];
    args?: string[];
    workingDir?: string;
    env?: EnvVar[];
    resources?: ResourceRequirements;
    volumeMounts?: VolumeMount[];
    securityContext?: SecurityContext;
    terminationMessagePath?: string;
    terminationMessagePolicy?: "File" | "FallbackToLogsOnError";
    /** "Always" on an init container makes it a sidecar. */
    restartPolicy?: "Always";
}

export interface Volume {
    name: string;
    emptyDir?: { medium?: "" | "Memory"; sizeLimit?: string };
    ephemeral?: {
        volumeClaimTemplate: {
            metadata?: ObjectMeta;
            spec: {
                accessModes: string[];
                storageClassName?: string;
                resources: { requests: { storage: string } };
            };
        };
    };
    configMap?: { name: string; items?: { key: string; path: string }[]; defaultMode?: number };
}

export interface Toleration {
    key?: string;
    operator?: "Exists" | "Equal";
    value?: string;
    effect?: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
    tolerationSeconds?: number;
}

export interface PodSpec {
    containers: Container[];
    initContainers?: Container[];
    volumes?: Volume[];
    restartPolicy?: "Never" | "OnFailure" | "Always";
    serviceAccountName?: string;
    automountServiceAccountToken?: boolean;
    enableServiceLinks?: boolean;
    hostUsers?: boolean;
    securityContext?: PodSecurityContext;
    nodeSelector?: Record<string, string>;
    tolerations?: Toleration[];
    terminationGracePeriodSeconds?: number;
    activeDeadlineSeconds?: number;
    priorityClassName?: string;
    nodeName?: string;
}

export interface PodTemplateSpec {
    metadata?: ObjectMeta;
    spec: PodSpec;
}

export interface PodFailurePolicyRule {
    action: "FailJob" | "Ignore" | "Count" | "FailIndex";
    onExitCodes?: { containerName?: string; operator: "In" | "NotIn"; values: number[] };
    onPodConditions?: { type: string; status?: "True" | "False" | "Unknown" }[];
}

export interface JobSpec {
    template: PodTemplateSpec;
    backoffLimit?: number;
    activeDeadlineSeconds?: number;
    ttlSecondsAfterFinished?: number;
    completions?: number;
    parallelism?: number;
    suspend?: boolean;
    podFailurePolicy?: { rules: PodFailurePolicyRule[] };
    podReplacementPolicy?: "Failed" | "TerminatingOrFailed";
}

export interface Condition {
    type: string;
    status: "True" | "False" | "Unknown";
    reason?: string;
    message?: string;
    lastTransitionTime?: string;
    lastProbeTime?: string;
}

/** Job condition types: Complete, Failed, FailureTarget, SuccessCriteriaMet, Suspended. */
export type JobCondition = Condition;

export interface JobStatus {
    active?: number;
    ready?: number;
    terminating?: number;
    succeeded?: number;
    failed?: number;
    startTime?: string;
    completionTime?: string;
    conditions?: JobCondition[];
}

export interface Job {
    apiVersion?: "batch/v1";
    kind?: "Job";
    metadata: ObjectMeta;
    spec?: JobSpec;
    status?: JobStatus;
}

export interface JobList {
    apiVersion?: string;
    kind?: "JobList";
    metadata: ListMeta;
    items: Job[];
}

export interface ContainerState {
    waiting?: { reason?: string; message?: string };
    running?: { startedAt?: string };
    terminated?: {
        exitCode: number;
        signal?: number;
        reason?: string;
        message?: string;
        startedAt?: string;
        finishedAt?: string;
        containerID?: string;
    };
}

export interface ContainerStatus {
    name: string;
    ready: boolean;
    restartCount: number;
    image: string;
    imageID: string;
    containerID?: string;
    started?: boolean;
    state?: ContainerState;
    lastState?: ContainerState;
}

export interface PodStatus {
    phase?: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
    reason?: string;
    message?: string;
    nodeName?: string;
    startTime?: string;
    conditions?: Condition[];
    initContainerStatuses?: ContainerStatus[];
    containerStatuses?: ContainerStatus[];
}

export interface Pod {
    apiVersion?: "v1";
    kind?: "Pod";
    metadata: ObjectMeta;
    spec?: PodSpec;
    status?: PodStatus;
}

export interface PodList {
    apiVersion?: string;
    kind?: "PodList";
    metadata: ListMeta;
    items: Pod[];
}

export interface KubeEvent {
    apiVersion?: "v1";
    kind?: "Event";
    metadata: ObjectMeta;
    involvedObject: ObjectReference;
    reason?: string;
    message?: string;
    type?: "Normal" | "Warning";
    count?: number;
    firstTimestamp?: string | null;
    lastTimestamp?: string | null;
    eventTime?: string | null;
    source?: { component?: string; host?: string };
    reportingComponent?: string;
}

export interface EventList {
    apiVersion?: string;
    kind?: "EventList";
    metadata: ListMeta;
    items: KubeEvent[];
}

export interface StatusCause {
    reason?: string;
    message?: string;
    field?: string;
}

export interface StatusDetails {
    name?: string;
    group?: string;
    kind?: string;
    uid?: string;
    causes?: StatusCause[];
    retryAfterSeconds?: number;
}

export interface Status {
    apiVersion?: "v1";
    kind: "Status";
    status?: "Success" | "Failure";
    message?: string;
    reason?: string;
    code?: number;
    details?: StatusDetails;
}

export interface DeleteOptions {
    apiVersion: "v1";
    kind: "DeleteOptions";
    propagationPolicy?: "Background" | "Foreground" | "Orphan";
    gracePeriodSeconds?: number;
    preconditions?: { uid?: string; resourceVersion?: string };
}

export interface ResourceRule {
    verbs: string[];
    apiGroups?: string[];
    resources?: string[];
    resourceNames?: string[];
}

export interface NonResourceRule {
    verbs: string[];
    nonResourceURLs?: string[];
}

export interface SelfSubjectRulesReview {
    apiVersion: "authorization.k8s.io/v1";
    kind: "SelfSubjectRulesReview";
    spec: { namespace: string };
    status?: {
        resourceRules: ResourceRule[];
        nonResourceRules: NonResourceRule[];
        incomplete: boolean;
        evaluationError?: string;
    };
}

export interface KubeVersion {
    major: string;
    minor: string;
    gitVersion: string;
    gitCommit?: string;
    buildDate?: string;
    goVersion?: string;
    platform?: string;
}

export type WatchEventType = "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";

/** BOOKMARK objects carry only kind, apiVersion and metadata.resourceVersion (and annotations). */
export type WatchEvent<T> =
    | { type: "ADDED" | "MODIFIED" | "DELETED"; object: T }
    | { type: "BOOKMARK"; object: { kind?: string; apiVersion?: string; metadata: ObjectMeta } }
    | { type: "ERROR"; object: Status };
