/**
 * MVP-0 smoke test: the model-independent core.
 *
 * Boots the real transport (app.mjs) + real registry (piweb-host.mjs) on an
 * ephemeral port — no agent, no model, no auth — and asserts the end-to-end
 * loop: /health, the initial SSE panel snapshot, and a panel action round-trip
 * (dock -> snapshot -> dispatch -> setState -> broadcast).
 */
import { test, expect } from "bun:test";
import { createBus, createApp } from "../src/host/app.ts";
import { createPiWebHost } from "../src/host/piweb-host.ts";

function startServer() {
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: (frame) => bus.broadcast(frame),
        getPi: () => ({ sendUserMessage() {} }), // stub; not exercised here
    });
    // a counter panel mirroring hello-panel's state semantics
    piweb.dock("hello", {
        side: "right",
        title: "Hello",
        initialState: { count: 0, name: "world" },
        render: (s) => ({ type: "Text", text: `count=${s.count}` }),
        actions: {
            inc: (ctx) => ctx.setState((s) => ({ count: s.count + 1 })),
            setName: (ctx) => ctx.setState({ name: ctx.payload?.value }),
        },
    });

    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        onPrompt() {},
        onReload() {},
    });

    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({ server, base: `http://127.0.0.1:${port}` });
        });
    });
}

/** Incremental reader of SSE `data:` frames from a fetch Response. */
function frameReader(res) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const queue = [];
    const waiters = [];
    (async () => {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                if (line.startsWith("data: ")) {
                    const frame = JSON.parse(line.slice(6));
                    if (waiters.length) waiters.shift()(frame);
                    else queue.push(frame);
                }
            }
        }
    })();
    return {
        next: () =>
            queue.length
                ? Promise.resolve(queue.shift())
                : new Promise((r) => waiters.push(r)),
        close: () => reader.cancel().catch(() => {}),
    };
}

test("MVP-0: health + SSE snapshot + action round-trip (no model)", async () => {
    const { server, base } = await startServer();
    try {
        // /health is up without any agent/model
        const health = await (await fetch(`${base}/health`)).json();
        expect(health.ok).toBe(true);
        expect(health.surfaces).toBe(1);

        // SSE delivers the initial panel snapshot
        const events = frameReader(await fetch(`${base}/events`));
        const first = await events.next();
        expect(first.kind).toBe("surfaces");
        expect(first.surfaces.docks.right[0].id).toBe("hello");
        expect(first.surfaces.docks.right[0].tree.text).toBe("count=0");

        // a panel action round-trips state back over SSE
        await fetch(`${base}/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ surfaceId: "hello", action: "inc" }),
        });
        const second = await events.next();
        expect(second.kind).toBe("surfaces");
        expect(second.surfaces.docks.right[0].tree.text).toBe("count=1");

        events.close();
    } finally {
        server.close();
    }
});

test("thread routes delegate to injected callbacks", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        threads: {
            list: async () => [
                { id: "a", name: "A", active: true },
                { id: "b", name: "B", active: false },
            ],
            create: async () => {
                calls.push("create");
                return { id: "new" };
            },
            switch: async (id) => {
                calls.push(`switch:${id}`);
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const list = await (await fetch(`${base}/threads`)).json();
        expect(list.items.length).toBe(2);
        expect(list.items[0].id).toBe("a");

        const created = await (
            await fetch(`${base}/threads`, { method: "POST" })
        ).json();
        expect(created.id).toBe("new");

        await fetch(`${base}/threads/switch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "b" }),
        });

        expect(calls).toContain("create");
        expect(calls).toContain("switch:b");
    } finally {
        server.close();
    }
});

test("/files returns the project file list for the @ mention typeahead", async () => {
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    let called = 0;
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        listFiles: async () => {
            called++;
            return ["src/web/app.ts", "README.md"];
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const res = await fetch(`${base}/files`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.items).toEqual(["src/web/app.ts", "README.md"]);
        expect(called).toBe(1);
    } finally {
        server.close();
    }
});

test("session command routes delegate to sessionApi", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        sessionApi: {
            info: async () => ({ id: "s1", name: "demo" }),
            setName: async (n) => calls.push(`name:${n}`),
            compact: async () => calls.push("compact"),
            export: async (fmt) => ({ path: `/tmp/x.${fmt}`, format: fmt }),
            changelog: async () => ({ text: "# changelog" }),
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        expect((await (await fetch(`${base}/session`)).json()).id).toBe("s1");
        expect(
            (await (await fetch(`${base}/changelog`)).json()).text,
        ).toContain("changelog");

        await fetch(`${base}/session/name`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "renamed" }),
        });
        await fetch(`${base}/session/compact`, { method: "POST" });
        const exp = await (
            await fetch(`${base}/session/export`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ format: "jsonl" }),
            })
        ).json();
        expect(exp.path).toBe("/tmp/x.jsonl");

        expect(calls).toContain("name:renamed");
        expect(calls).toContain("compact");
    } finally {
        server.close();
    }
});

test("/bash delegates to onBash with the exclude flag", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        onBash: (command, exclude) =>
            calls.push(`${exclude ? "!!" : "!"}${command}`),
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        await fetch(`${base}/bash`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: "ls", excludeFromContext: false }),
        });
        await fetch(`${base}/bash`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: "pwd", excludeFromContext: true }),
        });
        expect(calls).toContain("!ls");
        expect(calls).toContain("!!pwd");
    } finally {
        server.close();
    }
});

test("thread routes: list / create / switch are wired to callbacks", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        threads: {
            list: async () => [
                { id: "a", name: "A", active: true },
                { id: "b", name: "B", active: false },
            ],
            create: async () => {
                calls.push("create");
                return { id: "new" };
            },
            switch: async (id) => {
                calls.push(`switch:${id}`);
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const list = await (await fetch(`${base}/threads`)).json();
        expect(list.items.length).toBe(2);
        expect(list.items[0].id).toBe("a");

        const created = await (
            await fetch(`${base}/threads`, { method: "POST" })
        ).json();
        expect(created.id).toBe("new");

        await fetch(`${base}/threads/switch`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: "b" }),
        });

        expect(calls).toContain("create");
        expect(calls).toContain("switch:b");
    } finally {
        server.close();
    }
});

test("bus.broadcastToThread fans out only to the matching clients", () => {
    const bus = createBus();
    const sink = { a: [], b: [], none: [] };
    const mk = (tid, out) => ({ __threadId: tid, write: (l) => out.push(l) });
    const ca = mk("a", sink.a);
    const cb = mk("b", sink.b);
    const cn = mk(undefined, sink.none);
    bus.clients.add(ca);
    bus.clients.add(cb);
    bus.clients.add(cn);

    // thread-scoped: only the client viewing "a" gets it
    bus.broadcastToThread("a", { kind: "delta", text: "x" });
    expect(sink.a.length).toBe(1);
    expect(sink.b.length).toBe(0);
    expect(sink.none.length).toBe(0);

    // a missing/undefined threadId routes to nobody (never the untagged client)
    bus.broadcastToThread(undefined, { kind: "delta", text: "y" });
    expect(sink.none.length).toBe(0);

    // global broadcast still reaches everyone
    bus.broadcast({ kind: "threads", items: [] });
    expect(sink.a.length).toBe(2);
    expect(sink.b.length).toBe(1);
    expect(sink.none.length).toBe(1);
});

test("thread-scoped POST routes forward the body threadId", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        onPrompt: (text, threadId) => calls.push(`prompt:${text}@${threadId}`),
        onBash: (cmd, exclude, threadId) =>
            calls.push(`bash:${cmd}@${threadId}`),
        onReload: async (threadId) => calls.push(`reload:@${threadId}`),
        onInterrupt: async (threadId) => calls.push(`interrupt:@${threadId}`),
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    const send = (path, body) =>
        fetch(`${base}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    try {
        await send("/prompt", { text: "hi", threadId: "t1" });
        await send("/bash", { command: "ls", threadId: "t2" });
        await send("/reload", { threadId: "t3" });
        await send("/interrupt", { threadId: "t4" });
        expect(calls).toContain("prompt:hi@t1");
        expect(calls).toContain("bash:ls@t2");
        expect(calls).toContain("reload:@t3");
        expect(calls).toContain("interrupt:@t4");
    } finally {
        server.close();
    }
});

test("/events?thread passes the id to onConnect and tags the connection", async () => {
    let seen;
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        onConnect: (_send, ctx) => {
            seen = ctx.threadId;
            return ctx.threadId; // resolved id tags the connection
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const reader = frameReader(await fetch(`${base}/events?thread=t-42`));
        await reader.next(); // initial panels frame
        // give the handler a tick to run onConnect + register the client
        await new Promise((r) => setTimeout(r, 40));
        expect(seen).toBe("t-42");
        // the now-registered, tagged client receives its thread's frames
        bus.broadcastToThread("t-42", { kind: "system", text: "hi" });
        expect((await reader.next()).text).toBe("hi");
        reader.close();
    } finally {
        server.close();
    }
});

test("piweb host: docks group by side, overlays toggle, notify broadcasts", async () => {
    const frames = [];
    const host = createPiWebHost({
        broadcast: (f) => frames.push(f),
        getPi: () => ({}),
    });
    host.dock("a", {
        side: "left",
        title: "A",
        render: () => ({ type: "Text", text: "x" }),
    });
    host.overlay("m", {
        title: "M",
        render: () => ({ type: "Text", text: "y" }),
        actions: { close: (ctx) => ctx.closeOverlay("m") },
    });

    const snap = host.snapshot();
    expect(snap.docks.left[0].id).toBe("a");
    expect(snap.overlays.length).toBe(0); // overlays start closed

    host.openOverlay("m");
    expect(host.snapshot().overlays[0].id).toBe("m");

    await host.dispatch("m", "close"); // action closes itself
    expect(host.snapshot().overlays.length).toBe(0);

    host.notify("heads up", "warning");
    expect(
        frames.some((f) => f.kind === "notify" && f.level === "warning"),
    ).toBe(true);
});

test("/surface forwards overlay open/close to onSurface", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({ broadcast: () => {}, getPi: () => ({}) });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        onSurface: (threadId, op, id) => calls.push(`${op}:${id}@${threadId}`),
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        await fetch(`${base}/surface`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId: "t1", op: "close", id: "m" }),
        });
        expect(calls).toContain("close:m@t1");
    } finally {
        server.close();
    }
});

test("/app.js serves the bundled TS front-end (build-web)", async () => {
    const { makeWebBundler } = await import("../src/host/build-web.ts");
    const bus = createBus();
    const piweb = createPiWebHost({ broadcast: () => {}, getPi: () => ({}) });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        bundleWeb: makeWebBundler("src/web"),
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const res = await fetch(`${base}/app.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("javascript");
        const code = await res.text();
        // fuzzy.ts + markdown.ts are bundled into the single entrypoint
        expect(code).toContain("fuzzyMatch");
        expect(code).toContain("renderMarkdown");
    } finally {
        server.close();
    }
});
