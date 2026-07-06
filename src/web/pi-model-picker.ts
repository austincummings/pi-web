// <pi-model-picker> — the searchable /model selector, mirroring the pi TUI's
// model picker: a search box over a fuzzy-ranked, keyboard-navigable list (the
// active model marked, subscription/thinking models tagged).
//
// Extracted from app.ts as its own standalone overlay (like <pi-dialog>): it
// owns its backdrop, card, search input, fuzzy filtering, keyboard nav, and
// self-closes. The host feeds it the model list via open() and reacts to the
// events — it stays agnostic about /models fetching and /model POSTing.
//
// Light DOM (no Shadow DOM) so the shared CSS (#overlay/pi-model-picker,
// .picker, .model-search, .model-list, .item.sel, --acc, …) applies unchanged.
//
// Events (bubble):
//   pi-model-choose { provider, id }  — the user picked a model
//   pi-model-cancel                    — dismissed (Escape / backdrop)
//
// Public API:
//   open(models, query?)  — populate + show (focuses the search box)
//   close()               — hide + reset
//   visible               — whether the overlay is shown
import { fuzzyFilter } from "./fuzzy.ts";

// compact token formatting, mirroring the pi TUI footer's formatTokens
function fmtTokens(n: number) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + "k";
    if (n < 1000000) return Math.round(n / 1000) + "k";
    if (n < 10000000) return (n / 1000000).toFixed(1) + "M";
    return Math.round(n / 1000000) + "M";
}

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

export class PiModelPicker extends HTMLElement {
    #card!: HTMLElement;
    #search!: HTMLInputElement;
    #list!: HTMLElement;
    #models: any[] = []; // full list from open()
    #filtered: any[] = []; // data behind the rendered rows
    #rows: HTMLElement[] = []; // rendered row elements
    #index = 0;

    get visible() {
        return this.classList.contains("show");
    }

    connectedCallback() {
        this.#card = document.createElement("div");
        this.#card.className = "picker";
        const h = document.createElement("h3");
        h.textContent = "Select model";
        this.#search = document.createElement("input");
        this.#search.type = "text";
        this.#search.className = "model-search";
        this.#search.placeholder = "search models…";
        this.#list = document.createElement("div");
        this.#list.className = "model-list";
        this.#card.append(h, this.#search, this.#list);
        this.appendChild(this.#card);

        this.addEventListener("click", this.#onBackdrop);
        this.#search.addEventListener("input", this.#onInput);
        this.#search.addEventListener("keydown", this.#onSearchKey);
        // Escape via a capture-phase document listener (highest precedence, like
        // <pi-dialog>): closes the picker before the app's global Escape chain
        // can interrupt the agent.
        document.addEventListener("keydown", this.#onDocKey, true);
    }

    disconnectedCallback() {
        this.removeEventListener("click", this.#onBackdrop);
        this.#search.removeEventListener("input", this.#onInput);
        this.#search.removeEventListener("keydown", this.#onSearchKey);
        document.removeEventListener("keydown", this.#onDocKey, true);
    }

    open(models: any[], query = "") {
        this.#models = models || [];
        this.#index = 0;
        this.#search.value = query;
        this.#render(query);
        this.classList.add("show");
        this.#search.focus();
    }

    close() {
        this.classList.remove("show");
        this.#rows = [];
        this.#filtered = [];
        this.#index = 0;
    }

    #setSel(i: number) {
        if (!this.#rows.length) return;
        this.#index = (i + this.#rows.length) % this.#rows.length;
        this.#rows.forEach((el, idx) =>
            el.classList.toggle("sel", idx === this.#index),
        );
        this.#rows[this.#index].scrollIntoView({ block: "nearest" });
    }

    // Fuzzy-rank + render the model rows for the current query, preselecting the
    // active model (else the first row).
    #render(query: string) {
        const ranked = query
            ? fuzzyFilter(this.#models, query, (m) => modelSearchText(m))
            : this.#models;
        this.#filtered = ranked;
        this.#rows = [];
        this.#list.innerHTML = "";
        if (!ranked.length) {
            const empty = document.createElement("div");
            empty.className = "item";
            empty.innerHTML =
                '<span class="name hint">no matching models</span>';
            this.#list.appendChild(empty);
            return;
        }
        ranked.forEach((m: any) => {
            const item = document.createElement("div");
            item.className = "item" + (m.current ? " active" : "");
            const n = document.createElement("span");
            n.className = "name";
            n.textContent = `${m.provider}/${m.id}`;
            const meta = document.createElement("span");
            meta.className = "meta";
            meta.textContent = modelMeta(m);
            item.append(n, meta);
            item.onclick = () => this.#choose(m);
            this.#list.appendChild(item);
            this.#rows.push(item);
        });
        const activeIdx = ranked.findIndex((m: any) => m.current);
        this.#setSel(activeIdx >= 0 ? activeIdx : 0);
    }

    #choose(m: any) {
        this.close();
        this.dispatchEvent(
            new CustomEvent("pi-model-choose", {
                bubbles: true,
                detail: { provider: m.provider, id: m.id },
            }),
        );
    }

    #cancel() {
        if (!this.visible) return;
        this.close();
        this.dispatchEvent(
            new CustomEvent("pi-model-cancel", { bubbles: true }),
        );
    }

    #onInput = () => this.#render(this.#search.value);

    #onSearchKey = (e: KeyboardEvent) => {
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                this.#setSel(this.#index + 1);
                break;
            case "ArrowUp":
                e.preventDefault();
                this.#setSel(this.#index - 1);
                break;
            case "Enter": {
                e.preventDefault();
                const m = this.#filtered[this.#index];
                if (m) this.#choose(m);
                break;
            }
        }
    };

    #onDocKey = (e: KeyboardEvent) => {
        if (!this.visible || e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        this.#cancel();
    };

    #onBackdrop = (e: MouseEvent) => {
        if (e.target === this) this.#cancel();
    };
}

if (!customElements.get("pi-model-picker"))
    customElements.define("pi-model-picker", PiModelPicker);
