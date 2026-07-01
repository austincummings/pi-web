# `piweb.setWidget` — sticky extension chrome for the web UI

Status: **implemented** (TODO #20). This document specifies the rename of the
current `dock` surface API to `setWidget`, aligning pi-web with pi's TUI
`ExtensionUIContext.setWidget` while remaining a serializable superset.

Landed: `setWidget(key, content, options)` + `removeWidget(key)` on the host
registry (`src/host/piweb-host.ts`), forwarded in `src/host/server.ts` and
stubbed as no-ops in `src/sdk/piweb.ts`. `string[]` content, the
`aboveEditor`/`belowEditor`/`left`/`right` placements, and `title`/`order`
options all work; `dock()` remains as a deprecated authoring alias. The wire
protocol and front-end (`docks.{left,right,bottom,footer}` cards) are unchanged.

---

## 1. Why

pi-web's design goal (README) is to be _"a serializable superset of pi's
`ExtensionUIContext`."_ The web UI already honors that for `notify` and
`setStatus` — they keep pi's exact TUI names, and the project's `context-bar`
extension depends on `setStatus`. But the persistent-widget primitive was named
`dock`, inventing a new term for a concept pi already calls `setWidget`.

This spec brings that primitive back in line:

- **Same name where the concept maps.** `dock` -> `setWidget`.
- **Extend via options, not new methods.** Widen `placement` instead of adding
  rails as separate calls.
- **Drop-in for plain pi extensions.** A portable extension that calls
  `setWidget(key, ["line"])` behaves correctly under the web UI and no-ops under
  a terminal with no host.

Modals stay separate: `overlay` is **not** folded into `setWidget` (pi's modal
analogue is `custom({ overlay })`, not a widget placement).

## 2. The pi TUI primitive (reference)

```ts
// pi ExtensionUIContext
type WidgetPlacement = "aboveEditor" | "belowEditor";
interface ExtensionWidgetOptions { placement?: WidgetPlacement }

setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
setWidget(key: string, content: ((tui, theme) => Component & { dispose?(): void }) | undefined, options?): void;
```

- `key` — stable id; re-calling replaces; `undefined` content removes.
- `content` — static lines **or** a live `Component` factory (interactive).
- `placement` — `aboveEditor` (default) or `belowEditor`. Two slots only.

pi-web cannot ship a live `Component`/closure over the wire, so it substitutes a
**serializable render tree + an id'd actions map** (the same trick docks/overlays
already use, and the same one proposed for `registerMessageRenderer`, TODO #19).

## 3. The pi-web API

```ts
type WidgetPlacement =
  | "aboveEditor" | "belowEditor"   // pi-compatible
  | "left" | "right";               // web-only rails (superset)

interface WidgetOptions {
  placement?: WidgetPlacement;      // default "aboveEditor"
  title?: string;                   // optional rail/card heading
  order?: number;                   // stable sort within a placement
}

type WidgetContent =
  | string[]                        // plain lines  -> Text nodes
  | WidgetDef;                      // rich, serializable

interface WidgetDef {
  render: (state: any) => Node;     // returns a serializable component tree
  actions?: Record<string, (ctx: ActionContext) => void | Promise<void>>;
  initialState?: any;
  title?: string;
  order?: number;
}

// overloads
piweb.setWidget(key: string, content: WidgetContent | undefined, options?: WidgetOptions): void;
piweb.removeWidget(key: string): void;     // alias: setWidget(key, undefined)
```

Where `Node` is the existing serializable component tree
(`Stack | Row | Text | Divider | Button | Input | Frame | ...`, plus the
proposed `Code` node from TODO #19), and `ActionContext` is the dispatch context
the host already builds (`payload`, `state`, `setState`, `pi`, `openOverlay`,
`closeOverlay`, `notify`).

### Semantics

| Call                                              | Effect                                                   |
| ------------------------------------------------- | -------------------------------------------------------- |
| `setWidget(key, content)`                         | mount/replace widget `key` at default placement          |
| `setWidget(key, content, { placement })`          | mount/replace at a specific target                       |
| `setWidget(key, undefined)` / `removeWidget(key)` | remove widget `key`                                      |
| re-`setWidget(key, ...)`                          | **replace**; state preserved unless `initialState` given |

- **Keying & replacement** match pi: same `key` replaces in place.
- **State preservation** mirrors today's `define()` behaviour — re-defining a
  widget keeps `state` unless a new `initialState` is supplied.
- **Placement aliases** map onto today's internal rails:
  `aboveEditor -> bottom`, `belowEditor -> footer`. `left`/`right` are the
  web-only rails with no TUI counterpart.

### `string[]` content (drop-in compatibility)

When `content` is a `string[]`, the host wraps it into a default `render`:

```ts
render: () => ({
    type: "Stack",
    children: lines.map((t) => ({ type: "Text", text: t })),
});
```

So a plain pi extension's `setWidget("k", ["a", "b"])` renders as two text rows,
and the same source runs unmodified in a terminal (where `__PIWEB__` is absent
and the call no-ops via the SDK shim).

## 4. Placement model

```
+-----------------------------------------------------------+
| left rail |            transcript               | right   |
|  (left)   |                                     |  rail   |
|           |                                     | (right) |
|-----------+-------------------------------------+---------|
|            aboveEditor  (bottom)  -- sticky chrome above   |
|            [   composer / prompt   ]                       |
|            belowEditor  (footer)  -- sticky chrome below   |
+-----------------------------------------------------------+
```

- `aboveEditor` / `belowEditor` are the pi-parity slots (sticky, full-width,
  around the prompt). The `context-bar`-style footer lives at `belowEditor`.
- `left` / `right` are stackable vertical rails unique to the web UI.
- Within any placement, widgets sort by `order` (then insertion order).

## 5. Host implementation notes

The change is mechanical against `src/host/piweb-host.ts`:

1. Rename the public `dock(id, def)` method to `setWidget(key, content, options)`;
   keep `dock` as a thin deprecated alias that forwards (one release).
2. Normalize args: if `content` is an array, synthesize the `render` above; if a
   `WidgetDef`, use it directly; if `undefined`, delete the surface.
3. Map `placement` -> internal `side` (`aboveEditor->bottom`,
   `belowEditor->footer`, `left`/`right` pass through). Keep accepting the old
   `side` values during the alias window.
4. `removeWidget(key)` -> existing `removeDock`/`remove`.
5. `snapshot()` and the `surfaces` SSE frame are **unchanged** — the front-end
   keeps rendering `docks.{left,right,bottom,footer}` cards via `renderNode`; only
   the authoring-side names change.
6. Update the two forwarders in `src/host/server.ts`
   (`dock`/`overlay` -> add `setWidget`/`removeWidget`) and the SDK stub in
   `src/sdk/piweb.ts` (add `setWidget`/`removeWidget` no-ops; keep `dock` alias).

No front-end or wire-protocol change is required: this is purely the extension
authoring surface.

## 6. Overlays stay separate

`overlay`/`openOverlay`/`closeOverlay` are **not** part of `setWidget`. They are
modal cards (pi's `custom({ overlay })`), not sticky chrome, and have their own
open/close lifecycle. Folding them into a `placement` would conflate two distinct
primitives. The intended long-term mapping:

| pi `ExtensionUIContext`                  | pi-web                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `setWidget(key, content, { placement })` | `setWidget(key, content, { placement, title, order })` (+ `left`/`right`) |
| `setStatus(key, text)`                   | `setStatus(key, text, { align, tone })` (already present)                 |
| `notify(msg, type)`                      | `notify(msg, type)` (already present)                                     |
| `custom({ overlay })`                    | `overlay(id, def)` + `openOverlay`/`closeOverlay`                         |

## 7. Examples

Plain pi extension (portable; works in terminal and web UI):

```ts
export default function (pi) {
    pi.ui.setWidget("hello", ["Hello from an extension"], {
        placement: "belowEditor",
    });
}
```

Rich web UI widget with state + an action:

```ts
const piweb = globalThis.__PIWEB__;
piweb?.setWidget("counter", {
    placement: "right",
    title: "Counter",
    initialState: { n: 0 },
    render: (s) => ({
        type: "Stack",
        children: [
            { type: "Text", text: `count: ${s.n}` },
            { type: "Button", label: "increment", action: "inc" },
        ],
    }),
    actions: {
        inc: (ctx) => ctx.setState((s) => ({ n: s.n + 1 })),
    },
});

// later
piweb?.removeWidget("counter");
```

## 8. Migration checklist

- [ ] `piweb-host.ts`: add `setWidget`/`removeWidget`; keep `dock`/`removeDock`
      as forwarding aliases (deprecated).
- [ ] `setWidget` arg normalization (`string[]` | `WidgetDef` | `undefined`).
- [ ] `placement` -> `side` mapping incl. `aboveEditor`/`belowEditor` aliases.
- [ ] `server.ts`: forward `setWidget`/`removeWidget` into the active registry.
- [ ] `src/sdk/piweb.ts`: add `setWidget`/`removeWidget` no-op stubs (+ alias).
- [ ] README + host docstrings: describe `setWidget` directly (drop the
      "dock = setWidget analogue" wording).
- [ ] Optional: a small example extension under `.pi/extensions/` exercising a
      `left`/`right` rail widget.
