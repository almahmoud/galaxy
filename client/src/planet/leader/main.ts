/**
 * Entry of `/static/dist/planet-leader.bundled.js`, which the boot gate loads in top-level index.html pages after
 * Galaxy's bundles. Every Planet tab joins the job leader election; the leader runs the job manager.
 */

import { ingestFailure, ingestResults, readPrepare } from "@/planet/jobs/ingest";
import { CHANNEL_NAME } from "@/planet/jobs/leader";
import { abortDispatch, adoptDispatch, prepareDispatch } from "@/planet/jobs/manifest";

import { LeaderHost } from "./host";

function start(): void {
    // eslint-disable-next-line compat/compat -- feature-detected below
    const locks = typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined;
    if (!locks || typeof BroadcastChannel !== "function") {
        console.warn("Planet: this browser lacks Web Locks or BroadcastChannel; this tab will not run jobs.");
        return;
    }
    const host = new LeaderHost({
        window,
        locks,
        channel: new BroadcastChannel(CHANNEL_NAME),
        protocol: { prepareDispatch, adoptDispatch, abortDispatch, ingestResults, readPrepare, ingestFailure },
    });
    host.start();
}

start();
