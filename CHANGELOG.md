# Changelog

Release notes for the public KiCI packages.

## v0.1.27 — 2026-07-10

### Features

- Rename job environments to contexts (breaking: use context:/contexts:/ctx.context)
- The orchestrator now detects PostgreSQL collation-version drift at startup and logs a loud, alertable error naming the database, the recorded-vs-actual libc collation versions, and the exact `kici-admin db reindex` remediation — instead of a drifted text index silently reading a present row (such as a source private key) back as missing. A `kici_orch_db_collation_drift` metric exposes the state for alerting, and setting `KICI_DB_FAIL_ON_COLLATION_DRIFT=true` makes the orchestrator refuse to start on drift.
- kici local: warm local dev orchestrator plane (up/status/down/logs)
- kici run --local --offline runs a compiled workflow end-to-end on your machine as an ephemeral agent, through a warm local dev orchestrator — no cloud, real execution engine
- kici run --local --offline: resolve secrets.yaml context-scoped secrets through the real resolver
- kici run --local --offline now mints a dev-signed identity: ctx.kici.oidc.token() and ctx.attestProvenance() are signed by a local key with issuer kici-local (clearly non-prod). Export the trust root with `kici local trust-root <file>` to verify a dev-signed bundle offline via `kici verify-attestation --trust-root <file>`; against the default (hosted) trust root it correctly rejects.
- kici run --local: attach the local dev plane to the Platform for real OIDC + attestation, with a `kici login` attach-prompt, `kici local attach`/`detach`, and auto-fallback to offline when the Platform is unreachable
- Trusted fleet-agent execution profile: an agent launched with `KICI_TRUSTED_ENV=true` passes the ambient host environment through to workflow steps (minus the agent's own KiCI identity secrets), for trusted host-configuration / fleet workloads — composing with the existing `KICI_SANDBOX` isolation toggle. On the local dev plane, `kici run --local --trusted` routes a run to this profile so steps see your ambient credentials (sops/ssh/aws) that a normal sandboxed run cannot. Trusted-env is an agent-launch/scaler-config property only — a workflow or trigger can never elevate itself.
- The `kici run local` subcommand is retired: every run is now a real routed dispatch. Use `kici run <event> --local` to run a workflow on your own machine (this machine becomes an ephemeral agent through the local dev plane), with `--offline` to force the throwaway/independent plane or `--in-place` to reuse the working tree. `kici run local` now prints a redirect to the new form and exits non-zero.

### Fixes

- kici-admin source refresh no longer fails with '[object Object]' is not valid JSON when refreshing a GitHub source's App identity
- kici run --local --offline: ctx.emit now delivers custom events instead of failing with 'Unknown job context'
- `kici local` plane reboots (attach/detach mode switches) now wait for the outgoing orchestrator to fully exit before booting the replacement, so a follow-up `kici local status` no longer intermittently reports the plane as not running
- Trusted/in-place agent step-log streaming now honors a step's `$({ quiet: true })` intent, so a workflow step that decrypts a credential (for example via `sops -d`) no longer leaks the decrypted value into the captured run log
- Dynamic context functions on a job (an impure `context()` resolved through an `__init__` job) take effect again. The environment-to-context rename had desynced the orchestrator's dispatch flag and the agent's returned resolved-context field names, so the agent silently skipped evaluating dynamic context functions and the resolved context was dropped
- Filesystem cache backend no longer rejects dependency-cache uploads larger than 25MB; internal artifact transfers are bounded by the cache max-tarball size instead of the webhook body limit
- Dashboard metrics, activity, and infrastructure pages now show status-aware error messages (permission/rate-limit/unavailable) instead of a generic connectivity error
- Windows orchestrator service install is now idempotent — a redeploy onto a peer that already has the service no longer fails with sc create 1073
- kici local up now honors a durable attachment: an attached plane comes up hybrid (matching kici run --local); --offline forces independent
- A dashboard re-run now yields exactly one run even when the platform relay fails over between coordinators (requestId idempotency)
- OAuth connect callbacks use the API base URL in split-origin deployments

### Documentation

- CLI reference command tables are now auto-generated from the CLI command trees

## v0.1.26 — 2026-07-06

### Other

- Maintenance release.

## v0.1.25 — 2026-07-05

### Features

- kici-admin environment purge: bulk-delete environments + held runs (direct-DB)
- kici-admin cluster reconcile-identity: recover a stuck orchestrator by reconciling cluster_meta.cluster_id with the durable S3 sentinel
- agent provenance can ride on org API key actors and run records
- Marketing landing now positions KiCI as an alternative to common CI tools, linking the comparison pages
- kici-admin access-log list --agent-label/--agent-only filter agent-attributed rows
- Provenance attestations carry a source-origin brand (triggered vs kici run remote) and the origin org id
- kici verify-attestation shows the origin org and flags kici run remote attestations
- MCP server: new developer agent tools — list_orgs, list_secrets (key names only), list_orchestrators, get_diagnostics, plus list_workflows filters
- Direct GitHub webhook ingress: deliver GitHub-App webhooks straight to your self-hosted orchestrator, bypassing the hosted Platform relay, with cluster-wide dedup and full job processing while the Platform is offline
- Provenance attestations carry a mint-timing origin (live, deferred, offline-backfill)
- kici verify-attestation flags deferred and offline-backfill attestations
- kici-admin attestations retry mints deferred attestations on demand
- Attestations surface deferred/pending state, an origin badge, and an on-demand retry
- Deferred attestations can be retried from the dashboard
- Coding agents can now approve, reject, and cancel-by-branch runs over the MCP server (approve_run / reject_run / cancel_runs_by_branch)
- kici-admin attestations list lists an orchestrator's attestations

### Fixes

- Public OIDC discovery + JWKS endpoints now reachable for build-provenance attestation verification
- External orchestrators can mint build-provenance identity tokens (route /internal/orchestrator/\* through the edge)
- New organization owners can again create API keys and service accounts with default permissions (the built-in Owner/Member roles now carry the full current permission set)
- Orchestrator no longer rejects manual workflow registration when a job binds an environment that has no protection-gate record
- Legal acceptance gate no longer deadlocks when a document version is published while you are reviewing it
- Test runs now warn (and skip) when a bound environment is unavailable (non-test or unconfigured) instead of silently dropping it — the warning appears on the kici run remote output and the dashboard run view
- `kici-admin cluster reconcile-identity` now defaults the storage prefix to the bucket root (matching the orchestrator default) instead of `kici-cache/`, so recovery reconciles the same sentinel the orchestrator validates at startup
- Firecracker microVM agents now bake the complete `@kici-dev/core` loader-hook layer into the rootfs — the shared rolldown runtime chunk was previously omitted, which made workflow execution inside a microVM fail with a missing-module error
- A transient provenance mint failure no longer fails the job; the attestation is minted later
- Fix a 500 error when browsing the org-wide attestations page (including filtering by digest).
- kici now points you at the current command (kici runs / kici diagnostics) when you type a retired command like kici status, and suggests near-matches for any mistyped command
- Events missed during an orchestrator restart are now all delivered on catch-up, not just the first 100
- kici run local prints discoverable usage when the event is missing
- system-completion events are no longer dropped by the per-workflow rate limit at scale
- an empty cross-repo trust allow-list now denies all events instead of allowing all
- kici run remote --approve-all now auto-approves holds in --json/--quiet mode instead of hanging
- kici run remote --approve-all / --yes now correctly binds the auto-approve flag (was silently ignored due to option aliasing)
- provenance ingest refetches JWKS on a kid-miss so a signing-key rotation no longer marks attestations failed
- Deferred attestations that the hosted platform can never mint (run/job absent) stop retrying forever; operators can re-arm them with kici-admin attestations retry --include-rejected
- Provenance verification no longer fails a live bundle whose repository/ref/sha/workflow_ref identity-token claim is null
- workflow timeouts of 24h or longer are now enforced by the stale-run scan
- Orchestrator container image now ships the jose dependency, fixing a startup crash (ERR_MODULE_NOT_FOUND: jose) when the orchestrator runs as a container
- kici approve/reject and run remote --approve-all now work for remote runs

### Documentation

- Document the agent safety model — least-privilege, fail-closed, audited
- Document agent prompt-injection defense (untrusted-content fencing)
- Document the deferred-attestation lifecycle, run-sync backfill, retry CLI, and truth contract

### Other

- Provenance ID-token minting now rides the authenticated orchestrator-to-Platform WebSocket, so external orchestrators can attest provenance without a separate public HTTP endpoint.

## v0.1.24 — 2026-06-28

### Features

- schedule() triggers can declare defaults-only typed inputs exposed as ctx.dispatchInputs
- kici-admin orchestrator/agent upgrade --pick to interactively switch to an installed version
- kici-admin agent register --privileged-root mints a confined root agent token
- Jobs can bind multiple environments via environments: [...]
- Add ctx.signal (AbortSignal) to step context for cooperative cancellation
- Registering a workflow rejects mutually-exclusive multi-environment job bindings with a precise message
- Add parallel() to run independent steps concurrently within a job
- Rename kici test to kici preview
- Add provenance-tagged agent run-result schema
- Add agent-annotated actor + PatKind to the protocol
- Mint agent PATs with kici pat create --agent for the MCP server
- Add a Platform-hosted MCP server so a coding agent can drive KiCI under your identity
- Verify build-provenance attestations at ingest and store the verdict for browsing
- kici-admin attestations reverify: backfill stored provenance verdicts
- Execution notifications engine: run-terminal evaluation, coalescing, Slack delivery worker
- Email notification channel with per-recipient delivery and bounce/complaint suppression
- Self-service notification subscriptions: manage your own email notifications without admin
- Capture and notify the person who triggered a run (actor-scope notifications)
- `kici verify-attestation` now defaults `--trust-root` to the hosted KiCI platform, so verifying a bundle attested on the hosted platform needs no flag

### Fixes

- kici run remote --json now emits clean JSON even when a workflow logs at module top level (workflow output goes to stderr)
- Orchestrator fails fast when a scaler would receive a loopback storage URL, naming the endpoint env var to set
- kici types: generated secrets.d.ts augments the SDK module instead of shadowing it
- kici run remote labels runs with the local working tree's git origin instead of an internal routing key
- Stop npm install -g of @kici-dev/orchestrator and @kici-dev/compiler from colliding (EEXIST) with the kici-admin and kici wrapper CLIs
- Environment Secrets tab now resolves scope bindings against the selected orchestrator (per-orchestrator environment pages no longer preview against the wrong cluster's scopes)
- Dashboard now reports 'orchestrator too old' instead of a misleading invalid-payload error when a feature needs a newer orchestrator
- Platform now falls back to X-Real-IP (and then null) when the first X-Forwarded-For hop is empty or whitespace, so a malformed forwarding header no longer records an empty-string client IP in legal consent records and webhook audit logs
- Agent image no longer ships perl (removed to eliminate the perl CVEs); workflow steps that invoke perl are no longer supported
- Quickstart compose templates now use the postgres alpine image (perl-free, smaller attack surface)

### Documentation

- Document the structured agent run-result API
- Document driving KiCI from a coding agent via the MCP server

## v0.1.23 — 2026-06-25

### Features

- Typed dispatch inputs: declare a workflow's manual-dispatch parameters with `defineDispatchInputs`, pass a typed `inputs` map on `dispatch()` triggers, and read coerced values via `ctx.dispatchInputs` in steps and rules. Inputs are validated and defaulted against their descriptors before dispatch, and a new repeatable `--input key=value` flag on `kici run local` / `kici run remote` supplies them from the CLI.
- Ordered fan-out: fan-out children now carry a deterministic position exposed as `ctx.fanout` (index/total) to steps and rules, with `onlyOnFirstHost` / `onlyOnLastHost` / `onlyOnFanoutIndex` rule helpers for run-once-per-fan-out behavior. A new `runsOn.pick` selector deterministically pins a job to a single matching host by agentId.
- Step retry policy: a step can declare `retry` with `retryIf` and a backoff so a thrown step is retried with computed delays before failing the job. Retries apply across dynamic jobs and `kici run local`.
- Per-host secret scoping: environment bindings accept a `host_pattern` (exact, glob, or regex over agentId/host/labels), set via `kici-admin environment bind --host`, so a fan-out resolves a different secret value per host with host-specificity precedence. Scope patterns can template `agentId`/`host`/`label` with sanitization.
- `kici docs llm` now takes a topic argument and emits per-task bundle files behind a router index (the bare command builds the index by default). Relative markdown links are rewritten to absolute docs URLs, and bundles are gated on link-cleanliness, dangling references, size, and coverage.
- New `checkStep()` — a check-mode-aware sibling of `idempotentStep` for drift-detecting steps. Remote runs now persist the run's check mode on the dispatch path, so `kici run --check --fail-on-drift` correctly fails a remote run that finds configuration drift.
- Fresh-box bring-up for `runsOnAll`: a new `includeUninitialized` job option fans a job out across declared hosts that have no agent yet. The orchestrator flags declared-but-offline hosts for bring-up and dispatches a synthetic bring-up job for un-agented children, using single-use short-TTL bootstrap tokens and an ephemeral-key SSH seam (`ensureInitRunner` / `preBootSend`) to stand the agent up before the real job runs.
- Re-declaring a fleet host now converges it to the newly declared labels, hostname, and properties instead of silently no-opping; agent-reported liveness is preserved and the declare result reports whether the host was created or updated.
- kici run remote --pick opens an interactive multi-select menu of the available fixtures, so you can choose which ones to run without typing their names. Selecting several runs them all through the normal remote pipeline (honoring --parallel).
- kici run remote now recompiles workflows before dispatching (parity with kici run local)

### Fixes

- `kici run local` now exits with code 2 (not 1) when given an invalid `--input` value, distinguishing bad user input from a workflow failure.
- Fix `kici run remote` failing with ECONNREFUSED on the bare-metal quickstart when using the container scaler: SeaweedFS is now published off-loopback and the storage config sets an agent-facing external endpoint.
- `kici run remote` now reports a clear, actionable error when the target orchestrator has no object storage configured (overlay uploads require it), instead of failing with an opaque `Failed to parse URL from` after three retries. The orchestrator refuses to mint an empty upload URL, and the CLI fails fast if it ever receives one.
- `kici run remote` no longer occasionally drops the last log line of a finished run. A blocking follow could exit the moment the run reached a terminal state while the agent's final log chunk was still being persisted, omitting it from the captured output. The orchestrator now drains a terminal run's in-flight log writes before reporting the log stream complete, so the final line is always included.
- kici org list now shows org ownership (owner/member) instead of (undefined)

### Documentation

- New authoring docs for typed dispatch inputs (`kici run --input`), ordered fan-out (`ctx.fanout`, run-once helpers, `runsOn.pick`), the step retry policy, per-host secret scoping, `checkStep()`, and `kici docs llm` task bundles.
- Quickstart troubleshooting: document the kici run remote container-scaler overlay-download failure (ECONNREFUSED on :8333) and the SeaweedFS empty-directory crash-loop, storage-not-configured, and No-jobs-dispatched failure modes in both the bare-metal and Docker/Podman quickstarts; the bare-metal quickstart now documents the three-endpoint storage block + all-interfaces SeaweedFS publish that make kici run remote work with the container scaler.

## v0.1.22 — 2026-06-24

### Features

- Documentation site now includes a Changelog page with released notes and an Unreleased section.
- Approval gates can now fire on drift. A per-step `approval: { when: 'drift' }` gate pauses a check/apply step mid-job when its `check()` finds drift in apply mode, shows the computed drift in the dashboard approval queue and the CLI, and applies only on approval — Terraform's plan→apply, per step. The unified `approval` config replaces `requireApproval` and adds a run-scoped `kici run --approve-all` breakglass.
- Workflows can now reboot a bare-metal host mid-run and wait for it to come back. New SDK steps `restartHost` and `waitForHostAlive` (plus `ctx.kici.host.requestReboot`) request a reboot; the orchestrator holds further dispatch to that host until it reconnects, treats the expected disconnect as success, and sweeps hosts that miss their reboot deadline. The agent records the reboot intent and executes the reboot across operating systems.
- GitHub sources now capture the GitHub App's display name and slug at creation and refresh them from GitHub daily, with `kici-admin source refresh` to re-sync on demand. You can also override the GitHub App webhook URL when registering a source via `--webhook-url`.
- `kici-admin host remove` removes a statically-declared host from the orchestrator's host roster.

### Fixes

- `kici login` now persists the endpoint and OIDC issuer it authenticated against, and resets stale active-org and default-cluster state when you log in against a different endpoint, so a re-login no longer leaves the CLI pointed at the previous environment's selections. A new `--oidc-issuer` flag lets you override the issuer used for the login flow.

## v0.1.21 — 2026-06-23

### Features

- `runsOn: [agentId]` now pins a generated job to a specific host, dispatching it directly to that agent.
- Host inventory: agents report typed host properties at registration (declarable with `kici-admin host declare --prop`), queryable from workflows via `ctx.kici.inventory.query` / `get`.
- Idempotent steps with check mode: `step()` gains an idempotent check facet, and `kici run --check` / `--fail-on-drift` report or fail a run on configuration drift.
- One-click GitHub App setup: `source add github --manifest` runs a guided manifest flow that builds, installs, and verifies the App.
- Reusable, instance-bound join tokens enable self-healing peer rejoin within the token's expiry.
- Incompatible-schema or malformed lock files are now rejected at the cache with recompile guidance.
- More reliable remote-worker terminal-status relay: terminal job statuses are durably persisted, acknowledged, and replayed across worker reconnects and peer flaps.

### Fixes

- The CLI main-module guard now tolerates being invoked through a symlink.
- `corepack prepare` is retried to survive transient registry hiccups.
- Workflow validation throws a clear error when a `runsOn` element is not a valid matcher.
- The local runner and executor now provide a `ctx.kici.inventory` mock for local testing.
- The sandbox-failed agent log line now includes the underlying failure cause.

### Documentation

- Document one-click `--manifest` GitHub App setup as the primary path.
- Document host inventory query API and host properties.
- Document idempotent steps and check mode.
- Document self-healing peer rejoin via reusable join tokens.
- Document that schema-mismatched locks are rejected with recompile guidance.
- Quote `push-*` glob examples so the shell does not expand them.

## v0.1.20 — 2026-06-19

### Documentation

- Refresh the documentation for engine close codes and CLI commands.

## v0.1.19 — 2026-06-19

### Fixes

- Correctly partition workflow label matching across dispatch paths so `runsOn` selectors route jobs to the intended agents.
- Page through archived event-log history newest-first.
- Skip fleet bundle logging gracefully when no log directory is configured, instead of erroring.
- Reject empty provenance subject digests rather than writing an invalid storage key.
- Write Firecracker boot-script network configuration with proper newlines so the VM network comes up reliably.
- Guard job-cancellation messages against closed connections to avoid spurious errors.

### Documentation

- Reworked quickstart: split into "run remote" (compose + bare-metal) and "GitHub" parts, clarified remote-run SDK resolution, and added a Docker Hub rate-limit note.
- Corrected quickstart details — token prefix, `kici` CLI install step, PostgreSQL 18 on macOS, and an updated SDK version pin.
- Routine documentation maintenance across security, orchestrator config, engine protocol, and configuration references.

## v0.1.18 — 2026-06-17

### Features

- `runsOn` and `runsOnAll` now accept RegExp and glob-string label selectors, not just exact labels
- New `runsOnAll` surface fans a job out across every matching host, exposing `ctx.host`/`byHost` per pinned host, with configurable `onUnreachable` behavior and alerting on unreachable declared hosts
- Rolling fan-out concurrency controls: `maxParallel` and `failFast` on matrix/fan-out jobs
- Result-aware dynamic job generation: `dynamicJob` can declare `needs` and read upstream results via `ctx.needs`, deferring evaluation until those upstreams complete
- Yarn Berry support: corepack provisioning, forced node-modules linker, `workspace:`/`portal:` protocol validation, and yarn flavor folded into the dependency-cache key
- Regex label selectors are screened for ReDoS at compile time and revalidated when the lock is loaded
- Install collision errors now point operators at the upgrade path

### Fixes

- Matrix dimensions are preserved when one is named `value` (previously collided with the expanded name)
- Cron- and `ctx.emit`-triggered internal events now match label selectors correctly
- Explicit approval holds resume and expire correctly
- Rolling fan-out releases the whole wave instead of only the first sibling
- `.kici` dependencies are reinstalled with the project's own package manager, and the dependency cache keys on `.kici/pnpm-lock.yaml` for standalone pnpm projects
- Windows-essential system environment variables now pass through the execution sandbox
- Renaming a non-existent secret scope is rejected with a clear error
- npm-source upgrades verify the running unit's launch version before proceeding
- The instance deploy folder is recovered from the init system when needed
- Invalid input now returns HTTP 400 instead of a server error

### Documentation

- Glob and regex label selectors for `runsOn`/`runsOnAll`
- `runsOnAll` host fan-out authoring and `onUnreachable` semantics
- `maxParallel`/`failFast` rolling fan-out
- Result-aware dynamic job generation
- Yarn Berry support
- Quickstart: bare-metal setup ships a prefilled compose file with a stub local database password, and orchestrator upgrade paths are clarified
- Operator: npm-source upgrade launch-version verification and embedded deploy-folder marker recovery
- Reorganized the dashboard guide into its own subgroup

### Other

- Upgraded dependencies, including SeaweedFS, and dropped several now-redundant third-party libraries

## v0.1.17 — 2026-06-14

### Features

- `kici run remote` now routes through the Platform, with explicit org targeting and uploads to hidden orchestrators
- New `kici orchestrators list` / `use` commands, and per-org default clusters stored in config
- New `kici runs` command group (`list`, `show`, `logs`, `rerun`, `cancel`) and a new `kici diagnostics` command; the standalone `status` and top-level `cancel` commands are retired
- `secrets-list`, `types`, and `workflows list` now route through the Platform; `kici login` no longer takes a direct `--endpoint`
- Dynamic matrices: typed matrix output envelope with local/remote parity, combination-keyed upstream outputs, `ctx.matrix` values, and materialization across rerun, manual, scheduled, webhook, and remote-run paths
- `runsOn` can now target `kici:` labels (e.g. `kici:os:linux`) using the label model
- Local filesystem (`file://`) repositories can be configured as a user-facing source provider
- Job `init` accepts mise presets and `'auto'` runtime detection, with auto-expansion during the init phase
- Yarn Classic is now supported for `.kici` dependency installation (standalone and hoisted layouts), with the agent image bundling yarn 1.22.22
- Workflow install holds: runs pause on an install gate, resume on approval, and auto-release on wait-timer expiry, with a new held run status
- New `ctx.kici.oidc.token()` for job-bound OIDC tokens with automatic masking
- Provenance attestations: `ctx.attestProvenance` and a new `kici verify-attestation` command with trust-root resolution and client-side verification
- Agents now report their version, enabling a restart-only upgrade mode for npm-based sources

### Fixes

- Dynamic matrices materialize correctly on generated jobs
- Local (`file://`) source provider migration and update handling corrected
- Restore executable bit on corepack shims for the Node 24.16.0 base image
- Windows mise preset fixes: PATH handling, config trust before install, and stderr-on-success surviving strict error handling
- `pnpm`/`yarn` availability is probed from a neutral working directory

### Documentation

- Guides for the `file://` local source provider, `kici:os:linux` label targeting, matrix remote semantics, and how `kici run remote` picks its destination org
- Documented runtime sops env injection (repo secrets are not auto-decrypted), mise init presets with `'auto'` detection, and the Windows VC++ runtime prerequisite
- Documented Yarn Classic support, diagnostics version display, npm-source upgrade mode, and consolidated provenance documentation

### Other

- Bump rolldown and bundler bindings to 1.1.0 and the Node base image to 24.16.0
- Remove dead test-run/observe code paths and legacy wire schemas

## v0.1.16 — 2026-06-12

### Features

- **Multi-level approval gates.** Workflows can now require manual approval at the step, job, or workflow level via a new `requireApproval` option in the SDK. Approval requirements support AND clauses, designated eligibility, optional self-approval, and configurable expiry — held runs name exactly which clauses remain unsatisfied and resume automatically once approved.
- **Approve and reject from the CLI.** New `kici approve` / `kici reject` commands let you act on held runs, with real approver attribution and eligibility enforcement.
- **Environment reviewers.** Job and workflow approval holds can enforce per-environment reviewers, configurable through `approval_expiry_seconds` and `allow_self_approval` org settings.
- **Teams.** A new teams management tab on organization settings, with team memberships propagated to orchestrators via trust policy.
- **Fleet log collection.** `kici-admin debug-bundle --fleet` collects and reassembles logs, system info, and metrics from an entire orchestrator + agent + peer subtree over the existing channels, with `--list` / `--pick` / `--fleet-timeout` controls.
- **Firecracker host-network management.** A new `kici-admin firecracker` command group (`provision` / `verify` / `teardown`) replaces the old setup script, and `kici-admin diagnose` now reports Firecracker bridge health.
- **Automatic Firecracker orphan recovery.** A startup disk-space guard auto-reaps orphaned Firecracker VMs before they cause an out-of-disk crash-loop, plus a standalone `kici-admin scaler reap-orphans` recovery command that runs without a live orchestrator and never deletes live VMs.
- **Digest-pinned installer.** The orchestrator installer now resolves and pins its image by manifest-list digest for reproducible, tamper-evident installs.
- **Access-time cache eviction.** The user cache now evicts by access-time LRU instead of creation time, keeping frequently used entries warm.
- **SLSA provenance schema.** Added an SLSA v1.0 provenance schema.

### Fixes

- Slimmer, distroless agent and orchestrator runtimes — Perl removed from the base image while preserving the CI userland.
- Correct multi-arch images: architecture-agnostic nftables library copy.
- Firecracker host-network provisioning is now deploy-ready.
- Bumped SeaweedFS (4.32 → 4.33) past OpenSSL CVE-2026-45447.
- `kici-admin scaler reap-orphans` now resolves its scaler config for environment-only workers.
- Hardened held-run persistence and approval bookkeeping.

### Documentation

- New guide covering per-step, per-job, and per-workflow approvals (authoring, operator, and architecture perspectives).
- Documented the self-service sign-in method change and corrected linked-accounts help copy.
- New operator page on installer digest pinning and upgrade considerations, plus a generated release-artifacts reference.
- New Firecracker data-disk recovery runbook and `reap-orphans` reference.
- Documented fleet log collection via `debug-bundle --fleet`.

## v0.1.15 — 2026-06-11

### Features

- **Per-job init phase:** jobs can now run setup commands before the step loop, applying environment changes, restoring and saving caches, and enforcing per-init timeouts (e.g. provisioning `jq` via generic init).
- **Declarative caching:** define caches on jobs and steps and persist directories across runs through `ctx.cache`, with immutable/atomic/isolated semantics and cluster-configurable per-org quota and TTL.
- **Job and workflow timeouts:** set wall-clock limits on individual jobs and whole workflows; the orchestrator enforces a run deadline and reports a distinct timeout reason.
- **Step environment exports:** steps export environment variables and PATH additions via `setEnv`/`addPath` and the `$KICI_ENV`/`$KICI_PATH` shell contract.
- **`kici run remote` secrets and env:** new `--context` flag for encrypted per-run secrets and an `--env` flag; test runs resolve test-scoped secrets and evaluate inline and dynamic environments.
- **Test-run access control:** environments expose a `test_access.set` operation and an `allowLocalExecution` gate, surfaced in the web UI alongside fixed/glob type explanations.
- **Dispatch acknowledgement:** agents acknowledge accepted dispatches; the orchestrator requeues lost dispatches, disconnects unresponsive agents, and handles job rejection with bounded requeue. The ack timeout is cluster-configurable.
- **Environment lifecycle via kici-admin:** create environments with `--glob-pattern` and delete them; deletion is blocked while pending held runs exist, and terminal history is preserved.
- **Stale checkout cleanup:** `kici run local` garbage-collects retained checkouts after 72h, and agents clear hard-death leftovers at startup.
- **SeaweedFS storage in quickstart:** the generated compose wires SeaweedFS, and `KICI_STORAGE_UPLOAD_ENDPOINT` enables host-facing S3 pre-signed uploads.
- **Corrupt lock-file handling:** unparseable lock files surface as a typed parse error and a `lockfile_corrupt` event-log status.
- **Scaler visibility:** scaler status and diagnostics surface the static spawning host and agent host labels.
- Customer-controlled opt-in settings for support access.
- `kici login` defaults its OAuth settings to production.

### Fixes

- Graceful shutdown now honors exit codes — fatal and forced shutdowns exit non-zero — and EPIPE on stdout/stderr during shutdown is swallowed.
- `kici run remote --json` emits pure JSON on stdout.
- Presigned uploads work on S3-compatible stores: default request checksums are disabled, the S3 region is required and set for non-AWS backends, and the generated compose fixes the SeaweedFS healthcheck.
- Database connection-pool errors are absorbed instead of crashing the process; `db migrate` records a migration content hash so schema checks work on warm databases.
- Firecracker per-VM isolation keys on source IP so forwarded traffic matches, and allowlist rules insert at the chain head so baseline drops cannot shadow them.
- Cache scope: default-branch pushes count as a trusted ref, contributor-less non-PR events are trusted, and cache keys stay canonical for dot-only path segments.
- Missing registrations and backend not-found requests now return structured 404s.
- Multi-level timeouts now actually fire and preserve their reason.
- Agent containers are labeled with the job and run they serve.
- The agent runtime image installs curl, gzip, and xz so generic-init fetchers and tar pipelines work.
- Rootless Firecracker cleanup chowns the jailer chroot before removal so disk is freed.
- Example workflows repaired, including a tested deploy example.

### Documentation

- Reworked quickstart with a run-remote walkthrough over SeaweedFS, the cache-storage prerequisite, and corrected `kici test` invocations.
- New and restructured operator docs: per-backend auto-scaler pages (container, bare-metal, Firecracker), a self-hosting security front-door, an orchestrator-first landing page, and an observability rewrite.
- Documented the init phase, job/workflow timeouts, user-facing caching, the dispatch ack deadline, `setEnv`/`addPath`, and test-scoped secrets.
- Generated SDK reference for event payload schemas, with a drift check.

### Other

- Public release history is now published as linear commits, authenticated as a GitHub App.
- Workspace packages gained descriptions, real pointer READMEs, repository/keywords metadata, and a core license.
- Bumped the Windows service wrapper to 1.9.0.
