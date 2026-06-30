/**
 * pi-web host: runs the pi agent in-process (createAgentSession) and serves a
 * web cockpit. Browser bus is SSE (server->client) + POST (client->server) so
 * there are zero extra dependencies.
 *
 * Transport (SSE/POST/static/health/threads) lives in ./app.mjs and is
 * agent-independent; this file owns agent bootstrap, the event -> cockpit
 * translation, and the thread (session) lifecycle.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const WEB = join(__dirname, "..", "web");
const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? "0.0.0.0";
const cwd = process.cwd();

// ---- browser bus (SSE) ----------------------------------------------------
const bus = createBus();
const broadcast = bus.broadcast;

// ---- piweb host (injected into extensions) --------------------------------
const piweb = createPiWebHost({
    broadcastPanels: (panels) => broadcast({ kind: "panels", panels }),
    getPi: () => piweb._pi,
});
globalThis.__PIWEB__ = piweb;

// ---- agent session --------------------------------------------------------
const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    additionalExtensionPaths: [join(ROOT, "extensions", "hello-panel.ts")],
    // Inline factory captures the live ExtensionAPI so panel actions can call back
    // into the agent (pi.sendUserMessage, registerTool, etc).
    extensionFactories: [
        (pi) => {
            piweb._pi = pi;
        },
    ],
});
await resourceLoader.reload();

// pi-web defaults to the `meridian` provider. That provider is registered by
// the pi-meridian extension *during* session startup, so it isn't resolvable
// until after createAgentSession. We pin it afterwards via setModel.
// Override with PI_PROVIDER / PI_MODEL.
const PROVIDER = process.env.PI_PROVIDER ?? "meridian";
const MODEL_ID = process.env.PI_MODEL ?? "claude-opus-4-8";
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// ---- text helpers ---------------------------------------------------------
// pull plain text out of a message's content (string | block[])
function textOf(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("");
}
function describeError(raw) {
    if (!raw) return "model returned an error";
    try {
        return JSON.parse(raw)?.error?.message ?? String(raw);
    } catch {
        return String(raw);
    }
}

// ---- session lifecycle ----------------------------------------------------
// The agent has no in-place "load another session", so switching threads means
// recreating the AgentSession bound to a different SessionManager. The same
// resourceLoader is reused; panels are keyed by id so re-registration is
// idempotent.
let session = null;
let unsubscribe = null;
let busy = false; // a turn is running — block thread switches while true

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

// translate agent events -> cockpit messages.
// This provider/model emits message_start/message_end (no text_delta stream),
// so render the final message content; use deltas only when they exist.
function subscribe(s) {
    let streamed = false;
    return s.subscribe((ev) => {
        switch (ev.type) {
            case "message_start":
                if (ev.message?.role === "user")
                    broadcast({
                        kind: "user",
                        text: textOf(ev.message.content),
                    });
                else if (ev.message?.role === "assistant") {
                    streamed = false;
                    busy = true;
                }
                break;
            case "message_update": {
                const e = ev.assistantMessageEvent;
                if (e?.type === "text_delta") {
                    streamed = true;
                    broadcast({ kind: "delta", text: e.delta });
                }
                break;
            }
            case "message_end": {
                const m = ev.message;
                if (m?.role !== "assistant") break;
                if (m.stopReason === "error" || m.errorMessage)
                    broadcast({
                        kind: "error",
                        text: describeError(m.errorMessage),
                    });
                else if (!streamed) {
                    const text = textOf(m.content);
                    if (text) broadcast({ kind: "assistant_full", text });
                }
                broadcast({ kind: "assistant_end" });
                break;
            }
            case "tool_execution_start":
                broadcast({
                    kind: "tool",
                    id: ev.toolCallId,
                    name: ev.toolName,
                    status: "start",
                    args: ev.args,
                });
                break;
            case "tool_execution_end":
                broadcast({
                    kind: "tool",
                    id: ev.toolCallId,
                    name: ev.toolName,
                    status: "end",
                    isError: ev.isError,
                });
                break;
            case "agent_end":
                busy = false;
                broadcast({ kind: "assistant_end" });
                // names/recency may have changed — refresh the header title/list
                broadcastThreads();
                break;
        }
    });
}

async function bootSession(sessionManager) {
    const created = await createAgentSession({
        cwd,
        resourceLoader,
        sessionManager,
        authStorage,
        modelRegistry,
    });
    session = created.session;
    await pinModel(session);
    unsubscribe = subscribe(session);
    return session;
}

// Replay a thread's history into the transcript after a reset.
function replayTranscript(s) {
    broadcast({ kind: "transcript_reset" });
    let messages = [];
    try {
        const ctx = s.sessionManager.buildSessionContext?.();
        messages = Array.isArray(ctx?.messages) ? ctx.messages : [];
    } catch {
        messages = [];
    }
    for (const m of messages) {
        if (m?.role === "user") {
            broadcast({ kind: "user", text: textOf(m.content) });
        } else if (m?.role === "assistant") {
            const text = textOf(m.content);
            if (text) broadcast({ kind: "assistant_full", text });
            broadcast({ kind: "assistant_end" });
        }
    }
}

async function switchTo(sessionManager) {
    if (busy) throw new Error("cannot switch threads while a turn is running");
    if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
    }
    if (session) session.dispose();
    piweb.clear();
    // re-instantiate extensions (re-registers panels) for the new session
    await resourceLoader.reload();
    await bootSession(sessionManager);
    replayTranscript(session);
    broadcast({
        kind: "thread_switched",
        id: session.sessionManager.getSessionId(),
    });
    broadcastThreads();
}

// ---- threads (sessions) ---------------------------------------------------
function broadcastThreads() {
    threads
        .list()
        .then((items) => broadcast({ kind: "threads", items }))
        .catch(() => {});
}

const threads = {
    async list() {
        const infos = await SessionManager.list(cwd);
        const activeId = session?.sessionManager.getSessionId();
        return infos
            .slice()
            .sort((a, b) => new Date(b.modified) - new Date(a.modified))
            .map((i) => ({
                id: i.id,
                name: i.name || i.firstMessage || "(new thread)",
                messageCount: i.messageCount,
                modified: i.modified,
                active: i.id === activeId,
            }));
    },
    async create() {
        await switchTo(SessionManager.create(cwd));
        return { id: session.sessionManager.getSessionId() };
    },
    async switch(id) {
        if (!id) return;
        if (id === session?.sessionManager.getSessionId()) return;
        const infos = await SessionManager.list(cwd);
        const info = infos.find((i) => i.id === id);
        if (!info) throw new Error(`unknown thread: ${id}`);
        await switchTo(SessionManager.open(info.path));
    },
};

// ---- session commands (/session, /name, /compact, /export, /changelog) ----
const sessionApi = {
    info() {
        const sm = session?.sessionManager;
        return {
            id: sm?.getSessionId(),
            name: sm?.getSessionName() ?? null,
            stats: session?.getSessionStats?.() ?? null,
            usage: session?.getContextUsage?.() ?? null,
        };
    },
    setName(name) {
        const n = (name ?? "").trim();
        if (n && session) {
            session.setSessionName(n);
            broadcastThreads();
            broadcast({ kind: "system", text: `renamed thread to “${n}”` });
        }
    },
    async compact() {
        if (!session) return;
        broadcast({ kind: "system", text: "compacting context…" });
        try {
            await session.compact();
            broadcast({ kind: "system", text: "context compacted" });
            broadcastThreads();
        } catch (err) {
            broadcast({
                kind: "error",
                text: "compact failed: " + String(err?.message ?? err),
            });
        }
    },
    async export(format) {
        if (!session) return { error: "no active session" };
        try {
            const path =
                format === "jsonl"
                    ? session.exportToJsonl()
                    : await session.exportToHtml();
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

// ---- boot -----------------------------------------------------------------
// Persist sessions so threads survive restarts; resume the most recent.
await bootSession(SessionManager.continueRecent(cwd));

// ---- http -----------------------------------------------------------------
const server = createApp({
    web: WEB,
    bus,
    piweb,
    threads,
    sessionApi,
    onPrompt: (text) =>
        session
            .prompt(text)
            .catch((err) =>
                broadcast({ kind: "error", text: String(err?.message ?? err) }),
            ),
    onReload: async () => {
        // best-effort self-modify hook: re-discover extensions on disk
        piweb.clear();
        try {
            await resourceLoader.reload();
            broadcast({ kind: "system", text: "reloaded extensions" });
        } catch (err) {
            broadcast({
                kind: "error",
                text: "reload failed: " + String(err?.message ?? err),
            });
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
        session?.dispose();
    } finally {
        process.exit(0);
    }
});
