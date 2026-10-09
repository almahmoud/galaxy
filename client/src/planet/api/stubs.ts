/**
 * Fixed replies for Galaxy features Planet does not provide (yet). Each answers with the empty value of the
 * route's schema type, so panels that load at startup or from the activity bar render empty lists rather than
 * errors: webhooks, object stores and their templates and instances, file sources, invocations, workflows, pages,
 * visualizations, plugins, tours, recent exports, remote files, libraries, licenses, quotas, notifications and broadcasts,
 * interactive tool entry points, the help forum and Tool Shed repositories. `/api/unprivileged_tools` answers 403,
 * which the client treats as "custom tools not available" without an error toast.
 *
 * Paths not listed here, such as single workflows, pages or invocations, fall through to the router's 404.
 */

import { json } from "@/planet/sw/responses";
import type { Router } from "@/planet/sw/router";
import { ApiError, ErrorCodes } from "@/planet/util/errors";

/** An empty list with Galaxy's `total_matches: 0` header, for paginated grids. */
function emptyPage() {
    return json([], { headers: { total_matches: "0" } });
}

export function register(router: Router): void {
    router.untyped("/api/webhooks", "get", () => []);
    router.untyped("/api/entry_points", "get", () => []);

    router.route("/api/object_stores", "get", () => []);
    router.route("/api/object_store_instances", "get", () => []);
    router.route("/api/object_store_templates", "get", () => []);
    router.route("/api/file_source_instances", "get", () => []);
    router.route("/api/file_source_templates", "get", () => []);
    router.route("/api/remote_files/plugins", "get", () => []);
    router.route("/api/remote_files", "get", () => []);

    router.route("/api/unprivileged_tools", "get", () => {
        throw ApiError.forbidden(
            "User-defined tools are not available in Planet.",
            ErrorCodes.INSUFFICIENT_PERMISSIONS,
        );
    });

    router.route("/api/invocations", "get", emptyPage);
    router.route("/api/workflows", "get", emptyPage);
    router.route("/api/workflows/menu", "get", () => ({ ids_in_menu: [], workflows: [] }));
    router.route("/api/workflows/curated", "get", () => ({
        source: "unavailable" as const,
        total_matches: 0,
        workflows: [],
        collections: [],
        message: "Workflows are not available in Planet yet.",
    }));
    router.route("/api/pages", "get", emptyPage);
    router.route("/api/visualizations", "get", emptyPage);
    router.route("/api/plugins", "get", () => []);
    router.route("/api/tours", "get", () => []);
    router.route("/api/exports", "get", () => []);

    router.route("/api/libraries", "get", () => []);
    router.route("/api/licenses", "get", () => []);
    router.route("/api/quotas", "get", () => []);
    router.route("/api/tool_shed_repositories", "get", () => []);

    router.route("/api/notifications", "get", () => []);
    router.route("/api/notifications/status", "get", () => ({
        total_unread_count: 0,
        notifications: [],
        broadcasts: [],
    }));
    router.route("/api/notifications/broadcast", "get", () => []);
    router.route("/api/notifications/preferences", "get", () => ({ preferences: {} }));

    router.route("/api/help/forum/search", "get", () => ({
        topics: [],
        posts: [],
        users: [],
        categories: [],
        tags: [],
        groups: [],
        grouped_search_result: null,
    }));
}
