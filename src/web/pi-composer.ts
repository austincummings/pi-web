// <pi-composer> — the message composer as a self-contained custom element
// (prototype for the app.ts → custom-element refactor; see the review notes).
//
// This is the "biggest win" vertical slice: the composer owns the most scattered
// module-level state in app.ts (pasted images, the steering queue, prompt
// history, the working spinner). Folding it into an element turns all of that
// into *instance fields*, moves listener/timer cleanup into the lifecycle
// callbacks, and — crucially — inverts the dependencies: instead of importing
// and calling `runInput`/`restoreQueue`, the composer *emits* CustomEvents the
// host wires up. That's what lets the old app.ts ↔ composer import cycle go away.
//
// Light DOM only (no Shadow DOM), matching <pi-bash>/<pi-tool>/<pi-thinking>, so
// the global stylesheet in index.html keeps applying. The host keeps the same
// `.composer` / `#prompt` / `#backdrop` markup + class names, so the existing CSS
// (thinking-level border, backdrop highlight, attachment chips) is unchanged.
//
// Events emitted (all bubbling + composed):
//   pi-submit  { text, images }  Enter (no Shift) with non-empty text/images
//   pi-dequeue                    a queued steering row was clicked
//   pi-escape                     Escape pressed in the textarea
//   pi-input   { text, caret }    text changed (host drives `@`/`/` autocomplete)
//
// Host seam: set `keyGuard` to intercept a keystroke before the element's own
// default handling (history / submit). The host's autocomplete uses it to claim
// Arrow/Tab/Enter while its dropdown is open, and to route Shift+Tab (thinking
// cycle) / Alt+Up (dequeue) / Tab (force bash completion). Returning true means
// "handled \u2014 stop": the element does nothing else with that event.

import { highlightComposer } from "./markdown.ts";

/** A pasted/attached image waiting to be sent with the next message. */
export interface Attachment {
    data: string;
    mimeType: string;
    url: string;
}

// Braille spinner frames @ 80ms (matches pi-tui's Loader and <pi-bash>).
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Up/Down prompt-history browser, extracted as a plain class so it's unit
 * testable on its own (and reusable). `up`/`down` return the text to show, or
 * null when there's nowhere to move. The in-progress draft is stashed on the
 * first `up` and restored when you walk back past the newest entry.
 */
export class PromptHistory {
    #items: string[] = [];
    #index: number | null = null;
    #draft = "";

    /** Record a submitted line (dedupes consecutive repeats) and reset browsing. */
    push(text: string): void {
        const t = text.trim();
        if (t && this.#items[this.#items.length - 1] !== t) this.#items.push(t);
        this.reset();
    }

    reset(): void {
        this.#index = null;
        this.#draft = "";
    }

    /** Move to an older entry; returns its text, or null at the top. */
    up(current: string): string | null {
        if (!this.#items.length) return null;
        if (this.#index === null) {
            this.#draft = current;
            this.#index = this.#items.length;
        }
        if (this.#index === 0) return null;
        this.#index -= 1;
        return this.#items[this.#index] ?? null;
    }

    /** Move to a newer entry; past the newest, restores the stashed draft. */
    down(): string | null {
        if (this.#index === null) return null;
        this.#index += 1;
        if (this.#index >= this.#items.length) {
            this.#index = null;
            const draft = this.#draft;
            this.#draft = "";
            return draft;
        }
        return this.#items[this.#index] ?? null;
    }
}

const MARKUP = `
<div id="ac" class="ac"></div>
<div id="queued" class="queued" aria-live="polite"></div>
<div id="working" class="working" aria-live="polite"><span class="spin"></span><span class="label">Working…</span></div>
<div id="attachments" class="attachments" aria-live="polite"></div>
<form id="ask">
  <div class="input-wrap">
    <div id="backdrop" class="backdrop" aria-hidden="true"></div>
    <textarea id="prompt" rows="1" placeholder="message pi…  (/ commands · ! shell · @ files)" autocomplete="off"></textarea>
  </div>
</form>`;

export class PiComposer extends HTMLElement {
    #images: Attachment[] = [];
    #queue: string[] = [];
    #history = new PromptHistory();

    #built = false;
    #busy = false;
    #spinTimer: ReturnType<typeof setInterval> | null = null;
    #spinIndex = 0;
    // Streaming working-indicator overrides (pi ui.setWorking*). Undefined
    // fields fall back to the defaults (label "Working\u2026", braille @ 80ms,
    // shown while busy).
    #workCfg: {
        message?: string;
        visible?: boolean;
        frames?: string[];
        intervalMs?: number;
    } = {};

    /**
     * Optional host hook: claim a keystroke before the element's own default
     * handling. Return true to stop (the host handled it). Used by the host's
     * autocomplete / thinking-cycle / dequeue routing.
     */
    keyGuard: ((e: KeyboardEvent) => boolean) | null = null;

    // Resolved lazily after the markup is built.
    #ta!: HTMLTextAreaElement;
    #backdrop!: HTMLElement;
    #queuedEl!: HTMLElement;
    #workingEl!: HTMLElement;
    #attachEl!: HTMLElement;

    connectedCallback(): void {
        if (!this.#built) {
            this.#built = true;
            this.className = "composer";
            this.innerHTML = MARKUP;
            this.#ta = this.querySelector("#prompt") as HTMLTextAreaElement;
            this.#backdrop = this.querySelector("#backdrop") as HTMLElement;
            this.#queuedEl = this.querySelector("#queued") as HTMLElement;
            this.#workingEl = this.querySelector("#working") as HTMLElement;
            this.#attachEl = this.querySelector("#attachments") as HTMLElement;
            this.#ta.addEventListener("input", this.#onInput);
            this.#ta.addEventListener("keydown", this.#onKeydown);
            // keep the highlight backdrop scroll-locked to the textarea
            this.#ta.addEventListener("scroll", () => {
                this.#backdrop.scrollTop = this.#ta.scrollTop;
                this.#backdrop.scrollLeft = this.#ta.scrollLeft;
            });
            this.querySelector("#ask")!.addEventListener("submit", (e) => {
                e.preventDefault();
                this.#submit();
            });
            this.#syncHighlight();
        }
    }

    disconnectedCallback(): void {
        this.#stopSpinner();
    }

    // ---- value -----------------------------------------------------------
    get value(): string {
        return this.#ta?.value ?? "";
    }
    set value(text: string) {
        if (!this.#ta) return;
        this.#ta.value = text;
        this.#syncHighlight();
        this.#autoGrow();
    }

    /** The pending attachments (read-only snapshot). */
    get images(): Attachment[] {
        return this.#images.slice();
    }

    // ---- host-driven updates (called by the SSE dispatcher) --------------
    /**
     * Seed the Up/Down history with a previously-sent line (the host replays
     * per-thread history over SSE, which has no matching submit).
     */
    pushHistory(text: string): void {
        this.#history.push(text);
    }

    /** Replace the steering-queue rows shown above the composer. */
    setQueue(items: string[]): void {
        this.#queue = items.slice();
        this.#renderQueue();
    }

    /** Show/hide the working spinner (drives the braille animation). */
    setWorking(on: boolean): void {
        this.#busy = on;
        this.#applyWorking();
    }

    /**
     * Apply streaming working-indicator overrides (pi ui.setWorking*). Omitted
     * fields fall back to the defaults; call with `{}` to reset.
     */
    setWorkingConfig(cfg: {
        message?: string;
        visible?: boolean;
        frames?: string[];
        intervalMs?: number;
    }): void {
        this.#workCfg = { ...cfg };
        this.#applyWorking();
    }

    #applyWorking(): void {
        if (!this.#workingEl) return;
        const cfg = this.#workCfg;
        const visible = cfg.visible ?? this.#busy;
        this.#workingEl.classList.toggle("show", visible);
        const label = this.#workingEl.querySelector(".label");
        if (label) label.textContent = cfg.message ?? "Working\u2026";
        // frames: [] hides the glyph; custom frames render verbatim; undefined
        // uses the default braille spinner.
        const frames =
            cfg.frames && cfg.frames.length ? cfg.frames : SPIN_FRAMES;
        const animate = visible && cfg.frames?.length !== 0;
        this.#stopSpinner();
        const spin = this.#workingEl.querySelector(".spin");
        if (spin && cfg.frames?.length === 0) spin.textContent = "";
        if (animate) {
            this.#spinIndex = 0;
            const tick = () => {
                const el = this.#workingEl.querySelector(".spin");
                if (el)
                    el.textContent = frames[this.#spinIndex % frames.length];
                this.#spinIndex += 1;
            };
            tick();
            this.#spinTimer = setInterval(tick, cfg.intervalMs ?? 80);
        }
    }

    /** Set the focused-border reasoning level (mirrors app.ts data-think). */
    setThinking(level: string, bash = false): void {
        if (level) this.dataset.think = level;
        else delete this.dataset.think;
        if (bash) this.dataset.bash = "";
        else delete this.dataset.bash;
    }

    /** Add a pasted/dropped image chip. */
    addImage(att: Attachment): void {
        this.#images.push(att);
        this.#renderAttachments();
    }

    /** Clear text + attachments (after a successful submit). */
    clear(): void {
        this.#images = [];
        this.#renderAttachments();
        this.value = "";
    }

    focusInput(): void {
        this.#ta?.focus();
    }

    /** Current caret offset in the textarea. */
    getCaret(): number {
        return this.#ta?.selectionStart ?? this.value.length;
    }

    /**
     * Replace `[start, end)` of the composer text with `text` and place the
     * caret at its end (used by the host's autocomplete to accept a completion).
     */
    spliceRange(start: number, end: number, text: string): void {
        const v = this.value;
        const next = v.slice(0, start) + text + v.slice(end);
        this.value = next;
        const caret = start + text.length;
        this.#ta.selectionStart = this.#ta.selectionEnd = caret;
        this.#ta.focus();
    }

    // ---- internals -------------------------------------------------------
    /** Re-sync the highlight backdrop + autosize without touching value/caret
     * (the host calls this after writing the textarea value directly). */
    reflow(): void {
        this.#syncHighlight();
        this.#autoGrow();
    }

    #onInput = (): void => {
        // typing over a recalled history entry makes it the new draft
        this.#history.reset();
        this.#syncHighlight();
        this.#autoGrow();
        this.dispatchEvent(
            new CustomEvent("pi-input", {
                bubbles: true,
                composed: true,
                detail: { text: this.value, caret: this.#ta.selectionStart },
            }),
        );
    };

    #onKeydown = (e: KeyboardEvent): void => {
        // Host gets first refusal (autocomplete nav, thinking cycle, dequeue).
        if (this.keyGuard?.(e)) return;
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            this.#submit();
            return;
        }
        if (e.key === "Escape") {
            this.dispatchEvent(
                new CustomEvent("pi-escape", { bubbles: true, composed: true }),
            );
            return;
        }
        if (e.key === "ArrowUp" && this.#caretOnFirstLine()) {
            const prev = this.#history.up(this.value);
            if (prev !== null) {
                e.preventDefault();
                this.value = prev;
                this.#caretToEnd();
            }
        } else if (e.key === "ArrowDown" && this.#caretOnLastLine()) {
            const next = this.#history.down();
            if (next !== null) {
                e.preventDefault();
                this.value = next;
                this.#caretToEnd();
            }
        }
    };

    #submit(): void {
        const text = this.value;
        if (!text.trim() && this.#images.length === 0) return;
        this.dispatchEvent(
            new CustomEvent("pi-submit", {
                bubbles: true,
                composed: true,
                detail: { text, images: this.images },
            }),
        );
        this.#history.push(text);
        this.clear();
    }

    #syncHighlight(): void {
        if (this.#backdrop)
            this.#backdrop.innerHTML = highlightComposer(this.value);
    }

    #autoGrow(): void {
        const ta = this.#ta;
        if (!ta) return;
        ta.style.height = "auto";
        if (ta.scrollHeight) ta.style.height = `${ta.scrollHeight}px`;
    }

    #caretOnFirstLine(): boolean {
        const c = this.#ta.selectionStart ?? 0;
        return this.value.lastIndexOf("\n", c - 1) === -1;
    }
    #caretOnLastLine(): boolean {
        const c = this.#ta.selectionStart ?? 0;
        return this.value.indexOf("\n", c) === -1;
    }
    #caretToEnd(): void {
        const n = this.value.length;
        this.#ta.selectionStart = this.#ta.selectionEnd = n;
    }

    #renderQueue(): void {
        const el = this.#queuedEl;
        el.innerHTML = "";
        el.classList.toggle("show", this.#queue.length > 0);
        this.#queue.forEach((text, i) => {
            const row = document.createElement("div");
            row.className = "queued-item";
            const badge = document.createElement("span");
            badge.className = "queued-badge";
            badge.textContent = `${i + 1}`;
            const body = document.createElement("span");
            body.className = "queued-text";
            body.textContent = text;
            row.append(badge, body);
            row.onclick = () =>
                this.dispatchEvent(
                    new CustomEvent("pi-dequeue", {
                        bubbles: true,
                        composed: true,
                    }),
                );
            el.appendChild(row);
        });
    }

    #renderAttachments(): void {
        const el = this.#attachEl;
        el.innerHTML = "";
        el.classList.toggle("show", this.#images.length > 0);
        this.#images.forEach((img, i) => {
            const chip = document.createElement("div");
            chip.className = "attach-chip";
            const thumb = document.createElement("img");
            thumb.src = img.url;
            const rm = document.createElement("button");
            rm.className = "attach-remove";
            rm.type = "button";
            rm.textContent = "×";
            rm.onclick = () => {
                this.#images.splice(i, 1);
                this.#renderAttachments();
            };
            chip.append(thumb, rm);
            el.appendChild(chip);
        });
    }

    #stopSpinner(): void {
        if (this.#spinTimer) {
            clearInterval(this.#spinTimer);
            this.#spinTimer = null;
        }
    }
}

if (!customElements.get("pi-composer")) {
    customElements.define("pi-composer", PiComposer);
}
