/**
 * Shows "PR #1234 (title)" in the Pi footer when the current branch has
 * an open GitHub PR. Uses the GitHub CLI to resolve the PR for the current
 * branch and refreshes after session start, agent turns, and HEAD changes.
 */

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface PrInfo {
	number: string;
	title: string;
}

type SetupProblem = "missing-gh" | "unauthenticated-gh";

type PrLookupResult =
	| { kind: "found"; pr: PrInfo }
	| { kind: "none" }
	| { kind: "setup-problem"; problem: SetupProblem }
	| { kind: "error" };

type RefreshOutcome = "applied" | "stale" | "skipped";

const STATUS_KEY = "github-pr-indicator";
const GIT_TIMEOUT_MS = 3_000;
const GH_TIMEOUT_MS = 5_000;
const WATCH_DEBOUNCE_MS = 250;
const MAX_TITLE_CHARS = 72;

const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/g;

function cleanSingleLine(text: string): string {
	return text
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(CONTROL_CHARACTER_PATTERN, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateText(text: string, maxChars: number): string {
	const chars = Array.from(text);
	if (chars.length <= maxChars) return text;
	if (maxChars <= 1) return "…";
	return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function formatTitle(title: string): string {
	return truncateText(cleanSingleLine(title), MAX_TITLE_CHARS);
}

function classifyGhFailure(result: ExecResult): SetupProblem | "none" | "other" {
	if (result.killed) return "other";

	const output = `${result.stderr}\n${result.stdout}`.trim().toLowerCase();
	if (!output) return "missing-gh";

	if (/enoent|command not found|not recognized|executable file not found|spawn .* enoent/.test(output)) {
		return "missing-gh";
	}

	if (/gh auth login|not logged in|not authenticated|authentication required|requires authentication|http 401|bad credentials/.test(output)) {
		return "unauthenticated-gh";
	}

	if (/no pull requests? found|could not find any pull requests?|there is no pull request|no open pull requests?/.test(output)) {
		return "none";
	}

	if (/none of the git remotes.*github|not a github repository|could not determine.*repo|run: gh repo set-default|no git remotes/.test(output)) {
		return "none";
	}

	return "other";
}

function parsePrInfo(raw: string): PrInfo | null {
	try {
		const parsed = JSON.parse(raw) as { number?: unknown; title?: unknown };
		if (parsed.number === undefined || parsed.number === null || parsed.number === "") {
			return null;
		}
		return {
			number: String(parsed.number),
			title: typeof parsed.title === "string" ? parsed.title : "",
		};
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let gitHeadWatcher: ReturnType<typeof watch> | null = null;
	let lastHead: string | null = null;
	let extensionContext: ExtensionContext | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshInFlight = false;
	let refreshPending = false;
	let refreshGeneration = 0;
	let disposed = false;
	const refreshWaiters: Array<() => void> = [];
	const notifiedSetupProblems = new Set<SetupProblem>();

	pi.registerTool({
		name: "github_pr_indicator_update",
		label: "GitHub PR Indicator Update",
		description: "Refresh the GitHub PR indicator in the Pi footer.",
		promptSnippet: "Refresh the GitHub PR indicator shown in the footer after creating a PR or switching branches",
		promptGuidelines: [
			"Call github_pr_indicator_update after creating a PR or switching branches so the footer shows the new PR number immediately.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "GitHub PR indicator refresh skipped because UI is unavailable." }],
					details: {},
				};
			}

			await requestRefresh(ctx);
			return {
				content: [{ type: "text", text: "GitHub PR indicator refreshed." }],
				details: {},
			};
		},
	});

	async function run(command: string, args: string[], cwd: string, timeout: number): Promise<ExecResult> {
		return pi.exec(command, args, { cwd, timeout });
	}

	async function runText(command: string, args: string[], cwd: string, timeout: number): Promise<string | null> {
		const result = await run(command, args, cwd, timeout);
		if (result.code !== 0 || result.killed) return null;
		const stdout = result.stdout.trim();
		return stdout || null;
	}

	function clearStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function notifySetupProblem(ctx: ExtensionContext, problem: SetupProblem): void {
		if (!ctx.hasUI || notifiedSetupProblems.has(problem)) return;
		notifiedSetupProblems.add(problem);

		if (problem === "missing-gh") {
			ctx.ui.notify("GitHub PR Indicator: GitHub CLI (`gh`) was not found. Install `gh` and run `gh auth login`.", "warning");
			return;
		}

		ctx.ui.notify("GitHub PR Indicator: GitHub CLI is not authenticated. Run `gh auth login`.", "warning");
	}

	function setPrStatus(ctx: ExtensionContext, prInfo: PrInfo): void {
		if (!ctx.hasUI) return;

		const prefix = ctx.ui.theme.fg("dim", "PR");
		const number = ctx.ui.theme.fg("accent", `#${prInfo.number}`);
		const title = formatTitle(prInfo.title);
		const titlePart = title ? ` ${ctx.ui.theme.fg("dim", `(${title})`)}` : "";
		ctx.ui.setStatus(STATUS_KEY, `${prefix} ${number}${titlePart}`);
	}

	async function findGitRoot(cwd: string): Promise<string | null> {
		return runText("git", ["rev-parse", "--show-toplevel"], cwd, GIT_TIMEOUT_MS);
	}

	async function getGitHeadPath(gitRoot: string): Promise<string | null> {
		const headPath = await runText("git", ["rev-parse", "--git-path", "HEAD"], gitRoot, GIT_TIMEOUT_MS);
		if (!headPath) return null;
		return isAbsolute(headPath) ? headPath : join(gitRoot, headPath);
	}

	async function readGitHeadFromPath(headPath: string): Promise<string | null> {
		try {
			return (await readFile(headPath, "utf-8")).trim() || null;
		} catch {
			return null;
		}
	}

	async function getPrInfo(gitRoot: string): Promise<PrLookupResult> {
		const result = await run("gh", ["pr", "view", "--json", "number,title"], gitRoot, GH_TIMEOUT_MS);
		if (result.code !== 0 || result.killed) {
			const failure = classifyGhFailure(result);
			if (failure === "missing-gh" || failure === "unauthenticated-gh") {
				return { kind: "setup-problem", problem: failure };
			}
			if (failure === "none") return { kind: "none" };
			return { kind: "error" };
		}

		const prInfo = parsePrInfo(result.stdout);
		return prInfo ? { kind: "found", pr: prInfo } : { kind: "none" };
	}

	function applyPrLookupResult(ctx: ExtensionContext, result: PrLookupResult): void {
		if (result.kind === "found") {
			setPrStatus(ctx, result.pr);
			return;
		}

		clearStatus(ctx);
		if (result.kind === "setup-problem") {
			notifySetupProblem(ctx, result.problem);
		}
	}

	function resolveRefreshWaiters(): void {
		const waiters = refreshWaiters.splice(0);
		for (const resolve of waiters) resolve();
	}

	function requestRefresh(ctx: ExtensionContext, options: { debounceMs?: number } = {}): Promise<void> {
		extensionContext = ctx;
		if (disposed || !ctx.hasUI) return Promise.resolve();

		refreshGeneration += 1;
		const promise = new Promise<void>((resolve) => refreshWaiters.push(resolve));
		const debounceMs = options.debounceMs ?? 0;

		if (debounceMs > 0) {
			if (refreshTimer) clearTimeout(refreshTimer);
			refreshTimer = setTimeout(() => {
				refreshTimer = null;
				triggerRefresh();
			}, debounceMs);
		} else {
			if (refreshTimer) {
				clearTimeout(refreshTimer);
				refreshTimer = null;
			}
			triggerRefresh();
		}

		return promise;
	}

	function triggerRefresh(): void {
		if (disposed) {
			resolveRefreshWaiters();
			return;
		}

		if (refreshInFlight) {
			refreshPending = true;
			return;
		}

		void drainRefreshes();
	}

	async function drainRefreshes(): Promise<void> {
		if (refreshInFlight) return;
		refreshInFlight = true;

		try {
			do {
				refreshPending = false;
				const ctx = extensionContext;
				const requestId = refreshGeneration;
				if (!ctx || !ctx.hasUI || disposed) break;

				const outcome = await performRefresh(ctx, requestId);
				if (outcome === "stale" && extensionContext?.hasUI && !disposed) {
					refreshPending = true;
				}
			} while (refreshPending && !disposed);
		} finally {
			refreshInFlight = false;
			resolveRefreshWaiters();
		}
	}

	function isStaleRefresh(requestId: number): boolean {
		return disposed || requestId !== refreshGeneration;
	}

	async function performRefresh(ctx: ExtensionContext, requestId: number): Promise<RefreshOutcome> {
		if (!ctx.hasUI || disposed) return "skipped";

		const gitRoot = await findGitRoot(ctx.cwd);
		if (isStaleRefresh(requestId)) return "stale";
		if (!gitRoot) {
			clearStatus(ctx);
			return "applied";
		}

		const headPath = await getGitHeadPath(gitRoot);
		if (isStaleRefresh(requestId)) return "stale";
		const headBefore = headPath ? await readGitHeadFromPath(headPath) : null;

		const prResult = await getPrInfo(gitRoot);
		const headAfter = headPath ? await readGitHeadFromPath(headPath) : null;
		if (isStaleRefresh(requestId) || headBefore !== headAfter) return "stale";

		applyPrLookupResult(ctx, prResult);
		return "applied";
	}

	function stopGitHeadWatcher(): void {
		if (gitHeadWatcher) {
			gitHeadWatcher.close();
			gitHeadWatcher = null;
		}
		lastHead = null;
	}

	async function handleGitHeadChanged(headPath: string): Promise<void> {
		const currentHead = await readGitHeadFromPath(headPath);
		if (!currentHead || currentHead === lastHead) return;

		lastHead = currentHead;
		const ctx = extensionContext;
		if (ctx) void requestRefresh(ctx, { debounceMs: WATCH_DEBOUNCE_MS });
	}

	async function startGitHeadWatcher(ctx: ExtensionContext): Promise<void> {
		stopGitHeadWatcher();
		if (!ctx.hasUI || disposed) return;

		const gitRoot = await findGitRoot(ctx.cwd);
		if (!gitRoot || disposed) return;

		const headPath = await getGitHeadPath(gitRoot);
		if (!headPath || disposed) return;

		lastHead = await readGitHeadFromPath(headPath);
		try {
			const watcher = watch(headPath, { persistent: false }, () => {
				if (gitHeadWatcher !== watcher) return;
				void handleGitHeadChanged(headPath);
			});
			watcher.on("error", () => {
				if (gitHeadWatcher === watcher) {
					watcher.close();
					gitHeadWatcher = null;
				}
			});
			gitHeadWatcher = watcher;
		} catch {
			gitHeadWatcher = null;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		extensionContext = ctx;
		if (!ctx.hasUI) return;

		void requestRefresh(ctx);
		void startGitHeadWatcher(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		void requestRefresh(ctx);
	});

	pi.on("session_shutdown", async () => {
		disposed = true;
		extensionContext = null;
		refreshGeneration += 1;
		refreshPending = false;
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		resolveRefreshWaiters();
		stopGitHeadWatcher();
	});
}
