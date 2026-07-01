# Spec: Frontend Extension Runtime (Proxy-over-RPC)

Status: **Draft / proposed.** Tracks the "run pi extensions on the frontend and
relay their API calls to the backend" design discussion.

This document specifies a **second, opt-in extension runtime** for pi-web in
which an extension's module executes **in the browser** (sandboxed) and its
`pi` / `piweb` API is a `Proxy` that forwards calls to the host over the existing
SSE + POST bus. It complements — does **not** replace — the current host-side
in-process runtime.

---

## 1. Motivation

Today every extension runs **host-side, in-process** under pi
(`createAgentSession`), and pi-web renders the transcript with its **own**
front-end. pi's TUI render hooks (`renderResult`, `renderCall`,
`registerMessageRenderer` returning a live `Component`) are therefore never
invoked in the web — pi-web _reimplements_ rendering via serializable trees
(`piweb.registerMessageRenderer`) and client renderers (`registerToolRenderer`
in `src/web/tools.ts`). See `docs/extension-points.md` §2.

Consequence: a **visual** extension (e.g. a custom diff viewer) cannot paint the
browser from its host-side module. It must be ported to pi-web's serializable
tree model (v1 defers arbitrary-HTML `Frame`; see §Scope), and even then cannot
override tool cards from its own file (that hook is client-side only).

The frontend runtime closes this gap for the **UI / pure-logic** class of
extensions: the extension's view code runs where the DOM is (the browser), while
capability-bearing work is **relayed to** the host.

### Non-goals

- **Not** a replacement for the host runtime. Capability tools (`bash`, `edit`,
  fs/network), in-band middleware, providers, and session control stay host-side.
- **Not** transparent access to non-serializable live objects
  (`ctx.sessionManager`, `ctx.signal` as a live `AbortSignal`, streams).
- **Not** a security boundary weakening: browser extensions run sandboxed with
  **no** host capabilities except those explicitly relayed and allow-listed.

### Scope (v1): TUI parity first

Per AGENTS.md ("match the pi TUI by default; treat divergence as a decision"),
the first cut deliberately **defers all web-only surface**:

- **No web regions** — `setWidget` left/right rails and `overlay` modal cards are
  out of v1. Widgets/status/dialogs use only what maps to pi's TUI.
- **No `Frame`** — no arbitrary sandboxed HTML/CSS/JS output. Renderers emit pi's
  serializable node vocabulary (Box/Row/Text/Divider/Code/Markdown) that the web
  already mounts to match the TUI.

Consequences: the render sandbox needs only a **Worker** for logic (no render
iframe), and `piweb` largely **collapses into the relayed `ctx.ui`** (see §17.7).
Web-only affordances (rails, overlays, `Frame`, side-by-side layouts) return as
explicit, justified divergences in a later phase.

---

## 2. Terminology

| Term                 | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| **Host runtime**     | The existing in-process runtime (`src/host/`), pi via `createAgentSession`.               |
| **Frontend runtime** | The new browser-side runtime specified here.                                              |
| **Web extension**    | An extension (or extension entry point) that runs in the frontend runtime.                |
| **Proxy API**        | The browser-side `pi` / `piweb` `Proxy` that forwards calls to the host.                  |
| **Relay**            | The RPC substrate: `ext-call` (fwd), `ext-invoke` (reverse), `ext-reply`, state snapshot. |
| **Owner client**     | The single SSE client designated to run a given web-extension instance for a thread.      |

---

## 3. Architecture

```
 ┌────────────────────── browser tab (owner client) ───────────────────────┐
 │  sandbox (Worker — no render iframe in v1)                               │
 │   ┌───────────────────────────────────────────────────────────────┐     │
 │   │  web extension module  export default (pi) => { … }            │     │
 │   │     pi.on("tool_result", h)      pi.registerCommand(...)        │     │
 │   │     piweb.registerToolRenderer("edit", render)                  │     │
 │   └───────────────▲───────────────────────────┬───────────────────┘     │
 │        local handler registry (cbId→fn)        │ Proxy get-trap          │
 │   ┌───────────────┴───────────────────────────▼───────────────────┐     │
 │   │  ext-runtime bootstrap: Proxy + registries + transport client   │     │
 │   └───────────────▲───────────────────────────┬───────────────────┘     │
 └───────────────────┼───────────────────────────┼─────────────────────────┘
       SSE  ext-invoke│  (host → browser)         │POST ext-call/-reply (browser → host)
 ┌───────────────────┴───────────────────────────▼─────────────────────────┐
 │  host (Bun)                                                              │
 │   ext-host bridge: subscription table, capability allow-list,           │
 │     correlation registry (promise ids), state snapshotter               │
 │   pi ExtensionAPI  ◄── in-process ──►  createAgentSession               │
 └─────────────────────────────────────────────────────────────────────────┘
```

The relay reuses the **existing transport** (`src/host/app.ts`):

- **SSE** `GET /events` tagged with `res.__threadId`; host→browser frames via
  `bus.broadcastToThread(threadId, frame)`; wire format `data: <json>\n\n`.
- **POST** routes are thread-scoped (`body.threadId`).
- **Precedent:** blocking dialogs already implement a correlation registry —
  `piweb.select()` returns a promise settled by `POST /ui-response` →
  `resolveUiRequest(id, value)` (`src/host/piweb-host.ts`). The relay generalizes
  this to arbitrary calls.
- **Sandbox precedent:** `<pi-frame>` already runs extension HTML in a sandboxed
  iframe (`allow-scripts`, no `allow-same-origin`) and bridges via `postMessage`
  (`window.piweb.action/notify`). The frontend runtime generalizes that frame
  into a full module host.

---

## 4. API surface classification

Every `pi` / `ctx` / `piweb` member falls into exactly one bucket. The Proxy
dispatches by bucket.

| Bucket                         | Examples                                                                          | Mechanism                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Forward imperative**      | `notify`, `setStatus`, `setTitle`, `sendMessage`, `setModel`, `setThinkingLevel`  | `ext-call` (fire-and-forget or awaited ack).                                                                                                                                                              |
| **B. Forward async-return**    | `getContextUsage`, `getCommands`, `getActiveTools`                                | `ext-call` with `replyId`; Proxy returns a `Promise`.                                                                                                                                                     |
| **C. Callback registration**   | `on(event, fn)`, `registerCommand(name,{handler})`, `registerShortcut`            | Register `fn` locally → `ext-call` with a `subId`; host invokes via `ext-invoke`.                                                                                                                         |
| **D. Renderer registration**   | `piweb.registerToolRenderer`, `piweb.registerMessageRenderer`                     | **Local only.** Stored in the sandbox; returns a **serializable node tree** (pi's Box/Row/Text/Divider/Code/Markdown vocab) mounted by the existing `renderNode` — no host round-trip, no arbitrary HTML. |
| **E. Sync reads**              | `piweb.present`, `ctx.cwd`, `ctx.mode`, `ctx.hasUI`                               | Served from the **init state snapshot** (local); never a network call.                                                                                                                                    |
| **F. Capability / non-serial** | `registerTool({execute})`, `registerProvider`, `ctx.sessionManager`, `ctx.signal` | **Not supported browser-side** (Phase-gated). See §9.                                                                                                                                                     |

A machine-readable classification table lives in Appendix A and drives codegen /
runtime dispatch.

---

## 5. Wire protocol

All frames are JSON, thread-scoped, over the existing bus. New message `kind`s:

### 5.1 Browser → host (POST)

`POST /ext-call` — one relayed forward call.

```jsonc
{
    "threadId": "t_123",
    "extId": "split-diff", // which web extension instance
    "callId": "c_42", // present iff a reply is expected (bucket B)
    "method": "sendMessage", // dotted path allowed: "ctx.getContextUsage"
    "args": [/* JSON-serializable, functions stripped */],
    "subs": { "2": "fn" }, // arg index → subId for any callback args (bucket C)
}
```

`POST /ext-reply` — the browser's answer to a host `ext-invoke` (bucket C
middleware, or a command handler that returns).

```jsonc
{ "threadId": "t_123", "invokeId": "i_9", "ok": true, "value": { /* … */ } }
{ "threadId": "t_123", "invokeId": "i_9", "ok": false, "error": "message" }
```

`POST /ext-ready` — sandbox finished importing the module and registering; host
may flush queued events.

```jsonc
{ "threadId": "t_123", "extId": "split-diff", "subs": ["s_1", "s_2"] }
```

### 5.2 Host → browser (SSE frames)

`{ kind: "ext-load", ext: {…} }` — instruct the client to instantiate a web
extension (see §8 manifest) and hands over the **state snapshot**.

```jsonc
{
    "kind": "ext-load",
    "ext": {
        "id": "split-diff",
        "module": "/ext/split-diff/web.js",
        "capabilities": [
            "message-renderer",
            "tool-renderer",
            "on:tool_result",
            "command",
        ],
    },
    "snapshot": {
        "present": true,
        "cwd": "/home/austin/projects/pi-web",
        "mode": "web",
    },
}
```

`{ kind: "ext-invoke", … }` — host asks the browser to run a registered callback.

```jsonc
{
    "kind": "ext-invoke",
    "extId": "split-diff",
    "subId": "s_1", // which registered callback
    "invokeId": "i_9", // present iff the host awaits a reply (middleware)
    "args": [{/* serialized event */}],
    "deadlineMs": 2000, // host will proceed/timeout after this
}
```

`{ kind: "ext-reply", callId, ok, value|error }` — the answer to a bucket-B
`ext-call` (host→browser over SSE, correlated by `callId`).

`{ kind: "ext-unload", extId }` — tear down (thread switch, extension disabled).

### 5.3 Correlation

- **Bucket B** (`callId`): Proxy stores `resolve/reject` in a client-side map;
  settled on the matching `ext-reply` SSE frame. Mirrors `resolveUiRequest`.
- **Bucket C middleware** (`invokeId`): host stores `resolve/reject` keyed by
  `invokeId`; settled on `POST /ext-reply`. Timeout → §10 policy.
- **subId** is stable for the lifetime of a registration; the host maps
  `subId → live handler slot` (e.g. the `pi.on` unsubscribe closure).

---

## 6. The Proxy

Browser-side, one `Proxy` per surface (`pi`, `ctx`, `piweb`). Get-trap returns a
dispatcher chosen by Appendix-A bucket:

```ts
function makeProxy(path: string): any {
    return new Proxy(function () {}, {
        get(_t, prop: string) {
            if (prop in SYNC_SNAPSHOT[path]) return SYNC_SNAPSHOT[path][prop]; // E
            return makeProxy(`${path}.${prop}`); // dotted nesting
        },
        apply(_t, _this, args) {
            const method = path;
            const bucket = BUCKET[method] ?? "A";
            if (bucket === "D") return LOCAL.register(method, args); // renderer registry
            if (bucket === "F") throw new UnsupportedInFrontend(method);
            const subs = extractCallbacks(args); // C: fn → subId
            if (bucket === "B")
                return call(method, stripFns(args), subs, /*reply*/ true);
            return call(method, stripFns(args), subs, /*reply*/ false); // A / C
        },
    });
}
```

Key rules:

- **Callbacks never serialize.** `extractCallbacks` replaces each function arg
  with a `subId`, stores `subId → fn` in the local handler registry, and includes
  the map in `subs`. The host stores `subId → invoker`. When the host-side event
  fires, it emits `ext-invoke`; the browser runs the **local** function.
- **Return of a callback registration** (e.g. `pi.on` returns an unsubscribe fn):
  the Proxy returns a **local** function that, when called, sends
  `ext-call {method:"__unsub", subId}`.
- **Sync reads (E)** resolve from `SYNC_SNAPSHOT` (shipped in `ext-load`); a miss
  throws (never silently blocks). Snapshot is refreshed on relevant SSE frames
  (`theme`, `surfaces`, model/thinking changes) to stay coherent.

---

## 7. Sandbox & security

- **Isolation:** a **dedicated Worker** runs the extension's untrusted JS off the
  main thread. In v1 there is **no render iframe** — renderers return a
  serializable node tree (bucket D) that the trusted `app.ts` `renderNode` mounts,
  so no arbitrary HTML crosses the boundary. (A sandboxed-HTML `Frame` output
  path — `allow-scripts`, **no** `allow-same-origin`, as `<pi-frame>` does today —
  is deferred until web divergences are in scope; see §Scope.)
- **Module delivery:** the host serves the web module at `/ext/<id>/web.js`
  (bundled via `Bun.build`, like `src/host/build-web.ts` does for the app). The
  sandbox `import()`s it; no `eval` of host-trusted globals.
- **Capability allow-list:** each `ext-call` `method` is checked against the
  extension's declared `capabilities` (§8) **on the host**. Unlisted methods are
  rejected with an `ext-reply` error and logged. The browser is untrusted; the
  host is the enforcement point.
- **No ambient authority:** buckets A/B only reach in-process pi methods the host
  chooses to expose. Bucket F is unreachable from the browser by construction.

---

## 8. Extension declaration (manifest)

A web extension declares a **web entry point** and its capabilities so the host
knows what to expose and load. Two options:

**8a. Package field** (preferred, static):

```jsonc
// .pi/extensions/split-diff/manifest.json (or a field in the extension)
{
    "id": "split-diff",
    "web": "web.ts", // bundled → /ext/split-diff/web.js
    "capabilities": [
        "message-renderer", // bucket D
        "tool-renderer:edit", // bucket D, scoped to a tool
        "on:tool_result", // bucket C, event allow-list
        "command:split-diff", // bucket C
        "command:split-diff-auto",
        "notify",
        "select", // bucket A/B piweb methods
    ],
}
```

**8b. Host-side shim registers a web entry.** A conventional host module calls a
new host API `piweb.registerWebExtension({ id, module, capabilities })`; the host
then emits `ext-load`. This keeps a single portable extension that opts into a web
module when a host is present.

The host **must** validate capabilities; the manifest is a request, not a grant.

---

## 9. Capability boundary (bucket F)

Browser-resident code has no fs/exec/network-as-host. Therefore:

- `pi.registerTool({ execute })` where `execute` needs host capabilities:
  **unsupported** in Phase 1–2. A _pure_ tool (deterministic, no I/O) could be
  allowed later via an explicit `pureTool` API that runs `execute` in the Worker.
- `registerProvider`, `ctx.sessionManager`, `ctx.signal` (live), streaming:
  **unsupported**; the Proxy throws `UnsupportedInFrontend`. `ctx.signal` may be
  offered as an **abort event relay** (host emits `ext-invoke` on abort) rather
  than a live `AbortSignal`.

An extension needing bucket F must keep that part in a **host-side module** and
split responsibilities (host logic + web view), coordinated by the relay.

---

## 10. Liveness & multi-client policy

pi-web is multi-client (many tabs watch a thread) and can run **headless** (no
browser). This is the crux for bucket C.

- **Owner election:** for each `(threadId, extId)` the host designates exactly one
  connected SSE client as **owner** (first-ready wins; re-elect on disconnect).
  Only the owner receives `ext-invoke`. Non-owners still receive rendered output
  (surfaces/messages) like today.
- **No owner (headless / all tabs closed):**
    - **Bucket C fire-and-forget** (`pi.on` with no reply): **dropped** (with a
      counter/log). Web extensions must be **non-authoritative** — the agent's
      correctness cannot depend on a browser handler running.
    - **Bucket C middleware** (awaited): host applies the **default/identity**
      result (e.g. `tool_result` passes through unmodified) after `deadlineMs`.
    - Therefore: **middleware that must mutate agent behavior may not run as a web
      extension.** The manifest MUST NOT grant middleware capabilities that can
      change results unless the extension also provides a host-side default. This
      is enforced by capability policy (only "observing" event subscriptions are
      allowed browser-side by default).
- **Deadlines:** every awaited `ext-invoke` carries `deadlineMs`; on timeout the
  host resolves with the default and marks the owner degraded. Prevents a slow/
  hung tab from stalling turns.
- **Reconnect:** on owner reconnect, the host re-sends `ext-load` + snapshot; the
  sandbox re-registers; queued non-awaited events since disconnect are **not**
  replayed (they were dropped). Renderer state is rebuilt from the transcript.

---

## 11. Serialization rules

- Args/returns must be JSON. Functions → `subId` (bucket C) or stripped.
- Disallowed values (Map/Set/Date/BigInt/AbortSignal/Stream/class instances):
  rejected at the boundary with a clear error, or passed through a declared
  **codec** (e.g. Date↔ISO). No structured-clone reliance across the wire.
- Large payloads (diffs, file contents) are fine but subject to a size cap
  (config, default 1 MB) → oversize rejected with an error frame.
- Event payloads shipped to bucket-C handlers are the **already-serialized** event
  shapes the host emits today (e.g. `tool_result`'s `{toolName, input, details,
content, isError}`), not live objects.

---

## 12. Host changes (`src/host/`)

1. **`ext-host.ts` (new):** subscription table (`subId → invoker`), correlation
   registry (`invokeId`/`callId` promises — reuse the `resolveUiRequest`
   pattern), capability allow-list enforcement, owner election, snapshotter.
2. **`app.ts`:** add routes `POST /ext-call`, `POST /ext-reply`, `POST /ext-ready`;
   add SSE frame emitters `ext-load`, `ext-invoke`, `ext-reply`, `ext-unload`.
   Wire `onConnect` to emit `ext-load` for each registered web extension (after
   the existing `surfaces`/`theme` snapshot at `app.ts:236`).
3. **`piweb-host.ts`:** add `registerWebExtension({id,module,capabilities})`;
   generalize `resolveUiRequest` into a shared `resolveCall(id,value)`.
4. **`build-web.ts`:** bundle each web extension entry to `/ext/<id>/web.js`
   (dev: per-request rebuild under `PI_WEB_DEV`).
5. **Bridging registrations:** when a web extension calls `pi.on(evt, subId)`, the
   host attaches a real in-process listener that emits `ext-invoke` (respecting
   owner + capability + deadline).

## 13. Client changes (`src/web/`)

1. **`ext-runtime.ts` (new):** owns the sandbox (a **Worker**; no render iframe in v1), the
   `pi`/`piweb` Proxy, the local handler + renderer registries, the transport
   client (POST `ext-call`/`ext-reply`; SSE `ext-invoke`/`ext-reply`).
2. **`app.ts`:** on `ext-load`, instantiate the runtime; route `ext-invoke` to it;
   let its **renderer registry** feed the existing render paths — i.e. a
   web-extension `registerToolRenderer` populates the same map `pi-tool.ts`
   already consults (`getToolRenderer`), and `registerMessageRenderer` feeds the
   custom-message path. This is the change that finally lets an **extension**
   (not just built-in `app.ts`) override tool cards.
3. **Renderer bridge:** the sandboxed renderer returns a **serializable node
   tree** in pi's existing vocabulary (Box/Row/Text/Divider/Code/Markdown); the
   trusted `app.ts` `renderNode` mounts it. No DOM handles or HTML strings cross
   the Worker boundary in v1 — arbitrary-HTML `Frame` output is deferred (§Scope).

---

## 14. Worked proving case: port `split-diff` (TUI-matching first)

Target: the existing `.pi/extensions/split-diff/` runs **entirely frontend-side**
and _replaces_ the `edit` card — rendering through pi's serializable node
vocabulary (TUI-matching), **not** arbitrary `Frame` HTML.

- `web.ts` (bundled to `/ext/split-diff/web.js`) reuses the parsing logic
  (`alignRows`/`intraLine`) but emits a **node tree** instead of an HTML string.
- `export default (pi) => { … }` uses:
    - `ctx.ui.registerToolRenderer("edit", info => diffTree(info.details.diff))`
      — **bucket D, local**; returns Box/Row/Text/`Code` nodes the existing
      `renderNode` mounts. v1 renders a **unified** diff (TUI-matching); a
      side-by-side layout — a deliberate divergence — is a later opt-in (§Scope).
    - `pi.on("tool_result", …)` — **bucket C, observing only** (headless-safe;
      dropped when no owner). Populates the `/split-diff` picker list.
    - `pi.registerCommand("split-diff", handler)` — **bucket C**; handler runs in
      the sandbox, calls `ctx.ui.select` (**bucket B**, awaited) and
      `pi.sendMessage` (**bucket A**).
- Manifest capabilities: `["tool-renderer:edit","message-renderer",
"on:tool_result","command:split-diff","notify","select"]`.
- Acceptance: with a browser connected, an extension **replaces** the `edit` card
  via the node tree; **headless**, the agent runs normally and no turn stalls.

---

## 15. Phased implementation plan

| Phase | Scope                                                                                                                   | Exit criterion                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **0** | Spec + Appendix-A classification table; capability-policy defaults.                                                     | This doc reviewed; table committed.                                            |
| **1** | Transport + sandbox: `ext-load`, `ext-call` (A/B), `ext-reply`, snapshot, Proxy, Worker.                                | A web extension can `notify`/`sendMessage`/read `present` from the browser.    |
| **2** | Renderer bucket (D): local `registerToolRenderer`/`registerMessageRenderer` returning **node trees** feeding `src/web`. | An extension **replaces** the `edit` card with a TUI-matching renderer.        |
| **3** | Callbacks (C, observing): `pi.on`, `registerCommand`, owner election, drop-when-headless.                               | `/split-diff` command + picker works; headless is a safe no-op.                |
| **4** | Awaited middleware (C-await) with deadlines + defaults; strict capability policy.                                       | `tool_result` observe-with-default demoed; timeouts proven not to stall turns. |
| **5** | Hardening: size caps, codecs, reconnect/re-election, metrics, docs in `extension-points.md`.                            | Fuzz/timeouts/multi-tab tests green.                                           |

Bucket F (capabilities / live objects) **and all web-only surface** — rails,
overlays, and `Frame` — are **out of scope** for v1 (see §Scope); they return as
later, explicitly-justified phases.

---

## 16. Testing plan

- **Unit (host):** capability enforcement (reject unlisted method), correlation
  registry settle/timeout, owner election on connect/disconnect, snapshot build.
- **Unit (client):** Proxy dispatch by bucket, callback→subId extraction,
  unsubscribe, sync-read from snapshot, `UnsupportedInFrontend` for bucket F.
- **Integration:** `split-diff` end-to-end (Phase 2/3) via the existing test
  harness (`bun test`, `/app.js` build test as a model).
- **Liveness:** middleware timeout applies default; headless drop counters;
  multi-tab single-owner; reconnect re-registration.
- Keep `bun test` green; `bun run typecheck`; `bun run format`.

---

## 17. Open questions

1. **Owner UX:** should the user see which tab owns an extension? Auto-handoff on
   focus, or sticky until disconnect?
2. **Pure tools (F-lite):** worth a `pureTool` API that runs `execute` in the
   Worker for I/O-free tools, or keep all tools host-side?
3. **Renderer result model:** _resolved for v1_ — a **serializable node tree**
   (pi's `renderNode` vocabulary), mounted by trusted `app.ts`. `Frame`
   (arbitrary HTML) and canvas/DOM-patch protocols are deferred (§Scope).
4. **Portability:** do we require a web extension to _also_ be a valid host
   extension (single module, `piweb.present` guard), or allow web-only bundles?
5. **State snapshot coherence:** enumerate exactly which sync reads are supported
   and their refresh triggers (theme, model, cwd, mode, present).
6. **Versioning:** protocol version in `ext-load`; negotiate on mismatch.
7. **`piweb` convergence:** with web regions + `Frame` deferred, most of `piweb`
   folds into the relayed `ctx.ui` (`notify`/`setStatus`/dialogs) and `ctx.mode`
   (`"web"`) replaces `piweb.present`. Do web extensions import `piweb` at all, or
   only `pi`/`ctx`? (Host-resident extensions keep `piweb` regardless.)

---

## Appendix A — API bucket table (excerpt)

> The authoritative table is code (drives dispatch). Excerpt for review:

| Method                                          | Bucket | Notes                                                            |
| ----------------------------------------------- | :----: | ---------------------------------------------------------------- |
| `piweb.notify`                                  |   A    | fire-and-forget                                                  |
| `piweb.setStatus` / `setTitle`                  |   A    |                                                                  |
| `pi.sendMessage` / `sendUserMessage`            |   A    |                                                                  |
| `pi.setModel` / `setThinkingLevel`              |   A    |                                                                  |
| `piweb.select` / `confirm` / `input` / `editor` |   B    | awaited; already correlated via `/ui-response`                   |
| `pi.getContextUsage` / `getCommands`            |   B    | async return                                                     |
| `pi.on(event, fn)`                              |   C    | observing by default; middleware gated (§10)                     |
| `pi.registerCommand(name,{handler})`            |   C    |                                                                  |
| `pi.registerShortcut`                           |   C    | terminal-only semantics; may be N/A                              |
| `piweb.registerToolRenderer`                    |   D    | local; returns node tree; feeds `src/web` map (no `Frame` in v1) |
| `piweb.registerMessageRenderer`                 |   D    | local; returns serializable tree                                 |
| `piweb.present`                                 |   E    | snapshot                                                         |
| `ctx.cwd` / `ctx.mode` / `ctx.hasUI`            |   E    | snapshot                                                         |
| `pi.registerTool({execute})`                    |   F    | unsupported (capability); host-side only                         |
| `pi.registerProvider`                           |   F    | unsupported                                                      |
| `ctx.sessionManager` / `ctx.signal`             |   F    | unsupported (live object); abort may be relayed                  |

```

```
