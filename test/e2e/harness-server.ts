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

async function bundle(): Promise<string> {
    const result = await Bun.build({
        entrypoints: [join(WEB, "pi-composer.ts")],
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

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/pi-composer.js") {
            try {
                return new Response(await bundle(), {
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
        return new Response(PAGE, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
        });
    },
});

console.log(`harness on http://127.0.0.1:${PORT}`);
