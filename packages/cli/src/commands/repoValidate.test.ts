import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateRepositoryFiles } from "./repoValidate.js";

function checkout(template?: string): string {
  const root = mkdtempSync(join(tmpdir(), "propr-repo-validate-"));
  if (template !== undefined) {
    mkdirSync(join(root, ".propr"));
    writeFileSync(join(root, ".propr", "pr-template.md"), template);
  }
  return root;
}

test("repo validate accepts a checkout without a pull request template", async () => {
  const root = checkout();
  try {
    assert.deepEqual(await validateRepositoryFiles({ cwd: root }), {
      file: join(root, ".propr", "pr-template.md"), found: false, valid: true, sections: [], problems: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo validate lists customized sections and reports unknown sections and placeholders", async () => {
  const root = checkout("## title\n{{issue_title}}\n## run\n\n## checklist\n- [ ] done\n## summary\n{{summary}} {{ticket}}\n");
  try {
    const result = await validateRepositoryFiles({ cwd: root });
    assert.equal(result.valid, false);
    assert.deepEqual(result.sections, [{ name: "title", removed: false }, { name: "summary", removed: false }, { name: "run", removed: true }]);
    assert.deepEqual(result.problems.map((problem) => [problem.kind, problem.line]), [["unknown_section", 5], ["unknown_placeholder", 8]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
