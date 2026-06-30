# Extension Points: pi TUI vs. pi-web

A side-by-side map of what the **pi TUI** exposes to extensions versus what the
**pi-web cockpit** currently bridges to the browser. Tracks TODO #16.

Sources:

- pi TUI: `/opt/pi-coding-agent/docs/extensions.md` (ExtensionAPI, ExtensionContext, `ctx.ui`).
- pi-web: `src/host/piweb-host.ts` (host registry on `globalThis.__PIWEB__`),
  `src/sdk/piweb.ts` (the `piweb` shim), `src/web/tools.ts` (client renderers),
  `src/web/app.ts` (in-iframe `window.piweb`).

> **Framing.** pi-web is **not** a second extension runtime. Extensions still run
> in-process under pi; pi-web only adds a _UI bridge_ so an extension can paint
> the browser cockpit instead of (or alongside) the terminal. So the events /
> tools / session-control layers below are **inherited from pi unchanged** — they
> are not re-exposed by pi-web — while only the **`ctx.ui` surface** has a web
> counterpart. The matrix therefore focuses on the UI layer.

---

## 1. Inherited from pi unchanged (no web-specific bridge)

These run identically whether pi renders to a terminal or pi-web renders to a
browser. pi-web adds nothing and takes nothing away.

| Layer             | pi TUI surface                                                                                                                                                                                                                                                                                                                                      | In pi-web?                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Events            | `pi.on(event, handler)` — `project_trust`, `resources_discover`, `session_*`, `before_agent_start`, `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_*`, `context`, `before_provider_request`, `after_provider_response`, `model_select`, `thinking_level_select`, `tool_call`, `tool_result`, `user_bash`, `input` | ✅ inherited                                                                          |
| Tools             | `pi.registerTool`, override built-ins, remote exec, `getActiveTools/getAllTools/setActiveTools`                                                                                                                                                                                                                                                     | ✅ inherited                                                                          |
| Messaging         | `pi.sendMessage`, `pi.sendUserMessage`, `pi.appendEntry`, `pi.setLabel`                                                                                                                                                                                                                                                                             | ✅ inherited                                                                          |
| Commands          | `pi.registerCommand`, `pi.getCommands`                                                                                                                                                                                                                                                                                                              | ✅ inherited (slash commands; web UI separately reimplements a subset — see TODO #21) |
| Shortcuts / flags | `pi.registerShortcut`, `pi.registerFlag`                                                                                                                                                                                                                                                                                                            | ✅ inherited (terminal-only semantics)                                                |
| Models            | `pi.setModel`, `pi.get/setThinkingLevel`, `pi.registerProvider`, `pi.unregisterProvider`                                                                                                                                                                                                                                                            | ✅ inherited                                                                          |
| Session control   | `ctx.newSession`, `ctx.fork`, `ctx.navigateTree`, `ctx.switchSession`, `ctx.reload`, `ctx.compact`, `ctx.shutdown`, `ctx.sessionManager`, `pi.set/getSessionName`                                                                                                                                                                                   | ✅ inherited                                                                          |
| Context           | `ctx.mode`, `ctx.hasUI`, `ctx.cwd`, `ctx.isProjectTrusted`, `ctx.signal`, `ctx.getContextUsage`, `ctx.getSystemPrompt`                                                                                                                                                                                                                              | ✅ inherited (`ctx.mode === "web"` is proposed, not yet wired)                        |

---

## 2. UI extension points — the matrix

pi's `ctx.ui` (and its message/tool render hooks) vs. pi-web's `piweb` surface.

Legend: ✅ implemented · 🟡 partial / proposed · ❌ missing · ➖ N/A in a browser

| #   | pi TUI (`ctx.ui.*` / render hooks)                             | pi-web counterpart                                           | Status | Notes                                                                                                                                                              |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------ | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `notify(msg, level)`                                           | `piweb.notify(msg, type)`                                    |   ✅   | Toasts; same name, info/warning/error.                                                                                                                             |
| 2   | `setStatus(key, text)`                                         | `piweb.setStatus(key, text, opts?)`                          |   ✅   | Keyed footer segments; web adds align/tone superset.                                                                                                               |
| 3   | `setWidget(key, lines, {placement: aboveEditor\|belowEditor})` | `piweb.dock(id, def)` → left/right/bottom/footer rails       |   🟡   | Concept maps but name diverges; rename to `setWidget` + widened placement is **proposed** in `docs/widget.md` (TODO #20).                                          |
| 4   | `select / confirm / input / editor` dialogs                    | `piweb.overlay(id, def)` + `openOverlay/closeOverlay`        |   🟡   | Declarative modal cards exist; blocking `await select()`-style request/response (`POST /ui-response` + `ui_request` SSE) is **not yet wired** (carried-over TODO). |
| 5   | Custom tool rendering (`renderCall` / `renderResult`)          | `registerToolRenderer(name, fn)` (`src/web/tools.ts`)        |   ✅   | Returns a DOM node or `null` to fall back; web equivalent of the TUI render hooks (TODO #4).                                                                       |
| 6   | `registerMessageRenderer(customType, renderer)`                | —                                                            |   ❌   | Proposed as `piweb.registerMessageRenderer` returning a serializable node tree (TODO #19).                                                                         |
| 7   | Custom components / `custom({ overlay })` (experimental)       | overlay render-tree + id'd `actions` map                     |   🟡   | pi-web can't ship a live `Component`; substitutes serializable `Stack/Row/Text/Button/Frame…` + actions dispatched via `host.dispatch`.                            |
| 8   | `setFooter(factory)`                                           | —                                                            |   ❌   | No web footer-replacement hook (status segments only).                                                                                                             |
| 9   | `setWorkingMessage / setWorkingVisible / setWorkingIndicator`  | —                                                            |   ❌   | No web streaming-indicator override.                                                                                                                               |
| 10  | `setTitle(text)`                                               | `piweb.setTitle(text)`                                       |   ✅   | Host emits a `title` SSE frame; client sets `document.title`. Default (no override) tracks the session as `π web - <thread name> - <cwd>` (mirrors the TUI's `π - <session> - <cwd>`, dropping segments that are absent); empty restores it. `ctx.ui` wiring tracked in #22. |
| 11  | `setEditorText / getEditorText / pasteToEditor`                | —                                                            |   ❌   | No composer-text bridge yet.                                                                                                                                       |
| 12  | `addAutocompleteProvider(fn)`                                  | — (web has built-in `@`/`/` completion only)                 |   ❌   | No extension-supplied autocomplete bridge.                                                                                                                         |
| 13  | `getToolsExpanded / setToolsExpanded`                          | per-card expand (alt+o / click)                              |   🟡   | Web has the UI affordance but no programmatic extension control.                                                                                                   |
| 14  | `setEditorComponent / getEditorComponent`                      | —                                                            |   ➖   | TUI Component swap (vim/emacs editors); not meaningful in the DOM composer.                                                                                        |
| 15  | `getAllThemes / getTheme / setTheme / theme.fg(...)`           | —                                                            |   ❌   | No theme API exposed to web extensions yet (cockpit CSS is static).                                                                                                |
| 16  | In-frame host calls                                            | `window.piweb.action(name, payload)` + `window.piweb.notify` |   ✅   | Web-only: lets iframe widget content call back into the host (no TUI analogue).                                                                                    |
| —   | `ctx.hasUI` / `ctx.mode` guards                                | `piweb.present` flag; no-op `stub` when no host              |   ✅   | Portable: calls degrade to no-ops under plain terminal pi.                                                                                                         |

---

## 3. pi-web surface inventory (for reference)

Everything currently on `globalThis.__PIWEB__` (`src/host/piweb-host.ts`):

| Method                                                       | Purpose                                                | TUI analogue                          |
| ------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------- |
| `dock(id, def)`                                              | Mount/replace a rail widget (left/right/bottom/footer) | `setWidget(aboveEditor\|belowEditor)` |
| `removeDock(id)` / `remove(id)`                              | Remove a dock                                          | `setWidget(key, undefined)`           |
| `overlay(id, def)`                                           | Define a modal card (starts closed)                    | `custom({ overlay })`                 |
| `openOverlay(id)` / `closeOverlay(id)` / `removeOverlay(id)` | Show/hide/remove a modal                               | dialog lifecycle                      |
| `notify(msg, type)`                                          | Transient toast                                        | `ui.notify`                           |
| `setStatus(key, text, opts?)`                                | Keyed footer status segment                            | `ui.setStatus`                        |
| `clear()`                                                    | Drop all surfaces + statuses                           | —                                     |
| `present`                                                    | Host-presence flag (false in the no-op stub)           | `ctx.hasUI`                           |
| `dispatch(id, action, payload)` _(internal)_                 | Run a surface action in-process, rebroadcast           | —                                     |
| `snapshot()` _(internal)_                                    | Serialize docks/overlays/status for SSE                | —                                     |

Client-side (`src/web/`): `registerToolRenderer(name, fn)` (tools.ts) and
in-iframe `window.piweb.{action,notify}` (app.ts).

---

## 4. Gap summary

- **Strong parity:** `notify`, `setStatus`, `setTitle`, custom tool rendering, host-presence guard.
- **Proposed / in flight:** `setWidget` rename (TODO #20), `registerMessageRenderer` (TODO #19), blocking dialog request/response bridge, `ctx.mode === "web"`.
- **Missing:** `setFooter`, working-message/indicator overrides, editor-text bridge, `addAutocompleteProvider`, theme API.
- **N/A in a browser:** `setEditorComponent` (TUI Component swap).
