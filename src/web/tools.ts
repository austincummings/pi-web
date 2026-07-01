// Tool-call rendering helpers for the transcript: a compact argument summary
// and line-based truncation, mirroring pi-tui's default tool-result view
// (collapsed by default, expandable with ctrl+o). Plus a small renderer
// registry so extensions can override how a given tool is displayed — the web
// counterpart to pi-tui's per-tool `renderResult`.

/** Lines of tool output shown before truncation (matches the collapsed view). */
export const MAX_TOOL_LINES = 8;

/**
 * One-line summary of a tool call's arguments for the card header. Surfaces the
 * most meaningful field for common pi tools (bash command, file path, pattern,
 * query, url); otherwise a compact, length-capped JSON.
 */
export function summarizeArgs(args: any): string {
    if (args == null || typeof args !== "object") return "";
    const pick =
        args.command ??
        args.path ??
        args.file_path ??
        args.filePath ??
        args.pattern ??
        args.query ??
        args.url ??
        args.cmd;
    if (typeof pick === "string") return pick;
    try {
        const s = JSON.stringify(args);
        return s.length > 140 ? s.slice(0, 137) + "…" : s;
    } catch {
        return "";
    }
}

/**
 * Make an absolute path cwd-relative for display (read/write/edit/ls), matching
 * how the pi TUI relativizes tool paths. Paths outside cwd are left as-is.
 */
export function relativizePath(p: string, cwd?: string): string {
    if (!cwd) return p;
    if (p === cwd) return ".";
    const base = cwd.endsWith("/") ? cwd : cwd + "/";
    return p.startsWith(base) ? p.slice(base.length) : p;
}

/** Coerce a value to a trimmed string, or "" if absent/non-string. */
function s(v: any): string {
    return typeof v === "string" ? v : "";
}

/**
 * The `:start-end` line-range suffix for a read call, mirroring pi-tui's
 * `formatReadLineRange` (offset defaults to 1; limit gives the end line).
 */
export function readLineRange(args: any): string {
    if (args?.offset === undefined && args?.limit === undefined) return "";
    const start = args.offset ?? 1;
    const end = args.limit !== undefined ? start + args.limit - 1 : "";
    return `:${start}${end ? `-${end}` : ""}`;
}

export interface TitleParts {
    /** Bold title slot (tool name, or `$` for bash). */
    name: string;
    /** Accented primary argument (command / path / pattern). */
    args: string;
    /** Muted trailing context (line range, `in <path>`, glob, limit). */
    dim: string;
}

/**
 * The header parts for a tool call, mirroring how the pi TUI titles each tool:
 * a bold name slot, an accented primary argument, and a muted trailing context.
 * bash is `$ <command>`; read appends a `:start-end` range; grep/find show the
 * pattern accented with a muted ` in <path> (flags)` suffix; other path tools
 * show the cwd-relative path. Falls back to a compact JSON summary.
 */
export function toolTitle(name: string, args: any, cwd?: string): TitleParts {
    const a = args && typeof args === "object" ? args : {};
    if (name === "bash" || name === "shell") {
        return { name: "$", args: s(a.command) || s(a.cmd), dim: "" };
    }
    if (name === "read") {
        return {
            name,
            args: relativizePath(s(a.file_path) || s(a.path), cwd),
            dim: readLineRange(a),
        };
    }
    if (name === "grep" || name === "find") {
        const path = a.path ? relativizePath(s(a.path), cwd) : ".";
        const pattern = s(a.pattern);
        let dim = ` in ${path}`;
        if (a.glob) dim += ` (${s(a.glob)})`;
        if (a.limit !== undefined) dim += ` limit ${a.limit}`;
        // grep wraps the pattern in /slashes/, find shows it bare (pi-tui).
        const shown = name === "grep" ? `/${pattern}/` : pattern;
        return { name, args: shown, dim };
    }
    const p = a.path ?? a.file_path ?? a.filePath;
    if (typeof p === "string" && p) {
        return { name, args: relativizePath(p, cwd), dim: "" };
    }
    return { name, args: summarizeArgs(args), dim: "" };
}

/**
 * Split result text into the visible portion plus the count of hidden lines.
 * When `expanded`, everything is shown. Trailing whitespace is trimmed so the
 * line count is accurate. The preview keeps the **last** `max` lines (the tail),
 * matching pi-tui, since the end of command output is usually the relevant part;
 * `hidden` counts the earlier lines elided above the preview.
 */
export function truncateResult(
    text: string,
    expanded: boolean,
    max = MAX_TOOL_LINES,
): { shown: string; hidden: number } {
    const norm = (text ?? "").replace(/\s+$/, "");
    if (expanded) return { shown: norm, hidden: 0 };
    const lines = norm.split("\n");
    if (lines.length <= max) return { shown: norm, hidden: 0 };
    return {
        shown: lines.slice(lines.length - max).join("\n"),
        hidden: lines.length - max,
    };
}

export interface ToolInfo {
    name: string;
    args: any;
    /** Result text (empty while the tool is still running). */
    result: string;
    isError: boolean;
    /** True while executing (before `tool_execution_end`). */
    pending: boolean;
    /** Whether the result view is expanded (ctrl+o / click). */
    expanded: boolean;
    /** Structured tool details (e.g. edit's `diff`); pi-tui's renderResult input. */
    details?: any;
}

/** A custom tool renderer returns a DOM node, or null to fall back to default. */
export type ToolRenderer = (info: ToolInfo) => HTMLElement | null;

const toolRenderers = new Map<string, ToolRenderer>();

/** Register a custom renderer for a tool by name (overrides the default view). */
export function registerToolRenderer(name: string, fn: ToolRenderer): void {
    toolRenderers.set(name, fn);
}

/** Look up a custom renderer for a tool, if one is registered. */
export function getToolRenderer(name: string): ToolRenderer | undefined {
    return toolRenderers.get(name);
}
