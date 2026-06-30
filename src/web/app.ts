// pi-web web client: transcript stream, extension panels, thread switching,
// and a fuzzy command typeahead (ported from pi-tui's fuzzy matcher).
import { fuzzyFilter } from "./fuzzy.ts";
import { renderMarkdown } from "./markdown.ts";
import {
    toolTitle,
    truncateResult,
    getToolRenderer,
    registerToolRenderer,
} from "./tools.ts";
import {
    keyHintsLine,
    sectionSummary,
    hasResources,
    type WelcomeInfo,
} from "./welcome.ts";

// Expose the tool-renderer registry so client-side extensions can override how
// a tool's result is displayed (web counterpart to pi-tui's renderResult).
(window as any).piweb = Object.assign((window as any).piweb || {}, {
    registerToolRenderer,
});

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
const $prompt = document.getElementById("prompt") as HTMLTextAreaElement;
const $ask = document.getElementById("ask") as HTMLFormElement;
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
let thinkingEl = null; // current streaming thinking block
let thinkingRaw = ""; // accumulated thinking text (rendered as markdown)
let thinkingHidden = false; // mirrors pi's "hide thinking blocks" setting
let thinkingLevel = "off"; // per-session reasoning level (focused border color)
let thinkingSupported = false; // does the active model support cycling levels?
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

// client-side slash commands (client-handled, like pi's /resume, /new)
const COMMANDS = [
    {
        value: "/resume",
        label: "/resume",
        description: "Switch to another thread",
    },
    {
        value: "/new",
        label: "/new",
        description:
            "Start a new thread — /new [dir] (prompts for a directory)",
    },
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
    clearEmpty();
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
    el.querySelector(".body").textContent = text;
    $transcript.appendChild(el);
    $transcript.scrollTop = $transcript.scrollHeight;
    return el;
}

function bashBubble(command, excluded) {
    clearEmpty();
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

// ---- Tool calls ----------------------------------------------------------
// One card per tool call (keyed by toolCallId), built from a mutable `info`
// record. The card shows a header (marker + name + arg summary) and a result
// body that is collapsed to MAX_TOOL_LINES until expanded (click or alt+o),
// matching pi-tui's default tool-result view. `lastToolEntry` is the target of
// the global alt+o toggle.
let toolEls = {};
let lastToolEntry = null;
// The agent's working directory (from the `config` frame); used to show
// cwd-relative tool paths like the TUI.
let cwd = "";

// Startup / reload intro view (#5/#12): the version banner + loaded resources,
// emitted as the first entry in the transcript (scrolls with the content rather
// than sticking to the top). Collapsed by default (compact comma lists), click
// to expand (one resource per line), mirroring the TUI header.
let welcomeInfo: WelcomeInfo | null = null;
let welcomeExpanded = false;

// Remove placeholder copy without nuking real transcript entries (e.g. the
// welcome banner). Used wherever the first message replaces the empty state.
function clearEmpty() {
    $transcript.querySelectorAll(".empty").forEach((e) => e.remove());
}

function renderWelcome() {
    let el = $transcript.querySelector(".welcome") as HTMLElement | null;
    const info = welcomeInfo;
    if (!info) {
        if (el) el.remove();
        return;
    }
    if (!el) {
        el = document.createElement("div");
        el.className = "welcome";
    }
    // keep the banner pinned as the first transcript entry
    if ($transcript.firstChild !== el) {
        $transcript.insertBefore(el, $transcript.firstChild);
    }
    el.classList.toggle("expanded", welcomeExpanded);
    el.innerHTML = "";

    const logo = document.createElement("div");
    logo.className = "logo";
    logo.textContent = "pi";
    if (info.version) {
        const ver = document.createElement("span");
        ver.className = "ver";
        ver.textContent = ` v${info.version}`;
        logo.appendChild(ver);
    }
    el.appendChild(logo);

    const hints = document.createElement("div");
    hints.className = "hints";
    hints.textContent = keyHintsLine();
    el.appendChild(hints);

    if (hasResources(info)) {
        const secs = document.createElement("div");
        secs.className = "sections";
        for (const s of info.sections) {
            if (!s.items || !s.items.length) continue;
            const sec = document.createElement("div");
            sec.className = "sec";
            const name = document.createElement("span");
            name.className = "sec-name";
            name.textContent = `[${s.name}] `;
            const items = document.createElement("span");
            items.className = "sec-items";
            items.textContent = welcomeExpanded
                ? s.items.join("\n")
                : sectionSummary(s.items);
            sec.appendChild(name);
            sec.appendChild(items);
            secs.appendChild(sec);
        }
        el.appendChild(secs);
    }

    const toggle = document.createElement("div");
    toggle.className = "toggle";
    toggle.textContent = welcomeExpanded
        ? "collapse"
        : "show loaded resources (click)";
    el.appendChild(toggle);

    el.onclick = () => {
        welcomeExpanded = !welcomeExpanded;
        renderWelcome();
    };
}

// True when the transcript is scrolled (near) to the bottom, so we only
// auto-follow new output when the user hasn't scrolled up to read history.
function nearBottom(pad = 40) {
    return (
        $transcript.scrollHeight -
            $transcript.scrollTop -
            $transcript.clientHeight <
        pad
    );
}

// `scroll` is only honored when new agent output arrives; user-initiated
// expand/collapse re-renders pass `false` so the view stays put.
function renderToolCard(entry, scroll = false) {
    const info = entry.info;
    const el = entry.el;
    el.innerHTML = "";
    el.classList.toggle("error", !!info.isError);
    el.classList.toggle("pending", !!info.pending);

    const head = document.createElement("div");
    head.className = "tool-head";
    const mark = info.pending ? "\u23F5" : "";
    head.innerHTML =
        '<span class="tool-mark"></span><span class="tool-name"></span> ' +
        '<span class="tool-args"></span><span class="tool-dim"></span>';
    head.querySelector(".tool-mark").textContent = mark;
    const title = toolTitle(info.name, info.args, cwd);
    head.querySelector(".tool-name").textContent = title.name;
    head.querySelector(".tool-args").textContent = title.args;
    head.querySelector(".tool-dim").textContent = title.dim;
    el.appendChild(head);

    // Extension override: a registered renderer may replace the default body.
    const custom = getToolRenderer(info.name);
    if (custom) {
        try {
            const node = custom({ ...info });
            if (node) {
                el.appendChild(node);
                if (scroll) $transcript.scrollTop = $transcript.scrollHeight;
                return;
            }
        } catch {
            /* fall through to the default rendering */
        }
    }

    if (info.result) {
        const { shown, hidden } = truncateResult(info.result, !!info.expanded);
        const makeMore = (label) => {
            const more = document.createElement("div");
            more.className = "tool-more";
            more.textContent = label;
            more.onclick = () => {
                info.expanded = !info.expanded;
                renderToolCard(entry, false);
            };
            return more;
        };
        // Collapsed: the preview is the tail, so the "N earlier lines" hint goes
        // ABOVE it (matching pi-tui). Expanded: a "collapse" affordance below.
        if (hidden > 0) {
            el.appendChild(
                makeMore(
                    `… ${hidden} earlier line${hidden === 1 ? "" : "s"} (alt+o)`,
                ),
            );
        }
        const body = document.createElement("pre");
        body.className = "tool-body";
        body.textContent = shown;
        el.appendChild(body);
        if (info.expanded) {
            el.appendChild(makeMore("collapse (alt+o)"));
        }
    }
    if (scroll) $transcript.scrollTop = $transcript.scrollHeight;
}

// Apply a `tool` SSE frame: create or update the card for this call id.
function applyToolFrame(m) {
    let entry = toolEls[m.id];
    if (!entry) {
        clearEmpty();
        const el = document.createElement("div");
        el.className = "tool";
        $transcript.appendChild(el);
        entry = toolEls[m.id] = {
            el,
            info: {
                name: m.name,
                args: undefined,
                result: "",
                isError: false,
                pending: true,
                expanded: false,
            },
        };
    }
    if (m.status === "start") {
        entry.info.name = m.name;
        entry.info.args = m.args;
        entry.info.pending = true;
    } else {
        entry.info.pending = false;
        entry.info.isError = !!m.isError;
        if (m.result != null) entry.info.result = String(m.result);
    }
    lastToolEntry = entry;
    renderToolCard(entry, nearBottom());
}

// A collapsible thinking/reasoning trace. Clicking the header (or Ctrl+T)
// toggles visibility, which is persisted to pi's `hideThinkingBlock` setting.
function thinkingBubble() {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "thinking-block";
    el.innerHTML =
        '<div class="think-head">thinking</div><div class="think-body"></div>';
    (el.querySelector(".think-head") as HTMLElement).onclick = () =>
        toggleThinking();
    $transcript.appendChild(el);
    $transcript.scrollTop = $transcript.scrollHeight;
    return el;
}

function renderThinking(el, text) {
    el.querySelector(".think-body").innerHTML = renderMarkdown(text);
    $transcript.scrollTop = $transcript.scrollHeight;
}

// Throttle streaming thinking re-renders to one paint per animation frame.
let thinkingRenderPending = false;
function scheduleThinkingRender() {
    if (thinkingRenderPending) return;
    thinkingRenderPending = true;
    requestAnimationFrame(() => {
        thinkingRenderPending = false;
        if (thinkingEl) renderThinking(thinkingEl, thinkingRaw);
    });
}

// Apply the hidden state to the DOM (CSS collapses .think-body). When `persist`
// is set, also write the new value back to pi's settings via the host.
function setThinkingHidden(hidden, persist) {
    thinkingHidden = !!hidden;
    document.body.classList.toggle("hide-thinking", thinkingHidden);
    if (persist) postThread("/thinking", { hidden: thinkingHidden });
}

function toggleThinking() {
    setThinkingHidden(!thinkingHidden, true);
}

// Tint the focused composer border by the current reasoning level (mirrors the
// pi TUI editor border via theme.getThinkingBorderColor). `data-think` selects
// the level color in CSS; `data-bash` overrides it green while the input is a
// `!` shell command (matching the TUI bash-mode border). The border only shows
// the tint when focused; otherwise it stays the default `--line`.
const $composer = $prompt?.closest(".composer") as HTMLElement | null;
function applyThinkingBorder() {
    if (!$composer) return;
    $composer.dataset.think = thinkingLevel || "off";
    // match the pi TUI: leading whitespace is ignored when detecting `!` bash
    const bash = ($prompt?.value ?? "").trimStart().startsWith("!");
    $composer.toggleAttribute("data-bash", bash);
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
    fileCacheAt = 0; // the new thread may have a different cwd → refetch @-files
    history.pushState({ thread: id }, "", "?thread=" + encodeURIComponent(id));
    reopenStream();
    updateTitle();
}

// ---- component-tree renderer (serializable UI from extensions) ----
// ---- sandboxed custom HTML (Frame node) ----
// Extensions can return { type:"Frame", html, height? }. The html runs in a
// sandboxed iframe (allow-scripts, NO allow-same-origin) so arbitrary
// HTML/CSS/JS is isolated from the web UI's DOM, cookies, and JS. A tiny
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

// copy the web UI theme vars into the frame so it matches the active theme
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
        `body{font:14px/1.5 ui-monospace,Menlo,monospace;color:var(--txt);background:transparent}` +
        `a{color:var(--acc)}` +
        // baseline control styling so frame buttons/inputs match the web UI
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
    const left = segs.filter((s) => s.align !== "right");
    const right = segs.filter((s) => s.align === "right");
    const add = (s, pushRight) => {
        const el = document.createElement("span");
        el.className =
            "seg" +
            (s.tone ? " tone-" + s.tone : "") +
            (pushRight ? " right" : "");
        el.textContent = s.text;
        $statusbar.appendChild(el);
    };
    left.forEach((s) => add(s, false));
    // the first right-aligned segment carries margin-left:auto to push the
    // group (e.g. model name) to the far right, like pi's footer
    right.forEach((s, i) => add(s, i === 0));
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

// Short label for a working directory: the basename (full path kept for the
// `title` tooltip). Threads can live in different dirs, so the picker/header
// surface where each one runs.
function dirBase(p) {
    if (!p) return "";
    return p.replace(/\/+$/, "").split("/").pop() || p;
}

// A compact directory label: the last two path segments (e.g. `projects/pi-web`),
// enough to disambiguate same-named project folders without the full path.
function dirShort(p) {
    if (!p) return "";
    const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
    return parts.slice(-2).join("/") || p;
}

// the app-title prefix for the browser tab, mirroring the pi TUI's `π` prefix
const PAGE_TITLE_PREFIX = "π web";
// extension-supplied override (piweb.setTitle); "" means "use the default"
let extPageTitle = "";

/**
 * Set the browser page (tab) title from an extension's setTitle().
 * An override takes precedence over the thread-derived default; ""/undefined
 * clears it so the title falls back to the `π web - <session> - <cwd>` default.
 * @param {string} [text]
 */
function setPageTitle(text) {
    extPageTitle = text ? String(text) : "";
    applyPageTitle();
}

/**
 * Compute the browser-tab title. Mirrors the pi TUI's terminal title
 * (`π - <session> - <cwd>`): here `π web - <thread name> - <cwd>`, dropping the
 * session segment when the thread is unnamed and the cwd segment when unknown.
 */
function applyPageTitle() {
    if (extPageTitle) {
        document.title = extPageTitle;
        return;
    }
    const active = threadItems.find((t) => t.id === activeThreadId);
    const cwdBase = cwd ? cwd.replace(/\/+$/, "").split("/").pop() : "";
    const parts = [PAGE_TITLE_PREFIX];
    if (active?.name) parts.push(threadName(active));
    if (cwdBase) parts.push(cwdBase);
    document.title = parts.join(" - ");
}

function updateTitle() {
    applyPageTitle();
    if (!$threadTitle) return;
    const active = threadItems.find((t) => t.id === activeThreadId);
    if (active) {
        const others = threadItems.filter(
            (t) => t.id !== active.id && t.running,
        ).length;
        const base = dirBase(active.cwd || cwd);
        $threadTitle.textContent =
            threadName(active) +
            (base ? `  ·  ${base}` : "") +
            (others ? `  (${others} running in background)` : "");
        $threadTitle.title = active.cwd || cwd || "";
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

    // New thread in the current directory (quick path). To start one elsewhere,
    // use `/new <dir>` in the prompt — it offers a directory typeahead.
    $picker.appendChild(
        mk("new", "＋ New thread", "here · or /new <dir>", () => {
            closePicker();
            newThread(cwd);
        }),
    );

    // Group threads by working directory (sessions are partitioned per-cwd), so
    // it's clear where each thread runs. The active thread's group sorts first.
    const groups = new Map();
    for (const t of threadItems) {
        const key = t.cwd || cwd || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
    }
    const activeCwd =
        threadItems.find((t) => t.id === activeThreadId)?.cwd || cwd || "";
    const keys = [...groups.keys()].sort((a, b) =>
        a === activeCwd ? -1 : b === activeCwd ? 1 : 0,
    );
    const multiDir = keys.length > 1;
    for (const key of keys) {
        if (multiDir) {
            const head = document.createElement("div");
            head.className = "dir-head";
            head.textContent = dirShort(key) || key;
            head.title = key;
            $picker.appendChild(head);
        }
        for (const t of groups.get(key)) {
            const flags = [t.running ? "● running" : t.loaded ? "live" : null]
                .filter(Boolean)
                .join(" ");
            const meta =
                `${t.messageCount ?? 0} msgs · ${relTime(t.modified)}` +
                (flags ? ` · ${flags}` : "");
            const item = mk(
                t.active || t.id === activeThreadId ? "active" : "",
                threadName(t),
                meta,
                () => {
                    closePicker();
                    gotoThread(t.id);
                },
            );
            item.title = t.cwd || "";
            $picker.appendChild(item);
        }
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

// ---- prompt input history (Up/Down browse, mirrors the pi TUI editor) ----
// Per-thread, oldest -> newest. Seeded from `case "user"` SSE frames so it
// covers both live sends and replay; cleared on `transcript_reset`.
let promptHistory: string[] = [];
// Browse cursor: null = editing the live draft; otherwise an index into
// promptHistory. Up walks toward 0; Down walks past the end back to the draft.
let histIndex: number | null = null;
// The in-progress draft stashed on entering history; restored on the way down.
let histDraft = "";

// Record a submitted/replayed prompt, skipping consecutive duplicates.
function pushHistory(text: string) {
    const t = (text ?? "").replace(/\s+$/, "");
    if (!t) return;
    if (promptHistory[promptHistory.length - 1] === t) return;
    promptHistory.push(t);
}

// True when the caret sits on the first logical line of the textarea.
function caretOnFirstLine() {
    const c = $prompt.selectionStart ?? 0;
    return $prompt.value.lastIndexOf("\n", c - 1) === -1;
}

// True when the caret sits on the last logical line of the textarea.
function caretOnLastLine() {
    const c = $prompt.selectionStart ?? 0;
    return $prompt.value.indexOf("\n", c) === -1;
}

// Show a recalled history entry, placing the caret at `pos`.
function showHistory(idx: number, pos: number) {
    histIndex = idx;
    $prompt.value = promptHistory[idx];
    autoGrow();
    const at = pos < 0 ? $prompt.value.length : pos;
    $prompt.setSelectionRange(at, at);
}

// Up arrow with the typeahead closed. Returns true when it consumed the key.
function tryHistoryUp() {
    if (!caretOnFirstLine()) return false; // let the caret move up a line
    // Edge nudge (pi #5789): a non-empty draft jumps to the start of the line
    // on the first Up; history browsing begins on the next press.
    if (histIndex === null && ($prompt.selectionStart ?? 0) > 0) {
        $prompt.setSelectionRange(0, 0);
        return true;
    }
    if (!promptHistory.length) return false;
    if (histIndex === null) {
        histDraft = $prompt.value;
        showHistory(promptHistory.length - 1, 0);
    } else if (histIndex > 0) {
        showHistory(histIndex - 1, 0); // caret at start when browsing up (#5454)
    }
    return true;
}

// Down arrow with the typeahead closed. Returns true when it consumed the key.
function tryHistoryDown() {
    if (histIndex === null) return false; // not browsing: default behavior
    if (!caretOnLastLine()) return false; // let the caret move down a line
    if (histIndex < promptHistory.length - 1) {
        showHistory(histIndex + 1, -1); // caret at end when browsing down (#5454)
    } else {
        // Stepped past the newest entry: restore the stashed draft (#5494).
        histIndex = null;
        $prompt.value = histDraft;
        autoGrow();
        const at = $prompt.value.length;
        $prompt.setSelectionRange(at, at);
    }
    return true;
}

// ---- fuzzy command + @file typeahead ----
let acItems = [];
let acIndex = 0;
// "command" = leading-slash command palette; "file" = `@`-mention completion.
let acMode = "command";
// For file mode: the [start, end) span of the `@token` being completed, so an
// accepted suggestion is spliced in place (mid-line) instead of replacing all.
let acAtStart = 0;
let acAtEnd = 0;
// Sequence guard so a slow /files fetch can't clobber a newer keystroke.
let acReq = 0;
// Cached project file list (fetched lazily on first `@`, refreshed on a TTL).
let fileCache = null;
let fileCacheAt = 0;
const FILE_CACHE_TTL_MS = 8000;

// Map the server's path list into typeahead items: `@path` is what gets
// inserted; basename is the label, full path the muted description.
async function ensureFiles() {
    if (fileCache && Date.now() - fileCacheAt < FILE_CACHE_TTL_MS) {
        return fileCache;
    }
    try {
        const r = await fetch(
            "/files" +
                (activeThreadId
                    ? "?thread=" + encodeURIComponent(activeThreadId)
                    : ""),
        );
        const j = await r.json();
        fileCache = (j.items || []).map((p) => ({
            value: "@" + p,
            label: p.slice(p.lastIndexOf("/") + 1),
            description: p,
            path: p,
        }));
        fileCacheAt = Date.now();
    } catch {
        fileCache = fileCache || [];
    }
    return fileCache;
}

// Find a `@token` ending at the caret: an `@` at start-of-text or after
// whitespace, followed by non-whitespace (the query). Returns null otherwise.
function atTokenBeforeCaret(text, caret) {
    const before = text.slice(0, caret);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return null;
    const query = m[2];
    return { start: caret - query.length - 1, end: caret, query };
}

async function showFileAc(query) {
    const myReq = ++acReq;
    const files = await ensureFiles();
    if (myReq !== acReq) return; // a newer keystroke superseded this one
    const ranked = query ? fuzzyFilter(files, query, (f) => f.path) : files;
    acItems = ranked.slice(0, 20);
    acIndex = 0;
    renderAc();
}

// Directory suggestions for `/new <dir>`: the host resolves the partial against
// the active thread's cwd and returns matching subdirs as absolute paths.
async function showDirAc(query) {
    const myReq = ++acReq;
    let items = [];
    try {
        const r = await fetch(
            "/dirs?q=" +
                encodeURIComponent(query) +
                (activeThreadId
                    ? "&thread=" + encodeURIComponent(activeThreadId)
                    : ""),
        );
        items = (await r.json()).items || [];
    } catch {}
    if (myReq !== acReq) return; // a newer keystroke superseded this one
    acItems = items;
    acIndex = 0;
    renderAc();
}

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
    const caret = $prompt.selectionStart ?? v.length;

    // command palette: a leading-slash token with no args yet (start of input)
    if (v.startsWith("/") && !/\s/.test(v)) {
        acMode = "command";
        acItems = fuzzyFilter(COMMANDS, v, (c) => c.label);
        acIndex = 0;
        renderAc();
        return;
    }

    // `/new <dir>`: directory typeahead for choosing a thread's working dir.
    // The arg is the last token, so complete from just after "/new " to caret.
    const dm = v.match(/^(\/new\s+)(.*)$/s);
    if (dm) {
        acMode = "dir";
        acAtStart = dm[1].length;
        acAtEnd = v.length;
        showDirAc(dm[2]); // async; guarded by acReq
        return;
    }

    // `@file` mention: complete the token under the caret (mid-line is fine)
    const tok = atTokenBeforeCaret(v, caret);
    if (tok) {
        acMode = "file";
        acAtStart = tok.start;
        acAtEnd = tok.end;
        showFileAc(tok.query); // async; guarded by acReq
        return;
    }

    closeAc();
}

function acceptAc(run) {
    const it = acItems[acIndex];
    if (!it) return;

    // File mentions splice into the `@token` span and keep editing — never
    // submit — so you can attach several files in one message.
    if (acMode === "file") {
        const v = $prompt.value;
        const before = v.slice(0, acAtStart);
        const after = v.slice(acAtEnd);
        const insert = it.value + " ";
        $prompt.value = before + insert + after;
        const pos = before.length + insert.length;
        closeAc();
        $prompt.focus();
        $prompt.setSelectionRange(pos, pos);
        autoGrow();
        return;
    }

    // Directory completion for `/new <dir>`: Enter creates a thread in the
    // selected dir; Tab drills into it (appends `/`) so you can keep navigating.
    if (acMode === "dir") {
        const v = $prompt.value;
        const before = v.slice(0, acAtStart); // "/new "
        if (run) {
            closeAc();
            $prompt.value = "";
            runInput(before + it.value);
            return;
        }
        const insert = it.value + "/";
        $prompt.value = before + insert;
        const pos = before.length + insert.length;
        closeAc();
        $prompt.focus();
        $prompt.setSelectionRange(pos, pos);
        autoGrow();
        updateAc(); // re-trigger to list the children of the drilled dir
        return;
    }

    closeAc();
    if (run) {
        $prompt.value = "";
        runInput(it.value);
    } else {
        $prompt.value = it.value;
        $prompt.focus();
    }
    autoGrow();
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

// Create a fresh thread, then navigate to it (URL + SSE re-point). An optional
// `dir` starts the thread in another working directory — the web UI analogue
// of `cd` (pi binds cwd at session creation, so a new thread is the honest way
// to change directory).
function newThread(dir = "") {
    post("/threads", dir ? { cwd: dir } : {})
        .then((r) => r.json())
        .then((d) => {
            if (d?.id) gotoThread(d.id);
            else notice(d?.error || "could not create thread");
        })
        .catch(() => notice("could not create thread"));
}

// returns true if handled as a client command
function runCommand(cmd, arg) {
    switch (cmd) {
        case "/resume":
            openPicker();
            return true;
        case "/new":
            // /new <dir> starts a thread there (the prompt offers a directory
            // typeahead as you type); bare /new starts one in the current cwd.
            newThread(arg || cwd);
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
        ["↑ / ↓", "browse prompt history (at the draft's top / bottom line)"],
        ["Tab", "complete selected command"],
        ["Esc", "dismiss menu / overlay · interrupt the working agent"],
        ["Alt+T", "show / hide thinking blocks"],
        ["Shift+Tab", "cycle thinking level"],
        ["/resume", "switch threads"],
        ["/new", "new thread — /new [dir] (prompts for a directory)"],
    ];
    wrap.innerHTML = keys
        .map(
            ([k, d]) =>
                `<div style="display:flex;gap:12px;padding:3px 0"><b style="color:var(--acc);min-width:90px">${k}</b><span>${d}</span></div>`,
        )
        .join("");
    showOverlay("Keyboard shortcuts", wrap);
}

// Auto-grow the textarea to fit its content, up to a sensible cap (after which
// it scrolls internally).
function autoGrow() {
    if (!$prompt) return;
    $prompt.style.height = "auto";
    $prompt.style.height = Math.min($prompt.scrollHeight, 200) + "px";
}

$prompt.addEventListener("input", () => {
    histIndex = null; // typing over a recalled entry makes it the new draft
    autoGrow();
    updateAc();
    applyThinkingBorder(); // live `!` bash-mode border toggle
});
$prompt.addEventListener("keydown", (e) => {
    // Shift+Tab cycles the reasoning level (mirrors the pi TUI). It's a browser
    // focus-traversal key, so preventDefault to keep focus in the composer.
    if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        postThread("/thinking-level", { op: "cycle" });
        return;
    }
    if ($ac.classList.contains("show")) {
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
                // In file mode, Enter accepts the suggestion (and keeps
                // editing); in command mode it accepts + runs.
                e.preventDefault();
                acceptAc(acMode !== "file");
                break;
            case "Escape":
                e.preventDefault();
                closeAc();
                break;
        }
        return;
    }
    // No typeahead open: Up/Down browse input history (mirrors the pi TUI),
    // falling through to normal caret movement when not at a draft boundary.
    if (e.key === "ArrowUp" && tryHistoryUp()) {
        e.preventDefault();
        return;
    }
    if (e.key === "ArrowDown" && tryHistoryDown()) {
        e.preventDefault();
        return;
    }
    // No typeahead open: Enter sends, Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if ($ask.requestSubmit) $ask.requestSubmit();
        else $ask.dispatchEvent(new Event("submit", { cancelable: true }));
    }
});

// Alt+T toggles thinking-block visibility (persisted to pi's settings). Alt+T
// is not browser-reserved (unlike Ctrl+T), so preventDefault reliably works.
document.addEventListener("keydown", (e) => {
    // Use e.code (physical key): under Option/Alt some layouts remap e.key to a
    // diacritic (macOS Alt+T -> "†"), so e.key === "t" would never match.
    if (e.code === "KeyT" && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleThinking();
    }
});

// Alt+O expands/collapses the most recent tool result (the web analogue of
// pi-tui's "ctrl+o more"; Ctrl+O is reserved by the browser for "open file",
// so Alt+O is used, mirroring the Alt+T thinking toggle).
document.addEventListener("keydown", (e) => {
    // e.code so Option/Alt remaps (macOS Alt+O -> "ø") don't break the match.
    if (e.code === "KeyO" && e.altKey && !e.ctrlKey && !e.metaKey) {
        if (!lastToolEntry) return;
        e.preventDefault();
        lastToolEntry.info.expanded = !lastToolEntry.info.expanded;
        renderToolCard(lastToolEntry, false);
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
    histIndex = null; // leave history-browse on send
    histDraft = "";
    autoGrow();
    applyThinkingBorder(); // clear any `!` bash-mode border
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
        case "config":
            // working directory, so tool cards can show cwd-relative paths
            if (typeof m.cwd === "string") {
                cwd = m.cwd;
                updateTitle(); // surface the cwd in the tab + header titles
            }
            break;
        case "welcome":
            // startup / reload intro: version banner + loaded resources
            welcomeInfo = {
                version: m.version || "",
                sections: m.sections || [],
            };
            renderWelcome();
            break;
        case "theme":
            // apply the active pi theme palette to the web UI CSS variables
            if (m.vars)
                for (const [k, v] of Object.entries(m.vars))
                    document.documentElement.style.setProperty(k, String(v));
            break;
        case "surfaces":
            renderSurfaces(m.surfaces);
            break;
        case "notify":
            toast(m.message, m.level);
            break;
        case "title":
            // extension-driven page (tab) title; "" restores the default
            setPageTitle(m.text);
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
            promptHistory = []; // input history is per-thread
            histIndex = null;
            histDraft = "";
            renderWelcome(); // re-pin the banner as the first transcript entry
            assistantEl = null;
            thinkingEl = null;
            toolEls = {};
            lastToolEntry = null;
            setWorking(false);
            break;
        case "thinking_level":
            thinkingLevel = m.level || "off";
            thinkingSupported = !!m.supported;
            applyThinkingBorder();
            break;
        case "thinking_visibility":
            setThinkingHidden(!!m.hidden, false);
            break;
        case "user":
            bubble("user", m.text);
            pushHistory(m.text); // seed/extend per-thread input history
            histIndex = null;
            assistantEl = null;
            thinkingEl = null;
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
        case "thinking":
            if (m.status === "full") {
                // non-streamed (replay / cached): render in one shot
                const el = thinkingBubble();
                renderThinking(el, m.text || "");
                thinkingEl = null;
            } else if (m.status === "start") {
                thinkingEl = thinkingBubble();
                thinkingRaw = "";
            } else if (m.status === "delta") {
                if (!thinkingEl) {
                    thinkingEl = thinkingBubble();
                    thinkingRaw = "";
                }
                thinkingRaw += m.text;
                scheduleThinkingRender();
            } else if (m.status === "end") {
                if (thinkingEl) renderThinking(thinkingEl, thinkingRaw);
                thinkingEl = null;
                thinkingRaw = "";
            }
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
        case "tool":
            applyToolFrame(m);
            break;
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

// On first load: if the URL names a thread, open it; otherwise start a *fresh*
// thread (don't resume the most recent session) and canonicalize the URL.
if (activeThreadId) {
    reopenStream();
} else {
    post("/threads", {})
        .then((r) => r.json())
        .then((d) => {
            if (d?.id) {
                activeThreadId = d.id;
                history.replaceState(
                    { thread: d.id },
                    "",
                    "?thread=" + encodeURIComponent(d.id),
                );
            }
        })
        .catch(() => {})
        .finally(() => reopenStream());
}
