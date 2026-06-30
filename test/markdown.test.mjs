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
    expect(renderMarkdown("```\na<b\n```")).toContain(
        "<pre><code>a&lt;b</code></pre>",
    );
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
