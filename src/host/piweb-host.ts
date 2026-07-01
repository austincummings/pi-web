/**
 * piweb host registry — the web UI's UI-extension surface.
 *
 * Lives in the host process alongside the agent (in-process via
 * createAgentSession). It generalizes pi's TUI `ExtensionUIContext` into a 2D,
 * serializable model. Extensions mount **surfaces**:
 *
 *   - **widgets** — persistent, stackable widgets in the left / right / bottom
 *     / footer rails, authored via `setWidget(key, content, { placement })`
 *     (the web analogue of pi-tui's `setWidget(aboveEditor|belowEditor)`,
 *     widened with web-only `left`/`right` rails). Internally still tracked as
 *     `dock`-kind surfaces; `dock()` remains a deprecated authoring alias.
 *   - **overlays** — declarative modal cards, opened/closed on demand
 *     (the analogue of pi-tui's `custom({ overlay })` + select/confirm/input).
 *
 * Plus transient `notify()` toasts and keyed `setStatus()` segments.
 *
 * Each surface provides `render(state) -> a *serializable* component tree` (no
 * closures cross the wire) and `actions: { [id]: (ctx) => void }` that run
 * in-process. The host serializes the tree, ships it to the browser, and routes
 * action events back to the in-process handler.
 *
 * @typedef {"left"|"right"|"bottom"|"footer"} DockSide
 *   bottom = above the prompt (pi-tui "aboveEditor"); footer = below the prompt
 *   (pi-tui "belowEditor").
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
 * @property {{left:SurfaceCard[], right:SurfaceCard[], bottom:SurfaceCard[], footer:SurfaceCard[]}} docks
 * @property {SurfaceCard[]} overlays
 * @property {{key:string, text:string, align?:"right", tone?:"warning"|"error"}[]} status
 * @property {DialogSpec[]} dialogs             open blocking dialogs (select/confirm/input/editor)
 */

/**
 * @param {object} o
 * @param {(frame: any) => void} o.broadcast   send a server message to viewers
 * @param {() => any} o.getPi                   live ExtensionAPI for this thread
 */
export function createPiWebHost({ broadcast, getPi }) {
    /** @type {Map<string, Surface>} */
    const surfaces = new Map();
    /** @type {Map<string, {text:string, align?:string, tone?:string}>} keyed status segments */
    const statuses = new Map();
    /**
     * Open blocking dialogs awaiting a browser response.
     * @type {Map<string, {kind:string, spec:DialogSpec, settle:(v:any)=>void}>}
     */
    const pendingUi = new Map();
    /**
     * Custom transcript-message renderers, keyed by `customType`. Each takes a
     * CustomMessage + options and returns a *serializable* component tree (the
     * same Stack/Row/Text/Button/Frame/Code node model as surfaces). The web
     * analogue of pi-tui's `registerMessageRenderer` (which returns a live TUI
     * `Component`).
     * @type {Map<string, (message:any, opts:any)=>any>}
     */
    const messageRenderers = new Map();
    let orderSeq = 0;
    let uiSeq = 0;
    // pi's runtime label shown in place of a collapsed thinking block
    // (pi-tui `ui.setHiddenThinkingLabel`, default "Thinking..."). Host-global
    // like the page title; broadcast so every viewer renders the same text and
    // replayed on (re)connect from getHiddenThinkingLabel().
    let hiddenThinkingLabel = "Thinking...";

    /** @param {Surface} s @returns {SurfaceCard} */
    const renderCard = (s) => {
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
                tree: { type: "Text", text: `render error: ${err.message}` },
            };
        }
    };

    /** @returns {SurfacesSnapshot} */
    const snapshot = () => {
        const docks = { left: [], right: [], bottom: [], footer: [] };
        const overlays = [];
        const ordered = [...surfaces.values()].sort(
            (a, b) => a.order - b.order,
        );
        for (const s of ordered) {
            if (s.kind === "overlay") {
                if (s.open) overlays.push(renderCard(s));
            } else {
                (docks[s.side] ?? docks.bottom).push(renderCard(s));
            }
        }
        const status = [...statuses.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, v]) => ({
                key,
                text: v.text,
                align: v.align,
                tone: v.tone,
            }));
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
    const requestUi = (kind, spec, opts: Record<string, any> = {}) => {
        const id = `ui-${++uiSeq}`;
        return new Promise((resolve) => {
            let timer = null;
            const settle = (value) => {
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
                spec: { id, dialog: kind, ...spec },
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
     * Map a widget `placement` (pi-parity + web-only rails) onto an internal
     * dock `side`. `aboveEditor`/`belowEditor` are pi's two slots; `left`/`right`
     * are the web-only rails; the raw `side` values pass through unchanged.
     * @param {"aboveEditor"|"belowEditor"|"left"|"right"|"bottom"|"footer"} [placement]
     * @returns {DockSide}
     */
    const placementToSide = (placement) => {
        switch (placement) {
            case "belowEditor":
            case "footer":
                return "footer";
            case "left":
                return "left";
            case "right":
                return "right";
            case "aboveEditor":
            case "bottom":
            default:
                return "bottom";
        }
    };

    /**
     * @param {string} id
     * @param {"dock"|"overlay"} kind
     * @param {object} def
     */
    const define = (id, kind, def: Record<string, any> = {}) => {
        const prev = surfaces.get(id);
        surfaces.set(id, {
            id,
            kind,
            side: kind === "dock" ? (def.side ?? "right") : undefined,
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
         * Mount/replace a sticky widget (pi-parity name for the legacy `dock`).
         * Mirrors pi-tui `ExtensionUIContext.setWidget`, widened with `left`/
         * `right` rails and a serializable render tree in place of a live
         * `Component`. Same `key` replaces in place; `undefined` content removes.
         *
         * @param {string} key
         * @param {string[]|object|undefined} content  plain lines, a WidgetDef, or undefined to remove
         * @param {{placement?:"aboveEditor"|"belowEditor"|"left"|"right", title?:string, order?:number}} [options]
         */
        setWidget(key, content, options: Record<string, any> = {}) {
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
        removeWidget(key) {
            if (surfaces.delete(key)) push();
        },

        /**
         * @deprecated Use `setWidget(key, content, { placement })`. Thin alias
         * kept for one release; defaults to the `right` rail like before.
         * @param {string} id @param {object} def
         */
        dock(id, def = {}) {
            define(id, "dock", def);
        },
        /** Mount/update an overlay surface (starts closed). @param {string} id @param {object} def */
        overlay(id, def = {}) {
            define(id, "overlay", def);
        },
        /** @param {string} id */
        removeDock(id) {
            if (surfaces.delete(id)) push();
        },
        /** @param {string} id */
        removeOverlay(id) {
            if (surfaces.delete(id)) push();
        },
        /** @param {string} id */
        remove(id) {
            if (surfaces.delete(id)) push();
        },

        /** @param {string} id */
        openOverlay(id) {
            const s = surfaces.get(id);
            if (s && s.kind === "overlay" && !s.open) {
                s.open = true;
                push();
            }
        },
        /** @param {string} id */
        closeOverlay(id) {
            const s = surfaces.get(id);
            if (s && s.kind === "overlay" && s.open) {
                s.open = false;
                push();
            }
        },

        /**
         * Show a selector; resolves to the chosen option (or undefined on
         * cancel). Mirrors pi-tui `ctx.ui.select(title, options, opts?)`.
         * @param {string} title
         * @param {string[]} options
         * @param {{signal?:AbortSignal, timeout?:number}} [opts]
         * @returns {Promise<string|undefined>}
         */
        select(title, options, opts) {
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
        confirm(title, message, opts) {
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
        input(title, placeholder, opts) {
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
        editor(title, prefill, opts) {
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
         * Mirrors pi-tui `pi.registerMessageRenderer`, but the renderer returns
         * a serializable node tree instead of a live `Component`. Pass a
         * non-function to unregister.
         * @param {string} customType
         * @param {(message:any, opts:{expanded:boolean})=>any} renderer
         */
        registerMessageRenderer(customType, renderer) {
            const key = String(customType);
            if (typeof renderer === "function")
                messageRenderers.set(key, renderer);
            else messageRenderers.delete(key);
        },
        /**
         * Whether a renderer is registered for `customType`.
         * @param {string} customType @returns {boolean}
         */
        hasMessageRenderer(customType) {
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
        renderMessage(customType, message, opts = {}) {
            const r = messageRenderers.get(String(customType));
            if (!r) return null;
            try {
                return r(message, { expanded: false, ...opts }) ?? null;
            } catch (err) {
                return { type: "Text", text: `render error: ${err.message}` };
            }
        },

        /**
         * Resolve an open blocking dialog with the browser's answer. Called by
         * the host when a `/ui-response` arrives. Unknown ids are ignored
         * (already settled by timeout/abort/refresh).
         * @param {string} id
         * @param {any} value
         */
        resolveUiRequest(id, value) {
            pendingUi.get(id)?.settle(value);
        },

        /**
         * Transient toast (mirrors pi-tui ui.notify).
         * @param {string} message
         * @param {"info"|"warning"|"error"} [type]
         */
        notify(message, type = "info") {
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
        setTitle(text) {
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
        setHiddenThinkingLabel(label) {
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
         * Keyed bottom-bar status segment (mirrors pi-tui ui.setStatus, with an
         * optional align/tone superset). Pass undefined/"" to clear.
         * @param {string} key
         * @param {string} [text]
         * @param {{align?:"right", tone?:"warning"|"error"}} [opts]
         */
        setStatus(key, text, opts) {
            if (text == null || text === "") statuses.delete(key);
            else
                statuses.set(key, {
                    text: String(text),
                    align: opts?.align,
                    tone: opts?.tone,
                });
            push();
        },

        clear() {
            surfaces.clear();
            statuses.clear();
            messageRenderers.clear();
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
        async dispatch(surfaceId, action, payload) {
            const s = surfaces.get(surfaceId);
            if (!s) return;
            const handler = s.actions[action];
            if (typeof handler !== "function") return;
            const ctx = {
                payload,
                get state() {
                    return s.state;
                },
                setState(patch) {
                    const next =
                        typeof patch === "function" ? patch(s.state) : patch;
                    s.state = { ...s.state, ...next };
                    push();
                },
                pi: getPi(),
                // let handlers drive overlays / toasts (e.g. a button opens a modal)
                openOverlay: (id) => host.openOverlay(id),
                closeOverlay: (id) => host.closeOverlay(id),
                notify: (m, t) => host.notify(m, t),
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
