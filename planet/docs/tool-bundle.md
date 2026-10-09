# Tool bundles

A tool bundle is one Galaxy tool version parsed by Galaxy's `galaxy.tool_util` and saved
as JSON. The browser builds tool forms and submits jobs from bundles; the job's stage-in
container renders the command from them. Neither parses tool XML.

The schema is [`planet/toolbox/tool-bundle.schema.json`](../toolbox/tool-bundle.schema.json)
(JSON Schema 2020-12, `format_version` 1).

## Producing bundles

`planet/scripts/generate-data.sh` builds the bundles of the built-in toolbox listed in
[`planet/toolbox/toolbox.yml`](../toolbox/toolbox.yml), together with the datatype and
genome data, and validates every bundle against the schema:

```sh
planet/scripts/generate-data.sh                  # everything
planet/scripts/generate-data.sh --skip-toolbox   # datatypes and genomes only, no network
```

It runs the `planet_runtime.generate` modules in a container (`--image`, default
`quay.io/galaxyproject/galaxy-job-execution:26.2.dev0`) with this checkout's `lib/` first
on `PYTHONPATH`. Output goes to `planet/build/generated/`:

| Path | Content |
| --- | --- |
| `static/planet/data/datatypes/*.json` | `/api/datatypes*` payloads |
| `static/planet/data/genomes.json` | `GET /api/genomes` |
| `static/planet/data/toolbox/bundles/<id>/<version>.json` | one bundle per tool version |
| `static/planet/data/toolbox/panel.json` | `GET /api/tool_panels/default` |
| `static/planet/data/toolbox/panel_views/<view>.json` | `GET /api/tool_panels/{view}` |
| `static/planet/data/toolbox/panels.json` | `GET /api/tool_panels` |
| `static/planet/data/toolbox/tools.json` | `GET /api/tools?in_panel=false` |
| `static/planet/data/toolbox/tools_in_panel.json` | `GET /api/tools` |
| `static/planet/data/toolbox/tool_tags.json` | `GET /api/tags/tool_tags` |
| `toolrepos/tools/<id>/<version>/repo.tar` | the tool directory, without `test-data/` |
| `toolrepos/index.json` | id, version, path, SHA-256 and size of each `repo.tar` |

Repository tools get their Tool Shed GUID as id
(`toolshed.g2.bx.psu.edu/repos/<owner>/<repository>/<tool id>/<version>`). Each `/` in an
id is a directory level on disk; build URLs by encoding every `/`-separated segment with
`encodeURIComponent`, for example
`bundles/toolshed.g2.bx.psu.edu/repos/iuc/fastp/fastp/1.3.7%2Bgalaxy0/1.3.7%2Bgalaxy0.json`.
Ids and versions may only contain `A-Z a-z 0-9 . _ + @ ~ -` and `/`.

Datatype files that correspond to query variants of one route:

| File | Request |
| --- | --- |
| `extensions.json` | `/api/datatypes` |
| `extensions_all.json` | `/api/datatypes?upload_only=false` |
| `index.json`, `upload.json` | `/api/datatypes?extension_only=false` |
| `index_all.json` | `/api/datatypes?extension_only=false&upload_only=false` |
| `types_and_mapping.json` | `/api/datatypes/types_and_mapping` |
| `types_and_mapping_all.json` | `/api/datatypes/types_and_mapping?upload_only=false` |
| `details.json` | `/api/datatypes/{ext}`, keyed by extension |
| `visualizations.json` | `/api/datatypes/{ext}/visualizations`, keyed by extension |

`details.json` names a `preferred_visualization` only for plugins listed in
`PLANET_VISUALIZATION_PLUGINS`, as Galaxy omits plugins it does not serve.

### Adding a tool

Add an entry to a section of `toolbox.yml`:

```yaml
- path: tools/<directory>/<tool>.xml    # in `repository` at `commit`
  owner: iuc                            # optional, default from the directory's .shed.yml
  name: my_repository                   # optional, default from the directory's .shed.yml
  labels: [new]                         # optional panel labels
```

Raising `commit` updates every repository tool. Downloads are checked against the git
object ids of that commit and cached in `planet/build/cache/github/`.

## Contents

Values mirror what `galaxy.tools.Tool` and its parameter classes hold after parsing.

### Tool

| Field | Meaning |
| --- | --- |
| `id`, `old_id`, `version`, `versions` | Tool id (GUID for repository tools), the XML `id`, this version, all versions of the lineage |
| `name`, `description`, `profile`, `python_template_version` | As Galaxy computes them; `python_template_version` defaults to 3.5 from profile 19.05, else 2.7 |
| `tool_type`, `model_class`, `form_style` | Tool class (`Tool` for ordinary tools) and the form style the client uses |
| `hidden`, `display_interface`, `require_login`, `is_workflow_compatible`, `has_parameters` | Flags as in the tool panel API; `hidden` is `""` when unset |
| `edam_operations`, `edam_topics`, `xrefs`, `tool_tags` | After Galaxy's ontology expansion (curated EDAM and bio.tools mappings) |
| `license`, `creator`, `funding`, `citations` | Parsed metadata; citations are `{type, content}` |
| `help` | `{format, content, html, rendered}`: the help as written and its docutils rendering |
| `requirements`, `containers`, `resource_requirements`, `javascript_requirements`, `credentials` | `to_dict()` of Galaxy's requirement objects |
| `command` | `text` (Cheetah template), `interpreter`, `strict` (`set -e`), `detect_errors`, `oom_exit_code`, `use_shared_home`, all `attributes` |
| `version_command` | `{command, interpreter}` or null |
| `stdio` | `exit_codes` and `regexes`, `to_dict()` of `ToolStdioExitCode` / `ToolStdioRegex` |
| `configfiles` | `configfiles` (Cheetah templates), `inputs` (JSON of the tool state), `file_sources` |
| `environment_variables` | `{name, template, inject, strip}` |
| `home_target`, `tmp_target`, `tmp_directory_vars`, `docker_env_pass_through` | Job environment settings |
| `template_macro_params` | `<macros>` entries of type `template` (name to text), added to the Cheetah namespace |
| `options` | `<options sanitize refresh>` |
| `provided_metadata` | `galaxy.json` file name, style, and whether the tool declares them |
| `required_files`, `code` | `<required_files>` and `<code>` hooks (not executed by Planet) |
| `form`, `display`, `inputs`, `inputs_by_page` | Form attributes and the input tree (below) |
| `outputs` | Output definitions (below) |
| `parameter_models` | Galaxy's typed parameter models, or null when the tool cannot be modelled |
| `data_tables` | Tables from the directory's `tool_data_table_conf.xml.sample`, with `.loc.sample` rows |
| `tool_dir`, `tool_shed_repository`, `source` | Where the tool came from; `source.repo_tar` has the archive path, SHA-256 and size |
| `panel_entry` | `GET /api/tools/{id}` payload; set for built-in toolbox tools |

`help.html` keeps Galaxy's `${static_path}` and `${host_url}` placeholders; replace them
with `/static` and the site origin followed by `/` before serving, as `Tool.render_help`
does. `help.rendered` is false when docutils was unavailable.

### Inputs

`inputs` is an ordered list. Each entry is a group or a parameter, identified by
`model_class`.

| Group | Fields |
| --- | --- |
| `Repeat` | `name`, `title` (defaults to `name`), `help`, `min`, `max` (null if unbounded), `default` (clamped to min..max), `inputs` |
| `Section` | `name`, `title`, `help`, `expanded`, `inputs` |
| `Conditional` | `name`, `test_param`, `cases` (`{value, inputs}`), `value_ref`, `value_ref_in_group`, `value_from` |
| `UploadDataset` | `name`, `title`, `file_type_name`, `default_file_type`, `metadata_ref`, `inputs` |

As in Galaxy, a conditional's test parameter is never optional and always refreshes the
form, and every selectable test value without a `<when>` gets a case with no inputs.

Every parameter has `model_class`, `type`, `name`, `argument`, `label`, `help`,
`help_format`, `hidden`, `refresh_on_change`, `optional`, `is_dynamic`, `sanitizer`,
`validators` and `attributes` (the XML attributes, verbatim). Type-specific fields:

| Types | Fields |
| --- | --- |
| `text`, `integer`, `float` | `value` (string as written), `area`, `datalist`, `multiple`, `optionality_inferred`; numbers also `min`, `max` |
| `boolean` | `truevalue`, `falsevalue`, `checked` |
| `hidden`, `baseurl`, `color`, `directory_uri` | `value`; `color` also `rgb` |
| `select`, `genomebuild`, `group_tag`, `data_column` | `multiple`, `display`, `separator`, `static_options` (`[label, value, selected]`), `legal_values`, `options` (dynamic definition), `dynamic_options` (Python code), `data_ref` |
| `group_tag` | `tag_key`, `accept_default`, `default_value` |
| `data_column` | `numerical`, `accept_default`, `default_value` (without the `c` prefix), `usecolnames` |
| `drill_down` | `multiple`, `display`, `hierarchy`, `separator`, `options` (static tree), `from_file`, `dynamic_options` |
| `data`, `hidden_data` | `extensions`, `multiple`, `min`, `max`, `tag`, `load_contents`, `no_validation`, `conversions`, `default_object`, `allow_uri_if_protocol`, `options`, `options_filter_attribute` |
| `data_collection` | `extensions`, `collection_types`, `tag`, `fields`, `column_definitions`, `default_object`, `options`, `options_filter_attribute` |
| `rules` | `data_ref` |

`validators` lists Galaxy's validator models in Galaxy's order, including the ones Galaxy
adds itself (`implicit: true`): the range of `min`/`max` numbers and the metadata check
of data parameters. `expression` validators carry their Python expression.

`sanitizer` is `{invalid_char, sanitize, valid, mapping, xml}`, where `valid` and
`mapping` list the `<valid>` and `<mapping>` elements with their `add`/`remove` actions.

`options` on select and data parameters is the `<options>` element: `from_dataset`,
`from_file`, `from_data_table`, `from_parameter`, `from_url`, `meta_file_key`,
`options_filter_attribute`, `separator`, `startswith`, `transform_lines`, `columns`
(name to index), `filters` (each with its attributes), `validators`, and `xml`, the element
itself for Galaxy's `DynamicOptions`.

### Outputs

`outputs` lists `ToolOutput.to_dict()`, `ToolOutputCollection.to_dict()` and
`ToolExpressionOutput.to_dict()` in Galaxy's order, with EDAM terms, and adds:

| Field | Meaning |
| --- | --- |
| `filters` | Python expressions from `<filter>` |
| `change_format` | `{value, format, input, input_dataset, check_attribute}` per `<when>` |
| `actions` | `{element, xml}` for `<actions>`, or null |
| `precreate_directory`, `from_expression` | Data outputs |
| `outputs` | Datasets of a static collection, in the same format |
| `path`, `from_expression` | Expression outputs |

### Where values are evaluated

The browser uses the parsed values directly: types, defaults, options from
`static_options`, data tables and genome builds, `min`/`max`, regular-expression, length
and range validators, collection types and extensions. Cheetah (`command.text`,
`configfiles`, environment variable templates, output labels and `change_format` checks),
Python expressions (`filters`, `expression` validators, `dynamic_options`,
`transform_lines`), `<code>` hooks and output `actions` are evaluated in the job's
stage-in container, never on the site origin.

## Validating

```sh
python -m planet_runtime.generate.validate --schema planet/toolbox/tool-bundle.schema.json DIR_OR_FILE...
```

The generator tests (`planet/runtime/planet_runtime/generate/tests/`) also build a bundle
for every tool shipped in this Galaxy checkout and validate it against the schema.
