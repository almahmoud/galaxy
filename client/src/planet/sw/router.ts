/**
 * Request router for the emulated Galaxy API. Patterns use Galaxy's (Starlette's) syntax: `{name}` matches
 * one path segment or part of one (`/contents/{type}s/{id}`), `{name:path}` matches the rest of the path.
 * A trailing slash on the request path is ignored. Among the routes for the request's method (GET also
 * serves HEAD), the most specific pattern wins: literal segments beat mixed ones, mixed beat single
 * parameters, parameters beat `{name:path}`; ties go to the earlier registration.
 *
 * The worker receives navigations into its scope from any site (links, frames, form posts), while other
 * sites' subresource requests never reach it. Navigations therefore reach only routes registered as
 * `navigable` (read-only documents and downloads), and requests that change state are refused when they
 * carry another origin or do not come from a script's `fetch` or `XMLHttpRequest` (markup such as
 * `<link rel=prefetch>` and `<a ping>` sends same-origin requests in `no-cors` mode).
 */

import type { GalaxyApiPaths } from "@/api/schema";
import { ApiError, ErrorCodes } from "@/planet/util/errors";

import { error, errorFrom, finalize, json, noContent, type TypedResponse } from "./responses";

export type HttpMethod = "get" | "put" | "post" | "delete" | "patch" | "head";

/** Every path in Galaxy's OpenAPI schema. */
export type SchemaPath = keyof GalaxyApiPaths & string;

type Operation<P extends SchemaPath, M extends HttpMethod> = NonNullable<GalaxyApiPaths[P][M]>;

/** Schema paths that define method `M`. */
export type SchemaPathFor<M extends HttpMethod> = {
    [P in SchemaPath]: [Operation<P, M>] extends [never] ? never : P;
}[SchemaPath];

type JsonBody<R> = R extends { content: infer C }
    ? C extends { "application/json": infer B }
        ? B
        : unknown
    : undefined;

type SuccessFrom<R> = R extends { 200: infer S }
    ? JsonBody<S>
    : R extends { 201: infer S }
      ? JsonBody<S>
      : R extends { 202: infer S }
        ? JsonBody<S>
        : R extends { 204: unknown }
          ? undefined
          : unknown;

/** The JSON body of the schema's success response (`undefined` for 204, `unknown` for non-JSON bodies). */
export type SuccessBody<P extends SchemaPath, M extends HttpMethod> =
    Operation<P, M> extends { responses: infer R } ? SuccessFrom<R> : unknown;

/** The schema's JSON request body, or `unknown` when it declares none. */
export type RequestBody<P extends SchemaPath, M extends HttpMethod> =
    Operation<P, M> extends { requestBody?: infer B }
        ? [NonNullable<B>] extends [never]
            ? unknown
            : NonNullable<B> extends { content: { "application/json": infer J } }
              ? J
              : unknown
        : unknown;

type ParamName<N extends string> = N extends `${infer Base}:${string}` ? Base : N;

/** Parameter names in a path pattern: `PathParams<"/api/histories/{history_id}">` is `"history_id"`. */
export type PathParams<S extends string> = string extends S
    ? string
    : S extends `${string}{${infer Name}}${infer Rest}`
      ? ParamName<Name> | PathParams<Rest>
      : never;

/** A request as handlers see it. */
export interface PlanetRequest<P extends string = string, B = unknown> {
    /** Upper-case HTTP method. HEAD requests reach GET handlers with `method` set to `HEAD`. */
    readonly method: string;
    readonly url: URL;
    /** Path as requested, without a trailing slash. */
    readonly path: string;
    /** Decoded path parameters. */
    readonly params: Readonly<Record<P, string>>;
    /** Query parameters; repeated keys (`q`, `qv`) are read with `getAll`. */
    readonly query: URLSearchParams;
    readonly headers: Headers;
    readonly raw: Request;
    /** Id of the window client that sent the request (or will receive the navigation), or "". */
    readonly clientId: string;
    /** True for navigations (top-level pages, iframes, downloads). */
    readonly isNavigation: boolean;
    /**
     * Parses the body as JSON. An empty body yields `{}`. The type comes from the schema and is not
     * validated: treat the value as untrusted input.
     *
     * @throws ApiError 400 (`USER_INVALID_JSON`) when the body is not JSON
     */
    json(): Promise<B>;
    /** The body as text. `json()` and `text()` share one read of the body. Both may be destructured. */
    text(): Promise<string>;
    /** Keeps the Service Worker alive until `promise` settles, after the response is sent. */
    waitUntil(promise: Promise<unknown>): void;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * What a typed handler returns: the success body (sent as JSON with status 200), a response built with
 * the helpers in `responses.ts`, or nothing for 204 routes.
 */
export type HandlerResult<T> = T | TypedResponse<T> | (undefined extends T ? void : never);

export type TypedHandler<P extends SchemaPath, M extends HttpMethod> = (
    request: PlanetRequest<PathParams<P>, RequestBody<P, M>>,
) => MaybePromise<HandlerResult<SuccessBody<P, M>>>;

/**
 * A handler for a route outside the schema. Return a value to send it as JSON (200), a `Response`, or
 * `undefined` for 204.
 */
export type UntypedHandler = (request: PlanetRequest) => MaybePromise<unknown>;

/** Context the Service Worker passes with each request. */
export interface HandleContext {
    clientId?: string;
    waitUntil?: (promise: Promise<unknown>) => void;
}

/** Registration options of a route. */
export interface RouteOptions {
    /**
     * Lets navigations (links, frames, downloads, typed addresses) reach this GET route. Any site can start
     * a navigation, so only read-only document and download routes are navigable.
     */
    navigable?: boolean;
    /**
     * Marks a GET route that changes state (Galaxy's legacy controllers). It gets the checks of the other
     * methods, which always count as changing state: same origin, and only `fetch` and `XMLHttpRequest`
     * calls, not navigations, images, scripts, styles, prefetches or pings.
     */
    changesState?: boolean;
}

export interface RouteInfo {
    method: string;
    pattern: string;
    navigable: boolean;
    changesState: boolean;
}

interface CompiledRoute extends RouteInfo {
    regex: RegExp;
    paramNames: string[];
    rank: number[];
    order: number;
    handler: (request: PlanetRequest) => MaybePromise<unknown>;
}

export type RouteMatch =
    | { kind: "route"; route: RouteInfo; params: Record<string, string>; handler: UntypedHandler }
    | { kind: "method-not-allowed"; allow: string[] }
    | { kind: "none" };

const LITERAL = 3;
const MIXED = 2;
const PARAM = 1;
const REST = 0;

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const PLACEHOLDER = new RegExp(`\\{(${NAME})(?::(path))?\\}`, "g");

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SCRIPTED_MODES = new Set<RequestMode>(["cors", "same-origin"]);

const NAVIGATION_FORM_REFUSED = "Planet does not accept form submissions.";
const NAVIGATION_REFUSED = "This Planet address cannot be opened as a page, link or frame.";
const CROSS_ORIGIN_REFUSED = "Requests from other sites cannot change Planet data.";
const NOT_SCRIPTED_REFUSED = "This address changes Planet data and answers only fetch or XMLHttpRequest calls.";

/**
 * True when the request carries another origin: an `Origin` header (including `null`, sent by opaque
 * origins such as sandboxed documents) or a `Sec-Fetch-Site` other than `same-origin`.
 */
function isForeign(request: Request, origin: string): boolean {
    const site = request.headers.get("Sec-Fetch-Site");
    if (site !== null && site !== "same-origin") {
        return true;
    }
    const sender = request.headers.get("Origin");
    return sender !== null && sender !== origin;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(path: string): string {
    return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function compile(pattern: string): Pick<CompiledRoute, "regex" | "paramNames" | "rank" | "pattern"> {
    const normalized = normalizePath(pattern);
    if (!normalized.startsWith("/")) {
        throw new Error(`Route pattern must start with "/": ${pattern}`);
    }
    const paramNames: string[] = [];
    const rank: number[] = [];
    const parts = normalized
        .split("/")
        .slice(1)
        .map((segment, index, all) => {
            const placeholders = [...segment.matchAll(PLACEHOLDER)];
            const stripped = segment.replace(PLACEHOLDER, "");
            if (stripped.includes("{") || stripped.includes("}")) {
                throw new Error(`Invalid placeholder in route pattern: ${pattern}`);
            }
            for (const match of placeholders) {
                if (paramNames.includes(match[1]!)) {
                    throw new Error(`Duplicate parameter ${match[1]} in route pattern: ${pattern}`);
                }
                paramNames.push(match[1]!);
            }
            if (placeholders.length === 0) {
                rank.push(LITERAL);
                return escapeRegex(segment);
            }
            if (placeholders.some((match) => match[2] === "path")) {
                if (placeholders.length !== 1 || placeholders[0]![0] !== segment || index !== all.length - 1) {
                    throw new Error(`{name:path} must be the whole last segment: ${pattern}`);
                }
                rank.push(REST);
                return "(.*)";
            }
            rank.push(placeholders.length === 1 && placeholders[0]![0] === segment ? PARAM : MIXED);
            let source = "";
            let last = 0;
            for (const match of placeholders) {
                source += escapeRegex(segment.slice(last, match.index)) + "([^/]+)";
                last = match.index! + match[0].length;
            }
            return source + escapeRegex(segment.slice(last));
        });
    return { regex: new RegExp(`^/${parts.join("/")}$`), paramNames, rank, pattern: normalized };
}

function compareRoutes(a: CompiledRoute, b: CompiledRoute): number {
    const length = Math.max(a.rank.length, b.rank.length);
    for (let i = 0; i < length; i++) {
        const difference = (b.rank[i] ?? -1) - (a.rank[i] ?? -1);
        if (difference !== 0) {
            return difference;
        }
    }
    return a.order - b.order;
}

function decode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        throw ApiError.badRequest("Malformed percent-encoding in request path");
    }
}

class RoutedRequest implements PlanetRequest {
    readonly method: string;
    readonly path: string;
    readonly query: URLSearchParams;
    readonly headers: Headers;
    readonly clientId: string;
    readonly isNavigation: boolean;
    private body?: Promise<string>;

    constructor(
        readonly raw: Request,
        readonly url: URL,
        readonly params: Readonly<Record<string, string>>,
        private readonly context: HandleContext,
    ) {
        this.method = raw.method.toUpperCase();
        this.path = normalizePath(url.pathname);
        this.query = url.searchParams;
        this.headers = raw.headers;
        this.clientId = context.clientId ?? "";
        this.isNavigation = raw.mode === "navigate";
    }

    readonly text = (): Promise<string> => {
        this.body ??= this.raw.text();
        return this.body;
    };

    readonly json = async (): Promise<unknown> => {
        const body = await this.text();
        if (body.trim() === "") {
            return {};
        }
        try {
            return JSON.parse(body);
        } catch {
            throw ApiError.badRequest(
                "Your request did not appear to be valid JSON, please consult the API documentation",
                ErrorCodes.USER_INVALID_JSON,
            );
        }
    };

    readonly waitUntil = (promise: Promise<unknown>): void => {
        const guarded = promise.catch((reason) => console.error("Planet background task failed", reason));
        this.context.waitUntil?.(guarded);
    };
}

/** Why the router refuses a request before running its handler, or null to let it through. */
function refusalFor(request: Request, url: URL, method: string, found: RouteMatch): string | null {
    if (request.mode === "navigate") {
        if (method !== "GET" && method !== "HEAD") {
            return NAVIGATION_FORM_REFUSED;
        }
        if (found.kind === "none" || (found.kind === "route" && found.route.navigable)) {
            return null;
        }
        return NAVIGATION_REFUSED;
    }
    const changesState = !READ_METHODS.has(method) || (found.kind === "route" && found.route.changesState);
    if (!changesState) {
        return null;
    }
    if (isForeign(request, url.origin)) {
        return CROSS_ORIGIN_REFUSED;
    }
    // Scripts send "cors" (or "same-origin") requests with an empty destination; markup sends "no-cors" ones.
    if (!SCRIPTED_MODES.has(request.mode) || request.destination !== "") {
        return NOT_SCRIPTED_REFUSED;
    }
    return null;
}

function toResponse(result: unknown): Response {
    if (result instanceof Response) {
        return result;
    }
    if (result === undefined) {
        return noContent();
    }
    return json(result);
}

function withoutBody(response: Response): Response {
    void response.body?.cancel().catch(() => undefined);
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** Routes requests to handlers and turns their results and errors into Galaxy-shaped responses. */
export class Router {
    private readonly table: CompiledRoute[] = [];
    private sorted = true;

    /**
     * Registers a handler for a path and method of Galaxy's OpenAPI schema. Path parameters, the JSON
     * body and the result are typed from the schema.
     *
     * @example router.route("/api/histories/{history_id}", "get", async ({ params }) => ...)
     */
    route<P extends SchemaPathFor<M>, M extends HttpMethod>(
        path: P,
        method: M,
        handler: TypedHandler<P, M>,
        options: RouteOptions = {},
    ): this {
        return this.add(path, method, handler as (request: PlanetRequest) => MaybePromise<unknown>, options);
    }

    /** Registers a handler for a path outside the schema (legacy controllers, `/context`, Planet routes). */
    untyped(
        path: string,
        method: HttpMethod | readonly HttpMethod[],
        handler: UntypedHandler,
        options: RouteOptions = {},
    ): this {
        for (const each of typeof method === "string" ? [method] : method) {
            this.add(path, each, handler, options);
        }
        return this;
    }

    /** Registered routes in match order. */
    routes(): RouteInfo[] {
        return this.ordered().map(({ method, pattern, navigable, changesState }) => ({
            method,
            pattern,
            navigable,
            changesState,
        }));
    }

    /** Finds the route for a method and path. HEAD falls back to GET. */
    match(method: string, path: string): RouteMatch {
        const wanted = method.toUpperCase();
        const normalized = normalizePath(path);
        const candidates: { route: CompiledRoute; match: RegExpExecArray }[] = [];
        for (const route of this.ordered()) {
            const match = route.regex.exec(normalized);
            if (match) {
                candidates.push({ route, match });
            }
        }
        const pick =
            candidates.find(({ route }) => route.method === wanted) ??
            (wanted === "HEAD" ? candidates.find(({ route }) => route.method === "GET") : undefined);
        if (pick) {
            const params: Record<string, string> = {};
            pick.route.paramNames.forEach((name, index) => {
                params[name] = decode(pick.match[index + 1] ?? "");
            });
            const { method: routeMethod, pattern, navigable, changesState } = pick.route;
            return {
                kind: "route",
                route: { method: routeMethod, pattern, navigable, changesState },
                params,
                handler: pick.route.handler,
            };
        }
        if (candidates.length) {
            const allow = new Set(candidates.map(({ route }) => route.method));
            if (allow.has("GET")) {
                allow.add("HEAD");
            }
            return { kind: "method-not-allowed", allow: [...allow].sort() };
        }
        return { kind: "none" };
    }

    /**
     * Answers a request. Unknown paths get a Galaxy 404, known paths with another method a 405, handler
     * errors a Galaxy error envelope (500 for anything but {@link ApiError}, without details). Navigations
     * to routes that are not navigable, and state-changing requests from another origin, get a 403. Every
     * response carries `X-Request-ID` and `Cache-Control: no-store`; HEAD responses have no body.
     */
    async handle(request: Request, context: HandleContext = {}): Promise<Response> {
        const url = new URL(request.url);
        const method = request.method.toUpperCase();
        let response: Response;
        try {
            const found = this.match(method, url.pathname);
            const refusal = refusalFor(request, url, method, found);
            if (refusal) {
                response = error(403, refusal, ErrorCodes.USER_CANNOT_ACCESS_ITEM);
            } else if (found.kind === "none") {
                response = error(404, `No route for ${url.pathname}`, ErrorCodes.USER_OBJECT_NOT_FOUND);
            } else if (found.kind === "method-not-allowed") {
                response = error(405, "Method Not Allowed", ErrorCodes.UNKNOWN, {}, { Allow: found.allow.join(", ") });
            } else {
                try {
                    response = toResponse(await found.handler(new RoutedRequest(request, url, found.params, context)));
                } catch (caught) {
                    if (!(caught instanceof ApiError)) {
                        console.error(`Planet handler for ${found.route.method} ${found.route.pattern} failed`, caught);
                    }
                    throw caught;
                }
            }
        } catch (caught) {
            response =
                caught instanceof ApiError
                    ? errorFrom(caught)
                    : error(500, "Internal server error", ErrorCodes.INTERNAL_SERVER_ERROR);
        }
        if (method === "HEAD") {
            response = withoutBody(response);
        }
        return finalize(response);
    }

    private add(
        path: string,
        method: HttpMethod,
        handler: (request: PlanetRequest) => MaybePromise<unknown>,
        options: RouteOptions,
    ): this {
        const compiled = compile(path);
        const upper = method.toUpperCase();
        if (this.table.some((route) => route.pattern === compiled.pattern && route.method === upper)) {
            throw new Error(`Route already registered: ${upper} ${compiled.pattern}`);
        }
        const navigable = options.navigable === true;
        const changesState = options.changesState === true;
        if (navigable && (upper !== "GET" || changesState)) {
            throw new Error(`Only read-only GET routes can be navigable: ${upper} ${compiled.pattern}`);
        }
        this.table.push({ ...compiled, method: upper, navigable, changesState, order: this.table.length, handler });
        this.sorted = false;
        return this;
    }

    private ordered(): CompiledRoute[] {
        if (!this.sorted) {
            this.table.sort(compareRoutes);
            this.sorted = true;
        }
        return this.table;
    }
}
