import type { ToolInfo } from "./tools.ts";

/** Lines of read output shown for collapsed errors (matches pi-tui read). */
export const READ_PREVIEW_LINES = 10;

export interface ReadResultParts {
    shown: string;
    remaining: number;
}

function trimTrailingEmptyLines(lines: string[]): string[] {
    let end = lines.length;
    while (end > 0 && lines[end - 1] === "") end--;
    return lines.slice(0, end);
}

/**
 * pi-tui's read renderer hides successful collapsed output entirely; expanded
 * reads show from the top, while collapsed errors show the first 10 lines.
 */
export function readResultParts(
    info: Pick<ToolInfo, "result" | "expanded" | "isError">,
): ReadResultParts | null {
    if (!info.expanded && !info.isError) return null;

    const lines = trimTrailingEmptyLines(
        info.result.replace(/\r/g, "").split("\n"),
    );
    const max = info.expanded ? lines.length : READ_PREVIEW_LINES;
    const shownLines = lines.slice(0, max);

    return {
        shown: shownLines.join("\n"),
        remaining: Math.max(0, lines.length - max),
    };
}

export function readMoreLabel(remaining: number): string {
    return `... (${remaining} more lines, alt+o to expand)`;
}
