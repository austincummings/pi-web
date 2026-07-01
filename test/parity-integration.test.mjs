/**
 * End-to-end render-model parity (P1): a tool's custom renderResult Component is
 * invoked host-side with the web-palette Theme, adapted to an AnsiBlock, then
 * painted by the client's ansiToHtml — asserting the whole chain produces themed
 * HTML. Ties together component-adapter + tui-theme (host) and ansi (client).
 */
import { test, expect } from "bun:test";
import { renderToolResultToNode } from "../src/host/component-adapter.ts";
import { webPaletteTheme } from "../src/host/tui-theme.ts";
import { ansiToHtml } from "../src/web/ansi.ts";

test("tool renderResult Component → AnsiBlock → themed HTML", () => {
    // A fake extension tool whose renderResult builds a pi-tui-style Component
    // that colors its output via the passed-in theme (as a real tool would).
    const def = {
        renderResult: (result, _options, theme) => ({
            render: (_w) => [
                theme.bold(theme.fg("toolTitle", "my-tool")),
                theme.fg("error", "boom: " + result.details.msg),
            ],
        }),
    };

    const node = renderToolResultToNode(
        def,
        {
            toolName: "my-tool",
            toolCallId: "t1",
            args: {},
            cwd: "/",
            content: [],
            details: { msg: "nope" },
            isError: true,
        },
        webPaletteTheme,
        80,
    );

    expect(node?.type).toBe("AnsiBlock");
    expect(node.lines.length).toBe(2);

    const html = ansiToHtml(node.lines);
    // title line: bold + accent color (rgb of --acc)
    expect(html).toContain("font-weight:bold");
    expect(html).toContain("color:rgb(106,160,255)");
    expect(html).toContain("my-tool");
    // error line: error color (rgb of --err)
    expect(html).toContain("color:rgb(224,85,106)");
    expect(html).toContain("boom: nope");
});
