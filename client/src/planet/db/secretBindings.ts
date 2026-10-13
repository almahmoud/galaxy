/**
 * Settings each stored secret belongs to. Changing one of them removes the secret unless the same change supplies
 * a new one: the cluster token is sent as is to the gateway URL, and a secret access key belongs to one access key
 * of one storage service. Shared by the settings store, the connection checks and the setup page.
 */

import type { StoredSettings } from "./types";

type ClusterSettings = StoredSettings["cluster"];
type StorageSettings = StoredSettings["storage"];

const TOKEN_BINDING: readonly (keyof ClusterSettings)[] = ["gateway_url"];

const SECRET_BINDING: readonly (keyof StorageSettings)[] = ["endpoint", "cluster_endpoint", "bucket", "access_key_id"];

/** True when `change` gives one of `keys` a value other than the stored one. */
function rebinds<T extends object>(change: Partial<T> | undefined, stored: T, keys: readonly (keyof T)[]): boolean {
    return keys.some((key) => change?.[key] !== undefined && change[key] !== stored[key]);
}

/** True when `change` moves the cluster token to another gateway. */
export function rebindsToken(change: Partial<ClusterSettings> | undefined, stored: ClusterSettings): boolean {
    return rebinds(change, stored, TOKEN_BINDING);
}

/** True when `change` points the secret access key at another service, bucket or access key. */
export function rebindsSecret(change: Partial<StorageSettings> | undefined, stored: StorageSettings): boolean {
    return rebinds(change, stored, SECRET_BINDING);
}
