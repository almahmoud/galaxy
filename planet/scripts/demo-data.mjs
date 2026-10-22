#!/usr/bin/env node
/**
 * Writes the demo data set: a synthetic two-contig reference and simulated Illumina paired-end reads.
 *
 *   node planet/scripts/demo-data.mjs [--out <dir>] [--pairs <n>] [--seed <n>] [--force]
 *
 * Files in the output directory (default planet/build/demo/data):
 *   reference.fasta                       two contigs, demo_chr1 and demo_chr2
 *   demo_R1.fastq.gz, demo_R2.fastq.gz    2 x 150 bp reads, Phred+33
 *   manifest.json                         parameters, simulated counts and file checksums
 *
 * The output depends only on the seed and the number of pairs. The reads come from a copy of the reference
 * with SNPs and short indels, with quality-dependent substitution errors, and include adapter read-through,
 * low-quality tails, failing reads, reads with Ns, PCR duplicates, chimeric pairs and pairs from a sequence
 * absent from the reference. Existing files are kept when manifest.json records the same parameters.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const VERSION = 1;
const READ_LENGTH = 150;
const CONTIGS = [
    { name: "demo_chr1", length: 28_000, gc: 0.41 },
    { name: "demo_chr2", length: 22_000, gc: 0.45 },
];
/** TruSeq adapters as read through on R1 and R2, followed by the flow cell binding sequences. */
const ADAPTER_R1 = "AGATCGGAAGAGCACACGTCTGAACTCCAGTCACGATCAGATATCTCGTATGCCGTCTTCTGCTTG";
const ADAPTER_R2 = "AGATCGGAAGAGCGTCGTGTAGGGAAAGAGTGTACTTGAATGTGTAGATCTCGGTGGTCGCCGTATCATT";
const INDEX = "GATCAGAT+ACTTGAAT";
const INSTRUMENT = "DEMO01:42:HDMKYDSX5";

/** Fractions of pairs or reads. */
const RATES = {
    snp: 1 / 900,
    indelsPerContig: 6,
    contaminantPairs: 0.025,
    chimericPairs: 0.005,
    duplicatePairs: 0.04,
    shortFragments: 0.045,
    lowQualityTails: 0.06,
    failingReads: 0.012,
    readsWithN: 0.004,
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArguments(argv) {
    const options = { out: join(repoRoot, "planet/build/demo/data"), pairs: 20_000, seed: 20_261_022, force: false };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const value = () => {
            const next = argv[++index];
            if (next === undefined) {
                throw new Error(`${argument} needs a value`);
            }
            return next;
        };
        if (argument === "--out") {
            options.out = resolve(value());
        } else if (argument === "--pairs") {
            options.pairs = Number(value());
        } else if (argument === "--seed") {
            options.seed = Number(value());
        } else if (argument === "--force") {
            options.force = true;
        } else if (argument === "-h" || argument === "--help") {
            console.log("Usage: demo-data.mjs [--out <dir>] [--pairs <n>] [--seed <n>] [--force]");
            process.exit(0);
        } else {
            throw new Error(`Unknown argument ${argument}`);
        }
    }
    if (!Number.isInteger(options.pairs) || options.pairs < 100 || options.pairs > 1_000_000) {
        throw new Error("--pairs must be an integer from 100 to 1000000");
    }
    if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0xffffffff) {
        throw new Error("--seed must be an integer from 0 to 4294967295");
    }
    return options;
}

/** mulberry32: a small, fast 32-bit generator; good enough for simulated data. */
function createRandom(seed) {
    let state = seed >>> 0;
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let spare = null;
    return {
        next,
        int: (min, max) => min + Math.floor(next() * (max - min + 1)),
        chance: (p) => next() < p,
        pick: (items) => items[Math.floor(next() * items.length)],
        /** Standard normal deviate (Box-Muller). */
        normal() {
            if (spare !== null) {
                const value = spare;
                spare = null;
                return value;
            }
            const u = 1 - next();
            const v = next();
            const radius = Math.sqrt(-2 * Math.log(u));
            spare = radius * Math.sin(2 * Math.PI * v);
            return radius * Math.cos(2 * Math.PI * v);
        },
    };
}

function randomSequence(random, length, gc) {
    const bases = new Array(length);
    for (let index = 0; index < length; index += 1) {
        const r = random.next();
        bases[index] = r < gc / 2 ? "G" : r < gc ? "C" : r < gc + (1 - gc) / 2 ? "A" : "T";
    }
    return bases.join("");
}

const COMPLEMENT = { A: "T", C: "G", G: "C", T: "A", N: "N" };

function reverseComplement(sequence) {
    let result = "";
    for (let index = sequence.length - 1; index >= 0; index -= 1) {
        result += COMPLEMENT[sequence[index]];
    }
    return result;
}

/** Contigs with a shared 800 bp segment (multi-mapping reads), a CA repeat and a poly-A run. */
function buildReference(random) {
    const shared = randomSequence(random, 800, 0.43);
    return CONTIGS.map((contig, index) => {
        let sequence = randomSequence(random, contig.length, contig.gc);
        const insertAt = index === 0 ? 9_000 : 15_000;
        sequence = sequence.slice(0, insertAt) + shared + sequence.slice(insertAt + shared.length);
        const repeatAt = index === 0 ? 4_200 : 6_100;
        const repeat = index === 0 ? "CA".repeat(30) : "A".repeat(25);
        sequence = sequence.slice(0, repeatAt) + repeat + sequence.slice(repeatAt + repeat.length);
        return { name: contig.name, sequence };
    });
}

/** The sequenced sample: the reference with homozygous SNPs and short indels. */
function buildSample(random, reference) {
    let snps = 0;
    let indels = 0;
    const contigs = reference.map(({ name, sequence }) => {
        const bases = sequence.split("");
        for (let index = 0; index < bases.length; index += 1) {
            if (random.chance(RATES.snp)) {
                bases[index] = random.pick(["A", "C", "G", "T"].filter((base) => base !== bases[index]));
                snps += 1;
            }
        }
        for (let count = 0; count < RATES.indelsPerContig; count += 1) {
            const at = random.int(500, bases.length - 500);
            const size = random.int(1, 4);
            if (random.chance(0.5)) {
                bases.splice(at, size);
            } else {
                bases.splice(at, 0, ...randomSequence(random, size, 0.5));
            }
            indels += 1;
        }
        return { name, sequence: bases.join("") };
    });
    return { contigs, snps, indels };
}

function phred(quality) {
    return String.fromCharCode(33 + quality);
}

const ERROR_PROBABILITY = Array.from({ length: 42 }, (_, quality) => Math.max(10 ** (-quality / 10), 0.0004));

/**
 * Qualities of one read: high at the start, falling towards the end with occasional dips; R2 is slightly
 * worse. `tailFrom` starts a low-quality tail; `failing` makes the whole read poor.
 */
function qualities(random, length, mate, { tailFrom = null, failing = false }) {
    const values = new Array(length);
    for (let index = 0; index < length; index += 1) {
        const position = index / READ_LENGTH;
        let mean = 37.5 - (mate === 2 ? 2.5 : 0) - 7 * position * position;
        if (failing) {
            mean = 11;
        } else if (tailFrom !== null && index >= tailFrom) {
            mean = 8;
        }
        let quality = Math.round(mean + random.normal() * (failing || index >= (tailFrom ?? length) ? 4 : 1.6));
        if (!failing && random.chance(0.03)) {
            quality -= random.int(8, 20);
        }
        values[index] = Math.min(41, Math.max(2, quality));
    }
    return values;
}

/** Applies substitution errors with the probability each base's quality states. */
function sequenceWithErrors(random, template, values) {
    let result = "";
    for (let index = 0; index < template.length; index += 1) {
        const base = template[index];
        if (base !== "N" && random.chance(ERROR_PROBABILITY[values[index]])) {
            result += random.pick(["A", "C", "G", "T"].filter((other) => other !== base));
        } else {
            result += base;
        }
    }
    return result;
}

/** The first READ_LENGTH bases sequenced from `insert`, reading into the adapter when the insert is shorter. */
function readTemplate(random, insert, adapter) {
    if (insert.length >= READ_LENGTH) {
        return { template: insert.slice(0, READ_LENGTH), adapter: false };
    }
    let template = insert + adapter;
    if (template.length < READ_LENGTH) {
        template += randomSequence(random, READ_LENGTH - template.length, 0.5);
    }
    return { template: template.slice(0, READ_LENGTH), adapter: true };
}

function fragmentLength(random, short) {
    if (short) {
        return random.int(70, 145);
    }
    return Math.min(700, Math.max(160, Math.round(330 + random.normal() * 60)));
}

function sliceFragment(random, source, length) {
    const start = random.int(0, source.length - length);
    const forward = source.slice(start, start + length);
    return random.chance(0.5) ? forward : reverseComplement(forward);
}

function simulate(options) {
    const random = createRandom(options.seed);
    const reference = buildReference(random);
    const sample = buildSample(random, reference);
    const contaminant = randomSequence(random, 12_000, 0.62);
    const totalLength = sample.contigs.reduce((sum, contig) => sum + contig.sequence.length, 0);

    const counts = {
        pairs: options.pairs,
        contaminant_pairs: 0,
        chimeric_pairs: 0,
        duplicate_pairs: 0,
        adapter_read_through_pairs: 0,
        low_quality_tail_reads: 0,
        failing_reads: 0,
        reads_with_n: 0,
    };
    const chunks = { 1: [], 2: [] };
    const fragments = [];

    const pickContig = () => {
        let position = random.int(0, totalLength - 1);
        for (const contig of sample.contigs) {
            if (position < contig.sequence.length) {
                return contig.sequence;
            }
            position -= contig.sequence.length;
        }
        return sample.contigs[0].sequence;
    };

    for (let pair = 0; pair < options.pairs; pair += 1) {
        let insert1;
        let insert2;
        if (fragments.length > 100 && random.chance(RATES.duplicatePairs)) {
            [insert1, insert2] = random.pick(fragments);
            counts.duplicate_pairs += 1;
        } else if (random.chance(RATES.chimericPairs)) {
            insert1 = sliceFragment(random, sample.contigs[0].sequence, 300);
            insert2 = sliceFragment(random, sample.contigs[1].sequence, 300);
            counts.chimeric_pairs += 1;
        } else {
            const isContaminant = random.chance(RATES.contaminantPairs);
            const source = isContaminant ? contaminant : pickContig();
            const fragment = sliceFragment(random, source, fragmentLength(random, random.chance(RATES.shortFragments)));
            insert1 = fragment;
            insert2 = reverseComplement(fragment);
            counts.contaminant_pairs += isContaminant ? 1 : 0;
        }
        if (fragments.length < 5_000) {
            fragments.push([insert1, insert2]);
        }

        const tile = 1101 + (pair % 4) * 100 + (Math.floor(pair / 4) % 60);
        const name = `${INSTRUMENT}:1:${tile}:${random.int(1000, 32000)}:${random.int(1000, 37000)}`;
        let adapter = false;
        for (const mate of [1, 2]) {
            const read = readTemplate(random, mate === 1 ? insert1 : insert2, mate === 1 ? ADAPTER_R1 : ADAPTER_R2);
            adapter ||= read.adapter;
            const failing = random.chance(RATES.failingReads);
            const tailFrom = !failing && random.chance(RATES.lowQualityTails) ? READ_LENGTH - random.int(25, 70) : null;
            const values = qualities(random, READ_LENGTH, mate, { tailFrom, failing });
            let sequence = sequenceWithErrors(random, read.template, values);
            if (random.chance(RATES.readsWithN)) {
                const bases = sequence.split("");
                for (let count = random.int(6, 12); count > 0; count -= 1) {
                    const at = random.int(0, READ_LENGTH - 1);
                    bases[at] = "N";
                    values[at] = 2;
                }
                sequence = bases.join("");
                counts.reads_with_n += 1;
            }
            counts.failing_reads += failing ? 1 : 0;
            counts.low_quality_tail_reads += tailFrom !== null ? 1 : 0;
            chunks[mate].push(`@${name} ${mate}:N:0:${INDEX}\n${sequence}\n+\n${values.map(phred).join("")}\n`);
        }
        counts.adapter_read_through_pairs += adapter ? 1 : 0;
    }

    const fasta = reference
        .map(({ name, sequence }) => `>${name} synthetic demo contig\n${sequence.match(/.{1,60}/g).join("\n")}\n`)
        .join("");
    return {
        files: {
            "reference.fasta": Buffer.from(fasta),
            "demo_R1.fastq.gz": gzipSync(chunks[1].join(""), { level: 6 }),
            "demo_R2.fastq.gz": gzipSync(chunks[2].join(""), { level: 6 }),
        },
        reference: reference.map(({ name, sequence }) => ({ name, length: sequence.length })),
        variants: { snps: sample.snps, indels: sample.indels },
        counts,
    };
}

function sha256(data) {
    return createHash("sha256").update(data).digest("hex");
}

function upToDate(options, manifestPath) {
    if (options.force || !existsSync(manifestPath)) {
        return false;
    }
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (manifest.version !== VERSION || manifest.seed !== options.seed || manifest.pairs !== options.pairs) {
            return false;
        }
        return Object.entries(manifest.files).every(([name, file]) => {
            const path = join(options.out, name);
            return existsSync(path) && sha256(readFileSync(path)) === file.sha256;
        });
    } catch {
        return false;
    }
}

function main() {
    const options = parseArguments(process.argv.slice(2));
    const manifestPath = join(options.out, "manifest.json");
    if (upToDate(options, manifestPath)) {
        console.log(`Demo data in ${options.out} is up to date`);
        return;
    }
    const started = Date.now();
    const result = simulate(options);
    mkdirSync(options.out, { recursive: true });
    const files = {};
    for (const [name, data] of Object.entries(result.files)) {
        const path = join(options.out, name);
        writeFileSync(`${path}.tmp`, data);
        renameSync(`${path}.tmp`, path);
        files[name] = { bytes: data.length, sha256: sha256(data) };
    }
    const manifest = {
        version: VERSION,
        seed: options.seed,
        pairs: options.pairs,
        read_length: READ_LENGTH,
        reference: result.reference,
        variants: result.variants,
        simulated: result.counts,
        files,
    };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const total = Object.values(files).reduce((sum, file) => sum + file.bytes, 0);
    console.log(
        `Wrote ${Object.keys(files).join(", ")} (${(total / 1e6).toFixed(1)} MB) to ${options.out} ` +
            `in ${((Date.now() - started) / 1000).toFixed(1)} s`,
    );
}

main();
