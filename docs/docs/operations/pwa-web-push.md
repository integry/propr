---
sidebar_position: 8
title: PWA, Web Push, and Badges
---

# PWA, Web Push, and Badges

ProPR's production UI is an installable Progressive Web App (PWA). Web Push is optional: the Inbox and live UI continue to work when Push is not configured or a browser lacks Push or Badging APIs. Outside `localhost`, both the UI and API must be reached over HTTPS.

## Configure VAPID

Generate one P-256 VAPID key pair for each ProPR installation on an administrator-controlled machine. From a ProPR source checkout with dependencies installed, use the repository's pinned `web-push` package:

```bash
npx --no-install web-push generate-vapid-keys
```

Run this only in a private terminal without session recording. Transfer the displayed values directly into the stack's protected `.env` or secret manager; do not redirect or pipe the output into build/deployment logs:

```bash
WEB_PUSH_VAPID_SUBJECT=mailto:admin@example.com
WEB_PUSH_VAPID_PUBLIC_KEY=<URL-safe-base64-public-key>
WEB_PUSH_VAPID_PRIVATE_KEY=<URL-safe-base64-private-key>
WEB_PUSH_ENABLED=true
```

Set all three `WEB_PUSH_VAPID_*` values together. The subject must be an HTTPS contact URL or a `mailto:` address. `propr check` and both launcher paths reject an incomplete tuple, malformed keys or subject, and a public/private mismatch before startup.

The **public key is intentionally browser-visible**: an authenticated browser obtains it from `GET /api/notifications/config` and supplies it when creating a subscription. The **private key is a server signing credential**. Keep it only in the protected stack `.env` or a server-side secret manager. Never commit it, copy it into `VITE_*`/`config.js`, put it on a command line, paste it into an issue, or print it in application or deployment logs. Restrict the deployed file to its service account (for example, `chmod 600 .env`) and rotate the pair if the private key is exposed. Rotation requires browsers to subscribe again.

The optional dispatcher interval, batch, lease, request-timeout, TTL, attempt, and retry variables are listed in [Configuration Reference](./configuration-reference.md). Validate and restart after any change:

```bash
propr check
propr start --restart
```

Leaving all three VAPID values unset is a valid Push-disabled installation. `WEB_PUSH_ENABLED=false` pauses delivery without deleting preferences or subscriptions; it is not a substitute for removing or correcting a partial key tuple.

## Install and enable notifications

In a supported desktop or Android browser, install ProPR from the browser's install control, open the installed app, then go to **Settings → Personal notifications → Enable on this browser**. Permission is requested only from that button click. Enable Push for the desired categories after the browser is subscribed.

On **iOS or iPadOS 16.4 and later**, Web Push is available only to a Home Screen web app:

1. Open the ProPR UI in Safari.
2. Open **Share**, choose **Add to Home Screen**, and confirm.
3. Launch ProPR from its new Home Screen icon, not the original Safari tab.
4. Sign in, open **Settings → Personal notifications**, and choose **Enable on this browser**.
5. Accept the system notification prompt, then enable the desired Push categories.

Apple describes the platform behavior in [Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). A permission prompt cannot be triggered silently; it must follow the user's action. If permission is denied, ProPR cannot ask again until it is allowed in browser/site or OS notification settings.

Each browser profile or installed app creates its own subscription. Enabling one device does not enable another.

## UI and API origins

The PWA, service worker, notification permission, and browser subscription belong to the **UI origin**. The API stores the subscription for the authenticated ProPR user and uses the installation's private VAPID key to send to it.

### Self-hosted UI

For a normal self-hosted deployment, the UI origin is the public origin serving the `propr/ui` bundle, such as `https://propr.example.com`. The API may be same-origin or a separate HTTPS origin. `FRONTEND_URL` must equal the UI origin, while `API_PUBLIC_URL` and runtime `PROPR_UI_PUBLIC_API_URL` must identify the browser-reachable API origin. Moving the UI to a different scheme, host, or port creates a different PWA origin; users must install/subscribe on the new origin.

### Hosted UI tunnel

With the hosted tunnel, the origins are deliberately different:

| Responsibility | Origin |
|---|---|
| UI, manifest, service worker, installed PWA, permission, browser subscription | `https://app.propr.dev` |
| Selected stack's REST API, Socket.IO, OAuth callback, and session | `https://t-<id>.propr.dev` |

The `t-<id>` tunnel routes only `/api/*` and `/socket.io/*`; it does not serve PWA files. The subscription is created by the `app.propr.dev` service worker, then registered with the currently selected `t-<id>` backend and owned there by the authenticated user. A browser has one Push subscription for that service-worker registration. Before changing the hosted UI to a different ProPR stack, disable Push on the old stack, switch stacks, and enable it again so the new stack owns a subscription created with its VAPID public key. Do not copy subscription endpoints between users, stacks, origins, or browser profiles.

See [Hosted UI Tunnel](./hosted-ui-tunnel.md) for tunnel routing and authentication details.

## Reverse proxy and caching contract

The proxy must preserve HTTPS, content types, and these exact UI-origin paths. Exact file locations must win over the SPA fallback; returning `index.html` for a worker, manifest, icon, shell manifest, or `config.js` breaks installation or can send the browser to the wrong API.

| UI-origin path | Required handling | Recommended `Cache-Control` |
|---|---|---|
| `/service-worker.js` (the ProPR worker; often named `sw.js` in other deployments) | Serve JavaScript from the UI root with scope `/`; never SPA-rewrite it | `no-cache, must-revalidate` |
| `/manifest.webmanifest` | Serve as a web app manifest; never SPA-rewrite it | `no-cache, must-revalidate` |
| `/pwa-shell-assets.json` | Serve the release's shell asset list | `no-cache, must-revalidate` |
| `/icons/pwa-192x192.png`, `/icons/pwa-512x512.png`, `/icons/pwa-maskable-512x512.png`, `/apple-touch-icon.png` | Serve the real PNG files | `public, max-age=86400` (purge when replaced) |
| `/config.js` | Serve the per-deployment runtime API selection; never cache or SPA-rewrite it | `no-store, no-cache, must-revalidate` |
| `/assets/*` | Serve the hashed files from the same UI release | `public, max-age=31536000, immutable` |
| `/`, `/index.html`, and application routes | Serve the current HTML; application routes may fall back to `index.html` | `no-cache, must-revalidate` |

The published UI container already supplies strict headers for `/service-worker.js` and `/config.js`; an outer CDN or proxy must preserve them or apply an equally strict policy. Do not apply an `immutable` blanket policy to the worker, manifest, shell manifest, HTML, or runtime config. WebSocket upgrades remain required on the API's `/socket.io/` path.

Check the public response, not only the container upstream:

```bash
curl -I https://propr.example.com/service-worker.js
curl -I https://propr.example.com/manifest.webmanifest
curl -I https://propr.example.com/icons/pwa-192x192.png
curl -I https://propr.example.com/config.js
```

Expect `200`, the correct non-HTML content type, and the cache policy above. In the browser, confirm the registered worker's script URL and scope are the UI origin and `/`.

## Badges are progressive enhancement

The **Show an unread-count badge on the installed app** preference asks the browser's Badging API to show the Inbox unread count, capped at 99. Push receipt and foreground Inbox refresh both update it; reading or dismissing notifications reduces or clears it.

Badge presentation and support vary by browser, operating system, launcher, and installation state. Some environments show a number, some show only a dot, and unsupported browsers show nothing. ProPR treats `setAppBadge`/`clearAppBadge` as best effort: missing or rejected badge calls never block notification delivery or Inbox use. Test badges on an installed PWA rather than assuming a normal browser tab will display them.

## Troubleshooting

### Permission is denied

- Open the browser's site settings and the operating system's notification settings for the **UI origin** (or installed ProPR app), allow notifications, then reload/reopen the app.
- On iPhone/iPad, confirm iOS/iPadOS 16.4+ and that ProPR was launched from its Home Screen icon before pressing **Enable on this browser**.
- If policy-managed browser settings block notifications, an administrator must change that policy; repeatedly pressing Enable cannot reopen a denied prompt.

### Subscription is missing or expired

- In Settings, confirm the browser says **This browser is subscribed**. Disable and re-enable it to create a fresh endpoint.
- Provider responses `404` or `410` automatically revoke and erase an expired subscription. Re-enable Push on that browser afterward.
- If the UI origin or VAPID pair changed, unsubscribe/resubscribe; old subscriptions cannot be reused with a new origin or signing identity.
- Check `GET /api/notifications/push-subscriptions` while authenticated and the API logs. Do not put an endpoint URL or private key in a ticket or log; endpoints are bearer-like capability URLs.

### Notification arrives but the badge is missing

- Confirm the badge preference is enabled and the Inbox has unread items.
- Use an installed PWA on an OS/browser that implements the Badging API. A missing badge on an unsupported platform is expected and does not indicate Push failure.
- Open the app once and compare the Inbox unread count; foreground refresh should reconcile the badge. OS launchers may render a dot instead of the numeric count.

### Hosted tunnel cannot connect

- Run `propr tunnel verify`; `/api/status` and `/socket.io/` must be reachable on `t-<id>.propr.dev`, while the proxy root returning `404` is expected.
- Confirm the page and service worker come from `app.propr.dev`, but notification capability/subscription requests go to the selected `t-<id>.propr.dev` API.
- After changing tunnel configuration, run `propr start --restart` so the API, worker, UI selection, CORS, and public URLs agree.
- If switching instances, disable Push before switching and re-enable it on the destination stack.

See [Troubleshooting](./troubleshooting.md#hosted-ui-tunnel-not-working) for full tunnel diagnostics.

## Release verification checklist

Use a test user and a real HTTPS staging origin. Repeat subscription and delivery on every supported target; a desktop result does not validate mobile installation behavior.

1. **Static PWA contract:** load `/manifest.webmanifest`; verify name, `start_url`, scope, display mode, and every icon returns `200`. Confirm the browser reports the app installable.
2. **Worker:** verify `/service-worker.js` is `200`, JavaScript (not HTML), uses the required cache header, registers at scope `/`, activates, and controls a reloaded page. Confirm `/config.js` is `no-store` and contains the expected API origin without secrets.
3. **VAPID capability:** run `propr check`; authenticated `GET /api/notifications/config` must report Push configured and return the expected public key. Confirm neither API responses nor logs contain the private key.
4. **Subscription creation:** press Enable from Settings, grant permission, and verify a browser Push subscription is created and `GET /api/notifications/push-subscriptions` lists an active subscription for that user/browser.
5. **Delivery:** enable one Push category, put the app in the background, trigger a real event in that category (for example a test task completion), and verify one visible notification arrives. Check API delivery logs/audit state for success.
6. **Deep link and actions:** click the notification body and each advertised action. Verify ProPR focuses or opens at the intended task, plan, pull request, or Inbox target, without an open redirect.
7. **Badge:** enable the badge preference, create unread notifications, and compare the displayed badge with the Inbox count (counts above 99 display as 99). Mark a notification read/dismiss it and verify the badge decreases or clears where supported.
8. **Recovery:** revoke permission and verify the denied guidance; re-allow and resubscribe. Revoke/unsubscribe a test endpoint and verify the UI can create a fresh subscription.
9. **Origin/tunnel:** for self-hosting, verify worker/manifest/config all come from the configured UI origin and calls target `API_PUBLIC_URL`. For hosted mode, verify PWA assets come only from `app.propr.dev`, calls target the selected `t-<id>.propr.dev`, and `propr tunnel verify` passes.

Record results for this minimum matrix:

| Target | Required checks |
|---|---|
| Chromium desktop (current Chrome and/or Edge) | Install, worker update, permission, subscription, delivery, deep link, badge where supported |
| Android (current Chrome) | Add/install PWA, background delivery, tap deep link/action, launcher badge behavior |
| iOS and iPadOS 16.4+ (current Safari/WebKit) | Share → Add to Home Screen, launch from icon, user-gesture permission, background delivery, deep link, badge behavior |
| Desktop Firefox | Worker, permission, subscription, delivery, deep link; record badge as unsupported if absent |
| Desktop Safari on current macOS | Install/add app as supported by that release, permission, delivery, deep link, badge behavior |

A release is not verified until manifest, worker, VAPID capability, subscription creation, delivery, deep linking, and badge-count behavior (or an explicitly recorded unsupported badge platform) have all been observed.
