import { describe, expect, it, vi } from "vitest";

import { suppressJavascriptLinks } from "./links";

describe("suppressJavascriptLinks", () => {
    it("cancels javascript: links but keeps component click handlers", () => {
        suppressJavascriptLinks(document);
        document.body.innerHTML = `<a id="js" href=" JavaScript:void(0)"><span id="inner">x</span></a><a id="ok" href="#a">y</a>`;
        const handler = vi.fn();
        document.getElementById("js")!.addEventListener("click", handler);

        const jsClick = new MouseEvent("click", { bubbles: true, cancelable: true });
        document.getElementById("inner")!.dispatchEvent(jsClick);
        expect(jsClick.defaultPrevented).toBe(true);
        expect(handler).toHaveBeenCalledOnce();

        const okClick = new MouseEvent("click", { bubbles: true, cancelable: true });
        document.getElementById("ok")!.dispatchEvent(okClick);
        expect(okClick.defaultPrevented).toBe(false);
    });
});
