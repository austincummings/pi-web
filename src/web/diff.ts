// Diff rendering for the transcript — a faithful HTML port of pi-tui's
// `renderDiff` (modes/interactive/components/diff.js). The diff *string* itself
// is computed host-side by pi's own `generateDiffString` (edit-diff.ts) and
// shipped in the tool result's `details.diff`, so the two can't drift; this
// module only reproduces the TUI's colorization and intra-line highlighting.
//
// Line format (from generateDiffString): "<prefix><padded-lineNum> <content>"
// where prefix is "+" added / "-" removed / " " context.
//   context  -> --diff-context (dim)
//   removed  -> --diff-removed (red)
//   added    -> --diff-added   (green)
// When a change is exactly one removed + one added line, the changed tokens are
// word-diffed and wrapped in `.inverse` (the web analogue of theme.inverse()),
// with leading whitespace left un-highlighted so indentation doesn't flash.

import { diffWords } from "diff";

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Replace tabs with spaces for consistent rendering (matches pi-tui). */
function replaceTabs(text: string): string {
    return text.replace(/\t/g, "   ");
}

interface ParsedLine {
    prefix: string;
    lineNum: string;
    content: string;
}

/** Parse "+123 content" / "-123 content" / " 123 content" / "     ...". */
function parseDiffLine(line: string): ParsedLine | null {
    const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
    if (!match) return null;
    return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function span(cls: string, text: string): string {
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

/**
 * Word-level diff of a single changed line pair, returning HTML for the removed
 * and added lines with changed tokens wrapped in `.inverse`. Leading whitespace
 * on the first changed part is stripped from the highlight (matches pi-tui).
 */
function renderIntraLineDiff(
    oldContent: string,
    newContent: string,
): { removedHtml: string; addedHtml: string } {
    const wordDiff = diffWords(oldContent, newContent);
    let removedHtml = "";
    let addedHtml = "";
    let isFirstRemoved = true;
    let isFirstAdded = true;
    for (const part of wordDiff) {
        if (part.removed) {
            let value = part.value;
            if (isFirstRemoved) {
                const leadingWs = value.match(/^(\s*)/)?.[1] || "";
                value = value.slice(leadingWs.length);
                removedHtml += escapeHtml(leadingWs);
                isFirstRemoved = false;
            }
            if (value) removedHtml += span("inverse", value);
        } else if (part.added) {
            let value = part.value;
            if (isFirstAdded) {
                const leadingWs = value.match(/^(\s*)/)?.[1] || "";
                value = value.slice(leadingWs.length);
                addedHtml += escapeHtml(leadingWs);
                isFirstAdded = false;
            }
            if (value) addedHtml += span("inverse", value);
        } else {
            removedHtml += escapeHtml(part.value);
            addedHtml += escapeHtml(part.value);
        }
    }
    return { removedHtml, addedHtml };
}

/**
 * Render a pi diff string to HTML matching the TUI's `renderDiff`. Returns an
 * HTML string of one `<span>` per line (newline-separated) to drop into a
 * `<pre class="tool-body diff">`.
 */
export function renderDiffHtml(diffText: string): string {
    const lines = diffText.split("\n");
    const result: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const parsed = parseDiffLine(line);
        if (!parsed) {
            result.push(span("diff-context", line));
            i++;
            continue;
        }
        if (parsed.prefix === "-") {
            // Collect consecutive removed then consecutive added lines.
            const removedLines: ParsedLine[] = [];
            while (i < lines.length) {
                const p = parseDiffLine(lines[i]);
                if (!p || p.prefix !== "-") break;
                removedLines.push(p);
                i++;
            }
            const addedLines: ParsedLine[] = [];
            while (i < lines.length) {
                const p = parseDiffLine(lines[i]);
                if (!p || p.prefix !== "+") break;
                addedLines.push(p);
                i++;
            }
            if (removedLines.length === 1 && addedLines.length === 1) {
                const removed = removedLines[0];
                const added = addedLines[0];
                const { removedHtml, addedHtml } = renderIntraLineDiff(
                    replaceTabs(removed.content),
                    replaceTabs(added.content),
                );
                result.push(
                    `<span class="diff-removed">${escapeHtml(`-${removed.lineNum} `)}${removedHtml}</span>`,
                );
                result.push(
                    `<span class="diff-added">${escapeHtml(`+${added.lineNum} `)}${addedHtml}</span>`,
                );
            } else {
                for (const removed of removedLines)
                    result.push(
                        span(
                            "diff-removed",
                            `-${removed.lineNum} ${replaceTabs(removed.content)}`,
                        ),
                    );
                for (const added of addedLines)
                    result.push(
                        span(
                            "diff-added",
                            `+${added.lineNum} ${replaceTabs(added.content)}`,
                        ),
                    );
            }
        } else if (parsed.prefix === "+") {
            result.push(
                span(
                    "diff-added",
                    `+${parsed.lineNum} ${replaceTabs(parsed.content)}`,
                ),
            );
            i++;
        } else {
            result.push(
                span(
                    "diff-context",
                    ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`,
                ),
            );
            i++;
        }
    }
    return result.join("\n");
}
