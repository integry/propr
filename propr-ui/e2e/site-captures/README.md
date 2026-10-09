# Site captures

Screenshots for propr.dev, rendered from the real UI against a mock instance.
Each capture is a small, focused image of one thing the site describes — a
status chip, a panel, a dialog — so the page can show it instead of telling it.

This is not a test suite and never runs in CI. It has its own Playwright config.

## Run

```bash
npm run build -w @propr/shared && npm run build -w @propr/client   # once per checkout
npm run site-captures -w propr-ui                                  # all captures
npm run site-captures -w propr-ui -- shots/goals                   # one file
```

The config builds the UI and serves it on `127.0.0.1:4173` (it reuses a server
that is already running there — restart it after changing UI code).

Output goes to `.propr/site-captures/` at the repo root:

- `<id>@2x.webp` (retina) and `<id>.webp` (1x) for every shot;
- `manifest.jsonl` — id, alt text, size, site pages, and any unmocked API calls;
- `contact-sheet.html` — every shot on one page, for review before publishing.

To write straight into the site, point `SITE_CAPTURES_OUT` at its asset folder:

```bash
SITE_CAPTURES_OUT=/path/to/propr-site/release-site-src/public/assets/screenshots/ui \
  npm run site-captures -w propr-ui
```

Set `CHROMIUM_PATH` to use a system Chromium instead of Playwright's download.

## Layout

```
playwright.site-captures.config.ts   viewport 1440×900 @2x, UTC, en-US, reduced motion
e2e/site-captures/
  lib/world.ts         installWorld(page, ...areas): mock API router, logs unmocked calls
  lib/shot.ts          shot(page, locator, options): crop to the element, write WebP + manifest
  lib/contactSheet.ts  global teardown: builds contact-sheet.html
  world/base.ts        Northwind Labs: user, repos, agents, settings, app chrome
  world/<area>.ts      mock data for one product area (goals, tasks, plans, …)
  shots/<area>.capture.ts   the shots for that area
```

## The mock world

Every screen shows the same fictional team, **Northwind Labs**: repos
`northwind/storefront-web`, `northwind/orders-api`, `northwind/courier-app`,
`northwind/platform-infra`, signed in as Maya Ortiz. Use `REPOS`, `USER`,
`NOW`, `minutesAgo()` and friends from `world/base.ts` so screens agree with
each other. Write data that reads like a real week of work — believable issue
titles, branch names, review scores and timings — never lorem ipsum, never
real customer, employee or private-repo names, and never aggregate spend.

`installWorld(page, base, goals, …)` answers each API call from the first area
(last argument first) that knows it. Areas are built with `area(name, routes,
patterns)`: exact paths (`'GET /api/goals'` or `'/api/goals'`), or regex
routes for ids. Unanswered calls get a 503 and are listed in the manifest and
on the contact sheet — a panel that shows an error usually means a missing
route there.

Response shapes must match the real API. When the UI changes what it reads,
fix the area module; the e2e specs in `e2e/*.pw.ts` and the types in
`src/api/` are the best reference for current shapes.

## Writing a shot

```ts
test('goal progress', async ({ page }, info) => {
  const log = await installWorld(page, base, goals);
  await page.goto(`/goals/${GOAL.id}`);
  await shot(page, page.getByRole('region', { name: 'Progress' }), {
    id: 'goal-progress',
    alt: 'Goal progress: 4 of 6 steps merged, one in review',
    usedOn: ['/goals/'],
  }, info, log);
});
```

Rules that keep shots useful and resilient:

- **Frame one idea.** Capture the element the copy talks about, not the page.
  Prefer several micro-shots (a chip, a row, a card) over one wide screenshot.
  Full-page views are the exception, for “here is the whole console” moments.
- **Locate by meaning.** Use `getByRole`, `getByLabel`, `getByText` or a
  `data-testid` the UI already has — never CSS paths or pixel coordinates.
  The crop is the element's own box plus padding, so it follows layout changes.
- **Fail loudly.** `shot()` fails by id when its target is missing. Fix the
  locator or the mock; don't loosen the locator until anything matches.
- **Use `include`** to add a neighbour (a heading, a legend) to the crop and
  `maxWidth` / `maxHeight` to trim long panels.
- **Set state through the UI** (clicks, hovers, opened menus) after load, or
  through the mock data — not by editing the DOM.
- **Keep ids stable.** The site references `<id>.webp` / `<id>@2x.webp`;
  renaming an id breaks the page that uses it.
- **Alt text** describes what the image shows, in the site's voice.

## Before publishing

Open `contact-sheet.html` and check every shot: correct state, no error
banners, no "unmocked" warnings that affect what's shown, nothing cut off, no
real names or private repositories.
