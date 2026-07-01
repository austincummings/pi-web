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

// Split a table row into trimmed cells, ignoring the optional
// leading/trailing pipes. Operates on already-escaped text.
function splitRow(line) {
    const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return s.split("|").map((c) => c.trim());
}

// A GFM table starts where a header row (contains "|") is immediately
// followed by a delimiter row whose every cell is `:?-+:?` (---, :--, --:,
// :-:). The two-line lookahead avoids misfiring on stray "|" in prose.
function isTableStart(lines, i) {
    const head = lines[i];
    const delim = lines[i + 1];
    if (!head || !delim || !head.includes("|") || !delim.includes("|"))
        return false;
    const cells = splitRow(delim);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
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

        // GFM table: header row + delimiter row, then body rows
        if (isTableStart(lines, i)) {
            closeList();
            const headers = splitRow(lines[i]);
            const aligns = splitRow(lines[i + 1]).map((c) => {
                const l = c.startsWith(":");
                const r = c.endsWith(":");
                if (l && r) return "center";
                if (r) return "right";
                if (l) return "left";
                return "";
            });
            i += 2;
            const cell = (tag, txt, idx) => {
                const a = aligns[idx];
                const style = a ? ` style="text-align:${a}"` : "";
                return `<${tag}${style}>${inline(txt)}</${tag}>`;
            };
            const head = headers.map((c, idx) => cell("th", c, idx)).join("");
            const rows = [];
            while (
                i < lines.length &&
                lines[i].includes("|") &&
                !/^\s*$/.test(lines[i])
            ) {
                const cells = splitRow(lines[i++]);
                const tds = headers
                    .map((_, idx) => cell("td", cells[idx] ?? "", idx))
                    .join("");
                rows.push(`<tr>${tds}</tr>`);
            }
            html.push(
                `<div class="table-wrap"><table><thead><tr>${head}</tr></thead>` +
                    `<tbody>${rows.join("")}</tbody></table></div>`,
            );
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
            !/^\s*\d+\.\s+/.test(lines[i]) &&
            !isTableStart(lines, i)
        ) {
            buf.push(lines[i++]);
        }
        html.push(`<p>${inline(buf.join("<br>"))}</p>`);
    }
    closeList();
    // Join with "" (not "\n"): the blocks are all block-level elements, so the
    // separator is cosmetic — but if the output is mounted in a `white-space:
    // pre-wrap` context (e.g. an extension custom-message `Markdown` node inside
    // `.msg`), stray "\n"s between tags render as blank lines. Fenced code keeps
    // its own newlines inside the <pre> string, so nothing visible is lost.
    return html.join("");
}

/**
 * Layout-preserving syntax highlighter for the composer textarea backdrop.
 *
 * Unlike renderMarkdown (which produces structural HTML), this keeps EVERY
 * source character — including the markdown markers themselves — so the output
 * lays out glyph-for-glyph identically to the underlying <textarea>. Tokens are
 * merely wrapped in <span> tints. Because the composer font is monospace,
 * bold/italic keep the same advance width, so the caret stays aligned.
 *
 * Input is HTML-escaped first; only <span class> wrappers are ever emitted, so
 * this can never inject markup.
 */
function highlightInline(s) {
    // Stash each matched token as a placeholder so later passes can't re-match
    // inside an already-wrapped span. NUL delimiters never occur in real input.
    const stash = [];
    const keep = (cls, str) => {
        stash.push(`<span class="${cls}">${str}</span>`);
        return `\u0000${stash.length - 1}\u0000`;
    };
    s = s.replace(/(`+)([^`]*?)\1/g, (m) => keep("md-code", m)); // inline code
    s = s.replace(/\[[^\]]*\]\([^)\s]*\)/g, (m) => keep("md-link", m)); // links
    s = s.replace(/\*\*[^*]+\*\*/g, (m) => keep("md-strong", m)); // **bold**
    s = s.replace(/__[^_]+__/g, (m) => keep("md-strong", m)); // __bold__
    s = s.replace(/\*[^*\s][^*]*\*/g, (m) => keep("md-em", m)); // *italic*
    s = s.replace(
        /(^|[^\w\u0000])_([^_]+)_(?=$|[^\w])/g,
        (_, p, t) => p + keep("md-em", `_${t}_`),
    ); // _italic_
    s = s.replace(/(^|\s)(@[^\s]+)/g, (_, p, t) => p + keep("md-mention", t)); // @file
    // Restore placeholders (repeat: a token may nest inside another's text).
    let prev;
    do {
        prev = s;
        s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[+i]);
    } while (s !== prev && /\u0000\d+\u0000/.test(s));
    return s;
}

export function highlightComposer(src) {
    const text = escapeHtml(String(src ?? "")).replace(/\r\n?/g, "\n");
    const lines = text.split("\n");
    let inFence = false;
    const out = lines.map((line, idx) => {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            return `<span class="md-code">${line}</span>`;
        }
        if (inFence) return `<span class="md-code">${line}</span>`;

        let m;
        // `!`/`!!` shell or `/command` — only meaningful at the very start.
        if (idx === 0 && (m = line.match(/^(!!?|\/[\w:-]*)/)))
            return (
                `<span class="md-cmd">${m[1]}</span>` +
                highlightInline(line.slice(m[1].length))
            );
        // ATX heading
        if ((m = line.match(/^(\s*)(#{1,6})(\s+)(.*)$/)))
            return `${m[1]}<span class="md-h">${m[2]}${m[3]}${highlightInline(m[4])}</span>`;
        // blockquote (`>` is already HTML-escaped to `&gt;` at this point)
        if ((m = line.match(/^(\s*)(&gt;)(\s?)(.*)$/)))
            return `${m[1]}<span class="md-quote">${m[2]}${m[3]}${highlightInline(m[4])}</span>`;
        // unordered / ordered list marker
        if ((m = line.match(/^(\s*)([-*+])(\s+)(.*)$/)))
            return `${m[1]}<span class="md-marker">${m[2]}</span>${m[3]}${highlightInline(m[4])}`;
        if ((m = line.match(/^(\s*)(\d+\.)(\s+)(.*)$/)))
            return `${m[1]}<span class="md-marker">${m[2]}</span>${m[3]}${highlightInline(m[4])}`;
        return highlightInline(line);
    });
    // A trailing newline needs a filler char, else the block clips its last
    // (empty) line and the backdrop scrolls out of sync with the textarea.
    return out.join("\n") + "\n";
}
