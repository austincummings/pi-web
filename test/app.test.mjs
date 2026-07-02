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
        side: "aboveEditor",
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
        expect(first.surfaces.docks.aboveEditor[0].id).toBe("hello");
        expect(first.surfaces.docks.aboveEditor[0].tree.text).toBe("count=0");

        // a panel action round-trips state back over SSE
        await fetch(`${base}/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ surfaceId: "hello", action: "inc" }),
        });
        const second = await events.next();
        expect(second.kind).toBe("surfaces");
        expect(second.surfaces.docks.aboveEditor[0].tree.text).toBe("count=1");

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

test("/threads/delete + /threads/rename delegate to callbacks", async () => {
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
            list: async () => [],
            delete: async (threadId) => {
                calls.push(`delete:${threadId}`);
                if (threadId === "running")
                    return {
                        ok: false,
                        error: "Cannot delete a running thread",
                    };
                return { ok: true, method: "trash" };
            },
            rename: async (threadId, name) => {
                calls.push(`rename:${threadId}:${name}`);
                return { ok: true };
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    const postJson = (path, body) =>
        fetch(`${base}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    try {
        // Successful delete → 200 { ok, method }.
        const ok = await postJson("/threads/delete", { threadId: "a" });
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual({ ok: true, method: "trash" });

        // Refused delete (running) → 400 with the message and ok:false.
        const bad = await postJson("/threads/delete", { threadId: "running" });
        expect(bad.status).toBe(400);
        const badBody = await bad.json();
        expect(badBody.ok).toBe(false);
        expect(badBody.error).toContain("running");

        // Rename delegates with threadId + name.
        const rn = await postJson("/threads/rename", {
            threadId: "a",
            name: "My Thread",
        });
        expect(rn.status).toBe(200);
        expect(await rn.json()).toEqual({ ok: true });

        expect(calls).toEqual([
            "delete:a",
            "delete:running",
            "rename:a:My Thread",
        ]);
    } finally {
        server.close();
    }
});

test("/threads/delete surfaces a thrown callback error as 400", async () => {
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
            list: async () => [],
            delete: async () => {
                throw new Error("boom");
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const res = await fetch(`${base}/threads/delete`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId: "a" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toContain("boom");
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

test("/dirs returns directory suggestions for the /new typeahead", async () => {
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcast: () => {},
        getPi: () => ({}),
    });
    const calls = [];
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        listDirs: async (q, threadId) => {
            calls.push({ q, threadId });
            return [
                { value: "/tmp/foo", label: "foo", description: "/tmp/foo" },
            ];
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const res = await fetch(`${base}/dirs?q=fo&thread=t1`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.items).toEqual([
            { value: "/tmp/foo", label: "foo", description: "/tmp/foo" },
        ]);
        expect(calls).toEqual([{ q: "fo", threadId: "t1" }]);
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

test("model routes delegate to modelApi (list / set)", async () => {
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
        modelApi: {
            list: (threadId) => {
                calls.push(`list:${threadId}`);
                return {
                    current: { provider: "meridian", id: "claude-opus-4-8" },
                    items: [
                        {
                            provider: "meridian",
                            id: "claude-opus-4-8",
                            name: "Opus",
                            reasoning: true,
                            contextWindow: 200000,
                            sub: true,
                            current: true,
                        },
                    ],
                };
            },
            set: (provider, id, threadId) => {
                calls.push(`set:${provider}/${id}:${threadId}`);
                return { ok: true, provider, id };
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const listed = await (await fetch(`${base}/models?thread=t1`)).json();
        expect(listed.current.id).toBe("claude-opus-4-8");
        expect(listed.items[0].sub).toBe(true);
        expect(calls).toContain("list:t1");

        const set = await (
            await fetch(`${base}/model`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    provider: "openai",
                    id: "gpt-5",
                    threadId: "t1",
                }),
            })
        ).json();
        expect(set.ok).toBe(true);
        expect(calls).toContain("set:openai/gpt-5:t1");
    } finally {
        server.close();
    }
});

test("/commands delegates to commandsApi.list for the / typeahead", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({ broadcast: () => {}, getPi: () => ({}) });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        commandsApi: {
            list: (threadId) => {
                calls.push(`list:${threadId}`);
                return {
                    items: [
                        {
                            name: "ui-demo",
                            description: "run all four dialogs",
                            source: "extension",
                        },
                    ],
                };
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const listed = await (await fetch(`${base}/commands?thread=t1`)).json();
        expect(calls).toContain("list:t1");
        expect(listed.items[0].name).toBe("ui-demo");
        expect(listed.items[0].source).toBe("extension");
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

test("/prompt forwards text and pasted image attachments to onPrompt", async () => {
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
        onPrompt: (text, threadId, images) =>
            calls.push({ text, threadId, images }),
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const images = [{ data: "AAAA", mimeType: "image/png" }];
        // text + image
        await fetch(`${base}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "look", images, threadId: "t1" }),
        });
        // image-only (empty text) still sends
        await fetch(`${base}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "", images, threadId: "t1" }),
        });
        // no text and no images → ignored
        await fetch(`${base}/prompt`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "   ", threadId: "t1" }),
        });
        expect(calls.length).toBe(2);
        expect(calls[0]).toEqual({ text: "look", threadId: "t1", images });
        expect(calls[1].text).toBe("");
        expect(calls[1].images).toEqual(images);
    } finally {
        server.close();
    }
});

test("/dequeue delegates to onDequeue and returns the restored items", async () => {
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
        onDequeue: (threadId, abort) => {
            calls.push({ threadId, abort });
            return { items: ["first queued", "second queued"] };
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const res = await fetch(`${base}/dequeue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId: "t-1", abort: true }),
        });
        const body = await res.json();
        expect(calls).toEqual([{ threadId: "t-1", abort: true }]);
        expect(body.items).toEqual(["first queued", "second queued"]);
    } finally {
        server.close();
    }
});

test("/thinking-level delegates to onThinkingLevel (cycle / set)", async () => {
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
        onThinkingLevel: (op, level, threadId) =>
            calls.push({ op, level, threadId }),
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        await fetch(`${base}/thinking-level`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "cycle", threadId: "t1" }),
        });
        await fetch(`${base}/thinking-level`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ op: "set", level: "high", threadId: "t1" }),
        });
        expect(calls).toEqual([
            { op: "cycle", level: undefined, threadId: "t1" },
            { op: "set", level: "high", threadId: "t1" },
        ]);
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
        side: "aboveEditor",
        title: "A",
        render: () => ({ type: "Text", text: "x" }),
    });
    host.overlay("m", {
        title: "M",
        render: () => ({ type: "Text", text: "y" }),
        actions: { close: (ctx) => ctx.closeOverlay("m") },
    });

    const snap = host.snapshot();
    expect(snap.docks.aboveEditor[0].id).toBe("a");
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

test("piweb host: setTitle broadcasts a title frame; clearing restores default", () => {
    const frames = [];
    const host = createPiWebHost({
        broadcast: (f) => frames.push(f),
        getPi: () => ({}),
    });

    host.setTitle("My Project");
    expect(frames.at(-1)).toEqual({ kind: "title", text: "My Project" });

    // undefined / empty restores the default (client maps "" -> base title)
    host.setTitle();
    expect(frames.at(-1)).toEqual({ kind: "title", text: "" });
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

test("/ui-response forwards a blocking-dialog answer to onUiResponse", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({ broadcast: () => {}, getPi: () => ({}) });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        onUiResponse: (threadId, requestId, value) =>
            calls.push({ threadId, requestId, value }),
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        await fetch(`${base}/ui-response`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                threadId: "t1",
                requestId: "ui-1",
                value: "b",
            }),
        });
        expect(calls).toEqual([
            { threadId: "t1", requestId: "ui-1", value: "b" },
        ]);
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
        // Regression guard: the <pi-tool> / <pi-frame> custom elements are
        // registered via module side effects in pi-tool.ts / pi-frame.ts, but
        // app.ts only references their classes in type positions. Without an
        // explicit side-effect import the bundler elides the modules and drops
        // customElements.define(), leaving createElement("pi-tool") inert so
        // tool cards never render. Assert the registrations survive bundling.
        expect(code).toContain('customElements.define("pi-tool"');
        expect(code).toContain('customElements.define("pi-frame"');
    } finally {
        server.close();
    }
});

// #21 slash-command parity: the session-navigation cluster (/tree, /fork,
// /clone, /import, /share) is wired through sessionApi + threads callbacks the
// same way as the older thread routes. Assert each route reaches its callback
// with the forwarded threadId / args and returns the callback's result.
test("session-navigation routes (/tree, /fork, /clone, /import, /share) are wired", async () => {
    const calls = [];
    const bus = createBus();
    const piweb = createPiWebHost({ broadcast: () => {}, getPi: () => ({}) });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        sessionApi: {
            tree: (threadId) => {
                calls.push(`tree@${threadId}`);
                return {
                    entries: [{ id: "e1", role: "user", text: "hi" }],
                    leafId: "e1",
                };
            },
            navigateTree: (entryId, threadId) => {
                calls.push(`navigate:${entryId}@${threadId}`);
                return { ok: true, editorText: "draft" };
            },
            forkMessages: (threadId) => {
                calls.push(`forkMessages@${threadId}`);
                return { items: [{ id: "e1", text: "hi" }] };
            },
            share: (threadId) => {
                calls.push(`share@${threadId}`);
                return {
                    viewerUrl: "https://pi.dev/session/#gist1",
                    gistUrl: "u",
                };
            },
        },
        threads: {
            list: async () => [],
            clone: async (threadId) => {
                calls.push(`clone@${threadId}`);
                return { id: "cloned" };
            },
            fork: async (threadId, entryId) => {
                calls.push(`fork:${entryId}@${threadId}`);
                return { id: "forked" };
            },
            importJsonl: async (path, threadId) => {
                calls.push(`import:${path}@${threadId}`);
                return { id: "imported" };
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    const post = (path, body) =>
        fetch(`${base}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    try {
        const tree = await (await fetch(`${base}/tree?thread=t1`)).json();
        expect(tree.entries[0].id).toBe("e1");
        expect(calls).toContain("tree@t1");

        const fm = await (
            await fetch(`${base}/fork-messages?thread=t1`)
        ).json();
        expect(fm.items[0].id).toBe("e1");
        expect(calls).toContain("forkMessages@t1");

        const nav = await (
            await post("/tree/navigate", { entryId: "e1", threadId: "t1" })
        ).json();
        expect(nav.ok).toBe(true);
        expect(calls).toContain("navigate:e1@t1");

        const cloned = await (
            await post("/threads/clone", { threadId: "t1" })
        ).json();
        expect(cloned.id).toBe("cloned");
        expect(calls).toContain("clone@t1");

        const forked = await (
            await post("/threads/fork", { entryId: "e1", threadId: "t1" })
        ).json();
        expect(forked.id).toBe("forked");
        expect(calls).toContain("fork:e1@t1");

        const imported = await (
            await post("/threads/import", { path: "s.jsonl", threadId: "t1" })
        ).json();
        expect(imported.id).toBe("imported");
        expect(calls).toContain("import:s.jsonl@t1");

        const shared = await (
            await post("/session/share", { threadId: "t1" })
        ).json();
        expect(shared.viewerUrl).toContain("#gist1");
        expect(calls).toContain("share@t1");
    } finally {
        server.close();
    }
});

// A failing clone/fork/import (callback throws) surfaces as a 400 with the
// error message rather than crashing the route.
test("clone/fork/import errors return 400 with the message", async () => {
    const bus = createBus();
    const piweb = createPiWebHost({ broadcast: () => {}, getPi: () => ({}) });
    const server = createApp({
        web: "src/web",
        bus,
        piweb,
        threads: {
            list: async () => [],
            clone: async () => {
                throw new Error("nothing to clone yet");
            },
        },
    });
    const base = await new Promise((r) =>
        server.listen(0, "127.0.0.1", () =>
            r(`http://127.0.0.1:${server.address().port}`),
        ),
    );
    try {
        const res = await fetch(`${base}/threads/clone`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId: "t1" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain("nothing to clone yet");
    } finally {
        server.close();
    }
});
