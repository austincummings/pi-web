/**
 * Thread subsystem types + git-branch tracking.
 *
 * This module owns the *self-contained* parts of pi-web's per-thread model: the
 * `ThreadRuntime` shape every thread is represented by, and the live git-branch
 * watcher that drives `FooterData.gitBranch`. The thread *registry* + lifecycle
 * (creation, event subscription, routing pointers) remain the composition root
 * in server.ts, since they're bound to the bus, theme, footer builders, and the
 * agent event translation; this module is the home those pieces migrate toward.
 */
import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type {
    AgentSession,
    DefaultResourceLoader,
    ExtensionAPI,
    SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { createPiWebHost } from "./piweb-host.ts";

/** A thread's panel/surface registry (one per thread). */
export type PiWebRegistry = ReturnType<typeof createPiWebHost>;

/**
 * A live, independently-running conversation thread.
 *
 * @property id             session id (stable registry key)
 * @property cwd            this thread's working directory
 * @property sm             this thread's session manager
 * @property session        the in-process agent session
 * @property pi             this thread's live ExtensionAPI
 * @property piweb          this thread's panel registry
 * @property resourceLoader extension loader
 * @property unsubscribe    detaches the event listener
 * @property busy           a turn is currently in flight
 * @property gitWatcher     live git-branch watcher (drives FooterData.gitBranch)
 */
export interface ThreadRuntime {
    id: string;
    cwd: string;
    sm: SessionManager;
    session: AgentSession | null;
    pi: ExtensionAPI | null;
    piweb: PiWebRegistry | null;
    resourceLoader: DefaultResourceLoader | null;
    unsubscribe: (() => void) | null;
    busy: boolean;
    /** Live git-branch watcher (drives `FooterData.gitBranch` reactively). */
    gitWatcher: GitBranchWatcher | null;
}

/** Cached git branch + a filesystem watcher that refreshes it on checkout. */
export interface GitBranchWatcher {
    getBranch(): string | null;
    dispose(): void;
}

/**
 * Watch a repo's `.git` for HEAD/ref changes and keep the current branch name
 * cached, calling `onChange` when it flips (checkout / detach) — the host side
 * of `FooterData.gitBranch` (pi-tui `footerData.getGitBranch` + `onBranchChange`
 * parity). Best-effort: outside a repo it simply reports `null`.
 */
export function createGitBranchWatcher(
    dir: string,
    onChange: () => void,
): GitBranchWatcher {
    let branch: string | null = null;
    let disposed = false;
    let watcher: FSWatcher | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const set = (val: string | null) => {
        if (disposed || val === branch) return;
        branch = val;
        onChange();
    };
    const refresh = () => {
        execFile(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: dir, timeout: 5000 },
            (err, out) => {
                if (disposed) return;
                if (err) return set(null);
                const b = String(out).trim();
                if (b !== "HEAD") return set(b);
                // Detached HEAD -> short SHA.
                execFile(
                    "git",
                    ["rev-parse", "--short", "HEAD"],
                    { cwd: dir, timeout: 5000 },
                    (e2, o2) =>
                        disposed || set(e2 ? null : `@${String(o2).trim()}`),
                );
            },
        );
    };
    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(refresh, 150); // debounce rapid .git churn
    };
    try {
        watcher = watch(join(dir, ".git"), { persistent: false }, (_e, f) => {
            const name = f ? String(f) : "";
            // HEAD flips on checkout; refs/packed-refs on branch create/delete.
            if (
                !name ||
                name === "HEAD" ||
                name === "packed-refs" ||
                name.startsWith("refs")
            )
                schedule();
        });
    } catch {
        /* not a git repo (or .git missing) — branch stays null */
    }
    refresh();
    return {
        getBranch: () => branch,
        dispose: () => {
            disposed = true;
            try {
                watcher?.close();
            } catch {
                /* ignore */
            }
            if (timer) clearTimeout(timer);
        },
    };
}
