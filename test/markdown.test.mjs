/**
 * Tests for the basic safe Markdown renderer.
 */
import { test, expect } from "bun:test";
import { renderMarkdown } from "../src/web/markdown.mjs";

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
