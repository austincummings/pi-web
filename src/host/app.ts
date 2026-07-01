/**
 * pi-web HTTP app: the browser bus (SSE + POST), static serving, /health, and
 * thread (session) routes.
 *
 * This layer is intentionally **agent-independent** — it knows nothing about
 * createAgentSession/models/auth. Agent-coupled behavior is injected via
 * callbacks (onPrompt/onReload/threads), which keeps the core web UI plumbing
 * (dock/overlay -> snapshot -> dispatch -> setState -> broadcast, plus thread
 * listing/switching) testable with zero credentials.
 */
import http, {
    Server,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { createRouter } from "./router.ts";

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
    /**
     * Absolute path to `index.html`. Under `bun run` this is a real file in
     * `src/web`; in a compiled binary it's the embedded copy (a `Bun.file`
     * virtual path). When set, it's served for `/` and `/index.html` instead
     * of reading from the `web` directory.
     */
    indexHtmlPath?: string;
    bus: Bus;
    piweb: any;
    theme?: Record<string, string>;
    bundleWeb?: () => Promise<string>;
    onPrompt?: (
        text: string,
        threadId?: string,
        images?: Array<{ data: string; mimeType: string }>,
    ) => void;
    onDequeue?: (
        threadId: string | undefined,
        abort: boolean,
    ) => Promise<{ items: string[] }> | { items: string[] };
    onReload?: (threadId?: string) => void | Promise<void>;
    onInterrupt?: (threadId?: string) => void | Promise<void>;
    onBash?: (command: string, exclude: boolean, threadId?: string) => void;
    onAbortBash?: (threadId?: string) => void | Promise<void>;
    onSurface?: (
        threadId: string | undefined,
        op: "open" | "close",
        id: string,
    ) => void;
    onUiResponse?: (
        threadId: string | undefined,
        requestId: string,
        value: unknown,
    ) => void;
    onThinkingVisibility?: (hidden: boolean, threadId?: string) => void;
    onThinkingLevel?: (
        op: "cycle" | "set",
        level: string | undefined,
        threadId?: string,
    ) => void;
    onConnect?: (
        send: (msg: Frame) => void,
        ctx: { threadId?: string },
    ) => (string | undefined) | Promise<string | undefined>;
    listFiles?: (threadId?: string) => string[] | Promise<string[]>;
    listDirs?: (
        q: string,
        threadId?: string,
    ) =>
        | Array<{ value: string; label: string; description: string }>
        | Promise<Array<{ value: string; label: string; description: string }>>;
    threads?: {
        list: () => Promise<any[]>;
        create?: (dir?: string) => Promise<any>;
        switch?: (id: string) => Promise<void>;
        clone?: (threadId?: string) => Promise<any>;
        fork?: (threadId: string | undefined, entryId: string) => Promise<any>;
        importJsonl?: (path: string, threadId?: string) => Promise<any>;
        delete?: (threadId: string) => Promise<{
            ok: boolean;
            method?: "trash" | "unlink";
            error?: string;
        }>;
        rename?: (threadId: string, name: string) => Promise<any>;
    };
    sessionApi?: Record<string, (...args: any[]) => any>;
    modelApi?: {
        list: (threadId?: string) => any;
        set: (provider: string, id: string, threadId?: string) => any;
    };
    commandsApi?: {
        list: (
            threadId?: string,
        ) => { items: any[] } | Promise<{ items: any[] }>;
    };
    autocomplete?: (
        threadId: string | undefined,
        ctx: { text: string; caret?: number },
    ) => any | Promise<any>;
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
 * @param {(text:string, threadId?:string, images?:{data:string,mimeType:string}[])=>void} [o.onPrompt]
 * @param {(threadId?:string)=>Promise<void>} [o.onReload]
 * @param {(threadId?:string)=>Promise<void>} [o.onInterrupt]
 * @param {(command:string, exclude:boolean, threadId?:string)=>void} [o.onBash]
 * @param {(threadId?:string)=>void|Promise<void>} [o.onAbortBash]  cancel the thread's running shell command
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
    indexHtmlPath,
    theme,
    bus,
    piweb,
    onPrompt,
    onDequeue,
    onReload,
    threads,
    sessionApi,
    modelApi,
    commandsApi,
    autocomplete,
    onBash,
    onAbortBash,
    onConnect,
    onInterrupt,
    onSurface,
    onUiResponse,
    onThinkingVisibility,
    onThinkingLevel,
    listFiles,
    listDirs,
    bundleWeb,
}: AppOptions): Server {
    // `/app.js` is produced by the TS bundler (see build-web.ts); the rest are
    // served verbatim from src/web.
    const STATIC = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/index.html": ["index.html", "text/html; charset=utf-8"],
    };

    const router = createRouter({ readBody });

    // ---- GET routes ---------------------------------------------------------

    // liveness: up regardless of model/auth
    router.get("/health", ({ res }) => {
        const snap = piweb.snapshot?.() ?? {};
        const d = snap.docks ?? { left: [], right: [], bottom: [] };
        const surfaces =
            (d.left?.length ?? 0) +
            (d.right?.length ?? 0) +
            (d.bottom?.length ?? 0) +
            (d.footer?.length ?? 0) +
            (snap.overlays?.length ?? 0);
        sendJson(res, 200, { ok: true, surfaces });
    });

    // SSE event stream
    router.get("/events", async ({ req, res, url }) => {
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
        // browser refresh restores the conversation (and an unknown id falls
        // back to the default thread). Tag the connection with the resolved id
        // so per-thread broadcasts reach it.
        if (onConnect) {
            try {
                const resolved = await onConnect(send, { threadId: wanted });
                if (resolved) res.__threadId = resolved;
            } catch {
                /* replay is best-effort on connect */
            }
        }
        bus.clients.add(res);
        req.on("close", () => bus.clients.delete(res));
    });

    // list threads
    router.get("/threads", async ({ res }) => {
        const items = threads ? await threads.list() : [];
        sendJson(res, 200, { items });
    });

    // session info / changelog (read-only)
    router.get("/session", async ({ res, url }) => {
        const threadId = url.searchParams.get("thread") || undefined;
        sendJson(res, 200, (await sessionApi?.info?.(threadId)) ?? {});
    });
    // session-tree jump points for the /tree selector (read-only)
    router.get("/tree", async ({ res, url }) => {
        const threadId = url.searchParams.get("thread") || undefined;
        sendJson(
            res,
            200,
            (await sessionApi?.tree?.(threadId)) ?? { entries: [] },
        );
    });
    // user messages that can serve as /fork points (read-only)
    router.get("/fork-messages", async ({ res, url }) => {
        const threadId = url.searchParams.get("thread") || undefined;
        sendJson(
            res,
            200,
            (await sessionApi?.forkMessages?.(threadId)) ?? { items: [] },
        );
    });
    router.get("/changelog", async ({ res }) => {
        sendJson(res, 200, (await sessionApi?.changelog?.()) ?? { text: "" });
    });

    // selectable models for the /model picker (read-only)
    router.get("/models", async ({ res, url }) => {
        const threadId = url.searchParams.get("thread") || undefined;
        sendJson(res, 200, (await modelApi?.list?.(threadId)) ?? { items: [] });
    });

    // extension/prompt/skill slash commands for the `/` typeahead (read-only)
    router.get("/commands", async ({ res, url }) => {
        const threadId = url.searchParams.get("thread") || undefined;
        sendJson(
            res,
            200,
            (await commandsApi?.list?.(threadId)) ?? { items: [] },
        );
    });

    // project file list for the `@` mention typeahead (read-only). The client
    // caches this and fuzzy-filters locally as the user types.
    router.get("/files", async ({ res, url }) => {
        const threadId = url.searchParams.get("thread") || undefined;
        const items = listFiles ? await listFiles(threadId) : [];
        sendJson(res, 200, { items });
    });

    // directory suggestions for the `/new <dir>` typeahead (read-only)
    router.get("/dirs", async ({ res, url }) => {
        const q = url.searchParams.get("q") || "";
        const threadId = url.searchParams.get("thread") || undefined;
        const items = listDirs ? await listDirs(q, threadId) : [];
        sendJson(res, 200, { items });
    });

    // extension-supplied composer completions (piweb.addAutocompleteProvider).
    // The client posts the composer `{ text, caret }`; the host runs the
    // thread's providers and returns a `{ start, end, items }` splice span.
    router.post("/autocomplete", async ({ res, body }) => {
        const result = autocomplete
            ? await autocomplete(body.threadId || undefined, {
                  text: String(body.text ?? ""),
                  caret: Number.isInteger(body.caret) ? body.caret : undefined,
              })
            : null;
        sendJson(res, 200, result ?? { items: [] });
    });

    // bundled front-end entrypoint (built by build-web.ts)
    router.get("/app.js", async ({ res }) => {
        if (!bundleWeb) {
            res.writeHead(404).end("not found");
            return;
        }
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
    });

    // ---- POST routes (thread-scoped: threadId travels in the body) ----------

    router.post("/prompt", ({ res, body }) => {
        const text = (body.text ?? "").trim();
        const images = Array.isArray(body.images) ? body.images : undefined;
        if (text || images?.length)
            onPrompt?.(text, body.threadId || undefined, images);
        res.writeHead(202).end();
    });
    // Restore the thread's queued (steering/follow-up) messages back to the
    // composer; with `abort`, also interrupt the in-flight turn (Esc parity).
    router.post("/dequeue", async ({ res, body }) => {
        const result = (await onDequeue?.(
            body.threadId || undefined,
            !!body.abort,
        )) ?? { items: [] };
        sendJson(res, 200, result);
    });
    router.post("/action", async ({ res, body }) => {
        await piweb.dispatch(
            body.surfaceId,
            body.action,
            body.payload,
            body.threadId || undefined,
        );
        res.writeHead(202).end();
    });
    router.post("/surface", ({ res, body }) => {
        onSurface?.(body.threadId || undefined, body.op, body.id);
        res.writeHead(202).end();
    });
    // answer to a blocking dialog (select/confirm/input/editor)
    router.post("/ui-response", ({ res, body }) => {
        onUiResponse?.(body.threadId || undefined, body.requestId, body.value);
        res.writeHead(202).end();
    });
    router.post("/session/name", async ({ res, body }) => {
        await sessionApi?.setName?.(body.name, body.threadId || undefined);
        res.writeHead(202).end();
    });
    router.post("/model", async ({ res, body }) => {
        const result =
            (await modelApi?.set?.(
                body.provider,
                body.id,
                body.threadId || undefined,
            )) ?? {};
        sendJson(res, 200, result);
    });
    router.post("/session/compact", ({ res, body }) => {
        sessionApi?.compact?.(body.threadId || undefined); // streamed over SSE
        res.writeHead(202).end();
    });
    // jump to a point in the session tree (re-broadcasts the transcript)
    router.post("/tree/navigate", async ({ res, body }) => {
        const result =
            (await sessionApi?.navigateTree?.(
                body.entryId,
                body.threadId || undefined,
            )) ?? {};
        sendJson(res, 200, result);
    });
    // share the session as a private gist, returning a shareable viewer URL
    router.post("/session/share", async ({ res, body }) => {
        const result =
            (await sessionApi?.share?.(body.threadId || undefined)) ?? {};
        sendJson(res, 200, result);
    });
    router.post("/session/export", async ({ res, body }) => {
        const result =
            (await sessionApi?.export?.(
                body.format,
                body.threadId || undefined,
            )) ?? {};
        sendJson(res, 200, result);
    });
    router.post("/bash", ({ res, body }) => {
        onBash?.(
            body.command,
            body.excludeFromContext,
            body.threadId || undefined,
        );
        res.writeHead(202).end();
    });
    // Cancel a running user-run shell command (Esc in the web UI).
    router.post("/bash/abort", ({ res, body }) => {
        onAbortBash?.(body.threadId || undefined);
        res.writeHead(202).end();
    });
    router.post("/threads", async ({ res, body }) => {
        try {
            const result = (await threads?.create?.(body.cwd)) ?? {};
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, 400, { error: String(err?.message ?? err) });
        }
    });
    router.post("/threads/switch", async ({ res, body }) => {
        try {
            await threads?.switch?.(body.id);
            res.writeHead(202).end();
        } catch (err) {
            sendJson(res, 409, { error: String(err?.message ?? err) });
        }
    });
    // /clone, /fork, /import all mint a new thread and return its id so the
    // client can navigate to it (like /new, but seeded from existing history).
    router.post("/threads/clone", async ({ res, body }) => {
        try {
            const result =
                (await threads?.clone?.(body.threadId || undefined)) ?? {};
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, 400, { error: String(err?.message ?? err) });
        }
    });
    router.post("/threads/fork", async ({ res, body }) => {
        try {
            const result =
                (await threads?.fork?.(
                    body.threadId || undefined,
                    body.entryId,
                )) ?? {};
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, 400, { error: String(err?.message ?? err) });
        }
    });
    router.post("/threads/import", async ({ res, body }) => {
        try {
            const result =
                (await threads?.importJsonl?.(
                    body.path,
                    body.threadId || undefined,
                )) ?? {};
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, 400, { error: String(err?.message ?? err) });
        }
    });
    // Delete a thread's session (Ctrl+D in the resume picker). Mirrors the pi
    // TUI: trash-then-unlink, blocking a running thread. Returns { ok, method }.
    router.post("/threads/delete", async ({ res, body }) => {
        try {
            const result = (await threads?.delete?.(body.threadId)) ?? {
                ok: false,
                error: "delete not supported",
            };
            sendJson(res, result.ok ? 200 : 400, result);
        } catch (err) {
            sendJson(res, 400, {
                ok: false,
                error: String(err?.message ?? err),
            });
        }
    });
    // Rename a thread's session (Ctrl+R in the resume picker).
    router.post("/threads/rename", async ({ res, body }) => {
        try {
            const result =
                (await threads?.rename?.(body.threadId, body.name)) ?? {};
            sendJson(res, 200, result);
        } catch (err) {
            sendJson(res, 400, { error: String(err?.message ?? err) });
        }
    });
    router.post("/reload", async ({ res, body }) => {
        await onReload?.(body.threadId || undefined);
        res.writeHead(202).end();
    });
    router.post("/interrupt", ({ res, body }) => {
        onInterrupt?.(body.threadId || undefined); // streamed over SSE
        res.writeHead(202).end();
    });
    router.post("/thinking", ({ res, body }) => {
        // toggle the global "hide thinking blocks" pi setting; broadcast on SSE
        onThinkingVisibility?.(!!body.hidden, body.threadId || undefined);
        res.writeHead(202).end();
    });
    router.post("/thinking-level", ({ res, body }) => {
        // cycle/set the per-session reasoning level; broadcast to the thread
        onThinkingLevel?.(
            body.op === "set" ? "set" : "cycle",
            body.level,
            body.threadId || undefined,
        );
        res.writeHead(202).end();
    });

    // ---- static files (GET) + 404 fallback ----------------------------------
    router.fallback(async ({ req, res, url }) => {
        const entry =
            req.method === "GET" || req.method === "HEAD"
                ? STATIC[url.pathname]
                : undefined;
        if (entry) {
            try {
                // Serve via Bun.file so the embedded (compiled-binary) path
                // resolves; falls back to the on-disk web dir under `bun run`.
                const p = indexHtmlPath ?? join(web, entry[0]);
                const buf = Buffer.from(await Bun.file(p).arrayBuffer());
                res.writeHead(200, { "Content-Type": entry[1] }).end(buf);
            } catch {
                res.writeHead(404).end("not found");
            }
            return;
        }
        res.writeHead(404).end("not found");
    });

    return http.createServer((req: IncomingMessage, res: SSEClient) =>
        router.handle(req, res),
    );
}
