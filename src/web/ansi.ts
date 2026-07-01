// ANSI-to-DOM painter (render-model parity, Parity P0). A pure port of the
// "workhorse" from docs/render-model-parity.md §6: pi TUI `Component`s expose
// only `render(width): string[]` — arrays of ANSI-styled monospace lines — so to
// show an arbitrary component in pi-web's DOM we parse that ANSI and emit
// controlled, escaped `<span>`s. This is NOT a terminal emulator: it paints a
// self-contained *block of lines* (no cursor motion, scrollback, or alt-screen).
//
// Security (§6.4/§13): all text is HTML-escaped; only a whitelisted set of inline
// styles is emitted (color/background/font-weight/style/text-decoration); OSC 8
// URLs are sanitized (http/https/mailto only); every other control sequence
// (cursor motion, other OSC/DCS/APC incl. the zero-width CURSOR_MARKER) is
// stripped. No untrusted string is ever used as raw HTML.

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** A resolved color: a CSS var reference, an rgb()/hex literal, or default. */
type Color =
    | { kind: "default" }
    | { kind: "idx"; n: number } // 0..255
    | { kind: "rgb"; r: number; g: number; b: number };

interface SgrState {
    fg: Color;
    bg: Color;
    bold: boolean;
    dim: boolean;
    italic: boolean;
    underline: boolean;
    inverse: boolean;
    strike: boolean;
}

function freshState(): SgrState {
    return {
        fg: { kind: "default" },
        bg: { kind: "default" },
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        inverse: false,
        strike: false,
    };
}

// The 16 base ANSI colors mapped onto the active pi-web theme's CSS vars, so
// colors track the current theme (docs/render-model-parity.md §6.2 fallback LUT).
const ANSI16: string[] = [
    "var(--bg)", // 0 black
    "var(--err)", // 1 red
    "var(--ok)", // 2 green
    "var(--warn)", // 3 yellow
    "var(--acc)", // 4 blue
    "var(--acc2)", // 5 magenta
    "var(--cyan)", // 6 cyan
    "var(--txt)", // 7 white
    "var(--dim)", // 8 bright black
    "var(--err)", // 9 bright red
    "var(--ok)", // 10 bright green
    "var(--warn)", // 11 bright yellow
    "var(--acc)", // 12 bright blue
    "var(--acc2)", // 13 bright magenta
    "var(--cyan)", // 14 bright cyan
    "var(--txt)", // 15 bright white
];

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** Resolve a 256-color index to a concrete CSS color. */
function idxToCss(n: number): string {
    if (n < 16) return ANSI16[n];
    if (n < 232) {
        const i = n - 16;
        const r = CUBE_LEVELS[Math.floor(i / 36) % 6];
        const g = CUBE_LEVELS[Math.floor(i / 6) % 6];
        const b = CUBE_LEVELS[i % 6];
        return `rgb(${r},${g},${b})`;
    }
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
}

function colorToCss(c: Color): string | null {
    if (c.kind === "default") return null;
    if (c.kind === "rgb") return `rgb(${c.r},${c.g},${c.b})`;
    return idxToCss(c.n);
}

/** Build the whitelisted inline style for the current SGR state. */
function styleFor(st: SgrState): string {
    // Inverse swaps fg/bg, defaulting to the theme's text/background so the
    // classic reverse-video look holds even when colors are unset.
    let fg = colorToCss(st.fg);
    let bg = colorToCss(st.bg);
    if (st.inverse) {
        const newFg = bg ?? "var(--bg)";
        const newBg = fg ?? "var(--txt)";
        fg = newFg;
        bg = newBg;
    }
    const decls: string[] = [];
    if (fg) decls.push(`color:${fg}`);
    if (bg) decls.push(`background-color:${bg}`);
    if (st.bold) decls.push("font-weight:bold");
    if (st.dim && !st.bold) decls.push("opacity:0.7");
    if (st.italic) decls.push("font-style:italic");
    const deco: string[] = [];
    if (st.underline) deco.push("underline");
    if (st.strike) deco.push("line-through");
    if (deco.length) decls.push(`text-decoration:${deco.join(" ")}`);
    return decls.join(";");
}

/** Apply an SGR (`ESC [ … m`) parameter list to the state, in place. */
function applySgr(st: SgrState, params: number[]): void {
    for (let i = 0; i < params.length; i++) {
        const p = params[i];
        switch (true) {
            case p === 0:
                Object.assign(st, freshState());
                break;
            case p === 1:
                st.bold = true;
                break;
            case p === 2:
                st.dim = true;
                break;
            case p === 3:
                st.italic = true;
                break;
            case p === 4:
                st.underline = true;
                break;
            case p === 7:
                st.inverse = true;
                break;
            case p === 9:
                st.strike = true;
                break;
            case p === 22:
                st.bold = false;
                st.dim = false;
                break;
            case p === 23:
                st.italic = false;
                break;
            case p === 24:
                st.underline = false;
                break;
            case p === 27:
                st.inverse = false;
                break;
            case p === 29:
                st.strike = false;
                break;
            case p >= 30 && p <= 37:
                st.fg = { kind: "idx", n: p - 30 };
                break;
            case p === 39:
                st.fg = { kind: "default" };
                break;
            case p >= 40 && p <= 47:
                st.bg = { kind: "idx", n: p - 40 };
                break;
            case p === 49:
                st.bg = { kind: "default" };
                break;
            case p >= 90 && p <= 97:
                st.fg = { kind: "idx", n: p - 90 + 8 };
                break;
            case p >= 100 && p <= 107:
                st.bg = { kind: "idx", n: p - 100 + 8 };
                break;
            case p === 38 || p === 48: {
                const target = p === 38 ? "fg" : "bg";
                const mode = params[i + 1];
                if (mode === 5) {
                    st[target] = { kind: "idx", n: params[i + 2] & 255 };
                    i += 2;
                } else if (mode === 2) {
                    st[target] = {
                        kind: "rgb",
                        r: params[i + 2] & 255,
                        g: params[i + 3] & 255,
                        b: params[i + 4] & 255,
                    };
                    i += 4;
                }
                break;
            }
            // other SGR codes: ignored
        }
    }
}

/** Only http/https/mailto URLs survive OSC 8 link sanitization. */
function sanitizeUrl(url: string): string | null {
    const u = url.trim();
    if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
    return null;
}

/**
 * Render one ANSI line to safe HTML, mutating `st` so styles carry within the
 * line. (pi appends a reset per line, so state does not carry across lines — the
 * caller starts each line from a fresh state.)
 */
function lineToHtml(line: string, st: SgrState): string {
    let out = "";
    let run = "";
    let href: string | null = null;
    const flush = () => {
        if (!run) return;
        const style = styleFor(st);
        const text = escapeHtml(run);
        let piece = style ? `<span style="${style}">${text}</span>` : text;
        if (href)
            piece = `<a href="${escapeHtml(href)}" rel="noopener noreferrer">${piece}</a>`;
        out += piece;
        run = "";
    };
    const ESC = "\x1b";
    let i = 0;
    while (i < line.length) {
        const ch = line[i];
        if (ch !== ESC) {
            run += ch;
            i++;
            continue;
        }
        const next = line[i + 1];
        if (next === "[") {
            // CSI: ESC [ params letter
            let j = i + 2;
            while (j < line.length && !/[A-Za-z]/.test(line[j])) j++;
            const final = line[j];
            const body = line.slice(i + 2, j);
            if (final === "m") {
                flush();
                const params =
                    body === ""
                        ? [0]
                        : body.split(";").map((s) => parseInt(s, 10) || 0);
                applySgr(st, params);
            }
            // non-SGR CSI (cursor motion, etc.): stripped
            i = j + 1;
            continue;
        }
        if (next === "]") {
            // OSC: ESC ] ... ST (ST = BEL or ESC \)
            let j = i + 2;
            let end = -1;
            let stLen = 0;
            while (j < line.length) {
                if (line[j] === "\x07") {
                    end = j;
                    stLen = 1;
                    break;
                }
                if (line[j] === ESC && line[j + 1] === "\\") {
                    end = j;
                    stLen = 2;
                    break;
                }
                j++;
            }
            const osc = end === -1 ? line.slice(i + 2) : line.slice(i + 2, end);
            // OSC 8 hyperlink: "8;params;URI"
            if (osc.startsWith("8;")) {
                flush();
                const uri = osc.slice(2).replace(/^[^;]*;/, "");
                href = uri ? sanitizeUrl(uri) : null;
            }
            i = end === -1 ? line.length : end + stLen;
            continue;
        }
        if (next === "_" || next === "P" || next === "^") {
            // APC (incl. zero-width CURSOR_MARKER) / DCS / PM: strip to ST.
            let j = i + 2;
            let end = -1;
            let stLen = 0;
            while (j < line.length) {
                if (line[j] === "\x07") {
                    end = j;
                    stLen = 1;
                    break;
                }
                if (line[j] === ESC && line[j + 1] === "\\") {
                    end = j;
                    stLen = 2;
                    break;
                }
                j++;
            }
            i = end === -1 ? line.length : end + stLen;
            continue;
        }
        // lone ESC or unknown 2-char escape: skip the ESC (and a following byte)
        i += 2;
    }
    flush();
    if (href) out += ""; // links close implicitly at line end
    return out;
}

/**
 * Render an array of ANSI lines (one component `render(width)` block) to the
 * inner HTML of an `.ansi` block: one `<div class="ansi-line">` per line. Each
 * line starts from a fresh SGR state (pi's per-line reset contract).
 */
export function ansiToHtml(lines: string[]): string {
    return lines
        .map(
            (line) =>
                `<div class="ansi-line">${lineToHtml(line, freshState()) || "&nbsp;"}</div>`,
        )
        .join("");
}
