/**
 * GET /api/datatypes, /api/datatypes/types_and_mapping, /api/datatypes/mapping, /api/datatypes/sniffers,
 * /api/datatypes/converters, /api/datatypes/edam_*, /api/datatypes/visualizations, /api/datatypes/{datatype} and
 * /api/datatypes/{datatype}/visualizations.
 *
 * Every payload comes from the JSON the build generates from Galaxy's datatype registry
 * (`/static/planet/data/datatypes/`). This module also answers datatype class questions (`isA`) for dataset display.
 */

import type { components } from "@/api/schema";
import type { Router } from "@/planet/sw/router";
import { ApiError } from "@/planet/util/errors";
import { queryBool } from "@/planet/util/query";
import { loadOptionalStaticData, loadStaticData } from "@/planet/util/staticData";

type DatatypeDetails = components["schemas"]["DatatypeDetails"];
type DatatypesMap = components["schemas"]["DatatypesMap"];
type DatatypeConverterList = components["schemas"]["DatatypeConverterList"];
type DatatypeVisualizationMappingsList = components["schemas"]["DatatypeVisualizationMappingsList"];
type DatatypesEDAMDetailsDict = components["schemas"]["DatatypesEDAMDetailsDict"];

/** `GET /api/datatypes/{datatype}` as written to `details.json`. */
export interface DatatypeShow {
    extension: string;
    description: string | null;
    display_in_upload: boolean;
    mimetype: string | null;
    is_binary: boolean | "maybe";
    display_behavior: string | null;
    composite_files?: { name: string; [key: string]: unknown }[];
    edam_format?: string;
    edam_data?: string;
    converters?: string[];
    preferred_visualization?: { visualization: string };
}

// ---------------------------------------------------------------------------------------------------------
// Datatype classes

/** Galaxy datatype classes the display code branches on. */
export const DatatypeClass = {
    DATA: "galaxy.datatypes.data.Data",
    TEXT: "galaxy.datatypes.data.Text",
    TABULAR_DATA: "galaxy.datatypes.tabular.TabularData",
    SRA_MANIFEST: "galaxy.datatypes.tabular.SraManifest",
    SEQUENCE: "galaxy.datatypes.sequence.Sequence",
    HTML: "galaxy.datatypes.text.Html",
    BINARY: "galaxy.datatypes.binary.Binary",
    GZIP: "galaxy.datatypes.binary.GzDynamicCompressedArchive",
    IMAGE: "galaxy.datatypes.images.Image",
} as const;

/** What the registry knows about one extension. */
export interface DatatypeInfo {
    extension: string;
    /** Implementing class, `galaxy.datatypes.data.Data` for unknown extensions. */
    className: string;
    /** `/api/datatypes/{extension}`, or undefined for unknown extensions. */
    details: DatatypeShow | undefined;
    /** True when the class is `cls` or derives from it. */
    isA(cls: string): boolean;
}

/** Returns the registry's view of `extension` (Galaxy falls back to `Data` for unknown extensions). */
export async function getDatatype(extension: string): Promise<DatatypeInfo> {
    const [mapping, details] = await Promise.all([
        loadStaticData<DatatypesMap>("datatypes/mapping.json"),
        loadStaticData<Record<string, DatatypeShow>>("datatypes/details.json"),
    ]);
    const known = Object.hasOwn(mapping.ext_to_class_name, extension);
    const className = known ? mapping.ext_to_class_name[extension]! : DatatypeClass.DATA;
    const classes = new Set(Object.keys(mapping.class_to_classes[className] ?? { [className]: true }));
    classes.add(className);
    return {
        extension,
        className,
        details: Object.hasOwn(details, extension) ? details[extension] : undefined,
        isA: (cls) => classes.has(cls),
    };
}

/** Every registered extension with its `/api/datatypes/{datatype}` payload, in registry order. */
export function getAllDatatypeDetails(): Promise<Record<string, DatatypeShow>> {
    return loadStaticData<Record<string, DatatypeShow>>("datatypes/details.json");
}

// ---------------------------------------------------------------------------------------------------------
// Handlers

async function datatypeIndex(extensionOnly: boolean, uploadOnly: boolean): Promise<DatatypeDetails[] | string[]> {
    if (extensionOnly) {
        if (uploadOnly) {
            return loadStaticData<string[]>("datatypes/extensions.json");
        }
        const all = await loadOptionalStaticData<string[]>("datatypes/extensions_all.json");
        return all ?? Object.keys(await getAllDatatypeDetails());
    }
    if (uploadOnly) {
        return (
            (await loadOptionalStaticData<DatatypeDetails[]>("datatypes/index.json")) ??
            loadStaticData<DatatypeDetails[]>("datatypes/upload.json")
        );
    }
    return (
        (await loadOptionalStaticData<DatatypeDetails[]>("datatypes/index_all.json")) ??
        loadStaticData<DatatypeDetails[]>("datatypes/index.json")
    );
}

async function visualizationMappings(): Promise<Record<string, DatatypeVisualizationMappingsList>> {
    return (
        (await loadOptionalStaticData<Record<string, DatatypeVisualizationMappingsList>>(
            "datatypes/visualizations.json",
        )) ?? {}
    );
}

export function register(router: Router): void {
    router.route("/api/datatypes", "get", ({ query }) =>
        datatypeIndex(queryBool(query, "extension_only", true), queryBool(query, "upload_only", true)),
    );

    router.route("/api/datatypes/types_and_mapping", "get", async ({ query }) => {
        const [datatypes, mapping] = await Promise.all([
            datatypeIndex(queryBool(query, "extension_only", true), queryBool(query, "upload_only", true)),
            loadStaticData<DatatypesMap>("datatypes/mapping.json"),
        ]);
        return { datatypes: datatypes as string[], datatypes_mapping: mapping };
    });

    router.route("/api/datatypes/mapping", "get", () => loadStaticData<DatatypesMap>("datatypes/mapping.json"));

    router.route("/api/datatypes/sniffers", "get", () => loadStaticData<string[]>("datatypes/sniffers.json"));

    router.route("/api/datatypes/converters", "get", () =>
        loadStaticData<DatatypeConverterList>("datatypes/converters.json"),
    );

    router.route("/api/datatypes/edam_formats", "get", () =>
        loadStaticData<Record<string, string>>("datatypes/edam_formats.json"),
    );

    router.route("/api/datatypes/edam_formats/detailed", "get", () =>
        loadStaticData<DatatypesEDAMDetailsDict>("datatypes/edam_formats_detailed.json"),
    );

    router.route("/api/datatypes/edam_data", "get", () =>
        loadStaticData<Record<string, string>>("datatypes/edam_data.json"),
    );

    router.route("/api/datatypes/edam_data/detailed", "get", () =>
        loadStaticData<DatatypesEDAMDetailsDict>("datatypes/edam_data_detailed.json"),
    );

    // Galaxy has no such route (the request falls through to `show` and 404s); the client calls it for the
    // full mapping list, which is what Galaxy's view_visualization_mappings returns without a datatype.
    router.untyped("/api/datatypes/visualizations", "get", async () =>
        Object.values(await visualizationMappings()).flat(),
    );

    router.route("/api/datatypes/{datatype}/visualizations", "get", async ({ params }) => {
        const mappings = await visualizationMappings();
        return Object.hasOwn(mappings, params.datatype) ? mappings[params.datatype]! : [];
    });

    router.route("/api/datatypes/{datatype}", "get", async ({ params }) => {
        const details = await getAllDatatypeDetails();
        if (!Object.hasOwn(details, params.datatype)) {
            throw ApiError.notFound(`Datatype '${params.datatype}' not found`);
        }
        return details[params.datatype];
    });
}
