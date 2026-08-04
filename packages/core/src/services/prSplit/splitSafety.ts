import type { PrSnapshotFile } from './types.js';

const GENERATED_DIRECTORIES = /(^|\/)(dist|build|coverage|vendor|third_party|node_modules|generated)(\/|$)/i;
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock|poetry\.lock|uv\.lock|pipfile\.lock|cargo\.lock|gemfile\.lock|go\.sum|package\.resolved|gradle\.lockfile)$/i;
const GENERATED_NAME = /\.min\.(js|css)$|\.(generated|gen)\.[cm]?[jt]sx?$|\.snap$/i;
const SECRET_PATH = /(^|\/)(\.env(?:\..+)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^.]+)?\.json|service[-_]?account(?:\.[^.]+)?\.json|secrets?\.ya?ml)$|\.(pem|p12|pfx|key)$/i;
const SECRET_CONTENT = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bASIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"][^'"\r\n]{8,}['"]/i;

export function isGeneratedSplitArtifact(filename: string): boolean {
  return GENERATED_DIRECTORIES.test(filename)
    || LOCKFILE.test(filename)
    || GENERATED_NAME.test(filename);
}

function addedPatchText(file: PrSnapshotFile): string {
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
  const changedContent = file.contentComplete && file.headContent !== null
    ? file.headContent
    : addedPatchText(file);
  return pathLooksSecret || SECRET_CONTENT.test(changedContent);
}
