# Voice briefings and Web Push: release verification and engineering notes

Release-verification checklists and diagnosis records moved out of the user guides
[Voice briefings](docs/features/voice-briefings.md) and
[PWA, Web Push, and Badges](docs/operations/pwa-web-push.md) for 0.9.0. Content is preserved as written;
anchors such as `#enabling-voice-briefings` refer to the voice briefings guide.

# Voice briefings

## Manual release verification checklist

Use a test account and non-sensitive spoken phrases on a real HTTPS staging origin. Browser emulation alone does not validate a physical device's microphone, speech service, background lifecycle, or PWA behavior. Record the browser and OS versions and whether synthesis and recognition are supported.

### Desktop browser

1. In a fresh browser profile, verify that no **Voice briefing** launcher is rendered and
   that no `/api/voice/capabilities` or `/api/voice/briefing` request is issued. Enable
   **Voice briefings · Experimental** in Settings, verify the launcher appears without a
   reload, and verify that it survives a full page reload.
2. Open **Voice briefing**, verify the vendor-processing disclosure appears before the first recognition attempt, and verify that no microphone prompt appears until **I understand** and then **Listen** are selected.
3. Select **Catch me up**. Verify one `GET /api/voice/briefing?scope=all` returns JSON, the same briefing is visible as text, and supported speech playback starts only from that user action.
4. Select **Listen**, grant microphone permission, and exercise a briefing command, a numbered `open` command, and `repeat`.
5. Stage `stop task N` or `follow up task N to ...`. Verify no mutation request occurs before a separate **Confirm action** selection or recognized `confirm`; verify `cancel` leaves state unchanged. After confirmation, verify a text request uses the normal task or plan API and no request contains raw audio.
6. Deny microphone permission in a fresh browser profile. Verify the UI reports that access was not allowed, still provides the text briefing, and does not repeatedly or silently prompt.
7. Test a browser without `SpeechRecognition`/`webkitSpeechRecognition`. Verify **Listen** is disabled with unsupported guidance and **Catch me up** still provides the text fallback.
8. Start playback and then start recognition in separate attempts; background the tab during each. Verify playback/listening is cancelled, does not resume automatically, and no action is executed.

### Android installed PWA

1. Install ProPR from a current supported Android browser, launch the installed PWA, and repeat the disclosure, granted-permission, denied-permission, and unsupported-recognition checks that the selected browser/device permits.
2. Request a briefing and verify the visible text remains the source of truth whether or not the device speaks it.
3. Stage and cancel one mutation, then stage and confirm one mutation. Verify both require the explicit second step.
4. While playback is active and, separately, while listening is active, switch apps and lock the screen. Verify both interactions cancel and do not restart when the PWA returns to the foreground.
5. Trigger a task-completion Web Push while the PWA is backgrounded. Verify it is a text notification and does not auto-play a voice briefing.

### iOS/iPadOS Home Screen app

1. In Safari, add ProPR with **Share → Add to Home Screen**, then launch it from the Home Screen icon. Record unsupported synthesis or recognition as an expected platform capability result rather than treating the text briefing as failed.
2. Verify **Catch me up** shows text after a user action. Where recognition is available, verify disclosure and **Listen** precede the OS microphone prompt; test both allowed and denied permission states.
3. Stage and cancel one mutation, then stage and confirm one mutation. Verify no stop or follow-up request is sent before confirmation.
4. Start any supported playback/listening interaction, go Home, and lock the screen. Verify it cancels and does not resume or execute an action when the app is reopened.
5. Deliver a Web Push while the Home Screen app is closed or backgrounded. Verify the notification is text-only and that opening it does not start voice playback without a new user request.

A release is not verified until the matrix includes a denied microphone permission result, an unsupported-recognition result, background cancellation, and confirmation gating for a mutating command, in addition to the successful text briefing path.

## Desktop diagnosis and consent (#2264, #2260; epic #1970)

The reported Linux runtime pin `6b8ebe96c61e70238041c6366cf89463a5570a1d`
precedes the voice backend: its `packages/api/server.ts` does not register either
voice route and its source tree has no `packages/api/routes/voiceRoutes.ts`.
The reported newer desktop revision `03f78868` registers both authenticated
`GET /api/voice/capabilities` and `GET /api/voice/briefing` routes. Updating the
desktop renderer alone cannot add those endpoints to an already running server.
The implementation must target `1950-epic-cross-platform-dsk`.

`apiFetch` resolves relative paths through the active `ProprClient`, and the
desktop credential boundary attaches credentials for that selected instance.
The initially empty API base therefore does **not** cause requests to go to the
renderer origin. Voice requests now always use relative API paths; this also
avoids retaining a nonempty base URL from an earlier instance. Regression tests
cover activation, profile switching, and the desktop transport scope header.
A missing voice endpoint produces `VOICE_BACKEND_UNAVAILABLE`, without falling
back to another origin, resetting credentials, or inventing briefing data.

For the affected installation, inspect the selected instance's network responses
for both voice GET routes and the running runtime image/revision. An authenticated
JSON capabilities response establishes route availability; a 401/403 requires
resolving authentication/authorization, while a 404 from the reported older build
requires updating that **server runtime** to a voice-enabled desktop-epic build
and reconnecting. Preserve the existing data and credentials. This change does
not deploy or replace that runtime. Source revisions were checked during this
fix; no live user instance endpoint was available to independently inspect its
currently deployed responses.

### Desktop microphone check: implementation and validation evidence

Standard Electron exposes a Web Speech constructor without supplying the
proprietary recognition service available in Chrome/Edge. Electron maintainers
[confirm this limitation](https://github.com/electron/electron/issues/46143#issuecomment-3166676214),
and Electron 44's
[local recognition context is unimplemented](https://github.com/electron/electron/blob/v44.0.0/shell/browser/electron_speech_recognition_manager_delegate.cc).
API presence is not evidence of working packaged recognition. Desktop therefore
shows **Check microphone**, explicitly describing it as an access test, and does
not invoke Web Speech recognition. Browser **Listen** retains its existing
user-initiated recognition flow. `service-not-allowed` is a speech-service failure,
separate from `not-allowed` / an OS microphone denial.

On Linux and macOS desktop, the check requires a live user gesture in the isolated preload and a
native **Allow microphone** decision (default/escape is **Deny**). It opens an
audio-only stream after approval and immediately stops every track. No recorder,
transcription provider, upload, or background listener is created. Access is
restricted to the live trusted main renderer, top frame, and active connection;
null/foreign web contents, subframes, approval windows, camera/mixed/unknown media,
and other permissions remain denied. On macOS, after the native choice, ProPR
also [requests the operating system's microphone permission](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos). Packaged builds
include the microphone usage description; the existing Electron signing defaults
include audio-input entitlement. If macOS has denied access, change the Microphone
permission in System Settings and restart ProPR. Cancelling invalidates the check
even if the OS prompt remains open; a late OS approval cannot open a stream.
The grant is temporary, ends on completion
or cancellation, and expires after 30 seconds. Navigation, renderer destruction,
crash, connection invalidation, and shutdown prevent grant reuse. Cancellation
also ignores a late native approval and releases a late device stream.

Safe options today are desktop text briefings and voice commands in a supported
browser with the existing vendor-processing disclosure. A future desktop
implementation could bundle an explicitly selected local transcription engine
and model after reviewing resource, licensing, packaging, and privacy requirements.
Adding a paid/cloud provider or forwarding raw audio requires separate approval;
this fix adds neither. Physical microphone and native OS prompts still require
release verification on the packaged target device; mocked tests do not establish
that hardware or a speech service works.

An isolated Linux Electron 44.0.0 check also exercised the actual preload and
session-security handlers on a secure `propr-app://renderer` page, with synthetic
media and an injected native consent decision. Results: microphone denied before
consent; request without a user gesture rejected; one approved request opened
and stopped audio; mixed camera/audio denied; microphone denied after revocation.
This is runtime permission-boundary evidence, not a packaged physical-device or
native-dialog acceptance result. A separate synthetic Web Speech probe exposed
the constructor but failed with `audio-capture`; virtual audio cannot validate
recognition service availability. The unsupported desktop decision relies on
the Electron implementation and maintainer explanation linked above.

Follow-up validation used the real Settings and voice components in Chromium:
default off, keyboard opt-in, full-reload persistence, opt-out, and backend-404
fallback passed. The browser reported microphone permission `prompt`, no audio
input devices, and `NotFoundError` on a real microphone request. No permission
was granted or bypassed and no synthetic device was supplied. The agent image
has no Electron executable or display server for native-dialog verification.

Follow-up validation in the Linux agent environment cannot establish physical
microphone capture, macOS TCC prompt behavior, signed-package microphone access,
or audible speaker output. Verify these on Linux and macOS devices with an
explicit Settings opt-in and real native/OS consent. No server deployment or
worker restart is part of this change.

# PWA and Web Push

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
