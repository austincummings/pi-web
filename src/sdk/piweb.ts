/**
 * @pi-web/sdk (prototype shim)
 *
 * The surface extensions import to define web UI. It resolves to the live
 * host registry that pi-web injects on `globalThis.__PIWEB__`. When no pi-web
 * host is present (e.g. the extension is loaded by plain `pi` in a terminal),
 * every call degrades to a no-op so the extension stays a valid, portable pi
 * extension.
 *
 * Layer 2 of the design: a serializable superset of pi's ExtensionUIContext.
 */
const noop = () => {};
const stub = {
    dock: noop,
    overlay: noop,
    removeDock: noop,
    removeOverlay: noop,
    remove: noop,
    openOverlay: noop,
    closeOverlay: noop,
    notify: noop,
    setStatus: noop,
    clear: noop,
    present: false,
};

export function getPiWeb() {
    return globalThis.__PIWEB__ ?? stub;
}

export const piweb = new Proxy(
    {},
    {
        get(_t, prop) {
            const host = globalThis.__PIWEB__ ?? stub;
            return host[prop];
        },
    },
);
