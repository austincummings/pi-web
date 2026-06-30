/**
 * Parity tests for the ported fuzzy matcher (mirrors pi-tui semantics).
 */
import { test, expect } from "bun:test";
import { fuzzyMatch, fuzzyFilter } from "../src/web/fuzzy.mjs";

const CMDS = [{ label: "/resume" }, { label: "/new" }];

test("subsequence matching (order, not adjacency)", () => {
    expect(fuzzyMatch("rsm", "/resume").matches).toBe(true);
    expect(fuzzyMatch("res", "/resume").matches).toBe(true);
    expect(fuzzyMatch("xyz", "/resume").matches).toBe(false);
});

test("lower score = better; exact beats partial", () => {
    const exact = fuzzyMatch("resume", "resume").score;
    const partial = fuzzyMatch("res", "resume").score;
    expect(exact).toBeLessThan(partial);
});

test("fuzzyFilter narrows to the matching command", () => {
    const r = fuzzyFilter(CMDS, "/res", (c) => c.label);
    expect(r.length).toBe(1);
    expect(r[0].label).toBe("/resume");
});

test("fuzzyFilter keeps all when a token matches both", () => {
    const r = fuzzyFilter(CMDS, "e", (c) => c.label);
    expect(r.length).toBe(2);
});

test("empty / slash-only query returns all items", () => {
    expect(fuzzyFilter(CMDS, "", (c) => c.label).length).toBe(2);
    expect(fuzzyFilter(CMDS, "/", (c) => c.label).length).toBe(2);
});
