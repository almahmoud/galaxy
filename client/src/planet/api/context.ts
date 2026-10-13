/**
 * GET /context (the configuration and current user the client loads at startup) and GET /welcome (302 to the
 * configured welcome_url).
 */

import { redirect } from "@/planet/sw/responses";
import type { Router } from "@/planet/sw/router";

import { getConfiguration, WELCOME_URL } from "./configuration";
import { detailedUser } from "./users";

export function register(router: Router): void {
    router.route("/context", "get", async () => {
        const [config, user] = await Promise.all([getConfiguration(), detailedUser()]);
        return { config, user, session_csrf_token: "" };
    });

    // Planet fixes welcome_url, so the redirect does not wait for the configuration. The client loads it in a frame.
    router.untyped("/welcome", "get", () => redirect(WELCOME_URL), { navigable: true });
}
