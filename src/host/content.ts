/** Pull plain text out of a message's content (string | block[]). */
export function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("");
}

/**
 * Pull image blocks out of a message's content (block[] only). Images live as
 * `{ type:"image", data:base64, mimeType }` content blocks.
 */
export function imagesOf(
    content: unknown,
): { data: string; mimeType: string }[] {
    if (!Array.isArray(content)) return [];
    return content
        .filter((b) => b?.type === "image" && b.data)
        .map((b) => ({ data: b.data, mimeType: b.mimeType }));
}

/** Pull thinking/reasoning text out of a message's content (block[] only). */
export function thinkingOf(content: unknown): string {
    if (!Array.isArray(content)) return "";
    return content
        .filter((b) => b?.type === "thinking" && !b.redacted)
        .map((b) => b.thinking ?? "")
        .join("");
}

export function describeError(raw: unknown): string {
    if (!raw) return "model returned an error";
    try {
        return JSON.parse(String(raw))?.error?.message ?? String(raw);
    } catch {
        return String(raw);
    }
}
