# `@jimkring/pi-github-pr-indicator`

Pi extension that shows the current GitHub pull request in the Pi footer.

![Screenshot of the GitHub PR indicator extension showing a PR in the Pi terminal footer](assets/github-pr-indicator-terminal.png)

The `PR #1 (Update terminal screenshot)` text in the lower-left footer is the indicator added by this extension. It updates to show the open GitHub PR for the current branch.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/jimkring/pi-github-pr-indicator
```

For local development from this repository:

```bash
pi -e .
```

## Requirements

- GitHub-backed Git repository checkout, such as a repository with a GitHub remote
- GitHub CLI: `gh`
- Authenticated GitHub CLI session via `gh auth login`
- Current branch must have an open GitHub PR for a footer indicator to appear

## Behavior

- Runs read-only `git` and `gh pr view` commands.
- Does not write files or modify the repository.
- Shows `PR #1234 (title)` in the Pi footer when a PR is found.
- Clears the footer indicator when no PR is found.
- Registers the `github_pr_indicator_update` tool so the agent can refresh the footer after creating a PR or switching branches.

## Development

```bash
npm install
npm run check
npm run pack:dry-run
```

## License

MIT
