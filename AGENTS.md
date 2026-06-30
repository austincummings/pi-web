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
- **Tests:** `bun test`. Keep the suite green before committing.
- **Format:** `bun run format` (prettier) before committing.
- **Architecture:** `src/host/` is the agent-independent transport layer (node:http
  server, SSE + POST bus, `piweb` registry). `src/web/` is the browser front-end.
  Thread ids travel in the POST body (`body.threadId`) or `?thread=` query — no path
  params.
