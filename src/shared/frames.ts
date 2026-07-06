/**
 * The single source of truth for the server→client SSE wire vocabulary.
 *
 * The host (`src/host/*`) constructs these frames and broadcasts them over the
 * SSE bus; the web front-end (`src/web/app.ts` `onSseMessage`) consumes them.
 * Modeling them as a discriminated union keyed on `kind` lets `switch (m.kind)`
 * narrow each payload, so a renamed field or a dropped case becomes a compile
 * error instead of a silent `undefined` at runtime.
 *
 * We intentionally *do not* runtime-validate these on the client: the producer
 * is our own host in the same repo/trust domain, so the value here is
 * drift-catching (a job the type checker already does at the `broadcast` call
 * sites), not sanitizing untrusted input.
 *
 * Frame payloads that originate from *extensions* rather than our host
 * (`ToolFrame.args`/`details`, `CustomFrame`'s message) stay `unknown` — they
 * are genuinely open and consumers must narrow them, but they are never `any`.
 *
 * Reuse note: `BashFrame`/`ThinkingFrame`/`ToolFrame` are defined next to the
 * custom elements that own their rendering, and `WelcomeSection` next to the
 * welcome view. We pull them in with `import type` (fully erased at runtime) so
 * the agent-independent host never drags DOM/custom-element runtime into its
 * bundle.
 */
import type { BashFrame } from "../web/pi-bash.ts";
import type { ThinkingFrame } from "../web/pi-thinking.ts";
import type { ToolFrame } from "../web/pi-tool.ts";
import type { WelcomeError, WelcomeSection } from "../web/welcome.ts";

export type { BashFrame, ThinkingFrame, ToolFrame, WelcomeSection };

/* ---- shared sub-shapes ------------------------------------------------ */

export type NotifyLevel = "info" | "success" | "warn" | "error";

/**
 * A serializable render-model node (Box/Text/Image/Frame/…). Modeled loosely
 * here — the full discriminated node union is a separate hardening step; this
 * keeps the property access the frame consumers need (`.type`, `.html`, …)
 * working without falling back to `any`.
 */
export interface FrameNode {
    type?: string;
    [key: string]: unknown;
}

/** An attached image block: either a data payload or a URL. */
export interface ImageRef {
    data?: string;
    mimeType?: string;
    url?: string;
}

/** A single keyed status segment (pi-tui `setStatus`). */
export interface StatusSegment {
    text: string;
    [key: string]: unknown;
}

/** A dock/overlay card carrying a serializable node tree. */
export interface SurfaceCard {
    id: string;
    title?: string;
    tree?: FrameNode;
    options?: OverlayOptions;
}

/** Anchor/size hints for an overlay card. */
export interface OverlayOptions {
    width?: number | string;
    maxHeight?: number | string;
    anchor?: string;
    [key: string]: unknown;
}

/** The dock/overlay/status/dialog snapshot carried by a `surfaces` frame. */
export interface SurfacesPayload {
    docks?: { aboveEditor?: SurfaceCard[]; belowEditor?: SurfaceCard[] };
    overlays?: SurfaceCard[];
    status?: StatusSegment[];
    dialogs?: unknown[];
}

/** Per-thread override for the streaming working indicator. */
export interface WorkingConfig {
    message?: string;
    visible?: boolean;
    indicator?: string;
    [key: string]: unknown;
}

/** A conversation (thread) list entry. */
export interface ThreadListItem {
    id: string;
    [key: string]: unknown;
}

/* ---- the frames ------------------------------------------------------- */

interface Base<K extends string> {
    kind: K;
}

export interface ConfigFrame extends Base<"config"> {
    cwd?: string;
}
export interface WelcomeFrame extends Base<"welcome"> {
    version?: string;
    sections?: WelcomeSection[];
    reload?: boolean;
    /** Extensions that failed to load (surfaced so they don't vanish silently). */
    errors?: WelcomeError[];
}
export interface ThemeFrame extends Base<"theme"> {
    vars?: Record<string, string>;
}
export interface SurfacesFrame extends Base<"surfaces"> {
    surfaces: SurfacesPayload;
}
export interface NotifyFrame extends Base<"notify"> {
    message: string;
    level?: NotifyLevel;
}
export interface FooterFrame extends Base<"footer"> {
    /** When set, an extension owns the footer: render this node in place. */
    custom?: FrameNode;
    cwd?: string;
    session?: string;
    tokens?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    cost?: number;
    sub?: boolean;
    context?: { percent?: number; window?: number };
    autoCompact?: boolean;
    model?: string;
    reasoning?: boolean;
    level?: string;
}
export interface HeaderFrame extends Base<"header"> {
    /** Extension-owned header node, or null/absent to restore the default. */
    custom?: FrameNode | null;
}
export interface TitleFrame extends Base<"title"> {
    text: string;
}
export interface ThreadsFrame extends Base<"threads"> {
    items: ThreadListItem[];
}
export interface ThreadSwitchedFrame extends Base<"thread_switched"> {
    id: string;
}
export interface WorkingFrame extends Base<"working"> {
    busy: boolean;
}
export interface WorkingConfigFrame extends Base<"working_config"> {
    config?: WorkingConfig;
}
export interface TrustRequiredFrame extends Base<"trust_required"> {}
export interface QueueFrame extends Base<"queue"> {
    items: string[];
}
export interface TranscriptResetFrame extends Base<"transcript_reset"> {}
export interface ThinkingLevelFrame extends Base<"thinking_level"> {
    level?: string;
    supported?: boolean;
}
export interface ThinkingVisibilityFrame extends Base<"thinking_visibility"> {
    hidden?: boolean;
}
export interface ThinkingLabelFrame extends Base<"thinking_label"> {
    label?: string;
}
export interface EditorFrame extends Base<"editor"> {
    op?: "set" | "paste";
    text?: string;
}
export interface ToolsExpandedFrame extends Base<"tools_expanded"> {
    expanded?: boolean;
}
export interface UserFrame extends Base<"user"> {
    text: string;
    images?: ImageRef[];
}
export interface DeltaFrame extends Base<"delta"> {
    text: string;
}
export interface AssistantFullFrame extends Base<"assistant_full"> {
    text: string;
}
export interface AssistantEndFrame extends Base<"assistant_end"> {}
export interface SystemFrame extends Base<"system"> {
    text: string;
}
export interface ErrorFrame extends Base<"error"> {
    text: string;
}
export interface CustomFrame extends Base<"custom"> {
    /** The custom message type, shown as the role label. */
    customType?: string;
    /** A registered renderer's serialized node tree, if any. */
    tree?: FrameNode;
    /** Fallback markdown text when no renderer tree is supplied. */
    text?: string;
}

/**
 * A step in the OAuth `/login` flow (pi-tui parity). The host drives
 * `authStorage.login()` and translates its callbacks into these frames; the
 * `<pi-login>` overlay renders them and, for `prompt` steps, posts the user's
 * answer back to `/login/respond` (keyed by `loginId`). One interactive prompt
 * is outstanding at a time per `loginId`.
 */
export interface LoginFrame extends Base<"login"> {
    /** Correlates every frame of one login flow; the key for respond/cancel. */
    loginId: string;
    event:
        | "start"
        | "auth_url"
        | "device_code"
        | "prompt"
        | "progress"
        | "done"
        | "cancelled";
    provider?: { id: string; name: string };
    /** auth_url: the URL to open (plus optional instructions). */
    url?: string;
    instructions?: string;
    /** device_code: the user code + verification URL and timing hints. */
    userCode?: string;
    verificationUri?: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
    /** prompt: what kind of input to collect and its label. */
    promptKind?: "text" | "secret" | "manual_code" | "select";
    message?: string;
    placeholder?: string;
    allowEmpty?: boolean;
    options?: Array<{ id: string; label: string }>;
    /** done: terminal outcome. */
    ok?: boolean;
    error?: string;
}

// `bash`/`thinking`/`tool` reuse the element-owned payloads, tagged with their
// discriminant. The payloads deliberately omit `kind` (the elements' `apply()`
// takes them directly), so we intersect it in here.
export type BashMsg = { kind: "bash" } & BashFrame;
export type ThinkingMsg = { kind: "thinking" } & ThinkingFrame;
export type ToolMsg = { kind: "tool" } & ToolFrame;

/* ---- the union + helpers ---------------------------------------------- */

export type ServerFrame =
    | ConfigFrame
    | WelcomeFrame
    | ThemeFrame
    | SurfacesFrame
    | NotifyFrame
    | FooterFrame
    | HeaderFrame
    | TitleFrame
    | ThreadsFrame
    | ThreadSwitchedFrame
    | WorkingFrame
    | WorkingConfigFrame
    | TrustRequiredFrame
    | QueueFrame
    | TranscriptResetFrame
    | ThinkingLevelFrame
    | ThinkingVisibilityFrame
    | ThinkingLabelFrame
    | EditorFrame
    | ToolsExpandedFrame
    | UserFrame
    | DeltaFrame
    | AssistantFullFrame
    | AssistantEndFrame
    | SystemFrame
    | ErrorFrame
    | CustomFrame
    | LoginFrame
    | BashMsg
    | ThinkingMsg
    | ToolMsg;

/** All valid `kind` discriminants. */
export type FrameKind = ServerFrame["kind"];

/** Narrow a specific frame by kind, e.g. `Frame<"bash">` → `BashMsg`. */
export type Frame<K extends FrameKind> = Extract<ServerFrame, { kind: K }>;
