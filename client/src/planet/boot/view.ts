/**
 * Static DOM for the boot gate: start-up status, failure page and update banner.
 * Built with textContent only; nothing here interprets HTML.
 */

export type FailureReason =
    | "unsupported"
    | "registration-failed"
    | "activation-failed"
    | "not-controlled"
    | "load-failed";

interface FailureCopy {
    title: string;
    body: string;
    reloadable: boolean;
}

const SW_REQUIRED = "Service workers are required";

export const FAILURE_COPY: Record<FailureReason, FailureCopy> = {
    unsupported: {
        title: SW_REQUIRED,
        body:
            "Planet runs Galaxy inside your browser and needs service workers, which are not available here. " +
            "Browsers disable them in some private windows, when site data is blocked, and on pages not served over HTTPS.",
        reloadable: false,
    },
    "registration-failed": {
        title: SW_REQUIRED,
        body: "Planet could not register its service worker.",
        reloadable: true,
    },
    "activation-failed": {
        title: SW_REQUIRED,
        body: "Planet's service worker did not start.",
        reloadable: true,
    },
    "not-controlled": {
        title: SW_REQUIRED,
        body:
            "This page was loaded without Planet's service worker, which happens after a forced reload " +
            "(Shift+Reload or Ctrl+F5). Reload the page normally to continue.",
        reloadable: true,
    },
    "load-failed": {
        title: "Planet could not start",
        body: "Some application files failed to load. Check your connection and reload the page.",
        reloadable: true,
    },
};

const BANNER_ID = "planet-update-banner";

function mountPoint(doc: Document): HTMLElement {
    return doc.getElementById("app") ?? doc.body;
}

export function renderStatus(doc: Document, text: string): void {
    const status = doc.createElement("p");
    status.className = "planet-boot-status";
    status.setAttribute("role", "status");
    status.textContent = text;
    mountPoint(doc).replaceChildren(status);
}

export function clearStatus(doc: Document): void {
    for (const status of doc.querySelectorAll(".planet-boot-status")) {
        status.remove();
    }
}

export function renderFailure(doc: Document, reason: FailureReason, detail: string | null, onReload: () => void): void {
    const copy = FAILURE_COPY[reason];
    const section = doc.createElement("section");
    section.className = "planet-boot-message";
    section.setAttribute("role", "alert");
    section.setAttribute("aria-labelledby", "planet-boot-title");
    section.dataset.reason = reason;

    const title = doc.createElement("h1");
    title.id = "planet-boot-title";
    title.tabIndex = -1;
    title.textContent = copy.title;

    const body = doc.createElement("p");
    body.textContent = copy.body;
    section.append(title, body);

    if (detail) {
        const detailText = doc.createElement("p");
        detailText.className = "planet-boot-detail";
        detailText.textContent = detail;
        section.append(detailText);
    }

    if (copy.reloadable) {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = "planet-boot-button";
        button.textContent = "Reload";
        button.addEventListener("click", onReload);
        section.append(button);
    }

    mountPoint(doc).replaceChildren(section);
    title.focus();
}

export interface BannerActions {
    onReload: () => void;
}

/** Shows the update banner once; later calls leave the existing banner in place. */
export function showUpdateBanner(doc: Document, actions: BannerActions): HTMLElement {
    const existing = doc.getElementById(BANNER_ID);
    if (existing) {
        return existing;
    }
    const banner = doc.createElement("div");
    banner.id = BANNER_ID;
    banner.className = "planet-update-banner";
    banner.setAttribute("role", "status");

    const text = doc.createElement("span");
    text.textContent = "A new version of Planet is available.";

    const reload = doc.createElement("button");
    reload.type = "button";
    reload.className = "planet-boot-button";
    reload.textContent = "Reload";
    reload.addEventListener("click", () => {
        reload.disabled = true;
        actions.onReload();
    });

    const dismiss = doc.createElement("button");
    dismiss.type = "button";
    dismiss.className = "planet-update-banner__dismiss";
    dismiss.setAttribute("aria-label", "Dismiss update notice");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => banner.remove());

    banner.append(text, reload, dismiss);
    doc.body.append(banner);
    return banner;
}
