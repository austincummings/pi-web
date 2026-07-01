/**
 * ui-dialogs-demo — exercises pi-web's blocking dialog bridge (TODO #22).
 *
 * Registers slash commands that call `piweb.select/confirm/input/editor(...)`
 * and `await` the browser's answer, then report it via a toast. Each mirrors a
 * pi-tui `ctx.ui.*` dialog, so the same code is a valid, portable pi extension:
 * with no pi-web host present, `piweb` no-ops (dialogs resolve to
 * undefined/false) and the commands simply report a cancel.
 *
 * Try it in the web UI:
 *   /ui-select   — pick from a list
 *   /ui-confirm  — yes/no
 *   /ui-input    — single-line text
 *   /ui-editor   — multi-line text
 *   /ui-demo     — run all four in sequence
 *   /ui-card     — send a custom message rendered by a registered
 *                  message renderer (piweb.registerMessageRenderer, TODO #19)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// The pi-web UI-bridge shim: resolves to the in-process host registry, or
// no-ops under plain terminal pi. Relative path from .pi/extensions/<name>/.
import { piweb } from "../../../src/sdk/piweb.ts";

export default function (pi: ExtensionAPI) {
    // A custom transcript-message renderer: messages of customType "demo-card"
    // render as a titled Box with a Markdown code block (mirrors pi-tui's
    // Text + Markdown components) instead of plain markdown.
    piweb.registerMessageRenderer("demo-card", (message, opts) => {
        const d = (message.details as any) || {};
        const lang = d.lang ?? "ts";
        return {
            type: "Box",
            children: [
                { type: "Text", text: `⭐ ${d.title ?? "Card"}` },
                { type: "Divider" },
                {
                    type: "Markdown",
                    text: `\`\`\`${lang}\nconst expanded = ${opts.expanded};\n\`\`\``,
                },
                { type: "Text", text: d.body ?? "" },
            ],
        };
    });

    pi.registerCommand("ui-card", {
        description:
            "Demo: send a custom message rendered by a message renderer",
        handler: async () => {
            // A rendererless message falls back to markdown; "demo-card" is
            // routed through the renderer registered above.
            pi.sendMessage({
                customType: "demo-card",
                content: "A demo card (fallback text if no renderer).",
                display: true,
                details: {
                    title: "Hello from an extension",
                    lang: "ts",
                    body: "Rendered via piweb.registerMessageRenderer.",
                },
            });
        },
    });

    pi.registerCommand("ui-select", {
        description: "Demo: piweb.select() blocking dialog",
        handler: async () => {
            const fruit = await piweb.select("Pick a fruit", [
                "apple",
                "banana",
                "cherry",
                "date",
            ]);
            piweb.notify(
                fruit ? `You picked: ${fruit}` : "Selection cancelled",
                "info",
            );
        },
    });

    pi.registerCommand("ui-confirm", {
        description: "Demo: piweb.confirm() blocking dialog",
        handler: async () => {
            const ok = await piweb.confirm(
                "Confirm action",
                "Do you want to proceed?",
            );
            piweb.notify(
                ok ? "Confirmed ✓" : "Declined",
                ok ? "info" : "warning",
            );
        },
    });

    pi.registerCommand("ui-input", {
        description: "Demo: piweb.input() blocking dialog",
        handler: async () => {
            const name = await piweb.input("What's your name?", "type here…");
            piweb.notify(name ? `Hello, ${name}!` : "No name entered", "info");
        },
    });

    pi.registerCommand("ui-editor", {
        description: "Demo: piweb.editor() blocking dialog",
        handler: async () => {
            const text = await piweb.editor(
                "Edit some text",
                "The quick brown fox\njumps over the lazy dog.",
            );
            piweb.notify(
                text != null
                    ? `Saved ${text.length} chars`
                    : "Editor cancelled",
                "info",
            );
        },
    });

    pi.registerCommand("ui-demo", {
        description: "Demo: run all four blocking dialogs in sequence",
        handler: async () => {
            const color = await piweb.select("Choose a color", [
                "red",
                "green",
                "blue",
            ]);
            if (!color)
                return piweb.notify("Demo cancelled at select", "warning");

            const sure = await piweb.confirm(
                "Confirm",
                `Use "${color}" as your favorite color?`,
            );
            if (!sure)
                return piweb.notify("Demo cancelled at confirm", "warning");

            const nickname = await piweb.input(
                "Pick a nickname",
                "e.g. speedy",
            );
            if (nickname == null)
                return piweb.notify("Demo cancelled at input", "warning");

            const bio = await piweb.editor(
                "Write a short bio",
                `Favorite color: ${color}\nNickname: ${nickname}\n`,
            );
            if (bio == null)
                return piweb.notify("Demo cancelled at editor", "warning");

            piweb.notify(
                `All set — ${nickname} likes ${color} (${bio.length}-char bio)`,
                "info",
            );
        },
    });
}
