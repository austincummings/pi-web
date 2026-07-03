/**
 * DOM-level tests for the static node renderer (src/web/nodes.ts), covering the
 * layout/style props added for custom footers/headers (piweb.setFooter /
 * setHeader): `Text` tone/color/bold and `Row` justify/gap/align/wrap. Runs
 * under the happy-dom harness (bunfig preload -> test/setup-dom.ts).
 */
import { test, expect } from "bun:test";
import { renderStaticNode } from "../src/web/nodes.ts";

const el = (node: any) => renderStaticNode(node) as HTMLElement;

test("Text tone maps to a themed tone-* class", () => {
    const d = el({ type: "Text", text: "hi", tone: "accent" });
    expect(d.textContent).toBe("hi");
    expect(d.classList.contains("tone-accent")).toBe(true);
});

test("Text dim adds tone-dim; bold sets font-weight", () => {
    const d = el({ type: "Text", text: "x", dim: true, bold: true });
    expect(d.classList.contains("tone-dim")).toBe(true);
    expect(d.style.fontWeight).toBe("600");
});

test("Text explicit color sets an inline color (theme.fg analog)", () => {
    const d = el({ type: "Text", text: "x", color: "#abcdef" });
    expect(d.style.color).toBe("#abcdef");
});

test("plain Text has no tone class or inline color", () => {
    const d = el({ type: "Text", text: "plain" });
    expect(d.className).toBe("");
    expect(d.style.color).toBe("");
});

test("Row justify=between maps to space-between + honors gap", () => {
    const d = el({
        type: "Row",
        justify: "between",
        gap: 12,
        children: [
            { type: "Text", text: "L" },
            { type: "Text", text: "R" },
        ],
    });
    expect(d.className).toBe("row");
    expect(d.style.justifyContent).toBe("space-between");
    expect(d.style.gap).toBe("12px");
    expect(d.childNodes.length).toBe(2);
});

test("Row justify=end/center map correctly; wrap=false sets nowrap; align passes through", () => {
    expect(el({ type: "Row", justify: "end" }).style.justifyContent).toBe(
        "flex-end",
    );
    expect(el({ type: "Row", justify: "center" }).style.justifyContent).toBe(
        "center",
    );
    const d = el({ type: "Row", wrap: false, align: "center" });
    expect(d.style.flexWrap).toBe("nowrap");
    expect(d.style.alignItems).toBe("center");
});

test("a footer-style Box tree (Rows of toned Text) renders nested structure", () => {
    const tree = {
        type: "Box",
        children: [
            {
                type: "Row",
                justify: "between",
                children: [
                    {
                        type: "Row",
                        children: [
                            { type: "Text", text: "⎇ main", tone: "accent" },
                        ],
                    },
                    {
                        type: "Row",
                        children: [
                            { type: "Text", text: "sonnet", tone: "text" },
                        ],
                    },
                ],
            },
        ],
    };
    const box = el(tree);
    expect(box.querySelectorAll(".row").length).toBe(3); // outer + 2 inner
    expect(box.querySelector(".tone-accent")?.textContent).toBe("⎇ main");
    expect(box.querySelector(".tone-text")?.textContent).toBe("sonnet");
});
