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
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

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

test("pi write renderCall adapts the TUI content preview", () => {
    const def = createWriteToolDefinition("/repo");
    const node = renderToolCallToNode(
        def,
        {
            toolName: "write",
            toolCallId: "tc-write",
            args: { path: "out.txt", content: "a\nb\nc" },
            cwd: "/repo",
            expanded: false,
            isPartial: true,
        },
        theme,
        80,
    );

    expect(node?.type).toBe("AnsiBlock");
    expect(node.lines.join("\n")).toContain("write out.txt");
    expect(node.lines.join("\n")).toContain("a");
    expect(node.lines.join("\n")).toContain("b");
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

// ---- Parity P2: structural recognition (fake constructor names) ----
// componentKind keys off constructor.name; tag plain objects to exercise the
// structural paths without importing pi-tui (see tui-internals.test.mjs for the
// real-class drift self-check).
const tag = (name, obj) => {
    obj.constructor = { name };
    return obj;
};

test("adapts an Image component to an <img> data URI (alt from filename)", () => {
    const img = tag("Image", {
        base64Data: "QUJD",
        mimeType: "image/png",
        options: { filename: "cat.png" },
        render: () => ["<ansi image fallback>"],
    });
    expect(componentToNode(img, 80)).toEqual({
        type: "Image",
        src: "data:image/png;base64,QUJD",
        alt: "cat.png",
    });
});

test("an Image missing its data degrades to the ANSI leaf", () => {
    const img = tag("Image", {
        mimeType: "image/png",
        render: () => ["fallback"],
    });
    const node = componentToNode(img, 80);
    expect(node.type).toBe("AnsiBlock");
    expect(node.lines).toEqual(["fallback"]);
});

test("adapts a Spacer to a gap node", () => {
    const sp = tag("Spacer", { lines: 4, render: () => ["", "", "", ""] });
    expect(componentToNode(sp, 80)).toEqual({ type: "Spacer", lines: 4 });
});

test("walks a Box: padding + recursively-adapted children at inner width", () => {
    const child = { render: (w) => ["child@" + w] }; // plain leaf
    const box = tag("Box", {
        paddingX: 2,
        paddingY: 1,
        children: [child],
        render: () => ["boxansi"],
    });
    const node = componentToNode(box, 80);
    expect(node.type).toBe("Box");
    expect(node.paddingX).toBe(2);
    expect(node.paddingY).toBe(1);
    // child rendered at inner width 80 - 2*2 = 76
    expect(node.children[0]).toEqual({
        type: "AnsiBlock",
        cols: 76,
        lines: ["child@76"],
    });
});

test("a Box with a bgFn degrades to the ANSI leaf (bg unreproducible)", () => {
    const box = tag("Box", {
        paddingX: 1,
        paddingY: 0,
        bgFn: (s) => s,
        children: [{ render: () => ["c"] }],
        render: () => ["boxed-with-bg"],
    });
    const node = componentToNode(box, 80);
    expect(node.type).toBe("AnsiBlock");
    expect(node.lines).toEqual(["boxed-with-bg"]);
});

test("adapts a Container to a zero-padding Box", () => {
    const container = tag("Container", {
        children: [{ render: () => ["a"] }, { render: () => ["b"] }],
        render: () => ["ansi"],
    });
    const node = componentToNode(container, 40);
    expect(node.type).toBe("Box");
    expect(node.paddingX).toBe(0);
    expect(node.paddingY).toBe(0);
    expect(node.children.map((c) => c.lines[0])).toEqual(["a", "b"]);
});
