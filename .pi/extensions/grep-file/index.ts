/**
 * grep-file — `/grep <regex>` searches the project for a regular expression and
 * shows the hits as a Zed-style read-only multibuffer: one syntax-highlighted
 * excerpt per cluster of matches, grouped by file, with the matched text marked
 * and the collapsed gaps between excerpts expandable in place.
 *
 * How it works (pure extension — no pi-web host changes):
 *   • The regex runs host-side across discovered project files (ignore-dir
 *     aware). Smart-case: a pattern with no uppercase is matched
 *     case-insensitively.
 *   • The shared `_shared/multibuffer` presentation layer highlights each file
 *     with highlight.js, marks the matches, and carves excerpts (match ±
 *     context) with expandable folds for the gaps.
 *   • The whole multibuffer is one { type:"Frame", html } custom message. The
 *     sandboxed <pi-frame> inherits the theme `--syn-*` palette and runs the
 *     frame's own JS (allow-scripts) so the "⋯ N lines" gaps and file headers
 *     expand/collapse client-side. Read-only.
 *
 * Commands:
 *   /grep <regex>   — search and show matches as an expandable multibuffer
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { piweb } from "../../../src/sdk/piweb.ts";
import {
    escapeHtml,
    type FileHits,
    highlightLines,
    type LineMatch,
    renderMultibuffer,
} from "../_shared/multibuffer.ts";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const MAX_FILES = 50; // files shown in one multibuffer
const MAX_MATCHES = 1000; // total matches before we stop scanning
const MAX_DIGEST_LINES = 200; // match lines inlined into agent-visible content
const DIGEST_LINE_CHARS = 200; // per-line text cap in the digest
const MAX_FILE_BYTES = 1024 * 1024;

/**
 * Build a compact, *agent-visible* text digest of the matches — `path` headers
 * followed by `  <lineNo>: <trimmed line text>` — and fold it into the message
 * `content`. Unlike `details` (render-only, consumed by the frame), `content`
 * is what the model actually reads, so this makes /grep results usable by the
 * agent, not just pretty for the human. Capped so it never floods context.
 */
function buildDigest(
    files: { path: string; content: string; matches: LineMatch[] }[],
    truncated: boolean,
): string {
    const out: string[] = [];
    let shown = 0;
    let clipped = false;
    outer: for (const f of files) {
        const lines = f.content.split("\n");
        out.push(f.path);
        for (const m of f.matches) {
            if (shown >= MAX_DIGEST_LINES) {
                clipped = true;
                break outer;
            }
            const text = (lines[m.line] ?? "")
                .trim()
                .slice(0, DIGEST_LINE_CHARS);
            out.push(`  ${m.line + 1}: ${text}`);
            shown++;
        }
    }
    if (clipped || truncated)
        out.push("  … results truncated — run grep directly for the full set");
    return out.join("\n");
}

/** Find all match ranges on one line (guards against zero-width loops). */
function matchLine(re: RegExp, text: string): [number, number][] {
    const ranges: [number, number][] = [];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const start = m.index;
        const end = m.index + m[0].length;
        if (end > start) ranges.push([start, end]);
        if (m[0].length === 0) re.lastIndex++; // avoid infinite loop
    }
    return ranges;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
    "coverage",
    "vendor",
    "target",
]);

async function discover(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 8 || out.length > 20000) return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith("."))
                    continue;
                await walk(resolve(dir, entry.name), depth + 1);
            } else if (entry.isFile()) {
                out.push(resolve(dir, entry.name));
            }
        }
    };
    await walk(root, 0);
    out.sort((a, b) => a.localeCompare(b));
    return out;
}

// ---------------------------------------------------------------------------
// Summary banner
// ---------------------------------------------------------------------------

function buildSummary(
    pattern: string,
    files: FileHits[],
    truncated: boolean,
): string {
    const totalMatches = files.reduce(
        (n, f) => n + f.matches.reduce((k, m) => k + m.ranges.length, 0),
        0,
    );
    return (
        `<div class="summary"><b>${totalMatches}</b> match${totalMatches === 1 ? "" : "es"} in ` +
        `<b>${files.length}</b> file${files.length === 1 ? "" : "s"} for ` +
        `<b>/${escapeHtml(pattern)}/</b>${truncated ? " (truncated)" : ""}</div>`
    );
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    const root = (pi as any)?.ctx?.cwd ?? process.cwd();
    const toDisplay = (p: string): string => {
        const rel = relative(root, p);
        return !rel || rel.startsWith("..") ? p : rel;
    };

    piweb.registerMessageRenderer("grep-result", (message: any) => {
        const d = (message.details as any) || {};
        if (!Array.isArray(d.files) || !d.files.length) {
            return {
                type: "Text",
                text: `grep: no matches for /${d.pattern}/`,
            };
        }
        // Re-highlight from stored content so replay is faithful + serializable.
        const files: FileHits[] = d.files.map((f: any) => ({
            path: f.path,
            lines: highlightLines(f.path, f.content),
            matches: f.matches,
        }));
        return {
            type: "Frame",
            html: renderMultibuffer(
                files,
                buildSummary(d.pattern, files, !!d.truncated),
            ),
        };
    });

    pi.registerCommand("grep", {
        description:
            "Regex search shown as an expandable highlighted multibuffer",
        handler: async (args?: string) => {
            const pattern = (args ?? "").trim();
            if (!pattern) {
                piweb.notify("Usage: /grep <regex>", "info");
                return;
            }
            let re: RegExp;
            try {
                // Smart-case: no uppercase in the pattern ⇒ case-insensitive.
                const flags = /[A-Z]/.test(pattern) ? "g" : "gi";
                re = new RegExp(pattern, flags);
            } catch (err: any) {
                piweb.notify(`Invalid regex: ${err?.message ?? err}`, "error");
                return;
            }
            if (!piweb.present) {
                piweb.notify("The /grep multibuffer needs the web UI.", "info");
                return;
            }

            const paths = await discover(root);
            const hits: {
                path: string;
                content: string;
                matches: LineMatch[];
            }[] = [];
            let total = 0;
            let truncated = false;

            for (const abs of paths) {
                if (hits.length >= MAX_FILES || total >= MAX_MATCHES) {
                    truncated = true;
                    break;
                }
                let content: string;
                try {
                    if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
                    content = await readFile(abs, "utf8");
                } catch {
                    continue;
                }
                if (content.includes("\u0000")) continue; // binary

                const rawLines = content.split("\n");
                const matches: LineMatch[] = [];
                for (let i = 0; i < rawLines.length; i++) {
                    const ranges = matchLine(re, rawLines[i]);
                    if (ranges.length) {
                        matches.push({ line: i, ranges });
                        total += ranges.length;
                        if (total >= MAX_MATCHES) {
                            truncated = true;
                            break;
                        }
                    }
                }
                if (matches.length)
                    hits.push({ path: toDisplay(abs), content, matches });
            }

            if (!hits.length) {
                piweb.notify(`No matches for /${pattern}/`, "warning");
                return;
            }

            const summary =
                `grep: ${total} match${total === 1 ? "" : "es"} for /${pattern}/` +
                ` in ${hits.length} file${hits.length === 1 ? "" : "s"}`;
            pi.sendMessage({
                customType: "grep-result",
                content: `${summary}\n${buildDigest(hits, truncated)}`,
                display: true,
                details: { pattern, files: hits, truncated },
            });
        },
    });
}
