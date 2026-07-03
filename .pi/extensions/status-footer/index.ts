/**
 * status-footer — replace pi-web's default context bar with a single, unified
 * footer (true pi-TUI parity via `piweb.setFooter`):
 *
 *     ~/projects/pi-web • my-session
 *     ⎇ main  +42 −7 ~3          [▓▓▓▓▓▓░░░░] 58%/200k  sonnet-4 • high
 *      branch  git diff          <progress> meter         model • thinking
 *
 * Unlike the earlier `setStatus` approach (which stacked a *second* status band
 * under the host-built context bar, duplicating model/thinking/context), this
 * uses the `setFooter` hook: the extension supplies a factory that returns the
 * whole footer, which the host renders in place of the default `#contextbar` —
 * exactly how pi-tui's `ctx.ui.setFooter(factory)` completely replaces the
 * FooterComponent. One footer, one line of truth.
 *
 * The footer is emitted as a single `{ type: "Frame", html }` node — a
 * sandboxed <pi-frame> that inherits the theme `--*` CSS vars — so the context
 * meter can be a real HTML `<progress>` element (rather than a glyph bar). This
 * uses only the *existing* web-only `Frame` node; it does not add anything to
 * the extension/node surface.
 *
 * How it works:
 *   • `piweb.setFooter(factory)` registers a factory that receives live
 *     `FooterData` (cwd, session, model, thinking level, tokens, cost, context
 *     %/window, gitBranch, …) each time the host rebuilds the footer — on turn
 *     end, model / thinking change, compaction, rename, a git-branch change, or
 *     an explicit `refreshFooter()`.
 *   • Model / thinking / context / branch come straight from `FooterData`
 *     (`gitBranch` is host-native + reactive). Diff stats are gathered
 *     out-of-band via `pi.exec("git", …)` into a small cache (debounced so the
 *     shell-outs don't pile up while a turn streams); after each recompute the
 *     extension calls `piweb.refreshFooter()` so the factory re-runs.
 *   • Trade-off of the Frame: the host re-mounts the <pi-frame> on each footer
 *     rebuild, so the bar briefly reloads when it refreshes — acceptable for a
 *     status line, and the debounce keeps git-driven churn down.
 *
 * Under plain terminal pi (`piweb.present === false`) `setFooter` no-ops, so the
 * extension stays a valid, portable pi extension (the real TUI already renders
 * its own footer from the same data).
 *
 * Commands:
 *   /footer            — toggle the custom footer on/off (off = default bar)
 *   /footer on|off     — force it on or off
 *   /footer refresh    — recompute git + rebuild now
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FooterData } from "../../../src/sdk/piweb.ts";
import { piweb } from "../../../src/sdk/piweb.ts";

const DEBOUNCE_MS = 250; // coalesce git recompute bursts
const FOOTER_HEIGHT = 46; // px: two lines (13px/1.5) + vertical padding

interface GitStats {
    files: number;
    added: number;
    removed: number;
    untracked: number;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** compact token count (mirrors the pi TUI footer's formatTokens) */
function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + "k";
    if (n < 1000000) return Math.round(n / 1000) + "k";
    return (n / 1000000).toFixed(1) + "M";
}

/** theme CSS var for the context meter: accent until ~70%, warn to 90%, error. */
function contextColor(percent: number | null): string {
    if (percent == null) return "--dim";
    if (percent > 90) return "--err";
    if (percent > 70) return "--warn";
    return "--acc";
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

async function git(
    pi: ExtensionAPI,
    root: string,
    args: string[],
): Promise<string | null> {
    try {
        const res = await pi.exec("git", args, { cwd: root, timeout: 5000 });
        return res.code === 0 ? res.stdout : null;
    } catch {
        return null;
    }
}

/**
 * Summed +/-/file counts vs HEAD (staged + unstaged) plus a count of untracked
 * files. Branch is *not* computed here — it comes host-native from
 * `FooterData.gitBranch` (reactive), matching pi-tui's `footerData.getGitBranch`.
 */
async function gitStats(
    pi: ExtensionAPI,
    root: string,
): Promise<GitStats | null> {
    const inside = await git(pi, root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside === null || inside.trim() !== "true") return null;

    let added = 0;
    let removed = 0;
    let files = 0;
    const numstat =
        (await git(pi, root, ["diff", "--numstat", "HEAD"])) ??
        (await git(pi, root, ["diff", "--numstat"]));
    if (numstat) {
        for (const line of numstat.split("\n")) {
            if (!line.trim()) continue;
            const [a, r] = line.split("\t");
            files++;
            if (a !== "-") added += parseInt(a, 10) || 0;
            if (r !== "-") removed += parseInt(r, 10) || 0;
        }
    }

    // Untracked (new, unignored) files — excluded from `git diff`, counted here.
    let untracked = 0;
    const others = await git(pi, root, [
        "ls-files",
        "--others",
        "--exclude-standard",
    ]);
    if (others) untracked = others.split("\n").filter((l) => l.trim()).length;

    return { files, added, removed, untracked };
}

// ---------------------------------------------------------------------------
// Footer HTML (rendered inside a sandboxed <pi-frame> so the context meter can
// be a real <progress> element; the frame inherits the theme --* CSS vars).
// ---------------------------------------------------------------------------

/** The <progress>-based context meter markup. */
function meterHtml(percent: number | null, window: number): string {
    const clamped =
        percent == null ? null : Math.max(0, Math.min(100, percent));
    const win = window ? `/${fmtTokens(window)}` : "";
    const label = `${clamped == null ? "?" : clamped.toFixed(0)}%${win}`;
    const value = clamped == null ? "" : ` value="${clamped}"`;
    return (
        `<progress class="meter" max="100"${value}></progress>` +
        `<span class="pct">${escapeHtml(label)}</span>`
    );
}

/** git branch + diff markup (left group). */
function gitHtml(data: FooterData, stats: GitStats | null): string {
    const branch = `<span class="branch">⎇ ${escapeHtml(data.gitBranch || "—")}</span>`;
    let diff = "";
    if (
        stats &&
        (stats.added || stats.removed || stats.files || stats.untracked)
    ) {
        const parts: string[] = [];
        if (stats.files)
            parts.push(
                `<span class="add">+${stats.added}</span> ` +
                    `<span class="del">−${stats.removed}</span> ` +
                    `<span class="dim">~${stats.files}</span>`,
            );
        if (stats.untracked)
            parts.push(`<span class="unt">+${stats.untracked}?</span>`);
        diff = " " + parts.join(" ");
    } else if (stats) {
        diff = ` <span class="dim">clean</span>`;
    }
    return branch + diff;
}

/** Build the whole footer as a self-contained HTML document for the Frame. */
function footerHtml(data: FooterData, stats: GitStats | null): string {
    const color = contextColor(data.context?.percent ?? null);
    const l1 = data.session
        ? `${escapeHtml(data.cwd || "~")} <span class="dim">•</span> ${escapeHtml(data.session)}`
        : escapeHtml(data.cwd || "~");
    const model = `<span class="model">${escapeHtml(data.model || "no-model")}</span>`;
    const think = !data.reasoning
        ? ""
        : data.level === "off"
          ? ` <span class="dim">• thinking off</span>`
          : ` <span class="think">• ✱ ${escapeHtml(data.level)}</span>`;
    return (
        `<!doctype html><style>` +
        `html,body{margin:0;padding:0;background:transparent;}` +
        `body{font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--txt);` +
        `padding:3px 14px;overflow:hidden;}` +
        `.l1{color:var(--dim);}` +
        `.l2{display:flex;align-items:center;gap:12px;white-space:nowrap;}` +
        `.left,.right{display:flex;align-items:center;gap:8px;}` +
        `.right{margin-left:auto;}` +
        `.dim{color:var(--dim);}.add{color:var(--ok);}.del{color:var(--err);}` +
        `.unt{color:var(--muted);}.branch{color:var(--acc);}.model{color:var(--txt);}` +
        `.think{color:var(--acc);}.pct{color:var(${color});}` +
        `progress.meter{-webkit-appearance:none;appearance:none;width:120px;height:8px;` +
        `border:none;border-radius:999px;overflow:hidden;background:var(--line);vertical-align:middle;}` +
        `progress.meter::-webkit-progress-bar{background:var(--line);border-radius:999px;}` +
        `progress.meter::-webkit-progress-value{background:var(${color});border-radius:999px;}` +
        `progress.meter::-moz-progress-bar{background:var(${color});border-radius:999px;}` +
        `</style>` +
        `<div class="l1">${l1}</div>` +
        `<div class="l2">` +
        `<span class="left">${gitHtml(data, stats)}</span>` +
        `<span class="right">${meterHtml(data.context?.percent ?? null, data.context?.window ?? 0)}${model}${think}</span>` +
        `</div>`
    );
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // process.cwd() under pi-web is the *server's* dir; seed from every ctx.
    let root = process.cwd();
    let enabled = true;
    let stats: GitStats | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** Register (or clear) the footer factory. */
    function install() {
        if (!enabled) {
            piweb.setFooter(undefined); // restore the default context bar
            return;
        }
        // Fixed height for the two-line bar: without it the <pi-frame>
        // auto-sizes from an 80px placeholder and leaves a gap below.
        piweb.setFooter((data: FooterData) => ({
            type: "Frame",
            height: FOOTER_HEIGHT,
            html: footerHtml(data, stats),
        }));
    }

    /** Recompute git (debounced), then ask the host to rebuild the footer. */
    function scheduleGit(ctx?: any) {
        if (ctx?.cwd) root = ctx.cwd;
        if (!enabled || !piweb.present) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
            timer = null;
            stats = await gitStats(pi, root);
            piweb.refreshFooter();
        }, DEBOUNCE_MS);
    }

    // Install at registration time. This runs during initial load AND on every
    // `/reload` (which first calls `piweb.clear()`, wiping the factory) — both
    // happen with `bindingThread` set, so `setFooter` routes to this thread's
    // registry. Installing only inside `session_start` would leave the footer on
    // the default bar after a reload until the next session_start.
    install();

    // Seed cwd + first git snapshot once the session binds.
    pi.on("session_start", (_e: any, ctx: any) => {
        if (ctx?.cwd) root = ctx.cwd;
        install();
        scheduleGit(ctx);
    });
    pi.on("turn_end", (_e: any, ctx: any) => scheduleGit(ctx));
    pi.on("agent_end", (_e: any, ctx: any) => scheduleGit(ctx));
    pi.on("tool_result", (_e: any, ctx: any) => scheduleGit(ctx)); // tree may change
    // model / thinking changes already trigger a host footer rebuild; the
    // factory re-runs with fresh FooterData, so no git recompute is needed.

    pi.registerCommand("footer", {
        description:
            "Toggle the unified footer (cwd, git branch/diff, context meter, model, thinking).",
        handler: async (args?: string, ctx?: any) => {
            const arg = (args ?? "").trim().toLowerCase();
            if (ctx?.cwd) root = ctx.cwd;
            if (arg === "off") enabled = false;
            else if (arg === "on" || arg === "refresh") enabled = true;
            else enabled = !enabled; // bare /footer toggles

            if (!piweb.present) {
                piweb.notify("The custom footer needs the web UI.", "info");
                return;
            }
            if (!enabled) {
                if (timer) clearTimeout(timer);
                timer = null;
                install(); // clears the factory → default context bar returns
                piweb.notify(
                    "Custom footer off (default context bar).",
                    "info",
                );
                return;
            }
            stats = await gitStats(pi, root);
            install();
            piweb.refreshFooter();
        },
    });
}
