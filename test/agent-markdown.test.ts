// The assistant bubble's tiny markdown subset (`web/markdown.js` and
// `web/markdown-view.js`).
//
// Why this file exists: the model writes `- **Breakfast** (07:00)` and the
// caregiver was reading the asterisks. Rendering them is the fix; the risk is
// that "rendering markdown" turns model output into markup. So these tests pin
// both halves:
//   * the parser's boundaries — text is never dropped, an unmatched marker is
//     literal, blank lines split blocks, and `<script>` is text;
//   * the renderer's shape — the parsed records become `strong`/`code`/`li`
//     vnodes holding *string children*, and the Agent view sends only
//     `assistant` entries through it (a caregiver's own typing stays literal).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

// `web/` is plain JavaScript outside `tsc`'s include list (it runs in the
// browser through node-free ES modules), so it is imported by a path the
// compiler does not resolve rather than keeping a second, hand-written copy of
// its types.
const WEB = join(import.meta.dirname, "..", "web");
const { parseMarkdown, spansOf } = await import(join(WEB, "markdown.js"));
const { MarkdownText } = await import(join(WEB, "markdown-view.js"));
const { Agent } = await import(join(WEB, "views", "agent.js"));

// --- vnode helpers (the idea from test/client.test.js) ----------------------

/** The first vnode whose type is `type`, intrinsic (`"strong"`) or component. */
function findVnode(node: any, type: string): any {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findVnode(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (node && typeof node === "object") {
    if (node.type === type || node.type?.name === type) return node;
    return findVnode(node.props?.children, type);
  }
  return undefined;
}

function countVnodes(node: any, type: string): number {
  let count = 0;
  const walk = (current: any) => {
    if (Array.isArray(current)) return current.forEach(walk);
    if (current && typeof current === "object") {
      if (current.type === type || current.type?.name === type) count += 1;
      walk(current.props?.children);
    }
  };
  walk(node);
  return count;
}

// --- inline spans ----------------------------------------------------------

test("a sentence keeps its text around bold and inline code, in order", () => {
  assert.deepEqual(spansOf("fed by **Owner** at `18:27` today"), [
    { type: "text", text: "fed by " },
    { type: "strong", text: "Owner" },
    { type: "text", text: " at " },
    { type: "code", text: "18:27" },
    { type: "text", text: " today" },
  ]);
});

test("an unmatched marker stays literal instead of swallowing the rest of the line", () => {
  // The model's stray asterisk must not eat a caregiver's words.
  assert.deepEqual(spansOf("a **oops"), [{ type: "text", text: "a **oops" }]);
  assert.deepEqual(spansOf("**oops** and **dangling"), [
    { type: "strong", text: "oops" },
    { type: "text", text: " and **dangling" },
  ]);
  // An empty body (`****`) is literal too, and so is a lone backtick.
  assert.deepEqual(spansOf("****"), [{ type: "text", text: "****" }]);
  assert.deepEqual(spansOf("a `b"), [{ type: "text", text: "a `b" }]);
});

// --- blocks ----------------------------------------------------------------

test("blank lines split paragraphs and a single newline inside one is kept", () => {
  assert.deepEqual(parseMarkdown("first\nsecond\n\nthird"), [
    { type: "paragraph", spans: [{ type: "text", text: "first\nsecond" }] },
    { type: "paragraph", spans: [{ type: "text", text: "third" }] },
  ]);
});

test("a run of bullets is one list block whose items carry inline spans", () => {
  assert.deepEqual(parseMarkdown("- **Breakfast** (07:00) — fed\n- Lunch (12:00)\n- Dinner (19:00)"), [
    {
      type: "list",
      items: [
        {
          spans: [
            { type: "strong", text: "Breakfast" },
            { type: "text", text: " (07:00) — fed" },
          ],
        },
        { spans: [{ type: "text", text: "Lunch (12:00)" }] },
        { spans: [{ type: "text", text: "Dinner (19:00)" }] },
      ],
    },
  ]);
});

test("every bullet marker the model writes is a list, and prose ends one", () => {
  assert.deepEqual(parseMarkdown("* one\n• two\ntext"), [
    { type: "list", items: [{ spans: [{ type: "text", text: "one" }] }, { spans: [{ type: "text", text: "two" }] }] },
    { type: "paragraph", spans: [{ type: "text", text: "text" }] },
  ]);
});

test("a dash without a space is a dash, not a bullet", () => {
  assert.deepEqual(parseMarkdown("-\nnot a list"), [
    { type: "paragraph", spans: [{ type: "text", text: "-\nnot a list" }] },
  ]);
  assert.deepEqual(parseMarkdown("a - b"), [{ type: "paragraph", spans: [{ type: "text", text: "a - b" }] }]);
});

test("a heading is a paragraph, so nothing is rendered that was not parsed", () => {
  assert.deepEqual(parseMarkdown("# Today\nbody"), [
    { type: "paragraph", spans: [{ type: "text", text: "# Today\nbody" }] },
  ]);
});

test("empty, whitespace-only and non-string input has no blocks", () => {
  assert.deepEqual(parseMarkdown(""), []);
  assert.deepEqual(parseMarkdown("   \n\t\n \n"), []);
  assert.deepEqual(parseMarkdown(undefined), []);
});

// --- the security stance ---------------------------------------------------

test("model HTML comes back as plain text, character for character", () => {
  const img = '<img src=x onerror=alert(1)>';
  const script = "<script>alert(1)</script>";

  // No element, no attribute, no entity decoding: one `text` span.
  assert.deepEqual(parseMarkdown(img), [{ type: "paragraph", spans: [{ type: "text", text: img }] }]);
  assert.deepEqual(parseMarkdown(script), [{ type: "paragraph", spans: [{ type: "text", text: script }] }]);
  // Even inside a bullet and inside bold, the characters are untouched.
  assert.deepEqual(parseMarkdown(`- ${script}`), [
    { type: "list", items: [{ spans: [{ type: "text", text: script }] }] },
  ]);
  assert.deepEqual(spansOf(`**${img}**`), [{ type: "strong", text: img }]);

  // The invariant behind all of the above: for text with no marker in it, the
  // spans hold the input exactly — an HTML-looking string has nowhere else to
  // go. (Markers, and only markers, are removed; that is asserted above.)
  for (const input of [img, script, `a ${img} and ${script} b`, `- ${img}`]) {
    for (const block of parseMarkdown(input)) {
      const spans = block.type === "list" ? block.items[0].spans : block.spans;
      assert.equal(spans.map((span: any) => span.text).join(""), input.replace(/^[-*•]\s+/, ""));
    }
  }
});

/** The source with comments removed: a comment that *names* a sink is not a use. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .trim();
}

test("nothing under web/ builds HTML from the model's text", async () => {
  for (const file of ["markdown.js", "markdown-view.js", join("views", "agent.js")]) {
    const code = codeOnly(await readFile(join(WEB, file), "utf8"));
    for (const sink of ["innerHTML", "dangerouslySetInnerHTML", "__html", "insertAdjacentHTML", "outerHTML"]) {
      assert.ok(!code.includes(sink), `${file} must not use ${sink}`);
    }
  }
});

// --- the renderer ----------------------------------------------------------

test("MarkdownText turns bold into a strong vnode holding the text as a child", () => {
  const tree = MarkdownText({ text: "**hi**" });
  const strong = findVnode(tree, "strong");
  assert.ok(strong, "`**hi**` renders a strong element");
  assert.equal(strong.props.children, "hi");
  assert.ok(findVnode(tree, "p"), "the paragraph is its own block");
});

test("MarkdownText renders a list as li nodes, with code as text", () => {
  const tree = MarkdownText({ text: "- a\n- **b**\n- `18:27`" });
  assert.equal(countVnodes(tree, "li"), 3);
  assert.equal(findVnode(tree, "strong").props.children, "b");
  assert.equal(findVnode(tree, "code").props.children, "18:27");
  // Nothing is rendered for text with no blocks.
  assert.equal(MarkdownText({ text: "  \n " }), null);
});

test("the Agent sends assistant replies through MarkdownText and chat bubbles literally", () => {
  const agent: any = new Agent({ request: async () => ({}) });
  agent.state = { ...agent.state, loading: false, session: null };
  agent.timezone = () => "Europe/Paris";

  const assistant = agent.renderEntry({
    kind: "assistant",
    entryId: 7,
    at: "2026-11-06T09:00:00.000Z",
    text: "- **Breakfast** (07:00)",
  });
  const markdown = findVnode(assistant, "MarkdownText");
  assert.ok(markdown, "an assistant reply is rendered as markdown");
  assert.equal(markdown.props.text, "- **Breakfast** (07:00)", "the raw text is what gets parsed");
  const bubble = findVnode(assistant, "div");
  assert.equal(bubble?.props?.class, "thread__bubble thread__bubble--agent", "the bubble keeps its class names");

  // A person's own typing is shown as typed: a literal `**` must not become bold.
  const chat = agent.renderEntry({
    kind: "chat",
    entryId: 8,
    at: "2026-11-06T09:00:00.000Z",
    authorId: "owner",
    authorName: "Alex",
    text: "**not bold**",
  });
  assert.equal(findVnode(chat, "MarkdownText"), undefined, "chat bubbles are not markdown");
  assert.equal(findVnode(chat, "strong"), undefined, "no strong node in a caregiver's message");
});
