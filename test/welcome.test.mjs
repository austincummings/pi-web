/**
 * Unit tests for the startup/reload intro-view helpers (src/web/welcome.ts):
 * the key-hint strip, compact section summaries, and the has-resources guard.
 */
import { test, expect } from "bun:test";
import {
    keyHintsLine,
    sectionSummary,
    hasResources,
    KEY_HINTS,
} from "../src/web/welcome.ts";

test("keyHintsLine joins the hints with a middot separator", () => {
    const line = keyHintsLine();
    expect(line).toContain("esc interrupt");
    expect(line).toContain("/ commands");
    expect(line).toContain("! bash");
    // browser-adapted: expand is alt+o (ctrl+o is reserved)
    expect(line).toContain("alt+o more");
    expect(line.split("·").length).toBe(KEY_HINTS.length);
});

test("sectionSummary trims, drops blanks, sorts, and comma-joins", () => {
    expect(sectionSummary([" b ", "a", "", "  ", "c"])).toBe("a, b, c");
    expect(sectionSummary([])).toBe("");
});

test("hasResources is true only when some section has items", () => {
    expect(hasResources(null)).toBe(false);
    expect(hasResources({ version: "1", sections: [] })).toBe(false);
    expect(
        hasResources({ version: "1", sections: [{ name: "X", items: [] }] }),
    ).toBe(false);
    expect(
        hasResources({ version: "1", sections: [{ name: "X", items: ["a"] }] }),
    ).toBe(true);
});
