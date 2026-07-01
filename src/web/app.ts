// pi-web web client: transcript stream, extension panels, thread switching,
// and a fuzzy command typeahead (ported from pi-tui's fuzzy matcher).
import { fuzzyFilter } from "./fuzzy.ts";
import { renderMarkdown, highlightComposer } from "./markdown.ts";
import { registerToolRenderer, type ToolInfo } from "./tools.ts";
import { renderDiffHtml } from "./diff.ts";
import {
    keyHintsLine,
    sectionSummary,
    hasResources,
    type WelcomeInfo,
} from "./welcome.ts";
// NOTE: these modules are imported only for their side effect —
// registering the <pi-frame> / <pi-tool> / <pi-thinking> custom elements via
// customElements.define(). We reference their classes solely in type
// positions (`as PiFrame`, `: PiTool | null`), so a plain `import { PiTool }`
// gets elided as type-only by the bundler, which then tree-shakes the whole
// module and drops the registration — leaving createElement("pi-tool") as an
// inert element with no .apply() (tool cards silently fail to render). The
// explicit bare `import "./x.ts"` forces module evaluation; `import type`
// keeps the class names available for annotations.
import "./pi-frame.ts";
import "./pi-tool.ts";
import "./pi-thinking.ts";
import type {
    PiFrame,
    PiFrameActionDetail,
    PiFrameNotifyDetail,
} from "./pi-frame.ts";
import type { PiTool } from "./pi-tool.ts";
import type { PiThinking } from "./pi-thinking.ts";

// Expose the tool-renderer registry so client-side extensions can override how
// a tool's result is displayed (web counterpart to pi-tui's renderResult).
(window as any).piweb = Object.assign((window as any).piweb || {}, {
    registerToolRenderer,
});

// Render `edit` results as a colored diff, mirroring the pi TUI (which shows the
// diff in place of the tool-result text). The diff string is computed host-side
// by pi's `generateDiffString` and arrives in `details.diff`; while the tool is
// still pending (or on error) there's no diff, so we fall back to the default
// tool body by returning null.
registerToolRenderer("edit", (info: ToolInfo) => {
    const diff = info.details?.diff;
    if (typeof diff !== "string" || !diff) return null;
    const pre = document.createElement("pre");
    pre.className = "tool-body diff";
    pre.innerHTML = renderDiffHtml(diff);
    return pre;
});

const $transcript = document.getElementById("transcript");
const $dockLeft = document.getElementById("dock-left");
const $dockRight = document.getElementById("dock-right");
const $dockBottom = document.getElementById("dock-bottom");
const $dockFooter = document.getElementById("dock-footer");
const $overlayLayer = document.getElementById("overlay-layer");
const $toastLayer = document.getElementById("toast-layer");
const $statusbar = document.getElementById("statusbar");
const $contextbar = document.getElementById("contextbar");
const $status = document.getElementById("status");
const $threadTitle = document.getElementById("threadTitle");
const $overlay = document.getElementById("overlay");
const $picker = document.getElementById("picker");
const $prompt = document.getElementById("prompt") as HTMLTextAreaElement;
const $backdrop = document.getElementById("backdrop") as HTMLElement;

// Repaint the markdown-highlight backdrop behind the composer to mirror the
// textarea's current value (see .backdrop in index.html).
function syncHighlight() {
    if ($backdrop) $backdrop.innerHTML = highlightComposer($prompt.value);
}
// Keep the backdrop's scroll locked to the textarea once content overflows.
$prompt?.addEventListener("scroll", () => {
    if (!$backdrop) return;
    $backdrop.scrollTop = $prompt.scrollTop;
    $backdrop.scrollLeft = $prompt.scrollLeft;
});
const $ask = document.getElementById("ask") as HTMLFormElement;
const $ac = document.getElementById("ac");
const $working = document.getElementById("working");
const $queued = document.getElementById("queued");
const $attachments = document.getElementById("attachments");

// ---- pasted/attached images (Ctrl+V into the composer) --------------------
// Images pasted (or dropped) into the composer are held here as base64 until
// the message is sent, and shown as removable thumbnail chips below the input.
// Each entry: { data: base64 (no data: prefix), mimeType, url: data-URL }.
/** @type {{data:string; mimeType:string; url:string}[]} */
let pendingImages = [];
const MAX_IMAGE_DIM = 2000; // downscale large pastes (mirrors the pi CLI cap)

// Read a File as a data: URL.
function readAsDataURL(file): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(r.error);
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(file);
    });
}

// Decode a data-URL into an <img> so we can measure/resize it on a canvas.
function loadImageEl(url): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = url;
    });
}

// Turn a File into a pending-image record, downscaling to MAX_IMAGE_DIM on the
// longest edge when needed (keeps request payloads sane). Falls back to the
// original bytes if canvas processing fails.
async function fileToImage(file) {
    const url = await readAsDataURL(file);
    let outUrl = url;
    let mimeType = file.type || "image/png";
    try {
        const im = await loadImageEl(url);
        const longest = Math.max(im.width, im.height);
        const scale = longest > MAX_IMAGE_DIM ? MAX_IMAGE_DIM / longest : 1;
        if (scale < 1) {
            const c = document.createElement("canvas");
            c.width = Math.round(im.width * scale);
            c.height = Math.round(im.height * scale);
            c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
            outUrl = c.toDataURL("image/png");
            mimeType = "image/png";
        }
    } catch {
        /* keep the original bytes */
    }
    const comma = outUrl.indexOf(",");
    return { mimeType, data: outUrl.slice(comma + 1), url: outUrl };
}

// Ingest a pasted/dropped image file into the pending list.
async function addImageFile(file) {
    try {
        pendingImages.push(await fileToImage(file));
        renderAttachments();
    } catch {
        notice("could not read pasted image");
    }
}

// Paint the pending-image thumbnail chips below the composer.
function renderAttachments() {
    if (!$attachments) return;
    $attachments.innerHTML = "";
    if (!pendingImages.length) {
        $attachments.classList.remove("show");
        return;
    }
    pendingImages.forEach((img, i) => {
        const chip = document.createElement("div");
        chip.className = "attach-chip";
        const thumb = document.createElement("img");
        thumb.src = img.url;
        thumb.alt = "pasted image";
        const rm = document.createElement("button");
        rm.type = "button";
        rm.className = "attach-remove";
        rm.textContent = "\u00d7";
        rm.title = "Remove image";
        rm.addEventListener("click", () => {
            pendingImages.splice(i, 1);
            renderAttachments();
        });
        chip.append(thumb, rm);
        $attachments.appendChild(chip);
    });
    $attachments.classList.add("show");
}

// ---- steering queue (mirrors the pi TUI's pending-messages display) --------
// While a turn is in flight the host appends each submitted message to this
// thread's steering queue instead of starting a second turn. The authoritative
// list arrives on `queue` SSE frames; we render it above the composer and let
// the user pop the whole queue back into the composer to edit (click / Alt+Up),
// or interrupt-and-restore with Esc.
let queuedMessages: string[] = [];

// Paint the pending-queue rows above the composer.
function renderQueue() {
    if (!$queued) return;
    $queued.innerHTML = "";
    if (!queuedMessages.length) {
        $queued.classList.remove("show");
        return;
    }
    queuedMessages.forEach((text, i) => {
        const row = document.createElement("div");
        row.className = "queued-item";
        row.title = "Edit queued messages (Alt+\u2191)";
        const badge = document.createElement("span");
        badge.className = "queued-badge";
        badge.textContent = `↑${i + 1}`;
        const body = document.createElement("span");
        body.className = "queued-text";
        body.textContent = text.replace(/\s+/g, " ").trim();
        const hint = document.createElement("span");
        hint.className = "queued-hint";
        hint.textContent = "queued";
        row.append(badge, body, hint);
        // Clicking any row restores the whole queue to the composer to edit,
        // matching the TUI (dequeue restores all messages joined together).
        row.addEventListener("click", () => restoreQueue({ abort: false }));
        $queued.appendChild(row);
    });
    $queued.classList.add("show");
}

// Pop the queued messages back into the composer for editing. Clears the host
// queue and, when `abort`, interrupts the in-flight turn — mirroring the pi
// TUI's restoreQueuedMessagesToEditor({ abort }). Queued text is placed before
// the current draft (queued \n\n draft), matching pi's ordering.
async function restoreQueue({ abort }: { abort: boolean }) {
    if (!activeThreadId) return;
    let items = queuedMessages.slice();
    try {
        const r = await post("/dequeue", {
            threadId: activeThreadId,
            abort: !!abort,
        });
        const d = await r.json();
        if (Array.isArray(d?.items)) items = d.items;
    } catch {
        /* fall back to the last-known queue */
    }
    queuedMessages = [];
    renderQueue();
    if (!items.length) return;
    const draft = $prompt.value;
    const combined = [items.join("\n\n"), draft]
        .filter((t) => t.trim())
        .join("\n\n");
    $prompt.value = combined;
    histIndex = null;
    autoGrow();
    $prompt.focus();
    const at = $prompt.value.length;
    $prompt.setSelectionRange(at, at);
}

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
        value: "/model",
        label: "/model",
        description: "Switch the active model",
    },
    {
        value: "/session",
        label: "/session",
        description: "Show session info and stats",
    },
    {
        value: "/tree",
        label: "/tree",
        description: "Jump to an earlier point in the session and continue",
    },
    {
        value: "/fork",
        label: "/fork",
        description: "New thread branched from a previous user message",
    },
    {
        value: "/clone",
        label: "/clone",
        description: "Duplicate the current thread into a new one",
    },
    {
        value: "/import",
        label: "/import",
        description: "Import a session from a JSONL file — /import <file>",
    },
    {
        value: "/share",
        label: "/share",
        description: "Share the session as a private GitHub gist",
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

function bubble(role, text = "", images = []) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    el.innerHTML = `<div class="role">${role}</div><div class="body"></div>`;
    el.querySelector(".body").textContent = text;
    if (images && images.length) {
        const wrap = document.createElement("div");
        wrap.className = "msg-images";
        images.forEach((im) => {
            const img = document.createElement("img");
            img.className = "msg-image";
            img.src = im.url || `data:${im.mimeType};base64,${im.data}`;
            img.addEventListener("click", () => window.open(img.src, "_blank"));
            wrap.appendChild(img);
        });
        el.querySelector(".body").appendChild(wrap);
    }
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
// One <pi-tool> card per tool call (keyed by the `call-id` attribute). The
// element owns its own state, expand/collapse, and rendering (see ./pi-tool.ts);
// here we just create/look up the card and feed it SSE frames. The global alt+o
// toggle targets the last <pi-tool> in the transcript.
function toolCard(id: string): PiTool | null {
    return $transcript.querySelector(
        `pi-tool[call-id="${CSS.escape(id)}"]`,
    ) as PiTool | null;
}
function lastToolCard(): PiTool | null {
    const all = $transcript.querySelectorAll("pi-tool");
    return (all[all.length - 1] as PiTool) ?? null;
}
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

// Apply a `tool` SSE frame: create or look up the <pi-tool> card for this call
// id, feed it the frame, and auto-follow only if we were near the bottom (so we
// don't yank the view while the user reads back).
function applyToolFrame(m) {
    let el = toolCard(m.id);
    const follow = nearBottom();
    if (!el) {
        clearEmpty();
        el = document.createElement("pi-tool") as PiTool;
        el.callId = m.id;
        el.setAttribute("call-id", m.id);
        $transcript.appendChild(el);
    }
    el.apply(m, cwd);
    if (follow) $transcript.scrollTop = $transcript.scrollHeight;
}

// A streaming thinking/reasoning trace, owned by the <pi-thinking> custom
// element (see ./pi-thinking.ts): it holds its raw text, re-renders markdown
// internally (throttled to one paint per animation frame), and emits
// `pithinking-toggle` when its header is clicked. Here we just create/look up
// the element and feed it SSE `thinking` frames; the header toggle and
// follow-scroll are wired once via delegated listeners on $transcript.
function newThinking(): PiThinking {
    clearEmpty();
    const el = document.createElement("pi-thinking") as PiThinking;
    $transcript.appendChild(el);
    $transcript.scrollTop = $transcript.scrollHeight;
    return el;
}
function lastThinking(): PiThinking | null {
    const all = $transcript.querySelectorAll("pi-thinking");
    return (all[all.length - 1] as PiThinking) ?? null;
}
$transcript.addEventListener("pithinking-toggle", () => toggleThinking());
$transcript.addEventListener(
    "pithinking-render",
    () => ($transcript.scrollTop = $transcript.scrollHeight),
);

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
// Sandboxed custom HTML (the Frame node) is handled by the <pi-frame> custom
// element (./pi-frame.ts), which owns its iframe lifecycle and emits bubbling
// `piframe-action` / `piframe-notify` events. Those are routed to the host once,
// below (see the document-level listeners near `toast`).
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
            // arbitrary HTML/CSS/JS, isolated in a sandboxed <pi-frame>
            const frame = document.createElement("pi-frame") as PiFrame;
            frame.surfaceId = surfaceId;
            frame.frameHtml = node.html ?? "";
            if (node.height != null) frame.frameHeight = node.height;
            return frame;
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

// compact token formatting, mirroring the pi TUI footer's formatTokens
function fmtTokens(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + "k";
    if (n < 1000000) return Math.round(n / 1000) + "k";
    if (n < 10000000) return (n / 1000000).toFixed(1) + "M";
    return Math.round(n / 1000000) + "M";
}

/**
 * Render the default context bar from a `footer` frame, mirroring the pi TUI
 * FooterComponent: a pwd/session line and a token-stats / `<model> • thinking
 * <level>` line. @param {any} f
 */
function renderFooter(f) {
    if (!$contextbar) return;
    if (!f) {
        $contextbar.classList.remove("show");
        $contextbar.innerHTML = "";
        return;
    }
    $contextbar.innerHTML = "";

    // line 1: pwd  •  session
    const l1 = document.createElement("div");
    l1.className = "line";
    l1.textContent = f.session ? `${f.cwd}  •  ${f.session}` : f.cwd || "";

    // line 2: token stats (left) + context% + model•thinking (right)
    const l2 = document.createElement("div");
    l2.className = "line";
    const t = f.tokens || {};
    const stats = [];
    if (t.input) stats.push(`↑${fmtTokens(t.input)}`);
    if (t.output) stats.push(`↓${fmtTokens(t.output)}`);
    if (t.cacheRead) stats.push(`R${fmtTokens(t.cacheRead)}`);
    if (t.cacheWrite) stats.push(`W${fmtTokens(t.cacheWrite)}`);
    if (f.cost || f.sub)
        stats.push(`$${(f.cost || 0).toFixed(3)}${f.sub ? " (sub)" : ""}`);
    const left = document.createElement("span");
    left.textContent = stats.join(" ");

    const pct = f.context?.percent;
    const win = f.context?.window || 0;
    const auto = f.autoCompact ? " (auto)" : "";
    const ctx = document.createElement("span");
    ctx.textContent =
        (pct == null ? "?" : `${pct.toFixed(1)}%`) +
        `/${fmtTokens(win)}${auto}`;
    if (pct != null && pct > 90) ctx.className = "ctx-err";
    else if (pct != null && pct > 70) ctx.className = "ctx-warn";

    const right = document.createElement("span");
    right.className = "spacer";
    let r = f.model || "no-model";
    if (f.reasoning)
        r += f.level === "off" ? " • thinking off" : ` • ${f.level}`;
    right.textContent = r;

    l2.append(left, ctx, right);
    $contextbar.append(l1, l2);
    $contextbar.classList.add("show");
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
    // <pi-frame> elements are re-created on every surface render; each owns its
    // own message listener (added/removed via connected/disconnectedCallback),
    // so there's no central registry to reset here.
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

// Route events bubbling out of <pi-frame> sandboxed frames to the host: surface
// actions go to the active thread; notify() calls become toasts.
document.addEventListener("piframe-action", (e) => {
    const d = (e as CustomEvent<PiFrameActionDetail>).detail;
    postThread("/action", d);
});
document.addEventListener("piframe-notify", (e) => {
    const d = (e as CustomEvent<PiFrameNotifyDetail>).detail;
    toast(d.message, d.level);
});

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
    // Refresh both the browser tab and the in-page thread title bar, which now
    // mirrors the same override.
    updateTitle();
}

/**
 * Compute the browser-tab title. Mirrors the pi TUI's terminal title
 * (`π - <session> - <cwd>`): here `π web - <thread name> - <cwd>`, dropping the
 * session segment when the thread is unnamed and the cwd segment when unknown.
 */
function computePageTitle() {
    if (extPageTitle) return extPageTitle;
    const active = threadItems.find((t) => t.id === activeThreadId);
    const cwdBase = cwd ? cwd.replace(/\/+$/, "").split("/").pop() : "";
    const parts = [PAGE_TITLE_PREFIX];
    if (active?.name) parts.push(threadName(active));
    if (cwdBase) parts.push(cwdBase);
    return parts.join(" - ");
}

function applyPageTitle() {
    document.title = computePageTitle();
}

function updateTitle() {
    applyPageTitle();
    if (!$threadTitle) return;
    const active = threadItems.find((t) => t.id === activeThreadId);
    if (active) {
        const others = threadItems.filter(
            (t) => t.id !== active.id && t.running,
        ).length;
        // Show the same title as the browser tab (`π web - <name> - <cwd>`, or
        // an extension override), plus a hint when other threads run in back.
        $threadTitle.textContent =
            computePageTitle() +
            (others ? `  (${others} running in background)` : "");
        $threadTitle.title = active.cwd || cwd || "";
    } else {
        $threadTitle.innerHTML = '<span class="hint">(no thread)</span>';
    }
}

// Selectable rows in the resume picker, in visual order, for keyboard nav.
// `pickerNav` gates the arrow/Enter handling so the generic showOverlay()
// dialog (which reuses #picker) isn't affected.
let pickerItems = [];
let pickerIndex = -1;
let pickerNav = false;

function setPickerSel(i) {
    if (!pickerItems.length) return;
    pickerIndex = (i + pickerItems.length) % pickerItems.length;
    pickerItems.forEach((el, idx) =>
        el.classList.toggle("sel", idx === pickerIndex),
    );
    pickerItems[pickerIndex].scrollIntoView({ block: "nearest" });
}

function openPicker() {
    if (!$overlay) return;
    $picker.innerHTML = "<h3>Resume thread</h3>";
    pickerItems = [];
    pickerNav = true;

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
    pickerItems.push($picker.lastElementChild);

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
            pickerItems.push(item);
        }
    }
    // Preselect the active thread (else the first row) so Enter has a target.
    const activeIdx = pickerItems.findIndex((el) =>
        el.classList.contains("active"),
    );
    setPickerSel(activeIdx >= 0 ? activeIdx : 0);
    // Blur the composer so its Up/Down history-browse handler doesn't compete
    // with the picker's arrow-key navigation while the modal is open.
    $prompt?.blur();
    $overlay.classList.add("show");
}

function closePicker() {
    const wasNav = pickerNav || modelNav;
    $overlay?.classList.remove("show");
    pickerNav = false;
    pickerItems = [];
    pickerIndex = -1;
    modelNav = false;
    modelRows = [];
    if (wasNav) $prompt?.focus(); // return focus to the composer
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
    pickerNav = false;
    $picker.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = title;
    const body = document.createElement("div");
    body.style.padding = "12px 14px";
    body.appendChild(contentEl);
    $picker.append(h, body);
    $overlay.classList.add("show");
}

function runInput(text, images = []) {
    text = (text ?? "").trim();
    if (!text && !images.length) return;
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
    postThread("/prompt", {
        text,
        images: images.length ? images : undefined,
    });
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
        case "/model":
            openModelPicker(arg);
            return true;
        case "/session":
            showSessionInfo();
            return true;
        case "/tree":
            openTreePicker();
            return true;
        case "/fork":
            openForkPicker();
            return true;
        case "/clone":
            doClone();
            return true;
        case "/import":
            doImport(arg);
            return true;
        case "/share":
            doShare();
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

// Append `?thread=<id>` to a GET path so a read-only endpoint resolves the
// thread the client is currently viewing (the POST helpers use postThread).
function withThread(path) {
    return (
        path +
        (activeThreadId ? "?thread=" + encodeURIComponent(activeThreadId) : "")
    );
}

// Generic single-column selector that reuses the resume-picker chrome and its
// shared keyboard navigation (Up/Down/Enter/Home/End via the pickerNav
// listener). `rows` is ordered; each is { name, meta?, cls?, title?, onClick }.
function openListPicker(title, rows, selectIndex = 0) {
    if (!$overlay) return;
    $picker.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = title;
    $picker.appendChild(h);
    pickerItems = [];
    pickerNav = true;
    if (!rows.length) {
        const empty = document.createElement("div");
        empty.className = "item";
        empty.innerHTML = '<span class="name hint">nothing here</span>';
        $picker.appendChild(empty);
    }
    for (const row of rows) {
        const item = document.createElement("div");
        item.className = "item" + (row.cls ? ` ${row.cls}` : "");
        const n = document.createElement("span");
        n.className = "name";
        n.textContent = row.name;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = row.meta || "";
        item.append(n, meta);
        if (row.title) item.title = row.title;
        item.onclick = () => {
            closePicker();
            row.onClick();
        };
        $picker.appendChild(item);
        pickerItems.push(item);
    }
    if (pickerItems.length)
        setPickerSel(
            Math.max(0, Math.min(selectIndex, pickerItems.length - 1)),
        );
    $prompt?.blur(); // don't let the composer's history keys fight the picker
    $overlay.classList.add("show");
}

// ---- /tree: jump to an earlier point in the session ----------------------
async function openTreePicker() {
    const data = await getJson(withThread("/tree"));
    const entries = data?.entries || [];
    if (!entries.length) {
        notice("no earlier points to jump to");
        return;
    }
    const rows = entries.map((e) => {
        const indent = "  ".repeat(Math.min(e.depth || 0, 6));
        const role =
            e.role === "user"
                ? "▸ you"
                : e.role === "assistant"
                  ? "· pi"
                  : e.role === "label"
                    ? "⚑"
                    : String(e.role);
        return {
            name: `${indent}${role}${e.current ? "  (current)" : ""}`,
            meta: e.label ? `${e.label} — ${e.text}` : e.text,
            cls: e.current ? "active" : "",
            onClick: () => navigateTree(e.id),
        };
    });
    const curIdx = entries.findIndex((e) => e.current);
    openListPicker(
        "Jump to a point in the session",
        rows,
        curIdx >= 0 ? curIdx : rows.length - 1,
    );
}

async function navigateTree(entryId) {
    const r = await (await postThread("/tree/navigate", { entryId })).json();
    if (r?.error) notice("navigate failed: " + r.error);
    else if (r?.cancelled) notice("navigation cancelled");
    else {
        notice("jumped to selected point");
        // pi hands back the user message at the branch point so you can edit and
        // resend it; drop it into an empty composer (never clobber a draft).
        if (r?.editorText && $prompt && !$prompt.value.trim()) {
            $prompt.value = r.editorText;
            autoGrow();
        }
    }
}

// ---- /fork: new thread from a previous user message ----------------------
async function openForkPicker() {
    const data = await getJson(withThread("/fork-messages"));
    const items = data?.items || [];
    if (!items.length) {
        notice("no messages to fork from");
        return;
    }
    const rows = items.map((m) => ({
        name: m.text || "(empty message)",
        meta: "",
        onClick: () => forkFrom(m.id),
    }));
    // preselect the most recent user message (matches the pi TUI default)
    openListPicker("Fork from a message", rows, rows.length - 1);
}

async function forkFrom(entryId) {
    const r = await (await postThread("/threads/fork", { entryId })).json();
    if (r?.id) gotoThread(r.id);
    else notice("fork failed" + (r?.error ? ": " + r.error : ""));
}

// ---- /clone: duplicate the current thread --------------------------------
async function doClone() {
    const r = await (await postThread("/threads/clone", {})).json();
    if (r?.id) gotoThread(r.id);
    else notice("clone failed" + (r?.error ? ": " + r.error : ""));
}

// ---- /import <file>: resume a session from a JSONL file ------------------
async function doImport(file) {
    const path = (file || "").trim();
    if (!path) {
        notice("usage: /import <file.jsonl>");
        return;
    }
    const r = await (await postThread("/threads/import", { path })).json();
    if (r?.id) gotoThread(r.id);
    else notice("import failed" + (r?.error ? ": " + r.error : ""));
}

// ---- /share: upload as a private gist ------------------------------------
async function doShare() {
    notice("creating private gist…");
    const r = await (await postThread("/session/share", {})).json();
    if (r?.viewerUrl) {
        notice("shared → " + r.viewerUrl);
        navigator.clipboard?.writeText(r.viewerUrl).catch(() => {});
    } else {
        notice("share failed" + (r?.error ? ": " + r.error : ""));
    }
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

// ---- /model picker -------------------------------------------------------
// A searchable model picker mirroring the pi TUI's /model selector: a search
// box plus a keyboard-navigable list (the active model is marked, subscription
// models tagged). Selecting one POSTs /model; the host switches the thread's
// model and re-broadcasts the footer + thinking-level frames.
let modelList: any[] = []; // all models from /models
let modelRows: HTMLElement[] = []; // rendered rows (filtered)
let modelFiltered: any[] = []; // data behind modelRows
let modelIndex = 0;
let modelNav = false; // gates the model picker's key handling

function modelMeta(m) {
    const parts = [];
    if (m.contextWindow) parts.push(`${fmtTokens(m.contextWindow)} ctx`);
    if (m.reasoning) parts.push("thinking");
    if (m.sub) parts.push("subscription");
    return parts.join(" · ");
}

// Fuzzy-search text mirroring the TUI's getModelSelectorSearchText (provider
// first so provider-prefixed queries rank ahead of proxy-provider ids).
function modelSearchText(m) {
    const name = m.name ? ` ${m.name}` : "";
    return `${m.provider} ${m.provider}/${m.id} ${m.provider} ${m.id}${name}`;
}

function setModelSel(i) {
    if (!modelRows.length) return;
    modelIndex = (i + modelRows.length) % modelRows.length;
    modelRows.forEach((el, idx) =>
        el.classList.toggle("sel", idx === modelIndex),
    );
    modelRows[modelIndex].scrollIntoView({ block: "nearest" });
}

function renderModelList(container, query) {
    const ranked = query
        ? fuzzyFilter(modelList, query, (m) => modelSearchText(m))
        : modelList;
    modelFiltered = ranked;
    modelRows = [];
    container.innerHTML = "";
    if (!ranked.length) {
        const empty = document.createElement("div");
        empty.className = "item";
        empty.innerHTML = '<span class="name hint">no matching models</span>';
        container.appendChild(empty);
        return;
    }
    ranked.forEach((m, i) => {
        const item = document.createElement("div");
        item.className = "item" + (m.current ? " active" : "");
        const n = document.createElement("span");
        n.className = "name";
        n.textContent = `${m.provider}/${m.id}`;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = modelMeta(m);
        item.append(n, meta);
        item.onclick = () => chooseModel(m);
        container.appendChild(item);
        modelRows.push(item);
    });
    // preselect the active model, else the first row
    const activeIdx = ranked.findIndex((m) => m.current);
    setModelSel(activeIdx >= 0 ? activeIdx : 0);
}

async function chooseModel(m) {
    closePicker();
    const r = await (
        await postThread("/model", { provider: m.provider, id: m.id })
    ).json();
    if (r?.error) notice("model switch failed: " + r.error);
}

async function openModelPicker(query = "") {
    if (!$overlay) return;
    const data = await getJson(
        "/models" +
            (activeThreadId
                ? "?thread=" + encodeURIComponent(activeThreadId)
                : ""),
    );
    modelList = data?.items || [];
    pickerNav = false; // this picker runs its own key handling
    modelNav = true;
    modelIndex = 0;

    $picker.innerHTML = "";
    const h = document.createElement("h3");
    h.textContent = "Select model";
    const search = document.createElement("input");
    search.type = "text";
    search.className = "model-search";
    search.placeholder = "search models…";
    search.value = query;
    const list = document.createElement("div");
    list.className = "model-list";
    $picker.append(h, search, list);

    renderModelList(list, query);
    search.addEventListener("input", () => renderModelList(list, search.value));
    search.addEventListener("keydown", (e) => {
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                setModelSel(modelIndex + 1);
                break;
            case "ArrowUp":
                e.preventDefault();
                setModelSel(modelIndex - 1);
                break;
            case "Enter": {
                e.preventDefault();
                const m = modelFiltered[modelIndex];
                if (m) chooseModel(m);
                break;
            }
            case "Escape":
                e.preventDefault();
                closePicker();
                break;
        }
    });

    $overlay.classList.add("show");
    search.focus();
}

function showHotkeys() {
    const wrap = document.createElement("div");
    const keys = [
        ["Enter", "send message / run selected command"],
        ["/", "open command typeahead"],
        ["↑ / ↓", "move through command suggestions"],
        ["↑ / ↓", "browse prompt history (at the draft's top / bottom line)"],
        ["Tab", "complete selected command"],
        [
            "Esc",
            "dismiss menu / overlay · interrupt the working agent (restores queued messages)",
        ],
        ["Alt+↑", "restore queued messages to the composer to edit"],
        ["Alt+T", "show / hide thinking blocks"],
        ["Shift+Tab", "cycle thinking level"],
        ["/resume", "switch threads"],
        ["/new", "new thread — /new [dir] (prompts for a directory)"],
        ["/model", "switch the active model"],
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
    // autoGrow() runs after every value change (typing, history recall,
    // autocomplete insert, clear), so repaint the highlight backdrop here too.
    syncHighlight();
    if ($backdrop) $backdrop.scrollTop = $prompt.scrollTop;
}

$prompt.addEventListener("input", () => {
    histIndex = null; // typing over a recalled entry makes it the new draft
    autoGrow();
    updateAc();
    applyThinkingBorder(); // live `!` bash-mode border toggle
});

// Ctrl/Cmd+V of an image (screenshot, copied file) attaches it to the message
// rather than pasting garbage text. Plain-text pastes fall through untouched.
$prompt.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items)
        if (it.kind === "file" && it.type.startsWith("image/")) {
            const f = it.getAsFile();
            if (f) files.push(f);
        }
    if (!files.length) return; // no image → let the normal text paste happen
    e.preventDefault();
    files.forEach(addImageFile);
});

// Drag-and-drop images onto the composer, same plumbing as paste.
$prompt.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
$prompt.addEventListener("drop", (e) => {
    const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
        f.type.startsWith("image/"),
    );
    if (!files.length) return;
    e.preventDefault();
    files.forEach(addImageFile);
});
$prompt.addEventListener("keydown", (e) => {
    // Shift+Tab cycles the reasoning level (mirrors the pi TUI). It's a browser
    // focus-traversal key, so preventDefault to keep focus in the composer.
    if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        postThread("/thinking-level", { op: "cycle" });
        return;
    }
    // Alt+Up restores queued (steering/follow-up) messages back into the
    // composer to edit, without interrupting the turn (mirrors the pi TUI's
    // app.message.dequeue = alt+up). Esc is the interrupt-and-restore variant.
    if (e.key === "ArrowUp" && e.altKey && queuedMessages.length) {
        e.preventDefault();
        restoreQueue({ abort: false });
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
        const el = lastToolCard();
        if (!el) return;
        e.preventDefault();
        el.toggleExpanded();
    }
});

// Resume picker keyboard nav: Up/Down move the selection, Enter activates the
// highlighted row, Home/End jump to the ends. Escape is handled below.
document.addEventListener("keydown", (e) => {
    if (!pickerNav || !$overlay?.classList.contains("show")) return;
    // Ignore the very keystroke that opened the picker (e.g. the Enter that
    // submitted `/resume`), which calls preventDefault() before bubbling here.
    if (e.defaultPrevented) return;
    switch (e.key) {
        case "ArrowDown":
            e.preventDefault();
            setPickerSel(pickerIndex + 1);
            break;
        case "ArrowUp":
            e.preventDefault();
            setPickerSel(pickerIndex - 1);
            break;
        case "Home":
            e.preventDefault();
            setPickerSel(0);
            break;
        case "End":
            e.preventDefault();
            setPickerSel(pickerItems.length - 1);
            break;
        case "Enter":
            e.preventDefault();
            pickerItems[pickerIndex]?.click();
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
        // agent is working → mirror the pi TUI's Esc: restore any queued
        // (steering/follow-up) messages back into the composer *and* interrupt
        // this thread's turn (restoreQueuedMessagesToEditor({ abort: true })).
        restoreQueue({ abort: true });
    } else if (queuedMessages.length) {
        // not working but messages are still queued → restore them to edit
        restoreQueue({ abort: false });
    }
});

$ask.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $prompt.value;
    const images = pendingImages.map(({ data, mimeType }) => ({
        data,
        mimeType,
    }));
    $prompt.value = "";
    pendingImages = [];
    renderAttachments();
    histIndex = null; // leave history-browse on send
    histDraft = "";
    autoGrow();
    applyThinkingBorder(); // clear any `!` bash-mode border
    closeAc();
    runInput(text, images);
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
        $status.textContent = "● connected";
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
        case "footer":
            // default below-composer context bar (pwd/session + tokens + model)
            renderFooter(m);
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
        case "queue":
            // pending steering/follow-up messages waiting for delivery
            queuedMessages = Array.isArray(m.items) ? m.items : [];
            renderQueue();
            break;
        case "transcript_reset":
            $transcript.innerHTML = '<div class="empty">new thread</div>';
            promptHistory = []; // input history is per-thread
            histIndex = null;
            histDraft = "";
            queuedMessages = []; // steering queue is per-thread
            renderQueue();
            renderWelcome(); // re-pin the banner as the first transcript entry
            assistantEl = null;
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
            bubble("user", m.text, m.images);
            pushHistory(m.text); // seed/extend per-thread input history
            histIndex = null;
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
        case "thinking":
            // `start`/`full` begin a fresh block; `delta`/`end` feed the
            // current one (the element owns its raw text + throttled render).
            if (m.status === "start" || m.status === "full") {
                newThinking().apply(m);
            } else {
                (lastThinking() ?? newThinking()).apply(m);
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
