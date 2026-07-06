import { test, expect } from "bun:test";
import { themeJsonToVars, createThemeManager } from "../src/host/theme.ts";

// A minimal pi-theme-shaped JSON: `vars` are the raw palette, `colors` are
// named-token -> var refs (or raw hex), `export` is the HTML-export block.
const sample = {
    vars: {
        bg0: "#101010",
        fg0: "#fafafa",
        blue: "#5599ff",
        magenta: "#ff55ff",
        green: "#33cc66",
        surface: "#181818",
    },
    colors: {
        bg: "bg0",
        text: "fg0",
        accent: "blue",
        success: "green",
        // raw hex literal (thinking tokens mix named refs + hex)
        thinkingHigh: "#abcdef",
    },
    export: { pageBg: "bg0" },
};

test("themeJsonToVars resolves named refs, hex literals, surface, and export", () => {
    const v = themeJsonToVars(sample);
    expect(v["--bg"]).toBe("#101010"); // colors.bg -> vars.bg0
    expect(v["--txt"]).toBe("#fafafa"); // colors.text -> vars.fg0
    expect(v["--acc"]).toBe("#5599ff"); // colors.accent -> vars.blue
    expect(v["--acc2"]).toBe("#ff55ff"); // vars.magenta preferred
    expect(v["--ok"]).toBe("#33cc66"); // colors.success -> vars.green
    expect(v["--panel"]).toBe("#181818"); // vars.surface directly
    expect(v["--think-high"]).toBe("#abcdef"); // raw hex passthrough
    expect(v["--export-page-bg"]).toBe("#101010"); // export block ref
});

test("themeJsonToVars omits tokens with no resolvable color", () => {
    const v = themeJsonToVars(sample);
    // `warning` isn't defined in colors/vars, so --warn must be absent (client
    // keeps its :root default) rather than present-but-null.
    expect("--warn" in v).toBe(false);
    expect(v["--warn"]).toBeUndefined();
});

test("themeJsonToVars tolerates an empty / malformed theme", () => {
    expect(themeJsonToVars({})).toEqual({});
    expect(themeJsonToVars(null)).toEqual({});
});

test("createThemeManager.apply of an unknown theme fails without broadcasting", () => {
    const frames: any[] = [];
    const mgr = createThemeManager((f) => frames.push(f));
    const res = mgr.apply("__definitely-not-a-real-theme__");
    expect(res.success).toBe(false);
    expect(res.error).toContain("__definitely-not-a-real-theme__");
    expect(frames.length).toBe(0);
});

test("createThemeManager.vars memoizes (same reference on repeat calls)", () => {
    const mgr = createThemeManager(() => {});
    const a = mgr.vars();
    const b = mgr.vars();
    expect(a).toBe(b); // cached, not recomputed
    expect(typeof a).toBe("object");
});

test("createThemeManager.list and .has agree", () => {
    const mgr = createThemeManager(() => {});
    const names = mgr.list().map((t) => t.name);
    // has() must be true for every listed name and false for a bogus one.
    for (const n of names.slice(0, 5)) expect(mgr.has(n)).toBe(true);
    expect(mgr.has("__nope__")).toBe(false);
});
