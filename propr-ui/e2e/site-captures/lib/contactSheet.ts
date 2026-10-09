import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { manifestPath, outDir } from './shot';

/** Writes contact-sheet.html next to the captures so a run can be reviewed at a glance. */
export default async function contactSheet(): Promise<void> {
  if (!existsSync(manifestPath)) return;
  const latest = new Map<string, Record<string, unknown>>();
  for (const line of (await readFile(manifestPath, 'utf8')).split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    latest.set(String(entry.id), entry);
  }
  const esc = (value: unknown) => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const cards = [...latest.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(entry => `
    <figure>
      <img src="${esc(entry.id)}@2x.webp" width="${esc(entry.width)}" height="${esc(entry.height)}" alt="${esc(entry.alt)}">
      <figcaption><b>${esc(entry.id)}</b> · ${esc(entry.width)}×${esc(entry.height)} · ${esc((entry.usedOn as string[]).join(', '))}
      <br>${esc(entry.alt)}${(entry.unmocked as string[]).length ? `<br><span class="warn">Unmocked: ${esc((entry.unmocked as string[]).join(', '))}</span>` : ''}</figcaption>
    </figure>`).join('');
  await writeFile(path.join(outDir, 'contact-sheet.html'), `<!doctype html><meta charset="utf-8"><title>Site captures</title>
<style>body{font:14px system-ui;margin:24px;background:#f4f6f7}figure{background:#fff;border:1px solid #d6dde0;border-radius:8px;padding:12px;margin:0 0 20px;display:inline-block;vertical-align:top;max-width:100%}img{max-width:100%;height:auto;display:block;border:1px solid #eef1f2}figcaption{margin-top:8px;color:#4a5a62;max-width:720px}.warn{color:#b45309}</style>
<h1>Site captures (${latest.size})</h1>${cards}`);
}
