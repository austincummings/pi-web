# pi-web TODO

Simple, line-based backlog. Check items off as they land.

## Planned

- [x] 1. Use TypeScript across the board; minimal build system for the front-end web code. (Bun.build bundler in `src/host/build-web.ts`; `tsconfig.json` + `typecheck`/`build` scripts; web modules are now `.ts`.)
- [x] 2. Investigate a basic/standard request router instead of the bespoke one. (Evaluated Bun.serve / Hono / in-house; chose a dependency-free `method+exact-path` router in `src/host/router.ts` since all routes are flat. Replaced the 199-line if-chain.)
- [x] 3. Style the composer scrollbar; make all scrollbars match the transcript view styling. (Promoted the transcript's `::-webkit-scrollbar` + Firefox `scrollbar-*` treatment to a global `*` rule in index.html.)
- [x] 4. Render tool calls neatly: per-call cards with arg summary + collapsed result body (expand via click or **alt+o** — ctrl+o is browser-reserved), error/pending states. Host now emits tool result text (live + replay). Client `window.piweb.registerToolRenderer(name, fn)` allows overrides (host->browser bridge tracked in #10).
- [ ] 5. Add the starting/reload context intro view (find pi's name for it) showing [Context], [Extensions], [Themes], etc.
- [ ] 6. Stop the transcript area from scrolling horizontally; tool-call output currently overruns the right edge.
- [ ] 7. Clean up the code: add tests, tidy interfaces and walk through them, remove unused styles/styling.
- [ ] 8. Set the web page title dynamically as an extension point, mirroring how the pi TUI sets the terminal title.
- [ ] 9. Highlight the focused composer border based on the current thinking mode.
- [ ] 10. Explore what the pi TUI exposes to extensions for the transcript view (custom message/tool-output rendering) and expose similar in pi-web: custom HTML/canvas in place of a message, ideally interactive.
- [ ] 11. Fix extensions not loading on first app load (only load after /reload).
- [ ] 12. Show a webified version of the TUI startup banner at the top of threads:
      `pi v0.80.2` / `escape interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · ctrl+o more` / `Press ctrl+o to show full startup help and loaded resources.`
- [ ] 13. Render markdown tables in the transcript view.
- [ ] 14. Add an "open project" modal overlay (à la Zed's folder picker) so daemon-hosted agents can be cd'd into a chosen working directory.
- [ ] 15. Add the /model model picker that the TUI has.
- [ ] 16. Create a matrix of TUI extension points vs. our web UI counterparts, noting gaps; add as `docs/extension-points.md`.
- [ ] 17. Research whether to switch to HTMX for rendering the dynamic UI.
- [ ] 18. Research rendering markdown in the composer text box.
- [ ] 19. Add a web equivalent of pi's `registerMessageRenderer(customType, renderer)` so
      extensions can override how a message / code block renders in the transcript
      (closely related to #10; the forcing function is a tree-sitter highlighter).
      Shape: `piweb.registerMessageRenderer(customType, (message, opts) => Node)`
      where the renderer returns a **serializable component tree** (the same
      `Stack/Row/Text/Button/Frame` node model as docks/overlays), not a TUI
      `Component`. The host keeps a `customType -> renderer` map; when a transcript
      entry carries a matching `customType` (or, for code blocks, a synthetic
      `"code"` type with `{ lang, text }`), it renders the returned tree via the
      existing `renderNode` path instead of the default markdown/`<pre>` output.
      Needs three small pieces: (a) the registry + `render` SSE frame carrying
      `{ customType, tree }`, (b) a new `Code` node type so a highlighter can emit
      spans without a `Frame`, (c) capturing the fenced-code language in
      `markdown.ts` so code blocks can be routed to a registered renderer.
      Stays portable: with no host present the call no-ops like the rest of `piweb`.
- [ ] 20. Rename the `dock`/`overlay` surface API toward pi parity: `dock` -> `setWidget`
      with a widened `placement` (`aboveEditor`/`belowEditor` aliases for today's
      `bottom`/`footer`, plus web-only `left`/`right` rails), and accept `string[]`
      content for drop-in compatibility with plain pi extensions. Keep `overlay`
      separate (it maps to pi's `custom({ overlay })`, not a widget placement).
      `dock`/`overlay` currently have no real callers, so the rename is cheap; keep
      `dock` as a thin deprecated alias for one release. See `docs/widget.md` for the
      full spec.

- [ ] 21. Reach slash-command parity with the pi TUI. The web cockpit (`src/web/app.ts`
      `COMMANDS`) currently ships 10 of the TUI's 22 commands. Shared today:
      `/resume`, `/new`, `/name`, `/session`, `/compact`, `/copy`, `/export`,
      `/reload`, `/hotkeys`, `/changelog`. Missing in web (port or decide N/A):
    - [ ] `/login`, `/logout` — manage OAuth or API-key credentials
    - [ ] `/model` — switch models (see #15)
    - [ ] `/scoped-models` — enable/disable models for Ctrl+P cycling
    - [ ] `/settings` — thinking level, theme, message delivery, transport
    - [ ] `/tree` — jump to any point in the session and continue
    - [ ] `/trust` — save project trust decision
    - [ ] `/fork` — new session from a previous user message
    - [ ] `/clone` — duplicate the current active branch into a new session
    - [ ] `/import <file>` — import and resume a session from a JSONL file
    - [ ] `/share` — upload as private GitHub gist with shareable HTML link
    - [ ] `/quit` — quit pi (likely N/A in a browser tab)

## Docs

- [ ] Re-add documentation (the previous `docs/roadmap.md` and `docs/ui-bridge.md` were removed). Document the architecture, the bus protocol, and the ExtensionUIContext web bridge.

## Carried over (from old roadmap)

- [ ] Make /reload actually re-instantiate session extensions (relates to #11).
- [ ] Resolve the SDK shim (`src/sdk/piweb.ts`): wire a real `@pi-web/sdk` import or drop it.
- [ ] ExtensionUIContext bridge: `notify` → `confirm` (permission gates) → `select`/`input` → `setStatus`/`setWidget`; add `POST /ui-response` + `ui_request` SSE frames; introduce `ctx.mode === "web"`.
