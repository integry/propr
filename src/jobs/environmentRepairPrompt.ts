export const FIX_ENVIRONMENT_REPAIR_INSTRUCTIONS = `**Environment Repair for /fix:**
- If verification fails because an executable, package, runtime, package manager, system library, or generated setup step is missing inside the agent container, repository setup changes are in scope.
- Inspect .propr/setup.sh and related manifests. If .propr is missing, create the standard ProPR setup scaffold before editing it.
- Prefer the repository's native dependency installation first, such as npm ci, pnpm install, pip install -r requirements.txt, bundle install, cargo fetch, or the equivalent for this repo.
- Use .propr/package.json for agent-only npm helper packages and guarded \`sudo apt-get update && sudo apt-get install -y --no-install-recommends <pkg>\` commands for Debian system packages.
- Keep setup changes minimal and committed with the normal code changes so reviewers can inspect them.
- After changing setup, run .propr/setup.sh once with PROPR_WORKSPACE and PROPR_CACHE_DIR set if needed, then retry the failed verification command once. Do not loop indefinitely.`;


export function getFixEnvironmentRepairInstructions(commandMode?: string): string {
    return commandMode === 'fix'
        ? `\n${FIX_ENVIRONMENT_REPAIR_INSTRUCTIONS}`
        : '';
}
