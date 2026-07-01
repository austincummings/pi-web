// <pi-thinking> — the streaming thinking/reasoning trace in the transcript.
//
// Mirrors pi-tui's collapsible reasoning block: an uppercase "thinking" header
// over a markdown-rendered body. The element owns its own raw text and
// re-renders markdown internally, throttling streamed deltas to one paint per
// animation frame so a burst of tokens doesn't thrash innerHTML.
//
// Visibility stays app-global: the show/hide toggle lives at the app level
// (`body.hide-thinking` CSS, persisted to pi's `hideThinkingBlock` setting), so
// the element only emits a bubbling `pithinking-toggle` event when its header is
// clicked and otherwise just respects the shared stylesheet. It carries the
// existing `.thinking-block` classes (light DOM, no Shadow DOM); after each
// paint it emits `pithinking-render` so the host — which owns the transcript —
// can keep the view scrolled to the latest text.

import { renderMarkdown } from "./markdown.ts";

// The shape of an SSE `thinking` frame.
export interface ThinkingFrame {
    status?: "start" | "delta" | "end" | "full" | string;
    text?: string;
}

export class PiThinking extends HTMLElement {
    /** Accumulated thinking text (rendered as markdown). */
    private raw = "";
    private body: HTMLElement | null = null;
    private renderPending = false;
    private built = false;

    connectedCallback(): void {
        if (!this.built) {
            this.built = true;
            this.build();
        }
    }

    private build(): void {
        this.className = "thinking-block";
        this.innerHTML =
            '<div class="think-head">thinking</div><div class="think-body"></div>';
        this.body = this.querySelector(".think-body");
        (this.querySelector(".think-head") as HTMLElement).onclick = () =>
            this.emit("pithinking-toggle");
    }

    /** Apply one SSE `thinking` frame (`start`/`delta`/`end`/`full`). */
    apply(m: ThinkingFrame): void {
        if (!this.built) {
            this.built = true;
            this.build();
        }
        if (m.status === "start") {
            this.raw = "";
            this.renderNow();
        } else if (m.status === "delta") {
            this.raw += m.text || "";
            this.scheduleRender();
        } else if (m.status === "full") {
            // non-streamed (replay / cached): render in one shot
            this.raw = m.text || "";
            this.renderNow();
        } else if (m.status === "end") {
            // flush any pending delta immediately
            this.renderNow();
        }
    }

    // Throttle streaming re-renders to one paint per animation frame.
    private scheduleRender(): void {
        if (this.renderPending) return;
        this.renderPending = true;
        requestAnimationFrame(() => {
            this.renderPending = false;
            this.renderNow();
        });
    }

    private renderNow(): void {
        this.renderPending = false;
        if (this.body) this.body.innerHTML = renderMarkdown(this.raw);
        this.emit("pithinking-render");
    }

    private emit(type: string): void {
        this.dispatchEvent(
            new CustomEvent(type, { bubbles: true, composed: true }),
        );
    }
}

if (!customElements.get("pi-thinking")) {
    customElements.define("pi-thinking", PiThinking);
}

declare global {
    interface HTMLElementTagNameMap {
        "pi-thinking": PiThinking;
    }
    interface HTMLElementEventMap {
        "pithinking-toggle": CustomEvent<void>;
        "pithinking-render": CustomEvent<void>;
    }
}
