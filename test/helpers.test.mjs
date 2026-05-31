import assert from "node:assert/strict";
import { test } from "node:test";
import { __testing } from "../index.ts";

const { cleanSingleLine, truncateText, formatTitle, classifyGhFailure, parsePrInfo } = __testing;

function execResult({ stdout = "", stderr = "", killed = false } = {}) {
	return { code: killed ? null : 1, stdout, stderr, killed };
}

test("cleanSingleLine strips ANSI/control characters and normalizes whitespace", () => {
	assert.equal(cleanSingleLine("\u001b[31mPR\u001b[0m\n#1\t  title"), "PR #1 title");
});

test("truncateText preserves short text and adds an ellipsis when needed", () => {
	assert.equal(truncateText("short", 10), "short");
	assert.equal(truncateText("abcdef", 5), "abcd…");
	assert.equal(truncateText("abcdef", 1), "…");
});

test("formatTitle cleans and limits PR titles", () => {
	assert.equal(formatTitle("Fix\n\tfooter"), "Fix footer");
	assert.equal(formatTitle("a".repeat(80)), `${"a".repeat(71)}…`);
});

test("parsePrInfo accepts GitHub CLI JSON output", () => {
	assert.deepEqual(parsePrInfo('{"number":1,"title":"Update terminal screenshot"}'), {
		number: "1",
		title: "Update terminal screenshot",
	});
	assert.deepEqual(parsePrInfo('{"number":"42"}'), { number: "42", title: "" });
});

test("parsePrInfo rejects invalid or incomplete JSON", () => {
	assert.equal(parsePrInfo("not json"), null);
	assert.equal(parsePrInfo('{"title":"Missing number"}'), null);
	assert.equal(parsePrInfo('{"number":""}'), null);
});

test("classifyGhFailure identifies setup and no-PR cases", () => {
	assert.equal(classifyGhFailure(execResult({ stderr: "gh: command not found" })), "missing-gh");
	assert.equal(classifyGhFailure(execResult({ stderr: "not logged in. Run gh auth login" })), "unauthenticated-gh");
	assert.equal(classifyGhFailure(execResult({ stderr: "no pull requests found for branch" })), "none");
	assert.equal(classifyGhFailure(execResult({ killed: true })), "other");
});
