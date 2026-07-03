/**
 * DOM-level tests for the <pi-tool> custom element (src/web/pi-tool.ts) — the
 * first "Layer 1" front-end suite, proving the happy-dom harness (bunfig.toml
 * preload -> test/setup-dom.ts) lets us instantiate real Web Components and
 * drive them the way the host does: feed SSE `tool` frames via apply(), toggle
 * expansion, and assert the rendered DOM.
 *
 * The importing of pi-tool.ts registers <pi-tool> via customElements.define,
 * which only works because the preload installed `customElements`/`HTMLElement`.
 */
import { test, expect } from "bun:test";
import "../src/web/pi-tool.ts";
import type { PiTool } from "../src/web/pi-tool.ts";

/** Create a connected <pi-tool> (connectedCallback -> initial render). */
function mount(): PiTool {
    const el = document.createElement("pi-tool") as PiTool;
    document.body.appendChild(el);
    return el;
}

test("registers the custom element", () => {
    expect(customElements.get("pi-tool")).toBeDefined();
});

test("a pending start frame tints the card and shows the header", () => {
    const el = mount();
    el.apply(
        {
            id: "t1",
            name: "bash",
            args: { command: "ls -la" },
            status: "start",
        },
        "/repo",
    );

    // Status is conveyed by class tint, not a glyph (matches pi-tui).
    expect(el.classList.contains("tool")).toBe(true);
    expect(el.classList.contains("pending")).toBe(true);
    expect(el.classList.contains("error")).toBe(false);

    // Header renders the bash title: pi-tui shows bash as `$` (bold name slot)
    // with the command accented in the args slot.
    expect(el.querySelector(".tool-name")?.textContent).toBe("$");
    expect(el.querySelector(".tool-args")?.textContent).toBe("ls -la");
    // No result body while pending.
    expect(el.querySelector(".tool-body")).toBeNull();

    el.remove();
});

test("an end frame drops pending and renders the result body", () => {
    const el = mount();
    el.apply(
        {
            id: "t1",
            name: "bash",
            args: { command: "echo hi" },
            status: "start",
        },
        "/repo",
    );
    el.apply({ id: "t1", status: "end", result: "hi\n" }, "/repo");

    expect(el.classList.contains("pending")).toBe(false);
    const body = el.querySelector(".tool-body");
    expect(body?.textContent).toContain("hi");

    el.remove();
});

test("an error end frame adds the .error tint", () => {
    const el = mount();
    el.apply({ id: "t1", name: "bash", status: "start" }, "/repo");
    el.apply(
        { id: "t1", status: "end", result: "boom", isError: true },
        "/repo",
    );

    expect(el.classList.contains("error")).toBe(true);
    expect(el.classList.contains("pending")).toBe(false);

    el.remove();
});

test("long results collapse with an 'earlier lines' hint until expanded", () => {
    const el = mount();
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    el.apply({ id: "t1", name: "bash", status: "start" }, "/repo");
    el.apply({ id: "t1", status: "end", result: long }, "/repo");

    // Collapsed: a "more" affordance appears (mentions alt+o) and not all lines show.
    const more = el.querySelector(".tool-more");
    expect(more?.textContent).toContain("alt+o");
    const collapsedLines = el
        .querySelector(".tool-body")!
        .textContent!.split("\n").length;
    expect(collapsedLines).toBeLessThan(40);

    // Expanded: the full body is shown.
    el.toggleExpanded();
    const expandedLines = el
        .querySelector(".tool-body")!
        .textContent!.split("\n").length;
    expect(expandedLines).toBe(40);

    el.remove();
});

test("setExpanded drives state idempotently (pi ui.setToolsExpanded fan-out)", () => {
    const el = mount();
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    el.apply({ id: "t1", name: "bash", status: "start" }, "/repo");
    el.apply({ id: "t1", status: "end", result: long }, "/repo");

    const lineCount = () =>
        el.querySelector(".tool-body")!.textContent!.split("\n").length;
    expect(lineCount()).toBeLessThan(40); // collapsed by default
    el.setExpanded(true);
    expect(el.info.expanded).toBe(true);
    expect(lineCount()).toBe(40);
    // idempotent: setting the same state is a no-op
    el.setExpanded(true);
    expect(lineCount()).toBe(40);
    el.setExpanded(false);
    expect(lineCount()).toBeLessThan(40);

    el.remove();
});

test("clicking the collapsed 'more' affordance expands the body", () => {
    const el = mount();
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    el.apply({ id: "t1", name: "bash", status: "start" }, "/repo");
    el.apply({ id: "t1", status: "end", result: long }, "/repo");

    (el.querySelector(".tool-more") as HTMLElement).click();

    const lines = el
        .querySelector(".tool-body")!
        .textContent!.split("\n").length;
    expect(lines).toBe(40);

    el.remove();
});
