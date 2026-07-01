/**
 * Unit tests for the host-side pi Component → node adapter
 * (src/host/component-adapter.ts), render-model parity Parity P0: a live pi-tui
 * Component is emitted as a single AnsiBlock via its render(width) contract.
 */
import { test, expect } from "bun:test";
import {
    componentToNode,
    isComponent,
    renderToolCallToNode,
    renderToolResultToNode,
} from "../src/host/component-adapter.ts";

test("adapts a component to an AnsiBlock at the given width", () => {
    const comp = { render: (w) => ["line1", "cols=" + w] };
    const node = componentToNode(comp, 42);
    expect(node.type).toBe("AnsiBlock");
    expect(node.cols).toBe(42);
    expect(node.lines).toEqual(["line1", "cols=42"]);
});

test("defaults to 80 columns and floors fractional widths", () => {
    const comp = { render: (w) => ["w=" + w] };
    expect(componentToNode(comp).lines).toEqual(["w=80"]);
    expect(componentToNode(comp, 33.7).lines).toEqual(["w=33"]);
});

test("render() failure degrades to a one-line error block (no throw)", () => {
    const comp = {
        render() {
            throw new Error("boom");
        },
    };
    const node = componentToNode(comp);
    expect(node.type).toBe("AnsiBlock");
    expect(node.lines.length).toBe(1);
    expect(node.lines[0]).toContain("render error: boom");
});

test("marks focusable when the component takes input / has focused flag", () => {
    const plain = { render: () => ["x"] };
    const interactive = { render: () => ["x"], handleInput: () => {} };
    expect(componentToNode(plain).focusable).toBeUndefined();
    expect(componentToNode(interactive).focusable).toBe(true);
});

test("isComponent duck-types render(width)", () => {
    expect(isComponent({ render: () => [] })).toBe(true);
    expect(isComponent({})).toBe(false);
    expect(isComponent(null)).toBe(false);
});

// ---- Parity P1: tool renderResult/renderCall invocation ----

const theme = { fg: (_t, s) => s, bold: (s) => s }; // stand-in Theme

test("renderToolResultToNode invokes renderResult and adapts the component", () => {
    let seen;
    const def = {
        renderResult: (result, options, thm, ctx) => {
            seen = { result, options, thm, ctx };
            return { render: (w) => ["R:" + result.details.msg + "@" + w] };
        },
    };
    const node = renderToolResultToNode(
        def,
        {
            toolName: "demo",
            toolCallId: "tc1",
            args: { a: 1 },
            cwd: "/repo",
            expanded: true,
            content: [{ type: "text", text: "hi" }],
            details: { msg: "ok" },
        },
        theme,
        50,
    );
    expect(node?.type).toBe("AnsiBlock");
    expect(node.lines).toEqual(["R:ok@50"]);
    // signature wiring: result/options/theme/ctx are passed through correctly
    expect(seen.result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(seen.result.isError).toBe(false);
    expect(seen.options).toEqual({ expanded: true, isPartial: false });
    expect(seen.thm).toBe(theme);
    expect(seen.ctx.cwd).toBe("/repo");
    expect(seen.ctx.toolCallId).toBe("tc1");
    expect(seen.ctx.expanded).toBe(true);
    expect(typeof seen.ctx.invalidate).toBe("function");
});

test("renderToolCallToNode invokes renderCall with args/theme/ctx", () => {
    const def = {
        renderCall: (args, _thm, ctx) => ({
            render: () => ["$ " + args.cmd + " (" + ctx.toolCallId + ")"],
        }),
    };
    const node = renderToolCallToNode(
        def,
        { toolName: "bash", toolCallId: "tc2", args: { cmd: "ls" }, cwd: "/" },
        theme,
    );
    expect(node.lines).toEqual(["$ ls (tc2)"]);
});

test("returns null when the hook is absent", () => {
    const base = { toolName: "x", toolCallId: "t", args: {}, cwd: "/" };
    expect(renderToolResultToNode({}, base, theme)).toBeNull();
    expect(renderToolCallToNode({}, base, theme)).toBeNull();
    expect(renderToolResultToNode(null, base, theme)).toBeNull();
});

test("a throwing renderResult degrades to null (falls back to default card)", () => {
    const def = {
        renderResult: () => {
            throw new Error("nope");
        },
    };
    const node = renderToolResultToNode(
        def,
        { toolName: "x", toolCallId: "t", args: {}, cwd: "/" },
        theme,
    );
    expect(node).toBeNull();
});

test("returns null when the hook returns a non-Component", () => {
    const def = { renderResult: () => ({ not: "a component" }) };
    const node = renderToolResultToNode(
        def,
        { toolName: "x", toolCallId: "t", args: {}, cwd: "/" },
        theme,
    );
    expect(node).toBeNull();
});
