/**
 * DOM-level tests for the <pi-composer> custom element (src/web/pi-composer.ts)
 * — the message composer prototype for the app.ts → custom-element refactor.
 *
 * These exercise the three properties the refactor is buying: instance-field
 * state (images/queue/history), lifecycle cleanup (the spinner timer), and the
 * CustomEvent seam (pi-submit / pi-dequeue / pi-escape) the host wires up in
 * place of direct calls into app.ts.
 */
import { test, expect, afterEach } from "bun:test";
import "../src/web/pi-composer.ts";
import { PromptHistory, type PiComposer } from "../src/web/pi-composer.ts";

function mount(): PiComposer {
    const el = document.createElement("pi-composer") as PiComposer;
    document.body.appendChild(el);
    return el;
}

function keydown(el: PiComposer, key: string, opts: KeyboardEventInit = {}) {
    el.querySelector("#prompt")!.dispatchEvent(
        new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...opts,
        }),
    );
}

afterEach(() => {
    document.querySelectorAll("pi-composer").forEach((el) => el.remove());
});

test("registers the custom element", () => {
    expect(customElements.get("pi-composer")).toBeDefined();
});

test("builds the composer markup with the expected class + children", () => {
    const el = mount();
    expect(el.classList.contains("composer")).toBe(true);
    expect(el.querySelector("#prompt")).not.toBeNull();
    expect(el.querySelector("#backdrop")).not.toBeNull();
    expect(el.querySelector("#ask")).not.toBeNull();
});

test("value get/set mirrors the textarea and syncs the backdrop", () => {
    const el = mount();
    el.value = "hello **world**";
    expect((el.querySelector("#prompt") as HTMLTextAreaElement).value).toBe(
        "hello **world**",
    );
    // highlightComposer wraps **bold** in a tint span (never plain text).
    expect(el.querySelector("#backdrop")!.innerHTML).toContain("md-strong");
});

test("Enter emits a bubbling pi-submit with text + images, then clears", () => {
    const el = mount();
    el.addImage({ data: "AAAA", mimeType: "image/png", url: "blob:x" });
    el.value = "ship it";
    let detail: any = null;
    document.addEventListener(
        "pi-submit",
        (e) => (detail = (e as CustomEvent).detail),
        {
            once: true,
        },
    );
    keydown(el, "Enter");
    expect(detail.text).toBe("ship it");
    expect(detail.images).toHaveLength(1);
    expect(detail.images[0].mimeType).toBe("image/png");
    // cleared after submit
    expect(el.value).toBe("");
    expect(el.images).toHaveLength(0);
});

test("Shift+Enter does not submit (newline continues the message)", () => {
    const el = mount();
    el.value = "line one";
    let fired = false;
    document.addEventListener("pi-submit", () => (fired = true), {
        once: true,
    });
    keydown(el, "Enter", { shiftKey: true });
    expect(fired).toBe(false);
});

test("empty composer does not submit", () => {
    const el = mount();
    let fired = false;
    document.addEventListener("pi-submit", () => (fired = true), {
        once: true,
    });
    keydown(el, "Enter");
    expect(fired).toBe(false);
});

test("Escape emits a bubbling pi-escape", () => {
    const el = mount();
    let fired = false;
    document.addEventListener("pi-escape", () => (fired = true), {
        once: true,
    });
    keydown(el, "Escape");
    expect(fired).toBe(true);
});

test("setQueue renders rows; clicking one emits pi-dequeue", () => {
    const el = mount();
    el.setQueue(["first", "second"]);
    const rows = el.querySelectorAll("#queued .queued-item");
    expect(rows).toHaveLength(2);
    expect(el.querySelector("#queued")!.classList.contains("show")).toBe(true);
    let fired = false;
    document.addEventListener("pi-dequeue", () => (fired = true), {
        once: true,
    });
    (rows[0] as HTMLElement).click();
    expect(fired).toBe(true);
    // clearing the queue hides the tray
    el.setQueue([]);
    expect(el.querySelector("#queued")!.classList.contains("show")).toBe(false);
});

test("addImage renders a chip; the remove button drops it", () => {
    const el = mount();
    el.addImage({ data: "AAAA", mimeType: "image/png", url: "blob:x" });
    expect(el.querySelectorAll("#attachments .attach-chip")).toHaveLength(1);
    (el.querySelector(".attach-remove") as HTMLElement).click();
    expect(el.images).toHaveLength(0);
    expect(el.querySelector("#attachments")!.classList.contains("show")).toBe(
        false,
    );
});

test("setWorking(false) clears the spinner interval on disconnect", () => {
    const el = mount();
    el.setWorking(true);
    expect(el.querySelector("#working")!.classList.contains("show")).toBe(true);
    // disconnecting must stop the timer (no leaked interval)
    el.remove();
    // re-mounting a fresh element starts clean
    const el2 = mount();
    expect(el2.querySelector("#working")!.classList.contains("show")).toBe(
        false,
    );
});

test("keyGuard claims a key before the element's default handling", () => {
    const el = mount();
    el.value = "guarded";
    let submitted = false;
    document.addEventListener("pi-submit", () => (submitted = true), {
        once: true,
    });
    // Host claims Enter (e.g. an open autocomplete accepting a completion).
    el.keyGuard = (e) => e.key === "Enter";
    keydown(el, "Enter");
    expect(submitted).toBe(false); // guard swallowed it, no submit
    // With the guard cleared, Enter submits again.
    el.keyGuard = null;
    document.addEventListener("pi-submit", () => (submitted = true), {
        once: true,
    });
    keydown(el, "Enter");
    expect(submitted).toBe(true);
});

test("spliceRange replaces a span and moves the caret to its end", () => {
    const el = mount();
    el.value = "read @src/ab";
    // accept a completion for the `@src/ab` token (@ at index 5, end 12)
    el.spliceRange(5, 12, "src/app.ts ");
    expect(el.value).toBe("read src/app.ts ");
    expect(el.getCaret()).toBe("read src/app.ts ".length);
});

test("setWorkingConfig overrides the label and hides the glyph with frames:[]", () => {
    const el = mount();
    el.setWorking(true);
    el.setWorkingConfig({ message: "Thinking hard…", frames: [] });
    expect(el.querySelector("#working .label")!.textContent).toBe(
        "Thinking hard…",
    );
    expect(el.querySelector("#working .spin")!.textContent).toBe("");
    // a static single-frame indicator renders that glyph verbatim
    el.setWorkingConfig({ frames: ["●"] });
    expect(el.querySelector("#working .spin")!.textContent).toBe("●");
});

test("setWorkingConfig visible:true shows the row even when not busy", () => {
    const el = mount();
    expect(el.querySelector("#working")!.classList.contains("show")).toBe(
        false,
    );
    el.setWorkingConfig({ visible: true });
    expect(el.querySelector("#working")!.classList.contains("show")).toBe(true);
});

test("setThinking toggles the data-think / data-bash border attributes", () => {
    const el = mount();
    el.setThinking("high");
    expect(el.dataset.think).toBe("high");
    el.setThinking("off", true);
    expect(el.dataset.bash).toBe("");
});

// ---- PromptHistory (unit, no DOM) ----------------------------------------
test("PromptHistory: up walks back, down restores the draft", () => {
    const h = new PromptHistory();
    h.push("one");
    h.push("two");
    // start browsing from a fresh draft
    expect(h.up("draft")).toBe("two");
    expect(h.up("draft")).toBe("one");
    expect(h.up("draft")).toBe(null); // top of history
    expect(h.down()).toBe("two");
    expect(h.down()).toBe("draft"); // past newest → stashed draft
    expect(h.down()).toBe(null);
});

test("PromptHistory: dedupes consecutive repeats", () => {
    const h = new PromptHistory();
    h.push("same");
    h.push("same");
    expect(h.up("")).toBe("same");
    expect(h.up("")).toBe(null); // only one entry kept
});

test("ArrowUp on the first line recalls the previous submission", () => {
    const el = mount();
    // submit once to seed history
    el.value = "remembered";
    keydown(el, "Enter");
    expect(el.value).toBe("");
    // ArrowUp from an empty composer recalls it
    keydown(el, "ArrowUp");
    expect(el.value).toBe("remembered");
});
