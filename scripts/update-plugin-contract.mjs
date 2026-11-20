#!/usr/bin/env tsx
/**
 * Records the plugin interface contract (manifest fields, event payloads and
 * the handler SDK surface) in
 * packages/shared/test/contracts/plugin-contract.snapshot.json, which the
 * shared package's contract test compares the current interface with.
 *
 * `npm run plugins:contract:update` records additive changes. It refuses a
 * breaking change: removing or retyping something plugins rely on needs a
 * new manifestVersion (for the manifest) or must not happen at all (event
 * payloads and the SDK are additive only). `--accept-breaking` records it
 * anyway, for the rare reviewed exception, and prints what it accepted.
 *
 * Runs under tsx: it imports the TypeScript sources so no build is needed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { comparePluginContract } from '../packages/shared/src/pluginContract.js';
import { buildSourcePluginContract, pluginContractSourceMismatches } from '../packages/shared/test/support/pluginContractSource.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_CONTRACT_SNAPSHOT = path.join(repositoryRoot, 'packages/shared/test/contracts/plugin-contract.snapshot.json');

export const serializePluginContract = contract => `${JSON.stringify(contract, null, 2)}\n`;

function main(argv) {
  const acceptBreaking = argv.includes('--accept-breaking');
  const mismatches = pluginContractSourceMismatches();
  if (mismatches.length) {
    console.error(`The event descriptors in packages/shared/src/pluginContract.ts differ from the source interfaces:\n${mismatches.map(m => `  - ${m}`).join('\n')}\nUpdate them first. Nothing was written.`);
    return 1;
  }
  // The contract as the TypeScript sources declare it: real payload field types and SDK signatures.
  const current = buildSourcePluginContract();
  if (existsSync(PLUGIN_CONTRACT_SNAPSHOT)) {
    const previous = JSON.parse(readFileSync(PLUGIN_CONTRACT_SNAPSHOT, 'utf8'));
    const { breaking, additions } = comparePluginContract(previous, current);
    if (breaking.length && !acceptBreaking) {
      console.error(`The plugin interface has ${breaking.length} breaking change(s):\n${breaking.map(b => `  - ${b}`).join('\n')}\nSee "Compatibility rules" in docs/docs/plugins/authoring.md. Nothing was written.`);
      return 1;
    }
    for (const change of breaking) console.log(`accepted breaking change: ${change}`);
    for (const change of additions) console.log(`recorded: ${change}`);
  }
  writeFileSync(PLUGIN_CONTRACT_SNAPSHOT, serializePluginContract(current));
  console.log(`Wrote ${path.relative(repositoryRoot, PLUGIN_CONTRACT_SNAPSHOT)}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
