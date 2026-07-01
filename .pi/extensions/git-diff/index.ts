/**
 * git-diff — `/gdiff [args]` renders a real **git diff** as a Zed-style
 * side-by-side ("split") multibuffer: one collapsible section per file, each
 * laid out in two columns (old | new) with aligned rows, hunk separators, and
 * word-level intra-line highlighting. Colors track the active pi theme.
 *
 * This complements the sibling `split-diff` extension: where that one shows the
 * *edits pi made this session* (captured from the `edit` tool), this one shows
 * the *git working tree* — exactly what `git diff` reports — so you can review a
 * branch, the staged index, or any revision range the way you would in Zed.
 *
 * How it works (pure extension — no pi-web host changes):
 *   • The command shells out to `git diff <args>` host-side and parses the
 *     unified diff (multi-file, multi-hunk). Line numbers are reconstructed from
 *     the `@@ -a,b +c,d @@` hunk headers, and consecutive −/＋ runs are paired
 *     for side-by-side alignment with `diff`'s word-level highlighting.
 *   • The whole thing is emitted as one `{ type:"Frame", html }` custom message.
 *     The sandboxed <pi-frame> inherits the theme `--diff-*` / `--syn-*` / line
 *     tokens and runs its own JS (allow-scripts) so file sections collapse and
 *     hunks expand client-side with no host round-trip. Re-rendered from the
 *     stored raw diff on replay, so it stays serializable + faithful.
 *   • `piweb.addAutocompleteProvider` completes `/gdiff ` with common ref/flag
 *     args (`--staged`, `HEAD`, `HEAD~1`, `main`…) and the changed file paths.
 *
 * Under plain terminal pi (`piweb.present === false`) the rich view no-ops and
 * the command explains it needs the web UI.
 *
 * Commands:
 *   /gdiff              — working tree vs index (unstaged; falls back to staged)
 *   /gdiff --staged     — staged changes (index vs HEAD)
 *   /gdiff HEAD~2       — arbitrary revision / range / pathspec (passed to git)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { diffWords } from "diff";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { piweb } from "../../../src/sdk/piweb.ts";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Parsing git's unified diff
// ---------------------------------------------------------------------------

type LineKind = "ctx" | "del" | "add";
interface DiffLine {
    kind: LineKind;
    oldNum: number | null;
    newNum: number | null;
    content: string;
}
interface Hunk {
    header: string; // the section heading after "@@ … @@", if any
    lines: DiffLine[];
}
type FileStatus =
    | "modified"
    | "added"
    | "deleted"
    | "renamed"
    | "binary";
interface FileDiff {
    path: string; // new path (or old path for deletes)
    oldPath: string | null; // set when renamed
    status: FileStatus;
    hunks: Hunk[];
    added: number;
    removed: number;
}

// "@@ -oldStart,oldCount +newStart,newCount @@ heading"
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Strip the leading a/ or b/ that git prefixes onto diff paths. */
function stripPrefix(p: string): string {
    if (p === "/dev/null") return p;
    return p.replace(/^[ab]\//, "");
}

function parseGitDiff(text: string): FileDiff[] {
    const lines = text.split("\n");
    const files: FileDiff[] = [];
    let file: FileDiff | null = null;
    let hunk: Hunk | null = null;
    let oldNum = 0;
    let newNum = 0;

    const pushFile = () => {
        if (file) {
            if (hunk) file.hunks.push(hunk);
            files.push(file);
        }
        hunk = null;
    };

    for (const raw of lines) {
        if (raw.startsWith("diff --git ")) {
            pushFile();
            // diff --git a/<old> b/<new>
            const m = raw.match(/^diff --git (.+) (.+)$/);
            const oldP = m ? stripPrefix(m[1]) : "";
            const newP = m ? stripPrefix(m[2]) : oldP;
            file = {
                path: newP || oldP,
                oldPath: null,
                status: "modified",
                hunks: [],
                added: 0,
                removed: 0,
            };
            continue;
        }
        if (!file) continue;

        if (raw.startsWith("new file mode")) {
            file.status = "added";
            continue;
        }
        if (raw.startsWith("deleted file mode")) {
            file.status = "deleted";
            continue;
        }
        if (raw.startsWith("rename from ")) {
            file.oldPath = raw.slice("rename from ".length);
            file.status = "renamed";
            continue;
        }
        if (raw.startsWith("rename to ")) {
            file.path = raw.slice("rename to ".length);
            file.status = "renamed";
            continue;
        }
        if (raw.startsWith("Binary files")) {
            file.status = "binary";
            continue;
        }
        // "--- a/path" / "+++ b/path": trust these for the real paths.
        if (raw.startsWith("--- ")) {
            const p = stripPrefix(raw.slice(4).trim());
            if (p !== "/dev/null" && file.status !== "renamed") file.oldPath = p;
            continue;
        }
        if (raw.startsWith("+++ ")) {
            const p = stripPrefix(raw.slice(4).trim());
            if (p !== "/dev/null" && file.status !== "renamed") file.path = p;
            continue;
        }

        const hm = raw.match(HUNK_RE);
        if (hm) {
            if (hunk) file.hunks.push(hunk);
            oldNum = parseInt(hm[1], 10);
            newNum = parseInt(hm[2], 10);
            hunk = { header: hm[3].trim(), lines: [] };
            continue;
        }
        if (!hunk) continue;

        // "\ No newline at end of file" — attach nothing, just skip.
        if (raw.startsWith("\\")) continue;

        const marker = raw[0];
        const content = raw.slice(1);
        if (marker === "+") {
            hunk.lines.push({
                kind: "add",
                oldNum: null,
                newNum: newNum++,
                content,
            });
            file.added++;
        } else if (marker === "-") {
            hunk.lines.push({
                kind: "del",
                oldNum: oldNum++,
                newNum: null,
                content,
            });
            file.removed++;
        } else if (marker === " ") {
            hunk.lines.push({
                kind: "ctx",
                oldNum: oldNum++,
                newNum: newNum++,
                content,
            });
        }
        // any other stray line inside a hunk is ignored
    }
    pushFile();
    return files;
}

// ---------------------------------------------------------------------------
// Side-by-side row model (mirrors split-diff's alignment + word highlighting)
// ---------------------------------------------------------------------------

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

interface Side {
    num: number | null;
    html: string; // already-escaped, may contain <span class="inverse">
}
type Row =
    | { kind: "ctx"; left: Side; right: Side }
    | { kind: "change"; left: Side | null; right: Side | null }
    | { kind: "hunk"; text: string };

/**
 * Word-level diff of a changed line pair → escaped HTML with changed runs
 * wrapped in <span class="inverse">. Leading whitespace stays un-highlighted so
 * indentation doesn't flash.
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

/** Turn one file's hunks into aligned side-by-side rows. */
function alignFile(file: FileDiff): Row[] {
    const rows: Row[] = [];
    for (const hunk of file.hunks) {
        rows.push({
            kind: "hunk",
            text: hunk.header || "",
        });
        const lines = hunk.lines;
        let i = 0;
        while (i < lines.length) {
            const ln = lines[i];
            if (ln.kind === "ctx") {
                const c = escapeHtml(replaceTabs(ln.content));
                rows.push({
                    kind: "ctx",
                    left: { num: ln.oldNum, html: c },
                    right: { num: ln.newNum, html: c },
                });
                i++;
                continue;
            }
            // change block: consecutive dels then consecutive adds
            const dels: DiffLine[] = [];
            while (i < lines.length && lines[i].kind === "del")
                dels.push(lines[i++]);
            const adds: DiffLine[] = [];
            while (i < lines.length && lines[i].kind === "add")
                adds.push(lines[i++]);
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
                    left = { num: del.oldNum, html: lh };
                    right = { num: add.newNum, html: rh };
                } else if (del) {
                    left = {
                        num: del.oldNum,
                        html: escapeHtml(replaceTabs(del.content)),
                    };
                } else if (add) {
                    right = {
                        num: add.newNum,
                        html: escapeHtml(replaceTabs(add.content)),
                    };
                }
                rows.push({ kind: "change", left, right });
            }
        }
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function cell(side: Side | null, cls: string, mid: boolean): string {
    const m = mid ? " mid" : "";
    if (!side) return `<td class="ln${m}"></td><td class="tx"></td>`;
    const num = side.num == null ? "" : String(side.num);
    return (
        `<td class="ln ${cls}${m}">${num}</td>` +
        `<td class="tx ${cls}">${side.html || "&nbsp;"}</td>`
    );
}

const STATUS_LABEL: Record<FileStatus, string> = {
    modified: "modified",
    added: "added",
    deleted: "deleted",
    renamed: "renamed",
    binary: "binary",
};

function fileSection(file: FileDiff): string {
    const rows = alignFile(file);
    const body = rows
        .map((r) => {
            if (r.kind === "hunk") {
                const label = r.text ? escapeHtml(r.text) : "⋯";
                return `<tr class="hunk"><td colspan="4">${label}</td></tr>`;
            }
            if (r.kind === "ctx") {
                return `<tr>${cell(r.left, "diff-context", false)}${cell(r.right, "diff-context", true)}</tr>`;
            }
            return `<tr>${cell(r.left, "diff-removed", false)}${cell(r.right, "diff-added", true)}</tr>`;
        })
        .join("");

    const slash = file.path.lastIndexOf("/");
    const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
    const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    const rename =
        file.status === "renamed" && file.oldPath
            ? `<span class="ren">${escapeHtml(file.oldPath)} →</span>`
            : "";

    const table = body
        ? `<table><colgroup><col class="gutter"><col><col class="gutter"><col></colgroup><tbody>${body}</tbody></table>`
        : `<div class="empty">No textual diff (${STATUS_LABEL[file.status]}).</div>`;

    return (
        `<section class="file">` +
        `<div class="fhdr"><span class="tw">▾</span>` +
        `<span class="badge ${file.status}">${STATUS_LABEL[file.status]}</span>` +
        rename +
        `<span class="fname">${escapeHtml(base)}</span>` +
        `<span class="fdir">${escapeHtml(dir)}</span>` +
        `<span class="stat"><span class="plus">+${file.added}</span> ` +
        `<span class="minus">-${file.removed}</span></span></div>` +
        `<div class="body">${table}</div>` +
        `</section>`
    );
}

const STYLE = `
<style>
  body { margin: 0;
         background: var(--bg, #0c1117);
         color: var(--txt, #ddd);
         font: 13px/1.55 ui-monospace, Menlo, monospace; }
  .summary { padding: 6px 12px; color: var(--muted);
             background: var(--panel); border-bottom: 1px solid var(--line); }
  .summary b { color: var(--txt); font-weight: 600; }
  .summary .plus { color: var(--diff-added); }
  .summary .minus { color: var(--diff-removed); }
  .file { border-bottom: 1px solid var(--line, #333); }
  .fhdr { display: flex; gap: 8px; align-items: center; cursor: pointer;
          padding: 5px 12px; position: sticky; top: 0; z-index: 1;
          background: var(--panel, #1a1a1a);
          border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .fhdr:hover { background: var(--hover, rgba(255,255,255,.04)); }
  .fhdr .tw { width: 1ch; color: var(--muted); user-select: none; }
  .fhdr .fname { color: var(--txt); font-weight: 600; }
  .fhdr .fdir { color: var(--dim, #667); flex: 1; }
  .fhdr .ren { color: var(--muted); }
  .fhdr .stat .plus { color: var(--diff-added); }
  .fhdr .stat .minus { color: var(--diff-removed); }
  .badge { font-size: 11px; padding: 0 6px; border-radius: 999px;
           border: 1px solid var(--line); color: var(--muted); user-select: none; }
  .badge.added { color: var(--diff-added); border-color: var(--diff-added); }
  .badge.deleted { color: var(--diff-removed); border-color: var(--diff-removed); }
  .badge.renamed { color: var(--acc, #6cf); border-color: var(--acc, #6cf); }
  .file.collapsed .body { display: none; }

  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  col.gutter { width: 3.5em; }
  td { padding: 0 6px; vertical-align: top; }
  td.ln { text-align: right; user-select: none; -webkit-user-select: none;
          color: var(--dim, #666); }
  td.tx { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; }
  /* center divider between the two panes */
  td.mid { border-left: 1px solid var(--line); }
  .diff-added { color: var(--diff-added); }
  .diff-removed { color: var(--diff-removed); }
  .diff-context { color: var(--diff-context); }
  td.tx.diff-added, td.tx.diff-removed { }
  td.ln.diff-added { background: color-mix(in srgb, var(--diff-added) 12%, transparent); }
  td.ln.diff-removed { background: color-mix(in srgb, var(--diff-removed) 12%, transparent); }
  td.tx.diff-added { background: color-mix(in srgb, var(--diff-added) 8%, transparent); }
  td.tx.diff-removed { background: color-mix(in srgb, var(--diff-removed) 8%, transparent); }
  .inverse { color: var(--bg); border-radius: 2px; }
  .diff-added .inverse { background: var(--diff-added); }
  .diff-removed .inverse { background: var(--diff-removed); }
  tr.hunk td { color: var(--dim); background: var(--panel);
               padding: 2px 12px; font-style: italic;
               border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .empty { padding: 8px 12px; color: var(--muted); }
</style>`;

const SCRIPT = `
<script>(function(){
  document.addEventListener('click', function(e){
    var t=e.target; if(!t.closest) return;
    var h=t.closest('.fhdr'); if(!h) return;
    var f=h.closest('.file'); if(!f) return;
    f.classList.toggle('collapsed');
    var tw=h.querySelector('.tw');
    if(tw) tw.textContent = f.classList.contains('collapsed') ? '▸' : '▾';
  });
})();<\/script>`;

function buildDiffHtml(label: string, files: FileDiff[]): string {
    const added = files.reduce((n, f) => n + f.added, 0);
    const removed = files.reduce((n, f) => n + f.removed, 0);
    const summary =
        `<div class="summary"><b>${files.length}</b> file${files.length === 1 ? "" : "s"} changed` +
        ` · <span class="plus">+${added}</span> <span class="minus">-${removed}</span>` +
        ` · <b>${escapeHtml(label)}</b></div>`;
    return STYLE + summary + files.map(fileSection).join("") + SCRIPT;
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/** Split a raw arg string into argv, respecting simple quotes. */
function splitArgs(s: string): string[] {
    const out: string[] = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // The thread's working directory. `pi` (ExtensionAPI) has no cwd of its own,
    // and process.cwd() is the pi-web *server's* CWD — not the thread's. The
    // authoritative cwd arrives on the handler `ctx` (ExtensionCommandContext.
    // cwd); we also seed it from session_start so the autocomplete provider —
    // which only receives { text, caret } — has a repo root to run git in.
    let root = process.cwd();
    pi.on("session_start", (_event: any, ctx: any) => {
        if (ctx?.cwd) root = ctx.cwd;
    });

    piweb.registerMessageRenderer("git-diff", (message: any) => {
        const d = (message.details as any) || {};
        const raw = typeof d.diff === "string" ? d.diff : "";
        const label = typeof d.label === "string" ? d.label : "git diff";
        if (!raw.trim()) {
            return { type: "Text", text: `git-diff: no changes (${label})` };
        }
        const files = parseGitDiff(raw);
        if (!files.length) {
            return { type: "Text", text: `git-diff: nothing to show (${label})` };
        }
        return { type: "Frame", html: buildDiffHtml(label, files) };
    });

    // Autocomplete: refs/flags + changed file paths after "/gdiff ".
    piweb.addAutocompleteProvider(async ({ text, caret }) => {
        const before = text.slice(0, caret);
        const m = before.match(/^\/gdiff(\s+)(.*)$/s);
        if (!m) return null;
        const query = m[2];
        const start = caret - query.length;
        const suggestions: { value: string; description: string }[] = [
            { value: "--staged", description: "staged changes (index vs HEAD)" },
            { value: "HEAD", description: "working tree vs HEAD" },
            { value: "HEAD~1", description: "vs previous commit" },
            { value: "--stat", description: "(passed through to git)" },
        ];
        try {
            const names = await runGit(root, [
                "diff",
                "--name-only",
                "HEAD",
            ]);
            for (const n of names.split("\n"))
                if (n.trim())
                    suggestions.push({ value: n.trim(), description: "changed file" });
        } catch {
            /* not a repo / no HEAD — just offer flags */
        }
        const q = query.toLowerCase();
        const items = suggestions
            .filter((s) => !q || s.value.toLowerCase().includes(q))
            .slice(0, 20)
            .map((s) => ({ value: s.value, label: s.value, description: s.description }));
        if (!items.length) return null;
        return { start, end: caret, items };
    });

    pi.registerCommand("gdiff", {
        description:
            "Side-by-side git diff (Zed-style). Args pass through to `git diff`.",
        handler: async (args?: string, ctx?: any) => {
            // Authoritative: run git in *this thread's* cwd, not the server's.
            if (ctx?.cwd) root = ctx.cwd;
            const arg = (args ?? "").trim();
            if (!piweb.present) {
                piweb.notify("The side-by-side /gdiff view needs the web UI.", "info");
                return;
            }

            // Confirm we're in a repo first for a clean message.
            try {
                await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
            } catch {
                piweb.notify("Not inside a git repository.", "error");
                return;
            }

            const passed = splitArgs(arg);
            const label = arg ? `git diff ${arg}` : "git diff";
            let diff = "";
            try {
                diff = await runGit(root, ["diff", ...passed]);
                // No unstaged changes and no explicit args → try the staged set.
                if (!diff.trim() && !passed.length) {
                    diff = await runGit(root, ["diff", "--staged"]);
                    if (diff.trim()) {
                        return emit("git diff --staged", diff);
                    }
                }
            } catch (err: any) {
                piweb.notify(`git diff failed: ${err?.message ?? err}`, "error");
                return;
            }

            if (!diff.trim()) {
                piweb.notify(`No changes for: ${label}`, "warning");
                return;
            }
            emit(label, diff);

            function emit(lbl: string, raw: string) {
                const files = parseGitDiff(raw);
                pi.sendMessage({
                    customType: "git-diff",
                    content: `${lbl}: ${files.length} file${files.length === 1 ? "" : "s"} changed`,
                    display: true,
                    details: { label: lbl, diff: raw },
                });
            }
        },
    });
}
