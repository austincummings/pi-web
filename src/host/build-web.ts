/**
 * Minimal front-end build step.
 *
 * The browser web UI is authored in TypeScript (`src/web/*.ts`) and bundled
 * with Bun's built-in bundler — no extra toolchain. `app.ts` is the single
 * entrypoint; it pulls in `fuzzy.ts` / `markdown.ts`, and the result is served
 * as `/app.js`.
 *
 * - prod: bundle once, cache the string.
 * - dev:  rebuild on every request so edits show up on a browser refresh
 *         (the host's `--watch` only restarts on host-file changes).
 */
import { join } from "node:path";

export type WebBundler = () => Promise<string>;

async function build(webDir: string): Promise<string> {
    const result = await Bun.build({
        entrypoints: [join(webDir, "app.ts")],
        target: "browser",
        format: "esm",
        minify: false,
        sourcemap: "inline",
    });
    if (!result.success) {
        const msg = result.logs.map((l) => String(l)).join("\n");
        throw new Error(`web build failed:\n${msg}`);
    }
    return await result.outputs[0].text();
}

/**
 * Create a bundler for the web entrypoint.
 * @param webDir absolute path to `src/web`
 * @param dev    rebuild on every call (no caching) for live editing
 */
export function makeWebBundler(webDir: string, dev = false): WebBundler {
    let cached: string | null = null;
    return async () => {
        if (dev) return build(webDir);
        if (cached == null) cached = await build(webDir);
        return cached;
    };
}
