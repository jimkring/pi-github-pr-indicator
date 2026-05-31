/**
 * Shows "PR #1234 (title)" in the Pi footer when the current branch has
 * an open GitHub PR. Uses the GitHub CLI to resolve the PR for the current
 * branch and refreshes after session start, agent turns, and HEAD changes.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface PrInfo {
	number: string;
	title: string;
}

export default function (pi: ExtensionAPI) {
	let gitHeadWatcher: ReturnType<typeof watch> | null = null;
	let lastHead: string | null = null;
	let extensionContext: ExtensionContext | null = null;

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
			updateStatus(ctx);
			return {
				content: [{ type: "text", text: "GitHub PR indicator refreshed." }],
				details: {},
			};
		},
	});

	function run(command: string, args: string[], cwd: string): string | null {
		try {
			return execFileSync(command, args, {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return null;
		}
	}

	function findGitRoot(cwd: string): string | null {
		return run("git", ["rev-parse", "--show-toplevel"], cwd);
	}

	function getGitHeadPath(gitRoot: string): string | null {
		const headPath = run("git", ["rev-parse", "--git-path", "HEAD"], gitRoot);
		if (!headPath) return null;
		return isAbsolute(headPath) ? headPath : join(gitRoot, headPath);
	}

	function getPrInfo(gitRoot: string): PrInfo | null {
		const raw = run("gh", ["pr", "view", "--json", "number,title"], gitRoot);
		if (!raw) return null;

		try {
			const parsed = JSON.parse(raw) as { number?: unknown; title?: unknown };
			if (!parsed.number) return null;
			return {
				number: String(parsed.number),
				title: typeof parsed.title === "string" ? parsed.title : "",
			};
		} catch {
			return null;
		}
	}

	function readGitHead(gitRoot: string): string | null {
		const headPath = getGitHeadPath(gitRoot);
		if (headPath && existsSync(headPath)) {
			try {
				return readFileSync(headPath, "utf-8").trim();
			} catch {
				return null;
			}
		}

		return run("git", ["rev-parse", "HEAD"], gitRoot);
	}

	function updateStatus(ctx: ExtensionContext) {
		const gitRoot = findGitRoot(ctx.cwd);
		if (!gitRoot) {
			ctx.ui.setStatus("github-pr-indicator", undefined);
			return;
		}

		const prInfo = getPrInfo(gitRoot);
		if (prInfo) {
			const prefix = ctx.ui.theme.fg("dim", "PR");
			const number = ctx.ui.theme.fg("accent", `#${prInfo.number}`);
			const title = prInfo.title ? ` ${ctx.ui.theme.fg("dim", `(${prInfo.title})`)}` : "";
			ctx.ui.setStatus("github-pr-indicator", `${prefix} ${number}${title}`);
		} else {
			ctx.ui.setStatus("github-pr-indicator", undefined);
		}
	}

	function startGitHeadWatcher(ctx: ExtensionContext) {
		const gitRoot = findGitRoot(ctx.cwd);
		if (!gitRoot) return;

		const headPath = getGitHeadPath(gitRoot);
		if (!headPath) return;

		lastHead = readGitHead(gitRoot);
		try {
			gitHeadWatcher = watch(headPath, () => {
				const currentHead = readGitHead(gitRoot);
				if (currentHead && currentHead !== lastHead) {
					lastHead = currentHead;
					if (extensionContext) updateStatus(extensionContext);
				}
			});
		} catch {
			gitHeadWatcher = null;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		extensionContext = ctx;
		updateStatus(ctx);
		startGitHeadWatcher(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		extensionContext = null;
		if (gitHeadWatcher) {
			gitHeadWatcher.close();
			gitHeadWatcher = null;
		}
	});
}
