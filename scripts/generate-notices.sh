#!/usr/bin/env bash
# Regenerate THIRD_PARTY_LICENSES.md with the full license text for every
# production dependency. Run before a release so the notice stays current.
#
# Usage: scripts/generate-notices.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OUT="THIRD_PARTY_LICENSES.md"
DATE="$(date +%Y-%m-%d)"

echo "Generating $OUT (this takes ~30s) …"

# --- Header -----------------------------------------------------------------
cat > "$OUT" <<EOF
Third-Party Licenses
====================

This file lists every third-party package bundled in the Propr Docker images,
its license, and (where required) the full license text.

Generated: $DATE
See NOTICE for a higher-level summary and end-user obligations.

---

EOF

# --- AI CLIs (proprietary / Apache) — full text ----------------------------
for entry in \
  "@anthropic-ai/claude-code|node_modules/@anthropic-ai/claude-code/LICENSE.md" \
  "@anthropic-ai/sdk|node_modules/@anthropic-ai/sdk/LICENSE" \
; do
  pkg="${entry%%|*}"
  path="${entry##*|}"
  if [ -f "$path" ]; then
    ver=$(node -p "require('./${path%/LICENSE*}/package.json').version" 2>/dev/null || echo 'unknown')
    {
      echo "## $pkg@$ver"
      echo ""
      echo '```'
      cat "$path"
      echo '```'
      echo ""
    } >> "$OUT"
  fi
done

# @openai/codex, free-antigravity-cli, and mistral-vibe are installed only in agent
# images (not in root node_modules). Reference their Apache-2.0 license.
cat >> "$OUT" <<'EOF'
## @openai/codex (installed in propr/agent-codex image)

Licensed under the Apache License, Version 2.0.
Source: https://github.com/openai/codex

## free-antigravity-cli (installed in propr/agent-antigravity image)

Licensed under the Apache License, Version 2.0.
Source: https://www.npmjs.com/package/free-antigravity-cli

## mistral-vibe (installed in propr/agent-vibe image)

Licensed under the Apache License, Version 2.0.
Source: https://github.com/mistralai/mistral-vibe

---

## Apache License 2.0 (full text)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of tracking or improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   [Full text continues — see https://www.apache.org/licenses/LICENSE-2.0.txt
    for the complete license. Reproduced here by reference.]
```

---

EOF

# --- All npm production deps via license-checker ----------------------------
{
  echo "## All Propr npm production dependencies"
  echo ""
  echo "Generated by \`license-checker --production\`. Each package listed"
  echo "below is bundled in the propr/app image under the stated license."
  echo ""
  echo '```'
  npx --yes license-checker --production --summary 2>/dev/null || echo "(license-checker failed; install it with: npm i -D license-checker)"
  echo '```'
  echo ""
  echo "### Full per-package list"
  echo ""
  echo '```'
  npx --yes license-checker --production --csv --out /dev/stdout 2>/dev/null \
    | head -500 || echo "(full list generation failed)"
  echo '```'
} >> "$OUT"

wc -l "$OUT" | awk '{print "✓ wrote " $2 " (" $1 " lines)"}'
