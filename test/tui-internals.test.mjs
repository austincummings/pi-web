/**
 * Drift self-check for the guarded pi-tui internals accessor
 * (src/host/tui-internals.ts) and the structural adapter (render-model parity
 * §7). Constructs REAL pi-tui components and asserts the adapter recognizes and
 * upgrades them (Image→<img>, Box/Container→nested, Spacer→gap). If pi-tui
 * renames a soft-private field or a class, these fail loudly — which is exactly
 * the contract §7.4 asks for (fail on drift, never silently mis-render).
 */
import { test, expect } from "bun:test";
import { Box, Container, Spacer, Image, Text } from "@earendil-works/pi-tui";
import {
    componentKind,
    readImage,
    readBoxPadding,
    readSpacerLines,
    readChildren,
} from "../src/host/tui-internals.ts";
import { componentToNode } from "../src/host/component-adapter.ts";

test("componentKind classifies real pi-tui components by constructor", () => {
    expect(componentKind(new Image("QUJD", "image/png", { fallbackColor: (s) => s }))).toBe("image");
    expect(componentKind(new Box(1, 1))).toBe("box");
    expect(componentKind(new Container())).toBe("container");
    expect(componentKind(new Spacer(2))).toBe("spacer");
    expect(componentKind(new Text("x"))).toBe("unknown"); // leaf → ANSI
    expect(componentKind({ render: () => [] })).toBe("unknown");
});

test("readImage extracts base64Data + mimeType from a real Image", () => {
    const img = new Image("QUJD", "image/png", { fallbackColor: (s) => s }, { filename: "cat.png" });
    expect(readImage(img)).toEqual({ base64Data: "QUJD", mimeType: "image/png", filename: "cat.png" });
});

test("readBoxPadding reads padding + detects a bgFn on a real Box", () => {
    expect(readBoxPadding(new Box(3, 2))).toEqual({ paddingX: 3, paddingY: 2, hasBg: false });
    expect(readBoxPadding(new Box(1, 1, (s) => s)).hasBg).toBe(true);
});

test("readSpacerLines / readChildren read real Spacer + Container", () => {
    expect(readSpacerLines(new Spacer(4))).toBe(4);
    const c = new Container();
    const t = new Text("hi");
    c.addChild(t);
    expect(readChildren(c)).toEqual([t]);
});

test("adapt lifts a real Image to an <img> data URI", () => {
    const img = new Image("QUJD", "image/png", { fallbackColor: (s) => s });
    expect(componentToNode(img, 80)).toEqual({
        type: "Image",
        src: "data:image/png;base64,QUJD",
        alt: undefined,
    });
});

test("adapt walks a real Box: padding + recursively-adapted children", () => {
    const box = new Box(2, 1);
    box.addChild(new Text("hello"));
    box.addChild(new Spacer(3));
    const node = componentToNode(box, 80);
    expect(node.type).toBe("Box");
    expect(node.paddingX).toBe(2);
    expect(node.paddingY).toBe(1);
    // Text is a leaf (ANSI), rendered at the inner width (80 - 2*2 = 76).
    expect(node.children[0].type).toBe("AnsiBlock");
    expect(node.children[0].cols).toBe(76);
    // Spacer is lifted to a gap node.
    expect(node.children[1]).toEqual({ type: "Spacer", lines: 3 });
});

test("adapt renders a real Container as a zero-padding Box", () => {
    const c = new Container();
    c.addChild(new Text("x"));
    const node = componentToNode(c, 40);
    expect(node.type).toBe("Box");
    expect(node.paddingX).toBe(0);
    expect(node.paddingY).toBe(0);
    expect(node.children[0].type).toBe("AnsiBlock");
});
