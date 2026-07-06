/**
 * DOM-level tests for the <pi-dialog> custom element (src/web/pi-dialog.ts) —
 * the blocking modal dialogs (select / confirm / input / editor) extracted from
 * app.ts as part of the custom-element refactor.
 *
 * These exercise the properties the extraction buys: instance-field state
 * (activeDialog/sel), the render() reconciliation against the surfaces
 * `dialogs` array, the CustomEvent seam (pi-dialog-answer / pi-dialog-open the
 * host wires to /ui-response), and lifecycle cleanup of the document-level
 * capture keydown listener.
 */
import { test, expect, afterEach } from "bun:test";
import "../src/web/pi-dialog.ts";
import { type PiDialog } from "../src/web/pi-dialog.ts";

function mount(): PiDialog {
    const el = document.createElement("pi-dialog") as PiDialog;
    document.body.appendChild(el);
    return el;
}

function docKey(key: string, opts: KeyboardEventInit = {}) {
    document.dispatchEvent(
        new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
            ...opts,
        }),
    );
}

// Capture pi-dialog-answer details for assertions.
function onAnswer(el: PiDialog) {
    const answers: any[] = [];
    el.addEventListener("pi-dialog-answer", (e) =>
        answers.push((e as CustomEvent).detail),
    );
    return answers;
}

afterEach(() => {
    document.querySelectorAll("pi-dialog").forEach((el) => el.remove());
});

test("registers the custom element", () => {
    expect(customElements.get("pi-dialog")).toBeDefined();
});

test("mounts a .dialog-card and stays hidden until render", () => {
    const el = mount();
    expect(el.querySelector(".dialog-card")).not.toBeNull();
    expect(el.classList.contains("show")).toBe(false);
});

test("render(select) shows the card, options, and highlights the first", () => {
    const el = mount();
    const opens: number[] = [];
    el.addEventListener("pi-dialog-open", () => opens.push(1));
    el.render([
        { id: "d1", dialog: "select", title: "Pick", options: ["a", "b", "c"] },
    ]);
    expect(el.classList.contains("show")).toBe(true);
    expect(opens.length).toBe(1);
    const rows = el.querySelectorAll(".item");
    expect(rows.length).toBe(3);
    expect(rows[0].classList.contains("sel")).toBe(true);
    expect(el.querySelector("h3")!.textContent).toBe("Pick");
});

test("select: arrows move the highlight (wrapping) and Enter answers", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([{ id: "d1", dialog: "select", options: ["a", "b", "c"] }]);
    docKey("ArrowDown");
    let rows = el.querySelectorAll(".item");
    expect(rows[1].classList.contains("sel")).toBe(true);
    docKey("ArrowUp");
    docKey("ArrowUp"); // wrap past top -> last
    rows = el.querySelectorAll(".item");
    expect(rows[2].classList.contains("sel")).toBe(true);
    docKey("Enter");
    expect(answers).toEqual([{ requestId: "d1", value: "c" }]);
});

test("select: clicking a row answers with that option", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([{ id: "d1", dialog: "select", options: ["x", "y"] }]);
    (el.querySelectorAll(".item")[1] as HTMLElement).click();
    expect(answers).toEqual([{ requestId: "d1", value: "y" }]);
});

test("confirm: OK answers true, and Escape answers false", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([
        { id: "c1", dialog: "confirm", title: "Sure?", message: "Really?" },
    ]);
    expect(el.querySelector(".dialog-msg")!.textContent).toBe("Really?");
    (el.querySelector("button.primary") as HTMLButtonElement).click();
    expect(answers).toEqual([{ requestId: "c1", value: true }]);
    // reopen, this time cancel via Escape
    el.render([{ id: "c2", dialog: "confirm", message: "?" }]);
    docKey("Escape");
    expect(answers[1]).toEqual({ requestId: "c2", value: false });
});

test("input: Enter submits the field value", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([{ id: "i1", dialog: "input", placeholder: "name" }]);
    const field = el.querySelector(".dialog-field") as HTMLInputElement;
    expect(field.tagName).toBe("INPUT");
    field.value = "hi";
    field.dispatchEvent(
        new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
        }),
    );
    expect(answers).toEqual([{ requestId: "i1", value: "hi" }]);
});

test("editor: multiline textarea, Enter is a newline, Ctrl+Enter saves", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([{ id: "e1", dialog: "editor", prefill: "abc" }]);
    const field = el.querySelector(".dialog-field") as HTMLTextAreaElement;
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.value).toBe("abc");
    // plain Enter does NOT submit an editor
    field.dispatchEvent(
        new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
        }),
    );
    expect(answers.length).toBe(0);
    field.dispatchEvent(
        new KeyboardEvent("keydown", {
            key: "Enter",
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        }),
    );
    expect(answers).toEqual([{ requestId: "e1", value: "abc" }]);
});

test("input/editor Escape answers null", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([{ id: "i1", dialog: "input" }]);
    docKey("Escape");
    expect(answers).toEqual([{ requestId: "i1", value: null }]);
});

test("render([]) hides the dialog and clears the card", () => {
    const el = mount();
    el.render([{ id: "d1", dialog: "select", options: ["a"] }]);
    el.render([]);
    expect(el.classList.contains("show")).toBe(false);
    expect(el.querySelector(".dialog-card")!.innerHTML).toBe("");
});

test("re-rendering the same id does not rebuild (preserves input text)", () => {
    const el = mount();
    el.render([{ id: "i1", dialog: "input" }]);
    const field = el.querySelector(".dialog-field") as HTMLInputElement;
    field.value = "half typed";
    el.render([{ id: "i1", dialog: "input" }]); // same id
    expect((el.querySelector(".dialog-field") as HTMLInputElement).value).toBe(
        "half typed",
    );
});

test("the most-recent dialog wins when several stack", () => {
    const el = mount();
    el.render([
        { id: "a", dialog: "confirm", message: "first" },
        { id: "b", dialog: "select", title: "second", options: ["z"] },
    ]);
    expect(el.querySelector("h3")!.textContent).toBe("second");
    expect(el.querySelectorAll(".item").length).toBe(1);
});

test("backdrop click cancels; clicks inside the card do not", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([{ id: "i1", dialog: "input" }]);
    // click inside the card — ignored
    (el.querySelector(".dialog-card") as HTMLElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
    );
    expect(answers.length).toBe(0);
    // click the backdrop (the element itself) — cancels
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(answers).toEqual([{ requestId: "i1", value: null }]);
});

test("disconnect removes the document keydown listener", () => {
    const el = mount();
    const answers = onAnswer(el);
    el.render([{ id: "d1", dialog: "select", options: ["a", "b"] }]);
    el.remove();
    docKey("Escape"); // should be a no-op now
    expect(answers.length).toBe(0);
});

test("keys are ignored when no dialog is open", () => {
    const el = mount();
    const answers = onAnswer(el);
    docKey("Escape");
    docKey("Enter");
    docKey("ArrowDown");
    expect(answers.length).toBe(0);
});
