/**
 * pi-web host: runs the pi agent in-process (createAgentSession) and serves a
 * web cockpit. Browser bus is SSE (server->client) + POST (client->server) so
 * there are zero extra dependencies.
 *
 * Transport (SSE/POST/static/health/threads) lives in ./app.mjs and is
 * agent-independent; this file owns agent bootstrap, the event -> cockpit
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
import { readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { execFile } from "node:child_process";
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
} from "@earendil-works/pi-coding-agent";

import { createPiWebHost } from "./piweb-host.mjs";
import { createBus, createApp } from "./app.mjs";

/**
 * @typedef {import("@earendil-works/pi-coding-agent").AgentSession} AgentSession
 * @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI
 * @typedef {ReturnType<typeof createPiWebHost>} PiWebRegistry
 */

/**
 * A live, independently-running conversation thread.
 *
 * @typedef {object} ThreadRuntime
 * @property {string} id                       session id (stable registry key)
 * @property {SessionManager} sm               this thread's session manager
 * @property {AgentSession|null} session       the in-process agent session
 * @property {ExtensionAPI|null} pi            this thread's live ExtensionAPI
 * @property {PiWebRegistry|null} piweb        this thread's panel registry
 * @property {DefaultResourceLoader|null} resourceLoader  extension loader
 * @property {(() => void)|null} unsubscribe   detaches the event listener
 * @property {boolean} busy                    a turn is currently in flight
 */

/** A serializable server->client cockpit frame. @typedef {{kind:string,[k:string]:any}} CockpitMessage */

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? "0.0.0.0";
const cwd = process.cwd();

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
/** @type {{ at: number, items: string[] } | null} */
let fileCache = null;

async function walkFiles(dir, base, out) {
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

async function listProjectFiles() {
    if (fileCache && Date.now() - fileCache.at < FILE_CACHE_TTL_MS) {
        return fileCache.items;
    }
    let items;
    try {
        const { stdout } = await execFileP(
            "git",
            ["ls-files", "--cached", "--others", "--exclude-standard"],
            { cwd, maxBuffer: 64 * 1024 * 1024 },
        );
        items = stdout.split("\n").filter(Boolean).slice(0, FILE_LIST_CAP);
    } catch {
        items = [];
        await walkFiles(cwd, cwd, items);
    }
    fileCache = { at: Date.now(), items };
    return items;
}

// ---- browser bus (SSE) ----------------------------------------------------
const bus = createBus();
const broadcast = bus.broadcast;

// ---- thread registry ------------------------------------------------------
/** @type {Map<string, ThreadRuntime>} */
const threadRuntimes = new Map();
/** Fallback thread for clients that connect without a `?thread`. @type {ThreadRuntime|null} */
let defaultThread = null;
/** Thread whose extensions are registering panels *right now* (during boot/reload). @type {ThreadRuntime|null} */
let bindingThread = null;
/** Thread currently handling a panel action dispatch. @type {ThreadRuntime|null} */
let dispatchingThread = null;
/** Thread whose extension code is executing now (event handlers route surface
 * updates here). @type {ThreadRuntime|null} */
let currentThread = null;

/** @param {string|undefined|null} id */
const sessionFor = (id) =>
    id ? (threadRuntimes.get(id)?.session ?? null) : null;

// ---- piweb router (injected into extensions) ------------------------------
// Each thread has its own panel registry; the global __PIWEB__ that extensions
// talk to routes to whichever thread is currently binding (during boot/reload)
// or dispatching (during a panel action). Panel writes reach only the clients
// viewing that thread, via the thread registry's broadcast().
const nullRegistry = {
    dock() {},
    overlay() {},
    removeDock() {},
    removeOverlay() {},
    remove() {},
    openOverlay() {},
    closeOverlay() {},
    notify() {},
    setStatus() {},
    clear() {},
    snapshot() {
        return {
            docks: { left: [], right: [], bottom: [], footer: [] },
            overlays: [],
            status: [],
        };
    },
    async dispatch() {},
};
const activeRegistry = () =>
    (bindingThread ?? dispatchingThread ?? currentThread)?.piweb ??
    nullRegistry;
const piweb = {
    present: true,
    dock: (...a) => activeRegistry().dock(...a),
    overlay: (...a) => activeRegistry().overlay(...a),
    removeDock: (...a) => activeRegistry().removeDock(...a),
    removeOverlay: (...a) => activeRegistry().removeOverlay(...a),
    remove: (...a) => activeRegistry().remove(...a),
    openOverlay: (...a) => activeRegistry().openOverlay(...a),
    closeOverlay: (...a) => activeRegistry().closeOverlay(...a),
    notify: (...a) => activeRegistry().notify(...a),
    setStatus: (...a) => activeRegistry().setStatus(...a),
    clear: (...a) => activeRegistry().clear(...a),
    snapshot: () => activeRegistry().snapshot(),
    /**
     * Route a surface action to the owning thread's registry.
     * @param {string} surfaceId
     * @param {string} action
     * @param {any} payload
     * @param {string} [threadId]
     */
    async dispatch(surfaceId, action, payload, threadId) {
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

// pi-web defaults to the `meridian` provider. That provider is registered by
// the pi-meridian extension *during* session startup, so it isn't resolvable
// until after createAgentSession. We pin it afterwards via setModel.
// Override with PI_PROVIDER / PI_MODEL.
const PROVIDER = process.env.PI_PROVIDER ?? "meridian";
const MODEL_ID = process.env.PI_MODEL ?? "claude-opus-4-8";
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// ---- text helpers ---------------------------------------------------------
/**
 * Pull plain text out of a message's content (string | block[]).
 * @param {unknown} content
 * @returns {string}
 */
function textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("");
}
/**
 * Pull thinking/reasoning text out of a message's content (block[] only).
 * Thinking lives as `{ type:"thinking", thinking, redacted? }` content blocks.
 * @param {unknown} content
 * @returns {string}
 */
function thinkingOf(content) {
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
function thinkingHidden(s) {
    try {
        return !!s?.settingsManager?.getHideThinkingBlock?.();
    } catch {
        return false;
    }
}
/**
 * @param {unknown} raw
 * @returns {string}
 */
function describeError(raw) {
    if (!raw) return "model returned an error";
    try {
        return JSON.parse(String(raw))?.error?.message ?? String(raw);
    } catch {
        return String(raw);
    }
}

/** @param {AgentSession} s */
async function pinModel(s) {
    const model = modelRegistry.find(PROVIDER, MODEL_ID);
    if (model) {
        await s.setModel(model);
        console.log(
            `  model:  ${model.provider}/${model.id} (${model.name ?? ""})`,
        );
    } else {
        const cur = s.state?.model;
        console.warn(
            `  model:  ${PROVIDER}/${MODEL_ID} not found — using ${cur?.provider}/${cur?.id}`,
        );
    }
}

// ---- per-thread event translation -----------------------------------------
// Translate one thread's agent events -> cockpit frames, routed to the clients
// viewing this thread. Background threads (no current viewers) still run; their
// frames simply reach nobody and are restored via replay on the next view.
/**
 * @param {ThreadRuntime} thread
 * @returns {() => void} unsubscribe
 */
function subscribe(thread) {
    let streamed = false;
    let streamedThinking = false;
    /** @param {CockpitMessage} msg */
    const emit = (msg) => bus.broadcastToThread(thread.id, msg);
    return thread.session.subscribe((ev) => {
        // route surface updates from this thread's extension event handlers
        // (setStatus, dock, notify, …) to its own registry
        currentThread = thread;
        switch (ev.type) {
            case "message_start":
                if (ev.message?.role === "user") {
                    emit({ kind: "user", text: textOf(ev.message.content) });
                } else if (ev.message?.role === "assistant") {
                    streamed = false;
                    streamedThinking = false;
                    if (!thread.busy) {
                        thread.busy = true;
                        // drive the cockpit "Working" spinner (pi-tui style)
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
                emit({
                    kind: "tool",
                    id: ev.toolCallId,
                    name: ev.toolName,
                    status: "start",
                    args: ev.args,
                });
                break;
            case "tool_execution_end":
                emit({
                    kind: "tool",
                    id: ev.toolCallId,
                    name: ev.toolName,
                    status: "end",
                    isError: ev.isError,
                });
                break;
            case "agent_end":
                thread.busy = false;
                emit({ kind: "assistant_end" });
                emit({ kind: "working", busy: false });
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
function makeThread(sm) {
    /** @type {ThreadRuntime} */
    const thread = {
        id: sm.getSessionId(),
        sm,
        session: null,
        pi: null,
        piweb: null,
        resourceLoader: null,
        unsubscribe: null,
        busy: false,
    };
    thread.piweb = createPiWebHost({
        // panels reach only the clients viewing this thread
        // surface frames reach only the clients viewing this thread
        broadcast: (frame) => bus.broadcastToThread(thread.id, frame),
        getPi: () => thread.pi,
    });
    return thread;
}

/**
 * Boot (or resume) a thread into the registry.
 * @param {SessionManager} sm
 * @returns {Promise<ThreadRuntime>}
 */
function createThread(sm) {
    const run = createChain.then(async () => {
        const thread = makeThread(sm);
        const resourceLoader = new DefaultResourceLoader({
            cwd,
            agentDir: getAgentDir(),
            // Project extensions live in .pi/extensions. They're loaded
            // explicitly (rather than via project-trust discovery) so the
            // headless web host doesn't need a trust prompt. The loader dedupes
            // by path if the project is also trusted.
            additionalExtensionPaths: [
                join(cwd, ".pi", "extensions", "context-bar", "index.ts"),
            ],
            // Inline factory captures this thread's live ExtensionAPI so panel
            // actions call back into *this* thread (pi.sendUserMessage, etc).
            extensionFactories: [
                (pi) => {
                    thread.pi = pi;
                },
            ],
        });
        await resourceLoader.reload();
        thread.resourceLoader = resourceLoader;

        bindingThread = thread; // route panel registration to this thread
        try {
            const created = await createAgentSession({
                cwd,
                resourceLoader,
                sessionManager: sm,
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
async function ensureLoaded(id) {
    if (!id) return null;
    const existing = threadRuntimes.get(id);
    if (existing) return existing;
    const infos = await SessionManager.list(cwd);
    const info = infos.find((i) => i.id === id);
    if (!info) return null;
    return createThread(SessionManager.open(info.path));
}

// Replay a thread's history into the transcript.
// `send` writes to a single client (used on SSE connect / per-thread replay).
// NOTE: this reads buildSessionContext() (in-memory), which works even for
// threads not yet flushed to disk (the SDK only writes the .jsonl after the
// first assistant message) — so a refresh restores a brand-new thread too.
/**
 * @param {AgentSession} s
 * @param {(msg: CockpitMessage) => void} send
 */
function replayTranscript(s, send) {
    send({ kind: "transcript_reset" });
    let messages = [];
    try {
        const ctx = s.sessionManager.buildSessionContext?.();
        messages = Array.isArray(ctx?.messages) ? ctx.messages : [];
    } catch {
        messages = [];
    }
    for (const m of messages) {
        switch (m?.role) {
            case "user":
                send({ kind: "user", text: textOf(m.content) });
                break;
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
                });
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
                });
                break;
        }
    }
}

/**
 * Resolve + replay the thread a freshly-connected client is viewing. Sends that
 * client its panels and transcript, and returns the resolved id so the SSE
 * connection can be tagged (and the browser can canonicalize its URL).
 * @param {(msg: CockpitMessage) => void} send
 * @param {string|undefined} threadId
 * @returns {Promise<string|undefined>}
 */
async function handleConnect(send, threadId) {
    let t = null;
    try {
        t = await ensureLoaded(threadId);
    } catch {
        t = null;
    }
    if (!t) t = defaultThread;
    if (!t?.session || !t.piweb) return undefined;
    send({ kind: "surfaces", surfaces: t.piweb.snapshot() });
    // reflect the persisted pi "hide thinking blocks" setting
    send({ kind: "thinking_visibility", hidden: thinkingHidden(t.session) });
    replayTranscript(t.session, send);
    send({ kind: "thread_switched", id: t.id });
    // reflect the thread's current activity (e.g. focusing a busy background
    // thread should show the spinner immediately)
    send({ kind: "working", busy: !!t.busy });
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
        const infos = await SessionManager.list(cwd);
        const items = infos
            .slice()
            .sort((a, b) => new Date(b.modified) - new Date(a.modified))
            .map((i) => {
                const rt = threadRuntimes.get(i.id);
                return {
                    id: i.id,
                    name: i.name || i.firstMessage || "(new thread)",
                    messageCount: i.messageCount,
                    modified: i.modified,
                    running: rt?.busy ?? false, // turn in flight (any viewer or none)
                    loaded: !!rt, // live in the registry (running in-process)
                };
            });
        // The SDK only flushes a session to disk after its first assistant
        // message, so brand-new or still-running threads won't appear in
        // `infos`. Surface every live in-registry thread so they stay visible
        // and resumable across browser refreshes (the server keeps them alive).
        const onDisk = new Set(infos.map((i) => i.id));
        for (const [id, rt] of threadRuntimes) {
            if (onDisk.has(id)) continue;
            const sm = rt.session?.sessionManager;
            let messageCount = 0;
            let firstMessage = "";
            try {
                const msgs = sm?.buildSessionContext?.().messages ?? [];
                messageCount = msgs.length;
                const u = msgs.find((m) => m?.role === "user");
                if (u) firstMessage = textOf(u.content).slice(0, 80);
            } catch {}
            items.unshift({
                id,
                name: sm?.getSessionName?.() || firstMessage || "(new thread)",
                messageCount,
                modified: new Date(),
                running: rt.busy ?? false,
                loaded: true,
            });
        }
        return items;
    },
    /** Create a fresh thread and return its id (the client navigates to it). */
    async create() {
        const t = await createThread(SessionManager.create(cwd));
        return { id: t.id };
    },
    /**
     * Resume a thread into the registry (clients view it by reopening the SSE
     * stream with `?thread=<id>`; this just guarantees it is live).
     * @param {string} id
     */
    async switch(id) {
        if (!id) return;
        const t = await ensureLoaded(id);
        if (!t) throw new Error(`unknown thread: ${id}`);
    },
};

// ---- session commands (/session, /name, /compact, /export, /changelog) ----
// All operate on the thread named by the calling client (threadId).
const sessionApi = {
    /** @param {string} [threadId] */
    info(threadId) {
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
    setName(name, threadId) {
        const n = (name ?? "").trim();
        const s = sessionFor(threadId);
        if (n && s) {
            s.setSessionName(n);
            broadcastThreads();
            bus.broadcastToThread(threadId, {
                kind: "system",
                text: `renamed thread to “${n}”`,
            });
        }
    },
    /** @param {string} [threadId] */
    async compact(threadId) {
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
            broadcastThreads();
        } catch (err) {
            bus.broadcastToThread(threadId, {
                kind: "error",
                text: "compact failed: " + String(err?.message ?? err),
            });
        }
    },
    /**
     * @param {"html"|"jsonl"} format
     * @param {string} [threadId]
     */
    async export(format, threadId) {
        const s = sessionFor(threadId);
        if (!s) return { error: "no active session" };
        try {
            const path =
                format === "jsonl" ? s.exportToJsonl() : await s.exportToHtml();
            return { path, format: format === "jsonl" ? "jsonl" : "html" };
        } catch (err) {
            return { error: String(err?.message ?? err) };
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
            return { text: "", error: String(err?.message ?? err) };
        }
    },
};

// ---- shell execution (! adds output to context, !! keeps it local) -------
/**
 * @param {string} command
 * @param {boolean} excludeFromContext
 * @param {string} [threadId]
 */
async function runBash(command, excludeFromContext, threadId) {
    const cmd = (command ?? "").trim();
    const s = sessionFor(threadId);
    if (!s || !cmd) return;
    /** @param {CockpitMessage} msg */
    const emit = (msg) => bus.broadcastToThread(threadId, msg);
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
            (chunk) => {
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
        });
    } catch (err) {
        emit({
            kind: "error",
            text: "bash failed: " + String(err?.message ?? err),
        });
    }
}

// ---- boot -----------------------------------------------------------------
// Persist sessions so threads survive restarts; resume the most recent as the
// default thread for clients that connect without a `?thread`.
defaultThread = await createThread(SessionManager.continueRecent(cwd));

// Mirror the active pi theme into the cockpit: read settings.json ->
// themes/<name>.json under the agent dir and resolve to cockpit CSS variables.
// Missing tokens fall back to the client's :root defaults.
function loadPiTheme() {
    try {
        const dir = getAgentDir();
        const settings = JSON.parse(
            readFileSync(join(dir, "settings.json"), "utf8"),
        );
        const name = settings.theme;
        if (!name) return {};
        const theme = JSON.parse(
            readFileSync(join(dir, "themes", `${name}.json`), "utf8"),
        );
        const vars = theme.vars ?? {};
        const colors = theme.colors ?? {};
        const pick = (t) => vars[colors[t] ?? t] ?? vars[t] ?? null;
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
        };
        const out = {};
        for (const [k, v] of Object.entries(map)) if (v) out[k] = v;
        return out;
    } catch {
        return {};
    }
}
const piTheme = loadPiTheme();

// ---- http -----------------------------------------------------------------
const server = createApp({
    web: WEB,
    theme: piTheme,
    bus,
    piweb,
    threads,
    sessionApi,
    // Project file list for the browser's `@` mention typeahead.
    listFiles: () => listProjectFiles(),
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
     * @param {string} text
     * @param {string} [threadId]
     */
    onPrompt: (text, threadId) => {
        const s = sessionFor(threadId);
        if (!s) return;
        s.prompt(text).catch((err) =>
            bus.broadcastToThread(threadId, {
                kind: "error",
                text: String(err?.message ?? err),
            }),
        );
    },
    /**
     * Toggle the persisted pi "hide thinking blocks" setting (Ctrl+T in the
     * cockpit). The setting is global, so the new value is broadcast to every
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
     * Interrupt the agent mid-turn (Esc in the cockpit). Aborts the current
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
                text: "interrupt failed: " + String(err?.message ?? err),
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
        if (!t?.resourceLoader || !t.piweb) return;
        t.piweb.clear();
        bindingThread = t;
        try {
            await t.resourceLoader.reload();
            bus.broadcastToThread(threadId, {
                kind: "surfaces",
                surfaces: t.piweb.snapshot(),
            });
            bus.broadcastToThread(threadId, {
                kind: "system",
                text: "reloaded extensions",
            });
        } catch (err) {
            bus.broadcastToThread(threadId, {
                kind: "error",
                text: "reload failed: " + String(err?.message ?? err),
            });
        } finally {
            bindingThread = null;
        }
    },
});

server.listen(PORT, HOST, () => {
    console.log(
        `\n  pi-web cockpit  →  http://${HOST}:${PORT}  (bound on all interfaces)\n  cwd: ${cwd}\n`,
    );
});

process.on("SIGINT", () => {
    try {
        for (const t of threadRuntimes.values()) {
            try {
                t.unsubscribe?.();
                t.session?.dispose();
            } catch {
                /* best-effort */
            }
        }
    } finally {
        process.exit(0);
    }
});
