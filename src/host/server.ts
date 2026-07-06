/**
 * pi-web host: runs the pi agent in-process (createAgentSession) and serves a
 * web UI. Browser bus is SSE (server->client) + POST (client->server) so
 * there are zero extra dependencies.
 *
 * Transport (SSE/POST/static/health/threads) lives in ./app.mjs and is
 * agent-independent; this file owns agent bootstrap, the event -> server message
 * translation, and the thread (session) lifecycle.
 *
 * Multi-thread model
 * ------------------
 * Every thread is a fully independent AgentSession (bound to its own
 * SessionManager + extension resourceLoader + piweb panel registry), kept alive
 * in `threadRuntimes`. Threads run *in parallel*: a background thread keeps
 * processing its turn even when no browser is looking at it.
 *
 * Selection is per-client, driven by the URL (`/?thread=<id>` ⇒
 * `/events?thread=<id>`). Each SSE connection is tagged with the thread it is
 * viewing, and a thread's events are routed only to the clients viewing it
 * (`bus.broadcastToThread`). Different browser tabs can therefore watch
 * different threads at the same time; "switching" is just reopening the SSE
 * stream with a new `?thread`. Nothing is ever disposed, so no work is lost.
 *
 * Because there is no single server-wide "focused" thread, every mutating
 * request (`/prompt`, `/bash`, `/action`, `/session/*`, `/reload`) carries the
 * thread id it targets.
 */
import { readFile, readdir, unlink } from "node:fs/promises";
import { statSync, existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    getAgentDir,
    getPackageDir,
    AuthStorage,
    ModelRegistry,
    ProjectTrustStore,
    hasTrustRequiringProjectResources,
    SettingsManager,
    type AgentSession,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { renderToolResultToNode } from "./component-adapter.ts";
import { webPaletteTheme } from "./tui-theme.ts";

// Built-in tools pi-web renders natively (client renderers / default body). We
// only attach a component-adapter `tree` (render-model parity P1) for
// *extension* tools with a custom renderResult, so built-in rendering is
// unchanged; the client also prefers its own registered renderer over the tree.
const WEB_BUILTIN_TOOLS = new Set([
    "bash",
    "shell",
    "edit",
    "read",
    "write",
    "ls",
    "grep",
    "find",
    "apply_patch",
    "multiedit",
    "todo_write",
    "task",
]);

import { createPiWebHost } from "./piweb-host.ts";
import { makeWebBundler } from "./build-web.ts";
import { createBus, createApp } from "./app.ts";
import { openApp, probeRunningInstance, browserHost } from "./open-app.ts";
import { createThemeManager } from "./theme.ts";
import { createRequire } from "node:module";

// pi version, for the startup banner (mirrors the TUI's `pi v<version>` logo).
const PI_VERSION = (() => {
    try {
        return createRequire(import.meta.url)(
            "@earendil-works/pi-coding-agent/package.json",
        ).version as string;
    } catch {
        return "";
    }
})();

type PiWebRegistry = ReturnType<typeof createPiWebHost>;

/** A serializable server->client message frame. */
type ServerMessage = { kind: string; [k: string]: any };

/** A live, independently-running conversation thread. */
interface ThreadRuntime {
    id: string;
    cwd: string;
    sm: SessionManager;
    session: AgentSession | null;
    pi: ExtensionAPI | null;
    piweb: PiWebRegistry | null;
    resourceLoader: DefaultResourceLoader | null;
    unsubscribe: (() => void) | null;
    busy: boolean;
    /** Live git-branch watcher (drives `FooterData.gitBranch` reactively). */
    gitWatcher: GitBranchWatcher | null;
}

/** Cached git branch + a filesystem watcher that refreshes it on checkout. */
interface GitBranchWatcher {
    getBranch(): string | null;
    dispose(): void;
}

/**
 * A live, independently-running conversation thread.
 *
 * @typedef {object} ThreadRuntime
 * @property {string} id                       session id (stable registry key)
 * @property {string} cwd                      this thread's working directory
 * @property {SessionManager} sm               this thread's session manager
 * @property {AgentSession|null} session       the in-process agent session
 * @property {ExtensionAPI|null} pi            this thread's live ExtensionAPI
 * @property {PiWebRegistry|null} piweb        this thread's panel registry
 * @property {DefaultResourceLoader|null} resourceLoader  extension loader
 * @property {(() => void)|null} unsubscribe   detaches the event listener
 * @property {boolean} busy                    a turn is currently in flight
 */

/** A serializable server->client message frame. @typedef {{kind:string,[k:string]:any}} ServerMessage */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? "0.0.0.0";
// The process working directory: the default/root for new threads and the
// fallback for sessions whose stored cwd is unknown. Per-thread cwd lives on
// each ThreadRuntime (sourced from its SessionManager header); pi binds cwd at
// session creation, so "changing directory" means starting a thread elsewhere.
const cwd = process.cwd();

// Project-trust store (pi's shared ~/.pi/agent/trust.json). Declared early: the
// default thread is created at module init (below) and createThread reads the
// saved decision to pin the hard trust gate before loading project resources.
const trustStore = new ProjectTrustStore(getAgentDir());
// Threads we've shown the first-load trust prompt for this process, so
// reconnects/refreshes don't re-nag after the user has seen (or dismissed) it.
const trustPrompted = new Set<string>();

// If a pi-web instance is already serving on this port, don't boot a second
// server (it would only fail to bind). Instead, open the existing instance in
// the default browser as a chromeless --app window and exit. Probing here —
// before the heavy agent bootstrap below — keeps the reuse path instant.
{
    const already = await probeRunningInstance(HOST, PORT);
    if (already) {
        const url = `http://${browserHost(HOST)}:${PORT}`;
        console.log(`\n  pi-web already running \u2192 opening ${url}\n`);
        await openApp(url);
        process.exit(0);
    }
}

// Directories pi-web has live/known threads in, so the thread list can span
// multiple working dirs (on-disk sessions are partitioned per-cwd). Seeded with
// the root; grows as threads are created in other directories this run.
/** @type {Set<string>} */
const knownCwds = new Set([cwd]);

/**
 * Resolve a user-supplied directory for a new thread. Relative paths resolve
 * against the root cwd, `~` expands to $HOME, and the target must be an existing
 * directory — otherwise we throw so the client can surface a clear error rather
 * than booting a session in a bogus place.
 * @param {string} [dir]
 * @returns {string}
 */
function resolveThreadCwd(dir?: string) {
    const raw = (dir ?? "").trim();
    if (!raw) return cwd;
    const expanded = raw.startsWith("~")
        ? join(process.env.HOME ?? "", raw.slice(1))
        : raw;
    const abs = resolve(cwd, expanded);
    let st;
    try {
        st = statSync(abs);
    } catch {
        throw new Error(`no such directory: ${abs}`);
    }
    if (!st.isDirectory()) throw new Error(`not a directory: ${abs}`);
    return abs;
}

// ---- project file list (for the `@` mention typeahead) --------------------
// Prefer `git ls-files` (fast, respects .gitignore); fall back to a bounded
// filesystem walk for non-git working dirs. Results are cached briefly so a
// burst of keystrokes doesn't re-shell on every request, while newly created
// files still surface within a few seconds.
const FILE_CACHE_TTL_MS = 4000;
const FILE_LIST_CAP = 10000;
const WALK_SKIP = new Set([
    ".git",
    "node_modules",
    ".cache",
    "dist",
    "build",
    "coverage",
    ".next",
]);
/** Per-directory file-list cache (the `@` typeahead is scoped to a thread's cwd). @type {Map<string, { at: number, items: string[] }>} */
const fileCacheByDir = new Map();

async function walkFiles(dir: string, base: string, out: string[]) {
    if (out.length >= FILE_LIST_CAP) return;
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const ent of entries) {
        if (out.length >= FILE_LIST_CAP) return;
        if (ent.name.startsWith(".") && ent.name !== ".") {
            if (WALK_SKIP.has(ent.name)) continue;
        }
        if (WALK_SKIP.has(ent.name)) continue;
        const abs = join(dir, ent.name);
        if (ent.isDirectory()) {
            await walkFiles(abs, base, out);
        } else if (ent.isFile()) {
            out.push(relative(base, abs).split(sep).join("/"));
        }
    }
}

/**
 * List project files for the `@` mention typeahead, scoped to a thread's cwd.
 * @param {string} [dir]
 */
async function listProjectFiles(dir?: string) {
    const base = dir || cwd;
    const cached = fileCacheByDir.get(base);
    if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS) {
        return cached.items;
    }
    let items: string[];
    try {
        const { stdout } = await execFileP(
            "git",
            ["ls-files", "--cached", "--others", "--exclude-standard"],
            { cwd: base, maxBuffer: 64 * 1024 * 1024 },
        );
        items = stdout.split("\n").filter(Boolean).slice(0, FILE_LIST_CAP);
    } catch {
        items = [];
        await walkFiles(base, base, items);
    }
    fileCacheByDir.set(base, { at: Date.now(), items });
    return items;
}

/**
 * Directory suggestions for the `/new <dir>` typeahead. Resolves the partial
 * `q` against the viewing thread's cwd (or the root), expands `~`, and lists
 * matching subdirectories as absolute paths the client can splice in and drill.
 * @param {string} q
 * @param {string} [threadId]
 */
async function listProjectDirs(q: string, threadId?: string) {
    const baseCwd =
        (threadId ? threadRuntimes.get(threadId) : undefined)?.cwd || cwd;
    const raw = (q ?? "").trim();
    const expand = (p: string) =>
        p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p;
    let listDir;
    let prefix;
    if (!raw) {
        listDir = baseCwd;
        prefix = "";
    } else {
        const abs = resolve(baseCwd, expand(raw));
        if (raw.endsWith("/")) {
            listDir = abs;
            prefix = "";
        } else {
            listDir = dirname(abs);
            prefix = basename(abs).toLowerCase();
        }
    }
    let ents;
    try {
        ents = await readdir(listDir, { withFileTypes: true });
    } catch {
        return [];
    }
    const items: { value: string; label: string; description: string }[] = [];
    for (const e of ents) {
        if (!e.isDirectory()) continue;
        // hide dotdirs unless the user is explicitly typing one
        if (e.name.startsWith(".") && !prefix.startsWith(".")) continue;
        if (prefix && !e.name.toLowerCase().startsWith(prefix)) continue;
        const abs = join(listDir, e.name);
        items.push({ value: abs, label: e.name, description: abs });
    }
    items.sort((a, b) => a.label.localeCompare(b.label));
    return items.slice(0, 50);
}

// ---- browser bus (SSE) ----------------------------------------------------
const bus = createBus();
const broadcast = bus.broadcast;

// ---- theme (pi settings.json -> web CSS vars) -----------------------------
// Constructed before any thread is created: extensions loaded during
// createThread can call piweb.setFooter -> footerFrame -> theme.vars(), so the
// manager (and its lazy palette cache) must already exist. See ./theme.ts.
const theme = createThemeManager(bus.broadcast);

// ---- thread registry ------------------------------------------------------
const threadRuntimes = new Map<string, ThreadRuntime>();
/** Fallback thread for clients that connect without a `?thread`. */
let defaultThread: ThreadRuntime | null = null;
/** Thread whose extensions are registering panels *right now* (during boot/reload). */
let bindingThread: ThreadRuntime | null = null;
/** Thread currently handling a panel action dispatch. */
let dispatchingThread: ThreadRuntime | null = null;
/** Thread whose extension code is executing now (event handlers route surface
 * updates here). */
let currentThread: ThreadRuntime | null = null;

const sessionFor = (id: string | undefined | null) =>
    id ? (threadRuntimes.get(id)?.session ?? null) : null;

// ---- piweb router (injected into extensions) ------------------------------
// Each thread has its own panel registry; the global __PIWEB__ that extensions
// talk to routes to whichever thread is currently binding (during boot/reload)
// or dispatching (during a panel action). Panel writes reach only the clients
// viewing that thread, via the thread registry's broadcast().
const nullRegistry = {
    setWidget() {},
    removeWidget() {},
    dock() {},
    overlay() {},
    removeDock() {},
    removeOverlay() {},
    remove() {},
    openOverlay() {},
    closeOverlay() {},
    custom() {
        return Promise.resolve(undefined);
    },
    notify() {},
    setStatus() {},
    getStatuses() {
        return [];
    },
    setFooter() {},
    refreshFooter() {},
    getFooterFactory() {
        return undefined;
    },
    setHeader() {},
    refreshHeader() {},
    getHeaderFactory() {
        return undefined;
    },
    setTitle() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    getWorkingConfig() {
        return {};
    },
    setHiddenThinkingLabel() {},
    getHiddenThinkingLabel() {
        return "Thinking...";
    },
    setEditorText() {},
    getEditorText() {
        return "";
    },
    pasteToEditor() {},
    updateEditorText() {},
    getToolsExpanded() {
        return false;
    },
    setToolsExpanded() {},
    theme: undefined,
    getAllThemes() {
        return [];
    },
    getTheme() {
        return undefined;
    },
    setTheme() {
        return { success: false, error: "no active thread" };
    },
    registerMessageRenderer() {},
    hasMessageRenderer() {
        return false;
    },
    renderMessage() {
        return null;
    },
    addAutocompleteProvider() {
        return () => {};
    },
    hasAutocomplete() {
        return false;
    },
    autocomplete() {
        return Promise.resolve(null);
    },
    select() {
        return Promise.resolve(undefined);
    },
    confirm() {
        return Promise.resolve(false);
    },
    input() {
        return Promise.resolve(undefined);
    },
    editor() {
        return Promise.resolve(undefined);
    },
    resolveUiRequest() {},
    clear() {},
    snapshot() {
        return {
            docks: { left: [], right: [], bottom: [], footer: [] },
            overlays: [],
            status: [],
            dialogs: [],
        };
    },
    async dispatch() {},
};
const activeRegistry = (): any =>
    (bindingThread ?? dispatchingThread ?? currentThread)?.piweb ??
    nullRegistry;
const piweb = {
    present: true,
    // medium marker (pi-tui `ctx.mode` analog): portable extensions branch on
    // `piweb.mode === "web"`.
    mode: "web" as const,
    setWidget: (...a: any[]) => activeRegistry().setWidget(...a),
    removeWidget: (...a: any[]) => activeRegistry().removeWidget(...a),
    dock: (...a: any[]) => activeRegistry().dock(...a),
    overlay: (...a: any[]) => activeRegistry().overlay(...a),
    removeDock: (...a: any[]) => activeRegistry().removeDock(...a),
    removeOverlay: (...a: any[]) => activeRegistry().removeOverlay(...a),
    remove: (...a: any[]) => activeRegistry().remove(...a),
    openOverlay: (...a: any[]) => activeRegistry().openOverlay(...a),
    closeOverlay: (...a: any[]) => activeRegistry().closeOverlay(...a),
    // custom components (pi-tui `ctx.ui.custom`) — mounts an overlay surface
    // and resolves when the extension calls `done(result)`.
    custom: (...a: any[]) => activeRegistry().custom(...a),
    notify: (...a: any[]) => activeRegistry().notify(...a),
    setStatus: (...a: any[]) => activeRegistry().setStatus(...a),
    // footer replacement (pi-tui `ctx.ui.setFooter`) + explicit refresh
    setFooter: (...a: any[]) => activeRegistry().setFooter(...a),
    refreshFooter: (...a: any[]) => activeRegistry().refreshFooter(...a),
    // header replacement (pi-tui `ctx.ui.setHeader`) + explicit refresh
    setHeader: (...a: any[]) => activeRegistry().setHeader(...a),
    refreshHeader: (...a: any[]) => activeRegistry().refreshHeader(...a),
    setTitle: (...a: any[]) => activeRegistry().setTitle(...a),
    // streaming working-indicator overrides (pi ui.setWorking*)
    setWorkingMessage: (...a: any[]) =>
        activeRegistry().setWorkingMessage(...a),
    setWorkingVisible: (...a: any[]) =>
        activeRegistry().setWorkingVisible(...a),
    setWorkingIndicator: (...a: any[]) =>
        activeRegistry().setWorkingIndicator(...a),
    setHiddenThinkingLabel: (...a: any[]) =>
        activeRegistry().setHiddenThinkingLabel(...a),
    // composer text bridge (pi ui.setEditorText/getEditorText/pasteToEditor)
    setEditorText: (...a: any[]) => activeRegistry().setEditorText(...a),
    getEditorText: (...a: any[]) => activeRegistry().getEditorText(...a),
    pasteToEditor: (...a: any[]) => activeRegistry().pasteToEditor(...a),
    // tool-output expansion (pi ui.getToolsExpanded/setToolsExpanded)
    getToolsExpanded: (...a: any[]) => activeRegistry().getToolsExpanded(...a),
    setToolsExpanded: (...a: any[]) => activeRegistry().setToolsExpanded(...a),
    // theme API (pi ui.theme/getAllThemes/getTheme/setTheme)
    get theme() {
        return activeRegistry().theme;
    },
    getAllThemes: (...a: any[]) => activeRegistry().getAllThemes(...a),
    getTheme: (...a: any[]) => activeRegistry().getTheme(...a),
    setTheme: (...a: any[]) => activeRegistry().setTheme(...a),
    // custom transcript-message renderers (customType -> serializable tree)
    registerMessageRenderer: (...a: any[]) =>
        activeRegistry().registerMessageRenderer(...a),
    hasMessageRenderer: (...a: any[]) =>
        activeRegistry().hasMessageRenderer(...a),
    renderMessage: (...a: any[]) => activeRegistry().renderMessage(...a),
    // composer autocomplete providers (piweb.addAutocompleteProvider)
    addAutocompleteProvider: (...a: any[]) =>
        activeRegistry().addAutocompleteProvider(...a),
    // blocking dialogs — return promises that settle on the browser's response
    select: (...a: any[]) => activeRegistry().select(...a),
    confirm: (...a: any[]) => activeRegistry().confirm(...a),
    input: (...a: any[]) => activeRegistry().input(...a),
    editor: (...a: any[]) => activeRegistry().editor(...a),
    clear: (...a: any[]) => activeRegistry().clear(...a),
    snapshot: () => activeRegistry().snapshot(),
    /**
     * Resolve a thread's concrete surface registry by its session id (== thread
     * id). Lets event-driven extensions write to *their own*
     * thread's surface without relying on the global `currentThread` pointer —
     * which is set by the server listener that runs *after* extension handlers,
     * so it is stale/cross-thread when an extension's `pi.on(...)` fires.
     * Returns null when the thread isn't registered yet (e.g. during
     * session_start, before threadRuntimes is populated) so callers fall back to
     * the global router (which routes via bindingThread at that moment).
     * @param {string|undefined|null} id
     */
    forSession(id: string | undefined | null) {
        return (id && threadRuntimes.get(id)?.piweb) || null;
    },
    /**
     * Route a surface action to the owning thread's registry.
     * @param {string} surfaceId
     * @param {string} action
     * @param {any} payload
     * @param {string} [threadId]
     */
    async dispatch(
        surfaceId: string,
        action: string,
        payload: any,
        threadId?: string,
    ) {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        if (!t?.piweb) return;
        dispatchingThread = t;
        try {
            await t.piweb.dispatch(surfaceId, action, payload);
        } finally {
            dispatchingThread = null;
        }
    },
};
globalThis.__PIWEB__ = piweb;

// Model selection precedence:
//   1. PI_PROVIDER / PI_MODEL env vars (explicit override, always wins)
//   2. pi's own settings.json default (defaultProvider/defaultModel) — this is
//      already resolved onto session.state.model by createAgentSession, so we
//      leave it untouched when the user has configured a pi default
//   3. the `meridian` fallback, when neither of the above applies
// pi-meridian registers its provider *during* session startup, so meridian is
// only resolvable after createAgentSession; hence the post-hoc pin.
const ENV_PROVIDER = process.env.PI_PROVIDER;
const ENV_MODEL_ID = process.env.PI_MODEL;
const FALLBACK_PROVIDER = "meridian";
const FALLBACK_MODEL_ID = "claude-opus-4-8";
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// ---- text helpers ---------------------------------------------------------
/**
 * Pull plain text out of a message's content (string | block[]).
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("");
}
/**
 * Pull image blocks out of a message's content (block[] only). Images live as
 * `{ type:"image", data:base64, mimeType }` content blocks; returns the
 * `{ data, mimeType }` records the web client renders as inline thumbnails.
 * @param {unknown} content
 * @returns {{data:string; mimeType:string}[]}
 */
function imagesOf(content: unknown): { data: string; mimeType: string }[] {
    if (!Array.isArray(content)) return [];
    return content
        .filter((b) => b?.type === "image" && b.data)
        .map((b) => ({ data: b.data, mimeType: b.mimeType }));
}
/**
 * Pull thinking/reasoning text out of a message's content (block[] only).
 * Thinking lives as `{ type:"thinking", thinking, redacted? }` content blocks.
 * @param {unknown} content
 * @returns {string}
 */
function thinkingOf(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b?.type === "thinking" && !b.redacted)
        .map((b) => b.thinking ?? "")
        .join("");
}
/**
 * Current persisted "hide thinking blocks" pi setting for a session.
 * @param {AgentSession|null|undefined} s
 * @returns {boolean}
 */
function thinkingHidden(s: AgentSession | null | undefined) {
    try {
        return !!s?.settingsManager?.getHideThinkingBlock?.();
    } catch {
        return false;
    }
}
/**
 * Build the `thinking_level` frame for a session: current reasoning level, the
 * levels the active model supports, and whether thinking is supported at all
 * (a model with a single level — e.g. only "off" — can't be cycled). Drives the
 * focused composer border color in the web UI (mirrors the pi TUI editor
 * border via theme.getThinkingBorderColor).
 * @param {AgentSession|null|undefined} s
 * @returns {{kind:"thinking_level", level:string, available:string[], supported:boolean}}
 */
function thinkingLevelFrame(s: AgentSession | null | undefined) {
    let level = "off";
    let available: string[] = [];
    try {
        level = s?.thinkingLevel || "off";
        available = s?.getAvailableThinkingLevels?.() ?? [];
    } catch {
        /* best-effort: fall back to off / no levels */
    }
    return {
        kind: "thinking_level",
        level,
        available,
        supported: available.length > 1,
    };
}

/**
 * Collapse an absolute cwd to `~`-relative form for display, mirroring the pi
 * TUI footer's `formatCwdForFooter`.
 * @param {string} dir
 * @param {string} home
 * @returns {string}
 */
function formatCwdForFooter(dir: string, home: string) {
    if (!home) return dir;
    const rel = relative(resolve(home), resolve(dir));
    const inside =
        rel === "" ||
        (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) return dir;
    return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Build the `footer` frame: the default below-composer context bar that mirrors
 * the pi TUI footer (FooterComponent) — a pwd/session line plus a token-stats /
 * `<model> • thinking <level>` line. Best-effort: any missing piece degrades to
 * a sane default rather than throwing.
 * @param {AgentSession|null|undefined} s
 * @param {string} [threadCwd]
 */
/**
 * Find the surface registry that owns a given session (reverse lookup), so
 * `footerFrame` can apply an extension's `setFooter` factory without every
 * call site having to thread the registry through.
 */
// O(1) session -> thread index (self-healing): footer/header rebuilds resolve
// the owning thread by session identity without an O(threads) scan each emit.
const sessionIndex = new Map<AgentSession, ThreadRuntime>();
function threadForSession(
    s: AgentSession | null | undefined,
): ThreadRuntime | null {
    if (!s) return null;
    const hit = sessionIndex.get(s);
    if (hit && hit.session === s) return hit;
    // Miss (or a session swapped after fork/switch): rebuild lazily.
    for (const t of threadRuntimes.values()) {
        if (t.session) sessionIndex.set(t.session, t);
        if (t.session === s) return t;
    }
    return null;
}
function registryForSession(s: AgentSession | null | undefined): any {
    return threadForSession(s)?.piweb ?? null;
}

/** Remove a thread from the registry, disposing its git watcher + index entry. */
function evictThread(id: string) {
    const t = threadRuntimes.get(id);
    if (t) {
        try {
            t.gitWatcher?.dispose();
        } catch {
            /* ignore */
        }
        if (t.session) sessionIndex.delete(t.session);
    }
    threadRuntimes.delete(id);
}

/**
 * Watch a repo's `.git` for HEAD/ref changes and keep the current branch name
 * cached, calling `onChange` when it flips (checkout / detach) — the host side
 * of `FooterData.gitBranch` (pi-tui `footerData.getGitBranch` + `onBranchChange`
 * parity). Best-effort: outside a repo it simply reports `null`.
 */
function createGitBranchWatcher(
    dir: string,
    onChange: () => void,
): GitBranchWatcher {
    let branch: string | null = null;
    let disposed = false;
    let watcher: FSWatcher | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const set = (val: string | null) => {
        if (disposed || val === branch) return;
        branch = val;
        onChange();
    };
    const refresh = () => {
        execFile(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: dir, timeout: 5000 },
            (err, out) => {
                if (disposed) return;
                if (err) return set(null);
                const b = String(out).trim();
                if (b !== "HEAD") return set(b);
                // Detached HEAD -> short SHA.
                execFile(
                    "git",
                    ["rev-parse", "--short", "HEAD"],
                    { cwd: dir, timeout: 5000 },
                    (e2, o2) =>
                        disposed || set(e2 ? null : `@${String(o2).trim()}`),
                );
            },
        );
    };
    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 150); // debounce rapid .git churn
    };
    try {
        watcher = watch(join(dir, ".git"), { persistent: false }, (_e, f) => {
            const name = f ? String(f) : "";
            // HEAD flips on checkout; refs/packed-refs on branch create/delete.
            if (
                !name ||
                name === "HEAD" ||
                name === "packed-refs" ||
                name.startsWith("refs")
            )
                schedule();
        });
    } catch {
        /* not a git repo (or .git missing) — branch stays null */
    }
    refresh();
    return {
        getBranch: () => branch,
        dispose: () => {
            disposed = true;
            try {
                watcher?.close();
            } catch {
                /* ignore */
            }
            if (timer) clearTimeout(timer);
        },
    };
}

/**
 * Compute the live `FooterData` for a thread (shared by the footer and header
 * frames). Best-effort: any missing piece degrades to a sane default.
 */
function buildFooterData(
    s: AgentSession | null | undefined,
    threadCwd: string,
    thread: ThreadRuntime | null,
    registry: any,
) {
    let model = null;
    let reasoning = false;
    let level = "off";
    let session = null;
    let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    let sub = false;
    let context: { percent: number | null; window: number } = {
        percent: null,
        window: 0,
    };
    let autoCompact = false;
    let cwdStr = threadCwd || cwd;
    try {
        const st = s?.state;
        model = st?.model?.id ?? null;
        reasoning = !!st?.model?.reasoning;
        level = s?.thinkingLevel || "off";
        const sm = s?.sessionManager;
        session = sm?.getSessionName?.() || null;
        cwdStr = sm?.getCwd?.() || cwdStr;
        const stats = s?.getSessionStats?.();
        if (stats?.tokens) {
            tokens = {
                input: stats.tokens.input,
                output: stats.tokens.output,
                cacheRead: stats.tokens.cacheRead,
                cacheWrite: stats.tokens.cacheWrite,
            };
            cost = stats.cost ?? 0;
        }
        if (st?.model && s?.modelRegistry?.isUsingOAuth)
            sub = !!s.modelRegistry.isUsingOAuth(st.model);
        const usage = s?.getContextUsage?.();
        context = {
            percent: usage?.percent ?? null,
            window: usage?.contextWindow ?? st?.model?.contextWindow ?? 0,
        };
        autoCompact = !!s?.autoCompactionEnabled;
    } catch {
        /* best-effort */
    }
    let statuses: { key: string; text: string }[] = [];
    try {
        statuses = registry?.getStatuses?.() ?? [];
    } catch {
        /* best-effort */
    }
    // Host-native git branch (pi-tui footerData.getGitBranch parity): read the
    // thread's live watcher cache; null outside a repo / when unknown.
    let gitBranch: string | null = null;
    try {
        gitBranch = thread?.gitWatcher?.getBranch?.() ?? null;
    } catch {
        /* best-effort */
    }
    // Count of selectable models (footerData.getAvailableProviderCount parity).
    let availableModels = 0;
    try {
        availableModels = s?.modelRegistry?.getAvailable?.()?.length ?? 0;
    } catch {
        /* best-effort */
    }
    return {
        cwd: formatCwdForFooter(cwdStr, homedir()),
        session,
        model,
        reasoning,
        level,
        tokens,
        cost,
        sub,
        context,
        autoCompact,
        gitBranch,
        availableModels,
        statuses,
    };
}

function footerFrame(
    s: AgentSession | null | undefined,
    threadCwd = "",
    reg?: any,
) {
    const thread = threadForSession(s);
    const registry = reg ?? thread?.piweb;
    const base = buildFooterData(s, threadCwd || cwd, thread, registry);
    // If an extension owns the footer (piweb.setFooter), call its factory with
    // the live FooterData + theme vars and ship the returned node tree as
    // `custom`. Any failure (or a falsy return) falls back to the default bar.
    const factory = registry?.getFooterFactory?.();
    if (factory) {
        try {
            const custom = factory({ ...base }, theme.vars());
            if (custom) return { kind: "footer" as const, ...base, custom };
        } catch (err) {
            console.error("setFooter factory threw:", err);
        }
    }
    return { kind: "footer" as const, ...base };
}

/**
 * Build the `header` frame: an extension-owned custom header above the
 * transcript (pi-tui `ctx.ui.setHeader` parity). `custom` is null when no
 * header factory is set, which restores the built-in header on the client.
 */
function headerFrame(
    s: AgentSession | null | undefined,
    threadCwd = "",
    reg?: any,
) {
    const thread = threadForSession(s);
    const registry = reg ?? thread?.piweb;
    const factory = registry?.getHeaderFactory?.();
    if (!factory) return { kind: "header" as const, custom: null };
    try {
        const base = buildFooterData(s, threadCwd || cwd, thread, registry);
        const custom = factory({ ...base }, theme.vars());
        return { kind: "header" as const, custom: custom || null };
    } catch (err) {
        console.error("setHeader factory threw:", err);
        return { kind: "header" as const, custom: null };
    }
}
/**
 * Build the `queue` frame: the per-thread steering/follow-up messages waiting to
 * be delivered while a turn is in flight. Mirrors the pi TUI's pending-messages
 * display (drained at the next message boundary / turn end). Best-effort.
 * @param {AgentSession|null|undefined} s
 * @returns {{kind:"queue", items:string[]}}
 */
function queueFrame(s: AgentSession | null | undefined) {
    let items: string[] = [];
    try {
        const steering = s?.getSteeringMessages?.() ?? [];
        const followUp = s?.getFollowUpMessages?.() ?? [];
        items = [...steering, ...followUp];
    } catch {
        /* best-effort: empty queue */
    }
    return { kind: "queue", items };
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function describeError(raw: unknown): string {
    if (!raw) return "model returned an error";
    try {
        return JSON.parse(String(raw))?.error?.message ?? String(raw);
    } catch {
        return String(raw);
    }
}

/**
 * Choose the session's model, honoring pi's own settings where possible.
 * See the precedence comment on ENV_PROVIDER/FALLBACK_PROVIDER above.
 * @param {AgentSession} s
 */
async function pinModel(s: AgentSession) {
    const cur = s.state?.model;

    // 1. Explicit env override always wins.
    if (ENV_PROVIDER || ENV_MODEL_ID) {
        const provider = ENV_PROVIDER ?? FALLBACK_PROVIDER;
        const modelId = ENV_MODEL_ID ?? FALLBACK_MODEL_ID;
        const model = modelRegistry.find(provider, modelId);
        if (model) {
            await s.setModel(model);
            console.log(
                `  model:  ${model.provider}/${model.id} (${model.name ?? ""}) [env]`,
            );
            return;
        }
        console.warn(
            `  model:  ${provider}/${modelId} not found (PI_PROVIDER/PI_MODEL)`,
        );
    }

    // 2. Respect pi's settings.json default when the user has set one.
    //    createAgentSession already resolved it onto s.state.model.
    const sm = s.settingsManager;
    const hasPiDefault = !!(
        sm?.getDefaultModel?.() || sm?.getDefaultProvider?.()
    );
    if (hasPiDefault && cur?.provider && cur?.id) {
        console.log(
            `  model:  ${cur.provider}/${cur.id} (${cur.name ?? ""}) [pi settings]`,
        );
        return;
    }

    // 3. No env override and no pi default — pin the meridian fallback.
    const fallback = modelRegistry.find(FALLBACK_PROVIDER, FALLBACK_MODEL_ID);
    if (fallback) {
        await s.setModel(fallback);
        console.log(
            `  model:  ${fallback.provider}/${fallback.id} (${fallback.name ?? ""}) [fallback]`,
        );
    } else {
        console.warn(
            `  model:  ${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID} not found — using ${cur?.provider}/${cur?.id}`,
        );
    }
}

// ---- per-thread event translation -----------------------------------------
// Translate one thread's agent events -> server messages, routed to the clients
// viewing this thread. Background threads (no current viewers) still run; their
// frames simply reach nobody and are restored via replay on the next view.
/**
 * @param {ThreadRuntime} thread
 * @returns {() => void} unsubscribe
 */
/**
 * Build a `custom` transcript frame for an extension CustomMessage (role
 * "custom", from `pi.sendMessage`). If a renderer is registered for its
 * customType, ship the serialized component tree; otherwise fall back to the
 * message's text content (the client renders it as markdown). Mirrors pi-tui's
 * registered-message-renderer path (TODO #19).
 * @param {PiWebRegistry|null|undefined} reg   the thread's surface registry
 * @param {any} m                              the CustomMessage
 * @returns {ServerMessage}
 */
function customFrame(reg: PiWebRegistry | null | undefined, m: any) {
    const frame: ServerMessage = {
        kind: "custom",
        customType: m.customType || "",
    };
    let tree = null;
    try {
        tree = reg?.renderMessage?.(m.customType, m, { expanded: false });
    } catch {
        tree = null;
    }
    if (tree) frame.tree = tree;
    else frame.text = textOf(m.content);
    return frame;
}

function subscribe(thread: ThreadRuntime) {
    let streamed = false;
    let streamedThinking = false;
    // Wall-clock start time per in-flight tool call, keyed by toolCallId, so we
    // can stamp `durationMs` on the matching end frame (mirrors pi-tui showing
    // how long a tool/command took). Only live turns are timed; replayed
    // transcripts have no stored timing and simply omit the duration.
    const toolStart = new Map();
    const toolArgs = new Map();
    /** @param {ServerMessage} msg */
    const emit = (msg: ServerMessage) => bus.broadcastToThread(thread.id, msg);
    return thread.session!.subscribe((ev) => {
        // route surface updates from this thread's extension event handlers
        // (setStatus, dock, notify, …) to its own registry
        currentThread = thread;
        switch (ev.type) {
            case "message_start":
                if (ev.message?.role === "user") {
                    const frame: ServerMessage = {
                        kind: "user",
                        text: textOf(ev.message.content),
                    };
                    const imgs = imagesOf(ev.message.content);
                    if (imgs.length) frame.images = imgs;
                    emit(frame);
                    // A brand-new thread is hidden from the list until it has a
                    // message; now that one exists, surface it immediately
                    // instead of waiting for the turn to finish (agent_end).
                    broadcastThreads();
                } else if (ev.message?.role === "assistant") {
                    streamed = false;
                    streamedThinking = false;
                    if (!thread.busy) {
                        thread.busy = true;
                        // drive the web UI "Working" spinner (pi-tui style)
                        emit({ kind: "working", busy: true });
                    }
                }
                break;
            case "message_update": {
                const e = ev.assistantMessageEvent;
                if (e?.type === "text_delta") {
                    streamed = true;
                    emit({ kind: "delta", text: e.delta });
                } else if (e?.type === "thinking_start") {
                    emit({ kind: "thinking", status: "start" });
                } else if (e?.type === "thinking_delta") {
                    streamedThinking = true;
                    emit({ kind: "thinking", status: "delta", text: e.delta });
                } else if (e?.type === "thinking_end") {
                    emit({ kind: "thinking", status: "end" });
                }
                break;
            }
            case "message_end": {
                const m = ev.message;
                // extension-injected custom messages (pi.sendMessage) render via
                // a registered message renderer, or fall back to their text
                if (m?.role === "custom") {
                    if (m.display !== false) emit(customFrame(thread.piweb, m));
                    break;
                }
                if (m?.role !== "assistant") break;
                if (m.stopReason === "error" || m.errorMessage)
                    emit({
                        kind: "error",
                        text: describeError(m.errorMessage),
                    });
                else {
                    // emit thinking before text (mirrors how it streams)
                    if (!streamedThinking) {
                        const think = thinkingOf(m.content);
                        if (think)
                            emit({
                                kind: "thinking",
                                status: "full",
                                text: think,
                            });
                    }
                    if (!streamed) {
                        const text = textOf(m.content);
                        if (text) emit({ kind: "assistant_full", text });
                    }
                }
                emit({ kind: "assistant_end" });
                break;
            }
            case "tool_execution_start":
                toolStart.set(ev.toolCallId, Date.now());
                // Keep args around for the end event, which omits them; the
                // tool's renderResult context wants them (Parity P1).
                toolArgs.set(ev.toolCallId, ev.args);
                emit({
                    kind: "tool",
                    id: ev.toolCallId,
                    name: ev.toolName,
                    status: "start",
                    args: ev.args,
                });
                break;
            case "tool_execution_end": {
                const t0 = toolStart.get(ev.toolCallId);
                if (t0 != null) toolStart.delete(ev.toolCallId);
                const args = toolArgs.get(ev.toolCallId);
                toolArgs.delete(ev.toolCallId);
                const frame: ServerMessage = {
                    kind: "tool",
                    id: ev.toolCallId,
                    name: ev.toolName,
                    status: "end",
                    isError: ev.isError,
                    result: textOf(ev.result?.content),
                    // structured tool details for rich rendering (e.g. edit's
                    // `diff` string) — the web counterpart to pi-tui renderResult
                    details: ev.result?.details,
                    // how long the tool ran (live turns only; see toolStart)
                    durationMs: t0 != null ? Date.now() - t0 : undefined,
                };
                // Parity P1: extension tools with a custom renderResult render
                // their pi TUI Component as an AnsiBlock `tree`. Built-ins keep
                // pi-web's native rendering; the client prefers its own
                // registered renderer over the tree when present.
                if (!WEB_BUILTIN_TOOLS.has(ev.toolName)) {
                    try {
                        const def = thread.session?.getToolDefinition?.(
                            ev.toolName,
                        );
                        if (def?.renderResult) {
                            const node = renderToolResultToNode(
                                def,
                                {
                                    toolName: ev.toolName,
                                    toolCallId: ev.toolCallId,
                                    args: args ?? {},
                                    cwd: thread.cwd,
                                    content: ev.result?.content,
                                    details: ev.result?.details,
                                    isError: ev.isError,
                                    expanded: false,
                                },
                                webPaletteTheme,
                                100,
                            );
                            if (node) frame.tree = node;
                        }
                    } catch {
                        /* fall back to default rendering */
                    }
                }
                emit(frame);
                break;
            }
            case "queue_update":
                // steering / follow-up messages waiting to be delivered while a
                // turn is in flight; mirror the pi TUI's pending-messages display
                emit({
                    kind: "queue",
                    items: [...(ev.steering ?? []), ...(ev.followUp ?? [])],
                });
                break;
            case "agent_end":
                thread.busy = false;
                emit({ kind: "assistant_end" });
                emit({ kind: "working", busy: false });
                // refresh the context bar with the turn's updated token usage
                emit(footerFrame(thread.session, thread.cwd));
                // names/recency/running may have changed — refresh the list
                broadcastThreads();
                break;
        }
    });
}

// ---- thread creation ------------------------------------------------------
// Booting a thread instantiates its own extensions (capturing this thread's pi
// + routing panel registration into this thread's registry) and AgentSession.
// Creation is serialized so the transient `bindingThread` pointer can't be
// clobbered by a concurrent boot.
let createChain = Promise.resolve();

/**
 * @param {SessionManager} sm
 * @returns {ThreadRuntime}
 */
function makeThread(sm: SessionManager): ThreadRuntime {
    // The SessionManager header is the source of truth for a thread's cwd (pi
    // binds it at creation). Fall back to the process root for legacy/in-memory
    // sessions that don't carry one.
    const threadCwd = sm.getCwd() || cwd;
    knownCwds.add(threadCwd);
    const thread: ThreadRuntime = {
        id: sm.getSessionId(),
        cwd: threadCwd,
        sm,
        session: null,
        pi: null,
        piweb: null,
        resourceLoader: null,
        unsubscribe: null,
        busy: false,
        gitWatcher: null,
    };
    thread.piweb = createPiWebHost({
        // panels reach only the clients viewing this thread
        // surface frames reach only the clients viewing this thread
        broadcast: (frame) => bus.broadcastToThread(thread.id, frame),
        getPi: () => thread.pi,
        // rebuild + rebroadcast the footer (server owns the session data it
        // needs) when an extension (re)sets or refreshes a footer factory
        requestFooter: () =>
            bus.broadcastToThread(
                thread.id,
                footerFrame(thread.session, thread.cwd, thread.piweb),
            ),
        // same, for a custom header (setHeader)
        requestHeader: () =>
            bus.broadcastToThread(
                thread.id,
                headerFrame(thread.session, thread.cwd, thread.piweb),
            ),
        // theme API (pi ui.getAllThemes/setTheme): list loadable themes and
        // switch+persist+rebroadcast the palette (globally — theme is app-wide).
        themeApi: {
            list: () => theme.list(),
            set: (name: string) => theme.apply(name),
        },
    });
    // Live git-branch tracking for FooterData.gitBranch: refresh the footer
    // (and header) whenever the branch flips under this thread's cwd.
    thread.gitWatcher = createGitBranchWatcher(thread.cwd, () => {
        bus.broadcastToThread(
            thread.id,
            footerFrame(thread.session, thread.cwd, thread.piweb),
        );
        bus.broadcastToThread(
            thread.id,
            headerFrame(thread.session, thread.cwd, thread.piweb),
        );
    });
    return thread;
}

/**
 * Boot (or resume) a thread into the registry.
 * @param {SessionManager} sm
 * @returns {Promise<ThreadRuntime>}
 */
function createThread(sm: SessionManager) {
    const run = createChain.then(async () => {
        const thread = makeThread(sm);
        const threadCwd = thread.cwd;
        // Hard trust gate: own the SettingsManager so we can pin the trust flag
        // *before* loading resources. A project with trust-requiring .pi
        // resources and no saved decision starts UNTRUSTED, so its extensions/
        // skills/prompts/settings aren't loaded until the user decides via
        // /trust. A saved decision is honored; a project with nothing to gate is
        // trusted. reload() preserves this flag (it doesn't re-resolve), and the
        // SDK default would otherwise start every project trusted.
        const settingsManager = SettingsManager.create(
            threadCwd,
            getAgentDir(),
        );
        const savedTrust = trustStore.get(threadCwd); // boolean | null
        settingsManager.setProjectTrusted(
            savedTrust !== null
                ? savedTrust
                : !hasTrustRequiringProjectResources(threadCwd),
        );
        const resourceLoader = new DefaultResourceLoader({
            cwd: threadCwd,
            agentDir: getAgentDir(),
            settingsManager,
            // Inline factory captures this thread's live ExtensionAPI so panel
            // actions call back into *this* thread (pi.sendUserMessage, etc).
            extensionFactories: [
                (pi) => {
                    thread.pi = pi;
                },
            ],
        });
        thread.resourceLoader = resourceLoader;
        // Route extension registration (setWidget/setStatus/registerMessage-
        // Renderer/…) to this thread. Extensions register during
        // `resourceLoader.reload()` — NOT during createAgentSession — so
        // bindingThread must be set *before* reload(), matching the /reload
        // path (onReload). Setting it only around createAgentSession dropped
        // every first-load registration onto the null registry until an
        // explicit /reload (the real cause of TODO #11). createThread is
        // serialized via createChain, so this transient pointer is safe.
        bindingThread = thread;
        try {
            await resourceLoader.reload();
            const created = await createAgentSession({
                cwd: threadCwd,
                resourceLoader,
                sessionManager: sm,
                settingsManager,
                authStorage,
                modelRegistry,
            });
            thread.session = created.session;
        } finally {
            bindingThread = null;
        }

        await pinModel(thread.session);
        thread.unsubscribe = subscribe(thread);
        threadRuntimes.set(thread.id, thread);
        if (thread.session) sessionIndex.set(thread.session, thread);
        return thread;
    });
    createChain = run.then(
        () => {},
        () => {},
    );
    return run;
}

/**
 * Resolve a thread id to a live runtime, resuming it from disk if necessary.
 * @param {string|undefined|null} id
 * @returns {Promise<ThreadRuntime|null>}
 */
async function ensureLoaded(id: string | undefined | null) {
    if (!id) return null;
    const existing = threadRuntimes.get(id);
    if (existing) return existing;
    // Sessions are stored per-cwd, so search every directory we know threads in.
    for (const dir of knownCwds) {
        const infos = await SessionManager.list(dir);
        const info = infos.find((i) => i.id === id);
        if (info) return createThread(SessionManager.open(info.path));
    }
    // Fallback (e.g. a deep-linked ?thread in a dir we haven't listed yet):
    // scan all projects, then seed knownCwds so later lookups stay fast.
    const all = await SessionManager.listAll().catch(() => []);
    const hit = all.find((i) => i.id === id);
    if (hit) {
        if (hit.cwd) knownCwds.add(hit.cwd);
        return createThread(SessionManager.open(hit.path));
    }
    return null;
}

// Replay a thread's history into the transcript.
// `send` writes to a single client (used on SSE connect / per-thread replay).
// NOTE: this reads buildSessionContext() (in-memory), which works even for
// threads not yet flushed to disk (the SDK only writes the .jsonl after the
// first assistant message) — so a refresh restores a brand-new thread too.
/**
 * @param {AgentSession} s
 * @param {(msg: ServerMessage) => void} send
 */
function replayTranscript(s: AgentSession, send: (msg: ServerMessage) => void) {
    send({ kind: "transcript_reset" });
    // this thread's surface registry, for re-rendering custom messages on replay
    const replayReg = threadRuntimes.get(
        s?.sessionManager?.getSessionId?.(),
    )?.piweb;
    let messages: any[] = [];
    try {
        const ctx = s.sessionManager.buildSessionContext?.();
        messages = Array.isArray(ctx?.messages) ? ctx.messages : [];
    } catch {
        messages = [];
    }
    for (const m of messages) {
        switch (m?.role) {
            case "user": {
                const frame: ServerMessage = {
                    kind: "user",
                    text: textOf(m.content),
                };
                const imgs = imagesOf(m.content);
                if (imgs.length) frame.images = imgs;
                send(frame);
                break;
            }
            case "assistant": {
                const think = thinkingOf(m.content);
                if (think)
                    send({ kind: "thinking", status: "full", text: think });
                const text = textOf(m.content);
                if (text) send({ kind: "assistant_full", text });
                send({ kind: "assistant_end" });
                // Tool calls live as `toolCall` blocks inside the assistant
                // message; re-emit each as a tool "start" (its matching
                // "end" comes from the toolResult message below).
                if (Array.isArray(m.content)) {
                    for (const b of m.content) {
                        if (b?.type === "toolCall")
                            send({
                                kind: "tool",
                                id: b.id,
                                name: b.name,
                                status: "start",
                                args: b.arguments,
                            });
                    }
                }
                break;
            }
            case "toolResult":
                send({
                    kind: "tool",
                    id: m.toolCallId,
                    name: m.toolName,
                    status: "end",
                    isError: !!m.isError,
                    result: textOf(m.content),
                    details: m.details,
                });
                break;
            case "custom":
                // extension-injected custom message: render via a registered
                // renderer (serialized tree) or fall back to its text content
                if (m.display !== false) send(customFrame(replayReg, m));
                break;
            case "bashExecution":
                // user-run shell (! / !!) is stored as its own message
                send({
                    kind: "bash",
                    status: "start",
                    command: m.command,
                    excludeFromContext: !!m.excludeFromContext,
                });
                if (m.output)
                    send({ kind: "bash", status: "chunk", text: m.output });
                send({
                    kind: "bash",
                    status: "end",
                    exitCode: m.exitCode ?? null,
                    cancelled: !!m.cancelled,
                    truncated: !!m.truncated,
                    fullOutputPath: m.fullOutputPath ?? null,
                });
                break;
        }
    }
}

/**
 * Resolve + replay the thread a freshly-connected client is viewing. Sends that
 * client its panels and transcript, and returns the resolved id so the SSE
 * connection can be tagged (and the browser can canonicalize its URL).
 * @param {(msg: ServerMessage) => void} send
 * @param {string|undefined} threadId
 * @returns {Promise<string|undefined>}
 */
// A short, human label for a resource path. Extensions usually live in
// `.../<name>/index.ts`, so prefer the containing folder name; otherwise the
// basename. Plain files are shown cwd-relative.
function resourceLabel(p: string) {
    const rel = p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
    const parts = rel.split("/");
    const base = parts[parts.length - 1] || rel;
    if (/^index\.[mc]?[jt]sx?$/.test(base) && parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return rel;
}

// Extensions that FAILED to load (bad import, runtime throw in the factory,
// jiti/parse error, …). The core resource loader swallows these into
// `getExtensions().errors` instead of throwing, so without surfacing them a
// newly added / broken extension silently vanishes: `/reload` looks successful,
// the welcome banner just omits it, and its `/command` never appears. We lift
// them into the welcome payload + an inline error on reload so the user learns
// *why* it didn't load. Inline factories (`<inline:…>`) are skipped.
function extensionErrors(rl: any): { label: string; message: string }[] {
    try {
        return (rl?.getExtensions().errors ?? [])
            .filter((e: any) => e && !String(e.path).startsWith("<"))
            .map((e: any) => ({
                label: resourceLabel(String(e.path)),
                message: String(e.error?.message ?? e.error ?? "load failed"),
            }));
    } catch {
        return [];
    }
}

// Gather the loaded resources for the startup/reload intro view, mirroring the
// TUI's `showLoadedResources` sections (Context, Skills, Prompts, Extensions,
// Themes). Each accessor is guarded so one broken loader can't sink the banner.
function buildWelcome(rl: any) {
    const sections: { name: string; items: any[] }[] = [];
    const add = (name: string, items: any[]) => {
        const list = (items || []).filter(Boolean);
        if (list.length) sections.push({ name, items: list });
    };
    const safe = <T>(fn: () => T, fallback: T): T => {
        try {
            return fn();
        } catch {
            return fallback;
        }
    };
    if (rl) {
        add(
            "Context",
            safe(() => rl.getAgentsFiles().agentsFiles, []).map((f: any) =>
                resourceLabel(f.path),
            ),
        );
        add(
            "Skills",
            safe(() => rl.getSkills().skills, []).map((s: any) => s.name),
        );
        add(
            "Prompts",
            safe(() => rl.getPrompts().prompts, []).map(
                (p: any) => `/${p.name}`,
            ),
        );
        add(
            "Extensions",
            safe(() => rl.getExtensions().extensions, [])
                // Skip synthetic/inline extensions (e.g. "<inline:1>"), like the
                // factory pi-web injects to capture each thread's ExtensionAPI.
                .filter((e: any) => !e.path.startsWith("<"))
                .map((e: any) => resourceLabel(e.path)),
        );
        add(
            "Themes",
            safe(() => rl.getThemes().themes, [])
                .filter((t: any) => t.sourcePath)
                .map((t: any) => t.name || resourceLabel(t.sourcePath)),
        );
    }
    return { version: PI_VERSION, sections, errors: extensionErrors(rl) };
}

async function handleConnect(
    send: (msg: ServerMessage) => void,
    threadId?: string,
) {
    let t: ThreadRuntime | null = null;
    try {
        t = await ensureLoaded(threadId);
    } catch {
        t = null;
    }
    if (!t) t = defaultThread;
    if (!t?.session || !t.piweb) return undefined;
    // Tell the client this thread's working directory so it can show cwd-relative
    // tool paths (read/write/edit/ls) and surface the dir in the UI, matching
    // the pi TUI. Each thread can live in a different directory.
    send({ kind: "config", cwd: t.cwd || cwd });
    // startup/reload intro: version banner + loaded resources (#5/#12)
    send({ kind: "welcome", ...buildWelcome(t.resourceLoader) });
    send({ kind: "surfaces", surfaces: t.piweb.snapshot() });
    // reflect the persisted pi "hide thinking blocks" setting
    send({ kind: "thinking_visibility", hidden: thinkingHidden(t.session) });
    // reflect the current collapsed-thinking label (pi ui.setHiddenThinkingLabel)
    send({
        kind: "thinking_label",
        label: t.piweb.getHiddenThinkingLabel?.() ?? "Thinking...",
    });
    // reflect the per-session reasoning level (focused composer border color)
    send(thinkingLevelFrame(t.session));
    // default below-composer context bar (pwd/session + tokens + model•thinking)
    send(footerFrame(t.session, t.cwd));
    // extension-owned custom header above the transcript (setHeader), if any
    send(headerFrame(t.session, t.cwd, t.piweb));
    replayTranscript(t.session, send);
    // pending steering/follow-up messages, so a refreshing viewer sees the queue
    send(queueFrame(t.session));
    send({ kind: "thread_switched", id: t.id });
    // reflect the thread's current activity (e.g. focusing a busy background
    // thread should show the spinner immediately)
    send({ kind: "working", busy: !!t.busy });
    // reflect any working-indicator overrides (pi ui.setWorking*)
    send({
        kind: "working_config",
        config: t.piweb.getWorkingConfig?.() ?? {},
    });
    // reflect the programmatic tool-output expansion default (pi ui.setToolsExpanded)
    send({
        kind: "tools_expanded",
        expanded: t.piweb.getToolsExpanded?.() ?? false,
    });
    // restore any extension-set composer text (pi ui.setEditorText): the fresh
    // browser <textarea> is empty on (re)connect, so replay a non-empty shadow.
    const draft = t.piweb.getEditorText?.() ?? "";
    if (draft) send({ kind: "editor", op: "set", text: draft });
    // First-load trust gate: pi-web resolves headless -> untrusted for projects
    // with trust-requiring .pi resources, silently ignoring them. When such a
    // project has no saved decision yet, nudge the browser to open the /trust
    // picker so the user can decide (the TUI shows an equivalent "not trusted,
    // use /trust" prompt at startup). We can't block here to ask synchronously:
    // handleConnect runs *before* this client is tagged to the thread, so a
    // blocking dialog would deadlock. Emit once per thread per process.
    if (needsTrustPrompt(t)) {
        trustPrompted.add(t.id);
        send({ kind: "trust_required", cwd: t.cwd });
    }
    return t.id;
}

// ---- threads (sessions) ---------------------------------------------------
function broadcastThreads() {
    threads
        .list()
        .then((items) => broadcast({ kind: "threads", items }))
        .catch(() => {});
}

const threads = {
    /** @returns {Promise<Array<object>>} */
    async list() {
        // List sessions across every project directory (each session carries the
        // cwd it was started in) so threads persist across host restarts and the
        // client can group them by directory. Seed knownCwds so resume-by-id and
        // the @-file typeahead can resolve any listed thread's working dir.
        const infos = await SessionManager.listAll().catch(() => []);
        for (const i of infos) if (i.cwd) knownCwds.add(i.cwd);
        const items = infos
            .slice()
            .sort(
                (a, b) =>
                    new Date(b.modified).getTime() -
                    new Date(a.modified).getTime(),
            )
            .map((i) => {
                const rt = threadRuntimes.get(i.id);
                return {
                    id: i.id,
                    name: i.name || i.firstMessage || "(new thread)",
                    cwd: i.cwd,
                    messageCount: i.messageCount,
                    modified: i.modified,
                    running: rt?.busy ?? false, // turn in flight (any viewer or none)
                    loaded: !!rt, // live in the registry (running in-process)
                };
            });
        // The SDK only flushes a session to disk after its first assistant
        // message, so brand-new or still-running threads won't appear in
        // `infos`. Surface every live in-registry thread that already has at
        // least one message so they stay visible and resumable across browser
        // refreshes (the server keeps them alive). Empty, freshly-created
        // threads are skipped so they don't pollute the list until the first
        // message is actually sent — the client still opens them by URL.
        const onDisk = new Set(infos.map((i) => i.id));
        for (const [id, rt] of threadRuntimes) {
            if (onDisk.has(id)) continue;
            const sm = rt.session?.sessionManager;
            let messageCount = 0;
            let firstMessage = "";
            try {
                const msgs = sm?.buildSessionContext?.().messages ?? [];
                messageCount = msgs.length;
                const u = msgs.find((m: any) => m?.role === "user");
                if (u) firstMessage = textOf((u as any).content).slice(0, 80);
            } catch {}
            // No messages yet → don't list it (avoids empty-thread clutter).
            if (messageCount === 0) continue;
            items.unshift({
                id,
                name: sm?.getSessionName?.() || firstMessage || "(new thread)",
                cwd: rt.cwd,
                messageCount,
                modified: new Date(),
                running: rt.busy ?? false,
                loaded: true,
            });
        }
        return items;
    },
    /**
     * Create a fresh thread and return its id (the client navigates to it).
     * An optional `dir` starts the thread in another working directory — the
     * web analogue of `cd`, since pi binds cwd at session creation and a new
     * thread is the honest way to "change directory".
     * @param {string} [dir]
     */
    async create(dir?: string) {
        const target = resolveThreadCwd(dir);
        const t = await createThread(SessionManager.create(target));
        return { id: t.id, cwd: t.cwd };
    },
    /**
     * Resume a thread into the registry (clients view it by reopening the SSE
     * stream with `?thread=<id>`; this just guarantees it is live).
     * @param {string} id
     */
    async switch(id: string) {
        if (!id) return;
        const t = await ensureLoaded(id);
        if (!t) throw new Error(`unknown thread: ${id}`);
    },
    /**
     * Duplicate the current active branch into a brand-new thread (/clone),
     * copying the full history and staying at the current position. The client
     * navigates to the returned id.
     * @param {string} threadId
     */
    async clone(threadId?: string) {
        const rt = threadId ? threadRuntimes.get(threadId) : undefined;
        const file = rt?.session?.sessionManager?.getSessionFile?.();
        if (!file) throw new Error("nothing to clone yet");
        const t = await createThread(SessionManager.forkFrom(file, rt!.cwd));
        return { id: t.id, cwd: t.cwd };
    },
    /**
     * Start a new thread forked from a previous user message (/fork): copy the
     * history into a new session file, then move its leaf to `entryId` so the
     * next turn branches from that point. forkFrom preserves entry ids, so the
     * branch target resolves in the copy.
     * @param {string} threadId
     * @param {string} entryId
     */
    async fork(threadId: string | undefined, entryId: string) {
        const rt = threadId ? threadRuntimes.get(threadId) : undefined;
        const file = rt?.session?.sessionManager?.getSessionFile?.();
        if (!file) throw new Error("nothing to fork yet");
        if (!entryId) throw new Error("missing entryId");
        const sm = SessionManager.forkFrom(file, rt!.cwd);
        sm.branch(entryId);
        const t = await createThread(sm);
        return { id: t.id, cwd: t.cwd };
    },
    /**
     * Import a session JSONL file into a new thread (/import), resuming it in
     * the calling thread's working directory. forkFrom copies the history into
     * a fresh session file so the original file is left untouched.
     * @param {string} path
     * @param {string} [threadId]
     */
    async importJsonl(path: string, threadId?: string) {
        const p = (path ?? "").trim();
        if (!p) throw new Error("missing file path");
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        const targetCwd =
            (threadId ? threadRuntimes.get(threadId) : undefined)?.cwd || cwd;
        const t = await createThread(SessionManager.forkFrom(abs, targetCwd));
        return { id: t.id, cwd: t.cwd };
    },
    /**
     * Delete a thread's session file (Ctrl+D in the resume picker). Mirrors the
     * pi TUI: refuse a running thread, trash-then-unlink the file, evict any
     * live copy, then rebroadcast the list. Threads not yet flushed to disk are
     * simply dropped from the registry.
     * @param {string} threadId
     */
    async delete(threadId: string) {
        if (!threadId) throw new Error("missing threadId");
        // Parity with the TUI's "Cannot delete the currently active session":
        // the web has no single active thread, so block any thread with a turn
        // in flight instead.
        if (threadRuntimes.get(threadId)?.busy)
            throw new Error("Cannot delete a running thread");
        const file = await sessionFileForThread(threadId);
        if (!file) {
            // No session file yet (no assistant message flushed): nothing to
            // unlink, just drop it from the registry so it leaves the list.
            evictThread(threadId);
            broadcastThreads();
            return { ok: true, method: "unlink" as const };
        }
        const result = await deleteSessionFile(file);
        if (result.ok) {
            evictThread(threadId); // evict any live copy (+ dispose git watcher)
            broadcastThreads(); // SSE → every client refreshes its list
        }
        return result;
    },
    /**
     * Rename a thread's session (Ctrl+R in the resume picker) by appending a
     * session_info entry. Works on loaded and on-disk threads.
     * @param {string} threadId
     * @param {string} name
     */
    async rename(threadId: string, name: string) {
        const n = (name ?? "").trim();
        if (!n) throw new Error("missing name");
        const s = sessionFor(threadId);
        if (s) {
            s.setSessionName(n);
            broadcastThreads();
            return { ok: true };
        }
        const file = await sessionFileForThread(threadId);
        if (!file) throw new Error(`unknown thread: ${threadId}`);
        const sm = SessionManager.open(file);
        sm.appendSessionInfo(n);
        broadcastThreads();
        return { ok: true };
    },
};

/**
 * Resolve a threadId to its on-disk session file path. Prefers a live registry
 * entry (so brand-new threads resolve before any disk listing), then falls back
 * to scanning all sessions so unloaded/old threads are still deletable.
 * @param {string} threadId
 * @returns {Promise<string | undefined>}
 */
async function sessionFileForThread(threadId: string) {
    const live = threadRuntimes
        .get(threadId)
        ?.session?.sessionManager?.getSessionFile?.();
    if (live) return live;
    const infos = await SessionManager.listAll().catch(() => []);
    return infos.find((i) => i.id === threadId)?.path;
}

/**
 * Delete a session file, trying the `trash` CLI first (recoverable) and falling
 * back to a permanent unlink. Ported verbatim from the pi TUI's
 * session-selector so behavior matches exactly.
 * @param {string} sessionPath
 */
async function deleteSessionFile(
    sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
    const trashArgs = sessionPath.startsWith("-")
        ? ["--", sessionPath]
        : [sessionPath];
    const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

    const getTrashErrorHint = () => {
        const parts: string[] = [];
        if (trashResult.error) parts.push(trashResult.error.message);
        const stderr = trashResult.stderr?.trim();
        if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
        if (parts.length === 0) return null;
        return `trash: ${parts.join(" · ").slice(0, 200)}`;
    };

    // trash reported success, or the file is gone anyway → treat as success.
    if (trashResult.status === 0 || !existsSync(sessionPath)) {
        return { ok: true, method: "trash" };
    }

    // Fallback to permanent deletion.
    try {
        await unlink(sessionPath);
        return { ok: true, method: "unlink" };
    } catch (err) {
        const unlinkError = err instanceof Error ? err.message : String(err);
        const trashErrorHint = getTrashErrorHint();
        const error = trashErrorHint
            ? `${unlinkError} (${trashErrorHint})`
            : unlinkError;
        return { ok: false, method: "unlink", error };
    }
}

// Describe one session-tree node as a navigable jump point for /tree. Returns
// null for entries that aren't useful to jump to (model/thinking changes, tool
// noise) so the web tree selector stays readable. Mirrors the pi TUI, which
// lets you navigate to any earlier point and continue from there.
function treeEntryInfo(node: any) {
    const e = node?.entry;
    if (!e) return null;
    const label = node.label || null;
    if (e.type === "message") {
        const role = e.message?.role;
        if (role !== "user" && role !== "assistant") return null;
        let text = textOf(e.message?.content).replace(/\s+/g, " ").trim();
        if (!text) text = role === "assistant" ? "(tool calls)" : "";
        return { role, text: text.slice(0, 140), label };
    }
    // non-message entries only surface when explicitly labeled
    if (label) return { role: "label", text: label.slice(0, 140), label };
    return null;
}

// ---- session commands (/session, /name, /compact, /export, /changelog) ----
// All operate on the thread named by the calling client (threadId).
const sessionApi = {
    info(threadId?: string) {
        const s = sessionFor(threadId);
        const sm = s?.sessionManager;
        return {
            id: sm?.getSessionId(),
            name: sm?.getSessionName() ?? null,
            stats: s?.getSessionStats?.() ?? null,
            usage: s?.getContextUsage?.() ?? null,
        };
    },
    /**
     * @param {string} name
     * @param {string} [threadId]
     */
    setName(name: string, threadId?: string) {
        const n = (name ?? "").trim();
        const s = sessionFor(threadId);
        if (n && s) {
            s.setSessionName(n);
            broadcastThreads();
            // the context bar's pwd line shows the session name
            bus.broadcastToThread(threadId, footerFrame(s));
            bus.broadcastToThread(threadId, {
                kind: "system",
                text: `renamed thread to “${n}”`,
            });
        }
    },
    async compact(threadId?: string) {
        const s = sessionFor(threadId);
        if (!s) return;
        bus.broadcastToThread(threadId, {
            kind: "system",
            text: "compacting context…",
        });
        try {
            await s.compact();
            bus.broadcastToThread(threadId, {
                kind: "system",
                text: "context compacted",
            });
            // compaction changes context usage — refresh the context bar
            bus.broadcastToThread(threadId, footerFrame(s));
            broadcastThreads();
        } catch (err) {
            bus.broadcastToThread(threadId, {
                kind: "error",
                text: "compact failed: " + String((err as any)?.message ?? err),
            });
        }
    },
    /**
     * @param {"html"|"jsonl"} format
     * @param {string} [threadId]
     */
    async export(format: "html" | "jsonl", threadId?: string) {
        const s = sessionFor(threadId);
        if (!s) return { error: "no active session" };
        try {
            const path =
                format === "jsonl" ? s.exportToJsonl() : await s.exportToHtml();
            return { path, format: format === "jsonl" ? "jsonl" : "html" };
        } catch (err) {
            return { error: String((err as any)?.message ?? err) };
        }
    },
    async changelog() {
        try {
            const text = await readFile(
                join(getPackageDir(), "CHANGELOG.md"),
                "utf8",
            );
            return { text: text.slice(0, 20000) };
        } catch (err) {
            return { text: "", error: String((err as any)?.message ?? err) };
        }
    },
    // ---- session tree navigation (/tree) ---------------------------------
    /**
     * The navigable points in this thread's session tree, flattened depth-first
     * with the current leaf marked. Powers the web /tree selector.
     * @param {string} [threadId]
     */
    tree(threadId?: string) {
        const s = sessionFor(threadId);
        const sm = s?.sessionManager;
        if (!sm) return { entries: [], leafId: null };
        const leafId = sm.getLeafId?.() ?? null;
        const entries: any[] = [];
        const visit = (nodes: any[], depth: number) => {
            for (const node of nodes ?? []) {
                const info = treeEntryInfo(node);
                if (info)
                    entries.push({
                        id: node.entry.id,
                        depth,
                        current: node.entry.id === leafId,
                        ...info,
                    });
                visit(node?.children, depth + 1);
            }
        };
        visit(sm.getTree?.() ?? [], 0);
        return { entries, leafId };
    },
    /**
     * Jump the thread's leaf to `entryId` and continue from there (stays in the
     * same session file, unlike /fork). Re-broadcasts the transcript so every
     * viewer of the thread re-renders at the new point.
     * @param {string} entryId
     * @param {string} [threadId]
     */
    async navigateTree(entryId: string, threadId?: string) {
        const s = sessionFor(threadId);
        if (!s) return { error: "no active session" };
        if (!entryId) return { error: "missing entryId" };
        try {
            const result = await s.navigateTree(entryId);
            if (result?.cancelled) return { cancelled: true };
            const emit = (msg: ServerMessage) =>
                bus.broadcastToThread(threadId, msg);
            replayTranscript(s, emit);
            emit(
                footerFrame(
                    s,
                    (threadId ? threadRuntimes.get(threadId) : undefined)?.cwd,
                ),
            );
            broadcastThreads();
            return { ok: true, editorText: result?.editorText ?? "" };
        } catch (err) {
            return { error: String((err as any)?.message ?? err) };
        }
    },
    /**
     * User messages that can serve as fork points (/fork), newest last.
     * @param {string} [threadId]
     */
    forkMessages(threadId?: string) {
        const s = sessionFor(threadId);
        try {
            const items = s?.getUserMessagesForForking?.() ?? [];
            return {
                items: items.map((m: any) => ({
                    id: m.entryId,
                    text: String(m.text ?? "")
                        .replace(/\s+/g, " ")
                        .trim()
                        .slice(0, 140),
                })),
            };
        } catch {
            return { items: [] };
        }
    },
    // ---- share as a secret GitHub gist (/share) --------------------------
    /**
     * Export the session to HTML and upload it as a private gist via the GitHub
     * CLI, returning a shareable viewer URL (mirrors the pi TUI /share). Needs
     * `gh` installed + authenticated on the host.
     * @param {string} [threadId]
     */
    async share(threadId?: string) {
        const s = sessionFor(threadId);
        if (!s) return { error: "no active session" };
        try {
            await execFileP("gh", ["auth", "status"]);
        } catch (err) {
            const missing = /not found|ENOENT/i.test(
                String((err as any)?.message ?? err),
            );
            return {
                error: missing
                    ? "GitHub CLI (gh) is not installed \u2014 https://cli.github.com/"
                    : "GitHub CLI is not logged in \u2014 run: gh auth login",
            };
        }
        const tmpFile = join(tmpdir(), `pi-session-${Date.now()}.html`);
        try {
            await s.exportToHtml(tmpFile);
            const { stdout } = await execFileP("gh", [
                "gist",
                "create",
                "--public=false",
                tmpFile,
            ]);
            const gistUrl = String(stdout).trim();
            const gistId = gistUrl.split("/").pop();
            if (!gistId) return { error: "could not parse gist id from gh" };
            const base =
                process.env.PI_SHARE_VIEWER_URL || "https://pi.dev/session/";
            return { gistUrl, viewerUrl: `${base}#${gistId}` };
        } catch (err) {
            return { error: String((err as any)?.message ?? err) };
        } finally {
            unlink(tmpFile).catch(() => {});
        }
    },
};

// ---- model picker (/model) -----------------------------------------------
// Mirror the pi TUI's /model selector: list selectable models (marking the
// active one + subscription/OAuth models) and switch the thread's model. Model
// changes ripple into the thinking-level border (available levels vary per
// model) and the context bar (the `<model>` segment), so both are re-broadcast.
const modelApi = {
    /**
     * List models for the picker. Prefers models with configured auth
     * (getAvailable, matching the TUI selector); falls back to the full catalog
     * if none resolve. The active model is pinned first, then provider/id order.
     * @param {string} [threadId]
     */
    list(threadId?: string) {
        const s = sessionFor(threadId);
        const current = s?.state?.model ?? null;
        let models: any[] = [];
        try {
            models = modelRegistry.getAvailable();
        } catch {
            /* best-effort */
        }
        if (!models.length) {
            try {
                models = modelRegistry.getAll();
            } catch {
                models = [];
            }
        }
        const isCurrent = (m: any) =>
            !!current && m.provider === current.provider && m.id === current.id;
        const sub = (m: any) => {
            try {
                return !!modelRegistry.isUsingOAuth(m);
            } catch {
                return false;
            }
        };
        const items = models
            .map((m: any) => ({
                provider: m.provider,
                id: m.id,
                name: m.name ?? "",
                reasoning: !!m.reasoning,
                contextWindow: m.contextWindow ?? 0,
                sub: sub(m),
                current: isCurrent(m),
            }))
            .sort((a, b) => {
                if (a.current !== b.current) return a.current ? -1 : 1;
                return (
                    a.provider.localeCompare(b.provider) ||
                    a.id.localeCompare(b.id)
                );
            });
        return {
            current: current
                ? { provider: current.provider, id: current.id }
                : null,
            items,
        };
    },
    /**
     * Switch the thread's active model (mirrors the TUI selecting a model).
     * setModel validates auth and throws if none is configured; surface that
     * as an error rather than silently no-op.
     * @param {string} provider
     * @param {string} id
     * @param {string} [threadId]
     */
    async set(provider: string, id: string, threadId?: string) {
        const s = sessionFor(threadId);
        if (!s) return { error: "no active session" };
        const model = modelRegistry.find(provider, id);
        if (!model) return { error: `model not found: ${provider}/${id}` };
        try {
            await s.setModel(model);
        } catch (err) {
            return { error: String((err as any)?.message ?? err) };
        }
        const cwdOf = (threadId ? threadRuntimes.get(threadId) : undefined)
            ?.cwd;
        // available thinking levels can change with the model → re-assert border
        bus.broadcastToThread(threadId, thinkingLevelFrame(s));
        // the context bar's `<model>` segment must reflect the new model
        bus.broadcastToThread(threadId, footerFrame(s, cwdOf));
        bus.broadcastToThread(threadId, {
            kind: "notify",
            level: "info",
            message: `Model: ${model.provider}/${model.id}`,
        });
        return {
            ok: true,
            provider: model.provider,
            id: model.id,
            name: model.name ?? "",
        };
    },
};

// ---- slash commands (/-typeahead) ----------------------------------------
// Surface the thread's extension/prompt/skill commands (registered via
// pi.registerCommand + file-based prompts/skills) so the web `/` typeahead can
// offer them alongside its built-in client commands. Executed by falling
// through to s.prompt("/name ..."), which dispatches registered commands.
const commandsApi = {
    list(threadId?: string) {
        const rt = threadId ? threadRuntimes.get(threadId) : undefined;
        let items: any[] = [];
        try {
            items = (rt?.pi?.getCommands?.() ?? []).map((c: any) => ({
                name: c.name,
                description: c.description ?? "",
                source: c.source,
            }));
        } catch {
            /* best-effort */
        }
        // `autocomplete` tells the web `/` composer whether this thread has any
        // extension autocomplete providers registered, so it only round-trips
        // to `/autocomplete` when there's something to serve.
        return { items, autocomplete: !!rt?.piweb?.hasAutocomplete?.() };
    },
    // Execute a registered slash command by name for a thread. Resolves the
    // command off the session's extension runner and invokes its handler with a
    // freshly built ExtensionCommandContext. `bindingThread` is set so any
    // piweb surface mutations / sendMessage the handler makes route to *this*
    // thread (mirrors the reload path).
    async run(name: string, args: string, threadId?: string) {
        const rt = threadId ? threadRuntimes.get(threadId) : undefined;
        const runner = (rt?.session as any)?.extensionRunner;
        const cmd = runner?.getCommand?.(name);
        if (!rt || !cmd)
            return { ok: false, error: `unknown command: /${name}` };
        bindingThread = rt;
        try {
            const ctx = runner.createCommandContext();
            await cmd.handler(args ?? "", ctx);
            return { ok: true };
        } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
        } finally {
            bindingThread = null;
        }
    },
};

// ---- shell execution (! adds output to context, !! keeps it local) -------
/**
 * @param {string} command
 * @param {boolean} excludeFromContext
 * @param {string} [threadId]
 */
async function runBash(
    command: string,
    excludeFromContext: boolean,
    threadId?: string,
) {
    const cmd = (command ?? "").trim();
    const s = sessionFor(threadId);
    if (!s || !cmd) return;
    const emit = (msg: ServerMessage) => bus.broadcastToThread(threadId, msg);
    emit({
        kind: "bash",
        status: "start",
        command: cmd,
        excludeFromContext: !!excludeFromContext,
    });
    let streamed = false;
    try {
        const result = await s.executeBash(
            cmd,
            (chunk: string) => {
                streamed = true;
                emit({ kind: "bash", status: "chunk", text: chunk });
            },
            { excludeFromContext: !!excludeFromContext },
        );
        if (!streamed && result?.output) {
            emit({ kind: "bash", status: "chunk", text: result.output });
        }
        emit({
            kind: "bash",
            status: "end",
            exitCode: result?.exitCode ?? null,
            cancelled: !!result?.cancelled,
            truncated: !!result?.truncated,
            fullOutputPath: result?.fullOutputPath ?? null,
        });
    } catch (err) {
        emit({
            kind: "error",
            text: "bash failed: " + String((err as any)?.message ?? err),
        });
    }
}

// ---- boot -----------------------------------------------------------------
// Persist sessions so threads survive restarts; resume the most recent as the
// default thread for clients that connect without a `?thread`.
defaultThread = await createThread(SessionManager.continueRecent(cwd));

// Live-reload the palette on external settings.json / theme edits. Theme
// resolution, switching, and enumeration now live in ./theme.ts.
theme.watch();

// ---- http -----------------------------------------------------------------
// Web assets: from disk under `bun run` / `bun dev`; from the copy embedded at
// compile time when running as a standalone binary (`bun build --compile`).
const indexHtmlPath = Bun.embeddedFiles?.length
    ? (await import("./embedded.ts")).indexHtmlPath
    : join(WEB, "index.html");

// ---- project trust (/trust) --------------------------------------------
// pi gates project-local .pi resources behind a trust decision. Running via
// the SDK, pi-web resolves headless -> untrusted for trust-requiring projects
// (interactive `ctx.ui.select` never fires without a terminal). `/trust` gives
// the browser a way to set that decision: persist it to pi's shared trust.json
// (so future sessions honor it) AND flip the live session's flag, then
// session.reload() reloads resources under it. reload() PRESERVES
// settingsManager.projectTrusted (it doesn't re-resolve), so setting the flag
// first is what makes the live thread pick up the change.
// True when a thread's project has trust-requiring .pi resources but the user
// has never recorded a trust decision (`trustStore.get === null`). createThread
// starts such projects untrusted (the hard gate), and this drives the browser's
// first-load prompt. Fires once per thread per process.
function needsTrustPrompt(t: ThreadRuntime): boolean {
    if (!t.session || trustPrompted.has(t.id)) return false;
    try {
        if (!hasTrustRequiringProjectResources(t.cwd)) return false;
        return trustStore.get(t.cwd) === null;
    } catch {
        return false;
    }
}

// getProjectTrustOptions isn't exported from the package (and deep imports are
// blocked by its `exports` map), so mirror core/trust-manager.ts's
// getProjectTrustOptions(cwd, { includeSessionOnly: true }). Persistence itself
// goes through the real ProjectTrustStore, which re-normalizes these paths, so
// the keys written to trust.json stay canonical regardless of display form.
function projectTrustOptions(dir: string): Array<{
    label: string;
    trusted: boolean;
    updates: Array<{ path: string; decision: boolean | null }>;
}> {
    const trustPath = resolve(dir);
    const parent = dirname(trustPath);
    const options: Array<{
        label: string;
        trusted: boolean;
        updates: Array<{ path: string; decision: boolean | null }>;
    }> = [
        {
            label: "Trust",
            trusted: true,
            updates: [{ path: trustPath, decision: true }],
        },
    ];
    if (parent !== trustPath) {
        options.push({
            label: `Trust parent folder (${parent})`,
            trusted: true,
            updates: [
                { path: parent, decision: true },
                { path: trustPath, decision: null },
            ],
        });
    }
    options.push({
        label: "Trust (this session only)",
        trusted: true,
        updates: [],
    });
    options.push({
        label: "Do not trust",
        trusted: false,
        updates: [{ path: trustPath, decision: false }],
    });
    options.push({
        label: "Do not trust (this session only)",
        trusted: false,
        updates: [],
    });
    return options;
}

const trustApi = {
    get: (threadId?: string) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        const dir = t?.cwd || cwd;
        return {
            cwd: dir,
            options: projectTrustOptions(dir).map((o) => ({
                label: o.label,
                trusted: o.trusted,
            })),
            saved: trustStore.getEntry(dir),
            projectTrusted:
                t?.session?.settingsManager?.isProjectTrusted?.() ?? false,
        };
    },
    set: async (threadId: string | undefined, label: string) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        if (!t?.session || !t.resourceLoader || !t.piweb)
            return { ok: false, error: "no session" };
        const opt = projectTrustOptions(t.cwd).find((o) => o.label === label);
        if (!opt) return { ok: false, error: "unknown option" };
        try {
            // Persist yes/no decisions (session-only options have no updates).
            if (opt.updates.length) trustStore.setMany(opt.updates);
            // Flip the live flag, then reload resources under it (mirrors the
            // onReload path: clear surfaces, reload, re-broadcast).
            t.session.settingsManager?.setProjectTrusted?.(opt.trusted);
            t.piweb.clear();
            bindingThread = t;
            try {
                await t.session.reload();
            } finally {
                bindingThread = null;
            }
            bus.broadcastToThread(t.id, {
                kind: "surfaces",
                surfaces: t.piweb.snapshot(),
            });
            bus.broadcastToThread(t.id, {
                kind: "welcome",
                reload: true,
                ...buildWelcome(t.resourceLoader),
            });
            bus.broadcastToThread(t.id, thinkingLevelFrame(t.session));
            return {
                ok: true,
                projectTrusted:
                    t.session.settingsManager?.isProjectTrusted?.() ??
                    opt.trusted,
            };
        } catch (err) {
            return {
                ok: false,
                error: String((err as any)?.message ?? err),
            };
        }
    },
};

// ---- login (/login) ------------------------------------------------------
// Mirror the pi TUI's OAuth /login flow. The TUI drives `authStorage.login()`
// with a set of callbacks that push UI (auth URL / device code / prompts) and
// await user input; we reproduce that over the web bus. Each callback becomes a
// `login` frame broadcast to the acting thread, and the interactive callbacks
// (`onPrompt`/`onManualCodeInput`/`onSelect`) register a single-slot pending
// promise that POST `/login/respond` resolves. This is host plumbing (it owns
// `authStorage`/`modelRegistry`), so it lives here alongside `modelApi` rather
// than in an extension.
type PendingLogin = {
    threadId?: string;
    abort: AbortController;
    // the one outstanding interactive prompt, if any
    resolve?: (value: string) => void;
    reject?: (err: Error) => void;
};
const loginSessions = new Map<string, PendingLogin>();

// Re-broadcast the footer (its `<model>`/subscription segment reflects auth) so
// login/logout immediately updates the context bar, mirroring `modelApi.set`.
function refreshAuthFooter(threadId?: string) {
    const s = sessionFor(threadId);
    if (!s) return;
    const cwdOf = (threadId ? threadRuntimes.get(threadId) : undefined)?.cwd;
    bus.broadcastToThread(threadId, footerFrame(s, cwdOf));
}

// Friendly provider name (falls back to the id when unknown). Mirrors the
// TUI's modelRegistry.getProviderDisplayName resolution.
function providerDisplayName(id: string): string {
    try {
        return modelRegistry.getProviderDisplayName(id) || id;
    } catch {
        return id;
    }
}
// Whether a provider offers an API-key login (mirrors the TUI's
// isApiKeyLoginProvider): true when it has a known display name, otherwise true
// for custom providers unless they're OAuth-only. We use the display-name
// heuristic (name !== id) rather than importing the SDK's internal built-in
// tables, so it also covers extension-registered providers.
function isApiKeyLoginProvider(id: string, oauthIds: Set<string>): boolean {
    if (providerDisplayName(id) !== id) return true;
    if (oauthIds.has(id)) return false;
    return true;
}

const loginApi = {
    /**
     * Providers for the `/login` (and `/logout`) picker. For `login` this is the
     * OAuth/subscription providers *plus* every API-key-capable model provider
     * (the same union the pi TUI shows), each tagged with `authType`. For
     * `logout` it's whatever currently has a stored credential.
     * @param {string} [mode] "login" | "logout"
     * @param {string} [threadId]
     */
    providers(mode?: string, _threadId?: string) {
        const statusOf = (id: string) => {
            try {
                return authStorage.getAuthStatus(id);
            } catch {
                return {} as any;
            }
        };

        if (mode === "logout") {
            // Everything with a stored credential (api_key or oauth), like the
            // TUI's getLogoutProviderOptions.
            let stored: string[] = [];
            try {
                stored = authStorage.list();
            } catch {
                /* best-effort */
            }
            const items = stored
                .map((id) => {
                    let cred: any;
                    try {
                        cred = authStorage.get(id);
                    } catch {
                        /* skip unreadable */
                    }
                    if (!cred) return null;
                    return {
                        id,
                        name: providerDisplayName(id),
                        authType: cred.type ?? "api_key",
                        configured: true,
                    };
                })
                .filter(Boolean)
                .sort((a: any, b: any) => a.name.localeCompare(b.name));
            return { items };
        }

        let oauth: any[] = [];
        try {
            oauth = authStorage.getOAuthProviders();
        } catch {
            /* best-effort */
        }
        const oauthIds = new Set<string>(oauth.map((p: any) => p.id));

        // Subscription (OAuth) providers first.
        const items: any[] = oauth.map((p: any) => ({
            id: p.id,
            name: p.name ?? p.id,
            authType: "oauth",
            usesCallbackServer: !!p.usesCallbackServer,
            configured: !!statusOf(p.id)?.configured,
        }));

        // API-key providers: the distinct providers across the model catalog
        // (same source as the TUI's getLoginProviderOptions).
        const seen = new Set<string>();
        let models: any[] = [];
        try {
            models = modelRegistry.getAll();
        } catch {
            /* best-effort */
        }
        for (const m of models) {
            const pid = m?.provider;
            if (!pid || seen.has(pid)) continue;
            seen.add(pid);
            if (!isApiKeyLoginProvider(pid, oauthIds)) continue;
            items.push({
                id: pid,
                name: providerDisplayName(pid),
                authType: "api_key",
                configured: !!statusOf(pid)?.configured,
            });
        }

        // Sort by name; within a name, subscription (OAuth) before API key.
        items.sort(
            (a: any, b: any) =>
                a.name.localeCompare(b.name) ||
                (a.authType === b.authType
                    ? 0
                    : a.authType === "oauth"
                      ? -1
                      : 1),
        );
        return { items };
    },

    /**
     * Begin an OAuth login. Returns a `loginId` the client uses to route its
     * prompt responses; the flow itself streams `login` frames over SSE. The
     * `authStorage.login()` promise runs detached so the POST returns promptly.
     * @param {string} providerId
     * @param {string} [threadId]
     */
    async start(providerId: string, threadId?: string, authType?: string) {
        let oauthProvider: any;
        try {
            oauthProvider = authStorage
                .getOAuthProviders()
                .find((p: any) => p.id === providerId);
        } catch {
            /* fall through */
        }
        // Explicit authType wins (a provider like Anthropic offers both an OAuth
        // subscription *and* an API key); otherwise infer from whether the
        // provider registers an OAuth flow.
        const isOAuth = authType ? authType === "oauth" : !!oauthProvider;
        if (isOAuth && !oauthProvider)
            return { error: `unknown OAuth provider: ${providerId}` };

        const loginId = "login_" + Math.random().toString(36).slice(2, 10);
        const abort = new AbortController();
        const pending: PendingLogin = { threadId, abort };
        loginSessions.set(loginId, pending);

        const emit = (event: Record<string, unknown>) =>
            bus.broadcastToThread(threadId, {
                kind: "login",
                loginId,
                ...event,
            });
        // Register the single outstanding interactive prompt and await its
        // answer (delivered by respond()) or rejection (by cancel()).
        const awaitInput = () =>
            new Promise<string>((resolve, reject) => {
                pending.resolve = resolve;
                pending.reject = reject;
            });

        const name = isOAuth
            ? (oauthProvider.name ?? providerId)
            : providerDisplayName(providerId);
        const prov = { id: providerId, name };
        emit({ event: "start", provider: prov });

        if (!isOAuth) {
            // API-key providers aren't driven by authStorage.login(): prompt for
            // the key, store it, and refresh models — mirroring the TUI's
            // showApiKeyLoginDialog. (Amazon Bedrock really wants AWS creds / a
            // bearer token; we still store whatever value is entered.)
            void (async () => {
                try {
                    emit({
                        event: "prompt",
                        promptKind: "secret",
                        message: `Enter API key for ${name}:`,
                    });
                    const key = (await awaitInput()).trim();
                    if (!key) throw new Error("API key cannot be empty.");
                    authStorage.set(providerId, { type: "api_key", key });
                    try {
                        modelRegistry.refresh();
                    } catch {
                        /* refresh is best-effort */
                    }
                    emit({ event: "done", ok: true, provider: prov });
                    bus.broadcastToThread(threadId, {
                        kind: "notify",
                        level: "success",
                        message: `Saved API key for ${name}`,
                    });
                    refreshAuthFooter(threadId);
                } catch (err: any) {
                    const msg = String(err?.message ?? err);
                    if (msg === "Login cancelled") emit({ event: "cancelled" });
                    else emit({ event: "done", ok: false, error: msg });
                } finally {
                    loginSessions.delete(loginId);
                }
            })();
            return { ok: true, loginId, provider: prov, authType: "api_key" };
        }

        void (async () => {
            try {
                await authStorage.login(providerId, {
                    onAuth: (info: any) =>
                        emit({
                            event: "auth_url",
                            url: info.url,
                            instructions: info.instructions,
                        }),
                    onDeviceCode: (info: any) =>
                        emit({ event: "device_code", ...info }),
                    onPrompt: async (prompt: any) => {
                        emit({
                            event: "prompt",
                            promptKind: "text",
                            message: prompt.message,
                            placeholder: prompt.placeholder,
                            allowEmpty: !!prompt.allowEmpty,
                        });
                        return awaitInput();
                    },
                    // Callback-server providers race a browser redirect against a
                    // manually pasted redirect URL; we offer the paste box.
                    onManualCodeInput: async () => {
                        emit({
                            event: "prompt",
                            promptKind: "manual_code",
                            message:
                                "Paste the redirect URL here, or finish signing in via the browser:",
                        });
                        return awaitInput();
                    },
                    onSelect: async (prompt: any) => {
                        emit({
                            event: "prompt",
                            promptKind: "select",
                            message: prompt.message,
                            options: prompt.options,
                        });
                        return awaitInput();
                    },
                    onProgress: (message: string) =>
                        emit({ event: "progress", message }),
                    signal: abort.signal,
                });
                // Success: reload models so newly authed ones become selectable.
                try {
                    modelRegistry.refresh();
                } catch {
                    /* refresh is best-effort */
                }
                emit({ event: "done", ok: true, provider: prov });
                bus.broadcastToThread(threadId, {
                    kind: "notify",
                    level: "success",
                    message: `Logged in to ${prov.name}`,
                });
                refreshAuthFooter(threadId);
            } catch (err: any) {
                const msg = String(err?.message ?? err);
                if (msg === "Login cancelled") emit({ event: "cancelled" });
                else emit({ event: "done", ok: false, error: msg });
            } finally {
                loginSessions.delete(loginId);
            }
        })();

        return {
            ok: true,
            loginId,
            provider: prov,
            authType: "oauth",
            usesCallbackServer: !!oauthProvider.usesCallbackServer,
        };
    },

    /**
     * Deliver the browser's answer to the outstanding interactive prompt.
     * @param {string} loginId
     * @param {string} value
     */
    respond(loginId: string, value: string) {
        const p = loginSessions.get(loginId);
        if (!p?.resolve) return { ok: false };
        const resolve = p.resolve;
        p.resolve = undefined;
        p.reject = undefined;
        resolve(String(value ?? ""));
        return { ok: true };
    },

    /**
     * Cancel the whole flow (Esc / backdrop / dialog close): reject any pending
     * prompt and abort the login so `authStorage.login()` unwinds.
     * @param {string} loginId
     */
    cancel(loginId: string) {
        const p = loginSessions.get(loginId);
        if (!p) return { ok: false };
        p.reject?.(new Error("Login cancelled"));
        p.resolve = undefined;
        p.reject = undefined;
        try {
            p.abort.abort();
        } catch {
            /* already settled */
        }
        return { ok: true };
    },

    /**
     * Remove stored credentials for a provider (`/logout` parity).
     * @param {string} providerId
     * @param {string} [threadId]
     */
    logout(providerId: string, threadId?: string) {
        try {
            authStorage.logout(providerId);
            try {
                modelRegistry.refresh();
            } catch {
                /* refresh is best-effort */
            }
            refreshAuthFooter(threadId);
            return { ok: true };
        } catch (err: any) {
            return { ok: false, error: String(err?.message ?? err) };
        }
    },
};

const server = createApp({
    web: WEB,
    indexHtmlPath,
    theme: theme.vars(),
    bus,
    piweb,
    // TS front-end bundle (cached in prod, rebuilt per-request when PI_WEB_DEV=1)
    bundleWeb: makeWebBundler(WEB, process.env.PI_WEB_DEV === "1"),
    threads,
    sessionApi,
    modelApi,
    commandsApi,
    loginApi,
    trustApi,
    // Project file list for the browser's `@` mention typeahead, scoped to the
    // viewing thread's working directory.
    listFiles: (threadId) =>
        listProjectFiles(
            (threadId ? threadRuntimes.get(threadId) : undefined)?.cwd,
        ),
    // Run this thread's registered autocomplete providers for the composer.
    // The thread's cwd is injected here (the host owns it) so providers that
    // resolve filesystem paths don't fall back to the server's launch dir —
    // pi-web never emits `session_start`, so extensions can't learn the cwd
    // that way.
    autocomplete: async (threadId, ctx) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        if (!t?.piweb?.autocomplete) return null;
        return (await t.piweb.autocomplete({ ...ctx, cwd: t.cwd })) ?? null;
    },
    // Directory suggestions for the `/new <dir>` typeahead.
    listDirs: (q, threadId) => listProjectDirs(q, threadId),
    // On SSE (re)connect, resolve + replay the thread this client is viewing
    // (from `?thread`), returning the resolved id so the connection is tagged.
    onConnect: (send, ctx) => handleConnect(send, ctx?.threadId),
    /**
     * @param {string} command
     * @param {boolean} exclude
     * @param {string} [threadId]
     */
    onBash: (command, exclude, threadId) => runBash(command, exclude, threadId),
    /**
     * Cancel a running user-run shell command (Esc in the web UI).
     * @param {string} [threadId]
     */
    onAbortBash: (threadId) => {
        const s = sessionFor(threadId);
        if (s?.isBashRunning) s.abortBash();
    },
    /**
     * Client-driven overlay control (Esc / backdrop close).
     * @param {string} [threadId]
     * @param {"open"|"close"} op
     * @param {string} id
     */
    onSurface: (threadId, op, id) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        if (!t?.piweb || !id) return;
        if (op === "open") t.piweb.openOverlay(id);
        else if (op === "close") t.piweb.closeOverlay(id);
    },
    /**
     * Deliver a browser's answer to a blocking dialog back to the awaiting
     * extension, routed to the thread that opened it.
     * @param {string|undefined} threadId
     * @param {string} requestId
     * @param {any} value
     */
    onUiResponse: (threadId, requestId, value) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        if (!t?.piweb || !requestId) return;
        t.piweb.resolveUiRequest(requestId, value);
    },
    /**
     * Store the browser's composer-text echo so `piweb.getEditorText()` returns
     * the live value (pi-tui parity). Per-thread; the client debounces sends.
     * @param {string|undefined} threadId
     * @param {string} text
     */
    onEditorText: (threadId, text) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        t?.piweb?.updateEditorText?.(text);
    },
    /**
     * @param {string} text
     * @param {string} [threadId]
     * @param {{data:string; mimeType:string}[]} [images]
     */
    onPrompt: (text, threadId, images) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        const s = t?.session ?? sessionFor(threadId);
        if (!s) return;
        // Route this thread's registry for any extension command dispatched by
        // s.prompt (e.g. a `/command` handler that calls piweb.select/notify).
        // The prompt runs the handler before any event sets currentThread, so a
        // fresh thread would otherwise fall back to the no-op registry.
        if (t) currentThread = t;
        // While a turn is in flight, pi keeps letting you type: each message is
        // appended to the thread's steering queue instead of starting a second
        // concurrent turn. Steering messages are injected at the next message
        // boundary (adjusting course) and, if the turn ends first, delivered as
        // the next turn automatically. `streamingBehavior` is required by the
        // SDK when streaming, so only pass it when a turn is actually running.
        const opts = s.isStreaming ? { streamingBehavior: "steer" } : undefined;
        // Attach any pasted/dropped images (base64 blocks) to the message.
        // Normalize to well-formed ImageContent blocks: the web client sends
        // `{ data, mimeType }`, but the SDK splices these straight into the user
        // message content and downstream consumers (provider transforms, and our
        // own `imagesOf` transcript extractor) key off `type: "image"`. Without
        // it the image is dropped from the rendered bubble and the model input.
        const imageBlocks = images?.length
            ? images.map((img) => ({ type: "image", ...img }))
            : undefined;
        const promptOpts = imageBlocks
            ? { ...opts, images: imageBlocks }
            : opts;
        s.prompt(text, promptOpts as any).catch((err: any) =>
            bus.broadcastToThread(threadId, {
                kind: "error",
                text: String((err as any)?.message ?? err),
            }),
        );
    },
    /**
     * Restore the thread's queued (steering/follow-up) messages: clear the
     * queue and return the messages so the client can pop them back into the
     * composer to edit/delete. When `abort` is set (Esc while working) the
     * in-flight turn is also interrupted — mirroring the pi TUI's
     * `restoreQueuedMessagesToEditor({ abort })`.
     * @param {string|undefined} threadId
     * @param {boolean} abort
     * @returns {Promise<{items:string[]}>}
     */
    onDequeue: async (threadId, abort) => {
        const s = sessionFor(threadId);
        if (!s) return { items: [] };
        let items: string[] = [];
        try {
            const { steering, followUp } = s.clearQueue?.() ?? {
                steering: [],
                followUp: [],
            };
            items = [...steering, ...followUp];
        } catch {
            /* best-effort */
        }
        // reflect the now-empty queue to every viewer of this thread
        bus.broadcastToThread(threadId, { kind: "queue", items: [] });
        if (abort) {
            try {
                if (s.isStreaming) await s.abort();
                bus.broadcastToThread(threadId, {
                    kind: "system",
                    text: "interrupted",
                });
            } catch (err) {
                bus.broadcastToThread(threadId, {
                    kind: "error",
                    text:
                        "interrupt failed: " +
                        String((err as any)?.message ?? err),
                });
            } finally {
                const t = threadId ? threadRuntimes.get(threadId) : null;
                if (t) t.busy = false;
                bus.broadcastToThread(threadId, {
                    kind: "working",
                    busy: false,
                });
                broadcastThreads();
            }
        }
        return { items };
    },
    /**
     * Toggle the persisted pi "hide thinking blocks" setting (Ctrl+T in the
     * web UI). The setting is global, so the new value is broadcast to every
     * connected client.
     * @param {boolean} hidden
     * @param {string} [threadId]
     */
    onThinkingVisibility: (hidden, threadId) => {
        const s = sessionFor(threadId) ?? defaultThread?.session;
        try {
            s?.settingsManager?.setHideThinkingBlock?.(!!hidden);
        } catch {
            /* best-effort persistence */
        }
        broadcast({ kind: "thinking_visibility", hidden: !!hidden });
    },
    /**
     * Cycle or set the per-session reasoning level (Shift+Tab in the web UI).
     * Unlike "hide thinking blocks", the level is per-session, so the new value
     * is broadcast only to the thread's viewers.
     * @param {"cycle"|"set"} op
     * @param {string} [level]
     * @param {string} [threadId]
     */
    onThinkingLevel: (op, level, threadId) => {
        const s = sessionFor(threadId) ?? defaultThread?.session;
        if (!s) return;
        let newLevel;
        try {
            if (op === "set") {
                if (level) s.setThinkingLevel?.(level as any);
                newLevel = s.thinkingLevel;
            } else {
                newLevel = s.cycleThinkingLevel?.();
                if (newLevel === undefined) {
                    bus.broadcastToThread(threadId, {
                        kind: "notify",
                        level: "info",
                        message: "Current model does not support thinking",
                    });
                    return;
                }
            }
        } catch (err) {
            bus.broadcastToThread(threadId, {
                kind: "error",
                text:
                    "thinking level failed: " +
                    String((err as any)?.message ?? err),
            });
            return;
        }
        bus.broadcastToThread(threadId, thinkingLevelFrame(s));
        // keep the context bar's `• thinking <level>` segment in sync
        bus.broadcastToThread(threadId, footerFrame(s));
        // mirror the pi TUI's showStatus(`Thinking level: <x>`) on cycle/set
        bus.broadcastToThread(threadId, {
            kind: "notify",
            level: "info",
            message: `Thinking level: ${newLevel}`,
        });
    },
    /**
     * Interrupt the agent mid-turn (Esc in the web UI). Aborts the current
     * operation and waits for the thread to go idle.
     * @param {string} [threadId]
     */
    onInterrupt: async (threadId) => {
        const s = sessionFor(threadId);
        if (!s?.isStreaming) return;
        try {
            await s.abort();
            bus.broadcastToThread(threadId, {
                kind: "system",
                text: "interrupted",
            });
        } catch (err) {
            bus.broadcastToThread(threadId, {
                kind: "error",
                text:
                    "interrupt failed: " + String((err as any)?.message ?? err),
            });
        } finally {
            const t = threadId ? threadRuntimes.get(threadId) : null;
            if (t) t.busy = false;
            bus.broadcastToThread(threadId, { kind: "working", busy: false });
            broadcastThreads();
        }
    },
    /**
     * Self-modify hook: re-discover extensions for the given thread and
     * re-register its panels.
     * @param {string} [threadId]
     */
    onReload: async (threadId) => {
        const t = threadId ? threadRuntimes.get(threadId) : null;
        if (!t?.resourceLoader || !t.piweb || !t.session) return;
        t.piweb.clear();
        bindingThread = t;
        try {
            // Mirror the pi TUI's /reload: call session.reload(), NOT just
            // resourceLoader.reload(). session.reload() re-evaluates extension
            // modules from disk AND rebuilds the live session's runtime in
            // place (tool registry, message renderers, providers, flags,
            // shortcuts) via _buildRuntime(), so tool/renderer edits take
            // effect without recreating the session or restarting pi-web.
            // resourceLoader.reload() alone re-reads the module but leaves the
            // running session bound to the stale runtime.
            await t.session.reload();
            bus.broadcastToThread(threadId, {
                kind: "surfaces",
                surfaces: t.piweb.snapshot(),
            });
            // refresh the intro view with the newly loaded resources (#5).
            // `reload` tells the client to also echo the intro inline at the
            // bottom of the transcript, not just refresh the pinned banner.
            bus.broadcastToThread(threadId, {
                kind: "welcome",
                reload: true,
                ...buildWelcome(t.resourceLoader),
            });
            // Surface any extension that FAILED to load as an inline error so a
            // broken/new extension doesn't silently vanish — the reload
            // otherwise looks clean and the missing `/command` is a mystery.
            for (const e of extensionErrors(t.resourceLoader)) {
                bus.broadcastToThread(threadId, {
                    kind: "error",
                    text: `extension ${e.label} failed to load: ${e.message}`,
                });
            }
            // re-assert the composer's thinking-level border after reload
            // (mirrors the pi TUI re-running updateEditorBorderColor)
            bus.broadcastToThread(threadId, thinkingLevelFrame(t.session));
        } catch (err) {
            bus.broadcastToThread(threadId, {
                kind: "error",
                text: "reload failed: " + String((err as any)?.message ?? err),
            });
        } finally {
            bindingThread = null;
        }
    },
});

server.listen(PORT, HOST, () => {
    console.log(
        `\n  pi-web  →  http://${HOST}:${PORT}  (bound on all interfaces)\n  cwd: ${cwd}\n`,
    );
});

process.on("SIGINT", () => {
    try {
        for (const t of threadRuntimes.values()) {
            try {
                t.unsubscribe?.();
                t.gitWatcher?.dispose();
                t.session?.dispose();
            } catch {
                /* best-effort */
            }
        }
    } finally {
        process.exit(0);
    }
});
