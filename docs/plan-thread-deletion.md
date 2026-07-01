# Plan: Thread (session) deletion + rename in pi-web

Goal: bring the web UI to **exact parity** with the pi TUI's session-selector
delete/rename flow (`@earendil-works/pi-coding-agent`
`dist/modes/interactive/components/session-selector.ts`).

## Parity target (what the TUI does)

In the "Resume Session" selector:

- **`Ctrl+D`** (`app.session.delete`) or **`Ctrl+Backspace`**
  (`app.session.deleteNoninvasive`, only fires when the search box is empty)
  starts an inline **delete confirmation** on the highlighted session.
- The header switches to `Delete session? [Enter] confirm · [Esc] cancel`,
  and the target row turns red. **Enter** confirms, **Esc** cancels; all other
  keys are swallowed while confirming.
- Deletion runs `deleteSessionFile(path)`: try the **`trash`** CLI first
  (recoverable); if it isn't installed / fails and the file still exists, fall
  back to a permanent **`unlink`**. Status message: `"Session moved to trash"`
  vs `"Session deleted"`; failures show `"Failed to delete: <err>"`.
- **Guard:** the _currently active_ session cannot be deleted
  (`"Cannot delete the currently active session"`).
- After a successful delete the list is filtered locally and reloaded.
- Adjacent feature in the same selector: **`Ctrl+R`** (`app.session.rename`)
  renames via `appendSessionInfo`. Included here since it's part of the
  selector's "exact functionality," but delete is the primary deliverable.

## Current web architecture (relevant pieces)

- **Host route surface** — `src/host/app.ts`: `threads` callback bag
  (`list/create/switch/clone/fork/importJsonl`) + `POST /threads/*` routes.
- **Host impl** — `src/host/server.ts`: the `threads` object (`list()` builds
  items from `SessionManager.listAll()` + live registry; `clone/fork` use
  `rt.session.sessionManager.getSessionFile()`), `broadcastThreads()` fans the
  list over SSE, and `sessionApi.setName()` already renames the _active_ thread.
- **Web picker** — `src/web/app.ts`: `openPicker()` renders "Resume thread"
  rows from `threadItems` (kept fresh by SSE); `pickerNav` gates Up/Down/Enter/
  Home/End in the keydown handler near L2362; `closePicker()` tears down.
- `SessionInfo` (from the SDK) exposes `.path` and `.id`; the web `list()`
  deliberately omits `.path`, so the browser never sees filesystem paths.

---

## Backend changes

### 1. `src/host/app.ts` — extend the `threads` type + add routes

Add to the `threads?: { … }` type:

```ts
delete?: (threadId: string) => Promise<{ ok: boolean; method?: "trash" | "unlink"; error?: string }>;
rename?: (threadId: string, name: string) => Promise<any>;
```

Add two thread-scoped routes next to `/threads/clone` etc.:

```ts
router.post("/threads/delete", async ({ res, body }) => {
    try {
        const result = (await threads?.delete?.(body.threadId)) ?? {
            ok: false,
        };
        sendJson(res, result.ok ? 200 : 400, result);
    } catch (err) {
        sendJson(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
});
router.post("/threads/rename", async ({ res, body }) => {
    try {
        const result =
            (await threads?.rename?.(body.threadId, body.name)) ?? {};
        sendJson(res, 200, result);
    } catch (err) {
        sendJson(res, 400, { error: String(err?.message ?? err) });
    }
});
```

### 2. `src/host/server.ts` — port `deleteSessionFile` + implement callbacks

Port the TUI helper verbatim (keep it server-side; it needs `spawnSync`,
`existsSync`, `unlink`):

```ts
import { spawnSync } from "node:child_process";
import { unlink } from "node:fs/promises";
// existsSync already imported

async function deleteSessionFile(sessionPath) {
    const trashArgs = sessionPath.startsWith("-")
        ? ["--", sessionPath]
        : [sessionPath];
    const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });
    // ... (trash error-hint builder, exactly as the TUI) ...
    if (trashResult.status === 0 || !existsSync(sessionPath)) {
        return { ok: true, method: "trash" };
    }
    try {
        await unlink(sessionPath);
        return { ok: true, method: "unlink" };
    } catch (err) {
        // compose unlink + trash hint, as the TUI does
        return { ok: false, method: "unlink", error };
    }
}
```

Add a helper to resolve a `threadId` → on-disk session file path (loaded first,
then disk lookup so unloaded/old threads are deletable):

```ts
async function sessionFileForThread(threadId) {
    const rt = threadRuntimes.get(threadId);
    const live = rt?.session?.sessionManager?.getSessionFile?.();
    if (live) return live;
    const infos = await SessionManager.listAll().catch(() => []);
    return infos.find((i) => i.id === threadId)?.path;
}
```

Add to the `threads` object:

```ts
async delete(threadId) {
    if (!threadId) throw new Error("missing threadId");

    // Parity guard: never delete a thread with a turn in flight, and mirror
    // the TUI's "currently active session" block. In the web there is no single
    // active thread (multi-client), so we block any *loaded & running* thread.
    const rt = threadRuntimes.get(threadId);
    if (rt?.busy) throw new Error("Cannot delete a running thread");

    const file = await sessionFileForThread(threadId);
    if (!file) {
        // Not yet flushed to disk (no assistant message). Just drop it from the
        // registry so it disappears from the list — nothing to unlink.
        threadRuntimes.delete(threadId);
        broadcastThreads();
        return { ok: true, method: "unlink" };
    }

    const result = await deleteSessionFile(file);
    if (result.ok) {
        threadRuntimes.delete(threadId); // evict any live copy
        broadcastThreads();               // SSE → every client re-renders the list
    }
    return result;
},

async rename(threadId, name) {
    const n = (name ?? "").trim();
    if (!n) throw new Error("missing name");
    const s = sessionFor(threadId);
    if (s) { s.setSessionName(n); broadcastThreads(); return { ok: true }; }
    // Unloaded thread: open its SessionManager, append session_info, done.
    const file = await sessionFileForThread(threadId);
    if (!file) throw new Error(`unknown thread: ${threadId}`);
    const sm = SessionManager.open(file);
    sm.appendSessionInfo(n);
    broadcastThreads();
    return { ok: true };
},
```

Notes:

- `broadcastThreads()` already re-lists and pushes to all SSE clients, so open
  pickers refresh automatically — matching the TUI's post-mutation reload.
- Deleting a thread another browser tab is _viewing_ is acceptable (the TUI
  only protects the _active_ session). That viewer keeps its last transcript
  until it navigates; optionally push a `thread-gone` frame later (out of scope).

---

## Frontend changes — `src/web/app.ts`

### 3. Track the session id per picker row + a confirm state

In `openPicker()` the row factory `mk(...)` already closes over `t`. Extend it
so each thread row stores its id and whether it's deletable:

```ts
item.dataset.threadId = t.id;
item.dataset.deletable = String(!(t.id === activeThreadId || t.running));
```

Add module state near `pickerItems`:

```ts
let pickerConfirmId = null; // threadId awaiting delete confirmation, or null
```

Render an inline hint line under `<h3>Resume thread</h3>` mirroring the TUI
header (normal vs confirming), e.g. a `<div class="picker-hint">` updated by a
small `renderPickerHint()` that shows either
`↑↓ move · Enter open · Ctrl+D delete` or, when `pickerConfirmId`,
`Delete thread? Enter confirm · Esc cancel` in the error color. Give the
confirming row a `.confirm-delete` class (red), reusing the transcript theme's
error color.

### 4. Keybindings in the picker keydown handler (near L2362)

Extend the `if (!pickerNav …) return;` handler:

```ts
// While confirming, swallow everything except Enter/Esc (TUI behavior).
if (pickerConfirmId) {
    if (e.key === "Enter") {
        e.preventDefault();
        confirmDeleteThread();
    } else if (e.key === "Escape") {
        e.preventDefault();
        cancelDeleteThread();
    } else e.preventDefault();
    return;
}
// Ctrl+D or Ctrl+Backspace → start confirmation on the selected row.
if (e.ctrlKey && (e.key === "d" || e.key === "Backspace")) {
    e.preventDefault(); // stop the browser's bookmark shortcut
    startDeleteConfirmForSelected();
    return;
}
```

Keep the existing Escape precedence handler working: when `pickerConfirmId` is
set, the confirm branch above consumes Esc first (it runs in this handler, which
is registered before the global Escape handler and calls `preventDefault`).
If ordering is fragile, gate the global Escape handler with
`if (pickerConfirmId) return;`.

### 5. Delete helpers

```ts
function startDeleteConfirmForSelected() {
    const el = pickerItems[pickerIndex];
    const id = el?.dataset?.threadId;
    if (!id) return; // "＋ New thread" row, etc.
    if (el.dataset.deletable !== "true") {
        toast("Cannot delete the currently active thread", "error");
        return;
    }
    pickerConfirmId = id;
    el.classList.add("confirm-delete");
    renderPickerHint();
}

function cancelDeleteThread() {
    const el = pickerItems[pickerIndex];
    el?.classList.remove("confirm-delete");
    pickerConfirmId = null;
    renderPickerHint();
}

async function confirmDeleteThread() {
    const id = pickerConfirmId;
    pickerConfirmId = null;
    const r = await (
        await postThread("/threads/delete", { threadId: id })
    ).json();
    if (r.ok) {
        toast(
            r.method === "trash" ? "Thread moved to trash" : "Thread deleted",
            "info",
        );
        // SSE broadcastThreads() will refresh threadItems; re-render the open
        // picker from the new list, preserving a sensible selection.
        if ($overlay?.classList.contains("show")) openPicker();
    } else {
        toast(`Failed to delete: ${r.error ?? "unknown error"}`, "error");
        renderPickerHint();
    }
}
```

`postThread` already injects `activeThreadId`; here we override with the target
`threadId` in the body (server keys off `body.threadId`).

### 6. Re-render on SSE

`threadItems` is already updated on every `threads` SSE frame. Add: if the
resume picker is open when a `threads` frame arrives, call `openPicker()` to
rebuild it (guard against clobbering an in-progress `pickerConfirmId` — skip the
rebuild while confirming). This mirrors the TUI's list refresh.

### 7. Optional rename (Ctrl+R) — same selector

To fully match the selector, add `Ctrl+R` → inline rename input in the picker
(reuse the blocking-input dialog chrome or an inline `<input>`), POSTing
`/threads/rename { threadId, name }`. Can ship in a follow-up if we want delete
first.

---

## Edge cases / parity checklist

- [ ] `Ctrl+D` preventDefault so the browser doesn't bookmark.
- [ ] Confirming swallows all keys but Enter/Esc (TUI parity).
- [ ] Active/running thread blocked with the exact message text.
- [ ] `trash` success **or** file-already-gone ⇒ treated as success.
- [ ] Permanent `unlink` fallback with combined error hint.
- [ ] Not-yet-flushed (no session file) threads: drop from registry, `ok`.
- [ ] List auto-refreshes for **all** connected clients via `broadcastThreads()`.
- [ ] Filesystem paths never sent to the browser (id-only API preserved).
- [ ] Deleting the row you're viewing doesn't crash the viewer.

## Tests

- **Host unit** (`test/`): `deleteSessionFile` with `trash` present/absent
  (stub `spawnSync`), and `threads.delete` resolving loaded vs on-disk ids,
  the running-thread guard, and the no-file path. Assert `broadcastThreads`
  fires and the registry entry is evicted.
- **Route test**: `POST /threads/delete` returns `{ok, method}` / 400 on error;
  `POST /threads/rename` appends the name.
- **DOM test** (happy-dom harness, like the transcript tests): open picker,
  send `Ctrl+D`, assert confirm hint + red row; `Enter` calls fetch and
  re-renders; `Esc` cancels; active-row `Ctrl+D` toasts the guard message.

## Docs / tracking

- `docs/extension-points.md`: add a row for thread delete/rename parity.
- `docs/render-model-parity.md`: note `/threads/delete` + `/threads/rename`.
- `TODO.md`: add the item and link this plan.

## File-by-file summary

| File                          | Change                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/host/app.ts`             | `threads.delete?/rename?` types; `POST /threads/delete`, `/threads/rename` routes                                   |
| `src/host/server.ts`          | port `deleteSessionFile`; `sessionFileForThread`; `threads.delete`/`rename` impls                                   |
| `src/web/app.ts`              | picker delete affordance, `Ctrl+D`/`Ctrl+Backspace` + confirm state, helpers, SSE re-render, (opt.) `Ctrl+R` rename |
| `src/web/index.html` / styles | `.confirm-delete`, `.picker-hint` styling (error color)                                                             |
| `test/…`                      | host unit + route + DOM tests                                                                                       |
| `docs/*`, `TODO.md`           | parity notes                                                                                                        |
