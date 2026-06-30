// pi-web cockpit client: renders the transcript stream + extension-defined panels.

const $transcript = document.getElementById("transcript");
const $panels = document.getElementById("panels");
const $status = document.getElementById("status");
const $threads = document.getElementById("threads");
const $newThread = document.getElementById("newThread");

let assistantEl = null; // current streaming assistant bubble

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

// ---- component-tree renderer (serializable UI from extensions) ----
function post(path, body) {
    return fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

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

function renderThreads(items) {
    if (!$threads) return;
    $threads.innerHTML = "";
    if (!items || !items.length) {
        const o = document.createElement("option");
        o.textContent = "(no threads)";
        $threads.appendChild(o);
        return;
    }
    for (const t of items) {
        const o = document.createElement("option");
        o.value = t.id;
        const label = (t.name || "(new thread)")
            .replace(/\s+/g, " ")
            .slice(0, 40);
        o.textContent = `${label} · ${relTime(t.modified)}`;
        if (t.active) o.selected = true;
        $threads.appendChild(o);
    }
}

$threads?.addEventListener("change", () =>
    post("/threads/switch", { id: $threads.value }),
);
$newThread?.addEventListener("click", () => post("/threads", {}));

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
            renderThreads(m.items);
            break;
        case "thread_switched":
            if ($threads) $threads.value = m.id;
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

// ---- prompt box ----
document.getElementById("ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("prompt");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    post("/prompt", { text });
});

document
    .getElementById("reload")
    .addEventListener("click", () => post("/reload", {}));
