/**
 * markdown-viewer — read Markdown files from the filesystem and render them
 * (rich) in the transcript, authored entirely as an extension (no pi-web host
 * changes).
 *
 * It works purely through the public `piweb` surface plus standard `pi.*`
 * APIs, so it stays a valid, portable pi extension (under plain terminal pi,
 * `piweb` no-ops and the commands simply report that the web UI is absent).
 *
 *   • `piweb.registerMessageRenderer("markdown-file", …)` returns a
 *     serializable `Box` with a titled header (path + size) and a `Markdown`
 *     node whose body flows through the same markdown pipeline as the
 *     transcript (mirrors pi-tui's Markdown component).
 *   • `piweb.addAutocompleteProvider(…)` feeds the web composer inline
 *     completions for `/md <path>`: type `/md ` and discovered Markdown files
 *     appear in the `/`-style typeahead (Tab to complete, Enter to render).
 *   • `/md <path>` reads a file off disk and emits it as one of those custom
 *     transcript messages.
 *
 * Commands:
 *   /md <path>   — render a Markdown file (inline typeahead completes the path)
 *   /md-list     — list the Markdown files discovered under the project root
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { piweb } from "../../../src/sdk/piweb.ts";

const MD_EXTENSIONS = [".md", ".markdown", ".mdx", ".mdown", ".mkd"];
const IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".cache",
    "coverage",
    "vendor",
]);

function isMarkdown(path: string): boolean {
    const lower = path.toLowerCase();
    return MD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Discover Markdown files under `root`, skipping heavy/ignored directories. */
async function discover(root: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 8) return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".") && entry.name !== ".pi") {
                if (entry.isDirectory()) continue;
            }
            const full = resolve(dir, entry.name);
            if (entry.isDirectory()) {
                if (IGNORE_DIRS.has(entry.name)) continue;
                await walk(full, depth + 1);
            } else if (entry.isFile() && isMarkdown(entry.name)) {
                out.push(full);
            }
        }
    };
    await walk(root, 0);
    out.sort((a, b) => a.localeCompare(b));
    return out;
}

export default function (pi: ExtensionAPI) {
    const root = (pi as any)?.ctx?.cwd ?? process.cwd();

    const toDisplay = (path: string): string => {
        const rel = relative(root, path);
        return !rel || rel.startsWith("..") ? path : rel;
    };

    // Short-lived cache of discovered files so the autocomplete provider (called
    // on every keystroke of `/md …`) doesn't re-walk the tree each time.
    let cache: { files: string[]; at: number } | null = null;
    const CACHE_TTL_MS = 5000;
    const cachedDiscover = async (): Promise<string[]> => {
        if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.files;
        const files = await discover(root);
        cache = { files, at: Date.now() };
        return files;
    };

    // Inline composer completion for `/md <path>`: when the line is `/md ` +
    // partial path, offer matching Markdown files. The replace span covers just
    // the argument, so accepting yields `/md <full path>`.
    piweb.addAutocompleteProvider((current) => async (ctx) => {
        const { text, caret } = ctx;
        const before = text.slice(0, caret);
        const m = before.match(/^\/md(\s+)(.*)$/s);
        if (!m) return current(ctx);
        const query = m[2];
        const start = caret - query.length;
        const files = await cachedDiscover();
        const q = query.toLowerCase();
        const items = files
            .map(toDisplay)
            .filter((p) => !q || p.toLowerCase().includes(q))
            // Prefer earlier matches, then shorter/shallower paths.
            .sort((a, b) => {
                const ai = a.toLowerCase().indexOf(q);
                const bi = b.toLowerCase().indexOf(q);
                return ai - bi || a.length - b.length || a.localeCompare(b);
            })
            .slice(0, 20)
            .map((p) => ({ value: p, label: p, description: "markdown" }));
        if (!items.length) return current(ctx);
        return { start, end: caret, items };
    });

    // Render "markdown-file" custom messages as a titled Box + Markdown body.
    piweb.registerMessageRenderer("markdown-file", (message: any) => {
        const d = (message.details as any) || {};
        const path = typeof d.path === "string" ? d.path : "file";
        const text = typeof d.content === "string" ? d.content : "";
        const meta =
            typeof d.size === "number" ? `  ·  ${humanSize(d.size)}` : "";
        if (!text.trim()) {
            return { type: "Text", text: `markdown-viewer: ${path} is empty` };
        }
        return {
            type: "Box",
            children: [
                { type: "Text", text: `📄 ${path}${meta}` },
                { type: "Divider" },
                { type: "Markdown", text },
            ],
        };
    });

    const emit = async (path: string): Promise<void> => {
        const abs = isAbsolute(path) ? path : resolve(root, path);
        let content: string;
        let size = 0;
        try {
            content = await readFile(abs, "utf8");
            size = (await stat(abs)).size;
        } catch (err: any) {
            piweb.notify(
                `Couldn't read ${toDisplay(abs)}: ${err?.message ?? err}`,
                "error",
            );
            return;
        }
        if (!isMarkdown(abs)) {
            const ok = await piweb.confirm(
                "Not a Markdown file",
                `${toDisplay(abs)} doesn't look like Markdown. Render it anyway?`,
            );
            if (!ok) return;
        }
        pi.sendMessage({
            customType: "markdown-file",
            content: `Markdown: ${toDisplay(abs)}`,
            display: true,
            details: { path: toDisplay(abs), content, size },
        });
    };

    pi.registerCommand("md", {
        description:
            "Render a Markdown file from the filesystem (Tab to complete)",
        handler: async (args?: string) => {
            const arg = (args ?? "").trim();
            if (arg) {
                await emit(arg);
                return;
            }
            piweb.notify(
                "Usage: /md <path> — start typing to autocomplete a Markdown file",
                "info",
            );
        },
    });

    pi.registerCommand("md-list", {
        description: "List Markdown files discovered under the project root",
        handler: async () => {
            const files = await discover(root);
            if (!files.length) {
                piweb.notify("No Markdown files found", "warning");
                return;
            }
            pi.sendMessage({
                customType: "markdown-file",
                content: `${files.length} Markdown files`,
                display: true,
                details: {
                    path: `${files.length} Markdown files under ${toDisplay(root) || "."}`,
                    content: files
                        .map((f) => `- \`${toDisplay(f)}\``)
                        .join("\n"),
                },
            });
        },
    });
}
