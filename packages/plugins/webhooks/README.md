# Outbound webhooks

Sends ProPR events as signed JSON `POST` requests to any HTTPS endpoint. It is
the generic integration for services without a plugin of their own.

- **Events:** pull request opened, review scored, Ultrafix ended, pull request
  merged or closed, task queued, started, completed, failed or cancelled, and
  epic queue blocked or completed.
- **Targets:** up to three. Each has a URL, the events it receives and an
  optional repository filter.
- **Signature:** every request carries `X-ProPR-Signature: sha256=<hex>`, the
  HMAC-SHA256 of `<X-ProPR-Timestamp>.<body>` keyed with the target's signing
  secret. ProPR signs the request, so the handler never sees the secret.
- **Envelope:** a versioned JSON object of identifiers, links, states and
  scores. It never contains code, logs, prompt text, tool output or
  credentials.

The envelope reference, the signature algorithm with a test vector, and the
retry rules are in [`docs/docs/plugins/webhooks.md`](../../../docs/docs/plugins/webhooks.md).

## Setup

1. Open **Plugins**, choose **Outbound webhooks**, and install it (permission:
   `events.read`).
2. In **Settings**, set **Target 1 URL** to an `https://` endpoint on a public
   host, for example `https://hooks.example.com/propr`. Optionally set targets
   2 and 3.
3. For each target, keep or narrow its **events**, and optionally list
   **repositories** (`owner/repo`). An empty list means every repository the
   plugin is enabled for.
4. Under **Connections**, set the **signing secret** of each target you use: a
   random value of at least 32 characters (`openssl rand -hex 32`), also
   configured on the receiving endpoint. A target without a secret receives
   nothing.
5. Optionally limit the plugin to repositories, then **Enable** it.

The plugin's allowed hosts are the hosts of the saved target URLs
(`outboundHostsFromSettings` in `manifest.json`). A URL with plain HTTP, an IP
address, a local name, or a host that resolves to a private address is refused
when you save it.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | Settings (three target slots), signing secret connections, subscriptions and `outboundHostsFromSettings`. |
| `handlers.ts` | `deliver`: builds the envelope and sends one signed request per matching target. |
| `../_shared/eventSelection.ts` | Event and repository selection, shared with other forwarding plugins. |
| `../test/webhooks.test.ts` | Handler tests with the plugin test kit. |

## Manual smoke test

Use a request inspector you control, for example a small HTTPS server of your
own or a public request bin.

- [ ] Saving `http://…`, `https://10.0.0.1/…` or `https://localhost/…` as
      **Target 1 URL** is refused with a message on the field.
- [ ] Saving the inspector's `https://` URL succeeds. The plugin's detail shows
      that it sends requests to the hosts of its target URL settings.
- [ ] Set **Target 1 signing secret**, enable the plugin, and open a pull request
      in an enabled repository. One `POST` arrives with `X-ProPR-Event:
      pull_request.opened`.
- [ ] Recompute `sha256=` + hex(HMAC-SHA256(secret, timestamp + "." + body))
      for that request. It equals `X-ProPR-Signature`.
- [ ] The body has `"version": 1`, the repository and pull request links, and
      no code, logs, prompt text or secrets.
- [ ] Deselect `pull_request.opened` for target 1 and open another pull request.
      Nothing arrives.
- [ ] Set **Target 1 repositories** to another repository. Events of this
      repository no longer arrive.
- [ ] Make the inspector answer `429` with `Retry-After: 120`. The delivery in
      **Activity** is *retrying* with the next attempt about 2 minutes later,
      and arrives again with the same `X-ProPR-Delivery`.
- [ ] Make the inspector answer `410`. The delivery is *failed* at once, with a
      message naming the target and the status.
- [ ] Clear **Target 1 signing secret**. The next delivery is *failed* with a
      message about the signing secret, and nothing reaches the inspector.
