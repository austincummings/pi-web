/**
 * pi-web host: runs the pi agent in-process (createAgentSession) and serves a
 * web cockpit. Browser bus is SSE (server->client) + POST (client->server) so
 * there are zero extra dependencies.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";

import { createPiWebHost } from "./piweb-host.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const WEB = join(__dirname, "..", "web");
const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? "0.0.0.0";
const cwd = process.cwd();

// ---- browser bus (SSE) ----------------------------------------------------
const clients = new Set();
function broadcast(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) res.write(line);
}

// ---- piweb host (injected into extensions) --------------------------------
const piweb = createPiWebHost({
  broadcastPanels: (panels) => broadcast({ kind: "panels", panels }),
  getPi: () => piweb._pi,
});
globalThis.__PIWEB__ = piweb;

// ---- agent session --------------------------------------------------------
const resourceLoader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  additionalExtensionPaths: [join(ROOT, "extensions", "hello-panel.ts")],
  // Inline factory captures the live ExtensionAPI so panel actions can call back
  // into the agent (pi.sendUserMessage, registerTool, etc).
  extensionFactories: [(pi) => { piweb._pi = pi; }],
});
await resourceLoader.reload();

// pi-web defaults to the `meridian` provider. That provider is registered by
// the pi-meridian extension *during* session startup, so it isn't resolvable
// until after createAgentSession. We pin it afterwards via setModel.
// Override with PI_PROVIDER / PI_MODEL.
const PROVIDER = process.env.PI_PROVIDER ?? "meridian";
const MODEL_ID = process.env.PI_MODEL ?? "claude-opus-4-8";
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

const { session } = await createAgentSession({
  cwd,
  resourceLoader,
  sessionManager: SessionManager.inMemory(cwd),
  authStorage,
  modelRegistry,
});

// Extensions are loaded now — the meridian provider is registered. Pin it.
const model = modelRegistry.find(PROVIDER, MODEL_ID);
if (model) {
  await session.setModel(model);
  console.log(`  model:  ${model.provider}/${model.id} (${model.name ?? ""})`);
} else {
  const cur = session.state?.model;
  console.warn(`  model:  ${PROVIDER}/${MODEL_ID} not found — using ${cur?.provider}/${cur?.id}`);
}

// pull plain text out of a message's content (string | block[])
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text).join("");
}
function describeError(raw) {
  if (!raw) return "model returned an error";
  try { return JSON.parse(raw)?.error?.message ?? String(raw); } catch { return String(raw); }
}

// translate agent events -> cockpit messages.
// This provider/model emits message_start/message_end (no text_delta stream),
// so render the final message content; use deltas only when they exist.
let streamed = false;
session.subscribe((ev) => {
  switch (ev.type) {
    case "message_start":
      if (ev.message?.role === "user") broadcast({ kind: "user", text: textOf(ev.message.content) });
      else if (ev.message?.role === "assistant") streamed = false;
      break;
    case "message_update": {
      const e = ev.assistantMessageEvent;
      if (e?.type === "text_delta") { streamed = true; broadcast({ kind: "delta", text: e.delta }); }
      break;
    }
    case "message_end": {
      const m = ev.message;
      if (m?.role !== "assistant") break;
      if (m.stopReason === "error" || m.errorMessage) broadcast({ kind: "error", text: describeError(m.errorMessage) });
      else if (!streamed) { const text = textOf(m.content); if (text) broadcast({ kind: "assistant_full", text }); }
      broadcast({ kind: "assistant_end" });
      break;
    }
    case "tool_execution_start":
      broadcast({ kind: "tool", id: ev.toolCallId, name: ev.toolName, status: "start", args: ev.args });
      break;
    case "tool_execution_end":
      broadcast({ kind: "tool", id: ev.toolCallId, name: ev.toolName, status: "end", isError: ev.isError });
      break;
    case "agent_end":
      broadcast({ kind: "assistant_end" });
      break;
  }
});

// ---- http -----------------------------------------------------------------
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // SSE event stream
  if (path === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    res.write(`data: ${JSON.stringify({ kind: "panels", panels: piweb.snapshot() })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    if (path === "/prompt") {
      const text = (body.text ?? "").trim();
      if (text) {
        // user echo comes from the message_start(role:user) event, covering both
        // /prompt and panel-initiated (sendUserMessage) turns uniformly.
        session.prompt(text).catch((err) => broadcast({ kind: "error", text: String(err?.message ?? err) }));
      }
      res.writeHead(202).end();
      return;
    }
    if (path === "/action") {
      await piweb.dispatch(body.panelId, body.action, body.payload);
      res.writeHead(202).end();
      return;
    }
    if (path === "/reload") {
      // best-effort self-modify hook: re-discover extensions on disk
      piweb.clear();
      try { await resourceLoader.reload(); broadcast({ kind: "system", text: "reloaded extensions" }); }
      catch (err) { broadcast({ kind: "error", text: "reload failed: " + String(err?.message ?? err) }); }
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
      const buf = await readFile(join(WEB, entry[0]));
      res.writeHead(200, { "Content-Type": entry[1] }).end(buf);
    } catch {
      res.writeHead(404).end("not found");
    }
    return;
  }
  res.writeHead(404).end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`\n  pi-web cockpit  →  http://${HOST}:${PORT}  (bound on all interfaces)\n  cwd: ${cwd}\n`);
});

process.on("SIGINT", () => { try { session.dispose(); } finally { process.exit(0); } });
