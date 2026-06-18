---
title: Webhook pipeline
description: ''
---

The orchestrator's webhook processing pipeline turns inbound provider webhooks
into dispatched workflow runs. The pipeline is fully provider-agnostic — all
provider-specific operations (normalization, lock-file fetch, credential
minting) happen through the `ProviderRegistry` and its per-routing-key
`ProviderBundle` instances.

Entry point: `processWebhook()` in `packages/orchestrator/src/pipeline/process-webhook.ts` (re-exported from the sibling `processor.ts`, which holds the pipeline's shared helpers such as `resolveLockFileWithFallback`).

## Overview

```
request → dedup → provider normalize → extract repo/ref/credentials →
          trust resolution (PR only) → fetch lock file (with fallback) →
          trigger match → cache check → dispatch jobs → forward traces → metrics
```

Each step is a pure function called from `processWebhook()`; none of them
knows about the others. The pipeline is designed so a single entry point can
serve multiple providers (github, generic, internal) without any provider-
specific branching outside the bundles themselves.

## Pipeline steps

1. **Dedup check** — `DedupCache` rejects duplicate delivery IDs within the TTL window.
2. **Provider bundle resolution** — `providerRegistry.getByRoutingKey(info.routingKey)` maps the inbound routing key to the correct `ProviderBundle`.
3. **Event normalization** — `bundle.normalizer.normalizeEvent(...)` turns the provider-native payload into a `SimulatedEvent` (push, pull_request, …).
4. **Extract repo/ref/credentials** — `bundle.normalizer.extractRepoIdentifier`, `extractRef`, `extractCredentials`.
5. **Lock-file fetch** — via the multi-provider fallback resolver (see below).
6. **Trigger match** — `matchAllWorkflows(lockFile.workflows, event, changedFiles)` against the resolved lock file.
7. **Dispatch** — `dispatcher.dispatch(...)` routes each matched job to an agent or queue.
8. **Decision trace** — the orchestrator forwards the decision trace upstream to KiCI for dashboard visibility.
9. **Metrics** — `webhooksProcessedTotal`, `triggerMatchDurationSeconds`, etc.

## Multi-provider lock-file fallback

**Source:** `resolveLockFileWithFallback()` in `packages/orchestrator/src/pipeline/processor.ts`.

### Resolver behavior

The lock-file resolver tries the inbound webhook's provider bundle first.
When the inbound fetcher returns `null` (the repo is not present on the
inbound provider's side — typical for internal-sourced webhooks targeting
repos whose lock files live on a github provider in the same customer), the
resolver falls back to the lock-file fetchers of OTHER provider bundles
registered for the SAME customer's registrations of the SAME repo. On the
first non-null result it stops and returns the lock file. On exhaustion it
returns `null` so the `Lock file not found` branch runs (global workflow
matching, then no-op).

### Security model

Tenant isolation is structural, not procedural:

- The fallback iterates ONLY registrations returned by
  `registrationIndex.getByOrgAndRepo(customerId, repoIdentifier)`.
- That index is keyed by `${customerId}|${repoIdentifier}`. A customer B
  registration for the same `repoIdentifier` will NEVER be returned when we
  pass `customerId = 'custA'`. Cross-tenant leakage is impossible by
  construction — there is no path through the fallback that reaches a
  different customer's registration set.
- The fallback is additionally gated on `customerId !== '__default__'` so
  the global default bucket cannot accidentally serve as a cross-tenant
  staging area.
- The inbound routing key is excluded from the fallback set, preventing
  self-recursion (the same fetcher is never called twice within one webhook
  processing cycle).
- The fallback dedupes by `routingKey` so a repo with many registered
  workflows under the same source only triggers one fallback fetch.

### Ordering

Registrations are consulted in the order returned by `getByOrgAndRepo`, which
preserves insertion order (effectively `createdAt` ascending). The first
non-null lock file wins. This is deterministic; operators can predict which
bundle will serve a given webhook by inspecting the registration list.

### Credentials

Each fallback fetcher is invoked with the REGISTRATION's `providerContext`,
NOT the inbound normalizer's credentials. This is load-bearing:

- `LocalWebhookNormalizer.extractCredentials()` returns `{}`.
- `GitHubLockFileFetcher.fetchLockFile()` requires `installationId` in
  credentials and would fail on `{}`.
- The registration stores the `providerContext` from the time it was
  created, which includes the credentials its owning provider needs.

The implementation looks up the matching registration by `routingKey` and
passes `registration.providerContext` directly into `lockFileCache.get(...)`.

### Cache interaction

The shared `LockFileCache` is provider-agnostic — the cache key is
`${repoIdentifier}:${ref}`, not scoped by fetcher. This means:

- If a prior real GitHub push webhook has already populated the cache for
  `(<owner>/<repo>, <sha>)`, the fallback's call to the
  github fetcher hits the cache immediately — zero network cost.
- If the cache is cold, the fallback makes a single github API call, then
  all subsequent webhooks for the same ref hit the cache.

### Cross-provider dispatch (clone URL + clone token)

When `resolveLockFileWithFallback` resolves a lock file via a fallback
bundle, the dispatch site must use THAT bundle's `repoUrlBuilder` and
`cloneTokenProvider` — not the inbound bundle's. Without this swap, an
internal-sourced webhook resolved via a github fallback would pass
`file://` clone URLs to the agent, which fail inside container agents where
the local filesystem path does not exist.

**What is swapped at the dispatch site:**

- `bundle.repoUrlBuilder` → `fallbackBundle.repoUrlBuilder` (clone URLs)
- `credentials` → `fallbackCredentials` (the registration's
  `providerContext`, carrying `installationId` etc.)
- `effectiveRoutingKey` → `fallbackRoutingKey`
- `effectiveProvider` → `fallbackBundle.normalizer.provider`

**What is NOT swapped:**

- `changedFilesFetcher` — inbound concern (changed files detection is
  normalized from the inbound payload, not the fallback provider)
- `checkStatusPoster` — inbound context (check runs belong to the provider
  that received the original webhook)
- Registration extraction (`replaceAll`) — event-driven, uses inbound
  `bundle` and `credentials`

This mirrors the bundle-swap pattern used by cross-source dispatch in
`process-webhook.ts` (Phase B), applied to the fallback resolution path. The principle:
"the bundle that knows about the repo provides the clone credentials."

**Return type extension:** `resolveLockFileWithFallback` now returns
`fallbackBundle` (the winning `ProviderBundle`) and `fallbackCredentials`
(the registration's `providerContext` cast to `Record<string, unknown>`)
alongside the existing `fallbackRoutingKey`. These are `undefined` when
the lock file was resolved via the inbound path or not at all.

### Observability

The resolver emits structured log markers operators can grep for:

- `Lock file resolved via fallback provider bundle` (info) — on success.
  Includes `deliveryId`, `inboundRoutingKey`, `fallbackRoutingKey`,
  `repoIdentifier`, `ref`, `attemptedFallbacks`.
- `Cross-provider dispatch: using fallback bundle for clone URL + token`
  (info) — emitted at the dispatch site when the bundle swap activates.
  Includes `deliveryId`, `inboundRoutingKey`, `fallbackRoutingKey`,
  `repoIdentifier`.
- `Multi-provider fallback exhausted without resolving lock file` (info) —
  on miss after all fallbacks tried. Includes `attemptedFallbacks` count.
- `Multi-provider fallback: no same-customer registrations for repo` (info)
  — when the registration index returns nothing for the tenant.
- `Multi-provider fallback: fetcher threw, continuing` (warn) — when a
  fallback fetcher throws; processing continues with the next fallback.

Staging deploys should look for both success markers during the
`stg-ha-smoke` failover-dispatch test window — the fallback resolution
marker and the dispatch bundle swap marker together confirm the full
cross-provider pipeline is live. See `docs/internal/staging-deployment.md`
for deploy-time verification steps.

### Tests

Unit coverage in `packages/orchestrator/src/pipeline/processor.test.ts`
covers the multi-provider lock-file fallback:

1. **Success-first** — inbound succeeds → fallback not consulted.
2. **Fallback success** — inbound returns null → github fetcher called with
   the registration's `providerContext`, lock file resolved, trigger match
   fires, dispatch happens.
3. **Exhaustion** — inbound null, two fallback registrations both return
   null → existing no-lock-file path runs, no crash, zero dispatches.
4. **Strict tenant boundary** — customer A webhook, customer B has a
   matching-repo registration; fallback NEVER calls customer B's fetcher;
   `getByOrgAndRepo` is only called with `custA`.
5. **Dedupe by routingKey** — two same-tenant registrations sharing one
   routingKey → fallback fetcher called exactly once.
6. **No self-recursion** — inbound `github:42`, registration also
   `github:42` → fetcher called exactly once total (inbound only; excluded
   from fallback set).
7. **Inbound repoUrl regression** — inbound succeeds → dispatched
   job's `repoUrl` is the inbound bundle's `file://` URL, `providerContext`
   is the inbound `{}`. Regression guard for the bundle swap.
8. **Fallback repoUrl + credentials** — inbound null, fallback fires
   → dispatched job's `repoUrl` starts with `https://github.com/`,
   `providerContext` is the registration's `{installationId: 12345}`.
9. **No repoUrlBuilder fallback** — fallback bundle has
   `lockFileFetcher` but no `repoUrlBuilder` → dispatched job's `repoUrl`
   is `''` (graceful degradation, no crash).

E2E coverage via `e2e/tests/stg-ha-smoke.test.ts` failover-dispatch test
which proves the end-to-end flow against deployed staging: real push webhook
→ internal ingress → fallback resolves lock file via github bundle → trigger
match → dispatch through coord B with `https://github.com/` clone URL →
agent clones successfully → `scalerContext.scalerName.endsWith('-b')` →
run reaches terminal `completed`.
