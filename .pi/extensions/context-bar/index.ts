/**
 * context-bar — replicates the pi-tui "context-bar" footer in the pi-web cockpit.
 *
 * Renders into the bottom context bar (via piweb.setStatus segments): working
 * dir (~), git branch, model + thinking level, a 20-cell context-window usage
 * bar with percentage + window size, and a right-aligned session cost — colored
 * with the Glass Cockpit severity rules:
 *   error  (red)   — at/over half the model's context window ("dumb zone").
 *   warning (amber)— >= 150k tokens (the long-context cost tier looms at 200k).
 *   accent (sky)   — nominal.
 *
 * Mirrors ~/.pi/agent/extensions/context-bar/index.ts, but instead of pi-tui's
 * setFooter() it uses the pi-web `setStatus` surface (keyed segments, align +
 * tone). Portable: with no pi-web host present (plain pi in a terminal) it
 * no-ops — and the terminal already has the native context-bar extension.
 */
import os from "os";
import { readFileSync } from "fs";
import { join } from "path";

const BAR_WIDTH = 20;
const FILLED = "█";
const EMPTY = "░";
const AMBER_TOKEN_THRESHOLD = 150_000;

function fmtTokens(n: number): string {
    if (n <= 0) return "0";
    if (n < 1000) return `${n}`;
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number): string {
    if (usd <= 0) return "$0.00";
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

function buildBar(pct: number, width = BAR_WIDTH): string {
    const filled = Math.max(
        0,
        Math.min(width, Math.round((pct / 100) * width)),
    );
    return FILLED.repeat(filled) + EMPTY.repeat(width - filled);
}

/** Severity tone for the context bar, mirroring the shell statusline. */
function contextTone(tokens: number, contextWindow: number): string {
    const half = contextWindow > 0 ? Math.floor(contextWindow / 2) : 0;
    if (half > 0 && tokens >= half) return "error"; // red — dumb zone
    if (tokens >= AMBER_TOKEN_THRESHOLD) return "warning"; // amber — cost warning
    return "accent"; // sky blue — nominal
}

/** cwd → basename, with ~ for $HOME (matches the shell statusline). */
function dirDisplay(cwd: string, home: string): string {
    if (!cwd) return "";
    if (home && cwd === home) return "~";
    if (home && cwd.startsWith(home + "/"))
        return "~/" + cwd.slice(home.length + 1);
    return cwd.split("/").pop() || cwd;
}

/** Cheap current git branch (no watcher): read .git/HEAD. */
function gitBranch(dir: string): string | null {
    try {
        const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
        const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        return m ? m[1] : head.slice(0, 7);
    } catch {
        return null;
    }
}

export default function (pi: any) {
    const piweb = (globalThis as any).__PIWEB__;
    if (!piweb) return; // portable: terminal pi has its own context-bar

    function render(ctx: any) {
        try {
            // Route to *this thread's* surface registry by session id rather
            // than the host's global `currentThread` pointer: extension event
            // handlers run before the cockpit listener that sets currentThread,
            // so it is stale (or points at another thread) when we render here.
            // forSession returns null during session_start (thread not yet
            // registered) — fall back to the global router, correctly bound then.
            const sid = ctx?.sessionManager?.getSessionId?.();
            const surface = piweb.forSession?.(sid) ?? piweb;

            const home = os.homedir();
            const usage = ctx.getContextUsage?.();
            const contextWindow =
                usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
            const tokens = usage?.tokens ?? 0;
            const pct =
                usage?.percent ??
                (contextWindow > 0 ? (tokens / contextWindow) * 100 : 0);

            // session cost accumulated across the branch
            let cost = 0;
            for (const e of ctx.sessionManager.getBranch?.() ?? []) {
                if (e.type === "message" && e.message.role === "assistant") {
                    cost += e.message.usage?.cost?.total ?? 0;
                }
            }

            const dir = dirDisplay(ctx.cwd ?? "", home);
            const branch = gitBranch(ctx.cwd ?? "");
            const model = ctx.model?.id || "no-model";
            // Match the pi TUI footer exactly: append the thinking level to the
            // model name only when the model supports reasoning, rendering
            // "<model> • thinking off" when off, else "<model> • <level>".
            const thinking = pi.getThinkingLevel?.() || "off";
            const modelText = ctx.model?.reasoning
                ? thinking === "off"
                    ? `${model} • thinking off`
                    : `${model} • ${thinking}`
                : model;
            const bar = buildBar(pct);
            const tone = contextTone(tokens, contextWindow);
            const pctStr = pct > 0 ? `${Math.round(pct)}%` : "0%";

            // keyed segments (sorted by key; the "cb/" prefix groups them and is
            // never shown). Passing undefined clears a segment.
            surface.setStatus("cb/0-dir", dir || undefined, { tone: "accent" });
            surface.setStatus(
                "cb/1-branch",
                branch ? `(${branch})` : undefined,
                {
                    tone: "muted",
                },
            );
            surface.setStatus("cb/2-model", modelText, { tone: "text" });
            surface.setStatus("cb/4-ctx", `ctx: ${bar} ${pctStr}`, { tone });
            surface.setStatus(
                "cb/5-win",
                contextWindow > 0 ? `/${fmtTokens(contextWindow)}` : undefined,
                { tone: "dim" },
            );
            surface.setStatus(
                "cb/9-cost",
                cost > 0 ? fmtCost(cost) : undefined,
                {
                    align: "right",
                    tone: "success",
                },
            );
        } catch {
            /* best-effort cockpit chrome */
        }
    }

    // session_start runs while the host is still binding this thread, so the
    // initial bar routes correctly; later events refresh as tokens/cost grow.
    pi.on("session_start", (_e: any, ctx: any) => render(ctx));
    pi.on("message_end", (_e: any, ctx: any) => render(ctx));
    pi.on("turn_end", (_e: any, ctx: any) => render(ctx));
    pi.on("agent_end", (_e: any, ctx: any) => render(ctx));
    pi.on("thinking_level_select", (_e: any, ctx: any) => render(ctx));
    pi.on("model_select", (_e: any, ctx: any) => render(ctx));
}
