/** Service Worker entry, built as the classic script `/sw.js` with scope `/`. */

import { registerAll } from "@/planet/api";

import { Router } from "./router";
import type { ServiceWorkerScopeLike } from "./types";
import { installServiceWorker } from "./worker";

const router = new Router();
registerAll(router);

installServiceWorker(globalThis as unknown as ServiceWorkerScopeLike, {
    buildId: __PLANET_BUILD_ID__,
    router,
});
