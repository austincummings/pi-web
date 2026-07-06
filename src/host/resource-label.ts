// A short, human label for a resource path. Extensions usually live in
// `.../<name>/index.ts`, so prefer the containing folder name; otherwise the
// basename. Plain files are shown cwd-relative.
export function resourceLabel(p: string, cwd: string) {
    const rel = p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p;
    const parts = rel.split("/");
    const base = parts[parts.length - 1] || rel;
    if (/^index\.[mc]?[jt]sx?$/.test(base) && parts.length >= 2) {
        return parts[parts.length - 2];
    }
    return rel;
}
