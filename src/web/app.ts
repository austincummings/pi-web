// pi-web web client: transcript stream, extension panels, thread switching,
// and a fuzzy command typeahead (ported from pi-tui's fuzzy matcher).
import { fuzzyFilter } from "./fuzzy.ts";
import { renderMarkdown } from "./markdown.ts";
import { registerToolRenderer, type ToolInfo } from "./tools.ts";
import { renderDiffHtml } from "./diff.ts";
import { renderStaticNode } from "./nodes.ts";
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
import { setThinkingLabel } from "./pi-thinking.ts";
import "./pi-bash.ts";
import "./pi-composer.ts";
import type { PiComposer } from "./pi-composer.ts";
import type {
    PiFrame,
    PiFrameActionDetail,
    PiFrameNotifyDetail,
} from "./pi-frame.ts";
import type { PiTool } from "./pi-tool.ts";
import type { PiThinking } from "./pi-thinking.ts";
import type { PiBash } from "./pi-bash.ts";

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

const $transcript = document.getElementById("transcript")!;
const $dockAboveEditor = document.getElementById("dock-above-editor")!;
const $dockBelowEditor = document.getElementById("dock-below-editor")!;
const $overlayLayer = document.getElementById("overlay-layer")!;
const $toastLayer = document.getElementById("toast-layer")!;
const $statusbar = document.getElementById("statusbar")!;
const $contextbar = document.getElementById("contextbar")!;
const $status = document.getElementById("status")!;
const $threadTitle = document.getElementById("threadTitle")!;
const $overlay = document.getElementById("overlay")!;
const $picker = document.getElementById("picker")!;
const $dialog = document.getElementById("dialog")!;
const $dialogCard = document.getElementById("dialog-card")!;
// The composer is the <pi-composer> custom element; the side-effect import
// above upgraded the in-DOM element synchronously, so its #prompt / #ac /
// #backdrop / … children already exist. It owns submit / history / queue /
// images / working; app.ts drives it via methods and reacts to its pi-* events.
const composer = document.getElementById("composer") as PiComposer;
const $prompt = document.getElementById("prompt") as HTMLTextAreaElement;
const $ac = document.getElementById("ac")!;

// Legacy shim: <pi-composer> owns the highlight backdrop + autosize now, but a
// few command / autocomplete flows still set the textarea value directly —
// reflow() repaints + resizes without disturbing the caret.
function syncHighlight() {
    composer.reflow();
}

// ---- pasted/attached images (Ctrl+V into the composer) --------------------
// Images pasted (or dropped) into the composer are held here as base64 until
// the message is sent, and shown as removable thumbnail chips below the input.
// Each entry: { data: base64 (no data: prefix), mimeType, url: data-URL }.
const MAX_IMAGE_DIM = 2000; // downscale large pastes (mirrors the pi CLI cap)

// Read a File as a data: URL.
function readAsDataURL(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(r.error);
        r.onload = () => resolve(String(r.result));
        r.readAsDataURL(file);
    });
}

// Decode a data-URL into an <img> so we can measure/resize it on a canvas.
function loadImageEl(url: string): Promise<HTMLImageElement> {
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
async function fileToImage(file: File) {
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
            c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
            outUrl = c.toDataURL("image/png");
            mimeType = "image/png";
        }
    } catch {
        /* keep the original bytes */
    }
    const comma = outUrl.indexOf(",");
    return { mimeType, data: outUrl.slice(comma + 1), url: outUrl };
}

// Ingest a pasted/dropped image file, downscale it, and hand it to the composer
// (which owns the pending-attachment chips).
async function addImageFile(file: File) {
    try {
        composer.addImage(await fileToImage(file));
    } catch {
        notice("could not read pasted image");
    }
}

// ---- steering queue (mirrors the pi TUI's pending-messages display) --------
// While a turn is in flight the host appends each submitted message to this
// thread's steering queue instead of starting a second turn. The authoritative
// list arrives on `queue` SSE frames; we render it above the composer and let
// the user pop the whole queue back into the composer to edit (click / Alt+Up),
// or interrupt-and-restore with Esc.
let queuedMessages: string[] = [];

// The <pi-composer> element paints the steering-queue rows; this shim keeps the
// call sites (SSE `queue`, restoreQueue) unchanged.
function renderQueue() {
    composer.setQueue(queuedMessages);
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
    autoGrow();
    $prompt.focus();
    const at = $prompt.value.length;
    $prompt.setSelectionRange(at, at);
}

// ---- "Working" spinner ----------------------------------------------------
// <pi-composer> owns the spinner + pi ui.setWorking* overrides; these thin
// wrappers forward the SSE `working` / `working_config` frames to it and keep a
// plain `working` flag so the Esc precedence knows the agent is streaming.
let working = false;
function setWorking(on: boolean) {
    working = on;
    composer.setWorking(on);
}
function setWorkingConfig(cfg: {
    message?: string;
    visible?: boolean;
    frames?: string[];
    intervalMs?: number;
}) {
    composer.setWorkingConfig(cfg || {});
}

let assistantEl: HTMLElement | null = null; // current streaming assistant bubble
let bashEl: PiBash | null = null; // current streaming bash output block
let thinkingHidden = false; // mirrors pi's "hide thinking blocks" setting
let thinkingLevel = "off"; // per-session reasoning level (focused border color)
let thinkingSupported = false; // does the active model support cycling levels?
let assistantRaw = ""; // accumulated assistant text (rendered as markdown)
let threadItems: any[] = []; // last known thread list (from SSE)
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
        value: "/trust",
        label: "/trust",
        description: "Set project trust for this folder",
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

function bubble(role: string, text = "", images: any[] = []) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = `msg ${role}`;
    // No role label for user/assistant turns — matches the TUI, which sets user
    // turns apart with the userMessageBg wash and renders assistant turns as
    // plain markdown. (custom messages render their own label elsewhere.)
    el.innerHTML = `<div class="body"></div>`;
    el.querySelector(".body")!.textContent = text;
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
        el.querySelector(".body")!.appendChild(wrap);
    }
    $transcript.appendChild(el);
    followBottom();
    return el;
}

function bashBubble(command: string, excluded: boolean): PiBash {
    clearEmpty();
    const el = document.createElement("pi-bash") as PiBash;
    el.apply({ status: "start", command, excludeFromContext: excluded });
    $transcript.appendChild(el);
    followBottom();
    return el;
}

function renderAssistant(el: HTMLElement, text: string) {
    el.querySelector(".body")!.innerHTML = renderMarkdown(text);
    followBottom();
}

// Render an extension custom message (kind:"custom"). When the host ships a
// serialized component `tree` (from a registered message renderer), render it
// via renderNode; otherwise render the message's text as markdown. The
// customType is shown as the role label (mirrors the TUI's customMessageLabel).
function renderCustomMessage(m: any) {
    clearEmpty();
    const el = document.createElement("div");
    el.className = "msg custom";
    const role = document.createElement("div");
    role.className = "role";
    role.textContent = m.customType || "custom";
    const body = document.createElement("div");
    body.className = "body";
    if (m.tree) {
        // pi TUI parity: when a registered renderer supplies a component it
        // owns its styling, so don't paint the customMessageBg wash over it
        // (CustomMessageComponent.rebuild() returns before adding its
        // background box when a custom renderer is present).
        body.classList.add("bare");
        body.appendChild(renderNode(m.tree, null));
    } else body.innerHTML = renderMarkdown(m.text || "");
    el.append(role, body);
    $transcript.appendChild(el);
    followBottom();
    assistantEl = null;
    return el;
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

// Build the intro view's content (logo/version, key hints, loaded-resource
// sections, expand/collapse toggle) into `el` from the current welcomeInfo.
// `expanded` picks compact comma lists vs. one-per-line; `onToggle` fires on
// click so each caller can flip its own expanded state and re-render.
function fillWelcome(el: HTMLElement, expanded: boolean, onToggle: () => void) {
    const info = welcomeInfo;
    if (!info) return;
    el.classList.toggle("expanded", expanded);
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
            items.textContent = expanded
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
    toggle.textContent = expanded
        ? "collapse"
        : "show loaded resources (click)";
    el.appendChild(toggle);

    el.onclick = onToggle;
}

function renderWelcome() {
    let el = $transcript.querySelector(".welcome.pinned") as HTMLElement | null;
    if (!welcomeInfo) {
        if (el) el.remove();
        return;
    }
    if (!el) {
        el = document.createElement("div");
        el.className = "welcome pinned";
    }
    // keep the banner pinned as the first transcript entry
    if ($transcript.firstChild !== el) {
        $transcript.insertBefore(el, $transcript.firstChild);
    }
    fillWelcome(el, welcomeExpanded, () => {
        welcomeExpanded = !welcomeExpanded;
        renderWelcome();
    });
}

// Show the intro view inline at the bottom of the transcript. Used after
// /reload so the freshly loaded resources are visible in place, rather than
// only silently refreshed in the pinned banner up top (which the user has
// usually scrolled past). Each inline copy tracks its own expanded state.
function appendWelcome() {
    if (!welcomeInfo) return;
    clearEmpty();
    const el = document.createElement("div");
    el.className = "welcome inline";
    let expanded = false;
    const draw = () =>
        fillWelcome(el, expanded, () => {
            expanded = !expanded;
            draw();
        });
    draw();
    $transcript.appendChild(el);
    followBottom();
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

// Whether new output should snap the view to the bottom. We track this from the
// user's own scrolling (appending content doesn't fire a scroll event, so the
// flag keeps its value across DOM mutations) rather than sampling nearBottom()
// after we've already grown the transcript. Starts true so the first messages
// follow.
let stickToBottom = true;
$transcript.addEventListener(
    "scroll",
    () => {
        stickToBottom = nearBottom();
    },
    { passive: true },
);

// Snap to the bottom only if the user was already pinned there; if they've
// scrolled up to read history we leave their position untouched.
function followBottom() {
    if (stickToBottom) $transcript.scrollTop = $transcript.scrollHeight;
}

// Apply a `tool` SSE frame: create or look up the <pi-tool> card for this call
// id, feed it the frame, and auto-follow only if we were near the bottom (so we
// don't yank the view while the user reads back).
function applyToolFrame(m: any) {
    let el = toolCard(m.id);
    if (!el) {
        clearEmpty();
        el = document.createElement("pi-tool") as PiTool;
        el.callId = m.id;
        el.setAttribute("call-id", m.id);
        $transcript.appendChild(el);
    }
    el.apply(m, cwd);
    followBottom();
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
    followBottom();
    return el;
}
function lastThinking(): PiThinking | null {
    const all = $transcript.querySelectorAll("pi-thinking");
    return (all[all.length - 1] as PiThinking) ?? null;
}
$transcript.addEventListener("pithinking-toggle", () => toggleThinking());
$transcript.addEventListener("pithinking-render", () => followBottom());
// <pi-frame> iframes auto-size asynchronously (they boot at an 80px placeholder,
// then report their real height once loaded). followBottom() runs when we mount
// the frame — too early — so re-follow when a frame grows (e.g. /gdiff, /cat).
$transcript.addEventListener("piframe-resize", () => followBottom());

// Apply the hidden state to the DOM (CSS collapses .think-body). When `persist`
// is set, also write the new value back to pi's settings via the host.
function setThinkingHidden(hidden: boolean, persist: boolean) {
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
function applyThinkingBorder() {
    // <pi-composer> applies the reasoning-level border (data-think) and the `!`
    // bash-mode override (data-bash); leading whitespace is ignored for `!`.
    composer.setThinking(
        thinkingLevel || "off",
        composer.value.trimStart().startsWith("!"),
    );
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

function post(path: string, body: any) {
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
function postThread(path: string, body: any = {}) {
    return post(path, { ...body, threadId: activeThreadId });
}

// Navigate to a thread: push the URL and re-point the SSE stream. The host
// boots/resumes the thread on (re)connect and replays its transcript, so no
// separate "switch" round-trip is needed.
/** @param {string} id */
function gotoThread(id: string) {
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
function renderNode(node: any, surfaceId: string | null) {
    if (!node || typeof node !== "object")
        return document.createTextNode(String(node ?? ""));
    switch (node.type) {
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
            frame.surfaceId = surfaceId ?? "";
            frame.frameHtml = node.html ?? "";
            if (node.height != null) frame.frameHeight = node.height;
            return frame;
        }
        // Everything else (Box/Row/Text/Markdown/AnsiBlock/Spacer/Image, …) is
        // static; the shared renderer owns it. Container children recurse back
        // through renderNode so interactive nodes nested in a Box still work.
        default: {
            const el = renderStaticNode(node, (c) => renderNode(c, surfaceId));
            if (el) return el;
            const d = document.createElement("div");
            d.textContent = `[unknown node: ${node.type}]`;
            return d;
        }
    }
}

// ---- surfaces: docks (aboveEditor/belowEditor), overlays, status, toasts ----
let openOverlays: string[] = []; // ids of currently-open extension overlays

function surfaceCard(card: any) {
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

function renderDock(el: HTMLElement | null, cards: any[]) {
    if (!el) return;
    el.innerHTML = "";
    const has = cards && cards.length;
    el.classList.toggle("empty-dock", !has);
    for (const c of cards || []) el.appendChild(surfaceCard(c));
}

// Apply a few overlay option hints (anchor/size) to the modal card.
function applyOverlayOptions(card: HTMLElement, options: any) {
    if (!options) return;
    const sz = (v: any) => (typeof v === "number" ? `${v}px` : v);
    if (options.width != null) card.style.width = sz(options.width);
    if (options.maxHeight != null) card.style.maxHeight = sz(options.maxHeight);
    const a = options.anchor;
    if (a && a !== "center") {
        // map the 9 pi-tui anchors onto flex alignment of the overlay layer
        const [v, h] = (
            {
                "top-left": ["start", "start"],
                "top-center": ["start", "center"],
                "top-right": ["start", "end"],
                "left-center": ["center", "start"],
                "right-center": ["center", "end"],
                "bottom-left": ["end", "start"],
                "bottom-center": ["end", "center"],
                "bottom-right": ["end", "end"],
            } as Record<string, [string, string]>
        )[a] || ["center", "center"];
        $overlayLayer.style.alignItems = v;
        $overlayLayer.style.justifyContent = h;
    }
}

function renderOverlays(overlays: any[]) {
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
function fmtTokens(n: number) {
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
function renderFooter(f: any) {
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
    const stats: string[] = [];
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

function renderStatus(segments: any[]) {
    if (!$statusbar) return;
    $statusbar.innerHTML = "";
    const segs: any[] = segments || [];
    $statusbar.classList.toggle("show", segs.length > 0);
    // pi-tui setStatus segments are plain keyed text, rendered in key order.
    for (const s of segs) {
        const el = document.createElement("span");
        el.className = "seg";
        el.textContent = s.text;
        $statusbar.appendChild(el);
    }
}

function renderSurfaces(s: any) {
    // <pi-frame> elements are re-created on every surface render; each owns its
    // own message listener (added/removed via connected/disconnectedCallback),
    // so there's no central registry to reset here.
    const docks = s?.docks ?? { aboveEditor: [], belowEditor: [] };
    renderDock($dockAboveEditor, docks.aboveEditor);
    renderDock($dockBelowEditor, docks.belowEditor);
    renderOverlays(s?.overlays);
    renderStatus(s?.status);
    renderDialogs(s?.dialogs);
}

// Close the top extension overlay (Esc / backdrop). Server-driven: it toggles
// the surface's open flag and re-broadcasts.
function closeTopOverlay() {
    const id = openOverlays[openOverlays.length - 1];
    if (id) postThread("/surface", { op: "close", id });
}

// ---- blocking dialogs (select / confirm / input / editor) ----------------
// The host's `piweb.select/confirm/input/editor` open a modal here and await
// the answer; we POST /ui-response to unblock the extension. The open dialog
// travels in the surfaces snapshot, so a refresh replays it (see host
// piweb-host.ts requestUi).
/** @type {any} */
let activeDialog: any = null;
let dialogSel = 0; // highlighted option index (select dialogs)

// Send the browser's answer back to the awaiting extension. `value` is the
// chosen string / boolean / text, or null to cancel (host maps null ->
// undefined for select/input/editor, false for confirm).
function answerDialog(value: any) {
    if (!activeDialog) return;
    const id = activeDialog.id;
    activeDialog = null;
    postThread("/ui-response", { requestId: id, value });
}

function setDialogSel(i: number, rows: HTMLElement[]) {
    if (!rows.length) return;
    dialogSel = (i + rows.length) % rows.length;
    rows.forEach((el, idx) => el.classList.toggle("sel", idx === dialogSel));
    rows[dialogSel].scrollIntoView({ block: "nearest" });
}

// Build the modal DOM for one dialog spec and wire its submit/cancel paths.
function buildDialog(d: any) {
    $dialogCard.innerHTML = "";
    dialogSel = 0;
    const h = document.createElement("h3");
    h.textContent = d.title || "";
    $dialogCard.appendChild(h);
    const body = document.createElement("div");
    body.className = "dialog-body";
    $dialogCard.appendChild(body);

    if (d.dialog === "select") {
        const rows: HTMLElement[] = [];
        (d.options || []).forEach((opt: any, i: number) => {
            const row = document.createElement("div");
            row.className = "item";
            row.textContent = opt;
            row.onclick = () => answerDialog(opt);
            row.onmouseenter = () => setDialogSel(i, rows);
            body.appendChild(row);
            rows.push(row);
        });
        activeDialog.rows = rows;
        setDialogSel(0, rows);
    } else if (d.dialog === "confirm") {
        const msg = document.createElement("div");
        msg.className = "dialog-msg";
        msg.textContent = d.message || "";
        body.appendChild(msg);
        const btns = document.createElement("div");
        btns.className = "dialog-btns";
        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        cancel.onclick = () => answerDialog(false);
        const ok = document.createElement("button");
        ok.className = "primary";
        ok.textContent = "OK";
        ok.onclick = () => answerDialog(true);
        btns.append(cancel, ok);
        body.appendChild(btns);
        setTimeout(() => ok.focus(), 0);
    } else if (d.dialog === "input" || d.dialog === "editor") {
        const multiline = d.dialog === "editor";
        const field = document.createElement(
            multiline ? "textarea" : "input",
        ) as HTMLInputElement | HTMLTextAreaElement;
        field.className = "dialog-field";
        if (multiline) {
            (field as HTMLTextAreaElement).rows = 8;
            field.value = d.prefill || "";
        } else {
            (field as HTMLInputElement).type = "text";
            field.placeholder = d.placeholder || "";
        }
        body.appendChild(field);
        const btns = document.createElement("div");
        btns.className = "dialog-btns";
        const cancel = document.createElement("button");
        cancel.textContent = "Cancel";
        cancel.onclick = () => answerDialog(null);
        const ok = document.createElement("button");
        ok.className = "primary";
        ok.textContent = multiline ? "Save" : "OK";
        ok.onclick = () => answerDialog(field.value);
        btns.append(cancel, ok);
        body.appendChild(btns);
        // Enter submits a single-line input; the editor keeps Enter for newlines
        // (submit via the button or Ctrl/Cmd+Enter).
        (field as HTMLElement).addEventListener("keydown", (e: any) => {
            if (e.key === "Enter" && (!multiline || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                answerDialog(field.value);
            }
        });
        setTimeout(() => field.focus(), 0);
    }
}

// Render the open dialog (the most-recently-opened wins if several stack). Skips
// a rebuild when the same dialog id is already shown, so unrelated surface
// pushes don't wipe a half-typed input.
function renderDialogs(dialogs: any[]) {
    if (!$dialog || !$dialogCard) return;
    const list = dialogs || [];
    const d = list.length ? list[list.length - 1] : null;
    if (!d) {
        activeDialog = null;
        $dialog.classList.remove("show");
        $dialogCard.innerHTML = "";
        return;
    }
    if (activeDialog && activeDialog.id === d.id) return; // already showing
    activeDialog = { id: d.id, dialog: d.dialog, rows: [] };
    buildDialog(d);
    $dialog.classList.add("show");
    $prompt?.blur();
}

// Dialog keyboard handling (capture phase, highest precedence): arrows/Enter
// drive a select; Escape cancels any dialog. Runs before the picker/overlay/
// interrupt Escape handlers below.
document.addEventListener(
    "keydown",
    (e) => {
        if (!activeDialog) return;
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            answerDialog(activeDialog.dialog === "confirm" ? false : null);
            return;
        }
        if (activeDialog.dialog !== "select") return;
        const rows = activeDialog.rows || [];
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                e.stopPropagation();
                setDialogSel(dialogSel + 1, rows);
                break;
            case "ArrowUp":
                e.preventDefault();
                e.stopPropagation();
                setDialogSel(dialogSel - 1, rows);
                break;
            case "Enter":
                e.preventDefault();
                e.stopPropagation();
                rows[dialogSel]?.click();
                break;
        }
    },
    true,
);

// Cancel a dialog by clicking its backdrop (mirrors Esc).
$dialog?.addEventListener("click", (e) => {
    if (e.target === $dialog && activeDialog)
        answerDialog(activeDialog.dialog === "confirm" ? false : null);
});

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

function toast(message: string, level = "info") {
    if (!$toastLayer) return;
    const el = document.createElement("div");
    el.className = `toast ${level}`;
    el.textContent = message;
    $toastLayer.appendChild(el);
    setTimeout(() => el.remove(), 4000);
}

// ---- threads (conversation sessions) ----
function relTime(d: string | number | Date) {
    const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function threadName(t: any) {
    return (t?.name || "(new thread)").replace(/\s+/g, " ").slice(0, 60);
}

// Short label for a working directory: the basename (full path kept for the
// `title` tooltip). Threads can live in different dirs, so the picker/header
// surface where each one runs.
function dirBase(p: string) {
    if (!p) return "";
    return p.replace(/\/+$/, "").split("/").pop() || p;
}

// A compact directory label: the last two path segments (e.g. `projects/pi-web`),
// enough to disambiguate same-named project folders without the full path.
function dirShort(p: string) {
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
function setPageTitle(text?: string) {
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
let pickerItems: HTMLElement[] = [];
let pickerIndex = -1;
let pickerNav = false;
// threadId of the row awaiting a delete confirmation (Ctrl+D), or null. While
// set, the picker swallows every key but Enter (confirm) / Esc (cancel), just
// like the pi TUI's session-selector delete flow.
let pickerConfirmId: string | null = null;

function setPickerSel(i: number) {
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
    pickerConfirmId = null;

    // Hint line under the title, mirroring the TUI selector header. Updated in
    // place by renderPickerHint() when entering/leaving delete confirmation.
    const hint = document.createElement("div");
    hint.className = "picker-hint";
    $picker.appendChild(hint);

    const mk = (
        cls: string,
        name: string,
        meta: string,
        onClick: () => void,
    ) => {
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
    pickerItems.push($picker.lastElementChild as HTMLElement);

    // Group threads by working directory (sessions are partitioned per-cwd), so
    // it's clear where each thread runs. The active thread's group sorts first.
    const groups = new Map<string, any[]>();
    for (const t of threadItems) {
        const key = t.cwd || cwd || "";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(t);
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
        for (const t of groups.get(key)!) {
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
            item.dataset.threadId = t.id;
            // The active/running thread can't be deleted (TUI parity).
            item.dataset.deletable = String(
                !(t.id === activeThreadId || t.running),
            );
            $picker.appendChild(item);
            pickerItems.push(item);
        }
    }
    // Preselect the active thread (else the first row) so Enter has a target.
    const activeIdx = pickerItems.findIndex((el) =>
        el.classList.contains("active"),
    );
    setPickerSel(activeIdx >= 0 ? activeIdx : 0);
    renderPickerHint();
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
    pickerConfirmId = null;
    modelNav = false;
    modelRows = [];
    if (wasNav) $prompt?.focus(); // return focus to the composer
}

// Update the picker's hint line: normal nav hints, or the red delete-confirm
// prompt while a row is pending deletion (mirrors the TUI selector header).
function renderPickerHint() {
    const hint = $picker?.querySelector(".picker-hint");
    if (!hint) return;
    if (pickerConfirmId) {
        hint.textContent = "Delete thread? Enter confirm · Esc cancel";
        hint.classList.add("danger");
    } else {
        hint.textContent = "↑↓ move · Enter open · Ctrl+D delete";
        hint.classList.remove("danger");
    }
}

// Begin a delete confirmation on the highlighted row. No-ops on the "New
// thread" row and refuses the active/running thread (TUI parity).
function startDeleteConfirmForSelected() {
    const el = pickerItems[pickerIndex];
    const id = el?.dataset?.threadId;
    if (!id) return; // "＋ New thread" or a non-thread row
    if (el.dataset.deletable !== "true") {
        toast("Cannot delete the currently active thread", "error");
        return;
    }
    pickerConfirmId = id;
    el.classList.add("confirm-delete");
    renderPickerHint();
}

function cancelDeleteThread() {
    pickerItems.forEach((el) => el.classList.remove("confirm-delete"));
    pickerConfirmId = null;
    renderPickerHint();
}

async function confirmDeleteThread() {
    const id = pickerConfirmId;
    pickerConfirmId = null;
    if (!id) return;
    let r;
    try {
        // Use post() (not postThread) so the *target* threadId is sent, not the
        // thread this client is currently viewing.
        r = await (await post("/threads/delete", { threadId: id })).json();
    } catch (err) {
        toast(`Failed to delete: ${(err as any)?.message ?? err}`, "error");
        return;
    }
    if (r?.ok) {
        toast(
            r.method === "trash" ? "Thread moved to trash" : "Thread deleted",
            "info",
        );
        // broadcastThreads() refreshes threadItems over SSE; rebuild the open
        // picker from the new list so the row disappears immediately.
        if ($overlay?.classList.contains("show")) openPicker();
    } else {
        toast(`Failed to delete: ${r?.error ?? "unknown error"}`, "error");
        renderPickerHint();
    }
}

$overlay?.addEventListener("click", (e) => {
    if (e.target === $overlay) closePicker();
});

// clicking the overlay backdrop (not a card) closes the top extension overlay
$overlayLayer?.addEventListener("click", (e) => {
    if (e.target === $overlayLayer) closeTopOverlay();
});

// ---- prompt input history -------------------------------------------------
// Owned by the <pi-composer> element (Up/Down browse). The host replays each
// thread's prior sends over SSE, which we seed via pushHistory() below.
function pushHistory(text: string) {
    composer.pushHistory(text ?? "");
}

// ---- fuzzy command + @file typeahead ----
let acItems: any[] = [];
let acIndex = 0;
// Extension/prompt/skill commands for the current thread (from GET /commands),
// merged into the `/` palette alongside the built-in client COMMANDS. Refreshed
// on thread switch and after /reload.
let extCommands: any[] = [];
// Whether the active thread has any extension autocomplete providers
// (piweb.addAutocompleteProvider). Gates the `/autocomplete` round-trip so
// plain prose typing doesn't hit the host on every keystroke.
let extAcEnabled = false;

// Fetch the active thread's registered slash commands and map them to typeahead
// entries. Skips any that collide with a built-in client command.
async function refreshCommands() {
    if (!activeThreadId) {
        extCommands = [];
        extAcEnabled = false;
        return;
    }
    const data = await getJson(
        "/commands?thread=" + encodeURIComponent(activeThreadId),
    );
    extAcEnabled = !!data?.autocomplete;
    const builtin = new Set(COMMANDS.map((c) => c.value));
    extCommands = (data?.items || [])
        .map((c: any) => ({
            value: "/" + c.name,
            label: "/" + c.name,
            description: c.description || (c.source ? `(${c.source})` : ""),
        }))
        .filter((c: any) => !builtin.has(c.value));
}
// "command" = leading-slash command palette; "file" = `@`-mention completion.
let acMode = "command";
// For file mode: the [start, end) span of the `@token` being completed, so an
// accepted suggestion is spliced in place (mid-line) instead of replacing all.
let acAtStart = 0;
let acAtEnd = 0;
// Sequence guard so a slow /files fetch can't clobber a newer keystroke.
let acReq = 0;
// Cached project file list (fetched lazily on first `@`, refreshed on a TTL).
let fileCache: any[] = [];
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
        fileCache = (j.items || []).map((p: any) => ({
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
function atTokenBeforeCaret(text: string, caret: number) {
    const before = text.slice(0, caret);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    if (!m) return null;
    const query = m[2];
    return { start: caret - query.length - 1, end: caret, query };
}

async function showFileAc(query: string) {
    const myReq = ++acReq;
    const files = await ensureFiles();
    if (myReq !== acReq) return; // a newer keystroke superseded this one
    const ranked = query ? fuzzyFilter(files, query, (f) => f.path) : files;
    acItems = ranked.slice(0, 20);
    acIndex = 0;
    renderAc();
}

// The path token to complete inside a `!`/`!!` bash command: whatever follows
// the `!`/`!!` prefix (and any whitespace), up to the caret's last
// whitespace-delimited token. Returns null when the input isn't a bash command.
// Used by the Tab handler to force-open file completion (the pi TUI's
// forceFileAutocomplete), so it isn't spammed on every keystroke.
function bashTokenSpan(v: string, caret: number) {
    const trimmed = v.trimStart();
    if (!trimmed.startsWith("!")) return null;
    const before = v.slice(0, caret);
    const leadingWs = v.length - trimmed.length;
    const bangCount = before.trimStart().startsWith("!!") ? 2 : 1;
    // Only complete text between the `!`/`!!` prefix and the caret.
    const afterBang = before.slice(leadingWs + bangCount);
    const spaceIdx = afterBang.lastIndexOf(" ");
    const token = spaceIdx >= 0 ? afterBang.slice(spaceIdx + 1) : afterBang;
    const tokenStart =
        leadingWs + bangCount + (spaceIdx >= 0 ? spaceIdx + 1 : 0);
    return { token, start: tokenStart, end: caret };
}

// File completions for `!`/`!!` bash commands (same file cache as @-mentions,
// but values carry the bare path instead of `@path`).
async function showBashFileAc(query: string) {
    const myReq = ++acReq;
    const files = await ensureFiles();
    if (myReq !== acReq) return;
    // Reuse the cached file list; map to items with the bare path as value.
    const bashFiles = files.map((f: any) => ({
        value: f.path,
        label: f.label,
        description: f.description,
        path: f.path,
    }));
    const ranked = query
        ? fuzzyFilter(bashFiles, query, (f) => f.path)
        : bashFiles;
    acItems = ranked.slice(0, 20);
    acIndex = 0;
    renderAc();
}

// Directory suggestions for `/new <dir>`: the host resolves the partial against
// the active thread's cwd and returns matching subdirs as absolute paths.
async function showDirAc(query: string) {
    const myReq = ++acReq;
    let items: any[] = [];
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

// Extension-supplied completions (piweb.addAutocompleteProvider). The host runs
// the active thread's providers against the composer text + caret and returns a
// `{ start, end, items }` splice span. Guarded by acReq like the other async
// sources so a slow response can't clobber a newer keystroke.
async function showExtAc(text: string, caret: number) {
    const myReq = ++acReq;
    let result = null;
    try {
        const r = await fetch("/autocomplete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                text,
                caret,
                threadId: activeThreadId || undefined,
            }),
        });
        result = await r.json();
    } catch {}
    if (myReq !== acReq) return; // superseded
    const items = (result?.items || [])
        .map((it: any) => ({
            value: it.value,
            label: it.label || it.value,
            description: it.description || "",
        }))
        .filter((it: any) => it.value);
    if (!items.length) {
        closeAc();
        return;
    }
    acMode = "ext";
    acAtStart = Number.isInteger(result.start) ? result.start : caret;
    acAtEnd = Number.isInteger(result.end) ? result.end : caret;
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
        acItems = fuzzyFilter([...COMMANDS, ...extCommands], v, (c) => c.label);
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

    // `!`/`!!` bash-command file completion is *not* auto-triggered here
    // (unlike `/`, `@`, `/new`). It's force-opened by Tab — see `bashTokenSpan()`
    // + the Tab handler in the composer keydown listener — mirroring the pi TUI's
    // forceFileAutocomplete (Tab to list, Tab again to accept). But once the
    // list is open, keep it live so typing narrows it instead of flickering shut.
    if (acMode === "bash" && $ac.classList.contains("show")) {
        const span = bashTokenSpan(v, caret);
        if (span) {
            acAtStart = span.start;
            acAtEnd = span.end;
            showBashFileAc(span.token);
            return;
        }
        closeAc();
        return;
    }

    // Extension-supplied completions (e.g. a `/md <file>` provider). Only when
    // the active thread registered providers, so prose typing stays local.
    if (extAcEnabled && v.trim()) {
        showExtAc(v, caret); // async; guarded by acReq
        return;
    }

    closeAc();
}

function acceptAc(run: boolean) {
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

    // Bash file completions splice the bare path into the `!/!!` token span
    // and keep editing (never submit), so you can chain further arguments.
    // Matches the @-mention splice pattern — same behaviour, no `@` prefix.
    if (acMode === "bash") {
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

    // Extension completions (piweb.addAutocompleteProvider) splice their value
    // into the provider's [start, end) span. Enter runs the resulting line
    // (e.g. `/md <file>`); Tab inserts and keeps editing.
    if (acMode === "ext") {
        const v = $prompt.value;
        const before = v.slice(0, acAtStart);
        const after = v.slice(acAtEnd);
        const line = before + it.value + after;
        if (run) {
            closeAc();
            $prompt.value = "";
            syncHighlight(); // repaint the now-empty highlight backdrop
            runInput(line);
            return;
        }
        $prompt.value = line;
        const pos = before.length + it.value.length;
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
            syncHighlight(); // repaint the now-empty highlight backdrop
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

function notice(text: string) {
    bubble("system", text);
}

async function getJson(path: string) {
    try {
        return await (await fetch(path)).json();
    } catch {
        return null;
    }
}

function showOverlay(title: string, contentEl: HTMLElement) {
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

function runInput(text: string, images: any[] = []) {
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
        // Registered extension/prompt/skill command (from GET /commands): run it
        // host-side instead of sending the slash text to the model as a prompt.
        if (extCommands.some((c) => c.value === cmd)) {
            postThread("/command", { name: cmd.slice(1), args: arg });
            return;
        }
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
function runCommand(cmd: string, arg: string) {
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
        case "/trust":
            openTrustPicker();
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

async function doExport(format: string) {
    const fmt = format === "jsonl" ? "jsonl" : "html";
    const r = await (
        await postThread("/session/export", { format: fmt })
    ).json();
    if (r?.path) notice(`exported (${r.format}) → ${r.path}`);
    else notice("export failed" + (r?.error ? `: ${r.error}` : ""));
}

// Append `?thread=<id>` to a GET path so a read-only endpoint resolves the
// thread the client is currently viewing (the POST helpers use postThread).
function withThread(path: string) {
    return (
        path +
        (activeThreadId ? "?thread=" + encodeURIComponent(activeThreadId) : "")
    );
}

// Generic single-column selector that reuses the resume-picker chrome and its
// shared keyboard navigation (Up/Down/Enter/Home/End via the pickerNav
// listener). `rows` is ordered; each is { name, meta?, cls?, title?, onClick }.
function openListPicker(title: string, rows: any[], selectIndex = 0) {
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

// ---- /trust: set project-trust for this thread's working directory -------
// pi gates project-local .pi resources behind a trust decision; pi-web runs
// headless so trust-requiring projects default to untrusted. This picker lists
// pi's trust choices (Trust / Trust parent / session-only / Do not trust) and
// POSTs the pick to the host, which persists it + reloads resources under it.
async function openTrustPicker() {
    const data = await getJson(
        "/trust" +
            (activeThreadId
                ? "?thread=" + encodeURIComponent(activeThreadId)
                : ""),
    );
    const options: Array<{ label: string; trusted: boolean }> =
        data?.options || [];
    if (!options.length) {
        notice("project trust unavailable");
        return;
    }
    const state = data?.projectTrusted ? "trusted" : "untrusted";
    const rows = options.map((o) => ({
        name: o.label,
        meta: o.trusted ? "trust" : "untrust",
        onClick: () => applyTrust(o.label),
    }));
    openListPicker(
        `Project trust · ${data?.cwd || ""} · currently ${state}`,
        rows,
    );
}

async function applyTrust(label: string) {
    const r = await (await postThread("/trust", { label })).json();
    if (!r?.ok) {
        notice("trust update failed: " + (r?.error || "unknown"));
        return;
    }
    toast(r.projectTrusted ? "Project trusted" : "Project not trusted");
}

// ---- /tree: jump to an earlier point in the session ----------------------
async function openTreePicker() {
    const data = await getJson(withThread("/tree"));
    const entries = data?.entries || [];
    if (!entries.length) {
        notice("no earlier points to jump to");
        return;
    }
    const rows = entries.map((e: any) => {
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
    const curIdx = entries.findIndex((e: any) => e.current);
    openListPicker(
        "Jump to a point in the session",
        rows,
        curIdx >= 0 ? curIdx : rows.length - 1,
    );
}

async function navigateTree(entryId: string) {
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
    const rows = items.map((m: any) => ({
        name: m.text || "(empty message)",
        meta: "",
        onClick: () => forkFrom(m.id),
    }));
    // preselect the most recent user message (matches the pi TUI default)
    openListPicker("Fork from a message", rows, rows.length - 1);
}

async function forkFrom(entryId: string) {
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
async function doImport(file: string) {
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

function modelMeta(m: any) {
    const parts: string[] = [];
    if (m.contextWindow) parts.push(`${fmtTokens(m.contextWindow)} ctx`);
    if (m.reasoning) parts.push("thinking");
    if (m.sub) parts.push("subscription");
    return parts.join(" · ");
}

// Fuzzy-search text mirroring the TUI's getModelSelectorSearchText (provider
// first so provider-prefixed queries rank ahead of proxy-provider ids).
function modelSearchText(m: any) {
    const name = m.name ? ` ${m.name}` : "";
    return `${m.provider} ${m.provider}/${m.id} ${m.provider} ${m.id}${name}`;
}

function setModelSel(i: number) {
    if (!modelRows.length) return;
    modelIndex = (i + modelRows.length) % modelRows.length;
    modelRows.forEach((el, idx) =>
        el.classList.toggle("sel", idx === modelIndex),
    );
    modelRows[modelIndex].scrollIntoView({ block: "nearest" });
}

function renderModelList(container: HTMLElement, query: string) {
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

async function chooseModel(m: any) {
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
    // <pi-composer> owns autosize + backdrop repaint; reflow() resizes + repaints
    // after a direct textarea write (command / autocomplete flows), caret intact.
    composer.reflow();
}

// Text changed: refresh autocomplete + the `!` bash-mode border (the element
// owns autosize / highlight / history-reset).
composer.addEventListener("pi-input", () => {
    updateAc();
    applyThinkingBorder();
});

// The element emits submit / dequeue instead of app.ts owning the form + keys.
composer.addEventListener("pi-submit", (e) => {
    const detail = (e as CustomEvent).detail;
    closeAc();
    runInput(
        detail.text,
        (detail.images || []).map((img: any) => ({
            data: img.data,
            mimeType: img.mimeType,
        })),
    );
});
composer.addEventListener("pi-dequeue", () => restoreQueue({ abort: false }));

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
// Autocomplete + thinking-cycle + dequeue claim keys *before* the composer's own
// history / submit handling, via the element's keyGuard seam. Returning true
// means "handled" (the composer then ignores the key). History and Enter-submit
// are owned by <pi-composer>.
composer.keyGuard = (e) => {
    // Shift+Tab cycles the reasoning level (a browser focus-traversal key).
    if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        postThread("/thinking-level", { op: "cycle" });
        return true;
    }
    // Alt+Up restores queued (steering/follow-up) messages to the composer.
    if (e.key === "ArrowUp" && e.altKey && queuedMessages.length) {
        e.preventDefault();
        restoreQueue({ abort: false });
        return true;
    }
    if ($ac.classList.contains("show")) {
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                acIndex = (acIndex + 1) % acItems.length;
                renderAc();
                return true;
            case "ArrowUp":
                e.preventDefault();
                acIndex = (acIndex - 1 + acItems.length) % acItems.length;
                renderAc();
                return true;
            case "Tab":
                e.preventDefault();
                acceptAc(false);
                return true;
            case "Enter":
                // file/bash: accept + keep editing; command/dir: accept + run.
                e.preventDefault();
                acceptAc(acMode !== "file" && acMode !== "bash");
                return true;
            case "Escape":
                e.preventDefault();
                closeAc();
                return true;
        }
        return false; // other keys fall through to the composer while AC is open
    }
    // No typeahead open: Tab force-opens file completion for a `!`/`!!` bash
    // command (the pi TUI's forceFileAutocomplete): "Tab to list, Tab to accept".
    if (e.key === "Tab" && !e.shiftKey) {
        const caret = $prompt.selectionStart ?? $prompt.value.length;
        const span = bashTokenSpan($prompt.value, caret);
        if (span) {
            e.preventDefault();
            acMode = "bash";
            acAtStart = span.start;
            acAtEnd = span.end;
            showBashFileAc(span.token);
            return true;
        }
    }
    return false; // let the composer handle history / Enter-submit
};

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
    // Delete confirmation active: swallow every key but Enter/Esc (TUI parity).
    if (pickerConfirmId) {
        e.preventDefault();
        if (e.key === "Enter") confirmDeleteThread();
        else if (e.key === "Escape") {
            // Stop the global Escape handler from also closing the picker.
            e.stopImmediatePropagation();
            cancelDeleteThread();
        }
        return;
    }
    // Ctrl+D or Ctrl+Backspace → start a delete confirmation on the selection.
    // preventDefault stops the browser's bookmark (Ctrl+D) shortcut.
    if (e.ctrlKey && (e.key === "d" || e.key === "Backspace")) {
        e.preventDefault();
        startDeleteConfirmForSelected();
        return;
    }
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
// else interrupt the working agent, else cancel a running shell command, else
// restore any queued messages (mirrors the pi TUI's Esc handling).
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
    if (working) {
        // agent is working → mirror the pi TUI's Esc: restore any queued
        // (steering/follow-up) messages back into the composer *and* interrupt
        // this thread's turn (restoreQueuedMessagesToEditor({ abort: true })).
        restoreQueue({ abort: true });
    } else if (bashEl) {
        // a user-run shell command is in flight → cancel it (TUI Esc parity:
        // isBashRunning → session.abortBash()).
        postThread("/bash/abort");
    } else if (queuedMessages.length) {
        // not working but messages are still queued → restore them to edit
        restoreQueue({ abort: false });
    }
});

// (Prompt submission + attachments are owned by <pi-composer>; the pi-submit
// listener above calls runInput. The composer clears itself after emitting.)

// ---- SSE stream ----
// One EventSource at a time, scoped to the viewed thread via `?thread`.
// Switching threads = reopen the stream; the host replays the new thread.
let es: EventSource | null = null;

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

function onSseMessage(e: MessageEvent) {
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
            // After a /reload, also show the intro inline at the bottom so the
            // freshly loaded resources are visible in place (the pinned banner
            // up top has usually been scrolled past).
            if (m.reload) appendWelcome();
            // extensions may have changed (first load / after /reload) — refresh
            // the `/` typeahead's extension commands
            refreshCommands();
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
            // Refresh an open resume picker, but not mid delete-confirmation
            // (openPicker() would reset pickerConfirmId and drop the prompt).
            if ($overlay?.classList.contains("show") && !pickerConfirmId)
                openPicker();
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
            // load this thread's extension/prompt/skill commands for the palette
            refreshCommands();
            // working-indicator overrides are per-thread; the connect replay
            // re-sends this thread's `working_config` right after.
            setWorkingConfig({});
            break;
        case "working":
            setWorking(!!m.busy);
            break;
        case "working_config":
            // extension overrides for the streaming indicator (pi ui.setWorking*)
            setWorkingConfig(m.config || {});
            break;
        case "trust_required":
            // First-load trust gate: this project ships trust-gated `.pi`
            // resources (extensions/skills/prompts/settings) with no saved
            // decision, so it started UNTRUSTED — those resources are disabled
            // until the user decides. Prompt via the /trust picker. Non-blocking;
            // dismissible (stays untrusted — they can /trust later).
            notice(
                "This project isn't trusted — its .pi extensions/skills are disabled. Pick a trust option, or run /trust later.",
            );
            setTimeout(() => {
                if (!$overlay?.classList.contains("show")) openTrustPicker();
            }, 400);
            break;
        case "queue":
            // pending steering/follow-up messages waiting for delivery
            queuedMessages = Array.isArray(m.items) ? m.items : [];
            renderQueue();
            break;
        case "transcript_reset":
            $transcript.innerHTML = '<div class="empty">new thread</div>';
            stickToBottom = true; // fresh thread starts pinned to the bottom
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
        case "thinking_label":
            // pi-tui ui.setHiddenThinkingLabel: relabel the collapsed trace.
            setThinkingLabel(m.label);
            break;
        case "user":
            bubble("user", m.text, m.images);
            pushHistory(m.text); // seed/extend per-thread input history
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
                // Seed the Up/Down input history with the full `!`/`!!` text
                // (mirrors the pi TUI, which stores run bash commands too).
                if (m.command)
                    pushHistory(
                        (m.excludeFromContext ? "!!" : "!") + m.command,
                    );
            } else {
                if (!bashEl) bashEl = bashBubble("", false);
                bashEl.apply(m);
                if (m.status === "chunk") followBottom();
                if (m.status === "end") bashEl = null;
            }
            break;
        case "tool":
            applyToolFrame(m);
            break;
        case "custom":
            // extension-injected message rendered via a registered renderer
            renderCustomMessage(m);
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
