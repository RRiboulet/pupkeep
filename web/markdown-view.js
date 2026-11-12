// The Agent screen's bubble renderer for an assistant reply: the blocks
// `web/markdown.js` parsed, as Preact vnodes.
//
// What this file is allowed to be: a mapping. It takes the parser's
// `{type, text}` records and returns elements — `<p>`, `<ul>/<li>`, `<strong>`,
// `<code>` — with the text bound as *children*. Preact sets a text node for a
// string child, so model output can never become markup: there is no
// `innerHTML`, no `dangerouslySetInnerHTML`, no attribute built from the text,
// and nothing to escape. The parser's own header carries the security argument;
// this one is just the second half of it, kept deliberately dull.
//
// Class names stay on the caller's wrapper (`.thread__bubble--agent`) so the
// existing bubble typography, padding and `white-space: pre-wrap` apply
// unchanged, and the few rules the block markup needs live beside them in
// `style.css`. Caregiver `chat` bubbles never come through here: a person's own
// typing is shown literally, as typed.

import { Fragment, h } from "./vendor/preact.mjs";
import htm from "./vendor/htm.mjs";
import { parseMarkdown } from "./markdown.js";

const html = htm.bind(h);

/**
 * One span as a child. A `text` span stays a plain string — the same thing the
 * bubble used to render, so nothing about plain text changes.
 */
function spanNode(span, index) {
  if (span.type === "strong") return html`<strong key=${index}>${span.text}</strong>`;
  if (span.type === "code") return html`<code key=${index}>${span.text}</code>`;
  return span.text;
}

function spansNodes(spans) {
  return spans.map(spanNode);
}

/**
 * `MarkdownText({ text })` — the reply's blocks. Empty text renders nothing
 * (the parser returns no blocks for it, and an empty bubble is better than an
 * empty line).
 */
export function MarkdownText({ text }) {
  const blocks = parseMarkdown(text);
  if (blocks.length === 0) return null;

  return html`<${Fragment}>${blocks.map((block, index) =>
    block.type === "list"
      ? html`<ul key=${index}>${block.items.map((item, itemIndex) =>
          html`<li key=${itemIndex}>${spansNodes(item.spans)}</li>`,
        )}</ul>`
      : html`<p key=${index}>${spansNodes(block.spans)}</p>`,
  )}</${Fragment}>`;
}
