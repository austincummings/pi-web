/**
 * Web assets baked into the standalone binary (`bun build --compile`).
 *
 * These `type: "file"` imports make Bun embed the prebuilt front-end bundle
 * (`dist/app.js`, produced by `bun run build`) and `index.html` into the
 * compiled executable, exposing them as paths usable with `Bun.file()`.
 *
 * This module is imported **only** from a compiled binary — the asset server
 * guards the dynamic `import("./embedded.ts")` behind `Bun.embeddedFiles.length`
 * — so `bun run` / `bun dev` never evaluate these imports and therefore don't
 * require a prebuilt `dist/app.js` to exist.
 */
import indexHtmlFile from "../web/index.html" with { type: "file" };
// `dist/app.js` is a prebuilt bundle with no type declarations and may not
// exist outside a binary build; the `type: "file"` import resolves to a path
// string at compile time either way.
// @ts-expect-error -- untyped Bun file import (prebuilt front-end bundle)
import appJsFile from "../../dist/app.js" with { type: "file" };

// The `type: "file"` assertion makes these resolve to a path usable with
// `Bun.file()`; cast to string because TS types `*.html` imports as HTMLBundle.
export const indexHtmlPath = indexHtmlFile as unknown as string;
export const appJsPath = appJsFile as unknown as string;
