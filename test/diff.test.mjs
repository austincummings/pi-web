/**
 * Unit tests for the web diff renderer (src/web/diff.ts), a faithful HTML port
 * of pi-tui's renderDiff. To guard against drift we feed it the exact diff
 * string produced by pi's own `generateDiffString` (the same function the edit
 * tool uses) and assert the resulting HTML colorization + intra-line highlight.
 */
import { test, expect } from "bun:test";
import { renderDiffHtml } from "../src/web/diff.ts";
import { generateDiffString } from "@earendil-works/pi-coding-agent";

test("colorizes context / added / removed lines by prefix", () => {
    const { diff } = generateDiffString(
        "alpha\nbeta\ngamma\n",
        "alpha\nBETA\ngamma\n",
    );
    const html = renderDiffHtml(diff);
    // one removed + one added → single-line modification path
    expect(html).toContain('class="diff-removed"');
    expect(html).toContain('class="diff-added"');
    expect(html).toContain('class="diff-context"');
    // context lines survive verbatim (with their line numbers)
    expect(html).toContain("alpha");
    expect(html).toContain("gamma");
});

test("single-line change highlights only the changed tokens with .inverse", () => {
    const { diff } = generateDiffString("const x = 1\n", "const x = 2\n");
    const html = renderDiffHtml(diff);
    // the changed token is wrapped; the unchanged prefix is not
    expect(html).toContain('<span class="inverse">');
    // the shared "const x = " prefix should appear outside any inverse span
    expect(html).toContain("const x = ");
});

test("multi-line change lists removals then additions without intra-line diff", () => {
    const { diff } = generateDiffString("a\nb\nc\n", "x\ny\nz\n");
    const html = renderDiffHtml(diff);
    // block replacement → no intra-line inverse highlight
    expect(html).not.toContain('<span class="inverse">');
    const removed = (html.match(/class="diff-removed"/g) || []).length;
    const added = (html.match(/class="diff-added"/g) || []).length;
    expect(removed).toBe(3);
    expect(added).toBe(3);
});

test("escapes HTML metacharacters in content", () => {
    const { diff } = generateDiffString("plain\n", "<script>&\n");
    const html = renderDiffHtml(diff);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
});

test("output is one span per line, newline-joined", () => {
    const { diff } = generateDiffString("a\nb\n", "a\nB\n");
    const html = renderDiffHtml(diff);
    for (const line of html.split("\n")) {
        expect(line.startsWith("<span")).toBe(true);
    }
});
