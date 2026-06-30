// pi-web cockpit client: transcript stream, extension panels, thread switching,
// and a fuzzy command typeahead (ported from pi-tui's fuzzy matcher).
import { fuzzyFilter } from "/fuzzy.mjs";

const $transcript = document.getElementById("transcript");
const $panels = document.getElementById("panels");
const $status = document.getElementById("status");
const $threadTitle = document.getElementById("threadTitle");
const $overlay = document.getElementById("overlay");
const $picker = document.getElementById("picker");
const $prompt = document.getElementById("prompt");
const $ask = document.getElementById("ask");
const $ac = document.getElementById("ac");

let assistantEl = null; // current streaming assistant bubble
let threadItems = []; // last known thread list (from SSE)
let activeThreadId = null;

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

function post(path, body) {
    return fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// ---- component-tree renderer (serializable UI from extensions) ----
function renderNode(node, panelId) {
    if (!node || typeof node !== "object")
        return document.createTextNode(String(node ?? ""));
    switch (node.type) {
        case "Stack": {
            const d = document.createElement("div");
            d.style.display = "flex";
            d.style.flexDirection = "column";
            d.style.gap = "8px";
            (node.children || []).forEach((c) =>
                d.appendChild(renderNode(c, panelId)),
            );
            return d;
        }
        case "Row": {
            const d = document.createElement("div");
            d.className = "row";
            (node.children || []).forEach((c) =>
                d.appendChild(renderNode(c, panelId)),
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
            b.onclick = () => post("/action", { panelId, action: node.action });
            return b;
        }
        case "Input": {
            const i = document.createElement("input");
            i.type = "text";
            if (node.placeholder) i.placeholder = node.placeholder;
            if (node.value != null) i.value = node.value;
            i.onkeydown = (e) => {
                if (e.key === "Enter")
                    post("/action", {
                        panelId,
                        action: node.action,
                        payload: { value: i.value },
                    });
            };
            i.onblur = () =>
                post("/action", {
                    panelId,
                    action: node.action,
                    payload: { value: i.value },
                });
            return i;
        }
        default: {
            const d = document.createElement("div");
            d.textContent = `[unknown node: ${node.type}]`;
            return d;
        }
    }
}

function renderPanels(panels) {
    $panels.innerHTML = "";
    if (!panels.length) {
        $panels.innerHTML = '<div class="empty">no panels yet</div>';
        return;
    }
    for (const p of panels) {
        const el = document.createElement("div");
        el.className = "panel";
        const title = document.createElement("div");
        title.className = "ptitle";
        title.textContent = p.title;
        const body = document.createElement("div");
        body.className = "pbody";
        body.appendChild(renderNode(p.tree, p.id));
        el.appendChild(title);
        el.appendChild(body);
        $panels.appendChild(el);
    }
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
    const active =
        threadItems.find((t) => t.id === activeThreadId) ||
        threadItems.find((t) => t.active);
    if (active) {
        activeThreadId = active.id;
        $threadTitle.textContent = threadName(active);
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
            post("/threads", {});
        }),
    );

    for (const t of threadItems) {
        $picker.appendChild(
            mk(
                t.active || t.id === activeThreadId ? "active" : "",
                threadName(t),
                `${t.messageCount ?? 0} msgs · ${relTime(t.modified)}`,
                () => {
                    closePicker();
                    if (t.id !== activeThreadId)
                        post("/threads/switch", { id: t.id });
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
    if (text.startsWith("/")) {
        const sp = text.indexOf(" ");
        const cmd = sp === -1 ? text : text.slice(0, sp);
        const arg = sp === -1 ? "" : text.slice(sp + 1).trim();
        if (runCommand(cmd, arg)) return;
    }
    post("/prompt", { text });
}

// returns true if handled as a cockpit command
function runCommand(cmd, arg) {
    switch (cmd) {
        case "/resume":
            openPicker();
            return true;
        case "/new":
            post("/threads", {});
            return true;
        case "/reload":
            post("/reload", {});
            return true;
        case "/copy":
            copyLastAssistant();
            return true;
        case "/compact":
            post("/session/compact", {});
            return true;
        case "/name":
            if (!arg) notice("usage: /name <title>");
            else post("/session/name", { name: arg });
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
    const r = await (await post("/session/export", { format: fmt })).json();
    if (r?.path) notice(`exported (${r.format}) → ${r.path}`);
    else notice("export failed" + (r?.error ? `: ${r.error}` : ""));
}

async function showSessionInfo() {
    const info = await getJson("/session");
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
        ["Esc", "dismiss menu / overlay"],
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

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePicker();
});

$ask.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $prompt.value;
    $prompt.value = "";
    closeAc();
    runInput(text);
});

document
    .getElementById("reload")
    .addEventListener("click", () => post("/reload", {}));

// ---- SSE stream ----
const es = new EventSource("/events");
es.onopen = () => {
    $status.textContent = "● live";
    $status.className = "";
};
es.onerror = () => {
    $status.textContent = "○ disconnected";
};
es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    switch (m.kind) {
        case "panels":
            renderPanels(m.panels);
            break;
        case "threads":
            threadItems = m.items || [];
            updateTitle();
            if ($overlay?.classList.contains("show")) openPicker();
            break;
        case "thread_switched":
            activeThreadId = m.id;
            updateTitle();
            break;
        case "transcript_reset":
            $transcript.innerHTML = '<div class="empty">new thread</div>';
            assistantEl = null;
            break;
        case "user":
            bubble("user", m.text);
            assistantEl = null;
            break;
        case "delta":
            if (!assistantEl) assistantEl = bubble("assistant", "");
            assistantEl.querySelector(".body").textContent += m.text;
            $transcript.scrollTop = $transcript.scrollHeight;
            break;
        case "assistant_full":
            (
                assistantEl ?? (assistantEl = bubble("assistant", ""))
            ).querySelector(".body").textContent = m.text;
            $transcript.scrollTop = $transcript.scrollHeight;
            break;
        case "assistant_end":
            assistantEl = null;
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
};
