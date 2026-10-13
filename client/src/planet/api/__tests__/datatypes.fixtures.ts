/**
 * A small datatype registry, in the shape of the build's `/static/planet/data/datatypes/` files, for the datatype,
 * dataset and collection handler tests.
 */

const DATA = "galaxy.datatypes.data.Data";
const TEXT = "galaxy.datatypes.data.Text";
const TABULAR_DATA = "galaxy.datatypes.tabular.TabularData";
const TABULAR = "galaxy.datatypes.tabular.Tabular";
const BINARY = "galaxy.datatypes.binary.Binary";
const IMAGE = "galaxy.datatypes.images.Image";
const GZIP = [
    "galaxy.datatypes.binary.GzDynamicCompressedArchive",
    "galaxy.datatypes.binary.CompressedArchive",
    BINARY,
];

/** Extension: [class, ancestors (excluding itself and Data), mimetype, display in upload]. */
const REGISTRY: Record<string, [string, string[], string | null, boolean]> = {
    data: [DATA, [], "application/octet-stream", false],
    txt: [TEXT, [], "text/plain", true],
    tabular: [TABULAR, [TABULAR_DATA, TEXT], "text/plain", true],
    "tabular.gz": ["galaxy.datatypes.registry.TabularGz", [TABULAR, TABULAR_DATA, TEXT, ...GZIP], null, true],
    csv: ["galaxy.datatypes.tabular.CSV", ["galaxy.datatypes.tabular.BaseCSV", TABULAR_DATA, TEXT], "text/csv", true],
    bed: [
        "galaxy.datatypes.interval.Bed",
        ["galaxy.datatypes.interval.Interval", TABULAR, TABULAR_DATA, TEXT],
        null,
        true,
    ],
    "sra_manifest.tabular": ["galaxy.datatypes.tabular.SraManifest", [TABULAR, TABULAR_DATA, TEXT], null, true],
    vcf_bgzip: [
        "galaxy.datatypes.tabular.VcfGz",
        ["galaxy.datatypes.tabular.BaseVcf", TABULAR, TABULAR_DATA, TEXT, BINARY],
        "text/plain",
        true,
    ],
    html: ["galaxy.datatypes.text.Html", [TEXT], "text/html", false],
    obo: ["galaxy.datatypes.text.Obo", [TEXT], "text/html", true],
    xml: ["galaxy.datatypes.xml.GenericXml", [TEXT], "application/xml", true],
    svg: ["galaxy.datatypes.registry.Svg", ["galaxy.datatypes.xml.GenericXml", TEXT], "image/svg+xml", false],
    json: ["galaxy.datatypes.text.Json", [TEXT], "application/json", true],
    fasta: ["galaxy.datatypes.sequence.Fasta", ["galaxy.datatypes.sequence.Sequence", TEXT], null, true],
    "fastqsanger.gz": [
        "galaxy.datatypes.registry.FastqSangerGz",
        ["galaxy.datatypes.sequence.FastqSanger", "galaxy.datatypes.sequence.Sequence", TEXT, ...GZIP],
        null,
        true,
    ],
    bam: [
        "galaxy.datatypes.binary.Bam",
        ["galaxy.datatypes.binary.BamNative", ...GZIP.slice(1)],
        "application/octet-stream",
        true,
    ],
    png: ["galaxy.datatypes.images.Png", [IMAGE], "image/png", true],
    pdf: ["galaxy.datatypes.images.Pdf", [IMAGE], "application/pdf", true],
    affybatch: [
        "galaxy.datatypes.genetics.Affybatch",
        ["galaxy.datatypes.genetics.RexpBase", "galaxy.datatypes.text.Html", TEXT],
        "text/html",
        false,
    ],
};

const BINARY_EXTENSIONS = new Set(["data", "bam", "png", "pdf", "tabular.gz", "fastqsanger.gz"]);

export const MAPPING = {
    ext_to_class_name: Object.fromEntries(Object.entries(REGISTRY).map(([ext, [cls]]) => [ext, cls])),
    class_to_classes: Object.fromEntries(
        Object.values(REGISTRY).map(([cls, ancestors]) => [
            cls,
            Object.fromEntries([cls, ...ancestors, DATA].map((name) => [name, true])),
        ]),
    ),
};

export const DETAILS = Object.fromEntries(
    Object.entries(REGISTRY).map(([ext, [, , mimetype, upload]]) => {
        const details: Record<string, unknown> = {
            extension: ext,
            description: `${ext} description`,
            display_in_upload: upload,
            mimetype,
            is_binary: BINARY_EXTENSIONS.has(ext),
            display_behavior: BINARY_EXTENSIONS.has(ext) ? "download" : "inline",
        };
        if (ext === "affybatch") {
            details.composite_files = [{ name: "%s.affybatch", optional: false }];
        }
        if (ext === "tabular") {
            details.converters = ["tabular.gz"];
        }
        return [ext, details];
    }),
);

const UPLOAD_EXTENSIONS = Object.keys(DETAILS).filter((ext) => DETAILS[ext]!.display_in_upload);

function infoDict(ext: string) {
    return {
        extension: ext,
        description: `${ext} description`,
        description_url: null,
        display_in_upload: DETAILS[ext]!.display_in_upload,
        display_behavior: DETAILS[ext]!.display_behavior,
    };
}

export const VISUALIZATIONS = {
    ...Object.fromEntries(Object.keys(DETAILS).map((ext) => [ext, []])),
    bam: [{ datatype: "bam", visualization: "igv" }],
    png: [{ datatype: "png", visualization: "image" }],
};

/** The datatype files, keyed by request path. */
export const DATATYPE_FILES: Record<string, unknown> = {
    "/static/planet/data/datatypes/mapping.json": MAPPING,
    "/static/planet/data/datatypes/details.json": DETAILS,
    "/static/planet/data/datatypes/extensions.json": UPLOAD_EXTENSIONS,
    "/static/planet/data/datatypes/extensions_all.json": Object.keys(DETAILS),
    "/static/planet/data/datatypes/index.json": UPLOAD_EXTENSIONS.map(infoDict),
    "/static/planet/data/datatypes/upload.json": UPLOAD_EXTENSIONS.map(infoDict),
    "/static/planet/data/datatypes/index_all.json": Object.keys(DETAILS).map(infoDict),
    "/static/planet/data/datatypes/sniffers.json": ["bam", "fasta", "tabular"],
    "/static/planet/data/datatypes/converters.json": [
        { source: "tabular", target: "tabular.gz", tool_id: "CONVERTER_uncompressed_to_gz" },
    ],
    "/static/planet/data/datatypes/edam_formats.json": { bam: "format_2572", fasta: "format_1929" },
    "/static/planet/data/datatypes/edam_formats_detailed.json": {
        bam: { prefix_IRI: "format_2572", label: "BAM", definition: "BAM format." },
    },
    "/static/planet/data/datatypes/edam_data.json": { bam: "data_0863" },
    "/static/planet/data/datatypes/edam_data_detailed.json": {
        bam: { prefix_IRI: "data_0863", label: "Sequence alignment", definition: "An alignment." },
    },
    "/static/planet/data/datatypes/visualizations.json": VISUALIZATIONS,
};
