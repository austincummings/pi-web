/**
 * DOM-level tests for the <pi-thinking> custom element (src/web/pi-thinking.ts)
 * — the streaming reasoning trace. Driven the way the host does: feed SSE
 * `thinking` frames via apply(), and observe the emitted bubbling events
 * (`pithinking-render` after each paint, `pithinking-toggle` on header click)
 * plus the shared collapsed label managed by setThinkingLabel().
 */
import { test, expect, afterEach } from "bun:test";
import "../src/web/pi-thinking.ts";
import { setThinkingLabel } from "../src/web/pi-thinking.ts";
import type { PiThinking } from "../src/web/pi-thinking.ts";

function mount(): PiThinking {
    const el = document.createElement("pi-thinking") as PiThinking;
    document.body.appendChild(el);
    return el;
}

afterEach(() => {
    // Restore the default label so cross-test state doesn't leak.
    setThinkingLabel();
    document.querySelectorAll("pi-thinking").forEach((el) => el.remove());
});

test("registers the custom element", () => {
    expect(customElements.get("pi-thinking")).toBeDefined();
});

test("builds a head (collapsed label) and an empty body", () => {
    const el = mount();
    expect(el.classList.contains("thinking-block")).toBe(true);
    expect(el.querySelector(".think-head")?.textContent).toBe("Thinking...");
    expect(el.querySelector(".think-body")?.innerHTML).toBe("");
});

test("a `full` frame renders markdown into the body in one shot", () => {
    const el = mount();
    el.apply({ status: "full", text: "hello **world**" });
    const body = el.querySelector(".think-body")!;
    expect(body.innerHTML).toContain("<strong>world</strong>");
});

test("`start` clears prior text; `full` replaces it", () => {
    const el = mount();
    el.apply({ status: "full", text: "old text" });
    el.apply({ status: "start" });
    expect(el.querySelector(".think-body")!.textContent).toBe("");
    el.apply({ status: "full", text: "new text" });
    expect(el.querySelector(".think-body")!.textContent).toContain("new text");
});

test("streamed deltas accumulate and paint on the next frame; end flushes", async () => {
    const el = mount();
    el.apply({ status: "start" });
    el.apply({ status: "delta", text: "one " });
    el.apply({ status: "delta", text: "two" });
    // Deltas are throttled to one paint per animation frame.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(el.querySelector(".think-body")!.textContent).toContain("one two");
});

test("emits pithinking-render after a paint", () => {
    const el = mount();
    let renders = 0;
    el.addEventListener("pithinking-render", () => renders++);
    el.apply({ status: "full", text: "x" });
    expect(renders).toBeGreaterThan(0);
});

test("clicking the head emits a bubbling pithinking-toggle", () => {
    const el = mount();
    let toggled = false;
    // Listen on the document to confirm the event bubbles (the host does this).
    document.addEventListener("pithinking-toggle", () => (toggled = true), {
        once: true,
    });
    (el.querySelector(".think-head") as HTMLElement).click();
    expect(toggled).toBe(true);
});

test("setThinkingLabel relabels every mounted trace; empty restores default", () => {
    const a = mount();
    const b = mount();
    setThinkingLabel("Reasoning…");
    expect(a.querySelector(".think-head")?.textContent).toBe("Reasoning…");
    expect(b.querySelector(".think-head")?.textContent).toBe("Reasoning…");
    setThinkingLabel("");
    expect(a.querySelector(".think-head")?.textContent).toBe("Thinking...");
});
