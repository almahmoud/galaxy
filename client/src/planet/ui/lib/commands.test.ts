// @vitest-environment node
import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

import { clusterCommands, localClusterCommands } from "./commands";
import { CLUSTER, GARAGE } from "./presets";

const DOCS = resolve(__dirname, "../../../../../planet/docs");
const CLUSTER_GUIDE = readFileSync(resolve(DOCS, "cluster-setup.md"), "utf-8");
const STORAGE_GUIDE = readFileSync(resolve(DOCS, "storage-setup.md"), "utf-8");

/** Documented commands that manage the kind cluster rather than set it up. */
const NOT_SETUP_STEPS = ["planet/scripts/dev-cluster.sh status", "planet/scripts/dev-cluster.sh down"];

/** Lines of the document's code blocks in `languages`, with continuation lines joined and comments removed. */
function codeLines(markdown: string, languages: string[]): string[] {
    const lines: string[] = [];
    for (const [, language, body] of markdown.matchAll(/^ *```(\w+)\n([\s\S]*?)^ *```$/gm)) {
        if (!languages.includes(language!)) {
            continue;
        }
        for (const line of body!.replace(/\\\n\s*/g, "").split("\n")) {
            const command = line.replace(/\s+#\s.*$/, "").trim();
            if (command) {
                lines.push(command);
            }
        }
    }
    return lines;
}

/** Cells after the first of the table row whose first cell is `name`. */
function tableRow(markdown: string, name: string): string[] {
    const row = markdown.split("\n").find((line) => line.startsWith(`| ${name} |`));
    return row
        ? row
              .split("|")
              .slice(2, -1)
              .map((cell) => cell.trim())
        : [];
}

describe("setup guides", () => {
    it("document every setup command, and the setup page shows every documented one", () => {
        const documented = [CLUSTER_GUIDE, STORAGE_GUIDE].flatMap((guide) => codeLines(guide, ["sh", "bash"]));
        const forPlanet = documented.filter(
            (command) =>
                command.startsWith(`kubectl -n ${CLUSTER.namespace} `) ||
                command.startsWith("kubectl apply -k planet/deploy/") ||
                command.startsWith("planet/scripts/"),
        );
        expect(forPlanet).toEqual(expect.arrayContaining(NOT_SETUP_STEPS));

        const shown = [...clusterCommands(), ...localClusterCommands()].map((step) => step.command);
        const steps = forPlanet.filter((command) => !NOT_SETUP_STEPS.includes(command));
        expect([...new Set(shown)].sort()).toEqual([...new Set(steps)].sort());

        const origin = clusterCommands({ origin: "https://planet.mylab.org" })[0]!.command;
        expect(codeLines(CLUSTER_GUIDE, ["nginx"])).toContain(origin);
    });

    it("use the default settings", () => {
        expect(tableRow(CLUSTER_GUIDE, "Gateway URL")[0]?.split(",")[0]).toBe(`\`${CLUSTER.gatewayUrl}\``);
        expect(tableRow(CLUSTER_GUIDE, "Namespace")).toEqual([`\`${CLUSTER.namespace}\``]);
        expect(tableRow(CLUSTER_GUIDE, "Job service account")).toEqual([`\`${CLUSTER.jobServiceAccount}\``]);

        const garage = (name: string) => tableRow(STORAGE_GUIDE, name)[2];
        expect(garage("Endpoint")).toBe(`\`${GARAGE.endpoint}\``);
        expect(garage("Cluster endpoint")).toBe(`\`${GARAGE.clusterEndpoint}\``);
        expect(garage("Region")).toBe(`\`${GARAGE.region}\``);
        expect(garage("Bucket")).toBe(`\`${GARAGE.bucket}\``);
        expect(garage("Path-style")).toBe(GARAGE.pathStyle ? "on" : "off");
    });
});
