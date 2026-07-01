/**
 * A self-contained pi-tui `Theme` shim for render-model parity (P1).
 *
 * Extension tool `renderResult` hooks call `theme.fg/bg/bold/…` to wrap text in
 * ANSI; the client's `ansiToHtml` then paints it. pi's real `Theme` singleton is
 * not exported from the package top level (and deep imports are blocked by its
 * `exports` map), so instead of depending on pi internals we supply a shim whose
 * palette equals pi-web's own CSS-var colors. This is the spec's preferred
 * "web-palette pi theme" (docs/render-model-parity.md §10): `theme.fg` emits
 * truecolor SGR in the exact RGBs of the web `--*` vars, so colors stay coherent
 * with the surrounding UI and `ansiToHtml` maps them 1:1 (truecolor → rgb()).
 *
 * Named `ThemeColor` slots are matched by keyword (no enumeration), so the shim
 * is resilient to pi adding new slot names.
 */

// pi-web palette (mirrors the CSS vars in src/web/index.html :root).
const PALETTE = {
    txt: [215, 224, 234],
    muted: [159, 176, 192],
    dim: [125, 138, 160],
    acc: [106, 160, 255],
    acc2: [139, 92, 246],
    ok: [78, 201, 163],
    warn: [217, 164, 65],
    err: [224, 85, 106],
    cyan: [79, 196, 196],
} as const;

/** Map a ThemeColor slot name to a palette RGB by keyword. */
function pick(color: string): readonly number[] {
    const c = String(color).toLowerCase();
    if (/error|removed|delet|danger|\bred\b|fail/.test(c)) return PALETTE.err;
    if (/success|added|insert|green|string/.test(c)) return PALETTE.ok;
    if (/warn|number|\byellow\b|modif|orange/.test(c)) return PALETTE.warn;
    if (/title|accent|keyword|link|heading|\bblue\b|prompt|bash/.test(c))
        return PALETTE.acc;
    if (/type|class|\bcyan\b/.test(c)) return PALETTE.cyan;
    if (/magenta|purple|violet|label/.test(c)) return PALETTE.acc2;
    if (
        /muted|output|comment|\bdim\b|context|hint|secondary|gr[ae]y|punct|operator/.test(
            c,
        )
    )
        return PALETTE.muted;
    return PALETTE.txt;
}

const fgSgr = (rgb: readonly number[]) =>
    `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const bgSgr = (rgb: readonly number[]) =>
    `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
const RESET_FG = "\x1b[39m";
const RESET_BG = "\x1b[49m";

/**
 * A structural `Theme` (typed `any` to satisfy the render hooks' `theme`
 * parameter without importing pi's non-exported concrete class).
 */
export const webPaletteTheme: any = {
    fg: (color: string, text: string) =>
        `${fgSgr(pick(color))}${text}${RESET_FG}`,
    bg: (color: string, text: string) =>
        `${bgSgr(pick(color))}${text}${RESET_BG}`,
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
    underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
    inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
    strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
    getFgAnsi: (color: string) => fgSgr(pick(color)),
    getBgAnsi: (color: string) => bgSgr(pick(color)),
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (s: string) => s,
    getBashModeBorderColor: () => (s: string) => s,
};
