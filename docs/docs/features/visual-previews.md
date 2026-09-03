---
title: Visual Previews
---

# Visual Previews

Visual previews let a ProPR implementation show its user-visible result directly in the generated pull request. The same policy applies to later follow-up commits, whose completion comments can include fresh media focused on that follow-up.

The feature is opt-in per repository. Existing repository configurations remain disabled after an upgrade.

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

Generated files live under `.propr/previews/`. Optional titles, descriptions, and tool recommendations are recorded in `.propr/previews/manifest.json`. Only preview files changed by the current implementation commit are published, which prevents an old capture from being presented as evidence for a later change.

Supported image formats are PNG, JPEG, GIF, SVG, and WebP. Supported video formats are MP4, MOV, and WebM; H.264 MP4 is the most broadly compatible choice. Each attachment must be smaller than 10 MB.

## Publication And Fallbacks

ProPR first adds commit-pinned repository links, then attempts to replace them with [GitHub attachments](https://cli.github.com/manual/gh_pr_edit) so images render inline and videos use GitHub's media presentation. When attachment upload is unavailable, images remain embedded from the implementation commit and videos remain explicit links to the committed recording. This keeps the evidence reachable without relying on mutable branch URLs.

Preview generation is evidence, not a replacement for automated tests. A preview failure does not discard an otherwise valid implementation; the PR explains missing tool support when the agent can identify it.
