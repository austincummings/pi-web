/**
 * Example self-registering web panel.
 *
 * This is a normal pi extension: `export default function (pi: ExtensionAPI)`.
 * It uses globalThis.__PIWEB__ (the pi-web host) to declare a web UI. Loaded by
 * plain `pi` in a terminal, __PIWEB__ is absent and the extension is a harmless
 * no-op — so it stays portable.
 *
 * Demonstrates the full self-modifiable loop:
 *   - a panel the agent could have authored
 *   - local UI state round-trips (counter / name)
 *   - a button that calls back into the agent (pi.sendUserMessage triggers a turn)
 */
export default function (pi: any) {
  const piweb = (globalThis as any).__PIWEB__;
  if (!piweb) return; // portable: no host, no-op

  piweb.registerPanel("hello", {
    title: "Hello Panel — self-registered by an extension",
    initialState: { count: 0, name: "world" },
    render: (s: any) => ({
      type: "Stack",
      children: [
        { type: "Text", text: `👋 Hello, ${s.name}!  (count = ${s.count})` },
        {
          type: "Row",
          children: [
            { type: "Button", label: "-1", action: "dec" },
            { type: "Button", label: "+1", action: "inc" },
          ],
        },
        { type: "Input", placeholder: "set your name…", action: "setName" },
        { type: "Divider" },
        { type: "Button", label: "Ask pi to summarize this repo", action: "ask", variant: "primary" },
      ],
    }),
    actions: {
      inc: (ctx: any) => ctx.setState((s: any) => ({ count: s.count + 1 })),
      dec: (ctx: any) => ctx.setState((s: any) => ({ count: s.count - 1 })),
      setName: (ctx: any) => ctx.setState({ name: ctx.payload?.value || "world" }),
      ask: (ctx: any) =>
        ctx.pi.sendUserMessage(
          "In one paragraph, summarize what this repository contains based on its files.",
        ),
    },
  });
}
