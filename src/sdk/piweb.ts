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

type NotifyLevel = "info" | "warning" | "error";
type DialogOptions = { signal?: AbortSignal; timeout?: number };

/** The composer snapshot passed to an autocomplete provider. */
export interface AutocompleteContext {
    /** Full composer text. */
    text: string;
    /** Caret offset within `text`. */
    caret: number;
    /**
     * The working directory of the thread the composer belongs to. Supplied by
     * the pi-web host (it owns each thread's cwd); undefined under plain
     * terminal pi. Providers that resolve filesystem paths should prefer this
     * over `process.cwd()`, which under pi-web is the *server's* launch dir.
     */
    cwd?: string;
}
/** A single completion candidate. */
export interface AutocompleteItem {
    /** Text spliced into the composer when accepted. */
    value: string;
    /** Label shown in the dropdown (defaults to `value`). */
    label?: string;
    /** Muted secondary text shown alongside the label. */
    description?: string;
}
/**
 * A provider's result: items plus an optional `[start, end)` replace span
 * (defaults to the whitespace-delimited token ending at the caret).
 */
export interface AutocompleteResult {
    start?: number;
    end?: number;
    items: (AutocompleteItem | string)[];
}
export type AutocompleteProvider = (
    ctx: AutocompleteContext,
) =>
    | AutocompleteResult
    | (AutocompleteItem | string)[]
    | null
    | undefined
    | Promise<
          AutocompleteResult | (AutocompleteItem | string)[] | null | undefined
      >;

/**
 * The pi-web UI-bridge surface available to extensions. A serializable superset
 * of pi's `ExtensionUIContext`; the dialog methods mirror pi-tui's `ctx.ui.*`.
 */
export interface PiWebSurface {
    /** Host present? `false` under plain terminal pi (calls no-op). */
    present: boolean;
    // --- persistent surfaces ---
    setWidget(
        key: string,
        content: string[] | Record<string, any> | undefined,
        options?: Record<string, any>,
    ): void;
    removeWidget(key: string): void;
    overlay(id: string, def?: Record<string, any>): void;
    openOverlay(id: string): void;
    closeOverlay(id: string): void;
    removeOverlay(id: string): void;
    remove(id: string): void;
    // --- transient feedback ---
    notify(message: string, type?: NotifyLevel): void;
    setStatus(
        key: string,
        text?: string,
        opts?: { align?: "right"; tone?: "warning" | "error" },
    ): void;
    setTitle(text?: string): void;
    /**
     * Label rendered in place of a collapsed thinking block (mirrors pi-tui
     * `ui.setHiddenThinkingLabel`). Empty/undefined restores the default.
     */
    setHiddenThinkingLabel(label?: string): void;
    // --- custom transcript-message renderers ---
    /** Register a serializable-tree renderer for messages of `customType`. */
    registerMessageRenderer(
        customType: string,
        renderer: (message: any, opts: { expanded: boolean }) => any,
    ): void;
    // --- composer autocomplete ---
    /**
     * Register a composer autocomplete provider (mirrors pi-tui
     * `ctx.ui.addAutocompleteProvider`). The browser queries registered
     * providers as the user types; return items (+ optional replace span) or
     * null when the provider doesn't apply. Returns a disposer.
     */
    addAutocompleteProvider(provider: AutocompleteProvider): () => void;
    // --- blocking dialogs (await the browser's answer) ---
    select(
        title: string,
        options: string[],
        opts?: DialogOptions,
    ): Promise<string | undefined>;
    confirm(
        title: string,
        message: string,
        opts?: DialogOptions,
    ): Promise<boolean>;
    input(
        title: string,
        placeholder?: string,
        opts?: DialogOptions,
    ): Promise<string | undefined>;
    editor(
        title: string,
        prefill?: string,
        opts?: DialogOptions,
    ): Promise<string | undefined>;
    clear(): void;
    /** Deprecated alias for setWidget. */
    dock(id: string, def?: Record<string, any>): void;
    [key: string]: any;
}

declare global {
    // eslint-disable-next-line no-var
    var __PIWEB__: PiWebSurface | undefined;
}

const noop = () => {};
// Blocking dialogs degrade to an immediate cancel under plain pi (no host):
// select/input/editor resolve to undefined, confirm to false — same as a
// dismissed dialog, so portable extensions stay valid.
const dialogNoop = () => Promise.resolve(undefined);
const stub = {
    setWidget: noop,
    removeWidget: noop,
    dock: noop,
    overlay: noop,
    removeDock: noop,
    removeOverlay: noop,
    remove: noop,
    openOverlay: noop,
    closeOverlay: noop,
    notify: noop,
    setTitle: noop,
    setStatus: noop,
    setHiddenThinkingLabel: noop,
    registerMessageRenderer: noop,
    hasMessageRenderer: () => false,
    renderMessage: () => null,
    addAutocompleteProvider: () => noop,
    hasAutocomplete: () => false,
    autocomplete: () => Promise.resolve(null),
    select: dialogNoop,
    confirm: () => Promise.resolve(false),
    input: dialogNoop,
    editor: dialogNoop,
    clear: noop,
    present: false,
};

export function getPiWeb() {
    return globalThis.__PIWEB__ ?? stub;
}

export const piweb: PiWebSurface = new Proxy(
    {},
    {
        get(_t, prop: string | symbol) {
            const host = globalThis.__PIWEB__ ?? stub;
            return (host as Record<string | symbol, any>)[prop];
        },
    },
) as PiWebSurface;
