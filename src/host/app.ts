/**
 * pi-web HTTP app: the browser bus (SSE + POST), static serving, /health, and
 * thread (session) routes.
 *
 * This layer is intentionally **agent-independent** — it knows nothing about
 * createAgentSession/models/auth. Agent-coupled behavior is injected via
 * callbacks (onPrompt/onReload/threads), which keeps the core cockpit plumbing
 * (dock/overlay -> snapshot -> dispatch -> setState -> broadcast, plus thread
 * listing/switching) testable with zero credentials.
 */
import http, {
    Server,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** An SSE response stream, tagged with the thread id the client is viewing. */
type SSEClient = ServerResponse & { __threadId?: string };

/** A JSON-ish bus frame. */
type Frame = Record<string, unknown>;

export interface Bus {
    clients: Set<SSEClient>;
    broadcast: (msg: Frame) => void;
    broadcastToThread: (threadId: string | undefined, msg: Frame) => void;
}

/** Options for {@link createApp}. Everything agent-coupled is an optional hook. */
export interface AppOptions {
    web: string;
    bus: Bus;
    piweb: any;
    theme?: Record<string, string>;
    bundleWeb?: () => Promise<string>;
    onPrompt?: (text: string, threadId?: string) => void;
    onReload?: (threadId?: string) => void | Promise<void>;
    onInterrupt?: (threadId?: string) => void | Promise<void>;
    onBash?: (command: string, exclude: boolean, threadId?: string) => void;
    onSurface?: (
        threadId: string | undefined,
        op: "open" | "close",
        id: string,
    ) => void;
    onThinkingVisibility?: (hidden: boolean, threadId?: string) => void;
    onConnect?: (
        send: (msg: Frame) => void,
        ctx: { threadId?: string },
    ) => (string | undefined) | Promise<string | undefined>;
    listFiles?: () => string[] | Promise<string[]>;
    threads?: {
        list: () => Promise<any[]>;
        create?: () => Promise<any>;
        switch?: (id: string) => Promise<void>;
    };
    sessionApi?: Record<string, (...args: any[]) => any>;
}

/**
 * SSE fan-out bus.
 *
 * `clients` holds the open response streams. Each stream is tagged (by the
 * `/events` handler) with the thread id it is viewing on `res.__threadId`, so
 * `broadcastToThread` can fan out a thread's frames only to the clients
 * watching it. `broadcast` still reaches everyone (e.g. the thread list).
 *
 * @typedef {import("node:http").ServerResponse & { __threadId?: string }} SSEClient
 * @returns {{
 *   clients: Set<SSEClient>,
 *   broadcast: (msg: any) => void,
 *   broadcastToThread: (threadId: string|undefined, msg: any) => void,
 * }}
 */
export function createBus(): Bus {
    const clients = new Set<SSEClient>();
    const frame = (msg: Frame) => `data: ${JSON.stringify(msg)}\n\n`;
    const broadcast = (msg) => {
        const line = frame(msg);
        for (const res of clients) res.write(line);
    };
    const broadcastToThread = (threadId, msg) => {
        if (!threadId) return;
        const line = frame(msg);
        for (const res of clients)
            if (res.__threadId === threadId) res.write(line);
    };
    return { clients, broadcast, broadcastToThread };
}

async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return {};
    }
}

function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" }).end(
        JSON.stringify(obj),
    );
}

/**
 * Build the HTTP server (pure transport; no agent dependency).
 *
 * @param {object}   o
 * @param {string}   o.web       absolute path to the static web dir
 * @param {object}   o.bus       createBus() result
 * @param {object}   o.piweb     piweb host registry (snapshot/dispatch)
 * Every mutating route is thread-scoped: the client sends the `threadId` it is
 * acting on (in the POST body, or `?thread=` for SSE/GET), and the host routes
 * the call to that thread's AgentSession.
 *
 * @param {object} o
 * @param {string} o.web
 * @param {ReturnType<typeof createBus>} o.bus
 * @param {object} o.piweb     piweb host registry/router (snapshot/dispatch)
 * @param {(text:string, threadId?:string)=>void} [o.onPrompt]
 * @param {(threadId?:string)=>Promise<void>} [o.onReload]
 * @param {(threadId?:string)=>Promise<void>} [o.onInterrupt]
 * @param {(command:string, exclude:boolean, threadId?:string)=>void} [o.onBash]
 * @param {object} [o.sessionApi]
 * @param {{ list:()=>Promise<any[]>, create:()=>Promise<any>, switch:(id:string)=>Promise<void> }} [o.threads]
 * @param {(send:(msg:any)=>void, ctx:{threadId?:string})=>(string|undefined)|Promise<string|undefined>} [o.onConnect]
 *        per-client replay on (re)connect; returns the resolved thread id
 * @param {(threadId?:string)=>void|Promise<void>} [o.onInterrupt]  interrupt the thread's turn
 * @param {(threadId:string|undefined, op:"open"|"close", id:string)=>void} [o.onSurface]  overlay control
 * @returns {import("node:http").Server}
 */
export function createApp({
    web,
    theme,
    bus,
    piweb,
    onPrompt,
    onReload,
    threads,
    sessionApi,
    onBash,
    onConnect,
    onInterrupt,
    onSurface,
    onThinkingVisibility,
    listFiles,
    bundleWeb,
}: AppOptions): Server {
    // `/app.js` is produced by the TS bundler (see build-web.ts); the rest are
    // served verbatim from src/web.
    const STATIC = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/index.html": ["index.html", "text/html; charset=utf-8"],
    };

    return http.createServer(async (req: IncomingMessage, res: SSEClient) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        // liveness: up regardless of model/auth
        if (path === "/health") {
            const snap = piweb.snapshot?.() ?? {};
            const d = snap.docks ?? { left: [], right: [], bottom: [] };
            const surfaces =
                (d.left?.length ?? 0) +
                (d.right?.length ?? 0) +
                (d.bottom?.length ?? 0) +
                (d.footer?.length ?? 0) +
                (snap.overlays?.length ?? 0);
            sendJson(res, 200, { ok: true, surfaces });
            return;
        }

        // SSE event stream
        if (path === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            res.write(": connected\n\n");
            const send = (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
            // the thread this client is viewing (URL-driven selection)
            const wanted = url.searchParams.get("thread") || undefined;
            res.__threadId = wanted;
            // push the active pi theme first so CSS vars apply before render
            if (theme) send({ kind: "theme", vars: theme });
            send({ kind: "surfaces", surfaces: piweb.snapshot() });
            if (threads) {
                try {
                    send({ kind: "threads", items: await threads.list() });
                } catch {
                    /* listing is best-effort on connect */
                }
            }
            // Resolve + replay the viewed thread to *this* client only, so a
            // browser refresh restores the conversation (and an unknown id
            // falls back to the default thread). Tag the connection with the
            // resolved id so per-thread broadcasts reach it.
            if (onConnect) {
                try {
                    const resolved = await onConnect(send, {
                        threadId: wanted,
                    });
                    if (resolved) res.__threadId = resolved;
                } catch {
                    /* replay is best-effort on connect */
                }
            }
            bus.clients.add(res);
            req.on("close", () => bus.clients.delete(res));
            return;
        }

        // list threads
        if (req.method === "GET" && path === "/threads") {
            const items = threads ? await threads.list() : [];
            sendJson(res, 200, { items });
            return;
        }

        // session info / changelog (read-only)
        if (req.method === "GET" && path === "/session") {
            const threadId = url.searchParams.get("thread") || undefined;
            sendJson(res, 200, (await sessionApi?.info?.(threadId)) ?? {});
            return;
        }
        if (req.method === "GET" && path === "/changelog") {
            sendJson(
                res,
                200,
                (await sessionApi?.changelog?.()) ?? { text: "" },
            );
            return;
        }

        // project file list for the `@` mention typeahead (read-only). The
        // client caches this and fuzzy-filters locally as the user types.
        if (req.method === "GET" && path === "/files") {
            const items = listFiles ? await listFiles() : [];
            sendJson(res, 200, { items });
            return;
        }

        if (req.method === "POST") {
            const body = await readBody(req);
            // thread the request targets (URL-driven selection on the client)
            const threadId = body.threadId || undefined;
            if (path === "/prompt") {
                const text = (body.text ?? "").trim();
                if (text) onPrompt?.(text, threadId);
                res.writeHead(202).end();
                return;
            }
            if (path === "/action") {
                await piweb.dispatch(
                    body.surfaceId,
                    body.action,
                    body.payload,
                    threadId,
                );
                res.writeHead(202).end();
                return;
            }
            if (path === "/surface") {
                onSurface?.(threadId, body.op, body.id);
                res.writeHead(202).end();
                return;
            }
            if (path === "/session/name") {
                await sessionApi?.setName?.(body.name, threadId);
                res.writeHead(202).end();
                return;
            }
            if (path === "/session/compact") {
                sessionApi?.compact?.(threadId); // async; progress streamed over SSE
                res.writeHead(202).end();
                return;
            }
            if (path === "/session/export") {
                const result =
                    (await sessionApi?.export?.(body.format, threadId)) ?? {};
                sendJson(res, 200, result);
                return;
            }
            if (path === "/bash") {
                onBash?.(body.command, body.excludeFromContext, threadId);
                res.writeHead(202).end();
                return;
            }
            if (path === "/threads") {
                const result = (await threads?.create?.()) ?? {};
                sendJson(res, 200, result);
                return;
            }
            if (path === "/threads/switch") {
                try {
                    await threads?.switch?.(body.id);
                    res.writeHead(202).end();
                } catch (err) {
                    sendJson(res, 409, { error: String(err?.message ?? err) });
                }
                return;
            }
            if (path === "/reload") {
                await onReload?.(threadId);
                res.writeHead(202).end();
                return;
            }
            if (path === "/interrupt") {
                onInterrupt?.(threadId); // async; result streamed over SSE
                res.writeHead(202).end();
                return;
            }
            if (path === "/thinking") {
                // toggle the global "hide thinking blocks" pi setting; the new
                // value is broadcast to all clients over SSE
                onThinkingVisibility?.(!!body.hidden, threadId);
                res.writeHead(202).end();
                return;
            }
            res.writeHead(404).end();
            return;
        }

        // bundled front-end entrypoint
        if (path === "/app.js" && bundleWeb) {
            try {
                const code = await bundleWeb();
                res.writeHead(200, {
                    "Content-Type": "text/javascript; charset=utf-8",
                }).end(code);
            } catch (err) {
                res.writeHead(500, {
                    "Content-Type": "text/javascript; charset=utf-8",
                }).end(
                    `/* web build failed */\nconsole.error(${JSON.stringify(String(err?.message ?? err))});`,
                );
            }
            return;
        }

        // static
        const entry = STATIC[path];
        if (entry) {
            try {
                const buf = await readFile(join(web, entry[0]));
                res.writeHead(200, { "Content-Type": entry[1] }).end(buf);
            } catch {
                res.writeHead(404).end("not found");
            }
            return;
        }
        res.writeHead(404).end("not found");
    });
}
