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
