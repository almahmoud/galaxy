/**
 * Tool container resolution, following Galaxy's `explicit` and `mulled` container resolvers
 * (`galaxy.tool_util.deps.container_resolvers`, `deps/mulled/util.py`):
 *
 * 1. the first `<container type="docker">` of the tool;
 * 2. otherwise its `package` requirements as a BioContainers image on quay.io: one package is
 *    `biocontainers/<name>:<version>--<build>`, several are `mulled-v2-<sha1 of names>:<sha1 of versions>-<build>`.
 *    The tag is looked up with quay's v1 tag API (exact version matches only, as Galaxy) and pinned by its manifest
 *    digest;
 * 3. tools without package requirements run in the planet-runtime image.
 *
 * Resolved images are cached in `kv` for {@link CONTAINER_CACHE_SECONDS}.
 */

import { kv } from "@/planet/db";

export const QUAY_API = "https://quay.io/api/v1/repository";
export const BIOCONTAINERS_REGISTRY = "quay.io/biocontainers";
/** Resolved images are reused for 7 days. */
export const CONTAINER_CACHE_SECONDS = 7 * 24 * 3600;

const QUAY_PAGE_SIZE = 100;
const QUAY_MAX_PAGES = 30;
const PACKAGE_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9._+!*-]+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUILD_NUMBER = /(\d+)$/;

/** A conda package a tool requires. */
export interface PackageRequirement {
    name: string;
    version: string | null;
}

/** The parts of a tool bundle container resolution reads (`requirements`, `containers`). */
export interface ContainerRequest {
    requirements: PackageRequirement[];
    /** Explicit docker image identifiers, in the tool's order. */
    containers: string[];
}

/** A resolved tool image. */
export interface ResolvedContainer {
    /** Reference for the pod spec, digest-pinned when the registry reported a digest. */
    image: string;
    source: "explicit" | "mulled";
}

export interface ContainerResolverOptions {
    fetch?: (input: string, init: RequestInit) => Promise<Response>;
    /** Milliseconds since the epoch. */
    now?: () => number;
    /** Read and write the resolution cache in `kv` (default true). */
    cache?: boolean;
    signal?: AbortSignal;
}

/**
 * Raised when no image can be found. `transient` failures (network errors, quay errors, rate limits) are worth
 * retrying; others fail the job.
 */
export class ContainerResolutionError extends Error {
    constructor(
        message: string,
        readonly transient = false,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "ContainerResolutionError";
    }

    get permanent(): boolean {
        return !this.transient;
    }
}

interface QuayTag {
    name: string;
    manifest_digest?: string;
    start_ts?: number;
}

/** Reads the container request from a tool bundle (`requirements` and `containers`, see tool-bundle.schema.json). */
export function containerRequest(bundle: unknown): ContainerRequest {
    const tool = (bundle ?? {}) as { requirements?: unknown; containers?: unknown };
    const requirements: PackageRequirement[] = [];
    for (const item of Array.isArray(tool.requirements) ? tool.requirements : []) {
        const { name, type, version } = (item ?? {}) as { name?: unknown; type?: unknown; version?: unknown };
        if (type === "package" && typeof name === "string" && name) {
            requirements.push({ name, version: typeof version === "string" && version ? version : null });
        }
    }
    const containers: string[] = [];
    for (const item of Array.isArray(tool.containers) ? tool.containers : []) {
        const { identifier, type } = (item ?? {}) as { identifier?: unknown; type?: unknown };
        if (type === "docker" && typeof identifier === "string" && identifier.trim()) {
            containers.push(identifier.trim());
        }
    }
    return { requirements, containers };
}

async function sha1Hex(text: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedPackages(requirements: readonly PackageRequirement[]): PackageRequirement[] {
    return requirements
        .map(({ name, version }) => ({ name: name.toLowerCase(), version }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Galaxy's `v2_image_name` for several packages: the repository hashes the sorted package names, the tag
 * prefix hashes their versions in the same order (`null` for a versionless package), or is null when no
 * package has a version.
 */
export async function mulledV2Name(
    requirements: readonly PackageRequirement[],
): Promise<{ repository: string; versionHash: string | null }> {
    const packages = normalizedPackages(requirements);
    const repository = `mulled-v2-${await sha1Hex(packages.map((p) => p.name).join("\n"))}`;
    const versionHash = packages.some((p) => p.version)
        ? await sha1Hex(packages.map((p) => p.version ?? "null").join("\n"))
        : null;
    return { repository, versionHash };
}

/** The conda version of a single-package tag (`<version>--<build>`), as Galaxy's `split_tag`. */
function tagVersion(tag: string): string {
    const separator = tag.lastIndexOf("--");
    return separator === -1 ? tag : tag.slice(0, separator);
}

function buildNumber(tag: string): number {
    const match = BUILD_NUMBER.exec(tag);
    return match ? Number(match[1]) : -1;
}

/** Newest first: higher build number, then the more recent push (Galaxy's `version_sorted` within one version). */
function newestFirst(a: QuayTag, b: QuayTag): number {
    return buildNumber(b.name) - buildNumber(a.name) || (b.start_ts ?? 0) - (a.start_ts ?? 0);
}

function pinned(repository: string, tag: QuayTag): string {
    const image = `${BIOCONTAINERS_REGISTRY}/${repository}:${tag.name}`;
    return tag.manifest_digest && DIGEST_PATTERN.test(tag.manifest_digest) ? `${image}@${tag.manifest_digest}` : image;
}

/** Lists the active tags of a BioContainers repository whose name contains `filter`; [] when it does not exist. */
async function quayTags(
    repository: string,
    filter: string | null,
    options: Required<Pick<ContainerResolverOptions, "fetch">> & Pick<ContainerResolverOptions, "signal">,
): Promise<QuayTag[]> {
    const tags: QuayTag[] = [];
    for (let page = 1; page <= QUAY_MAX_PAGES; page++) {
        const query = [`limit=${QUAY_PAGE_SIZE}`, `page=${page}`, "onlyActiveTags=true"];
        if (filter) {
            query.push(`filter_tag_name=${encodeURIComponent(`like:${filter}`)}`);
        }
        const url = `${QUAY_API}/biocontainers/${encodeURIComponent(repository)}/tag/?${query.join("&")}`;
        let response: Response;
        try {
            response = await options.fetch(url, {
                method: "GET",
                // quay.io refuses API calls from browsers without this header (CSRF protection, HTTP 400).
                headers: { "X-Requested-With": "XMLHttpRequest" },
                credentials: "omit",
                referrerPolicy: "no-referrer",
                cache: "no-store",
                signal: options.signal,
            });
        } catch (error) {
            options.signal?.throwIfAborted();
            throw new ContainerResolutionError(`Could not reach quay.io to look up ${repository}.`, true, {
                cause: error,
            });
        }
        // quay.io answers 401 (`invalid_token`) for repositories that do not exist.
        if (response.status === 401 || response.status === 404) {
            return [];
        }
        if (!response.ok) {
            throw new ContainerResolutionError(
                `quay.io answered HTTP ${response.status} when looking up ${repository}.`,
                response.status === 429 || response.status >= 500,
            );
        }
        let body: { tags?: unknown; has_additional?: unknown };
        try {
            body = (await response.json()) as typeof body;
        } catch (error) {
            throw new ContainerResolutionError(`quay.io returned an invalid tag list for ${repository}.`, true, {
                cause: error,
            });
        }
        for (const tag of Array.isArray(body.tags) ? body.tags : []) {
            const { name, manifest_digest: digest, start_ts: started } = (tag ?? {}) as Record<string, unknown>;
            if (typeof name === "string" && name !== "latest") {
                tags.push({
                    name,
                    manifest_digest: typeof digest === "string" ? digest : undefined,
                    start_ts: typeof started === "number" ? started : undefined,
                });
            }
        }
        if (body.has_additional !== true) {
            break;
        }
    }
    return tags;
}

function describe(requirements: readonly PackageRequirement[]): string {
    return requirements.map(({ name, version }) => (version ? `${name} ${version}` : name)).join(", ");
}

async function resolveMulled(
    requirements: PackageRequirement[],
    options: Required<Pick<ContainerResolverOptions, "fetch">> & Pick<ContainerResolverOptions, "signal">,
): Promise<string> {
    for (const { name, version } of requirements) {
        if (!PACKAGE_PATTERN.test(name.toLowerCase()) || (version !== null && !VERSION_PATTERN.test(version))) {
            throw new ContainerResolutionError(`Invalid package requirement ${version ? `${name} ${version}` : name}.`);
        }
    }
    if (requirements.length === 1) {
        const [{ name, version }] = normalizedPackages(requirements) as [PackageRequirement];
        if (version === null) {
            throw new ContainerResolutionError(
                `No container for requirement ${name}: BioContainers images are matched by version and the tool ` +
                    "does not give one.",
            );
        }
        const tags = (await quayTags(name, version, options))
            .filter((tag) => tagVersion(tag.name) === version)
            .sort(newestFirst);
        const tag = tags[0];
        if (!tag) {
            throw new ContainerResolutionError(
                `No BioContainers image ${BIOCONTAINERS_REGISTRY}/${name}:${version}--* exists.`,
            );
        }
        return pinned(name, tag);
    }
    const { repository, versionHash } = await mulledV2Name(requirements);
    const tags = (await quayTags(repository, versionHash, options))
        .filter((tag) => !versionHash || tag.name === versionHash || tag.name.startsWith(`${versionHash}-`))
        .sort(newestFirst);
    const tag = tags[0];
    if (!tag) {
        throw new ContainerResolutionError(
            `No BioContainers image combines the tool's requirements (${describe(requirements)}): ` +
                `${BIOCONTAINERS_REGISTRY}/${repository}${versionHash ? `:${versionHash}-*` : ""} does not exist.`,
        );
    }
    return pinned(repository, tag);
}

function cacheKey(requirements: readonly PackageRequirement[]): `container:${string}` {
    return `container:${normalizedPackages(requirements)
        .map(({ name, version }) => `${name}=${version ?? ""}`)
        .join(",")}`;
}

/**
 * Resolves the image a tool runs in. Returns null when the tool names no container and has no package
 * requirements; such tools run in the planet-runtime image ({@link resolveToolImage}).
 *
 * @throws ContainerResolutionError when the requirements match no image, or quay.io cannot be queried
 */
export async function resolveToolContainer(
    bundle: unknown,
    options: ContainerResolverOptions = {},
): Promise<ResolvedContainer | null> {
    const { requirements, containers } = containerRequest(bundle);
    const explicit = containers[0];
    if (explicit) {
        return { image: explicit, source: "explicit" };
    }
    if (!requirements.length) {
        return null;
    }
    const now = options.now ?? Date.now;
    const useCache = options.cache ?? true;
    const key = cacheKey(requirements);
    if (useCache) {
        const cached = await kv.get(key);
        if (cached && now() - cached.resolved < CONTAINER_CACHE_SECONDS * 1000) {
            return { image: cached.image, source: "mulled" };
        }
    }
    const fetchImpl = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));
    const image = await resolveMulled(requirements, { fetch: fetchImpl, signal: options.signal });
    if (useCache) {
        await kv.set(key, { image, resolved: now() });
    }
    return { image, source: "mulled" };
}

/** The image a tool runs in: {@link resolveToolContainer}, or `runtimeImage` when the tool needs no packages. */
export async function resolveToolImage(
    bundle: unknown,
    runtimeImage: string,
    options: ContainerResolverOptions = {},
): Promise<string> {
    return (await resolveToolContainer(bundle, options))?.image ?? runtimeImage;
}
