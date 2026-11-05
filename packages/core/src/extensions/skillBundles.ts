import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { posix } from 'node:path';
import { parse } from 'yaml';
import { EXTENSION_LIMITS } from '@propr/shared';

export interface SkillFile { path: string; content: string }
function fail(): never { throw new Error('Invalid or oversized skill bundle'); }
export function skillPath(value: string): string {
  // eslint-disable-next-line no-control-regex -- reject NUL/control characters in untrusted archive paths
  if (!value || value.length > 240 || /[\\\x00-\x1f:]/.test(value) || value.startsWith('/') || value.split('/').some(v => !v || v === '.' || v === '..') || posix.normalize(value) !== value) fail();
  return value;
}
// eslint-disable-next-line complexity -- archive and skill validation keep all rejection checks at the untrusted input boundary
export function validateSkillFiles(files: SkillFile[]): { digest: string; name: string; requirements: string[]; bytes: number; files: SkillFile[] } {
  if (!files.length || files.length > EXTENSION_LIMITS.files) fail();
  const paths = new Set<string>(); const components = new Map<string, string>(); let bytes = 0;
  for (const file of files) {
    skillPath(file.path);
    const segments = file.path.split('/');
    for (let count = 1; count <= segments.length; count++) {
      const prefix = segments.slice(0, count).join('/'); const folded = prefix.normalize('NFC').toLowerCase();
      if (components.has(folded) && components.get(folded) !== prefix) fail();
      components.set(folded, prefix);
    }
    const key = file.path.normalize('NFC').toLowerCase();
    if (paths.has(key) || [...paths].some(p => p.startsWith(key + '/') || key.startsWith(p + '/'))) fail();
    paths.add(key);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) fail();
    bytes += Buffer.from(file.content, 'base64').length;
    if (bytes > EXTENSION_LIMITS.bytes) fail();
  }
  const skill = files.find(f => f.path === 'SKILL.md');
  if (!skill) fail();
  const markdown = Buffer.from(skill.content, 'base64').toString('utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match || match[1].length > 16_384) fail();
  let metadata: Record<string, unknown>;
  try { metadata = parse(match[1], { maxAliasCount: 0 }) as Record<string, unknown>; } catch { return fail(); }
  if (!metadata || typeof metadata.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(metadata.name) || typeof metadata.description !== 'string' || !metadata.description.trim()) fail();
  // Requirements remain declarations. No script or frontmatter is executed at import.
  const requirements = metadata.requirements ?? [];
  if (!Array.isArray(requirements) || requirements.length > 64 || requirements.some(v => typeof v !== 'string' || v.length > 256)) fail();
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const digest = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  return { digest, name: metadata.name, requirements, bytes, files: sorted };
}

/** Strict ustar regular files/directories only. PAX/GNU extensions and all links are rejected. */
// eslint-disable-next-line complexity -- archive and skill validation keep all rejection checks at the untrusted input boundary
export function readSkillArchive(input: Buffer): SkillFile[] {
  if (input.length > EXTENSION_LIMITS.archiveBytes) fail();
  let archive = input;
  if (input[0] === 0x1f && input[1] === 0x8b) {
    try { archive = gunzipSync(input, { maxOutputLength: EXTENSION_LIMITS.bytes + EXTENSION_LIMITS.files * 1024 + 1024 }); } catch { fail(); }
  }
  if (archive.length % 512 !== 0 || archive.length > EXTENSION_LIMITS.bytes + EXTENSION_LIMITS.files * 1024 + 1024) fail();
  const files: SkillFile[] = []; const entries = new Set<string>(); const components = new Map<string, string>(); let ended = false;
  const field = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  for (let offset = 0; offset < archive.length; ) {
    const header = archive.subarray(offset, offset + 512); offset += 512;
    if (header.every(b => b === 0)) { ended = true; if (archive.subarray(offset).some(b => b !== 0)) fail(); break; }
    let checksum = 0; for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    const checksumText = field(header.subarray(148, 156)).trim();
    if (!/^[0-7]+$/.test(checksumText) || parseInt(checksumText, 8) !== checksum) fail();
    const sizeText = field(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/.test(sizeText)) fail();
    const size = parseInt(sizeText, 8); const type = header[156];
    if (!Number.isSafeInteger(size) || size > EXTENSION_LIMITS.bytes || offset + size > archive.length || ![0, 48, 53].includes(type) || field(header.subarray(157, 257))) fail();
    const prefix = field(header.subarray(345, 500));
    let name = (prefix ? prefix + '/' : '') + field(header.subarray(0, 100));
    if (type === 53 && name.endsWith('/')) name = name.slice(0, -1);
    skillPath(name);
    const segments = name.split('/');
    for (let count = 1; count <= segments.length; count++) {
      const prefix = segments.slice(0, count).join('/'); const folded = prefix.normalize('NFC').toLowerCase();
      if (components.has(folded) && components.get(folded) !== prefix) fail();
      components.set(folded, prefix);
    }
    const key = name.normalize('NFC').toLowerCase();
    if (entries.has(key) || entries.size >= EXTENSION_LIMITS.files) fail();
    entries.add(key);
    if (type === 53) { if (size !== 0) fail(); }
    else files.push({ path: name, content: archive.subarray(offset, offset + size).toString('base64') });
    offset += Math.ceil(size / 512) * 512;
  }
  if (!ended) fail();
  validateSkillFiles(files);
  return files;
}
