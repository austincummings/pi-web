import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { textOf } from "./content.ts";
import { formatCwdForFooter } from "./cwd-display.ts";
import type { PiWebRegistry, ThreadRuntime } from "./threads.ts";

/** A serializable server->client message frame. */
export type ServerMessage = { kind: string; [k: string]: any };

type FrameBuilderDeps = {
    rootCwd: string;
    homeDir: string;
    themeVars: () => any;
    threadForSession: (
        s: AgentSession | null | undefined,
    ) => ThreadRuntime | null;
};

export function createFrameBuilders({
    rootCwd,
    homeDir,
    themeVars,
    threadForSession,
}: FrameBuilderDeps) {
    /**
     * Build the `thinking_level` frame for a session: current reasoning level,
     * the levels the active model supports, and whether thinking is supported at
     * all (a model with a single level — e.g. only "off" — can't be cycled).
     */
    function thinkingLevelFrame(s: AgentSession | null | undefined) {
        let level = "off";
        let available: string[] = [];
        try {
            level = s?.thinkingLevel || "off";
            available = s?.getAvailableThinkingLevels?.() ?? [];
        } catch {
            /* best-effort: fall back to off / no levels */
        }
        return {
            kind: "thinking_level" as const,
            level,
            available,
            supported: available.length > 1,
        };
    }

    /**
     * Compute the live `FooterData` for a thread (shared by the footer and
     * header frames). Best-effort: any missing piece degrades to a sane default.
     */
    function buildFooterData(
        s: AgentSession | null | undefined,
        threadCwd: string,
        thread: ThreadRuntime | null,
        registry: any,
    ) {
        let model = null;
        let reasoning = false;
        let level = "off";
        let session = null;
        let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        let cost = 0;
        let sub = false;
        let context: { percent: number | null; window: number } = {
            percent: null,
            window: 0,
        };
        let autoCompact = false;
        let cwdStr = threadCwd || rootCwd;
        try {
            const st = s?.state;
            model = st?.model?.id ?? null;
            reasoning = !!st?.model?.reasoning;
            level = s?.thinkingLevel || "off";
            const sm = s?.sessionManager;
            session = sm?.getSessionName?.() || null;
            cwdStr = sm?.getCwd?.() || cwdStr;
            const stats = s?.getSessionStats?.();
            if (stats?.tokens) {
                tokens = {
                    input: stats.tokens.input,
                    output: stats.tokens.output,
                    cacheRead: stats.tokens.cacheRead,
                    cacheWrite: stats.tokens.cacheWrite,
                };
                cost = stats.cost ?? 0;
            }
            if (st?.model && s?.modelRegistry?.isUsingOAuth)
                sub = !!s.modelRegistry.isUsingOAuth(st.model);
            const usage = s?.getContextUsage?.();
            context = {
                percent: usage?.percent ?? null,
                window: usage?.contextWindow ?? st?.model?.contextWindow ?? 0,
            };
            autoCompact = !!s?.autoCompactionEnabled;
        } catch {
            /* best-effort */
        }
        let statuses: { key: string; text: string }[] = [];
        try {
            statuses = registry?.getStatuses?.() ?? [];
        } catch {
            /* best-effort */
        }
        // Host-native git branch (pi-tui footerData.getGitBranch parity): read
        // the thread's live watcher cache; null outside a repo / when unknown.
        let gitBranch: string | null = null;
        try {
            gitBranch = thread?.gitWatcher?.getBranch?.() ?? null;
        } catch {
            /* best-effort */
        }
        // Count of selectable models (footerData.getAvailableProviderCount parity).
        let availableModels = 0;
        try {
            availableModels = s?.modelRegistry?.getAvailable?.()?.length ?? 0;
        } catch {
            /* best-effort */
        }
        return {
            cwd: formatCwdForFooter(cwdStr, homeDir),
            session,
            model,
            reasoning,
            level,
            tokens,
            cost,
            sub,
            context,
            autoCompact,
            gitBranch,
            availableModels,
            statuses,
        };
    }

    /**
     * Build the `footer` frame: the default below-composer context bar that
     * mirrors the pi TUI footer. If an extension owns the footer, include its
     * custom node tree.
     */
    function footerFrame(
        s: AgentSession | null | undefined,
        threadCwd = "",
        reg?: any,
    ) {
        const thread = threadForSession(s);
        const registry = reg ?? thread?.piweb;
        const base = buildFooterData(s, threadCwd || rootCwd, thread, registry);
        const factory = registry?.getFooterFactory?.();
        if (factory) {
            try {
                const custom = factory({ ...base }, themeVars());
                if (custom) return { kind: "footer" as const, ...base, custom };
            } catch (err) {
                console.error("setFooter factory threw:", err);
            }
        }
        return { kind: "footer" as const, ...base };
    }

    /**
     * Build the `header` frame: an extension-owned custom header above the
     * transcript. `custom` is null when no header factory is set.
     */
    function headerFrame(
        s: AgentSession | null | undefined,
        threadCwd = "",
        reg?: any,
    ) {
        const thread = threadForSession(s);
        const registry = reg ?? thread?.piweb;
        const factory = registry?.getHeaderFactory?.();
        if (!factory) return { kind: "header" as const, custom: null };
        try {
            const base = buildFooterData(
                s,
                threadCwd || rootCwd,
                thread,
                registry,
            );
            const custom = factory({ ...base }, themeVars());
            return { kind: "header" as const, custom: custom || null };
        } catch (err) {
            console.error("setHeader factory threw:", err);
            return { kind: "header" as const, custom: null };
        }
    }

    /** Build the per-thread steering/follow-up queue frame. */
    function queueFrame(s: AgentSession | null | undefined) {
        let items: string[] = [];
        try {
            const steering = s?.getSteeringMessages?.() ?? [];
            const followUp = s?.getFollowUpMessages?.() ?? [];
            items = [...steering, ...followUp];
        } catch {
            /* best-effort: empty queue */
        }
        return { kind: "queue" as const, items };
    }

    /**
     * Build a `custom` transcript frame for an extension CustomMessage. If a
     * renderer is registered for its customType, ship the serialized component
     * tree; otherwise fall back to the message's text content.
     */
    function customFrame(
        reg: PiWebRegistry | null | undefined,
        m: any,
    ): ServerMessage {
        const frame: ServerMessage = {
            kind: "custom",
            customType: m.customType || "",
        };
        let tree = null;
        try {
            tree = reg?.renderMessage?.(m.customType, m, { expanded: false });
        } catch {
            tree = null;
        }
        if (tree) frame.tree = tree;
        else frame.text = textOf(m.content);
        return frame;
    }

    return {
        thinkingLevelFrame,
        buildFooterData,
        footerFrame,
        headerFrame,
        queueFrame,
        customFrame,
    };
}
