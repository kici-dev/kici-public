# Changelog

Release notes for the public KiCI packages.

## v0.6.0 — 2026-09-01

### Features

- The orchestrator plan limit now counts worker orchestrators alongside coordinators.
- Workflow-driven autoscaling: a new event scaler backend emits reserved scale-up/scale-down events that customer provisioning and teardown workflows consume to spin up and tear down ephemeral cloud instances
- SDK: buildAgentCloudInit — customizable cloud-init for scaler-provisioned agents
- Reused (bare-metal) agents now reap a finished job's leaked process tree, re-run declared cleanup out-of-band after a hard kill, and can run an operator between-jobs reset command
- invokeSource: global workflows can invoke and gate on a source repo's opt-in workflows
- GitHub Actions autoscaling: run KiCI agents as one-shot GitHub Actions workflow runs via the event scaler, with unified claim-code self-bootstrap
- Event-scaler autoscaling works behind a single shared endpoint on a multi-coordinator cluster, with maxAgents counted cluster-wide
- Authenticated git in workflows: declare named credentials from the secrets backend with gitCredentials, and push with ctx.repo.withWrite. Credentials are minted per git operation, so a push at the end of a long job works.
- Container jobs can use any glibc image, including a private one, without that image shipping Node. An agent that starts your image as a second container also clones for you, so that image needs no git either; a pool that runs your image as the agent itself still needs git in the image.
- Container jobs can build their image from a Dockerfile in your repository, instead of naming a finalized image. KiCI clones, builds on the agent that runs the job, and runs the job in the result; the build's output appears in the run log as its own step.
- kici runs show prints why a run never started: the run-level failure, each job's rejection reason, and any approval hold with its context and reason
- A repeatedly failing external (event) scaler now backs off exponentially instead of re-dispatching every spawn timeout, with three cluster settings to tune it
- Ref-based CI trust: same-repo refs run fully trusted; fork pull requests are governed by one org-level switch (ignore, hold, or allow) and always run with reduced privilege
- Independent orchestrators can register their own `/kici approve` approvers with `kici-admin trust-policy directory-set` and revoke them with `directory-remove`; both refuse on a Platform-attached orchestrator, where the dashboard owns the directory
- The org CI trust policy accepts a seconds-granularity approval expiry, so a security hold can be shorter than an hour
- Independent orchestrators raise, persist, surface and expire approval holds. A fork pull request the org policy holds is now parked with a `KiCI Security` check and released with `/kici approve`; a workflow's own `approval` gate is enforced instead of running the job ungated
- `kici-admin held-run list|approve|reject` answers a held run on an independent orchestrator, covering the approval queue as well as the security queue. Approving re-dispatches the held job or workflow rather than only marking it approved, and the resumed run keeps the reduced privilege its ref earned. Both verbs refuse with a 409 wherever a Platform is attached, because the Platform authorizes each decision there
- The Members tab now names a per-member CI trust override on the badge and lets a `ci_trust:admin` member clear it. The override outranks the level a member's roles grant, so an organization that had lowered someone by override previously had no way to see that, or undo it, from the dashboard
- Notification subscriptions scoped to a workflow's defining repository now receive that workflow's organization-wide runs. A repository filter matches either the repository a run executed against or the repository that defines the workflow.
- A failed organization-workflow evaluation round can be re-run. Re-running the errored evaluation run re-evaluates the original event; a clean result posts success on the 'KiCI: Organization workflow evaluation' check and dispatches the admitted workflows.
- The SDK exports the reserved scaler event names and their payload schemas (SCALER_EVENT_NAMES, ScaleDownReason, ScalerScaleUpPayload, ScalerScaleDownPayload), so an autoscaling workflow imports the contract instead of re-declaring it
- Copy-pasteable GitHub Actions provisioning and teardown workflows now ship under examples/, pointed at your runner repo by the GITHUB_RUNNER_REPO context variable
- kici report gathers a redacted diagnostic bundle for an issue report, with an opt-in private upload to KiCI and self-service list/withdraw

### Fixes

- Cache restore now works when KICI_TMPDIR points at a different filesystem from the workspace
- kici types now writes an empty offline stub when the Platform is unreachable instead of failing, so an unauthenticated compile still typechecks
- kici init now scaffolds .kici/.gitignore so the generated types/ declarations stay untracked (kici.lock.json remains tracked source)
- kici types preserves an existing populated secrets.d.ts when the Platform is unreachable, writing the empty offline stub only when the file is absent
- Agent: dynamic job generators now see env vars set by a workflow module at import time, matching the global eval round
- Reject duplicate generated job names across a whole eval round, not just within one dynamic generator
- Update dependencies to clear high/moderate advisories (undici, tar, react-router, postcss, nanoid, hono, @hono/node-server, brace-expansion, fast-uri, ip-address)
- Bump the DHI Node base image to 24.19.0 (picks up the 24.18.1 security release) across the orchestrator, agent, and platform images
- The orchestrator now starts correctly on macOS, Windows, and ARM (the cross-platform bundle no longer exits immediately without running)
- A failed job's GitHub check run no longer gets stuck showing in-progress with a failure conclusion (a late progress update could reopen the completed check)
- A workflow host-restart's post-restart job is no longer dispatched into the rebooting host by the pending-job safety-net re-drive (it stays held until the host reboots back)
- kici-admin now distinguishes a malformed request (e.g. a token containing a newline) from an unreachable orchestrator, instead of reporting both as a connectivity failure
- Dependency-cache tarballs are addressed by their own content hash, so two builds sharing a lock file can no longer leave a tarball and integrity hash that disagree (which failed jobs with a durable hash mismatch)
- Event-scaler provisions are no longer stranded without teardown, and an agent that reaches a different coordinator in a cluster is no longer treated as unmanaged
- A kiciEvent() workflow now receives the emitted payload on ctx.rawPayload, so an autoscaling provisioning workflow can read its claim code
- An event-scaler teardown addresses the provisioning targets recorded at spawn time on every coordinator, and removing an event scaler from the config no longer strands its in-flight provisions
- An internally triggered workflow no longer reads a fabricated targetBranch of "main" on ctx.event — an internal event has no branch, so the field is absent
- Container installs now wait for the orchestrator and agent to shut down cleanly instead of killing them after 10 seconds
- kici.git.github.getToken now mints a token covering every repository you name, instead of silently using only the first
- A job that pairs requireApproval with a dynamic env, context, concurrency group or matrix is now held for approval instead of dispatching ungated, and a context bound dynamically is now checked against its protection rules
- A job that pairs requireApproval with a dynamic matrix now holds every matrix child for approval, instead of holding one placeholder that would resume as a single job
- A job held by a context's wait-timer, concurrency or trust gate is now registered on its run and keeps a resume path, instead of being dropped while the run reported success
- A job that both waits on another job and requires approval is no longer dispatched when its upstream finishes, and a job held for approval is no longer lost when the orchestrator has connected peers
- A job with a dynamic concurrency group is now limited by that group rather than by its context name, and a held matrix or host child keeps its variant identity
- A context bound statically to a job that also uses a dynamic field now has its protection rules and secrets applied, and approving a security hold now runs the gated job instead of only marking it approved
- Config reload now adds and removes scaler backends: a new scaler starts routing immediately, a removed scaler is retired (routing stops, warm agents are destroyed, job-bound agents finish), and maxAgents, maxConcurrentSpawns, machine pools and warm-pool removal all apply without a restart.
- A Firecracker scaler entry that sets `requireSudo: true` now escalates privileged commands through `sudo -n` on a leader orchestrator, not only on a worker — a rootless leader no longer fails to run `ip`, `chown`, `chmod` and `nft`.
- A scaler removed from the config no longer advertises capacity to cluster peers, so a peer stops routing jobs to a retiring scaler that cannot serve them
- The kici-admin diagnose table now shows a retiring scaler and its remaining agent count instead of cutting the marker off the end of the row
- A scaler config reload that cannot construct a newly added scaler now leaves every existing scaler exactly as it was, instead of keeping the new label sets and maxAgents while reporting that the previous config was kept.
- Removing a scaler from the config while one of its agent spawns is still in flight no longer tears the backend down early, so the agent that lands is still tracked and destroyed instead of outliving the scaler it belonged to.
- A scaler added by a config reload is now built from the reloaded config. It previously used the boot-time config, so a Firecracker scaler added alongside a network change allocated IPs from the old CIDR and attached to the old bridge.
- Config reload now applies an event scaler's roles, mandatoryLabels, provisioningTargets, agentTokenTtlSeconds and claimTtlSeconds. They were read from the entry captured at startup, so a reload that retargeted the provisioning workflow kept emitting scale-up events to the old one.
- Warm pools now keep agents ready. A scaler configured with warmPool.enabled pre-spawned nothing, because the pool was never populated; it now fills from the orchestrator's own agent registry. idleTimeoutSeconds removes only agents above the configured size, so an agent that makes up the pool stays ready until a job uses it.
- Re-adding a scaler while it is still draining now keeps it routable, instead of dropping the backend once the drain finishes
- The scaler panel in dashboard diagnostics now reflects the config a `SIGHUP` reload applied, instead of the one the orchestrator started with
- Warm pools keep their agents. An agent started for a warm pool used to shut itself down a few seconds later, so the pool never held any agents; it now waits for work until the orchestrator gives it a job or removes it.
- Jobs now run on a scaler that declares a platform. A scaler with a platform such as arm64 or macOS started agents that no job could use, so its jobs went back to the queue and started more agents.
- Warm pools now reserve the resources their agents use, and a job that asks for different resources or its own container image gets its own agent instead of a ready one. Warm pools now require declared resources.
- A job that declares its own cpu and memory now gets an agent of that size on a worker node. Such a job used to lose its declared size when it was queued on a worker, so it ran on a ready agent of the pool's size, or started a new agent of the default size.
- Agents spawning at the same time no longer mount a partially copied KiCI runtime
- A failed runtime copy no longer removes the runtime volume another agent is still writing
- A failed runtime copy now reaps its dead volume instead of leaking it
- Runtime materialization containers now carry the kici-managed label, so the orphan reaper removes them
- runsOnAll fan-out targets declared fleet hosts only; auto-scaler agents are no longer pinned fan-out targets
- Reference autoscaling provisioning workflows now bind the context that holds their cloud credential, and the GitHub Actions scaler example names a repo in provisioningTargets instead of a workflow name
- A workflow triggered by a schedule or an event resolves its bound contexts in full: context variables, scoped secrets, and the context's protection rules
- A gated context now gates an internally-triggered run: reject rules, approval holds, wait timers and concurrency groups apply to schedule and event triggers
- An internally-triggered run carries a trust tier: the orchestrator's own schedule and lifecycle events are trusted, and a kiciEvent() subscriber inherits the tier of the run that emitted the event
- A run summoned by an invoke gate inherits the trust tier of the summoning run
- A kiciEvent() subscriber that inherits a tier below trusted receives no install secrets, and a minimumTrust context holds it for security review when the inherited tier falls short
- A Dockerfile build in a cron-fired workflow runs, because a schedule fire is a trusted trigger
- The event-name prefix __ is reserved for KiCI internal events: ctx.emit() refuses it, alongside the existing kici. reservation
- invokeSource() refuses a reserved event name at compile time, and a lock file that still carries one fails that gate job at dispatch
- A scheduled or event-triggered workflow dispatches its dynamic-matrix, dynamic-env and dynamic-concurrency jobs, and honors workflow-level filters
- A cron-fired run records the commit sha it ran against, so the run links to the commit that registered the workflow
- A job a deployment context rejects now appears on the run as a failed job naming the context and the rule, instead of vanishing from the run — so a run whose gated job was silently absent, and reported green, now reports failed
- A branch-restricted context now names the real reason it rejects an internally-triggered run
- A workflow triggered by `kici.scaler.scale-up` or `kici.scaler.scale-down` now runs trusted, so it can build a Dockerfile job and pass a `minimumTrust` context
- The orchestrator now recovers its internal-event backlog after a restart that follows a stop, and shutdown waits for a running catch-up scan
- A refused invoke-gate summon now fails the gate instead of reading as a green skip under `optional: true`
- A workflow triggered by a run completing, or by a failure batch, now runs at the trust tier of the run or runs that caused the event instead of always trusted. Where that cause was untrusted, the workflow loses shared cache scope, is denied a Dockerfile build, receives no install secrets so a private-registry install fails at install time, and is held for approval by any context that sets minimumTrust
- A scheduled or event-triggered run now presents a real branch, so a branch-restricted context can accept it
- Agents that carry a token can now connect to an orchestrator running with agent authentication disabled, instead of being refused and reconnecting forever
- In a multi-orchestrator cluster, a job routed to a peer orchestrator is no longer cancelled mid-execution when it takes longer than the spawn window to finish
- The dependency-cache key is now computed for a repository whose package manager could not be detected from its root, so those repositories get dependency caching instead of a fresh install on every job
- A dependency change now rebuilds the dependency cache: previously a cache miss on dependencies was ignored whenever the workflow source was unchanged, so every job reinstalled from the registry
- Job routing labels and matrix values are no longer dropped by the runs API
- An external (event-scaler) provisioning failure now reports the provisioning cause on the affected job instead of a label-mismatch message
- An orchestrator no longer retains a scaler failure event for an agent that never registered, so a long-running orchestrator does not accumulate them
- On a multi-orchestrator cluster, a provision another coordinator adopted is no longer reported as a failed external provisioning
- A pull request whose run ends before any job starts now completes its KiCI check runs, so the pull request reports a failure instead of staying pending forever
- A job gated by both a reviewer approval and a security trust hold now requires both to be released, and kici approve and kici reject take --hold-type or --hold to name which one
- The org fork policy now governs pull requests that arrive on the orchestrator's own GitHub webhook route, not only those relayed from the Platform; before this, such a pull request was dropped whatever the org had chosen
- The self-approval gate now fires for every actor type. When `allow_self_approval` is off, an approve from the principal that triggered the run is refused whether that principal is a user acting through an agent, a service account, or a system component — previously only a plain user was recognised, so the other renderings were admitted
- A held job is no longer dispatched when the orchestrator cannot read its hold rows. The pre-dispatch hold check now retries a failed read and then refuses, leaving the job pending for the next release or the scheduler recovery pass, instead of treating an unreadable gate as an open one
- A dispatch that fails part-way now completes the queued `kici/…` checks it had already posted. An infrastructure error — a rolled-back hold transaction, a lost connection — used to leave those checks queued forever, which blocks branch protection with no explanation
- A pending security check is no longer stranded by a transient database error. The orchestrator records an accepted check post on the hold rows with a bounded retry, so a lost connection between the post and the record no longer leaves a check on the commit that nothing can close
- A webhook delivery whose pipeline throws now records a `failed` event-log row on every ingress, under the delivery's resolved organization. Direct-ingress failures previously appeared only in the orchestrator's own log, so the dashboard's failed-delivery count could never be non-zero for them
- The CI trust approval expiry editor no longer widens a sub-hour window. It now takes an amount plus a unit (seconds, minutes, or hours) and saves the exact value, instead of reading and writing back the rounded-up hours view — which turned a stored 90-second window into an hour on the next save
- Global-workflow policy repository lists now reject negation patterns ('!…') at write time; a stored negation entry fails closed (grants nothing on the allow list, blocks on the deny list) instead of silently inverting.
- Global-workflow policy repository lists now reject the regular-expression negative assertions '(?!…)' and '(?<!…)', which the matcher compiled into a real inversion — an allow-list entry of '(?!myorg/legacy)**' allowed every repository in every organization but the one it named. The character class '[!a]' is no longer refused: it is a literal class, not a negation.
- Re-running a failed global workflow evaluation round now looks up the original delivery within the run's own organization, so a delivery id another organization supplied can no longer be read.
- The webhook delivery decision trace no longer shows commit messages, comment bodies, or changed-file lists to members without event_log:read_payload
- A re-run of a failed organization-workflow evaluation posts success on the gating check only when the re-evaluation actually reached a verdict. A pass that could evaluate nothing leaves the check as it stands, so a merge gate is never cleared by work that did not run.
- Re-running a failed organization-workflow evaluation no longer times out: the request is accepted immediately and the re-evaluation runs in the background, like the push that first triggered it
- A workflow-level approval gate now also applies when the job's context raises its own reviewer hold
- A context concurrency limit now counts the jobs one dispatch admits against each other, so a matrix job bound to that context admits at most that many children
- A scaler-started agent that re-registers with no spawn record is now refused instead of being treated as a static agent, so it can never lose its mandatory-labels gate.
- Approving or rejecting a held run answers when the decision is recorded, instead of timing out behind the resume it starts
- Scaler taint gates are now per label set, so a scaler mixing platforms no longer makes its own label sets unroutable
- A job gated on `needs` no longer dispatches when a concurrency or approval hold is released while its upstream is still pending, and is skipped when its upstream failed
- A job the needs gate skips, and a scheduler-ready job whose dispatch is rejected, now terminalize their own tracked job instead of leaving it pending
- A job released from a hold no longer runs over its context concurrency limit
- A scaler agent refused for a missing spawn record now has its compute reclaimed on the host that spawned it, instead of looping on reconnect while its resources leak. This covers a Firecracker VM and a container-mode bare-metal agent. A bare-metal agent running as a plain process is still reclaimed only while the orchestrator that spawned it is running.
- An event-scaler provision that a peer adopted is no longer reported as a failed provision after its spawn record is torn down
- The published GitHub Actions teardown workflow now cancels only genuinely stranded runner runs (spawn-timeout, heartbeat-timeout) instead of cancelling healthy ones on shutdown
- `kici-admin variable set --value` no longer warns that it put "the secret" in your shell history — a context variable is plaintext by design, and the warning now names the value
- diagnostic bundles now redact KiCI API keys, personal access tokens, cluster join tokens and fine-grained GitHub tokens, and kici report --no-redact leaves the bundle unredacted as documented
- Bump the DHI Node base image to 24.20.0 across the orchestrator, agent, and platform images — including the portable Node runtime mounted into every job container — refresh runtime dependencies to their current in-range releases (aws-sdk, jose, picomatch, pg-boss, react-router, mantine, tanstack, eslint, vite, vitest, and others), and move the quickstart compose example to seaweedfs 4.44
- Scaler resource gauges from an event-backed scaler now reach the hosted Platform: the metrics catalog admits every scaler backend type on the `scalerType` and agent `scaler` labels, so an `event` scaler's CPU and memory series are no longer dropped as `bad_label_value`.
- A dashboard-write policy change now takes effect on every coordinator in a high-availability cluster, not just the one that served the kici-admin write.
- Context concurrency limits are no longer exceeded while a dispatched job is still starting up
- The quickstart object-store image now carries the patched openssl (SeaweedFS 4.45)

### Documentation

- Event scaler docs now lead with the claim-code self-bootstrap flow, and the agent protocol reference states correctly when an agent may redeem a claim code
- Operator docs for what happens when external (event-scaler) provisioning fails, the retry backoff, and its three cluster settings
- A copy-pasteable GitHub Actions agent workflow now ships in examples/github-actions-autoscale/, and the autoscaling docs link to it

### Other

- Refresh runtime and build dependencies to current in-range releases (aws-sdk, playwright, mantine, eslint, stripe, pg, recharts, react, and others)
- Removed the orchestrator's test-only fault-injection env knobs (KICI_TEST_MODE and the KICI_TEST_* and KICI_SKIP_S3_SENTINEL_VALIDATION family) from the shipped customer artifact; fault injection now lives only in a build-time test double that never ships
- buildAgentCloudInit token-baking (CloudInitCredentials) deprecated in favor of claim-code delivery (ClaimCodeCredentials); removed at v1.0.0
- An internally-triggered run packs its source through a build job before its own jobs, so it needs an agent with the kici:role:builder label
- Deprecated: the unknown-contributor and workflow-change trust policy arms, the fork policy value reject, the per-member CI trust override, and the known trust tier — see the deprecations ledger
- Protocol version 2: the orchestrator and Platform negotiate version 2 so a fork policy of ignore reaches the orchestrator; version 1 peers stay accepted and receive the equivalent deny value

## v0.5.0 — 2026-08-15

### Features

- A succeeded init step with no log output now reads as an affirmative green check in the run log viewer, instead of a neutral gray "No log output" line — so a dynamic env/context/concurrencyGroup field that resolved with no output is visibly confirmed rather than looking blank.
- Add a `requires` content-filter field to the push, pr, and tag triggers: filter workflows by the JSON/YAML/text contents of a source file at the event ref before dispatch.
- Lock-file and content cache sizes and TTLs are now cluster-configurable via kici-admin cluster-settings (applied at the next orchestrator restart)
- SDK: workflow-level `filter` predicate, plus `sourceRepo` / `workflowRepo` on the generator and rule contexts
- Lock schema v34 records whether a workflow declares a filter predicate
- A global workflow can declare a filter predicate and generate jobs per source repo, evaluated once per push before any run is created
- The global eval round budgets and its result-cache size are cluster-configurable
- A failed organization-workflow evaluation is surfaced as an errored run and a commit check
- Organization workflow evaluation now records why a workflow was excluded, and reports round timing, verdicts, and cache behavior as metrics
- A workflow in the repo it runs against can declare a filter predicate, evaluated before any of its jobs is dispatched
- kici-admin runs logs prints a page of one step's log lines, including the evaluation round of an organization-wide workflow — the only path to that output, since such a round records no run of its own
- Run detail names the repo that defines an organization-wide workflow in a new Defined in row, so a cross-repo global run is distinguishable from an ordinary one
- New cluster setting: kici-admin cluster-settings --ingest-overflow-claim-timeout-ms bounds how long a queued webhook delivery's claim may stand before the drain pass reclaims and retries it
- Triggers can now gate on the commit message with commitMessage (contains, notContains, matches, notMatches), evaluated by the orchestrator with no evaluation job; requires gains the same literal contains / notContains / notMatches keys for file contents

### Fixes

- kici types output is now deterministic (no generation timestamp), so regenerating never produces a spurious diff
- Dynamic env/context/concurrencyGroup functions are now always resolved on the eval agent; the orchestrator no longer evaluates any workflow code in-process. The W101 purity-fallback compiler warning is removed.
- Trigger branch/tag/repo patterns, comment bodyMatch, and embedded JSONPath /re/ regexes are now ReDoS-checked and rejected at lock registration if catastrophic, matching label selectors
- Global-workflow generators and job rules now receive the source and workflow repo pair before they run
- Step-level rules on a global workflow now receive the source and workflow repo pair, matching job-level rules
- Global workflows now dispatch the jobs their generators produce instead of silently dropping them
- A stuck global eval round no longer blocks the webhook delivery that triggered it
- A global eval round that fails transiently is retried once instead of skipping the workflows
- An organization-workflow evaluation that finishes without deciding anything is now retried and reported
- orchestrator scheduled-job health metrics for the unroutable-probe job are no longer dropped by the Platform, so JobConsecutiveFailures can alert on it
- upgrade agents to v0.5.0 before the orchestrator — an older init-runner cannot evaluate a global workflow, and the orchestrator now says so instead of timing out
- an abandoned organization-workflow evaluation no longer leaves an orphan job queued, and a queue-side fast-fail now settles the waiting delivery immediately
- an organization-workflow evaluation that leaves only SOME workflows undecided now posts the same failing check as one that fails outright, naming just those workflows
- the global eval candidate budget is now validated against the round budget, and a wait ceiling too close to the round budget is raised or refused instead of silently failing every round
- kici compile now refuses an approval gate on an organization-wide workflow (E124) — it was silently ignored, so the job ran with no human release
- an organization-wide workflow authored in a repo behind a different provider than the event's source repo now evaluates — its pre-run round built the workflow repo's clone URL from the wrong provider, so the checkout failed and no filter ran
- an organization-wide workflow's dispatched jobs now clone the workflow repo from its own provider — when the workflow repo sat behind a different provider than the event's source repo, the job was handed a clone URL built by the wrong provider and the checkout failed
- An organization-wide workflow that declares repos: ['**'] now also applies to repositories whose identifier starts with a dot, and a `!`-prefixed exclusion whose wildcard covers such a repo now correctly excludes it
- An organization-wide workflow dropped because the event's repository does not match its repos patterns is now reported in the orchestrator log — one line per delivery naming every dropped workflow, its repo and its declared patterns — instead of disappearing silently
- Step logs from an organization-wide workflow's evaluation round are now readable through the orchestrator admin API — a round that admits its candidates records no run of its own, so its logs previously returned 404
- An organization-wide workflow that runs against another repository now creates a run, so its jobs appear in `kici runs list` / `kici runs show` and the dashboard, report their status, and can be cancelled — previously they executed with no run recorded at all
- An organization-wide workflow that dispatches more than one job no longer finalizes its run before the rest of its jobs are registered, so the run reports the status and duration of every job rather than of whichever one finished first; and a run whose dispatch fails outright is now recorded as failed instead of sitting `pending` forever with nothing able to cancel or reap it
- Re-running a run of an organization-wide workflow that executed against another repository is now refused — from the dashboard and from the orchestrator alike — with an error naming the repository that declares the workflow and the one the run executed against, so you know where to re-trigger it from. The re-run previously resolved the workflow from the repository the run executed against: it failed with a misleading force-push message, or, where that repository declared a workflow of the same name, silently ran that one instead
- The three organization-wide workflow repository lists (blocked source repos, allowed author repos, elevated access) now match a dot-prefixed repository name the same way a workflow's own `repos:` patterns do — a repository identifier is an owner/name pair, not a file path, so `myorg/*` covers `myorg/.github` and `**` covers every repository in the org. A blocked-source entry written with a wildcard previously admitted such a repository; review any list entry that relies on a wildcard to reach or to spare a dot-prefixed name
- A global workflow refused registration by the organization policy is now reported by name, with the organization it was denied under and how to fix it
- A failure while releasing an organization-wide workflow run's pending-jobs hold no longer fails the webhook delivery that dispatched it. Releasing the hold can finalize the run — writing its terminal status, posting the provider check and forwarding to the Platform — so it can fail; that failure previously replaced whatever the dispatch was about to return or raise, turning a completed dispatch into a delivery error and hiding the original fault. Because the delivery id is already claimed for deduplication, a redelivery was then dropped as a duplicate, so the event was lost and any remaining organization-wide workflows for it were skipped. The failure is now logged and the dispatch's own outcome stands
- A run of an organization-wide workflow is now visible to members scoped to the repository that defines the workflow, as well as to the repository it ran against
- A run of an organization-wide workflow no longer completes or reopens the GitHub check run of a same-named workflow in the repository it ran against
- An organization-wide workflow now reports its last-triggered time in the dashboard, and deleting its registration cancels its own in-flight runs rather than none — while deleting a same-named registration in another repository no longer cancels them
- An organization-wide workflow run now stores the webhook payload that triggered it, so its run-detail Payload tab shows the source repo's event instead of failing to load
- The run-detail Workflow link on an organization-wide run now opens the workflow file in the repo that defines it, on that repo's default branch, instead of pointing at the source repo at the source commit
- An organization-wide workflow now receives the event that triggered it in ctx.event, so a workflow author can read the source repository's payload and scope a concurrency group by it
- The Elevated access list for organization-wide workflows is deprecated: it was never enforced, and an organization-wide workflow's job runs with no secrets at all, so clearing the list takes nothing away
- A run that starts past your monthly run cap is now recorded and shown instead of silently missing from the dashboard, and your run usage appears as a meter on the billing settings tab
- Bitbucket run links in the dashboard now resolve — the workflow-file, commit and branch links were built with GitHub's path shapes, so all three returned 404 on every Bitbucket run
- The pull-request link on a GitLab run now opens the merge request instead of a GitLab path that does not exist
- The billing settings tab no longer goes blank when the Platform reports a different set of usage meters than the dashboard expects; an unreported meter is simply omitted
- A team scoped to the repository that defines a global workflow now sees that workflow's historical runs immediately, instead of waiting for the next run to make the repository visible
- Live run subscriptions on the dashboard now honour repository scope: a member restricted to a subset of an organization's repositories no longer receives the live logs, provisioning logs, or status stream of a run outside those repositories, and a cross-repository global run reaches the team that defines the workflow as well as the team that triggered it
- Recovering a dead orchestrator's stuck check runs no longer times out a running check of the same name on the repository an organization-wide workflow acted against
- A `kici run remote` test run is now scoped to the developer who started it: its status, its log stream, and its cancellation are reachable by that developer and by a caller with unrestricted repository scope, instead of by every organization member holding the `runs` permission
- A `kici run remote` test run now records who started it, so the orchestrator dashboard, `kici runs show` and `kici-admin` attribute it to the developer instead of showing no initiator
- Webhook deliveries are acknowledged as soon as they are durably queued, so a slow build no longer times out the provider's delivery attempt; the 202 now means accepted and stored, and pipeline outcomes surface in the event log and structured logs
- A workflow run is now recorded before its first job is handed to an agent, so a job that finishes immediately can no longer have its status dropped and leave the run hanging
- A pre-signed upload that stalls on a wedged socket now fails its attempt after five minutes and retries, instead of hanging until the job timeout kills the step
- A job whose dependency finished almost instantly no longer stalls the run: the orchestrator now re-checks the dependency gates once a run's dependency graph is stored, so a dependency that completed before the graph was written still releases everything waiting on it
- A transient object-storage error no longer fails a build: the agent retries an upload that was answered with an overload or throttling response, and still fails fast on a rejection that cannot succeed on a retry
- A dispatched job can no longer be claimed and executed by two agents at once, which ran a job's steps — and every side effect they perform — twice
- A webhook for a generic or local source is no longer accepted and then silently discarded when the orchestrator has not yet loaded that source's provider settings — the source is now looked up and applied before the delivery is matched
- A completed check run is no longer pushed back to `in_progress` by a step update that arrives after its run finished, which left the check permanently unresolved on the commit despite carrying a conclusion
- The orchestrator now reports why a free agent took no work while jobs were still queued, instead of returning silently on each of the five paths that can decline
- A lost dispatch that is requeued now reliably reaches a connected idle agent: a per-coordinator safety-net re-drive re-attempts delivery through the atomic claim, so a requeued job the one-shot redispatch transiently missed no longer stalls until it expires
- Early step-log lines are no longer lost when a job's logs start streaming before its dispatch record is fully registered
- A test run whose only jobs use a dynamic environment now dispatches correctly and no longer reports 'no jobs dispatched', and a non-test environment's secrets are never merged into a test run resolved through the deferred-init path
- Agent packaging now retries the vendored Node runtime download on a transient network failure and reports the underlying cause instead of an opaque 'fetch failed'
- In an HA cluster, a worker-dispatched job's early step-log lines are no longer lost — the coordinator now records the job name at reroute time so persisted logs land under a readable path
- A test run of a workflow with a dynamic environment now materializes its workspace from the uploaded overlay instead of attempting an empty git clone, so the init job resolves against the real source tree
- When a test run skips a non-test environment resolved through a dynamic context, the 'unavailable for this test run' warning is now surfaced to the CLI and persisted on the run, matching the synchronous dispatch path
- The run-mirror reconciler now retires an orphaned run (one whose owning orchestrator no longer has it, e.g. after an orchestrator database reset) to a terminal cancelled state instead of leaving it non-terminal forever
- The auto-scaler no longer leaks resource-cap capacity when an agent is spawned but never registers: its reservation is now released when the stale spawning entry is pruned, so a scaler can no longer drift into a permanent at-capacity state that stops all further scale-up after a leader failover or restart
- Agent metrics (kici_agent_*) and agent runtime metrics are no longer dropped by the hosted Platform when a scaler is named differently from its backend type — the scaler label now carries the backend type
- kici run remote no longer 504s on large repos: the Platform gives the trigger relay its own longer timeout

### Other

- The global workflows master switch is now cluster-wide: enable it with kici-admin cluster-settings set --global-workflows-enabled true. It is off by default after upgrade, the per-org switch and its dashboard toggle are removed, and the per-org allow, deny and elevated repo lists are unchanged

## v0.4.0 — 2026-08-09

### Fixes

- Reject secret keys outside [A-Za-z0-9._-] on every write path, so the at-rest encryption binding cannot be made ambiguous

## v0.3.0 — 2026-08-09

### Features

- Jobs whose runsOn matches no agent or scaler now surface the reason immediately and fail within a short grace window instead of waiting out the queue timeout

## v0.2.0 — 2026-08-08

### Features

- Add an open-source page documenting how to run the orchestrator and agent fully self-hosted, receiving git webhooks directly without the hosted Platform
- kici init offers a workspace-integrate mode so workflows can import your other pnpm/npm/yarn workspace packages
- Add workflowsFailedBatch() SDK trigger: accumulate failed workflow runs over a window and notify once per batch
- kici notifications CLI to manage org notification channels, subscriptions, and Slack roster
- Add a self-contained example global workflow that posts a Slack notification (routed per repo) whenever any workflow fails org-wide
- Test notifications now appear in the org delivery log, marked with a Test badge
- kici run --local auto-reboots the warm dev plane when the installed CLI build changes (keeps its data)
- The orchestrator now durably buffers webhook deliveries shed under overload and automatically replays them once capacity recovers, so bursts past the ingest limit are no longer dropped (bounded and idempotent; on by default).
- ctx.emit now accepts a defineEvent() definition so the event's Zod schema type-checks the payload at compile time
- kici-admin source subcommands (list, add local, update-local, enable, remove, update --customer-id) now support --database-url for direct-DB offline operation
- Direct-DB kici-admin subcommands (db, host) now write access-log rows, so the audit trail is the same whether you act over HTTP or straight against the database.
- Admin tokens support opt-in expiry; support sessions enforce a 24h lifetime cap and re-check org eligibility on renewal
- Lock files use a compatibility window: additive SDK updates no longer require simultaneous orchestrator upgrades
- Version skew between an orchestrator and the Platform now produces a diagnosable error naming the unsupported message type instead of a silent drop
- Scaler config: declare a pool's platform with a structured 'platform: { os, arch }' field; the OS/arch labels and the mandatory platform taint both derive from it, so a non-Linux pool is correctly gated even with non-canonical labels.
- Interactive setup wizard is now the default for kici-admin orchestrator install
- Job containers are hardened by default: all Linux capabilities dropped, no-new-privileges set, and pids/memory/CPU cgroup caps enforced, with `KICI_SANDBOX_*` knobs to tune the posture
- kici init scaffolds workflow runsOn labels matching your host OS, warns when a local run targets a different OS, and offers to run your first workflow immediately
- Add kici doctor, a setup diagnostic that walks the onboarding funnel and prints the exact next command to fix the first broken step
- Cross-job outputs are fully typed: job references thread their inferred output types through needs, ctx.needs, and jobOutputs
- Add @kici-dev/sdk/testing with createTestStepContext() for unit-testing step functions in Vitest
- Compile and validation errors now report the real `file:line:column` of the offending job or step instead of a generic line 1, and `kici compile --check` additionally type-checks your workflow sources (`tsc --noEmit`) so type-broken workflows surface their errors at compile time.
- kici-admin orchestrator drain: quiesce a coordinator before upgrading
- kici-admin db backup/restore: back up and restore the orchestrator database
- Orchestrator auto-provisions the Firecracker host bridge on startup (autoProvisionHost, default on)
- Silent webhook misconfigurations are now visible: edge-rejected deliveries (unknown source, rate/size cap) appear in the event log, and the Runs page and 'kici runs' surface a 'webhooks arriving but 0 matched' hint with a 'kici preview push' next step.
- ctx.artifacts: named, durable build artifacts shared between jobs and downloadable from the run page
- kici-admin agent package produces self-contained fresh-box agent payloads (vendored Node + real installed agent) that boot with no system Node
- ensureInitRunner boots agents on bare boxes by staging a self-contained agent + Node + npm payload over SSH
- job containers now run hardened by default: all Linux capabilities dropped, no-new-privileges, resource caps (pids/memory/CPU), and a private tmpfs /tmp — matching the bare-metal sandbox posture and adding the cgroup resource caps it never had. Container jobs also honor KICI_SANDBOX_NETWORK=host (host networking with the host /etc/hosts bound read-only) and read-only binding of a local file:// clone source. Roll back the hardened defaults with KICI_SANDBOX_HARDENED=false
- Distribute fresh-box agent payloads via the orchestrator cache bucket with per-host presigned delivery (direct S3 pull or SSH-push fallback)
- Fleet agent auto-upgrade: orchestrator upgrade auto-packages agent payloads and an availability-gated convergence check-step rolls the permanent fleet to the orchestrator's version
- Personal Slack notifications now connect with Sign in with Slack instead of typing your email
- Personal Slack notifications: after connecting your Slack identity, choose Slack (a direct message to you) or email when adding a personal run notification
- Slack actor-tagging roster now validates a KiCI-user/email subject against the user directory at add time, offers a searchable user picker, and shows each row resolved to the user's email
- Export the Activity feed as newline-delimited JSON: an Export JSONL button (and streaming API) downloads the current filtered activity/audit view, including archived rows
- Build provenance is now signed and verified by your own orchestrator: it owns its ES256 signing key, publishes its own OIDC discovery + JWKS, mints identity tokens locally, and exposes a native verify endpoint — so builds produce verifiable provenance with zero hosted-Platform dependency. The hosted Platform mint is deprecated (existing Platform-signed bundles keep verifying); kici verify-attestation now defaults its trust root to your configured orchestrator.
- Per-job sandbox escape hatch: request extra Linux capabilities or host networking for a container job, granted only within an operator-controlled allow-list (denied requests fail the run loudly)
- SDK: ctx.mktemp() / ctx.mktempFile() allocate a scratch directory or file that is cleaned up automatically when the job ends, with an idempotent cleanup() you can also call manually.
- KICI_TMPDIR routes KiCI temporary files (repo clones, build scratch, deploy render dirs) onto a chosen volume
- Dashboard-write policy gains an 'encrypted' posture for secret and variable writes
- Document the encrypted dashboard-write posture and its two trust tiers
- Cluster-global dashboard verified-issuer setting for encrypted dashboard writes
- kici-admin dashboard-encryption-key show/list/rotate for the browser-sealed dashboard-write key
- `kici runs artifacts list` and `kici runs artifacts download` list and fetch a run's build artifacts from the terminal — the download streams straight from object storage over a short-lived signed URL and verifies the content hash end to end
- Add the `observed` orchestrator mode: webhooks are ingested directly by your orchestrator (nothing transits KiCI) while the hosted dashboard keeps full run, job, step, log, and event visibility.
- the Verified dashboard-encryption tier no longer requires configuring a build-attestation issuer
- kici-admin warns when a verified issuer origin publishes no dashboard-encryption key
- kici-admin gains 'secret scopes --all-backends' for cross-backend scope listing and 'secret fix-prefixed-scopes' to repair scopes stored with a stale backend qualifier
- The org trust policy (fork PR, unknown contributor, workflow change, approval expiry) is now enforced by the orchestrator. Behavior change: orgs on the documented defaults will start seeing fork-PR and unknown-contributor holds that previously never occurred, and security holds now expire after the org's approval expiry (default 72h) instead of a fixed hour.
- kici-admin check-run list reports the check runs the orchestrator posted for a commit
- Runs now report a job whose runsOn matches no agent as unroutable and fail the run, instead of finishing green with the job never having run
- kici local status gains --json for machine-readable plane state

### Fixes

- Slack and GitHub connect now work reliably across the Platform fleet (OAuth CSRF state moved to shared storage; error redirects target the dashboard)
- Overlapping glob environments now resolve to the most-specific pattern deterministically
- Bare-metal jobs no longer route to a scaler of the wrong OS/architecture
- Rerouted jobs recover from a peer spawn failure instead of hanging until stale detection
- Orchestrator step logs on S3 now use append-only segments, eliminating write amplification and a concurrent-overwrite log-loss race (single-shot payload writers unchanged)
- Ephemeral container agents now default to IfNotPresent image pulls (set imagePullPolicy: Always on a label set to re-pull every spawn) and the auto-scaler throttles concurrent agent provisioning per backend, preventing a registry and container-socket storm on a burst of queued jobs
- Firecracker orchestrator hosts no longer wedge NetworkManager at 100% CPU (unmanaged-devices drop-ins now use the += append operator so they don't clobber each other)
- kici-admin upgrade is now self-driving (recovers the unit's pinned node + owning package)
- Firecracker guest networking now works on hosts that also run Docker: bridge provisioning accepts the microVM subnet in Docker's DOCKER-USER chain, so Docker's default FORWARD DROP policy no longer blocks guest internet/NAT.
- Reject out-of-union webhook verification_method as misconfigured instead of throwing
- reject invalid manual-approval timeout values
- Fix ungrammatical 'an context' text in the secrets scope tree
- kici-admin stop/uninstall no longer error when the named service isn't installed — they exit 0 as a no-op
- Agent bare-metal bring-up: the ephemeral ssh-agent teardown no longer inherits a parent/login SSH_AGENT_PID, so it can never signal the wrong ssh-agent when the agent's start output fails to parse.
- Orchestrator install wizard now defaults the Platform relay URL to wss://api.kici.dev/ws
- kici init's AGENTS.md now teaches the correct matrix and secrets APIs
- Id-less steps' .result now resolves; previously it always threw even after outputs existed
- Master-key rotation now re-encrypts external secret-backend configs; stranded backends self-heal at boot while the old key is configured
- Path filters match conservatively when the changed-files diff is unavailable (universal-git pull-request events no longer silently skip); GitHub changed-files fetch failures retry on 5xx and report a distinct degraded error instead of being treated as an empty diff
- Terminal job and step status now survive an agent disconnect at completion instead of being silently dropped, so a finished run no longer sits Running until stale detection
- Scaler re-dispatches queued at-capacity jobs the moment capacity frees (hook + leader-gated sweep), instead of letting bursts above pool capacity time out
- Webhooks are buffered and replayed when no orchestrator is connected, instead of being dropped with a 503
- kici compile now surfaces impure context/env/concurrencyGroup functions as a visible W101 warning (naming the reason and the ~5-10s init-job cost), and kici preview lists the injected `__init__` job
- kici-admin routes diagnostic logs to stderr so --json output stays pure, machine-parseable data
- Within-job step .result now resolves at runtime on the agent
- kici run --local (no --trusted) no longer leaks the ambient host environment into a sandboxed step: the trusted local-plane profile is now taint-gated so a default run can never be dispatched to a lingering idle trusted agent
- Reroute recovery now verifies the source peer, so a superseded peer's stale signal cannot bounce a healthy rerouted job
- Clustered orchestrators no longer log a duplicate-key error when two coordinators restart together and a run arrives before agents are warm — a rerouted job's re-enqueue is now an idempotent no-op.
- scaler provisioning no longer stalls when a container runtime or registry hangs — a bounded, per-org spawn timeout aborts the hung provision and frees the queue
- Agent SSH bootstrap no longer crashes on a dropped stdin pipe (EPIPE) during pre-boot unlock
- Config-init template now shows the correct Platform WebSocket URL (wss://api.kici.dev/ws) instead of a non-existent example host
- Bare-metal bwrap sandbox now exposes host name-resolution files (/etc/hosts, nsswitch) so host-network workflows resolve local hostnames correctly
- orchestrator install wizard now prints a ready-to-run source-add command instead of discarding the GitHub App source; kici-admin source add github --webhook-secret - reads the secret from stdin
- Ignore stray terminal job updates from a superseded peer after a reroute so they cannot wrongly terminalize a run or strip the replacement's spawn-window backstop
- ctx.changedFiles now reflects the real diff for job/step rules on remote runs (was always empty)
- A rule whose check() throws now fails the job/step instead of silently skipping
- Notification roster now shows an error when adding a Slack mapping fails, and add forms sit above their lists
- Slack notifications: the Connect Slack button now sits above the workspace list for quicker access.
- kici run --local now follows the run its own trigger created (fixes a wrong-run report on back-to-back local runs)
- Worker-spawned agents now honor the cluster-wide agent_token_ttl_ms (previously only leader-spawned agents did)
- Upgrade the Node HTTP server adapter to @hono/node-server v2 (WebSocket memory-leak DoS fix) across orchestrator, agent, and platform
- agent package upload/refresh no longer requires the orchestrator's DB/platform runtime env or a KICI_*-clean shell — it validates only the object-storage config
- Circular-dependency (E102) errors now list only the jobs actually on the cycle
- KICI_TMPDIR now routes the agent's main temp allocations (caches, workdirs, pnpm stores), not just a few sites
- `ctx.secrets.list()`, `ctx.secrets.mountFile()`, and `ctx.secrets.exposeFile()` no longer disappear from the type surface after running `kici types` — generating typed secret keys now narrows only the `get`/`expose` key parameter and preserves every other secrets accessor
- Container-sandbox jobs that execute from `/tmp` (npm/pnpm install scripts, tools that stage a binary there) no longer fail with `Permission denied` under Docker — the hardened `/tmp` tmpfs now sets explicit `exec,nosuid,nodev` options instead of relying on the runtime default, which Docker (unlike Podman) mounts `noexec`
- Container-sandbox jobs now pull their image on demand instead of failing with `No such image` when it is not already cached locally — `createContainer` (unlike `docker run` / `podman run`) never auto-pulls, so a job whose image was never pulled, or was reaped by a disk-pressure image prune, previously failed to start
- SDK: void run-shorthand jobs now typecheck when placed in a workflow's jobs[]
- verify-attestation --trust-root help text now names the configured orchestrator as the default trust root
- Agent: same-step ctx.setEnv/ctx.addPath is now visible to that step's own ctx.$ subprocesses
- Test step-context builder now restores process.env on dispose() and no longer deletes pre-existing host env vars during secrets cleanup
- Workflows with multiple schedule() triggers now fire every schedule, not just the first
- Orchestrator: a transient database error during leader election no longer disables scheduled (cron) workflows for the rest of the leadership term — evaluation now starts with a cold cache and self-heals on the next tick.
- /kici approve and /kici reject now only affect the held runs of the PR the comment was posted on
- Non-trusted PRs that modify workflow files now create a real, approvable security hold instead of a check that never resolves
- Orchestrator concurrency limits are now scoped per org, so a context name shared across tenants no longer counts against another tenant's maxConcurrent
- Orchestrator: clear the coordinator-routing timeout timer on fast dispatch, and manually-triggered scheduled runs no longer fail wholesale when one matrix job can't expand
- kici run test dispatch now preserves per-host secret scoping for fan-out (runsOnAll/matrix) workflows instead of degrading to fleet-wide resolution
- Reject malformed secret scope names on create, rename, and set
- kici run remote tolerates a not-yet-visible run right after trigger
- kici login now uses the browser (PKCE) flow on WSL instead of the device flow
- kici login detects a container via the /run/.containerenv and /.dockerenv sentinel files, so a container that sets no env marker still gets the device flow
- `kici login` no longer treats the conventional `CI=false` opt-out as a CI environment, so a desktop shell that exports it keeps the browser login flow.
- Orchestrator verifies the artifact storage key and size server-side on upload complete (agent-supplied values are no longer trusted)
- Artifact uploads now fail the step when the orchestrator cannot commit the artifact, instead of silently succeeding
- Artifact upload and download failures caused by orchestrator misconfiguration or internal errors no longer surface to workflows as a misleading storage-quota rejection or a missing-artifact error
- Artifact uploads reject a name that violates the artifact-name contract at the orchestrator, so a name that would collide with another artifact's storage key fails the step instead of overwriting it. The contract now also refuses a name made only of dots (`.`, `..`) — such a name has to be escaped into a storage segment a literal name can already address — so `ctx.artifacts.upload()` rejects it too
- Dashboard sources tab: the `kici-admin source get-webhook-secret` hint now shows only for GitHub App sources (the command does not resolve for generic or universal-git sources), and a source with no pushed name no longer renders its routing key twice.
- Orchestrator: a job whose several upstream jobs finish at the same instant is no longer dispatched twice — the needs scheduler now honours its claim on the ready transition, so only one evaluation dispatches the job.
- Outbound webhook deliveries now use a durable queue with a backstop sweep, so a Platform restart during a retry backoff no longer strands deliveries as permanently pending
- Webhook endpoint URLs must now be https and point at a publicly routable address — private, loopback, link-local, and other reserved targets are rejected when you save the endpoint and refused at delivery time, with the connection pinned to the validated address so a hostname cannot re-resolve to a private one. Redirects are no longer followed; a `3xx` is recorded as the delivery result
- Webhook test ping now answers 404 for an endpoint that is not yours and reports a rejected delivery as not delivered, instead of always reporting success
- Orchestrator: a healthy long-running workflow is no longer force-failed by its own orphan recovery on a single-node deployment.
- Installed systemd services now honor the configured 5-minute restart window
- On WSL, `kici login` now falls back to the device flow when Windows interop is unreachable, instead of waiting five minutes for a Windows browser that cannot open. An SSH session that kept only `SSH_CONNECTION` is now recognised as headless too.
- kici login now points you at 'kici login --device' when the browser never reaches the local callback, instead of telling you to retry the command that just failed. It also prints a reminder after 90 seconds of waiting, so a blocked callback no longer means five minutes of silence
- Orchestrator admin API decodes `:name` / `:key` / `:routingKey` / `:scope` path params exactly once, so a backend name, context variable key, routing key, or secret scope containing a literal `%` no longer returns a 500 or targets the wrong resource.
- CI detection is now consistent across the CLI: `CI=0` no longer forces the device flow, and every command reads the same convention — `0` and `false` (any case) are opt-outs, an empty or whitespace-only value counts as unset, and anything else means CI. Three behavior changes follow from unifying the readers. If you export a truthy non-`true` value such as `CI=1` in an interactive terminal, `kici init`, `kici hook install`, the post-install prompt, and `kici-admin orchestrator install` now treat it as CI and skip their prompts. Those same commands now also honor a bare `GITHUB_ACTIONS` / `GITLAB_CI` marker even when `CI` is unset, where before only `CI=true` suppressed prompts. And `GITHUB_ACTIONS=false` / `GITLAB_CI=false` are now opt-outs for `kici login` rather than counting as CI.
- Artifacts whose names differ only by case no longer overwrite each other on a case-insensitive storage backend such as the filesystem backend on macOS
- A failed artifact upload-complete now reports a fixed, classified reason instead of the raw orchestrator exception, so database and storage detail no longer reaches workflow logs
- A bad artifact name now fails with a readable message instead of a raw validation dump
- An artifact upload no longer fails when the connection drops while its commit is being acknowledged
- Turning off a context's required reviewers, hold expiry or concurrency strategy from the dashboard Protection tab now persists instead of silently keeping the old value
- The dashboard Verified encryption tier is now explicit opt-in and is no longer enabled by the build-attestation issuer setting
- The orchestrator serves CORS headers on its .well-known endpoints so browsers can fetch its published keys directly
- A change to the dashboard verified-issuer setting now reaches connected dashboards within seconds instead of waiting for the orchestrator to reconnect
- orchestrator accepts KICI_ORCHESTRATOR_URL so bootstrapped and scaler agents on other machines can dial back
- A run is no longer reported complete before its post-build jobs have run
- Held runs report one hold-type vocabulary, so approval and wait-timer holds render with their proper badge
- Held-run lists no longer fail when a wait-timer hold has been released
- A failing step now records its error in the run log, and stdout/stderr are stored as distinct log streams
- Run-log forwarding from a worker orchestrator to its coordinator now sends the shape the coordinator expects, so the relayed step-log chunks are accepted instead of being rejected as malformed
- The truncation notice on a failing step's log entry now reports the real number of dropped lines and characters instead of zero for whichever cap did not fire
- A job that fails mid-execution now flushes the step output it had already buffered, so the run log keeps the failing step's last lines instead of ending mid-step
- A malformed or duplicate matrix now fails with a clear error instead of expanding into garbage jobs
- Matrix include entries render their dimensions in the same order as their expanded siblings. An include entry used to keep the key order you wrote it in, so its child job printed its values back-to-front next to every sibling combination. If you wrote an include entry's keys out of alphabetical order, that child's job name changes accordingly — and so does the `byMatrix` key a downstream job reads its outputs under. Two include entries that only looked distinct because their keys were typed in different orders now render the same name, and the duplicate guard refuses the fan-out with an error naming the collision.
- The diagnostics `kici-admin` command for a systemd / launchd orchestrator resolves the shim from npm's real global bin directory, and falls back to a PATH-resolved bare `kici-admin` when no shim can be located (was a path assumed to sit next to node, which does not exist when npm's global prefix differs from the node install prefix)
- The diagnostics kici-admin command names the Windows .cmd launcher npm actually installs, and shell-quotes a pinned bare-metal invocation whose paths hold whitespace
- The orchestrator ignores stray whitespace around the KICI_DEPLOY_MODE and KICI_DEPLOY_CONTAINER_RUNTIME env vars instead of reporting an unknown deployment shape
- Cold-store reads derive their time bound from the same warm TTL archival uses, so lowering a per-table KICI_COLD_STORE_<TABLE>_WARM_TTL_DAYS override no longer hides archived rows
- held runs now record the job name, so kici approve --job resolves concurrency, wait-timer and security holds
- kici approve and reject now list the candidate holds when a run has several, instead of only asking for --job
- kici login no longer hangs on a wedged WSL mount, and names an unusable KICI_CALLBACK_PORT (busy, privileged, or out of range) instead of crashing
- orchestrator error replies to the agent no longer include raw internal exception text
- User-cache entries whose keys differ only by case no longer collide on a case-insensitive storage backend, so a restore can no longer return another key's tarball.
- The filesystem cache backend now prefix-matches restoreKeys, so a cache restoreKeys fallback finds matching entries instead of silently missing.
- kici runs artifacts download now refuses, before writing anything, when two of a run's artifact names differ only in case and the output directory is on a case-insensitive filesystem
- kici local down now verifies the plane port is released before reporting success, and exits non-zero when it cannot; kici local status reports a running-but-not-ready plane, and reports a port held by a process that is not a KiCI plane orchestrator without pointing at a teardown that refuses to touch it; kici local up fails with the reason the port could not be freed instead of a readiness timeout; a local run fails fast when no agent claims it
- kici local status and kici local down no longer hang on a plane whose port answers the connection but not the request, and a plane process that survives being stopped is now reported as still holding the port instead of stalling the command
- Admin secret routes now require an unscoped admin token; routing-key-scoped tokens get a clear 403
- kici-admin context set-policy --hold-expiry "" now clears a context's hold expiry instead of being silently ignored
- A context hold expiry of 0 seconds is now rejected — it made every reviewer hold expire the instant it was created
- A context created without a hold expiry now uses the documented one-hour window instead of holding for 24 hours
- a transient orchestrator DB read no longer downgrades the Verified dashboard-encryption tier
- Scoped-secret writes now accept a backend-qualified scope (e.g. pg:production) on every write plane, instead of failing with a scope-name validation error
- Artifact uploads and other job-scoped agent messages now survive an orchestrator coordinator failover
- A workflow run is no longer reported complete while jobs from an init step, a dynamic job function, or a source-pack build are still being registered
- Worker-dispatched job logs are now persisted and visible in the dashboard
- held runs from an orchestrator that has not yet upgraded now show the correct hold-type badge and controls
- Approving or rejecting a security hold now requires ci_trust:write, and every other hold type requires contexts:write — enforced server-side instead of only in the dashboard's button gating
- kici runs now colours a timed-out job red instead of gray
- Outbound webhooks now fire job.failed for timed-out and drift-dropped jobs
- Notification digests mark timed-out and drift-dropped jobs as failures
- kici-admin runs can now filter by held and cancelling
- when: 'on-failure' now also runs when an upstream job was dropped by determinism drift
- Repo-restricted roles are now enforced on workflow registrations and held-run approvals; secrets are documented as governed by permission level and context, not repo patterns
- Cancelling a run that already finished is now a no-op instead of overwriting its recorded result. Runs whose status, completion time or job statuses were overwritten by an earlier raced cancel keep the `cancelled` values they were given — those fields were replaced in place, so there is nothing to restore them from. Step logs were never affected.
- Reading or rerunning a single workflow run now stops at your plan's run retention window, matching the run list.
- A cancel that loses the race against a run finishing no longer reports a cancellation it did not perform, and no longer stamps the run's cancellation attribution
- Approving, rejecting, or skipping a wait-timer hold now requires `contexts:admin` on every surface — the server enforces what the dashboard and the documentation already promised
- The developer MCP `approve_run` / `reject_run` tools now require the hold's own permission in addition to `runs:write`, so an agent credential whose CI trust level is below `write` can no longer release a security hold
- The dashboard's hold controls now honour a per-member CI trust override that lowers a member's authority, and require `contexts:admin` to act on a wait-timer hold, so the page stops offering controls the server refuses
- Organization global workflows no longer run for a pull request the org trust policy holds or rejects -- reported on its own 'KiCI: Organization workflows' check so the security check keeps showing the hold -- and forkPolicy 'allow' now dispatches a fork PR
- The Platform now pushes the documented trust-policy defaults to an org that has no policy row, so such orgs also receive identity links instead of no push at all
- kici-admin check-run list now shows TERMINAL_SENT, so a check run stuck at queued is attributable to us or to the provider
- The diagnostics kici-admin command now pins the Windows launcher path and shows a separate copyable form for cmd.exe and PowerShell
- kici-admin trust-policy now requires the dedicated ci_trust permissions, audits every write, and reports no policy values when only legacy enforcement is in force
- the Platform run view no longer reports a terminal status the orchestrator never recorded (e.g. a run that succeeded reading as failed)
- A run no longer reports success when a job it declared never dispatched: the job is tracked from the moment it is queued, settles unroutable when nothing in the fleet matches its runsOn, and the unmatched selectors are named on the run
- The orchestrator JWKS endpoint now reports no_published_keys when it has no key to publish, instead of incorrectly reporting a missing provenance issuer.
- dashboard secret writes on a pg:-qualified scope now use the configured PG store, so pgCustomerSecrets, the resolved key version and the old-master-key fallback all apply
- renaming a secret scope across backends is refused with a 400, and renaming onto an occupied scope is refused with a 409 instead of silently merging the two
- The orchestrator's admin API now returns a structured `503 Authentication unavailable` when it cannot reach its database to validate an admin token, instead of an unstructured `500`. Invalid and missing tokens continue to return `401` unchanged, and a best-effort token-usage bookkeeping write can no longer fail an otherwise valid authentication.
- `kici-admin secret fix-prefixed-scopes` reports a scope whose bare target is already taken as SKIPPED and repairs the scopes behind it, instead of stopping the whole repair on the first such collision
- jobs that end skipped, drift-dropped, or unroutable now resolve their GitHub check run instead of leaving it queued forever
- Orchestrator: check-run tracking rows are now pruned on a configurable retention window instead of growing without bound
- Repo-scoped callers no longer see held runs outside their repository patterns
- A held-run approval refused for repository scope no longer reveals the hold's type
- Package builds now remove declaration files whose source was deleted, so a stale .d.ts no longer ships in the published tarball
- Setting KICI_ORCH_RECONNECT_REPLAY_WINDOW_HOURS no longer prevents the orchestrator from starting
- Orchestrator reconnect state replay is split into bounded frames, so an org with many runs no longer reconnect-loops forever
- Repository-scoped callers keep seeing held runs on manual and cron-triggered runs, which carry no repository, so kici approve and kici reject still resolve them
- An orchestrator running without a secret store now refuses dashboard secret writes instead of reporting success while discarding them

### Documentation

- Add a flagship typed-pipeline example and standardize example runsOn labels to kici:os:linux
- New operator adoption pack: network requirements, upgrade and rollback, and data residency reference pages
- Added an importable orchestrator monitoring pack: a Grafana dashboard and Prometheus alert-rules starter for self-hosted orchestrators.

### Other

- Infrastructure alert type and severity have a shared engine vocabulary; an unrecognised severity now renders at the critical level instead of silently downgrading to a warning
- get_diagnostics connection health badge can now report 'orphaned'
- The `@kici-dev/compiler` package no longer declares `proper-lockfile` as a runtime dependency — nothing imported it

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
