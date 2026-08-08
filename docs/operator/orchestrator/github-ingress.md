---
title: Direct GitHub webhook ingress
description: Expose your orchestrator's GitHub-App webhook ingress so GitHub delivers events directly, bypassing the hosted Platform relay.
---

By default a GitHub-App webhook travels GitHub → the hosted KiCI Platform → the
WebSocket relay → your orchestrator. The orchestrator already verifies the
signature, deduplicates the delivery, matches triggers, and dispatches the job
locally — the Platform is only relaying bytes. If you would rather not depend on
the Platform for the one step that must never miss a push, you can point GitHub
directly at your orchestrator.

This page covers exposing that ingress, the two delivery topologies, the
clustered-ingress topology, and the quota-free proposition. For what keeps
working when the Platform is offline, see [Platform-down
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
ingress is reachable (for example `https://ci.example.com`). With it set, the
CLI prints the exact ingress URL for this source:

```
https://ci.example.com/webhook/<org>/github/<source-id>
```

That is the receiving endpoint. Paste it into GitHub as described below. Without
`KICI_WEBHOOK_PUBLIC_URL`, the CLI cannot print a URL and tells you to set it.

## Topology 1 — App-level repoint (full bypass)

Point the GitHub App's single **Webhook URL** (App settings → General → Webhook)
at the printed `…/webhook/<org>/github/<source-id>` URL. GitHub now delivers
every event for every installation directly to your orchestrator, and the hosted
Platform never sees the event.

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

A classic per-repo webhook does not carry the App installation-target headers;
the source id in the URL already identifies the source, so the orchestrator
skips the App-header check for those deliveries.

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

## Quota-free

Direct-ingress events are not counted against the hosted Platform's
webhook-event quota. Self-hosting your orchestrator and opening this ingress is
exactly how you opt out of the webhook-quota fee — the events never reach the
Platform, so there is nothing to meter.

## Advanced: pointing the App at a custom URL

If you use the App-manifest setup flow and want the generated App to bake in a
specific webhook URL up front, the `--webhook-url` flag on `kici-admin source
add github` writes that URL into the App verbatim. That flag only sets where
GitHub sends events; this page is what makes your orchestrator receive them. Use
both together when you want a custom hostname in front of this ingress.
