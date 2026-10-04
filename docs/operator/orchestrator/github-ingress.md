---
title: Direct GitHub webhook ingress
description: Expose your orchestrator's GitHub-App webhook ingress so GitHub delivers events directly, bypassing the hosted Platform relay.
---

A GitHub-App webhook travels GitHub → the hosted KiCI Platform → the WebSocket
relay → your orchestrator. The orchestrator already verifies the signature,
deduplicates the delivery, matches triggers, and dispatches the job locally — the
Platform is only relaying bytes. If you would rather not depend on the Platform
for the one step that must never miss a push, point GitHub directly at your
orchestrator.

`hybrid`, `independent` and `observed` orchestrators serve both direct GitHub
routes: the org-scoped `/webhook/<org>/github` and the per-source
`/webhook/<org>/github/<source-id>`. `kici-admin orchestrator install` writes
`KICI_MODE=hybrid`, so a fresh orchestrator already serves them. Two steps turn
them into a live delivery path: set `KICI_WEBHOOK_PUBLIC_URL` to the public base
at which the routes are reachable, then point GitHub at the URL the CLI prints.

This page covers exposing that ingress, the two delivery topologies, the
clustered-ingress topology, and why direct-ingress webhooks are not metered. For
what keeps working when the Platform is offline, see [Platform-down
behavior](./platform-down-behavior.md).

## Configure a local GitHub source

Register the GitHub App with your orchestrator (its App id, private key, and
webhook secret) using the admin CLI:

```bash
kici-admin source add github \
  --name my-app \
  --app-id 123456 \
  --private-key @/path/to/app-private-key.pem \
  --webhook-secret "$WEBHOOK_SECRET"
```

Set `KICI_WEBHOOK_PUBLIC_URL` to the public base at which your orchestrator's
ingress is reachable (for example `https://ci.example.com`). The install stub
carries the variable commented out, so uncomment it and restart. With it set,
`kici-admin source list` prints the exact ingress URL under each GitHub source
(`ingress: …`). In `observed` and `independent` mode, `source add` prints it
too:

```
https://ci.example.com/webhook/<org>/github/<source-id>
```

That is the per-source receiving endpoint. Paste it into GitHub as described
below. Without `KICI_WEBHOOK_PUBLIC_URL`, the CLI cannot print a URL and tells
you to set it.

## Topology 1 — App-level repoint (full bypass)

Point the GitHub App's single **Webhook URL** (App settings → General → Webhook)
at one of the orchestrator's GitHub URLs. GitHub now delivers every event for
every installation directly to your orchestrator, and the hosted Platform never
sees the event. Either URL works for an App:

- **The org-scoped URL**, `<base>/webhook/<org>/github`. The orchestrator finds
  the source from the App's installation-target headers. This URL exists before
  the App does, so the manifest flow bakes it into a new App in `observed` and
  `independent` mode.
- **The per-source URL**, `<base>/webhook/<org>/github/<source-id>`, which
  `kici-admin source list` prints.

GitHub sends the App installation-target headers
(`X-GitHub-Hook-Installation-Target-Type: integration` and
`-Target-ID: <app-id>`) with each delivery; the orchestrator validates them
against the source before accepting.

## Topology 2 — per-repo classic webhook (hybrid)

Keep the App pointed at the Platform and add a **repository-level** webhook
(repo Settings → Webhooks → Add webhook) pointing at the same ingress URL, with
the same secret and `application/json` content type. GitHub then delivers to
both destinations. The orchestrator deduplicates the two copies by their shared
`X-GitHub-Delivery` id, so exactly one job is dispatched. Because GitHub delivers
directly to your orchestrator as well as through the Platform, a Platform outage
never drops a build trigger — the direct copy still arrives and dispatches the
job. This is the reliability reason to run hybrid mode. For the full picture of
what the Platform still provides, see
[What requires the hosted Platform](./platform-capabilities.md).

A classic per-repo webhook does not carry the App installation-target headers,
so it must use the per-source URL. The source id in the URL identifies the
source, and the orchestrator skips the App-header check for those deliveries.
The org-scoped URL answers 400 to a delivery without App headers.

## An App still pointed at the hosted Platform

An `observed` orchestrator never receives relayed deliveries. When its GitHub
App still points at the hosted Platform, the Platform answers each delivery with
409 `OBSERVE_ONLY_SOURCE`. GitHub shows the 409 under the App's _Advanced →
Recent Deliveries_. To fix it, set the App's webhook URL to the URL
`kici-admin source list` prints for the source, or to the org-scoped
`<base>/webhook/<org>/github`.

## Cluster ingress

When you run more than one orchestrator instance against one shared PostgreSQL
database, the direct ingress is a first-class clustered path:

- **Every instance serves the ingress route.** Put an external load balancer or
  DNS record in front of the cluster and point GitHub at it; a delivery may land
  on any healthy instance.
- The instance that receives the delivery becomes the run coordinator. Jobs are
  enqueued in the shared dispatch queue and any agent on any instance claims
  them; the orchestrator-to-orchestrator peer mesh handles capacity-based
  rerouting. None of this touches the Platform.
- Deliveries are deduplicated cluster-wide by an atomic claim on the shared
  database, so a load balancer that retries a delivery — or GitHub's own retry —
  cannot cause two instances to dispatch the same push.

## Exposure requirements

- Public HTTPS with a valid TLS certificate.
- A reverse proxy that forwards the **raw request body** and the
  `X-Hub-Signature-256` and `X-GitHub-*` headers unmodified. Signature
  verification is a byte-exact HMAC over the body, so any rewriting of the body
  (re-encoding, whitespace changes) or dropping of those headers breaks
  verification.
- GitHub caps webhook payloads at 25 MB; the ingress accepts up to that size.

## Direct-ingress webhooks are not metered

Direct-ingress events are not counted against the hosted Platform's
relayed-webhook quota. Self-hosting your orchestrator and opening this ingress is
exactly how you opt out of the webhook-quota fee — the events never reach the
Platform, so there is nothing to meter.

This exemption covers the relayed-webhook quota alone. If you also run the hosted
Platform (`hybrid` mode), every other plan dimension applies as usual — see
[platform-down
behavior](./platform-down-behavior.md#the-independence-boundary). `observed` mode
serves this ingress too and keeps the hosted dashboard without the relay — see
[what requires the hosted Platform](./platform-capabilities.md).

## Advanced: pointing the App at a custom URL

If you use the App-manifest setup flow and want the generated App to bake in a
specific webhook URL up front, the `--webhook-url` flag on `kici-admin source
add github` writes that URL into the App verbatim. That flag only sets where
GitHub sends events; this page is what makes your orchestrator receive them. Use
both together when you want a custom hostname in front of this ingress.
