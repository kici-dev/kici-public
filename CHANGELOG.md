# Changelog

Release notes for the public KiCI packages.

## v0.9.1 — 2026-09-22

### Fixes

- Orchestrator, Platform and agent HTTP listeners keep an idle keep-alive connection open for 130 s so a reverse proxy (Caddy, nginx, a load balancer) never sends a request into a socket the server is closing; that race answered 502 to a GitHub push webhook, which providers do not redeliver
- Archived access-log, audit-log and event-log pages read newest-first and stop once the page is full, fetch manifests and chunks up to 16 at a time, and cache manifests in-process; a filtered page over a long archive took 34 s on staging and timed out the kici-admin CLI

## v0.9.0 — 2026-09-21

### Features

- Breaking: the SDK root barrel no longer exports runtime internals (use @kici-dev/sdk/internal), buildAgentCloudInit accepts only claim-code credentials, the lock-file inline-expression value shape is no longer parsed, ContributorResolver and getAccessCacheInvalidations are removed from @kici-dev/engine, and the trust tier vocabulary is trusted | unknown
- Breaking: the wire protocol is now version 3 and the floor equals it. Every 0.8.x (and older) orchestrator, agent and peer sends version 2 and is refused at connect with WS_CLOSE_PROTOCOL_ERROR, so both tiers of a deployment — the orchestrator and its agents and peers — must move to 0.9.0 together. Removed from the wire with it: the Platform-rooted identity mint (`oidc.mint.*` RPC and the `oidcMint` Platform capability — the orchestrator's own signing key mints every token, including the deferred re-mint, so `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` is required for provenance; the hybrid local dev plane configures it automatically), the job-dispatch and peer-reroute `sourceTarHash` field (`sourceTarDigest` is the only digest), `artifacts.upload.complete` `storageKey` and `sizeBytes`, the `scalerCapacity[].mandatoryLabels` union (`labelSetMandatoryLabels` is required), the trust-policy `unknownContributorPolicy` / `workflowChangePolicy` arms and the `enforcement` field, the `forkPolicy: reject` value, the global-workflows `elevatedRepos` list, boolean dashboard-write policy values (`permissive` / `encrypted` / `disabled` only) and the `KICI_OIDC_LEGACY_PR_SUB` escape hatch. The `artifacts.upload.complete`, `trust_policy.update` policy, `scalerCapacity[]` and global-workflow settings objects are now strict, so a stale sender is refused rather than silently ignored. The Platform JWKS stays published, so bundles it signed earlier keep verifying.
- Breaking: kici-admin drops join --config (the join writes only ./kici-orchestrator.env), secret scopes --all-backends (every registered backend is listed by default, qualified as <backend>:<path>), cluster-settings --contributor-cache-ttl-ms, org-settings global-workflows elevate-add / elevate-remove (the orchestrator admin API no longer reads or writes elevatedRepos), context --minimum-trust known (only trusted or null), and KICI_CONTRIBUTOR_CACHE_TTL_MS
- Breaking: the orchestrator admin PATCH /api/v1/admin/cluster-settings body is strict — an unknown field, including the removed contributorCacheTtlMs, is refused with a 400 instead of being dropped
- Breaking: the per-member CI trust override route and its Members-tab clear control are removed — a member's CI trust level comes from their roles alone; the webhook test-ping response no longer carries the success alias of delivered; the dashboard no longer reports a separate approver level
- Breaking: the orchestrator and Platform migrations drop the columns behind removed features — the per-member CI trust override, the global-workflows elevated-repo list, the contributor-cache TTL, the two non-fork trust-policy arms and the dispatch-queue source tar hash — and rewrite stored legacy values: a run's trust tier known becomes unknown, a fork policy reject becomes ignore, and a context floor of known is cleared
- Breaking: objects under the pre-0.6 cache layouts are no longer read; kici-admin cache purge-legacy removes them
- The hosted plan catalogue (tiers, prices, limits) is served publicly at GET /api/v1/billing/plans, and the enforced tier limits are built from one plans.yaml source.
- kici feedback --draft <file> builds the prefilled agent-report issue-form URL from a JSON draft, so an agent can hand a person a report to review and file

### Fixes

- A stored trust tier or context floor that predates the current vocabulary is read fail-closed: an unrecognized run tier inherits as unknown and an unrecognized context minimum trust reads as no floor
- A trust policy stored while the retired `reject` fork switch was still accepted no longer breaks the Platform's `trust_policy.update` push: the stored value is rewritten to `ignore` (what `reject` did) by a Platform migration, and both the push and the dashboard settings API render any stored value outside the current enum as `ignore`. The per-agent `mandatoryLabels` peer-heartbeat field is now required (a static agent sends `[]`), the orchestrator admin `PATCH /trust-policy` body is strict so a removed policy arm from an older `kici-admin` is refused with a 400 instead of being ignored, and an orchestrator without `KICI_ORCHESTRATOR_PROVENANCE_ISSUER` now logs one warning per retrier drain that its deferred attestations cannot be completed.
- User-cache quota eviction no longer deletes a concurrent save's in-flight upload
- A workflow with a dynamic init job (a filter, a dynamic env or context) no longer fails immediately when no agent or scaler backend can take the init job at dispatch time; the init job waits in the queue for capacity like every other job
- The agent image and the Node runtime it mounts into every job container move to Node 24.21.0 (OpenSSL 3.5.8, undici 7.29.1, NSS 3.126 root certificates); the orchestrator and platform images share the same base
- The dashboard's upgrade cards read tier prices and limits from the Platform's plan catalogue instead of a hand-maintained copy.
- Dependency advisories cleared: hono 4.13.7, fast-uri 3.1.7, qs 6.16.0 and postcss-selector-parser 7.1.6 replace the versions carrying GHSA-gqvv-2mrq-wpjv, GHSA-5jgf-p345-68v8, GHSA-x5fp-wj9c-mxmx, GHSA-w9m9-85wc-3x92 and their cohorts
- The marketing site's pricing, licence split and llms.txt bundle table are read from their sources at build time and fail the build rather than render a stale copy.
- The published public-mirror CI workflow pins actions/checkout v7.0.1 (SHA-pinned); it triggers on push and pull_request only, so v7's fork-PR checkout guard does not apply
- The agent exits non-zero when the orchestrator refuses its authentication permanently (an invalid or revoked token, or a protocol version below the orchestrator's floor) instead of staying alive behind its health endpoint; the GitHub Actions one-shot runner workflow carries timeout-minutes: 15 so a wedged run releases its runner
- The 0.8.0 installer image-digest record, quickstart compose and release-artifacts page carry the manifest-list digests quay.io serves (the resumed 0.8.0 release had left the record on 0.7.0, whose tags were since retired, and the compose without a digest pin); the release chain now reads the digests back from the registry when the image push was already done
- The dashboard reserves the Support button's corner under the main area, so the last row of a long table (an API key's clone/revoke actions, for example) is no longer covered by the floating button
- kici run --local (connected) describes its identity as plane-signed OIDC + attestation under the plane's own issuer, and kici local attach says the same, instead of claiming Platform-minted tokens
- A provenance signing key the orchestrator cannot load (sealed under a master key it does not hold, or db custody with no KICI_SECRET_KEY) is logged once as an error naming the recovery; a mint against it defers immediately instead of stalling for thirty seconds before deferring
- In a multi-coordinator cluster, a run whose build, init, or dynamic-eval job is claimed by a sibling coordinator's agent now dispatches its post-build jobs and ends with their status. The precursor result travels on the shared job row, every coordinator finalizes a run only when every job row is terminal, and a registration window on the run row stops a sibling from finishing the run on the build job alone.
- Dashboard: long pages no longer scroll their last row under the floating Support button — the shell grows with the page instead of pinning to the viewport, except on run detail, which scrolls in place
- The orchestrator OIDC discovery document now advertises every claim the ID token carries (claims_supported was missing the event-context, origin and attestation claims)
- The oidc.token() examples in the provenance and SDK runtime docs handle the deferred result the API can return instead of destructuring a token that may be absent
- A webhook the provider emits twice under two delivery ids — GitHub does this at times, with identical bodies under a second apart — now produces one run: the Platform treats a delivery whose body matches one it accepted for the same source within the last minute as a duplicate, so the second copy is answered as such and never relayed
- The pricing cards on the kici.dev landing page no longer show a gap between the price and its per-month period.
- kici docs, kici feedback and the files kici init scaffolds link to docs.kici.dev; the kici.dev/docs form they printed was dead
- kici feedback lists KiCI version and Environment as two required fields, matching the agent-report issue form
- The AGENTS.md that kici init scaffolds describes kici docs llm as the CLI accepts it: no topic prints the index, full prints the whole bundle, a topic name prints one task bundle; the --index flag it named does not exist
- Runtime dependency patches in the published packages — the kici CLI, SDK, agent and orchestrator, and the shared libraries under them: zod 4.6.5, yaml 2.9.1, open 11.0.4 (CLI), @aws-sdk/* 3.1135.0 (orchestrator and shared storage client)
- Runtime dependency patch in the published packages: oxc-transform 0.150.0, the TypeScript transform under the kici CLI's workflow loader and the agent (core and shared)
- The kici-admin --system refusal prints a sudo command that names the resolved node binary and CLI script, so it runs when node comes from a version manager such as nvm or mise
- The agent container image build retries the Node runtime tarball download on transient network errors instead of failing the whole build on one dropped TLS handshake.

### Documentation

- The deprecations pages are removed; the changelog starts at 0.8.0
- Build provenance docs gain worked examples for exchanging the job's ID token with an external service — a Cloudsmith npm publish and an AWS STS AssumeRoleWithWebIdentity + S3 upload
- The landing page and the public repository state that KiCI is in public beta
- KiCI is pronounced /ki-ci/. The landing page and the GitHub repository description now say so.
- Workload identity with OIDC has its own page, with Cloudsmith and AWS examples generated from the tested E2E workflows

## v0.8.0 — 2026-09-13

### Fixes

- kici run --local no longer times out on the first run after a cold plane start
- The local dev plane now rotates its orchestrator and PostgreSQL logs at 50 MB instead of growing without bound
- kici run --local names the cause when the local plane creates no run: leader election still pending, no lock file at the packed commit, or the plane's recorded delivery status
- kici run --local no longer reuses the previous run's lock file for a dispatch or in-place run: the local source is read from disk on every trigger, so an uncommitted edit runs its own step body instead of the cached bundle
- A warm pool on an event scaler no longer logs a spurious spawn failure at every orchestrator start; its first fill now runs once the event emitter is ready
- The kici.scaler.scale-up event's mandatoryLabels now carries the full gate the spawned agent is registered with, including taints derived from the scaler's platform field, instead of the configured list alone
- kici init in dev mode (KICI_DEV=true) pins @kici-dev/sdk to the latest dist-tag: the old >=0.0.1-0 range cannot match a prerelease build past 0.0.1, so npm install in .kici/ failed with ETARGET against a dev registry
- kici run remote against a fleet-coordinated orchestrator now carries the overlay and test-run provenance onto the routed job; previously the agent cloned an empty repository instead of unpacking the uploaded working tree
- kici run remote prints each streamed log line's text instead of the stored JSON envelope ({"ts","level","msg"}) the relay returns
- kici run remote fills the Duration column of its summary table: the Platform relay's run-status response now carries each job's duration
- kici runs logs prints each stored log line's text instead of the orchestrator's JSON envelope ({"ts","level","msg"}), in both the default and --follow modes
- kici run --local prints each streamed log line's text instead of the local plane's JSON envelope ({"ts","level","msg"}), matching kici run remote and kici runs logs
- An orchestrator restart no longer stalls a container, Firecracker or bare-metal scaler pool: spawns the previous process left in flight are released at startup instead of holding their capacity reservations until the stale-spawn prune
- kici-admin debug-bundle --fleet no longer fails on an agent whose diagnostic bundle is larger than the orchestrator's per-connection byte burst: the chunks of a bundle the orchestrator asked for are exempt from that limiter, and an agent now recognises the orchestrator's rate-limit warning frame instead of logging it as an invalid message
- A worker orchestrator now re-drives its pending jobs when one of its scalers frees capacity: the worker's in-memory queue lacked the listing the re-drive reads, so every freed slot logged 'Pending-scale re-drive failed' and placed nothing
- The orchestrator no longer crashes when a container-scaler agent finishes and disconnects before its own spawn has completed: the destroy that disconnect triggers stops the real container (or none, when it does not exist yet) instead of asking the runtime to stop an empty id, which podman answered with a redirect that ended in an uncaught getaddrinfo ENOTFOUND containers

### Other

- Versions before 0.8.0 were retired in a one-time reset before 1.0: they are deprecated on npm and their quay.io tags and GitHub releases are removed. Later versions stay available
