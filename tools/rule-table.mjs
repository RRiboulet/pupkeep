#!/usr/bin/env node
// rule-table.mjs — deterministic checker for the "Rules and enforcement" table.
//
// Canonical copy: .pi/skills/prevent-recurrence/scripts/rule-table.mjs
// Format and JSON contract: .pi/skills/prevent-recurrence/references/rule-table.md
//
// Node standard library only: no dependencies, no network. Static validation
// only — proof references are checked for existence, never executed. That is the
// contract: the project's own gate runs the proof, this checker validates that a
// proof was recorded and still points at something real.
//
// Exit codes: 0 valid, 1 violation, 2 usage error.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import process from "node:process";

const CHECKER = "rule-table";
const VERSION = 1;

const HEADING = "## Rules and enforcement";
// A heading may be indented by up to three spaces, as GFM permits.
const HEADING_PATTERN = /^ {0,3}## Rules and enforcement\s*$/;
const LEVELS = ["architecture", "type", "lint", "test", "prose"];
const COLUMNS = ["rule", "level", "enforced by", "proof"];
const COLUMN_LABELS = {
	rule: "Rule",
	level: "Level",
	"enforced by": "Enforced by",
	proof: "Proof",
};

// A cell holding one of these names no enforcer at all. "none" and "n/a" are
// listed on purpose: writing them down is the same omission as leaving the cell
// empty, and the row must fail rather than look answered.
const EMPTY_ENFORCERS = new Set(["", "-", "--", "—", "–", "n/a", "none", "tbd", "tba"]);

const USAGE = `usage: rule-table.mjs check [--json] <AGENTS.md>
       rule-table.mjs --help
`;

const HELP = `rule-table.mjs — validate the "Rules and enforcement" table in an AGENTS.md

${USAGE}
Commands
  check <path>   Validate the table in <path>. Exit 0 when every row is
                 enforceable, 1 on a violation, 2 on a usage error.

Options
  --json         Print one JSON object instead of human lines. Same exit codes.
  --help, -h     Print this text.

Exit codes
  0  the table is valid
  1  at least one violation; each line names the file line, the table row and
     the reason
  2  bad invocation (no command, unknown flag, missing or unreadable path)

Table format
  The table sits under this exact heading, once per file, with at most three
  leading spaces:

    ${HEADING}

  It must be the first thing after the heading (blank lines allowed), and it must
  have a separator row with the same number of cells as the header. Nothing else
  may follow the table before the next heading: a second table, or a table-like
  line without its leading pipe, is a violation. The header carries these four
  columns, in any order; extra columns are ignored. Column names may be plain, in
  code spans or in bold:

    | Rule | Level | Enforced by | Proof |
    |---|---|---|---|
    | A branch descends from origin/dev | test | \`node tools/branch-base.mjs\` | \`tools/branch-base.md\` |
    | Every rule has an owner | prose | judgment: ownership is a human fact | \`tools/owners.md\` |

  Rule       Free text naming the rule. Two rows are duplicates when their rule
             text matches after trimming, collapsing whitespace and
             case-folding.
  Level      One of: architecture, type, lint, test, prose. Case-insensitive;
             surrounding backticks are ignored.
  Enforced   The command that fails when the rule is broken. A prose row instead
  by         needs \`judgment: <reason>\`: a reason of at least three characters
             that is not a placeholder (-, --, —, –, n/a, none, TBD, TBA). Empty
             cells are violations too.
  Proof      Either a backticked path — one or more code spans, each of which
             must exist — or a snippet pair written exactly as
             bad=<ref> good=<ref>, separated by whitespace. Use one form, not
             both. When the table's directory is inside a git work tree with
             history the refs are resolved with \`git rev-parse --verify\`;
             without git history only the ref format is checked. Nothing in
             Proof is executed.

  Paths resolve from the directory containing the table file. For a
  repository-root AGENTS.md that is the repository root, and in a linked worktree
  it is the worktree root, never the main checkout.

Reference: .pi/skills/prevent-recurrence/references/rule-table.md
`;

// ---------------------------------------------------------------------------
// Markdown table parsing
// ---------------------------------------------------------------------------

// The index of the next run of exactly `length` backticks at or after `from`,
// or -1. A run of a different length is text, not a closer: that is what makes
// a double-backtick span able to contain a `|` and a single backtick.
function findBacktickRun(text, from, length) {
	let index = from;
	while (index < text.length) {
		if (text[index] !== "`") {
			index++;
			continue;
		}
		let end = index;
		while (end < text.length && text[end] === "`") end++;
		if (end - index === length) return index;
		index = end;
	}
	return -1;
}

function splitRow(line) {
	// Split a table line into cells. `|` ends a cell unless it is backslash
	// escaped or inside a code span, so \`a | b\` and \`\`a|b\`\` stay one cell.
	let text = line.trim();
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);

	const cells = [];
	let current = "";
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (character === "\\" && text[index + 1] === "|") {
			current += "|";
			index += 2;
			continue;
		}
		if (character === "`") {
			let end = index;
			while (end < text.length && text[end] === "`") end++;
			const length = end - index;
			const close = findBacktickRun(text, end, length);
			// No matching run: the backticks are literal text, not a span. GFM
			// strips a backslash before a pipe even inside a table's code span.
			const stop = close === -1 ? end : close + length;
			current += text.slice(index, stop).replace(/\\\|/g, "|");
			index = stop;
			continue;
		}
		if (character === "|") {
			cells.push(current.trim());
			current = "";
			index++;
			continue;
		}
		current += character;
		index++;
	}
	cells.push(current.trim());
	return cells;
}

function stripDecorations(text) {
	// Column names and levels are often written `like this` or **like this**.
	return text
		.replace(/^`+|`+$/g, "")
		.replace(/^\*+|\*+$/g, "")
		.replace(/^_+|_+$/g, "")
		.trim();
}

function normalizeColumn(text) {
	return stripDecorations(text).toLowerCase().replace(/\s+/g, " ");
}

function normalizeRule(text) {
	return stripDecorations(text)
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function isEmptyEnforcer(text) {
	const value = stripDecorations(text).toLowerCase();
	return EMPTY_ENFORCERS.has(value) || value === "";
}

function isSeparatorRow(cells) {
	// One hyphen is enough for GFM: `|-|-|-|-|` is a valid separator.
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell.trim()));
}

// A prose row's reason is the text after `judgment:`. A placeholder is not a
// reason, however it is spelled: the point of the marker is that a person
// answered the question.
function hasJudgmentReason(enforcer) {
	const match = /^judgment:\s*(.*)$/.exec(stripDecorations(enforcer));
	if (!match) return false;
	const reason = match[1].trim();
	if (reason.length < 3) return false;
	return !EMPTY_ENFORCERS.has(reason.toLowerCase());
}

// git ref names: the subset of `git check-ref-format` a proof reference needs,
// minus the sha case, which is covered by the same character rules. Refs with
// whitespace, `..`, `~`, `^`, `:`, `?`, `*`, `[`, `\` or a leading `-` are
// malformed rather than merely unresolved, so a no-git directory can still
// reject them.
function isRefFormat(ref) {
	if (!ref || ref.length > 255) return false;
	if (/\s/.test(ref)) return false;
	if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/")) return false;
	if (ref.endsWith(".") || ref.endsWith(".lock")) return false;
	if (ref.includes("..") || ref.includes("//") || ref.includes("@{")) return false;
	if (/[~^:?*[\\\x00-\x1f\x7f]/.test(ref)) return false;
	return true;
}

function cleanRef(token) {
	return token.replace(/^`+|`+$/g, "").replace(/[.,;]+$/, "");
}

// A work tree with no commits cannot resolve a ref, so it degrades to the same
// format-only check as a directory without git. `git rev-list --all --count`
// fails outside a work tree and prints 0 inside a fresh `git init`, which is
// exactly the two cases to reject.
function gitAvailable(directory) {
	const result = spawnSync("git", ["rev-list", "--all", "--count"], {
		cwd: directory,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return false;
	const count = Number.parseInt(result.stdout.trim(), 10);
	return Number.isInteger(count) && count > 0;
}

function refResolves(directory, ref) {
	const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
		cwd: directory,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 && result.stdout.trim() !== "";
}

function displayPath(absolute, directory) {
	const relative = path.relative(directory, absolute);
	return relative === "" || relative.startsWith("..") ? absolute : relative;
}

// After the first table block: a second table, or a table-like line whose
// leading pipe is missing, is content GitHub drops. Report the first offender
// once and stop; the next heading ends the search, so a table in a later
// section is somebody else's table.
function scanAfterTable(lines, start, violate) {
	let firstNonBlank = true;
	for (let index = start; index < lines.length; index++) {
		if (/^ {0,3}#{1,6}\s/.test(lines[index])) return;
		const trimmed = lines[index].trim();
		if (trimmed === "") continue;
		if (firstNonBlank && trimmed.includes("|") && !trimmed.startsWith("|")) {
			violate({
				code: "row-missing-pipe",
				line: index + 1,
				message: "table rows start with '|'; this line would be dropped",
			});
			return;
		}
		firstNonBlank = false;
		if (trimmed.startsWith("|")) {
			violate({
				code: "content-after-table",
				line: index + 1,
				message: "a second table starts after the rule table; keep one table under the heading",
			});
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function analyze(text, directory, gitOk) {
	const lines = text.split(/\r?\n/);
	const violations = [];
	const rows = [];

	const violate = ({ code, line, row = null, rule = null, message }) => {
		violations.push({ code, row, line, rule, message });
	};

	// Headings inside a fenced block are examples, not the contract. A fence is
	// indented by at most three spaces; four make an indented code block, which
	// must not hide the real heading.
	const headingLines = [];
	let inFence = false;
	let fenceMarker = "";
	for (let index = 0; index < lines.length; index++) {
		const fence = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
		if (fence) {
			const marker = fence[1][0];
			if (!inFence) {
				inFence = true;
				fenceMarker = marker;
			} else if (marker === fenceMarker) {
				inFence = false;
				fenceMarker = "";
			}
			continue;
		}
		if (inFence) continue;
		if (HEADING_PATTERN.test(lines[index])) headingLines.push(index);
	}

	if (headingLines.length === 0) {
		violate({
			code: "missing-heading",
			line: 1,
			message: `no "${HEADING}" heading; the rule table lives under it`,
		});
		return { rows, violations };
	}
	if (headingLines.length > 1) {
		violate({
			code: "duplicate-heading",
			line: headingLines[1] + 1,
			message: `a second "${HEADING}" heading; the table must appear once`,
		});
	}

	const headingLine = headingLines[0];
	let index = headingLine + 1;
	while (index < lines.length && lines[index].trim() === "") index++;

	if (index >= lines.length || !lines[index].trim().startsWith("|")) {
		violate({
			code: "no-table",
			line: headingLine + 1,
			message: `"${HEADING}" is not followed by a markdown table`,
		});
		return { rows, violations };
	}

	const tableLines = [];
	while (index < lines.length) {
		const trimmed = lines[index].trim();
		if (trimmed === "" || !trimmed.startsWith("|")) break;
		tableLines.push({ index, cells: splitRow(lines[index]) });
		index++;
	}

	// The table block has ended. Anything table-like before the next heading is a
	// row GitHub will silently drop, so it is a violation rather than dead prose.
	scanAfterTable(lines, index, violate);

	const headerEntry = tableLines[0];
	const header = headerEntry.cells.map(normalizeColumn);

	// A table GitHub will not render is not a table: the header needs its
	// separator row directly beneath it, with one cell per header cell.
	if (tableLines.length < 2 || !isSeparatorRow(tableLines[1].cells)) {
		violate({
			code: "no-separator",
			line: (tableLines[1] ?? headerEntry).index + 1,
			message: "the header needs a |---| separator row directly beneath it",
		});
		return { rows, violations };
	}
	const separatorEntry = tableLines[1];
	if (separatorEntry.cells.length !== header.length) {
		violate({
			code: "separator-count",
			line: separatorEntry.index + 1,
			message: `the separator has ${separatorEntry.cells.length} cells but the header has ${header.length}; GitHub will not render the table`,
		});
		return { rows, violations };
	}

	for (const column of COLUMNS) {
		if (!header.includes(column)) {
			violate({
				code: "missing-column",
				line: headerEntry.index + 1,
				message: `missing required column "${COLUMN_LABELS[column]}" (required: ${COLUMNS.map((name) => COLUMN_LABELS[name]).join(", ")})`,
			});
		}
	}
	const seenColumns = new Set();
	for (const column of header) {
		if (!COLUMNS.includes(column)) continue;
		if (seenColumns.has(column)) {
			violate({
				code: "duplicate-column",
				line: headerEntry.index + 1,
				message: `column "${COLUMN_LABELS[column]}" appears twice`,
			});
		}
		seenColumns.add(column);
	}

	const hasAllColumns = COLUMNS.every((column) => header.includes(column));
	// Git refs are resolved only when the table's directory is in a work tree
	// with history; otherwise the snippet proof is checked for format alone.
	// This is what lets a project without commits adopt the table.
	const refsAreChecked = hasAllColumns && gitOk;

	const ruleRows = new Map();

	for (let offset = 2; offset < tableLines.length; offset++) {
		const entry = tableLines[offset];
		const line = entry.index + 1;
		const row = offset - 1;

		if (entry.cells.length !== header.length) {
			violate({
				code: "column-count",
				line,
				row,
				message: `row has ${entry.cells.length} cells but the header has ${header.length}`,
			});
			continue;
		}

		const record = {};
		for (let column = 0; column < header.length; column++) {
			if (header[column]) record[header[column]] = entry.cells[column];
		}

		const rule = record.rule ?? "";
		const levelCell = record.level ?? "";
		const enforcer = record["enforced by"] ?? "";
		const proof = record.proof ?? "";

		rows.push({ row, line, rule, level: levelCell, enforcedBy: enforcer, proof });

		if (stripDecorations(rule) === "") {
			violate({ code: "empty-rule", line, row, message: "the Rule cell is empty" });
		} else {
			const key = normalizeRule(rule);
			if (ruleRows.has(key)) {
				violate({
					code: "duplicate-rule",
					line,
					row,
					rule,
					message: `rule duplicates row ${ruleRows.get(key)}: "${stripDecorations(rule)}"`,
				});
			} else {
				ruleRows.set(key, row);
			}
		}

		const level = stripDecorations(levelCell).toLowerCase();
		if (!LEVELS.includes(level)) {
			violate({
				code: "unknown-level",
				line,
				row,
				rule,
				message: `level "${levelCell}" is not one of ${LEVELS.join(", ")}`,
			});
		}

		if (isEmptyEnforcer(enforcer)) {
			violate({
				code: "empty-enforcer",
				line,
				row,
				rule,
				message: `"Enforced by" is empty; every rule needs a command or "judgment: <reason>"`,
			});
		} else if (level === "prose" && !hasJudgmentReason(enforcer)) {
			violate({
				code: "prose-without-judgment",
				line,
				row,
				rule,
				message: `a prose row needs "judgment: <reason>" in "Enforced by", got "${enforcer}"`,
			});
		}

		if (!hasAllColumns) continue;
		validateProof({ proof, line, row, rule, directory, refsAreChecked, violate });
	}

	return { rows, violations };
}

function validateProof({ proof, line, row, rule, directory, refsAreChecked, violate }) {
	const value = proof.trim();
	const fail = (code, message) => violate({ code, line, row, rule, message });

	if (value === "") {
		fail("proof-empty", `the Proof cell is empty; record a path or bad=<ref> good=<ref>`);
		return;
	}

	const spans = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
	const mentionsPair = /(?:bad|good)=/.test(value);

	// Either a path or a pair. A cell with both validates neither, because
	// whichever one a reader believes, the other is dead text.
	if (spans.length > 0 && mentionsPair) {
		fail(
			"proof-mixed",
			"use one proof form: a backticked path or `bad=<ref> good=<ref>`, not both",
		);
		return;
	}

	if (mentionsPair) {
		// Strict: `bad=<ref> good=<ref>`, whitespace-separated, nothing else.
		// `bad=X,good=Y`, a reversed pair and trailing prose are all rejected
		// rather than silently parsed into something the author did not write.
		const pair = /^bad=(\S+)\s+good=(\S+)$/.exec(value);
		if (!pair) {
			fail(
				"proof-format",
				`a snippet proof must be exactly bad=<ref> good=<ref> separated by whitespace, got "${value}"`,
			);
			return;
		}
		for (const [label, token] of [
			["bad", pair[1]],
			["good", pair[2]],
		]) {
			const ref = cleanRef(token);
			if (!isRefFormat(ref)) {
				fail("proof-ref-invalid", `${label}=${ref} is not a valid git ref name`);
				continue;
			}
			if (refsAreChecked && !refResolves(directory, ref)) {
				fail(
					"proof-ref-missing",
					`${label}=${ref} does not resolve to a commit in ${directory}`,
				);
			}
		}
		return;
	}

	if (spans.length === 0) {
		fail(
			"proof-format",
			`expected a backticked file path or bad=<ref> good=<ref>, got "${value}"`,
		);
		return;
	}

	for (const span of spans) {
		const resolved = path.resolve(directory, span);
		let stats;
		try {
			stats = statSync(resolved);
		} catch (error) {
			if (error && error.code === "ENOENT") {
				fail("proof-missing", `proof path ${displayPath(resolved, directory)} does not exist`);
			} else {
				fail(
					"proof-missing",
					`proof path ${displayPath(resolved, directory)} cannot be read: ${error?.code ?? error}`,
				);
			}
			continue;
		}
		if (!stats.isFile()) {
			fail("proof-not-file", `proof path ${displayPath(resolved, directory)} is not a file`);
		}
	}
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usageError(message) {
	process.stderr.write(`rule-table.mjs: ${message}\n${USAGE}`);
	return 2;
}

function describeReadError(error) {
	if (error && error.code === "ENOENT") return "no such file or directory";
	if (error && error.code === "EISDIR") return "is a directory";
	if (error && error.code === "EACCES") return "permission denied";
	return error?.message ?? String(error);
}
function main(argv) {
	let json = false;
	const positional = [];

	for (const argument of argv) {
		if (argument === "--json") json = true;
		else if (argument === "--help" || argument === "-h") {
			process.stdout.write(HELP);
			return 0;
		} else if (argument.startsWith("-")) {
			return usageError(`unknown option: ${argument}`);
		} else {
			positional.push(argument);
		}
	}

	const [command, ...rest] = positional;
	if (command === undefined) return usageError("missing command");
	if (command !== "check") return usageError(`unknown command: ${command}`);
	if (rest.length === 0) return usageError("check needs the path to an AGENTS.md");
	if (rest.length > 1) return usageError(`check takes one path, got ${rest.length}: ${rest.join(" ")}`);

	const target = path.resolve(rest[0]);
	let stats;
	try {
		stats = statSync(target);
	} catch (error) {
		return usageError(`cannot read ${rest[0]}: ${describeReadError(error)}`);
	}
	if (!stats.isFile()) {
		return usageError(
			`cannot read ${rest[0]}: ${stats.isDirectory() ? "is a directory" : "not a regular file"}`,
		);
	}

	let text;
	try {
		text = readFileSync(target, "utf8");
	} catch (error) {
		return usageError(`cannot read ${rest[0]}: ${describeReadError(error)}`);
	}

	const directory = path.dirname(target);
	const gitOk = gitAvailable(directory);
	const { rows, violations } = analyze(text, directory, gitOk);
	violations.sort((left, right) => left.line - right.line || (left.row ?? 0) - (right.row ?? 0));

	const report = {
		checker: CHECKER,
		version: VERSION,
		path: target,
		ok: violations.length === 0,
		git: gitOk,
		rows,
		violations,
		summary: { rows: rows.length, violations: violations.length },
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} else if (report.ok) {
		process.stdout.write(`${rest[0]}: ${rows.length} rule row${rows.length === 1 ? "" : "s"} valid\n`);
	} else {
		for (const violation of violations) {
			const where = violation.row === null ? "" : `row ${violation.row}: `;
			process.stdout.write(
				`${rest[0]}:${violation.line}: ${where}${violation.code}: ${violation.message}\n`,
			);
		}
	}

	return report.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
