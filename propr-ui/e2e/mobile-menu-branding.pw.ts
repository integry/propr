import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openDashboard } from './dashboard-sections.fixture';

async function capture(page: Page, name: string) {
  if (!process.env.PROPR_CAPTURE_PREVIEWS) return;
  const directory = path.resolve('../.propr/previews');
  await mkdir(directory, { recursive: true });
  await page.screenshot({ animations: 'disabled', path: path.join(directory, `${name}.png`) });
}

const cases = [
  { name: 'narrow-320', viewport: { width: 320, height: 568 }, textScale: 1 },
  { name: 'phone-390', viewport: { width: 390, height: 844 }, textScale: 1 },
  { name: 'short-390', viewport: { width: 390, height: 480 }, textScale: 1 },
  // Browser text zoom: rem-sized type and controls grow together.
  { name: 'enlarged-text-320', viewport: { width: 320, height: 568 }, textScale: 1.5 },
  { name: 'enlarged-text-390', viewport: { width: 390, height: 844 }, textScale: 1.5 },
];

async function openMenu(page: Page, viewport: { width: number; height: number }, textScale: number) {
  await openDashboard(page, viewport);
  if (textScale !== 1) await page.addStyleTag({ content: `html { font-size: ${textScale * 100}%; }` });
  const moreButton = page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('button', { name: 'More' });
  await moreButton.click();
  const sheet = page.getByRole('dialog', { name: 'ProPR', exact: true });
  await expect(sheet).toBeVisible();
  await settle(page);
  return { moreButton, sheet };
}

// Measure only once the sheet has finished rising (and the scrim fading):
// mid-animation rectangles carry a fractional translate. Endless animations
// elsewhere on the page (spinners) never finish, so only finite ones count.
// A finite animation cancelled before its end (WebKit cancels one the sheet's
// opening replaces) rejects `finished` and moves nothing more, so the wait
// continues with whatever is still running instead of failing.
async function settle(page: Page) {
  await page.evaluate(async () => {
    const running = () => document.getAnimations().filter(animation =>
      animation.playState !== 'finished' && animation.playState !== 'idle' && animation.effect?.getComputedTiming().endTime !== Infinity);
    for (let pending = running(); pending.length; pending = running()) await Promise.allSettled(pending.map(animation => animation.finished));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

// Tight allowance for float noise in DOM rectangle arithmetic, not a looser target.
const SUBPIXEL = 0.01;

for (const { name, viewport, textScale } of cases) {
  test(`the More sheet is headed ProPR with its logo at ${name}`, async ({ page }) => {
    const { moreButton, sheet } = await openMenu(page, viewport, textScale);
    const heading = sheet.getByRole('heading', { level: 2, name: 'ProPR', exact: true });
    const logo = heading.locator('img');
    const close = sheet.getByRole('button', { name: 'Close ProPR menu' });
    await expect(logo).toHaveAttribute('alt', '');
    await expect.poll(() => logo.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    const layout = await sheet.evaluate(dialog => {
      const box = (element: Element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const header = dialog.querySelector('h2')!.parentElement!;
      const image = dialog.querySelector('h2 img') as HTMLImageElement;
      const title = dialog.querySelector('h2 span')!;
      const closeButton = dialog.querySelector('[aria-label="Close ProPR menu"]')!;
      return {
        header: box(header), logo: box(image), title: box(title), close: box(closeButton),
        ratio: image.naturalWidth / image.naturalHeight,
        titleClipped: title.scrollWidth > title.clientWidth,
      };
    });
    // Logo, then title, then close: inside the header, never overlapping.
    for (const part of [layout.logo, layout.title, layout.close]) {
      expect(part.left).toBeGreaterThanOrEqual(layout.header.left - SUBPIXEL);
      expect(part.right).toBeLessThanOrEqual(layout.header.right + SUBPIXEL);
      expect(part.top).toBeGreaterThanOrEqual(layout.header.top - SUBPIXEL);
      expect(part.bottom).toBeLessThanOrEqual(layout.header.bottom + SUBPIXEL);
    }
    expect(layout.logo.right).toBeLessThanOrEqual(layout.title.left + SUBPIXEL);
    expect(layout.title.right).toBeLessThanOrEqual(layout.close.left + SUBPIXEL);
    expect(layout.titleClipped).toBe(false);
    // The existing mark keeps its own proportions.
    expect(layout.logo.width / layout.logo.height).toBeCloseTo(layout.ratio, 1);
    expect(layout.close.width).toBeGreaterThanOrEqual(44 - SUBPIXEL);
    expect(layout.close.height).toBeGreaterThanOrEqual(44 - SUBPIXEL);
    await expect(sheet.getByRole('link', { name: 'Goals' })).toBeVisible();
    await capture(page, `mobile-propr-menu-${name}`);

    // Keyboard: focus is inside the sheet, close is reachable, Escape returns focus.
    await expect(sheet.locator(':focus')).toHaveCount(1);
    await close.focus();
    await expect(close).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(moreButton).toBeFocused();
  });
}

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const inside = (inner: Box, outer: Box) =>
  inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 &&
  inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
const overlaps = (a: Box, b: Box) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

for (const { name, viewport, textScale } of cases) {
  test(`More shows whole workspace labels and a readable account row at ${name}`, async ({ page }) => {
    const { sheet } = await openMenu(page, viewport, textScale);
    const layout = await sheet.evaluate(dialog => {
      const box = (element: Element) => {
        const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      // Lines a text node is laid out on: more lines than words means a word
      // was broken apart, which reads as badly as an ellipsis.
      const lines = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(Array.from(range.getClientRects()).filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size;
      };
      const clipped = (element: Element) =>
        element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
      const workspace = dialog.querySelector('section[aria-labelledby="mobile-more-workspace"]')!;
      const signOut = Array.from(dialog.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Sign out')!;
      const profile = signOut.parentElement!;
      const [identityName, identityLogin] = Array.from(profile.querySelectorAll('p'));
      return {
        sheet: box(dialog),
        rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tiles: Array.from(workspace.querySelectorAll('a')).map(link => {
          const label = link.querySelector('span')!;
          return {
            text: label.textContent ?? '', link: box(link), label: box(label),
            clipped: clipped(label) || clipped(link), lines: lines(label),
            words: (label.textContent ?? '').split(/\s+/).length,
          };
        }),
        profile: box(profile),
        signOut: box(signOut),
        identity: [identityName, identityLogin].map(element => ({
          text: element.textContent ?? '', box: box(element), clipped: clipped(element),
          lines: lines(element), words: (element.textContent ?? '').split(/\s+/).length,
        })),
      };
    });

    expect(layout.documentOverflow).toBeLessThanOrEqual(0);

    // Every destination keeps its full name, whole words, inside its own tile.
    expect(layout.tiles.map(tile => tile.text)).toEqual(['Goals', 'Plans', 'Automations', 'Repositories']);
    for (const tile of layout.tiles) {
      expect(tile.clipped, `${tile.text} is clipped`).toBe(false);
      expect(tile.lines, `${tile.text} breaks mid-word`).toBeLessThanOrEqual(tile.words);
      expect(inside(tile.label, tile.link), `${tile.text} spills out of its tile`).toBe(true);
      expect(inside(tile.link, layout.sheet)).toBe(true);
      expect(tile.link.height).toBeGreaterThanOrEqual(44 - SUBPIXEL);
      expect(tile.link.width).toBeGreaterThanOrEqual(44 - SUBPIXEL);
    }
    for (const [index, tile] of layout.tiles.entries()) {
      for (const other of layout.tiles.slice(index + 1)) expect(overlaps(tile.link, other.link)).toBe(false);
    }

    // The account reads as a name and a login, not a letter or two, and
    // Sign out sits beside or beneath it without covering it.
    expect(layout.identity.map(line => line.text)).toEqual(['Dana Okonkwo', '@operator']);
    for (const line of layout.identity) {
      expect(line.clipped, `${line.text} is clipped`).toBe(false);
      expect(line.lines, `${line.text} breaks mid-word`).toBeLessThanOrEqual(line.words);
      expect(line.box.width).toBeGreaterThanOrEqual(6 * layout.rootFontSize);
      expect(inside(line.box, layout.profile)).toBe(true);
      expect(overlaps(line.box, layout.signOut)).toBe(false);
    }
    expect(inside(layout.signOut, layout.profile)).toBe(true);
    expect(inside(layout.profile, layout.sheet)).toBe(true);
    expect(layout.signOut.height).toBeGreaterThanOrEqual(40 - SUBPIXEL);
    await sheet.evaluate(dialog => { dialog.scrollTop = 0; });
    await capture(page, `mobile-propr-menu-readable-${name}`);

    // Short or enlarged screens scroll the sheet itself to the last row.
    const lastLink = sheet.getByRole('link', { name: 'Settings' });
    await lastLink.scrollIntoViewIfNeeded();
    await expect(lastLink).toBeInViewport({ ratio: 1 });
  });
}
