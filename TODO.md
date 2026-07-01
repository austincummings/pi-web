# pi-web TODO

Simple, line-based backlog. Check items off as they land.

## Planned

- [x] 1. Use TypeScript across the board; minimal build system for the front-end web code. (Bun.build bundler in `src/host/build-web.ts`; `tsconfig.json` + `typecheck`/`build` scripts; web modules are now `.ts`.)
- [x] 2. Investigate a basic/standard request router instead of the bespoke one. (Evaluated Bun.serve / Hono / in-house; chose a dependency-free `method+exact-path` router in `src/host/router.ts` since all routes are flat. Replaced the 199-line if-chain.)
- [x] 3. Style the composer scrollbar; make all scrollbars match the transcript view styling. (Promoted the transcript's `::-webkit-scrollbar` + Firefox `scrollbar-*` treatment to a global `*` rule in index.html.)
- [x] 4. Render tool calls neatly: per-call cards with arg summary + collapsed result body (expand via click or **alt+o** — ctrl+o is browser-reserved), error/pending states. Host now emits tool result text (live + replay). Client `window.piweb.registerToolRenderer(name, fn)` allows overrides (host->browser bridge tracked in #10).
- [x] 5. Add the starting/reload context intro view (pi calls it the startup header + "loaded resources"). Host emits a `welcome` frame (version + Context/Skills/Prompts/Extensions/Themes from the session resourceLoader, on connect and after /reload); client renders a collapsible banner above the transcript (`src/web/welcome.ts` + `#welcome`). Folded together with #12.
- [ ] 6. Stop the transcript area from scrolling horizontally; tool-call output currently overruns the right edge.
- [ ] 7. Clean up the code: add tests, tidy interfaces and walk through them, remove unused styles/styling.
- [x] 8. Set the web page title dynamically as an extension point, mirroring how the pi TUI sets the terminal title. (`piweb.setTitle(text)` on the host registry broadcasts a `title` SSE frame; the client sets `document.title`. By default (no override) the tab tracks the session as `π web - <thread name> - <cwd>` (mirroring the TUI's `π - <session> - <cwd>`, dropping absent segments); `""`/undefined clears the override and falls back to that. No-ops under plain pi via the SDK stub. Reaching it through `ctx.ui` is folded into #22.)
- [x] 9. Highlight the focused composer border based on the current thinking mode. (Host emits a per-session `thinking_level` SSE frame on connect + on cycle/set; web tints the focused composer border per level via `.composer[data-think]` CSS (mirrors pi-tui `theme.getThinkingBorderColor`), with a green `data-bash` override for `!` shell input. Shift+Tab cycles the level via `POST /thinking-level`, with a "Thinking level: <x>" toast. The `#contextbar` footer mirrors the TUI FooterComponent: a host `footer` SSE frame (emitted on connect, turn end, thinking-level change, rename, compact) drives a pwd/session line plus a token-stats / `<model> • thinking <level>` line (`• thinking off` when reasoning is supported but off; context% colored at >70/>90), rendered below the composer. `--think-*`/`--bash-mode` are theme-aware via the `theme` frame; `/reload` re-asserts the border.)
- [ ] 10. Explore what the pi TUI exposes to extensions for the transcript view (custom message/tool-output rendering) and expose similar in pi-web: custom HTML/canvas in place of a message, ideally interactive.
- [ ] 11. Fix extensions not loading on first app load (only load after /reload).
- [x] 12. Show a webified version of the TUI startup banner at the top of threads. Done as part of #5: the `#welcome` banner shows `pi v<version>` + a compact key-hint strip (`esc interrupt · ctrl+c/ctrl+d clear/exit · / commands · ! bash · alt+o more`, alt+o since ctrl+o is browser-reserved) and click-to-expand loaded resources.
- [ ] 13. Render markdown tables in the transcript view.
- [ ] 14. Add an "open project" modal overlay (à la Zed's folder picker) so daemon-hosted agents can be cd'd into a chosen working directory.
- [x] 15. Add the /model model picker that the TUI has. (Host `modelApi` lists selectable models via `ModelRegistry.getAvailable()` — active model pinned first, subscription/OAuth models tagged — over `GET /models`; `POST /model` switches the thread's model via `session.setModel()` and re-broadcasts the `thinking_level` + `footer` frames. Web `/model` opens a searchable, keyboard-navigable picker (fuzzy search mirrors the TUI's `getModelSelectorSearchText`) in the existing `#overlay`.)
- [x] 16. Create a matrix of TUI extension points vs. our web UI counterparts, noting gaps; add as `docs/extension-points.md`. (Done — see `docs/extension-points.md`; the gaps it surfaces are tracked in #22.)
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

- [ ] 21. Reach slash-command parity with the pi TUI. The web UI (`src/web/app.ts`
      `COMMANDS`) currently ships 11 of the TUI's 22 commands. Shared today:
      `/resume`, `/new`, `/name`, `/session`, `/compact`, `/copy`, `/export`,
      `/reload`, `/hotkeys`, `/changelog`, `/model`. Missing in web (port or decide N/A):
    - [ ] `/login`, `/logout` — manage OAuth or API-key credentials
    - [x] `/model` — switch models (see #15)
    - [ ] `/scoped-models` — enable/disable models for Ctrl+P cycling
    - [ ] `/settings` — thinking level, theme, message delivery, transport
    - [ ] `/tree` — jump to any point in the session and continue
    - [ ] `/trust` — save project trust decision
    - [ ] `/fork` — new session from a previous user message
    - [ ] `/clone` — duplicate the current active branch into a new session
    - [ ] `/import <file>` — import and resume a session from a JSONL file
    - [ ] `/share` — upload as private GitHub gist with shareable HTML link
    - [ ] `/quit` — quit pi (likely N/A in a browser tab)

- [ ] 22. Reach `ctx.ui` extension-point parity with the pi TUI (gaps from
      `docs/extension-points.md`). Extensions inherit pi's event/tool/session/model
      layers unchanged; only the UI layer needs a web bridge. Already at parity:
      `notify`, `setStatus`, custom tool rendering (`registerToolRenderer`), and the
      host-presence/no-op guard. To build: - [ ] `setWidget` rename + widened placement (folds in #20) — replaces `dock` - [ ] blocking dialog request/response so `select`/`confirm`/`input`/`editor`
      can `await` (`POST /ui-response` + `ui_request` SSE; see carried-over bridge) - [ ] `registerMessageRenderer` (folds in #19) - [x] `setTitle` web page-title hook (folds in #8 — `piweb.setTitle`; `ctx.ui` wiring still pending) - [ ] `setFooter` — footer replacement hook - [ ] `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` - [ ] `setEditorText` / `getEditorText` / `pasteToEditor` composer bridge - [ ] `addAutocompleteProvider` — extension-supplied completion - [ ] `getToolsExpanded` / `setToolsExpanded` programmatic control - [ ] theme API: `getAllThemes` / `getTheme` / `setTheme` / `theme.fg(...)` - [ ] `ctx.mode === "web"` so portable extensions can branch on the medium - [ ] N/A in a browser: `setEditorComponent` / `getEditorComponent` (TUI
      Component swap) — document as out of scope rather than implement

- [x] 23. Reach theme-palette parity with the pi TUI. `loadPiTheme()` in
      `src/host/server.ts` flattens only ~11 of the TUI theme's tokens into web UI
      CSS vars (`--bg`, `--panel`, `--line`, `--txt`, `--muted`, `--dim`, `--acc`,
      `--acc2`, `--ok`, `--warn`, `--err`); everything else in the theme JSON is
      dropped, so the web can't honor the full palette. See a matrix of the two
      palettes in the analysis behind this item. Gaps to close (port or decide N/A):
    - [x] tool-card status tints — consume the theme's literal `toolPendingBg` /
          `toolSuccessBg` / `toolErrorBg` / `toolTitle` / `toolOutput` instead of the
          hard-coded `color-mix(...)` tints in `index.html` (AGENTS.md ethos)
    - [x] markdown styling — `mdHeading`, `mdLink`, `mdLinkUrl`, `mdCode`,
          `mdCodeBlock`, `mdCodeBlockBorder`, `mdQuote`, `mdQuoteBorder`, `mdHr`,
          `mdListBullet` (rendered body + composer backdrop tints)
    - [x] diff colors — `toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext`
          (exposed as `--diff-*`; consumed when diff rendering lands with #19)
    - [x] syntax highlighting — the 9 `syntax*` slots exposed as `--syn-*`
          (consumed when highlighting lands with #19)
    - [x] thinking-level gradient — `thinkingOff/Minimal/Low/Medium/High/Xhigh`
          (already wired via `--think-*`)
    - [x] message styling — `selectedBg`, `userMessageBg/Text`,
          `customMessageBg/Text/Label` (user/custom bodies washed; `--selected-bg`
          exposed)
    - [x] misc raw slots — `hover`, `borderVariant`, `comment`, `cyan`,
          `brightCyan`, `dimBlue`, `bashMode`, plus the `export` block
          (all surfaced as CSS vars)
    - [x] `:root` fallbacks in `index.html` for every var (incl. `--muted` /
          `--ok` / `--warn`) so a theme that omits a token degrades gracefully
    - [x] widen `frameThemeVars()` so sandboxed extension iframes get the full set
          (was 7 vars; now the whole palette)

- [x] 24. Reach steering-message-queue parity with the pi TUI (parity cluster
      alongside #21/#22/#23). While a turn is in flight (`thread.busy`), pi lets
      you keep typing: each submitted message is appended to a per-thread
      **steering queue** instead of being dropped or starting a second concurrent
      turn. Today `runInput` in `src/web/app.ts`
      always `POST`s `/prompt`, and the host's `onPrompt` (`src/host/server.ts`)
      calls `s.prompt(text)` immediately regardless of `busy`, so a message sent
      mid-turn races the in-flight one. Port the TUI's queue semantics. What the
      pi TUI lets you do with the queue (the parity checklist):
    - [x] **Steer mid-turn** — inject the queued text into the running agent at
          the next message boundary so it adjusts course without an interrupt.
          (`onPrompt` enqueues via `s.prompt(text, { streamingBehavior: "steer" })`
          when `s.isStreaming`.)
    - [x] **Auto-flush on completion** — when no steering hook applies, deliver
          the queued message(s) as the next turn the moment the current one ends.
          (Handled by the SDK's own steering queue; delivery emits the normal
          `user`/`message_start` frames.)
    - [x] **Queue many** — stack multiple messages; they're delivered in order.
    - [x] **Show the pending queue** — render the queued messages in the UI
          (above the composer) so you can see what's waiting. (`queue` SSE frame
          from the host's `queue_update` event → `#queued` rows in `index.html`;
          also sent on connect so a refreshing viewer sees the backlog.)
    - [x] **Edit / remove before send** — pop a queued item back into the
          composer to edit it, or delete it before it's delivered. (Click a row
          or press Alt+↑ to restore the whole queue to the composer, mirroring
          the TUI's `restoreQueuedMessagesToEditor` / `app.message.dequeue`.)
    - [x] **Esc interaction** — distinguish "interrupt the turn" from "clear the
          queue"; mirror the TUI's precedence. (Esc while working restores the
          queue _and_ aborts — `restoreQueuedMessagesToEditor({ abort: true })`;
          Alt+↑ restores without aborting.)
          Done: a per-thread queue on the host (the SDK session's steering queue,
          drained at steer points / turn end), a `queue` SSE frame so viewers see
          pending items, `POST /dequeue` to restore+optionally-abort, and the host
          enqueuing automatically while `busy`.

- [ ] 25. Reach prompt-history navigation parity with the pi TUI (Up/Down in the
      composer). Today `src/web/app.ts` only special-cases Up/Down while the
      autocomplete popup is open (moving `acIndex`); with the popup closed the
      `<textarea>` gets default browser caret movement and there is no input
      history. Port the TUI's combined caret-move + history-browse behavior:
    - [ ] **Boundary-gated browsing** — Up browses history only when the caret is
          on the first logical line; Down only when on the last line. Otherwise
          arrows move the caret between draft lines as normal.
    - [ ] **Edge nudge (pi #5789)** — a non-empty single-line draft jumps the
          caret to the start of the line on the first Up before browsing begins.
    - [ ] **Cursor placement (pi #5454)** — browsing upward lands the caret at the
          **start** of the recalled entry; browsing downward lands it at the
          **end**.
    - [ ] **Draft preservation (pi #5494)** — stash the in-progress draft when
          entering history and restore it when arrowing back down past the newest
          entry.
    - [ ] **History source** — seed/keep per-thread history from the `case "user"`
          SSE frames (covers both live sends and replay), clear it on
          `transcript_reset`. No host change required for an MVP.

- [ ] 26. Extract the streaming thinking trace into a `<pi-thinking>` custom
      element (continuing the front-end custom-element refactor that already
      landed `<pi-frame>` and `<pi-tool>`). Today `src/web/app.ts` tracks the
      live block via the `thinkingEl`/`thinkingRaw` module globals and renders
      it through the free functions `thinkingBubble()` / `renderThinking()` /
      `scheduleThinkingRender()`.
    - [ ] **Own the element's state** — a `<pi-thinking>` that holds its raw
          text and re-renders markdown internally, throttled to one paint per
          animation frame (move `scheduleThinkingRender`'s rAF inside).
    - [ ] **Streaming API** — feed it the `thinking` SSE frames
          (`start`/`delta`/`end`/`full`); the host appends deltas and the
          element renders, so `thinkingEl`/`thinkingRaw` globals go away.
    - [ ] **Keep visibility app-global** — the show/hide toggle stays at app
          level (`body.hide-thinking` CSS + persisted to pi's
          `hideThinkingBlock` setting); the element just respects the CSS.
    - [ ] **Light DOM** — carry the existing `.thinking-block` classes so the
          shared stylesheet applies unchanged (add `display:block`).

## Docs

- [ ] Re-add documentation (the previous `docs/roadmap.md` and `docs/ui-bridge.md` were removed). Document the architecture, the bus protocol, and the ExtensionUIContext web bridge.

## Carried over (from old roadmap)

- [ ] Make /reload actually re-instantiate session extensions (relates to #11).
- [ ] Resolve the SDK shim (`src/sdk/piweb.ts`): wire a real `@pi-web/sdk` import or drop it.
- [ ] ExtensionUIContext bridge: `notify` → `confirm` (permission gates) → `select`/`input` → `setStatus`/`setWidget`; add `POST /ui-response` + `ui_request` SSE frames; introduce `ctx.mode === "web"`.
