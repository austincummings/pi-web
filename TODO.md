# pi-web TODO

Simple, line-based backlog. Check items off as they land.

## Planned

- [ ] 1. Use TypeScript across the board; minimal build system for the front-end web code.
- [ ] 2. Investigate a basic/standard request router instead of the bespoke one.
- [ ] 3. Style the composer scrollbar; make all scrollbars match the transcript view styling.
- [ ] 4. Render tool calls neatly: let extensions override rendering (like the TUI) and match pi's default tool-result behavior (truncation, ctrl+o to expand, etc.).
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

## Docs

- [ ] Re-add documentation (the previous `docs/roadmap.md` and `docs/ui-bridge.md` were removed). Document the architecture, the bus protocol, and the ExtensionUIContext web bridge.

## Carried over (from old roadmap)

- [ ] Make /reload actually re-instantiate session extensions (relates to #11).
- [ ] Resolve the SDK shim (`src/sdk/piweb.ts`): wire a real `@pi-web/sdk` import or drop it.
- [ ] ExtensionUIContext bridge: `notify` → `confirm` (permission gates) → `select`/`input` → `setStatus`/`setWidget`; add `POST /ui-response` + `ui_request` SSE frames; introduce `ctx.mode === "web"`.
