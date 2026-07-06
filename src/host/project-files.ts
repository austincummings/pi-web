import { readdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const execFileP = promisify(execFile);

// Prefer `git ls-files` (fast, respects .gitignore); fall back to a bounded
// filesystem walk for non-git working dirs. Results are cached briefly so a
// burst of keystrokes doesn't re-shell on every request, while newly created
// files still surface within a few seconds.
const FILE_CACHE_TTL_MS = 4000;
const FILE_LIST_CAP = 10000;
const WALK_SKIP = new Set([
    ".git",
    "node_modules",
    ".cache",
    "dist",
    "build",
    "coverage",
    ".next",
]);

type DirectorySuggestion = {
    value: string;
    label: string;
    description: string;
};

type ProjectFileOptions = {
    cwd: string;
    getThreadCwd?: (threadId?: string) => string | undefined;
};

/**
 * Project path helpers for @-file and /new-dir typeahead, scoped to the
 * process root cwd plus an optional thread-id -> cwd resolver.
 */
export function createProjectFileHelpers({
    cwd,
    getThreadCwd,
}: ProjectFileOptions) {
    /** Per-directory file-list cache. */
    const fileCacheByDir = new Map<string, { at: number; items: string[] }>();

    /**
     * Resolve a user-supplied directory for a new thread. Relative paths resolve
     * against the root cwd, `~` expands to $HOME, and the target must be an
     * existing directory.
     */
    function resolveThreadCwd(dir?: string) {
        const raw = (dir ?? "").trim();
        if (!raw) return cwd;
        const expanded = raw.startsWith("~")
            ? join(process.env.HOME ?? "", raw.slice(1))
            : raw;
        const abs = resolve(cwd, expanded);
        let st;
        try {
            st = statSync(abs);
        } catch {
            throw new Error(`no such directory: ${abs}`);
        }
        if (!st.isDirectory()) throw new Error(`not a directory: ${abs}`);
        return abs;
    }

    async function walkFiles(dir: string, base: string, out: string[]) {
        if (out.length >= FILE_LIST_CAP) return;
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            if (out.length >= FILE_LIST_CAP) return;
            if (WALK_SKIP.has(ent.name)) continue;
            // Skip hidden directories (.git-like noise / huge caches); keep
            // hidden files (e.g. .gitignore, .editorconfig) which are legit
            // @-mentionable project files, matching the `git ls-files` fast
            // path above.
            if (ent.isDirectory() && ent.name.startsWith(".")) continue;
            const abs = join(dir, ent.name);
            if (ent.isDirectory()) {
                await walkFiles(abs, base, out);
            } else if (ent.isFile()) {
                out.push(relative(base, abs).split(sep).join("/"));
            }
        }
    }

    /** List project files for the `@` mention typeahead, scoped to cwd. */
    async function listProjectFiles(dir?: string) {
        const base = dir || cwd;
        const cached = fileCacheByDir.get(base);
        if (cached && Date.now() - cached.at < FILE_CACHE_TTL_MS) {
            return cached.items;
        }
        let items: string[];
        try {
            const { stdout } = await execFileP(
                "git",
                ["ls-files", "--cached", "--others", "--exclude-standard"],
                { cwd: base, maxBuffer: 64 * 1024 * 1024 },
            );
            items = stdout.split("\n").filter(Boolean).slice(0, FILE_LIST_CAP);
        } catch {
            items = [];
            await walkFiles(base, base, items);
        }
        fileCacheByDir.set(base, { at: Date.now(), items });
        return items;
    }

    /** Directory suggestions for the `/new <dir>` typeahead. */
    async function listProjectDirs(q: string, threadId?: string) {
        const baseCwd = getThreadCwd?.(threadId) || cwd;
        const raw = (q ?? "").trim();
        const expand = (p: string) =>
            p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p;
        let listDir;
        let prefix;
        if (!raw) {
            listDir = baseCwd;
            prefix = "";
        } else {
            const abs = resolve(baseCwd, expand(raw));
            if (raw.endsWith("/")) {
                listDir = abs;
                prefix = "";
            } else {
                listDir = dirname(abs);
                prefix = basename(abs).toLowerCase();
            }
        }
        let ents;
        try {
            ents = await readdir(listDir, { withFileTypes: true });
        } catch {
            return [];
        }
        const items: DirectorySuggestion[] = [];
        for (const e of ents) {
            if (!e.isDirectory()) continue;
            // hide dotdirs unless the user is explicitly typing one
            if (e.name.startsWith(".") && !prefix.startsWith(".")) continue;
            if (prefix && !e.name.toLowerCase().startsWith(prefix)) continue;
            const abs = join(listDir, e.name);
            items.push({ value: abs, label: e.name, description: abs });
        }
        items.sort((a, b) => a.label.localeCompare(b.label));
        return items.slice(0, 50);
    }

    return { resolveThreadCwd, listProjectFiles, listProjectDirs };
}
