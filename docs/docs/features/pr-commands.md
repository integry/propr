---
sidebar_position: 13
---

# PR Slash Commands

Most PR refinement does not need a slash command. If you want ProPR to make a normal change, write a regular GitHub PR comment with the instruction and any screenshots or context. When the PR carries a processing label or the comment includes a trigger keyword, ProPR processes that comment directly — see [PR Automation And Fine-Tuning](./pr-followup.md).

Slash commands are for specific actions: AI review, applying AI review feedback, model routing, branch updates, and automated correction loops.

## Works On Any Pull Request

These commands are not limited to PRs that ProPR created. You can run `/review`, `/fix`, and the others on any eligible pull request — including ones opened by a teammate, another agent, or yourself outside ProPR — as long as you are an allowed author. A slash command from an allowed author is processed directly and does not require the PR to carry a processing label.

To **take over an existing PR** for ongoing work (so that natural follow-up comments are picked up alongside commands), add a configured processing label such as `AI` or `propr` to the PR. See [Use ProPR On Any Pull Request](./pr-followup.md#use-propr-on-any-pull-request).

## Quick Reference

| Command | Use it when | Changes code? | Details |
|---|---|---|---|
| `/review` | You want AI review comments on the PR | No | [Review And Fix Commands](./pr-review-fix-commands.md) |
| `/fix` | You want to apply unprocessed AI review comments from `/review` | Yes | [Review And Fix Commands](./pr-review-fix-commands.md) |
| `/merge` | You want to merge the base branch into the PR branch | Maybe, if conflicts need resolution | [Ultrafix And Branch Commands](./pr-ultrafix-commands.md) |
| `/switch <model-id>` | You want future PR work to use a different model | No, unless you include follow-up instructions | [Model Routing Commands](./pr-model-routing-commands.md) |
| `/use <model-id>` | You want one immediate follow-up run with a temporary model | Yes | [Model Routing Commands](./pr-model-routing-commands.md) |
| `/ultrafix` | You want an automated review-fix loop | Yes | [Ultrafix And Branch Commands](./pr-ultrafix-commands.md) |

## Syntax Rules

- The slash command must be on the first line of the PR comment. A comment with leading blank lines or text before the command is treated as a normal follow-up comment.
- Arguments go on the same line as the command (for example `/review llm-claude-opus48` or `/ultrafix goal=8 max=10`).
- Lines below the command become extra instructions for the run.
- Both top-level PR comments and line-level review comments are processed; line-level comments carry their file, line, and diff context to the agent.

## Model IDs

Commands that take a model accept the model IDs configured in AI Agents. The `llm-` prefix is optional in command arguments — `/switch claude-opus48` and `/switch llm-claude-opus48` are equivalent. Unrecognized models are rejected. The built-in catalog is listed in [Agents and Models](./agents-and-models.md).

## Who Can Trigger Commands

ProPR filters PR comments by author before processing anything (commands and natural follow-ups alike):

- Bot accounts (usernames containing `[bot]` or with user type `Bot`) and ProPR's own bot account are ignored.
- If `GITHUB_USER_WHITELIST` is set (comma-separated usernames), only those users can trigger processing.
- Users listed in `GITHUB_USER_BLACKLIST` are ignored.
- Comments containing a configured follow-up ignore keyword are skipped.

Slash commands from an allowed author are processed directly. Natural follow-up comments are additionally gated: the PR must carry one of the configured processing labels (for example `AI` or `propr`), or the comment must contain a trigger keyword from `PR_FOLLOWUP_TRIGGER_KEYWORDS` (for example `!propr`).

## Completion Comments

When a command or follow-up task finishes, ProPR posts a completion comment on the PR with a summary of what was done, the commit hash when changes were committed, and an expandable "ProPR Slash Commands" reference block listing the available commands.

{/* SCREENSHOT PLACEHOLDER: Capture a PR conversation showing a `/review` comment, the resulting AI review with severity findings and a `Score: N/10` line, and a ProPR completion comment with the expanded slash commands block. */}
