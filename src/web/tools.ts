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
 * The header label + arg summary for a tool call, mirroring how the pi TUI
 * titles each tool. Most tools render as `<name> <primary-arg>`, but bash is
 * special-cased to `$ <command>` (no "bash" word), matching pi-tui's
 * `formatBashCall`. The returned `name` is what goes in the bold title slot.
 */
export function toolTitle(
    name: string,
    args: any,
): { name: string; args: string } {
    if (name === "bash" || name === "shell") {
        const cmd =
            args && typeof args === "object"
                ? (args.command ?? args.cmd ?? "")
                : "";
        return { name: "$", args: typeof cmd === "string" ? cmd : "" };
    }
    return { name, args: summarizeArgs(args) };
}

/**
 * Split result text into the visible portion plus the count of hidden lines.
 * When `expanded`, everything is shown. Trailing whitespace is trimmed so the
 * line count is accurate.
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
        shown: lines.slice(0, max).join("\n"),
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
