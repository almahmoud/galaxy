/**
 * Kubernetes API client for the Planet gateway, usable from pages, dedicated workers and the Service Worker.
 *
 * Failures throw KubeError with the API Status reason; a request the browser could not complete
 * (network, CORS, mixed content or local network access) has reason "network_blocked".
 */
export {
    createKubeClient,
    type DeleteJobOptions,
    type EventListOptions,
    type FetchFunction,
    type KubeClient,
    type KubeClientConfig,
    type KubeClientOptions,
    type KubeRequestOptions,
    missingPermissions,
    parseWarningHeader,
    type PodLogOptions,
    REQUIRED_PERMISSIONS,
    rulesAllow,
    type RulesReviewResult,
    type WatchHandler,
    type WatchOptions,
    type WatchResult,
} from "./client";
export { isExpired, isKubeError, KubeError } from "./errors";
export type * from "./types";
export { LineDecoder, parseWatchEvent } from "./watch";
