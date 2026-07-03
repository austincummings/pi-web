import { webPaletteTheme } from "./tui-theme.ts";

/**
 * piweb host registry — the web UI's UI-extension surface.
 *
 * Lives in the host process alongside the agent (in-process via
 * createAgentSession). It generalizes pi's TUI `ExtensionUIContext` into a 2D,
 * serializable model. Extensions mount **surfaces**:
 *
 *   - **widgets** — persistent, stackable widgets in the aboveEditor /
 *     belowEditor trays, authored via `setWidget(key, content, { placement })`
 *     (pi-tui parity: the two `setWidget(aboveEditor|belowEditor)` slots).
 *     Internally tracked as `dock`-kind surfaces; `dock()` remains a
 *     deprecated authoring alias.
 *   - **overlays** — modal cards driven by `custom(factory, options?)` (the
 *     analogue of pi-tui's `ctx.ui.custom`) and by the blocking
 *     select/confirm/input/editor dialogs. The bare overlay verbs
 *     (`overlay`/`openOverlay`/…) are internal primitives behind `custom()`.
 *
 * Plus transient `notify()` toasts and keyed `setStatus()` segments.
 *
 * Each surface provides `render(state) -> a *serializable* component tree` (no
 * closures cross the wire) and `actions: { [id]: (ctx) => void }` that run
 * in-process. The host serializes the tree, ships it to the browser, and routes
 * action events back to the in-process handler.
 *
 * @typedef {"aboveEditor"|"belowEditor"} DockSide  pi-tui's two widget slots.
 *
 * @typedef {object} Surface
 * @property {string} id
 * @property {"dock"|"overlay"} kind
 * @property {DockSide} [side]                 dock rail (kind === "dock")
 * @property {string} [title]
 * @property {number} order                    stable sort within a rail/layer
 * @property {boolean} open                     overlays: currently visible?
 * @property {object} [options]                 overlay anchor/size hints
 * @property {(state:any)=>any} render
 * @property {Record<string, Function>} actions
 * @property {any} state
 *
 * @typedef {object} SurfaceCard  serialized surface sent to the browser
 * @property {string} id
 * @property {string} [title]
 * @property {any} tree
 * @property {object} [options]
 *
 * @typedef {object} DialogSpec  a pending blocking dialog sent to the browser
 * @property {string} id                        request id (echoed in the response)
 * @property {"select"|"confirm"|"input"|"editor"} dialog
 * @property {string} title
 * @property {string} [message]                  confirm
 * @property {string[]} [options]                select
 * @property {string} [placeholder]              input
 * @property {string} [prefill]                  editor
 *
 * @typedef {object} SurfacesSnapshot
 * @property {{aboveEditor:SurfaceCard[], belowEditor:SurfaceCard[]}} docks
 * @property {SurfaceCard[]} overlays
 * @property {{key:string, text:string}[]} status
 * @property {DialogSpec[]} dialogs             open blocking dialogs (select/confirm/input/editor)
 */

type DockSide = "aboveEditor" | "belowEditor";
type DialogKind = "select" | "confirm" | "input" | "editor";
type NotifyLevel = "info" | "warning" | "error";

interface Surface {
    id: string;
    kind: "dock" | "overlay";
    side?: DockSide;
    title?: string;
    order: number;
    open: boolean;
    options?: Record<string, any>;
    render: (state: any) => any;
    actions: Record<string, (ctx: any) => any>;
    state: any;
}

interface SurfaceCard {
    id: string;
    title?: string;
    tree: any;
    options?: Record<string, any>;
}

interface DialogSpec {
    id: string;
    dialog: DialogKind;
    title: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
}

type AutocompleteProvider = (ctx: {
    text: string;
    caret: number;
    cwd?: string;
}) => any;
/** Wrap the current provider with additional behavior (pi-tui parity). */
type AutocompleteProviderFactory = (
    current: AutocompleteProvider,
) => AutocompleteProvider;

/**
 * @param o.broadcast   send a server message to viewers
 * @param o.getPi       live ExtensionAPI for this thread
 */
export function createPiWebHost({
    broadcast,
    getPi,
    requestFooter,
    requestHeader,
    themeApi,
}: {
    broadcast: (frame: any) => void;
    getPi: () => any;
    /**
     * Ask the server to rebuild + rebroadcast this thread's footer frame (it
     * owns the session data the footer needs). Invoked when an extension
     * (re)sets a footer factory or calls `refreshFooter()`.
     */
    requestFooter?: () => void;
    /** Same as `requestFooter`, for the custom header (setHeader). */
    requestHeader?: () => void;
    /**
     * Bridge to the host's theme system (the web analog of pi-tui's theme API:
     * `getAllThemes`/`setTheme`). `list()` enumerates the loadable themes;
     * `set(name)` switches + persists the active theme and rebroadcasts the
     * `theme` CSS-var frame to every viewer. The server owns settings.json +
     * the themes dir, so it supplies these.
     */
    themeApi?: {
        list?: () => { name: string; path?: string }[];
        set?: (theme: string) => { success: boolean; error?: string };
    };
}) {
    const surfaces = new Map<string, Surface>();
    /** keyed status segments */
    const statuses = new Map<string, { text: string }>();
    /** extension footer factory (piweb.setFooter), or undefined for default. */
    let footerFactory: ((data: any, theme: any) => any) | undefined;
    /** extension header factory (piweb.setHeader), or undefined for default. */
    let headerFactory: ((data: any, theme: any) => any) | undefined;
    /**
     * Open blocking dialogs awaiting a browser response.
     * @type {Map<string, {kind:string, spec:DialogSpec, settle:(v:any)=>void}>}
     */
    const pendingUi = new Map<
        string,
        { kind: DialogKind; spec: DialogSpec; settle: (v: any) => void }
    >();
    /**
     * Custom transcript-message renderers, keyed by `customType`. Each takes a
     * CustomMessage + options and returns a *serializable* component tree (the
     * same Box/Row/Text/Button/Frame/Code node model as surfaces). The web
     * analogue of pi-tui's `pi.registerMessageRenderer` (which returns a live
     * TUI `Component`); the renderer receives `(message, options, theme)` to
     * match pi-tui's `MessageRenderer` shape.
     * @type {Map<string, (message:any, options:any, theme:any)=>any>}
     */
    const messageRenderers = new Map<
        string,
        (message: any, options: any, theme: any) => any
    >();
    /**
     * Extension-supplied composer autocomplete providers (the web analogue of
     * pi-tui `ctx.ui.addAutocompleteProvider`). Each registration is a *factory*
     * that wraps the current composed provider (`(current) => provider`), so a
     * provider can defer to the ones registered before it. The composed
     * provider is called with the composer `{ text, caret, cwd }` and returns
     * completion items (+ an optional replace span) or null when nothing
     * applies. It runs in-process; the browser queries it over `/autocomplete`
     * as the user types. The innermost `current` is a base that returns null.
     */
    const baseAutocomplete: AutocompleteProvider = () => null;
    let composedAutocomplete: AutocompleteProvider = baseAutocomplete;
    let autocompleteCount = 0;
    let orderSeq = 0;
    let uiSeq = 0;
    let customSeq = 0;
    // pi's runtime label shown in place of a collapsed thinking block
    // (pi-tui `ui.setHiddenThinkingLabel`, default "Thinking..."). Host-global
    // like the page title; broadcast so every viewer renders the same text and
    // replayed on (re)connect from getHiddenThinkingLabel().
    let hiddenThinkingLabel = "Thinking...";
    // Overrides for the streaming "working" indicator (pi-tui ui.setWorking*).
    // Undefined fields mean "use the client default" (braille @ 80ms, label
    // "Working…", shown while busy). Per-thread; broadcast + replayed on connect.
    const workingConfig: {
        message?: string;
        visible?: boolean;
        frames?: string[];
        intervalMs?: number;
    } = {};
    const broadcastWorking = () =>
        broadcast({ kind: "working_config", config: { ...workingConfig } });

    // Host-side shadow of the composer text (pi-tui ui.getEditorText). The
    // browser owns the real <textarea>; it echoes changes up via /editor-text
    // so a synchronous getEditorText() can return the last-known value.
    // setEditorText/pasteToEditor push the other way (broadcast an `editor`
    // frame the client applies).
    let editorText = "";
    // Programmatic tool-output expansion default (pi-tui ui.getToolsExpanded /
    // setToolsExpanded). Broadcast as a `tools_expanded` frame + replayed on
    // connect; the client applies it to existing + future tool cards.
    let toolsExpanded = false;

    const renderCard = (s: Surface): SurfaceCard => {
        try {
            return {
                id: s.id,
                title: s.title,
                tree: s.render(s.state),
                options: s.options,
            };
        } catch (err) {
            return {
                id: s.id,
                title: s.title,
                tree: {
                    type: "Text",
                    text: `render error: ${(err as any)?.message}`,
                },
            };
        }
    };

    const snapshot = () => {
        const docks: Record<DockSide, SurfaceCard[]> = {
            aboveEditor: [],
            belowEditor: [],
        };
        const overlays: SurfaceCard[] = [];
        const ordered = [...surfaces.values()].sort(
            (a, b) => a.order - b.order,
        );
        for (const s of ordered) {
            if (s.kind === "overlay") {
                if (s.open) overlays.push(renderCard(s));
            } else {
                (docks[s.side ?? "aboveEditor"] ?? docks.aboveEditor).push(
                    renderCard(s),
                );
            }
        }
        const status = [...statuses.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => ({ key, text: v.text }));
        const dialogs = [...pendingUi.values()].map((e) => e.spec);
        return { docks, overlays, status, dialogs };
    };

    const push = () => broadcast({ kind: "surfaces", surfaces: snapshot() });

    /**
     * Open a blocking dialog and return a promise that settles when the browser
     * answers (via resolveUiRequest), the optional AbortSignal fires, or the
     * optional timeout elapses. The pending dialog is part of the surfaces
     * snapshot, so it survives a browser refresh (replayed on reconnect).
     *
     * @param {"select"|"confirm"|"input"|"editor"} kind
     * @param {object} spec                    dialog-specific fields (title, options, …)
     * @param {{signal?:AbortSignal, timeout?:number}} [opts]
     * @returns {Promise<any>}
     */
    const requestUi = (
        kind: DialogKind,
        spec: Record<string, any>,
        opts: Record<string, any> = {},
    ): Promise<any> => {
        const id = `ui-${++uiSeq}`;
        return new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const settle = (value: any) => {
                if (!pendingUi.has(id)) return;
                pendingUi.delete(id);
                if (timer) clearTimeout(timer);
                opts.signal?.removeEventListener?.("abort", onAbort);
                // Normalize per dialog kind: confirm is a boolean; the rest map
                // a cancel (null/undefined) to `undefined` like pi-tui.
                let result = value;
                if (kind === "confirm") result = value === true;
                else if (value == null) result = undefined;
                resolve(result);
                push();
            };
            const onAbort = () => settle(undefined);
            pendingUi.set(id, {
                kind,
                spec: { id, dialog: kind, ...spec } as DialogSpec,
                settle,
            });
            if (opts.signal) {
                if (opts.signal.aborted)
                    queueMicrotask(() => settle(undefined));
                else
                    opts.signal.addEventListener?.("abort", onAbort, {
                        once: true,
                    });
            }
            if (opts.timeout > 0)
                timer = setTimeout(() => settle(undefined), opts.timeout);
            push();
        });
    };

    /**
     * Map a widget `placement` onto an internal dock `side`. pi-tui has exactly
     * two slots: `aboveEditor` (default) and `belowEditor`.
     * @param {"aboveEditor"|"belowEditor"} [placement]
     * @returns {DockSide}
     */
    const placementToSide = (placement?: string): DockSide =>
        placement === "belowEditor" ? "belowEditor" : "aboveEditor";

    /**
     * @param {string} id
     * @param {"dock"|"overlay"} kind
     * @param {object} def
     */
    const define = (
        id: string,
        kind: "dock" | "overlay",
        def: Record<string, any> = {},
    ) => {
        const prev = surfaces.get(id);
        surfaces.set(id, {
            id,
            kind,
            side: kind === "dock" ? (def.side ?? "aboveEditor") : undefined,
            title: def.title,
            order: def.order ?? prev?.order ?? orderSeq++,
            // overlays start hidden; re-defining preserves visibility
            open: kind === "overlay" ? (prev?.open ?? false) : true,
            options: def.options,
            render:
                typeof def.render === "function"
                    ? def.render
                    : () => ({ type: "Text", text: id }),
            actions: def.actions ?? {},
            // preserve state across re-definition unless a new initialState is given
            state:
                prev && def.initialState === undefined
                    ? prev.state
                    : (def.initialState ?? {}),
        });
        push();
    };

    const host = {
        present: true,
        /**
         * The medium this extension surface is bridging to. The pi-web analog of
         * pi-tui's `ctx.mode` (`"tui"|"rpc"|"json"|"print"`): portable
         * extensions branch on `piweb.mode === "web"` (or `piweb.present`) to
         * light up web-only UI. The no-op stub under plain terminal pi leaves
         * this `undefined`.
         */
        mode: "web" as const,

        /**
         * Mount/replace a sticky widget (pi-parity name for the legacy `dock`).
         * Mirrors pi-tui `ExtensionUIContext.setWidget`, widened with `left`/
         * `right` rails and a serializable render tree in place of a live
         * `Component`. Same `key` replaces in place; `undefined` content removes.
         *
         * @param {string} key
         * @param {string[]|object|undefined} content  plain lines, a WidgetDef, or undefined to remove
         * @param {{placement?:"aboveEditor"|"belowEditor", title?:string, order?:number}} [options]
         */
        setWidget(
            key: string,
            content: any,
            options: Record<string, any> = {},
        ) {
            if (content === undefined) {
                if (surfaces.delete(key)) push();
                return;
            }
            // string[] -> a default Box of Text rows (drop-in for plain pi).
            const def = Array.isArray(content)
                ? {
                      render: () => ({
                          type: "Box",
                          children: content.map((t) => ({
                              type: "Text",
                              text: String(t),
                          })),
                      }),
                  }
                : { ...content };
            // `options` wins, but a WidgetDef may also carry placement/title/
            // order inline (see docs/widget.md §7), so fall back to those.
            def.side = placementToSide(options.placement ?? def.placement);
            if (options.title !== undefined) def.title = options.title;
            if (options.order !== undefined) def.order = options.order;
            define(key, "dock", def);
        },
        /**
         * Remove a widget (alias for `setWidget(key, undefined)`).
         * @param {string} key
         */
        removeWidget(key: string) {
            if (surfaces.delete(key)) push();
        },

        /**
         * @deprecated Use `setWidget(key, content, { placement })`. Thin alias
         * kept for one release; defaults to the `right` rail like before.
         * @param {string} id @param {object} def
         */
        dock(id: string, def: Record<string, any> = {}) {
            define(id, "dock", def);
        },
        // --- overlay surface primitives (internal) ---------------------------
        // Not part of the public pi-tui-parity surface: extensions drive custom
        // UI via `custom()` below (pi-tui's `ctx.ui.custom`). These remain for
        // `custom()`'s own use, the `/surface` route, and action-handler ctx.
        /** Mount/update an overlay surface (starts closed). */
        overlay(id: string, def: Record<string, any> = {}) {
            define(id, "overlay", def);
        },
        removeDock(id: string) {
            if (surfaces.delete(id)) push();
        },
        removeOverlay(id: string) {
            if (surfaces.delete(id)) push();
        },
        remove(id: string) {
            if (surfaces.delete(id)) push();
        },

        openOverlay(id: string) {
            const s = surfaces.get(id);
            if (s && s.kind === "overlay" && !s.open) {
                s.open = true;
                push();
            }
        },
        closeOverlay(id: string) {
            const s = surfaces.get(id);
            if (s && s.kind === "overlay" && s.open) {
                s.open = false;
                push();
            }
        },

        /**
         * Show a custom component and resolve when it calls `done(result)`.
         * Mirrors pi-tui `ctx.ui.custom(factory, options?)`: the factory
         * receives the (web-palette) theme and a `done` resolver and returns a
         * *serializable* surface def (`{ render, actions?, initialState?,
         * title? }`) in place of a live `Component`. The component mounts
         * immediately as an overlay card. `options` mirror pi-tui
         * (`{ overlay?, overlayOptions?, onHandle? }`); `onHandle` receives a
         * handle with `{ close(result?), requestRender() }`.
         * @param {(theme:any, done:(result?:any)=>void)=>any} factory
         * @param {{overlay?:boolean, overlayOptions?:any|(()=>any), onHandle?:(h:any)=>void}} [options]
         * @returns {Promise<any>}
         */
        custom(
            factory: (theme: any, done: (result?: any) => void) => any,
            options: Record<string, any> = {},
        ) {
            const id = `custom-${++customSeq}`;
            return new Promise((resolve) => {
                let settled = false;
                const done = (result?: any) => {
                    if (settled) return;
                    settled = true;
                    if (surfaces.delete(id)) push();
                    resolve(result);
                };
                let def: any;
                try {
                    def = factory(webPaletteTheme, done);
                } catch (err) {
                    console.error("[piweb] custom() factory failed:", err);
                    resolve(undefined);
                    return;
                }
                const overlayOptions =
                    typeof options.overlayOptions === "function"
                        ? options.overlayOptions()
                        : options.overlayOptions;
                define(id, "overlay", {
                    ...(def && typeof def === "object" ? def : {}),
                    options: overlayOptions ?? def?.options,
                });
                // Unlike overlay() (which starts hidden), custom() shows the
                // component right away.
                host.openOverlay(id);
                options.onHandle?.({
                    close: (result?: any) => done(result),
                    requestRender: () => push(),
                });
            });
        },

        /**
         * Show a selector; resolves to the chosen option (or undefined on
         * cancel). Mirrors pi-tui `ctx.ui.select(title, options, opts?)`.
         * @param {string} title
         * @param {string[]} options
         * @param {{signal?:AbortSignal, timeout?:number}} [opts]
         * @returns {Promise<string|undefined>}
         */
        select(title: string, options: string[], opts?: Record<string, any>) {
            return requestUi(
                "select",
                {
                    title: String(title ?? ""),
                    options: (options ?? []).map(String),
                },
                opts,
            );
        },
        /**
         * Show a confirmation dialog; resolves to a boolean. Mirrors pi-tui
         * `ctx.ui.confirm(title, message, opts?)`.
         * @param {string} title
         * @param {string} message
         * @param {{signal?:AbortSignal, timeout?:number}} [opts]
         * @returns {Promise<boolean>}
         */
        confirm(title: string, message: string, opts?: Record<string, any>) {
            return requestUi(
                "confirm",
                { title: String(title ?? ""), message: String(message ?? "") },
                opts,
            );
        },
        /**
         * Show a single-line text input; resolves to the entered string (or
         * undefined on cancel). Mirrors pi-tui `ctx.ui.input(title, placeholder, opts?)`.
         * @param {string} title
         * @param {string} [placeholder]
         * @param {{signal?:AbortSignal, timeout?:number}} [opts]
         * @returns {Promise<string|undefined>}
         */
        input(title: string, placeholder?: string, opts?: Record<string, any>) {
            return requestUi(
                "input",
                {
                    title: String(title ?? ""),
                    placeholder: placeholder != null ? String(placeholder) : "",
                },
                opts,
            );
        },
        /**
         * Show a multi-line editor; resolves to the edited text (or undefined on
         * cancel). Mirrors pi-tui `ctx.ui.editor(title, prefill?)`.
         * @param {string} title
         * @param {string} [prefill]
         * @param {{signal?:AbortSignal, timeout?:number}} [opts]
         * @returns {Promise<string|undefined>}
         */
        editor(title: string, prefill?: string, opts?: Record<string, any>) {
            return requestUi(
                "editor",
                {
                    title: String(title ?? ""),
                    prefill: prefill != null ? String(prefill) : "",
                },
                opts,
            );
        },
        /**
         * Register a custom renderer for transcript messages of `customType`
         * (extension messages sent via `pi.sendMessage({ customType, … })`).
         * Mirrors pi-tui `pi.registerMessageRenderer` (an ExtensionAPI method,
         * not `ctx.ui`), but the renderer returns a serializable node tree
         * instead of a live `Component`. Matching pi-tui's `MessageRenderer`
         * shape, it receives `(message, options, theme)`. Pass a non-function
         * to unregister.
         * @param {string} customType
         * @param {(message:any, options:{expanded:boolean}, theme:any)=>any} renderer
         */
        registerMessageRenderer(
            customType: string,
            renderer: (message: any, options: any, theme: any) => any,
        ) {
            const key = String(customType);
            if (typeof renderer === "function")
                messageRenderers.set(key, renderer);
            else messageRenderers.delete(key);
        },
        /**
         * Whether a renderer is registered for `customType`.
         * @param {string} customType @returns {boolean}
         */
        hasMessageRenderer(customType: string) {
            return messageRenderers.has(String(customType));
        },
        /**
         * Render a custom message to a serializable tree via its registered
         * renderer, or null when none is registered. Errors are caught and
         * surfaced as a Text node so one bad renderer can't sink the transcript.
         * @param {string} customType
         * @param {any} message
         * @param {{expanded?:boolean}} [opts]
         * @returns {any|null}
         */
        renderMessage(
            customType: string,
            message: any,
            opts: Record<string, any> = {},
        ) {
            const r = messageRenderers.get(String(customType));
            if (!r) return null;
            try {
                // Third arg mirrors pi-tui's `MessageRenderer(message, options,
                // theme)`: pass the web-palette pi Theme shim so renderers can
                // resolve theme colors the same way a TUI renderer would.
                return (
                    r(message, { expanded: false, ...opts }, webPaletteTheme) ??
                    null
                );
            } catch (err) {
                return {
                    type: "Text",
                    text: `render error: ${(err as any)?.message}`,
                };
            }
        },

        /**
         * Register an extension composer autocomplete provider. Mirrors pi-tui
         * `ctx.ui.addAutocompleteProvider(factory)`: the argument is a *factory*
         * `(current) => provider` that wraps the current composed provider, so
         * it can add completions or defer to `current`. Each provider gets the
         * composer `{ text, caret, cwd }` and returns items (`string` |
         * `{value,label?,description?}`) either as a bare array (replacing the
         * token before the caret) or as `{ start, end, items }` to control the
         * spliced span; returning null means "defer / no completion here".
         * @param {(current:AutocompleteProvider)=>AutocompleteProvider} factory
         * @returns {void}
         */
        addAutocompleteProvider(factory: AutocompleteProviderFactory) {
            if (typeof factory !== "function") return;
            const wrapped = factory(composedAutocomplete);
            if (typeof wrapped !== "function") return;
            composedAutocomplete = wrapped;
            autocompleteCount++;
        },
        /** Whether any autocomplete provider is registered (client gate). */
        hasAutocomplete() {
            return autocompleteCount > 0;
        },
        /**
         * Run the composed provider against a composer snapshot and return the
         * completion, normalized to `{ start, end, items }` (or null). Called by
         * the host for the browser's `/autocomplete`.
         * @param {{text?:string, caret?:number}} ctx
         * @returns {Promise<{start:number,end:number,items:{value:string,label:string,description?:string}[]}|null>}
         */
        async autocomplete(ctx: {
            text?: string;
            caret?: number;
            cwd?: string;
        }) {
            const text = String(ctx?.text ?? "");
            const caret = Number.isInteger(ctx?.caret)
                ? Math.max(0, Math.min(ctx.caret as number, text.length))
                : text.length;
            // Default span: the whitespace-delimited token ending at the caret.
            const tokenStart =
                caret - (text.slice(0, caret).match(/\S*$/)?.[0].length ?? 0);
            // Thread the owning thread's cwd through to providers (the host
            // injects it) so filesystem-path providers resolve against the
            // correct directory rather than the server's launch dir.
            const base = { text, caret, cwd: ctx?.cwd };
            let r;
            try {
                r = await composedAutocomplete(base);
            } catch (err) {
                console.error("[piweb] autocomplete provider failed:", err);
                return null;
            }
            if (!r) return null;
            const rawItems = Array.isArray(r) ? r : r.items;
            if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
            const items = rawItems
                .map((it) =>
                    typeof it === "string"
                        ? { value: it, label: it }
                        : {
                              value: String(it.value ?? it.label ?? ""),
                              label: String(it.label ?? it.value ?? ""),
                              description:
                                  it.description != null
                                      ? String(it.description)
                                      : undefined,
                          },
                )
                .filter((it) => it.value !== "");
            if (!items.length) return null;
            const hasSpan = !Array.isArray(r);
            const start =
                hasSpan && Number.isInteger(r.start)
                    ? Math.max(0, Math.min(r.start, caret))
                    : tokenStart;
            const end =
                hasSpan && Number.isInteger(r.end)
                    ? Math.max(start, Math.min(r.end, text.length))
                    : caret;
            return { start, end, items: items.slice(0, 50) };
        },

        /**
         * Resolve an open blocking dialog with the browser's answer. Called by
         * the host when a `/ui-response` arrives. Unknown ids are ignored
         * (already settled by timeout/abort/refresh).
         * @param {string} id
         * @param {any} value
         */
        resolveUiRequest(id: string, value: any) {
            pendingUi.get(id)?.settle(value);
        },

        /**
         * Transient toast (mirrors pi-tui ui.notify).
         * @param {string} message
         * @param {"info"|"warning"|"error"} [type]
         */
        notify(message: string, type: NotifyLevel = "info") {
            broadcast({
                kind: "notify",
                message: String(message ?? ""),
                level: type,
            });
        },

        /**
         * Set the browser page (tab) title (mirrors pi-tui ui.setTitle, which
         * sets the terminal title). Pass undefined/"" to restore the default.
         * @param {string} [text]
         */
        setTitle(text?: string) {
            broadcast({
                kind: "title",
                text: text == null ? "" : String(text),
            });
        },

        /**
         * Set the label shown in place of a collapsed thinking block (mirrors
         * pi-tui ui.setHiddenThinkingLabel). Pass undefined/"" to restore pi's
         * default ("Thinking...").
         * @param {string} [label]
         */
        setHiddenThinkingLabel(label?: string) {
            hiddenThinkingLabel =
                label == null || String(label).trim() === ""
                    ? "Thinking..."
                    : String(label);
            broadcast({ kind: "thinking_label", label: hiddenThinkingLabel });
        },

        /** Current collapsed-thinking label (for connection replay). */
        getHiddenThinkingLabel() {
            return hiddenThinkingLabel;
        },

        /**
         * Set the working/loading message shown during streaming (mirrors
         * pi-tui ui.setWorkingMessage). Pass undefined/"" to restore the default
         * ("Working…").
         * @param {string} [message]
         */
        setWorkingMessage(message?: string) {
            workingConfig.message =
                message == null || String(message) === ""
                    ? undefined
                    : String(message);
            broadcastWorking();
        },
        /**
         * Show or hide the built-in working loader row during streaming
         * (mirrors pi-tui ui.setWorkingVisible). Default (no override) shows it
         * while the thread is busy.
         * @param {boolean} visible
         */
        setWorkingVisible(visible: boolean) {
            workingConfig.visible = !!visible;
            broadcastWorking();
        },
        /**
         * Configure the working indicator (mirrors pi-tui ui.setWorkingIndicator):
         * omit `options` to restore the default animated braille spinner;
         * `frames: ["●"]` for a static glyph; `frames: []` to hide the indicator
         * entirely; custom frames render verbatim at `intervalMs` (default 80).
         * @param {{frames?:string[], intervalMs?:number}} [options]
         */
        setWorkingIndicator(options?: {
            frames?: string[];
            intervalMs?: number;
        }) {
            if (!options) {
                workingConfig.frames = undefined;
                workingConfig.intervalMs = undefined;
            } else {
                workingConfig.frames = Array.isArray(options.frames)
                    ? options.frames.map((f) => String(f))
                    : undefined;
                workingConfig.intervalMs =
                    typeof options.intervalMs === "number" &&
                    options.intervalMs > 0
                        ? options.intervalMs
                        : undefined;
            }
            broadcastWorking();
        },
        /** Current working-indicator overrides (for connection replay). */
        getWorkingConfig() {
            return { ...workingConfig };
        },

        /**
         * Replace the composer text (mirrors pi-tui ui.setEditorText). Broadcasts
         * an `editor` frame the browser applies to its <textarea>; the client
         * echoes the result back so `getEditorText()` stays in sync.
         * @param {string} text
         */
        setEditorText(text: string) {
            editorText = text == null ? "" : String(text);
            broadcast({ kind: "editor", op: "set", text: editorText });
        },
        /**
         * Insert text at the composer caret, triggering the client's paste
         * handling (mirrors pi-tui ui.pasteToEditor). The client echoes the new
         * full text back to update the shadow.
         * @param {string} text
         */
        pasteToEditor(text: string) {
            broadcast({
                kind: "editor",
                op: "paste",
                text: text == null ? "" : String(text),
            });
        },
        /**
         * The current composer text (mirrors pi-tui ui.getEditorText). Returns
         * the host's shadow of the browser <textarea>, kept current by the
         * client's `/editor-text` echoes; "" before the first echo / under the
         * no-op stub.
         * @returns {string}
         */
        getEditorText() {
            return editorText;
        },
        /**
         * Update the host's editor-text shadow from the browser (called by the
         * server when a `/editor-text` echo arrives). Not part of the public
         * pi-tui-parity surface — plumbing for `getEditorText()`.
         * @param {string} text
         */
        updateEditorText(text: string) {
            editorText = text == null ? "" : String(text);
        },

        /**
         * Current tool-output expansion default (mirrors pi-tui
         * ui.getToolsExpanded).
         * @returns {boolean}
         */
        getToolsExpanded() {
            return toolsExpanded;
        },
        /**
         * Set the tool-output expansion default (mirrors pi-tui
         * ui.setToolsExpanded). Broadcasts a `tools_expanded` frame; the client
         * expands/collapses existing cards and honors it for new ones.
         * @param {boolean} expanded
         */
        setToolsExpanded(expanded: boolean) {
            toolsExpanded = !!expanded;
            broadcast({ kind: "tools_expanded", expanded: toolsExpanded });
        },

        /**
         * The active theme, as a pi-tui `Theme` shim (`theme.fg(...)` etc.).
         * Mirrors pi-tui's readonly `ctx.ui.theme`; the web-palette shim emits
         * ANSI in the web CSS-var colors (see tui-theme.ts).
         */
        get theme() {
            return webPaletteTheme;
        },
        /**
         * All loadable themes with their names/paths (mirrors pi-tui
         * ui.getAllThemes). Sourced from the host's themes dir.
         * @returns {{name:string, path?:string}[]}
         */
        getAllThemes() {
            try {
                return themeApi?.list?.() ?? [];
            } catch {
                return [];
            }
        },
        /**
         * Load a theme by name without switching to it (mirrors pi-tui
         * ui.getTheme). Returns the web-palette `Theme` shim when the name is
         * loadable, else undefined. (The shim's palette is fixed to the web
         * vars; per-theme color extraction isn't recoverable without pi
         * internals — the honest ceiling, like the render-model spec's leaves.)
         * @param {string} name
         */
        getTheme(name: string) {
            return host.getAllThemes().some((t) => t.name === name)
                ? webPaletteTheme
                : undefined;
        },
        /**
         * Switch the active theme by name (mirrors pi-tui ui.setTheme). Persists
         * it and rebroadcasts the web CSS-var palette to every viewer. Accepts a
         * name or a Theme-ish object with a `.name`. Returns `{ success }`.
         * @param {string|{name?:string}} theme
         * @returns {{success:boolean, error?:string}}
         */
        setTheme(theme: string | { name?: string }) {
            const name =
                typeof theme === "string" ? theme : (theme?.name ?? "");
            if (!name) return { success: false, error: "no theme name" };
            try {
                return (
                    themeApi?.set?.(name) ?? {
                        success: false,
                        error: "theme switching unsupported",
                    }
                );
            } catch (err) {
                return {
                    success: false,
                    error: String((err as any)?.message ?? err),
                };
            }
        },

        /**
         * Keyed footer status segment (mirrors pi-tui ui.setStatus). Pass
         * undefined/"" to clear.
         * @param {string} key
         * @param {string} [text]
         */
        setStatus(key: string, text?: string) {
            if (text == null || text === "") statuses.delete(key);
            else statuses.set(key, { text: String(text) });
            push();
            // Status segments can be rendered inline by a custom footer, so a
            // footer factory sees the change too.
            if (footerFactory) requestFooter?.();
        },

        /**
         * Extension footer segments, sorted by key (mirrors the status snapshot)
         * so a custom footer can render them inline (pi-tui parity: the footer
         * shows `setStatus` segments). Consumed host-side by `footerFrame`.
         */
        getStatuses() {
            return [...statuses.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, v]) => ({ key, text: v.text }));
        },

        /**
         * Replace the default context bar with a serializable node tree (mirrors
         * pi-tui `ui.setFooter`). Pass undefined to restore the default. The
         * factory is stored and invoked host-side by `footerFrame` with fresh
         * `FooterData` each time the footer is rebuilt.
         * @param {(data:any)=>any} [factory]
         */
        setFooter(factory?: (data: any) => any) {
            footerFactory = typeof factory === "function" ? factory : undefined;
            requestFooter?.();
        },

        /** Rebuild + rebroadcast the footer now (e.g. after recomputing git). */
        refreshFooter() {
            requestFooter?.();
        },

        /** The current footer factory, or undefined. Consumed by `footerFrame`. */
        getFooterFactory() {
            return footerFactory;
        },

        /**
         * Replace the built-in header with a serializable node tree (mirrors
         * pi-tui `ui.setHeader`). Pass undefined to restore the default.
         * @param {(data:any,theme:any)=>any} [factory]
         */
        setHeader(factory?: (data: any, theme: any) => any) {
            headerFactory = typeof factory === "function" ? factory : undefined;
            requestHeader?.();
        },

        /** Rebuild + rebroadcast the custom header now. */
        refreshHeader() {
            requestHeader?.();
        },

        /** The current header factory, or undefined. Consumed by `headerFrame`. */
        getHeaderFactory() {
            return headerFactory;
        },

        clear() {
            surfaces.clear();
            statuses.clear();
            const hadFooter = !!footerFactory;
            const hadHeader = !!headerFactory;
            footerFactory = undefined;
            headerFactory = undefined;
            if (hadFooter) requestFooter?.();
            if (hadHeader) requestHeader?.();
            messageRenderers.clear();
            composedAutocomplete = baseAutocomplete;
            autocompleteCount = 0;
            workingConfig.message = undefined;
            workingConfig.visible = undefined;
            workingConfig.frames = undefined;
            workingConfig.intervalMs = undefined;
            broadcastWorking();
            // reset the programmatic tool-expansion default (extensions re-set
            // it on reload); the editor-text shadow is user state, left as-is.
            if (toolsExpanded) {
                toolsExpanded = false;
                broadcast({ kind: "tools_expanded", expanded: false });
            }
            // cancel any open dialogs so awaiting extensions unblock
            for (const e of [...pendingUi.values()]) e.settle(undefined);
            push();
        },

        snapshot,

        /**
         * Run a surface action in-process and re-broadcast.
         * @param {string} surfaceId
         * @param {string} action
         * @param {any} payload
         */
        async dispatch(surfaceId: string, action: string, payload?: any) {
            const s = surfaces.get(surfaceId);
            if (!s) return;
            const handler = s.actions[action];
            if (typeof handler !== "function") return;
            const ctx = {
                payload,
                get state() {
                    return s.state;
                },
                setState(patch: any) {
                    const next =
                        typeof patch === "function" ? patch(s.state) : patch;
                    s.state = { ...s.state, ...next };
                    push();
                },
                pi: getPi(),
                // let handlers drive overlays / toasts (e.g. a button opens a modal)
                openOverlay: (id: string) => host.openOverlay(id),
                closeOverlay: (id: string) => host.closeOverlay(id),
                notify: (m: string, t?: NotifyLevel) => host.notify(m, t),
            };
            try {
                await handler(ctx);
            } catch (err) {
                console.error(
                    `[piweb] action ${surfaceId}.${action} failed:`,
                    err,
                );
            }
            push();
        },
    };

    return host;
}
