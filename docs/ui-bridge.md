# pi-web ExtensionUIContext bridge

pi exposes interactive UI to extensions through **`ExtensionUIContext`** (`ctx.ui.*`).
Each runtime mode (`tui`, `rpc`, `print`) ships its own implementation. **pi-web is a
fourth host**: it implements the same interface over the browser bus (SSE + POST), so
that **unmodified pi extensions** that call `ctx.ui.confirm(...)`, `ctx.ui.select(...)`,
etc. light up in the web cockpit.

This mirrors how RPC mode works (`docs/rpc.md`): dialog calls become a request/response
sub-protocol layered on the existing event/command flow.

## Method taxonomy

`ExtensionUIContext` methods fall into three buckets. Only the first two are bridgeable
to a web client; the rest require a real terminal and are no-ops/degraded (guard with
`ctx.mode`).

### 1. Dialog methods — request → block → response

The host emits a request to the browser and **awaits** a matching response before the
extension's promise resolves.

| Method    | Signature                                 | Resolves with                           |
| --------- | ----------------------------------------- | --------------------------------------- |
| `select`  | `select(title, options: string[], opts?)` | chosen `string` \| `undefined` (cancel) |
| `confirm` | `confirm(title, message, opts?)`          | `boolean`                               |
| `input`   | `input(title, placeholder?, opts?)`       | `string` \| `undefined` (cancel)        |
| `editor`  | `editor(title, prefill?)`                 | `string` \| `undefined` (cancel)        |

`opts: ExtensionUIDialogOptions = { signal?: AbortSignal; timeout?: number }`.
If `timeout` is set, the host auto-resolves with the default when it expires (the client
need not track timeouts), matching RPC semantics.

### 2. Fire-and-forget methods — request, no response

| Method          | Signature                                            | Web surface                                        |
| --------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `notify`        | `notify(message, type?: "info"\|"warning"\|"error")` | toast / transcript notice                          |
| `setStatus`     | `setStatus(key, text \| undefined)`                  | status-bar region (clear on `undefined`)           |
| `setWidget`     | `setWidget(key, string[] \| undefined, opts?)`       | docked widget region (`aboveEditor`/`belowEditor`) |
| `setTitle`      | `setTitle(title)`                                    | document title                                     |
| `setEditorText` | `setEditorText(text)`                                | prefill the prompt box                             |

(The component-factory overload of `setWidget`/`setFooter`/`setHeader` is TUI-only — see #3.)

### 3. TUI-only / degraded (web = no-op, guard with `ctx.mode`)

`custom()`, `setFooter()`, `setHeader()`, `onTerminalInput()`, `setWorkingMessage()`,
`setWorkingVisible()`, `setWorkingIndicator()`, `setHiddenThinkingLabel()`,
`pasteToEditor()`, `getEditorText()`, autocomplete factories.

These need direct terminal/`TUI` access. In the web host, `ctx.mode` should be a new
`"web"` value and extensions must guard terminal-only features
(`if (ctx.mode === "tui") ...`), exactly as RPC mode requires today. The serializable
`piweb` panel model is the web-native replacement for `custom()`.

## Wire protocol (over the existing pi-web bus)

Reuse the SSE (server→client) + POST (client→server) bus already in `server.mjs`.

**Server → browser (SSE frame):**

```json
{
    "kind": "ui_request",
    "id": "<uuid>",
    "method": "confirm",
    "title": "Dangerous!",
    "message": "Allow rm -rf?",
    "timeout": 30000
}
```

Fire-and-forget methods use the same `kind: "ui_request"` with no expectation of a reply.

**Browser → server (POST `/ui-response`):**

```json
{ "id": "<uuid>", "confirmed": true }            // confirm
{ "id": "<uuid>", "value": "chosen option" }     // select / input / editor
{ "id": "<uuid>", "cancelled": true }            // any dialog dismissed
```

## Host implementation sketch

```
pendingUI = new Map<id, { resolve, timer? }>()

function makeWebUIContext(broadcast): ExtensionUIContext {
  const dialog = (method, fields, mapResponse) => new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = fields.timeout ? setTimeout(() => settle(id, defaultFor(method)), fields.timeout) : null;
    pendingUI.set(id, { resolve, timer, mapResponse });
    broadcast({ kind: "ui_request", id, method, ...fields });
  });
  return {
    confirm: (title, message, opts) => dialog("confirm", { title, message, ...opts }, r => !!r.confirmed),
    select:  (title, options, opts) => dialog("select",  { title, options, ...opts }, r => r.cancelled ? undefined : r.value),
    input:   (title, placeholder, opts) => dialog("input", { title, placeholder, ...opts }, r => r.cancelled ? undefined : r.value),
    editor:  (title, prefill) => dialog("editor", { title, prefill }, r => r.cancelled ? undefined : r.value),
    notify:  (message, type = "info") => broadcast({ kind: "ui_request", method: "notify", message, notifyType: type }),
    setStatus: (key, text) => broadcast({ kind: "ui_request", method: "setStatus", key, text }),
    setWidget: (key, content, options) => broadcast({ kind: "ui_request", method: "setWidget", key, content, options }),
    setTitle:  (title) => broadcast({ kind: "ui_request", method: "setTitle", title }),
    setEditorText: (text) => broadcast({ kind: "ui_request", method: "setEditorText", text }),
    // TUI-only -> no-ops
    custom: async () => undefined, setFooter() {}, setHeader() {}, onTerminalInput: () => () => {},
    setWorkingMessage() {}, setWorkingVisible() {}, setWorkingIndicator() {},
    setHiddenThinkingLabel() {}, pasteToEditor() {}, getEditorText: () => "",
  };
}
```

`POST /ui-response` looks up `pendingUI.get(id)`, clears the timer, calls
`mapResponse(body)`, resolves the promise, and deletes the entry.

**Wiring it in:** pi-web must hand this `ExtensionUIContext` to the extension runner.
The runner exposes `setUIContext(uiContext, mode)` (see
`dist/core/extensions/runner.d.ts`). The open question to validate: how to inject our
context through `createAgentSession` / `DefaultResourceLoader` so `ctx.ui` resolves to
the web implementation for in-process extensions.

## Implementation order

`notify` (trivial, fire-and-forget) → `confirm` (highest value: permission gates) →
`select` / `input` → `setStatus` / `setWidget` → `editor`. `custom()` stays a no-op;
use `piweb` panels instead.
