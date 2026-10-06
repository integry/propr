/**
 * `propr repo validate`: check repository-local ProPR files in a checkout
 * without contacting a ProPR instance.
 */

import { Command } from "commander";
import path from "path";
import { readFile } from "fs/promises";
import { PR_TEMPLATE_PATH, PR_TEMPLATE_SECTIONS, parsePrTemplate, type PrTemplateProblem, type PrTemplateSection } from "@propr/shared";
import { printOutput } from "../utils/io.js";

export interface RepoValidateResult {
  file: string;
  found: boolean;
  valid: boolean;
  /** Sections that replace ProPR's defaults; `removed` ones are whitespace-only. */
  sections: Array<{ name: PrTemplateSection; removed: boolean }>;
  problems: PrTemplateProblem[];
}

export async function validateRepositoryFiles(options: { cwd?: string } = {}): Promise<RepoValidateResult> {
  const file = path.join(path.resolve(options.cwd ?? process.cwd()), PR_TEMPLATE_PATH);
  let source: string;
  try {
    source = await readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { file, found: false, valid: true, sections: [], problems: [] };
    throw error;
  }
  const { sections, problems } = parsePrTemplate(source);
  return {
    file,
    found: true,
    valid: problems.length === 0,
    sections: PR_TEMPLATE_SECTIONS.filter((name) => sections[name] !== undefined).map((name) => ({ name, removed: !sections[name] })),
    problems,
  };
}

function displayResult(result: RepoValidateResult): void {
  if (!result.found) {
    console.log(`No ${PR_TEMPLATE_PATH} found; ProPR writes its default pull request description.`);
    return;
  }
  for (const problem of result.problems) {
    console.log(`${PR_TEMPLATE_PATH}${problem.line ? `:${problem.line}` : ""}: ${problem.message}`);
  }
  const customized = result.sections.map((section) => section.removed ? `${section.name} (removed)` : section.name);
  console.log(customized.length ? `Customized sections: ${customized.join(", ")}` : "No sections customized; ProPR's defaults apply.");
  console.log(result.valid ? `${PR_TEMPLATE_PATH} is valid.` : `${PR_TEMPLATE_PATH} has ${result.problems.length} problem(s). ProPR ignores unknown sections and falls back to its default description when a template cannot be rendered.`);
}

export function createRepoValidateCommand(): Command {
  return new Command("validate")
    .description(`Validate repository-local ProPR files (${PR_TEMPLATE_PATH}) in the current checkout`)
    .option("-C, --cwd <path>", "Repository checkout to validate (default: current directory)")
    .option("-j, --json", "Output result as JSON")
    .action(async (options: { cwd?: string; json?: boolean }) => {
      try {
        const result = await validateRepositoryFiles({ cwd: options.cwd });
        if (!printOutput(result, !!options.json)) displayResult(result);
        if (!result.valid) process.exitCode = 1;
      } catch (error) {
        console.error(`Error validating repository files: ${(error as Error).message}`);
        process.exit(1);
      }
    });
}
