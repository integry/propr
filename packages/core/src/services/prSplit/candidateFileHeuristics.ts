import { posix } from 'node:path';
import type { PrSnapshotFile } from './types.js';

const GENERATED_DIRECTORIES = /(^|\/)(dist|build|coverage|vendor|third_party|node_modules|generated)(\/|$)/i;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|poetry\.lock|cargo\.lock|gemfile\.lock)$/i;
const GENERATED_NAME = /\.min\.(js|css)$|\.(generated|gen)\.[cm]?[jt]sx?$|\.snap$/i;
const TEST_PATH = /(^|\/)(tests?|spec|__tests__)(\/|$)|\.(test|spec)\.[^.]+$|_test\.[^.]+$/i;
const SOURCE_PATH = /\.(?:[cm]?[jt]sx?|py|go|rs|rb|php|java|kt|kts|cs|cpp|cc|cxx|c|h|hpp|swift|scala|vue|svelte)$/i;
const SPECIAL_DEPENDENCY = /(^|\/)(migrations?|schema|schemas|types?)(\/|$)|(^|\/)(types?|schema)\.[cm]?[jt]s$|\.(sql|prisma|proto|d\.ts)$/i;
const SECRET_PATH = /(^|\/)(\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^.]+)?\.json|service[-_]?account(?:\.[^.]+)?\.json|secrets?\.ya?ml)$|\.(pem|p12|pfx|key)$/i;
const SECRET_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"\r\n]{8,}['"]/i;

export function isGeneratedSplitFile(filename: string): boolean {
  return GENERATED_DIRECTORIES.test(filename)
    || LOCKFILE.test(filename)
    || GENERATED_NAME.test(filename);
}

export function addedSplitPatchText(file: PrSnapshotFile): string {
  if (!file.patch) return '';
  return file.patch
    .split(/\r?\n/)
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .map(line => line.slice(1))
    .join('\n');
}

export function isSecretBearingSplitFile(file: PrSnapshotFile): boolean {
  const pathLooksSecret = SECRET_PATH.test(file.filename)
    && !/\.env\.(example|sample|template)$|(^|\/)\.env\.example$/i.test(file.filename);
  const changedContent = file.headContent ?? addedSplitPatchText(file);
  return pathLooksSecret || SECRET_CONTENT.test(changedContent);
}

export function isTestSplitFile(filename: string): boolean {
  return TEST_PATH.test(filename);
}

export function isSpecialSplitDependencyFile(filename: string): boolean {
  return SPECIAL_DEPENDENCY.test(filename);
}

export function isImplementationSplitFile(filename: string): boolean {
  return SOURCE_PATH.test(filename)
    && !isTestSplitFile(filename)
    && !isGeneratedSplitFile(filename)
    && !isSpecialSplitDependencyFile(filename);
}

export function normalizedSplitFileStem(filename: string): string {
  return posix.basename(filename)
    .toLowerCase()
    .replace(/\.d\.[^.]+$/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/(?:[._-](?:test|spec|generated|gen))$/, '')
    .replace(/[^a-z0-9]/g, '');
}
