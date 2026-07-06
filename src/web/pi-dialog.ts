// <pi-dialog> — blocking modal dialogs (select / confirm / input / editor).
//
// The host's `piweb.select/confirm/input/editor` open a modal here and await
// the answer; the app POSTs /ui-response to unblock the extension. The open
// dialog travels in the surfaces snapshot, so a refresh replays it (see host
// piweb-host.ts requestUi).
//
// Light DOM (no Shadow DOM) so the global CSS (#dialog, .dialog-card, --acc, …)
// applies unchanged. The element self-manages a document-level capture-phase
// keydown listener (highest precedence: arrows/Enter drive a select, Escape
// cancels) and a backdrop click that mirrors Escape.
//
// Events (all bubble):
//   pi-dialog-answer { requestId, value }  — the user's answer, or a cancel
//         (value null for select/input/editor, false for confirm)
//   pi-dialog-open                         — a dialog just became visible
//
// Public API:
//   render(dialogs)  — reconcile against the surfaces `dialogs` array

// A single open dialog's runtime state.
interface ActiveDialog {
    id: string;
    dialog: "select" | "confirm" | "input" | "editor";
    rows: HTMLElement[];
}

export class PiDialog extends HTMLElement {
    #active: ActiveDialog | null = null;
    #sel = 0; // highlighted option index (select dialogs)
    #card!: HTMLElement;

    connectedCallback() {
        // The custom element itself is the fullscreen backdrop (#dialog); it
        // hosts a single .dialog-card that is rebuilt per open dialog.
        this.#card = document.createElement("div");
        this.#card.className = "dialog-card";
        this.#card.id = "dialog-card";
        this.appendChild(this.#card);
        this.addEventListener("click", this.#onBackdrop);
        document.addEventListener("keydown", this.#onDocKey, true);
    }

    disconnectedCallback() {
        this.removeEventListener("click", this.#onBackdrop);
        document.removeEventListener("keydown", this.#onDocKey, true);
    }

    // Render the open dialog (the most-recently-opened wins if several stack).
    // Skips a rebuild when the same dialog id is already shown, so unrelated
    // surface pushes don't wipe a half-typed input.
    render(dialogs: any[]) {
        const list = dialogs || [];
        const d = list.length ? list[list.length - 1] : null;
        if (!d) {
            this.#active = null;
            this.classList.remove("show");
            this.#card.innerHTML = "";
            return;
        }
        if (this.#active && this.#active.id === d.id) return; // already showing
        this.#active = { id: d.id, dialog: d.dialog, rows: [] };
        this.#build(d);
        this.classList.add("show");
        this.dispatchEvent(
            new CustomEvent("pi-dialog-open", { bubbles: true }),
        );
    }

    // Send the user's answer back to the awaiting extension. `value` is the
    // chosen string / boolean / text, or null to cancel (host maps null ->
    // undefined for select/input/editor, false for confirm).
    #answer(value: any) {
        if (!this.#active) return;
        const requestId = this.#active.id;
        this.#active = null;
        this.dispatchEvent(
            new CustomEvent("pi-dialog-answer", {
                bubbles: true,
                detail: { requestId, value },
            }),
        );
    }

    #setSel(i: number, rows: HTMLElement[]) {
        if (!rows.length) return;
        this.#sel = (i + rows.length) % rows.length;
        rows.forEach((el, idx) =>
            el.classList.toggle("sel", idx === this.#sel),
        );
        rows[this.#sel].scrollIntoView({ block: "nearest" });
    }

    // Build the modal DOM for one dialog spec and wire its submit/cancel paths.
    #build(d: any) {
        this.#card.innerHTML = "";
        this.#sel = 0;
        const h = document.createElement("h3");
        h.textContent = d.title || "";
        this.#card.appendChild(h);
        const body = document.createElement("div");
        body.className = "dialog-body";
        this.#card.appendChild(body);

        if (d.dialog === "select") {
            const rows: HTMLElement[] = [];
            (d.options || []).forEach((opt: any, i: number) => {
                const row = document.createElement("div");
                row.className = "item";
                row.textContent = opt;
                row.onclick = () => this.#answer(opt);
                row.onmouseenter = () => this.#setSel(i, rows);
                body.appendChild(row);
                rows.push(row);
            });
            this.#active!.rows = rows;
            this.#setSel(0, rows);
        } else if (d.dialog === "confirm") {
            const msg = document.createElement("div");
            msg.className = "dialog-msg";
            msg.textContent = d.message || "";
            body.appendChild(msg);
            const btns = document.createElement("div");
            btns.className = "dialog-btns";
            const cancel = document.createElement("button");
            cancel.textContent = "Cancel";
            cancel.onclick = () => this.#answer(false);
            const ok = document.createElement("button");
            ok.className = "primary";
            ok.textContent = "OK";
            ok.onclick = () => this.#answer(true);
            btns.append(cancel, ok);
            body.appendChild(btns);
            setTimeout(() => ok.focus(), 0);
        } else if (d.dialog === "input" || d.dialog === "editor") {
            const multiline = d.dialog === "editor";
            const field = document.createElement(
                multiline ? "textarea" : "input",
            ) as HTMLInputElement | HTMLTextAreaElement;
            field.className = "dialog-field";
            if (multiline) {
                (field as HTMLTextAreaElement).rows = 8;
                field.value = d.prefill || "";
            } else {
                (field as HTMLInputElement).type = "text";
                field.placeholder = d.placeholder || "";
            }
            body.appendChild(field);
            const btns = document.createElement("div");
            btns.className = "dialog-btns";
            const cancel = document.createElement("button");
            cancel.textContent = "Cancel";
            cancel.onclick = () => this.#answer(null);
            const ok = document.createElement("button");
            ok.className = "primary";
            ok.textContent = multiline ? "Save" : "OK";
            ok.onclick = () => this.#answer(field.value);
            btns.append(cancel, ok);
            body.appendChild(btns);
            // Enter submits a single-line input; the editor keeps Enter for
            // newlines (submit via the button or Ctrl/Cmd+Enter).
            (field as HTMLElement).addEventListener("keydown", (e: any) => {
                if (
                    e.key === "Enter" &&
                    (!multiline || e.ctrlKey || e.metaKey)
                ) {
                    e.preventDefault();
                    this.#answer(field.value);
                }
            });
            setTimeout(() => field.focus(), 0);
        }
    }

    // Dialog keyboard handling (capture phase, highest precedence): arrows/Enter
    // drive a select; Escape cancels any dialog. Runs before the app's
    // picker/overlay/interrupt Escape handlers.
    #onDocKey = (e: KeyboardEvent) => {
        if (!this.#active) return;
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            this.#answer(this.#active.dialog === "confirm" ? false : null);
            return;
        }
        if (this.#active.dialog !== "select") return;
        const rows = this.#active.rows || [];
        switch (e.key) {
            case "ArrowDown":
                e.preventDefault();
                e.stopPropagation();
                this.#setSel(this.#sel + 1, rows);
                break;
            case "ArrowUp":
                e.preventDefault();
                e.stopPropagation();
                this.#setSel(this.#sel - 1, rows);
                break;
            case "Enter":
                e.preventDefault();
                e.stopPropagation();
                rows[this.#sel]?.click();
                break;
        }
    };

    // Cancel a dialog by clicking its backdrop (mirrors Esc).
    #onBackdrop = (e: MouseEvent) => {
        if (e.target === this && this.#active)
            this.#answer(this.#active.dialog === "confirm" ? false : null);
    };
}

if (!customElements.get("pi-dialog"))
    customElements.define("pi-dialog", PiDialog);
