import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Collapse an absolute cwd to `~`-relative form for display, mirroring the pi
 * TUI footer's `formatCwdForFooter`.
 */
export function formatCwdForFooter(dir: string, home: string) {
    if (!home) return dir;
    const rel = relative(resolve(home), resolve(dir));
    const inside =
        rel === "" ||
        (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!inside) return dir;
    return rel === "" ? "~" : `~${sep}${rel}`;
}
