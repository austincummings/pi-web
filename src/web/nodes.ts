/**
 * Shared renderer for pi-web's *static* (non-interactive) node vocabulary
 * (render-model parity). Used by both the transcript renderer (app.ts
 * `renderNode`, which layers the interactive Button/Input/Frame nodes on top)
 * and tool cards (pi-tool.ts), so a tool's adapted `renderResult` tree — Box,
 * Spacer, Image, AnsiBlock, … — paints identically wherever it appears.
 *
 * Interactive nodes need a `surfaceId` + host RPC, so they live in app.ts; this
 * module stays dependency-light (ansi + markdown only) and free of app.ts, which
 * keeps pi-tool.ts out of an import cycle.
 */
import { ansiToHtml } from "./ansi.ts";
import { renderMarkdown } from "./markdown.ts";

type Node = any;
type RenderChild = (node: Node) => ChildNode;

/**
 * Render a static node to a DOM node. Returns null for node types this renderer
 * doesn't own (interactive/unknown) so a caller (app.ts) can handle them.
 *
 * @param node        the serializable node
 * @param renderChild recursion hook for container children (defaults to static)
 */
export function renderStaticNode(
    node: Node,
    renderChild?: RenderChild,
): ChildNode | null {
    if (!node || typeof node !== "object") {
        return document.createTextNode(String(node ?? ""));
    }
    const recur: RenderChild =
        renderChild ?? ((c) => renderStaticNode(c, renderChild) ?? unknown(c));

    switch (node.type) {
        // Box / Container (Stack = pre-rename alias). Vertical child stack; when
        // the host adapter supplies terminal-cell padding (structural pi Box),
        // apply it (cells → ch/line-height) and drop the inter-child gap.
        case "Box":
        case "Stack": {
            const d = document.createElement("div");
            d.style.display = "flex";
            d.style.flexDirection = "column";
            const hasPad =
                typeof node.paddingX === "number" ||
                typeof node.paddingY === "number";
            if (hasPad) {
                const px = Math.max(0, node.paddingX || 0);
                const py = Math.max(0, node.paddingY || 0);
                // .ansi line-height is 1.5; a cell of vertical padding ≈ 1.5em.
                d.style.padding = `${py * 1.5}em ${px}ch`;
                d.style.gap = "0";
            } else {
                d.style.gap = "8px";
            }
            (node.children || []).forEach((c: Node) => d.appendChild(recur(c)));
            return d;
        }
        case "Row": {
            const d = document.createElement("div");
            d.className = "row";
            (node.children || []).forEach((c: Node) => d.appendChild(recur(c)));
            return d;
        }
        case "Text": {
            const d = document.createElement("div");
            d.textContent = node.text ?? "";
            return d;
        }
        case "Divider": {
            const d = document.createElement("div");
            d.className = "divider";
            return d;
        }
        case "Markdown": {
            const d = document.createElement("div");
            d.className = "md";
            d.innerHTML = renderMarkdown(node.text ?? "");
            return d;
        }
        // AnsiBlock: monospace ANSI lines from a pi Component's render(width).
        case "AnsiBlock": {
            const pre = document.createElement("div");
            pre.className = "ansi";
            pre.innerHTML = ansiToHtml(
                Array.isArray(node.lines) ? node.lines : [],
            );
            return pre;
        }
        // Spacer: N blank terminal lines → a fixed-height gap (line-height 1.5).
        case "Spacer": {
            const d = document.createElement("div");
            const n = Math.max(0, Number(node.lines) || 0);
            d.style.height = `${n * 1.5}em`;
            d.setAttribute("aria-hidden", "true");
            return d;
        }
        // Image: a pi-tui Image lifted to a real <img> via a data URI (§7.4).
        case "Image": {
            const img = document.createElement("img");
            img.className = "pi-img";
            img.src = String(node.src || "");
            if (node.alt) img.alt = String(node.alt);
            img.loading = "lazy";
            return img;
        }
        default:
            return null; // not a static node — caller decides
    }
}

function unknown(node: Node): ChildNode {
    const d = document.createElement("div");
    d.textContent = `[unknown node: ${node?.type}]`;
    return d;
}
