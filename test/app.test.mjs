/**
 * MVP-0 smoke test: the model-independent core.
 *
 * Boots the real transport (app.mjs) + real registry (piweb-host.mjs) on an
 * ephemeral port — no agent, no model, no auth — and asserts the end-to-end
 * loop: /health, the initial SSE panel snapshot, and a panel action round-trip
 * (registerPanel -> snapshot -> dispatch -> setState -> broadcast).
 */
import { test, expect } from "bun:test";
import { createBus, createApp } from "../src/host/app.mjs";
import { createPiWebHost } from "../src/host/piweb-host.mjs";

function startServer() {
    const bus = createBus();
    const piweb = createPiWebHost({
        broadcastPanels: (panels) => bus.broadcast({ kind: "panels", panels }),
        getPi: () => ({ sendUserMessage() {} }), // stub; not exercised here
    });
    // a counter panel mirroring hello-panel's state semantics
    piweb.registerPanel("hello", {
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
        expect(health.panels).toBe(1);

        // SSE delivers the initial panel snapshot
        const events = frameReader(await fetch(`${base}/events`));
        const first = await events.next();
        expect(first.kind).toBe("panels");
        expect(first.panels[0].id).toBe("hello");
        expect(first.panels[0].tree.text).toBe("count=0");

        // a panel action round-trips state back over SSE
        await fetch(`${base}/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ panelId: "hello", action: "inc" }),
        });
        const second = await events.next();
        expect(second.kind).toBe("panels");
        expect(second.panels[0].tree.text).toBe("count=1");

        events.close();
    } finally {
        server.close();
    }
});
