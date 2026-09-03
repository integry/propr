---
title: Visual Previews
---

# Visual Previews

Visual previews let a ProPR implementation show its user-visible result directly in the generated pull request. The same policy applies to later follow-up commits, whose completion comments can include fresh media focused on that follow-up.

The feature is opt-in per repository. Existing repository configurations remain disabled after an upgrade.

GitHub attachment uploads require a GitHub OAuth App token (`gho_`) or personal
access token. GitHub's uploader rejects both GitHub App user (`ghu_`) and
installation (`ghs_`) tokens even though those tokens work for normal GitHub API
operations. When an instance administrator's Web UI login is backed by a GitHub
OAuth App, ProPR automatically stores its compatible credential, encrypted in
the shared database. Open **Settings → Visual preview uploads** to see which
account is connected or explicitly replace it with the current administrator
login. Normal GitHub API, commit, and pull-request operations continue to use
the GitHub App installation token.

When normal Web UI login uses a GitHub App, an administrator can instead paste
a personal access token in **Settings → Visual preview uploads**. ProPR validates
the token with GitHub and encrypts it before storing it. No CLI, callback URL, or
service restart is required. For a fine-grained token, choose the organization or
user that owns the repositories as the resource owner, include every
preview-enabled repository, and grant the repository permission **Pull requests:
Read and write**. GitHub adds read-only metadata access automatically; no other
repository permission is required. The token owner must have push access to the
repositories and must complete any organization approval or SAML SSO authorization.
Fine-grained tokens can target only one resource owner. If the repositories span
multiple owners, use a classic PAT with `repo`, or `public_repo` if every repository
is public. Settings links to GitHub's token form with the fine-grained permission
preselected.

Expiring OAuth credentials are refreshed on API startup and every 30 minutes
while the stack is running. Each successful refresh rotates the access and
refresh tokens, so an administrator does not need to sign in every six months
while the stack can keep refreshing them. A revoked grant, an expired unused
refresh token, or a changed encryption secret requires a fresh administrator
login. Personal access tokens are not refreshable OAuth grants; replace a
revoked or expired PAT in **Settings → Visual preview uploads**. As an advanced
server-managed alternative, configure `GITHUB_VISUAL_PREVIEW_TOKEN` with an
OAuth App token, classic PAT, or fine-grained PAT belonging to a user with write
access to every preview-enabled repository.

`propr setup` also reuses an upload-compatible token from an existing `gh` CLI
session when no working preview credential is already configured. GitHub CLI
does not expose a refresh token to ProPR, so an expired or revoked imported token
must be replaced in Settings or re-imported by running setup again.

## Configure A Repository

On **Repositories**, turn on **Visual previews** beneath the repository entry. Choose **Images**, **Videos**, or both, then optionally add capture instructions such as:

```text
Capture separate desktop and mobile views. Open the new settings dialog and focus the changed controls.
```

The setting is repository-wide. If the same repository has entries for multiple base branches, ProPR keeps their preview policy synchronized.

The CLI exposes the same policy:

```bash
propr repo add owner/repo --visual-previews --preview-types image,video \
  --preview-instructions "Capture desktop and mobile views."
propr repo toggle owner/repo --visual-previews --preview-types image
propr repo toggle owner/repo --no-visual-previews
```

## What The Agent Captures

When enabled, the implementation agent evaluates the completed change:

- If the result is perceptible visually, it captures the changed state with relevant project tooling such as Playwright, Storybook, a browser, an emulator, or a project-native renderer.
- If the change has no visible result, it does not create placeholder media.
- Captures focus on the change rather than generic application screens and must not contain credentials, personal data, or unrelated content.
- If capture is blocked, the agent can recommend the concrete browser, emulator, or media tool that should be added to the agent image.

Agents generate files under the transient `.propr/previews/` runtime directory. Optional titles, descriptions, and tool recommendations are recorded in `.propr/previews/manifest.json`. Before committing, ProPR copies accepted files to worker-owned temporary storage and removes the runtime directory from the worktree. Preview files are therefore never included in the implementation commit.

Supported image formats are PNG, JPEG, GIF, SVG, and WebP. Supported video formats are MP4, MOV, and WebM; H.264 MP4 is the most broadly compatible choice. Each attachment must be smaller than 10 MB.

## Publication And Upload Failures

ProPR publishes previews as [GitHub attachments](https://cli.github.com/manual/gh_pr_edit) so images render inline and videos use GitHub's media presentation. For follow-ups, it uploads the media first and then updates the existing progress comment; it does not create a temporary second comment. ProPR verifies that every temporary local path was replaced with a hosted attachment URL, then deletes the temporary files. If upload or verification fails, ProPR publishes a text-only explanation; preview media is not added to Git as a fallback. When the failure is a missing, unsupported, expired, or rejected user credential, that explanation includes the exact Settings reconnection steps in the affected pull request.

Preview generation is evidence, not a replacement for automated tests. A preview failure does not discard an otherwise valid implementation; the PR explains missing tool support when the agent can identify it.
