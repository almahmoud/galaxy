/** Query parameter parsing with the rules of Galaxy's FastAPI routes and legacy controllers. */

import { ApiError } from "./errors";

const TRUE_VALUES = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_VALUES = new Set(["0", "off", "f", "false", "n", "no"]);

/**
 * Reads a boolean query parameter the way FastAPI does. An absent or empty value gives `fallback`.
 *
 * @throws ApiError 400 for values pydantic would reject
 */
export function queryBool(query: URLSearchParams, name: string, fallback: boolean): boolean;
export function queryBool(query: URLSearchParams, name: string, fallback: boolean | null): boolean | null;
export function queryBool(query: URLSearchParams, name: string, fallback: boolean | null): boolean | null {
    const raw = query.get(name);
    if (raw === null || raw === "") {
        return fallback;
    }
    const value = raw.trim().toLowerCase();
    if (TRUE_VALUES.has(value)) {
        return true;
    }
    if (FALSE_VALUES.has(value)) {
        return false;
    }
    throw ApiError.badRequest(`Input should be a valid boolean, unable to interpret input in ('query', '${name}')`);
}

/**
 * Reads an integer query parameter the way FastAPI does. An absent or empty value gives `fallback`.
 *
 * @throws ApiError 400 when the value is not an integer or is below `min`
 */
export function queryInt(query: URLSearchParams, name: string, fallback: number, min?: number): number;
export function queryInt(query: URLSearchParams, name: string, fallback: number | null, min?: number): number | null;
export function queryInt(query: URLSearchParams, name: string, fallback: number | null, min?: number): number | null {
    const raw = query.get(name);
    if (raw === null || raw === "") {
        return fallback;
    }
    if (!/^\s*[+-]?\d+\s*$/.test(raw)) {
        throw ApiError.badRequest(
            `Input should be a valid integer, unable to parse string as an integer in ('query', '${name}')`,
        );
    }
    const value = Number.parseInt(raw, 10);
    if (min !== undefined && value < min) {
        throw ApiError.badRequest(`Input should be greater than or equal to ${min} in ('query', '${name}')`);
    }
    return value;
}

/** Galaxy's `util.string_as_bool`, used by legacy controllers: anything but these values is false. */
export function stringAsBool(value: string | null | undefined): boolean {
    return ["true", "yes", "on", "1"].includes(String(value ?? "").toLowerCase());
}
