import { AsyncLocalStorage } from "node:async_hooks";
import type { ThreadRuntime } from "./threads.ts";

/**
 * Routing context: which thread's surface registry `piweb.*` calls target right
 * now.
 *
 * Extensions talk to a single global `__PIWEB__`; the host must route each
 * `setStatus` / `dock` / `notify` / `sendMessage` to the thread whose code is
 * running. That "current thread" used to be three mutable module-level pointers
 * (`bindingThread` / `dispatchingThread` / `currentThread`) set with manual
 * try/finally. Because several of those scopes span `await`s (extension reload,
 * `/command` handlers, panel dispatch, a prompt turn), two concurrent operations
 * — e.g. a `/command` racing a `/trust` — could clobber a shared global
 * mid-flight and route one thread's surface writes to the other.
 *
 * AsyncLocalStorage fixes that: each `run(thread, fn)` scope keeps its thread for
 * `fn` and everything it awaits, regardless of interleaving. Nested scopes (a
 * panel dispatch whose handler triggers agent events) resolve innermost-first,
 * preserving the old `binding ?? dispatch ?? current` precedence without needing
 * separate slots.
 */
export interface ThreadRouter {
    /** The thread surface writes route to now, or null outside any scope. */
    active(): ThreadRuntime | null;
    /** Run `fn` with `thread` as the active routing thread (async-scoped). */
    run<T>(thread: ThreadRuntime | null | undefined, fn: () => T): T;
}

export function createThreadRouter(): ThreadRouter {
    const als = new AsyncLocalStorage<ThreadRuntime>();
    return {
        active: () => als.getStore() ?? null,
        run: (thread, fn) => (thread ? als.run(thread, fn) : fn()),
    };
}
