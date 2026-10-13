/**
 * What tool parameter handling works with: the request context (tool, history items, datatype registry, genome
 * builds), the scope parameters look other values up in (Galaxy's `ExpressionContext`), and parameter errors.
 */

import type { DatatypeInfo } from "@/planet/api/contents";
import type { DatatypeShow } from "@/planet/api/datatypes";

import type { ToolBundle } from "./bundle";
import { type HistorySnapshot, isHistoryItem } from "./history";
import { pyRepr } from "./python";

/** Data the request context reads from the build's static data. */
export interface StaticToolData {
    datatypes: DatatypeInfo;
    /** `/api/datatypes/{ext}` details by extension, for composite datatypes. */
    datatypeDetails: Readonly<Record<string, DatatypeShow>>;
    /** EDAM format and data terms by extension. */
    edamFormats: Readonly<Record<string, string>>;
    edamData: Readonly<Record<string, string>>;
    /** `[name, dbkey]` pairs of the genome builds. */
    genomes: readonly (readonly string[])[];
    /** `Registry.upload_file_formats`. */
    uploadFormats: readonly string[];
}

/** Galaxy's work request context for one tool: `trans` with the history and the datatype registry. */
export interface RequestContext extends StaticToolData {
    tool: ToolBundle;
    snapshot: HistorySnapshot;
    /** The site origin, for `baseurl` parameters and help links. */
    origin: string;
}

/** A tool state level: parameter names to values, without a prototype so any name is a plain key. */
export type StateDict = Record<string, unknown>;

/** A new empty {@link StateDict}. */
export function emptyDict(): StateDict {
    return Object.create(null) as StateDict;
}

/** Copies `entries` into a new {@link StateDict}. */
export function dictFrom(entries: Iterable<readonly [string, unknown]>): StateDict {
    const dict = emptyDict();
    for (const [key, value] of entries) {
        dict[key] = value;
    }
    return dict;
}

/** True when `value` is a plain object (a state level or a JSON object). */
export function isDict(value: unknown): value is StateDict {
    return typeof value === "object" && value !== null && !Array.isArray(value) && !isHistoryItem(value);
}

/** Reads an own property, or undefined. */
export function own(dict: unknown, key: string): unknown {
    return isDict(dict) && Object.hasOwn(dict, key) ? dict[key] : undefined;
}

/**
 * Galaxy's `ExpressionContext`: a state level that falls back to its parent levels, so a parameter can refer to the
 * values of its siblings and of the levels around its group.
 */
export class StateContext {
    constructor(
        readonly values: StateDict,
        readonly parent: StateContext | null = null,
    ) {}

    has(name: string): boolean {
        return Object.hasOwn(this.values, name) || (this.parent?.has(name) ?? false);
    }

    get(name: string): unknown {
        if (Object.hasOwn(this.values, name)) {
            return this.values[name];
        }
        return this.parent?.get(name);
    }

    /** `bool(ExpressionContext)`: false when this level and its parent are both empty. */
    get truthy(): boolean {
        return Object.keys(this.values).length > 0 || this.parent !== null;
    }

    /** Every value of this level, then of the parent levels. */
    *allValues(): Iterable<unknown> {
        yield* Object.values(this.values);
        if (this.parent) {
            yield* this.parent.allValues();
        }
    }
}

/** Galaxy's `ParameterValueError`: a value a parameter rejects. */
export class ParameterValueError extends Error {
    constructor(
        readonly suffix: string,
        readonly parameterName: string,
        readonly parameterValue: unknown = undefined,
        readonly isDynamic: boolean | null = null,
    ) {
        super(`Parameter '${parameterName}': ${suffix}`);
        this.name = "ParameterValueError";
    }

    /** `ParameterValueError.to_dict()`. */
    toDict(): Record<string, unknown> {
        const out: Record<string, unknown> = {
            message: this.message,
            message_suffix: this.suffix,
            parameter_name: this.parameterName,
        };
        if (this.parameterValue !== undefined && isJsonValue(this.parameterValue)) {
            out.parameter_value = this.parameterValue;
        }
        if (this.isDynamic !== null) {
            out.is_dynamic = this.isDynamic;
        }
        return out;
    }
}

/** Any other value Galaxy rejects with a plain `ValueError`. */
export class InputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InputError";
    }
}

function isJsonValue(value: unknown, depth = 0): boolean {
    if (depth > 32) {
        return false;
    }
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        return true;
    }
    if (Array.isArray(value)) {
        return value.every((item) => isJsonValue(item, depth + 1));
    }
    return isDict(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

/** `{value!r}` in Galaxy's messages. */
export function reprValue(value: unknown): string {
    return isHistoryItem(value) ? `<${value.src} ${value.id}>` : pyRepr(value);
}
