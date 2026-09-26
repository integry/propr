import { Command } from 'commander';
import {
  applyAgentRuntimePackages,
  getAgentRuntimePackages,
  updateAgentRuntimePackages,
  verifyAgentRuntimePackages,
  type AgentRuntimePackageState,
  type AgentRuntimePackageVerificationResult
} from '../api/agentRuntime.js';

const POLL_INTERVAL_MS = 2000;
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

function printState(state: AgentRuntimePackageState, json = false): void {
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`Status:          ${state.status}`);
  console.log(`Desired:         ${state.packages.length ? state.packages.join(', ') : '(none)'}`);
  console.log(`Active:          ${state.activePackages.length ? state.activePackages.join(', ') : '(none)'}`);
  console.log(`Runtime images:  ${Object.keys(state.images).length}`);
  if (state.error) console.log(`Error:           ${state.error}`);
}

async function waitForBuild(buildId: string, json: boolean): Promise<AgentRuntimePackageState> {
  const deadline = Date.now() + BUILD_TIMEOUT_MS;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const state = await getAgentRuntimePackages();
    if (state.buildId !== buildId) throw new Error('Runtime build was superseded by a newer package change');
    if (!json && state.status !== lastStatus) {
      console.log(`Runtime build: ${state.status}`);
      lastStatus = state.status;
    }
    if (state.status === 'ready' || state.status === 'disabled') return state;
    if (state.status === 'failed') throw new Error(state.error || 'Runtime image build failed');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for the runtime image build');
}

async function finishUpdate(state: AgentRuntimePackageState, options: { wait?: boolean; json?: boolean }): Promise<void> {
  const finalState = options.wait && state.buildId
    ? await waitForBuild(state.buildId, Boolean(options.json))
    : state;
  printState(finalState, Boolean(options.json));
}

function handleError(error: unknown): never {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}

export function printRuntimePackageVerification(
  result: AgentRuntimePackageVerificationResult,
  json = false
): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const label = result.status === 'healthy' ? 'HEALTHY' : result.status === 'disabled' ? 'DISABLED' : 'UNHEALTHY';
  console.log(`Runtime package verification: ${label}`);
  console.log(`Desired: ${result.desiredPackages.length ? result.desiredPackages.join(', ') : '(none)'}`);
  console.log(`Active:  ${result.activePackages.length ? result.activePackages.join(', ') : '(none)'}`);
  if (result.disabled) {
    console.log('Runtime package profile is disabled; agent execution uses the configured base image directly.');
    return;
  }
  for (const error of result.configurationErrors) console.log(`Configuration: ${error}`);
  for (const verificationIssue of result.issues) console.log(`Issue: ${verificationIssue.message}`);
  for (const image of result.images) {
    console.log(`${image.healthy ? 'OK' : 'FAILED'}: ${image.baseImage}`);
    if (image.recordedImage) console.log(`  Runtime image: ${image.recordedImage}`);
    for (const verificationIssue of image.issues) console.log(`  - ${verificationIssue.message}`);
  }
  if (result.remediation) console.log(`Remediation: ${result.remediation}`);
}

export function runtimePackageVerificationExitCode(result: AgentRuntimePackageVerificationResult): number {
  return result.healthy ? 0 : 1;
}

function normalizePackageSpec(value: string): string {
  const trimmed = value.trim();
  const separator = trimmed.indexOf('=');
  if (separator === -1) return trimmed.toLowerCase();
  return `${trimmed.slice(0, separator).toLowerCase()}=${trimmed.slice(separator + 1)}`;
}

function packageNameFromSpec(value: string): string {
  return normalizePackageSpec(value).split('=', 1)[0].split(':', 1)[0];
}

export function filterRemovedRuntimePackages(currentPackages: string[], packagesToRemove: string[]): string[] {
  const removeSpecs = new Set(packagesToRemove.map(normalizePackageSpec));
  const removeNames = new Set(packagesToRemove.map(packageNameFromSpec));
  return currentPackages.filter(value => {
    const normalized = normalizePackageSpec(value);
    return !removeSpecs.has(normalized) && !removeNames.has(packageNameFromSpec(normalized));
  });
}

export function createRuntimeCommand(): Command {
  const runtime = new Command('runtime').description('Manage the installation agent runtime');
  const packages = new Command('packages').description('Manage installation-wide system packages');

  packages.command('list')
    .description('Show desired and active runtime packages')
    .option('-j, --json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      try { printState(await getAgentRuntimePackages(), Boolean(options.json)); }
      catch (error) { handleError(error); }
    });

  packages.command('add <packages...>')
    .description('Add packages and build updated agent runtime images')
    .option('-w, --wait', 'Wait for the build to finish')
    .option('-j, --json', 'Output JSON')
    .action(async (values: string[], options: { wait?: boolean; json?: boolean }) => {
      try {
        const current = await getAgentRuntimePackages();
        const next = [...new Set([...current.packages, ...values])].sort();
        await finishUpdate(await updateAgentRuntimePackages(next), options);
      } catch (error) { handleError(error); }
    });

  packages.command('remove <packages...>')
    .description('Remove packages and rebuild agent runtime images from the clean base')
    .option('-w, --wait', 'Wait for the build to finish')
    .option('-j, --json', 'Output JSON')
    .action(async (values: string[], options: { wait?: boolean; json?: boolean }) => {
      try {
        const current = await getAgentRuntimePackages();
        await finishUpdate(await updateAgentRuntimePackages(filterRemovedRuntimePackages(current.packages, values)), options);
      } catch (error) { handleError(error); }
    });

  packages.command('apply')
    .description('Rebuild the current runtime package profile')
    .option('-w, --wait', 'Wait for the build to finish')
    .option('-j, --json', 'Output JSON')
    .action(async (options: { wait?: boolean; json?: boolean }) => {
      try { await finishUpdate(await applyAgentRuntimePackages(), options); }
      catch (error) { handleError(error); }
    });

  packages.command('verify')
    .description('Verify configured packages and current runtime images without changing them')
    .option('-j, --json', 'Output structured JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const result = await verifyAgentRuntimePackages();
        printRuntimePackageVerification(result, Boolean(options.json));
        if (runtimePackageVerificationExitCode(result) !== 0) process.exitCode = 1;
      } catch (error) { handleError(error); }
    });

  runtime.command('status')
    .description('Show runtime package build and image status')
    .option('-j, --json', 'Output JSON')
    .action(async (options: { json?: boolean }) => {
      try { printState(await getAgentRuntimePackages(), Boolean(options.json)); }
      catch (error) { handleError(error); }
    });

  runtime.addCommand(packages);
  return runtime;
}
