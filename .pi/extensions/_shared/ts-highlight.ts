/**
 * ts-highlight — tree-sitter syntax highlighting for the pi-web extensions,
 * a drop-in replacement for the highlight.js path they used before.
 *
 * Design notes
 *   • Runs host-side under Bun. `web-tree-sitter` (WASM) + prebuilt grammar
 *     wasm from `tree-sitter-wasms` are resolved straight out of node_modules —
 *     exactly how the extensions resolved `highlight.js` before, so no bundling
 *     or `bun build --compile` embedding is needed.
 *   • tree-sitter init + grammar load are async, but the pi-web message
 *     renderers are *sync* (and re-run on replay). So callers `warm()` the
 *     grammar set up front and the highlight functions stay synchronous: if a
 *     grammar isn't loaded yet the text is emitted as plain (escaped) HTML and
 *     colored correctly on the next render.
 *   • Output uses `hljs-*` class names so the extensions' existing CSS
 *     (`.hljs-*` → theme `--syn-*`) is reused verbatim.
 */
import Parser from "web-tree-sitter";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import {
    BASH_QUERY,
    CPP_QUERY,
    C_QUERY,
    CSS_QUERY,
    GO_QUERY,
    HTML_QUERY,
    JSON_QUERY,
    PYTHON_QUERY,
    RUST_QUERY,
    TS_QUERY,
} from "./highlight-queries.ts";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Grammar registry
// ---------------------------------------------------------------------------

// Language key → { wasm module in tree-sitter-wasms, highlights query }.
// ts/tsx/js/jsx all use the `tsx` grammar (a superset) + the one TS query.
interface Grammar {
    wasm: string; // tree-sitter-wasms/out/tree-sitter-<wasm>.wasm
    query: string;
}
const GRAMMARS: Record<string, Grammar> = {
    typescript: { wasm: "tsx", query: TS_QUERY },
    tsx: { wasm: "tsx", query: TS_QUERY },
    javascript: { wasm: "tsx", query: TS_QUERY },
    jsx: { wasm: "tsx", query: TS_QUERY },
    python: { wasm: "python", query: PYTHON_QUERY },
    rust: { wasm: "rust", query: RUST_QUERY },
    go: { wasm: "go", query: GO_QUERY },
    json: { wasm: "json", query: JSON_QUERY },
    bash: { wasm: "bash", query: BASH_QUERY },
    css: { wasm: "css", query: CSS_QUERY },
    html: { wasm: "html", query: HTML_QUERY },
    // NOTE: yaml intentionally omitted — its prebuilt wasm external scanner
    // references a symbol web-tree-sitter@0.24.7 doesn't provide, so parse()
    // throws. Falls back to plain text via EXT_LANG omission below.
    c: { wasm: "c", query: C_QUERY },
    cpp: { wasm: "cpp", query: CPP_QUERY },
};

// The core set warmed at extension start.
export const CORE_LANGS = Object.keys(GRAMMARS);

// Extension → language key. Only the mapping the extensions need; unknown
// extensions fall through to plain text (tree-sitter has no auto-detection).
export const EXT_LANG: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    mts: "typescript",
    cts: "typescript",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    pyi: "python",
    rs: "rust",
    go: "go",
    json: "json",
    jsonc: "json",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    css: "css",
    scss: "css",
    html: "html",
    htm: "html",
    xml: "html",
    svg: "html",
    vue: "html",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    hh: "cpp",
    hxx: "cpp",
};

/** Resolve a file path to a grammar key, or "" for plain text. */
export function resolveLangKey(path: string): string {
    const name = basename(path).toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop()! : "";
    return EXT_LANG[ext] ?? "";
}

/** Human label for the cat-file header. */
export function langLabel(key: string): string {
    return key || "plain text";
}

// ---------------------------------------------------------------------------
// Async init / warm
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;
function init(): Promise<void> {
    if (!initPromise) {
        const coreWasm = require.resolve("web-tree-sitter/tree-sitter.wasm");
        initPromise = Parser.init({ locateFile: () => coreWasm });
    }
    return initPromise;
}

const wasmCache = new Map<string, Promise<Parser.Language>>();
function loadWasm(name: string): Promise<Parser.Language> {
    let p = wasmCache.get(name);
    if (!p) {
        const file = require.resolve(
            `tree-sitter-wasms/out/tree-sitter-${name}.wasm`,
        );
        p = Parser.Language.load(new Uint8Array(readFileSync(file)));
        wasmCache.set(name, p);
    }
    return p;
}

interface Ready {
    lang: Parser.Language;
    query: Parser.Query;
}
const ready = new Map<string, Ready>();

/** Load + compile a single language's grammar and query (idempotent). */
export async function ensureLang(key: string): Promise<void> {
    if (ready.has(key)) return;
    const g = GRAMMARS[key];
    if (!g) return;
    await init();
    const lang = await loadWasm(g.wasm);
    ready.set(key, { lang, query: lang.query(g.query) });
}

/** Pre-load a set of languages (defaults to the core set). */
export async function warm(keys: string[] = CORE_LANGS): Promise<void> {
    await Promise.all(keys.map(ensureLang));
}

export function isReady(key: string): boolean {
    return ready.has(key);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// tree-sitter capture name → hljs class(es). Keyed by the full dotted name with
// a fallback to the first segment (so `function.method` → `function` if absent).
const CLASS: Record<string, string> = {
    comment: "hljs-comment",
    string: "hljs-string",
    number: "hljs-number",
    constant: "hljs-variable",
    "constant.builtin": "hljs-literal",
    keyword: "hljs-keyword",
    operator: "hljs-operator",
    function: "hljs-title function_",
    "function.call": "hljs-title function_",
    "function.method": "hljs-title function_",
    "function.builtin": "hljs-title function_",
    constructor: "hljs-title class_",
    type: "hljs-type",
    "type.builtin": "hljs-type",
    property: "hljs-property",
    variable: "hljs-variable",
    "variable.parameter": "hljs-params",
    attribute: "hljs-attr",
    tag: "hljs-name",
    namespace: "hljs-type",
    label: "hljs-symbol",
    punctuation: "hljs-punctuation",
};
function classFor(name: string): string {
    return CLASS[name] ?? CLASS[name.split(".")[0]!] ?? "";
}

interface Span {
    start: number;
    end: number;
    name: string;
    idx: number;
}

/**
 * Turn a source string + its captures into HTML with nested `<span>`s. Captures
 * from a tree query are always disjoint or properly nested (they sit on tree
 * nodes), so a simple open/close stack is sufficient. For two captures on the
 * exact same range the first (by query order) wins, matching tree-sitter's
 * "first pattern wins" convention.
 */
function renderHtml(code: string, spans: Span[]): string {
    spans.sort((a, b) => a.start - b.start || b.end - a.end || a.idx - b.idx);

    let out = "";
    let pos = 0;
    const stack: number[] = []; // end offsets of currently open spans

    const closeThrough = (limit: number): void => {
        while (stack.length && stack[stack.length - 1]! <= limit) {
            const end = stack.pop()!;
            out += escapeHtml(code.slice(pos, end));
            pos = end;
            out += "</span>";
        }
    };

    let prevStart = -1;
    let prevEnd = -1;
    for (const s of spans) {
        if (s.end <= s.start) continue;
        if (s.start === prevStart && s.end === prevEnd) continue; // dup range
        const cls = classFor(s.name);
        if (!cls) continue;
        prevStart = s.start;
        prevEnd = s.end;

        closeThrough(s.start);
        if (pos < s.start) {
            out += escapeHtml(code.slice(pos, s.start));
            pos = s.start;
        }
        out += `<span class="${cls}">`;
        stack.push(s.end);
    }
    closeThrough(code.length);
    if (pos < code.length) out += escapeHtml(code.slice(pos));
    return out;
}

// One reusable parser (single-threaded host, sync parse).
let parser: Parser | null = null;
function getParser(): Parser {
    if (!parser) parser = new Parser();
    return parser;
}

/**
 * Split highlighted HTML into individual lines while keeping `<span>` nesting
 * balanced per line — a span that crosses a newline is closed at the line end
 * and reopened on the next, so each line is valid standalone HTML.
 */
export function splitHighlightedLines(html: string): string[] {
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

/** Highlight `content` as `key`, returning per-line balanced HTML. Sync: if the
 *  grammar isn't loaded yet, returns escaped plain-text lines. */
export function highlightToLines(key: string, content: string): string[] {
    const r = key ? ready.get(key) : undefined;
    if (!r) return splitHighlightedLines(escapeHtml(content));

    // Some prebuilt grammar wasm can throw at parse time (e.g. an external
    // scanner referencing a symbol this runtime doesn't provide). Never let
    // that crash the frame renderer — degrade to plain (escaped) text.
    try {
        const p = getParser();
        p.setLanguage(r.lang);
        const tree = p.parse(content);
        const caps = r.query.captures(tree.rootNode);
        const spans: Span[] = caps.map((c, i) => ({
            start: c.node.startIndex,
            end: c.node.endIndex,
            name: c.name,
            idx: i,
        }));
        const html = renderHtml(content, spans);
        tree.delete();
        return splitHighlightedLines(html);
    } catch {
        return splitHighlightedLines(escapeHtml(content));
    }
}

/** Path-based convenience mirroring the old multibuffer `highlightLines`. */
export function highlightLines(path: string, content: string): string[] {
    return highlightToLines(resolveLangKey(path), content);
}
