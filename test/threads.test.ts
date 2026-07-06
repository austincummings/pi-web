import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitBranchWatcher } from "../src/host/threads.ts";

// The watcher is best-effort: outside a git repo it must report null and never
// throw, and dispose() must be safe to call regardless.
test("createGitBranchWatcher reports null outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "piweb-nogit-"));
    let changes = 0;
    const w = createGitBranchWatcher(dir, () => changes++);
    try {
        // Synchronous read before the async `git` probe resolves: still null,
        // and the non-repo probe can only ever resolve back to null (no change).
        expect(w.getBranch()).toBeNull();
    } finally {
        expect(() => w.dispose()).not.toThrow();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("createGitBranchWatcher.dispose is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "piweb-nogit-"));
    const w = createGitBranchWatcher(dir, () => {});
    w.dispose();
    expect(() => w.dispose()).not.toThrow(); // double-dispose is safe
    rmSync(dir, { recursive: true, force: true });
});
