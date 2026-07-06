/**
 * pi-web theme manager.
 *
 * Mirrors the active pi theme into the web UI: reads pi's `settings.json` ->
 * `themes/<name>.json` under the agent dir and resolves it to the web UI's CSS
 * custom properties (`--acc`, `--err`, `--tool-success-bg`, …). Missing tokens
 * fall back to the client's `:root` defaults.
 *
 * Extracted from server.ts. It owns only theme concerns: palette resolution,
 * the memoized active palette, live-reload on external edits, theme enumeration,
 * and switching/persisting. The one collaborator it needs is a `broadcast`
 * function (the SSE bus) so palette changes reach every viewer.
 *
 * Construct it *before* the first thread is created: extensions loaded during
 * `createThread` can call `piweb.setFooter`, which triggers `footerFrame` ->
 * `manager.vars()`. `vars()` is lazy (memoizes on first call), so as long as the
 * manager object exists the read is safe — no module-init temporal-dead-zone
 * hazard like the former module-level `var piThemeCache`.
 */
import { join } from "node:path";
import {
    readFileSync,
    writeFileSync,
    readdirSync,
    existsSync,
    watch,
} from "node:fs";
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";

/** A frame broadcast to every connected viewer (the SSE bus `broadcast`). */
type Broadcast = (frame: {
    kind: "theme";
    vars: Record<string, string>;
}) => void;

export interface ThemeManager {
    /** The active pi theme palette as web CSS vars (memoized on first use). */
    vars(): Record<string, string>;
    /**
     * Loadable themes (pi's built-ins ∪ the agent's `themes/` dir), the web
     * analog of pi-tui `ui.getAllThemes`. A same-named agent theme overrides the
     * built-in. Names are bare filenames (sans `.json`), matching `apply()`.
     */
    list(): { name: string; path: string }[];
    /**
     * Whether `name` resolves to a loadable theme file (drives pi-tui
     * `ui.getTheme`'s "known name?" check without re-reading the palette).
     */
    has(name: string): boolean;
    /**
     * Switch + persist the active theme (pi-tui `ui.setTheme` analog): recompute
     * the palette for `name`, write it to `settings.json`, and rebroadcast a
     * `theme` frame to every viewer. Returns `{ success }`.
     */
    apply(name: string): { success: boolean; error?: string };
    /**
     * Re-read the theme from disk, refresh the memoized cache, and rebroadcast
     * it. Invoked by the settings watcher when settings.json / a theme file
     * changes outside pi-web.
     */
    refresh(): void;
    /**
     * Start watching `settings.json` + `themes/` for external edits so the pi
     * TUI switching/disabling a theme (or a hand edit) goes live in the browser
     * instead of waiting for a restart. Best-effort; returns a disposer.
     */
    watch(): () => void;
}

// pi's built-in themes (dark/light + others) ship *inside* the package, not in
// ~/.pi/agent/themes. This is the dir that holds their JSON definitions.
function builtinThemesDir(): string {
    return join(getPackageDir(), "dist", "modes", "interactive", "theme");
}

// Resolve a theme name to its JSON file, preferring the user's agent themes dir
// and falling back to pi's built-in themes. Returns null if neither has it.
function resolveThemeFile(name: string): string | null {
    for (const base of [join(getAgentDir(), "themes"), builtinThemesDir()]) {
        const p = join(base, `${name}.json`);
        if (existsSync(p)) return p;
    }
    return null;
}

/**
 * Resolve a theme name (or the active default) to the web UI's CSS-var palette.
 * A web server has no TTY for pi's terminal-bg detection (getDefaultTheme), so
 * we mirror its headless fallback: dark. Returns `{}` when the theme can't be
 * loaded (the client keeps its `:root` defaults).
 */
export function loadPiTheme(nameOverride?: string): Record<string, string> {
    try {
        // Resolve the active theme name: explicit override > settings.json >
        // pi's built-in default.
        let name = nameOverride;
        if (!name) {
            try {
                const settings = JSON.parse(
                    readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
                );
                name = settings.theme;
            } catch {
                /* no/unreadable settings.json — fall through to the default */
            }
        }
        // pi's "auto"/"auto:light=…,dark=…" settings pick by terminal background;
        // headless, we mirror its dark fallback.
        if (!name || name === "auto" || String(name).startsWith("auto:"))
            name = "dark";
        const file = resolveThemeFile(name);
        if (!file) return {};
        return themeJsonToVars(JSON.parse(readFileSync(file, "utf8")));
    } catch {
        return {};
    }
}

/**
 * Map a parsed pi theme JSON object to the web UI's CSS-var palette. Pure (no
 * disk I/O) so it's unit-testable in isolation; `loadPiTheme` handles name
 * resolution + file reads and delegates the mapping here.
 */
export function themeJsonToVars(theme: any): Record<string, string> {
    try {
        const vars = theme.vars ?? {};
        const colors = theme.colors ?? {};
        const pick = (t: string) => vars[colors[t] ?? t] ?? vars[t] ?? null;
        // Like pick, but tolerates direct hex literals in `colors` (the thinking
        // tokens are a mix of named refs e.g. "darkGray" and raw hex "#81a2be").
        const resolve = (x: any) =>
            typeof x === "string" && x.startsWith("#") ? x : (vars[x] ?? null);
        const pickC = (t: string) => resolve(colors[t] ?? t);
        // Resolve the `export` block (raw var refs, e.g. { pageBg: "bg" }).
        const exp = theme.export ?? {};
        const pickE = (t: string) => (exp[t] != null ? resolve(exp[t]) : null);
        const map = {
            "--bg": pick("bg"),
            "--panel": vars.surface ?? null,
            "--line": pick("border"),
            "--txt": pick("text"),
            "--muted": pick("muted"),
            "--dim": pick("dim"),
            "--acc": pick("accent"),
            "--acc2": vars.magenta ?? pick("accent"),
            "--ok": pick("success"),
            "--warn": pick("warning"),
            "--err": pick("error"),
            // thinking-level composer border colors (mirror the pi TUI theme)
            "--think-off": pickC("thinkingOff"),
            "--think-minimal": pickC("thinkingMinimal"),
            "--think-low": pickC("thinkingLow"),
            "--think-medium": pickC("thinkingMedium"),
            "--think-high": pickC("thinkingHigh"),
            "--think-xhigh": pickC("thinkingXhigh"),
            "--bash-mode": pickC("bashMode"),
            // tool-card status tints + title/output (literal theme slots, so the
            // web washes cards with the exact colors the TUI uses — no color-mix)
            "--tool-pending-bg": pick("toolPendingBg"),
            "--tool-success-bg": pick("toolSuccessBg"),
            "--tool-error-bg": pick("toolErrorBg"),
            "--tool-title": pick("toolTitle"),
            "--tool-output": pick("toolOutput"),
            // markdown styling
            "--md-heading": pick("mdHeading"),
            "--md-link": pick("mdLink"),
            "--md-link-url": pick("mdLinkUrl"),
            "--md-code": pick("mdCode"),
            "--md-code-block": pick("mdCodeBlock"),
            "--md-code-block-border": pick("mdCodeBlockBorder"),
            "--md-quote": pick("mdQuote"),
            "--md-quote-border": pick("mdQuoteBorder"),
            "--md-hr": pick("mdHr"),
            "--md-list-bullet": pick("mdListBullet"),
            // diff colors (pairs with #19 syntax/diff rendering)
            "--diff-added": pick("toolDiffAdded"),
            "--diff-removed": pick("toolDiffRemoved"),
            "--diff-context": pick("toolDiffContext"),
            // syntax highlighting slots (pairs with #19)
            "--syn-comment": pick("syntaxComment"),
            "--syn-keyword": pick("syntaxKeyword"),
            "--syn-function": pick("syntaxFunction"),
            "--syn-variable": pick("syntaxVariable"),
            "--syn-string": pick("syntaxString"),
            "--syn-number": pick("syntaxNumber"),
            "--syn-type": pick("syntaxType"),
            "--syn-operator": pick("syntaxOperator"),
            "--syn-punctuation": pick("syntaxPunctuation"),
            // message styling
            "--selected-bg": pick("selectedBg"),
            "--user-msg-bg": pick("userMessageBg"),
            "--user-msg-text": pick("userMessageText"),
            "--custom-msg-bg": pick("customMessageBg"),
            "--custom-msg-text": pick("customMessageText"),
            "--custom-msg-label": pick("customMessageLabel"),
            // misc raw palette slots exposed for extensions / future use
            "--hover": pick("hover"),
            "--border-variant": pick("borderVariant"),
            "--comment": pick("comment"),
            "--cyan": pick("cyan"),
            "--bright-cyan": pick("brightCyan"),
            "--dim-blue": pick("dimBlue"),
            // export block (TUI HTML-export palette; surfaced for parity)
            "--export-page-bg": pickE("pageBg"),
            "--export-card-bg": pickE("cardBg"),
            "--export-info-bg": pickE("infoBg"),
        };
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(map)) if (v) out[k] = v;
        return out;
    } catch {
        return {};
    }
}

/**
 * Enumerate the loadable themes (built-ins ∪ agent themes). Exported standalone
 * so it can be unit-tested without constructing a manager.
 */
export function listThemeNames(): { name: string; path: string }[] {
    // A same-named agent theme overrides the built-in (matches resolveThemeFile's
    // priority).
    const seen = new Map<string, string>();
    for (const base of [builtinThemesDir(), join(getAgentDir(), "themes")]) {
        try {
            for (const f of readdirSync(base)) {
                if (!f.endsWith(".json") || f === "theme-schema.json") continue;
                seen.set(f.slice(0, -".json".length), join(base, f));
            }
        } catch {
            /* dir may not exist (e.g. no agent themes yet) */
        }
    }
    return [...seen]
        .map(([name, path]) => ({ name, path }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create the theme manager. `broadcast` is the SSE bus fan-out; palette changes
 * (switch / external edit) are pushed to every viewer through it.
 */
export function createThemeManager(broadcast: Broadcast): ThemeManager {
    // Active palette, memoized on first use (see the module header for why the
    // read must stay lazy rather than a module-level const).
    let cache: Record<string, string> | undefined;
    // Keys sent in the most recent `theme` frame (seeded lazily from the initial
    // palette). Used to compute which CSS vars to *reset* when the theme changes
    // and drops tokens: disabling a theme yields `{}`, but the client only ever
    // *sets* vars, so without an explicit reset the old colors would stay stuck.
    let lastThemeKeys: string[] | undefined;

    const vars = (): Record<string, string> => {
        if (cache === undefined) cache = loadPiTheme();
        return cache;
    };

    // Rebroadcast the active palette to every viewer. Any key present last time
    // but absent now is sent as "" so the client removes the custom property and
    // falls back to its :root default (full reset on theme-disable).
    const broadcastTheme = (next: Record<string, string>) => {
        if (lastThemeKeys === undefined) lastThemeKeys = Object.keys(vars());
        const frame: Record<string, string> = { ...next };
        for (const k of lastThemeKeys) if (!(k in frame)) frame[k] = "";
        lastThemeKeys = Object.keys(next);
        broadcast({ kind: "theme", vars: frame });
    };

    const refresh = () => {
        cache = loadPiTheme();
        broadcastTheme(cache);
    };

    const apply = (name: string): { success: boolean; error?: string } => {
        const next = loadPiTheme(name);
        if (!next || Object.keys(next).length === 0)
            return { success: false, error: `theme not found: ${name}` };
        cache = next;
        // Persist the choice so a reload / new session keeps it (mirrors the TUI
        // writing the theme to settings). Best-effort: a read-only settings file
        // still switches the live UI for this process.
        try {
            const settingsPath = join(getAgentDir(), "settings.json");
            const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
            settings.theme = name;
            writeFileSync(
                settingsPath,
                JSON.stringify(settings, null, 2) + "\n",
            );
        } catch {
            /* live switch still applies even if persistence fails */
        }
        broadcastTheme(next);
        return { success: true };
    };

    const watchFs = (): (() => void) => {
        const watchers: { close(): void }[] = [];
        try {
            const dir = getAgentDir();
            let debounce: ReturnType<typeof setTimeout> | null = null;
            const bump = () => {
                // Editors/tools emit several events per save; coalesce them.
                if (debounce) clearTimeout(debounce);
                debounce = setTimeout(refresh, 80);
            };
            watchers.push(
                watch(join(dir, "settings.json"), { persistent: false }, bump),
            );
            watchers.push(
                watch(join(dir, "themes"), { persistent: false }, bump),
            );
        } catch {
            /* watching is best-effort; the in-app theme switch still works */
        }
        return () => {
            for (const w of watchers) {
                try {
                    w.close();
                } catch {
                    /* ignore */
                }
            }
        };
    };

    return {
        vars,
        list: listThemeNames,
        has: (name) => listThemeNames().some((t) => t.name === name),
        apply,
        refresh,
        watch: watchFs,
    };
}
