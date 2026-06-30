// The startup / reload "intro" view — pi-web's take on the pi TUI's header
// banner + loaded-resources listing (interactive-mode `showLoadedResources`).
// Shown above the transcript: a logo line, a compact key-hint strip, and a set
// of `[Section]` blocks (Context, Skills, Prompts, Extensions, Themes). These
// helpers are pure so they can be unit-tested; DOM assembly lives in app.ts.

/** A named group of loaded resources, e.g. { name: "Extensions", items: [...] }. */
export interface WelcomeSection {
    name: string;
    items: string[];
}

/** The full intro payload the host sends on connect. */
export interface WelcomeInfo {
    version: string;
    sections: WelcomeSection[];
}

/**
 * The compact key-hint strip under the logo, mirroring the TUI's
 * `compactInstructions`. Adapted to the browser: Ctrl+O is reserved, so the
 * "more" affordance is Alt+O (matching the tool/thinking expand keys).
 */
export const KEY_HINTS: ReadonlyArray<readonly [string, string]> = [
    ["esc", "interrupt"],
    ["ctrl+c/ctrl+d", "clear/exit"],
    ["/", "commands"],
    ["!", "bash"],
    ["alt+o", "more"],
];

/** Render the compact key-hint strip as a single ` · `-separated line. */
export function keyHintsLine(): string {
    return KEY_HINTS.map(([k, d]) => `${k} ${d}`).join("  ·  ");
}

/**
 * Collapsed one-line summary of a section's items: trimmed, de-blanked,
 * alphabetically sorted, comma-joined — matching the TUI's `formatCompactList`.
 */
export function sectionSummary(items: string[]): string {
    return (items ?? [])
        .map((s) => (s ?? "").trim())
        .filter((s) => s.length > 0)
        .sort((a, b) => a.localeCompare(b))
        .join(", ");
}

/** True when there's anything worth rendering (any section has items). */
export function hasResources(info: WelcomeInfo | null | undefined): boolean {
    return !!info?.sections?.some((s) => s.items && s.items.length > 0);
}
