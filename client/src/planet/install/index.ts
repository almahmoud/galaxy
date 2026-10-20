/**
 * Tool installation from the Tool Shed and GitHub, done by install pods (`planet-stager install`, kind
 * `tool_install`): the browser checks sources, dispatches the job, then verifies and stores what the pod installed.
 * It never reads or evaluates tool XML (architecture invariant 1).
 */

export * from "./github";
export { ingestToolInstall } from "./ingest";
export { INSTALL_SLOT_COUNT, installSlotKeys, isInstalledArchiveKey } from "./keys";
export * from "./source";
export * from "./toolshed";
export * from "./views";
