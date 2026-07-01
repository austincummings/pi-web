/**
 * Unit tests for the web-palette Theme shim (src/host/tui-theme.ts) used to
 * drive extension tool renderResult hooks in render-model parity P1. Asserts it
 * emits truecolor ANSI in pi-web's palette (so ansiToHtml maps colors 1:1) and
 * implements the Theme method surface renderers call.
 */
import { test, expect } from "bun:test";
import { webPaletteTheme as t } from "../src/host/tui-theme.ts";

test("fg wraps text in truecolor SGR + reset, keyed by slot keyword", () => {
    // error-ish slot → err palette rgb(224,85,106)
    expect(t.fg("error", "x")).toBe("\x1b[38;2;224;85;106mx\x1b[39m");
    // success-ish slot → ok palette rgb(78,201,163)
    expect(t.fg("toolSuccess", "x")).toBe("\x1b[38;2;78;201;163mx\x1b[39m");
    // title/accent → acc palette rgb(106,160,255)
    expect(t.fg("toolTitle", "x")).toBe("\x1b[38;2;106;160;255mx\x1b[39m");
    // unknown → default text color rgb(215,224,234)
    expect(t.fg("somethingElse", "x")).toBe("\x1b[38;2;215;224;234mx\x1b[39m");
});

test("bg wraps in truecolor background SGR + reset", () => {
    expect(t.bg("error", "x")).toBe("\x1b[48;2;224;85;106mx\x1b[49m");
});

test("style helpers emit standard SGR pairs", () => {
    expect(t.bold("x")).toBe("\x1b[1mx\x1b[22m");
    expect(t.italic("x")).toBe("\x1b[3mx\x1b[23m");
    expect(t.underline("x")).toBe("\x1b[4mx\x1b[24m");
    expect(t.inverse("x")).toBe("\x1b[7mx\x1b[27m");
    expect(t.strikethrough("x")).toBe("\x1b[9mx\x1b[29m");
});

test("getFgAnsi/getBgAnsi return bare SGR prefixes; mode is truecolor", () => {
    expect(t.getFgAnsi("error")).toBe("\x1b[38;2;224;85;106m");
    expect(t.getBgAnsi("success")).toBe("\x1b[48;2;78;201;163m");
    expect(t.getColorMode()).toBe("truecolor");
});

test("border-color helpers are identity (no crash for callers)", () => {
    expect(t.getThinkingBorderColor("high")("b")).toBe("b");
    expect(t.getBashModeBorderColor()("b")).toBe("b");
});
