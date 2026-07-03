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

const JS: Record<string, string> = {
    "/pi-composer.js": "pi-composer.ts",
    "/pi-dialog.js": "pi-dialog.ts",
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
        const body = url.pathname === "/dialog" ? DIALOG_PAGE : PAGE;
        return new Response(body, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    },
});

console.log(`harness on http://127.0.0.1:${PORT}`);
