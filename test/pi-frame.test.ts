/**
 * DOM-level tests for the <pi-frame> custom element (src/web/pi-frame.ts) — the
 * sandboxed host for extension-provided HTML/CSS/JS. These cover the parts that
 * are deterministic under happy-dom: the isolation posture (sandbox WITHOUT
 * allow-same-origin), the bootstrapped srcdoc document (theme vars + piweb
 * bridge + the caller's body html), height sizing, and the postMessage -> bubbling
 * CustomEvent bridge (piframe-action / piframe-notify) that keeps the host
 * decoupled from the frame. Full in-frame JS execution is a Layer 2 (Playwright)
 * concern; here we assert the wiring around the iframe.
 */
import { test, expect, afterEach } from "bun:test";
import "../src/web/pi-frame.ts";
import type { PiFrame } from "../src/web/pi-frame.ts";

function mount(
    opts: { html?: string; surfaceId?: string; height?: number | null } = {},
): PiFrame {
    const el = document.createElement("pi-frame") as PiFrame;
    el.surfaceId = opts.surfaceId ?? "surf-1";
    el.frameHtml = opts.html ?? "<div>hi</div>";
    if (opts.height !== undefined) el.frameHeight = opts.height;
    document.body.appendChild(el);
    return el;
}

afterEach(() => {
    document.querySelectorAll("pi-frame").forEach((el) => el.remove());
});

test("registers the custom element", () => {
    expect(customElements.get("pi-frame")).toBeDefined();
});

test("builds a sandboxed iframe that is NOT same-origin", () => {
    const el = mount();
    const iframe = el.querySelector("iframe")!;
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    // Critical isolation invariant: extension HTML must not get same-origin access.
    expect(sandbox).not.toContain("allow-same-origin");
});

test("srcdoc wraps the caller html with the theme + piweb bridge bootstrap", () => {
    const el = mount({ html: "<button data-action='go'>Go</button>" });
    const srcdoc = el.querySelector("iframe")!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain("<button data-action='go'>Go</button>");
    expect(srcdoc).toContain("window.piweb=");
    expect(srcdoc).toContain(":root{"); // injected theme vars block
});

test("auto-sizes to a default height when no frameHeight is given", () => {
    const el = mount({ height: null });
    expect(el.querySelector("iframe")!.style.height).toBe("80px");
});

test("honors a fixed pixel height", () => {
    const el = mount({ height: 240 });
    expect(el.querySelector("iframe")!.style.height).toBe("240px");
});

test("relays a frame `action` postMessage as a bubbling piframe-action event", () => {
    const el = mount({ surfaceId: "panel-x" });
    const iframe = el.querySelector("iframe") as HTMLIFrameElement;

    let detail: any = null;
    document.addEventListener(
        "piframe-action",
        (e: any) => (detail = e.detail),
        { once: true },
    );

    // Simulate the sandboxed frame posting an action (source identifies our frame).
    window.dispatchEvent(
        new MessageEvent("message", {
            data: {
                __piweb: true,
                type: "action",
                action: "go",
                payload: { n: 1 },
            },
            source: iframe.contentWindow as Window,
        }),
    );

    expect(detail).not.toBeNull();
    expect(detail.surfaceId).toBe("panel-x");
    expect(detail.action).toBe("go");
    expect(detail.payload).toEqual({ n: 1 });
});

test("relays a frame `notify` postMessage as a bubbling piframe-notify event", () => {
    const el = mount();
    const iframe = el.querySelector("iframe") as HTMLIFrameElement;

    let detail: any = null;
    document.addEventListener(
        "piframe-notify",
        (e: any) => (detail = e.detail),
        { once: true },
    );

    window.dispatchEvent(
        new MessageEvent("message", {
            data: {
                __piweb: true,
                type: "notify",
                message: "done",
                level: "warn",
            },
            source: iframe.contentWindow as Window,
        }),
    );

    expect(detail?.message).toBe("done");
    expect(detail?.level).toBe("warn");
});

test("ignores messages that are not from this frame's window", () => {
    const el = mount();
    let fired = false;
    document.addEventListener("piframe-action", () => (fired = true), {
        once: true,
    });

    // A message with no matching source (e.g. some other window) must be ignored.
    window.dispatchEvent(
        new MessageEvent("message", {
            data: { __piweb: true, type: "action", action: "go", payload: {} },
            source: null,
        }),
    );

    expect(fired).toBe(false);
});
