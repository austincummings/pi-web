/**
 * cat-file — `/cat <path>` reads a file off disk and renders it in the
 * transcript with syntax highlighting, `bat`-style: a line-number gutter, a
 * header showing the path + detected language, and colors drawn from the active
 * pi theme. If the language can't be detected the file is shown unhighlighted
 * (plain text) rather than mis-colored.
 *
 * How it works (pure extension — no pi-web host changes):
 *   • Highlighting runs host-side with highlight.js (already available under pi
 *     as a transitive dependency). Language is picked from the file extension
 *     first; failing that we fall back to highlight.js content auto-detection,
 *     and if that isn't confident we render plain text.
 *   • The highlighted HTML is emitted as a custom transcript message whose
 *     renderer returns a { type:"Frame", html } node. pi-web mounts that in a
 *     sandboxed <pi-frame> that already inherits the theme's `--syn-*` palette
 *     (see src/web/pi-frame.ts THEME_VARS), so highlight.js' `hljs-*` classes
 *     map straight onto the pi syntax colors.
 *   • `piweb.addAutocompleteProvider` completes `/cat <path>` as you type.
 *
 * Under plain terminal pi (`piweb.present === false`) the frame/renderer
 * no-op; the command reports that the rich view needs the web UI.
 *
 * Commands:
 *   /cat <path>   — render a file with syntax highlighting (Tab to complete)
 *
 * Tools:
 *   cat({ path })  — the same rich view, but callable by the agent. It renders
 *     the file for the user AND returns the file's contents to the model, so a
 *     single tool call both *shows* and *reads* the file.
 */
import {
    createReadToolDefinition,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import hljs from "highlight.js";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { piweb } from "../../../src/sdk/piweb.ts";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

// Extension → highlight.js language id. Only the cases where the bare extension
// isn't already a valid hljs language id (or is ambiguous) need to be listed;
// everything else is resolved via hljs.getLanguage(ext) below.
const EXT_LANG: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    kt: "kotlin",
    kts: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    cs: "csharp",
    java: "java",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    ini: "ini",
    md: "markdown",
    markdown: "markdown",
    html: "xml",
    htm: "xml",
    xml: "xml",
    svg: "xml",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    jsonc: "json",
    sql: "sql",
    dockerfile: "dockerfile",
    make: "makefile",
    mk: "makefile",
    lua: "lua",
    pl: "perl",
    r: "r",
    scala: "scala",
    dart: "dart",
    ex: "elixir",
    exs: "elixir",
    clj: "clojure",
    hs: "haskell",
    vue: "xml",
    diff: "diff",
    patch: "diff",
};

// Special-cased by basename (no useful extension).
const NAME_LANG: Record<string, string> = {
    dockerfile: "dockerfile",
    makefile: "makefile",
    gnumakefile: "makefile",
    "cmakelists.txt": "cmake",
    ".gitignore": "plaintext",
    ".env": "bash",
};

interface Picked {
    language: string; // hljs language id, or "" for plain text
    label: string; // human label for the header
}

/** Decide which language to highlight `content` as, bat-style. */
function pickLanguage(path: string, content: string): Picked {
    const name = basename(path).toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop()! : "";

    const byName = NAME_LANG[name];
    if (byName && byName !== "plaintext" && hljs.getLanguage(byName))
        return { language: byName, label: byName };
    if (byName === "plaintext") return { language: "", label: "plain text" };

    const byExt =
        EXT_LANG[ext] ?? (ext && hljs.getLanguage(ext) ? ext : undefined);
    if (byExt && hljs.getLanguage(byExt))
        return { language: byExt, label: byExt };

    // No extension mapping — let highlight.js guess from the content, but only
    // trust a reasonably confident guess (relevance is hljs' own heuristic).
    const auto = hljs.highlightAuto(content);
    if (auto.language && auto.relevance >= 5)
        return { language: auto.language, label: `${auto.language} (auto)` };

    return { language: "", label: "plain text" };
}

// ---------------------------------------------------------------------------
// Highlighting → line-numbered HTML
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Split highlight.js output into individual lines while keeping `<span>`
 * nesting balanced per line — a multi-line comment/string span is closed at the
 * newline and reopened on the next line, so each line is valid standalone HTML.
 */
function splitHighlightedLines(html: string): string[] {
    const lines: string[] = [];
    const open: string[] = []; // stack of open <span …> tags
    let cur = "";
    const re = /<\/?[^>]+>|[^<]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const tok = m[0];
        if (tok[0] === "<") {
            if (tok.startsWith("</")) {
                open.pop();
                cur += tok;
            } else if (tok.endsWith("/>")) {
                cur += tok;
            } else {
                open.push(tok);
                cur += tok;
            }
        } else {
            const parts = tok.split("\n");
            for (let k = 0; k < parts.length; k++) {
                cur += parts[k];
                if (k < parts.length - 1) {
                    for (let s = open.length - 1; s >= 0; s--) cur += "</span>";
                    lines.push(cur);
                    cur = open.join("");
                }
            }
        }
    }
    for (let s = open.length - 1; s >= 0; s--) cur += "</span>";
    lines.push(cur);
    return lines;
}

const MAX_LINES = 2000;

/** Build the sandboxed-frame body HTML: header + line-numbered code. */
function buildFrameHtml(path: string, content: string): string {
    const picked = pickLanguage(path, content);
    const highlighted = picked.language
        ? hljs.highlight(content, {
              language: picked.language,
              ignoreIllegals: true,
          }).value
        : escapeHtml(content);

    let lines = splitHighlightedLines(highlighted);
    // Drop a single trailing empty line (files usually end in "\n").
    if (lines.length && lines[lines.length - 1] === "") lines.pop();

    let truncated = 0;
    if (lines.length > MAX_LINES) {
        truncated = lines.length - MAX_LINES;
        lines = lines.slice(0, MAX_LINES);
    }

    const gutter = String(lines.length).length;
    const rows = lines
        .map(
            (ln, i) =>
                `<div class="ln"><span class="no">${i + 1}</span>` +
                `<span class="src">${ln || " "}</span></div>`,
        )
        .join("");

    const meta =
        `${escapeHtml(picked.label)} · ${lines.length} line` +
        (lines.length === 1 ? "" : "s") +
        (truncated ? ` · +${truncated} more truncated` : "");

    return `
<style>
  /* --md-code-block is a *foreground* color (= --txt); the code surface uses
     --panel (theme-driven, opaque) so text stays readable on every theme. */
  body { margin: 0;
         background: var(--panel, #0c1117);
         color: var(--txt, #ddd);
         font: 14px/1.6 ui-monospace, Menlo, monospace; }
  .hdr { display: flex; justify-content: space-between; gap: 12px;
         padding: 4px 12px; color: var(--muted, #888);
         border-bottom: 1px solid var(--line, #333); }
  .hdr .path { color: var(--txt, #ddd); }
  .code { padding: 6px 0; }
  .ln { display: flex; white-space: pre; }
  .ln:hover { background: var(--hover, rgba(255,255,255,.04)); }
  .no { flex: none; width: ${gutter + 1}ch; padding: 0 12px;
        text-align: right; color: var(--dim, #666);
        user-select: none; -webkit-user-select: none; }
  .src { flex: 1; padding-right: 12px; }

  /* highlight.js scopes → pi theme --syn-* palette (see pi-frame THEME_VARS) */
  .hljs-comment, .hljs-quote { color: var(--syn-comment); font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-name,
  .hljs-built_in, .hljs-literal { color: var(--syn-keyword); }
  .hljs-string, .hljs-regexp, .hljs-meta .hljs-string,
  .hljs-symbol, .hljs-bullet { color: var(--syn-string); }
  .hljs-number { color: var(--syn-number); }
  .hljs-title, .hljs-title.function_, .hljs-section,
  .hljs-selector-id, .hljs-link { color: var(--syn-function); }
  .hljs-type, .hljs-class .hljs-title, .hljs-title.class_,
  .hljs-attribute, .hljs-selector-class { color: var(--syn-type); }
  .hljs-variable, .hljs-template-variable, .hljs-attr,
  .hljs-property, .hljs-params { color: var(--syn-variable); }
  .hljs-operator { color: var(--syn-operator); }
  .hljs-punctuation { color: var(--syn-punctuation); }
  .hljs-meta, .hljs-comment.hljs-doctag { color: var(--syn-comment); }
  .hljs-deletion { color: var(--diff-removed, #e06c75); }
  .hljs-addition { color: var(--diff-added, #98c379); }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 600; }
</style>
<div class="hdr"><span class="path">${escapeHtml(path)}</span><span>${meta}</span></div>
<div class="code">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// File discovery (for autocomplete)
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
        if (depth > 8 || out.length > 5000) return;
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
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // The thread's working directory. `pi` (ExtensionAPI) has no `.ctx`; the cwd
    // only arrives on the handler `ctx` (ExtensionContext.cwd). Under pi-web each
    // thread loads with its own cwd (see DefaultResourceLoader({ cwd })), so we
    // must read it from a handler ctx rather than process.cwd() — otherwise the
    // path autocomplete/discovery is scoped to the pi-web server's CWD instead
    // of the directory this thread is actually in.
    let root = process.cwd();

    // Short-lived cache so the autocomplete provider doesn't re-walk per keystroke.
    let cache: { files: string[]; at: number } | null = null;

    // Point `root` at the thread's cwd, dropping the stale walk when it moves.
    const syncRoot = (cwd?: string): void => {
        if (cwd && cwd !== root) {
            root = cwd;
            cache = null;
        }
    };

    // Under plain terminal pi, `session_start` carries the cwd. Under pi-web the
    // host never emits it (it doesn't call session.bindExtensions), so the cwd
    // instead arrives on the autocomplete context and the command handler ctx —
    // both routed through syncRoot below.
    pi.on("session_start", (_event, ctx) => syncRoot(ctx?.cwd));

    const toDisplay = (path: string): string => {
        const rel = relative(root, path);
        return !rel || rel.startsWith("..") ? path : rel;
    };

    const CACHE_TTL_MS = 5000;
    const cachedDiscover = async (): Promise<string[]> => {
        if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.files;
        const files = await discover(root);
        cache = { files, at: Date.now() };
        return files;
    };

    piweb.addAutocompleteProvider(async ({ text, caret, cwd }) => {
        syncRoot(cwd); // pi-web injects the thread's cwd here
        const before = text.slice(0, caret);
        const m = before.match(/^\/cat(\s+)(.*)$/s);
        if (!m) return null;
        const query = m[2];
        const start = caret - query.length;
        const files = await cachedDiscover();
        const q = query.toLowerCase();
        const items = files
            .map(toDisplay)
            .filter((p) => !q || p.toLowerCase().includes(q))
            .sort((a, b) => {
                const ai = a.toLowerCase().indexOf(q);
                const bi = b.toLowerCase().indexOf(q);
                return ai - bi || a.length - b.length || a.localeCompare(b);
            })
            .slice(0, 20)
            .map((p) => ({ value: p, label: p, description: "file" }));
        if (!items.length) return null;
        return { start, end: caret, items };
    });

    // Render "cat-file" custom messages as a syntax-highlighted frame. Runs
    // host-side on live message_end and on replay, so highlighting is rebuilt
    // from the stored content each time (keeps details portable + serializable).
    piweb.registerMessageRenderer("cat-file", (message: any) => {
        const d = (message.details as any) || {};
        const path = typeof d.path === "string" ? d.path : "file";
        const content = typeof d.content === "string" ? d.content : "";
        if (!content) {
            return { type: "Text", text: `cat-file: ${path} is empty` };
        }
        return { type: "Frame", html: buildFrameHtml(path, content) };
    });

    // Read + validate a file for the cat view. Shared by the `/cat` command and
    // the `cat` tool. Returns the text, or a human-readable reason it can't be
    // shown (too large / unreadable / binary) plus the severity to surface.
    const readForCat = async (
        path: string,
    ): Promise<{
        disp: string;
        content?: string;
        error?: string;
        severity?: "warning" | "error";
    }> => {
        const abs = isAbsolute(path) ? path : resolve(root, path);
        const disp = toDisplay(abs);
        try {
            const size = (await stat(abs)).size;
            if (size > 2 * 1024 * 1024)
                return {
                    disp,
                    error: `${disp} is ${(size / 1024 / 1024).toFixed(1)} MB — too large to cat`,
                    severity: "warning",
                };
            const content = await readFile(abs, "utf8");
            // NUL byte ⇒ almost certainly binary; refuse rather than render garbage.
            if (content.includes("\u0000"))
                return { disp, error: `${disp} looks binary`, severity: "warning" };
            return { disp, content };
        } catch (err: any) {
            return {
                disp,
                error: `Couldn't read ${disp}: ${err?.message ?? err}`,
                severity: "error",
            };
        }
    };

    // Push a rendered cat-file frame into the transcript. Returns the display
    // path so callers can report/echo it, or undefined if nothing was emitted.
    const showFrame = (disp: string, content: string): void => {
        pi.sendMessage({
            customType: "cat-file",
            content: `cat: ${disp}`,
            display: true,
            details: { path: disp, content },
        });
    };

    const emit = async (path: string): Promise<void> => {
        const { disp, content, error, severity } = await readForCat(path);
        if (error || content == null) {
            piweb.notify(error ?? `Couldn't read ${disp}`, severity ?? "error");
            return;
        }
        if (!piweb.present) {
            piweb.notify(
                "The rich /cat view needs the web UI (pi-web).",
                "info",
            );
            return;
        }
        showFrame(disp, content);
    };

    pi.registerCommand("cat", {
        description:
            "Render a file with syntax highlighting (Tab to complete the path)",
        handler: async (args, ctx) => {
            syncRoot(ctx?.cwd); // keep path resolution scoped to this thread
            const arg = (args ?? "").trim();
            if (!arg) {
                piweb.notify(
                    "Usage: /cat <path> — start typing to autocomplete a file",
                    "info",
                );
                return;
            }
            await emit(arg);
        },
    });

    // The agent-facing counterpart to `/cat`: a tool the model can call to both
    // *show* the user a syntax-highlighted file (web UI) and *see* its contents
    // itself (returned as tool output). Prefer this over the built-in `read`
    // when the user should see the rendered file too.
    //
    // We borrow the built-in read tool's TypeBox schema for `parameters` (a
    // project extension can't resolve @sinclair/typebox directly); only `path`
    // is used here.
    pi.registerTool({
        name: "cat",
        label: "Cat File",
        description:
            "Display a text file to the user with syntax highlighting in the " +
            "transcript, and return its contents to you. Use this instead of " +
            "`read` when you also want the user to see the rendered file. " +
            "Argument: { path }.",
        parameters: createReadToolDefinition(process.cwd()).parameters,
        // Signature: execute(toolCallId, params, signal, onUpdate, ctx). The
        // schema-validated arguments arrive as the *second* parameter.
        async execute(_toolCallId: string, params: any, _signal, _onUpdate, ctx: any) {
            syncRoot(ctx?.cwd); // scope path resolution to the calling thread
            const rawPath =
                typeof params?.path === "string" ? params.path.trim() : "";
            if (!rawPath) {
                return {
                    content: [
                        { type: "text", text: "cat: missing `path` argument." },
                    ],
                    isError: true,
                };
            }
            const { disp, content, error } = await readForCat(rawPath);
            if (error || content == null) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `cat: ${error ?? `couldn't read ${disp}`}`,
                        },
                    ],
                    isError: true,
                };
            }
            // Render the frame for the user (no-ops under plain terminal pi).
            if (piweb.present) showFrame(disp, content);
            // Hand the contents back to the model as well.
            return {
                content: [{ type: "text", text: `${disp}:\n\n${content}` }],
                details: { path: disp, bytes: content.length },
                isError: false,
            };
        },
    } as any);
}
