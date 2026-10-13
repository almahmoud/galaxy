// Builds the configuration payload served for /context and /api/configuration: every key ConfigSerializer
// exposes, with the value Galaxy serves for a default galaxy.yml, then Planet overrides.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "client/package.json"));
const YAML = require("yaml");

const read = (path) => readFileSync(resolve(root, path), "utf8");

function match(source, pattern, what) {
    const found = source.match(pattern);
    if (!found) {
        throw new Error(`Cannot find ${what}`);
    }
    return found;
}

const versionSource = read("lib/galaxy/version/__init__.py");
const versionMajor = match(versionSource, /^VERSION_MAJOR = "([^"]*)"$/m, "VERSION_MAJOR in lib/galaxy/version")[1];
const versionMinor = match(versionSource, /^VERSION_MINOR = "([^"]*)"$/m, "VERSION_MINOR in lib/galaxy/version")[1];

// Galaxy's Python runs in planet-runtime, so `python` reports that image's interpreter.
const runtimePython = match(
    read("planet/runtime/Dockerfile"),
    /^ARG PYTHON_IMAGE=python:(\d+)\.(\d+)/m,
    "the Python image in planet/runtime/Dockerfile",
);

const includeTag = { tag: "!include", resolve: (value) => value };
const options = YAML.parse(read("lib/galaxy/config/schemas/config_schema.yml"), { customTags: [includeTag] }).mapping
    .galaxy.mapping;
const schemaDefault = (key) => options[key]?.default ?? null;

/** Python literals used as serializer defaults; anything else is undefined. */
function pythonLiteral(text) {
    const value = text.trim();
    const literals = { True: true, False: false, None: null };
    if (value in literals) {
        return literals[value];
    }
    if (/^"[^"\\]*"$/.test(value) || /^-?\d+(\.\d+)?$/.test(value)) {
        return JSON.parse(value);
    }
    return undefined;
}

/**
 * The serializer of each key in ConfigSerializer.add_serializers: `{kind: "config"}` (`_use_config`),
 * `{kind: "truthy"}` (`_config_is_truthy`), `{kind: "default", value}` (`_defaults_to(value)` and
 * `getattr(item, key, value)` lambdas) or `{kind: "app"}` (other lambdas, computed from the app).
 */
function readSerializers() {
    const source = read("lib/galaxy/managers/configuration.py");
    const start = source.indexOf("class ConfigSerializer");
    const end = source.indexOf("class AdminConfigSerializer");
    const serializers = new Map();
    for (const [, key, expression] of source.slice(start, end).matchAll(/^\s+"([a-z_0-9]+)": (.*)$/gm)) {
        const code = expression.replace(/\s+#.*$/, "").replace(/,$/, "");
        const defaultsTo =
            code.match(/^_defaults_to\((.*)\)$/) ??
            code.match(/^lambda item, key, \*\*context: getattr\(item, key, (.*)\)$/);
        if (defaultsTo) {
            serializers.set(key, {
                kind: "default",
                value: pythonLiteral(defaultsTo[1]),
            });
        } else if (code === "_use_config") {
            serializers.set(key, { kind: "config" });
        } else if (code === "_config_is_truthy") {
            serializers.set(key, { kind: "truthy" });
        } else {
            serializers.set(key, { kind: "app" });
        }
    }
    return serializers;
}

/** Splits one CSV line; fields may be quoted. */
function csvFields(line) {
    const fields = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (quoted && char === '"' && line[i + 1] === '"') {
            field += '"';
            i++;
        } else if (char === '"') {
            quoted = !quoted;
        } else if (char === "," && !quoted) {
            fields.push(field);
            field = "";
        } else {
            field += char;
        }
    }
    fields.push(field);
    return fields;
}

/** `galaxy.carbon_emissions.get_carbon_intensity_entry` for the default location code. */
function carbonIntensityEntry() {
    const code = schemaDefault("geographical_server_location_code");
    for (const line of read("lib/galaxy/carbon_emissions/carbon_intensity.csv").split(/\r?\n/)) {
        const fields = csvFields(line);
        if (fields[0] === code) {
            const name = code.length > 2 ? `${fields[3]} (${fields[2]})` : fields[2];
            return {
                location_name: name,
                carbon_intensity: Number.parseFloat(fields[4]),
            };
        }
    }
    return { location_name: "GLOBAL", carbon_intensity: 475.0 };
}

const carbon = carbonIntensityEntry();

// What Galaxy's app reports for these keys with no custom object stores, file sources, webhooks, SMTP,
// Sentry or LLM settings.
const appValues = {
    is_admin_user: false,
    carbon_intensity: carbon.carbon_intensity,
    geographical_server_location_name: carbon.location_name,
    server_mail_configured: false,
    file_sources_configured: false,
    quota_source_labels: [],
    object_store_allows_id_selection: false,
    object_store_ids_allowing_selection: [],
    user_library_import_dir_available: false,
    llm_api_configured: false,
    llm_registry_type: "default",
    sentry_dsn_public: null,
};

// Planet runs without a server, accounts, Celery, notifications or interactive tools. The Service Worker
// applies some of these again at runtime, with the build id and its start time.
const planetOverrides = {
    brand: "Planet",
    single_user: true,
    use_remote_user: true,
    enable_account_interface: false,
    allow_local_account_creation: false,
    enable_oidc: false,
    oidc: {},
    require_login: false,
    enable_quotas: false,
    enable_celery_tasks: false,
    enable_tool_requests: false,
    enable_notification_system: false,
    enable_sse_updates: false,
    enable_webhooks: false,
    interactivetools_enable: false,
    markdown_to_pdf_available: false,
    enable_tool_recommendations: false,
    enable_help_forum_tool_panel_integration: false,
    enable_tool_installation_request_form: false,
    enable_tool_generated_tours: false,
    enable_beacon_integration: false,
    tool_training_recommendations: false,
    install_tool_dependencies: false,
    install_repository_dependencies: false,
    install_resolver_dependencies: false,
    ga_code: null,
    plausible_server: null,
    plausible_domain: null,
    matomo_server: null,
    matomo_site_id: null,
    themes: {},
    panel_views: {},
    server_starttime: null,
    python: [Number(runtimePython[1]), Number(runtimePython[2])],
    version_major: versionMajor,
    version_minor: versionMinor,
};

const serializers = readSerializers();
const config = {};
const unresolved = [];
for (const [key, serializer] of serializers) {
    if (key in planetOverrides) {
        config[key] = planetOverrides[key];
    } else if (serializer.kind === "app") {
        if (!(key in appValues)) {
            unresolved.push(key);
        }
        config[key] = appValues[key] ?? null;
    } else if (serializer.kind === "default") {
        // getattr(config, key, default): options in the schema always exist on Galaxy's config object.
        if (!(key in options) && serializer.value === undefined) {
            unresolved.push(key);
        }
        config[key] = key in options ? schemaDefault(key) : (serializer.value ?? null);
    } else if (serializer.kind === "truthy") {
        config[key] = Boolean(schemaDefault(key));
    } else {
        config[key] = schemaDefault(key);
    }
}
const unknown = [...Object.keys(planetOverrides), ...Object.keys(appValues)].filter((key) => !serializers.has(key));
if (unknown.length) {
    throw new Error(`Values for keys ConfigSerializer does not expose: ${unknown.join(", ")}`);
}
if (unresolved.length) {
    throw new Error(`No value for ConfigSerializer keys computed by Galaxy's app: ${unresolved.join(", ")}`);
}

const outFile = process.argv[2] ?? resolve(root, "planet/build/generated/static/planet/data/config.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${Object.keys(config).length} configuration keys to ${outFile}`);
