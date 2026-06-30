/**
 * Unit tests for the tiny node:http router (src/host/router.ts): method+path
 * dispatch, JSON body parsing for body-bearing methods, the fallback, and the
 * inspectable route table.
 */
import { test, expect } from "bun:test";
import { createRouter } from "../src/host/router.ts";

/** Minimal fake (req, res) pair capturing what handlers write. */
function fakeReqRes(method, path, bodyObj) {
    const bodyStr = bodyObj == null ? "" : JSON.stringify(bodyObj);
    // an async-iterable request yielding the body once
    const req = {
        method,
        url: path,
        async *[Symbol.asyncIterator]() {
            if (bodyStr) yield Buffer.from(bodyStr);
        },
    };
    const res = {
        statusCode: 0,
        headers: null,
        body: "",
        writeHead(code, headers) {
            this.statusCode = code;
            this.headers = headers ?? null;
            return this;
        },
        end(chunk) {
            if (chunk != null) this.body += chunk;
            return this;
        },
    };
    return { req, res };
}

test("dispatches by method + exact path", async () => {
    const router = createRouter();
    const hits = [];
    router.get("/health", ({ res }) => {
        hits.push("get-health");
        res.writeHead(200).end("ok");
    });
    router.post("/health", ({ res }) => {
        hits.push("post-health");
        res.writeHead(202).end();
    });

    const a = fakeReqRes("GET", "/health");
    await router.handle(a.req, a.res);
    const b = fakeReqRes("POST", "/health");
    await router.handle(b.req, b.res);

    expect(hits).toEqual(["get-health", "post-health"]);
    expect(a.res.statusCode).toBe(200);
    expect(a.res.body).toBe("ok");
    expect(b.res.statusCode).toBe(202);
});

test("parses JSON body for POST, not for GET", async () => {
    const router = createRouter();
    let seen;
    router.post("/echo", ({ res, body }) => {
        seen = body;
        res.writeHead(200).end();
    });
    let getBody;
    router.get("/echo", ({ res, body }) => {
        getBody = body;
        res.writeHead(200).end();
    });

    const p = fakeReqRes("POST", "/echo", { a: 1, threadId: "t1" });
    await router.handle(p.req, p.res);
    expect(seen).toEqual({ a: 1, threadId: "t1" });

    const g = fakeReqRes("GET", "/echo", { ignored: true });
    await router.handle(g.req, g.res);
    expect(getBody).toEqual({}); // GET body is never read
});

test("exposes query params via ctx.url", async () => {
    const router = createRouter();
    let thread;
    router.get("/session", ({ res, url }) => {
        thread = url.searchParams.get("thread");
        res.writeHead(200).end();
    });
    const { req, res } = fakeReqRes("GET", "/session?thread=abc");
    await router.handle(req, res);
    expect(thread).toBe("abc");
});

test("fallback handles unmatched routes", async () => {
    const router = createRouter();
    const calls = [];
    router.get("/known", ({ res }) => res.writeHead(200).end());
    router.fallback(({ res, url }) => {
        calls.push(url.pathname);
        res.writeHead(418).end("teapot");
    });
    const { req, res } = fakeReqRes("GET", "/nope");
    await router.handle(req, res);
    expect(calls).toEqual(["/nope"]);
    expect(res.statusCode).toBe(418);
});

test("HEAD falls back to the GET handler", async () => {
    const router = createRouter();
    let hits = 0;
    router.get("/page", ({ res }) => {
        hits++;
        res.writeHead(200).end("body");
    });
    const { req, res } = fakeReqRes("HEAD", "/page");
    await router.handle(req, res);
    expect(hits).toBe(1);
    expect(res.statusCode).toBe(200);
});

test("default 404 when no route and no fallback", async () => {
    const router = createRouter();
    const { req, res } = fakeReqRes("GET", "/missing");
    await router.handle(req, res);
    expect(res.statusCode).toBe(404);
});

test("routes() reports the registered method+path table", () => {
    const router = createRouter();
    router.get("/a", () => {}).post("/b/c", () => {});
    expect(router.routes()).toEqual([
        { method: "GET", path: "/a" },
        { method: "POST", path: "/b/c" },
    ]);
});
