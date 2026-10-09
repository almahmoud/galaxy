import { openDB } from "idb";

import { newInstanceId } from "@/planet/util/ids";

import { migrate } from "./migrations";
import { buildHistory, defaultSettings } from "./records";
import { DB_NAME, DB_VERSION, type PlanetDB, type PlanetDBSchema, SECRETS_KEY, SETTINGS_KEY } from "./schema";
import { runTransaction } from "./transaction";
import type { HistoryRecord, PlanetSecrets } from "./types";

let connection: Promise<PlanetDB> | null = null;

/**
 * Opens the `planet` database once per context, running migrations and the first-run bootstrap.
 * The connection closes itself when another context upgrades the database; the next call reopens it.
 */
export function getDb(): Promise<PlanetDB> {
    if (!connection) {
        const opening: Promise<PlanetDB> = open(() => {
            if (connection === opening) {
                connection = null;
            }
        });
        connection = opening;
        opening.catch(() => {
            if (connection === opening) {
                connection = null;
            }
        });
    }
    return connection;
}

/** Closes this context's connection. The next {@link getDb} call reopens it. */
export async function closeDb(): Promise<void> {
    const current = connection;
    connection = null;
    if (current) {
        try {
            (await current).close();
        } catch {
            // The open failed; nothing to close.
        }
    }
}

async function open(onClosed: () => void): Promise<PlanetDB> {
    const db = await openDB<PlanetDBSchema>(DB_NAME, DB_VERSION, {
        upgrade(database, oldVersion, newVersion, transaction) {
            migrate(database, transaction, oldVersion, newVersion ?? DB_VERSION);
        },
        blocked(currentVersion, blockedVersion) {
            console.warn(
                `Planet database upgrade from version ${currentVersion} to ${blockedVersion} is waiting for other tabs to close it`,
            );
        },
        blocking(_currentVersion, _blockedVersion, event) {
            (event.target as IDBDatabase).close();
            onClosed();
        },
        terminated() {
            onClosed();
        },
    });
    try {
        await bootstrap(db);
    } catch (error) {
        db.close();
        throw error;
    }
    return db;
}

/**
 * Ensures settings, secrets and a current history exist. Creates them on first run; afterwards repairs a
 * missing or purged current history by selecting the most recently updated live history or creating one.
 */
export async function bootstrap(db: PlanetDB): Promise<void> {
    await runTransaction(db, ["settings", "secrets", "histories", "kv"], "readwrite", async (tx) => {
        const settings = tx.store("settings");
        if (!(await settings.get(SETTINGS_KEY))) {
            await settings.put(defaultSettings(newInstanceId()), SETTINGS_KEY);
        }
        const secrets = tx.store("secrets");
        if (!(await secrets.get(SECRETS_KEY))) {
            const empty: PlanetSecrets = { cluster_token: null, storage_secret_access_key: null };
            await secrets.put(empty, SECRETS_KEY);
        }
        const kv = tx.store("kv");
        const histories = tx.store("histories");
        const currentId = await kv.get("current_history_id");
        const current = typeof currentId === "string" ? await histories.get(currentId) : undefined;
        if (current && !current.purged) {
            return;
        }
        let candidate: HistoryRecord | undefined;
        let cursor = await histories.index("update_time").openCursor(null, "prev");
        while (cursor) {
            if (!cursor.value.deleted && !cursor.value.archived) {
                candidate = cursor.value;
                break;
            }
            cursor = await cursor.continue();
        }
        if (!candidate) {
            candidate = buildHistory({}, tx.now);
            await histories.put(candidate);
        }
        await kv.put(candidate.id, "current_history_id");
        tx.notify({ type: "current-history-changed", historyId: candidate.id });
    });
}
