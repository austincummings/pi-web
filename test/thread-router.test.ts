import { test, expect } from "bun:test";
import { createThreadRouter } from "../src/host/thread-router.ts";
import type { ThreadRuntime } from "../src/host/threads.ts";

// The router only stores/returns the thread by reference, so a tagged stub is
// enough to assert routing identity.
const thread = (id: string) => ({ id }) as unknown as ThreadRuntime;

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

test("active() is null outside any scope", () => {
    const router = createThreadRouter();
    expect(router.active()).toBeNull();
});

test("run(thread, fn) sets the active thread for fn and restores after", () => {
    const router = createThreadRouter();
    const a = thread("a");
    const inside = router.run(a, () => router.active());
    expect(inside).toBe(a);
    expect(router.active()).toBeNull(); // scope ended
});

test("run(null, fn) runs fn with no active thread", () => {
    const router = createThreadRouter();
    let seen: ThreadRuntime | null = thread("x");
    router.run(null, () => {
        seen = router.active();
    });
    expect(seen).toBeNull();
});

test("nested scopes resolve innermost-first, then restore the outer", () => {
    const router = createThreadRouter();
    const a = thread("a");
    const b = thread("b");
    const seen: (string | null)[] = [];
    router.run(a, () => {
        seen.push(router.active()?.id ?? null); // a
        router.run(b, () => seen.push(router.active()?.id ?? null)); // b
        seen.push(router.active()?.id ?? null); // a (restored)
    });
    expect(seen).toEqual(["a", "b", "a"]);
});

test("interleaved async scopes keep their own thread across awaits", async () => {
    // This is the race the AsyncLocalStorage change fixes: two operations whose
    // routing scope spans awaits must not clobber each other. With the old
    // mutable global, the second run() would overwrite the first mid-flight.
    const router = createThreadRouter();
    const a = thread("a");
    const b = thread("b");

    const op = async (t: ThreadRuntime, out: string[]) =>
        router.run(t, async () => {
            out.push(router.active()!.id); // before await
            await tick();
            out.push(router.active()!.id); // after await — still t
            await tick();
            out.push(router.active()!.id);
        });

    const outA: string[] = [];
    const outB: string[] = [];
    await Promise.all([op(a, outA), op(b, outB)]);

    expect(outA).toEqual(["a", "a", "a"]);
    expect(outB).toEqual(["b", "b", "b"]);
    expect(router.active()).toBeNull();
});
