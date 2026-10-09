/** Installed and curated tool versions, and stored tool panel views. */

import { type ReadTx, useRead, useWrite, type WriteTx } from "./tx";
import type { ToolPanelRecord, ToolRecord } from "./types";

export type NewTool = Omit<ToolRecord, "create_time" | "update_time">;

/** Returns one tool version, or undefined. */
export function get(toolId: string, toolVersion: string, tx?: ReadTx): Promise<ToolRecord | undefined> {
    return useRead(tx, ["tools"], (t) => t.store("tools").get([toolId, toolVersion]));
}

/** Returns every stored version of a tool. */
export function listVersions(toolId: string, tx?: ReadTx): Promise<ToolRecord[]> {
    return useRead(tx, ["tools"], (t) => t.store("tools").index("tool_id").getAll(toolId));
}

/** Returns every stored tool version. */
export function list(tx?: ReadTx): Promise<ToolRecord[]> {
    return useRead(tx, ["tools"], (t) => t.store("tools").getAll());
}

/** Inserts or replaces a tool version, keeping its original `create_time`. */
export function put(tool: NewTool, tx?: WriteTx): Promise<ToolRecord> {
    return useWrite(tx, ["tools"], async (t) => {
        const store = t.store("tools");
        const existing = await store.get([tool.tool_id, tool.tool_version]);
        const record: ToolRecord = { ...tool, create_time: existing?.create_time ?? t.now, update_time: t.now };
        await store.put(record);
        t.notify({ type: "tools-changed" });
        return record;
    });
}

/** Removes a tool version. */
export function remove(toolId: string, toolVersion: string, tx?: WriteTx): Promise<void> {
    return useWrite(tx, ["tools"], async (t) => {
        await t.store("tools").delete([toolId, toolVersion]);
        t.notify({ type: "tools-changed" });
    });
}

/** Returns a stored tool panel view, or undefined. */
export function getPanel(viewId: string, tx?: ReadTx): Promise<ToolPanelRecord | undefined> {
    return useRead(tx, ["toolPanel"], (t) => t.store("toolPanel").get(viewId));
}

/** Stores a tool panel view. */
export function putPanel(viewId: string, panel: unknown, tx?: WriteTx): Promise<ToolPanelRecord> {
    return useWrite(tx, ["toolPanel"], async (t) => {
        const record: ToolPanelRecord = { view_id: viewId, panel, update_time: t.now };
        await t.store("toolPanel").put(record);
        t.notify({ type: "tools-changed" });
        return record;
    });
}
