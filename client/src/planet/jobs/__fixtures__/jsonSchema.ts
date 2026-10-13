/**
 * A JSON Schema (draft 2020-12) validator for the keywords the job protocol schemas use, so tests can check
 * documents against planet/runtime/schemas without a schema library. `format` is an annotation, as in the
 * runtime's `jsonschema` validation.
 */

type Schema = boolean | Record<string, unknown>;

/** Keywords this validator applies. */
const ASSERTIONS = new Set([
    "$ref",
    "type",
    "const",
    "enum",
    "required",
    "properties",
    "additionalProperties",
    "items",
    "oneOf",
    "allOf",
    "if",
    "then",
    "else",
    "minimum",
    "minLength",
    "pattern",
]);
/** Keywords without effect on validation. */
const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description", "format", "default", "examples"]);

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeMatches(value: unknown, type: string): boolean {
    switch (type) {
        case "null":
            return value === null;
        case "boolean":
            return typeof value === "boolean";
        case "string":
            return typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return Number.isInteger(value);
        case "array":
            return Array.isArray(value);
        case "object":
            return isObject(value);
        default:
            throw new Error(`Unknown type ${type}`);
    }
}

function equal(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export class SchemaValidator {
    constructor(private readonly root: Record<string, unknown>) {}

    /** Returns the validation errors of `value` as `<path>: <message>`. */
    validate(value: unknown): string[] {
        const errors: string[] = [];
        this.check(this.root, value, "", errors);
        return errors;
    }

    private resolve(ref: string): Schema {
        if (!ref.startsWith("#/")) {
            throw new Error(`Only local references are supported: ${ref}`);
        }
        let node: unknown = this.root;
        for (const part of ref.slice(2).split("/")) {
            node = (node as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
        }
        return node as Schema;
    }

    private valid(schema: Schema, value: unknown, path: string): boolean {
        const errors: string[] = [];
        this.check(schema, value, path, errors);
        return errors.length === 0;
    }

    private check(schema: Schema, value: unknown, path: string, errors: string[]): void {
        if (schema === true) {
            return;
        }
        if (schema === false) {
            errors.push(`${path}: no value is allowed`);
            return;
        }
        for (const keyword of Object.keys(schema)) {
            if (!ASSERTIONS.has(keyword) && !ANNOTATIONS.has(keyword)) {
                throw new Error(`Unsupported schema keyword ${keyword} at ${path}`);
            }
        }
        if (typeof schema.$ref === "string") {
            this.check(this.resolve(schema.$ref), value, path, errors);
        }
        if (schema.type !== undefined) {
            const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
            if (!types.some((type) => typeMatches(value, type))) {
                errors.push(`${path}: expected ${types.join(" or ")}`);
                return;
            }
        }
        if ("const" in schema && !equal(value, schema.const)) {
            errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
        }
        if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(item, value))) {
            errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}`);
        }
        if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
            errors.push(`${path}: expected at least ${schema.minimum}`);
        }
        if (typeof value === "string") {
            if (typeof schema.minLength === "number" && [...value].length < schema.minLength) {
                errors.push(`${path}: shorter than ${schema.minLength}`);
            }
            if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
                errors.push(`${path}: does not match ${schema.pattern}`);
            }
        }
        if (isObject(value)) {
            const properties = isObject(schema.properties) ? (schema.properties as Record<string, Schema>) : {};
            for (const name of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
                if (!Object.hasOwn(value, name)) {
                    errors.push(`${path}: missing required property ${name}`);
                }
            }
            for (const [name, item] of Object.entries(value)) {
                if (Object.hasOwn(properties, name)) {
                    this.check(properties[name]!, item, `${path}/${name}`, errors);
                } else if (schema.additionalProperties !== undefined) {
                    this.check(schema.additionalProperties as Schema, item, `${path}/${name}`, errors);
                }
            }
        }
        if (Array.isArray(value) && schema.items !== undefined) {
            value.forEach((item, index) => this.check(schema.items as Schema, item, `${path}/${index}`, errors));
        }
        if (Array.isArray(schema.allOf)) {
            for (const item of schema.allOf as Schema[]) {
                this.check(item, value, path, errors);
            }
        }
        if (Array.isArray(schema.oneOf)) {
            const matching = (schema.oneOf as Schema[]).filter((item) => this.valid(item, value, path)).length;
            if (matching !== 1) {
                errors.push(`${path}: matches ${matching} of the oneOf alternatives`);
            }
        }
        if (schema.if !== undefined) {
            const branch = this.valid(schema.if as Schema, value, path) ? schema.then : schema.else;
            if (branch !== undefined) {
                this.check(branch as Schema, value, path, errors);
            }
        }
    }
}

/** Every keyword used in a schema document, `properties` names and `$defs` names excluded. */
export function schemaKeywords(schema: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(schema)) {
        schema.forEach((item) => schemaKeywords(item, out));
    } else if (isObject(schema)) {
        for (const [keyword, value] of Object.entries(schema)) {
            out.add(keyword);
            if ((keyword === "properties" || keyword === "$defs") && isObject(value)) {
                Object.values(value).forEach((item) => schemaKeywords(item, out));
            } else if (keyword !== "const" && keyword !== "enum" && keyword !== "examples" && keyword !== "default") {
                schemaKeywords(value, out);
            }
        }
    }
    return out;
}

export function isSupportedKeyword(keyword: string): boolean {
    return ASSERTIONS.has(keyword) || ANNOTATIONS.has(keyword);
}
