/**
 * DOM-level tests for the <pi-bash> custom element (src/web/pi-bash.ts) — one
 * user-run `!`/`!!` shell command in the transcript. Driven the way the host
 * does: feed SSE `bash` frames via apply() (start -> chunk… -> end) and assert
 * the rendered command header, streamed output, collapse/expand, the running
 * spinner footer, and the exit/cancel status parts.
 *
 * Each element is removed in afterEach so its spinner setInterval is cleared
 * (disconnectedCallback), keeping the test runner from hanging on a live timer.
 */
import { test, expect, afterEach } from "bun:test";
import "../src/web/pi-bash.ts";
import type { PiBash } from "../src/web/pi-bash.ts";

function mount(): PiBash {
    const el = document.createElement("pi-bash") as PiBash;
    document.body.appendChild(el);
    return el;
}

afterEach(() => {
    document.querySelectorAll("pi-bash").forEach((el) => el.remove());
});

test("registers the custom element", () => {
    expect(customElements.get("pi-bash")).toBeDefined();
});

test("a start frame shows the `$ <command>` header and a running spinner", () => {
    const el = mount();
    el.apply({ status: "start", command: "ls -la" });
    expect(el.classList.contains("bash")).toBe(true);
    expect(el.querySelector(".bash-cmd")?.textContent).toBe("$ ls -la");
    // While running: a spinner footer, no exit status yet.
    expect(el.querySelector(".bash-run")).not.toBeNull();
    expect(el.querySelector(".bash-status")).toBeNull();
});

test("`!!` (excludeFromContext) tints the block with .excluded", () => {
    const el = mount();
    el.apply({
        status: "start",
        command: "echo secret",
        excludeFromContext: true,
    });
    expect(el.classList.contains("excluded")).toBe(true);
});

test("chunks stream into the output body; end stops the spinner", () => {
    const el = mount();
    el.apply({ status: "start", command: "echo hi" });
    el.apply({ status: "chunk", text: "hi\n" });
    expect(el.querySelector("pre.body")?.textContent).toContain("hi");
    el.apply({ status: "end", exitCode: 0 });
    // Clean exit: spinner gone, and no status line (matches pi-tui).
    expect(el.querySelector(".bash-run")).toBeNull();
    expect(el.querySelector(".bash-status")).toBeNull();
});

test("a non-zero exit renders an error status", () => {
    const el = mount();
    el.apply({ status: "start", command: "false" });
    el.apply({ status: "end", exitCode: 1 });
    const status = el.querySelector(".bash-status.err");
    expect(status?.textContent).toBe("(exit 1)");
});

test("a cancelled command renders a warn status", () => {
    const el = mount();
    el.apply({ status: "start", command: "sleep 100" });
    el.apply({ status: "end", cancelled: true });
    const status = el.querySelector(".bash-status.warn");
    expect(status?.textContent).toBe("(cancelled)");
});

test("long output collapses to a tail with a 'more lines' hint until expanded", () => {
    const el = mount();
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    el.apply({ status: "start", command: "seq 50" });
    el.apply({ status: "chunk", text: lines });
    el.apply({ status: "end", exitCode: 0 });

    // Collapsed: only the last 20 lines show, with a "… 30 more lines" hint.
    const more = el.querySelector(".bash-more") as HTMLElement;
    expect(more?.textContent).toBe("… 30 more lines");
    expect(el.querySelector("pre.body")!.textContent!.split("\n").length).toBe(
        20,
    );

    // Clicking the hint expands to the full output.
    more.click();
    expect(el.querySelector("pre.body")!.textContent!.split("\n").length).toBe(
        50,
    );
    expect(el.querySelector(".bash-more")?.textContent).toBe("collapse");
});

test("a truncation warning shows only when a full-output path exists", () => {
    const el = mount();
    el.apply({ status: "start", command: "big" });
    el.apply({
        status: "end",
        exitCode: 0,
        truncated: true,
        fullOutputPath: "/tmp/out.txt",
    });
    const warn = [...el.querySelectorAll(".bash-status.warn")].map(
        (n) => n.textContent,
    );
    expect(warn.some((t) => t?.includes("/tmp/out.txt"))).toBe(true);
});
