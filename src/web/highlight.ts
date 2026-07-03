/**
 * Fenced-code syntax highlighting for the transcript, mirroring the pi TUI.
 *
 * The pi TUI highlights markdown code blocks with highlight.js
 * (`dist/utils/syntax-highlight.js` → `theme.js` `highlightCode`). We do the
 * same in the browser so the web transcript matches: hljs emits `hljs-*`
 * classes, which `index.html` maps to the theme's `--syn-*` palette — the same
 * class→palette convention the project's tree-sitter extensions already use
 * (`~/.pi/agent/extensions/_shared/ts-highlight.ts`), so a transcript code block and an
 * extension-rendered one look identical.
 *
 * We use `highlight.js/lib/core` + an explicit language set (pi's
 * `getLanguageFromPath` languages) rather than the full build, to keep the
 * front-end bundle lean. hljs registers each module's own aliases (`ts`, `py`,
 * …), so those resolve without a table here.
 */
import hljs from "highlight.js/lib/core";

import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import php from "highlight.js/lib/languages/php";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import sql from "highlight.js/lib/languages/sql";
import xml from "highlight.js/lib/languages/xml";
import css from "highlight.js/lib/languages/css";
import scss from "highlight.js/lib/languages/scss";
import less from "highlight.js/lib/languages/less";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import markdown from "highlight.js/lib/languages/markdown";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import makefile from "highlight.js/lib/languages/makefile";
import cmake from "highlight.js/lib/languages/cmake";
import lua from "highlight.js/lib/languages/lua";
import perl from "highlight.js/lib/languages/perl";
import r from "highlight.js/lib/languages/r";
import scala from "highlight.js/lib/languages/scala";
import clojure from "highlight.js/lib/languages/clojure";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import haskell from "highlight.js/lib/languages/haskell";
import ocaml from "highlight.js/lib/languages/ocaml";
import vim from "highlight.js/lib/languages/vim";
import protobuf from "highlight.js/lib/languages/protobuf";
import shell from "highlight.js/lib/languages/shell";
import plaintext from "highlight.js/lib/languages/plaintext";

// Register once at module load. hljs pulls in each module's declared aliases
// (typescript→ts, javascript→js/jsx/mjs, python→py, yaml→yml, bash→sh, …).
const LANGUAGES: Record<string, any> = {
    typescript,
    javascript,
    python,
    ruby,
    rust,
    go,
    java,
    kotlin,
    swift,
    c,
    cpp,
    csharp,
    php,
    bash,
    powershell,
    sql,
    xml,
    css,
    scss,
    less,
    json,
    yaml,
    ini,
    markdown,
    dockerfile,
    makefile,
    cmake,
    lua,
    perl,
    r,
    scala,
    clojure,
    elixir,
    erlang,
    haskell,
    ocaml,
    vim,
    protobuf,
    shell,
    plaintext,
};
for (const [name, def] of Object.entries(LANGUAGES)) {
    hljs.registerLanguage(name, def);
}

// A few fence-tag aliases hljs doesn't declare itself. `html` maps to the `xml`
// grammar (hljs has no separate html language); `text`/`txt` to plaintext.
const ALIASES: Record<string, string> = {
    html: "xml",
    htm: "xml",
    text: "plaintext",
    txt: "plaintext",
    yml: "yaml",
    shell: "shell",
};

function escapeHtml(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Bounded memo cache: the throttled per-frame transcript re-render re-highlights
// every closed code block each animation frame, so memoizing by (lang, code)
// keeps a streaming turn from re-tokenizing unchanged blocks repeatedly.
const cache = new Map<string, string>();
const CACHE_MAX = 500;

/**
 * Highlight a fenced code block to HTML with `hljs-*` class spans. Mirrors the
 * pi TUI's `highlightCode`: only highlights when the fence names a language hljs
 * supports (no `highlightAuto`, which the TUI avoids because it misidentifies
 * prose); otherwise returns HTML-escaped plain text. hljs escapes the code it
 * emits, so the output is safe to inject.
 */
export function highlightCode(code: string, lang: string): string {
    const resolved = (lang || "").toLowerCase();
    const name = ALIASES[resolved] || resolved;
    if (!name || !hljs.getLanguage(name)) return escapeHtml(code);

    const key = name + "\u0000" + code;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let out: string;
    try {
        out = hljs.highlight(code, {
            language: name,
            ignoreIllegals: true,
        }).value;
    } catch {
        out = escapeHtml(code);
    }

    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, out);
    return out;
}
