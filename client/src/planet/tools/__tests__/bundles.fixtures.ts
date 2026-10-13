/**
 * A synthetic tool bundle with every parameter and group type the tool engine handles, the datatype data it needs,
 * and the static files serving it, so the engine tests do not depend on the generated toolbox.
 */

import type {
    BundleConditional,
    BundleInput,
    BundleOutput,
    BundleParameter,
    BundleRepeat,
    BundleSection,
    ToolBundle,
} from "../bundle";
import { bundlePath } from "../bundle";

export const TOOL_ID = "toolshed.example.org/repos/planet/kitchen_sink/kitchen_sink/1.1";

const MODEL_CLASSES: Record<string, string> = {
    text: "TextToolParameter",
    integer: "IntegerToolParameter",
    float: "FloatToolParameter",
    boolean: "BooleanToolParameter",
    select: "SelectToolParameter",
    genomebuild: "GenomeBuildParameter",
    data_column: "ColumnListParameter",
    hidden: "HiddenToolParameter",
    color: "ColorToolParameter",
    data: "DataToolParameter",
    data_collection: "DataCollectionToolParameter",
    drill_down: "DrillDownSelectToolParameter",
};

export function param(type: string, name: string, fields: Partial<BundleParameter> = {}): BundleParameter {
    return {
        model_class: MODEL_CLASSES[type] ?? "ToolParameter",
        type,
        name,
        argument: null,
        label: fields.label ?? name,
        help: "",
        help_format: "html",
        hidden: type === "hidden",
        refresh_on_change: type === "data" || type === "data_collection",
        optional: false,
        is_dynamic: ["data", "data_collection", "data_column", "genomebuild"].includes(type),
        sanitizer: null,
        validators: [],
        ...fields,
    };
}

export function conditional(name: string, test: BundleParameter, cases: [string, BundleInput[]][]): BundleConditional {
    return {
        model_class: "Conditional",
        type: "conditional",
        name,
        value_ref: null,
        value_ref_in_group: true,
        value_from: null,
        test_param: { ...test, refresh_on_change: true },
        cases: cases.map(([value, inputs]) => ({ value, inputs })),
    };
}

export function repeat(name: string, inputs: BundleInput[], fields: Partial<BundleRepeat> = {}): BundleRepeat {
    return {
        model_class: "Repeat",
        type: "repeat",
        name,
        title: name,
        help: null,
        default: 1,
        min: 0,
        max: null,
        inputs,
        ...fields,
    };
}

export function section(name: string, inputs: BundleInput[], fields: Partial<BundleSection> = {}): BundleSection {
    return {
        model_class: "Section",
        type: "section",
        name,
        title: name,
        help: null,
        expanded: false,
        inputs,
        ...fields,
    };
}

export function output(name: string, fields: Partial<BundleOutput> = {}): BundleOutput {
    return {
        model_class: "ToolOutput",
        name,
        label: null,
        hidden: false,
        output_type: "data",
        format: "data",
        format_source: null,
        metadata_source: null,
        from_work_dir: null,
        filters: [],
        change_format: [],
        ...fields,
    };
}

/** A tool with data, column, select, number, text, boolean, genome, color and hidden parameters and every group. */
export function kitchenSinkBundle(version = "1.1"): ToolBundle {
    return {
        id: TOOL_ID.replace(/1\.1$/, version),
        old_id: "kitchen_sink",
        version,
        versions: ["1.0", "1.1"],
        name: "Kitchen sink",
        description: "for tests",
        profile: "23.0",
        model_class: "Tool",
        form_style: "regular",
        display_interface: true,
        is_workflow_compatible: true,
        has_parameters: true,
        license: "MIT",
        creator: [{ class: "Person", name: "Planet" }],
        citations: [{ type: "doi", content: "10.1000/x" }],
        help: {
            format: "restructuredtext",
            content: "**Help**",
            html: '<p><img src="${static_path}/images/a.png"/> <a href="${host_url}datasets">datasets</a></p>',
            rendered: true,
        },
        requirements: [{ name: "kitchen", version: "1.0", type: "package" }],
        options: { sanitize: true, refresh: false },
        form: { action: "/tool_runner/index", method: "post", check_values: true },
        data_tables: [{ name: "indexes", columns: ["value", "dbkey", "name", "path"], files: [] }],
        tool_shed_repository: { name: "kitchen_sink", owner: "planet", tool_shed: "toolshed.example.org" },
        panel_entry: {
            model_class: "Tool",
            id: TOOL_ID.replace(/1\.1$/, version),
            name: "Kitchen sink",
            version,
            description: "for tests",
            labels: [],
            icon: null,
            edam_operations: [],
            edam_topics: [],
            hidden: "",
            is_workflow_compatible: true,
            xrefs: [],
            versions: ["1.0", "1.1"],
            hidden_versions: [],
            link: "/tool_runner?tool_id=kitchen_sink",
            has_parameters: true,
            panel_section_id: "tests",
            panel_section_name: "Tests",
            form_style: "regular",
        },
        inputs: [
            param("data", "input", { label: "Table", extensions: ["tabular"], multiple: false }),
            param("data_column", "column", {
                data_ref: "input",
                multiple: false,
                default_value: null,
                numerical: false,
            }),
            param("data", "reads", { extensions: ["fastqsanger"], multiple: true, optional: true, min: null, max: 4 }),
            param("data_collection", "pairs", {
                extensions: ["fastqsanger"],
                collection_types: ["paired"],
                optional: true,
            }),
            param("select", "mode", {
                static_options: [
                    ["Fast", "fast", false],
                    ["Slow", "slow", true],
                ],
                multiple: false,
                separator: ",",
            }),
            param("select", "flags", {
                static_options: [
                    ["A", "a", false],
                    ["B", "b", false],
                ],
                multiple: true,
                optional: true,
                display: "checkboxes",
                separator: ",",
            }),
            param("select", "index", {
                is_dynamic: true,
                optional: true,
                options: {
                    from_dataset: null,
                    from_file: null,
                    from_data_table: "indexes",
                    from_parameter: null,
                    from_url: null,
                    transform_lines: null,
                    meta_file_key: null,
                    options_filter_attribute: null,
                    separator: "\t",
                    startswith: null,
                    columns: {},
                    filters: [{ type: "sort_by", column: "2" }],
                    validators: [],
                },
            }),
            param("select", "read_group", {
                is_dynamic: true,
                optional: true,
                options: {
                    from_dataset: null,
                    from_file: null,
                    from_data_table: null,
                    from_parameter: null,
                    from_url: null,
                    transform_lines: null,
                    meta_file_key: null,
                    options_filter_attribute: null,
                    separator: "\t",
                    startswith: null,
                    columns: {},
                    filters: [{ type: "data_meta", ref: "input", key: "column_names" }],
                    validators: [],
                },
            }),
            param("integer", "threads", {
                value: "4",
                min: 1,
                max: 64,
                validators: [
                    {
                        type: "in_range",
                        message: "Value ('%s') must fulfill (1 <= value <= 64)",
                        implicit: true,
                        min: 1,
                        max: 64,
                        negate: false,
                    },
                ],
            }),
            param("float", "ratio", { value: "0.5" }),
            param("text", "title", {
                value: "run",
                optional: true,
                validators: [
                    {
                        type: "regex",
                        expression: "[a-z]",
                        message: "Must start with a letter",
                        negate: false,
                        implicit: false,
                    },
                ],
            }),
            param("boolean", "verbose", { truevalue: "--verbose", falsevalue: "", checked: false }),
            param("genomebuild", "dbkey", { multiple: false }),
            conditional(
                "options",
                param("select", "kind", {
                    static_options: [
                        ["Basic", "basic", true],
                        ["Advanced", "advanced", false],
                    ],
                }),
                [
                    ["basic", []],
                    ["advanced", [param("integer", "level", { value: "1" }), param("text", "note", { value: "" })]],
                ],
            ),
            repeat(
                "queries",
                [
                    param("text", "q", { value: "x" }),
                    param("data", "table", { extensions: ["tabular"], optional: true }),
                ],
                {
                    title: "Query",
                    min: 1,
                    default: 1,
                    max: 3,
                },
            ),
            section("advanced", [param("boolean", "keep", { truevalue: "true", falsevalue: "false", checked: true })], {
                title: "Advanced settings",
            }),
            param("hidden", "secret", { value: "s3" }),
            param("color", "colour", { value: "#FF0000" }),
            conditional(
                "reference",
                param("boolean", "use_ref", { truevalue: "yes", falsevalue: "no", checked: false }),
                [
                    ["yes", [param("data", "ref", { extensions: ["fasta"] })]],
                    ["no", []],
                ],
            ),
        ],
        outputs: [
            output("pair_out", {
                model_class: "ToolOutputCollection",
                output_type: "collection",
                format: null,
                label: "${tool.name} on ${on_string}: pairs",
                default_format: "fastqsanger",
                structure: {
                    collection_type: "paired",
                    collection_type_source: null,
                    structured_like: null,
                    discover_datasets: [],
                },
                outputs: [],
                filters: ["pairs is not None"],
            }),
            output("out", { format_source: "input", label: "${tool.name} on ${on_string}", metadata_source: "input" }),
            output("report", {
                format: "html",
                label: "Report of $mode ($options.kind)",
                filters: ["options['kind'] == 'advanced'"],
                from_work_dir: "out/report.html",
            }),
            output("aligned", {
                format: "bam",
                change_format: [
                    { value: "slow", format: "sam", input: "$mode", input_dataset: null, check_attribute: null },
                ],
            }),
            output("maybe", { format: "txt", filters: ["len(queries) > 1"], label: "${input.name} extra" }),
        ],
    };
}

/** A trimmed `/api/datatypes/mapping` with the classes the kitchen sink uses. */
export const MAPPING = {
    ext_to_class_name: {
        data: "galaxy.datatypes.data.Data",
        txt: "galaxy.datatypes.data.Text",
        tabular: "galaxy.datatypes.tabular.Tabular",
        interval: "galaxy.datatypes.interval.Interval",
        bed: "galaxy.datatypes.interval.Bed",
        fastqsanger: "galaxy.datatypes.sequence.FastqSanger",
        fasta: "galaxy.datatypes.sequence.Fasta",
        bam: "galaxy.datatypes.binary.Bam",
        sam: "galaxy.datatypes.tabular.Sam",
        html: "galaxy.datatypes.text.Html",
    },
    class_to_classes: {
        "galaxy.datatypes.data.Data": { "galaxy.datatypes.data.Data": true },
        "galaxy.datatypes.data.Text": { "galaxy.datatypes.data.Text": true, "galaxy.datatypes.data.Data": true },
        "galaxy.datatypes.tabular.Tabular": {
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.interval.Interval": {
            "galaxy.datatypes.interval.Interval": true,
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.interval.Bed": {
            "galaxy.datatypes.interval.Bed": true,
            "galaxy.datatypes.interval.Interval": true,
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.sequence.FastqSanger": {
            "galaxy.datatypes.sequence.FastqSanger": true,
            "galaxy.datatypes.sequence.Fastq": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.sequence.Fasta": {
            "galaxy.datatypes.sequence.Fasta": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.binary.Bam": { "galaxy.datatypes.binary.Bam": true, "galaxy.datatypes.data.Data": true },
        "galaxy.datatypes.tabular.Sam": {
            "galaxy.datatypes.tabular.Sam": true,
            "galaxy.datatypes.tabular.Tabular": true,
            "galaxy.datatypes.data.Text": true,
            "galaxy.datatypes.data.Data": true,
        },
        "galaxy.datatypes.text.Html": { "galaxy.datatypes.text.Html": true, "galaxy.datatypes.data.Data": true },
    },
};

export const GENOMES = [
    ["unspecified (?)", "?"],
    ["Human Dec. 2013 (GRCh38/hg38) (hg38)", "hg38"],
    ["Mouse Dec. 2011 (GRCm38/mm10) (mm10)", "mm10"],
];

/** Static data files for a toolbox holding the given bundles. */
export function toolboxFiles(bundles: ToolBundle[] = [kitchenSinkBundle()]): Record<string, unknown> {
    const files: Record<string, unknown> = {
        "/static/planet/data/datatypes/mapping.json": MAPPING,
        "/static/planet/data/datatypes/details.json": {},
        "/static/planet/data/datatypes/edam_formats.json": { tabular: "format_3475" },
        "/static/planet/data/datatypes/edam_data.json": { tabular: "data_0006" },
        "/static/planet/data/datatypes/extensions.json": ["tabular", "txt"],
        "/static/planet/data/genomes.json": GENOMES,
        "/static/planet/data/toolbox/tools.json": bundles.map((bundle) => bundle.panel_entry),
    };
    for (const bundle of bundles) {
        files[`/static/planet/data/${bundlePath(bundle.id, bundle.version)}`] = bundle;
    }
    return files;
}
