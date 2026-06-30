/**
 * piweb host registry.
 *
 * Lives in the host process alongside the agent (in-process via createAgentSession).
 * Extensions call `registerPanel` with:
 *   - render(state) -> a *serializable* component tree (no closures cross the wire)
 *   - actions: { [id]: (ctx) => void }  -> run in-process; ctx.pi is the live ExtensionAPI
 *
 * The host serializes the tree, ships it to the browser, and routes action
 * events back to the in-process handler. This generalizes pi's RPC extension-UI
 * sub-protocol (fixed method set) into an open component model.
 */
export function createPiWebHost({ broadcastPanels, getPi }) {
    const panels = new Map();

    const renderPanel = (p) => {
        try {
            return { id: p.id, title: p.title, tree: p.render(p.state) };
        } catch (err) {
            return {
                id: p.id,
                title: p.title,
                tree: { type: "Text", text: `render error: ${err.message}` },
            };
        }
    };

    const snapshot = () => [...panels.values()].map(renderPanel);
    const push = () => broadcastPanels(snapshot());

    const host = {
        present: true,

        registerPanel(id, def = {}) {
            panels.set(id, {
                id,
                title: def.title ?? id,
                render:
                    typeof def.render === "function"
                        ? def.render
                        : () => ({ type: "Text", text: id }),
                actions: def.actions ?? {},
                state: def.initialState ?? {},
            });
            push();
        },

        unregisterPanel(id) {
            if (panels.delete(id)) push();
        },

        clear() {
            panels.clear();
            push();
        },

        snapshot,

        async dispatch(panelId, action, payload) {
            const p = panels.get(panelId);
            if (!p) return;
            const handler = p.actions[action];
            if (typeof handler !== "function") return;
            const ctx = {
                payload,
                get state() {
                    return p.state;
                },
                setState(patch) {
                    const next =
                        typeof patch === "function" ? patch(p.state) : patch;
                    p.state = { ...p.state, ...next };
                    push();
                },
                pi: getPi(),
            };
            try {
                await handler(ctx);
            } catch (err) {
                console.error(
                    `[piweb] action ${panelId}.${action} failed:`,
                    err,
                );
            }
            push();
        },
    };

    return host;
}
