/**
 * split-diff — a side-by-side ("split") diff viewer, authored entirely as an
 * extension (no pi-web host changes).
 *
 * The built-in `edit` tool card renders a *unified* diff (matching the pi TUI).
 * This extension adds an opt-in *split* view: two columns (old | new) with
 * aligned rows and word-level intra-line highlighting. It works purely through
 * the public `piweb` surface:
 *
 *   • `pi.on("tool_result", …)` captures each edit's `details.diff` string —
 *     the exact same data the built-in card uses, so the two can't drift.
 *   • `piweb.registerMessageRenderer("split-diff", …)` returns a serializable
 *     `Frame` node whose sandboxed HTML lays the diff out side-by-side. The
 *     frame inherits the active theme's `--diff-added/removed/context` vars, so
 *     colors track the current pi theme.
 *   • `/split-diff` emits the last edit (or lets you pick a file) as a
 *     custom transcript message rendered by that renderer.
 *
 * Because it only touches `piweb` (which no-ops under plain terminal pi) and
 * standard `pi.*` APIs, it stays a valid, portable pi extension.
 *
 * Commands:
 *   /split-diff        — show the most recent edit side-by-side (picker if many)
 *   /split-diff-auto   — toggle auto-appending a split view after every edit
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diffWords } from "diff";
import { piweb } from "../../../src/sdk/piweb.ts";

// ---- diff-string parsing (mirrors src/web/diff.ts / pi's generateDiffString) --
// Each diff line is "<prefix><padded lineNum> <content>", prefix ∈ {+,-, }.
interface ParsedLine {
    prefix: "+" | "-" | " ";
    num: string;
    content: string;
}

function parseDiffLine(line: string): ParsedLine | null {
    const m = line.match(/^([+\-\s])(\s*\d*)\s(.*)$/);
    if (!m) return null;
    return {
        prefix: m[1] as ParsedLine["prefix"],
        num: m[2].trim(),
        content: m[3],
    };
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** Tabs → 3 spaces for stable column alignment (matches pi-tui). */
function replaceTabs(text: string): string {
    return text.replace(/\t/g, "   ");
}

// ---- side-by-side row model ---------------------------------------------------
interface Side {
    num: string;
    html: string; // already-escaped, may contain <mark> spans
}
type Row =
    | { kind: "ctx"; left: Side; right: Side }
    | { kind: "change"; left: Side | null; right: Side | null }
    | { kind: "meta"; text: string }; // hunk gaps / unparseable lines

/**
 * Word-level diff of a changed line pair → escaped HTML with changed runs
 * wrapped in <mark> (the split analogue of pi-tui's `.inverse`). Leading
 * whitespace stays un-highlighted so indentation doesn't flash.
 */
function intraLine(
    oldC: string,
    newC: string,
): { left: string; right: string } {
    let left = "";
    let right = "";
    let firstDel = true;
    let firstIns = true;
    for (const part of diffWords(oldC, newC)) {
        if (part.removed) {
            let v = part.value;
            if (firstDel) {
                const ws = v.match(/^(\s*)/)?.[1] ?? "";
                v = v.slice(ws.length);
                left += escapeHtml(ws);
                firstDel = false;
            }
            if (v) left += `<span class="inverse">${escapeHtml(v)}</span>`;
        } else if (part.added) {
            let v = part.value;
            if (firstIns) {
                const ws = v.match(/^(\s*)/)?.[1] ?? "";
                v = v.slice(ws.length);
                right += escapeHtml(ws);
                firstIns = false;
            }
            if (v) right += `<span class="inverse">${escapeHtml(v)}</span>`;
        } else {
            left += escapeHtml(part.value);
            right += escapeHtml(part.value);
        }
    }
    return { left, right };
}

/** Turn a unified diff string into aligned side-by-side rows. */
function alignRows(diffText: string): Row[] {
    const lines = diffText.split("\n");
    const rows: Row[] = [];
    let i = 0;
    while (i < lines.length) {
        const parsed = parseDiffLine(lines[i]);
        if (!parsed) {
            const raw = lines[i];
            // Skip trailing empties; keep gap markers (e.g. "…") as meta rows.
            if (raw.trim() !== "") rows.push({ kind: "meta", text: raw });
            i++;
            continue;
        }
        if (parsed.prefix === " ") {
            const c = replaceTabs(parsed.content);
            rows.push({
                kind: "ctx",
                left: { num: parsed.num, html: escapeHtml(c) },
                right: { num: parsed.num, html: escapeHtml(c) },
            });
            i++;
            continue;
        }
        // A change block: consecutive removals, then consecutive additions.
        const dels: ParsedLine[] = [];
        while (i < lines.length) {
            const p = parseDiffLine(lines[i]);
            if (!p || p.prefix !== "-") break;
            dels.push(p);
            i++;
        }
        const adds: ParsedLine[] = [];
        while (i < lines.length) {
            const p = parseDiffLine(lines[i]);
            if (!p || p.prefix !== "+") break;
            adds.push(p);
            i++;
        }
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k++) {
            const del = dels[k];
            const add = adds[k];
            let left: Side | null = null;
            let right: Side | null = null;
            if (del && add) {
                const { left: lh, right: rh } = intraLine(
                    replaceTabs(del.content),
                    replaceTabs(add.content),
                );
                left = { num: del.num, html: lh };
                right = { num: add.num, html: rh };
            } else if (del) {
                left = {
                    num: del.num,
                    html: escapeHtml(replaceTabs(del.content)),
                };
            } else if (add) {
                right = {
                    num: add.num,
                    html: escapeHtml(replaceTabs(add.content)),
                };
            }
            rows.push({ kind: "change", left, right });
        }
    }
    return rows;
}

// A side's line-number + text cells, colored by the diff class that mirrors the
// app's renderer (`diff-added`/`diff-removed`/`diff-context`). `mid` draws the
// single center divider between the two panes (the one intended divergence).
function cell(side: Side | null, cls: string, mid: boolean): string {
    const m = mid ? " mid" : "";
    if (!side) return `<td class="ln${m}"></td><td class="tx"></td>`;
    return (
        `<td class="ln ${cls}${m}">${escapeHtml(side.num)}</td>` +
        `<td class="tx ${cls}">${side.html || "&nbsp;"}</td>`
    );
}

/** Build the sandboxed <Frame> body HTML for a split diff. */
function buildSplitHtml(diffText: string, path: string): string {
    const rows = alignRows(diffText);
    let added = 0;
    let removed = 0;
    const body = rows
        .map((r) => {
            if (r.kind === "meta") {
                return `<tr class="meta"><td colspan="4">${escapeHtml(r.text)}</td></tr>`;
            }
            if (r.kind === "ctx") {
                return `<tr>${cell(r.left, "diff-context", false)}${cell(r.right, "diff-context", true)}</tr>`;
            }
            if (r.left) removed++;
            if (r.right) added++;
            return `<tr>${cell(r.left, "diff-removed", false)}${cell(r.right, "diff-added", true)}</tr>`;
        })
        .join("");

    const style = `
<style>
  .sd { font: 13px/1.55 ui-monospace, Menlo, monospace; color: var(--txt); }
  .sd .hd {
    display: flex; justify-content: space-between; align-items: center;
    padding: 4px 8px 8px; color: var(--muted);
  }
  .sd .hd .path { color: var(--txt); font-weight: 600; }
  .sd .hd .stat .plus { color: var(--diff-added); }
  .sd .hd .stat .minus { color: var(--diff-removed); }
  .sd table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  .sd col.gutter { width: 3.5em; }
  .sd td { padding: 0 6px; vertical-align: top; }
  .sd td.ln { text-align: right; user-select: none; -webkit-user-select: none; }
  .sd td.tx { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  /* The only divergence from the app's unified diff: a center divider between
     the two panes, drawn with the provided --line token. */
  .sd td.mid { border-left: 1px solid var(--line); }
  /* Colors mirror the app's diff renderer exactly (src/web/index.html): a
     foreground color per line, and a solid .inverse (theme.inverse analogue)
     for intra-line changes — all from the injected --diff-* / --bg tokens. */
  .sd .diff-added { color: var(--diff-added); }
  .sd .diff-removed { color: var(--diff-removed); }
  .sd .diff-context { color: var(--diff-context); }
  .sd .inverse { color: var(--bg); }
  .sd .diff-added .inverse { background: var(--diff-added); }
  .sd .diff-removed .inverse { background: var(--diff-removed); }
  .sd tr.meta td { color: var(--diff-context); text-align: center; padding: 2px 6px; }
</style>`;

    const header =
        `<div class="hd"><span class="path">${escapeHtml(path)}</span>` +
        `<span class="stat"><span class="plus">+${added}</span> ` +
        `<span class="minus">-${removed}</span></span></div>`;

    return (
        `${style}<div class="sd">${header}` +
        `<table><colgroup><col class="gutter"><col><col class="gutter"><col></colgroup>` +
        `<tbody>${body}</tbody></table></div>`
    );
}

export default function (pi: ExtensionAPI) {
    // Most-recent-first list of edits seen this session, deduped by path.
    const recent: { path: string; diff: string }[] = [];
    let auto = false;

    const remember = (path: string, diff: string) => {
        const idx = recent.findIndex((e) => e.path === path);
        if (idx !== -1) recent.splice(idx, 1);
        recent.unshift({ path, diff });
        if (recent.length > 50) recent.pop();
    };

    const emitSplit = (path: string, diff: string) => {
        pi.sendMessage({
            customType: "split-diff",
            content: `Side-by-side diff: ${path}`,
            display: true,
            details: { path, diff },
        });
    };

    // Render "split-diff" custom messages as a sandboxed side-by-side Frame.
    piweb.registerMessageRenderer("split-diff", (message: any) => {
        const d = (message.details as any) || {};
        const diff = typeof d.diff === "string" ? d.diff : "";
        const path = typeof d.path === "string" ? d.path : "diff";
        if (!diff) {
            return { type: "Text", text: "split-diff: no diff data" };
        }
        return { type: "Frame", html: buildSplitHtml(diff, path) };
    });

    // Capture every edit's diff string (same data the built-in card renders).
    pi.on("tool_result", async (event: any) => {
        if (event?.toolName !== "edit") return;
        const diff = event?.details?.diff;
        if (typeof diff !== "string" || !diff) return;
        const input = event?.input ?? {};
        const path =
            input.file_path ?? input.path ?? input.filePath ?? "edited file";
        remember(String(path), diff);
        if (auto) emitSplit(String(path), diff);
    });

    pi.registerCommand("split-diff", {
        description: "Show the most recent edit as a side-by-side diff",
        handler: async () => {
            if (!recent.length) {
                piweb.notify("No edits captured yet this session", "warning");
                return;
            }
            let choice = recent[0];
            if (recent.length > 1) {
                const picked = await piweb.select(
                    "Side-by-side diff for…",
                    recent.map((e) => e.path),
                );
                if (!picked) return;
                choice = recent.find((e) => e.path === picked) ?? recent[0];
            }
            emitSplit(choice.path, choice.diff);
        },
    });

    pi.registerCommand("split-diff-auto", {
        description: "Toggle auto side-by-side diff after every edit",
        handler: async () => {
            auto = !auto;
            piweb.notify(
                auto
                    ? "Split diff: auto-on (a side-by-side view follows each edit)"
                    : "Split diff: auto-off",
                "info",
            );
        },
    });
}
