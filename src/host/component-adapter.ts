/**
 * Host-side pi `Component` → serializable node adapter (render-model parity,
 * docs/render-model-parity.md). pi runs in-process, so this walks the *live*
 * component objects and emits pi-web's serializable node tree for the browser.
 *
 * Parity P0: the whole component is emitted as a single `AnsiBlock` — we call
 * its `render(cols)` (the one universal contract) and ship the ANSI lines, which
 * the client paints via `ansiToHtml` (src/web/ansi.ts). Structural recognition
 * (Box/Container/Image → native nodes) and interactivity are later phases
 * (§7/§8); this module is the foundation they build on.
 */

/** The minimal pi-tui Component contract we depend on (tui.d.ts). */
export interface TuiComponent {
    render(width: number): string[];
    handleInput?(data: string): void;
    wantsKeyRelease?: boolean;
    invalidate?(): void;
}

/** A serializable AnsiBlock node (client renders it via the `AnsiBlock` case). */
export interface AnsiBlockNode {
    type: "AnsiBlock";
    cols: number;
    lines: string[];
    focusable?: boolean;
}

/** Duck-type check: anything exposing `render(width) => string[]`. */
export function isComponent(x: unknown): x is TuiComponent {
    return !!x && typeof (x as any).render === "function";
}

/**
 * Adapt a pi `Component` to a serializable node. P0 always yields a single
 * `AnsiBlock`; `render(cols)` failures degrade to a one-line error block rather
 * than throwing into the transcript pipeline.
 *
 * @param component a pi-tui Component (live, in-process)
 * @param cols      column width to render at (default 80 until measured)
 */
export function componentToNode(
    component: TuiComponent,
    cols = 80,
): AnsiBlockNode {
    let lines: string[] = [];
    try {
        const out = component.render(Math.max(1, Math.floor(cols)));
        if (Array.isArray(out)) lines = out.map((l) => String(l ?? ""));
    } catch (err: any) {
        lines = [`\u27e8render error: ${err?.message ?? String(err)}\u27e9`];
    }
    const node: AnsiBlockNode = { type: "AnsiBlock", cols, lines };
    if (
        typeof (component as any).focused === "boolean" ||
        typeof component.handleInput === "function"
    ) {
        node.focusable = true;
    }
    return node;
}

// ---------------------------------------------------------------------------
// Parity P1: invoke a tool's custom renderResult/renderCall host-side and adapt
// the returned Component. Mirrors pi's own reference implementation
// (core/export-html/tool-renderer.ts `createToolHtmlRenderer`): build a
// ToolRenderContext, call the hook, then `component.render(cols)` via
// componentToNode. Signatures verified against core/extensions/types.d.ts:
//   renderCall(args, theme, ctx) => Component
//   renderResult({content,details,isError}, {expanded,isPartial}, theme, ctx) => Component
// ---------------------------------------------------------------------------

/** A tool definition exposing the optional TUI render hooks. */
export interface ToolRenderers {
    renderCall?: (args: any, theme: any, ctx: any) => TuiComponent;
    renderResult?: (
        result: any,
        options: any,
        theme: any,
        ctx: any,
    ) => TuiComponent;
    renderShell?: "default" | "self";
}

/** Inputs for invoking a tool renderer (a subset of pi's ToolRenderContext). */
export interface ToolRenderParams {
    toolName: string;
    toolCallId: string;
    args: any;
    cwd: string;
    expanded?: boolean;
    isPartial?: boolean;
    isError?: boolean;
    /** Result-only: the tool result content blocks + structured details. */
    content?: any[];
    details?: any;
    /** Per-tool renderer state + previous component (pi keeps these across renders). */
    state?: any;
    lastComponent?: TuiComponent;
}

/**
 * Build the ToolRenderContext object pi's render hooks expect. `invalidate` is a
 * no-op here (the live re-render loop is Parity P3); `showImages` is false (P0
 * paints images as ANSI fallback until the structural adapter lands).
 */
function makeRenderContext(p: ToolRenderParams): any {
    return {
        args: p.args,
        toolCallId: p.toolCallId,
        invalidate: () => {},
        lastComponent: p.lastComponent,
        state: p.state ?? {},
        cwd: p.cwd,
        executionStarted: true,
        argsComplete: true,
        isPartial: !!p.isPartial,
        expanded: !!p.expanded,
        showImages: false,
        isError: !!p.isError,
    };
}

/**
 * Invoke a tool's `renderCall` and adapt the Component to a node. Returns null
 * if the tool has no `renderCall` or the hook throws (caller falls back to the
 * default pi-web card).
 */
export function renderToolCallToNode(
    def: ToolRenderers | undefined | null,
    p: ToolRenderParams,
    theme: any,
    cols = 80,
): AnsiBlockNode | null {
    const fn = def?.renderCall;
    if (typeof fn !== "function") return null;
    try {
        const comp = fn(p.args, theme, makeRenderContext(p));
        if (!isComponent(comp)) return null;
        return componentToNode(comp, cols);
    } catch {
        return null;
    }
}

/**
 * Invoke a tool's `renderResult` and adapt the Component to a node. Returns null
 * if the tool has no `renderResult` or the hook throws.
 */
export function renderToolResultToNode(
    def: ToolRenderers | undefined | null,
    p: ToolRenderParams,
    theme: any,
    cols = 80,
): AnsiBlockNode | null {
    const fn = def?.renderResult;
    if (typeof fn !== "function") return null;
    try {
        const result = {
            content: p.content ?? [],
            details: p.details,
            isError: !!p.isError,
        };
        const options = { expanded: !!p.expanded, isPartial: !!p.isPartial };
        const comp = fn(result, options, theme, makeRenderContext(p));
        if (!isComponent(comp)) return null;
        return componentToNode(comp, cols);
    } catch {
        return null;
    }
}
