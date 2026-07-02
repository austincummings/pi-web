/**
 * semgrep — `/semgrep <natural language search>` dispatches a scoped, read-only
 * *subagent* that hunts down the relevant code, then presents the locations it
 * found as the same Zed-style multibuffer that `/grep` uses.
 *
 * Why a subagent?  `/grep` is a literal regex; `/semgrep` is a *semantic* search
 * ("where do we decide a file is binary?", "the retry/backoff logic", …). The
 * pi SDK exposes `createAgentSession()`, so an extension can spin up a fully
 * independent agent — its own model, cwd, tool set and SessionManager — drive it
 * to completion, harvest its answer, and dispose it. None of the subagent's
 * search churn lands in the user's thread; only the curated result message does.
 *
 * How it works (pure extension — no pi-web host changes):
 *   • On `/semgrep <query>` we `createAgentSession({ tools:["grep","find","read",
 *     "ls"] })` — a read-only agent that can search but never mutate.
 *   • We prompt it to locate the relevant code and to end its answer with a
 *     `LOCATIONS:` block of `path:line` entries. `await session.prompt()` runs
 *     the whole tool loop to completion.
 *   • We parse those locations, read the files host-side, and hand them to the
 *     shared `_shared/multibuffer` renderer — identical presentation to `/grep`,
 *     with the reported lines marked and their surroundings expandable.
 *   • The subagent is always `dispose()`d in a `finally`.
 *
 * Commands:
 *   /semgrep <natural language>   — semantic code search via a subagent
 */
import {
    createAgentSession,
    type ExtensionAPI,
    type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { piweb } from "../../../src/sdk/piweb.ts";
import {
    escapeHtml,
    type FileHits,
    highlightLines,
    type LineMatch,
    renderMultibuffer,
    warm,
} from "../_shared/multibuffer.ts";

const MAX_FILES = 30; // files shown in one multibuffer
const MAX_LOCATIONS = 200; // parsed locations cap
const STATUS_KEY = "semgrep";

// ---------------------------------------------------------------------------
// Subagent orchestration
// ---------------------------------------------------------------------------

/** The instruction we hand the subagent. Ends with a strict, parseable block. */
function buildPrompt(query: string): string {
    return [
        `You are a code-search subagent. Find the code most relevant to this request:`,
        ``,
        `    ${query}`,
        ``,
        `Use the grep, find, read and ls tools to locate it. Prefer definitions`,
        `and the core logic over incidental references. Keep it tight — surface`,
        `the handful of locations that actually answer the request, not every hit.`,
        ``,
        `When done, reply with:`,
        `  1. One short paragraph explaining what you found and where.`,
        `  2. A final block, on its own lines, in exactly this form:`,
        ``,
        `LOCATIONS:`,
        `relative/path/to/file.ext:LINE`,
        `relative/path/to/other.ext:LINE`,
        ``,
        `Rules for the LOCATIONS block:`,
        `  • One entry per line, project-relative path, a single 1-based line`,
        `    number pointing at the most relevant line (the definition/signature).`,
        `  • List the most relevant location first. No commentary in this block.`,
    ].join("\n");
}

/** Pull the concatenated text out of the last assistant message. */
function lastAssistantText(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || m.role !== "assistant") continue;
        const c = m.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c))
            return c
                .filter((p: any) => p && p.type === "text")
                .map((p: any) => p.text)
                .join("");
    }
    return "";
}

interface Location {
    path: string; // as reported (project-relative or absolute)
    line: number; // 1-based
}

/**
 * Split the subagent answer into its human explanation and the parsed
 * `LOCATIONS:` entries. Tolerant: if the marker is missing we scan the whole
 * message for `path:line` tokens so a slightly off-format answer still renders.
 */
function parseAnswer(text: string): {
    explanation: string;
    locations: Location[];
} {
    const lines = text.split(/\r?\n/);
    const markerIdx = lines.findIndex((l) => /^\s*LOCATIONS:?\s*$/i.test(l));
    const bodyLines = markerIdx >= 0 ? lines.slice(markerIdx + 1) : lines;
    const explanation =
        markerIdx >= 0
            ? lines.slice(0, markerIdx).join("\n").trim()
            : text.trim();

    const locations: Location[] = [];
    const seen = new Set<string>();
    // `path:line` — path may contain no whitespace; line is 1+ digits, optional
    // `-end` range (we anchor on the start line).
    const re = /([^\s:]+(?:\/[^\s:]+)*):(\d+)(?:-\d+)?/g;
    for (const l of bodyLines) {
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(l))) {
            const path = m[1];
            const line = parseInt(m[2], 10);
            if (!line || !/[./]/.test(path)) continue; // skip bare `word:12`
            const key = `${path}:${line}`;
            if (seen.has(key)) continue;
            seen.add(key);
            locations.push({ path, line });
            if (locations.length >= MAX_LOCATIONS)
                return { explanation, locations };
        }
    }
    return { explanation, locations };
}

/** Column span [firstNonWs, lastNonWs+1) so the reported line gets a <mark>. */
function contentRange(text: string): [number, number][] {
    const start = text.search(/\S/);
    if (start < 0) return [];
    const end = text.length - (text.length - text.trimEnd().length);
    return [[start, end]];
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // Pre-load tree-sitter grammars so the (sync) result renderer highlights on
    // first paint and on replay (falls back to plain text until warmed).
    warm().catch(() => {});
    piweb.registerMessageRenderer("semgrep-result", (message: any) => {
        const d = (message.details as any) || {};
        if (!Array.isArray(d.files) || !d.files.length) {
            return {
                type: "Text",
                text: `semgrep: no code found for “${d.query ?? ""}”`,
            };
        }
        const files: FileHits[] = d.files.map((f: any) => ({
            path: f.path,
            lines: highlightLines(f.path, f.content),
            matches: f.matches,
        }));
        const nLoc = files.reduce((n, f) => n + f.matches.length, 0);
        const summary =
            `<div class="summary"><b>${nLoc}</b> location${nLoc === 1 ? "" : "s"} in ` +
            `<b>${files.length}</b> file${files.length === 1 ? "" : "s"} for ` +
            `<span class="q">${escapeHtml(d.query ?? "")}</span></div>` +
            (d.explanation
                ? `<div class="summary">${escapeHtml(d.explanation).replace(/\n/g, "<br>")}</div>`
                : "");
        return { type: "Frame", html: renderMultibuffer(files, summary) };
    });

    pi.registerCommand("semgrep", {
        description:
            "Semantic code search: a subagent finds the code, shown as a multibuffer",
        handler: async (args: string, ctx: ExtensionCommandContext) => {
            const query = (args ?? "").trim();
            if (!query) {
                piweb.notify(
                    "Usage: /semgrep <natural language search>",
                    "info",
                );
                return;
            }
            if (!piweb.present) {
                piweb.notify(
                    "The /semgrep multibuffer needs the web UI.",
                    "info",
                );
                return;
            }
            if (!ctx.model) {
                piweb.notify(
                    "semgrep: no model available for the subagent.",
                    "error",
                );
                return;
            }

            const root = ctx.cwd;
            const toDisplay = (p: string): string => {
                const abs = isAbsolute(p) ? p : resolve(root, p);
                const rel = relative(root, abs);
                return !rel || rel.startsWith("..") ? p : rel;
            };

            piweb.setStatus(STATUS_KEY, "semgrep: searching…");

            let session:
                | Awaited<ReturnType<typeof createAgentSession>>["session"]
                | undefined;
            try {
                // 1. Spawn an isolated, read-only subagent.
                ({ session } = await createAgentSession({
                    cwd: root,
                    model: ctx.model,
                    modelRegistry: ctx.modelRegistry,
                    tools: ["grep", "find", "read", "ls"], // no edit/write/bash
                }));

                // Surface the subagent's tool activity in the status line.
                session.subscribe((ev: any) => {
                    if (ev.type === "tool_execution_start" && ev.args)
                        piweb.setStatus(
                            STATUS_KEY,
                            `semgrep: ${ev.toolName} ${
                                ev.args.pattern ??
                                ev.args.query ??
                                ev.args.path ??
                                ""
                            }`.trim(),
                        );
                });

                // 2. Drive the whole tool loop to completion.
                await session.prompt(buildPrompt(query));

                // 3. Harvest + parse the answer.
                const { explanation, locations } = parseAnswer(
                    lastAssistantText(session.messages),
                );
                if (!locations.length) {
                    piweb.notify(
                        `semgrep: no locations found for “${query}”`,
                        "warning",
                    );
                    return;
                }

                // 4. Read the referenced files host-side and build the multibuffer.
                const byPath = new Map<string, Location[]>();
                for (const loc of locations) {
                    const disp = toDisplay(loc.path);
                    (byPath.get(disp) ?? byPath.set(disp, []).get(disp)!).push(
                        loc,
                    );
                }

                const files: {
                    path: string;
                    content: string;
                    matches: LineMatch[];
                }[] = [];
                for (const [disp, locs] of byPath) {
                    if (files.length >= MAX_FILES) break;
                    const abs = isAbsolute(locs[0].path)
                        ? locs[0].path
                        : resolve(root, locs[0].path);
                    let content: string;
                    try {
                        content = await readFile(abs, "utf8");
                    } catch {
                        continue; // hallucinated / moved path — skip
                    }
                    const srcLines = content.split("\n");
                    const matches: LineMatch[] = [];
                    const usedLines = new Set<number>();
                    for (const { line } of locs) {
                        const idx = Math.min(
                            Math.max(line - 1, 0),
                            srcLines.length - 1,
                        );
                        if (usedLines.has(idx)) continue;
                        usedLines.add(idx);
                        matches.push({
                            line: idx,
                            ranges: contentRange(srcLines[idx] ?? ""),
                        });
                    }
                    matches.sort((a, b) => a.line - b.line);
                    if (matches.length)
                        files.push({ path: disp, content, matches });
                }

                if (!files.length) {
                    piweb.notify(
                        `semgrep: located ${locations.length} reference(s) but none resolved to a readable file.`,
                        "warning",
                    );
                    return;
                }

                // 5. Present it — agent-visible digest in `content`, render payload
                //    in `details` (consumed by the renderer above).
                const digest = [
                    `semgrep: ${query}`,
                    explanation,
                    ...files.flatMap((f) =>
                        f.matches.map((m) => `  ${f.path}:${m.line + 1}`),
                    ),
                ]
                    .filter(Boolean)
                    .join("\n");

                await warm(); // ensure the immediate live render is highlighted
                pi.sendMessage({
                    customType: "semgrep-result",
                    content: digest,
                    display: true,
                    details: { query, explanation, files },
                });
            } catch (err: any) {
                piweb.notify(`semgrep failed: ${err?.message ?? err}`, "error");
            } finally {
                piweb.setStatus(STATUS_KEY); // clear
                try {
                    session?.dispose();
                } catch {
                    /* ignore */
                }
            }
        },
    });
}
