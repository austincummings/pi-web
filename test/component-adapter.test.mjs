/**
 * Unit tests for the host-side pi Component → node adapter
 * (src/host/component-adapter.ts), render-model parity Parity P0: a live pi-tui
 * Component is emitted as a single AnsiBlock via its render(width) contract.
 */
import { test, expect } from "bun:test";
import { componentToNode, isComponent } from "../src/host/component-adapter.ts";

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
