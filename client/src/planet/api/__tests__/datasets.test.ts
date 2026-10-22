// @vitest-environment node
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { datasets, hdas, jobs, settings } from "@/planet/db";
import type { NewHda } from "@/planet/db/hdas";
import type { NewDataset } from "@/planet/db/records";
import { Router } from "@/planet/sw/router";

import {
    CHUNK_SIZE,
    DATASET_DOCUMENT_CSP,
    register,
    resolveReference,
    rewriteCss,
    rewriteHtml,
    scanHtml,
    type SubresourceResolver,
    toContentDisposition,
    withStorageShim,
} from "../datasets";
import {
    addDataset,
    currentHistoryId,
    fetchJson,
    GENOMES,
    keysOf,
    request,
    resetPlanet,
    send,
    teardownPlanet,
} from "./contents.fixtures";
import { configureStorage, FakeBucket, PREFIX, S3_ENDPOINT, stubNetwork } from "./datasets.fixtures";
import { DATATYPE_FILES } from "./datatypes.fixtures";

const encoder = new TextEncoder();
const FILES = { ...DATATYPE_FILES, "/static/planet/data/genomes.json": GENOMES };

let bucket: FakeBucket;

function makeRouter(): Router {
    const router = new Router();
    register(router);
    return router;
}

beforeEach(async () => {
    await resetPlanet();
    bucket = new FakeBucket();
    stubNetwork(FILES, bucket);
    await configureStorage();
});
afterEach(teardownPlanet);

/** Gzip-compresses `text` with the platform's CompressionStream. */
async function gzip(text: string): Promise<Uint8Array> {
    const Compressor = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream!;
    const stream = new Blob([text]).stream().pipeThrough(new Compressor("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesOf(content: string | Uint8Array): Uint8Array {
    return typeof content === "string" ? encoder.encode(content) : content;
}

/** Adds an `ok` dataset whose primary file holds `content`. */
async function addFile(
    extension: string,
    content: string | Uint8Array,
    hda: Partial<Omit<NewHda, "history_id" | "dataset_id">> = {},
    dataset: NewDataset = {},
) {
    const bytes = bytesOf(content);
    const created = await addDataset(
        await currentHistoryId(),
        { name: "my data", extension, ...hda },
        { file_size: bytes.byteLength, total_size: bytes.byteLength, ...dataset },
    );
    bucket.put(created.dataset.object_key, bytes);
    return created;
}

/** Stores an extra files archive (members at 512-byte aligned offsets, like tar) and its index. */
async function addExtraFiles(datasetId: string, members: Record<string, string | Uint8Array>, keyed: string[] = []) {
    const dataset = (await datasets.get(datasetId))!;
    const parts: Uint8Array[] = [];
    const entries: Record<string, unknown>[] = [];
    const directories = new Set<string>();
    let offset = 0;
    for (const [path, content] of Object.entries(members)) {
        const segments = path.split("/");
        for (let depth = 1; depth < segments.length; depth++) {
            const directory = segments.slice(0, depth).join("/");
            if (!directories.has(directory)) {
                directories.add(directory);
                entries.push({ path: directory, type: "directory" });
            }
        }
        const bytes = bytesOf(content);
        offset += 512;
        parts.push(new Uint8Array(512), bytes);
        const entry: Record<string, unknown> = { path, type: "file", offset, size: bytes.byteLength };
        if (keyed.includes(path)) {
            entry.key = `datasets/${dataset.uuid}/extra/${path}`;
            bucket.put(entry.key as string, bytes);
        }
        entries.push(entry);
        offset += bytes.byteLength;
    }
    const tar = new Uint8Array(offset);
    let position = 0;
    for (const part of parts) {
        tar.set(part, position);
        position += part.byteLength;
    }
    const extra = { key: `datasets/${dataset.uuid}/extra.tar`, index_key: `datasets/${dataset.uuid}/extra.json` };
    bucket.put(extra.key, tar);
    bucket.put(extra.index_key, JSON.stringify({ size: tar.byteLength, entries }));
    await datasets.update(datasetId, { extra_files: extra });
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}

/** One BGZF block: a gzip member with the "BC" extra subfield holding the block size. */
function bgzfBlock(piece: Uint8Array): Uint8Array {
    const deflated = deflateRawSync(piece);
    const block = new Uint8Array(18 + deflated.byteLength + 8);
    const view = new DataView(block.buffer);
    block.set([0x1f, 0x8b, 8, 4, 0, 0, 0, 0, 0, 0xff, 6, 0, 0x42, 0x43, 2, 0]);
    view.setUint16(16, block.byteLength - 1, true);
    block.set(deflated, 18);
    view.setUint32(18 + deflated.byteLength, crc32(piece), true);
    view.setUint32(22 + deflated.byteLength, piece.byteLength, true);
    return block;
}

/** `text` as bgzip writes it: blocks of at most `blockSize` bytes, then the empty end-of-file block. */
function bgzip(text: string, blockSize = 65280): Uint8Array {
    const data = encoder.encode(text);
    const blocks: Uint8Array[] = [];
    for (let offset = 0; offset < data.byteLength; offset += blockSize) {
        blocks.push(bgzfBlock(data.subarray(offset, offset + blockSize)));
    }
    return joinBytes([...blocks, bgzfBlock(new Uint8Array(0))]);
}

/** Header length of the gzip member at the start of `data` (RFC 1952). */
function gzipHeaderLength(data: Uint8Array): number {
    const flags = data[3]!;
    let length = 10;
    if (flags & 4) {
        length += 2 + (data[10]! | (data[11]! << 8));
    }
    for (const flag of [8, 16]) {
        if (flags & flag) {
            length = data.indexOf(0, length) + 1;
        }
    }
    return flags & 2 ? length + 2 : length;
}

/**
 * DecompressionStream("gzip") as browsers implement it: it decodes one gzip member and fails on data after it.
 * Node's decodes every member, which would hide code that relies on that.
 */
class SingleMemberDecompressionStream extends TransformStream<Uint8Array, Uint8Array> {
    constructor() {
        const parts: Uint8Array[] = [];
        super({
            transform: (chunk) => {
                parts.push(chunk);
            },
            flush: (controller) => {
                const input = joinBytes(parts);
                const header = gzipHeaderLength(input);
                const result = inflateRawSync(input.subarray(header), { info: true }) as unknown as {
                    buffer: Uint8Array;
                    engine: { bytesWritten: number };
                };
                if (header + result.engine.bytesWritten + 8 < input.byteLength) {
                    controller.error(new TypeError("Junk found after end of compressed data."));
                    return;
                }
                controller.enqueue(new Uint8Array(result.buffer));
            },
        });
    }
}

/** A GET as the worker sees it for a frame or tab that shows `path`. */
function navigate(router: Router, path: string): Promise<Response> {
    const navigation = request(path);
    Object.defineProperty(navigation, "mode", { value: "navigate" });
    return router.handle(navigation);
}

/** `count` lines of `width` bytes each, newline included. */
function lines(count: number, width = 99): string {
    return Array.from({ length: count }, (_, index) => `${String(index).padStart(width - 1, "x")}\n`).join("");
}

describe("storage configuration", () => {
    it("explains how to configure storage when no bucket is set", async () => {
        const { hda } = await addFile("txt", "hello");
        await settings.update({ storage: { endpoint: "", secret_access_key: null } });
        const error = await fetchJson(makeRouter(), "GET", `/datasets/${hda.id}/display?preview=True`, undefined, 501);
        expect(error.err_code).toBe(501002);
        expect(error.err_msg).toContain("Dataset storage is not configured");
    });

    it("reports a dataset file missing from the bucket", async () => {
        const { hda, dataset } = await addFile("txt", "hello");
        bucket.objects.delete(`${PREFIX}/${dataset.object_key}`);
        const error = await fetchJson(makeRouter(), "GET", `/api/datasets/${hda.id}/download`, undefined, 404);
        expect(error.err_msg).toBe(`The file of dataset ${hda.hid} is missing from your bucket.`);
    });
});

describe("text previews", () => {
    it("serves at most 1 MB of text with x-content-truncated, using a Range request", async () => {
        const content = "a".repeat(1_200_000);
        const { hda, dataset } = await addFile("txt", content);
        const response = await send(makeRouter(), "GET", `/datasets/${hda.id}/display/?preview=True`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("x-content-truncated")).toBe("1000000");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect((await response.text()).length).toBe(1_000_000);
        expect(bucket.requestsFor(dataset.object_key)).toEqual([
            { method: "GET", key: `${PREFIX}/${dataset.object_key}`, range: "bytes=0-1000000" },
        ]);
    });

    it("serves small text whole without the truncation header", async () => {
        const { hda } = await addFile("txt", "small file\n");
        const response = await send(makeRouter(), "GET", `/datasets/${hda.id}/display?preview=true`);
        expect(response.headers.get("x-content-truncated")).toBeNull();
        expect(await response.text()).toBe("small file\n");
        expect(response.headers.get("content-disposition")).toContain('inline; filename="Galaxy1-[my_data].txt"');
    });

    it("answers HEAD from the dataset size without reading the object", async () => {
        const { hda, dataset } = await addFile("txt", "a".repeat(2_000_000));
        const response = await send(makeRouter(), "HEAD", `/datasets/${hda.id}/display/?preview=True`);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-content-truncated")).toBe("1000000");
        expect(bucket.requestsFor(dataset.object_key)).toEqual([]);
    });

    it.each(["svg", "xml", "json", "html.txt"])(
        "never serves %s previews as active content",
        async (extension: string) => {
            const { hda } = await addFile(
                extension === "html.txt" ? "txt" : extension,
                "<svg><script>alert(1)</script></svg>",
            );
            const response = await send(makeRouter(), "GET", `/api/datasets/${hda.id}/display?preview=true`);
            expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        },
    );

    it("previews binary datasets as 100 KB of text", async () => {
        const { hda } = await addFile("bam", new Uint8Array(150_000).fill(65));
        const response = await send(makeRouter(), "GET", `/datasets/${hda.id}/display?preview=True`);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(response.headers.get("x-content-truncated")).toBe("100000");
        expect((await response.text()).length).toBe(100_000);
    });

    it("decompresses gzip sequences for their 100 KB preview", async () => {
        const fastq = "@read\nACGT\n+\nIIII\n".repeat(10_000);
        const { hda } = await addFile("fastqsanger.gz", await gzip(fastq));
        const response = await send(makeRouter(), "GET", `/datasets/${hda.id}/display?preview=True`);
        expect(response.headers.get("x-content-truncated")).toBe("100000");
        expect(await response.text()).toBe(fastq.slice(0, 100_000));
    });

    it("redirects raster image previews to the bucket and treats other images as text", async () => {
        const png = await addFile("png", new Uint8Array([137, 80, 78, 71]));
        const response = await send(makeRouter(), "GET", `/datasets/${png.hda.id}/display?preview=True`);
        expect(response.status).toBe(302);
        const location = new URL(response.headers.get("location")!);
        expect(location.origin).toBe(S3_ENDPOINT);
        expect(location.pathname).toBe(`/bucket/${PREFIX}/${png.dataset.object_key}`);
        expect(location.searchParams.get("response-content-type")).toBe("image/png");
        expect(location.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);

        const pdf = await addFile("pdf", "%PDF-1.4");
        const text = await send(makeRouter(), "GET", `/datasets/${pdf.hda.id}/display?preview=True`);
        expect(text.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    });
});

describe("tabular chunks", () => {
    it("serves the first chunk with x-content-chunked, extended to the end of its line", async () => {
        const content = lines(1000);
        const { hda } = await addFile("tabular", content, { metadata: { columns: 1 } });
        const response = await send(makeRouter(), "GET", `/datasets/${hda.id}/display/?preview=True`);
        expect(response.headers.get("x-content-chunked")).toBe("true");
        expect(response.headers.get("content-type")).toBe("application/json");
        const chunk = await response.json();
        const expectedEnd = Math.ceil(CHUNK_SIZE / 99) * 99;
        expect(chunk).toEqual({ ck_data: content.slice(0, expectedEnd), offset: expectedEnd, data_line_offset: 0 });
    });

    it("pages through chunks with the legacy route until the end of the file", async () => {
        const content = lines(1000);
        const { hda } = await addFile("tabular", content);
        const router = makeRouter();
        let offset = 0;
        let data = "";
        for (let page = 0; page < 10; page++) {
            const chunk = await fetchJson(router, "GET", `/dataset/display?dataset_id=${hda.id}&offset=${offset}`);
            if (!chunk.ck_data) {
                expect(chunk.offset).toBe(offset);
                break;
            }
            expect(chunk.ck_data.endsWith("\n")).toBe(true);
            data += chunk.ck_data;
            offset = chunk.offset;
        }
        expect(data).toBe(content);
    });

    it("honours ck_size and the datatype's data_line_offset", async () => {
        const { hda } = await addFile("sra_manifest.tabular", "a\tb\nc\td\ne\tf\n");
        const chunk = await fetchJson(makeRouter(), "GET", `/dataset/display?dataset_id=${hda.id}&offset=0&ck_size=5`);
        expect(chunk).toEqual({ ck_data: "a\tb\nc\td\n", offset: 8, data_line_offset: 1 });
    });

    it("decompresses gzip tabular data for chunks", async () => {
        const content = lines(2000, 50);
        const { hda } = await addFile("tabular.gz", await gzip(content));
        const router = makeRouter();
        const first = await fetchJson(router, "GET", `/dataset/display?dataset_id=${hda.id}&offset=0`);
        expect(first.ck_data).toBe(content.slice(0, first.offset));
        expect(first.offset % 50).toBe(0);
        const second = await fetchJson(router, "GET", `/dataset/display?dataset_id=${hda.id}&offset=${first.offset}`);
        expect(second.ck_data).toBe(content.slice(first.offset, second.offset));
    });

    it("refuses binary content in a chunk", async () => {
        const { hda } = await addFile("tabular", new Uint8Array([0xff, 0xfe, 0x0a]));
        const error = await fetchJson(
            makeRouter(),
            "GET",
            `/dataset/display?dataset_id=${hda.id}&offset=0`,
            undefined,
            500,
        );
        expect(error).toEqual({ err_code: 500005, err_msg: "Dataset appears to contain binary data, cannot display." });
    });
});

describe("gzip data of any datatype", () => {
    beforeEach(() => {
        vi.stubGlobal("DecompressionStream", SingleMemberDecompressionStream);
    });

    it("decodes bgzip tabular data block by block, for the first chunk and later ones", async () => {
        const content = lines(5000, 60);
        const { hda, dataset } = await addFile("vcf_bgzip", bgzip(content), { metadata: { columns: 1 } });
        const router = makeRouter();
        const preview = await send(router, "GET", `/datasets/${hda.id}/display/?preview=True`);
        expect(preview.headers.get("x-content-chunked")).toBe("true");
        const first = await preview.json();
        expect(first.offset).toBe(Math.ceil(CHUNK_SIZE / 60) * 60);
        expect(first.ck_data).toBe(content.slice(0, first.offset));

        const later = await fetchJson(router, "GET", `/dataset/display?dataset_id=${hda.id}&offset=150000`);
        expect(later.ck_data).toBe(content.slice(150_000, later.offset));
        expect(later.offset).toBe(Math.ceil((150_000 + CHUNK_SIZE) / 60) * 60);

        const text = await fetchJson(router, "GET", `/api/datasets/${hda.id}/get_content_as_text`);
        expect(text.item_data).toBe(content);
        expect(bucket.requestsFor(dataset.object_key)[0]).toMatchObject({ range: `bytes=0-${CHUNK_SIZE - 1}` });
    });

    it("gunzips datasets whose datatype does not declare gzip when the data starts with gzip's magic bytes", async () => {
        const content = lines(400, 40);
        const { hda } = await addFile("tabular", await gzip(content));
        const chunk = await fetchJson(makeRouter(), "GET", `/dataset/display?dataset_id=${hda.id}&offset=0`);
        expect(chunk.ck_data).toBe(content);

        const notes = await addFile("txt", await gzip("compressed notes\n"));
        const preview = await send(makeRouter(), "GET", `/datasets/${notes.hda.id}/display?preview=True`);
        expect(await preview.text()).toBe("compressed notes\n");
    });

    it("shows the complete blocks of bgzip data cut short", async () => {
        const content = lines(2000, 60);
        const data = bgzip(content);
        const firstBlock = 1 + new DataView(data.buffer).getUint16(16, true);
        const { hda } = await addFile("vcf_bgzip", data.slice(0, firstBlock + 100));
        const chunk = await fetchJson(
            makeRouter(),
            "GET",
            `/dataset/display?dataset_id=${hda.id}&offset=0&ck_size=200000`,
        );
        expect(chunk.ck_data).toBe(content.slice(0, 65280));
    });
});

describe("withStorageShim", () => {
    const shim = withStorageShim("").replace(/^<script>|<\/script>$/g, "");

    it("goes after <head>, else after the doctype, else first", () => {
        expect(withStorageShim('<!DOCTYPE html><html><HEAD lang="en"><script>a()</script>')).toMatch(
            /^<!DOCTYPE html><html><HEAD lang="en"><script>\(\(\) => \{[\s\S]*<\/script><script>a\(\)<\/script>$/,
        );
        expect(withStorageShim("<!doctype html>\n<header>x</header>")).toMatch(
            /^<!doctype html><script>[\s\S]*<header>x/,
        );
        expect(withStorageShim("<p>x</p>")).toMatch(/^<script>[\s\S]*<\/script><p>x<\/p>$/);
    });

    it("replaces storage and cookies that throw, and keeps those that work", () => {
        const denied = {
            configurable: true,
            get() {
                throw new DOMException("The document is sandboxed", "SecurityError");
            },
        };
        const sandboxed = {} as Record<string, unknown>;
        Object.defineProperty(sandboxed, "localStorage", denied);
        const session = { kept: true };
        sandboxed.sessionStorage = session;
        const page = Object.defineProperty({} as { cookie: string }, "cookie", denied);
        new Function("window", "document", shim)(sandboxed, page);
        expect(page.cookie).toBe("");
        page.cookie = "a=1";
        expect(page.cookie).toBe("");

        const storage = sandboxed.localStorage as Storage;
        storage.setItem("theme", 1 as unknown as string);
        storage.setItem("zoom", "2");
        expect(storage.getItem("theme")).toBe("1");
        expect(storage.getItem("missing")).toBeNull();
        expect([storage.length, storage.key(1), storage.key(5)]).toEqual([2, "zoom", null]);
        storage.removeItem("theme");
        expect(storage.length).toBe(1);
        storage.clear();
        expect(storage.length).toBe(0);
        expect(sandboxed.sessionStorage).toBe(session);
    });
});

describe("HTML documents", () => {
    it("serves HTML datasets in a sandbox to frames and tabs, and as text to scripts", async () => {
        const source = "<html><body><script>parent.alert(1)</script></body></html>";
        const { hda, dataset } = await addFile("html", source);
        const router = makeRouter();
        const response = await navigate(router, `/datasets/${hda.id}/display/?preview=True`);
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(response.headers.get("content-security-policy")).toBe(DATASET_DOCUMENT_CSP);
        expect(DATASET_DOCUMENT_CSP).toBe(
            "sandbox allow-scripts allow-popups allow-forms; default-src 'none'; img-src data: https:; " +
                "style-src 'unsafe-inline' https:; script-src 'unsafe-inline' https:; media-src https:; " +
                "font-src https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
        );
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        const document = await response.text();
        expect(document).toContain("<script>parent.alert(1)</script>");
        expect(document.indexOf("localStorage")).toBeLessThan(document.indexOf("parent.alert"));

        // A fetched body could become a blob: document in the app's origin.
        const fetched = await send(router, "GET", `/datasets/${hda.id}/display/?preview=True`);
        expect(fetched.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(fetched.headers.get("content-security-policy")).toBeNull();
        expect(await fetched.text()).toBe(source);

        const head = await send(router, "HEAD", `/datasets/${hda.id}/display/?preview=True`);
        expect(head.status).toBe(200);
        expect(head.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(head.headers.get("x-content-truncated")).toBeNull();
        expect(bucket.requestsFor(dataset.object_key).filter((request) => request.method === "GET")).toHaveLength(2);
    });

    it("previews datatypes that are HTML only by mimetype as text, however they are requested", async () => {
        const { hda } = await addFile("obo", "<html><body><script>alert(1)</script></body></html>");
        const router = makeRouter();
        const path = `/datasets/${hda.id}/display/?preview=True`;
        for (const response of [
            await send(router, "GET", path),
            await send(router, "HEAD", path),
            await send(router, "GET", `/api/datasets/${hda.id}/display?preview=true`),
            await navigate(router, path),
        ]) {
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
            expect(response.headers.get("content-security-policy")).toBeNull();
        }
    });

    it("rewrites relative subresources to inlined or presigned content from the extra files", async () => {
        const page = [
            "<html><head>",
            '<link rel="stylesheet" href="css/style.css" media="screen">',
            '<script src="js/app.js"></script>',
            '<script src="https://cdn.example.org/lib.js"></script>',
            "</head><body>",
            '<img src="images/plot.png" alt="plot">',
            '<img srcset="images/plot.png 1x, images/big.png 2x">',
            "<div style=\"background: url('images/plot.png')\"></div>",
            '<video src="movie.mp4"></video>',
            '<a href="other.html">next</a>',
            '<img src="../../secret.png">',
            '<img src="/static/logo.png">',
            '<img src="missing.png">',
            "</body></html>",
        ].join("\n");
        const { hda } = await addFile("html", page);
        await addExtraFiles(
            hda.dataset_id,
            {
                "css/style.css": "body { background: url(../images/plot.png); } @import 'more.css';",
                "css/more.css": "p { color: red; }",
                "js/app.js": "document.title = '</script>';",
                "images/plot.png": new Uint8Array([1, 2, 3]),
                "images/big.png": new Uint8Array([4, 5, 6]),
                "movie.mp4": new Uint8Array([7]),
                "other.html": "<p>next</p>",
            },
            ["movie.mp4", "images/big.png"],
        );
        const body = await (await navigate(makeRouter(), `/datasets/${hda.id}/display/?preview=True`)).text();
        const png = "data:image/png;base64,AQID";
        expect(body).toContain(`<img src="${png}" alt="plot">`);
        expect(body).toContain(`<style media="screen">body { background: url("${png}"); } p { color: red; }</style>`);
        expect(body).toContain("<script >document.title = '<\\/script>';</script>");
        expect(body).toContain('<script src="https://cdn.example.org/lib.js"></script>');
        expect(body).toMatch(
            /srcset="data:image\/png;base64,AQID 1x, https:\/\/s3\.test\/bucket\/planet\/datasets\/[^"]+\/extra\/images\/big\.png\?[^" ]+ 2x"/,
        );
        expect(body).toContain(`style="background: url(&quot;${png}&quot;)"`);
        expect(body).toMatch(/<video src="https:\/\/s3\.test\/bucket\/planet\/datasets\/[^"]+\/extra\/movie\.mp4\?/);
        expect(body).toContain('<a href="other.html">next</a>');
        expect(body).toContain('<img src="../../secret.png">');
        expect(body).toContain('<img src="/static/logo.png">');
        expect(body).toContain('<img src="missing.png">');
    });

    it("ignores single-object keys outside the dataset's own prefix", async () => {
        const { hda, dataset } = await addFile("html", '<img src="a.png">');
        await addExtraFiles(hda.dataset_id, { "a.png": new Uint8Array([1]) });
        const index = JSON.parse(
            new TextDecoder().decode(bucket.objects.get(`${PREFIX}/datasets/${dataset.uuid}/extra.json`)),
        );
        index.entries[0].key = "state/instance/snapshot";
        bucket.put(`datasets/${dataset.uuid}/extra.json`, JSON.stringify(index));
        const body = await (await navigate(makeRouter(), `/datasets/${hda.id}/display/?preview=True`)).text();
        expect(body).toBe(withStorageShim('<img src="data:image/png;base64,AQ==">'));
    });

    it("serves extra files by name: documents sandboxed, images as images, directories as listings", async () => {
        const { hda } = await addFile("html", "<p>index</p>");
        await addExtraFiles(hda.dataset_id, {
            "sub/page.html": '<img src="pic.png">',
            "sub/pic.png": new Uint8Array([9, 9]),
            "notes.txt": "plain",
        });
        const router = makeRouter();
        const page = await navigate(router, `/datasets/${hda.id}/display/sub/page.html`);
        expect(page.headers.get("content-security-policy")).toBe(DATASET_DOCUMENT_CSP);
        expect(await page.text()).toBe(withStorageShim('<img src="data:image/png;base64,CQk=">'));
        const pageSource = await send(router, "GET", `/datasets/${hda.id}/display/sub/page.html`);
        expect(pageSource.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(pageSource.headers.get("content-security-policy")).toBeNull();
        expect(await pageSource.text()).toBe('<img src="pic.png">');

        const image = await send(router, "GET", `/api/datasets/${hda.id}/display?filename=sub/pic.png`);
        expect(image.headers.get("content-type")).toBe("image/png");
        expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([9, 9]));

        const notes = await send(router, "GET", `/datasets/${hda.id}/display/notes.txt`);
        expect(notes.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(await notes.text()).toBe("plain");

        const listing = await navigate(router, `/datasets/${hda.id}/display/sub`);
        expect(listing.headers.get("content-security-policy")).toBe(DATASET_DOCUMENT_CSP);
        expect(await listing.text()).toContain("Directory sub contents: 2 items");
        const listingSource = await send(router, "GET", `/datasets/${hda.id}/display/sub`);
        expect(listingSource.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(await listingSource.text()).toContain("Directory sub contents: 2 items");

        expect((await send(router, "GET", `/datasets/${hda.id}/display/nope.txt`)).status).toBe(404);
        expect((await send(router, "GET", `/api/datasets/${hda.id}/display?filename=sub/../../x`)).status).toBe(400);

        expect(
            await fetchJson(router, "GET", `/api/datasets/${hda.id}/get_content_as_text?filename=notes.txt`),
        ).toEqual({
            item_data: "plain",
            truncated: false,
            item_url: `/datasets/${hda.id}/display?preview=False`,
        });
        expect(await fetchJson(router, "GET", `/api/datasets/${hda.id}/extra_files`)).toEqual([
            { class: "Directory", path: "sub" },
            { class: "File", path: "sub/page.html" },
            { class: "File", path: "sub/pic.png" },
            { class: "File", path: "notes.txt" },
        ]);
    });

    it("allows a plain-http storage endpoint next to https in the document policy", async () => {
        const local = "http://localhost:3900";
        stubNetwork(FILES, bucket, (url, init) => (url.origin === local ? bucket.handle(url, init) : undefined));
        await configureStorage(local);
        const { hda } = await addFile("html", "<p>local</p>");
        const response = await navigate(makeRouter(), `/datasets/${hda.id}/display/?preview=True`);
        const policy = response.headers.get("content-security-policy")!;
        expect(policy).toContain("img-src data: https: http://localhost:3900");
        expect(policy).toContain("sandbox allow-scripts allow-popups allow-forms");
    });
});

describe("downloads", () => {
    it("redirects downloads to a presigned URL with Galaxy's file name", async () => {
        const { hda, dataset } = await addFile("tabular", "a\tb\n", { name: 'odd "name"' });
        const response = await send(makeRouter(), "GET", `/api/datasets/${hda.id}/download`);
        expect(response.status).toBe(302);
        const location = new URL(response.headers.get("location")!);
        expect(location.pathname).toBe(`/bucket/${PREFIX}/${dataset.object_key}`);
        expect(location.searchParams.get("response-content-type")).toBe("application/octet-stream");
        expect(location.searchParams.get("response-content-disposition")).toBe(
            `attachment; filename="Galaxy1-[odd__name_].tabular"; filename*=UTF-8''Galaxy1-%5Bodd%20_name_%5D.tabular`,
        );
        expect(location.searchParams.get("X-Amz-Expires")).toBe("900");
    });

    it("downloads with another extension through display?to_ext", async () => {
        const { hda } = await addFile("txt", "x");
        const response = await send(makeRouter(), "GET", `/api/datasets/${hda.id}/display?to_ext=csv`);
        expect(response.status).toBe(302);
        const location = new URL(response.headers.get("location")!);
        expect(location.searchParams.get("response-content-disposition")).toContain('filename="Galaxy1-[my_data].csv"');
        const invalid = await send(makeRouter(), "GET", `/api/datasets/${hda.id}/display?to_ext=a%0D%0Ab`);
        expect(invalid.status).toBe(400);
    });

    it("answers HEAD downloads with size and file name", async () => {
        const { hda } = await addFile("txt", "12345");
        const response = await send(makeRouter(), "HEAD", `/api/datasets/${hda.id}/download?to_ext=txt`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe("5");
        expect(response.headers.get("content-disposition")).toContain('attachment; filename="Galaxy1-[my_data].txt"');
    });

    it("redirects full displays with a safe type: attachment for tabular, inline text otherwise", async () => {
        const tabular = await addFile("tabular", "a\n");
        const text = await addFile("txt", "a\n");
        const router = makeRouter();
        const raw = new URL(
            (await send(router, "GET", `/datasets/${tabular.hda.id}/display`)).headers.get("location")!,
        );
        expect(raw.searchParams.get("response-content-disposition")).toMatch(/^attachment;/);
        const inline = new URL(
            (await send(router, "GET", `/dataset/display?dataset_id=${text.hda.id}`)).headers.get("location")!,
        );
        expect(inline.searchParams.get("response-content-disposition")).toMatch(/^inline;/);
        expect(inline.searchParams.get("response-content-type")).toBe("text/plain; charset=utf-8");
    });

    it("refuses archive downloads of datasets with extra files", async () => {
        const { hda } = await addFile("html", "<p>x</p>");
        await addExtraFiles(hda.dataset_id, { "a.txt": "a" });
        const error = await fetchJson(makeRouter(), "GET", `/api/datasets/${hda.id}/download`, undefined, 501);
        expect(error.err_code).toBe(501001);
    });

    it("redirects metadata files with Galaxy's file name", async () => {
        const { hda } = await addFile("bam", "BAM");
        const key = "datasets/x/meta/bam_index";
        bucket.put(key, "BAI");
        await datasets.update(hda.dataset_id, { metadata_files: { bam_index: { key, file_size: 3 } } });
        const router = makeRouter();
        const response = await send(router, "GET", `/api/datasets/${hda.id}/metadata_file?metadata_file=bam_index`);
        const location = new URL(response.headers.get("location")!);
        expect(location.pathname).toBe(`/bucket/${PREFIX}/${key}`);
        expect(location.searchParams.get("response-content-disposition")).toBe(
            'attachment; filename="Galaxy1-[my_data].bai"',
        );
        const missing = await fetchJson(
            router,
            "GET",
            `/api/datasets/${hda.id}/metadata_file?metadata_file=other`,
            undefined,
            400,
        );
        expect(missing.err_msg).toBe("Metadata file other is not set for this dataset");
    });
});

describe("dataset states", () => {
    it("refuses to show data of datasets that have none", async () => {
        const router = makeRouter();
        const queued = await addFile("txt", "", {}, { state: "queued" });
        const conflict = await fetchJson(router, "GET", `/datasets/${queued.hda.id}/display`, undefined, 409);
        expect(conflict.err_msg).toBe("The dataset you are attempting to view is queued and has no data.");
        const purged = await addFile("txt", "x", { purged: true });
        const gone = await fetchJson(router, "GET", `/datasets/${purged.hda.id}/display`, undefined, 400);
        expect(gone.err_msg).toBe("The dataset you are attempting to view has been purged.");
        const deleted = await addFile("txt", "x", { deleted: true });
        expect((await send(router, "GET", `/datasets/${deleted.hda.id}/display?preview=True`)).status).toBe(200);
    });
});

describe("dataset details", () => {
    it("shows datasets with the HDA serializer", async () => {
        const { hda } = await addFile("txt", "x");
        const router = makeRouter();
        const detailed = await fetchJson(router, "GET", `/api/datasets/${hda.id}`);
        expect(detailed).toMatchObject({ id: hda.id, model_class: "HistoryDatasetAssociation", file_ext: "txt" });
        expect(detailed).toHaveProperty("peek");
        const keyed = await fetchJson(router, "GET", `/api/datasets/${hda.id}?keys=id,name`);
        expect(keysOf(keyed)).toEqual(["id", "name"]);
        expect((await send(router, "GET", `/api/datasets/${hda.id}?hda_ldda=ldda`)).status).toBe(404);
        expect((await send(router, "GET", `/api/datasets/${hda.id}?data_type=raw_data`)).status).toBe(501);
    });

    it("lists datasets across histories with filters, order and total_matches", async () => {
        const first = await addFile("txt", "a", { name: "alpha" });
        await addFile("txt", "b", { name: "beta" });
        const router = makeRouter();
        const response = await send(router, "GET", "/api/datasets?q=name-contains&qv=alp&order=create_time-dsc");
        expect(response.headers.get("total_matches")).toBe("1");
        const items = await response.json();
        expect(items.map((item: { id: string }) => item.id)).toEqual([first.hda.id]);
        expect(items[0]).toMatchObject({ name: "alpha", history_content_type: "dataset" });
        const all = await fetchJson(router, "GET", "/api/datasets?order=name-asc&limit=1&offset=1");
        expect(all.map((item: { name: string }) => item.name)).toEqual(["beta"]);
    });

    it("returns text content, storage details and empty metrics without a creating job", async () => {
        const { hda } = await addFile("txt", "hello text");
        const binary = await addFile("bam", "BAM");
        const router = makeRouter();
        expect(await fetchJson(router, "GET", `/api/datasets/${hda.id}/get_content_as_text`)).toEqual({
            item_data: "hello text",
            truncated: false,
            item_url: `/datasets/${hda.id}/display?preview=False`,
        });
        expect(
            (await fetchJson(router, "GET", `/api/datasets/${binary.hda.id}/get_content_as_text`)).item_data,
        ).toBeNull();
        const storage = await fetchJson(router, "GET", `/api/datasets/${hda.id}/storage`);
        expect(storage).toMatchObject({ name: "Your bucket", object_store_id: null, dataset_state: "ok", badges: [] });
        expect(await fetchJson(router, "GET", `/api/datasets/${hda.id}/inheritance_chain`)).toEqual([]);
        expect(await fetchJson(router, "GET", `/api/datasets/${hda.id}/metrics`)).toEqual([]);
        expect(await fetchJson(router, "GET", `/api/datasets/${hda.id}/parameters_display`)).toEqual({
            parameters: [],
            has_parameter_errors: false,
            outputs: {},
        });
    });

    it("reports parameter errors and metrics for a creating job whose tool is not in the toolbox", async () => {
        const { hda } = await addFile("txt", "x");
        const job = await jobs.create({
            tool_id: "cat1",
            tool_version: "1.0",
            history_id: hda.history_id,
            params: { sep: "tab" },
            outputs: [{ name: "out", src: "hda", id: hda.id }],
            metrics: [{ plugin: "core", name: "galaxy_slots", title: "Cores", value: "1", raw_value: "1" }],
        });
        await hdas.update(hda.id, { creating_job_id: job.id });
        const router = makeRouter();
        expect(await fetchJson(router, "GET", `/api/datasets/${hda.id}/parameters_display?hda_ldda=hda`)).toEqual({
            parameters: [],
            has_parameter_errors: true,
            outputs: { out: [{ label: null, value: { src: "hda", id: hda.id } }] },
        });
        expect(await fetchJson(router, "GET", `/api/datasets/${hda.id}/metrics`)).toEqual(job.metrics);
    });
});

describe("edit attributes", () => {
    it("returns Galaxy's attribute form", async () => {
        const { hda } = await addFile("txt", "x", { dbkey: "hg38", info: "some info" });
        const form = await fetchJson(makeRouter(), "GET", `/dataset/get_edit?dataset_id=${hda.id}`);
        expect(form.attribute_inputs.map((input: { name: string }) => input.name)).toEqual([
            "name",
            "info",
            "annotation",
            "dbkey",
        ]);
        const dbkey = form.attribute_inputs[3];
        expect(dbkey.value).toBe("hg38");
        expect(dbkey.options).toContainEqual(["Human Dec. 2013 (GRCh38/hg38) (hg38)", "hg38", true]);
        const datatypes = form.datatype_inputs[0].options.map((option: string[]) => option[1]);
        expect(datatypes).toContain("tabular");
        expect(datatypes).not.toContain("affybatch");
        expect(form.datatype_inputs[0].value).toBe("txt");
        expect(form).toMatchObject({ dataset_id: hda.id, metadata_disable: false, conversion_disable: true });
    });

    it("updates attributes and changes datatypes through a set-metadata job", async () => {
        const { hda } = await addFile("txt", "x");
        const router = makeRouter();
        const updated = await fetchJson(router, "PUT", "/dataset/set_edit", {
            dataset_id: hda.id,
            operation: "attributes",
            name: "renamed",
            info: "new info",
            annotation: "notes",
            dbkey: "mm10",
        });
        expect(updated).toEqual({ status: "success", message: "Attributes updated." });
        expect(await hdas.get(hda.id)).toMatchObject({
            name: "renamed",
            info: "new info",
            annotation: "notes",
            dbkey: "mm10",
        });

        const changed = await fetchJson(router, "PUT", "/dataset/set_edit", {
            dataset_id: hda.id,
            operation: "datatype",
            datatype: "tabular",
        });
        expect(changed).toEqual({ status: "success", message: "Changed the type to tabular." });
        expect(await hdas.get(hda.id)).toMatchObject({ extension: "tabular", _state: "setting_metadata" });
        const created = await jobs.listForHistory(hda.history_id);
        expect(created.map((job) => job.tool_id)).toEqual(["__SET_METADATA__"]);

        const unknown = await fetchJson(
            router,
            "PUT",
            "/dataset/set_edit",
            { dataset_id: hda.id, operation: "datatype", datatype: "nonsense" },
            400,
        );
        expect(unknown.err_msg).toBe("The target datatype does not exist.");
        const conversion = await fetchJson(
            router,
            "PUT",
            "/dataset/set_edit",
            { dataset_id: hda.id, operation: "conversion", target_type: "csv" },
            400,
        );
        expect(conversion.err_msg).toContain("not available in Planet yet");
    });

    it("keeps metadata while a job uses the dataset", async () => {
        const { hda } = await addFile("txt", "x");
        await jobs.create({
            tool_id: "cat1",
            tool_version: "1.0",
            history_id: hda.history_id,
            state: "running",
            inputs: [{ name: "input1", src: "hda", id: hda.id }],
        });
        const result = await fetchJson(makeRouter(), "PUT", "/dataset/set_edit", {
            dataset_id: hda.id,
            operation: "attributes",
            name: "renamed",
            dbkey: "mm10",
        });
        expect(result.status).toBe("warning");
        expect(await hdas.get(hda.id)).toMatchObject({ name: "renamed", dbkey: "?" });
    });
});

describe("sandboxed document rewriting", () => {
    const inline = (contents: Record<string, string>): SubresourceResolver => ({
        resolve: async (path) => (Object.hasOwn(contents, path) ? { bytes: encoder.encode(contents[path]) } : null),
    });

    it("tokenizes tags, attributes and raw text", () => {
        const tags = scanHtml(`<!-- <img src="no"> --><IMG SRC=a.png alt='x y'/><script>if (a<b) {}</script><p>`);
        expect(tags.map((tag) => tag.name)).toEqual(["img", "script", "script", "p"]);
        expect(tags[0]!.attributes.map((attribute) => [attribute.name, attribute.value])).toEqual([
            ["src", "a.png"],
            ["alt", "x y"],
        ]);
        expect(tags[1]!.content).toEqual({ start: 57, end: 68 });
    });

    it("resolves only relative references inside the extra files", () => {
        expect(resolveReference("", "img/a.png?v=1#top")).toEqual({ path: "img/a.png", suffix: "#top" });
        expect(resolveReference("sub", "../a%20b.png")).toEqual({ path: "a b.png", suffix: "" });
        for (const reference of [
            "",
            "#x",
            "/abs.png",
            "//host/x.png",
            "https://x/y.png",
            "data:image/png;base64,AA",
            "../x",
        ]) {
            expect(resolveReference("", reference)).toBeNull();
        }
    });

    it("inlines imported stylesheets and rewrites url() references", async () => {
        const css = await rewriteCss(
            `@import url("b.css") print; .a { background: url( 'img.png' ) } .b { background: myurl(x.png) }`,
            "",
            inline({ "b.css": ".b { font: url(f.woff2) }", "img.png": "P", "f.woff2": "F" }),
        );
        expect(css).toBe(
            `@media print {\n.b { font: url("data:font/woff2;base64,Rg==") }\n} .a { background: url("data:image/png;base64,UA==") } .b { background: myurl(x.png) }`,
        );
    });

    it("resolves each reference once, with at most six lookups in flight", async () => {
        let active = 0;
        let peak = 0;
        const calls: string[] = [];
        const resolver: SubresourceResolver = {
            async resolve(path) {
                calls.push(path);
                active++;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 1));
                active--;
                return { bytes: encoder.encode(path) };
            },
        };
        const images = Array.from({ length: 20 }, (_, index) => `<img src="i${index}.png"><img src="i${index}.png">`);
        const rewritten = await rewriteHtml(images.join(""), "", resolver);
        expect(calls).toHaveLength(20);
        expect(peak).toBeLessThanOrEqual(6);
        expect(rewritten).not.toContain('src="i');
    });

    it("rewrites large documents in linear time", async () => {
        const html = `<style>${".x { background: url(a.png) }\n".repeat(20_000)}</style>`;
        const started = performance.now();
        const rewritten = await rewriteHtml(html, "", inline({ "a.png": "A" }));
        expect(performance.now() - started).toBeLessThan(5000);
        expect(rewritten).toContain('url("data:image/png;base64,QQ==")');
    });
});

describe("content disposition", () => {
    it("matches Galaxy's to_content_disposition", () => {
        expect(toContentDisposition("Galaxy3-[résumé (1)].txt")).toBe(
            `attachment; filename="Galaxy3-[r_sum__(1)].txt"; filename*=UTF-8''Galaxy3-%5Br%C3%A9sum%C3%A9%20%281%29%5D.txt`,
        );
        expect(toContentDisposition("Galaxy1-[a/b*c].tar.gz", "inline")).toBe(
            `inline; filename="Galaxy1-[a_b_c].tar.gz"; filename*=UTF-8''Galaxy1-%5Ba_b_c%5D.tar.gz`,
        );
    });
});
