/**
 * Tiny `node:http` router.
 *
 * The cockpit's routes are flat (no path params — ids travel in the body or
 * `?thread=`), so this is a deliberate, dependency-free `method + exact-path`
 * table rather than a full framework. It keeps the `(req, res)` signature that
 * `createApp` and every test harness rely on, and makes the route set
 * registerable + inspectable (`routes()`), replacing the old 199-line
 * `if (path === …)` chain.
 *
 * Matched POST/PUT/PATCH/DELETE handlers receive the parsed JSON `body`; GET
 * handlers and the fallback do not read the request stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export type Res = ServerResponse & { __threadId?: string };

export interface RouteCtx {
    req: IncomingMessage;
    res: Res;
    url: URL;
    query: URLSearchParams;
    /** Parsed JSON body for body-bearing methods on a matched route; else `{}`. */
    body: any;
}

export type RouteHandler = (ctx: RouteCtx) => void | Promise<void>;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function defaultReadBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return {};
    }
}

export interface Router {
    add(method: string, path: string, handler: RouteHandler): Router;
    get(path: string, handler: RouteHandler): Router;
    post(path: string, handler: RouteHandler): Router;
    /** Handler for requests that match no route (e.g. static files / 404). */
    fallback(handler: RouteHandler): Router;
    /** The registered routes, for inspection/debugging. */
    routes(): Array<{ method: string; path: string }>;
    handle(req: IncomingMessage, res: Res): Promise<void>;
}

export function createRouter(opts?: {
    readBody?: (req: IncomingMessage) => Promise<any>;
}): Router {
    const table = new Map<string, RouteHandler>();
    const readBody = opts?.readBody ?? defaultReadBody;
    let fb: RouteHandler | null = null;
    const key = (method: string, path: string) => `${method} ${path}`;

    const router: Router = {
        add(method, path, handler) {
            table.set(key(method.toUpperCase(), path), handler);
            return router;
        },
        get(path, handler) {
            return router.add("GET", path, handler);
        },
        post(path, handler) {
            return router.add("POST", path, handler);
        },
        fallback(handler) {
            fb = handler;
            return router;
        },
        routes() {
            return [...table.keys()].map((k) => {
                const sp = k.indexOf(" ");
                return { method: k.slice(0, sp), path: k.slice(sp + 1) };
            });
        },
        async handle(req, res) {
            const url = new URL(req.url ?? "/", "http://localhost");
            const method = (req.method ?? "GET").toUpperCase();
            // HEAD falls back to the GET handler (node suppresses the body).
            const handler =
                table.get(key(method, url.pathname)) ??
                (method === "HEAD"
                    ? table.get(key("GET", url.pathname))
                    : undefined);
            const ctx: RouteCtx = {
                req,
                res,
                url,
                query: url.searchParams,
                body:
                    handler && BODY_METHODS.has(method)
                        ? await readBody(req)
                        : {},
            };
            if (handler) return handler(ctx);
            if (fb) return fb(ctx);
            res.writeHead(404).end("not found");
        },
    };
    return router;
}
