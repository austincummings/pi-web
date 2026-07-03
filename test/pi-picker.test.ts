/**
 * DOM-level tests for the <pi-picker> custom element (src/web/pi-picker.ts) —
 * the modal overlay chrome + generic keyboard navigation extracted from app.ts.
 *
 * These cover the seam the extraction buys: the .picker card the host builds
 * into, show/hide visibility (and the nav/items/index reset on hide), the
 * generic Up/Down/Home/End/Enter loop gated by `nav`, the keyGuard seam the
 * host uses to claim feature keys (Ctrl+D delete etc.) first, the backdrop
 * event, and document-listener cleanup on disconnect.
 */
import { test, expect, afterEach } from "bun:test";
import "../src/web/pi-picker.ts";
import { type PiPicker } from "../src/web/pi-picker.ts";

function mount(): PiPicker {
    const el = document.createElement("pi-picker") as PiPicker;
    document.body.appendChild(el);
    return el;
}

function docKey(key: string, opts: KeyboardEventInit = {}) {
    const e = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...opts,
    });
    document.dispatchEvent(e);
    return e;
}

// Populate the picker with n clickable rows; return the rows + a click log.
function rows(el: PiPicker, n: number) {
    const clicks: number[] = [];
    el.items = [];
    for (let i = 0; i < n; i++) {
        const item = document.createElement("div");
        item.className = "item";
        item.onclick = () => clicks.push(i);
        el.card.appendChild(item);
        el.items.push(item);
    }
    return clicks;
}

afterEach(() => {
    document.querySelectorAll("pi-picker").forEach((el) => el.remove());
});

test("registers the custom element", () => {
    expect(customElements.get("pi-picker")).toBeDefined();
});

test("builds a .picker card exposed via card", () => {
    const el = mount();
    const card = el.querySelector(".picker") as HTMLElement;
    expect(card).not.toBeNull();
    expect(el.card).toBe(card);
});

test("show()/hide() toggle the .show class and visible", () => {
    const el = mount();
    expect(el.visible).toBe(false);
    el.show();
    expect(el.classList.contains("show")).toBe(true);
    expect(el.visible).toBe(true);
    el.hide();
    expect(el.visible).toBe(false);
});

test("hide() resets nav / items / index", () => {
    const el = mount();
    rows(el, 3);
    el.nav = true;
    el.setSel(2);
    expect(el.index).toBe(2);
    el.hide();
    expect(el.nav).toBe(false);
    expect(el.items.length).toBe(0);
    expect(el.index).toBe(-1);
});

test("setSel wraps and toggles the .sel class", () => {
    const el = mount();
    rows(el, 3);
    el.setSel(0);
    expect(el.items[0].classList.contains("sel")).toBe(true);
    el.setSel(el.index + 1);
    expect(el.items[1].classList.contains("sel")).toBe(true);
    expect(el.items[0].classList.contains("sel")).toBe(false);
    el.setSel(-1); // wrap to last
    expect(el.items[2].classList.contains("sel")).toBe(true);
});

test("nav loop: ArrowDown/Up/Home/End move selection when nav + visible", () => {
    const el = mount();
    rows(el, 4);
    el.nav = true;
    el.show();
    el.setSel(0);
    docKey("ArrowDown");
    expect(el.index).toBe(1);
    docKey("End");
    expect(el.index).toBe(3);
    docKey("ArrowDown"); // wrap to first
    expect(el.index).toBe(0);
    docKey("ArrowUp"); // wrap to last
    expect(el.index).toBe(3);
    docKey("Home");
    expect(el.index).toBe(0);
});

test("nav loop: Enter clicks the highlighted row", () => {
    const el = mount();
    const clicks = rows(el, 3);
    el.nav = true;
    el.show();
    el.setSel(1);
    docKey("Enter");
    expect(clicks).toEqual([1]);
});

test("nav loop is inert when nav is false or not visible", () => {
    const el = mount();
    rows(el, 3);
    el.setSel(0);
    // nav=false, visible=false
    docKey("ArrowDown");
    expect(el.index).toBe(0);
    // visible but nav still false
    el.show();
    docKey("ArrowDown");
    expect(el.index).toBe(0);
    // nav true but hidden
    el.hide();
    rows(el, 3);
    el.nav = true;
    el.setSel(0);
    docKey("ArrowDown");
    expect(el.index).toBe(0);
});

test("keyGuard claims a key before the generic nav loop", () => {
    const el = mount();
    rows(el, 3);
    el.nav = true;
    el.show();
    el.setSel(0);
    const seen: string[] = [];
    el.keyGuard = (e) => {
        seen.push(e.key);
        return e.key === "ArrowDown"; // claim ArrowDown only
    };
    docKey("ArrowDown"); // claimed -> selection unchanged
    expect(el.index).toBe(0);
    docKey("End"); // not claimed -> generic loop runs
    expect(el.index).toBe(2);
    expect(seen).toEqual(["ArrowDown", "End"]);
});

test("nav loop ignores an already-defaultPrevented key", () => {
    const el = mount();
    rows(el, 3);
    el.nav = true;
    el.show();
    el.setSel(0);
    const e = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
    });
    e.preventDefault(); // e.g. the keystroke that opened the picker
    document.dispatchEvent(e);
    expect(el.index).toBe(0);
});

test("backdrop click emits pi-picker-backdrop; card clicks do not", () => {
    const el = mount();
    const hits: number[] = [];
    el.addEventListener("pi-picker-backdrop", () => hits.push(1));
    el.card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(hits.length).toBe(0);
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(hits.length).toBe(1);
});

test("disconnect removes the document nav listener", () => {
    const el = mount();
    rows(el, 3);
    el.nav = true;
    el.show();
    el.setSel(0);
    el.remove();
    docKey("ArrowDown");
    expect(el.index).toBe(0);
});
