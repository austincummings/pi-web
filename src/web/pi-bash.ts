// <pi-bash> — one user-run shell command (`!` / `!!`) in the transcript.
//
// Mirrors pi-tui's BashExecutionComponent: a bordered block (top + bottom
// rules) tinted with the bash-mode color — or dim for `!!` (excluded from
// context) — a bold `$ <command>` header, live-streaming output collapsed to
// the last PREVIEW_LINES until expanded, and a footer that shows a braille
// spinner while running or the exit/cancel/truncation status once complete.
//
// The element owns its own state, spinner timer, expand/collapse, and
// rendering (light DOM, no Shadow DOM). The host feeds it SSE `bash` frames via
// apply(); scrolling stays with the host (it owns the transcript). While a
// command runs, Esc cancels it (host `POST /bash/abort` -> session.abortBash());
// the resulting end frame carries `cancelled: true`, shown as "(cancelled)".

import { formatDuration } from "./tools.ts";

// Preview line limit when collapsed (matches pi-tui's BashExecutionComponent).
const PREVIEW_LINES = 20;

// Braille spinner frames @ 80ms (matches pi-tui's Loader).
const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The shape of an SSE `bash` frame.
export interface BashFrame {
    status?: "start" | "chunk" | "end" | string;
    command?: string;
    excludeFromContext?: boolean;
    text?: string;
    exitCode?: number | null;
    cancelled?: boolean;
    truncated?: boolean;
    fullOutputPath?: string | null;
    /** How long the command ran, in ms (host-stamped on the end frame). */
    durationMs?: number;
}

export class PiBash extends HTMLElement {
    private command = "";
    private excluded = false;
    private output = "";
    private running = true;
    private exitCode: number | null = null;
    private cancelled = false;
    private truncated = false;
    private fullOutputPath: string | null = null;
    private expanded = false;
    // Wall-clock start (for the live running counter) and final run time. The
    // host stamps durationMs on the end frame; startedAt is the client-side
    // fallback and drives the ticking elapsed while the command runs.
    private startedAt: number | null = null;
    private durationMs: number | null = null;

    private built = false;
    private spinTimer: ReturnType<typeof setInterval> | null = null;
    private spinIndex = 0;

    connectedCallback(): void {
        if (!this.built) {
            this.built = true;
            this.render();
        }
        this.syncSpinner();
    }

    disconnectedCallback(): void {
        this.stopSpinner();
    }

    /** Apply one SSE `bash` frame and re-render. */
    apply(m: BashFrame): void {
        if (m.status === "start") {
            if (m.command != null) this.command = m.command;
            this.excluded = !!m.excludeFromContext;
            this.running = true;
            this.startedAt = Date.now();
        } else if (m.status === "chunk") {
            this.output += m.text ?? "";
        } else if (m.status === "end") {
            this.running = false;
            this.exitCode = m.exitCode ?? null;
            this.cancelled = !!m.cancelled;
            this.truncated = !!m.truncated;
            this.fullOutputPath = m.fullOutputPath ?? null;
            this.durationMs =
                m.durationMs ??
                (this.startedAt != null ? Date.now() - this.startedAt : null);
        }
        this.render();
        this.syncSpinner();
    }

    /** Flip the output expand/collapse state (click the "more" affordance). */
    private toggleExpanded(): void {
        this.expanded = !this.expanded;
        this.render();
        this.syncSpinner();
    }

    // Start/stop the braille spinner interval to match the running state.
    private syncSpinner(): void {
        if (this.running && !this.spinTimer) {
            this.spinTimer = setInterval(() => {
                this.spinIndex = (this.spinIndex + 1) % SPIN_FRAMES.length;
                const spin = this.querySelector<HTMLElement>(".bash-run .spin");
                if (spin) spin.textContent = SPIN_FRAMES[this.spinIndex];
                const el =
                    this.querySelector<HTMLElement>(".bash-run .elapsed");
                if (el) el.textContent = this.elapsedText();
            }, 80);
        } else if (!this.running) {
            this.stopSpinner();
        }
    }

    private stopSpinner(): void {
        if (this.spinTimer) {
            clearInterval(this.spinTimer);
            this.spinTimer = null;
        }
    }

    private render(): void {
        this.className = "bash" + (this.excluded ? " excluded" : "");
        this.innerHTML = "";

        // Command header: bold `$ <command>` in the bash-mode color.
        const head = document.createElement("div");
        head.className = "bash-cmd";
        head.textContent = "$ " + this.command;
        this.appendChild(head);

        // Output, collapsed to the last PREVIEW_LINES until expanded (tail).
        const lines = this.output === "" ? [] : this.output.split("\n");
        const shownLines = this.expanded ? lines : lines.slice(-PREVIEW_LINES);
        const hidden = lines.length - shownLines.length;
        if (shownLines.length) {
            const body = document.createElement("pre");
            body.className = "body";
            body.textContent = shownLines.join("\n");
            this.appendChild(body);
        }

        if (this.running) {
            // Footer: braille spinner + "Running…" while the command runs.
            const run = document.createElement("div");
            run.className = "bash-run";
            run.innerHTML =
                '<span class="spin"></span>Running… ' +
                '<span class="elapsed"></span>';
            (run.querySelector(".spin") as HTMLElement).textContent =
                SPIN_FRAMES[this.spinIndex];
            (run.querySelector(".elapsed") as HTMLElement).textContent =
                this.elapsedText();
            run.append(" (esc to cancel)");
            this.appendChild(run);
            return;
        }

        // Footer: collapse/expand hint (pi-tui shows it below the output).
        if (hidden > 0) {
            const more = document.createElement("div");
            more.className = "bash-more";
            more.textContent = this.expanded
                ? "collapse"
                : `… ${hidden} more line${hidden === 1 ? "" : "s"}`;
            more.onclick = () => this.toggleExpanded();
            this.appendChild(more);
        } else if (this.expanded) {
            const more = document.createElement("div");
            more.className = "bash-more";
            more.textContent = "collapse";
            more.onclick = () => this.toggleExpanded();
            this.appendChild(more);
        }

        // Footer: exit / cancel status with run time (mirrors pi-tui's status
        // parts; the duration is appended like `(exit 1 · 1.2s)`).
        const dur = formatDuration(this.durationMs);
        if (this.cancelled) {
            this.appendStatus(dur ? `(cancelled · ${dur})` : "(cancelled)", "warn");
        } else if (this.exitCode != null && this.exitCode !== 0) {
            this.appendStatus(
                dur ? `(exit ${this.exitCode} · ${dur})` : `(exit ${this.exitCode})`,
                "err",
            );
        } else if (dur) {
            this.appendStatus(`(${dur})`, "meta");
        }
        // Matches pi-tui: the truncation warning shows only when a full-output
        // temp file exists (that's where the elided output can be recovered).
        if (this.truncated && this.fullOutputPath) {
            this.appendStatus(
                `Output truncated. Full output: ${this.fullOutputPath}`,
                "warn",
            );
        }
    }

    // Elapsed time since the command started, for the live running counter.
    private elapsedText(): string {
        return this.startedAt == null
            ? ""
            : formatDuration(Date.now() - this.startedAt);
    }

    private appendStatus(text: string, kind: "warn" | "err" | "meta"): void {
        const s = document.createElement("div");
        s.className = "bash-status " + kind;
        s.textContent = text;
        this.appendChild(s);
    }
}

if (!customElements.get("pi-bash")) {
    customElements.define("pi-bash", PiBash);
}

declare global {
    interface HTMLElementTagNameMap {
        "pi-bash": PiBash;
    }
}
