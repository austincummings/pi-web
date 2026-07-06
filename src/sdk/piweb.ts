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

import type { FrameNode, OverlayOptions } from "../shared/frames.ts";
export type { FrameNode, RenderNode } from "../shared/frames.ts";

type NotifyLevel = "info" | "warning" | "error";
type DialogOptions = { signal?: AbortSignal; timeout?: number };
/** Working-indicator configuration (mirrors pi-tui `WorkingIndicatorOptions`). */
export interface WorkingIndicatorOptions {
    /** Animation frames. `[]` hides the indicator; custom frames render verbatim. */
    frames?: string[];
    /** Frame interval in milliseconds for animated indicators (default 80). */
    intervalMs?: number;
}

/**
 * The live data handed to a `setFooter` factory each time the footer is rebuilt
 * (turn end, model / thinking change, compaction, rename, or `refreshFooter()`).
 * Mirrors the fields pi-tui exposes to a footer Component via its
 * `ReadonlyFooterDataProvider`, in serializable form.
 */
export interface FooterData {
    /** `~`-relative working directory (already collapsed for display). */
    cwd: string;
    /** Session display name, or null when unset. */
    session: string | null;
    /** Active model id, or null. */
    model: string | null;
    /** Whether the model supports reasoning/thinking. */
    reasoning: boolean;
    /** Current thinking level (`off` when disabled). */
    level: string;
    /** Cumulative token usage for the session. */
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    /** Cumulative cost in USD. */
    cost: number;
    /** Whether the active model bills via a subscription/OAuth plan. */
    sub: boolean;
    /** Context-window usage: `percent` (null when unknown) of `window` tokens. */
    context: { percent: number | null; window: number };
    /** Whether auto-compaction is enabled. */
    autoCompact: boolean;
    /**
     * Current git branch (or `@<sha>` when detached), host-provided and updated
     * live when the branch changes — the serializable analog of pi-tui
     * `footerData.getGitBranch()`. `null` when not a repo / unknown.
     */
    gitBranch: string | null;
    /**
     * Number of models available for selection (mirrors pi-tui
     * `footerData.getAvailableProviderCount()`); useful to gate a model hint.
     */
    availableModels: number;
    /** The extension `setStatus` segments, so a footer can render them inline. */
    statuses: { key: string; text: string }[];
}
/**
 * The active theme as a flat map of CSS custom properties (e.g. `--acc`,
 * `--err`, `--dim`), the serializable analog of pi-tui's `Theme`/`theme.fg(...)`
 * passed to a footer/header Component. A factory may read these to set an
 * explicit `Text` `color`, beyond the named `tone` set.
 */
export type ThemeVars = Record<string, string>;
/**
 * A footer factory: given the current `FooterData` (and the active theme vars),
 * return a serializable node tree to render in place of the default context
 * bar, or a falsy value to fall back to the default footer. Mirrors pi-tui
 * `ctx.ui.setFooter(factory)`.
 */
export type FooterFactory = (
    data: FooterData,
    theme: ThemeVars,
) => FrameNode | null | undefined;
/**
 * A header factory (mirrors pi-tui `ctx.ui.setHeader`): return a serializable
 * node tree to render as a custom header above the transcript, or a falsy value
 * to restore the built-in header. Receives the same live data + theme vars.
 */
export type HeaderFactory = (
    data: FooterData,
    theme: ThemeVars,
) => FrameNode | null | undefined;

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
 * Wrap the current composed provider with additional behavior (mirrors pi-tui
 * `AutocompleteProviderFactory`). Return a provider that adds completions or
 * defers to `current`.
 */
export type AutocompleteProviderFactory = (
    current: AutocompleteProvider,
) => AutocompleteProvider;

export interface SurfaceDefinition {
    title?: string;
    placement?: "aboveEditor" | "belowEditor";
    order?: number;
    options?: OverlayOptions;
    initialState?: unknown;
    render?: (state: unknown) => FrameNode;
    actions?: Record<string, (ctx: unknown) => unknown>;
    [key: string]: unknown;
}

/**
 * The pi-web UI-bridge surface available to extensions. A serializable superset
 * of pi's `ExtensionUIContext`; the dialog methods mirror pi-tui's `ctx.ui.*`.
 */
export interface PiWebSurface {
    /** Host present? `false` under plain terminal pi (calls no-op). */
    present: boolean;
    /**
     * The medium being bridged. `"web"` under a pi-web host; `undefined` under
     * plain terminal pi (the no-op stub). The pi-web analog of pi-tui's
     * `ctx.mode` — portable extensions branch on `piweb.mode === "web"` (or
     * `piweb.present`) to light up web-only UI.
     */
    mode?: "web";
    // --- persistent surfaces ---
    /** Mount/replace a widget; pass `undefined` content to remove it. */
    setWidget(
        key: string,
        content: string[] | SurfaceDefinition | undefined,
        options?: {
            placement?: "aboveEditor" | "belowEditor";
            title?: string;
            order?: number;
        },
    ): void;
    /**
     * Show a custom component and resolve when it calls `done(result)`. Mirrors
     * pi-tui `ctx.ui.custom(factory, options?)`, but the factory returns a
     * *serializable* surface def (`{ render, actions?, initialState?, title? }`)
     * in place of a live `Component` and receives the theme plus the `done`
     * resolver. `options` mirror pi-tui (`{ overlay?, overlayOptions?,
     * onHandle? }`); `onHandle` receives a handle with `{ close, requestRender }`.
     */
    custom<T = any>(
        factory: (
            theme: any,
            done: (result?: T) => void,
        ) => SurfaceDefinition | null | undefined,
        options?: {
            overlay?: boolean;
            overlayOptions?: OverlayOptions | (() => OverlayOptions);
            onHandle?: (handle: {
                close: (result?: T) => void;
                requestRender: () => void;
            }) => void;
        },
    ): Promise<T | undefined>;
    // --- transient feedback ---
    notify(message: string, type?: NotifyLevel): void;
    setStatus(key: string, text?: string): void;
    /**
     * Replace the default below-composer footer (the pi-web analog of pi-tui
     * `ctx.ui.setFooter`). The factory is called with the live `FooterData`
     * whenever the footer is rebuilt and returns a serializable node tree; pass
     * `undefined` to restore the default host-built context bar. No-ops under
     * plain terminal pi.
     */
    setFooter(factory?: FooterFactory): void;
    /**
     * Ask the host to rebuild + rebroadcast the footer now (e.g. after the
     * extension recomputes git state). No-op when no footer factory is set.
     */
    refreshFooter(): void;
    /**
     * Replace the built-in header above the transcript with a serializable node
     * tree (the pi-web analog of pi-tui `ctx.ui.setHeader`). Pass `undefined` to
     * restore the default. No-ops under plain terminal pi.
     */
    setHeader(factory?: HeaderFactory): void;
    /** Rebuild + rebroadcast the custom header now. */
    refreshHeader(): void;
    setTitle(text?: string): void;
    /**
     * Set the working/loading message shown during streaming (mirrors pi-tui
     * `ui.setWorkingMessage`). Call with no argument to restore the default.
     */
    setWorkingMessage(message?: string): void;
    /**
     * Show or hide the built-in working loader row during streaming (mirrors
     * pi-tui `ui.setWorkingVisible`).
     */
    setWorkingVisible(visible: boolean): void;
    /**
     * Configure the working indicator (mirrors pi-tui `ui.setWorkingIndicator`):
     * omit to restore the default animated spinner; `frames: []` hides it.
     */
    setWorkingIndicator(options?: WorkingIndicatorOptions): void;
    /**
     * Label rendered in place of a collapsed thinking block (mirrors pi-tui
     * `ui.setHiddenThinkingLabel`). Empty/undefined restores the default.
     */
    setHiddenThinkingLabel(label?: string): void;
    // --- composer text bridge (mirrors pi-tui ui.setEditorText/…) ---
    /** Replace the composer text (mirrors pi-tui `ui.setEditorText`). */
    setEditorText(text: string): void;
    /** The current composer text (mirrors pi-tui `ui.getEditorText`). */
    getEditorText(): string;
    /**
     * Insert text at the composer caret, triggering paste handling (mirrors
     * pi-tui `ui.pasteToEditor`).
     */
    pasteToEditor(text: string): void;
    // --- tool-output expansion (mirrors pi-tui ui.getToolsExpanded/…) ---
    /** Current tool-output expansion default (mirrors pi-tui `ui.getToolsExpanded`). */
    getToolsExpanded(): boolean;
    /** Set the tool-output expansion default (mirrors pi-tui `ui.setToolsExpanded`). */
    setToolsExpanded(expanded: boolean): void;
    // --- theme API (mirrors pi-tui ui.theme/getAllThemes/getTheme/setTheme) ---
    /** The active theme as a pi-tui `Theme` shim (`theme.fg(...)`). */
    readonly theme: any;
    /** All loadable themes with names/paths (mirrors pi-tui `ui.getAllThemes`). */
    getAllThemes(): { name: string; path?: string }[];
    /** Load a theme by name without switching (mirrors pi-tui `ui.getTheme`). */
    getTheme(name: string): any | undefined;
    /**
     * Switch + persist the active theme, rebroadcasting the palette to every
     * viewer (mirrors pi-tui `ui.setTheme`). Returns `{ success }`.
     */
    setTheme(theme: string | { name?: string }): {
        success: boolean;
        error?: string;
    };
    // --- custom transcript-message renderers ---
    /**
     * Register a serializable-tree renderer for messages of `customType`.
     * Mirrors pi-tui's `pi.registerMessageRenderer` (an ExtensionAPI method):
     * the renderer receives `(message, options, theme)` to match pi-tui's
     * `MessageRenderer` shape, but returns a serializable node tree instead of
     * a live `Component`.
     */
    registerMessageRenderer(
        customType: string,
        renderer: (
            message: unknown,
            options: { expanded: boolean },
            theme?: any,
        ) => FrameNode | null | undefined,
    ): void;
    // --- composer autocomplete ---
    /**
     * Register a composer autocomplete provider (mirrors pi-tui
     * `ctx.ui.addAutocompleteProvider`). The argument is a *factory*
     * `(current) => provider` that wraps the current composed provider, so it
     * can add completions or defer to `current`. The browser queries the
     * composed provider as the user types; a provider returns items (+ optional
     * replace span) or null when it doesn't apply.
     */
    addAutocompleteProvider(factory: AutocompleteProviderFactory): void;
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
    custom: dialogNoop,
    notify: noop,
    setFooter: noop,
    refreshFooter: noop,
    setHeader: noop,
    refreshHeader: noop,
    setTitle: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setStatus: noop,
    setHiddenThinkingLabel: noop,
    setEditorText: noop,
    getEditorText: () => "",
    pasteToEditor: noop,
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false }),
    registerMessageRenderer: noop,
    hasMessageRenderer: () => false,
    renderMessage: () => null,
    addAutocompleteProvider: noop,
    hasAutocomplete: () => false,
    autocomplete: () => Promise.resolve(null),
    select: dialogNoop,
    confirm: () => Promise.resolve(false),
    input: dialogNoop,
    editor: dialogNoop,
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
