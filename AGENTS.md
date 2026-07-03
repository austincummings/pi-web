# AGENTS.md

Guidance for agents working in pi-web.

## Design ethos: match the pi TUI by default

pi-web is a web UI for the same agent the pi TUI drives. **Unless there is a
deliberate reason to diverge, the web UI should match the look and feel of the pi
TUI.** When deciding how something should render or behave, the default answer is
"however pi's terminal UI does it."

Concretely:

- **Mirror the TUI's visual language.** Prefer the TUI's cues over inventing new
  ones. For example, the TUI does not mark tool calls with ✓/✗ glyphs — it tints
  the result body (`toolPendingBg` / `toolSuccessBg` / `toolErrorBg`) and bolds the
  tool title. pi-web does the same (tinted `.tool-body`, no success/error glyph).
- **Reuse pi's names and concepts.** Keep pi's terminology where the concept maps
  (`notify`, `setStatus`, `setWidget`, thinking mode, `/` commands, `!` bash) so
  extensions and muscle memory carry over. See `TODO.md` #20 / `docs/widget.md`.
  The extension surface (`src/sdk/piweb.ts`) is a subset of pi-tui's
  `ExtensionUIContext`; the serializable **node** vocabulary mirrors pi-tui
  components (`Box`/`Container`/`Text`/`Spacer`/`Image`/`Markdown`) except for a
  small set of **sanctioned web-only nodes** the terminal has no equivalent for
  (`Frame`, `Button`, `Input`, `Row`, `Divider`). Adding a web-only node is a
  deliberate exception — document it in `docs/render-model-parity.md` §4.0 and
  prefer a pi-tui-mirrored node when the concept already exists.
- **Adopt the active pi theme.** Colors come from the theme at runtime; use the CSS
  variables (`--acc`, `--err`, `--dim`, …) rather than hard-coded values, and accent
  the same things the TUI accents (e.g. the bash command string uses `--acc`).
- **Keyboard parity, adapted to the browser.** Match the TUI's shortcuts where the
  browser allows; where a key is reserved (Ctrl+T, Ctrl+O), pick the closest free
  equivalent (Alt+T thinking, Alt+O expand) rather than a wholly new scheme.

Diverging is fine when the medium demands it (the browser reserves keys, supports
HTML/canvas, has a window title instead of a terminal title) — but treat divergence
as a decision to justify, not the starting point.

## Project conventions

- **Runtime:** Bun (runs `.ts` directly). `bun start` / `bun dev` (dev sets
  `PI_WEB_DEV=1` for per-request rebuilds). `bun run build` bundles the front-end via
  `Bun.build`; `bun run typecheck` runs `tsc --noEmit`.
- **Tests:** `bun test` (unit/DOM via happy-dom). Keep the suite green before
  committing. Real-browser component tests live in `test/e2e/*.e2e.ts` and run
  with `bun run e2e` (Playwright + the system Chrome, via a static harness that
  mounts the bundled element — no agent host needed). They're named `.e2e.ts`
  (not `.spec.ts`) so `bun test` ignores them.
- **Format:** `bun run format` (prettier) before committing.
- **Architecture:** `src/host/` is the agent-independent transport layer (node:http
  server, SSE + POST bus, `piweb` registry). `src/web/` is the browser front-end.
  Thread ids travel in the POST body (`body.threadId`) or `?thread=` query — no path
  params.
- **Extensions vs. host — do not bake features into the host.** User-facing
  features (slash commands, widgets, overlays, footers/headers, message
  renderers, autocomplete) are **extensions**, not host code. Author them as
  file-based pi extensions under `.pi/extensions/<name>/`, importing the
  `@pi-web/sdk` shim (`src/sdk/piweb.ts`) plus `pi.registerCommand`/`pi.on` so
  they stay portable (a no-op under plain terminal pi). **Never** wire a feature
  into `src/host/**` — in particular do not add it to the `extensionFactories`
  array in `src/host/server.ts`; that array is reserved for host plumbing (e.g.
  capturing the thread's live `ExtensionAPI`), not shipped features. If a task
  says "add an extension" and no `.pi/extensions/` home is obvious, **ask where
  it should live rather than defaulting to the host.**
