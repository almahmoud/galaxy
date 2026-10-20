import { describe, expect, it } from "vitest";

import { DEFAULT_SLOT_COUNT, MAX_UPLOAD_SLOTS, uploadLimitProblem, uploadSlotCount } from "./limits";

function urls(count: number) {
    return Array.from({ length: count }, (_, index) => ({ src: "url", url: `https://example.org/${index}.txt` }));
}

describe("upload limits", () => {
    it("allocates slots for collection elements and expanded archives only", () => {
        const targets = [
            { destination: { type: "hdas" }, elements: urls(3) },
            { destination: { type: "hdca" }, collection_type: "list", elements: urls(2) },
            { destination: { type: "hdas" }, elements_from: "archive", src: "url", url: "https://example.org/a.zip" },
        ];
        expect(uploadSlotCount(targets)).toBe(2 + DEFAULT_SLOT_COUNT);
    });

    it("counts the datasets of hdas targets towards the cap", () => {
        const half = Math.floor(MAX_UPLOAD_SLOTS / 2) + 1;
        expect(uploadLimitProblem([{ destination: { type: "hdas" }, elements: urls(MAX_UPLOAD_SLOTS) }])).toBeNull();
        expect(uploadLimitProblem([{ destination: { type: "hdas" }, elements: urls(MAX_UPLOAD_SLOTS + 1) }])).toBe(
            `This upload creates ${MAX_UPLOAD_SLOTS + 1} datasets; one upload can create at most ${MAX_UPLOAD_SLOTS}. ` +
                "Split it into several uploads.",
        );
        const mixed = [
            { destination: { type: "hdas" }, elements: urls(half) },
            { destination: { type: "hdca" }, collection_type: "list", elements: urls(half) },
        ];
        expect(uploadLimitProblem(mixed)).toContain(`creates ${2 * half} datasets`);
        expect(uploadLimitProblem("not a list")).toBeNull();
    });
});
