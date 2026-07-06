// <pi-login> — the /login (and /logout) overlay, mirroring the pi TUI's OAuth
// login flow. It has two views inside one card:
//
//   1. provider picker — a keyboard-navigable list of OAuth providers (marking
//      the ones that already have credentials). Picking one starts login (or,
//      in "logout" mode, removes its credentials).
//   2. login flow — reflects the streaming `login` frames the host produces as
//      it drives `authStorage.login()`: it shows the auth URL / device code /
//      progress, and prompts for input (paste-a-code / secret / select) when
//      the flow needs it, posting the answer back keyed by `loginId`.
//
// Light DOM (no Shadow DOM) so the shared overlay CSS (#overlay/pi-login,
// .picker, .item.sel, --acc, …) applies unchanged, matching <pi-model-picker>.
//
// Events (bubble):
//   pi-login-pick    { providerId, mode }  — a provider was chosen
//   pi-login-respond { loginId, value }    — answer to an interactive prompt
//   pi-login-cancel  { loginId? }          — dismissed (Escape / backdrop)
//
// Public API:
//   openProviders(items, mode)   — show the picker ("login" | "logout")
//   beginFlow(loginId, provider) — switch to the flow view ("connecting…")
//   applyEvent(frame)            — apply a `login` SSE frame to the flow view
//   close()                      — hide + reset
//   visible                      — whether the overlay is shown
import type { LoginFrame } from "../shared/frames.ts";

type ProviderItem = {
    id: string;
    name: string;
    authType?: "oauth" | "api_key" | string;
    configured?: boolean;
    usesCallbackServer?: boolean;
    label?: string;
};

type Mode = "login" | "logout";

export class PiLogin extends HTMLElement {
    #card!: HTMLElement;
    #heading!: HTMLElement;
    #list!: HTMLElement; // provider picker rows live here
    #flow!: HTMLElement; // login-flow body lives here
    #info!: HTMLElement; // accumulates auth-url / device-code / progress
    #promptArea!: HTMLElement; // the current interactive prompt (input/select)

    #providers: ProviderItem[] = [];
    #rows: HTMLElement[] = [];
    #index = 0;
    #mode: Mode = "login";
    #loginId: string | null = null;
    #closeTimer: ReturnType<typeof setTimeout> | null = null;

    get visible() {
        return this.classList.contains("show");
    }

    connectedCallback() {
        this.#card = document.createElement("div");
        this.#card.className = "picker login-card";
        this.#heading = document.createElement("h3");
        this.#list = document.createElement("div");
        this.#list.className = "model-list";
        this.#flow = document.createElement("div");
        this.#flow.className = "login-flow";
        this.#info = document.createElement("div");
        this.#info.className = "login-info";
        this.#promptArea = document.createElement("div");
        this.#promptArea.className = "login-prompt";
        this.#flow.append(this.#info, this.#promptArea);
        this.#card.append(this.#heading, this.#list, this.#flow);
        this.appendChild(this.#card);

        this.addEventListener("click", this.#onBackdrop);
        document.addEventListener("keydown", this.#onDocKey, true);
    }

    disconnectedCallback() {
        this.removeEventListener("click", this.#onBackdrop);
        document.removeEventListener("keydown", this.#onDocKey, true);
    }

    // ---- provider picker ----------------------------------------------------

    openProviders(items: ProviderItem[], mode: Mode = "login") {
        this.#mode = mode;
        // The host already returns the right set per mode (login = OAuth +
        // API-key union; logout = providers with stored credentials).
        this.#providers = items || [];
        this.#loginId = null;
        this.#index = 0;
        this.#heading.textContent =
            mode === "logout"
                ? "Log out of a provider"
                : "Sign in to a provider";
        this.#flow.style.display = "none";
        this.#list.style.display = "";
        this.#renderProviders();
        this.classList.add("show");
        this.focus();
    }

    #renderProviders() {
        this.#rows = [];
        this.#list.innerHTML = "";
        if (!this.#providers.length) {
            const empty = document.createElement("div");
            empty.className = "item";
            empty.innerHTML =
                '<span class="name hint">' +
                (this.#mode === "logout"
                    ? "no stored credentials to remove"
                    : "no OAuth providers available") +
                "</span>";
            this.#list.appendChild(empty);
            return;
        }
        this.#providers.forEach((p) => {
            const item = document.createElement("div");
            item.className = "item";
            const n = document.createElement("span");
            n.className = "name";
            n.textContent = p.name;
            const meta = document.createElement("span");
            meta.className = "meta";
            meta.textContent = this.#providerMeta(p);
            item.append(n, meta);
            item.onclick = () => this.#pick(p);
            this.#list.appendChild(item);
            this.#rows.push(item);
        });
        this.#setSel(0);
    }

    // Picker row subtitle: the auth kind (subscription vs API key) plus whether
    // credentials are already stored.
    #providerMeta(p: ProviderItem) {
        const parts: string[] = [];
        if (this.#mode !== "logout")
            parts.push(p.authType === "api_key" ? "API key" : "subscription");
        if (p.configured)
            parts.push(this.#mode === "logout" ? "signed in" : "configured");
        return parts.join(" · ");
    }

    #setSel(i: number) {
        if (!this.#rows.length) return;
        this.#index = (i + this.#rows.length) % this.#rows.length;
        this.#rows.forEach((el, idx) =>
            el.classList.toggle("sel", idx === this.#index),
        );
        this.#rows[this.#index].scrollIntoView({ block: "nearest" });
    }

    #pick(p: ProviderItem) {
        this.dispatchEvent(
            new CustomEvent("pi-login-pick", {
                bubbles: true,
                detail: {
                    providerId: p.id,
                    mode: this.#mode,
                    authType: p.authType,
                },
            }),
        );
    }

    // ---- login flow ---------------------------------------------------------

    // Switch to the flow view for a started login. Called once the host has
    // returned a loginId from POST /login/start.
    beginFlow(loginId: string, provider: { id: string; name: string }) {
        this.#loginId = loginId;
        this.#list.style.display = "none";
        this.#flow.style.display = "";
        this.#heading.textContent = `Signing in to ${provider?.name ?? "provider"}`;
        this.#info.innerHTML = "";
        this.#promptArea.innerHTML = "";
        this.#status("Connecting…");
        this.classList.add("show");
    }

    // Apply one streaming `login` frame to the flow view.
    applyEvent(m: LoginFrame) {
        if (m.loginId) this.#loginId = m.loginId;
        switch (m.event) {
            case "start":
                // beginFlow() already set up the view from the POST response;
                // ensure the heading is right if the frame won the race.
                if (m.provider)
                    this.#heading.textContent = `Signing in to ${m.provider.name}`;
                break;
            case "auth_url":
                this.#showAuthUrl(m.url || "", m.instructions);
                break;
            case "device_code":
                this.#showDeviceCode(m);
                break;
            case "progress":
                this.#status(m.message || "");
                break;
            case "prompt":
                this.#showPrompt(m);
                break;
            case "done":
                if (m.ok) {
                    this.#promptArea.innerHTML = "";
                    this.#status(
                        `✓ Signed in to ${m.provider?.name ?? "provider"}`,
                        "ok",
                    );
                    this.#autoClose();
                } else {
                    this.#promptArea.innerHTML = "";
                    this.#status(m.error || "Login failed", "err");
                    this.#addCloseButton();
                }
                break;
            case "cancelled":
                this.close();
                break;
        }
    }

    #status(text: string, kind: "" | "ok" | "err" = "") {
        const line = document.createElement("div");
        line.className = "login-line" + (kind ? " " + kind : "");
        line.textContent = text;
        this.#info.appendChild(line);
        this.#info.scrollTop = this.#info.scrollHeight;
    }

    #showAuthUrl(url: string, instructions?: string) {
        if (instructions) this.#status(instructions);
        const wrap = document.createElement("div");
        wrap.className = "login-line";
        wrap.textContent = "Open this URL to continue:";
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.className = "login-url";
        link.textContent = url;
        this.#info.append(wrap, link, this.#copyButton(url, "Copy URL"));
        // Best-effort: pop the browser tab so the user doesn't have to click.
        try {
            window.open(url, "_blank", "noreferrer");
        } catch {
            /* popup blocked — the link above is the fallback */
        }
    }

    #showDeviceCode(m: LoginFrame) {
        this.#status("Enter this code in your browser:");
        const code = document.createElement("div");
        code.className = "login-code";
        code.textContent = m.userCode || "";
        this.#info.append(
            code,
            this.#copyButton(m.userCode || "", "Copy code"),
        );
        if (m.verificationUri) {
            const link = document.createElement("a");
            link.href = m.verificationUri;
            link.target = "_blank";
            link.rel = "noreferrer";
            link.className = "login-url";
            link.textContent = m.verificationUri;
            this.#info.appendChild(link);
            try {
                window.open(m.verificationUri, "_blank", "noreferrer");
            } catch {
                /* popup blocked */
            }
        }
        this.#status("Waiting for authorization…");
    }

    #copyButton(text: string, label: string) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "login-btn login-copy";
        b.textContent = label;
        b.onclick = () => {
            navigator.clipboard?.writeText(text).then(
                () => {
                    b.textContent = "Copied ✓";
                    setTimeout(() => (b.textContent = label), 1200);
                },
                () => {},
            );
        };
        return b;
    }

    // Render the current interactive prompt: a text/secret/manual-code input, or
    // a set of option buttons for a select.
    #showPrompt(m: LoginFrame) {
        this.#promptArea.innerHTML = "";
        if (m.message) {
            const msg = document.createElement("div");
            msg.className = "login-line";
            msg.textContent = m.message;
            this.#promptArea.appendChild(msg);
        }
        if (m.promptKind === "select") {
            (m.options || []).forEach((opt) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "login-btn login-option";
                b.textContent = opt.label;
                b.onclick = () => this.#respond(opt.id);
                this.#promptArea.appendChild(b);
            });
            const first = this.#promptArea.querySelector(
                "button",
            ) as HTMLButtonElement | null;
            first?.focus();
            return;
        }
        const row = document.createElement("div");
        row.className = "login-input-row";
        const input = document.createElement("input");
        input.type = m.promptKind === "secret" ? "password" : "text";
        input.className = "model-search login-field";
        input.placeholder = m.placeholder || "";
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                if (input.value || m.allowEmpty) this.#respond(input.value);
            }
        });
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "login-btn";
        submit.textContent = "Submit";
        submit.onclick = () => {
            if (input.value || m.allowEmpty) this.#respond(input.value);
        };
        row.append(input, submit);
        this.#promptArea.appendChild(row);
        input.focus();
    }

    #respond(value: string) {
        if (!this.#loginId) return;
        this.#promptArea.innerHTML = "";
        this.#status("Submitting…");
        this.dispatchEvent(
            new CustomEvent("pi-login-respond", {
                bubbles: true,
                detail: { loginId: this.#loginId, value },
            }),
        );
    }

    #addCloseButton() {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "login-btn";
        b.textContent = "Close";
        b.onclick = () => this.close();
        this.#promptArea.appendChild(b);
        b.focus();
    }

    #autoClose() {
        if (this.#closeTimer) clearTimeout(this.#closeTimer);
        this.#closeTimer = setTimeout(() => this.close(), 1400);
    }

    close() {
        if (this.#closeTimer) {
            clearTimeout(this.#closeTimer);
            this.#closeTimer = null;
        }
        this.classList.remove("show");
        this.#rows = [];
        this.#index = 0;
        this.#loginId = null;
        this.#info.innerHTML = "";
        this.#promptArea.innerHTML = "";
    }

    #cancel() {
        if (!this.visible) return;
        const loginId = this.#loginId;
        this.close();
        this.dispatchEvent(
            new CustomEvent("pi-login-cancel", {
                bubbles: true,
                detail: { loginId },
            }),
        );
    }

    // ---- keyboard / backdrop ------------------------------------------------

    #onDocKey = (e: KeyboardEvent) => {
        if (!this.visible) return;
        // Arrow nav only matters while the provider picker is showing.
        const picking = this.#list.style.display !== "none";
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.#cancel();
            return;
        }
        if (!picking) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            this.#setSel(this.#index + 1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            this.#setSel(this.#index - 1);
        } else if (e.key === "Enter") {
            e.preventDefault();
            const p = this.#providers[this.#index];
            if (p) this.#pick(p);
        }
    };

    #onBackdrop = (e: MouseEvent) => {
        if (e.target === this) this.#cancel();
    };
}

if (!customElements.get("pi-login")) customElements.define("pi-login", PiLogin);
