/**
 * pi-web HTTP app: the browser bus (SSE + POST), static serving, /health, and
 * thread (session) routes.
 *
 * This layer is intentionally **agent-independent** — it knows nothing about
 * createAgentSession/models/auth. Agent-coupled behavior is injected via
 * callbacks (onPrompt/onReload/threads), which keeps the core cockpit plumbing
 * (registerPanel -> snapshot -> dispatch -> setState -> broadcast, plus thread
 * listing/switching) testable with zero credentials.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** SSE fan-out bus: a set of response streams + a JSON broadcaster. */
export function createBus() {
    const clients = new Set();
    const broadcast = (msg) => {
        const line = `data: ${JSON.stringify(msg)}\n\n`;
        for (const res of clients) res.write(line);
    };
    return { clients, broadcast };
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
 * @param {(text:string)=>void} [o.onPrompt]   user prompt handler
 * @param {()=>Promise<void>}   [o.onReload]   reload handler
 * @param {{ list:()=>Promise<any[]>, create:()=>Promise<any>, switch:(id:string)=>Promise<void> }} [o.threads]
 * @returns {import("node:http").Server}
 */
export function createApp({
    web,
    bus,
    piweb,
    onPrompt,
    onReload,
    threads,
    sessionApi,
    onBash,
}) {
    const STATIC = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/index.html": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/fuzzy.mjs": ["fuzzy.mjs", "text/javascript; charset=utf-8"],
    };

    return http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const path = url.pathname;

        // liveness: up regardless of model/auth
        if (path === "/health") {
            sendJson(res, 200, { ok: true, panels: piweb.snapshot().length });
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
            res.write(
                `data: ${JSON.stringify({ kind: "panels", panels: piweb.snapshot() })}\n\n`,
            );
            if (threads) {
                try {
                    const items = await threads.list();
                    res.write(
                        `data: ${JSON.stringify({ kind: "threads", items })}\n\n`,
                    );
                } catch {
                    /* listing is best-effort on connect */
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
            sendJson(res, 200, (await sessionApi?.info?.()) ?? {});
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

        if (req.method === "POST") {
            const body = await readBody(req);
            if (path === "/prompt") {
                const text = (body.text ?? "").trim();
                if (text) onPrompt?.(text);
                res.writeHead(202).end();
                return;
            }
            if (path === "/action") {
                await piweb.dispatch(body.panelId, body.action, body.payload);
                res.writeHead(202).end();
                return;
            }
            if (path === "/session/name") {
                await sessionApi?.setName?.(body.name);
                res.writeHead(202).end();
                return;
            }
            if (path === "/session/compact") {
                sessionApi?.compact?.(); // async; progress streamed over SSE
                res.writeHead(202).end();
                return;
            }
            if (path === "/session/export") {
                const result = (await sessionApi?.export?.(body.format)) ?? {};
                sendJson(res, 200, result);
                return;
            }
            if (path === "/bash") {
                onBash?.(body.command, body.excludeFromContext);
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
                await onReload?.();
                res.writeHead(202).end();
                return;
            }
            res.writeHead(404).end();
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
