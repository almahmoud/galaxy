import "./boot.css";

import { boot } from "./gate";

declare const __PLANET_BUILD_ID__: string;

// Both accessors throw a SecurityError in some browsers when site data is blocked.
function serviceWorkerContainer(): ServiceWorkerContainer | undefined {
    try {
        // eslint-disable-next-line compat/compat -- feature-detected; browsers without it get the failure page
        return "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
    } catch {
        return undefined;
    }
}

function sessionStore(): Storage | undefined {
    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

void boot({
    buildId: __PLANET_BUILD_ID__,
    document,
    container: serviceWorkerContainer(),
    storage: sessionStore(),
    fetch: window.fetch.bind(window),
    reload: () => window.location.reload(),
});
