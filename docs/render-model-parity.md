# Spec: Render-Model Parity (pi Components → DOM)

Status: **Draft / proposed.** Companion to `docs/frontend-extension-runtime.md`
(the Proxy-over-RPC relay). Where the relay answers _"can an extension's API
calls and logic reach the browser,"_ this spec answers the harder half: _"can an
extension's custom **rendering** (pi TUI `Component`s) appear in pi-web's DOM
without shipping a whole terminal emulator."_

Goal in one line: **keep the DOM renderer; render pi `Component`s into it** —
natively where possible, via a small ANSI-to-DOM painter where not.

---

## 1. The constraint (source-grounded)

Read directly from the vendored `@earendil-works/pi-tui` types.

**The universal contract** (`tui.d.ts`):

```ts
interface Component {
    render(width: number): string[]; // lines of ANSI-styled text, each ≤ width
    handleInput?(data: string): void; // raw input bytes when focused
    wantsKeyRelease?: boolean;
    invalidate(): void; // drop cached render (e.g. on theme change)
}
```

**Encapsulation findings** (decisive):

| Component        | Public structural API                                              | Content/props                                         |
| ---------------- | ------------------------------------------------------------------ | ----------------------------------------------------- |
| `Box`            | **`children: Component[]`** (public), `addChild/removeChild/clear` | `paddingX/Y`, `bgFn` **private**                      |
| `Container`      | **`children: Component[]`** (public), `addChild/removeChild/clear` | —                                                     |
| `Text`           | `setText()` only                                                   | `text`, padding, `bgFn` **private** (no `getText`)    |
| `Spacer`         | `setLines()` only                                                  | `lines` **private**                                   |
| `Markdown`       | `setText()` only                                                   | source **private**                                    |
| `Image`          | `getImageId()` only                                                | `base64Data`/`mimeType` **private** (no pixel access) |
| `Input`/`Editor` | `Focusable`; input via `handleInput`                               | buffer/cursor **private**                             |
| _custom_         | none                                                               | everything private                                    |

**Consequence.** You can walk _structure_ where a container exposes `children`,
but you **cannot read a leaf's content as data** — the only way to obtain it is
`render(width)`, which returns **ANSI-styled monospace lines**. Therefore:

> The **ANSI-line → DOM renderer is the workhorse** (works for _every_ component
> via `render(width)`), and the **semantic/structural adapter is an opportunistic
> enhancement** layered on top where public APIs (container children, images)
> allow. This is the inverse of the naïve "translate the component tree" hope —
> encapsulation blocks generic prop-reading.

Two mitigating facts make this tractable:

1. pi-web runs pi **in-process** (`createAgentSession`), so extraction happens in
   the same VM as the live component objects — no serialization of live objects,
   direct method calls, correct `instanceof`.
2. A component's `render(width)` output is **not a full VT screen** — it's a
   self-contained _block of relative lines_ (TUI does differential screen
   composition itself). So the browser needs an **ANSI span painter for a block
   of lines**, _not_ a cursor-addressable terminal emulator (no scrollback, alt
   screen, or cursor motion). That is dramatically smaller than xterm.

---

## 2. Goals / non-goals

**Goals**

- Render arbitrary pi `Component`s (from `renderResult`/`renderCall`,
  `ctx.ui.custom`, custom-tool UIs) inside pi-web's existing DOM transcript.
- Native, responsive DOM for the parts we can recognize (containers, images).
- A faithful **ANSI-to-DOM** block renderer for everything else, themed via CSS
  vars — no full terminal emulator, no `<canvas>`, no xterm.
- Optional **interactivity** (focus + key relay) for interactive components.

**Non-goals**

- A cursor-addressable terminal (alt-screen apps, mouse-tracking, scrollback).
- Kitty keyboard protocol / key-release semantics (degrade; §8.5).
- Pixel-perfect terminal emulation. We target _semantic + styled monospace_,
  not a VT100.
- Reading private component state by reflection/monkey-patching.

---

## 3. Architecture

```
 host (Bun, in-process pi)                          browser (DOM)
 ┌───────────────────────────────────────┐        ┌────────────────────────────┐
 │ render hook fires:                     │        │ renderNode(tree)           │
 │   renderResult() / ui.custom(comp)     │        │   Box/Row/Text/… (native)  │
 │        │ Component (live object)       │        │   Image  → <img>           │
 │        ▼                               │  SSE   │   AnsiBlock → ansiToDom()  │
 │ component-adapter.ts                   │ ─────► │      (styled <span> lines) │
 │   walk children where public (Box/…)   │ frames │                            │
 │   leaves → render(width) → ANSI        │        │ resize/keys ──────────────►│
 │   emit serializable node tree          │ ◄───── │  POST /ui-input, /ui-resize │
 │      + AnsiBlock nodes                 │        └────────────────────────────┘
 │ theme shim: pi theme ⇄ web palette     │
 └───────────────────────────────────────┘
```

- **Extraction is host-side**, in-process. Output is pi-web's existing
  **serializable node tree** (`Box/Container/Row/Text/Divider/Markdown/…`) plus two
  **new nodes**: `AnsiBlock` and `Image`.
- Transport reuses the existing SSE + POST bus and the surface lifecycle
  (`onSurface` open/close), and — for interactive components — the relay's
  request/response correlation (`docs/frontend-extension-runtime.md` §5).
- **Browser adds one core renderer**: `ansiToDom()` for `AnsiBlock`. Everything
  else is existing `renderNode` cases plus an `<img>`.

---

## 4. Node additions

Extend the serializable vocabulary (current cases: `Box/Container`, `Row`, `Text`,
`Divider`, `Button`, `Input`, `Markdown`, `Frame`):

### 4.0 Which nodes mirror pi-tui, which are web-only

The serializable node vocabulary splits into three groups. Only the first is
expected to “match the TUI” by name; the rest are deliberate additions.

- **pi-tui-mirrored** — same name and concept as a pi-tui component: `Box`,
  `Container`, `Text`, `Spacer`, `Image`, `Markdown`. Author these 1:1 with the
  TUI.
- **Parity bridges** — nodes the host adapter emits to carry TUI output into the
  DOM: `AnsiBlock` (§4.1) and the `<img>`-lifted `Image` (§4.2, §7.4).
- **Sanctioned web-only nodes** — interactive/layout affordances the DOM has but
  the terminal does not. These have **no pi-tui equivalent** and are intentional
  divergences (like `Frame`), not names to reconcile:

    | Node      | Role                                                 | Note                                                                                                                |
    | --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
    | `Frame`   | sandboxed raw HTML/CSS/JS in a `<pi-frame>`          | the original sanctioned exception                                                                                   |
    | `Button`  | clickable action trigger (`{ label, action }`)       | dispatches a surface action via `host.dispatch`                                                                     |
    | `Input`   | text form field (`{ placeholder?, value?, action }`) | **web-only concept**; _not_ pi-tui's `Input` (a focusable editor leaf) — the name overlaps but the semantics differ |
    | `Row`     | horizontal flex container                            | pi-tui containers are vertical-only                                                                                 |
    | `Divider` | horizontal rule                                      | —                                                                                                                   |

    New web-only nodes are allowed, but each is a deliberate exception: prefer a
    pi-tui-mirrored node whenever the concept already exists there.

### 4.1 `AnsiBlock`

```jsonc
{
    "type": "AnsiBlock",
    "cols": 80, // width the lines were rendered at
    "lines": ["\u001b[7m…\u001b[27m plain \u001b[38;5;42mgreen\u001b[39m", "…"],
    "focusable": false, // true if the source component isFocusable()
    "surfaceId": "s_7", // for input/resize relay (interactive only)
}
```

- `lines` are **raw ANSI strings** exactly as `render(cols)` produced them.
- The browser never trusts them as HTML; `ansiToDom()` escapes text and emits
  only a controlled span/style set (§6).

### 4.2 `Image`

```jsonc
{ "type": "Image", "src": "data:image/png;base64,…", "alt": "…", "cols": 40 }
```

Emitted for images pi-web sources itself **and** for pi-tui `Image` components
read via the unsafe internals accessor (§7.4) — `base64Data` + `mimeType` are
plain runtime properties, so a `data:` URL is recoverable. (Original note, kept
for context on the safe-only path:) also emitted for images pi-web **sources
itself** (e.g. from a tool result's
structured details). A pi-tui `Image` **component** keeps its `base64Data`
private (only `getImageId()` is public), so its pixels are _not_ recoverable —
adapting one yields terminal image-protocol bytes that `ansiToDom()` strips, i.e.
an empty block. Images inside custom components are therefore **unsupported**
(§16) until pi exposes the data.

---

## 5. Width & reflow

Components are **width-driven**: `render(width)` reflows to `width` columns.

- The browser measures the mounting container's pixel width, computes
  `cols = floor(pxWidth / chWidth)` where `chWidth` is the monospace glyph
  advance (measured once), and reports it: `POST /ui-resize { surfaceId, cols }`.
- The host caches `cols` per surface, re-invokes `render(cols)` (and re-runs the
  adapter), and broadcasts an updated tree. Debounced (~50 ms) on resize.
- Initial render uses a sensible default (e.g. 80) until the first measurement.
- Native container nodes (`Box.children` walk) reflow via CSS; only `AnsiBlock`
  leaves need the width round-trip. So the more the adapter recognizes, the less
  reflow chatter.

---

## 6. Core mechanism: `ansiToDom()` (the workhorse)

A pure function `ansiToDom(lines: string[]): HTMLElement` producing a
`<div class="ansi">` of one `<div class="ansi-line">` per line, each containing
styled `<span>`s. **This is the only genuinely new renderer** and the "terminal
renderer for some things" — scoped to a block of lines, not a screen.

### 6.1 Supported escape subset (Appendix A is authoritative)

- **SGR** (`ESC [ … m`): reset(0), bold(1), dim(2), italic(3), underline(4),
  inverse(7), strike(9), and their resets (22/23/24/27/29); FG/BG 16-color
  (30–37/90–97, 40–47/100–107), 256-color (`38;5;n` / `48;5;n`), truecolor
  (`38;2;r;g;b` / `48;2;…`), default(39/49).
- **OSC 8 hyperlinks** (`ESC ] 8 ; params ; URI ST`): wrap the enclosed run in an
  `<a>` after **URL sanitization** (http/https/mailto only; others dropped).
- **APC `CURSOR_MARKER`**: strip from output; if `focusable`, record its column
  offset to position a DOM caret (§8.4).
- **Everything else** (other OSC/DCS/APC/CSI, cursor motion, alt-screen):
  **stripped and ignored** (we render blocks, not screens).

### 6.2 Color → theme mapping

`theme.fg(...)` has already _baked_ palette colors into the ANSI. To keep web
theme coherence, choose one (see §10):

- **(preferred) Web-palette pi theme:** run pi with a theme whose 16/256/truecolor
  values equal the web CSS-var RGBs, so mapping is identity (or a tiny table).
- **(fallback) Palette LUT:** map ANSI indices → `--syn-*`/base CSS vars in
  `ansiToDom()`.

Inverse video (`7`) swaps the resolved fg/bg (defaulting to `--txt`/`--bg`).

### 6.3 Rendering rules

- Text is HTML-escaped; only whitelisted inline styles are emitted (color,
  background-color, font-weight, font-style, text-decoration). No raw HTML.
- The block is `white-space: pre`, `font-family` monospace, so column alignment
  from `render(cols)` is preserved.
- Trailing SGR resets per line (pi appends them) are honored; state does **not**
  carry across lines (matches pi's contract).

### 6.4 Security

`ansiToDom()` is the trust boundary for untrusted extension output: escape all
text, allow only the enumerated SGR attributes, sanitize OSC 8 URLs, drop all
other control strings. Fuzz it (§14).

---

## 7. Structural enhancement (opportunistic Tier-1)

Layered on the workhorse to gain native DOM where public APIs permit. **Never
required for correctness** — always degradable to a single `AnsiBlock` for the
whole component.

### 7.1 Recognition

- Primary: `instanceof` against the pi-tui classes (`Box`, `Container`, `Image`,
  `Spacer`, `Markdown`, `Text`, `Input`, `Editor`, `SelectList`, …). Valid
  because extraction runs in-process against the same module instance.
- Defensive fallback: `component.constructor?.name` match (survives duplicate
  module instances; fragile under minification — the vendored dist is not
  minified, so acceptable, but keep both).

### 7.2 What's actually recoverable

| Source                                                             | Recognized → node                                           | Notes                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Box` / `Container`                                                | `Box` / `Container` with recursively-adapted `children`     | **both** expose public `children: Component[]`; gives nesting + per-child boundaries |
| `Spacer`                                                           | vertical gap node (height from line count via `render`)     | `lines` private → infer from `render(cols).length`                                   |
| `Image`                                                            | `Image` node (`<img>`) via **unsafe read** of fields (§7.4) | TS-private but plain runtime props; guarded + ANSI fallback on drift                 |
| `Text` / `Markdown` / `Input` / `Editor` / `SelectList` / _custom_ | **leaf** → `render(cols)` → `AnsiBlock`                     | content is private; ANSI is the only faithful source                                 |

So structure (nesting, images, spacing) is recoverable; **leaf content is not** —
it always comes through ANSI. That's the honest ceiling of "translate."

### 7.3 Benefits when it applies

- Responsive containers wrapping ANSI leaves (native fl*box around blocks).
- Real `<img>` for host-sourced images **and** pi-tui `Image` comps (via §7.4).
- Per-child DOM nodes → selection, copy, and future per-child upgrades.
- Fewer width round-trips (only leaves need `cols`).

### 7.4 Unsafe internals accessor (allowlisted, guarded)

pi-tui's "private" fields are **TypeScript soft-private**, not ECMAScript
`#private`: the compiled dist assigns plain instance properties (`this.text`,
`this.base64Data`, `this.lines`) and contains **zero** `#`-fields. They are
therefore fully readable at runtime — `(comp as any).field` / `comp["field"]` /
`Reflect.get`. This is a legitimate **Tier-1 accelerator** that upgrades several
built-ins from AnsiBlock to native DOM (notably **images**), but it trades
compile-time safety for silent upgrade breakage, so it must be **contained**:

- **One module** (`src/host/tui-internals.ts`) holds all unsafe reads behind a
  typed "internals view," for a **small allowlist** of stable, high-value
  built-ins: `Image` (`base64Data`, `mimeType`), `Text` (`text`), `Spacer`
  (`lines`), `Box` (`paddingX/Y`, `bgFn`). Nowhere else casts to `any`.
- **Startup self-check:** assert each expected field exists on its constructor's
  prototype/instance shape; on mismatch (version drift) **throw in dev** and
  **fall back to ANSI in prod** — never silently mis-render.
- **Pin** the pi-tui version; add tests that fail loudly if a field disappears.
- **Scope discipline:** never read _custom_ component internals (unknown shape)
  and don't shadow-reimplement complex components (`Editor`, `SelectList`) from
  internals — those stay on the ANSI path, which is more robust.
- **Faithfulness caveat:** a field is the _source_, not the rendered result
  (`render()` also applies `bgFn`/padding/wrap/theme). Use fields only where
  reproducing render is trivial (`Image`, `Spacer`, plain `Text`); otherwise
  prefer ANSI.
- **Long game:** request public accessors upstream (`getText()`, image data) to
  drop the fragility entirely.

---

## 8. Interactivity relay (interactive components)

Needed only for components that implement `handleInput` (selectors, dialogs,
editors). Non-interactive `renderResult` output skips all of this.

### 8.1 Focus model

- One surface holds keyboard focus at a time (the open overlay, or a focused
  inline surface). The client marks it `.focused` and forwards keys.
- Focus changes emit `POST /ui-focus { surfaceId, focused }`; the host sets
  `component.focused` (via `isFocusable`) and re-renders.

### 8.2 Key encoding (DOM → terminal bytes)

`handleInput(data)` expects **terminal byte sequences**, not DOM events. The
client encodes `KeyboardEvent`s to the same bytes pi's stdin would deliver, using
pi-tui's `keys` vocabulary (`Key`, `parseKey`, `matchesKey`) as the reference:

- Printable → the character(s).
- Enter→`\r`, Tab→`\t`, Backspace→`\x7f`, Esc→`\x1b`.
- Arrows/Home/End/PgUp/Dn/Delete → CSI sequences (`\x1b[A`, `\x1b[3~`, …).
- Ctrl-\<letter\> → control byte; Alt-\<x\> → `\x1b`-prefixed.
- (Appendix C is the authoritative table.)

Encoded bytes go `POST /ui-input { surfaceId, data }`; the host calls
`component.handleInput(data)`, then the component's `requestRender` triggers
re-extraction + rebroadcast (§9).

### 8.3 Render loop

`ctx.ui.custom` returns a handle with `requestRender()`. The host subscribes to
those requests (or polls invalidation) and, on each, re-runs the adapter for that
surface and broadcasts the new tree. Coalesce bursts (rAF/≤60 fps, §12).

### 8.4 Cursor / IME (`Focusable` + `CURSOR_MARKER`)

- If `focusable`, scan the ANSI for `CURSOR_MARKER` (zero-width APC) to find the
  caret's line/column, strip it, and place a DOM caret (a positioned element) at
  that cell. This mirrors how the TUI positions the hardware cursor.
- Full IME candidate-window positioning is **phase-gated** (§17); v1 shows a
  fake caret without native IME composition.

### 8.5 Explicitly degraded

- `wantsKeyRelease` / Kitty progressive keyboard: not delivered (browser lacks
  reliable key-release + the protocol). Components must remain usable without it.
- Mouse tracking: not forwarded in v1.

---

## 9. Lifecycle & render-hook integration

### 9.1 `ctx.ui.custom(component, opts)` / `pi.ui.custom`

- On call, the host allocates a `surfaceId`, runs the adapter, and emits a
  **render-surface open** frame (inline or `overlay` per `opts.overlay` /
  `overlayOptions`), reusing the existing overlay plumbing (`onSurface`).
- `handle.requestRender()` → re-extract + update frame. `handle.close()` /
  `done(value)` → close frame; if the call was awaited (selector returning a
  value), settle it via the relay's correlation registry (§5 of the relay spec).

### 9.2 `renderResult` / `renderCall` (tool cards)

- Today pi-web renders tool results itself. To honor a tool's custom renderer,
  the host invokes `tool.renderResult(result, options, theme, ctx)` to obtain a
  `Component`, adapts it, and ships the tree **in place of** the default card
  (client `getToolRenderer` path, `src/web/pi-tool.ts`). Same for `renderCall`.
- Requires a **theme shim** and an `options` object (expanded state, width) that
  satisfy the hook signatures (§10, §11).

### 9.3 Theme changes

On web theme change, the host calls `component.invalidate()` and re-extracts, so
colors refresh; the client also re-maps palette LUTs if used.

---

## 10. Theme bridging

Two directions must agree:

1. **Colors inside ANSI** (from `theme.fg`) — resolved to concrete palette values
   at `render()` time.
2. **CSS vars** driving the rest of pi-web.

**Recommended:** derive a **pi theme from the web theme** at session start — set
pi's palette (base 16 + any named tokens) to the exact RGBs of the web CSS vars.
Then ANSI truecolor emitted by `theme.fg` already equals the web colors, and
`ansiToDom()` maps 1:1 (truecolor → `rgb(...)`; 256/16 → a small identity LUT).
Named theme tokens (Appendix B of `tui.md`: `success`, `error`, syntax slots, …)
map to the corresponding `--syn-*` / status vars.

**Fallback:** keep pi's default theme and translate ANSI palette indices → CSS
vars in `ansiToDom()` (a fixed 16/256 LUT + truecolor passthrough). Less coherent
but zero pi-theme coupling.

---

## 11. Wire protocol

Reuse existing frames where possible; add:

**Host → browser (SSE):**

- `{ kind: "render-surface", op: "open"|"update"|"close", surfaceId, placement: "inline"|"overlay", overlay?: {...}, tree }` — `tree` is the adapted node tree (may contain `AnsiBlock`/`Image`).
- Theme refresh reuses the existing `theme` frame.

**Browser → host (POST):**

- `/ui-resize { threadId, surfaceId, cols }` — width report (§5).
- `/ui-input { threadId, surfaceId, data }` — encoded key bytes (§8.2).
- `/ui-focus { threadId, surfaceId, focused }` — focus change (§8.1).
- Awaited `custom()` results settle via the existing `/ui-response` correlation.

Under the frontend-extension-runtime relay, these are the same channels; this
spec adds the `render-surface` payload shape and the resize/input/focus verbs.

---

## 12. Performance

- **Cache** `render(cols)` per `(surfaceId, cols)`; only re-render on
  invalidation, input, or width change.
- **Coalesce** `requestRender` bursts to one broadcast per frame.
- **Line diffing:** send only changed lines on `update` (index-keyed) for large
  blocks; browser patches in place.
- **Caps:** max lines/bytes per surface (config; default e.g. 5 000 lines / 2 MB)
  → truncate with a notice. Virtualize very tall blocks (render visible slice).
- Adapter recursion depth cap to avoid pathological trees.

---

## 13. Security

- `ansiToDom()` escapes all text; emits only whitelisted inline styles; sanitizes
  OSC 8 URLs (http/https/mailto); strips all other control sequences.
- No extension-provided string is ever `innerHTML`'d.
- Image `src` limited to `data:` of allowed mime types (or host-proxied) — no
  arbitrary remote fetches from `alt`/`src`.
- Input relay forwards opaque bytes to `handleInput` in-process (same trust as
  the extension already has host-side); no new capability is granted.

---

## 14. Testing plan

- **`ansiToDom` unit tests:** each SGR attr + resets; 16/256/truecolor fg/bg;
  inverse; nested styles; OSC 8 (valid + malicious URL); `CURSOR_MARKER`
  strip+locate; unknown-escape stripping; HTML-escape of `<>&"`.
- **Adapter tests:** `Box`/`Container` structural walk → node tree; `Spacer`
  height; `Image` → `<img>` vs AnsiBlock fallback; unknown class → single
  AnsiBlock.
- **Reflow:** width change re-renders at new `cols`; alignment preserved.
- **Interactivity:** key-encoding table (Appendix C) round-trips; `handleInput`
  drives `requestRender`; focus routing; SelectList selection e2e.
- **Integration:** a `renderResult`-providing tool replaces its pi-web card;
  `ctx.ui.custom` overlay opens/updates/closes and settles an awaited value.
- **Theme:** web-palette pi theme → identity color mapping; theme change refresh.
- Keep `bun test` green; `bun run typecheck`; `bun run format`.

---

## 15. Phased plan

| Phase     | Scope                                                                                                                                   | Exit criterion                                                                                                                                                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **P0** ✅ | `AnsiBlock` node + `ansiToHtml()` (SGR/OSC8/APC subset); `componentToNode` emits a whole `Component` as one AnsiBlock at a fixed width. | **Done.** `src/web/ansi.ts`, `renderNode` `AnsiBlock` case, `src/host/component-adapter.ts`; tests in `test/ansi.test.mjs` + `test/component-adapter.test.mjs`.                                                                                                                                  |
| **P1**    | `renderResult` integration replacing **extension**-tool cards ✅ (built-ins keep native rendering); width/reflow round-trip pending.    | **Done (core):** an extension tool's `renderResult` paints its card via AnsiBlock + web-palette Theme shim. Resize reflow: follow-up.                                                                                                                                                            |
| **P2** ✅ | Structural adapter: `Box`/`Container` walk, `Spacer`, `Image` → native nodes.                                                           | **Done.** `src/host/tui-internals.ts` (guarded §7.4 reads) + `componentToNode` structural recursion; client `src/web/nodes.ts` (`Spacer`/`Image`/padded `Box`); tests in `test/tui-internals.test.mjs` + `test/component-adapter.test.mjs`. Falls back to the ANSI leaf on any field drift / bg. |
| **P3**    | Interactivity: focus, key-encoding, `/ui-input`, `requestRender` loop; `ctx.ui.custom`.                                                 | An interactive selector/dialog works end-to-end in the browser.                                                                                                                                                                                                                                  |
| **P4**    | `Focusable`/`CURSOR_MARKER` caret + IME; perf (line-diff, virtualization); theme derivation.                                            | Editors position a caret; large/animated blocks stay smooth.                                                                                                                                                                                                                                     |

Out of scope throughout: alt-screen/cursor-addressed TUIs, mouse tracking, Kitty
keyboard (§2, §8.5).

---

## 16. Compatibility ceiling

Renders faithfully: styled text, colors (theme-mapped), inverse, hyperlinks,
nested boxes, images, spacers, and interactive components driven by
`handleInput` + line-array `render`.

Degrades or unsupported: components that assume a **cursor-addressable screen**
(full-frame redraws with absolute positioning), **mouse** interaction, **Kitty
keyboard**/key-release logic. (**Images** are now supported by reading the
`Image` component's runtime fields — §7.4 — not via its protocol bytes, which strip to an
empty block). Non-image components render as static ANSI blocks (visually
correct, limited
interactivity) or a graceful "unsupported interaction" notice — never a crash.

This is the precise boundary: **anything expressible as `render(width) → styled
lines` + `handleInput(bytes)` works; anything requiring a live VT screen does
not.**

---

## 17. Open questions

1. ~~`Container.children` visibility~~ — **resolved:** public (like `Box`), so
   both container types are walkable.
2. ~~`Image` data access~~ — **resolved:** `base64Data`/`mimeType` are TS-private
   but plain runtime props, so the unsafe accessor (§7.4) recovers them for a real
   `<img>`. Caveat: version-fragile; guarded + ANSI fallback. _Follow-up: request
   a public accessor upstream to drop the unsafe read._
3. **Theme derivation** — is pi's theme API rich enough to set a full palette
   from web CSS vars at session start (preferred §10), or must we LUT?
4. **Awaited `custom()`** — settle via the relay correlation registry, or a
   dedicated `render-surface` result verb?
5. **Line-diff granularity** — worth it in P1, or defer to P4 perf?
6. **IME** — how far to go on candidate-window positioning vs. a fake caret only?
7. **Relationship to `Frame`** — once `AnsiBlock` + adapter exist, is arbitrary
   `Frame` HTML still wanted, or does the adapter cover the need?

---

## Appendix A — Supported ANSI / SGR (authoritative subset)

| Sequence                        | Effect               | DOM output                          |
| ------------------------------- | -------------------- | ----------------------------------- |
| `ESC[0m`                        | reset                | close all spans                     |
| `ESC[1m` / `22`                 | bold / normal weight | `font-weight`                       |
| `ESC[2m` / `22`                 | dim                  | reduced opacity / `--dim`           |
| `ESC[3m` / `23`                 | italic / off         | `font-style`                        |
| `ESC[4m` / `24`                 | underline / off      | `text-decoration`                   |
| `ESC[7m` / `27`                 | inverse / off        | swap fg/bg                          |
| `ESC[9m` / `29`                 | strike / off         | `text-decoration: line-through`     |
| `ESC[30–37;90–97m` / `39`       | fg 16 / default      | `color` (LUT or identity)           |
| `ESC[40–47;100–107m` / `49`     | bg 16 / default      | `background-color`                  |
| `ESC[38;5;n m` / `48;5;n`       | fg/bg 256            | LUT → CSS var / rgb                 |
| `ESC[38;2;r;g;b m` / `48;2`     | fg/bg truecolor      | `rgb(r,g,b)`                        |
| `OSC 8 ; ; URI ST … OSC 8 ;;ST` | hyperlink            | `<a href>` (sanitized)              |
| `APC CURSOR_MARKER ST`          | caret position       | strip; place DOM caret if focusable |
| any other CSI/OSC/DCS/APC       | (screen control)     | **stripped**                        |

## Appendix B — Built-in component capability matrix

| Class                         | Public API used             | Native node?          | Else             |
| ----------------------------- | --------------------------- | --------------------- | ---------------- |
| `Box`                         | `children`                  | `Box` (recurse)       | —                |
| `Container`                   | `children` (public)         | `Container` (recurse) | —                |
| `Spacer`                      | `render().length`           | gap node              | —                |
| `Image`                       | `getImageId()` only         | **none** (private)    | AnsiBlock→empty  |
| `Text` / `TruncatedText`      | `render()`                  | AnsiBlock (styled)    | —                |
| `Markdown`                    | `render()`                  | AnsiBlock             | (later: source?) |
| `Input` / `Editor`            | `render()` + `handleInput`  | AnsiBlock + input     | —                |
| `SelectList` / `SettingsList` | `render()` + `handleInput`  | AnsiBlock + input     | (later: items?)  |
| _custom_                      | `render()` (+`handleInput`) | AnsiBlock (+input)    | —                |

## Appendix C — Key encoding (DOM → bytes), excerpt

| Key               | Bytes                 | Key        | Bytes               |
| ----------------- | --------------------- | ---------- | ------------------- |
| Enter             | `\r`                  | Up         | `\x1b[A`            |
| Tab               | `\t`                  | Down       | `\x1b[B`            |
| Backspace         | `\x7f`                | Right      | `\x1b[C`            |
| Escape            | `\x1b`                | Left       | `\x1b[D`            |
| Delete            | `\x1b[3~`             | Home / End | `\x1b[H` / `\x1b[F` |
| PageUp / PageDown | `\x1b[5~` / `\x1b[6~` | Ctrl-A…Z   | `\x01`…`\x1a`       |
| Alt-\<x\>         | `\x1b` + x            | printable  | the char(s)         |

(Authoritative mapping lives in code, cross-checked against pi-tui `keys.ts`
`parseKey`/`matchesKey`.)
