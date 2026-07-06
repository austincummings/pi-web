# pi-web

A **self-modifiable web UI** for the [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) coding agent.

It runs `pi` **in-process** via the SDK (`createAgentSession`) and exposes a
`piweb` API that extensions use to define **custom web UI** — a serializable
superset of pi's `ExtensionUIContext`. The agent can author its own panels.

## Architecture

```
browser web UI  ──SSE/POST──►  host (Bun)
  transcript                      createAgentSession()  ← pi runs in-process
  panels (component trees)        DefaultResourceLoader  ← loads extensions
                                  piweb host registry    ← injected as globalThis.__PIWEB__
        ▲                                 │
        └── serialized UI tree ───────────┘
            action events ─────────────►  in-process handler (closes over pi: ExtensionAPI)
```

- **Wrapper, not a fork.** The host embeds pi via the published SDK; pi is untouched.
- **`piweb` is additive.** Extensions stay valid portable pi extensions: with no
  host present, `globalThis.__PIWEB__` is absent and `piweb` calls no-op.
- **Serializable UI + id'd handlers.** `render(state)` returns a JSON component
  tree; handlers are referenced by action id and run in-process — generalizing
  pi's RPC extension-UI sub-protocol into an open component model.

## Files

| Path                     | Role                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `src/host/server.ts`     | HTTP host: in-process agent + SSE/POST bus                       |
| `src/host/piweb-host.ts` | `piweb` registry: docks/overlays, state, action dispatch         |
| `src/host/build-web.ts`  | bundles the TS front-end (`src/web/*.ts`) via Bun → `/app.js`    |
| `src/sdk/piweb.ts`       | `@pi-web/sdk` shim extensions import (resolves to host or no-op) |
| `src/web/`               | Browser web UI: transcript + component-tree renderer             |

> **Extensions** live in `~/.dotfiles/config/pi/.pi/agent/extensions/` (vendored
> from this repo, stowed into `~/.pi/agent/extensions/`), so pi/pi-web auto-load
> them **globally**. They import the vendored `_shared/piweb.ts` shim rather than
> this repo's `src/sdk/piweb.ts`.

## Run

```bash
bun install
bun start            # → http://localhost:4321
# or: bun dev        # watch mode (restarts on file changes)
```

Open the web UI:

- **Chat** with pi in the center (streaming transcript, tool calls).
- **Docks** (left/right rails, bottom tray) + the below-prompt **context bar**
  are registered by the global extensions in `~/.pi/agent/extensions/` — e.g.
  `status-footer`, which mirrors the pi-tui glass-cockpit footer (dir, branch,
  model, context-window usage bar, session cost).

> Model selection follows this precedence: (1) `PI_PROVIDER` / `PI_MODEL` env
> vars, (2) pi's own `settings.json` default (`defaultProvider`/`defaultModel`,
> the same one the pi TUI `/model` selector writes), (3) the **`meridian`
> fallback** (`meridian/claude-opus-4-8`). The pin is applied after startup via
> `session.setModel` because the pi-meridian extension only registers its
> provider during session startup. Surfaces work regardless of provider.

## The self-modifiable loop

1. In the web UI, ask pi to build a new panel.
2. pi writes an extension to `extensions/` (or `~/.pi/agent/extensions/`) calling
   `piweb.registerPanel(...)`.
3. Click **reload ext** → host re-discovers extensions → the new panel appears.

## Status / next steps

- [x] In-process agent host, streaming transcript over SSE
- [x] `piweb` registry + serializable component tree + action round-trip
- [x] Portable example extension (no-op without host)
- [ ] Richer node types (Select/Confirm/Editor mapping to pi's native ui methods)
- [ ] Live `/reload` that re-instantiates session extensions (currently best-effort)
- [ ] Multi-session / multi-project routing
- [ ] Publish `@pi-web/sdk` so third-party extensions can import it by name
