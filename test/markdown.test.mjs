/**
 * Tests for the basic safe Markdown renderer.
 */
import { test, expect } from "bun:test";
import { renderMarkdown } from "../src/web/markdown.ts";

test("escapes HTML (no injection)", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
});

test("bold and italic", () => {
    expect(renderMarkdown("**hi**")).toContain("<strong>hi</strong>");
    expect(renderMarkdown("*hi*")).toContain("<em>hi</em>");
});

test("inline and fenced code", () => {
    expect(renderMarkdown("use `x` here")).toContain("<code>x</code>");
    // A fence with no language is plain escaped text inside a .hljs code block.
    expect(renderMarkdown("```\na<b\n```")).toContain(
        '<pre><code class="hljs">a&lt;b</code></pre>',
    );
});

test("highlights a fenced block with a known language", () => {
    const out = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(out).toContain('<pre><code class="hljs language-ts">');
    expect(out).toContain("hljs-keyword"); // `const`
    // the source text survives highlighting
    expect(out.replace(/<[^>]+>/g, "")).toContain("const x = 1;");
});

test("unknown language falls back to plain escaped code", () => {
    const out = renderMarkdown("```notalang\nplain <b>\n```");
    expect(out).toContain('<pre><code class="hljs language-notalang">');
    expect(out).not.toContain("hljs-" + "keyword");
    expect(out).toContain("plain &lt;b&gt;");
});

test("highlighted code is escaped exactly once (no double-escape)", () => {
    const out = renderMarkdown("```ts\nconst s = a && b > c;\n```");
    // Correct single-escaping: `&`→`&amp;`, `>`→`&gt;`.
    expect(out).toContain("&amp;&amp;");
    expect(out).toContain("&gt;");
    // Double-escaping would produce these; they must be absent.
    expect(out).not.toContain("&amp;amp;");
    expect(out).not.toContain("&amp;gt;");
});

test("unterminated (streaming) fence renders plain, not highlighted", () => {
    const out = renderMarkdown("```ts\nconst x = 1;");
    expect(out).toContain("<pre><code");
    expect(out).not.toContain("hljs-keyword");
    expect(out.replace(/<[^>]+>/g, "")).toContain("const x = 1;");
});

test("headings and lists", () => {
    expect(renderMarkdown("# Title")).toContain("<h1>Title</h1>");
    const ul = renderMarkdown("- a\n- b");
    expect(ul).toContain("<ul>");
    expect((ul.match(/<li>/g) || []).length).toBe(2);
});

test("links are sanitized", () => {
    expect(renderMarkdown("[x](https://a.com)")).toContain(
        'href="https://a.com"',
    );
    expect(renderMarkdown("[x](javascript:alert(1))")).toContain('href="#"');
});

test("renders a basic table", () => {
    const out = renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<thead>");
    expect((out.match(/<th[ >]/g) || []).length).toBe(2);
    expect((out.match(/<td[ >]/g) || []).length).toBe(2);
    expect(out).toContain('<div class="table-wrap">');
});

test("table column alignment", () => {
    const out = renderMarkdown(
        "| l | c | r |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |",
    );
    expect(out).toContain("text-align:center");
    expect(out).toContain("text-align:right");
});

test("inline formatting inside table cells", () => {
    const out = renderMarkdown("| h |\n| --- |\n| **bold** |");
    expect(out).toContain("<strong>bold</strong>");
});

test("table cells are escaped (no injection)", () => {
    const out = renderMarkdown("| h |\n| --- |\n| <img> |");
    expect(out).toContain("&lt;img&gt;");
    expect(out).not.toContain("<img>");
});

test("a lone pipe in prose stays a paragraph", () => {
    const out = renderMarkdown("this | that\nand more");
    expect(out).toContain("<p>");
    expect(out).not.toContain("<table>");
});

// ---- highlightComposer: layout-preserving composer backdrop tints ----
import { highlightComposer } from "../src/web/markdown.ts";

test("highlightComposer preserves every source character", () => {
    // Stripping the <span> wrappers must yield the escaped input verbatim
    // (plus the trailing filler newline), else the caret would misalign.
    const src = "# hi **b** *i* `c` @f > q - x";
    const bare = highlightComposer(src)
        .replace(/<[^>]+>/g, "")
        .replace(/\n$/, "")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&");
    expect(bare).toBe(src);
});

test("highlightComposer tints markdown tokens", () => {
    expect(highlightComposer("**b**")).toContain('class="md-strong">**b**');
    expect(highlightComposer("*i*")).toContain('class="md-em">*i*');
    expect(highlightComposer("`c`")).toContain('class="md-code">`c`');
    expect(highlightComposer("# h")).toContain('class="md-h">#');
    expect(highlightComposer("- item")).toContain('class="md-marker">-');
    expect(highlightComposer("say @file.ts")).toContain(
        'class="md-mention">@file.ts',
    );
    expect(highlightComposer("> q")).toContain('class="md-quote">&gt;');
    expect(highlightComposer("[t](https://x.com)")).toContain(
        'class="md-link">[t](https://x.com)',
    );
});

test("highlightComposer flags shell/command only at the start", () => {
    expect(highlightComposer("!ls")).toContain('class="md-cmd">!');
    expect(highlightComposer("/model")).toContain('class="md-cmd">/model');
    // Not on later lines.
    expect(highlightComposer("hi\n/model")).not.toContain("md-cmd");
});

test("highlightComposer escapes HTML (no injection)", () => {
    const out = highlightComposer("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
});

test("highlightComposer does not misfire on bare numbers", () => {
    // Placeholder restore must not swallow digits surrounded by spaces.
    expect(highlightComposer("a 5 b 7 c")).toContain("a 5 b 7 c");
});

test("highlightComposer leaves markdown untouched inside a code fence", () => {
    const out = highlightComposer("```\n*no* **md**\n```");
    expect(out).not.toContain("md-em");
    expect(out).not.toContain("md-strong");
});
