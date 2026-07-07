/**
 * Minimal static harness for the Playwright component tests.
 *
 * It serves one page that mounts the *real* bundled `<pi-composer>` element (no
 * agent host, no SSE) and records the CustomEvents it emits on `window.__events`
 * so the specs can assert on the event seam in a real browser — exercising true
 * caret math, real Enter / Shift+Enter defaults, focus, and paste that happy-dom
 * can only approximate.
 *
 * The element is bundled on demand with Bun.build (same path as the app), so the
 * harness always tests the current source.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "web",
);
const PORT = Number(process.env.HARNESS_PORT ?? 4399);

async function bundle(entry: string): Promise<string> {
    const result = await Bun.build({
        entrypoints: [join(WEB, entry)],
        target: "browser",
        format: "esm",
        sourcemap: "inline",
    });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    return result.outputs[0].text();
}

const PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>pi-composer harness</title></head>
<body>
  <pi-composer id="composer"></pi-composer>
  <script type="module">
    import "/pi-composer.js";
    window.__events = [];
    const record = (name) => (e) =>
      window.__events.push({ name, detail: e.detail ?? null });
    const el = document.getElementById("composer");
    for (const evt of ["pi-submit", "pi-dequeue", "pi-escape", "pi-input"])
      el.addEventListener(evt, record(evt));
    // Expose the element for imperative driving from specs.
    window.composer = el;
    window.__ready = true;
  </script>
</body>
</html>`;

// <pi-dialog> harness: mounts the real bundled element (plus the app's dialog
// CSS so real clicks/backdrop hit-testing behave) and records its CustomEvents.
const DIALOG_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>pi-dialog harness</title>
<style>
  #dialog { position: fixed; inset: 0; background: rgba(0,0,0,.5);
    display: none; align-items: flex-start; justify-content: center; z-index: 60; }
  #dialog.show { display: flex; }
  .dialog-card { margin-top: 16vh; background: #222; border: 1px solid #444;
    border-radius: 10px; width: min(560px, 90vw); max-height: 68vh; overflow: auto; }
  .dialog-card h3 { margin: 0; padding: 12px 14px; }
  .dialog-body { padding: 12px 14px; }
  .dialog-card .item { padding: 9px 12px; border: 1px solid #444;
    border-radius: 6px; margin-bottom: 6px; cursor: pointer; }
  .dialog-card .item.sel { border-color: #6cf; }
  .dialog-field { display: block; width: 100%; box-sizing: border-box;
    padding: 8px 10px; margin-bottom: 12px; }
  .dialog-btns { display: flex; gap: 8px; justify-content: flex-end; }
</style>
</head>
<body>
  <pi-dialog id="dialog"></pi-dialog>
  <script type="module">
    import "/pi-dialog.js";
    window.__events = [];
    const record = (name) => (e) =>
      window.__events.push({ name, detail: e.detail ?? null });
    const el = document.getElementById("dialog");
    for (const evt of ["pi-dialog-answer", "pi-dialog-open"])
      el.addEventListener(evt, record(evt));
    window.dialog = el;
    window.__ready = true;
  </script>
</body>
</html>`;

// <pi-tool> harness: mounts the real bundled element with enough app CSS to
// exercise the actual browser DOM rendering path for host-adapted tool trees.
const TOOL_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>pi-tool harness</title>
<style>
  :root { --dim: #7d8aa0; --muted: #9fb0c0; --acc: #6aa0ff; --ok: #4ade80;
    --err: #f87171; --tool-success-bg: #092216; --tool-pending-bg: #0f1d2e;
    --tool-error-bg: #2a1013; --tool-title: #6aa0ff; --tool-output: #9fb0c0; }
  .tool { display: block; color: var(--dim); border-left: 2px solid var(--ok);
    background: var(--tool-success-bg); padding: 5px 8px; margin: 6px 0;
    font-size: 14px; border-radius: 0 4px 4px 0; font-family: ui-monospace, monospace; }
  .tool.pending { border-left-color: var(--acc); background: var(--tool-pending-bg); }
  .tool.error { border-left-color: var(--err); background: var(--tool-error-bg); }
  .tool-head { display: flex; align-items: baseline; white-space: nowrap; overflow: hidden; }
  .tool-name { color: var(--tool-title); font-weight: 600; margin-right: 6px; }
  .tool-args { color: var(--acc); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool-dim { color: var(--dim); white-space: pre; flex-shrink: 0; }
  .tool-body { margin: 4px 0 0; padding: 0; background: none; color: var(--tool-output);
    font-size: 14px; white-space: pre-wrap; word-break: break-word; overflow-x: auto; max-width: 100%; }
  .ansi { margin: 4px 0 0; font-family: ui-monospace, monospace; font-size: 14px;
    line-height: 1.5; white-space: pre; overflow-x: auto; max-width: 100%; }
  .ansi-line { min-height: 1.5em; }
</style>
</head>
<body>
  <pi-tool id="tool"></pi-tool>
  <script type="module">
    import "/pi-tool.js";
    const el = document.getElementById("tool");
    window.tool = el;
    window.applyTool = (frame, cwd = "/repo") => el.apply(frame, cwd);
    window.__ready = true;
  </script>
</body>
</html>`;

// <pi-picker> harness: mounts the real bundled element with the app's overlay
// CSS so real clicks/backdrop hit-testing behave, exposes window.openList() to
// populate + open a nav picker, and records row activations + backdrop events.
const PICKER_PAGE = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>pi-picker harness</title>
<style>
  #overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5);
    display: none; align-items: flex-start; justify-content: center; z-index: 60; }
  #overlay.show { display: flex; }
  .picker { margin-top: 12vh; background: #222; border: 1px solid #444;
    border-radius: 10px; width: min(620px, 92vw); max-height: 74vh; overflow: auto; }
  .picker h3 { margin: 0; padding: 12px 14px; }
  .picker .item { display: flex; justify-content: space-between; gap: 12px;
    padding: 9px 12px; border: 1px solid #444; border-radius: 6px;
    margin: 6px 12px; cursor: pointer; }
  .picker .item.sel { border-color: #6cf; box-shadow: inset 2px 0 0 #6cf; }
</style>
</head>
<body>
  <pi-picker id="overlay"></pi-picker>
  <script type="module">
    import "/pi-picker.js";
    window.__events = [];
    const el = document.getElementById("overlay");
    el.addEventListener("pi-picker-backdrop", () =>
      window.__events.push({ name: "pi-picker-backdrop", detail: null }));
    // Build a nav picker of the given labels (mirrors app.ts openListPicker).
    window.openList = (labels) => {
      el.card.innerHTML = "<h3>Pick</h3>";
      el.items = [];
      el.nav = true;
      labels.forEach((label, i) => {
        const item = document.createElement("div");
        item.className = "item";
        item.textContent = label;
        item.onclick = () =>
          window.__events.push({ name: "row-click", detail: { i, label } });
        el.card.appendChild(item);
        el.items.push(item);
      });
      el.setSel(0);
      el.show();
    };
    window.picker = el;
    window.__ready = true;
  </script>
</body>
</html>`;

const JS: Record<string, string> = {
    "/pi-composer.js": "pi-composer.ts",
    "/pi-dialog.js": "pi-dialog.ts",
    "/pi-picker.js": "pi-picker.ts",
    "/pi-tool.js": "pi-tool.ts",
};

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        const entry = JS[url.pathname];
        if (entry) {
            try {
                return new Response(await bundle(entry), {
                    headers: {
                        "Content-Type": "text/javascript; charset=utf-8",
                    },
                });
            } catch (err) {
                return new Response(
                    `/* build failed */\nconsole.error(${JSON.stringify(String(err))});`,
                    {
                        status: 500,
                        headers: {
                            "Content-Type": "text/javascript; charset=utf-8",
                        },
                    },
                );
            }
        }
        const body =
            url.pathname === "/dialog"
                ? DIALOG_PAGE
                : url.pathname === "/picker"
                  ? PICKER_PAGE
                  : url.pathname === "/tool"
                    ? TOOL_PAGE
                    : PAGE;
        return new Response(body, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    },
});

console.log(`harness on http://127.0.0.1:${PORT}`);
