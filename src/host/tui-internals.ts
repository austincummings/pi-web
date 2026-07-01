/**
 * Allowlisted, guarded reads of pi-tui's soft-private component fields
 * (render-model parity §7.4). pi-tui's "private" members are *TypeScript*
 * soft-private, not ECMAScript `#private`: the compiled dist assigns plain
 * instance properties (`this.base64Data`, `this.paddingX`, `this.lines`) and
 * contains ZERO `#`-fields, so they are readable at runtime. This module is the
 * single place that touches them, for a small allowlist of stable, high-value
 * built-ins. Every read is typeof-guarded and returns null on any drift, so the
 * structural adapter degrades to the ANSI path (never mis-renders).
 *
 * Recognition uses `constructor.name` (the vendored dist is not minified, so
 * names are stable and this survives duplicate module instances) rather than
 * `instanceof`, keeping this module free of a hard pi-tui import. The companion
 * self-check test constructs real pi-tui components and fails loudly if any of
 * these fields is renamed upstream.
 */

/** Structural kinds we upgrade from a flat AnsiBlock to native/nested DOM. */
export type ComponentKind =
    "image" | "box" | "container" | "spacer" | "unknown";

function ctorName(x: unknown): string {
    return (x as any)?.constructor?.name ?? "";
}

/** Classify a live pi-tui component by its (non-minified) constructor name. */
export function componentKind(comp: unknown): ComponentKind {
    switch (ctorName(comp)) {
        case "Image":
            return "image";
        case "Box":
            return "box";
        case "Container":
            return "container";
        case "Spacer":
            return "spacer";
        default:
            return "unknown";
    }
}

export interface ImageInternals {
    base64Data: string;
    mimeType: string;
    filename?: string;
}

/** Read an `Image`'s data for an `<img>` (§7.4). Null if the shape drifted. */
export function readImage(comp: unknown): ImageInternals | null {
    const c = comp as any;
    const base64Data = c?.base64Data;
    const mimeType = c?.mimeType;
    if (
        typeof base64Data !== "string" ||
        base64Data.length === 0 ||
        typeof mimeType !== "string" ||
        mimeType.length === 0
    ) {
        return null;
    }
    const filename = c?.options?.filename;
    return {
        base64Data,
        mimeType,
        filename: typeof filename === "string" ? filename : undefined,
    };
}

export interface BoxInternals {
    paddingX: number;
    paddingY: number;
    /** True when the Box paints a background we cannot faithfully reproduce. */
    hasBg: boolean;
}

/** Read a `Box`'s padding + whether it has a bgFn. Null if the shape drifted. */
export function readBoxPadding(comp: unknown): BoxInternals | null {
    const c = comp as any;
    const paddingX = c?.paddingX;
    const paddingY = c?.paddingY;
    if (typeof paddingX !== "number" || typeof paddingY !== "number") {
        return null;
    }
    return {
        paddingX: Math.max(0, Math.floor(paddingX)),
        paddingY: Math.max(0, Math.floor(paddingY)),
        hasBg: typeof c?.bgFn === "function",
    };
}

/** Read a `Spacer`'s line count. Null if the shape drifted. */
export function readSpacerLines(comp: unknown): number | null {
    const n = (comp as any)?.lines;
    return typeof n === "number" && n >= 0 ? Math.floor(n) : null;
}

/** Read a container's public `children` array (Box/Container). Null if absent. */
export function readChildren(comp: unknown): unknown[] | null {
    const c = (comp as any)?.children;
    return Array.isArray(c) ? c : null;
}
