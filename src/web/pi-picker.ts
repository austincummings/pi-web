// <pi-picker> — the modal overlay "picker" chrome shared by the resume-thread
// selector, the generic list pickers (/tree, /fork, /trust, …), the searchable
// /model selector, and the read-only overlays (hotkeys, etc.).
//
// It owns the fullscreen backdrop (#overlay), the centered card (.picker#picker
// that callers build their content into via `card`), show/hide visibility, the
// backdrop-click close, and the *generic* keyboard navigation loop
// (Up/Down/Home/End/Enter over `items`). Feature-specific keys (the resume
// picker's Ctrl+D delete + its Enter/Esc delete-confirm gating) are claimed by
// the host through `keyGuard` before the generic loop runs — the same seam
// <pi-composer> uses.
//
// Light DOM (no Shadow DOM) so the global CSS (#overlay, .picker, .item.sel,
// --acc, …) applies unchanged.
//
// Events (bubble):
//   pi-picker-backdrop  — the user clicked the backdrop (host runs its close)
//
// Public API:
//   card        — the inner .picker element to append content into
//   visible     — whether the overlay is shown
//   nav         — enable the shared arrow/Enter navigation for this open
//   items       — the selectable rows, in visual order (host assigns per open)
//   index       — the highlighted row index
//   setSel(i)   — move the highlight (wraps), scrolling it into view
//   show()/hide() — toggle visibility (hide resets nav/items/index)
//   keyGuard    — (e) => boolean; claim a key before the generic nav loop

export class PiPicker extends HTMLElement {
    #card!: HTMLElement;
    // Selectable rows in visual order; the host rebuilds these per open. `nav`
    // gates the generic arrow/Enter loop so non-nav consumers (showOverlay, the
    // model picker's own key handling) aren't affected.
    items: HTMLElement[] = [];
    nav = false;
    #index = -1;
    /** Host hook: claim a key before the generic nav loop (return true = handled). */
    keyGuard: ((e: KeyboardEvent) => boolean) | null = null;

    get card() {
        return this.#card;
    }
    get visible() {
        return this.classList.contains("show");
    }
    get index() {
        return this.#index;
    }

    connectedCallback() {
        // The element itself is the #overlay backdrop; it hosts one .picker card
        // that callers populate. Reuse an existing child if present (SSR/markup).
        this.#card =
            (this.querySelector(".picker") as HTMLElement) ||
            document.createElement("div");
        if (!this.#card.isConnected) {
            this.#card.className = "picker";
            this.#card.id = "picker";
            this.appendChild(this.#card);
        }
        this.addEventListener("click", this.#onBackdrop);
        document.addEventListener("keydown", this.#onNavKey);
    }

    disconnectedCallback() {
        this.removeEventListener("click", this.#onBackdrop);
        document.removeEventListener("keydown", this.#onNavKey);
    }

    setSel(i: number) {
        if (!this.items.length) return;
        this.#index = (i + this.items.length) % this.items.length;
        this.items.forEach((el, idx) =>
            el.classList.toggle("sel", idx === this.#index),
        );
        this.items[this.#index].scrollIntoView({ block: "nearest" });
    }

    show() {
        this.classList.add("show");
    }

    // Hide and reset the shared nav state. The host's own close path
    // (closePicker) still handles composer refocus + feature state.
    hide() {
        this.classList.remove("show");
        this.nav = false;
        this.items = [];
        this.#index = -1;
    }

    // Generic picker navigation: Up/Down move the selection, Home/End jump to the
    // ends, Enter activates the highlighted row. Ignores the keystroke that
    // opened the picker (defaultPrevented) and yields to the host's keyGuard
    // (delete-confirm / Ctrl+D) first — matching the pre-extraction ordering.
    #onNavKey = (e: KeyboardEvent) => {
        if (!this.nav || !this.visible) return;
        if (e.defaultPrevented) return;
        if (this.keyGuard?.(e)) return;
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                this.setSel(this.#index + 1);
                break;
            case "ArrowUp":
                e.preventDefault();
                this.setSel(this.#index - 1);
                break;
            case "Home":
                e.preventDefault();
                this.setSel(0);
                break;
            case "End":
                e.preventDefault();
                this.setSel(this.items.length - 1);
                break;
            case "Enter":
                e.preventDefault();
                this.items[this.#index]?.click();
                break;
        }
    };

    // Backdrop click (outside the card) → let the host run its close path.
    #onBackdrop = (e: MouseEvent) => {
        if (e.target === this)
            this.dispatchEvent(
                new CustomEvent("pi-picker-backdrop", { bubbles: true }),
            );
    };
}

if (!customElements.get("pi-picker"))
    customElements.define("pi-picker", PiPicker);
