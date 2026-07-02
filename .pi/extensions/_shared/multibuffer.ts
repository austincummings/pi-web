/**
 * _shared/multibuffer — the Zed-style read-only multibuffer presentation layer
 * shared by the `/grep` (grep-file) and `/semgrep` extensions.
 *
 * It owns everything about *showing* a set of file excerpts: syntax
 * highlighting (highlight.js), splitting highlighted output into balanced
 * per-line HTML, overlaying <mark> spans onto match columns, carving excerpts
 * (match ± context) with expandable folds for the gaps, and the frame's own
 * CSS + client-side JS. Search / discovery logic lives in each extension.
 *
 * The output is a single self-contained HTML string meant for a `{ type:"Frame" }`
 * custom message: the sandboxed <pi-frame> inherits the theme `--syn-*` palette
 * and runs the frame's JS (allow-scripts) so folds expand client-side with no
 * host round-trip.
 */
import hljs from "highlight.js";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Highlighting
// ---------------------------------------------------------------------------

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

export function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Highlight a whole file, returning one HTML string per line (spans balanced). */
export function highlightLines(path: string, content: string): string[] {
    const name = basename(path).toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop()! : "";
    const lang = EXT_LANG[ext] ?? (ext && hljs.getLanguage(ext) ? ext : "");
    const html =
        lang && hljs.getLanguage(lang)
            ? hljs.highlight(content, { language: lang, ignoreIllegals: true })
                  .value
            : escapeHtml(content);
    return splitHighlightedLines(html);
}

/** Split highlight.js output into per-line HTML, keeping spans balanced. */
function splitHighlightedLines(html: string): string[] {
    const lines: string[] = [];
    const open: string[] = [];
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

/**
 * Overlay <mark> tags onto an already-highlighted line at the given visible
 * column ranges [start, end). Marks never cross a tag boundary — they close
 * before any tag and reopen after — so span nesting stays valid. Each HTML
 * entity (&lt; &amp; …) counts as one visible column, matching raw offsets.
 */
export function applyMarks(html: string, ranges: [number, number][]): string {
    if (!ranges.length) return html;
    const inRange = (c: number) => ranges.some(([s, e]) => c >= s && c < e);
    const re = /<\/?[^>]+>|&[a-zA-Z]+;|&#\d+;|[\s\S]/g;
    let col = 0;
    let out = "";
    let marked = false;
    const setMark = (want: boolean) => {
        if (want && !marked) {
            out += "<mark>";
            marked = true;
        } else if (!want && marked) {
            out += "</mark>";
            marked = false;
        }
    };
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
        const tok = m[0];
        if (tok[0] === "<") {
            setMark(false);
            out += tok;
        } else {
            setMark(inRange(col));
            out += tok;
            col++;
        }
    }
    setMark(false);
    return out;
}

// ---------------------------------------------------------------------------
// Excerpt model
// ---------------------------------------------------------------------------

export const CONTEXT = 2; // lines of context on each side of a match
export const EXPAND_STEP = 10; // lines revealed per Zed-style expander click

export interface LineMatch {
    line: number; // 0-based line index
    ranges: [number, number][]; // match column ranges within the line
}
export interface FileHits {
    path: string; // display path
    lines: string[]; // highlighted lines
    matches: LineMatch[];
}

/** Merge [line-CTX, line+CTX] windows around each match into excerpt ranges. */
function toExcerpts(matches: LineMatch[], total: number): [number, number][] {
    const out: [number, number][] = [];
    for (const { line } of matches) {
        const s = Math.max(0, line - CONTEXT);
        const e = Math.min(total - 1, line + CONTEXT);
        const last = out[out.length - 1];
        if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
        else out.push([s, e]);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function lineRow(no: number, srcHtml: string, isMatch: boolean): string {
    return (
        `<div class="ln${isMatch ? " match" : ""}">` +
        `<span class="no">${no}</span>` +
        `<span class="src">${srcHtml || " "}</span></div>`
    );
}

/** Render one file's excerpts, with expandable folds for the gaps. */
function fileSection(f: FileHits): string {
    const N = f.lines.length;
    const markMap = new Map<number, [number, number][]>();
    let matchCount = 0;
    for (const m of f.matches) {
        markMap.set(m.line, m.ranges);
        matchCount += m.ranges.length || 1;
    }
    const excerpts = toExcerpts(f.matches, N);

    const render = (i: number) =>
        lineRow(
            i + 1,
            applyMarks(f.lines[i], markMap.get(i) ?? []),
            markMap.has(i),
        );

    // Zed-style gutter expanders: the hidden gap lines are staged (pre-
    // highlighted) inside `.gsrc`; clicking the gutter ↓ (grow the excerpt above
    // downward → reveals into `.gtop`) or ↑ (grow the excerpt below upward →
    // reveals into `.gbot`) just moves DOM nodes — no re-highlight, no round-trip.
    // `down`/`up` flags omit the arrow that has no adjacent excerpt (file ends).
    const fold = (from: number, to: number, down: boolean, up: boolean) => {
        const rows: string[] = [];
        for (let i = from; i <= to; i++) rows.push(render(i));
        const arrow = (cls: string, glyph: string, title: string) =>
            `<div class="grow ${cls}" title="${title}">` +
            `<span class="no">${glyph}</span><span class="gline"></span></div>`;
        return (
            `<div class="gap" data-step="${EXPAND_STEP}">` +
            `<div class="gtop"></div>` +
            (down
                ? arrow("down", "↓", `Expand ${EXPAND_STEP} lines down`)
                : "") +
            `<div class="gsrc" hidden>${rows.join("")}</div>` +
            (up ? arrow("up", "↑", `Expand ${EXPAND_STEP} lines up`) : "") +
            `<div class="gbot"></div>` +
            `</div>`
        );
    };

    const parts: string[] = [];
    let pos = 0;
    for (const [s, e] of excerpts) {
        // leading gap has no excerpt above (down=false); middle gaps have both.
        if (s > pos) parts.push(fold(pos, s - 1, pos > 0, true));
        const rows: string[] = [];
        for (let i = s; i <= e; i++) rows.push(render(i));
        parts.push(`<div class="lines">${rows.join("")}</div>`);
        pos = e + 1;
    }
    // trailing gap has no excerpt below (up=false).
    if (pos < N) parts.push(fold(pos, N - 1, true, false));

    const slash = f.path.lastIndexOf("/");
    const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
    const base = slash >= 0 ? f.path.slice(slash + 1) : f.path;
    return (
        `<section class="file">` +
        `<div class="fhdr"><span class="tw">▾</span>` +
        `<span class="chk"></span>` +
        `<span class="fname">${escapeHtml(base)}</span>` +
        `<span class="fdir">${escapeHtml(dir)}</span>` +
        `<span class="cnt">${matchCount} match${matchCount === 1 ? "" : "es"}</span></div>` +
        `<div class="body">${parts.join("")}</div>` +
        `</section>`
    );
}

const STYLE = `
<style>
  body { margin: 0;
         background: var(--bg, #0c1117);
         color: var(--txt, #ddd);
         font: 14px/1.6 ui-monospace, Menlo, monospace; }
  .summary { padding: 6px 12px; color: var(--muted);
             background: var(--panel); border-bottom: 1px solid var(--line); }
  .summary b { color: var(--txt); font-weight: 600; }
  .summary .q { color: var(--acc); font-style: italic; }
  .file { border-bottom: 1px solid var(--line, #333); }
  .fhdr { display: flex; gap: 8px; align-items: center; cursor: pointer;
          padding: 4px 12px; position: sticky; top: 0; z-index: 1;
          background: var(--panel, #1a1a1a);
          border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .fhdr:hover { background: var(--hover, rgba(255,255,255,.04)); }
  .fhdr .tw { width: 1ch; color: var(--muted); user-select: none; }
  .fhdr .chk { width: 12px; height: 12px; border: 1px solid var(--line);
               border-radius: 3px; flex: none; }
  .fhdr .fname { color: var(--txt); font-weight: 600; }
  .fhdr .fdir { color: var(--dim, #667); flex: 1; }
  .fhdr .cnt { color: var(--muted); }
  .ln { display: flex; white-space: pre; }
  .ln:hover { background: var(--hover, rgba(255,255,255,.04)); }
  .no { flex: none; width: 4ch; padding: 0 12px 0 8px; text-align: right;
        color: var(--dim, #666); user-select: none; -webkit-user-select: none;
        border-right: 1px solid var(--line); }
  .src { flex: 1; padding: 0 12px; }
  mark { background: var(--acc, #6cf); color: var(--bg, #000);
         border-radius: 2px; padding: 0 1px; }
  .grow { display: flex; align-items: center; cursor: pointer; height: 1.4em;
          user-select: none; color: var(--dim, #666); }
  .grow:hover { background: var(--hover, rgba(255,255,255,.05)); }
  .grow .no { border-right: 1px solid var(--line);
              font-size: 1.25em; line-height: 1; }
  .grow:hover .no { color: var(--acc); }
  .grow .gline { flex: 1; height: 0;
                 border-top: 1px dashed var(--line); margin: 0 12px; opacity: .6; }
  .gtop:empty, .gbot:empty { display: none; }

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
  .hljs-meta { color: var(--syn-comment); }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 600; }
</style>`;

const SCRIPT = `
<script>(function(){
  function update(gap){
    var src=gap.querySelector('.gsrc');
    if(src && src.children.length<=0){
      var arrows=gap.querySelectorAll('.grow');
      for(var i=0;i<arrows.length;i++) arrows[i].style.display='none';
    }
  }
  function up(gap){ // ↑ grow the excerpt below upward: reveal from bottom of gap
    var src=gap.querySelector('.gsrc'), bot=gap.querySelector('.gbot');
    var step=+gap.getAttribute('data-step')||10;
    for(var i=0;i<step&&src.lastChild;i++) bot.insertBefore(src.lastChild, bot.firstChild);
    update(gap);
  }
  function down(gap){ // ↓ grow the excerpt above downward: reveal from top of gap
    var src=gap.querySelector('.gsrc'), top=gap.querySelector('.gtop');
    var step=+gap.getAttribute('data-step')||10;
    for(var i=0;i<step&&src.firstChild;i++) top.appendChild(src.firstChild);
    update(gap);
  }
  document.addEventListener('click', function(e){
    var t=e.target; if(!t.closest) return;
    var u=t.closest('.grow.up');   if(u){ up(u.closest('.gap')); return; }
    var d=t.closest('.grow.down'); if(d){ down(d.closest('.gap')); return; }
    var h=t.closest('.fhdr');
    if(h){
      var body=h.nextElementSibling;
      if(body){
        var hid=body.hasAttribute('hidden');
        if(hid){ body.removeAttribute('hidden'); h.classList.remove('collapsed');
                 h.querySelector('.tw').textContent='▾'; }
        else { body.setAttribute('hidden',''); h.classList.add('collapsed');
               h.querySelector('.tw').textContent='▸'; }
      }
    }
  });
})();<\/script>`;

/**
 * Compose a complete multibuffer document: theme CSS, a caller-supplied summary
 * banner (already HTML — e.g. one or more `.summary` divs), one section per
 * file, and the fold/collapse client script.
 */
export function renderMultibuffer(
    files: FileHits[],
    summaryHtml: string,
): string {
    return STYLE + summaryHtml + files.map(fileSection).join("") + SCRIPT;
}
