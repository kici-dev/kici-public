---
title: CI security architecture
description: Ref-based trust resolution, the org fork switch, lock file pinning, reduced-privilege execution, and the security approval queue
---

KiCI decides how much privilege a run gets from **the git ref the event carries**, not from who pushed it. A ref that lives in the base repository is trusted: only a contributor with write access can put a ref there. A ref that comes from a fork is untrusted. The orchestrator reads that from the webhook payload alone — there is no provider permission call and no contributor lookup on the dispatch path.

A run with no ref-based signal is evaluated too. A schedule fire or an internal event resolves its tier from the trigger, as [Internal triggers](#internal-triggers) describes.

## Trust tiers

| Tier      | Produced by                    | Lock file source | Install and registry secrets | Build cache      |
| --------- | ------------------------------ | ---------------- | ---------------------------- | ---------------- |
| `trusted` | any same-repo ref (push or PR) | PR head          | delivered                    | org-shared scope |
| `unknown` | a pull request from a fork     | base branch      | stripped                     | isolated scope   |

`known` is a third value the vocabulary still carries. Nothing produces it any more. It survives on run rows written by earlier builds, and a context may still declare it as a `minimumTrust` floor. It is removed at v1.0.0 — see [deprecations](../../user/deprecations.md).

## Trust resolution

Resolution is one comparison, performed locally:

```
Webhook pull_request event
    |
    v
Does the head ref live outside the base repo?
    |
    +-- yes --> unknown  (reason: "Fork PR — the head ref lives outside the base repo")
    +-- no  --> trusted  (reason: "Same-repo ref — pushed by a write-access contributor")
```

A push event carries a ref in the base repository by definition, so it resolves `trusted`.

The comparison needs a provider that models forks. Only the GitHub provider produces the fork signal today. For every other source — a generic webhook, a plain Git remote, a local source — a pull-request event resolves **no tier at all**. That is not a claim of trust: the one question the switch asks cannot be answered for those sources, so they are neither trusted nor untrusted. An unresolved tier isolates the run's caches and denies it a Dockerfile build, and it leaves install secrets in place. [Trust tiers on internal triggers](../../user/events.md#trust-tiers-on-internal-triggers) carries the full table of what an unresolved tier does at each control.

The reason string is recorded for audit alongside the resolved tier and the contributor's provider username.

### Internal triggers

A run triggered by a schedule or an internal event resolves its tier from the trigger instead of from a ref. Four rules apply, in this order:

| Order | Trigger                                                                | Tier                                                        |
| ----- | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1     | A run summoned by an invoke gate                                       | the tier of the summoning run                               |
| 2     | `__schedule_fire`, `kici.scaler.scale-up`, `kici.scaler.scale-down`    | trusted — no run causes these, the orchestrator mints them  |
| 3     | `__workflows_failed_batch`                                             | the most restrictive tier across the failed runs it carries |
| 4     | `__workflow_complete`, `__job_complete`, or a `kiciEvent()` subscriber | the tier of the run that emitted the event                  |

Rule 2 admits only the events **no run causes**. Minting an event is not, on its own, evidence that nothing external shaped the run behind it. The two lifecycle events a single run causes carry that run's id, so they inherit under rule 4. Without that, an untrusted fork-PR run completing would hand its `__workflow_complete` subscriber the shared cache scope and the Dockerfile builds the fork-PR run was denied. That is the escalation the emitter-inheritance rule exists to close, reached through the lifecycle door.

Rule 2 also rests on the orchestrator being the only emitter of those three names, and two independent mechanisms hold that premise.

The first is the reservation. The `__` and `kici.` prefixes belong to KiCI, and a workflow step, an invoke gate, and the compiler each refuse them.

The second is the ordering. Rule 1 is checked **before** rule 2, so a summoned run always inherits its summoner's tier. A gate that names a minted event therefore cannot reach rule 2, even if some future path let that name through the reservation. Defense in depth: either mechanism alone closes the escalation.

Rule 3 covers the one event that many runs cause at once. The batch resolves to the most restrictive tier across the runs it names, so it is only as trusted as its least trusted member. A window that held more failed runs than the event carries truncates that list to a sample. The batch then resolves no tier at all: a minimum over a sample is not a minimum over the window.

Inheritance is strict in the other direction. A missing emitting run, an unreadable tier, a failed lookup, or a single unreadable member of a batch resolves no tier at all, which isolates the run's caches and denies it a Dockerfile build.

A tier is inherited as it stood when the emitting run started. It is not re-derived, so a contributor's later permission change does not travel to a subscriber already triggered.

## The org fork switch

The organization's trust policy carries one switch, `forkPolicy`, with three values. It decides what happens to a pull request from a fork, and it decides nothing else.

| Value    | What the orchestrator does                                                                 |
| -------- | ------------------------------------------------------------------------------------------ |
| `ignore` | Drops the event before dispatch. No run row, no check runs, nothing a contributor can see. |
| `hold`   | Holds the run in the security queue and posts a pending `KiCI Security` check.             |
| `allow`  | Dispatches the run immediately, with the reduced privileges below.                         |

`reject` is a fourth, deprecated value. This build resolves it through the same arm as `ignore`, so a stored `reject` row keeps denying fork pull requests without an operator rewriting it first.

The switch is evaluated once per webhook event, before any dispatch path runs, and the verdict is threaded to every path that could start a job. The dispatch context's verdict field is required, so a path that fails to carry one does not compile. A verdict this build does not recognise resolves to `hold`. The policy columns are plain text, so a newer Platform can emit a value this orchestrator has never seen. For a security control, the safe reading of "I do not understand this" is to hold rather than to pass.

Two guards precede the switch. A `trusted` tier passes, and an event that is not a fork pull request passes. Neither has a fork verdict to receive.

### Which policy applies

| Stored state                            | Policy applied                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| A policy is stored                      | that policy                                                                    |
| No policy is stored                     | `ignore` — the fail-closed posture for an organization that has not chosen one |
| The stored policy could not be **read** | `hold`                                                                         |

The no-row default and the read-failure default answer different questions, so they differ deliberately. "No row" is what an organization has chosen by not choosing, and dropping the event leaves nothing behind. A read failure says nothing about what the organization chose: an organization on `hold` or `allow` would have its fork pull requests silently disappear if the two cases shared an answer. Both are fail-closed — nothing untrusted dispatches either way — but a hold is recoverable and visible on the pull request, and an operator can act on it.

The no-policy state is not necessarily brief. The Platform pushes `trust_policy.update` only for an organization whose policy has been created, and it is created on a dashboard read. An organization that has never opened **Settings > CI trust** stays on `ignore` indefinitely.

### What `ignore` does

An ignored event is dropped before the lock file is fetched. The delivery is still recorded in the event log, the webhook is reported to the ingress as `skipped`, and `kici_orch_fork_events_ignored_total{provider}` counts it. Nothing is written to `execution_runs`, and no check run is created, so the pull request shows no KiCI status at all.

### What an untrusted run may do

A dispatched run whose tier resolved below `trusted` — under `allow`, or after a `hold` is approved — carries three reductions, and they are derived from the tier rather than from the switch:

- **Base-branch workflow definitions.** A pull-request event on an untrusted ref evaluates the base branch's lock file, so a workflow change on the fork ref does not take effect until it is merged.
- **No install or registry secrets.** The dispatch carries neither `npmRegistries` nor `installEnvSecrets`, so an install from a [private registry](../../user/private-registries.md) fails on the first private dependency.
- **An isolated build-cache write scope.** Cache **writes** are confined to a per-run scope. A restore still falls back to the org-shared scope, so the run can read what trusted runs saved but can never overwrite it.

Approving a hold means "let this run", never "make this trusted". The resumed dispatch replays the same trust resolution, so an approved fork pull request carries the same three reductions.

Each provider check on such a run carries a note naming the reductions, so a contributor reading the pull request learns why an install failed or why a workflow change had no effect.

## Workflow modification detection

When a pull request modifies workflows, the orchestrator compares the base and head lock files and reports the difference on its own neutral check, `KiCI: Workflow changes`, titled "Workflow changes detected". The check is informational and it feeds no policy arm.

It does not need to. An untrusted ref evaluates the base branch's lock file, so the modified definitions are inert for that run — there is nothing left for a policy to gate. The check exists so a reviewer sees that the pull request changes CI behaviour once merged.

This means an operator on `allow` does not get a hold when a fork pull request edits `.kici/`. The run dispatches with the base-branch definitions and the three reductions above, and the neutral check records the change.

### Organization-wide global workflows

Organization-wide global workflows do not run for a pull request the fork switch holds. A neutral informational check on its own check name (`KiCI: Organization workflows`) records that they were skipped, so it never writes over the `KiCI Security` check the hold owns.

When the repository has no lock file of its own there is no dispatch path and no run to hold, so the event produces only the neutral skipped notice. Nothing is dispatched either way; the difference is only in how much the pull request is told.

A skipped global workflow has no run row and therefore no held run, so approving the event's hold releases the pull request's own workflows only. It does not retroactively run the organization's global workflows for that event.

This gate exists because a global workflow runs with **organization** credentials against the event's head commit. Running one for an event the policy refused would hand an untrusted contributor exactly the capability the policy was protecting.

## Security approval queue

Security holds are stored in the `held_runs` table with `queue_type = 'security'`, separate from context approval holds (`queue_type = 'context'`). The split is enforced at release time, not only in the UI. A release that targets the security queue asserts the row's `queue_type` matches. So a context approval can never release a security hold, and the reverse cannot happen either.

- Security approvals require `ci_trust:write` or higher.
- Context approvals require `contexts:write` or higher, plus eligibility for an unsatisfied clause.

### Hold reasons

| Reason          | Raised by                                                 | Scope         | Required to approve |
| --------------- | --------------------------------------------------------- | ------------- | ------------------- |
| `fork_pr`       | the org fork switch on `hold`                             | the whole run | `ci_trust:write`    |
| `context_trust` | a context's `minimumTrust` gate blocking an untrusted ref | one job       | `ci_trust:write`    |

Two further values, `workflow_modification` and `unknown_contributor`, remain in the stored vocabulary and are no longer raised. Rows written by earlier builds still carry them, so the queue renders them.

A `fork_pr` hold is workflow-scoped and stores a resume context. Approving it replays the dispatch with the same trust resolution, so the workflow actually runs — untrusted. Rejecting it cancels the run. Expiry cancels it too.

### Two holds on one job

A job can be gated by a reviewer approval and by a security trust hold at the same time. Each writes its own `held_runs` row, and **both must be released** before the job runs. That is the point of the split: releasing a reviewer hold takes `contexts:write` plus clause eligibility, while releasing the trust hold takes `ci_trust:write`, and a job held for both reasons must satisfy both requirements.

The two rows carry independent expiries, and whichever comes first cancels the run. The reviewer row uses the gate's own `timeout` if the workflow set one, otherwise the org's `approval_expiry_seconds` (default 24 hours). The `context_trust` row uses the context's `hold_expiry_seconds` (default one hour), so it is usually the shorter of the two.

The commit carries one `KiCI Security` check run, shared by every hold on that commit. It stays pending until every hold that owns it has ended, so releasing one hold never turns the check green while another still gates the job. The check's description names the reviewer clauses. It adds a line naming the trust hold, the permission that clears it, and the `/kici approve` command. So an approver is never left with a satisfied requirement and no statement of what remains.

Because a `--job` selector cannot separate two holds on one job, `kici approve` and `kici reject` take `--hold-type <type>` and `--hold <id>`.

### Approval channels

1. **Dashboard** — the **Approval queue** page (`/orgs/:customerId/approval-queue`), which lists security and context holds together and draws the controls each one's permission allows.
2. **Comment-based** — `/kici approve` and `/kici reject` in pull-request comments (case-insensitive). The commenter's identity is resolved through their identity link, and their `ci_trust` level is checked before the command acts. A command acts **only on the held runs for the pull request (and repo) the comment was posted on** — a bare `/kici approve` releases every pending security hold for that pull request, and never touches holds from other pull requests or repositories. An explicit `/kici approve <runId>` is narrowed within that pull request's holds, so a run id belonging to a different pull request or repository matches nothing.

An approve posts the terminal provider status before it resumes the run, so the replayed dispatch's own pending status lands last. That ordering costs one provider round-trip per hold.

### Approval expiry

A security hold expires on a deadline set when it is created. A `fork_pr` hold covers a whole pull request and is not attached to any context, so it uses the organization's approval expiry (default 72 hours). A `context_trust` hold is raised by a context, so it uses that context's own hold expiry (`hold_expiry_seconds`, default one hour). An expired run transitions to `expired`, and its checks are completed with a timeout explanation.

## Check runs

| Event                        | Check name                     | Status  | Title                          |
| ---------------------------- | ------------------------------ | ------- | ------------------------------ |
| Security hold created        | `KiCI Security`                | pending | Held for approval              |
| Security hold approved       | `KiCI Security`                | success | Approved                       |
| Security hold rejected       | `KiCI Security`                | failure | Rejected                       |
| Workflow modifications       | `KiCI: Workflow changes`       | neutral | Workflow changes detected      |
| Organization globals skipped | `KiCI: Organization workflows` | neutral | Organization workflows skipped |

Security holds use the fixed check name `KiCI Security` so the run is updated in place as the hold progresses. The two informational checks each use their own name, so neither can overwrite it. That matters concretely. The security check is a single run per commit: a hold posts it as pending, and an approve or reject later completes it. An informational write onto it would resolve a still-held run's check, and release whatever branch protection waits on it.

### A run that never dispatches still completes its checks

Setting up a dispatch creates the queued `kici/<workflow>` check and one check per job, before the run is known to be viable. Every path that ends the run before a job starts — an init failure, a secret-resolution failure, a rejected hold, an expired hold, and an infrastructure error that aborts the dispatch part-way — completes those checks rather than leaving them queued. A queued check blocks branch protection forever and says nothing; a completed one names the failure and can be re-run by pushing a new commit.

The condition is the checks being on the commit, not the particular way the dispatch ended. An aborted dispatch that had already reached a resumable hold is an exception in appearance only: answering that hold re-enters the dispatch, which posts the queued checks again, so the retry's pending state lands after the failure conclusion.

## Identity links

Identity links connect a provider username (for example GitHub `octocat`) to a KiCI user account. They are **not** part of trust resolution: no dispatch decision reads one. They exist so a `/kici approve` comment can be attributed to a KiCI user whose `ci_trust` level can then be checked.

Two verified linking mechanisms exist:

1. **Auto-link from OAuth claims** — when a user signs up through the identity provider with GitHub, their GitHub username is extracted from the identity provider's claims automatically.
2. **Manual OAuth linking via the dashboard** — a "Link GitHub account" button in personal settings, for users who signed up with email and password.

Self-reported usernames are not accepted, because they are spoofable.

### Why match on the numeric id, not the username

Provider usernames (GitHub `login`, GitLab `username`) are **mutable**. A user can rename, and after a hold period the freed username is available for someone else to register. Authority granted to user X under their old login would otherwise transfer to whoever owns the login next. The strict numeric-id match closes this: the immutable identity-provider numeric id (`sender.id` on GitHub, `user_id` on GitLab) is the only field consulted for the identity-link match.

An event with no `sender.id`, a link with a null `provider_user_id`, and a numeric-id mismatch are all refused and treated as no link. Refusals are counted under `kici_orch_trust_match_refused_no_id_total{reason}`. Steady state should be 0 in a healthy deployment; a non-zero rate points at a normalizer that drops `sender.id` or at an identity-sync regression.

### Identity-link freshness

The strict numeric-id policy depends on the stored `provider_user_id` being filled and current. KiCI keeps it that way through three independent reconciliation paths: a push from the identity provider, an on-demand sync at dashboard read, and a periodic reconcile job.

## CI trust level resolution

`ci_trust` is **approval authority**. It decides who may release a security hold. It does not decide how much privilege a run gets — the ref does that.

A member's effective `ci_trust` level comes from their assigned roles: the Owner role always yields `admin`, multiple roles merge with the highest level winning per resource, and no roles defaults to `none`. A per-member override supersedes the role-derived value where one is set; the override is deprecated and is removed at v1.0.0, so grant the level through a role instead.

The roles page shows the `ci_trust` value configured on each role. The members page shows the **effective** level after role merging and any override.

## Trust policy sync

The trust policy is cached on the orchestrator and pushed from the Platform over the WebSocket (`trust_policy.update`). The same message carries the organization's identity links, per-member `ci_trust` levels, and team memberships, so an orchestrator can authorize a `/kici approve` without calling the Platform.

The orchestrator persists what it was last pushed, so a restart does not empty the directory and refuse every approval until the next push arrives.

An organization whose policy row was never created receives no push. Its orchestrator applies the documented `ignore` default and cannot resolve a commenter's identity until the row is created on a dashboard read.

An **independent** orchestrator has no Platform and so receives no push at all. There the operator owns the directory instead, registering each approver's identity link and `ci_trust` level with `kici-admin trust-policy directory-set`. The two writers are mutually exclusive: the admin route refuses a local write wherever a Platform is attached, because the next push would replace the whole directory.

The message is version-gated. `forkPolicy: 'ignore'` requires protocol version 2; an orchestrator that negotiated version 1 receives `reject`, which its own enum carries and which denies dispatch the same way.

The stored policy is read on **both** ingresses — the Platform relay and the orchestrator's own direct GitHub route, which is served in hybrid, independent and observed mode. One stored row therefore governs a pull request whichever way it arrived, so repointing a GitHub App's webhook at the orchestrator does not change the verdict its events get.

## Data model

```
execution_runs
  + trust_tier           TEXT  -- 'trusted' | 'known' (legacy rows) | 'unknown' | null
  + lock_file_source     TEXT  -- 'head' | 'base' | null
  + contributor_username TEXT  -- provider username of the pull request author

held_runs
  + id                   UUID PRIMARY KEY
  + org_id               VARCHAR(12) NOT NULL
  + run_id               UUID NOT NULL
  + job_id               TEXT NOT NULL   -- expanded job name, or a run-wide sentinel
  + context_id           UUID (FK to contexts.id; null for context-free holds)
  + hold_type            TEXT NOT NULL   -- 'reviewer' | 'timer' | 'concurrency' | 'security'
  + status               TEXT NOT NULL DEFAULT 'pending'
  + queue_type           TEXT NOT NULL DEFAULT 'context'  -- 'context' | 'security'
  + hold_scope           TEXT NOT NULL DEFAULT 'job'      -- 'workflow' | 'job' | 'step'
  + step_index           INTEGER
  + trigger_source       TEXT NOT NULL DEFAULT 'context'  -- 'context' | 'explicit'
  + approval_requirement JSONB
  + payload              JSONB
  + posted_pending_check BOOLEAN         -- null on rows that predate the column
  + reason               TEXT
  + approved_by          TEXT
  + created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
  + expires_at           TIMESTAMPTZ NOT NULL
  + resolved_at          TIMESTAMPTZ

Indexes:
  - held_runs_org_id_status_idx (org_id, status)
  - held_runs_org_queue_type_status_idx (org_id, queue_type, status)
```

## Data flow

```
GitHub webhook
    |
    v
Platform relay (verify signature, route over the WebSocket)
    |
    v
Orchestrator pipeline
    |
    +-- 1. Normalize the event
    +-- 2. Compare head and base repository names --> isForkPR
    +-- 3. Resolve the tier from that comparison alone
    +-- 4. Evaluate the fork switch
    |       |
    |       +-- ignore --> drop the event; nothing further runs
    |       +-- hold   --> hold the run, post the pending KiCI Security check
    |       +-- pass   --> continue
    |
    +-- 5. Fetch the lock file (head for trusted, base otherwise)
    +-- 6. Compare base and head lock files, post the informational check
    +-- 7. Match triggers against the lock file
    +-- 8. Dispatch jobs with the tier's reductions applied
    +-- 9. Record the trust context on execution_runs
```
