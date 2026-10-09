// Builds the configuration payload served for /context and /api/configuration.
// Keys come from ConfigSerializer, defaults from config_schema.yml, then Planet overrides.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "client/package.json"));
const YAML = require("yaml");

const serializerSource = readFileSync(resolve(root, "lib/galaxy/managers/configuration.py"), "utf8");
const start = serializerSource.indexOf("class ConfigSerializer");
const end = serializerSource.indexOf("class AdminConfigSerializer");
const keys = [...serializerSource.slice(start, end).matchAll(/^\s+"([a-z_0-9]+)":/gm)].map((m) => m[1]);

const includeTag = { tag: "!include", resolve: (value) => value };
const schema = YAML.parse(readFileSync(resolve(root, "lib/galaxy/config/schemas/config_schema.yml"), "utf8"), {
    customTags: [includeTag],
});
const options = schema.mapping.galaxy.mapping;

// Serializer-level defaults that differ from the schema (see ConfigSerializer.add_serializers).
const serializerDefaults = {
    is_admin_user: false,
    lims_doc_url: "https://usegalaxy.org/u/rkchak/p/sts",
    allow_local_account_creation: false,
    disable_local_accounts: false,
    allow_user_dataset_purge: false,
    has_user_tool_filters: false,
    has_user_preferences_extra: false,
    nginx_upload_path: false,
    carbon_emission_estimates: false,
    carbon_intensity: 0,
    geographical_server_location_name: "",
    mailing_join_addr: "galaxy-announce-join@bx.psu.edu",
    server_mail_configured: false,
    show_welcome_with_login: true,
    markdown_to_pdf_available: false,
    file_sources_configured: false,
    quota_source_labels: [],
    object_store_allows_id_selection: false,
    object_store_ids_allowing_selection: [],
    user_library_import_dir_available: false,
    fixed_delegated_auth: false,
    llm_api_configured: false,
    llm_registry_type: null,
    sentry_dsn_public: null,
    enable_webhooks: false,
};

// Planet runs without a server, accounts, Celery, notifications or interactive tools.
const planetOverrides = {
    brand: "Planet",
    single_user: true,
    use_remote_user: true,
    enable_account_interface: false,
    enable_oidc: false,
    oidc: {},
    require_login: false,
    enable_quotas: false,
    enable_celery_tasks: false,
    enable_tool_requests: false,
    enable_notification_system: false,
    enable_sse_updates: false,
    interactivetools_enable: false,
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
    python: [3, 12],
    version_major: "26.1",
    version_minor: "dev0",
};

const config = {};
for (const key of keys) {
    if (key in planetOverrides) {
        config[key] = planetOverrides[key];
    } else if (key in serializerDefaults) {
        config[key] = serializerDefaults[key];
    } else if (options[key] && "default" in options[key]) {
        config[key] = options[key].default;
    } else {
        config[key] = null;
    }
}
const unknown = Object.keys(planetOverrides).filter((key) => !keys.includes(key));
if (unknown.length) {
    throw new Error(`Overrides for keys ConfigSerializer does not expose: ${unknown.join(", ")}`);
}

const outFile = process.argv[2] ?? resolve(root, "planet/build/generated/config.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${Object.keys(config).length} configuration keys to ${outFile}`);
