/**
 * Where a tool installation reads tools from (`install.source` of a `tool_install` manifest, planet/docs/job-protocol.md):
 * a Tool Shed changeset, cloned by the install pod with hg, or a GitHub commit, read from its codeload tarball.
 * The browser checks and normalizes sources; it never reads the repositories itself.
 */

/** `tool_id` of tool installation jobs; their `params.source` is the {@link InstallSource}. */
export const TOOL_INSTALL_TOOL_ID = "__PLANET_TOOL_INSTALL__";
export const TOOL_INSTALL_TOOL_VERSION = "1.0.0";

export const MAIN_TOOL_SHED = "https://toolshed.g2.bx.psu.edu";
/** Tool Sheds tools may be installed from. */
export const TOOL_SHEDS: readonly string[] = [MAIN_TOOL_SHED, "https://testtoolshed.g2.bx.psu.edu"];

/** Panel section of installed tools; the install pod writes it into each bundle's `panel_entry`. */
export const INSTALLED_PANEL_SECTION = { id: "planet_installed", name: "Installed tools" } as const;

export interface ToolShedSource {
    type: "toolshed";
    tool_shed_url: string;
    owner: string;
    name: string;
    /** Changeset id, 12 to 40 lowercase hexadecimal digits. */
    changeset_revision: string;
}

export interface GitHubSource {
    type: "github";
    /** `<owner>/<name>`. */
    repository: string;
    /** Full commit SHA. */
    ref: string;
    /** Directory inside the repository to look for tools in; "" for the root. */
    path: string;
}

export type InstallSource = ToolShedSource | GitHubSource;

/** An install source that cannot be used; the message names the problem. */
export class InstallSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InstallSourceError";
    }
}

// The install pod checks the same patterns (planet_runtime/repositories.py).
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CHANGESET = /^[0-9a-f]{12,40}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PATH_SEGMENT = /^[A-Za-z0-9_+@~-][A-Za-z0-9._+@~-]*$/;
const MAX_PATH_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown !== undefined) {
        throw new InstallSourceError(`Unknown install source field ${JSON.stringify(unknown)}.`);
    }
}

/** A directory inside a repository, without leading, trailing or repeated slashes; "" for the root. */
export function normalizeRepositoryPath(value: unknown): string {
    const path = text(value).replace(/^\/+|\/+$/g, "");
    if (!path) {
        return "";
    }
    const segments = path.split("/").filter((segment) => segment !== "");
    if (path.length > MAX_PATH_LENGTH || !segments.every((segment) => PATH_SEGMENT.test(segment))) {
        throw new InstallSourceError(
            `Path ${JSON.stringify(path)} must be a directory inside the repository, such as tools/datamash.`,
        );
    }
    return segments.join("/");
}

/**
 * Checks an untrusted install source and returns it normalized: a Tool Shed source of one of {@link TOOL_SHEDS}, or a
 * GitHub commit.
 *
 * @throws InstallSourceError naming the first problem
 */
export function parseInstallSource(value: unknown): InstallSource {
    if (!isRecord(value)) {
        throw new InstallSourceError("The install source must be an object.");
    }
    if (value.type === "toolshed") {
        checkKeys(value, ["type", "tool_shed_url", "owner", "name", "changeset_revision"]);
        const url = text(value.tool_shed_url || MAIN_TOOL_SHED).replace(/\/+$/, "");
        if (!TOOL_SHEDS.includes(url)) {
            throw new InstallSourceError(`Tools can only be installed from ${TOOL_SHEDS.join(" or ")}.`);
        }
        const owner = text(value.owner);
        const name = text(value.name);
        if (!NAME.test(owner) || !NAME.test(name)) {
            throw new InstallSourceError("The repository needs a valid owner and name.");
        }
        const changeset = text(value.changeset_revision).toLowerCase();
        if (!CHANGESET.test(changeset)) {
            throw new InstallSourceError("The changeset revision must be 12 to 40 hexadecimal digits.");
        }
        return { type: "toolshed", tool_shed_url: url, owner, name, changeset_revision: changeset };
    }
    if (value.type === "github") {
        checkKeys(value, ["type", "repository", "ref", "path"]);
        const repository = text(value.repository)
            .replace(/^https:\/\/github\.com\//, "")
            .replace(/\.git$/, "");
        const [owner, name, ...rest] = repository.split("/");
        if (rest.length || !NAME.test(owner ?? "") || !NAME.test(name ?? "")) {
            throw new InstallSourceError("The GitHub repository must be written as owner/name.");
        }
        const ref = text(value.ref).toLowerCase();
        if (!COMMIT.test(ref)) {
            throw new InstallSourceError("The GitHub commit must be a full 40-character commit SHA.");
        }
        return { type: "github", repository: `${owner}/${name}`, ref, path: normalizeRepositoryPath(value.path) };
    }
    throw new InstallSourceError("The install source type must be toolshed or github.");
}

/** The beginning of the ids of the tools a source installs, ending with `/`; the install pod computes the same. */
export function toolIdPrefix(source: InstallSource): string {
    if (source.type === "toolshed") {
        return `${new URL(source.tool_shed_url).host}/repos/${source.owner}/${source.name}/`;
    }
    return `github.com/repos/${source.repository}/`;
}

/** `owner/name` of the source's repository. */
export function sourceLabel(source: InstallSource): string {
    return source.type === "toolshed" ? `${source.owner}/${source.name}` : source.repository;
}

/** The revision a source names: the changeset or commit. */
export function sourceRevision(source: InstallSource): string {
    return source.type === "toolshed" ? source.changeset_revision : source.ref;
}

/** A page about the source's repository at its revision, for people to read. */
export function sourcePageUrl(source: InstallSource): string {
    if (source.type === "toolshed") {
        return `${source.tool_shed_url}/view/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.name)}/${source.changeset_revision}`;
    }
    const tree = source.path
        ? `/tree/${source.ref}/${source.path.split("/").map(encodeURIComponent).join("/")}`
        : `/tree/${source.ref}`;
    return `https://github.com/${source.repository}${tree}`;
}
