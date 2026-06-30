# pi-web roadmap

Status legend: ✅ done · 🚧 partial · ⬜ not started

## Where we are

- ✅ In-process agent host (`createAgentSession`) + SSE/POST bus (`server.mjs`)
- ✅ `piweb` panel registry: serializable component tree + in-process action dispatch
- ✅ Streaming transcript; prompt box; `sendUserMessage` from a panel
- 🚧 `/reload` (best-effort; may not re-instantiate session extensions)
- ⬜ Tests / health check (correctness = eyeballing the browser)
- ⬜ `ExtensionUIContext` bridge (`ctx.ui.*` → web) — see `docs/ui-bridge.md`
- ⬜ **Thread (session) switching** — the immediate next phase, detailed below

Key limitation to fix early: the host uses `SessionManager.inMemory(cwd)`, so the
conversation is **ephemeral and single-threaded**. Everything thread-related depends on
moving to a persistent, file-backed `SessionManager`.

---

## Phase 0 — Lock down the core (MVP-0)

Make the model-independent plumbing provable, so it can gate CI.

- `GET /health` endpoint.
- `bun test` smoke test: boot on an ephemeral port → assert `/health` → open `/events`,
  read first `panels` frame (expect `hello`) → `POST /action` `inc` → assert next frame
  shows `count = 1`.
- Make model pinning non-fatal (already only warns) so boot never needs auth.

**Exit:** `bun test` green without any credentials.

---

## Phase 1 — Thread switching ← current request

### Goal

List conversation threads, switch the active one, and start new threads from the cockpit.
A "thread" = one pi **session** (one session file).

### Backend

1. **Persist sessions.** Replace `SessionManager.inMemory(cwd)` with a file-backed
   manager (default dir `~/.pi/agent/sessions/<encoded-cwd>/`). Now sessions survive
   restarts and are enumerable.
2. **Endpoints**
    - `GET  /threads` → `SessionManager.list(cwd)` → `SessionInfo[]`
      (`id, name?, created, modified, messageCount, firstMessage`).
    - `POST /threads` → create a new thread (`sessionManager.newSession()`), switch to it.
    - `POST /threads/switch` `{ id | path }` → make it active.
    - `POST /threads/rename` `{ id, name }` (optional; writes a `session_info` entry).
3. **Switch mechanism.** The SDK surface has no in-place "load arbitrary session" on
   `AgentSession` (only `reload`, tree `navigate` within one file, and `fork`). So switch
   by **recreating** the agent session bound to the chosen file:
    - guard: refuse to switch while a turn is running (`session.isBusy`-style check);
    - `session.dispose()`;
    - build a `SessionManager` pointing at the target session file
      (`setSessionFile` / `newSession`);
    - `createAgentSession({ ... })` reusing the existing `resourceLoader`, `authStorage`,
      `modelRegistry`; re-pin model; re-`subscribe` the event translator.
    - **Validate** whether `resourceLoader`/extension state can be reused across recreations
      or must be rebuilt (affects panel re-registration).
4. **Transcript replay.** On switch, the browser must show the target thread's history.
   Read the resolved branch (`sessionManager.getBranch()` / `getEntries()` →
   `buildSessionContext`), convert message entries to transcript frames, and emit them
   over SSE before resuming live events. Add a `kind: "transcript_reset"` frame so the
   client clears first.

### Frontend

- Thread switcher in the header (dropdown or left sidebar): list with name/first message +
  relative `modified`; "＋ New thread" button.
- On switch: clear transcript, render replayed history, then stream live.
- New SSE frames: `{ kind: "threads", items }`, `{ kind: "thread_switched", id }`,
  `{ kind: "transcript_reset" }`.

### Edge cases / decisions

- **Mid-turn switch** → block or auto-interrupt.
- **Panel state** is currently global; decide whether panels are per-thread or shared
  (initially: shared, re-rendered after switch).
- **Branches vs threads:** intra-session tree navigation/`fork` is a _separate_ feature
  (Phase 3); Phase 1 is distinct session files only.

**Exit:** can list threads, create a thread, switch between two threads with correct
history replay, without restarting the host.

---

## Phase 2 — ExtensionUIContext bridge

Implement `ctx.ui.*` over the bus (`docs/ui-bridge.md`):
`notify` → `confirm` (permission gates) → `select`/`input` → `setStatus`/`setWidget`.
Adds `+ POST /ui-response` and `kind: "ui_request"` SSE frames; introduce `ctx.mode === "web"`.

## Phase 3 — Richer surfaces

- Per-tool result cards from the tool event stream.
- Context/usage + cost meters (`ContextUsage`, `SessionStats`).
- Session **tree / branches**: visualize and navigate within a thread; `fork`.

## Phase 4 — Models, auth, projects

- Model picker (`ModelRegistry`); login flows (`AuthStorage`: API key / OAuth) as web forms.
- Multi-project routing (one cockpit, many cwds via `SessionManager.listAll`).

## Cleanup (ongoing)

- Resolve the dead SDK shim: either wire `hello-panel.ts` to import `@pi-web/sdk`
  (and make the name resolve) or delete `src/sdk/piweb.mjs` until it's real.
- Make `/reload` actually re-instantiate session extensions.
