// <pi-tool> — one tool-call card in the transcript.
//
// Mirrors pi-tui's default tool-result view: a header (pending marker + bold
// name + accented primary arg + muted context) and a result body collapsed to
// MAX_TOOL_LINES until expanded (click the "more" affordance for this one card,
// or alt+o to toggle every card at once). The TUI conveys status by tinting the
// whole block rather than a glyph, so the element carries the `.tool` /
// `.tool.pending` / `.tool.error`
// classes and the shared stylesheet does the rest (light DOM, no Shadow DOM).
//
// The element owns its own `info` state, expand/collapse, and rendering. The
// host feeds it SSE `tool` frames via apply() and drives expansion via
// setExpanded() (session-wide alt+o) or toggleExpanded() (per-card click);
// scrolling stays with the host (it owns the transcript).

import type { FrameNode } from "../shared/frames.ts";
import {
    toolTitle,
    truncateResult,
    getToolRenderer,
    formatDuration,
    type ToolInfo,
} from "./tools.ts";
import { renderStaticNode } from "./nodes.ts";

// The shape of an SSE `tool` frame (start = name+args; end = result+isError).
export interface ToolFrame {
    id: string;
    name?: string;
    args?: unknown;
    status?: "start" | "end" | string;
    result?: unknown;
    isError?: boolean;
    details?: unknown;
    /** How long the tool ran, in ms (host-stamped; live turns only). */
    durationMs?: number;
    /**
     * A host-adapted serializable node tree for a tool's custom renderResult
     * (render-model parity P1). Currently an `AnsiBlock` node; painted in place
     * of the default body when no registered client renderer applies.
     */
    tree?: FrameNode;
}

export class PiTool extends HTMLElement {
    /** The tool call id (also reflected to the `call-id` attribute). */
    callId = "";
    /** cwd for relativizing tool paths in the header (from the config frame). */
    cwd = "";

    readonly info: ToolInfo = {
        name: "",
        args: undefined,
        result: "",
        isError: false,
        pending: true,
        expanded: false,
        details: undefined,
    };

    private built = false;
    /** Host-adapted renderResult tree (Parity P1); see ToolFrame.tree. */
    private tree: FrameNode | null = null;

    connectedCallback(): void {
        if (!this.built) {
            this.built = true;
            this.render();
        }
    }

    /** Apply one SSE `tool` frame and re-render (no scrolling — host's job). */
    apply(m: ToolFrame, cwd: string): void {
        this.cwd = cwd;
        if (m.name != null) this.info.name = m.name;
        if (m.status === "start") {
            this.info.args = m.args;
            this.info.pending = true;
        } else {
            this.info.pending = false;
            this.info.isError = !!m.isError;
            if (m.result != null) this.info.result = String(m.result);
            if (m.details != null) this.info.details = m.details;
            if (m.durationMs != null) this.info.durationMs = m.durationMs;
            if (m.tree != null) this.tree = m.tree;
        }
        this.render();
    }

    /** Flip the result expand/collapse state (alt+o / click). */
    toggleExpanded(): void {
        this.info.expanded = !this.info.expanded;
        this.render();
    }

    /**
     * Set the expand/collapse state directly (pi ui.setToolsExpanded fan-out).
     * No-ops (no re-render) when already in the requested state.
     */
    setExpanded(on: boolean): void {
        if (this.info.expanded === !!on) return;
        this.info.expanded = !!on;
        this.render();
    }

    private render(): void {
        const info = this.info;
        this.className =
            "tool" +
            (info.isError ? " error" : "") +
            (info.pending ? " pending" : "");
        this.innerHTML = "";

        const head = document.createElement("div");
        head.className = "tool-head";
        head.innerHTML =
            '<span class="tool-name"></span> ' +
            '<span class="tool-args"></span><span class="tool-dim"></span>';
        const title = toolTitle(info.name, info.args, this.cwd);
        (head.querySelector(".tool-name") as HTMLElement).textContent =
            title.name;
        (head.querySelector(".tool-args") as HTMLElement).textContent =
            title.args;
        // Append how long the tool took to the muted context (host-stamped;
        // absent on replay, so it simply doesn't show there).
        const dur = info.pending ? "" : formatDuration(info.durationMs);
        (head.querySelector(".tool-dim") as HTMLElement).textContent =
            title.dim + (dur ? ` · ${dur}` : "");
        this.appendChild(head);

        // Extension override: a registered renderer may replace the body.
        const custom = getToolRenderer(info.name);
        if (custom) {
            try {
                const node = custom({ ...info });
                if (node) {
                    this.appendChild(node);
                    return;
                }
            } catch {
                /* fall through to the default rendering */
            }
        }

        // Render-model parity: a tool's custom renderResult arrives as a
        // host-adapted node tree (AnsiBlock leaf, or a structural Box/Image/
        // Spacer tree — P2). Paint it via the shared static-node renderer
        // (unless a registered renderer above already handled the body). Falls
        // through if absent/unknown.
        if (this.tree) {
            const el = renderStaticNode(this.tree);
            if (el) {
                this.appendChild(el);
                return;
            }
        }

        if (!info.result) return;

        const { shown, hidden } = truncateResult(info.result, !!info.expanded);
        const makeMore = (label: string) => {
            const more = document.createElement("div");
            more.className = "tool-more";
            more.textContent = label;
            more.onclick = () => this.toggleExpanded();
            return more;
        };
        // Collapsed: the preview is the tail, so the "N earlier lines" hint goes
        // ABOVE it (matching pi-tui). Expanded: a "collapse" affordance below.
        if (hidden > 0) {
            this.appendChild(
                makeMore(
                    `… ${hidden} earlier line${hidden === 1 ? "" : "s"} (alt+o)`,
                ),
            );
        }
        const body = document.createElement("pre");
        body.className = "tool-body";
        body.textContent = shown;
        this.appendChild(body);
        if (info.expanded) this.appendChild(makeMore("collapse (alt+o)"));
    }
}

if (!customElements.get("pi-tool")) {
    customElements.define("pi-tool", PiTool);
}

declare global {
    interface HTMLElementTagNameMap {
        "pi-tool": PiTool;
    }
}
