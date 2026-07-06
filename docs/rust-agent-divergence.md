# Divergence Plan — Rust-Native Agent (HTMX UI + WASI Extensions)

**Status:** architecture decisions locked; two spikes open
**Relationship to `docs/rust-rewrite-plan.md`:** a deliberate _fork_, not a port.
**Date:** 2026-07-02

---

## 0. What this is (and is not)

`docs/rust-rewrite-plan.md` describes a **line-by-line, byte-parity port** of pi/pi-tui/
pi-sdk/pi-web from TypeScript to Rust, gated by an oracle that diffs against TS `pi`
@ v0.80.2.

This document describes a **different product** that keeps pi's agent core faithfully
but _forks_ the UI and extension layers:

- **Rust for everything.**
- **UI delivered as server-rendered HTML over HTMX** (+ JS enhancement), not a WASM SPA.
- **Extensions are WASI 0.3 components** (Zed-style), authored in any language that
  compiles to a component — **not** source-compatible with pi's `.ts` extensions.
- **Self-extension compiles Rust → WASM on the fly** (server-side toolchain).

### 0.1 The load-bearing consequence

Because the UI and extension surfaces are from-scratch, **there is no TS artifact to
diff against for those layers** — the byte-parity oracle (§8 of the port plan) does
**not** apply to them. It still applies, unchanged, to the faithful core.

| Layer                             | Parity model                                                           |
| --------------------------------- | ---------------------------------------------------------------------- |
| `pi-ai` + `pi-agent-core` + tools | **Faithful port**, oracle-gated vs TS v0.80.2 (port plan §8)           |
| TUI renderer / node vocabulary    | Internal parity: node→ANSI and node→HTML must agree                    |
| Extension API                     | **Shape/semantic parity** with pi's `ExtensionAPI` (not source parity) |
| Web frontend                      | New; no TS oracle                                                      |

"Feature parity + extension-API parity" is the north star — **not** byte-identical
output.

---

## 1. Architecture

Extensions and the agent emit an **abstract node tree** (pi's vocabulary:
`Box/Text/Spacer/AnsiBlock/Image/Markdown/Row/Divider` + web-only `Frame/Button/Input`).
Two backend renderers consume it. HTMX is **only the web transport**, not "the UI."

```
                          ┌───────────────► TUI renderer ──► ANSI  (terminal client)
extension (WASI) ─┐       │
                  ├─► node tree (host) ─────┤
agent core       ─┘       │
                          └───────────────► web renderer ──► HTML + HTMX/SSE (browser)
```

- The node tree is the **central contract** and a **versioned artifact**.
- The primary UI oracle becomes: _the two backends of the same node tree agree_
  (this is pi-web's existing `render-model-parity.md` concept, extended with a TUI
  backend).

---

## 2. Locked decisions

| #        | Topic                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core     | Agent/providers/tools    | **Faithful port** of `pi-ai` + `pi-agent-core` + tools; unchanged from `rust-rewrite-plan.md` Phases 0–3. Divergences below do not touch it.                                                                                                                                                                                                                                                                                                 |
| Q1       | Render model             | Extensions emit an **abstract node tree**; TUI renders ANSI, web renders HTML; **HTMX is the web backend, not the UI**. Node schema is versioned.                                                                                                                                                                                                                                                                                            |
| Q2       | Editors                  | **Full pi `Editor` in the TUI**; **`<textarea>` on web** (browser owns cursor/undo/IME/paste). Follows pi-web's `src/web/pi-composer.ts`. **Autocomplete is host-driven** (computed host-side, pushed to both TUI editor and web composer via a `pi-input {text,caret}` channel), so `@file`/slash logic isn't forked. `setEditorComponent` is **out of scope on web** — partial editor-hook parity accepted.                                |
| Q3       | Multi-client             | **Mirror** the transcript to all clients; **composer stays local per client** (no co-editing the textarea). Extension dialogs (`confirm/select/input`) render on **all** clients with **first-answer-wins + resolve-and-retract** (dismiss on every other client, ignore late answers). Pure-display overlays mirror; blocking overlays use the retract path.                                                                                |
| Q4       | Extension API versioning | **Zed-style**: pin a WIT world per version, keep **all historical worlds** compiled into the host, read each component's declared `schema_version`, instantiate against the matching world via an adapter. Standing tax that grows with API surface — **freeze the extension API early, additive-only changes**, reserve breaking changes for new worlds.                                                                                    |
| Q5       | Event delivery           | Keep pi's `on(type, handler)` (opt-in by type — good for parity). Cross-boundary cost is the new problem: model hot/fat payloads (`AssistantMessage` partial) as WIT **`resource`** (opaque handle + lazy accessors) so the growing text is **never re-serialized per token**. Model the `message_update` firehose as a 0.3 **`stream<message-delta>` + `future<result>`**, and **coalesce** so a slow handler can't stall the token stream. |
| Q6       | Auth                     | **No app-level auth.** Solo tailnet; Tailscale ACLs _are_ the auth. **Invariant: `tailscale serve` only, never `tailscale funnel`** (funnel = public, zero-auth, remote unsandboxed bash).                                                                                                                                                                                                                                                   |
| Ext      | Extension execution      | **WASI 0.3 components**, any source language. **No** source-compat with pi's `.ts` extensions (existing pi extensions must be rewritten).                                                                                                                                                                                                                                                                                                    |
| Self-ext | Rust → WASM              | Agent authors Rust, host **compiles server-side** to a component and hot-reloads. Toolchain (rustc + `wasm32-wasip2`/p3 target + `cargo-component`) lives on the **serve host**, not the client.                                                                                                                                                                                                                                             |

### 2.1 Trust model (bifurcated)

The WASI runtime sandbox is only as tight as the capabilities granted, and API parity
forces granting FS/Shell host imports to any extension that registers a real tool.
Combined with the agent's **already-unsandboxed `bash` tool**, this splits:

| Tier          | Source                  | Capabilities                          | Is the sandbox meaningful?                  |
| ------------- | ----------------------- | ------------------------------------- | ------------------------------------------- |
| Self-authored | the agent               | Full (FS + Shell host imports)        | **No** — the agent already has `bash`       |
| Third-party   | registry / tailnet peer | Declared in manifest + trust-prompted | **Yes** — this is where WASI earns its keep |

Consequence: don't spend effort sandboxing the _compile_ step (`build.rs`/proc-macros
run native code, but the agent can already run arbitrary bash — no new trust floor).
Capability grants and the trust prompt matter only for **distributed** extensions.

---

## 3. Impact on the port plan's crates

| Port-plan crate                             | Fate in this fork                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`                                     | Unchanged — faithful, oracle-gated. Still Phase 1.                                                                                                                                                    |
| `pi-agent-core`                             | Unchanged — faithful.                                                                                                                                                                                 |
| tools (`pi-coding-agent` core)              | Unchanged — faithful.                                                                                                                                                                                 |
| `pi-tui`                                    | **Kept**, but demoted to _one of two_ node-tree backends.                                                                                                                                             |
| `pi-web-frontend` (WASM SPA)                | **Replaced** by server-rendered HTML + HTMX (net simplification).                                                                                                                                     |
| Extension host (`rquickjs`, port-plan §7.1) | **Replaced** by a **wasmtime component host** + WIT world mirroring `ExtensionAPI`/`ExtensionUIContext` + a **server-side Rust→WASM build service**. Net _more_ work than rquickjs; biggest new risk. |

---

## 4. WASI 0.3 status (relevant because extensions are guests)

WASI 0.3.0 ratified **2026-06-11**; async is native to the component model
(`async func`, `stream`, `future`; `wasi:io` absorbed into the canonical ABI).

| Layer                                                                           | Status                    | Risk for us                           |
| ------------------------------------------------------------------------------- | ------------------------- | ------------------------------------- |
| 0.3 spec + resources/streams/futures                                            | Stable                    | None                                  |
| Host runtime (Wasmtime 46, `component-model-async` on by default)               | Shipped                   | None — our host is ready              |
| jco (JS guest)                                                                  | Close behind              | N/A                                   |
| **Rust guest async bindgen** (`wit-bindgen` / `cargo-component` vs a 0.3 world) | **In progress at launch** | **Confirm before committing the WIT** |

**Fallback if Rust guest async isn't fully baked:** model the extension interface
**without guest-side `async fn`** — sync host imports plus `future`/`stream` _returns_
that the (ready) host drives. No 0.2 fallback needed.

Bonus: 0.3 streams carry a terminal `future<result>` so a reader that stops early still
learns success/error — exactly the shape wanted for the coalesced `message_update`
stream (Q5).

---

## 5. Open spikes (do before writing feature code)

1. **Rust guest-toolchain spike (~30 min).** Build a trivial `async func` guest against
   a 0.3 world with `wit-bindgen` + `cargo-component`. Confirms §4's one remaining risk.
   If it fails, adopt the sync-guest-shape fallback.

2. **Self-extension compile / hot-reload loop (largest unspecified mechanism).** Define:
    - **Build-time UX** — a streamed build-log widget for the (seconds-to-tens-of-seconds)
      compile; the agent's edit loop is minutes-scale, not pi's instant jiti eval.
    - **Compile-error feedback** — pipe `rustc` errors back to the agent as a tool result
      so it can iterate (good fit for an agent; must be structured).
    - **Hot-reload / state semantics** — a resident stateful component gets recompiled:
      drop linear-memory state or migrate? What happens to its registered
      tools/subscriptions/widgets mid-session? Define reload = re-instantiate + re-register.
    - **Justify Rust→WASM over an in-process native tool** — the payoff is uniform ABI +
      **distributability** (share a compiled extension to tailnet peers as a portable
      artifact). If self-extensions never leave the box, this is pure cost — revisit.

---

## 6. Recommended sequencing

Unchanged from the port plan for the core; the fork only re-slots the UI/extension work.

1. **Faithful core first** — `pi-ai` → `pi-agent-core` → tools (port-plan Phases 0–3,
   oracle-gated). All divergences sit above this and don't touch it.
2. **Node vocabulary + two renderers** — TUI (ANSI) and web (HTML/HTMX); wire the
   internal render-model-parity check.
3. **Web host** — axum, in-process agent, SSE mirror bus, POST command bus, textarea
   composer with host-driven autocomplete, multi-client mirror + dialog retract.
4. **Extension host** — wasmtime component host, WIT world (mirroring `ExtensionAPI`),
   resource-typed hot payloads, versioned worlds. _Gated on spike #1._
5. **Self-extension build service** — server-side Rust→WASM + hot-reload. _Gated on
   spike #2._
