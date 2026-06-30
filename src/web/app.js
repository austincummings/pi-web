// pi-web cockpit client: transcript stream, extension panels, thread switching,
// and a fuzzy command typeahead (ported from pi-tui's fuzzy matcher).
import { fuzzyFilter } from "/fuzzy.mjs";
import { renderMarkdown } from "/markdown.mjs";

const $transcript = document.getElementById("transcript");
const $dockLeft = document.getElementById("dock-left");
const $dockRight = document.getElementById("dock-right");
const $dockBottom = document.getElementById("dock-bottom");
const $dockFooter = document.getElementById("dock-footer");
const $overlayLayer = document.getElementById("overlay-layer");
const $toastLayer = document.getElementById("toast-layer");
const $statusbar = document.getElementById("statusbar");
const $status = document.getElementById("status");
const $threadTitle = document.getElementById("threadTitle");
const $overlay = document.getElementById("overlay");
const $picker = document.getElementById("picker");
const $prompt = document.getElementById("prompt");
const $ask = document.getElementById("ask");
const $ac = document.getElementById("ac");
const $working = document.getElementById("working");

// ---- "Working" spinner (mirrors pi-tui's Loader: braille frames @ 80ms) ----
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinTimer = null;
let spinIndex = 0;
/** Show/hide the spinner above the input while the focused thread is working. */
function setWorking(on) {
    if (!$working) return;
    const spin = $working.querySelector(".spin");
    if (on) {
        if (spinTimer) return; // already animating
        spinIndex = 0;
        if (spin) spin.textContent = SPIN_FRAMES[0];
        $working.classList.add("show");
        spinTimer = setInterval(() => {
            spinIndex = (spinIndex + 1) % SPIN_FRAMES.length;
            if (spin) spin.textContent = SPIN_FRAMES[spinIndex];
        }, 80);
    } else {
        if (spinTimer) {
            clearInterval(spinTimer);
            spinTimer = null;
        }
        $working.classList.remove("show");
    }
}

let assistantEl = null; // current streaming assistant bubble
let bashEl = null; // current streaming bash output block
let assistantRaw = ""; // accumulated assistant text (rendered as markdown)
let threadItems = []; // last known thread list (from SSE)
// The selected thread is driven by the URL (`/?thread=<id>`), so it survives
// refreshes, is shareable/bookmarkable, and lets different tabs view different
// threads. `activeThreadId` always mirrors the current URL.
/** @returns {string|null} */
function urlThread() {
    return new URL(location.href).searchParams.get("thread") || null;
}
let activeThreadId = urlThread();

// client-side slash commands (cockpit-handled, like pi's /resume, /new)
const COMMANDS = [
    {
        value: "/resume",
        label: "/resume",
        description: "Switch to another thread",
    },
    { value: "/new", label: "/new", description: "Start a new thread" },
    {
        value: "/reload",
        label: "/reload",
        description: "Reload extensions, skills, prompts, themes",
    },
    {
        value: "/copy",
        label: "/copy",
        description: "Copy the last assistant message",
    },
    {
        value: "/compact",
        label: "/compact",
        description: "Compact the conversation context",
    },
    {
        value: "/name",
        label: "/name",
        description: "Set this thread's display name — /name <title>",
    },
    {
        value: "/session",
        label: "/session",
        description: "Show session info and stats",
    },
    {
        value: "/export",
        label: "/export",
        description: "Export session — /export [html|jsonl]",
    },
    {
        value: "/changelog",
        label: "/changelog",
        description: "Show the pi changelog",
    },
    {
        value: "/hotkeys",
        label: "/hotkeys",
        description: "Show keyboard shortcuts",
    },
];

function bubble(role, text = "") {
    if ($transcript.querySelector(".empty")) $transcript.innerHTML = "";
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
    el.querySelector(".body").textContent = text;
    $transcript.appendChild(el);
    $transcript.scrollTop = $transcript.scrollHeight;
    return el;
}

function bashBubble(command, excluded) {
    if ($transcript.querySelector(".empty")) $transcript.innerHTML = "";
    const el = document.createElement("div");
    el.className = "bash";
    const head = document.createElement("div");
    head.className = "bash-cmd";
    head.textContent = (excluded ? "!! " : "! ") + command;
    const body = document.createElement("pre");
    body.className = "body";
    el.append(head, body);
    $transcript.appendChild(el);
    $transcript.scrollTop = $transcript.scrollHeight;
    return el;
}

function renderAssistant(el, text) {
    el.querySelector(".body").innerHTML = renderMarkdown(text);
    $transcript.scrollTop = $transcript.scrollHeight;
}

// Re-render the streaming assistant bubble as markdown, throttled to one paint
// per animation frame so a burst of token deltas doesn't thrash innerHTML.
let assistantRenderPending = false;
function scheduleAssistantRender() {
    if (assistantRenderPending) return;
    assistantRenderPending = true;
    requestAnimationFrame(() => {
        assistantRenderPending = false;
        if (assistantEl) renderAssistant(assistantEl, assistantRaw);
    });
}

function post(path, body) {
    return fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// Thread-scoped POST: tags the request with the thread the client is viewing so
// the host routes prompts/bash/actions/session-ops to the right AgentSession.
/**
 * @param {string} path
 * @param {object} [body]
 */
function postThread(path, body = {}) {
    return post(path, { ...body, threadId: activeThreadId });
}

// Navigate to a thread: push the URL and re-point the SSE stream. The host
// boots/resumes the thread on (re)connect and replays its transcript, so no
// separate "switch" round-trip is needed.
/** @param {string} id */
function gotoThread(id) {
    if (!id || id === activeThreadId) return;
    activeThreadId = id;
    history.pushState({ thread: id }, "", "?thread=" + encodeURIComponent(id));
    reopenStream();
    updateTitle();
}

// ---- component-tree renderer (serializable UI from extensions) ----
// ---- sandboxed custom HTML (Frame node) ----
// Extensions can return { type:"Frame", html, height? }. The html runs in a
// sandboxed iframe (allow-scripts, NO allow-same-origin) so arbitrary
// HTML/CSS/JS is isolated from the cockpit's DOM, cookies, and JS. A tiny
// bridge lets the frame dispatch surface actions and report its height.
// Inside the frame: window.piweb.action(name, payload),
// window.piweb.notify(msg, level), or any [data-action] element.
const mountedFrames = new Map(); // iframe -> { surfaceId, autoHeight }
let frameBridgeInstalled = false;
function installFrameBridge() {
    if (frameBridgeInstalled) return;
    frameBridgeInstalled = true;
    window.addEventListener("message", (e) => {
        // sandboxed frames have a null origin, so identify by window identity
        let frame, meta;
        for (const [f, m] of mountedFrames) {
            if (f.contentWindow === e.source) {
                frame = f;
                meta = m;
                break;
            }
        }
        if (!meta) return;
        const msg = e.data;
        if (!msg || msg.__piweb !== true) return;
        if (msg.type === "action")
            postThread("/action", {
                surfaceId: meta.surfaceId,
                action: msg.action,
                payload: msg.payload ?? {},
            });
        else if (msg.type === "notify") toast(msg.message, msg.level);
        else if (msg.type === "height" && meta.autoHeight)
            frame.style.height =
                Math.max(24, Math.min(Number(msg.height) || 0, 4000)) + "px";
    });
}

// copy the cockpit theme vars into the frame so it matches the active theme
function frameThemeVars() {
    const cs = getComputedStyle(document.documentElement);
    return ["--bg", "--panel", "--line", "--txt", "--dim", "--acc", "--acc2"]
        .map((n) => `${n}:${cs.getPropertyValue(n).trim()}`)
        .join(";");
}

// Wrap extension-provided body HTML into a full sandboxed document with the
// theme + bridge bootstrap. (`<\/script>` is escaped so the bootstrap survives
// being embedded in this module.)
function wrapFrameDoc(html) {
    return (
        `<!doctype html><html><head><meta charset="utf-8"><style>` +
        `:root{${frameThemeVars()}}html,body{margin:0}` +
        `body{font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--txt);background:transparent}` +
        `a{color:var(--acc)}` +
        // baseline control styling so frame buttons/inputs match the cockpit
        // (extensions can override with their own <style>)
        `button{font:inherit;background:var(--panel);color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:5px 10px;cursor:pointer}` +
        `button:hover{border-color:var(--acc)}` +
        `button.primary{background:linear-gradient(90deg,var(--acc),var(--acc2));border:none;color:#fff}` +
        `input,select,textarea{font:inherit;background:#0c1117;color:var(--txt);border:1px solid var(--line);border-radius:6px;padding:6px 8px}` +
        `code,pre{background:#0c1117;border:1px solid var(--line);border-radius:4px}` +
        `</style></head><body>${html}<script>(function(){` +
        `function send(m){m.__piweb=true;parent.postMessage(m,'*');}` +
        `window.piweb={action:function(a,p){send({type:'action',action:a,payload:p||{}});},` +
        `notify:function(msg,l){send({type:'notify',message:msg,level:l||'info'});}};` +
        `document.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-action]');` +
        `if(el){send({type:'action',action:el.getAttribute('data-action'),payload:{}});}});` +
        `function report(){send({type:'height',height:document.documentElement.scrollHeight});}` +
        `if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement);}` +
        `window.addEventListener('load',report);setTimeout(report,0);})();<\/script></body></html>`
    );
}

function renderNode(node, surfaceId) {
    if (!node || typeof node !== "object")
        return document.createTextNode(String(node ?? ""));
    switch (node.type) {
        case "Stack": {
            const d = document.createElement("div");
            d.style.display = "flex";
            d.style.flexDirection = "column";
            d.style.gap = "8px";
            (node.children || []).forEach((c) =>
                d.appendChild(renderNode(c, surfaceId)),
            );
            return d;
        }
        case "Row": {
            const d = document.createElement("div");
            d.className = "row";
            (node.children || []).forEach((c) =>
                d.appendChild(renderNode(c, surfaceId)),
            );
            return d;
        }
        case "Text": {
            const d = document.createElement("div");
            d.textContent = node.text ?? "";
            return d;
        }
        case "Divider": {
            const d = document.createElement("div");
            d.className = "divider";
            return d;
        }
        case "Button": {
            const b = document.createElement("button");
            b.textContent = node.label ?? "button";
            if (node.variant === "primary") b.className = "primary";
            b.onclick = () =>
                postThread("/action", { surfaceId, action: node.action });
            return b;
        }
        case "Input": {
            const i = document.createElement("input");
            i.type = "text";
            if (node.placeholder) i.placeholder = node.placeholder;
            if (node.value != null) i.value = node.value;
            i.onkeydown = (e) => {
                if (e.key === "Enter")
                    postThread("/action", {
                        surfaceId,
                        action: node.action,
                        payload: { value: i.value },
                    });
            };
            i.onblur = () =>
                postThread("/action", {
                    surfaceId,
                    action: node.action,
                    payload: { value: i.value },
                });
            return i;
        }
        case "Frame": {
            // arbitrary HTML/CSS/JS, isolated in a sandboxed iframe
            const iframe = document.createElement("iframe");
            iframe.className = "frame";
            iframe.setAttribute("sandbox", "allow-scripts");
            iframe.setAttribute("scrolling", "no");
            const autoHeight = node.height == null;
            iframe.style.width = "100%";
            iframe.style.border = "0";
            iframe.style.display = "block";
            iframe.style.height = (autoHeight ? 80 : node.height) + "px";
            mountedFrames.set(iframe, { surfaceId, autoHeight });
            iframe.srcdoc = wrapFrameDoc(node.html ?? "");
            return iframe;
        }
        default: {
            const d = document.createElement("div");
            d.textContent = `[unknown node: ${node.type}]`;
            return d;
        }
    }
}

// ---- surfaces: docks (left/right/bottom), overlays, status, toasts ----
let openOverlays = []; // ids of currently-open extension overlays

function surfaceCard(card) {
    const el = document.createElement("div");
    el.className = "surface";
    if (card.title) {
        const t = document.createElement("div");
        t.className = "stitle";
        t.textContent = card.title;
        el.appendChild(t);
    }
    const body = document.createElement("div");
    body.className = "sbody";
    body.appendChild(renderNode(card.tree, card.id));
    el.appendChild(body);
    return el;
}

function renderDock(el, cards) {
    if (!el) return;
    el.innerHTML = "";
    const has = cards && cards.length;
    el.classList.toggle("empty-dock", !has);
    for (const c of cards || []) el.appendChild(surfaceCard(c));
}

// Apply a few overlay option hints (anchor/size) to the modal card.
function applyOverlayOptions(card, options) {
    if (!options) return;
    const sz = (v) => (typeof v === "number" ? `${v}px` : v);
    if (options.width != null) card.style.width = sz(options.width);
    if (options.maxHeight != null) card.style.maxHeight = sz(options.maxHeight);
    const a = options.anchor;
    if (a && a !== "center") {
        // map the 9 pi-tui anchors onto flex alignment of the overlay layer
        const [v, h] = {
            "top-left": ["start", "start"],
            "top-center": ["start", "center"],
            "top-right": ["start", "end"],
            "left-center": ["center", "start"],
            "right-center": ["center", "end"],
            "bottom-left": ["end", "start"],
            "bottom-center": ["end", "center"],
            "bottom-right": ["end", "end"],
        }[a] || ["center", "center"];
        $overlayLayer.style.alignItems = v;
        $overlayLayer.style.justifyContent = h;
    }
}

function renderOverlays(overlays) {
    if (!$overlayLayer) return;
    $overlayLayer.innerHTML = "";
    $overlayLayer.style.alignItems = "center";
    $overlayLayer.style.justifyContent = "center";
    openOverlays = (overlays || []).map((o) => o.id);
    $overlayLayer.classList.toggle("show", openOverlays.length > 0);
    for (const o of overlays || []) {
        const card = document.createElement("div");
        card.className = "ov-card";
        applyOverlayOptions(card, o.options);
        if (o.title) {
            const t = document.createElement("div");
            t.className = "ov-title";
            t.textContent = o.title;
            card.appendChild(t);
        }
        const body = document.createElement("div");
        body.className = "ov-body";
        body.appendChild(renderNode(o.tree, o.id));
        card.appendChild(body);
        $overlayLayer.appendChild(card);
    }
}

function renderStatus(segments) {
    if (!$statusbar) return;
    $statusbar.innerHTML = "";
    const segs = segments || [];
    $statusbar.classList.toggle("show", segs.length > 0);
    for (const s of segs) {
        const el = document.createElement("span");
        el.className = "seg";
        el.textContent = s.text;
        $statusbar.appendChild(el);
    }
}

function renderSurfaces(s) {
    // frames are re-created on every surface render; reset the bridge registry
    // (old iframes are detached when docks/overlays rebuild) and ensure the
    // single window message listener is installed.
    mountedFrames.clear();
    installFrameBridge();
    const docks = s?.docks ?? { left: [], right: [], bottom: [] };
    renderDock($dockLeft, docks.left);
    renderDock($dockRight, docks.right);
    renderDock($dockBottom, docks.bottom);
    renderDock($dockFooter, docks.footer);
    renderOverlays(s?.overlays);
    renderStatus(s?.status);
}

// Close the top extension overlay (Esc / backdrop). Server-driven: it toggles
// the surface's open flag and re-broadcasts.
function closeTopOverlay() {
    const id = openOverlays[openOverlays.length - 1];
    if (id) postThread("/surface", { op: "close", id });
}

function toast(message, level = "info") {
    if (!$toastLayer) return;
    const el = document.createElement("div");
    el.className = `toast ${level}`;
    el.textContent = message;
    $toastLayer.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// ---- threads (conversation sessions) ----
function relTime(d) {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function threadName(t) {
    return (t?.name || "(new thread)").replace(/\s+/g, " ").slice(0, 60);
}

function updateTitle() {
    if (!$threadTitle) return;
    const active = threadItems.find((t) => t.id === activeThreadId);
    if (active) {
        const others = threadItems.filter(
            (t) => t.id !== active.id && t.running,
        ).length;
        $threadTitle.textContent =
            threadName(active) +
            (others ? `  (${others} running in background)` : "");
    } else {
        $threadTitle.innerHTML = '<span class="hint">(no thread)</span>';
    }
}

function openPicker() {
    if (!$overlay) return;
    $picker.innerHTML = "<h3>Resume thread</h3>";

    const mk = (cls, name, meta, onClick) => {
        const item = document.createElement("div");
        item.className = `item ${cls}`;
        const n = document.createElement("span");
        n.className = "name";
        n.textContent = name;
        const m = document.createElement("span");
        m.className = "meta";
        m.textContent = meta;
        item.append(n, m);
        item.onclick = onClick;
        return item;
    };

    $picker.appendChild(
        mk("new", "＋ New thread", "/new", () => {
            closePicker();
            newThread();
        }),
    );

    for (const t of threadItems) {
        const flags = [t.running ? "● running" : t.loaded ? "live" : null]
            .filter(Boolean)
            .join(" ");
        const meta =
            `${t.messageCount ?? 0} msgs · ${relTime(t.modified)}` +
            (flags ? ` · ${flags}` : "");
        $picker.appendChild(
            mk(
                t.active || t.id === activeThreadId ? "active" : "",
                threadName(t),
                meta,
                () => {
                    closePicker();
                    gotoThread(t.id);
                },
            ),
        );
    }
    $overlay.classList.add("show");
}

function closePicker() {
    $overlay?.classList.remove("show");
}

$overlay?.addEventListener("click", (e) => {
    if (e.target === $overlay) closePicker();
});

// clicking the overlay backdrop (not a card) closes the top extension overlay
$overlayLayer?.addEventListener("click", (e) => {
    if (e.target === $overlayLayer) closeTopOverlay();
});

// ---- fuzzy command typeahead ----
let acItems = [];
let acIndex = 0;

function renderAc() {
    if (!acItems.length) {
        closeAc();
        return;
    }
    $ac.innerHTML = "";
    acItems.forEach((it, i) => {
        const o = document.createElement("div");
        o.className = "opt" + (i === acIndex ? " sel" : "");
        const cmd = document.createElement("span");
        cmd.className = "cmd";
        cmd.textContent = it.label;
        const desc = document.createElement("span");
        desc.className = "desc";
        desc.textContent = it.description || "";
        o.append(cmd, desc);
        // mousedown (not click) so it fires before the input blurs
        o.onmousedown = (e) => {
            e.preventDefault();
            acIndex = i;
            acceptAc(true);
        };
        $ac.appendChild(o);
    });
    $ac.classList.add("show");
}

function closeAc() {
    acItems = [];
    $ac.classList.remove("show");
}

function updateAc() {
    const v = $prompt.value;
    // only suggest while typing the command token itself (no args yet)
    if (!v.startsWith("/") || /\s/.test(v)) {
        closeAc();
        return;
    }
    acItems = fuzzyFilter(COMMANDS, v, (c) => c.label);
    acIndex = 0;
    renderAc();
}

function acceptAc(run) {
    const it = acItems[acIndex];
    if (!it) return;
    closeAc();
    if (run) {
        $prompt.value = "";
        runInput(it.value);
    } else {
        $prompt.value = it.value;
        $prompt.focus();
    }
}

function notice(text) {
    bubble("system", text);
}

async function getJson(path) {
    try {
        return await (await fetch(path)).json();
    } catch {
        return null;
    }
}

function showOverlay(title, contentEl) {
    if (!$overlay) return;
    $picker.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = title;
    const body = document.createElement("div");
    body.style.padding = "12px 14px";
    body.appendChild(contentEl);
    $picker.append(h, body);
    $overlay.classList.add("show");
}

function runInput(text) {
    text = (text ?? "").trim();
    if (!text) return;
    if (text.startsWith("!")) {
        const exclude = text.startsWith("!!");
        const command = text.slice(exclude ? 2 : 1).trim();
        if (command)
            postThread("/bash", { command, excludeFromContext: exclude });
        return;
    }
    if (text.startsWith("/")) {
        const sp = text.indexOf(" ");
        const cmd = sp === -1 ? text : text.slice(0, sp);
        const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
        if (runCommand(cmd, arg)) return;
    }
    postThread("/prompt", { text });
}

// Create a fresh thread, then navigate to it (URL + SSE re-point).
function newThread() {
    post("/threads", {})
        .then((r) => r.json())
        .then((d) => {
            if (d?.id) gotoThread(d.id);
        })
        .catch(() => notice("could not create thread"));
}

// returns true if handled as a cockpit command
function runCommand(cmd, arg) {
    switch (cmd) {
        case "/resume":
            openPicker();
            return true;
        case "/new":
            newThread();
            return true;
        case "/reload":
            postThread("/reload", {});
            return true;
        case "/copy":
            copyLastAssistant();
            return true;
        case "/compact":
            postThread("/session/compact", {});
            return true;
        case "/name":
            if (!arg) notice("usage: /name <title>");
            else postThread("/session/name", { name: arg });
            return true;
        case "/session":
            showSessionInfo();
            return true;
        case "/export":
            doExport(arg);
            return true;
        case "/changelog":
            showChangelog();
            return true;
        case "/hotkeys":
            showHotkeys();
            return true;
        default:
            return false;
    }
}

function copyLastAssistant() {
    const nodes = $transcript.querySelectorAll(".msg.assistant .body");
    const text = nodes.length ? nodes[nodes.length - 1].textContent : "";
    if (!text) {
        notice("nothing to copy");
        return;
    }
    (navigator.clipboard?.writeText(text) ?? Promise.reject()).then(
        () => notice("copied last message"),
        () => notice("copy failed (clipboard unavailable)"),
    );
}

async function doExport(format) {
    const fmt = format === "jsonl" ? "jsonl" : "html";
    const r = await (
        await postThread("/session/export", { format: fmt })
    ).json();
    if (r?.path) notice(`exported (${r.format}) → ${r.path}`);
    else notice("export failed" + (r?.error ? `: ${r.error}` : ""));
}

async function showSessionInfo() {
    const info = await getJson(
        "/session" +
            (activeThreadId
                ? "?thread=" + encodeURIComponent(activeThreadId)
                : ""),
    );
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.margin = "0";
    pre.textContent = info
        ? JSON.stringify(info, null, 2)
        : "(no session info)";
    showOverlay("Session", pre);
}

async function showChangelog() {
    const r = await getJson("/changelog");
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.margin = "0";
    pre.textContent = r?.text || "(changelog unavailable)";
    showOverlay("Changelog", pre);
}

function showHotkeys() {
    const wrap = document.createElement("div");
    const keys = [
        ["Enter", "send message / run selected command"],
        ["/", "open command typeahead"],
        ["↑ / ↓", "move through command suggestions"],
        ["Tab", "complete selected command"],
        ["Esc", "dismiss menu / overlay · interrupt the working agent"],
        ["/resume", "switch threads"],
        ["/new", "new thread"],
    ];
    wrap.innerHTML = keys
        .map(
            ([k, d]) =>
                `<div style="display:flex;gap:12px;padding:3px 0"><b style="color:var(--acc);min-width:90px">${k}</b><span>${d}</span></div>`,
        )
        .join("");
    showOverlay("Keyboard shortcuts", wrap);
}

$prompt.addEventListener("input", updateAc);
$prompt.addEventListener("keydown", (e) => {
    if (!$ac.classList.contains("show")) return;
    switch (e.key) {
        case "ArrowDown":
            e.preventDefault();
            acIndex = (acIndex + 1) % acItems.length;
            renderAc();
            break;
        case "ArrowUp":
            e.preventDefault();
            acIndex = (acIndex - 1 + acItems.length) % acItems.length;
            renderAc();
            break;
        case "Tab":
            e.preventDefault();
            acceptAc(false);
            break;
        case "Enter":
            e.preventDefault();
            acceptAc(true);
            break;
        case "Escape":
            e.preventDefault();
            closeAc();
            break;
    }
});

// Escape precedence: close the command typeahead, else close an open overlay,
// else interrupt the working agent on the focused thread.
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($ac.classList.contains("show")) return; // handled by the prompt keydown
    if ($overlay?.classList.contains("show")) {
        closePicker();
        return;
    }
    if ($overlayLayer?.classList.contains("show")) {
        closeTopOverlay();
        return;
    }
    if (spinTimer) {
        // agent is working → interrupt this thread's turn
        postThread("/interrupt", {});
    }
});

$ask.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $prompt.value;
    $prompt.value = "";
    closeAc();
    runInput(text);
});

// ---- SSE stream ----
// One EventSource at a time, scoped to the viewed thread via `?thread`.
// Switching threads = reopen the stream; the host replays the new thread.
/** @type {EventSource|null} */
let es = null;

function streamUrl() {
    return (
        "/events" +
        (activeThreadId ? "?thread=" + encodeURIComponent(activeThreadId) : "")
    );
}

function reopenStream() {
    if (es) es.close();
    es = new EventSource(streamUrl());
    es.onopen = () => {
        $status.textContent = "● live";
        $status.className = "";
    };
    es.onerror = () => {
        $status.textContent = "○ disconnected";
    };
    es.onmessage = onSseMessage;
}

/** @param {MessageEvent} e */
function onSseMessage(e) {
    const m = JSON.parse(e.data);
    switch (m.kind) {
        case "surfaces":
            renderSurfaces(m.surfaces);
            break;
        case "notify":
            toast(m.message, m.level);
            break;
        case "threads":
            threadItems = m.items || [];
            updateTitle();
            if ($overlay?.classList.contains("show")) openPicker();
            break;
        case "thread_switched":
            // the host tells us which thread this connection resolved to;
            // canonicalize the URL (e.g. when we connected without a ?thread,
            // or asked for an unknown id and fell back to the default).
            activeThreadId = m.id;
            if (urlThread() !== m.id)
                history.replaceState(
                    { thread: m.id },
                    "",
                    "?thread=" + encodeURIComponent(m.id),
                );
            updateTitle();
            break;
        case "working":
            setWorking(!!m.busy);
            break;
        case "transcript_reset":
            $transcript.innerHTML = '<div class="empty">new thread</div>';
            assistantEl = null;
            setWorking(false);
            break;
        case "user":
            bubble("user", m.text);
            assistantEl = null;
            break;
        case "delta":
            if (!assistantEl) {
                assistantEl = bubble("assistant", "");
                assistantRaw = "";
            }
            assistantRaw += m.text;
            // render markdown incrementally as tokens stream in
            scheduleAssistantRender();
            break;
        case "assistant_full":
            if (!assistantEl) assistantEl = bubble("assistant", "");
            assistantRaw = m.text;
            renderAssistant(assistantEl, assistantRaw);
            break;
        case "assistant_end":
            if (assistantEl && assistantRaw)
                renderAssistant(assistantEl, assistantRaw);
            assistantEl = null;
            assistantRaw = "";
            break;
        case "bash":
            if (m.status === "start") {
                bashEl = bashBubble(m.command, m.excludeFromContext);
            } else if (m.status === "chunk") {
                if (!bashEl) bashEl = bashBubble("", false);
                bashEl.querySelector(".body").textContent += m.text;
                $transcript.scrollTop = $transcript.scrollHeight;
            } else if (m.status === "end") {
                if (bashEl && m.exitCode != null && m.exitCode !== 0) {
                    const code = document.createElement("div");
                    code.className = "bash-cmd";
                    code.textContent = `exit ${m.exitCode}`;
                    bashEl.appendChild(code);
                }
                bashEl = null;
            }
            break;
        case "tool": {
            const el = document.createElement("div");
            el.className = "tool";
            el.textContent =
                m.status === "start"
                    ? `⏵ ${m.name}(${JSON.stringify(m.args ?? {})})`
                    : `⏹ ${m.name}${m.isError ? " (error)" : ""}`;
            $transcript.appendChild(el);
            break;
        }
        case "system":
            bubble("system", m.text);
            break;
        case "error":
            bubble("system", "⚠ " + m.text);
            break;
    }
}

// Back/forward navigation between threads re-points the stream.
window.addEventListener("popstate", () => {
    activeThreadId = urlThread();
    reopenStream();
    updateTitle();
});

reopenStream();
