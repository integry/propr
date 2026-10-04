---
title: Voice Briefings
---

# Voice Briefings

Voice Briefings give you a short, on-demand status snapshot while several tasks or plans are running. They are **experimental and off by default**; once you enable them in Settings, open **Voice briefing** from the Web UI and choose **Catch me up**. ProPR fetches the current state, displays the briefing as text, and, when the browser supports it, asks the browser or operating system to read that text aloud.

This is a **pull-based** workflow. Each briefing is a snapshot requested by the signed-in user, which makes it useful for checking parallel or long-running work without watching the dashboard. ProPR does not keep a telephone call, WebRTC session, speech session, polling loop, or background listener open while work runs. Request another briefing when you want a newer snapshot.

## Enabling Voice Briefings

Voice Briefings are **experimental and off by default in every runtime**: the browser
Web UI, the installed PWA, and the desktop app. Until a signed-in user turns them on
there is no launcher to open, the vendor-processing disclosure cannot be reached, no
`GET /api/voice/capabilities` or `GET /api/voice/briefing` request is issued, and no
speech-synthesis, speech-recognition, or microphone API is touched.

To turn them on, open **Settings** and enable **Voice briefings · Experimental**.
Administrators find it under **Integrations**; members find it in their personal
settings view. The launcher appears immediately, without reloading the page.

Enabling the option does not start audio or request microphone access. Turning it off
hides the entry points, aborts in-flight briefing requests, cancels active speech and
microphone checks, releases media tracks (including streams that arrive after
cancellation), clears pending confirmations, and rejects late results. An already
submitted, confirmed task action cannot be undone; turning the option off prevents its
follow-on voice refresh or playback.

The choice is stored locally on the device and scoped to the signed-in account and the
connected instance, so it is never shared across devices, browsers, accounts, or
instances. Switching accounts or instances loads that scope's own choice and cancels the
previous voice session. This is a client-side experience gate only: `/api/voice/capabilities`
and `/api/voice/briefing` remain authenticated read-only endpoints.

**After upgrading**, browser and installed-PWA users who previously had Voice Briefings
available must opt in once for each account, instance, and device. An existing voice
disclosure acknowledgement does not enable the feature. An existing desktop opt-in is
kept.

## Data flow, cost, and privacy

The server and browser have deliberately separate responsibilities:

1. The browser makes an authenticated `GET /api/voice/briefing` request for all work, running work, or work needing attention.
2. The ProPR server reads the current task, plan, and notification state and returns a bounded **text JSON** snapshot. This endpoint does not accept raw audio, and ProPR does not store recognition audio or the browser's recognition transcript.
3. The browser displays the text. If speech synthesis is available and the page is visible, the browser or operating system reads the supplied text aloud.
4. When the user explicitly chooses **Listen**, the browser performs one short speech-recognition attempt and gives the recognized text to the Web UI command parser.
5. A stop or follow-up command remains pending until the user confirms it. Only then does the Web UI send the action through the same authenticated task or plan API used by the corresponding visual control. For a task follow-up, the confirmed instruction is ordinary text sent through the normal task follow-up API.

ProPR therefore adds **no Twilio charge and no server TTS or voice-provider per-minute cost**. The MVP has no server voice provider and requires no voice environment variable. Hosting, network, device, browser, or vendor charges and terms may still apply independently.

Browser speech recognition is a browser/operating-system capability, not a ProPR-hosted service. Depending on the browser, device, configuration, and vendor, microphone audio **may be sent to and processed by the browser or operating-system vendor**. Do not assume recognition is local, offline, private from that vendor, or free of vendor processing. Review the applicable browser and OS privacy settings and policies before enabling microphone access.

Before its first recognition attempt, the Web UI shows this vendor-processing disclosure. A microphone request starts only after the user acknowledges it and selects **Listen**. ProPR never activates the microphone silently.

## Text Web Push is not voice playback

[Web Push](../operations/pwa-web-push.md) can deliver a text notification while an installed PWA is in the background. It does not carry briefing audio and does not make ProPR speak. Voice playback follows an explicit interaction or recognized command only while the Voice Briefing control is open and visible; it is never initiated by Push.

Moving the app into the background or locking the screen cancels active listening and playback. A completed task may produce a text Push notification, but it cannot cause background auto-play.

## Supported command grammar

Choose **Listen** for each single command. Recognition is not continuous. Commands may refer only to an item and action advertised by the latest briefing; a reference consists of `task`, `plan`, or `system` plus its displayed number. Digits and the spoken numbers one through ten are accepted.

| Intent | Supported phrases | Result |
| --- | --- | --- |
| Full briefing | `catch me up`, `give me a briefing`, `brief me` | Fetch all current briefing items. |
| Running work | `what is running`, `what's running`, `running status` | Fetch the running-work view. |
| Needs attention | `what needs attention`, `what requires attention`, `attention status` | Fetch the attention view. |
| Repeat | `repeat`, `repeat that`, `repeat the briefing`, `say that again` | Replay the latest briefing when speech synthesis is available. |
| Open | `open task 1`, `open plan one`, `open system 2` | Open the resolved, server-provided application link. This is not a mutation. |
| Stop | `stop task 1` (or another advertised numbered reference) | Stage a stop action and ask for confirmation. |
| Follow up | `follow up task 1 to rerun the tests` (or an advertised plan reference) | Stage the text instruction and ask for confirmation. |
| Decide pending action | `confirm`; `cancel` or `never mind` | Execute the one pending mutation, or discard it. |

A leading or trailing `please` is accepted. Follow-up text is limited to 1,000 characters and cannot contain a URL or API endpoint. Unknown, compound, out-of-range, ambiguous, and unadvertised commands are rejected rather than interpreted freely.

### Confirmation is mandatory for mutations

`stop` and `follow up` never mutate state from the initial transcript. ProPR shows and speaks a specific confirmation prompt, and the user must select **Confirm** or make a separate listening request and say `confirm`. Selecting **Cancel**, saying `cancel` or `never mind`, closing the panel, or sending another command does not execute the pending mutation. `open`, briefing, and repeat commands do not mutate server state and do not require confirmation.

The grammar is intentionally closed. Voice Briefings do **not** execute arbitrary shell commands, URLs, API requests, or free-form browser navigation.

## Platform limitations

Speech synthesis and recognition support varies by browser, OS version, language, permissions, policy, and PWA installation mode. The text briefing remains usable when either speech API is missing: unsupported playback leaves the text on screen, and unsupported recognition disables **Listen**. ProPR cannot make the platform grant microphone access or restore a permission the user denied.

Voice Briefings are not designed or supported for:

- background auto-play or speaking in response to a Push notification;
- listening while the app is backgrounded or the screen is locked;
- emergency paging, alarms, or any safety-critical notification path;
- arbitrary shell commands or open-ended voice-agent behavior; or
- silent, continuous, or remotely triggered microphone activation.

Use an external, purpose-built alerting system for emergencies and guaranteed paging.

## Desktop app

### The opt-in also gates the desktop app

The desktop app uses the same **Voice briefings · Experimental** opt-in as every
other runtime; see [Enabling Voice Briefings](#enabling-voice-briefings). Desktop
installations that had already acknowledged the voice disclosure are still off
until that explicit choice is made, and the choice is scoped to the signed-in
account, the selected instance, and this device. While the option is off, voice
entry points are hidden and the controller cannot request briefings, start
playback, or request microphone access.

### Microphone access in the desktop app

The desktop app does not run speech recognition: Electron does not provide the recognition service that Chrome and Edge
use. Desktop shows **Check microphone** instead, which only tests microphone access after a native **Allow microphone**
decision and immediately stops the stream. Nothing is recorded, transcribed or uploaded. Use **Listen** in a supported
browser for voice commands; text briefings work in both.

On macOS, ProPR also requests the operating system's microphone permission. If macOS has denied access, change the
Microphone permission in **System Settings → Privacy & Security** and restart ProPR.

Release-verification checklists and implementation notes live in the repository's
`docs/voice-and-push-release-verification.md`.
