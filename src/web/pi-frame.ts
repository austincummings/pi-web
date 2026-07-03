// <pi-frame> — a sandboxed host for extension-provided HTML/CSS/JS.
//
// Extensions can return { type:"Frame", html, height? } as a surface node. The
// html runs in a sandboxed iframe (allow-scripts, NO allow-same-origin) so
// arbitrary HTML/CSS/JS is isolated from the web UI's DOM, cookies, and JS.
//
// The element owns its whole lifecycle: it builds the iframe + bootstrap
// document, scopes a `message` listener to its own contentWindow, auto-sizes to
// content height, and tears the listener down on disconnect. Instead of calling
// back into the host directly, it emits bubbling CustomEvents so the host can
// stay decoupled:
//   - "piframe-action"  detail: { surfaceId, action, payload }
//   - "piframe-notify"  detail: { message, level }
//
// Inside the frame: window.piweb.action(name, payload),
// window.piweb.notify(msg, level), or any [data-action] element.

export interface PiFrameActionDetail {
    surfaceId: string;
    action: string;
    payload: Record<string, unknown>;
}

export interface PiFrameNotifyDetail {
    message: string;
    level: string;
}

// Theme vars copied into the frame so its baseline styling matches the active
// pi theme (the frame is a separate document, so CSS variables don't inherit).
const THEME_VARS = [
    // base palette
    "--bg",
    "--panel",
    "--line",
    "--txt",
    "--muted",
    "--dim",
    "--acc",
    "--acc2",
    "--ok",
    "--warn",
    "--err",
    // tool-card status tints + title/output
    "--tool-pending-bg",
    "--tool-success-bg",
    "--tool-error-bg",
    "--tool-title",
    "--tool-output",
    // markdown
    "--md-heading",
    "--md-link",
    "--md-link-url",
    "--md-code",
    "--md-code-block",
    "--md-code-block-border",
    "--md-quote",
    "--md-quote-border",
    "--md-hr",
    "--md-list-bullet",
    // diff
    "--diff-added",
    "--diff-removed",
    "--diff-context",
    // syntax
    "--syn-comment",
    "--syn-keyword",
    "--syn-function",
    "--syn-variable",
    "--syn-string",
    "--syn-number",
    "--syn-type",
    "--syn-operator",
    "--syn-punctuation",
    // message styling
    "--selected-bg",
    "--user-msg-bg",
    "--user-msg-text",
    "--custom-msg-bg",
    "--custom-msg-text",
    "--custom-msg-label",
    // misc raw palette slots
    "--hover",
    "--border-variant",
    "--comment",
    "--cyan",
    "--bright-cyan",
    "--dim-blue",
    "--bash-mode",
];

function frameThemeVars(): string {
    const cs = getComputedStyle(document.documentElement);
    return THEME_VARS.map((n) => `${n}:${cs.getPropertyValue(n).trim()}`).join(
        ";",
    );
}

// Wrap extension-provided body HTML into a full sandboxed document with the
// theme + bridge bootstrap. (`<\/script>` is escaped so the bootstrap survives
// being embedded in this module.)
function wrapFrameDoc(html: string): string {
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
        `window.piweb={data:undefined,onData:null,` +
        `action:function(a,p){send({type:'action',action:a,payload:p||{}});},` +
        `notify:function(msg,l){send({type:'notify',message:msg,level:l||'info'});}};` +
        // host -> frame data channel (postMessage): persists across footer/widget
        // refreshes so the frame updates in place instead of reloading.
        `window.addEventListener('message',function(e){var m=e.data;` +
        `if(!m||m.__pihost!==true)return;if(m.type==='data'){window.piweb.data=m.data;` +
        `if(typeof window.piweb.onData==='function'){try{window.piweb.onData(m.data);}catch(_){}}}});` +
        `document.addEventListener('click',function(e){var el=e.target.closest&&e.target.closest('[data-action]');` +
        `if(el){send({type:'action',action:el.getAttribute('data-action'),payload:{}});}});` +
        `function report(){send({type:'height',height:document.documentElement.scrollHeight});}` +
        `if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement);}` +
        `window.addEventListener('load',report);setTimeout(report,0);})();<\/script></body></html>`
    );
}

export class PiFrame extends HTMLElement {
    /** The surface id this frame belongs to (sent with action events). */
    surfaceId = "";
    /** Extension-provided body HTML. */
    frameHtml = "";
    /** Fixed pixel height, or null to auto-size to content. */
    frameHeight: number | null = null;
    /** Optional data payload pushed into the frame (postMessage) after load. */
    frameData: unknown = undefined;

    private iframe: HTMLIFrameElement | null = null;
    private loaded = false;
    private readonly onMessage = (e: MessageEvent) => this.handleMessage(e);

    private get autoHeight(): boolean {
        return this.frameHeight == null;
    }

    connectedCallback(): void {
        if (!this.iframe) this.build();
        // Sandboxed frames have a null origin, so we can't filter by origin;
        // handleMessage() identifies our frame by contentWindow identity.
        window.addEventListener("message", this.onMessage);
    }

    disconnectedCallback(): void {
        window.removeEventListener("message", this.onMessage);
    }

    private build(): void {
        const iframe = document.createElement("iframe");
        iframe.className = "frame";
        iframe.setAttribute("sandbox", "allow-scripts");
        iframe.setAttribute("scrolling", "no");
        iframe.style.width = "100%";
        iframe.style.border = "0";
        iframe.style.display = "block";
        iframe.style.height = (this.autoHeight ? 80 : this.frameHeight) + "px";
        iframe.addEventListener("load", () => {
            this.loaded = true;
            this.postData();
        });
        iframe.srcdoc = wrapFrameDoc(this.frameHtml);
        this.iframe = iframe;
        this.appendChild(iframe);
    }

    /** Push the current data payload into the (loaded) frame. */
    private postData(): void {
        if (!this.loaded || this.frameData === undefined) return;
        this.iframe?.contentWindow?.postMessage(
            { __pihost: true, type: "data", data: this.frameData },
            "*",
        );
    }

    /**
     * Update an already-mounted frame in place. If `html` is unchanged, the
     * iframe is *not* reloaded — only the new `data` is posted (no flicker);
     * otherwise the document is rebuilt. Used by the persistent footer path.
     */
    update(html: string, height: number | null, data?: unknown): void {
        this.frameData = data;
        if (height != null && height !== this.frameHeight) {
            this.frameHeight = height;
            if (this.iframe) this.iframe.style.height = `${height}px`;
        }
        if (html !== this.frameHtml) {
            this.frameHtml = html;
            this.loaded = false;
            if (this.iframe) this.iframe.srcdoc = wrapFrameDoc(html);
            // the load handler posts `data` once the new document is ready
        } else {
            this.postData(); // same shell -> just refresh the data
        }
    }

    private handleMessage(e: MessageEvent): void {
        if (!this.iframe || e.source !== this.iframe.contentWindow) return;
        const msg = e.data;
        if (!msg || msg.__piweb !== true) return;
        if (msg.type === "action") {
            this.emit<PiFrameActionDetail>("piframe-action", {
                surfaceId: this.surfaceId,
                action: msg.action,
                payload: msg.payload ?? {},
            });
        } else if (msg.type === "notify") {
            this.emit<PiFrameNotifyDetail>("piframe-notify", {
                message: msg.message,
                level: msg.level,
            });
        } else if (msg.type === "height" && this.autoHeight) {
            const next =
                Math.max(24, Math.min(Number(msg.height) || 0, 4000)) + "px";
            if (next !== this.iframe.style.height) {
                this.iframe.style.height = next;
                // The iframe auto-sizes asynchronously (it boots at an 80px
                // placeholder, then reports its real content height here). The
                // host already ran followBottom() when it mounted us — while we
                // were still 80px — so announce the growth and let it re-follow
                // if the user was pinned to the bottom.
                this.emit("piframe-resize", { surfaceId: this.surfaceId });
            }
        }
    }

    private emit<T>(type: string, detail: T): void {
        this.dispatchEvent(
            new CustomEvent<T>(type, { detail, bubbles: true, composed: true }),
        );
    }
}

if (!customElements.get("pi-frame")) {
    customElements.define("pi-frame", PiFrame);
}

declare global {
    interface HTMLElementTagNameMap {
        "pi-frame": PiFrame;
    }
    interface HTMLElementEventMap {
        "piframe-action": CustomEvent<PiFrameActionDetail>;
        "piframe-notify": CustomEvent<PiFrameNotifyDetail>;
        "piframe-resize": CustomEvent<{ surfaceId: string }>;
    }
}
