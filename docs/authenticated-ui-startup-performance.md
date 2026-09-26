# Authenticated UI startup performance

Issue #2409 measured the shared `/tasks` startup path in the production Vite
build with headless Chromium at 1280 × 800. Both variants use the same UI:

- `web` loads the normal browser presentation.
- `desktop` installs the desktop adapter bridge, restores one authenticated
  profile, completes its connection probe, and then loads the shared route.

The fixture adds deterministic response waits of 180 ms for
`/api/auth/demo-mode`, 220 ms for `/api/auth/user`, 160 ms for the selected
route chunk, and 240 ms for `/api/tasks`. Its `Server-Timing` headers identify
60, 80, and 100 ms respectively as server work for the mocked API responses;
the browser resource entries report response wait and transfer separately.
The measurement starts before navigation and stops when a real task row is
visible. It also reports the time from authenticated-shell readiness to the
first useful-data request, and from the last useful-data response to render.

## Result

Before this change the source and browser trace had this serial order:

```text
demo-mode (180) -> current-user (220) -> route chunk (160) -> tasks (240)
```

The injected part of the critical path was therefore 800 ms. The baseline
production build rendered the useful row at a median 1,401 ms across three web
runs and at 1,406 ms in the desktop harness. One demo-mode request, one
current-user request, one route chunk request, and three existing task-list
consumers were observed; this change does not add an API request or polling.

After this change the first three independent stages overlap:

```text
max(demo-mode 180, current-user 220, route chunk 160) -> tasks (240)
```

The deterministic injected critical path is 460 ms, a reduction of 340 ms
(42.5%). A representative post-change run rendered the useful row at 1,044 ms
on web and 1,034 ms in the desktop harness. The critical request counts were
unchanged. Current-user completion still gates authenticated rendering and
socket activation; route preloading fetches JavaScript only and cannot start
page data reads.

## Reproduce

From the repository root:

```sh
npm run measure:startup --workspace=propr-ui
```

The command builds the production bundle and prints one
`STARTUP_MEASUREMENT` JSON record per runtime. It also attaches the same record
to the Playwright result. Request-order assertions make the measurement fail
if demo mode, current-user validation, and selected-route discovery become
serial again.

## Remaining bottleneck and limitations

In the representative post-change run, useful data did not start until roughly
340 ms after the three explicitly delayed bootstrap stages had completed. That
interval includes loading and parsing transitive route dependencies, React
provider/layout work, and effect scheduling; it is the next concrete browser
bottleneck to profile. The final data-to-row render interval was about 65–66
ms. These figures come from a local deterministic harness, not a remote host,
and must not be interpreted as production network or backend latency. Real
server time is only available when an endpoint emits `Server-Timing`; otherwise
the resource trace can separate response wait from transfer but cannot divide
network latency from server execution. Playwright applies the static route-chunk
delay before continuing its network request, so that 160 ms is present in the
harness stage timing but intentionally absent from Chromium's resource TTFB.
