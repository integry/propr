---
title: Pull request templates
---

ProPR writes a title and description for every pull request it opens. Add an optional `.propr/pr-template.md` to make them follow your team's conventions, such as required sections, ticket references or checklists. `propr init` scaffolds an example in which everything is commented out, and `propr repo validate` checks the file in a local checkout.

Like [`.propr/workflow.yml`](./repository-workflow.md), the template is read from the head commit of the pull request's base branch when the pull request is created. Template changes on a task branch have no effect until they are merged, and pull requests that are already open keep their description.

## Sections

The file is a list of sections. Each section starts with a level-2 heading that names it:

| Section | ProPR's default content |
| --- | --- |
| `title` | `[<issue> by <Model>] <issue title>` |
| `summary` | Heading, `Closes #N` (or `Addresses #N`), branch, and the agent's summary of the change |
| `run` | Status, repository, execution time, tokens, API cost, repository validation results and log locations |
| `commits` | The published commit |
| `files_changed` | Nothing |
| `prompt` | Nothing |
| `review_guidelines` | The **Need changes?** invitation to comment on the pull request |
| `commands` | Nothing on issue PRs |
| `trailer` | The "created automatically by ProPR" line |

When the file has no sections, or does not exist, ProPR writes its usual description.

- A **present** section replaces the default content.
- A section that is **present but empty or whitespace-only** removes that section from the output.
- An **absent** section keeps ProPR's default content.

Sections are written in the order of the table, separated by blank lines, whatever their order in the file. Visual previews are still appended at the end. Text before the first heading and HTML comments (`<!-- ... -->`) are ignored, so you can use comments for notes. Level-2 headings inside fenced code blocks do not start a section. Inside a section, use `###` or deeper headings: every `##` heading starts a new section. A heading with an unknown name (for example `## checklist`) is reported by validation, and its content is ignored. If a section appears twice, the last one is used. The file must be UTF-8 and at most 64 KiB.

## Placeholders

Section bodies, including `title`, are Markdown with `{{placeholder}}` substitutions. Spaces inside the braces are allowed (`{{ issue_number }}`).

| Placeholder | Value |
| --- | --- |
| `{{issue_number}}` | Number of the issue the pull request resolves |
| `{{issue_title}}` | Title of that issue |
| `{{model}}` | Display name of the model, for example `Claude Opus` |
| `{{agent}}` | Agent type: `claude`, `codex`, `antigravity`, `opencode` or `vibe` |
| `{{cost}}` | API cost of the run, for example `$0.42` |
| `{{tokens}}` | Total tokens used, for example `12,345` |
| `{{execution_time}}` | Execution time, for example `4m 12s` |
| `{{branch}}` | Head branch of the pull request |
| `{{commits}}` | Markdown list of commits published by the run |
| `{{files_changed}}` | Markdown list of changed files (at most 50, then `…and N more`) |
| `{{summary}}` | The agent's summary of the change |
| `{{session_id}}` | Agent session identifier |
| `{{repository}}` | `owner/repository` |

Substitution is the only logic. Conditionals, loops and helpers (`{{#if}}`, `{{#each}}`, `{{> partial}}`) are not supported; validation reports them as unknown placeholders. Substituted values are never scanned again for placeholders.

Values that come from people or agents are treated as untrusted. `{{summary}}` is sanitized the same way as in ProPR's default description, and secrets are redacted from all values. In descriptions, HTML tags in `{{issue_title}}`, `{{summary}}` and `{{commits}}` are escaped (outside code spans and code blocks), so they display as text instead of being rendered. In the title, line breaks are collapsed into spaces. Titles are limited to 256 characters, and a title that renders empty keeps the default title.

## Examples

### Minimal

A conventional title and a short description, keeping the run statistics and the rest of ProPR's defaults:

```markdown
## title
fix: {{issue_title}} (#{{issue_number}})

## summary
Closes #{{issue_number}}

{{summary}}
```

### Remove run statistics

Empty sections remove the execution statistics and the trailer:

```markdown
## run

## trailer
```

### Company checklist

```markdown
## title
[PROJ-{{issue_number}}] {{issue_title}}

## summary
### What
{{summary}}

### Ticket
Closes #{{issue_number}}

## files_changed
### Files
{{files_changed}}

## run
<details>
<summary>Run details</summary>

{{agent}} / {{model}} · {{execution_time}} · {{tokens}} tokens · {{cost}}
</details>

## review_guidelines
### Checklist
- [ ] Tests cover the change
- [ ] Documentation is updated
- [ ] No secrets or credentials in the diff
```

## GitHub template fallback

When a repository has no `.propr/pr-template.md` but has a GitHub pull request template, ProPR writes its default summary and run block, followed by the repository template, so your team's checklist still appears. ProPR looks for the template where GitHub does:

1. `pull_request_template.md` in `.github/`, the repository root, or `docs/` (in that order, any capitalization, such as `PULL_REQUEST_TEMPLATE.md`).
2. A `PULL_REQUEST_TEMPLATE/` directory in the same locations: its `default.md`, or its only Markdown file. If there are several templates and none is named `default.md`, none is used.

The fallback is a per-repository option and is enabled by default. Turn it off with `propr repo toggle owner/repo --no-github-pr-template`, or with the `githubPrTemplateFallback` field of the repository configuration API and of the `update_repository_configuration` MCP tool. A `.propr/pr-template.md` always takes precedence, whether the option is on or off.

## Validation

`propr repo validate` (or `propr repo validate --cwd path/to/checkout`) checks `.propr/pr-template.md` and reports:

- unknown section names,
- sections that appear more than once,
- unknown placeholders, including Handlebars logic,
- files over 64 KiB.

It also lists the sections the file customizes and the ones it removes. It exits with status 1 when it finds a problem, so you can run it in CI. Use `--json` for machine-readable output.

A template can never fail a run. When ProPR cannot read or render the template (for example because of an unknown placeholder, a file that is too large, or a GitHub API error), it logs the error, adds a **Pull request template could not be applied** entry to the task timeline, and uses its default title and description. Unknown sections are ignored, and the rest of the template still applies.

## Where templates apply

- **Issue pull requests**: the title and the description, when ProPR creates the pull request.
- **Continuation pull requests**: when ProPR cannot push to a contributor's branch, publication or [publication recovery](./pr-followup.md) opens a continuation pull request. Its default "Continuation of …" text is the `summary` section, and other sections are added as configured. The `Continue #N:` title is kept, as is the hidden continuation marker that ProPR uses to find the pull request. If the result would exceed GitHub's description limit, the default description is used.

Follow-up work on an existing pull request does not rewrite its description, and follow-up completion comments are not affected by templates. Goal pull requests keep their own description.
