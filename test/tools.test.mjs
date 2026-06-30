/**
 * Unit tests for the tool-call rendering helpers (src/web/tools.ts):
 * argument summarisation, line-based truncation, and the renderer registry.
 */
import { test, expect } from "bun:test";
import {
    summarizeArgs,
    toolTitle,
    relativizePath,
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

test("truncateResult keeps the tail (last lines), like the TUI", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i}`);
    const { shown, hidden } = truncateResult(lines.join("\n"), false);
    const shownLines = shown.split("\n");
    expect(shownLines).toHaveLength(MAX_TOOL_LINES);
    expect(shownLines[shownLines.length - 1]).toBe("L19");
    expect(shownLines[0]).toBe(`L${20 - MAX_TOOL_LINES}`);
    expect(hidden).toBe(20 - MAX_TOOL_LINES);
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

test("toolTitle renders bash as `$ <command>` (no bash word), like the TUI", () => {
    expect(toolTitle("bash", { command: "ls -la" })).toEqual({
        name: "$",
        args: "ls -la",
        dim: "",
    });
    expect(toolTitle("shell", { cmd: "pwd" })).toEqual({
        name: "$",
        args: "pwd",
        dim: "",
    });
});

test("toolTitle keeps the tool name + primary arg for non-bash tools", () => {
    expect(toolTitle("read", { path: "src/x.ts" })).toEqual({
        name: "read",
        args: "src/x.ts",
        dim: "",
    });
});

test("toolTitle appends a read line range, like the TUI", () => {
    expect(toolTitle("read", { path: "a.ts", offset: 10, limit: 20 })).toEqual({
        name: "read",
        args: "a.ts",
        dim: ":10-29",
    });
    expect(toolTitle("read", { path: "a.ts", offset: 5 })).toEqual({
        name: "read",
        args: "a.ts",
        dim: ":5",
    });
});

test("toolTitle shows grep/find pattern accented with a muted context suffix", () => {
    expect(
        toolTitle("grep", { pattern: "foo", path: "src", glob: "*.ts" }),
    ).toEqual({ name: "grep", args: "/foo/", dim: " in src (*.ts)" });
    expect(toolTitle("find", { pattern: "*.md", limit: 5 })).toEqual({
        name: "find",
        args: "*.md",
        dim: " in . limit 5",
    });
});

test("relativizePath strips the cwd prefix, leaving outside paths alone", () => {
    expect(relativizePath("/home/u/proj/src/x.ts", "/home/u/proj")).toBe(
        "src/x.ts",
    );
    expect(relativizePath("/home/u/proj", "/home/u/proj")).toBe(".");
    expect(relativizePath("/etc/hosts", "/home/u/proj")).toBe("/etc/hosts");
    expect(relativizePath("/home/u/proj/x", undefined)).toBe("/home/u/proj/x");
});

test("toolTitle relativizes path args against cwd", () => {
    expect(
        toolTitle("edit", { path: "/home/u/proj/src/x.ts" }, "/home/u/proj"),
    ).toEqual({ name: "edit", args: "src/x.ts", dim: "" });
});

test("renderer registry stores and retrieves by tool name", () => {
    expect(getToolRenderer("nope")).toBeUndefined();
    const fn = () => null;
    registerToolRenderer("my_tool", fn);
    expect(getToolRenderer("my_tool")).toBe(fn);
});
