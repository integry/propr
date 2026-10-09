import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorldLog } from './world';

/** Where captures land. Point SITE_CAPTURES_OUT at the site's asset folder to publish directly. */
export const outDir = path.resolve(process.env.SITE_CAPTURES_OUT ?? fileURLToPath(new URL('../../../../.propr/site-captures', import.meta.url)));
export const manifestPath = path.join(outDir, 'manifest.jsonl');

export interface ShotOptions {
  /** File stem, kebab-case and stable: the site references `<id>.webp` and `<id>@2x.webp`. */
  id: string;
  /** What the image shows, written as the site's alt text. */
  alt: string;
  /** Site pages that use it, for the contact sheet and for knowing what a change affects. */
  usedOn: string[];
  /** CSS pixels of breathing room around the target (default 12). */
  padding?: number;
  /** Extra elements the crop must include (the union of all boxes is captured). */
  include?: Locator[];
  /** Crop limits in CSS pixels; the crop keeps the target's top-left and trims the rest. */
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Captures one focused image: the target element (plus `include`) with
 * padding, cropped from the live page — never fixed coordinates, so a layout
 * change moves the crop with the UI. Fails if the target is missing.
 */
export async function shot(page: Page, target: Locator, options: ShotOptions, testInfo?: TestInfo, log?: WorldLog): Promise<void> {
  await expect(target, `${options.id}: target not visible — update its locator`).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  const boxes = [];
  for (const locator of [target, ...(options.include ?? [])]) {
    const box = await locator.boundingBox();
    if (!box) throw new Error(`${options.id}: element has no box`);
    boxes.push(box);
  }
  const pad = options.padding ?? 12;
  const viewport = page.viewportSize()!;
  let x = Math.max(0, Math.min(...boxes.map(b => b.x)) - pad);
  let y = Math.max(0, Math.min(...boxes.map(b => b.y)) - pad);
  let right = Math.min(viewport.width, Math.max(...boxes.map(b => b.x + b.width)) + pad);
  let bottom = Math.min(viewport.height, Math.max(...boxes.map(b => b.y + b.height)) + pad);
  if (options.maxWidth) right = Math.min(right, x + options.maxWidth);
  if (options.maxHeight) bottom = Math.min(bottom, y + options.maxHeight);
  const clip = { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(right - x), height: Math.ceil(bottom - y) };

  await mkdir(outDir, { recursive: true });
  const png = await page.screenshot({ clip, animations: 'disabled', caret: 'hide' });
  const scale = (await page.evaluate(() => window.devicePixelRatio)) || 1;
  const base = path.join(outDir, options.id);
  const [hi, lo] = await encodeWebp(page, png, Math.round(clip.width * scale / 2));
  await writeFile(`${base}@2x.webp`, hi);
  await writeFile(`${base}.webp`, lo);
  const entry = {
    id: options.id, alt: options.alt, usedOn: options.usedOn, width: Math.round(clip.width * scale / 2), height: Math.round(clip.height * scale / 2),
    test: testInfo?.title ?? '', unmocked: log?.unmocked ?? [],
  };
  await appendFile(manifestPath, `${JSON.stringify(entry)}\n`);
  if (log?.unmocked.length) testInfo?.annotations.push({ type: 'unmocked', description: log.unmocked.join(', ') });
}

/** WebP at full size and at `smallWidth`, encoded by the browser's canvas so the harness needs no image library. */
async function encodeWebp(page: Page, png: Buffer, smallWidth: number): Promise<[Buffer, Buffer]> {
  const encoded = await page.evaluate(async ({ data, width }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const encode = async (w: number, quality: number) => {
      const h = Math.round(bitmap.height * w / bitmap.width);
      const canvas = new OffscreenCanvas(w, h);
      const context = canvas.getContext('2d')!;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, w, h);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp', quality })).arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
    };
    return [await encode(bitmap.width, 0.84), await encode(width, 0.86)];
  }, { data: png.toString('base64'), width: smallWidth });
  return [Buffer.from(encoded[0], 'base64'), Buffer.from(encoded[1], 'base64')];
}
