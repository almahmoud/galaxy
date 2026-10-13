/** GET /api/configuration, GET /api/version and GET /api/whoami. */

import type { Router } from "@/planet/sw/router";
import { BUILD_ID } from "@/planet/util/build";
import { ApiError, ErrorCodes } from "@/planet/util/errors";
import { loadStaticData } from "@/planet/util/staticData";

import { userSummary } from "./users";

/** Galaxy release this client is built from (`lib/galaxy/version`). */
export const GALAXY_VERSION_MAJOR = "26.2";
export const GALAXY_VERSION_MINOR = "dev0";

/** Galaxy's default `welcome_url`, where the build publishes Planet's welcome and setup page. */
export const WELCOME_URL = "/static/welcome.html";

/** Upload part size Planet's page-side multipart uploads use. */
export const CHUNK_UPLOAD_SIZE = 32 * 1024 * 1024;

/** Seconds since the epoch when this worker started (Galaxy's `server_starttime`). */
const STARTED_AT = Math.floor(Date.now() / 1000);

export type GalaxyConfig = Record<string, unknown>;

/**
 * Values Planet enforces whatever the generated configuration says: no accounts, Celery, notifications, quotas,
 * interactive tools, webhooks or object store selection; one local user.
 */
function planetOverrides(): GalaxyConfig {
    return {
        brand: "Planet",
        logo_url: "/",
        logo_src: "/static/favicon.svg",
        welcome_url: WELCOME_URL,
        is_admin_user: false,
        single_user: true,
        use_remote_user: true,
        enable_account_interface: false,
        allow_local_account_creation: false,
        enable_oidc: false,
        require_login: false,
        enable_quotas: false,
        enable_celery_tasks: false,
        enable_tool_requests: false,
        enable_notification_system: false,
        enable_sse_updates: false,
        interactivetools_enable: false,
        enable_webhooks: false,
        object_store_allows_id_selection: false,
        allow_user_dataset_purge: true,
        expose_dataset_path: true,
        chunk_upload_size: CHUNK_UPLOAD_SIZE,
        themes: {},
        server_starttime: STARTED_AT,
        version_major: GALAXY_VERSION_MAJOR,
        version_minor: GALAXY_VERSION_MINOR,
        version_extra: { planet_build: BUILD_ID },
    };
}

/** The configuration served by `/context` and `/api/configuration`: the generated file with Planet's overrides. */
export async function getConfiguration(): Promise<GalaxyConfig> {
    const generated = await loadStaticData<unknown>("config.json");
    if (typeof generated !== "object" || generated === null || Array.isArray(generated)) {
        throw new ApiError(500, "Planet configuration is malformed", ErrorCodes.CONFIG_ERROR);
    }
    return { ...(generated as GalaxyConfig), ...planetOverrides() };
}

/** Galaxy's `/api/version` payload. */
export function versionInfo(): { version_major: string; version_minor: string; extra: Record<string, string> } {
    return {
        version_major: GALAXY_VERSION_MAJOR,
        version_minor: GALAXY_VERSION_MINOR,
        extra: { planet_build: BUILD_ID },
    };
}

/** Splits Galaxy's comma-separated `keys` parameter. */
export function parseKeys(value: string | null): string[] | null {
    if (!value) {
        return null;
    }
    return value.split(",");
}

export function register(router: Router): void {
    router.route("/api/configuration", "get", async ({ query }) => {
        const view = query.get("view");
        if (view && view !== "all") {
            throw new ApiError(400, `unknown view - ${view}`, ErrorCodes.USER_REQUEST_INVALID_PARAMETER, {
                view,
                available_views: ["all"],
            });
        }
        const config = await getConfiguration();
        const keys = parseKeys(query.get("keys"));
        if (!keys) {
            return config;
        }
        const selected: GalaxyConfig = {};
        for (const key of keys) {
            if (Object.hasOwn(config, key)) {
                selected[key] = config[key];
            }
        }
        return selected;
    });

    router.route("/api/version", "get", () => versionInfo());

    router.route("/api/whoami", "get", () => userSummary());
}
