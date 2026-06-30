/**
 * Minimal, safe Markdown -> HTML renderer (no dependencies).
 *
 * Supports: fenced + inline code, ATX headings, bold/italic, links, ordered /
 * unordered lists, blockquotes, and paragraphs. Everything is HTML-escaped
 * first, and only http(s)/mailto/relative URLs are allowed — so assistant
 * output can never inject markup or scripts.
 */

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeUrl(url) {
    const u = url.trim();
    if (/^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i.test(u)) return u;
    return "#";
}

// Inline formatting. Operates on already-escaped text.
function inline(text) {
    let out = text;
    // protect inline code spans first
    const codes = [];
    out = out.replace(/`([^`]+)`/g, (_, c) => {
        codes.push(c);
        return `\u0000C${codes.length - 1}\u0000`;
    });
    // links [text](url)
    out = out.replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_, t, url) =>
            `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${t}</a>`,
    );
    // bold, then italic
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    out = out.replace(
        /(^|[^a-zA-Z0-9_])_([^_]+)_(?=$|[^a-zA-Z0-9_])/g,
        "$1<em>$2</em>",
    );
    // restore inline code
    out = out.replace(
        /\u0000C(\d+)\u0000/g,
        (_, i) => `<code>${codes[+i]}</code>`,
    );
    return out;
}

export function renderMarkdown(src) {
    const text = escapeHtml(String(src ?? "")).replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    const html = [];
    let i = 0;
    let listType = null; // "ul" | "ol"

    const closeList = () => {
        if (listType) {
            html.push(`</${listType}>`);
            listType = null;
        }
    };

    while (i < lines.length) {
        const line = lines[i];

        // fenced code block
        if (/^```/.test(line)) {
            closeList();
            const buf = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i]))
                buf.push(lines[i++]);
            i++; // consume closing fence
            html.push(`<pre><code>${buf.join("\n")}</code></pre>`);
            continue;
        }

        // blank line
        if (/^\s*$/.test(line)) {
            closeList();
            i++;
            continue;
        }

        // heading
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            closeList();
            const level = h[1].length;
            html.push(`<h${level}>${inline(h[2])}</h${level}>`);
            i++;
            continue;
        }

        // blockquote
        if (/^>\s?/.test(line)) {
            closeList();
            const buf = [];
            while (i < lines.length && /^>\s?/.test(lines[i]))
                buf.push(lines[i++].replace(/^>\s?/, ""));
            html.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
            continue;
        }

        // unordered list
        const ul = line.match(/^\s*[-*+]\s+(.*)$/);
        if (ul) {
            if (listType !== "ul") {
                closeList();
                html.push("<ul>");
                listType = "ul";
            }
            html.push(`<li>${inline(ul[1])}</li>`);
            i++;
            continue;
        }

        // ordered list
        const ol = line.match(/^\s*\d+\.\s+(.*)$/);
        if (ol) {
            if (listType !== "ol") {
                closeList();
                html.push("<ol>");
                listType = "ol";
            }
            html.push(`<li>${inline(ol[1])}</li>`);
            i++;
            continue;
        }

        // paragraph: gather consecutive "plain" lines
        closeList();
        const buf = [line];
        i++;
        while (
            i < lines.length &&
            !/^\s*$/.test(lines[i]) &&
            !/^```/.test(lines[i]) &&
            !/^#{1,6}\s/.test(lines[i]) &&
            !/^>\s?/.test(lines[i]) &&
            !/^\s*[-*+]\s+/.test(lines[i]) &&
            !/^\s*\d+\.\s+/.test(lines[i])
        ) {
            buf.push(lines[i++]);
        }
        html.push(`<p>${inline(buf.join("<br>"))}</p>`);
    }
    closeList();
    return html.join("\n");
}
