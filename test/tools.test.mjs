/**
 * Unit tests for the tool-call rendering helpers (src/web/tools.ts):
 * argument summarisation, line-based truncation, and the renderer registry.
 */
import { test, expect } from "bun:test";
import {
    summarizeArgs,
    truncateResult,
    registerToolRenderer,
    getToolRenderer,
    MAX_TOOL_LINES,
} from "../src/web/tools.ts";

test("summarizeArgs surfaces the meaningful field for common tools", () => {
    expect(summarizeArgs({ command: "ls -la" })).toBe("ls -la");
    expect(summarizeArgs({ path: "/etc/hosts" })).toBe("/etc/hosts");
    expect(summarizeArgs({ file_path: "a.ts" })).toBe("a.ts");
    expect(summarizeArgs({ pattern: "TODO" })).toBe("TODO");
    expect(summarizeArgs({ query: "router" })).toBe("router");
});

test("summarizeArgs falls back to compact JSON, capped in length", () => {
    expect(summarizeArgs({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
    const big = summarizeArgs({ blob: "x".repeat(400) });
    expect(big.length).toBeLessThanOrEqual(140);
    expect(big.endsWith("…")).toBe(true);
});

test("summarizeArgs handles null / non-object", () => {
    expect(summarizeArgs(null)).toBe("");
    expect(summarizeArgs(undefined)).toBe("");
    expect(summarizeArgs("nope")).toBe("");
});

test("truncateResult keeps short output intact", () => {
    const text = "line1\nline2\nline3";
    expect(truncateResult(text, false)).toEqual({ shown: text, hidden: 0 });
});

test("truncateResult collapses to MAX_TOOL_LINES with a hidden count", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
    const { shown, hidden } = truncateResult(lines.join("\n"), false);
    expect(shown.split("\n")).toHaveLength(MAX_TOOL_LINES);
    expect(hidden).toBe(20 - MAX_TOOL_LINES);
});

test("truncateResult expanded shows everything", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n");
    const { shown, hidden } = truncateResult(lines, true);
    expect(shown).toBe(lines);
    expect(hidden).toBe(0);
});

test("truncateResult trims trailing whitespace before counting", () => {
    const text = "a\nb\n\n\n   ";
    expect(truncateResult(text, false)).toEqual({ shown: "a\nb", hidden: 0 });
});

test("renderer registry stores and retrieves by tool name", () => {
    expect(getToolRenderer("nope")).toBeUndefined();
    const fn = () => null;
    registerToolRenderer("my_tool", fn);
    expect(getToolRenderer("my_tool")).toBe(fn);
});
