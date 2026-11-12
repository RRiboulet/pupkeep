// The tiny markdown subset an assistant reply is rendered with (the Agent
// screen's bubbles). Plain functions over plain strings: no Preact, no DOM, no
// fetch, so a Node test can pin every boundary without a browser.
//
// Why a subset at all: the model writes `- **Breakfast** (07:00) — fed by Owner`
// and a caregiver was reading the markers literally. Rendering them needs
// *some* parser, and the honest smallest one is better than a dependency.
//
// Security stance — this is the whole point of doing it here:
//   * the model's text is untrusted input. This module only ever returns data:
//     `{type, text}` records whose `text` holds exactly the characters that came
//     in (minus the markers it recognised). It never produces HTML, never
//     builds a string an HTML parser would later interpret, and never decides
//     which element to use — `web/markdown-view.js` maps the records to Preact
//     vnodes, which set text nodes, not markup;
//   * there is no pass-through of anything: no links, no images, no HTML tags,
//     no inline styles or handlers. `<script>alert(1)</script>` is text, and it
//     comes out as a `text` span with those exact characters. That is why the
//     view can bind it as a child and stay innocent under CSP
//     `default-src 'self'`;
//   * text is never dropped. An unmatched `**` or backtick stays literal
//     instead of swallowing the rest of the line, and a marker with an empty
//     body (`****`) is literal too — silently losing a caregiver's words would
//     be worse than showing a stray asterisk.
//
// The supported subset, deliberately small:
//   * blocks: paragraphs (separated by a blank line) and bullet lists
//     (`- `, `* `, `• ` at the start of consecutive lines);
//   * inline: `**bold**` and `` `code` ``;
//   * a heading (`# …`) is a paragraph, so the `#` shows. Not supported, and
//     shown literally rather than half-rendered: italic, links, images, tables,
//     block quotes, fenced code, nested or indented bullets, and any inline
//     markup inside bold or code (those spans hold plain text).
//
// Newlines inside a paragraph are kept as `\n`: `.thread__bubble` is
// `white-space: pre-wrap`, so a line break the model wrote stays one line break
// and the renderer adds no blank space of its own.

/** A bullet line's marker: the marker character, then at least one space. */
const LIST_ITEM = /^[-*•][ \t]+([\s\S]*)$/;

/** The line's bullet body, or `null` when it is ordinary paragraph text. */
function listItemOf(line) {
  const match = LIST_ITEM.exec(line);
  // `-` with no space is a dash a person typed, not a bullet.
  return match ? match[1] : null;
}

/**
 * One line's inline spans, left to right.
 *
 * The scanner never removes a character it did not recognise as a marker, so
 * `a **b` stays `a **b`. Bold and code bodies are taken literally (no nested
 * parsing): a tiny subset that is always explainable beats one that guesses.
 */
export function spansOf(text) {
  const spans = [];
  let literal = "";
  let index = 0;

  const flush = () => {
    if (literal === "") return;
    spans.push({ type: "text", text: literal });
    literal = "";
  };

  while (index < text.length) {
    const char = text[index];

    if (char === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1) {
        flush();
        spans.push({ type: "code", text: text.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
      // Unmatched, or empty (``): the backtick is the caregiver's/ model's text.
      literal += char;
      index += 1;
      continue;
    }

    if (char === "*" && text[index + 1] === "*") {
      const close = text.indexOf("**", index + 2);
      if (close > index + 2) {
        flush();
        spans.push({ type: "strong", text: text.slice(index + 2, close) });
        index = close + 2;
        continue;
      }
      literal += "**";
      index += 2;
      continue;
    }

    literal += char;
    index += 1;
  }

  flush();
  return spans;
}

/**
 * A reply as blocks: `{type: "paragraph", spans}` and `{type: "list", items}`,
 * where each item is `{spans}`. Empty or whitespace-only input has no blocks.
 *
 * Trailing whitespace on a line is dropped (it renders as nothing anyway) so a
 * list marker followed by spaces is still a bullet; every other character is
 * kept.
 */
export function parseMarkdown(text) {
  if (typeof text !== "string" || text.trim() === "") return [];

  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));

  const blocks = [];
  /** `{type: "paragraph", lines}` or `{type: "list", items}` while open. */
  let open = null;

  const close = () => {
    if (open === null) return;
    if (open.type === "list") {
      blocks.push({ type: "list", items: open.items.map((item) => ({ spans: spansOf(item) })) });
    } else {
      blocks.push({ type: "paragraph", spans: spansOf(open.lines.join("\n")) });
    }
    open = null;
  };

  for (const line of lines) {
    if (line.trim() === "") {
      close();
      continue;
    }

    const item = listItemOf(line);
    if (item !== null) {
      if (open?.type !== "list") {
        close();
        open = { type: "list", items: [] };
      }
      open.items.push(item);
      continue;
    }

    if (open?.type !== "paragraph") {
      close();
      open = { type: "paragraph", lines: [] };
    }
    open.lines.push(line);
  }

  close();
  return blocks;
}
