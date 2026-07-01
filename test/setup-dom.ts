// Preloaded by `bun test` (see bunfig.toml) to give the DOM-level suites a
// browser-like global environment — `document`, `customElements`, `CustomEvent`,
// `HTMLElement`, etc. — via happy-dom, with no real browser binary required.
//
// This is the foundation of the front-end "Layer 1" tests: because the pi-web
// web UI is built from Web Components (`<pi-tool>`, `<pi-frame>`, …) registered
// through `customElements.define`, importing those modules under bun test only
// works once these globals exist. Registering here (before any test module is
// evaluated) means a plain `import "../src/web/pi-tool.ts"` just works.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom's global registration also swaps in a *browser* fetch/Response/etc.
// that enforces the same-origin policy. That breaks the non-DOM transport suites
// (test/app.test.mjs, test/router.test.mjs), which boot the real host on an
// ephemeral 127.0.0.1 port and read SSE via fetch(). Capture Bun's native
// networking globals first, register happy-dom for the DOM (document,
// customElements, HTMLElement, CustomEvent), then restore the native ones so
// server-facing fetches behave exactly as they did before this preload existed.
const native = {
    fetch: globalThis.fetch,
    Response: globalThis.Response,
    Request: globalThis.Request,
    Headers: globalThis.Headers,
    WebSocket: globalThis.WebSocket,
};

GlobalRegistrator.register();

Object.assign(globalThis, native);
