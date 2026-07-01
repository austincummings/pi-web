/**
 * Unit tests for the ANSI-to-DOM painter (src/web/ansi.ts), the "workhorse" of
 * render-model parity: pi TUI Components expose only render(width): string[] of
 * ANSI-styled lines, so we parse that ANSI into escaped, whitelisted spans.
 * These assert the supported SGR/OSC8/APC subset (docs/render-model-parity.md
 * Appendix A) and the security guarantees (escape, style whitelist, URL sanitize).
 */
import { test, expect } from "bun:test";
import { ansiToHtml } from "../src/web/ansi.ts";

test("wraps each line in .ansi-line; empty line becomes nbsp", () => {
    const html = ansiToHtml(["a", ""]);
    expect(html).toContain('<div class="ansi-line">a</div>');
    expect(html).toContain('<div class="ansi-line">&nbsp;</div>');
    expect((html.match(/ansi-line/g) || []).length).toBe(2);
});

test("HTML-escapes text (no raw markup)", () => {
    const html = ansiToHtml(['<b>&"']);
    expect(html).toContain("&lt;b&gt;&amp;&quot;");
    expect(html).not.toContain("<b>");
});

test("16-color foreground maps to theme CSS vars", () => {
    expect(ansiToHtml(["\x1b[31mR"])).toContain("color:var(--err)");
    expect(ansiToHtml(["\x1b[32mG"])).toContain("color:var(--ok)");
    // bright green (90+ range) → index 10
    expect(ansiToHtml(["\x1b[92mG"])).toContain("color:var(--ok)");
});

test("background color + bold/italic/underline/strike", () => {
    expect(ansiToHtml(["\x1b[41mX"])).toContain("background-color:var(--err)");
    expect(ansiToHtml(["\x1b[1mB"])).toContain("font-weight:bold");
    expect(ansiToHtml(["\x1b[3mI"])).toContain("font-style:italic");
    expect(ansiToHtml(["\x1b[4mU"])).toContain("text-decoration:underline");
    expect(ansiToHtml(["\x1b[9mS"])).toContain("line-through");
});

test("256-color and truecolor resolve to rgb()", () => {
    // idx 42 → 6x6x6 cube → rgb(0,215,135)
    expect(ansiToHtml(["\x1b[38;5;42mG"])).toContain("rgb(0,215,135)");
    expect(ansiToHtml(["\x1b[38;2;10;20;30mT"])).toContain("rgb(10,20,30)");
});

test("inverse video swaps fg/bg (theme defaults)", () => {
    const html = ansiToHtml(["\x1b[7mX\x1b[27m"]);
    expect(html).toContain("color:var(--bg)");
    expect(html).toContain("background-color:var(--txt)");
});

test("SGR reset ends styling (plain text after reset is unstyled)", () => {
    const html = ansiToHtml(["\x1b[31mR\x1b[0mN"]);
    expect(html).toContain("color:var(--err)");
    // N comes after the reset → bare escaped text, not inside the red span
    expect(html).toContain("</span>N</div>");
});

test("per-line reset: styles do not carry across lines (pi contract)", () => {
    const html = ansiToHtml(["\x1b[31mred", "plain"]);
    expect(html).toContain('<div class="ansi-line">plain</div>');
});

test("OSC 8: http(s)/mailto links render <a>; other schemes are dropped", () => {
    const ok = ansiToHtml([
        "\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
    ]);
    expect(ok).toContain('<a href="https://example.com"');
    expect(ok).toContain("link");

    const bad = ansiToHtml([
        "\x1b]8;;javascript:alert(1)\x1b\\x\x1b]8;;\x1b\\",
    ]);
    expect(bad).not.toContain("<a ");
    expect(bad).not.toContain("javascript:");
    expect(bad).toContain("x");
});

test("APC / CURSOR_MARKER and unknown CSI are stripped", () => {
    // APC (zero-width cursor marker): ESC _ ... ST
    const apc = ansiToHtml(["\x1b_Gcursor\x1b\\hello"]);
    expect(apc).toContain("hello");
    expect(apc).not.toContain("cursor");
    // cursor motion / clear-screen CSI: stripped, text survives
    const csi = ansiToHtml(["\x1b[2J\x1b[Hclean"]);
    expect(csi).toContain("clean");
    expect(csi).not.toContain("[2J");
});
