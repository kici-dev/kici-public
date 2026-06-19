# Changelog

Release notes for the public KiCI packages.

## v0.1.19 — 2026-06-19

### Features

- Track paid-tier live-log tail-minute usage with a new consumption meter in the web UI.

### Fixes

- Correctly partition workflow label matching across dispatch paths so `runsOn` selectors route jobs to the intended agents.
- Page through archived event-log history newest-first.
- Skip fleet bundle logging gracefully when no log directory is configured, instead of erroring.
- Reject empty provenance subject digests rather than writing an invalid storage key.
- Keep attestation badges from briefly flashing "unverifiable" while verification keys are still loading in the web UI.
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
- Web UI: folded stateful-agent groups no longer show a redundant host label

### Documentation

- Glob and regex label selectors for `runsOn`/`runsOnAll`
- `runsOnAll` host fan-out authoring and `onUnreachable` semantics
- `maxParallel`/`failFast` rolling fan-out
- Result-aware dynamic job generation
- Yarn Berry support
- Quickstart: bare-metal setup ships a prefilled compose file with a stub local database password, and orchestrator upgrade paths are clarified
- Operator: npm-source upgrade launch-version verification and embedded deploy-folder marker recovery
- Documented the paid-tier live-log tail-minute fair-use cap
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
- Provenance attestations: `ctx.attestProvenance`, a new `kici verify-attestation` command with trust-root resolution, and an attestations panel with client-side verification in the run detail view
- Run detail view gains a Graph tab surfacing job dependency edges
- Agents now report their version, enabling a restart-only upgrade mode for npm-based sources

### Fixes

- Dashboard environment-list and other org-scoped reads are correctly scoped to the requesting org
- Schema-invalid dashboard requests now return a structured error, and every forwarded request is guaranteed a response
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
- New registrations metric with accompanying dashboard panels.
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
- The web UI hides the payload tab for runs that never carry a payload.
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
