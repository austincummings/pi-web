/**
 * piweb host registry — the cockpit's UI-extension surface.
 *
 * Lives in the host process alongside the agent (in-process via
 * createAgentSession). It generalizes pi's TUI `ExtensionUIContext` into a 2D,
 * serializable model. Extensions mount **surfaces**:
 *
 *   - **docks** — persistent, stackable widgets in the left / right / bottom
 *     rails (the web analogue of pi-tui's `setWidget(aboveEditor|belowEditor)`).
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
 * @typedef {object} SurfacesSnapshot
 * @property {{left:SurfaceCard[], right:SurfaceCard[], bottom:SurfaceCard[], footer:SurfaceCard[]}} docks
 * @property {SurfaceCard[]} overlays
 * @property {{key:string, text:string, align?:"right", tone?:"warning"|"error"}[]} status
 */

/**
 * @param {object} o
 * @param {(frame: any) => void} o.broadcast   send a cockpit frame to viewers
 * @param {() => any} o.getPi                   live ExtensionAPI for this thread
 */
export function createPiWebHost({ broadcast, getPi }) {
    /** @type {Map<string, Surface>} */
    const surfaces = new Map();
    /** @type {Map<string, {text:string, align?:string, tone?:string}>} keyed status segments */
    const statuses = new Map();
    let orderSeq = 0;

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
        return { docks, overlays, status };
    };

    const push = () => broadcast({ kind: "surfaces", surfaces: snapshot() });

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

        /** Mount/update a dock surface. @param {string} id @param {object} def */
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
