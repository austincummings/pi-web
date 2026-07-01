/**
 * parity-demo — live tests for render-model parity (P1 + P2).
 *
 * Registers two tools:
 *  • `parity_demo` (P1) — `renderResult` returns a duck-typed `Component`
 *    (`{ render(width): string[] }`) that colors its output via the passed-in
 *    `theme`; pi-web adapts it to an `AnsiBlock` and paints it in the card.
 *  • `parity_demo_structural` (P2) — `renderResult` returns a REAL pi-tui
 *    `Box → Text + Spacer + Image` tree; the host adapter walks it into nested
 *    nodes and lifts the Image to a real `<img>` (data URI).
 *
 * Try it: ask the agent to **"run the parity_demo tool"** (colored block) or
 * **"run the parity_demo_structural tool"** (nested card with an `<img>`), then
 * look at the tool card instead of the default text body.
 *
 * Note: a project extension can't resolve `@sinclair/typebox` directly (it's
 * nested under pi), so we reuse a built-in tool's TypeBox schema for
 * `parameters`. The tool ignores its args.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Text, Spacer, Image } from "@earendil-works/pi-tui";

// A 1x1 transparent PNG — enough to prove the Image → <img> data-URI path (P2).
const PNG_1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export default function (pi: ExtensionAPI) {
    // Reuse a built-in schema so we don't need TypeBox in the extension.
    const parameters = createLsToolDefinition(process.cwd()).parameters;

    pi.registerTool({
        name: "parity_demo",
        label: "Parity Demo",
        description:
            "Render-model parity P1 demo. Returns a custom pi TUI Component via " +
            "renderResult so pi-web renders it as a colored block. Call this " +
            "tool when asked to demo/test render-model parity. Takes no meaningful args.",
        parameters,
        async execute() {
            return {
                content: [
                    {
                        type: "text",
                        text: "parity_demo ran — see the rendered component in the tool card.",
                    },
                ],
                details: {
                    note: "Rendered by renderResult → pi-web AnsiBlock",
                },
                isError: false,
            };
        },
        // The star of the show: a Component colored via the theme. In pi-web this
        // runs host-side (with the web-palette Theme shim) and paints in the DOM.
        renderResult(result: any, options: any, theme: any) {
            const d = (result?.details as any) || {};
            return {
                render(width: number): string[] {
                    return [
                        theme.bold(
                            theme.fg(
                                "toolTitle",
                                "◆ Parity Demo — renderResult",
                            ),
                        ),
                        "",
                        theme.fg("success", "  ✓ theme.fg(success) — green"),
                        theme.fg("error", "  ✗ theme.fg(error) — red"),
                        theme.italic(
                            theme.fg("toolOutput", "  italic muted output"),
                        ),
                        theme.underline(
                            theme.fg("keyword", "  underlined keyword"),
                        ),
                        "  " + theme.inverse(" INVERSE VIDEO "),
                        "",
                        theme.fg(
                            "toolOutput",
                            `  expanded=${options?.expanded}  width=${width}`,
                        ),
                        theme.fg("toolOutput", "  " + (d.note ?? "")),
                    ];
                },
            };
        },
    } as any);

    // Parity P2 (structural): renderResult returns a REAL pi-tui component tree
    // (Box → Text + Spacer + Image). The host adapter walks it into nested nodes
    // — the Box becomes a padded container, the Spacer a gap, and the Image a
    // real <img> (data URI, §7.4) — instead of flattening to one ANSI block.
    // In a terminal the Image renders as pixel cells; in pi-web it's an <img>.
    pi.registerTool({
        name: "parity_demo_structural",
        label: "Parity Demo (structural)",
        description:
            "Render-model parity P2 demo. Returns a real pi-tui Box/Text/Spacer/" +
            "Image component tree via renderResult, so pi-web renders a nested " +
            "card with an actual <img>. Call when asked to demo structural parity.",
        parameters,
        async execute() {
            return {
                content: [{ type: "text", text: "parity_demo_structural ran." }],
                details: {},
                isError: false,
            };
        },
        renderResult() {
            const box = new Box(2, 1);
            box.addChild(new Text("◆ Parity Demo — structural (Box → children)"));
            box.addChild(new Spacer(1));
            box.addChild(new Text("Below is a real pi-tui Image → <img> in pi-web:"));
            box.addChild(
                new Image(
                    PNG_1x1,
                    "image/png",
                    { fallbackColor: (s: string) => s },
                    { filename: "pixel.png" },
                    { widthPx: 1, heightPx: 1 },
                ),
            );
            return box as any;
        },
    } as any);
}
