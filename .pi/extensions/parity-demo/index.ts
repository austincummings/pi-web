/**
 * parity-demo — a live test for render-model parity (P1).
 *
 * Registers a tool whose `renderResult` returns a pi TUI `Component` (duck-typed
 * `{ render(width): string[] }`) that colors its output via the passed-in
 * `theme`. When the agent calls this tool, pi-web invokes the renderResult
 * host-side, adapts the Component to an `AnsiBlock`, and paints it in the tool
 * card — exercising the whole parity pipeline end-to-end in the browser.
 *
 * Try it: ask the agent to **"run the parity_demo tool"**, then look at the
 * tool card — it should show a titled, multi-colored block (bold accent title,
 * green/red lines, italic + underline, and an inverse-video chip) instead of
 * the default text body.
 *
 * Note: a project extension can't resolve `@sinclair/typebox` directly (it's
 * nested under pi), so we reuse a built-in tool's TypeBox schema for
 * `parameters`. The tool ignores its args.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLsToolDefinition } from "@earendil-works/pi-coding-agent";

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
}
