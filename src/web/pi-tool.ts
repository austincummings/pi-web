// <pi-tool> — one tool-call card in the transcript.
//
// Mirrors pi-tui's tool-result view: a header (pending marker + bold name +
// accented primary arg + muted context) and a tool-specific result body. Most
// tools collapse to a short tail until expanded; read delegates to its own
// renderer to match pi-tui. The TUI conveys status by tinting the whole block
// rather than a glyph, so the element carries the `.tool` / `.tool.pending` /
// `.tool.error` classes and the shared stylesheet does the rest (light DOM, no
// Shadow DOM).
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
import { readMoreLabel, readResultParts } from "./read-tool.ts";

const WRITE_PREVIEW_LINES = 10;
const RESULT_PREVIEW_LINES: Record<string, number> = {
    grep: 15,
    find: 20,
    ls: 20,
};
const SGR_RE = /\x1b\[[0-9;]*m/g;

function isBlankAnsiLine(line: string): boolean {
    return line.replace(SGR_RE, "").trim() === "";
}

function stripLeadingBlankLines(node: FrameNode): FrameNode | null {
    if (node.type !== "AnsiBlock" || !Array.isArray(node.lines)) return node;
    const lines = [...node.lines];
    while (lines.length && isBlankAnsiLine(lines[0])) lines.shift();
    return lines.length ? { ...node, lines } : null;
}

function stripWriteHeader(node: FrameNode): FrameNode | null {
    if (node.type !== "AnsiBlock" || !Array.isArray(node.lines)) return node;
    return stripLeadingBlankLines({ ...node, lines: node.lines.slice(1) });
}

function writeCollapsedPreviewFromExpanded(node: FrameNode): FrameNode | null {
    const body = stripWriteHeader(node);
    if (body?.type !== "AnsiBlock" || !Array.isArray(body.lines)) return body;
    const total = body.lines.length;
    if (total <= WRITE_PREVIEW_LINES) return body;
    const remaining = total - WRITE_PREVIEW_LINES;
    return {
        ...body,
        lines: [
            ...body.lines.slice(0, WRITE_PREVIEW_LINES),
            `... (${remaining} more lines, ${total} total, alt+o to expand)`,
        ],
    };
}

function collapsedResultFromExpanded(
    toolName: string,
    node: FrameNode,
): FrameNode | null {
    const max = RESULT_PREVIEW_LINES[toolName];
    if (!max) return stripLeadingBlankLines(node);
    const body = stripLeadingBlankLines(node);
    if (body?.type !== "AnsiBlock" || !Array.isArray(body.lines)) return body;
    const total = body.lines.length;
    if (total <= max) return body;
    const remaining = total - max;
    return {
        ...body,
        lines: [
            ...body.lines.slice(0, max),
            `... (${remaining} more lines, alt+o to expand)`,
        ],
    };
}

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
    /** Host-adapted pi-tui renderCall trees (collapsed / expanded). */
    callTree?: FrameNode;
    callTreeExpanded?: FrameNode;
    /** Host-adapted pi-tui renderResult trees (collapsed / expanded). */
    resultTree?: FrameNode;
    resultTreeExpanded?: FrameNode;
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
    /** Host-adapted pi-tui renderCall/renderResult trees for built-in spikes. */
    private callTree: FrameNode | null = null;
    private callTreeExpanded: FrameNode | null = null;
    private resultTree: FrameNode | null = null;
    private resultTreeExpanded: FrameNode | null = null;

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
            if (m.callTree != null) this.callTree = m.callTree;
            if (m.callTreeExpanded != null)
                this.callTreeExpanded = m.callTreeExpanded;
        } else {
            this.info.pending = false;
            this.info.isError = !!m.isError;
            if (m.result != null) this.info.result = String(m.result);
            if (m.details != null) this.info.details = m.details;
            if (m.durationMs != null) this.info.durationMs = m.durationMs;
            if (m.tree != null) this.tree = m.tree;
            if (m.resultTree != null) this.resultTree = m.resultTree;
            if (m.resultTreeExpanded != null)
                this.resultTreeExpanded = m.resultTreeExpanded;
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

        const appendHeader = () => {
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
        };

        if (
            this.callTree ||
            this.callTreeExpanded ||
            this.resultTree ||
            this.resultTreeExpanded
        ) {
            // Adapted TUI trees own the inner content, while pi-web keeps the
            // themed card shell/header. `write` call trees include their own
            // header, so strip it before rendering the preview body.
            appendHeader();
            const callTree =
                info.expanded && this.callTreeExpanded
                    ? this.callTreeExpanded
                    : this.callTree;
            if (callTree) {
                const call = renderStaticNode(
                    info.name === "write"
                        ? stripWriteHeader(callTree)
                        : stripLeadingBlankLines(callTree),
                );
                if (call) this.appendChild(call);
            } else if (
                info.name === "write" &&
                !info.expanded &&
                this.callTreeExpanded
            ) {
                const call = renderStaticNode(
                    writeCollapsedPreviewFromExpanded(this.callTreeExpanded),
                );
                if (call) this.appendChild(call);
            }
            const resultTree =
                info.expanded && this.resultTreeExpanded
                    ? this.resultTreeExpanded
                    : this.resultTree;
            const resultFallback =
                !info.expanded && !this.resultTree && this.resultTreeExpanded
                    ? collapsedResultFromExpanded(
                          info.name,
                          this.resultTreeExpanded,
                      )
                    : null;
            const result = renderStaticNode(
                resultFallback ??
                    (resultTree ? stripLeadingBlankLines(resultTree) : null),
            );
            if (result) this.appendChild(result);
            return;
        }

        appendHeader();

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

        const makeMore = (label: string) => {
            const more = document.createElement("div");
            more.className = "tool-more";
            more.textContent = label;
            more.onclick = () => this.toggleExpanded();
            return more;
        };
        const appendBody = (text: string) => {
            const body = document.createElement("pre");
            body.className = "tool-body";
            body.textContent = text;
            this.appendChild(body);
        };

        if (info.name === "read") {
            const parts = readResultParts(info);
            if (!parts) return;
            appendBody(parts.shown);
            if (parts.remaining > 0) {
                this.appendChild(makeMore(readMoreLabel(parts.remaining)));
            }
            if (info.expanded) this.appendChild(makeMore("collapse (alt+o)"));
            return;
        }

        const { shown, hidden } = truncateResult(info.result, !!info.expanded);
        // Collapsed: the preview is the tail, so the "N earlier lines" hint goes
        // ABOVE it (matching pi-tui). Expanded: a "collapse" affordance below.
        if (hidden > 0) {
            this.appendChild(
                makeMore(
                    `... (${hidden} earlier line${hidden === 1 ? "" : "s"}, alt+o to expand)`,
                ),
            );
        }
        appendBody(shown);
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
