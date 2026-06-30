/**
 * Example self-registering web UI extension.
 *
 * This is a normal pi extension: `export default function (pi: ExtensionAPI)`.
 * It uses globalThis.__PIWEB__ (the pi-web host) to declare cockpit UI. Loaded
 * by plain `pi` in a terminal, __PIWEB__ is absent and the extension is a
 * harmless no-op — so it stays portable.
 *
 * Demonstrates the dock + overlay model:
 *   - a right-rail dock the agent could have authored
 *   - local UI state round-trips (counter / name)
 *   - a button that opens a modal overlay
 *   - a button that calls back into the agent (pi.sendUserMessage triggers a turn)
 */
export default function (pi: any) {
    const piweb = (globalThis as any).__PIWEB__;
    if (!piweb) return; // portable: no host, no-op

    piweb.dock("hello", {
        side: "right",
        title: "Hello — self-registered by an extension",
        initialState: { count: 0, name: "world" },
        render: (s: any) => ({
            type: "Stack",
            children: [
                {
                    type: "Text",
                    text: `👋 Hello, ${s.name}!  (count = ${s.count})`,
                },
                {
                    type: "Row",
                    children: [
                        { type: "Button", label: "-1", action: "dec" },
                        { type: "Button", label: "+1", action: "inc" },
                    ],
                },
                {
                    type: "Input",
                    placeholder: "set your name…",
                    action: "setName",
                },
                { type: "Divider" },
                {
                    type: "Row",
                    children: [
                        {
                            type: "Button",
                            label: "Open details…",
                            action: "openDetails",
                        },
                        {
                            type: "Button",
                            label: "Ask pi to summarize this repo",
                            action: "ask",
                            variant: "primary",
                        },
                    ],
                },
            ],
        }),
        actions: {
            inc: (ctx: any) =>
                ctx.setState((s: any) => ({ count: s.count + 1 })),
            dec: (ctx: any) =>
                ctx.setState((s: any) => ({ count: s.count - 1 })),
            setName: (ctx: any) =>
                ctx.setState({ name: ctx.payload?.value || "world" }),
            openDetails: (ctx: any) => ctx.openOverlay("hello-details"),
            ask: (ctx: any) => {
                ctx.notify("Asking pi to summarize the repo…", "info");
                ctx.pi.sendUserMessage(
                    "In one paragraph, summarize what this repository contains based on its files.",
                );
            },
        },
    });

    // A declarative modal overlay, opened by the dock's "Open details…" button.
    piweb.overlay("hello-details", {
        title: "Hello details",
        options: { width: 420, anchor: "center" },
        render: () => ({
            type: "Stack",
            children: [
                {
                    type: "Text",
                    text: "This modal is a piweb overlay — a serializable component tree rendered above the cockpit.",
                },
                { type: "Divider" },
                { type: "Button", label: "Close", action: "close" },
            ],
        }),
        actions: {
            close: (ctx: any) => ctx.closeOverlay("hello-details"),
        },
    });

    // Custom HTML/CSS/JS rendered in a sandboxed iframe (Frame node). The
    // `[data-action]` button and `window.piweb` bridge dispatch back into this
    // surface's actions; arbitrary JS (here a tiny canvas animation) runs
    // isolated from the cockpit.
    piweb.dock("frame-demo", {
        side: "bottom",
        title: "Custom HTML — sandboxed iframe",
        render: () => ({
            type: "Frame",
            height: 180,
            html: `
                <div style="padding:12px;border-radius:8px;background:linear-gradient(90deg,var(--acc),var(--acc2));color:#fff">
                    <b>Hello from a sandboxed iframe</b>
                    <p style="margin:6px 0">Arbitrary HTML + CSS + JS, isolated from the cockpit.</p>
                    <canvas id="c" width="600" height="40" style="width:100%;height:40px"></canvas>
                    <button data-action="ping" style="margin-top:8px;cursor:pointer">Ping the agent host</button>
                </div>
                <script>
                    var cv=document.getElementById('c'),x=cv.getContext('2d'),t=0;
                    (function loop(){t+=0.05;x.clearRect(0,0,600,40);
                        for(var i=0;i<600;i++){var y=20+15*Math.sin(i/30+t);
                            x.fillStyle='rgba(255,255,255,0.7)';x.fillRect(i,y,1,2);}
                        requestAnimationFrame(loop);})();
                <\/script>`,
        }),
        actions: {
            ping: (ctx: any) =>
                ctx.notify("Ping received from inside the iframe!", "info"),
        },
    });

    // A below-prompt (footer) dock — the pi-tui "belowEditor" zone.
    piweb.dock("footer-hint", {
        side: "footer",
        render: () => ({
            type: "Text",
            text: "tip: / for commands · ! to run shell · Esc to interrupt",
        }),
    });

    // Contribute a segment to the bottom context bar, alongside the
    // host-managed model / context-usage segment.
    piweb.setStatus("hello", "hello-panel ✓");
}
